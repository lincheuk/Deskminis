/**
 * F04：资源锁表——一个引擎进程里只有一张，所有会话的工具调用共用。
 *
 * 为什么要有：循环以前让同批最多 10 个工具调用同时跑，不看它们碰不碰同一个文件；不同会话之间更是没有任何协调
 * （新会话与定时会话继承上次的工作区，多个会话共用一个目录是常态）。两个调用写同一个文件时，谁的权限卡先被点谁先落盘。
 *
 * 规则（冲突判定见 requestsConflict）：
 *  - 一个请求的全部资源在同一个同步步骤里一起授予，从不「拿着一部分等另一部分」——等待关系只从后到的指向先到的
 *    或已持有的，持有者不再向锁表要锁，所以没有死锁。持锁的工具不得再经调度器发起工具调用。
 *  - 先到先得、不插队：后到的请求只要与某个更早、仍在等的请求冲突就得等；与前面都不冲突的可以越过去。
 *    这同时给出同批的调用顺序和跨会话的先后，写者不会被后来的读者饿死。
 *  - 每会话并发上限是授予条件：拿到锁就可以执行，不存在「拿着锁等名额」。
 *  - 等别的会话有上限（waitTimeoutMs），只算「直接被别的会话挡住」的时间；只被本会话前序调用或并发上限挡住的不计时
 *    ——那是模型自己排的顺序，前序调用自带时限。
 *  - 取消（signal）与超时只作用于还在等的请求；已授予的由持有者放。
 *
 * 锁只在内存里：进程退出持有者一并消失，没有磁盘锁文件，没有陈旧锁。覆盖面也只在这一个引擎进程内
 * （另一个 minisd、用户的编辑器、Office 进程不在其内）。
 */
import type { ResourceMode } from './types';

export type LockClaim =
  /** root / segs 取自 data-gate.ts 的 pathIdentity()：覆盖它自己和它之下的整棵子树。 */
  | { ns: 'path'; root: string; segs: string[]; mode: ResourceMode; display: string }
  | { ns: 'named' | 'session'; key: string; mode: ResourceMode; display: string };

/** group = 会话 id。同一会话同时只有一个 run、一批调用（index.ts 的 inFlight 守卫）。 */
export interface LockRequest { group: string; label: string; claims: LockClaim[]; signal?: AbortSignal }
/** display：本请求自己那条被挡住的 claim（给模型看的是它自己给的路径，不带对方会话的任何信息）。 */
export interface LockBlocker { label: string; display: string }
export type LockResult =
  | { ok: true; waitedMs: number; release(): void }                       // release 幂等
  | { ok: false; reason: 'cancelled' | 'timeout'; waitedMs: number; blockedBy?: LockBlocker };

export interface LockManagerOptions { maxConcurrentPerGroup?: number; waitTimeoutMs?: number; now?: () => number }
export interface LockSnapshot {
  held: { group: string; label: string; claims: string[] }[];
  waiting: { group: string; label: string; claims: string[]; blockedBy?: string; foreignBlocked: boolean }[];
}

/** 每会话同时在跑的工具调用上限（沿用循环原来的并发数）。 */
export const MAX_CONCURRENT_PER_SESSION = 10;
/** 等别的会话放锁的上限。必须大于权限兜底时限（index.ts 的 PERM_TIMEOUT_MS，90 秒）：
 *  一次跨会话阻塞的正常上界是一张权限卡加一条 shell 命令（默认 120 秒）。 */
export const LOCK_WAIT_TIMEOUT_MS = 300_000;

export function claimKey(c: LockClaim): string {
  return c.ns === 'path' ? `path:${c.root}${c.segs.join('/')}` : `${c.ns}:${c.key}`;
}

/** 两条 claim 指的是不是同一处资源（不看读写）。path 按段比较：一个是另一个的前缀（含相等）即重叠，
 *  父目录与子文件算重叠——写 D/sub/x 会建目录，会改变「列 D」的结果；D 与 D-evil 不重叠。 */
export function claimsOverlap(a: LockClaim, b: LockClaim): boolean {
  if (a.ns === 'path') {
    if (b.ns !== 'path' || a.root !== b.root) return false;
    const n = Math.min(a.segs.length, b.segs.length);
    for (let i = 0; i < n; i++) if (a.segs[i] !== b.segs[i]) return false;
    return true;
  }
  return b.ns === a.ns && a.key === b.key;
}

