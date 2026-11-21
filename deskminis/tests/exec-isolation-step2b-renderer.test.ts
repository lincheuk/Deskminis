/** 执行隔离第 2 步（二）界面侧：待确认的外部改动从哪里来、确认怎么发、在哪里提示。
 *  ① store：refreshControlPending 取 control.pending.list；旧引擎没有这个接口时保持空、不报错；
 *     control.pending.changed 广播触发重取；confirm 带上看到的那一版指纹，失败照样重取并把错误抛给界面。
 *  ② 横幅与设置页接线（源码守卫）：横幅点「去查看」进设置的权限页；权限页挂着确认列表；MCP 列表标出未确认。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import fs from 'node:fs';
import path from 'node:path';
import { useChat, type UiControlPending } from '../src/renderer/src/stores/chat';
import { resetStoreRpc, settleStore } from './renderer-store-fixture';

const root = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
beforeEach(() => { resetStoreRpc(_probe); });
afterEach(() => { vi.restoreAllMocks(); });

const ITEM: UiControlPending = { kind: 'mcp', key: 'a', fingerprint: 'f1', title: 'MCP 服务器 a', preview: '启动命令：x', reason: 'changed' };

describe('① store', () => {
  it('取 control.pending.list；没有这个接口（旧引擎）时保持空', async () => {
    const chat = useChat();
    _rpcCall.mockImplementation(async (m: string) => (m === 'control.pending.list' ? { items: [ITEM] } : undefined));
    await chat.refreshControlPending();
    expect(chat.controlPending).toEqual([ITEM]);
    _rpcCall.mockImplementation(async () => { throw new Error('未知方法: control.pending.list'); });
    await chat.refreshControlPending();
    expect(chat.controlPending).toEqual([]);
  });

  it('init 订阅 control.pending.changed，广播来了就重取', async () => {
    const chat = useChat();
    _rpcCall.mockImplementation(async (m: string) => {
      if (m === 'control.pending.list') return { items: [ITEM] };
      if (m === 'chat.sessions.list' || m === 'provider.instances.list' || m === 'modelgroup.list' || m === 'assistants.list' || m === 'skills.list') return [];
      return undefined;
    });
    await chat.init();
    await settleStore();
    expect(_handlers.has('control.pending.changed')).toBe(true);
    chat.controlPending = [];
    _rpcCall.mockClear();
    _handlers.get('control.pending.changed')!({ count: 1 });
    await settleStore();
    expect(_rpcCall.mock.calls).toEqual([['control.pending.list']]);
    expect(chat.controlPending).toEqual([ITEM]);
  });

  it('确认带上看到的指纹；引擎拒绝时错误抛给界面，列表照样重取', async () => {
    const chat = useChat();
    _rpcCall.mockImplementation(async (m: string) => (m === 'control.pending.list' ? { items: [] } : { ok: true }));
    await chat.confirmControlPending(ITEM);
    expect(_rpcCall.mock.calls).toEqual([['control.pending.confirm', { kind: 'mcp', key: 'a', fingerprint: 'f1' }], ['control.pending.list']]);
    _rpcCall.mockReset();
    _rpcCall.mockImplementation(async (m: string) => {
      if (m === 'control.pending.confirm') throw new Error('内容在你查看之后又变了，请重新查看再确认');
      return { items: [{ ...ITEM, fingerprint: 'f2' }] };
    });
    await expect(chat.confirmControlPending(ITEM)).rejects.toThrow('内容在你查看之后又变了');
    expect(chat.controlPending[0].fingerprint).toBe('f2');
  });
});

describe('② 横幅与设置页接线', () => {
  const app = read('src/renderer/src/ui/AppShell.vue');
  const settings = read('src/renderer/src/ui/StageSettings.vue');
  const pending = read('src/renderer/src/ui/settings/ControlPending.vue');
  it('有待确认时顶部横幅出现（设置页里不出现），「去查看」打开设置的权限页', () => {
    expect(app).toMatch(/v-if="chat\.controlPending\.length && view !== 'settings'"/);
    expect(app).toMatch(/@click="openControlReview"/);
    expect(app).toMatch(/view\.value = 'settings';\s*settingsJump\.value \+= 1;/);
    expect(app).toMatch(/<StageSettings v-else :initial-sec="settingsJump \? 'perm' : undefined" :jump="settingsJump" \/>/);
  });
  it('权限页挂着确认列表；列表显示预览、确认调 confirmControlPending', () => {
    expect(settings).toMatch(/v-else-if="sec === 'perm'"[^>]*><SecPermission \/><ControlPending \/>/);
    expect(settings).toMatch(/ref<Sec>\(props\.initialSec \?\? 'models'\)/);
    expect(pending).toMatch(/\{\{ i\.preview \}\}/);
    expect(pending).toMatch(/chat\.confirmControlPending\(i\)/);
  });
  it('MCP 列表标出配置被外部改过、还没确认的服务器', () => {
    const mcp = read('src/renderer/src/ui/settings/SecMcp.vue');
    expect(mcp).toMatch(/i\.kind === 'mcp' && i\.key === name/);
    expect(mcp).toContain('外部改动待确认');
  });
});
