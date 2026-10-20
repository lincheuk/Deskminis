import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isVNode, markRaw, nextTick, type VNode } from 'vue';
import { join } from 'node:path';
import { runSetup, type SetupRun } from './sfc-setup';
import { initStore, resetStoreRpc, minimalReply, settleStore, type Chat } from './renderer-store-fixture';
const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on, onLost: probe.lost, connect: probe.connect } }));
const all = (v: any): VNode[] => Array.isArray(v) ? v.flatMap(all) : isVNode(v) ? [v, ...all(v.children)] : [];
const runs: SetupRun<any>[] = [], observers: TestObserver[] = [];
const stored = new Map<string, string>(), listeners = new Map<string, any>(), frames: FrameRequestCallback[] = [];
const key = 'deskminis.chatColWidth';
let chat: Chat;
class TestObserver {
  cb: ResizeObserverCallback; element: any; disconnected = false;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; observers.push(this); }
  observe(el: any) { this.element = el; }
  disconnect() { this.disconnected = true; }
  fire() { this.cb([], this as any); }
}
beforeEach(async () => {
  resetStoreRpc(probe); stored.clear(); observers.length = 0; frames.length = 0; listeners.clear();
  vi.stubGlobal('localStorage', { getItem: vi.fn((k: string) => stored.get(k) ?? null), setItem: vi.fn((k: string, v: string) => stored.set(k, v)), removeItem: vi.fn((k: string) => stored.delete(k)) });
  vi.stubGlobal('window', { deskminis: {}, addEventListener: (k: string, f: any) => listeners.set(k, f), removeEventListener: (k: string) => listeners.delete(k) });
  vi.stubGlobal('ResizeObserver', TestObserver);
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '372px' }));
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.push(f); return frames.length; });
  chat = await initStore(probe); chat.activeId = 'S'; chat.messages = [{ id: 'U', role: 'user', parts: [{ type: 'text', value: '合成' }] }];
});
afterEach(() => { runs.splice(0).forEach(r => r.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function settle() { await nextTick(); for (let i = 0; i < 3; i++) { frames.splice(0).forEach(f => f(0)); await nextTick(); } }
async function shell(width = 1200, preview = true) {
  const s = await runSetup<any>(join(__dirname, '../src/renderer/src/ui/AppShell.vue'), {}, effectScope(), { inlineTemplate: true }); runs.push(s); s.mount();
  const nodes = () => all(s.bindings({}, []));
  const split = () => nodes().find(n => n.props?.class?.includes?.('split'))!;
  let measured = width;
  const el = markRaw({ getBoundingClientRect: () => ({ width: measured }) });
  (split().ref as any).r.value = el; await nextTick();
  const open = (kind: 'preview' | 'review') => kind === 'preview' ? chat.pendingFilePreview = 'fixture.md' : nodes().find(n => (n.type as any)?.name?.endsWith('WorkspacePanel.vue'))!.props!.onReview('C');
  if (preview) { open('preview'); await nextTick(); }
  const handle = () => nodes().find(n => n.props?.role === 'separator');
  const column = () => nodes().find(n => (n.type as any)?.name?.endsWith('StageChat.vue'))!;
  const close = () => nodes().find(n => (n.type as any)?.name?.endsWith('PreviewPane.vue'))!.props!.onClose();
  const capture = new Set<number>();
  const target = { setPointerCapture: vi.fn((id: number) => capture.add(id)), hasPointerCapture: (id: number) => capture.has(id), releasePointerCapture: vi.fn((id: number) => capture.delete(id)) };
  const event = (name: string, extra: object = {}) => handle()!.props![name]({ button: 0, pointerId: 7, clientX: 100, currentTarget: target, preventDefault: vi.fn(), ...extra });
  return { s, split, handle, column, close, open, target, event, now: () => handle()!.props!['aria-valuenow'], resize: async (w: number) => { measured = w; observers.find(o => o.element === el && !o.disconnected)!.fire(); await nextTick(); } };
}
describe('N24 splitter actual template handlers', () => {
  it('纯对话没有手柄；默认与归位都不写宽度，即使可用宽度太窄', async () => {
    const v = await shell(604, false); expect(v.handle()).toBeUndefined(); expect(v.column().props!.style).toBeUndefined();
    v.open('preview'); await nextTick(); expect(v.now()).toBe(372); expect(v.column().props!.style).toBeUndefined();
    expect(v.handle()!.props).toMatchObject({ tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': '调整对话列宽度', 'aria-valuemin': 320, 'aria-valuemax': 320 });
  });
  it('主键有4px死区，5px才开始；松手存偏好，捕获与拖动属性配对', async () => {
    const v = await shell(); v.event('onPointerdown', { button: 2 }); v.event('onPointermove', { clientX: 180 }); expect(v.now()).toBe(372);
    v.event('onPointerdown'); expect(v.target.setPointerCapture).toHaveBeenCalledWith(7);
    v.event('onPointermove', { clientX: 103 }); expect(v.now()).toBe(372); expect(v.split().props!['data-pane-dragging']).toBeUndefined();
    v.event('onPointermove', { clientX: 104 }); expect(v.now()).toBe(372);
    v.event('onPointermove', { clientX: 105, pointerId: 8 }); expect(v.now()).toBe(372);
    v.event('onPointermove', { clientX: 105 }); expect(v.now()).toBe(377); expect(v.split().props!['data-pane-dragging']).toBe(''); expect(stored.has(key)).toBe(false);
    v.event('onPointerup'); expect(stored.get(key)).toBe('377'); expect(v.column().props!.style).toEqual({ flex: '0 0 377px' }); expect(v.handle()!.props!.style).toEqual({ left: '373px' }); expect(v.target.releasePointerCapture).toHaveBeenCalledWith(7); expect(v.split().props!['data-pane-dragging']).toBeUndefined();
  });
  it('拖动钳制320到分栏宽减360；小分栏取320', async () => {
    const v = await shell(); v.event('onPointerdown'); v.event('onPointermove', { clientX: -900 }); expect(v.now()).toBe(320);
    v.event('onPointermove', { clientX: 5000 }); expect(v.now()).toBe(840); v.event('onPointerup');
    await v.resize(604); expect(v.now()).toBe(320); expect(stored.get(key)).toBe('840'); await v.resize(1500); expect(v.now()).toBe(840);
  });
  it('Escape回到本次开始前的偏好，释放捕获；双击归位并删键', async () => {
    stored.set(key, '500'); const v = await shell(); v.event('onPointerdown'); v.event('onPointermove', { clientX: 150 }); expect(v.now()).toBe(550);
    listeners.get('keydown')({ key: 'Escape', preventDefault() {} }); expect(v.now()).toBe(500); expect(stored.get(key)).toBe('500'); expect(v.target.releasePointerCapture).toHaveBeenCalledWith(7);
    v.event('onPointerup'); expect(stored.get(key)).toBe('500'); v.event('onDblclick'); expect(v.now()).toBe(372); expect(stored.has(key)).toBe(false); expect(v.column().props!.style).toBeUndefined();
  });
  it('未存过时Escape恢复缺省；取消与丢捕获均回滚', async () => {
    const v = await shell(); for (const end of ['onPointercancel', 'onLostpointercapture']) { v.event('onPointerdown'); v.event('onPointermove', { clientX: 140 }); v.event(end); expect(v.now()).toBe(372); expect(stored.has(key)).toBe(false); }
    v.event('onPointerdown'); v.event('onPointermove', { clientX: 140 }); v.event('onKeydown', { key: 'Escape' }); expect(v.column().props!.style).toBeUndefined();
  });
  it('方向键每次16px，Home/End共用边界；两面板共用宽度', async () => {
    const v = await shell(); for (const [k, w] of [['ArrowRight', 388], ['ArrowLeft', 372], ['Home', 320], ['ArrowLeft', 320], ['End', 840], ['ArrowRight', 840]] as const) { v.event('onKeydown', { key: k }); expect(v.now()).toBe(w); expect(stored.get(key)).toBe(String(w)); }
    expect(v.handle()!.props).toMatchObject({ 'aria-valuemin': 320, 'aria-valuemax': 840 }); v.open('review'); await nextTick(); expect(v.now()).toBe(840);
  });
  it.each(['', ' ', 'bad', 'NaN', 'Infinity', '-Infinity'])('坏偏好%s按没拖过处理', async raw => {
    stored.set(key, raw); const v = await shell(604); expect(v.now()).toBe(372); expect(v.column().props!.style).toBeUndefined();
  });
  it('读写抛错仍能拖宽与归位', async () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => { throw Error('blocked'); }); const v = await shell();
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw Error('quota'); }); v.event('onKeydown', { key: 'ArrowRight' }); expect(v.now()).toBe(388);
    vi.mocked(localStorage.removeItem).mockImplementation(() => { throw Error('blocked'); }); v.event('onDblclick'); expect(v.now()).toBe(372);
  });
  it('跨挂载读回偏好；收起面板时回滚未完成拖动，卸载退订', async () => {
    const v = await shell(); v.event('onKeydown', { key: 'End' }); v.s.unmount(); runs.pop(); const w = await shell(); expect(w.now()).toBe(840);
    w.event('onPointerdown'); w.event('onPointermove', { clientX: 80 });
    chat.activeId = 'other'; await nextTick(); expect(w.handle()).toBeUndefined(); expect(stored.get(key)).toBe('840');
    w.s.unmount(); runs.pop(); expect(listeners.has('keydown')).toBe(false); expect(observers.every(o => o.disconnected)).toBe(true);
  });
});
describe('N24 resize keeps StageChat following intent', () => {
  it.each([false, true])('上翻=%s时布局改变不重新裁决跟随', async up => {
    const s = await runSetup<any>(join(__dirname, '../src/renderer/src/ui/StageChat.vue'), {}, effectScope()); runs.push(s);
    let top = 900, writes = 0; const el = markRaw({ scrollHeight: 1000, clientHeight: 100, get scrollTop() { return top; }, set scrollTop(v: number) { writes++; top = Math.min(v, el.scrollHeight - el.clientHeight); } });
    s.bindings.scroller.value = el; await nextTick(); const o = observers.find(o => o.element === el)!;
    if (up) { s.bindings.onWheel({ deltaY: -1 }); top = 500; }
    for (const height of [1400, 1100, 1900]) { el.scrollHeight = height; o.fire(); await settle(); expect(s.bindings.following.value).toBe(!up); if (!up) { expect(top).toBe(height - 100); expect(s.bindings.backVisible.value).toBe(false); } else { expect(top).toBe(500); } }
    expect(writes).toBe(up ? 0 : 3); s.unmount(); runs.pop(); expect(o.disconnected).toBe(true);
  });
});

describe('N24 补充19a four review counterexamples', () => {
  it('拖到一半关预览再开，内存和显示宽度都回到拖之前', async () => {
    stored.set(key, '500'); const v = await shell();
    v.event('onPointerdown'); v.event('onPointermove', { clientX: 150 }); expect(v.now()).toBe(550);
    v.close(); await nextTick(); expect(v.handle()).toBeUndefined(); expect(v.column().props!.style).toBeUndefined(); expect(stored.get(key)).toBe('500');
    v.open('preview'); await nextTick(); expect(v.now()).toBe(500); expect(v.column().props!.style).toEqual({ flex: '0 0 500px' });
    expect(v.handle()!.props!.style).toEqual({ left: '496px' }); expect(v.split().props!['data-pane-dragging']).toBeUndefined();
  });
  it('上翻后尺寸变化跨过120px，回到底部随离底距离重新判定', async () => {
    const s = await runSetup<any>(join(__dirname, '../src/renderer/src/ui/StageChat.vue'), {}, effectScope()); runs.push(s);
    let top = 750, writes = 0;
    const el = markRaw({ scrollHeight: 1000, clientHeight: 100, get scrollTop() { return top; }, set scrollTop(v: number) { writes++; top = v; } });
    s.bindings.scroller.value = el; await nextTick(); const o = observers.find(o => o.element === el)!;
    s.bindings.onWheel({ deltaY: -1 }); expect(s.bindings.backVisible.value).toBe(true);
    for (const [height, visible] of [[970, false], [971, true], [900, false]] as const) {
      el.scrollHeight = height; o.fire(); await settle(); expect(s.bindings.backVisible.value).toBe(visible); expect(s.bindings.following.value).toBe(false);
    }
    expect(top).toBe(750); expect(writes).toBe(0);
  });
  it.each(['xhigh', 'max'] as const)('%s降为高时，实际下拉title保留本轮按高发送', async level => {
    chat.providers = [{ id: 'P', name: '合成', hasApiKey: false, modelId: 'synthetic' }]; chat.defaultProviderId = 'P'; chat.thinkingLevel = level;
    probe.call.mockImplementation((method: string) => method === 'provider.runtime.resolve'
      ? Promise.resolve({ runtime: { reasoning: { state: 'supported' } }, thinkingPreview: { xhigh: { level: 'high', note: '只支持高' }, max: { level: 'high', note: '只支持高' } } }) : minimalReply(method));
    const s = await runSetup<any>(join(__dirname, '../src/renderer/src/ui/Composer.vue'), {}, effectScope(), { inlineTemplate: true }); runs.push(s); await settleStore();
    const nodes = all(s.bindings({}, [])), select = nodes.find(v => v.type === 'select')!;
    expect(select.props!.value).toBe(level); expect(select.props!.title).toContain('本轮按高发送');
    expect(nodes.find(v => String(v.props?.class).includes('thinking-note'))?.children).toBe('本轮按高发送');
  });
  it('有禁用server时MCP实际按钮title与aria含禁N，模型胶囊与权限下拉可命名', async () => {
    chat.sessions = [{ id: 'S', title: '合成', mcpDisabled: ['alpha'] }];
    chat.mcpServers = { servers: [{ name: 'alpha', enabled: true, transport: 'stdio' }, { name: 'beta', enabled: true, transport: 'stdio' }], statuses: [], configError: false };
    const s = await runSetup<any>(join(__dirname, '../src/renderer/src/ui/Composer.vue'), {}, effectScope(), { inlineTemplate: true }); runs.push(s); await settleStore();
    const nodes = all(s.bindings({}, [])), mcp = nodes.find(v => v.type === 'button' && String(v.props?.class).includes('mcpbtn'))!;
    expect(mcp.props!.title).toContain('MCP · 禁 1'); expect(mcp.props!['aria-label']).toContain('MCP · 禁 1');
    const caps = nodes.filter(v => v.type === 'span' && String(v.props?.class).split(/\s+/).includes('cap'));
    expect(caps).toHaveLength(1); for (const cap of caps) { expect(cap.props!.role).toBe('img'); expect(cap.props!['aria-label']).toBeTruthy(); }
    const permission = nodes.find(v => v.type === 'select' && String(v.props?.class).includes('perm-select'))!;
    expect(permission.props!['aria-label']).toBe('权限档'); expect(permission.props!.title).toBe('权限档：每次确认');
    expect(all(permission.children).filter(v => v.type === 'option').map(v => v.props!.value)).toEqual(['ask', 'session', 'plan', 'full']);
  });
});
