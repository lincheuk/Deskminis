/** F11C：配对策略、码格式分派、不接受明文降级（任务卡验收 4；阻断 2）、共享契约与文档守卫。
 *
 *  默认策略是 legacy（独立密码学审查通过前不翻默认值）。打开 authenticated 之后旧的明文入口整体关闭；
 *  认证配对码的任何一部分都不该被当成旧码明文发出去；万一被不支持认证配对的版本明文发了出来，那个码当场作废。 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FaultVault, beginOn, bootNode, countingServer, joinVia, mitm, pairCodeOf, rawConnect, rawPair, upgradeOutcome, waitFor, type Cleanups, type TestNode,
} from './pair-v2-util';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingService, PairingStore, StaticIdentity, generatePairingCode, generatePairingCodeV2, type PairedNotice, type PairingKey } from '../src/minisd/remote/pairing';
import { createRemoteMethods } from '../src/minisd/remote';
import type { RpcConnection } from '../src/minisd/rpc/server';
import { PAIRING_POLICY_KEY } from '../src/minisd/store/settings';
import { SYNC_CAP, LOCAL_SYNC_CAPS } from '../src/minisd/sync/wire';
import {
  DEFAULT_PAIRING_POLICY, PAIRING_CODE_ALPHABET, PAIR_ERROR_TEXT, PAIR_PEER_LEGACY_DISABLED_TEXT, PairError, classifyPairingCode, pairErrorCodeOf,
} from '../src/shared/pairing';

const cleanups: Cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const repoRoot = join(__dirname, '..', '..');
const conn = (authMode: 'local' | 'pairing' | 'remote', extra: Partial<RpcConnection> = {}): RpcConnection => ({ authMode, notify: () => { /* */ }, ...extra });
const hostState = (h: TestNode) => h.service.pairingStatus().host;
const outcome = (h: TestNode) => h.service.pairingStatus().lastHostOutcome;
const codeOfSync = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof PairError ? e.code : `非 PairError: ${String(e)}`; }
  return undefined;
};
function tmpStore(): { dir: string; vault: InMemoryVault; store: PairingStore } {
  const dir = mkdtempSync(join(tmpdir(), 'dm-policy-'));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
  const vault = new InMemoryVault();
  return { dir, vault, store: new PairingStore(dir, vault) };
}
function keyFor(fp: string, fill: number, proto?: 2): PairingKey {
  return { authKey: new Uint8Array(32).fill(fill), sessionSecret: new Uint8Array(32).fill(fill + 1), roomId: 'ROOMROOM', peerFingerprint: fp, peerName: 'peer', createdAt: 1_700_000_000, pairingProtocol: proto };
}

