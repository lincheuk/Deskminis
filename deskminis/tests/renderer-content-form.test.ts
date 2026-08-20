/** I4 守卫（改造自 E3 renderer-aurora-content，AionUi 换向）：内容区平面形态（10 例）。
 *
 *  设计稿 2026-08-20-ui-redo-aionui-design.md §4：内容区从「实心浮岛 + 顶缘受光边」
 *  换向 AionUi 平面语言——用户消息右对齐浅蓝气泡、助手输出无背景满行宽平铺、
 *  思考块浅渐变条、卡类一律白底 + 1px 边 + 柔影。mono 读数面（E 波资产）不随皮退场。
 *
 *  断言面：
 *    1. 输入卡 .composer 圆角走 --r-input（I1 起 24px），聚焦态 --glow-accent 外光保留；
 *    2. 用户消息：.ublock 右对齐（flex-end），.utext 浅蓝气泡（--secondary-subtle）
 *       + 方向性圆角（右上收平的 AionUi 切角）；
 *    3. 助手消息：.abody 无卡片底（--surface-1 清零）——文档式满行宽平铺；
 *    4. ChatView 受光边全退场：--glass-edge 计数 0（覆盖消息卡/输入卡/浮条/气泡弹层）；
 *    5. ThinkingBlock：浅渐变条（linear-gradient + --secondary-subtle）+ mono 时长读数保留；
 *    6. ToolLine 运行态左缘活动线保留（--accent，I1 起为蓝）；
 *    7. PermissionCard：左缘警示线 --accent + mono 读数保留，受光边清零；
 *    8. SessionList：.scard 平面行（--r-card 保留、--surface-1 底退场），.scard.on
 *       灰底 + --accent 指示，受光边清零；
 *    9. 设置四页 + MarketPanel + EmptyState 受光边清零（--glass-edge 全站清零的内容区半场）；
 *   10. TerminalPanel xterm 兜底换算完成：旧 Aurora 值清零（正向锚 = mu3 例 9 新三值）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const DIR = 'src/renderer/src/components';
const CHATVIEW = `${DIR}/ChatView.vue`;
const THINKING = `${DIR}/ThinkingBlock.vue`;
const TOOLLINE = `${DIR}/ToolLine.vue`;
const PERMCARD = `${DIR}/PermissionCard.vue`;
const SESSIONLIST = `${DIR}/SessionList.vue`;
const SETTINGS = `${DIR}/SettingsModal.vue`;
const PROVIDER = `${DIR}/ProviderSettings.vue`;
const SKILLS = `${DIR}/SkillsSettings.vue`;
const MCP = `${DIR}/McpSettings.vue`;
const MARKET = `${DIR}/MarketPanel.vue`;
const EMPTY = `${DIR}/EmptyState.vue`;
const TERMINAL = `${DIR}/TerminalPanel.vue`;

/** 取某个 class 选择器的规则块正文（守的是样式声明本身，不是渲染结果） */
function ruleBlock(src: string, selector: string): string {
  const m = src.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\}`));
  if (!m) throw new Error(`找不到 ${selector} 规则块`);
  return m[1];
}
const count = (src: string, needle: string): number => src.split(needle).length - 1;

describe('I4 内容区平面形态：源码守卫', () => {
  it('1. 输入卡：.composer 含 var(--r-input)，:focus-within 聚焦态含 var(--glow-accent)', () => {
    const src = read(CHATVIEW);
    expect(ruleBlock(src, '.composer')).toContain('var(--r-input)');
    expect(ruleBlock(src, '.composer:focus-within')).toContain('var(--glow-accent)');
  });

  it('2. 用户消息右对齐浅蓝气泡：.ublock flex-end；.utext 含 --secondary-subtle 与方向性圆角', () => {
    const src = read(CHATVIEW);
    expect(ruleBlock(src, '.ublock')).toContain('align-items: flex-end');
    const utext = ruleBlock(src, '.utext');
    expect(utext).toContain('var(--secondary-subtle)');
    expect(utext).toMatch(/border-radius: var\(--r-control\) 0 var\(--r-control\) var\(--r-control\)/);
  });

  it('3. 助手消息平铺：.abody 无卡片底（--surface-1 清零）', () => {
    expect(ruleBlock(read(CHATVIEW), '.abody')).not.toContain('var(--surface-1)');
  });

  it('4. ChatView 受光边全退场：var(--glass-edge) 计数 0', () => {
    expect(count(read(CHATVIEW), 'var(--glass-edge)')).toBe(0);
  });

  it('5. ThinkingBlock：浅渐变条（linear-gradient + --secondary-subtle）+ mono 时长读数', () => {
    const src = read(THINKING);
    expect(ruleBlock(src, '.tkwrap')).toMatch(/linear-gradient\([^)]*var\(--secondary-subtle\)/);
    expect(src).toContain('var(--font-mono)');
  });

  it('6. ToolLine 运行态（.tline:has(.spin)）含 var(--accent)——左缘活动线', () => {
    const m = read(TOOLLINE).match(/\.tline:has\(\.spin\)\s*\{([\s\S]*?)\}/);
    if (!m) throw new Error('找不到 .tline:has(.spin) 规则块');
    expect(m[1]).toContain('var(--accent)');
  });

  it('7. PermissionCard：--accent 警示线 + --font-mono 读数保留，--glass-edge 清零', () => {
    const src = read(PERMCARD);
    expect(src).toContain('var(--accent)');
    expect(src).toContain('var(--font-mono)');
    expect(count(src, 'var(--glass-edge)')).toBe(0);
  });

  it('8. SessionList 平面行：.scard 含 --r-card 且无 --surface-1 底；.scard.on 含 --accent；--glass-edge 清零', () => {
    const src = read(SESSIONLIST);
    const card = ruleBlock(src, '.scard');
    expect(card).toContain('var(--r-card)');
    expect(card).not.toContain('var(--surface-1)');
    expect(ruleBlock(src, '.scard.on')).toContain('var(--accent)');
    expect(count(src, 'var(--glass-edge)')).toBe(0);
  });

  it('9. 设置四页 + MarketPanel + EmptyState：--glass-edge 清零（受光边全站退场·内容区半场）', () => {
    for (const f of [SETTINGS, PROVIDER, SKILLS, MCP, MARKET, EMPTY]) {
      expect(count(read(f), 'var(--glass-edge)'), `${f} 应零受光边`).toBe(0);
    }
  });

  it('10. TerminalPanel xterm 兜底：旧 Aurora 值 #1e2532/#a2adbd/#d0d6df 清零', () => {
    const t = read(TERMINAL);
    for (const c of ['#1e2532', '#a2adbd', '#d0d6df']) expect(t).not.toContain(c);
  });
});
