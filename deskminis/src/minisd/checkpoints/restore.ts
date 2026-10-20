/**
 * F08：变化清单、前后对比、冲突安全的恢复与另存。
 *
 * 恢复协议：预检 → 取资源锁（与工具写入同一把，F04）→ 锁内完整重判 → 先把当前字节存进检查点、再原子替换。
 * 逐项给结果，不做整体回滚——多文件恢复不是原子的，前面的项恢复了、后面的项冲突，前面的不回滚。
 *
 * 硬规则：
 *  - 动手之前，同一段同步代码里确认了：路径身份键相同；目标是可写的普通文件、单链接；内容哈希等于这次改动写入的；
 *    文件 ID 符合（取得到时）；动手前一刻的 stat 与算哈希时相同。哈希、存进检查点的字节、动手前比对的签名
 *    取自锁内对目标的**同一次读**。任何一条不成立都不动文件。没有强制选项。
 *  - 恢复新建的文件只做删除；内容不等于这次写入的就不删。
 *  - 取到的资源锁一定在 finally 里放掉；审计与广播的失败不改变已得出的逐项结果。
 *  - 恢复、另存只由 RPC 触发（仅本机连接）；这里不是工具，不经注册表，模型没有恢复工具。
 *  - 不执行任何外部命令。办公目录不能假设有版本库：恢复只动目标这一个文件。
 *  - 已删除的会话（F11B：已清除的，以及已在其他设备删除、本机留着副本的）不显示、不恢复：清单给空，预检、对比、恢复、
 *    另存整次拒绝；恢复在锁内重判时再查一次（等锁期间对端的删除可能落地）。保留副本的记录与内容留着，会话显式恢复之后照常可用。
 */
import * as nodePath from 'node:path';
import {
  CHECKPOINT_DIFF_TEXT_MAX_BYTES, CHECKPOINT_LIST_MAX_ROWS, CHECKPOINT_MAX_FILE_BYTES, CHECKPOINT_OFFICE_DIFF_MAX_BYTES,
  CHECKPOINT_RESTORE_LOCK_WAIT_MS, CHECKPOINT_RESTORE_MAX_ITEMS, describeVerdict,
  type ChangeDiff, type ChangeList, type DiffSide, type FileChangeView, type RestoreItemResult, type RestorePrecheck,
  type RestoreReport, type RestoreVerdict, type RunChangeGroup,
} from '../../shared/checkpoint';
import type { MinisPaths } from '../paths';
import { parseOffice } from '../office/parse';
import { dataGate, pathIdentity, pathKeyOf, realPathOf, type DataGateOptions } from '../tools/data-gate';
import { decodeUtf8Exact } from '../tools/edit-text';
import { docToText } from '../tools/office';
import type { LockClaim, ResourceLockManager } from '../tools/resource-locks';
import type { FileId } from '../tools/types';
import { CheckpointError } from './commit';
import {
  errCode, fileIdOf, isBusyCode, nodeFileIo, removeQuiet, replaceExisting, sameSig, sha256Hex, tmpPathFor, TargetChangedError,
  type FileIo, type FileSig,
} from './fs';
import type { CheckpointRow, CheckpointStore } from './store';

export interface CheckpointServiceDeps {
  store: CheckpointStore; paths: MinisPaths; locks: ResourceLockManager;
  /** 这个会话此刻有没有 run 在跑。在跑时不允许恢复：它的工具随时可能再写这些文件。 */
  isSessionRunning(sessionId: string): boolean;
  /** 这个会话是不是已删除（F11B 的生命周期登记为奇数）：已清除的，以及「已在其他设备删除、本机留着副本」的。
   *  已删除的会话不显示、拒写：清单给空，预检、对比、恢复、另存一律拒绝。保留副本的检查点留着，会话显式恢复之后照常可用。 */
  isSessionDeleted(sessionId: string): boolean;
  /** 每个 run 里已启动、副作用范围未知的调用数，按工具名分类。它们的改动不在记录范围内。 */
  uncoveredCalls(sessionId: string): Map<string, { shell: number; mcp: number; other: number }>;
  runMeta(runIds: readonly string[]): Map<string, { generation: number; createdAt: number; state: string }>;
  /** 可能抛（库写失败）。兜住。 */
  audit?(eventType: string, payload: unknown, opts: { sessionId?: string }): void;
  io?: FileIo; path?: DataGateOptions;
  /** 恢复取锁的等待上限，缺省 CHECKPOINT_RESTORE_LOCK_WAIT_MS。 */
  lockWaitMs?: number;
  warn?(msg: string, e?: unknown): void;
}

