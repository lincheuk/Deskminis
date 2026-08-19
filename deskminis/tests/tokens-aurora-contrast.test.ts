/** E1 新守卫：Aurora 调色板 WCAG 对比度闸（26 对 AA + 1 条层次）。
 *
 *  为什么存在：MU3 移植 Appica 时留下了两笔对比度欠账——三级文字（--foreground-subtle）
 *  在浅暗两主题的多层 surface 上不过 4.5:1、浅段四个状态色 emphasis 在白底仅 ~3.9:1。
 *  Aurora 色板（设计稿 2026-08-19-ui-reskin-aurora.md §2）已把这些值设计进去，
 *  本守卫把「改色板必过 AA 闸」固化成红线，欠账不再复发。
 *
 *  数学：OKLCH → linear sRGB → WCAG 相对亮度（按 clamp 后的实际渲染色算，不是 OKLCH 的 L），
 *  标准转换零依赖，系数勿改。
 *
 *  取值：从 tokens.css 浅段（:root）与媒体暗段正则抓 oklch 实色三元组；
 *  强制暗/强制浅与这两段的一致性由 tokens-mu3-appica 例 2 保证，此处不重复断言。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const tokens = R('../src/renderer/src/styles/tokens.css');

/** 按选择器切片（与 tokens-mu3-appica.test.ts 相同的字面切片标记） */
function section(src: string, start: string, end?: string): string {
  const i = src.indexOf(start);
  if (i < 0) return '';
  const j = end ? src.indexOf(end, i + start.length) : -1;
  return src.slice(i, j < 0 ? src.length : j);
}
const rootLight = section(tokens, ':root {', '@media (prefers-color-scheme: dark)');
const mediaDark = section(tokens, '@media (prefers-color-scheme: dark)', '/* 强制深色');

type Oklch = [number, number, number];
/** 段内抓变量的 oklch 三元组（清单内变量全是不带 alpha 的实色；抓不到直接报变量名） */
function grab(seg: string, name: string): Oklch {
  const m = seg.match(new RegExp(`${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`));
  if (!m) throw new Error(`段内抓不到 ${name} 的 oklch 实色三元组`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function oklchToLinearSrgb(L: number, C: number, Hdeg: number): [number, number, number] {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const clamp01 = (c: number) => Math.min(1, Math.max(0, c));
// WCAG 相对亮度用 clamp 后的 linear sRGB（即浏览器实际渲染色），不是 OKLCH 的 L
function lum(L: number, C: number, H: number): number {
  const [r, g, b] = oklchToLinearSrgb(L, C, H).map(clamp01);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg: Oklch, bg: Oklch): number {
  const l1 = lum(...fg), l2 = lum(...bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 表驱动：每行一对「前景 on 背景 ≥ 阈值」，阈值 4.5 = 文本 AA，3 = 焦点环等非文本 AA */
const DARK_PAIRS: Array<[fg: string, bg: string, min: number]> = [
  ['--foreground-subtle', '--background', 4.5],
  ['--foreground-subtle', '--background-muted', 4.5],
  ['--foreground-subtle', '--background-strong', 4.5],
  ['--foreground-muted', '--background-strong', 4.5],
  ['--foreground-strong', '--background-strong', 4.5],
  ['--secondary-emphasis', '--background', 4.5],
  ['--secondary-emphasis', '--background-strong', 4.5],
  ['--secondary-foreground', '--secondary-emphasis', 4.5], // 青钮底深字
  ['--focus-ring', '--background', 3],
  ['--error-emphasis', '--background', 4.5],
  ['--success-emphasis', '--background', 4.5],
  ['--warning-emphasis', '--background', 4.5],
  ['--info-emphasis', '--background', 4.5],
];
const LIGHT_PAIRS: Array<[fg: string, bg: string, min: number]> = [
  ['--foreground-subtle', '--background', 4.5],
  ['--foreground-subtle', '--background-muted', 4.5],
  ['--foreground-subtle', '--background-strong', 4.5],
  ['--foreground-muted', '--background-strong', 4.5],
  ['--foreground-strong', '--background-strong', 4.5],
  ['--secondary-emphasis', '--background', 4.5],
  ['--primary-foreground', '--secondary-emphasis', 4.5], // 深青钮底白字
  ['--focus-ring', '--background', 3],
  ['--error-emphasis', '--background', 4.5],
  ['--success-emphasis', '--background', 4.5],
  ['--warning-emphasis', '--background', 4.5],
  ['--info-emphasis', '--background', 4.5],
];

describe('E1 Aurora 对比度守卫（26 对 AA + 1 条层次）', () => {
  for (const [fg, bg, min] of DARK_PAIRS) {
    it(`暗段 ${fg} on ${bg} ≥ ${min}:1`, () => {
      const ratio = contrast(grab(mediaDark, fg), grab(mediaDark, bg));
      expect(ratio, `${fg} on ${bg} 实测 ${ratio.toFixed(2)}:1，要求 ≥ ${min}:1`).toBeGreaterThanOrEqual(min);
    });
  }
  for (const [fg, bg, min] of LIGHT_PAIRS) {
    it(`浅段 ${fg} on ${bg} ≥ ${min}:1`, () => {
      const ratio = contrast(grab(rootLight, fg), grab(rootLight, bg));
      expect(ratio, `${fg} on ${bg} 实测 ${ratio.toFixed(2)}:1，要求 ≥ ${min}:1`).toBeGreaterThanOrEqual(min);
    });
  }
  it('暗段文字层次可辨：lum(--foreground-muted) / lum(--foreground-subtle) ≥ 1.25', () => {
    // 防复发：三级补对比度时被提到与次级同色、压掉层次（设计稿 §2「与次级保持亮度差」）
    const ratio = lum(...grab(mediaDark, '--foreground-muted')) / lum(...grab(mediaDark, '--foreground-subtle'));
    expect(ratio, `muted/subtle 亮度比实测 ${ratio.toFixed(2)}，要求 ≥ 1.25`).toBeGreaterThanOrEqual(1.25);
  });
});
