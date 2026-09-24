/**
 * W1b-1 · 进程树回收、System32 绝对路径启动、windowsHide、子进程环境剥 DESKMINIS_*
 * （止血波设计稿 §2「工具层」、§3 第 10 条；侦察 tools.md W1b-killtree 先红 ①–⑨；cross.md S9）。
 *
 * 为什么要注入假 spawn：这几处都是 Windows 行为（taskkill、System32、CREATE_NO_WINDOW），Linux 上没有 powershell。
 * PersistentShell / ShellManager / TerminalSession / TerminalManager / runPowerShell / spawnMcpProcess / McpStdioClient
 * 都接受 {platform, spawnImpl, sysEnv}，这里把 platform 设成 'win32'，断言它们交给 spawn 的命令、参数与选项。
 * 唯一的真进程用例是 MCP 环境变量：vitest 跑在 electron 上，fixture 以 Node 模式起得来，能真读回子进程看到的环境。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { spawn } from 'node:child_process';
import { PersistentShell, ShellManager } from '../src/minisd/tools/shell';
import { TerminalSession, TerminalManager } from '../src/minisd/terminal';
import { runPowerShell } from '../src/minisd/bridge/handlers';
import { McpStdioClient, spawnMcpProcess, killTree } from '../src/minisd/mcp/stdio';
import { MinisPaths } from '../src/minisd/paths';

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const CWD = tmpdir();
const FIXTURE = fileURLToPath(new URL('./mcp-stdio-server.mjs', import.meta.url));

/** 模拟 minisd 的进程环境：主进程 fork 时下发的 DESKMINIS_* 一组（W1a-9），外加普通变量。 */
const SYS_ENV = Object.freeze({
  SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', MINIS_KEEP: 'k',
  DESKMINIS_STANDALONE: '1', DESKMINIS_DATA_DIR: 'D:\\dm-dev', DESKMINIS_KEYRING_SERVICE: 'DeskMinis-dev', DESKMINIS_LOG_DIR: 'D:\\logs',
});

interface Call { cmd: string; args: string[]; opts: Record<string, unknown> }
type FakeChild = EventEmitter & {
  pid: number; exitCode: number | null; signalCode: string | null; killed: boolean;
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
  kills: Array<NodeJS.Signals | number | undefined>;
  kill: (sig?: NodeJS.Signals | number) => boolean;
};

/** 假 spawn：taskkill 返回一个空的 EventEmitter（测试手动 emit exit/error），其余返回带三条 PassThrough 的假子进程，
 *  pid 从 4242 递增，下一个微任务 emit('spawn')（spawnMcpProcess 等它才 resolve）。 */
function fakeSpawn() {
  const calls: Call[] = [];
  const children: FakeChild[] = [];
  const taskkills: EventEmitter[] = [];
  let nextPid = 4242;
  const spawnImpl = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args: [...args], opts });
    if (/taskkill\.exe$/i.test(cmd)) {
      const tk = new EventEmitter();
      taskkills.push(tk);
      return tk;
    }
    const ch = new EventEmitter() as FakeChild;
    Object.assign(ch, {
      pid: nextPid++, exitCode: null, signalCode: null, killed: false,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: [],
    });
    ch.kill = (sig) => { ch.kills.push(sig); return true; };
    children.push(ch);
    queueMicrotask(() => ch.emit('spawn'));
    return ch;
  }) as unknown as typeof spawn;
  return { calls, children, taskkills, spawnImpl };
}
/** 子进程自己退出（用户在终端敲 exit、shell 里跑了 exit、MCP server 崩了）：照 Node 的顺序，
 *  先把 exitCode / signalCode 填上再发 'exit'；close 另由调用方决定发不发（孙进程占着管道时 close 会晚到）。 */
function exitOnItsOwn(ch: FakeChild, code: number | null, signal: string | null = null): void {
  ch.exitCode = code;
  ch.signalCode = signal;
  ch.emit('exit', code, signal);
}
const win = (spawnImpl: typeof spawn) => ({ platform: 'win32', spawnImpl, sysEnv: SYS_ENV });
const linux = (spawnImpl: typeof spawn) => ({ platform: 'linux', spawnImpl, sysEnv: SYS_ENV });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const appKeys = (env: unknown): string[] => Object.keys(env as object).filter((k) => /^deskminis_/i.test(k));

