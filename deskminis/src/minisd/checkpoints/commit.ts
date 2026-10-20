/**
 * F08：内置文件 / Office 写入的唯一落盘入口。
 *
 * 以前三个写工具都是原地 writeFileSync：改动前的内容没有任何地方留着，中途崩溃留半截文件。这里把一次写入做成一段
 * **同步**的事务：读原始字节 → 生成新字节 → 写前检查点（原字节与一条 pending 记录先持久）→ 同目录临时文件加改名的
 * 原子替换 → 记下结果。从读原文件到替换完成之间没有 await：别的 RPC、取消、恢复都插不进来。
 *
 * 硬规则：
 *  - 检查点没保存成，就不碰目标文件（连父目录都不建）。没有检查点的覆盖无法撤销。
 *  - 替换前复核「目标还是读它时的那个文件」；对不上就不写，不盖掉别人的修改。
 *  - 改名因目标正被别的句柄开着而失败时，只在检查点已持久的前提下退到原地覆盖，并重读核对；对不上记 unknown。
 *  - 失败时按实际文件定结论，不猜：确认未动才说「文件没有改动」。
 *
 * 调用位置固定：过了权限闸（guardWrite）、闸后复查过取消之后。检查点保存与任何目标文件 IO 都在放行之后——
 * 审批最长等 90 秒，在审批前读原文件的话，期间用户的手改会被盖掉而检查点里是更旧的版本。
 */
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { CHECKPOINT_MAX_FILE_BYTES, type FileVersion } from '../../shared/checkpoint';
import { pathKeyOf, realPathOf, type DataGateOptions } from '../tools/data-gate';
import type { PreparedCheckpoint, ToolContext } from '../tools/types';
import {
  errCode, fileIdOf, isBusyCode, nodeFileIo, removeQuiet, replaceExisting, sameSig, sha256Hex, tmpPathFor, TargetChangedError,
  type FileIo, type FileSig,
} from './fs';

export type FileBefore =
  | { exists: false }
  | { exists: true; bytes: Buffer; hash: string; size: number };

export interface FileWritePlan {
  /** 宿主绝对路径：就是工具给 guardWrite 与 scheduling.resources 的那个值。 */
  path: string;
  /** 给出要写入的全部字节。before 是替换前读到的原始字节。同步。
   *  返回 { abort } = 不写，message 原样给模型；抛错原样外抛（由 registry.run 兜成「工具执行异常」）。 */
  produce(before: FileBefore): Buffer | { abort: string };
  /** 文件不存在时原样抛出读文件的错（file_edit 用：保持现有的 ENOENT 文案）。 */
  requireExisting?: boolean;
  /** 新建文件时是否自动建父目录。缺省 true。 */
  createParents?: boolean;
  /** 调用方是基于哪个版本算出新内容的（sha256；null = 基于「不存在」）。给了而当前文件不是这个版本 → 不写、报冲突。
   *  要异步解析原文件的调用方用：先自己读并解析，算好新字节，再带着 basedOn 进来。 */
  basedOn?: string | null;
}

export type FileCommitStage = 'cancelled' | 'unsupported' | 'out-of-claims' | 'produce' | 'checkpoint' | 'conflict' | 'write';
export type FileCommitResult =
  | { ok: true; path: string; created: boolean; unchanged: boolean; checkpointId?: string; before: FileVersion; after: FileVersion }
  | { ok: false; stage: FileCommitStage; message: string; fileUntouched: boolean };

export interface FileCommitDeps { io?: FileIo; path?: DataGateOptions; warn?(msg: string, e?: unknown): void }

