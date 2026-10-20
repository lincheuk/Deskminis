/**
 * F05：运行记录器——循环与调度器看到的那一面账本。每个 run 一个；循环是顺序的，同一时刻只有一批调用。
 *
 * 四个提交点（状态先提交，事件后发布）：
 *  - persistAssistant：assistant 消息与整批「待执行」行同一个事务。落不下 → 循环终止，一个工具都没执行。
 *  - journal.begin：执行意图（待执行 → 执行中）。落不下 → 调度器不调 execute。
 *  - journal.settled：调用落定时（放锁之前）提交终态与落库形态的结果。同批里已经做完的结果不再只在内存里。
 *  - persistResults：结果消息与「已交付」同一个事务。落不下 → 消息一并回滚，由 run 收尾或下次启动的恢复补。
 *
 * 权限接缝（journal.permissions）套在真实网关之外、取消赛跑层之内：只在真的弹了卡时写「审批中」；
 * 弹过卡的放行是持久提交点，写不成就改成拒绝，并把这张卡带来的授权（本会话允许、桥合并授权）一并收回。
 * 它从不自己放行，只可能把放行改成拒绝。
 * 依赖的既有保证：有副作用的工具在权限询问返回之前不产生副作用——据此，停在首次审批上的调用崩溃后记为未执行。
 */
import { denied, type PermissionOutcome } from '../../shared/permission';
import { terminalOf, type RunRef, type ToolEndKind } from '../../shared/run';
import type { ExecutionSettle, RunLedger } from '../store/run-ledger';
import { decidePermission, reportDenied } from '../tools/permission-outcome';
import type { CallJournal, CallRef, ScheduledCall, ScheduledResult } from '../tools/scheduler';
import type { PermissionAskOptions, PermissionGateway, PermissionRequest } from '../tools/types';
import type { OffloadEngine } from './offload';
import { finalizeToolOutput, type FinalizedOutput } from './tool-output';

export interface SettledCall { output: FinalizedOutput; state: 'completed' | 'failed' | 'cancelled'; endKind: ToolEndKind }

/** 循环看到的那一面。 */
export interface RunRecorder {
  readonly journal: CallJournal;
  /** 原子地落 assistant 消息与本批调用的待执行记录。 */
  persistAssistant<T extends { id: string }>(calls: readonly ScheduledCall[], append: () => T): T;
  /** 第 index 个调用落定时算好的落库形态与终态；没有返回 undefined。 */
  settledOf(index: number): SettledCall | undefined;
  /** 原子地落结果消息并把本批标为已交付。账本里还没落定的行按 results 补齐。批次已不归本代次时抛（消息一并回滚）。 */
  persistResults<T extends { id: string }>(results: readonly ScheduledResult[], append: () => T): T;
}

/** 卸载文件写不进去时改存的前缀长度。 */
const FALLBACK_OUTPUT_MAX = 20_000;

/** 截到 max 个码元，不切断代理对。 */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

interface Batch {
  no: number; rowIds: string[]; calls: readonly ScheduledCall[];
  settled: (SettledCall | undefined)[]; rows: (ExecutionSettle | undefined)[];
}

