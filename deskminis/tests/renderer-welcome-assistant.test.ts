/**
 * W2b-4 · 欢迎页选助手不再撒谎（止血设计稿 §2「渲染端」、§4 W2b-4；侦察 renderer.md「W2b-welcome」与 open_questions 4、5；
 * cross.md S22 及 corrections「不再含 newSession 的守卫只限定在 saveImages 内」）。
 *
 * 谎在哪：有活动会话但它是空的时候（NavRail「新建会话」最常走到这里），界面显示的也是欢迎页，
 * 副标题承诺「已选 X——直接输入即以该预设开始」；可 Composer.send() 只在没有会话时才按选择建会话，
 * 空会话这条路直接发送，助手从没套上。贴图、选工作区两条隐式建会话也绕过选择；open() 又把选择清成 ''。
 *
 * 修法（本文件钉渲染端一半，后端 RPC 见 tests/session-apply-assistant.test.ts）：
 *   - 纯模块 lib/welcome/assistant.ts：assistantToApply 决定要不要套用 / 解绑；previewBinding 让胶囊发送前就显示真正生效的绑定；
 *   - store：open() 换会话时从会话已绑的助手初始化选择；applyAssistantToSession 调新 RPC 后重拉；ensureSession 按选择建会话；
 *   - Composer：send 的「已有会话」分支先套用再寄存草稿，失败说「套用助手失败」并留住文字；贴图改走 ensureSession；
 *     WorkspacePanel 删掉本地 ensureSession，改走 store 的。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sfcBlocks } from './sfc-blocks';

const { rpcCallMock } = vi.hoisted(() => ({ rpcCallMock: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCallMock, connect: async () => {}, on: vi.fn() },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';

/** 纯模块用动态 import：模块还不存在时只让用到它的那几例红，store 与源码守卫各自按自己的原因红。 */
const loadWelcome = () => import('../src/renderer/src/lib/welcome/assistant');

const SRC = join(__dirname, '../src/renderer/src/');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8').replace(/\r\n/g, '\n');
/** .vue 的脚本段剥注释（/* *\/ 与 // 行）：断言认调用形态，注释里写得再多也喂不饱（交接 §2 第 10 条）。
 *  W2b-4b 第二次审查补：脚本段由 SFC 解析器切出，不再从原文第一个 `<script` 切到第一个 `</script>`——
 *  文件顶部一条 <!-- --> 里写着 <script 和一份正确的 send()，切片就从注释开始，bodyOf 取到的是注释里那份，
 *  「恰好出现 1 次」也由注释凑数，而剥 JS 注释管不到 HTML 注释（审查变异 toplevel-html-comment-feeds-*，实测全绿）。 */
const script = (p: string): string => sfcBlocks(read(p), p).script;
/** 从 open（一个 '{' 的下标）起按花括号配对，返回与它配对的 '}' 的下标（源码已剥注释；这里的函数体内字符串的花括号都成对）。 */
function closeOf(src: string, open: number): number {
  expect(src[open], `下标 ${open} 处不是 '{'`).toBe('{');
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return k; }
  }
  throw new Error(`下标 ${open} 起的花括号没有配平`);
}
/** 从 head 起按花括号配对取函数体。 */
function bodyOf(src: string, head: string): string {
  const i = src.indexOf(head);
  expect(i, `找不到 ${head}`).toBeGreaterThan(-1);
  const open = src.indexOf('{', src.indexOf(')', i));
  return src.slice(open + 1, closeOf(src, open));
}

const base = { activeId: 'E', hasMessages: false, boundAssistantId: '', selected: '' };

