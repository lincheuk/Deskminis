/** W2b-11a：工具步骤的状态（纯函数，单测见 tests/renderer-step-status.test.ts）。
 *
 *  为什么需要：StageChat 给历史里的工具步骤定状态，以前写的是 `ok: r ? r.ok : true`——配不到 toolResult 的一步一律画成成功。
 *  loop.ts 要等一批工具全部跑完才落结果那条消息，minisd 崩溃、被强杀、退出时来不及收尾，那几步在库里就只剩 toolUse；
 *  模型那一侧 pairToolResults 早就给它们补了「[工具执行被中断，结果未知]」，只有界面还说它们成功了
 *  （OpenCode V2 研读报告 §2「历史回合里没有结果的工具」）。
 *
 *  四种状态：
 *  - ok / failed：配到了结果，按 success 分。只有 success === false 才算失败——与原判据一致，老库里没有 success 字段的结果照旧算成功；
 *  - interrupted：没配到结果，而它所在的回合已经不在跑了——执行被打断，工具可能做完了也可能没做，结果不知道；
 *  - pending：没配到结果，所在回合还在跑——结果还没到是正常的。界面照旧画（与成功同一个点），
 *    回合结束后 open() 重取历史就有结果了；给「进行中」另画一种样子属于 W7c「各步骤的状态点」，不在这一步。
 *  「所在回合还在不在跑」由调用方判（StageChat 看运行态与最后一个回合的起点，见 lastTurnStart）。
 *
 *  W2b-11d：右栏「改动」清单（lib/artifacts/collect）也按这里的状态判一次写入算不算改动，配结果（toolResultsById）
 *  与「最后一个回合还在不在跑」（lib/steps/live 的 useLastTurnLive）一并抽成共用的一份：对话流与改动清单各配各的话，
 *  哪天一处认了新形态的结果、另一处没认，同一步在对话流里是成功、在改动清单里却消失了（或反过来）。 */

export type StepStatus = 'ok' | 'failed' | 'interrupted' | 'pending';

/** 一步配到的工具结果：success 原样带回（交给 stepStatus 判，只有 === false 算失败），output 给展开区显示。 */
export interface StepResult { success: unknown; output?: string }

/** 库里的 toolResult 按 toolUseId 建索引，给历史里的 toolUse 配结果（W2b-11d 从 StageChat 的 resultOf 抽出来，改动清单共用）。
 *  认的形态与原 resultOf 相同：type 为 toolResult、value 是对象、toolUseId 是字符串。
 *  同一个 id 出现多次时认最早那条——原 resultOf 从头逐条扫、见到就返回，是同一条。
 *  一次建好整张表：原 resultOf 每个 toolUse 都把全部消息扫一遍，长会话里是平方级。 */
export function toolResultsById(messages: readonly { role?: unknown; parts?: unknown }[]): Map<string, StepResult> {
  const out = new Map<string, StepResult>();
  for (const m of messages) {
    if (!Array.isArray(m?.parts)) continue;
    for (const p of m.parts as ({ type?: unknown; value?: unknown } | null)[]) {
      if (p?.type !== 'toolResult' || !p.value || typeof p.value !== 'object') continue;
      const v = p.value as { toolUseId?: unknown; success?: unknown; output?: unknown };
      if (typeof v.toolUseId !== 'string' || out.has(v.toolUseId)) continue;
      out.set(v.toolUseId, { success: v.success, output: typeof v.output === 'string' ? v.output : undefined });
    }
  }
  return out;
}

/** result：这一步配到的工具结果（库里的 toolResult，或实时回合 toolEnd 带回来的）；还没有结果传 undefined / null。
 *  turnLive：这一步所在的回合是否还在跑。 */
export function stepStatus(result: { success?: unknown } | null | undefined, turnLive: boolean): StepStatus {
  if (result) return result.success === false ? 'failed' : 'ok';
  return turnLive ? 'pending' : 'interrupted';
}

/** 仅承载工具结果的合成 user 消息（后端用它回传 toolResult）：不是用户说的话，不开新回合。 */
export function isResultCarrier(m: { role?: unknown; parts?: unknown }): boolean {
  return Array.isArray(m.parts) && m.parts.length > 0
    && m.parts.every((p: { type?: unknown } | null) => p?.type === 'toolResult');
}

/** 最后一个回合从哪条消息开始：最后一条真用户消息（结果载体不算）的下标，与 StageChat 按用户消息切回合同一判据。
 *  一条用户消息都没有时，整段都在同一个回合里，返回 0。 */
export function lastTurnStart(messages: readonly { role?: unknown; parts?: unknown }[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && !isResultCarrier(m)) return i;
  }
  return 0;
}
