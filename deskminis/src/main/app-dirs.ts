/** W1a-9 开发态数据隔离（设计稿 §2「开发态数据隔离」、侦察计划 lifecycle.md「W1a-devdata」）。
 *
 *  以前 `npm run dev` 与装好的正式版共用 %APPDATA%\DeskMinis 和 keyring 服务名 'DeskMinis'：
 *  同一个 minis.db（dev 跑一次就可能把正式库迁移到正式版不认识的版本，DB_NEWER 守卫也只能让它「打不开」）、
 *  同一个配对身份、同一个搜索 key 单槽。现在主进程启动时在这里一次算定全部目录，
 *  再经 fork env 显式下发给 minisd，主进程自己的 attachments:save 也用同一份结果。
 *
 *  纯函数、不 import electron：isPackaged 与 env 由调用方传入，测试可以直接穷举组合。 */
import { join, resolve } from 'node:path';
import { defaultDataRoot, productDirName, type AppVariant } from '../minisd/paths';

type Env = Readonly<Record<string, string | undefined>>;

export interface AppDirs {
  /** minisd 的数据根，经 DESKMINIS_DATA_DIR 下发。 */
  dataRoot: string;
  /** 要 app.setPath('userData') 的目录；undefined 表示保持 Electron 默认（打包态）。 */
  userData?: string;
  /** keyring 服务名，经 DESKMINIS_KEYRING_SERVICE 下发。 */
  keyringService: string;
  /** 日志与崩溃记录目录，经 DESKMINIS_LOG_DIR 下发（本步只算出并下发，写日志在 W2b-7）。 */
  logRoot: string;
  variant: AppVariant;
}

/**
 * 规则（按「是否打包 × 是否设 DESKMINIS_DATA_DIR」）：
 * - 数据根：DESKMINIS_DATA_DIR 优先；否则 APPDATA 下的 DeskMinis（打包）或 DeskMinis-dev（未打包）。
 * - userData：打包态不动——动了会丢用户已保存的主题（localStorage）与 update-prefs。
 *   未打包且没设 DATA_DIR 时就是数据根，和正式版在 Windows 上 userData≡数据根的布局一致
 *   （正式版 userData 是 %APPDATA%\deskminis，NTFS 不分大小写，与数据根是同一个目录）。
 *   未打包且设了 DATA_DIR=X 时是 X/electron：Electron 的单实例锁按 userData 算，
 *   不分开的话 driver 会被开着的 dev 应用当成第二实例秒退，每个临时根也就没法各带一份 Chromium 配置。
 * - keyring 服务名：打包 'DeskMinis'（正式版已存的 key 都在这里，不能变）；未打包一律 'DeskMinis-dev'。
 * - 日志目录：设了 DATA_DIR 时 <DATA_DIR>/logs；否则 LOCALAPPDATA 下的 DeskMinis[-dev]/logs，
 *   非 Windows 回退 HOME/.local/state。放 Local 而不放数据根：数据根在 Roaming 下会被域漫游或 OneDrive 同步，
 *   日志不该跟着漫游，也不该进数据根写闸和将来备份的范围。
 *
 * 所有路径都 resolve 成绝对路径：app.setPath 只收绝对路径，DATA_DIR 给相对路径时会在模块顶层抛错、应用起不来。
 * 主进程与 minisd 的 cwd 相同，所以对 minisd 来说落点不变。
 */
export function resolveAppDirs(input: { isPackaged: boolean; env: Env }): AppDirs {
  const { isPackaged, env } = input;
  const variant: AppVariant = isPackaged ? 'prod' : 'dev';
  // 空串当没设，与 paths.dataRoot() 的判断一致
  const override = env.DESKMINIS_DATA_DIR ? resolve(env.DESKMINIS_DATA_DIR) : undefined;
  const dataRoot = override ?? resolve(defaultDataRoot(env, variant));
  const localAppData = env.LOCALAPPDATA ?? join(env.HOME ?? '.', '.local', 'state');
  const logRoot = override ? join(override, 'logs') : resolve(localAppData, productDirName(variant), 'logs');
  const userData = isPackaged ? undefined : (override ? join(override, 'electron') : dataRoot);
  const keyringService = isPackaged ? 'DeskMinis' : 'DeskMinis-dev';
  return { dataRoot, userData, keyringService, logRoot, variant };
}
