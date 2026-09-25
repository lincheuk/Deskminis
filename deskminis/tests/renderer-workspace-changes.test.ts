/** W2b-11d：右栏「改动」清单按工具结果判——真跑 WorkspacePanel 的 setup，看它算出的 changes。
 *
 *  立项事实：WorkspacePanel 的改动清单 = collectArtifacts(chat.messages, chat.toolCards)，而 collectArtifacts 只看工具调用本身：
 *  失败的、历史回合里中断没有结果的 file_edit / file_write / office_write 也列成改动，还带增删数。
 *  与 W2b-11a 修掉的「没结果的工具显示成功」是同一类界面假话（设计稿 §4.1 W2b-11d）。
 *
 *  判定与对话流共用一份（设计稿 §4.1 W2b-11d「复用 W2b-11a 的步骤状态判定」，不另写一套）：
 *  - 步骤状态：lib/steps/status 的 stepStatus / lastTurnStart / toolResultsById，与 StageChat 给步骤定状态同一套；
 *  - 「最后一个回合是不是还在跑」：lib/steps/live 的 useLastTurnLive——原来写在 StageChat 里（W2b-11a 的 settling），
 *    running 落下、open() 还没把历史取回来的那一拍仍算在跑，收尾不闪。
 *  成功的照旧列；失败的不列；没有结果、所在回合已不在跑（已中断 · 结果未知）的不列；所在回合还在跑、结果还没到的照旧列。
 *
 *  最后一组把 StageChat 与 WorkspacePanel 挂在同一个 store 上，逐个运行态比对：对话流里是成功或还在等结果的写工具，
 *  恰好就是改动清单里的那些——两处判据一旦分叉，这组先红。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import * as vue from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useChat } from '../src/renderer/src/stores/chat';
import { runSetup } from './sfc-setup';

// 有一组走 store 自己的 send / open / onEvent，rpc 换成可控的桩（同 renderer-tool-steps.test.ts 审查二那组）
const { rpcCall } = vi.hoisted(() => ({ rpcCall: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCall, connect: async () => {}, on: () => {}, off: () => {} },
}));

const root = path.resolve(__dirname, '..');
const WS_FILE = path.join(root, 'src/renderer/src/ui/WorkspacePanel.vue');
const STAGE_FILE = path.join(root, 'src/renderer/src/ui/StageChat.vue');

type Change = { path: string; kind: string; add?: number; del?: number };
type WsBindings = { changes: { value: Change[] } };
type StepOut = { name: string; status?: string; input?: string };
type StageBindings = {
  turns: { value: { blocks: { kind: string; steps?: StepOut[] }[] }[] };
  liveSteps: { value: StepOut[] };
};

const u = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', value: text }], createdAt: 1 });
const use = (id: string, useId: string, name: string, input: Record<string, unknown>) =>
  ({ id, role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: useId, name, input: JSON.stringify(input) } }] });
const res = (id: string, useId: string, success?: boolean) =>
  ({ id, role: 'user', parts: [{ type: 'toolResult', value: success === undefined ? { toolUseId: useId, output: 'o' } : { toolUseId: useId, output: 'o', success } }] });
const say = (id: string, text: string) => ({ id, role: 'assistant', parts: [{ type: 'text', value: text }] });

const W = (p: string) => ({ path: p, content: '一行\n', tool_title: `写 ${p}` });
const E = (p: string) => ({ path: p, old_string: '旧', new_string: '新', tool_title: `改 ${p}` });

/** 与 xvfb 剧本 W2b-11d-changes.mjs 同形：成功一个、失败一个、中断一个（中断的那个在最后一个回合里）。 */
const HISTORY = () => [
  u('u1', '第一步：写成功一个文件'), use('a1', 'T1', 'file_write', W('成功.txt')), res('r1', 'T1', true), say('a1b', '写好了。'),
  u('u2', '第二步：改失败一个不存在的文件'), use('a2', 'T2', 'file_edit', E('失败.txt')), res('r2', 'T2', false), say('a2b', '没改成。'),
  u('u3', '第三步：写中断'), use('a3', 'T3', 'file_write', W('skills/demo/SKILL.md')),
];

