/** F11C：认证配对 v2 的发起端状态机与 RpcServer 的 ?pair=2 入口（任务卡验收 2 与阻断 3）。
 *
 *  用手工帧客户端与「不知道码的攻击者」（生产的纯函数加随机 w）直接打 H：
 *  错码、并发猜码、重放、角色反射、重复 confirm、过期、取消、超时都失败或按协议终结；
 *  握手未成功的连接没有任何业务能力（调不了方法、收不到广播、不算在线）。 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FakeJoiner, FaultVault, beginOn, bootNode, expectNoResidue, fakeClock, fakeHost, joinVia, mitm, gate,
  pairCodeOf, randomW, rawConnect, rawPair, sleep, waitFor, type Cleanups, type NodeOpts, type TestNode,
} from './pair-v2-util';
import { PAIR_FAIL_FRAME, PAIR_DONE_FRAME, derivePasswordScalar, encodePairHello, parsePairHello, parsePairReply } from '../src/minisd/remote/pair-proto';
import { StaticIdentity, generatePairingCodeV2 } from '../src/minisd/remote/pairing';

const cleanups: Cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function hostWithCode(opts: NodeOpts = {}): Promise<{ h: TestNode; code: string; w: bigint }> {
  const h = await bootNode(cleanups, opts);
  const { code } = await beginOn(h);
  return { h, code, w: await derivePasswordScalar(code) };
}
const hostState = (h: TestNode) => h.service.pairingStatus().host;
const outcome = (h: TestNode) => h.service.pairingStatus().lastHostOutcome;

/** 一次完整的手工握手（知道 w）。返回连接与帧。 */
async function manualPair(h: TestNode, w: bigint, identity = new StaticIdentity()): Promise<{ a: FakeJoiner; frames: string[]; sent: string[] }> {
  const c = await rawPair(h.port);
  expect(c.status).toBeUndefined();
  const a = new FakeJoiner(w, identity);
  const hello = a.hello('manual', 0);
  c.send(hello);
  expect(await c.waitFrames(1)).toBe(true);
  expect(a.onReply(c.frames[0]).cBok).toBe(true);
  const confirm = a.confirm();
  c.send(confirm);
  expect(await c.waitFrames(2)).toBe(true);
  await c.closed;
  return { a, frames: [...c.frames], sent: [hello, confirm] };
}

