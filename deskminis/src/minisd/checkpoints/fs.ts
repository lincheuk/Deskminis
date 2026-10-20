/**
 * F08：检查点用到的文件操作原语。写入事务（commit.ts）、恢复（restore.ts）与检查点存储（store.ts）对文件系统的
 * 每一次读写都经 FileIo 这一个接口——测试据此记录调用、按路径注入故障、在指定点从外面改文件。
 * 产品代码里没有任何崩溃钩子，只有 FileIo.at 这一个注入缝（生产的 nodeFileIo 没有它）。
 *
 * 忙重试、静默删除复用 F11A 的原语（sync/attachments/io.ts），不另写。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync, closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync,
  mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync, type BigIntStats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { removeFileQuiet, retryBusySync } from '../sync/attachments/io';
import type { FileId } from '../tools/types';

/** 注入点：只在测试里给。 */
export type IoPoint = 'after-prepare' | 'after-tmp' | 'before-replace' | 'before-inplace' | 'after-replace'
  | 'restore-after-mark' | 'restore-after-tmp' | 'restore-before-replace' | 'restore-before-inplace' | 'restore-after-replace';

/** 文件签名：dev / ino / size / mtimeNs 四项全等才算「还是读它时的那个文件、没被改过」。bigint 以十进制文本存。 */
export interface FileSig { dev: string; ino: string; size: string; mtimeNs: string; nlink: number; mode: number }

export interface FileIo {
  /** lstat（bigint）。不存在返回 undefined，其它错抛。 */
  lstat(p: string): { kind: 'file' | 'dir' | 'symlink' | 'other'; sig: FileSig } | undefined;
  /** open → fstat → 读满 → fstat → close；前后两次 fstat 不一致（读的过程中被改）抛 EBUSY。 */
  readStable(p: string): { bytes: Buffer; sig: FileSig };
  /** 'wx' 新建 + 写满 + fsync + 关；给了 mode 且非 win32 时 fchmod。目标已存在抛 EEXIST。
   *  建出来之后没写完整（盘满、IO 错）就把它删掉再抛：不留一个名字像成品、内容残缺的文件。 */
  writeDurable(p: string, data: Buffer, mode?: number): void;
  /** 改名覆盖。经 retryBusySync（共 4 次尝试、间隔 50 ms）。 */
  rename(from: string, to: string): void;
  /** 原地覆盖一个**已存在**的文件：open('r+')（文件不存在报 ENOENT，从不新建）→ 从 0 写满 → ftruncate 到 data.length → fsync → close。
   *  不是原子的。只由 replaceExisting 调（源码守卫钉着）。 */
  overwriteInPlace(p: string, data: Buffer): void;
  /** 不覆盖的发布：link(from, to) 再删 from；to 已存在抛 EEXIST；
   *  硬链接做不了（不论报的是哪个错误码）时确认 to 不存在再 rename，改名也做不成才把改名的错抛出去。
   *  删 from 删不掉不抛：这时 to 带着 nlink=2 留下，from 的路径还记在检查点行里，由对账与 releaseTemps 补删。 */
  linkExclusive(from: string, to: string): void;
  /** 经 retryBusySync。 */
  unlink(p: string): void;
  mkdirp(dir: string): void;
  /** accessSync(W_OK)。Windows 上只读文件为假（而 unlink 删得掉只读文件，所以恢复必须显式查）。 */
  writable(p: string): boolean;
  realpath(p: string): string;
  readdir(dir: string): string[];
  /** 尽力把目录项的变更刷到盘上（非 win32）。失败不抛。 */
  syncDir?(dir: string): void;
  at?(point: IoPoint, info: { path: string; tmp?: string }): void;
}

export function errCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

function sigOf(s: BigIntStats): FileSig {
  return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), nlink: Number(s.nlink), mode: Number(s.mode) & 0o7777 };
}

function writeAll(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) off += writeSync(fd, data, off, data.length - off, off);
}

