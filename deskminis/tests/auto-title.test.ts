/** B1 会话标题：auto-title 的两个纯函数（buildTitleRequest 组请求 / cleanTitle 洗模型输出）。
 *  自动命名本体是 index.ts 里 fire-and-forget 的网络调用，可单测的只有这两头——
 *  组进去的请求参数、以及模型回来那串文本怎么收拾成能进标题栏的东西。 */
import { describe, it, expect } from 'vitest';
import { buildTitleRequest, cleanTitle } from '../src/minisd/agent/auto-title';

describe('buildTitleRequest', () => {
  it('固定参数：tools 空 / maxTokens 64 / thinking off / systemPrompt 限死字数且禁引号句号', () => {
    const req = buildTitleRequest('帮我重构登录模块');
    expect(req.tools).toEqual([]);
    expect(req.maxTokens).toBe(64);
    expect(req.thinkingLevel).toBe('off');
    expect(req.systemPrompt).toContain('12 个字');
    expect(req.systemPrompt).toContain('只输出标题本身');
  });

  it('messages 只含一条用户文本：取名不需要历史，带上等于把整个会话又发一遍', () => {
    const req = buildTitleRequest('帮我重构登录模块');
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe('user');
    expect(req.messages[0].parts).toEqual([{ type: 'text', value: '帮我重构登录模块' }]);
  });

  it('首条用户文本截断到 500 字：粘一整篇需求文档进来时，取名只用得上开头', () => {
    const req = buildTitleRequest('重'.repeat(1200));
    const v = (req.messages[0].parts[0] as { value: string }).value;
    expect(v).toBe('重'.repeat(500));
  });
});

describe('cleanTitle', () => {
  it('剥掉包裹引号（中英文各式）——模型十次有三次会把标题裹起来', () => {
    expect(cleanTitle('"重构登录模块"')).toBe('重构登录模块');
    expect(cleanTitle('「重构登录模块」')).toBe('重构登录模块');
    expect(cleanTitle('“重构登录模块”')).toBe('重构登录模块');
    expect(cleanTitle("'重构登录模块'")).toBe('重构登录模块');
  });

  it('去尾部句号（中英文），但正文里的点保留——v1.2 的点是内容不是标点', () => {
    expect(cleanTitle('重构登录模块。')).toBe('重构登录模块');
    expect(cleanTitle('重构登录模块.')).toBe('重构登录模块');
    expect(cleanTitle('升级到 v1.2')).toBe('升级到 v1.2');
  });

  it('换行折成空格再 trim：直接删换行会把上下两行的词黏成一个怪词', () => {
    expect(cleanTitle('  重构登录模块  ')).toBe('重构登录模块');
    expect(cleanTitle('重构\n登录模块')).toBe('重构 登录模块');
  });

  it('超 20 字截断：模型不守 12 字约定时得有硬闸，否则左栏 212px 一行塞不下', () => {
    expect(cleanTitle('标'.repeat(30))).toBe('标'.repeat(20));
  });

  it('空 / 纯标点 → undefined：拿不到像样的标题就别改，保留「新会话」', () => {
    expect(cleanTitle('')).toBeUndefined();
    expect(cleanTitle('   ')).toBeUndefined();
    expect(cleanTitle('""')).toBeUndefined();
    expect(cleanTitle('。')).toBeUndefined();
  });
});
