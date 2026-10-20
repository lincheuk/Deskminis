import { parseMarkdown, type MdNode } from './parse';

/** 只保留当前会话里仍在渲染的消息/文本组合；同一消息的多个文本块分别缓存。 */
export function createHistoryMarkdownCache(parse: (text: string) => MdNode[] = parseMarkdown) {
  let current = new Map<string, Map<string, MdNode[]>>();
  let next = new Map<string, Map<string, MdNode[]>>();
  return {
    begin(): void { next = new Map(); },
    nodes(messageId: string, text: string): MdNode[] {
      const nodes = next.get(messageId)?.get(text) ?? current.get(messageId)?.get(text) ?? parse(text);
      let texts = next.get(messageId);
      if (!texts) { texts = new Map(); next.set(messageId, texts); }
      texts.set(text, nodes);
      return nodes;
    },
    end(): void { current = next; },
  };
}
