/** W2b-7（设计稿 §3 第 11 条、§4 S25 · 侦察 lifecycle.md「W2b-crashlog」）：握手之后主进程自己退出时，引擎的退出不算崩溃。
 *
 *  场景：引擎握手成功，建主窗口却失败了（页面加载 reject）。whenReady 的 catch 弹「启动失败」的框，自己 kill 引擎
 *  （不走 stop()，exitWatch.stopRequested 仍为假），再 app.quit()。随后到来的 exit 是主进程自己杀的，不是引擎的问题；
 *  记成 minisd_exit 的话，每次这种启动失败 crashes.json 里都多一条假的「引擎在运行中意外退出」。
 *  主进程靠 quitting 认出它：真 Electron 的 app.quit() 当场同步发 before-quit，处理器第一句就把 quitting 置真
 *  （真 Electron 38 实测过，app.quit() 返回时处理器已经跑完）。桩按同样的样子做：h.quitEmitsBeforeQuit。
 *
 *  与 tests/crash-log-wiring.test.ts 的「优雅退出不是崩溃」互补：那条里 quitting 与 stopRequested 同时为真，
 *  任一条件都能让它绿；这条里只有 quitting 为真，钉的是 quitting 这一半（exit 监听里把它换成 false，这条就红）。
 *  主进程模块每个 worker 只能 import 一次，所以单开一个文件；electron 桩与启动器在 tests/main-window-guard-harness.ts。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootMain, h } from './main-window-guard-harness';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

let restore = (): void => {};
let logDir = '';
beforeAll(async () => {
  h.loadFails = true;
  h.quitEmitsBeforeQuit = true;
  // 建窗口失败走不到建托盘：等 whenReady 的 catch 分支弹出错误框（它之后同步地 kill、markStopped、app.quit()）
  restore = await bootMain({ rendererUrl: undefined, until: () => h.errorBoxes.length > 0 });
  logDir = join(process.env.DESKMINIS_DATA_DIR ?? '', 'logs');
}, 30_000);
afterAll(() => { restore(); });

const crashes = (): Array<{ kind: string }> => {
  try { return JSON.parse(readFileSync(join(logDir, 'crashes.json'), 'utf8')) as Array<{ kind: string }>; } catch { return []; }
};
const dailyLog = (): string => {
  try {
    return readdirSync(logDir).filter(f => /^minisd-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
      .map(f => readFileSync(join(logDir, f), 'utf8')).join('');
  } catch { return ''; }
};

describe('握手之后建窗口失败：主进程自己 kill 的引擎退出不是崩溃', () => {
  it('走到的是握手之后的 catch：页面加载 reject → 启动失败的框 → kill 引擎 → app.quit()，before-quit 放行', () => {
    expect(h.loads.map(l => l.via), '加载过一次页面（打包形态走 loadFile）').toEqual(['loadFile']);
    expect(h.trayCreated).toBe(false);
    expect(h.errorBoxes.map(b => b[0])).toEqual(['DeskMinis 启动失败']);
    expect(h.errorBoxes[0][1]).toContain('ERR_FILE_NOT_FOUND');
    expect(h.child.exit, '主进程在引擎上挂了那一个 exit 监听（下一例靠它）').toHaveLength(1);
    expect(h.child.kills, 'catch 分支直接 kill 引擎，不走优雅停').toBe(1);
    expect(h.child.posted, '没发过 shutdown：stopRequested 仍为假').toEqual([]);
    // app.quit() 当场发了一次 before-quit，退出闸因为 markStopped 放行（没挡）
    expect(h.quits).toEqual([{ prevented: false }]);
  });

  it('随后到来的引擎 exit：不记 minisd_exit，按天日志只记退出码、不说「意外退出」', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // 被 kill 的引擎这时才退出（kill 只是发信号，exit 事件要等下一轮事件循环）；退出码不参与判定
      h.child.exit[0]?.(1);
    } finally {
      spy.mockRestore();
    }
    await new Promise(r => setTimeout(r, 20));
    expect(crashes().filter(r => r.kind === 'minisd_exit'), '主进程自己在退出时引擎的退出不是崩溃').toEqual([]);
    const text = dailyLog();
    expect(text).toMatch(/\[main\] 启动失败：Error: ERR_FILE_NOT_FOUND/);
    expect(text).toMatch(/\[main\] 引擎进程退出 code=1\n/);
    expect(text).not.toMatch(/意外退出/);
  });
});
