import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── 为什么要 mock electron ──────────────────────────────────────────────────
// 下面的 parseHandshake 单测需要 import src/main/index.ts。但本项目的 npm test 跑在
// ELECTRON_RUN_AS_NODE 下，此时 require('electron') 返回的是可执行文件路径字符串，
// app / ipcMain 等具名导出全是 undefined。而 index.ts 在模块顶层就会执行
// ipcMain.handle(...) 和 app.whenReady()，直接 import 会当场 TypeError 崩掉整个文件。
// 这里给一组无副作用的桩：whenReady 返回一个永不 resolve 的 Promise，保证不会触发真正
// 的启动流程；其余方法都是 no-op。它只为让模块可被 import，不改变任何生产行为。
vi.mock('electron', () => ({
  app: { whenReady: () => new Promise<void>(() => {}), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {} },
  BrowserWindow: class {},
  dialog: { showErrorBox: () => {} },
  utilityProcess: { fork: () => ({}) },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到文件顶部，此 import 拿到的已是桩
import { parseHandshake } from '../src/main/index';

// ── 静态一致性守卫：不构建、不起 Electron，直接读两个源文件的文本比对 ──────────────
// 背景：这就是"缺了它才让 bug 溜进来"的那道守卫。minisd 现在要求 per-run token，
// 渲染层通过 preload 的 minisdInfo() → ipcRenderer.invoke('minisd:info') 拿 token。
// 只要主进程漏注册 ipcMain.handle('minisd:info')，渲染层这次 invoke 就命中一个不存在的
// 通道、静默失败，拿不到 token，每个 WS 连接被 401 —— 应用只能开一个空窗口。这类漂移
// 不会让 typecheck / build / 其它单测变红，只有源文本级契约测试能挡住。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
function readText(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

const INVOKE_RE = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g;
const HANDLE_RE = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;

/** 用 pattern 抽出全部第 1 捕获组；每次克隆正则，避免 g 标志的 lastIndex 在多次调用间串味。 */
function extractAll(pattern: RegExp, text: string): string[] {
  const re = new RegExp(pattern.source, pattern.flags);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** preload 里 invoke、但主进程没有 ipcMain.handle 注册的通道（正常应为空数组）。 */
function missingHandlers(preloadSrc: string, mainSrc: string): string[] {
  const invoked = extractAll(INVOKE_RE, preloadSrc);
  const handlers = new Set(extractAll(HANDLE_RE, mainSrc));
  return invoked.filter(ch => !handlers.has(ch));
}

const CONTRACT_MSG =
  '预加载 invoke 的每个 IPC 通道都必须在主进程 ipcMain.handle 注册，' +
  '否则渲染层调用会静默失败、应用连不上 minisd。';

describe('IPC 通道契约（preload.invoke ↔ main.handle）', () => {
  it('preload 的每个 ipcRenderer.invoke 通道都有主进程 ipcMain.handle', () => {
    const preloadSrc = readText('src/preload/index.ts');
    const mainSrc = readText('src/main/index.ts');
    const invoked = extractAll(INVOKE_RE, preloadSrc);
    // 兜底：若正则或文件路径错了，invoked 会是空数组，让"全部有 handler"假性通过。
    expect(invoked.length, 'preload 应至少 invoke 一个通道，否则正则/路径抽取失效').toBeGreaterThan(0);
    const missing = missingHandlers(preloadSrc, mainSrc);
    expect(missing, `缺少 ipcMain.handle 注册的通道: ${JSON.stringify(missing)}。${CONTRACT_MSG}`).toEqual([]);
  });

  it("主进程注册了 'minisd:info'（渲染层 minisdInfo() 靠它拿 token）", () => {
    const mainSrc = readText('src/main/index.ts');
    const handlers = new Set(extractAll(HANDLE_RE, mainSrc));
    expect(
      handlers.has('minisd:info'),
      `主进程必须 ipcMain.handle('minisd:info')。${CONTRACT_MSG}`,
    ).toBe(true);
  });

  it('守卫会咬人：从主进程源文本里删掉 minisd:info 后，契约立刻报缺失', () => {
    const preloadSrc = readText('src/preload/index.ts');
    const mainSrc = readText('src/main/index.ts');
    // 仅在内存里剔除该 handler（不落盘），模拟"控制器回退把 handler 丢了"的接缝缺陷
    const mutated = mainSrc.replace(/ipcMain\.handle\(\s*['"]minisd:info['"][\s\S]*?\);/, '');
    expect(mutated, '变异应真的删掉了 minisd:info 的注册').not.toContain("ipcMain.handle('minisd:info'");
    // 删掉后：渲染层 invoke 的 minisd:info 无人接 —— 守卫必须报出这个缺失
    expect(missingHandlers(preloadSrc, mutated)).toContain('minisd:info');
  });
});

describe('parseHandshake（握手行解析）', () => {
  it('同时带 port + token 的握手行被解析出来', () => {
    const line = JSON.stringify({ minisdPort: 51234, authToken: 'D3F4-TOKEN-UUID' });
    expect(parseHandshake(line)).toEqual({ port: 51234, token: 'D3F4-TOKEN-UUID' });
  });

  it('只有 port 没有 token 的行不是握手行 → undefined（应被转发、继续等）', () => {
    expect(parseHandshake(JSON.stringify({ minisdPort: 51234 }))).toBeUndefined();
    expect(parseHandshake(JSON.stringify({ minisdPort: 51234, authToken: '' }))).toBeUndefined();
    expect(parseHandshake(JSON.stringify({ authToken: 'X' }))).toBeUndefined();
    expect(parseHandshake('[minisd] booting db...')).toBeUndefined();
    expect(parseHandshake('not json at all')).toBeUndefined();
  });
});
