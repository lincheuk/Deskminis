/**
 * F11A · 真引擎 × 脚本对端（故障注入）。受测端是 startMinisd 起的真引擎；对端 RawPeer 经真实配对、真实加密通道连上，
 * 只是它发什么由脚本控制（tests/att-peer-util.ts）。覆盖任务卡验收 2、3、4 与阻断 2、3 里两个真引擎之间造不出来的故障：
 * 重复块、损坏的哈希、超额、路径穿越的名字、读源设备任意文件、不声明能力位的旧版对端、明文连接、用户取消、两个对端并发。
 *
 * 每个故障用例末尾都核对：附件桶里没有这个文件、状态不是 ready、读不到、sync-incoming/ 里没有可当作完整文件的东西。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMinisd } from '../src/minisd/index';
import { makePng, sha256File, sha256Of, treeOf, waitFor } from './att-util';
import { bucketOf, expectNotComplete, itemOf, newSession, partsIn, seedFile, statusOf, wsConnect, type RpcClient } from './att-engines-util';
import { RawPeer, refMessage, type RawConn } from './att-peer-util';

const CHUNK = 256 * 1024;
const MiB = 1024 * 1024;
const CAPS = { protocolVersion: 2, caps: { attachments: true } };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

interface Rig { parent: string; root: string; port: number; local: RpcClient; peer: RawPeer; conn: RawConn }

/** 一个真引擎（数据根放在专用的父目录里，方便断言「数据根之外没有多出任何文件」）加一个已配对、已握通道、已声明能力位的脚本对端。 */
async function rig(hello: Parameters<RawConn['hello']>[0] | 'none' = CAPS): Promise<Rig> {
  const parent = mkdtempSync(join(tmpdir(), 'f11a-adv-'));
  const root = join(parent, 'data');
  mkdirSync(root);
  writeFileSync(join(root, 'providers.json'), JSON.stringify({ providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }], defaultProviderId: '__fake__' }), 'utf8');
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir: root, host: '127.0.0.1', port: 0 });
  const local = await wsConnect(`ws://127.0.0.1:${srv.port}/?token=${srv.authToken}`);
  const peer = new RawPeer();
  cleanups.push(async () => {
    peer.dispose(); local.close();
    await srv.close();
    try { rmSync(parent, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
  });
  await peer.pair(local, srv.port);
  const conn = await peer.connect();
  if (hello !== 'none') await conn.hello(hello);
  return { parent, root, port: srv.port, local, peer, conn };
}

/** 脚本对端（拨号方）推一个会话与一条引用了这些名字的消息；返回会话 id。 */
async function pushSession(conn: RawConn, names: unknown[]): Promise<string> {
  const sid = randomUUID().toUpperCase();
  const now = Date.now();
  await conn.call('sync.push', {
    sessionId: sid,
    payload: {
      messages: [refMessage(sid, names.map(n => ({ relativePath: typeof n === 'string' && !n.includes('/') && !n.includes('\\') ? `attachments/${n}` : n })))],
      markers: [], session: { id: sid, title: '脚本对端推来的会话', createdAt: now, updatedAt: now, memoryEnabled: 1 },
    },
  });
  return sid;
}

const entry = (name: string, data: Buffer) => ({ name, size: data.length, sha256: sha256Of(data), mimeType: 'image/png' });
const manifest = (conn: RawConn, sid: string, entries: unknown[]) => conn.call('sync.att.manifest', { v: 1, sessionId: sid, entries });
const put = (conn: RawConn, sid: string, name: string, sha: string, offset: number, bytes: Buffer) =>
  conn.call('sync.att.put', { v: 1, sessionId: sid, name, sha256: sha, offset, data: bytes.toString('base64') });
const chunkAt = (data: Buffer, offset: number): Buffer => data.subarray(offset, Math.min(data.length, offset + CHUNK));
async function putAll(conn: RawConn, sid: string, name: string, data: Buffer, sha = sha256Of(data), from = 0): Promise<any> {
  let last: any;
  for (let off = from; off < data.length; off += CHUNK) last = await put(conn, sid, name, sha, off, chunkAt(data, off));
  return last;
}
async function errOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as Error).message; }
  return '没有抛错';
}

