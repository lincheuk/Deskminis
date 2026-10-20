/** F11B × F11A：已删除的会话（含保留副本）与附件同步（设计 §4.16 的 A1–A5）。
 *
 *  AT1：保留副本的附件不登记、不列进清单、不送出、不受理，行与文件原样留着；恢复之后重新参与。
 *  AT2：清除之后不重启也不再发清单，附件表的行随会话一起清，文件不删。
 *  AT3：协调器的排程规则——墓碑与被拒之后不排附件作业。
 *  AT4：接线的源码守卫。AT5：显式恢复后附件重新可取（两个真实引擎）。AT6：在途的取回在墓碑落地后停下。
 *
 *  A1 的落点以 F11A 的实际代码为准：存储层在查引用之前先问 sessionExists（装配处接 chat.getSession），
 *  而 getSession 看不到保留副本——所以不另加 sessionDeleted 这一项依赖。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { watchEngine } from './engine-wiring';
import { callMark } from './engine-trace';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { MinisPaths } from '../src/minisd/paths';
import { ChatStore } from '../src/minisd/store/chat-store';
import { SyncCoordinator, type AttachmentSyncPort } from '../src/minisd/sync/coordinator';
import { createAttachmentSync, type AttachmentSync } from '../src/minisd/sync/attachments';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import type { TombstoneHost } from '../src/minisd/sync/receive';
import type { WireLifecycle } from '../src/minisd/sync/wire';
import type { RpcServer } from '../src/minisd/rpc/server';
import type { OutboundClient } from '../src/minisd/sync/outbound-client';
import { stripComments } from './strip-comments';
import { incomingFiles, makeGate, makePng, sha256File, sha256Of, waitFor, type Gate } from './att-util';
import { bucketOf, itemOf, seedFile, statusOf } from './att-engines-util';
import {
  aliveIds, deleteSession, disposeAll, orderedDirs, pair, retained, rows, seedSession, settle, startNode, waitOnline,
} from './sync-delete-util';
import { expectSame } from './engine-trace';

const FP = 'aabbccddeeff';
const INBOUND = { authMode: 'remote', encrypted: true, peerFingerprint: FP, syncPeer: { protocolVersion: 2, caps: { attachments: true, tombstones: true } }, notify: () => { /* 不用 */ } } as never;
const LOCAL = { authMode: 'local', notify: () => { /* 不用 */ } } as never;
const CHUNK = 256 * 1024;

