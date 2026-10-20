/** F11C：密钥确认失败、数据库或 vault 写入失败时，双方没有业务权限残留（任务卡验收 3；阻断 3 的加入端一侧）。
 *
 *  双节点（真实的发起端 H 与加入端 J），用 FaultVault 与真实的文件写入故障注入：
 *   - J 先落盘（暂存）再发确认，H 验过确认再落盘；任一侧本机写失败两边都不留记录；
 *   - 已有同指纹旧记录时，失败的重新配对把旧记录原样恢复，旧密钥仍能握通道；
 *   - 回滚不干净时该指纹在本进程里被吊销；握手窗口内的解绑不会被回滚撤销；
 *   - J 的记录在收到 done 之前不生效：知道码的对端没法在这段窗口里用新密钥连上来。 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  FakeJoiner, FaultVault, beginOn, bootNode, chDial, expectNoAccess, expectNoResidue, fakeClock, fakeHost, gate, joinVia, keysOfRaw, mitm,
  pairCodeOf, rawPair, waitFor, type Cleanups, type NodeOpts, type RelayFrame, type TestNode,
} from './pair-v2-util';
import type { ChannelKeys } from '../src/minisd/remote/channel';
import { PAIR_DONE_FRAME, PAIR_FAIL_FRAME, derivePasswordScalar } from '../src/minisd/remote/pair-proto';
import { StaticIdentity, generatePairingCodeV2 } from '../src/minisd/remote/pairing';

const cleanups: Cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const VK = (fp: string): string => `pairing.${fp}`;
const hostIdle = (h: TestNode): boolean => { const s = h.service.pairingStatus().host; return s === undefined || s.inFlight === false; };
const outcome = (h: TestNode) => h.service.pairingStatus().lastHostOutcome;
const isOnline = async (n: TestNode, fp: string): Promise<boolean> =>
  (await n.local.call('remote.status')).devices.some((d: any) => d.peerFingerprint === fp && d.online === true);

interface Pair { h: TestNode; j: TestNode; hv: FaultVault; jv: FaultVault }
async function nodes(hOpts: NodeOpts = {}, jOpts: NodeOpts = {}): Promise<Pair> {
  const hv = new FaultVault();
  const jv = new FaultVault();
  return { h: await bootNode(cleanups, { vault: hv, ...hOpts }), j: await bootNode(cleanups, { vault: jv, ...jOpts }), hv, jv };
}
const joinArgs = (j: TestNode) => ({ peerName: 'J-name', listenPort: j.port });
/** 改写 M3 的 cA（合法长度的另一串字节）。 */
const tamperCA = (f: RelayFrame): string | void => {
  if (f.dir !== 'c2s' || f.index !== 1) return;
  return JSON.stringify({ ...JSON.parse(f.text), cA: Buffer.alloc(32, 7).toString('base64url') });
};
/** M4 丢在半路：中继收到 H 的 done（说明 H 已经验过 cA 并落盘）之后不转发，直接把连接断掉。J 等到的是「对端断开」。
 *  不用「卡住不放、等 J 超时」的写法：那要给 J 一个很短的每步时限，机器忙的时候前面几步自己就会超时，
 *  用例就测不到「H 已落盘而 done 没到」这个状态了。J 等 done 超时的那条路在 B3 (a′) 里单测（对端一声不吭）。 */
const dropM4 = (f: RelayFrame): { close: true } | void => {
  if (f.dir === 's2c' && f.index === 1) return { close: true };
};

/** 先做一次成功的配对，等 J 的出站通道上线；返回两端此刻的 vault 原文与地址（旧记录）。 */
async function pairedOnce(p: Pair): Promise<{ rawH: string; rawJ: string; addrH: string | undefined; addrJ: string | undefined }> {
  const { code } = await beginOn(p.h);
  await joinVia(p.j, p.h.port, code, joinArgs(p.j));
  await waitFor('J 上线', () => isOnline(p.j, p.h.fp));
  return {
    rawH: p.hv.inner.get(VK(p.j.fp))!, rawJ: p.jv.inner.get(VK(p.h.fp))!,
    addrH: p.h.store.getAddress(p.j.fp), addrJ: p.j.store.getAddress(p.h.fp),
  };
}
/** 失败的重新配对之后：两端的旧记录原样还在，旧密钥仍能握 H 的加密通道。 */
async function expectOldRecordIntact(p: Pair, old: Awaited<ReturnType<typeof pairedOnce>>): Promise<void> {
  expect(p.hv.inner.get(VK(p.j.fp)), 'H 的 vault 原文').toBe(old.rawH);
  expect(p.jv.inner.get(VK(p.h.fp)), 'J 的 vault 原文').toBe(old.rawJ);
  expect(p.h.store.getAddress(p.j.fp)).toBe(old.addrH);
  expect(p.j.store.getAddress(p.h.fp)).toBe(old.addrJ);
  expect(p.h.store.get(p.j.fp)).toBeDefined();
  expect(p.j.store.get(p.h.fp)).toBeDefined();
  const d = await chDial(p.h.port, keysOfRaw(old.rawJ), p.j.fp, p.h.fp);
  expect(d.accepted, '旧密钥握 ?ch=1').toBe(true);
  d.close();
  // 真实的出站客户端也用旧密钥重新连上
  await waitFor('J 用旧密钥重新上线', () => isOnline(p.j, p.h.fp));
}

