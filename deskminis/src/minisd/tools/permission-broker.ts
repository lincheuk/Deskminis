/**
 * F13：权限卡的登记与了结——一张卡只了结一次，第一终态获胜。
 *
 * 以前了结逻辑在 index.ts 里写了三份（超时定时器、permission.respond、denyPendingPerms），顺序各不相同，
 * 两处审计没兜住；晚到的答复悄悄没生效，也可能在卡片已经没人等的时候照样发桥授权。
 * 现在全部收进 settle()：答复、超时、取消、失效四条路谁先到谁赢，之后的任何答复 / 定时器 / abort 都不改变任何东西。
 *
 * 不变量：
 *  - 一个 requestId 至多了结一次，了结后不可复活；只有调用 ask 的那一方拿得到这次了结的结果。
 *  - 桥合并授权（onApproved）只在「这张卡以允许了结」这一处产生，且在唤醒询问方之前。
 *  - 广播与审计都在唤醒询问方之后、各自兜住：它们失败不改变了结结果，引擎不因此退出。
 *  - 待批的卡只接受两类连接的答复（配置了 connSeq 时）：发卡时已经连着的；或引擎经 deliver() 把这张卡的完整内容
 *    交给过的（F06：重载、重连后的新连接先 state.attach 取回卡片，才获得答复资格）。应答方没有连接序号按不可答复处理。
 *    凭旧 requestId、没取回过卡片的新连接照旧答不了；这条只会让答复不生效，不会让任何答复多生效。
 */
import { randomUUID } from 'node:crypto';
import type { BridgePermissionKind, PermissionRequest } from './types';
import { PromptAbort, type PermissionPrompt, type PromptAnswer, type PromptControl } from './permissions';
import {
  allowed, denied, USER_DECISIONS,
  type PermissionDenyCause, type PermissionOutcome, type PermissionResolvedReason, type PermissionRespondResult,
  type PermissionSettledInfo, type UserDecision,
} from '../../shared/permission';
import type { PendingPermissionView } from '../../shared/event-stream';

/** 待批请求的只读视图（F06 的快照里要补发的就是它）。 */
export interface PendingView { requestId: string; req: PermissionRequest; toolUseId?: string; origin: 'tool' | 'bridge'; askedAt: number; bridgeTriggers: BridgePermissionKind[] }

/** 系统代为了结的两类原因。F07 的插话作废卡片时给 cancelled 加一个 cause。 */
export type SystemSettle =
  | { reason: 'cancelled'; cause: 'user-stop' | 'session-deleted' | 'shutdown' | 'requester-gone' }
  | { reason: 'invalidated'; cause: 'mcp-disabled' | 'mcp-session-disabled' | 'mcp-config-changed' | 'mcp-removed' | 'mcp-config-unreadable' };

/** seq：答复所在连接的序号（RpcConnection.seq）。 */
export interface Responder { via: 'local' | 'remote'; peerFingerprint?: string; seq?: number }

/** RPC 连接 → 应答方。conn 缺省（进程内调用）按 local、没有 seq。 */
export function responderOf(conn: { authMode?: string; peerFingerprint?: string; seq?: number } | undefined): Responder {
  const r: Responder = { via: conn?.authMode === 'remote' ? 'remote' : 'local' };
  if (conn?.peerFingerprint !== undefined) r.peerFingerprint = conn.peerFingerprint;
  if (typeof conn?.seq === 'number') r.seq = conn.seq;
  return r;
}

export interface BrokerDeps {
  timeoutMs: number;
  /** 当前已分配的最大连接序号。给了它，一张卡就只接受「发卡时已经连着的连接」的答复；
   *  缺省 = 不做这项检查（不经 RpcServer 的宿主、单测）。 */
  connSeq?: () => number;
  /** 有人对这个会话的一张已了结的卡做了答复（没生效，但说明用户在场）。抛错被兜住。 */
  onUserSeen?(sessionId: string): void;
  broadcast(method: 'permission.request' | 'permission.resolved', params: unknown): void;
  /** 可能抛（库写失败）。broker 每次调用都兜住。 */
  audit(eventType: string, payload: unknown, opts: { sessionId?: string; peerFingerprint?: string }): void;
  /** 卡片 meta 里宿主算的部分：shell 的风险分级与桥触发探测。 */
  describe?(req: PermissionRequest): { riskClass?: string; bridgeTriggers?: BridgePermissionKind[] };
  /** 这张卡以「允许」了结时调用一次，在唤醒询问方之前（桥合并授权、stable 缓存失效）。 */
  onApproved?(entry: PendingView, decision: 'allow-once' | 'allow-session'): void;
  /** 缺省 randomUUID().toUpperCase()。 */
  newId?: () => string;
  now?: () => number;
  warn?: (msg: string, e?: unknown) => void;
  /** 最近已了结的卡记多少张（晚到答复据此回 settled、写 late-response）。缺省 256。 */
  recentLimit?: number;
}

