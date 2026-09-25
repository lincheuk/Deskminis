/**
 * W2a-6 · 溢出与压缩失败的界面（止血设计稿 §3 第 2–5 条、§4 W2a-6；侦察 renderer.md「W2a-overflow-ui」与
 * engine.md「W2a-overflow」的渲染条目；cross.md S21 及 corrections 里统一后的契约）。
 *
 * 引擎侧（W2a-2、W2a-3）已经按 code 发事件，渲染端还是一套旧处理：
 *   ① 所有 error 一律 retryable:true——「上下文已满」原地重试必然再满，绑定错误重试必然再 400，重试钮是空头支票；
 *   ② 错误短句对整条报文跑状态码正则：绑定错误的 message 后半是原始 400 响应体，里面一个独立的 5xx 三位数
 *      就被说成「模型服务暂时不可用」；「上下文已满（已用 512 / 200000）」同样被认成 512；
 *   ③ 因超窗降级到更大窗口时，短句仍是笼统的「已切换到备选模型」，不说为什么、改用了谁；
 *   ④ 引擎给了接力草稿（relayDraft），界面没有任何入口能用上它。
 *
 * 本文件钉（两份侦察守卫 renderer-context-full / renderer-overflow-relay 合并于此）：
 *   - copy.ts 先按事件 code 选短句；未带 code 的溢出文案在 5xx 正则之前认出来；
 *   - store：contextFull 不给重试、给接力（relay:true），草稿留在 relaySource，不放进可被输入卡消费的 relayDraft；
 *     thinkingBinding 不给重试；普通错误照旧可重试；fallback 带 cause 时短句写明「因上下文已满改用 X」；
 *   - relayToNewSession：继承助手（还在的话）、模型绑定与工作区语义（原会话设过目录就照抄；原会话是默认沙箱、或目录已不在，
 *     新会话回到自己的沙箱，不落在别的会话选的 lastUsed）；relayDraft = {sessionId: 新会话, text} 在 open() 之前写好；
 *     建出会话后的继承步骤尽力而为，失败照样落到新会话并说明；建会话本身失败如实报错、可再点；
 *     会话已建出而切过去失败时，再点只切过去、不再新建；并发连点只建一个会话；
 *   - 源码守卫：EventNotes 的接力钮接线、Composer 只在 setup 里按 sessionId === activeId 消费（不用 watch、不自动发送；
 *     按引用次数钉，不认某一种 watch 写法）；渲染端组件里只有 Composer 碰 relayDraft / relaySource。
 *   - W2a-6b 补强（起于 W2a-6 第三轮审查 R1–R4，本步又经两轮审查）：输入卡与 store 这两侧改用 TypeScript 语法树判，
 *     不再数括号、认缩进或按行剥注释——
 *     · Composer 的 <script setup>：takeRelay 恰好两处，一处是顶层声明，一处是父节点就是整个脚本的 `takeRelay();` 语句；
 *       takeRelay 体内的调用、实参、赋值目标、用到的名字都按白名单钉，体内用到的体外名字在 setup 顶层各声明一次、
 *       就是预期的那个；relayDraft 在脚本里只有体内取、清两处；<script setup> 之外的原文（模板、样式、别的块）不许提草稿。
 *     · store：relayDraft、relaySource 各自只许落在 state 声明与指定的几个 action 里。
 *     · 跨文件：src/renderer 整个目录与它经 @shared 引用的 src/shared 下所有代码文件里，只有上面两份提到草稿；
 *       渲染端从这两个目录之外只许类型引用（值引用出去的话，取草稿的帮手就能放在扫描范围外）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import * as ts from 'typescript';
import { parse as parseSfc } from 'vue/compiler-sfc';
import { stripComments } from './strip-comments';

// ── 桩掉 renderer 的 rpc：call 走可控实现并记账，on 把处理器收进 handlers，测试里直接派发广播 ──
const { rpcCallMock, handlers, calls } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
  handlers: new Map<string, (p: any) => void>(),
  calls: [] as { method: string; params: any; relayDraft?: unknown }[],
}));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: rpcCallMock,
    connect: async () => {},
    on: (method: string, h: (p: any) => void) => { handlers.set(method, h); },
    // W2b-3：init() 在 connect 之前订阅断线；本文件不测断线，给个空订阅
    onLost: vi.fn(),
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import * as copy from '../src/renderer/src/lib/eventnote/copy';

const SRC = join(__dirname, '../src/renderer/src/');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

/** .vue 拆三段并各自剥注释：模板剥 <!-- -->，脚本剥 /* *\/ 与 // 行（交接 §2 第 10 条：断言不能被注释喂饱）。 */
function sfc(p: string): { script: string; tpl: string; css: string } {
  const src = read(p);
  const script = stripComments(src.slice(src.indexOf('<script'), src.indexOf('</script>')));
  const tpl = src.slice(src.indexOf('<template>'), src.lastIndexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '');
  const css = src.includes('<style') ? src.slice(src.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '') : '';
  return { script, tpl, css };
}

/** 字面量（字符串、模板串的静态段、正则）的内容换成等长空格，定界符与换行留着，下标与原文一一对应。
 *  bodyFrom 在这份上配花括号，字面量里的花括号不算数：函数体里一个 '}' 能把体提前截断，一个 '{' 能把体拖进后面的方法。
 *  哪些是字面量交给 TypeScript 自己的解析器认（devDependencies 里本来就有）：正则字面量与除号、模板串 ${} 里再套模板串，
 *  靠正则猜认不准。 */
function blankLiterals(src: string): string {
  // <script setup lang="ts"> 这行不是 TS，等长换成空格再解析
  const code = src.replace(/^<script\b[^>]*>/, m => ' '.repeat(m.length));
  const sf = ts.createSourceFile('guard.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = code.split('');
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isRegularExpressionLiteral(n)
      || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      // 首尾各留一个字符：引号、反引号、正则开头的 /；模板串的静态段留下 ${ 的 { 与收尾的 }——它们在 ${…} 两端成对
      for (let k = n.getStart(sf) + 1; k < n.end - 1; k++) if (out[k] !== '\n') out[k] = ' ';
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.join('');
}

/** 从 head 之后参数表收尾的 `) {` / `): T {` 起按花括号配对取出函数体（返回原文，不是抹掉字面量的那份）
 *  （参数类型里的 `{ … }` 不算函数体；源码已剥注释；配对在 blankLiterals 之后做，字符串里的花括号不算）。 */
function bodyFrom(src: string, head: string): string {
  const i = src.indexOf(head);
  expect(i, `找不到 ${head}`).toBeGreaterThan(-1);
  const code = blankLiterals(src);
  const m = /\)\s*(?::\s*[^{;]+)?\{/g;
  m.lastIndex = i;
  const hit = head.endsWith('{') ? null : m.exec(code);
  const open = head.endsWith('{') ? i + head.length - 1 : hit!.index + hit![0].length - 1;
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}') { depth--; if (depth === 0) return src.slice(open + 1, k); }
  }
  throw new Error(`${head} 的花括号没有配平`);
}

