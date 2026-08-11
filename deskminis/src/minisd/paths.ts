import { join, resolve, isAbsolute } from 'node:path';
import { mkdirSync } from 'node:fs';

const SESSION_BUCKETS = ['workspace', 'attachments', 'offloads', 'browser'] as const;
const GLOBAL_DIRS = ['memory', 'skills', 'shared', 'mcp-servers'] as const;
export type SessionBucket = (typeof SESSION_BUCKETS)[number];
export type GlobalDir = (typeof GLOBAL_DIRS)[number];

export function dataRoot(): string {
  if (process.env.DESKMINIS_DATA_DIR) return process.env.DESKMINIS_DATA_DIR;
  const appData = process.env.APPDATA ?? join(process.env.HOME ?? '.', '.config');
  return join(appData, 'DeskMinis');
}

export class MinisPaths {
  constructor(public readonly root: string) {}

  sessionBucket(sessionId: string, bucket: SessionBucket): string {
    return join(this.root, 'sessions', sessionId, bucket);
  }

  /** 每会话工作区覆盖值的解析器。由 index.ts 注入——Paths 不该认识 DB。 */
  private workspaceResolver?: (sessionId: string) => string | undefined;
  setWorkspaceResolver(fn: (sessionId: string) => string | undefined): void { this.workspaceResolver = fn; }

  /** 会话的**实际**工作目录：设过就用设的，否则回落沙箱桶。
   *  shell 的 cwd、终端启动目录、相对路径解析三处必须都走这里——
   *  只改其中一处的话，文件工具听话了但命令还在沙箱桶里跑，
   *  表现为「agent 说找不到文件」，而用户以为工作区已经切过去了。 */
  workspaceOf(sessionId: string): string {
    const o = this.workspaceResolver?.(sessionId);
    return (typeof o === 'string' && o.trim() !== '') ? resolve(o) : this.sessionBucket(sessionId, 'workspace');
  }
  globalDir(name: GlobalDir): string { return join(this.root, name); }

  ensureSessionDirs(sessionId: string): void {
    for (const b of SESSION_BUCKETS) mkdirSync(this.sessionBucket(sessionId, b), { recursive: true });
    for (const g of GLOBAL_DIRS) mkdirSync(this.globalDir(g), { recursive: true });
  }

  /** guest 路径(/var/minis/*或相对)→宿主绝对路径；绝对宿主路径放行；禁止穿越。 */
  resolveGuestPath(sessionId: string, guestPath: string): string {
    if (/^[A-Za-z]:[\\/]/.test(guestPath)) return resolve(guestPath); // 绝对 Windows 路径(归一化)
    let base: string; let rest: string;
    const m = guestPath.match(/^\/var\/minis\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const ns = m[1]; rest = m[2] ?? '';
      if ((SESSION_BUCKETS as readonly string[]).includes(ns)) {
        // /var/minis/workspace 是「工作区」的 guest 名，必须跟着覆盖值走；其余桶不受影响
        base = ns === 'workspace' ? this.workspaceOf(sessionId) : this.sessionBucket(sessionId, ns as SessionBucket);
      }
      else if ((GLOBAL_DIRS as readonly string[]).includes(ns)) base = this.globalDir(ns as GlobalDir);
      else throw new Error(`未知 minis 命名空间: ${ns}`);
    } else if (guestPath.startsWith('/')) {
      throw new Error(`不支持的绝对 guest 路径: ${guestPath}`);
    } else {
      base = this.workspaceOf(sessionId); rest = guestPath;
    }
    const abs = resolve(base, rest);
    if (abs !== base && !abs.startsWith(base + '\\') && !abs.startsWith(base + '/')) {
      throw new Error(`路径穿越被拒绝: ${guestPath}`);
    }
    return abs;
  }
}
