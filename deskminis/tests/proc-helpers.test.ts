/**
 * 子进程小工具的纯函数部分（W1b-1 · 止血波设计稿 §2「工具层」、§3 第 10 条；侦察 tools.md W1b-killtree）。
 *
 * - proc/win-exec.ts：SystemRoot 的取值与校验、System32 下的绝对路径、killTree 的「先 taskkill 整树，失败才兜底杀根」；
 * - proc/child-env.ts：shell、终端、MCP 子进程的环境剥掉 DESKMINIS_* 这一组。
 *
 * 路径断言一律用 Windows 形态的字面量（反斜杠、盘符）：实现用 path.win32 拼接，Linux 上跑出来也必须是这个样子。
 * 所有用例都注入 env，不读本机的 SystemRoot——Windows 真机上它常是大写的 C:\WINDOWS，读了会让断言随机器变。
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { win32 } from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { systemRoot, system32, powershellPath, killTree } from '../src/minisd/proc/win-exec';
import { childEnv } from '../src/minisd/proc/child-env';
import { killTree as killTreeViaMcp } from '../src/minisd/mcp/stdio';

describe('systemRoot：只认盘符开头的绝对路径，其余回落 C:\\Windows', () => {
  it('依次取 SystemRoot、windir；键名大小写不敏感（Windows 的环境变量名本来就不分大小写）', () => {
    expect(systemRoot({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win');
    expect(systemRoot({ SYSTEMROOT: 'E:\\W' })).toBe('E:\\W');
    expect(systemRoot({ windir: 'F:\\X' })).toBe('F:\\X');
    expect(systemRoot({ WINDIR: 'G:\\Y' })).toBe('G:\\Y');
    // 两个都有时 SystemRoot 优先
    expect(systemRoot({ windir: 'F:\\X', SystemRoot: 'D:\\Win' })).toBe('D:\\Win');
  });

  it('缺失、相对路径、UNC、空串都回落 C:\\Windows；SystemRoot 不合格时仍看 windir', () => {
    expect(systemRoot({})).toBe('C:\\Windows');
    expect(systemRoot({ SystemRoot: 'Windows' })).toBe('C:\\Windows');
    expect(systemRoot({ SystemRoot: '\\\\evil\\share' })).toBe('C:\\Windows');
    expect(systemRoot({ SystemRoot: '' })).toBe('C:\\Windows');
    expect(systemRoot({ SystemRoot: 'C:Windows' })).toBe('C:\\Windows'); // 盘符相对路径，不是绝对路径
    expect(systemRoot({ SystemRoot: 'relative\\dir', windir: 'H:\\Win' })).toBe('H:\\Win');
  });
});

describe('system32 / powershellPath：path.win32 拼出的绝对路径', () => {
  it('system32(name) = <SystemRoot>\\System32\\<name>', () => {
    expect(system32('taskkill.exe', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\taskkill.exe');
    expect(system32('cmd.exe', {})).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(win32.isAbsolute(system32('cmd.exe', {}))).toBe(true);
  });

  it('powershellPath = <SystemRoot>\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', () => {
    expect(powershellPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(powershellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(win32.isAbsolute(powershellPath({}))).toBe(true);
  });
});

/** 假 taskkill：记录调用，返回一个可手动 emit('exit'/'error') 的 EventEmitter。 */
function fakeSpawn(mode: 'ok' | 'throw' = 'ok') {
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const procs: EventEmitter[] = [];
  const spawnImpl = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args: [...args], opts });
    if (mode === 'throw') throw new Error('spawn EPERM');
    const p = new EventEmitter();
    procs.push(p);
    return p;
  }) as unknown as typeof spawn;
  return { calls, procs, spawnImpl };
}
/** pid 传 null 表示「没有 pid」（spawn 就失败了）；不能用 undefined，那会落到缺省值上。 */
function fakeChild(pid: number | null = 4242) {
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  const child = { pid: pid ?? undefined, kill: (sig?: NodeJS.Signals | number) => { kills.push(sig); return true; } } as unknown as ChildProcess;
  return { child, kills };
}

