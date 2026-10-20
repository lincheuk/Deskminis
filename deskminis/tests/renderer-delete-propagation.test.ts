/** F11B · 渲染端：删除确认说明删除范围、保留副本的入口、被对端删掉时切走、文档（设计 §4.13、§7.2 的 U1–U7）。
 *
 *  U1 纯函数与文案；U2 NavRail 的 <script setup> 真跑（rpc 是桩）加模板位置守卫；U2b / U3 / U4 store 真跑；
 *  U5 / U7 设备页真渲染一遍看渲出来的字，加源码守卫；U6 文档守卫。
 *
 *  要钉住的错法：设备列表还没拉回来（或拉失败）时把范围说成「只影响这台」；local 文案承诺做不到的「只删本机」；
 *  界面停在一个已不存在的会话上；恢复、彻底删除接错方法；文档还写着「删除不同步」。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import * as vue from 'vue';

const { rpcCallMock, handlers } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
  handlers: new Map<string, (p: any) => void>(),
}));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: rpcCallMock,
    connect: async () => {},
    on: (method: string, h: (p: any) => void) => { handlers.set(method, h); },
    off: () => {},
    onLost: vi.fn(),
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import { DELETE_SCOPE_TEXT, PAIRING_DELETE_NOTE, deleteScope, retainedSummary, type DeviceListState } from '../src/renderer/src/lib/devices/delete-scope';
// eslint-disable-next-line import/first
import type { RetainedSession } from '../src/shared/types';
// eslint-disable-next-line import/first
import { renderSfc, runSetup, visibleText } from './sfc-setup';
// eslint-disable-next-line import/first
import { sfcBlocks } from './sfc-blocks';
// eslint-disable-next-line import/first
import { stripComments } from './strip-comments';
import { seedDeletion, deletionSentinels } from './renderer-store-deletion';
import { settleStore } from './renderer-store-fixture';

const root = path.resolve(__dirname, '..');
const NAV_FILE = path.join(root, 'src/renderer/src/ui/NavRail.vue');
const DEVICES_FILE = path.join(root, 'src/renderer/src/ui/StageDevices.vue');

/** 桩的可控部分。 */
let sessions: Array<{ id: string; title: string }>;
/** remote.status 怎么答：值、挂着不回的 Promise、或 Error（抛）。 */
let remoteStatus: () => unknown;
let controlStatus: () => unknown;
let listRetained: () => unknown;
/** chat.sessions.purgeRetained 怎么答：值，或 Error（抛）。 */
let purgeRetained: () => unknown;

function stubRpc(): void {
  rpcCallMock.mockImplementation(async (method: string) => {
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return sessions;
    if (method === 'provider.instances.list') return [];
    if (method === 'provider.getDefault') return {};
    if (method === 'modelgroup.list') return [];
    if (method === 'assistants.list') return [];
    if (method === 'skills.list') return [];
    if (method === 'chat.messages.list') return [];
    if (method === 'chat.annotations.list') return { annotations: [] };
    if (method === 'workspace.get') return { root: '/w', isDefault: true };
    if (method === 'control.status') { const r = controlStatus(); if (r instanceof Error) throw r; return r; }
    if (method === 'remote.status') { const r = remoteStatus(); if (r instanceof Error) throw r; return r; }
    if (method === 'chat.sessions.listRetained') { const r = listRetained(); if (r instanceof Error) throw r; return r; }
    if (method === 'chat.sessions.purgeRetained') { const r = purgeRetained(); if (r instanceof Error) throw r; return r; }
    if (method === 'chat.sessions.restore' || method === 'chat.sessions.delete') return { ok: true };
    return undefined;
  });
}
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const callsOf = (method: string): unknown[] => rpcCallMock.mock.calls.filter(c => c[0] === method).map(c => c[1]);
const device = (fp: string, name = '书房的电脑') => ({ peerFingerprint: fp, peerName: name, roomId: 'r', createdAt: 1, online: true, lastSeenAt: 1 });
const kept = (over: Partial<RetainedSession> = {}): RetainedSession => ({
  id: 'R1', title: '周报草稿', deletedBy: 'aabbccddeeff', deletedAt: 1, retainedAt: 2, messageCount: 5, unseenCount: 2, annotationCount: 0, ...over,
});

