/**
 * V9 · 文本选区注释 / 引用在新壳里的落位守卫。
 *
 * 这是 T 波换壳后最后一块没接过来的能力。两件事：
 * ① 选中助手正文 → 浮条给「引用」「注释」两个动作；
 * ② 已有注释在正文上着色，点开可看引文 / 改笔记 / 删。
 *
 * 高亮必须走 CSS Custom Highlight API：跨节点 <mark> 包裹会改写 DOM，
 * 与 Vue 的视图一致性打架（重渲染后包裹层要么消失要么错位）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(__dirname, '../src/renderer/src/ui/');
const read = (p: string): string => readFileSync(join(UI, p), 'utf8').replace(/\r\n/g, '\n');

describe('V9 — 注释层落位', () => {
  it('组件存在并挂进会话视图', () => {
    expect(existsSync(join(UI, 'AnnoLayer.vue'))).toBe(true);
    const c = read('StageChat.vue');
    expect(c).toContain("import AnnoLayer from './AnnoLayer.vue'");
    expect(c).toContain('<AnnoLayer');
  });
  it('助手正文块带 data-anno-root 与 data-mid（锚点靠它定位）', () => {
    const c = read('StageChat.vue');
    expect(c).toContain('data-anno-root');
    expect(c).toContain('data-mid');
  });
  it('高亮走 CSS Custom Highlight API，不改写 DOM', () => {
    const a = read('AnnoLayer.vue');
    expect(a).toContain('CSS as unknown');
    expect(a).toContain('highlights');
    expect(a).not.toMatch(/createElement\('mark'\)|surroundContents/);
  });
  it('锚点解析复用既有纯模块（不自造一套）', () => {
    const a = read('AnnoLayer.vue');
    for (const f of ['matchQuote', 'resolveOffsets', 'absoluteOffset']) expect(a).toContain(f);
  });
  it('增删改三个动作都接线；本地态不就地改，走广播回流', () => {
    const a = read('AnnoLayer.vue');
    for (const f of ['addAnnotation', 'updateAnnotationNote', 'removeAnnotation']) expect(a).toContain(f);
  });
  it('乐观消息（local- 前缀）不给注释入口——落库后 id 会换，建了必成孤儿', () => {
    const a = read('AnnoLayer.vue');
    expect(a).toContain("startsWith('local-')");
  });
});
