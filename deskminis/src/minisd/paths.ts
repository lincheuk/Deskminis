import { join, resolve, isAbsolute } from 'node:path';
import { mkdirSync } from 'node:fs';

/** 导出给 tools/data-gate.ts 复用：数据根收窄按桶名与全局目录名判定，两边各写一份常量迟早漂移。 */
export const SESSION_BUCKETS = ['workspace', 'attachments', 'offloads', 'browser'] as const;
export const GLOBAL_DIRS = ['memory', 'skills', 'shared', 'mcp-servers'] as const;
export type SessionBucket = (typeof SESSION_BUCKETS)[number];
export type GlobalDir = (typeof GLOBAL_DIRS)[number];

/** 数据根锁（止血设计稿 §3 第 9 条）：`<dataRoot>/minisd.lock`，接管闸 `minisd.lock.recovery`。
 *  名字定在这里，W1b-3 的锁实现与 dataGate 的硬拒表引用同一对常量——
 *  各写一份的话，锁改了名而硬拒表没跟上，agent 就能用 file_write 删改锁。
 *  叫 NAME 不叫 FILE：接管闸是文件还是目录由 W1b-3 定，dataGate 对这个名字下的整棵子树都硬拒。 */
export const DATA_ROOT_LOCK_NAME = 'minisd.lock';
export const DATA_ROOT_LOCK_RECOVERY_NAME = 'minisd.lock.recovery';

/** 正式版与未打包的开发态（W1a-9 起默认隔离，设计稿 §2「开发态数据隔离」）。 */
export type AppVariant = 'prod' | 'dev';

/** APPDATA / LOCALAPPDATA 下的目录名。dev 单独一个，npm run dev 才不会把正式库迁移到正式版不认识的版本。 */
export function productDirName(variant: AppVariant): string {
  return variant === 'dev' ? 'DeskMinis-dev' : 'DeskMinis';
}

/** 没设 DESKMINIS_DATA_DIR 时的数据根。env 由调用方传入：主进程（src/main/app-dirs.ts）按是否打包选 variant，
 *  与下面的 dataRoot() 共用这一套 APPDATA → HOME/.config 回退，两边不会各写一份再漂移。 */
export function defaultDataRoot(env: Readonly<Record<string, string | undefined>>, variant: AppVariant): string {
  const appData = env.APPDATA ?? join(env.HOME ?? '.', '.config');
  return join(appData, productDirName(variant));
}

/** minisd 自己的数据根：DESKMINIS_DATA_DIR 优先，否则正式版的根。
 *  经主进程起的 minisd 总会收到主进程显式下发的 DESKMINIS_DATA_DIR（dev 时指向 DeskMinis-dev）；
 *  不经主进程直接起的 standalone 脚本（e2e-acceptance 等）照旧默认正式版的根，对外行为不变。 */
export function dataRoot(): string {
  if (process.env.DESKMINIS_DATA_DIR) return process.env.DESKMINIS_DATA_DIR;
  return defaultDataRoot(process.env, 'prod');
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
