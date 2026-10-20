/** N05b：真实 Pinia + StageChat setup/模板，手动控制布局、绘制帧和用户输入时钟。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isVNode, markRaw, nextTick, reactive, type VNode } from 'vue';
import { join } from 'node:path';
import { runSetup, type SetupRun } from './sfc-setup';
import { initStore, resetStoreRpc, type Chat } from './renderer-store-fixture';
const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on, onLost: probe.lost, connect: probe.connect } }));
const file = join(__dirname, '../src/renderer/src/ui/StageChat.vue');
const runs: SetupRun<any>[] = [], frames = new Map<number, FrameRequestCallback>();
let chat: Chat, now = 1000, id = 0, reduce = false;
const listeners = new Map<string, () => void>();
const all = (v: any): VNode[] => Array.isArray(v) ? v.flatMap(all) : isVNode(v) ? [v, ...all(v.children)] : [];
beforeEach(async () => {
  resetStoreRpc(probe); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  now = 1000; reduce = false; id = 0; frames.clear(); listeners.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.set(++id, f); return id; });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduce }), addEventListener: (k: string, fn: () => void) => listeners.set(k, fn), removeEventListener: (k: string) => listeners.delete(k) });
  chat = await initStore(probe); chat.activeId = 'S'; chat.running = true;
  chat.messages = [0, 1, 2].map(i => ({ id: 'U' + i, role: 'user', parts: [{ type: 'text', value: '问题' + i }], createdAt: i }));
});
afterEach(async () => { for (const s of runs.splice(0)) s.unmount(); await nextTick(); frames.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function frame() { const jobs = [...frames.values()]; frames.clear(); for (const f of jobs) f(now); await nextTick(); }
async function settle() { await nextTick(); await nextTick(); await frame(); await frame(); }
async function stage(inline = false) {
  const props = reactive({ narrow: false });
  const s = await runSetup<any>(file, props, effectScope(), { inlineTemplate: inline }); runs.push(s);
  const render = () => all(s.bindings({}, []));
  const scroll = inline ? render().find(n => n.props?.class === 'scroll')! : null;
  const writes: number[] = []; let top = 900;
  const el = markRaw({ scrollHeight: 1000, clientHeight: 100, offsetWidth: 800, clientWidth: 784,
    get scrollTop() { return top; }, set scrollTop(v: number) { writes.push(v); top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)); },
    getBoundingClientRect: () => ({ right: 800 }), querySelector: vi.fn(() => ({ scrollIntoView: vi.fn() })),
    scrollTo: vi.fn((o: ScrollToOptions) => { el.scrollTop = Number(o.top); }),
  });
  if (inline) (scroll!.ref as any).r.value = el; else s.bindings.scroller.value = el;
  const b = s.bindings;
  const event = (method: string, arg: any) => inline ? scroll!.props![method](arg) : b[method](arg);
  const wheel = (deltaY: number) => event(inline ? 'onWheelPassive' : 'onWheel', { deltaY });
  const position = (v: number) => { top = v; inline ? scroll!.props!.onScroll() : b.onScroll(); };
  const content = () => inline ? render().find(n => (n.type as any)?.name?.endsWith('LiveTurn.vue'))!.props!.onContent() : b.stickBottom();
  const button = () => render().find(n => n.type === 'button' && n.props?.['aria-label'] === '回到底部');
  return { s, b, props, el, writes, wheel, position, content, render, button, event, top: () => top };
}

describe('N05b following only changes on user intent', () => {
  it('程序贴底后又长200px，scroll到达仍跟随；无用户事件不读位置', async () => {
    const v = await stage(); v.content(); await settle(); v.writes.length = 0;
    v.el.scrollHeight += 200; v.b.onScroll(); expect(v.b.following.value).toBe(true);
    expect(v.b.backVisible.value).toBe(false); v.content(); await settle(); expect(v.writes).toEqual([1200]);
  });
  it('向上只翻一格立即停，已排双帧也不能拉回；向下到120以内恢复', async () => {
    const v = await stage(); v.content(); await nextTick(); await frame();
    v.wheel(-1); expect(v.b.following.value).toBe(false); v.position(899); await frame(); expect(v.writes).toEqual([]);
    v.content(); await settle(); expect(v.writes).toEqual([]);
    v.wheel(1); v.position(890); expect(v.b.following.value).toBe(true); v.content(); await settle(); expect(v.writes).toEqual([1000]);
  });
  for (const [up, down] of [['PageUp', 'End'], ['ArrowUp', 'ArrowDown'], ['Home', 'PageDown']]) it(up + ' 停，' + down + ' 恢复', async () => {
    const v = await stage(); v.b.onScrollKey({ key: up }); expect(v.b.following.value).toBe(false); v.position(850); expect(v.b.following.value).toBe(false);
    v.b.onScrollKey({ key: down }); v.position(890); expect(v.b.following.value).toBe(true);
  });
  it('600ms内向下可恢复，过期程序scroll不恢复，新的输入重新开窗口', async () => {
    const v = await stage(); v.wheel(-1); v.position(500); v.wheel(1); now += 599; v.position(770); expect(v.b.following.value).toBe(false);
    now += 2; v.position(900); expect(v.b.following.value).toBe(false);
    v.wheel(1); v.position(890); expect(v.b.following.value).toBe(true);
    now += 601; v.el.scrollHeight += 200; v.b.onScroll(); expect(v.b.following.value).toBe(true);
  });
  it('滚动条按下待判方向，上移才停，按住超过窗口仍可拖回底部；无关释放不算输入', async () => {
    const v = await stage(); v.b.onScrollPointer({ target: v.el, button: 0, clientX: 795 }); expect(v.b.following.value).toBe(true);
    v.position(850); expect(v.b.following.value).toBe(false);
    v.position(500); now += 900; v.position(890); expect(v.b.following.value).toBe(true);
    v.position(500); expect(v.b.following.value).toBe(false); v.b.endScrollPointer();
    now += 601; v.b.endScrollPointer(); v.position(900); expect(v.b.following.value).toBe(false);
  });
  it('恢复后的600ms窗口内再长200px，程序scroll仍跟随且按钮不出现', async () => {
    const v = await stage(); v.wheel(-1); v.position(850); expect(v.b.following.value).toBe(false);
    v.wheel(1); v.position(890); expect(v.b.following.value).toBe(true);
    now += 100; v.el.scrollHeight += 200; v.b.onScroll(); expect(v.b.following.value).toBe(true); expect(v.b.backVisible.value).toBe(false);
    v.content(); await settle(); expect(v.writes).toEqual([1200]);
    v.el.scrollHeight += 200; v.b.onScroll(); expect(v.b.following.value).toBe(true); expect(v.b.backVisible.value).toBe(false);
    v.content(); await settle(); expect(v.writes).toEqual([1200, 1400]);
  });
  it('拖条只在scrollTop变小时取消，未移动和向下的程序scroll不会取消', async () => {
    const v = await stage(); v.b.onScrollPointer({ target: v.el, button: 0, clientX: 795 });
    v.b.onScroll(); expect(v.b.following.value).toBe(true);
    v.el.scrollHeight += 200; v.b.onScroll(); expect(v.b.following.value).toBe(true);
    v.position(1000); expect(v.b.following.value).toBe(true);
    v.position(990); expect(v.b.following.value).toBe(false); // 只上移10px，仍在近底区
    v.position(1090); expect(v.b.following.value).toBe(true);
    v.el.scrollHeight += 400; v.b.onScroll(); expect(v.b.following.value).toBe(true);
    v.position(1200); expect(v.b.following.value).toBe(true); // 向下但尚远，不能按距离取消
    v.position(1199); expect(v.b.following.value).toBe(false);
    v.position(1490); expect(v.b.following.value).toBe(true);
    v.b.endScrollPointer(); now += 601; v.el.scrollHeight += 200; v.b.onScroll(); expect(v.b.following.value).toBe(true);
  });
  it('End恢复后主动补双帧贴底，按钮行消失改变视口也不留空隙', async () => {
    const v = await stage(); v.el.scrollHeight = 2000; v.wheel(-1); v.position(1400); expect(v.b.following.value).toBe(false);
    v.b.onScrollKey({ key: 'End' }); v.position(1810); expect(v.b.following.value).toBe(true);
    v.el.clientHeight = 150; // 回底按钮行隐藏，滚动区增高
    await settle(); expect(v.writes).toEqual([2000]); expect(v.el.scrollHeight - v.top() - v.el.clientHeight).toBe(0);
  });
  it('正文点击和非左键不会被当成拖滚动条', async () => {
    const v = await stage(); for (const e of [{ target: v.el, button: 0, clientX: 200 }, { target: {}, button: 0, clientX: 795 }, { target: v.el, button: 2, clientX: 795 }]) v.b.onScrollPointer(e);
    v.position(850); expect(v.b.following.value).toBe(true);
  });
  it('触摸上翻即停，反向拖回近底恢复；无位移和零滚轮不改变意图', async () => {
    const v = await stage(); v.b.onTouchStart({ touches: [{ clientY: 100 }] }); v.b.onTouchMove({ touches: [{ clientY: 120 }] });
    expect(v.b.following.value).toBe(false); v.position(850); expect(v.b.following.value).toBe(false);
    v.b.onTouchMove({ touches: [{ clientY: 90 }] }); v.position(890); expect(v.b.following.value).toBe(true);
    v.wheel(0); v.b.onTouchMove({ touches: [{ clientY: 90 }] }); expect(v.b.following.value).toBe(true);
  });
  it('编辑框、修饰键和输入法按键不夺走跟随状态', async () => {
    const v = await stage(); for (const e of [{ target: { closest: () => ({}) } }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) v.b.onScrollKey({ key: 'Home', ...e });
    expect(v.b.following.value).toBe(true);
  });
});

describe('N05b Q11b navigation and existing bottom triggers', () => {
  it('跳转全程拒绝排队和新增贴底，scroll延长保护，结束按历史位置判断', async () => {
    const v = await stage(); v.wheel(1); v.content(); await nextTick(); await frame(); v.b.jumpTurn('U0');
    v.position(850); await frame(); expect(v.writes).toEqual([]); v.content(); await settle(); expect(v.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(199); v.position(0); await vi.advanceTimersByTimeAsync(199);
    v.content(); await settle(); expect(v.writes).toEqual([]); await vi.advanceTimersByTimeAsync(1);
    expect(v.b.following.value).toBe(false); v.content(); await settle(); expect(v.writes).toEqual([]);
    expect(v.el.querySelector).toHaveBeenCalledWith('[data-turn-id="U0"]');
  });
  it('原地实时导航以起跳高度判断，增长收尾补贴底', async () => {
    const v = await stage(); v.b.jumpTurn('live'); v.el.scrollHeight += 200;
    await vi.advanceTimersByTimeAsync(200); await settle(); expect(v.b.following.value).toBe(true); expect(v.writes).toEqual([1200]);
  });
  for (const name of ['messages', 'tools', 'permission-add', 'permission-remove', 'notice-add', 'notice-remove', 'narrow-on', 'narrow-off']) it(name + ' 保留贴底', async () => {
    const v = await stage();
    if (name === 'permission-remove') chat.pendingPerms = [{ requestId: 'P', sessionId: 'S' } as any];
    if (name === 'notice-remove') chat.pendingPerms = [{ requestId: 'P', sessionId: 'B' } as any];
    if (name === 'narrow-off') v.props.narrow = true;
    await settle(); v.writes.length = 0; v.el.scrollHeight = 1200;
    if (name === 'messages') chat.messages.push({ id: 'A', role: 'assistant', parts: [] } as any);
    if (name === 'tools') chat.toolCards.push({ toolUseId: 'T' } as any);
    if (name === 'permission-add') chat.pendingPerms = [{ requestId: 'P', sessionId: 'S' } as any];
    if (name === 'notice-add') chat.pendingPerms = [{ requestId: 'P', sessionId: 'B' } as any];
    if (name.endsWith('-remove')) chat.pendingPerms = [];
    if (name === 'narrow-on') v.props.narrow = true;
    if (name === 'narrow-off') v.props.narrow = false;
    await settle(); expect(v.writes).toEqual([1200]);
  });
});

describe('N05b actual template button and event wiring', () => {
  for (const reduced of [false, true]) it('阈值与点击回底，reduced=' + reduced, async () => {
    reduce = reduced; const v = await stage(true);
    v.el.scrollHeight = 2000; v.position(0); expect(v.button()).toBeUndefined();
    v.wheel(-1); v.position(1900 - 120); expect(v.button()).toBeUndefined();
    v.position(1900 - 121); const button = v.button()!; expect(button).toBeDefined(); expect(button.props!.type).toBe('button');
    button.props!.onClick(); await nextTick(); expect(v.el.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: reduced ? 'auto' : 'smooth' });
    expect(v.button()).toBeUndefined(); v.el.scrollHeight = 2200; v.content(); await settle(); expect(v.writes.at(-1)).toBe(2200);
  });
  it('模板接通按键、触摸、滚动条入口，按钮在取消跟随后才渲染', async () => {
    const v = await stage(true); expect(v.render().find(n => n.props?.class === 'scroll')!.props!.tabindex).toBe('0');
    v.event('onKeydown', { key: 'Home' }); v.position(0); expect(v.button()).toBeDefined();
    v.event('onKeydown', { key: 'End' }); v.position(900); expect(v.button()).toBeUndefined();
    v.event('onTouchstartPassive', { touches: [{ clientY: 10 }] }); v.event('onTouchmovePassive', { touches: [{ clientY: 20 }] }); v.position(0); expect(v.button()).toBeDefined();
    v.wheel(1); v.position(900); v.event('onPointerdown', { target: v.el, button: 0, clientX: 795 }); v.position(0); expect(v.button()).toBeDefined();
  });
  it('底部观察器覆盖取消后内容增长，挂载/卸载清理观察器及窗口释放监听', async () => {
    let notify!: (e: any[]) => void; const observe = vi.fn(), disconnect = vi.fn();
    const ctor = vi.fn(function(this: any, callback: typeof notify, options: any) { notify = callback; this.observe = observe; this.disconnect = disconnect; expect(options.rootMargin).toBe('0px 0px 120px 0px'); });
    vi.stubGlobal('IntersectionObserver', ctor);
    const v = await stage(); const anchor = {}; v.b.bottomAnchor.value = anchor; v.s.mount(); expect(observe).toHaveBeenCalledWith(anchor);
    notify([{ isIntersecting: false }]); expect(v.b.backVisible.value).toBe(false);
    v.wheel(-1); expect(v.b.backVisible.value).toBe(false); notify([{ isIntersecting: false }]); expect(v.b.backVisible.value).toBe(true);
    notify([{ isIntersecting: true }]); expect(v.b.backVisible.value).toBe(false);
    expect(listeners.size).toBe(2); v.s.unmount(); runs.splice(runs.indexOf(v.s), 1); expect(disconnect).toHaveBeenCalledOnce(); expect(listeners.size).toBe(0);
  });
});