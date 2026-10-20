import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, watch, type VNode } from 'vue';
import { join } from 'node:path';
const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on, onLost: probe.lost, connect: probe.connect } }));
import { initStore, resetStoreRpc } from './renderer-store-fixture';
import { runSetup } from './sfc-setup';
const UI = join(__dirname, '../src/renderer/src/ui');
const nodes = (v: any): VNode[] => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === 'object' && 'type' in v ? [v, ...nodes(v.children)] : [];
beforeEach(() => { resetStoreRpc(probe); vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(100000); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const event = (key: string, extra = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 0, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra });
async function composer() {
  const chat = await initStore(probe); chat.activeId = 'A'; chat.skills = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }] as any;
  chat.messages = [{ id: 'M', role: 'user', parts: [{ type: 'text', value: 'history' }] }];
  const s = await runSetup<any>(join(UI, 'Composer.vue'), {}, effectScope());
  s.bindings.atFiles.value = ['alpha.ts', 'another.ts'];
  const field = { value: '', selectionStart: 0, focus: vi.fn(), setSelectionRange: vi.fn() };
  s.bindings.field.value = field;
  const text = async (value: string, caret = value.length) => { field.value = value; field.selectionStart = caret; s.bindings.text.value = value; s.bindings.syncAt(); await nextTick(); };
  return { chat, s, b: s.bindings, field, text };
}
describe('U1 Composer escape and IME', () => {
  for (const kind of ['slash', 'at']) it(kind + ' Esc stays closed after keyup, unchanged token and click; edits reopen', async () => {
    const { s, b, text } = await composer();
    try {
      const open = kind === 'slash' ? b.slashOpen : b.atOpen;
      await text(kind === 'slash' ? '/' : '@'); expect(open.value).toBe(true);
      const e = event('Escape'); b.closeMenus(e); b.syncAt(); await nextTick(); expect(open.value).toBe(false); expect(e.preventDefault).toHaveBeenCalledOnce();
      b.syncAt(); await nextTick(); expect(open.value).toBe(false);
      await text(kind === 'slash' ? '/a' : '@a'); expect(open.value).toBe(true);
      b.closeMenus(event('Escape')); await text(kind === 'slash' ? '/' : '@'); expect(open.value).toBe(true);
    } finally { s.unmount(); }
  });
  it('@ identical query in a different token reopens; no open menu means Esc does nothing', async () => {
    const { s, b, text } = await composer();
    try {
      await text('@a @a', 2); b.closeMenus(event('Escape')); b.syncAt(); expect(b.atOpen.value).toBe(false);
      await text('@a @a', 5); expect(b.atOpen.value).toBe(true);
      await text('plain'); const e = event('Escape'); b.closeMenus(e); expect(e.preventDefault).not.toHaveBeenCalled(); expect(e.stopPropagation).not.toHaveBeenCalled();
    } finally { s.unmount(); }
  });
  for (const mechanism of ['isComposing', '229']) for (const menu of ['slash', 'at', 'history']) for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'Escape', 'Enter', 'CtrlEnter']) {
    it('IME ' + mechanism + ' ' + menu + ' ' + key + ' has no side effects', async () => {
      const { s, b, text } = await composer();
      try {
        await text(menu === 'slash' ? '/' : menu === 'at' ? '@' : '');
        b.menuIndex.value = 1;
        const before = [b.text.value, b.menuIndex.value, b.histCursor.value, b.slashOpen.value, b.atOpen.value];
        const e = event(key, mechanism === 'isComposing' ? { isComposing: true } : { keyCode: 229 });
        if (key === 'ArrowUp' || key === 'ArrowDown') b.onNav(key === 'ArrowUp' ? -1 : 1, e);
        else if (key === 'Tab') b.onTab(e); else if (key === 'Escape') b.closeMenus(e); else if (key === 'CtrlEnter') b.onQueueKey(e); else b.onEnter(e);
        expect([b.text.value, b.menuIndex.value, b.histCursor.value, b.slashOpen.value, b.atOpen.value]).toEqual(before);
        expect(e.preventDefault).not.toHaveBeenCalled(); expect(probe.call.mock.calls.filter(c => c[0] === 'chat.prompt')).toEqual([]);
      } finally { s.unmount(); }
    });
  }
  it('compiled textarea listeners route keyboard events through the same guards', async () => {
    await initStore(probe);
    const s = await runSetup<(ctx: object, cache: unknown[]) => VNode>(join(UI, 'Composer.vue'), {}, effectScope(), { inlineTemplate: true });
    try {
      const field = nodes(s.bindings({}, [])).find(n => n.type === 'textarea')!;
      for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'Escape', 'Enter']) {
        const e = event(key, { isComposing: true });
        for (const fn of field.props!.onKeydown) fn(e);
        expect(e.preventDefault).not.toHaveBeenCalled();
      }
    } finally { s.unmount(); }
  });
});