describe('V3 落盘失败无残留（新指纹）', () => {
  it('① H 的 vault.set 抛错 → H 回 fail，J 回滚；配对码已消费', async () => {
    const p = await nodes();
    const { code } = await beginOn(p.h);
    p.hv.fault = (op, k) => op === 'set' && k === VK(p.j.fp) ? 'throw' : undefined;
    expect(await pairCodeOf(joinVia(p.j, p.h.port, code, joinArgs(p.j)))).toBe('PAIR_PEER_REJECTED');
    expect(outcome(p.h)).toMatchObject({ kind: 'failed', code: 'PAIR_COMMIT_FAILED' });
    expect(p.h.service.pairingStatus().host).toBeUndefined();
    const leaked = p.jv.writtenKeys(p.h.fp);
    expect(leaked).toHaveLength(1);                           // J 确实先落过盘
    await expectNoResidue(p.h, p.j.fp, leaked);
    await expectNoResidue(p.j, p.h.fp, leaked);
    expect(p.j.events).toEqual([{ kind: 'failed', protocol: 2, role: 'join', code: 'PAIR_PEER_REJECTED' }]);
    expect(p.h.events.at(-1)).toEqual({ kind: 'failed', protocol: 2, role: 'host', code: 'PAIR_COMMIT_FAILED' });
  });

  it('② H 的索引写失败 → H 的 vault 没被写，J 回滚', async () => {
    const p = await nodes();
    const { code } = await beginOn(p.h);
    mkdirSync(join(p.h.dir, 'pairing-index.json.tmp'));
    expect(await pairCodeOf(joinVia(p.j, p.h.port, code, joinArgs(p.j)))).toBe('PAIR_PEER_REJECTED');
    expect(p.hv.pairingSets()).toEqual([]);                   // 提交点没到：没有 isPaired 为真的孤儿密钥
    const leaked = p.jv.writtenKeys(p.h.fp);
    await expectNoResidue(p.h, p.j.fp, leaked);
    await expectNoResidue(p.j, p.h.fp, leaked);
  });

  it('③ H 的地址簿写失败 → 同上', async () => {
    const p = await nodes();
    const { code } = await beginOn(p.h);
    mkdirSync(join(p.h.dir, 'peer-addresses.json.tmp'));
    expect(await pairCodeOf(joinVia(p.j, p.h.port, code, joinArgs(p.j)))).toBe('PAIR_PEER_REJECTED');
    expect(p.hv.pairingSets()).toEqual([]);
    const leaked = p.jv.writtenKeys(p.h.fp);
    await expectNoResidue(p.h, p.j.fp, leaked);
    await expectNoResidue(p.j, p.h.fp, leaked);
  });

  it('④ J 的 vault.set 抛错 → PAIR_COMMIT_FAILED，J 没有发出 confirm，H 不落盘', async () => {
    const p = await nodes();
    const { code } = await beginOn(p.h);
    const relay = await mitm(cleanups, p.h.port);
    p.jv.fault = (op, k) => op === 'set' && k === VK(p.h.fp) ? 'throw' : undefined;
    expect(await pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)))).toBe('PAIR_COMMIT_FAILED');
    await waitFor('H 收尾', () => hostIdle(p.h));
    expect(relay.frames.map(f => JSON.parse(f.text).t)).toEqual(['dm.pair.hello', 'dm.pair.reply']);
    expect(p.hv.pairingSets()).toEqual([]);
    await expectNoResidue(p.h, p.j.fp);
    await expectNoResidue(p.j, p.h.fp);
  });

  it('⑤ J 的索引写失败 → PAIR_COMMIT_FAILED，J 的 vault 没被写，没有 confirm', async () => {
    const p = await nodes();
    const { code } = await beginOn(p.h);
    const relay = await mitm(cleanups, p.h.port);
    mkdirSync(join(p.j.dir, 'pairing-index.json.tmp'));
    expect(await pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)))).toBe('PAIR_COMMIT_FAILED');
    await waitFor('H 收尾', () => hostIdle(p.h));
    expect(relay.frames.some(f => f.text.includes('dm.pair.confirm'))).toBe(false);
    expect(p.jv.pairingSets()).toEqual([]);
    await expectNoResidue(p.h, p.j.fp);
    await expectNoResidue(p.j, p.h.fp);
  });

  it('⑥ 中继丢掉 M4 → J 回滚，J 无残留；H 留下的记录的密钥在 J 侧已不存在（已声明的残余）', async () => {
    const p = await nodes();
    const { code } = await beginOn(p.h);
    const relay = await mitm(cleanups, p.h.port, dropM4);
    expect(await pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)))).toBe('PAIR_PEER_REJECTED');
    // 中继确实收到过 H 的 done、而且没有转给 J
    expect(relay.frames.some(f => f.dir === 's2c' && f.index === 1 && f.text === PAIR_DONE_FRAME)).toBe(true);
    expect(relay.forwarded.some(f => f.dir === 's2c' && f.index === 1)).toBe(false);
    const leaked = p.jv.writtenKeys(p.h.fp);
    expect(leaked).toHaveLength(1);
    await expectNoResidue(p.j, p.h.fp, leaked);
    // H 已落盘（它验过了 cA）：这是两将军问题留下的单侧悬空记录，没有任何人持有它的密钥
    expect(p.h.store.get(p.j.fp)).toBeDefined();
    expect(p.j.store.get(p.h.fp)).toBeUndefined();
    expect(p.jv.inner.get(VK(p.h.fp))).toBeUndefined();
    expect(p.h.rpc.isInboundOnline(p.j.fp)).toBe(false);
  });
});