describe('killTree', () => {
  it('mcp/stdio 导出的 killTree 就是 win-exec 的同一个实现（re-export，不留两份）', () => {
    expect(killTreeViaMcp).toBe(killTree);
  });

  it('win32：起 System32 下的 taskkill /pid <pid> /T /F（windowsHide），不同步杀根；taskkill 0 退出就不再兜底', () => {
    const { calls, procs, spawnImpl } = fakeSpawn();
    const { child, kills } = fakeChild();
    killTree(child, 'win32', spawnImpl, { SystemRoot: 'D:\\Win' }, 'SIGKILL');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('D:\\Win\\System32\\taskkill.exe');
    expect(calls[0].args).toEqual(['/pid', '4242', '/T', '/F']);
    expect(calls[0].opts.windowsHide).toBe(true);
    expect(calls[0].opts.stdio).toBe('ignore');
    expect(kills).toEqual([]);
    procs[0].emit('exit', 0, null);
    expect(kills).toEqual([]);
  });

  it('taskkill 非 0 退出（或被信号终止）→ 兜底杀根一次，带上调用方给的信号', () => {
    const a = fakeSpawn();
    const ca = fakeChild();
    killTree(ca.child, 'win32', a.spawnImpl, {}, 'SIGKILL');
    a.procs[0].emit('exit', 128, null);
    expect(ca.kills).toEqual(['SIGKILL']);
    const b = fakeSpawn();
    const cb = fakeChild();
    killTree(cb.child, 'win32', b.spawnImpl, {});
    b.procs[0].emit('exit', null, 'SIGTERM');
    expect(cb.kills).toEqual([undefined]);
  });

  it('taskkill 异步 error（如找不到文件）→ 兜底一次；error 之后又来 exit 也不重复杀', () => {
    const { procs, spawnImpl } = fakeSpawn();
    const { child, kills } = fakeChild();
    expect(() => killTree(child, 'win32', spawnImpl, {})).not.toThrow();
    expect(kills).toHaveLength(0);
    procs[0].emit('error', new Error('spawn ENOENT'));
    procs[0].emit('exit', 1, null);
    expect(kills).toHaveLength(1);
  });

  it('taskkill 同步抛错 → 当场兜底一次，不往外抛', () => {
    const { calls, spawnImpl } = fakeSpawn('throw');
    const { child, kills } = fakeChild();
    expect(() => killTree(child, 'win32', spawnImpl, {}, 'SIGKILL')).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(kills).toEqual(['SIGKILL']);
  });

  it('根进程的 kill 自己抛错（已死进程在个别平台会抛）→ 吞掉', () => {
    const { procs, spawnImpl } = fakeSpawn();
    const child = { pid: 7, kill: () => { throw new Error('ESRCH'); } } as unknown as ChildProcess;
    killTree(child, 'win32', spawnImpl, {});
    expect(() => procs[0].emit('exit', 1, null)).not.toThrow();
    expect(() => killTree(child, 'linux', spawnImpl, {})).not.toThrow();
  });

  it('非 win32：不起 taskkill，child.kill(signal) 一次', () => {
    const { calls, spawnImpl } = fakeSpawn();
    const { child, kills } = fakeChild();
    killTree(child, 'linux', spawnImpl, {}, 'SIGKILL');
    expect(calls).toHaveLength(0);
    expect(kills).toEqual(['SIGKILL']);
  });

  it('根进程已自己退出（exitCode 或 signalCode 非 null）：不起 taskkill、也不 kill——旧 pid 可能已被系统复用', () => {
    // Node 收到 'exit' 时就关了进程句柄，Windows 随即可以把这个 pid 发给别的进程；
    // 这时 taskkill /pid <旧 pid> /T /F 杀的是一棵无关的树。两种「已终止」形态都要认：
    // 自然退出给 exitCode，被信号终止只给 signalCode（Windows 上被 kill 的进程 exitCode 恒为 null）。
    const cases: Array<Record<string, unknown>> = [
      { exitCode: 0, signalCode: null },
      { exitCode: 3, signalCode: null },
      { exitCode: null, signalCode: 'SIGTERM' },
    ];
    for (const gone of cases) {
      for (const platform of ['win32', 'linux']) {
        const { calls, spawnImpl } = fakeSpawn();
        const kills: unknown[] = [];
        const child = { pid: 15521, ...gone, kill: (s?: unknown) => { kills.push(s); return true; } } as unknown as ChildProcess;
        killTree(child, platform, spawnImpl, { SystemRoot: 'C:\\Windows' }, 'SIGKILL');
        expect({ gone, platform, calls: calls.length, kills: kills.length }).toEqual({ gone, platform, calls: 0, kills: 0 });
      }
    }
    // 对照：两者都显式为 null（还活着）照常起 taskkill
    const alive = fakeSpawn();
    killTree({ pid: 15521, exitCode: null, signalCode: null, kill: () => true } as unknown as ChildProcess, 'win32', alive.spawnImpl, {});
    expect(alive.calls).toHaveLength(1);
  });

  it('win32 但没有 pid（spawn 就失败了）：不起 taskkill，直接 child.kill', () => {
    const { calls, spawnImpl } = fakeSpawn();
    const { child, kills } = fakeChild(null);
    killTree(child, 'win32', spawnImpl, {});
    expect(calls).toHaveLength(0);
    expect(kills).toHaveLength(1);
  });
});

describe('childEnv：子进程环境剥掉 DESKMINIS_*（§3 第 10 条）', () => {
  it('继承来的与显式传入的 DESKMINIS_* 都剥掉（前缀不分大小写），其余照传，显式值盖过继承值', () => {
    const base = {
      PATH: 'C:\\bin', SystemRoot: 'C:\\Windows',
      DESKMINIS_DATA_DIR: 'D:\\dev-root', DESKMINIS_STANDALONE: '1', DESKMINIS_KEYRING_SERVICE: 'DeskMinis-dev',
      DeskMinis_Log_Dir: 'D:\\logs', deskminis_test: '1',
      MY_DESKMINIS_X: 'keep-infix', DESKMINISX: 'keep-no-underscore', MINIS_CHAT_SESSION_ID: 'old',
    };
    const env = childEnv(base, { MINIS_CHAT_SESSION_ID: 'S1', DESKMINIS_FAKE_PROVIDER: '1', MINIS_UNSET: undefined });
    expect(Object.keys(env).filter((k) => /^deskminis_/i.test(k))).toEqual([]);
    expect(env).toEqual({
      PATH: 'C:\\bin', SystemRoot: 'C:\\Windows',
      MY_DESKMINIS_X: 'keep-infix', DESKMINISX: 'keep-no-underscore', MINIS_CHAT_SESSION_ID: 'S1',
    });
  });

  it('不改入参、返回新对象；不给 extra 也照样剥', () => {
    const base = Object.freeze({ PATH: '/bin', DESKMINIS_DATA_DIR: '/x' });
    const env = childEnv(base);
    expect(env).toEqual({ PATH: '/bin' });
    expect(env).not.toBe(base);
    expect(base).toEqual({ PATH: '/bin', DESKMINIS_DATA_DIR: '/x' });
  });
});
