/** W3-ps（设计稿 §4.1；0.3.0 真机验证报告 §3.2）：agent 的 shell 与终端抽屉起 PowerShell 时带 -ExecutionPolicy Bypass。
 *
 *  真机上的现象：对话里「已执行 1 步 · 1 步失败」，展开是 PowerShell 的原始报错——
 *  「npm : 无法加载文件 C:\Program Files\nodejs\npm.ps1，因为在此系统上禁止运行脚本」。
 *  Windows 客户端的默认执行策略是 Restricted（本机各作用域都是 Undefined），PowerShell 解析 npm 时先命中 npm.ps1 垫片，被策略挡下；
 *  npx / pnpm / yarn 同理。agent 也没法自己改：set-executionpolicy 在危险规则里（permissions.ts），这是对的。
 *  -ExecutionPolicy Bypass 只作用于这个 PowerShell 进程（从里面再起的 PowerShell 经 PSExecutionPolicyPreference 继承），不改系统设置；
 *  组策略（MachinePolicy / UserPolicy）设定的执行策略比它优先，那样的机器上照旧被挡（W3-psb，审查指出 CHANGELOG 原先说过头）。
 *  执行策略本身不是安全边界：agent 的命令照旧逐条过权限网关；终端抽屉里是用户自己敲的，本来就不经网关。
 *  -EncodedCommand 必须是最后一个参数（它后面的都当成命令的一部分），所以 -ExecutionPolicy 要排在它前面。
 *
 *  注入假 spawn、把 platform 设成 'win32'，断言交给 spawn 的参数（与 tests/shell-kill-tree.test.ts 同一手法）。 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { PersistentShell } from '../src/minisd/tools/shell';
import { TerminalSession } from '../src/minisd/terminal';

const CWD = 'C:\\Users\\me\\ws';
const SYS_ENV = { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin' };

function fakeSpawn(): { calls: Array<{ cmd: string; args: string[] }>; spawnImpl: typeof spawn } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnImpl = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args: [...args] });
    const ch = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(ch, { pid: 4242, exitCode: null, signalCode: null, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    ch.kill = () => true;
    queueMicrotask(() => ch.emit('spawn'));
    return ch;
  }) as unknown as typeof spawn;
  return { calls, spawnImpl };
}
const win = (spawnImpl: typeof spawn) => ({ platform: 'win32', spawnImpl, sysEnv: SYS_ENV });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 参数里 -ExecutionPolicy Bypass 成对出现，排在 -EncodedCommand 之前；原来的几项照旧 */
function expectBypass(args: string[]): void {
  const i = args.findIndex((a) => a.toLowerCase() === '-executionpolicy');
  expect(i, `参数里没有 -ExecutionPolicy：${args.join(' ')}`).toBeGreaterThan(-1);
  expect(args[i + 1]).toBe('Bypass');
  const iEnc = args.indexOf('-EncodedCommand');
  expect(iEnc, '参数里没有 -EncodedCommand').toBeGreaterThan(i + 1);
  expect(iEnc).toBe(args.length - 2);   // -EncodedCommand <base64> 收尾
  for (const keep of ['-NoProfile', '-NoLogo', '-NonInteractive']) expect(args).toContain(keep);
}

describe('agent 的 shell（PersistentShell）', () => {
  it('win32：起 PowerShell 带 -ExecutionPolicy Bypass（npm.ps1 这类垫片不再被默认策略挡下）', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell(CWD, undefined, win(spawnImpl));
    void sh.run('npm --version');
    await tick();
    expect(calls).toHaveLength(1);
    expectBypass(calls[0].args);
  });
});

describe('终端抽屉（TerminalSession）', () => {
  it('win32：起 PowerShell 同样带 -ExecutionPolicy Bypass', () => {
    const { calls, spawnImpl } = fakeSpawn();
    const t = new TerminalSession(CWD, () => {}, { MINIS_CHAT_SESSION_ID: 'S1' }, win(spawnImpl));
    t.attach();
    expect(calls).toHaveLength(1);
    expectBypass(calls[0].args);
    t.dispose();
  });
});
