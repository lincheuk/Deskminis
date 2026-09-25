/** T6e-2 补搬守卫：工具步骤要看得见「调了什么」。
 *
 *  立项事实（T6 清场时实测）：T 波换壳把工具行重做成 `ui/StepGroup.vue`，
 *  但 `Step` 接口只有 `{name,title,ok,output}`——**连 `input` 字段都没有**。
 *  旧 `components/ToolLine.vue` 有的两样东西一起丢了：
 *    ① `file_edit` 展开渲成差分视图（`extractEditPair` + `DiffView`，路径还做了相对化）；
 *    ② 提不出载荷时回落「参数」JSON 区。
 *  结果：agent 改了文件，界面上只有一段 output，看不到改的是哪个文件、改了什么。
 *
 *  数据一直在手边——`stores/chat.ts` 的 `toolCards` 带 `input`，历史消息路径上
 *  `StageChat.vue` 甚至读了 `input.tool_title` 当标题、**把剩下的整个对象扔了**。
 *  所以这不是「能力没实现」，是**映射时顺手丢字段**，本文件钉住两条链路都别再丢。
 *
 *  ⚠️ 手法边界（与 mu6 守卫同一句话）：源码文本守卫只能证明「传下去了」，
 *  证明不了「点开真的看得见」。实拍 `drive-t6e.mjs` 不可被本文件替代。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as vue from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useChat } from '../src/renderer/src/stores/chat';
import { runSetup, renderSfc, visibleText } from './sfc-setup';
import { sfcBlocks } from './sfc-blocks';

// W2b-11a 审查二：有几例要走 store 自己的 send / open / onEvent，rpc 换成可控的桩（别的用例不碰 rpc）。
// 桩的行为由那几例在 beforeEach 里装；StageChat 的 setup 经 sfc-setup 现 import 的 store 与这里是同一份，拿到的也是桩
const { rpcCall } = vi.hoisted(() => ({ rpcCall: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCall, connect: async () => {}, on: () => {}, off: () => {} },
}));

const root = path.resolve(__dirname, '..');
const read = (p: string): string =>
  fs.readFileSync(path.join(root, 'src/renderer/src/', p), 'utf8').replace(/\r\n/g, '\n');

const group = read('ui/StepGroup.vue');
const stage = read('ui/StageChat.vue');

describe('T6e-2 工具步骤展开区：file_edit 走差分，其余回落参数（4 例）', () => {
  it('StepGroup 的 Step 接口必须带 input——字段不在，后面全是空谈', () => {
    const iface = group.match(/interface Step \{[^}]*\}/)?.[0] ?? '';
    expect(iface).not.toBe('');
    expect(iface).toMatch(/input\?:\s*string/);
  });

  it('StepGroup 复用既有的 extractEditPair / diffLines / UiDiff，不自造一套', () => {
    // 这三样都现成且已测（lib/diff/payload.ts、lib/diff/lcs.ts、ui/UiDiff.vue）。
    // 自己再写一份路径相对化或差分算法 = 把已测逻辑换成未测逻辑，正是 T6e-1 记过的那笔账。
    expect(group).toMatch(/from\s+'\.\.\/lib\/diff\/payload'/);
    expect(group).toMatch(/from\s+'\.\.\/lib\/diff\/lcs'/);
    expect(group).toContain('extractEditPair');
    expect(group).toMatch(/import UiDiff from '\.\/UiDiff\.vue'/);
    expect(group).toContain('<UiDiff');
  });

  it('提不出载荷时回落「参数」区，而不是什么都不显示', () => {
    // 旧 ToolLine 的回落链：editPair 出得来走 DiffView，否则参数 JSON + 输出，都没有才「无内容」。
    // 只做 file_edit 一种、别的工具展开一片空白，等于换了个方式继续瞒着用户。
    expect(group).toContain('参数');
    expect(group).toMatch(/JSON\.parse/);   // 参数要 pretty 打印，原始单行 JSON 没法读
  });

  it('参数区必须截断——载荷可能是整个文件内容，撑爆的是用户的滚动条', () => {
    // output 那边本来就 slice(0, 2000)，参数区漏了截断的话，一次 file_write 大文件就把对话撑没了。
    const slices = [...group.matchAll(/\.slice\(0,\s*\d+\)/g)].length;
    expect(slices).toBeGreaterThanOrEqual(2);
  });
});

describe('T6e-2 两条链路都要把 input 传下去（2 例）', () => {
  it('实时路径：toolCards 映射必须带 input', () => {
    // chat.toolCards 在 toolStart 时就存了 input，映射里不写这一行就等于当场扔掉。
    const map = stage.match(/chat\.toolCards\.map\([\s\S]{0,300}?\)\)/)?.[0] ?? '';
    expect(map).not.toBe('');
    expect(map).toMatch(/input:/);
  });

  it('历史路径：step 字面量必须带 input（同一处已经读了 input.tool_title）', () => {
    // 回归锚：这里原本写着 `p.value.input.tool_title` 取标题，取完把 p.value.input 整个丢了——
    // 数据就在手上却不往下传，是本次补搬里最容易再犯的一种。
    const lit = stage.match(/const step: Step = \{[\s\S]*?\};/)?.[0] ?? '';
    expect(lit).not.toBe('');
    expect(lit).toMatch(/input:/);
  });
});

// ── W2b-11a：历史回合里没有结果的工具不再显示成功 ─────────────────────────────────────────
// StageChat 以前给历史步骤定状态用 `ok: r ? r.ok : true`：配不到 toolResult 的一步一律画成成功。
// loop.ts 要等一批工具全部跑完才写结果那条消息，minisd 崩溃、被强杀、退出来不及收尾时，那几步只剩 toolUse——
// 模型那一侧 pairToolResults 早补上了「[工具执行被中断，结果未知]」，界面却说它们成功了（OpenCode V2 研读报告 §2）。
// 这里用 compiler-sfc 真跑 StageChat 的 setup（tests/sfc-setup.ts），喂消息、改运行态，读它算出的 turns，
// 不是只看源码里写了什么。

const STAGE_FILE = path.join(root, 'src/renderer/src/ui/StageChat.vue');
const GROUP_FILE = path.join(root, 'src/renderer/src/ui/StepGroup.vue');

type StepOut = { title: string; status?: string; ok?: boolean };
type StageBindings = {
  turns: { value: { blocks: { kind: string; steps?: StepOut[] }[] }[] };
  liveSteps: { value: StepOut[] };
};

const T = (title: string): string => JSON.stringify({ url: 'http://127.0.0.1/x', tool_title: title });
const u = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', value: text }], createdAt: 1 });
const use = (id: string, useId: string, title: string) =>
  ({ id, role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: useId, name: 'web_fetch', input: T(title) } }] });
const res = (id: string, useId: string, success?: boolean) =>
  ({ id, role: 'user', parts: [{ type: 'toolResult', value: success === undefined ? { toolUseId: useId, output: 'o' } : { toolUseId: useId, output: 'o', success } }] });
const say = (id: string, text: string) => ({ id, role: 'assistant', parts: [{ type: 'text', value: text }] });

/** 四个回合：成功 / 失败 + 老库无 success 字段 / 崩溃时在跑（悬空）/ 最后一个回合也悬空。 */
const HISTORY = [
  u('u1', '第一回合'), use('a1', 'T1', '抓成功的'), res('r1', 'T1', true), say('a1b', '抓到了。'),
  u('u2', '第二回合'), use('a2', 'T2', '抓失败的'), res('r2', 'T2', false), use('a2b', 'T3', '老库的结果'), res('r3', 'T3'),
  u('u3', '第三回合'), use('a3', 'T4', '崩溃时在跑'),
  u('u4', '第四回合'), use('a4', 'T5', '最后一回合的'),
];

