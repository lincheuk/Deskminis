/**
 * W2a-6 · 溢出与压缩失败的界面（止血设计稿 §3 第 2–5 条、§4 W2a-6；侦察 renderer.md「W2a-overflow-ui」与
 * engine.md「W2a-overflow」的渲染条目；cross.md S21 及 corrections 里统一后的契约）。
 *
 * 引擎侧（W2a-2、W2a-3）已经按 code 发事件，渲染端还是一套旧处理：
 *   ① 所有 error 一律 retryable:true——「上下文已满」原地重试必然再满，绑定错误重试必然再 400，重试钮是空头支票；
 *   ② 错误短句对整条报文跑状态码正则：绑定错误的 message 后半是原始 400 响应体，里面一个独立的 5xx 三位数
 *      就被说成「模型服务暂时不可用」；「上下文已满（已用 512 / 200000）」同样被认成 512；
 *   ③ 因超窗降级到更大窗口时，短句仍是笼统的「已切换到备选模型」，不说为什么、改用了谁；
 *   ④ 引擎给了接力草稿（relayDraft），界面没有任何入口能用上它。
 *
 * 本文件钉（两份侦察守卫 renderer-context-full / renderer-overflow-relay 合并于此）：
 *   - copy.ts 先按事件 code 选短句；未带 code 的溢出文案在 5xx 正则之前认出来；
 *   - store：contextFull 不给重试、给接力（relay:true），草稿留在 relaySource，不放进可被输入卡消费的 relayDraft；
 *     thinkingBinding 不给重试；普通错误照旧可重试；fallback 带 cause 时短句写明「因上下文已满改用 X」；
 *   - relayToNewSession：继承助手（还在的话）、模型绑定与工作区语义（原会话设过目录就照抄；原会话是默认沙箱、或目录已不在，
 *     新会话回到自己的沙箱，不落在别的会话选的 lastUsed）；relayDraft = {sessionId: 新会话, text} 在 open() 之前写好；
 *     建出会话后的继承步骤尽力而为，失败照样落到新会话并说明；建会话本身失败如实报错、可再点；
 *     会话已建出而切过去失败时，再点只切过去、不再新建；并发连点只建一个会话；
 *   - 源码守卫：EventNotes 的接力钮接线、Composer 只在 setup 里按 sessionId === activeId 消费（不用 watch、不自动发送；
 *     按引用次数钉，不认某一种 watch 写法）；渲染端组件里只有 Composer 碰 relayDraft / relaySource。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';

// ── 桩掉 renderer 的 rpc：call 走可控实现并记账，on 把处理器收进 handlers，测试里直接派发广播 ──
const { rpcCallMock, handlers, calls } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
  handlers: new Map<string, (p: any) => void>(),
  calls: [] as { method: string; params: any; relayDraft?: unknown }[],
}));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: rpcCallMock,
    connect: async () => {},
    on: (method: string, h: (p: any) => void) => { handlers.set(method, h); },
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import * as copy from '../src/renderer/src/lib/eventnote/copy';

const SRC = join(__dirname, '../src/renderer/src/');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

/** .vue 拆三段并各自剥注释：模板剥 <!-- -->，脚本剥 /* *\/ 与 // 行（交接 §2 第 10 条：断言不能被注释喂饱）。 */
function sfc(p: string): { script: string; tpl: string; css: string } {
  const src = read(p);
  const script = stripComments(src.slice(src.indexOf('<script'), src.indexOf('</script>')));
  const tpl = src.slice(src.indexOf('<template>'), src.lastIndexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '');
  const css = src.includes('<style') ? src.slice(src.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '') : '';
  return { script, tpl, css };
}

/** 从 head 之后参数表收尾的 `) {` / `): T {` 起按花括号配对取出函数体
 *  （参数类型里的 `{ … }` 不算函数体；源码已剥注释；这里的函数体内没有含花括号的字符串）。 */
