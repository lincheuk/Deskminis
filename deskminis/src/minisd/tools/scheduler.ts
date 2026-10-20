/**
 * F04：工具调度器——按副作用和资源冲突决定一批工具调用各自「什么时候可以开始」。
 *
 * 循环以前把同批调用丢进固定并发 10 的执行器，不看工具种类与参数：
 *  - 写 A 的权限卡还挂着，同批后面的读 A 已经跑完（读到旧值）；两次写同一路径，谁的卡先被点谁先落盘；
 *  - shell / MCP 与文件工具并跑；取消后排在 shell 自己队列里的命令仍会执行；
 *  - 不同会话之间没有任何协调。
 *
 * 两层结构：ResourceLockManager（resource-locks.ts，跨会话共用的锁表）负责排队与授予；这里把一批调用规划成锁请求，
 * 拿到锁后执行，按调用下标交回结果。
 *  - 整批同步规划、同步入队：票号按调用顺序连续，别的会话插不进本批中间。
 *  - barrier（未声明、非并发安全、副作用未知、资源解析失败、声明自相矛盾）用「会话 claim 取写」表达：
 *    它前面的要先跑完，后面的要等它跑完；其余调用的会话 claim 取读，互不冲突，资源不重叠就并行。
 *  - 锁在审批之前拿、持有到工具返回：写 A 之后读 A，读要等写完成，而写包含它的审批；
 *    file_write 权限卡上的差分是询问那一刻读的旧内容，锁内审批时同路径上排在前面的写一定已落盘。
 *
 * 不变量：调度器没有任何授予权限的路径。它只决定何时调 tool.execute；权限闸在各工具内部原样执行。
 * 元数据（ToolExecutor.scheduling）只影响排队与加锁，只来自宿主代码里注册的执行器对象；
 * 这里不做任何命令分类，也不读权限判定的结果。
 */
import type {
  PermissionAskOptions, PermissionDecision, PermissionDenied, PermissionGateway, PermissionOutcome, PermissionRequest,
  ResourceClaim, SideEffectScope, ToolContext, ToolExecutor, ToolOutcome, ToolPlanContext,
} from './types';
import { cancelCauseOf, denied } from '../../shared/permission';
import { decidePermission } from './permission-outcome';
import type { PreparedCall, ToolRegistry } from './registry';
import { pathIdentity, type DataGateOptions } from './data-gate';
import { ResourceLockManager, claimKey, type LockClaim, type LockResult } from './resource-locks';

/** input 是循环里归一后的 JSON 文本（落库、toolStart 事件、工具执行三处看到的是同一个值）。 */
export interface ScheduledCall { toolUseId: string; name: string; input: string }
/** refused：调度器没有调 execute 就给出了结果——会话排除、未知工具、入参不合法，或等锁期间工具被摘 / 调度条件变了。 */
export type CallEnd = 'completed' | 'refused' | 'cancelled-before-start' | 'lock-timeout';

export interface ScheduledResult<C extends ScheduledCall = ScheduledCall> {
  call: C; outcome: ToolOutcome; end: CallEnd;
  /** tool.execute 是否被调用过。false = 确定没有任何副作用（F05：可直接记为取消 / 未执行）。 */
  started: boolean;
  waitedMs: number;
}

/** 工具调用阶段的可观察事件。每个事件都带 sessionId（= BatchOptions.ctx.sessionId）/ index / toolUseId。
 *  回调同步执行；抛错被吞掉，不影响执行与放锁。settled 在放锁之前发出。 */
export type SchedulerEvent = { sessionId: string; index: number; toolUseId: string } & (
  | { kind: 'queued'; name: string; barrier: boolean; readOnly: boolean; sideEffects: SideEffectScope; claims: string[] }
  | { kind: 'started'; waitedMs: number }
  /** 工具进入权限判定。免审的也会瞬间往返一次，不等于弹了卡。 */
  | { kind: 'approval-requested'; request: { kind: PermissionRequest['kind']; detail: string } }
  /** decision：交回给工具的值；cancelled：因会话取消而提前交回（此时 decision 恒为 'deny'）。
   *  outcome（F13）：带原因的完整结果；弹过卡时 outcome.requestId 就是那张卡的 id（F05 据此把审批终态与工具调用对上）。
   *  cancelled 等价于 outcome.decision === 'deny' && outcome.reason === 'cancelled'。 */
  | { kind: 'approval-returned'; decision: PermissionDecision; cancelled: boolean; outcome: PermissionOutcome }
  | { kind: 'settled'; end: CallEnd; started: boolean; success: boolean }
);

