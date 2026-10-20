/**
 * F11A · 拨号方的调度与收敛记号（设计 §4.6）。真实的库与存储层，出站连接是脚本化的假对象（记录每次 RPC）。
 *
 * 收敛记号只是省掉重复的清单往返；记错的代价是「对端那边变了，这边再也不发清单」。钉住：
 *   - 对端的拒绝里有之后会变的状态（held / failed / busy / not_referenced / session_unknown）→ 不记收敛；
 *   - 只有重发也不会变的拒绝 → 记收敛，下一次 schedule 不发；
 *   - 已收敛后对端发来 sync.dirty（onRemoteDirty）→ 下一次 schedule 发；
 *   - 清单在途时被催过、或本机行变了 → 这一轮不算收敛；
 *   - 对端没声明能力位 → 一个 sync.att.* 都不发；声明了却不受理 → 本连接周期内不再发；
 *   - 配对没了而连接还在（真连接上走不到的那一格）→ 不发清单、在途的应答不写盘、不再送下一块；换连接周期后旧应答不写盘。
 *
 * 状态模型里靠「有没有行」「交换发生在引用出现之前还是之后」区分的几格也放在这里（同一套夹具，经本机方法 attachments.* 取）：
 *   - 还没有行的引用不给取消（取消记不下任何东西，清单一到照样下载）；
 *   - 交换过清单的会话里新到的引用，在下一份清单之前是「等待同步」，不是「在线的设备上没有这个文件」；
 *   - 名字过不了同步规则、但文件就在本机附件桶里的引用，照实报「本机有」。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { MinisPaths } from '../src/minisd/paths';
import { createAttachmentSync, type AttachmentSync } from '../src/minisd/sync/attachments';
import { ATTACHMENT_STATE_TEXT, type AttachmentStatusResult, type AttachmentView } from '../src/shared/attachments';
import { chipOf } from '../src/renderer/src/lib/attach/status';
import { createAttachmentIo } from '../src/minisd/sync/attachments/io';
import { incomingFiles, makeGate, makePng, sha256File, sha256Of, type Gate } from './att-util';

const SID = '11111111-2222-4333-8444-555555555555';
const FP = 'peer-fp-engine';

const realIo = createAttachmentIo();
/** 加密通道上的已配对入站连接（声明了 attachments）：直接调对端处理器时用。 */
const INBOUND_CONN = { authMode: 'remote', encrypted: true, peerFingerprint: FP, syncPeer: { protocolVersion: 2, caps: { attachments: true } }, notify: () => { /* 不用 */ } } as never;

