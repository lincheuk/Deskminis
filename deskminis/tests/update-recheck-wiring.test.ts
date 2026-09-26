/** W3-updb（设计稿 §4.1）：checkUpdates 接住 electron-updater 自动下载的 downloadPromise。
 *
 *  electron-updater 6.8.9 在 autoDownload 为真时，checkForUpdates() 发完 update-available 就落定，交回的结果里带着
 *  downloadPromise（AppUpdater.doCheckForUpdates）。以前主进程对它不闻不问，出了两个问题：
 *  ① 已经下载过的安装包只核对缓存，几毫秒后才发 update-downloaded（W3-upd 实拍晚 7–16ms）。手动检查一落定就取状态，
 *     取到的是 available：托盘回执说「发现新版本，正在后台下载」、关于页变成「有新版本」，同时弹出的安装提示却说「已下载完成」。
 *  ② 下载失败时 electron-updater 先发 'error'，再让 downloadPromise reject（AppUpdater.downloadUpdate 的
 *     `.catch(e => { throw errorHandler(e) })`）。没人接，就成了主进程的未处理拒绝，W2b-7 的钩子把它当主进程崩溃记进
 *     crashes.json——那里只留最近 5 条，会把真崩溃挤掉。
 *  现在：不论自动还是手动都给它挂上处理；手动检查再等它最多 MANUAL_CHECK_SETTLE_MS，缓存命中时说得出「已下载」，
 *  真要从头下载的等满上限照常回「正在后台下载」。
 *
 *  按打包形态起主进程（未打包时 checkUpdates 直接回 dev，走不到 electron-updater），checkForUpdates 换成这里的实现：
 *  照 electron-updater 的顺序发事件、交回 downloadPromise。走两条路：关于页的 update:check（ipcMain.handle 的处理器）
 *  与托盘「检查更新…」（托盘菜单模板里那一项的 click）。自动检查只在启动 8 秒后跑一次，这里不等它；
 *  「处理不看 manual」由 tests/update-handoff.test.ts 的源码守卫钉。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootMain, h } from './main-window-guard-harness';
import { downloadedDialog, manualCheckDialog } from '../src/main/update-status';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

let restore = (): void => {};
let logDir = '';
// 全量并发时起主进程可能慢，钩子时限放宽到 30s
beforeAll(async () => {
  restore = await bootMain({ rendererUrl: undefined, isPackaged: true });
  logDir = join(process.env.DESKMINIS_DATA_DIR ?? '', 'logs');
  h.listWindows = true;   // 下载完成框挂在主窗口上
}, 30_000);
afterAll(() => { h.checkForUpdates = () => Promise.resolve(null); restore(); });

type State = { status: string; version?: string; error?: string };
const V = '0.3.99';
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
/** 主进程挂在 autoUpdater 上的处理器，按 electron-updater 的样子发事件 */
function emit(event: string, ...args: unknown[]): void {
  for (const fn of h.updaterOn.get(event) ?? []) fn(...args);
}
/** 模拟 autoDownload 为真时的 checkForUpdates：发 checking-for-update、update-available，交回带 downloadPromise 的结果 */
function fakeCheck(download: () => Promise<string[]>): () => Promise<unknown> {
  return async () => {
    emit('checking-for-update');
    emit('update-available', { version: V });
    return { isUpdateAvailable: true, updateInfo: { version: V }, versionInfo: { version: V }, downloadPromise: download() };
  };
}
/** 缓存命中：核对完（10ms）才发 update-downloaded，再落定 */
const cached = (): Promise<string[]> => (async () => {
  await sleep(10);
  emit('update-downloaded', { version: V });
  return ['/cache/pending/DeskMinis-Setup.exe'];
})();
/** 真要从头下载：这次检查期间下不完 */
const pending = (): Promise<string[]> => new Promise<string[]>(() => {});
/** 下载失败：与 electron-updater 一样先发 'error'，再 reject 同一个错误 */
const failing = (): Promise<string[]> => (async () => {
  await sleep(10);
  const e = new Error(`Cannot download "https://github.com/lincheuk/deskminis-releases/releases/download/v${V}/DeskMinis-${V}-Setup.exe", status 404: Not Found`);
  emit('error', e);
  throw e;
})();