describe('纯模块 assistantToApply：null = 不动，\'\' = 解绑，id = 套用', () => {
  it('没有活动会话 → null：交给「建会话」分支（create 带 assistantId 一步到位）', async () => {
    const { assistantToApply } = await loadWelcome();
    expect(assistantToApply({ ...base, activeId: '', selected: 'X' })).toBeNull();
    expect(assistantToApply({ ...base, activeId: '', selected: '' })).toBeNull();
  });

  it('空会话、未绑、选了 X → \'X\'', async () => {
    const { assistantToApply } = await loadWelcome();
    expect(assistantToApply({ ...base, selected: 'X' })).toBe('X');
  });

  it('已绑 X、选的还是 X → null（镜像出来的选择，不重复套用——接力会话照抄过来的模型绑定不会被助手的绑定盖掉）', async () => {
    const { assistantToApply } = await loadWelcome();
    expect(assistantToApply({ ...base, boundAssistantId: 'X', selected: 'X' })).toBeNull();
  });

  it('已绑 X、取消了选择 → \'\'（解绑）；改选 Y → \'Y\'（替换）', async () => {
    const { assistantToApply } = await loadWelcome();
    expect(assistantToApply({ ...base, boundAssistantId: 'X', selected: '' })).toBe('');
    expect(assistantToApply({ ...base, boundAssistantId: 'X', selected: 'Y' })).toBe('Y');
  });

  it('会话已有消息 → null（不是欢迎页；后端也会拒）', async () => {
    const { assistantToApply } = await loadWelcome();
    expect(assistantToApply({ ...base, hasMessages: true, selected: 'X' })).toBeNull();
    expect(assistantToApply({ ...base, hasMessages: true, boundAssistantId: 'X', selected: '' })).toBeNull();
  });

  it('会话绑的助手已被删除：镜像出的 id 没有对应卡片，bound === selected → null，不会凭空触发套用', async () => {
    const { assistantToApply } = await loadWelcome();
    expect(assistantToApply({ ...base, boundAssistantId: 'DEAD', selected: 'DEAD' })).toBeNull();
    // 用户点一张卡再点掉（选择回到 ''）才是明确的解绑
    expect(assistantToApply({ ...base, boundAssistantId: 'DEAD', selected: '' })).toBe('');
  });
});

describe('纯模块 previewBinding：胶囊在发送前就显示发送后真正生效的绑定', () => {
  const ASSTS = [{ id: 'X', modelBinding: 'provider:PX' }, { id: 'Y' }];

  it('没有会话：选了有绑定的 X → X 的绑定；没选 / 选了无绑定的 Y → 默认（\'\'）', async () => {
    const { previewBinding } = await loadWelcome();
    const none = { ...base, activeId: '', sessionBinding: '' };
    expect(previewBinding({ ...none, selected: 'X' }, ASSTS)).toBe('provider:PX');
    expect(previewBinding({ ...none, selected: '' }, ASSTS)).toBe('');
    expect(previewBinding({ ...none, selected: 'Y' }, ASSTS)).toBe('');
  });

  it('空会话待套用：显示所选助手的绑定；所选助手无绑定时显示默认——会话上手动设过的绑定会被套用覆盖，胶囊如实预告', async () => {
    const { previewBinding } = await loadWelcome();
    const manual = { ...base, sessionBinding: 'provider:MANUAL' };
    expect(previewBinding({ ...manual, selected: 'X' }, ASSTS)).toBe('provider:PX');
    expect(previewBinding({ ...manual, selected: 'Y' }, ASSTS)).toBe('');
  });

  it('空会话待解绑：显示默认', async () => {
    const { previewBinding } = await loadWelcome();
    expect(previewBinding({ ...base, boundAssistantId: 'X', selected: '', sessionBinding: 'provider:PX' }, ASSTS)).toBe('');
  });

  it('不需要套用（已绑且没改选 / 有消息）：显示会话自己的绑定，哪怕它与助手的不同（接力照抄的、降级改绑过的）', async () => {
    const { previewBinding } = await loadWelcome();
    expect(previewBinding({ ...base, boundAssistantId: 'X', selected: 'X', sessionBinding: 'group:G' }, ASSTS)).toBe('group:G');
    expect(previewBinding({ ...base, hasMessages: true, selected: 'Y', sessionBinding: 'provider:MANUAL' }, ASSTS)).toBe('provider:MANUAL');
    expect(previewBinding({ ...base, sessionBinding: '' }, ASSTS)).toBe('');
  });
});

