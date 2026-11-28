import { dirname, join, resolve, sep } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/** 导出给 tools/data-gate.ts 复用：数据根收窄按桶名与全局目录名判定，两边各写一份常量迟早漂移。 */
export const SESSION_BUCKETS = ['workspace', 'attachments', 'offloads', 'browser'] as const;
export const GLOBAL_DIRS = ['memory', 'skills', 'shared', 'mcp-servers'] as const;
export type SessionBucket = (typeof SESSION_BUCKETS)[number];
export type GlobalDir = (typeof GLOBAL_DIRS)[number];
/** 执行隔离第 2 步：放在 agent 根而不是数据根里的全局目录。会话的四个桶也都在 agent 根里（sessions/<id>/<桶>）。
 *  其余全局目录（memory、skills、mcp-servers）是 DeskMinis 的控制面：会进提示、会被执行，留在数据根里。 */
export const AGENT_GLOBAL_DIRS: readonly GlobalDir[] = ['shared'];

/** 数据根锁（止血设计稿 §3 第 9 条）：`<dataRoot>/minisd.lock`，接管闸 `minisd.lock.recovery`。
 *  名字定在这里，W1b-3 的锁实现与 dataGate 的硬拒表引用同一对常量——
 *  各写一份的话，锁改了名而硬拒表没跟上，agent 就能用 file_write 删改锁。
 *  叫 NAME 不叫 FILE：dataGate 对这个名字下的整棵子树都硬拒，不管它是文件还是目录。W1b-3 的实现里两者都是文件
 *  （src/minisd/store/data-root-lock.ts）；接管与释放时短暂出现的 `<名>.stale-*` / `<名>.release-*` 隔离文件名字随机、
 *  转瞬即删，不在硬拒表里，落进 dataGate 的「其余」走卡。 */
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

/** 没设 DESKMINIS_DATA_DIR 时的日志与崩溃记录目录：LOCALAPPDATA 下的 DeskMinis[-dev]/logs，非 Windows 回退 HOME/.local/state。
 *  放 Local 而不放数据根：数据根在 Roaming 下会被域漫游或 OneDrive 同步，日志不该跟着漫游。
 *  主进程（src/main/app-dirs.ts）与 minisd（下面的 logRootFromEnv）共用这一条，两边不会各写一份再漂移。 */
export function defaultLogRoot(env: Readonly<Record<string, string | undefined>>, variant: AppVariant): string {
  const localAppData = env.LOCALAPPDATA ?? join(env.HOME ?? '.', '.local', 'state');
  return join(localAppData, productDirName(variant), 'logs');
}

/** minisd 的日志与崩溃记录目录（W2b-7）：主进程经 DESKMINIS_LOG_DIR 下发。没下发时（不经主进程直接起的 standalone，
 *  例如 e2e 脚本）照主进程的规则回退：设了 DESKMINIS_DATA_DIR 就是 <DATA_DIR>/logs，否则正式版的缺省目录
 *  （与 dataRoot() 缺省正式版的根同一个取向）。空串当没设。 */
export function logRootFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  if (env.DESKMINIS_LOG_DIR) return env.DESKMINIS_LOG_DIR;
  if (env.DESKMINIS_DATA_DIR) return join(env.DESKMINIS_DATA_DIR, 'logs');
  return defaultLogRoot(env, 'prod');
}

/** 执行隔离第 2 步：agent 根的缺省位置——LocalLow 下的 DeskMinis[-dev]（%USERPROFILE%\AppData\LocalLow）。
 *  agent 能看到、能写的目录（会话的工作区、附件、卸载、浏览器桶与 shared）都在这里，数据根里只剩 DeskMinis 自己的东西；
 *  放 LocalLow 是为第 3 步做准备：低完整性的进程只能写这类目录。非 Windows 回退 HOME/.local/share 下的 DeskMinis[-dev]-agent。 */
export function defaultAgentRoot(env: Readonly<Record<string, string | undefined>>, variant: AppVariant): string {
  if (env.LOCALAPPDATA) return join(dirname(env.LOCALAPPDATA), 'LocalLow', productDirName(variant));
  return join(env.HOME ?? '.', '.local', 'share', `${productDirName(variant)}-agent`);
}

