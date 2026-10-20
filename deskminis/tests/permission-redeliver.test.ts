/**
 * F06：权限卡的补发与答复资格（F13 留的接缝）。
 *
 * F13 的规则：一张待批的卡只接受发卡时已经连着的连接的答复。重载、重连之后的窗口是一条新连接，
 * 卡片重新显示出来了却点不动。F06 把规则放宽一处：引擎经 deliver() 把这张卡的完整内容交给过的连接也可以答复
 *（state.attach 的两种应答都调它）。没取回过卡片、只凭旧 requestId 来答的新连接照旧是 undelivered。
 *
 * G4：broker 单测（真实 PermissionBroker + 真实网关，按 index.ts 的写法接线；连接序号由用例给）。
 * G3：部件级装配（真 RpcServer + guardBusinessMethod + 真 broker + 真 WebSocket，照 permission-broker.test.ts 的 K10）。
 *     它自己装配方法表与守卫、不经过 index.ts——真实装配上的行为由 state-sync-minisd 的 G5 钉。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { PermissionBroker, responderOf, type Responder } from '../src/minisd/tools/permission-broker';
import type { PermissionRequest } from '../src/minisd/tools/types';
import type { PermissionOutcome } from '../src/shared/permission';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService, StaticIdentity, derivePairingKey } from '../src/minisd/remote/pairing';
import { createAdditionalVerify, guardBusinessMethod } from '../src/minisd/remote';
import { encodePaseto } from '../src/minisd/remote/paseto';
import { RpcServer, type RpcConnection, type RpcMethods } from '../src/minisd/rpc/server';
import { mkStack, MemAudit, Wire, type Stack } from './permission-stack-fixture';
import { waitFor } from './permission-fixture';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) { try { await cleanups.pop()!(); } catch { /* 收尾尽力 */ } } });

const req = (kind: PermissionRequest['kind'], detail: string, sessionId = 'S1'): PermissionRequest => ({ kind, detail, sessionId, toolTitle: 't' });
const WRITE = req('file-write', 'C:\\w\\a.txt');
const BRIDGE_SHELL = req('shell', 'windows-clipboard get');
const local = (seq?: number): Responder => ({ via: 'local', ...(seq !== undefined ? { seq } : {}) });

function ask(s: Stack, r: PermissionRequest, opts?: Parameters<Stack['gateway']['decide']>[1]): { p: Promise<PermissionOutcome>; id: string } {
  const before = s.wire.cards().length;
  const p = s.gateway.decide(r, opts);
  const ids = s.wire.cards();
  if (ids.length !== before + 1) throw new Error('这次 decide 没有弹卡');
  return { p, id: ids[ids.length - 1] };
}