export function createRunRecorder(
  ledger: RunLedger, run: RunRef,
  deps: { signal: AbortSignal; offload?: OffloadEngine; warn?: (msg: string, e?: unknown) => void },
): RunRecorder {
  const warn = deps.warn ?? ((msg: string, e?: unknown): void => { console.warn(msg, e); });
  let batch: Batch | undefined;

  const rowOf = (at: CallRef): string => {
    const id = batch?.rowIds[at.index];
    if (id === undefined) throw new Error('这次调用没有执行记录');
    return id;
  };

  const journal: CallJournal = {
    begin(at, plan) {
      const id = rowOf(at);
      ledger.beginExecution(id, plan);
      // F08：交回执行身份，调度器写进 ToolContext.call（写前检查点据此关联 run 与这次工具执行）
      return { runId: run.runId, executionId: id };
    },

    permissions(at, inner): PermissionGateway {
      const rowId = rowOf(at);
      /** 本次调用此前已拿到的放行次数（免审的放行不落账，只在这里计数）。发卡时记进行里：
       *  先免审放行、动了手、再弹卡时崩溃的调用，不能被判成「未执行」。 */
      let allows = 0;
      const decide = async (req: PermissionRequest, opts?: PermissionAskOptions): Promise<PermissionOutcome> => {
        let issued = false;
        const o = await decidePermission(inner, req, {
          ...opts,
          onIssued: id => {
            issued = true;
            // 只记一笔：写不成时行停在「执行中」，此刻中断会按结果未知处理（偏安全）
            try { ledger.approvalIssued(rowId, { requestId: id, kind: req.kind, priorAllows: allows }); }
            catch (e) { warn('审批中状态写入失败（这次调用若此刻中断，会按结果未知处理）:', e); }
            opts?.onIssued?.(id);
          },
        });
        if (o.decision === 'allow') {
          if (issued) {
            try {
              // false = 这一行已经落定（取消先到、工具已返回）：没有东西要记，原样交回，由取消赛跑层照旧记「批准了却没执行」
              if (!ledger.approvalAllowed(rowId)) return o;
            } catch (e) {
              warn('权限放行没能落进执行账本，这次调用不放行:', e);
              const d = denied('invalidated', 'record-failed', o.requestId !== undefined ? { requestId: o.requestId } : undefined);
              // 这张卡带来的授权一并收回：「本会话允许」在网关交回放行之前就记下了会话授权（shell 卡还带出桥合并授权）。
              // 不收回的话，回给模型的是「这次批准已失效……会重新询问」，同样的请求下一次却不弹卡直接放行
              try { inner.revokeGrant?.(req, o); }
              catch (e2) { warn('收回这次批准带来的授权失败（这次调用照样不放行）:', e2); }
              reportDenied(inner, req, d, { toolUseId: at.toolUseId });
              // 尽力把「没放行、为什么」也记进行里（库此刻多半写不成，写不成就算了：行停在审批中，落定时会记成未放行）
              try { ledger.approvalDenied(rowId, { reason: d.reason, cause: d.cause, requestId: d.requestId }); } catch { /* 见上 */ }
              return d;
            }
          }
          allows += 1;
          return o;
        }
        try { ledger.approvalDenied(rowId, { reason: o.reason, cause: o.cause, requestId: o.requestId }); }
        catch (e) { warn('权限未放行的记录写入失败（拒绝本身不受影响）:', e); }
        return o;
      };
      return {
        decide,
        async check(req) { return (await decide(req)).decision; },
        noteDenied: (r, d, o) => inner.noteDenied?.(r, d, o),
        hasBridgeGrant: s => inner.hasBridgeGrant(s),
        isPlanMode: () => inner.isPlanMode?.() === true,
      };
    },

    settled(at, r) {
      const b = batch;
      if (!b || b.rowIds[at.index] === undefined) return;
      const t = terminalOf({ end: r.end, started: r.started, success: r.outcome.success }, deps.signal.aborted);
      let fin: FinalizedOutput;
      try {
        fin = finalizeToolOutput(deps.offload, run.sessionId, b.calls[at.index], r.outcome);
      } catch (e) {
        // 卸载文件写不进去：不让一次磁盘错误丢掉整个结果
        warn('工具输出卸载失败，改存截断后的前一部分:', e);
        fin = { outputToStore: clip(r.outcome.output, FALLBACK_OUTPUT_MAX) + '\n[输出过长，卸载文件写入失败，后面的部分没有保存]' };
      }
      const row: ExecutionSettle = {
        state: t.state, endKind: t.endKind, started: r.started, success: r.outcome.success,
        output: fin.outputToStore, offloadPath: fin.offloadedPath, chars: r.outcome.output.length,
      };
      // 先记进内存、再写库：库写失败时（抛错被调度器吞掉）persistResults 还能按它补写
      b.settled[at.index] = { output: fin, state: t.state, endKind: t.endKind };
      b.rows[at.index] = row;
      ledger.settleExecution(b.rowIds[at.index], row);
    },
  };

  return {
    journal,

    persistAssistant(calls, append) {
      return ledger.atomic(() => {
        const m = append();
        // 账本已关停（有序关停之后晚到的写入）：只落消息，不记账
        if (ledger.closed) { batch = undefined; return m; }
        const opened = ledger.openBatch(run.runId, m.id, calls);
        batch = { no: opened.batch, rowIds: opened.rowIds, calls, settled: new Array(calls.length), rows: new Array(calls.length) };
        return m;
      });
    },

    settledOf(index) {
      return batch?.settled[index];
    },

    persistResults(results, append) {
      const b = batch;
      return ledger.atomic(() => {
        const m = append();
        if (ledger.closed || !b) return m;
        // 账本里还没落定的行（落定时的写入失败过）按内存里的终态补写；连内存里都没有的按结果现算。
        // 这一笔里 result_output 随即被清空（结果已在消息里），所以现算的不必带输出正文
        const fallback = results.map((r, i): ExecutionSettle => {
          const kept = b.rows[i];
          if (kept) return kept;
          const t = terminalOf({ end: r.end, started: r.started, success: r.outcome.success }, deps.signal.aborted);
          return { state: t.state, endKind: t.endKind, started: r.started, success: r.outcome.success, output: '', chars: r.outcome.output.length };
        });
        ledger.deliverBatch(run.runId, b.no, m.id, fallback);
        return m;
      });
    },
  };
}
