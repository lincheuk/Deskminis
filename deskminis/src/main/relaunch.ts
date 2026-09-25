/** 两条重启路径的纯逻辑（W2b-3 · 设计稿 §3 第 7 条、§4.1）：断线横幅的「重启应用」怎么起新实例，
 *  「重启并安装」之后等多久还没退就自己退。不 import electron：单测直接跑（与 minisd-stop.ts、update-status.ts 同一手法）。 */

/** app.relaunch 的参数。Electron 38 的 App::Relaunch：execPath、args 任一给了，新实例就只按 [execPath, ...args] 起，
 *  没给的 args 当空——所以两样一起给，不然便携版重启后丢掉原来的命令行参数。 */
export interface RelaunchOptions { execPath: string; args: string[] }

/** 便携版要重启的是外面那个便携 exe：它的启动器（app-builder-lib 的 portable.nsi）把应用解压到临时目录再运行，
 *  并把自己的路径写进 PORTABLE_EXECUTABLE_FILE；应用一退出，启动器就删掉那个临时目录——重启到解压出来的副本上，
 *  新实例要么起不来、要么跑在一个正被删除的目录里。参数照旧带上（启动器把命令行原样转给解压出的应用）。
 *  安装版与开发态返回 undefined：沿用 Electron 默认，同一个 exe、同一组参数、同一个工作目录。 */
export function relaunchOptions(env: Record<string, string | undefined>, argv: readonly string[]): RelaunchOptions | undefined {
  const exe = env.PORTABLE_EXECUTABLE_FILE;
  if (typeof exe !== 'string' || exe === '') return undefined;
  return { execPath: exe, args: argv.slice(1) };
}

/** 「重启并安装」之后等应用自己退出的上限（设计稿 §4.1）。electron-updater 的 install() 返回 false 时
 *  （安装包找不到、spawn 安装器失败、已经调过一次）quitAndInstall 不调 app.quit()，而引擎在那之前已经停了：
 *  不兜底就留下一个窗口还开着、什么也做不了的应用。正常路径上它下一拍就 app.quit()，3 秒绰绰有余。 */
export const INSTALL_QUIT_FALLBACK_MS = 3_000;