function statuses(b: StageBindings): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const t of b.turns.value) for (const blk of t.blocks) for (const s of blk.steps ?? []) out[s.title] = s.status;
  return out;
}

let scope = vue.effectScope();
beforeEach(() => {
  setActivePinia(createPinia());
  scope = vue.effectScope();
  // StageChat 的贴底 watch 走 requestAnimationFrame（node 里没有）；消息一变它就会排一帧
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
});
afterEach(() => { scope.stop(); });

async function runStage(): Promise<{ chat: ReturnType<typeof useChat>; b: StageBindings }> {
  const chat = useChat();
  const { bindings } = await runSetup<StageBindings>(STAGE_FILE, { narrow: false }, scope);
  return { chat, b: bindings };
}

describe('W2b-11a StageChat：历史步骤的状态（真跑 setup）', () => {
  it('不在运行：配不到结果的步骤是「已中断」，不再是成功；成功、失败、老库无 success 字段照旧', async () => {
    const { chat, b } = await runStage();
    chat.messages = HISTORY.map(m => ({ ...m }));
    await vue.nextTick();
    expect(statuses(b)).toEqual({
      抓成功的: 'ok', 抓失败的: 'failed', 老库的结果: 'ok', 崩溃时在跑: 'interrupted', 最后一回合的: 'interrupted',
    });
  });

  it('中途接上正在跑的会话（running + midRun）：最后一个回合里没到的结果是 pending，更早回合的悬空步骤仍是「已中断」', async () => {
    const { chat, b } = await runStage();
    chat.messages = HISTORY.map(m => ({ ...m }));
    chat.running = true; chat.midRun = true;
    await vue.nextTick();
    expect(statuses(b)).toMatchObject({ 崩溃时在跑: 'interrupted', 最后一回合的: 'pending', 抓成功的: 'ok' });
  });

  it('本窗口刚发出一条（running，乐观消息在末尾）：上一个回合的悬空步骤是「已中断」——它不在正在跑的回合里', async () => {
    const { chat, b } = await runStage();
    chat.messages = [...HISTORY.map(m => ({ ...m })), u('local-1', '第五回合')];
    chat.running = true; chat.midRun = false;
    await vue.nextTick();
    expect(statuses(b)).toMatchObject({ 崩溃时在跑: 'interrupted', 最后一回合的: 'interrupted' });
  });

  it('中途接上的回合落下、open() 还没把历史取回来：不闪「已中断」；取回来以后按新历史判', async () => {
    const { chat, b } = await runStage();
    chat.messages = HISTORY.map(m => ({ ...m }));
    chat.running = true; chat.midRun = true;
    await vue.nextTick();
    expect(statuses(b)['最后一回合的']).toBe('pending');
    // turnEnd：store 同步落下 running / midRun，open() 的重取要等一次 RPC——手里还是跑着时取的那份历史
    chat.running = false; chat.midRun = false;
    await vue.nextTick();
    expect(statuses(b)['最后一回合的']).toBe('pending');
    // 历史取回来了，结果也在里面
    chat.messages = [...HISTORY.map(m => ({ ...m })), res('r5', 'T5', true), say('a5', '好了。')];
    await vue.nextTick();
    expect(statuses(b)).toMatchObject({ 最后一回合的: 'ok', 崩溃时在跑: 'interrupted' });
  });

  it('同上，但取回来的历史里这一步还是没有结果（回合以出错收场、那一步悬空）：判「已中断」', async () => {
    const { chat, b } = await runStage();
    chat.messages = HISTORY.map(m => ({ ...m }));
    chat.running = true; chat.midRun = true;
    await vue.nextTick();
    chat.running = false; chat.midRun = false;
    await vue.nextTick();
    chat.messages = HISTORY.map(m => ({ ...m }));
    await vue.nextTick();
    expect(statuses(b)['最后一回合的']).toBe('interrupted');
  });

  it('发送被拒（本窗口发起、没中途接上）：running 落下、乐观消息撤掉，上一回合真悬空的步骤立刻判「已中断」', async () => {
    const { chat, b } = await runStage();
    chat.messages = [...HISTORY.map(m => ({ ...m })), u('local-1', '第五回合')];
    chat.running = true; chat.midRun = false;
    await vue.nextTick();
    // store.send 的 catch：撤掉乐观消息（新数组）并落下 running
    chat.messages = chat.messages.filter(m => m.id !== 'local-1');
    chat.running = false;
    await vue.nextTick();
    expect(statuses(b)['最后一回合的']).toBe('interrupted');
  });

  it('实时回合的步骤保持原样：没到 toolEnd 的是 pending（画法同以前），到了的按 success 分成功失败，绝不判中断', async () => {
    const { chat, b } = await runStage();
    chat.running = true;
    chat.toolCards = [
      { toolUseId: 'L1', name: 'web_fetch', title: '还在跑的', input: T('还在跑的'), startedAt: 1 },
      { toolUseId: 'L2', name: 'web_fetch', title: '跑完了', input: T('跑完了'), startedAt: 1, success: true, output: 'o', endedAt: 2 },
      { toolUseId: 'L3', name: 'web_fetch', title: '失败了', input: T('失败了'), startedAt: 1, success: false, output: 'e', endedAt: 2 },
    ];
    await vue.nextTick();
    expect(b.liveSteps.value.map(s => [s.title, s.status])).toEqual([['还在跑的', 'pending'], ['跑完了', 'ok'], ['失败了', 'failed']]);
    // 回合收尾时 turnEnd 先落 running（open 重取之前）：实时块跟着隐藏，里面的步骤也不改判
    chat.running = false;
    await vue.nextTick();
    expect(b.liveSteps.value.map(s => s.status)).toEqual(['pending', 'ok', 'failed']);
  });
});

