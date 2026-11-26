/** 执行隔离第 3 步（一）：低完整性沙箱的核心（src/minisd/proc/sandbox.ts）。
 *  ① 开关、环境改道、标签输出的解析（各平台都跑）。
 *  ② shell 接线：开了沙箱时驱动带降级函数、降级排在归属之后；标签打完之前不起驱动；降级失败如实报出、不当成普通崩溃。
 *  ④ Windows 上真跑：打标签、驱动降到 Low 之后读不到也写不了数据目录，工作区和临时目录照常可写，git、node 照常能用。 */
import { describe, it, expect, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { spawn } from 'node:child_process';
import { PersistentShell, ShellManager, SANDBOX_OUTSIDE_NOTE, makeShellTool } from '../src/minisd/tools/shell';
import { PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest, ToolContext } from '../src/minisd/tools/types';
import { ProcSupervisor } from '../src/minisd/proc/owned';
import {
  LOWER_HOOK_PS, SANDBOX_LABEL_PS, SANDBOX_LOWER_PS, SANDBOX_NATIVE_PS, SANDBOX_REFUSED_EXIT, SANDBOX_REFUSED_TEXT,
  applyLabels, ensureSandboxDirs, labelInvocation, runLabelScript, overrideEnv, parseLabelOutput, sandboxDecision, sandboxEnv,
} from '../src/minisd/proc/sandbox';
import { ARM_HOOK_PS } from '../src/minisd/proc/own-script';

const WIN = process.platform === 'win32';
const SYS_ENV = { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', Temp: 'C:\\Users\\me\\AppData\\Local\\Temp', NPM_CONFIG_CACHE: 'C:\\npm' };

interface FakeChild extends EventEmitter { pid: number; exitCode: number | null; signalCode: null; killed: boolean; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
function fakeSpawn(): { calls: Array<{ args: string[]; env: Record<string, string>; child: FakeChild }>; spawnImpl: typeof spawn } {
  const calls: Array<{ args: string[]; env: Record<string, string>; child: FakeChild }> = [];
  const spawnImpl = ((_cmd: string, args: string[], o: { env: Record<string, string> }) => {
    const ch = new EventEmitter() as FakeChild;
    Object.assign(ch, { pid: 4242, exitCode: null, signalCode: null, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    ch.kill = () => true;
    calls.push({ args: [...args], env: o.env, child: ch });
    queueMicrotask(() => ch.emit('spawn'));
    return ch;
  }) as unknown as typeof spawn;
  return { calls, spawnImpl };
}
const tick = (): Promise<void> => new Promise(r => setImmediate(r));
const scriptOf = (args: string[]): string => Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
const SBX = (ready: Promise<boolean | void> = Promise.resolve()) => ({ env: sandboxEnv('C:\\Users\\me\\AppData\\LocalLow\\DeskMinis'), ready });

describe('① 开关、环境、标签输出', () => {
  const root = 'C:\\Users\\me\\AppData\\Roaming\\DeskMinis';
  const agentRoot = 'C:\\Users\\me\\AppData\\LocalLow\\DeskMinis';
  it('默认开（第 4 步）、DESKMINIS_SANDBOX=0 强制关、只在 Windows 上；agent 根与数据根重叠时不开', () => {
    expect(sandboxDecision({ env: {}, platform: 'win32', root, agentRoot })).toEqual({ enabled: true });
    expect(sandboxDecision({ env: { DESKMINIS_SANDBOX: '0' }, platform: 'win32', root, agentRoot })).toEqual({ enabled: false, reason: 'off' });
    expect(sandboxDecision({ env: {}, platform: 'win32', root, agentRoot, setting: '0' })).toEqual({ enabled: false, reason: 'off' });
    expect(sandboxDecision({ env: { DESKMINIS_SANDBOX: '1' }, platform: 'linux', root, agentRoot })).toEqual({ enabled: false, reason: 'not-windows' });
    if (WIN) {
      expect(sandboxDecision({ env: { DESKMINIS_SANDBOX: '1' }, platform: 'win32', root, agentRoot })).toEqual({ enabled: true });
      expect(sandboxDecision({ env: { DESKMINIS_SANDBOX: '1' }, platform: 'win32', root, agentRoot: root.toUpperCase() })).toEqual({ enabled: false, reason: 'agent-root-overlaps-data-root' });
    }
    const r = '/data/root';
    expect(sandboxDecision({ env: { DESKMINIS_SANDBOX: '1' }, platform: 'win32', root: r, agentRoot: r })).toEqual({ enabled: false, reason: 'agent-root-overlaps-data-root' });
    expect(sandboxDecision({ env: { DESKMINIS_SANDBOX: '1' }, platform: 'win32', root: r, agentRoot: `${r}/agent` })).toEqual({ enabled: false, reason: 'agent-root-overlaps-data-root' });
    expect(sandboxDecision({ env: { DESKMINIS_SANDBOX: '1' }, platform: 'win32', root: `${r}/x`, agentRoot: r })).toEqual({ enabled: false, reason: 'agent-root-overlaps-data-root' });
    expect(sandboxDecision({ env: { DESKMINIS_SANDBOX: '1' }, platform: 'win32', root: '/data/root', agentRoot: '/data/rootx' })).toEqual({ enabled: true });
  });

  it('TEMP、TMP 与常见缓存都指到 agent 根的 sandbox 目录下；覆盖时不分大小写去掉原值', () => {
    const env = sandboxEnv('/a');
    expect(Object.keys(env).sort()).toEqual(['GOCACHE', 'GOMODCACHE', 'NUGET_PACKAGES', 'PIP_CACHE_DIR', 'TEMP', 'TMP', 'YARN_CACHE_FOLDER', 'npm_config_cache'].sort());
    for (const v of Object.values(env)) expect(v.startsWith(join('/a', 'sandbox'))).toBe(true);
    expect(env.TEMP).toBe(join('/a', 'sandbox', 'tmp'));
    const out = overrideEnv({ Temp: 'x', NPM_CONFIG_CACHE: 'y', PATH: 'p' }, env);
    expect(Object.keys(out).filter(k => k.toUpperCase() === 'TEMP')).toEqual(['TEMP']);
    expect(Object.keys(out).filter(k => k.toUpperCase() === 'NPM_CONFIG_CACHE')).toEqual(['npm_config_cache']);
    expect(out.PATH).toBe('p');
    expect(overrideEnv({ A: '1' }, undefined)).toEqual({ A: '1' });
  });

  it('建好 sandbox 下的目录', () => {
    const d = mkdtempSync(join(tmpdir(), 'sbx-dirs-'));
    try {
      expect(ensureSandboxDirs(sandboxEnv(d))).toEqual([]);
      expect(existsSync(join(d, 'sandbox', 'tmp'))).toBe(true);
      expect(existsSync(join(d, 'sandbox', 'cache', 'npm'))).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('路径经环境变量按 UTF-8 base64 传，不进脚本文本；输出按序号对回，没报的记 err -1', () => {
    const jobs = [{ mode: 'protect' as const, path: 'C:\\用户\\数据' }, { mode: 'low' as const, path: 'D:\\x y' }, { mode: 'clear' as const, path: 'E:\\z' }];
    const inv = labelInvocation(jobs);
    expect(inv.script).toBe(SANDBOX_NATIVE_PS + SANDBOX_LABEL_PS);
    expect(inv.script).not.toContain('用户');
    expect(inv.jobsEnv.split('\n').map(l => l.split(' ')[0])).toEqual(['protect', 'low', 'clear']);
    expect(Buffer.from(inv.jobsEnv.split('\n')[0].split(' ')[1], 'base64').toString('utf8')).toBe('C:\\用户\\数据');
    expect(parseLabelOutput(jobs, '__MINIS_LABEL__ 0 ok\r\nnoise\n__MINIS_LABEL__ 1 err 5\n__MINIS_LABEL__ 7 ok\n')).toEqual([
      { path: 'C:\\用户\\数据', outcome: 'ok' }, { path: 'D:\\x y', outcome: 'err', code: 5 }, { path: 'E:\\z', outcome: 'err', code: -1 },
    ]);
    expect(parseLabelOutput(jobs.slice(0, 1), '__MINIS_LABEL__ 0 same\n')).toEqual([{ path: 'C:\\用户\\数据', outcome: 'same' }]);
  });

  it('标签：数据根 Medium + 不许读写，agent 根 Low，都继承给子目录与文件；已经是同一个标签的不重写', () => {
    expect(SANDBOX_LABEL_PS).toContain("protect = '(ML;OICI;NRNW;;;ME)'");
    expect(SANDBOX_LABEL_PS).toContain("low = '(ML;OICI;NW;;;LW)'");
    expect(SANDBOX_LABEL_PS).toMatch(/if \(\$same\) \{ \$res = 'same' \}/);
  });

  it('降级只降到 Low，读回确认；失败写说明、以 196 退出；跑完删掉两个函数', () => {
    expect(SANDBOX_LOWER_PS).toContain("SecurityIdentifier]::new('S-1-16-4096')");
    expect(SANDBOX_LOWER_PS).toContain("if ($got -ne 'S-1-16-4096') { throw 'x' }");
    expect(SANDBOX_LOWER_PS).toContain(`[Environment]::Exit(${SANDBOX_REFUSED_EXIT})`);
    expect(SANDBOX_LOWER_PS).toContain(SANDBOX_REFUSED_TEXT);
    expect(SANDBOX_LOWER_PS).toContain('$function:__minis_sbx_native = $null; $function:__minis_lower = $null');
  });
});

describe('② shell 接线', () => {
  it('没开沙箱：驱动脚本里没有降级，环境不改道', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell('C:\\ws', undefined, { platform: 'win32', spawnImpl, sysEnv: SYS_ENV });
    void sh.run('dir');
    await tick();
    expect(scriptOf(calls[0].args)).not.toContain('__minis_lower');
    expect(calls[0].env.Temp).toBe(SYS_ENV.Temp);
    expect(sh.sandboxed).toBe(false);
  });

  it('开了沙箱、有托管：归属在前、降级在后，都在执行命令之前；TEMP 与缓存改道', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const sup = new ProcSupervisor({ ownerPid: 1234, warn: () => {} });
    const sh = new PersistentShell('C:\\ws', { MINIS_CHAT_SESSION_ID: 's1' }, { platform: 'win32', spawnImpl, sysEnv: SYS_ENV, supervisor: sup }, { kind: 'shell', sessionId: 's1' }, SBX());
    void sh.run('dir');
    await tick(); await tick();
    expect(calls).toHaveLength(1);
    const s = scriptOf(calls[0].args);
    expect(s.indexOf('function __minis_sbx_native')).toBeGreaterThan(-1);
    expect(s.indexOf('function __minis_lower')).toBeLessThan(s.indexOf('while ($true)'));
    const arm = s.indexOf(ARM_HOOK_PS); const low = s.indexOf(LOWER_HOOK_PS); const exec = s.indexOf('[scriptblock]::Create($cmd)');
    expect(arm).toBeGreaterThan(s.indexOf('while ($true)'));
    expect(low).toBeGreaterThan(arm);
    expect(exec).toBeGreaterThan(low);
    const env = calls[0].env;
    expect(env.TEMP).toBe(join('C:\\Users\\me\\AppData\\LocalLow\\DeskMinis', 'sandbox', 'tmp'));
    expect(env.Temp).toBeUndefined();
    expect(env.NPM_CONFIG_CACHE).toBeUndefined();
    expect(env.npm_config_cache).toBeDefined();
    expect(env.MINIS_CHAT_SESSION_ID).toBe('s1');
    expect(sh.sandboxed).toBe(true);
  });

  it('开了沙箱、没有托管：只有降级那一行', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell('C:\\ws', undefined, { platform: 'win32', spawnImpl, sysEnv: SYS_ENV }, undefined, SBX());
    void sh.run('dir');
    await tick(); await tick();
    const s = scriptOf(calls[0].args);
    expect(s).not.toContain(ARM_HOOK_PS);
    expect(s.indexOf(LOWER_HOOK_PS)).toBeGreaterThan(s.indexOf('while ($true)'));
  });

  it('非 Windows 忽略沙箱', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell('/ws', undefined, { platform: 'linux', spawnImpl, sysEnv: SYS_ENV }, undefined, SBX());
    void sh.run('dir');
    await tick();
    expect(scriptOf(calls[0].args)).not.toContain('__minis_lower');
    expect(sh.sandboxed).toBe(false);
  });

  it('标签打完之前不起驱动，命令排着；打完再起', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    let release!: () => void;
    const ready = new Promise<void>(r => { release = r; });
    const mgr = new ShellManager({ platform: 'win32', spawnImpl, sysEnv: SYS_ENV }, SBX(ready));
    void mgr.run('s1', 'C:\\ws', 'dir');
    await tick(); await tick();
    expect(calls).toHaveLength(0);
    release();
    await tick(); await tick();
    expect(calls).toHaveLength(1);
    expect(scriptOf(calls[0].args)).toContain('__minis_lower');
  });

  it('打标签失败（ready 拒绝）也照样起驱动', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell('C:\\ws', undefined, { platform: 'win32', spawnImpl, sysEnv: SYS_ENV }, undefined, SBX(Promise.reject(new Error('x'))));
    void sh.run('dir');
    await tick(); await tick();
    expect(calls).toHaveLength(1);
  });

  it('降级失败：驱动以 196 退出，输出里说明命令没有执行，退出码 196', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const sh = new PersistentShell('C:\\ws', undefined, { platform: 'win32', spawnImpl, sysEnv: SYS_ENV }, undefined, SBX());
    const p = sh.run('Remove-Item x');
    await tick(); await tick();
    const ch = calls[0].child;
    ch.stdout.write(Buffer.from(`${SANDBOX_REFUSED_TEXT}（步骤 set，错误码 5）\r\n`, 'utf8'));
    await tick();
    ch.exitCode = SANDBOX_REFUSED_EXIT;
    ch.emit('close');
    const r = await p;
    expect(r.exitCode).toBe(SANDBOX_REFUSED_EXIT);
    expect(r.output).toContain('步骤 set，错误码 5');
    expect(r.output).toContain('[命令隔离启动失败，shell 已退出。');
    expect(r.output).toContain('设置「权限」里关掉「命令隔离」');
    expect(r.output).not.toContain('[shell 进程意外退出]');
  });
});

describe('② 在沙箱外运行', () => {
  const req = (detail: string, outside = true): PermissionRequest => ({ kind: 'shell', detail, sessionId: 'S1', toolTitle: 't', ...(outside ? { outsideSandbox: true as const } : {}) });

  it('完全访问档也弹卡；「本会话允许」只放这一次；和沙箱内同一条命令的授权分开', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    g.applyPreset('full');
    expect(await g.check(req('winget install x', false))).toBe('allow');
    expect(asked).toBe(0);
    expect(await g.check(req('winget install x'))).toBe('allow');
    expect(await g.check(req('winget install x'))).toBe('allow');
    expect(asked).toBe(2);
  });
  it('「每次确认」档：沙箱内批过「本会话允许」不覆盖沙箱外', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(req('npm i -g x', false))).toBe('allow');
    expect(await g.check(req('npm i -g x', false))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(req('npm i -g x'))).toBe('allow');
    expect(asked).toBe(2);
  });
  it('规划档直接拒；危险命令照旧拒，都不弹卡', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    g.applyPreset('plan');
    expect(await g.check(req('dir'))).toBe('deny');
    g.applyPreset('full');
    expect(await g.check(req('Remove-Item -Recurse C:\\x'))).toBe('deny');
    expect(asked).toBe(0);
  });

  const ctxOf = (asks: PermissionRequest[]): ToolContext => ({
    sessionId: 's1',
    paths: { workspaceOf: () => 'C:\\ws' },
    permissions: { decide: async (r: PermissionRequest) => { asks.push(r); return { decision: 'allow', via: 'user-once' }; }, check: async () => 'allow' },
  } as unknown as ToolContext);

  it('开了命令隔离：sandbox: false 的卡带 outsideSandbox 与说明，命令进不在沙箱里的那个 shell', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const mgr = new ShellManager({ platform: 'win32', spawnImpl, sysEnv: SYS_ENV }, SBX());
    expect(mgr.sandboxed).toBe(true);
    const tool = makeShellTool(mgr);
    const asks: PermissionRequest[] = [];
    void tool.execute({ command: 'winget install x', tool_title: 't', sandbox: false }, ctxOf(asks));
    await tick(); await tick(); await tick();
    expect(asks[0]).toMatchObject({ kind: 'shell', outsideSandbox: true, note: SANDBOX_OUTSIDE_NOTE });
    expect(calls).toHaveLength(1);
    expect(scriptOf(calls[0].args)).not.toContain('__minis_lower');
    expect(calls[0].env.Temp).toBe(SYS_ENV.Temp);
    void tool.execute({ command: 'dir', tool_title: 't' }, ctxOf(asks));
    await tick(); await tick(); await tick();
    expect(asks[1].outsideSandbox).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(scriptOf(calls[1].args)).toContain('__minis_lower');
  });

  it('没开命令隔离：sandbox: false 不起作用，卡与平常一样', async () => {
    const { spawnImpl } = fakeSpawn();
    const mgr = new ShellManager({ platform: 'win32', spawnImpl, sysEnv: SYS_ENV });
    expect(mgr.sandboxed).toBe(false);
    const asks: PermissionRequest[] = [];
    void makeShellTool(mgr).execute({ command: 'dir', tool_title: 't', sandbox: false }, ctxOf(asks));
    await tick(); await tick();
    expect(asks[0].outsideSandbox).toBeUndefined();
    expect(asks[0].note).toBeUndefined();
  });
});