/** 期间主进程往 stderr 写的（更新出错的原文）闭嘴 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { return await fn(); } finally { spy.mockRestore(); }
}
/** 关于页「现在检查」走的通道 */
function updateCheck(): Promise<State> {
  const fn = h.ipcHandlers.get('update:check');
  expect(fn, "主进程没有注册 ipcMain.handle('update:check'").toBeTypeOf('function');
  return fn!({}) as unknown as Promise<State>;
}
/** 托盘菜单里 label 那一项的 click */
function trayClick(label: string): () => void {
  const tpl = [...h.menuTemplates].reverse()
    .find((t): t is Array<{ label?: string; click?: () => void }> => Array.isArray(t) && t.some(i => i?.label === label));
  const item = tpl?.find(i => i.label === label);
  expect(item?.click, `托盘菜单里没有「${label}」`).toBeTypeOf('function');
  return item!.click!;
}
const crashes = (): Array<{ process: string; kind: string }> => {
  try { return JSON.parse(readFileSync(join(logDir, 'crashes.json'), 'utf8')); } catch { return []; }
};

describe('手动检查 · 已经下载过：缓存核对几毫秒后才发 update-downloaded', () => {
  it('关于页「现在检查」回「已下载」，不是「有新版本」', async () => {
    h.checkForUpdates = fakeCheck(cached);
    expect(await quietly(() => updateCheck())).toEqual({ status: 'downloaded', version: V });
  });

  it('托盘「检查更新…」：回执是 downloaded 那一格，与同时弹出的安装提示一致，不再说「正在后台下载」', async () => {
    h.checkForUpdates = fakeCheck(cached);
    const before = h.messageBoxes.length;
    await quietly(async () => {
      trayClick('检查更新…')();
      // 回执不挂窗口（实参只有选项一个）；安装提示挂主窗口
      await vi.waitFor(() => { expect(h.messageBoxes.slice(before).filter(a => a.length === 1)).toHaveLength(1); }, { timeout: 5_000 });
    });
    const boxes = h.messageBoxes.slice(before);
    expect(boxes).toContainEqual([h.windows[0], downloadedDialog(V)]);
    expect(boxes).toContainEqual([manualCheckDialog({ status: 'downloaded', version: V }, '0.0.0-test')]);
  });
});

describe('手动检查 · 真要从头下载：下载在这次检查期间完不了', () => {
  it('等满上限就照常回「有新版本」（回执说正在后台下载），不把回执拖到下载完', async () => {
    h.checkForUpdates = fakeCheck(pending);
    const t0 = Date.now();
    const r = await quietly(() => updateCheck());
    const took = Date.now() - t0;
    expect(r).toEqual({ status: 'available', version: V });
    expect(took, '缓存核对要有机会落定：先等一会儿').toBeGreaterThanOrEqual(1_000);
    expect(took, '真在下载的不能一直等：几秒内就回').toBeLessThan(3_000);
  });
});

describe('下载失败：downloadPromise 的拒绝有人接', () => {
  it('update:check 回「更新失败」与一句中文原因；不在 crashes.json 里记成主进程崩溃', async () => {
    h.checkForUpdates = fakeCheck(failing);
    const r = await quietly(() => updateCheck());
    expect(r.status).toBe('error');
    expect(r.error).toContain('安装包');
    // 没人接的拒绝要等这一轮微任务跑完才报出来（'unhandledRejection'），多等一拍再看
    await sleep(50);
    expect(crashes().filter(c => c.kind === 'unhandled_rejection')).toEqual([]);
  });
});