export interface CallPlan { barrier: boolean; readOnly: boolean; sideEffects: SideEffectScope; claims: LockClaim[] }

function toLockClaim(c: ResourceClaim, path: DataGateOptions): LockClaim {
  if (c.kind === 'named') return { ns: 'named', key: c.name, mode: c.mode, display: c.name };
  const id = pathIdentity(c.path, path);
  return { ns: 'path', root: id.root, segs: id.segs, mode: c.mode, display: c.path };
}

/**
 * 把一次调用规划成锁请求。同步，不抛。F08 可直接用它在执行前拿到写集合（claims 里 ns==='path' && mode==='write'）。
 *
 * barrier 的条件（满足任一）：没有声明；声明了非并发安全；副作用未知；资源解析或路径规范化抛错；
 * 声明自相矛盾（只读却写本地文件 / 只读却给出写 claim / 写本地文件却没有任何写 claim）。
 * 没声明的工具另加本会话工作区子树的写 claim——「未知」与 shell 同一条规则；资源解析失败的不加任何跨会话 claim：
 * 内置解析只会在路径不合法时抛，execute 会在任何 IO 之前以同一个错失败，不该让模型一个写错的路径去挡别的会话。
 */
export function planCall(tool: ToolExecutor, input: Record<string, unknown>, ctx: ToolPlanContext, path: DataGateOptions = {}): CallPlan {
  const s = tool.scheduling;
  let claims: LockClaim[] = [];
  let resolveFailed = false;
  if (s?.resources) {
    try { claims = s.resources(input, ctx).map(c => toLockClaim(c, path)); }
    catch { claims = []; resolveFailed = true; }
  }
  const hasWrite = claims.some(c => c.mode === 'write');
  const barrier = s === undefined
    || !s.concurrencySafe
    || s.sideEffects === 'unknown'
    || resolveFailed
    || (s.readOnly && s.sideEffects === 'local-files')
    || (s.readOnly && hasWrite)
    || (s.sideEffects === 'local-files' && !hasWrite);
  if (s === undefined) {
    try { claims.push(toLockClaim({ kind: 'path', mode: 'write', path: ctx.paths.workspaceOf(ctx.sessionId) }, path)); }
    catch { /* 取不到工作区或规范化失败：不加，仍是会话内 barrier */ }
  }
  claims.push({ ns: 'session', key: ctx.sessionId, mode: barrier ? 'write' : 'read', display: '本会话的工具队列' });
  // 同键去重（取写），再按键排序：排序只为确定性——授予本身是整组原子的，比「按固定顺序逐个取锁」更强
  const byKey = new Map<string, LockClaim>();
  for (const c of claims) {
    const k = claimKey(c);
    const prev = byKey.get(k);
    if (!prev || (prev.mode === 'read' && c.mode === 'write')) byKey.set(k, c);
  }
  const sorted = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(e => e[1]);
  return { barrier, readOnly: s?.readOnly ?? false, sideEffects: s?.sideEffects ?? 'unknown', claims: sorted };
}

/** 两份计划的调度条件是否相同：barrier 相同，且 claims 逐条键与读写相同（planCall 已按键排序，逐位比）。 */
export function samePlan(a: CallPlan, b: CallPlan): boolean {
  if (a.barrier !== b.barrier || a.claims.length !== b.claims.length) return false;
  for (let i = 0; i < a.claims.length; i++) {
    if (claimKey(a.claims[i]) !== claimKey(b.claims[i]) || a.claims[i].mode !== b.claims[i].mode) return false;
  }
  return true;
}

/** 取消源：一个 signal 只挂一个 abort 监听，回调登记在集合里
 *  （一批里每个调用的权限检查都要与取消赛跑；逐个往 AbortSignal 上挂，超过 10 个 Node 会打 MaxListenersExceededWarning）。 */
export interface CancelSource { readonly aborted: boolean; subscribe(cb: () => void): () => void; dispose(): void }