let scope = vue.effectScope();
beforeEach(() => {
  rpcCallMock.mockReset();
  handlers.clear();
  setActivePinia(createPinia());
  sessions = [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
  remoteStatus = () => ({ devices: [] });
  controlStatus = () => ({ syncPaused: false });
  listRetained = () => [];
  purgeRetained = () => ({ ok: true });
  stubRpc();
  scope = vue.effectScope();
});
afterEach(() => { scope.stop(); vi.restoreAllMocks(); });

describe('U1 deleteScope 与文案', () => {
  it('真值表：没有设备时只有本次刷新成功才说「只影响这台」；有设备时不看刷新状态', () => {
    const lists: DeviceListState[] = ['checking', 'fresh', 'failed'];
    for (const paused of [false, true]) {
      expect(lists.map(l => deleteScope(0, paused, l))).toEqual(['checking', 'local', 'unknown']);
      expect(lists.map(l => deleteScope(2, paused, l))).toEqual(lists.map(() => (paused ? 'paused' : 'propagate')));
    }
  });

  it('文案：local 不承诺「只删这台设备上的」；unknown 按会传播说；配对入口的说明', () => {
    expect(DELETE_SCOPE_TEXT.local).toContain('现在没有已配对的设备');
    expect(DELETE_SCOPE_TEXT.local).toContain('以后配对');
    expect(DELETE_SCOPE_TEXT.local).toContain('也会被删除');
    expect(DELETE_SCOPE_TEXT.local).not.toContain('只删这台设备上的');
    expect(DELETE_SCOPE_TEXT.unknown).toContain('没能确认');
    expect(DELETE_SCOPE_TEXT.unknown).toContain('也会删除');
    expect(DELETE_SCOPE_TEXT.checking).toContain('正在确认');
    expect(DELETE_SCOPE_TEXT.paused).toContain('同步已暂停');
    expect(DELETE_SCOPE_TEXT.propagate).toContain('旧版本');
    expect(DELETE_SCOPE_TEXT.propagate).toContain('已配对的设备也会删除');
    for (const part of ['配对后', '已经删除的会话', '也会被删除', '留下']) expect(PAIRING_DELETE_NOTE).toContain(part);
    expect(Object.keys(DELETE_SCOPE_TEXT).sort()).toEqual(['checking', 'local', 'paused', 'propagate', 'unknown']);
  });

  it('retainedSummary：条数已知、无法确认、带本机标注', () => {
    expect(retainedSummary({ messageCount: 5, unseenCount: 2, annotationCount: 0 })).toBe('5 条消息，其中 2 条对方没见过');
    expect(retainedSummary({ messageCount: 5, unseenCount: null, annotationCount: 0 })).toBe('5 条消息，无法确认对方是否全部见过');
    expect(retainedSummary({ messageCount: 3, unseenCount: 0, annotationCount: 2 })).toBe('3 条消息，其中 0 条对方没见过，2 条本机标注');
  });
});

describe('U2 NavRail：删除确认里的范围说明', () => {
  interface NavBindings { confirmDelete: vue.Ref<string>; deviceList: vue.Ref<DeviceListState>; deleteScopeNote: vue.ComputedRef<string> }
  async function nav(): Promise<{ chat: ReturnType<typeof useChat>; b: NavBindings }> {
    // NavRail 的 setup 里有一个每分钟的定时器，测试里不让它真挂上
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    const chat = useChat();
    const { bindings } = await runSetup<NavBindings>(NAV_FILE, { view: 'chat' }, scope);
    return { chat, b: bindings };
  }
  const confirm = async (b: NavBindings, id: string): Promise<void> => { b.confirmDelete.value = id; await vue.nextTick(); await tick(); await tick(); };

  it('刷新成功且没有设备 → 只影响这台；有设备 → 会传播；暂停 → 恢复后传播', async () => {
    const { b } = await nav();
    await confirm(b, 'A');
    expect(b.deleteScopeNote.value).toBe(DELETE_SCOPE_TEXT.local);

    remoteStatus = () => ({ devices: [device('aabbccddeeff')] });
    await confirm(b, '');
    await confirm(b, 'A');
    expect(b.deleteScopeNote.value).toBe(DELETE_SCOPE_TEXT.propagate);

    controlStatus = () => ({ syncPaused: true });
    await confirm(b, '');
    await confirm(b, 'B');
    expect(b.deleteScopeNote.value).toBe(DELETE_SCOPE_TEXT.paused);
  });

  it('刷新还没回来 → 「正在确认」，不说只影响这台；回来之后才定', async () => {
    let release!: (v: unknown) => void;
    remoteStatus = () => new Promise(r => { release = r; });
    const { b } = await nav();
    await confirm(b, 'A');
    expect(b.deviceList.value).toBe('checking');
    expect(b.deleteScopeNote.value).toBe(DELETE_SCOPE_TEXT.checking);
    release({ devices: [] });
    await tick(); await tick();
    expect(b.deleteScopeNote.value).toBe(DELETE_SCOPE_TEXT.local);
  });

  it('刷新失败、或应答不是设备表 → 「没能确认」，不吞成只影响这台', async () => {
    for (const bad of [new Error('remote.status 失败'), undefined, {}]) {
      remoteStatus = () => bad;
      const { b } = await nav();
      await confirm(b, 'A');
      expect(b.deviceList.value, String(bad)).toBe('failed');
      expect(b.deleteScopeNote.value).toBe(DELETE_SCOPE_TEXT.unknown);
      scope.stop(); scope = vue.effectScope();
      setActivePinia(createPinia());
    }
  });

  it('上一次确认的结果不沿用：每次进确认态都重新确认；别的行迟到的结果不盖过当前行', async () => {
    const { b } = await nav();
    await confirm(b, 'A');
    expect(b.deleteScopeNote.value).toBe(DELETE_SCOPE_TEXT.local);
    const before = callsOf('remote.status').length;
    // 换到 B 行：先回到「正在确认」，这次的刷新挂着
    let release!: (v: unknown) => void;
    remoteStatus = () => new Promise(r => { release = r; });
    b.confirmDelete.value = 'B';
    await vue.nextTick();
    expect(b.deviceList.value).toBe('checking');
    expect(callsOf('remote.status').length).toBe(before + 1);
    // 用户又切回 A 行；B 行那次刷新这时才失败，不该把 A 行判成失败
    const hung = release;
    remoteStatus = () => ({ devices: [] });
    b.confirmDelete.value = 'A';
    await vue.nextTick(); await tick(); await tick();
    expect(b.deviceList.value).toBe('fresh');
    hung({ notDevices: true });
    await tick(); await tick();
    expect(b.deviceList.value).toBe('fresh');
  });

  it('模板：说明句在「确认删除？」之后、取消与删除按钮之前；设备项的角标绑保留副本数；脚本不吞刷新失败', () => {
    const { template, script } = sfcBlocks(readFileSync(NAV_FILE, 'utf8'), NAV_FILE);
    const ask = template.indexOf('确认删除？此操作不可撤销。');
    const note = template.indexOf('{{ deleteScopeNote }}');
    const cancel = template.indexOf('@click.stop="cancelDelete(s.id)"');
    const del = template.indexOf('@click.stop="onDelete(s.id)"');
    expect(ask).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(ask);
    expect(cancel).toBeGreaterThan(note);
    expect(del).toBeGreaterThan(note);
    expect(template.match(/\{\{ deleteScopeNote \}\}/g)).toHaveLength(1);
    expect(template).toContain('@click.stop="confirmDelete = s.id"');
    expect(template).toMatch(/v-if="!props\.compact && chat\.retainedSessions\.length" class="cnt tnum">\{\{ chat\.retainedSessions\.length \}\}/);
    expect(template).toContain('有会话已在其他设备删除，本机保留了对方没见过的内容');

    const watchBody = script.slice(script.indexOf('watch(confirmDelete,'), script.indexOf('const deleteScopeNote'));
    expect(watchBody).toContain("deviceList.value = 'checking'");
    expect(watchBody).toMatch(/chat\.refreshDevices\(\)\.then\(/);
    expect(watchBody).toContain('chat.devicesLoaded');
    expect(watchBody.match(/deviceList\.value = 'failed'/g)!.length).toBeGreaterThanOrEqual(1);
    expect(script).not.toMatch(/refreshDevices\(\)\s*\.catch\(/);
    expect(script).toMatch(/deleteScope\(chat\.devices\.length, chat\.syncPaused, deviceList\.value\)/);
  });
});

describe('U2b store.refreshDevices：应答是不是设备表', () => {
  it('{ devices: [] } → devicesLoaded 为真；undefined 或 {} → 为假且 devices 为空；抛错 → reject，保持原值', async () => {
    const chat = useChat();
    expect(chat.devicesLoaded).toBe(false);
    await chat.refreshDevices();
    expect(chat.devicesLoaded).toBe(true);
    expect(chat.devices).toEqual([]);

    for (const bad of [undefined, {}]) {
      remoteStatus = () => bad;
      await chat.refreshDevices();
      expect(chat.devicesLoaded).toBe(false);
      expect(chat.devices).toEqual([]);
    }

    remoteStatus = () => ({ devices: [device('aabbccddeeff')] });
    await chat.refreshDevices();
    expect(chat.devicesLoaded).toBe(true);
    remoteStatus = () => new Error('断了');
    await expect(chat.refreshDevices()).rejects.toThrow('断了');
    expect(chat.devicesLoaded).toBe(true);
    expect(chat.devices).toHaveLength(1);
  });
});

describe('U3 store：会话生命周期广播', () => {
  async function started(active: string): Promise<ReturnType<typeof useChat>> {
    const chat = useChat();
    await chat.init();
    await chat.open(active);
    await tick();
    return chat;
  }
  const fire = async (p: Record<string, unknown>): Promise<void> => { handlers.get('chat.sessions.lifecycle')!(p); await tick(); await tick(); await tick(); };

  it('订阅了 chat.sessions.lifecycle；init 时拉一次保留副本', async () => {
    listRetained = () => [kept()];
    const chat = await started('A');
    expect(handlers.has('chat.sessions.lifecycle')).toBe(true);
    expect(handlers.has('chat.sessions.changed')).toBe(true);
    expect(chat.retainedSessions.map(r => r.id)).toEqual(['R1']);
  });

  it('当前会话被另一台设备删掉：落到列表第一个，并留一条事件条；保留副本重拉', async () => {
    const chat = await started('A');
    const before = callsOf('chat.sessions.listRetained').length;
    sessions = [{ id: 'B', title: 'B' }];
    listRetained = () => [kept({ id: 'A' })];
    await fire({ sessionId: 'A', kind: 'tombstone-applied', origin: 'remote', v: 1, byDevice: 'aabbccddeeff', retained: true });
    expect(chat.activeId).toBe('B');
    expect(chat.eventNotes.map(n => n.short)).toEqual(['刚才打开的会话已在另一台设备上删除']);
    expect(callsOf('chat.sessions.listRetained').length).toBe(before + 1);
    expect(chat.retainedSessions.map(r => r.id)).toEqual(['A']);
  });

  it('没有别的会话：落到欢迎页并清掉那组字段', async () => {
    const chat = await started('A');
    chat.lastError = '已取消'; chat.running = true; chat.streamingText = '半截';
    // 被删会话上一轮的「输出被截断」提示（F02）也不该带到欢迎页
    chat.lastOutputLimit = { cause: 'modelLimit' } as unknown as typeof chat.lastOutputLimit;
    sessions = [];
    await fire({ sessionId: 'A', kind: 'tombstone-applied', origin: 'remote', v: 1, byDevice: 'aabbccddeeff' });
    expect(chat.activeId).toBe('');
    expect(chat.messages).toEqual([]);
    expect(chat.lastError).toBe('');
    expect(chat.running).toBe(false);
    expect(chat.streamingText).toBe('');
    expect(chat.eventNotes).toEqual([]);
    expect(chat.lastOutputLimit).toBeNull();
  });

  it('源码守卫：落到欢迎页时清的字段与 deleteSession 的 else 分支是同一组（别的任务往那边加字段，这边不能落下）', async () => {
    // 两条路径从同一份穷尽state键的哨兵表开始，比较整份state。
    const results: unknown[] = [];
    for (const route of ['local', 'lifecycle'] as const) {
      setActivePinia(createPinia());
      const chat = useChat();
      sessions = [{ id: 'A', title: 'A' }];
      await chat.init();
      await settleStore();
      seedDeletion(chat);
      const defaults = useChat().$state;
      expect(Object.keys(defaults).sort()).toEqual(Object.keys(deletionSentinels).sort());
      sessions = [];
      // 本地删除不刷新保留副本；广播会刷新，后端返回同一份权威保留表。
      listRetained = () => structuredClone(deletionSentinels.retainedSessions);
      if (route === 'local') await chat.deleteSession('A');
      else await handlers.get('chat.sessions.lifecycle')!({ sessionId: 'A', kind: 'deleted', origin: 'remote', v: 1, byDevice: 'abcdef' });
      await settleStore();
      expect(chat.activeId).toBe('');
      expect(chat.messages).toEqual([]);
      results.push(JSON.parse(JSON.stringify(chat.$state)));
    }
    expect(results[1]).toEqual(results[0]);
  });

  it('本机（别的窗口）删掉当前会话：切走，但不加事件条', async () => {
    const chat = await started('A');
    sessions = [{ id: 'B', title: 'B' }];
    await fire({ sessionId: 'A', kind: 'deleted', origin: 'local', v: 1, byDevice: 'me' });
    expect(chat.activeId).toBe('B');
    expect(chat.eventNotes).toEqual([]);
  });

  it('不是当前会话、或这个会话还在列表里（恢复、清掉保留副本）：activeId 不变，保留副本照样重拉', async () => {
    const chat = await started('A');
    sessions = [{ id: 'A', title: 'A' }];
    for (const p of [
      { sessionId: 'B', kind: 'tombstone-applied', origin: 'remote', v: 1, byDevice: 'x' },
      { sessionId: 'A', kind: 'restore-applied', origin: 'remote', v: 2, byDevice: 'x' },
      { sessionId: 'Z', kind: 'purged', origin: 'local', v: 1, byDevice: 'me' },
      { sessionId: 'Z', kind: 'retained-released', origin: 'remote', v: 1, byDevice: 'x' },
    ]) {
      const before = callsOf('chat.sessions.listRetained').length;
      await fire(p);
      expect(chat.activeId).toBe('A');
      expect(callsOf('chat.sessions.listRetained').length).toBe(before + 1);
    }
    expect(chat.sessions.map(s => s.id)).toEqual(['A']);
  });

  it('旧引擎没有 listRetained（桩返回 undefined 或抛错）：置空，不报错', async () => {
    listRetained = () => [kept()];
    const chat = await started('A');
    expect(chat.retainedSessions).toHaveLength(1);
    listRetained = () => undefined;
    await chat.refreshRetained();
    expect(chat.retainedSessions).toEqual([]);
    listRetained = () => [kept()];
    await chat.refreshRetained();
    listRetained = () => new Error('未知方法: chat.sessions.listRetained');
    await chat.refreshRetained();
    expect(chat.retainedSessions).toEqual([]);
    // 畸形的广播不让 store 抛
    await fire(undefined as unknown as Record<string, unknown>);
    await fire({ kind: 'deleted' });
    expect(chat.activeId).toBe('A');
  });
});

describe('U4 store：恢复与彻底删除接对了方法', () => {
  it('restoreSession → chat.sessions.restore 带 confirm；purgeRetainedSession → chat.sessions.purgeRetained 带 confirm（不是通用的 chat.sessions.delete）；之后都重拉保留副本', async () => {
    const chat = useChat();
    await chat.restoreSession('R1');
    expect(callsOf('chat.sessions.restore')).toEqual([{ sessionId: 'R1', confirm: true }]);
    expect(callsOf('chat.sessions.delete')).toEqual([]);
    expect(callsOf('chat.sessions.listRetained')).toHaveLength(1);
    expect(callsOf('chat.sessions.list')).toHaveLength(1);
    await chat.purgeRetainedSession('R2');
    expect(callsOf('chat.sessions.purgeRetained')).toEqual([{ sessionId: 'R2', confirm: true }]);
    // 通用的删除分不出「清保留副本」与「删这个会话」：清单过期时它会把刚被恢复的会话在所有设备上再删一次
    expect(callsOf('chat.sessions.delete')).toEqual([]);
    expect(callsOf('chat.sessions.restore')).toHaveLength(1);
    expect(callsOf('chat.sessions.listRetained')).toHaveLength(2);
  });

  it('彻底删除被拒（它刚被别的设备恢复）：原因原样抛出，会话列表与保留副本都重拉，不改用别的方法重试', async () => {
    listRetained = () => [kept({ id: 'R2' })];
    const chat = useChat();
    await chat.refreshRetained();
    expect(chat.retainedSessions.map(r => r.id)).toEqual(['R2']);
    const refused = '这个会话已不是保留副本（它已被恢复，或并未被其他设备删除），没有删除任何内容';
    purgeRetained = () => new Error(refused);
    // 引擎那边它已经回到会话列表、不在保留清单里了
    sessions = [{ id: 'A', title: 'A' }, { id: 'R2', title: '周报草稿' }];
    listRetained = () => [];
    const listsBefore = callsOf('chat.sessions.list').length;

    await expect(chat.purgeRetainedSession('R2')).rejects.toThrow(refused);
    expect(callsOf('chat.sessions.purgeRetained')).toEqual([{ sessionId: 'R2', confirm: true }]);
    expect(callsOf('chat.sessions.delete')).toEqual([]);
    expect(callsOf('chat.sessions.list').length).toBe(listsBefore + 1);
    expect(chat.retainedSessions).toEqual([]);
    expect(chat.sessions.map(s => s.id)).toContain('R2');
  });
});

describe('U5 / U7 设备页', () => {
  const { template, script } = sfcBlocks(readFileSync(DEVICES_FILE, 'utf8'), DEVICES_FILE);

  it('真渲染：有保留副本时出现「已在其他设备删除」一节，每行有删除方、条数、两个按钮；没有时整节不出现', async () => {
    const chat = useChat();
    chat.devices = [device('aabbccddeeff')];
    chat.retainedSessions = [kept(), kept({ id: 'R2', title: '读书笔记', deletedBy: '112233445566', unseenCount: null, annotationCount: 3, messageCount: 8 })];
    const text = visibleText(await renderSfc(DEVICES_FILE, {}));
    expect(text).toContain('已在其他设备删除');
    expect(text).toContain('周报草稿');
    expect(text).toContain('由 书房的电脑 删除');
    expect(text).toContain('5 条消息，其中 2 条对方没见过');
    expect(text).toContain('读书笔记');
    // 删除方已不在配对表里：退回指纹
    expect(text).toContain('由 11 22 33 44 55 66 删除');
    expect(text).toContain('8 条消息，无法确认对方是否全部见过，3 条本机标注');
    expect(text.match(/恢复/g)!.length).toBeGreaterThanOrEqual(2);
    expect(text.match(/彻底删除/g)!.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('恢复会让它重新出现在所有已配对设备上；彻底删除后无法恢复。');

    chat.retainedSessions = [];
    const none = visibleText(await renderSfc(DEVICES_FILE, {}));
    expect(none).not.toContain('这些会话已在另一台设备上删除');
    expect(none.match(/已在其他设备删除/g) ?? []).toHaveLength(1); // 只剩「同步」卡片说明里提到的那一处
  });

  it('真渲染：两个配对入口旁各有一句配对后删除会补传的说明；「同步」卡片讲清暂停与解绑；被钉住的句子都在', async () => {
    useChat();
    const text = visibleText(await renderSfc(DEVICES_FILE, {}));
    expect(text.split(PAIRING_DELETE_NOTE)).toHaveLength(3);
    expect(text).toContain('以后再把它配回来');
    expect(text).toContain('暂停期间删除既不发出也不生效，恢复同步后补齐');
    expect(text).toContain('删除也会同步');
    expect(text).toMatch(/设置、记忆文件[^。]*不同步/);
    expect(text).toContain('MINISD_HOST');
    expect(text).toContain('进行中：会话在已配对设备之间自动同步。');
  });

  it('彻底删除被拒、那一行又已经不在清单里（刚被别的设备恢复）：原因带着标题显示在这一节外面，确认态收起；行还在时原因留在行内', async () => {
    interface DevBindings {
      retainNotice: vue.Ref<string>; retainErr: vue.Ref<Record<string, string>>; purging: vue.Ref<string>; retainBusy: vue.Ref<string>;
      onPurge(id: string): Promise<void>; onRestore(id: string): Promise<void>;
    }
    const chat = useChat();
    chat.retainedSessions = [kept({ id: 'R2', title: '读书笔记' }), kept({ id: 'R3', title: '菜谱收藏' })];
    const { bindings: b } = await runSetup<DevBindings>(DEVICES_FILE, {}, scope);
    const refused = '这个会话已不是保留副本（它已被恢复，或并未被其他设备删除），没有删除任何内容';
    purgeRetained = () => new Error(refused);

    // (1) 引擎拒绝，重拉之后 R2 已不在清单里
    listRetained = () => [kept({ id: 'R3', title: '菜谱收藏' })];
    b.purging.value = 'R2';
    await b.onPurge('R2');
    expect(b.retainNotice.value).toBe(`「读书笔记」：${refused}`);
    expect(b.purging.value).toBe('');
    expect(b.retainBusy.value).toBe('');
    expect(chat.retainedSessions.map(r => r.id)).toEqual(['R3']);

    // (2) 行还在（比如引擎正在关停）：原因留在行内，确认态不收，上一条说明清掉
    purgeRetained = () => new Error('引擎正在关停');
    b.purging.value = 'R3';
    await b.onPurge('R3');
    expect(b.retainNotice.value).toBe('');
    expect(b.retainErr.value.R3).toBe('引擎正在关停');
    expect(b.purging.value).toBe('R3');

    // (3) 成功：不留说明
    purgeRetained = () => ({ ok: true });
    listRetained = () => [];
    await b.onPurge('R3');
    expect(b.retainNotice.value).toBe('');
    expect(b.purging.value).toBe('');
    // 那句说明在保留副本一节的外面：清单空了整节不显示，它还得看得见
    expect(template).toMatch(/<p v-if="retainNotice"[^>]*>\{\{ retainNotice \}\}<\/p>/);
    expect(template.indexOf('v-if="retainNotice"')).toBeLessThan(template.indexOf('<section v-if="chat.retainedSessions.length"'));
    expect(template.indexOf('v-if="retainNotice"')).toBeGreaterThan(template.indexOf('<h2>同步</h2>'));
  });

  it('源码守卫：一节的显示条件、两个按钮各接一个 store 动作、彻底删除有二次确认、挂载时拉保留副本', () => {
    expect(template).toMatch(/<section v-if="chat\.retainedSessions\.length" class="f-sec">/);
    expect(script).toMatch(/import \{ PAIRING_DELETE_NOTE, retainedSummary \} from '\.\.\/lib\/devices\/delete-scope'/);
    expect(template.match(/\{\{ PAIRING_DELETE_NOTE \}\}/g)).toHaveLength(2);
    expect(template.indexOf('{{ PAIRING_DELETE_NOTE }}')).toBeGreaterThan(template.indexOf('<h2>发起配对</h2>'));
    expect(template.lastIndexOf('{{ PAIRING_DELETE_NOTE }}')).toBeGreaterThan(template.indexOf('<h2>加入配对</h2>'));
    expect(template.indexOf('{{ PAIRING_DELETE_NOTE }}')).toBeLessThan(template.indexOf('<h2>加入配对</h2>'));
    expect(script).toContain('chat.restoreSession(id)');
    expect(script).toContain('chat.purgeRetainedSession(id)');
    expect(template).toContain('@click="onRestore(r.id)"');
    // 「彻底删除」先进确认态，确认态里的按钮才真删
    expect(template).toContain('@click="purging = r.id"');
    const confirmBlock = template.slice(template.indexOf('v-if="purging === r.id"'), template.indexOf('@click="purging = r.id"'));
    expect(confirmBlock).toContain('@click="onPurge(r.id)"');
    expect(template.match(/@click="onPurge\(r\.id\)"/g)).toHaveLength(1);
    expect(template).toContain('{{ retainedSummary(r) }}');
    expect(script).toMatch(/onMounted\(\(\) => \{[^}]*chat\.refreshRetained\(\)/);
  });
});

describe('U6 文档与行为一致', () => {
  const repo = path.resolve(root, '..');
  const readme = readFileSync(path.join(repo, 'README.md'), 'utf8');
  const changelog = readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
  const spec = readFileSync(path.join(repo, 'docs/specs/2026-10-03-f11b-delete-propagation.md'), 'utf8');

  it('README「设备同步」不再说删除不同步，写了旧版、暂停、配对后补传的边界，不说「只删本机」', () => {
    const row = readme.split('\n').filter(l => l.startsWith('| 设备同步 |'))[0];
    expect(row).not.toContain('删除不同步');
    expect(row).not.toMatch(/下次与已配对设备同步时会回来/);
    expect(row).toContain('删除也会同步');
    expect(row).toMatch(/旧版本/);
    expect(row).toMatch(/暂停/);
    expect(row).toMatch(/配对（或重新配对）/);
    expect(readme).not.toMatch(/只删本机|只删这台设备上的/);
    expect(readme).toContain('库里会留一条不含内容的删除记录');
  });

  it('CHANGELOG 0.3.0：数据安全有删除同步一条；已知边界不再写「不传播删除」，换成剩余的边界', () => {
    const v030 = changelog.slice(changelog.indexOf('## 0.3.0'), changelog.indexOf('## 0.2.0'));
    expect(v030).not.toContain('设备同步不传播删除');
    expect(v030).toContain('删除会话现在会同步到已配对的设备');
    const known = v030.slice(v030.indexOf('### 已知边界'));
    expect(known).toContain('删除同步的边界');
    for (const part of ['旧版本', '升级前', '配对或重新配对', '第三台设备', '不删磁盘上的']) expect(known, part).toContain(part);
  });

  it('规格文档的边界表：没有已配对设备时的删除、取消配对期间的删除、并发删除时的第三台设备', () => {
    for (const rowHead of ['没有已配对设备时的删除', '取消配对期间的删除', '并发删除时的第三台设备', '旧版对端', '暂停', '升级前的删除']) {
      expect(spec, rowHead).toContain(rowHead);
    }
    expect(spec).toContain('未验证');
    expect(spec).toMatch(/真实.*两台/);
  });

  it('规格文档与 CHANGELOG 写了：彻底删除保留副本用专门的方法、保留副本冻结、自带别的会话 id 的条目被丢弃、登记到上限的边界', () => {
    expect(spec).toContain('chat.sessions.purgeRetained');
    expect(spec).toContain('保留副本因此是冻结的');
    // 冻结清单里有不归会话存储层写的两处：会话的技能覆盖、sync.ack 写的 last_synced_at
    expect(spec).toMatch(/`skills\.setEnabled` 带 `sessionId` 时在处理器里同样抛「会话已删除」/);
    expect(spec).toMatch(/`sync\.ack` 对它是空操作/);
    expect(spec).toMatch(/两者不一致的条目在合并之前丢弃/);
    expect(spec).toContain('| 登记到上限 |');
    const v030 = changelog.slice(changelog.indexOf('## 0.3.0'), changelog.indexOf('## 0.2.0'));
    expect(v030).toContain('最多一百万次');
    expect(v030).toContain('彻底删除只清这台设备留着的那一份');
  });
});
