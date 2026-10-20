/**
 * F11A 附件索引与落盘（数据库加文件系统，不碰网络）。
 *
 * 一行 = 一个（会话，名字）绑定的内容（sha256 + 长度）与本机状态：
 *   present：本机附件桶里有完整且校验过的文件；missing：知道内容身份，本机没有；failed：见 fail_code。
 * 把行置成 present 只有两条路，都先算过整文件哈希：本机登记（ensureIndexed）与校验后的发布（publishVerified，
 * 参数类型 VerifiedFile 只有 io.verify 能造）。发布不覆盖：最终名字已被占就比较内容，不同则记冲突，那份文件不动。
 *
 * 路径只由本机拼：finalPath = <数据根>/sessions/<sid>/attachments/<name>，sessionId 与 name 都先过正则；
 * 读取前、发布前另核对桶目录的真实路径（被换成 junction / 符号链接时拒绝）。
 * 只有被本机该会话的消息引用到的名字才会被登记、受理、送出：桶里的截屏、卸载文件不在其中。
 */
import type Database from 'better-sqlite3';
import { closeSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { MinisPaths } from '../../paths';
import { SESSION_ID_RE, SHA256_HEX_RE, attachmentNameOf, localAttachmentNameOf, validateAttachmentName } from '../../../shared/attachments';
import { AttError, type AttErrorCode, type AttRejectCode, type WireAttachment } from './wire';
import type { AttachmentLimits } from './limits';
import { removeFileQuiet, type AttachmentIo, type VerifiedFile } from './io';

export interface AttachmentRow {
  sessionId: string; name: string; sha256: string; size: number; mimeType: string;
  state: 'present' | 'missing' | 'failed';
  want: boolean; failCode?: string; attempts: number;
  conflictSha256?: string; conflictSize?: number;
  statSize?: number; statMtimeMs?: number; sourceFp?: string;
  createdAt: number; updatedAt: number;
}
export interface RefInfo { name: string; relativePath: string; mimeType: string; originalFileName?: string }
export type AcceptResult =
  | { action: 'have'; row: AttachmentRow }
  | { action: 'want'; row: AttachmentRow }
  | { action: 'reject'; code: AttRejectCode };

/** 存储层向外的回调，由 createAttachmentSync 接到引擎上（都不抛）。 */
export interface AttachmentStoreDeps {
  /** 任何一行的状态变了。 */
  onChanged(sessionId: string): void;
  /** 一个 present 行的本机文件没了，行已改成 missing / local_missing。引擎接到后催一次对端。 */
  onLocalMissing(sessionId: string): void;
  /** 这个会话此刻还在不在（装配处接的是 chat.getSession）。删会话不经 onDirty、也不清本表的行，
   *  所以引用缓存与行都可能是删除之前的；查引用之前先问它，不在就当作没有任何引用。 */
  sessionExists(sessionId: string): boolean;
  /** 与接收器是同一个 publishBlock：本机去重在发布之前同步查一次。 */
  publishBlock(fp: string): AttErrorCode | undefined;
  /** 审计（可选）：manifest 冲突时记一条。 */
  audit?(event: string, payload: Record<string, unknown>, sessionId?: string): void;
}

type FileStat = { kind: 'file'; size: number; mtimeMs: number } | { kind: 'none' } | { kind: 'other' };
interface RefSet { valid: Map<string, RefInfo>; invalid: Array<{ relativePath: string; mimeType: string; originalFileName?: string }> }

/** 已不存在的会话的引用：空的，不进缓存。 */
const NO_REFS: RefSet = Object.freeze({ valid: new Map<string, RefInfo>(), invalid: [] });

/** 可以因为「本机出现了同内容的文件」而自愈的失败原因。 */
const HEALABLE_FAILS = new Set(['hash_mismatch', 'bad_chunk', 'io_error', 'name_conflict']);
const PART_NAME_RE = /^([0-9a-f]{64})\.(\d{1,16})\.part$/;

interface DbRow {
  session_id: string; name: string; sha256: string; size: number; mime_type: string; state: string; want: number;
  fail_code: string | null; attempts: number; conflict_sha256: string | null; conflict_size: number | null;
  stat_size: number | null; stat_mtime_ms: number | null; source_fp: string | null; created_at: number; updated_at: number;
}

function toRow(r: DbRow): AttachmentRow {
  return {
    sessionId: r.session_id, name: r.name, sha256: r.sha256, size: r.size, mimeType: r.mime_type,
    state: r.state as AttachmentRow['state'], want: r.want !== 0,
    failCode: r.fail_code ?? undefined, attempts: r.attempts,
    conflictSha256: r.conflict_sha256 ?? undefined, conflictSize: r.conflict_size ?? undefined,
    statSize: r.stat_size ?? undefined, statMtimeMs: r.stat_mtime_ms ?? undefined, sourceFp: r.source_fp ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function statOf(path: string): FileStat {
  try {
    // lstat：符号链接与 junction 不算普通文件
    const s = lstatSync(path);
    return s.isFile() ? { kind: 'file', size: s.size, mtimeMs: s.mtimeMs } : { kind: 'other' };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' };
    throw e;
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class AttachmentStore {
  private refCache = new Map<string, RefSet>();
  /** 本进程里完整登记过、之后没被 markDirty 的会话（快路径）。 */
  private indexed = new Set<string>();
  private indexing = new Map<string, { promise: Promise<void>; force: boolean }>();
  /** 每会话被 markDirty 的次数：登记期间被催过就不记「已登记」。 */
  private dirtyGen = new Map<string, number>();
  /** 每会话行写入次数：stamp 的一部分，同一毫秒内的两次写也分得开。 */
  private rev = new Map<string, number>();

  constructor(
    private readonly db: Database.Database,
    private readonly root: string,
    private readonly paths: Pick<MinisPaths, 'sessionBucket'>,
    private readonly limits: AttachmentLimits,
    private readonly io: AttachmentIo,
    private readonly now: () => number,
    private readonly deps: AttachmentStoreDeps,
  ) {}

  // ---- 路径 ----

  finalPath(sessionId: string, name: string): string {
    if (!SESSION_ID_RE.test(sessionId) || validateAttachmentName(name) === undefined) throw new AttError('ATT_BAD_REQUEST');
    return join(this.paths.sessionBucket(sessionId, 'attachments'), name);
  }

  incomingDir(): string { return join(this.root, 'sync-incoming'); }

  partPath(sha256: string, size: number): string {
    if (!SHA256_HEX_RE.test(sha256) || !Number.isSafeInteger(size) || size < 1) throw new AttError('ATT_BAD_REQUEST');
    return join(this.incomingDir(), `${sha256}.${size}.part`);
  }

  stagePath(sha256: string): string {
    if (!SHA256_HEX_RE.test(sha256)) throw new AttError('ATT_BAD_REQUEST');
    return join(this.incomingDir(), `${sha256}.${randomBytes(4).toString('hex')}.stage`);
  }

  /** 桶目录的真实路径必须正是 <数据根的真实路径>/sessions/<sid>/attachments：桶或上级被换成 junction / 符号链接时不过。
   *  create 为真（发布前）时先建目录；读取前不建，目录不存在就是不过。 */
  private bucketOk(sessionId: string, create: boolean): boolean {
    if (!SESSION_ID_RE.test(sessionId)) return false;
    const dir = this.paths.sessionBucket(sessionId, 'attachments');
    try {
      if (create) mkdirSync(dir, { recursive: true });
      const real = realpathSync.native(dir);
      const expect = join(realpathSync.native(this.root), 'sessions', sessionId, 'attachments');
      return samePath(real, expect);
    } catch { return false; }
  }

  /** 最终路径上的文件状态；桶目录校验不过时一律当作没有。lstat 抛的 EBUSY / EACCES 原样抛给调用方。 */
  private statFinal(sessionId: string, name: string): FileStat {
    const st = statOf(this.finalPath(sessionId, name));
    if (st.kind === 'none') return st;
    return this.bucketOk(sessionId, false) ? st : { kind: 'none' };
  }

  /** 本机附件桶里此刻有没有这个名字的普通文件（状态显示与 attachments.read 用）。不抛。 */
  localFile(sessionId: string, name: string): { path: string; size: number } | undefined {
    try {
      const st = this.statFinal(sessionId, name);
      return st.kind === 'file' ? { path: this.finalPath(sessionId, name), size: st.size } : undefined;
    } catch { return undefined; }
  }

  /** 引用的名字过不了同步的规则、但仍是附件桶里的一个单层文件名（shared 的 localAttachmentNameOf）：本机有没有这个普通文件。
   *  这类名字不登记、不同步、不上线路；这里只给状态显示与本机预览用——请求构建按文件名读本机文件，「本机有没有」要照实说。不抛。 */
  localFileLoose(sessionId: string, relativePath: string): { name: string; path: string; size: number } | undefined {
    const name = localAttachmentNameOf(relativePath);
    if (name === undefined || !SESSION_ID_RE.test(sessionId)) return undefined;
    try {
      const path = join(this.paths.sessionBucket(sessionId, 'attachments'), name);
      const st = statOf(path);
      return st.kind === 'file' && this.bucketOk(sessionId, false) ? { name, path, size: st.size } : undefined;
    } catch { return undefined; }
  }

  // ---- 引用 ----

  private sessionAlive(sessionId: string): boolean {
    try { return this.deps.sessionExists(sessionId); } catch { return false; }
  }

  private loadRefs(sessionId: string): RefSet {
    // 查缓存之前先问会话还在不在：删会话（chat.sessions.delete）不经 onDirty，缓存里还是删除之前的引用。
    // 送出（readChunk、listPresent）、受理（acceptRemote、put 的取行条件）、发布（wantedTargets、wantedRow）都以引用为判据，
    // 这一处挡住全部：已删的会话不再向对端提供附件、不再受理写入、不再有文件被发布。代价是每次一条主键查询。
    if (!this.sessionAlive(sessionId)) { this.refCache.delete(sessionId); return NO_REFS; }
    const hit = this.refCache.get(sessionId);
    if (hit) return hit;
    const valid = new Map<string, RefInfo>();
    const invalid: Array<{ relativePath: string; mimeType: string; originalFileName?: string }> = [];
    const seenInvalid = new Set<string>();
    const rows = this.db.prepare(
      `SELECT parts_json FROM messages WHERE session_id=? AND instr(parts_json,'"mediaRef"')>0 ORDER BY created_at, id`,
    ).all(sessionId) as Array<{ parts_json: string }>;
    for (const r of rows) {
      let parts: unknown;
      try { parts = JSON.parse(r.parts_json); } catch { continue; }
      if (!Array.isArray(parts)) continue;
      for (const p of parts) {
        if (p === null || typeof p !== 'object' || (p as { type?: unknown }).type !== 'mediaRef') continue;
        const v = (p as { value?: unknown }).value;
        if (v === null || typeof v !== 'object') continue;
        const { relativePath, mimeType, originalFileName } = v as { relativePath?: unknown; mimeType?: unknown; originalFileName?: unknown };
        const mime = typeof mimeType === 'string' ? mimeType : '';
        const orig = typeof originalFileName === 'string' ? originalFileName : undefined;
        const name = attachmentNameOf(relativePath);
        if (name === undefined) {
          const rel = typeof relativePath === 'string' ? relativePath : '';
          if (!seenInvalid.has(rel)) { seenInvalid.add(rel); invalid.push({ relativePath: rel, mimeType: mime, originalFileName: orig }); }
          continue;
        }
        const key = name.toLowerCase();
        // 同名多次引用合成一项，mimeType、originalFileName 取第一次出现的
        if (!valid.has(key)) valid.set(key, { name, relativePath: relativePath as string, mimeType: mime, originalFileName: orig });
      }
    }
    // 建好之后不再改：markDirty 是整份丢掉重建。引擎把某一刻的引用集当快照留着（「那次清单交换时这个名字被引用了没有」）
    const entry = { valid, invalid };
    this.refCache.set(sessionId, entry);
    return entry;
  }

  /** 该会话消息里引用到的合法附件名（键为小写名）。有缓存，markDirty 使之失效；会话已不存在时是空的。
   *  返回的表建好之后不再改（可以当快照留着）。
   *  F11B：「会话已不存在」包括在别的设备上被删、本机留着内容的保留副本（sessionExists 接的 chat.getSession 看不到它）——
   *  它的消息还在，但对同步等同没有任何引用：不登记、不列进清单、不送出、不受理。
   *  所以这张表只能用来回答「同步要不要管这个名字」。将来写附件文件的清理规则时不能拿它当「没有消息引用」：
   *  保留副本的附件恢复之后还要用，判据应当是「会话行还在（含隐藏行）」。 */
  referenced(sessionId: string): ReadonlyMap<string, RefInfo> { return this.loadRefs(sessionId).valid; }

  /** 引用形态不合规的 mediaRef（只给状态显示用）。 */
  invalidRefs(sessionId: string): Array<{ relativePath: string; mimeType: string; originalFileName?: string }> {
    return this.loadRefs(sessionId).invalid;
  }

  private isReferenced(sessionId: string, name: string): boolean {
    return this.referenced(sessionId).has(name.toLowerCase());
  }

  markDirty(sessionId: string): void {
    this.refCache.delete(sessionId);
    this.indexed.delete(sessionId);
    this.dirtyGen.set(sessionId, (this.dirtyGen.get(sessionId) ?? 0) + 1);
  }

  // ---- 行 ----

  get(sessionId: string, name: string): AttachmentRow | undefined {
    const r = this.db.prepare('SELECT * FROM sync_attachments WHERE session_id=? AND name=?').get(sessionId, name) as DbRow | undefined;
    return r ? toRow(r) : undefined;
  }

  list(sessionId: string): AttachmentRow[] {
    return (this.db.prepare('SELECT * FROM sync_attachments WHERE session_id=? ORDER BY name').all(sessionId) as DbRow[]).map(toRow);
  }

  /** state='present' 且仍被引用的行，按 name 升序，最多 sessionMaxFiles 条。 */
  listPresent(sessionId: string): AttachmentRow[] {
    const out: AttachmentRow[] = [];
    const refs = this.referenced(sessionId);
    for (const row of this.list(sessionId)) {
      if (row.state !== 'present' || !refs.has(row.name.toLowerCase())) continue;
      out.push(row);
      if (out.length >= this.limits.sessionMaxFiles) break;
    }
    return out;
  }

  /** 还有没到齐的附件（非 present 行）的会话：暂停 / 恢复时界面要跟着刷新的那些。 */
  sessionsWithUnfinished(): string[] {
    return (this.db.prepare(`SELECT DISTINCT session_id FROM sync_attachments WHERE state<>'present'`).all() as Array<{ session_id: string }>).map(r => r.session_id);
  }

  /** 这个会话有没有要取的 missing 行。 */
  hasWanted(sessionId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM sync_attachments WHERE session_id=? AND state='missing' AND want=1 LIMIT 1`).get(sessionId) !== undefined;
  }

  /** 「引用数:present 数:要取的 missing 数:failed 数:最大 updated_at:本进程内的写入次数」，作业的跳过判断用。 */
  stamp(sessionId: string): string {
    const refs = this.referenced(sessionId).size;
    let present = 0; let wanted = 0; let failed = 0; let max = 0;
    for (const row of this.list(sessionId)) {
      if (row.state === 'present') present++;
      else if (row.state === 'failed') failed++;
      else if (row.want) wanted++;
      if (row.updatedAt > max) max = row.updatedAt;
    }
    return `${refs}:${present}:${wanted}:${failed}:${max}:${this.rev.get(sessionId) ?? 0}`;
  }

  private touched(sessionId: string): void {
    this.rev.set(sessionId, (this.rev.get(sessionId) ?? 0) + 1);
    try { this.deps.onChanged(sessionId); } catch { /* 回调不得影响存储层 */ }
  }

  private insertRow(r: {
    sessionId: string; name: string; sha256: string; size: number; mimeType: string; state: 'missing' | 'failed';
    failCode?: string; sourceFp?: string;
  }): void {
    const t = this.now();
    this.db.prepare(
      `INSERT INTO sync_attachments (session_id, name, sha256, size, mime_type, state, want, fail_code, source_fp, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(r.sessionId, r.name, r.sha256, r.size, r.mimeType, r.state, r.failCode ?? null, r.sourceFp ?? null, t, t);
    this.touched(r.sessionId);
  }

  /** 把一行置成 present 的唯一写入点。调用方只有两个：登记（刚算过整文件哈希）与 publishVerified（拿着 VerifiedFile）。 */
  private writePresent(sessionId: string, name: string, sha256: string, size: number, mimeType: string, st: { size: number; mtimeMs: number }): void {
    const t = this.now();
    const done = this.db.prepare(
      `UPDATE sync_attachments SET state='present', want=1, fail_code=NULL, attempts=0, stat_size=?, stat_mtime_ms=?, updated_at=?
       WHERE session_id=? AND name=? AND sha256=? AND size=?`,
    ).run(st.size, st.mtimeMs, t, sessionId, name, sha256, size);
    if (done.changes === 0) {
      this.db.prepare(
        `INSERT OR IGNORE INTO sync_attachments (session_id, name, sha256, size, mime_type, state, want, stat_size, stat_mtime_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'present', 1, ?, ?, ?, ?)`,
      ).run(sessionId, name, sha256, size, mimeType, st.size, st.mtimeMs, t, t);
    }
    this.touched(sessionId);
  }

  private setState(row: AttachmentRow, state: 'missing' | 'failed', failCode: string | undefined, extra: { want?: boolean } = {}): void {
    this.db.prepare(
      'UPDATE sync_attachments SET state=?, fail_code=?, want=?, updated_at=? WHERE session_id=? AND name=?',
    ).run(state, failCode ?? null, (extra.want ?? row.want) ? 1 : 0, this.now(), row.sessionId, row.name);
    this.touched(row.sessionId);
  }

  private setStat(row: AttachmentRow, st: { size: number; mtimeMs: number }): void {
    this.db.prepare('UPDATE sync_attachments SET stat_size=?, stat_mtime_ms=? WHERE session_id=? AND name=?')
      .run(st.size, st.mtimeMs, row.sessionId, row.name);
  }

  /** present 行的本机文件没了：改成 missing / local_missing，催一次对端（只在这一下触发）。 */
  private markLocalMissing(row: AttachmentRow): void {
    this.setState(row, 'missing', 'local_missing', { want: true });
    try { this.deps.onLocalMissing(row.sessionId); } catch { /* 回调不得影响存储层 */ }
  }

  // ---- 本机登记 ----

  /** 对已引用的本机文件算哈希并登记。每个会话一把互斥；永不 reject。 */
  ensureIndexed(sessionId: string, opts: { force?: boolean } = {}): Promise<void> {
    const force = opts.force === true;
    const cur = this.indexing.get(sessionId);
    if (cur) {
      if (!force || cur.force) return cur.promise;
      return cur.promise.then(() => this.ensureIndexed(sessionId, opts));
    }
    if (!force && this.indexed.has(sessionId)) return Promise.resolve();
    const promise = this.indexSession(sessionId, force).catch(() => { /* 逐文件已各自兜住；这里只防意外 */ }).finally(() => {
      if (this.indexing.get(sessionId)?.promise === promise) this.indexing.delete(sessionId);
    });
    this.indexing.set(sessionId, { promise, force });
    return promise;
  }

  private async indexSession(sessionId: string, force: boolean): Promise<void> {
    if (!SESSION_ID_RE.test(sessionId)) return;
    const gen0 = this.dirtyGen.get(sessionId) ?? 0;
    let skipped = false;
    for (const ref of [...this.referenced(sessionId).values()]) {
      // 逐文件容错：一个读不了的文件（EBUSY、EACCES）不挡住这个会话的其它附件
      try { if (!(await this.indexOne(sessionId, ref, force))) skipped = true; } catch { skipped = true; }
    }
    // 有被跳过的名字、或登记期间又来了新消息：不记「已登记」，下一次调用再走一遍
    if (!skipped && (this.dirtyGen.get(sessionId) ?? 0) === gen0) this.indexed.add(sessionId);
  }

  /** 登记一个名字。返回 false 表示本轮跳过（算哈希期间文件被改写）。 */
  private async indexOne(sessionId: string, ref: RefInfo, force: boolean): Promise<boolean> {
    const before = this.get(sessionId, ref.name);
    const st = this.statFinal(sessionId, ref.name);
    if (!this.needsHash(before, st, force)) { this.applyUnhashed(sessionId, ref, before, st); return true; }
    const file = st as { kind: 'file'; size: number; mtimeMs: number };
    const h = await this.io.hash(this.finalPath(sessionId, ref.name));
    // 哈希前后各 lstat 一次：不同说明算哈希期间文件被改写，行里的哈希与 stat 必须对应同一份内容
    const after = this.statFinal(sessionId, ref.name);
    if (after.kind !== 'file' || after.size !== file.size || after.mtimeMs !== file.mtimeMs || h.size !== after.size) return false;
    // 等哈希的这段时间里 acceptRemote 或一次发布可能已经建了或改了同主键的行：重新取行再判定，不做盲插入
    this.applyHashed(sessionId, ref, this.get(sessionId, ref.name), h, after);
    return true;
  }

  private needsHash(row: AttachmentRow | undefined, st: FileStat, force: boolean): boolean {
    if (st.kind !== 'file') return false;
    if (!row) return st.size >= 1 && st.size <= this.limits.maxFileBytes;
    if (row.state === 'present') {
      if (st.size === row.statSize && st.mtimeMs === row.statMtimeMs) return false;
      return st.size === row.size;   // 长度都变了就不用算了，一定不是登记时的内容
    }
    if (row.state === 'missing' || (row.state === 'failed' && HEALABLE_FAILS.has(row.failCode ?? ''))) return st.size === row.size;
    if (row.state === 'failed' && row.failCode === 'local_changed') return force && st.size === row.size;
    return false;
  }

  /** 不需要算哈希就能定的那些分支。 */
  private applyUnhashed(sessionId: string, ref: RefInfo, row: AttachmentRow | undefined, st: FileStat): void {
    if (!row) {
      // 本机超限文件：本机使用不受影响，只是不同步（sha256 留空、size 记实际长度）。不存在、长度为 0、不是普通文件：不建行
      if (st.kind === 'file' && st.size > this.limits.maxFileBytes) {
        this.insertRow({ sessionId, name: ref.name, sha256: '', size: st.size, mimeType: ref.mimeType, state: 'failed', failCode: 'too_large' });
      }
      return;
    }
    if (row.state === 'present') {
      if (st.kind !== 'file') { this.markLocalMissing(row); return; }
      if (st.size !== row.size) this.setState(row, 'failed', 'local_changed');
      return;
    }
    if (row.state === 'missing' || (row.state === 'failed' && HEALABLE_FAILS.has(row.failCode ?? ''))) {
      // 最终名字上有一份长度都不同的文件：发布时一定撞名
      if (st.kind === 'file' && st.size !== row.size && !(row.state === 'failed' && row.failCode === 'name_conflict')) {
        this.setState(row, 'failed', 'name_conflict');
      }
      return;
    }
    if (row.state === 'failed' && row.failCode === 'local_changed' && st.kind !== 'file') {
      // 被改过的本机文件后来又被删了：登记时的内容别的设备上可能还有，按「本机文件丢了」取回
      this.markLocalMissing(row);
    }
  }

  private applyHashed(sessionId: string, ref: RefInfo, row: AttachmentRow | undefined, h: { sha256: string; size: number }, st: { size: number; mtimeMs: number }): void {
    if (!row) {
      this.writePresent(sessionId, ref.name, h.sha256, h.size, ref.mimeType, st);
      return;
    }
    const same = row.sha256 === h.sha256 && row.size === h.size;
    if (row.state === 'present') {
      if (same) this.setStat(row, st);
      else this.setState(row, 'failed', 'local_changed');
      return;
    }
    if (row.state === 'missing' || (row.state === 'failed' && HEALABLE_FAILS.has(row.failCode ?? ''))) {
      // 崩溃在发布与写库之间：最终名字上已是那份内容，补记 present；不同则是撞名
      if (same) this.writePresent(sessionId, row.name, row.sha256, row.size, row.mimeType, st);
      else if (!(row.state === 'failed' && row.failCode === 'name_conflict')) this.setState(row, 'failed', 'name_conflict');
      return;
    }
    if (row.state === 'failed' && row.failCode === 'local_changed' && same) {
      this.writePresent(sessionId, row.name, row.sha256, row.size, row.mimeType, st);
    }
  }

  // ---- 受理对端的 manifest ----

  /** 调用方已保证 sessionId 合规、会话存在、entry 过了 parseWireAttachment，且此前 ensureIndexed 完整跑完过一次。 */
  async acceptRemote(sessionId: string, entry: WireAttachment, fromFp: string): Promise<AcceptResult> {
    const ref = this.referenced(sessionId).get(entry.name.toLowerCase());
    // 消息还没到：不建行，下一轮（消息到了之后）会再来
    if (!ref) return { action: 'reject', code: 'not_referenced' };
    let row = this.get(sessionId, ref.name);
    if (row) {
      if (row.sha256 === entry.sha256 && row.size === entry.size) {
        if (!row.sourceFp) {
          this.db.prepare('UPDATE sync_attachments SET source_fp=? WHERE session_id=? AND name=?').run(fromFp, sessionId, row.name);
        }
      } else {
        // 同名不同内容：本机先有的为准，绑定不自动改；后到的声明记下来给界面看
        if (row.conflictSha256 !== entry.sha256 || row.conflictSize !== entry.size) {
          this.db.prepare('UPDATE sync_attachments SET conflict_sha256=?, conflict_size=?, updated_at=? WHERE session_id=? AND name=?')
            .run(entry.sha256, entry.size, this.now(), sessionId, row.name);
          this.touched(sessionId);
          this.auditQuiet('attachment.conflict', { sessionId, name: row.name, sha256: entry.sha256.slice(0, 12), size: entry.size, peer: fromFp, result: 'name_conflict' }, sessionId);
        }
        return { action: 'reject', code: 'name_conflict' };
      }
    } else {
      let st: FileStat;
      try { st = this.statFinal(sessionId, ref.name); } catch { return { action: 'reject', code: 'busy' }; }
      // 本机有这个名字的文件、只是还没登记：不按对端的哈希建行（否则本机原件随后会被判成撞名），让对方稍后重来
      if (st.kind === 'file' && st.size !== 0) return { action: 'reject', code: 'busy' };
      if (entry.size > this.limits.maxFileBytes) {
        this.insertRow({ sessionId, name: ref.name, sha256: entry.sha256, size: entry.size, mimeType: ref.mimeType || entry.mimeType, state: 'failed', failCode: 'too_large', sourceFp: fromFp });
        return { action: 'reject', code: 'too_large' };
      }
      const usage = this.db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN state='present' OR (state='missing' AND want=1) THEN size ELSE 0 END), 0) AS bytes
         FROM sync_attachments WHERE session_id=?`,
      ).get(sessionId) as { n: number; bytes: number };
      if (usage.n >= this.limits.sessionMaxFiles || usage.bytes + entry.size > this.limits.sessionQuotaBytes) {
        this.insertRow({ sessionId, name: ref.name, sha256: entry.sha256, size: entry.size, mimeType: ref.mimeType || entry.mimeType, state: 'failed', failCode: 'quota', sourceFp: fromFp });
        return { action: 'reject', code: 'quota' };
      }
      // 线路上的 mimeType 只在建行时采用，本机消息里的优先；不参与任何判断
      this.insertRow({ sessionId, name: ref.name, sha256: entry.sha256, size: entry.size, mimeType: ref.mimeType || entry.mimeType, state: 'missing', sourceFp: fromFp });
    }
    row = this.get(sessionId, ref.name)!;
    if (row.state === 'present') return { action: 'have', row };
    if (row.state === 'failed') {
      return { action: 'reject', code: row.failCode === 'too_large' ? 'too_large' : row.failCode === 'quota' ? 'quota' : 'failed' };
    }
    if (!row.want) return { action: 'reject', code: 'held' };
    if (await this.tryLocalDedupe(row, fromFp)) return { action: 'have', row: this.get(sessionId, ref.name) ?? row };
    return { action: 'want', row: this.get(sessionId, ref.name) ?? row };
  }

  /** 同一内容键下 state='missing' 且 want=1 且仍被引用的行。 */
  wantedTargets(sha256: string, size: number): AttachmentRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM sync_attachments WHERE sha256=? AND size=? AND state='missing' AND want=1 ORDER BY session_id, name`,
    ).all(sha256, size) as DbRow[];
    return rows.map(toRow).filter(r => this.isReferenced(r.sessionId, r.name));
  }

  /** 这一行此刻还要不要这份内容：仍是 missing、want=1、内容键没换，且名字仍被这个会话的消息引用（会话被删、消息被清之后不算）。
   *  发布之前的最后一次复查用它：复制与校验有 await，期间用户可能取消、会话可能被删。 */
  wantedRow(sessionId: string, name: string, sha256: string, size: number): AttachmentRow | undefined {
    const cur = this.get(sessionId, name);
    if (!cur || cur.state !== 'missing' || !cur.want || cur.sha256 !== sha256 || cur.size !== size) return undefined;
    return this.isReferenced(sessionId, cur.name) ? cur : undefined;
  }

  // ---- 发布 ----

  /** 把校验过的文件以不覆盖的方式放到最终名字，行置成 present。 */
  async publishVerified(row: AttachmentRow, staged: VerifiedFile): Promise<'published' | 'exists_same' | 'conflict'> {
    const failIo = (): never => {
      const cur = this.get(row.sessionId, row.name);
      if (cur && cur.state !== 'present') this.setState(cur, 'failed', 'io_error');
      removeFileQuiet(staged.path);
      throw new AttError('ATT_IO');
    };
    if (staged.sha256 !== row.sha256 || staged.size !== row.size) failIo();
    if (!this.bucketOk(row.sessionId, true)) failIo();
    const final = this.finalPath(row.sessionId, row.name);
    let r: 'published' | 'exists';
    try { r = this.io.publish(staged.path, final); } catch { return failIo(); }
    if (r === 'exists') {
      // 最终名字已被占（登记之后才出现的文件）：内容相同当作已发布，不同记撞名，那份文件不动
      let h: { sha256: string; size: number } | undefined;
      try { h = await this.io.hash(final); } catch { h = undefined; }
      removeFileQuiet(staged.path);
      const st = this.localStat(row.sessionId, row.name);
      if (h && st && h.sha256 === row.sha256 && h.size === row.size) {
        this.writePresent(row.sessionId, row.name, row.sha256, row.size, row.mimeType, st);
        return 'exists_same';
      }
      const cur = this.get(row.sessionId, row.name);
      if (cur && cur.state !== 'present') this.setState(cur, 'failed', 'name_conflict');
      return 'conflict';
    }
    const st = this.localStat(row.sessionId, row.name);
    if (!st) return failIo();
    this.writePresent(row.sessionId, row.name, row.sha256, row.size, row.mimeType, st);
    return 'published';
  }

  private localStat(sessionId: string, name: string): { size: number; mtimeMs: number } | undefined {
    try {
      const st = statOf(this.finalPath(sessionId, name));
      return st.kind === 'file' ? { size: st.size, mtimeMs: st.mtimeMs } : undefined;
    } catch { return undefined; }
  }

  /** 本机别处已有同内容的完成文件时本机复制，不走网络。用的绑定（名字 → 哈希）是对端给的，
   *  所以发布之前同样要过 publishBlock：暂停、取消配对、关停之后不再有文件被发布。 */
  async tryLocalDedupe(row: AttachmentRow, fromFp: string): Promise<boolean> {
    const sources = (this.db.prepare(
      `SELECT * FROM sync_attachments WHERE sha256=? AND size=? AND state='present' AND NOT (session_id=? AND name=?) LIMIT 5`,
    ).all(row.sha256, row.size, row.sessionId, row.name) as DbRow[]).map(toRow);
    for (const src of sources) {
      let stage: string | undefined;
      try {
        if (!(await this.verifyPresent(src))) continue;
        stage = this.stagePath(row.sha256);
        await this.io.copy(this.finalPath(src.sessionId, src.name), stage);
        const v = await this.io.verify(stage, row.sha256, row.size);
        if (!v) { removeFileQuiet(stage); continue; }
        // 前面几步有 await：期间可能已暂停、已取消配对、已关停
        if (this.deps.publishBlock(fromFp) !== undefined) { removeFileQuiet(stage); return false; }
        const cur = this.wantedRow(row.sessionId, row.name, row.sha256, row.size);
        if (!cur) { removeFileQuiet(stage); return false; }
        const r = await this.publishVerified(cur, v);
        return r !== 'conflict';
      } catch {
        if (stage) removeFileQuiet(stage);
      }
    }
    return false;
  }

  /** present 行的本机文件还在不在、内容还是不是登记时那份。不是时行已按登记表改掉。 */
  async verifyPresent(row: AttachmentRow): Promise<boolean> {
    let st: FileStat;
    try { st = this.statFinal(row.sessionId, row.name); } catch { return false; }
    if (st.kind !== 'file') {
      const cur = this.get(row.sessionId, row.name);
      if (cur && cur.state === 'present') this.markLocalMissing(cur);
      return false;
    }
    if (st.size === row.statSize && st.mtimeMs === row.statMtimeMs) return true;
    let same = false;
    if (st.size === row.size) {
      let h: { sha256: string; size: number };
      try { h = await this.io.hash(this.finalPath(row.sessionId, row.name)); } catch { return false; }
      let after: FileStat;
      try { after = this.statFinal(row.sessionId, row.name); } catch { return false; }
      if (after.kind !== 'file' || after.size !== st.size || after.mtimeMs !== st.mtimeMs) return false;
      same = h.sha256 === row.sha256 && h.size === row.size;
    }
    const cur = this.get(row.sessionId, row.name);
    if (!cur || cur.state !== 'present' || cur.sha256 !== row.sha256) return false;
    if (same) { this.setStat(cur, st); return true; }
    this.setState(cur, 'failed', 'local_changed');
    return false;
  }

  // ---- 发送源 ----

  /** 读一块给对端。读的路径只来自本机的行与本机的 join；所有「取不到」都是 ATT_NOT_FOUND，不透露文件在不在。 */
  async readChunk(sessionId: string, name: string, sha256: string, offset: number): Promise<{ bytes: Buffer; size: number }> {
    const notFound = (): never => { throw new AttError('ATT_NOT_FOUND'); };
    if (!SESSION_ID_RE.test(sessionId) || validateAttachmentName(name) === undefined) notFound();
    let row = this.get(sessionId, name);
    if (!row || row.state !== 'present' || row.sha256 !== sha256 || !this.isReferenced(sessionId, row.name)) return notFound();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= row.size || offset % this.limits.chunkBytes !== 0) notFound();
    let st: FileStat;
    try { st = this.statFinal(sessionId, row.name); } catch { return notFound(); }
    if (st.kind !== 'file' || st.size !== row.statSize || st.mtimeMs !== row.statMtimeMs) {
      // 文件没了或 stat 变了：整文件重新核对；不过时行已改成 failed/local_changed 或 missing
      if (!(await this.verifyPresent(row))) notFound();
      row = this.get(sessionId, name);
      if (!row || row.state !== 'present' || row.sha256 !== sha256) return notFound();
    }
    const want = Math.min(this.limits.chunkBytes, row.size - offset);
    const buf = Buffer.allocUnsafe(want);
    let fd: number | undefined;
    try {
      fd = openSync(this.finalPath(sessionId, row.name), 'r');
      const n = readSync(fd, buf, 0, want, offset);
      if (n !== want) notFound();
    } catch (e) {
      if (e instanceof AttError) throw e;
      notFound();
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关闭 */ } }
    }
    return { bytes: buf, size: row.size };
  }

  // ---- 行状态的其它写入 ----

  /** 整文件校验失败后调：该内容键下每个要取的行 attempts+1；超过 integrityRetries 的置 failed/hash_mismatch。 */
  noteIntegrityFailure(sha256: string, size: number): void {
    for (const row of this.wantedTargets(sha256, size)) {
      const attempts = row.attempts + 1;
      const failed = attempts > this.limits.integrityRetries;
      this.db.prepare('UPDATE sync_attachments SET attempts=?, state=?, fail_code=?, updated_at=? WHERE session_id=? AND name=?')
        .run(attempts, failed ? 'failed' : 'missing', failed ? 'hash_mismatch' : null, this.now(), row.sessionId, row.name);
      this.touched(row.sessionId);
      if (failed) this.auditQuiet('attachment.failed', { sessionId: row.sessionId, name: row.name, sha256: sha256.slice(0, 12), size, peer: row.sourceFp, result: 'hash_mismatch' }, row.sessionId);
    }
  }

  /** 把一个还没到的附件记成失败。present 行不动（本机已有校验过的文件）。 */
  fail(sessionId: string, name: string, code: string): void {
    const row = this.get(sessionId, name);
    if (!row || row.state === 'present') return;
    this.setState(row, 'failed', code);
    this.auditQuiet('attachment.failed', { sessionId, name: row.name, sha256: row.sha256.slice(0, 12), size: row.size, peer: row.sourceFp, result: code }, sessionId);
  }

  /** 该内容键下每个要取的行记成失败（写暂存出错时用）。 */
  failContent(sha256: string, size: number, code: string): void {
    for (const row of this.wantedTargets(sha256, size)) this.fail(row.sessionId, row.name, code);
  }

  /** 瞬时中断：不计失败次数，只留一个给界面看的原因。 */
  noteInterrupted(sessionId: string, name: string): void {
    const row = this.get(sessionId, name);
    if (!row || row.state !== 'missing' || !row.want || row.failCode === 'interrupted') return;
    this.setState(row, 'missing', 'interrupted');
  }

  /** 用户取消：missing 行置 want=0，等用户点「下载」。其它状态的行不动。 */
  hold(sessionId: string, name: string): void {
    const row = this.get(sessionId, name);
    if (!row || row.state !== 'missing' || !row.want) return;
    this.setState(row, 'missing', undefined, { want: false });
  }

  /** 用户重试（调用方先 ensureIndexed(force)）。 */
  retry(sessionId: string, name: string): void {
    const row = this.get(sessionId, name);
    if (!row || row.state === 'present') return;
    if (row.state === 'failed' && (row.failCode === 'too_large' || row.failCode === 'quota')) {
      // 删掉这一行，下一份清单重新判定
      this.db.prepare('DELETE FROM sync_attachments WHERE session_id=? AND name=?').run(sessionId, row.name);
      this.touched(sessionId);
      return;
    }
    // 只靠调用方那次强制核对：文件恢复原样就回到 present；不重新登记，别的设备上可能已是登记时的内容
    if (row.state === 'failed' && row.failCode === 'local_changed') return;
    // 本机同名文件还在（强制核对刚确认过内容不同）：重传只会在发布时再撞一次名
    if (row.state === 'failed' && row.failCode === 'name_conflict' && this.localFile(sessionId, row.name)) return;
    // 有冲突声明就采纳它：改绑只在用户点重试时发生
    const sha = row.conflictSha256 ?? row.sha256;
    const size = row.conflictSha256 !== undefined && row.conflictSize !== undefined ? row.conflictSize : row.size;
    this.db.prepare(
      `UPDATE sync_attachments SET state='missing', want=1, fail_code=NULL, attempts=0, sha256=?, size=?, conflict_sha256=NULL, conflict_size=NULL, updated_at=?
       WHERE session_id=? AND name=?`,
    ).run(sha, size, this.now(), sessionId, row.name);
    this.touched(sessionId);
  }

  private auditQuiet(event: string, payload: Record<string, unknown>, sessionId?: string): void {
    try { this.deps.audit?.(event, payload, sessionId); } catch { /* 审计失败不影响同步 */ }
  }

  /** 收完一个附件时由接收器调（审计一条）。 */
  noteReceived(row: AttachmentRow, peer: string): void {
    this.auditQuiet('attachment.received', { sessionId: row.sessionId, name: row.name, sha256: row.sha256.slice(0, 12), size: row.size, peer, result: 'ok' }, row.sessionId);
  }

  // ---- 启动自检 ----

  /** 同步。① 已不存在的会话的行删掉（只删行，不删文件）；② 清掉全部 .stage；③ .part 只留还有人要、没超长、没过期的。 */
  recover(): void {
    try { this.db.prepare('DELETE FROM sync_attachments WHERE session_id NOT IN (SELECT id FROM sessions)').run(); } catch { /* 库不可用时不挡启动 */ }
    let names: string[];
    try { names = readdirSync(this.incomingDir()); } catch { return; }
    const wanted = this.db.prepare(`SELECT 1 FROM sync_attachments WHERE sha256=? AND size=? AND state='missing' AND want=1 LIMIT 1`);
    for (const n of names) {
      const full = join(this.incomingDir(), n);
      if (n.endsWith('.stage')) { removeFileQuiet(full); continue; }
      if (!n.endsWith('.part')) continue;
      const m = PART_NAME_RE.exec(n);
      let keep = false;
      if (m) {
        const size = Number(m[2]);
        try {
          const st = lstatSync(full);
          keep = st.isFile() && Number.isSafeInteger(size) && st.size <= size
            && this.now() - st.mtimeMs <= this.limits.partTtlMs
            && wanted.get(m[1], size) !== undefined;
        } catch { keep = false; }
      }
      if (!keep) removeFileQuiet(full);
    }
  }
}
