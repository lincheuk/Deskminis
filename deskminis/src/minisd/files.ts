import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, sep, posix } from 'node:path';
import type { MinisPaths } from './paths';

export interface FileNode {
  /** 显示名（含后缀） */
  name: string;
  /** 相对于 workspace 根的 POSIX 路径（目录分隔符为 `/`）；根层条目即 `basename` */
  path: string;
  /** 文件 vs 目录 */
  kind: 'dir' | 'file';
  /** 字节大小；目录 size 固定为 0（递归计算代价太高且会让大目录卡顿） */
  size: number;
  /** mtime 为 epoch 秒（浮点） */
  mtime: number;
}

export interface FilePreview {
  /** 用户请求的 guest path（原样返回，便于 UI 标签） */
  path: string;
  /** 完整字节大小（content 被截断时 size 仍为原始大小） */
  size: number;
  /** utf8 前缀内容；二进制为空串；超限前缀为 256KB */
  content: string;
  /** content 与实际文件不等长（超过 256KB） */
  truncated: boolean;
  /** 内容含 NUL 字节或编码错误被判定为二进制，content 为空字符串 */
  binary: boolean;
}

/** 前缀读取上限（与计划一致：256KB） */
const PREVIEW_MAX_BYTES = 256 * 1024;

/** 工作区文件服务：目录在前按名排序；任何解析结果必须落在会话 workspace 内（绝对宿主路径/全局命名空间/穿越一律抛错）。 */
export class FilesService {
  constructor(private paths: MinisPaths) {}

  /** `dir` 省略 = 工作区根；`dir` 为相对 POSIX 路径，禁止穿越或全局命名空间引用。 */
  list(sessionId: string, dir?: string): FileNode[] {
    this.paths.ensureSessionDirs(sessionId);
    const workspaceRoot = this.paths.sessionBucket(sessionId, 'workspace');
    // 任何 dir（含空/undefined）经 resolveGuestPath 校验：绝对宿主路径/全局命名空间/穿越一律抛错；默认落到 workspace 根
    const guest = dir && dir !== '' ? dir : '';
    const absDir = guest === ''
      ? workspaceRoot
      : this.paths.resolveGuestPath(sessionId, guest);
    // absDir 必须仍在 workspaceRoot 之下（resolveGuestPath 已防穿越；再检查保证显式安全）
    if (absDir !== workspaceRoot && !absDir.startsWith(workspaceRoot + sep) && !absDir.startsWith(workspaceRoot + posix.sep)) {
      throw new Error(`files.list: dir 越出 workspace: ${dir ?? ''}`);
    }
    let names: string[];
    try { names = readdirSync(absDir); } catch { /* 不存在/非目录 -> 视为空（UI 友好） */ return []; }
    const nodes: FileNode[] = [];
    for (const n of names) {
      const abs = join(absDir, n);
      let st;
      try { st = statSync(abs); } catch { continue; }
      const relGuestAbs = guest === '' ? n : posixJoin(guest, n);
      // 再次把最终相对 guest path 喂 resolveGuestPath 得到 abs（双重校验：不能因为 dir 合法但目标出界而漏掉）
      const recheck = this.paths.resolveGuestPath(sessionId, relGuestAbs);
      if (recheck !== abs) throw new Error(`files.list: 路径不一致: ${relGuestAbs}`);
      nodes.push({
        name: n,
        path: relGuestAbs.split(sep).join(posix.sep), // 归一化为 POSIX 分隔
        kind: st.isDirectory() ? 'dir' : (st.isFile() ? 'file' : 'file'), // 其他类型（符号链接/设备）按 file 显示；符号链接由 statSync 跟随的行为与 read 一致
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtimeMs / 1000,
      });
    }
    // 目录在前 + 各自按 localeCompare 名升序（Windows/中文都稳定）
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  /** `path` 为 guest 路径（支持相对 /var/minis/*，但 /var/minis/attachments 等命名空间也经 resolveGuestPath——与 UI 的 workspace-only 策略一致：UI 传相对路径都会落到 workspace，不存在跨 bucket 混淆）。 */
  read(sessionId: string, path: string): FilePreview {
    if (typeof path !== 'string' || path.trim() === '') throw new Error('files.read 需要 path');
    this.paths.ensureSessionDirs(sessionId);
    const abs = this.paths.resolveGuestPath(sessionId, path);
    const workspaceRoot = this.paths.sessionBucket(sessionId, 'workspace');
    if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + sep) && !abs.startsWith(workspaceRoot + posix.sep)) {
      throw new Error(`files.read: path 越出 workspace: ${path}`);
    }
    let st;
    try { st = statSync(abs); } catch (e: any) {
      throw new Error(`文件不存在或不可读: ${basename(path)} (${e?.message ?? String(e)})`);
    }
    if (!st.isFile()) throw new Error(`不是文件: ${basename(path)}`);
    const size = st.size;
    // 读前 PREVIEW_MAX_BYTES（文件更大时只读前缀——content 被截断、binary 判定基于前缀即可；若前缀无 NUL 则当作文本显示，UI 侧显示「文件过大，仅预览前 256KB」）
    let buf: Buffer;
    try {
      const fd = require('node:fs').openSync(abs, 'r');
      try {
        const toRead = Math.min(size, PREVIEW_MAX_BYTES);
        buf = Buffer.alloc(toRead);
        let read = 0;
        while (read < toRead) {
          const got = require('node:fs').readSync(fd, buf, read, toRead - read, null);
          if (got <= 0) break;
          read += got;
        }
        if (read < buf.length) buf = buf.subarray(0, read);
      } finally { require('node:fs').closeSync(fd); }
    } catch (e: any) {
      throw new Error(`读取失败: ${basename(path)} (${e?.message ?? String(e)})`);
    }
    const truncated = size > PREVIEW_MAX_BYTES;
    // 二进制判定：NUL 字节（简单可靠——兼容 UTF-16 等极端情形由 UI 的 binary=true 空串兜底即可）
    const binary = buf.includes(0x00);
    let content = '';
    if (!binary) {
      try { content = buf.toString('utf8'); } catch { content = ''; }
      // UTF-8 解码后含 替代字符（大量）时判二进制（防止乱码渲染撑满面板）
      if (countReplacement(content) > Math.max(1, Math.floor(buf.length / 500))) {
        content = '';
      }
    }
    return { path, size, content, truncated, binary: binary || content === '' && buf.length > 0 };
  }
}

function countReplacement(s: string): number {
  let n = 0;
  for (const c of s) if (c === '\uFFFD') n++;
  return n;
}

/** 把可能含反斜杠的 guest 路径段拼接成 POSIX 风格（计划要求 path 为 POSIX 分隔）。 */
function posixJoin(a: string, b: string): string {
  const aN = a.replace(/\\/g, '/').replace(/\/+$/, '');
  const bN = b.replace(/\\/g, '/').replace(/^\/+/, '');
  return aN === '' ? bN : `${aN}/${bN}`;
}
