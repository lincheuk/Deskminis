/** W3-aumid（设计稿 §4.1；DSH 桌面端对照报告 §1 U4）：打包后的 Windows 版把进程的 AppUserModelID 设成 appId。
 *
 *  为什么：Windows 任务栏按 AppUserModelID（AUMID）归组。NSIS 安装程序给开始菜单与桌面快捷方式写的 AUMID 是
 *  electron-builder.yml 的 appId（app-builder-lib 模板 include/installer.nsh 的 WinShell::SetLnkAUMI "${APP_ID}"），
 *  主进程以前从没调用 app.setAppUserModelId，Electron 会自己生成一个（推断：electron.app.<名>），两边对不上时，
 *  固定到任务栏的图标与运行中的窗口可能分成两个按钮（推断，RELEASE 发版前核对里真机确认）。
 *  固定项会长期留在用户机器上，晚改会让老的固定项失配，所以赶在第一个公开版之前定下来。
 *
 *  ① 判定（src/main/app-identity.ts 的 applyAppUserModelId，不 import electron，这里直接跑）：只在 win32 且打包时设——
 *     开发态用的是 node_modules 里的 electron.exe，设成正式版的身份会跟装好的正式版挤进同一个任务栏按钮；
 *     app.setAppUserModelId 是 Windows 专有的方法，别的平台上 Electron 根本没有它，调了就是 TypeError。
 *  ② 常量与 electron-builder.yml 的 appId 一致（改一边忘了另一边，就又对不上了）。
 *  ③ 源码守卫：主进程在模块顶层、whenReady 之前调用一次——Windows 要求进程在出现任何界面之前设好 AUMID。
 *  打包形态的接线（桩的 app 记下实参）在 tests/main-window-guard-wiring-packaged.test.ts，开发形态在 -dev 那份。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_USER_MODEL_ID, applyAppUserModelId } from '../src/main/app-identity';
import { stripComments } from './strip-comments';

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/** 桩：记下 setAppUserModelId 收到的实参 */
function fakeApp(isPackaged: boolean): { isPackaged: boolean; ids: string[]; setAppUserModelId(id: string): void } {
  const ids: string[] = [];
  return { isPackaged, ids, setAppUserModelId: (id: string) => { ids.push(id); } };
}

describe('① applyAppUserModelId · 只在打包后的 Windows 版上设', () => {
  it('win32 + 打包：设成 APP_USER_MODEL_ID，恰好一次，返回 true', () => {
    const a = fakeApp(true);
    expect(applyAppUserModelId(a, 'win32')).toBe(true);
    expect(a.ids).toEqual([APP_USER_MODEL_ID]);
  });

  it('win32 + 开发态：不设（会跟装好的正式版挤进同一个任务栏按钮），返回 false', () => {
    const a = fakeApp(false);
    expect(applyAppUserModelId(a, 'win32')).toBe(false);
    expect(a.ids).toEqual([]);
  });

  it.each(['linux', 'darwin'] as const)('%s + 打包：不设（Windows 专有的方法，别的平台上没有它），返回 false', (platform) => {
    const a = fakeApp(true);
    expect(applyAppUserModelId(a, platform)).toBe(false);
    expect(a.ids).toEqual([]);
  });

  it('别的平台上 app 根本没有 setAppUserModelId 也不碰它（真 Electron 在 Linux、macOS 上就是这样）', () => {
    expect(applyAppUserModelId({ isPackaged: true } as never, 'linux')).toBe(false);
  });
});

describe('② APP_USER_MODEL_ID 与 electron-builder.yml 的 appId 一致', () => {
  it('就是安装程序写进快捷方式的那个 AUMID', () => {
    const yml = read('electron-builder.yml').replace(/(^|\s)#.*$/gm, '$1');
    const appId = /^appId:\s*(\S+)\s*$/m.exec(yml)?.[1];
    expect(appId, 'electron-builder.yml 里找不到顶层 appId').toBeTruthy();
    expect(APP_USER_MODEL_ID).toBe(appId);
  });
});

describe('③ 主进程在模块顶层、whenReady 之前调用', () => {
  const main = stripComments(read('src/main/index.ts'));

  it('恰好一处 applyAppUserModelId(app, process.platform);，顶格写（模块顶层，不在任何函数或块里）', () => {
    expect(main.match(/applyAppUserModelId\(/g) ?? []).toHaveLength(1);
    expect(main).toMatch(/^applyAppUserModelId\(app, process\.platform\);$/m);
  });

  it('排在单实例锁、建托盘、whenReady 之前', () => {
    const at = main.search(/^applyAppUserModelId\(/m);
    expect(at).toBeGreaterThan(-1);
    for (const later of [/app\.requestSingleInstanceLock\(\)/, /app\.whenReady\(\)/, /new Tray\(/]) {
      const i = main.search(later);
      expect(i, `找不到 ${later}`).toBeGreaterThan(-1);
      expect(at, `applyAppUserModelId 要排在 ${later} 之前`).toBeLessThan(i);
    }
  });
});
