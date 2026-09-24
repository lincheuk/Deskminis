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
import { stripComments } from './strip-comments';

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
/** .vue 的脚本段剥注释（/* *\/ 与 // 行）：断言认调用形态，注释里写得再多也喂不饱（交接 §2 第 10 条）。 */
const script = (p: string): string => {
  const src = read(p);
  return stripComments(src.slice(src.indexOf('<script'), src.indexOf('</script>')));
};
/** 从 head 起按花括号配对取函数体（源码已剥注释；这里的函数体内字符串的花括号都成对）。 */
function bodyOf(src: string, head: string): string {
  const i = src.indexOf(head);
  expect(i, `找不到 ${head}`).toBeGreaterThan(-1);
  const open = src.indexOf('{', src.indexOf(')', i));
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(open + 1, k); }
  }
  throw new Error(`${head} 的花括号没有配平`);
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

// ─────────── 源码守卫（.vue 不在 typecheck 覆盖内；脚本段先剥注释） ───────────
describe('Composer / WorkspacePanel 接线', () => {
  const composer = script('ui/Composer.vue');
  const sendBody = bodyOf(composer, 'async function send()');
  const saveBody = bodyOf(composer, 'async function saveImages(');

  it('send：已有会话时先按 assistantToApply 套用 / 解绑，失败写「套用助手失败：」并 return（文字留在框里）', () => {
    expect(composer).toMatch(/import \{[^}]*\bassistantToApply\b[^}]*\} from '\.\.\/lib\/welcome\/assistant'/);
    expect(sendBody).toMatch(/assistantToApply\(/);
    expect(sendBody).toMatch(/await chat\.applyAssistantToSession\(chat\.activeId, /);
    expect(sendBody).toMatch(/catch \(e\) \{\s*chat\.lastError = `套用助手失败：\$\{[^}]+\}`;\s*return;/);
    // 判据与 AppShell 的 inChat 一致：有消息才算会话页（状态由 applyState() 统一组装，胶囊的 previewBinding 用同一份）
    expect(sendBody).toMatch(/assistantToApply\(applyState\(\)\)/);
    expect(composer).toMatch(/hasMessages: chat\.messages\.length > 0/);
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
    expect(composer).toMatch(/const effectiveBinding = computed\(\(\) => previewBinding\(/);
    expect(composer).toMatch(/describeBinding\(effectiveBinding\.value, chat\.providers, chat\.modelGroups, chat\.defaultProviderId\)/);
  });

  it('WorkspacePanel：删掉本地 ensureSession，两处都走 store 的 chat.ensureSession()', () => {
    const ws = script('ui/WorkspacePanel.vue');
    expect(ws).not.toMatch(/function ensureSession\(/);
    expect(ws.match(/await chat\.ensureSession\(\)/g) ?? []).toHaveLength(2);
    expect(ws).not.toMatch(/chat\.newSession\(/);
  });
});
