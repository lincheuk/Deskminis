/** 补充14a：按真实CSS级联取四种主题的值，供出处与Markdown对比度守卫共用。 */
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

export const rendererRoot = path.resolve(__dirname, '../src/renderer/src');
export const themeCss = fs.readFileSync(path.join(rendererRoot, 'styles/theme.css'), 'utf8');
export const MODES = ['system-light', 'system-dark', 'forced-dark', 'forced-light'] as const;
export type Mode = typeof MODES[number];

export function themeTokens(mode: Mode): Record<string, string> {
  const systemDark = mode === 'system-dark' || mode === 'forced-light';
  const forced = mode === 'forced-dark' ? 'dark' : mode === 'forced-light' ? 'light' : null;
  const result: Record<string, string> = {}, priority: Record<string, number> = {};
  postcss.parse(themeCss).walkRules(rule => {
    const declarations = rule.nodes.filter(n => n.type === 'decl' && n.prop.startsWith('--'));
    if (!declarations.length) return;
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type !== 'atrule' || p.name !== 'media' || p.params !== '(prefers-color-scheme: dark)') throw new Error('未处理的令牌作用域');
      if (!systemDark) return;
    }
    let matches = false, specificity = 0;
    switch (rule.selector) {
      case ':root': matches = true; specificity = 1; break;
      case ':root[data-theme="dark"]': matches = forced === 'dark'; specificity = 2; break;
      case ':root[data-theme="light"]': matches = forced === 'light'; specificity = 2; break;
      case ':root:not([data-theme="light"])': matches = forced !== 'light'; specificity = 2; break;
      default: throw new Error(`未处理的令牌选择器 ${rule.selector}`);
    }
    if (matches) for (const d of declarations) if (d.type === 'decl' && specificity >= (priority[d.prop] ?? 0)) {
      result[d.prop] = d.value; priority[d.prop] = specificity;
    }
  });
  const resolve = (name: string, chain: string[] = []): string => {
    if (chain.includes(name) || result[name] === undefined) throw new Error(`无法解析令牌 ${name}`);
    return result[name].replace(/var\((--[\w-]+)\)/g, (_, key) => resolve(key, [...chain, name]));
  };
  return Object.fromEntries(Object.keys(result).map(name => [name, resolve(name)]));
}

