/**
 * F06：有序事件、快照与续传——引擎与客户端共用的线上契约，外加客户端一侧的游标状态机。
 *
 * 只有 import type，其余是常量、纯函数与一个不做 I/O 的类（与 shared/run.ts、shared/permission.ts 同一做法）。
 *
 * 以前广播帧没有序号：客户端分不清重复、漏帧、乱序，断线即终态，重载后进行中的回合、待批的权限卡、流到一半的正文都无处可取。
 * 现在：
 *  - 除 UNSEQUENCED_METHODS 外，引擎的每条广播在帧顶层带 ev { epoch, seq }（params 与以前逐字相同）；
 *  - state.attach 在一段同步代码里给出 lastSeq 时刻的权威状态（快照），或游标之后的全部帧（续传）；
 *  - 客户端按 seq 去重、发现空洞就续传、同步期间扣帧（StreamTracker）。
 *
 * 后续任务的扩展点：往 StateSnapshot 加可选字段、在 WriteRef / WriteOutcome 的联合末尾追加一种 kind；
 * 新广播照常走 RpcServer.broadcast 即自动入序。往快照里加字段并新增对应广播时，把那个方法加进 coveredBySnapshot。
 */
import type { RunView, ToolExecState, ToolExecutionView } from './run';
import type { PermissionSettledInfo } from './permission';
import type { RawMessage, SessionMeta } from './types';
import type {InputView} from './inputs';

export const STATE_PROTOCOL = 1;

/** 广播帧顶层的 ev：{ jsonrpc:'2.0', method, params, ev }。method / params 与以前逐字相同。
 *  epoch = 引擎代次（RunLedger.epoch，持久，每次引擎启动加一）；seq 在一个 epoch 内从 1 起逐条加一、无空洞。 */
export interface EventStamp { epoch: number; seq: number }
export interface EventFrame { method: string; params: unknown; ev: EventStamp }
/** Session-owned payloads can be erased without leaving a hole in the sequence.
 * Lifecycle and session-list notices remain available to reconcile deletion. */
export function eventSessionId(method: string, params: unknown): string | undefined {
  if (method === 'chat.sessions.lifecycle' || method === 'chat.sessions.changed') return undefined;
  if (params === null || typeof params !== 'object') return undefined;
  const p = params as { sessionId?: unknown; req?: { sessionId?: unknown } };
  if (typeof p.sessionId === 'string') return p.sessionId;
  return typeof p.req?.sessionId === 'string' ? p.req.sessionId : undefined;
}
/** 不入序的广播：没有 ev、不留存、不续传。其余经 RpcServer.broadcast 发出的一律入序（含 chat.event 的 synced 形态）。 */
export const UNSEQUENCED_METHODS: readonly string[] = ['terminal.output'];

/** 形状校验：两个字段都是安全整数，seq 从 1 起。不合法的戳按「没有戳」处理（旧引擎的帧、别的来源的帧）。 */
export function isEventStamp(x: unknown): x is EventStamp {
  if (x === null || typeof x !== 'object') return false;
  const o = x as { epoch?: unknown; seq?: unknown };
  return typeof o.epoch === 'number' && Number.isSafeInteger(o.epoch) && typeof o.seq === 'number' && Number.isSafeInteger(o.seq) && o.seq >= 1;
}

/** 客户端游标。instanceId 识破「epoch 数字相同但不是同一个引擎进程」（库被整份替换）。 */
export interface StreamCursor { epoch: number; instanceId: string; lastSeq: number }
export type FrameVerdict = 'apply' | 'duplicate' | 'gap' | 'foreign';
/** epoch 不同 → foreign；seq <= lastSeq → duplicate；seq === lastSeq + 1 → apply；其余 → gap。 */
export function judgeFrame(c: Pick<StreamCursor, 'epoch' | 'lastSeq'>, ev: EventStamp): FrameVerdict {
  if (ev.epoch !== c.epoch) return 'foreign';
  if (ev.seq <= c.lastSeq) return 'duplicate';
  return ev.seq === c.lastSeq + 1 ? 'apply' : 'gap';
}

export interface PermissionRequestWire {
  sessionId: string; kind: string; detail: string; toolTitle: string;
  preview?: { oldText: string; newText: string }; note?: string;
}
/** 待批权限卡：requestId / req / meta 与当初 permission.request 广播的 params 相同。 */
export interface PendingPermissionView {
  requestId: string; req: PermissionRequestWire;
  meta: { timeoutMs: number; riskClass?: string; bridgeTriggers?: string[]; toolUseId?: string };
  origin: 'tool' | 'bridge';
  /** 引擎时钟，毫秒。 */
  askedAt: number;
  /** 应答那一刻离超时还剩多少；客户端据它算倒计时，不依赖两边时钟一致。 */
  remainingMs: number;
}
/** 一个活动 run 还没落库的流式尾巴：最近一个重置点之后已发布的正文与思考。
 *  重置点：messagePersisted、retry、fallback。seq 是这个 run 最近一条事件的序号。 */
