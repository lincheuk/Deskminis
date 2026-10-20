/**
 * F05：工具输出的落库形态——从循环的结果段原样搬出（逻辑不变），循环与运行记录器共用这一份。
 *
 * 为什么要搬出来：结果现在在调用落定时就提交进账本（放锁之前），而不是等整批结束；恢复补写的结果
 * 必须与正常落库是同一个字符串。两处各写一份迟早会漂移。
 */
import type { ToolOutcome } from '../tools/types';
import type { OffloadEngine } from './offload';

export interface FinalizedOutput { outputToStore: string; offloadedPath?: string }

/**
 * 读回本会话卸载文件 → 按 READBACK_MAX 封顶；否则超过阈值 → 卸载并换成桩；否则原样。
 *  - 读回本会话的卸载文件（W2a-5）不再二次卸载——否则模型照桩去读只拿到下一个桩，内容永远取不回；
 *    只认读成功的：失败时 output 是错误信息，不是文件内容。分段读回（带 offset/limit）同样认得出，readRange 让封顶按文件坐标给下一段。
 *  - 卸载会写文件：同一个调用只该算一次，调用方（循环 / 记录器）各自保证不重复调。
 */
export function finalizeToolOutput(
  offload: OffloadEngine | undefined, sessionId: string,
  call: { toolUseId: string; name: string; input: string }, outcome: ToolOutcome,
): FinalizedOutput {
  const readBack = outcome.success ? offload?.readBackOf(sessionId, call.name, call.input) : undefined;
  if (offload && readBack) return { outputToStore: offload.clampReadBack(outcome.output, outcome.readRange) };
  if (offload && offload.shouldOffload(outcome.output)) {
    const { stub, relativePath } = offload.offload(sessionId, call.toolUseId, outcome.output);
    return { outputToStore: stub, offloadedPath: relativePath };
  }
  return { outputToStore: outcome.output };
}

/** W1：仅在既有出口消毒后的请求边界包裹。不再截断或转义；只拆开可能提前闭合的固定结束标签。 */
export function wrapToolOutput(output: string): string {
  return `<tool-output>\n${output.replaceAll('</tool-output>', '</tool-\u200Boutput>')}\n</tool-output>`;
}
