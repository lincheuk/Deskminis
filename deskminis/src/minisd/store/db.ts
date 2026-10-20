import Database from 'better-sqlite3';

/** schema 对齐 OpenMinis ChatStore（设计 §3.1）；M1 只建用到的表，同步表列先留出。
 *  导出 + 冻结是给 tests/db-migrations-immutable.test.ts 的 sha256 钉用的：已发布的条目一个字符都不能改，
 *  只允许在尾部追加。条目本身（包括空白）改了，老用户的库永远拿不到那次改动，新老用户的表结构就分叉了。 */
export const MIGRATIONS: readonly string[] = Object.freeze([
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
    model_id TEXT, category TEXT, model_binding TEXT, source TEXT,
    memory_enabled INTEGER NOT NULL DEFAULT 1,
    pinned_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
    last_synced_at REAL, remote_origin_device_id TEXT, remote_tombstoned_at REAL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    role TEXT NOT NULL, parts_json TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL, updated_at REAL NOT NULL,
    token_usage TEXT, sort_order INTEGER NOT NULL,
    reasoning_content TEXT, stream_interrupt_count INTEGER NOT NULL DEFAULT 0,
    error_info TEXT, part_flags TEXT
  );
  CREATE INDEX idx_messages_session ON messages(session_id, created_at, id);
  CREATE TABLE compact_markers (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    summary TEXT NOT NULL, last_compacted_message_id TEXT NOT NULL, created_at REAL NOT NULL
  );
  `,
  // [1] M2a 新增：compact_markers 按 (session_id, created_at DESC) 建索引
  //  必须是新迁移条目，不能追加进 MIGRATIONS[0]——已有用户库 user_version=1，
  //  db.ts 的迁移 runner 只对 user_version < N 的库跑 MIGRATIONS[0..N-1]，
  //  改 MIGRATIONS[0] 对已发布库是 no-op（迁移一经发布不可改）。
  //  IF NOT EXISTS 双保险：开发库（M1 时已建表但无索引）跑此迁移建索引；若已存在则跳过。
  `CREATE INDEX IF NOT EXISTS idx_compact_markers_session ON compact_markers(session_id, created_at DESC);`,
  // [2] M2c 技能系统（设计 §5.1）：元数据并入 minis.db；SKILL.md 正文永远在文件系统、原样不改写。
  //  迁移一经发布不可改、不可重排：已发布库 user_version=2，runner 只对 v<3 的库跑 MIGRATIONS[2]，
  //  改 [0]/[1] 对已发布库是 no-op。表结构与计划原案一致。
  `
  CREATE TABLE skills (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '',
    import_source TEXT NOT NULL DEFAULT '', is_enabled INTEGER NOT NULL DEFAULT 1,
    installed_at REAL NOT NULL, updated_at REAL NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE session_skill_overrides (
    session_id TEXT NOT NULL, skill_id TEXT NOT NULL, is_enabled INTEGER NOT NULL,
    PRIMARY KEY (session_id, skill_id)
  );
  `,
  // [3] M3b 双向同步：messages 表新增设备来源字段 + sync_orphan_markers 隔离表（设计 §1-M3b / §4.2 / 评审命门 2）
  //  迁移一经发布不可改：已发布库 user_version=3，runner 只对 v<4 的库跑 MIGRATIONS[3]。
  //  旧数据回填：origin_device_id='legacy'（DEFAULT 自动），created_locally_at=created_at（UPDATE 显式）。
  //  'legacy' 仅作占位，合并靠 id 去重不影响正确性——新消息 appendMessage 永不写 'legacy'。
  //  sessions 表 MIGRATIONS[0] 已预留 last_synced_at/remote_origin_device_id/remote_tombstoned_at（L11），本次不动。
  //  compact_markers schema 一行不改（M2a 红线）——orphan 落 sync_orphan_markers 隔离表。
  `
  ALTER TABLE messages ADD COLUMN origin_device_id TEXT NOT NULL DEFAULT 'legacy';
  ALTER TABLE messages ADD COLUMN created_locally_at REAL;
  UPDATE messages SET created_locally_at = created_at WHERE created_locally_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_origin ON messages(session_id, origin_device_id, created_locally_at);
  CREATE TABLE sync_orphan_markers (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    summary TEXT NOT NULL, last_compacted_message_id TEXT NOT NULL, created_at REAL NOT NULL,
    received_at REAL NOT NULL
  );
  CREATE INDEX idx_sync_orphan_markers_session ON sync_orphan_markers(session_id, created_at DESC);
  `,
  // [4] M6 可观测与控制权：audit_logs（R4 审计）+ settings（R2 暂停标志）
  //  迁移一经发布不可改：已发布库 user_version=4，runner 只对 v<5 的库跑 MIGRATIONS[4]。
  //  audit_logs：事件型审计（权限决议等），跨会话查询面；轮转按 created_at FIFO 删最旧（决策点 2-3）。
  //  settings：key-value 全局设置（R2 暂停标志 sync.paused），重启后仍生效（决策点 2-6）。
  `
  CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    session_id TEXT,
    peer_fingerprint TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL
  );
  CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC, id);
  CREATE INDEX idx_audit_logs_type ON audit_logs(event_type, created_at DESC);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at REAL NOT NULL
  );
  `,
  // [5] 工作区可选（用户 2026-08-11「这个点不开，无法使用」）：会话可绑定真实项目目录。
  //  迁移一经发布不可改：已发布库 user_version=5，runner 只对 v<6 的库跑 MIGRATIONS[5]。
  //  NULL = 未设置 = 回落到沙箱桶 sessions/<id>/workspace（老会话与新建会话的默认）。
  //  只存路径不存别的：工作区是「默认工作目录」，不是权限边界——
  //  resolveGuestPath 对绝对路径本就放行，越界由权限系统把关，这一列不改变那条规则。
  `
  ALTER TABLE sessions ADD COLUMN workspace_root TEXT;
  `,
  // [6] G1 扩展市场：market_cache（读侧 HTTP 缓存，设计稿 §2）。
  //  迁移一经发布不可改：已发布库 user_version=6，runner 只对 v<7 的库跑 MIGRATIONS[6]。
  //  key=源前缀:端点:查询（适配器构造），etag 支持条件请求（304 只刷 fetched_at），
  //  TTL 软过期（列表 15 分钟/详情 24h）由 cache.ts 运行时判断——列里不存 TTL，改策略无需迁移。
  //  追加式纪律：只建新表，不动既有任何表。
  `
  CREATE TABLE market_cache (
    key TEXT PRIMARY KEY,
    etag TEXT,
    body TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
  // [7] G2 市场安装登记（provenance，设计稿 §3/§7）：market_installs 只追加新表。
  //  迁移一经发布不可改：已发布库 user_version=7，runner 只对 v<8 的库跑 MIGRATIONS[7]。
  //  item_id=源前缀:条目id（主键——同条目重装走 upsert 覆盖）；kind='skill'|'mcp'；
  //  local_ref=技能 id（SkillStore）或 MCP server 名（servers.json）；content_hash=安装物
  //  内容哈希（技能=下载字节自算 sha256；MCP=注册表包版本哈希；无来源可空）——
  //  供 market.installed 双向核对（本体已删→清理登记行）与 G4 更新检查比对。
  `
  CREATE TABLE market_installs (
    item_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    local_ref TEXT NOT NULL,
    content_hash TEXT,
    installed_at INTEGER NOT NULL
  );
  `,
  // [8] H1 文本选区注释（设计稿 §1-3）：annotations 只追加新表。
  //  迁移一经发布不可改：已发布库 user_version=8，runner 只对 v<9 的库跑 MIGRATIONS[8]。
  //  锚定模型 = W3C TextQuoteSelector（exact + 前后文各 32 字符），锚对象是消息「渲染后纯文本」；
  //  重锚定全在 renderer 侧完成——库里只存锚与笔记，不存任何 DOM 偏移（重渲染即失效的东西不落库）。
  //  color 是保留字段（v1 单色）；note/color 空串语义 = 无。索引带 created_at 供 list 稳定排序。
  `
  CREATE TABLE annotations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    exact TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  );
  CREATE INDEX idx_annotations_session ON annotations(session_id, created_at);
  `,
  // [9] J1 助手体系：assistants 只追加新表，保存命名预设。
  //  迁移一经发布不可改：已发布库 user_version=9，runner 只对 v<10 的库跑 MIGRATIONS[9]。
  //  助手 = 命名预设：rules 追加系统提示词、skill_ids_json 默认技能勾选（建会话时快照式
  //  写 session_skill_overrides）、model_binding 同 sessions 取值约定（'provider:'/'group:'）、
  //  prompts_json 示例指令数组。会话绑定列 sessions.assistant_id 走 ChatStore 构造器
  //  幂等补列（mcp_disabled_json 成例），不占迁移位。权限档不入表：助手预设不接管全局权限档。
  `
  CREATE TABLE assistants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    model_binding TEXT,
    skill_ids_json TEXT NOT NULL DEFAULT '[]',
    prompts_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  );
  `,
  // [10] K1 定时任务：cron_jobs 只追加新表，保存计划、下一次运行时间与结果状态。
  //  迁移一经发布不可改：已发布库 user_version=10，runner 只对 v<11 的库跑 MIGRATIONS[10]。
  //  三态调度：schedule_kind 'interval'（分钟数 ≥5）/'once'（epoch 秒）/'cron'（5 段，
  //  本机时区，日/周 OR 语义）；next_run_at 在 create/update/跑完时算定（epoch 秒），
  //  调度器 tick 只查 enabled=1 AND next_run_at<=now。会话形态：每次触发新建会话
  //  （sessions.source='cron' 首次启用迁移[0] 预留列），可绑助手（J 波预设三件随之应用）。
  //  权限档不入表：无人值守权限卡 90s 超时自动拒绝是既有语义（设计稿 §0，不静默扩权）。
  `
  CREATE TABLE cron_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_kind TEXT NOT NULL,
    schedule_value TEXT NOT NULL,
    assistant_id TEXT,
    workspace_root TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at REAL,
    last_run_at REAL,
    last_session_id TEXT,
    last_status TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  );
  `,
  // [11] F11A 附件同步（docs/specs/2026-10-03-f11a-attachment-sync.md）：sync_attachments 只追加新表。
  //  迁移一经发布不可改：已发布库 user_version=11，runner 只对 v<12 的库跑 MIGRATIONS[11]。
  //  设备本地索引，不上线路：一个（会话，名字）一行，记这个名字绑定的内容（sha256 + 长度）与本机状态。
  //  name 用 NOCASE：名字只含 ASCII，Windows 文件系统不分大小写，A.png 与 a.png 必须落在同一行上。
  //  state：present（本机有完整且校验过的文件）/ missing（知道内容身份，本机没有）/ failed。
  //  传输进度不入库：以暂存文件在磁盘上的长度为准，库里不存一个可能与磁盘不一致的数。
  `
  CREATE TABLE sync_attachments (
    session_id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    want INTEGER NOT NULL DEFAULT 1,
    fail_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    conflict_sha256 TEXT,
    conflict_size INTEGER,
    stat_size INTEGER,
    stat_mtime_ms REAL,
    source_fp TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (session_id, name)
  );
  CREATE INDEX idx_sync_attachments_content ON sync_attachments(sha256, size, state);
  `,
  // [12] F05 持久化运行状态与工具执行账本：只建三张新表与索引，不 ALTER 任何既有表、不引用别的迁移建的表或列。
  //  engine_instances：每次启动一行，epoch 自增 = 引擎代次（租约）；heartbeat_at 只供存活判断与诊断，
  //   从不据此改任何状态；close_kind 'shutdown'（有序关停）/'superseded'（被后一代接管时还没关 = 崩溃或被强杀）。
  //  agent_runs：run 状态机。active 非终态为 1、终态为 NULL，部分唯一索引保证同一会话最多一个活动 run；
  //   (session_id, prompt_id) 唯一 = chat.prompt 的持久去重（跨重启）；generation 是该会话的第几次运行。
  //  tool_executions：每个 toolUse 一行（按 run / batch / call_index，不按 toolUseId——同批里它可以重复）。
  //   state 七种（待执行 / 审批中 / 执行中 / 已完成 / 失败 / 取消 / 结果未知）；started=1 表示执行意图已落账、
  //   execute 可能已被调用。result_output 只在「已落定、未交付」期间有值（落库形态），交付即清空；
  //   工具入参不重复存，在 assistant_message_id 那条消息的 toolUse 里。
  //  不声明外键（与既有表同一风格）；账本行随会话删除（ChatStore.deleteSession）。三张表只在本机，不进同步。
  `
  CREATE TABLE engine_instances (
    epoch INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    app_version TEXT NOT NULL DEFAULT '',
    started_at REAL NOT NULL,
    heartbeat_at REAL NOT NULL,
    closed_at REAL,
    close_kind TEXT
  );
  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    state TEXT NOT NULL,
    active INTEGER,
    step TEXT NOT NULL DEFAULT 'starting',
    tool_batches INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'user',
    origin_ref TEXT,
    prompt_id TEXT,
    prompt_digest TEXT,
    user_message_id TEXT,
    stop_reason TEXT,
    stop_detail TEXT,
    recovered_epoch INTEGER,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    ended_at REAL
  );
  CREATE UNIQUE INDEX idx_agent_runs_active ON agent_runs(session_id) WHERE active = 1;
  CREATE UNIQUE INDEX idx_agent_runs_generation ON agent_runs(session_id, generation);
  CREATE UNIQUE INDEX idx_agent_runs_prompt ON agent_runs(session_id, prompt_id) WHERE prompt_id IS NOT NULL;
  CREATE TABLE tool_executions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    batch INTEGER NOT NULL,
    call_index INTEGER NOT NULL,
    tool_use_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    assistant_message_id TEXT NOT NULL,
    state TEXT NOT NULL,
    end_kind TEXT,
    started INTEGER NOT NULL DEFAULT 0,
    barrier INTEGER,
    read_only INTEGER,
    side_effects TEXT,
    claims_json TEXT,
    write_paths_json TEXT,
    approval_state TEXT,
    approval_request_id TEXT,
    approval_kind TEXT,
    approval_reason TEXT,
    approval_cause TEXT,
    prior_allows INTEGER NOT NULL DEFAULT 0,
    result_success INTEGER,
    result_output TEXT,
    result_offload_path TEXT,
    result_chars INTEGER,
    result_message_id TEXT,
    delivered_at REAL,
    created_at REAL NOT NULL,
    started_at REAL,
    settled_at REAL,
    updated_at REAL NOT NULL
  );
  CREATE UNIQUE INDEX idx_tool_executions_call ON tool_executions(run_id, batch, call_index);
  CREATE INDEX idx_tool_executions_open ON tool_executions(epoch) WHERE delivered_at IS NULL;
  CREATE INDEX idx_tool_executions_session ON tool_executions(session_id);
  `,
  // [13] F11B 会话生命周期登记（docs/specs/2026-10-03-f11b-delete-propagation.md）：session_lifecycle 只追加新表。
  //  迁移一经发布不可改：已发布库 user_version=13，runner 只对 v<14 的库跑 MIGRATIONS[13]。
  //  每个会话至多一行，存当前登记：version 奇数 = 已删除（墓碑），偶数（≥2）= 删除后被显式恢复；没有行等于从未删除。
  //  为什么单独成表而不挂在 sessions 行上：登记要比会话行活得久——会话行一删，挂在上面的标记也没了，
  //  拦不住之后带着旧副本回来的设备。这张表的行永不删除，GC 只把 seen_ids_json 置空（条数与摘要留着）。
  //  origin_at / recorded_at 是墙钟，只用于展示与压实的早晚；谁胜出只看 (version, op_id)。
  //  sessions.remote_tombstoned_at（迁移 [0] 预留列）在这一版开始使用：非空 = 这一行已被别的设备的删除覆盖、
  //  本机内容还留着（保留副本）。走迁移而不是构造器自建表，是为了让 user_version 前进：
  //  旧构建打开这个库会把保留副本当普通会话显示并推出去，必须由降级守卫拦住。
  `
  CREATE TABLE session_lifecycle (
    session_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    op_id TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    origin_at REAL NOT NULL,
    seen_count INTEGER,
    seen_digest TEXT,
    seen_ids_json TEXT,
    received_from TEXT,
    recorded_at REAL NOT NULL
  );
  `,
  // [14] F08 普通文件检查点：只建两张新表与索引，不 ALTER 任何既有表，不声明外键。
  //  file_checkpoints：内置文件 / Office 写入工具每改一个文件一行。seq 自增 = 同一路径上改动的先后；
  //   path_key 是路径身份键（tools/data-gate.ts 的 pathKeyOf，与资源锁同一套规范化）；state 五种
  //   （pending / applied / aborted / restored / unknown）；「恢复中」不是 state，是 restoring_at 非空。
  //   before_blob / after_blob 指向 checkpoint_blobs.hash：写入前的内容在写入之前存下，写入后的内容只在恢复那一刻存；
  //   清理只置 pruned_at 并清空这两个引用，行留着。tmp_path / restore_tmp_path 是放在用户目录里的临时文件，
  //   确认它已不在才清空该列。run_id / execution_id 指向 F05 的 agent_runs.id / tool_executions.id（代码层面的关联）。
  //  checkpoint_blobs：内容文件的登记表（按 sha256 去重，文件在 <数据根>/checkpoints/blobs/ 下）。
  //  两张表只在本机，不进同步；file_checkpoints 的行随会话物理清除（ChatStore.purgeSessionRows：本机删除、对端墓碑、
  //  彻底删除保留副本都经它；保留副本的行与内容留着），还记着残留临时文件的行留成不带内容的占位。
  `
  CREATE TABLE file_checkpoints (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    run_id TEXT,
    execution_id TEXT,
    tool_use_id TEXT,
    tool_name TEXT NOT NULL DEFAULT '',
    ordinal INTEGER NOT NULL DEFAULT 0,
    requested_path TEXT NOT NULL,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL,
    state TEXT NOT NULL,
    before_exists INTEGER NOT NULL,
    before_hash TEXT,
    before_size INTEGER,
    before_mode INTEGER,
    before_blob TEXT,
    after_hash TEXT NOT NULL,
    after_size INTEGER NOT NULL,
    after_blob TEXT,
    file_dev TEXT,
    file_ino TEXT,
    restored_dev TEXT,
    restored_ino TEXT,
    tmp_path TEXT,
    restoring_at REAL,
    restore_tmp_path TEXT,
    abort_reason TEXT,
    detail TEXT,
    created_at REAL NOT NULL,
    applied_at REAL,
    restored_at REAL,
    pruned_at REAL,
    updated_at REAL NOT NULL
  );
  CREATE INDEX idx_file_checkpoints_session ON file_checkpoints(session_id, seq);
  CREATE INDEX idx_file_checkpoints_path ON file_checkpoints(path_key, seq);
  CREATE INDEX idx_file_checkpoints_execution ON file_checkpoints(execution_id);
  CREATE INDEX idx_file_checkpoints_before_blob ON file_checkpoints(before_blob) WHERE before_blob IS NOT NULL;
  CREATE INDEX idx_file_checkpoints_after_blob ON file_checkpoints(after_blob) WHERE after_blob IS NOT NULL;
  CREATE TABLE checkpoint_blobs (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    created_at REAL NOT NULL
  );
  `,
  // [15] F03 结构化压缩标记：compact_marker_meta 只追加新表，不 ALTER compact_markers（它的列由同步线路与既有读取方钉着）。
  //  一条 marker 至多一行，与 marker 行同一个事务写入；meta_json 是 CompactMeta（v 目前恒为 2）：覆盖区间、模型写的各小节、
  //  程序根据落库消息生成的记录。没有这一行的 marker 就是旧 marker（旧版本写的、同步来的），读的一方按没有 meta 处理。
  //  设备本地，不上同步线路；不声明外键（与既有表同一风格），行随会话删除。不引用别的迁移建的表或列。
  `
  CREATE TABLE compact_marker_meta (
    marker_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    v INTEGER NOT NULL,
    meta_json TEXT NOT NULL,
    created_at REAL NOT NULL
  );
  CREATE INDEX idx_compact_marker_meta_session ON compact_marker_meta(session_id);
  `,
  // F09 进程树账本：只建一张新表与两个索引，不 ALTER 任何既有表、不引用别的迁移建的表或列。
  //  process_trees：引擎为 shell、终端、stdio MCP 起的每个根进程一行。root_pid + root_created（进程自己报的创建时间，
  //   FILETIME 十进制）才算身份；库里的 PID 只用于展示与取证，恢复从不按它结束或探测任何进程。
  //   protection 'pending' / 'job'（根自建的作业对象已就位、属主监视已就位）/ 'none'（原因在 protection_reason）。
  //   stop_cause = 引擎发起回收的原因；end_kind 'exited' / 'stopped' / 'spawn-failed' / 'engine-lost'（引擎停止时还开着，
  //   只由后一代写）；reaped 只由后一代关账时写（'job' = 当时受作业托管，整棵树已随引擎由系统结束；'unverified' = 没有依据）。
  //   run_id / stop_run_id 是对 agent_runs.id 的弱引用（不建外键）；epoch 是 engine_instances 的代次。
  //  表只在本机，不进同步；按会话归属的行随会话删除（ChatStore.purgeSessionRows）。旧库升级得到一张空表，不回填。
  `
  CREATE TABLE process_trees (
    id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT,
    owner_ref TEXT,
    tool_prefix TEXT,
    run_id TEXT,
    root_pid INTEGER,
    root_created TEXT,
    target_pid INTEGER,
    protection TEXT NOT NULL DEFAULT 'pending',
    protection_reason TEXT,
    pre_job INTEGER,
    started_at REAL NOT NULL,
    stop_cause TEXT,
    stop_run_id TEXT,
    stop_at REAL,
    ended_at REAL,
    end_kind TEXT,
    exit_code INTEGER,
    exit_signal TEXT,
    reaped TEXT,
    recovered_epoch INTEGER
  );
  CREATE INDEX idx_process_trees_open ON process_trees(epoch) WHERE ended_at IS NULL;
  CREATE INDEX idx_process_trees_session ON process_trees(session_id);
  `,
  // F07: local durable steer and queue; prior migrations stay immutable.
  `
  CREATE TABLE session_inputs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    input_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('steer','queue')),
    text TEXT NOT NULL,
    attachments_json TEXT NOT NULL,
    request_json TEXT NOT NULL,
    digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','starting','admitted','delivered','held','cancelled')),
    run_id TEXT,
    history_message_id TEXT,
    claim TEXT,
    reason TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    delivered_at REAL,
    UNIQUE(session_id,input_id),
    CHECK(state NOT IN ('admitted','delivered') OR (run_id IS NOT NULL AND history_message_id IS NOT NULL)),
    CHECK(state != 'delivered' OR delivered_at IS NOT NULL)
  );
  CREATE INDEX idx_session_inputs_open ON session_inputs(session_id,seq) WHERE state IN ('pending','starting','held');
  CREATE INDEX idx_session_inputs_run ON session_inputs(run_id);
  `,
  // C4: queue order is independent of immutable input identity; old writers retain seq order.
  `
  ALTER TABLE session_inputs ADD COLUMN position REAL;
  `,
]);

