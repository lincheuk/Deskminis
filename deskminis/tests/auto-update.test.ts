/** 自动更新守卫（用户 2026-08-11 拍板：GitHub Releases 全自动 + 启动检查可关）。
 *
 *  立项理由：桌面应用没有自动更新，用户装了 0.1.1 就永远停在 0.1.1——
 *  每次发版等于要求所有人手动重装。这是「装完能跑但用起来会撞墙」那一类里最贵的一条。
 *
 *  三处刻意的设计，守卫逐条锚住：
 *  ① **dev 下不许检查**：electron-updater 在未打包的应用里会抛
 *     「Skip checkForUpdates because application is not packed」，
 *     不拦的话每次 npm run dev 都吐一条错误噪音，久了就没人看错误日志了。
 *  ② **可关，且开关归主进程管**：做检查的是主进程，配置若只存在渲染端的 localStorage，
 *     主进程启动时读不到——开关会形同虚设。
 *  ③ **默认不静默安装**：下载完只提示，重启时才装。Agent 应用可能正跑着长任务，
 *     自动重启会把用户的活干掉一半。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const main = read('src/main/index.ts');
const preload = read('src/preload/index.ts');
const builder = read('electron-builder.yml');
const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; version: string };
const settings = read('src/renderer/src/components/SettingsModal.vue');

describe('自动更新 · 装配（3 例）', () => {
  it('electron-updater 是运行时依赖，不是 devDependency', () => {
    // 它在主进程运行，进 devDependencies 的话打包产物里就没有，线上直接崩。
    expect(pkg.dependencies['electron-updater']).toBeTruthy();
  });

  it('electron-builder 配 publish: github——没有它 electron-updater 不知道去哪查', () => {
    expect(builder).toMatch(/publish:/);
    expect(builder).toMatch(/provider:\s*github/);
    expect(builder).toMatch(/owner:/);
    expect(builder).toMatch(/repo:/);
  });

  it('主进程接 autoUpdater，且**dev 下不检查**（app.isPackaged 守门）', () => {
    expect(main).toMatch(/from 'electron-updater'/);
    expect(main).toMatch(/autoUpdater/);
    // 命门：不拦的话 dev 每次启动都抛「application is not packed」，
    // 错误日志被噪音淹没后，真错误也就没人看了。
    expect(main).toMatch(/app\.isPackaged/);
  });
});

describe('自动更新 · 不打断正在跑的任务（2 例）', () => {
  it('关掉自动安装：下载完只提示，重启时才装', () => {
    // Agent 应用可能正跑着长任务，自动重启会把用户的活干掉一半。
    expect(main).toMatch(/autoUpdater\.autoInstallOnAppQuit\s*=|autoInstallOnAppQuit:/);
    expect(main).not.toMatch(/quitAndInstall\(\)\s*;?\s*\n(?![\s\S]{0,200}?(响应|用户|click|confirm))/);
  });

  it('检查失败必须吞掉而不是弹窗——没网/GitHub 挂了不该打扰用户', () => {
    // 更新检查是后台便利功能，失败是常态（离线、公司网、GitHub 限流）。
    expect(main).toMatch(/autoUpdater\.on\(\s*'error'/);
  });
});

describe('自动更新 · 开关归主进程（3 例）', () => {
  it('开关持久化在主进程侧，不是只存渲染端 localStorage', () => {
    // 做检查的是主进程，启动时渲染端可能还没挂载。配置只存 localStorage 的话
    // 主进程读不到，「关掉自动检查」这个开关就是摆设。
    expect(main).toMatch(/update-prefs\.json|updatePrefs/);
    expect(main).toMatch(/ipcMain\.handle\(\s*'update:/);
  });

  it('preload 对称暴露读写与手动检查三个通道', () => {
    expect(preload).toMatch(/update:getPrefs|getUpdatePrefs/);
    expect(preload).toMatch(/update:setEnabled|setUpdateEnabled/);
    expect(preload).toMatch(/update:check|checkForUpdates/);
  });

  it('设置里有「关于与更新」页：显示版本号 + 开关 + 手动检查', () => {
    // 顺带补上「看不到自己在跑哪个版本」这个缺口——用户报 bug 时第一句就是版本号。
    expect(settings).toMatch(/\{ id: 'about', label: '关于与更新' \}/);
    expect(settings).toMatch(/section === 'about'/);
    expect(settings).toMatch(/appVersion/);
  });
});