// W2b-4b：输入卡喂给 assistantToApply / previewBinding 的参数此前在 Composer 里就地拼，只有调用头有守卫——
// 把 boundAssistantId 换成 welcomeAssistantId（永不套用，原来的谎回来）、把 sessionBinding 换成 ''（胶囊永远说默认，
// Z5 的谎回来）都不红（W2b-4 第三轮审查变异 1、3）。组装挪进纯模块 applyStateOf，这里用仿 store 的夹具钉住每个字段。
describe('纯模块 applyStateOf：从 store 的形状组装 assistantToApply / previewBinding 的入参', () => {
  const ASSTS = [{ id: 'X', modelBinding: 'provider:PX' }, { id: 'Y', modelBinding: 'provider:PY' }, { id: 'Z' }];
  /** 仿 store 的夹具：字段名与形状照 stores/chat.ts 的 state（activeId / messages / sessions / welcomeAssistantId）。
   *  E 是当前会话，绑 X、模型绑定 group:G——故意与 X 自己的 provider:PX 不同（接力照抄来的、降级后改绑过的就是这样）；
   *  D 排在列表第一条、每个字段都与 E 不同：取错会话（比如直接取第一条）的组装会被它揭穿。 */
  type SessionLike = { id: string; title: string; assistantId?: string | null; modelBinding?: string | null };
  const D: SessionLike = { id: 'D', title: '别的会话', assistantId: 'Z', modelBinding: 'provider:PD' };
  const storeLike = (o: { activeId?: string; messages?: unknown[]; sessions?: SessionLike[]; welcomeAssistantId?: string } = {}) => ({
    activeId: 'E',
    messages: [] as unknown[],
    sessions: [D, { id: 'E', title: '甲', assistantId: 'X', modelBinding: 'group:G' }] as SessionLike[],
    welcomeAssistantId: 'X',
    ...o,
  });
  /** 列表里有、但没绑助手的空会话 E——NavRail「新建会话」建出来的就是它，W2b-4 最常走的路。
   *  后端 chat-store getSession 把 NULL 列映射成 undefined，经 JSON 传到渲染端就是缺字段——这是真实形状；
   *  null 一并覆盖（store 里别处若写进 null、或后端改成原样返回 NULL 列，都不能被当成「绑了」）。
   *  D 仍排第一、绑着 Z：取错会话的组装照样会被揭穿。 */
  const UNBOUND_E: [string, SessionLike][] = [
    ['缺字段', { id: 'E', title: '新会话' }],
    ['字段为 null', { id: 'E', title: '新会话', assistantId: null, modelBinding: null }],
  ];

  it('空会话 E 绑 X、绑定 group:G，卡片改选 Y → 组装出 E 的真实状态；assistantToApply = \'Y\'，胶囊预告 Y 的绑定', async () => {
    const { applyStateOf, assistantToApply, previewBinding } = await loadWelcome();
    const st = storeLike({ welcomeAssistantId: 'Y' });
    expect(applyStateOf(st)).toEqual({ activeId: 'E', hasMessages: false, boundAssistantId: 'X', selected: 'Y', sessionBinding: 'group:G' });
    expect(assistantToApply(applyStateOf(st))).toBe('Y');
    expect(previewBinding(applyStateOf(st), ASSTS)).toBe('provider:PY');
  });

  it('选择仍是 X（open 镜像来的）→ 不动；胶囊显示会话自己的 group:G，不是助手 X 的 provider:PX', async () => {
    const { applyStateOf, assistantToApply, previewBinding } = await loadWelcome();
    const st = storeLike();
    expect(applyStateOf(st)).toEqual({ activeId: 'E', hasMessages: false, boundAssistantId: 'X', selected: 'X', sessionBinding: 'group:G' });
    expect(assistantToApply(applyStateOf(st))).toBeNull();
    expect(previewBinding(applyStateOf(st), ASSTS)).toBe('group:G');
  });

  it('会话已有消息 → hasMessages 为真、不动，哪怕选择与绑定不一致；胶囊显示会话自己的绑定', async () => {
    const { applyStateOf, assistantToApply, previewBinding } = await loadWelcome();
    const st = storeLike({ messages: [{ id: 'm1', role: 'user', text: '你好' }], welcomeAssistantId: 'Y' });
    expect(applyStateOf(st)).toEqual({ activeId: 'E', hasMessages: true, boundAssistantId: 'X', selected: 'Y', sessionBinding: 'group:G' });
    expect(assistantToApply(applyStateOf(st))).toBeNull();
    expect(previewBinding(applyStateOf(st), ASSTS)).toBe('group:G');
  });

  it('空会话上取消选择（\'\'）→ 解绑，胶囊回默认', async () => {
    const { applyStateOf, assistantToApply, previewBinding } = await loadWelcome();
    const st = storeLike({ welcomeAssistantId: '' });
    expect(applyStateOf(st)).toEqual({ activeId: 'E', hasMessages: false, boundAssistantId: 'X', selected: '', sessionBinding: 'group:G' });
    expect(assistantToApply(applyStateOf(st))).toBe('');
    expect(previewBinding(applyStateOf(st), ASSTS)).toBe('');
  });

  it('没有会话（activeId \'\'）→ 会话侧字段取空，交给建会话分支；胶囊看所选助手的绑定', async () => {
    const { applyStateOf, assistantToApply, previewBinding } = await loadWelcome();
    const st = storeLike({ activeId: '', welcomeAssistantId: 'Y' });
    expect(applyStateOf(st)).toEqual({ activeId: '', hasMessages: false, boundAssistantId: '', selected: 'Y', sessionBinding: '' });
    expect(assistantToApply(applyStateOf(st))).toBeNull();
    expect(previewBinding(applyStateOf(st), ASSTS)).toBe('provider:PY');
  });

  it('activeId 指向列表里还没有的会话（刚建、列表还没重拉）→ 当作未绑：boundAssistantId 与 sessionBinding 都是 \'\'', async () => {
    const { applyStateOf, assistantToApply } = await loadWelcome();
    const st = storeLike({ activeId: 'NEW', welcomeAssistantId: 'Y' });
    expect(applyStateOf(st)).toEqual({ activeId: 'NEW', hasMessages: false, boundAssistantId: '', selected: 'Y', sessionBinding: '' });
    expect(assistantToApply(applyStateOf(st))).toBe('Y');
  });

  // W2b-4b 审查补：上面「未绑」只来自找不到会话。列表里找得到、但会话本身没绑的这条路此前没有一例——
  // 把未绑会话当成「绑了卡片上选的那个」（bound 恒等于 selected：永不套用），或给它一个非空的会话绑定
  // （胶囊不再预告所选助手的模型），都能全绿，W2b-4 的两个谎在最常走的路上一起回来
  for (const [label, e] of UNBOUND_E) {
    it(`列表里的空会话 E 没绑助手（${label}）、卡片选 X → 会话侧字段取空；套用 X，胶囊预告 X 的 provider:PX`, async () => {
      const { applyStateOf, assistantToApply, previewBinding } = await loadWelcome();
      const st = storeLike({ sessions: [D, e], welcomeAssistantId: 'X' });
      expect(applyStateOf(st)).toEqual({ activeId: 'E', hasMessages: false, boundAssistantId: '', selected: 'X', sessionBinding: '' });
      expect(assistantToApply(applyStateOf(st))).toBe('X');
      expect(previewBinding(applyStateOf(st), ASSTS)).toBe('provider:PX');
    });

    it(`列表里的空会话 E 没绑助手（${label}）、没选 → 不动，胶囊显示默认（''）`, async () => {
      const { applyStateOf, assistantToApply, previewBinding } = await loadWelcome();
      const st = storeLike({ sessions: [D, e], welcomeAssistantId: '' });
      expect(applyStateOf(st)).toEqual({ activeId: 'E', hasMessages: false, boundAssistantId: '', selected: '', sessionBinding: '' });
      expect(assistantToApply(applyStateOf(st))).toBeNull();
      expect(previewBinding(applyStateOf(st), ASSTS)).toBe('');
    });
  }

  it('与 AppShell 的 inChat 同一判据：会话页（有会话且有消息）上组装出的状态永远不触发套用；欢迎页上的空会话照常套用', async () => {
    const { applyStateOf, assistantToApply } = await loadWelcome();
    // E 绑 X 的列表，与 E 未绑的两种写法各走一遍
    const lists: [string, SessionLike[] | undefined][] = [['X', undefined], ...UNBOUND_E.map(([, e]): [string, SessionLike[]] => ['', [D, e]])];
    for (const [bound, sessions] of lists) {
      for (const activeId of ['', 'E']) {
        for (const messages of [[], [{ id: 'm1' }]]) {
          for (const welcomeAssistantId of ['', 'X', 'Y', 'Z']) {
            const st = storeLike({ activeId, messages, welcomeAssistantId, ...(sessions ? { sessions } : {}) });
            // 与 AppShell.vue 的 inChat 同式（AppShell 那一侧由下方「send」一例的源码守卫钉住）
            const inChat = !!st.activeId && st.messages.length > 0;
            expect(applyStateOf(st).hasMessages).toBe(st.messages.length > 0);
            expect(applyStateOf(st).boundAssistantId).toBe(activeId ? bound : '');
            if (inChat) expect(assistantToApply(applyStateOf(st))).toBeNull();
            // 欢迎页上的空会话 E：选择与会话的绑定不一致就套用 / 解绑，一致就不动
            if (!inChat && activeId) expect(assistantToApply(applyStateOf(st))).toBe(welcomeAssistantId !== bound ? welcomeAssistantId : null);
          }
        }
      }
    }
  });
});