type Terminal =
  | { kind: 'allow'; decision: 'allow-once' | 'allow-session' }
  | { kind: 'deny'; reason: 'user-denied' | 'timeout' | 'cancelled' | 'invalidated'; cause?: PermissionDenyCause };

interface Entry {
  view: PendingView;
  /** 发卡这一刻已分配的最大连接序号；undefined = 不做连接检查。 */
  connSeqAtIssue: number | undefined;
  resolve: (a: PromptAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
  /** 「发卡之后才建立的连接答复了这张卡」已经记过审计（同一张卡至多一条）。 */
  staleLogged: boolean;
  /** F06：当初随 permission.request 广播出去的 meta，原样留着（补发给新连接的就是它）。 */
  meta: PendingPermissionView['meta'];
  /** F06：发卡之后才建立、又经 deliver() 拿到过这张卡的连接序号。卡了结时条目从表里删除，登记随之消失。 */
  delivered: Set<number>;
}

interface Recent { settled: PermissionSettledInfo; sessionId: string; lateLogged: boolean }

/** 线上 permission.resolved 的 reason（旧字段，取值只增不改）。 */
function wireReasonOf(t: Terminal): PermissionResolvedReason {
  if (t.kind === 'allow' || t.reason === 'user-denied') return 'answered';
  if (t.reason === 'timeout') return 'timeout';
  if (t.reason === 'invalidated') return 'invalidated';
  return t.cause === 'session-deleted' ? 'session-deleted' : t.cause === 'shutdown' ? 'shutdown' : 'cancelled';
}

/** 网关放弃询问时给的 abort reason → 终态。不是 PromptAbort 的值按「询问方取消」处理。 */
function fromAbort(reason: unknown): Extract<Terminal, { kind: 'deny' }> {
  if (reason instanceof PromptAbort) {
    return reason.reason === 'timeout'
      ? { kind: 'deny', reason: 'timeout', cause: 'unanswered' }
      : { kind: 'deny', reason: 'cancelled', cause: reason.cause ?? 'user-stop' };
  }
  return { kind: 'deny', reason: 'cancelled', cause: 'user-stop' };
}

export class PermissionBroker {
  private readonly entries = new Map<string, Entry>();
  /** 最近已了结的卡，按了结先后（Map 保持插入序，超过上限删最早的）。 */
  private readonly recent = new Map<string, Recent>();
  private readonly now: () => number;
  private readonly warn: (msg: string, e?: unknown) => void;
  private readonly recentLimit: number;

  constructor(private readonly deps: BrokerDeps) {
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? ((msg, e) => { console.warn(msg, e); });
    this.recentLimit = Math.max(1, deps.recentLimit ?? 256);
  }

