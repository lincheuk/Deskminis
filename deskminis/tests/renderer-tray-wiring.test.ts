/** W2b-11a：托盘「打开设置」「切换右栏」两条死通道接上（AppShell 一侧 + 跨文件的死通道绊线）。
 *
 *  立项事实（侦察 cross.md missing 末条）：main/index.ts 的托盘菜单一直在 webContents.send('menu:toggle-right' /
 *  'menu:open-settings')，preload 也暴露了 onMenuOpenSettings / onMenuToggleRight，但 src/renderer/src 里零订阅，
 *  两项点了没反应——也是界面撒谎（菜单上摆着做不到的事）。
 *
 *  两层：
 *  ① AppShell 真跑 setup（tests/sfc-setup.ts），用仿 preload 的桥：「打开设置」切到设置舞台，「切换右栏」与标题栏
 *     右栏钮是同一个动作（模板里 @toggle-aside 绑的那个函数），卸载时两条都退订。
 *  ② 通道绊线，全靠算、不写死名单：主进程 send 的每条通道 preload 都有订阅接口、接口都带退订；
 *     preload 的每个订阅接口在渲染端都有调用（剥注释后认调用形态 `.接口名(`）——以后再多一条推送通道，
 *     只在 preload 里包一层、渲染端没人订的话，这里先红。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: vi.fn(async () => undefined), connect: async () => {}, on: vi.fn(), off: vi.fn() },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as vue from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useChat } from '../src/renderer/src/stores/chat';
import { runSetup } from './sfc-setup';
import { sfcBlocks } from './sfc-blocks';
import { stripComments } from './strip-comments';

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const APP_FILE = join(root, 'src/renderer/src/ui/AppShell.vue');

/** 仿 preload（与 src/preload/index.ts 同形：订阅返回退订函数），按通道记监听。 */
function fakeBridge() {
  const listeners = { settings: new Set<() => void>(), right: new Set<() => void>() };
  return {
    listeners,
    onMenuOpenSettings(cb: () => void) { listeners.settings.add(cb); return () => { listeners.settings.delete(cb); }; },
    onMenuToggleRight(cb: () => void) { listeners.right.add(cb); return () => { listeners.right.delete(cb); }; },
    fire(ch: 'settings' | 'right') { for (const cb of [...listeners[ch]]) cb(); },
  };
}

type AppBindings = Record<string, unknown> & { view: { value: string }; wsOpen: { value: boolean } };

let scope = vue.effectScope();
let bridge = fakeBridge();
beforeEach(() => {
  setActivePinia(createPinia());
  scope = vue.effectScope();
  bridge = fakeBridge();
  (globalThis as { window?: unknown }).window = { deskminis: bridge };
});
afterEach(() => {
  scope.stop();
  delete (globalThis as { window?: unknown }).window;
});

describe('W2b-11a AppShell：托盘两条通道（真跑 setup）', () => {
  const tpl = sfcBlocks(read('src/renderer/src/ui/AppShell.vue'), 'AppShell.vue').template;
  /** 标题栏「工作台」钮在 AppShell 这边绑的处理函数名（剥过 HTML 注释的模板里现取，不写死）。 */
  const asideHandler = /<TopBar\b[^>]*@toggle-aside="(\w+)(?:\(\))?"/.exec(tpl)?.[1] ?? '';

  async function mounted(): Promise<{ b: AppBindings; unmount: () => void }> {
    const chat = useChat();
    chat.init = async () => {}; // onMounted 里的 init 要连引擎，这里不连
    const run = await runSetup<AppBindings>(APP_FILE, {}, scope);
    run.mount();
    return { b: run.bindings, unmount: run.unmount };
  }

  it('挂载后两条通道各订一次', async () => {
    await mounted();
    expect(bridge.listeners.settings.size).toBe(1);
    expect(bridge.listeners.right.size).toBe(1);
  });

  it('托盘「打开设置」：切到设置舞台', async () => {
    const { b } = await mounted();
    expect(b.view.value).toBe('chat');
    bridge.fire('settings');
    expect(b.view.value).toBe('settings');
  });

  it('托盘「切换右栏」与标题栏右栏钮是同一个动作：一开一合，两边交替按也对得上', async () => {
    expect(asideHandler, '标题栏的 @toggle-aside 要绑一个具名函数（托盘与它共用）').not.toBe('');
    const { b } = await mounted();
    const fromTopBar = b[asideHandler];
    expect(typeof fromTopBar).toBe('function');
    const start = b.wsOpen.value;
    bridge.fire('right');
    expect(b.wsOpen.value).toBe(!start);
    (fromTopBar as () => void)();
    expect(b.wsOpen.value).toBe(start);
    bridge.fire('right');
    bridge.fire('right');
    expect(b.wsOpen.value).toBe(start);
  });

  it('卸载时两条都退订：之后托盘再点不再动界面', async () => {
    const { b, unmount } = await mounted();
    unmount();
    expect(bridge.listeners.settings.size).toBe(0);
    expect(bridge.listeners.right.size).toBe(0);
    const [view, ws] = [b.view.value, b.wsOpen.value];
    bridge.fire('settings'); bridge.fire('right');
    expect([b.view.value, b.wsOpen.value]).toEqual([view, ws]);
  });
});

