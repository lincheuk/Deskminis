/** 源码守卫共用：去掉 /* *\/ 块注释与 // 行注释后再做正向、位置断言。
 *
 *  为什么：守卫要认真实的调用形态。读原文的话，代码回退后只要注释里还留着旧调用的原文，
 *  正向匹配、位置搜索都照样命中，测试不红（handoff §2.10、§7.6；W1a-9 审查用 5 种「注释喂饱」变异实测过）。
 *
 *  这是按正则去注释，不认字符串，有两点要知道：
 *  - `://` 前面是冒号，不当行注释，URL 字符串原样保留；
 *  - 其余字符串或正则字面量里出现 // 或 /* 会被误删。目前扫的 src/main/index.ts、src/main/app-dirs.ts、
 *    src/minisd/index.ts、src/minisd/store/provider-store.ts 都没有这种写法（W1a-9 用 TypeScript 语法树去注释对照过，
 *    结果去掉空白后逐字相同）；W1b-2 起 src/renderer/src/stores/chat.ts 与 ui/PermCard.vue 的 <script> 段也用它，
 *    W1b-3 起 src/minisd/store/data-root-lock.ts 也用它，同样对照过。以后扫的文件出现这种写法时，要换成认字符串的去法。 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