const dirs: string[] = [];
const dbs: Database.Database[] = [];
const syncs: AttachmentSync[] = [];
afterEach(() => {
  for (const s of syncs.splice(0)) s.port.stop();
  for (const d of dbs.splice(0)) { try { d.close(); } catch { /* 已关 */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
});

interface Fx {
  sync: AttachmentSync; root: string; calls: Array<{ method: string; params: any }>;
  caps: Record<string, boolean>; respond: { manifest: (params: any) => unknown; get?: (params: any) => unknown; put?: (params: any) => unknown };
  gate: Gate; broadcasts: Array<{ method: string; params: any }>;
  /** 配对表里还有没有这台设备。脚本化的出站连接不会跟着断（真实的 remote.unpair 会同时断连）：
   *  这样才看得出引擎自己的复查——配对没了、连接还在、应答照常回来的那一刻它做什么。 */
  paired: { value: boolean };
  putFile(name: string, data: Buffer): void;
  manifests(): any[];
  run(): Promise<void>;
  /** 追加一条带 mediaRef 的用户消息，并像协调器的 onDirty 那样让附件侧的缓存失效。relativePath 原样写进消息。 */
  addRef(relativePath: string): void;
  /** 经本机连接调 attachments.*。 */
  local(method: string, params: unknown): Promise<any>;
  /** attachments.status 里 relativePath 对应的那一项。 */
  item(relativePath: string): Promise<AttachmentView | undefined>;
}

/** inbound：对端是拨进来的（本端作监听方），出站不在线。hashGate：本机登记算哈希之前先过这道闸门。 */
function setup(refNames: string[] = ['a.png'], opts: { inbound?: boolean; hashGate?: Gate } = {}): Fx {
  const root = mkdtempSync(join(tmpdir(), 'f11a-engine-'));
  dirs.push(root);
  const db = openDb(join(root, 'minis.db'));
  dbs.push(db);
  db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)').run(SID, 't');
  const parts = JSON.stringify(refNames.map((n, i) => ({ type: 'mediaRef', value: { id: `m${i}`, relativePath: `attachments/${n}`, mimeType: 'image/png' } })));
  db.prepare('INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, 1, 1, 1)').run('msg-1', SID, 'user', parts);
  const paths = new MinisPaths(root);
  const calls: Fx['calls'] = [];
  const caps: Record<string, boolean> = { attachments: true };
  const respond: Fx['respond'] = { manifest: () => ({ v: 1, entries: [], want: [], rejected: [], indexing: false }) };
  const gate = makeGate();
  const broadcasts: Fx['broadcasts'] = [];
  const outbound = {
    isOnline: () => opts.inbound !== true,
    dialedPeers: () => [FP],
    peerInfo: () => ({ protocolVersion: 2, caps }),
    callRpc: async (_fp: string, method: string, params: unknown) => {
      calls.push({ method, params });
      await gate.wait();
      const script = method === 'sync.att.manifest' ? respond.manifest : method === 'sync.att.get' ? respond.get : method === 'sync.att.put' ? respond.put : undefined;
      if (!script) throw new Error(`脚本没有准备 ${method} 的应答`);
      const r = script(params);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const paired = { value: true };
  const sync = createAttachmentSync({
    db, root, paths, isPaired: () => paired.value, pairedPeers: () => [FP],
    sessionExists: sid => sid === SID, sessionCursor: () => ({}),
    outbound: () => outbound, isInboundOnline: () => opts.inbound === true,
    broadcast: (method, params) => { broadcasts.push({ method, params }); },
    io: opts.hashGate ? { hash: async p => { await opts.hashGate!.wait(); return realIo.hash(p); } } : undefined,
  });
  syncs.push(sync);
  sync.port.onPeerOnline(FP);
  let seq = 1;
  const local = async (method: string, params: unknown): Promise<any> => sync.localMethods[method](params, { authMode: 'local', notify: () => { /* 不用 */ } } as never);
  return {
    sync, root, calls, caps, respond, gate, broadcasts, paired,
    putFile(name, data) { const dir = paths.sessionBucket(SID, 'attachments'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), data); },
    manifests: () => calls.filter(c => c.method === 'sync.att.manifest').map(c => c.params),
    async run() { sync.port.schedule(FP, SID); await sync.idle(); },
    addRef(relativePath) {
      seq++;
      const parts = JSON.stringify([{ type: 'mediaRef', value: { id: `late-${seq}`, relativePath, mimeType: 'image/png' } }]);
      db.prepare('INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`msg-${seq}`, SID, 'user', parts, seq, seq, seq);
      sync.port.markDirty(SID);
    },
    local,
    async item(relativePath) {
      const st: AttachmentStatusResult = await local('attachments.status', { sessionId: SID });
      return st.items.find(i => i.relativePath === relativePath);
    },
  };
}

const reject = (code: string) => ({ v: 1, entries: [], want: [], rejected: [{ index: 0, code }], indexing: false });

describe('F11A 引擎：收敛记号', () => {
  it('清单带上本机 present 的条目（名字 + 内容身份，没有路径）；干净的应答记收敛，下一次 schedule 不再发', async () => {
    const f = setup();
    const data = makePng(3000, 1).buf;
    f.putFile('a.png', data);
    await f.run();
    expect(f.manifests()).toEqual([{ v: 1, sessionId: SID, entries: [{ name: 'a.png', size: 3000, sha256: sha256Of(data), mimeType: 'image/png' }] }]);
    expect(JSON.stringify(f.calls)).not.toContain(f.root);
    await f.run();
    expect(f.manifests()).toHaveLength(1);
  });

  it('拒绝里有之后会变的状态：不记收敛，下一次 schedule 仍发清单', async () => {
    for (const code of ['held', 'failed', 'busy', 'not_referenced', 'session_unknown']) {
      const f = setup();
      f.putFile('a.png', makePng(3000, 2).buf);
      f.respond.manifest = () => reject(code);
      await f.run();
      await f.run();
      expect(f.manifests().length, code).toBe(2);
    }
  });

  it('只有重发也不会变的拒绝：记收敛，下一次 schedule 不发', async () => {
    for (const code of ['too_large', 'quota', 'name_conflict', 'bad_name', 'bad_entry']) {
      const f = setup();
      f.putFile('a.png', makePng(3000, 3).buf);
      f.respond.manifest = () => reject(code);
      await f.run();
      await f.run();
      expect(f.manifests().length, code).toBe(1);
    }
  });

  it('已收敛后对端发来 sync.dirty（onRemoteDirty）或本机消息变了（markDirty）：下一次 schedule 发', async () => {
    const f = setup();
    f.putFile('a.png', makePng(3000, 4).buf);
    await f.run();
    await f.run();
    expect(f.manifests()).toHaveLength(1);
    f.sync.port.onRemoteDirty(FP, SID);
    await f.run();
    expect(f.manifests()).toHaveLength(2);
    await f.run();
    expect(f.manifests()).toHaveLength(2);
    f.sync.port.markDirty(SID);
    await f.run();
    expect(f.manifests()).toHaveLength(3);
  });

  it('清单在途时被催过：这一轮不记收敛', async () => {
    for (const poke of ['onRemoteDirty', 'markDirty'] as const) {
      const f = setup();
      f.putFile('a.png', makePng(3000, 5).buf);
      f.gate.close();
      f.sync.port.schedule(FP, SID);
      await f.gate.entered();
      if (poke === 'onRemoteDirty') f.sync.port.onRemoteDirty(FP, SID); else f.sync.port.markDirty(SID);
      f.gate.release();
      await f.sync.idle();
      await f.run();
      expect(f.manifests().length, poke).toBe(2);
    }
  });

  it('清单在途时本机多出一个 present 行：记下的是发清单之前的 stamp，下一次 schedule 仍发（并带上新条目）', async () => {
    const f = setup(['a.png', 'b.png']);
    f.putFile('a.png', makePng(3000, 6).buf);
    f.gate.close();
    f.sync.port.schedule(FP, SID);
    await f.gate.entered();
    f.putFile('b.png', makePng(3100, 7).buf);
    await f.sync.store.ensureIndexed(SID, { force: true });
    f.gate.release();
    await f.sync.idle();
    await f.run();
    const sent = f.manifests();
    expect(sent).toHaveLength(2);
    expect(sent[0].entries.map((e: any) => e.name)).toEqual(['a.png']);
    expect(sent[1].entries.map((e: any) => e.name)).toEqual(['a.png', 'b.png']);
    await f.run();
    expect(f.manifests()).toHaveLength(2);
  });

  it('新的连接周期（onPeerOnline）：收敛记号清空，重新发清单', async () => {
    const f = setup();
    f.putFile('a.png', makePng(3000, 8).buf);
    await f.run();
    f.sync.port.onPeerOnline(FP);
    await f.run();
    expect(f.manifests()).toHaveLength(2);
  });

  it('清单在途时换了连接周期（onPeerOnline）：旧作业拿到应答后不再借新连接送块；新周期的作业自己重新发清单', async () => {
    const f = setup();
    const data = makePng(3000, 9).buf;
    f.putFile('a.png', data);
    // 对端要这份内容：旧作业若不看连接周期，应答回来之后会接着发 sync.att.put
    f.respond.manifest = () => ({ v: 1, entries: [], want: [{ name: 'a.png', sha256: sha256Of(data), offset: 0 }], rejected: [], indexing: false });
    f.gate.close();
    f.sync.port.schedule(FP, SID);
    await f.gate.entered();
    f.sync.port.onPeerOnline(FP);
    f.respond.manifest = () => ({ v: 1, entries: [], want: [], rejected: [], indexing: false });
    f.gate.release();
    await f.sync.idle();
    expect(f.calls.map(c => c.method)).toEqual(['sync.att.manifest']);
    await f.run();
    expect(f.calls.map(c => c.method)).toEqual(['sync.att.manifest', 'sync.att.manifest']);
  });
});

describe('F11A 引擎：能力位与暂停', () => {
  it('对端没声明 attachments：一个 sync.att.* 都不发', async () => {
    const f = setup();
    f.putFile('a.png', makePng(3000, 10).buf);
    delete f.caps.attachments;
    await f.run();
    f.sync.port.markDirty(SID);
    await f.run();
    expect(f.calls).toEqual([]);
  });

  it('对端声明了却不受理（未知方法 / ATT_CAP_REQUIRED / ATT_CHANNEL_REQUIRED）：本连接周期内不再发；新连接再试', async () => {
    for (const msg of ['未知方法: sync.att.manifest', 'ATT_CAP_REQUIRED', 'ATT_CHANNEL_REQUIRED']) {
      const f = setup();
      f.putFile('a.png', makePng(3000, 11).buf);
      f.respond.manifest = () => new Error(msg);
      await f.run();
      f.sync.port.markDirty(SID);
      await f.run();
      expect(f.manifests().length, msg).toBe(1);
      f.sync.port.onPeerOnline(FP);
      await f.run();
      expect(f.manifests().length, msg).toBe(2);
    }
  });

  it('本机没有任何被引用的附件：不发清单', async () => {
    const f = setup([]);
    await f.run();
    expect(f.calls).toEqual([]);
  });

  it('本端暂停：schedule 不入队、不发清单；恢复后照常发', async () => {
    const f = setup();
    f.putFile('a.png', makePng(3000, 12).buf);
    f.sync.port.setPaused(true);
    await f.run();
    expect(f.calls).toEqual([]);
    f.sync.port.setPaused(false);
    await f.run();
    expect(f.manifests()).toHaveLength(1);
  });

  it('对端回 ATT_PAUSED：不记收敛；对端要的文件按它给的偏移送块，送的一方不改自己的状态', async () => {
    const f = setup();
    const data = makePng(3000, 13).buf;
    f.putFile('a.png', data);
    f.respond.manifest = () => new Error('ATT_PAUSED');
    await f.run();
    await f.run();
    expect(f.manifests()).toHaveLength(2);
    // 关停之后不再发任何东西
    f.sync.port.stop();
    f.sync.port.schedule(FP, SID);
    await f.sync.idle();
    expect(f.manifests()).toHaveLength(2);
    expect(f.sync.store.get(SID, 'a.png')).toMatchObject({ state: 'present', sha256: sha256Of(data) });
  });
});

// 变异核对补的一组（F11A-mutation.json 的 M21、M46）：真实的 remote.unpair 在删配对记录的同一个同步段里就把连接断了，
// 挂着的调用以「连接断开」拒绝，引擎「应答回来之后、写盘之前」与「每一步之前」对配对的复查在真连接上走不到——
// 引擎级、组件级用例里把这两处复查删掉，全部照样是绿的。这里的出站连接是脚本：配对没了它照样在线、照样应答，
// 只剩引擎自己的复查挡着。换连接周期（onPeerOnline）同理：真连接重拨时旧连接上的调用先被拒，旧应答到不了引擎。
describe('F11A 引擎：对配对与连接周期的复查不靠断连（配对没了、连接还在、应答照常回来）', () => {
  const CHUNK = 256 * 1024;
  const partsOf = (f: Fx): string[] => incomingFiles(f.root);

  /** 对端有、本机要取的一个三块文件。第一份清单应答之后关上闸门：随后的第一个 sync.att.get 停在闸门上（应答在途）。 */
  function fetching(seed: number) {
    const f = setup();                                   // 引用 a.png，本机没有文件
    const data = makePng(600_000, seed).buf;
    const sha = sha256Of(data);
    const listing = { v: 1, entries: [{ name: 'a.png', size: data.length, sha256: sha, mimeType: 'image/png' }], want: [], rejected: [], indexing: false };
    f.respond.manifest = () => { f.gate.close(); return listing; };
    f.respond.get = (p: any) => ({ v: 1, offset: p.offset, size: data.length, data: data.subarray(p.offset, p.offset + CHUNK).toString('base64') });
    const getOffsets = (): number[] => f.calls.filter(c => c.method === 'sync.att.get').map(c => c.params.offset);
    return { f, data, sha, listing, getOffsets };
  }

  it('等 get 应答期间取消配对：应答照常回来也不写盘、不再要下一块，行仍是要取的；配回来之后从头取完', async () => {
    const { f, data, sha, listing, getOffsets } = fetching(31);
    f.sync.port.schedule(FP, SID);
    await f.gate.entered();
    expect(getOffsets()).toEqual([0]);
    expect(partsOf(f)).toEqual([]);
    f.paired.value = false;
    f.gate.release();                                    // 第 0 块的应答此刻送达
    await f.sync.idle();
    expect(partsOf(f), '取消配对之后到的那一块不该落盘').toEqual([]);
    expect(getOffsets()).toEqual([0]);
    expect(f.sync.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', want: true, sha256: sha });
    expect(f.sync.store.localFile(SID, 'a.png')).toBeUndefined();
    // 票已撤、没有留下半截：重新配对后的下一轮从第 0 块取起，取完校验发布
    f.paired.value = true;
    f.respond.manifest = () => listing;
    await f.run();
    expect(getOffsets()).toEqual([0, 0, CHUNK, 2 * CHUNK]);
    expect(f.sync.store.get(SID, 'a.png')?.state).toBe('present');
    expect(sha256File(f.sync.store.localFile(SID, 'a.png')!.path)).toBe(sha256Of(data));
    expect(partsOf(f)).toEqual([]);
  });

  it('等 get 应答期间换了连接周期（onPeerOnline）：旧连接上回来的应答不写盘；新周期的作业自己从头取完', async () => {
    const { f, data, listing, getOffsets } = fetching(32);
    f.sync.port.schedule(FP, SID);
    await f.gate.entered();
    f.sync.port.onPeerOnline(FP);
    f.respond.manifest = () => listing;
    f.gate.release();
    await f.sync.idle();
    expect(partsOf(f), '旧连接周期的应答不该落盘').toEqual([]);
    expect(getOffsets()).toEqual([0]);
    await f.run();
    expect(getOffsets()).toEqual([0, 0, CHUNK, 2 * CHUNK]);
    expect(sha256File(f.sync.store.localFile(SID, 'a.png')!.path)).toBe(sha256Of(data));
  });

  it('配对表里已经没有这台设备、出站连接却还在线：一个 sync.att.* 都不发；配回来之后照常发', async () => {
    const f = setup();
    f.putFile('a.png', makePng(3000, 33).buf);
    f.paired.value = false;
    await f.run();
    f.sync.port.markDirty(SID);
    await f.run();
    expect(f.calls).toEqual([]);
    f.paired.value = true;
    await f.run();
    expect(f.manifests()).toHaveLength(1);
  });

  it('送块途中取消配对（连接没断）：在途的那一块之后不再送任何一块', async () => {
    const f = setup();
    const data = makePng(600_000, 34).buf;
    f.putFile('a.png', data);
    f.respond.manifest = () => { f.gate.close(); return { v: 1, entries: [], want: [{ name: 'a.png', sha256: sha256Of(data), offset: 0 }], rejected: [], indexing: false }; };
    f.respond.put = (p: any) => ({ v: 1, offset: p.offset + CHUNK, done: false });
    const putOffsets = (): number[] => f.calls.filter(c => c.method === 'sync.att.put').map(c => c.params.offset);
    f.sync.port.schedule(FP, SID);
    await f.gate.entered();
    expect(putOffsets()).toEqual([0]);
    f.paired.value = false;
    f.gate.release();
    await f.sync.idle();
    expect(putOffsets()).toEqual([0]);
  });

  it('对照：配对一直在时，同一套脚本把三块都取回来、把三块都送出去', async () => {
    const { f, sha, listing, getOffsets } = fetching(35);
    f.respond.manifest = () => listing;                  // 不关闸门：应答一路放行
    await f.run();
    expect(getOffsets()).toEqual([0, CHUNK, 2 * CHUNK]);
    expect(f.sync.store.get(SID, 'a.png')).toMatchObject({ state: 'present', sha256: sha });

    const g = setup();
    const data = makePng(600_000, 36).buf;
    g.putFile('a.png', data);
    g.respond.manifest = () => ({ v: 1, entries: [], want: [{ name: 'a.png', sha256: sha256Of(data), offset: 0 }], rejected: [], indexing: false });
    g.respond.put = (p: any) => { const next = Math.min(p.offset + CHUNK, data.length); return { v: 1, offset: next, done: next === data.length }; };
    await g.run();
    expect(g.calls.filter(c => c.method === 'sync.att.put').map(c => c.params.offset)).toEqual([0, CHUNK, 2 * CHUNK]);
  });
});

describe('F11A 引擎：状态模型里靠「有没有行」「交换在引用之前还是之后」区分的几格', () => {
  const REL = 'attachments/a.png';

  it('还没有行的「等待同步」不给取消；清单告诉了内容身份、行还要取时才给，取消后下一份清单不再取', async () => {
    const f = setup();            // 引用 a.png，本机没有文件；对端在线、支持，还没交换过这个会话
    const before = await f.item(REL);
    expect(before).toMatchObject({ state: 'pending', reason: 'queued', canRetry: false, canCancel: false, localAvailable: false });
    // 直接调 RPC 也留不下「看起来取消了、清单一到照样下载」的状态：没有行可记，状态原样
    expect(await f.local('attachments.cancel', { sessionId: SID, name: 'a.png' })).toEqual({ ok: true });
    expect(f.sync.store.list(SID)).toEqual([]);
    expect(await f.item(REL)).toEqual(before);

    // 对端的清单列出了它：建行、开始取（脚本对 get 不应答 → 中断）。这时取消才有东西可记
    const data = makePng(3000, 20).buf;
    f.respond.manifest = () => ({ v: 1, entries: [{ name: 'a.png', size: 3000, sha256: sha256Of(data), mimeType: 'image/png' }], want: [], rejected: [], indexing: false });
    await f.run();
    expect(f.calls.map(c => c.method)).toEqual(['sync.att.manifest', 'sync.att.get']);
    expect(await f.item(REL)).toMatchObject({ state: 'pending', reason: 'interrupted', canRetry: true, canCancel: true });
    await f.local('attachments.cancel', { sessionId: SID, name: 'a.png' });
    expect(f.sync.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', want: false });
    expect(await f.item(REL)).toMatchObject({ state: 'held', canRetry: true, canCancel: false });
    f.sync.port.onRemoteDirty(FP, SID);
    await f.run();
    // 又发了一轮清单，没有再取
    expect(f.calls.map(c => c.method)).toEqual(['sync.att.manifest', 'sync.att.get', 'sync.att.manifest']);
    expect(await f.item(REL)).toMatchObject({ state: 'held' });
  });

  it('交换过清单的会话里新到的引用：下一份清单之前是「等待同步」；那份清单之后对端仍没列它，才是「在线的设备上没有这个文件」', async () => {
    const f = setup();
    f.putFile('a.png', makePng(3000, 21).buf);
    await f.run();                                   // 这个会话与对端交换过一次清单
    expect(f.manifests()).toHaveLength(1);
    f.addRef('attachments/b.png');                   // 新消息带来的引用：本机没有文件、没有行，对端还没被问过
    expect(await f.item('attachments/b.png')).toMatchObject({ state: 'pending', reason: 'queued', canRetry: false, canCancel: false });
    expect(await f.item(REL)).toMatchObject({ state: 'ready' });
    await f.run();                                   // 引用出现之后又交换了一次，对端的清单里没有它
    expect(f.manifests()).toHaveLength(2);
    expect(await f.item('attachments/b.png')).toMatchObject({ state: 'unavailable', reason: 'no_source', canRetry: true, canCancel: false });
    // 再来一条别的消息：b.png 已经被问过，结论不因为无关的新消息退回「等待同步」
    f.addRef('attachments/c.png');
    expect(await f.item('attachments/b.png')).toMatchObject({ state: 'unavailable', reason: 'no_source' });
    expect(await f.item('attachments/c.png')).toMatchObject({ state: 'pending', reason: 'queued' });
  });

  it('清单在途时才到的引用：那一次交换不算问过它（记的是发清单那一刻的引用集）', async () => {
    const f = setup();
    f.putFile('a.png', makePng(3000, 22).buf);
    f.gate.close();
    f.sync.port.schedule(FP, SID);
    await f.gate.entered();                          // 清单已发出、应答还没回来
    f.addRef('attachments/b.png');
    f.gate.release();
    await f.sync.idle();
    expect(f.manifests()).toHaveLength(1);
    expect(await f.item('attachments/b.png')).toMatchObject({ state: 'pending', reason: 'queued' });
  });

  it('监听方：对端的清单处理途中才到的引用不算被这份清单问过（记的是受理那一刻的引用集）；受理时已有的引用对端没列，才是 no_source', async () => {
    const hashGate = makeGate();
    const f = setup(['a.png', 'gone.png'], { inbound: true, hashGate });   // 对端是拨进来的；gone.png 两端都没有文件
    f.putFile('a.png', makePng(3000, 24).buf);
    f.sync.onPeerHello(FP, { protocolVersion: 2, caps: { attachments: true } });
    // 还没交换过：没有行的引用是等待
    hashGate.close();
    const pending = f.item('attachments/gone.png');                         // status 先强制登记：停在 a.png 的哈希上
    await hashGate.entered();
    hashGate.release();
    expect(await pending).toMatchObject({ state: 'pending', reason: 'queued', canCancel: false });
    // 对端发来清单（什么都没列）。处理器先等本机登记：有一个新引用的本机文件要算哈希，停在闸门上；这时来了一条带新引用的消息
    f.putFile('warm.png', makePng(3100, 25).buf);
    f.addRef('attachments/warm.png');
    hashGate.close();
    const reply = f.sync.peerMethods['sync.att.manifest']({ v: 1, sessionId: SID, entries: [] }, INBOUND_CONN);
    await hashGate.entered();
    f.addRef('attachments/late.png');
    hashGate.release();
    expect(await reply).toMatchObject({ v: 1, want: [], rejected: [], indexing: false });
    expect(await f.item('attachments/warm.png')).toMatchObject({ state: 'ready' });
    // 受理那一刻已有的引用：对端的清单没列它 → 在线的设备上没有
    expect(await f.item('attachments/gone.png')).toMatchObject({ state: 'unavailable', reason: 'no_source', canRetry: true, canCancel: false });
    // 处理途中才到的：这份清单没有问过它 → 等待
    expect(await f.item('attachments/late.png')).toMatchObject({ state: 'pending', reason: 'queued', canRetry: false, canCancel: false });
  });

  it('名字过不了同步规则、但文件就在本机附件桶里的引用：照实报本机有（模型读得到），不同步；能打开自己的文件', async () => {
    const f = setup([]);
    const shot = makePng(3000, 23).buf;
    // chat.prompt 的白名单收这几种名字（. _ - 开头、含 ..），同步的名字规则不收
    for (const n of ['_shot.png', '-a.png', 'a..b.png']) { f.putFile(n, shot); f.addRef(`attachments/${n}`); }
    f.addRef('attachments/_gone.png');               // 同一类名字，桶里没有文件
    f.addRef('attachments/../../../evil.png');       // 多层目录：不认
    f.addRef('C:\\Users\\x\\secret.png');            // 绝对路径：不认
    f.putFile('_unref.png', shot);                   // 桶里有、没有消息引用
    for (const n of ['_shot.png', '-a.png', 'a..b.png']) {
      const item = await f.item(`attachments/${n}`);
      expect(item, n).toMatchObject({ name: n, state: 'unavailable', reason: 'bad_reference', localAvailable: true, canRetry: false, canCancel: false });
      expect(item!.localPath, n).toBe(join(f.root, 'sessions', SID, 'attachments', n));
    }
    for (const rel of ['attachments/_gone.png', 'attachments/../../../evil.png', 'C:\\Users\\x\\secret.png']) {
      const item = await f.item(rel);
      expect(item, rel).toMatchObject({ state: 'unavailable', reason: 'bad_reference', localAvailable: false });
      expect(item!.localPath, rel).toBeUndefined();
    }
    // 这类附件不登记、不进清单
    expect(f.sync.store.list(SID)).toEqual([]);
    await f.run();
    expect(f.calls).toEqual([]);
    // 打开：读到的就是本机这一份
    const r = await f.local('attachments.read', { sessionId: SID, name: '_shot.png' });
    expect(r).toMatchObject({ name: '_shot.png', size: 3000, localPath: join(f.root, 'sessions', SID, 'attachments', '_shot.png') });
    expect(sha256Of(Buffer.from(r.base64, 'base64'))).toBe(sha256Of(shot));
    // 仍然按「消息引用」授权：桶里有但没被引用的、被引用但桶里没有的、带分隔符的名字都读不到
    await expect(f.local('attachments.read', { sessionId: SID, name: '_unref.png' })).rejects.toThrow('附件尚未同步到本机');
    await expect(f.local('attachments.read', { sessionId: SID, name: '_gone.png' })).rejects.toThrow('附件尚未同步到本机');
    for (const bad of ['..', '.', '../evil.png', 'a/b.png', 'a\\b.png', 'C:evil.png', 'x.png:ads', 'CON.png', '']) {
      await expect(f.local('attachments.read', { sessionId: SID, name: bad }), bad).rejects.toThrow('非法附件名');
    }
    // 重试、取消仍只认同步的名字规则：这类附件没有可重试、可取消的东西
    await expect(f.local('attachments.retry', { sessionId: SID, name: '_shot.png' })).rejects.toThrow('非法附件名');
    await expect(f.local('attachments.cancel', { sessionId: SID, name: '_shot.png' })).rejects.toThrow('非法附件名');
  });

  it('前缀大小写不同的引用（chat.prompt 的白名单带 /i，照收并原样落库）：文件在本机桶里就照实报本机有、能打开；不登记、不进清单、对端要不走', async () => {
    const f = setup([]);
    const shot = makePng(3000, 29).buf;
    f.putFile('x.png', shot);
    f.putFile('_y.png', shot);
    f.addRef('Attachments/x.png');         // 名字本身合规，只有前缀的大小写不同
    f.addRef('ATTACHMENTS/_y.png');        // 前缀与名字都过不了同步的规则
    f.addRef('Attachments/gone.png');      // 同一种形态，桶里没有文件
    for (const [rel, name] of [['Attachments/x.png', 'x.png'], ['ATTACHMENTS/_y.png', '_y.png']]) {
      const item = await f.item(rel);
      // 请求构建按 basename 读桶里的这个文件，模型照常收到；状态要照实说本机有
      expect(item, rel).toMatchObject({ name, relativePath: rel, state: 'unavailable', reason: 'bad_reference', localAvailable: true, canRetry: false, canCancel: false });
      expect(item!.localPath, rel).toBe(join(f.root, 'sessions', SID, 'attachments', name));
      // 界面据此：chip 点得开、文案是「本机可用…不同步」；「模型暂时看不到」的判据（!localAvailable）不成立
      expect(chipOf(item), rel).toMatchObject({ open: true, tone: 'warn', label: ATTACHMENT_STATE_TEXT['local/bad_reference'] });
    }
    const gone = await f.item('Attachments/gone.png');
    expect(gone).toMatchObject({ state: 'unavailable', reason: 'bad_reference', localAvailable: false });
    expect(gone!.localPath).toBeUndefined();
    expect(chipOf(gone)).toMatchObject({ open: false, label: ATTACHMENT_STATE_TEXT['unavailable/bad_reference'] });
    // 这一份不同步：同步侧不认这种引用，不登记、不进清单、不上线路
    expect([...f.sync.store.referenced(SID).keys()]).toEqual([]);
    expect(f.sync.store.list(SID)).toEqual([]);
    await f.run();
    expect(f.calls).toEqual([]);
    // 打开：读到的就是本机这一份（界面传的是状态里的 name）
    for (const name of ['x.png', '_y.png']) {
      const r = await f.local('attachments.read', { sessionId: SID, name });
      expect(r, name).toMatchObject({ name, size: 3000, localPath: join(f.root, 'sessions', SID, 'attachments', name) });
      expect(sha256Of(Buffer.from(r.base64, 'base64')), name).toBe(sha256Of(shot));
    }
    await expect(f.local('attachments.read', { sessionId: SID, name: 'gone.png' })).rejects.toThrow('附件尚未同步到本机');
    // 放宽的只是本机显示与本机读取。对端按这个（合规的）名字来推、来取，都因为它没被同步侧当作引用而不成
    const sha = sha256Of(shot);
    const pushed = await f.sync.peerMethods['sync.att.manifest']({ v: 1, sessionId: SID, entries: [{ name: 'x.png', size: 3000, sha256: sha, mimeType: 'image/png' }] }, INBOUND_CONN);
    expect(pushed).toMatchObject({ v: 1, entries: [], want: [], rejected: [{ index: 0, code: 'not_referenced' }] });
    await expect(f.sync.peerMethods['sync.att.get']({ v: 1, sessionId: SID, name: 'x.png', sha256: sha, offset: 0 }, INBOUND_CONN)).rejects.toThrow('ATT_NOT_FOUND');
    expect(f.sync.store.list(SID)).toEqual([]);
  });
});
