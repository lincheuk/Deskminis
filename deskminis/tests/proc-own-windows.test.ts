/**
 * F09 P 组：真机机制用例（只在 win32 跑；其它平台整体跳过）。
 *
 * 「引擎替身」是 tests/proc-own-host.ts：独立进程，import 真实的归属层与三种入口，按指令起根并回报。结束替身就是「只结束引擎」。
 * 断言的是替身之外的真实进程是否还活着：由测试进程起的观察者握着句柄、读内核记录的退出时刻，加上各进程自己写的心跳文件。
 * 只动自己起的进程（按测试握着的 ChildProcess）；从不按进程名结束任何东西；fixture 进程靠 stop 文件自己退出。
 *
 * 分档：P1–P8 随全量跑；P9、P10（批量、耗时与内存）只在 DESKMINIS_F09_FULL=1 下跑。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ELECTRON, EnvNotReady, Lab, TREE_FIXTURE, TREE_GROWN_MS, VERDICT_MS, appRoot, bareTree, judgeRoles, procsOf, roleProc, rolesGrown, treeCommand, until,
  type Tree,
} from './proc-lifecycle-fixture';
import { lines } from './run-ledger-fixture';
import { system32 } from '../src/minisd/proc/win-exec';

const WIN = process.platform === 'win32';
const FULL = process.env.DESKMINIS_F09_FULL === '1';
const SLOW = Math.max(1, Number(process.env.DESKMINIS_F09_SLOW) || 1);
const HOST_READY_MS = 120_000 * SLOW;
const STEP_MS = 120_000 * SLOW;
const T = (n: number): number => n * 60_000 * SLOW;
const VITE_NODE = join(appRoot, 'node_modules', 'vite-node', 'vite-node.mjs');

if (!WIN) console.log('F09 P 组：非 Windows 平台，未运行');
if (WIN && !FULL) console.log('F09 P 组：P9、P10 未运行（需要 DESKMINIS_F09_FULL=1）');

class Host {
  private seq = 0;
  private pending = new Map<number, (m: any) => void>();
  readonly events: any[] = [];
  pid = 0;
  private constructor(readonly child: ChildProcess) {}
  static async start(init: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}): Promise<Host> {
    const child = spawn(ELECTRON, [VITE_NODE, 'tests/proc-own-host.ts'], { cwd: appRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' } });
    const h = new Host(child);
    hosts.push(h);
    let buf = ''; let err = ''; let ready = false;
    child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => { err += d; });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.ev === 'ready') { ready = true; h.pid = m.pid; }
        else if (m.ev === 'reply') { const r = h.pending.get(m.seq); if (r) { h.pending.delete(m.seq); r(m); } }
        else h.events.push(m);
      }
    });
    child.on('error', () => undefined);
    child.on('exit', () => { for (const [, r] of h.pending) r({ hostGone: true }); h.pending.clear(); });
    await until('替身 ready', () => ready || child.exitCode !== null, HOST_READY_MS);
    if (!ready) throw new EnvNotReady(`替身起不来: ${err.slice(-400)}`, 0);
    const r = await h.call('init', init);
    if (r.hostError) throw new Error(r.hostError);
    return h;
  }
  call(op: string, params: Record<string, unknown> = {}): Promise<any> {
    const seq = ++this.seq;
    return new Promise(res => { this.pending.set(seq, res); this.child.stdin!.write(JSON.stringify({ op, seq, ...params }) + '\n'); });
  }
  get alive(): boolean { return this.child.exitCode === null && this.child.signalCode === null; }
  /** 只结束替身本身（不带 /T）：测试握着它的 ChildProcess。 */
  killOnly(): void { if (this.alive && this.child.pid !== undefined) spawnSync(system32('taskkill.exe'), ['/PID', String(this.child.pid), '/F'], { windowsHide: true, stdio: 'ignore' }); }
  shellDone(id: string, tag: string): any | undefined { return this.events.find(e => e.ev === 'shellDone' && e.id === id && e.tag === tag); }
}