describe('⑦ 已有同指纹旧记录：失败的重新配对把旧记录原样恢复', () => {
  it('H 的 vault.set 抛错', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    p.hv.fault = (op, k) => op === 'set' && k === VK(p.j.fp) ? 'throw' : undefined;
    expect(await pairCodeOf(joinVia(p.j, p.h.port, code, joinArgs(p.j)))).toBe('PAIR_PEER_REJECTED');
    p.hv.fault = () => undefined;
    expect(p.jv.setsOf(p.h.fp)).toBe(3);                      // 第一次配对、这次暂存、回滚写回旧值
    await expectOldRecordIntact(p, old);
  });

  it('H 的地址簿写失败', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    mkdirSync(join(p.h.dir, 'peer-addresses.json.tmp'));
    expect(await pairCodeOf(joinVia(p.j, p.h.port, code, joinArgs(p.j)))).toBe('PAIR_PEER_REJECTED');
    // 撤掉故障再验旧记录：J 重连时 H 的 sync.hello 也要写地址簿
    rmdirSync(join(p.h.dir, 'peer-addresses.json.tmp'));
    await expectOldRecordIntact(p, old);
  });

  it('J 的 vault.set 抛错', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    p.jv.fault = (op, k) => op === 'set' && k === VK(p.h.fp) ? 'throw' : undefined;
    expect(await pairCodeOf(joinVia(p.j, p.h.port, code, joinArgs(p.j)))).toBe('PAIR_COMMIT_FAILED');
    p.jv.fault = () => undefined;
    await waitFor('H 收尾', () => hostIdle(p.h));
    await expectOldRecordIntact(p, old);
  });

  it('M3 的 cA 被改（J 已落盘再回滚）', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    const relay = await mitm(cleanups, p.h.port, tamperCA);
    expect(await pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)))).toBe('PAIR_PEER_REJECTED');
    await expectOldRecordIntact(p, old);
    // 这次握手写入过的新密钥握不上任何一端
    const fresh = p.jv.writtenKeys(p.h.fp)[1];
    expect((await chDial(p.h.port, fresh, p.j.fp, p.h.fp)).accepted).toBe(false);
    expect((await chDial(p.j.port, fresh, p.h.fp, p.j.fp)).accepted).toBe(false);
  });

  it('握手卡在 M3 时 H 取消', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    const hold = gate();
    const relay = await mitm(cleanups, p.h.port, async f => { if (f.dir === 'c2s' && f.index === 1) await hold.wait; });
    const joining = pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)));
    await waitFor('M3 到了中继', () => relay.frames.some(f => f.dir === 'c2s' && f.index === 1));
    // 暂存窗口内：J 读到的仍是旧记录
    expect(Buffer.from(p.j.store.get(p.h.fp)!.authKey).toString('base64')).toBe(JSON.parse(old.rawJ).authKey);
    await p.h.local.call('remote.pair.cancel');
    hold.open();
    expect(await joining).toBe('PAIR_PEER_REJECTED');
    await expectOldRecordIntact(p, old);
  });

  it('握手卡在 M3 时过期', async () => {
    const clock = fakeClock();
    const p = await nodes({ now: clock.now });
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    const hold = gate();
    const relay = await mitm(cleanups, p.h.port, async f => { if (f.dir === 'c2s' && f.index === 1) await hold.wait; });
    const joining = pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)));
    await waitFor('M3 到了中继', () => relay.frames.some(f => f.dir === 'c2s' && f.index === 1));
    clock.advance(301_000);
    hold.open();
    expect(await joining).toBe('PAIR_PEER_REJECTED');
    await expectOldRecordIntact(p, old);
  });

  it('⑦′ 丢掉 M4（已声明的残余）：J 还原为旧值，H 换成了新记录，两端用各自的密钥都握不上对方', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    const relay = await mitm(cleanups, p.h.port, dropM4);
    expect(await pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)))).toBe('PAIR_PEER_REJECTED');
    expect(relay.frames.some(f => f.dir === 's2c' && f.index === 1 && f.text === PAIR_DONE_FRAME)).toBe(true);
    expect(p.jv.inner.get(VK(p.h.fp))).toBe(old.rawJ);
    const newRawH = p.hv.inner.get(VK(p.j.fp))!;
    expect(newRawH).not.toBe(old.rawH);
    expect((await chDial(p.h.port, keysOfRaw(old.rawJ), p.j.fp, p.h.fp)).accepted).toBe(false);
    expect((await chDial(p.j.port, keysOfRaw(newRawH), p.h.fp, p.j.fp)).accepted).toBe(false);
    // H 换记录时当场断了用旧密钥握的入站连接
    await waitFor('H 上 J 的旧连接已断', () => !p.h.rpc.isInboundOnline(p.j.fp));
  });

  it('对照：重新配对成功 → 两端都换成新密钥，旧密钥失效，J 用新密钥重新上线', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    expect(await joinVia(p.j, p.h.port, code, joinArgs(p.j))).toMatchObject({ ok: true, protocol: 2 });
    expect(p.hv.inner.get(VK(p.j.fp))).not.toBe(old.rawH);
    expect(keysOfRaw(p.hv.inner.get(VK(p.j.fp))!)).toEqual(keysOfRaw(p.jv.inner.get(VK(p.h.fp))!));
    expect((await chDial(p.h.port, keysOfRaw(old.rawJ), p.j.fp, p.h.fp)).accepted).toBe(false);
    await waitFor('J 用新密钥上线', () => isOnline(p.j, p.h.fp));
    expect(p.h.events.at(-1)).toMatchObject({ kind: 'paired', role: 'host', replaced: true });
    expect(p.j.events.at(-1)).toMatchObject({ kind: 'paired', role: 'join', replaced: true });
  });

  it('重新配对成功时，两端用旧密钥握着的连接当场被关（记录一换，旧通道不留）', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    // 两端各有一条用旧密钥握着的入站加密通道：H 上的自称 J，J 上的自称 H。
    // 上一条用例里「J 重新上线」单靠在线状态分不出新旧——旧连接不断的话它本来就在线，所以这里盯住旧连接本身
    const onH = await chDial(p.h.port, keysOfRaw(old.rawJ), p.j.fp, p.h.fp);
    const onJ = await chDial(p.j.port, keysOfRaw(old.rawJ), p.h.fp, p.j.fp);
    expect(onH.accepted).toBe(true);
    expect(onJ.accepted).toBe(true);

    const { code } = await beginOn(p.h);
    expect(await joinVia(p.j, p.h.port, code, joinArgs(p.j))).toMatchObject({ ok: true, protocol: 2 });
    await waitFor('H 上用旧密钥握着的连接被关', () => onH.isClosed(), 2000);
    await waitFor('J 上用旧密钥握着的连接被关', () => onJ.isClosed(), 2000);
    // 关掉之后的广播它们一帧都收不到
    const seenH = onH.framesAfter();
    const seenJ = onJ.framesAfter();
    p.h.rpc.broadcast('chat.event', { text: 'SECRET' });
    p.j.rpc.broadcast('chat.event', { text: 'SECRET' });
    expect(onH.framesAfter()).toBe(seenH);
    expect(onJ.framesAfter()).toBe(seenJ);
    // J 的出站连接断开之后用新密钥重新连上
    await waitFor('J 用新密钥上线', () => isOnline(p.j, p.h.fp));
  });
});

