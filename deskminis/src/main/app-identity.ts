/** Windows 的应用身份 AppUserModelID（W3-aumid；设计稿 §4.1）。不 import electron（只有类型），单测直接跑——与 update-status.ts 同一手法。
 *
 *  Windows 任务栏按 AppUserModelID（AUMID）归组。NSIS 安装程序给开始菜单与桌面快捷方式写的 AUMID 是 electron-builder.yml 的 appId
 *  （app-builder-lib 模板 include/installer.nsh 的 WinShell::SetLnkAUMI "${APP_ID}"）；主进程以前从没设过，Electron 会自己生成一个，
 *  两边对不上时，固定到任务栏的图标与运行中的窗口可能分成两个按钮（推断，RELEASE 发版前核对里真机确认）。
 *  固定项会长期留在用户机器上，晚改会让老的固定项失配，所以在第一个公开版之前定下来。 */

/** 与 electron-builder.yml 的 appId 一致（tests/app-identity.test.ts 核对两边）。改 appId 时两边一起改。 */
export const APP_USER_MODEL_ID = 'com.deskminis.app';

/** 打包后的 Windows 版把进程的 AUMID 设成 APP_USER_MODEL_ID，返回是否设了。要在出现任何窗口与托盘之前调用（主进程模块顶层）。
 *  - 开发态不设：用的是 node_modules 里的 electron.exe，设成正式版的身份会跟装好的正式版挤进同一个任务栏按钮；
 *  - 别的平台不设：app.setAppUserModelId 是 Windows 专有的方法，Linux、macOS 上的 Electron 根本没有它，调了就是 TypeError。
 *  便携版也是打包的 Windows 版，一样设（它没有快捷方式，设不设都不影响归组，设了与安装版一致）。 */
export function applyAppUserModelId(
  app: { readonly isPackaged: boolean; setAppUserModelId(id: string): void },
  platform: NodeJS.Platform,
): boolean {
  if (platform !== 'win32' || !app.isPackaged) return false;
  app.setAppUserModelId(APP_USER_MODEL_ID);
  return true;
}