// ── W2b-11a 审查二：回合落下到历史取回之间，按 store 真实的动作顺序走 ─────────────────────────────
// 审查实测：本窗口发起的回合跑到一半，用户点了一下 NavRail 上的当前会话。从设置、定时、助手、市场、设备页回到对话，
// 除了「新建会话」只有这条路；StageSearch、StageCron「打开最近一次会话」点中当前会话也一样。
// 同会话 open() 不动 running / midRun，却把已落库、还没有结果的 toolUse 取进了 messages。
// 旧的 settling 只认 midRun：turnEnd 落下 running 时 midRun 是 false，open() 重取回来之前那一步判成「已中断」，
// 组头闪一下「1 步已中断」（审查的 xvfb 剧本里 MutationObserver 记到 1 次；把重取压 2.5 秒后能截到图）。
// 上面几例直接改 store 字段，走不到这条路；这几例按真实顺序调 send / open / trackRun + onEvent，
// rpc 是桩，chat.messages.list 可以挂起，模拟重取还在路上。
describe('W2b-11a StageChat：回合落下到历史取回之间（走 store 自己的动作）', () => {
  /** chat.messages.list 每次依次取一份回复；取到 'HOLD' 就挂起，等用例从 held 里取出来放行。 */
  let lists: unknown[] = [];
  let held: ((v: unknown) => void)[] = [];
  let prompt: () => Promise<unknown> = async () => ({ ok: true });

  beforeEach(() => {
    lists = []; held = []; prompt = async () => ({ ok: true });
    rpcCall.mockReset();
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'chat.messages.list') {
        const r = lists.shift() ?? [];
        return r === 'HOLD' ? await new Promise(res => { held.push(res); }) : r;
      }
      if (method === 'chat.prompt') return await prompt();
      if (method === 'skills.list') return [];
      if (method === 'chat.annotations.list') return { annotations: [] };
      if (method === 'workspace.get') return { root: '/w', isDefault: true };
      return undefined;
    });
  });

  /** open() 里一层套一层地 await：让这些 promise 都走完，再等 Vue 把 watch 与 computed 跑完。 */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    await vue.nextTick();
  };
  /** 与 init() 里 chat.event 的处理器同两行：先按会话记账，是当前会话才交给 onEvent。 */
  const emit = (chat: ReturnType<typeof useChat>, sessionId: string, event: Record<string, unknown>): void => {
    chat.trackRun(sessionId, event);
    if (sessionId === chat.activeId) chat.onEvent(event);
  };
  const BEFORE = () => [u('u1', '第一回合'), say('a1', '好。')];
  const MIDWAY = () => [...BEFORE(), u('u2', '第二回合：跑一个长工具'), use('a2', 'T9', '跑到一半的长工具')];

  /** 本窗口发起一个回合，工具跑着的时候用户点了当前会话（NavRail.openSession 无条件 chat.open）。 */
  async function sendThenReopen(): Promise<{ chat: ReturnType<typeof useChat>; b: StageBindings }> {
    const { chat, b } = await runStage();
    lists.push(BEFORE());
    await chat.open('S1');
    void chat.send('第二回合：跑一个长工具');
    await settle();
    emit(chat, 'S1', { kind: 'toolStart', toolUseId: 'T9', name: 'web_fetch', title: '跑到一半的长工具', input: T('跑到一半的长工具') });
    lists.push(MIDWAY());
    await chat.open('S1');
    await settle();
    expect([chat.running, chat.midRun], '前提：同会话 open() 不动运行态，也不算中途接上').toEqual([true, false]);
    expect(statuses(b)['跑到一半的长工具']).toBe('pending');
    return { chat, b };
  }

  it.each([
    ['turnEnd', { kind: 'turnEnd', stopReason: 'endTurn' }],
    ['error', { kind: 'error', message: '模型服务断开' }],
  ])('本窗口发起、中途同会话 open() 取进了跑到一半的步骤：%s 落下 running 之后、重取回来之前不闪「已中断」，取回来按新历史判', async (_, end) => {
    const { chat, b } = await sendThenReopen();
    lists.push('HOLD');
    emit(chat, 'S1', end);
    await settle();
    expect(chat.running).toBe(false);
    expect(held.length, '前提：重取还挂着').toBe(1);
    expect(statuses(b)['跑到一半的长工具'], '回合落下到重取回来之间闪出了假的「已中断」').toBe('pending');
    held.shift()!([...MIDWAY(), res('r9', 'T9', true), say('a2b', '做完了。')]);
    await settle();
    expect(statuses(b)['跑到一半的长工具']).toBe('ok');
  });

  it('同一条路走到一半换到别的会话：新会话历史到之前，画面上还是这个仍在跑的回合，不闪「已中断」；到了按新会话判', async () => {
    const { chat, b } = await sendThenReopen();
    // open() 换会话时先同步落下 running（S2 没在跑），历史 await 回来才换
    lists.push('HOLD');
    void chat.open('S2');
    await settle();
    expect([chat.running, chat.runningSessions]).toEqual([false, ['S1']]);
    expect(statuses(b)['跑到一半的长工具'], 'S1 确实还在跑，不该判中断').toBe('pending');
    held.shift()!([u('v1', '别的会话'), use('b1', 'U1', '别的会话里悬空的')]);
    await settle();
    expect(statuses(b)).toEqual({ 别的会话里悬空的: 'interrupted' });
  });

  it('发送被拒（store.send 的 catch 撤掉乐观消息、落下 running）：上一回合真悬空的步骤前后都是「已中断」，不被当成还在跑', async () => {
    // settling 只在「running 落下的那一拍历史没被换掉」时生效；被拒时 store 用新数组撤乐观消息，历史换了，所以不生效。
    // 以后 store 若改成原地删（splice），这里会红：那时上一回合的悬空步骤会一直画成 pending，因为被拒之后不会重取历史
    const { chat, b } = await runStage();
    lists.push(HISTORY.map(m => ({ ...m })));
    await chat.open('S1');
    await settle();
    expect(statuses(b)['最后一回合的']).toBe('interrupted');
    let reject: (e: Error) => void = () => {};
    prompt = () => new Promise((_, rej) => { reject = rej; });
    const sending = chat.send('第五回合');
    await settle();
    expect(chat.running).toBe(true);
    expect(statuses(b)['最后一回合的'], '乐观消息开了新回合，上一回合不在跑').toBe('interrupted');
    reject(new Error('未配置模型'));
    await sending;
    await settle();
    expect([chat.running, chat.lastError]).toEqual([false, '未配置模型']);
    expect(statuses(b)['最后一回合的']).toBe('interrupted');
  });
});