describe('开关策略：默认 legacy，审查通过前不翻默认值', () => {
  it('DEFAULT_PAIRING_POLICY 是 legacy；要翻成 authenticated，仓库里必须先有独立密码学审查的记录', () => {
    if ((DEFAULT_PAIRING_POLICY as string) === 'authenticated') {
      expect(existsSync(join(repoRoot, 'docs', 'security', 'f11c-crypto-review.md')), '翻默认值之前要有 docs/security/f11c-crypto-review.md').toBe(true);
    } else {
      expect(DEFAULT_PAIRING_POLICY).toBe('legacy');
    }
  });
  it('两参构造的 PairingService（既有调用方式）策略为 legacy，出的是 8 位旧码', async () => {
    const { store, vault } = tmpStore();
    const service = new PairingService(store, vault);
    expect(service.policy()).toBe('legacy');
    const methods = createRemoteMethods(service);
    const r = await methods['remote.pair.begin']!({}, conn('local')) as any;
    expect(r.protocol).toBe(1);
    expect(r.pairingCode).toHaveLength(8);
    expect(r.attempts).toBeUndefined();
    expect(service.pairingStatus()).toEqual({ policy: 'legacy', defaultPolicy: 'legacy' });
  });
  it('策略的持久化键是 pairing.policy', () => {
    expect(PAIRING_POLICY_KEY).toBe('pairing.policy');
  });
  it('setPolicy 清空 v1 与 v2 的待用码，并发 policy 事件', async () => {
    const h = await bootNode(cleanups, { policy: 'legacy' });
    const v1 = await beginOn(h);
    expect(h.service.hasPending(v1.code)).toBe(true);
    expect(await h.local.call('remote.pair.setPolicy', { policy: 'authenticated' })).toEqual({ ok: true, policy: 'authenticated' });
    expect(h.policy.value).toBe('authenticated');
    h.policy.value = 'legacy';                               // 绕过 setPolicy 切回去看：那个 v1 码确实被清了，不只是被策略挡住
    expect(h.service.hasPending(v1.code)).toBe(false);

    h.policy.value = 'authenticated';
    const v2 = await beginOn(h);
    expect(v2.protocol).toBe(2);
    expect(hostState(h)).toBeDefined();
    await h.local.call('remote.pair.setPolicy', { policy: 'legacy' });
    expect(hostState(h)).toBeUndefined();
    expect((await rawPair(h.port)).status).toBe(401);
    expect(h.events.filter(e => e.kind === 'policy')).toEqual([{ kind: 'policy', policy: 'authenticated' }, { kind: 'policy', policy: 'legacy' }]);
    await expect(h.local.call('remote.pair.setPolicy', { policy: 'whatever' })).rejects.toThrow(/legacy 或 authenticated/);
    await expect(h.local.call('remote.pair.setPolicy', {})).rejects.toThrow(/legacy 或 authenticated/);
    expect(h.policy.value).toBe('legacy');
  });
  it('策略写入失败原样向上抛，不发事件', () => {
    const { store, vault } = tmpStore();
    const events: unknown[] = [];
    const service = new PairingService(store, vault, {
      policy: { get: () => 'legacy', set: () => { throw new Error('settings 写失败'); } },
      onEvent: e => events.push(e),
    });
    expect(() => service.setPolicy('authenticated')).toThrow('settings 写失败');
    expect(events).toEqual([]);
  });
  it('事件回调抛错被吞掉，不影响配对流程', () => {
    const { store, vault } = tmpStore();
    const service = new PairingService(store, vault, { onEvent: () => { throw new Error('审计写失败'); } });
    expect(() => service.beginPairing()).not.toThrow();
    expect(() => service.setPolicy('authenticated')).not.toThrow();
  });
  it('受理路径上现读策略失败按拒绝处理：?pairingCode=<有效码> 得 401，没有未捕获异常；begin 抛错且不建状态；恢复后那个码仍可用', async () => {
    const h = await bootNode(cleanups, { policy: 'legacy' });
    const v1 = await beginOn(h);
    // 异常若从升级回调里抛出去，会成为进程级的未捕获异常（独立运行的引擎遇到它就退出）。自己收着，下面断言一条都没有
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => { uncaught.push(e); };
    process.on('uncaughtException', onUncaught);
    cleanups.push(() => { process.off('uncaughtException', onUncaught); });
    // 让策略读取抛错（引擎里它是读 settings 表）
    let broken = true;
    Object.defineProperty(h.policy, 'value', {
      configurable: true,
      get: () => { if (broken) throw new Error('settings 读失败'); return 'legacy'; },
      set: () => { /* 本例不改策略 */ },
    });
    const eventsBefore = h.events.length;

    // 坏实现下对端收不到任何应答（既没有 101 也没有 401）：'no-response' 就是那种失败
    expect(await upgradeOutcome(`ws://127.0.0.1:${h.port}/?pairingCode=${v1.code}`)).toBe(401);
    expect(uncaught.map(String)).toEqual([]);
    expect(await h.local.call('echo', { still: 'alive' })).toEqual({ still: 'alive' });   // 本机连接照常
    // begin / join 里读失败：这次调用抛错，不建任何状态
    await expect(h.local.call('remote.pair.begin', {})).rejects.toThrow('settings 读失败');
    expect(h.events.length).toBe(eventsBefore);

    broken = false;
    expect(h.service.pairingStatus()).toEqual({ policy: 'legacy', defaultPolicy: 'legacy' });   // 没有 v2 的 host 状态
    expect(await upgradeOutcome(`ws://127.0.0.1:${h.port}/?pairingCode=${v1.code}`), '恢复后同一个码仍连得上').toBe('open');
    expect(uncaught.map(String)).toEqual([]);
  });
});