/** 预检的结果。cur 是目标此刻的真实路径；read 是核对内容那一次读到的字节、签名与哈希——恢复在锁内接着用，对目标不再读第二次。 */
interface Pre { verdict: RestoreVerdict; cur?: string; read?: { bytes: Buffer; sig: FileSig; hash: string } }

const OFFICE_EXT = new Set(['docx', 'xlsx', 'xlsm', 'pptx']);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const un = (reason: Extract<RestoreVerdict, { kind: 'unavailable' }>['reason']): Pre => ({ verdict: { kind: 'unavailable', reason } });
const conflict = (reason: Extract<RestoreVerdict, { kind: 'conflict' }>['reason'], later?: { id: string; sessionId: string }[]): Pre =>
  ({ verdict: later ? { kind: 'conflict', reason, later } : { kind: 'conflict', reason } });

export class CheckpointService {
  private readonly store: CheckpointStore;
  private readonly io: FileIo;
  private readonly warn: (msg: string, e?: unknown) => void;

  constructor(private readonly deps: CheckpointServiceDeps) {
    this.store = deps.store;
    this.io = deps.io ?? nodeFileIo;
    this.warn = deps.warn ?? ((msg, e) => { console.warn(msg, e); });
  }

  // ---------- 清单 ----------

  private displayPath(row: CheckpointRow, workspace: { root: string; segs: string[] } | undefined): string {
    if (!workspace) return row.path;
    try {
      const id = pathIdentity(row.path, this.deps.path);
      if (id.root !== workspace.root || workspace.segs.length >= id.segs.length || !workspace.segs.every((s, i) => s === id.segs[i])) return row.path;
      // 尾部各段取自真实路径本身：保留磁盘上的大小写
      const parts = row.path.split(/[\\/]/).filter(s => s !== '');
      return parts.slice(parts.length - (id.segs.length - workspace.segs.length)).join('/');
    } catch { return row.path; }
  }

  private view(row: CheckpointRow, workspace?: { root: string; segs: string[] }): FileChangeView {
    const v: FileChangeView = {
      id: row.id, seq: row.seq, sessionId: row.sessionId, toolName: row.toolName, ordinal: row.ordinal,
      path: row.path, displayPath: this.displayPath(row, workspace), pathKey: row.pathKey,
      kind: row.kind, state: row.state, before: row.before, after: row.after,
      beforeStored: row.beforeStored, afterStored: row.afterStored, createdAt: row.createdAt,
    };
    for (const k of ['runId', 'executionId', 'toolUseId', 'appliedAt', 'restoredAt', 'prunedAt', 'abortReason', 'detail'] as const) {
      if (row[k] !== undefined) (v as unknown as Record<string, unknown>)[k] = row[k];
    }
    return v;
  }

  private workspaceId(sessionId: string): { root: string; segs: string[] } | undefined {
    try { return pathIdentity(this.deps.paths.workspaceOf(sessionId), this.deps.path); } catch { return undefined; }
  }

  /** 已删除的会话（含保留副本）不接受按会话的查看与恢复：与 chat.prompt、会话存储层的写入同一句话。 */
  private assertSessionLive(sessionId: string): void {
    if (this.deps.isSessionDeleted(sessionId)) throw new Error('会话已删除');
  }

