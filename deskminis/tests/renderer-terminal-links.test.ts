/** W2b-6b（设计稿 §4.1 W2b-6b · W2b-6 第三轮审查必修）：终端抽屉里的 OSC 8 超链接交给系统浏览器。
 *
 *  为什么：TerminalPane 的 new Terminal({...}) 以前没配 linkHandler，xterm 走它自带的 defaultActivate——先弹英文确认框，
 *  再 window.open() 开一个空白窗口、事后改那个窗口的 location.href。W2b-6 起主进程的 setWindowOpenHandler 只看得到 about:blank，
 *  按规矩拒绝、不交出：点了链接、在确认框里点了确定，什么也不发生（静默失效；W2b-6 之前则是在应用里开出第二个窗口加载外站）。
 *  修法：linkHandler.activate 里直接 window.open(地址)，主进程拒绝新窗口、把 http / https 交给系统浏览器（openInSystem）。
 *  OSC 8 的显示文字可以和目标地址不一样（程序输出里写「文档」两个字，指向的却是别的网站），所以打开前用中文确认框把真实地址
 *  给用户看，取消就不打开；xterm 自带的英文确认框不再出现。不开 allowNonHttpProtocols：xterm 仍只让 http / https 的 OSC 8 链接可点。
 *
 *  审查修正：框里给的地址与真正交出去的，必须是同一个串。xterm 交给 activate 的是 OSC 8 里的原文——原文里夹一个 U+202E
 *  （从右到左覆盖）或一个同形字母（西里尔字母 U+0430），框里显示的主机就和实际打开的不一样，「显示文字不等于目标地址」的欺骗
 *  换到地址这一行上照样成立。所以框里给、window.open 交的都是规范形 new URL(地址).href：双向控制符被百分号转义，
 *  非 ASCII 的主机名成了 punycode（xn--…），与主进程 openInSystem（externalUrlOf 同样取 .href）交给系统浏览器的一致；
 *  主机另起一行（https://apple.com@evil.example/ 这类地址，前半截像 apple.com，真正去的是 @ 后面的主机）。
 *
 *  两层：
 *  ① 行为：真跑 TerminalPane 的 <script setup>（tests/sfc-setup.ts 的 runSetup），@xterm/xterm 换成记下构造选项的桩，
 *     挂载后取出交给 new Terminal 的 linkHandler，直接调 activate（xterm 点击链接时就是这么调的：鼠标事件、地址、范围）；
 *  ② 源码守卫：sfcBlocks 取脚本段（注释已剥）交给 TypeScript 解析，认 new Terminal( 的选项里 linkHandler 的 activate
 *     调了 window.open(<规范形>)，规范形由 new URL(<地址参数>) 得来——在语法树上认，不数括号，确认框文案里的括号、引号打不乱它。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// xterm 桩：只记构造选项，其余方法空转（挂载时 TerminalPane 会调 loadAddon / open / onData）
const xt = vi.hoisted(() => ({ created: [] as Array<Record<string, unknown>> }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    constructor(o: Record<string, unknown>) { xt.created.push(o); this.options = { ...o }; }
    loadAddon(): void {}
    open(): void {}
    onData(): { dispose(): void } { return { dispose() {} }; }
    write(): void {}
    writeln(): void {}
    reset(): void {}
    dispose(): void {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} activate(): void {} dispose(): void {} } }));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: vi.fn(async () => ({})), connect: async () => {}, on: vi.fn(), off: vi.fn() },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as vue from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { runSetup } from './sfc-setup';
import { sfcBlocks } from './sfc-blocks';

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
const FILE = join(__dirname, '../src/renderer/src/ui/TerminalPane.vue');

type LinkHandler = { activate?: (e: unknown, uri: string, range: unknown) => void; allowNonHttpProtocols?: boolean };

// ─────────────────────────── ① 行为：真跑 setup，调 xterm 会调的 activate ───────────────────────────
const g = globalThis as Record<string, unknown>;
const GLOBALS = ['window', 'document', 'getComputedStyle', 'ResizeObserver', 'MutationObserver', 'confirm', 'open'] as const;
// 测试前这几个全局原来是什么样（node 里本来都没有），收尾时照原样放回去
const savedGlobals = GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
let confirmSpy = vi.fn((_msg?: string) => true);
let openSpy = vi.fn((_url?: string | URL) => null);
let scope = vue.effectScope();

beforeEach(() => {
  setActivePinia(createPinia());
  scope = vue.effectScope();
  xt.created.length = 0;
  confirmSpy = vi.fn((_msg?: string) => true);
  openSpy = vi.fn((_url?: string | URL) => null);
  // 挂载要用到的浏览器全局，给最小的桩；confirm / open 写成 window.confirm 还是裸 confirm 都落到同一个间谍上
  g.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    confirm: confirmSpy, open: openSpy,
  };
  g.confirm = confirmSpy;
  g.open = openSpy;
  g.document = { documentElement: {} };
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  g.ResizeObserver = class { observe(): void {} disconnect(): void {} };
  g.MutationObserver = class { observe(): void {} disconnect(): void {} };
});
afterEach(() => {
  scope.stop();
  for (const [k, d] of savedGlobals) {
    if (d) Object.defineProperty(g, k, d); else delete g[k];
  }
});

/** 挂载 TerminalPane，取出交给 new Terminal 的 linkHandler（没有 activate 就红在这里，不往下调） */
async function mountedLinkHandler(): Promise<LinkHandler> {
  const run = await runSetup<Record<string, unknown>>(FILE, {}, scope);
  run.mount();
  expect(xt.created, '挂载时应当 new Terminal 一次').toHaveLength(1);
  const lh = (xt.created[0].linkHandler ?? {}) as LinkHandler;
  expect(lh.activate, '没配 linkHandler 时 xterm 走自带的 defaultActivate：window.open() 开空白窗口，主进程只看到 about:blank').toBeTypeOf('function');
  return lh;
}
/** xterm 调 activate 时给的第三个实参（链接在缓冲区里的范围，1 起算） */
const RANGE = { start: { x: 7, y: 1 }, end: { x: 21, y: 1 } };
const CLICK = { type: 'mouseup', button: 0 };
/** window.open 收到的地址：实参按浏览器的规矩转成字符串（交 URL 对象，浏览器用的就是它的 href） */
const opened = (): string[] => openSpy.mock.calls.map((c) => String(c[0]));
/** 双向控制符：LRM、RLM、ALM，LRE / RLE / PDF / LRO / RLO，LRI / RLI / FSI / PDI */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** 框里单起一行给出主机：有一行带着 host，又不是整条地址（不含 ://），也不带 @。标签怎么写不管。
 *  为什么不许带 @：主机里不会有 @，这一行带着 @，就是把 @ 前面的用户名段也当成网站显示了——从整条地址里切主机
 *  （href.split('/')[2] 之类）会把 https://apple.com@evil.example/ 切成「apple.com@evil.example」，前半截像 apple.com；
 *  主机单起一行防的正是这一种。只查 host 与 :// 时，这样切主机的写法一例也不红（W2b-6b 第四轮审查）。 */