describe('V4 不接受明文降级', () => {
  it('authenticated 下 ?pairingCode=（含策略切换前残留的 v1 码）→ 401；legacy 下 ?pair=2 → 401', async () => {
    const h = await bootNode(cleanups, { policy: 'legacy' });
    const v1 = await beginOn(h);
    expect((await rawPair(h.port)).status).toBe(401);                       // legacy：没有 v2 码
    h.policy.value = 'authenticated';                                        // 残留的 v1 码还在 pending 里
    expect((await rawConnect(`ws://127.0.0.1:${h.port}/?pairingCode=${v1.code}`)).status).toBe(401);
    expect(h.service.hasPending(v1.code)).toBe(false);
    h.policy.value = 'legacy';
    const ok = await rawConnect(`ws://127.0.0.1:${h.port}/?pairingCode=${v1.code}`);
    expect(ok.status, '对照：legacy 下同一个码连得上').toBeUndefined();
    ok.close();
  });

  it('authenticated 下服务层的 v1 入口全拒；直接调 remote.pair.complete → PAIR_LEGACY_DISABLED 并关连接', async () => {
    const h = await bootNode(cleanups, { policy: 'legacy' });
    const v1 = await beginOn(h);
    h.policy.value = 'authenticated';
    const peer = new StaticIdentity();
    const pub = Buffer.from(peer.publicKey).toString('base64');
    expect(codeOfSync(() => h.service.beginPairing())).toBe('PAIR_LEGACY_DISABLED');
    expect(codeOfSync(() => h.service.completePairing(v1.code, pub, peer.fingerprint, 'n'))).toBe('PAIR_LEGACY_DISABLED');
    expect(codeOfSync(() => h.service.joinPairing(pub, peer.fingerprint, 'n', v1.code, '127.0.0.1:1'))).toBe('PAIR_LEGACY_DISABLED');
    let closed = false;
    const methods = createRemoteMethods(h.service);
    await expect(methods['remote.pair.complete']!(
      { pairingCode: v1.code, peerPublicKey: pub, peerFingerprint: peer.fingerprint }, conn('pairing', { closeAfterReply: () => { closed = true; } }),
    )).rejects.toThrow(/^PAIR_LEGACY_DISABLED: /);
    expect(closed).toBe(true);
    expect(h.store.list()).toEqual([]);
  });

  it('J 为 authenticated 时输入 8 位旧码 → 本地拒绝，目标端口上 0 个连接', async () => {
    const j = await bootNode(cleanups, { policy: 'authenticated' });
    const target = await countingServer(cleanups);
    expect(await pairCodeOf(joinVia(j, target.port, 'ABCD2345'))).toBe('PAIR_LEGACY_DISABLED');
    expect(target.connections()).toBe(0);
  });

  it('J 的 v2 加入遇到 401：得 PAIR_NO_PENDING，没有改走 ?pairingCode=（目标上没有任何带 pairingCode 的请求）', async () => {
    const code = generatePairingCodeV2();
    for (const policy of ['legacy', 'authenticated'] as const) {
      const j = await bootNode(cleanups, { policy });
      const target = await bootNode(cleanups, { policy: 'legacy' });       // 没有 v2 码：?pair=2 一律 401
      expect(await pairCodeOf(joinVia(j, target.port, code))).toBe('PAIR_NO_PENDING');
      expect(target.upgradeLog).toEqual([]);
      // 换成只数连接的假服务器再看一遍：J 只发出过一个请求，是 ?pair=2
      const counter = await countingServer(cleanups);
      expect(await pairCodeOf(joinVia(j, counter.port, code))).toBe('PAIR_UNREACHABLE');
      expect(counter.connections()).toBe(1);
      expect(counter.requests.join('')).toContain('GET /?pair=2 HTTP/1.1');
      expect(counter.requests.join('')).not.toContain('pairingCode');
      expect(counter.requests.join('')).not.toContain(code);
    }
  });

  it('v1 不得覆盖已有的 v2 记录：completePairing（自报该指纹）与 joinPairing 都抛 PAIR_LEGACY_DISABLED，v2 记录原文不变', () => {
    const { store, vault } = tmpStore();
    const service = new PairingService(store, vault);                       // 默认策略 legacy：这道闸与策略无关
    const peer = new StaticIdentity();
    const pub = Buffer.from(peer.publicKey).toString('base64');
    store.commit(keyFor(peer.fingerprint, 9, 2));
    const raw = vault.get(`pairing.${peer.fingerprint}`);
    const { code } = service.beginPairing();
    expect(codeOfSync(() => service.completePairing(code, pub, peer.fingerprint, 'n'))).toBe('PAIR_LEGACY_DISABLED');
    expect(codeOfSync(() => service.joinPairing(pub, peer.fingerprint, 'n', code, '127.0.0.1:1'))).toBe('PAIR_LEGACY_DISABLED');
    expect(vault.get(`pairing.${peer.fingerprint}`)).toBe(raw);
    expect(service.get(peer.fingerprint)?.pairingProtocol).toBe(2);
    // 解绑之后才能改回旧方式
    service.delete(peer.fingerprint);
    expect(() => service.completePairing(code, pub, peer.fingerprint, 'n')).not.toThrow();
    expect(service.get(peer.fingerprint)?.pairingProtocol).toBe(1);
  });
});