export interface RunLiveView {
  runId: string; sessionId: string; generation: number; epoch: number;
  text: string; thinking: string; truncated?: true; seq: number;
}
export interface SnapshotArtifact {
  sessionId: string; runId: string; toolUseId: string; tool: string; state: ToolExecState;
  writePaths: string[]; offloadPath?: string;
}

/** lastSeq 时刻的权威状态。后续任务往这里加可选字段，客户端忽略不认识的字段。 */
export interface StateSnapshot {
  epoch: number; instanceId: string;
  /** 持久状态修订号，本 epoch 内单调不减。同一 epoch 下 (lastSeq, revision) 相同
   *  ⇒ 两份快照除 takenAt / remainingMs 外内容相同；没有对应事件的库写入也会让它变大。 */
  revision: number;
  /** 在快照覆盖的域上（会话列表、run、待批卡、尾巴、所带会话的消息），快照已包含 seq <= lastSeq 的全部事件的效果；
   *  之后的增量从 lastSeq + 1 起，一条不缺。快照没覆盖的域（助手、技能、定时任务、注释、附件状态、导入进度、同步通知）
   *  不在这个保证里：客户端对水位之前的这类帧另行处理（coveredBySnapshot 与 StreamTracker.settle 的 uncovered / missed）。 */
  lastSeq: number;
  takenAt: number;
  /** 与 chat.sessions.list 同形。 */
  sessions: SessionMeta[];
  /** RunLedger.snapshot() 的 runs：全部活动 run，加 sessionId 的最近一次 run。已删除会话（F11B：已清除的与保留副本）的不带——
   *  下面的 executions / live / artifacts 同样；与 chat.runs.snapshot 同一口径。 */
  runs: RunView[];
  /** 同上：所列 run 的最后一批与未交付的行。 */
  executions: ToolExecutionView[];
  live: RunLiveView[];
  pendingPermissions: PendingPermissionView[];
  /** 所列 run 全部批次里声明了写入目标或产生了卸载文件的调用。 */
  artifacts: SnapshotArtifact[];
  /** F07 all unconsumed inputs and bounded recent terminal inputs, across visible sessions. */
  inputs?: InputView[];
  /** 给了 sessionId 才有。exists:false = 会话已不存在。messages 与 chat.messages.list 同形。 */
  session?: { sessionId: string; exists: boolean; messages: RawMessage[] };
}

/** 一帧的效果是否已被快照覆盖。覆盖：permission.request、permission.resolved、chat.sessions.changed、
 *  带 event 字段的 chat.event（run 事件）。其余一律不覆盖（含 kind:'synced' 的 chat.event、将来新增的广播）。
 *  这是一张白名单：往 StateSnapshot 加字段并新增对应广播的任务把那个方法加进来，否则水位之前的那类帧会被多交付一次。
 *  已覆盖的帧里有一类不是简单丢掉：这条连接收到过的 run 终止事件，在装快照之前先交给处理器（StreamTracker.settle 的 ended）。 */
export function coveredBySnapshot(method: string, params: unknown): boolean {
  if (method === 'permission.request' || method === 'permission.resolved' || method === 'chat.sessions.changed' || method === 'chat.inputs.changed') return true;
  if (method === 'chat.event') return params !== null && typeof params === 'object' && (params as { event?: unknown }).event !== undefined;
  return false;
}

export type SnapshotReason = 'no-cursor' | 'epoch-changed' | 'ahead' | 'window-expired' | 'replay-too-large';
export interface AttachParams { resume?: StreamCursor; sessionId?: string; protocol?: number }
export interface AttachHead {
  protocol: typeof STATE_PROTOCOL; epoch: number; instanceId: string; lastSeq: number; revision: number;
  window: { firstSeq: number; maxEvents: number; maxChars: number };
}
export type AttachResult =
  /** events 是 (resume.lastSeq, lastSeq] 的全部帧，seq 连续升序。runs / pendingPermissions 是 lastSeq 时刻的权威值。 */
  | (AttachHead & { mode: 'resume'; events: EventFrame[]; runs: RunView[]; pendingPermissions: PendingPermissionView[]; inputs?: InputView[] })
  | (AttachHead & { mode: 'snapshot'; reason: SnapshotReason; snapshot: StateSnapshot });