// ── 语法树工具（W2a-6b）：输入卡取草稿、store 里草稿落在哪、跨文件扫描这几条守卫在语法树上判，不数括号、不认缩进、不按行剥注释 ──
// 为什么不再数括号：表达式体箭头函数 `() => takeRelay()` 没有括号包住调用，挪进 watch 回调照样数成 0 层
// （W2a-6b 第二轮审查 A1–A3）。为什么不按行剥注释：stripComments 按行认 //，字符串里的 'a//' 会把同行后面的真代码
// 一起剥掉（同轮 E2）。语法树本来就不看注释，也分得清代码与字面量。
const ROOT = join(__dirname, '..');
const readRoot = (p: string): string => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const tsOf = (name: string, code: string): ts.SourceFile => ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** 先序走遍 n 与它的全部子节点。ts.forEachChild 不进 JSDoc：注释里写到的名字不算。 */
function walk(n: ts.Node, f: (n: ts.Node) => void): void {
  f(n);
  ts.forEachChild(n, c => walk(c, f));
}

/** root 底下提到 name 的节点：标识符按 \bname\b 认（转义写法 relay\u0044raft 解析后 .text 相同，一样认得出；
 *  与改动前在文本上按 \b 数的口径一致，$takeRelay 这种只多一个 $ 的名字也算），以及内容里含 name 的字面量——
 *  字符串、模板串各段、正则。下标写法 chat['relayDraft'] 靠后者认出来；字面量里只是写到这个名字、并没用它，
 *  也照样算，宁严勿漏。运行时拼出来的名字（'relay' + 'Draft'）认不出。 */
function mentions(root: ts.Node, name: string): ts.Node[] {
  const word = new RegExp(`\\b${name}\\b`);
  const out: ts.Node[] = [];
  walk(root, n => {
    const lit = ts.isStringLiteralLike(n) || ts.isRegularExpressionLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
    if (ts.isIdentifier(n) ? word.test(n.text) : lit && (n as ts.LiteralLikeNode).text.includes(name)) out.push(n);
  });
  return out;
}

/** 报错信息用：节点所在的行号与那一行原文。 */
function at(n: ts.Node): string {
  const sf = n.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
  return `L${line + 1} ${sf.text.split('\n')[line].trim()}`;
}

/** n 所在的那条语句（往上找到父节点是语句块、case 分支或整个文件的那一层）。 */
function stmtOf(n: ts.Node): ts.Node {
  let p = n;
  while (p.parent && !ts.isBlock(p.parent) && !ts.isSourceFile(p.parent) && !ts.isCaseOrDefaultClause(p.parent)) p = p.parent;
  return p;
}

/** .vue 用 Vue 自己的 SFC 解析器切块（注释挪不动块边界，见 sfc-blocks.ts 的说明）。 */
function sfcOf(p: string, raw: string): ReturnType<typeof parseSfc>['descriptor'] {
  const { descriptor, errors } = parseSfc(raw, { filename: p });
  if (errors.length) throw new Error(`${p} 解析出错：${errors.map(e => e.message).join('；')}`);
  return descriptor;
}

/** Composer.vue 的 <script setup>：原文交给 TypeScript 解析（不先剥注释，理由见上）；
 *  outside 是这个块之外的整份原文（模板、样式、别的脚本块），不剥注释——那里只做「不许出现」的检查，剥注释只会藏东西。 */
function composerSetup(): { sf: ts.SourceFile; tpl: string; outside: string } {
  const raw = read('ui/Composer.vue');
  const d = sfcOf('ui/Composer.vue', raw);
  const b = d.scriptSetup;
  if (!b) throw new Error('Composer.vue 没有 <script setup>');
  return {
    sf: tsOf('Composer.setup.ts', b.content),
    tpl: d.template?.content ?? '',
    outside: raw.slice(0, b.loc.start.offset) + raw.slice(b.loc.end.offset),
  };
}

/** 顶层函数声明 name（取不到就抛：守卫要看的东西都不在了）。 */
function topFn(sf: ts.SourceFile, name: string): ts.FunctionDeclaration & { body: ts.Block } {
  const fn = sf.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (fn.length !== 1 || !fn[0].body) throw new Error(`顶层函数 ${name} 应恰好声明一次（带函数体），实际 ${fn.length} 处`);
  return fn[0] as ts.FunctionDeclaration & { body: ts.Block };
}

/** 脚本顶层对 name 的全部声明，各写成一行便于逐字比对：import 记「{ 原文 } from 模块」，变量记「const 原文」，
 *  函数、类、枚举记种类与名字。改名引入（import { nextTick as tick }）的本地名是 tick，不算 nextTick 的声明。 */
function topDecls(sf: ts.SourceFile, name: string): string[] {
  const out: string[] = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause;
      const from = (s.moduleSpecifier as ts.StringLiteral).text;
      if (c?.name?.text === name) out.push(`default from ${from}`);
      const nb = c?.namedBindings;
      if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) out.push(`* from ${from}`);
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (e.name.text === name) out.push(`{ ${e.getText(sf)} } from ${from}`);
    } else if (ts.isVariableStatement(s)) {
      const kw = s.declarationList.flags & ts.NodeFlags.Const ? 'const' : s.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
      for (const d of s.declarationList.declarations) {
        walk(d.name, n => {
          if (ts.isIdentifier(n) && n.text === name && (n.parent === d || (ts.isBindingElement(n.parent) && n.parent.name === n))) out.push(`${kw} ${d.getText(sf)}`);
        });
      }
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) && s.name?.text === name) {
      out.push(`${ts.SyntaxKind[s.kind]} ${name}`);
    }
  }
  return out;
}

/** root 底下声明出来的全部名字（变量、参数、解构、函数、类，含 catch 变量）。 */
function declsIn(root: ts.Node): string[] {
  const out: string[] = [];
  walk(root, n => {
    const named = ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n)
      || ts.isFunctionExpression(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n);
    if (!named || !n.name) return;
    walk(n.name, m => { if (ts.isIdentifier(m) && (m.parent === n || (ts.isBindingElement(m.parent) && m.parent.name === m))) out.push(m.text); });
  });
  return out;
}

/** stores/chat.ts 里名字各落在哪：state 里声明它的那个属性记 'state'；actions 对象的直接成员（方法、属性、存取器）
 *  记成员名；别处记 '?'（getters、文件顶层的帮手、state 里别的属性的初值……）。只认 actions 的直接成员：
 *  某个 action 里再套一个对象、上面挂一个叫 onEvent 的方法，算在外层那个 action 头上，冒充不了真的 onEvent。 */