describe('W2b-11a StepGroup：「已中断」单独计数、单独画', () => {
  type GroupBindings = { failed: () => number; interrupted: () => number };
  const steps = (...st: string[]) => st.map((status, i) => ({ name: 'web_fetch', title: `第 ${i + 1} 步`, status, output: null }));

  it('失败只数 failed，中断另数；pending 与成功都不计（真跑 setup）', async () => {
    const { bindings: g } = await runSetup<GroupBindings>(GROUP_FILE, { steps: steps('ok', 'failed', 'interrupted', 'interrupted', 'pending'), live: false }, scope);
    expect(g.failed()).toBe(1);
    expect(g.interrupted()).toBe(2);
  });

  const { template: gtpl, style: gcss } = sfcBlocks(group, 'StepGroup.vue');

  it('组头：收起时（默认状态）就看得见「N 步已中断」，与「N 步失败」分开（真渲染，只看看得见的字）', async () => {
    // 这条原先在整段模板上认写法、不看位置：审查实测，把计数挪进 v-if="open" 的展开区，收起时就看不见了，照样绿。
    // 步骤组默认收起，那一刻组头只剩「已执行 N 步」（有失败的再加一句「N 步失败」），悬空的几步看上去与成功没有两样——
    // 本步要去掉的假话又回来了。
    // 改为按默认状态真渲染（tests/sfc-setup.ts 的 renderSfc），只看用户看得见的字：计数挪进展开区、展开区改 v-show 再挪进去，
    // 这里都看不到它；组头以后怎么重排（W7c 要重画状态点），只要收起时还看得见，就不误报。
    const seen = async (...st: string[]) => visibleText(await renderSfc(GROUP_FILE, { steps: steps(...st), live: false }));
    const mixed = await seen('ok', 'failed', 'interrupted', 'interrupted', 'pending');
    expect(mixed, '前提：步骤组默认收起，展开区里的步骤标题不该出现').not.toMatch(/第 \d 步/);
    expect(mixed).toMatch(/(?<!\d)2\s*步已中断/);
    expect(mixed).toMatch(/(?<!\d)1\s*步失败/);
    // 两个计数各管各的：没有中断就不说中断，只有中断也不冒出「0 步失败」
    expect(await seen('ok', 'failed')).not.toMatch(/步已中断/);
    const onlyIntr = await seen('ok', 'interrupted');
    expect(onlyIntr).toMatch(/(?<!\d)1\s*步已中断/);
    expect(onlyIntr).not.toMatch(/步失败/);
  });

  it('步骤行：中断的那一步标「已中断 · 结果未知」', () => {
    expect(gtpl).toMatch(/v-if="s\.status === 'interrupted'"[^>]*>\s*已中断 · 结果未知\s*</);
  });

  it('状态点：失败与中断各有自己的类，中断的画法既不是成功的绿、也不是失败的红', () => {
    const dot = /<span class="dot" :class="\{([^}]*)\}"/.exec(gtpl)?.[1] ?? '';
    expect(dot, '找不到状态点的 :class').not.toBe('');
    const keyOf = (st: string): string => new RegExp(`(\\w+): s\\.status === '${st}'`).exec(dot)?.[1] ?? '';
    const bad = keyOf('failed');
    const intr = keyOf('interrupted');
    expect(bad).not.toBe('');
    expect(intr).not.toBe('');
    expect(intr).not.toBe(bad);
    const rule = (sel: string): string => new RegExp(`\\.dot\\.${sel}\\s*\\{([^}]*)\\}`).exec(gcss)?.[1] ?? '';
    expect(rule(bad)).toMatch(/var\(--c-err\)/);
    expect(rule(intr), `.dot.${intr} 没有样式`).not.toBe('');
    expect(rule(intr)).not.toMatch(/var\(--c-(ok|err)\)/);
  });
});
