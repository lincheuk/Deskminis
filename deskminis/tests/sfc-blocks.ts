/** .vue 源码守卫共用：用 Vue 自己的 SFC 解析器切出脚本、模板、样式三段，各段剥掉本段语言的注释后再断言。
 *
 *  为什么不在原文上用 indexOf('<script') / lastIndexOf('</template>') 切：块的边界本身就能被注释挪动。
 *  脚本里一行 // 注释写着 <template>，模板段的起点就落进脚本段；样式的 /* *\/ 里写着 </template>，模板段的终点就落进样式段；
 *  文件顶部一条 <!-- --> 里写着 <script，脚本段就从这条注释开始。注释里的旧代码于是进了切片，
 *  而切片上只剥本段语言的注释，剥不到它，守卫又被注释喂饱了（W2b-4b 第二次审查在沙箱对 Composer.vue 实测 5 个变异，全绿）。
 *  解析器按 SFC 的规则认块：script、style 的内容是原文，顶层注释不属于任何块，注释挪不动边界。
 *
 *  各段剥什么：脚本（<script> 与 <script setup> 按出现顺序拼接）剥 /* *\/ 与 // 行（stripComments，局限见那边的说明）；
 *  模板剥 <!-- -->；样式剥 /* *\/。
 *  解析出错就抛：块都切不对，断言的结果没有意义。样式只认纯 CSS、模板只认 HTML：scss 的 // 注释、pug 之类这里剥不到，
 *  真遇到时先把这里扩了，而不是让守卫静默地被喂饱。
 *  单放一个文件、不并进 strip-comments.ts：那边也给主进程的守卫用，不必让它们连带加载 Vue 编译器。 */
import { parse } from 'vue/compiler-sfc';
import { stripComments } from './strip-comments';

export interface SfcBlocks { script: string; template: string; style: string }

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
  return {
    script: stripComments(scripts.map((b) => b.content).join('\n')),
    template: (d.template?.content ?? '').replace(/<!--[\s\S]*?-->/g, ''),
    style: d.styles.map((s) => s.content).join('\n').replace(/\/\*[\s\S]*?\*\//g, ''),
  };
}