  /** 按 run 分组的变化清单。进门先清理与对账：界面看到的占用是清过的，停在 pending / 「恢复中」的陈旧行已按实际文件落定。 */
  list(sessionId: string): ChangeList {
    this.store.prune(0);
    // 已删除的会话不显示（与 chat.runs.snapshot 同一口径）：空清单，不抛——界面正开着的会话被别的设备删掉时，
    // 这里晚到的一次重取不该闪一句报错。保留副本的记录原样留着，不在这里对账（那会读用户的文件、改它的记录）；占用是全局的，照给
    if (this.deps.isSessionDeleted(sessionId)) return { groups: [], truncated: false, usage: this.store.usage(), coveredToolUseIds: [] };
    this.store.reconcile({ sessionId });
    const all = this.store.listSession(sessionId, CHECKPOINT_LIST_MAX_ROWS + 1);
    const truncated = all.length > CHECKPOINT_LIST_MAX_ROWS;
    const rows = truncated ? all.slice(0, CHECKPOINT_LIST_MAX_ROWS) : all;
    const ws = this.workspaceId(sessionId);
    const runIds = [...new Set(rows.map(r => r.runId).filter((x): x is string => x !== undefined))];
    let meta = new Map<string, { generation: number; createdAt: number; state: string }>();
    let uncovered = new Map<string, { shell: number; mcp: number; other: number }>();
    try { meta = this.deps.runMeta(runIds); } catch (e) { this.warn('文件检查点：读取运行信息失败:', e); }
    try { uncovered = this.deps.uncoveredCalls(sessionId); } catch (e) { this.warn('文件检查点：读取未覆盖调用数失败:', e); }
    const byRun = new Map<string | null, RunChangeGroup>();
    for (const r of rows) {   // rows 已按 seq 降序
      const key = r.runId ?? null;
      let g = byRun.get(key);
      if (!g) {
        g = { runId: key, changes: [], uncovered: (key !== null ? uncovered.get(key) : undefined) ?? { shell: 0, mcp: 0, other: 0 } };
        const m = key !== null ? meta.get(key) : undefined;
        if (m) { g.generation = m.generation; g.startedAt = m.createdAt; g.runState = m.state; }
        byRun.set(key, g);
      }
      g.changes.push(this.view(r, ws));
    }
    // 组按 run 的开始时刻降序；取不到 run 信息的（不带账本的调用）按组内最新一条的时刻排
    const at = (g: RunChangeGroup): number => g.startedAt ?? g.changes[0]?.createdAt ?? 0;
    const groups = [...byRun.values()].sort((a, b) => at(b) - at(a));
    // coveredToolUseIds 不取自截断后的 rows：清单只给最近若干条，而「哪些写调用不该再按工具入参列成改动」要看全部
    return { groups, truncated, usage: this.store.usage(), coveredToolUseIds: this.store.coveredToolUseIds(sessionId) };
  }

  // ---------- 预检 ----------

  /** 这个路径身份上最近一次由本应用完成的写入或恢复留下的文件 ID：改名替换会换掉文件 ID，
   *  同一文件先后两次改动、恢复了后一次之后，磁盘上的文件既不是前一次记的、也不是后一次记的那个。取不到返回 undefined（跳过比对）。
   *  取不到的一种来源：同一路径上别的会话的记录随那个会话被物理清除，这条链断了——清除时已把这条路径上剩下的记录里的
   *  文件 ID 置空（ChatStore.purgeSessionRows），不让断了的链把一个字节没变的文件判成 replaced。 */
  private expectedFileId(R: CheckpointRow): FileId | undefined {
    let best: { at: number; id: FileId | undefined } = { at: R.appliedAt ?? R.createdAt, id: R.fileId };
    let own = true;
    for (const l of this.store.laterOnPath(R.pathKey, R.seq)) {   // seq 升序
      if (l.state !== 'restored' || l.restoredAt === undefined) continue;
      // 时刻并列时谁更晚：对 R 自己的写入，后面记录的恢复一定更晚（那条记录在 R 写完之后才建）；
      // 两次恢复之间，seq 小的更晚——同一路径上的恢复从最新的一条往回做（前一条恢复时后面的都已恢复），
      // 一次「恢复这次运行」里相邻两条可以落在同一毫秒。按「不早于」取会选中 seq 大的那条的旧 ID，把链上最早的一条判成 replaced
      if (own ? l.restoredAt >= best.at : l.restoredAt > best.at) { best = { at: l.restoredAt, id: l.restoredFileId }; own = false; }
    }
    return best.id;
  }

