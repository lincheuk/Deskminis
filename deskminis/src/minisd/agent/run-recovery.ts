/**
 * F05：恢复——把没交付的工具批次收口，把前代引擎遗留的活动 run 记为中断。
 *
 * 硬规则：
 *  1. 恢复阶段绝不执行任何工具，也不自动续跑任何 run、不补跑定时任务。这个文件不引工具注册表、调度器、任何具体工具与 MCP
 *    （源码守卫钉着）——引不到执行入口，就不可能重放。
 *  2. recoverOnBoot 与 settleOpenBatches 从不抛。启动恢复在装配里、监听端口之前同步执行：它抛错等于引擎起不来，
 *     而触发它的那行数据每次启动都还在，应用就再也打不开。所以每个查询、每一批的事务、每个 run 的收口、
 *     定时任务的每一步、每条审计各自兜住，失败只告警并记进 failed，后面的照做。
 *  3. 不把任何「执行中 / 审批中」的行写成已完成；unknown 只由这里写。
 *
 * 数据库提交与副作用不原子：「启动之后」与「副作用之后、结果提交之前」在盘上是同一个样子，恢复无从分辨，
 * 一律按「可能已经发生」处理（只读且无副作用的除外）。判定集中在 classifyOrphan 这一个纯函数里；
 * 以后给可证明幂等的工具定专用恢复协议，只改这一处。
 */
import { denied } from '../../shared/permission';
import { toolResultStatusOf, type RunView, type ToolEndKind, type ToolExecState } from '../../shared/run';
import type { ContentPart } from '../../shared/types';
import type { ChatStore } from '../store/chat-store';
import type { CronStore } from '../cron/store';
import type { OpenBatch, RunLedger } from '../store/run-ledger';

type OrphanEndKind = 'not-started' | 'approval-expired' | 'interrupted-readonly' | 'effect-unknown';

/**
 * 崩溃后的分类表，按序匹配第一条。纯函数；已是终态返回 undefined。唯一的判定点。
 *  - 待执行：没开始 → 取消 / 未执行。
 *  - 审批中、且发卡时本次调用此前没有拿到过任何放行：权限询问返回之前工具不产生副作用 → 取消 / 审批过期。
 *  - 执行中，或审批中但此前已拿到过放行（先免审放行、可能动了手、再弹卡）：
 *      只读且无副作用 → 取消 / 只读调用被打断（可以重做）；其余（含计划为空）→ 结果未知。
 */
export function classifyOrphan(x: { state: ToolExecState; priorAllows: number; readOnly?: boolean; sideEffects?: string }):
  { state: 'cancelled' | 'unknown'; endKind: OrphanEndKind } | undefined {
  if (x.state === 'pending') return { state: 'cancelled', endKind: 'not-started' };
  if (x.state === 'awaiting-approval' && x.priorAllows === 0) return { state: 'cancelled', endKind: 'approval-expired' };
  if (x.state === 'running' || x.state === 'awaiting-approval') {
    if (x.readOnly === true && x.sideEffects === 'none') return { state: 'cancelled', endKind: 'interrupted-readonly' };
    return { state: 'unknown', endKind: 'effect-unknown' };
  }
  return undefined;
}

/** 写给模型的话，按 endKind 取。措辞对「引擎重启」与「同进程收尾」都成立。 */
export const ORPHAN_TEXT: Record<OrphanEndKind, string> = {
  'not-started': '[未执行] 这次调用还没有开始，运行就中断了；没有产生任何改动。需要的话可以重新调用。',
  'approval-expired': '[未执行] 这次调用在等待权限批准时运行中断，权限请求已作废：没有批准，也没有执行。需要的话请重新发起，届时会重新询问。',
  'interrupted-readonly': '[未完成] 这次只读调用还没有返回结果，运行就中断了；它不改动任何东西，可以重新调用。',
  'effect-unknown': '[结果未知] 这次调用已经开始执行，运行在保存结果之前中断了。它可能已经完成、只做了一部分，或者没有生效；没有自动重试。'
    + '继续之前请先核实实际状态（查看相关文件、命令的效果或外部系统），不要直接重复执行有副作用的操作。',
};
const isOrphanEnd = (k: ToolEndKind | undefined): k is OrphanEndKind =>
  k === 'not-started' || k === 'approval-expired' || k === 'interrupted-readonly' || k === 'effect-unknown';