  /** 交给 PermissionGatewayImpl 的询问函数。箭头属性，可直接传引用。同步登记卡片，返回只兑现一次的 Promise。 */
  readonly ask: PermissionPrompt = (req: PermissionRequest, ctl: PromptControl): Promise<PromptAnswer> => {
    // 询问方进门前就不要了：不建卡
    if (ctl.signal.aborted) {
      const t = fromAbort(ctl.signal.reason);
      return Promise.resolve({ answer: 'deny', reason: t.reason, cause: t.cause });
    }
    const requestId = (this.deps.newId ?? (() => randomUUID().toUpperCase()))();
    let d: { riskClass?: string; bridgeTriggers?: BridgePermissionKind[] } = {};
    try { d = this.deps.describe?.(req) ?? {}; } catch (e) { this.warn(`权限卡 ${requestId} 的风险描述计算失败（卡片照常询问）:`, e); }
    const bridgeTriggers = d.bridgeTriggers ?? [];
    // 广播附 meta（决策 4b）：超时毫秒数 / 风险分级 / 桥触发探测（非空才带）/ 这张卡属于哪个工具调用
    const meta: { timeoutMs: number; riskClass?: string; bridgeTriggers?: BridgePermissionKind[]; toolUseId?: string } = { timeoutMs: this.deps.timeoutMs };
    if (d.riskClass) meta.riskClass = d.riskClass;
    if (bridgeTriggers.length > 0) meta.bridgeTriggers = bridgeTriggers;
    if (ctl.toolUseId) meta.toolUseId = ctl.toolUseId;

    let resolve!: (a: PromptAnswer) => void;
    const answer = new Promise<PromptAnswer>(r => { resolve = r; });
    const view: PendingView = { requestId, req, origin: ctl.origin, askedAt: this.now(), bridgeTriggers };
    if (ctl.toolUseId) view.toolUseId = ctl.toolUseId;
    const entry: Entry = {
      view, resolve, signal: ctl.signal, staleLogged: false,
      meta, delivered: new Set<number>(),
      connSeqAtIssue: this.deps.connSeq?.(),
      // 超时不通知 UI 的话，卡片会永远留在界面上、表只增不减：到点主动了结
      timer: setTimeout(() => { this.settle(entry, { kind: 'deny', reason: 'timeout', cause: 'unanswered' }); }, this.deps.timeoutMs),
      // 网关放弃这次询问（它自己的兜底时限到了 / 询问方取消）：当场了结，之后的答复查不到条目
      onAbort: () => { this.settle(entry, fromAbort(ctl.signal.reason)); },
    };
    entry.timer.unref?.();
    ctl.signal.addEventListener('abort', entry.onAbort, { once: true });
    this.entries.set(requestId, entry);
    try { ctl.issued?.(requestId); } catch { /* 观察者的错误不影响询问 */ }

    // 广播带 preview 全文（权限卡渲染差分的唯一数据源）。广播抛错 = 没有任何人能看到这张卡：
    // 撤掉条目（不进 recent、不广播 resolved、不写审计），把错误抛给询问方——失败关闭，不留孤儿卡与孤儿定时器
    try {
      this.deps.broadcast('permission.request', { requestId, req, meta });
    } catch (e) {
      this.entries.delete(requestId);
      clearTimeout(entry.timer);
      ctl.signal.removeEventListener('abort', entry.onAbort);
      throw e;
    }
    // 审计剔除 preview 全文只记 hasPreview 布尔：preview 单条最多 2×20000 字符，写文件类请求频繁时审计库会膨胀成文件内容副本。
    // 写入失败只记一笔警告，卡片照常询问：库写不进去时仍允许用户批准并执行，与「了结审计失败照常了结」同一口径
    const { preview, ...reqNoPreview } = req;
    try {
      this.deps.audit('permission.request', { requestId, req: reqNoPreview, hasPreview: preview !== undefined, meta }, { sessionId: req.sessionId });
    } catch (e) {
      this.warn(`权限卡 ${requestId} 登记时审计写入失败（卡片照常询问）:`, e);
    }
    return answer;
  };

  /** 唯一的了结出口。同步、不抛；返回这次调用是否真的了结了这张卡。 */
  private settle(entry: Entry, t: Terminal, by?: Responder): boolean {
    const { requestId, req, toolUseId } = entry.view;
    // 第一终态获胜的唯一判据：条目还在表里
    if (this.entries.get(requestId) !== entry) return false;
    this.entries.delete(requestId);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener('abort', entry.onAbort);

    const reason = wireReasonOf(t);
    const waitedMs = Math.max(0, this.now() - entry.view.askedAt);
    const outcome: PermissionOutcome = t.kind === 'allow'
      ? allowed(t.decision === 'allow-session' ? 'user-session' : 'user-once', requestId)
      : denied(t.reason, t.cause, { requestId, waitedMs });
    this.recent.set(requestId, { settled: { reason, decision: outcome.decision }, sessionId: req.sessionId, lateLogged: false });
    while (this.recent.size > this.recentLimit) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }

