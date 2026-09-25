/** 跑一个 .vue 的 <script setup>，拿回它的顶层绑定（W2b-11a）；或按给定 props 真渲染一遍，看渲出来的字（renderSfc，见文件尾）。
 *
 *  为什么：仓库里没有挂载组件的设施（没有 DOM 库，vitest 没接 vue 插件），又不许加依赖；源码守卫只能证明「写了」，
 *  证明不了 setup 里的推导真的算对。做法同 renderer-send-session-switch.test.ts：vue/compiler-sfc 编译 <script setup>，
 *  typescript 转成 CommonJS，在调用方给的 effectScope 里执行 setup——开发态编译产物的 setup 会把全部顶层绑定返回出来。
 *
 *  与那边的两处不同：
 *  - import 不按手写表喂，按编译产物实际 require 的路径现解析：.vue 子组件给空壳（渲染为空），样式文件给空对象，
 *    'vue' 给真 vue（生命周期钩子另收，见下），其余的经 vitest 动态 import 真模块——与测试文件静态 import 的是同一份实例
 *    （store、被 vi.mock 的 rpc 都一样）。组件以后多 import 一个 lib，这里不用跟着改。
 *  - 生命周期钩子：没有组件实例时 onMounted / onBeforeUnmount / onUnmounted 注册不上（Vue 只打一句警告）。
 *    这里给编译产物的 vue 是覆盖了这三个钩子的副本，钩子先收起来，由调用方在「挂载」「卸载」时调：
 *    订阅从 setup 挪进 onMounted、退订写成 onBeforeUnmount 这类正常重构，行为测试照样跑得通。
 *    onScopeDispose 走真的 effectScope，unmount() 里 scope.stop() 时执行。 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import { renderToString } from 'vue/server-renderer';

// typescript 是 export = 形态，tsconfig 没开 esModuleInterop，用 require 取（同 renderer-send-session-switch）
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

export interface SetupRun<B> {
  /** setup 的返回值：全部顶层绑定（ref 仍是 ref，要 .value）。 */
  bindings: B;
  /** 执行收到的 onMounted 钩子（按注册顺序）。 */
  mount(): void;
  /** 执行 onBeforeUnmount 钩子 → 停掉 effectScope（onScopeDispose 在这一步跑）→ 执行 onUnmounted 钩子，与 Vue 卸载的先后一致。 */
  unmount(): void;
}

/** 编译产物 require 的相对路径解析成真文件：先按原样（带扩展名的），再补 .ts、/index.ts。只认文件，目录不算。 */
function resolveModule(fromDir: string, id: string): string {
  const base = resolve(fromDir, id);
  for (const p of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (statSync(p, { throwIfNoEntry: false })?.isFile()) return p;
  }
  throw new Error(`解析不到 ${id}（相对 ${fromDir}）`);
}

type Hooks = { mounted: (() => void)[]; beforeUnmount: (() => void)[]; unmounted: (() => void)[] };
type Compiled = { setup?: (p: object, c: object) => unknown };

/** 编译、现解析 import、求值，拿回组件对象。inlineTemplate 为假时 setup 返回全部顶层绑定（runSetup 用）；
 *  为真时模板一并编进 setup，setup 返回渲染函数（renderSfc 用），两条路共用同一套 import 解析。 */