export function oklchParts(value: string): number[] {
  const m = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%)?)?\)$/.exec(value);
  if (!m) throw new Error(`不是OKLCH值 ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1)];
}

const decode = (c: number) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
const encode = (c: number) => c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055;
type Rgba = [number, number, number, number];
function rgba(value: string): Rgba {
  if (/^#[\da-f]{6}$/i.test(value)) {
    const n = parseInt(value.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  // 沿用退场Aurora守卫的OKLCH→linear sRGB系数及clamp；混色在显示sRGB中做source-over。
  const [L, C, H, alpha] = oklchParts(value), h = H * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (L - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (L - .0894841775 * a - 1.291485548 * b) ** 3;
  return [...[
    4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
    -.0041960863 * l - .7034186147 * m + 1.707614701 * s,
  ].map(c => encode(Math.max(0, Math.min(1, c)))), alpha] as Rgba;
}
const over = (a: Rgba, b: Rgba): Rgba => [a[0] * a[3] + b[0] * (1 - a[3]), a[1] * a[3] + b[1] * (1 - a[3]), a[2] * a[3] + b[2] * (1 - a[3]), 1];
const lum = (c: Rgba) => .2126 * decode(c[0]) + .7152 * decode(c[1]) + .0722 * decode(c[2]);
export function colorLuminance(value: string): number { return lum(rgba(value)); }
export function contrastOf(tokens: Record<string, string>, foreground: string, background: string, underlay?: string): number {
  let bg = rgba(tokens[background]);
  if (bg[3] !== 1) { if (!underlay) throw new Error(`缺少半透明底色 ${background} 的底层`); bg = over(bg, rgba(tokens[underlay])); }
  const fg = over(rgba(tokens[foreground]), bg), a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

/** 每行：前景、背景、半透明背景的底层、出处。四模式各算一次，不把选区/边框当文字。 */
export const MARKDOWN_PAIRS: [string, string, string | undefined, string][] = [
  ['--c-ink', '--c-bg', undefined, 'StageChat/LiveTurn .ablock + AppShell .stage；PreviewPane .doc'],
  ['--c-ink', '--c-bg-1', undefined, 'StageMarket .readme正文'],
  ['--c-ink', '--grouped-bg-secondary', undefined, 'MarkdownView .md-pre/.md-table th'],
  ['--label-secondary', '--c-bg', undefined, 'MarkdownView .md-quote；会话/文档'],
  ['--label-secondary', '--c-bg-1', undefined, 'MarkdownView .md-quote；市场说明'],
  ['--label-secondary', '--grouped-bg-secondary', undefined, 'MarkdownView .md-codebar/.md-copy；引用内表头'],
  ['--link', '--c-bg', undefined, 'MarkdownInline .md-link；会话/文档/引用'],
  ['--link', '--c-bg-1', undefined, 'MarkdownInline .md-link；市场说明/引用'],
  ['--link', '--grouped-bg-secondary', undefined, 'MarkdownInline .md-link；MarkdownView表头'],
  ['--c-ink', '--fill-quaternary', '--c-bg', 'MarkdownInline .md-icode；会话/文档正文'],
  ['--c-ink', '--fill-quaternary', '--c-bg-1', 'MarkdownInline .md-icode；市场正文'],
  ['--c-ink', '--fill-quaternary', '--grouped-bg-secondary', 'MarkdownInline .md-icode；表头'],
  ['--label-secondary', '--fill-quaternary', '--c-bg', 'MarkdownInline .md-icode；会话/文档引用'],
  ['--label-secondary', '--fill-quaternary', '--c-bg-1', 'MarkdownInline .md-icode；市场引用'],
  ['--label-secondary', '--fill-quaternary', '--grouped-bg-secondary', 'MarkdownInline .md-icode；引用内表头'],
  ['--link', '--fill-quaternary', '--c-bg', 'MarkdownInline .md-link内行内码；会话/文档'],
  ['--link', '--fill-quaternary', '--c-bg-1', 'MarkdownInline .md-link内行内码；市场说明'],
  ['--link', '--fill-quaternary', '--grouped-bg-secondary', 'MarkdownInline .md-link内行内码；表头'],
  ['--label', '--fill-tertiary', undefined, 'MarkdownView .md-copy:hover'],
];
export const pairKey = (pair: readonly (string | undefined)[]) => pair.slice(0, 3).map(v => v ?? '').join('|');

/** 从实际声明独立推导配对全集：新增/漏掉表项也必须被看见。透明块继承所在容器底色。 */
export function expectedMarkdownPairs(): string[] {
  const property = (file: string, selector: string, prop: string): string => {
    const source = fs.readFileSync(path.join(rendererRoot, file), 'utf8');
    let value: string | undefined;
    for (const [, style] of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) postcss.parse(style).walkRules(rule => {
      if (!rule.selector.split(',').map(s => s.trim()).includes(selector)) return;
      rule.walkDecls(prop, d => { value = d.value; });
    });
    const m = /^var\((--[\w-]+)\)$/.exec(value ?? '');
    if (!m) throw new Error(`${file} ${selector} ${prop}不是单一令牌`);
    return m[1];
  };
  const main = property('ui/StageChat.vue', '.ablock', 'color');
  if (property('ui/LiveTurn.vue', '.ablock', 'color') !== main || property('ui/PreviewPane.vue', '.doc', 'color') !== main || property('ui/StageMarket.vue', '.readme', 'color') !== main) throw new Error('Markdown继承文字语境改变');
  const surfaces = [...new Set([property('ui/AppShell.vue', '.stage', 'background'), property('ui/PreviewPane.vue', '.doc', 'background'), property('ui/StageMarket.vue', '.readme', 'background')])];
  const md = 'components/MarkdownView.vue', inline = 'components/MarkdownInline.vue';
  const secondary = property(md, '.md-quote', 'color'), link = property(inline, '.md-link', 'color');
  const grouped = property(md, '.md-code', 'background'), fill = property(inline, '.md-icode', 'background');
  if (property(md, '.md-codebar', 'color') !== secondary || property(md, '.md-copy', 'color') !== secondary || property(md, '.md-table th', 'background') !== grouped) throw new Error('Markdown局部文字/底色语境改变');
  const backgrounds = [...new Set([...surfaces, grouped])], keys: string[] = [];
  for (const fg of [main, secondary, link]) for (const bg of backgrounds) {
    keys.push(pairKey([fg, bg, undefined]), pairKey([fg, fill, bg]));
  }
  keys.push(pairKey([property(md, '.md-copy:hover', 'color'), property(md, '.md-copy:hover', 'background'), undefined]));
  return [...new Set(keys)].sort();
}