// ─────────── store 行为（pinia + mock rpc） ───────────
function stubRpc(sessions: any[]) {
  rpcCallMock.mockImplementation(async (m: string, p?: any) => {
    if (m === 'chat.sessions.list') return sessions;
    if (m === 'chat.messages.list') return [];
    if (m === 'skills.list') return [];
    if (m === 'chat.annotations.list') return { annotations: [] };
    if (m === 'workspace.get') return { root: '/ws', isDefault: true };
    if (m === 'chat.sessions.create') {
      const s = { id: `N${sessions.length}`, title: '新会话', ...(p?.assistantId ? { assistantId: p.assistantId } : {}) };
      sessions.unshift(s);
      return s;
    }
    if (m === 'chat.sessions.applyAssistant') return { id: p.sessionId };
    if (m === 'chat.sessions.delete') { sessions.splice(0, sessions.length, ...sessions.filter(s => s.id !== p.sessionId)); return { ok: true }; }
    return undefined;
  });
}
const methods = (): string[] => rpcCallMock.mock.calls.map(c => String(c[0]));

beforeEach(() => { rpcCallMock.mockReset(); setActivePinia(createPinia()); });

describe('store — 选择态镜像会话绑定', () => {
  it('open() 换到已绑助手的会话：welcomeAssistantId 取会话的 assistantId（不再清成 \'\'）；换到未绑的会话 → \'\'', async () => {
    stubRpc([{ id: 'E', title: '写手甲', assistantId: 'X' }, { id: 'F', title: '新会话' }]);
    const chat = useChat();
    await chat.refreshSessions();
    await chat.open('E');
    expect(chat.welcomeAssistantId).toBe('X');
    await chat.open('F');
    expect(chat.welcomeAssistantId).toBe('');
  });

  it('同一会话的自刷新（turnEnd / error 后的 open(activeId)）不覆盖刚点的选择', async () => {
    stubRpc([{ id: 'F', title: '新会话' }]);
    const chat = useChat();
    await chat.refreshSessions();
    await chat.open('F');
    chat.welcomeAssistantId = 'Y';
    await chat.open('F');
    expect(chat.welcomeAssistantId).toBe('Y');
  });

  it('选中的助手被删掉（助手页或别的窗口删的）：选择回落到会话自己绑的助手——否则卡片不亮、胶囊说默认，发送却去套用一个不存在的助手，每发一次失败一次', async () => {
    stubRpc([{ id: 'E', title: '新会话' }, { id: 'F', title: '写手甲', assistantId: 'DEAD' }]);
    let list = [{ id: 'X', name: '甲' }, { id: 'Y', name: '乙' }];
    const base = rpcCallMock.getMockImplementation()!;
    rpcCallMock.mockImplementation(async (m: string, p?: any) => (m === 'assistants.list' ? list : base(m, p)));
    const chat = useChat();
    await chat.refreshSessions();
    await chat.refreshAssistants();
    await chat.open('E');
    chat.welcomeAssistantId = 'Y';
    list = [{ id: 'X', name: '甲' }];
    await chat.refreshAssistants();
    expect(chat.welcomeAssistantId).toBe('');
    // 没有会话时同理：回到「没选」，不再按已删的助手建会话
    chat.activeId = ''; chat.welcomeAssistantId = 'GONE';
    await chat.refreshAssistants();
    expect(chat.welcomeAssistantId).toBe('');
    // 会话绑的助手本身已删、选择是它的镜像：保持镜像（bound === selected，不触发套用）
    await chat.open('F');
    expect(chat.welcomeAssistantId).toBe('DEAD');
    await chat.refreshAssistants();
    expect(chat.welcomeAssistantId).toBe('DEAD');
  });

  it('删掉最后一个会话、落到无会话的欢迎页：选择清空，不把已删会话的助手带过去', async () => {
    stubRpc([{ id: 'E', title: '写手甲', assistantId: 'X' }]);
    const chat = useChat();
    await chat.refreshSessions();
    await chat.open('E');
    expect(chat.welcomeAssistantId).toBe('X');
    await chat.deleteSession('E');
    expect(chat.activeId).toBe('');
    expect(chat.welcomeAssistantId).toBe('');
  });
});

