import {
  STATE_PROTOCOL, StreamTracker, isAttachResult, isEventStamp,
  type AttachResult, type EventFrame, type EventStamp, type SnapshotReason, type StateSnapshot,
} from '@shared/event-stream';
import { isInFlightLoss, markInFlightLoss } from './lib/conn/in-doubt';

/** F06：入序的广播帧多带一个戳（帧顶层的 ev）；没有戳的帧（terminal.output、旧引擎的帧）第二个实参是 undefined。 */
type Handler = (params: any, ev?: EventStamp) => void;

/** W2b-3：连接断了之后，在途与新发起的 call 都以这句拒绝（设计稿 §3 第 7 条）。 */
const LOST = '与后台服务的连接已断开';

// ---------- F06：断线重连与事件续传（由 store 显式开启；不开启时本文件的行为与以前相同） ----------

export interface LinkStatus {
  state: 'open' | 'reconnecting' | 'lost';
  /** 第几次重连尝试（从 1 起）；open / lost 时是 0。 */
  attempt: number; maxAttempts: number;
  /** 这次尝试之前还要等多久。 */
  retryInMs?: number;
  /** 终态的原因：重连次数用尽，或主进程说引擎进程已经退出。 */
  reason?: 'exhausted' | 'engine-exited';
}
/** 一轮同步是谁要的：首次（initial）、切到在跑的会话（join）、重连（reconnect）、收到跳号的帧（gap）、
 *  收到别的代次的帧（foreign）、静默探测（probe）、终态后的手动重连（retry）。 */
export type SyncCause = 'initial' | 'join' | 'reconnect' | 'gap' | 'foreign' | 'probe' | 'retry';
/** 断线那一刻已经发出、没等到应答的调用。只用来向用户交代「结果未知」，从不重发。 */
export interface InDoubtCall { method: string; params: unknown }
export interface SyncInfo { via: 'resume' | 'snapshot'; cause: SyncCause; epochChanged: boolean; revision: number; missed: boolean; inDoubt: InDoubtCall[] }
export interface RecoveryHooks {
  /** attach 时带上的当前会话。 */
  attachParams(): { sessionId?: string };
  /** 用快照重建状态。必须同步完成、不得发起调用；返回后才放行水位之前没覆盖的帧与 seq > lastSeq 的事件。
   *  它之前只可能先交付一类帧：attach 往返里这条连接收到过的 run 终止事件（StreamTracker.settle 的 ended）。 */
  applySnapshot(snap: StateSnapshot, info: { reason: SnapshotReason; cause: SyncCause; epochChanged: boolean }): void;
  /** 续传的事件已按序分发完，用应答里的权威值校正。同步。 */
  resumed(r: Extract<AttachResult, { mode: 'resume' }>, info: { cause: SyncCause }): void;
  /** 一轮同步完成，每轮恰好调一次，重连时一定在开闸之后。inDoubt：断线时已发出、没等到应答的调用（没有重发），
   *  只在 cause 为 reconnect / retry 时非空。missed：见 StreamTracker.settle。 */
  synced?(info: SyncInfo): void;
  /** state:'open' 在开闸的那一刻同步通知：此后（含同一段同步代码里随后分发的回放帧的处理器）发起的调用都发得出去。 */
  status?(s: LinkStatus): void;
  /** 要不要做静默探测。'idle'：有活动 run 或待批卡——距上一帧超过 probeIdleMs 才探测；
   *  'poll'：有别处正在起跑、本窗口还没点亮的 run——距上一次 attach 应答超过 startPollMs 就探测，不看有没有别的帧。 */
  wantProbe?(): false | 'idle' | 'poll';
  /** 断线时问一次：上层是否已经就绪到可以靠重连恢复。回 false 就按终态处理（与没开恢复时相同）。
   *  store 在 init() 走完之前回 false：那时广播处理器还没登记全，重连回来的界面是残缺的。缺省 = 可以。 */
  canRecover?(): boolean;
}
export interface ReconnectPolicy { delaysMs: readonly number[]; jitter: number; connectTimeoutMs: number; attachTimeoutMs: number; probeIdleMs: number; startPollMs: number }
/** 缺省：0.5、1、2、4、8、8、8、8 秒（±20%），8 次不成进入终态（约 40 秒，另加各次的建连超时）；
 *  有活动 run 或待批卡而 20 秒没有任何帧时探测一次；有别处正在起跑的 run 时每 2 秒探测一次。 */
