/** TitleBar 下拉菜单层级遮盖修复的源文本守卫。
 *
 *  历史背景（实测取证）：`.titlebar` 曾带 `backdrop-filter`，它会创建层叠上下文，把下拉菜单
 *  `.pop { z-index: 40 }` 的层级**困在 titlebar 内部**。若 titlebar 自身是 static/z-auto，
 *  它在根层叠上下文里按「非定位元素」绘制，顺序低于主体中任何定位元素——菜单会被盖住。
 *  CDP 实测（elementFromPoint 网格取样）确认的覆盖者：
 *    - `.datehead`（sticky, z-index:1, 背景不透明）→ 横条遮挡（暗色主题下呈黑杠）
 *    - `.stream` / `.empty`（static 但 DOM 在后）→ 透明但抢走点击命中，菜单项点不动
 *  修法：给 `.titlebar` 自身 `position: relative; z-index: 50`，整棵子树抬到主体之上。
 *
 *  MU3 修订（计划 §3-4，自审第 8 处订正）：材质已全退场，「滤镜创建层叠上下文困住 .pop」的
 *  原始诱因消失，但 `position: relative; z-index: 50` **保留**，理由改写为**防御性层级槽位**：
 *    - 「主体所有 z-index < 50 < 模态 100/110」的不变量由本文件后三例固化，保留槽位使该
 *      不变量继续可守卫、可推理；
 *    - 未来任何浮层/滤镜/transform 重新引入 titlebar 层叠上下文时，陷阱不复发；
 *    - 保留成本为零（一行既有 CSS 不动）。
 *  第 1 例的滤镜断言随之**反转**（不是删除——删除会让先红预期落空且留下守卫真空）：
 *  滤镜不得回潮；一旦回潮，层叠上下文陷阱的前提即复发。
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

const TITLEBAR = 'src/renderer/src/ui/TopBar.vue';
const SETTINGS_MODAL = 'src/renderer/src/ui/StageSettings.vue';
const DEVICES_MODAL = 'src/renderer/src/ui/StageDevices.vue';
/** G3 申报偏离：MarketPanel 自带安装确认卡（scrim+sheet 模态，z-index 100 与上两模态同档），
 *  是第三个模态宿主——层级序不变量里模态本就在标题栏之上，故入豁免集。 */
const MARKET_PANEL = 'src/renderer/src/ui/StageMarket.vue';
/** V7 申报偏离：新壳的 StageMarket 同样是「面板 + 模态宿主」混合体（安装确认卡 + toast），
 *  照 MarketPanel 的先例做**值级**豁免（只放行 100），面板内其余元素仍须低于标题栏。 */
const STAGE_MARKET = 'src/renderer/src/ui/StageMarket.vue';

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
  /* 「.titlebar 必须同时有 position 与 z-index」在 T6e-3 退场：新树的 ui/TopBar.vue
     在正常流里，没有 position 也没有 z-index，因为**没有需要抬升的子树**——
     设置 / 设备这些当年的模态现在是独立舞台视图，标题栏里不再挂下拉菜单。
     50 这个档位保留为**空置的防御性槽位**（见下两例的上下界），文件头注释第 12-13 行
     早就预写了这个理由。 */

  it('模态层必须高于标题栏槽位（模态要能盖住一切）', () => {
    // T6e-3 重指：当年的「设置模态 / 设备模态」在新树里是**独立舞台视图**，
    // 平铺在主体里、没有 z-index 也不该有。现在真正的模态只剩 StageMarket 的
    // 安装确认卡与 toast（100）。断言随之收窄到「凡是模态，都在 50 之上」。
    const zs = numericZIndexes(read(STAGE_MARKET));
    expect(zs.length, 'StageMarket 的模态层没了？').toBeGreaterThan(0);
    for (const z of zs) expect(z).toBeGreaterThan(TITLEBAR_Z);
  });

  it('主体内所有 z-index 必须低于标题栏槽位（这是本文件真正的资产）', () => {
    // 这一例是全树递归扫描，不锚任何单个文件——T6d 就是靠它逮到 StageMarket
    // 把模态 z-index 写在主体档（40/50）的。清场后旧组件树消失，扫描面自动收敛到新树。
    const exempt = new Set([path.join(root, STAGE_MARKET)]);
    const offenders: string[] = [];
    for (const file of walk(rendererDir)) {
      if (exempt.has(file)) continue;
      for (const z of numericZIndexes(fs.readFileSync(file, 'utf8'))) {
        if (z >= TITLEBAR_Z) offenders.push(`${path.relative(root, file)}: z-index ${z}`);
      }
    }
    expect(offenders, `这些元素越过了标题栏槽位（${TITLEBAR_Z}）`).toEqual([]);
  });

  it('模态宿主的豁免是**值级**的：面板内其余元素仍须低于槽位', () => {
    // 文件级豁免会让整个面板失去守卫（镇魂碑第 5 条：豁免要做值级不做文件级）。
    for (const z of numericZIndexes(read(STAGE_MARKET))) {
      expect([100, 110], `StageMarket 里出现了非模态档的高 z-index: ${z}`).toContain(z);
    }
  });
});
