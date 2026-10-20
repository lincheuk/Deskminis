import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { CompactMarker, RawMessage, RetainedSession, SessionMeta, TokenUsage } from '../../shared/types';
import type { CompactMeta } from '../../shared/compaction';
import { serializeParts, parseParts } from '../../shared/parts';
import { parseCompactMeta } from '../agent/compact-meta';
import { mergeSession } from '../sync/merge';
import type { SyncPayload, WireLifecycle, WireLifecycleHead, WireSeen } from '../sync/wire';
import { toWireMessage, toWireMarker, toWireSession, parseWireLifecycle, isSyncId, LIFECYCLE_MAX } from '../sync/wire';
import { compareLifecycle, decideIncoming, isDeletedVersion, makeSeen, unseenOf } from '../sync/lifecycle';

interface MessageRow {
  id: string; session_id: string; role: string; parts_json: string;
  created_at: number; updated_at: number; token_usage: string | null;
  sort_order: number; reasoning_content: string | null;
  stream_interrupt_count: number; error_info: string | null;
  origin_device_id: string; created_locally_at: number | null;
}

interface SessionRow {
  id: string; title: string; model_binding: string | null; memory_enabled: number;
  workspace_root: string | null; mcp_disabled_json: string | null; assistant_id: string | null;
  created_at: number; updated_at: number; pinned_at: number | null;
}
const SESSION_COLUMNS = 'id, title, model_binding, memory_enabled, workspace_root, mcp_disabled_json, assistant_id, created_at, updated_at, pinned_at';

/** H1 文本选区注释（W3C TextQuoteSelector 锚 + 笔记）。exact/prefix/suffix 针对消息渲染后纯文本。 */
export interface Annotation {
  id: string; sessionId: string; messageId: string;
  exact: string; prefix: string; suffix: string;
  note: string; color: string;
  createdAt: number; updatedAt: number;
}
interface AnnotationRow {
  id: string; session_id: string; message_id: string;
  exact: string; prefix: string; suffix: string; note: string; color: string;
  created_at: number; updated_at: number;
}
// 写入上限：本地 RPC 也不给无界写入面（PREVIEW_MAX_CHARS 同一精神）。
// prefix/suffix 只是消歧上下文，64 已远超 renderer 送来的 32；exact/note 截断而非拒绝——
// 超长选区的语义是「用户真选了这么长」，静默截断仍可锚定（匹配退 exact 前缀命中），拒绝反而丢数据。
const ANNO_CONTEXT_MAX = 64;
const ANNO_TEXT_MAX = 20000;

// ── F11B 会话生命周期登记（设计 §3.4、§4.1）──

export interface ChatStoreOpts {
  /** 墙钟（毫秒）。缺省 Date.now。只供测试造时钟不同的设备；nowEpoch() 读它。 */
  now?: () => number;
}

interface LifecycleRow {
  session_id: string; version: number; op_id: string; origin_device_id: string; origin_at: number;
  seen_count: number | null; seen_digest: string | null; seen_ids_json: string | null;
  received_from: string | null; recorded_at: number;
}

/** 本机库里的一条登记：线上声明加两项本机记账（从谁那里得知、本机何时记下）。 */
export interface LifecycleRecord extends WireLifecycle { receivedFrom?: string; recordedAt: number }

export type DeleteSessionResult =
  /** 这个 id 名下什么都没有：不写墓碑 */
  | { kind: 'absent' }
  | { kind: 'deleted'; lifecycle: WireLifecycle; messageCount: number }
  /** 清掉的是保留副本（或奇数登记下的残留行）；版本不变 */
  | { kind: 'purged'; lifecycle: WireLifecycle };

export type TombstoneApplyResult =
  | { status: 'applied' | 'superseded'; hadLocalCopy: boolean; retained: boolean; unseenCount: number | null; annotationCount: number }
  /** released = 这条墓碑让一个保留副本被清除了 */
  | { status: 'duplicate' | 'stale'; released: boolean };

export type LifecycleEvent =
  | { kind: 'deleted'; sessionId: string; lifecycle: WireLifecycle; messageCount: number }
  | { kind: 'tombstone-applied'; sessionId: string; lifecycle: WireLifecycle; fromPeer?: string;
      hadLocalCopy: boolean; retained: boolean; unseenCount: number | null; annotationCount: number }
  | { kind: 'retained-released'; sessionId: string; lifecycle: WireLifecycle; fromPeer?: string }
  | { kind: 'restored'; sessionId: string; lifecycle: WireLifecycle }
  | { kind: 'restore-applied'; sessionId: string; lifecycle: WireLifecycle; fromPeer?: string }
  | { kind: 'purged'; sessionId: string; lifecycle: WireLifecycle }
  | { kind: 'stale-content-rejected'; sessionId: string; lifecycle: WireLifecycle; fromPeer?: string };

export interface MergeRemoteResult {
  mergedCount: number; orphanMarkerIds: string[]; hasChange: boolean;
  /** 内容被拒，没有写任何行。tombstoned = 本机已删除且版本更高；
   *  session-required = 载荷带来更高的偶数登记，但本机没有会话行、载荷里也没有 session。 */
  rejected?: 'tombstoned' | 'session-required';
  /** 这次合并接受了对端的显式恢复。 */
  restored?: boolean;
  /** 这次合并新建了会话行，或让一个保留副本重新可见。 */
  sessionCreated?: boolean;
  /** 操作之后本机的登记（v>0 时带），供对端追平。 */
  lifecycle?: WireLifecycle;
}

function toMessage(r: MessageRow): RawMessage {
  return {
    id: r.id, sessionId: r.session_id, role: r.role as RawMessage['role'],
    parts: parseParts(r.parts_json), createdAt: r.created_at, updatedAt: r.updated_at,
    sortOrder: r.sort_order, tokenUsage: r.token_usage ? JSON.parse(r.token_usage) : undefined,
    reasoningContent: r.reasoning_content ?? undefined,
    streamInterruptCount: r.stream_interrupt_count, errorInfo: r.error_info ?? undefined,
    originDeviceId: r.origin_device_id, createdLocallyAt: r.created_locally_at ?? r.created_at,
  };
}

function stripRecord(r: LifecycleRecord): WireLifecycle {
  const out: WireLifecycle = { v: r.v, opId: r.opId, originDeviceId: r.originDeviceId, at: r.at };
  if (r.seen) out.seen = r.seen;
  return out;
}

export class ChatStore {
  /** M3b：脏数据钩子（Task 6 SyncCoordinator 注入），appendMessage/appendCompactMarker 等触发 */
  onDirty?: (sessionId: string) => void;
  /** F11B：生命周期事件钩子（index.ts 接审计与广播）。事务提交后同步调用；钩子抛错只记警告，不影响操作本身。 */
  onLifecycle?: (e: LifecycleEvent) => void;
  private readonly now: () => number;
  private readonly selectWorkspace: Database.Statement;
  private readonly selectSession: Database.Statement;
  private readonly selectSessions: Database.Statement;
  private readonly selectMessageMax: Database.Statement;
  /** Q12c：合并时因为 id 丢过内容、已经报过警告的会话。对端每轮对账（约 30 秒）都会把同一批再送一遍，每个会话只报一次。 */
  private readonly idWarned = new Set<string>();

