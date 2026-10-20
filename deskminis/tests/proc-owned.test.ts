/**
 * F09 U 组：归属层的状态机与调用形态（假 spawn，各平台都跑）。
 * 这里钉的是引擎一侧怎么读标记、怎么记原因、什么时候停用、launcher 协议怎么回退；Windows 上作业对象是否真的收得住进程，
 * 由真机用例证明（proc-own-windows.test.ts、proc-lifecycle-process.test.ts），不拿这里的结果当 Windows 结论。
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { ChildProcess, spawn } from 'node:child_process';
import { ARM_HOOK_PS, MarkerScanner, PROC_MARKER, armPs, launcherPs, parseArmMarker, type ArmReport } from '../src/minisd/proc/own-script';
import { ProcSupervisor, spawnCommandOwned, type ProcJournal } from '../src/minisd/proc/owned';
import { PersistentShell, ShellManager, driverPs } from '../src/minisd/tools/shell';
import { TerminalSession, terminalDriverPs } from '../src/minisd/terminal';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const tick = (): Promise<void> => new Promise(r => setImmediate(r));
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const decode = (args: readonly string[]): string => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

class FakeChild extends EventEmitter {
  exitCode: number | null = null; signalCode: string | null = null; killed = false;
  stdin = Object.assign(new EventEmitter(), { written: [] as string[], destroyed: false, write(this: { written: string[] }, d: unknown) { this.written.push(String(d)); return true; } });
  stdout = Object.assign(new EventEmitter(), { setEncoding() { /* 假 */ } });
  stderr = Object.assign(new EventEmitter(), { readableEnded: false, destroyed: false, resume() { /* 假 */ }, setEncoding() { /* 假 */ } });
  constructor(public pid: number | undefined) { super(); }
  kill(): boolean { this.killed = true; return true; }
  err(text: string): void { this.stderr.emit('data', Buffer.from(text, 'utf8')); }
  exit(code: number | null): void { this.exitCode = code; this.stderr.readableEnded = true; this.emit('exit', code, null); this.emit('close', code, null); }
}
interface Spawned { file: string; args: string[]; opts: any; child: FakeChild }
function fakeSpawn(o: { failLauncher?: boolean } = {}): { impl: typeof spawn; calls: Spawned[]; roots(): Spawned[]; taskkills(): Spawned[] } {
  const calls: Spawned[] = []; let pid = 1000;
  const impl = ((file: string, args: string[], opts: unknown) => {
    if (o.failLauncher && /powershell\.exe$/i.test(file)) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const child = new FakeChild(++pid);
    calls.push({ file, args: [...args], opts, child });
    if (/taskkill\.exe$/i.test(file)) {
      // taskkill 真的会结束目标：让对应的假根退出，再让 taskkill 自己以 0 退出
      setImmediate(() => { calls.find(c => String(c.child.pid) === args[1])?.child.exit(1); child.exit(0); });
    } else queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { impl, calls, roots: () => calls.filter(c => !/taskkill\.exe$/i.test(c.file)), taskkills: () => calls.filter(c => /taskkill\.exe$/i.test(c.file)) };
}
function memJournal(): { j: ProcJournal; log: any[] } {
  const log: any[] = [];
  return { log, j: {
    opened: (id, meta, root) => { log.push({ what: 'opened', id, meta, root }); },
    protection: (id, p) => { log.push({ what: 'protection', id, ...p }); },
    stopRequested: (id, cause) => { log.push({ what: 'stop', id, cause }); },
    ended: (id, e) => { log.push({ what: 'ended', id, ...e }); },
  } };
}
const marker = (pid: number | undefined, rest = 'job=armed watch=1 prejob=1', tail = ''): string => `${PROC_MARKER} ${rest} pid=${pid} created=133${tail}\r\n`;
const sysEnv = { SystemRoot: 'C:\\Windows' };
function setup(o: { armTimeoutMs?: number; disabled?: string } = {}) {
  const sp = fakeSpawn(); const { j, log } = memJournal(); const warns: string[] = [];
  const sup = new ProcSupervisor({ ownerPid: 4242, armTimeoutMs: o.armTimeoutMs ?? 60_000, disabled: o.disabled, warn: m => { warns.push(m); } });
  sup.bind(j);
  const proc = { platform: 'win32', spawnImpl: sp.impl, sysEnv, supervisor: sup };
  return { sp, log, warns, sup, proc };
}
/** 起一个带 supervisor 的 shell 并写出第一条命令；返回驱动的假子进程。 */
async function startShell(s: ReturnType<typeof setup>, id = 's1', timeoutMs = 60_000) {
  const shell = new PersistentShell('C:\\ws', undefined, s.proc, { kind: 'shell', sessionId: id });
  const done = shell.run('echo hi', timeoutMs);
  await tick(); // run 是排队执行的：spawn 发生在下一拍
  return { shell, done, root: () => s.sp.roots()[s.sp.roots().length - 1] };
}

describe('U1 parseArmMarker', () => {
  it('armed / failed 各字段；坏行返回 undefined', async () => {
    expect(parseArmMarker(`${PROC_MARKER} job=armed watch=1 prejob=0 pid=12 created=133`)).toEqual({ job: 'armed', watch: true, prejob: false, pid: 12, created: '133' });
    expect(parseArmMarker(`${PROC_MARKER} job=armed watch=0 prejob=1 pid=12 created=133 target=77\r`)).toEqual({ job: 'armed', watch: false, prejob: true, pid: 12, created: '133', target: 77 });
    expect(parseArmMarker(`${PROC_MARKER} job=armed watch=1 prejob=1 pid=12 created=133 launch=failed code=2`)).toMatchObject({ job: 'armed', launchFailed: 2 });
    expect(parseArmMarker(`${PROC_MARKER} job=failed step=assign code=5 pid=12 created=133`)).toEqual({ job: 'failed', step: 'assign', code: 5, pid: 12, created: '133' });
    for (const bad of [
      'job=armed watch=1 prejob=1 pid=12 created=133', `${PROC_MARKER}job=armed`, `${PROC_MARKER} job=maybe pid=1 created=1`,
      `${PROC_MARKER} job=armed watch=2 prejob=1 pid=12 created=133`, `${PROC_MARKER} job=armed watch=1 prejob=1 pid=0 created=133`,
      `${PROC_MARKER} job=armed watch=1 prejob=1 pid=12`, `${PROC_MARKER} job=failed step=nope code=5 pid=12 created=1`,
      `${PROC_MARKER} job=failed step=assign pid=12 created=1`, `${PROC_MARKER} job=armed watch=1 prejob=1 pid=12 created=1 target=x`,
      `${PROC_MARKER} job=armed watch=1 watch=1 prejob=1 pid=12 created=1`, ` ${PROC_MARKER} job=armed watch=1 prejob=1 pid=12 created=1`,
    ]) expect(parseArmMarker(bad), bad).toBeUndefined();
  });
});

describe('U2 MarkerScanner', () => {
  const run = (chunks: string[]): { out: string; reports: ArmReport[] } => {
    const reports: ArmReport[] = []; const sc = new MarkerScanner(r => reports.push(r));
    let out = ''; for (const c of chunks) out += sc.feed(c);
    return { out: out + sc.flush(), reports };
  };
  const line = `${PROC_MARKER} job=armed watch=1 prejob=1 pid=7 created=1\r\n`;
  it('标记跨 chunk、前后夹着别的行：标记被摘掉，其余原样', async () => {
    const r = run(['#< CLIXML\r\n' + line.slice(0, 9), line.slice(9, 30), line.slice(30) + 'after\n']);
    expect(r.out).toBe('#< CLIXML\r\nafter\n');
    expect(r.reports).toHaveLength(1);
  });
  it('普通文本即到即透传（不等换行）；只有行首可能是标记前缀的那一小段被扣住', async () => {
    const reports: ArmReport[] = []; const sc = new MarkerScanner(r => reports.push(r));
    expect(sc.feed('compiling...')).toBe('compiling...');
    expect(sc.feed(' done\n__MIN')).toBe(' done\n');
    expect(sc.feed('OR not a marker\n')).toBe('__MINOR not a marker\n');
    expect(sc.feed('x ' + line)).toBe('x ' + line); // 不在行首的不是标记
    expect(reports).toEqual([]);
  });
  it('第二行标记也被摘掉；长得像但字段坏了的照常透传；没等到换行的半行在 flush 时交出', async () => {
    const r = run([line, 'mid\n', line, `${PROC_MARKER} job=armed bad\n`, PROC_MARKER + ' job=arm']);
    expect(r.reports).toHaveLength(2);
    expect(r.out).toBe(`mid\n${PROC_MARKER} job=armed bad\n${PROC_MARKER} job=arm`);
  });
});

describe('U3 脚本组成', () => {
  it('不带钩子的驱动脚本与 F09 之前逐字相同（基线的 sha256 钉在这里）', async () => {
    expect({ len: driverPs('').length, sha: sha(driverPs('')) }).toEqual({ len: 973, sha: '997ccf4b3761041fdde81645cc236a7e2ffaebbf7a9353bf5b6907e3a7c8baeb' });
    expect({ len: terminalDriverPs('').length, sha: sha(terminalDriverPs('')) }).toEqual({ len: 1362, sha: '260f977cc242e21b2f06bbec59b3b3043dda0ec3e4df97f50d3712c7cc0a3783' });
  });
  it('钩子排在读输入与判 EOF 之后、执行命令之前', async () => {
    const s = driverPs(ARM_HOOK_PS);
    const order = ['[Console]::In.ReadLine()', 'if ($null -eq $line) { break }', ARM_HOOK_PS, '[scriptblock]::Create($cmd)'].map(x => s.indexOf(x));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const t = terminalDriverPs(ARM_HOOK_PS);
    const to = ['[Console]::In.Read()', 'if ($__minis_ch -lt 0) { break }', ARM_HOOK_PS, '[scriptblock]::Create($__minis_cmd)'].map(x => t.indexOf(x));
    expect(to.every(i => i >= 0)).toBe(true);
    expect([...to].sort((a, b) => a - b)).toEqual(to);
    expect(s.replace(`  ${ARM_HOOK_PS}\n`, '')).toBe(driverPs(''));
  });
  it('armPs 只含定义、不含调用；作业只有 KILL_ON_JOB_CLOSE、不命名；自己的创建时间取 GetProcessTimes', async () => {
    const a = armPs(4242);
    // 去掉两个函数体之后什么都不剩：脚本顶层没有任何语句
    const top = a.split('\n').filter(l => !l.startsWith(' ') && l.trim() !== '');
    expect(top).toEqual(['function __minis_k32 {', '}', 'function __minis_arm {', '}']);
    for (const s of [a, launcherPs(4242)]) {
      expect(s).toContain('$M::WriteInt32($buf, 16, 0x2000)');
      expect(s).not.toMatch(/0x800\b|0x1000\b|0x3000\b|0x2800\b/i);
      expect(s).toContain('$k::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)');
      expect(s).toContain('$k::GetProcessTimes($self,');
      expect(s).toContain('[uint32]4242)');
      expect(s).toContain('[Environment]::Exit(197)');
      expect(Buffer.from(s, 'utf16le').toString('base64').length).toBeLessThan(30_000);
    }
    expect(Buffer.from(armPs(4242) + driverPs(ARM_HOOK_PS), 'utf16le').toString('base64').length).toBeLessThan(30_000);
    expect(Buffer.from(armPs(4242) + terminalDriverPs(ARM_HOOK_PS), 'utf16le').toString('base64').length).toBeLessThan(30_000);
    expect(() => armPs(0)).toThrow(); expect(() => armPs(1.5)).toThrow(); expect(() => launcherPs(-1)).toThrow();
  });
  it('launcher：等放行行 → 归属 → CreateProcessW（挂起创建，0x4）→ 写带 target= 的标记 → ResumeThread；归属失败不启动目标', async () => {
    const s = launcherPs(4242);
    const order = ['$s.ReadByte()', 'step=go', '$k::AssignProcessToJobObject(', 'if (-not $armed)', '$k::CreateProcessW(', "' target=' + $tp", '$k::ResumeThread($ht)', '$k::WaitForSingleObject($hp'].map(x => s.indexOf(x));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(s).toContain('$true, [uint32]0x4, [IntPtr]::Zero');
    expect(s).toMatch(/if \(-not \$armed\) \{ \[Console\]::Error\.WriteLine\([^\n]+\); \[Environment\]::Exit\(197\) \}/);
    expect(s).toContain("launch=failed code=' + $M::GetLastWin32Error()); [Environment]::Exit(198)");
    for (const n of ['MINIS_OWN_NONCE', 'MINIS_OWN_CMDLINE', 'MINIS_OWN_PSMP_SET', 'MINIS_OWN_PSMP', 'MINIS_OWN_COMPAT_SET', 'MINIS_OWN_COMPAT']) expect(s).toContain(`'${n}'`);
    expect(s).not.toContain('-ExecutionPolicy');
  });
});

describe('U4 shell / 终端 + supervisor', () => {
  it('spawn 后登记；带前导的脚本；标记 → job、status 变 active；取消 → cancel，回收形态不变', async () => {
    const s = setup(); const { shell, done, root } = await startShell(s);
    expect(s.sp.calls).toHaveLength(1);
    expect(root().file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(root().args.slice(0, 6)).toEqual(['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    expect(decode(root().args)).toBe(armPs(4242) + driverPs(ARM_HOOK_PS));
    expect(s.log[0]).toMatchObject({ what: 'opened', meta: { kind: 'shell', sessionId: 's1' }, root: { pid: root().child.pid } });
    expect(s.sup.status).toEqual({ state: 'untested' });
    expect(s.sup.open()[0]).toMatchObject({ protection: 'pending', kind: 'shell', sessionId: 's1' });
    root().child.err(marker(root().child.pid));
    expect(s.sup.status).toEqual({ state: 'active' });
    expect(s.log.find(l => l.what === 'protection')).toMatchObject({ protection: 'job', preJob: true, root: { pid: root().child.pid, createdAt: '133' } });
    shell.interrupt(); shell.interrupt('timeout'); // 原因只记第一次
    expect(s.log.filter(l => l.what === 'stop')).toEqual([expect.objectContaining({ cause: 'cancel' })]);
    expect(s.sp.taskkills().map(t => ({ file: t.file, args: t.args, opts: t.opts }))).toEqual([
      { file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/pid', String(root().child.pid), '/T', '/F'], opts: { stdio: 'ignore', windowsHide: true } }]);
    expect((await done).exitCode).toBe(129);
    await tick();
    expect(s.log.find(l => l.what === 'ended')).toMatchObject({ kind: 'stopped', exitCode: 1 });
    expect(s.sup.open()).toEqual([]);
  });
  it('超时 → timeout；dispose → session-deleted；disposeAll → shutdown；根自己退出 → exited', async () => {
    const a = setup(); const sa = await startShell(a, 's1', 20);
    expect((await sa.done).exitCode).toBe(124);
    expect(a.log.find(l => l.what === 'stop')).toMatchObject({ cause: 'timeout' });
    const b = setup(); const sb = await startShell(b); void sb.shell.dispose();
    expect(b.log.find(l => l.what === 'stop')).toMatchObject({ cause: 'session-deleted' });
    const c = setup(); const mgr = new ShellManager(c.proc); void mgr.run('s9', 'C:\\ws', 'x'); await tick(); void mgr.disposeAll();
    expect(c.log.find(l => l.what === 'opened')).toMatchObject({ meta: { kind: 'shell', sessionId: 's9' } });
    expect(c.log.find(l => l.what === 'stop')).toMatchObject({ cause: 'shutdown' });
    const d = setup(); const sd = await startShell(d); sd.root().child.err(marker(sd.root().child.pid)); sd.root().child.exit(7);
    expect((await sd.done).exitCode).toBe(129);
    expect(d.log.find(l => l.what === 'ended')).toMatchObject({ kind: 'exited', exitCode: 7 });
    expect(d.log.some(l => l.what === 'stop')).toBe(false);
    expect(d.sup.status.state).toBe('active'); // 出过标记之后退出不算机制失败
    sd.shell.interrupt(); // 根已退出：不记原因、不起 taskkill
    expect(d.sp.taskkills()).toEqual([]);
    expect(d.log.some(l => l.what === 'stop')).toBe(false);
  });
  it('终端：标记行不进输出，其余 stderr 文本照常并入；dispose 的原因', async () => {
    const s = setup(); let out = '';
    const term = new TerminalSession('C:\\ws', d => { out += d; }, {}, s.proc, { kind: 'terminal', sessionId: 't1' });
    term.attach(); term.input('dir\r');
    const root = s.sp.roots()[0];
    expect(decode(root.args)).toBe("$ProgressPreference = 'SilentlyContinue'\n" + armPs(4242) + terminalDriverPs(ARM_HOOK_PS));
    root.child.err('warn: 中'); root.child.err('文\r\n' + marker(root.child.pid) + 'tail\r\n');
    expect(out).toBe('warn: 中文\r\ntail\r\n');
    expect(s.sup.open()[0]).toMatchObject({ kind: 'terminal', sessionId: 't1', protection: 'job' });
    void term.dispose();
    expect(s.log.find(l => l.what === 'stop')).toMatchObject({ cause: 'session-deleted' });
  });
  it('U7 不传 supervisor：shell 脚本不变，终端带进度设置前缀，stdin 的内容形态不变', async () => {
    const sp = fakeSpawn();
    const shell = new PersistentShell('C:\\ws', undefined, { platform: 'win32', spawnImpl: sp.impl, sysEnv }, { kind: 'shell', sessionId: 's1' });
    void shell.run('echo hi'); await tick();
    expect(decode(sp.calls[0].args)).toBe(driverPs(''));
    expect(sp.calls[0].child.stdin.written[0]).toMatch(/^[0-9a-f]{8} ZWNobyBoaQ==\n$/);
    const term = new TerminalSession('C:\\ws', () => undefined, {}, { platform: 'win32', spawnImpl: sp.impl, sysEnv }, { kind: 'terminal', sessionId: 't1' });
    term.attach();
    expect(decode(sp.calls[1].args)).toBe("$ProgressPreference = 'SilentlyContinue'\n" + terminalDriverPs(''));
    // 已停用的 supervisor 同样用原来的脚本，树记 none
    const s = setup({ disabled: 'disabled-by-env' }); await startShell(s);
    expect(decode(s.sp.roots()[0].args)).toBe(driverPs(''));
    expect(s.log.find(l => l.what === 'protection')).toMatchObject({ protection: 'none', reason: 'disabled-by-env' });
    expect(s.sup.status).toEqual({ state: 'disabled', reason: 'disabled-by-env' });
  });
});

describe('U5 归属结论', () => {
  it('watch=0 → none / no-owner-watch；pid 不符 → none / marker-invalid；都不算 active', async () => {
    const a = setup(); const sa = await startShell(a); sa.root().child.err(marker(sa.root().child.pid, 'job=armed watch=0 prejob=1'));
    expect(a.sup.open()[0]).toMatchObject({ protection: 'none', protectionReason: 'no-owner-watch' });
    expect(a.sup.status).toEqual({ state: 'untested', lastFailure: 'no-owner-watch' });
    const b = setup(); const sb = await startShell(b); sb.root().child.err(marker(999_999));
    expect(b.sup.open()[0]).toMatchObject({ protection: 'none', protectionReason: 'marker-invalid' });
    expect(b.sup.status.state).toBe('untested');
    sb.root().child.err(marker(sb.root().child.pid)); // 结论只生效一次
    expect(b.sup.open()[0].protection).toBe('none');
  });
  it('写了第一条命令、到时限没有标记 → none / no-marker；迟到的有效标记把它升成 job，pid 不符的不升', async () => {
    const a = setup({ armTimeoutMs: 20 }); const sa = await startShell(a);
    await sleep(60);
    expect(a.sup.open()[0]).toMatchObject({ protection: 'none', protectionReason: 'no-marker' });
    expect(a.sup.status).toEqual({ state: 'untested', lastFailure: 'no-marker' });
    sa.root().child.err(marker(sa.root().child.pid));
    expect(a.sup.open()[0].protection).toBe('job');
    expect(a.sup.status).toEqual({ state: 'active' });
    const b = setup({ armTimeoutMs: 20 }); const sb = await startShell(b);
    await sleep(60);
    sb.root().child.err(marker(999_999));
    expect(b.sup.open()[0].protection).toBe('none');
  });
});

describe('U6 停用的触发点', () => {
  it('job=failed（step 不是 go）→ 停用；之后再起的驱动不带前导', async () => {
    const s = setup(); const a = await startShell(s); a.root().child.err(marker(a.root().child.pid, 'job=failed step=assign code=5'));
    expect(s.sup.status).toMatchObject({ state: 'disabled', reason: 'arm-failed:assign:5' });
    expect(s.warns.join('\n')).toContain('进程托管已停用（arm-failed:assign:5）');
    await startShell(s, 's2');
    expect(decode(s.sp.roots()[1].args)).toBe(driverPs(''));
    expect(s.sup.wants('win32')).toBe(false);
  });
  it('没出标记就自己退出 → root-exited-before-arm；先 stop 再退出 → 不停用', async () => {
    const a = setup(); const sa = await startShell(a); sa.root().child.exit(1);
    expect(a.sup.status).toMatchObject({ state: 'disabled', reason: 'root-exited-before-arm' });
    expect(a.log.find(l => l.what === 'protection')).toMatchObject({ protection: 'none', reason: 'exited-before-arm' });
    const b = setup(); const sb = await startShell(b); sb.shell.interrupt(); await sb.done; await tick();
    expect(b.sup.status.state).toBe('untested');
  });
  it('没出标记、没 stop 过、自己以 197 退出 → owner-check-misfired；出过标记之后的 197、先 stop 再 197 → 不停用', async () => {
    const a = setup(); const sa = await startShell(a); sa.root().child.exit(197);
    expect(a.sup.status).toMatchObject({ state: 'disabled', reason: 'owner-check-misfired' });
    await startShell(a, 's2');
    expect(decode(a.sp.roots()[1].args)).toBe(driverPs(''));
    const b = setup(); const sb = await startShell(b); sb.root().child.err(marker(sb.root().child.pid)); sb.root().child.exit(197);
    expect(b.sup.status.state).toBe('active');
    const c = setup(); const sc = await startShell(c);
    void c.sup; sc.shell.interrupt(); sc.root().child.exit(197); await tick();
    expect(c.sup.status.state).toBe('untested');
  });
  it('起来很久之后、没写过输入就以别的退出码退出 → 不停用', async () => {
    let now = 1_000_000;
    const sp = fakeSpawn(); const sup = new ProcSupervisor({ ownerPid: 4242, now: () => now, warn: () => undefined });
    const term = new TerminalSession('C:\\ws', () => undefined, {}, { platform: 'win32', spawnImpl: sp.impl, sysEnv, supervisor: sup }, { kind: 'terminal', sessionId: 't' });
    term.attach(); // 没有输入
    now += 11_000;
    sp.calls[0].child.exit(1);
    expect(sup.status.state).toBe('untested');
  });
  it('一棵树停在 no-marker 结束 → 不停用；连续第二棵 → arm-unresponsive；中间有一棵出过标记则重新计数', async () => {
    const s = setup({ armTimeoutMs: 10 });
    const one = async (id: string, withMarker: boolean): Promise<void> => {
      const x = await startShell(s, id);
      if (withMarker) x.root().child.err(marker(x.root().child.pid)); else await sleep(40);
      x.shell.interrupt(); await x.done; await tick();
    };
    await one('a', false);
    expect(s.sup.status.state).toBe('untested');
    await one('b', true);
    await one('c', false);
    expect(s.sup.status.state).not.toBe('disabled');
    await one('d', false);
    expect(s.sup.status).toMatchObject({ state: 'disabled', reason: 'arm-unresponsive' });
  });
});

describe('U8 launcher 协议（spawnCommandOwned）', () => {
  const meta = { kind: 'mcp' as const, ownerRef: 'srv', toolPrefix: 'mcp__srv__' };
  function go(s: ReturnType<typeof setup>, o: { command?: string; args?: string[]; deadlineMs?: number } = {}) {
    const directChild = new FakeChild(5555);
    const direct = vi.fn(async () => directChild as unknown as ChildProcess);
    const p = spawnCommandOwned({ meta, command: o.command ?? 'C:\\tools\\srv.exe', args: o.args ?? ['a b'], cwd: 'C:\\ws', env: { PSModulePath: 'X', FOO: '1' }, direct, deadlineMs: o.deadlineMs ?? 60_000 }, s.proc);
    return { p, direct, directChild, launcher: () => s.sp.roots()[s.sp.roots().length - 1] };
  }
  it('先写放行行、等到标记才返回；环境带六个 MINIS_OWN_*；不带 -ExecutionPolicy', async () => {
    const s = setup(); const g = go(s);
    let settled = false; void g.p.then(() => { settled = true; });
    await tick();
    const l = g.launcher();
    expect(l.args.slice(0, 4)).toEqual(['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand']);
    expect(decode(l.args)).toBe(launcherPs(4242));
    expect(l.opts).toMatchObject({ shell: false, cwd: 'C:\\ws', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(l.opts.env).toMatchObject({ FOO: '1', MINIS_OWN_CMDLINE: 'C:\\tools\\srv.exe "a b"', MINIS_OWN_PSMP_SET: '1', MINIS_OWN_PSMP: 'X' });
    expect(l.child.stdin.written).toEqual([l.opts.env.MINIS_OWN_NONCE + '\n']);
    expect(l.opts.env.MINIS_OWN_NONCE).toMatch(/^[0-9a-f]{16}$/);
    expect(settled).toBe(false);
    l.child.err(marker(l.child.pid, 'job=armed watch=1 prejob=1', ' target=77') + 'early-text');
    const r = await g.p;
    expect(r.child).toBe(l.child);
    expect(r.tree!.protection()).toBe('job');
    expect(g.direct).not.toHaveBeenCalled();
    let tail = ''; r.tree!.onStderr(t => { tail += t; });
    expect(tail).toBe('early-text'); // 订阅之前到的文本补发，标记行不在里面
    expect(s.log.find(x => x.what === 'protection')).toMatchObject({ protection: 'job', targetPid: 77 });
  });
  it('launch=failed → 恰好直起一次、原样返回它的结果，不停用；直起拒绝则原样抛', async () => {
    const s = setup(); const g = go(s); await tick();
    const l = g.launcher(); l.child.err(marker(l.child.pid, 'job=armed watch=1 prejob=1', ' launch=failed code=2')); l.child.exit(198);
    const r = await g.p;
    expect(r.child).toBe(g.directChild);
    expect(g.direct).toHaveBeenCalledTimes(1);
    expect(s.sp.taskkills()).toEqual([]);
    expect(s.sup.status.state).not.toBe('disabled');
    expect(s.log.filter(x => x.what === 'protection').map(x => x.reason)).toEqual(['launch-failed:2', 'fallback:launch-failed:2']);
    const s2 = setup(); const boom = new Error('命令不存在: x');
    const p2 = spawnCommandOwned({ meta, command: 'C:\\t\\x.exe', args: [], env: {}, direct: async () => { throw boom; }, deadlineMs: 60_000 }, s2.proc);
    await tick(); const l2 = s2.sp.roots()[0]; l2.child.err(marker(l2.child.pid, 'job=armed watch=1 prejob=1', ' launch=failed code=2')); l2.child.exit(198);
    await expect(p2).rejects.toBe(boom);
  });
  it('job=failed（归属失败）→ 直起并停用；没读到放行行（step=go）→ 直起、不停用；没出标记以 197 退出 → 直起并停用', async () => {
    const a = setup(); const ga = go(a); await tick();
    ga.launcher().child.err(marker(ga.launcher().child.pid, 'job=failed step=create code=8')); ga.launcher().child.exit(197);
    expect((await ga.p).child).toBe(ga.directChild);
    expect(a.sup.status).toMatchObject({ state: 'disabled', reason: 'arm-failed:create:8' });
    const b = setup(); const gb = go(b); await tick();
    gb.launcher().child.err(marker(gb.launcher().child.pid, 'job=failed step=go code=0')); gb.launcher().child.exit(197);
    expect((await gb.p).tree!.protection()).toBe('none');
    expect(b.sup.status.state).not.toBe('disabled');
    expect(b.log.filter(x => x.what === 'protection').map(x => x.reason)).toEqual(['launcher-not-released', 'fallback:launcher-not-released']);
    const c = setup(); const gc = go(c); await tick();
    gc.launcher().child.exit(197);
    expect((await gc.p).child).toBe(gc.directChild);
    expect(gc.direct).toHaveBeenCalledTimes(1);
    expect(c.sup.status).toMatchObject({ state: 'disabled', reason: 'owner-check-misfired' });
  });
  it('等满 armTimeoutMs → no-marker：对 launcher 起 taskkill、等它退出、再直起；连续两次停用', async () => {
    const s = setup({ armTimeoutMs: 20 });
    const g = go(s); const r = await g.p;
    expect(r.child).toBe(g.directChild);
    expect(s.sp.taskkills().map(t => t.args[1])).toEqual([String(g.launcher().child.pid)]);
    expect(g.launcher().child.exitCode).not.toBeNull(); // launcher 死了才直起
    expect(s.log.filter(x => x.what === 'protection').map(x => x.reason)).toEqual(['no-marker', 'fallback:no-marker']);
    expect(s.sup.status.state).not.toBe('disabled');
    await go(s).p;
    expect(s.sup.status).toMatchObject({ state: 'disabled', reason: 'arm-unresponsive' });
    const g3 = go(s); await g3.p; // 停用之后不再起 launcher
    expect(s.sp.roots()).toHaveLength(2);
    expect(g3.direct).toHaveBeenCalledTimes(1);
  });
  it('被更小的 deadlineMs 截断 → launcher-deadline：直起的树是 fallback:launcher-deadline，连续多次也不停用、不计数', async () => {
    const s = setup({ armTimeoutMs: 5_000 });
    for (let i = 0; i < 3; i++) await go(s, { deadlineMs: 15 }).p;
    expect(s.log.filter(x => x.what === 'protection').map(x => x.reason)).toEqual(Array(3).fill(['launcher-deadline', 'fallback:launcher-deadline']).flat());
    expect(s.sup.status.state).not.toBe('disabled');
    expect(s.sup.strikes).toBe(0);
  });
  it('launcher spawn 抛错 → 直起；超长命令行、带路径的批处理目标 → 不起 launcher；x.cmdx、x.cmd.exe → 起 launcher', async () => {
    const sp = fakeSpawn({ failLauncher: true }); const sup = new ProcSupervisor({ ownerPid: 4242, warn: () => undefined });
    const { j, log } = memJournal(); sup.bind(j);
    const dc = new FakeChild(5555);
    const r = await spawnCommandOwned({ meta, command: 'C:\\t\\x.exe', args: [], env: {}, direct: async () => dc as unknown as ChildProcess, deadlineMs: 1000 }, { platform: 'win32', spawnImpl: sp.impl, sysEnv, supervisor: sup });
    expect(r.child).toBe(dc);
    expect(log.find(x => x.what === 'protection')).toMatchObject({ reason: 'fallback:launcher-spawn-failed' });
    const s = setup();
    for (const [command, reason] of [['C:\\t\\x.cmd', 'batch-target'], ['C:\\t\\X.CMD', 'batch-target'], ['C:/t/x.Bat', 'batch-target'], ['C:\\t\\x.cmd.', 'batch-target'],
      ['C:\\t\\x.bat.', 'batch-target'], ['C:\\t\\x.cmd ', 'batch-target'], ['C:\\t\\x.cmd. .', 'batch-target']] as const) {
      const g = go(s, { command }); await g.p;
      expect(g.direct, command).toHaveBeenCalledTimes(1);
      expect(s.log[s.log.length - 1], command).toMatchObject({ what: 'protection', protection: 'none', reason });
    }
    const long = go(s, { args: ['x'.repeat(33_000)] }); await long.p;
    expect(s.log[s.log.length - 1]).toMatchObject({ reason: 'cmdline-too-long' });
    expect(s.sp.roots()).toEqual([]);
    for (const command of ['C:\\t\\x.cmdx', 'C:\\t\\x.cmd.exe']) {
      const g = go(s, { command }); await tick();
      expect(decode(g.launcher().args), command).toBe(launcherPs(4242));
      g.launcher().child.err(marker(g.launcher().child.pid, 'job=armed watch=1 prejob=1', ' target=9')); await g.p;
    }
    expect(s.sp.roots()).toHaveLength(2);
    // 裸名：命令行第一段是 cmd.exe 的绝对路径
    const bare = go(s, { command: 'npx', args: ['-y', 'pkg'] }); await tick();
    expect(bare.launcher().opts.env.MINIS_OWN_CMDLINE).toBe('C:\\Windows\\System32\\cmd.exe /d /s /c npx -y pkg');
    bare.launcher().child.err(marker(bare.launcher().child.pid, 'job=armed watch=0 prejob=1', ' target=9'));
    expect((await bare.p).tree!.protection()).toBe('none'); // watch=0：目标已在作业里，照样返回 launcher，但不报 job
    expect(bare.direct).not.toHaveBeenCalled();
  });
  it('没有 supervisor：直接 direct()，不登记；非 win32：直起并记 not-windows', async () => {
    const dc = new FakeChild(1);
    expect(await spawnCommandOwned({ meta, command: 'x', args: [], env: {}, direct: async () => dc as unknown as ChildProcess, deadlineMs: 1 }, {})).toEqual({ child: dc });
    const s = setup();
    const r = await spawnCommandOwned({ meta, command: 'x', args: [], env: {}, direct: async () => dc as unknown as ChildProcess, deadlineMs: 1 }, { ...s.proc, platform: 'linux' });
    expect(r.tree!.protection()).toBe('none');
    expect(s.log.find(x => x.what === 'protection')).toMatchObject({ reason: 'not-windows' });
    expect(s.sp.calls).toEqual([]);
  });
});

describe('U10 记账失败不拖垮回收', () => {
  it('账本每个方法都抛：adopt、标记、stop、退出照常；读 exitCode 抛错时 stop 的同步抛错照旧往外传', async () => {
    const sp = fakeSpawn(); const warns: string[] = [];
    const sup = new ProcSupervisor({ ownerPid: 4242, warn: m => { warns.push(m); } });
    const boom = (): never => { throw new Error('库坏了'); };
    sup.bind({ opened: boom, protection: boom, stopRequested: boom, ended: boom });
    const proc = { platform: 'win32', spawnImpl: sp.impl, sysEnv, supervisor: sup };
    const shell = new PersistentShell('C:\\ws', undefined, proc, { kind: 'shell', sessionId: 's' });
    const done = shell.run('x'); await tick();
    sp.calls[0].child.err(marker(sp.calls[0].child.pid));
    expect(sup.status.state).toBe('active');
    shell.interrupt();
    expect(sp.taskkills()).toHaveLength(1);
    expect((await done).exitCode).toBe(129);
    expect(warns.length).toBeGreaterThan(0);
    const poisoned = new FakeChild(77);
    Object.defineProperty(poisoned, 'exitCode', { get() { throw new Error('读 exitCode 抛错'); } });
    const tree = sup.adopt(poisoned as unknown as ChildProcess, { kind: 'shell', sessionId: 'p' }, proc, { armed: false, reason: 'test' });
    expect(() => tree.stop('shutdown', 'SIGKILL')).toThrow('读 exitCode 抛错');
  });
  it('spawn 失败（没有 pid）：记 spawn-failed，stop 仍走 killTree 的兜底', async () => {
    const s = setup();
    const dead = new FakeChild(undefined);
    const tree = s.sup.adopt(dead as unknown as ChildProcess, { kind: 'mcp', ownerRef: 'x' }, s.proc, { armed: false, reason: 'test' });
    expect(s.log.find(l => l.what === 'ended')).toMatchObject({ kind: 'spawn-failed' });
    void tree.stop('startup-failed');
    expect(dead.killed).toBe(true);
    expect(s.sp.taskkills()).toEqual([]);
  });
});
