import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, markRaw, nextTick } from 'vue';
import { join } from 'node:path';
const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on, onLost: probe.lost, connect: probe.connect } }));
import { initStore, resetStoreRpc } from './renderer-store-fixture';
import { runSetup } from './sfc-setup';
const runs: { unmount(): void }[] = [];
beforeEach(() => resetStoreRpc(probe));
afterEach(() => { runs.splice(0).forEach(r => r.unmount());vi.unstubAllGlobals(); });

describe('N25 thought layout preserves following intent', () => {
  it.each(['following', 'cancelled', 'switch', 'resumed'] as const)('live replacement anchor is guarded: %s', async mode => {
    const chat = await initStore(probe);chat.activeId = 'S';chat.running = false;
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const s = await runSetup<any>(join(__dirname, '../src/renderer/src/ui/StageChat.vue'), {}, effectScope());runs.push(s);
    let top = 52, live = true;const block = { textContent: 'same paragraph', tagName: 'P', getBoundingClientRect: () => ({ top, bottom: top + 32 }) };
    const el = markRaw({ scrollTop: 2000, scrollHeight: 4000, clientHeight: 700, getBoundingClientRect: () => ({ top: 40, bottom: 740 }), querySelector: () => live ? {} : null, querySelectorAll: () => [block] });
    s.bindings.scroller.value = el;await nextTick();
    if(mode !== 'following')s.bindings.onWheel({ deltaY: -1 });
    chat.messages = [{ id: 'A', role: 'assistant', parts: [{ type: 'text', value: 'same paragraph' }] }];
    top = 86;live = false;
    if(mode === 'switch')chat.activeId = 'B';
    if(mode === 'resumed')s.bindings.following.value = true;
    await nextTick();expect(el.scrollTop).toBe(mode === 'cancelled' ? 2034 : 2000);
    expect(s.bindings.following.value).toBe(mode === 'following' || mode === 'resumed');
  });
  it('content-height observation during thought animation keeps bottom following and never resumes cancelled following', async () => {
    await initStore(probe);const callbacks: (() => void)[] = [],observed: unknown[] = [],frames: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { callbacks.push(cb); } observe(el: unknown) { observed.push(el); } disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb);return frames.length; });
    const s = await runSetup<any>(join(__dirname, '../src/renderer/src/ui/StageChat.vue'), {}, effectScope());runs.push(s);
    const child = {},el = markRaw({ firstElementChild: child, scrollTop: 1000, scrollHeight: 1700, clientHeight: 700 });
    s.bindings.scroller.value = el;await nextTick();expect(observed).toEqual([el, child]);
    el.scrollHeight = 1900;callbacks[0]();await nextTick();while(frames.length)frames.shift()!();expect(el.scrollTop).toBe(1900);expect(s.bindings.following.value).toBe(true);
    s.bindings.onWheel({ deltaY: -1 });el.scrollTop = 500;el.scrollHeight = 2100;callbacks[0]();await nextTick();while(frames.length)frames.shift()!();expect(el.scrollTop).toBe(500);expect(s.bindings.following.value).toBe(false);
  });
});
