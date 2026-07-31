/** MU2a Task 3：FadeText 组件 + ChatView 流式/滚动接线源文本守卫（4 例）。
 *  计划 Task 3 Step 2；同步修订：renderer-markdown-view.test.ts 的 streamNodes 锚
 *  在本 Task 内改为 streamStable/streamTailText（流式区演进：稳定区 Markdown + 尾部 FadeText）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const readSrc = (rel: string): string =>
  fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const fadeText = readSrc('src/renderer/src/components/FadeText.vue');
const chatView = readSrc('src/renderer/src/components/ChatView.vue');

describe('MU2a Task 3 FadeText + 滚动接线源文本守卫（4 例）', () => {
  it('FadeText.vue：props { text: string }；diffWords 驱动；added 词渲染 span.fade-word + animationDelay', () => {
    expect(fadeText).toContain('defineProps<{ text: string }>()');
    expect(fadeText).toContain("from '../lib/fade/split'");
    expect(fadeText).toContain('diffWords(');
    expect(fadeText).toContain('class="fade-word"');
    expect(fadeText).toContain('animationDelay');
  });

  it('FadeText.vue：XSS 红线（无 v-html）；reduced-motion 降级锚（动画关闭即时呈现）', () => {
    expect(fadeText).not.toContain('v-html');
    expect(fadeText).not.toContain('innerHTML');
    expect(fadeText).toContain('@media (prefers-reduced-motion: reduce)');
    expect(fadeText).toContain('0.3s ease-out'); // §8 节奏参数
  });

  it('ChatView 流式区：稳定区 MarkdownView（不淡入）+ 尾部 FadeText 纯文本段；旧 streamNodes 形态退役', () => {
    expect(chatView).toContain("import FadeText from './FadeText.vue'");
    expect(chatView).toContain(':nodes="streamStable"');
    expect(chatView).toContain(':text="streamTailText"');
    expect(chatView).toContain('stablePrefixEnd(');
    expect(chatView).not.toContain('streamNodes');
  });

  it('ChatView 滚动治理：shouldFollow 判定 + @scroll 绑定 + 「回到底部」浮钮；旧无条件贴底 watch 已移除', () => {
    expect(chatView).toContain("from '../lib/scroll/follow'");
    expect(chatView).toContain('shouldFollow(');
    expect(chatView).toContain('@scroll="onScroll"');
    expect(chatView).toContain('回到底部');
    expect(chatView).toContain('following');
    // 旧形态（L79-82 无条件贴底）已移除
    expect(chatView).not.toContain('() => { void nextTick(() => { const el = streamEl.value; if (el) el.scrollTop = el.scrollHeight; }); }');
    expect(chatView).toContain('if (!following.value) return;');
  });
});