function bodyFrom(src: string, head: string): string {
  const i = src.indexOf(head);
  expect(i, `找不到 ${head}`).toBeGreaterThan(-1);
  const m = /\)\s*(?::\s*[^{;]+)?\{/g;
  m.lastIndex = i;
  const hit = head.endsWith('{') ? null : m.exec(src);
  const open = head.endsWith('{') ? i + head.length - 1 : hit!.index + hit![0].length - 1;
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(open + 1, k); }
  }
  throw new Error(`${head} 的花括号没有配平`);
}

// ─────────── 桩：两个会话 A / B，A 带助手、组绑定与自定义工作区；桩的后端语义对齐 minisd/index.ts（见 Stub 各项注释） ───────────
type Stub = {
  createFails?: string; createBinding?: string; createDelayMs?: number;
  sourceA?: Record<string, unknown>; wsA?: { root: string; isDefault: boolean };
  /** 还在的助手 id（缺省只有 as1）。后端 create 对查不到的 assistantId 抛「助手不存在」（minisd/index.ts chat.sessions.create）。 */
  assistants?: string[];
  /** settings 里的 workspace.lastUsed：后端建会话一律拿它当新会话的工作区根（chat-store createSession），create 的返回里带 workspaceRoot。 */
  lastUsed?: string;
  wsSetFails?: string; bindFails?: string; resetFails?: string;
};

let sessions: any[] = [];
/** 下一次调用该方法时抛一次（给「建出会话之后的某一步失败」用；boot 之后再设，免得打在 init 上）。 */
const failNext: Record<string, string> = {};

function stubRpc(o: Stub = {}): void {
  calls.length = 0;
  sessions = [
    { id: 'A', title: 'A', assistantId: 'as1', modelBinding: 'group:G1', ...(o.sourceA ?? {}) },
    { id: 'B', title: 'B' },
  ];
  rpcCallMock.mockImplementation(async (method: string, params: any) => {
    // 记下每次调用发生时 relayDraft 的快照：钉「open 之前就写好」靠它
    calls.push({ method, params, relayDraft: JSON.parse(JSON.stringify(useChat().relayDraft ?? null)) });
    if (failNext[method]) { const m = failNext[method]; delete failNext[method]; throw new Error(m); }
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return sessions.map(s => ({ ...s }));
    if (method === 'provider.instances.list') return [];
    if (method === 'provider.getDefault') return {};
    if (method === 'modelgroup.list') return [];
    if (method === 'assistants.list') return (o.assistants ?? ['as1']).map((id, i) => ({ id, name: id, avatar: '', rules: '', skillIds: [], prompts: [], sortOrder: i }));
    if (method === 'skills.list') return [];
    if (method === 'control.status') return { syncPaused: false };
    if (method === 'chat.messages.list') {
      return params?.sessionId === 'N' ? [] : [{ id: 'u1', role: 'user', parts: [{ type: 'text', value: '上一条' }], createdAt: 1 }];
    }
    if (method === 'chat.annotations.list') return { annotations: [] };
    if (method === 'chat.contextInfo') return { windowTokens: 1, usedTokens: 0, remaining: 1 };
    if (method === 'workspace.get') {
      if (params?.sessionId === 'A') return o.wsA ?? { root: '/proj', isDefault: false };
      return { root: `/bucket/${params?.sessionId}`, isDefault: true };
    }
    if (method === 'chat.sessions.create') {
      if (o.createDelayMs) await new Promise(r => setTimeout(r, o.createDelayMs));
      if (o.createFails) throw new Error(o.createFails);
      if (params?.assistantId !== undefined && !(o.assistants ?? ['as1']).includes(params.assistantId)) {
        throw new Error(`助手不存在: ${params.assistantId}`);
      }
      const s: any = { id: 'N', title: '新会话' };
      if (o.lastUsed) s.workspaceRoot = o.lastUsed;
      if (params?.assistantId) { s.assistantId = params.assistantId; s.modelBinding = o.createBinding ?? 'provider:P-from-assistant'; }
      sessions = [s, ...sessions];
      return s;
    }
    if (method === 'chat.sessions.setModelBinding') {
      if (o.bindFails) throw new Error(o.bindFails);
      const s = sessions.find(x => x.id === params.sessionId);
      if (s) { if (params.binding) s.modelBinding = params.binding; else delete s.modelBinding; }
      return { ok: true };
    }
    if (method === 'workspace.set') {
      if (o.wsSetFails) throw new Error(o.wsSetFails);
      return { root: params.root, isDefault: false };
    }
    if (method === 'workspace.reset') {
      if (o.resetFails) throw new Error(o.resetFails);
      return { root: `/bucket/${params?.sessionId}`, isDefault: true };
    }
    return undefined;
  });
}

