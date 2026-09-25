/** W2b-11a：工具步骤的状态推导（纯模块 lib/steps/status.ts 的单测）。
 *
 *  立项事实（OpenCode V2 研读报告 §2、附录 baseline-and-cuts.md「[replace] 历史回合里没有结果的工具」）：
 *  StageChat 给历史里的工具步骤定状态用的是 `ok: r ? r.ok : true`——配不到 toolResult 的一步一律画成成功。
 *  而 loop.ts 要等一批工具全部跑完才写结果那条消息，minisd 崩溃、被强杀、退出时来不及收尾，那几步就只剩 toolUse。
 *  模型那一侧 pairToolResults 早就补上了「[工具执行被中断，结果未知]」，只有界面还说它们成功了。
 *
 *  规则（设计稿 §4.1「W2b-11 拆成两步」的 W2b-11a）：
 *  - 配到了结果：success === false 是失败，其余是成功（老库里没有 success 字段的结果照旧算成功，与原判据一致）；
 *  - 配不到结果、所在回合不在跑：已中断 · 结果未知；
 *  - 配不到结果、所在回合还在跑：结果还没到，是正常的（pending），界面保持原样。
 *  「哪个回合还在跑」由 StageChat 决定（运行态与最后一个回合的起点，见 renderer-tool-steps.test.ts 的运行时用例）；
 *  回合的起点与 StageChat 切回合同一判据：真用户消息开新回合，只装工具结果的载体不算。 */
import { describe, it, expect } from 'vitest';
import { stepStatus, lastTurnStart, isResultCarrier } from '../src/renderer/src/lib/steps/status';

describe('stepStatus：配到结果看 success，配不到看所在回合还在不在跑', () => {
  it('配到结果：success === false 是失败，true 是成功', () => {
    expect(stepStatus({ success: true }, false)).toBe('ok');
    expect(stepStatus({ success: false }, false)).toBe('failed');
    // 回合在不在跑不影响已经有结果的步骤
    expect(stepStatus({ success: true }, true)).toBe('ok');
    expect(stepStatus({ success: false }, true)).toBe('failed');
  });

  it('老库里没有 success 字段、或字段不是 false 的结果：照旧算成功（原判据是 success !== false）', () => {
    expect(stepStatus({}, false)).toBe('ok');
    expect(stepStatus({ success: undefined }, false)).toBe('ok');
    expect(stepStatus({ success: 'false' }, false)).toBe('ok');
  });

  it('配不到结果、回合不在跑：已中断（不再当成功）', () => {
    expect(stepStatus(undefined, false)).toBe('interrupted');
    expect(stepStatus(null, false)).toBe('interrupted');
  });

  it('配不到结果、回合还在跑：pending——结果还没到是正常的，不能判中断', () => {
    expect(stepStatus(undefined, true)).toBe('pending');
    expect(stepStatus(null, true)).toBe('pending');
  });
});

const user = (text: string) => ({ role: 'user', parts: [{ type: 'text', value: text }] });
const carrier = (id: string) => ({ role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: id, output: 'x', success: true } }] });
const asst = (useId?: string) => ({ role: 'assistant', parts: useId ? [{ type: 'toolUse', value: { toolUseId: useId, name: 'web_fetch', input: '{}' } }] : [{ type: 'text', value: '好' }] });

describe('isResultCarrier：只装工具结果的合成 user 消息', () => {
  it('parts 非空且全是 toolResult 才算', () => {
    expect(isResultCarrier(carrier('T1'))).toBe(true);
    expect(isResultCarrier(user('你好'))).toBe(false);
    expect(isResultCarrier({ role: 'user', parts: [] })).toBe(false);
    expect(isResultCarrier({ role: 'user', parts: [{ type: 'toolResult', value: {} }, { type: 'text', value: 'x' }] })).toBe(false);
    expect(isResultCarrier({ role: 'user' })).toBe(false);
  });
});

describe('lastTurnStart：最后一个回合从哪条消息开始', () => {
  it('最后一条真用户消息的下标；结果载体不开新回合', () => {
    expect(lastTurnStart([user('一'), asst('T1'), carrier('T1'), asst(), user('二'), asst('T2')])).toBe(4);
    // 最后一条 user 是结果载体：回合仍从「二」算起
    expect(lastTurnStart([user('一'), asst(), user('二'), asst('T2'), carrier('T2'), asst('T3')])).toBe(2);
  });

  it('最后一条是刚发出的用户消息（本窗口发起、还没有助手输出）：就是它', () => {
    expect(lastTurnStart([user('一'), asst('T1'), user('二')])).toBe(2);
  });

  it('一条用户消息都没有：整段都在同一个回合里，从 0 开始；空列表也是 0', () => {
    expect(lastTurnStart([asst('T1'), carrier('T1'), asst()])).toBe(0);
    expect(lastTurnStart([])).toBe(0);
  });
});
