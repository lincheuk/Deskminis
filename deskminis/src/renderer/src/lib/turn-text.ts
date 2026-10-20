/** 回复复制与导出共用：只取正文原文，保留顺序与 Markdown。 */
export function turnMarkdown(blocks: readonly { kind: string; text?: string }[]): string {
  return blocks.filter(b => b.kind === 'text').map(b => b.text ?? '').join('\n\n');
}