/** 应答的形状校验（客户端在采用之前做）：协议版本、模式、几个数字字段、模式各自的载荷。 */
export function isAttachResult(x: unknown): x is AttachResult {
  if (x === null || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  const int = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (r.protocol !== STATE_PROTOCOL || !int(r.epoch) || !int(r.lastSeq) || typeof r.instanceId !== 'string') return false;
  if (r.mode === 'resume') return Array.isArray(r.events) && Array.isArray(r.runs) && Array.isArray(r.pendingPermissions);
  if (r.mode === 'snapshot') {
    const s = r.snapshot as Record<string, unknown> | null | undefined;
    return s !== null && typeof s === 'object' && int(s.lastSeq) && Array.isArray(s.sessions) && Array.isArray(s.runs)
      && Array.isArray(s.live) && Array.isArray(s.pendingPermissions);
  }
  return false;
}

/** 写调用的结果查询（state.outcomes）。后续任务在联合末尾追加一种 kind（F07：{ kind: 'input', … }）。 */
export type WriteRef =
  | { kind: 'prompt'; sessionId: string; promptId: string }
  | { kind: 'permission'; requestId: string }
  | { kind: 'input'; sessionId: string; messageId: string };
export type WriteOutcome =
  | { kind: 'prompt'; sessionId: string; promptId: string; status: 'accepted'; run: RunView }
  /** 截至此刻引擎没有接收过这次提交：没送达，或起跑前失败（error 是那次失败的原因）。同一个 promptId 可以再提交。 */
  | { kind: 'prompt'; sessionId: string; promptId: string; status: 'not-accepted'; error?: string }
  | { kind: 'permission'; requestId: string; status: 'pending'; sessionId: string }
  /** 本引擎进程了结的卡。 */
  | { kind: 'permission'; requestId: string; status: 'settled'; source: 'broker'; settled: PermissionSettledInfo }
  /** 执行账本里的审批记录（可以是前一代引擎的；只有工具发起的卡才有）。 */
  | { kind: 'permission'; requestId: string; status: 'settled'; source: 'ledger'; sessionId: string; toolUseId: string; epoch: number;
      approval: { state: 'allowed' | 'denied' | 'expired'; reason?: string; cause?: string }; execution: ToolExecState }
  | { kind: 'permission'; requestId: string; status: 'unknown' }
  | { kind: 'input'; sessionId: string; messageId: string; status: 'accepted'; input: InputView }
  | { kind: 'input'; sessionId: string; messageId: string; status: 'not-accepted'; error?: string };
export interface OutcomesResult { epoch: number; instanceId: string; outcomes: WriteOutcome[] }
/** 一次 state.outcomes 最多查这么多条。 */
export const OUTCOME_REFS_MAX = 64;

/** 同步期间最多扣这么多帧；超过就清空缓冲、改取快照（内存有界）。 */
export const STREAM_HELD_MAX = 20_000;

/** 一帧是不是 run 的终止事件（带 event 字段的 chat.event，kind 为 turnEnd / error）。 */
export function isRunEndFrame(f: Pick<EventFrame, 'method' | 'params'>): boolean {
  if (f.method !== 'chat.event' || f.params === null || typeof f.params !== 'object') return false;
  const kind = (f.params as { event?: { kind?: unknown } }).event?.kind;
  return kind === 'turnEnd' || kind === 'error';
}

export interface OfferResult { deliver: EventFrame[]; need?: 'resume' | 'snapshot' }
export interface SettleResult {
  accepted: boolean; snapshot?: StateSnapshot; replay: EventFrame[]; uncovered: EventFrame[]; after: EventFrame[];
  /** 只在快照时可能非空：缓冲里水位之前的 run 终止事件，升序、每个 seq 一条。见 settle 的说明。 */
  ended: EventFrame[];
  missed: boolean; need?: 'resume' | 'snapshot';
}

/**
 * 客户端一侧的游标、缓冲与去重。无 I/O。渲染端 RpcClient 与测试里的原始客户端用同一个类。
 *
 * 用法：发 state.attach 之前 begin()（此后到达的入序帧只进缓冲）→ 应答到了 settle() → 按返回值交付；
 * 平时每收到一条入序帧 offer()。乱序不另设重排：提前到的那条表现为空洞，走续传；晚到的那条表现为重复。
 */
export class StreamTracker {
  phase: 'off' | 'syncing' | 'live' = 'off';
  cursor: StreamCursor | undefined;
  readonly stats = { applied: 0, duplicates: 0, foreign: 0, gaps: 0, snapshots: 0, resumes: 0 };
  /** 同步期间扣下的帧，按到达顺序。 */
  private held: EventFrame[] = [];
  /** 下一轮必须取快照（缓冲溢出、续传应答对不上、见到别的代次的帧）。 */
  private mustSnapshot = false;
  /** 这一轮同步开始时的游标（判断「水位之前有没有帧没到过」用）。 */
  private base: StreamCursor | undefined;

  /** 发 state.attach 之前调，此后到达的入序帧只进缓冲。返回要带的游标；undefined = 取快照。 */
  begin(o: { newConnection: boolean; forceSnapshot?: boolean }): StreamCursor | undefined {
    this.phase = 'syncing';
    // 新连接：旧套接字上扣下的帧与新连接的应答没有先后关系，不能拿来接续。
    // 也不留基线：断线期间的帧本来就没到过这条连接，「水位之前有没有帧没凑齐」对它没有意义（上层在重连后整体刷新）
    if (o.newConnection) this.held = [];
    this.base = !o.newConnection && this.cursor ? { ...this.cursor } : undefined;
    return o.forceSnapshot || !this.cursor || this.mustSnapshot ? undefined : { ...this.cursor };
  }

  offer(f: EventFrame): OfferResult {
    if (this.phase === 'off') return { deliver: [f] };
    if (this.phase === 'syncing' || !this.cursor) {
      this.held.push(f);
      if (this.held.length > STREAM_HELD_MAX) { this.held = []; this.mustSnapshot = true; }
      return { deliver: [] };
    }
    const v = judgeFrame(this.cursor, f.ev);
    if (v === 'apply') {
      this.cursor.lastSeq = f.ev.seq;
      this.stats.applied += 1;
      return { deliver: [f] };
    }
    if (v === 'duplicate') { this.stats.duplicates += 1; return { deliver: [] }; }
    this.phase = 'syncing';
    if (v === 'gap') {
      // 中间缺了帧：这一帧先扣着，续传补齐之后它就是重复帧，或者正好接在后面
      this.stats.gaps += 1;
      this.held = [f];
      return { deliver: [], need: 'resume' };
    }
    // 别的代次的帧：丢掉。游标已经不可信，下一轮取快照
    this.stats.foreign += 1;
    this.held = [];
    this.mustSnapshot = true;
    return { deliver: [], need: 'snapshot' };
  }

  /**
   * accepted：这份应答被采用（false = 续传应答对不上，什么都不交付，need 是 'snapshot'）。
   * replay：回放里该交给上层的帧；after：缓冲里 seq > lastSeq 的帧。
   * uncovered（只在快照时非空）：缓冲里水位之前、快照没覆盖的帧（coveredBySnapshot 为假），升序、每个 seq 一条。
   * missed（只在快照时可能为真）：原来有同一代次的游标，而 (原游标, lastSeq] 的帧没有在缓冲里凑齐——
   * 其中快照没覆盖的那些无从补发，上层要整体刷新。
   * ended（只在快照、且原来有同一代次的游标时可能非空）：缓冲里 (原游标, lastSeq] 的 run 终止事件（turnEnd / error）。
   * run 的结局快照里有（所以它算「已覆盖」、不进 uncovered），但终止事件自带的东西快照里没有——错误的分类码与接力草稿、
   * 截断说明；这条连接明明收到了这一帧，当成已覆盖丢掉的话，上层只能凭账本里的一行去交代，重试 / 接力入口就没了。
   * 上层在装快照**之前**把它们交给处理器（那时上层的状态还是水位之前的，终止事件照原路处理）；随后的快照里那次 run 已是终态。
   * 新连接（缓冲清过）、换了代次、没有游标（首次同步：上层还没有在跟踪的 run）时恒为空。
   * 上层顺序：快照 → 发 ended、装快照、发 uncovered、发 after；续传 → 发 replay、用应答校正、发 after。
   */
  settle(r: AttachResult): SettleResult {
    const out: SettleResult = { accepted: false, replay: [], uncovered: [], after: [], ended: [], missed: false };
    if (r.mode === 'snapshot') {
      const lastSeq = r.snapshot.lastSeq;
      const base = this.base;
      const sameGen = base !== undefined && base.epoch === r.epoch && base.instanceId === r.instanceId;
      // 水位之前的帧：同一代次、seq <= lastSeq，每个 seq 一条；同代次时去掉基线之前的（那些已经应用过，只可能是重复帧）
      const seen = new Set<number>();
      const before: EventFrame[] = [];
      for (const f of this.held) {
        if (f.ev.epoch !== r.epoch || f.ev.seq > lastSeq || seen.has(f.ev.seq)) continue;
        if (sameGen && f.ev.seq <= base.lastSeq) continue;
        seen.add(f.ev.seq);
        before.push(f);
      }
      before.sort((a, b) => a.ev.seq - b.ev.seq);
      out.uncovered = before.filter(f => !coveredBySnapshot(f.method, f.params));
      out.ended = sameGen ? before.filter(isRunEndFrame) : [];
      out.missed = sameGen && before.length < lastSeq - base.lastSeq;
      out.accepted = true;
      out.snapshot = r.snapshot;
      this.cursor = { epoch: r.epoch, instanceId: r.instanceId, lastSeq };
      this.mustSnapshot = false;
      this.stats.snapshots += 1;
    } else {
      const c = this.cursor;
      if (!c || r.epoch !== c.epoch || r.instanceId !== c.instanceId) { this.mustSnapshot = true; out.need = 'snapshot'; return out; }
      // 先在副本上走一遍：出现空洞、别的代次的帧、或走完对不上应答的水位，就整份不采用（游标不动）
      const probe = { epoch: c.epoch, lastSeq: c.lastSeq };
      const replay: EventFrame[] = [];
      let skipped = 0;
      for (const f of r.events) {
        const v = isEventStamp(f?.ev) ? judgeFrame(probe, f.ev) : 'foreign';
        if (v === 'apply') { probe.lastSeq = f.ev.seq; replay.push(f); }
        else if (v === 'duplicate') skipped += 1;
        else { this.mustSnapshot = true; out.need = 'snapshot'; return out; }
      }
      if (probe.lastSeq !== r.lastSeq) { this.mustSnapshot = true; out.need = 'snapshot'; return out; }
      out.accepted = true;
      out.replay = replay;
      c.lastSeq = probe.lastSeq;
      this.stats.applied += replay.length;
      this.stats.duplicates += skipped;
      this.stats.resumes += 1;
    }
    // 排空缓冲：升序；别的代次的丢；水位之前的丢（快照时其中没覆盖的已进 uncovered；续传时它们已在回放里，是重复帧）；
    // 正好接在后面的交付并推进；遇到空洞 → 剩余的留在缓冲，再续传一轮
    const cur = this.cursor!;
    const rest = [...this.held].sort((a, b) => a.ev.seq - b.ev.seq);
    this.held = [];
    for (let i = 0; i < rest.length; i++) {
      const f = rest[i];
      const v = judgeFrame(cur, f.ev);
      if (v === 'foreign') { this.stats.foreign += 1; continue; }
      if (v === 'duplicate') { if (r.mode === 'resume') this.stats.duplicates += 1; continue; }
      if (v === 'apply') { cur.lastSeq = f.ev.seq; this.stats.applied += 1; out.after.push(f); continue; }
      this.stats.gaps += 1;
      this.held = rest.slice(i).filter(x => x.ev.epoch === cur.epoch);
      out.need = 'resume';
      break;
    }
    if (out.need === undefined) this.phase = 'live';
    return out;
  }

  /** 关掉（旧引擎、首次同步失败）：返回缓冲里的帧（到达顺序），上层原样分发。 */
  off(): EventFrame[] {
    const frames = this.held;
    this.held = [];
    this.phase = 'off';
    this.mustSnapshot = false;
    return frames;
  }

  /** 一轮同步失败而连接还在（join 的应答没取到）：回到放行状态，缓冲里的帧按游标逐条判定——接得上的交付，
   *  有空洞就留在缓冲里并要求续传。有游标才回得去；没有游标（从没同步成过）时由调用方 off()。 */
  reopen(): OfferResult {
    if (!this.cursor) return { deliver: [] };
    const cur = this.cursor;
    const rest = [...this.held].sort((a, b) => a.ev.seq - b.ev.seq);
    this.held = [];
    this.phase = 'live';
    const deliver: EventFrame[] = [];
    for (let i = 0; i < rest.length; i++) {
      const r = this.offer(rest[i]);
      deliver.push(...r.deliver);
      if (r.need) {
        // offer 已把状态置回 syncing；它之后的帧一并留在缓冲里
        if (r.need === 'resume') this.held.push(...rest.slice(i + 1).filter(x => x.ev.epoch === cur.epoch));
        return { deliver, need: r.need };
      }
    }
    return { deliver };
  }
}
