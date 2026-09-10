/** MU2a Task 3：FadeText 组件 + ChatView 流式/滚动接线源文本守卫（4 例）。
 *  计划 Task 3 Step 2；同步修订：renderer-markdown-view.test.ts 的 streamNodes 锚
 *  在本 Task 内改为 streamStable/streamTailText（流式区演进：稳定区 Markdown + 尾部 FadeText）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const readSrc = (rel: string): string =>
  fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

// T6e-1：FadeText 与 lib/fade/split 随两区流式渲染一起退场（理由记在那一笔 commit）
const chatView = readSrc('src/renderer/src/ui/StageChat.vue');

/* T6e-3：两条 FadeText 例退场——组件与 lib/fade/split 已在 T6e-1 随两区流式渲染
   一起删除（新 StageChat 每帧整段重新解析，没有「稳定区 + 淡入尾部」这个形态）。
   其中「淡入组件不许用 v-html」这条 XSS 红线**没有丢**：模型输出的渲染现在全部
   经 MarkdownView，`tests/renderer-markdown-view.test.ts` 与
   `tests/renderer-ui-icon-guard.test.ts` 各守一头。 */
describe('MU2a Task 3 流式渲染与滚动接线（2 例）', () => {


  /* 「稳定区 MarkdownView + 尾部 FadeText 纯文本段」在 T6e-3 退场：
     新 StageChat 每帧整段重新解析渲染，没有稳定区/尾部之分，FadeText 与
     lib/fade/split 已在 T6e-1 随实现一起删除（理由记在那一笔 commit 里）。 */

  it('滚动治理：跟随判定 + @scroll 绑定（用户上翻看历史时不抢滚动）', () => {
    // 判据从纯模块 lib/scroll/follow 内联进了 StageChat（T6e-1 记过这笔账：
    // 已测的纯判据换成了未测的内联代码）。这里至少把「有判定、有绑定」钉住。
    expect(chatView).toMatch(/@scroll="onScroll"/);
    expect(chatView).toMatch(/following/);
    expect(chatView).toMatch(/scrollHeight - .*scrollTop - .*clientHeight/);
  });
});
