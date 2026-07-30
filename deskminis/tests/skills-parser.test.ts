import { describe, it, expect } from 'vitest';
import { parseSkillMd, slugify, nameFromUrl } from '../src/minisd/skills/parser';

describe('parseSkillMd 标准 frontmatter', () => {
  it('提取 name/description/version，正文忽略', () => {
    const md = '---\nname: my-skill\ndescription: 一个技能\nversion: 1.2.3\n---\n# 标题\n正文内容\n';
    expect(parseSkillMd(md)).toEqual({ name: 'my-skill', description: '一个技能', version: '1.2.3' });
  });
  it('未知 frontmatter 键静默忽略（Claude/Codex 兼容机制）', () => {
    const md = '---\nname: a\nlicense: MIT\nallowed-tools: [shell_execute]\nmetadata:\n  foo: bar\ndescription: d\n---\n正文';
    const m = parseSkillMd(md);
    expect(m.name).toBe('a');
    expect(m.description).toBe('d');
    expect(m.version).toBeUndefined();
  });
  it('带引号的值去引号', () => {
    const md = '---\nname: "quoted-name"\ndescription: \'单引号\'\n---\n';
    expect(parseSkillMd(md)).toEqual({ name: 'quoted-name', description: '单引号' });
  });
});

describe('parseSkillMd headless frontmatter（无 --- 包围也认）', () => {
  it('开头键值区直接解析，正文第一个非键值行截止', () => {
    const md = 'name: headless\ndescription: 没有围栏\n\n# 正文开始\nversion: 这行在正文里不算\n';
    const m = parseSkillMd(md);
    expect(m.name).toBe('headless');
    expect(m.description).toBe('没有围栏');
    expect(m.version).toBeUndefined();
  });
  it('纯正文（无键值）返回空对象而不抛异常', () => {
    expect(parseSkillMd('# 只是标题\n随便写点啥\n')).toEqual({});
    expect(parseSkillMd('')).toEqual({});
    expect(parseSkillMd('---\n---\n')).toEqual({});
  });
});

describe('parseSkillMd YAML 块标量（含 chomping 变体）', () => {
  it('| 保留换行，clip 补一个尾部换行', () => {
    const md = '---\nname: b\ndescription: |\n  第一行\n  第二行\n---\n';
    expect(parseSkillMd(md).description).toBe('第一行\n第二行\n');
  });
  it('|- strip 不补尾部换行', () => {
    const md = '---\ndescription: |-\n  第一行\n  第二行\n---\n';
    expect(parseSkillMd(md).description).toBe('第一行\n第二行');
  });
  it('> 折叠段内换行为空格，空行分段', () => {
    const md = '---\ndescription: >\n  第一行\n  第二行\n\n  第二段\n---\n';
    expect(parseSkillMd(md).description).toBe('第一行 第二行\n第二段\n');
  });
  it('>- 折叠 + strip', () => {
    const md = '---\ndescription: >-\n  aa\n  bb\n---\n';
    expect(parseSkillMd(md).description).toBe('aa bb');
  });
  it('|+ keep 保留尾部空行', () => {
    const md = '---\ndescription: |+\n  内容\n\n\n---\n';
    expect(parseSkillMd(md).description).toBe('内容\n\n\n');
  });
  it('未知键的块标量不会吞掉后续的 name 键', () => {
    const md = '---\nnotes: |\n  占用多行\n  的未知键\nname: after-block\n---\n';
    expect(parseSkillMd(md).name).toBe('after-block');
  });
});

describe('parseSkillMd 损坏容错（中途保存）', () => {
  it('缺失闭合 --- 时按 headless 兜底，能救回多少是多少', () => {
    const md = '---\nname: rescued\ndescription: |-\n  写到一半没保存完';
    const m = parseSkillMd(md);
    expect(m.name).toBe('rescued');
    expect(m.description).toBe('写到一半没保存完');
  });
  it('键值区混着垃圾行不抛异常', () => {
    const m = parseSkillMd('---\n{{{ 这不是 yaml\nname: ok\n---\n');
    expect(m.name).toBe('ok');
  });
});

describe('slugify 稳定 id', () => {
  it('大小写/空格/特殊字符折叠', () => {
    expect(slugify('My Cool Skill!')).toBe('my-cool-skill');
    expect(slugify('  multi   sep__chars  ')).toBe('multi-sep-chars');
  });
  it('CJK 保留且稳定', () => {
    expect(slugify('技能A')).toBe('技能a');
    expect(slugify('技能A')).toBe(slugify('技能A'));
  });
  it('空结果兜底 unnamed-skill', () => {
    expect(slugify('---')).toBe('unnamed-skill');
    expect(slugify('')).toBe('unnamed-skill');
  });
});

describe('nameFromUrl URL 兜底命名', () => {
  it('取最后路径段并去 .git', () => {
    expect(nameFromUrl('https://github.com/owner/repo')).toBe('repo');
    expect(nameFromUrl('https://github.com/owner/repo.git')).toBe('repo');
    expect(nameFromUrl('https://github.com/o/r/tree/main/skills/pdf')).toBe('pdf');
    expect(nameFromUrl('https://github.com/owner/repo/')).toBe('repo');
  });
  it('非法 URL 用斜杠切分兜底，全空给 unnamed-skill', () => {
    expect(nameFromUrl('C:\\skills\\my-skill')).toBe('my-skill');
    expect(nameFromUrl('')).toBe('unnamed-skill');
  });
});
