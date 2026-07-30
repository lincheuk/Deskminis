import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { MinisPaths } from './paths';

/** files.read 预览上限（超出截断并置 truncated）。 */
const MAX_PREVIEW = 256 * 1024;
/** 二进制嗅探窗口：前 8KB 含 NUL 即视为不可预览。 */
const SNIFF_BYTES = 8192;

export interface FileNode {
  name: string;          // 条目名（不含路径）
  path: string;          // 工作区相对路径，POSIX 分隔（'sub/b.txt'；根层条目为 'a.txt'）
  kind: 'dir' | 'file';
  size: number;          // 字节；目录为 0
  mtime: number;         // epoch 秒（浮点，全局约束）
}

export interface FilePreview {
  path: string;          // 工作区相对 POSIX 路径
  size: number;          // 完整文件字节数（截断时也回全量大小，供 UI 展示）
  content: string;       // 文本内容（可能只含前缀）；二进制时为空串
  truncated: boolean;    // 因超过 256KB 只读了前缀
  binary: boolean;       // 嗅探为二进制：不可预览
}

/** 归一化后的包含判断（与 tools/files.ts 的 isInsideRoot 同策略：防 <root>\..\.. 前缀欺骗）。 */
function isInside(abs: string, base: string): boolean {
  const rel = relative(resolve(base), resolve(abs));
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

export class FilesService {
  constructor(private paths: MinisPaths) {}

  /**
   * 把 UI 给的目录/文件引用解析为「工作区内」绝对路径。
   * resolveGuestPath 对绝对宿主路径（C:\...）与全局命名空间（/var/minis/memory）是放行的——
   * 那是 agent 工具 + 权限网关的领域；文件面板是工作区树，必须额外收死在仓内（计划决策 4）。
   */
  private resolveInWorkspace(sessionId: string, ref?: string): { abs: string; rel: string } {
    const base = this.paths.sessionBucket(sessionId, 'workspace');
    const abs = this.paths.resolveGuestPath(sessionId, ref ?? '/var/minis/workspace');
    if (!isInside(abs, base)) throw new Error(`文件面板只允许访问会话工作区: ${ref ?? '/'}`);
    const rel = relative(base, abs).split('\\').join('/');
    return { abs, rel };
  }

  /** 列目录一层（懒加载树的单步）。dir 省略 = 工作区根。目录在前、按名称排序。 */
  list(sessionId: string, dir?: string): FileNode[] {
    this.paths.ensureSessionDirs(sessionId);
    const { abs, rel } = this.resolveInWorkspace(sessionId, dir);
    const st = statSync(abs); // ENOENT 原样抛给 RPC 层，前端显示「路径不存在」
    if (!st.isDirectory()) throw new Error(`不是目录: ${rel || '/'}`);
    const entries = readdirSync(abs, { withFileTypes: true });
    const nodes: FileNode[] = entries.map(e => {
      const isDir = e.isDirectory();
      let size = 0; let mtime = 0;
      try {
        const cs = statSync(resolve(abs, e.name));
        size = isDir ? 0 : cs.size;
        mtime = cs.mtimeMs / 1000;
      } catch { /* 列目录瞬间被删的条目：按 0 返回，不让整层失败 */ }
      return { name: e.name, path: rel ? `${rel}/${e.name}` : e.name, kind: isDir ? 'dir' as const : 'file' as const, size, mtime };
    });
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return nodes;
  }

  /** 读文本预览：只读前 256KB+1 字节（不整文件入内存）；嗅探含 NUL 视为二进制不返回内容。 */
  read(sessionId: string, path: string): FilePreview {
    this.paths.ensureSessionDirs(sessionId);
    const { abs, rel } = this.resolveInWorkspace(sessionId, path);
    const st = statSync(abs);
    if (st.isDirectory()) throw new Error(`不能预览目录: ${rel}`);
    const fd = openSync(abs, 'r');
    let buf: Buffer;
    try {
      const head = Buffer.alloc(Math.min(st.size, MAX_PREVIEW + 1));
      const n = readSync(fd, head, 0, head.length, 0);
      buf = head.subarray(0, n);
    } finally { closeSync(fd); }
    const sniffLen = Math.min(buf.length, SNIFF_BYTES);
    for (let i = 0; i < sniffLen; i++) {
      if (buf[i] === 0) return { path: rel, size: st.size, content: '', truncated: false, binary: true };
    }
    const truncated = st.size > MAX_PREVIEW;
    const content = buf.subarray(0, truncated ? MAX_PREVIEW : buf.length).toString('utf8');
    return { path: rel, size: st.size, content, truncated, binary: false };
  }
}
