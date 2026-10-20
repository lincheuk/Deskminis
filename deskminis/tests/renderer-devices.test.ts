/** MU2b Task 7：配对管理面（DevicesModal 接 remote.* 真 RPC）——lib/devices/fmt 纯模块单测
 *  + chat.ts 四 actions / DevicesModal.vue / SessionList / App.vue / SettingsModal 源文本守卫。
 *  红线：只消费既有 remote.status / remote.pair.begin / remote.unpair，不新增任何 RPC；
 *  「加入配对」一期置灰（M3c 出站通道，remote.pair.complete 是 pairing authMode 专属，本地连接不可调）。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { rpcCall } = vi.hoisted(() => ({ rpcCall: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: rpcCall } }));
import fs from 'node:fs';
import path from 'node:path';
import { fmtFingerprint, fmtPairingCode, codeInputNormalize } from '../src/renderer/src/lib/devices/fmt';
import { createPinia, setActivePinia } from 'pinia';
import { useChat } from '../src/renderer/src/stores/chat';
import type { Equal } from './renderer-store-fixture';

const root = path.resolve(__dirname, '..');
const devicesModal = fs.readFileSync(path.join(root, 'src/renderer/src/ui/StageDevices.vue'), 'utf8');
const sessionList = fs.readFileSync(path.join(root, 'src/renderer/src/ui/NavRail.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/ui/AppShell.vue'), 'utf8');
const settingsModal = fs.readFileSync(path.join(root, 'src/renderer/src/ui/StageSettings.vue'), 'utf8');

beforeEach(() => {
  setActivePinia(createPinia());
  rpcCall.mockReset();
  rpcCall.mockImplementation(async () => ({ ok: true }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('MU2b Task 7 配对管理面：lib/devices/fmt 纯模块（4 例）', () => {
  it('fmtFingerprint：12 hex → 大写两字分组（XX XX XX XX XX XX）', () => {
    expect(fmtFingerprint('a1b2c3d4e5f6')).toBe('A1 B2 C3 D4 E5 F6');
    expect(fmtFingerprint('A47184C877FA')).toBe('A4 71 84 C8 77 FA');
  });

  it('fmtFingerprint：超 12 截断 + 非 hex 字符剥离', () => {
    expect(fmtFingerprint('a1b2c3d4e5f60708')).toBe('A1 B2 C3 D4 E5 F6');
    expect(fmtFingerprint('zz-a1b2')).toBe('A1 B2');
  });

  it('fmtPairingCode：8 字 → XXXX-XXXX；不足 4 字原样', () => {
    expect(fmtPairingCode('ABCD2345')).toBe('ABCD-2345');
    expect(fmtPairingCode('ABC')).toBe('ABC');
  });

  it('codeInputNormalize：大写化 + 剥非字母数字 + 限 12 位（F11C：认证配对码 12 位）', () => {
    expect(codeInputNormalize('abcd-2345')).toBe('ABCD2345');
    expect(codeInputNormalize('ab cd!23 45')).toBe('ABCD2345');
    expect(codeInputNormalize('abcd2345efgh')).toBe('ABCD2345EFGH');
    expect(codeInputNormalize('abcd2345efghjkmn')).toBe('ABCD2345EFGH');
    expect(codeInputNormalize('')).toBe('');
  });
});

describe('MU2b Task 7 配对管理面：store 与组件守卫（5 例）', () => {
  it('chat.ts 纯增量：devices/pairingSession state + refreshDevices/beginPairing/cancelPairing/unpair 四 actions 接 remote.* 三 RPC', async () => {
    // 初值是真实 store；擦除的类型声明通过真实实例字段的精确类型比较，由 tsc 把关。
    const chat = useChat();
    expect(chat.devices).toEqual([]);
    expect(chat.pairingSession).toBeNull();
    const devicesType: true = true as Equal<typeof chat.devices, { peerFingerprint: string; peerName: string; roomId: string; createdAt: number; online: boolean; lastSeenAt: number }[]>;
    const pairingType: true = true as Equal<typeof chat.pairingSession, null | { code: string; myFingerprint: string; expiresIn: number; startedAt: number }>;
    expect([devicesType, pairingType]).toEqual([true, true]);

    // 刷新消费 remote.status 的设备表，每个字段及布尔两值原样进 state。
    const devices = [
      { peerFingerprint: 'aabb', peerName: 'Desk A', roomId: 'room-A', createdAt: 101, online: true, lastSeenAt: 102 },
      { peerFingerprint: 'ccdd', peerName: 'Desk B', roomId: 'room-B', createdAt: 201, online: false, lastSeenAt: 202 },
    ];
    rpcCall.mockResolvedValueOnce({ devices });
    await chat.refreshDevices();
    expect(rpcCall.mock.calls).toEqual([['remote.status']]);
    expect(chat.devices).toEqual(devices);
    expect(Object.keys(chat.devices[0]).sort()).toEqual(['createdAt', 'lastSeenAt', 'online', 'peerFingerprint', 'peerName', 'roomId']);

    // 配对应答在途时不先写状态；应答后的四个字段及当前时间逐个对上。
    let releasePair!: (reply: unknown) => void;
    rpcCall.mockClear();
    rpcCall.mockImplementationOnce(() => new Promise(resolve => { releasePair = resolve; }));
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    const pairing = chat.beginPairing();
    expect(rpcCall.mock.calls).toEqual([['remote.pair.begin']]);
    expect(chat.pairingSession).toBeNull();
    releasePair({ pairingCode: 'ABCD2345', myFingerprint: 'aabbcc', expiresIn: 300 });
    await pairing;
    expect(chat.pairingSession).toEqual({ code: 'ABCD2345', myFingerprint: 'aabbcc', expiresIn: 300, startedAt: 123456 });

    // 取消确实清状态、只发一次无参 RPC；未发起时再取消，等当前事件循环结束后没有第二次调用。
    rpcCall.mockClear();
    chat.cancelPairing();
    expect(chat.pairingSession).toBeNull();
    expect(chat.pairingMeta).toBeNull();
    expect(rpcCall.mock.calls).toEqual([['remote.pair.cancel']]);
    chat.cancelPairing();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rpcCall.mock.calls).toEqual([['remote.pair.cancel']]);

    // 解绑先把指纹传给 remote.unpair，成功应答后才刷新；刷新结果替换设备表。
    let releaseUnpair!: (reply: unknown) => void;
    rpcCall.mockClear();
    rpcCall.mockImplementationOnce(() => new Promise(resolve => { releaseUnpair = resolve; }));
    rpcCall.mockResolvedValueOnce({ devices: [devices[1]] });
    const unpairing = chat.unpair('aabb');
    expect(rpcCall.mock.calls).toEqual([['remote.unpair', { peerFingerprint: 'aabb' }]]);
    expect(chat.devices).toEqual(devices);
    releaseUnpair({ ok: true });
    await unpairing;
    expect(rpcCall.mock.calls).toEqual([['remote.unpair', { peerFingerprint: 'aabb' }], ['remote.status']]);
    expect(chat.devices).toEqual([devices[1]]);
  });

  it('DevicesModal.vue：三区块（设备列表/发起配对/加入配对）+ 码大字 mono 32px 字距 8px + 倒计时复用 lib/perm/countdown + fmt 三函数', () => {
    expect(devicesModal).toContain('已配对设备');
    expect(devicesModal).toContain('发起配对');
    expect(devicesModal).toContain('加入配对');
    expect(devicesModal).toContain('32px');
    expect(devicesModal).toContain('letter-spacing: 8px');
    expect(devicesModal).toContain('var(--f-mono)');
    expect(devicesModal).toContain("from '../lib/perm/countdown'");
    expect(devicesModal).toContain('fmtFingerprint');
    expect(devicesModal).toContain('fmtPairingCode');
    expect(devicesModal).toContain('codeInputNormalize');
  });

  it('DevicesModal.vue：移除钮二次确认 + 指纹 mono 展示 + 加入配对置灰带 M3c 说明 + 等待/过期状态句 + 2s 轮询感知', () => {
    expect(devicesModal).toMatch(/确认解绑/);  // 文案从「移除」改成更准的「解绑」
    expect(devicesModal).toContain('等待对端输入');
    expect(devicesModal).toContain('配对码已过期，请重新发起');
    expect(devicesModal).toContain('2000'); // 2s 轮询 remote.status
    expect(devicesModal).toContain('refreshDevices');
  });

  it('SessionList.vue：设备按钮 disabled 退场 → inject openDevices 开 DevicesModal', () => {
    expect(sessionList).toMatch(/emit\('view', 'devices'\)/);  // 从 provide/inject 改成 NavRail 发 view 事件
    // 设备按钮不再 disabled（lfoot 区块内）
    // 取 NavRail 里「设备」那颗按钮本体：不再 disabled，且点了真的能到设备视图
    const devBtn = sessionList.match(/<button[^>]*@click="emit\('view', 'devices'\)"[^>]*>/)?.[0] ?? '';
    expect(devBtn, 'NavRail 里找不到设备入口').not.toBe('');
    expect(devBtn).not.toContain('disabled');
  });

  it('App.vue provide openDevices + DevicesModal 接线；SettingsModal 设备与同步 section 入口同开', () => {
    expect(app).toContain("import StageDevices from './StageDevices.vue'");
    expect(app).toMatch(/view === 'devices'/);  // 外壳按 view 值切舞台
    expect(app).toMatch(/view === 'devices'/);
    // 设置页不再挂设备入口：设备是 NavRail 一级项
    // 设置模态内入口不再 disabled
    expect(settingsModal).not.toContain('disabled title="MU2b Task 7 填实"');
  });
});
