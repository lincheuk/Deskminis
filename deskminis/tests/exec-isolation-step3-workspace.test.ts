/** 执行隔离第 3 步（三）：沙箱补全。
 *  ① 设置里的开关与环境变量强制；不支持标签的卷记 unsupported。
 *  ② agent 根以外的工作区：哪些不打、打了记下、不用了还原（src/minisd/proc/sandbox-workspace.ts）。
 *  ③ shell 接线：开不了（ready 落定为 false）时照原级别跑；第一次在工作区跑命令前打标签，打不了的说明附在输出前面、只说一次。
 *  ④ 引擎装配与设置页（源码守卫）。
 *  ⑤ Windows 上真跑：绑定到 agent 根以外的工作区，打标签之后沙箱里写得进去（已有文件也行），还原之后又写不了。 */
import { describe, it, expect, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { spawn } from 'node:child_process';
import { PersistentShell, ShellManager, makeShellTool } from '../src/minisd/tools/shell';
import type { PermissionRequest, ToolContext } from '../src/minisd/tools/types';
import { SANDBOX_LABEL_PS, SANDBOX_SETTING_KEY, applyLabels, parseLabelOutput, sandboxDecision, sandboxEnv, type LabelJob, type LabelResult } from '../src/minisd/proc/sandbox';
import { SANDBOX_LABELED_KEY, WorkspaceLabels, workspaceLabelSkip, workspaceNote } from '../src/minisd/proc/sandbox-workspace';

const WIN = process.platform === 'win32';
const SYS_ENV = { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', Temp: 'C:\\Users\\me\\AppData\\Local\\Temp' };
const ROOT = 'C:\\Users\\me\\AppData\\Roaming\\DeskMinis';
const AGENT = 'C:\\Users\\me\\AppData\\LocalLow\\DeskMinis';
const HOME = 'C:\\Users\\me';
const SYSDIRS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];

interface FakeChild extends EventEmitter { pid: number; exitCode: number | null; signalCode: null; killed: boolean; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
function fakeSpawn(): { calls: Array<{ args: string[] }>; spawnImpl: typeof spawn } {
  const calls: Array<{ args: string[] }> = [];
  const spawnImpl = ((_cmd: string, args: string[]) => {
    const ch = new EventEmitter() as FakeChild;
    Object.assign(ch, { pid: 4242, exitCode: null, signalCode: null, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    ch.kill = () => true;
    calls.push({ args: [...args] });
    queueMicrotask(() => ch.emit('spawn'));
    return ch;
  }) as unknown as typeof spawn;
  return { calls, spawnImpl };
}
const tick = (): Promise<void> => new Promise(r => setImmediate(r));
const scriptOf = (args: string[]): string => Buffer.from(args[args.length - 1], 'base64').toString('utf16le');

describe('① 开关与不支持标签的卷', () => {
  const root = '/data/root'; const agentRoot = '/data/agent';
  it('没设环境变量时看设置（第 4 步起默认开，只有 \'0\' 是关）；DESKMINIS_SANDBOX=1 / 0 强制开关', () => {
    expect(SANDBOX_SETTING_KEY).toBe('sandbox.enabled');
    const d = (env: Record<string, string>, setting?: string) => sandboxDecision({ env, platform: 'win32', root, agentRoot, setting });
    expect(d({})).toEqual({ enabled: true });
    expect(d({}, '')).toEqual({ enabled: true });
    expect(d({}, '0')).toEqual({ enabled: false, reason: 'off' });
    expect(d({}, '1')).toEqual({ enabled: true });
    expect(d({ DESKMINIS_SANDBOX: '0' }, '1')).toEqual({ enabled: false, reason: 'off' });
    expect(d({ DESKMINIS_SANDBOX: '1' }, '0')).toEqual({ enabled: true });
    expect(d({ DESKMINIS_SANDBOX: 'yes' }, '1')).toEqual({ enabled: true }); // 认不得的值当没设
    expect(sandboxDecision({ env: {}, platform: 'darwin', root, agentRoot, setting: '1' })).toEqual({ enabled: false, reason: 'not-windows' });
  });

  it('网络盘、不保存 ACL 的文件系统记 unsupported；命名管道与 clear 不看卷', () => {
    const jobs: LabelJob[] = [{ mode: 'protect', path: 'E:\\data' }, { mode: 'low', path: 'C:\\ws' }];
    expect(parseLabelOutput(jobs, '__MINIS_LABEL__ 0 unsupported\n__MINIS_LABEL__ 1 ok\n')).toEqual([
      { path: 'E:\\data', outcome: 'unsupported' }, { path: 'C:\\ws', outcome: 'ok' },
    ]);
    expect(SANDBOX_LABEL_PS).toContain("if ($mode -ne 'clear' -and -not $path.StartsWith('\\\\.\\')) {");
    expect(SANDBOX_LABEL_PS).toContain("if ($n::GetDriveTypeW($vol) -eq 4) { $res = 'unsupported'; throw 'x' }");
    expect(SANDBOX_LABEL_PS).toMatch(/-and -not \(\$fl -band 8\)\) \{ \$res = 'unsupported'; throw 'x' \}/);
    // 看卷在读现有标签之前：unsupported 的不会去写
    expect(SANDBOX_LABEL_PS.indexOf('GetVolumePathNameW($path')).toBeLessThan(SANDBOX_LABEL_PS.indexOf('$rc = $n::GetNamedSecurityInfoW($path'));
  });
});

describe('② 工作区标签', () => {
  const scope = { root: ROOT, agentRoot: AGENT, home: HOME, systemDirs: SYSDIRS, win: true };
  it('哪些不打：agent 根里、数据目录里、它们的上级、盘根、用户目录、系统目录；比较不分大小写', () => {
    expect(workspaceLabelSkip('c:\\users\\ME\\appdata\\locallow\\deskminis\\sessions\\s1\\workspace', scope)).toBe('agent-root');
    expect(workspaceLabelSkip(`${ROOT}\\sub`, scope)).toBe('data-root');
    expect(workspaceLabelSkip('C:\\Users\\me\\AppData', scope)).toBe('ancestor');
    expect(workspaceLabelSkip('D:\\', scope)).toBe('drive-root');
    expect(workspaceLabelSkip('C:\\Users\\Me', scope)).toBe('ancestor'); // 用户目录也是数据目录的上级
    expect(workspaceLabelSkip('C:\\Users\\other', { ...scope, home: 'C:\\Users\\other' })).toBe('home');
    expect(workspaceLabelSkip('C:\\Program Files\\App', scope)).toBe('system');
    expect(workspaceLabelSkip('c:\\windows\\temp', scope)).toBe('system');
    expect(workspaceLabelSkip('C:\\Users\\me\\Projects\\app', scope)).toBeUndefined();
    expect(workspaceLabelSkip('D:\\code\\app', scope)).toBeUndefined();
    expect(workspaceLabelSkip('\\\\server\\share\\app', scope)).toBeUndefined(); // 网络盘交给标签脚本判 unsupported
  });

  function harness(results: (jobs: LabelJob[]) => LabelResult[]) {
    let store: string[] = [];
    const calls: LabelJob[][] = [];
    const logs: string[] = [];
    const wl = new WorkspaceLabels({
      ...scope,
      apply: async jobs => { calls.push(jobs); return results(jobs); },
      tracked: { load: () => [...store], save: l => { store = [...l]; } },
      log: m => logs.push(m),
    });
    return { wl, calls, logs, tracked: () => store, setTracked: (l: string[]) => { store = l; } };
  }
  const ok = (jobs: LabelJob[]): LabelResult[] => jobs.map(j => ({ path: j.path, outcome: 'ok' as const }));

  it('打上了就记下，同一个目录只打一次（不分大小写）', async () => {
    const h = harness(ok);
    expect(await h.wl.prepare('D:\\code\\app')).toBeUndefined();
    expect(await h.wl.prepare('d:\\CODE\\app')).toBeUndefined();
    expect(h.calls).toEqual([[{ mode: 'low', path: 'D:\\code\\app' }]]);
    expect(h.tracked()).toEqual(['D:\\code\\app']);
  });

  it('原本就是这个标签：不记（以后也不去还原）', async () => {
    const h = harness(jobs => jobs.map(j => ({ path: j.path, outcome: 'same' as const })));
    expect(await h.wl.prepare('D:\\code\\app')).toBeUndefined();
    expect(h.tracked()).toEqual([]);
  });

  it('不打的、不支持的、失败的给说明；失败的下次再试', async () => {
    const h = harness(jobs => jobs.map(j => j.path.startsWith('E:') ? { path: j.path, outcome: 'unsupported' as const } : { path: j.path, outcome: 'err' as const, code: 5 }));
    expect(await h.wl.prepare(`${AGENT}\\sessions\\s1\\workspace`)).toBeUndefined();
    expect(await h.wl.prepare('C:\\Program Files\\App')).toBe(workspaceNote('C:\\Program Files\\App', 'system'));
    expect(h.calls).toEqual([]);
    expect(await h.wl.prepare('E:\\usb')).toBe(workspaceNote('E:\\usb', 'unsupported'));
    expect(await h.wl.prepare('E:\\usb')).toBe(workspaceNote('E:\\usb', 'unsupported'));
    expect(h.calls).toHaveLength(1);
    expect(await h.wl.prepare('D:\\x')).toBe(workspaceNote('D:\\x', { code: 5 }));
    expect(await h.wl.prepare('D:\\x')).toContain('错误码 5');
    expect(h.calls).toHaveLength(3);
    expect(h.tracked()).toEqual([]);
    expect(h.logs.some(l => l.includes('D:\\x'))).toBe(true);
    for (const n of [workspaceNote('a', 'system'), workspaceNote('a', 'unsupported'), workspaceNote('a', { code: 1 })]) expect(n).toContain('sandbox: false');
  });

  it('还原：只去掉记着的、不再用的；目录没了也算还原；别的失败留着下次再试；还原过的再用会重新打', async () => {
    const h = harness(jobs => jobs.map(j => j.path === 'D:\\gone' ? { path: j.path, outcome: 'err' as const, code: 3 }
      : j.path === 'D:\\locked' ? { path: j.path, outcome: 'err' as const, code: 5 } : { path: j.path, outcome: 'ok' as const }));
    await h.wl.prepare('D:\\a');
    h.setTracked([...h.tracked(), 'D:\\b', 'D:\\gone', 'D:\\locked']);
    expect(await h.wl.reconcile(['d:\\A'])).toEqual(['D:\\b', 'D:\\gone']);
    expect(h.calls[1]).toEqual([{ mode: 'clear', path: 'D:\\b' }, { mode: 'clear', path: 'D:\\gone' }, { mode: 'clear', path: 'D:\\locked' }]);
    expect(h.tracked()).toEqual(['D:\\a', 'D:\\locked']);
    expect(h.logs.some(l => l.includes('D:\\locked') && l.includes('错误码 5'))).toBe(true);
    // 全都不用了（沙箱关了）
    expect(await h.wl.reconcile([])).toEqual(['D:\\a']);
    expect(h.tracked()).toEqual(['D:\\locked']);
    await h.wl.prepare('D:\\a');
    expect(h.calls.at(-1)).toEqual([{ mode: 'low', path: 'D:\\a' }]);
  });

  it('没有要还原的不起 PowerShell；记录读不出来当空的', async () => {
    const h = harness(ok);
    expect(await h.wl.reconcile([])).toEqual([]);
    expect(h.calls).toEqual([]);
    const bad = new WorkspaceLabels({ ...scope, apply: async () => { throw new Error('x'); }, tracked: { load: () => { throw new Error('db'); }, save: () => {} } });
    expect(await bad.reconcile([])).toEqual([]);
    expect(await bad.prepare('D:\\x')).toBeUndefined(); // apply 抛了也不拒绝
  });

  it('打标签与还原排队：先排的先做完', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let store = ['D:\\old'];
    const wl = new WorkspaceLabels({
      ...scope,
      apply: async jobs => { order.push(`start ${jobs[0].mode}`); if (jobs[0].mode === 'low') await gate; order.push(`end ${jobs[0].mode}`); return jobs.map(j => ({ path: j.path, outcome: 'ok' as const })); },
      tracked: { load: () => [...store], save: l => { store = [...l]; } },
    });
    const p1 = wl.prepare('D:\\new');
    const p2 = wl.reconcile(['D:\\new']);
    await tick();
    expect(order).toEqual(['start low']);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start low', 'end low', 'start clear', 'end clear']);
    expect(store).toEqual(['D:\\new']);
  });
});

describe('③ shell 接线', () => {
  const env = sandboxEnv(AGENT);
  it('ready 落定为 false：不再算开了沙箱，驱动照原级别起', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const mgr = new ShellManager({ platform: 'win32', spawnImpl, sysEnv: SYS_ENV }, { env, ready: Promise.resolve(false) });
    void mgr.run('s1', 'C:\\ws', 'dir');
    await tick(); await tick(); await tick();
    expect(mgr.sandboxed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(scriptOf(calls[0].args)).not.toContain('__minis_lower');
  });

  it('开了沙箱：工作区说明同一会话同一目录只给一次；没开或开不了时不去打标签', async () => {
    const seen: string[] = [];
    const workspace = async (dir: string) => { seen.push(dir); return dir === 'C:\\Program Files\\x' ? 'NOTE' : undefined; };
    const mgr = new ShellManager({ platform: 'win32', sysEnv: SYS_ENV }, { env, ready: Promise.resolve(true), workspace });
    expect(await mgr.prepareWorkspace('s1', 'C:\\Program Files\\x')).toBe('NOTE');
    expect(await mgr.prepareWorkspace('s1', 'C:\\Program Files\\x')).toBeUndefined();
    expect(await mgr.prepareWorkspace('s2', 'C:\\Program Files\\x')).toBe('NOTE');
    expect(await mgr.prepareWorkspace('s1', 'D:\\ok')).toBeUndefined();
    expect(seen).toEqual(['C:\\Program Files\\x', 'C:\\Program Files\\x', 'C:\\Program Files\\x', 'D:\\ok']);

    const off = new ShellManager({ platform: 'win32', sysEnv: SYS_ENV });
    expect(await off.prepareWorkspace('s1', 'D:\\x')).toBeUndefined();
    const unavailable = new ShellManager({ platform: 'win32', sysEnv: SYS_ENV }, { env, ready: Promise.resolve(false), workspace });
    expect(await unavailable.prepareWorkspace('s1', 'D:\\y')).toBeUndefined();
    const linux = new ShellManager({ platform: 'linux', sysEnv: SYS_ENV }, { env, ready: Promise.resolve(true), workspace });
    expect(await linux.prepareWorkspace('s1', 'D:\\z')).toBeUndefined();
    expect(seen).not.toContain('D:\\y');
    expect(seen).not.toContain('D:\\z');
  });

  it('shell 工具：沙箱里跑之前先处理工作区，说明附在输出前面；沙箱外运行不处理', async () => {
    const prepared: string[] = [];
    const runs: Array<{ outside?: boolean }> = [];
    const fake = {
      sandboxed: true,
      cwdOf: () => undefined,
      interrupt: () => {},
      prepareWorkspace: async (_s: string, dir: string) => { prepared.push(dir); return '[命令隔离：说明]'; },
      run: async (_s: string, _c: string, _cmd: string, _t?: number, _e?: unknown, o?: { outside?: boolean }) => { runs.push({ outside: o?.outside }); return { output: 'OUT', exitCode: 0, durationMs: 1 }; },
    } as unknown as ShellManager;
    const ctx = {
      sessionId: 's1',
      paths: { workspaceOf: () => 'D:\\code\\app' },
      permissions: { decide: async (_r: PermissionRequest) => ({ decision: 'allow', via: 'user-once' }), check: async () => 'allow' },
    } as unknown as ToolContext;
    const tool = makeShellTool(fake);
    const r = await tool.execute({ command: 'npm test', tool_title: 't' }, ctx);
    expect(prepared).toEqual(['D:\\code\\app']);
    expect(r.output.startsWith('[命令隔离：说明]\nOUT')).toBe(true);
    const o = await tool.execute({ command: 'winget install x', tool_title: 't', sandbox: false }, ctx);
    expect(prepared).toHaveLength(1);
    expect(o.output.startsWith('OUT')).toBe(true);
    expect(runs).toEqual([{ outside: undefined }, { outside: true }]);
  });

  it('PersistentShell：ready 落定为 false 之后不再带降级', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell('C:\\ws', undefined, { platform: 'win32', spawnImpl, sysEnv: SYS_ENV }, undefined, { env, ready: Promise.resolve(false) });
    expect(sh.sandboxed).toBe(true); // 落定之前还算
    void sh.run('dir');
    await tick(); await tick(); await tick();
    expect(sh.sandboxed).toBe(false);
    expect(scriptOf(calls[0].args)).not.toContain('__minis_lower');
  });
});

describe('④ 引擎装配与设置页（源码守卫）', () => {
  const idx = readFileSync(resolve(__dirname, '..', 'src', 'minisd', 'index.ts'), 'utf8');
  it('设置开关读 settings 表；数据根 unsupported 时落定为开不了；工作区标签接到沙箱上', () => {
    expect(idx).toContain('const sandboxSetting = settings.get(SANDBOX_SETTING_KEY);');
    expect(idx).toMatch(/if \(results\[0\]\?\.outcome === 'unsupported'\) \{[\s\S]{0,300}return false;/);
    expect(idx).toContain('apply: jobs => applyLabels(jobs, procOpts, 600_000)');
    expect(idx).toContain('save: list => settings.set(SANDBOX_LABELED_KEY, JSON.stringify(list))');
    expect(SANDBOX_LABELED_KEY).toBe('sandbox.labeledWorkspaces');
  });
  it('启动时、改工作区之后还原不再用的标签；沙箱没开或开不了时全部还原', () => {
    expect(idx).toContain("const inUse = ok === true ? chat.listSessions().flatMap(x => x.workspaceRoot ? [x.workspaceRoot] : []) : [];");
    expect(idx.match(/reconcileWorkspaceLabels\(\);/g)?.length).toBe(3);
  });
  it('sandbox.setEnabled 只收布尔值、改了记审计；sandbox.status 说要不要重启', () => {
    expect(idx).toContain("if (typeof p?.enabled !== 'boolean') throw new Error('enabled 必须是 true 或 false');");
    expect(idx).toContain("if (prev !== p.enabled) audit.append('sandbox.setting', { enabled: p.enabled, prev });");
    expect(idx).toContain('restartNeeded: wantedNow !== sandboxWanted.enabled');
  });
  it('设置「权限」页有命令隔离开关，环境变量强制时开关不可用，写明重启后生效', () => {
    const vue = readFileSync(resolve(__dirname, '..', 'src', 'renderer', 'src', 'ui', 'settings', 'SecPermission.vue'), 'utf8');
    expect(vue).toContain('<span>命令隔离</span>');
    expect(vue).toContain('默认开启');
    expect(vue).toContain(':disabled="chat.sandbox.forced !== undefined"');
    expect(vue).toContain('chat.setSandboxEnabled(el.checked)');
    expect(vue).toContain('重启 DeskMinis 后生效');
    const store = readFileSync(resolve(__dirname, '..', 'src', 'renderer', 'src', 'stores', 'chat.ts'), 'utf8');
    expect(store).toContain("rpc.call<UiSandboxStatus>('sandbox.setEnabled', { enabled })");
  });
});

describe.runIf(WIN)('⑤ Windows 真跑：工作区标签', () => {
  const made: string[] = [];
  afterAll(async () => {
    await applyLabels(made.map(path => ({ mode: 'clear' as const, path })));
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('agent 根以外的工作区：打标签前写不了，打了之后新建、改已有文件都行，还原之后又写不了', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sbx-ws-'));
    made.push(base);
    const root = join(base, 'data'); const agentRoot = join(base, 'agent'); const ws = join(base, 'project');
    for (const d of [root, join(agentRoot, 'home'), join(ws, 'src')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(ws, 'src', 'old.txt'), 'OLD');
    expect((await applyLabels([{ mode: 'low', path: agentRoot }]))[0].outcome).toBe('ok');
    let store: string[] = [];
    const wl = new WorkspaceLabels({ root, agentRoot, win: true, apply: jobs => applyLabels(jobs), tracked: { load: () => store, save: l => { store = l; } } });
    const sh = new PersistentShell(ws, undefined, {}, undefined, { env: sandboxEnv(agentRoot), ready: Promise.resolve(true) });
    const run = (c: string) => sh.run(c, 60_000);
    try {
      await run("Set-Content -LiteralPath 'before.txt' -Value x");
      expect(existsSync(join(ws, 'before.txt'))).toBe(false);

      expect(await wl.prepare(ws)).toBeUndefined();
      expect(store).toEqual([ws]);
      expect((await run("Set-Content -LiteralPath 'after.txt' -Value x; 'wrote'")).output).toContain('wrote');
      expect(existsSync(join(ws, 'after.txt'))).toBe(true);
      await run("Set-Content -LiteralPath 'src\\old.txt' -Value NEW");
      expect(readFileSync(join(ws, 'src', 'old.txt'), 'utf8')).toContain('NEW');

      expect(await wl.reconcile([])).toEqual([ws]);
      expect(store).toEqual([]);
      await run("Set-Content -LiteralPath 'again.txt' -Value x");
      expect(existsSync(join(ws, 'again.txt'))).toBe(false);
      await run("Set-Content -LiteralPath 'after.txt' -Value changed");
      expect(readFileSync(join(ws, 'after.txt'), 'utf8')).not.toContain('changed');
    } finally {
      await sh.dispose('shutdown');
    }
  }, 180_000);
});
