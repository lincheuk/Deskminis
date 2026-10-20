/**
 * F11A 附件同步的文件操作。可注入：index.ts 不传，测试用它做受控延迟与故障。
 *
 * VerifiedFile 只有 verify() 能造出来：它证明某个路径上的文件整文件 sha256 与长度都对。
 * 存储层的 publishVerified 只收这个类型——没有校验过的字节没有办法被放到最终名字上。
 */
import { createHash } from 'node:crypto';
import {
  createReadStream, constants as fsConstants, copyFile, linkSync, lstatSync, mkdirSync, renameSync, unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

declare const verifiedBrand: unique symbol;
/** 整文件校验过的文件。字段只读；品牌字段只存在于类型里。 */
export interface VerifiedFile { readonly path: string; readonly sha256: string; readonly size: number; readonly [verifiedBrand]: true }

export interface AttachmentIo {
  /** 流式读整个文件算 sha256；长度与哈希都相等才返回 VerifiedFile，否则 undefined。读失败也返回 undefined。 */
  verify(path: string, sha256: string, size: number): Promise<VerifiedFile | undefined>;
  /** 读不了（EBUSY、EACCES、中途被删）就 reject；调用方逐文件接住。 */
  hash(path: string): Promise<{ sha256: string; size: number }>;
  /** 复制到一个还不存在的目标（已存在即失败）。 */
  copy(src: string, dst: string): Promise<void>;
  /** 不覆盖的发布：硬链接到 final 再删 staged；final 已存在返回 'exists'。 */
  publish(staged: string, final: string): 'published' | 'exists';
}

/** 同步等一小会儿：删除、改名遇到杀毒软件或索引服务占用时的重试间隔。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

/** 文件被别的进程短暂占用（EBUSY / EPERM / EACCES）时同步重试 3 次、间隔 50 毫秒；其它错误当场抛。 */
export function retryBusySync<T>(fn: () => T): T {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      const code = errCode(e);
      if (i >= 3 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw e;
      sleepSync(50);
    }
  }
}

/** 删文件：不存在不算错；删不掉（占用重试之后仍不行）返回 false，不抛。 */
export function removeFileQuiet(path: string): boolean {
  try { retryBusySync(() => unlinkSync(path)); return true; } catch (e) { return errCode(e) === 'ENOENT'; }
}

function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let size = 0;
    // 64KB 一读：逐块让出事件循环，大文件不长时间占着
    const s = createReadStream(path, { highWaterMark: 64 * 1024 });
    s.on('data', (chunk: string | Buffer) => { const b = chunk as Buffer; size += b.length; h.update(b); });
    s.on('error', reject);
    s.on('end', () => resolve({ sha256: h.digest('hex'), size }));
  });
}

/** 硬链接不可用的文件系统（FAT、exFAT、部分网络盘）报的错。 */
const NO_HARDLINK = new Set(['EPERM', 'ENOSYS', 'EXDEV', 'ENOTSUP']);

/** 缺省实现。fsImpl 只给测试替换 linkSync（模拟不支持硬链接的文件系统）。 */
export function createAttachmentIo(fsImpl: { linkSync?: typeof linkSync } = {}): AttachmentIo {
  const link = fsImpl.linkSync ?? linkSync;
  return {
    async verify(path, sha256, size) {
      try {
        const h = await hashFile(path);
        if (h.sha256 !== sha256 || h.size !== size) return undefined;
        return { path, sha256, size } as VerifiedFile;
      } catch { return undefined; }
    },
    hash: hashFile,
    copy(src, dst) {
      return new Promise((resolve, reject) => {
        try { mkdirSync(dirname(dst), { recursive: true }); } catch (e) { reject(e); return; }
        copyFile(src, dst, fsConstants.COPYFILE_EXCL, err => { if (err) reject(err); else resolve(); });
      });
    },
    publish(staged, final) {
      try {
        // 硬链接：目标已存在时以 EEXIST 失败，对别的进程（agent 的 shell）也是原子的；renameSync 在 Windows 上会覆盖
        link(staged, final);
      } catch (e) {
        const code = errCode(e);
        if (code === 'EEXIST') return 'exists';
        if (code === undefined || !NO_HARDLINK.has(code)) throw e;
        // 退回「确认不存在再改名」：两句之间没有 await，本进程内不会交叉；对别的进程有极小的窗口
        try { lstatSync(final); return 'exists'; } catch (e2) { if (errCode(e2) !== 'ENOENT') throw e2; }
        retryBusySync(() => renameSync(staged, final));
        return 'published';
      }
      removeFileQuiet(staged);
      return 'published';
    },
  };
}