describe('记录一换，用旧密钥握的连接当场掐断——不等对端配合关闭握手', () => {
  const remoteCalls = (n: TestNode) => n.echoCalls.filter(c => c.authMode !== 'local');
  const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
  /** 固定身份的手工加入端走一遍真实的 ?pair=2，返回它导出的配对密钥。beforeConfirm：发出 confirm 之前插一脚。 */
  async function fakePair(h: TestNode, identity: StaticIdentity, beforeConfirm?: () => void): Promise<ChannelKeys> {
    const { code } = await beginOn(h);
    const a = new FakeJoiner(await derivePasswordScalar(code), identity);
    const c = await rawPair(h.port);
    c.send(a.hello('fake', 0));
    expect(await c.waitFrames(1)).toBe(true);
    expect(a.onReply(c.frames[0]).cBok).toBe(true);
    beforeConfirm?.();
    c.send(a.confirm());
    expect(await c.waitFrames(2)).toBe(true);
    expect(c.frames[1]).toBe(PAIR_DONE_FRAME);
    await c.closed;
    return a.keys();
  }

  it('H 一侧：旧密钥的持有者不读、不回 close 帧——重新配对之后它在旧连接上发的业务调用一次都不执行，它也不再算入站在线', async () => {
    const h = await bootNode(cleanups);
    const id = new StaticIdentity();
    const fp = id.fingerprint;
    const oldKeys = await fakePair(h, id);
    const old = await chDial(h.port, oldKeys, fp, h.fp);
    expect(old.accepted).toBe(true);
    expect((await old.call('echo', { n: 1 }))?.result).toEqual({ n: 1 });
    expect(remoteCalls(h)).toEqual([{ authMode: 'remote', fp }]);
    old.stall();                                              // 从此不读：对端发来的 close 帧它收不到，也就不会回

    const newKeys = await fakePair(h, id);                    // 同一个指纹重新配对
    expect(outcome(h)).toMatchObject({ kind: 'paired', peerFingerprint: fp, replaced: true });
    expect(hex(h.store.get(fp)!.authKey)).toBe(hex(newKeys.authKey));
    expect(hex(newKeys.authKey)).not.toBe(hex(oldKeys.authKey));

    // 记录已经换成新密钥。旧连接若只是「请对端关闭」，它在对端回 close 帧之前（最长 30 秒）照常分发收到的帧，
    // 而业务守卫只按指纹复查——这个指纹有新记录，拦不住
    for (let i = 0; i < 3; i++) old.post('permission.respond');
    await waitFor('旧连接在 H 上销毁', () => !h.rpc.isInboundOnline(fp), 2000).catch(() => { /* 下面的断言给出具体的失败 */ });
    expect(remoteCalls(h), '旧连接上的业务调用不该再执行').toHaveLength(1);
    expect(h.rpc.isInboundOnline(fp)).toBe(false);
    old.post('permission.respond');
    await h.local.call('remote.status');
    expect(remoteCalls(h)).toHaveLength(1);
    // 旧密钥也握不出新的连接
    expect((await chDial(h.port, oldKeys, fp, h.fp)).accepted).toBe(false);
  });

  it('J 一侧：自称发起端的旧密钥持有者同样不配合——J 的记录生效之后，它在旧连接上发的业务调用一次都不执行', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const onJ = await chDial(p.j.port, keysOfRaw(old.rawJ), p.h.fp, p.j.fp);
    expect(onJ.accepted).toBe(true);
    expect((await onJ.call('echo', { n: 1 }))?.result).toEqual({ n: 1 });
    expect(remoteCalls(p.j)).toEqual([{ authMode: 'remote', fp: p.h.fp }]);
    onJ.stall();

    const { code } = await beginOn(p.h);
    expect(await joinVia(p.j, p.h.port, code, joinArgs(p.j))).toMatchObject({ ok: true, protocol: 2 });
    for (let i = 0; i < 3; i++) onJ.post('permission.respond');
    // 等一件确实要好几轮网络往返的事（J 的出站用新密钥重新握上：配对落定时它被断开重拨），再看那几帧有没有被执行。
    // 只看 J 自己的出站，不看 remote.status 的 online：那里把入站也算在线，坏实现下挂着的旧连接会让它立刻为真
    await waitFor('J 的出站用新密钥重新上线', () => p.j.outbound.isOnline(p.h.fp));
    await p.j.local.call('remote.status');
    expect(remoteCalls(p.j), '旧连接上的业务调用不该再执行').toHaveLength(1);
  });

  it('提交那一刻凭据库读旧值失败（replaced 报成 false）：旧连接照样被掐断', async () => {
    const hv = new FaultVault();
    const h = await bootNode(cleanups, { vault: hv });
    const id = new StaticIdentity();
    const fp = id.fingerprint;
    const oldKeys = await fakePair(h, id);
    const old = await chDial(h.port, oldKeys, fp, h.fp);     // 这一条是配合的对端：没人叫它关，它就一直开着
    expect(old.accepted).toBe(true);

    // 只让下一次读这个键读成「不存在」（吞掉错误的凭据库）：发出 confirm 之前才装上，命中的正是 commit 读旧值的那一次
    let armed = false;
    hv.fault = (op, k) => {
      if (armed && op === 'get' && k === VK(fp)) { armed = false; return 'ignore'; }
      return undefined;
    };
    const newKeys = await fakePair(h, id, () => { armed = true; });
    expect(armed, '那一次读确实发生了').toBe(false);
    expect(outcome(h)).toMatchObject({ kind: 'paired', peerFingerprint: fp, replaced: false });
    expect(hex(h.store.get(fp)!.authKey)).toBe(hex(newKeys.authKey));

    await waitFor('用旧密钥握着的连接被关', () => old.isClosed() && !h.rpc.isInboundOnline(fp), 2000);
    expect((await chDial(h.port, oldKeys, fp, h.fp)).accepted).toBe(false);
  });
});

