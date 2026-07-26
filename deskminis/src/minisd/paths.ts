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
  globalDir(name: GlobalDir): string { return join(this.root, name); }

  ensureSessionDirs(sessionId: string): void {
    for (const b of SESSION_BUCKETS) mkdirSync(this.sessionBucket(sessionId, b), { recursive: true });
    for (const g of GLOBAL_DIRS) mkdirSync(this.globalDir(g), { recursive: true });
  }

  /** guest 路径(/var/minis/*或相对)→宿主绝对路径；绝对宿主路径放行；禁止穿越。 */
  resolveGuestPath(sessionId: string, guestPath: string): string {
    if (/^[A-Za-z]:[\\/]/.test(guestPath)) return guestPath; // 绝对 Windows 路径
    let base: string; let rest: string;
    const m = guestPath.match(/^\/var\/minis\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const ns = m[1]; rest = m[2] ?? '';
      if ((SESSION_BUCKETS as readonly string[]).includes(ns)) base = this.sessionBucket(sessionId, ns as SessionBucket);
      else if ((GLOBAL_DIRS as readonly string[]).includes(ns)) base = this.globalDir(ns as GlobalDir);
      else throw new Error(`未知 minis 命名空间: ${ns}`);
    } else if (guestPath.startsWith('/')) {
      throw new Error(`不支持的绝对 guest 路径: ${guestPath}`);
    } else {
      base = this.sessionBucket(sessionId, 'workspace'); rest = guestPath;
    }
    const abs = resolve(base, rest);
    if (abs !== base && !abs.startsWith(base + '\\') && !abs.startsWith(base + '/')) {
      throw new Error(`路径穿越被拒绝: ${guestPath}`);
    }
    return abs;
  }
}