describe('v1 不得覆盖 v2 记录：只在一侧解绑之后用 8 位旧码重配', () => {
  /** 先做一次认证配对，再把两端都切回 legacy（记录留着）。unpairOn：只在这一侧解绑。 */
  async function v2PairedThenLegacy(unpairOn: 'h' | 'j'): Promise<{ h: TestNode; j: TestNode; v1code: string }> {
    const h = await bootNode(cleanups);
    const j = await bootNode(cleanups);
    const v2 = await beginOn(h);
    await joinVia(j, h.port, v2.code, { peerName: 'J', listenPort: j.port });
    expect(h.store.get(j.fp)?.pairingProtocol).toBe(2);
    expect(j.store.get(h.fp)?.pairingProtocol).toBe(2);
    if (unpairOn === 'h') await h.local.call('remote.unpair', { peerFingerprint: j.fp });
    else await j.local.call('remote.unpair', { peerFingerprint: h.fp });
    await h.local.call('remote.pair.setPolicy', { policy: 'legacy' });
    await j.local.call('remote.pair.setPolicy', { policy: 'legacy' });
    const v1 = await beginOn(h);
    expect(v1.protocol).toBe(1);
    return { h, j, v1code: v1.code };
  }
  const failure = (p: Promise<unknown>): Promise<string> => p.then(() => '(没有失败)', e => (e instanceof Error ? e.message : String(e)));
  /** 设备页显示加入失败的办法：取得到错误码就显示它的文案，取不到显示原消息。 */
  const shownOnDevicePage = (msg: string): string => { const c = pairErrorCodeOf(msg); return c ? PAIR_ERROR_TEXT[c] : msg; };

  it('J 留着对端的 v2 记录（对端已单方解绑）：发请求之前就在本地拒绝——对端不落盘，配对码不消费、也没上线路', async () => {
    const { h, j, v1code } = await v2PairedThenLegacy('h');
    const rawJ = j.vault.get(`pairing.${h.fp}`);
    expect(await pairCodeOf(joinVia(j, h.port, v1code, { peerName: 'J', listenPort: j.port }))).toBe('PAIR_LEGACY_DISABLED');
    expect(h.upgradeLog, '没有任何请求到过对端的明文入口').toEqual([]);
    expect(h.store.get(j.fp), 'H 没有多出一条单侧的 v1 记录').toBeUndefined();
    expect((await h.local.call('remote.status')).devices).toEqual([]);
    expect(h.service.hasPending(v1code), '码没被消费').toBe(true);
    expect(j.vault.get(`pairing.${h.fp}`)).toBe(rawJ);
    expect(j.store.get(h.fp)?.pairingProtocol).toBe(2);
    // 这句文案的主语是本机：J 上确实有一条可以解绑的 v2 记录
    expect(PAIR_ERROR_TEXT.PAIR_LEGACY_DISABLED).toContain('得先解绑');
  });

  it('已声明的残余：对端换了地址时预检认不出来，仍由落盘前的闸拒绝——这时对端单侧留下一条 v1 记录', async () => {
    const { h, j, v1code } = await v2PairedThenLegacy('h');
    const rawJ = j.vault.get(`pairing.${h.fp}`);
    j.store.setAddress(h.fp, '127.0.0.1:1');                // 地址簿里记的不是这次要连的地址
    expect(await pairCodeOf(joinVia(j, h.port, v1code, { peerName: 'J', listenPort: j.port }))).toBe('PAIR_LEGACY_DISABLED');
    expect(j.vault.get(`pairing.${h.fp}`), 'J 的 v2 记录没被 v1 覆盖').toBe(rawJ);
    // 规格文档 §6 写明的状态：H 已落盘、码已消费；这条记录的密钥 J 没有存，通道握不上，要在 J 上解绑后重配
    expect(h.upgradeLog).toEqual([`?pairingCode=${v1code}`]);
    expect(h.store.get(j.fp)?.pairingProtocol).toBe(1);
    expect(h.service.hasPending(v1code)).toBe(false);
    expect(Buffer.from(h.store.get(j.fp)!.authKey).equals(Buffer.from(j.store.get(h.fp)!.authKey))).toBe(false);
  });

  it('对端留着本机的 v2 记录（本机已单方解绑）：J 看到的是以「对方」为主语的说明，不带内部方法名与错误码', async () => {
    const { h, j, v1code } = await v2PairedThenLegacy('j');
    const rawH = h.vault.get(`pairing.${j.fp}`);
    const msg = await failure(joinVia(j, h.port, v1code, { peerName: 'J', listenPort: j.port }));
    expect(msg).toBe(PAIR_PEER_LEGACY_DISABLED_TEXT);
    const shown = shownOnDevicePage(msg);
    expect(shown).toContain('对方');
    expect(shown).toContain('配对');
    expect(shown, '「这台机器」在 J 的界面上指的是 J，而要解绑的条目在对端').not.toContain('这台机器');
    expect(shown).not.toContain('remote.pair.complete');
    expect(shown).not.toMatch(/PAIR_[A-Z_]+/);
    // 两端的记录都没动：H 的 v2 记录原样，J 没有记录
    expect(h.vault.get(`pairing.${j.fp}`)).toBe(rawH);
    expect(j.store.get(h.fp)).toBeUndefined();
  });

  it('对端在 remote.pair.complete 上回的其它错误保持原样（带方法名前缀）', async () => {
    const h = await bootNode(cleanups, { policy: 'legacy' });
    const j = await bootNode(cleanups, { policy: 'legacy' });
    const v1 = await beginOn(h);
    // 中继把 complete 请求里的码换成别的：升级用的是真码，H 在 completePairing 里才发现码不对
    const relay = await mitm(cleanups, h.port, f => {
      if (f.dir !== 'c2s' || f.index !== 0) return;
      const m = JSON.parse(f.text);
      return JSON.stringify({ ...m, params: { ...m.params, pairingCode: 'ZZZZ9999' } });
    });
    expect(await failure(joinVia(j, relay.port, v1.code))).toMatch(/^remote\.pair\.complete: 配对码不存在或已失效/);
  });
});

describe('码格式与标记位（认证配对码不明文发给对端）', () => {
  it('generatePairingCodeV2 跑 200 次：都是 12 位，首位是 0，后 11 位都在字母表内，分类为 v2', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generatePairingCodeV2();
      expect(c).toHaveLength(12);
      expect(c[0]).toBe('0');
      for (const ch of c.slice(1)) expect(PAIRING_CODE_ALPHABET).toContain(ch);
      expect(classifyPairingCode(c)).toEqual({ kind: 'v2', code: c });
      seen.add(c);
    }
    expect(seen.size).toBe(200);
  });
  it('generatePairingCode（v1）不变：8 位、全在字母表内、不以 0 或 O 开头', () => {
    for (let i = 0; i < 100; i++) {
      const c = generatePairingCode();
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      expect(classifyPairingCode(c)).toEqual({ kind: 'v1' });
    }
  });

  for (const policy of ['legacy', 'authenticated'] as const) {
    it(`J（${policy}）输入一个 v2 码的前 8、9、10、11 位，或多输一位：PAIR_BAD_CODE_FORMAT，目标端口上 0 个连接`, async () => {
      const j = await bootNode(cleanups, { policy });
      const target = await countingServer(cleanups);
      const code = generatePairingCodeV2();
      for (const partial of [code.slice(0, 8), code.slice(0, 9), code.slice(0, 10), code.slice(0, 11), code + 'A', 'O' + code.slice(1, 8)]) {
        expect(await pairCodeOf(joinVia(j, target.port, partial)), partial.length + ' 位').toBe('PAIR_BAD_CODE_FORMAT');
      }
      expect(target.connections()).toBe(0);
      expect(j.events).toEqual([]);
    });
  }

  it('authMode 的检查先于码的分类：非 local 连接加任意码，报的是 authMode 的错', async () => {
    const { store, vault } = tmpStore();
    const methods = createRemoteMethods(new PairingService(store, vault));
    await expect(methods['remote.pair.join']!({ host: '127.0.0.1', port: 1, pairingCode: '0' }, conn('remote'))).rejects.toThrow(/local|authMode/);
    await expect(methods['remote.pair.join']!({ host: '127.0.0.1', port: 1, pairingCode: '' }, conn('local'))).rejects.toThrow('remote.pair.join 需要 pairingCode');
  });
});

