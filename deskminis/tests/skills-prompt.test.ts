import { describe, it, expect } from 'vitest';
import { buildSkillsBlock, tierSkills, type PromptSkill } from '../src/minisd/skills/prompt';
import { join } from 'node:path';

const ROOT = join('C:', 'data', 'skills');
const NOW = 1_800_000_000;
const DAY = 24 * 3600;

function sk(id: string, patch?: Partial<PromptSkill>): PromptSkill {
  return { id, name: id, description: `描述-${id}`, updatedAt: NOW - 30 * DAY, useCount: 0, importSource: 'folder', ...patch };
}

describe('buildSkillsBlock 基本形态', () => {
  it('0 个技能返回空串', () => {
    expect(buildSkillsBlock([], ROOT, NOW)).toBe('');
  });
  it('≤20 个全量披露：名 + 描述 + SKILL.md 绝对路径', () => {
    const out = buildSkillsBlock([sk('a'), sk('b')], ROOT, NOW);
    expect(out).toContain('<available_skills>');
    expect(out).toContain('<name>a</name>');
    expect(out).toContain('<description>描述-a</description>');
    expect(out).toContain(`<path>${join(ROOT, 'a', 'SKILL.md')}</path>`);
    expect(out).not.toContain('overflowed');
  });
  it('描述压缩成单行且 ≤200 字（超出加省略号）', () => {
    const long = '很长\n第二行 '.repeat(40);
    const out = buildSkillsBlock([sk('a', { description: long })], ROOT, NOW);
    const m = /<description>([^<]*)<\/description>/.exec(out);
    expect(m).toBeTruthy();
    expect(m![1].length).toBeLessThanOrEqual(200);
    expect(m![1]).not.toContain('\n');
    expect(m![1].endsWith('…')).toBe(true);
  });
  it('XML 特殊字符转义', () => {
    const out = buildSkillsBlock([sk('a', { name: 'a<b&c' })], ROOT, NOW);
    expect(out).toContain('<name>a&lt;b&amp;c</name>');
    expect(out).not.toContain('a<b&c');
  });
});

describe('tierSkills 分级披露（>20 个时）', () => {
  it('内置 > 7 天内更新(≤10) > use_count 高→低；full 上限 20', () => {
    const skills: PromptSkill[] = [
      sk('builtin-2', { importSource: 'builtin' }),
      sk('builtin-1', { importSource: 'builtin' }),
      // 12 个 7 天内更新 → 只取最新 10 个
      ...Array.from({ length: 12 }, (_, i) => sk(`recent-${String(i).padStart(2, '0')}`, { updatedAt: NOW - i * 1000 })),
      // 13 个普通技能，use_count 区分热度
      ...Array.from({ length: 13 }, (_, i) => sk(`plain-${i}`, { useCount: i })),
    ];
    const { full, rest } = tierSkills(skills, NOW);
    expect(full.length).toBe(20);
    // 第一层：内置全保留（保持原相对顺序）
    expect(full[0].id).toBe('builtin-2');
    expect(full[1].id).toBe('builtin-1');
    // 第二层：7 天内更新至多 10 个，按新→旧
    const recentInFull = full.filter(s => s.id.startsWith('recent-'));
    expect(recentInFull.map(s => s.id)).toEqual(Array.from({ length: 10 }, (_, i) => `recent-${String(i).padStart(2, '0')}`));
    // 第三层：剩余 8 席按 use_count 高→低
    const plainInFull = full.filter(s => s.id.startsWith('plain-'));
    expect(plainInFull.map(s => s.id)).toEqual(['plain-12', 'plain-11', 'plain-10', 'plain-9', 'plain-8', 'plain-7', 'plain-6', 'plain-5']);
    // 溢出：recent-10/11 + plain-0..4 共 7 个
    expect(rest.map(s => s.id).sort()).toEqual(['plain-0', 'plain-1', 'plain-2', 'plain-3', 'plain-4', 'recent-10', 'recent-11']);
  });
  it('恰好 20 个不分级（边界）', () => {
    const skills = Array.from({ length: 20 }, (_, i) => sk(`s${i}`));
    const out = buildSkillsBlock(skills, ROOT, NOW);
    expect(out).not.toContain('overflowed');
  });
});

describe('buildSkillsBlock 溢出（21 个）', () => {
  it('溢出只列名，并提示可用 shell ls/grep 查找', () => {
    const skills = Array.from({ length: 21 }, (_, i) => sk(`s${String(i).padStart(2, '0')}`, { useCount: i }));
    const out = buildSkillsBlock(skills, ROOT, NOW);
    expect(out).toContain('<overflowed_skills>');
    expect(out).toContain('<name>s00</name>'); // use_count 最低的被淘汰，只列名
    expect(out).not.toContain('<description>描述-s00</description>');
    expect(out).toContain('ls');
    expect(out).toContain('grep');
    expect(out).toContain(ROOT);
    // 正文永不预载：块内不得出现技能正文线索（只有 名/描述/路径 三类字段）
    expect(out).not.toContain('## ');
  });
});
