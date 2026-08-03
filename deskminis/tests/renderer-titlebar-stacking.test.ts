/** TitleBar 下拉菜单层级遮盖修复的源文本守卫。
 *
 *  背景（实测取证）：`.titlebar` 的 `backdrop-filter` 会创建层叠上下文，把下拉菜单
 *  `.pop { z-index: 40 }` 的层级**困在 titlebar 内部**。若 titlebar 自身是 static/z-auto，
 *  它在根层叠上下文里按「非定位元素」绘制，顺序低于主体中任何定位元素——菜单会被盖住。
 *  CDP 实测（elementFromPoint 网格取样）确认的覆盖者：
 *    - `.datehead`（sticky, z-index:1, 背景不透明）→ 横条遮挡（暗色主题下呈黑杠）
 *    - `.stream` / `.empty`（static 但 DOM 在后）→ 透明但抢走点击命中，菜单项点不动
 *  修法：给 `.titlebar` 自身 `position: relative; z-index: 50`，整棵子树抬到主体之上。
 *
 *  这些断言守的是**层级序不变量**，不是具体数字本身：
 *    主体内所有 z-index  <  标题栏(50)  <  模态(100/110)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const rendererDir = path.join(root, 'src/renderer/src');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

const TITLEBAR = 'src/renderer/src/components/TitleBar.vue';
const SETTINGS_MODAL = 'src/renderer/src/components/SettingsModal.vue';
const DEVICES_MODAL = 'src/renderer/src/components/DevicesModal.vue';

/** 取 .titlebar 规则块正文 */
function titlebarBlock(): string {
  const m = read(TITLEBAR).match(/\.titlebar\s*\{([\s\S]*?)\}/);
  if (!m) throw new Error('TitleBar.vue 中找不到 .titlebar 规则块');
  return m[1];
}

/** 递归收集目录下所有 .vue/.css 文件 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(vue|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 抽出文件中所有数值型 z-index（忽略 auto/inherit 等关键字） */
function numericZIndexes(src: string): number[] {
  return [...src.matchAll(/z-index:\s*(-?\d+)/g)].map(m => Number(m[1]));
}

const TITLEBAR_Z = 50;

describe('TitleBar 层级遮盖修复：源文本守卫', () => {
  it('.titlebar 必须同时有 position 与 z-index（缺任一则层叠上下文陷阱复发）', () => {
    const block = titlebarBlock();
    // 前提：backdrop-filter 仍在——它正是造成陷阱的原因，若被移除本守卫的理由需重新评估
    expect(block).toMatch(/backdrop-filter/);
    expect(block).toMatch(/position:\s*(relative|sticky|absolute|fixed)/);
    expect(block).toMatch(new RegExp(`z-index:\\s*${TITLEBAR_Z}\\b`));
  });

  it('两个模态的层级必须高于标题栏（模态要能盖住标题栏）', () => {
    for (const f of [SETTINGS_MODAL, DEVICES_MODAL]) {
      const zs = numericZIndexes(read(f));
      expect(zs.length).toBeGreaterThan(0);
      for (const z of zs) expect(z).toBeGreaterThan(TITLEBAR_Z);
    }
  });

  it('主体内所有 z-index 必须低于标题栏（否则会盖住下拉菜单）', () => {
    const exempt = new Set([TITLEBAR, SETTINGS_MODAL, DEVICES_MODAL].map(p => path.join(root, p)));
    const offenders: string[] = [];
    for (const file of walk(rendererDir)) {
      if (exempt.has(file)) continue;
      for (const z of numericZIndexes(fs.readFileSync(file, 'utf8'))) {
        if (z >= TITLEBAR_Z) offenders.push(`${path.relative(root, file)}: z-index ${z}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('下拉菜单 .pop 的 z-index 低于标题栏自身（它只在 titlebar 内部生效）', () => {
    const m = read(TITLEBAR).match(/\.pop\s*\{([\s\S]*?)\}/);
    expect(m).not.toBeNull();
    const z = numericZIndexes(m![1]);
    expect(z.length).toBe(1);
    expect(z[0]).toBeLessThan(TITLEBAR_Z);
  });
});