async function boot(o: Stub = {}) {
  stubRpc(o);
  const chat = useChat();
  await chat.init();
  await chat.open('A');
  calls.length = 0;
  return chat;
}

/** 模拟 minisd 的 chat.event 广播（index.ts 的 run IIFE 发出的形态）。 */
function emit(sessionId: string, event: Record<string, unknown>): void {
  const h = handlers.get('chat.event');
  if (!h) throw new Error('init() 没有订阅 chat.event');
  h({ sessionId, event });
}

const FULL_MSG = '上下文已满：当前模型放不下这段对话，可新建会话用摘要接力';
const DRAFT = '接续上一个会话（上下文已满）。\n\n之前对话的摘要：\nS1\n\n我最后的请求是：\nU-last';
// 绑定错误的 message：中文说明在前，原始 400 响应体在后——响应体里有一个独立的 503
const BINDING_MSG = 'Claude 拒绝回放历史思考块：对话前缀校验未通过，换模型无法解决。请新建会话继续；如在用第三方中转，可改用官方端点。'
  + '（原始错误：Anthropic HTTP 400: {"type":"error","error":{"message":"The block is bound to a different conversation (block 503)"}}）';

beforeEach(() => {
  setActivePinia(createPinia());
  rpcCallMock.mockReset();
  handlers.clear();
  calls.length = 0;
  for (const k of Object.keys(failNext)) delete failNext[k];
});

// ═══════════════════════════ copy.ts：先按 code 选短句 ═══════════════════════════
describe('copy.ts：带分类码的事件先按 code 选短句，不对原始报文跑状态码正则', () => {
  it('errorShortByCode：contextFull / thinkingBinding 各有一句；其它 code 与缺省返回 undefined', () => {
    expect(copy.errorShortByCode('contextFull')).toBe('上下文已满，当前模型放不下这段对话');
    expect(copy.errorShortByCode('thinkingBinding')).toBe('Claude 拒绝回放历史思考块，请新建会话继续');
    expect(copy.errorShortByCode(undefined)).toBeUndefined();
    expect(copy.errorShortByCode('whatever')).toBeUndefined();
  });

  it('这正是要绕开的坑：同一条绑定报文交给 humanizeError 会被 503 误判', () => {
    expect(copy.humanizeError(BINDING_MSG)).toBe('模型服务暂时不可用（503）');
    expect(copy.errorShortByCode('thinkingBinding')).not.toMatch(/503|暂时不可用/);
  });

  it('fallbackShortByCause：因超窗降级写明「因上下文已满改用 <目标>」；其它原因不给（仍走通用短句）', () => {
    expect(copy.fallbackShortByCause('contextOverflow', '大窗(mock-big)')).toBe('因上下文已满改用 大窗(mock-big)');
    expect(copy.fallbackShortByCause(undefined, '大窗(mock-big)')).toBeUndefined();
  });

  it('humanizeError：没带 code 的溢出文案在 5xx 正则之前认出来', () => {
    expect(copy.humanizeError('上下文已满（已用 512 / 200000）')).toBe('上下文已满');
    expect(copy.humanizeError('OpenAI HTTP 400: {"error":{"message":"This model\'s maximum context length is 131072 tokens (500 more than allowed)"}}')).toBe('上下文已满');
    expect(copy.humanizeError('OpenAI HTTP 400: context_length_exceeded')).toBe('上下文已满');
    expect(copy.humanizeError('Anthropic HTTP 400: prompt is too long: 213462 tokens > 200000 maximum')).toBe('上下文已满');
    // 回归：401/403/429 仍先判；真 5xx 仍是服务不可用
    expect(copy.humanizeError('HTTP 429 too many tokens')).toBe('请求过频或额度不足');
    expect(copy.humanizeError('HTTP 503 Service Unavailable')).toBe('模型服务暂时不可用（503）');
  });
});

