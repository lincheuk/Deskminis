/** F11C：受控中间人与被动抓包（任务卡验收 1；阻断 1、2）。
 *
 *  中继夹在真实的发起端 H 与加入端 J 之间，逐项替换握手里的公钥与协议字段——替换成的公钥与点都是合法值。
 *  每一例两端都不能留下配对记录、不能获得任何业务权限；握手中出现过的密钥握不了加密通道。
 *  被动抓包：一次成功配对的全部帧、升级请求、原始字节里都找不到配对码与派生密钥。 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  FakeJoiner, FaultVault, beginOn, bootNode, expectNoResidue, fakeHost, joinVia, mitm, pairCodeOf, randomW, rawPair,
  tap, waitFor, type Cleanups, type RelayFrame, type TestNode,
} from './pair-v2-util';
import { PAIR_FAIL_FRAME, derivePasswordScalar } from '../src/minisd/remote/pair-proto';
import { spake2Password, spake2Share } from '../src/minisd/remote/spake2';
import { StaticIdentity } from '../src/minisd/remote/pairing';
import { fmtPairingCode } from '../src/renderer/src/lib/devices/fmt';

const cleanups: Cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const otherKey = (): string => b64u(new StaticIdentity().publicKey);
const otherPoint = (role: 'A' | 'B'): string => b64u(spake2Share(role, spake2Password(randomW())).share);
const otherMac = (): string => b64u(new Uint8Array(randomBytes(32)));
const hostIdle = (h: TestNode): boolean => { const s = h.service.pairingStatus().host; return s === undefined || s.inFlight === false; };

/** 改写第 index 帧（按方向计数）里的一个字段。 */
function rewrite(dir: 'c2s' | 's2c', index: number, field: string, value: unknown) {
  return (f: RelayFrame): string | void => {
    if (f.dir !== dir || f.index !== index) return;
    const o = JSON.parse(f.text);
    expect(o, `帧里应当有 ${field}`).toHaveProperty(field);
    o[field] = value;
    return JSON.stringify(o);
  };
}

describe('① 对照组：原样中继', () => {
  it('中继不改任何东西时配对成功，J 随后经加密通道连上 H（夹具本身不破坏协议）', async () => {
    const h = await bootNode(cleanups);
    const j = await bootNode(cleanups);
    const { code } = await beginOn(h);
    const relay = await mitm(cleanups, h.port);
    const r = await joinVia(j, relay.port, code, { peerName: 'J-name', listenPort: j.port });
    expect(r).toEqual({ ok: true, peerFingerprint: h.fp, protocol: 2 });
    expect(relay.frames.map(f => `${f.dir}:${JSON.parse(f.text).t}`)).toEqual([
      'c2s:dm.pair.hello', 's2c:dm.pair.reply', 'c2s:dm.pair.confirm', 's2c:dm.pair.done',
    ]);
    // 两端导出同一把密钥、互为对端；H 从握手里记下 J 的监听地址
    const atH = h.store.get(j.fp)!;
    const atJ = j.store.get(h.fp)!;
    expect(Buffer.from(atH.authKey).toString('hex')).toBe(Buffer.from(atJ.authKey).toString('hex'));
    expect(Buffer.from(atH.sessionSecret).toString('hex')).toBe(Buffer.from(atJ.sessionSecret).toString('hex'));
    expect(atH.roomId).toBe(atJ.roomId);
    expect(atH).toMatchObject({ peerName: 'J-name', pairingProtocol: 2 });
    expect(atJ).toMatchObject({ peerName: 'J-name', pairingProtocol: 2 });
    expect(h.store.getAddress(j.fp)).toBe(`127.0.0.1:${j.port}`);
    // J 单方拨号：用刚导出的密钥握 ?ch=1（经同一个中继），sync.hello 互认后在线
    await waitFor('J 经加密通道连上 H', async () => {
      const st = await j.local.call('remote.status');
      return st.devices.some((d: any) => d.peerFingerprint === h.fp && d.online === true && d.pairingProtocol === 2);
    });
    expect(h.rpc.isInboundOnline(j.fp)).toBe(true);
    expect(h.events.map(e => e.kind)).toEqual(['begin', 'paired']);
    expect(j.events).toEqual([{ kind: 'paired', protocol: 2, role: 'join', peerFingerprint: h.fp, replaced: false }]);
  });
});

