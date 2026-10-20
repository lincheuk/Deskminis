/**
 * X 波：首发竞态排查——首条消息发送链的三道闸（设计稿 docs/specs/2026-09-10-first-send-race-design.md）。
 *
 * 复现结论：L6 记的「紧跟启动的首条 Enter 偶发被吞」是剧本判定的假阳性（消息从未丢过），
 * 但排查顺带挖出两处真缺陷，都在「首条消息要先建会话」这几十毫秒的窗口上：
 * ① 建会话期间 send() 无重入闸——双击 Enter 建出两个会话、撞后端 inFlight 抛红横幅、running 被误归零；
 * ② 首条消息被同步拒绝（未配置模型 / 建会话失败）时欢迎页零交代——文字清了、多出一个幽灵会话、没有一句话。
 * 这条守卫钉死修法。断言认调用形态，不认散文（同文件注释里写得再多也喂不饱）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';
import { useChat } from '../src/renderer/src/stores/chat';
import { resetStoreRpc, type Equal, type Chat } from './renderer-store-fixture';

const SRC = join(__dirname, '../src/renderer/src/');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8').replace(/\r\n/g, '\n');
const composer = read('ui/Composer.vue');
const stageChat = read('ui/StageChat.vue');

/** send() 函数体（到下一个顶层函数声明为止）——闸与寄存都必须在它里面。 */
const sendBody = composer.slice(composer.indexOf('async function send('), composer.indexOf('\nfunction takeDraft('));

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例使用新的真实 Pinia；RPC 桩只记调用与订阅，由用例放行应答。
beforeEach(() => { resetStoreRpc(_probe); });
afterEach(() => { vi.restoreAllMocks(); });

describe('X1 — 首条消息建会话期间不许重入', () => {
  it('send() 有 sending 闸：入口早退、进入置位、finally 放开', () => {
    expect(composer).toMatch(/const sending = ref\(false\)/);
    expect(sendBody).toMatch(/if \(\(!t && !paths\.length\) \|\| sending\.value\) return;/);
    expect(sendBody).toMatch(/if \(chat\.running && !chat\.inputsOn\) return;/);
    expect(sendBody).toMatch(/sending\.value = true;/);
    // 闸必须在 finally 块内放：任一 await 抛错后不放，输入卡就永久失能（块内可有注释，不锚「首句」）
    expect(sendBody).toMatch(/finally \{[^}]*sending\.value = false;[^}]*\}/);
  });

  it('发送键随闸变灰——建会话那几十毫秒就是「已经在发」的反馈', () => {
    expect(composer).toMatch(/const canSend = computed\(\(\) =>[^;]*&& chat\.connection !== 'reconnecting' && chat\.connection !== 'lost' && !sending\.value\)/);
  });
});

describe('X2 — 首条消息被同步拒绝时，界面必须交代', () => {
  it('欢迎页输入卡渲染 chat.lastError（hero 态）；会话页仍由 StageChat 横幅负责，不重复', () => {
    expect(composer).toMatch(/const cardError = computed\(\(\) => \(props\.variant === 'hero' \? chat\.lastError : ''\)\)/);
    expect(composer).toMatch(/<p v-if="cardError" class="cerr t-aux">\{\{ cardError \}\}<\/p>/);
    expect(stageChat).toMatch(/v-if="chat\.lastError"/);
  });

  it('建会话失败写 chat.lastError 并留住草稿，不是 unhandled rejection', () => {
    expect(sendBody).toMatch(/catch \(e\) \{\s*chat\.lastError = `新建会话失败：\$\{[^}]+\}`;\s*return;/);
    // 附件路径同款 newSession()：兜住写 attErr
    expect(composer).toMatch(/catch \(e\) \{\s*attErr\.value = `新建会话失败：\$\{[^}]+\}`;\s*return;/);
  });
});

describe('X2b — 被拒的草稿交回输入框（跨实例：欢迎页换会话页再换回来，发它的实例已卸载）', () => {
  it('store 有 draft 寄存字段', async () => {
    // 草稿的可空联合及嵌套附件完整形状由精确类型比较把关；运行时逐个取值。
    const draftType: true = true as Equal<Chat['draft'], null | { text: string; attachments: { path: string; dataUrl: string }[] }>;
    expect(draftType).toBe(true);
    const chat = useChat();
    expect(chat.draft).toBeNull();
    for (const attachments of [[], [{ path: 'attachments/a.png', dataUrl: 'data:test' }]]) {
      const draft = { text: 'draft text', attachments };
      chat.draft = draft;
      expect(chat.draft).toEqual(draft);
      chat.draft = null;
      expect(chat.draft).toBeNull();
    }
    expect(_rpcCall.mock.calls).toEqual([]);
  });

  it('清空输入框之前先寄存；send 返回后被拒则取回、否则清寄存', () => {
    const iPark = sendBody.indexOf('chat.draft = { text: text.value, attachments: atts.value }');
    const iClear = sendBody.indexOf("text.value = '';");
    expect(iPark).toBeGreaterThan(-1);
    expect(iClear).toBeGreaterThan(iPark);
    // W1b-4 审查起：send 返回时已换了会话（先切走再删 / 停止，被拒要等 MCP 连接超时），只清寄存、不交回——
    // 会话视图换会话不重建输入卡，交回会把 A 的话塞进 B 的输入框。中间夹了注释，剥掉再认调用形态
    expect(stripComments(sendBody)).toMatch(/await chat\.send\(t, paths\.length \? paths : undefined\);\s*if \(chat\.activeId !== sid\) chat\.draft = null;\s*else if \(chat\.lastError\) takeDraft\(\); else chat\.draft = null;/);
  });

  it('takeDraft 在 setup 也跑一次——欢迎页新建的那个实例靠它', () => {
    expect(composer).toMatch(/function takeDraft\(\): void \{\s*const d = chat\.draft;\s*if \(!chat\.lastError \|\| !d\) return;/);
    expect(composer).toMatch(/chat\.draft = null;/);
    // 定义之外至少两处调用：setup 顶层 + send() 之后
    const calls = composer.split('takeDraft()').length - 1 - 1; // 减去定义处
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