    // 桥合并授权放在唤醒之前：工具醒来时授权已就位
    if (t.kind === 'allow') {
      try { this.deps.onApproved?.({ ...entry.view }, t.decision); }
      catch (e) { this.warn(`权限卡 ${requestId} 批准后的授权处理失败（卡片照常按允许了结）:`, e); }
    }
    entry.resolve(t.kind === 'allow'
      ? { answer: t.decision, requestId }
      : { answer: 'deny', reason: t.reason, cause: t.cause, requestId, waitedMs });

    // 同一个请求可能在多个窗口里显示：告诉所有客户端这张卡片已了结。询问方已经拿到结果，广播失败只影响界面摘卡
    try { this.deps.broadcast('permission.resolved', { requestId, reason, outcome }); }
    catch (e) { this.warn(`权限卡 ${requestId}（${reason}）了结时广播失败（卡片照常了结）:`, e); }
    // 审计写入兜住（W2b-7）：库写失败（SQLITE_FULL / SQLITE_BUSY）时这一抛可能发生在定时器里——就是一次未捕获异常，
    // standalone 下引擎当场退出。失败只记一笔警告（stderr 经主进程落进按天日志），丢的只是这条审计
    const answered = t.kind === 'allow' || t.reason === 'user-denied';
    try {
      this.deps.audit('permission.resolved', {
        requestId, reason, outcome,
        ...(answered ? { decision: t.kind === 'allow' ? t.decision : 'deny', by: by?.via ?? 'local' } : {}),
        ...(toolUseId ? { toolUseId } : {}),
      }, { sessionId: req.sessionId, ...(answered && by?.via === 'remote' && by.peerFingerprint ? { peerFingerprint: by.peerFingerprint } : {}) });
    } catch (e) {
      this.warn(`权限卡 ${requestId}（${reason}）了结时审计写入失败（卡片照常了结）:`, e);
    }
    return true;
  }

  /**
   * 用户（本机窗口或已配对设备）对一张卡的答复。decision 不是三种合法值 → 抛错，卡不动：
   * 不认识的值不是「用户点了拒绝」。答复没有生效时如实告诉客户端（applied:false）。
   */
  respond(requestId: string, decision: unknown, by?: Responder): PermissionRespondResult {
    if (typeof decision !== 'string' || !(USER_DECISIONS as readonly string[]).includes(decision)) {
      throw new Error(`非法权限决定: ${typeof decision === 'string' ? decision : typeof decision}`);
    }
    const d = decision as UserDecision;
    const entry = this.entries.get(requestId);
    if (!entry) {
      const rec = this.recent.get(requestId);
      // 本引擎进程不认识这个 id（重启前的卡、已滚出最近记录、胡编的 id）：不写审计——任意 id 不能刷审计表
      if (!rec) return { ok: true, applied: false };
      // 有人答了这个会话的卡：没生效，但说明用户在场
      try { this.deps.onUserSeen?.(rec.sessionId); } catch (e) { this.warn(`权限卡 ${requestId} 的晚到答复通知失败:`, e); }
      // 同一张卡的晚到答复只记第一条：循环重发的客户端、重放旧 id 的设备最多给每张卡多留一行
      if (!rec.lateLogged) {
        rec.lateLogged = true;
        this.auditLate(requestId, { requestId, decision: d, by: by?.via ?? 'local', cause: 'settled', settled: rec.settled }, rec.sessionId, by);
      }
      return { ok: true, applied: false, settled: { ...rec.settled } };
    }
    // 断线后旧批准：这张卡只接受发卡时已经连着的连接的答复。序号不大于 connSeqAtIssue 而又能发来答复的，
    // 一定是发卡时就在、此刻仍在的连接，它当时收到了广播。应答方没有序号按不可答复处理（失败关闭）。
    // F06：发卡之后才建立的连接，经 deliver() 拿到过这张卡的完整内容之后同样可以答复（重载、重连后的窗口）；
    // 没取回过卡片、只凭旧 requestId 来答的新连接仍然落进下面的 undelivered 分支
    const eligible = by?.seq !== undefined && (by.seq <= (entry.connSeqAtIssue ?? -1) || entry.delivered.has(by.seq));
    if (entry.connSeqAtIssue !== undefined && !eligible) {
      if (!entry.staleLogged) {
        entry.staleLogged = true;
        this.auditLate(requestId, { requestId, decision: d, by: by?.via ?? 'local', cause: 'stale-connection' }, entry.view.req.sessionId, by);
      }
      return { ok: true, applied: false, undelivered: true };
    }
    this.settle(entry, d === 'deny' ? { kind: 'deny', reason: 'user-denied' } : { kind: 'allow', decision: d }, by);
    return { ok: true, applied: true };
  }