  /**
   * 对一条记录按序判，命中即止。对目标只读、算哈希，从不写目标。两处会动检查点自己的东西：
   * 停在 pending / 「恢复中」的行先对账（只重判一次）；nlink > 1 时补删这条路径上记录在案的残留临时文件。从不抛。
   */
  private precheck(row: CheckpointRow, mayReconcile = true): Pre {
    try {
      const R = row;
      // 排在最前、任何对账与读文件之前：已删除的会话（保留副本）是冻结的，它的记录与它改过的文件都不动。
      // 进门时已删除的会话整次调用已被拒；走到这里的是「恢复等锁期间，对端的删除落地、会话成了保留副本」
      if (this.deps.isSessionDeleted(R.sessionId)) return un('session-deleted');
      if (R.state === 'restored') return un('already-restored');
      if (R.state === 'aborted') return un('not-applied');
      if (R.state === 'pending' || R.restoringAt !== undefined) {
        // 同进程里 applied / finishRestore 的写库失败会留下这种行：不先对账，一个其实已经恢复好的文件会被报成「被修改过」
        if (!mayReconcile) return un('unsettled');
        this.store.reconcile({ id: R.id });
        const again = this.store.get(R.id);
        return again ? this.precheck(again, false) : un('unsettled');
      }
      if (R.state === 'unknown') return un('unknown-state');
      if (R.prunedAt !== undefined) return un('pruned');
      if (this.deps.isSessionRunning(R.sessionId)) return un('run-active');
      const scope = { root: this.deps.paths.root, sessionId: R.sessionId, workspace: this.deps.paths.workspaceOf(R.sessionId) };
      if (dataGate(R.path, scope, 'write', this.deps.path).verdict === 'deny') return un('rule-blocked');
      return this.precheckFile(R);
    } catch (e) {
      this.warn('文件检查点：预检出错（按读不了处理，没有改动文件）:', e);
      return conflict('unreadable');
    }
  }

  /** 预检里看文件的那一段。路径解析、lstat 抛出「不存在」以外的错（盘不在线、祖先目录没有权限）按 unreadable。 */
  private precheckFile(R: CheckpointRow): Pre {
    const io = this.io;
    let cur: string;
    try {
      // cur 是目标此刻的真实路径（文件在时是磁盘上现在的大小写）。之后所有 IO 都对它做，不对记录里的旧路径：
      // 用户把 File.TXT 改名成 file.txt 之后，拿旧路径当改名的目标串会把文件名改回去
      cur = realPathOf(R.path, this.deps.path);
      if (pathKeyOf(R.requestedPath, this.deps.path) !== R.pathKey || pathKeyOf(cur, this.deps.path) !== R.pathKey) return conflict('identity-changed');
    } catch { return conflict('unreadable'); }
    const later = this.store.laterOnPath(R.pathKey, R.seq).filter(l => l.state === 'applied' || l.state === 'pending' || l.state === 'unknown');
    if (later.length > 0) return conflict('superseded', later.map(l => ({ id: l.id, sessionId: l.sessionId })));
    let st: ReturnType<FileIo['lstat']>;
    try { st = io.lstat(cur); } catch { return conflict('unreadable'); }
    if (st === undefined) return conflict('missing');
    if (st.kind !== 'file') return conflict('not-a-file');
    if (Number(st.sig.size) !== R.after.size) return conflict('modified');
    let read: { bytes: Buffer; sig: FileSig; hash: string };
    try { const r = io.readStable(cur); read = { bytes: r.bytes, sig: r.sig, hash: sha256Hex(r.bytes) }; }
    catch { return conflict('unreadable'); }
    if (read.hash !== R.after.hash) return conflict('modified');
    const expected = this.expectedFileId(R);
    const actual = fileIdOf(read.sig);
    if (expected && actual && (expected.dev !== actual.dev || expected.ino !== actual.ino)) return conflict('replaced');
    if (read.sig.nlink > 1) {
      // 新建文件时「硬链接成功、删临时文件失败」会让目标带着两个链接留下：先补删记录在案的残留再判。
      // 删硬链接的另一个名字不改内容、大小与修改时间，read.sig 仍然可用
      this.store.releaseTemps(R.pathKey);
      let again: ReturnType<FileIo['lstat']>;
      try { again = io.lstat(cur); } catch { return conflict('unreadable'); }
      if (again === undefined || again.sig.nlink > 1) return conflict('hard-linked');
    }
    // 必须显式查：Windows 上 unlink 能删掉只读文件，改名本身拦不住
    if (!io.writable(cur)) return conflict('read-only');
    if (R.before.exists && (R.before.hash === undefined || !this.store.hasBlob(R.before.hash))) return un('blob-missing');
    return { verdict: { kind: 'ready', action: R.before.exists ? 'overwrite' : 'delete' }, cur, read };
  }

  /** 校验 ids：去重、不超过上限、都属于这个会话。否则整次调用报错，零改动。 */
  private rowsOf(sessionId: string, ids: readonly string[]): CheckpointRow[] {
    const uniq = [...new Set(ids)];
    if (uniq.length > CHECKPOINT_RESTORE_MAX_ITEMS) throw new Error(`一次最多处理 ${CHECKPOINT_RESTORE_MAX_ITEMS} 条检查点`);
    return uniq.map(id => {
      const r = this.store.get(id);
      if (!r || r.sessionId !== sessionId) throw new Error('检查点不存在');
      return r;
    });
  }