/** 检查点没保存成。code：quota 空间用满；too-large 超过单文件上限；io 内容文件写不成或不在；db 记录提交不了；unavailable 存储不可用。 */
export class CheckpointError extends Error {
  constructor(
    readonly code: 'quota' | 'too-large' | 'io' | 'db' | 'unavailable', message: string,
    /** limitBytes：too-large 时的单文件上限、quota 时的总上限。blob：readBlob 分清内容文件是不在还是校验不符。 */
    readonly info: { limitBytes?: number; sizeBytes?: number; blob?: 'missing' | 'corrupt' } = {},
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}

const MIB = 1024 * 1024;
/** 字节数的人话：不到 1 GB 用 MB（至少 1 位小数以内的整数），否则用 GB。 */
function sizeText(bytes: number): string {
  if (bytes >= 1024 * MIB) return `${(bytes / (1024 * MIB)).toFixed(bytes % (1024 * MIB) === 0 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / MIB))} MB`;
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const fail = (stage: FileCommitStage, message: string, fileUntouched: boolean): FileCommitResult => ({ ok: false, stage, message, fileUntouched });

const TEXT = {
  tooLarge: (abs: string, size: number, limit: number): string =>
    `没有写入 ${abs}：这个文件有 ${sizeText(size)}，超过可保存检查点的上限（${sizeText(limit)}）。没有检查点的覆盖无法撤销，所以没有执行，文件没有改动。`,
  quota: (abs: string, quota: number | undefined): string =>
    `没有写入 ${abs}：文件检查点的空间已用满${quota !== undefined ? `（上限 ${sizeText(quota)}）` : ''}，写入前的内容保存不下来。没有检查点的覆盖无法撤销，所以没有执行，文件没有改动。请告诉用户在「改动」页调大检查点上限。`,
  checkpointFailed: (abs: string, why: string): string =>
    `没有写入 ${abs}：写入前的检查点没能保存（${why}）。没有检查点的覆盖无法撤销，所以没有执行，文件没有改动，可以稍后重试。`,
  readOnly: (abs: string): string => `没有写入 ${abs}：文件是只读的。文件没有改动。`,
  hardLinked: (abs: string, n: number): string => `没有写入 ${abs}：这个文件有 ${n} 个硬链接，替换会把链接拆开，文件工具不支持。文件没有改动。`,
  notAFile: (abs: string): string => `没有写入 ${abs}：目标不是普通文件（是目录、失效的链接或设备）。`,
  badName: (abs: string): string => `没有写入 ${abs}：路径里带 NTFS 数据流写法（冒号），或文件名以点、空格结尾，文件工具不支持。`,
  outOfClaims: (abs: string): string => `没有写入 ${abs}：这个路径的指向在等待期间变了，已不在本次调用排队时的范围内。文件没有改动，可以重试。`,
  changed: (abs: string): string => `没有写入 ${abs}：准备写入期间这个文件被别的程序改动了。为了不盖掉那次改动，本次没有执行；请重新读取文件后再决定怎么改。`,
  writeFailedUntouched: (e: unknown, win: boolean): string =>
    `写入失败：${errText(e)}。文件没有改动。${win && isBusyCode(errCode(e)) ? '可能正被其它程序打开。' : ''}`,
  writeFailedUnknown: (e: unknown, saved: boolean): string =>
    `写入失败：${errText(e)}。没能确认文件当前的状态；${saved ? '写入前的内容已保存，可在「改动」里另存。' : ''}请先查看文件再继续。`,
};

/** win32：盘符（或 UNC 根）之后任一段带冒号（NTFS 数据流写法），或末段以点、空格结尾（Win32 API 会把它当成另一个名字的同一个文件）。
 *  按词法拒绝，放在取真实路径之前：realpath 对 'a.txt.' 报 ENOENT，会被当成「新建文件」。 */
function badWin32Name(abs: string): boolean {
  const P = nodePath.win32;
  const segs = abs.slice(P.parse(abs).root.length).split(/[\\/]/).filter(s => s !== '');
  if (segs.some(s => s.includes(':'))) return true;
  const last = segs[segs.length - 1];
  return last !== undefined && /[. ]$/.test(last);
}

const versionOf = (b: FileBefore): FileVersion => (b.exists ? { exists: true, hash: b.hash, size: b.size } : { exists: false });

/**
 * 内置文件 / Office 写入的唯一落盘入口。同步：从读原文件到替换完成之间没有 await。
 * 替换已有文件先走改名；改名因占用失败且检查点已持久时原地覆盖并重读核对。调用方看不出走的是哪条路。
 * 调用位置固定：过了 guardWrite、闸后复查过取消之后。从不抛（produce 与 requireExisting 的错除外）。
 * 失败时 message 是可以直接给模型的一句话；fileUntouched=true 表示已确认目标文件没有变化。
 */
export function commitFileWrite(
  ctx: Pick<ToolContext, 'sessionId' | 'signal' | 'call' | 'checkpoints'>, plan: FileWritePlan, deps: FileCommitDeps = {},
): FileCommitResult {
  // 文件操作与路径选项：显式给的优先，其次是检查点保存方的那一套（与存储共用），都没有就是生产实现
  const io = deps.io ?? ctx.checkpoints?.io ?? nodeFileIo;
  const pathOpts = deps.path ?? ctx.checkpoints?.pathOptions;
  const warn = deps.warn ?? ((msg: string, e?: unknown): void => { console.warn(msg, e); });
  const abs = plan.path;
  const win = (pathOpts?.platform ?? process.platform) === 'win32';

  // 1. 取消只可能发生在进入之前或返回之后：下面是同步段，取消信号翻不了
  if (ctx.signal?.aborted) return fail('cancelled', '[已取消]', true);
  // 2. 不支持的写法
  if (win && badWin32Name(abs)) return fail('unsupported', TEXT.badName(abs), true);
  // 3. 路径必须仍在本次调用持有的写锁之内（审批等待期间链接被改指向）
  if (ctx.call?.covers && !ctx.call.covers(abs)) return fail('out-of-claims', TEXT.outOfClaims(abs), true);
  // 4. 带着执行身份却没有检查点保存方 = 接线漏了：宁可拒绝，也不静默地做没有检查点的覆盖
  if (ctx.call?.executionId !== undefined && !ctx.checkpoints) {
    return fail('checkpoint', TEXT.checkpointFailed(abs, '检查点存储没有接入'), true);
  }

  // 5. 写入前的状态
  let real: string; let key: string;
  let before: FileBefore = { exists: false };
  let sig0: FileSig | undefined;
  try {
    real = realPathOf(abs, pathOpts);
    key = pathKeyOf(abs, pathOpts);
    let st = io.lstat(real);
    if (st && st.kind !== 'file') return fail('unsupported', TEXT.notAFile(abs), true);
    if (st && st.sig.nlink > 1) {
      // 新建文件时「硬链接成功、删临时文件失败」会让目标带着两个链接留下：先把记录在案的残留删掉再判
      ctx.checkpoints?.releaseTemps(key);
      st = io.lstat(real);
      if (!st || st.kind !== 'file') return fail('conflict', TEXT.changed(abs), true);
      if (st.sig.nlink > 1) return fail('unsupported', TEXT.hardLinked(abs, st.sig.nlink), true);
    }
    if (st) {
      const size = Number(st.sig.size);
      if (ctx.checkpoints && size > CHECKPOINT_MAX_FILE_BYTES) return fail('checkpoint', TEXT.tooLarge(abs, size, CHECKPOINT_MAX_FILE_BYTES), true);
      if (!io.writable(real)) return fail('write', TEXT.readOnly(abs), true);
      const read = io.readStable(real);
      sig0 = read.sig;
      before = { exists: true, bytes: read.bytes, hash: sha256Hex(read.bytes), size: read.bytes.length };
    }
  } catch (e) {
    // 路径解析、lstat、读原文件失败（被独占打开、盘不在线）：还什么都没动
    return fail('write', TEXT.writeFailedUntouched(e, win), true);
  }
  if (!before.exists && plan.requireExisting) {
    // 对工具给的路径读（不对真实路径）：ENOENT 文案里的路径与以前逐字相同。抛错原样外抛
    readFileSync(abs);
    // 没抛：这一瞬间文件冒了出来
    return fail('conflict', TEXT.changed(abs), true);
  }

  // 6. 调用方基于的版本必须就是现在这个
  if (plan.basedOn !== undefined && (before.exists ? before.hash : null) !== plan.basedOn) return fail('conflict', TEXT.changed(abs), true);

  // 7. 新内容（抛错原样外抛）
  const out = plan.produce(before);
  if (!Buffer.isBuffer(out)) return fail('produce', out.abort, true);
  const afterHash = sha256Hex(out);
  const after: FileVersion = { exists: true, hash: afterHash, size: out.length };

  // 8. 内容相同：不替换、不建记录、修改时间不变
  if (before.exists && afterHash === before.hash) {
    return { ok: true, path: real, created: false, unchanged: true, before: versionOf(before), after };
  }

  // 9. 写前检查点：提交不了就不碰目标
  const tmp = tmpPathFor(real);
  let cp: PreparedCheckpoint | undefined;
  if (ctx.checkpoints) {
    try {
      cp = ctx.checkpoints.prepare({
        sessionId: ctx.sessionId, call: ctx.call, requestedPath: abs, path: real, pathKey: key,
        before: before.exists && sig0 ? { bytes: before.bytes, hash: before.hash, mode: sig0.mode } : undefined,
        afterHash, afterSize: out.length, tmpPath: tmp,
      });
    } catch (e) {
      if (e instanceof CheckpointError) {
        if (e.code === 'too-large') return fail('checkpoint', TEXT.tooLarge(abs, e.info.sizeBytes ?? (before.exists ? before.size : 0), e.info.limitBytes ?? CHECKPOINT_MAX_FILE_BYTES), true);
        if (e.code === 'quota') return fail('checkpoint', TEXT.quota(abs, e.info.limitBytes), true);
      }
      return fail('checkpoint', TEXT.checkpointFailed(abs, errText(e)), true);
    }
  }
  /** 记录的状态更新失败不改变结论：行留在 pending，由对账按实际文件收口。 */
  const mark = (fn: (c: PreparedCheckpoint) => void): void => {
    if (!cp) return;
    try { fn(cp); } catch (e) { warn('文件检查点：记录状态写入失败（由对账收口）:', e); }
  };

  // 10–11. 父目录、临时文件
  try {
    io.at?.('after-prepare', { path: real, tmp });
    if (!before.exists && plan.createParents !== false) io.mkdirp(nodePath.dirname(real));
    io.writeDurable(tmp, out, sig0?.mode);
    io.at?.('after-tmp', { path: real, tmp });
  } catch (e) {
    removeQuiet(io, tmp);
    mark(c => c.aborted('write-failed', errCode(e)));
    return fail('write', TEXT.writeFailedUntouched(e, win), true);
  }

  // 12. 替换前复核：目标必须还是读它时的那个文件（原先不存在的必须仍不存在）
  try {
    const now = io.lstat(real);
    const same = sig0 ? (now !== undefined && now.kind === 'file' && sameSig(now.sig, sig0)) : now === undefined;
    if (!same) {
      removeQuiet(io, tmp);
      mark(c => c.aborted('changed-during-write'));
      return fail('conflict', TEXT.changed(abs), true);
    }
  } catch (e) {
    removeQuiet(io, tmp);
    mark(c => c.aborted('write-failed', errCode(e)));
    return fail('write', TEXT.writeFailedUntouched(e, win), true);
  }

  // 13. 替换
  let inPlace = false;
  try {
    io.at?.('before-replace', { path: real, tmp });
    if (sig0) {
      // allowInPlace 只在检查点已持久时为真：原地覆盖不是原子的，没有检查点兜底就是不可撤销的覆盖
      const how = replaceExisting(io, { tmp, target: real, bytes: out, expect: sig0, allowInPlace: cp !== undefined, inPlacePoint: 'before-inplace' });
      if (how === 'in-place') {
        inPlace = true;
        if (sha256Hex(io.readStable(real).bytes) !== afterHash) throw new Error('原地覆盖之后重读，内容与要写入的不一致');
      }
    } else {
      // 新建：目标已存在即失败，那一刻冒出来的同名文件不会被盖掉
      io.linkExclusive(tmp, real);
    }
    io.at?.('after-replace', { path: real, tmp });
  } catch (e) {
    removeQuiet(io, tmp);
    if (e instanceof TargetChangedError || (!sig0 && errCode(e) === 'EEXIST')) {
      mark(c => c.aborted('changed-during-write'));
      return fail('conflict', TEXT.changed(abs), true);
    }
    // 按实际文件定结论，不猜
    let landed = false; let untouched = false;
    try {
      const now = io.lstat(real);
      if (sig0 ? (now !== undefined && now.kind === 'file' && sameSig(now.sig, sig0)) : now === undefined) untouched = true;
      else if (now !== undefined && now.kind === 'file' && sha256Hex(io.readStable(real).bytes) === afterHash) landed = true;
    } catch { /* 读不了：按没能确认处理 */ }
    if (untouched) {
      mark(c => c.aborted('write-failed', errCode(e)));
      return fail('write', TEXT.writeFailedUntouched(e, win), true);
    }
    if (!landed) {
      mark(c => c.uncertain(`替换失败后文件既不是写入前的内容、也不是要写入的内容（${errCode(e) ?? errText(e)}）`));
      return fail('write', TEXT.writeFailedUnknown(e, cp !== undefined && before.exists), false);
    }
    // 替换其实成功了（后续步骤抛错）：按成功往下走。告诉模型「失败」会让它重做
  }

  // 14. 记下结果
  let fileId: ReturnType<typeof fileIdOf>;
  try { const st = io.lstat(real); if (st) fileId = fileIdOf(st.sig); } catch { /* 取不到文件 ID：恢复时跳过那一条比对 */ }
  let realAfter = real;
  try { realAfter = io.realpath(real); } catch { /* 取不到就用替换前解析出的 */ }
  try { io.syncDir?.(nodePath.dirname(real)); } catch { /* 尽力而为 */ }
  mark(c => c.applied({ path: realAfter, fileId, inPlace }));
  return { ok: true, path: realAfter, created: !before.exists, unchanged: false, checkpointId: cp?.id, before: versionOf(before), after };
}