describe('重新配对之后发起端的出站拨号循环', () => {
  it('H 原本有一条到 J 的常驻出站循环：重新配对后它用新密钥重建；J「重启」（自己不拨、连接全断）之后 H 自己拨得回来', async () => {
    const p = await nodes();
    await pairedOnce(p);
    // H 是主从裁决下的拨号方、而且重启过的样子：它自己有一条到 J 的出站循环（地址来自 J 握手时报的监听端口）
    p.h.outbound.dialNow(p.j.fp);
    await waitFor('H 的出站上线', () => p.h.outbound.isOnline(p.j.fp));
    const cameOnline: string[] = [];
    p.h.outbound.onOnline = fp => { cameOnline.push(fp); };

    const { code } = await beginOn(p.h);
    expect(await joinVia(p.j, p.h.port, code, joinArgs(p.j))).toMatchObject({ ok: true, protocol: 2 });
    // 旧的出站连接是用旧密钥握的，记录一换就断；重建的这一条是配对之后重新握的——握得上只能是新密钥，J 此刻只认新记录
    await waitFor('H 的出站重新上线', () => cameOnline.includes(p.j.fp) && p.h.outbound.isOnline(p.j.fp));

    // J「重启」：J 的指纹较大时它启动后不主动拨；它那边原有的连接全断
    p.j.outbound.disconnect(p.h.fp);
    p.j.rpc.terminateByFingerprint(p.h.fp);
    const seen = cameOnline.length;
    await waitFor('H 自己拨回来', () => cameOnline.length > seen && p.h.outbound.isOnline(p.j.fp) && p.j.rpc.isInboundOnline(p.h.fp));
    expect(await isOnline(p.h, p.j.fp)).toBe(true);
    expect(await isOnline(p.j, p.h.fp)).toBe(true);
  });
  // 「首次配对时发起端照旧不拨」是一条否定性的断言，在真实连接上只能靠等一段时间来猜；
  // 它由 tests/pair-policy.test.ts 的监听者调用表（替身记录调用，不涉及时序）钉住
});

