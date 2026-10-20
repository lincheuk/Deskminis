/**
 * F08：检查点存储——元信息在 minis.db（file_checkpoints / checkpoint_blobs），内容按 sha256 存在 <数据根>/checkpoints/blobs/ 下。
 *
 * 不变量：
 *  - 目标文件被改动之前，覆盖这次改动的记录已以 pending 持久提交，它引用的内容文件已 fsync 落盘，
 *    并且在提交前一刻确认过它在盘上、大小相符（不凭登记表推断）。
 *  - applied 只在替换完成之后写。任何时刻记录与文件不一致，都能由「当前内容对 before_hash / after_hash」重新判定；
 *    判不出来就是 unknown。
 *  - 清理从不动受保护的记录，也不删仍被任何记录引用的内容。清理的单位是记录（置 pruned_at、清空两个引用），
 *    内容在没有任何引用之后才删。
 *  - 这里不执行任何外部命令；对用户目录只做两件事：对账时读文件算哈希、删库里记着的那一个临时文件。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  CHECKPOINT_MAX_FILE_BYTES, CHECKPOINT_QUOTA_DEFAULT_BYTES, CHECKPOINT_QUOTA_KEY, CHECKPOINT_QUOTA_MAX_BYTES, CHECKPOINT_QUOTA_MIN_BYTES,
  CHECKPOINT_RETENTION_DAYS, CHECKPOINT_SINCE_EPOCH_KEY, CHECKPOINTED_TOOLS, CHECKPOINT_LIST_MAX_ROWS,
  type CheckpointState, type CheckpointUsage, type FileChangeView,
} from '../../shared/checkpoint';
import { pathKeyOf, realPathOf, type DataGateOptions } from '../tools/data-gate';
import type { CheckpointPrepare, FileCheckpointer, FileId, PreparedCheckpoint } from '../tools/types';
import { CheckpointError } from './commit';
import { errCode, fileIdOf, nodeFileIo, removeQuiet, sha256Hex, TMP_NAME_RE, type FileIo } from './fs';

export interface CheckpointStoreOptions {
  /** 记录的提交。生产传 fn => runLedger.durableAtomic(fn)（关停即拒、校验租约、FULL 同步）。不传就用一个立即事务（单测）。 */
  commit?: <T>(fn: () => T) => T;
  /** 其余写入（applied、清理、对账）。生产传 fn => runLedger.atomic(fn)。 */
  tx?: <T>(fn: () => T) => T;
  /** 缺省读 settings，取不到或非法用缺省值，越界夹到范围内。 */
  quotaBytes?: () => number;
  io?: FileIo; path?: DataGateOptions;
  /** 测试注入。 */
  maxFileBytes?: number; retentionDays?: number;
  now?: () => number; newId?: () => string;
  /** index.ts 接到 rpc.broadcast('checkpoints.changed', …)。抛错被吞。 */
  onChange?(sessionId: string): void;
  warn?(msg: string, e?: unknown): void;
}

export interface CheckpointRow extends Omit<FileChangeView, 'displayPath'> {
  requestedPath: string; beforeBlob?: string; afterBlob?: string; beforeMode?: number;
  fileId?: FileId; restoredFileId?: FileId; tmpPath?: string; restoringAt?: number; restoreTmpPath?: string;
}

interface DbRow {
  seq: number; id: string; session_id: string; run_id: string | null; execution_id: string | null; tool_use_id: string | null;
  tool_name: string; ordinal: number; requested_path: string; path: string; path_key: string; state: string;
  before_exists: number; before_hash: string | null; before_size: number | null; before_mode: number | null; before_blob: string | null;
  after_hash: string; after_size: number; after_blob: string | null;
  file_dev: string | null; file_ino: string | null; restored_dev: string | null; restored_ino: string | null;
  tmp_path: string | null; restoring_at: number | null; restore_tmp_path: string | null;
  abort_reason: string | null; detail: string | null;
  created_at: number; applied_at: number | null; restored_at: number | null; pruned_at: number | null; updated_at: number;
}

function toRow(r: DbRow): CheckpointRow {
  const v: CheckpointRow = {
    id: r.id, seq: r.seq, sessionId: r.session_id, toolName: r.tool_name, ordinal: r.ordinal,
    path: r.path, requestedPath: r.requested_path, pathKey: r.path_key,
    kind: r.before_exists === 1 ? 'modify' : 'create', state: r.state as CheckpointState,
    before: r.before_exists === 1 ? { exists: true, hash: r.before_hash ?? undefined, size: r.before_size ?? undefined } : { exists: false },
    after: { exists: true, hash: r.after_hash, size: r.after_size },
    beforeStored: r.before_blob !== null, afterStored: r.after_blob !== null,
    createdAt: r.created_at,
  };
  if (r.run_id !== null) v.runId = r.run_id;
  if (r.execution_id !== null) v.executionId = r.execution_id;
  if (r.tool_use_id !== null) v.toolUseId = r.tool_use_id;
  if (r.applied_at !== null) v.appliedAt = r.applied_at;
  if (r.restored_at !== null) v.restoredAt = r.restored_at;
  if (r.pruned_at !== null) v.prunedAt = r.pruned_at;
  if (r.abort_reason !== null) v.abortReason = r.abort_reason;
  if (r.detail !== null) v.detail = r.detail;
  if (r.before_blob !== null) v.beforeBlob = r.before_blob;
  if (r.after_blob !== null) v.afterBlob = r.after_blob;
  if (r.before_mode !== null) v.beforeMode = r.before_mode;
  if (r.file_dev !== null && r.file_ino !== null) v.fileId = { dev: r.file_dev, ino: r.file_ino };
  if (r.restored_dev !== null && r.restored_ino !== null) v.restoredFileId = { dev: r.restored_dev, ino: r.restored_ino };
  if (r.tmp_path !== null) v.tmpPath = r.tmp_path;
  if (r.restoring_at !== null) v.restoringAt = r.restoring_at;
  if (r.restore_tmp_path !== null) v.restoreTmpPath = r.restore_tmp_path;
  return v;
}

