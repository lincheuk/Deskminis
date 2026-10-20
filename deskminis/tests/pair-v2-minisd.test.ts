/** F11C：认证配对走 minisd/index.ts 的真实装配（任务卡验收 4，以及验收 1、2、3 在真实接线上的失败路径）。
 *
 *  进程内两个 startMinisd（做法同 tests/auto-sync.test.ts）。这里经过的是引擎自己的接线：settings 表驱动的策略、
 *  onEvent 写审计、setPairedListener 接真实的 RpcServer 与 OutboundClient、全部业务方法上的 isPaired。
 *  DESKMINIS_TEST 下引擎用的 vault 是 InMemoryVault.forDataRoot(dir)，测试取到同一个实例、记下它的每一次写入。
 *  中继是 WebSocket 层的，直接夹在两个引擎之间。 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { StaticIdentity } from '../src/minisd/remote/pairing';
import { PAIR_FAIL_FRAME } from '../src/minisd/remote/pair-proto';
import { fmtPairingCode } from '../src/renderer/src/lib/devices/fmt';
import {
  FakeJoiner, chDial, keysOfRaw, mitm, pairCodeOf, randomW, rawPair, waitFor, wsConnect,
  type Cleanups, type RelayFrame, type RpcClient,
} from './pair-v2-util';

const cleanups: Cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

interface Engine {
  dir: string;
  port: number;
  listenPort: number;
  fp: string;
  local: RpcClient;
  vault: InMemoryVault;
  /** vault 的每一次 set（键与值）。 */
  writes: Array<{ key: string; value: string }>;
  /** vault 里现有的、除静态身份之外的 pairing.* 键。 */
  pairingKeys(): string[];
  close(): Promise<void>;
}

async function bootEngine(dir?: string): Promise<Engine> {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'dm-pairv2-eng-'));
  if (!dir) {
    cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });
    writeFileSync(join(root, 'providers.json'), JSON.stringify({
      providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }], defaultProviderId: '__fake__',
    }, null, 2), 'utf8');
  }
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const vault = InMemoryVault.forDataRoot(root);
  const writes: Engine['writes'] = [];
  if (!(vault as any).__f11cTapped) {
    const origSet = vault.set.bind(vault);
    vault.set = (k: string, v: string): void => { ((vault as any).__f11cWrites as Engine['writes']).push({ key: k, value: v }); origSet(k, v); };
    (vault as any).__f11cTapped = true;
  }
  (vault as any).__f11cWrites = writes;
  const raw = await startMinisd({ dataDir: root, host: '127.0.0.1', port: 0 });
  let closed = false;
  const local = await wsConnect(`ws://127.0.0.1:${raw.port}/?token=${raw.authToken}`);
  const close = async (): Promise<void> => { if (closed) return; closed = true; local.close(); await raw.close(); };
  cleanups.push(close);
  const fp = new StaticIdentity(new Uint8Array(Buffer.from(vault.get('pairing.static-identity')!, 'base64'))).fingerprint;
  return {
    dir: root, port: raw.port, listenPort: raw.listenPort, fp, local, vault, writes,
    pairingKeys: () => [...((vault as any).m as Map<string, string>).keys()].filter(k => k.startsWith('pairing.') && k !== 'pairing.static-identity'),
    close,
  };
}

async function bootEngines(): Promise<{ h: Engine; j: Engine }> {
  const h = await bootEngine();
  const j = await bootEngine();
  expect(await h.local.call('remote.pair.setPolicy', { policy: 'authenticated' })).toEqual({ ok: true, policy: 'authenticated' });
  return { h, j };
}
const begin = async (h: Engine): Promise<string> => String((await h.local.call('remote.pair.begin', {})).pairingCode);
const join2 = (j: Engine, port: number, code: string): Promise<any> =>
  j.local.call('remote.pair.join', { host: '127.0.0.1', port, pairingCode: code, peerName: 'J-设备', listenPort: j.listenPort });
const devices = async (e: Engine): Promise<any[]> => (await e.local.call('remote.status')).devices;
const pairRows = async (e: Engine): Promise<Array<{ eventType: string; payload: unknown }>> =>
  ((await e.local.call('audit.list', { limit: 500 })).rows as any[]).filter(r => String(r.eventType).startsWith('pair.'));

