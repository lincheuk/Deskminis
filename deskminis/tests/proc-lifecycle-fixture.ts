/**
 * F09 fixture（不是测试）：真实进程树的观察、判定与取证。
 *
 * 不引任何 F09 新增的 src 模块：用它的用例（proc-lifecycle-process）与探针脚本只经 RPC、读库、读文件系统、
 * 经观察者握着的进程句柄断言，在 F09 之前的基线上也跑得起来、红在行为上。
 *
 * 约定（设计 §7.2）：
 *  - 只动自己起的进程。结束动作只有两种，都落在句柄上：对测试握着 ChildProcess 的进程 taskkill /PID <pid> /F（不带 /T）
 *    或 child.kill()；对自己起、但不是直接子进程的引擎（H2 的引擎），经观察者握着的那个 Process 对象 Kill()。
 *    从不按进程名、映像名、命令行结束任何东西；任何枚举只用于观察。
 *  - fixture 进程从不被测试为清理而杀：它们自限（stop 文件或 15 分钟），收尾只写 stop 文件。
 *  - 判定的时间锚点是触发这次回收的那个进程由内核记录的退出时刻，不是测试发起动作的时刻。
 *  - 「死了」只认观察者握着的句柄显示已退出；「还活着」要锚点之后又写了至少 10 行心跳、且到锚点之后 VERDICT_MS 句柄仍未退出；
 *    其余是没有结论。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  autoAllow, eventsOf, killTree as killEngineOnly, lines, mockLlm, readDb, rpcClient, spawnEngine,
  type Client, type Engine, type LlmStep,
} from './run-ledger-fixture';
import { powershellPath, system32 } from '../src/minisd/proc/win-exec';

export const appRoot = join(__dirname, '..');
const VITE_NODE = join(appRoot, 'node_modules', 'vite-node', 'vite-node.mjs');
const INJECT = join(__dirname, 'minisd-crash-inject.cjs');
const SELFLIMIT = join(__dirname, 'proc-engine-selflimit.cjs');
export const TREE_FIXTURE = join(__dirname, 'proc-tree-fixture.cjs');
/** 测试宿主自己：Electron Node 模式的可执行文件。树里的进程、无关进程、引擎都用它，所以是同名映像。 */
export const ELECTRON = process.execPath;

const SLOW = Math.max(1, Number(process.env.DESKMINIS_F09_SLOW) || 1);
export const ENGINE_HANDSHAKE_MS = 240_000 * SLOW;
export const OBSERVER_READY_MS = 120_000 * SLOW;
export const TREE_GROWN_MS = 120_000 * SLOW;
export const VERDICT_MS = 60_000 * SLOW;
/** shell / MCP 超时情形里的时限（秒）。取 20：计时从命令写出（或 connect）开始，PowerShell 冷启动与树的生长都算在里面。 */
export const TIMEOUT_SECONDS = 20 * SLOW;

/** 环境没准备好、或没有结论：不是断言失败，也不是通过（设计 §7.3 第 4 条）。 */
export class EnvNotReady extends Error {
  constructor(what: string, waitedMs: number) { super(`[环境] ${what}（已等 ${Math.round(waitedMs)}ms）`); this.name = 'EnvNotReady'; }
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
/** 等事件，不猜时长：每 pollMs 查一次，成立即返回，到上限抛 EnvNotReady。 */
export async function until(what: string, cond: () => boolean | Promise<boolean>, capMs: number, pollMs = 50): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return Date.now() - t0;
    if (Date.now() - t0 > capMs) throw new EnvNotReady(what, Date.now() - t0);
    await sleep(pollMs);
  }
}

// ---------- 观察者 ----------

export interface Held { pid: number; name: string; createdUtc: number; inJob: boolean | null; exitedUtc?: number; exitCode?: number }
export interface ParentInfo { pid: number; ppid: number; name: string; createdUtc: number }

/** 观察者脚本：握句柄、报创建 / 退出时刻（内核记录的）、从外面查 IsProcessInJob。只有 kill 一条指令会动进程，
 *  而且只对「已握住句柄、且被调用方标成自己起的引擎」的那个 PID 生效。 */