describe('F06 G4：broker 的补发与答复资格', () => {
  it('发卡之后才建立的连接：没取回过卡片就答 → undelivered、卡不动；deliver 之后同一条连接答复 → 生效', async () => {
    let conns = 2;
    const s = mkStack({ connSeq: () => conns });
    const a = ask(s, WRITE);
    conns = 3; // 第 3 条连接是发卡之后才连上的
    expect(s.broker.respond(a.id, 'allow-once', local(3))).toEqual({ ok: true, applied: false, undelivered: true });
    expect(s.broker.pending().map(x => x.requestId)).toEqual([a.id]);

    const got = s.broker.deliver(local(3));
    expect(got.map(x => x.requestId)).toEqual([a.id]);
    expect(s.broker.respond(a.id, 'allow-once', local(3))).toEqual({ ok: true, applied: true });
    expect(await a.p).toMatchObject({ decision: 'allow', via: 'user-once', requestId: a.id });
    // 另一条同样晚到、没有 deliver 过的连接：对已了结的卡得到 settled；对新卡仍是 undelivered
    const b = ask(s, WRITE);
    conns = 4;
    expect(s.broker.respond(b.id, 'deny', local(4))).toEqual({ ok: true, applied: false, undelivered: true });
    expect(s.broker.respond(a.id, 'deny', local(4))).toEqual({ ok: true, applied: false, settled: { reason: 'answered', decision: 'allow' } });
    s.broker.respond(b.id, 'deny', local(1));
    await b.p;
  });

  it('补发的卡与当初的广播同形：requestId / req（含 preview、note）/ meta（含 riskClass、bridgeTriggers、toolUseId）深相等', async () => {
    const s = mkStack({ connSeq: () => 1, timeoutMs: 5000 });
    const w = { ...WRITE, preview: { oldText: 'o', newText: 'n' }, note: '改应用配置' };
    const a = ask(s, w);
    const b = ask(s, BRIDGE_SHELL, { toolUseId: 'TU-9' });
    const got = s.broker.deliver(local(2));
    const sent = s.wire.of('permission.request').map(x => x.params);
    expect(got.map(({ requestId, req: r, meta }) => ({ requestId, req: r, meta }))).toEqual(sent);
    expect(got[0].req).toEqual(w);
    expect(got[1].meta).toEqual({ timeoutMs: 5000, riskClass: 'gated', bridgeTriggers: ['bridge-clipboard-read'], toolUseId: 'TU-9' });
    expect(got.map(x => x.origin)).toEqual(['tool', 'tool']);
    // 返回的是副本：改它不影响下一次交付
    (got[1].meta.bridgeTriggers as string[]).push('x');
    (got[0].req as { detail: string }).detail = '被改了';
    expect(s.broker.deliver(local(2)).map(({ requestId, req: r, meta }) => ({ requestId, req: r, meta }))).toEqual(sent);
    s.broker.respond(a.id, 'deny', local(1)); s.broker.respond(b.id, 'deny', local(1));
    await Promise.all([a.p, b.p]);
  });

  it('审计：第一次把卡登记给一条晚到的连接时写一条 permission.redelivered；同一条连接重复 deliver 不再写；发卡时已连着的连接不登记、不写', async () => {
    let conns = 2;
    const s = mkStack({ connSeq: () => conns });
    const a = ask(s, WRITE);
    conns = 4;
    // 发卡时已连着的（序号 1、2）：本来就可以答复
    s.broker.deliver(local(1));
    s.broker.deliver(local(2));
    expect(s.audit.of('permission.redelivered')).toEqual([]);
    // 晚到的 3 号：登记一次、审计一条；再来两次（静默探测、重复快照）不刷审计表
    for (let i = 0; i < 3; i++) s.broker.deliver(local(3));
    expect(s.audit.of('permission.redelivered', a.id)).toEqual([
      { eventType: 'permission.redelivered', opts: { sessionId: 'S1' }, payload: { requestId: a.id, by: 'local', connSeq: 3 } },
    ]);
    // 另一条晚到的连接（已配对设备）：各记各的，带指纹
    s.broker.deliver({ via: 'remote', peerFingerprint: 'FP-REMOTE', seq: 4 });
    expect(s.audit.of('permission.redelivered', a.id).map(x => [x.payload.by, x.payload.connSeq, x.opts.peerFingerprint])).toEqual([['local', 3, undefined], ['remote', 4, 'FP-REMOTE']]);
    // 两条都能答；第一终态获胜
    expect(s.broker.respond(a.id, 'deny', { via: 'remote', peerFingerprint: 'FP-REMOTE', seq: 4 })).toEqual({ ok: true, applied: true });
    expect(s.broker.respond(a.id, 'allow-once', local(3))).toEqual({ ok: true, applied: false, settled: { reason: 'answered', decision: 'deny' } });
    expect(await a.p).toMatchObject({ decision: 'deny', reason: 'user-denied' });
  });

  it('没有连接序号的应答方（进程内调用）：deliver 只返回、不登记；它的答复仍然不生效（失败关闭）', async () => {
    const s = mkStack({ connSeq: () => 1 });
    const a = ask(s, WRITE);
    expect(s.broker.deliver().map(x => x.requestId)).toEqual([a.id]);
    expect(s.broker.deliver({ via: 'local' }).map(x => x.requestId)).toEqual([a.id]);
    expect(s.broker.deliver(responderOf(undefined)).map(x => x.requestId)).toEqual([a.id]);
    expect(s.audit.of('permission.redelivered')).toEqual([]);
    expect(s.broker.respond(a.id, 'allow-once')).toEqual({ ok: true, applied: false, undelivered: true });
    expect(s.broker.respond(a.id, 'allow-once', { via: 'local' })).toEqual({ ok: true, applied: false, undelivered: true });
    s.broker.respond(a.id, 'deny', local(1));
    await a.p;
  });

  it('登记随卡了结而消失：被交付过旧卡的连接，对之后新发的卡没有资格（要再取一次）；已了结的卡不在交付里', async () => {
    let conns = 1;
    const s = mkStack({ connSeq: () => conns });
    const a = ask(s, WRITE);
    conns = 2;
    s.broker.deliver(local(2));
    expect(s.broker.respond(a.id, 'deny', local(2))).toEqual({ ok: true, applied: true });
    await a.p;
    expect(s.broker.deliver(local(2))).toEqual([]);
    // 新卡发出时 2 号已经连着：按 F13 原规则就可以答，不需要登记
    const b = ask(s, WRITE);
    conns = 3;
    expect(s.broker.respond(b.id, 'deny', local(3))).toEqual({ ok: true, applied: false, undelivered: true });
    expect(s.broker.respond(b.id, 'deny', local(2))).toEqual({ ok: true, applied: true });
    await b.p;
    expect(s.audit.of('permission.redelivered').map(x => x.payload.requestId)).toEqual([a.id]);
  });

  it('remainingMs：按引擎时钟算离超时还剩多少，不小于 0；补发不延长时限（到点照常超时）', async () => {
    let now = 1_000_000;
    let conns = 1;
    const s = mkStack({ connSeq: () => conns, timeoutMs: 90_000, now: () => now });
    const a = ask(s, WRITE);
    expect(s.broker.deliver(local(2))[0]).toMatchObject({ askedAt: 1_000_000, remainingMs: 90_000 });
    now += 30_500;
    expect(s.broker.deliver(local(2))[0].remainingMs).toBe(59_500);
    now += 100_000;
    expect(s.broker.deliver(local(2))[0].remainingMs).toBe(0);
    s.broker.respond(a.id, 'deny', local(1));
    await a.p;
  });

  it('statusOf 三态：待批 → pending 带会话；了结后 → settled 带结局；不认识的 id → undefined；都不写审计', async () => {
    const s = mkStack({ connSeq: () => 1 });
    const a = ask(s, req('file-write', 'C:\\w\\b.txt', 'S-A'));
    expect(s.broker.statusOf(a.id)).toEqual({ status: 'pending', sessionId: 'S-A' });
    const rows = s.audit.rows.length;
    s.broker.respond(a.id, 'allow-session', local(1));
    await a.p;
    expect(s.broker.statusOf(a.id)).toEqual({ status: 'settled', settled: { reason: 'answered', decision: 'allow' } });
    const b = ask(s, WRITE);
    s.broker.settleWhere(() => true, { reason: 'cancelled', cause: 'shutdown' });
    await b.p;
    expect(s.broker.statusOf(b.id)).toEqual({ status: 'settled', settled: { reason: 'shutdown', decision: 'deny' } });
    expect(s.broker.statusOf('NOPE')).toBeUndefined();
    // 两次了结各一条 resolved 审计（外加 b 的 request），statusOf 自己一条不写
    expect(s.audit.rows.length).toBe(rows + 3);
    expect(s.audit.rows.filter(r => r.eventType.startsWith('permission.late'))).toEqual([]);
  });

  it('pending() 的形状不变（F13 的契约）：没有 meta、没有登记表', async () => {
    const s = mkStack({ connSeq: () => 1, timeoutMs: 5000 });
    const a = ask(s, BRIDGE_SHELL, { toolUseId: 'TU-1' });
    s.broker.deliver(local(5));
    expect(s.broker.pending()).toEqual([{ requestId: a.id, req: BRIDGE_SHELL, toolUseId: 'TU-1', origin: 'tool', askedAt: expect.any(Number), bridgeTriggers: ['bridge-clipboard-read'] }]);
    s.broker.respond(a.id, 'deny', local(1));
    await a.p;
  });

  it('没有配置 connSeq（不经 RpcServer 的宿主）：不做连接检查，deliver 不登记、不写审计', async () => {
    const s = mkStack();
    const a = ask(s, WRITE);
    expect(s.broker.deliver(local(9)).map(x => x.requestId)).toEqual([a.id]);
    expect(s.audit.of('permission.redelivered')).toEqual([]);
    expect(s.broker.respond(a.id, 'allow-once')).toEqual({ ok: true, applied: true });
    await a.p;
  });

  it('补发的审计写入失败：只告警，登记照做（库写不进去时仍允许用户在重新出现的卡上答复）', async () => {
    let conns = 1;
    const s = mkStack({ connSeq: () => conns });
    const a = ask(s, WRITE);
    conns = 2;
    s.audit.failOn.add('permission.redelivered');
    expect(() => s.broker.deliver(local(2))).not.toThrow();
    expect(s.warns.some(w => w.includes('补发时审计写入失败'))).toBe(true);
    expect(s.broker.respond(a.id, 'allow-once', local(2))).toEqual({ ok: true, applied: true });
    await a.p;
  });
});