function hasHostLine(msg: string, host: string): boolean {
  return msg.split('\n').some((l) => l.includes(host) && !l.includes('://') && !l.includes('@'));
}

describe('① 终端 OSC 8 链接的点击（真跑 TerminalPane 的 setup）', () => {
  it('new Terminal 的选项里有 linkHandler.activate；不开 allowNonHttpProtocols（xterm 仍只让 http / https 可点）', async () => {
    const lh = await mountedLinkHandler();
    expect(lh.allowNonHttpProtocols ?? false).toBe(false);
  });

  it('点击：先用中文确认框给出真实地址；确定后 window.open(地址)，交给主进程转系统浏览器', async () => {
    const lh = await mountedLinkHandler();
    const uri = 'https://example.com/docs?q=1#part';   // 规范形与原文相同的普通地址
    lh.activate!(CLICK, uri, RANGE);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const msg = String(confirmSpy.mock.calls[0][0] ?? '');
    expect(msg, '确认框里要有真实地址').toContain(uri);
    expect(msg, '确认框的话用中文').toMatch(/[\u4e00-\u9fff]/);
    expect(msg, '不再是 xterm 自带的英文确认框').not.toMatch(/Do you want to navigate|WARNING/);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(opened(), 'window.open 要带上地址（不带地址就是 about:blank，主进程交不出去）').toEqual([uri]);
  });

  it('显示文字与目标地址不一样时，确认框给的是目标地址（activate 收到的就是 OSC 8 的 URI）', async () => {
    const lh = await mountedLinkHandler();
    // 终端里显示的是「官方文档」，OSC 8 实际指向别处：xterm 调 activate 给的是后者
    const uri = 'http://127.0.0.1:9/elsewhere';
    lh.activate!(CLICK, uri, RANGE);
    expect(String(confirmSpy.mock.calls[0]?.[0] ?? '')).toContain(uri);
    expect(opened()).toEqual([uri]);
  });

  it('确认框里点取消：不打开', async () => {
    const lh = await mountedLinkHandler();
    confirmSpy.mockImplementation(() => false);
    lh.activate!(CLICK, 'https://example.com/', RANGE);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('主机名里夹同形字（西里尔字母 U+0430）：框里给 punycode 的规范形并单起一行给主机，window.open 收到的正是框里那个串', async () => {
    const lh = await mountedLinkHandler();
    // 第一个字母是西里尔字母 U+0430，原文显示出来就是 apple.com；交给系统浏览器的是 xn--pple-43d.com
    lh.activate!(CLICK, 'https://\u0430pple.com/login', RANGE);
    const msg = String(confirmSpy.mock.calls[0]?.[0] ?? '');
    expect(msg, '框里不许出现原文里的西里尔字母（看上去就是 apple.com）').not.toContain('\u0430');
    expect(msg, '框里给规范形：主机是 punycode').toContain('https://xn--pple-43d.com/login');
    expect(hasHostLine(msg, 'xn--pple-43d.com'), `主机要单起一行：${JSON.stringify(msg)}`).toBe(true);
    expect(opened(), 'window.open 收到的就是框里那个串').toEqual(['https://xn--pple-43d.com/login']);
  });

  it('地址里夹双向控制符（U+202E 从右到左覆盖）：框里一个控制符也没有，单起一行给真实主机，window.open 收到同一个串', async () => {
    const lh = await mountedLinkHandler();
    // 原文显示出来像 https://nigol/elpmaxe.live@apple.com；apple 那段其实是用户名，真正的主机是 evil.example
    lh.activate!(CLICK, 'https://\u202emoc.elppa@evil.example/login', RANGE);
    const msg = String(confirmSpy.mock.calls[0]?.[0] ?? '');
    expect(msg, '框里不许有双向控制符').not.toMatch(BIDI);
    expect(msg, '框里给规范形：控制符被百分号转义').toContain('https://%E2%80%AEmoc.elppa@evil.example/login');
    expect(hasHostLine(msg, 'evil.example'), `真实主机要单起一行：${JSON.stringify(msg)}`).toBe(true);
    expect(opened(), 'window.open 收到的就是框里那个串').toEqual(['https://%E2%80%AEmoc.elppa@evil.example/login']);
  });

  it('地址带用户名段（https://apple.com@evil.example/login）：「网站」一行只给真实主机 evil.example，不带 @ 前面那段；window.open 收到同一个串', async () => {
    const lh = await mountedLinkHandler();
    // @ 前面的 apple.com 是用户名段，真正去的是 evil.example。这个地址的规范形与原文相同，钉的是主机那一行：
    // 主机从整条地址里切出来，就成了「apple.com@evil.example」，前半截像 apple.com
    const uri = 'https://apple.com@evil.example/login';
    lh.activate!(CLICK, uri, RANGE);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const msg = String(confirmSpy.mock.calls[0]?.[0] ?? '');
    expect(msg, '框里给完整的地址').toContain(uri);
    expect(hasHostLine(msg, 'evil.example'), `真实主机要单起一行，不带 @ 前面的用户名段：${JSON.stringify(msg)}`).toBe(true);
    expect(opened(), 'window.open 收到的就是框里那个串').toEqual([uri]);
  });

  it('地址解析不了：不弹框、不打开（不开 allowNonHttpProtocols 时 xterm 本不会交来；防的是回落成原文）', async () => {
    const lh = await mountedLinkHandler();
    lh.activate!(CLICK, 'not a url', RANGE);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── ② 源码守卫：语法树上认 new Terminal( 的 linkHandler.activate → window.open(规范形) ───────────────────────────
const script = sfcBlocks(readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n'), 'TerminalPane.vue').script;
const sf = ts.createSourceFile('TerminalPane.script.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

type TsNode = import('typescript').Node;
type TsExpr = import('typescript').Expression;
type TsObj = import('typescript').ObjectLiteralExpression;
type TsFn = import('typescript').ArrowFunction | import('typescript').FunctionExpression
  | import('typescript').MethodDeclaration | import('typescript').FunctionDeclaration;

/** 先序走遍 n 与它的全部子节点 */
function walk(n: TsNode, f: (n: TsNode) => void): void {
  f(n);
  ts.forEachChild(n, (c) => walk(c, f));
}
/** 剥掉不改值的外壳：括号、as、satisfies、非空断言 */
function bare(e: TsExpr): TsExpr {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}
/** 对象字面量里名为 name 的属性（普通属性、简写属性、方法都算） */
function propOf(obj: TsObj, name: string): import('typescript').ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
}
/** 同文件里 const name = <初始值> 的初始值（剥过外壳），或同名的函数声明——选项、linkHandler、activate、
 *  转手的函数抽成同文件的常量或函数也认得出 */
function constInit(name: string): TsNode | undefined {
  let out: TsNode | undefined;
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) out = bare(n.initializer);
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) out = n;
  });
  return out;
}
/** 表达式的值：标识符按同文件的常量解开 */
function deref(e: TsExpr | undefined): TsNode | undefined {
  if (e === undefined) return undefined;
  const b = bare(e);
  return ts.isIdentifier(b) ? constInit(b.text) : b;
}
/** 属性的值：简写属性与标识符按同文件的常量解开 */
function valueOf(p: import('typescript').ObjectLiteralElementLike): TsNode | undefined {
  if (ts.isShorthandPropertyAssignment(p)) return constInit(p.name.text);
  if (ts.isMethodDeclaration(p)) return p;
  if (ts.isPropertyAssignment(p)) return deref(p.initializer);
  return undefined;
}
/** 函数形态的节点：箭头函数、函数表达式、方法、函数声明 */
function asFn(n: TsNode | undefined): TsFn | undefined {
  return n !== undefined && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n))
    ? n : undefined;
}
/** new Terminal( 的选项对象：行内对象，或同文件的常量 */
function optionsOf(ne: import('typescript').NewExpression | undefined): TsObj | undefined {
  const v = deref(ne?.arguments?.[0]);
  return v !== undefined && ts.isObjectLiteralExpression(v) ? v : undefined;
}

/** 值的来历：raw = xterm 交来的原文地址；url = 由它 new URL(…) 得来的 URL 对象；canon = 规范形（URL 对象的 .href / .toString()） */
type Kind = 'raw' | 'url' | 'canon';

/** 走函数体，但不进嵌在里面的具名函数（它们只经调用、带着实参的来历进去认，见 opensIn）；回调这类匿名函数照走 */
function walkBody(fn: TsFn, f: (n: TsNode) => void): void {
  const go = (n: TsNode): void => {
    f(n);
    ts.forEachChild(n, (c) => {
      const named = ts.isFunctionDeclaration(c) || ((ts.isArrowFunction(c) || ts.isFunctionExpression(c)) && ts.isVariableDeclaration(c.parent));
      if (!named) go(c);
    });
  };
  go(fn);
}

/** fn 里（连同它把地址转手给的同文件函数）每一处 window.open( 的实参是什么：'<规范形>'（URL 对象或它的 .href）、
 *  '<原文 …>'（xterm 交来的原文）、否则照抄源码。params：fn 的哪个参数装着哪一类（activate 的第二个参数是原文）。
 *  变量按赋值认：声明的初始值与每一次 = 赋值都是同一类，它才算那一类——`let t; try { t = new URL(uri).href; } catch { return; }`
 *  认作规范形，catch 里回落成 t = uri 就不算；参数在函数里被改过，就不再按调用方给的来历算。 */
function opensIn(fn: TsFn, params: ReadonlyMap<string, Kind>, seen: Set<TsFn>): string[] {
  if (seen.has(fn)) return [];
  seen.add(fn);
  const assigns = new Map<string, TsExpr[]>();
  walkBody(fn, (n) => {
    const add = (name: string, e: TsExpr): void => { assigns.set(name, [...(assigns.get(name) ?? []), e]); };
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) add(n.name.text, n.initializer);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) add(n.left.text, n.right);
  });
  const vars = new Map([...params].filter(([p]) => !assigns.has(p)));
  const kindOf = (e: TsExpr): Kind | undefined => {
    const b = bare(e);
    if (ts.isIdentifier(b)) return vars.get(b.text);
    if (ts.isNewExpression(b)) {
      const one = b.arguments?.length === 1 ? b.arguments[0] : undefined;
      return ts.isIdentifier(b.expression) && b.expression.text === 'URL' && one !== undefined && kindOf(one) !== undefined ? 'url' : undefined;
    }
    const of = ts.isPropertyAccessExpression(b) && b.name.text === 'href' ? b.expression
      : ts.isCallExpression(b) && b.arguments.length === 0 && ts.isPropertyAccessExpression(b.expression) && b.expression.name.text === 'toString'
        ? b.expression.expression : undefined;
    return of !== undefined && kindOf(of) === 'url' ? 'canon' : undefined;
  };
  // 别名一层层认（const u = new URL(uri); const t = u.href; const s = t;），直到不再变
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, es] of assigns) {
      if (vars.has(name)) continue;
      const k = kindOf(es[0]);
      if (k !== undefined && es.every((e) => kindOf(e) === k)) { vars.set(name, k); grew = true; }
    }
  }
  const out: string[] = [];
  walkBody(fn, (n) => {
    if (!ts.isCallExpression(n)) return;
    const c = n.expression;
    const a = n.arguments;
    if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'window' && c.name.text === 'open') {
      const k = a[0] === undefined ? undefined : kindOf(a[0]);
      out.push(k === 'url' || k === 'canon' ? '<规范形>' : k === 'raw' ? `<原文 ${a[0].getText(sf)}>` : `<${a[0]?.getText(sf) ?? '无实参'}>`);
      return;
    }
    // 地址（或由它得来的值）转手给同文件的函数：带着实参的来历进去接着认
    const callee = ts.isIdentifier(c) ? asFn(constInit(c.text)) : undefined;
    if (callee === undefined) return;
    const passed = new Map<string, Kind>();
    callee.parameters.forEach((p, i) => {
      const k = a[i] === undefined ? undefined : kindOf(a[i]);
      if (k !== undefined && ts.isIdentifier(p.name)) passed.set(p.name.text, k);
    });
    if (passed.size > 0) out.push(...opensIn(callee, passed, seen));
  });
  return out;
}