describe('烧码规则：v1 的明文入口上出现了当前 v2 码（或它的一段），这个码当场作废', () => {
  const exposures: Array<[string, (code: string) => string]> = [
    ['8 位前缀（不支持认证配对的版本把输入截成 8 位）', c => c.slice(0, 8)],
    ['整码', c => c],
    ['去掉标记后的前 8 位（漏输了开头的 0）', c => c.slice(1, 9)],
    ['带连字符、小写的 8 位前缀', c => `${c.slice(0, 4)}-${c.slice(4, 8)}`.toLowerCase()],
  ];
  for (const [name, pick] of exposures) {
    it(`来码是${name} → 401、码作废、结局 PAIR_CODE_EXPOSED`, async () => {
      const h = await bootNode(cleanups);
      const { code } = await beginOn(h);
      expect((await rawConnect(`ws://127.0.0.1:${h.port}/?pairingCode=${encodeURIComponent(pick(code))}`)).status).toBe(401);
      expect(hostState(h)).toBeUndefined();
      expect(outcome(h)).toMatchObject({ kind: 'failed', code: 'PAIR_CODE_EXPOSED' });
      expect((await rawPair(h.port)).status).toBe(401);                     // 之后正确的码也进不来
      expect(h.events.at(-1)).toEqual({ kind: 'failed', protocol: 2, role: 'host', code: 'PAIR_CODE_EXPOSED' });
    });
  }
  it('不相干的来码、太短或太长的来码不作废（随机探测打不掉码），响应同样是 401', async () => {
    const h = await bootNode(cleanups);
    const { code } = await beginOn(h);
    for (const other of ['ZZZZ9999', code.slice(0, 7), code + 'A', code.slice(2, 10), '0' + code.slice(2, 9), 'x']) {
      expect((await rawConnect(`ws://127.0.0.1:${h.port}/?pairingCode=${other}`)).status, other.length + ' 位').toBe(401);
    }
    expect(hostState(h)).toMatchObject({ attemptsLeft: 5, inFlight: false });
    expect(outcome(h)).toBeUndefined();
  });
  it('remote.pair.complete 的参数里出现当前 v2 码的前缀 → 同样作废', async () => {
    const h = await bootNode(cleanups);
    const { code } = await beginOn(h);
    const methods = createRemoteMethods(h.service);
    await expect(methods['remote.pair.complete']!({ pairingCode: code.slice(0, 8), peerPublicKey: 'x', peerFingerprint: 'y' }, conn('pairing')))
      .rejects.toThrow(/^PAIR_LEGACY_DISABLED: /);
    expect(outcome(h)).toMatchObject({ kind: 'failed', code: 'PAIR_CODE_EXPOSED' });
  });
  it('握手在途时码被烧掉：在途握手随之失败，H 不落盘', async () => {
    const h = await bootNode(cleanups);
    const { code } = await beginOn(h);
    const c = await rawPair(h.port);
    expect(hostState(h)?.inFlight).toBe(true);
    await rawConnect(`ws://127.0.0.1:${h.port}/?pairingCode=${code.slice(0, 8)}`);
    expect(hostState(h)).toBeUndefined();
    c.send('{}');
    await c.waitFrames(1);
    expect(h.store.list()).toEqual([]);
    // 在途的那次握手没扣过次数：它的失败不另发事件，审计里只有烧码这一条
    expect(h.events.map(e => e.kind === 'failed' ? e.code : e.kind)).toEqual(['begin', 'PAIR_CODE_EXPOSED']);
  });
  it('新版的 J（legacy）漏掉开头的 0 又只输了 8 位：当成旧码明文发出，H 回 401 并作废那个码', async () => {
    const h = await bootNode(cleanups);
    const j = await bootNode(cleanups, { policy: 'legacy' });
    const { code } = await beginOn(h);
    await expect(joinVia(j, h.port, code.slice(1, 9))).rejects.toThrow(/配对码无效或已过期/);
    expect(h.upgradeLog).toEqual([`?pairingCode=${code.slice(1, 9)}`]);
    expect(outcome(h)).toMatchObject({ kind: 'failed', code: 'PAIR_CODE_EXPOSED' });
    expect(h.store.list()).toEqual([]);
    expect(j.store.list()).toEqual([]);
  });
});