describe('② 逐项改写握手字段：任何一项被改，两端都不留记录', () => {
  const cases: Array<{ name: string; dir: 'c2s' | 's2c'; index: number; field: string; value: () => unknown; code: string }> = [
    { name: 'M1 的 id（换成另一把合法公钥）', dir: 'c2s', index: 0, field: 'id', value: otherKey, code: 'PAIR_CONFIRM_FAILED' },
    { name: 'M1 的 pA（换成另一个合法的点）', dir: 'c2s', index: 0, field: 'pA', value: () => otherPoint('A'), code: 'PAIR_CONFIRM_FAILED' },
    { name: 'M1 的 name', dir: 'c2s', index: 0, field: 'name', value: () => 'evil', code: 'PAIR_CONFIRM_FAILED' },
    { name: 'M1 的 listenPort', dir: 'c2s', index: 0, field: 'listenPort', value: () => 6666, code: 'PAIR_CONFIRM_FAILED' },
    { name: 'M1 的 v', dir: 'c2s', index: 0, field: 'v', value: () => 3, code: 'PAIR_PEER_REJECTED' },
    { name: 'M1 的 suite', dir: 'c2s', index: 0, field: 'suite', value: () => 'SPAKE2-P256-SHA512-HKDF-HMAC', code: 'PAIR_PEER_REJECTED' },
    { name: 'M2 的 id（换成另一把合法公钥）', dir: 's2c', index: 0, field: 'id', value: otherKey, code: 'PAIR_CONFIRM_FAILED' },
    { name: 'M2 的 pB（换成另一个合法的点）', dir: 's2c', index: 0, field: 'pB', value: () => otherPoint('B'), code: 'PAIR_CONFIRM_FAILED' },
    { name: 'M2 的 cB', dir: 's2c', index: 0, field: 'cB', value: otherMac, code: 'PAIR_CONFIRM_FAILED' },
    { name: 'M2 的 v', dir: 's2c', index: 0, field: 'v', value: () => 1, code: 'PAIR_PROTOCOL' },
    { name: 'M3 的 cA', dir: 'c2s', index: 1, field: 'cA', value: otherMac, code: 'PAIR_PEER_REJECTED' },
  ];

  for (const c of cases) {
    it(`改 ${c.name} → J 得 ${c.code}`, async () => {
      const hv = new FaultVault();
      const jv = new FaultVault();
      const h = await bootNode(cleanups, { vault: hv });
      const j = await bootNode(cleanups, { vault: jv });
      const { code } = await beginOn(h);
      const relay = await mitm(cleanups, h.port, rewrite(c.dir, c.index, c.field, c.value()));
      expect(await pairCodeOf(joinVia(j, relay.port, code, { peerName: 'J-name', listenPort: j.port }))).toBe(c.code);
      await waitFor('H 收尾', () => hostIdle(h));

      expect(hv.pairingSets(), 'H 不该写任何配对记录').toEqual([]);
      const leaked = jv.writtenKeys(h.fp);
      if (c.field === 'cA') {
        // 改 cA 时 J 已经先落盘（暂存），随后回滚
        expect(leaked).toHaveLength(1);
        expect(relay.forwarded.at(-1)).toMatchObject({ dir: 's2c', text: PAIR_FAIL_FRAME });
      } else {
        expect(jv.pairingSets(), 'J 不该写任何配对记录').toEqual([]);
        expect(relay.frames.some(f => f.text.includes('dm.pair.confirm')), 'J 不该发出 confirm').toBe(false);
      }
      await expectNoResidue(h, j.fp, leaked);
      await expectNoResidue(j, h.fp, leaked);
      // 被替换成的身份同样没有记录
      expect(h.store.list()).toEqual([]);
      expect(j.store.list()).toEqual([]);
      if (c.field === 'listenPort') expect(readOrEmpty(h, 'peer-addresses.json')).not.toContain('6666');
      expect(h.events.some(e => e.kind === 'paired')).toBe(false);
      expect(j.events.some(e => e.kind === 'paired')).toBe(false);
    });
  }
});

function readOrEmpty(n: TestNode, name: string): string {
  try { return readFileSync(join(n.dir, name), 'utf8'); } catch { return ''; }
}

describe('③ 不知道码的完整中间人：对 J 扮 H、对 H 扮 J，各跑一遍 SPAKE2', () => {
  it('J 一侧：验不过 cB，什么都不写、不发 confirm；H 一侧：攻击者验不过 cB，它的 cA 也过不了', async () => {
    const hv = new FaultVault();
    const jv = new FaultVault();
    const h = await bootNode(cleanups, { vault: hv });
    const j = await bootNode(cleanups, { vault: jv });
    const { code } = await beginOn(h);

    // 对 J 扮 H（攻击者不知道码，只能猜一个 w）
    const evilHost = await fakeHost(cleanups, { w: randomW() });
    expect(await pairCodeOf(joinVia(j, evilHost.port, code, { peerName: 'J-name', listenPort: j.port }))).toBe('PAIR_CONFIRM_FAILED');
    expect(jv.pairingSets()).toEqual([]);
    expect(evilHost.received).toHaveLength(1);
    expect(evilHost.received[0]).toContain('dm.pair.hello');
    expect(evilHost.keys()).toBeUndefined();

    // 对 H 扮 J
    const evil = new FakeJoiner(randomW());
    const c = await rawPair(h.port);
    c.send(evil.hello('J-name', j.port));
    await c.waitFrames(1);
    expect(evil.onReply(c.frames[0]).cBok).toBe(false);      // 攻击者这一次猜测被否定
    c.send(evil.confirm());
    await c.waitFrames(2);
    expect(c.frames[1]).toBe(PAIR_FAIL_FRAME);
    expect(hv.pairingSets()).toEqual([]);

    await expectNoResidue(h, j.fp);
    await expectNoResidue(h, evil.fp, [evil.keys()]);
    await expectNoResidue(j, h.fp);
    await expectNoResidue(j, evilHost.fp);
    expect(h.service.pairingStatus().host?.attemptsLeft).toBe(4);
  });
});