  inspect(sessionId: string, ids: readonly string[]): RestorePrecheck[] {
    this.assertSessionLive(sessionId);
    return this.rowsOf(sessionId, ids).map(r => {
      const p = this.precheck(r);
      return { id: r.id, path: p.cur ?? r.path, verdict: p.verdict, message: describeVerdict(p.verdict, sessionId) };
    });
  }

  // ---------- 恢复 ----------

  private itemOf(R: CheckpointRow, p: Pre, sessionId: string): RestoreItemResult {
    return {
      id: R.id, path: p.cur ?? R.path, outcome: p.verdict.kind === 'conflict' ? 'conflict' : 'unavailable',
      verdict: p.verdict, message: describeVerdict(p.verdict, sessionId),
    };
  }

  /** 锁内恢复一项。同步。调用方已持有这条路径的写锁。 */
  private restoreOne(id: string, sessionId: string): RestoreItemResult {
    const io = this.io;
    const R = this.store.get(id);
    if (!R) return { id, path: '', outcome: 'failed', message: '检查点已不存在，没有恢复。' };
    // 完整重判，以这一次为准：等锁期间变成就绪或变成不就绪的，都按现在算
    const p = this.precheck(R);
    if (p.verdict.kind !== 'ready' || p.cur === undefined || p.read === undefined) return this.itemOf(R, p, sessionId);
    const cur = p.cur; const read = p.read;
    const overwriteAction = p.verdict.action === 'overwrite';
    const tmp = overwriteAction ? tmpPathFor(cur) : undefined;
    const failed = (message: string): RestoreItemResult => ({ id: R.id, path: cur, outcome: 'failed', message });

    // 先存当前字节（算过哈希的那一份）并标「恢复中」，持久提交：恢复本身不丢东西，用户反悔可以另存
    try { this.store.beginRestore(R.id, { afterBytes: read.bytes, tmpPath: tmp }); }
    catch (e) { return failed(`没能先保存当前内容，没有恢复（${errText(e)}）。文件没有改动。`); }
    io.at?.('restore-after-mark', { path: cur, tmp });

    let bytes: Buffer = Buffer.alloc(0);
    if (tmp !== undefined) {
      try { bytes = this.store.readBlob(R.before.hash ?? ''); }
      catch (e) {
        if (!(e instanceof CheckpointError) || e.info.blob === undefined) throw e;
        this.store.cancelRestore(R.id);
        const verdict: RestoreVerdict = { kind: 'unavailable', reason: e.info.blob === 'missing' ? 'blob-missing' : 'blob-corrupt' };
        return { id: R.id, path: cur, outcome: 'unavailable', verdict, message: describeVerdict(verdict, sessionId) };
      }
      try { io.writeDurable(tmp, bytes, R.beforeMode); }
      catch (e) {
        removeQuiet(io, tmp);
        this.store.cancelRestore(R.id);
        return failed(`恢复时出错：${errText(e)}。文件没有改动。`);
      }
      io.at?.('restore-after-tmp', { path: cur, tmp });
    }

    // 动手前复核：比的是算哈希那一次读的签名，「读完之后、动手之前」的任何改动都会被发现
    const now = io.lstat(cur);
    if (now === undefined || now.kind !== 'file' || !sameSig(now.sig, read.sig)) {
      if (tmp !== undefined) removeQuiet(io, tmp);
      this.store.cancelRestore(R.id);
      return this.itemOf(R, { verdict: { kind: 'conflict', reason: 'modified' }, cur }, sessionId);
    }

    try {
      io.at?.('restore-before-replace', { path: cur, tmp });
      if (tmp !== undefined) {
        // 改名因目标正被别的句柄开着而失败时原地覆盖：此时写入后的内容已由 beginRestore 存下
        const how = replaceExisting(io, { tmp, target: cur, bytes, expect: read.sig, allowInPlace: true, inPlacePoint: 'restore-before-inplace' });
        if (how === 'in-place' && sha256Hex(io.readStable(cur).bytes) !== R.before.hash) throw new Error('原地覆盖之后重读，内容与改动前的不一致');
      } else {
        io.unlink(cur);
      }
      io.at?.('restore-after-replace', { path: cur, tmp });
    } catch (e) {
      if (tmp !== undefined) removeQuiet(io, tmp);
      if (e instanceof TargetChangedError) {
        this.store.cancelRestore(R.id);
        return this.itemOf(R, { verdict: { kind: 'conflict', reason: 'modified' }, cur }, sessionId);
      }
      // 失败之后为了定结论再读一次当前文件，按实际内容说话，不猜
      let seen: 'missing' | 'unknown' | string = 'unknown';
      try {
        const st = io.lstat(cur);
        if (st === undefined) seen = 'missing';
        else if (st.kind === 'file') seen = sha256Hex(io.readStable(cur).bytes);
      } catch { seen = 'unknown'; }
      if (seen === R.after.hash) {
        this.store.cancelRestore(R.id);
        return failed(`恢复失败：${errText(e)}。文件没有改动。${process.platform === 'win32' && isBusyCode(errCode(e)) ? '可能正被其它程序打开。' : ''}`);
      }
      const done = tmp !== undefined ? seen === R.before.hash : seen === 'missing';
      if (!done) {
        this.store.markUnknown(R.id, `恢复被打断：文件既不是改动前的内容、也不是这次写入的内容（${errCode(e) ?? errText(e)}）`);
        return failed(`恢复失败：${errText(e)}。没能确认文件当前的状态；写入前和写入后的内容都已保存，可在「改动」里另存。`);
      }
      // 已经是改动前的样子（后续步骤抛错）：按成功往下走
    }

    let fileId: FileId | undefined;
    try { const st = io.lstat(cur); if (st) fileId = fileIdOf(st.sig); } catch { /* 取不到文件 ID：以后跳过那一条比对 */ }
    // 写库失败只告警：文件已恢复，行留在「恢复中」由对账落成 restored
    try { this.store.finishRestore(R.id, { path: cur, fileId: tmp !== undefined ? fileId : undefined }); }
    catch (e) { this.warn('文件检查点：恢复完成的记录写入失败（由对账收口）:', e); }
    return tmp !== undefined
      ? { id: R.id, path: cur, outcome: 'restored', message: '已恢复到这次改动之前的内容。恢复前的内容已存进检查点，可以另存。' }
      : { id: R.id, path: cur, outcome: 'deleted', message: '已删除这次改动新建的文件。删除前的内容已存进检查点，可以另存。' };
  }

