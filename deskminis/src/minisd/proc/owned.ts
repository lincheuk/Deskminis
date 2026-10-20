/**
 * F09 归属层：shell、终端、stdio MCP 三种入口共用的进程树登记、托管状态与关停入口。
 *
 * 每棵树的根自己建一个不许脱离、带 KILL_ON_JOB_CLOSE 的作业并把自己放进去，同时握着引擎进程的句柄、引擎一结束就终止
 * 整个作业（脚本在 own-script.ts）。这里是引擎一侧：决定这次 spawn 带不带前导 / 走不走 launcher，从根的 stderr 里摘出
 * 归属结论，记下每棵树的状态与结束方式，并在归属建不起来时退回 F09 之前的路径。
 *
 * 不变量：
 *  - protection === 'job' 只在根自己报告 job=armed watch=1、且标记里的 pid 等于引擎手里的子进程时成立。
 *    任何不确定都落成 none 或停在 pending（状态只少报、不多报）。
 *  - 回收仍是 killTree（proc/win-exec.ts，一字未改）：作业是多出来的一层。根被 taskkill 或兜底 kill 结束后作业自然关闭，
 *    连 taskkill /T 按父进程号找不到的后代一起结束。这里没有按进程名、映像名、命令行或库里存的 PID 的结束动作。
 *  - 归属层的任何失败都不会让三种入口不可用：没托管成就按 F09 之前的方式启动与回收，状态如实。
 *  - 记账（journal）失败不影响 spawn 与回收。
 *
 * 给 G02（浏览器进程，kind 追加 'browser'）的约束：
 *  - launcher 只转交 stdin / stdout / stderr 三个标准句柄；要第 4、5 个句柄的用法（--remote-debugging-pipe）不可用，改用回环端口。
 *  - 目标程序显式要求脱离作业（CREATE_BREAKAWAY_FROM_JOB）时，它的 CreateProcess 以拒绝访问失败。
 *  - 树的寿命不超过引擎，也不超过它的根。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ProcIdentity, ProcOwnershipStatus, ProcProtection, ProcStopCause, ProcTreeKind, ProcTreeView } from '../../shared/proc';
import { killTree, powershellPath, type ProcOpts } from './win-exec';
import { ARM_HOOK_PS, MarkerScanner, armPs, launcherPs, type ArmReport } from './own-script';
import { directCommand, winCommandLine } from './win-cmdline';

/** 写出第一份输入之后多久没有标记就先记 none / no-marker；也是等 launcher 标记的上限。 */
export const ARM_REPORT_TIMEOUT_MS = 15_000;
/** 带前导的根在起来后这么久之内、没出标记就自己退出，算「前导被拦」。 */
export const ROOT_STARTUP_WINDOW_MS = 10_000;
/** 连续这么多棵树到结束都没出过标记，就停用本次运行的托管。 */
export const ARM_STRIKE_LIMIT = 2;
/** launcher 失败后、直起之前等它退出的上限。 */
export const LAUNCHER_EXIT_WAIT_MS = 5_000;
/** 命令行超过这么长就不经 launcher（Windows 单个环境变量与命令行的上限都是 32767）。 */
const CMDLINE_MAX = 32_000;
/** 带路径的批处理目标：不分大小写，结尾的点、空格与其它空白都忽略（Windows 解析路径时会去掉它们）。
 *  只需是 Node 批处理护栏的超集：多判的写法只是不托管，结果仍与直起相同；漏判才会让 CreateProcessW 把批处理隐式交给 cmd.exe。 */
const BATCH_TARGET_RE = /\.(bat|cmd)[\s.]*$/i;
/** 带前导的根退出后，等它的 stderr 收尾（里面可能还有没读到的标记）的上限。 */
const EXIT_DRAIN_MS = 2_000;
/** 没有订阅者时攒着的 stderr 末尾长度（与 MCP 诊断尾巴同量级）。 */
const STDERR_BACKLOG_LIMIT = 16 * 1024;
/** 根判定「属主已不在」时的退出码，也是监视线程终止作业用的值（own-script.ts）。 */
const OWNER_GONE_EXIT = 197;