describe('PersistentShell（shell_execute 的常驻驱动）', () => {
  it('① win32：用 System32 下的 powershell 绝对路径启动，带 windowsHide，cwd 仍是工作区', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell(CWD, undefined, win(spawnImpl));
    void sh.run('Write-Output x');
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(PS);
    expect(win32.isAbsolute(calls[0].cmd)).toBe(true);
    expect(calls[0].opts.windowsHide).toBe(true);
    expect(calls[0].opts.cwd).toBe(CWD);
  });

  it('② interrupt：taskkill /pid <pid> /T /F（绝对路径、windowsHide），不同步杀根；taskkill 非 0 退出才兜底；树死后在途命令以 129 收口', async () => {
    const { calls, children, taskkills, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell(CWD, undefined, win(spawnImpl));
    const p = sh.run('Start-Sleep -Seconds 60');
    await tick();
    sh.interrupt();
    expect(calls).toHaveLength(2);
    expect(calls[1].cmd).toBe(TASKKILL);
    expect(calls[1].args).toEqual(['/pid', '4242', '/T', '/F']);
    expect(calls[1].opts.windowsHide).toBe(true);
    expect(children[0].kills).toEqual([]); // 先杀根的话 /T 就找不到这棵树了
    taskkills[0].emit('exit', 1, null);
    expect(children[0].kills).toEqual(['SIGKILL']);
    children[0].emit('close', null, 'SIGKILL');
    const r = await p;
    expect(r.exitCode).toBe(129);
  });

  it('② interrupt 后 taskkill 成功（0 退出）：不兜底；下一条命令重建驱动', async () => {
    const { calls, children, taskkills, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell(CWD, undefined, win(spawnImpl));
    const p = sh.run('Start-Sleep -Seconds 60');
    await tick();
    sh.interrupt();
    taskkills[0].emit('exit', 0, null);
    children[0].emit('close', 1, null);
    await p;
    expect(children[0].kills).toEqual([]);
    void sh.run('Write-Output ok');
    await tick();
    expect(calls.map((c) => c.cmd)).toEqual([PS, TASKKILL, PS]);
  });

  it('③ dispose：同样走 taskkill 整树、不同步杀根；taskkill 报错才兜底；之后的命令不复活进程', async () => {
    const { calls, children, taskkills, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell(CWD, undefined, win(spawnImpl));
    const p = sh.run('Start-Sleep -Seconds 60');
    await tick();
    sh.dispose();
    expect(calls[1]).toMatchObject({ cmd: TASKKILL, args: ['/pid', '4242', '/T', '/F'] });
    expect(children[0].kills).toEqual([]);
    taskkills[0].emit('error', new Error('spawn ENOENT'));
    expect(children[0].kills).toEqual(['SIGKILL']);
    children[0].emit('close', null, 'SIGKILL');
    await p;
    const after = await sh.run('Write-Output again');
    expect(after.exitCode).toBe(130);
    expect(calls).toHaveLength(2);
  });

  it('驱动自己退出（命令里跑了 exit / 被外部结束）后再 dispose 或 interrupt：不对旧 pid 起 taskkill，也不 kill', async () => {
    // Node 收到 'exit' 就关了进程句柄，Windows 可以把这个 pid 发给别的进程；此时 taskkill /pid <旧 pid> /T /F
    // 杀的是一棵无关的树。以前 dispose 走的是按句柄的 proc.kill，对已退出的进程什么都不做。
    const { calls, children, spawnImpl } = fakeSpawn();
    const mgr = new ShellManager(win(spawnImpl));
    const p1 = mgr.run('S1', CWD, 'exit');
    const p2 = mgr.run('S2', CWD, 'Start-Sleep 60');
    await tick();
    exitOnItsOwn(children[0], 0);
    children[0].emit('close', 0, null);
    exitOnItsOwn(children[1], null, 'SIGTERM'); // 被任务管理器结束：只有 signalCode
    children[1].emit('close', null, 'SIGTERM');
    expect((await p1).exitCode).toBe(129);
    expect((await p2).exitCode).toBe(129);
    mgr.dispose('S1');
    mgr.interrupt('S2');
    expect(calls.map((c) => c.cmd)).toEqual([PS, PS]);
    expect(children[0].kills).toEqual([]);
    expect(children[1].kills).toEqual([]);
  });

  it('④ 超时：到点先以 124 收口，同时起 taskkill 整树，不同步杀根', async () => {
    const { calls, children, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell(CWD, undefined, win(spawnImpl));
    const r = await sh.run('Start-Sleep -Seconds 60', 50);
    expect(r.exitCode).toBe(124);
    expect(calls[1]).toMatchObject({ cmd: TASKKILL, args: ['/pid', '4242', '/T', '/F'] });
    expect(children[0].kills).toEqual([]);
  });

  it('⑧ 非 win32：仍用裸名 powershell.exe（Linux 基线逐例不变），interrupt 直接 kill(SIGKILL)，不起 taskkill', async () => {
    const { calls, children, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell(CWD, undefined, linux(spawnImpl));
    void sh.run('x');
    await tick();
    expect(calls[0].cmd).toBe('powershell.exe');
    expect(calls[0].opts.windowsHide).toBe(true);
    sh.interrupt();
    expect(calls).toHaveLength(1);
    expect(children[0].kills).toEqual(['SIGKILL']);
  });

  it('子进程环境剥掉 DESKMINIS_*，会话级 MINIS_* 与 ELECTRON_RUN_AS_NODE 照旧注入，其余变量照传', async () => {
    const a = fakeSpawn();
    void new PersistentShell(CWD, { MINIS_CHAT_SESSION_ID: 'S1' }, win(a.spawnImpl)).run('x');
    const b = fakeSpawn();
    void new PersistentShell(CWD, undefined, win(b.spawnImpl)).run('x');
    await tick();
    const withSession = a.calls[0].opts.env as Record<string, string>;
    expect(appKeys(withSession)).toEqual([]);
    expect(withSession).toMatchObject({ PATH: 'C:\\bin', MINIS_KEEP: 'k', SystemRoot: 'C:\\Windows', MINIS_CHAT_SESSION_ID: 'S1', ELECTRON_RUN_AS_NODE: '1' });
    const plain = b.calls[0].opts.env as Record<string, string>;
    expect(appKeys(plain)).toEqual([]);
    expect(plain).toMatchObject({ PATH: 'C:\\bin', MINIS_KEEP: 'k' });
  });
});

describe('ShellManager', () => {
  it('构造注入透传给每个会话的 shell；dispose(sessionId) 只回收该会话的进程树，另一会话不动；未知会话不抛', async () => {
    const { calls, children, spawnImpl } = fakeSpawn();
    const mgr = new ShellManager(win(spawnImpl));
    void mgr.run('S1', CWD, 'Start-Sleep 60');
    void mgr.run('S2', CWD, 'Start-Sleep 60');
    await tick();
    expect(calls.map((c) => c.cmd)).toEqual([PS, PS]);
    mgr.dispose('S1');
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ cmd: TASKKILL, args: ['/pid', String(children[0].pid), '/T', '/F'] });
    expect(() => mgr.dispose('S-unknown')).not.toThrow();
    expect(calls).toHaveLength(3);
    mgr.interrupt('S2');
    expect(calls[3]).toMatchObject({ cmd: TASKKILL, args: ['/pid', String(children[1].pid), '/T', '/F'] });
  });
});

describe('TerminalSession / TerminalManager（终端面板的交互式 powershell）', () => {
  it('⑤ attach：powershell 绝对路径 + windowsHide；dispose 走 taskkill 整树、不同步杀根，杀树期间的迟到输出不再外发', async () => {
    const { calls, children, taskkills, spawnImpl } = fakeSpawn();
    const out: string[] = [];
    const t = new TerminalSession(CWD, (d) => out.push(d), { MINIS_CHAT_SESSION_ID: 'S1' }, win(spawnImpl));
    t.attach();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(PS);
    expect(calls[0].opts.windowsHide).toBe(true);
    expect(calls[0].opts.cwd).toBe(CWD);
    const env = calls[0].opts.env as Record<string, string>;
    expect(appKeys(env)).toEqual([]);
    expect(env).toMatchObject({ PATH: 'C:\\bin', MINIS_CHAT_SESSION_ID: 'S1' });
    children[0].stdout.write('PS C:\\> ');
    await tick();
    expect(out.join('')).toContain('PS C:\\> ');
    t.dispose();
    expect(calls[1]).toMatchObject({ cmd: TASKKILL, args: ['/pid', '4242', '/T', '/F'] });
    expect(children[0].kills).toEqual([]);
    children[0].stdout.write('late-output-after-dispose');
    await tick();
    expect(out.join('')).not.toContain('late-output-after-dispose');
    taskkills[0].emit('exit', 128, null);
    expect(children[0].kills).toEqual(['SIGKILL']);
  });

  it('TerminalManager 透传注入：attach 起绝对路径，envFor 的 MINIS_* 进环境、DESKMINIS_* 不进；dispose(sessionId) 走 taskkill', () => {
    const { calls, spawnImpl } = fakeSpawn();
    const paths = new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-killtree-term-')));
    const sid = '11111111-2222-3333-4444-555555555555';
    const mgr = new TerminalManager(paths, () => {}, (s) => ({ MINIS_CHAT_SESSION_ID: s }), win(spawnImpl));
    mgr.attach(sid);
    expect(calls[0].cmd).toBe(PS);
    expect(calls[0].opts.cwd).toBe(paths.workspaceOf(sid));
    expect(appKeys(calls[0].opts.env)).toEqual([]);
    expect(calls[0].opts.env).toMatchObject({ MINIS_CHAT_SESSION_ID: sid });
    mgr.dispose(sid);
    expect(calls[1]).toMatchObject({ cmd: TASKKILL, args: ['/pid', '4242', '/T', '/F'] });
  });

  it('终端驱动自己退出（用户敲了 exit）后删会话或退出应用：不对旧 pid 起 taskkill；还活着的会话照常收树', () => {
    // tests/terminal.test.ts 在 Windows 上走的就是这条路：输入「…; exit」→ chat.sessions.delete → terminals.dispose(sid)。
    const { calls, children, spawnImpl } = fakeSpawn();
    const paths = new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-killtree-term-')));
    const [s1, s2, s3] = ['1', '2', '3'].map((d) => `${d.repeat(8)}-2222-3333-4444-555555555555`);
    const mgr = new TerminalManager(paths, () => {}, undefined, win(spawnImpl));
    for (const s of [s1, s2, s3]) mgr.attach(s);
    mgr.input(s1, 'exit\r');
    exitOnItsOwn(children[0], 0);
    children[0].emit('close', 0, null);
    exitOnItsOwn(children[1], 1); // 退出了，但孙进程还占着管道，close 未到
    mgr.dispose(s1);
    expect(calls.map((c) => c.cmd)).toEqual([PS, PS, PS]);
    mgr.disposeAll();
    expect(calls.map((c) => c.cmd)).toEqual([PS, PS, PS, TASKKILL]);
    expect(calls[3].args).toEqual(['/pid', String(children[2].pid), '/T', '/F']);
    expect(children[0].kills).toEqual([]);
    expect(children[1].kills).toEqual([]);
  });

  it('非 win32：终端仍用裸名 powershell.exe', () => {
    const { calls, spawnImpl } = fakeSpawn();
    new TerminalSession(CWD, () => {}, {}, linux(spawnImpl)).attach();
    expect(calls[0].cmd).toBe('powershell.exe');
  });
});

describe('桥的一次性 PowerShell（runPowerShell）', () => {
  it('win32：System32 绝对路径 + windowsHide；超时以 124 收口并走 taskkill 整树', async () => {
    const { calls, children, spawnImpl } = fakeSpawn();
    const r = await runPowerShell('Start-Sleep 60', '', 50, win(spawnImpl));
    expect(r.exitCode).toBe(124);
    expect(calls[0].cmd).toBe(PS);
    expect(calls[0].args).toContain('-STA');
    expect(calls[0].opts.windowsHide).toBe(true);
    expect(calls[1]).toMatchObject({ cmd: TASKKILL, args: ['/pid', '4242', '/T', '/F'] });
    expect(children[0].kills).toEqual([]);
  });

  it('超时正好落在 exit 与 close 之间（根已退出、孙进程还占着管道）：照样 124 收口，不对旧 pid 起 taskkill', async () => {
    const { calls, children, spawnImpl } = fakeSpawn();
    const p = runPowerShell('Start-Sleep 60', '', 50, win(spawnImpl));
    await tick();
    exitOnItsOwn(children[0], 0);
    const r = await p;
    expect(r.exitCode).toBe(124);
    expect(calls.map((c) => c.cmd)).toEqual([PS]);
    expect(children[0].kills).toEqual([]);
  });
});

describe('MCP stdio 子进程', () => {
  it('⑨ win32 裸名：经 System32 下 cmd.exe 的绝对路径包裹，带 windowsHide；SystemRoot 取自注入的系统环境', async () => {
    const a = fakeSpawn();
    await spawnMcpProcess('npx', ['-y', 'pkg'], { env: {} }, 'win32', a.spawnImpl, { SystemRoot: 'C:\\Windows' });
    expect(a.calls[0].cmd).toBe(CMD);
    expect(a.calls[0].args).toEqual(['/d', '/s', '/c', 'npx', '-y', 'pkg']);
    expect(a.calls[0].opts.windowsHide).toBe(true);
    expect(a.calls[0].opts.shell).toBe(false);
    const b = fakeSpawn();
    await spawnMcpProcess('npx', [], { env: {} }, 'win32', b.spawnImpl, { SystemRoot: 'D:\\Win' });
    expect(b.calls[0].cmd).toBe('D:\\Win\\System32\\cmd.exe');
    // 带路径的命令不包裹，同样隐藏控制台窗口
    const c = fakeSpawn();
    await spawnMcpProcess('C:\\tools\\node.exe', ['srv.js'], { env: {} }, 'win32', c.spawnImpl, { SystemRoot: 'C:\\Windows' });
    expect(c.calls[0]).toMatchObject({ cmd: 'C:\\tools\\node.exe', args: ['srv.js'] });
    expect(c.calls[0].opts.windowsHide).toBe(true);
  });

  it('⑥ killTree 第 4 参给系统环境：taskkill 取该 SystemRoot；缺失或非盘符形式回落 C:\\Windows', () => {
    const run = (env: Record<string, string>) => {
      const { calls, spawnImpl } = fakeSpawn();
      killTree({ pid: 9, kill: () => true } as never, 'win32', spawnImpl, env);
      return calls[0]?.cmd;
    };
    expect(run({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\taskkill.exe');
    expect(run({})).toBe(TASKKILL);
    expect(run({ SystemRoot: '%SystemRoot%' })).toBe(TASKKILL);
  });

  it('握手超时（win32）：回收整棵树——cmd.exe 包裹下真正的 server 是孙进程，只杀根会留孤儿', async () => {
    const { calls, children, taskkills, spawnImpl } = fakeSpawn();
    const c = new McpStdioClient({ command: 'dm-fake-mcp-xyz', startupTimeoutSeconds: 0.05, proc: win(spawnImpl) });
    const err = await c.connect().then(() => null, (e: Error) => e);
    expect(err?.message).toContain('启动超时');
    expect(calls.map((x) => x.cmd)).toEqual([CMD, TASKKILL]);
    expect(calls[1].args).toEqual(['/pid', '4242', '/T', '/F']);
    expect(children[0].kills).toEqual([]);
    taskkills[0].emit('exit', 1, null);
    expect(children[0].kills).toHaveLength(1);
  });

  it('server 在握手中自己退出（崩溃）：connect 拒绝，之后 dispose 也不对旧 pid 起 taskkill', async () => {
    const { calls, children, spawnImpl } = fakeSpawn();
    const c = new McpStdioClient({ command: 'dm-fake-mcp-xyz', startupTimeoutSeconds: 5, proc: win(spawnImpl) });
    const pending = c.connect().then(() => null, (e: Error) => e);
    // 等 connect 拿到子进程、挂上 'exit' 监听（spawnMcpProcess 在 'spawn' 事件后才 resolve）
    for (let i = 0; i < 20 && (children[0]?.listenerCount('exit') ?? 0) === 0; i++) await tick();
    exitOnItsOwn(children[0], 1);
    children[0].emit('close', 1, null);
    const err = await pending;
    expect(err?.message).toContain('已退出');
    c.dispose();
    expect(calls.map((x) => x.cmd)).toEqual([CMD]);
    expect(children[0].kills).toEqual([]);
  });

  describe('环境变量（真子进程）', () => {
    const saved = { leak: process.env.DESKMINIS_LEAK_PROBE, keep: process.env.DM_KEEP_PROBE };
    const clients: McpStdioClient[] = [];
    afterEach(() => {
      for (const c of clients.splice(0)) c.dispose();
      if (saved.leak === undefined) delete process.env.DESKMINIS_LEAK_PROBE; else process.env.DESKMINIS_LEAK_PROBE = saved.leak;
      if (saved.keep === undefined) delete process.env.DM_KEEP_PROBE; else process.env.DM_KEEP_PROBE = saved.keep;
    });

    it('minisd 进程里的 DESKMINIS_* 不进 MCP server 的环境，配置里写的同前缀变量也不进；其余变量照常继承', async () => {
      process.env.DESKMINIS_LEAK_PROBE = 'leak-1';
      process.env.DM_KEEP_PROBE = 'keep-1';
      const c = new McpStdioClient({
        command: process.execPath,
        args: [FIXTURE, '--env-echo'],
        env: { ELECTRON_RUN_AS_NODE: '1', DESKMINIS_CFG_PROBE: 'cfg-1', CFG_PROBE: 'cfg-2' },
      });
      clients.push(c);
      await c.connect();
      const read = async (name: string): Promise<string> => {
        const r = (await c.callTool('envdump', { name })) as { content?: Array<{ text?: string }> };
        return r.content?.[0]?.text ?? '';
      };
      expect(await read('DESKMINIS_LEAK_PROBE')).toBe('');
      expect(await read('DESKMINIS_CFG_PROBE')).toBe('');
      expect(await read('DM_KEEP_PROBE')).toBe('keep-1');
      expect(await read('CFG_PROBE')).toBe('cfg-2');
    });
  });
});