describe('成功路径（手工帧）与码的形状', () => {
  it('authenticated 下 begin 出 12 位、首位是 0 的码；握手成功后 H 记下 v2 记录，结局 paired', async () => {
    const { h, code, w } = await hostWithCode();
    expect(code).toMatch(/^0[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{11}$/);
    expect(hostState(h)).toMatchObject({ protocol: 2, attemptsLeft: 5, inFlight: false });
    const { a, frames } = await manualPair(h, w);
    expect(frames[1]).toBe(PAIR_DONE_FRAME);
    expect(h.store.get(a.fp)).toMatchObject({ peerName: 'manual', pairingProtocol: 2 });
    expect(Buffer.from(h.store.get(a.fp)!.authKey).toString('hex')).toBe(Buffer.from(a.keys().authKey).toString('hex'));
    expect(hostState(h)).toBeUndefined();
    expect(outcome(h)).toMatchObject({ kind: 'paired', peerFingerprint: a.fp, replaced: false });
    expect(h.events.map(e => e.kind)).toEqual(['begin', 'paired']);
    // 事件里没有码和密钥
    expect(JSON.stringify(h.events)).not.toContain(code);
  });
});

describe('V2 错码', () => {
  it('真实的加入端用错码 → PAIR_CONFIRM_FAILED；两端无记录；H 的剩余次数从 5 变 4', async () => {
    const { h, code } = await hostWithCode();
    const jv = new FaultVault();
    const j = await bootNode(cleanups, { vault: jv });
    const wrong = code.slice(0, 11) + (code[11] === 'A' ? 'B' : 'A');
    expect(await pairCodeOf(joinVia(j, h.port, wrong))).toBe('PAIR_CONFIRM_FAILED');
    // J 验 cB 失败后直接断开，H 要等到连接关闭事件才收尾
    await waitFor('H 收尾', () => hostState(h)?.inFlight === false);
    expect(hostState(h)?.attemptsLeft).toBe(4);
    expect(jv.pairingSets()).toEqual([]);                    // J 什么都没写
    await expectNoResidue(h, j.fp);
    await expectNoResidue(j, h.fp);
    expect(h.events.filter(e => e.kind === 'failed')).toEqual([{ kind: 'failed', protocol: 2, role: 'host', code: 'PAIR_CONFIRM_FAILED' }]);
  });

  it('帧不合规、码错（cA 不对）、已过期、已取消：H 发出的失败帧逐字节相同', async () => {
    const clock = fakeClock();
    const h = await bootNode(cleanups, { now: clock.now });
    const fails: string[] = [];

    // ① 帧不合规
    await beginOn(h);
    const c1 = await rawPair(h.port);
    c1.send('garbage');
    await c1.waitFrames(1);
    fails.push(c1.frames[0]);
    expect(hostState(h)?.attemptsLeft).toBe(5);              // 没扣次数
    expect(h.events.filter(e => e.kind === 'failed'), '没扣次数的失败不发事件').toEqual([]);

    // ② cA 不对
    const c2 = await rawPair(h.port);
    const a2 = new FakeJoiner(randomW());
    c2.send(a2.hello());
    await c2.waitFrames(1);
    a2.onReply(c2.frames[0]);
    c2.send(a2.confirm());
    await c2.waitFrames(2);
    fails.push(c2.frames[1]);

    // ③ 握手中途过期（confirm 已经是对的）
    const b3 = await beginOn(h);
    const a3 = new FakeJoiner(await derivePasswordScalar(b3.code));
    const c3 = await rawPair(h.port);
    c3.send(a3.hello());
    await c3.waitFrames(1);
    expect(a3.onReply(c3.frames[0]).cBok).toBe(true);
    clock.advance(301_000);
    c3.send(a3.confirm());
    await c3.waitFrames(2);
    fails.push(c3.frames[1]);
    expect(h.store.get(a3.fp)).toBeUndefined();

    // ④ 握手中途取消（confirm 已经是对的）
    const b4 = await beginOn(h);
    const a4 = new FakeJoiner(await derivePasswordScalar(b4.code));
    const c4 = await rawPair(h.port);
    c4.send(a4.hello());
    await c4.waitFrames(1);
    expect(a4.onReply(c4.frames[0]).cBok).toBe(true);
    expect((await h.local.call('remote.pair.cancel')).cancelled).toBe(true);
    c4.send(a4.confirm());
    await c4.waitFrames(2);
    fails.push(c4.frames[1]);
    expect(h.store.get(a4.fp)).toBeUndefined();

    expect(fails).toEqual([PAIR_FAIL_FRAME, PAIR_FAIL_FRAME, PAIR_FAIL_FRAME, PAIR_FAIL_FRAME]);
    expect(PAIR_FAIL_FRAME).toBe('{"t":"dm.pair.fail","v":2}');
  });

  it('没扣次数的失败不发 failed 事件（否则审计表可以被无限刷）：垃圾帧 20 次、二进制帧、连上就断、自报本机身份，事件只有 begin；扣过次数的失败恰好多一条', async () => {
    const { h, w } = await hostWithCode();
    // 这些连接都不扣次数、也不限次：码待用期间谁都能一条接一条地连
    for (let i = 0; i < 20; i++) {
      const c = await rawPair(h.port);
      expect(c.status, `第 ${i + 1} 条垃圾连接被受理`).toBeUndefined();
      c.send(`garbage-${i}`);
      expect(await c.waitFrames(1)).toBe(true);
      await c.closed;
    }
    const bin = await rawPair(h.port);
    bin.sendBinary(new Uint8Array([1, 2, 3]));
    await bin.closed;
    const idle = await rawPair(h.port);
    expect(idle.status).toBeUndefined();
    idle.close();                                             // 连上就断，一帧不发
    await waitFor('握手槽位释放', () => hostState(h)?.inFlight === false);
    const self = await rawPair(h.port);
    self.send(new FakeJoiner(w).hello('', 0, { id: h.service.myPublicKey }));   // 合规的 hello，身份是 H 自己
    expect(await self.waitFrames(1)).toBe(true);
    expect(self.frames).toEqual([PAIR_FAIL_FRAME]);
    await self.closed;

    expect(hostState(h)).toMatchObject({ attemptsLeft: 5, inFlight: false });
    expect(h.events).toEqual([{ kind: 'begin', protocol: 2 }]);

    // 对照：扣了次数的失败进审计，而且只多这一条
    const c = await rawPair(h.port);
    const a = new FakeJoiner(randomW());
    c.send(a.hello());
    expect(await c.waitFrames(1)).toBe(true);
    a.onReply(c.frames[0]);
    c.send(a.confirm());
    expect(await c.waitFrames(2)).toBe(true);
    await c.closed;
    expect(hostState(h)?.attemptsLeft).toBe(4);
    expect(h.events.slice(1)).toEqual([{ kind: 'failed', protocol: 2, role: 'host', code: 'PAIR_CONFIRM_FAILED' }]);
  });
});

describe('V2 并发猜码：每个码最多 5 次握手', () => {
  /** 重试式攻击者：升级得到 401 就隔几毫秒重连，直到 H 的码没了。硬上限：累计 12 条 reply 或 5 秒，免得坏实现让用例挂死。 */
  async function attack(h: TestNode, n: number, mode: 'wrong-confirm' | 'drop-after-reply'): Promise<number[]> {
    const left: number[] = [];
    const t0 = Date.now();
    const stop = (): boolean => hostState(h) === undefined || left.length >= 12 || Date.now() - t0 > 5000;
    await Promise.all(Array.from({ length: n }, async () => {
      while (!stop()) {
        const c = await rawPair(h.port);
        if (c.status !== undefined) { await sleep(3); continue; }
        const a = new FakeJoiner(randomW());
        c.send(a.hello());
        if (!(await c.waitFrames(1)) || c.frames[0] === PAIR_FAIL_FRAME) { c.close(); continue; }
        // 每收到一条 reply，就地读一次 H 的剩余次数
        left.push(hostState(h)?.attemptsLeft ?? -1);
        if (mode === 'wrong-confirm') {
          a.onReply(c.frames[0]);
          c.send(a.confirm());
          await c.waitFrames(2);
        }
        c.close();
        await c.closed;
      }
    }));
    return left;
  }

  it('20 个攻击者各用随机的 w、发错的 cA：恰好 5 条 reply，剩余次数依次 4、3、2、1、0；之后正确的码也进不来', async () => {
    const { h, code } = await hostWithCode();
    const left = await attack(h, 20, 'wrong-confirm');
    expect(left).toEqual([4, 3, 2, 1, 0]);
    expect(outcome(h)).toMatchObject({ kind: 'failed', code: 'PAIR_ATTEMPTS_EXHAUSTED' });
    const j = await bootNode(cleanups);
    expect(await pairCodeOf(joinVia(j, h.port, code))).toBe('PAIR_NO_PENDING');
    expect(h.store.list()).toEqual([]);
    // 每个码最多 5 条握手失败事件，外加码结束时的一条
    expect(h.events.filter(e => e.kind === 'failed').map(e => (e as any).code)).toEqual([
      'PAIR_CONFIRM_FAILED', 'PAIR_CONFIRM_FAILED', 'PAIR_CONFIRM_FAILED', 'PAIR_CONFIRM_FAILED', 'PAIR_CONFIRM_FAILED', 'PAIR_ATTEMPTS_EXHAUSTED',
    ]);
  });

  it('(a) 攻击者收到 reply 后直接断开、不发 confirm：仍然恰好 5 条，结局相同', async () => {
    const { h } = await hostWithCode();
    const left = await attack(h, 20, 'drop-after-reply');
    expect(left).toEqual([4, 3, 2, 1, 0]);
    await waitFor('码作废', () => hostState(h) === undefined);
    expect(outcome(h)).toMatchObject({ kind: 'failed', code: 'PAIR_ATTEMPTS_EXHAUSTED' });
  });

  it('(b) 一条握手停在「已收到 reply、未发 confirm」时并发发起 10 条连接：全部 401，剩余次数不变', async () => {
    const { h } = await hostWithCode();
    const c = await rawPair(h.port);
    c.send(new FakeJoiner(randomW()).hello());
    await c.waitFrames(1);
    expect(hostState(h)).toMatchObject({ attemptsLeft: 4, inFlight: true });
    const others = await Promise.all(Array.from({ length: 10 }, () => rawPair(h.port)));
    expect(others.map(o => o.status)).toEqual(Array(10).fill(401));
    expect(hostState(h)).toMatchObject({ attemptsLeft: 4, inFlight: true });
    c.close();
  });

  it('(c) hello 里的 pA 是 65 字节、首字节 0x04、但不在曲线上：收到失败帧，剩余次数减 1', async () => {
    const { h } = await hostWithCode();
    const a = new FakeJoiner(randomW());
    const good = JSON.parse(a.hello());
    const pA = Buffer.from(good.pA, 'base64url');
    pA[64] ^= 1;
    const c = await rawPair(h.port);
    c.send(encodePairHello({ id: a.identity.publicKey, name: '', listenPort: 0, pA: new Uint8Array(pA) }));
    await c.waitFrames(1);
    expect(c.frames).toEqual([PAIR_FAIL_FRAME]);
    expect(hostState(h)).toMatchObject({ attemptsLeft: 4, inFlight: false });
  });

  it('4 次错码之后第 5 次用对的码成功（次数没多扣）', async () => {
    const { h, code } = await hostWithCode();
    for (let i = 0; i < 4; i++) {
      const c = await rawPair(h.port);
      const a = new FakeJoiner(randomW());
      c.send(a.hello());
      await c.waitFrames(1);
      a.onReply(c.frames[0]);
      c.send(a.confirm());
      await c.waitFrames(2);
      await c.closed;
    }
    expect(hostState(h)?.attemptsLeft).toBe(1);
    const j = await bootNode(cleanups);
    const r = await joinVia(j, h.port, code, { peerName: 'J', listenPort: j.port });
    expect(r).toMatchObject({ ok: true, peerFingerprint: h.fp, protocol: 2 });
    expect(h.store.get(j.fp)?.pairingProtocol).toBe(2);
  });

  // 变异核对补的：去掉收 hello 时的次数复查，上面的用例全绿——在途互斥还在的时候，会话开着而次数已经是 0 的状态到不了。
  // 那道复查是为「哪天互斥被改掉」留的，从外面测不到；这里直接向受理器要一个会话，再伸手把剩余次数拨成 0 来摆出那个状态。
  it('次数上限不只靠在途互斥：会话开着而剩余次数已经是 0 时，hello 得到失败帧，不回 reply、不再扣次数', async () => {
    const { h, w } = await hostWithCode();
    const session = h.service.pairingAcceptor.open({});
    expect(session).toBeDefined();
    const pending = (h.service as any).host.pending as { attemptsLeft: number };
    expect(pending.attemptsLeft).toBe(5);
    pending.attemptsLeft = 0;
    // 码是对的、帧也合规：拦下它的只有次数
    expect(session!.onFrame(new FakeJoiner(w).hello('late', 0))).toEqual({ reply: PAIR_FAIL_FRAME, end: true });
    expect(pending.attemptsLeft).toBe(0);
    expect(hostState(h)).toBeUndefined();
    expect(outcome(h)).toMatchObject({ kind: 'failed', code: 'PAIR_ATTEMPTS_EXHAUSTED' });
    expect(h.store.list()).toEqual([]);
  });
});

describe('本机网页连不上配对入口（带 Origin 头的一律 401）', () => {
  it('三种 Origin 各连一次：全部 401，次数不变、不占槽位；随后不带 Origin 的正常加入成功', async () => {
    const { h, code } = await hostWithCode();
    for (const origin of ['http://evil.example', 'http://localhost:5173', 'file://']) {
      const c = await rawPair(h.port, { origin });
      expect(c.status, origin).toBe(401);
    }
    expect(hostState(h)).toMatchObject({ attemptsLeft: 5, inFlight: false });
    const j = await bootNode(cleanups);
    expect(await joinVia(j, h.port, code)).toMatchObject({ ok: true, protocol: 2 });
  });
  it('源码守卫：加入端不带 Origin 头（pair-join.ts 里不出现 origin）', () => {
    const src = readFileSync(join(__dirname, '../src/minisd/remote/pair-join.ts'), 'utf8');
    expect(src).not.toMatch(/origin/i);
  });
  it('?pair 的值不是 2、没有受理器的服务器：401', async () => {
    const { h } = await hostWithCode();
    expect((await rawConnect(`ws://127.0.0.1:${h.port}/?pair=1`)).status).toBe(401);
    expect((await rawConnect(`ws://127.0.0.1:${h.port}/?pair=`)).status).toBe(401);
    expect((await rawConnect(`ws://127.0.0.1:${h.port}/?pair=2&pairingCode=x`)).status).toBeUndefined(); // pair 分支先于通用分支
    expect(h.upgradeLog).toEqual([]);                        // 带 pair 参数的请求不落进通用分支
  });
});

describe('V2 重放', () => {
  it('(a) 成功后重放 M1 → 升级 401；(b) 在仍有效的码上重放旧 M1 加旧 M3 → 失败并扣次数；(c) 把旧 M2 喂给新的 J → PAIR_CONFIRM_FAILED', async () => {
    const { h, w } = await hostWithCode();
    const id = new StaticIdentity();
    const first = await manualPair(h, w, id);
    const [oldM1, oldM3] = first.sent;
    const oldM2 = first.frames[0];

    // (a) 码已单次消费
    const r1 = await rawPair(h.port);
    expect(r1.status).toBe(401);

    // (b) 新的码上重放：H 的 y 每次握手新取，旧 cA 对不上新 transcript
    await h.local.call('remote.unpair', { peerFingerprint: first.a.fp });
    await beginOn(h);
    const r2 = await rawPair(h.port);
    r2.send(oldM1);
    await r2.waitFrames(1);
    expect(r2.frames[0]).not.toBe(oldM2);                    // reply 里的 pB、cB 是新的
    r2.send(oldM3);
    await r2.waitFrames(2);
    expect(r2.frames[1]).toBe(PAIR_FAIL_FRAME);
    expect(hostState(h)?.attemptsLeft).toBe(4);
    expect(h.store.get(first.a.fp)).toBeUndefined();

    // (c) 假 H 把录下的旧 M2 原样发给一个新的 J（J 的 x 是新的）
    const fh = await fakeHost(cleanups, { w, reply: () => oldM2 });
    const jv = new FaultVault();
    const j = await bootNode(cleanups, { vault: jv });
    // J 用的码要能算出同一个 w：直接用 H 当前的码不行（已换新），所以这里让 J 用任意合法的码——确认必然失败
    const b = await beginOn(await bootNode(cleanups));
    expect(await pairCodeOf(joinVia(j, fh.port, b.code))).toBe('PAIR_CONFIRM_FAILED');
    expect(jv.pairingSets()).toEqual([]);
    expect(fh.received).toHaveLength(1);                     // J 没有发 confirm
  });

  it('(c′) 同一个码、同一个 w：录下的旧 M2 喂给新的 J 仍然 PAIR_CONFIRM_FAILED（x 每次握手新取）', async () => {
    const { h, code, w } = await hostWithCode();
    // 先让一个知道码的 J 手工握到 reply 为止，录下 M2
    const c = await rawPair(h.port);
    const a = new FakeJoiner(w);
    c.send(a.hello('n', 0));
    await c.waitFrames(1);
    const oldM2 = c.frames[0];
    expect(a.onReply(oldM2).cBok).toBe(true);
    c.close();
    const fh = await fakeHost(cleanups, { w, reply: () => oldM2 });
    const jv = new FaultVault();
    const j = await bootNode(cleanups, { vault: jv });
    expect(await pairCodeOf(joinVia(j, fh.port, code, { peerName: 'n', listenPort: 0 }))).toBe('PAIR_CONFIRM_FAILED');
    expect(jv.pairingSets()).toEqual([]);
  });

  it('(b′) 同一个仍有效的码上重放：录下一次没走完的握手的 M1 与没送达的 M3，新连接上原样重放 → 失败并扣次数（H 的 y 每次握手新取）', async () => {
    const { h, w } = await hostWithCode();
    // 知道码的 J 握到 reply、算出了正确的 cA，但 M3 没送到、连接就断了：这次握手算一次失败的尝试，码仍有效
    const c = await rawPair(h.port);
    const a = new FakeJoiner(w);
    const oldM1 = a.hello('n', 0);
    c.send(oldM1);
    expect(await c.waitFrames(1)).toBe(true);
    const oldM2 = c.frames[0];
    expect(a.onReply(oldM2).cBok).toBe(true);
    const oldM3 = a.confirm();
    c.close();
    await waitFor('握手槽位释放', () => hostState(h)?.inFlight === false);
    expect(hostState(h)?.attemptsLeft).toBe(4);

    const r = await rawPair(h.port);
    expect(r.status).toBeUndefined();
    r.send(oldM1);
    expect(await r.waitFrames(1)).toBe(true);
    // 同一个 w、同一条 M1：y 若复用，pB 与整个 transcript 都和上一次相同，录下的 cA 就能通过
    expect(Buffer.from(parsePairReply(r.frames[0]).pB).toString('hex')).not.toBe(Buffer.from(parsePairReply(oldM2).pB).toString('hex'));
    r.send(oldM3);
    expect(await r.waitFrames(2)).toBe(true);
    expect(r.frames[1]).toBe(PAIR_FAIL_FRAME);
    expect(hostState(h)?.attemptsLeft).toBe(3);
    expect(h.store.list()).toEqual([]);
  });

  it('J 的 x 每次握手新取：同一个 J 用同一个码连两次，两条 M1 的身份相同而 pA 不同', async () => {
    const fh = await fakeHost(cleanups, { w: randomW() });        // 不知道码的对端：两次都在 cB 上失败，J 什么都不写
    const j = await bootNode(cleanups);
    const code = generatePairingCodeV2();
    expect(await pairCodeOf(joinVia(j, fh.port, code))).toBe('PAIR_CONFIRM_FAILED');
    expect(await pairCodeOf(joinVia(j, fh.port, code))).toBe('PAIR_CONFIRM_FAILED');
    expect(fh.received).toHaveLength(2);
    const [m1, m2] = fh.received.map(t => parsePairHello(t));
    expect(Buffer.from(m1.id).toString('hex')).toBe(Buffer.from(m2.id).toString('hex'));
    // 同一个码（同一个 w）、同一个身份：pA 不同只能来自 x 不同
    expect(Buffer.from(m1.pA).toString('hex')).not.toBe(Buffer.from(m2.pA).toString('hex'));
  });
});

describe('V2 角色反射', () => {
  it('(a) 把 J 的 M1 改 t 后弹回 J → PAIR_PROTOCOL', async () => {
    const fh = await fakeHost(cleanups, { w: randomW(), reply: hello => JSON.stringify({ ...JSON.parse(encodePairHello(hello)), t: 'dm.pair.reply' }) });
    const j = await bootNode(cleanups);
    const code = (await beginOn(await bootNode(cleanups))).code;
    expect(await pairCodeOf(joinVia(j, fh.port, code))).toBe('PAIR_PROTOCOL');
  });
  it('(b) 以 M2 的形状回填 J 自己的 id → PAIR_SELF；id 换成别的但 pB 等于 J 的 pA → PAIR_PROTOCOL', async () => {
    const code = (await beginOn(await bootNode(cleanups))).code;
    const jv = new FaultVault();
    const j = await bootNode(cleanups, { vault: jv });
    const self = await fakeHost(cleanups, { w: randomW(), reply: (hello, honest) => JSON.stringify({ t: 'dm.pair.reply', v: 2, id: Buffer.from(hello.id).toString('base64url'), pB: Buffer.from(honest.pB).toString('base64url'), cB: Buffer.from(honest.cB).toString('base64url') }) });
    expect(await pairCodeOf(joinVia(j, self.port, code))).toBe('PAIR_SELF');
    const mirror = await fakeHost(cleanups, { w: randomW(), reply: (hello, honest) => JSON.stringify({ t: 'dm.pair.reply', v: 2, id: Buffer.from(honest.id).toString('base64url'), pB: Buffer.from(hello.pA).toString('base64url'), cB: Buffer.from(honest.cB).toString('base64url') }) });
    expect(await pairCodeOf(joinVia(j, mirror.port, code))).toBe('PAIR_PROTOCOL');
    expect(jv.pairingSets()).toEqual([]);
  });
  it('(c) 把 H 的 id、pB 当 M1 发回 H → 失败且不扣次数；(d) 把 H 的 cB 当 cA 发回 → 失败', async () => {
    const { h, w } = await hostWithCode();
    // 先拿到 H 的一条 reply
    const c0 = await rawPair(h.port);
    const a0 = new FakeJoiner(w);
    c0.send(a0.hello());
    await c0.waitFrames(1);
    const reply = parsePairReply(c0.frames[0]);
    // (d) 同一条连接上把 cB 当 cA 发回
    c0.send(a0.confirm(reply.cB));
    await c0.waitFrames(2);
    expect(c0.frames[1]).toBe(PAIR_FAIL_FRAME);
    await c0.closed;
    expect(hostState(h)?.attemptsLeft).toBe(4);
    expect(h.store.list()).toEqual([]);
    // (c) 新连接：id 是 H 自己的静态公钥、pA 是 H 的 pB
    const c1 = await rawPair(h.port);
    c1.send(encodePairHello({ id: reply.id, name: '', listenPort: 0, pA: reply.pB }));
    await c1.waitFrames(1);
    expect(c1.frames).toEqual([PAIR_FAIL_FRAME]);
    expect(hostState(h)).toMatchObject({ attemptsLeft: 4, inFlight: false });   // 没有再扣
    // 事件也只有 (d) 那一次扣过次数的失败；(c) 没扣次数，不进审计
    expect(h.events.filter(e => e.kind === 'failed')).toEqual([{ kind: 'failed', protocol: 2, role: 'host', code: 'PAIR_CONFIRM_FAILED' }]);
  });
});

describe('V2 重复 confirm（握手结束后不再处理帧）', () => {
  it('收到 done 后同一连接再发 confirm：记录只写一次，连接已关；新连接只发 confirm → 失败帧', async () => {
    const hv = new FaultVault();
    const h = await bootNode(cleanups, { vault: hv });
    const { code } = await beginOn(h);
    const a = new FakeJoiner(await derivePasswordScalar(code));
    const c = await rawPair(h.port);
    c.send(a.hello());
    await c.waitFrames(1);
    a.onReply(c.frames[0]);
    const confirm = a.confirm();
    c.send(confirm);
    // 紧跟着再发两次：服务端在第一条 confirm 上已结束握手
    try { c.send(confirm); c.send(confirm); } catch { /* 连接可能已在关闭 */ }
    await c.waitFrames(2);
    await c.closed;
    expect(c.frames).toHaveLength(2);
    expect(c.frames[1]).toBe(PAIR_DONE_FRAME);
    expect(hv.setsOf(a.fp)).toBe(1);

    await beginOn(h);
    const c2 = await rawPair(h.port);
    c2.send(confirm);
    await c2.waitFrames(1);
    expect(c2.frames).toEqual([PAIR_FAIL_FRAME]);
    expect(hostState(h)?.attemptsLeft).toBe(5);              // 帧不合规（此时要的是 hello），不扣次数
    expect(hv.setsOf(a.fp)).toBe(1);
  });
});

describe('V2 过期', () => {
  it('(a) 过期后 ?pair=2 → 401，结局 PAIR_EXPIRED', async () => {
    const clock = fakeClock();
    const h = await bootNode(cleanups, { now: clock.now });
    await beginOn(h);
    clock.advance(300_000);
    expect((await rawPair(h.port)).status).toBe(401);
    expect(outcome(h)).toMatchObject({ kind: 'failed', code: 'PAIR_EXPIRED' });
    expect(h.events.at(-1)).toEqual({ kind: 'failed', protocol: 2, role: 'host', code: 'PAIR_EXPIRED' });
  });

  it('(b) 握手卡在 M3 时过期：H 不落盘，J 回滚，两端无残留', async () => {
    const clock = fakeClock();
    const h = await bootNode(cleanups, { now: clock.now });
    const { code } = await beginOn(h);
    const jv = new FaultVault();
    const j = await bootNode(cleanups, { vault: jv });
    const hold = gate();
    const relay = await mitm(cleanups, h.port, async f => { if (f.dir === 'c2s' && f.index === 1) await hold.wait; });
    const joining = pairCodeOf(joinVia(j, relay.port, code));
    await waitFor('M3 到了中继', () => relay.frames.some(f => f.dir === 'c2s' && f.index === 1));
    expect(jv.setsOf(h.fp)).toBe(1);                         // J 已先落盘（暂存）
    expect(j.store.get(h.fp)).toBeUndefined();               // 但没有生效
    clock.advance(301_000);
    hold.open();
    expect(await joining).toBe('PAIR_PEER_REJECTED');
    expect(outcome(h)).toMatchObject({ kind: 'failed', code: 'PAIR_EXPIRED' });
    await expectNoResidue(h, j.fp, jv.writtenKeys(h.fp));
    await expectNoResidue(j, h.fp, jv.writtenKeys(h.fp));
  });

  it('(c) 时钟越过有效期后不发任何连接：pairingStatus() 与 remote.status 都不再报告这个码，结局 PAIR_EXPIRED', async () => {
    const clock = fakeClock();
    const h = await bootNode(cleanups, { now: clock.now });
    await beginOn(h);
    const before = (await h.local.call('remote.status')).pairing;
    expect(before.host).toMatchObject({ protocol: 2, attemptsLeft: 5, inFlight: false });
    expect(before.host.expiresAt).toBe(clock.now() + 300_000);
    clock.advance(300_000);
    const st = (await h.local.call('remote.status')).pairing;
    expect(st.host).toBeUndefined();
    expect(st.lastHostOutcome).toMatchObject({ kind: 'failed', code: 'PAIR_EXPIRED' });
    expect(hostState(h)).toBeUndefined();
  });

  it('(d) 到期定时器：没有人连进来、也没有人查状态，到点自己清掉并发事件', async () => {
    const h = await bootNode(cleanups, { codeTtlMs: 150 });
    await h.service.beginPairingV2();
    // 只等事件，不碰 pairingStatus()（它自己会做过期检查，那样就测不到定时器）
    await waitFor('到期事件', () => h.events.some(e => e.kind === 'failed' && e.code === 'PAIR_EXPIRED'), 3000);
    expect(h.events.map(e => e.kind)).toEqual(['begin', 'failed']);
  });

  it('注入的有效期只能调短：大于 300 秒按 300 秒算', async () => {
    const clock = fakeClock();
    const h = await bootNode(cleanups, { now: clock.now, codeTtlMs: 3_600_000 });
    const r = await h.service.beginPairingV2();
    expect(r.expiresAt).toBe(clock.now() + 300_000);
    h.service.cancelPairing();
  });
});

describe('V2 取消', () => {
  it('(a) H 取消后加入 → PAIR_NO_PENDING', async () => {
    const { h, code } = await hostWithCode();
    expect(await h.local.call('remote.pair.cancel')).toEqual({ ok: true, cancelled: true });
    const j = await bootNode(cleanups);
    expect(await pairCodeOf(joinVia(j, h.port, code))).toBe('PAIR_NO_PENDING');
    expect(outcome(h)).toMatchObject({ kind: 'failed', code: 'PAIR_CANCELLED' });
    // 一次取消只记一行：cancelled 事件，没有额外的 failed
    expect(h.events.map(e => e.kind)).toEqual(['begin', 'cancelled']);
  });

  it('(b) 握手卡在 M3 时 H 取消：H 不落盘，J 回滚', async () => {
    const { h, code } = await hostWithCode();
    const jv = new FaultVault();
    const j = await bootNode(cleanups, { vault: jv });
    const hold = gate();
    const relay = await mitm(cleanups, h.port, async f => { if (f.dir === 'c2s' && f.index === 1) await hold.wait; });
    const joining = pairCodeOf(joinVia(j, relay.port, code));
    await waitFor('M3 到了中继', () => relay.frames.some(f => f.dir === 'c2s' && f.index === 1));
    await h.local.call('remote.pair.cancel');
    hold.open();
    expect(await joining).toBe('PAIR_PEER_REJECTED');
    await expectNoResidue(h, j.fp, jv.writtenKeys(h.fp));
    await expectNoResidue(j, h.fp, jv.writtenKeys(h.fp));
  });

  it('(c) 新的 begin 顶掉旧码：旧码配不上', async () => {
    const { h, code: oldCode } = await hostWithCode();
    const { code: newCode } = await beginOn(h);
    expect(newCode).not.toBe(oldCode);
    const j = await bootNode(cleanups);
    expect(await pairCodeOf(joinVia(j, h.port, oldCode))).toBe('PAIR_CONFIRM_FAILED');
    await waitFor('H 收尾', () => hostState(h)?.inFlight === false);
    expect(h.store.list()).toEqual([]);
    expect(await joinVia(j, h.port, newCode)).toMatchObject({ ok: true });
  });

  it('(d) v1 的待用码也被 remote.pair.cancel 清掉：之后 ?pairingCode=<那个码> 得 401', async () => {
    const h = await bootNode(cleanups, { policy: 'legacy' });
    const b = await beginOn(h);
    expect(b.protocol).toBe(1);
    expect(b.code).toHaveLength(8);
    expect(h.service.hasPending(b.code)).toBe(true);
    expect(await h.local.call('remote.pair.cancel')).toEqual({ ok: true, cancelled: true });
    expect((await rawConnect(`ws://127.0.0.1:${h.port}/?pairingCode=${b.code}`)).status).toBe(401);
  });

  it('(e) 取消幂等：没有码时返回 cancelled: false', async () => {
    const h = await bootNode(cleanups);
    expect(await h.local.call('remote.pair.cancel')).toEqual({ ok: true, cancelled: false });
    await beginOn(h);
    expect((await h.local.call('remote.pair.cancel')).cancelled).toBe(true);
    expect((await h.local.call('remote.pair.cancel')).cancelled).toBe(false);
    expect(h.events.filter(e => e.kind === 'cancelled')).toHaveLength(1);
  });

  it('(f) begin 的 scrypt 进行中取消 → 那次 begin 抛 PAIR_CANCELLED，没有码被安装', async () => {
    const h = await bootNode(cleanups);
    const pending = h.service.beginPairingV2();              // 同步跑到 scrypt 的 await 为止
    h.service.cancelPairing();
    expect(await pairCodeOf(pending)).toBe('PAIR_CANCELLED');
    expect(hostState(h)).toBeUndefined();
    expect((await rawPair(h.port)).status).toBe(401);
    expect(h.events.some(e => e.kind === 'begin')).toBe(false);
  });

  it('H 已验过 cA 并落盘之后的取消不影响这条已完成的配对', async () => {
    const { h, w } = await hostWithCode();
    const { a } = await manualPair(h, w);
    expect((await h.local.call('remote.pair.cancel')).cancelled).toBe(false);
    expect(h.store.get(a.fp)).toBeDefined();
  });
});

describe('超时与占位', () => {
  it('连上不发帧 → 到点被关且槽位释放（不扣次数），随后正常加入成功', async () => {
    // 「在途时第二条连接 → 401 且不扣次数」在上面并发猜码的变体 (b) 里测（那里没有时限在跑）
    // 每步时限 1 秒而不是更短：后面那次正常加入的每一步（含 J 的落盘）也受它约束，机器忙的时候太短的时限会把正常握手也掐掉
    const { h, code } = await hostWithCode({ pairStepMs: 1000 });
    const idle = await rawPair(h.port);
    await idle.closed;                                      // 服务端到点关的
    expect(idle.frames).toEqual([]);
    expect(hostState(h)).toMatchObject({ attemptsLeft: 5, inFlight: false });
    const j = await bootNode(cleanups);
    expect(await joinVia(j, h.port, code)).toMatchObject({ ok: true });
  });

  it('发 reply 后不回 confirm → 到点关闭，次数已扣，槽位释放', async () => {
    // 时限从连接建立起算，hello 要在它之内送到：给 1 秒，机器忙的时候不会在 hello 之前就到点
    const { h } = await hostWithCode({ pairStepMs: 1000 });
    const c = await rawPair(h.port);
    c.send(new FakeJoiner(randomW()).hello());
    expect(await c.waitFrames(1)).toBe(true);
    await c.closed;
    expect(c.frames).toHaveLength(1);
    expect(hostState(h)).toMatchObject({ attemptsLeft: 4, inFlight: false });
  });

  it('二进制帧、超过 2048 字节的帧：握手结束，不回任何帧', async () => {
    const { h } = await hostWithCode();
    const c1 = await rawPair(h.port);
    c1.sendBinary(new Uint8Array([1, 2, 3]));
    await c1.closed;
    expect(c1.frames).toEqual([]);
    const c2 = await rawPair(h.port);
    c2.send(' '.repeat(2049));
    await c2.closed;
    expect(c2.frames).toEqual([]);
    expect(hostState(h)).toMatchObject({ attemptsLeft: 5, inFlight: false });
    expect(h.events.map(e => e.kind), '没扣次数的失败不发事件').toEqual(['begin']);
  });

  it('关停时在途的 ?pair=2 连接被终止', async () => {
    const { h } = await hostWithCode();
    const c = await rawPair(h.port);
    await h.close();
    await c.closed;
    expect(c.isClosed()).toBe(true);
  });
});

describe('B3：握手未成功的连接没有任何业务能力', () => {
  const rpcFrame = (method: string): string => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} });

  it('握手各阶段发 JSON-RPC 帧（echo、remote.status、permission.respond）：处理器一次都没被调，收到的只有失败帧，连接被关', async () => {
    const { h } = await hostWithCode();
    // 阶段一：还没发 hello
    for (const method of ['echo', 'remote.status', 'permission.respond']) {
      const c = await rawPair(h.port);
      c.send(rpcFrame(method));
      await c.waitFrames(1);
      await c.closed;
      expect(c.frames, method).toEqual([PAIR_FAIL_FRAME]);
    }
    expect(h.events.map(e => e.kind), '阶段一的失败都没扣次数，不发事件').toEqual(['begin']);
    // 阶段二：已收到 reply、等 confirm
    for (const method of ['echo', 'remote.status', 'permission.respond']) {
      const c = await rawPair(h.port);
      c.send(new FakeJoiner(randomW()).hello());
      await c.waitFrames(1);
      c.send(rpcFrame(method));
      await c.waitFrames(2);
      await c.closed;
      expect(c.frames[1], method).toBe(PAIR_FAIL_FRAME);
      expect(c.frames, method).toHaveLength(2);
    }
    expect(h.echoCalls).toEqual([]);
    expect(h.store.list()).toEqual([]);
  });

  it('握手进行中广播 chat.event：这条连接一帧都收不到；它不算入站在线', async () => {
    const { h } = await hostWithCode();
    const a = new FakeJoiner(randomW());
    const c = await rawPair(h.port);
    h.rpc.broadcast('chat.event', { text: 'SECRET-1' });
    c.send(a.hello());
    await c.waitFrames(1);
    h.rpc.broadcast('chat.event', { text: 'SECRET-2' });
    h.rpc.broadcast('permission.request', { text: 'SECRET-3' });
    expect(h.rpc.isInboundOnline(a.fp)).toBe(false);
    c.send('x');                                              // 让握手失败收尾，拿到最后一帧
    await c.waitFrames(2);
    await c.closed;
    expect(c.frames).toHaveLength(2);
    expect(c.frames.join('')).not.toContain('SECRET');
    expect(c.binaryFrames).toBe(0);
    // 本机的 local 连接收得到同一批广播（对照：广播确实发出去了）
    await waitFor('local 收到广播', () => h.local.notifications.length >= 3);
  });

  it('源码守卫：runPairing 的函数体里不出现 attach(，也不往 clients 里登记', () => {
    const src = readFileSync(join(__dirname, '../src/minisd/rpc/server.ts'), 'utf8');
    const start = src.indexOf('private runPairing(');
    const end = src.indexOf('private attach(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // 函数体：从签名之后到下一个方法的文档注释之前
    const body = src.slice(src.indexOf('{', start), src.lastIndexOf('}', end));
    expect(body).not.toContain('attach(');
    expect(body).not.toContain('clients.set');
    expect(body).not.toContain('inboundRemote');
  });
});