export interface ProcTreeMeta { kind: ProcTreeKind; sessionId?: string; ownerRef?: string; toolPrefix?: string }

/** 持久记录的接缝。四个方法都不抛。 */
export interface ProcJournal {
  opened(id: string, meta: ProcTreeMeta, root: { pid?: number }): void;
  /** 每次归属结论变化都调（pending → job / none，none(no-marker) → job）。 */
  protection(id: string, p: { protection: 'job' | 'none'; reason?: string; root?: ProcIdentity; targetPid?: number; preJob?: boolean }): void;
  stopRequested(id: string, cause: ProcStopCause): void;
  ended(id: string, e: { kind: 'exited' | 'stopped' | 'spawn-failed'; exitCode: number | null; signal: string | null }): void;
}

export interface OwnedTree {
  readonly id: string;
  readonly child: ChildProcess;
  protection(): ProcProtection;
  /** 根的 stderr 去掉标记行之后的文本（utf8，多字节跨 chunk 不坏）。终端与 MCP 订阅；shell 不订阅（等于原来的 resume）。 */
  onStderr(cb: (text: string) => void): void;
  /** 引擎第一次往根的 stdin 写东西之后调用一次：启动「等标记」的定时器（unref）。重复调用无效。 */
  firstInput(): void;
  /** 记下原因（只记第一次；根已退出时不记；记账失败不抛），然后 `return killTree(child, platform, spawnImpl, sysEnv, signal)`。
   *  killTree 的实参、返回值、同步抛错、「根已退出则不动任何 PID」与 F09 之前逐字相同；每次调用都照旧走 killTree。 */
  stop(cause: ProcStopCause, signal?: NodeJS.Signals): Promise<void>;
}

type ArmOutcome = 'report' | 'exit' | 'no-marker';

class Tree implements OwnedTree {
  readonly id: string;
  state: ProcProtection = 'pending';
  reason: string | undefined;
  report: ArmReport | undefined;
  /** 出过任何一行认得出的标记（不论结论）。 */
  sawMarker = false;
  ended = false;
  private stopCause: ProcStopCause | undefined;
  private inputSeen = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly spawnedAt: number;
  private readonly stderrCbs: ((text: string) => void)[] = [];
  private backlog = '';
  private readonly waiters: ((o: ArmOutcome) => void)[] = [];
  private readonly platform: string;
  private readonly spawnImpl: typeof spawn;
  private readonly sysEnv: NodeJS.ProcessEnv;
  root: ProcIdentity | undefined;
  targetPid: number | undefined;
  preJob: boolean | undefined;
  /** command 根（launcher）：有效的标记必须带 target 或 launch=failed。 */
  expectTarget = false;

  constructor(
    private readonly sup: ProcSupervisor,
    readonly child: ChildProcess,
    readonly meta: ProcTreeMeta,
    proc: ProcOpts,
    readonly armed: boolean,
  ) {
    this.id = sup.newId();
    this.spawnedAt = sup.now();
    this.platform = proc.platform ?? process.platform;
    this.spawnImpl = proc.spawnImpl ?? spawn;
    this.sysEnv = proc.sysEnv ?? process.env;
  }

  protection(): ProcProtection { return this.state; }

  /** 第一个订阅者登记之前到的文本先攒着（只留末尾），登记时补发：launcher 路径上调用方要等 spawnCommandOwned 返回才拿得到
   *  这棵树，目标在那之前写出的 stderr 不能丢。shell 从不订阅，攒的这一小段就是「排空」的代价。 */
  onStderr(cb: (text: string) => void): void {
    this.stderrCbs.push(cb);
    if (this.backlog.length > 0) {
      const text = this.backlog;
      this.backlog = '';
      try { cb(text); } catch { /* 订阅者的错不影响登记 */ }
    }
  }