function storeSites(sf: ts.SourceFile, name: string): { site: string; node: ts.Node }[] {
  const defs: ts.CallExpression[] = [];
  walk(sf, n => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'defineStore') defs.push(n); });
  if (defs.length !== 1) throw new Error(`stores/chat.ts 里 defineStore 应恰好一处，实际 ${defs.length}`);
  const opts = defs[0].arguments[1];
  if (!opts || !ts.isObjectLiteralExpression(opts)) throw new Error('defineStore 的第二个参数不是对象字面量');
  const member = (k: string): ts.ObjectLiteralElementLike | undefined => opts.properties.find(p => p.name?.getText(sf) === k);
  const st = member('state');
  const ac = member('actions');
  const stateFn = st && ts.isPropertyAssignment(st) ? st.initializer : undefined;
  const stateBody = stateFn && ts.isArrowFunction(stateFn) && ts.isParenthesizedExpression(stateFn.body) ? stateFn.body.expression : undefined;
  const actions = ac && ts.isPropertyAssignment(ac) ? ac.initializer : undefined;
  if (!stateBody || !ts.isObjectLiteralExpression(stateBody)) throw new Error('state 不是 () => ({ … }) 的形态');
  if (!actions || !ts.isObjectLiteralExpression(actions)) throw new Error('actions 不是对象字面量');
  return mentions(sf, name).map(node => {
    if (ts.isPropertyAssignment(node.parent) && node.parent.name === node && node.parent.parent === stateBody) return { site: 'state', node };
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (p.parent === actions) return { site: (p as ts.ObjectLiteralElementLike).name?.getText(sf) ?? '?', node };
    }
    return { site: '?', node };
  });
}

/** 一个代码文件里交给 TypeScript 解析的脚本，以及外置脚本的 src：.vue 按 SFC 块切，.html 按 <script> 标签切，其余整份。 */
function scriptsOf(f: string, raw: string): { sfs: ts.SourceFile[]; srcs: string[] } {
  if (f.endsWith('.vue')) {
    const d = sfcOf(f, raw);
    const blocks = [d.script, d.scriptSetup].filter((b): b is NonNullable<typeof b> => !!b);
    return { sfs: blocks.map(b => tsOf(f, b.content)), srcs: blocks.flatMap(b => (b.src ? [b.src] : [])) };
  }
  if (f.endsWith('.html')) {
    const tags = [...raw.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    return {
      sfs: tags.map(m => tsOf(f, m[2])),
      srcs: tags.flatMap(m => { const s = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]); return s ? [s[1]] : []; }),
    };
  }
  return { sfs: [tsOf(f, raw)], srcs: [] };
}

/** 脚本里的模块引用：静态 import / export … from / import x = require()、动态 import()、import.meta.glob()。
 *  import type / export type 编译后不留下任何代码，记 typeOnly。动态 import 与 glob 的路径不是字面量时记「<非字面量>」。 */
function importsOf(sf: ts.SourceFile): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  walk(sf, n => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) out.push({ spec: n.moduleSpecifier.text, typeOnly: !!n.importClause?.isTypeOnly });
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push({ spec: n.moduleSpecifier.text, typeOnly: n.isTypeOnly });
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      out.push({ spec: n.moduleReference.expression.text, typeOnly: n.isTypeOnly });
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || n.expression.getText(sf) === 'import.meta.glob')) {
      const a0 = n.arguments[0];
      const args = a0 && ts.isArrayLiteralExpression(a0) ? [...a0.elements] : a0 ? [a0] : [];
      for (const a of args) out.push({ spec: ts.isStringLiteralLike(a) ? a.text : '<非字面量>', typeOnly: false });
    }
  });
  return out;
}

/** 渲染端的一个模块引用会不会落到 dirs 之外。包名（vue、pinia……）不归这里管；@shared 按 electron.vite.config.ts 的别名；
 *  / 开头按渲染端的 Vite 根（src/renderer）；/@fs/ 之类 Vite 特殊前缀与非字面量路径看不出落在哪，一律当落在外面。 */
function landsOutside(f: string, spec: string, dirs: string[]): boolean {
  const path = spec.split('?')[0];
  let abs: string;
  if (path === '<非字面量>' || path.startsWith('/@')) return true;
  if (path === '@shared' || path.startsWith('@shared/')) abs = join(ROOT, 'src/shared', path.slice('@shared'.length));
  else if (path.startsWith('.')) abs = join(dirname(join(ROOT, f)), path);
  else if (path.startsWith('/')) abs = join(ROOT, 'src/renderer', path);
  else return false;
  return !dirs.some(d => { const r = relative(join(ROOT, d), abs); return !r.startsWith('..') && !isAbsolute(r); });
}

// ─────────── 桩：两个会话 A / B，A 带助手、组绑定与自定义工作区；桩的后端语义对齐 minisd/index.ts（见 Stub 各项注释） ───────────
type Stub = {
  createFails?: string; createBinding?: string; createDelayMs?: number;
  sourceA?: Record<string, unknown>; wsA?: { root: string; isDefault: boolean };
  /** 还在的助手 id（缺省只有 as1）。后端 create 对查不到的 assistantId 抛「助手不存在」（minisd/index.ts chat.sessions.create）。 */
  assistants?: string[];
  /** settings 里的 workspace.lastUsed：后端建会话一律拿它当新会话的工作区根（chat-store createSession），create 的返回里带 workspaceRoot。 */
  lastUsed?: string;
  wsSetFails?: string; bindFails?: string; resetFails?: string;
};

let sessions: any[] = [];
/** 下一次调用该方法时抛一次（给「建出会话之后的某一步失败」用；boot 之后再设，免得打在 init 上）。 */
const failNext: Record<string, string> = {};

function stubRpc(o: Stub = {}): void {
  calls.length = 0;
  sessions = [
    { id: 'A', title: 'A', assistantId: 'as1', modelBinding: 'group:G1', ...(o.sourceA ?? {}) },
    { id: 'B', title: 'B' },
  ];
  rpcCallMock.mockImplementation(async (method: string, params: any) => {
    // 记下每次调用发生时 relayDraft 的快照：钉「open 之前就写好」靠它
    calls.push({ method, params, relayDraft: JSON.parse(JSON.stringify(useChat().relayDraft ?? null)) });
    if (failNext[method]) { const m = failNext[method]; delete failNext[method]; throw new Error(m); }
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return sessions.map(s => ({ ...s }));
    if (method === 'provider.instances.list') return [];
    if (method === 'provider.getDefault') return {};
    if (method === 'modelgroup.list') return [];
    if (method === 'assistants.list') return (o.assistants ?? ['as1']).map((id, i) => ({ id, name: id, avatar: '', rules: '', skillIds: [], prompts: [], sortOrder: i }));
    if (method === 'skills.list') return [];
    if (method === 'control.status') return { syncPaused: false };
    if (method === 'chat.messages.list') {
      return params?.sessionId === 'N' ? [] : [{ id: 'u1', role: 'user', parts: [{ type: 'text', value: '上一条' }], createdAt: 1 }];
    }
    if (method === 'chat.annotations.list') return { annotations: [] };
    if (method === 'chat.contextInfo') return { windowTokens: 1, usedTokens: 0, remaining: 1 };
    if (method === 'workspace.get') {
      if (params?.sessionId === 'A') return o.wsA ?? { root: '/proj', isDefault: false };
      return { root: `/bucket/${params?.sessionId}`, isDefault: true };
    }
    if (method === 'chat.sessions.create') {
      if (o.createDelayMs) await new Promise(r => setTimeout(r, o.createDelayMs));
      if (o.createFails) throw new Error(o.createFails);
      if (params?.assistantId !== undefined && !(o.assistants ?? ['as1']).includes(params.assistantId)) {
        throw new Error(`助手不存在: ${params.assistantId}`);
      }
      const s: any = { id: 'N', title: '新会话' };
      if (o.lastUsed) s.workspaceRoot = o.lastUsed;
      if (params?.assistantId) { s.assistantId = params.assistantId; s.modelBinding = o.createBinding ?? 'provider:P-from-assistant'; }
      sessions = [s, ...sessions];
      return s;
    }
    if (method === 'chat.sessions.setModelBinding') {
      if (o.bindFails) throw new Error(o.bindFails);
      const s = sessions.find(x => x.id === params.sessionId);
      if (s) { if (params.binding) s.modelBinding = params.binding; else delete s.modelBinding; }
      return { ok: true };
    }
    if (method === 'workspace.set') {
      if (o.wsSetFails) throw new Error(o.wsSetFails);
      return { root: params.root, isDefault: false };
    }
    if (method === 'workspace.reset') {
      if (o.resetFails) throw new Error(o.resetFails);
      return { root: `/bucket/${params?.sessionId}`, isDefault: true };
    }
    return undefined;
  });
}