/** minisd 的 agent 根：DESKMINIS_AGENT_DIR 优先；显式给了数据根（DESKMINIS_DATA_DIR 或 dataDirGiven）却没给 agent 根时
 *  就用数据根本身，布局与第 2 步之前相同（测试与 standalone 脚本的临时根照旧）；都没给时是正式版的缺省位置。
 *  经主进程起的 minisd 总会收到主进程下发的 DESKMINIS_AGENT_DIR。空串当没设。 */
export function agentRootFromEnv(env: Readonly<Record<string, string | undefined>>, dataRootPath: string, dataDirGiven = false): string {
  if (env.DESKMINIS_AGENT_DIR) return env.DESKMINIS_AGENT_DIR;
  if (dataDirGiven || env.DESKMINIS_DATA_DIR) return dataRootPath;
  return defaultAgentRoot(env, 'prod');
}

/** 会话桶的实际目录（执行隔离第 2 步）：agent 根下的 sessions/<id>/<桶>；只有数据根里的旧桶还在、agent 根里还没有时
 *  （启动时的迁移没搬成，例如文件被别的程序占着）才用旧桶——不然用户会以为工作区里的文件丢了。下次启动再搬。
 *  主进程存粘贴的附件时用同一条规则，两边落在同一个目录。 */
export function sessionBucketDir(dataRootPath: string, agentRootPath: string, sessionId: string, bucket: SessionBucket): string {
  const fresh = join(agentRootPath, 'sessions', sessionId, bucket);
  if (resolve(agentRootPath) === resolve(dataRootPath)) return fresh;
  const legacy = join(dataRootPath, 'sessions', sessionId, bucket);
  return !existsSync(fresh) && existsSync(legacy) ? legacy : fresh;
}

/** 宿主绝对路径长什么样：Windows 上是盘符路径；POSIX 上是以 / 开头、又不在 /var/minis 这个 guest 命名空间里的路径。
 *  这类路径 resolveGuestPath 原样放行（越界与否由数据闸和权限卡把关，见 tools/files.ts 的 guardRead / guardWrite）。
 *  按运行的宿主定，不按字样猜：POSIX 上的 `C:\x` 只是个带冒号和反斜杠的相对文件名，Windows 上没有盘符的 `/x` 照旧拒绝。 */
const HOST_ABSOLUTE = sep === '\\' ? /^[A-Za-z]:[\\/]/ : /^\/(?!var\/minis(?:\/|$))/;

export class MinisPaths {
  /** root：数据根（DeskMinis 自己的数据：会话库、配置、技能、记忆、MCP 配置）。
   *  agentRoot（执行隔离第 2 步）：agent 能看到的目录的根，缺省与数据根相同（第 2 步之前的布局）。 */
  constructor(public readonly root: string, public readonly agentRoot: string = root) {
    this.agentSeparate = resolve(agentRoot) !== resolve(root);
  }

  /** agent 根与数据根是不是两个目录。 */
  readonly agentSeparate: boolean;

  /** 每个会话桶第一次用时定下的目录（见 sessionBucketDir），本进程里不再变：之后数据根里冒出同名旧桶也不跟过去。 */
  private bucketDirs = new Map<string, string>();

  sessionBucket(sessionId: string, bucket: SessionBucket): string {
    if (!this.agentSeparate) return join(this.agentRoot, 'sessions', sessionId, bucket);
    const key = `${sessionId}\u0000${bucket}`;
    let dir = this.bucketDirs.get(key);
    if (dir === undefined) { dir = sessionBucketDir(this.root, this.agentRoot, sessionId, bucket); this.bucketDirs.set(key, dir); }
    return dir;
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
  globalDir(name: GlobalDir): string { return join(AGENT_GLOBAL_DIRS.includes(name) ? this.agentRoot : this.root, name); }

  ensureSessionDirs(sessionId: string): void {
    for (const b of SESSION_BUCKETS) mkdirSync(this.sessionBucket(sessionId, b), { recursive: true });
    for (const g of GLOBAL_DIRS) mkdirSync(this.globalDir(g), { recursive: true });
  }

  /** guest 路径(/var/minis/*或相对)→宿主绝对路径；绝对宿主路径放行；禁止穿越。 */
  resolveGuestPath(sessionId: string, guestPath: string): string {
    if (HOST_ABSOLUTE.test(guestPath)) return resolve(guestPath); // 宿主绝对路径(归一化)
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