  /** 只在等锁处 await。拿到的锁一定在 finally 里放掉；审计失败不改变逐项结果，也不让调用报错。 */
  async restore(sessionId: string, ids: readonly string[]): Promise<RestoreReport> {
    this.assertSessionLive(sessionId);
    const rows = this.rowsOf(sessionId, ids);
    // 无锁预检。它的结论只有两个用途：决定哪些项要取锁；给没取锁的项当最终结果
    const results = new Map<string, RestoreItemResult>();
    for (const r of rows) results.set(r.id, this.itemOf(r, this.precheck(r), sessionId));

    // 取锁范围按记录层面定、不看文件层面的结论：等锁期间用户把内容改回去、去掉只读、别的窗口恢复了后续改动，
    // 都会让一个本来不就绪的项在锁内重判时变成就绪；它若不在锁的范围内，就会在没持有该路径写锁的情况下被替换
    const claims = new Map<string, LockClaim>();
    const claimed = new Set<string>();
    for (const r0 of rows) {
      const R = this.store.get(r0.id);
      if (!R || R.state !== 'applied' || R.restoringAt !== undefined || R.prunedAt !== undefined) continue;
      if (this.deps.isSessionRunning(R.sessionId) || this.deps.isSessionDeleted(R.sessionId)) continue;
      try {
        const scope = { root: this.deps.paths.root, sessionId: R.sessionId, workspace: this.deps.paths.workspaceOf(R.sessionId) };
        if (dataGate(R.path, scope, 'write', this.deps.path).verdict === 'deny') continue;
        const id = pathIdentity(R.path, this.deps.path);
        // 身份已变的项不取锁：它的结论就是无锁预检给的 identity-changed
        if (id.root + id.segs.join('/') !== R.pathKey) continue;
        claims.set(R.pathKey, { ns: 'path', root: id.root, segs: id.segs, mode: 'write', display: R.path });
        claimed.add(R.id);
      } catch { /* 路径解析不了：保留无锁结论 */ }
    }

    if (claimed.size > 0) {
      const waitMs = this.deps.lockWaitMs ?? CHECKPOINT_RESTORE_LOCK_WAIT_MS;
      const giveUp = new AbortController();
      const timer = setTimeout(() => giveUp.abort(), waitMs);
      timer.unref?.();
      // 一次取整组：没有死锁
      const lock = await this.deps.locks.acquire({ group: `restore:${sessionId}`, label: 'restore', claims: [...claims.values()], signal: giveUp.signal });
      if (!lock.ok) {
        clearTimeout(timer);
        const seconds = Math.max(1, Math.round(waitMs / 1000));
        for (const r of rows) {
          if (!claimed.has(r.id)) continue;
          results.set(r.id, { id: r.id, path: r.path, outcome: 'busy', message: `这个文件正被别的操作占用（已等待 ${seconds} 秒），没有恢复，文件没有改动。请稍后再试。` });
        }
      } else {
        try {
          // 锁内同步、按 seq 降序逐项（同一文件的多次改动从最新的开始），逐项之间没有 await
          for (const r of [...rows].sort((a, b) => b.seq - a.seq)) {
            if (!claimed.has(r.id)) continue;
            try { results.set(r.id, this.restoreOne(r.id, sessionId)); }
            catch (e) {
              // 意外抛错：该项失败，接着做下一项。若已标「恢复中」，行由对账按实际文件落定
              results.set(r.id, { id: r.id, path: r.path, outcome: 'failed', message: `恢复时出错：${errText(e)}。这一项的状态会在下次查看时按实际文件核实。` });
            }
          }
        } finally {
          clearTimeout(timer);
          lock.release();
        }
      }
    }

    const items = rows.map(r => results.get(r.id) as RestoreItemResult);
    try {
      this.deps.audit?.('checkpoint.restore', { ids: items.map(i => i.id), outcomes: items.map(i => ({ id: i.id, outcome: i.outcome, reason: i.verdict && i.verdict.kind !== 'ready' ? i.verdict.reason : undefined })) }, { sessionId });
    } catch (e) { this.warn('文件检查点：恢复的审计写入失败（逐项结果不受影响）:', e); }
    return { items, allRestored: items.length > 0 && items.every(i => i.outcome === 'restored' || i.outcome === 'deleted') };
  }

