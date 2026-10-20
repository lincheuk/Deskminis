/**
 * F05 fixture 自检：killTree 只结束测试自己起的进程（复核修复 B3）。
 *
 * R 组先只结束引擎本身，再处理它起的 PowerShell 驱动。引擎一死，直接子进程随作业对象被系统一并结束，
 * 计数文件里读到的 pid 这时已经释放——以前不加核对就对它们 taskkill /T /F，pid 若被别的进程复用，杀掉的是一棵无关的进程树。
 * 这里用测试自己起的进程钉住：名单里不是这台引擎子进程的 pid 不动；确是它起的、引擎死后还活着的才结束。
 *
 * 用到的进程全是本文件自己 spawn 的（Electron 的 Node 模式，与引擎同一个可执行文件），各自睡一会儿就退出，不会留下来。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { killTree, pidAlive, sleep, waitFor, type EngineProc } from './run-ledger-fixture';

const WIN = process.platform === 'win32';
const own: ChildProcess[] = [];
afterEach(() => {
  // 只经自己握着的句柄收尾（已退出的进程 kill 是空操作），不按 pid
  for (const c of own.splice(0)) { try { c.kill('SIGKILL'); } catch { /* 已经不在了 */ } }
});

/** 起一个自己的 Node 子进程（npm test 在 ELECTRON_RUN_AS_NODE 下跑，execPath 是 electron，env 里带着这个变量）。 */
async function node(script: string, stdout: 'ignore' | 'pipe' = 'ignore'): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', script], { env: process.env, stdio: ['ignore', stdout, 'ignore'] });
  own.push(child);
  await new Promise<void>((res, rej) => { child.once('spawn', () => res()); child.once('error', rej); });
  return child;
}
const asEngine = (child: ChildProcess): EngineProc => ({
  child, pid: child.pid as number,
  exited: new Promise(res => {
    if (child.exitCode !== null || child.signalCode !== null) res({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code, signal) => res({ code, signal }));
  }),
});
const exitedOf = (c: ChildProcess): boolean => c.exitCode !== null || c.signalCode !== null;
const SLEEP = 'setTimeout(() => {}, 60000)';

describe('F05 fixture：killTree 只结束自己起的进程', () => {
  it('名单里的 pid 不是这台引擎的子进程（引擎死后那个 pid 指着别的进程）：引擎被结束，那个进程不动', async () => {
    const engine = await node(SLEEP);
    // 「别的进程」：与引擎无关（它是测试进程起的，不是引擎起的），pid 却出现在名单里——相当于旧 pid 被复用
    const bystander = await node(SLEEP);
    await killTree(asEngine(engine), [bystander.pid as number]);
    expect(exitedOf(engine)).toBe(true);
    // 等一会儿再看：被 taskkill 的进程，退出事件是稍后才到的
    await sleep(300);
    expect(exitedOf(bystander)).toBe(false);
    expect(pidAlive(bystander.pid as number)).toBe(true);
  }, 60_000);

  it('引擎已经自己退出：什么都不做，名单里的 pid 一个不动', async () => {
    const engine = await node('');
    const e = asEngine(engine);
    await e.exited;
    const bystander = await node(SLEEP);
    const t0 = Date.now();
    await killTree(e, [bystander.pid as number]);
    // 没有等待、没有查询
    expect(Date.now() - t0).toBeLessThan(500);
    await sleep(300);
    expect(exitedOf(bystander)).toBe(false);
  }, 30_000);

  it.skipIf(!WIN)('确是这台引擎起的、引擎死后还活着的子进程（detached，不随作业对象结束）：核对身份后按 PID 结束', async () => {
    // 引擎起一个 detached 的子进程并报出它的 pid；子进程自己 30 秒后退出（万一没被结束也不会留下来）
    const engine = await node(
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore', env: process.env });"
      + "c.unref(); process.stdout.write(String(c.pid) + '\\n'); setTimeout(() => {}, 60000);", 'pipe');
    let out = '';
    engine.stdout!.setEncoding('utf8');
    engine.stdout!.on('data', (d: string) => { out += d; });
    await waitFor('引擎报出子进程的 pid', () => /^\d+\r?\n/.test(out), 20_000);
    const childPid = Number(out.trim());
    expect(pidAlive(childPid)).toBe(true);
    await killTree(asEngine(engine), [childPid]);
    expect(exitedOf(engine)).toBe(true);
    await waitFor('引擎起的子进程已被结束', () => !pidAlive(childPid), 10_000);
  }, 60_000);

  it('不给名单：整棵树一把杀（清理用），引擎退出', async () => {
    const engine = await node(SLEEP);
    await killTree(asEngine(engine));
    expect(exitedOf(engine)).toBe(true);
  }, 30_000);
});
