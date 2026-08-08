/**
 * M4.6 Task 6 · Icon.vue v-html 白名单守卫测试
 *
 * 决策点 4 结论：维持 v-html 豁免（PATHS 是编译期静态 const 字典，无用户输入数据流可达）。
 * 本测试把「零用户输入 / 无执行内容」从口头约束固化为测试红线，防止未来误引入动态绑定或可执行内容。
 * 读 .vue 源码文本做守卫断言（不启动浏览器），与 renderer-* 先例一致。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(__dirname, '../src/renderer/src/components/Icon.vue'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('M4.6 Task 6 — Icon.vue v-html 白名单守卫', () => {
  it('v-html 绑定表达式必须是静态 inner（非用户输入可达）', () => {
    // 只允许 `v-html="inner"` 这种静态字典查找绑定；拒绝任何直接绑定 props/动态表达式
    expect(src).toContain('v-html="inner"');
    // inner 只来自静态字典键查找 PATHS[name] ?? PATHS.info，无其他赋值路径
    expect(src).toContain('PATHS[props.name] ?? PATHS.info');
  });

  it('PATHS 字典值不含可执行 HTML 标签/事件模式（XSS 红线）', () => {
    // 提取 const PATHS = { ... } 块
    const start = src.indexOf('const PATHS');
    const end = src.indexOf('};', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);

    // 禁用的可执行/事件模式
    const forbidden = [
      /onclick\s*=/i,
      /onerror\s*=/i,
      /onload\s*=/i,
      /on\w+\s*=/i,
      /<script/i,
      /<\/script>/i,
      /javascript:/i,
      /<img/i,
      /<iframe/i,
      /<style/i,
      /<link/i,
      /<a[\s>]/i,
      /<svg[\s>]/i,
    ];
    for (const re of forbidden) {
      expect(block.match(re)).toBeNull();
    }
  });

  it('PATHS 字典值只含白名单 SVG 元素（path/rect/circle/ellipse）', () => {
    const start = src.indexOf('= {', src.indexOf('const PATHS')) + 3;
    const end = src.indexOf('};', start);
    const block = src.slice(start, end);
    const tags = [...block.matchAll(/<(\/)?([a-zA-Z]+)/g)].map(m => m[2].toLowerCase());
    const whitelist = new Set(['rect', 'path', 'circle', 'ellipse']);
    for (const t of tags) {
      expect(whitelist.has(t)).toBe(true);
    }
    // 至少含非 path 元素（决策点 4 的关键——若全为 path，消除成本论述才改变）
    expect(block).toContain('<rect');
    expect(block).toContain('<circle');
    expect(block).toContain('<ellipse');
  });
});