const OBSERVER_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace F09 -Name K -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(System.IntPtr h, System.IntPtr j, out bool r);'
$epoch = [datetime]'1970-01-01'
function Ms($d) { [math]::Round(($d.ToUniversalTime() - $epoch).TotalMilliseconds, 3) }
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)) }
$held = @{}; $done = @{}; $own = @{}
Emit @{ ev = 'ready'; pid = $PID }
# 不能用 [Console]::In.ReadLineAsync()：它是同步包装，会把轮询卡在读 stdin 上；自己包一个 StreamReader 才是真异步
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$task = $stdin.ReadLineAsync()
while ($true) {
  if ($task.IsCompleted) {
    $line = $task.Result
    if ($null -eq $line) { break }
    $a = $line.Split(' ')
    $seq = $a[0]; $cmd = $a[1]
    try {
      if ($cmd -eq 'watch') {
        $id = [int]$a[2]
        if ($held.ContainsKey($id) -or $done.ContainsKey($id)) { Emit @{ ev = 'held'; seq = $seq; pid = $id; again = $true } }
        else {
          $p = [System.Diagnostics.Process]::GetProcessById($id)
          $h = $p.Handle
          $in = $false; $inJob = $null
          if ([F09.K]::IsProcessInJob($h, [IntPtr]::Zero, [ref]$in)) { $inJob = $in }
          $held[$id] = $p
          Emit @{ ev = 'held'; seq = $seq; pid = $id; name = $p.ProcessName; createdUtc = (Ms $p.StartTime); inJob = $inJob }
        }
      } elseif ($cmd -eq 'own') {
        $own[[int]$a[2]] = $true; Emit @{ ev = 'ok'; seq = $seq }
      } elseif ($cmd -eq 'kill') {
        $id = [int]$a[2]
        if ($held.ContainsKey($id) -and $own.ContainsKey($id)) { $held[$id].Kill(); Emit @{ ev = 'killed'; seq = $seq; pid = $id } }
        else { Emit @{ ev = 'refused'; seq = $seq; pid = $id } }
      } elseif ($cmd -eq 'parent') {
        $id = [int]$a[2]
        $q = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
        if ($q) { Emit @{ ev = 'parent'; seq = $seq; pid = $id; ppid = [int]$q.ParentProcessId; name = $q.Name; createdUtc = (Ms $q.CreationDate) } }
        else { Emit @{ ev = 'parent'; seq = $seq; pid = $id; gone = $true } }
      } elseif ($cmd -eq 'mem') {
        $id = [int]$a[2]; $p = $held[$id]; $p.Refresh()
        Emit @{ ev = 'mem'; seq = $seq; pid = $id; workingSet = $p.WorkingSet64; privateBytes = $p.PrivateMemorySize64 }
      } elseif ($cmd -eq 'survivors') {
        $like = '%' + $a[2] + '%'
        $ids = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '$like'" | ForEach-Object { [int]$_.ProcessId })
        Emit @{ ev = 'survivors'; seq = $seq; pids = $ids }
      } else { Emit @{ ev = 'bad'; seq = $seq } }
    } catch { Emit @{ ev = 'miss'; seq = $seq; why = [string]$_ } }
    $task = $stdin.ReadLineAsync()
  }
  foreach ($id in @($held.Keys)) {
    $p = $held[$id]
    if ($p.HasExited) {
      $code = $null; try { $code = $p.ExitCode } catch { }
      # 内核记录的退出时刻；偶发读到 1601 年（进程对象刚触发、时间还没填上）时退回到此刻，并标一笔
      $et = $p.ExitTime; $approx = $false
      if ($et.Year -lt 2000) { $et = [DateTime]::Now; $approx = $true }
      Emit @{ ev = 'exit'; pid = $id; exitedUtc = (Ms $et); exitCode = $code; approx = $approx }
      $done[$id] = $p; $held.Remove($id)
    }
  }
  Start-Sleep -Milliseconds 50
}
`;

export class Observer {
  private seq = 0;
  private pending = new Map<string, (m: any) => void>();
  private buf = '';
  readonly held = new Map<number, Held>();
  readyMs = 0;
  private constructor(private child: ChildProcess) {}

  /** 测试进程自己起的 PowerShell（不是引擎起的，不在任何被测作业里）；写出 ready 之后才算可用。 */
  static async start(): Promise<Observer> {
    const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(OBSERVER_PS, 'utf16le').toString('base64')],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const o = new Observer(child);
    let ready = false; let err = '';
    child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => { err += d; });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      o.buf += d;
      for (let nl = o.buf.indexOf('\n'); nl >= 0; nl = o.buf.indexOf('\n')) {
        const line = o.buf.slice(0, nl).trim(); o.buf = o.buf.slice(nl + 1);
        if (line === '') continue;
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.ev === 'ready') { ready = true; continue; }
        if (m.ev === 'exit') { const h = o.held.get(m.pid); if (h) { h.exitedUtc = m.exitedUtc; h.exitCode = m.exitCode ?? undefined; } continue; }
        // 握住的应答当场登记（不等 promise 的回调）：同一个 chunk 里紧跟着的 exit 行要找得到条目
        if (m.ev === 'held' && !m.again) o.held.set(Number(m.pid), { pid: Number(m.pid), name: String(m.name), createdUtc: Number(m.createdUtc), inJob: typeof m.inJob === 'boolean' ? m.inJob : null });
        const res = o.pending.get(String(m.seq)); if (res) { o.pending.delete(String(m.seq)); res(m); }
      }
    });
    child.on('error', () => undefined);
    const t0 = Date.now();
    try { await until('观察者 ready', () => ready || child.exitCode !== null, OBSERVER_READY_MS); }
    catch (e) { child.kill(); throw e; }
    if (!ready) throw new EnvNotReady(`观察者起不来: ${err.slice(-500)}`, Date.now() - t0);
    o.readyMs = Date.now() - t0;
    return o;
  }

  private ask(cmd: string): Promise<any> {
    const seq = String(++this.seq);
    return new Promise(res => { this.pending.set(seq, res); this.child.stdin!.write(`${seq} ${cmd}\n`); });
  }
  /** 握住句柄（此后这个 PID 不会被复用）。进程已不在返回 undefined。 */
  async watch(pid: number): Promise<Held | undefined> {
    const known = this.held.get(pid); if (known) return known;
    const m = await this.ask(`watch ${pid}`);
    void m;
    return this.held.get(pid);
  }
  async parent(pid: number): Promise<ParentInfo | undefined> {
    const m = await this.ask(`parent ${pid}`);
    return m.ev === 'parent' && !m.gone ? { pid, ppid: Number(m.ppid), name: String(m.name), createdUtc: Number(m.createdUtc) } : undefined;
  }
  /** 只用于观察：命令行里带这个令牌的进程（抓没来得及登记的）。 */
  async survivors(token: string): Promise<number[]> {
    const m = await this.ask(`survivors ${token}`);
    const p = m.pids; return Array.isArray(p) ? p.map(Number) : typeof p === 'number' ? [p] : [];
  }
  /** 约定里的第 2 种结束动作：只对已握住句柄、且标成「自己起的引擎」的那个 PID。 */
  async killOwnEngine(pid: number): Promise<boolean> {
    await this.ask(`own ${pid}`);
    return (await this.ask(`kill ${pid}`)).ev === 'killed';
  }
  /** 已握住句柄的进程此刻的内存（字节）。 */
  async mem(pid: number): Promise<{ workingSet: number; privateBytes: number } | undefined> {
    const m = await this.ask(`mem ${pid}`);
    return m.ev === 'mem' ? { workingSet: Number(m.workingSet), privateBytes: Number(m.privateBytes) } : undefined;
  }
  exited(pid: number): boolean { return this.held.get(pid)?.exitedUtc !== undefined; }
  close(): void { try { this.child.stdin!.end(); } catch { /* 已关 */ } }
}

// ---------- 进程树 ----------

export type Entry = 'shell' | 'terminal' | 'mcp-abs' | 'mcp-bare';
export const ENTRIES: readonly Entry[] = ['shell', 'terminal', 'mcp-abs', 'mcp-bare'];
export type Scenario = 'shutdown' | 'cancel' | 'engine-kill' | 'main-kill' | 'timeout' | 'shutdown-kill';
export interface ProcLine { role: string; pid: number; ppid: number; at: number; token: string }
/** 有心跳的四个角色（根另算）：MCP 入口里 child 一格是 mcp。 */
const rolesOf = (entry: Entry): string[] => [entry.startsWith('mcp') ? 'mcp' : 'child', 'leaf', 'leaf-detached', 'leaf-orphan'];

export interface Tree {
  entry: Entry; fx: string; token: string; sessionId?: string; server?: string; tag?: string;
  rootPid?: number; shape?: string;
}
export const procsOf = (t: Tree): ProcLine[] => lines(join(t.fx, 'procs.jsonl')).flatMap(l => { try { return [JSON.parse(l) as ProcLine]; } catch { return []; } });
export const roleProc = (t: Tree, role: string): ProcLine | undefined => procsOf(t).find(p => p.role === role);
const beatsOf = (t: Tree, role: string, pid: number): string[] => lines(join(t.fx, `beat-${role}-${pid}.log`));

/** shell 与终端用的同一段 PowerShell（一行）：记下驱动的 PID，起 child，然后显式占住（& 调图形子系统的 exe 不一定等待）。
 *  exitWith：「根自己退出」的变体——<fx>\go-exit 出现时驱动以这个退出码 exit（测试等树长成、握住句柄之后才放这个文件）。 */
export function treeCommand(fx: string, token: string, exitWith?: number): string {
  const hold = `-not (Test-Path -LiteralPath '${fx}\\stop') -and (Get-Date) -lt $until`;
  return [
    `Add-Content -LiteralPath '${fx}\\driver.pid' -Value $PID`,
    `$env:ELECTRON_RUN_AS_NODE = '1'`,
    `& '${ELECTRON}' '${TREE_FIXTURE}' '${fx}' child ${token}`,
    `$until = (Get-Date).AddMinutes(15)`,
    ...(exitWith === undefined
      ? [`while (${hold}) { Start-Sleep -Milliseconds 200 }`]
      : [`while (${hold} -and -not (Test-Path -LiteralPath '${fx}\\go-exit')) { Start-Sleep -Milliseconds 100 }`,
        `if (Test-Path -LiteralPath '${fx}\\go-exit') { exit ${exitWith} }`]),
  ].join('; ');
}

export interface RoleVerdict {
  role: string; pid: number | null; ppid: number | null; name: string | null; createdUtc: number | null; inJob: boolean | null;
  exitedUtc: number | null; exitCode: number | null; lagMs: number | null; lastBeat: number | null; beatsAfterAnchor: number | null;
  selfExit: boolean; verdict: 'dead' | 'alive' | 'inconclusive';
}

/**
 * 判定一棵树的各角色（设计 §7.2 的判活规则）：等锚点进程退出，再等各角色退出或到锚点之后 VERDICT_MS。
 * 「死了」只认句柄显示已退出（且心跳文件里没有 self-exit）；「还活着」要锚点之后至少 10 行心跳、且到锚点之后 VERDICT_MS
 * 句柄仍未退出；其余没有结论。anchorPid 为空（没找到根）时各格都没有结论。
 */
export async function judgeRoles(obs: Observer, t: Tree, anchorPid: number | null, rootParent: number | null, anchorName = 'root'): Promise<{ anchorExit: number | null; tree: RoleVerdict[]; notes: string[] }> {
  const notes: string[] = [];
  let anchorExit: number | null = null;
  if (anchorPid !== null) {
    try { await until(`锚点（${anchorName} ${anchorPid}）退出`, () => obs.exited(anchorPid), VERDICT_MS); anchorExit = obs.held.get(anchorPid)!.exitedUtc!; }
    catch { notes.push(`锚点（${anchorName}）在 VERDICT_MS 内没有退出`); }
  }
  const roles = rolesOf(t.entry);
  const pids = roles.map(r => roleProc(t, r)?.pid).filter((p): p is number => p !== undefined);
  const all = t.rootPid !== undefined ? [t.rootPid, ...pids] : pids;
  if (anchorExit !== null) {
    const deadline = anchorExit + VERDICT_MS;
    try { await until('各角色退出', () => all.every(p => obs.exited(p)) || Date.now() > deadline, VERDICT_MS + 10_000); } catch { /* 到点 */ }
  }
  const row = (role: string, pid: number | undefined, ppid: number | undefined, hasBeat: boolean): RoleVerdict => {
    const h = pid !== undefined ? obs.held.get(pid) : undefined;
    const beats = hasBeat && pid !== undefined ? beatsOf(t, role, pid) : [];
    const selfExit = beats.includes('self-exit');
    const stamps = beats.map(Number).filter(n => Number.isFinite(n));
    const after = anchorExit !== null ? stamps.filter(s => s > anchorExit!).length : null;
    const exitedUtc = h?.exitedUtc ?? null;
    let verdict: RoleVerdict['verdict'] = 'inconclusive';
    if (exitedUtc !== null && !selfExit) verdict = 'dead';
    else if (exitedUtc === null && h !== undefined && anchorExit !== null && Date.now() > anchorExit + VERDICT_MS && (!hasBeat || (after ?? 0) >= 10)) verdict = 'alive';
    return {
      role, pid: pid ?? null, ppid: ppid ?? null, name: h?.name ?? null, createdUtc: h?.createdUtc ?? null, inJob: h?.inJob ?? null,
      exitedUtc, exitCode: h?.exitCode ?? null, lagMs: exitedUtc !== null && anchorExit !== null ? Math.round(exitedUtc - anchorExit) : null,
      lastBeat: stamps.length > 0 ? stamps[stamps.length - 1] : null, beatsAfterAnchor: after, selfExit, verdict,
    };
  };
  const rootIsRole = t.rootPid !== undefined && roleProc(t, roles[0])?.pid === t.rootPid; // 基线上绝对路径 MCP 的根就是 server 自己
  const tree: RoleVerdict[] = [];
  if (!rootIsRole) tree.push(row('root', t.rootPid, rootParent ?? undefined, false));
  for (const r of roles) { const p = roleProc(t, r); tree.push(row(r === roles[0] && rootIsRole ? `${r}（根）` : r, p?.pid, p?.ppid, true)); }
  return { anchorExit, tree, notes };
}

/** 一棵不经引擎的树（P 组用）：只有目录与令牌。 */
export function bareTree(root: string, entry: Entry, n: number): Tree {
  const fx = join(root, `fx${n}`);
  mkdirSync(fx, { recursive: true });
  return { entry, fx, token: 'f09tok' + randomBytes(6).toString('hex') };
}
/** 各角色已登记、心跳在涨、观察者握住了句柄。 */
export async function rolesGrown(obs: Observer, t: Tree, capMs = TREE_GROWN_MS): Promise<void> {
  const roles = rolesOf(t.entry);
  await until(`树长成（${t.entry}）`, async () => {
    for (const r of roles) {
      const p = roleProc(t, r);
      if (!p || !(await obs.watch(p.pid)) || beatsOf(t, r, p.pid).length < 2) return false;
    }
    return true;
  }, capMs);
}

// ---------- 引擎宿主 ----------

export interface EngineRef {
  /** h1 = standalone 引擎；h2 = 替身主进程；h3 = 真实应用（开发态图形应用或打包目录），引擎是真实的 utilityProcess。 */
  host: 'h1' | 'h2' | 'h3'; pid: number; port: number; token: string;
  /** H1：引擎是测试的直接子进程。 */
  engine?: Engine;
  /** H2：替身主进程（测试的直接子进程）；引擎由它以 detached 起。 */
  hostChild?: ChildProcess;
  post(message: unknown): void;
  out(): string; err(): string;
}

function engineEnv(dataDir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...extra,
    ELECTRON_RUN_AS_NODE: '1', DESKMINIS_STANDALONE: '1', DESKMINIS_E2E: '1',
    DESKMINIS_DATA_DIR: dataDir, DESKMINIS_LOG_DIR: join(dataDir, 'logs'),
  };
  delete env.DESKMINIS_TEST; delete env.DESKMINIS_FAKE_PROVIDER; delete env.MINISD_HOST;
  return env;
}

/** 替身主进程的代码（Node 模式，-e 运行）：以 detached 起引擎（引擎因此不在替身的 libuv 作业里），回报引擎 PID，
 *  把 stdin 原样转给引擎（parentPort 消息的通道）。pipe 形态下引擎的 stdout / stderr 接在替身的管道上（产品的形态）。 */
const HOST_JS = `
const { spawn } = require('node:child_process'); const fs = require('node:fs');
const cfg = JSON.parse(process.env.F09_HOST_CFG);
const io = cfg.stdio === 'file' ? ['pipe', fs.openSync(cfg.out, 'a'), fs.openSync(cfg.err, 'a')] : ['pipe', 'pipe', 'pipe'];
const eng = spawn(process.execPath, cfg.args, { cwd: cfg.cwd, env: cfg.env, stdio: io, detached: true, windowsHide: true });
process.stdout.write(JSON.stringify({ enginePid: eng.pid }) + '\\n');
if (cfg.stdio !== 'file') { eng.stdout.on('data', d => process.stdout.write(d)); eng.stderr.on('data', d => process.stderr.write(d)); }
process.stdin.on('data', d => { try { eng.stdin.write(d); } catch {} });
eng.stdin.on('error', () => {});
setInterval(() => {}, 1000);
`;

// ---------- 实验台 ----------

export interface Evidence {
  scenario: string; entry: Entry; host: string; baseSha?: string; ownership?: unknown;
  load: { handshakeMs: number; observerReadyMs: number };
  shape: string;
  engine: { pid: number; createdUtc: number | null; inJob: boolean | null; exitedUtc: number | null; exitCode: number | null; engineEnd: string | null };
  action: { what: string; pid: number | null; requestedAt: number; how: string };
  anchor: { role: 'root' | 'engine'; pid: number | null; exitedUtc: number | null };
  rootReaped: boolean;
  tree: RoleVerdict[];
  rootReapedBy: 'owner-watch' | 'other' | null;
  toolResult?: unknown;
  bystanders: { what: string; pid: number; aliveAfter: boolean }[];
  cleanup: { what: string; pid: number; how: string }[];
  ledger?: unknown;
  verdict: 'clean' | 'leak' | 'inconclusive';
  notes: string[];
}

export class Lab {
  readonly root = mkdtempSync(join(tmpdir(), 'dm-f09-'));
  readonly dataDir = join(this.root, 'data');
  readonly binDir = join(this.root, 'bin');
  readonly scripts: Record<string, LlmStep[]> = {};
  readonly allow = new Set<string>();
  observer!: Observer;
  llm!: Awaited<ReturnType<typeof mockLlm>>;
  ref: EngineRef | undefined;
  c: Client | undefined;
  handshakeMs = 0;
  private tagNo = 0;
  private treeNo = 0;
  private bystanderProcs: { what: string; child: ChildProcess }[] = [];
  private bystanderTree: Tree | undefined;
  readonly cleanup: { what: string; pid: number; how: string }[] = [];
  readonly trees: Tree[] = [];

  static async open(): Promise<Lab> {
    const lab = new Lab();
    mkdirSync(lab.dataDir, { recursive: true }); mkdirSync(lab.binDir, { recursive: true });
    // 裸名 MCP 的垫片：经 cmd.exe /d /s /c dm-f09-mcp … 启动，真正的 server 是 cmd.exe 的子进程
    writeFileSync(join(lab.binDir, 'dm-f09-mcp.cmd'), `@"${ELECTRON}" "${TREE_FIXTURE}" %*\r\n`);
    lab.observer = await Observer.start();
    lab.llm = await mockLlm(lab.scripts);
    return lab;
  }

  /** 无关进程（V2）：测试自己起、全程握着句柄。一个睡眠的 powershell.exe、一个等待的 cmd.exe、一个空转的同名映像进程、
   *  一棵另一个令牌的 fixture 树。 */
  async startBystanders(): Promise<void> {
    const ps = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 900'], { stdio: 'ignore', windowsHide: true });
    const cmd = spawn(system32('cmd.exe'), ['/d', '/k'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const idle = spawn(ELECTRON, ['-e', 'setTimeout(() => {}, 900000)'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const t = this.newTree('shell');
    const other = spawn(ELECTRON, [TREE_FIXTURE, t.fx, 'child', t.token], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    this.bystanderProcs = [{ what: 'powershell.exe（睡眠）', child: ps }, { what: 'cmd.exe（等待）', child: cmd }, { what: '同名映像（空转）', child: idle }, { what: '无关树的 child', child: other }];
    for (const b of this.bystanderProcs) b.child.on('error', () => undefined);
    this.bystanderTree = t;
    this.trees.pop(); // 无关树不算被测树
    await until('无关树长成', () => rolesOf('shell').every(r => roleProc(t, r) !== undefined), TREE_GROWN_MS);
  }
  /** 无关进程此刻是否都还在：句柄未退出；无关树的各角色心跳仍在涨。 */
  async checkBystanders(): Promise<{ what: string; pid: number; aliveAfter: boolean }[]> {
    const out = this.bystanderProcs.map(b => ({ what: b.what, pid: b.child.pid ?? -1, aliveAfter: b.child.exitCode === null && b.child.signalCode === null }));
    const t = this.bystanderTree;
    if (t) {
      for (const role of rolesOf('shell').slice(1)) {
        const p = roleProc(t, role); if (!p) continue;
        const before = beatsOf(t, role, p.pid).length;
        let grew = false;
        try { await until('无关树心跳', () => beatsOf(t, role, p.pid).length > before, 10_000); grew = true; } catch { /* 没涨 */ }
        out.push({ what: `无关树的 ${role}`, pid: p.pid, aliveAfter: grew });
      }
    }
    return out;
  }

  private newTree(entry: Entry): Tree {
    const fx = join(this.root, `fx${++this.treeNo}`);
    mkdirSync(fx, { recursive: true });
    const t: Tree = { entry, fx, token: 'f09tok' + randomBytes(6).toString('hex') };
    this.trees.push(t);
    return t;
  }
  private newTag(steps: LlmStep[]): string {
    const tag = `S${++this.tagNo}`;
    this.scripts[tag] = steps;
    return tag;
  }

  /** H1：standalone 引擎（测试的直接子进程）。 */
  async startEngine(extraEnv: Record<string, string> = {}): Promise<EngineRef> {
    const t0 = Date.now();
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    let engine: Engine;
    try { engine = await spawnEngine(this.dataDir, { [pathKey]: this.binDir + ';' + (process.env[pathKey] ?? ''), ...extraEnv }, ENGINE_HANDSHAKE_MS); }
    catch (e) { throw new EnvNotReady(`引擎没有握手: ${String(e).slice(0, 400)}`, Date.now() - t0); }
    this.handshakeMs = Date.now() - t0;
    this.ref = { host: 'h1', pid: engine.pid, port: engine.port, token: engine.token, engine, post: m => engine.post(m), out: () => engine.stdout(), err: () => engine.stderr() };
    await this.connect();
    return this.ref;
  }

  /** H2：替身主进程以 detached 起引擎；结束替身就是「结束主进程」。引擎多预加载自限件，不留孤儿。 */
  async startHost(stdio: 'file' | 'pipe' = 'file', extraEnv: Record<string, string> = {}): Promise<EngineRef> {
    const t0 = Date.now();
    const fx = join(this.root, 'host'); mkdirSync(fx, { recursive: true });
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    const env = engineEnv(this.dataDir, { [pathKey]: this.binDir + ';' + (process.env[pathKey] ?? ''), DESKMINIS_F09_SELFLIMIT: fx, ...extraEnv });
    const cfg = { stdio, out: join(fx, 'engine.out'), err: join(fx, 'engine.err'), cwd: appRoot, env, args: ['-r', INJECT, '-r', SELFLIMIT, VITE_NODE, 'src/minisd/index.ts'] };
    const hostChild = spawn(ELECTRON, ['-e', HOST_JS], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', F09_HOST_CFG: JSON.stringify(cfg) } });
    let out = ''; let err = '';
    hostChild.stdout!.setEncoding('utf8'); hostChild.stdout!.on('data', (d: string) => { out += d; });
    hostChild.stderr!.setEncoding('utf8'); hostChild.stderr!.on('data', (d: string) => { err += d; });
    hostChild.on('error', () => undefined);
    const text = (): string => (stdio === 'file' ? (existsSync(cfg.out) ? readFileSync(cfg.out, 'utf8') : '') : out);
    let enginePid = 0; let hs: { minisdPort: number; authToken: string } | undefined;
    try {
      await until('替身回报引擎 PID', () => { const m = /"enginePid":(\d+)/.exec(out); if (m) enginePid = Number(m[1]); return enginePid > 0; }, ENGINE_HANDSHAKE_MS);
      const held = await this.observer.watch(enginePid);
      const par = await this.observer.parent(enginePid);
      if (!held || !par || par.ppid !== hostChild.pid) throw new EnvNotReady('引擎身份核对不过（父进程不是替身）', Date.now() - t0);
      await until('引擎握手（经替身）', () => {
        for (const line of text().split('\n')) {
          if (!line.includes('"minisdPort"')) continue;
          try { const j = JSON.parse(line.trim()); if (typeof j.minisdPort === 'number') { hs = j; return true; } } catch { /* 半行 */ }
        }
        return this.observer.exited(enginePid);
      }, ENGINE_HANDSHAKE_MS);
    } catch (e) {
      writeFileSync(join(fx, 'stop'), '');
      hostChild.kill();
      throw e instanceof EnvNotReady ? e : new EnvNotReady(String(e), Date.now() - t0);
    }
    if (!hs) throw new EnvNotReady(`引擎在握手前退出: ${(stdio === 'file' && existsSync(cfg.err) ? readFileSync(cfg.err, 'utf8') : err).slice(-400)}`, Date.now() - t0);
    this.handshakeMs = Date.now() - t0;
    this.ref = {
      host: 'h2', pid: enginePid, port: hs.minisdPort, token: hs.authToken, hostChild,
      post: m => { hostChild.stdin!.write(JSON.stringify({ parentPortMessage: m }) + '\n'); },
      out: text, err: () => (stdio === 'file' && existsSync(cfg.err) ? readFileSync(cfg.err, 'utf8') : err),
    };
    await this.connect();
    return this.ref;
  }

  /**
   * H3：真实应用。appExe 缺省 = 开发态图形应用（electron.exe . ，要先 build）；给了就是打包目录里的 exe。
   * 引擎是真实的 utilityProcess：端口与 token 取自数据根的 minisd-port.json，PID 取自 engine_instances，
   * 由观察者核对它的父进程是本脚本起的主进程之后才握住句柄。会弹出一个窗口与托盘图标。
   * 隔离：临时数据根 + DESKMINIS_E2E=1（凭据落临时根的文件库）；打包态另带 --user-data-dir，不碰正式的 userData、单实例锁与凭据库。
   */
  async startGui(appExe?: string): Promise<EngineRef> {
    const t0 = Date.now();
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k === 'ELECTRON_RUN_AS_NODE' || /^(DESKMINIS_|MINISD_|VITEST)/.test(k)) delete env[k];
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = this.binDir + ';' + (env[pathKey] ?? '');
    env.DESKMINIS_DATA_DIR = this.dataDir; env.DESKMINIS_E2E = '1';
    const main = appExe
      ? spawn(appExe, [`--user-data-dir=${join(this.root, 'electron')}`], { cwd: dirname(appExe), env, stdio: 'ignore' })
      : spawn(ELECTRON, ['.'], { cwd: appRoot, env, stdio: 'ignore' });
    main.on('error', () => undefined);
    const portFile = join(this.dataDir, 'minisd-port.json');
    let hs: { port: number; authToken: string } | undefined; let enginePid = 0;
    try {
      await until('应用写出引擎端口', () => {
        if (main.exitCode !== null) return true;
        try { const j = JSON.parse(readFileSync(portFile, 'utf8')); if (typeof j.port === 'number' && typeof j.authToken === 'string') { hs = j; return true; } } catch { /* 还没写 / 半个文件 */ }
        return false;
      }, ENGINE_HANDSHAKE_MS);
      if (!hs) throw new EnvNotReady(`应用在引擎起来之前退出（code=${main.exitCode}）`, Date.now() - t0);
      await until('引擎登记代次', () => { try { enginePid = Number(readDb(this.dataDir, 'SELECT pid FROM engine_instances ORDER BY epoch DESC LIMIT 1')[0]?.pid ?? 0); } catch { enginePid = 0; } return enginePid > 0; }, ENGINE_HANDSHAKE_MS);
      const held = await this.observer.watch(enginePid);
      const par = await this.observer.parent(enginePid);
      await this.observer.watch(main.pid!);
      if (!held || !par || par.ppid !== main.pid) throw new EnvNotReady('引擎身份核对不过（父进程不是本脚本起的主进程）', Date.now() - t0);
    } catch (e) {
      if (main.pid !== undefined && main.exitCode === null) spawnSync(system32('taskkill.exe'), ['/PID', String(main.pid), '/F'], { windowsHide: true, stdio: 'ignore' });
      throw e instanceof EnvNotReady ? e : new EnvNotReady(String(e), Date.now() - t0);
    }
    this.handshakeMs = Date.now() - t0;
    this.ref = { host: 'h3', pid: enginePid, port: hs.port, token: hs.authToken, hostChild: main, post: () => undefined, out: () => '', err: () => '' };
    await this.connect();
    return this.ref;
  }

  private async connect(): Promise<void> {
    const ref = this.ref!;
    await this.observer.watch(ref.pid);
    const c = rpcClient(ref.port, ref.token);
    await c.ready;
    this.c = c;
    autoAllow(c, this.allow);
    // 模型端点：已有同名实例（同一数据根的第二代引擎）就不再建
    const list = (await c.call('provider.instances.list', {})).result as { id: string; name: string }[] | undefined;
    if (!Array.isArray(list) || !list.some(p => p.name === 'f09-mock')) {
      const prov = (await c.call('provider.instances.create', { name: 'f09-mock', kind: 'ollama', baseUrl: this.llm.baseUrl, modelId: 'f09-mock' })).result;
      await c.call('provider.setDefault', { id: prov.id });
    }
  }

  private async newSession(): Promise<string> {
    const c = this.c!;
    const id = (await c.call('chat.sessions.create', {})).result.id as string;
    const ws = join(this.root, 'ws-' + id.slice(0, 8)); mkdirSync(ws, { recursive: true });
    await c.call('workspace.set', { sessionId: id, root: ws });
    this.allow.add(id);
    return id;
  }

  /** 这个实验目录的名字：它出现在本实验全部 fixture 进程（含裸名 MCP 的 cmd.exe 垫片）的命令行里，
   *  拿它问观察者的 survivors 就是「本实验起的进程里还有谁活着」（只观察）。 */
  get token(): string { return basename(this.root); }

  /** MCP 试连的树（mcp.servers.test）：server 不应答握手，树在启动时限内一直长着；不等应答。 */
  async startProbe(): Promise<Tree> {
    const t = this.newTree('mcp-abs');
    t.server = `f09-probe-${this.treeNo}`;
    void this.c!.call('mcp.servers.test', { name: t.server, command: ELECTRON, args: [TREE_FIXTURE, t.fx, 'mcp', t.token, '--no-handshake'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    return t;
  }

  /** 起一棵树。timeout：shell 的 timeout_seconds 取 TIMEOUT_SECONDS（否则 1800）；MCP 加 --no-handshake 与同样的启动时限。
   *  exitWith（只对 shell）：命令在 <fx>\go-exit 出现时以这个退出码 exit（根自己退出）。 */
  async startTree(entry: Entry, o: { timeout?: boolean; exitWith?: number } = {}): Promise<Tree> {
    const c = this.c!;
    const t = this.newTree(entry);
    if (entry === 'shell') {
      t.sessionId = await this.newSession();
      t.tag = this.newTag([
        { tools: [{ name: 'shell_execute', input: { command: treeCommand(t.fx, t.token, o.exitWith), timeout_seconds: o.timeout ? TIMEOUT_SECONDS : 1800, tool_title: 'F09 进程树' } }] },
        { text: '完成' },
      ]);
      await c.call('chat.prompt', { sessionId: t.sessionId, text: `[[${t.tag}]] 起一棵进程树` });
    } else if (entry === 'terminal') {
      t.sessionId = await this.newSession();
      await c.call('terminal.attach', { sessionId: t.sessionId });
      await c.call('terminal.input', { sessionId: t.sessionId, data: treeCommand(t.fx, t.token) + '\r' });
    } else {
      t.server = `f09-${entry === 'mcp-abs' ? 'abs' : 'bare'}-${this.treeNo}`;
      const flags = o.timeout ? ['--no-handshake'] : [];
      const entryCfg = entry === 'mcp-abs'
        ? { command: ELECTRON, args: [TREE_FIXTURE, t.fx, 'mcp', t.token, ...flags] }
        : { command: 'dm-f09-mcp', args: [t.fx, 'mcp', t.token, ...flags] };
      const r = await c.call('mcp.servers.upsert', { name: t.server, ...entryCfg, env: { ELECTRON_RUN_AS_NODE: '1' }, ...(o.timeout ? { startupTimeoutSeconds: TIMEOUT_SECONDS } : {}) });
      if (r.error) throw new Error(`mcp.servers.upsert 失败: ${JSON.stringify(r.error)}`);
      // 发一条消息触发 ensureForRun（模型只回一句话）
      t.sessionId = await this.newSession();
      t.tag = this.newTag([{ text: '好的' }]);
      // 不等应答：chat.prompt 要等 ensureForRun 连完才回，握手超时的情形里那时树已经被回收了
      void c.call('chat.prompt', { sessionId: t.sessionId, text: `[[${t.tag}]] 连一下 MCP` });
    }
    return t;
  }

  /** 让模型调一次工具（新会话、自动批准）：不等应答。 */
  async callTool(name: string, input: Record<string, unknown>): Promise<string> {
    const sessionId = await this.newSession();
    const tag = this.newTag([{ tools: [{ name, input: { ...input, tool_title: 'F09 调用' } }] }, { text: '完成' }]);
    void this.c!.call('chat.prompt', { sessionId, text: `[[${tag}]] 调一次工具` });
    return sessionId;
  }

  /** 找根：shell / 终端取 driver.pid；MCP 从 server 进程沿父链往上走到引擎的直接子进程。 */
  private async findRoot(t: Tree): Promise<void> {
    if (t.rootPid !== undefined) return;
    const chain: string[] = [];
    if (t.entry === 'shell' || t.entry === 'terminal') {
      const pid = Number(lines(join(t.fx, 'driver.pid'))[0]);
      if (!Number.isInteger(pid)) return;
      t.rootPid = pid;
      const child = roleProc(t, 'child');
      const h = await this.observer.watch(pid);
      chain.push(`${h?.name ?? '?'}(${pid}, 根)`, `child(${child?.pid}, ppid=${child?.ppid})`);
    } else {
      const mcp = roleProc(t, 'mcp'); if (!mcp) return;
      let pid = mcp.pid; let ppid = mcp.ppid;
      chain.unshift(`mcp(${pid})`);
      for (let depth = 0; depth < 4 && ppid !== this.ref!.pid; depth++) {
        const par = await this.observer.parent(ppid);
        if (!par) return;
        pid = ppid; ppid = par.ppid;
        chain.unshift(`${par.name}(${pid})`);
      }
      if (ppid !== this.ref!.pid) return;
      t.rootPid = pid;
      chain[0] += ' 根';
    }
    const kid = t.entry.startsWith('mcp') ? 'mcp' : 'child';
    const kids = ['leaf', 'leaf-detached', 'bouncer', 'leaf-orphan'].map(r => { const p = roleProc(t, r); return p ? `${r}(${p.pid}, ppid=${p.ppid})` : `${r}(?)`; });
    t.shape = `引擎(${this.ref!.pid}) → ${chain.join(' → ')}；${kid} 之下：${kids.join('、')}`;
  }

  /** 「长成了」：各角色已登记、心跳在涨、观察者握住了句柄、根已找到；shell 入口那次调用还没有 toolEnd。 */
  async grown(t: Tree): Promise<void> {
    const roles = rolesOf(t.entry);
    await until(`树长成（${t.entry}）`, async () => {
      if (!roles.every(r => roleProc(t, r) !== undefined)) return false;
      await this.findRoot(t);
      if (t.rootPid === undefined) return false;
      for (const r of roles) {
        const p = roleProc(t, r)!;
        if (!(await this.observer.watch(p.pid))) return false;
        if (beatsOf(t, r, p.pid).length < 2) return false;
      }
      return (await this.observer.watch(t.rootPid)) !== undefined;
    }, TREE_GROWN_MS);
    if (t.entry === 'shell' && eventsOf(this.c!, t.sessionId!).some(e => e.kind === 'toolEnd')) {
      throw new EnvNotReady('shell 入口：那次 shell_execute 已经返回，命令没有占住', 0);
    }
  }

  /** proc.trees.snapshot；方法不存在（F09 之前的基线）返回 undefined。 */
  async snapshot(): Promise<any | undefined> {
    const r = await this.c!.call('proc.trees.snapshot', {});
    return r.error ? undefined : r.result;
  }

  /** 只结束引擎本身（不带 /T）。H1：按测试握着的 ChildProcess；H2：经观察者握着的句柄。 */
  async killEngine(): Promise<void> {
    const ref = this.ref!;
    if (ref.engine) await killEngineOnly(ref.engine, []);
    else await this.observer.killOwnEngine(ref.pid);
  }
  /** 结束替身主进程（H2）：测试握着它的 ChildProcess。 */
  killHost(): void {
    const h = this.ref?.hostChild;
    if (h?.pid !== undefined && h.exitCode === null) spawnSync(system32('taskkill.exe'), ['/PID', String(h.pid), '/F'], { windowsHide: true, stdio: 'ignore' });
  }

  /** 判定一棵树：等锚点退出，再等各角色退出或到锚点之后 VERDICT_MS。 */
  async judge(t: Tree, scenario: string, action: Evidence['action'], anchorRole: 'root' | 'engine'): Promise<Evidence> {
    const ref = this.ref!;
    const obs = this.observer;
    const anchorPid = anchorRole === 'engine' ? ref.pid : t.rootPid ?? null;
    const { anchorExit, tree, notes } = await judgeRoles(obs, t, anchorPid, ref.pid, anchorRole);
    // 主进程被结束而引擎没有退出：不是「没有结论」，是产品的缺口（引擎与整棵树都留下）
    const engineStayed = scenario === 'main-kill' && anchorExit === null;
    if (engineStayed) notes.push('主进程被结束后引擎没有自己退出：引擎与整棵树都留下');
    const rootRow = tree[0];
    const eng = obs.held.get(ref.pid);
    const bystanders = await this.checkBystanders();
    let ledger: unknown;
    try { ledger = readDb(this.dataDir, 'SELECT * FROM process_trees ORDER BY started_at'); } catch { /* 表不存在（基线） */ }
    let toolResult: unknown;
    if (t.entry === 'shell' && t.sessionId) {
      try {
        const rows = readDb(this.dataDir, 'SELECT state, end_kind FROM tool_executions WHERE session_id=?', t.sessionId);
        const msgs = readDb(this.dataDir, 'SELECT parts_json FROM messages WHERE session_id=? ORDER BY created_at, id', t.sessionId);
        const results = msgs.flatMap(m => JSON.parse(m.parts_json) as { type: string; value: any }[]).filter(p => p.type === 'toolResult').map(p => p.value);
        toolResult = { rows, results: results.map(v => ({ status: v.status, success: v.success, tail: String(v.output).split('\n').slice(-3).join('\n') })) };
      } catch { /* 库读不了 */ }
    }
    const verdict: Evidence['verdict'] = engineStayed || tree.some(r => r.verdict === 'alive') ? 'leak' : tree.every(r => r.verdict === 'dead') ? 'clean' : 'inconclusive';
    return {
      scenario, entry: t.entry, host: ref.host, load: { handshakeMs: this.handshakeMs, observerReadyMs: obs.readyMs },
      shape: t.shape ?? '（没有找到根）',
      engine: { pid: ref.pid, createdUtc: eng?.createdUtc ?? null, inJob: eng?.inJob ?? null, exitedUtc: eng?.exitedUtc ?? null, exitCode: eng?.exitCode ?? null, engineEnd: null },
      action, anchor: { role: anchorRole, pid: anchorPid, exitedUtc: anchorExit },
      rootReaped: rootRow !== undefined && rootRow.exitedUtc !== null,
      tree, rootReapedBy: rootRow?.exitedUtc != null ? (rootRow.exitCode === 197 ? 'owner-watch' : 'other') : null,
      toolResult, bystanders, cleanup: [], ledger, verdict, notes,
    };
  }

  /** 收尾：写 stop 文件让 fixture 进程自己退出；引擎还活着就结束它（H1 按句柄；H2 先等自限，再经观察者握着的句柄）。
   *  返回引擎是怎么结束的。从不为清理杀 fixture 进程。 */
  async settle(engineWasKilled = false): Promise<string> {
    for (const t of [...this.trees, ...(this.bystanderTree ? [this.bystanderTree] : [])]) { try { writeFileSync(join(t.fx, 'stop'), ''); } catch { /* 目录没了 */ } }
    const ref = this.ref;
    let engineEnd = engineWasKilled ? 'killed' : 'exited';
    try { this.c?.close(); } catch { /* 已断开 */ }
    if (ref) {
      if (ref.engine) {
        if (ref.engine.child.exitCode === null && ref.engine.child.signalCode === null) { await killEngineOnly(ref.engine, []); engineEnd = 'cleaned'; this.cleanup.push({ what: '引擎（H1，直接子进程）', pid: ref.pid, how: 'taskkill /PID /F（握着 ChildProcess）' }); }
      } else if (ref.host === 'h3') {
        // 真实应用的引擎没法预加载自限件：还活着就经观察者握着的句柄结束它（身份在握住时核对过）
        if (!this.observer.exited(ref.pid) && await this.observer.killOwnEngine(ref.pid)) { engineEnd = 'cleaned'; this.cleanup.push({ what: '引擎（H3，utilityProcess）', pid: ref.pid, how: '观察者握着的句柄 Process.Kill()' }); }
        this.killHost();
      } else {
        if (!this.observer.exited(ref.pid)) {
          try { writeFileSync(join(this.root, 'host', 'stop'), ''); } catch { /* 目录没了 */ }
          try { await until('引擎按自限件退出', () => this.observer.exited(ref.pid), VERDICT_MS); engineEnd = 'self-exit'; }
          catch { if (await this.observer.killOwnEngine(ref.pid)) { engineEnd = 'cleaned'; this.cleanup.push({ what: '引擎（H2）', pid: ref.pid, how: '观察者握着的句柄 Process.Kill()' }); } }
        } else if (this.observer.held.get(ref.pid)?.exitCode === 86) engineEnd = 'self-exit';
        this.killHost();
      }
    }
    for (const b of this.bystanderProcs) { try { b.child.kill(); } catch { /* 已退出 */ } }
    // fixture 进程靠 stop 文件自己退出：等观察者握着的那些都退出（最多 VERDICT_MS），留下的记一笔
    const mine = [...this.observer.held.values()].filter(h => h.exitedUtc === undefined).map(h => h.pid);
    try { await until('fixture 进程自己退出', () => mine.every(p => this.observer.exited(p)), VERDICT_MS); }
    catch { this.cleanup.push({ what: '到点仍未退出的进程（不结束，等自限）', pid: mine.find(p => !this.observer.exited(p)) ?? -1, how: 'none' }); }
    return engineEnd;
  }
  async close(): Promise<void> {
    this.observer.close();
    await this.llm.close();
  }
}

/** 证据落盘（不进产品补丁）。 */
export function writeEvidence(dir: string, ev: Evidence, tag = ''): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ev.host}-${ev.scenario}-${ev.entry}${tag}.json`);
  writeFileSync(file, JSON.stringify(ev, null, 2));
  return file;
}
export function appendLog(file: string, line: string): void { appendFileSync(file, line + '\n'); }
export function summary(ev: Evidence): string {
  return `${ev.host} ${ev.scenario} ${ev.entry}: ${ev.verdict} 根回收=${ev.rootReaped} `
    + ev.tree.map(r => `${r.role}=${r.verdict}${r.lagMs !== null ? `(+${r.lagMs}ms,code=${r.exitCode})` : r.beatsAfterAnchor !== null ? `(心跳+${r.beatsAfterAnchor})` : ''}`).join(' ')
    + ` 无关进程=${ev.bystanders.every(b => b.aliveAfter) ? '全在' : '有退出的!'}` + (ev.notes.length ? ` 备注=${ev.notes.join('；')}` : '');
}