/** 受保护、自动清理不碰的记录（c 是 file_checkpoints 的别名）：还没落定的、恢复中的、所属 run 仍在活动的（用户还没机会审阅）。 */
const PROTECTED = `(c.state = 'pending' OR c.restoring_at IS NOT NULL
  OR (c.run_id IS NOT NULL AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.id = c.run_id AND r.active = 1)))`;

/** 按保留期清理的节流：每小时最多一次（启动时一次；之后由 prepare、list、usage 顺带触发）。 */
const RETENTION_SWEEP_INTERVAL_S = 3600;

const EVIDENCE_NONE = '这次调用没有留下写入记录，目标文件没有被它改动。';

export class CheckpointStore implements FileCheckpointer {
  /** 文件操作。写入事务（commit.ts）经 FileCheckpointer.io 用同一个：测试注入一处，两边都生效。 */
  readonly io: FileIo;
  private readonly blobsDir: string;
  private readonly tmpDir: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly warn: (msg: string, e?: unknown) => void;
  private readonly commit: <T>(fn: () => T) => T;
  private readonly tx: <T>(fn: () => T) => T;
  private readonly maxFileBytes: number;
  private readonly retentionDays: number;
  private available = false;
  private lastRetentionAt: number | undefined;

  /** dir = <数据根>/checkpoints。目录建不出来不抛：标记不可用，之后 prepare 抛 CheckpointError('unavailable')。 */
  constructor(private readonly db: Database.Database, dir: string, private readonly opts: CheckpointStoreOptions = {}) {
    this.io = opts.io ?? nodeFileIo;
    this.blobsDir = join(dir, 'blobs');
    this.tmpDir = join(dir, 'tmp');
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.newId = opts.newId ?? (() => randomUUID().toUpperCase());
    this.warn = opts.warn ?? ((msg, e) => { console.warn(msg, e); });
    const plain = <T>(fn: () => T): T => (db.inTransaction ? fn() : db.transaction(fn).immediate());
    this.commit = opts.commit ?? plain;
    this.tx = opts.tx ?? plain;
    this.maxFileBytes = opts.maxFileBytes ?? CHECKPOINT_MAX_FILE_BYTES;
    this.retentionDays = opts.retentionDays ?? CHECKPOINT_RETENTION_DAYS;
    try {
      this.io.mkdirp(this.blobsDir);
      this.io.mkdirp(this.tmpDir);
      this.available = true;
    } catch (e) {
      this.warn('文件检查点：存储目录建不出来，之后的文件写入会被拒绝并说明原因:', e);
    }
  }

  get pathOptions(): DataGateOptions | undefined { return this.opts.path; }

  // ---------- 内容文件 ----------

  private blobPath(hash: string): string { return join(this.blobsDir, hash.slice(0, 2), hash); }
  private registered(hash: string): boolean {
    return this.db.prepare('SELECT 1 FROM checkpoint_blobs WHERE hash=?').get(hash) !== undefined;
  }
  private blobOnDisk(hash: string, size: number): boolean {
    try {
      const st = this.io.lstat(this.blobPath(hash));
      return st !== undefined && st.kind === 'file' && Number(st.sig.size) === size;
    } catch { return false; }
  }
  private usedBytes(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM checkpoint_blobs').get() as { n: number }).n;
  }