describe('F11A 对抗：块与哈希', () => {
  it('基线：脚本对端按协议推一个文件 → 引擎的附件桶里出现它，哈希相等，状态 ready', async () => {
    const r = await rig();
    const data = makePng(600_000, 1).buf; const name = 'paste-1-11111111.png';
    const sid = await pushSession(r.conn, [name]);
    expect((await itemOf(r.local, sid, name))?.state).not.toBe('ready');
    const m = await manifest(r.conn, sid, [entry(name, data)]);
    expect(m).toEqual({ v: 1, entries: [], want: [{ name, sha256: sha256Of(data), offset: 0 }], rejected: [], indexing: false });
    expect(await putAll(r.conn, sid, name, data)).toEqual({ v: 1, offset: data.length, done: true });
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(data));
    expect((await itemOf(r.local, sid, name))?.state).toBe('ready');
    expect(partsIn(r.root)).toEqual([]);
  });

  it('重复块不被追加；跳块被拒并告知期望的偏移；块长不对被拒；收满之后再来的块不改变已发布的文件', async () => {
    const r = await rig();
    const data = makePng(600_000, 2).buf; const name = 'paste-2-22222222.png'; const sha = sha256Of(data);
    const sid = await pushSession(r.conn, [name]);
    await manifest(r.conn, sid, [entry(name, data)]);
    expect(await put(r.conn, sid, name, sha, 0, chunkAt(data, 0))).toEqual({ v: 1, offset: CHUNK, done: false });
    const partSize = (): number => partsIn(r.root).find(p => p.name.endsWith('.part'))?.size ?? -1;
    expect(partSize()).toBe(CHUNK);
    // 同一个 offset 再发一次：偏移不前进，暂存长度不变
    expect(await put(r.conn, sid, name, sha, 0, chunkAt(data, 0))).toEqual({ v: 1, offset: CHUNK, done: false });
    expect(partSize()).toBe(CHUNK);
    expect(await errOf(put(r.conn, sid, name, sha, 2 * CHUNK, chunkAt(data, 2 * CHUNK)))).toBe(`ATT_OFFSET expected=${CHUNK}`);
    // 一块比该有的短 / 末块给了一整块（会越过声明长度）
    expect(await errOf(put(r.conn, sid, name, sha, CHUNK, data.subarray(CHUNK, CHUNK + 1000)))).toBe('ATT_BAD_CHUNK');
    expect(partSize()).toBe(CHUNK);
    await put(r.conn, sid, name, sha, CHUNK, chunkAt(data, CHUNK));
    expect(await errOf(put(r.conn, sid, name, sha, 2 * CHUNK, Buffer.alloc(CHUNK, 1)))).toBe('ATT_BAD_CHUNK');
    expect(partSize()).toBe(2 * CHUNK);
    // data 超长：信封就不合规
    expect(await errOf(r.conn.call('sync.att.put', { v: 1, sessionId: sid, name, sha256: sha, offset: 2 * CHUNK, data: Buffer.alloc(CHUNK + 3).toString('base64') }))).toBe('ATT_BAD_REQUEST');
    // 不等应答连发剩下的块：按到达顺序落盘
    const rest = [2 * CHUNK].map(off => put(r.conn, sid, name, sha, off, chunkAt(data, off)));
    expect((await Promise.all(rest)).pop()).toEqual({ v: 1, offset: data.length, done: true });
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha);
    expect(await errOf(put(r.conn, sid, name, sha, 2 * CHUNK, chunkAt(data, 2 * CHUNK)))).toBe('ATT_NO_TRANSFER');
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha);
  });

  it('损坏的哈希：最后一块翻转一个字节 → ATT_HASH，不发布、删暂存；再坏一次记失败可重试；重试后用正确内容传完', async () => {
    const r = await rig();
    const data = makePng(600_000, 3).buf; const name = 'paste-3-33333333.png'; const sha = sha256Of(data);
    const bad = Buffer.from(data); bad[bad.length - 1] ^= 0x01;
    const sid = await pushSession(r.conn, [name]);
    for (const round of [1, 2]) {
      const m = await manifest(r.conn, sid, [entry(name, data)]);
      expect(m.want, `第 ${round} 轮仍然要这份内容`).toEqual([{ name, sha256: sha, offset: 0 }]);
      // 声明的是 data 的哈希，送来的是别的字节（等同于「manifest 的 sha256 是别的文件的」）
      expect(await errOf(putAll(r.conn, sid, name, bad, sha))).toBe('ATT_HASH');
      await expectNotComplete(r.root, r.local, sid, name, data.length);
      expect(partsIn(r.root)).toEqual([]);
    }
    const failed = await itemOf(r.local, sid, name);
    expect(failed).toMatchObject({ state: 'failed', reason: 'hash_mismatch', canRetry: true, localAvailable: false });
    expect((await manifest(r.conn, sid, [entry(name, data)])).rejected).toEqual([{ index: 0, code: 'failed' }]);
    expect(await errOf(put(r.conn, sid, name, sha, 0, chunkAt(data, 0)))).toBe('ATT_CANCELLED');
    // 用户重试：引擎（监听方）发 sync.dirty 催对端重发清单
    const before = r.conn.notifications.length;
    expect(await r.local.call('attachments.retry', { sessionId: sid, name })).toEqual({ ok: true, started: true });
    await waitFor('对端收到 sync.dirty', () => r.conn.notifications.slice(before).some(n => n.method === 'sync.dirty' && n.params?.sessionId === sid));
    expect((await manifest(r.conn, sid, [entry(name, data)])).want).toEqual([{ name, sha256: sha, offset: 0 }]);
    expect((await putAll(r.conn, sid, name, data)).done).toBe(true);
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha);
    expect((await itemOf(r.local, sid, name))?.state).toBe('ready');
  });

  it('续传从断点开始：断开重连后清单应答的 offset 等于已收长度', async () => {
    const r = await rig();
    const data = makePng(MiB, 4).buf; const name = 'paste-4-44444444.png'; const sha = sha256Of(data);
    const sid = await pushSession(r.conn, [name]);
    await manifest(r.conn, sid, [entry(name, data)]);
    await put(r.conn, sid, name, sha, 0, chunkAt(data, 0));
    await put(r.conn, sid, name, sha, CHUNK, chunkAt(data, CHUNK));
    r.conn.close();
    await r.conn.closed;
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    const again = await r.peer.connect();
    await again.hello(CAPS);
    expect((await manifest(again, sid, [entry(name, data)])).want).toEqual([{ name, sha256: sha, offset: 2 * CHUNK }]);
    expect((await putAll(again, sid, name, data, sha, 2 * CHUNK)).done).toBe(true);
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha);
  });
});

