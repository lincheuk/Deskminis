import Database from 'better-sqlite3';

/** schema 对齐 OpenMinis ChatStore（设计 §3.1）；M1 只建用到的表，同步表列先留出。 */
const MIGRATIONS: string[] = [
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
];

export function openDb(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  return db;
}