// ═══════════════════════════ store：按 code 分流 ═══════════════════════════
describe('store.onEvent：error 按 code 分流、fallback 按 cause 给短句', () => {
  it('contextFull：不给重试、给接力；草稿进 relaySource（不是 relayDraft，旧会话的输入卡不能把它取走）', async () => {
    const chat = await boot();
    emit('A', { kind: 'textDelta', text: '半截' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    const n = chat.eventNotes.at(-1)!;
    expect(n.kind).toBe('error');
    expect(n.retryable).toBe(false);
    expect(n.relay).toBe(true);
    expect(n.short).toBe('上下文已满，当前模型放不下这段对话');
    expect(n.detail).toBe(FULL_MSG);
    expect(chat.relaySource).toEqual({ sessionId: 'A', text: DRAFT });
    expect(chat.relayDraft).toBeNull();
    expect(chat.running).toBe(false);
    expect(chat.lastError).toBe(FULL_MSG);
  });

  it('contextFull 没带草稿：仍不给重试，也不给一个点了没东西可接的接力钮', async () => {
    const chat = await boot();
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG });
    const n = chat.eventNotes.at(-1)!;
    expect(n.retryable).toBe(false);
    expect(n.relay).toBeFalsy();
    expect(chat.relaySource).toBeNull();
  });

  it('thinkingBinding：不给重试（历史不变，重发必然同样 400）；短句按 code 选，不被响应体里的 503 带偏', async () => {
    const chat = await boot();
    emit('A', { kind: 'error', code: 'thinkingBinding', message: BINDING_MSG });
    const n = chat.eventNotes.at(-1)!;
    expect(n.retryable).toBe(false);
    expect(n.relay).toBeFalsy();
    expect(n.short).toBe('Claude 拒绝回放历史思考块，请新建会话继续');
    expect(n.detail).toBe(BINDING_MSG); // 原文完整留在详情里
  });

  it('回归：没带 code 的普通错误照旧可重试，不带接力与短句（短句仍由 EventNotes 现算 humanizeError）', async () => {
    const chat = await boot();
    emit('A', { kind: 'error', message: 'OpenAI HTTP 503: upstream' });
    const n = chat.eventNotes.at(-1)!;
    expect(n.retryable).toBe(true);
    expect(n.relay).toBeFalsy();
    expect(n.short).toBeUndefined();
  });

  it('fallback 带 cause:contextOverflow：短句「因上下文已满改用 <to>」；不带 cause 的降级不设短句', async () => {
    const chat = await boot();
    emit('A', { kind: 'fallback', from: '小窗(m-small)', to: '大窗(m-big)', reason: '上下文已满', cause: 'contextOverflow' });
    const a = chat.eventNotes.at(-1)!;
    expect(a.kind).toBe('fallback');
    expect(a.short).toBe('因上下文已满改用 大窗(m-big)');
    expect(a.detail).toBe('小窗(m-small) → 大窗(m-big)（上下文已满）');
    emit('A', { kind: 'fallback', from: '主力(p)', to: '备用(b)', reason: 'OpenAI HTTP 429: rate limited' });
    expect(chat.eventNotes.at(-1)!.short).toBeUndefined();
  });
});