describe('store — applyAssistantToSession / ensureSession', () => {
  it('applyAssistantToSession 调 chat.sessions.applyAssistant，随后重拉会话列表与技能', async () => {
    stubRpc([{ id: 'E', title: '新会话' }]);
    const chat = useChat();
    chat.activeId = 'E';
    await chat.applyAssistantToSession('E', 'X');
    expect(rpcCallMock).toHaveBeenCalledWith('chat.sessions.applyAssistant', { sessionId: 'E', assistantId: 'X' });
    // refreshSkills 是 void 出去的，但它的 rpc.call 在调用当下就发出了，await 回来时已记在账上
    const ms = methods();
    const iApply = ms.indexOf('chat.sessions.applyAssistant');
    expect(iApply).toBeGreaterThan(-1);
    expect(ms.indexOf('chat.sessions.list', iApply)).toBeGreaterThan(iApply);
    expect(ms.indexOf('skills.list', iApply)).toBeGreaterThan(iApply);
  });

  it('applyAssistantToSession 失败原样抛给调用方（输入卡据此说「套用助手失败」并留住文字）', async () => {
    rpcCallMock.mockImplementation(async (m: string) => {
      if (m === 'chat.sessions.applyAssistant') throw new Error('会话已有消息');
      return [];
    });
    const chat = useChat();
    await expect(chat.applyAssistantToSession('E', 'X')).rejects.toThrow('会话已有消息');
  });

  it('ensureSession：无会话且选了 X → chat.sessions.create {assistantId:\'X\'}，建好后选择仍是 X', async () => {
    stubRpc([]);
    const chat = useChat();
    chat.welcomeAssistantId = 'X';
    await chat.ensureSession();
    expect(rpcCallMock).toHaveBeenCalledWith('chat.sessions.create', { assistantId: 'X' });
    expect(chat.activeId).not.toBe('');
    expect(chat.welcomeAssistantId).toBe('X');
  });

  it('ensureSession：无会话、没选 → chat.sessions.create {}；已有会话 → 什么也不建', async () => {
    stubRpc([]);
    const chat = useChat();
    await chat.ensureSession();
    expect(rpcCallMock).toHaveBeenCalledWith('chat.sessions.create', {});
    rpcCallMock.mockClear();
    await chat.ensureSession();
    expect(methods()).not.toContain('chat.sessions.create');
  });
});