async function loadSfc(file: string, inlineTemplate: boolean): Promise<{ component: Compiled; hooks: Hooks }> {
  const { descriptor, errors } = parse(readFileSync(file, 'utf8'), { filename: file });
  if (errors.length) throw errors[0];
  const { content } = compileScript(descriptor, { id: `setup-run-${file}`, inlineTemplate });
  const js = ts.transpileModule(content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const hooks: Hooks = { mounted: [], beforeUnmount: [], unmounted: [] };
  const fakeVue = {
    ...vue,
    onMounted: (fn: () => void) => { hooks.mounted.push(fn); },
    onBeforeUnmount: (fn: () => void) => { hooks.beforeUnmount.push(fn); },
    onUnmounted: (fn: () => void) => { hooks.unmounted.push(fn); },
  };
  const deps: Record<string, unknown> = {};
  for (const [, id] of js.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in deps) continue;
    if (id === 'vue') deps[id] = fakeVue;
    // 子组件的空壳带一个渲染为空的 render：renderSfc 只看本组件自己的模板，也免得 Vue 警告「缺模板」
    else if (id.endsWith('.vue')) deps[id] = { default: { name: id, render: () => null } };
    else if (id.endsWith('.css')) deps[id] = {};
    else if (id.startsWith('.')) deps[id] = await import(resolveModule(dirname(file), id));
    else deps[id] = await import(id);
  }
  const req = (id: string): unknown => {
    if (!(id in deps)) throw new Error(`${file} 运行时 require 了没有预先解析的 ${id}`);
    return deps[id];
  };
  const mod: { exports: { default?: Compiled } } = { exports: {} };
  new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
  const component = mod.exports.default;
  if (!component?.setup) throw new Error(`${file} 的编译产物里没有 setup`);
  return { component, hooks };
}

export async function runSetup<B>(
  file: string,
  props: Record<string, unknown>,
  scope: vue.EffectScope,
  ctx: { emit?: (event: string, ...args: unknown[]) => void } = {},
): Promise<SetupRun<B>> {
  const { component, hooks } = await loadSfc(file, false);
  const setup = component.setup as (p: object, c: object) => B;
  const bindings = scope.run(() => setup(props, { expose: () => {}, emit: ctx.emit ?? (() => {}), attrs: {}, slots: {} }));
  if (!bindings) throw new Error(`${file} 的 setup 没有返回绑定`);
  return {
    bindings,
    mount: () => { for (const fn of hooks.mounted) fn(); },
    unmount: () => {
      for (const fn of hooks.beforeUnmount) fn();
      scope.stop();
      for (const fn of hooks.unmounted) fn();
    },
  };
}

/** 按给定 props 把 .vue 真渲染一遍（组件自己的初始状态，比如折叠组默认收起），拿回 HTML（W2b-11a 审查后加）。
 *
 *  为什么：模板上的正则只证明「写了」，不看写在哪、那个状态下看不看得见——审查实测，把组头的「N 步已中断」
 *  挪进 v-if="open" 的展开区，整段模板上的正则照样绿，可折叠组默认收起，用户那一刻就看不见了。
 *  用的是 vue 包自带的 server-renderer 出口（vue/server-renderer，不是新依赖）：模板编成普通渲染函数，
 *  server-renderer 照样能把它渲成字符串。子组件是空壳，渲染为空；看字用下面的 visibleText。 */
export async function renderSfc(file: string, props: Record<string, unknown>): Promise<string> {
  const { component } = await loadSfc(file, true);
  return renderToString(vue.createSSRApp(component as vue.Component, props));
}

/** renderSfc 渲出来的 HTML 里，用户看得见的那些字。
 *  去注释（Vue 的片段锚点 <!--[--> 之类也是注释）；display:none 的元素（v-show 为假时 SSR 就这么写）与带 hidden 属性的元素
 *  连同子孙一起去掉；再去标签（标签边界记一个空白，块与块的字不粘连）、还原 Vue 转义过的五个实体、压空白。
 *  只对付 Vue SSR 吐出的规整 HTML，不是通用解析器；靠 class 配样式表藏起来的，这里看不出。 */
export function visibleText(html: string): string {
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  const opened: boolean[] = []; // 每个还没闭合的元素：它自己是不是隐藏的
  let hiddenDepth = 0;          // 当前处在几层隐藏元素里
  let out = '';
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of noComments.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+/g)) {
    if (m[2] === undefined) { if (!hiddenDepth) out += m[0]; continue; }
    out += ' ';
    if (m[1]) { if (opened.pop()) hiddenDepth--; continue; }
    if (VOID.test(m[2]) || m[3].trimEnd().endsWith('/')) continue;
    const hides = /\sstyle="[^"]*display:\s*none/i.test(m[3]) || /\shidden(?=[\s=]|$)/i.test(m[3]);
    opened.push(hides);
    if (hides) hiddenDepth++;
  }
  return out
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