// ── 死通道绊线 ─────────────────────────────────────────────────────────────

/** preload 里的订阅接口：属性值是函数、函数体里 ipcRenderer.on('<通道>') 的那些。语法树上认（注释天然不在里面），
 *  顺带记下同一个函数体里有没有 ipcRenderer.removeListener 同一条通道（即返回的退订函数摘的是它）。 */
function preloadSubscriptions(src: string): { api: string; channel: string; removes: boolean }[] {
  const sf = ts.createSourceFile('preload.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: { api: string; channel: string; removes: boolean }[] = [];
  const ipcCalls = (fn: import('typescript').Node, method: string): string[] => {
    const found: string[] = [];
    const walk = (n: import('typescript').Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.expression.getText(sf) === 'ipcRenderer' && n.expression.name.text === method) {
        const a = n.arguments[0];
        if (a && ts.isStringLiteralLike(a)) found.push(a.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(fn);
    return found;
  };
  const visit = (n: import('typescript').Node): void => {
    if (ts.isPropertyAssignment(n) && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      const removed = ipcCalls(n.initializer, 'removeListener');
      for (const channel of ipcCalls(n.initializer, 'on')) out.push({ api: n.name.getText(sf), channel, removes: removed.includes(channel) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** 渲染端全部源码，剥过注释：.ts 去 /* *\/ 与 // 行；.vue 取脚本段与模板段（sfcBlocks 各按本段语言剥）。 */
function rendererSources(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const raw = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      if (p.endsWith('.ts')) out.push({ file: p, code: stripComments(raw) });
      else if (p.endsWith('.vue')) { const b = sfcBlocks(raw, p); out.push({ file: p, code: `${b.script}\n${b.template}` }); }
    }
  };
  walk(join(root, 'src/renderer/src'));
  return out;
}

describe('W2b-11a 死通道绊线：主进程推的每条通道，渲染端都有人订', () => {
  const sent = [...stripComments(read('src/main/index.ts')).matchAll(/webContents\.send\(\s*'([^']+)'/g)].map(m => m[1]);
  const subs = preloadSubscriptions(read('src/preload/index.ts'));

  it('抽取自检：主进程的托盘菜单确实在推这两条（正则或路径失效时这里先红，免得下面几条空转变绿）', () => {
    expect(sent).toEqual(expect.arrayContaining(['menu:open-settings', 'menu:toggle-right']));
    expect(subs.map(s => s.channel)).toEqual(expect.arrayContaining(['menu:open-settings', 'menu:toggle-right']));
  });

  it('主进程 send 的每条通道，preload 都有订阅接口', () => {
    const subscribed = new Set(subs.map(s => s.channel));
    expect(sent.filter(ch => !subscribed.has(ch))).toEqual([]);
  });

  it('preload 的每个订阅接口都返回退订函数（摘的是同一条通道），组件卸载时才摘得掉', () => {
    expect(subs.filter(s => !s.removes).map(s => s.api)).toEqual([]);
  });

  it('preload 的每个订阅接口在渲染端都有调用（剥注释后认 `.接口名(`）', () => {
    const src = rendererSources();
    const dead = subs.filter(s => !src.some(f => new RegExp(`\\.${s.api}\\s*\\(`).test(f.code))).map(s => `${s.api}（${s.channel}）`);
    expect(dead, `这些订阅接口渲染端没人调，主进程推过来的消息石沉大海：${dead.join('、')}`).toEqual([]);
  });
});