export function cancelSourceOf(signal: AbortSignal | undefined): CancelSource | undefined {
  if (!signal) return undefined;
  const subs = new Set<() => void>();
  const onAbort = (): void => {
    for (const cb of [...subs]) { try { cb(); } catch { /* 订阅者的错误不影响其余订阅者 */ } }
    subs.clear();
  };
  signal.addEventListener('abort', onAbort);
  return {
    get aborted() { return signal.aborted; },
    subscribe(cb) {
      // 已取消的 signal 不会再发 abort 事件：当场回调
      if (signal.aborted) { cb(); return () => undefined; }
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
    dispose() { signal.removeEventListener('abort', onAbort); subs.clear(); },
  };
}

/**
 * 审批阶段的唯一接缝：所有经调度器执行的工具，权限检查都过这一层。
 * 只做三件事：把内层的结果原样（带原因）转交；会话取消时立即把 cancelled 交回工具，不再等卡片；
 * 把这次询问绑到发起它的工具调用上（toolUseId 进卡片与审计）。从不自己放行。
 *
 * 为什么要赛跑：abort 唤不醒正在等权限的工具（各工具都是拿到决议后才复查 signal），不交回的话它持有的锁
 * 要等用户点卡或 90 秒兜底才放。交回那一刻已取消就一律按取消交回，不看赛跑谁先到：生产路径上取消是
 * 「先了结卡、再 abort」写在同一段同步代码里，内层的决议与取消信号几乎同时到。
 *
 * F13：取消经每次询问各自的 AbortSignal 交给内层网关，网关当场把卡片了结——不经 index.ts 的调用方也不再留孤儿卡。
 * 一张卡被批准了、这次调用却因取消没有执行时，向内层报一条（带同一个 requestId）：否则审计里只有 answered / allow。
 * 没弹卡的放行（档位 bypass、会话授权）被取消不报——取消一次没弹卡的调用本来就不进权限审计。
 *
 * bind.signal 是会话的取消信号：只读它的 reason（区分用户停止 / 删除会话 / 关停），不往它上面挂监听——
 * 监听由 CancelSource 统一挂一个（一批里每个调用各挂一个的话，超过 10 个 Node 会打 MaxListenersExceededWarning）。
 */
export function wrapPermissions(
  inner: PermissionGateway, cancel: CancelSource | undefined,
  hooks?: {
    requested?(req: PermissionRequest): void;
    returned?(decision: PermissionDecision, cancelled: boolean, outcome: PermissionOutcome): void;
  },
  bind?: { toolUseId?: string; signal?: AbortSignal },
): PermissionGateway {
  const requested = (req: PermissionRequest): void => { try { hooks?.requested?.(req); } catch { /* 观察者的错误不影响权限判定 */ } };
  const returned = (o: PermissionOutcome): PermissionOutcome => {
    try { hooks?.returned?.(o.decision, o.decision !== 'allow' && o.reason === 'cancelled', o); } catch { /* 同上 */ }
    return o;
  };
  const cancelledNow = (requestId?: string): PermissionDenied =>
    denied('cancelled', cancelCauseOf(bind?.signal), requestId !== undefined ? { requestId } : undefined);
  const noteDenied = (req: PermissionRequest, d: PermissionDenied, o?: Pick<PermissionAskOptions, 'toolUseId' | 'origin'>): void => {
    try { inner.noteDenied?.(req, d, { toolUseId: bind?.toolUseId ?? o?.toolUseId, origin: 'tool' }); } catch { /* 记审计是尽力而为 */ }
  };
  const decide = async (req: PermissionRequest, opts?: PermissionAskOptions): Promise<PermissionOutcome> => {
    // 一张卡被批准了，这次调用却不执行：记一条。没弹卡的放行（不带 requestId）不记
    const dropped = (o: PermissionOutcome): void => {
      if (o.decision === 'allow' && o.requestId !== undefined) noteDenied(req, cancelledNow(o.requestId));
    };
    // 已取消：不再弹卡，不调内层
    if (cancel?.aborted) return returned(cancelledNow());
    requested(req);
    let issuedId: string | undefined;
    const askOpts: PermissionAskOptions = {
      toolUseId: bind?.toolUseId ?? opts?.toolUseId, origin: 'tool',
      onIssued: id => { issuedId = id; opts?.onIssued?.(id); },
    };
    if (!cancel) return returned(await decidePermission(inner, req, { ...askOpts, signal: opts?.signal }));
    // 每次询问一个 AbortController：取消经 CancelSource 转进来
    const ask = new AbortController();
    const unsubscribe = cancel.subscribe(() => ask.abort(bind?.signal?.reason));
    const pending = decidePermission(inner, req, { ...askOpts, signal: ask.signal });
    const aborted = new Promise<'cancelled'>(resolve => {
      if (ask.signal.aborted) resolve('cancelled');
      else ask.signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
    });
    let winner: PermissionOutcome | 'cancelled';
    try { winner = await Promise.race([pending, aborted]); }   // 内层先拒绝：原样抛出
    finally { unsubscribe(); }
    if (winner === 'cancelled') {
      // 取消先到，内层那次询问还没交回：它晚到的结果若是批准（同一拍里卡先被批准、取消紧跟着到），补记一条；
      // 晚到的拒绝不能变成未处理的拒绝。补记发生在本函数返回之后，只写审计，不影响已经交回的 cancelled
      pending.then(dropped, () => undefined);
      return returned(cancelledNow(issuedId));
    }
    if (cancel.aborted) {
      // 内层先交回，但此刻已取消：不放行
      dropped(winner);
      return returned(cancelledNow(winner.requestId ?? issuedId));
    }
    return returned(winner);
  };
  return {
    decide,
    /** 旧式二值投影：留给还按二值问的调用方。 */
    async check(req: PermissionRequest): Promise<PermissionDecision> { return (await decide(req)).decision; },
    noteDenied,
    hasBridgeGrant: sessionId => inner.hasBridgeGrant(sessionId),
    isPlanMode: () => inner.isPlanMode?.() === true,
  };
}

/** F05：一个调用在本批里的位置。 */
export interface CallRef { sessionId: string; index: number; toolUseId: string }

/** F08：journal.begin 交回的执行身份（runId = agent_runs.id，executionId = tool_executions.id）。 */
export interface CallIdentity { runId: string; executionId: string }

/**
 * F05：调用账本接缝。调度器只保证调用时机与「begin 抛错即不执行」，不关心实现（也不引入它）。
 * begin / settled 都在对应的 SchedulerEvent 之前调用：状态先提交，事件后发布。
 * 为什么不用 onEvent：事件回调的一切异常都被吞掉，settled 事件也不带输出——观察性事件做不到「意图落不下就不执行」。
 */
export interface CallJournal {
  /** 执行意图提交点：拿到锁、复核通过之后，发 started 与调 execute 之前，同步调用。
   *  抛错 = 意图没落下，本次不执行（end:'refused'、started:false），锁照常放。
   *  F08：可以交回执行身份；交回了就写进这次调用的 ToolContext.call（写前检查点据此关联 run 与工具执行）。 */
  begin(at: CallRef, plan: { name: string; barrier: boolean; readOnly: boolean; sideEffects: SideEffectScope; claims: string[]; writePaths: string[] }): void | CallIdentity;
  /** 按调用包一层权限网关：套在真实网关之外、取消赛跑层（wrapPermissions）之内。
   *  返回的网关只能转交内层结果或把放行改成拒绝，从不自己放行。 */
  permissions?(at: CallRef, inner: PermissionGateway): PermissionGateway;
  /** 落定（放锁之前）。每个调用恰好一次，包括没启动就有结果的。抛错被吞。 */
  settled(at: CallRef, r: { end: CallEnd; started: boolean; outcome: ToolOutcome }): void;
}

/** 写集合：计划里路径类的写 claim（宿主路径）。账本记作这次调用可能动到的产出物。 */
function writePathsOf(plan: CallPlan): string[] {
  return plan.claims.filter(c => c.ns === 'path' && c.mode === 'write').map(c => c.display);
}

/** 意图没落下：说清没有执行、没有改动、可以重试。 */
function intentNotRecorded(name: string, e: unknown): ToolOutcome {
  const why = e instanceof Error ? e.message : String(e);
  return {
    output: `工具 ${name} 没有执行：执行记录写入失败（${why}）。为避免留下没有记录的操作，本次调用被拦下，没有产生任何改动，可以重试。`,
    success: false,
  };
}

export interface BatchOptions<C extends ScheduledCall = ScheduledCall> {
  calls: C[]; registry: ToolRegistry;
  /** 工具执行上下文。会话 id 只有这一个来源：锁的 group、事件的 sessionId、resources() 的入参、execute 的入参
   *  全部取 ctx.sessionId。这里不另收 sessionId——调用方各填一次的两个值一旦不同，锁的路径和实际动的路径就分家。 */
  ctx: ToolContext;
  /** 等锁期间与启动前认的取消信号；缺省用 ctx.signal。审批赛跑只认 ctx.signal（工具闸后复查的就是它）。 */
  signal?: AbortSignal;
  /** 返回结果 = 不执行（会话排除的工具）。 */
  refuse?(call: C): ToolOutcome | undefined;
  onEvent?(e: SchedulerEvent): void;
  /** F05：调用账本。不传时行为与以前逐字相同。 */
  journal?: CallJournal;
}

export interface ToolSchedulerOptions {
  /** 传了就用它，下面两项忽略。 */
  locks?: ResourceLockManager;
  /** 缺省 MAX_CONCURRENT_PER_SESSION。 */
  maxConcurrentPerSession?: number;
  /** 缺省 LOCK_WAIT_TIMEOUT_MS。 */
  lockWaitTimeoutMs?: number;
  /** 路径规范化的平台与 realpath（测试注入）。 */
  path?: DataGateOptions;
}

const cancelledOutcome = (): ToolOutcome => ({ output: '[已取消]', success: false });

/** 等别的会话超时：说清没有执行、没有改动、可以重试。只带它自己给的路径，不带对方的会话 id 与内容。 */
function lockTimeoutOutcome(lock: Extract<LockResult, { ok: false }>): ToolOutcome {
  const what = lock.blockedBy?.display ?? '所需资源';
  const seconds = Math.max(1, Math.round(lock.waitedMs / 1000));
  return {
    output: `等待资源超时，本次调用没有执行：${what} 正被其它会话的操作占用（已等待 ${seconds} 秒）。没有产生任何改动，可以稍后重试。`,
    success: false,
  };
}

export class ToolScheduler {
  readonly locks: ResourceLockManager;
  private readonly pathOpts: DataGateOptions;

  constructor(opts: ToolSchedulerOptions = {}) {
    this.locks = opts.locks ?? new ResourceLockManager({
      maxConcurrentPerGroup: opts.maxConcurrentPerSession, waitTimeoutMs: opts.lockWaitTimeoutMs,
    });
    this.pathOpts = opts.path ?? {};
  }

  /** 执行一批调用。结果与 calls 同长同序（按下标关联，不按 toolUseId）。从不拒绝；返回时本批所有锁已释放。
   *  每个调用恒有一个结果：取消、超时、拒绝的也有（工具调用与结果配对由此保证）。 */
  runBatch<C extends ScheduledCall>(o: BatchOptions<C>): Promise<ScheduledResult<C>[]> {
    const sid = o.ctx.sessionId;
    const planCtx: ToolPlanContext = { sessionId: sid, paths: o.ctx.paths };
    const signal = o.signal ?? o.ctx.signal;
    const cancel = cancelSourceOf(o.ctx.signal);
    const results = new Array<ScheduledResult<C>>(o.calls.length);
    const emit = (e: SchedulerEvent): void => {
      if (!o.onEvent) return;
      try { o.onEvent(e); } catch { /* 观察者的错误不影响执行与放锁 */ }
    };
    /** 落定的唯一出口：写结果 → 账本提交（抛错被吞，结果与放锁不受影响）→ 发 settled 事件。放锁在它之后。 */
    const finish = (i: number, r: ScheduledResult<C>): void => {
      results[i] = r;
      const at = { sessionId: sid, index: i, toolUseId: r.call.toolUseId };
      try { o.journal?.settled(at, { end: r.end, started: r.started, outcome: r.outcome }); } catch { /* 账本的错误不影响执行与放锁 */ }
      emit({ ...at, kind: 'settled', end: r.end, started: r.started, success: r.outcome.success });
    };
    const refused = (i: number, call: C, outcome: ToolOutcome): void => {
      finish(i, { call, outcome, end: 'refused', started: false, waitedMs: 0 });
    };

    /** 拿到锁之后、启动之前复核「入队时定下的计划还作不作数」。同步；通过时交回要执行的那个对象（可能已换成表里当前的）。
     *  入队到执行之间隔着等锁（同批前序不限时，等别的会话最长 LOCK_WAIT_TIMEOUT_MS），两样东西都可能变：
     *  - 注册表。名字不在了（等锁期间 MCP 被 forget / 空闲驱逐 / 崩溃摘除）：按未知工具失败，旧执行器不进 execute——
     *    否则它照常问权限、发调用，还会把刚被复位的服务器标成出错。同名换了对象（MCP 重连或重列）：按新对象重做预检。
     *  - resources() 读的状态。会话工作区被用户改了（workspace.set / reset 不看会话是否在跑），或路径上多出了链接：
     *    文件类工具进 execute 时按当前状态重新解析路径，锁却是按入队时的解析结果拿的——相对路径的 file_write
     *    会拿着旧工作区那条路径的锁去写新工作区，别的会话在新工作区里对同一文件的写挡不住它。
     *  所以对象换没换都按表里当前的对象、当前的状态重新规划一次，与已持有的锁逐条相同才执行；不同就失败不执行、
     *  说明可以重试（重试时按新状态入队，锁的就是它要动的路径）。不能拿着 W1/x 的锁去写 W2/x，也不能拿着甲的锁去跑乙的工具。
     *  从这里到 registry.run、再到文件类工具 execute 里解析路径之间没有 await：重新规划看到的就是工具将要用的那个状态。
     *  （shell 的 cwd 在权限 await 之后才取，审批期间改工作区的窗口仍在。） */
    const recheck = (call: C, prepared: PreparedCall, plan: CallPlan): { run: PreparedCall } | { stale: ToolOutcome } => {
      const cur = o.registry.get(call.name);
      if (cur === undefined) return { stale: { output: `未知工具: ${call.name}`, success: false } };
      let run = prepared;
      if (cur !== prepared.tool) {
        const again = o.registry.prepare(call.name, call.input);
        if ('error' in again) return { stale: again.error };
        run = again;
      }
      if (samePlan(plan, planCall(run.tool, run.input, planCtx, this.pathOpts))) return { run };
      // 两句文案分开：对象没换时说「被重新注册」不属实
      return {
        stale: {
          output: run === prepared
            ? `工具 ${call.name} 的调度条件在等待执行期间已变（会话工作区被更改，或路径的指向变了），本次调用没有执行，可以重试。`
            : `工具 ${call.name} 在等待执行期间被重新注册，调度条件已变，本次调用没有执行，可以重试。`,
          success: false,
        },
      };
    };

    const runOne = async (i: number, call: C, prepared: PreparedCall, plan: CallPlan, lockP: Promise<LockResult>): Promise<void> => {
      const at = { sessionId: sid, index: i, toolUseId: call.toolUseId };
      const lock = await lockP;
      if (!lock.ok) {
        // 没拿到锁：execute 从未被调用，不发权限请求
        const end: CallEnd = lock.reason === 'cancelled' ? 'cancelled-before-start' : 'lock-timeout';
        const outcome = lock.reason === 'cancelled' ? cancelledOutcome() : lockTimeoutOutcome(lock);
        finish(i, { call, outcome, end, started: false, waitedMs: lock.waitedMs });
        return;
      }
      // 调度器不设执行看门狗、不提前放锁：锁只在工具真正返回时放，提前放就是数据竞争
      try {
        let outcome: ToolOutcome;
        let end: CallEnd = 'completed';
        let started = false;
        try {
          if (signal?.aborted) {
            // 授予与这个续体之间隔一个微任务：拿到锁的同一刻被取消，不启动
            outcome = cancelledOutcome(); end = 'cancelled-before-start';
          } else {
            const checked = recheck(call, prepared, plan);
            if ('stale' in checked) {
              outcome = checked.stale; end = 'refused';
            } else {
              // F05：执行意图先落账，落不下就不执行。recheck → begin → registry.run 之间仍然没有 await：
              // 重新规划看到的就是工具将要用的状态，账本里「执行中」先于 execute 的第一行。
              let gateway = o.ctx.permissions;
              let blocked: ToolOutcome | undefined;
              let ident: CallIdentity | undefined;
              try {
                ident = o.journal?.begin(at, {
                  name: call.name, barrier: plan.barrier, readOnly: plan.readOnly, sideEffects: plan.sideEffects,
                  claims: plan.claims.map(claimKey), writePaths: writePathsOf(plan),
                }) ?? undefined;
                if (o.journal?.permissions) gateway = o.journal.permissions(at, o.ctx.permissions);
              } catch (e) {
                blocked = intentNotRecorded(call.name, e);
              }
              if (blocked) {
                // execute 没被调用：started 保持 false
                outcome = blocked; end = 'refused';
              } else {
                emit({ ...at, kind: 'started', waitedMs: lock.waitedMs });
                started = true;
                const callCtx: ToolContext = {
                  ...o.ctx,
                  permissions: wrapPermissions(gateway, cancel, {
                    requested: req => emit({ ...at, kind: 'approval-requested', request: { kind: req.kind, detail: req.detail } }),
                    returned: (decision, cancelled, outcome) => emit({ ...at, kind: 'approval-returned', decision, cancelled, outcome }),
                  }, { toolUseId: call.toolUseId, signal: o.ctx.signal }),
                  // F08：这次调用的身份。没有 journal 时照样填（只是没有 runId / executionId）。
                  // covers：这条宿主路径此刻是否仍落在本次调用持有的路径写锁之内——与锁同一套 pathIdentity，规范化选项只在调度器里。
                  // 审批等待期间路径上的链接被改指向时，工具进门时解析出的路径不变、真实位置却换了：写入入口据此拒绝
                  call: {
                    toolUseId: call.toolUseId, index: i, name: call.name, ...(ident ?? {}),
                    covers: (abs: string): boolean => {
                      try {
                        const id = pathIdentity(abs, this.pathOpts);
                        return plan.claims.some(c => c.ns === 'path' && c.mode === 'write' && c.root === id.root
                          && c.segs.length <= id.segs.length && c.segs.every((s, k) => s === id.segs[k]));
                      } catch { return false; }
                    },
                  },
                };
                outcome = await o.registry.run(checked.run, callCtx);
              }
            }
          }
        } catch (e) {
          // registry.run 本不抛，防御
          outcome = { output: `工具执行异常: ${String(e)}`, success: false }; end = 'completed';
        }
        finish(i, { call, outcome, end, started, waitedMs: lock.waitedMs });
      } finally {
        lock.release();
      }
    };

    // 第 1 步：同步规划与入队。这个循环里不得出现 await——票号因此按调用顺序连续（同批顺序靠它），
    // 别的会话也插不进本批中间。runBatch 本身不是 async 函数，就是为了让这里写不进 await。
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < o.calls.length; i++) {
      const call = o.calls[i];
      const no = o.refuse?.(call);
      if (no) { refused(i, call, no); continue; }
      const prepared = o.registry.prepare(call.name, call.input);
      // 未知工具、入参不合法：工具代码不会运行，无需排队、不占锁
      if ('error' in prepared) { refused(i, call, prepared.error); continue; }
      const plan = planCall(prepared.tool, prepared.input, planCtx, this.pathOpts);
      emit({
        sessionId: sid, index: i, toolUseId: call.toolUseId, kind: 'queued', name: call.name,
        barrier: plan.barrier, readOnly: plan.readOnly, sideEffects: plan.sideEffects, claims: plan.claims.map(claimKey),
      });
      const lockP = this.locks.acquire({ group: sid, label: `${sid}/${call.toolUseId}/${call.name}`, claims: plan.claims, signal });
      tasks.push(runOne(i, call, prepared, plan, lockP));
    }
    return Promise.all(tasks).then(() => { cancel?.dispose(); return results; });
  }
}

let shared: ToolScheduler | undefined;
/** 进程级缺省实例（惰性单例）：调用方没传 scheduler 时用它——漏接线也不会退化成「每个 run 一把锁」。
 *  生产由 index.ts 为每个引擎实例显式建一个并传给每个 run。 */
export function sharedToolScheduler(): ToolScheduler {
  return (shared ??= new ToolScheduler());
}