/**
 * 一格情形（一个引擎、一棵树）：探针脚本与先行复现用。R 组用例为了少起引擎，自己编排 Lab 的各步。
 * 情形：shutdown（A0 有序关停）、cancel（A1：shell 取消 / 终端删会话 / MCP 移除服务器）、engine-kill（A2）、
 * main-kill（A3，H2）、timeout（A4）。
 */
export async function runCell(o: {
  scenario: Scenario; entry: Entry; stdio?: 'file' | 'pipe'; extraEnv?: Record<string, string>;
  /** gui = 真实应用（H3）：开发态图形应用，或 app 指向的打包目录里的 exe。缺省按情形选 H1 / H2。 */
  host?: 'gui'; app?: string;
}): Promise<Evidence> {
  const lab = await Lab.open();
  let ev: Evidence | undefined;
  let engineKilled = false;
  try {
    await lab.startBystanders();
    if (o.host === 'gui') {
      if (o.scenario === 'shutdown' || o.scenario === 'shutdown-kill') throw new EnvNotReady('真实应用宿主不支持经 parentPort 发 shutdown 的情形', 0);
      await lab.startGui(o.app);
    } else if (o.scenario === 'main-kill') await lab.startHost(o.stdio ?? 'file', o.extraEnv); else await lab.startEngine(o.extraEnv);
    const ownership = (await lab.snapshot())?.ownership;
    const t = await lab.startTree(o.entry, { timeout: o.scenario === 'timeout' });
    await lab.grown(t);
    const c = lab.c!;
    const requestedAt = Date.now();
    let action: Evidence['action']; let anchor: 'root' | 'engine' = 'root';
    if (o.scenario === 'shutdown') {
      lab.ref!.post({ type: 'shutdown' });
      action = { what: '有序关停', pid: lab.ref!.pid, requestedAt, how: 'parentPort shutdown 消息' };
    } else if (o.scenario === 'cancel') {
      if (o.entry === 'shell') { void c.call('chat.cancel', { sessionId: t.sessionId }); action = { what: '取消', pid: t.rootPid ?? null, requestedAt, how: 'chat.cancel' }; }
      else if (o.entry === 'terminal') { void c.call('chat.sessions.delete', { sessionId: t.sessionId, confirm: true }); action = { what: '删除会话', pid: t.rootPid ?? null, requestedAt, how: 'chat.sessions.delete' }; }
      else { void c.call('mcp.servers.remove', { name: t.server }); action = { what: '移除服务器', pid: t.rootPid ?? null, requestedAt, how: 'mcp.servers.remove' }; }
    } else if (o.scenario === 'engine-kill') {
      anchor = 'engine'; engineKilled = true;
      await lab.killEngine();
      action = { what: '只结束引擎', pid: lab.ref!.pid, requestedAt, how: 'taskkill /PID <引擎> /F（不带 /T）' };
    } else if (o.scenario === 'shutdown-kill') {
      // 关停超时的形态：有序关停刚发起（回收可能做到一半）就只结束引擎
      anchor = 'engine'; engineKilled = true;
      lab.ref!.post({ type: 'shutdown' });
      await lab.killEngine();
      action = { what: '发 shutdown 后立刻只结束引擎', pid: lab.ref!.pid, requestedAt, how: 'parentPort shutdown 消息 + taskkill /PID <引擎> /F（不带 /T）' };
    } else if (o.scenario === 'main-kill') {
      anchor = 'engine';
      lab.killHost();
      action = { what: '结束替身主进程', pid: lab.ref!.hostChild?.pid ?? null, requestedAt, how: 'taskkill /PID <替身> /F（不带 /T）' };
    } else {
      action = { what: '工具超时', pid: t.rootPid ?? null, requestedAt, how: o.entry === 'shell' ? `timeout_seconds=${TIMEOUT_SECONDS}` : `--no-handshake + startupTimeoutSeconds=${TIMEOUT_SECONDS}` };
    }
    ev = await lab.judge(t, o.scenario, action, anchor);
    ev.ownership = ownership;
    if (lab.ref!.host === 'h3' && o.scenario === 'main-kill') {
      // G7：主进程被结束后引擎是怎么退出的——退出码 0 且本代记为有序关停 = 属主轮询触发的有序关停；否则是被系统（Chromium）结束的
      const main = lab.observer.held.get(lab.ref!.hostChild?.pid ?? -1);
      const eng = lab.observer.held.get(lab.ref!.pid);
      let closeKind: unknown = '（读不到）';
      try { closeKind = readDb(lab.dataDir, 'SELECT close_kind FROM engine_instances ORDER BY epoch DESC LIMIT 1')[0]?.close_kind ?? null; } catch { /* 库读不了 */ }
      ev.notes.push(`主进程 ${main?.pid} 退出于 ${main?.exitedUtc ?? '未退出'}；引擎${eng?.exitedUtc !== undefined && main?.exitedUtc !== undefined ? `晚 ${Math.round(eng.exitedUtc - main.exitedUtc)}ms 退出` : '未退出'}，退出码 ${eng?.exitCode ?? '—'}，close_kind=${String(closeKind)}`);
    }
  } finally {
    const engineEnd = await lab.settle(engineKilled).catch(e => `收尾失败: ${String(e)}`);
    if (ev) {
      const eng = lab.observer.held.get(lab.ref?.pid ?? -1);
      ev.engine.engineEnd = engineEnd; ev.engine.exitedUtc = eng?.exitedUtc ?? null; ev.engine.exitCode = eng?.exitCode ?? null;
      ev.cleanup = lab.cleanup;
    }
    await lab.close();
  }
  return ev as Evidence;
}

/** 数据根锁是否已放：锁文件不在了，或里面记的 PID 已不是活着的引擎（只读文件，不动任何进程）。 */
export function lockFiles(dataDir: string): string[] {
  try { return readdirSync(dataDir).filter(f => /lock/i.test(f)); } catch { return []; }
}
