/** OpenAI 兼容层 thinking 渲染链路守卫（3 例）。
 *
 *  背景：loop 早已广播 thinkingDelta、assistant 消息也存了 reasoningContent，
 *  但 renderer 断在最后一公里——onEvent 没有 thinkingDelta 分支、ChatView 不渲染
 *  reasoningContent。本文件守三件事：
 *    ① chat store：onEvent thinkingDelta 累积进 streamingThinking，turnEnd 清空
 *       （行为级，桩 rpc 走真实 store，同 renderer-permtier 模式）；
 *    ② ChatView.vue：ThinkingBlock 两处挂载（实时流式态 + 历史默认收起）；
 *    ③ ThinkingBlock.vue：折叠交互 / 文案分支 / 收起态末两行 / 样式 token。
 *  先红后绿：删掉 chat.ts 的 thinkingDelta 分支或 ChatView 的任一挂载，对应断言变红。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── mock renderer 的 rpc 模块：桩掉 rpc.call（turnEnd 分支会触发 open() 重取消息）──
const { rpcCallMock } = vi.hoisted(() => ({ rpcCallMock: vi.fn() }));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCallMock, connect: async () => {}, on: vi.fn() },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';

const root = path.resolve(__dirname, '..');
const readSrc = (rel: string): string =>
  fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

beforeEach(() => {
  rpcCallMock.mockReset();
  setActivePinia(createPinia());
});

describe('thinking 渲染链路守卫', () => {
  it('onEvent thinkingDelta 累积进 streamingThinking；turnEnd 清空（历史侧由 reasoningContent 接管）', async () => {
    rpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'chat.messages.list') return [];
      if (method === 'skills.list') return [];
      return undefined;
    });
    const store = useChat();
    store.onEvent({ kind: 'thinkingDelta', text: '先想' });
    store.onEvent({ kind: 'thinkingDelta', text: '再想' });
    expect(store.streamingThinking).toBe('先想再想');
    // turnEnd 后流式缓冲必须同步清掉：open() 重取消息是异步的，
    // 不清的话「已落库的思考」与「缓冲残值」会在界面上短暂并存
    store.onEvent({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(store.streamingThinking).toBe('');
  });

  it('ChatView 源码含 ThinkingBlock 两处挂载：实时流式态 + 历史默认收起', () => {
    const chatView = readSrc('src/renderer/src/components/ChatView.vue');
    expect(chatView).toContain("import ThinkingBlock from './ThinkingBlock.vue'");
    // 实时块：streamingThinking 驱动，streaming 态（收起时显示「思考中…」+ 末两行）
    expect(chatView).toMatch(/<ThinkingBlock[^>]*:text="chat\.streamingThinking"[^>]*streaming/);
    // 历史块：assistant 消息的 reasoningContent 驱动，默认收起（不传 streaming）
    expect(chatView).toMatch(/<ThinkingBlock[^>]*:text="m\.reasoningContent"/);
    expect(chatView.split('<ThinkingBlock').length - 1).toBe(2);
  });

  it('ThinkingBlock.vue：折叠交互 + 文案分支 + 流式收起态末两行 + 次级色/--fs-micro；无 v-html', () => {
    const block = readSrc('src/renderer/src/components/ThinkingBlock.vue');
    // 折叠交互与 ToolLine 同构：button + aria-expanded + chevron 切换
    expect(block).toContain('aria-expanded');
    expect(block).toContain('chevron-down');
    expect(block).toContain('chevron-right');
    // 文案分支：流式「思考中…」/ 完成「已思考」
    expect(block).toContain('思考中…');
    expect(block).toContain('已思考');
    // 流式收起态只露最后两行（跟随滚动的窗口感，不把对话流撑高）
    expect(block).toContain('slice(-2)');
    // 与正文视觉区分：次级文字色 + micro 字号
    expect(block).toContain('var(--label-secondary)');
    expect(block).toContain('var(--fs-micro)');
    // XSS 红线（同 FadeText 先例）：思考文本只走插值，绝不 v-html
    expect(block).not.toContain('v-html');
    expect(block).not.toContain('innerHTML');
  });
});