export interface RecoveryDeps {
  ledger: RunLedger;
  chat: Pick<ChatStore, 'getSession' | 'lastMessageRef' | 'appendMessage' | 'newId' | 'nowEpoch'>;
  cron?: Pick<CronStore, 'list' | 'markDone'>;
  /** 可能抛（库写失败）。每次调用都兜住。 */
  audit?(eventType: string, payload: unknown, opts: { sessionId?: string }): void;
  warn?(msg: string, e?: unknown): void;
  /** F08：结果未知的调用，按文件检查点给出的事实（每个目标文件一句）。只读库；不执行工具、不改任何文件。抛错被兜住。
   *  epoch 是那条执行行的代次：早于检查点启用代次的行不给事实（那时的引擎是原地写入，没有记录不代表没有改动）。
   *  以函数形式注入：这个文件不引检查点模块。 */
  effectEvidence?(row: { id: string; name: string; epoch: number }): string[] | undefined;
  /** F09：对「结果未知」的调用补一句它所在进程树的去向（进程账本的只读查询）。返回 undefined = 没有依据，不加话。
   *  executionId 是 tool_executions.id。可能抛，调用处兜住。 */
  processNote?(x: { executionId: string; sessionId: string; name: string; epoch: number }): string | undefined;
}
export interface BatchReport {
  runId: string; sessionId: string; batch: number; assistantMessageId: string; resultMessageId?: string;
  counts: Record<'completed' | 'failed' | 'cancelled' | 'unknown', number>;
  /** 那条 assistant 后面已有别的消息（或会话、消息已不在）：没有补结果消息，只关了账。 */
  superseded: boolean;
  expiredRequestIds: string[];
}
export interface RecoveryReport {
  epoch: number; runs: RunView[]; batches: BatchReport[]; cronJobs: string[];
  /** 补写了结果消息的会话（同步协调器启动之后要对它们各标一次脏）。 */
  sessions: string[];
  failed: { what: string; error: string }[];
}

const warnOf = (deps: RecoveryDeps) => deps.warn ?? ((msg: string, e?: unknown): void => { console.warn(msg, e); });