// ═══════════════════════════ store：relayToNewSession ═══════════════════════════
describe('store.relayToNewSession：新建会话接力', () => {
  it('继承助手 → 模型绑定 → 自定义工作区；relayDraft 在 open() 取新会话消息之前就写好；不替用户发送', async () => {
    // lastUsed 故意与原会话的目录不同：后端把新会话放在 /elsewhere，要靠 workspace.set 改回 /proj
    const chat = await boot({ lastUsed: '/elsewhere' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();

    const seq = calls.map(c => c.method);
    const iCreate = seq.indexOf('chat.sessions.create');
    const iBind = seq.indexOf('chat.sessions.setModelBinding');
    const iWs = seq.indexOf('workspace.set');
    const iMsgs = calls.findIndex(c => c.method === 'chat.messages.list' && c.params?.sessionId === 'N');
    expect(iCreate).toBeGreaterThan(-1);
    expect(calls[iCreate].params).toEqual({ assistantId: 'as1' });
    // 助手预设给新会话套上了助手自己的绑定（provider:P-from-assistant），原会话绑的是组——照抄原会话的
    expect(calls[iBind].params).toEqual({ sessionId: 'N', binding: 'group:G1' });
    expect(calls[iWs].params).toEqual({ sessionId: 'N', root: '/proj' });
    expect(iCreate).toBeLessThan(iBind);
    expect(iBind).toBeLessThan(iMsgs);
    expect(iWs).toBeLessThan(iMsgs);
    // open(N) 去取消息的那一刻，草稿已经指向新会话：欢迎页新挂的输入卡在 setup 里拿得到
    expect(calls[iMsgs].relayDraft).toEqual({ sessionId: 'N', text: DRAFT });

    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT }); // store 不自己消费，留给输入卡
    expect(chat.relaySource).toBeNull();
    expect(chat.sessions.find(s => s.id === 'N')?.modelBinding).toBe('group:G1');
    expect(seq).not.toContain('workspace.reset'); // 照抄成功就不再动它
    expect(chat.lastError).toBe('');
    expect(seq).not.toContain('chat.prompt'); // 不自动发送
  });

  it('原会话无助手、无绑定、默认工作区：create 不带参数，不调 setModelBinding，也不设工作区', async () => {
    const chat = await boot({ sourceA: { assistantId: undefined, modelBinding: undefined }, wsA: { root: '/bucket/A', isDefault: true } });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    const seq = calls.map(c => c.method);
    expect(calls.find(c => c.method === 'chat.sessions.create')!.params).toEqual({});
    expect(seq).not.toContain('chat.sessions.setModelBinding');
    expect(seq).not.toContain('workspace.set');
    // 后端建出的新会话本来就在默认沙箱（没有 lastUsed），不必 reset
    expect(seq).not.toContain('workspace.reset');
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
  });

  it('原会话用默认沙箱、后端却把新会话放在 lastUsed（别的会话选的目录）：对新会话 workspace.reset，且在 open() 之前', async () => {
    const chat = await boot({ wsA: { root: '/bucket/A', isDefault: true }, lastUsed: '/other-project' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    const seq = calls.map(c => c.method);
    const iReset = calls.findIndex(c => c.method === 'workspace.reset');
    const iMsgs = calls.findIndex(c => c.method === 'chat.messages.list' && c.params?.sessionId === 'N');
    expect(iReset).toBeGreaterThan(-1);
    expect(calls[iReset].params).toEqual({ sessionId: 'N' });
    expect(iReset).toBeLessThan(iMsgs); // open() 里 refreshWorkspace 读到的已是新会话自己的沙箱
    expect(seq).not.toContain('workspace.set');
    expect(chat.activeId).toBe('N');
    expect(chat.workspaceIsDefault).toBe(true);
    expect(chat.lastError).toBe('');
  });

  it('默认沙箱放不回去（reset 失败）：照样落到新会话，并说清楚现在用的是哪个目录', async () => {
    const chat = await boot({ wsA: { root: '/bucket/A', isDefault: true }, lastUsed: '/other-project', resetFails: '数据库只读' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    await chat.relayToNewSession();
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    expect(chat.lastError).toBe('接力会话已建好，但没能把新会话放回默认工作区（数据库只读），现在用的是 /other-project');
  });

  it('原会话绑的助手已被删除（assistant_id 悬空）：不带 assistantId 建会话，接力照常成功，绑定仍照抄原会话', async () => {
    const chat = await boot({ assistants: [] });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    const creates = calls.filter(c => c.method === 'chat.sessions.create');
    expect(creates).toHaveLength(1);
    expect(creates[0].params).toEqual({});
    expect(calls.find(c => c.method === 'chat.sessions.setModelBinding')?.params).toEqual({ sessionId: 'N', binding: 'group:G1' });
    expect(chat.lastError).toBe('');
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
  });

  it('原会话的自定义目录已不存在（workspace.set 抛错）：只建一个会话、照样落到新会话、放回默认沙箱并说明；再点不会再建', async () => {
    const chat = await boot({ wsA: { root: '/gone', isDefault: false }, lastUsed: '/gone', wsSetFails: '目录不存在: /gone' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    await chat.relayToNewSession(); // 用户以为没反应又点一下
    expect(calls.filter(c => c.method === 'chat.sessions.create')).toHaveLength(1);
    // lastUsed 就是那个不存在的目录：不放回沙箱的话，新会话的 shell 会在一个不存在的 cwd 里起
    expect(calls.find(c => c.method === 'workspace.reset')?.params).toEqual({ sessionId: 'N' });
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    expect(chat.relaySource).toBeNull();
    expect(chat.lastError).toBe('接力会话已建好，但原会话的工作区用不了（目录不存在: /gone），新会话改用默认工作区');
  });

  it('模型绑定没能照抄（setModelBinding 抛错）：不拦接力，落到新会话并说明', async () => {
    const chat = await boot({ bindFails: '数据库只读' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    await chat.relayToNewSession();
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    expect(chat.lastError).toBe('接力会话已建好，但没能沿用原会话的模型绑定（数据库只读）');
  });

  it('会话建出后切过去失败（刷新列表抛错）：说明已建好；再点只切到那个会话、不再新建', async () => {
    const chat = await boot({ wsA: { root: '/gone', isDefault: false }, wsSetFails: '目录不存在: /gone' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    failNext['chat.sessions.list'] = '连接中断';
    await chat.relayToNewSession();
    expect(chat.activeId).toBe('A');
    expect(chat.lastError).toBe('接力会话已建好，但没能切过去：连接中断。可在会话列表里打开它，接力文本会自动填进输入框');
    // 草稿仍指向新会话：用户从列表点进去，欢迎页的输入卡照样取得到
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    await chat.relayToNewSession();
    expect(calls.filter(c => c.method === 'chat.sessions.create')).toHaveLength(1);
    expect(calls.filter(c => c.method === 'workspace.set')).toHaveLength(1); // 继承步骤也不重做
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    // 第一次尝试里没跟过来的工作区，切过去以后照样要说
    expect(chat.lastError).toBe('接力会话已建好，但原会话的工作区用不了（目录不存在: /gone），新会话改用默认工作区');
  });

  it('原会话有助手但解绑了模型：新会话被助手预设套上的绑定要解掉（照抄，不是照助手）', async () => {
    const chat = await boot({ sourceA: { modelBinding: undefined } });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    const bind = calls.find(c => c.method === 'chat.sessions.setModelBinding');
    expect(bind?.params).toEqual({ sessionId: 'N', binding: undefined });
    expect(chat.sessions.find(s => s.id === 'N')?.modelBinding).toBeUndefined();
  });

  it('建会话失败：如实报「新建接力会话失败：…」，留在原会话，草稿还在，可以再点', async () => {
    const chat = await boot({ createFails: '数据库只读' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    await chat.relayToNewSession();
    expect(chat.lastError).toBe('新建接力会话失败：数据库只读');
    expect(chat.activeId).toBe('A');
    expect(chat.relayDraft).toBeNull();
    expect(chat.relaySource).toEqual({ sessionId: 'A', text: DRAFT });
  });

  it('连点两下只建一个会话', async () => {
    const chat = await boot({ createDelayMs: 20 });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await Promise.all([chat.relayToNewSession(), chat.relayToNewSession()]);
    expect(calls.filter(c => c.method === 'chat.sessions.create')).toHaveLength(1);
    expect(chat.activeId).toBe('N');
  });

  it('草稿属于别的会话（出事后切走了）时什么也不做', async () => {
    const chat = await boot();
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    await chat.open('B');
    calls.length = 0;
    await chat.relayToNewSession();
    expect(calls.map(c => c.method)).not.toContain('chat.sessions.create');
    expect(chat.activeId).toBe('B');
    expect(chat.relayDraft).toBeNull();
  });
});

// ═══════════════════════════ 源码守卫（剥注释后认调用形态） ═══════════════════════════
describe('源码守卫：接力钮、短句优先、输入卡只在 setup 消费', () => {
  const notes = sfc('ui/EventNotes.vue');
  const composer = sfc('ui/Composer.vue');
  const store = stripComments(read('stores/chat.ts'));

  it('EventNotes：接力钮按 n.relay 出现、点了调 chat.relayToNewSession()；重试钮仍只认 n.retryable', () => {
    expect(notes.tpl).toMatch(/<button v-if="n\.relay" class="rt relay" type="button" @click="chat\.relayToNewSession\(\)">新建会话接力<\/button>/);
    expect(notes.tpl).toMatch(/<button v-if="n\.retryable" class="rt" type="button" @click="chat\.retryLast\(\)">重试<\/button>/);
  });

  it('EventNotes：shortOf 先取 n.short，没有才现算 eventCopy', () => {
    const body = bodyFrom(notes.script, 'function shortOf(');
    const iShort = body.indexOf('if (n.short) return n.short;');
    const iCopy = body.indexOf('eventCopy(');
    expect(iShort).toBeGreaterThan(-1);
    expect(iCopy).toBeGreaterThan(iShort);
  });

  it('EventNotes：接力钮是品牌色，与红色重试钮区分开', () => {
    const m = /\.rt\.relay\s*\{([^}]*)\}/.exec(notes.css);
    expect(m, '缺 .rt.relay 样式').not.toBeNull();
    expect(m![1]).toMatch(/background:\s*var\(--c-brand\)/);
    expect(m![1]).toMatch(/color:\s*var\(--c-brand-ink\)/);
  });

  it('Composer：takeRelay 定义在 quote() 之后（不进 first-send 守卫的 sendBody 切片），setup 顶层调用一次', () => {
    const iQuote = composer.script.indexOf('\nfunction quote(');
    const iDef = composer.script.indexOf('\nfunction takeRelay(): void {');
    expect(iQuote).toBeGreaterThan(-1);
    expect(iDef).toBeGreaterThan(iQuote);
    // 顶层调用：行首、不缩进（缩进的调用在某个函数体里，不是 setup 时跑）
    expect(composer.script).toMatch(/^takeRelay\(\);$/m);
  });

  it('Composer：只取指向当前会话的草稿，取完即清；不替用户发送', () => {
    const body = bodyFrom(composer.script, 'function takeRelay(): void {');
    expect(body).toMatch(/const r = chat\.relayDraft;\s*if \(!r \|\| r\.sessionId !== chat\.activeId\) return;\s*chat\.relayDraft = null;/);
    expect(body).toMatch(/text\.value = /);
    expect(body).not.toMatch(/\bsend\(/);
  });

  // 为什么数引用、不认某一种 watch 写法：open(N) 先把 activeId 设成 N 再 await 取消息，这段时间旧会话页的输入卡还挂着；
  // watch(() => chat.activeId, takeRelay)、watchEffect(() => takeRelay())、watch 回调里就地读 relayDraft……
  // 都会让旧卡在 pre-flush 里把指向 N 的草稿取走，随后它被欢迎页替换卸载，草稿就丢了。写法数不完，
  // 所以钉引用次数：takeRelay 只许定义一次、setup 顶层调一次；relayDraft 只许出现在 takeRelay 函数体里。
  it('Composer：不用 watch 消费草稿（旧会话的输入卡在 open() 的 await 期间还挂着，watch 会抢走再随组件卸载丢掉）', () => {
    // 两处 = `function takeRelay(): void {` 与行首的 `takeRelay();`（上上一例钉住这两处的形态）；
    // watch / watchEffect / $subscribe / 生命周期钩子 / 事件回调再引用它都会多出一处
    expect(composer.script.match(/\btakeRelay\b/g) ?? []).toHaveLength(2);
    const inBody = bodyFrom(composer.script, 'function takeRelay(): void {').match(/\brelayDraft\b/g) ?? [];
    expect(inBody.length).toBeGreaterThan(0);
    expect(composer.script.match(/\brelayDraft\b/g) ?? [], 'relayDraft 出现在 takeRelay 函数体之外').toHaveLength(inBody.length);
    // relaySource 是出事旧会话的草稿停放处，只归 store 与接力钮管，输入卡不碰
    expect(composer.script).not.toMatch(/\brelaySource\b/);
  });

  it('渲染端组件里只有 Composer 碰 relayDraft / relaySource：会话页、欢迎页、外壳用 watch 消费同样会在 open() 期间抢走草稿', () => {
    const vues = (readdirSync(SRC, { recursive: true }) as string[])
      .map(f => f.replace(/\\/g, '/'))
      .filter(f => f.endsWith('.vue'));
    expect(vues.length).toBeGreaterThan(10);
    // 整个文件剥注释后再找（不按 sfc() 只取第一个 <script> 块：一个 .vue 可以有两个脚本块）
    const touching = vues.filter(f => /\brelay(?:Draft|Source)\b/.test(stripComments(read(f).replace(/<!--[\s\S]*?-->/g, ''))));
    expect(touching).toEqual(['ui/Composer.vue']);
  });

  it('StageChat：错误横幅的图标不随长报错收缩（绑定错误折成多行时曾被压成一个点）', () => {
    const chatCss = sfc('ui/StageChat.vue').css;
    expect(chatCss).toMatch(/\.err :deep\(svg\) \{ flex: 0 0 auto; \}/);
  });

  it('store：relayDraft 是 {sessionId, text}；eventNotes 类型带 relay / short', () => {
    expect(store).toMatch(/relayDraft: null as null \| \{ sessionId: string; text: string \}/);
    expect(store).toContain('retryable?: boolean; relay?: boolean; short?: string }[]');
  });

  it('store：relayToNewSession 先写 relayDraft 再 await this.open(，并照抄模型绑定', () => {
    const body = bodyFrom(store, 'async relayToNewSession() {');
    const iDraft = body.indexOf('this.relayDraft = { sessionId: ');
    const iOpen = body.indexOf('await this.open(');
    expect(iDraft).toBeGreaterThan(-1);
    expect(iOpen).toBeGreaterThan(iDraft);
    expect(body).toMatch(/rpc\.call\('chat\.sessions\.setModelBinding', \{ sessionId: /);
  });
});