  /**
   * 确保这份内容在盘上。复用的判据是「登记行在，且盘上的内容文件大小相符」，不是「登记过」：
   * 检查点目录里的文件被用户或清理软件删掉后登记行还在，只凭登记表复用，就会带着一个空检查点去覆盖。
   * 其余情形（没登记；登记了但文件不在或大小不符；文件在但没登记——可能是上次崩溃留下的残缺文件）一律用手里的字节重写。
   * 返回前再确认一次文件在盘上、大小相符。失败抛 CheckpointError('io')。
   */
  private ensureBlob(hash: string, bytes: Buffer): void {
    const final = this.blobPath(hash);
    if (!(this.registered(hash) && this.blobOnDisk(hash, bytes.length))) {
      const tmp = join(this.tmpDir, randomBytes(8).toString('hex'));
      try {
        this.io.mkdirp(dirname(final));
        this.io.writeDurable(tmp, bytes);
        this.io.rename(tmp, final);
      } catch (e) {
        removeQuiet(this.io, tmp);
        throw new CheckpointError('io', `检查点内容写入失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!this.blobOnDisk(hash, bytes.length)) throw new CheckpointError('io', '检查点内容文件不在盘上或大小不符');
  }

  /** 读出后校验 sha256。文件不在 → CheckpointError('io', blob:'missing')；校验不符 → blob:'corrupt'。 */
  readBlob(hash: string): Buffer {
    let bytes: Buffer;
    try { bytes = this.io.readStable(this.blobPath(hash)).bytes; }
    catch (e) {
      throw new CheckpointError('io', `检查点内容读取失败：${e instanceof Error ? e.message : String(e)}`, { blob: errCode(e) === 'ENOENT' ? 'missing' : undefined });
    }
    if (sha256Hex(bytes) !== hash) throw new CheckpointError('io', '检查点内容校验不一致', { blob: 'corrupt' });
    return bytes;
  }

  /** 登记行存在，且内容文件在盘上、是普通文件、大小与登记的相符（与 prepare 复用内容的判据是同一个）。 */
  hasBlob(hash: string): boolean {
    try {
      const r = this.db.prepare('SELECT size FROM checkpoint_blobs WHERE hash=?').get(hash) as { size: number } | undefined;
      return r !== undefined && this.blobOnDisk(hash, r.size);
    } catch { return false; }
  }

  // ---------- 写入事务用 ----------

  prepare(p: CheckpointPrepare): PreparedCheckpoint {
    if (!this.available) throw new CheckpointError('unavailable', '检查点存储不可用（目录建不出来）');
    const before = p.before;
    if (before && before.bytes.length > this.maxFileBytes) {
      throw new CheckpointError('too-large', '写入前的文件超过单文件上限', { limitBytes: this.maxFileBytes, sizeBytes: before.bytes.length });
    }
    if (before) {
      // 先清理、后判定要不要落盘。本次要引用的哈希不参与这次清理里的内容回收：它唯一的引用可能正好在这次清理里被清掉，
      // 沿用清理之前的「已登记」结论就会提交出一条内容不存在的记录
      const need0 = this.registered(before.hash) ? 0 : before.bytes.length;
      this.prune(need0, before.hash);
      const need = this.registered(before.hash) ? 0 : before.bytes.length;
      const quota = this.quota();
      if (this.usedBytes() + need > quota) throw new CheckpointError('quota', '文件检查点的空间已用满', { limitBytes: quota });
      this.ensureBlob(before.hash, before.bytes);
    } else {
      // 新建文件不需要内容空间；保留期清理照常顺带做
      this.prune(0);
    }
    const id = this.newId();
    const at = this.now();
    try {
      this.commit(() => {
        if (before) this.db.prepare('INSERT OR IGNORE INTO checkpoint_blobs (hash, size, created_at) VALUES (?,?,?)').run(before.hash, before.bytes.length, at);
        const ordinal = p.call?.executionId === undefined ? 0
          : (this.db.prepare('SELECT COUNT(*) AS n FROM file_checkpoints WHERE execution_id=?').get(p.call.executionId) as { n: number }).n;
        this.db.prepare(`INSERT INTO file_checkpoints
          (id, session_id, run_id, execution_id, tool_use_id, tool_name, ordinal, requested_path, path, path_key, state,
           before_exists, before_hash, before_size, before_mode, before_blob, after_hash, after_size, tmp_path, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?)`).run(
          id, p.sessionId, p.call?.runId ?? null, p.call?.executionId ?? null, p.call?.toolUseId ?? null, p.call?.name ?? '', ordinal,
          p.requestedPath, p.path, p.pathKey,
          before ? 1 : 0, before?.hash ?? null, before?.bytes.length ?? null, before?.mode ?? null, before?.hash ?? null,
          p.afterHash, p.afterSize, p.tmpPath, at, at,
        );
      });
    } catch (e) {
      // 已写的内容文件留给 gc
      throw new CheckpointError('db', `检查点记录提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const sessionId = p.sessionId;
    const tmpPath = p.tmpPath;
    return {
      id,
      applied: a => {
        this.tx(() => {
          this.db.prepare(`UPDATE file_checkpoints SET state='applied', path=?, file_dev=?, file_ino=?, applied_at=?, detail=COALESCE(?, detail), updated_at=? WHERE id=? AND state='pending'`)
            .run(a.path, a.fileId?.dev ?? null, a.fileId?.ino ?? null, this.now(), a.inPlace ? 'in-place' : null, this.now(), id);
          this.clearTmpIfGone(id, 'tmp_path', tmpPath);
        });
        this.changed(sessionId);
      },
      aborted: (reason, detail) => {
        // 没有替换：立刻放掉内容引用，保留元信息备查
        this.tx(() => {
          this.db.prepare(`UPDATE file_checkpoints SET state='aborted', abort_reason=?, detail=?, before_blob=NULL, updated_at=? WHERE id=? AND state='pending'`)
            .run(reason, detail ?? null, this.now(), id);
          this.clearTmpIfGone(id, 'tmp_path', tmpPath);
        });
      },
      uncertain: detail => {
        this.tx(() => {
          this.db.prepare(`UPDATE file_checkpoints SET state='unknown', detail=?, updated_at=? WHERE id=? AND state='pending'`).run(detail, this.now(), id);
          this.clearTmpIfGone(id, 'tmp_path', tmpPath);
        });
        this.changed(sessionId);
      },
    };
  }

  /** 记录在案的临时文件只在确认它已经不在时才清空该列；还在就留着，由对账重试删除。 */
  private clearTmpIfGone(id: string, col: 'tmp_path' | 'restore_tmp_path', path: string | undefined): void {
    if (path === undefined) return;
    let gone = false;
    try { gone = this.io.lstat(path) === undefined; } catch { gone = false; }
    if (gone) this.db.prepare(`UPDATE file_checkpoints SET ${col}=NULL WHERE id=? AND ${col}=?`).run(id, path);
  }

  /** 重试删除一行上记录在案的临时文件：路径就是库里记的那一条、文件名匹配 TMP_NAME_RE、是普通文件才删；确认不在了再清空该列。 */
  private cleanTemps(r: Pick<DbRow, 'id' | 'tmp_path' | 'restore_tmp_path'>): void {
    for (const col of ['tmp_path', 'restore_tmp_path'] as const) {
      const p = r[col];
      if (p === null) continue;
      try {
        if (TMP_NAME_RE.test(basename(p))) {
          const st = this.io.lstat(p);
          if (st !== undefined && st.kind === 'file') removeQuiet(this.io, p);
        }
        this.tx(() => this.clearTmpIfGone(r.id, col, p));
      } catch (e) {
        this.warn('文件检查点：残留临时文件清理失败（下次再试）:', e);
      }
    }
    // 会话已清除、只为记住残留临时文件而留下的占位行（ChatStore.purgeSessionRows：本机删除、对端墓碑、彻底删除保留副本
    // 都经它）：临时文件确认都不在了，这一行也就没用了
    try {
      this.tx(() => {
        this.db.prepare(`DELETE FROM file_checkpoints WHERE id=? AND abort_reason='session-deleted' AND tmp_path IS NULL AND restore_tmp_path IS NULL`).run(r.id);
      });
    } catch (e) {
      this.warn('文件检查点：已删会话的占位记录清理失败（下次再试）:', e);
    }
  }

  releaseTemps(pathKey: string): void {
    try {
      const rows = this.db.prepare('SELECT id, tmp_path, restore_tmp_path FROM file_checkpoints WHERE path_key=? AND (tmp_path IS NOT NULL OR restore_tmp_path IS NOT NULL)')
        .all(pathKey) as Pick<DbRow, 'id' | 'tmp_path' | 'restore_tmp_path'>[];
      for (const r of rows) this.cleanTemps(r);
    } catch (e) {
      this.warn('文件检查点：残留临时文件清理失败（下次再试）:', e);
    }
  }

  private changed(sessionId: string): void {
    try { this.opts.onChange?.(sessionId); } catch (e) { this.warn('文件检查点：变更通知失败:', e); }
  }

  // ---------- 读 ----------

  get(id: string): CheckpointRow | undefined {
    const r = this.db.prepare('SELECT * FROM file_checkpoints WHERE id=?').get(id) as DbRow | undefined;
    return r ? toRow(r) : undefined;
  }

  /** 这个会话进变化清单的记录（aborted 的不进），seq 降序。 */
  listSession(sessionId: string, limit: number = CHECKPOINT_LIST_MAX_ROWS): CheckpointRow[] {
    return (this.db.prepare(`SELECT * FROM file_checkpoints WHERE session_id=? AND state IN ('applied','restored','unknown','pending') ORDER BY seq DESC LIMIT ?`)
      .all(sessionId, limit) as DbRow[]).map(toRow);
  }

  /** 同一路径身份上 seq 更大的记录（任何会话），seq 升序。 */
  laterOnPath(pathKey: string, seq: number): CheckpointRow[] {
    return (this.db.prepare('SELECT * FROM file_checkpoints WHERE path_key=? AND seq>? ORDER BY seq').all(pathKey, seq) as DbRow[]).map(toRow);
  }

  /**
   * 这个会话里「不该再按工具入参列成改动」的写调用：已有检查点记录的，加上由带检查点的引擎执行过的全部文件写入调用
   * （读执行账本；早于检查点启用代次的不算——那时是原地写入，没有记录不代表没有改动）。
   * 后一类里没有记录的，要么写入的内容与原文件相同（没有改动），要么没写成：都不是「没有检查点的改动」。
   * 不受变化清单的条数上限限制：清单被截断时，更早的有检查点的改动也不该掉进「没有检查点」那一节。从不抛。
   */
  coveredToolUseIds(sessionId: string): string[] {
    const ids = new Set<string>();
    try {
      for (const r of this.db.prepare('SELECT DISTINCT tool_use_id FROM file_checkpoints WHERE session_id=? AND tool_use_id IS NOT NULL').all(sessionId) as { tool_use_id: string }[]) ids.add(r.tool_use_id);
      const s = this.db.prepare('SELECT value FROM settings WHERE key=?').get(CHECKPOINT_SINCE_EPOCH_KEY) as { value: string } | undefined;
      const since = s === undefined ? NaN : Number(s.value);
      if (Number.isInteger(since)) {
        const names = CHECKPOINTED_TOOLS.map(() => '?').join(',');
        for (const r of this.db.prepare(`SELECT DISTINCT tool_use_id FROM tool_executions WHERE session_id=? AND epoch>=? AND tool_name IN (${names})`)
          .all(sessionId, since, ...CHECKPOINTED_TOOLS) as { tool_use_id: string }[]) ids.add(r.tool_use_id);
      }
    } catch (e) {
      this.warn('文件检查点：读取已覆盖的写调用失败（只按已取到的部分去重）:', e);
    }
    return [...ids];
  }

  // ---------- 恢复用 ----------

  /** 存当前字节并标「恢复中」，持久提交。存内容与 prepare 走同一段落盘逻辑（登记行在且文件大小相符才复用，否则重写），
   *  只是不比配额、不触发清理：恢复本身不该因为空间满而丢东西。 */
  beginRestore(id: string, a: { afterBytes: Buffer; tmpPath?: string }): void {
    if (!this.available) throw new CheckpointError('unavailable', '检查点存储不可用（目录建不出来）');
    const hash = sha256Hex(a.afterBytes);
    this.ensureBlob(hash, a.afterBytes);
    const at = this.now();
    try {
      this.commit(() => {
        this.db.prepare('INSERT OR IGNORE INTO checkpoint_blobs (hash, size, created_at) VALUES (?,?,?)').run(hash, a.afterBytes.length, at);
        const r = this.db.prepare(`UPDATE file_checkpoints SET after_blob=?, restoring_at=?, restore_tmp_path=?, updated_at=?
          WHERE id=? AND state='applied' AND restoring_at IS NULL AND after_hash=?`).run(hash, at, a.tmpPath ?? null, at, id, hash);
        if (r.changes !== 1) throw new Error('记录已不在可恢复的状态');
      });
    } catch (e) {
      if (e instanceof CheckpointError) throw e;
      throw new CheckpointError('db', `恢复记录提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 没有恢复（目标确认未被本次恢复改动）：清掉「恢复中」。存下的写入后内容留着（文件此刻可能已被别人改掉，它是那个版本唯一的副本）。 */
  cancelRestore(id: string): void {
    this.tx(() => {
      const r = this.db.prepare('SELECT restore_tmp_path FROM file_checkpoints WHERE id=?').get(id) as { restore_tmp_path: string | null } | undefined;
      this.db.prepare('UPDATE file_checkpoints SET restoring_at=NULL, updated_at=? WHERE id=? AND restoring_at IS NOT NULL').run(this.now(), id);
      this.clearTmpIfGone(id, 'restore_tmp_path', r?.restore_tmp_path ?? undefined);
    });
  }

  /** path：恢复那一刻的真实路径（写进行的 path 列：用户可能改过文件名的大小写）。 */
  finishRestore(id: string, a: { path: string; fileId?: FileId }): void {
    let sessionId: string | undefined;
    this.tx(() => {
      const r = this.db.prepare('SELECT session_id, restore_tmp_path FROM file_checkpoints WHERE id=?').get(id) as { session_id: string; restore_tmp_path: string | null } | undefined;
      sessionId = r?.session_id;
      this.db.prepare(`UPDATE file_checkpoints SET state='restored', restored_at=?, restoring_at=NULL, path=?, restored_dev=?, restored_ino=?, updated_at=?
        WHERE id=? AND state='applied'`).run(this.now(), a.path, a.fileId?.dev ?? null, a.fileId?.ino ?? null, this.now(), id);
      this.clearTmpIfGone(id, 'restore_tmp_path', r?.restore_tmp_path ?? undefined);
    });
    if (sessionId !== undefined) this.changed(sessionId);
  }

  markUnknown(id: string, detail: string): void {
    let sessionId: string | undefined;
    this.tx(() => {
      const r = this.db.prepare('SELECT session_id, tmp_path, restore_tmp_path FROM file_checkpoints WHERE id=?').get(id) as
        { session_id: string; tmp_path: string | null; restore_tmp_path: string | null } | undefined;
      sessionId = r?.session_id;
      this.db.prepare(`UPDATE file_checkpoints SET state='unknown', restoring_at=NULL, detail=?, updated_at=? WHERE id=?`).run(detail, this.now(), id);
      this.clearTmpIfGone(id, 'tmp_path', r?.tmp_path ?? undefined);
      this.clearTmpIfGone(id, 'restore_tmp_path', r?.restore_tmp_path ?? undefined);
    });
    if (sessionId !== undefined) this.changed(sessionId);
  }

  // ---------- 对账 ----------

  /** 实际文件此刻是什么：'missing'；{ hash, fileId }（普通文件）；'other'（不是文件、读不了、大小与两头都对不上时不必读内容）。 */
  private observe(path: string, sizes: readonly (number | null)[]): 'missing' | 'other' | { hash: string; fileId?: FileId } {
    try {
      const cur = realPathOf(path, this.opts.path);
      const st = this.io.lstat(cur);
      if (st === undefined) return 'missing';
      if (st.kind !== 'file') return 'other';
      if (!sizes.includes(Number(st.sig.size))) return 'other';
      const read = this.io.readStable(cur);
      return { hash: sha256Hex(read.bytes), fileId: fileIdOf(read.sig) };
    } catch { return 'other'; }
  }

  /**
   * 库里的旁证：同一路径身份上紧随其后的那条记录，在它动手之前看到的文件是这一行的哪一头。
   * 写入事务是同步的，同一路径的写入由资源锁串行，后一条记录的「写入前」就是这一行的操作做完之后文件的样子——
   * 它比「文件现在的内容」离这次操作更近：同进程里 applied / finishRestore 的写库失败后同一文件又被写了一次，
   * 文件现在是后一次写入的内容，与这一行的两头都对不上，而这一行其实完整生效过。
   * createdAfter（「恢复中」的行用）：只认恢复开始之后建的记录——seq 更大的记录可以在这次恢复之前就有（已恢复的后续改动），
   * 它们说明不了这次恢复的结果。
   * 返回 undefined = 没有这样的记录，或它看到的两头都不是（中间被别的程序改过）：仍按文件现在的内容判。
   */
  private successorSaw(r: DbRow, createdAfter?: number): 'after' | 'before' | undefined {
    const s = (createdAfter === undefined
      ? this.db.prepare('SELECT before_exists, before_hash FROM file_checkpoints WHERE path_key=? AND seq>? ORDER BY seq LIMIT 1').get(r.path_key, r.seq)
      : this.db.prepare('SELECT before_exists, before_hash FROM file_checkpoints WHERE path_key=? AND seq>? AND created_at>? ORDER BY seq LIMIT 1').get(r.path_key, r.seq, createdAfter)
    ) as Pick<DbRow, 'before_exists' | 'before_hash'> | undefined;
    if (!s) return undefined;
    if (s.before_exists === 1 && s.before_hash === r.after_hash) return 'after';
    if (r.before_exists === 1 ? (s.before_exists === 1 && s.before_hash === r.before_hash) : s.before_exists === 0) return 'before';
    return undefined;
  }

  /**
   * 把 pending 与「恢复中」的行按实际文件落到终态；对所有 tmp_path / restore_tmp_path 非空的行（不限状态）重试删除临时文件。
   * 只动检查点自己的行与库里记着的临时文件，从不改目标文件。从不抛；返回落定的行。每行各自兜住，失败的行原样留着，下次再对。
   * 写入事务与恢复都是同步的：这里看到的 pending / 「恢复中」一定是陈旧的，不是「正在进行」。
   * 判定的依据：同一路径上后一条记录看到的写入前状态（有的话，见 successorSaw），其次才是文件现在的内容；都判不出来就是 unknown。
   */
  reconcile(f: { sessionId?: string; id?: string } = {}): CheckpointRow[] {
    const settled: CheckpointRow[] = [];
    const where = f.id !== undefined ? ' AND id=?' : f.sessionId !== undefined ? ' AND session_id=?' : '';
    const args = f.id !== undefined ? [f.id] : f.sessionId !== undefined ? [f.sessionId] : [];
    let open: DbRow[] = [];
    let temps: Pick<DbRow, 'id' | 'tmp_path' | 'restore_tmp_path'>[] = [];
    try {
      open = this.db.prepare(`SELECT * FROM file_checkpoints WHERE (state='pending' OR restoring_at IS NOT NULL)${where} ORDER BY seq`).all(...args) as DbRow[];
    } catch (e) { this.warn('文件检查点：对账时列出未落定的记录失败:', e); }
    for (const r of open) {
      try {
        const at = this.now();
        const seen = this.observe(r.path, [r.before_size, r.after_size]);
        const nowAfter = typeof seen === 'object' && seen.hash === r.after_hash;
        const nowBefore = r.before_exists === 1 ? (typeof seen === 'object' && seen.hash === r.before_hash) : seen === 'missing';
        // 后一条记录的旁证优先；没有（或它也说不清）才按文件现在的内容判
        const saw = this.successorSaw(r, r.state === 'pending' ? undefined : r.restoring_at ?? undefined);
        const isAfter = saw !== undefined ? saw === 'after' : nowAfter;
        const isBefore = saw !== undefined ? saw === 'before' : nowBefore;
        // 文件 ID 只在「文件现在就是那一头」时才是它的；凭旁证落定的留空，恢复时跳过文件 ID 比对
        const fid = typeof seen === 'object' && (isAfter ? nowAfter : nowBefore) ? seen.fileId : undefined;
        const how = saw !== undefined ? 'reconciled-by-successor' : 'reconciled';
        const what = seen === 'missing' ? '文件不存在' : seen === 'other' ? '不是普通文件、读不了，或大小与两头都对不上' : '内容与两头都对不上';
        this.tx(() => {
          if (r.state === 'pending') {
            if (isAfter) {
              this.db.prepare(`UPDATE file_checkpoints SET state='applied', file_dev=?, file_ino=?, applied_at=?, detail=?, updated_at=? WHERE id=? AND state='pending'`)
                .run(fid?.dev ?? null, fid?.ino ?? null, at, how, at, r.id);
            } else if (isBefore) {
              this.db.prepare(`UPDATE file_checkpoints SET state='aborted', abort_reason='interrupted', before_blob=NULL, updated_at=? WHERE id=? AND state='pending'`).run(at, r.id);
            } else {
              this.db.prepare(`UPDATE file_checkpoints SET state='unknown', detail=?, updated_at=? WHERE id=? AND state='pending'`).run(`对账：${what}`, at, r.id);
            }
          } else if (isBefore) {
            this.db.prepare(`UPDATE file_checkpoints SET state='restored', restored_at=?, restoring_at=NULL, restored_dev=?, restored_ino=?, updated_at=? WHERE id=? AND restoring_at IS NOT NULL`)
              .run(at, fid?.dev ?? null, fid?.ino ?? null, at, r.id);
          } else if (isAfter) {
            this.db.prepare('UPDATE file_checkpoints SET restoring_at=NULL, updated_at=? WHERE id=? AND restoring_at IS NOT NULL').run(at, r.id);
          } else {
            this.db.prepare(`UPDATE file_checkpoints SET state='unknown', restoring_at=NULL, detail=?, updated_at=? WHERE id=? AND restoring_at IS NOT NULL`).run(`对账（恢复被打断）：${what}`, at, r.id);
          }
        });
        const row = this.get(r.id);
        if (row) settled.push(row);
      } catch (e) {
        this.warn(`文件检查点：对账记录 ${r.id} 失败（下次再对）:`, e);
      }
    }
    try {
      temps = this.db.prepare(`SELECT id, tmp_path, restore_tmp_path FROM file_checkpoints WHERE (tmp_path IS NOT NULL OR restore_tmp_path IS NOT NULL)${where}`)
        .all(...args) as Pick<DbRow, 'id' | 'tmp_path' | 'restore_tmp_path'>[];
    } catch (e) { this.warn('文件检查点：对账时列出残留临时文件失败:', e); }
    for (const r of temps) this.cleanTemps(r);
    for (const sid of new Set(settled.map(r => r.sessionId))) this.changed(sid);
    return settled;
  }

  /** 第一次带检查点启动时把当前引擎代次写进 settings；已有值就不动。从不抛（写不进只告警，下次启动再写）。 */
  markSinceEpoch(epoch: number): void {
    try {
      this.tx(() => {
        this.db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?,?,?)').run(CHECKPOINT_SINCE_EPOCH_KEY, String(epoch), this.now());
      });
    } catch (e) {
      this.warn('文件检查点：启用代次写入失败（这次启动不给崩溃恢复补充文件事实，下次启动再写）:', e);
    }
  }

  /**
   * 运行恢复用：这次执行的每个检查点一句事实。只读库，不对账，不做文件 IO。从不抛。
   * 它在两条路上被调：启动恢复（之前刚对过账）与 run 收尾（之前没有对账），所以每句话只说库里那一刻确实知道的事。
   * 返回 undefined（恢复文案逐字不变）：工具不在 CHECKPOINTED_TOOLS；或启用代次取不到；或这条执行早于启用代次
   * （那次执行是不带检查点的引擎做的，它是原地写入，没有记录不代表没有改动）。
   */
  effectEvidence(row: { id: string; name: string; epoch: number }): string[] | undefined {
    try {
      if (!(CHECKPOINTED_TOOLS as readonly string[]).includes(row.name)) return undefined;
      const s = this.db.prepare('SELECT value FROM settings WHERE key=?').get(CHECKPOINT_SINCE_EPOCH_KEY) as { value: string } | undefined;
      const since = s === undefined ? NaN : Number(s.value);
      if (!Number.isInteger(since) || row.epoch < since) return undefined;
      const rows = this.db.prepare('SELECT path, state, restoring_at FROM file_checkpoints WHERE execution_id=? ORDER BY seq').all(row.id) as
        Pick<DbRow, 'path' | 'state' | 'restoring_at'>[];
      if (rows.length === 0) return [EVIDENCE_NONE];
      return rows.map(r => {
        if (r.state === 'pending' || r.restoring_at !== null) return `${r.path}：还没有核实（写入前的版本已保存，可在「改动」里查看）`;
        if (r.state === 'applied') return `${r.path}：这次写入已完成（文件内容与这次写入一致，可在「改动」里查看或恢复）`;
        if (r.state === 'aborted') return `${r.path}：这次写入没有发生（文件仍是写入前的内容）`;
        if (r.state === 'restored') return `${r.path}：这次写入已完成，之后已恢复到写入前的内容`;
        return `${r.path}：无法确认（文件既不是写入前的内容，也不是这次要写入的内容；写入前的版本已保存，可在「改动」里另存）`;
      });
    } catch (e) {
      this.warn('文件检查点：读取恢复用的文件事实失败（恢复文案退回原样）:', e);
      return undefined;
    }
  }

  // ---------- 容量 ----------

  private quota(): number {
    let n: number;
    if (this.opts.quotaBytes) n = this.opts.quotaBytes();
    else {
      let raw: string | undefined;
      try { raw = (this.db.prepare('SELECT value FROM settings WHERE key=?').get(CHECKPOINT_QUOTA_KEY) as { value: string } | undefined)?.value; } catch { raw = undefined; }
      n = raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(n)) return CHECKPOINT_QUOTA_DEFAULT_BYTES;
      // 越界夹到范围内：直接改库也低不过下限
      n = Math.min(CHECKPOINT_QUOTA_MAX_BYTES, Math.max(CHECKPOINT_QUOTA_MIN_BYTES, Math.floor(n)));
    }
    return n;
  }

  usage(): CheckpointUsage {
    const b = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS n FROM checkpoint_blobs').get() as { used: number; n: number };
    const c = this.db.prepare(`SELECT COUNT(*) AS n FROM file_checkpoints WHERE state IN ('pending','applied','restored','unknown')`).get() as { n: number };
    // 受保护的字节：被「按容量清理不碰」的记录（还没落定、恢复中、所属 run 仍在活动、unknown）引用着的内容
    const p = this.db.prepare(`SELECT COALESCE(SUM(b.size), 0) AS n FROM checkpoint_blobs b WHERE EXISTS (
      SELECT 1 FROM file_checkpoints c WHERE (c.before_blob = b.hash OR c.after_blob = b.hash) AND (c.state = 'unknown' OR ${PROTECTED}))`).get() as { n: number };
    const quotaBytes = this.quota();
    return {
      usedBytes: b.used, blobCount: b.n, checkpointCount: c.n, quotaBytes,
      retentionDays: this.retentionDays, maxFileBytes: this.maxFileBytes,
      protectedBytes: p.n, overQuota: p.n > quotaBytes,
    };
  }

  /** 越界抛错（设置不变）；合法值写进 settings 并随即清理。 */
  setQuota(bytes: number): CheckpointUsage {
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < CHECKPOINT_QUOTA_MIN_BYTES || bytes > CHECKPOINT_QUOTA_MAX_BYTES) {
      throw new Error(`检查点上限必须在 ${CHECKPOINT_QUOTA_MIN_BYTES / (1024 * 1024)} MB 到 ${CHECKPOINT_QUOTA_MAX_BYTES / (1024 * 1024 * 1024)} GB 之间`);
    }
    this.tx(() => {
      this.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
        .run(CHECKPOINT_QUOTA_KEY, String(bytes), this.now());
    });
    this.prune();
    return this.usage();
  }

  /** 这份内容还有没有记录指着。 */
  private referenced(hash: string): boolean {
    return this.db.prepare('SELECT 1 FROM file_checkpoints WHERE before_blob=? OR after_blob=? LIMIT 1').get(hash, hash) !== undefined;
  }

  /** 删掉一份内容：同一个事务里删登记行，提交之后才删文件（删不掉的下次启动清扫补删）。 */
  private dropBlobs(hashes: readonly string[]): number {
    if (hashes.length === 0) return 0;
    this.tx(() => { for (const h of hashes) this.db.prepare('DELETE FROM checkpoint_blobs WHERE hash=?').run(h); });
    for (const h of hashes) removeQuiet(this.io, this.blobPath(h));
    return hashes.length;
  }

  /**
   * 先按保留期，再按容量从最旧的**逐条**清，够了就停（used + need ≤ quota），或没有可清的。返回清掉的记录数。从不抛。
   * 逐条而不是成批：多清一条就多丢一段可恢复的历史；清掉的那条若与别的记录共用内容，占用不会降，接着清下一条。
   * keepHash：这份内容即使暂时没有任何引用也不删（prepare 传它将要引用的哈希）。
   */
  prune(needBytes = 0, keepHash?: string): number {
    let pruned = 0;
    const touched = new Set<string>();
    try {
      const at = this.now();
      // 1. 保留期（受节流）。unknown 的也清（保留期到了照常清）；还没落定的、恢复中的、所属 run 仍在活动的不清
      if (this.lastRetentionAt === undefined || at - this.lastRetentionAt >= RETENTION_SWEEP_INTERVAL_S) {
        this.lastRetentionAt = at;
        const cutoff = at - this.retentionDays * 86400;
        const old = this.db.prepare(`SELECT c.id, c.session_id FROM file_checkpoints c
          WHERE c.created_at < ? AND c.pruned_at IS NULL AND c.state IN ('applied','restored','unknown') AND NOT ${PROTECTED}`).all(cutoff) as { id: string; session_id: string }[];
        if (old.length > 0) {
          this.tx(() => {
            const mark = this.db.prepare('UPDATE file_checkpoints SET pruned_at=?, before_blob=NULL, after_blob=NULL, updated_at=? WHERE id=?');
            for (const r of old) mark.run(at, at, r.id);
          });
          pruned += old.length;
          for (const r of old) touched.add(r.session_id);
        }
      }
      // 2. 没有任何引用的内容
      this.gc({ keepHash });
      // 3. 容量：逐条
      const quota = this.quota();
      while (this.usedBytes() + needBytes > quota) {
        const c = this.db.prepare(`SELECT c.id, c.session_id, c.before_blob, c.after_blob FROM file_checkpoints c
          WHERE c.pruned_at IS NULL AND c.state IN ('applied','restored') AND (c.before_blob IS NOT NULL OR c.after_blob IS NOT NULL) AND NOT ${PROTECTED}
          ORDER BY c.seq LIMIT 1`).get() as { id: string; session_id: string; before_blob: string | null; after_blob: string | null } | undefined;
        if (!c) break;
        this.tx(() => {
          this.db.prepare('UPDATE file_checkpoints SET pruned_at=?, before_blob=NULL, after_blob=NULL, updated_at=? WHERE id=?').run(at, at, c.id);
        });
        pruned += 1;
        touched.add(c.session_id);
        const freed = [...new Set([c.before_blob, c.after_blob].filter((h): h is string => h !== null))]
          .filter(h => h !== keepHash && !this.referenced(h));
        this.dropBlobs(freed);
      }
    } catch (e) {
      this.warn('文件检查点：清理失败（下次再试）:', e);
    }
    for (const sid of touched) this.changed(sid);
    return pruned;
  }

  /** 删掉没有任何记录引用的内容（keepHash 除外）。sweep=true（只在启动时：那一刻没有任何写入在途）再清目录里没登记的文件与 tmp/。
   *  返回删掉的内容数。从不抛。 */
  gc(o: { sweep?: boolean; keepHash?: string } = {}): number {
    let n = 0;
    try {
      const orphans = (this.db.prepare(`SELECT b.hash FROM checkpoint_blobs b
        WHERE NOT EXISTS (SELECT 1 FROM file_checkpoints c WHERE c.before_blob = b.hash OR c.after_blob = b.hash)`).all() as { hash: string }[])
        .map(r => r.hash).filter(h => h !== o.keepHash);
      n = this.dropBlobs(orphans);
      if (o.sweep && this.available) {
        for (const sub of this.io.readdir(this.blobsDir)) {
          const d = join(this.blobsDir, sub);
          let names: string[] = [];
          try { names = this.io.readdir(d); } catch { continue; }
          for (const name of names) if (!this.registered(name)) removeQuiet(this.io, join(d, name));
        }
        for (const name of this.io.readdir(this.tmpDir)) removeQuiet(this.io, join(this.tmpDir, name));
      }
    } catch (e) {
      this.warn('文件检查点：内容回收失败（下次再试）:', e);
    }
    return n;
  }

  // ---------- 给清理方（附件清理）----------

  /** 是否有未恢复、未清理的检查点以这个路径为目标（state ∈ pending / applied / unknown 且 pruned_at 为空）。 */
  isPathReferenced(abs: string): boolean {
    return this.db.prepare(`SELECT 1 FROM file_checkpoints WHERE path_key=? AND state IN ('pending','applied','unknown') AND pruned_at IS NULL LIMIT 1`)
      .get(pathKeyOf(abs, this.opts.path)) !== undefined;
  }

  referencedPaths(sessionId: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT path FROM file_checkpoints WHERE session_id=? AND state IN ('pending','applied','unknown') AND pruned_at IS NULL ORDER BY path`)
      .all(sessionId) as { path: string }[]).map(r => r.path);
  }
}