  /** 挂 stderr（带前导的经扫描器摘掉标记行；不带的原样解码）与退出监听。各自兜住：假子进程不一定像 ChildProcess。 */
  attach(): void {
    const emit = (text: string): void => {
      if (text.length === 0) return;
      if (this.stderrCbs.length === 0) { this.backlog = (this.backlog + text).slice(-STDERR_BACKLOG_LIMIT); return; }
      for (const cb of this.stderrCbs) { try { cb(text); } catch { /* 订阅者的错不影响别人 */ } }
    };
    const scanner = this.armed ? new MarkerScanner(r => this.onReport(r)) : undefined;
    const decoder = new StringDecoder('utf8');
    try {
      this.child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        emit(scanner ? scanner.feed(text) : text);
      });
    } catch { /* 没有可挂的 stderr：归属结论等不到，按 no-marker 走 */ }
    const flush = (): void => { const tail = decoder.end(); emit(scanner ? scanner.feed(tail) + scanner.flush() : tail); };
    try {
      this.child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        const finish = (): void => { flush(); this.onEnd(code, signal); };
        // 'exit' 可能先于 stderr 里最后几个字节到：带前导的根刚写完标记就退出（第一条命令就是 exit）时，
        // 不等一下会把它看成「没出标记就自己结束」而误停用托管。等 stderr 收尾，最多 EXIT_DRAIN_MS
        // （没托管成的树里，后代可能还握着这条管道的写端，end 永远不来，所以要有上限）
        let err: ChildProcess['stderr'] | undefined;
        try { err = this.child.stderr; } catch { err = undefined; }
        if (!this.armed || this.sawMarker || !err || err.readableEnded || err.destroyed || typeof err.once !== 'function') { finish(); return; }
        let done = false;
        const once = (): void => { if (done) return; done = true; clearTimeout(drain); finish(); };
        const drain = setTimeout(once, EXIT_DRAIN_MS);
        drain.unref?.();
        err.once('end', once);
        err.once('close', once);
      });
      // spawn 失败（没有 pid）时只有 'error'、没有 'exit'。已经起来的进程上的 'error'（如 kill 失败）不代表它结束了，不据此关账
      this.child.once('error', () => { if (typeof this.child.pid !== 'number') this.onEnd(null, null, true); });
    } catch { /* 挂不上监听：这棵树留在 pending，由后一代关账 */ }
  }

  firstInput(): void {
    if (this.inputSeen) return;
    this.inputSeen = true;
    if (!this.armed || this.state !== 'pending' || this.ended) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.state !== 'pending' || this.ended) return;
      this.settle('none', 'no-marker');
      this.wake('no-marker');
    }, this.sup.armTimeoutMs);
    this.timer.unref?.();
  }

  stop(cause: ProcStopCause, signal?: NodeJS.Signals): Promise<void> {
    try {
      // 根已退出时不记：这次 stop 什么都不会做（killTree 开头同一个判断，旧 pid 可能已属于别的进程）
      if (this.stopCause === undefined && !this.ended && this.child.exitCode == null && this.child.signalCode == null) {
        this.stopCause = cause;
        this.sup.journalDo(j => j.stopRequested(this.id, cause));
      }
    } catch { /* 记账那一段各自兜住；killTree 的同步抛错照旧往外传 */ }
    return killTree(this.child, this.platform, this.spawnImpl, this.sysEnv, signal);
  }

  /** 等归属结论、根退出或 no-marker 三者之一（spawnCommandOwned 用）。capMs 到点返回 'deadline'。 */
  waitArm(capMs: number): Promise<ArmOutcome | 'deadline'> {
    if (this.state !== 'pending') return Promise.resolve(this.report ? 'report' : 'no-marker');
    if (this.ended) return Promise.resolve('exit');
    return new Promise(resolve => {
      let done = false;
      const finish = (o: ArmOutcome | 'deadline'): void => { if (done) return; done = true; clearTimeout(cap); resolve(o); };
      const cap = setTimeout(() => finish('deadline'), capMs);
      cap.unref?.();
      this.waiters.push(finish);
    });
  }

  /** 被调用方更小的启动时限截断的等待：记 launcher-deadline，不计入连续计数、不可被迟到的标记改写。 */
  markDeadline(): void {
    if (this.state !== 'pending') return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.settle('none', 'launcher-deadline');
  }

  private wake(o: ArmOutcome): void { for (const w of this.waiters.splice(0)) w(o); }

  private settle(protection: 'job' | 'none', reason?: string): void {
    this.state = protection;
    this.reason = reason;
    this.sup.noteProtection(this, protection, reason);
    this.sup.journalDo(j => j.protection(this.id, { protection, reason, root: this.root, targetPid: this.targetPid, preJob: this.preJob }));
  }

  private onReport(r: ArmReport): void {
    if (!this.sawMarker) { this.sawMarker = true; this.sup.strikes = 0; }
    // 归属结论只生效一次；例外：先记了 no-marker、之后到的迟到标记可以改写它
    if (this.state !== 'pending' && !(this.state === 'none' && this.reason === 'no-marker')) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.report = r;
    const pid = r.pid;
    if (pid === undefined || pid !== this.child.pid) {
      this.settle('none', 'marker-invalid'); // 不认别人的标记
    } else {
      this.root = { pid, createdAt: r.created };
      this.preJob = r.prejob;
      if (r.job === 'failed') {
        if (r.step === 'go') this.settle('none', 'launcher-not-released');
        else {
          const reason = `arm-failed:${r.step}:${r.code}`;
          this.settle('none', reason);
          this.sup.disable(reason);
        }
      } else if (r.launchFailed !== undefined) {
        this.settle('none', `launch-failed:${r.launchFailed}`);
      } else if (this.expectTarget && r.target === undefined) {
        this.settle('none', 'marker-invalid');
      } else {
        this.targetPid = r.target;
        if (r.watch === true) this.settle('job');
        else this.settle('none', 'no-owner-watch');
      }
    }
    this.wake('report');
  }

  private onEnd(code: number | null, signal: NodeJS.Signals | null, spawnFailed = false): void {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const stopped = this.stopCause !== undefined;
    if (this.armed && !this.sawMarker && !spawnFailed) {
      const wasNoMarker = this.state === 'none' && this.reason === 'no-marker';
      if (this.state === 'pending') this.settle('none', 'exited-before-arm');
      if (!stopped) {
        // 没有人对它调过 stop、它自己结束了。197 = 根判定「属主已不在」；引擎明明还在（正在处理这次退出），判定必是误报
        // （典型是系统时钟回拨）：当场停用，否则此后每个带前导的根都在第一条命令处以 197 退出。
        if (code === OWNER_GONE_EXIT) this.sup.disable('owner-check-misfired');
        // 别的退出码、且发生在写过输入之后或刚起来不久：前导被拦（安全软件、策略）
        else if (this.inputSeen || this.sup.now() - this.spawnedAt < ROOT_STARTUP_WINDOW_MS) this.sup.disable('root-exited-before-arm');
      }
      // 等满了时限也没出过标记的树：连续计数，到上限说明前导挂死，停用（否则 shell 永远超时）。launcher-deadline 不计数
      if (wasNoMarker) {
        this.sup.strikes++;
        if (this.sup.strikes >= ARM_STRIKE_LIMIT) this.sup.disable('arm-unresponsive');
      }
    }
    this.sup.forget(this);
    this.sup.journalDo(j => j.ended(this.id, { kind: spawnFailed ? 'spawn-failed' : stopped ? 'stopped' : 'exited', exitCode: code, signal }));
    this.wake('exit');
  }

  /** 登记时就没有 pid（spawn 同步失败）：当场关账，stop 仍走 killTree。 */
  spawnFailed(): void { this.onEnd(null, null, true); }

  view(startedAt: number): ProcTreeView {
    return {
      id: this.id, epoch: 0, kind: this.meta.kind, sessionId: this.meta.sessionId, ownerRef: this.meta.ownerRef,
      root: this.root ?? (typeof this.child.pid === 'number' ? { pid: this.child.pid } : undefined), targetPid: this.targetPid,
      protection: this.state, protectionReason: this.reason, preJob: this.preJob, startedAt, stopCause: this.stopCause,
    };
  }
  get startedAtSec(): number { return this.spawnedAt / 1000; }
}