async function boot(o: Stub = {}) {
  stubRpc(o);
  const chat = useChat();
  await chat.init();
  await chat.open('A');
  calls.length = 0;
  return chat;
}

/** 模拟 minisd 的 chat.event 广播（index.ts 的 run IIFE 发出的形态）。 */
function emit(sessionId: string, event: Record<string, unknown>): void {
  const h = handlers.get('chat.event');
  if (!h) throw new Error('init() 没有订阅 chat.event');
  h({ sessionId, event });
}

const FULL_MSG = '上下文已满：当前模型放不下这段对话，可新建会话用摘要接力';
const DRAFT = '接续上一个会话（上下文已满）。\n\n之前对话的摘要：\nS1\n\n我最后的请求是：\nU-last';
// 绑定错误的 message：中文说明在前，原始 400 响应体在后——响应体里有一个独立的 503
const BINDING_MSG = 'Claude 拒绝回放历史思考块：对话前缀校验未通过，换模型无法解决。请新建会话继续；如在用第三方中转，可改用官方端点。'
  + '（原始错误：Anthropic HTTP 400: {"type":"error","error":{"message":"The block is bound to a different conversation (block 503)"}}）';

beforeEach(() => {
  setActivePinia(createPinia());
  rpcCallMock.mockReset();
  handlers.clear();
  calls.length = 0;
  for (const k of Object.keys(failNext)) delete failNext[k];
});

// ═══════════════════════════ copy.ts：先按 code 选短句 ═══════════════════════════
describe('copy.ts：带分类码的事件先按 code 选短句，不对原始报文跑状态码正则', () => {
  it('errorShortByCode：contextFull / thinkingBinding 各有一句；其它 code 与缺省返回 undefined', () => {
    expect(copy.errorShortByCode('contextFull')).toBe('上下文已满，当前模型放不下这段对话');
    expect(copy.errorShortByCode('thinkingBinding')).toBe('Claude 拒绝回放历史思考块，请新建会话继续');
    expect(copy.errorShortByCode(undefined)).toBeUndefined();
    expect(copy.errorShortByCode('whatever')).toBeUndefined();
  });

  it('这正是要绕开的坑：同一条绑定报文交给 humanizeError 会被 503 误判', () => {
    expect(copy.humanizeError(BINDING_MSG)).toBe('模型服务暂时不可用（503）');
    expect(copy.errorShortByCode('thinkingBinding')).not.toMatch(/503|暂时不可用/);
  });

  it('fallbackShortByCause：因超窗降级写明「因上下文已满改用 <目标>」；其它原因不给（仍走通用短句）', () => {
    expect(copy.fallbackShortByCause('contextOverflow', '大窗(mock-big)')).toBe('因上下文已满改用 大窗(mock-big)');
    expect(copy.fallbackShortByCause(undefined, '大窗(mock-big)')).toBeUndefined();
  });

  it('humanizeError：没带 code 的溢出文案在 5xx 正则之前认出来', () => {
    expect(copy.humanizeError('上下文已满（已用 512 / 200000）')).toBe('上下文已满');
    expect(copy.humanizeError('OpenAI HTTP 400: {"error":{"message":"This model\'s maximum context length is 131072 tokens (500 more than allowed)"}}')).toBe('上下文已满');
    expect(copy.humanizeError('OpenAI HTTP 400: context_length_exceeded')).toBe('上下文已满');
    expect(copy.humanizeError('Anthropic HTTP 400: prompt is too long: 213462 tokens > 200000 maximum')).toBe('上下文已满');
    // 回归：401/403/429 仍先判；真 5xx 仍是服务不可用
    expect(copy.humanizeError('HTTP 429 too many tokens')).toBe('请求过频或额度不足');
    expect(copy.humanizeError('HTTP 503 Service Unavailable')).toBe('模型服务暂时不可用（503）');
  });
});

// ═══════════════════════════ store：按 code 分流 ═══════════════════════════
describe('store.onEvent：error 按 code 分流、fallback 按 cause 给短句', () => {
  it('contextFull：不给重试、给接力；草稿进 relaySource（不是 relayDraft，旧会话的输入卡不能把它取走）', async () => {
    const chat = await boot();
    emit('A', { kind: 'textDelta', text: '半截' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    const n = chat.eventNotes.at(-1)!;
    expect(n.kind).toBe('error');
    expect(n.retryable).toBe(false);
    expect(n.relay).toBe(true);
    expect(n.short).toBe('上下文已满，当前模型放不下这段对话');
    expect(n.detail).toBe(FULL_MSG);
    expect(chat.relaySource).toEqual({ sessionId: 'A', text: DRAFT });
    expect(chat.relayDraft).toBeNull();
    expect(chat.running).toBe(false);
    expect(chat.lastError).toBe(FULL_MSG);
  });

  it('contextFull 没带草稿：仍不给重试，也不给一个点了没东西可接的接力钮', async () => {
    const chat = await boot();
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG });
    const n = chat.eventNotes.at(-1)!;
    expect(n.retryable).toBe(false);
    expect(n.relay).toBeFalsy();
    expect(chat.relaySource).toBeNull();
  });

  it('thinkingBinding：不给重试（历史不变，重发必然同样 400）；短句按 code 选，不被响应体里的 503 带偏', async () => {
    const chat = await boot();
    emit('A', { kind: 'error', code: 'thinkingBinding', message: BINDING_MSG });
    const n = chat.eventNotes.at(-1)!;
    expect(n.retryable).toBe(false);
    expect(n.relay).toBeFalsy();
    expect(n.short).toBe('Claude 拒绝回放历史思考块，请新建会话继续');
    expect(n.detail).toBe(BINDING_MSG); // 原文完整留在详情里
  });

  it('回归：没带 code 的普通错误照旧可重试，不带接力与短句（短句仍由 EventNotes 现算 humanizeError）', async () => {
    const chat = await boot();
    emit('A', { kind: 'error', message: 'OpenAI HTTP 503: upstream' });
    const n = chat.eventNotes.at(-1)!;
    expect(n.retryable).toBe(true);
    expect(n.relay).toBeFalsy();
    expect(n.short).toBeUndefined();
  });

  it('fallback 带 cause:contextOverflow：短句「因上下文已满改用 <to>」；不带 cause 的降级不设短句', async () => {
    const chat = await boot();
    emit('A', { kind: 'fallback', from: '小窗(m-small)', to: '大窗(m-big)', reason: '上下文已满', cause: 'contextOverflow' });
    const a = chat.eventNotes.at(-1)!;
    expect(a.kind).toBe('fallback');
    expect(a.short).toBe('因上下文已满改用 大窗(m-big)');
    expect(a.detail).toBe('小窗(m-small) → 大窗(m-big)（上下文已满）');
    emit('A', { kind: 'fallback', from: '主力(p)', to: '备用(b)', reason: 'OpenAI HTTP 429: rate limited' });
    expect(chat.eventNotes.at(-1)!.short).toBeUndefined();
  });
});