/** a 里第一条与 b 冲突的 claim；没有冲突返回 undefined。
 *  冲突 = 资源重叠，并且：两边都是写（任何会话之间）；或同一会话里至少一边是写（同批顺序：读-写也要排）。
 *  跨会话的读不等写：别的会话在一条 shell 命令或一张权限卡期间连读都读不了，是对现状的功能回退；
 *  丢数据与覆盖只发生在写-写之间。要改成严格读写互斥，删掉下面的 sameGroup 条件即可。 */
function conflictingClaim(
  a: Pick<LockRequest, 'group' | 'claims'>, b: Pick<LockRequest, 'group' | 'claims'>,
): LockClaim | undefined {
  const sameGroup = a.group === b.group;
  for (const x of a.claims) {
    for (const y of b.claims) {
      if (!claimsOverlap(x, y)) continue;
      if (x.mode === 'write' && y.mode === 'write') return x;
      if (sameGroup && (x.mode === 'write' || y.mode === 'write')) return x;
    }
  }
  return undefined;
}

export function requestsConflict(
  a: Pick<LockRequest, 'group' | 'claims'>, b: Pick<LockRequest, 'group' | 'claims'>,
): boolean {
  return conflictingClaim(a, b) !== undefined;
}

interface Req {
  seq: number; group: string; label: string; claims: LockClaim[];
  enqueuedAt: number;
  signal?: AbortSignal;
  /** 开始被别的会话直接挡住的时刻；不再被挡时清零。 */
  foreignSince?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** 最近一次 pump 判定的直接阻挡者（别的会话的持有者，或更早入队、仍在等的别的会话请求）。 */
  blocker?: LockBlocker;
  resolve: (r: LockResult) => void;
}

