/** F11C 渲染端：认证配对在设备页用到的 store 动作与格式化函数（真行为，桩掉 rpc.call 看实际调用）。
 *
 *  要守住的：界面上的「取消」真的到达引擎（以前只清前端状态，引擎里的码仍有效到过期）；
 *  remote.status 的新字段进了状态；旧引擎不报告 pairing 时不出错；12 位码的输入与展示。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { rpcCallMock } = vi.hoisted(() => ({ rpcCallMock: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: rpcCallMock } }));

import { createPinia, setActivePinia } from 'pinia';
import { useChat } from '../src/renderer/src/stores/chat';
import { codeInputNormalize, fmtPairingCode } from '../src/renderer/src/lib/devices/fmt';
import { PAIR_ERROR_TEXT, PairError, classifyPairingCode, pairErrorCodeOf, type PairErrorCode } from '../src/shared/pairing';

import { deferred } from './renderer-store-fixture';
afterEach(() => vi.unstubAllGlobals());

const calls = (method: string): unknown[][] => rpcCallMock.mock.calls.filter(([m]) => m === method);
const flush = (): Promise<void> => new Promise(r => setImmediate(r));

beforeEach(() => {
  rpcCallMock.mockReset();
  rpcCallMock.mockImplementation(async (method: string) => {
    if (method === 'remote.status') return { devices: [] };
    if (method === 'remote.pair.begin') return { pairingCode: '0ABCDEFGH234', myFingerprint: 'a1b2c3d4e5f6', expiresIn: 300, protocol: 2, attempts: 5 };
    if (method === 'remote.pair.cancel') return { ok: true, cancelled: true };
    if (method === 'remote.pair.setPolicy') return { ok: true };
    return undefined;
  });
  setActivePinia(createPinia());
});

describe('cancelPairing：取消真的到达引擎', () => {
  it('发起之后取消：调了 remote.pair.cancel，界面状态清空', async () => {
    const chat = useChat();
    await chat.beginPairing();
    expect(chat.pairingSession).toMatchObject({ code: '0ABCDEFGH234', myFingerprint: 'a1b2c3d4e5f6', expiresIn: 300 });
    expect(chat.pairingMeta).toEqual({ protocol: 2, attempts: 5 });
    chat.cancelPairing();
    expect(chat.pairingSession).toBeNull();
    expect(chat.pairingMeta).toBeNull();
    expect(calls('remote.pair.cancel')).toHaveLength(1);
  });
  it('没有在发起时取消：不调引擎', () => {
    const chat = useChat();
    chat.cancelPairing();
    expect(calls('remote.pair.cancel')).toHaveLength(0);
  });
  it('引擎那边取消失败（旧引擎没有这个方法）：不抛、不留未处理的拒绝，界面照样清空', async () => {
    rpcCallMock.mockImplementation(async (method: string) => {
      if (method === 'remote.pair.begin') return { pairingCode: 'ABCD2345', myFingerprint: 'a1b2c3d4e5f6', expiresIn: 300 };
      if (method === 'remote.pair.cancel') throw new Error('未知方法: remote.pair.cancel');
      return { devices: [] };
    });
    const chat = useChat();
    await chat.beginPairing();
    expect(chat.pairingMeta).toEqual({ protocol: 1, attempts: undefined });   // 旧引擎不带 protocol：按旧方式
    expect(() => chat.cancelPairing()).not.toThrow();
    await flush();
    expect(chat.pairingSession).toBeNull();
  });
});

describe('refreshDevices：remote.status 的新字段进状态', () => {
  it('每行的 pairingProtocol / canUpgradePairing 写进 deviceMeta；顶层 pairing 写进 pairStatus；devices 的形状不变', async () => {
    const pairing = { policy: 'authenticated', defaultPolicy: 'legacy', host: { protocol: 2, expiresAt: 1, attemptsLeft: 4, inFlight: false } };
    rpcCallMock.mockImplementation(async () => ({
      devices: [
        { peerFingerprint: 'aa0000000001', peerName: 'v2', roomId: 'R', createdAt: 1, online: true, lastSeenAt: 2, pairingProtocol: 2, canUpgradePairing: false },
        { peerFingerprint: 'aa0000000002', peerName: 'v1', roomId: 'R', createdAt: 1, online: true, lastSeenAt: 2, pairingProtocol: 1, canUpgradePairing: true },
        { peerFingerprint: 'aa0000000003', peerName: 'old', roomId: 'R', createdAt: 1, online: false, lastSeenAt: 0 },
        { peerFingerprint: 'aa0000000004', peerName: 'odd', roomId: 'R', createdAt: 1, online: false, lastSeenAt: 0, pairingProtocol: '2', canUpgradePairing: 'yes' },
      ],
      pairing,
    }));
    const chat = useChat();
    await chat.refreshDevices();
    expect(chat.devices).toHaveLength(4);
    expect(chat.deviceMeta).toEqual({
      aa0000000001: { pairingProtocol: 2, canUpgradePairing: false },
      aa0000000002: { pairingProtocol: 1, canUpgradePairing: true },
      aa0000000003: { pairingProtocol: 1, canUpgradePairing: false },   // 旧引擎的行：没有这两项
      aa0000000004: { pairingProtocol: 1, canUpgradePairing: false },   // 不认识的值一律按旧方式、不可升级
    });
    expect(chat.pairStatus).toEqual(pairing);
  });
  it('旧引擎不报告 pairing：pairStatus 为 null（设备页不显示开关）', async () => {
    const chat = useChat();
    await chat.refreshDevices();
    expect(chat.pairStatus).toBeNull();
    expect(chat.deviceMeta).toEqual({});
  });
});

describe('setPairingPolicy', () => {
  it('调 remote.pair.setPolicy，清掉发起态，再刷新设备', async () => {
    const chat = useChat();
    await chat.beginPairing();
    rpcCallMock.mockClear();
    await chat.setPairingPolicy('authenticated');
    expect(rpcCallMock.mock.calls.map(c => c[0])).toEqual(['remote.pair.setPolicy', 'remote.status']);
    expect(calls('remote.pair.setPolicy')[0][1]).toEqual({ policy: 'authenticated' });
    expect(chat.pairingSession).toBeNull();
    expect(chat.pairingMeta).toBeNull();
  });
  it('引擎拒绝时把错误抛给界面，发起态不动', async () => {
    const chat = useChat();
    await chat.beginPairing();
    rpcCallMock.mockImplementation(async (method: string) => { if (method === 'remote.pair.setPolicy') throw new Error('写不进去'); return { devices: [] }; });
    await expect(chat.setPairingPolicy('legacy')).rejects.toThrow('写不进去');
    expect(chat.pairingSession).not.toBeNull();
  });
});

describe('码的输入与展示', () => {
  it('fmtPairingCode：8 位 XXXX-XXXX，12 位 0XXX-XXXX-XXXX，不超过 4 位原样', () => {
    expect(fmtPairingCode('ABCD2345')).toBe('ABCD-2345');
    expect(fmtPairingCode('0ABCDEFGH234')).toBe('0ABC-DEFG-H234');
    expect(fmtPairingCode('ABCD')).toBe('ABCD');
    expect(fmtPairingCode('ABCDE')).toBe('ABCD-E');
  });
  it('codeInputNormalize 限 12 位；展示出来的码再输回去，分类结果是同一个 v2 码', () => {
    expect(codeInputNormalize('0abc-defg-h234')).toBe('0ABCDEFGH234');
    expect(codeInputNormalize('0abc-defg-h234-zzzz')).toBe('0ABCDEFGH234');
    expect(classifyPairingCode(codeInputNormalize(fmtPairingCode('0ABCDEFGH234')))).toEqual({ kind: 'v2', code: '0ABCDEFGH234' });
    expect(classifyPairingCode(codeInputNormalize(fmtPairingCode('ABCD2345')))).toEqual({ kind: 'v1' });
  });
});

describe('错误码到界面文案', () => {
  it('pairErrorCodeOf 与 PAIR_ERROR_TEXT 覆盖全部错误码；RPC 错误串开头是码时取得到', () => {
    for (const code of Object.keys(PAIR_ERROR_TEXT) as PairErrorCode[]) {
      const msg = new PairError(code).message;       // 引擎抛出、经 RPC 原样传到渲染端的错误串
      expect(pairErrorCodeOf(msg)).toBe(code);
      expect(PAIR_ERROR_TEXT[code].length).toBeGreaterThan(6);
    }
    expect(pairErrorCodeOf('配对码无效或已过期')).toBeUndefined();   // v1 的旧文案：界面原样显示
  });
});

describe('设备页源文本守卫（F11C）', () => {
  const vue = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'ui', 'StageDevices.vue'), 'utf8');
  it('开关文案如实：实验、未经独立密码学审查、默认关闭、码不经过网络、对方也要支持', () => {
    expect(vue).toContain('认证配对（实验）');
    expect(vue).toContain('尚未经独立密码学审查，默认关闭');
    expect(vue).toContain('配对码本身不经过网络');
    expect(vue).toContain('对方也要是支持认证配对的版本');
    expect(vue).toContain("chat.setPairingPolicy(authOn.value ? 'legacy' : 'authenticated')");
    expect(vue).toContain('v-if="chat.pairStatus"');       // 旧引擎：整行不显示
  });
  it('等待态写明 12 位要全部输入与次数；占位符不暗示 12 位码输到 8 位也能提交', () => {
    expect(vue).toContain('这个码以 0 开头，12 位要全部输入');
    expect(vue).toContain('chat.pairStatus?.host?.attemptsLeft');
    expect(vue).toContain('placeholder="8 位，或以 0 开头的 12 位"');
    expect(vue).not.toContain('8 位或 12 位配对码');
  });
  it('结局提示与旧配对标记；报错显示错误码对应的说明', () => {
    expect(vue).toContain("out?.kind === 'paired'");
    expect(vue).toContain('PAIR_ERROR_TEXT[out.code]');
    expect(vue).toContain('旧方式配对（未认证）');
    expect(vue).toContain('对方支持认证配对，重新配对即可升级');
    expect(vue).toContain('pairErrorCodeOf(msg)');
  });
  it('界面文案不把 0.3.0 当成旧版本', () => {
    expect(vue).not.toMatch(/0\.3\.0/);
  });
  it('新动作放在 unpair 之后、joinPairing 之前（joinPairing 到 retryLast 那一段有别的守卫在截取）', async () => {
    // 原位置约定已随切片守卫退出；分别验证三个动作的应答闸与完整RPC序列。
    vi.stubGlobal('window', {});
    const chat = useChat();
    for (const kind of ['unpair', 'policy', 'join'] as const) {
      const reply = deferred();
      rpcCallMock.mockReset();
      rpcCallMock.mockImplementation(async (m: string) => {
        if (m === 'remote.status') {
          if (kind === 'policy') {
            expect(chat.pairingSession).toBeNull();
            expect(chat.pairingMeta).toBeNull();
          }
          return { devices: [] };
        }
        return reply.promise;
      });
      chat.pairingSession = { code: 'CODE', myFingerprint: 'mine', expiresIn: 30, startedAt: 1 };
      chat.pairingMeta = { protocol: 2, attempts: 3 };
      const pair = { host: 'host', port: 12345, pairingCode: 'ABCD2345', peerName: 'peer', listenPort: 34567 };
      const first = kind === 'unpair' ? ['remote.unpair', { peerFingerprint: 'FP' }] : kind === 'policy' ? ['remote.pair.setPolicy', { policy: 'authenticated' }] : ['remote.pair.join', pair];
      const pending = kind === 'unpair' ? chat.unpair('FP') : kind === 'policy' ? chat.setPairingPolicy('authenticated') : chat.joinPairing(pair);
      expect(rpcCallMock.mock.calls).toEqual([first]);
      expect(chat.pairingSession).not.toBeNull();
      expect(chat.pairingMeta).not.toBeNull();
      reply.resolve({ peerFingerprint: 'PEER' });
      expect(await pending).toBe(kind === 'join' ? 'PEER' : undefined);
      expect(rpcCallMock.mock.calls).toEqual([first, ['remote.status']]);
    }
  });
});