/** 库的 user_version 比本应用认识的迁移条数还大：这份数据是更新版本的 DeskMinis 写的。
 *  旧代码不认识新表新列，带着旧 SQL 去读写只会把数据写坏，所以宁可不打开。
 *  code 是给 minisd 致命行通道（src/minisd/fatal.ts）识别用的，message 只进日志。 */
export class DbNewerThanAppError extends Error {
  readonly code = 'DB_NEWER_THAN_APP' as const;
  constructor(readonly dbVersion: number, readonly appVersion: number) {
    super(`数据库版本为 ${dbVersion}，当前应用只支持到 ${appVersion}：这份数据来自更新版本的 DeskMinis，为避免损坏没有打开它`);
    this.name = 'DbNewerThanAppError';
  }
}

function readUserVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** 逐条补跑迁移，每条一个事务。
 *  为什么用 db.transaction 而不是手写 BEGIN/COMMIT：旧写法在 exec 抛错时没有 ROLLBACK，
 *  半条迁移（比如前一句已建好的表）留在一个永不结束的事务里，同一连接之后的任何写入都会被一并提交，
 *  user_version 却没前进，下次启动再跑同一条就撞「表已存在」。transaction() 抛错即回滚，连接干净。
 *  这里也判一次新旧：直接拿现成连接调用的地方（测试、将来的工具）同样受降级守卫保护。 */
export function runMigrations(db: Database.Database, migrations: readonly string[] = MIGRATIONS): void {
  const current = readUserVersion(db);
  if (current > migrations.length) throw new DbNewerThanAppError(current, migrations.length);
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function openDb(filePath: string): Database.Database {
  const db = new Database(filePath);
  try {
    // 先只读版本、判新旧，再切 WAL：库若来自更新版本，本应用一个字节都不该写（切 journal_mode 本身就是写）。
    const current = readUserVersion(db);
    if (current > MIGRATIONS.length) throw new DbNewerThanAppError(current, MIGRATIONS.length);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  } catch (e) {
    // 失败先关连接再抛：不关的话 -wal/-shm 留在盘上、Windows 上库文件被这个死连接一直锁着。
    try { db.close(); } catch { /* 关不掉也要把原始错误抛出去，别让它被关连接的错误盖掉 */ }
    throw e;
  }
}
