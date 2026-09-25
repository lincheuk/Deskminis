/** .vue 源码守卫共用：用 Vue 自己的 SFC 解析器切出脚本、模板、样式三段，各段剥掉本段语言的注释后再断言。
 *
 *  为什么不在原文上用 indexOf('<script') / lastIndexOf('</template>') 切：块的边界本身就能被注释挪动。
 *  脚本里一行 // 注释写着 <template>，模板段的起点就落进脚本段；样式的 /* *\/ 里写着 </template>，模板段的终点就落进样式段；
 *  文件顶部一条 <!-- --> 里写着 <script，脚本段就从这条注释开始。注释里的旧代码于是进了切片，
 *  而切片上只剥本段语言的注释，剥不到它，守卫又被注释喂饱了（W2b-4b 第二次审查在沙箱对 Composer.vue 实测 5 个变异，全绿）。
 *  解析器按 SFC 的规则认块：script、style 的内容是原文，顶层注释不属于任何块，注释挪不动边界。
 *
 *  各段怎么剥：
 *  - 脚本（<script> 与 <script setup> 按出现顺序拼接）：交给 compileScript 用的同一个解析器 babelParse，
 *    按它给出的注释区间删。不用正则（strip-comments.ts）：正则不认字符串，也放过冒号后面的 //——
 *    `const t:// <旧代码>` 这样的真注释留在了代码里，字符串里的 '/*' 又会开出一段假的块注释、把后面真注释里的
 *    旧代码当成代码露出来（W2b-4b 第三次审查三个变异全绿，换成语法树的注释区间后全红）。
 *  - 模板：按模板 AST 里的注释节点区间删，不用 /<!--[\s\S]*?-->/。两者对 `<!-->` 这类提前结束的注释认法不同：
 *    解析器认为注释到此为止、后面是正文，正则却一路删到下一个 -->，把真正的正文也删了。
 *  - 样式：剥 /* *\/（CSS 只有这一种注释）。
 *  解析出错就抛：块都切不对，断言的结果没有意义。样式只认纯 CSS、模板只认 HTML、脚本只认 ts/js：
 *  scss 的 // 注释、pug、tsx 这里剥不到，真遇到时先把这里扩了，而不是让守卫静默地被喂饱。
 *  剩下的局限：源码守卫认不出死代码与字符串里的「正确写法」（`if (false) { … }`、`<template v-if="false">`、
 *  一段写着正确调用的字符串），这类只能靠各守卫自己数「恰好一处」来收窄。 */
import { parse, babelParse } from 'vue/compiler-sfc';

export interface SfcBlocks { script: string; template: string; style: string }

/** 按 [start, end) 区间从后往前删，前面的偏移不受影响。 */
function cut(text: string, ranges: Array<[number, number]>): string {
  let out = text;
  for (const [s, e] of [...ranges].sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + out.slice(e);
  return out;
}

function stripScript(content: string, file: string): string {
  let ast: ReturnType<typeof babelParse>;
  try {
    ast = babelParse(content, { sourceType: 'module', plugins: ['typescript'] });
  } catch (e) {
    throw new Error(`${file} 的脚本解析出错：${(e as Error).message}`);
  }
  return cut(content, (ast.comments ?? []).map((c) => [c.start ?? 0, c.end ?? 0] as [number, number]));
}

interface TplNode { type: number; loc: { start: { offset: number }; end: { offset: number } }; children?: TplNode[] }
const COMMENT = 3; // @vue/compiler-core 的 NodeTypes.COMMENT

export function sfcBlocks(src: string, file = 'component.vue'): SfcBlocks {
  const { descriptor: d, errors } = parse(src, { filename: file });
  if (errors.length) throw new Error(`${file} 解析出错：${errors.map((e) => e.message).join('；')}`);
  if (d.template?.lang && d.template.lang !== 'html') throw new Error(`${file} 的模板是 ${d.template.lang}，这里只会剥 HTML 注释`);
  for (const s of d.styles) {
    if (s.lang && s.lang !== 'css') throw new Error(`${file} 的样式是 ${s.lang}，这里只会剥 CSS 的块注释`);
  }
  const scripts = [d.script, d.scriptSetup]
    .filter((b): b is NonNullable<typeof b> => !!b)
    .sort((a, b) => a.loc.start.offset - b.loc.start.offset);
  for (const b of scripts) {
    if (b.lang && b.lang !== 'ts' && b.lang !== 'js') throw new Error(`${file} 的脚本是 ${b.lang}，这里只会按 ts/js 剥注释`);
  }

  let template = '';
  if (d.template) {
    const base = d.template.loc.start.offset;
    const ranges: Array<[number, number]> = [];
    const walk = (n: TplNode): void => {
      if (n.type === COMMENT) ranges.push([n.loc.start.offset - base, n.loc.end.offset - base]);
      n.children?.forEach(walk);
    };
    if (d.template.ast) walk(d.template.ast as unknown as TplNode);
    template = cut(d.template.content, ranges);
  }

  return {
    script: scripts.map((b) => stripScript(b.content, file)).join('\n'),
    template,
    style: d.styles.map((s) => s.content).join('\n').replace(/\/\*[\s\S]*?\*\//g, ''),
  };
}