const hosts: Host[] = [];
const trees: Tree[] = [];
const idle: ChildProcess[] = [];
let lab: Lab;
const root = mkdtempSync(join(tmpdir(), 'dm-f09-p-'));
let treeNo = 0;
const newTree = (entry: Tree['entry']): Tree => { const t = bareTree(root, entry, ++treeNo); trees.push(t); return t; };
/** 一个空转的同名映像进程（牺牲属主、无关进程）。测试握着它的句柄。 */
const spawnIdle = (): ChildProcess => {
  const c = spawn(ELECTRON, ['-e', 'setTimeout(() => {}, 900000)'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  c.on('error', () => undefined); idle.push(c); return c;
};
const mcpArgs = (t: Tree, ...flags: string[]): Record<string, unknown> =>
  ({ command: ELECTRON, args: [TREE_FIXTURE, t.fx, 'mcp', t.token, ...flags], env: { ELECTRON_RUN_AS_NODE: '1' } });
const driverPid = (t: Tree): number => Number(lines(join(t.fx, 'driver.pid'))[0]);
async function shellTree(h: Host, id: string, withStartProcess = false): Promise<Tree> {
  const t = newTree('shell');
  // withStartProcess：另用 Start-Process 起一个 leaf-sp（PowerShell 经 ShellExecute 起的进程是不是也在作业里）
  const pre = withStartProcess
    ? `$env:ELECTRON_RUN_AS_NODE = '1'; Start-Process -FilePath '${ELECTRON}' -ArgumentList '"${TREE_FIXTURE}"','"${t.fx}"','leaf-sp','${t.token}' -WindowStyle Hidden; `
    : '';
  await h.call('shell', { id, cwd: t.fx, command: pre + treeCommand(t.fx, t.token), tag: 'tree' });
  await until('driver.pid', () => Number.isInteger(driverPid(t)), TREE_GROWN_MS);
  t.rootPid = driverPid(t);
  await lab.observer.watch(t.rootPid);
  await rolesGrown(lab.observer, t);
  return t;
}
/** 这棵树在替身那里的状态（按根 PID 找）。 */
async function treeView(h: Host, rootPid: number): Promise<any | undefined> {
  return ((await h.call('status')).open as any[]).find(v => v.root?.pid === rootPid);
}
const allDead = (v: { tree: { role: string; verdict: string }[] }): string => v.tree.map(r => `${r.role}=${r.verdict}`).join(' ');
const DEAD5 = 'root=dead child=dead leaf=dead leaf-detached=dead leaf-orphan=dead';
const DEAD5_MCP = 'root=dead mcp=dead leaf=dead leaf-detached=dead leaf-orphan=dead';

describe.skipIf(!WIN)('F09 真机机制（P 组）', () => {
  beforeAll(async () => { lab = await Lab.open(); await lab.startBystanders(); }, T(5));
  afterAll(async () => {
    for (const t of trees) { try { writeFileSync(join(t.fx, 'stop'), ''); } catch { /* 目录没了 */ } }
    for (const h of hosts) h.killOnly();
    for (const c of idle) { try { c.kill(); } catch { /* 已退出 */ } }
    if (lab) { await lab.settle().catch(() => undefined); await lab.close(); }
  }, T(4));

  it('P1 driver 根：标记 job=armed watch=1；只结束替身后五个角色全部退出，无关进程全在；终端输出里没有标记行', async () => {
    const h = await Host.start();
    const t = await shellTree(h, 's1');
    const view = await treeView(h, t.rootPid!);
    expect(view).toMatchObject({ kind: 'shell', sessionId: 's1', protection: 'job', root: { pid: t.rootPid } });
    const st = await h.call('status');
    expect(st.status).toEqual({ state: 'active' });
    expect(st.journal.find((j: any) => j.what === 'protection' && j.protection === 'job')).toMatchObject({ preJob: true, root: { pid: t.rootPid } });
    // 终端入口同一个替身上再起一棵
    const tt = newTree('terminal');
    await h.call('terminal', { id: 't1', cwd: tt.fx, data: treeCommand(tt.fx, tt.token) + '\r' });
    await until('终端的 driver.pid', () => Number.isInteger(driverPid(tt)), TREE_GROWN_MS);
    tt.rootPid = driverPid(tt);
    await lab.observer.watch(tt.rootPid);
    await rolesGrown(lab.observer, tt);
    expect(await treeView(h, tt.rootPid)).toMatchObject({ kind: 'terminal', protection: 'job' });
    const out = (await h.call('termOut', { id: 't1' })).out as string;
    expect(out).not.toContain('__MINIS_PROC__');
    // 归属不在 stderr 上留下标记行以外的任何字节：与不带前导的终端跑同一条命令对比。PowerShell 自己在 stderr 上的东西
    // （第一条命令触发模块自动加载时冒出的 #< CLIXML 头，F09 之前就有）两边一样多
    const plain = await Host.start({ noSupervisor: true });
    const pt = newTree('terminal');
    await plain.call('terminal', { id: 't1', cwd: pt.fx, data: treeCommand(pt.fx, pt.token) + '\r' });
    await until('对照终端的 driver.pid', () => Number.isInteger(driverPid(pt)), TREE_GROWN_MS);
    const noise = (s: string): string[] => s.split(/\r?\n/).filter(l => !l.startsWith('PS ') && l.trim() !== '');
    await until('对照终端的输出到齐', async () => noise((await plain.call('termOut', { id: 't1' })).out as string).length >= noise(out).length, STEP_MS);
    expect(noise(out)).toEqual(noise((await plain.call('termOut', { id: 't1' })).out as string));
    await plain.call('termStop', { id: 't1', cause: 'probe-done' });
    await lab.observer.watch(h.pid);
    h.killOnly();
    const a = await judgeRoles(lab.observer, t, h.pid, h.pid, '替身');
    const b = await judgeRoles(lab.observer, tt, h.pid, h.pid, '替身');
    console.log('P1 证据：' + JSON.stringify({ shell: a.tree, terminal: b.tree }));
    expect(allDead(a)).toBe(DEAD5);
    expect(allDead(b)).toBe(DEAD5);
    expect((await lab.checkBystanders()).filter(x => !x.aliveAfter)).toEqual([]);
  }, T(8));

  it('P3 已托管的树 stop(cancel)：父链已断的 leaf-orphan 也退出；账本记 cancel / stopped', async () => {
    const h = await Host.start();
    const t = await shellTree(h, 's3', true);
    expect((await treeView(h, t.rootPid!))?.protection).toBe('job');
    await until('Start-Process 起的 leaf-sp 登记', () => roleProc(t, 'leaf-sp') !== undefined, TREE_GROWN_MS);
    const sp = roleProc(t, 'leaf-sp')!.pid;
    expect(await lab.observer.watch(sp)).toBeDefined();
    await h.call('shellStop', { id: 's3', cause: 'cancel' });
    const v = await judgeRoles(lab.observer, t, t.rootPid!, h.pid);
    console.log('P3 证据：' + JSON.stringify(v.tree));
    expect(allDead(v)).toBe(DEAD5);
    // Start-Process 起的那个也随根的作业结束
    await until('leaf-sp 退出', () => lab.observer.exited(sp), VERDICT_MS);
    expect(h.alive).toBe(true);
    await until('替身记下结束', async () => ((await h.call('status')).journal as any[]).some(j => j.what === 'ended'), STEP_MS);
    const j = (await h.call('status')).journal as any[];
    expect(j.find(x => x.what === 'stop')).toMatchObject({ cause: 'cancel' });
    expect(j.find(x => x.what === 'ended')).toMatchObject({ kind: 'stopped' });
    // 在途的那条命令照旧以 129 收口
    await until('在途命令收口', () => h.shellDone('s3', 'tree') !== undefined, STEP_MS);
    expect(h.shellDone('s3', 'tree').exitCode).toBe(129);
  }, T(6));

  it('P4 只靠属主监视：替身保持存活、只结束牺牲属主，driver 根与 command 根的树都全部退出，根的退出码是 197', async () => {
    const sac = spawnIdle();
    await until('牺牲进程起来', () => sac.pid !== undefined, STEP_MS);
    await lab.observer.watch(sac.pid!);
    const h = await Host.start({ ownerPid: sac.pid });
    const t = await shellTree(h, 's4');
    expect((await treeView(h, t.rootPid!))?.protection).toBe('job');
    const m = newTree('mcp-abs');
    expect(await h.call('mcp', { id: 'm4', ...mcpArgs(m) })).toMatchObject({ ok: true });
    await rolesGrown(lab.observer, m);
    const mv = ((await h.call('status')).open as any[]).find(v => v.kind === 'mcp');
    expect(mv).toMatchObject({ protection: 'job', ownerRef: 'm4' });
    expect(mv.targetPid).toBe(roleProc(m, 'mcp')!.pid);
    m.rootPid = mv.root.pid;
    await lab.observer.watch(m.rootPid!);
    sac.kill(); // 只结束牺牲属主：libuv 的作业没关、根的 stdin 没有 EOF，只有监视线程能动这两棵树
    const a = await judgeRoles(lab.observer, t, sac.pid!, h.pid, '牺牲属主');
    const b = await judgeRoles(lab.observer, m, sac.pid!, h.pid, '牺牲属主');
    console.log('P4 证据：' + JSON.stringify({ driver: a.tree, command: b.tree }));
    expect(allDead(a)).toBe(DEAD5);
    expect(allDead(b)).toBe(DEAD5_MCP);
    expect(a.tree[0].exitCode).toBe(197);
    expect(b.tree[0].exitCode).toBe(197);
    expect(h.alive).toBe(true);
    expect((await lab.checkBystanders()).filter(x => !x.aliveAfter)).toEqual([]);
    // 再做一次：标记一到立刻结束牺牲属主（不等树长完）
    const sac2 = spawnIdle();
    await until('牺牲进程起来', () => sac2.pid !== undefined, STEP_MS);
    await lab.observer.watch(sac2.pid!);
    const h2 = await Host.start({ ownerPid: sac2.pid });
    const t2 = newTree('shell');
    await h2.call('shell', { id: 's4b', cwd: t2.fx, command: treeCommand(t2.fx, t2.token), tag: 'tree' });
    await until('标记到', async () => ((await h2.call('status')).open as any[]).some(v => v.protection === 'job'), STEP_MS, 5);
    const rootPid = ((await h2.call('status')).open as any[])[0].root.pid as number;
    await lab.observer.watch(rootPid);
    sac2.kill();
    await until('根以 197 退出', () => lab.observer.exited(rootPid), VERDICT_MS);
    expect(lab.observer.held.get(rootPid)!.exitCode).toBe(197);
    await until('按令牌观察不到幸存者', async () => (await lab.observer.survivors(t2.token)).length === 0, VERDICT_MS, 500);
    expect(h2.alive).toBe(true);
  }, T(10));

  it('P2 command 根：大消息往返、参数 / 环境差分、退出码透传、各种路径写法、启动即写 stderr 的目标', async () => {
    const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'dm-f09-p2.cmd'), `@"${ELECTRON}" "${TREE_FIXTURE}" %*\r\n`);
    const spaced = join(root, 'dir with space');
    symlinkSync(dirname(ELECTRON), spaced, 'junction'); // 带空格的路径：一个指向 electron 所在目录的联接（只建不删）
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    // 固定 Windows 的兼容性层：健康检测器按启动路径注入 DetectorsAppHealth，会使两份环境只在系统标志上不同。
    const env = { [pathKey]: bin + ';' + (process.env[pathKey] ?? ''), __COMPAT_LAYER: 'RunAsInvoker' };
    const direct = await Host.start({ noSupervisor: true }, env);
    const owned = await Host.start({}, env);
    const fx = join(root, 'p2'); mkdirSync(fx, { recursive: true });
    const odd = ['a b', 'q"uo"te', 'back\\slash\\', 'end\\\\', '', '中文', 'x\\"y', 'tab\there', '--flag=has space'];
    const base = [TREE_FIXTURE, fx, 'mcp', 'p2tok', '--no-tree'];
    let n = 0;
    const both = async (cfg: Record<string, unknown>, managed: Host = owned): Promise<{ d: any; o: any; id: string }> => {
      const id = `p2-${++n}`;
      const d = await direct.call('mcp', { id, env: { ELECTRON_RUN_AS_NODE: '1' }, ...cfg });
      const o = await managed.call('mcp', { id, env: { ELECTRON_RUN_AS_NODE: '1' }, ...cfg });
      return { d, o, id };
    };
    const dumpOf = async (h: Host, id: string): Promise<{ argv: string[]; env: Record<string, string>; cwd: string }> =>
      JSON.parse((await h.call('mcpCall', { id, name: 'noop', args: { dump: true } })).result.content[0].text);
    // 参数与环境差分；图形子系统的目标（Electron Node 模式）拿得到 stdio
    const r1 = await both({ command: ELECTRON, args: [...base, ...odd] });
    expect(r1.d).toMatchObject({ ok: true }); expect(r1.o).toMatchObject({ ok: true });
    const dd = await dumpOf(direct, r1.id); const od = await dumpOf(owned, r1.id);
    expect(od.argv).toEqual(dd.argv);
    expect(od.argv.slice(4)).toEqual(odd);
    expect(od.cwd).toBe(dd.cwd);
    expect(Object.keys(od.env).filter(k => /^MINIS_OWN_/i.test(k))).toEqual([]);
    expect(od.env.PSExecutionPolicyPreference).toBeUndefined();
    expect(od.env).toEqual(dd.env);
    // 宿主继承值可能已经等于 PowerShell 的默认值，必须显式给自定义值/空值才测得出 launcher 改写。
    const modulePathOf = (vars: Record<string, string>): string | undefined =>
      Object.entries(vars).find(([key]) => key.toLowerCase() === 'psmodulepath')?.[1];
    const moduleKey = Object.keys(process.env).find(key => key.toLowerCase() === 'psmodulepath') ?? 'PSModulePath';
    // 各宿主对已有变量的启动改写不同；另一台真实宿主只注入启动改写，确认产品确实恢复原值。
    const rewriting = await Host.start({ inject: { rewriteModulePath: true } }, env);
    for (const modulePath of ['X:\\F09 modules with space;Y:\\F09-custom', '']) {
      const module = await both({ command: ELECTRON, args: base, env: { ELECTRON_RUN_AS_NODE: '1', [moduleKey]: modulePath } }, rewriting);
      expect(module.d).toMatchObject({ ok: true }); expect(module.o).toMatchObject({ ok: true });
      const plain = await dumpOf(direct, module.id), managed = await dumpOf(rewriting, module.id);
      expect(modulePathOf(plain.env)).toBe(modulePath);
      expect(modulePathOf(managed.env)).toBe(modulePathOf(plain.env));
      expect(((await rewriting.call('status')).open as any[]).find(v => v.ownerRef === module.id)?.protection).toBe('job');
    }
    const view = ((await owned.call('status')).open as any[]).find(v => v.ownerRef === r1.id);
    expect(view).toMatchObject({ protection: 'job', kind: 'mcp' });
    // 往返：1 MB 的大消息逐字节相同
    const big = 'x'.repeat(1024 * 1024 - 7) + '中文尾巴';
    expect((await owned.call('mcpCall', { id: r1.id, name: 'noop', args: { echo: big } })).result.content[0].text).toBe(big);
    // stderr 透传且不含标记行、不多出任何字节（目标没写 stderr 时尾巴为空）
    expect((await owned.call('mcpInfo', { id: r1.id })).stderrTail).toBe('');
    // 退出码透传
    for (const code of [0, 3, 3221225477]) {
      const r = await both({ command: ELECTRON, args: base });
      expect(r.o).toMatchObject({ ok: true });
      await direct.call('mcpCall', { id: r.id, name: 'noop', args: { exit: code } });
      await owned.call('mcpCall', { id: r.id, name: 'noop', args: { exit: code } });
      await until('两边的退出码', async () => (await owned.call('mcpInfo', { id: r.id })).closed === true && (await direct.call('mcpInfo', { id: r.id })).closed === true, STEP_MS);
      const de = (await direct.call('mcpInfo', { id: r.id })).exitCode; const oe = (await owned.call('mcpInfo', { id: r.id })).exitCode;
      expect(oe).toBe(de);
      if (code <= 0x7fffffff) expect(oe).toBe(code);
      console.log(`P2 退出码透传：要求 ${code}，直起 ${de}，launcher ${oe}`);
    }
    // 各种目标写法：直起起得来的，launcher 路径下也都起得来
    const targets: Record<string, unknown>[] = [
      { command: 'dm-f09-p2', args: [fx, 'mcp', 'p2tok', '--no-tree', 'a b'] },                           // 裸名垫片，经 cmd.exe
      { command: join(spaced, 'electron.exe'), args: base },                                               // 带空格的绝对路径
      { command: join(spaced, 'electron'), args: base },                                                   // 不带扩展名
      { command: '.\\electron.exe', args: base, cwd: spaced },                                             // 相对路径加 cwd
      { command: ELECTRON.replace(/\\/g, '/'), args: base },                                               // 正斜杠
    ];
    for (const cfg of targets) {
      const r = await both(cfg);
      expect({ cfg: cfg.command, ok: r.o.ok, error: r.o.error }).toEqual({ cfg: cfg.command, ok: r.d.ok, error: r.d.error });
      if (r.d.ok) expect((await dumpOf(owned, r.id)).argv).toEqual((await dumpOf(direct, r.id)).argv);
    }
    console.log('P2 各写法的托管结果：' + JSON.stringify(((await owned.call('status')).journal as any[]).filter(j => j.what === 'protection').map(j => `${j.protection}${j.reason ? '/' + j.reason : ''}`)));
    // 启动即写 stderr 的目标：标记先于目标的任何输出，连做 20 次
    for (let i = 0; i < 20; i++) {
      const id = `p2-early-${i}`;
      expect(await owned.call('mcp', { id, command: ELECTRON, args: [...base, '--stderr-early'], env: { ELECTRON_RUN_AS_NODE: '1' } })).toMatchObject({ ok: true });
      await until('stderr 尾巴到', async () => (await owned.call('mcpInfo', { id })).stderrTail.length > 0, STEP_MS);
      const tail = (await owned.call('mcpInfo', { id })).stderrTail as string;
      expect(tail.startsWith('early-stderr-without-newline')).toBe(true);
      expect(tail).not.toContain('__MINIS_PROC__');
      expect(((await owned.call('status')).open as any[]).find(v => v.ownerRef === id)?.protection).toBe('job');
      await owned.call('mcpStop', { id, cause: 'probe-done' });
    }
    writeFileSync(join(fx, 'stop'), '');
    trees.push({ entry: 'mcp-abs', fx, token: 'p2tok' });
  }, T(15));

  it('P5 目标不存在：恰好回退一次、文案与直起相同；带路径的批处理目标一次都不起 launcher、结果与直起逐字相同', async () => {
    const direct = await Host.start({ noSupervisor: true });
    const owned = await Host.start();
    const missing = { command: join(root, 'no-such-dir', 'nope.exe'), args: ['a'] };
    const d = await direct.call('mcp', { id: 'p5', ...missing });
    const o = await owned.call('mcp', { id: 'p5', ...missing });
    expect(d.ok).toBe(false);
    expect(d.error).toContain('命令不存在');
    expect({ ok: o.ok, error: o.error }).toEqual({ ok: d.ok, error: d.error });
    let st = await owned.call('status');
    expect((st.spawns as any[]).map(s => /powershell\.exe$/i.test(s.file) ? 'launcher' : /nope\.exe$/.test(s.file) ? 'direct' : 'other')).toEqual(['launcher', 'direct']);
    // CreateProcessW 的错误码：2（文件不存在）或 3（路径不存在），本机实测是 2
    expect((st.journal as any[]).find(j => j.what === 'protection' && j.protection === 'none')?.reason).toMatch(/^launch-failed:[23]$/);
    expect(st.status.state).not.toBe('disabled');
    // 批处理目标的差分
    const bat = join(root, 'p5'); mkdirSync(bat, { recursive: true });
    for (const f of ['x.cmd', 'y.bat']) writeFileSync(join(bat, f), '@echo off\r\n');
    const before = (st.spawns as any[]).length;
    for (const name of ['x.cmd', 'X.CMD', 'y.Bat', 'x.cmd.', 'y.bat.', 'x.cmd ', 'x.cmd. .']) {
      const cfg = { command: bat + '\\' + name, args: [], startupTimeoutSeconds: 5 };
      const dr = await direct.call('mcp', { id: 'p5b', ...cfg });
      const or = await owned.call('mcp', { id: 'p5b', ...cfg });
      expect({ name, ok: or.ok, error: or.error, code: or.code }).toEqual({ name, ok: dr.ok, error: dr.error, code: dr.code });
      await direct.call('mcpStop', { id: 'p5b' }); await owned.call('mcpStop', { id: 'p5b' });
    }
    st = await owned.call('status');
    expect((st.spawns as any[]).slice(before).filter(s => /powershell\.exe$/i.test(s.file))).toEqual([]);
  }, T(8));

  it('P6 故障注入：放行行不符 → 恰好直起一次、握手成功、不停用；前导被拦 → 第一条命令 129、停用、第二条命令正常', async () => {
    const h = await Host.start({ inject: { tamperNonce: true } });
    const fx = join(root, 'p6'); mkdirSync(fx, { recursive: true });
    trees.push({ entry: 'mcp-abs', fx, token: 'p6tok' });
    const r = await h.call('mcp', { id: 'p6', command: ELECTRON, args: [TREE_FIXTURE, fx, 'mcp', 'p6tok', '--no-tree'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(r).toMatchObject({ ok: true });
    let st = await h.call('status');
    expect((st.spawns as any[]).filter(s => /powershell\.exe$/i.test(s.file))).toHaveLength(1);
    expect((st.spawns as any[]).filter(s => s.file === ELECTRON)).toHaveLength(1);
    expect((st.open as any[]).find(v => v.ownerRef === 'p6')).toMatchObject({ protection: 'none', protectionReason: 'fallback:launcher-not-released' });
    expect(st.status.state).not.toBe('disabled');
    // launcher 以 197 退出、没有启动目标
    const launcherEnd = (st.journal as any[]).find(j => j.what === 'ended');
    expect(launcherEnd).toMatchObject({ exitCode: 197 });

    const h2 = await Host.start({ inject: { breakDriver: true } });
    await h2.call('shell', { id: 's6', cwd: fx, command: `'first'`, tag: 'a' });
    await until('第一条命令收口', () => h2.shellDone('s6', 'a') !== undefined, STEP_MS);
    expect(h2.shellDone('s6', 'a').exitCode).toBe(129);
    st = await h2.call('status');
    expect(st.status).toMatchObject({ state: 'disabled', reason: 'root-exited-before-arm' });
    await h2.call('shell', { id: 's6', cwd: fx, command: `'second-ok'`, tag: 'b' });
    await until('第二条命令收口', () => h2.shellDone('s6', 'b') !== undefined, STEP_MS);
    expect(h2.shellDone('s6', 'b')).toMatchObject({ exitCode: 0, output: 'second-ok' });
  }, T(6));

  it('P7 已托管的 shell 里以 CREATE_BREAKAWAY_FROM_JOB 起进程：失败，错误码 5；不带该标志则成功', async () => {
    const h = await Host.start();
    const fx = join(root, 'p7'); mkdirSync(fx, { recursive: true });
    const cmd = [
      `Add-Type -Namespace F09 -Name B -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CreateProcessW(IntPtr a, System.Text.StringBuilder c, IntPtr pa, IntPtr ta, bool inh, uint f, IntPtr e, IntPtr d, byte[] si, byte[] pi);'`,
      `foreach ($f in @(0x01000000, 0)) {`,
      `  $si = New-Object byte[] 104; $si[0] = 104; $pi = New-Object byte[] 24`,
      `  $ok = [F09.B]::CreateProcessW([IntPtr]::Zero, (New-Object System.Text.StringBuilder '${system32('cmd.exe')} /d /c exit 0'), [IntPtr]::Zero, [IntPtr]::Zero, $false, [uint32]($f -bor 0x08000000), [IntPtr]::Zero, [IntPtr]::Zero, $si, $pi)`,
      `  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()`,
      `  'BREAK flag=' + $f + ' ok=' + $ok + ' err=' + $(if ($ok) { 0 } else { $err })`,
      `}`,
    ].join('\n');
    await h.call('shell', { id: 's7', cwd: fx, command: cmd, tag: 'a' });
    await until('命令收口', () => h.shellDone('s7', 'a') !== undefined, STEP_MS);
    const out = h.shellDone('s7', 'a').output as string;
    expect(out).toContain('BREAK flag=16777216 ok=False err=5');
    expect(out).toContain('BREAK flag=0 ok=True err=0');
    expect(((await h.call('status')).journal as any[]).some(j => j.what === 'protection' && j.protection === 'job')).toBe(true);
  }, T(4));

  it('P8 失效句柄不起 taskkill；属主 PID 换人 → 根以 197 退出、无关进程存活、停用后第二条命令正常；MCP 同一情形恰好直起一次', async () => {
    const by = spawnIdle();
    await until('无关进程起来', () => by.pid !== undefined, STEP_MS);
    const h = await Host.start();
    expect(await h.call('fakeStop', { pid: by.pid })).toMatchObject({ spawned: 0 });
    expect(by.exitCode).toBeNull();
    expect(((await h.call('status')).journal as any[]).some(j => j.what === 'fake-kill')).toBe(false);

    const fx = join(root, 'p8'); mkdirSync(fx, { recursive: true });
    trees.push({ entry: 'mcp-abs', fx, token: 'p8tok' });
    const h2 = await Host.start({ inject: { lateOwnerFile: join(fx, 'late-owner.pid') } });
    await h2.call('shell', { id: 's8', cwd: fx, command: `'first'`, tag: 'a' });
    await until('第一条命令收口', () => h2.shellDone('s8', 'a') !== undefined, STEP_MS);
    expect(h2.shellDone('s8', 'a').exitCode).toBe(129); // 根以 197 退出、没有执行命令
    let st = await h2.call('status');
    expect((st.journal as any[]).find(j => j.what === 'ended')).toMatchObject({ exitCode: 197 });
    expect(st.status).toMatchObject({ state: 'disabled', reason: 'owner-check-misfired' });
    const late = h2.events.find(e => e.ev === 'lateOwner').pid as number;
    expect(await lab.observer.watch(late)).toBeDefined(); // 那个晚出生的无关进程还在
    expect(lab.observer.exited(late)).toBe(false);
    await h2.call('shell', { id: 's8', cwd: fx, command: `'second-ok'`, tag: 'b' });
    await until('第二条命令收口', () => h2.shellDone('s8', 'b') !== undefined, STEP_MS);
    expect(h2.shellDone('s8', 'b')).toMatchObject({ exitCode: 0, output: 'second-ok' });

    const h3 = await Host.start({ inject: { lateOwnerFile: join(fx, 'late-owner-3.pid') } });
    expect(await h3.call('mcp', { id: 'm8', command: ELECTRON, args: [TREE_FIXTURE, fx, 'mcp', 'p8tok', '--no-tree'], env: { ELECTRON_RUN_AS_NODE: '1' } })).toMatchObject({ ok: true });
    st = await h3.call('status');
    expect((st.spawns as any[]).filter(s => /powershell\.exe$/i.test(s.file))).toHaveLength(1);
    expect((st.spawns as any[]).filter(s => s.file === ELECTRON)).toHaveLength(1);
    expect((st.journal as any[]).find(j => j.what === 'ended')).toMatchObject({ exitCode: 197 });
    expect(st.status).toMatchObject({ state: 'disabled', reason: 'owner-check-misfired' });
  }, T(8));

  it.skipIf(!FULL)('P9 批量与快速：20 棵树生长途中结束替身，3 个有效轮都没有幸存者；30 次起根即 stop 没有残留', async () => {
    let valid = 0;
    for (let attempt = 0; attempt < 10 && valid < 3; attempt++) {
      const h = await Host.start();
      const batch: Tree[] = [];
      for (let i = 0; i < 20; i++) {
        const t = newTree(i % 2 === 0 ? 'shell' : 'mcp-abs'); batch.push(t);
        if (t.entry === 'shell') void h.call('shell', { id: `b${attempt}-${i}`, cwd: t.fx, command: treeCommand(t.fx, t.token), tag: 'tree' });
        else void h.call('mcp', { id: `b${attempt}-${i}`, ...mcpArgs(t) });
      }
      // 生长窗口内的随机时刻动手：等到至少一棵树已有后代登记（有效轮），再随机多等一小段
      await until('至少一棵树有后代登记', () => batch.some(t => procsOf(t).some(p => p.role.startsWith('leaf'))), TREE_GROWN_MS, 5);
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 400)));
      const grownTrees = batch.filter(t => procsOf(t).some(p => p.role.startsWith('leaf'))).length;
      h.killOnly();
      valid++;
      for (const t of batch) await until(`没有幸存者（${t.token}）`, async () => (await lab.observer.survivors(t.token)).length === 0, VERDICT_MS, 500);
      console.log(`P9 第 ${valid} 个有效轮：动手时 ${grownTrees}/20 棵树已有后代登记，之后按令牌观察不到幸存者`);
    }
    expect(valid).toBe(3);
    const h = await Host.start();
    const fx = join(root, 'p9'); mkdirSync(fx, { recursive: true });
    for (let i = 0; i < 30; i++) {
      await h.call('shell', { id: `q${i}`, cwd: fx, command: `'x'`, tag: 'a' });
      await h.call('shellStop', { id: `q${i}`, how: 'dispose', cause: 'cancel' });
    }
    await until('30 棵树都结束', async () => ((await h.call('status')).open as any[]).length === 0, STEP_MS);
    expect(h.alive).toBe(true);
    expect(((await h.call('status')).journal as any[]).filter(j => j.what === 'ended')).toHaveLength(30);
  }, T(30));

  it.skipIf(!FULL)('P10 归属耗时与 launcher 常驻内存（G5 的数据）；结构体长度分支与指针宽度一致', async () => {
    const fx = join(root, 'p10'); mkdirSync(fx, { recursive: true });
    trees.push({ entry: 'mcp-abs', fx, token: 'p10tok' });
    const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const measure = async (h: Host, kind: 'shell' | 'mcp', n: number): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const id = `${kind}${i}`; const t0 = Date.now();
        if (kind === 'shell') {
          await h.call('shell', { id, cwd: fx, command: `'x'`, tag: 'a' });
          await until('首条命令', () => h.shellDone(id, 'a') !== undefined, STEP_MS, 5);
          out.push(Date.now() - t0);
          await h.call('shellStop', { id, how: 'dispose', cause: 'probe-done' });
        } else {
          const r = await h.call('mcp', { id, command: ELECTRON, args: [TREE_FIXTURE, fx, 'mcp', 'p10tok', '--no-tree'], env: { ELECTRON_RUN_AS_NODE: '1' } });
          expect(r).toMatchObject({ ok: true });
          out.push(Date.now() - t0);
          if (i < n - 1) await h.call('mcpStop', { id, cause: 'probe-done' });
        }
      }
      return out;
    };
    const plain = await Host.start({ noSupervisor: true });
    const owned = await Host.start();
    const rows: Record<string, unknown> = {};
    for (const kind of ['shell', 'mcp'] as const) {
      const base = await measure(plain, kind, 10); const arm = await measure(owned, kind, 10);
      rows[kind] = { 直起: { 首次: base[0], p50: pct(base.slice(1), 0.5), p95: pct(base, 0.95) }, 托管: { 首次: arm[0], p50: pct(arm.slice(1), 0.5), p95: pct(arm, 0.95) } };
      expect(pct(arm, 0.95)).toBeGreaterThan(0);
    }
    const st = await owned.call('status');
    // MCP 的 10 棵一定到 job（connect 要等标记）；shell 的那 10 棵命令一返回就被释放，标记可能来不及读到
    expect((st.journal as any[]).filter(j => j.what === 'protection' && j.protection === 'job').length).toBeGreaterThanOrEqual(10);
    const launcher = (st.open as any[]).find(v => v.kind === 'mcp');
    await lab.observer.watch(launcher.root.pid);
    await new Promise(r => setTimeout(r, 2000)); // 让 launcher 收完工作集再量（只影响读数，不影响判定）
    const mem = await lab.observer.mem(launcher.root.pid);
    console.log('P10 读数（毫秒 / 字节）：' + JSON.stringify({ ...rows, launcher常驻: mem, 指针宽度: process.arch }));
    expect(process.arch === 'x64' || process.arch === 'ia32' || process.arch === 'arm64').toBe(true);
    expect(mem).toBeDefined();
  }, T(20));
});
