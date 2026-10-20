/**
 * F06：state.attach（原子快照 / 续传）与 state.outcomes（写调用的结果查询）的处理器。
 *
 * state.attach 是一段同步代码，函数体里没有 await：RPC 处理器由 ws 的 message 回调（宏任务）进入，
 * 所以读 lastSeq 与读各项状态之间不可能插进任何一次广播、任何账本事务、任何权限卡的登记或了结。
 * 引擎里「状态先提交、事件后发布」且两者之间没有等待 I/O 的 await，于是这一刻看到的库、账本、broker、尾巴
 * 恰好包含 seq <= lastSeq 的全部事件的效果，seq > lastSeq 的一条都还没发生——这就是快照与增量之间的无缝边界。
 * 应答里的对象都是这次调用新建的，序列化之前不会被后来的事件改写。
 *
 * 给后续任务的约束：往这里加字段时取值必须留在这段同步代码里；提交与对应事件的发布之间不得出现等待 I/O 的 await。
 *
 * state.outcomes 只读：断线时在途、没等到应答的写调用，客户端不重发，先来这里问真实结果。
 * prompt 的持久去重是 F05 的（promptId），批准的一次性是 F13 的（第一终态获胜）；这里不新增任何去重逻辑。
 */
import type { RpcConnection } from './rpc/server';
import { RESUME_MAX_CHARS, type EventLog } from './rpc/event-log';
import type { RunLedger } from './store/run-ledger';
import type { ChatStore } from './store/chat-store';
import { responderOf, type PermissionBroker } from './tools/permission-broker';
import type { LiveTails } from './agent/live-tails';
import { PROMPT_ID_RE } from '../shared/run';
import {INPUT_ID_RE} from '../shared/inputs';
import type {InputQueueStore} from './store/input-queue';
import {
  eventSessionId, OUTCOME_REFS_MAX, STATE_PROTOCOL,
  type AttachHead, type AttachParams, type AttachResult, type EventFrame, type OutcomesResult, type SnapshotArtifact,
  type SnapshotReason, type StateSnapshot, type StreamCursor, type WriteOutcome,
} from '../shared/event-stream';

export interface AttachDeps {
  log: Pick<EventLog, 'epoch' | 'lastSeq' | 'firstSeq' | 'since' | 'limits'>;
  instanceId: string;
  ledger: Pick<RunLedger, 'snapshot' | 'listExecutions'>;
  chat: Pick<ChatStore, 'listSessions' | 'getSession' | 'listMessages'>;
  /** F11B：这个会话是否已删除——已清除的，或「对端删了、本机留着副本」的保留副本。已删除的会话不显示：
   *  listSessions / getSession 本来就不含它们；保留副本的账本行还在库里（显式恢复之后要用），所以按会话归属的
   *  runs / executions / artifacts / live 在这里另滤一遍。index.ts 接 chat.isDeleted——与 chat.prompt 的入口闸、
   *  chat.runs.snapshot 的过滤同一个判据。不给（部件级用例）按「没有已删除的会话」处理。 */
  isSessionDeleted?: (sessionId: string) => boolean;
  broker: Pick<PermissionBroker, 'deliver'>;
  tails: Pick<LiveTails, 'list' | 'retain'>;
  /** 持久状态修订号：SELECT total_changes()（本连接打开以来的行变更总数，单调不减）。 */
  revision: () => number;
  now?: () => number;
  inputs?: Pick<InputQueueStore, 'list'>;
}