const dirs: string[] = [];
const dbs: Database.Database[] = [];
const syncs: AttachmentSync[] = [];
const coords: SyncCoordinator[] = [];
afterEach(async () => {
  for (const c of coords.splice(0)) c.stop();
  for (const s of syncs.splice(0)) s.port.stop();
  for (const d of dbs.splice(0)) { try { d.close(); } catch { /* 已关 */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
  await disposeAll();
  vi.restoreAllMocks();
});

interface Fx {
  sync: AttachmentSync; chat: ChatStore; db: Database.Database; root: string; sid: string; msgIds: string[];
  calls: Array<{ method: string; params: any }>;
  respond: { manifest: (p: any) => unknown; get?: (p: any) => unknown };
  gate: Gate;
  putFile(name: string, data: Buffer): string;
  attCalls(): string[];
  run(): Promise<void>;
  attRows(): Array<Record<string, any>>;
}

/** 真 ChatStore 加真附件同步，装配方式与 index.ts 相同：sessionExists 接 chat.getSession，
 *  onDirty 与生命周期事件都让附件侧失效。出站连接是脚本。会话 S 的消息各引用一个附件名。 */
function setup(refNames: string[]): Fx {
  const root = mkdtempSync(join(tmpdir(), 'f11b-att-'));
  dirs.push(root);
  const db = openDb(join(root, 'minis.db'));
  dbs.push(db);
  const chat = new ChatStore(db, 'me');
  const paths = new MinisPaths(root);
  const calls: Fx['calls'] = [];
  const respond: Fx['respond'] = { manifest: () => ({ v: 1, entries: [], want: [], rejected: [], indexing: false }) };
  const gate = makeGate();
  const outbound = {
    isOnline: () => true, dialedPeers: () => [FP],
    peerInfo: () => ({ protocolVersion: 2, caps: { attachments: true, tombstones: true } }),
    callRpc: async (_fp: string, method: string, params: unknown) => {
      calls.push({ method, params });
      await gate.wait();
      const script = method === 'sync.att.manifest' ? respond.manifest : method === 'sync.att.get' ? respond.get : undefined;
      if (!script) throw new Error(`脚本没有准备 ${method} 的应答`);
      return script(params);
    },
  };
  const sync = createAttachmentSync({
    db, root, paths, isPaired: () => true, pairedPeers: () => [FP],
    sessionExists: sid => chat.getSession(sid) !== undefined, sessionCursor: sid => chat.getSessionCursor(sid),
    outbound: () => outbound, isInboundOnline: () => false, broadcast: () => { /* 不看 */ },
  });
  syncs.push(sync);
  chat.onDirty = sid => { sync.port.markDirty(sid); };
  chat.onLifecycle = e => { if (e.kind !== 'stale-content-rejected') sync.port.markDirty(e.sessionId); };
  sync.port.onPeerOnline(FP);

  const s = chat.createSession('S');
  const msgIds = refNames.map((name, i) => {
    const id = chat.newId();
    chat.appendMessage({
      id, sessionId: s.id, role: 'user', createdAt: chat.nowEpoch(), streamInterruptCount: 0,
      parts: [{ type: 'text', value: '看附件' }, { type: 'mediaRef', value: { id: `ref-${i}`, relativePath: `attachments/${name}`, mimeType: 'image/png' } }],
    });
    return id;
  });
  return {
    sync, chat, db, root, sid: s.id, msgIds, calls, respond, gate,
    putFile(name, data) { const dir = paths.sessionBucket(s.id, 'attachments'); mkdirSync(dir, { recursive: true }); const p = join(dir, name); writeFileSync(p, data); return p; },
    attCalls: () => calls.filter(c => c.method.startsWith('sync.att.')).map(c => c.method),
    async run() { sync.port.schedule(FP, s.id); await sync.idle(); },
    attRows: () => db.prepare('SELECT * FROM sync_attachments WHERE session_id=? ORDER BY name').all(s.id) as Array<Record<string, any>>,
  };
}

const tomb = (opId: string, ids: string[]): WireLifecycle => ({ v: 1, opId, originDeviceId: FP, at: 1, seen: makeSeen(ids) });

describe('AT1 保留副本的附件不送出也不被受理（A1）', () => {
  it('引用为空、不发清单、清单回 session_unknown、get / put / retry / cancel 都被拒；行与文件原样；恢复后重新参与', async () => {
    const f = setup(['x.png', 'y.png']);
    const x = makePng(3000, 1).buf;
    const y = makePng(4000, 2).buf;
    const xPath = f.putFile('x.png', x);
    await f.run();                                          // x.png 登记为 present，清单发过一次
    // 对端说它有 y.png：本机建一行「要取」
    const offered = await f.sync.peerMethods['sync.att.manifest']!({ v: 1, sessionId: f.sid, entries: [{ name: 'y.png', size: y.length, sha256: sha256Of(y), mimeType: 'image/png' }] }, INBOUND) as any;
    expect(offered.want.map((w: any) => w.name)).toEqual(['y.png']);
    expect(f.attRows().map(r => [r.name, r.state])).toEqual([['x.png', 'present'], ['y.png', 'missing']]);
    expect(f.sync.store.referenced(f.sid).size).toBe(2);

    // 对端删除了这个会话，但没见过本机的消息 → 保留副本（消息行、附件行都还在）
    expect(f.chat.applyTombstone(f.sid, tomb('OP1', []), { fromPeer: FP })).toMatchObject({ status: 'applied', retained: true });
    const rowsBefore = f.attRows();
    expect(rowsBefore).toHaveLength(2);

    expect(f.sync.store.referenced(f.sid).size).toBe(0);
    expect(f.sync.store.invalidRefs(f.sid)).toEqual([]);
    const mark = f.calls.length;
    await f.run();
    expect(f.calls.slice(mark)).toEqual([]);
    const z = makePng(2000, 3).buf;
    const refused = await f.sync.peerMethods['sync.att.manifest']!({ v: 1, sessionId: f.sid, entries: [{ name: 'z.png', size: z.length, sha256: sha256Of(z), mimeType: 'image/png' }, { name: 'y.png', size: y.length, sha256: sha256Of(y), mimeType: 'image/png' }] }, INBOUND) as any;
    expect(refused.rejected).toEqual([{ index: 0, code: 'session_unknown' }, { index: 1, code: 'session_unknown' }]);
    expect(refused.want).toEqual([]);
    expect(refused.entries).toEqual([]);
    await expect(f.sync.peerMethods['sync.att.get']!({ v: 1, sessionId: f.sid, name: 'x.png', sha256: sha256Of(x), offset: 0 }, INBOUND)).rejects.toThrow('ATT_NOT_FOUND');
    await expect(f.sync.peerMethods['sync.att.put']!({ v: 1, sessionId: f.sid, name: 'y.png', sha256: sha256Of(y), offset: 0, data: y.toString('base64') }, INBOUND)).rejects.toThrow('ATT_CANCELLED');
    await expect(Promise.resolve().then(() => f.sync.localMethods['attachments.retry']!({ sessionId: f.sid, name: 'y.png' }, LOCAL))).rejects.toThrow(/会话已删除/);
    await expect(Promise.resolve().then(() => f.sync.localMethods['attachments.cancel']!({ sessionId: f.sid, name: 'y.png' }, LOCAL))).rejects.toThrow(/会话已删除/);
    expect((await f.sync.localMethods['attachments.status']!({ sessionId: f.sid }, LOCAL) as any).items).toEqual([]);
    await f.sync.idle();
    // 保留副本是冻结的：附件行与桶里的文件原样在
    expect(f.attRows()).toEqual(rowsBefore);
    expect(sha256File(xPath)).toBe(sha256Of(x));
    expect(incomingFiles(f.root)).toEqual([]);

    // 显式恢复：引用回来，清单重新发出（不沿用删除前的「已收敛」记号）
    f.chat.restoreSession(f.sid);
    expect(f.sync.store.referenced(f.sid).size).toBe(2);
    const mark2 = f.calls.length;
    await f.run();
    expect(f.calls.slice(mark2).map(c => c.method)).toContain('sync.att.manifest');
    expect(f.attRows().map(r => [r.name, r.state])).toEqual([['x.png', 'present'], ['y.png', 'missing']]);
  });
});

describe('AT2 清除之后不重启也不再发清单；附件表的行随会话清，文件不删（A1、A5）', () => {
  const cases: Array<[string, (f: Fx) => void]> = [
    ['本机 deleteSession', f => { expect(f.chat.deleteSession(f.sid).kind).toBe('deleted'); }],
    ['对端墓碑覆盖全部消息（清除）', f => { expect(f.chat.applyTombstone(f.sid, tomb('OP1', f.msgIds))).toMatchObject({ status: 'applied', retained: false }); }],
    ['保留副本被彻底删除（purged）', f => {
      expect(f.chat.applyTombstone(f.sid, tomb('OP1', []))).toMatchObject({ retained: true });
      expect(f.attRows()).toHaveLength(1);
      expect(f.chat.deleteSession(f.sid).kind).toBe('purged');
    }],
    ['保留副本被一条覆盖它的同代墓碑释放（retained-released）', f => {
      expect(f.chat.applyTombstone(f.sid, tomb('AAAA', []))).toMatchObject({ retained: true });
      expect(f.attRows()).toHaveLength(1);
      expect(f.chat.applyTombstone(f.sid, tomb('BBBB', f.msgIds))).toEqual({ status: 'stale', released: true });
    }],
  ];
  for (const [name, act] of cases) {
    it(name, async () => {
      const f = setup(['x.png']);
      const x = makePng(3000, 5).buf;
      const xPath = f.putFile('x.png', x);
      await f.run();                                        // 已登记、引用缓存已建、清单发过
      expect(f.attRows().map(r => r.state)).toEqual(['present']);
      expect(f.sync.store.referenced(f.sid).size).toBe(1);

      act(f);
      expect(f.attRows(), '附件表的行随会话一起清').toEqual([]);
      expect(f.sync.store.referenced(f.sid).size).toBe(0);
      const mark = f.calls.length;
      await f.run();
      expect(f.calls.slice(mark)).toEqual([]);
      // 本任务不删任何文件
      expect(existsSync(xPath)).toBe(true);
      expect(sha256File(xPath)).toBe(sha256Of(x));
    });
  }
});

describe('AT3 协调器的排程规则：墓碑与被拒之后不排附件作业（A4）', () => {
  interface Rig { chat: ChatStore; coord: SyncCoordinator; log: string[]; calls: Array<{ method: string; params: any }>; ob: any; setHandler(h: (m: string, p: any) => unknown): void; idle(): Promise<void>; scheduled(sid?: string): string[] }
  function rig(host?: TombstoneHost): Rig {
    const db = openDb(':memory:');
    dbs.push(db);
    const chat = new ChatStore(db, 'me');
    const log: string[] = [];
    const calls: Rig['calls'] = [];
    let handler: (m: string, p: any) => unknown = m => (m === 'sync.list' ? { sessions: [], tombstones: [] } : {});
    const ob: any = {
      dialedPeers: () => [FP], peerInfo: () => ({ protocolVersion: 2, caps: { tombstones: true, attachments: true } }),
      callRpc: async (_fp: string, method: string, params: unknown) => { calls.push({ method, params }); return handler(method, params); },
      start() { /* 不真拨号 */ }, stop() { /* 无 */ }, onRemoteDirty: undefined, onOnline: undefined,
    };
    const port: AttachmentSyncPort = {
      markDirty: sid => { log.push(`markDirty:${sid}`); }, onPeerOnline: () => { /* 不看 */ }, onRemoteDirty: () => { /* 不看 */ },
      schedule: (_fp, sid) => { log.push(`schedule:${sid}`); }, setPaused: () => { /* 不看 */ }, stop: () => { /* 不看 */ },
    };
    const coord = new SyncCoordinator(chat, { broadcast: () => { /* 不看 */ } } as unknown as RpcServer,
      { debounceMs: 10, outbound: ob as OutboundClient, attachments: port, ...(host ? { lifecycleHost: host } : {}) });
    coords.push(coord);
    chat.onDirty = sid => coord.onDirty(sid);
    coord.start();
    const idle = async (): Promise<void> => {
      let last = -1; let since = Date.now();
      await waitFor('协调器安静下来', () => {
        const n = calls.length + log.length;
        if (n !== last) { last = n; since = Date.now(); return false; }
        return Date.now() - since >= 120;
      }, 5000, 10);
    };
    return { chat, coord, log, calls, ob, setHandler: h => { handler = h; }, idle, scheduled: sid => log.filter(l => l.startsWith('schedule:') && (sid === undefined || l === `schedule:${sid}`)) };
  }
  function seeded(r: Rig): { sid: string; ids: string[] } {
    const s = r.chat.createSession('S');
    const ids = [0, 1].map(() => { const id = r.chat.newId(); r.chat.appendMessage({ id, sessionId: s.id, role: 'user', parts: [{ type: 'text', value: 'x' }], createdAt: r.chat.nowEpoch(), streamInterruptCount: 0 }); return id; });
    return { sid: s.id, ids };
  }
  const reset = async (r: Rig): Promise<void> => { await r.idle(); r.log.length = 0; r.calls.length = 0; };

  it('正常推完、正常拉完：各排一次', async () => {
    const r = rig();
    const s = seeded(r);
    await r.idle();
    expect(r.scheduled(s.sid)).toEqual([`schedule:${s.sid}`]);      // 推完之后
    r.log.length = 0;
    r.setHandler((m, p) => (m === 'sync.pull' ? { messages: [], markers: [], sessionId: p.sessionId } : {}));
    r.ob.onRemoteDirty(FP, s.sid);
    await r.idle();
    expect(r.scheduled(s.sid)).toEqual([`schedule:${s.sid}`]);      // 拉完之后（合并没有变化也排）
  });

  it('推墓碑：不排', async () => {
    const r = rig();
    const s = seeded(r);
    await reset(r);
    r.chat.deleteSession(s.sid);
    await r.idle();
    expect(r.calls.filter(c => c.method === 'sync.push' && c.params.payload.lifecycle)).toHaveLength(1);
    expect(r.scheduled()).toEqual([]);
  });

  it('推内容第一批得到 rejected：不排；之后两轮对账对端一直拒，始终不排', async () => {
    const r = rig();
    const s = seeded(r);
    await reset(r);
    // 对端已删这个会话但（比如暂停中）不交出墓碑：只回 rejected
    r.setHandler(m => (m === 'sync.list' ? { sessions: [], lifecyclePaused: true } : { mergedCount: 0, orphanMarkerIds: [], hasChange: false, rejected: 'tombstoned' }));
    for (let round = 0; round < 3; round++) {
      r.ob.onOnline(FP);
      await r.idle();
    }
    expect(r.calls.filter(c => c.method === 'sync.push' && c.params.sessionId === s.sid).length).toBe(3);
    expect(r.scheduled()).toEqual([]);
    // session-required 同样不排
    r.setHandler(m => (m === 'sync.list' ? { sessions: [], tombstones: [] } : { mergedCount: 0, orphanMarkerIds: [], hasChange: false, rejected: 'session-required' }));
    r.ob.onOnline(FP);
    await r.idle();
    expect(r.scheduled()).toEqual([]);
  });

  for (const outcome of ['applied', 'deferred'] as const) {
    it(`拉到的是墓碑载荷（宿主返回 ${outcome}）：不排`, async () => {
      const host: TombstoneHost | undefined = outcome === 'deferred'
        ? { applyRemoteTombstone: async () => ({ status: 'deferred', reason: 'run-stopping' }) } : undefined;
      const r = rig(host);
      const s = seeded(r);
      await reset(r);
      r.setHandler((m) => (m === 'sync.pull' ? { messages: [], markers: [], lifecycle: tomb('OP-PEER', s.ids) } : { tombstone: 'duplicate' }));
      r.ob.onRemoteDirty(FP, s.sid);
      await r.idle();
      expect(r.calls.filter(c => c.method === 'sync.pull')).toHaveLength(1);
      expect(r.chat.isDeleted(s.sid)).toBe(outcome === 'applied');
      expect(r.scheduled()).toEqual([]);
    });
  }

  it('拉到的内容被拒（本机已删、对端拿着旧副本）：不排', async () => {
    const r = rig();
    const s = seeded(r);
    const stale = r.chat.buildPushBatches(s.sid)[0];
    await reset(r);
    r.chat.deleteSession(s.sid);
    await reset(r);
    r.setHandler(m => (m === 'sync.pull' ? stale : { tombstone: 'applied' }));
    r.ob.onRemoteDirty(FP, s.sid);
    await r.idle();
    expect(r.calls.filter(c => c.method === 'sync.pull')).toHaveLength(1);
    expect(r.chat.listMessages(s.sid)).toEqual([]);
    // 被拒之后把墓碑给对方，但不排附件作业
    expect(r.calls.filter(c => c.method === 'sync.push' && c.params.payload.lifecycle)).toHaveLength(1);
    expect(r.scheduled()).toEqual([]);
  });
});

describe('AT4 接线的源码守卫（A1、A2、A3）', () => {
  const engine = stripComments(readFileSync(join(__dirname, '../src/minisd/sync/attachments/engine.ts'), 'utf8'));
  const store = stripComments(readFileSync(join(__dirname, '../src/minisd/sync/attachments/store.ts'), 'utf8'));

  it('装配处的 sessionExists 接 chat.getSession，而 getSession 看不到保留副本', async () => {
    // 先装观察，再起临时数据根上的真实引擎并取实际回调。
    const w = watchEngine();
    const n = await startNode('Q20-AT4', orderedDirs(1)[0]);
    const exists = w.args('createAttachmentSync')[0].sessionExists as (sid: string) => boolean;
    const a = await seedSession(n, 'retained', 1), b = await seedSession(n, 'control', 1);
    const actualChat = w.args('createSyncMethods')[0] as ChatStore;

    // 每次回调恰好问引擎那份 ChatStore 的 getSession，保留副本和从未存在的 id 都不可见。
    const checkExists = (sid: string, expected: boolean): void => {
      const getSession = w.spy('chat.getSession');
      const from = callMark();
      expect(exists(sid)).toBe(expected);
      expect(w.count('chat.getSession', from)).toBe(1);
      expect(getSession.mock.calls.at(-1)).toEqual([sid]);
      expectSame(getSession.mock.contexts.at(-1), actualChat);
      expect(getSession.mock.results.at(-1)?.value !== undefined).toBe(expected);
    };
    expect(w.count('createAttachmentSync')).toBe(1);
    checkExists(a.sid, true);
    checkExists(b.sid, true);
    checkExists('Q20-AT4-NEVER-EXISTED', false);

    // 保留副本仍在数据库里，附件回调按可见性拒绝；恢复后同一回调又能看见它。
    expect(actualChat.applyTombstone(a.sid, tomb('Q20-AT4', []), { fromPeer: FP })).toMatchObject({ retained: true });
    expect(rows(n.dir, 'SELECT COUNT(*) n FROM sessions WHERE id=?', a.sid)[0].n).toBe(1);
    checkExists(a.sid, false);
    checkExists(b.sid, true);
    actualChat.restoreSession(a.sid);
    checkExists(a.sid, true);

    // SQL 移到预编译字段后检查实际结果，保留副本仍有行，不能靠物理删除使检查通过。
    const db = openDb(':memory:');
    dbs.push(db);
    const chat = new ChatStore(db, 'local', { now: () => 1000000 });
    const session = chat.createSession('retained'), control = chat.createSession('control');
    chat.appendMessage({ id: 'AT4-local', sessionId: session.id, role: 'user', parts: [{ type: 'text', value: 'unseen' }], createdAt: 123, streamInterruptCount: 0 });
    expect(chat.getSession(session.id)).toMatchObject(session);
    expect(chat.listSessions().map(s => s.id).sort()).toEqual([session.id, control.id].sort());
    expect(chat.applyTombstone(session.id, tomb('AT4-OP', []), { fromPeer: FP })).toMatchObject({ status: 'applied', retained: true });
    expect((db.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').get(session.id) as {
      n: number;
    }).n).toBe(1);
    expect(chat.listMessages(session.id).map(m => m.id)).toEqual(['AT4-local']);
    expect(chat.getSession(session.id)).toBeUndefined();
    expect(chat.listSessions().map(s => s.id)).toEqual([control.id]);
    expect(chat.getSession(control.id)).toMatchObject(control);
    chat.restoreSession(session.id);
    expect(chat.getSession(session.id)).toMatchObject(session);
    expect(chat.listSessions().map(s => s.id).sort()).toEqual([session.id, control.id].sort());
  }, 30000);

  it('存储层的闸在缓存之前；「行还要取」看引用；retry / cancel 拒绝已删会话', () => {
    const loadRefs = store.slice(store.indexOf('private loadRefs('), store.indexOf('referenced(sessionId'));
    expect(loadRefs.indexOf('this.sessionAlive(sessionId)')).toBeGreaterThan(0);
    expect(loadRefs.indexOf('this.sessionAlive(sessionId)')).toBeLessThan(loadRefs.indexOf('this.refCache.get('));
    const stillWanted = engine.slice(engine.indexOf('private stillWanted('), engine.indexOf('private async fetchOne('));
    expect(stillWanted).toContain('this.store.wantedRow(');
    for (const fn of ['async retry(sessionId', 'cancel(sessionId']) {
      const at = engine.indexOf(fn);
      expect(at, fn).toBeGreaterThan(0);
      expect(engine.slice(at, at + 200)).toContain('this.assertSessionLive(sessionId)');
    }
  });

  it('生命周期钩子第一句让附件侧失效，排在任何审计之前，且不含「旧副本被拒」', async () => {
    // 直接调真实生命周期钩子，审计抛错时附件侧已经失效。
    const w = watchEngine();
    const n = await startNode('Q20-HOOK', orderedDirs(1)[0]);
    const s = await seedSession(n, 'hook', 1);
    w.spy('audit.append').mockImplementationOnce(() => {
      throw new Error('Q20 audit failure');
    });
    const from = callMark();
    const lifecycleChat = w.args('createSyncMethods')[0] as ChatStore;
    lifecycleChat.onLifecycle!({ kind: 'deleted', sessionId: s.sid, lifecycle: tomb('Q20-HOOK', []), messageCount: 1 });
    expect(w.seq(['attachments.markDirty', 'audit.append'], from)).toEqual(['attachments.markDirty', 'audit.append']);
    expect(w.spy('attachments.markDirty').mock.calls.at(-1)).toEqual([s.sid]);

    // 旧副本被拒只写审计，不使附件侧失效。
    const stale = callMark();
    lifecycleChat.onLifecycle!({ kind: 'stale-content-rejected', sessionId: s.sid, lifecycle: tomb('Q20-STALE', []) });
    expect(w.count('attachments.markDirty', stale)).toBe(0);
    expect(w.count('audit.append', stale)).toBe(1);

    const { allLifecycleEvents } = await import('./engine-trace');
    const attachmentPort = w.made('createAttachmentSync').port;
    for (const event of allLifecycleEvents(s.sid, tomb('Q20-ALL-KINDS', []))) {
      const mark = callMark();
      lifecycleChat.onLifecycle!(event);
      const expected = event.kind === 'stale-content-rejected' ? 0 : 1;
      expect(w.count('attachments.markDirty', mark), event.kind).toBe(expected);
      if (expected === 1) {
        expect(w.args('attachments.markDirty'), event.kind).toEqual([s.sid]);
        expectSame(w.spy('attachments.markDirty').mock.contexts.at(-1), attachmentPort, event.kind);
      }
    }
  }, 30000);
});

describe('AT6 在途的取回在墓碑落地后停下（A2）', () => {
  for (const kind of ['覆盖全部消息（清除）', '不覆盖（保留副本）'] as const) {
    it(`第二块的应答在途时对端删除，${kind}：没有第三次 get，文件不发布，行不变成 present`, async () => {
      const f = setup(['a.png']);                              // 引用 a.png，本机没有文件
      const data = makePng(600_000, 41).buf;                   // 三块
      const sha = sha256Of(data);
      f.respond.manifest = () => ({ v: 1, entries: [{ name: 'a.png', size: data.length, sha256: sha, mimeType: 'image/png' }], want: [], rejected: [], indexing: false });
      // 第 0 块照答，答完关闸：第二块的 get 停在闸门上（应答在途）
      f.respond.get = (p: any) => { if (p.offset === 0) f.gate.close(); return { v: 1, offset: p.offset, size: data.length, data: data.subarray(p.offset, p.offset + CHUNK).toString('base64') }; };
      const getOffsets = (): number[] => f.calls.filter(c => c.method === 'sync.att.get').map(c => c.params.offset);
      f.sync.port.schedule(FP, f.sid);
      await f.gate.entered();
      expect(getOffsets()).toEqual([0, CHUNK]);

      const t = tomb('OP1', kind.startsWith('覆盖') ? f.msgIds : []);
      const r = f.chat.applyTombstone(f.sid, t, { fromPeer: FP });
      expect(r).toMatchObject({ status: 'applied', retained: !kind.startsWith('覆盖') });
      f.gate.release();
      await f.sync.idle();

      expect(getOffsets(), '墓碑落地之后不该再要下一块').toEqual([0, CHUNK]);
      expect(existsSync(join(f.root, 'sessions', f.sid, 'attachments', 'a.png'))).toBe(false);
      const left = f.attRows();
      if (kind.startsWith('覆盖')) expect(left).toEqual([]);
      else expect(left.map(x => [x.name, x.state])).toEqual([['a.png', 'missing']]);
      expect(incomingFiles(f.root), '被丢下的暂存不该留着').toEqual([]);
    });
  }
});

describe('AT5 显式恢复后附件重新可取（两个真实引擎）', () => {
  it('B 离线追加带新附件的消息，A 删除，B 保留并恢复：A 上会话回来，两个附件都是 ready，新附件内容与 B 相同', async () => {
    const [dLo, dHi] = orderedDirs(2);
    const A = await startNode('A', dLo);
    const B = await startNode('B', dHi);
    await pair(A, B);
    const x = makePng(5000, 51).buf;
    const y = makePng(7000, 52).buf;
    const S = await seedSession(A, 'S', 1);
    await seedFile(A.local, A.dir, S.sid, 'x.png', x, 'image/png');
    await settle([A, B]);
    await waitFor('x.png 到 B', async () => (await itemOf(B.local, S.sid, 'x.png'))?.state === 'ready', 30_000, 50);

    await A.stop();
    await seedFile(B.local, B.dir, S.sid, 'y.png', y, 'image/png');
    await B.stop();
    await A.restart();
    await deleteSession(A, S.sid);
    // 清库时附件表的行一并清；文件留在盘上（本任务不删文件）
    expect(rows(A.dir, 'SELECT COUNT(*) AS c FROM sync_attachments WHERE session_id=?', S.sid)[0].c).toBe(0);
    expect(existsSync(join(bucketOf(A.dir, S.sid), 'x.png'))).toBe(true);
    await B.restart();
    await waitOnline(A, B);
    await waitFor('B 上会话进入保留列表', async () => (await retained(B)).some(r => r.id === S.sid), 40_000, 50);
    await settle([A, B]);
    // 保留期间 A 没有拿到 y.png，B 的状态面是空的（不参与同步）
    expect(existsSync(join(bucketOf(A.dir, S.sid), 'y.png'))).toBe(false);
    expect(rows(A.dir, 'SELECT COUNT(*) AS c FROM sync_attachments WHERE session_id=?', S.sid)[0].c).toBe(0);
    expect((await statusOf(B.local, S.sid)).items).toEqual([]);
    // B 的附件行与文件原样留着（y.png 是离线时放进去的，还没登记过；恢复之后才会登记并送出）
    expect(rows(B.dir, 'SELECT name FROM sync_attachments WHERE session_id=? ORDER BY name', S.sid).map(r => r.name)).toEqual(['x.png']);
    expect(existsSync(join(bucketOf(B.dir, S.sid), 'y.png'))).toBe(true);

    expect(await B.call('chat.sessions.restore', { sessionId: S.sid, confirm: true })).toEqual({ ok: true });
    await waitFor('A 上会话回来', async () => (await aliveIds(A)).includes(S.sid), 30_000, 50);
    await waitFor('A 上两个附件都 ready', async () => {
      const st = await statusOf(A.local, S.sid);
      return st.items.length === 2 && st.items.every(i => i.state === 'ready');
    }, 40_000, 100);
    expect(sha256File(join(bucketOf(A.dir, S.sid), 'y.png'))).toBe(sha256Of(y));
    expect(sha256File(join(bucketOf(A.dir, S.sid), 'x.png'))).toBe(sha256Of(x));
    expect((await statusOf(B.local, S.sid)).items.map(i => [i.name, i.state]).sort()).toEqual([['x.png', 'ready'], ['y.png', 'ready']]);
  }, 150_000);
});