describe('回滚不干净与吊销', () => {
  it('⑧⑨ J 回滚时 vault.delete 不生效 → PAIR_ROLLBACK_INCOMPLETE；该指纹在本进程里拿不到任何权限；再失败一次仍然如此', async () => {
    const p = await nodes();
    const relay = await mitm(cleanups, p.h.port, tamperCA);
    p.jv.fault = (op, k) => op === 'delete' && k === VK(p.h.fp) ? 'ignore' : undefined;

    // ⑧ 第一次：落盘后失败，删不掉
    const first = await beginOn(p.h);
    expect(await pairCodeOf(joinVia(p.j, relay.port, first.code, joinArgs(p.j)))).toBe('PAIR_ROLLBACK_INCOMPLETE');
    expect(p.jv.inner.get(VK(p.h.fp)), 'vault 里确实还留着条目').toBeDefined();
    expect(p.j.store.get(p.h.fp)).toBeUndefined();
    await expectNoAccess(p.j, p.h.fp, p.jv.writtenKeys(p.h.fp));
    expect(p.j.events.at(-1)).toEqual({ kind: 'failed', protocol: 2, role: 'join', code: 'PAIR_ROLLBACK_INCOMPLETE' });

    // ⑨ 第二次：同一个不生效的 vault.delete 下再做一次「落盘后失败」
    const second = await beginOn(p.h);
    expect(await pairCodeOf(joinVia(p.j, relay.port, second.code, joinArgs(p.j)))).toBe('PAIR_ROLLBACK_INCOMPLETE');
    const keys = p.jv.writtenKeys(p.h.fp);
    expect(keys).toHaveLength(2);                             // 两次握手各写入过一把；回滚没有把第一次的写回去
    expect(p.j.store.get(p.h.fp)).toBeUndefined();
    expect(p.j.store.list()).toEqual([]);
    await expectNoAccess(p.j, p.h.fp, keys);
    await expectNoResidue(p.h, p.j.fp, keys);
  });

  // 变异核对补的：⑧⑨ 里只有删除不生效，回滚读得到当前值。凭据库整个不可用时读与删一起失灵——
  // 回滚把「读不到」当成窗口内被解绑，不写回旧值、删除又没删掉。那一支里不吊销的话，凭据库一恢复，
  // 失败握手的密钥就成了一条生效的记录（索引里本来就有这个指纹），持有它的对端握得上 J 的加密通道。
  it('⑧′ 重新配对在 J 落盘后失败，回滚那一刻凭据库读、删都被吞掉：失败握手的密钥留在 vault 里，凭据库恢复后它也握不上通道', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    // J 的 confirm 到了中继（J 已经落盘）之后凭据库开始失灵：读成不存在，删除不生效
    let down = false;
    p.jv.fault = (op, k) => down && k === VK(p.h.fp) && (op === 'get' || op === 'delete') ? 'ignore' : undefined;
    const relay = await mitm(cleanups, p.h.port, f => {
      if (f.dir === 'c2s' && f.index === 1) down = true;
      return tamperCA(f);
    });
    const { code } = await beginOn(p.h);
    const failed = await pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)));
    down = false;                                             // 凭据库恢复
    // 现行规则把「读不到当前值」按窗口内被解绑处理、算回滚干净，报的是对端拒绝；这里不钉死是哪一个失败码
    expect(['PAIR_PEER_REJECTED', 'PAIR_ROLLBACK_INCOMPLETE']).toContain(failed);
    const keys = p.jv.writtenKeys(p.h.fp);
    expect(keys).toHaveLength(2);                             // 第一次配对的旧密钥、这次失败握手的新密钥
    const left = p.jv.inner.get(VK(p.h.fp));
    expect(left, 'vault 里留下的是失败握手写的那一份').toBeDefined();
    expect(left).not.toBe(old.rawJ);
    expect(p.j.store.get(p.h.fp)).toBeUndefined();
    expect(p.j.store.list()).toEqual([]);
    await expectNoAccess(p.j, p.h.fp, keys);
  });

  it('⑩ 窗口内解绑后握手失败：J 的 vault 里没有 pairing.<fp>，旧密钥没有被回滚写回', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    const hold = gate();
    // 卡住 M4，放行时把它换成失败帧
    const relay = await mitm(cleanups, p.h.port, async f => {
      if (f.dir !== 's2c' || f.index !== 1) return;
      await hold.wait;
      return PAIR_FAIL_FRAME;
    });
    const joining = pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)));
    await waitFor('M4 到了中继', () => relay.frames.some(f => f.dir === 's2c' && f.index === 1));
    await p.j.local.call('remote.unpair', { peerFingerprint: p.h.fp });
    hold.open();
    expect(await joining).toBe('PAIR_PEER_REJECTED');
    expect(p.jv.inner.get(VK(p.h.fp))).toBeUndefined();
    expect(p.j.store.get(p.h.fp)).toBeUndefined();
    await expectNoResidue(p.j, p.h.fp, [keysOfRaw(old.rawJ), ...p.jv.writtenKeys(p.h.fp)]);
  });

  it('⑩′ 窗口内解绑后对端放行 done：J 得 PAIR_CANCELLED，同样没有记录', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    const { code } = await beginOn(p.h);
    const hold = gate();
    const relay = await mitm(cleanups, p.h.port, async f => { if (f.dir === 's2c' && f.index === 1) await hold.wait; });
    const joining = pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)));
    await waitFor('M4 到了中继', () => relay.frames.some(f => f.dir === 's2c' && f.index === 1));
    await p.j.local.call('remote.unpair', { peerFingerprint: p.h.fp });
    hold.open();
    expect(await joining).toBe('PAIR_CANCELLED');
    expect(p.jv.inner.get(VK(p.h.fp))).toBeUndefined();
    expect(p.j.store.get(p.h.fp)).toBeUndefined();
    await expectNoResidue(p.j, p.h.fp, [keysOfRaw(old.rawJ), ...p.jv.writtenKeys(p.h.fp)]);
  });
});

