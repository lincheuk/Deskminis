import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, type VNode } from 'vue';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import * as vue from 'vue';

const xt = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: any;
  constructor(o: any) { this.options = { ...o }; xt.instances.push(this); }
  loadAddon() {} open() {} onData() {} reset() {} write() {} writeln() {} dispose() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on, off: vi.fn(), onLost: probe.lost, connect: probe.connect } }));
import { resetStoreRpc } from './renderer-store-fixture';
import { runSetup } from './sfc-setup';
import { initTheme, setTheme, toggleTheme, themeMode } from '../src/renderer/src/lib/theme';

const UI = join(__dirname, '../src/renderer/src/ui');
const nodes = (v: any): VNode[] => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === 'object' && 'type' in v ? [v, ...nodes(v.children)] : [];
let mem: Map<string, string>, dataset: Record<string, string>, dark: boolean;
let observer: (() => void) | undefined;
beforeEach(() => {
  resetStoreRpc(probe); xt.instances.length = 0; dark = false; observer = undefined; mem = new Map();
  dataset = new Proxy<Record<string, string>>({}, { set(t, k: string, v) { t[k] = v; queueMicrotask(() => observer?.()); return true; }, deleteProperty(t, k: string) { delete t[k]; queueMicrotask(() => observer?.()); return true; } });
  vi.stubGlobal('document', { documentElement: { dataset } });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: dark, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('MutationObserver', class { constructor(fn: () => void) { observer = fn; } observe() {} disconnect() { observer = undefined; } });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (key: string) => dataset.theme === 'dark' ? ({ '--c-bg': '#101010', '--c-ink': '#eeeeee', '--c-bg-3': '#303030' } as any)[key] : ({ '--c-bg': '#ffffff', '--c-ink': '#111111', '--c-bg-3': '#dddddd' } as any)[key] }));
  initTheme();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('U1 theme startup and shared controls', () => {
  for (const saved of ['system', 'light', 'dark', 'broken', null]) {
    it('real main applies ' + saved + ' before createApp and mount', async () => {
      if (saved !== null) mem.set('deskminis.theme', saved);
      dataset.theme = 'dark';
      const bundle = await build({ entryPoints: [join(UI, '../main.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, loader: { '.css': 'empty' }, plugins: [{ name: 'shell-stub', setup(b) { b.onLoad({ filter: /AppShell\.vue$/ }, () => ({ contents: 'export default {}', loader: 'js' })); } }] });
      const seen: unknown[] = [];
      const require = createRequire(import.meta.url);
      new Function('require', bundle.outputFiles[0].text)((id: string) => id === 'vue' ? { ...vue, createApp: () => {
        seen.push(['create', dataset.theme]); return { use() { return this; }, mount(id: string) { seen.push(['mount', id, dataset.theme]); } };
      } } : id === 'pinia' ? { createPinia: () => ({}) } : require(id));
      const expected = saved === 'light' || saved === 'dark' ? saved : undefined;
      expect(seen).toEqual([['create', expected], ['mount', '#app', expected]]);
    });
  }
  it('read and write exceptions preserve usable system and explicit theme', () => {
    vi.stubGlobal('localStorage', { getItem() { throw Error('read'); }, setItem() { throw Error('write'); } });
    dataset.theme = 'dark'; expect(() => initTheme()).not.toThrow(); expect(dataset.theme).toBeUndefined();
    expect(() => setTheme('light')).not.toThrow(); expect([themeMode.value, dataset.theme]).toEqual(['light', 'light']);
  });
  for (const systemDark of [false, true]) {
    it('system effective brightness toggles and survives module reload ' + systemDark, async () => {
      dark = systemDark; setTheme('system'); toggleTheme();
      const expected = systemDark ? 'light' : 'dark';
      expect([dataset.theme, mem.get('deskminis.theme')]).toEqual([expected, expected]);
      const rebuilt = await build({ entryPoints: [join(UI, '../lib/theme.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false });
      const mod = { exports: {} as any };
      new Function('require', 'module', 'exports', rebuilt.outputFiles[0].text)(() => vue, mod, mod.exports);
      const reboot = mod.exports;
      delete dataset.theme; reboot.initTheme(); expect([reboot.themeMode.value, dataset.theme]).toEqual([expected, expected]);
    });
  }
  it('TopBar event reaches AppShell toggle; settings reflect current module, not an old stored choice', async () => {
    const shell = await runSetup<(ctx: object, cache: unknown[]) => VNode>(join(UI, 'AppShell.vue'), {}, effectScope(), { inlineTemplate: true });
    const bar = nodes(shell.bindings({}, [])).find(n => (n.type as any)?.name === './TopBar.vue')!;
    const top = await runSetup<(ctx: object, cache: unknown[]) => VNode>(join(UI, 'TopBar.vue'), { railOpen: true, asideOpen: true, termOpen: false }, effectScope(), { inlineTemplate: true, emit: e => { if (e === 'toggle-theme') bar.props!.onToggleTheme(); } });
    const settings = await runSetup<(ctx: object, cache: unknown[]) => VNode>(join(UI, 'settings/SecLook.vue'), {}, effectScope(), { inlineTemplate: true });
    try {
      const button = nodes(top.bindings({}, [])).find(n => n.type === 'button' && n.props?.title === '切换明暗')!;
      expect(button.props?.['aria-label']).toBe('切换明暗'); button.props!.onClick();
      expect(dataset.theme).toBe('dark'); expect(mem.get('deskminis.theme')).toBe('dark');
      // 模拟写存储失败/外部旧值；当前选择必须来自共享状态。
      mem.set('deskminis.theme', 'light'); settings.mount(); await nextTick();
      const buttons = nodes(settings.bindings({}, [])).filter(n => n.type === 'button');
      expect(buttons.map(n => n.props?.['aria-pressed'])).toEqual([false, false, true]);
      buttons[0].props!.onClick(); expect(dataset.theme).toBeUndefined(); expect(mem.get('deskminis.theme')).toBe('system');
    } finally { shell.unmount(); top.unmount(); settings.unmount(); }
  });
  it('unchanged terminal observer rereads palette after the shared toggle and disconnects on unmount', async () => {
    const term = await runSetup<any>(join(UI, 'TerminalPane.vue'), {}, effectScope());
    term.mount();
    try {
      expect(xt.instances[0].options.theme.background).toBe('#ffffff');
      toggleTheme(); await nextTick(); expect(xt.instances[0].options.theme).toMatchObject({ background: '#101010', foreground: '#eeeeee', cursor: '#eeeeee' });
      toggleTheme(); await nextTick(); expect(xt.instances[0].options.theme.background).toBe('#ffffff');
    } finally { term.unmount(); }
    expect(observer).toBeUndefined();
  });
});

it('U1 every CSS custom property reference, including nested fallbacks, is declared in renderer', () => {
  // CSS 对未定义变量只回退不报错：这是补充13明确允许的整目录静态守卫。
  const root = join(UI, '../..');
  const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)]);
  const files = walk(root).filter(p => /\.(css|vue|ts|js|html)$/.test(p)).map(p => ({ p, text: readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));
  const definitions = new Set(files.flatMap(f => [...f.text.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1])));
  const missing = files.flatMap(f => [...f.text.matchAll(/var\(\s*(--[\w-]+)/g)].filter(m => !definitions.has(m[1])).map(m => ({ file: f.p.slice(root.length + 1), variable: m[1] })));
  expect(missing).toEqual([]);
});

describe('U1b startup never rewrites the saved preference', () => {
  for (const scenario of ['missing', 'invalid', 'read-error']) {
    it('real startup makes no setItem call when ' + scenario, async () => {
      const setItem = vi.fn();
      vi.stubGlobal('localStorage', {
        getItem: () => { if (scenario === 'read-error') throw Error('read blocked'); return scenario === 'invalid' ? 'broken' : null; },
        setItem,
      });
      dataset.theme = 'dark';
      const bundle = await build({ entryPoints: [join(UI, '../main.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, loader: { '.css': 'empty' }, plugins: [{ name: 'shell-stub', setup(b) { b.onLoad({ filter: /AppShell\.vue$/ }, () => ({ contents: 'export default {}', loader: 'js' })); } }] });
      const mount = vi.fn();
      const require = createRequire(import.meta.url);
      new Function('require', bundle.outputFiles[0].text)((id: string) => id === 'vue' ? { ...vue, createApp: () => ({ use() { return this; }, mount }) } : id === 'pinia' ? { createPinia: () => ({}) } : require(id));
      expect(mount).toHaveBeenCalledWith('#app');
      expect(dataset.theme).toBeUndefined();
      // 写入是可用的；必须证明启动根本没有尝试写，而非写异常被吞。
      expect(setItem).not.toHaveBeenCalled();
    });
  }
});