export class ResourceLockManager {
  private readonly held = new Set<Req>();
  /** 按入队序号递增。 */
  private waiting: Req[] = [];
  private readonly running = new Map<string, number>();
  /** 同一个 signal 只挂一个 abort 监听（一批调用共用一个会话级 signal；逐请求挂监听，超过 10 个 Node 会打 MaxListenersExceededWarning）。 */
  private readonly signals = new Map<AbortSignal, { listener: () => void; reqs: Set<Req> }>();
  private counter = 0;
  private readonly maxPerGroup: number;
  private readonly waitTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: LockManagerOptions = {}) {
    this.maxPerGroup = Math.max(1, opts.maxConcurrentPerGroup ?? MAX_CONCURRENT_PER_SESSION);
    this.waitTimeoutMs = opts.waitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 入队是同步的：返回 Promise 之前票号已定、已做过一次授予判定——调用方在一段不含 await 的代码里连续 acquire，
   *  票号就按调用顺序连续，别的会话插不进中间。Promise 只兑现一次，从不拒绝。 */
  acquire(req: LockRequest): Promise<LockResult> {
    return new Promise<LockResult>(resolve => {
      if (req.signal?.aborted) { resolve({ ok: false, reason: 'cancelled', waitedMs: 0 }); return; }
      const r: Req = {
        seq: ++this.counter, group: req.group, label: req.label, claims: req.claims,
        enqueuedAt: this.now(), signal: req.signal, resolve,
      };
      this.waiting.push(r);
      this.watch(r);
      this.pump();
    });
  }

  /** 只读副本，按入队序。测试、诊断与 F06 的快照用。 */
  snapshot(): LockSnapshot {
    const bySeq = (a: Req, b: Req): number => a.seq - b.seq;
    return {
      held: [...this.held].sort(bySeq).map(r => ({ group: r.group, label: r.label, claims: r.claims.map(claimKey) })),
      waiting: [...this.waiting].sort(bySeq).map(r => ({
        group: r.group, label: r.label, claims: r.claims.map(claimKey),
        ...(r.blocker ? { blockedBy: r.blocker.label } : {}),
        foreignBlocked: r.blocker !== undefined,
      })),
    };
  }

  /** 授予判定。同步，不调用任何外部代码（resolve 只是兑现 Promise，续体在微任务里跑）。
   *  四处调用缺一不可：acquire 与 release 推进「被持有者挡住」的请求；取消与超时出队后的两处推进
   *  「只被一个等待中的请求按先后挡住、与任何持有者都不冲突」的请求——等待者出队时没有人放锁，
   *  漏掉那次 pump 它就白等到某个不相干的持有者放锁，或者等满超时。 */
  private pump(): void {
    const passed: Req[] = [];   // 本轮看过、仍在等的请求
    for (const r of [...this.waiting]) {
      const { blocked, direct } = this.blockersOf(r, passed);
      const capFull = (this.running.get(r.group) ?? 0) >= this.maxPerGroup;
      if (!blocked && !capFull) { this.grant(r); continue; }
      passed.push(r);
      if (direct) {
        r.blocker = direct;
        if (r.foreignSince === undefined && Number.isFinite(this.waitTimeoutMs) && this.waitTimeoutMs > 0) {
          r.foreignSince = this.now();
          r.timer = setTimeout(() => this.onTimeout(r), this.waitTimeoutMs);
          r.timer.unref?.();
        }
      } else {
        // 只被本会话的调用或并发上限挡住：不计时
        r.blocker = undefined;
        r.foreignSince = undefined;
        this.clearTimer(r);
      }
    }
  }

  /** r 被谁挡着：先看持有者，再看排在它前面、仍在等的请求。
   *  direct = 其中第一个别的会话的请求（display 取 r 自己那条被挡住的 claim）。 */
  private blockersOf(r: Req, ahead: Req[]): { blocked: boolean; direct?: LockBlocker } {
    let blocked = false;
    let direct: LockBlocker | undefined;
    for (const other of [...this.held, ...ahead]) {
      const hit = conflictingClaim(r, other);
      if (!hit) continue;
      blocked = true;
      if (!direct && other.group !== r.group) direct = { label: other.label, display: hit.display };
    }
    return { blocked, direct };
  }

  private grant(r: Req): void {
    this.dequeue(r);
    this.unwatch(r);
    this.held.add(r);
    this.running.set(r.group, (this.running.get(r.group) ?? 0) + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.held.delete(r);
      const left = (this.running.get(r.group) ?? 1) - 1;
      if (left > 0) this.running.set(r.group, left); else this.running.delete(r.group);
      this.pump();
    };
    r.resolve({ ok: true, waitedMs: this.now() - r.enqueuedAt, release });
  }

  private onTimeout(r: Req): void {
    if (!this.waiting.includes(r)) return;   // 已授予或已取消：先到者胜
    this.dequeue(r);
    this.unwatch(r);
    r.resolve({ ok: false, reason: 'timeout', waitedMs: this.now() - r.enqueuedAt, ...(r.blocker ? { blockedBy: r.blocker } : {}) });
    this.pump();
  }

  private onAbort(signal: AbortSignal): void {
    const entry = this.signals.get(signal);
    if (!entry) return;
    this.signals.delete(signal);
    signal.removeEventListener('abort', entry.listener);
    // entry.reqs 里只有还在等的：授予、超时出队时都已 unwatch
    for (const r of entry.reqs) {
      this.dequeue(r);
      r.resolve({ ok: false, reason: 'cancelled', waitedMs: this.now() - r.enqueuedAt });
    }
    this.pump();
  }

  /** 从等待队列摘下并清掉它的定时器。 */
  private dequeue(r: Req): void {
    const i = this.waiting.indexOf(r);
    if (i >= 0) this.waiting.splice(i, 1);
    this.clearTimer(r);
  }

  private clearTimer(r: Req): void {
    if (r.timer !== undefined) { clearTimeout(r.timer); r.timer = undefined; }
  }

  private watch(r: Req): void {
    const signal = r.signal;
    if (!signal) return;
    let entry = this.signals.get(signal);
    if (!entry) {
      const listener = (): void => this.onAbort(signal);
      entry = { listener, reqs: new Set() };
      this.signals.set(signal, entry);
      signal.addEventListener('abort', listener);
    }
    entry.reqs.add(r);
  }

  private unwatch(r: Req): void {
    const signal = r.signal;
    if (!signal) return;
    const entry = this.signals.get(signal);
    if (!entry) return;
    entry.reqs.delete(r);
    if (entry.reqs.size === 0) {
      signal.removeEventListener('abort', entry.listener);
      this.signals.delete(signal);
    }
  }
}
