/**
 * M3c Task 7 · UI 源文本守卫测试（小项 7d）
 *
 * 参照 MU2 renderer-* 先例：读 .vue/.ts 源码断言关键 class/结构/action 存在，不启动浏览器。
 * CDP 断言（DevicesModal 交互/TitleBar 渲染）并入 Task 8 e2e 第 9 步。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on.mockImplementation((m: string, h: (p: any) => unknown) => probe.handlers.set(m, h)), onLost: probe.lost, connect: probe.connect } }));
import { useChat } from '../src/renderer/src/stores/chat';
import { resetStoreRpc, initStore, dispatchStore, deferred, minimalReply, type Chat, type Equal } from './renderer-store-fixture';
beforeEach(() => resetStoreRpc(probe));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const root = join(__dirname, '../src/renderer/src');

describe('M3c UI 源文本守卫', () => {
  it('StageDevices：加入配对两输入（host:port + 配对码，免手抄公钥）+ 在线点', () => {
    const src = readFileSync(join(root, 'ui/StageDevices.vue'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('joinAddr');    // host:port 输入
    expect(src).toContain('joinCode');    // 配对码输入
    expect(src).toContain('joinPairing'); // 调 store action
    expect(src).not.toContain('joinPubKey'); // 无公钥输入（免手抄）
    expect(src).toMatch(/class="dot[^"]*"/); // 在线点
  });

  it('TopBar：同步状态点三态（syncing / idle / 未连接）+ 人话 title', () => {
    // T6e-3 重指：syncdot → syncDot，pulse 动画退场（改用颜色区分三态，title 说人话）。
    // ⚠️ 我先前把这条误判成「没搬」——按 syncdot 小写去搜自然零命中。守卫重指前要按**意图**搜，不按旧名。
    const src = readFileSync(join(root, 'ui/TopBar.vue'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('syncDot');
    expect(src).toMatch(/syncState === 'syncing'/);
    expect(src).toMatch(/syncState === 'idle'/);
    expect(src).toMatch(/正在与其它设备同步/);
    expect(src).toMatch(/未连接其它设备/);   // 第三态也要说得出话
    expect(src).toMatch(/:title="syncDot\.t"/); // 悬停可读
  });

  /* T6e-3 退场「ChatView：回合区消息设备标…」：消息来源设备标（originDeviceId → 「来自 xx 设备」）在新 StageChat 里没有对应物。store 的 UiMessage 仍带 originDeviceId，只是没人渲染。记入候选池「换壳遗失的入口」 */

  it('chat.ts：joinPairing action + syncState state + synced 事件处理', async () => {
    // 配对应答之前不取设备；完成后带完整参数、返回指纹并刷新设备。
    vi.stubGlobal('window', {});
    const chat = await initStore(probe);
    expect(chat.syncState).toBe('offline');
    const gate = deferred();
    probe.call.mockImplementation((m: string) => m === 'remote.pair.join' ? gate.promise : minimalReply(m));
    const params = { host: 'host.example', port: 23456, pairingCode: 'ABCD2345', peerName: '设备乙', listenPort: 34567 };
    const joining = chat.joinPairing(params);
    expect(probe.call.mock.calls).toEqual([['remote.pair.join', params]]);
    gate.resolve({ peerFingerprint: 'fp-joined' });
    expect(await joining).toBe('fp-joined');
    expect(probe.call.mock.calls).toEqual([['remote.pair.join', params], ['remote.status']]);

    // 真派发同步通知，在2000毫秒边界、重置计时与断线后观察状态。
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(10000);
    await dispatchStore(probe, 'sync.dirty', {});
    expect(chat.syncState).toBe('syncing');
    await vi.advanceTimersByTimeAsync(1999);
    expect(chat.syncState).toBe('syncing');
    await vi.advanceTimersByTimeAsync(1);
    expect(chat.syncState).toBe('idle');
    await dispatchStore(probe, 'sync.dirty', {});
    await vi.advanceTimersByTimeAsync(1000);
    await dispatchStore(probe, 'sync.dirty', {});
    await vi.advanceTimersByTimeAsync(1999);
    expect(chat.syncState).toBe('syncing');
    await vi.advanceTimersByTimeAsync(1);
    expect(chat.syncState).toBe('idle');
    await dispatchStore(probe, 'sync.dirty', {});
    probe.lost.mock.calls.at(-1)![0]();
    expect(chat.syncState).toBe('offline');
    await vi.advanceTimersByTimeAsync(2000);
    expect(chat.syncState).toBe('offline');

    // 同步条属于当前会话，两个插值分别使用条数和设备指纹前六位。
    chat.activeId = 'A';
    await dispatchStore(probe, 'chat.event', { kind: 'synced', sessionId: 'A', mergedCount: 17, fromDevice: 'abcdef987654' });
    expect(chat.eventNotes).toEqual([{ kind: 'synced', ts: Date.now(), detail: '已同步 17 条来自 abcdef' }]);
    const beforeOtherSession = JSON.parse(JSON.stringify(chat.eventNotes));
    await dispatchStore(probe, 'chat.event', { kind: 'synced', sessionId: 'B', mergedCount: 23, fromDevice: 'uvwxyz123456' });
    expect(chat.eventNotes).toHaveLength(1);
    expect(chat.eventNotes).toEqual(beforeOtherSession);
  });

  it('chat.ts：devices 项增 online/lastSeenAt 字段', async () => {
    // 类型与真实应答分别验证；本条有意与renderer-devices的类型用例重复。
    const exact: true = true as Equal<Chat['devices'], { peerFingerprint: string; peerName: string; roomId: string; createdAt: number; online: boolean; lastSeenAt: number }[]>;
    expect(exact).toBe(true);
    const chat = useChat();
    expect(chat.devices).toEqual([]);
    const devices = [{ peerFingerprint: 'fp', peerName: '名字', roomId: 'room', createdAt: 19, online: true, lastSeenAt: 71 }, { peerFingerprint: 'fp2', peerName: '离线', roomId: 'r2', createdAt: 23, online: false, lastSeenAt: 97 }];
    probe.call.mockResolvedValue({ devices });
    await chat.refreshDevices();
    expect(probe.call.mock.calls).toEqual([['remote.status']]);
    expect(chat.devices).toEqual(devices);
  });

  // M4.6 Task 3：joinPairing 需透传 listenPort 到 remote.pair.join，
  // 否则 begin 侧断线后没有 join 侧监听端口无法回拨（回复收敛只剩单方向）
  //
  // Q20b：此例独立验证完整透传与桥回退。
  it('chat.ts：joinPairing 透传 listenPort 到 remote.pair.join（M4.6 Task 3，灰盒守卫）', async () => {
    // 显式端口优先；缺省值来自桥，桥缺失或失败仍完成配对。
    const bridge = vi.fn(async () => ({ port: 34567 }));
    const cases = [
      { bridge: { minisdInfo: bridge }, port: 45678, expected: 45678, reads: 0 },
      { bridge: { minisdInfo: bridge }, port: undefined, expected: 34567, reads: 1 },
      { bridge: { minisdInfo: vi.fn(async () => ({ port: undefined, alive: false })) }, port: undefined, expected: undefined, reads: 1 },
      { bridge: { minisdInfo: vi.fn(async () => ({ alive: false })) }, port: undefined, expected: undefined, reads: 1 },
      { bridge: { minisdInfo: vi.fn(async () => undefined) }, port: undefined, expected: undefined, reads: 1 },
      { bridge: { minisdInfo: vi.fn(async () => null) }, port: undefined, expected: undefined, reads: 1 },
      { bridge: undefined, port: undefined, expected: undefined, reads: 0 },
      { bridge: {}, port: undefined, expected: undefined, reads: 0 },
      { bridge: { minisdInfo: vi.fn(async () => { throw new Error('桥失败'); }) }, port: undefined, expected: undefined, reads: 1 },
    ];
    for (const c of cases) {
      resetStoreRpc(probe);
      bridge.mockClear();
      vi.stubGlobal('window', { deskminis: c.bridge });
      probe.call.mockImplementation(async (m: string) => m === 'remote.pair.join' ? { peerFingerprint: 'FP' } : minimalReply(m));
      const chat = useChat();
      const params = { host: '10.0.0.7', port: 23456, pairingCode: 'ABCD2345', peerName: '对端', ...(c.port === undefined ? {} : { listenPort: c.port }) };
      expect(await chat.joinPairing(params)).toBe('FP');
      expect(probe.call.mock.calls).toEqual([['remote.pair.join', { ...params, listenPort: c.expected }], ['remote.status']]);
      if (c.bridge?.minisdInfo) expect(c.bridge.minisdInfo).toHaveBeenCalledTimes(c.reads);
    }
  });
});