export class ProcSupervisor {
  /** 连续「到结束都没出过标记」的树数（Tree 维护）。 */
  strikes = 0;
  readonly armTimeoutMs: number;
  readonly now: () => number;
  readonly newId: () => string;
  private readonly ownerPid: number;
  private readonly warn: (m: string, e?: unknown) => void;
  private journal: ProcJournal | undefined;
  private disabledReason: string | undefined;
  private sawJob = false;
  private lastFailure: string | undefined;
  private readonly trees = new Set<Tree>();

  constructor(o: {
    /** 以停用状态起始（总开关） */
    disabled?: string;
    /** 属主（引擎）的 PID，缺省 process.pid；不是正整数则 wants() 恒为假 */
    ownerPid?: number;
    /** 缺省 ARM_REPORT_TIMEOUT_MS（测试注入短值） */
    armTimeoutMs?: number;
    now?: () => number; newId?: () => string; warn?: (m: string, e?: unknown) => void;
  } = {}) {
    this.disabledReason = o.disabled;
    this.ownerPid = o.ownerPid ?? process.pid;
    this.armTimeoutMs = o.armTimeoutMs ?? ARM_REPORT_TIMEOUT_MS;
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? randomUUID;
    this.warn = o.warn ?? ((m, e) => { if (e === undefined) console.warn(m); else console.warn(m, e); });
  }

