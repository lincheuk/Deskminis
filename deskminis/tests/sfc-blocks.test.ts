/**
 * W2b-4b 第二次审查补 · 源码守卫切 .vue 的块，边界不能被注释挪动（交接 §2 第 10 条：断言认调用形态，注释喂不饱）。
 *
 * 此前的守卫在原文上找块边界：脚本段从第一个 `<script` 切到第一个 `</script>`，模板段从第一个 `<template`
 * 切到最后一个 `</template>`，样式段从第一个 `<style` 起。注释里只要写着这些标签，边界就落进注释，
 * 注释里的旧代码跟着进了切片，而切片上只剥本段语言的注释，剥不到它。W2b-4b 第二次审查在沙箱里对 Composer.vue
 * 做了 5 个这样的变异，胶囊不显示生效的模型、send 永不套用助手，18 个文件 226 例照样全绿。
 * 下面每例是其中一种形状的最小复现：注释里放「对的」代码，真代码是错的，切出来的段里必须看不到注释里那份。
 */
import { describe, it, expect } from 'vitest';
import { sfcBlocks } from './sfc-blocks';

const CAP_OK = '<span class="cap" :title="modelView.title">{{ modelView.label }}</span>';
const CAP_BAD = '<span class="cap">{{ permLabel }}</span>';

describe('sfcBlocks：按 SFC 解析器切块，再各剥本段的注释', () => {
  it('三段各归各位：脚本剥 /* */ 与 //，模板剥 <!-- -->，样式剥 /* */', () => {
    const b = sfcBlocks([
      '<script setup lang="ts">',
      '// 行注释里的 oldCall()',
      '/* 块注释里的 oldCall() */',
      'const a = realCall();',
      '</script>',
      '',
      '<template>',
      '  <!-- <b>{{ oldLabel }}</b> -->',
      '  <i>{{ a }}</i>',
      '</template>',
      '',
      '<style scoped>',
      '/* .old { color: red } */',
      '.new { color: blue }',
      '</style>',
    ].join('\n'));
    expect(b.script).toContain('const a = realCall();');
    expect(b.script).not.toContain('oldCall');
    expect(b.template).toContain('<i>{{ a }}</i>');
    expect(b.template).not.toContain('oldLabel');
    expect(b.template).not.toContain('realCall');
    expect(b.style).toContain('.new { color: blue }');
    expect(b.style).not.toContain('.old');
  });

  it('脚本里一行 // 注释写着 <template>：模板段不从这条注释开始（审查变异 script-comment-shifts-template-slice）', () => {
    const b = sfcBlocks([
      '<script setup lang="ts">',
      `// 胶囊原来在 <template> 里写作 ${CAP_OK}`,
      "const permLabel = '只读';",
      '</script>',
      '',
      '<template>',
      `  ${CAP_BAD}`,
      '</template>',
    ].join('\n'));
    expect(b.template).toContain('{{ permLabel }}');
    expect(b.template).not.toContain('{{ modelView.label }}');
    expect(b.template).not.toContain('const permLabel');
  });

  it('样式里 /* */ 注释写着 </template>：模板段不延伸进样式（审查变异 style-comment-extends-template-slice）', () => {
    const b = sfcBlocks([
      '<template>',
      `  ${CAP_BAD}`,
      '</template>',
      '',
      '<style scoped>',
      `/* 旧胶囊 ${CAP_OK} 已挪出 </template> */`,
      '.cap { color: red }',
      '</style>',
    ].join('\n'));
    expect(b.template).toContain('{{ permLabel }}');
    expect(b.template).not.toContain('{{ modelView.label }}');
    expect(b.template).not.toContain('.cap {');
  });

  it('脚本里一行 // 注释写着 <style>：样式段不从这条注释开始（审查变异 script-comment-shifts-style-slice）', () => {
    const b = sfcBlocks([
      '<script setup lang="ts">',
      '// 见 <style> 里的 .cap.bad { color: var(--c-warn) }',
      'const a = 1;',
      '</script>',
      '',
      '<template><i /></template>',
      '',
      '<style scoped>',
      '.cap.gone { color: var(--c-warn) }',
      '</style>',
    ].join('\n'));
    expect(b.style).toContain('.cap.gone');
    expect(b.style).not.toMatch(/\.cap\.bad\s*\{/);
  });

  it('文件顶部一条 <!-- --> 里写着 <script 与代码：脚本段只取真正的脚本块（审查变异 toplevel-html-comment-feeds-*）', () => {
    const b = sfcBlocks([
      '<!-- 旧 <script> 里：const eff = computed(() => previewBinding(applyStateOf(chat), chat.assistants)); -->',
      '<script setup lang="ts">',
      "const eff = computed(() => '');",
      '</script>',
      '',
      '<template><i /></template>',
    ].join('\n'));
    expect(b.script).toContain("const eff = computed(() => '');");
    expect(b.script).not.toContain('previewBinding');
  });

  it('<script> 与 <script setup> 都算脚本，按出现顺序拼接', () => {
    const b = sfcBlocks([
      '<script lang="ts">',
      'export const first = 1;',
      '</script>',
      '<script setup lang="ts">',
      'const second = 2;',
      '</script>',
      '<template><i /></template>',
    ].join('\n'));
    expect(b.script).toMatch(/export const first = 1;[\s\S]*const second = 2;/);
  });

  it('块都切不对时直接抛：解析出错、样式不是纯 CSS（它的 // 注释这里剥不到）', () => {
    expect(() => sfcBlocks('<template><a /></template>\n<template><b /></template>\n')).toThrow(/解析出错/);
    expect(() => sfcBlocks('<template><i /></template>\n<style lang="scss">\n// .x {}\n</style>\n')).toThrow(/scss/);
  });

  it('没有的块给空串', () => {
    expect(sfcBlocks('<template><i /></template>\n')).toEqual({ script: '', template: '<i />', style: '' });
  });
});