export const RECONNECT_POLICY: ReconnectPolicy = {
  delaysMs: [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000], jitter: 0.2,
  connectTimeoutMs: 5000, attachTimeoutMs: 10_000, probeIdleMs: 20_000, startPollMs: 2000,
};
/** 第 attempt 次（从 1 起）重连前等多久：delaysMs[attempt - 1] × (1 ± jitter)。超出表长按最后一项（封顶）。 */
export function reconnectDelayMs(attempt: number, p: ReconnectPolicy, rand: () => number = Math.random): number {
  if (p.delaysMs.length === 0) return 0;
  const i = Math.min(Math.max(1, Math.floor(attempt)), p.delaysMs.length) - 1;
  return Math.max(0, Math.round(p.delaysMs[i] * (1 + p.jitter * (2 * rand() - 1))));
}
/** 断线时已发出、结果未知的调用被拒绝时带这个标记（message 仍是「与后台服务的连接已断开」）。 */
export { isInFlightLoss };

export interface TimerApi { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface RecoveryOptions { policy?: Partial<ReconnectPolicy>; timers?: TimerApi; rand?: () => number; now?: () => number }

interface Recovery { hooks: RecoveryHooks; policy: ReconnectPolicy; timers: TimerApi; rand: () => number; now: () => number }
/** 排着或在跑的一轮同步，与等它结果的 resync() 调用方。 */
interface Round { cause: SyncCause; force: boolean; waiters: { resolve: () => void; reject: (e: unknown) => void }[] }

/** 断线结算给在途调用的应答上打的记号。用 symbol：引擎发来的帧是 JSON，带不出这个键。 */
const IN_FLIGHT = Symbol('inFlightLoss');
/** 一轮同步里最多 attach 这么多次（补洞、应答对不上重取）；还对不齐就按失败处理。 */
const SYNC_MAX_ROUNDS = 5;
/** 旧引擎没有 state.attach：rpc/server.ts 对不认识的方法回这句。 */
const UNKNOWN_ATTACH = '未知方法: state.attach';
const urlOf = (port: unknown, token: unknown): string => token
  ? `ws://127.0.0.1:${port}/?token=${encodeURIComponent(String(token))}`
  : `ws://127.0.0.1:${port}`;
const report = (what: string, e: unknown): void => { try { console.error(`[rpc] ${what}`, e); } catch { /* 没有控制台 */ } };

export class RpcClient {
  private ws: WebSocket | undefined;
  private idc = 0;
  private pending = new Map<number, (v: any) => void>();
  private handlers = new Map<string, Set<Handler>>();
  /** 握手完成信号：connect() 在**第一个 await 之前**就赋值。组件 onMounted 的首批 call 可能赶在
   *  握手完成前触发，不排队直接 send 会撞 CONNECTING 态抛 InvalidStateError（真机冒烟逮到）。
   *  X 波订正：此前这行注释是假话——ready 在 await minisdInfo() 之后才赋值，那几毫秒里的 call
   *  走 sendNow() 撞 this.ws 未建（TypeError）。子组件 onMounted 先于父组件跑，「先于 init 的 call」
   *  是生命周期事实，不是编程错误。 */
  private ready: Promise<void> | undefined;
  /** W2b-3：socket 关了（minisd 崩溃、被杀、端口被关）。之后的 call 立即拒绝——浏览器对 CLOSING / CLOSED 的
   *  socket send 不抛错、静默丢弃，不主动拒绝的话它会永远挂着。
   *  不按 readyState 判：握手期的假 socket（renderer-rpc-connecting）没有这个字段。
   *  F06：没开恢复时仍然只置一次、不重连也不重放。开了恢复之后它是「闸」：断线时关上，重连并同步成功的那一刻打开
   *  （runSync 的开闸一步）；闸关着的期间新发起的 call 当场拒绝，断线时在途的 call 永不重发。 */
  private lost = false;
  private lostHandlers = new Set<(reason: string) => void>();

