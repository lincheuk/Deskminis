/** E4：键盘可达补课·9 控件专属守卫（设计稿 §6.2 兑现）。
 *
 *  与 a11y-keyboard-reachable.test.ts（普遍规则：凡 <div @click> 必有键盘通路）分工不同，
 *  本文件钉死设计稿点名的 9 个 [文件, 类名]——它们是 MU3 焦点环「空转」的老账：
 *  26 处 :focus-visible 环里 9 处画在 Tab 走不到的 div 上。
 *  组件侧修复已由 cc9363a（a11y 补齐 17→0）与 MU5（.tb-ico 退役为原生 button.tb-seg）落地，
 *  本守卫的职责是把这 9 类**逐一钉死**防回归：任何一类丢了 tabindex/role/keydown，或
 *  已退役的 .tb-ico 死模式回魂，立刻红。
 *
 *  对规格的一处有意偏离（已申报）：规格写「一律 role="button" 最小语义」，但落地代码用了
 *  更精确的 widget role（menuitem / tab / radio / option）——语义更准确、读屏更有用，
 *  回退成 button 是 a11y 倒退。守卫底线定为「必须有语义 role」（button 或更精确者），
 *  裸 div 无 role 即红；这与既有普遍守卫（只查 role 存在）方向一致、收口更紧。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const COMPONENTS = path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'components');

/** 只取 <template> 段；行尾归一化（仓库强制 LF，Windows 检出仍可能带 CRLF）。 */
function template(file: string): string {
  const src = fs.readFileSync(path.join(COMPONENTS, file), 'utf8').replace(/\r\n/g, '\n');
  const m = src.match(/<template>([\s\S]*)<\/template>/);
  return m ? m[1] : src;
}

/** 设计稿 §6.2 点名的 9 个 [文件, 类名] 组合。 */
const ROWS: [string, string][] = [
  ['TitleBar.vue', 'tb-ico'],
  ['TitleBar.vue', 'mi'],
  ['TitleBar.vue', 'it'],
  ['SessionList.vue', 'scard'],
  ['SessionList.vue', 'newbtn'],
  ['SettingsModal.vue', 'sitem'],
  ['SettingsModal.vue', 'opt'],
  ['PermissionPicker.vue', 'mrow'],
  ['ModelPicker.vue', 'mrow'],
];

/** 可接受的语义 role：button 是底线，更精确的 widget role 更好（见文件头偏离说明）。 */
const SEMANTIC_ROLE = /role="(button|menuitem|tab|radio|option|switch|checkbox|link)"/;

/** 抓 class 含指定类名的开标签片段。
 *  (?<!:)class=" 排除 :class 动态绑定（其属性名以冒号开头，不算静态类名来源）；
 *  [^>]* 天然跨行，兼容「class 与事件分写在多行」的开标签（如 .scard/.sitem/.opt）。 */
function openingTags(tpl: string, cls: string): { tag: string; attrs: string }[] {
  const re = new RegExp(`<([a-z][a-z0-9-]*)\\b(?=[^>]*(?<!:)class="[^"]*\\b${cls}\\b)[^>]*>`, 'g');
  return [...tpl.matchAll(re)].map(m => ({ tag: m[1], attrs: m[0] }));
}

/** 单组合体检：返回缺失项描述列表（空数组 = 可达）。 */
function check(file: string, cls: string): string[] {
  const tags = openingTags(template(file), cls);
  if (cls === 'tb-ico') {
    // MU5 起 .tb-ico 已由原生 <button class="tb-seg"> 取代（原生可达，其样式随之删除）。
    // 本组合反向钉死：旧的死模式（div.tb-ico @click，Tab 走不到）不得回魂。
    return tags.length === 0 ? [] : [`${file} .${cls} 已退役为原生 button.tb-seg，却重现 ${tags.length} 处`];
  }
  if (tags.length === 0) return [`${file} 找不到 .${cls} 的开标签`];
  const missing: string[] = [];
  for (const { tag, attrs } of tags) {
    if (tag === 'button') continue; // 原生已可达，本条直接过
    const lacks: string[] = [];
    if (!/tabindex="0"/.test(attrs)) lacks.push('tabindex="0"');
    if (!SEMANTIC_ROLE.test(attrs)) lacks.push('语义 role');
    if (!/@keydown\.enter/.test(attrs)) lacks.push('@keydown.enter');
    if (!/@keydown\.space/.test(attrs)) lacks.push('@keydown.space');
    if (lacks.length) missing.push(`${file} .${cls}（<${tag}>）缺 ${lacks.join('、')}`);
  }
  return missing;
}

describe('E4 键盘可达：设计稿 §6.2 点名的 9 类控件逐一体检', () => {
  it.each(ROWS.map(([file, cls]) => ({ file, cls })))(
    '$file .$cls 自带键盘通路（tabindex="0" + 语义 role + Enter/Space）',
    ({ file, cls }) => {
      expect(check(file, cls)).toEqual([]);
    },
  );

  it('汇总：9 类控件全部可达（含 .tb-ico 退役防回魂）', () => {
    const missing = ROWS.flatMap(([file, cls]) => check(file, cls));
    expect(missing, `以下控件不可达：\n${missing.join('\n')}`).toEqual([]);
  });
});