describe('② 引擎装配（源码守卫）', () => {
  const idx = readFileSync(resolve(__dirname, '..', 'src', 'minisd', 'index.ts'), 'utf8');
  it('开了沙箱：数据根打 protect、agent 根打 low，标签打完之前 shell 等着；没开时 ShellManager 拿到 undefined', () => {
    expect(idx).toContain('const sandboxPlatform = procOpts.platform ?? process.platform;');
    expect(idx).toContain('sandboxDecision({ env: process.env, platform: sandboxPlatform, root, agentRoot: paths.agentRoot, setting: sandboxSetting })');
    expect(idx).toContain("const jobs: LabelJob[] = [{ mode: 'protect', path: root }, { mode: 'low', path: paths.agentRoot }];");
    expect(idx).toContain("if (bridgePipe !== undefined) jobs.push({ mode: 'pipe', path: bridgePipe });");
    expect(idx).toContain('applyLabels(jobs, procOpts)');
    expect(idx).toContain('shellSandbox = { env, ready, workspace: workspaceLabels ? dir => workspaceLabels.prepare(dir) : undefined };');
    expect(idx).toContain('new ShellManager(procOpts, shellSandbox)');
  });
});

describe.runIf(WIN)('④ Windows 真跑', () => {
  const made: string[] = [];
  afterAll(async () => {
    // 先去掉标签再删（Medium 进程删 Medium 标签的目录本来也行，这里只是还原）
    await applyLabels(made.map(path => ({ mode: 'clear' as const, path })));
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('数据目录读写都被挡；工作区、临时目录可写；git、node 能用；去掉标签后读得到', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sbx-real-'));
    made.push(base);
    const root = join(base, 'data');
    const agentRoot = join(base, 'agent');
    const ws = join(agentRoot, 'workspace');
    const nested = join(agentRoot, 'nested');
    const outside = join(base, 'outside');
    for (const d of [root, ws, nested, outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(root, 'secret.txt'), 'TOPSECRET-DATA');
    writeFileSync(join(nested, 'secret.txt'), 'TOPSECRET-NESTED');
    writeFileSync(join(outside, 'plain.txt'), 'PLAIN-OUTSIDE');

    const labels = await applyLabels([{ mode: 'protect', path: root }, { mode: 'low', path: agentRoot }, { mode: 'protect', path: nested }]);
    expect(labels.map(l => l.outcome)).toEqual(['ok', 'ok', 'ok']);
    // 第二次是同一个标签：不重写。不对时把系统读回来的 SDDL 带进失败信息
    const again = labelInvocation([{ mode: 'protect', path: root }]);
    const { spawnSync } = await import('node:child_process');
    const raw = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(again.script, 'utf16le').toString('base64')],
      { encoding: 'utf8', env: { ...process.env, MINIS_LABEL_JOBS: again.jobsEnv }, windowsHide: true });
    expect(raw.stdout, raw.stdout + raw.stderr).toMatch(/__MINIS_LABEL__ 0 same/);

    const env = sandboxEnv(agentRoot);
    expect(ensureSandboxDirs(env)).toEqual([]);
    const sup = new ProcSupervisor({ warn: () => {} });
    const sh = new PersistentShell(ws, undefined, { supervisor: sup }, { kind: 'shell', sessionId: 'sbx' }, { env, ready: Promise.resolve() });
    try {
      const run = (c: string) => sh.run(c, 60_000);
      const il = await run('whoami /groups');
      expect(il.output).toContain('S-1-16-4096');

      const read = await run(`Get-Content -LiteralPath '${join(root, 'secret.txt')}'`);
      expect(read.output).not.toContain('TOPSECRET-DATA');
      const list = await run(`(Get-ChildItem -LiteralPath '${root}' -ErrorAction Stop).Count`);
      expect(list.output).not.toMatch(/^\s*1\s*$/m);
      await run(`Set-Content -LiteralPath '${join(root, 'new.txt')}' -Value x`);
      expect(existsSync(join(root, 'new.txt'))).toBe(false);

      const nestedRead = await run(`Get-Content -LiteralPath '${join(nested, 'secret.txt')}'`);
      expect(nestedRead.output).not.toContain('TOPSECRET-NESTED');

      await run(`Set-Content -LiteralPath '${join(outside, 'w.txt')}' -Value x`);
      expect(existsSync(join(outside, 'w.txt'))).toBe(false);
      // 已知短板：没打标签的文件 Low 照样读得到
      expect((await run(`Get-Content -LiteralPath '${join(outside, 'plain.txt')}'`)).output).toContain('PLAIN-OUTSIDE');

      expect((await run("Set-Content -LiteralPath 'a.txt' -Value ok; 'wrote'")).output).toContain('wrote');
      expect(existsSync(join(ws, 'a.txt'))).toBe(true);
      const tmp = await run('$f = [IO.Path]::GetTempFileName(); $f; Remove-Item -LiteralPath $f');
      expect(tmp.exitCode).toBe(0);
      expect(tmp.output.toLowerCase()).toContain(env.TEMP.toLowerCase());

      const git = await run('git init -q repo; git -C repo -c user.name=t -c user.email=t@example.invalid commit --allow-empty -q -m t; git -C repo log --oneline | Measure-Object | ForEach-Object Count');
      expect(git.output).toMatch(/^\s*1\s*$/m);
      const node = await run(`node -e "require('fs').writeFileSync('n.txt','1')"`);
      expect(node.exitCode).toBe(0);
      expect(existsSync(join(ws, 'n.txt'))).toBe(true);

      expect((await applyLabels([{ mode: 'clear', path: root }]))[0].outcome).toBe('ok');
      expect((await run(`Get-Content -LiteralPath '${join(root, 'secret.txt')}'`)).output).toContain('TOPSECRET-DATA');
    } finally {
      await sh.dispose('shutdown');
    }
  }, 180_000);

  it('命名管道打上 Low 标签之后，沙箱里的进程连得上（windows-* 桥）', async () => {
    const net = await import('node:net');
    const pipe = `\\\\.\\pipe\\deskminis-sbx-test-${process.pid}`;
    let conns = 0;
    const server = net.createServer(sock => { conns++; sock.on('error', () => {}); sock.end('hi'); });
    await new Promise<void>(r => server.listen(pipe, r));
    const base = mkdtempSync(join(tmpdir(), 'sbx-pipe-'));
    made.push(base);
    const agentRoot = join(base, 'agent'); const ws = join(agentRoot, 'ws');
    mkdirSync(ws, { recursive: true });
    const sh = new PersistentShell(ws, undefined, {}, undefined, { env: sandboxEnv(agentRoot), ready: Promise.resolve() });
    const probe = `node -e "const s=require('net').connect(process.argv[1]);s.on('data',d=>{console.log('GOT '+d);s.destroy()});s.on('error',e=>{console.log('ERR '+e.code);process.exit(0)})" '${pipe}'`;
    try {
      const l = await applyLabels([{ mode: 'low', path: agentRoot }]);
      expect(l[0].outcome).toBe('ok');
      expect((await sh.run(probe, 60_000)).output).toMatch(/ERR (EACCES|EPERM)/);
      const r = await runLabelScript([{ mode: 'pipe', path: pipe }]);
      expect(r.results[0], `${JSON.stringify(r.results[0])}\n${r.stdout}`).toMatchObject({ outcome: 'ok' });
      expect((await sh.run(probe, 60_000)).output).toContain('GOT hi');
      expect((await sh.run(probe, 60_000)).output).toContain('GOT hi'); // 第二个实例也认这个标签
      expect(conns).toBeGreaterThanOrEqual(2);
    } finally {
      await sh.dispose('shutdown');
      await new Promise<void>(r => server.close(() => r()));
    }
  }, 180_000);
});