describe('B3（加入端一侧）：收到 done 之前，J 写入的记录不生效', () => {
  it('(a) 知道码的对端在 J 发出 confirm 之后用导出的密钥握 J 的加密通道 → 被拒；它不发 done，J 回滚，它什么都收不到', async () => {
    const code = generatePairingCodeV2();
    const evil = await fakeHost(cleanups, { w: await derivePasswordScalar(code), onConfirm: 'gated-fail' });
    const jv = new FaultVault();
    const j = await bootNode(cleanups, { vault: jv });
    const joining = pairCodeOf(joinVia(j, evil.port, code, joinArgs(j)));
    await evil.confirmSeen;
    const keys = evil.keys();
    expect(keys, '对端知道码：它验过了 J 的 cA，导出了同一把密钥').toBeDefined();
    expect(jv.writtenKeys(evil.fp)[0]).toEqual(keys);         // 这把密钥已经在 J 的 vault 里
    // 暂存窗口：密钥在 vault 里，但 J 不认它
    expect(j.store.get(evil.fp)).toBeUndefined();
    expect(j.isPaired(evil.fp)).toBe(false);
    const d = await chDial(j.port, keys!, evil.fp, j.fp);
    expect(d.accepted, '暂存中的密钥握不了加密通道').toBe(false);
    expect(j.echoCalls).toEqual([]);

    evil.release();                                           // 不发 done，发 fail
    expect(await joining).toBe('PAIR_PEER_REJECTED');
    j.rpc.broadcast('chat.event', { text: 'SECRET' });
    expect(d.framesAfter()).toBe(0);
    expect(j.rpc.isInboundOnline(evil.fp)).toBe(false);
    await expectNoResidue(j, evil.fp, [keys!]);
  });

  it('(a′) 对端收到 confirm 后一声不吭：J 到点超时回滚，无残留', async () => {
    const code = generatePairingCodeV2();
    const evil = await fakeHost(cleanups, { w: await derivePasswordScalar(code), onConfirm: 'silent' });
    const jv = new FaultVault();
    // 每步时限给 1.5 秒：短到用例不拖沓，又长到机器忙的时候前两步（连接、等 reply）不会自己先超时
    const j = await bootNode(cleanups, { vault: jv, joinStepMs: 1500 });
    expect(await pairCodeOf(joinVia(j, evil.port, code, joinArgs(j)))).toBe('PAIR_TIMEOUT');
    // 超时发生在等 done 的那一步：J 已经落过盘（暂存），对端也确实收到了 confirm
    expect(jv.writtenKeys(evil.fp)).toHaveLength(1);
    expect(evil.keys(), '对端验过了 J 的 cA').toBeDefined();
    await expectNoResidue(j, evil.fp, jv.writtenKeys(evil.fp));
  });

  it('(b) 回滚断连接：重新配对在 J 落盘后失败、旧值又写不回去 → PAIR_ROLLBACK_INCOMPLETE，用旧密钥握着的入站连接当场被关', async () => {
    const p = await nodes();
    const old = await pairedOnce(p);
    // 对端用旧密钥握着一条到 J 的入站加密通道
    const d = await chDial(p.j.port, keysOfRaw(old.rawJ), p.h.fp, p.j.fp);
    expect(d.accepted).toBe(true);
    expect(p.j.rpc.isInboundOnline(p.h.fp)).toBe(true);

    const { code } = await beginOn(p.h);
    const hold = gate();
    const relay = await mitm(cleanups, p.h.port, async f => {
      if (f.dir !== 'c2s' || f.index !== 1) return;
      await hold.wait;
      return tamperCA(f);
    });
    const joining = pairCodeOf(joinVia(p.j, relay.port, code, joinArgs(p.j)));
    await waitFor('M3 到了中继', () => relay.frames.some(f => f.dir === 'c2s' && f.index === 1));
    // J 已落盘（暂存）。从现在起往 vault 写这个指纹一律失败：回滚里写回旧值的那一次会抛错
    p.jv.fault = (op, k) => op === 'set' && k === VK(p.h.fp) ? 'throw' : undefined;
    hold.open();
    expect(await joining).toBe('PAIR_ROLLBACK_INCOMPLETE');

    await d.closed;                                           // 旧连接收到关闭事件
    // 套接字是当场销毁的；J 的入站登记由那条连接自己的 close 事件清理，它和对端收到关闭事件谁先谁后不一定，所以等它
    await waitFor('J 清掉这条入站连接的登记', () => !p.j.rpc.isInboundOnline(p.h.fp));
    p.j.rpc.broadcast('chat.event', { text: 'SECRET' });
    expect(d.framesAfter()).toBe(0);
    expect(p.j.outbound.isOnline(p.h.fp)).toBe(false);
    // 旧密钥与这次写入的新密钥都握不上 J
    await expectNoAccess(p.j, p.h.fp, [keysOfRaw(old.rawJ), ...p.jv.writtenKeys(p.h.fp)]);
  });
});
