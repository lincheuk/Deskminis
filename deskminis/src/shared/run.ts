/**
 * F05：运行（run）与工具执行账本——引擎与渲染端共用的线上契约。
 *
 * 纯类型、常量与纯函数，没有任何 import（与 shared/runtime-model.ts、shared/permission.ts 同一做法）。
 *
 * 以前 run 的占位、控制器、收尾 promise 都只在内存里：引擎一停，哪个会话上次在跑、为什么停、
 * 那一批工具各自执行到了哪一步，全都查不到。这里把它们定成可持久的状态：
 *  - run：一次 chat.prompt 起的一轮循环。epoch 是拥有它的引擎代次（租约），generation 是这个会话的第几次运行。
 *  - 工具执行：assistant 消息里的每个 toolUse 一行，七种状态。
 *
 * 数据库提交与外部副作用之间无法普遍原子化：账本保证的是「意图已落账的调用，引擎至多调用一次 execute」，
 * 结果没提交就中断的记为 unknown——不宣称任何外部操作恰好执行一次，没有任何工具带幂等协议。
 */

export const RUN_STATES = ['starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type RunState = (typeof RUN_STATES)[number];
/** starting：run 行已建、user 消息还没落（连 MCP 那一段）。interrupted：只由后一代引擎的恢复写。 */
export const RUN_TERMINAL_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled', 'interrupted'];
export type RunStep = 'starting' | 'model' | 'tools' | 'finished';
/** ref = 定时任务 id。来源只有进程内调用给得了（RPC 够不着），远端客户端无法把自己的 prompt 标成定时任务。 */
export type RunOrigin = { kind: 'user' } | { kind: 'cron'; ref: string };

/** epoch：拥有这个 run 的引擎代次（租约）。generation：这个会话的第几次运行，从 1 起。 */
export interface RunRef { runId: string; sessionId: string; generation: number; epoch: number }
export interface RunView extends RunRef {
  state: RunState; step: RunStep; toolBatches: number;
  origin: RunOrigin; promptId?: string;
  /** 这次提交落库的 user 消息。没有 = 起跑前就结束了，历史里没有这条 prompt。 */
  userMessageId?: string;
  /** completed：provider 的 stopReason。failed：'error' | 'start-failed' | 'finalize-failed' | 循环 error 事件的 code。
   *  cancelled：'user-stop' | 'session-deleted' | 'shutdown'。interrupted：'engine-crash' | 'shutdown-timeout'。 */
  stopReason?: string; stopDetail?: string;
  /** 由哪一代引擎的恢复收尾的；正常收尾的没有。 */
  recoveredEpoch?: number;
  createdAt: number; updatedAt: number; endedAt?: number;
}

/** 待执行 / 审批中 / 执行中 / 已完成 / 失败 / 取消 / 结果未知 */
export const TOOL_EXEC_STATES = ['pending', 'awaiting-approval', 'running', 'completed', 'failed', 'cancelled', 'unknown'] as const;
export type ToolExecState = (typeof TOOL_EXEC_STATES)[number];
export const TOOL_EXEC_TERMINAL_STATES: readonly ToolExecState[] = ['completed', 'failed', 'cancelled', 'unknown'];
/** 前四个 = 调度器的 CallEnd（'completed' 只表示 execute 返回了，成败看 state）；
 *  cancelled-during-run：已启动、因取消收尾；后四个只由恢复写。 */
export type ToolEndKind =
  | 'completed' | 'refused' | 'cancelled-before-start' | 'lock-timeout'
  | 'cancelled-during-run'
  | 'not-started' | 'approval-expired' | 'interrupted-readonly' | 'effect-unknown';
export type ApprovalState = 'pending' | 'allowed' | 'denied' | 'expired';

export interface ToolExecutionView {
  id: string; runId: string; sessionId: string; epoch: number;
  batch: number; index: number; toolUseId: string; name: string; assistantMessageId: string;
  state: ToolExecState; endKind?: ToolEndKind;
  /** execute 是否被调用过（意图已落账）。false = 保证没有副作用。 */
  started: boolean;
  barrier?: boolean; readOnly?: boolean; sideEffects?: 'none' | 'local-files' | 'network' | 'unknown';
  /** requestId：弹过卡才有，就是那张权限卡的 id。priorAllows：发卡时本次调用此前已拿到过几次放行。 */
  approval?: { state: ApprovalState; requestId?: string; kind?: string; reason?: string; cause?: string; priorAllows: number };
  success?: boolean;
  /** 结果是否已进历史；resultMessageId 是它所在的消息。delivered 而没有 resultMessageId = 结果没有进历史
   *  （那条 assistant 后面已有别的消息，恢复只关账、不补消息）。 */
  delivered: boolean; resultMessageId?: string;
  /** 产出物：声明的写入目标（宿主路径）与卸载文件（会话相对路径）。 */
  artifacts: { writePaths: string[]; offloadPath?: string };
  createdAt: number; startedAt?: number; settledAt?: number; updatedAt: number;
}

export interface RunSnapshotQuery { sessionId?: string; runId?: string }
/** 只读快照。不带工具入参与输出正文。 */
export interface RunSnapshot { epoch: number; instanceId: string; heartbeatAt: number; takenAt: number; runs: RunView[]; executions: ToolExecutionView[] }
/** chat.event 广播（run 事件）里的 run 字段。 */
export interface RunEventMeta { id: string; generation: number; epoch: number }

export const PROMPT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** 不带 promptId 的调用拿到的仍是 { ok: true }。duplicate：这个 promptId 已经提交过，没有起新的 run。
 *  duplicate 为真时 state 不会是 starting：原 run 还没落 user 消息（连 MCP 那一段）时，重复提交等到它的起跑结果才应答——
 *  落了 user 消息答 duplicate；起跑前失败或被取消，重复提交方收到与原提交方相同的错误（这条消息没有被接收，同一个 id 可以再提交）。 */
export type ChatPromptResult =
  | { ok: true }
  | { ok: true; runId: string; generation: number; duplicate: boolean; state: RunState; stopReason?: string };

/** 实时路径的终态。aborted：落定那一刻 run 的取消信号是否已触发。
 *  execute 返回了失败而此刻已取消 → 记取消（工具自己收口的输出照留）；没取消 → 失败。 */
export function terminalOf(
  r: { end: 'completed' | 'refused' | 'cancelled-before-start' | 'lock-timeout'; started: boolean; success: boolean },
  aborted: boolean,
): { state: 'completed' | 'failed' | 'cancelled'; endKind: ToolEndKind } {
  if (r.end === 'cancelled-before-start') return { state: 'cancelled', endKind: 'cancelled-before-start' };
  if (r.end === 'lock-timeout') return { state: 'failed', endKind: 'lock-timeout' };
  if (r.end === 'refused') return { state: 'failed', endKind: 'refused' };
  if (r.success) return { state: 'completed', endKind: 'completed' };
  return aborted ? { state: 'cancelled', endKind: 'cancelled-during-run' } : { state: 'failed', endKind: 'completed' };
}

/** 落库 toolResult.status：completed → success，failed → failed，cancelled → cancelled，unknown → unknown。
 *  非终态不该走到这里；万一走到，按 unknown（不把没有结论的调用说成成功或失败）。 */
export function toolResultStatusOf(state: ToolExecState): 'success' | 'failed' | 'cancelled' | 'unknown' {
  if (state === 'completed') return 'success';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  return 'unknown';
}
