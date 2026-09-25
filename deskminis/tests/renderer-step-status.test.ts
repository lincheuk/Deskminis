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
 *  回合的起点与 StageChat 切回合同一判据：真用户消息开新回合，只装工具结果的载体不算。
 *  W2b-11d：「运行态」那一半抽进 lib/steps/live（useLastTurnLive），配结果抽成 toolResultsById，右栏「改动」清单与 StageChat 共用，
 *  单测见本文件末尾两组。 */
import { describe, it, expect } from 'vitest';
import { effectScope, nextTick, reactive } from 'vue';
import { stepStatus, lastTurnStart, isResultCarrier, toolResultsById } from '../src/renderer/src/lib/steps/status';
import { useLastTurnLive } from '../src/renderer/src/lib/steps/live';

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

// ── W2b-11d：配结果与「最后一个回合还在不在跑」也抽成共用的一份 ─────────────────────────────────────
// 右栏「改动」清单改为按工具结果判（设计稿 §4.1 W2b-11d），判据必须与对话流给步骤定状态是同一套，不另写一份：
// 配结果（toolResultsById）原是 StageChat 的 resultOf，「最后一个回合还在不在跑」（useLastTurnLive）原是 StageChat 的 settling。
// 两处各写一份的话，哪天一处改了、另一处没改，同一步在对话流里是成功、在改动清单里却没了（或反过来）。

describe('toolResultsById：按 toolUseId 给步骤配库里的结果', () => {
  it('带回 success 原值（交给 stepStatus 判）与 output；同一个 id 出现两次认最早那条', () => {
    const m = toolResultsById([
      user('一'), asst('T1'),
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: '第一次', success: false } }] },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: '第二次', success: true } }] },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T2', output: 7 } }] },
    ]);
    expect(m.get('T1')).toEqual({ success: false, output: '第一次' });
    // 老库没有 success 字段：原样是 undefined，stepStatus 照旧算成功；output 不是字符串就不带
    expect(m.get('T2')).toEqual({ success: undefined, output: undefined });
    expect(m.has('T3')).toBe(false);
  });

  it('不是结果的 part、value 不是对象、toolUseId 不是字符串的一律跳过；消息没有 parts 也不出错', () => {
    const m = toolResultsById([
      { role: 'user' },
      { role: 'user', parts: 'x' },
      { role: 'user', parts: [null, { type: 'toolResult' }, { type: 'toolResult', value: 'T9' }, { type: 'toolResult', value: { toolUseId: 9 } }] },
      asst('T4'),
    ]);
    expect(m.size).toBe(0);
  });
});

describe('useLastTurnLive：最后一个回合是不是还可能在跑（StageChat 与 WorkspacePanel 共用）', () => {
  function run(init: { running: boolean; messages: unknown[] }) {
    const scope = effectScope();
    const chat = reactive({ ...init });
    const live = scope.run(() => useLastTurnLive(chat))!;
    return { scope, chat, live };
  }

  it('running 为真就是在跑；从没跑过就不是', async () => {
    const a = run({ running: true, messages: [] });
    expect(a.live.value).toBe(true);
    const b = run({ running: false, messages: [user('一')] });
    expect(b.live.value).toBe(false);
    a.scope.stop(); b.scope.stop();
  });

  it('running 落下的那一拍历史没换（open() 的重取还在路上）：仍算在跑，直到历史换掉', async () => {
    const { scope, chat, live } = run({ running: true, messages: [user('一'), asst('T1')] });
    chat.running = false;
    await nextTick();
    expect(live.value).toBe(true);
    chat.messages = [user('一'), asst('T1'), carrier('T1')];
    await nextTick();
    expect(live.value).toBe(false);
    scope.stop();
  });

  it('running 落下的同一拍历史也换了（发送被拒撤掉乐观消息、删会话回欢迎页）：不算在跑', async () => {
    const { scope, chat, live } = run({ running: true, messages: [user('一'), asst('T1'), user('二')] });
    chat.messages = chat.messages.slice(0, 2);
    chat.running = false;
    await nextTick();
    expect(live.value).toBe(false);
    scope.stop();
  });
});
