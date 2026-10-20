/**
 * F06：主进程 minisd:info 的 alive——渲染端每次重连都来问一遍端口与 token，这个字段告诉它引擎进程还在不在。
 *
 * 为什么要钉：渲染端一侧（alive:false 立即进终态、不建套接字）有用例与守卫；主进程给出这个值的那一行以前没有任何用例。
 *  - 这个字段丢了：preload 的类型里它是可选的，渲染端按「还在」处理，引擎退出后空转满 8 次重连（约 40 秒「正在重新连接」）才出横幅；
 *  - 判反了：任何一次断线都在第一次尝试就进终态、且不给「重新连接」，自动重连在产品里整体失效。
 *
 * 做法：用 W2b-6 的 electron 桩把 src/main/index.ts 真跑到握手完成，直接调登记在 ipcMain 上的处理器；
 * 再让桩子进程退出（主进程在它上面只挂了一个 exit 监听），看 alive 翻成假。主进程模块每个 worker 只能 import 一次，所以单开一个文件。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootMain, h } from './main-window-guard-harness';
import { stripComments } from './strip-comments';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

let restore = (): void => {};
beforeAll(async () => { restore = await bootMain({ rendererUrl: undefined }); }, 30_000);
afterAll(() => { restore(); });

const info = (): { port: number; token: string; alive?: boolean } => {
  const fn = h.ipcHandlers.get('minisd:info');
  expect(fn, "主进程没有 ipcMain.handle('minisd:info')").toBeTypeOf('function');
  return (fn as () => unknown)() as { port: number; token: string; alive?: boolean };
};

describe('minisd:info 的 alive（渲染端重连时据它决定要不要继续试）', () => {
  it('握手完成、引擎进程还在：alive 为真；端口与 token 是握手行里的那一对', () => {
    expect(h.forks).toHaveLength(1);
    expect(info()).toEqual({ port: 45678, token: 'wiring-test-token', alive: true });
  });

  it('引擎进程退出之后：alive 为假（端口与 token 还是原来的——渲染端不该再拿它们去连）', () => {
    expect(h.child.exit, '主进程在引擎上挂了那一个 exit 监听').toHaveLength(1);
    // 主进程对意外退出会往 stderr 说一句，测试里闭嘴
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try { h.child.exit[0]?.(1); } finally { spy.mockRestore(); }
    expect(info()).toEqual({ port: 45678, token: 'wiring-test-token', alive: false });
    expect(info().alive).toBe(false);                            // 再问一遍还是假：退出记录不会被别的东西翻回来
  });
});

describe('源码守卫：alive 的判据与主进程自己判断「引擎还在不在」是同一个', () => {
  const src = stripComments(readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8'));
  /** 判据：fork 过，且那唯一的 exit 监听还没记下退出。 */
  const ALIVE = /ipcMain\.handle\('minisd:info', \(\) => \(\{ port: minisdPort, token: minisdToken, alive: minisd !== undefined && minisdExit\?\.exited !== true \}\)\);/;

  it('minisd:info 回 { port, token, alive }，alive = fork 过且没有退出记录', () => {
    expect(src).toMatch(ALIVE);
    // 退出记录只由 startMinisdProcess 里那一个 exit 监听写（它调 exitWatch.markExited）
    expect(src.match(/\.markExited\(/g)).toHaveLength(1);
    expect(src).toMatch(/minisdExit = exitWatch;/);
  });

  it('守卫会咬人：alive 丢了、判反了、不看退出记录，都认得出', () => {
    const line = "ipcMain.handle('minisd:info', () => ({ port: minisdPort, token: minisdToken, alive: minisd !== undefined && minisdExit?.exited !== true }));";
    expect(src).toContain(line);
    for (const mutated of [
      line.replace(', alive: minisd !== undefined && minisdExit?.exited !== true', ''),
      line.replace('minisdExit?.exited !== true', 'minisdExit?.exited === true'),
      line.replace(' && minisdExit?.exited !== true', ''),
      line.replace('minisd !== undefined && ', ''),
    ]) {
      expect(mutated).not.toBe(line);
      expect(src.replace(line, mutated)).not.toMatch(ALIVE);
    }
  });
});