describe('applyStateOf 吃真 store：字段名与 stores/chat.ts 对得上', () => {
  it('open(E) 后在卡片上改选 Y：取的是 E 的助手与绑定、卡片上的选择；会话有了消息 hasMessages 随之为真', async () => {
    stubRpc([
      { id: 'D', title: '别的会话', assistantId: 'Z', modelBinding: 'provider:PD' },
      { id: 'E', title: '甲', assistantId: 'X', modelBinding: 'group:G' },
    ]);
    const { applyStateOf } = await loadWelcome();
    const chat = useChat();
    await chat.refreshSessions();
    await chat.open('E');
    chat.welcomeAssistantId = 'Y';
    // 直接把 store 实例传进去——输入卡就是这么调的；typecheck 也经这一行把 store 的形状钉在参数类型上
    expect(applyStateOf(chat)).toEqual({ activeId: 'E', hasMessages: false, boundAssistantId: 'X', selected: 'Y', sessionBinding: 'group:G' });
    chat.messages = [{ id: 'm1', role: 'user', parts: [] }];
    expect(applyStateOf(chat).hasMessages).toBe(true);
  });

  it('open 未绑的空会话（F 缺字段——后端的真实形状；G 字段为 null）后点 X：会话侧字段取空，要套用 X', async () => {
    stubRpc([
      { id: 'D', title: '别的会话', assistantId: 'Z', modelBinding: 'provider:PD' },
      { id: 'F', title: '新会话' },
      { id: 'G', title: '新会话', assistantId: null, modelBinding: null },
    ]);
    const { applyStateOf, assistantToApply } = await loadWelcome();
    const chat = useChat();
    await chat.refreshSessions();
    for (const id of ['F', 'G']) {
      await chat.open(id);
      expect(chat.welcomeAssistantId).toBe('');
      chat.welcomeAssistantId = 'X';
      expect(applyStateOf(chat)).toEqual({ activeId: id, hasMessages: false, boundAssistantId: '', selected: 'X', sessionBinding: '' });
      expect(assistantToApply(applyStateOf(chat))).toBe('X');
    }
  });
});