  constructor(private db: Database.Database, private defaultOriginDeviceId: string = 'local', opts: ChatStoreOpts = {}) {
    this.now = opts.now ?? Date.now;
    // D5 追加式迁移：sessions 补 mcp_disabled_json 列（会话禁用的 MCP server 名单）。
    // 照仓库既有迁移模式（db.ts MIGRATIONS[5] 的 ALTER TABLE ADD COLUMN），但迁移 runner
    // 在 db.ts（本波白名单不含它），故在首个用户（ChatStore 构造）处幂等自查自补：
    // 列已存在时 PRAGMA 查得即跳过，重复构造不炸、旧库新库同一代码路径。
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'mcp_disabled_json')) {
      db.exec('ALTER TABLE sessions ADD COLUMN mcp_disabled_json TEXT');
    }
    // J1 同款幂等补列：会话绑定的助手 id（NULL = 无助手）。删助手时绑定悬空保留——
    // 注入侧查无即跳过，会话继续可用（设计稿 §1）。
    if (!cols.some(c => c.name === 'assistant_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN assistant_id TEXT');
    }
    this.selectWorkspace = db.prepare('SELECT workspace_root FROM sessions WHERE id=?');
    this.selectSession = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id=? AND remote_tombstoned_at IS NULL`);
    this.selectSessions = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE remote_tombstoned_at IS NULL ORDER BY updated_at DESC`);
    this.selectMessageMax = db.prepare('SELECT MAX(created_at) AS created_at FROM messages WHERE session_id=?');
  }

  nowEpoch(): number { return this.now() / 1000; }
  newId(): string { return randomUUID().toUpperCase(); }

  /** workspaceRoot 由调用方传入（index.ts 读全局「上次用过的」），缺省即回落沙箱桶。
   *  source（K1 首次启用迁移[0] 预留列）：'cron' = 定时任务触发的会话，供回溯与后续 UI 标记。 */
  createSession(title = '新会话', workspaceRoot?: string, source?: string): SessionMeta {
    const s: SessionMeta = { id: this.newId(), title, createdAt: this.nowEpoch(), updatedAt: this.nowEpoch() };
    if (workspaceRoot) s.workspaceRoot = workspaceRoot;
    this.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at, workspace_root, source) VALUES (?,?,?,?,?,?)')
      .run(s.id, s.title, s.createdAt, s.updatedAt, workspaceRoot ?? null, source ?? null);
    return s;
  }

  /** 写会话工作区；传 undefined/空串即清除（回落沙箱桶）。 */
  setWorkspaceRoot(sessionId: string, root: string | undefined): void {
    this.assertNotDeleted(sessionId);
    const val = (typeof root === 'string' && root.trim() !== '') ? root.trim() : null;
    this.db.prepare('UPDATE sessions SET workspace_root=?, updated_at=? WHERE id=?').run(val, this.nowEpoch(), sessionId);
    this.onDirty?.(sessionId);
  }

  /** 同步读取，供 MinisPaths.workspaceOf 的解析器用（热路径：每次路径解析都会调）。 */
  getWorkspaceRoot(sessionId: string): string | undefined {
    const r = this.selectWorkspace.get(sessionId) as { workspace_root: string | null } | undefined;
    return r?.workspace_root ?? undefined;
  }

  /** F11B：保留副本（remote_tombstoned_at 非空）对这里等同不存在——它已在别的设备上删除，本机只是替用户留着内容，
   *  不显示、不运行、不同步；要看它走 listRetainedSessions。 */
  getSession(id: string): SessionMeta | undefined {
    const r = this.selectSession.get(id) as SessionRow | undefined;
    return r ? ChatStore.sessionMeta(r) : undefined;
  }

  private static sessionMeta(r: SessionRow): SessionMeta {
    return { id: r.id, title: r.title, modelBinding: r.model_binding ?? undefined, memoryEnabled: r.memory_enabled === 1, workspaceRoot: r.workspace_root ?? undefined, mcpDisabled: ChatStore.parseMcpDisabled(r.mcp_disabled_json), assistantId: r.assistant_id ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at, pinnedAt: r.pinned_at ?? undefined };
  }

  listSessions(): SessionMeta[] {
    const rows = this.selectSessions.all() as SessionRow[];
    return rows.map(r => ChatStore.sessionMeta(r));
  }

  updateSessionTitle(id: string, title: string): void {
    this.assertNotDeleted(id);
    this.db.prepare('UPDATE sessions SET title=?, updated_at=? WHERE id=?').run(title, this.nowEpoch(), id);
    this.onDirty?.(id);
  }

  /** 写入 sessions.model_binding；取值约定见 Global Constraints。undefined/空串 = 清除。 */
  setModelBinding(sessionId: string, binding: string | undefined): void {
    this.assertNotDeleted(sessionId);
    const val = (typeof binding === 'string' && binding.trim() !== '') ? binding.trim() : null;
    this.db.prepare('UPDATE sessions SET model_binding=?, updated_at=? WHERE id=?').run(val, this.nowEpoch(), sessionId);
    this.onDirty?.(sessionId);
  }

  /** 写入 sessions.assistant_id（J1 会话绑定助手）；undefined/空串 = 清除。
   *  不触发 onDirty：助手是本机预设，wire 格式无此类目（annotations 同款裁定）。 */
  setAssistant(sessionId: string, assistantId: string | undefined): void {
    this.assertNotDeleted(sessionId);
    const val = (typeof assistantId === 'string' && assistantId.trim() !== '') ? assistantId.trim() : null;
    this.db.prepare('UPDATE sessions SET assistant_id=?, updated_at=? WHERE id=?').run(val, this.nowEpoch(), sessionId);
  }

  /** 置顶时间与其它会话时间一样使用 epoch 秒；取消置顶清为 NULL。 */
  setPinned(sessionId: string, pinned: boolean): void {
    this.assertNotDeleted(sessionId);
    const now = this.nowEpoch();
    this.db.prepare('UPDATE sessions SET pinned_at=?, updated_at=? WHERE id=?').run(pinned ? now : null, now, sessionId);
    this.onDirty?.(sessionId);
  }

  /** 写入 sessions.memory_enabled（设计 §3.4 会话级记忆开关）。 */
  setMemoryEnabled(sessionId: string, enabled: boolean): void {
    this.assertNotDeleted(sessionId);
    this.db.prepare('UPDATE sessions SET memory_enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, this.nowEpoch(), sessionId);
    this.onDirty?.(sessionId);
  }

  /** mcp_disabled_json 原始值的统一解析：空/损坏/形态不对一律回 []——
   *  这一列只是工具过滤开关，坏数据不该让会话不可用（getSession 与 getMcpDisabled 共用）。 */
  private static parseMcpDisabled(raw: string | null): string[] {
    if (raw === null) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  }

  /** 读会话禁用的 MCP server 名单（D5 §5.2 调用层硬执行的数据源）。 */
  getMcpDisabled(sessionId: string): string[] {
    const r = this.db.prepare('SELECT mcp_disabled_json FROM sessions WHERE id=?').get(sessionId) as { mcp_disabled_json: string | null } | undefined;
    return ChatStore.parseMcpDisabled(r?.mcp_disabled_json ?? null);
  }

  /** 写会话禁用的 MCP server 名单；空数组/去重后写 JSON（空写 '[]' 而非 NULL，读侧同形）。 */
  setMcpDisabled(sessionId: string, servers: string[]): void {
    this.assertNotDeleted(sessionId);
    const list = [...new Set(servers.filter(s => typeof s === 'string'))];
    this.db.prepare('UPDATE sessions SET mcp_disabled_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(list), this.nowEpoch(), sessionId);
    this.onDirty?.(sessionId);
  }

  // ── F11B 生命周期登记（墓碑、保留副本、显式恢复；规格 docs/specs/2026-10-03-f11b-delete-propagation.md）──
  //
  // 一个会话 id 在本机只有三种状态：存活（没有登记或登记为偶数，会话行可见）、已删除且已清（登记为奇数，没有会话行）、
  // 已删除但保留副本（登记为奇数，会话行还在、remote_tombstoned_at 非空）。保留副本出现在「对端删除了这个会话、
  // 而本机有删除方没见过的消息或本机标注」时：内容一行不动、不显示、不同步，等用户恢复或彻底删除。
  // 所有裁决只读 (version, op_id) 与消息 id 集合；表里的时间列只用于展示与压实的早晚。

  private static parseSeenIds(raw: string | null): string[] | undefined {
    if (raw === null) return undefined;
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) && v.every(x => typeof x === 'string') ? v as string[] : undefined;
    } catch { return undefined; }
  }

  getLifecycle(sessionId: string): LifecycleRecord | undefined {
    const r = this.db.prepare('SELECT * FROM session_lifecycle WHERE session_id=?').get(sessionId) as LifecycleRow | undefined;
    if (!r) return undefined;
    const rec: LifecycleRecord = { v: r.version, opId: r.op_id, originDeviceId: r.origin_device_id, at: r.origin_at, recordedAt: r.recorded_at };
    if (r.received_from !== null) rec.receivedFrom = r.received_from;
    if (isDeletedVersion(r.version) && r.seen_count !== null && r.seen_digest !== null) {
      const seen: WireSeen = { count: r.seen_count, digest: r.seen_digest };
      const ids = ChatStore.parseSeenIds(r.seen_ids_json);
      if (ids) seen.ids = ids;
      rec.seen = seen;
    }
    return rec;
  }

  /** 「这个会话已死」的唯一判据：登记为奇数。保留副本也算已删除。 */
  isDeleted(sessionId: string): boolean {
    const r = this.db.prepare('SELECT version FROM session_lifecycle WHERE session_id=?').get(sessionId) as { version: number } | undefined;
    return r !== undefined && isDeletedVersion(r.version);
  }

  /** 已删除的会话不接受写入：会话属性（标题、工作区、模型绑定、助手、记忆开关、MCP 禁用名单）与标注都在此列，
   *  消息与摘要在 appendMessage / appendCompactMarker 里各有同一句。保留副本是冻结的——它被留下的依据是
   *  「有对方没见过的消息或本机标注」，放任直接调用去改它，这个依据就能被绕开（删掉标注之后，同一代的墓碑会把副本清掉）。
   *  放在存储层：界面到不了隐藏的会话，但本机连接与已配对设备可以直接调这些方法。从未删除过的 id 不受影响。
   *  不归本类写的两处另有各自的闸：会话的技能覆盖（SkillStore 写）判在 skills.setEnabled 处理器里，
   *  sync.ack 写的 last_synced_at 在它的 UPDATE 条件里。 */
  private assertNotDeleted(sessionId: string): void {
    if (this.isDeleted(sessionId)) throw new Error('会话已删除');
  }

  /** 本机对这个会话的线上声明（v>0 时有）。seen 的 ids 已压实时不带。 */
  wireLifecycle(sessionId: string): WireLifecycle | undefined {
    const r = this.getLifecycle(sessionId);
    return r ? stripRecord(r) : undefined;
  }

  /** 全部奇数登记的头（对账时与对端的清单比，只补差量）。 */
  listTombstoneHeads(): WireLifecycleHead[] {
    const rows = this.db.prepare('SELECT session_id, version, op_id FROM session_lifecycle WHERE version % 2 = 1 ORDER BY session_id').all() as
      { session_id: string; version: number; op_id: string }[];
    return rows.map(r => ({ id: r.session_id, v: r.version, opId: r.op_id }));
  }

  /** 含隐藏行的裸查询：生命周期的判断要看「行在不在」，不能走 getSession（它看不到保留副本）。 */
  private rawSessionRow(id: string): { id: string; title: string; remote_tombstoned_at: number | null } | undefined {
    return this.db.prepare('SELECT id, title, remote_tombstoned_at FROM sessions WHERE id=?').get(id) as
      { id: string; title: string; remote_tombstoned_at: number | null } | undefined;
  }

  private messageIdsOf(sessionId: string): string[] {
    return (this.db.prepare('SELECT id FROM messages WHERE session_id=?').all(sessionId) as { id: string }[]).map(r => r.id);
  }

  private annotationCountOf(sessionId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM annotations WHERE session_id=?').get(sessionId) as { c: number }).c;
  }

  /** 写登记（整行换成 l）。登记只增不减：调用方都先比过全序，这里再挡一次——倒退的登记会让已删除的会话重新可写。 */
  private writeLifecycle(sessionId: string, l: WireLifecycle, receivedFrom: string | undefined): void {
    if (compareLifecycle(l, this.getLifecycle(sessionId)) <= 0) throw new Error('writeLifecycle：登记只增不减');
    const seen = isDeletedVersion(l.v) ? l.seen : undefined;
    this.db.prepare(`INSERT INTO session_lifecycle (session_id, version, op_id, origin_device_id, origin_at, seen_count, seen_digest, seen_ids_json, received_from, recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET version=excluded.version, op_id=excluded.op_id, origin_device_id=excluded.origin_device_id,
        origin_at=excluded.origin_at, seen_count=excluded.seen_count, seen_digest=excluded.seen_digest, seen_ids_json=excluded.seen_ids_json,
        received_from=excluded.received_from, recorded_at=excluded.recorded_at`)
      .run(sessionId, l.v, l.opId, l.originDeviceId, l.at, seen?.count ?? null, seen?.digest ?? null,
        seen?.ids ? JSON.stringify(seen.ids) : null, receivedFrom ?? null, this.nowEpoch());
  }

  /** 全仓唯一的物理删除点：清掉这个会话 id 名下的全部内容行。必须在事务里、且登记已是奇数之后调。
   *  session_lifecycle 的行不在这里，它永不删除；audit_logs 也不在，审计独立于会话的生命周期。
   *  别的会话的行只动一处：同一文件上的检查点记录里记着的文件 ID 置空（见下面 F08 一段），内容与状态不动。 */
  private purgeSessionRows(id: string): void {
    // 运行期防线：登记不是奇数就不许物理删行——没有墓碑的删除，下一次对账就会被对端的旧副本带回来
    if (!this.isDeleted(id)) throw new Error('purgeSessionRows：登记不是已删除');
    this.db.prepare('DELETE FROM session_inputs WHERE session_id=?').run(id); // F07: inbox follows every physical deletion path
    this.db.prepare('DELETE FROM messages WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM compact_markers WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM compact_marker_meta WHERE session_id=?').run(id); // F03: local marker metadata follows all physical deletion paths
    // 孤儿摘要此前不在删除链路里（留下的行再也没人清），一并补上
    this.db.prepare('DELETE FROM sync_orphan_markers WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM annotations WHERE session_id=?').run(id);
    // J1 随动修缺（设计稿 §3 申报）：该表此前不在删除链路，助手快照批量写覆盖后
    // 残留会随会话数膨胀——趁本波一并治理
    this.db.prepare('DELETE FROM session_skill_overrides WHERE session_id=?').run(id);
    // F11A 的附件索引行按会话归属，随会话一起清（附件文件不删，见规格文档的已知边界）
    this.db.prepare('DELETE FROM sync_attachments WHERE session_id=?').run(id);
    // F05：运行账本随会话删除（同一个事务）。放在这里而不是删除处理器里：对端墓碑清会话时也不会留孤儿行。
    // 保留副本不走这里，它的账本行与内容一起留着：显式恢复之后「第几次运行」接着数、旧的 promptId 仍去重
    this.db.prepare('DELETE FROM tool_executions WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM agent_runs WHERE session_id=?').run(id);
    // F08：文件检查点记录属于会话内容，随它一起物理清除（此后这些改动不能再恢复）；内容文件由下一次回收按引用清。
    // 保留副本不走这里，它的检查点与内容一起留着。
    // 例外：还记着残留临时文件的行（用户目录里一时删不掉的 .dm-*.tmp）不能直接删——删了就再没人知道那个文件，
    // 新建路径上它是目标的第二个硬链接，目标从此对所有会话都写不了。这种行留成不带内容引用的占位（aborted / session-deleted），
    // 检查点存储确认临时文件不在之后自己删掉它（CheckpointStore.cleanTemps）
    //
    // 删行之前先处理同一路径上别的会话的记录（这时本会话的行还在，才知道是哪些路径）：「磁盘上现在该是哪个文件」（文件 ID）
    // 是沿同一路径上的全部记录推出来的（CheckpointService.expectedFileId）——本应用每次写入、每次恢复都会换掉文件 ID。
    // 本会话在这些路径上做过的写入与恢复一删，这条链就断了：别的会话更早的改动只剩它自己当初记下的旧 ID，
    // 而文件字节可以正是它写入的（本会话恢复过自己的改动，或把内容改回去过）——留着旧 ID，它会被判成
    // 「换成了另一份内容相同的文件」，再也恢复不了。所以把这些记录上的文件 ID 置空：恢复时跳过文件 ID 这一条比对，
    // 内容哈希、大小、硬链接数与动手前的签名复核一条不少，内容被改过的文件照样不动。
    // 只看本会话确实动过文件的路径（aborted 的写入没有发生；清除后留下的占位行也是 aborted，重复清除不会再置空一遍）。
    // 「别的会话」不区分保留副本：它的记录同样置空（状态与内容引用不动，不算对会话内容的写入）——留着旧 ID，
    // 它显式恢复之后同样会被判成换了文件
    this.db.prepare(`UPDATE file_checkpoints SET file_dev=NULL, file_ino=NULL, restored_dev=NULL, restored_ino=NULL, updated_at=?
      WHERE session_id<>? AND (file_ino IS NOT NULL OR restored_ino IS NOT NULL)
        AND path_key IN (SELECT path_key FROM file_checkpoints WHERE session_id=? AND state<>'aborted')`).run(this.nowEpoch(), id, id);
    this.db.prepare('DELETE FROM file_checkpoints WHERE session_id=? AND tmp_path IS NULL AND restore_tmp_path IS NULL').run(id);
    this.db.prepare(`UPDATE file_checkpoints SET state='aborted', abort_reason='session-deleted', before_blob=NULL, after_blob=NULL, restoring_at=NULL, updated_at=? WHERE session_id=?`)
      .run(this.nowEpoch(), id);
    // F09：进程账本里按会话归属的行（shell、终端的进程树）同样随会话删除。之后迟到的关账改到 0 行，不报错
    this.db.prepare('DELETE FROM process_trees WHERE session_id=?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  }

  private emitLifecycle(e: LifecycleEvent): void {
    try { this.onLifecycle?.(e); } catch (err) {
      console.warn(`生命周期钩子出错（${e.kind} ${e.sessionId}），操作本身不受影响:`, err);
    }
  }

  /**
   * 本机删除。一个事务里先写墓碑、再清内容：任何一句失败都整体回滚（要么会话完好且没有墓碑，要么已清且有墓碑）。
   *  - 这个 id 名下什么都没有 → absent，不给从未存在的 id 造墓碑（重复删除因此幂等）；只剩技能覆盖行或运行账本行的也算这一种，顺手清掉；
   *  - 登记已是奇数（保留副本或残留行）→ purged，只清内容、版本不变，不再同步（对端早有这条墓碑）；
   *  - 其余 → 版本加一写墓碑，seen 记下此刻持有的全部消息 id，供对端判断它手里有没有本机没见过的内容。
   */
  deleteSession(id: string): DeleteSessionResult {
    const tx = this.db.transaction((): DeleteSessionResult => {
      const row = this.rawSessionRow(id);
      const ids = this.messageIdsOf(id);
      const hasMarkers = this.db.prepare('SELECT 1 FROM compact_markers WHERE session_id=? UNION ALL SELECT 1 FROM sync_orphan_markers WHERE session_id=? LIMIT 1').get(id, id) !== undefined;
      if (!row && ids.length === 0 && !hasMarkers) {
        // 这个 id 名下可能只剩技能覆盖行：对着从未存在过的 id 直接调 skills.setEnabled 写得出来，没有会话行可挂就没人回收。
        // 覆盖行只在本机、不进同步，不需要墓碑；以前的 deleteSession 无条件清这张表，这里照旧清掉
        this.db.prepare('DELETE FROM session_skill_overrides WHERE session_id=?').run(id);
        // F05：这个 id 名下可能只剩运行账本行（对着不存在的会话提问、起跑前就结束的 run）。它们只在本机、不进同步，
        // 对端带不回来，所以不需要墓碑；照「账本行随会话删除」的约定清掉，不为一个没有内容的 id 造墓碑
        this.db.prepare('DELETE FROM tool_executions WHERE session_id=?').run(id);
        this.db.prepare('DELETE FROM agent_runs WHERE session_id=?').run(id);
        // F08：文件检查点的行不在这里清。走到这一步的 id 名下至多剩「记着残留临时文件的占位行」（会话清除时留下的，
        // 见 purgeSessionRows），它们要留到检查点存储确认临时文件不在为止；带内容的检查点行只在工具写文件时产生，
        // 那时会话一定已有消息，不会落到这个分支
        // F09：同理，这个 id 名下可能只剩进程账本行（对着没有会话行的 id 打开过终端）；只在本机，照样清掉
        this.db.prepare('DELETE FROM process_trees WHERE session_id=?').run(id);
        return { kind: 'absent' };
      }
      const cur = this.getLifecycle(id);
      if (cur && isDeletedVersion(cur.v)) {
        this.purgeSessionRows(id);
        return { kind: 'purged', lifecycle: stripRecord(cur) };
      }
      const v = (cur?.v ?? 0) + 1;
      if (v > LIFECYCLE_MAX) throw new Error('这个会话的删除与恢复次数已到上限，无法再删除');
      const lifecycle: WireLifecycle = { v, opId: this.newId(), originDeviceId: this.defaultOriginDeviceId, at: this.nowEpoch(), seen: makeSeen(ids) };
      this.writeLifecycle(id, lifecycle, undefined);
      this.purgeSessionRows(id);
      return { kind: 'deleted', lifecycle, messageCount: ids.length };
    });
    const r = tx();
    if (r.kind === 'deleted') {
      this.onDirty?.(id);
      this.emitLifecycle({ kind: 'deleted', sessionId: id, lifecycle: r.lifecycle, messageCount: r.messageCount });
    } else if (r.kind === 'purged') {
      this.emitLifecycle({ kind: 'purged', sessionId: id, lifecycle: r.lifecycle });
    }
    return r;
  }

  /**
   * 应用对端的墓碑。事务内重新读登记再判（调用方在停 run 之前判过一次，期间本机可能已变）：
   *  - 对端胜出：登记换成对端的；本机副本只有在「对端见过本机全部消息、且本机没有标注」时才清，否则隐藏保留；
   *  - 同一条或同一代落败的一条：登记不动；本机若是保留副本，用这条的 seen 再判一次（并发双删时两条墓碑的 seen 可以不同）；
   *  - 更早的一代：什么都不动。
   * 清除是单调的（保留可以变成清除，清除不会变回保留），所以结果只取决于收到过哪些墓碑，与先后、重复无关。
   */
  applyTombstone(sessionId: string, t: WireLifecycle, ctx: { fromPeer?: string } = {}): TombstoneApplyResult {
    if (!isDeletedVersion(t.v)) throw new Error('applyTombstone：登记不是墓碑');
    const tx = this.db.transaction((): TombstoneApplyResult => {
      const cur = this.getLifecycle(sessionId);
      const cmp = compareLifecycle(t, cur);
      const row = this.rawSessionRow(sessionId);
      if (cmp > 0) {
        const status = cur && isDeletedVersion(cur.v) ? 'superseded' : 'applied';
        this.writeLifecycle(sessionId, t, ctx.fromPeer);
        if (!row) {
          // 没有会话行：至多有首次同步推到一半留下的残留行（界面上看不到），清掉
          this.purgeSessionRows(sessionId);
          return { status, hadLocalCopy: false, retained: false, unseenCount: 0, annotationCount: 0 };
        }
        const u = unseenOf(this.messageIdsOf(sessionId), t.seen);
        const annotationCount = this.annotationCountOf(sessionId);
        if (u.covered && annotationCount === 0) {
          this.purgeSessionRows(sessionId);
          return { status, hadLocalCopy: true, retained: false, unseenCount: 0, annotationCount: 0 };
        }
        // 保留副本：内容一行不动，只打隐藏标记（已有标记时不改，它记的是第一次被覆盖的时刻）
        this.db.prepare('UPDATE sessions SET remote_tombstoned_at = COALESCE(remote_tombstoned_at, ?) WHERE id=?').run(this.nowEpoch(), sessionId);
        return { status, hadLocalCopy: true, retained: true, unseenCount: u.unseen, annotationCount };
      }
      const status = cmp === 0 ? 'duplicate' : 'stale';
      const sameGeneration = cur !== undefined && cur.v === t.v;
      if (!sameGeneration || !row || row.remote_tombstoned_at === null) return { status, released: false };
      const u = unseenOf(this.messageIdsOf(sessionId), t.seen);
      if (!u.covered || this.annotationCountOf(sessionId) > 0) return { status, released: false };
      this.purgeSessionRows(sessionId);
      return { status, released: true };
    });
    const r = tx();
    if (!('released' in r)) {
      // 登记变了（applied / superseded）：向本机的其它对端转发
      this.onDirty?.(sessionId);
      this.emitLifecycle({
        kind: 'tombstone-applied', sessionId, lifecycle: t, fromPeer: ctx.fromPeer,
        hadLocalCopy: r.hadLocalCopy, retained: r.retained, unseenCount: r.unseenCount, annotationCount: r.annotationCount,
      });
    } else if (r.released) {
      // 登记没变，不 onDirty；重复、过期的墓碑到此为止，不写库、不转发、不广播
      this.emitLifecycle({ kind: 'retained-released', sessionId, lifecycle: this.wireLifecycle(sessionId) ?? t, fromPeer: ctx.fromPeer });
    }
    return r;
  }

  /** 显式恢复本机的保留副本：版本加一变偶数，会话重新可见并参与同步。不是保留副本时抛错。
   *  恢复与「旧副本被同步回来」的区别只在版本，不在时间：对端按更高的偶数登记接受它，普通旧内容仍被拒收。 */
  restoreSession(id: string): { lifecycle: WireLifecycle } {
    const tx = this.db.transaction((): { lifecycle: WireLifecycle } => {
      const row = this.rawSessionRow(id);
      const cur = this.getLifecycle(id);
      if (!row || row.remote_tombstoned_at === null || !cur || !isDeletedVersion(cur.v)) {
        throw new Error('没有可恢复的内容：这个会话在本机已清除，或并未被其他设备删除');
      }
      const v = cur.v + 1;
      if (v > LIFECYCLE_MAX) throw new Error('这个会话的删除与恢复次数已到上限，无法再恢复');
      const lifecycle: WireLifecycle = { v, opId: this.newId(), originDeviceId: this.defaultOriginDeviceId, at: this.nowEpoch() };
      this.writeLifecycle(id, lifecycle, undefined);
      this.db.prepare('UPDATE sessions SET remote_tombstoned_at = NULL, updated_at = ? WHERE id=?').run(this.nowEpoch(), id);
      return { lifecycle };
    });
    const r = tx();
    this.onDirty?.(id);
    this.emitLifecycle({ kind: 'restored', sessionId: id, lifecycle: r.lifecycle });
    return r;
  }

  /**
   * 彻底删除本机的保留副本：只清本机留着的内容，登记不动，不再同步（对端早有这条墓碑）。此刻不是保留副本就抛错，什么都不动。
   * 与 deleteSession 分开，是因为那一个把调用理解成「删除这个会话」：保留副本刚被别的设备（或本机另一个窗口）恢复、
   * 调用方手里的保留清单还没重拉时，同一个调用落到的是一个存活的会话——会写出新的墓碑，把刚恢复的会话在所有设备上再删一次。
   * 判断与清除在同一个事务里，中间插不进别的操作。
   */
  purgeRetained(id: string): { lifecycle: WireLifecycle } {
    const tx = this.db.transaction((): { lifecycle: WireLifecycle } => {
      const row = this.rawSessionRow(id);
      const cur = this.getLifecycle(id);
      if (!row) throw new Error('这个会话在本机已经清除（或不存在），没有可彻底删除的内容');
      if (row.remote_tombstoned_at === null || !cur || !isDeletedVersion(cur.v)) {
        throw new Error('这个会话已不是保留副本（它已被恢复，或并未被其他设备删除），没有删除任何内容');
      }
      this.purgeSessionRows(id);
      return { lifecycle: stripRecord(cur) };
    });
    const r = tx();
    // 登记没变，不 onDirty
    this.emitLifecycle({ kind: 'purged', sessionId: id, lifecycle: r.lifecycle });
    return r;
  }

  /** 保留副本列表（设备页「已在其他设备删除」）。 */
  listRetainedSessions(): RetainedSession[] {
    const rows = this.db.prepare('SELECT id, title, remote_tombstoned_at FROM sessions WHERE remote_tombstoned_at IS NOT NULL ORDER BY remote_tombstoned_at DESC, id').all() as
      { id: string; title: string; remote_tombstoned_at: number }[];
    return rows.map(r => {
      const cur = this.getLifecycle(r.id);
      const ids = this.messageIdsOf(r.id);
      return {
        id: r.id, title: r.title,
        deletedBy: cur?.originDeviceId ?? '', deletedAt: cur?.at ?? 0, retainedAt: r.remote_tombstoned_at,
        messageCount: ids.length, unseenCount: unseenOf(ids, cur?.seen).unseen, annotationCount: this.annotationCountOf(r.id),
      };
    });
  }

  /** 墓碑 GC = 压实：把记录时刻早于 nowS - maxAgeS 的墓碑的消息 id 列表置空，返回压实条数。行永不删——
   *  整行删掉之后，带着旧副本回来的设备与一个全新的会话在协议上分不出来。条数与摘要留着：副本与删除方当时
   *  完全相同的设备仍能精确清除，不相同的保留待用户决定。保留副本的那一行不压（列表里的「N 条对方没见过」要用它算）。 */
  compactTombstones(nowS: number, maxAgeS: number): number {
    return this.db.prepare(`UPDATE session_lifecycle SET seen_ids_json = NULL
      WHERE version % 2 = 1 AND seen_ids_json IS NOT NULL AND recorded_at < ? AND session_id NOT IN (SELECT id FROM sessions)`)
      .run(nowS - maxAgeS).changes;
  }

  /** 启动自检：登记与隐藏标记不一致（外力改库、历史缺陷）时，宁可显示或保留，不清内容。
   *  标记非空但登记不是奇数 → 清掉标记，会话重新可见；登记为奇数、会话行存在但没有标记 → 补上标记，按保留副本处理。 */
  repairLifecycle(): { unhidden: number; hidden: number } {
    const tx = this.db.transaction(() => {
      const unhidden = this.db.prepare(`UPDATE sessions SET remote_tombstoned_at = NULL
        WHERE remote_tombstoned_at IS NOT NULL AND id NOT IN (SELECT session_id FROM session_lifecycle WHERE version % 2 = 1)`).run().changes;
      const hidden = this.db.prepare(`UPDATE sessions SET remote_tombstoned_at = ?
        WHERE remote_tombstoned_at IS NULL AND id IN (SELECT session_id FROM session_lifecycle WHERE version % 2 = 1)`).run(this.nowEpoch()).changes;
      return { unhidden, hidden };
    });
    const r = tx();
    if (r.unhidden > 0 || r.hidden > 0) {
      console.warn(`会话生命周期自检：${r.unhidden} 个会话的隐藏标记没有对应的删除登记，已恢复显示；${r.hidden} 个已删除的会话还留着内容，已按保留副本处理`);
    }
    return r;
  }

  // ── H1 文本选区注释（设计稿 §1-3/§1-5）──
  // 注释不触发 onDirty：不入设备同步面（wire 格式无此类目，脏标记只会空跑一轮同步）。

  private static rowToAnnotation(r: AnnotationRow): Annotation {
    return {
      id: r.id, sessionId: r.session_id, messageId: r.message_id,
      exact: r.exact, prefix: r.prefix, suffix: r.suffix, note: r.note, color: r.color,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  /** created_at 同刻靠 rowid 决序（Windows 时钟 ~15ms 分辨率，连续 add 会同刻——getLatestCompactMarker 同一教训）。 */
  listAnnotations(sessionId: string): Annotation[] {
    const rows = this.db.prepare('SELECT * FROM annotations WHERE session_id=? ORDER BY created_at, rowid').all(sessionId) as AnnotationRow[];
    return rows.map(ChatStore.rowToAnnotation);
  }

  addAnnotation(a: { sessionId: string; messageId: string; exact: string; prefix?: string; suffix?: string; note?: string; color?: string }): Annotation {
    // F11B：已删除的会话不再接受标注（已清除的会留下没有会话行的孤儿标注；保留副本是冻结的）
    this.assertNotDeleted(a.sessionId);
    const now = this.nowEpoch();
    const row: Annotation = {
      id: this.newId(), sessionId: a.sessionId, messageId: a.messageId,
      exact: a.exact.slice(0, ANNO_TEXT_MAX),
      prefix: (a.prefix ?? '').slice(0, ANNO_CONTEXT_MAX),
      suffix: (a.suffix ?? '').slice(0, ANNO_CONTEXT_MAX),
      note: (a.note ?? '').slice(0, ANNO_TEXT_MAX),
      color: (a.color ?? '').slice(0, ANNO_CONTEXT_MAX),
      createdAt: now, updatedAt: now,
    };
    this.db.prepare('INSERT INTO annotations (id, session_id, message_id, exact, prefix, suffix, note, color, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.sessionId, row.messageId, row.exact, row.prefix, row.suffix, row.note, row.color, row.createdAt, row.updatedAt);
    return row;
  }

  /** 返回所属会话 id 供调用方定向广播；未知 id 返回 undefined（幂等，不抛）。
   *  F11B：所属会话是保留副本时抛「会话已删除」——标注是它被留下的依据之一，冻结期间不许改、不许删。 */
  updateAnnotationNote(id: string, note: string): string | undefined {
    const r = this.db.prepare('SELECT session_id FROM annotations WHERE id=?').get(id) as { session_id: string } | undefined;
    if (!r) return undefined;
    this.assertNotDeleted(r.session_id);
    this.db.prepare('UPDATE annotations SET note=?, updated_at=? WHERE id=?')
      .run(note.slice(0, ANNO_TEXT_MAX), this.nowEpoch(), id);
    return r.session_id;
  }

  /** 返回所属会话 id 供调用方定向广播；未知 id 返回 undefined（幂等，不抛）。
   *  F11B：所属会话是保留副本时抛「会话已删除」。只因本机标注而留下的副本，标注一删，下一条同代墓碑就会把它清掉。 */
  removeAnnotation(id: string): string | undefined {
    const r = this.db.prepare('SELECT session_id FROM annotations WHERE id=?').get(id) as { session_id: string } | undefined;
    if (!r) return undefined;
    this.assertNotDeleted(r.session_id);
    this.db.prepare('DELETE FROM annotations WHERE id=?').run(id);
    return r.session_id;
  }

  /** 追加压缩摘要 marker（设计 §4.2「压缩」）：锚定 lastCompactedMessageId，推理时合成 effectiveAgentHistory。 */
  appendCompactMarker(sessionId: string, summary: string, lastCompactedMessageId: string, meta?: CompactMeta): CompactMarker {
    if (this.isDeleted(sessionId)) throw new Error('会话已删除');
    const m: CompactMarker = { id: this.newId(), sessionId, summary, lastCompactedMessageId, createdAt: this.nowEpoch(), ...(meta ? { meta } : {}) };
    // F03：有 meta 时 marker 行与 meta 行同一个事务（I9）——只写进一半的话，一条 marker 就成了「有结构的摘要、没有程序记录」。
    // 没有 meta 时与以前相同（一条 INSERT）
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO compact_markers (id, session_id, summary, last_compacted_message_id, created_at) VALUES (?,?,?,?,?)')
        .run(m.id, m.sessionId, m.summary, m.lastCompactedMessageId, m.createdAt);
      if (meta) {
        this.db.prepare('INSERT INTO compact_marker_meta (marker_id, session_id, v, meta_json, created_at) VALUES (?,?,?,?,?)')
          .run(m.id, m.sessionId, meta.v, JSON.stringify(meta), m.createdAt);
      }
    })();
    this.onDirty?.(sessionId);
    return m;
  }

  /** 取该会话最新的压缩 marker（按 createdAt DESC）；无则 undefined。
   *  rowid DESC 作 tiebreaker：Windows 下 Date.now() 分辨率约 15ms，连续两次 appendCompactMarker
   *  可能落到同一 createdAt，单按 created_at 排序非确定性，需以插入顺序（rowid）兜底确保「最新插入」返回。 */
  getLatestCompactMarker(sessionId: string): CompactMarker | undefined {
    // F03：左连 compact_marker_meta。meta 解析不了（坏 JSON、版本不认识、锚点或 summary 被同步合并改写过）当没有：
    // 对象上不带 meta 键，这条 marker 退化成旧 marker，不报错
    const r = this.db.prepare(`SELECT m.id, m.session_id, m.summary, m.last_compacted_message_id, m.created_at, x.meta_json
      FROM compact_markers m LEFT JOIN compact_marker_meta x ON x.marker_id = m.id
      WHERE m.session_id=? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`).get(sessionId) as
      { id: string; session_id: string; summary: string; last_compacted_message_id: string; created_at: number; meta_json: string | null } | undefined;
    if (!r) return undefined;
    const marker: CompactMarker = { id: r.id, sessionId: r.session_id, summary: r.summary, lastCompactedMessageId: r.last_compacted_message_id, createdAt: r.created_at };
    const meta = parseCompactMeta(r.meta_json, marker);
    return meta ? { ...marker, meta } : marker;
  }

  appendMessage(m: Omit<RawMessage, 'sortOrder' | 'updatedAt'>): RawMessage {
    // F11B：登记为奇数的会话写不进去。放在存储层而不是 chat.prompt 的入口：界面、定时任务、已配对设备
    // 都从这里落消息，哪个调用方都绕不过；否则已清除的会话里会长出没有会话行的孤儿消息。
    if (this.isDeleted(m.sessionId)) throw new Error('会话已删除');
    const { mx } = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) mx FROM messages WHERE session_id=?').get(m.sessionId) as { mx: number };
    const full: RawMessage = {
      ...m, sortOrder: mx + 1, updatedAt: this.nowEpoch(),
      originDeviceId: m.originDeviceId ?? this.defaultOriginDeviceId,
      createdLocallyAt: m.createdLocallyAt ?? m.createdAt,
    };
    this.db.prepare(`INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, token_usage, sort_order, reasoning_content, stream_interrupt_count, error_info, origin_device_id, created_locally_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(full.id, full.sessionId, full.role, serializeParts(full.parts), full.createdAt, full.updatedAt,
        full.tokenUsage ? JSON.stringify(full.tokenUsage) : null, full.sortOrder,
        full.reasoningContent ?? null, full.streamInterruptCount, full.errorInfo ?? null,
        full.originDeviceId, full.createdLocallyAt);
    this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(full.updatedAt, full.sessionId);
    this.onDirty?.(full.sessionId);
    return full;
  }

  /** Q14：改已落库消息的内容，手里已有历史的界面看不到——chat.messages.list 的增量（listMessagesAfter）只给新落库的消息，
   *  凭的就是「落库之后内容不变」。产品代码里目前没有调用方；要用它的话得同时让界面重取完整历史。 */
  updateMessage(id: string, patch: { parts?: RawMessage['parts']; tokenUsage?: TokenUsage; errorInfo?: string; streamInterruptCount?: number }): void {
    const sets: string[] = ['updated_at=@now'];
    const args: Record<string, unknown> = { id, now: this.nowEpoch() };
    if (patch.parts !== undefined) { sets.push('parts_json=@parts'); args.parts = serializeParts(patch.parts); }
    if (patch.tokenUsage !== undefined) { sets.push('token_usage=@usage'); args.usage = JSON.stringify(patch.tokenUsage); }
    if (patch.errorInfo !== undefined) { sets.push('error_info=@err'); args.err = patch.errorInfo; }
    if (patch.streamInterruptCount !== undefined) { sets.push('stream_interrupt_count=@sic'); args.sic = patch.streamInterruptCount; }
    this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id=@id`).run(args);
    const row = this.db.prepare('SELECT session_id FROM messages WHERE id=?').get(id) as { session_id: string } | undefined;
    if (row) this.onDirty?.(row.session_id);
  }

  /** 只读取消息时间上界，供循环在投递排队输入之前推进时钟。空会话返回 undefined。 */
  getMaxMessageCreatedAt(sessionId: string): number | undefined {
    const r = this.selectMessageMax.get(sessionId) as { created_at: number | null };
    return r.created_at ?? undefined;
  }

  listMessages(sessionId: string): RawMessage[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC, id ASC').all(sessionId) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Q14：调用方手里已有这个会话按列表顺序的前 count 条、其中最后一条是 lastId 时，只给排在它之后的消息
   * （与 listMessages 同一排序、同一形状）。接不上时返回 undefined，调用方改取完整列表：
   *  - have 的形状不对；
   *  - lastId 不是这个会话的消息；
   *  - 排到 lastId 为止的条数不是 count——同步合并进来了时间更早的消息（列表按 created_at、id 排，
   *    新到的消息不一定在末尾），或者对方手里的不是这个会话此刻的前缀。
   * 条数对得上就说明对方手里的正是这一段：消息落库之后不改内容（updateMessage 在产品代码里没有调用方）、
   * 不单条删除（只有整会话删除），同一段位置上不会换成别的消息。
   * 排到 lastId 为止的条数只走 idx_messages_session，不读消息正文。
   */
  listMessagesAfter(sessionId: string, have: unknown): RawMessage[] | undefined {
    const { count, lastId } = (have ?? {}) as { count?: unknown; lastId?: unknown };
    if (count === 0) return this.listMessages(sessionId); // 手里一条都没有：全部都排在「之后」
    if (typeof lastId !== 'string') return undefined;
    const last = this.db.prepare('SELECT created_at FROM messages WHERE id=? AND session_id=?').get(lastId, sessionId) as { created_at: number } | undefined;
    if (!last) return undefined;
    const { n } = this.db.prepare('SELECT COUNT(*) n FROM messages WHERE session_id=? AND (created_at, id) <= (?, ?)')
      .get(sessionId, last.created_at, lastId) as { n: number };
    // 严格相等：count 不是这个整数（包括根本不是数字）都算接不上，不另外校验它的形状
    if (n !== count) return undefined;
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id=? AND (created_at, id) > (?, ?) ORDER BY created_at ASC, id ASC')
      .all(sessionId, last.created_at, lastId) as MessageRow[];
    return rows.map(toMessage);
  }

  /** F05：会话的最后一条消息（与 listMessages 同一排序的末位）。恢复据此判断「那条 assistant 是否仍是最后一条」——
   *  是才补结果消息；后面已有别的消息时补的结果不会紧跟它，只关账不补。 */
  lastMessageRef(sessionId: string): { id: string; role: RawMessage['role']; createdAt: number } | undefined {
    const r = this.db.prepare('SELECT id, role, created_at FROM messages WHERE session_id=? ORDER BY created_at DESC, id DESC LIMIT 1').get(sessionId) as
      { id: string; role: string; created_at: number } | undefined;
    return r ? { id: r.id, role: r.role as RawMessage['role'], createdAt: r.created_at } : undefined;
  }

  // ===== M3b 同步接口 =====

  /** 返回会话全部压缩 marker（按 createdAt ASC，rowid ASC 兜底）。M3b mergeSession 需要全量做 LWW。 */
  listCompactMarkers(sessionId: string): CompactMarker[] {
    const rows = this.db.prepare('SELECT * FROM compact_markers WHERE session_id=? ORDER BY created_at ASC, rowid ASC').all(sessionId) as
      { id: string; session_id: string; summary: string; last_compacted_message_id: string; created_at: number }[];
    return rows.map(r => ({ id: r.id, sessionId: r.session_id, summary: r.summary, lastCompactedMessageId: r.last_compacted_message_id, createdAt: r.created_at }));
  }

  /** 返回 sync_orphan_markers 里的 orphan marker（评审命门 2：脱孤检查用）。 */
  listOrphanMarkers(sessionId: string): CompactMarker[] {
    const rows = this.db.prepare('SELECT * FROM sync_orphan_markers WHERE session_id=?').all(sessionId) as
      { id: string; session_id: string; summary: string; last_compacted_message_id: string; created_at: number; received_at: number }[];
    return rows.map(r => ({ id: r.id, sessionId: r.session_id, summary: r.summary, lastCompactedMessageId: r.last_compacted_message_id, createdAt: r.created_at }));
  }

  /** 返回会话 cursor（供 sync.cursor）：lastMessageTs / lastMarkerTs，空会话返回 0/0。 */
  getSessionCursor(sessionId: string): { lastMessageTs: number; lastMarkerTs: number } {
    const msgRow = this.db.prepare('SELECT MAX(created_at) mx FROM messages WHERE session_id=?').get(sessionId) as { mx: number | null };
    const markerRow = this.db.prepare('SELECT MAX(created_at) mx FROM compact_markers WHERE session_id=?').get(sessionId) as { mx: number | null };
    return { lastMessageTs: msgRow.mx ?? 0, lastMarkerTs: markerRow.mx ?? 0 };
  }

  /** 返回本地全部会话 + 各自 cursor（首次连接对端 sync.list 用）。 */
  listSyncedSessions(): Array<SessionMeta & { cursor: { lastMessageTs: number; lastMarkerTs: number }; lifecycle?: { v: number; opId: string } }> {
    return this.listSessions().map(s => {
      const out: SessionMeta & { cursor: { lastMessageTs: number; lastMarkerTs: number }; lifecycle?: { v: number; opId: string } } =
        { ...s, cursor: this.getSessionCursor(s.id) };
      // F11B：恢复过的会话带上登记的头（v≥2），对端据此知道自己手里的墓碑已经过期
      const cur = this.getLifecycle(s.id);
      if (cur && cur.v >= 2 && !isDeletedVersion(cur.v)) out.lifecycle = { v: cur.v, opId: cur.opId };
      return out;
    });
  }

  /**
   * M3c Task 6 决策 4：构建分批 push 载荷（消除 >1MB 死区，必改 1）。
   *
   * 按 createdLocallyAt/createdAt 升序切批，每批序列化 ≤ maxBytes；markers + session 放最后一批。
   * 单条消息自身超 maxBytes 跳过留 warn（极端情况，避免死循环）。
   * @param sessionId 会话 ID
   * @param maxBytes 单批序列化上限，默认 512KB
   * @returns 分批载荷数组（每批 { messages, markers, session? }）
   */
  buildPushBatches(
    sessionId: string,
    maxBytes: number = 512 * 1024,
  ): SyncPayload[] {
    const session = this.getSession(sessionId);
    if (!session) return []; // 会话不存在（或是保留副本），空批
    const allMsgs = this.listMessages(sessionId);
    const allMarkers = this.listCompactMarkers(sessionId);
    // 按 createdLocallyAt/createdAt 升序（与落库顺序一致，对端 merge 顺序稳定）
    const sortedMsgs = [...allMsgs].sort((a, b) => (a.createdLocallyAt ?? a.createdAt) - (b.createdLocallyAt ?? b.createdAt));
    const wireMsgs = sortedMsgs.map(toWireMessage);
    const wireMarkers = allMarkers.map(m => toWireMarker(m, allMsgs));
    const wireSession = toWireSession(session);

    // F11B：恢复过的会话（登记为偶数且 ≥2）每一批都带 lifecycle 与 session。
    //  - 带版本：恢复的第一批往往只有消息，不带版本会被对端当成旧副本拒收；
    //  - 带会话行：对端第一批就建行，推到一半断线留下的是一个内容不全但可见、照常同步的会话，
    //    而不是「登记是偶数、有消息、没有会话行」这种谁也看不见、登记永远追不平的中间态。
    // 登记为 0 的普通会话不变：会话行仍只在最后一批。
    const reg = this.getLifecycle(sessionId);
    const lifecycle = reg && reg.v >= 2 && !isDeletedVersion(reg.v) ? stripRecord(reg) : undefined;
    const sessionSize = JSON.stringify(wireSession).length;
    const headSize = lifecycle ? sessionSize + JSON.stringify(lifecycle).length : 0;
    const newBatch = (): SyncPayload => (lifecycle ? { messages: [], markers: [], session: wireSession, lifecycle } : { messages: [], markers: [] });

    const batches: SyncPayload[] = [];
    let cur = newBatch();
    let curSize = 2 + headSize; // "[]"

    for (const msg of wireMsgs) {
      const msgSize = JSON.stringify(msg).length;
      // 单条超限跳过（极端情况，留 warn）
      if (msgSize > maxBytes) {
        console.warn(`buildPushBatches: 消息 ${msg.id} 序列化 ${msgSize} 字节超 maxBytes ${maxBytes}，跳过`);
        continue;
      }
      // 加入后超限 → 开新批（当前批非空才推）
      if (cur.messages.length > 0 && curSize + msgSize > maxBytes) {
        batches.push(cur);
        cur = newBatch();
        curSize = 2 + headSize;
      }
      cur.messages.push(msg);
      curSize += msgSize + 1; // +1 逗号
    }

    // markers + session 放最后一批（最后一批超限则单独一批）
    const markersSize = JSON.stringify(wireMarkers).length;
    // 每批都带会话行时它已经算在 curSize 里，不重复计
    if (curSize + markersSize + (lifecycle ? 0 : sessionSize) > maxBytes && cur.messages.length > 0) {
      batches.push(cur);
      cur = newBatch();
    }
    cur.markers = wireMarkers;
    cur.session = wireSession;
    batches.push(cur);

    return batches;
  }

  /**
   * 合并远端会话数据并落库（设计 §1-M3b / 评审命门 1/2）。
   * 红线：
   *  - raw history 追加型永不改写：新消息 INSERT OR IGNORE，UPDATE 只碰 sort_order
   *  - orphan marker 只进 sync_orphan_markers，绝不进 compact_markers（评审命门 2）
   *  - 脱孤：本次 mergeSession 已 resolve 成功的 marker 若之前是 orphan → 删 sync_orphan_markers
   */
  mergeRemoteSession(remote: SyncPayload, sessionId: string, ctx: { fromPeer?: string } = {}): MergeRemoteResult {
    // F11B 入口闸（设计 §4.4）。lifecycle 来自网络，重新解析；不合规的按「不带版本」处理。
    const remoteReg = parseWireLifecycle(remote.lifecycle);
    // 墓碑不走这里：它要先让本机这个会话的 run 停下（receiveRemotePayload → 宿主 → applyTombstone）
    if (remoteReg && isDeletedVersion(remoteReg.v)) throw new Error('墓碑载荷须经 receiveRemotePayload');
    const tx = this.db.transaction((): MergeRemoteResult => {
      const localReg = this.getLifecycle(sessionId);
      const localWire = localReg ? stripRecord(localReg) : undefined;
      const decision = decideIncoming(localReg, remoteReg);
      // 本机已删除、对端带来的版本更低（含不带版本）：整包拒收，一行不写。分批推送里只带消息的批次同样在这里被拒——
      // 会话行在最后一批，等到那一批再拒就晚了。
      if (decision.action !== 'merge') {
        return { mergedCount: 0, orphanMarkerIds: [], hasChange: false, rejected: 'tombstoned', lifecycle: localWire };
      }
      let mergedCount = 0;
      let hasChange = false;
      let sessionCreated = false;
      if (decision.adopt && remoteReg) {
        // 采纳偶数登记要求事务结束时会话行存在（本机已有，或载荷带来）。否则会停在「偶数登记、有消息、没有会话行」：
        // 不在清单里、拉不到、也没法把偶数登记告诉别的设备。
        if (!this.rawSessionRow(sessionId) && !remote.session) {
          return { mergedCount: 0, orphanMarkerIds: [], hasChange: false, rejected: 'session-required', lifecycle: localWire };
        }
        this.writeLifecycle(sessionId, remoteReg, ctx.fromPeer);
        if (decision.restore) {
          // 本机还留着保留副本：原地解冻，随后与对端的内容按 id 并集合并
          const r = this.db.prepare('UPDATE sessions SET remote_tombstoned_at = NULL WHERE id=? AND remote_tombstoned_at IS NOT NULL').run(sessionId);
          if (r.changes > 0) sessionCreated = true;
        }
        hasChange = true;
      }
      // 载荷里每条消息、每条摘要都自带 sessionId（线格式的字段），下面落库用的就是它。守约的对端发来的恒等于外层的会话 id；
      // 不等的丢掉。上面的闸判的是外层的 id：不丢的话，对端可以借一个存活的会话，把消息与摘要写进本机已删除的另一个会话——
      // 已清除的长出没有会话行的孤儿行；保留副本被掺进新消息，之后覆盖它的墓碑再也释放不了它。
      // 不改绑到外层的 id：那会把对端标成别的会话的内容并进这一个。
      const addressed = {
        messages: remote.messages.filter(m => m.sessionId === sessionId),
        markers: remote.markers.filter(m => m.sessionId === sessionId),
      };
      const foreign = remote.messages.length - addressed.messages.length + remote.markers.length - addressed.markers.length;
      if (foreign > 0) {
        console.warn(`mergeRemoteSession: 丢弃 ${foreign} 条不属于会话 ${sessionId} 的消息或摘要（来自 ${ctx.fromPeer ?? '本机连接'}）`);
      }
      const local = { messages: this.listMessages(sessionId), markers: this.listCompactMarkers(sessionId) };
      // mergeSession 会把合并后的序号写回消息对象（本机的那些就是 local.messages 里的同一批对象），先记下库里现在的序号
      const storedOrder = new Map<string, number>();
      for (const m of local.messages) storedOrder.set(m.id, m.sortOrder);
      // Q12c：id 也来自网络，逐条校验，丢掉的当作不在载荷里（不参与排序，也不给摘要当锚点）——
      //  - 形状不合规的（isSyncId：null、数字、空串、落单代理项、超长）；
      //  - id 在本机已经属于别的会话的。这三张表的 id 都是全库的主键，以前这样的消息照样参与排序，紧跟的那条
      //    改序号的 UPDATE 只按 id 找行，改到的是别的会话里的那一行；这样的孤儿摘要经 INSERT OR REPLACE
      //    把别的会话的那一行连同它的会话一起换掉。
      // 消息只为本会话里没有的 id 查库，相同内容重推时一次都不查；摘要每条查一次（一个会话没有几条）。
      let ownerOfMessage: Database.Statement | undefined;
      let ownerOfMarker: Database.Statement | undefined;
      const own = {
        messages: addressed.messages.filter(m => {
          if (!isSyncId(m.id)) return false;
          if (storedOrder.has(m.id)) return true;
          ownerOfMessage ??= this.db.prepare('SELECT 1 FROM messages WHERE id=?');
          return ownerOfMessage.get(m.id) === undefined;
        }),
        markers: addressed.markers.filter(m => {
          if (!isSyncId(m.id)) return false;
          ownerOfMarker ??= this.db.prepare(`SELECT 1 FROM compact_markers WHERE id=? AND session_id != ?
            UNION ALL SELECT 1 FROM sync_orphan_markers WHERE id=? AND session_id != ? LIMIT 1`);
          return ownerOfMarker.get(m.id, sessionId, m.id, sessionId) === undefined;
        }),
      };
      const unusable = addressed.messages.length - own.messages.length + addressed.markers.length - own.markers.length;
      if (unusable > 0 && !this.idWarned.has(sessionId)) {
        this.idWarned.add(sessionId);
        console.warn(`mergeRemoteSession: 丢弃 ${unusable} 条 id 不合规、或 id 在本机属于别的会话的消息或摘要（会话 ${sessionId}，来自 ${ctx.fromPeer ?? '本机连接'}）；同一个会话只报这一次`);
      }
      const merged = mergeSession(local, own);
      // Q12：下面各循环用到的语句都在循环外、第一次用到时准备一次（以前每行各准备一次）
      let insertMessage: Database.Statement | undefined;
      let moveMessage: Database.Statement | undefined;
      let putOrphan: Database.Statement | undefined;
      let insertMarker: Database.Statement | undefined;
      let updateMarker: Database.Statement | undefined;
      let dropOrphan: Database.Statement | undefined;
      // 消息：INSERT OR IGNORE 新消息 + UPDATE sort_order（仅当不一致）。
      // Q12：只对本机没有的 id 执行 INSERT、只对序号变了的行执行 UPDATE。本机已有的 id 那条 INSERT 会被主键挡掉，
      // 序号没变的、刚插入的那条 UPDATE 改不到行，所以落库结果与逐条都执行相同，省掉的是每条消息一次 parts 序列化
      // 和两次语句执行。
      // Q12c：UPDATE 只对快照里有的 id（也就是本会话自己的行）执行，语句里再带上会话条件；
      // 快照里没有的 id 只尝试插入，插不进去就到此为止，不再拿它去改序号。
      for (const m of merged.messages) {
        const stored = storedOrder.get(m.id);
        if (stored === undefined) {
          insertMessage ??= this.db.prepare(`INSERT OR IGNORE INTO messages (id, session_id, role, parts_json, created_at, updated_at, token_usage, sort_order, reasoning_content, stream_interrupt_count, error_info, origin_device_id, created_locally_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
          const r = insertMessage.run(m.id, m.sessionId, m.role, serializeParts(m.parts), m.createdAt, m.updatedAt ?? m.createdAt,
            m.tokenUsage ? JSON.stringify(m.tokenUsage) : null, m.sortOrder,
            m.reasoningContent ?? null, m.streamInterruptCount, m.errorInfo ?? null,
            m.originDeviceId ?? 'legacy', m.createdLocallyAt ?? m.createdAt);
          if (r.changes > 0) { mergedCount++; hasChange = true; }
          continue;
        }
        if (stored !== m.sortOrder) {
          moveMessage ??= this.db.prepare('UPDATE messages SET sort_order=? WHERE id=? AND session_id=? AND sort_order != ?');
          moveMessage.run(m.sortOrder, m.id, sessionId, m.sortOrder);
        }
      }
      const orphanSet = new Set(merged.orphanMarkerIds);
      const resolvedIds = new Set(merged.markers.filter(m => !orphanSet.has(m.id)).map(m => m.id));
      // orphan marker → sync_orphan_markers（INSERT OR REPLACE，绝不进 compact_markers）
      // M3c Task 1 必改 6：仅新出现或内容变化才计 hasChange
      const storedOrphans = new Map(this.listOrphanMarkers(sessionId).map(o => [o.id, o]));
      for (const oid of merged.orphanMarkerIds) {
        const m = merged.markers.find(x => x.id === oid)!;
        const stored = storedOrphans.get(oid);
        // Q12b：库里已有内容相同的这一行就不写。以前每次合并都整行重写，变的只有 received_at（没有任何地方读它），
        // 相同内容重推也因此每条孤儿摘要写一行
        if (stored && stored.summary === m.summary && stored.lastCompactedMessageId === m.lastCompactedMessageId && stored.createdAt === m.createdAt) continue;
        putOrphan ??= this.db.prepare('INSERT OR REPLACE INTO sync_orphan_markers (id, session_id, summary, last_compacted_message_id, created_at, received_at) VALUES (?,?,?,?,?,?)');
        putOrphan.run(m.id, m.sessionId, m.summary, m.lastCompactedMessageId, m.createdAt, this.nowEpoch());
        if (!stored) hasChange = true;
      }
      // 非 orphan marker → compact_markers（INSERT OR IGNORE + LWW UPDATE summary/last_compacted_message_id，不改 created_at）
      // M3c Task 1 必改 6：LWW 改为值比较精化——仅 summary/lastCompactedMessageId 实际不同才 UPDATE + hasChange
      for (const m of merged.markers) {
        if (orphanSet.has(m.id)) continue;
        insertMarker ??= this.db.prepare('INSERT OR IGNORE INTO compact_markers (id, session_id, summary, last_compacted_message_id, created_at) VALUES (?,?,?,?,?)');
        const insertResult = insertMarker.run(m.id, m.sessionId, m.summary, m.lastCompactedMessageId, m.createdAt);
        if (insertResult.changes > 0) { hasChange = true; continue; }
        const existing = local.markers.find(x => x.id === m.id);
        if (existing && (m.summary !== existing.summary || m.lastCompactedMessageId !== existing.lastCompactedMessageId)) {
          updateMarker ??= this.db.prepare('UPDATE compact_markers SET summary=?, last_compacted_message_id=? WHERE id=?');
          updateMarker.run(m.summary, m.lastCompactedMessageId, m.id);
          hasChange = true;
        }
      }
      // 脱孤：之前在 sync_orphan_markers、本次已 resolve 成功的 marker → 删 sync_orphan_markers
      const existingOrphans = this.listOrphanMarkers(sessionId);
      for (const om of existingOrphans) {
        if (resolvedIds.has(om.id)) {
          dropOrphan ??= this.db.prepare('DELETE FROM sync_orphan_markers WHERE id=?');
          dropOrphan.run(om.id);
          hasChange = true; // 脱孤是状态变化
        }
      }
      // session 元数据 LWW on updatedAt；session 不存在时 INSERT（首次同步创建）
      // M3c Task 1 必改 6：仅值有差异才 UPDATE + hasChange；无 remote.session 时 updated_at 兜底不计入 hasChange
      if (remote.session) {
        const ws = remote.session;
        const localSession = this.getSession(sessionId);
        if (!localSession) {
          this.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at, memory_enabled, model_binding, pinned_at) VALUES (?,?,?,?,?,?,?)')
            .run(sessionId, ws.title, ws.createdAt, ws.updatedAt, ws.memoryEnabled ? 1 : 0, ws.modelBinding ?? null, ws.pinnedAt ?? null);
          hasChange = true;
          sessionCreated = true;
        } else if (ws.updatedAt > localSession.updatedAt) {
          // 值比较精化：仅 title/memoryEnabled/modelBinding/pinnedAt 有差异才 UPDATE
          if (ws.title !== localSession.title || !!ws.memoryEnabled !== !!localSession.memoryEnabled ||
              (ws.modelBinding ?? null) !== (localSession.modelBinding ?? null) ||
              (ws.pinnedAt ?? null) !== (localSession.pinnedAt ?? null)) {
            this.db.prepare('UPDATE sessions SET title=?, updated_at=?, memory_enabled=?, model_binding=?, pinned_at=? WHERE id=?')
              .run(ws.title, ws.updatedAt, ws.memoryEnabled, ws.modelBinding ?? null, ws.pinnedAt ?? null, sessionId);
            hasChange = true;
          }
        }
      } else if (mergedCount > 0) {
        // Q12b：这一批确实带来了新消息才刷新。以前无条件刷新：分批推送里除最后一批外都不带会话行，
        // 相同内容每重推一轮，大会话的 updated_at 就被改成本机当前时间一次——列表里它总排在最前，
        // 而且本机的 updated_at 因此总比对端的新，随后那一批带来的会话行（改名等）过不了上面的比较
        this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(this.nowEpoch(), sessionId);
      }
      const out: MergeRemoteResult = { mergedCount, orphanMarkerIds: merged.orphanMarkerIds, hasChange };
      if (sessionCreated) out.sessionCreated = true;
      if (decision.adopt && decision.restore) out.restored = true;
      const after = this.wireLifecycle(sessionId);
      if (after) out.lifecycle = after;
      return out;
    });
    const result = tx();
    if (result.hasChange) this.onDirty?.(sessionId);
    // 被拒的内容不 onDirty（不引起往返）；只把「有人拿着旧副本来过」交给钩子记一笔
    if (result.rejected === 'tombstoned' && result.lifecycle) {
      this.emitLifecycle({ kind: 'stale-content-rejected', sessionId, lifecycle: result.lifecycle, fromPeer: ctx.fromPeer });
    } else if (result.restored && result.lifecycle) {
      this.emitLifecycle({ kind: 'restore-applied', sessionId, lifecycle: result.lifecycle, fromPeer: ctx.fromPeer });
    }
    return result;
  }
}
