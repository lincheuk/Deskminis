/** MU2a Task 2：MarkdownView 组件源文本守卫（5 例）+ MarkdownCache 纯模块（3 例）。
 *  守卫：docs/plans/2026-07-31-mu2-ui-implementation.md Task 2 Step 1；
 *  XSS 红线：Markdown 全链路禁 v-html；组件禁写死颜色。 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MarkdownCache } from '../src/renderer/src/lib/markdown/cache';
import * as parseMod from '../src/renderer/src/lib/markdown/parse';

const root = path.resolve(__dirname, '..');
const readSrc = (rel: string): string =>
  fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const mdView = readSrc('src/renderer/src/components/MarkdownView.vue');
const mdInline = readSrc('src/renderer/src/components/MarkdownInline.vue');
const chatView = readSrc('src/renderer/src/components/ChatView.vue');
const icon = readSrc('src/renderer/src/components/Icon.vue');

afterEach(() => { vi.restoreAllMocks(); });

describe('MU2a Task 2 MarkdownView 源文本守卫（5 例）', () => {
  it('props { nodes: MdNode[] }；MarkdownView / MarkdownInline 全文无 v-html（XSS 红线）', () => {
    expect(mdView).toContain('defineProps<{ nodes: MdNode[] }>()');
    expect(mdView).not.toContain('v-html');
    expect(mdView).not.toContain('innerHTML');
    expect(mdInline).not.toContain('v-html');
    expect(mdInline).not.toContain('innerHTML');
  });

  it('块级八类节点模板分支齐全；ul/ol/blockquote 子节点自递归 <MarkdownView :nodes>；行内委托 MarkdownInline', () => {
    for (const t of ['paragraph', 'heading', 'codeBlock', 'ul', 'ol', 'blockquote', 'table', 'hr']) {
      expect(mdView).toContain(`'${t}'`);
    }
    // 块级自递归（列表项 / 引用块内再渲染块）
    expect(mdView).toContain('<MarkdownView :nodes=');
    // 行内节点由 MarkdownInline 递归
    expect(mdView).toContain('MarkdownInline');
    expect(mdInline).toContain('<MarkdownInline :nodes=');
  });

  it('围栏块：语言名槽（md-lang + n.lang 空值回落）+ 复制按钮（copy/check 图标 + navigator.clipboard.writeText）；Icon.vue 只追加 copy 路径', () => {
    expect(mdView).toContain('md-lang');
    expect(mdView).toContain('n.lang');
    expect(mdView).toContain('navigator.clipboard.writeText');
    expect(mdView).toContain("'copy'");
    expect(mdView).toContain('md-copy');
    expect(icon).toContain("copy: '");
    // Icon 只追加红线：既有路径保留
    expect(icon).toContain("refresh: '");
    expect(icon).toContain("check: '");
  });

  it('MarkdownInline：link target="_blank" rel="noopener"；bold/italic/strikethrough/inlineCode/text 五类行内分支', () => {
    expect(mdInline).toContain('target="_blank"');
    expect(mdInline).toContain('rel="noopener"');
    for (const t of ['bold', 'italic', 'strikethrough', 'inlineCode', 'link']) {
      expect(mdInline).toContain(`'${t}'`);
    }
  });

  it('类名锚点：md-table/md-quote/md-ul/md-ol/md-li/md-icode/md-link；ChatView 接线（历史+流式走 MarkdownView，用户消息纯文本不动，atext 退役）', () => {
    for (const c of ['md-table', 'md-quote', 'md-ul', 'md-ol', 'md-li', 'md-icode', 'md-link']) {
      expect(mdView + mdInline).toContain(c);
    }
    // ChatView 两处增量替换：历史正文 + 流式文本
    expect(chatView).toContain("import MarkdownView from './MarkdownView.vue'");
    expect(chatView).toContain(':nodes="mdOf(');
    expect(chatView).toContain(':nodes="streamStable"'); // Task 3 同步修订：流式区拆为稳定区 Markdown + 尾部 FadeText
    // 用户消息不渲染 Markdown（§5.1）
    expect(chatView).toContain('{{ t.user.text }}'); // Task 5 同步修订：回合结构下用户正文为 turns 预计算纯文本插值
    expect(chatView).toContain('userText(m)'); // 纯文本提取函数仍是唯一用户正文来源
    // .atext 让位 MarkdownView 内部排版
    expect(chatView).not.toContain('class="atext"');
    // renderer-files-panel.test.ts 三锚不丢
    expect(chatView).toContain('useChat');
    expect(chatView).toContain('activeId');
    expect(chatView).toContain('messages');
    // 组件禁写死颜色
    expect(mdView).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(mdInline).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('MU2a Task 2 MarkdownCache（纯模块，3 例）', () => {
  it('空文本返回双空数组；同文本重复 update 返回同一结果对象且 parse 零调用', () => {
    const c = new MarkdownCache();
    expect(c.update('')).toEqual({ stableNodes: [], tailNodes: [] });
    c.update('hello world');
    const spy = vi.spyOn(parseMod, 'parseMarkdown');
    const a = c.update('hello world');
    const b = c.update('hello world');
    expect(spy).not.toHaveBeenCalled();
    expect(a).toBe(b); // 同一结果对象（身份稳定，模板 prop 不抖动）
  });

  it('连续 append 三次：parseMarkdown 只被调用于尾部区间（spy 计数 + 入参断言）', () => {
    const c = new MarkdownCache();
    c.update('段一\n\n');
    const spy = vi.spyOn(parseMod, 'parseMarkdown');
    // append 1：稳定前缀 '段一\n\n' 已缓存 → 仅解析尾部 '段二'
    c.update('段一\n\n段二');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenNthCalledWith(1, '段二');
    spy.mockClear();
    // append 2：尾部生长 → 仍只解析尾部
    c.update('段一\n\n段二更长');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenNthCalledWith(1, '段二更长');
    spy.mockClear();
    // append 3：尾部再生长
    const r = c.update('段一\n\n段二更长尾');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenNthCalledWith(1, '段二更长尾');
    expect(r.stableNodes).toHaveLength(1); // '段一'
    expect(r.tailNodes).toHaveLength(1);   // '段二更长尾'
  });

  it('稳定区推进：重解析新稳定段一次 + 尾部一次；未闭合围栏全文走尾部', () => {
    const c = new MarkdownCache();
    c.update('段一\n\n段二');
    const spy = vi.spyOn(parseMod, 'parseMarkdown');
    // 新边界推进：稳定段变 '段一\n\n段二\n\n'（重解析一次）+ 尾部 '段三'（一次）
    const r = c.update('段一\n\n段二\n\n段三');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, '段一\n\n段二\n\n');
    expect(spy).toHaveBeenNthCalledWith(2, '段三');
    expect(r.stableNodes).toHaveLength(2);
    expect(r.tailNodes).toHaveLength(1);
    spy.mockClear();
    // 未闭合围栏：边界在围栏之后被回退 → stablePrefixEnd = 0 → 全文走尾部（决策 3 兜底）
    const r2 = c.update('```js\ncode\n\nmore');
    expect(spy).toHaveBeenCalledTimes(1); // 稳定段为空不解析；全文一次
    expect(spy).toHaveBeenNthCalledWith(1, '```js\ncode\n\nmore');
    expect(r2.stableNodes).toEqual([]);
    expect(r2.tailNodes.length).toBeGreaterThan(0);
  });
});