describe('U1 permission card accessibility and keyboard scope', () => {
  const perm = { requestId: 'R:a/b', detail: 'C:/synthetic/a.txt', kind: 'file-write', toolTitle: '合成写入', deadlineMs: 190000, riskClass: 'danger' };
  it('named region, linked button descriptions, polite announcement and timer at ten-second boundaries', async () => {
    await initStore(probe);
    const s = await runSetup<(ctx: object, cache: unknown[]) => VNode>(join(UI, 'PermCard.vue'), { perm }, effectScope(), { inlineTemplate: true });
    try {
      const render = () => nodes(s.bindings({}, []));
      const root = render().find(n => n.props?.role === 'region')!;
      expect(root.props?.tabindex).toBe('-1');
      for (const attr of ['aria-labelledby', 'aria-describedby']) expect(render().some(n => n.props?.id === root.props![attr])).toBe(true);
      const buttons = render().filter(n => n.type === 'button');
      expect(buttons.map(n => n.props?.['aria-label'])).toEqual(['允许：请求写入文件', '本会话允许：请求写入文件', '拒绝：请求写入文件']);
      expect(buttons.every(n => n.props?.['aria-describedby'] === root.props?.['aria-describedby'])).toBe(true);
      expect(render().filter(n => n.props?.['aria-live'] === 'polite')).toHaveLength(2);
      const spoken = () => render().find(n => n.props?.role === 'timer')!.children;
      const seen: unknown[] = [spoken()];
      for (let second = 1; second <= 9; second++) { vi.advanceTimersByTime(1000); seen.push(spoken()); }
      expect(new Set(seen)).toEqual(new Set(['剩余约 90 秒']));
      vi.advanceTimersByTime(1000); expect(spoken()).toBe('剩余约 80 秒');
      expect(root.props?.onKeydown).toBeTypeOf('function'); expect(root.props?.onKeydown?.withKeys).toBeUndefined();
    } finally { s.unmount(); }
  });
  for (const inside of [false, true]) for (const connection of ['ok', 'reconnecting', 'lost'] as const) it('Esc scope=' + inside + ' connection=' + connection, async () => {
    const chat = await initStore(probe); chat.connection = connection;
    const respond = vi.spyOn(chat, 'respondPerm').mockResolvedValue(undefined as any);
    const active = {}; vi.stubGlobal('document', { activeElement: active });
    const s = await runSetup<any>(join(UI, 'PermCard.vue'), { perm }, effectScope());
    try {
      s.bindings.card.value = { contains: (el: unknown) => inside && el === active };
      const e = event('Escape'); s.bindings.onEscape(e);
      expect(respond.mock.calls).toEqual(inside && connection === 'ok' ? [[perm.requestId, 'deny']] : []);
      expect(e.preventDefault).toHaveBeenCalledTimes(inside && connection === 'ok' ? 1 : 0);
    } finally { s.unmount(); }
  });
  it('mount announces approval without focusing editable elements; otherwise focuses container', async () => {
    await initStore(probe);
    for (const editable of [true, false]) {
      vi.stubGlobal('document', { activeElement: { matches: () => editable, isContentEditable: false, closest: () => null } });
      const s = await runSetup<any>(join(UI, 'PermCard.vue'), { perm }, effectScope());
      const focus = vi.fn(); s.bindings.card.value = { focus };
      try { s.mount(); await nextTick(); expect(focus).toHaveBeenCalledTimes(editable ? 0 : 1); expect(s.bindings.announcement.value).toBe('需要你的批准：请求写入文件'); } finally { s.unmount(); }
    }
  });
});

describe('U1b permissions preserve each kind of editable focus', () => {
  for (const kind of ['input', 'select', 'contenteditable', 'textbox']) {
    it('mount keeps document.activeElement inside ' + kind, async () => {
      await initStore(probe);
      const textbox = { role: 'textbox' };
      const tag = kind === 'input' ? 'input' : kind === 'select' ? 'select' : 'span';
      const active = {
        tagName: tag.toUpperCase(),
        isContentEditable: kind === 'contenteditable',
        matches: (selector: string) => selector.split(',').some(s => s.trim() === tag),
        closest: (selector: string) => kind === 'textbox' && selector === '[role="textbox"]' ? textbox : null,
      };
      const doc: { activeElement: unknown } = { activeElement: active };
      vi.stubGlobal('document', doc);
      const card = { focus: vi.fn(() => { doc.activeElement = card; }) };
      const s = await runSetup<any>(join(UI, 'PermCard.vue'), { perm: { requestId: 'editable-' + kind, kind: 'file-write', detail: 'C:/synthetic/a.txt', toolTitle: '合成写入' } }, effectScope());
      s.bindings.card.value = card;
      try {
        s.mount(); await nextTick();
        expect(doc.activeElement).toBe(active);
        expect(card.focus).not.toHaveBeenCalled();
        expect(s.bindings.announcement.value).toBe('需要你的批准：请求写入文件');
      } finally { s.unmount(); }
    });
  }
});
