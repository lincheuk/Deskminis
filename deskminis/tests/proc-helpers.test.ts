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

/**
 * W1b-5d（设计稿 §4.1）：killTree 返回「回收落定」的 Promise，关停等它跑完再关库退出。
 * 以前 killTree 起了 taskkill 就返回，关停紧接着关库、exit(0)：taskkill 是 minisd 的直接子进程，随 minisd 退出被作业一并结束，
 * 还没跑完的话，npx 拉起的 node、终端里的 dev server 这些孙进程没人收（libuv 的作业只收直接子进程，见 win-exec.ts 头注释）。
 * 落定时机：win32 且有 pid 时等 taskkill 发 'exit'（非 0 先兜底杀根）或 'error'（先兜底）；同步抛错兜底后落定；
 * 根进程已退出、非 win32、没有 pid 时立即落定。从不拒绝——关停与删除会话都不该因为收树失败而中断。
 */
describe('killTree 返回回收落定的 Promise（W1b-5d）', () => {
  /** 排空微任务与已到期的 I/O 回调：落没落定，看这之后的标志 */
  const drain = (): Promise<void> => new Promise((r) => setImmediate(r));
  /** 记下落定的时刻根进程挨过哪几下 kill（undefined = 还没落定） */
  function watch(p: Promise<unknown>, kills: unknown[]): { at: () => unknown[] | undefined } {
    let seen: unknown[] | undefined;
    void p.then(() => { seen = [...kills]; });
    return { at: () => seen };
  }

  it('win32：taskkill 发 exit 之前不落定；exit(0) 之后落定，不兜底；taskkill 不设 detached', async () => {
    const { calls, procs, spawnImpl } = fakeSpawn();
    const { child, kills } = fakeChild();
    const p = killTree(child, 'win32', spawnImpl, { SystemRoot: 'D:\\Win' }, 'SIGKILL');
    const w = watch(p, kills);
    await drain();
    expect(w.at(), 'taskkill 还没跑完就落定了：关停会在收树之前关库退出').toBeUndefined();
    // 不设 detached 的理由写在 win-exec.ts 头注释：设了就另开进程组、活过 minisd，而这时关停已经等它跑完
    expect(calls[0].opts.detached).toBeUndefined();
    procs[0].emit('exit', 0, null);
    await expect(p).resolves.toBeUndefined();
    expect(w.at()).toEqual([]);
  });

  it('taskkill 非 0 退出或被信号终止：先兜底 kill 根进程（带调用方的信号），再落定', async () => {
    const a = fakeSpawn();
    const ca = fakeChild();
    const pa = killTree(ca.child, 'win32', a.spawnImpl, {}, 'SIGKILL');
    const wa = watch(pa, ca.kills);
    await drain();
    expect(wa.at()).toBeUndefined();
    a.procs[0].emit('exit', 128, null);
    await pa;
    expect(wa.at(), '落定时兜底已经做完').toEqual(['SIGKILL']);

    const b = fakeSpawn();
    const cb = fakeChild();
    const pb = killTree(cb.child, 'win32', b.spawnImpl, {});
    const wb = watch(pb, cb.kills);
    b.procs[0].emit('exit', null, 'SIGTERM');
    await pb;
    expect(wb.at()).toEqual([undefined]);
  });

  it("taskkill 发 'error'：兜底后落定、不拒绝；之后又来 exit 也只兜底一次", async () => {
    const { procs, spawnImpl } = fakeSpawn();
    const { child, kills } = fakeChild();
    const p = killTree(child, 'win32', spawnImpl, {}, 'SIGKILL');
    const w = watch(p, kills);
    await drain();
    expect(w.at()).toBeUndefined();
    procs[0].emit('error', new Error('spawn ENOENT'));
    await expect(p).resolves.toBeUndefined();
    expect(w.at()).toEqual(['SIGKILL']);
    procs[0].emit('exit', 1, null);
    await drain();
    expect(kills).toEqual(['SIGKILL']);
  });

  it('taskkill 同步抛错：兜底后落定、不拒绝', async () => {
    const { spawnImpl } = fakeSpawn('throw');
    const { child, kills } = fakeChild();
    const p = killTree(child, 'win32', spawnImpl, {}, 'SIGKILL');
    await expect(p).resolves.toBeUndefined();
    expect(kills).toEqual(['SIGKILL']);
  });

  it('根进程自己的 kill 抛错（兜底失败）：照样落定、不拒绝', async () => {
    const { procs, spawnImpl } = fakeSpawn();
    const child = { pid: 7, kill: () => { throw new Error('ESRCH'); } } as unknown as ChildProcess;
    const p = killTree(child, 'win32', spawnImpl, {});
    procs[0].emit('exit', 1, null);
    await expect(p).resolves.toBeUndefined();
    await expect(killTree(child, 'linux', spawnImpl, {})).resolves.toBeUndefined();
  });

  it('非 win32、win32 但没有 pid、根进程已退出：不等任何子进程，立即落定', async () => {
    const settledNow = async (p: Promise<unknown>): Promise<boolean> => {
      let done = false;
      void p.then(() => { done = true; });
      await drain();
      return done;
    };
    const lin = fakeSpawn();
    const cl = fakeChild();
    expect(await settledNow(killTree(cl.child, 'linux', lin.spawnImpl, {}, 'SIGKILL'))).toBe(true);
    expect(cl.kills).toEqual(['SIGKILL']);

    const nopid = fakeSpawn();
    const cn = fakeChild(null);
    expect(await settledNow(killTree(cn.child, 'win32', nopid.spawnImpl, {}))).toBe(true);
    expect(nopid.calls).toHaveLength(0);

    const gone = fakeSpawn();
    const exited = { pid: 15521, exitCode: 0, signalCode: null, kill: () => true } as unknown as ChildProcess;
    expect(await settledNow(killTree(exited, 'win32', gone.spawnImpl, {}))).toBe(true);
    expect(gone.calls).toHaveLength(0);
  });

  it('注入的 spawn 交回的东西挂不上监听（没有 .on）：兜底杀根后照样落定，不拒绝（W1b-5e）', async () => {
    // 生产里的 spawn 总是交回 ChildProcess；这里钉的是「从不拒绝」这句话本身：挂监听一抛，Promise 的执行器就把它变成拒绝，
    // 关停第 6 步虽然兜得住，不接返回值的调用点（shell interrupt、删除会话、MCP 握手失败）会冒出未处理的拒绝
    const spawnImpl = (() => ({})) as unknown as typeof spawn;
    const { child, kills } = fakeChild();
    await expect(killTree(child, 'win32', spawnImpl, {}, 'SIGKILL')).resolves.toBeUndefined();
    expect(kills, '挂不上监听就不知道 taskkill 何时跑完：先兜底杀根').toEqual(['SIGKILL']);
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