  // ---- F06 ----
  /** 开了恢复才有值；旧引擎（没有 state.attach）或首次同步失败时清回 undefined，此后与没开过相同。 */
  private rec: Recovery | undefined;
  private readonly tracker = new StreamTracker();
  /** 套接字序号。每条套接字的回调闭包里带着自己的序号，不是当前序号的回调一律忽略：
   *  旧连接晚到的帧、应答、关闭都进不了任何处理器。套接字作废（断线、主动关闭）时也加一，于是「没有当前套接字」。 */
  private sockNo = 0;
  /** 已发出、还没等到应答的调用（只在开了恢复时记）：断线时据它说清「哪些调用结果未知」。不保存请求帧，不用来重发。 */
  private sent = new Map<number, InDoubtCall>();
  private inDoubt: InDoubtCall[] = [];
  /** 完成过一次同步。没完成过就断线 → 按原来的终态处理（上层手里还没有可恢复的状态）。 */
  private syncedOnce = false;
  /** 重连用尽或引擎已退出。只有 retryNow() 能离开。 */
  private terminal = false;
  /** 同一时刻最多一轮同步；在跑的时候又被要求，记在 queued 里，本轮结束后再来一轮。 */
  private busy = false;
  private running: Round | undefined;
  private queued: Round | undefined;
  private lastFrameAt = 0;
  private lastAttachAt = 0;
  private reconnectTimer: unknown;
  private probeTimer: unknown;

  async connect(): Promise<void> {
    // 整段包成一个 promise 同步挂到 ready：minisdInfo 的 IPC 往返也算握手的一部分，
    // 期间到达的 call 一律排队（与 CONNECTING 竞态同源、同一种修法）。
    this.ready = (async () => {
      const bridge = (window as any).deskminis;
      // minisd 要求 per-run token（否则任意网页都能连上本地端口驱动 agent）。
      // 老的 minisdPort() 只在 minisdInfo 不存在时兜底。
      let port: number;
      let token: string | undefined;
      if (typeof bridge?.minisdInfo === 'function') {
        const info = await bridge.minisdInfo();
        port = info?.port;
        token = info?.token;
      } else {
        port = await bridge.minisdPort();
      }
      await this.openSocket(urlOf(port, token));
    })();
    await this.ready;
  }