describe('被动抓包：线路上没有配对码，也没有派生密钥', () => {
  it('一次成功配对的全部解码帧、升级请求、原始字节里都搜不到码、w、两端的密钥；URL 里只有 ?pair=2', async () => {
    const h = await bootNode(cleanups);
    const j = await bootNode(cleanups);
    const { code } = await beginOn(h);
    const relay = await mitm(cleanups, h.port);
    const wire = await tap(cleanups, relay.port);
    await joinVia(j, wire.port, code, { peerName: 'J-name', listenPort: j.port });

    const w = await derivePasswordScalar(code);
    const wBytes = Buffer.from(w.toString(16).padStart(64, '0'), 'hex');
    const key = h.store.get(j.fp)!;
    expect(j.store.get(h.fp)).toBeDefined();
    const codeBuf = Buffer.from(code, 'utf8');
    const needles: Array<[string, string]> = [
      ['码原样', code], ['码带连字符', fmtPairingCode(code)], ['码小写', code.toLowerCase()],
      ['码去掉标记位', code.slice(1)], ['码的前 8 位', code.slice(0, 8)],
      ['码 base64', codeBuf.toString('base64')], ['码 base64url', codeBuf.toString('base64url')], ['码 hex', codeBuf.toString('hex')],
      ['w hex', wBytes.toString('hex')], ['w base64url', wBytes.toString('base64url')], ['w base64', wBytes.toString('base64')],
      ['字面量 pairingCode', 'pairingCode'],
    ];
    for (const [label, k] of [['authKey', key.authKey], ['sessionSecret', key.sessionSecret]] as const) {
      const b = Buffer.from(k);
      needles.push([`${label} hex`, b.toString('hex')], [`${label} base64`, b.toString('base64')], [`${label} base64url`, b.toString('base64url')]);
    }

    const decoded = relay.frames.map(f => f.text).join('\n');
    const upgrades = JSON.stringify(relay.upgrades);
    const rawText = wire.all().toString('latin1');
    for (const [label, needle] of needles) {
      expect(decoded.includes(needle), `解码帧里出现了 ${label}`).toBe(false);
      expect(upgrades.includes(needle), `升级请求里出现了 ${label}`).toBe(false);
      expect(rawText.includes(needle), `原始字节里出现了 ${label}`).toBe(false);
    }
    // 原始字节里也没有密钥与 w 的原始字节串
    for (const b of [Buffer.from(key.authKey), Buffer.from(key.sessionSecret), wBytes]) expect(wire.all().includes(b)).toBe(false);

    // 正向对照：抓到的确实是这次握手
    // （配对成功后 J 会经同一条链路拨 ?ch=1，所以升级请求可能不止一个；配对那一个排在最前）
    expect(relay.upgrades[0].url).toBe('/?pair=2');
    expect(relay.upgrades.map(u => u.url).filter(u => u !== '/?ch=1')).toEqual(['/?pair=2']);
    expect(relay.upgrades[0].headers.origin).toBeUndefined();
    expect(wire.c2s().toString('latin1')).toContain('GET /?pair=2 HTTP/1.1');
    expect(decoded).toContain('dm.pair.hello');
    expect(decoded).toContain('dm.pair.reply');
    // H→J 方向的帧不加掩码：原始字节里能看到 reply（说明转发器确实录到了帧）
    expect(wire.s2c().toString('latin1')).toContain('dm.pair.reply');
  });
});

describe('源码守卫', () => {
  const read = (name: string): string => readFileSync(join(__dirname, '../src/minisd/remote', name), 'utf8');
  it('加入端的代码里不出现 pairingCode：码不进 URL、不进任何帧', () => {
    expect(read('pair-join.ts')).not.toContain('pairingCode');
    expect(read('pair-join.ts')).toContain('/?pair=2');
  });
  it('两端的握手代码不借传输层外壳来声称防中间人（不出现 wss:、https、tls）', () => {
    for (const name of ['pair-join.ts', 'pair-host.ts']) {
      const src = read(name);
      expect(src, name).not.toMatch(/wss:/i);
      expect(src, name).not.toMatch(/https/i);
      expect(src, name).not.toMatch(/tls/i);
    }
  });
});
