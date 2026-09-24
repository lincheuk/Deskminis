/**
 * W2b-5 · 欢迎页 ModelBar 标明它管的是「默认模型」（止血设计稿 §4 W2b-5；侦察 renderer.md「W2b-modelbar」；cross.md S23）。
 *
 * 旧 ModelBar 的头注释写着「选中哪个，下一条消息就用它」——会话或助手绑定了模型时这是假话：
 * 点圆点改的是后端默认 provider（chat.setDefaultProvider），绑定过的会话照旧用绑定。
 * 条上也没有任何字样说明「这是默认」，用户在绑了助手的欢迎页上点它，以为换了这条消息的模型。
 *
 * 胶囊那一半（未绑定时显示「默认 · X」）的语义在纯模块，由 tests/models-binding.test.ts 的单测接住；
 * 这里是 .vue 源码守卫——.vue 不在 typecheck 覆盖内，断言认模板结构与绑定表达式，不认散文。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(__dirname, '..', 'src', 'renderer', 'src', 'ui');
const bar = readFileSync(join(UI, 'ModelBar.vue'), 'utf8').replace(/\r\n/g, '\n');
// 交接 §2 第 10 条：断言不能被注释喂饱。模板剥 HTML 注释、样式剥 CSS 注释、脚本剥 JS 注释后再匹配。
const tpl = bar.slice(bar.indexOf('<template>'), bar.indexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '');
const css = bar.slice(bar.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
const script = bar.slice(bar.indexOf('<script'), bar.indexOf('</script>'))
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('W2b-5 ModelBar 标明「默认模型」', () => {
  it('当前项胶囊里、模型名之前有「默认模型」小标签', () => {
    expect(tpl).toMatch(/<span class="cur">[\s\S]*?<span class="clabel">默认模型<\/span>\s*<span class="cname">/);
  });

  it('整条带说明：没有绑定的会话用它，绑定了以绑定为准', () => {
    const m = /<div v-if="items\.length" class="bar" title="([^"]*)">/.exec(tpl);
    expect(m, '.bar 缺静态 title').not.toBeNull();
    expect(m![1]).toContain('默认模型');
    expect(m![1]).toContain('以绑定为准');
  });

  it('圆点的悬停说明是「设为默认模型：名称 · 模型」——点它改的是默认，不是这条消息', () => {
    expect(tpl).toMatch(/v-for="p in items"[^>]*:title="`设为默认模型：\$\{p\.name\}\$\{p\.modelId \? ' · ' \+ p\.modelId : ''\}`"[^>]*@click="pick\(p\.id\)"/);
  });

  it('模型名兜底退回 provider 名称，不再重复「默认模型」四字（标签已经说了）', () => {
    expect(tpl).toMatch(/<span class="cname">\{\{ active\?\.modelId \|\| active\?\.name \}\}<\/span>/);
    expect(tpl).not.toMatch(/\|\|\s*'默认模型'\s*\}\}/);
  });

  it('标签是弱化的辅助字：--c-ink-3 + --t-aux-size', () => {
    const m = /\.clabel\s*\{([^}]*)\}/.exec(css);
    expect(m, '缺 .clabel 样式').not.toBeNull();
    expect(m![1]).toMatch(/color:\s*var\(--c-ink-3\)/);
    expect(m![1]).toMatch(/font-size:\s*var\(--t-aux-size\)/);
    // 标签不能被藏起来：藏了等于没说「这是默认」
    expect(m![1]).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it('头注释里的假话改掉了：不再说「下一条消息就用它」', () => {
    expect(bar).not.toContain('下一条消息就用它');
  });

  it('默认项的回落不动：后端默认失效时取列表第一个（与 store.refreshProviders、后端同一策略）', () => {
    expect(script).toMatch(/const activeId = computed\(\(\) => chat\.defaultProviderId \|\| items\.value\[0\]\?\.id \|\| ''\);/);
  });
});
