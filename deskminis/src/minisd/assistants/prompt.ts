/** J1 助手规则注入块（设计稿 2026-08-20-assistants-design.md §4）。
 *  注入位：chat.prompt 的 promptFactory，base = stable + assistantBlock + skillsBlock。
 *  规则是用户自己写的配置（同 SKILL.md 信任级），不包 untrusted 壳；
 *  名称进 name 属性做提示词内自指认（「你正以 XX 预设工作」的语义由包裹块承担）。 */

export function buildAssistantBlock(a: { name: string; rules: string } | undefined): string {
  if (!a) return '';
  const rules = a.rules.trim();
  if (rules === '') return '';
  // 双引号换单引号：防属性值被截断。不做完整 XML 转义——这不是 XML 解析器要吃的文本，
  // 只是给模型看的定界标记，够用即可（skills/prompt.ts 同款态度）。
  const name = a.name.replace(/"/g, "'");
  return `\n\n<assistant_preset name="${name}">\n${rules}\n</assistant_preset>\n`;
}