  // ---------- 另存 ----------

  /** 把检查点里的一个版本另存成新文件。从不覆盖任何已有文件，不接受目标路径。 */
  saveCopy(sessionId: string, id: string, which: 'before' | 'after'): { path: string } {
    this.assertSessionLive(sessionId);
    const R = this.rowsOf(sessionId, [id])[0];
    if (which === 'before' && !R.before.exists) throw new Error('这次是新建文件，没有改动前的版本');
    const hash = which === 'before' ? R.beforeBlob : R.afterBlob;
    if (hash === undefined) throw new Error('这个版本已不在检查点里');
    const bytes = this.store.readBlob(hash);
    // 原目录还在就放在原文件旁边，否则放进会话工作桶里的「恢复副本」
    let dir = nodePath.dirname(R.path);
    let st: ReturnType<FileIo['lstat']>;
    try { st = this.io.lstat(realPathOf(dir, this.deps.path)); } catch { st = undefined; }
    if (!st || st.kind !== 'dir') {
      dir = nodePath.join(this.deps.paths.sessionBucket(sessionId, 'workspace'), '恢复副本');
      this.io.mkdirp(dir);
    }
    const ext = nodePath.extname(R.path);
    const stem = nodePath.basename(R.path, ext);
    const d = new Date();
    const two = (n: number): string => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    const label = which === 'before' ? '改动前' : '改动后';
    const scope = { root: this.deps.paths.root, sessionId, workspace: this.deps.paths.workspaceOf(sessionId) };
    for (let n = 1; n <= 20; n++) {
      const target = nodePath.join(dir, `${stem}.${label}-${stamp}${n === 1 ? '' : `-${n}`}${ext}`);
      if (dataGate(target, scope, 'write', this.deps.path).verdict === 'deny') throw new Error('这个位置是 DeskMinis 的核心数据，不能把副本存到这里');
      try {
        // 'wx'：目标已存在即失败，换下一个名字
        this.io.writeDurable(target, bytes);
      } catch (e) {
        if (errCode(e) === 'EEXIST') continue;
        throw new Error(`另存失败：${errText(e)}`);
      }
      try { this.deps.audit?.('checkpoint.save-copy', { id: R.id, which, path: target }, { sessionId }); }
      catch (e) { this.warn('文件检查点：另存的审计写入失败:', e); }
      return { path: target };
    }
    throw new Error('另存失败：同名的副本太多，请先整理目标目录');
  }

