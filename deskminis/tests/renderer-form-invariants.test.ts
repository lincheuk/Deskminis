/**
 * T6e · 从 mu5-workbench-layout 迁移过来的**与布局无关**的形态不变量。
 *
 * mu5 那份 34 例守的是「布局 B」——旧 App.vue 的图标轨 / 任务条 / 标签系统 / 定宽分栏，
 * T 波推倒重做后那套 DOM 一个都不剩，整文件随实现退场。
 * 但其中有几条守的**不是布局，是形态**，换了壳照样成立，逐条搬到新树来。
 *
 * 两条**没有**搬、原因记明：
 * ① `.abody{line-height: var(--lh-relaxed)}`（旧约 1.7）——新树对话正文是
 *    `--t-chat-lh`（24px / 16px = 1.5），比旧的更紧。这不是漂移是**换了裁定**，
 *    照搬会红；要不要回到 1.7 是排版议题，得先目视再定，不能靠守卫替人拍板。
 * ② `scrollbar-gutter: stable both-edges`——新树零命中。旧壳靠它防「滚动条一出现
 *    正文就横跳」，新壳的滚动容器结构不同，是否需要要实测才知道，记为待查而非直接钉死。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', 'src', 'renderer', 'src');
const read = (p: string): string => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

describe('T6e — 字体栈（Windows 优先，中文不许回落到雅黑）', () => {
  const theme = read('styles/theme.css');
  it('--f-ui 含随包思源黑体，雅黑仍作兜底', () => {
    expect(theme).toMatch(/--f-ui:[^;]*"Noto Sans SC"/s);
    expect(theme).toMatch(/--f-ui:[^;]*"Microsoft YaHei"/s);
  });
  it('--f-mono 含 Cascadia（Windows 自带等宽）', () => {
    expect(theme).toMatch(/--f-mono:[^;]*Cascadia/s);
  });
});

describe('T6e — 输入卡形态：静止无影，聚焦有晕', () => {
  const c = read('ui/Composer.vue');
  /** 「浮起」是动效语言，静止态用它显廉价——AionUi 实测静止 box-shadow:none，
   *  只在聚焦时上一层淡色晕。S 波按实测把 I 波的臆测锚推翻过一次，别再翻回去。 */
  it('静止态无投影', () => {
    expect(c).toMatch(/\.card\s*\{[^}]*box-shadow:\s*none/s);
  });
  it('聚焦态有晕（走 --sh-focus，不写死值）', () => {
    expect(c).toMatch(/\.card:focus-within\s*\{[^}]*box-shadow:\s*var\(--sh-focus\)/s);
  });
});

describe('T6e — 胶囊不换行（挤压时收缩，不折断文字）', () => {
  /** 旧锚是「容器 .ctools 必须 overflow:hidden」——那锚的是实现不是目的，
   *  还把一个 bug 焊死了（浮层被裁）。正确的意图是「chip 自己不换行」。 */
  it('胶囊文字走 nowrap + 省略号（收在文字上，图标不跟着缩）', () => {
    const c = read('ui/Composer.vue');
    expect(c).toMatch(/\.cap > span\s*\{[^}]*white-space:\s*nowrap/s);
    expect(c).toMatch(/\.cap > span\s*\{[^}]*text-overflow:\s*ellipsis/s);
  });
});

describe('T6e — 正文按可读宽封顶居中', () => {
  it('对话列与输入卡共用同一个定宽容器（旧壳是两处各写一份，会漂）', () => {
    const s = read('ui/StageChat.vue');
    expect(s).toMatch(/\.col\s*\{\s*width:\s*min\(var\(--w-stage\)/s);
    // 同一个 .col 同时裹正文与输入卡：两处各写一份宽度迟早对不齐
    expect(s.match(/class="col"/g) ?? []).toHaveLength(2);
  });
});
