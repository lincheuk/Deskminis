import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** H2 文本选区注释——renderer 源码守卫（.vue 不在 typecheck 覆盖内，接线靠文本锚钉死）。 */

const chatView = readFileSync(join(__dirname, '../src/renderer/src/components/ChatView.vue'), 'utf8');
const store = readFileSync(join(__dirname, '../src/renderer/src/stores/chat.ts'), 'utf8');

describe('ChatView 选区注释接线', () => {
  it('正文容器带锚：助手文本 part 与用户正文都有 data-anno-root + data-mid', () => {
    expect(chatView.match(/data-anno-root/g)!.length).toBeGreaterThanOrEqual(2);
    expect(chatView).toMatch(/data-anno-root[^>]*:data-mid="m\.id"/);
    expect(chatView).toMatch(/data-anno-root[^>]*:data-mid="t\.user!?\.msg\.id"/);
  });
  it('乐观消息（local- 前缀 id）不给标注入口——落库后 id 会换，注释会变孤儿', () => {
    expect(chatView).toMatch(/local-/);
  });
  it('浮条：两枚原生 button + aria-label，且 mousedown.prevent（否则按钮按下瞬间选区先塌）', () => {
    expect(chatView).toMatch(/annobar/);
    expect(chatView).toMatch(/aria-label="引用到输入框"/);
    expect(chatView).toMatch(/aria-label="添加标注"/);
    expect(chatView.match(/@mousedown\.prevent/g)!.length).toBeGreaterThanOrEqual(2);
  });
  it('高亮走 CSS Custom Highlight API：零 DOM 改写（不许出现 surroundContents/insertNode 包裹）', () => {
    expect(chatView).toMatch(/CSS[\s\S]{0,40}highlights/);
    expect(chatView).not.toMatch(/surroundContents|insertNode/);
  });
  it('::highlight 样式在非 scoped 块（scoped 会缀 [data-v-*] 使文档级伪元素失配）且用 accent 通道', () => {
    expect(chatView).toMatch(/::highlight\(dm-anno\)/);
    expect(chatView).toMatch(/::highlight\(dm-anno-noted\)/);
    expect(chatView).toMatch(/color-mix\(in srgb, var\(--accent\)/);
  });
  it('锚定核心从 lib/annotations/anchor 纯模块引入（可测内核不内联进 .vue）', () => {
    expect(chatView).toMatch(/from '\.\.\/lib\/annotations\/anchor'/);
  });
  it('引用追问：逐行 > 前缀 + 追加不覆盖草稿；XSS 反向锚：全文件仍无 v-html', () => {
    expect(chatView).toMatch(/'> '/);
    expect(chatView).not.toMatch(/v-html/);
  });
});

describe('chat store 注释面接线', () => {
  it('四件 RPC 与 changed 订阅在位', () => {
    expect(store).toMatch(/rpc\.call\('chat\.annotations\.list'/);
    expect(store).toMatch(/rpc\.call\('chat\.annotations\.add'/);
    expect(store).toMatch(/rpc\.call\('chat\.annotations\.update'/);
    expect(store).toMatch(/rpc\.call\('chat\.annotations\.remove'/);
    expect(store).toMatch(/rpc\.on\('chat\.annotations\.changed'/);
  });
  it('会话打开时装载注释（open 路径挂 refreshAnnotations）', () => {
    expect(store).toMatch(/refreshAnnotations/);
    expect(store.split('refreshAnnotations').length).toBeGreaterThanOrEqual(3);
  });
});