describe('F11A 对抗：超额与名字', () => {
  it('超额：单文件超限、会话配额、清单条数——都只凭声明判定，不要字节，不产生暂存', async () => {
    const r = await rig();
    const names = Array.from({ length: 17 }, (_, i) => `big-${i}.png`);
    const sid = await pushSession(r.conn, ['huge.png', ...names]);
    const fake = (n: number): string => sha256Of(Buffer.from(`内容 ${n}`));
    // 32 MiB + 1
    expect((await manifest(r.conn, sid, [{ name: 'huge.png', size: 32 * MiB + 1, sha256: fake(0), mimeType: 'image/png' }])).rejected).toEqual([{ index: 0, code: 'too_large' }]);
    expect(await errOf(put(r.conn, sid, 'huge.png', fake(0), 0, Buffer.alloc(CHUNK)))).toBe('ATT_CANCELLED');
    expect(await itemOf(r.local, sid, 'huge.png')).toMatchObject({ state: 'unavailable', reason: 'too_large', localAvailable: false });
    // 17 条各 32 MiB：前 16 条正好 512 MiB，第 17 条超配额
    const m = await manifest(r.conn, sid, names.map((name, i) => ({ name, size: 32 * MiB, sha256: fake(i + 1), mimeType: 'image/png' })));
    expect(m.want).toHaveLength(16);
    expect(m.rejected).toEqual([{ index: 16, code: 'quota' }]);
    expect(await itemOf(r.local, sid, 'big-16.png')).toMatchObject({ state: 'unavailable', reason: 'quota' });
    // 513 条：整条拒绝
    const many = Array.from({ length: 513 }, (_, i) => ({ name: `f${i}.png`, size: 1, sha256: fake(i), mimeType: 'image/png' }));
    expect(await errOf(manifest(r.conn, sid, many))).toBe('ATT_BAD_REQUEST');
    expect(partsIn(r.root)).toEqual([]);
  });

  it('路径穿越的名字与会话 id：一律被拒或条目被丢弃；数据根之外、附件桶之外没有多出任何文件', async () => {
    const r = await rig();
    const data = makePng(5000, 5).buf; const sha = sha256Of(data);
    const sid = await pushSession(r.conn, ['ok.png']);
    const outside = (): string[] => treeOf(r.parent, rel => rel === 'data' || rel.startsWith('data/'));
    const inside = (): string[] => treeOf(r.root).filter(l => /evil|\.\.|ads|hidden/i.test(l));
    const before = outside();
    const badNames: unknown[] = ['..\\..\\evil.png', '../x', 'a/b.png', 'C:evil', 'x.png:ads', 'CON.png', 'nul', '.hidden', 'x.', '', 'x\u0000y.png', 'n'.repeat(129), 42, null];
    const m = await manifest(r.conn, sid, badNames.map(name => ({ name, size: data.length, sha256: sha, mimeType: 'image/png' })));
    expect(m.want).toEqual([]);
    expect(m.rejected).toEqual(badNames.map((_, index) => ({ index, code: 'bad_name' })));
    for (const name of badNames) {
      expect(await errOf(r.conn.call('sync.att.put', { v: 1, sessionId: sid, name, sha256: sha, offset: 0, data: data.toString('base64') })), String(name)).toBe('ATT_BAD_REQUEST');
      expect(await errOf(r.conn.call('sync.att.get', { v: 1, sessionId: sid, name, sha256: sha, offset: 0 })), String(name)).toBe('ATT_BAD_REQUEST');
    }
    for (const badSid of ['..\\..\\x', 'not-a-uuid', '', 7]) {
      expect(await errOf(r.conn.call('sync.att.manifest', { v: 1, sessionId: badSid, entries: [entry('ok.png', data)] }))).toBe('ATT_BAD_REQUEST');
      expect(await errOf(r.conn.call('sync.att.get', { v: 1, sessionId: badSid, name: 'ok.png', sha256: sha, offset: 0 }))).toBe('ATT_BAD_REQUEST');
      expect(await errOf(r.conn.call('sync.att.put', { v: 1, sessionId: badSid, name: 'ok.png', sha256: sha, offset: 0, data: data.toString('base64') }))).toBe('ATT_BAD_REQUEST');
    }
    expect(outside()).toEqual(before);
    expect(inside()).toEqual([]);
    expect(partsIn(r.root)).toEqual([]);
    expect(existsSync(join(r.root, 'sessions', '..\\..\\x'))).toBe(false);
  });

  it('消息里的引用是穿越路径或绝对路径：状态是「引用的文件名不合规」，不登记、不受理', async () => {
    const r = await rig();
    const data = makePng(5000, 6).buf;
    const sid = await pushSession(r.conn, ['attachments/../../../evil.png', 'C:\\Windows\\win.ini']);
    const st = await statusOf(r.local, sid);
    expect(st.items.map(i => [i.state, i.reason, i.localAvailable])).toEqual([['unavailable', 'bad_reference', false], ['unavailable', 'bad_reference', false]]);
    expect((await manifest(r.conn, sid, [entry('evil.png', data)])).rejected).toEqual([{ index: 0, code: 'not_referenced' }]);
    expect(await errOf(put(r.conn, sid, 'evil.png', sha256Of(data), 0, data))).toBe('ATT_CANCELLED');
    expect(partsIn(r.root)).toEqual([]);
    expect(treeOf(r.root).filter(l => l.includes('evil'))).toEqual([]);
  });

  it('不访问源设备任意文件：只给得出「被消息引用、已登记、内容相符」的附件；别的一律 ATT_NOT_FOUND 且不带数据', async () => {
    const r = await rig();
    const real = makePng(5000, 7).buf; const shot = makePng(4000, 8).buf; const other = makePng(4500, 9).buf;
    const sid = await newSession(r.local, '有附件的会话');
    await seedFile(r.local, r.root, sid, 'real.png', real, 'image/png');
    writeFileSync(join(bucketOf(r.root, sid), 'screenshot-1.png'), shot);          // 桶里有、没有消息引用（截屏）
    const sid2 = await newSession(r.local, '别的会话');
    await seedFile(r.local, r.root, sid2, 'other.png', other, 'image/png');
    // 让引擎把两个会话的本机文件登记好（真实流程里拨号方先发清单，监听方在应答之前登记）
    expect((await itemOf(r.local, sid, 'real.png'))?.state).toBe('ready');
    expect((await itemOf(r.local, sid2, 'other.png'))?.state).toBe('ready');
    const get =(name: string, sha: string, s = sid) => r.conn.call('sync.att.get', { v: 1, sessionId: s, name, sha256: sha, offset: 0 });
    // 正向对照：被引用的那一个拿得到，字节相等
    const ok = await get('real.png', sha256Of(real));
    expect(sha256Of(Buffer.from(ok.data, 'base64'))).toBe(sha256Of(real));
    expect(Object.keys(ok).sort()).toEqual(['data', 'offset', 'size', 'v']);
    for (const [name, sha, s] of [
      ['screenshot-1.png', sha256Of(shot), sid], ['minis.db', sha256Of(real), sid], ['providers.json', sha256Of(real), sid],
      ['vault.json', sha256Of(real), sid], ['other.png', sha256Of(other), sid], ['real.png', sha256Of(other), sid], ['real.png', sha256Of(real), sid2],
    ] as const) {
      expect(await errOf(get(name, sha, s)), `${name}`).toBe('ATT_NOT_FOUND');
    }
    // 清单应答里只有被引用的那一个，没有路径
    const m = await manifest(r.conn, sid, []);
    expect(m.entries).toEqual([{ name: 'real.png', size: 5000, sha256: sha256Of(real), mimeType: 'image/png' }]);
    expect(JSON.stringify(m)).not.toContain(r.root);
    expect(JSON.stringify(m)).not.toMatch(/[A-Za-z]:\\\\/);
  });

  it('同会话同名不同内容：本机先有的不被覆盖，冲突可见，对端得到 name_conflict，不产生暂存', async () => {
    const r = await rig();
    const mine = makePng(5000, 10).buf; const theirs = makePng(5200, 11).buf;
    const sid = await newSession(r.local, '冲突');
    await seedFile(r.local, r.root, sid, 'paste-1.png', mine, 'image/png');
    const m = await manifest(r.conn, sid, [entry('paste-1.png', theirs)]);
    expect(m.rejected).toEqual([{ index: 0, code: 'name_conflict' }]);
    expect(m.want).toEqual([]);
    expect(await errOf(put(r.conn, sid, 'paste-1.png', sha256Of(theirs), 0, theirs))).toBe('ATT_CANCELLED');
    expect(sha256File(join(bucketOf(r.root, sid), 'paste-1.png'))).toBe(sha256Of(mine));
    expect(await itemOf(r.local, sid, 'paste-1.png')).toMatchObject({ state: 'ready', conflict: true, sha256: sha256Of(mine) });
    expect(partsIn(r.root)).toEqual([]);
  });

  it('发布时最终名字被占：传输途中本机在最终路径上有了别的内容 → 不覆盖，记 name_conflict，那份内容不变', async () => {
    const r = await rig();
    const data = makePng(600_000, 17).buf; const name = 'paste-8-88888888.png'; const sha = sha256Of(data);
    const other = makePng(3000, 18).buf;
    const sid = await pushSession(r.conn, [name]);
    await manifest(r.conn, sid, [entry(name, data)]);
    await put(r.conn, sid, name, sha, 0, chunkAt(data, 0));
    mkdirSync(bucketOf(r.root, sid), { recursive: true });
    writeFileSync(join(bucketOf(r.root, sid), name), other);
    // 收满、校验通过，但最终名字上已经有别的内容：这次 put 不算完成
    expect(await errOf(putAll(r.conn, sid, name, data, sha, CHUNK))).toBe('ATT_CANCELLED');
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(other));
    expect(await itemOf(r.local, sid, name)).toMatchObject({ state: 'failed', reason: 'name_conflict', localAvailable: true });
    expect(partsIn(r.root)).toEqual([]);
    expect((await manifest(r.conn, sid, [entry(name, data)])).rejected).toEqual([{ index: 0, code: 'failed' }]);
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(other));
  });
});