  /** 装配后半段接上账本。接上之前登记的树只在内存里（那时还没有任何入口能起进程）。 */
  bind(journal: ProcJournal): void { this.journal = journal; }

  get status(): ProcOwnershipStatus {
    const lastFailure = this.lastFailure !== undefined ? { lastFailure: this.lastFailure } : {};
    if (this.disabledReason !== undefined) return { state: 'disabled', reason: this.disabledReason, ...lastFailure };
    return { state: this.sawJob ? 'active' : 'untested', ...lastFailure };
  }

  private get ownerOk(): boolean { return Number.isSafeInteger(this.ownerPid) && this.ownerPid > 0; }

  /** 要不要给这次 spawn 带前导 / 走 launcher：platform === 'win32'、没有停用、ownerPid 合法。 */
  wants(platform: string): boolean {
    return platform === 'win32' && this.disabledReason === undefined && this.ownerOk;
  }

  /** 这次 spawn 不带前导时该记的原因（armed 为假的树）。 */
  unarmedReason(platform: string): string {
    if (platform !== 'win32') return 'not-windows';
    return this.disabledReason ?? 'disabled';
  }

  /** 本次运行不再尝试托管。只记第一次的原因，并告警一行（经主进程进按天日志）。不持久化，下次启动重新试。 */
  disable(reason: string): void {
    if (this.disabledReason !== undefined) return;
    this.disabledReason = reason;
    this.warn(`进程托管已停用（${reason}）：本次运行里 shell、终端与 MCP 启动的子进程不受作业对象托管，应用被强制结束时可能残留`);
  }

  /** 带前导的驱动脚本 = armPs(ownerPid) + driverPs(ARM_HOOK_PS)。 */
  armedDriver(driverPs: (hook: string) => string): string {
    return armPs(this.ownerPid) + driverPs(ARM_HOOK_PS);
  }

  /** launcher 全文（spawnCommandOwned 用）。 */
  launcherScript(): string { return launcherPs(this.ownerPid); }

  /** driver 根与直起的根：spawn 返回之后同步调用。armed = 这次 spawn 用的是不是带前导的脚本；
   *  reason = armed 为假时的 protectionReason。从不抛。child.pid 为空（spawn 失败）时照样返回句柄，stop 仍走 killTree。 */
  adopt(child: ChildProcess, meta: ProcTreeMeta, proc: ProcOpts, o: { armed: boolean; reason?: string }): OwnedTree {
    return this.adoptTree(child, meta, proc, o);
  }