// ─────────── 源码守卫（.vue 不在 typecheck 覆盖内；脚本段先剥注释） ───────────
describe('Composer / WorkspacePanel 接线', () => {
  const composer = script('ui/Composer.vue');
  const sendBody = bodyOf(composer, 'async function send()');
  const saveBody = bodyOf(composer, 'async function saveImages(');

  it('三个纯函数都从 lib/welcome/assistant 原名导入，组件里没有同名的本地定义把它们顶掉', () => {
    const imp = /import \{([^}]*)\} from '\.\.\/lib\/welcome\/assistant'/.exec(composer)?.[1] ?? '';
    for (const n of ['assistantToApply', 'applyStateOf', 'previewBinding']) expect(imp).toMatch(new RegExp(`\\b${n}\\b`));
    expect(imp).not.toMatch(/\bas\b/);
    expect(composer).not.toMatch(/\b(?:function|const|let|var)\s+(?:assistantToApply|applyStateOf|previewBinding)\b/);
    expect(composer).toMatch(/const chat = useChat\(\);/);
  });

  it('send：已有会话时先按 assistantToApply 套用 / 解绑，失败写「套用助手失败：」并 return（文字留在框里）', () => {
    // W2b-4b：入参由纯模块 applyStateOf 从 store 组装（字段逐个由上方单测钉住），这里认调用形态——
    // 就地改写入参（比如把 boundAssistantId 换成 welcomeAssistantId，永远不套用）必须红，所以连 want 的去向一起锚
    expect(sendBody).toMatch(/const want = assistantToApply\(applyStateOf\(chat\)\);\s*if \(want !== null\) \{\s*try \{ await chat\.applyAssistantToSession\(chat\.activeId, want\); \}/);
    expect(composer.match(/\bassistantToApply\(/g) ?? []).toHaveLength(1);
    expect(sendBody).toMatch(/catch \(e\) \{\s*chat\.lastError = `套用助手失败：\$\{[^}]+\}`;\s*return;/);
    // W2b-4b 审查补：上面只钉了 want 这一段的写法，没钉它在哪个分支里——`} else {` 改成 `} else if (false) {`，
    // 或把整段挪进「没有会话就建」的分支末尾（那里建会话前 activeId 是空的，新会话的绑定又已等于选择，永远不套用），
    // 都照样全绿，NavRail「新建会话」→ 点甲 → 发送又不套用。所以按花括号配对把分叉的结构钉死：
    // send 的 try 体一开头就是 `if (!chat.activeId) {`，它配对的 `}` 后面紧跟不带条件的 `else {`，
    // 而这个 else 的整个分支体恰好就是 want 这一段（空白压成一格后逐字比对）
    // W2b-4b 第二次审查补：从这条正则命中的那个 `{` 起配对。原来取的是第一个 `if (!chat.activeId) {`，try 前面放一段
    // 形状相同的 if (false) { … } 死代码，钉住的就成了死代码的分叉（审查沙箱变异 deadcode-decoy-before-try，实测全绿）
    const tryIf = /sending\.value = true;\s*try \{\s*if \(!chat\.activeId\) \{/.exec(sendBody);
    expect(tryIf, 'send 的 try 体一开头必须是 if (!chat.activeId) {').not.toBeNull();
    const ifClose = closeOf(sendBody, tryIf!.index + tryIf![0].length - 1);
    const elseHead = /^\s*else \{/.exec(sendBody.slice(ifClose + 1));
    expect(elseHead?.[0], '「没有会话就建」分支后面必须紧跟不带条件的 else').toBeDefined();
    const elseOpen = ifClose + elseHead![0].length;
    const elseBody = sendBody.slice(elseOpen + 1, closeOf(sendBody, elseOpen)).replace(/\s+/g, ' ').trim();
    expect(elseBody).toMatch(/^const want = assistantToApply\(applyStateOf\(chat\)\); if \(want !== null\) \{ try \{ await chat\.applyAssistantToSession\(chat\.activeId, want\); \} catch \(e\) \{ chat\.lastError = `套用助手失败：\$\{[^}]+\}`; return; \} \}$/);
    // 判据与 AppShell 的 inChat 一致：hasMessages 在 applyStateOf 里（单测「与 AppShell 的 inChat 同一判据」），AppShell 这一侧钉在这里
    expect(script('ui/AppShell.vue')).toMatch(/const inChat = computed\(\(\) => !!chat\.activeId && chat\.messages\.length > 0\)/);
  });

  it('send：套用在寄存草稿、清空输入框之前；「没有会话就建」的分支原样保留', () => {
    const iApply = sendBody.indexOf('await chat.applyAssistantToSession(');
    const iPark = sendBody.indexOf('chat.draft = { text: text.value, attachments: atts.value }');
    expect(iApply).toBeGreaterThan(-1);
    expect(iPark).toBeGreaterThan(iApply);
    expect(sendBody).toMatch(/if \(chat\.welcomeAssistantId\) await chat\.newSessionWithAssistant\(chat\.welcomeAssistantId\);\s*else await chat\.newSession\(\);/);
  });

  it('saveImages：贴图隐式建会话走 ensureSession（按选择建），不再直接 newSession；catch 体不变', () => {
    expect(saveBody).toMatch(/await chat\.ensureSession\(\)/);
    expect(saveBody).not.toMatch(/chat\.newSession\(/);
    expect(saveBody).toMatch(/catch \(e\) \{\s*attErr\.value = `新建会话失败：\$\{[^}]+\}`;\s*return;/);
  });

  it('胶囊的绑定走 previewBinding：发送前就显示发送后真正生效的模型', () => {
    // W2b-4b：与 send 吃同一份 applyStateOf(chat)，第二个参数是 store 的助手列表——就地改写入参
    // （比如 sessionBinding 换成 ''、助手列表换成 []，胶囊永远说「默认 · X」）必须红
    expect(composer).toMatch(/const effectiveBinding = computed\(\(\) => previewBinding\(applyStateOf\(chat\), chat\.assistants\)\);/);
    expect(composer.match(/\bpreviewBinding\(/g) ?? []).toHaveLength(1);
    expect(composer).toMatch(/describeBinding\(effectiveBinding\.value, chat\.providers, chat\.modelGroups, chat\.defaultProviderId\)/);
  });

  it('WorkspacePanel：删掉本地 ensureSession，两处都走 store 的 chat.ensureSession()', () => {
    const ws = script('ui/WorkspacePanel.vue');
    expect(ws).not.toMatch(/function ensureSession\(/);
    expect(ws.match(/await chat\.ensureSession\(\)/g) ?? []).toHaveLength(2);
    expect(ws).not.toMatch(/chat\.newSession\(/);
  });
});
