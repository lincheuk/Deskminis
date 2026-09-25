/** W2b-7（设计稿 §4 S25 · 侦察 lifecycle.md「W2b-crashlog」）：真 fork 一个 minisd 子进程，证明崩溃记录与按天日志真的落盘。
 *
 *  主进程是 src/main/index.ts 本体：electron 桩同 tests/main-window-guard-harness.ts（whenReady 在 worker 里真跑，
 *  数据根是 mkdtemp 临时目录），只把 utilityProcess.fork 换成 child_process.spawn——用 vite-node 直接跑
 *  src/minisd/index.ts，env 原样用主进程交给 fork 的那一份（DESKMINIS_STANDALONE=1、DATA_DIR、LOG_DIR、APP_VERSION…），
 *  所以子进程走的是真的 standalone 分支、真的崩溃钩子，日志目录与版本号也是主进程真下发的。
 *  子进程 `-r` 预加载 tests/minisd-crash-inject.cjs：补一个 process.parentPort，并按 stdin 的指令在引擎里制造
 *  未处理拒绝 / 未捕获异常（不往产品代码里加测试开关）。
 *
 *  依次验证（共用一个子进程，按顺序跑）：
 *   1. 握手之后按天日志里有 fork 与握手端口两行，per-run token 不落盘；
 *   2. 引擎里的未处理拒绝：引擎记一条 minisd / unhandled_rejection 后继续服务（以前 Node 默认直接打死引擎），
 *      它往 stderr 说的那句经主进程落进按天日志；
 *   3. 引擎里的未捕获异常：引擎同步记一条后以 1 退出；主进程在唯一的 exit 监听里判定「握手后、没请求关停」，
 *      记一条 minisd_exit（带退出码与 stderr 末尾），按天日志记下退出码。
 *  「请求过关停的退出不记」那一半在 tests/crash-log-wiring.test.ts（桩子进程）里。
 *
 *  Linux 与 Windows 都能跑：不用信号，指令都走 stdin；vitest 跑在 electron 的 node 模式上，子进程用同一个
 *  process.execPath，better-sqlite3 的 ABI 一致。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootMain, h, type ForkOptions } from './main-window-guard-harness';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

const appRoot = join(__dirname, '..');
const VITE_NODE = join(appRoot, 'node_modules', 'vite-node', 'vite-node.mjs');
const INJECT = join(__dirname, 'minisd-crash-inject.cjs');

let child: ChildProcess | undefined;
let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => { resolveExit = r; });
let restore = (): void => {};
let logDir = '';
let dataDir = '';
let stderrSpy: { mockRestore(): void } | undefined;

/** 把 ChildProcess 包成主进程用到的那部分 UtilityProcess：stdout / stderr / 'exit'(code) / kill / postMessage */
function asUtilityProcess(cp: ChildProcess) {
  return {
    stdout: cp.stdout,
    stderr: cp.stderr,
    on(event: string, cb: (code: number) => void) {
      // utilityProcess 的 exit 只给一个退出码；被信号杀掉时 Node 给 code=null，按 128+信号值的惯例折成数
      if (event === 'exit') cp.on('exit', (code, signal) => cb(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : -1)));
      return this;
    },
    kill: () => cp.kill(),
    postMessage: (message: unknown) => { cp.stdin?.write(JSON.stringify({ parentPortMessage: message }) + '\n'); },
  };
}