describe('v1 路径在默认策略下原样可用', () => {
  it('v1 错码（字母表内的 8 位）→ 对端 401 → 「配对码无效或已过期」；目标端恰好收到一条带 pairingCode 的请求', async () => {
    const j = await bootNode(cleanups, { policy: 'legacy' });
    const target = await bootNode(cleanups, { policy: 'legacy' });
    await expect(joinVia(j, target.port, 'ZZZZ9999')).rejects.toThrow(/配对码无效或已过期/);
    expect(target.upgradeLog).toEqual(['?pairingCode=ZZZZ9999']);
  });
  it('两个 legacy 节点用 8 位码配对成功，记录的 pairingProtocol 是 1，返回里带 protocol: 1', async () => {
    const h = await bootNode(cleanups, { policy: 'legacy' });
    const j = await bootNode(cleanups, { policy: 'legacy' });
    const b = await beginOn(h);
    expect(b).toMatchObject({ protocol: 1 });
    expect(b.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    const r = await joinVia(j, h.port, b.code, { peerName: 'J', listenPort: j.port });
    expect(r).toEqual({ ok: true, peerFingerprint: h.fp, protocol: 1 });
    const st = await j.local.call('remote.status');
    expect(st.devices[0]).toMatchObject({ peerFingerprint: h.fp, pairingProtocol: 1 });
    expect(st.pairing).toEqual({ policy: 'legacy', defaultPolicy: 'legacy' });
    expect(h.events.map(e => e.kind)).toEqual(['begin']);    // v1 只有 begin 一条事件（protocol 1）
    expect(h.events[0]).toEqual({ kind: 'begin', protocol: 1 });
  });
  it('legacy 的 J 输入完整的 v2 码：按码格式跟随走认证配对（J 自己不用开开关）', async () => {
    const h = await bootNode(cleanups, { policy: 'authenticated' });
    const j = await bootNode(cleanups, { policy: 'legacy' });
    const { code } = await beginOn(h);
    expect(await joinVia(j, h.port, code.toLowerCase().replace(/^0/, 'o'))).toEqual({ ok: true, peerFingerprint: h.fp, protocol: 2 });
    expect(j.store.get(h.fp)?.pairingProtocol).toBe(2);
    expect(h.upgradeLog).toEqual([]);                        // 没有任何请求走到明文入口
  });
});

describe('新 RPC 只许 local', () => {
  it('pairing、remote 两种连接调 remote.pair.cancel / remote.pair.setPolicy 都被拒；策略与待用码不受影响', async () => {
    const legacy = await bootNode(cleanups, { policy: 'legacy' });
    const v1 = await beginOn(legacy);
    const auth = await bootNode(cleanups, { policy: 'authenticated' });
    await beginOn(auth);
    for (const node of [legacy, auth]) {
      const methods = createRemoteMethods(node.service);
      const before = node.policy.value;
      for (const mode of ['pairing', 'remote'] as const) {
        await expect(methods['remote.pair.cancel']!({}, conn(mode, { peerFingerprint: 'aabbccddeeff' }))).rejects.toThrow(/local|authMode/);
        await expect(methods['remote.pair.setPolicy']!({ policy: before === 'legacy' ? 'authenticated' : 'legacy' }, conn(mode, { peerFingerprint: 'aabbccddeeff' })))
          .rejects.toThrow(/local|authMode/);
      }
      expect(node.policy.value).toBe(before);
    }
    expect(legacy.service.hasPending(v1.code)).toBe(true);
    expect(hostState(auth)).toMatchObject({ attemptsLeft: 5, inFlight: false });
    expect([...legacy.events, ...auth.events].filter(e => e.kind === 'cancelled' || e.kind === 'policy')).toEqual([]);
  });
});

describe('J 侧的名字检查', () => {
  it('65 字节的名字、含换行的名字 → PAIR_BAD_NAME，目标端口上 0 个连接', async () => {
    const j = await bootNode(cleanups);
    const target = await countingServer(cleanups);
    const code = generatePairingCodeV2();
    expect(await pairCodeOf(joinVia(j, target.port, code, { peerName: 'a'.repeat(65) }))).toBe('PAIR_BAD_NAME');
    expect(await pairCodeOf(joinVia(j, target.port, code, { peerName: '中'.repeat(22) }))).toBe('PAIR_BAD_NAME');
    expect(await pairCodeOf(joinVia(j, target.port, code, { peerName: 'a\nb' }))).toBe('PAIR_BAD_NAME');
    expect(target.connections()).toBe(0);
  });
  it('恰好 64 字节的名字配对成功，两端存下的名字相同', async () => {
    const h = await bootNode(cleanups);
    const j = await bootNode(cleanups);
    const { code } = await beginOn(h);
    const name = '中'.repeat(21) + 'a';
    expect(Buffer.byteLength(name, 'utf8')).toBe(64);
    await joinVia(j, h.port, code, { peerName: name });
    expect(h.store.get(j.fp)?.peerName).toBe(name);
    expect(j.store.get(h.fp)?.peerName).toBe(name);
  });
  it('不传名字：H 存「未命名设备」', async () => {
    const h = await bootNode(cleanups);
    const j = await bootNode(cleanups);
    const { code } = await beginOn(h);
    await joinVia(j, h.port, code);
    expect(h.store.get(j.fp)?.peerName).toBe('未命名设备');
    expect(j.store.get(h.fp)?.peerName).toBe('未命名设备');
  });
  it('同一时刻只允许一个加入：第二个得 PAIR_BUSY', async () => {
    const j = await bootNode(cleanups);
    const code = generatePairingCodeV2();
    const target = await bootNode(cleanups, { policy: 'legacy' });
    const first = pairCodeOf(j.service.joinPairingV2({ host: '127.0.0.1', port: target.port, code }));
    expect(await pairCodeOf(j.service.joinPairingV2({ host: '127.0.0.1', port: target.port, code }))).toBe('PAIR_BUSY');
    expect(await first).toBe('PAIR_NO_PENDING');
    // 结束后槽位释放
    expect(await pairCodeOf(j.service.joinPairingV2({ host: '127.0.0.1', port: target.port, code }))).toBe('PAIR_NO_PENDING');
  });
});

describe('共享契约：remote.status 的 pairingProtocol / canUpgradePairing 与能力位登记', () => {
  it('SYNC_CAP 登记了 pairV2，本端声明里有它', () => {
    expect(SYNC_CAP.PAIR_V2).toBe('pairV2');
    expect(LOCAL_SYNC_CAPS).toEqual({ pairV2: true, attachments: true, tombstones: true });
    expect(Object.isFrozen(SYNC_CAP)).toBe(true);
  });
  it('save() 写的记录是 1，v2 是 2；canUpgradePairing 只在「v1 记录且对端声明 pairV2」时为真（出站、入站各一例）', async () => {
    const { store, vault } = tmpStore();
    const service = new PairingService(store, vault);
    const [viaOut, viaIn, silent, v2] = ['a00000000001', 'a00000000002', 'a00000000003', 'a00000000004'];
    store.save(keyFor(viaOut, 1));
    store.save(keyFor(viaIn, 2));
    store.save(keyFor(silent, 3));
    store.commit(keyFor(v2, 4, 2));
    const declared = { protocolVersion: 2, caps: { pairV2: true } };
    const methods = createRemoteMethods(service, {
      getOutbound: () => ({ isOnline: () => false, peerInfo: fp => (fp === viaOut || fp === v2 ? declared : fp === silent ? { protocolVersion: 2, caps: {} } : undefined) }),
      getRpcServer: () => ({ isInboundOnline: () => false, inboundSyncPeer: fp => (fp === viaIn || fp === v2 ? declared : undefined) }),
    });
    const st = await methods['remote.status']!({}, conn('local')) as any;
    const row = (fp: string) => st.devices.find((d: any) => d.peerFingerprint === fp);
    expect(row(viaOut)).toMatchObject({ pairingProtocol: 1, canUpgradePairing: true });
    expect(row(viaIn)).toMatchObject({ pairingProtocol: 1, canUpgradePairing: true });
    expect(row(silent)).toMatchObject({ pairingProtocol: 1, canUpgradePairing: false });
    expect(row(v2)).toMatchObject({ pairingProtocol: 2, canUpgradePairing: false });   // 已是 v2：对端声明了也不提示
    // 脱敏视图：没有密钥材料
    expect(JSON.stringify(st)).not.toContain('authKey');
    expect(JSON.stringify(st)).not.toContain('sessionSecret');
    // 不给两个取值器（旧的装配方式）：一律 false，不抛错
    const bare = await createRemoteMethods(service)['remote.status']!({}, conn('local')) as any;
    expect(bare.devices.every((d: any) => d.canUpgradePairing === false)).toBe(true);
  });
  it('真实连接上：配对后 H 的 inboundSyncPeer(J) 与 J 的 outbound.peerInfo(H) 都是 {2, {pairV2}}；不认识的指纹是 undefined', async () => {
    const h = await bootNode(cleanups);
    const j = await bootNode(cleanups);
    const { code } = await beginOn(h);
    await joinVia(j, h.port, code, { peerName: 'J', listenPort: j.port });
    await waitFor('互认完成', () => j.outbound.peerInfo(h.fp) !== undefined && h.rpc.inboundSyncPeer(j.fp) !== undefined);
    expect(h.rpc.inboundSyncPeer(j.fp)).toEqual({ protocolVersion: 2, caps: { pairV2: true, attachments: true, tombstones: true } });
    expect(j.outbound.peerInfo(h.fp)).toEqual({ protocolVersion: 2, caps: { pairV2: true, attachments: true, tombstones: true } });
    expect(h.rpc.inboundSyncPeer('ffffffffffff')).toBeUndefined();
  });
});

describe('V5 文档：威胁模型、transcript、未审查的部分都写明了', () => {
  const spec = join(repoRoot, 'docs', 'specs', '2026-10-03-f11c-authenticated-pairing.md');
  it('规格文档存在，含「威胁模型」「transcript」「未经独立密码学审查」，并写了 RFC 向量的出处', () => {
    expect(existsSync(spec)).toBe(true);
    const text = readFileSync(spec, 'utf8');
    const headings = text.split('\n').filter(l => l.startsWith('#')).join('\n');
    expect(headings).toContain('威胁模型');
    expect(headings).toContain('transcript');
    expect(headings).toContain('未经独立密码学审查');
    expect(text).toContain('RFC 9382');
    expect(text).toContain('附录 B');
    expect(text).toContain('SPAKE2-P256-SHA256-HKDF-HMAC');
  });
  it('规格文档不借传输层外壳声称防中间人，也不把 0.3.0 当成旧版本', () => {
    const text = readFileSync(spec, 'utf8');
    expect(text).not.toMatch(/(TLS|HTTPS|wss)[^。\n]*(防|抵御|挡住)[^。\n]*中间人/i);
    expect(text).not.toMatch(/与 0\.3\.0 互通|旧版（0\.3\.0）|0\.3\.0 及更早/);
  });
  it('README 与设备页都写明「未经独立密码学审查」', () => {
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toContain('未经独立密码学审查');
    expect(readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'ui', 'StageDevices.vue'), 'utf8')).toContain('未经独立密码学审查');
  });
});