  /** 同 adopt，返回内部句柄（launcher 路径要等结论）。 */
  adoptTree(child: ChildProcess, meta: ProcTreeMeta, proc: ProcOpts, o: { armed: boolean; reason?: string; expectTarget?: boolean }): Tree {
    const tree = new Tree(this, child, meta, proc, o.armed);
    tree.expectTarget = o.expectTarget === true;
    try {
      this.trees.add(tree);
      let pid: number | undefined;
      try { pid = typeof child.pid === 'number' ? child.pid : undefined; } catch { pid = undefined; }
      this.journalDo(j => j.opened(tree.id, meta, { pid }));
      if (!o.armed) {
        tree.state = 'none';
        tree.reason = o.reason ?? this.unarmedReason(proc.platform ?? process.platform);
        this.journalDo(j => j.protection(tree.id, { protection: 'none', reason: tree.reason }));
      }
      tree.attach();
      if (pid === undefined) tree.spawnFailed();
    } catch (e) { this.warn('进程树登记失败（不影响启动与回收）:', e); }
    return tree;
  }

  /** 内存里还没结束的树（快照与用例用）。 */
  open(): ProcTreeView[] {
    return [...this.trees].map(t => t.view(t.startedAtSec));
  }

  // ---- 以下由 Tree 调用 ----

  /** 记账：没有账本、或账本抛了，都不影响调用方。 */
  journalDo(fn: (j: ProcJournal) => void): void {
    if (!this.journal) return;
    try { fn(this.journal); } catch (e) { this.warn('进程账本写入失败（不影响启动与回收）:', e); }
  }

  noteProtection(tree: Tree, protection: 'job' | 'none', reason?: string): void {
    if (protection === 'job') { this.sawJob = true; this.lastFailure = undefined; }
    else if (tree.armed) this.lastFailure = reason;
  }

  forget(tree: Tree): void { this.trees.delete(tree); }
}

/** 等一个子进程退出，最多 capMs。已退出立即返回。 */
function waitExit(child: ChildProcess, capMs: number): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, capMs);
    timer.unref?.();
    child.once('exit', done);
  });
}

/**
 * command 根（MCP；G02 的浏览器）：经 launcher 在作业里启动 command + args。
 * 托管不可用、或 launcher 路径上出了任何问题，都改调 direct()（F09 之前的直起路径），它的成功或拒绝原样作为结果：
 * libuv 起得来的照样起得来，起不来的报的还是原来的文案。整个函数里 direct() 至多调一次。
 * 没有 proc.supervisor 时直接 `{ child: await direct() }`，不登记。
 *
 * launcher 不带 -ExecutionPolicy Bypass：它会经环境变量传给目标的后代，改变 MCP 树里 PowerShell 的执行策略；
 * -EncodedCommand 不是脚本文件，不受执行策略限制。
 */
