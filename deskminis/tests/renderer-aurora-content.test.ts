/** E3 新守卫：Aurora 内容区「实心浮岛」与 mono 读数的源文本断言（8 例）。
 *
 *  背景：E2（64cdcc5）把壳层玻璃化后，内容区（消息流/输入卡/会话卡/设置页）还是
 *  平贴材质。本步按设计稿 §4 把内容区做成**实心浮岛**——不透明 surface + 顶缘内高光
 *  （inset --glass-edge）+ 柔影，**全程不新增 backdrop-filter**：ChatView/SessionList/
 *  SettingsModal 在 §5 blur 永久禁用清单（POPUP_OWNERS 例 8 双保险）内，消息卡数量
 *  还会随会话增长，blur 开销不可控。故浮岛质感一律用实心 + 高光 + 影模拟。
 *
 *  断言面：
 *    1. 输入卡 .composer 圆角走 --r-input，且聚焦态（:focus-within）有 --glow-accent 外光；
 *    2. ChatView 消费 --glass-edge ≥1（助手消息卡顶缘高光）；
 *    3. ThinkingBlock 消费 --font-mono（「思考 · N 秒」时长读数）；
 *    4. ToolLine 运行态（:has(.spin)）含 --accent（左缘 2px 活动线，inset 不位移）；
 *    5. PermissionCard 含 --accent（左缘 3px 警示线）与 --font-mono（工具名/路径读数）；
 *    6. SessionList .scard 浮岛（--r-card + --glass-edge），活跃卡（.scard.on）含 --accent；
 *    7. 设置四页各消费 --glass-edge ≥1（分组卡浮岛）；
 *    8. 反向锚：本步十组件 <style> 内 backdrop-filter 出现次数与 E2 后现状一致（全为 0）。
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
const EMPTY = `${DIR}/EmptyState.vue`;

/** 取某个 class 选择器的规则块正文（守的是样式声明本身，不是渲染结果） */
function ruleBlock(src: string, selector: string): string {
  const m = src.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\}`));
  if (!m) throw new Error(`找不到 ${selector} 规则块`);
  return m[1];
}

describe('E3 Aurora 内容区：浮岛化 + mono 读数源码守卫', () => {
  it('1. 输入卡：.composer 含 var(--r-input)，且 :focus-within 聚焦态含 var(--glow-accent) 外光', () => {
    const src = read(CHATVIEW);
    expect(ruleBlock(src, '.composer')).toContain('var(--r-input)');
    // 聚焦外光是「输入卡是视觉主角」的那一档（设计 §4：1px→2px）
    expect(ruleBlock(src, '.composer:focus-within')).toContain('var(--glow-accent)');
  });

  it('2. ChatView 消费 var(--glass-edge) 至少一处（助手消息卡顶缘高光）', () => {
    expect(read(CHATVIEW)).toContain('var(--glass-edge)');
  });

  it('3. ThinkingBlock 含 var(--font-mono)（「思考 · N 秒」时长读数走等宽）', () => {
    expect(read(THINKING)).toContain('var(--font-mono)');
  });

  it('4. ToolLine 运行态（.tline:has(.spin)）含 var(--accent)——左缘活动线', () => {
    // ruleBlock 不转义括号，:has(.spin) 需自写转正则（意图锚：运行态行块内有 accent 缘线）
    const m = read(TOOLLINE).match(/\.tline:has\(\.spin\)\s*\{([\s\S]*?)\}/);
    if (!m) throw new Error('找不到 .tline:has(.spin) 规则块');
    expect(m[1]).toContain('var(--accent)');
  });

  it('5. PermissionCard 含 var(--accent)（左缘 3px 警示线）且含 var(--font-mono)（工具名/路径读数）', () => {
    const src = read(PERMCARD);
    expect(src).toContain('var(--accent)');
    expect(src).toContain('var(--font-mono)');
  });

  it('6. SessionList：.scard 含 var(--r-card) 与 var(--glass-edge)（会话卡浮岛），.scard.on 含 var(--accent)', () => {
    const src = read(SESSIONLIST);
    const card = ruleBlock(src, '.scard');
    expect(card).toContain('var(--r-card)');
    expect(card).toContain('var(--glass-edge)');
    expect(ruleBlock(src, '.scard.on')).toContain('var(--accent)');
  });

  it('7. 设置四页各消费 var(--glass-edge) 至少一处（分组卡浮岛）', () => {
    for (const f of [SETTINGS, PROVIDER, SKILLS, MCP]) {
      expect(read(f), `${f} 应含 var(--glass-edge)`).toContain('var(--glass-edge)');
    }
  });

  it('8. 反向锚：本步十组件 <style> 内 backdrop-filter 计数与 E2 后现状一致（全为 0，白名单零扩）', () => {
    // E2 后实测：十文件 <style> 段 backdrop-filter 均为 0（blur 面恒定 = §5 白名单，本步零新增）。
    // 锚定计数而非「不含」，是因为守卫的意图是「不许比现状多」——现状有值时按实际数锚。
    const baseline: Record<string, number> = {
      [CHATVIEW]: 0, [THINKING]: 0, [TOOLLINE]: 0, [PERMCARD]: 0, [SESSIONLIST]: 0,
      [SETTINGS]: 0, [PROVIDER]: 0, [SKILLS]: 0, [MCP]: 0, [EMPTY]: 0,
    };
    for (const [f, n] of Object.entries(baseline)) {
      const style = read(f).slice(read(f).indexOf('<style'));
      expect(style.split('backdrop-filter').length - 1, `${f} backdrop-filter 计数应维持 ${n}`).toBe(n);
    }
  });
});