/** 收口一批（在一个事务里调）。不调用任何工具：没落定的行只按分类表写终态。 */
function settleBatch(deps: RecoveryDeps, b: OpenBatch): { report: BatchReport; expired: { requestId: string; toolUseId: string }[] } {
  const counts = { completed: 0, failed: 0, cancelled: 0, unknown: 0 };
  const expired: { requestId: string; toolUseId: string }[] = [];
  const parts: ContentPart[] = [];
  for (const row of b.rows) {
    const t = classifyOrphan({ state: row.state, priorAllows: row.approval?.priorAllows ?? 0, readOnly: row.readOnly, sideEffects: row.sideEffects });
    let state: ToolExecState = row.state;
    let output: string;
    let success = false;
    if (t) {
      deps.ledger.resolveOrphan(row.id, t);
      state = t.state;
      output = ORPHAN_TEXT[t.endKind];
      if (t.endKind === 'effect-unknown') {
        // F08：文件类调用按检查点补上事实。账本终态仍是 unknown——这里只多说几句库里确实知道的事
        let facts: string[] | undefined;
        try { facts = deps.effectEvidence?.({ id: row.id, name: row.name, epoch: row.epoch }); } catch { facts = undefined; }
        if (facts && facts.length > 0) output += `\n按文件检查点核实：\n${facts.join('\n')}`;
        // F09：追加进程账本中的去向；与 F08 的文件事实并存，均只读查询。
        let note: string | undefined;
        try { note = deps.processNote?.({ executionId: row.id, sessionId: b.sessionId, name: row.name, epoch: row.epoch }); } catch { note = undefined; }
        if (typeof note === 'string' && note !== '') output += '\n' + note;
      }
      if (t.endKind === 'approval-expired' && row.approval?.requestId !== undefined) expired.push({ requestId: row.approval.requestId, toolUseId: row.toolUseId });
    } else {
      // 结果已提交、只差交付：交付真实结果，终态不变
      output = row.resultOutput ?? (isOrphanEnd(row.endKind) ? ORPHAN_TEXT[row.endKind] : '');
      success = row.success ?? false;
    }
    if (state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'unknown') counts[state] += 1;
    parts.push({ type: 'toolResult', value: { toolUseId: row.toolUseId, output, success, status: toolResultStatusOf(state) } });
  }
  const ids = b.rows.map(r => r.id);
  const report: BatchReport = {
    runId: b.runId, sessionId: b.sessionId, batch: b.batch, assistantMessageId: b.assistantMessageId,
    counts, superseded: false, expiredRequestIds: expired.map(x => x.requestId),
  };
  // 只在那条 assistant 仍是会话最后一条时补结果消息：补写那一刻它紧跟对应的 assistant。
  // 后面已有别的消息时不往历史中间插（按时间游标增量同步的对端会拉不到它，也违背「历史只追加」），只关账；
  // 请求侧由 pairToolResults 给那一批补占位。
  const last = deps.chat.getSession(b.sessionId) ? deps.chat.lastMessageRef(b.sessionId) : undefined;
  if (last !== undefined && last.id === b.assistantMessageId) {
    // 时间是此刻（不回填成 assistant 之后一毫秒：同步游标取的是最大 created_at，回填的消息对端按游标拉不到）
    const msg = deps.chat.appendMessage({
      id: deps.chat.newId(), sessionId: b.sessionId, role: 'user', parts,
      createdAt: Math.max(deps.chat.nowEpoch(), last.createdAt + 0.001), streamInterruptCount: 0,
    });
    deps.ledger.closeRows(ids, msg.id);
    report.resultMessageId = msg.id;
  } else {
    deps.ledger.closeRows(ids, null);
    report.superseded = true;
  }
  return { report, expired };
}

/**
 * 把没交付的批次收口（启动恢复与 run 收尾共用）。逐批处理，每批一个事务。从不调用任何工具。账本已关停时返回空数组。
 * 从不抛：列表查询失败、某一批的事务失败都只告警并记进 failed（传了的话），其余批照做；失败的那批原样留着，下次启动再试。
 */
export function settleOpenBatches(
  deps: RecoveryDeps, filter: { runId: string } | { olderEpochs: true }, failed?: { what: string; error: string }[],
): BatchReport[] {
  const warn = warnOf(deps);
  const note = (what: string, e: unknown): void => {
    try { warn(`恢复：${what}失败（留到下次启动再试）:`, e); } catch { /* 告警本身不该再抛 */ }
    failed?.push({ what, error: String(e) });
  };
  const reports: BatchReport[] = [];
  let batches: OpenBatch[];
  try { batches = deps.ledger.listOpenBatches(filter); }
  catch (e) { note('列出未交付的工具批次', e); return reports; }
  for (const b of batches) {
    let done: ReturnType<typeof settleBatch>;
    try { done = deps.ledger.atomic(() => settleBatch(deps, b)); }
    catch (e) { note(`收口工具批次 ${b.runId}#${b.batch}`, e); continue; }
    reports.push(done.report);
    // 事务提交之后：审批过期的卡各补一条终态审计（卡片挂着时引擎停了，审计里只有 permission.request）
    for (const x of done.expired) {
      try {
        deps.audit?.('permission.resolved', {
          requestId: x.requestId, reason: 'invalidated',
          outcome: denied('invalidated', 'engine-restarted', { requestId: x.requestId }), toolUseId: x.toolUseId,
        }, { sessionId: b.sessionId });
      } catch (e) {
        try { warn('恢复：过期权限请求的审计写入失败（终态已在账本里）:', e); } catch { /* 同上 */ }
      }
    }
  }
  return reports;
}