export async function spawnCommandOwned(o: {
  meta: ProcTreeMeta; command: string; args: readonly string[]; cwd?: string; env: Record<string, string | undefined>;
  direct: () => Promise<ChildProcess>;
  /** 调用方给的启动时限；等 launcher 标记的上限取它与 armTimeoutMs 的较小值。
   *  等满 armTimeoutMs 没有标记记 no-marker（计入连续计数）；被更小的 deadlineMs 截断的记 launcher-deadline（不计数、不停用）。 */
  deadlineMs: number;
}, proc: ProcOpts): Promise<{ child: ChildProcess; tree?: OwnedTree }> {
  const sup = proc.supervisor;
  if (!sup) return { child: await o.direct() };
  const platform = proc.platform ?? process.platform;
  const spawnImpl = proc.spawnImpl ?? spawn;
  const sysEnv = proc.sysEnv ?? process.env;
  const directAdopt = async (reason: string): Promise<{ child: ChildProcess; tree: OwnedTree }> => {
    const child = await o.direct();
    return { child, tree: sup.adopt(child, o.meta, proc, { armed: false, reason }) };
  };
  if (!sup.wants(platform)) return directAdopt(sup.unarmedReason(platform));
  const hasPath = o.command.includes('\\') || o.command.includes('/');
  if (hasPath && BATCH_TARGET_RE.test(o.command)) return directAdopt('batch-target');
  const d = directCommand(o.command, o.args, platform, sysEnv);
  const cmdline = winCommandLine(d.file, d.args);
  if (cmdline.length > CMDLINE_MAX) return directAdopt('cmdline-too-long');

  // PowerShell 启动时会改写 PSModulePath：把原先有没有、原值带给 launcher，起目标前还原
  const psmpKey = Object.keys(o.env).find(k => k.toLowerCase() === 'psmodulepath');
  const psmp = psmpKey !== undefined ? o.env[psmpKey] : undefined;
  const compatKey = Object.keys(o.env).find(k => k.toLowerCase() === '__compat_layer');
  const compat = compatKey !== undefined ? o.env[compatKey] : undefined;
  const nonce = randomBytes(8).toString('hex');
  let launcher: ChildProcess;
  try {
    launcher = await new Promise<ChildProcess>((resolve, reject) => {
      const c = spawnImpl(powershellPath(sysEnv), ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', Buffer.from(sup.launcherScript(), 'utf16le').toString('base64')], {
        shell: false, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...o.env, MINIS_OWN_NONCE: nonce, MINIS_OWN_CMDLINE: cmdline, MINIS_OWN_PSMP_SET: psmp !== undefined ? '1' : '0', MINIS_OWN_PSMP: psmp ?? '', MINIS_OWN_COMPAT_SET: compat !== undefined ? '1' : '0', MINIS_OWN_COMPAT: compat ?? '' },
      });
      let settled = false;
      // 常挂 'error' 监听：spawn 成功后的迟到 'error' 没有监听器会冒泡成未捕获异常
      c.on('error', (e: unknown) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } });
      c.once('spawn', () => { if (!settled) { settled = true; resolve(c); } });
    });
  } catch {
    return directAdopt('fallback:launcher-spawn-failed'); // 典型是 cwd 不存在：交给直起路径报它原来的错
  }
  const tree = sup.adoptTree(launcher, o.meta, proc, { armed: true, expectTarget: true });
  try {
    launcher.stdin?.on('error', () => { /* launcher 已死时写入的 EPIPE：由下面的等待收口 */ });
    launcher.stdin?.write(nonce + '\n'); // 放行行：spawn() 已返回，运行时对这个根的处理已做完，此后它才建作业
  } catch { /* 写不进去：launcher 读到 EOF 自己以 197 退出，走回退 */ }
  tree.firstInput();
  const cap = Math.min(o.deadlineMs, sup.armTimeoutMs);
  const outcome = await tree.waitArm(cap);
  if (outcome === 'deadline') tree.markDeadline();
  // 目标已在作业里起来了：job（属主监视就位）或 none / no-owner-watch（没有监视，但取消时照样整棵收）
  if (tree.targetPid !== undefined && (tree.state === 'job' || tree.reason === 'no-owner-watch')) return { child: launcher, tree };
  // 回退：launcher 还活着就先收掉它（连同它可能已起的东西），等它退出，再直起一次
  const why = tree.reason ?? 'no-marker';
  // launcher 自己报了失败（没读到放行行、归属失败、目标起不来）：它正要以 197 / 198 退出，先等它自己走，不必起 taskkill
  if (outcome === 'report' && tree.report !== undefined && (tree.report.job === 'failed' || tree.report.launchFailed !== undefined)) {
    await waitExit(launcher, LAUNCHER_EXIT_WAIT_MS);
  }
  if (launcher.exitCode == null && launcher.signalCode == null) {
    void tree.stop('startup-failed');
    await waitExit(launcher, LAUNCHER_EXIT_WAIT_MS);
  }
  return directAdopt(`fallback:${why}`);
}