// ═══════════════════════════ store：relayToNewSession ═══════════════════════════
describe('store.relayToNewSession：新建会话接力', () => {
  it('继承助手 → 模型绑定 → 自定义工作区；relayDraft 在 open() 取新会话消息之前就写好；不替用户发送', async () => {
    // lastUsed 故意与原会话的目录不同：后端把新会话放在 /elsewhere，要靠 workspace.set 改回 /proj
    const chat = await boot({ lastUsed: '/elsewhere' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();

    const seq = calls.map(c => c.method);
    const iCreate = seq.indexOf('chat.sessions.create');
    const iBind = seq.indexOf('chat.sessions.setModelBinding');
    const iWs = seq.indexOf('workspace.set');
    const iMsgs = calls.findIndex(c => c.method === 'chat.messages.list' && c.params?.sessionId === 'N');
    expect(iCreate).toBeGreaterThan(-1);
    expect(calls[iCreate].params).toEqual({ assistantId: 'as1' });
    // 助手预设给新会话套上了助手自己的绑定（provider:P-from-assistant），原会话绑的是组——照抄原会话的
    expect(calls[iBind].params).toEqual({ sessionId: 'N', binding: 'group:G1' });
    expect(calls[iWs].params).toEqual({ sessionId: 'N', root: '/proj' });
    expect(iCreate).toBeLessThan(iBind);
    expect(iBind).toBeLessThan(iMsgs);
    expect(iWs).toBeLessThan(iMsgs);
    // open(N) 去取消息的那一刻，草稿已经指向新会话：欢迎页新挂的输入卡在 setup 里拿得到
    expect(calls[iMsgs].relayDraft).toEqual({ sessionId: 'N', text: DRAFT });

    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT }); // store 不自己消费，留给输入卡
    expect(chat.relaySource).toBeNull();
    expect(chat.sessions.find(s => s.id === 'N')?.modelBinding).toBe('group:G1');
    expect(seq).not.toContain('workspace.reset'); // 照抄成功就不再动它
    expect(chat.lastError).toBe('');
    expect(seq).not.toContain('chat.prompt'); // 不自动发送
  });

  it('原会话无助手、无绑定、默认工作区：create 不带参数，不调 setModelBinding，也不设工作区', async () => {
    const chat = await boot({ sourceA: { assistantId: undefined, modelBinding: undefined }, wsA: { root: '/bucket/A', isDefault: true } });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    const seq = calls.map(c => c.method);
    expect(calls.find(c => c.method === 'chat.sessions.create')!.params).toEqual({});
    expect(seq).not.toContain('chat.sessions.setModelBinding');
    expect(seq).not.toContain('workspace.set');
    // 后端建出的新会话本来就在默认沙箱（没有 lastUsed），不必 reset
    expect(seq).not.toContain('workspace.reset');
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
  });

  it('原会话用默认沙箱、后端却把新会话放在 lastUsed（别的会话选的目录）：对新会话 workspace.reset，且在 open() 之前', async () => {
    const chat = await boot({ wsA: { root: '/bucket/A', isDefault: true }, lastUsed: '/other-project' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    const seq = calls.map(c => c.method);
    const iReset = calls.findIndex(c => c.method === 'workspace.reset');
    const iMsgs = calls.findIndex(c => c.method === 'chat.messages.list' && c.params?.sessionId === 'N');
    expect(iReset).toBeGreaterThan(-1);
    expect(calls[iReset].params).toEqual({ sessionId: 'N' });
    expect(iReset).toBeLessThan(iMsgs); // open() 里 refreshWorkspace 读到的已是新会话自己的沙箱
    expect(seq).not.toContain('workspace.set');
    expect(chat.activeId).toBe('N');
    expect(chat.workspaceIsDefault).toBe(true);
    expect(chat.lastError).toBe('');
  });

  it('默认沙箱放不回去（reset 失败）：照样落到新会话，并说清楚现在用的是哪个目录', async () => {
    const chat = await boot({ wsA: { root: '/bucket/A', isDefault: true }, lastUsed: '/other-project', resetFails: '数据库只读' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    await chat.relayToNewSession();
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    expect(chat.lastError).toBe('接力会话已建好，但没能把新会话放回默认工作区（数据库只读），现在用的是 /other-project');
  });

  it('原会话绑的助手已被删除（assistant_id 悬空）：不带 assistantId 建会话，接力照常成功，绑定仍照抄原会话', async () => {
    const chat = await boot({ assistants: [] });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    const creates = calls.filter(c => c.method === 'chat.sessions.create');
    expect(creates).toHaveLength(1);
    expect(creates[0].params).toEqual({});
    expect(calls.find(c => c.method === 'chat.sessions.setModelBinding')?.params).toEqual({ sessionId: 'N', binding: 'group:G1' });
    expect(chat.lastError).toBe('');
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
  });

  it('原会话的自定义目录已不存在（workspace.set 抛错）：只建一个会话、照样落到新会话、放回默认沙箱并说明；再点不会再建', async () => {
    const chat = await boot({ wsA: { root: '/gone', isDefault: false }, lastUsed: '/gone', wsSetFails: '目录不存在: /gone' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    await chat.relayToNewSession(); // 用户以为没反应又点一下
    expect(calls.filter(c => c.method === 'chat.sessions.create')).toHaveLength(1);
    // lastUsed 就是那个不存在的目录：不放回沙箱的话，新会话的 shell 会在一个不存在的 cwd 里起
    expect(calls.find(c => c.method === 'workspace.reset')?.params).toEqual({ sessionId: 'N' });
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    expect(chat.relaySource).toBeNull();
    expect(chat.lastError).toBe('接力会话已建好，但原会话的工作区用不了（目录不存在: /gone），新会话改用默认工作区');
  });

  it('模型绑定没能照抄（setModelBinding 抛错）：不拦接力，落到新会话并说明', async () => {
    const chat = await boot({ bindFails: '数据库只读' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    await chat.relayToNewSession();
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    expect(chat.lastError).toBe('接力会话已建好，但没能沿用原会话的模型绑定（数据库只读）');
  });

  it('会话建出后切过去失败（刷新列表抛错）：说明已建好；再点只切到那个会话、不再新建', async () => {
    const chat = await boot({ wsA: { root: '/gone', isDefault: false }, wsSetFails: '目录不存在: /gone' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    failNext['chat.sessions.list'] = '连接中断';
    await chat.relayToNewSession();
    expect(chat.activeId).toBe('A');
    expect(chat.lastError).toBe('接力会话已建好，但没能切过去：连接中断。可在会话列表里打开它，接力文本会自动填进输入框');
    // 草稿仍指向新会话：用户从列表点进去，欢迎页的输入卡照样取得到
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    await chat.relayToNewSession();
    expect(calls.filter(c => c.method === 'chat.sessions.create')).toHaveLength(1);
    expect(calls.filter(c => c.method === 'workspace.set')).toHaveLength(1); // 继承步骤也不重做
    expect(chat.activeId).toBe('N');
    expect(chat.relayDraft).toEqual({ sessionId: 'N', text: DRAFT });
    // 第一次尝试里没跟过来的工作区，切过去以后照样要说
    expect(chat.lastError).toBe('接力会话已建好，但原会话的工作区用不了（目录不存在: /gone），新会话改用默认工作区');
  });

  it('原会话有助手但解绑了模型：新会话被助手预设套上的绑定要解掉（照抄，不是照助手）', async () => {
    const chat = await boot({ sourceA: { modelBinding: undefined } });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await chat.relayToNewSession();
    const bind = calls.find(c => c.method === 'chat.sessions.setModelBinding');
    expect(bind?.params).toEqual({ sessionId: 'N', binding: undefined });
    expect(chat.sessions.find(s => s.id === 'N')?.modelBinding).toBeUndefined();
  });

  it('建会话失败：如实报「新建接力会话失败：…」，留在原会话，草稿还在，可以再点', async () => {
    const chat = await boot({ createFails: '数据库只读' });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    await chat.relayToNewSession();
    expect(chat.lastError).toBe('新建接力会话失败：数据库只读');
    expect(chat.activeId).toBe('A');
    expect(chat.relayDraft).toBeNull();
    expect(chat.relaySource).toEqual({ sessionId: 'A', text: DRAFT });
  });

  it('连点两下只建一个会话', async () => {
    const chat = await boot({ createDelayMs: 20 });
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    calls.length = 0;
    await Promise.all([chat.relayToNewSession(), chat.relayToNewSession()]);
    expect(calls.filter(c => c.method === 'chat.sessions.create')).toHaveLength(1);
    expect(chat.activeId).toBe('N');
  });

  it('草稿属于别的会话（出事后切走了）时什么也不做', async () => {
    const chat = await boot();
    emit('A', { kind: 'error', code: 'contextFull', message: FULL_MSG, relayDraft: DRAFT });
    await chat.open('B');
    calls.length = 0;
    await chat.relayToNewSession();
    expect(calls.map(c => c.method)).not.toContain('chat.sessions.create');
    expect(chat.activeId).toBe('B');
    expect(chat.relayDraft).toBeNull();
  });
});

// ═══════════════════════════ 源码守卫（剥注释后认调用形态；接力草稿几例在语法树上判） ═══════════════════════════
describe('源码守卫：接力钮、短句优先、输入卡只在 setup 消费', () => {
  const notes = sfc('ui/EventNotes.vue');
  const composer = sfc('ui/Composer.vue');
  const store = stripComments(read('stores/chat.ts'));

  it('EventNotes：接力钮按 n.relay 出现、点了调 chat.relayToNewSession()；重试钮仍只认 n.retryable', () => {
    expect(notes.tpl).toMatch(/<button v-if="n\.relay" class="rt relay" type="button" @click="chat\.relayToNewSession\(\)">新建会话接力<\/button>/);
    expect(notes.tpl).toMatch(/<button v-if="n\.retryable" class="rt" type="button" @click="chat\.retryLast\(\)">重试<\/button>/);
  });

  it('EventNotes：shortOf 先取 n.short，没有才现算 eventCopy', () => {
    const body = bodyFrom(notes.script, 'function shortOf(');
    const iShort = body.indexOf('if (n.short) return n.short;');
    const iCopy = body.indexOf('eventCopy(');
    expect(iShort).toBeGreaterThan(-1);
    expect(iCopy).toBeGreaterThan(iShort);
  });

  it('EventNotes：接力钮是品牌色，与红色重试钮区分开', () => {
    const m = /\.rt\.relay\s*\{([^}]*)\}/.exec(notes.css);
    expect(m, '缺 .rt.relay 样式').not.toBeNull();
    expect(m![1]).toMatch(/background:\s*var\(--c-brand\)/);
    expect(m![1]).toMatch(/color:\s*var\(--c-brand-ink\)/);
  });

  it('Composer：takeRelay 定义在 quote() 之后（不进 first-send 守卫的 sendBody 切片），setup 顶层调用一次', () => {
    const iQuote = composer.script.indexOf('\nfunction quote(');
    const iDef = composer.script.indexOf('\nfunction takeRelay(): void {');
    expect(iQuote).toBeGreaterThan(-1);
    expect(iDef).toBeGreaterThan(iQuote);
    // 排版沿用改动前的要求（`takeRelay();` 独占一行），留着它，本步对改动前只加不减。它只管排版：表达式体箭头函数 `=>` 后换行，
    // takeRelay(); 照样独占一行（W2a-6b 第二轮审查 A3），模板串里也能写出这么一行。是不是 setup 顶层的调用，由下面的语法树判
    expect(composer.script).toMatch(/^takeRelay\(\);$/m);
    // 语法树：提到 takeRelay 的恰好两处——<script setup> 顶层的函数声明，和一条父节点就是整个脚本的表达式语句 `takeRelay();`。
    // 只有这样的语句是 setup 时跑一次、之后不再跑。挪进 watch 回调（缩不缩进、回调体有没有花括号都一样，R2、A1–A3）、
    // 交给别处当回调、只写进字符串（F1），声明与调用的形态或次数就对不上
    const { sf } = composerSetup();
    const refs = mentions(sf, 'takeRelay');
    const decl = refs.filter(n => ts.isFunctionDeclaration(n.parent) && n.parent.name === n && n.parent.parent === sf);
    const call = refs.filter(n => ts.isCallExpression(n.parent) && n.parent.expression === n && n.parent.arguments.length === 0
      && ts.isExpressionStatement(n.parent.parent) && n.parent.parent.parent === sf);
    expect(decl.map(at), 'takeRelay 应在 <script setup> 顶层声明一次').toHaveLength(1);
    expect(call.map(at), 'takeRelay(); 应是 <script setup> 的顶层语句（父节点就是整个脚本），恰好一处').toHaveLength(1);
    expect(refs.map(at), 'takeRelay 只许出现在顶层声明与顶层调用这两处').toHaveLength(2);
  });

  // 不替用户发送（设计稿 §2「渲染端」、renderer.md「只预填、不发送，由用户确认后按 Enter」）。
  // 光拦 send 这个名字拦不住转手：别名可以定义在体外（Q3），可以交给白名单里的高阶调用当参数（nextTick(go)、
  // replace(/$/, go)，B1、B2），可以用非 ASCII 名字（B3），可以挂成属性回调（window.onfocus = go，B4），
  // 可以在体外定义同名的 trim()（B5），可以藏在 setter 里（o.v = …，E1）。所以在语法树上逐项钉死：
  // 体内调用的原文、实参的种类、赋值的目标、用到的名字、体内声明的名字；体内用到的体外名字在 setup 顶层各自只声明一次，
  // 且就是预期的那个（改名引入 nextTick 再自定义一个同名函数，调用原文不变，靠这条拦）。
  it('Composer：只取指向当前会话的草稿，取完即清；不替用户发送', () => {
    const { sf } = composerSetup();
    const fn = topFn(sf, 'takeRelay');
    expect(fn.modifiers ?? [], 'takeRelay 不许是 async / export').toHaveLength(0);
    expect(fn.asteriskToken, 'takeRelay 不许是生成器').toBeUndefined();
    expect(fn.parameters).toHaveLength(0);
    expect(fn.type?.getText(sf)).toBe('void');
    // 开头三句逐句比原文（语法树切出来的语句，字符串或注释里写一遍这段话喂不饱它）
    const stmts = fn.body.statements.map(s => s.getText(sf));
    expect(stmts.slice(0, 3)).toEqual(['const r = chat.relayDraft;', 'if (!r || r.sessionId !== chat.activeId) return;', 'chat.relayDraft = null;']);
    expect(stmts.filter(s => s.startsWith('text.value = ')), '预填：体内最外层要有一句 text.value = …').toHaveLength(1);

    const calls: string[] = [];
    const bad: string[] = [];
    const ids = new Set<string>();
    walk(fn.body, n => {
      if (ts.isIdentifier(n)) ids.add(n.text);
      if (ts.isCallExpression(n)) {
        calls.push(n.expression.getText(sf));
        // 实参只许是就地写的箭头函数与字面量：传一个名字进去（nextTick(go)），被调的一方就替你调了它
        for (const a of n.arguments) if (!ts.isArrowFunction(a) && !ts.isStringLiteral(a) && !ts.isRegularExpressionLiteral(a)) bad.push(`实参 ${a.getText(sf)}`);
      }
      // 不写括号也会调到别处代码的写法：new、标签模板、await（thenable）、delete（Proxy）、自增自减（getter / setter）
      if (ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n) || ts.isAwaitExpression(n) || ts.isYieldExpression(n) || ts.isDeleteExpression(n)) bad.push(n.getText(sf));
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
        && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) bad.push(n.getText(sf));
      // 赋值只许写这两处：别的目标可能是 setter（E1），也可能把回调挂到事件属性上（B4）
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && !['text.value', 'chat.relayDraft'].includes(n.left.getText(sf))) bad.push(`赋值 ${n.left.getText(sf)}`);
    });
    // 先拦最直白的：体内提到 send（调用、起别名、写进字面量都算）
    expect(mentions(fn.body, 'send').map(at), 'takeRelay 体内提到了 send').toEqual([]);
    // 调用按原文比（排序后逐项相等）：只认名字的话，体外定义的同名 trim() 冒充 .trim()（B5）
    expect(calls.sort(), 'takeRelay 体内的调用应恰好是预填要用的这四个').toEqual(['field.value?.focus', 'nextTick', 'r.text.replace', 'text.value.trim']);
    expect(bad, 'takeRelay 体内有白名单之外的写法').toEqual([]);
    // 用到的名字（含属性名）逐个列出：读一个体外对象的 getter（void o.v）、把对象塞进模板串触发 toString，都要先提到一个新名字
    expect([...ids].sort(), 'takeRelay 体内用到了预填以外的名字')
      .toEqual(['activeId', 'chat', 'cur', 'field', 'focus', 'nextTick', 'r', 'relayDraft', 'replace', 'sessionId', 'text', 'trim', 'value']);
    // 体内只声明 r 与 cur：体内另声明一个 text / chat / field，就把下面钉住的体外名字遮住了
    expect(declsIn(fn.body).sort(), 'takeRelay 体内声明的名字').toEqual(['cur', 'r']);
    // 体内用到的体外名字，以及造出它们的 ref / useChat，在 setup 顶层各自只声明一次，就是这一句
    const outer: Record<string, string[]> = {
      chat: ['const chat = useChat()'],
      text: ["const text = ref('')"],
      field: ['const field = ref<HTMLTextAreaElement | null>(null)'],
      nextTick: ['{ nextTick } from vue'],
      ref: ['{ ref } from vue'],
      useChat: ['{ useChat } from ../stores/chat'],
    };
    for (const [name, want] of Object.entries(outer)) expect(topDecls(sf, name), `setup 顶层对 ${name} 的声明`).toEqual(want);
  });

  // 为什么钉引用、不认某一种 watch 写法：open(N) 先把 activeId 设成 N 再 await 取消息，这段时间旧会话页的输入卡还挂着；
  // watch(() => chat.activeId, takeRelay)、watchEffect(() => takeRelay())、watch 回调里就地读 relayDraft……
  // 都会让旧卡在 pre-flush 里把指向 N 的草稿取走，随后它被欢迎页替换卸载，草稿就丢了。写法数不完，
  // 所以钉住哪里能提到它：takeRelay 只有顶层声明与顶层调用（上上一例）；relayDraft 只在 takeRelay 体内取、清两处，
  // 且不包在体内的回调里——takeRelay 在 setup 时跑，体内挂的回调同样活到组件卸载（第三轮审查 R1、R7）。
  it('Composer：不用 watch 消费草稿（旧会话的输入卡在 open() 的 await 期间还挂着，watch 会抢走再随组件卸载丢掉）', () => {
    const { sf, tpl, outside } = composerSetup();
    // 模板也是执行点：模板表达式与事件绑定跑在组件的渲染副作用里，activeId / relayDraft 一变就重跑，与 watch 同险
    // （W2a-6b 审查 Q1、Q2）；样式里的 v-bind() 同样是渲染副作用（Q7），第二个 <script> 块不在 <script setup> 里（Q8）。
    // 这里只做「不许出现」的检查，所以查原文、不剥注释：剥注释只会藏东西，模板里 accept="image/*" 的 /* 就曾被当成注释
    // 开头，一路吞到样式里（Q9）
    expect(tpl, '模板里提到了接力草稿').not.toMatch(/\b(?:takeRelay|relayDraft|relaySource)\b/);
    expect(outside, '<script setup> 之外（模板、样式 v-bind()、别的块）提到了接力草稿').not.toMatch(/\b(?:takeRelay|relayDraft|relaySource)\b/);
    const fn = topFn(sf, 'takeRelay');
    const hooks: string[] = [];
    walk(fn.body, n => {
      if (ts.isCallExpression(n) && /(?:^|\.)(?:watch\w*|\$subscribe|\$onAction|on[A-Z]\w*|addEventListener|set(?:Timeout|Interval))$/.test(n.expression.getText(sf))) hooks.push(n.expression.getText(sf));
    });
    expect(hooks, 'takeRelay 体内注册了 watch / 钩子 / 订阅').toEqual([]);
    const drafts = mentions(sf, 'relayDraft');
    // 两处 = 上一例钉住的 `const r = chat.relayDraft;` 与 `chat.relayDraft = null;`
    expect(drafts.map(at), '<script setup> 里 relayDraft 应只有 takeRelay 体内取、清两处').toHaveLength(2);
    for (const n of drafts) {
      expect(n.getStart(sf) > fn.body.getStart(sf) && n.end < fn.body.end, `${at(n)}：relayDraft 在 takeRelay 体外`).toBe(true);
      let wrapped = '';
      for (let p = n.parent; p !== fn.body; p = p.parent) if (ts.isFunctionLike(p) || ts.isClassLike(p)) wrapped = p.getText(sf).slice(0, 60);
      expect(wrapped, `${at(n)}：relayDraft 包在 takeRelay 体内的回调里`).toBe('');
    }
    // relaySource 是出事旧会话的草稿停放处，只归 store 与接力钮管，输入卡不碰
    expect(mentions(sf, 'relaySource').map(at)).toEqual([]);
  });

  // 扫描范围是渲染端能打包进来的代码：src/renderer 整个目录（含 index.html）与经 @shared 别名引用的 src/shared，
  // 扩展名认 Vite 能解析的 .vue / .html / .[cm][jt]s(x)。取草稿挪进 .ts 帮手（R5）、放进 src/shared（C1）、写成 .mts（C2），
  // Composer 与 store 里都不多一处，上面几例看不见，要靠这里。原文查、不剥注释（理由同上一例，Q9）；脚本另经语法树查一遍，
  // 认得出转义写法 relay\u0044raft。从这两个目录之外只许类型引用：值引用出去的话（渲染端已有 import type 引 minisd），
  // 帮手放在 src/minisd、src/main 里就出了扫描范围。
  it('渲染端可打包的代码里只有 Composer 与 stores/chat.ts 提到 relayDraft / relaySource；从 src/renderer、src/shared 之外只许类型引用', () => {
    const DIRS = ['src/renderer', 'src/shared'];
    const files = DIRS.flatMap(d => (readdirSync(join(ROOT, d), { recursive: true }) as string[]).map(f => `${d}/${f.replace(/\\/g, '/')}`))
      .filter(f => /\.(?:vue|html|[cm]?[jt]sx?)$/.test(f));
    expect(files.filter(f => f.endsWith('.vue')).length).toBeGreaterThan(10);
    expect(files.filter(f => f.endsWith('.ts')).length).toBeGreaterThan(10);
    expect(files).toEqual(expect.arrayContaining(['src/renderer/index.html', 'src/shared/parts.ts', 'src/renderer/src/main.ts']));
    const touching: string[] = [];
    const escapes: string[] = [];
    for (const f of files) {
      const raw = readRoot(f);
      const { sfs, srcs } = scriptsOf(f, raw);
      if (/\brelay(?:Draft|Source)\b/.test(raw) || sfs.some(s => mentions(s, 'relayDraft').length + mentions(s, 'relaySource').length > 0)) touching.push(f);
      const refs = [...sfs.flatMap(importsOf), ...srcs.map(spec => ({ spec, typeOnly: false }))];
      for (const { spec, typeOnly } of refs) if (!typeOnly && landsOutside(f, spec, DIRS)) escapes.push(`${f} → ${spec}`);
    }
    expect(touching.sort()).toEqual(['src/renderer/src/stores/chat.ts', 'src/renderer/src/ui/Composer.vue']);
    expect(escapes, '渲染端值引用了 src/renderer、src/shared 之外的模块：挪进 src/shared，或把那个目录加进上面的扫描').toEqual([]);
  });

  it('StageChat：错误横幅的图标不随长报错收缩（绑定错误折成多行时曾被压成一个点）', () => {
    const chatCss = sfc('ui/StageChat.vue').css;
    expect(chatCss).toMatch(/\.err :deep\(svg\) \{ flex: 0 0 auto; \}/);
  });

  it('store：relayDraft 是 {sessionId, text}；eventNotes 类型带 relay / short', () => {
    expect(store).toMatch(/relayDraft: null as null \| \{ sessionId: string; text: string \}/);
    expect(store).toContain('retryable?: boolean; relay?: boolean; short?: string }[]');
  });

  it('store：relayToNewSession 先写 relayDraft 再 await this.open(，并照抄模型绑定', () => {
    const body = bodyFrom(store, 'async relayToNewSession() {');
    const iDraft = body.indexOf('this.relayDraft = { sessionId: ');
    const iOpen = body.indexOf('await this.open(');
    expect(iDraft).toBeGreaterThan(-1);
    expect(iOpen).toBeGreaterThan(iDraft);
    expect(body).toMatch(/rpc\.call\('chat\.sessions\.setModelBinding', \{ sessionId: /);
  });

  // W2a-6b：store 这一侧也得钉。给 store 加个取草稿的 action（popRelay），Composer 在 watch 里调它——Composer 里
  // 既不多一处 relayDraft 也不多一处 takeRelay，上面几例全看不见（第三轮审查 R3）。所以按语法树看 relayDraft 在 store 里
  // 落在哪：只许在 state 声明与 relayToNewSession 里（只写不读），没有 getter / action 能把它取走。引擎事件的同名字段
  // 只在 onEvent 的一句里读，它进的是 relaySource（上面 store.onEvent 的行为测试钉着），这一句按原文钉住。
  // 不按变量名放行（把接收者叫成 e 就能混过去，W2a-6b 审查 Q4），也不在剥过注释的文本上数（字符串里的 'a//' 会把
  // 同行后面的读写一起剥掉，D3）。
  it('store：relayDraft 只出现在 state 声明与 relayToNewSession 里（外加 onEvent 读引擎事件字段的一句），没有别的 getter / action 能取走它', () => {
    const sf = tsOf('chat.ts', read('stores/chat.ts'));
    const sites = storeSites(sf, 'relayDraft');
    expect(sites.filter(s => s.site === 'state'), 'state 声明应恰好一处').toHaveLength(1);
    expect([...new Set(sites.map(s => s.site))].sort(), 'relayDraft 出现在 state 声明、onEvent、relayToNewSession 之外')
      .toEqual(['onEvent', 'relayToNewSession', 'state']);
    const EVENT_LINE = "const draft = typeof e.relayDraft === 'string' ? e.relayDraft : '';";
    expect(sites.filter(s => s.site === 'onEvent').map(s => stmtOf(s.node).getText(sf)), 'onEvent 里只许读引擎事件字段的那一句')
      .toEqual([EVENT_LINE, EVENT_LINE]);
  });

  // W2a-6b 第二轮审查 D1：relaySource 同理。给 store 加个取 relaySource 的 action，Composer 在 watch 里调它，
  // 用户切回出事的旧会话时接力文本就被填进那个已满的会话；relaySource 被清空后 relayToNewSession 直接 return，
  // 接力钮也失效了——正是 state 里 relaySource 注释要防的事。所以它在 store 里只许落在 state 声明、onEvent（引擎报
  // contextFull 时写入，按原文钉成只写这一句）与 relayToNewSession（接力钮取用）里。
  it('store：relaySource 只出现在 state 声明、onEvent（只写）与 relayToNewSession 里', () => {
    const sf = tsOf('chat.ts', read('stores/chat.ts'));
    const sites = storeSites(sf, 'relaySource');
    expect(sites.filter(s => s.site === 'state'), 'state 声明应恰好一处').toHaveLength(1);
    expect([...new Set(sites.map(s => s.site))].sort(), 'relaySource 出现在 state 声明、onEvent、relayToNewSession 之外')
      .toEqual(['onEvent', 'relayToNewSession', 'state']);
    expect(sites.filter(s => s.site === 'onEvent').map(s => stmtOf(s.node).getText(sf)), 'onEvent 里只许写入这一句')
      .toEqual(['this.relaySource = draft ? { sessionId: this.activeId, text: draft } : null;']);
  });
});