/** 游标的形状校验：三个字段类型都对，lastSeq 是非负安全整数。不对的按「没带游标」处理。 */
function validCursor(c: unknown): c is StreamCursor {
  if (c === null || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return typeof o.epoch === 'number' && typeof o.instanceId === 'string'
    && typeof o.lastSeq === 'number' && Number.isSafeInteger(o.lastSeq) && o.lastSeq >= 0;
}

/**
 * 返回的处理器是同步函数，函数体里不得有 await（tests/state-sync-wiring 的守卫）。
 *
 * 判定（按序）：没带游标或游标形状不对 → 快照 / no-cursor；代次或实例变了 → 快照 / epoch-changed；
 * 游标比 lastSeq 还大 → 快照 / ahead；窗口盖不住 → 快照 / window-expired；回放太大 → 快照 / replay-too-large；
 * 否则续传，events 是 (游标, lastSeq] 的全部帧。
 * 两种应答都带此刻全部待批的卡，并把调用连接登记为可答复（broker.deliver）：
 * 断线前就发出、仍待批的卡不在回放里，只在续传路径上漏登记的话，重连后那张卡点了没用。
 * 任何一步抛错 → RPC 报错，不做部分快照。那时答复资格可能已经登记：登记本身无害（这条连接已通过认证，卡片内容它随时可以再取）。
 */
export function createAttachHandler(deps: AttachDeps): (p: AttachParams | undefined, conn?: RpcConnection) => AttachResult {
  const { log, instanceId } = deps;
  const now = deps.now ?? Date.now;
  return (p, conn) => {
    const lastSeq = log.lastSeq;
    const sessionId = typeof p?.sessionId === 'string' ? p.sessionId : undefined;
    let reason: SnapshotReason | undefined;
    let events: EventFrame[] = [];
    const cursor: unknown = p?.resume;
    if (!validCursor(cursor)) reason = 'no-cursor';
    else if (cursor.epoch !== log.epoch || cursor.instanceId !== instanceId) reason = 'epoch-changed';
    else if (cursor.lastSeq > lastSeq) reason = 'ahead';
    else {
      const got = log.since(cursor.lastSeq, RESUME_MAX_CHARS);
      if (got === 'expired') reason = 'window-expired';
      else if (got === 'too-large') reason = 'replay-too-large';
      else events = got;
    }
    const raw = deps.ledger.snapshot(sessionId !== undefined ? { sessionId } : {});
    // F11B：已删除的会话不显示。带着保留副本的 sessionId 来时，账本会给出它最近一次 run 与那一批执行记录
    //（行还在库里）——滤掉，续传与快照两种应答都不带；残留的活动行同样滤掉。每个会话只查一次登记
    const deleted = new Map<string, boolean>();
    const shown = (r: { sessionId: string }): boolean => {
      let d = deleted.get(r.sessionId);
      if (d === undefined) { d = deps.isSessionDeleted?.(r.sessionId) === true; deleted.set(r.sessionId, d); }
      return !d;
    };
    const ls = { runs: raw.runs.filter(shown), executions: raw.executions.filter(shown) };
    // Also guard late payloads emitted after the lifecycle hook erased retention.
    // Every original seq remains present; a redacted frame carries no session content.
    events = events.map(f => {
      const sessionId = eventSessionId(f.method, f.params);
      return sessionId !== undefined && !shown({ sessionId })
        ? { method: 'state.redacted', params: {}, ev: f.ev } : f;
    });
    // 待批卡不在这里滤：会话被删除时，它挂着的卡已由 stopRun 了结（本机删除与对端墓碑都先停 run、了结卡片，再落库），
    // 不会留到这里；而登记答复资格与返回值必须是同一批卡（deliver 的不变量），在这里另滤一遍只会让两者对不上
    const cards = deps.broker.deliver(responderOf(conn));
    const inputs = deps.inputs?.list().filter(shown);
    const head: Omit<AttachHead, 'revision'> = {
      protocol: STATE_PROTOCOL, epoch: log.epoch, instanceId, lastSeq,
      window: { firstSeq: log.firstSeq, ...log.limits },
    };
    // revision 取在 deliver 之后：登记可能写了一条审计
    if (reason === undefined) {
      return { ...head, revision: deps.revision(), mode: 'resume', events, runs: ls.runs, pendingPermissions: cards, ...(inputs !== undefined ? {inputs} : {}) };
    }
    // 尾巴只留本代次仍在活动的 run 的：没有终止事件就结束的 run（账本已收尾）不留条目
    // 留哪些条目按账本的原样算（不看会话是否已删除：清条目是对尾巴表的写，这里只按 run 的死活定）；给出去的再按会话滤
    const activeIds = new Set(raw.runs.filter(r => r.epoch === log.epoch && (r.state === 'starting' || r.state === 'running')).map(r => r.runId));
    deps.tails.retain(activeIds);
    const live = deps.tails.list().filter(shown);
    const artifacts: SnapshotArtifact[] = [];
    for (const r of ls.runs) {
      for (const x of deps.ledger.listExecutions(r.runId)) {
        if (x.artifacts.writePaths.length === 0 && x.artifacts.offloadPath === undefined) continue;
        artifacts.push({
          sessionId: x.sessionId, runId: x.runId, toolUseId: x.toolUseId, tool: x.name, state: x.state,
          writePaths: [...x.artifacts.writePaths],
          ...(x.artifacts.offloadPath !== undefined ? { offloadPath: x.artifacts.offloadPath } : {}),
        });
      }
    }
    const sessions = deps.chat.listSessions();
    let session: StateSnapshot['session'];
    if (sessionId !== undefined) {
      const exists = deps.chat.getSession(sessionId) !== undefined;
      session = { sessionId, exists, messages: exists ? deps.chat.listMessages(sessionId) : [] };
    }
    const revision = deps.revision();
    const snapshot: StateSnapshot = {
      epoch: log.epoch, instanceId, revision, lastSeq, takenAt: now(),
      sessions, runs: ls.runs, executions: ls.executions, live, pendingPermissions: cards, artifacts,
      ...(session !== undefined ? { session } : {}),
      ...(inputs !== undefined ? {inputs} : {}),
    };
    return { ...head, revision, mode: 'snapshot', reason, snapshot };
  };
}

/** 与 index.ts 里 chat.prompt 入口闸抛的是同一句。 */
const SESSION_DELETED = '会话已删除';

export interface OutcomesDeps {
  epoch: number; instanceId: string;
  ledger: Pick<RunLedger, 'findByPrompt' | 'findApproval'>;
  broker: Pick<PermissionBroker, 'statusOf'>;
  /** 本进程里还没落 user 消息的 run 的起跑结果（index.ts 的 launches）。 */
  launchOf: (runId: string) => Promise<void> | undefined;
  /** 会话 id 的形状校验（index.ts 的 assertSessionId），不合法就抛。 */
  sessionId: (id: unknown) => string;
  inputs?: Pick<InputQueueStore, 'get'>;
  /** F11B：同 AttachDeps.isSessionDeleted（index.ts 给两个处理器接的是同一个 chat.isDeleted）。 */
  isSessionDeleted?: (sessionId: string) => boolean;
}

/**
 * state.outcomes：逐条回答「这次写调用实际怎么样了」。refs 不是数组、超过 OUTCOME_REFS_MAX 条、某条形状不对 → 抛错。
 *
 * prompt（按 promptId）：
 *  - 账本里没有这个 id → not-accepted（没送达，或起跑前失败时已放掉）；
 *  - 命中的 run 还在 starting：本进程正在起它 → 等起跑结果再答（与 chat.prompt 对重复提交的口径相同：
 *    这时就答 accepted 的话，它随后起跑前失败，客户端却以为消息已被接收）；没在起（陈旧行）→ not-accepted；
 *  - 其余 → accepted，run 是当前的状态（如实，含 interrupted）。
 *  - 会话已删除（F11B；排在最前）→ not-accepted，error 是「会话已删除」——与 chat.prompt 入口闸对同一个 promptId 的答法相同。
 *    已清除的会话账本行已经没了，本来就是 not-accepted；保留副本的账本行还在，不拦的话会答 accepted 并把它的 run 带出去，
 *    而它已不在会话列表里（chat.runs.snapshot 同样不带）。客户端的会话列表里已经没有它，这条结论只用来摘掉在途记录。
 * permission（按 requestId）：本进程的 broker 认识 → pending / settled(broker)；否则查执行账本的审批记录（可以是前一代的）
 *  → settled(ledger)；账本里仍是 pending（没收掉的前代行）或查不到 → unknown。任意 id 不写审计。
 *  账本那一支命中的是已删除会话（保留副本）的执行记录时同样答 unknown：它的执行记录不带出去。broker 那一支不看：
 *  那是这张卡在本进程里怎么了结的（会话被删时就是「已取消 / 会话已删除」），不含执行记录。
 */
export function createOutcomesHandler(deps: OutcomesDeps): (p: { refs?: unknown } | undefined) => Promise<OutcomesResult> {
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  return async (p) => {
    const refs: unknown = p?.refs;
    if (!Array.isArray(refs) || refs.length > OUTCOME_REFS_MAX) throw new Error(`refs 必须是数组，且不超过 ${OUTCOME_REFS_MAX} 条`);
    const outcomes: WriteOutcome[] = [];
    for (const raw of refs as unknown[]) {
      const ref = (raw !== null && typeof raw === 'object' ? raw : {}) as { kind?: unknown; sessionId?: unknown; promptId?: unknown; requestId?: unknown; messageId?: unknown };
      if (ref.kind === 'prompt') {
        const sessionId = deps.sessionId(ref.sessionId);
        if (typeof ref.promptId !== 'string' || !PROMPT_ID_RE.test(ref.promptId)) throw new Error('非法 promptId');
        const promptId = ref.promptId;
        const id = { kind: 'prompt' as const, sessionId, promptId };
        if (deps.isSessionDeleted?.(sessionId)) { outcomes.push({ ...id, status: 'not-accepted', error: SESSION_DELETED }); continue; }
        let hit = deps.ledger.findByPrompt(sessionId, promptId);
        if (hit?.run.state === 'starting') {
          const launch = deps.launchOf(hit.run.runId);
          if (!launch) { outcomes.push({ ...id, status: 'not-accepted' }); continue; }
          try { await launch; }
          catch (e) { outcomes.push({ ...id, status: 'not-accepted', error: errText(e) }); continue; }
          hit = deps.ledger.findByPrompt(sessionId, promptId);
        }
        if (!hit || hit.run.state === 'starting') { outcomes.push({ ...id, status: 'not-accepted' }); continue; }
        outcomes.push({ ...id, status: 'accepted', run: hit.run });
      } else if (ref.kind === 'input') {
        const sessionId = deps.sessionId(ref.sessionId);
        if (typeof ref.messageId !== 'string' || !INPUT_ID_RE.test(ref.messageId)) throw Error('非法 messageId');
        const id = {kind: 'input' as const, sessionId, messageId: ref.messageId};
        if (deps.isSessionDeleted?.(sessionId)) { outcomes.push({...id,status:'not-accepted',error:SESSION_DELETED}); continue; }
        const input = deps.inputs?.get(sessionId, ref.messageId);
        outcomes.push(input ? {...id,status:'accepted',input} : {...id,status:'not-accepted'});
      } else if (ref.kind === 'permission') {
        if (typeof ref.requestId !== 'string' || ref.requestId === '') throw new Error('非法 requestId');
        const requestId = ref.requestId;
        const st = deps.broker.statusOf(requestId);
        if (st?.status === 'pending') { outcomes.push({ kind: 'permission', requestId, status: 'pending', sessionId: st.sessionId }); continue; }
        if (st?.status === 'settled') { outcomes.push({ kind: 'permission', requestId, status: 'settled', source: 'broker', settled: st.settled }); continue; }
        const a = deps.ledger.findApproval(requestId);
        if (a && (a.state === 'allowed' || a.state === 'denied' || a.state === 'expired') && !deps.isSessionDeleted?.(a.sessionId)) {
          outcomes.push({
            kind: 'permission', requestId, status: 'settled', source: 'ledger', sessionId: a.sessionId, toolUseId: a.toolUseId, epoch: a.epoch,
            approval: { state: a.state, ...(a.reason !== undefined ? { reason: a.reason } : {}), ...(a.cause !== undefined ? { cause: a.cause } : {}) },
            execution: a.execution,
          });
        } else {
          outcomes.push({ kind: 'permission', requestId, status: 'unknown' });
        }
      } else {
        throw new Error('不支持的查询类型');
      }
    }
    return { epoch: deps.epoch, instanceId: deps.instanceId, outcomes };
  };
}