  private auditLate(requestId: string, payload: unknown, sessionId: string, by?: Responder): void {
    try {
      this.deps.audit('permission.late-response', payload, { sessionId, ...(by?.via === 'remote' && by.peerFingerprint ? { peerFingerprint: by.peerFingerprint } : {}) });
    } catch (e) {
      this.warn(`权限卡 ${requestId} 的晚到答复审计写入失败（答复照常不生效）:`, e);
    }
  }

  /** 系统代为了结（取消 / 删除会话 / 关停 / 配置失效），返回了结了几张。从不抛：单张失败不挡后面的卡。 */
  settleWhere(match: (e: PendingView) => boolean, how: SystemSettle): number {
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      try {
        if (match({ ...entry.view }) && this.settle(entry, { kind: 'deny', reason: how.reason, cause: how.cause })) n++;
      } catch (e) {
        this.warn(`了结权限卡 ${entry.view.requestId}（${how.reason}）时出错，接着了结其余的卡:`, e);
      }
    }
    return n;
  }

  /** 待批请求的只读副本，按到达序。 */
  pending(): PendingView[] {
    return [...this.entries.values()].map(e => ({ ...e.view }));
  }

  /**
   * F06：把此刻全部待批的卡交给一条连接，并登记这条连接可以答复它们（state.attach 在快照与续传两种应答里都调）。
   * 返回的每一张与当初的 permission.request 广播同形（requestId / req / meta），另带来源、发卡时刻与剩余时限；
   * 补发不延长时限。
   *
   * 登记只对「发卡之后才建立的连接」做：发卡时已连着的本来就可以答复，不登记、不写审计（探测与重复快照不刷审计表）。
   * 同一张卡对同一条连接只登记一次，登记时写一条 permission.redelivered（不广播；写失败只告警，登记照做）。
   * to 缺省或没有 seq（进程内调用）时只返回、不登记——没有序号的应答方本来就按不可答复处理。
   * 不变量：登记给一条连接的每一张卡，其完整内容都在这次调用的返回值里。同步、不抛、不了结任何卡。
   */
  deliver(to?: Responder): PendingPermissionView[] {
    const now = this.now();
    const out: PendingPermissionView[] = [];
    for (const entry of this.entries.values()) {
      const { requestId, req, origin, askedAt } = entry.view;
      const view: PendingPermissionView = {
        requestId, req: { ...req }, meta: { ...entry.meta, ...(entry.meta.bridgeTriggers ? { bridgeTriggers: [...entry.meta.bridgeTriggers] } : {}) },
        origin, askedAt, remainingMs: Math.max(0, entry.meta.timeoutMs - (now - askedAt)),
      };
      out.push(view);
      const seq = to?.seq;
      if (typeof seq !== 'number' || entry.connSeqAtIssue === undefined || seq <= entry.connSeqAtIssue || entry.delivered.has(seq)) continue;
      entry.delivered.add(seq);
      try {
        this.deps.audit('permission.redelivered', { requestId, by: to?.via ?? 'local', connSeq: seq },
          { sessionId: req.sessionId, ...(to?.via === 'remote' && to.peerFingerprint ? { peerFingerprint: to.peerFingerprint } : {}) });
      } catch (e) {
        this.warn(`权限卡 ${requestId} 补发时审计写入失败（卡片照常交付）:`, e);
      }
    }
    return out;
  }

  /** F06：一张卡在本引擎进程里的现状（state.outcomes 用）；不认识返回 undefined。只读、不写审计——任意 id 不能刷审计表。 */
  statusOf(requestId: string): { status: 'pending'; sessionId: string } | { status: 'settled'; settled: PermissionSettledInfo } | undefined {
    const entry = this.entries.get(requestId);
    if (entry) return { status: 'pending', sessionId: entry.view.req.sessionId };
    const rec = this.recent.get(requestId);
    return rec ? { status: 'settled', settled: { ...rec.settled } } : undefined;
  }
}