beforeAll(async () => {
  // 子进程继承这两项：凭据走内存库（不碰开发机的 keyring），provider 用假的
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  h.forkImpl = (_modulePath: string, _args: string[], opts: ForkOptions) => {
    const cp = spawn(process.execPath, ['-r', INJECT, VITE_NODE, 'src/minisd/index.ts'], {
      cwd: appRoot,
      env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cp.on('exit', (code, signal) => resolveExit({ code, signal }));
    child = cp;
    return asUtilityProcess(cp);
  };
  restore = await bootMain({ rendererUrl: undefined, timeoutMs: 60_000 });
  dataDir = process.env.DESKMINIS_DATA_DIR ?? '';
  logDir = join(dataDir, 'logs');
  // 主进程把子进程的 stderr 转发到自己的 stderr：测试输出里闭嘴
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}, 90_000);

afterAll(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  stderrSpy?.mockRestore();
  restore();
});

type Rec = { process: string; kind: string; message: string; version: string; stack: string | null; exitCode?: number; stderrTail?: string };
const crashes = (): Rec[] => {
  try { return JSON.parse(readFileSync(join(logDir, 'crashes.json'), 'utf8')) as Rec[]; } catch { return []; }
};
const dailyLog = (): string => {
  try {
    return readdirSync(logDir).filter(f => /^minisd-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
      .map(f => readFileSync(join(logDir, f), 'utf8')).join('');
  } catch { return ''; }
};
const portFile = (): { port: number; authToken: string } =>
  JSON.parse(readFileSync(join(dataDir, 'minisd-port.json'), 'utf8')) as { port: number; authToken: string };

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

/** 连上去调一次 RPC：引擎还在正常服务 */
async function rpcAlive(port: number, token: string): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  try {
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const reply = await new Promise<{ result?: unknown }>((res) => {
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d)) as { id?: number; result?: unknown };
        if (msg.id === 1) res(msg);
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.sessions.list' }));
    });
    return Array.isArray(reply.result);
  } finally { ws.close(); }
}

describe('真 fork 的 minisd：崩溃记录与按天日志落盘', () => {
  it('1. 握手之后，按天日志里有 fork 与握手端口两行；per-run token 不落盘', async () => {
    const { port, authToken } = portFile();
    await waitFor('握手行进日志', () => dailyLog().includes(`引擎握手完成，端口 ${port}`), 5_000);
    const text = dailyLog();
    expect(text).toMatch(/\[main\] 启动引擎进程/);
    expect(text).not.toContain(authToken);
  });

  it('2. 引擎里的未处理拒绝：记一条 minisd / unhandled_rejection（版本号由主进程下发），引擎继续服务，那句说明落进按天日志', async () => {
    child?.stdin?.write(JSON.stringify({ inject: 'reject' }) + '\n');
    await waitFor('unhandled_rejection 记录', () => crashes().some(r => r.kind === 'unhandled_rejection'));
    const rec = crashes().find(r => r.kind === 'unhandled_rejection');
    expect(rec).toMatchObject({ process: 'minisd', version: '0.0.0-test', message: '注入：引擎里的未处理拒绝' });
    expect(rec?.stack).toContain('minisd-crash-inject.cjs');
    const { port, authToken } = portFile();
    expect(await rpcAlive(port, authToken), '记完之后引擎还得接着服务').toBe(true);
    expect(child?.exitCode).toBeNull();
    await waitFor('stderr 那句进按天日志', () => /\[minisd:err\].*注入：引擎里的未处理拒绝/.test(dailyLog()));
  });

  it('3. 引擎里的未捕获异常：引擎记一条后以 1 退出；主进程记 minisd_exit（退出码、stderr 末尾），按天日志记下退出码', async () => {
    child?.stdin?.write(JSON.stringify({ inject: 'throw' }) + '\n');
    const { code } = await Promise.race([exited, new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('引擎没有退出')), 15_000))]);
    expect(code).toBe(1);
    await waitFor('minisd_exit 记录', () => crashes().some(r => r.kind === 'minisd_exit'));
    const recs = crashes();
    expect(recs.map(r => [r.process, r.kind])).toEqual([
      ['minisd', 'unhandled_rejection'], ['minisd', 'uncaught_exception'], ['minisd', 'minisd_exit'],
    ]);
    expect(recs[1]).toMatchObject({ message: '注入：引擎里的未捕获异常', version: '0.0.0-test' });
    expect(recs[1].stack).toContain('minisd-crash-inject.cjs');
    expect(recs[2]).toMatchObject({ exitCode: 1, version: '0.0.0-test' });
    expect(recs[2].stderrTail, 'stderr 末尾（真正的原因多半在这里）').toContain('注入：引擎里的未处理拒绝');
    await waitFor('退出码进日志', () => /\[main\] 引擎进程退出 code=1/.test(dailyLog()));
    expect(dailyLog()).not.toContain(portFile().authToken);
  });
});
