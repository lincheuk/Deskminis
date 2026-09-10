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

  it('StageChat 挂 ThinkBlock：实时流式态 + 历史块两条路都在', () => {
    const chatView = readSrc('src/renderer/src/ui/StageChat.vue');
    expect(chatView).toMatch(/import ThinkBlock from '\.\/ThinkBlock\.vue'/);
    expect(chatView).toMatch(/kind === 'think'/);   // 历史侧走回合块
    expect(chatView).toMatch(/streamingThinking/);  // 实时侧
  });

  /* 「dots 跳动点排除纯思考阶段」在 T6e-3 退场：新 StageChat 没有 dots 跳动点，
     思考中的提示由 ThinkBlock 自己的「正在思考」标题承担（live 态自动展开）。
     原意图——**纯思考阶段不要再叠一个「正在输入」动画**——由「只有一处进行中提示」
     这件事本身满足，没有第二个动画可叠。 */

  it('ThinkBlock：折叠交互 + 进行中/已完成文案分支 + 无 v-html', () => {
    const block = readSrc('src/renderer/src/ui/ThinkBlock.vue');
    // 「流式收起态只露末两行」与 --fs-micro 两条不搬：新块流式时**默认展开**
    // （live 即 open），没有「收起态露几行」这个形态；字号走 theme.css 的 --t-* 词汇。
    expect(block).toMatch(/aria-expanded="open"/);
    expect(block).toMatch(/正在思考/);
    expect(block).toMatch(/思考过程/);
    expect(block).toMatch(/open = ref\(props\.live\)/);
    expect(block).not.toMatch(/v-html\s*=/);  // 思考正文是模型输出，绝不当 HTML 渲
  });
});