const paths = (b: WsBindings): string[] => b.changes.value.map(c => c.path);

let scope = vue.effectScope();
beforeEach(() => {
  setActivePinia(createPinia());
  scope = vue.effectScope();
  // StageChat 的贴底 watch 走 requestAnimationFrame（node 里没有）；消息一变它就会排一帧
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
  rpcCall.mockReset();
  rpcCall.mockImplementation(async () => undefined);
});
afterEach(() => { scope.stop(); });

async function runWs(): Promise<{ chat: ReturnType<typeof useChat>; b: WsBindings }> {
  const chat = useChat();
  const { bindings } = await runSetup<WsBindings>(WS_FILE, { selected: null }, scope);
  return { chat, b: bindings };
}

describe('W2b-11d WorkspacePanel：改动清单按工具结果判（真跑 setup）', () => {
  it('不在运行：成功的写列；失败的改、中断的写（已中断 · 结果未知）都不列', async () => {
    const { chat, b } = await runWs();
    chat.messages = HISTORY();
    await vue.nextTick();
    expect(b.changes.value).toEqual([{ path: '成功.txt', kind: 'write', add: undefined, del: undefined }]);
  });

  it('中途接上正在跑的会话（running + midRun）：最后一个回合里还没结果的写照旧列；更早回合里悬空的不列', async () => {
    const { chat, b } = await runWs();
    // HISTORY 第三回合的 T3 悬空；再开第四回合，里面的 T4 也还没有结果
    chat.messages = [...HISTORY(), u('u4', '第四步'), use('a4', 'T4', 'office_write', W('还在写.docx'))];
    chat.running = true; chat.midRun = true;
    await vue.nextTick();
    expect(paths(b)).toEqual(['成功.txt', '还在写.docx']);
  });

  it('回合落下、open() 还没把历史取回来：还没结果的写照旧列，不闪掉；取回来以后按结果判', async () => {
    const { chat, b } = await runWs();
    chat.messages = HISTORY();
    chat.running = true; chat.midRun = true;
    await vue.nextTick();
    expect(paths(b)).toEqual(['成功.txt', 'skills/demo/SKILL.md']);
    // turnEnd：store 同步落下 running / midRun，open() 的重取要等一次 RPC——手里还是跑着时取的那份历史
    chat.running = false; chat.midRun = false;
    await vue.nextTick();
    expect(paths(b), '回合落下到重取回来之间，还没结果的那一步从改动里闪掉了').toEqual(['成功.txt', 'skills/demo/SKILL.md']);
    // 取回来了：这一步被拒（失败）→ 不列
    chat.messages = [...HISTORY(), res('r3', 'T3', false), say('a3b', '没写成。')];
    await vue.nextTick();
    expect(paths(b)).toEqual(['成功.txt']);
  });

  it('同上，取回来的历史里这一步还是没有结果（回合以出错收场、那一步悬空）：判中断，不列', async () => {
    const { chat, b } = await runWs();
    chat.messages = HISTORY();
    chat.running = true; chat.midRun = true;
    await vue.nextTick();
    chat.running = false; chat.midRun = false;
    await vue.nextTick();
    chat.messages = HISTORY();
    await vue.nextTick();
    expect(paths(b)).toEqual(['成功.txt']);
  });

  it('发送被拒（新数组撤掉乐观消息、落下 running）：上一回合悬空的写不被当成还在跑', async () => {
    const { chat, b } = await runWs();
    chat.messages = [...HISTORY(), u('local-1', '第四步')];
    chat.running = true; chat.midRun = false;
    await vue.nextTick();
    expect(paths(b), '乐观消息开了新回合，上一回合不在跑').toEqual(['成功.txt']);
    chat.messages = chat.messages.filter(m => m.id !== 'local-1');
    chat.running = false;
    await vue.nextTick();
    expect(paths(b)).toEqual(['成功.txt']);
  });

  it('实时回合的工具卡：没到 toolEnd 的照旧列，成功的列，失败的不列', async () => {
    const { chat, b } = await runWs();
    chat.running = true;
    chat.toolCards = [
      { toolUseId: 'L1', name: 'file_write', title: '还在写', input: JSON.stringify(W('还在写.txt')), startedAt: 1 },
      { toolUseId: 'L2', name: 'file_edit', title: '改好了', input: JSON.stringify(E('改好了.txt')), startedAt: 1, success: true, output: 'o', endedAt: 2 },
      { toolUseId: 'L3', name: 'office_write', title: '写坏了', input: JSON.stringify(W('写坏了.xlsx')), startedAt: 1, success: false, output: 'e', endedAt: 2 },
    ];
    await vue.nextTick();
    expect(paths(b)).toEqual(['还在写.txt', '改好了.txt']);
    // 回合收尾时 turnEnd 先落 running（open 重取之前）：卡片还在，按各自的结果判，不改判
    chat.running = false;
    await vue.nextTick();
    expect(paths(b)).toEqual(['还在写.txt', '改好了.txt']);
  });
});

