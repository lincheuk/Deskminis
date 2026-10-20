import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resetStoreRpc, initStore, settleStore, dispatchStore, deferred, openCalls, minimalReply } from './renderer-store-fixture';

/** H2 文本选区注释——renderer 源码守卫（.vue 不在 typecheck 覆盖内，接线靠文本锚钉死）。 */

// T6e-3 重指：注释 UI 在换壳后独立成了 ui/AnnoLayer.vue，StageChat 只当宿主。
// 宿主锚（data-anno-root / data-mid）仍看 StageChat，其余全部看 AnnoLayer。
const chatView = readFileSync(join(__dirname, '../src/renderer/src/ui/StageChat.vue'), 'utf8');
const anno = readFileSync(join(__dirname, '../src/renderer/src/ui/AnnoLayer.vue'), 'utf8');

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例使用新的真实 Pinia；RPC 桩只记调用与订阅，由用例放行应答。
beforeEach(() => { resetStoreRpc(_probe); });
afterEach(() => { vi.restoreAllMocks(); });

describe('ChatView 选区注释接线', () => {
  it('正文容器带锚：助手文本 part 与用户正文都有 data-anno-root + data-mid', () => {
    expect(chatView.match(/data-anno-root/g)!.length).toBeGreaterThanOrEqual(2);
    expect(chatView).toMatch(/data-anno-root[^>]*:data-mid="b\.mid"/);   // 助手正文块
    expect(chatView).toMatch(/data-anno-root[^>]*:data-mid="t\.user\.id"/); // 用户正文块
  });
  it('乐观消息（local- 前缀 id）不给标注入口——落库后 id 会换，注释会变孤儿', () => {
    expect(anno).toMatch(/local-/);
  });
  it('浮条：两枚原生 button + aria-label，且 mousedown.prevent（否则按钮按下瞬间选区先塌）', () => {
    expect(anno).toMatch(/class="abar"/);
    expect(anno).toMatch(/aria-label="引用到输入框"/);
    expect(anno).toMatch(/aria-label="添加标注"/);
    expect(anno.match(/@mousedown\.prevent/g)!.length).toBeGreaterThanOrEqual(2);
  });
  it('高亮走 CSS Custom Highlight API：零 DOM 改写（不许出现 surroundContents/insertNode 包裹）', () => {
    expect(anno).toMatch(/CSS[\s\S]{0,40}highlights/);
    expect(anno).not.toMatch(/surroundContents|insertNode/);
  });
  it('::highlight 样式在非 scoped 块（scoped 会缀 [data-v-*] 使文档级伪元素失配）且用 accent 通道', () => {
    expect(anno).toMatch(/::highlight\(dm-anno\)/);
    expect(anno).toMatch(/::highlight\(dm-anno-noted\)/);
    expect(anno).toMatch(/color-mix\(in srgb, var\(--c-brand\)/);
  });
  it('锚定核心从 lib/annotations/anchor 纯模块引入（可测内核不内联进 .vue）', () => {
    expect(anno).toMatch(/from '\.\.\/lib\/annotations\/anchor'/);
  });
  it('引用追问：逐行 > 前缀 + 追加不覆盖草稿；XSS 反向锚：全文件仍无 v-html', () => {
    expect(anno).toMatch(/'> '/);
    expect(anno).not.toMatch(/v-html/);
  });
});

describe('H3 注释气泡（点击高亮 → 查看/编辑笔记/删除）', () => {
  it('命中判定走 Range 几何（caretRangeFromPoint + isPointInRange），不做 DOM 包裹', () => {
    expect(anno).toMatch(/caretRangeFromPoint/);
    expect(anno).toMatch(/isPointInRange/);
  });
  it('气泡：引文摘要 + 笔记输入（aria-label）+ 保存/删除原生按钮', () => {
    expect(anno).toMatch(/class="apop"/);
    expect(anno).toMatch(/aria-label="标注笔记"/);
    expect(anno).toMatch(/aria-label="保存笔记"/);
    expect(anno).toMatch(/aria-label="删除标注"/);
  });
  it('删除/保存走 store 动作（removeAnnotation/updateAnnotationNote），本地态靠广播回流', () => {
    expect(anno).toMatch(/chat\.removeAnnotation\(/);
    expect(anno).toMatch(/chat\.updateAnnotationNote\(/);
  });
  it('Esc 可关气泡（键盘可达闭环）', () => {
    // 旧断言数的是「≥2 处 keydown.esc」——那是因为**旧 ChatView 同时装着输入框和气泡**，
    // 两处 Esc 挤在一个文件里。新树把注释层拆成独立组件，输入框的 Esc 在 ui/Composer.vue，
    // 这里只该有气泡这一处。继续要求 ≥2 就是把「当时恰好两处」当成了不变量。
    expect(anno).toMatch(/keydown\.esc/);
  });
});

describe('chat store 注释面接线', () => {
  it('四件 RPC 与 changed 订阅在位', async () => {
    // 四个动作的完整方法、参数与 state；写动作只经广播回流刷新。
    const chat = await initStore(_probe);
    chat.activeId = 'A';
    const annotations = [{ id: 'N', messageId: 'M', exact: 'quote', prefix: 'pre', suffix: 'post', note: 'note', color: 'blue' }];
    _rpcCall.mockResolvedValueOnce({ annotations });
    await chat.refreshAnnotations();
    expect(_rpcCall.mock.calls).toEqual([['chat.annotations.list', { sessionId: 'A' }]]);
    expect(chat.annotations).toEqual(annotations);
    _rpcCall.mockClear();
    await chat.addAnnotation('M', { exact: 'quote', prefix: 'pre', suffix: 'post' });
    await chat.updateAnnotationNote('N', 'changed note');
    await chat.removeAnnotation('N');
    expect(_rpcCall.mock.calls).toEqual([
      ['chat.annotations.add', { sessionId: 'A', messageId: 'M', exact: 'quote', prefix: 'pre', suffix: 'post' }],
      ['chat.annotations.update', { id: 'N', note: 'changed note' }], ['chat.annotations.remove', { id: 'N' }],
    ]);
    expect(chat.annotations).toEqual(annotations);

    // 订阅数量恰一；当前会话 changed 重取，别会话及缺少会话不重取。
    expect(_rpcOn.mock.calls.filter(c => c[0] === 'chat.annotations.changed')).toHaveLength(1);
    _rpcCall.mockClear();
    _rpcCall.mockResolvedValueOnce({ annotations: [] });
    await dispatchStore(_probe, 'chat.annotations.changed', { sessionId: 'A' });
    expect(_rpcCall.mock.calls).toEqual([['chat.annotations.list', { sessionId: 'A' }]]);
    expect(chat.annotations).toEqual([]);
    _rpcCall.mockClear();
    for (const p of [{ sessionId: 'B' }, {}]) await dispatchStore(_probe, 'chat.annotations.changed', p);
    expect(_rpcCall.mock.calls).toEqual([]);
  });
  it('会话打开时装载注释（open 路径挂 refreshAnnotations）', async () => {
    // 定义、open、changed 三条本来想守的路径都真走；完整 open 次序和结果。
    const chat = await initStore(_probe);
    const annotations = [{ id: 'N', messageId: 'M', exact: 'x', prefix: '', suffix: '', note: 'n', color: 'blue' }];
    _rpcCall.mockImplementation(method => method === 'chat.annotations.list' ? Promise.resolve({ annotations }) : minimalReply(method));
    await chat.open('A');
    await settleStore();
    expect(_rpcCall.mock.calls).toEqual(openCalls('A'));
    expect(chat.annotations).toEqual(annotations);
    _rpcCall.mockClear();
    await dispatchStore(_probe, 'chat.annotations.changed', { sessionId: 'A' });
    expect(_rpcCall.mock.calls).toEqual([['chat.annotations.list', { sessionId: 'A' }]]);

    // 无活动会话直接清表；应答在途切走则丢弃，不能串台。
    chat.activeId = '';
    _rpcCall.mockClear();
    await chat.refreshAnnotations();
    expect(chat.annotations).toEqual([]);
    expect(_rpcCall.mock.calls).toEqual([]);
    chat.activeId = 'A';
    const pending = deferred();
    _rpcCall.mockReturnValueOnce(pending.promise);
    const fetch = chat.refreshAnnotations();
    chat.activeId = 'B';
    pending.resolve({ annotations });
    await fetch;
    expect(chat.annotations).toEqual([]);
  });
});
