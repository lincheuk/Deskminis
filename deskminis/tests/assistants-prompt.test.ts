import { describe, it, expect } from 'vitest';
import { buildAssistantBlock } from '../src/minisd/assistants/prompt';

/** J1 助手规则注入块（设计稿 §4）：无助手/规则为空 → 空串零开销；
 *  有规则 → <assistant_preset name="…"> 包裹追加进系统提示词。
 *  规则是用户自己写的配置（同 SKILL.md 信任级），不包 untrusted 壳。 */
describe('buildAssistantBlock', () => {
  it('无助手 / 规则空白 → 空串', () => {
    expect(buildAssistantBlock(undefined)).toBe('');
    expect(buildAssistantBlock({ name: '甲', rules: '' })).toBe('');
    expect(buildAssistantBlock({ name: '甲', rules: '   \n ' })).toBe('');
  });

  it('有规则 → 包裹块，名称进 name 属性', () => {
    const block = buildAssistantBlock({ name: '代码助手', rules: '你是严谨的工程师。' });
    expect(block).toContain('<assistant_preset name="代码助手">');
    expect(block).toContain('你是严谨的工程师。');
    expect(block).toContain('</assistant_preset>');
    expect(block.startsWith('\n\n')).toBe(true); // 与 stable 段拼接需要空行分隔
  });

  it('名称里的双引号转义为单引号（属性值不被截断）', () => {
    const block = buildAssistantBlock({ name: '写"稿"手', rules: 'r' });
    expect(block).toContain('name="写\'稿\'手"');
    expect(block).not.toContain('name="写"');
  });

  it('规则首尾空白修剪，内部换行保留', () => {
    const block = buildAssistantBlock({ name: 'x', rules: '\n第一行\n第二行\n\n' });
    expect(block).toContain('>\n第一行\n第二行\n</assistant_preset>');
  });
});
