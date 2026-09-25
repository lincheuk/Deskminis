/** W2b-7（设计稿 §4 S25 · 侦察 lifecycle.md「W2b-crashlog」）：握手之前引擎就退出 = 启动失败，不是崩溃。
 *
 *  用 tests/main-window-guard-harness.ts 的 electron 桩把 src/main/index.ts 真跑一遍，h.forkImpl 换成一个
 *  握手之前就往 stderr 写一行「minisd 启动失败」然后以 1 退出的桩子进程（与 standalone 分支 reportStartupFailure 的出口同形）。
 *  钉住：
 *   - 启动失败有自己的错误框（附 stderr 末尾），crashes.json 里不再记 minisd_exit——握手之前的退出不算崩溃；
 *   - 按天日志留下完整经过：fork、引擎 stderr 那一行、退出码、主进程的「启动失败」——打包后的 GUI 里 stderr 没人看，
 *     用户把错误框一关，原因以前就再也找不回来了；
 *   - 「启动失败」那一行在弹框之前就已落盘：真 Electron 里这个框阻塞主线程，用户一直不点（接着关机、结束进程），
 *     框后面才写的就没了。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootMain, h } from './main-window-guard-harness';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

let restore = (): void => {};
let logDir = '';
/** 每次弹（阻塞的）框那一刻按天日志的全文 */
const atBox: string[] = [];
beforeAll(async () => {
  h.onBlockingDialog = () => { atBox.push(dailyLog(join(process.env.DESKMINIS_DATA_DIR ?? '', 'logs'))); };
  h.forkImpl = () => {
    const stderr: Array<(d: Buffer) => void> = [];
    return {
      stdout: { on: () => {} },
      stderr: { on: (_event: string, cb: (d: Buffer) => void) => { stderr.push(cb); } },
      on: (event: string, cb: (code: number) => void) => {
        if (event !== 'exit') return;
        setTimeout(() => {
          for (const feed of stderr) feed(Buffer.from('minisd 启动失败: Error: 注入的启动失败\n'));
          cb(1);
        }, 10);
      },
      kill: () => true,
      postMessage: () => {},
    };
  };
  // 启动失败走不到建托盘：等 whenReady 的 catch 分支弹出错误框
  restore = await bootMain({ rendererUrl: undefined, until: () => h.errorBoxes.length > 0 });
  logDir = join(process.env.DESKMINIS_DATA_DIR ?? '', 'logs');
}, 30_000);
afterAll(() => { h.onBlockingDialog = undefined; restore(); });

function dailyLog(dir = logDir): string {
  try {
    return readdirSync(dir).filter(f => /^minisd-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
      .map(f => readFileSync(join(dir, f), 'utf8')).join('');
  } catch { return ''; }
}

describe('握手之前引擎就退出：启动失败', () => {
  it('弹启动失败的错误框（附 stderr 末尾），不记 minisd_exit', () => {
    expect(h.trayCreated).toBe(false);
    expect(h.errorBoxes.map(b => b[0])).toEqual(['DeskMinis 启动失败']);
    expect(h.errorBoxes[0][1]).toContain('注入的启动失败');
    const crashFile = join(logDir, 'crashes.json');
    const recs = existsSync(crashFile) ? (JSON.parse(readFileSync(crashFile, 'utf8')) as Array<{ kind: string }>) : [];
    expect(recs.filter(r => r.kind === 'minisd_exit'), '握手之前的退出不是崩溃').toEqual([]);
  });

  it('按天日志留下完整经过：fork → 引擎 stderr → 退出码 → 主进程的「启动失败」', () => {
    const text = dailyLog();
    const order = [
      /\[main\] 启动引擎进程/,
      /\[minisd:err\] minisd 启动失败: Error: 注入的启动失败/,
      /\[main\] 引擎进程退出 code=1\n/,
      /\[main\] 启动失败：Error: minisd 退出 code=1/,
    ].map(re => text.search(re));
    expect(order.every(i => i >= 0), `日志缺行：\n${text}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toMatch(/意外退出/);
  });

  it('「启动失败」那一行在弹框之前就已落盘（这个框阻塞主线程，用户不点掉，框后面的代码就不跑）', () => {
    expect(atBox, '只弹了一个阻塞的框').toHaveLength(1);
    expect(atBox[0]).toMatch(/\[main\] 启动失败：Error: minisd 退出 code=1/);
  });
});