describe('F06 G3：已配对设备上的补发（真 RpcServer + guardBusinessMethod + 真 broker）', () => {
  interface Client { ws: WebSocket; closed: Promise<number>; call(method: string, params?: unknown): Promise<any> }
  function connect(port: number, query: string): Promise<Client> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?${query}`);
      const pending = new Map<number, (m: any) => void>();
      let idc = 0;
      const closed = new Promise<number>(r => ws.on('close', code => r(code)));
      ws.on('message', d => { const m = JSON.parse(String(d)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
      ws.on('open', () => res({
        ws, closed,
        call: (method, params) => new Promise(resolve => { const id = ++idc; pending.set(id, resolve); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })); }),
      }));
      ws.on('error', rej);
    });
  }

  async function rig() {
    const dir = mkdtempSync(join(tmpdir(), 'dm-f06-g3-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ } });
    const vault = new InMemoryVault();
    const store = new PairingStore(dir, vault);
    const service = new PairingService(store, vault);
    const audit = new MemAudit(); const wire = new Wire();
    let rpc!: RpcServer;
    const broker = new PermissionBroker({
      timeoutMs: 60_000, connSeq: () => rpc.lastConnSeq(),
      broadcast: (m, p) => { wire.broadcast(m, p); rpc.broadcast(m, p); }, audit: (t, p, o) => audit.append(t, p, o),
    });
    const methods: RpcMethods = {
      // state.attach 的替身：只做它与 broker 之间的那一步
      'state.attach': (_p: unknown, conn: RpcConnection) => ({ pendingPermissions: broker.deliver(responderOf(conn)) }),
      'permission.respond': (p: any, conn: RpcConnection) => broker.respond(String(p?.requestId ?? ''), p?.decision, responderOf(conn)),
    };
    const isPaired = (fp: string): boolean => service.get(fp) !== undefined;
    for (const k of Object.keys(methods)) methods[k] = guardBusinessMethod(methods[k], k, isPaired);
    rpc = new RpcServer(methods, 'LOCAL-TOKEN-G3', createAdditionalVerify(service));
    const port = await rpc.listen('127.0.0.1', 0);
    cleanups.push(() => rpc.close());
    const pairPeer = (): { fp: string; paseto: string } => {
      const peer = new StaticIdentity(); const me = new StaticIdentity();
      const key = derivePairingKey(me.privateKey, peer.publicKey, 'CODE1234', peer.fingerprint, 'peer');
      store.save(key);
      return { fp: peer.fingerprint, paseto: encodePaseto({ exp: Date.now() + 60_000, iat: Date.now(), device_fingerprint: peer.fingerprint }, key.authKey) };
    };
    const card = (): { p: Promise<unknown>; id: string } => {
      const p = broker.ask(WRITE, { signal: new AbortController().signal, origin: 'tool' });
      const ids = wire.cards();
      return { p, id: ids[ids.length - 1] };
    };
    return { rpc, port, broker, audit, wire, service, pairPeer, card };
  }

  it('发卡之后才连上的已配对设备：先答 → undelivered；attach 得到这张卡 → 再答生效；审计 by:remote 带指纹', async () => {
    const r = await rig();
    const peer = r.pairPeer();
    const c = r.card();
    const late = await connect(r.port, `paseto=${encodeURIComponent(peer.paseto)}`);
    cleanups.push(() => { late.ws.close(); });
    expect((await late.call('permission.respond', { requestId: c.id, decision: 'allow-once' })).result).toEqual({ ok: true, applied: false, undelivered: true });

    const attached = (await late.call('state.attach')).result;
    expect(attached.pendingPermissions.map((x: any) => x.requestId)).toEqual([c.id]);
    expect(attached.pendingPermissions[0].req).toEqual(WRITE);
    expect(r.audit.of('permission.redelivered', c.id)).toEqual([
      { eventType: 'permission.redelivered', opts: { sessionId: 'S1', peerFingerprint: peer.fp }, payload: { requestId: c.id, by: 'remote', connSeq: 1 } },
    ]);
    expect((await late.call('permission.respond', { requestId: c.id, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    expect(await c.p).toEqual({ answer: 'allow-once', requestId: c.id });
    expect(r.audit.of('permission.resolved', c.id)[0]).toMatchObject({ opts: { sessionId: 'S1', peerFingerprint: peer.fp }, payload: { by: 'remote', decision: 'allow-once' } });
  });

  it('配对记录被删之后：state.attach 与 permission.respond 都被守卫拒绝、回包后连接关闭；卡仍待批，没有登记、没有补发审计', async () => {
    const r = await rig();
    const peer = r.pairPeer();
    const c = r.card();
    const late = await connect(r.port, `paseto=${encodeURIComponent(peer.paseto)}`);
    cleanups.push(() => { late.ws.close(); });
    await waitFor('连接分到序号', () => r.rpc.lastConnSeq() === 1);
    r.service.delete(peer.fp);

    const a = await late.call('state.attach');
    expect(a.result).toBeUndefined();
    expect(String(a.error?.message)).toContain('配对');
    await late.closed;
    expect(r.broker.pending().map(p => p.requestId)).toEqual([c.id]);
    expect(r.audit.of('permission.redelivered')).toEqual([]);

    // 另一条同一指纹的旧连接（配对删掉之前建好的）直接答：同样被拒
    const peer2 = r.pairPeer();
    const other = await connect(r.port, `paseto=${encodeURIComponent(peer2.paseto)}`);
    cleanups.push(() => { other.ws.close(); });
    r.service.delete(peer2.fp);
    const b = await other.call('permission.respond', { requestId: c.id, decision: 'allow-once' });
    expect(b.result).toBeUndefined();
    expect(String(b.error?.message)).toContain('配对');
    await other.closed;
    expect(r.broker.pending().map(p => p.requestId)).toEqual([c.id]);
    expect(r.audit.of('permission.resolved')).toEqual([]);
    expect(r.audit.of('permission.late-response')).toEqual([]);

    // 本机连接取回卡片后照常能答
    const me = await connect(r.port, 'token=LOCAL-TOKEN-G3');
    cleanups.push(() => { me.ws.close(); });
    expect((await me.call('state.attach')).result.pendingPermissions.map((x: any) => x.requestId)).toEqual([c.id]);
    expect((await me.call('permission.respond', { requestId: c.id, decision: 'deny' })).result).toEqual({ ok: true, applied: true });
  });
});