describe('② 源码守卫（sfcBlocks 取脚本段、剥过注释，再交给 TypeScript 解析）', () => {
  const news: import('typescript').NewExpression[] = [];
  walk(sf, (n) => { if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Terminal') news.push(n); });

  it('new Terminal( 恰好一处，选项是对象（行内，或同文件的常量），里面有 linkHandler（行内对象，或同文件的常量）', () => {
    expect(news).toHaveLength(1);
    const opts = optionsOf(news[0]);
    expect(opts, 'new Terminal( 的第一个实参应当是选项对象').toBeDefined();
    const lh = propOf(opts!, 'linkHandler');
    expect(lh, 'new Terminal( 的选项里没有 linkHandler：xterm 会走自带的 defaultActivate（英文确认框 + 空白窗口）').toBeDefined();
    const v = valueOf(lh!);
    expect(v !== undefined && ts.isObjectLiteralExpression(v), 'linkHandler 应当是对象').toBe(true);
  });

  it('linkHandler 的 activate 调了 window.open(<规范形>)：由 new URL(<activate 的第二个参数>) 得来，不交原文；没有 allowNonHttpProtocols: true', () => {
    const opts = optionsOf(news[0]);
    const lhProp = opts ? propOf(opts, 'linkHandler') : undefined;
    const lh = lhProp ? valueOf(lhProp) : undefined;
    expect(lh !== undefined && ts.isObjectLiteralExpression(lh), 'new Terminal( 的选项里找不到 linkHandler 对象').toBe(true);
    const lhObj = lh as TsObj;
    const allow = propOf(lhObj, 'allowNonHttpProtocols');
    expect(allow === undefined || (ts.isPropertyAssignment(allow) && allow.initializer.kind === ts.SyntaxKind.FalseKeyword),
      '不开 allowNonHttpProtocols：javascript:、file: 这类地址不许成为可点的链接').toBe(true);
    const actProp = propOf(lhObj, 'activate');
    expect(actProp, 'linkHandler 里没有 activate').toBeDefined();
    const fn = asFn(valueOf(actProp!));
    expect(fn, 'activate 应当是函数（箭头函数、函数表达式、方法，或同文件的函数）').toBeDefined();
    const uriParam = fn!.parameters[1]?.name;
    expect(uriParam !== undefined && ts.isIdentifier(uriParam), 'activate 要接第二个参数（xterm 给的地址）').toBe(true);
    const uri = (uriParam as import('typescript').Identifier).text;
    const opens = opensIn(fn!, new Map<string, Kind>([[uri, 'raw']]), new Set());
    expect(opens, `activate 里应当恰好一处 window.open(<由 new URL(${uri}) 得来的规范形>)：交原文的话，确认框里给的就不是真正交出去的那个串`)
      .toEqual(['<规范形>']);
  });
});
