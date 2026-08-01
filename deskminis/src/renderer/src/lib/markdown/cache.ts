/** MU2a Task 2：流式 Markdown 渲染缓存（决策 3：稳定前缀 + 尾部重解析）。
 *  稳定区（最后完整块边界之前）AST 缓存复用；每次 update 只重解析尾部，避免 O(N²) 全量重解析。
 *  同文本重复 update 返回同一结果对象（身份稳定，模板 prop 不抖动）。 */
import { parseMarkdown, type MdNode } from './parse';
import { stablePrefixEnd } from './prefix';

export interface MarkdownCacheResult { stableNodes: MdNode[]; tailNodes: MdNode[] }

export class MarkdownCache {
  private stableText = '';
  private stable: MdNode[] = [];
  private lastText: string | null = null;
  private last: MarkdownCacheResult | null = null;

  update(text: string): MarkdownCacheResult {
    if (this.last !== null && text === this.lastText) return this.last;
    const end = stablePrefixEnd(text);
    const stable = text.slice(0, end);
    if (stable !== this.stableText) {
      this.stableText = stable;
      this.stable = stable === '' ? [] : parseMarkdown(stable);
    }
    const tail = text.slice(end);
    const tailNodes = tail === '' ? [] : parseMarkdown(tail);
    this.lastText = text;
    this.last = { stableNodes: this.stable, tailNodes };
    return this.last;
  }
}