describe('配对落定或撤回之后的连接处理：监听者对入站、出站各做什么', () => {
  const FP = 'a0b1c2d3e4f5';
  /** 用记录调用的替身接上 createRemoteMethods，拿到它装进 PairingService 的那个监听者。fire 返回这一次事件引出的调用。 */
  function wired(o: { outboundOnline?: boolean; record?: boolean } = {}): (e: PairedNotice) => string[] {
    const { store, vault } = tmpStore();
    const service = new PairingService(store, vault);
    if (o.record) store.save(keyFor(FP, 5));
    const calls: string[] = [];
    let listener: ((e: PairedNotice) => void) | undefined;
    const set = service.setPairedListener.bind(service);
    service.setPairedListener = fn => { listener = fn; set(fn); };
    createRemoteMethods(service, {
      getOutbound: () => ({
        isOnline: () => o.outboundOnline === true,
        disconnect: fp => { calls.push(`outbound.disconnect ${fp}`); },
        dialNow: fp => { calls.push(`outbound.dialNow ${fp}`); },
      }),
      getRpcServer: () => ({
        isInboundOnline: () => false,
        closeByFingerprint: fp => { calls.push(`rpc.closeByFingerprint ${fp}`); },
        terminateByFingerprint: fp => { calls.push(`rpc.terminateByFingerprint ${fp}`); },
      }),
    });
    return e => { calls.length = 0; listener!(e); return [...calls]; };
  }
  // 入站用 terminate 掐断（不是走关闭握手的 close），出站断开；要重拨的话一定在断开之后（dialNow 对还没断的连接直接返回）
  const CUT = [`rpc.terminateByFingerprint ${FP}`, `outbound.disconnect ${FP}`];
  const CUT_THEN_DIAL = [...CUT, `outbound.dialNow ${FP}`];
  const paired = (role: 'host' | 'join', replaced: boolean): PairedNotice => ({ kind: 'paired', role, peerFingerprint: FP, replaced });

  it('paired，发起端：一律掐断入站、断开出站（不看 replaced）；替换了旧记录、或断之前出站在线才重拨；首次配对不拨', () => {
    expect(wired()(paired('host', false)), '首次配对：断是空操作，不拨（与 v1 一致）').toEqual(CUT);
    expect(wired()(paired('host', true)), '替换了旧记录：按新密钥重建出站').toEqual(CUT_THEN_DIAL);
    // 提交那一刻凭据库读旧值失败时 replaced 会报成 false，但连接是实实在在的：照样断，出站原本在线就照样重建
    expect(wired({ outboundOnline: true })(paired('host', false))).toEqual(CUT_THEN_DIAL);
  });
  it('paired，加入端：一律掐断入站、断开出站，然后总是拨', () => {
    expect(wired()(paired('join', false))).toEqual(CUT_THEN_DIAL);
    expect(wired()(paired('join', true))).toEqual(CUT_THEN_DIAL);
  });
  it('rolledBack：同样掐断入站、断开出站；该指纹还有生效记录才用它重拨', () => {
    expect(wired({ record: true })({ kind: 'rolledBack', peerFingerprint: FP })).toEqual(CUT_THEN_DIAL);
    expect(wired()({ kind: 'rolledBack', peerFingerprint: FP })).toEqual(CUT);
  });
});