  /** 建一条套接字并挂上四个回调（首次连接与每次重连共用）。open 兑现、open 之前出错拒绝。 */
  private openSocket(url: string): Promise<void> {
    const no = ++this.sockNo;
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      // W2b-3：断线只认 close——浏览器异常断开是先 error 后 close，首次就连不上也一样，横幅在首启失败时同样出现
      this.ws.onclose = () => this.onSocketClose(no);
      this.ws.onmessage = ev => this.onSocketMessage(no, ev.data);
    });
  }

  private onSocketMessage(no: number, data: string): void {
    if (no !== this.sockNo) return; // 旧套接字晚到的帧
    const msg = JSON.parse(data);
    const rec = this.rec;
    if (rec) this.lastFrameAt = rec.now();
    if (msg.id !== undefined && this.pending.has(msg.id)) { this.sent.delete(msg.id); this.pending.get(msg.id)!(msg); this.pending.delete(msg.id); }
    else if (msg.method) {
      // 没开恢复、没有合法的戳（terminal.output、旧引擎）：原样分发
      if (!rec || this.tracker.phase === 'off' || !isEventStamp(msg.ev)) { for (const h of this.handlers.get(msg.method) ?? []) h(msg.params, msg.ev); return; }
      // 入序帧：按 seq 去重；同步期间只进缓冲；跳号或别的代次 → 发起一轮同步
      const out = this.tracker.offer({ method: msg.method, params: msg.params, ev: msg.ev });
      for (const f of out.deliver) this.dispatch(f);
      if (out.need) this.internalSync(out.need === 'snapshot' ? 'foreign' : 'gap');
    }
  }

  call<T = any>(method: string, params?: unknown): Promise<T> {
    const sendNow = (): Promise<T> => {
      if (this.lost) return Promise.reject(new Error(LOST));
      const id = ++this.idc;
      return new Promise((resolve, reject) => {
        this.pending.set(id, msg => msg.error ? reject(msg[IN_FLIGHT] === true ? markInFlightLoss(new Error(msg.error.message)) : new Error(msg.error.message)) : resolve(msg.result));
        if (this.rec) this.sent.set(id, { method, params });
        this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    };
    // 握手期间到达的调用排队等 open 再发；未 connect 过则维持原行为（ws! 抛错，暴露编程错误）
    return this.ready ? this.ready.then(sendNow) : sendNow();
  }

  on(method: string, h: Handler): void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(h);
  }

  // M2d Task 3：组件卸载时摘订阅（TerminalPanel.vue onUnmounted）
  off(method: string, h: Handler): void {
    this.handlers.get(method)?.delete(h);
  }

  /** W2b-3：订阅断线（store 在 connect 之前挂，横幅靠它出现）。没开恢复时只通知一次；
   *  开了恢复之后，每进入一次终态（重连用尽、引擎已退出）通知一次。 */
  onLost(h: (reason: string) => void): void {
    this.lostHandlers.add(h);
  }

  /** 断线结算：在途的 call 用 { error } 结算（与服务端报错同一条路：reject 出 LOST），再通知订阅者。
   *  只生效一次——close 重复到、error 与 close 先后到，都只算一次断线。 */
  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    const settles = [...this.pending.values()];
    this.pending.clear();
    for (const settle of settles) settle({ error: { message: LOST } });
    for (const h of this.lostHandlers) {
      try { h(LOST); } catch { /* 一个订阅者坏了不拦别的：横幅照样要出现 */ }
    }
  }

  // ==================== F06：重连、续传、不重发 ====================

  /** 开启重连与续传。不调它，行为与以前逐字相同。connect() 之前调。 */
  enableRecovery(hooks: RecoveryHooks, opts?: RecoveryOptions): void {
    this.rec = {
      hooks,
      policy: { ...RECONNECT_POLICY, ...opts?.policy },
      timers: opts?.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
      rand: opts?.rand ?? Math.random,
      now: opts?.now ?? Date.now,
    };
    // 首次同步完成之前，入序帧只进缓冲：快照装好之后才按水位放行
    this.tracker.phase = 'syncing';
  }

  /** 取一次快照并重建（initial / join）。进行中再调：排一轮，返回的 promise 在后一轮完成时兑现。
   *  返回的 promise 必在有限时间内落定：每轮受 attach 超时与轮数上限约束；当前套接字关闭或进入终态时，
   *  在跑的与排队的都以 LOST 拒绝，重连成功后也不替它们补跑（那一轮本身就是一次完整同步）。 */
  resync(cause: 'initial' | 'join' = 'join'): Promise<void> {
    if (!this.rec) return Promise.resolve(); // 没开恢复，或已因旧引擎关掉：没有可同步的
    if (this.lost) return Promise.reject(new Error(LOST));
    return this.requestSync(cause, true);
  }

  /** 终态 lost 之后手动再试一轮（只在开过恢复时有效）。这一轮强制取快照：终态时上层已经清过一部分状态。 */
  retryNow(): void {
    if (!this.rec || !this.terminal) return;
    this.terminal = false;
    this.scheduleAttempt(1, 'retry', true);
  }

  private dispatch(f: EventFrame): void {
    for (const h of this.handlers.get(f.method) ?? []) {
      // 一个处理器抛错不能让同一轮里后面的帧、后面的步骤（校正、开探测）都不做
      try { h(f.params, f.ev); } catch (e) { report(`${f.method} 的处理器抛错`, e); }
    }
  }

  private notify(s: LinkStatus): void {
    try { this.rec?.hooks.status?.(s); } catch (e) { report('status 钩子抛错', e); }
  }

  private requestSync(cause: SyncCause, force: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.queued) { this.queued.force = this.queued.force || force; this.queued.waiters.push({ resolve, reject }); }
      else this.queued = { cause, force, waiters: [{ resolve, reject }] };
      this.pump();
    });
  }

  private internalSync(cause: 'gap' | 'foreign' | 'probe'): void {
    // 失败的处理在 syncFailed 里（关掉套接字、走断线重连）；这里只防未处理的拒绝
    this.requestSync(cause, cause === 'foreign').catch(() => undefined);
  }

  /** 有排着的一轮、且没有在跑的，就开跑。 */
  private pump(): void {
    if (this.busy || !this.queued) return;
    const round = this.queued;
    if (!this.rec) { this.queued = undefined; for (const w of round.waiters) w.resolve(); return; }
    if (this.lost) { this.queued = undefined; for (const w of round.waiters) w.reject(new Error(LOST)); return; }
    this.queued = undefined;
    const no = this.sockNo;
    this.busy = true; this.running = round;
    const done = (): void => { this.busy = false; this.running = undefined; };
    this.runSync(round.cause, round.force, no, { gate: false }).then(
      () => { done(); for (const w of round.waiters) w.resolve(); this.pump(); },
      e => { done(); this.syncFailed(round, no, e); this.pump(); },
    );
  }

  /**
   * 一轮同步：state.attach → 按应答交付（快照，或游标之后的全部帧）→ 缓冲里接得上的帧。补洞与「应答对不上」在同一轮里重来。
   *
   * 重连（reconnect / retry）时闸在这里开，而且排在向上层交付任何东西之前：回放帧的处理器会发调用
   * （turnEnd / error 重取历史、*.changed 重拉列表），这些调用要到当前这段同步代码结束后的微任务里才过闸；
   * 闸若等这个函数返回之后才开，它们全部以 LOST 拒绝，界面停在断线前的样子。
   * 从开闸到交付结束之间没有任何 await，用户操作插不进来。
   */
  private async runSync(cause: SyncCause, force: boolean, no: number, st: { gate: boolean }): Promise<void> {
    const rec = this.rec!;
    const fresh = cause === 'reconnect' || cause === 'retry';
    let via: 'resume' | 'snapshot' = 'resume';
    let missed = false; let epochChanged = false; let revision = 0;
    for (let round = 1; ; round++) {
      if (round > SYNC_MAX_ROUNDS) throw new Error('state.attach 多轮之后仍然对不齐');
      const before = this.tracker.cursor ? { ...this.tracker.cursor } : undefined;
      // 第 3 轮起强制取快照（续传一直补不齐）
      const resume = this.tracker.begin({ newConnection: fresh && round === 1, forceSnapshot: (force && round === 1) || round >= 3 });
      const r = await this.attachOnce({ ...rec.hooks.attachParams(), ...(resume ? { resume } : {}), protocol: STATE_PROTOCOL });
      if (no !== this.sockNo) throw new Error(LOST);
      if (!isAttachResult(r)) throw new Error('state.attach 的应答形状不对');
      this.lastAttachAt = rec.now();
      revision = r.revision;
      const out = this.tracker.settle(r);
      // 续传应答对不上（accepted === false）：什么都不交付、闸不开，下一轮取快照
      if (out.accepted) {
        if (fresh && this.lost) {
          this.lost = false;
          st.gate = true;
          this.notify({ state: 'open', attempt: 0, maxAttempts: rec.policy.delaysMs.length });
        }
        if (r.mode === 'snapshot') {
          const changed = before !== undefined && (before.epoch !== r.epoch || before.instanceId !== r.instanceId);
          epochChanged = epochChanged || changed;
          missed = missed || out.missed;
          via = 'snapshot';
          // attach 往返里这条连接收到过的 run 终止事件：先照原路交给处理器（重试 / 接力入口、截断说明都在那条路上），再装快照。
          // 当成「快照已覆盖」丢掉的话，上层只能凭快照里的一行 run 去交代，这些入口就没了；快照里那次 run 已是终态，不会交代第二遍
          for (const f of out.ended) this.dispatch(f);
          try { rec.hooks.applySnapshot(r.snapshot, { reason: r.reason, cause, epochChanged: changed }); } catch (e) { report('applySnapshot 钩子抛错', e); }
          // 水位之前、快照没覆盖的帧（助手、技能、定时任务、注释、附件、导入进度、同步通知）照常交给处理器
          for (const f of out.uncovered) this.dispatch(f);
        } else {
          for (const f of out.replay) this.dispatch(f);
          try { rec.hooks.resumed(r, { cause }); } catch (e) { report('resumed 钩子抛错', e); }
        }
        for (const f of out.after) this.dispatch(f);
      }
      if (!out.need) break;
    }
    this.syncedOnce = true;
    // 断线时在途的调用到这一步才交出去（没有重发过）；不是重连的同步不动那张表
    const inDoubt = fresh ? this.inDoubt.splice(0) : [];
    try {
      const p: unknown = rec.hooks.synced?.({ via, cause, epochChanged, revision, missed, inDoubt });
      if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(e => report('synced 钩子拒绝', e));
    } catch (e) { report('synced 钩子抛错', e); }
    this.armProbe();
  }

  /** 发一次 state.attach 并等应答（带超时）。这是重连路径上唯一的内部调用：不过断线闸，不记入在途表。 */
  private attachOnce(params: unknown): Promise<unknown> {
    const rec = this.rec!;
    return new Promise((resolve, reject) => {
      const id = ++this.idc;
      const timer = rec.timers.set(() => {
        if (this.pending.delete(id)) reject(new Error('state.attach 超时'));
      }, rec.policy.attachTimeoutMs);
      this.pending.set(id, msg => { rec.timers.clear(timer); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); });
      try { this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'state.attach', params })); }
      catch (e) { this.pending.delete(id); rec.timers.clear(timer); reject(e); }
    });
  }

  private syncFailed(round: Round, no: number, e: unknown): void {
    const fail = (): void => { for (const w of round.waiters) w.reject(e); };
    // 套接字已经换了、作废了，或闸已经关上：断线流程接手了，这里什么都不再做
    if (no !== this.sockNo || this.lost) { fail(); return; }
    if (e instanceof Error && e.message === UNKNOWN_ATTACH) {
      // 旧引擎：关掉恢复，此后与没开过相同（断线即终态）。resync() 正常兑现
      this.disableRecovery();
      for (const w of round.waiters) w.resolve();
      return;
    }
    if (round.cause === 'initial' || !this.tracker.cursor) { this.disableRecovery(); fail(); return; }
    if (round.cause === 'join') {
      // 连接还在、只是这一次没取到：回到放行状态，扣下的帧按游标接续；接不上就走续传
      fail();
      const r = this.tracker.reopen();
      for (const f of r.deliver) this.dispatch(f);
      if (r.need) this.internalSync(r.need === 'snapshot' ? 'foreign' : 'gap');
      return;
    }
    // gap / foreign / probe：游标之后的帧补不回来，这条连接不能再用——主动关掉，走断线重连
    fail();
    this.abandonSocket();
    this.linkDown();
  }

  /** 关掉恢复：缓冲里的帧按到达顺序原样分发，此后帧不再经游标、断线走原来的终态路径。 */
  private disableRecovery(): void {
    this.stopProbe();
    this.rec = undefined;
    this.sent.clear();
    for (const f of this.tracker.off()) this.dispatch(f);
  }

  private onSocketClose(no: number): void {
    if (no !== this.sockNo) return; // 旧套接字晚到的关闭
    const rec = this.rec;
    // 没开恢复、从没完成过一次同步、或上层说还没就绪：原来的终态路径（connect() 报错、onLost 通知一次）
    if (!rec || !this.syncedOnce || rec.hooks.canRecover?.() === false) {
      this.failSyncs();
      this.markLost();
      return;
    }
    this.sockNo += 1; // 这条套接字作废：它之后的回调（重复的 close、晚到的帧）都不再认
    // 重连尝试里的新套接字又断了：在途的只有那次 state.attach，交给那次尝试按失败处理
    if (this.lost) { this.settleInFlight(); return; }
    this.linkDown();
  }

  /** 主动放弃当前套接字（同步失败、建连超时）。先作废序号再关：它的 close 回调不会再触发断线流程。 */
  private abandonSocket(): void {
    const ws = this.ws;
    this.sockNo += 1;
    try { ws?.close(); } catch { /* 已经关了 */ }
  }

  /** 断线结算（开了恢复）：在途的调用全部以 LOST 拒绝并带「在途」标记，记下方法与参数供事后交代。
   *  请求帧不保存：新连接上不会出现任何断线前在途的调用，引擎可能已经执行过它们。 */
  private settleInFlight(): void {
    const settles = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, settle] of settles) {
      const meta = this.sent.get(id);
      if (meta) this.inDoubt.push(meta);
      settle({ error: { message: LOST }, [IN_FLIGHT]: true });
    }
    this.sent.clear();
  }

  /** 落定保证：在跑的与排队的 resync() 一律以 LOST 拒绝，排队的轮次（含内部排的 gap / probe）全部作废。 */
  private failSyncs(): void {
    const rounds = [this.running, this.queued];
    this.queued = undefined;
    for (const r of rounds) for (const w of r?.waiters ?? []) w.reject(new Error(LOST));
  }

  /** 当前连接没了：关闸、结算在途调用、进入重连。上层的运行态、卡片、正文都不动（引擎里的任务还在跑）。 */
  private linkDown(): void {
    this.lost = true;
    this.settleInFlight();
    this.failSyncs();
    this.stopProbe();
    this.scheduleAttempt(1, 'reconnect');
  }

  private scheduleAttempt(n: number, cause: 'reconnect' | 'retry', immediate = false): void {
    const rec = this.rec;
    if (!rec) return;
    const delay = immediate ? 0 : reconnectDelayMs(n, rec.policy, rec.rand);
    this.notify({ state: 'reconnecting', attempt: n, maxAttempts: rec.policy.delaysMs.length, retryInMs: delay });
    const go = (): void => { this.reconnectTimer = undefined; void this.attemptReconnect(n, cause); };
    if (immediate) go(); else this.reconnectTimer = rec.timers.set(go, delay);
  }

  /** 第 n 次重连尝试。每一步都兜住：定时器回调里不留未处理的拒绝。 */
  private async attemptReconnect(n: number, cause: 'reconnect' | 'retry'): Promise<void> {
    const rec = this.rec;
    if (!rec || this.terminal) return;
    const st = { gate: false };
    let no = -1;
    try {
      // 每次都重新取端口与 token：引擎换过（开发态只换引擎）token 就变了，缓存的那个永远连不上
      const info = await (window as any).deskminis.minisdInfo();
      // 引擎进程已经退出：不空转几十秒，直接进终态
      if (info?.alive === false) { this.enterTerminal('engine-exited'); return; }
      const opened = this.openSocket(urlOf(info?.port, info?.token));
      no = this.sockNo;
      await this.within(opened, rec.policy.connectTimeoutMs, 'WebSocket 连接超时');
      if (no !== this.sockNo) throw new Error(LOST); // open 之后、同步之前又断了
      this.busy = true;
      try { await this.runSync(cause, cause === 'retry', no, st); } finally { this.busy = false; }
    } catch {
      if (st.gate) {
        // 开闸之后的后续轮次失败：上层已经在用这条连接，按断线重新来（尝试次数从 1 起）。
        // synced 没有调，inDoubt 原样留着，等下一次同步完成再交
        if (no === this.sockNo) { this.abandonSocket(); this.linkDown(); }
        return;
      }
      // 开闸之前失败：这一次尝试不成（闸一直关着，上层什么都没收到）
      if (no === this.sockNo) this.abandonSocket();
      if (n >= rec.policy.delaysMs.length) this.enterTerminal('exhausted');
      else this.scheduleAttempt(n + 1, cause);
      return;
    }
    // 同步期间排着的 resync（回放帧的处理器、上层在 synced 里要的 join）现在跑
    this.pump();
  }

  private within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    const rec = this.rec!;
    return new Promise<T>((resolve, reject) => {
      const t = rec.timers.set(() => reject(new Error(message)), ms);
      p.then(v => { rec.timers.clear(t); resolve(v); }, e => { rec.timers.clear(t); reject(e); });
    });
  }

  /** 终态：先通知 status，再通知 onLost 的订阅者各一次（store 走原来的 markConnectionLost）。 */
  private enterTerminal(reason: 'exhausted' | 'engine-exited'): void {
    this.terminal = true;
    this.failSyncs();
    this.notify({ state: 'lost', attempt: 0, maxAttempts: this.rec?.policy.delaysMs.length ?? 0, reason });
    for (const h of this.lostHandlers) {
      try { h(LOST); } catch { /* 一个订阅者坏了不拦别的 */ }
    }
  }

  /** 静默探测：没有后续帧时空洞检测不会触发（尾帧丢失、半开连接），界面会一直停在「运行中」；
   *  别处正在起跑的 run 在连 MCP 期间不发任何事件。周期检查，由上层说要不要探测。 */
  private armProbe(): void {
    const rec = this.rec;
    if (!rec || this.probeTimer !== undefined || rec.policy.probeIdleMs <= 0) return;
    const period = Math.max(1, Math.min(rec.policy.probeIdleMs / 2, rec.policy.startPollMs));
    const tick = (): void => {
      this.probeTimer = undefined;
      const r = this.rec;
      if (!r || this.lost) return; // 断线期间不探测；重连后的那一轮同步结束时重新上弦
      this.probeTick(r);
      this.probeTimer = r.timers.set(tick, period);
    };
    this.probeTimer = rec.timers.set(tick, period);
  }

  private probeTick(rec: Recovery): void {
    if (this.tracker.phase !== 'live' || this.busy || this.queued) return;
    let want: false | 'idle' | 'poll' = false;
    try { want = rec.hooks.wantProbe?.() ?? false; } catch (e) { report('wantProbe 钩子抛错', e); }
    const now = rec.now();
    const due = want === 'idle' ? now - this.lastFrameAt >= rec.policy.probeIdleMs
      : want === 'poll' ? now - this.lastAttachAt >= rec.policy.startPollMs
      : false;
    if (due) this.internalSync('probe');
  }

  private stopProbe(): void {
    if (this.probeTimer === undefined) return;
    this.rec?.timers.clear(this.probeTimer);
    this.probeTimer = undefined;
  }
}

export const rpc = new RpcClient();