/** 审计里没有配对码（原样、带连字符），也没有握手中写进过 vault 的密钥。 */
async function expectAuditClean(e: Engine, code: string, extraWrites: Engine['writes'] = []): Promise<void> {
  const all = JSON.stringify((await e.local.call('audit.list', { limit: 500 })).rows);
  expect(all).not.toContain(code);
  expect(all).not.toContain(fmtPairingCode(code));
  for (const w of [...e.writes, ...extraWrites]) {
    if (!w.key.startsWith('pairing.') || w.key === 'pairing.static-identity') continue;
    const o = JSON.parse(w.value) as { authKey: string; sessionSecret: string };
    expect(all).not.toContain(o.authKey);
    expect(all).not.toContain(o.sessionSecret);
  }
}
const rewriteField = (dir: 'c2s' | 's2c', index: number, field: string, value: unknown) => (f: RelayFrame): string | void => {
  if (f.dir !== dir || f.index !== index) return;
  return JSON.stringify({ ...JSON.parse(f.text), [field]: value });
};

describe('V4 成功路径：策略 → 认证配对 → 加密通道 → 同步 → 解绑', () => {
  it('H 打开认证配对并发起，J 加入；J 上线且记录是 v2；J 写一条消息 H 收敛；解绑后连接当场断开、旧密钥再也握不上', async () => {
    const { h, j } = await bootEngines();
    const b = await h.local.call('remote.pair.begin', {});
    expect(b.protocol).toBe(2);
    expect(b.attempts).toBe(5);
    expect(b.pairingCode).toMatch(/^0[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{11}$/);
    expect(b.myFingerprint).toBe(h.fp);
    expect((await h.local.call('remote.status')).pairing).toMatchObject({ policy: 'authenticated', defaultPolicy: 'legacy', host: { protocol: 2, attemptsLeft: 5, inFlight: false } });

    expect(await join2(j, h.port, b.pairingCode)).toEqual({ ok: true, peerFingerprint: h.fp, protocol: 2 });
    await waitFor('J 经加密通道上线', async () => (await devices(j)).some(d => d.peerFingerprint === h.fp && d.online === true), 8000);
    expect((await devices(j))[0]).toMatchObject({ peerFingerprint: h.fp, pairingProtocol: 2, canUpgradePairing: false });
    expect((await devices(h))[0]).toMatchObject({ peerFingerprint: j.fp, peerName: 'J-设备', pairingProtocol: 2, address: `127.0.0.1:${j.listenPort}` });
    const st = (await h.local.call('remote.status')).pairing;
    expect(st.host).toBeUndefined();
    expect(st.lastHostOutcome).toMatchObject({ kind: 'paired', peerFingerprint: j.fp, replaced: false });

    // 同步：J（拨号方）写一条，H 收敛
    const s = await j.local.call('chat.sessions.create', { title: 'pair-v2' });
    await j.local.call('chat.prompt', { sessionId: s.id, text: '你好', providerId: '__fake__' });
    await waitFor('H 收到 J 的消息', async () => (await h.local.call('sync.pull', { sessionId: s.id })).messages.length > 0, 8000);

    // 审计：两端各有一条 paired，没有码和密钥
    expect((await pairRows(h)).map(r => r.eventType)).toEqual(expect.arrayContaining(['pair.policy', 'pair.begin', 'pair.paired']));
    expect((await pairRows(j)).map(r => r.eventType)).toEqual(['pair.paired']);
    await expectAuditClean(h, b.pairingCode, j.writes);
    await expectAuditClean(j, b.pairingCode, h.writes);

    // 解绑：H 当场断开 J 的连接；J 那把密钥再也握不上 H
    const keys = keysOfRaw(j.vault.get(`pairing.${h.fp}`)!);
    await h.local.call('remote.unpair', { peerFingerprint: j.fp });
    expect(await devices(h)).toEqual([]);
    await waitFor('J 掉线', async () => (await devices(j)).every(d => d.online === false), 8000);
    const d = await chDial(h.port, keys, j.fp, h.fp, 3000, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.sessions.list', params: {} }));
    expect(d.accepted).toBe(false);
    await d.closed;
    expect(d.totalFrames()).toBe(0);
  });

  it('策略写进 settings：重启同一数据根仍是 authenticated；默认是 legacy', async () => {
    const first = await bootEngine();
    expect((await first.local.call('remote.status')).pairing).toEqual({ policy: 'legacy', defaultPolicy: 'legacy' });
    expect((await first.local.call('remote.pair.begin', {})).protocol).toBe(1);
    await first.local.call('remote.pair.setPolicy', { policy: 'authenticated' });
    await first.close();
    const again = await bootEngine(first.dir);
    expect((await again.local.call('remote.status')).pairing.policy).toBe('authenticated');
    expect((await again.local.call('remote.pair.begin', {})).protocol).toBe(2);
    expect(again.fp).toBe(first.fp);
  });
});

describe('引擎级失败路径：两端都不留设备、不留密钥、审计里只有 begin 与 failed', () => {
  async function expectNothingLeft(h: Engine, j: Engine): Promise<void> {
    expect(await devices(h)).toEqual([]);
    expect(await devices(j)).toEqual([]);
    expect(h.pairingKeys()).toEqual([]);
    expect(j.pairingKeys()).toEqual([]);
  }
  async function expectAuditOnlyFailures(h: Engine, j: Engine, code: string): Promise<void> {
    const hTypes = (await pairRows(h)).map(r => r.eventType);
    const jTypes = (await pairRows(j)).map(r => r.eventType);
    expect(hTypes).toContain('pair.begin');
    for (const t of [...hTypes, ...jTypes]) expect(['pair.policy', 'pair.begin', 'pair.failed']).toContain(t);
    expect([...hTypes, ...jTypes]).not.toContain('pair.paired');
    await expectAuditClean(h, code, j.writes);
    await expectAuditClean(j, code, h.writes);
  }

  it('① 中继改 M1 的 id、M2 的 pB → J 得 PAIR_CONFIRM_FAILED；J 的出站没有上线', async () => {
    const { h, j } = await bootEngines();
    for (const tamper of [
      rewriteField('c2s', 0, 'id', Buffer.from(new StaticIdentity().publicKey).toString('base64url')),
      rewriteField('s2c', 0, 'pB', JSON.parse(new FakeJoiner(randomW()).hello()).pA),
    ]) {
      const code = await begin(h);
      const relay = await mitm(cleanups, h.port, tamper);
      expect(await pairCodeOf(join2(j, relay.port, code))).toBe('PAIR_CONFIRM_FAILED');
      await waitFor('H 收尾', async () => (await h.local.call('remote.status')).pairing.host?.inFlight === false);
      await expectNothingLeft(h, j);
      expect(j.writes.filter(w => w.key.startsWith('pairing.') && w.key !== 'pairing.static-identity')).toEqual([]);
      await expectAuditOnlyFailures(h, j, code);
    }
    expect((await pairRows(j)).map(r => r.payload)).toEqual([
      { kind: 'failed', protocol: 2, role: 'join', code: 'PAIR_CONFIRM_FAILED' },
      { kind: 'failed', protocol: 2, role: 'join', code: 'PAIR_CONFIRM_FAILED' },
    ]);
  });

  it('② 中继改 M3 的 cA（J 已落盘再回滚）→ PAIR_PEER_REJECTED；J 那次写入过的密钥在两端都握不上，握手后紧跟的业务请求没有回包', async () => {
    const { h, j } = await bootEngines();
    const code = await begin(h);
    const relay = await mitm(cleanups, h.port, rewriteField('c2s', 1, 'cA', Buffer.alloc(32, 9).toString('base64url')));
    expect(await pairCodeOf(join2(j, relay.port, code))).toBe('PAIR_PEER_REJECTED');
    await expectNothingLeft(h, j);
    const written = j.writes.filter(w => w.key === `pairing.${h.fp}`);
    expect(written).toHaveLength(1);                          // J 确实先落过盘
    const keys = keysOfRaw(written[0].value);
    const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.sessions.list', params: {} });
    for (const [port, myFp, peerFp] of [[h.port, j.fp, h.fp], [j.port, h.fp, j.fp]] as const) {
      const d = await chDial(port, keys, myFp, peerFp, 3000, req);
      expect(d.accepted).toBe(false);
      await d.closed;
      expect(d.totalFrames()).toBe(0);
    }
    await expectAuditOnlyFailures(h, j, code);
  });

  it('③ 重放：录下一次失败握手的 M1 与 M3，在新连接上原样重放 → 失败帧，H 无设备', async () => {
    const { h, j } = await bootEngines();
    const code = await begin(h);
    const relay = await mitm(cleanups, h.port, rewriteField('c2s', 1, 'cA', Buffer.alloc(32, 9).toString('base64url')));
    expect(await pairCodeOf(join2(j, relay.port, code))).toBe('PAIR_PEER_REJECTED');
    const [m1, m3] = relay.frames.filter(f => f.dir === 'c2s').map(f => f.text);   // m3 是改写之前、J 发出的原文
    const c = await rawPair(h.port);
    expect(c.status).toBeUndefined();                         // 码还在（只用掉 1 次）
    c.send(m1);
    await c.waitFrames(1);
    c.send(m3);
    await c.waitFrames(2);
    expect(c.frames[1]).toBe(PAIR_FAIL_FRAME);
    expect((await h.local.call('remote.status')).pairing.host).toMatchObject({ attemptsLeft: 3 });
    await expectNothingLeft(h, j);
    await expectAuditOnlyFailures(h, j, code);
  });

  it('④ 错码 5 次后用正确的码加入 → PAIR_NO_PENDING；H 的结局是 PAIR_ATTEMPTS_EXHAUSTED', async () => {
    const { h, j } = await bootEngines();
    const code = await begin(h);
    for (let i = 0; i < 5; i++) {
      const c = await rawPair(h.port);
      expect(c.status, `第 ${i + 1} 次`).toBeUndefined();
      const a = new FakeJoiner(randomW());
      c.send(a.hello());
      await c.waitFrames(1);
      a.onReply(c.frames[0]);
      c.send(a.confirm());
      await c.waitFrames(2);
      expect(c.frames[1]).toBe(PAIR_FAIL_FRAME);
      await c.closed;
    }
    expect(await pairCodeOf(join2(j, h.port, code))).toBe('PAIR_NO_PENDING');
    const st = (await h.local.call('remote.status')).pairing;
    expect(st.host).toBeUndefined();
    expect(st.lastHostOutcome).toMatchObject({ kind: 'failed', code: 'PAIR_ATTEMPTS_EXHAUSTED' });
    await expectNothingLeft(h, j);
    await expectAuditOnlyFailures(h, j, code);
    expect((await pairRows(h)).filter(r => r.eventType === 'pair.failed')).toHaveLength(6);
  });

  it('没扣次数的垃圾连接不进审计：30 条不合规的连接之后 audit 里没有 pair.failed；扣了次数的失败恰好多一行', async () => {
    // 这些连接不扣次数、也不限次。它们若各记一行，同网段任何人都能在码待用期间无限写 audit_logs，
    // 而审计表是定长轮转的：真实的权限审计记录会被挤掉
    const h = await bootEngine();
    await h.local.call('remote.pair.setPolicy', { policy: 'authenticated' });
    await begin(h);
    for (let i = 0; i < 30; i++) {
      const c = await rawPair(h.port);
      expect(c.status, `第 ${i + 1} 条`).toBeUndefined();
      c.send('not-a-pair-frame');
      await c.waitFrames(1);
      expect(c.frames).toEqual([PAIR_FAIL_FRAME]);
      await c.closed;
    }
    expect((await h.local.call('remote.status')).pairing.host).toMatchObject({ attemptsLeft: 5, inFlight: false });
    expect((await pairRows(h)).map(r => r.eventType).sort()).toEqual(['pair.begin', 'pair.policy']);

    // 对照：扣了次数的失败照常进审计
    const c = await rawPair(h.port);
    const a = new FakeJoiner(randomW());
    c.send(a.hello());
    await c.waitFrames(1);
    a.onReply(c.frames[0]);
    c.send(a.confirm());
    await c.waitFrames(2);
    await c.closed;
    expect((await pairRows(h)).filter(r => r.eventType === 'pair.failed').map(r => r.payload))
      .toEqual([{ kind: 'failed', protocol: 2, role: 'host', code: 'PAIR_CONFIRM_FAILED' }]);
  });

  it('取消真的到了引擎：remote.pair.cancel 之后那个码进不来，审计记一条 pair.cancelled', async () => {
    const { h, j } = await bootEngines();
    const code = await begin(h);
    expect(await h.local.call('remote.pair.cancel', {})).toEqual({ ok: true, cancelled: true });
    expect(await pairCodeOf(join2(j, h.port, code))).toBe('PAIR_NO_PENDING');
    expect((await pairRows(h)).map(r => r.eventType)).toEqual(expect.arrayContaining(['pair.begin', 'pair.cancelled']));
    await expectNothingLeft(h, j);
  });
});