  // ---------- 对比 ----------

  private async side(bytes: Buffer, source: 'blob' | 'file', pathForExt: string): Promise<DiffSide> {
    const base: DiffSide = { exists: true, size: bytes.length, hash: sha256Hex(bytes), source, form: 'binary' };
    const ext = nodePath.extname(pathForExt).slice(1).toLowerCase();
    if (OFFICE_EXT.has(ext)) {
      if (bytes.length > CHECKPOINT_OFFICE_DIFF_MAX_BYTES) return base;
      // 只给提取出的文字，不是版式；解析失败按二进制
      try { return { ...base, form: 'office-text', ...clip(docToText(await parseOffice(pathForExt, bytes))) }; } catch { return base; }
    }
    if (bytes.subarray(0, 8192).includes(0)) return base;
    const head = bytes.length > CHECKPOINT_DIFF_TEXT_MAX_BYTES ? cutUtf8(bytes, CHECKPOINT_DIFF_TEXT_MAX_BYTES) : bytes;
    const text = decodeUtf8Exact(head);
    if (text === undefined) return base;
    return head.length < bytes.length ? { ...base, form: 'text', text, truncated: true } : { ...base, form: 'text', text };
  }

  /** 前后对比。before 取自检查点；after 在当前文件仍是这次写入的内容时取当前文件，否则看检查点里有没有这份内容
   *  （后一次改动的「写入前」，或恢复时存下的）；都没有就是 unavailable。行差分在界面算。Office 解析是异步的。 */
  async diff(sessionId: string, id: string): Promise<ChangeDiff> {
    this.assertSessionLive(sessionId);
    const R = this.rowsOf(sessionId, [id])[0];
    const gone = (v: { hash?: string; size?: number }): DiffSide => ({ exists: true, size: v.size, hash: v.hash, source: 'unavailable', form: 'none' });
    const none: DiffSide = { exists: false, source: 'none', form: 'none' };
    const blob = async (hash: string | undefined, v: { hash?: string; size?: number }): Promise<DiffSide> => {
      if (hash === undefined || !this.store.hasBlob(hash)) return gone(v);
      try { return await this.side(this.store.readBlob(hash), 'blob', R.path); } catch { return gone(v); }
    };
    const before = R.before.exists ? await blob(R.beforeBlob, R.before) : none;

    let current: DiffSide = none;
    let currentIs: ChangeDiff['currentIs'] = 'missing';
    let curBytes: Buffer | undefined;
    try {
      const cur = realPathOf(R.path, this.deps.path);
      const st = this.io.lstat(cur);
      if (st !== undefined) {
        currentIs = 'other';
        if (st.kind === 'file' && Number(st.sig.size) <= CHECKPOINT_MAX_FILE_BYTES) {
          curBytes = this.io.readStable(cur).bytes;
          current = await this.side(curBytes, 'file', R.path);
          if (current.hash === R.after.hash) currentIs = 'after';
          else if (R.before.exists && current.hash === R.before.hash) currentIs = 'before';
        } else {
          current = { exists: true, size: Number(st.sig.size), source: 'file', form: 'binary' };
        }
      }
    } catch {
      // 读不了当前文件：不给正文，照样返回两头的版本
      current = { exists: true, source: 'unavailable', form: 'none' };
      currentIs = 'other';
    }
    const after = currentIs === 'after' ? current : await blob(R.after.hash, R.after);
    return { change: this.view(R, this.workspaceId(sessionId)), before, after, current, currentIs };
  }
}

/** 从字节的前 max 个里退到一个完整的 UTF-8 字符边界。 */
function cutUtf8(bytes: Buffer, max: number): Buffer {
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

/** 提取出的文字超过正文上限时截断（按 UTF-16 码元估，不切断代理对）。 */
function clip(text: string): { text: string; truncated?: boolean } {
  if (text.length <= CHECKPOINT_DIFF_TEXT_MAX_BYTES) return { text };
  const code = text.charCodeAt(CHECKPOINT_DIFF_TEXT_MAX_BYTES - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? CHECKPOINT_DIFF_TEXT_MAX_BYTES - 1 : CHECKPOINT_DIFF_TEXT_MAX_BYTES;
  return { text: text.slice(0, end), truncated: true };
}