/** 生产实现。没有 at。 */
export const nodeFileIo: FileIo = {
  lstat(p) {
    const s = lstatSync(p, { bigint: true, throwIfNoEntry: false });
    if (!s) return undefined;
    const kind = s.isFile() ? 'file' : s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'other';
    return { kind, sig: sigOf(s) };
  },
  readStable(p) {
    const fd = openSync(p, 'r');
    try {
      const a = fstatSync(fd, { bigint: true });
      const size = Number(a.size);
      const bytes = Buffer.allocUnsafe(size);
      let off = 0;
      while (off < size) {
        const n = readSync(fd, bytes, off, size - off, off);
        if (n === 0) break;
        off += n;
      }
      const b = fstatSync(fd, { bigint: true });
      // 读的过程中被别人改了（长度或修改时间变了，或没读满）：这份字节不是任何一个时刻的完整内容
      if (off !== size || a.size !== b.size || a.mtimeNs !== b.mtimeNs) {
        throw Object.assign(new Error(`EBUSY: 文件在读取期间发生了变化, read '${p}'`), { code: 'EBUSY' });
      }
      return { bytes, sig: sigOf(b) };
    } finally { closeSync(fd); }
  },
  writeDurable(p, data, mode) {
    const fd = openSync(p, 'wx', mode ?? 0o666);
    try {
      writeAll(fd, data);
      // umask 会削掉 open 时给的权限位：要保留原文件的权限位得再 fchmod 一次（Windows 上没有这回事）
      if (mode !== undefined && process.platform !== 'win32') fchmodSync(fd, mode);
      fsyncSync(fd);
    } catch (e) {
      // 'wx' 打开成功 = 这个文件是这一次建出来的（不会是别人的文件）：没写完整就删掉。
      // 另存的副本直接写到最终名字上，留下半截的话用户会把它当成完整的旧版本
      try { closeSync(fd); } catch { /* 已经在失败路径上：抛原来的错 */ }
      removeFileQuiet(p);
      throw e;
    }
    closeSync(fd);
  },
  rename(from, to) { retryBusySync(() => renameSync(from, to)); },
  overwriteInPlace(p, data) {
    const fd = openSync(p, 'r+');
    try {
      writeAll(fd, data);
      ftruncateSync(fd, data.length);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  },
  linkExclusive(from, to) {
    try {
      // 硬链接：目标已存在时以 EEXIST 失败，对别的进程也是原子的；renameSync 在 Windows 上会覆盖
      linkSync(from, to);
    } catch (e) {
      if (errCode(e) === 'EEXIST') throw e;
      // 硬链接做不了。不按错误码猜是不是「这个卷不支持硬链接」：各平台、各文件系统报的码不一样——
      // Windows 的 FAT32 报的是 EISDIR（ERROR_INVALID_FUNCTION 的映射），不在任何一张「不支持」的表里，
      // 按表判断的话这类卷（U 盘、SD 卡、移动硬盘）上一个新文件都建不出来，而以前的直接写入是能成的。
      // 所以除了「目标已存在」一律退回「确认不存在再改名」：真正的故障（临时文件不在、目录不可写）改名自己会再报出来。
      // 两句之间没有 await，本进程内不会交叉；对别的进程有极小的窗口
      if (lstatSync(to, { throwIfNoEntry: false })) throw Object.assign(new Error(`EEXIST: 目标已存在, link '${from}' -> '${to}'`), { code: 'EEXIST' });
      retryBusySync(() => renameSync(from, to));
      return;
    }
    removeFileQuiet(from);
  },
  unlink(p) { retryBusySync(() => unlinkSync(p)); },
  mkdirp(dir) { mkdirSync(dir, { recursive: true }); },
  writable(p) { try { accessSync(p, fsConstants.W_OK); return true; } catch { return false; } },
  realpath(p) { return realpathSync.native(p); },
  readdir(dir) { return readdirSync(dir); },
  syncDir(dir) {
    if (process.platform === 'win32') return;
    try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* 尽力而为 */ }
  },
};

export function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** 文件 ID（卷号 + 文件索引）。文件系统不提供时 ino 是 0：整体缺省，调用方跳过文件 ID 比对。 */
export function fileIdOf(sig: FileSig): FileId | undefined {
  return sig.ino === '0' ? undefined : { dev: sig.dev, ino: sig.ino };
}

export function sameSig(a: FileSig, b: FileSig): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** 放在用户目录里的临时文件名。固定形状：对账与 releaseTemps 只删库里记着、且名字匹配它的文件，从不按通配符扫用户目录。 */
export const TMP_NAME_RE = /^\.dm-[0-9a-f]{16}\.tmp$/;

/** 与目标同目录（改名才是原子的、也不会跨卷）。 */
export function tmpPathFor(real: string): string {
  return join(dirname(real), `.dm-${randomBytes(8).toString('hex')}.tmp`);
}

/** 删文件（经 io.unlink，测试注入得到）：不存在不算错；删不掉返回 false，不抛。 */
export function removeQuiet(io: FileIo, p: string): boolean {
  try { io.unlink(p); return true; } catch (e) { return errCode(e) === 'ENOENT'; }
}

/** 回落前复核时发现目标已不是 expect 那个签名。 */
export class TargetChangedError extends Error {
  constructor(path: string) { super(`目标在替换前被改动了: ${path}`); this.name = 'TargetChangedError'; }
}

/** 改名因「目标正被别的句柄开着」失败时报的错。Windows 上只要有任何句柄开着目标（只读、全共享也算），改名覆盖就一直失败。 */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
export function isBusyCode(code: string | undefined): boolean {
  return code !== undefined && BUSY.has(code);
}

/**
 * 把一个已存在的 target 换成 bytes（tmp 里已写好同样的字节）。写入事务与恢复共用这一个原语：
 *  1. io.rename(tmp, target)。成功 → 'renamed'。
 *  2. 抛的不是 EPERM / EBUSY / EACCES，或 allowInPlace 为假 → 原样外抛（tmp 由调用方删）。
 *  3. 回落：再 lstat(target)，不是普通文件或签名已不是 expect → 抛 TargetChangedError；
 *     io.at(inPlacePoint)；io.overwriteInPlace(target, bytes)；删 tmp → 'in-place'。
 * 不在这里判断结果：抛错时由调用方按实际文件定结论；'in-place' 时由调用方重读核对哈希。
 * allowInPlace 只在「覆盖这次改动的检查点已持久」时为真：原地覆盖不是原子的，写到一半出错会留下残缺文件，
 * 没有检查点兜底就是不可撤销的损坏。
 */
export function replaceExisting(io: FileIo, a: {
  tmp: string; target: string; bytes: Buffer; expect: FileSig; allowInPlace: boolean;
  inPlacePoint: 'before-inplace' | 'restore-before-inplace';
}): 'renamed' | 'in-place' {
  try {
    io.rename(a.tmp, a.target);
    return 'renamed';
  } catch (e) {
    if (!a.allowInPlace || !isBusyCode(errCode(e))) throw e;
  }
  const cur = io.lstat(a.target);
  if (!cur || cur.kind !== 'file' || !sameSig(cur.sig, a.expect)) throw new TargetChangedError(a.target);
  io.at?.(a.inPlacePoint, { path: a.target, tmp: a.tmp });
  io.overwriteInPlace(a.target, a.bytes);
  removeQuiet(io, a.tmp);
  return 'in-place';
}
