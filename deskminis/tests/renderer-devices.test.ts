/** MU2b Task 7：配对管理面（DevicesModal 接 remote.* 真 RPC）——lib/devices/fmt 纯模块单测
 *  + chat.ts 四 actions / DevicesModal.vue / SessionList / App.vue / SettingsModal 源文本守卫。
 *  红线：只消费既有 remote.status / remote.pair.begin / remote.unpair，不新增任何 RPC；
 *  「加入配对」一期置灰（M3c 出站通道，remote.pair.complete 是 pairing authMode 专属，本地连接不可调）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fmtFingerprint, fmtPairingCode, codeInputNormalize } from '../src/renderer/src/lib/devices/fmt';

const root = path.resolve(__dirname, '..');
const chatStore = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');
const devicesModal = fs.readFileSync(path.join(root, 'src/renderer/src/components/DevicesModal.vue'), 'utf8');
const sessionList = fs.readFileSync(path.join(root, 'src/renderer/src/components/SessionList.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8');
const settingsModal = fs.readFileSync(path.join(root, 'src/renderer/src/components/SettingsModal.vue'), 'utf8');

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

  it('codeInputNormalize：大写化 + 剥非字母数字 + 限 8 位', () => {
    expect(codeInputNormalize('abcd-2345')).toBe('ABCD2345');
    expect(codeInputNormalize('ab cd!23 45')).toBe('ABCD2345');
    expect(codeInputNormalize('abcd2345efgh')).toBe('ABCD2345');
    expect(codeInputNormalize('')).toBe('');
  });
});

describe('MU2b Task 7 配对管理面：store 与组件守卫（5 例）', () => {
  it('chat.ts 纯增量：devices/pairingSession state + refreshDevices/beginPairing/cancelPairing/unpair 四 actions 接 remote.* 三 RPC', () => {
    expect(chatStore).toContain('devices: [] as { peerFingerprint: string; peerName: string; roomId: string; createdAt: number; online: boolean; lastSeenAt: number }[]');
    expect(chatStore).toContain('pairingSession: null as null | { code: string; myFingerprint: string; expiresIn: number; startedAt: number }');
    expect(chatStore).toContain('async refreshDevices()');
    expect(chatStore).toContain("rpc.call('remote.status')");
    expect(chatStore).toContain('async beginPairing()');
    expect(chatStore).toContain("rpc.call('remote.pair.begin')");
    expect(chatStore).toContain('cancelPairing()');
    expect(chatStore).toContain('async unpair(fingerprint: string)');
    expect(chatStore).toContain("rpc.call('remote.unpair'");
  });

  it('DevicesModal.vue：三区块（设备列表/发起配对/加入配对）+ 码大字 mono 32px 字距 8px + 倒计时复用 lib/perm/countdown + fmt 三函数', () => {
    expect(devicesModal).toContain('已配对设备');
    expect(devicesModal).toContain('发起配对');
    expect(devicesModal).toContain('加入配对');
    expect(devicesModal).toContain('32px');
    expect(devicesModal).toContain('letter-spacing: 8px');
    expect(devicesModal).toContain('var(--font-mono)');
    expect(devicesModal).toContain("from '../lib/perm/countdown'");
    expect(devicesModal).toContain('fmtFingerprint');
    expect(devicesModal).toContain('fmtPairingCode');
    expect(devicesModal).toContain('codeInputNormalize');
  });

  it('DevicesModal.vue：移除钮二次确认 + 指纹 mono 展示 + 加入配对置灰带 M3c 说明 + 等待/过期状态句 + 2s 轮询感知', () => {
    expect(devicesModal).toContain('确认移除');
    expect(devicesModal).toContain('M3c');
    expect(devicesModal).toContain('等待对端输入');
    expect(devicesModal).toContain('配对码已过期，请重新发起');
    expect(devicesModal).toContain('2000'); // 2s 轮询 remote.status
    expect(devicesModal).toContain('refreshDevices');
  });

  it('SessionList.vue：设备按钮 disabled 退场 → inject openDevices 开 DevicesModal', () => {
    expect(sessionList).toContain("inject<() => void>('openDevices'");
    // 设备按钮不再 disabled（lfoot 区块内）
    const lfoot = /class="lfoot"[\s\S]*?<\/div>/.exec(sessionList)?.[0] ?? '';
    expect(lfoot).not.toContain('disabled');
    expect(lfoot).toContain('openDevices()');
  });

  it('App.vue provide openDevices + DevicesModal 接线；SettingsModal 设备与同步 section 入口同开', () => {
    expect(app).toContain("import DevicesModal from './components/DevicesModal.vue'");
    expect(app).toContain("provide('openDevices'");
    expect(app).toContain('DevicesModal v-if="devicesOpen"');
    expect(settingsModal).toContain("inject<() => void>('openDevices'");
    expect(settingsModal).toContain('openDevices()');
    // 设置模态内入口不再 disabled
    expect(settingsModal).not.toContain('disabled title="MU2b Task 7 填实"');
  });
});
