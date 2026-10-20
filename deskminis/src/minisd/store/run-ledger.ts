/**
 * F05：运行账本——引擎代次（租约）、run 状态机、工具执行记录的持久层。
 *
 * 以前 run 的占位、控制器、收尾 promise 都只在内存里（index.ts 的 inFlight / controllers / runs）：
 * 批次中途引擎被杀，库里只剩 assistant 的 toolUse、没有结果消息，「还没开始」「执行了一半」「执行完只差落库」
 * 在盘上是同一个样子；同批里已经做完的结果只在内存里，一并丢掉。这里把三样东西落进库：
 *  - engine_instances：每次启动开一个新代次（epoch）。判定一个 run 的属主已死只看「它的 epoch 小于当前」——
 *    数据根锁保证同一数据根同时只有一个活的引擎，能走到开代次说明前代已经不在了。
 *    心跳只供存活判断与诊断：这个文件里没有任何分支按心跳新旧改状态、判失败或触发执行。
 *  - agent_runs：run 的状态、步骤、停止原因、来源与幂等 id。同一会话最多一个活动 run（部分唯一索引兜底）。
 *  - tool_executions：每个工具调用一行。执行意图先落账（beginExecution）再调工具；结果在调用落定时提交；
 *    整批结果消息与「已交付」同一事务。
 *
 * 每次写入都校验租约（tx → assertLease，且 UPDATE 带 epoch 条件）：被后一代接管的旧实例写不进去，
 * 意图落不下就不执行工具，也不会往历史里多写一条结果。
 *
 * 这里不调用任何工具，也不宣称外部操作恰好执行一次：数据库提交与外部副作用之间无法普遍原子化。
 * 保证的是「意图已落账的调用，引擎至多调用一次 execute」；结果没提交就中断的，由后一代的恢复记为 unknown
 *（agent/run-recovery.ts），从不重放。没有任何工具带幂等协议。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalState, RunOrigin, RunRef, RunSnapshot, RunSnapshotQuery, RunState, RunStep, RunView,
  ToolEndKind, ToolExecState, ToolExecutionView,
} from '../../shared/run';

/** 有活动 run 时写心跳的间隔。 */
export const RUN_HEARTBEAT_MS = 10_000;
const STOP_DETAIL_MAX = 500;
const TERMINAL_EXEC = "('completed','failed','cancelled','unknown')";
const OPEN_EXEC = "('pending','awaiting-approval','running')";

export class RunActiveError extends Error {
  readonly code = 'RUN_ACTIVE' as const;
  constructor() { super('该会话正在运行中，请等待完成或取消'); this.name = 'RunActiveError'; }
}
export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST' as const;
  constructor() { super('数据已被另一个 DeskMinis 实例接管，本实例不再写入，请重启应用'); this.name = 'LeaseLostError'; }
}

export interface RunLedgerOptions {
  now?: () => number; newId?: () => string; pid?: number; appVersion?: string;
  warn?: (msg: string, e?: unknown) => void;
}
export interface RunEnd { state: 'completed' | 'failed' | 'cancelled'; reason: string; detail?: string }

export interface RunHandle {
  readonly ref: RunRef;
  /** 原子地落 user 消息并把 run 置为 running。返回 append 的返回值。run 已不归本代次时抛 LeaseLostError（消息一并回滚）。 */
  started<T extends { id: string }>(append: () => T): T;
  /** 落终态。幂等；已是终态、租约已失、账本已关停时什么都不做。不抛。 */
  end(e: RunEnd): void;
}

/** 调度器在执行前交来的计划（= CallJournal.begin 的第二个实参；这里按结构收，不引调度器）。 */
export interface ExecutionPlan {
  name: string; barrier: boolean; readOnly: boolean;
  sideEffects: 'none' | 'local-files' | 'network' | 'unknown';
  claims: string[]; writePaths: string[];
}
export interface ExecutionSettle {
  state: 'completed' | 'failed' | 'cancelled'; endKind: ToolEndKind;
  started: boolean; success: boolean;
  /** 落库形态（卸载桩 / 读回封顶之后的文本）。 */
  output: string; offloadPath?: string; chars: number;
}

/** 已落定、未交付时行里还留着落库形态的文本（恢复据此补结果消息）。 */
export interface OpenRow extends ToolExecutionView { resultOutput?: string }
export interface OpenBatch { runId: string; sessionId: string; batch: number; assistantMessageId: string; rows: OpenRow[] }