describe('F11A 对抗：能力位、通道、取消、并发', () => {
  it('旧版拨号方（sync.hello 不声明 attachments）：三个方法都是 ATT_CAP_REQUIRED，拿不到数据；界面显示对方版本不支持', async () => {
    for (const hello of [undefined, { protocolVersion: 2, caps: {} }] as const) {
      const r = await rig('none');
      await r.conn.hello(hello);
      const real = makePng(5000, 12).buf;
      const sid = await newSession(r.local, '引擎自己的附件');
      await seedFile(r.local, r.root, sid, 'real.png', real, 'image/png');
      expect((await itemOf(r.local, sid, 'real.png'))?.state).toBe('ready');   // 本机文件已登记：下面拿不到数据只能是因为能力位
      const pushed = await pushSession(r.conn, ['from-old-peer.png']);        // 消息照常同步
      expect((await r.local.call('chat.messages.list', { sessionId: pushed })).length).toBe(1);
      expect(await errOf(manifest(r.conn, sid, []))).toBe('ATT_CAP_REQUIRED');
      expect(await errOf(r.conn.call('sync.att.get', { v: 1, sessionId: sid, name: 'real.png', sha256: sha256Of(real), offset: 0 }))).toBe('ATT_CAP_REQUIRED');
      expect(await errOf(put(r.conn, pushed, 'from-old-peer.png', sha256Of(real), 0, real))).toBe('ATT_CAP_REQUIRED');
      expect(await itemOf(r.local, pushed, 'from-old-peer.png')).toMatchObject({ state: 'unavailable', reason: 'peer_unsupported', localAvailable: false });
      expect(partsIn(r.root)).toEqual([]);
      // 对照：同一个对端换一条声明了能力位的连接，同一个 get 拿得到数据
      const withCap = await r.peer.connect();
      await withCap.hello(CAPS);
      const ok = await withCap.call('sync.att.get', { v: 1, sessionId: sid, name: 'real.png', sha256: sha256Of(real), offset: 0 });
      expect(sha256Of(Buffer.from(ok.data, 'base64'))).toBe(sha256Of(real));
    }
  });

  it('明文连接（回环 ?paseto=）与本机连接调 sync.att.*：ATT_CHANNEL_REQUIRED；远程连接调 attachments.* 被拒', async () => {
    const r = await rig();
    const real = makePng(5000, 13).buf;
    const sid = await newSession(r.local, '引擎自己的附件');
    await seedFile(r.local, r.root, sid, 'real.png', real, 'image/png');
    const getReq = { v: 1, sessionId: sid, name: 'real.png', sha256: sha256Of(real), offset: 0 };
    const plain = await r.peer.connect({ plain: true });
    await plain.hello(CAPS);                                                   // 声明了能力位也不行：通道不是加密的
    expect(await errOf(plain.call('sync.att.manifest', { v: 1, sessionId: sid, entries: [] }))).toBe('ATT_CHANNEL_REQUIRED');
    expect(await errOf(plain.call('sync.att.get', getReq))).toBe('ATT_CHANNEL_REQUIRED');
    expect(await errOf(plain.call('sync.att.put', { ...getReq, data: real.toString('base64') }))).toBe('ATT_CHANNEL_REQUIRED');
    expect(await errOf(r.local.call('sync.att.get', getReq))).toBe('ATT_CHANNEL_REQUIRED');
    // 加密通道上的远程连接也调不了本机方法（它们回本机绝对路径与文件内容）
    for (const m of ['attachments.read', 'attachments.status', 'attachments.retry', 'attachments.cancel']) {
      expect(await errOf(r.conn.call(m, { sessionId: sid, name: 'real.png' })), m).toContain('只允许本机连接');
    }
  });

  it('对端已取消配对：之后的 sync.att.* 被业务守卫当场拒绝，连接随后被关', async () => {
    const r = await rig();
    const data = makePng(600_000, 14).buf; const name = 'paste-5-55555555.png'; const sha = sha256Of(data);
    const sid = await pushSession(r.conn, [name]);
    await manifest(r.conn, sid, [entry(name, data)]);
    await put(r.conn, sid, name, sha, 0, chunkAt(data, 0));
    const size = statSync(join(r.root, 'sync-incoming', `${sha}.${data.length}.part`)).size;
    await r.local.call('remote.unpair', { peerFingerprint: r.peer.fp });
    expect(await errOf(put(r.conn, sid, name, sha, CHUNK, chunkAt(data, CHUNK)))).toMatch(/已取消配对|连接断开/);
    await r.conn.closed;
    expect(partsIn(r.root).map(p => p.size)).toEqual([size]);                  // 一块都没多写
    await expectNotComplete(r.root, r.local, sid, name, data.length);
  });

  it('监听方已暂停：清单、送块、取块一律回 ATT_PAUSED，一块都不多写、一个字节都不给；恢复后从断点续传完成', async () => {
    const r = await rig();
    const data = makePng(600_000, 19).buf; const name = 'paste-9-99999999.png'; const sha = sha256Of(data);
    const mine = makePng(5000, 20).buf;
    const sid = await pushSession(r.conn, [name]);
    const own = await newSession(r.local, '引擎自己的附件');
    await seedFile(r.local, r.root, own, 'real.png', mine, 'image/png');
    expect((await itemOf(r.local, own, 'real.png'))?.state).toBe('ready');
    await manifest(r.conn, sid, [entry(name, data)]);
    await put(r.conn, sid, name, sha, 0, chunkAt(data, 0));
    await r.local.call('control.pause');
    expect(await errOf(manifest(r.conn, sid, [entry(name, data)]))).toBe('ATT_PAUSED');
    expect(await errOf(put(r.conn, sid, name, sha, CHUNK, chunkAt(data, CHUNK)))).toBe('ATT_PAUSED');
    expect(await errOf(r.conn.call('sync.att.get', { v: 1, sessionId: own, name: 'real.png', sha256: sha256Of(mine), offset: 0 }))).toBe('ATT_PAUSED');
    expect(partsIn(r.root).map(p => p.size)).toEqual([CHUNK]);                  // 暂停之后一块都没多写
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    expect((await itemOf(r.local, sid, name))?.state).toBe('paused');
    await r.local.call('control.resume');
    expect((await manifest(r.conn, sid, [entry(name, data)])).want).toEqual([{ name, sha256: sha, offset: CHUNK }]);
    expect((await putAll(r.conn, sid, name, data, sha, CHUNK)).done).toBe(true);
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha);
    const ok = await r.conn.call('sync.att.get', { v: 1, sessionId: own, name: 'real.png', sha256: sha256Of(mine), offset: 0 });
    expect(sha256Of(Buffer.from(ok.data, 'base64'))).toBe(sha256Of(mine));
  });

  it('用户取消（监听方在收）：之后的块被拒、暂存已删、状态「未下载」；清单得到 held；点下载后从头传完', async () => {
    const r = await rig();
    const data = makePng(600_000, 15).buf; const name = 'paste-6-66666666.png'; const sha = sha256Of(data);
    const sid = await pushSession(r.conn, [name]);
    await manifest(r.conn, sid, [entry(name, data)]);
    await put(r.conn, sid, name, sha, 0, chunkAt(data, 0));
    expect((await itemOf(r.local, sid, name))?.state).toBe('transferring');
    expect(await r.local.call('attachments.cancel', { sessionId: sid, name })).toEqual({ ok: true });
    expect(await errOf(put(r.conn, sid, name, sha, CHUNK, chunkAt(data, CHUNK)))).toBe('ATT_CANCELLED');
    expect(partsIn(r.root)).toEqual([]);
    expect(await itemOf(r.local, sid, name)).toMatchObject({ state: 'held', canRetry: true });
    expect((await manifest(r.conn, sid, [entry(name, data)])).rejected).toEqual([{ index: 0, code: 'held' }]);
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    expect((await r.local.call('attachments.retry', { sessionId: sid, name })).started).toBe(true);
    expect((await manifest(r.conn, sid, [entry(name, data)])).want).toEqual([{ name, sha256: sha, offset: 0 }]);
    expect((await putAll(r.conn, sid, name, data)).done).toBe(true);
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha);
  });

  it('两个对端同时推同一份内容：第二个得到 busy，最终只有一份正确的文件', async () => {
    const r = await rig();
    const second = new RawPeer();
    cleanups.push(() => second.dispose());
    await second.pair(r.local, r.port);
    const conn2 = await second.connect();
    await conn2.hello(CAPS);
    const data = makePng(600_000, 16).buf; const name = 'paste-7-77777777.png'; const sha = sha256Of(data);
    const sid = await pushSession(r.conn, [name]);
    expect((await manifest(r.conn, sid, [entry(name, data)])).want).toHaveLength(1);
    await put(r.conn, sid, name, sha, 0, chunkAt(data, 0));
    const m2 = await manifest(conn2, sid, [entry(name, data)]);
    expect(m2.want).toEqual([]);
    expect(m2.rejected).toEqual([{ index: 0, code: 'busy' }]);
    expect(await errOf(put(conn2, sid, name, sha, CHUNK, chunkAt(data, CHUNK)))).toBe('ATT_NO_TRANSFER');   // 票不是它的
    expect((await putAll(r.conn, sid, name, data, sha, CHUNK)).done).toBe(true);
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha);
    expect(partsIn(r.root)).toEqual([]);
  });
});
