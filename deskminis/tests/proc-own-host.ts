/**
 * F09 fixture（不是测试）：P 组的「引擎替身」。独立进程（vite-node 运行，与引擎同一个可执行文件、同样是 libuv 起子进程），
 * import 真实的归属层与三种入口（PersistentShell、TerminalSession、McpStdioClient），按 stdin 的 JSON 指令起根并回报。
 * 结束这个进程就是「只结束引擎」。它比引擎轻得多，P 组不起引擎。
 *
 * 故障注入只在这里包的那层 spawnImpl 上做（产品里没有故障开关）：
 *  - tamperNonce：把 launcher 环境里的 MINIS_OWN_NONCE 换成别的值（launcher 读不到对的放行行）。
 *  - breakDriver：把带前导的驱动脚本换成立刻 exit 1 的脚本（模拟前导被拦）。
 *  - lateOwner：把根脚本里属主 PID 的字面量换成「归属时从文件读」，并在根起来之后才起一个空转进程、把它的 PID 写进那个文件：
 *    根看到的属主因此是一个比自己晚创建的无关进程（PID 换人）。
 * 每次 spawn 都记一笔（file 与前几个实参），用例据此数 taskkill 与 launcher 各起了几次。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ProcSupervisor, type ProcJournal } from '../src/minisd/proc/owned';
import type { ProcOpts } from '../src/minisd/proc/win-exec';
import { PersistentShell } from '../src/minisd/tools/shell';
import { TerminalSession } from '../src/minisd/terminal';
import { McpStdioClient } from '../src/minisd/mcp/stdio';

const send = (o: unknown): void => { process.stdout.write(JSON.stringify(o) + '\n'); };
const spawns: { file: string; args: string[] }[] = [];
const journal: unknown[] = [];
let sup: ProcSupervisor | undefined;
let procOpts: ProcOpts = {};
const shells = new Map<string, PersistentShell>();
const terms = new Map<string, { s: TerminalSession; out: string }>();
const mcps = new Map<string, McpStdioClient>();
const extras: ChildProcess[] = [];

interface Inject { tamperNonce?: boolean; breakDriver?: boolean; lateOwnerFile?: string; rewriteModulePath?: boolean }

function wrapSpawn(inj: Inject, ownerPid: number): typeof spawn {
  const enc = (s: string): string => Buffer.from(s, 'utf16le').toString('base64');
  const wrapped = (file: string, args: readonly string[], opts: any): ChildProcess => {
    let a = [...args]; let o = opts;
    const ei = a.indexOf('-EncodedCommand');
    const isRoot = ei >= 0 && /powershell\.exe$/i.test(file);
    let script = isRoot ? Buffer.from(a[ei + 1], 'base64').toString('utf16le') : '';
    const armedRoot = script.includes('__minis_k32');
    if (armedRoot && inj.rewriteModulePath && o?.env?.MINIS_OWN_NONCE !== undefined) {
      script = "[Environment]::SetEnvironmentVariable('PSModulePath', 'X:\\F09-injected-startup')\n" + script;
      a[ei + 1] = enc(script);
    }
    if (armedRoot && inj.breakDriver && script.includes('__minis_arm')) { script = 'exit 1'; a[ei + 1] = enc(script); }
    if (armedRoot && inj.lateOwnerFile) {
      script = script.replace(`[uint32]${ownerPid})`, `[uint32][IO.File]::ReadAllText('${inj.lateOwnerFile}'))`);
      a[ei + 1] = enc(script);
    }
    if (inj.tamperNonce && o?.env?.MINIS_OWN_NONCE !== undefined) o = { ...o, env: { ...o.env, MINIS_OWN_NONCE: 'tampered' } };
    spawns.push({ file, args: a.slice(0, ei >= 0 ? ei : 4) });
    const child = spawn(file, a, o);
    if (armedRoot && inj.lateOwnerFile) {
      // 根已经创建（spawn 是同步创建的），此刻才起的进程一定比它晚出生
      const late = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 900000)'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      extras.push(late);
      writeFileSync(inj.lateOwnerFile, String(late.pid));
      send({ ev: 'lateOwner', pid: late.pid });
    }
    return child;
  };
  return wrapped as unknown as typeof spawn;
}

const memJournal: ProcJournal = {
  opened: (id, meta, root) => { journal.push({ what: 'opened', at: Date.now(), id, meta, root }); },
  protection: (id, p) => { journal.push({ what: 'protection', at: Date.now(), id, ...p }); },
  stopRequested: (id, cause) => { journal.push({ what: 'stop', at: Date.now(), id, cause }); },
  ended: (id, e) => { journal.push({ what: 'ended', at: Date.now(), id, ...e }); },
};

async function handle(m: any): Promise<unknown> {
  switch (m.op) {
    case 'init': {
      const ownerPid = typeof m.ownerPid === 'number' ? m.ownerPid : process.pid;
      sup = new ProcSupervisor({ ownerPid, armTimeoutMs: m.armTimeoutMs, ...(m.disabled ? { disabled: String(m.disabled) } : {}), warn: (msg) => { journal.push({ what: 'warn', msg }); } });
      sup.bind(memJournal);
      procOpts = { spawnImpl: wrapSpawn(m.inject ?? {}, ownerPid), ...(m.noSupervisor ? {} : { supervisor: sup }) };
      return { pid: process.pid };
    }
    case 'shell': {
      let s = shells.get(m.id);
      if (!s) { s = new PersistentShell(m.cwd, m.env, procOpts, { kind: 'shell', sessionId: m.id }); shells.set(m.id, s); }
      void s.run(m.command, m.timeoutMs ?? 1_800_000).then(r => send({ ev: 'shellDone', id: m.id, tag: m.tag, output: r.output, exitCode: r.exitCode }));
      return {};
    }
    case 'shellStop': {
      const s = shells.get(m.id);
      if (m.how === 'dispose') void s?.dispose(m.cause); else s?.interrupt(m.cause);
      return {};
    }
    case 'terminal': {
      let t = terms.get(m.id);
      if (!t) { const slot = { s: undefined as unknown as TerminalSession, out: '' }; slot.s = new TerminalSession(m.cwd, d => { slot.out += d; }, m.env ?? {}, procOpts, { kind: 'terminal', sessionId: m.id }); terms.set(m.id, slot); t = slot; }
      t.s.attach();
      if (typeof m.data === 'string' && m.data.length > 0) t.s.input(m.data);
      return {};
    }
    case 'termOut': return { out: terms.get(m.id)?.out ?? '' };
    case 'termStop': { void terms.get(m.id)?.s.dispose(m.cause); return {}; }
    case 'mcp': {
      const c = new McpStdioClient({
        command: m.command, args: m.args, env: m.env, cwd: m.cwd, startupTimeoutSeconds: m.startupTimeoutSeconds ?? 60,
        proc: procOpts, ...(m.noTree ? {} : { tree: { ownerRef: m.id, toolPrefix: `mcp__${m.id}__` } }),
      });
      mcps.set(m.id, c);
      try { await c.connect(); return { ok: true, stderrTail: c.stderrTail }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), code: (e as NodeJS.ErrnoException)?.code ?? null, stderrTail: c.stderrTail }; }
    }
    case 'mcpCall': {
      const c = mcps.get(m.id)!;
      try { return { ok: true, result: await c.callTool(m.name, m.args) }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), exitCode: c.exitCode }; }
    }
    case 'mcpInfo': { const c = mcps.get(m.id); return { exitCode: c?.exitCode ?? null, closed: c?.closed ?? null, stderrTail: c?.stderrTail ?? '' }; }
    case 'mcpStop': { void mcps.get(m.id)?.dispose(m.cause); return {}; }
    case 'fakeStop': {
      // 失效句柄：一个像 ChildProcess 的对象，pid 指向一个存活的无关进程、exitCode 已有值（根早已退出，pid 已换人）
      const fake = { pid: m.pid, exitCode: 0, signalCode: null, stderr: undefined, once: () => fake, on: () => fake, kill: () => { journal.push({ what: 'fake-kill' }); return true; } } as unknown as ChildProcess;
      const before = spawns.length;
      await sup!.adopt(fake, { kind: 'shell', sessionId: 'fake' }, procOpts, { armed: false, reason: 'test' }).stop('cancel', 'SIGKILL');
      return { spawned: spawns.length - before };
    }
    case 'status': return { status: sup?.status, open: sup?.open() ?? [], spawns, journal };
    default: return { error: 'unknown op' };
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let m: any;
  try { m = JSON.parse(line); } catch { return; }
  handle(m).then(r => send({ ev: 'reply', seq: m.seq, ...(r as object) }), e => send({ ev: 'reply', seq: m.seq, hostError: String(e?.stack ?? e) }));
});
// stdin 关了也不退出：只在被结束时结束（「只结束引擎」由测试按句柄做）
rl.on('close', () => { setInterval(() => {}, 1000); });
send({ ev: 'ready', pid: process.pid });
