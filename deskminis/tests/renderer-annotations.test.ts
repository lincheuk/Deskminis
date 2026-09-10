import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** H2 文本选区注释——renderer 源码守卫（.vue 不在 typecheck 覆盖内，接线靠文本锚钉死）。 */

// T6e-3 重指：注释 UI 在换壳后独立成了 ui/AnnoLayer.vue，StageChat 只当宿主。
// 宿主锚（data-anno-root / data-mid）仍看 StageChat，其余全部看 AnnoLayer。
const chatView = readFileSync(join(__dirname, '../src/renderer/src/ui/StageChat.vue'), 'utf8');
const anno = readFileSync(join(__dirname, '../src/renderer/src/ui/AnnoLayer.vue'), 'utf8');
const store = readFileSync(join(__dirname, '../src/renderer/src/stores/chat.ts'), 'utf8');

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