// ── 走 store 自己的动作：本窗口发起的回合中途同会话 open()，收尾到重取回来之间 ─────────────────────────
// 与 renderer-tool-steps.test.ts 审查二那组同一条路：同会话 open() 不动 running / midRun，却把已落库、还没有结果的 toolUse 取进 messages；
// turnEnd 落下 running 之后、重取回来之前，只看 chat.running 的话这一步会被判成中断，从改动清单里闪掉再回来。
describe('W2b-11d WorkspacePanel：回合落下到历史取回之间（走 store 自己的动作）', () => {
  let lists: unknown[] = [];
  let held: ((v: unknown) => void)[] = [];
  beforeEach(() => {
    lists = []; held = [];
    rpcCall.mockImplementation(async (method: string) => {
      if (method === 'chat.messages.list') {
        const r = lists.shift() ?? [];
        return r === 'HOLD' ? await new Promise(res => { held.push(res); }) : r;
      }
      if (method === 'chat.prompt') return { ok: true };
      if (method === 'skills.list') return [];
      if (method === 'chat.annotations.list') return { annotations: [] };
      if (method === 'workspace.get') return { root: '/w', isDefault: true };
      if (method === 'files.list') return [];
      return undefined;
    });
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    await vue.nextTick();
  };
  /** 与 init() 里 chat.event 的处理器同两行：先按会话记账，是当前会话才交给 onEvent。 */
  const emit = (chat: ReturnType<typeof useChat>, sessionId: string, event: Record<string, unknown>): void => {
    chat.trackRun(sessionId, event);
    if (sessionId === chat.activeId) chat.onEvent(event);
  };
  const BEFORE = () => [u('u1', '第一回合'), use('a1', 'T1', 'file_write', W('成功.txt')), res('r1', 'T1', true), say('a1b', '好。')];
  const MIDWAY = () => [...BEFORE(), u('u2', '第二回合：写一个要批准的文件'), use('a2', 'T9', 'file_write', W('等批准.txt'))];

  it.each([
    ['turnEnd', { kind: 'turnEnd', stopReason: 'endTurn' }],
    ['error', { kind: 'error', message: '模型服务断开' }],
  ])('%s 落下 running 之后、重取回来之前，跑到一半的写照旧在改动里；取回来按结果判', async (_, end) => {
    const { chat, b } = await runWs();
    lists.push(BEFORE());
    await chat.open('S1');
    void chat.send('第二回合：写一个要批准的文件');
    await settle();
    emit(chat, 'S1', { kind: 'toolStart', toolUseId: 'T9', name: 'file_write', title: '写 等批准.txt', input: JSON.stringify(W('等批准.txt')) });
    lists.push(MIDWAY());
    await chat.open('S1'); // 用户中途点了一下当前会话（NavRail.openSession 无条件 chat.open）
    await settle();
    expect([chat.running, chat.midRun], '前提：同会话 open() 不动运行态').toEqual([true, false]);
    expect(paths(b)).toEqual(['成功.txt', '等批准.txt']);
    lists.push('HOLD');
    emit(chat, 'S1', end);
    await settle();
    expect(chat.running).toBe(false);
    expect(held.length, '前提：重取还挂着').toBe(1);
    expect(paths(b), '回合落下到重取回来之间，跑到一半的写从改动里闪掉了').toEqual(['成功.txt', '等批准.txt']);
    held.shift()!([...MIDWAY(), res('r9', 'T9', false), say('a2b', '被拒了。')]);
    await settle();
    expect(paths(b)).toEqual(['成功.txt']);
  });
});

// ── 与对话流同一判据：StageChat 与 WorkspacePanel 挂同一个 store，逐个运行态比对 ─────────────────────────
describe('W2b-11d：改动清单与对话流判得一致（同一个 store 上真跑两边的 setup）', () => {
  const WRITE_TOOLS = new Set(['file_write', 'file_edit', 'office_write']);
  /** 对话流里算作「做了或还在做」的写工具：状态是 ok 或 pending 的那些，取它们的路径（夹具里的路径都不需要相对化）。 */
  function stageListed(s: StageBindings): string[] {
    const steps = [
      ...s.turns.value.flatMap(t => t.blocks.flatMap(blk => blk.steps ?? [])),
      ...s.liveSteps.value,
    ];
    return steps
      .filter(st => WRITE_TOOLS.has(st.name) && (st.status === 'ok' || st.status === 'pending'))
      .map(st => String((JSON.parse(st.input ?? '{}') as { path?: unknown }).path));
  }

  it('不在运行 / 中途接上 / 回合落下重取未回 / 取回无结果 / 发送被拒 / 实时卡片：两边列的写工具逐项相同', async () => {
    const chat = useChat();
    const { bindings: ws } = await runSetup<WsBindings>(WS_FILE, { selected: null }, scope);
    const { bindings: stage } = await runSetup<StageBindings>(STAGE_FILE, { narrow: false }, scope);
    const same = async (label: string, expected: string[]): Promise<void> => {
      await vue.nextTick();
      expect(new Set(paths(ws)), `${label}：改动清单`).toEqual(new Set(expected));
      expect(new Set(stageListed(stage)), `${label}：对话流`).toEqual(new Set(expected));
    };

    chat.messages = HISTORY();
    await same('不在运行', ['成功.txt']);

    chat.running = true; chat.midRun = true;
    await same('中途接上', ['成功.txt', 'skills/demo/SKILL.md']);

    chat.running = false; chat.midRun = false;
    await same('回合落下、重取未回', ['成功.txt', 'skills/demo/SKILL.md']);

    chat.messages = HISTORY();
    await same('取回来仍无结果', ['成功.txt']);

    chat.messages = [...HISTORY(), u('local-1', '第四步')];
    chat.running = true;
    await same('本窗口刚发出一条', ['成功.txt']);

    chat.toolCards = [
      { toolUseId: 'L1', name: 'file_write', title: '还在写', input: JSON.stringify(W('还在写.txt')), startedAt: 1 },
      { toolUseId: 'L2', name: 'file_edit', title: '改坏了', input: JSON.stringify(E('改坏了.txt')), startedAt: 1, success: false, output: 'e', endedAt: 2 },
    ];
    await same('实时卡片', ['成功.txt', '还在写.txt']);

    chat.messages = chat.messages.filter(m => m.id !== 'local-1');
    chat.toolCards = [];
    chat.running = false;
    await same('发送被拒', ['成功.txt']);
  });
});