describe('旧配对升级：用一个新的 v2 码重新配对', () => {
  it('两端原有 v1 记录 → v2 重新配对后两端都是 pairingProtocol 2，密钥换新', async () => {
    const hv = new FaultVault();
    const jv = new FaultVault();
    const h = await bootNode(cleanups, { vault: hv, policy: 'legacy' });
    const j = await bootNode(cleanups, { vault: jv, policy: 'legacy' });
    const v1 = await beginOn(h);
    await joinVia(j, h.port, v1.code, { peerName: 'J', listenPort: j.port });
    expect(h.store.get(j.fp)?.pairingProtocol).toBe(1);
    const oldRaw = hv.inner.get(`pairing.${j.fp}`);
    await h.local.call('remote.pair.setPolicy', { policy: 'authenticated' });
    const v2 = await beginOn(h);
    expect(await joinVia(j, h.port, v2.code, { peerName: 'J', listenPort: j.port })).toMatchObject({ protocol: 2 });
    expect(h.store.get(j.fp)?.pairingProtocol).toBe(2);
    expect(j.store.get(h.fp)?.pairingProtocol).toBe(2);
    expect(hv.inner.get(`pairing.${j.fp}`)).not.toBe(oldRaw);
    expect(h.events.at(-1)).toMatchObject({ kind: 'paired', replaced: true });
  });
});