/**
 * 启动恢复：收口前代留下的批次 → 前代的活动 run 记为 interrupted → 收口定时任务状态。同步。
 * 从不抛：三步各自兜住，哪一步失败都记进 report.failed 并告警，后面的步骤照做，照常返回。
 * 没收掉的活动行不会一直占着会话：该会话下次起跑时由 RunLedger.beginRun 收掉。
 */
export function recoverOnBoot(deps: RecoveryDeps): RecoveryReport {
  const report: RecoveryReport = { epoch: 0, runs: [], batches: [], cronJobs: [], sessions: [], failed: [] };
  const warn = warnOf(deps);
  const note = (what: string, e: unknown): void => {
    try { warn(`恢复：${what}失败:`, e); } catch { /* 告警本身不该再抛 */ }
    report.failed.push({ what, error: String(e) });
  };
  try {
    report.epoch = deps.ledger.epoch;
    // 1. 没交付的批次（它自己不抛）
    report.batches = settleOpenBatches(deps, { olderEpochs: true }, report.failed);
    report.sessions = [...new Set(report.batches.filter(b => b.resultMessageId !== undefined).map(b => b.sessionId))];

    // 2. 前代的活动 run。第 1 步失败不影响这一步：会话不能因为恢复失败而一直被活动索引占着
    let orphans: ReturnType<RunLedger['listOrphanRuns']> = [];
    try { orphans = deps.ledger.listOrphanRuns(); } catch (e) { note('列出被中断的运行', e); }
    for (const r of orphans) {
      // 前代有序关停过（close_kind = shutdown）而 run 还活动着 = 关停时限内没停下；否则是崩溃或被强杀
      const reason = r.predecessorCloseKind === 'shutdown' ? 'shutdown-timeout' : 'engine-crash';
      const detail = reason === 'shutdown-timeout'
        ? `引擎关停时这次运行没有在时限内停下（第 ${r.epoch} 代），由第 ${deps.ledger.epoch} 代启动时收口`
        : `引擎在这次运行进行中停止（第 ${r.epoch} 代${r.predecessorHeartbeatAt !== undefined ? `，最后心跳 ${new Date(r.predecessorHeartbeatAt * 1000).toISOString()}` : ''}），由第 ${deps.ledger.epoch} 代启动时收口`;
      try {
        deps.ledger.interruptRun(r.runId, { reason, detail });
        report.runs.push(deps.ledger.getRun(r.runId) ?? r);
      } catch (e) { note(`收口运行 ${r.runId}`, e); continue; }
      try {
        const mine = report.batches.filter(b => b.runId === r.runId);
        const counts = { completed: 0, failed: 0, cancelled: 0, unknown: 0 };
        for (const b of mine) { counts.completed += b.counts.completed; counts.failed += b.counts.failed; counts.cancelled += b.counts.cancelled; counts.unknown += b.counts.unknown; }
        deps.audit?.('run.recovered', {
          runId: r.runId, generation: r.generation, from: r.state, stopReason: reason, counts, superseded: mine.some(b => b.superseded),
        }, { sessionId: r.sessionId });
      } catch (e) {
        try { warn('恢复：run.recovered 审计写入失败（终态已在账本里）:', e); } catch { /* 同上 */ }
      }
    }

    // 3. 定时任务：启动这一刻没有任何 run 在跑，停在 running 的状态一定是陈旧的（完成钩子在内存里，随前代没了）。
    //    不按 run 行关联，旧库里的也一并收口。不补跑：once 在触发时已停用，interval / cron 的下一次已从触发时刻重算
    if (deps.cron) {
      let jobs: ReturnType<CronStore['list']> = [];
      try { jobs = deps.cron.list(); } catch (e) { note('列出定时任务', e); }
      for (const j of jobs) {
        if (!/^running(（|$)/.test(j.lastStatus)) continue;
        try {
          deps.cron.markDone(j.id, 'error: 运行被中断（应用退出或重启），没有自动重跑');
          report.cronJobs.push(j.id);
        } catch (e) { note(`收口定时任务 ${j.id}`, e); }
      }
    }
  } catch (e) {
    // 兜底：上面每一步都各自兜住了，这里只接没想到的
    note('启动恢复', e);
  }
  return report;
}