interface RunRow {
  id: string; session_id: string; generation: number; epoch: number; state: string; active: number | null;
  step: string; tool_batches: number; origin: string; origin_ref: string | null;
  prompt_id: string | null; prompt_digest: string | null; user_message_id: string | null;
  stop_reason: string | null; stop_detail: string | null; recovered_epoch: number | null;
  created_at: number; updated_at: number; ended_at: number | null;
}
interface ExecRow {
  id: string; run_id: string; session_id: string; epoch: number; batch: number; call_index: number;
  tool_use_id: string; tool_name: string; assistant_message_id: string; state: string; end_kind: string | null;
  started: number; barrier: number | null; read_only: number | null; side_effects: string | null;
  claims_json: string | null; write_paths_json: string | null;
  approval_state: string | null; approval_request_id: string | null; approval_kind: string | null;
  approval_reason: string | null; approval_cause: string | null; prior_allows: number;
  result_success: number | null; result_output: string | null; result_offload_path: string | null; result_chars: number | null;
  result_message_id: string | null; delivered_at: number | null;
  created_at: number; started_at: number | null; settled_at: number | null; updated_at: number;
}

function toRunView(r: RunRow): RunView {
  const v: RunView = {
    runId: r.id, sessionId: r.session_id, generation: r.generation, epoch: r.epoch,
    state: r.state as RunState, step: r.step as RunStep, toolBatches: r.tool_batches,
    origin: r.origin === 'cron' && r.origin_ref ? { kind: 'cron', ref: r.origin_ref } : { kind: 'user' },
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
  if (r.prompt_id !== null) v.promptId = r.prompt_id;
  if (r.user_message_id !== null) v.userMessageId = r.user_message_id;
  if (r.stop_reason !== null) v.stopReason = r.stop_reason;
  if (r.stop_detail !== null) v.stopDetail = r.stop_detail;
  if (r.recovered_epoch !== null) v.recoveredEpoch = r.recovered_epoch;
  if (r.ended_at !== null) v.endedAt = r.ended_at;
  return v;
}

/** 一行坏数据不该让整次扫描失败：解析不了的 JSON 按空数组算。 */
function stringList(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function toExecView(r: ExecRow): ToolExecutionView {
  const v: ToolExecutionView = {
    id: r.id, runId: r.run_id, sessionId: r.session_id, epoch: r.epoch,
    batch: r.batch, index: r.call_index, toolUseId: r.tool_use_id, name: r.tool_name, assistantMessageId: r.assistant_message_id,
    state: r.state as ToolExecState, started: r.started === 1,
    delivered: r.delivered_at !== null,
    artifacts: { writePaths: stringList(r.write_paths_json) },
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
  if (r.end_kind !== null) v.endKind = r.end_kind as ToolEndKind;
  if (r.barrier !== null) v.barrier = r.barrier === 1;
  if (r.read_only !== null) v.readOnly = r.read_only === 1;
  if (r.side_effects !== null) v.sideEffects = r.side_effects as ToolExecutionView['sideEffects'];
  if (r.approval_state !== null) {
    v.approval = { state: r.approval_state as ApprovalState, priorAllows: r.prior_allows };
    if (r.approval_request_id !== null) v.approval.requestId = r.approval_request_id;
    if (r.approval_kind !== null) v.approval.kind = r.approval_kind;
    if (r.approval_reason !== null) v.approval.reason = r.approval_reason;
    if (r.approval_cause !== null) v.approval.cause = r.approval_cause;
  }
  if (r.result_success !== null) v.success = r.result_success === 1;
  if (r.result_message_id !== null) v.resultMessageId = r.result_message_id;
  if (r.result_offload_path !== null) v.artifacts.offloadPath = r.result_offload_path;
  if (r.started_at !== null) v.startedAt = r.started_at;
  if (r.settled_at !== null) v.settledAt = r.settled_at;
  return v;
}

export class RunLedger {
  readonly epoch: number;
  readonly instanceId: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly warn: (msg: string, e?: unknown) => void;
  /** 构造时读到的 synchronous 取值（WAL 下缺省 1 = NORMAL）；durable() 临时切到 FULL 后恢复成它。 */
  private readonly syncDefault: number;
  /** 本进程里没收尾的 run：sessionId → runId。真正在跑的 run 由它挡住；库里的陈旧活动行由 beginRun 收掉。 */
  private readonly active = new Map<string, string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private isClosed = false;

  /** 构造即开新代次：插入本代的行，把前代里还没关的记为 superseded（有序关停的前代已是 shutdown，不会被改）。同步。 */
  constructor(private readonly db: Database.Database, opts: RunLedgerOptions = {}) {
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.newId = opts.newId ?? (() => randomUUID().toUpperCase());
    this.warn = opts.warn ?? ((msg, e) => { console.warn(msg, e); });
    this.instanceId = this.newId();
    const at = this.now();
    this.epoch = db.transaction(() => {
      const r = db.prepare('INSERT INTO engine_instances (instance_id, pid, app_version, started_at, heartbeat_at) VALUES (?,?,?,?,?)')
        .run(this.instanceId, opts.pid ?? process.pid, opts.appVersion ?? '', at, at);
      const epoch = Number(r.lastInsertRowid);
      db.prepare("UPDATE engine_instances SET closed_at=?, close_kind='superseded' WHERE epoch < ? AND closed_at IS NULL").run(at, epoch);
      return epoch;
    }).immediate();
    this.syncDefault = Number(db.pragma('synchronous', { simple: true }));
  }

  get closed(): boolean { return this.isClosed; }

  /** 租约：本代次的行还在、还没关。被后一代接管（superseded）或已有序关停的实例不再写入。 */
  private assertLease(): void {
    const r = this.db.prepare('SELECT closed_at FROM engine_instances WHERE epoch=?').get(this.epoch) as { closed_at: number | null } | undefined;
    if (!r || r.closed_at !== null) throw new LeaseLostError();
  }

  /** 账本的全部写入都经这里：已在事务里直接执行（外层已校验过租约），否则开一个立即事务并先校验租约。 */
  private tx<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn();
    return this.db.transaction(() => { this.assertLease(); return fn(); }).immediate();
  }

  /** 同一个库事务里执行 fn；已在事务里时直接执行。账本关停后直接调 fn（库已关，它自己会抛，与以前晚到的写入相同）。 */
  atomic<T>(fn: () => T): T {
    if (this.isClosed) return fn();
    return this.tx(fn);
  }

  /**
   * 持久提交：这一笔提交用 synchronous = FULL（刷的是整个 WAL，它之前的 assistant 消息与待执行行一并落盘）。
   * 进程崩溃、被强杀时 WAL 的普通提交已经够；断电、系统崩溃时 NORMAL 下最近的提交可能回滚——意图若丢了而副作用已发生，
   * 恢复会把它说成「未执行」。SQLite 不允许在事务里改这个设置，所以已在事务里、或原值已不低于 FULL 时直接执行。
   */
  private durable<T>(fn: () => T): T {
    if (this.db.inTransaction || this.syncDefault >= 2) return fn();
    this.db.pragma('synchronous = FULL');
    try { return fn(); } finally { this.db.pragma(`synchronous = ${this.syncDefault}`); }
  }

  /** F08：检查点记录的提交。与执行意图同一规格：账本已关停就抛（atomic 在关停后直接调 fn，挡不住晚到的写入）；
   *  校验租约；这一笔用 FULL 同步——记录落不下，就不许动目标文件。 */
  durableAtomic<T>(fn: () => T): T {
    if (this.isClosed) throw new Error('引擎正在关闭');
    return this.durable(() => this.tx(fn));
  }

  // ---------- run ----------

  findByPrompt(sessionId: string, promptId: string): { run: RunView; promptDigest?: string } | undefined {
    const r = this.db.prepare('SELECT * FROM agent_runs WHERE session_id=? AND prompt_id=?').get(sessionId, promptId) as RunRow | undefined;
    if (!r) return undefined;
    return r.prompt_digest !== null ? { run: toRunView(r), promptDigest: r.prompt_digest } : { run: toRunView(r) };
  }

  /**
   * 占用会话的活动 run。本进程里该会话已有没收尾的 run → RunActiveError；租约已失 → LeaseLostError。
   * 库里该会话残留的活动行顺手收掉：本代的只可能是上一次 end() 写库失败留下的（记 failed / finalize-failed）；
   * 更早代次的是启动恢复没能收掉的（记 interrupted / engine-crash）。会话不会被陈旧行占住。
   */
  beginRun(o: { sessionId: string; origin: RunOrigin; promptId?: string; promptDigest?: string }): RunHandle {
    if (this.isClosed) throw new Error('引擎正在关闭');
    if (this.active.has(o.sessionId)) throw new RunActiveError();
    const id = this.newId();
    const ref = this.tx((): RunRef => {
      const at = this.now();
      const stale = this.db.prepare('SELECT id, epoch FROM agent_runs WHERE session_id=? AND active=1').all(o.sessionId) as { id: string; epoch: number }[];
      for (const s of stale) {
        const mine = s.epoch === this.epoch;
        this.db.prepare(`UPDATE agent_runs SET state=?, active=NULL, step='finished', stop_reason=?, stop_detail=?, recovered_epoch=?, ended_at=?, updated_at=?,
          prompt_id = CASE WHEN user_message_id IS NULL THEN NULL ELSE prompt_id END WHERE id=? AND active=1`)
          .run(mine ? 'failed' : 'interrupted', mine ? 'finalize-failed' : 'engine-crash',
            mine ? '上一次运行的终态没能写入，起下一次运行时补记' : '启动恢复没能收口这次运行，起下一次运行时补记',
            mine ? null : this.epoch, at, at, s.id);
      }
      const { mx } = this.db.prepare('SELECT COALESCE(MAX(generation), 0) mx FROM agent_runs WHERE session_id=?').get(o.sessionId) as { mx: number };
      this.db.prepare(`INSERT INTO agent_runs (id, session_id, generation, epoch, state, active, step, origin, origin_ref, prompt_id, prompt_digest, created_at, updated_at)
        VALUES (?,?,?,?,'starting',1,'starting',?,?,?,?,?,?)`)
        .run(id, o.sessionId, mx + 1, this.epoch, o.origin.kind, o.origin.kind === 'cron' ? o.origin.ref : null, o.promptId ?? null, o.promptDigest ?? null, at, at);
      return { runId: id, sessionId: o.sessionId, generation: mx + 1, epoch: this.epoch };
    });
    this.active.set(o.sessionId, id);
    return {
      ref,
      started: <T extends { id: string }>(append: () => T): T => this.atomic(() => {
        const m = append();
        if (this.isClosed) return m;
        const r = this.db.prepare("UPDATE agent_runs SET state='running', step='model', user_message_id=?, updated_at=? WHERE id=? AND epoch=? AND active=1 AND state='starting'")
          .run(m.id, this.now(), id, this.epoch);
        // starting 一定没有 user 消息，running 一定有：改不动这一行就连消息一起回滚
        if (r.changes !== 1) throw new LeaseLostError();
        return m;
      }),
      end: (e: RunEnd): void => {
        try {
          if (this.isClosed) return;
          this.tx(() => {
            const at = this.now();
            // 从未落过 user 消息的 run 不占 promptId：这次提交没有留下任何用户可见的东西，同一个 id 可以再提交
            this.db.prepare(`UPDATE agent_runs SET state=?, active=NULL, step='finished', stop_reason=?, stop_detail=?, ended_at=?, updated_at=?,
              prompt_id = CASE WHEN user_message_id IS NULL THEN NULL ELSE prompt_id END WHERE id=? AND epoch=? AND active=1`)
              .run(e.state, e.reason, e.detail !== undefined ? e.detail.slice(0, STOP_DETAIL_MAX) : null, at, at, id, this.epoch);
          });
        } catch (err) {
          // 租约已失：本实例不再写入，什么都不做。其余写库失败只告警——陈旧的活动行由下一次 beginRun 或启动恢复收掉
          if (!(err instanceof LeaseLostError)) this.warn('run 终态写入失败（该会话下次起跑或下次启动时补记）:', err);
        } finally {
          // 无论写没写成，都把会话从活动表摘掉：账本的失败不能让会话一直「运行中」
          if (this.active.get(o.sessionId) === id) this.active.delete(o.sessionId);
        }
      },
    };
  }

  getRun(runId: string): RunView | undefined {
    const r = this.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId) as RunRow | undefined;
    return r ? toRunView(r) : undefined;
  }

  listExecutions(runId: string, o?: { batch?: number }): ToolExecutionView[] {
    const rows = (o?.batch !== undefined
      ? this.db.prepare('SELECT * FROM tool_executions WHERE run_id=? AND batch=? ORDER BY batch, call_index').all(runId, o.batch)
      : this.db.prepare('SELECT * FROM tool_executions WHERE run_id=? ORDER BY batch, call_index').all(runId)) as ExecRow[];
    return rows.map(toExecView);
  }

  /**
   * 只读快照，单个读事务：全部活动 run；q.runId 指定的 run；q.sessionId 给出时该会话 generation 最大的那个 run。
   * executions 只含所列 run 的最后一批与尚未交付的行。不带工具入参与输出正文。
   * 同步执行，与 run 事件的发布在同一线程：消费方在同一段同步代码里取快照与自己的事件序号就是无缝边界。
   */
  snapshot(q: RunSnapshotQuery = {}): RunSnapshot {
    return this.db.transaction((): RunSnapshot => {
      const byId = new Map<string, RunRow>();
      for (const r of this.db.prepare('SELECT * FROM agent_runs WHERE active=1 ORDER BY created_at').all() as RunRow[]) byId.set(r.id, r);
      if (q.runId !== undefined) {
        const r = this.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(q.runId) as RunRow | undefined;
        if (r) byId.set(r.id, r);
      }
      if (q.sessionId !== undefined) {
        const r = this.db.prepare('SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation DESC LIMIT 1').get(q.sessionId) as RunRow | undefined;
        if (r) byId.set(r.id, r);
      }
      const executions: ToolExecutionView[] = [];
      for (const r of byId.values()) {
        const rows = this.db.prepare('SELECT * FROM tool_executions WHERE run_id=? AND (batch=? OR delivered_at IS NULL) ORDER BY batch, call_index')
          .all(r.id, r.tool_batches) as ExecRow[];
        for (const x of rows) executions.push(toExecView(x));
      }
      const inst = this.db.prepare('SELECT heartbeat_at FROM engine_instances WHERE epoch=?').get(this.epoch) as { heartbeat_at: number } | undefined;
      return {
        epoch: this.epoch, instanceId: this.instanceId, heartbeatAt: inst?.heartbeat_at ?? 0, takenAt: this.now(),
        runs: [...byId.values()].map(toRunView), executions,
      };
    })();
  }

  /**
   * F06：按权限卡 id 找执行账本里的审批记录（state.outcomes 用）。跨代次：卡可以是前一代引擎发的——
   * 有序关停时挂着的卡记成 denied / cancelled，崩溃时挂着的由后一代的恢复记成 expired / engine-restarted。
   * 只有工具发起、弹过卡的调用才有记录（经桥发起的卡不在账本里）。只读；找不到返回 undefined。
   * 没有索引：这是重连后核对在途批准、且 broker 不认识那张卡时才走到的偶发查询。一次调用多次询问的，行里只留着最后一张卡的 id。
   */
  findApproval(requestId: string): {
    sessionId: string; toolUseId: string; epoch: number;
    state: ApprovalState; reason?: string; cause?: string; execution: ToolExecState;
  } | undefined {
    const r = this.db.prepare(`SELECT session_id, tool_use_id, epoch, state, approval_state, approval_reason, approval_cause
      FROM tool_executions WHERE approval_request_id=? AND approval_state IS NOT NULL ORDER BY updated_at DESC LIMIT 1`).get(requestId) as
      Pick<ExecRow, 'session_id' | 'tool_use_id' | 'epoch' | 'state' | 'approval_state' | 'approval_reason' | 'approval_cause'> | undefined;
    if (!r || r.approval_state === null) return undefined;
    return {
      sessionId: r.session_id, toolUseId: r.tool_use_id, epoch: r.epoch,
      state: r.approval_state as ApprovalState, execution: r.state as ToolExecState,
      ...(r.approval_reason !== null ? { reason: r.approval_reason } : {}),
      ...(r.approval_cause !== null ? { cause: r.approval_cause } : {}),
    };
  }

  // ---------- 心跳与关停 ----------

  /** 写一次心跳（本进程有没收尾的 run 才写）；返回是否写了。只是一个时间戳：没有任何代码据此改状态。 */
  heartbeat(): boolean {
    if (this.isClosed || this.active.size === 0) return false;
    try {
      return this.db.prepare('UPDATE engine_instances SET heartbeat_at=? WHERE epoch=? AND closed_at IS NULL').run(this.now(), this.epoch).changes === 1;
    } catch (e) {
      this.warn('运行心跳写入失败:', e);
      return false;
    }
  }

  startHeartbeat(ms: number = RUN_HEARTBEAT_MS): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => { this.heartbeat(); }, ms);
    this.heartbeatTimer.unref(); // 定时器不阻止进程退出
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /**
   * 有序关停时调：本代次记 closed_at / close_kind='shutdown'。此后一切写入是空操作，beginExecution 抛错。
   * 仍在活动的 run 不动，留给下次启动恢复（它会据 close_kind 记成 shutdown-timeout）。不抛。
   */
  close(): void {
    if (this.isClosed) return;
    this.stopHeartbeat();
    try {
      this.db.prepare("UPDATE engine_instances SET closed_at=?, close_kind='shutdown' WHERE epoch=? AND closed_at IS NULL").run(this.now(), this.epoch);
    } catch (e) {
      this.warn('封账失败（下次启动按崩溃恢复）:', e);
    }
    this.isClosed = true;
  }

  // ---------- 记录器用（agent/run-recorder.ts）----------

  /** 开一批：run 的步骤置为 tools、批号加一，每个调用插一行待执行。调用方把它与落 assistant 消息放进同一个事务（atomic）。 */
  openBatch(runId: string, assistantMessageId: string, calls: readonly { toolUseId: string; name: string }[]): { batch: number; rowIds: string[] } {
    return this.tx(() => {
      const at = this.now();
      const r = this.db.prepare("UPDATE agent_runs SET step='tools', tool_batches = tool_batches + 1, updated_at=? WHERE id=? AND epoch=? AND active=1")
        .run(at, runId, this.epoch);
      if (r.changes !== 1) throw new LeaseLostError();
      const run = this.db.prepare('SELECT session_id, tool_batches FROM agent_runs WHERE id=?').get(runId) as { session_id: string; tool_batches: number };
      const ins = this.db.prepare(`INSERT INTO tool_executions (id, run_id, session_id, epoch, batch, call_index, tool_use_id, tool_name, assistant_message_id, state, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`);
      const rowIds = calls.map((c, i) => {
        const id = this.newId();
        ins.run(id, runId, run.session_id, this.epoch, run.tool_batches, i, c.toolUseId, c.name, assistantMessageId, at, at);
        return id;
      });
      return { batch: run.tool_batches, rowIds };
    });
  }

  /**
   * 执行意图提交点：待执行 → 执行中。必须恰好改一行，否则抛（调度器据此不调 execute）。
   * 只读且无副作用的调用用普通提交，其余用持久提交。
   */
  beginExecution(rowId: string, plan: ExecutionPlan): void {
    if (this.isClosed) throw new Error('引擎正在关闭');
    const write = (): void => this.tx(() => {
      const at = this.now();
      const r = this.db.prepare(`UPDATE tool_executions SET state='running', started=1, started_at=?, barrier=?, read_only=?, side_effects=?, claims_json=?, write_paths_json=?, updated_at=?
        WHERE id=? AND epoch=? AND state='pending' AND delivered_at IS NULL`)
        .run(at, plan.barrier ? 1 : 0, plan.readOnly ? 1 : 0, plan.sideEffects, JSON.stringify(plan.claims), JSON.stringify(plan.writePaths), at, rowId, this.epoch);
      if (r.changes !== 1) throw new Error('执行记录不在待执行状态');
    });
    if (plan.readOnly && plan.sideEffects === 'none') write(); else this.durable(write);
  }

  /** 弹了卡：执行中 → 审批中，记下那张卡的 requestId 与发卡时此前已拿到的放行次数。行不在执行中时什么都不改。 */
  approvalIssued(rowId: string, a: { requestId: string; kind: string; priorAllows: number }): void {
    if (this.isClosed) return;
    this.tx(() => {
      this.db.prepare(`UPDATE tool_executions SET state='awaiting-approval', approval_state='pending', approval_request_id=?, approval_kind=?, prior_allows=?,
        approval_reason=NULL, approval_cause=NULL, updated_at=? WHERE id=? AND epoch=? AND state='running' AND delivered_at IS NULL`)
        .run(a.requestId, a.kind, a.priorAllows, this.now(), rowId, this.epoch);
    });
  }

  /**
   * 弹过卡之后的放行：审批中 → 执行中。持久提交。
   * 返回 false = 这一行已经落定（取消先到、工具已经返回），没有东西要记，这次放行也不会再引出执行。
   * 写不成（库写失败、租约已失、账本已关停）就抛：调用方据此把放行改成拒绝——
   * 放行那一笔若没落账，行会停在「审批中」而工具已经执行，崩溃后被说成「未执行」，模型据此重做就是重复副作用。
   */
  approvalAllowed(rowId: string): boolean {
    if (this.isClosed) throw new Error('引擎正在关闭');
    return this.durable(() => this.tx(() => {
      const r = this.db.prepare(`UPDATE tool_executions SET state='running', approval_state='allowed', updated_at=?
        WHERE id=? AND epoch=? AND state IN ('awaiting-approval','running') AND delivered_at IS NULL`).run(this.now(), rowId, this.epoch);
      if (r.changes === 1) return true;
      const row = this.db.prepare('SELECT state FROM tool_executions WHERE id=? AND epoch=?').get(rowId, this.epoch) as { state: string } | undefined;
      if (!row) throw new Error('执行记录不存在');
      return false;
    }));
  }

  /** 权限未放行：记原因；行在审批中时回到执行中（工具随后自己返回失败输出）。已落定的行改不动。 */
  approvalDenied(rowId: string, d: { reason: string; cause?: string; requestId?: string }): void {
    if (this.isClosed) return;
    this.tx(() => {
      this.db.prepare(`UPDATE tool_executions SET approval_state='denied', approval_reason=?, approval_cause=?,
        approval_request_id = COALESCE(approval_request_id, ?),
        state = CASE WHEN state='awaiting-approval' THEN 'running' ELSE state END, updated_at=?
        WHERE id=? AND epoch=? AND state IN ('awaiting-approval','running') AND delivered_at IS NULL`)
        .run(d.reason, d.cause ?? null, d.requestId ?? null, this.now(), rowId, this.epoch);
    });
  }

  private settleSql(): Database.Statement {
    // 审批还挂着就落定（取消赛跑先把 cancelled 交回了工具）：顺带把审批记成 denied / cancelled
    return this.db.prepare(`UPDATE tool_executions SET state=?, end_kind=?, started=?, result_success=?, result_output=?, result_offload_path=?, result_chars=?, settled_at=?, updated_at=?,
      approval_reason = CASE WHEN approval_state='pending' THEN 'cancelled' ELSE approval_reason END,
      approval_state = CASE WHEN approval_state='pending' THEN 'denied' ELSE approval_state END
      WHERE id=? AND epoch=? AND state IN ${OPEN_EXEC} AND delivered_at IS NULL`);
  }

  /** 落定：写终态与落库形态的结果。已落定、已交付的行改不动。 */
  settleExecution(rowId: string, s: ExecutionSettle): void {
    if (this.isClosed) return;
    this.tx(() => {
      const at = this.now();
      this.settleSql().run(s.state, s.endKind, s.started ? 1 : 0, s.success ? 1 : 0, s.output, s.offloadPath ?? null, s.chars, at, at, rowId, this.epoch);
    });
  }

  /**
   * 交付一批：还没落定的行按 fallback（按下标）补写；本批全部行记已交付并清空 result_output；run 的步骤回到 model。
   * 调用方把它与落结果消息放进同一个事务（atomic）。被标记的行数不等于本批调用数就抛 LeaseLostError（消息一并回滚）。
   */
  deliverBatch(runId: string, batch: number, resultMessageId: string, fallback: readonly (ExecutionSettle | undefined)[]): void {
    this.tx(() => {
      const at = this.now();
      const open = this.db.prepare(`SELECT id, call_index FROM tool_executions WHERE run_id=? AND batch=? AND epoch=? AND state IN ${OPEN_EXEC} AND delivered_at IS NULL`)
        .all(runId, batch, this.epoch) as { id: string; call_index: number }[];
      for (const row of open) {
        const s = fallback[row.call_index];
        if (s) this.settleSql().run(s.state, s.endKind, s.started ? 1 : 0, s.success ? 1 : 0, s.output, s.offloadPath ?? null, s.chars, at, at, row.id, this.epoch);
      }
      const r = this.db.prepare(`UPDATE tool_executions SET delivered_at=?, result_message_id=?, result_output=NULL, updated_at=?
        WHERE run_id=? AND batch=? AND epoch=? AND delivered_at IS NULL AND state IN ${TERMINAL_EXEC}`).run(at, resultMessageId, at, runId, batch, this.epoch);
      if (r.changes !== fallback.length) throw new LeaseLostError();
      this.db.prepare("UPDATE agent_runs SET step='model', updated_at=? WHERE id=? AND epoch=? AND active=1").run(at, runId, this.epoch);
    });
  }

  // ---------- 恢复用（agent/run-recovery.ts）。写的可能是前代的行，所以不带 epoch 条件；租约仍由 tx 校验 ----------

  /** 前代遗留的活动 run（active=1 且 epoch 小于本代），连同它那一代是怎么关的。账本已关停时是空数组。 */
  listOrphanRuns(): (RunView & { predecessorCloseKind?: string; predecessorHeartbeatAt?: number })[] {
    if (this.isClosed) return [];
    const rows = this.db.prepare(`SELECT r.*, e.close_kind AS p_close_kind, e.heartbeat_at AS p_heartbeat_at
      FROM agent_runs r LEFT JOIN engine_instances e ON e.epoch = r.epoch WHERE r.active = 1 AND r.epoch < ? ORDER BY r.created_at, r.id`)
      .all(this.epoch) as (RunRow & { p_close_kind: string | null; p_heartbeat_at: number | null })[];
    return rows.map(r => {
      const v: RunView & { predecessorCloseKind?: string; predecessorHeartbeatAt?: number } = toRunView(r);
      if (r.p_close_kind !== null) v.predecessorCloseKind = r.p_close_kind;
      if (r.p_heartbeat_at !== null) v.predecessorHeartbeatAt = r.p_heartbeat_at;
      return v;
    });
  }

  /** 没交付的批次，按 run、批号、下标。{ olderEpochs } = 前代留下的全部；{ runId } = 这个 run 的。账本已关停时是空数组。 */
  listOpenBatches(f: { runId: string } | { olderEpochs: true }): OpenBatch[] {
    if (this.isClosed) return [];
    const rows = ('runId' in f
      ? this.db.prepare('SELECT * FROM tool_executions WHERE delivered_at IS NULL AND run_id=? ORDER BY run_id, batch, call_index').all(f.runId)
      : this.db.prepare('SELECT * FROM tool_executions WHERE delivered_at IS NULL AND epoch < ? ORDER BY run_id, batch, call_index').all(this.epoch)) as ExecRow[];
    const out: OpenBatch[] = [];
    for (const r of rows) {
      let b = out[out.length - 1];
      if (!b || b.runId !== r.run_id || b.batch !== r.batch) {
        b = { runId: r.run_id, sessionId: r.session_id, batch: r.batch, assistantMessageId: r.assistant_message_id, rows: [] };
        out.push(b);
      }
      const row: OpenRow = toExecView(r);
      if (r.result_output !== null) row.resultOutput = r.result_output;
      b.rows.push(row);
    }
    return out;
  }

  /** 恢复判定的终态。审批过期的同时把审批记成 expired / engine-restarted。已落定的行改不动。 */
  resolveOrphan(rowId: string, t: { state: 'cancelled' | 'unknown'; endKind: ToolEndKind }): void {
    this.tx(() => {
      const at = this.now();
      const expired = t.endKind === 'approval-expired' ? 1 : 0;
      this.db.prepare(`UPDATE tool_executions SET state=?, end_kind=?, settled_at=?, updated_at=?,
        approval_state = CASE WHEN ?=1 THEN 'expired' ELSE approval_state END,
        approval_reason = CASE WHEN ?=1 THEN 'invalidated' ELSE approval_reason END,
        approval_cause = CASE WHEN ?=1 THEN 'engine-restarted' ELSE approval_cause END
        WHERE id=? AND state IN ${OPEN_EXEC} AND delivered_at IS NULL`).run(t.state, t.endKind, at, at, expired, expired, expired, rowId);
    });
  }

  /** 关账：记已交付。补了结果消息的清空 result_output；没补的（resultMessageId 为 null）留在行里备查。 */
  closeRows(rowIds: readonly string[], resultMessageId: string | null): void {
    this.tx(() => {
      const at = this.now();
      const withMsg = this.db.prepare('UPDATE tool_executions SET delivered_at=?, result_message_id=?, result_output=NULL, updated_at=? WHERE id=? AND delivered_at IS NULL');
      const noMsg = this.db.prepare('UPDATE tool_executions SET delivered_at=?, updated_at=? WHERE id=? AND delivered_at IS NULL');
      for (const id of rowIds) {
        if (resultMessageId !== null) withMsg.run(at, resultMessageId, at, id); else noMsg.run(at, at, id);
      }
    });
  }

  /** 把前代的活动 run 记为 interrupted（只由后一代的恢复调）。从未落过 user 消息的同样不占 promptId。 */
  interruptRun(runId: string, i: { reason: 'engine-crash' | 'shutdown-timeout'; detail: string }): void {
    this.tx(() => {
      const at = this.now();
      this.db.prepare(`UPDATE agent_runs SET state='interrupted', active=NULL, step='finished', stop_reason=?, stop_detail=?, recovered_epoch=?, ended_at=?, updated_at=?,
        prompt_id = CASE WHEN user_message_id IS NULL THEN NULL ELSE prompt_id END WHERE id=? AND active=1`)
        .run(i.reason, i.detail.slice(0, STOP_DETAIL_MAX), this.epoch, at, at, runId);
    });
  }
}
