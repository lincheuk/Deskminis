/** L 波候选池批次守卫（设计稿 2026-08-20-pool-batch-design.md）：
 *  L1 输入历史纯模块 + 接线；L2 @ 文件；L3 锚点轨；L4 md 预览；L5 会话级 MCP pill。
 *  各步落地时在此追加断言（同一批次一个守卫文件，拆步 commit 里逐项申报）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { histStep } from '../src/renderer/src/lib/composer/history';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

describe('L1 histStep 纯判据', () => {
  const E = ['第一条', '第二条', '第三条'];
  it('空表不应用；有草稿不抢（草稿比历史贵）', () => {
    expect(histStep([], '', -1, -1)).toBeNull();
    expect(histStep(E, '打了一半的草稿', -1, -1)).toBeNull();
  });
  it('空输入 ↑ 进最新；继续 ↑ 向旧走；到最旧停住不回绕', () => {
    let r = histStep(E, '', -1, -1)!;
    expect(r).toEqual({ text: '第三条', cursor: 2 });
    r = histStep(E, r.text, r.cursor, -1)!;
    expect(r).toEqual({ text: '第二条', cursor: 1 });
    r = histStep(E, r.text, r.cursor, -1)!;
    expect(r).toEqual({ text: '第一条', cursor: 0 });
    expect(histStep(E, r.text, r.cursor, -1)).toEqual({ text: '第一条', cursor: 0 });
  });
  it('↓ 向新走；越过最新清空退出；非历史态 ↓ 不应用', () => {
    let r = histStep(E, '第一条', 0, 1)!;
    expect(r).toEqual({ text: '第二条', cursor: 1 });
    r = histStep(E, '第三条', 2, 1)!;
    expect(r).toEqual({ text: '', cursor: -1 });
    expect(histStep(E, '随便', -1, 1)).toBeNull();
  });
  it('编辑过的历史条 = 退出历史态（current 不匹配即 null）', () => {
    expect(histStep(E, '第二条改过', 1, -1)).toBeNull();
    expect(histStep(E, '第二条改过', 1, 1)).toBeNull();
  });
});

describe('L1 接线：ChatView 历史上翻挂 onSlashNav（斜杠菜单优先级不动）', () => {
  it('ChatView 引用 histStep 且发送后复位游标', () => {
    const cv = read('src/renderer/src/components/ChatView.vue');
    expect(cv).toContain("from '../lib/composer/history'");
    expect(cv).toContain('histStep(');
    expect(cv).toContain('histCursor');
  });
});
