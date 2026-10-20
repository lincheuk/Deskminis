/**
 * F11A · 附件接收器（设计 §4.4）。真实临时目录、真实 sqlite、真实存储层；块长注入成 1024 让用例小而快。
 *
 * 钉住的行为（任务卡验收 2、阻断 3）：
 *   ① 未完成的字节只在 sync-incoming/ 的 .part 里；收满后先整文件校验、再不覆盖地发布，校验不过不发布且删暂存。
 *   ② 重复块不写盘；偏移不对、块长不对一律拒绝；任何写入都不可能越过声明长度。
 *   ③ 一个内容键一张票；正在提交的票不能接管，但它活不过那次提交（try / finally）。
 *   ④ 提交前与每个目标发布前都过 publishBlock：暂停、取消配对、关停之后不发布，暂存保留，之后可直接续上。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { MinisPaths } from '../src/minisd/paths';
import { AttachmentStore } from '../src/minisd/sync/attachments/store';
import { AttachmentReceiver } from '../src/minisd/sync/attachments/receiver';
import { createAttachmentIo, type AttachmentIo } from '../src/minisd/sync/attachments/io';
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from '../src/minisd/sync/attachments/limits';
import { AttError, type AttErrorCode } from '../src/minisd/sync/attachments/wire';
import { incomingFiles, makeGate, makePng, sha256File, sha256Of, type Gate } from './att-util';

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '22222222-3333-4444-8555-666666666666';
const A = 'peer-a'; const B = 'peer-b';
const CHUNK = 1024;

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dbs.splice(0)) { try { d.close(); } catch { /* 已关 */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
});

interface Fx {
  root: string; db: Database.Database; store: AttachmentStore; recv: AttachmentReceiver;
  clock: { t: number }; block: { code: AttErrorCode | undefined };
  paired: Set<string>; online: Set<string>; changed: string[];
  gates: { verify: Gate; copy: Gate }; copyError: { on: boolean };
  bucket(sid?: string): string; part(data: Buffer): string;
  /** 建好引用并受理一份声明，返回这份内容的 sha256。 */
  want(name: string, data: Buffer, sid?: string): Promise<string>;
}

function setup(limits: Partial<AttachmentLimits> = {}): Fx {
  const root = mkdtempSync(join(tmpdir(), 'f11a-recv-'));
  dirs.push(root);
  const db = openDb(join(root, 'minis.db'));
  dbs.push(db);
  for (const sid of [SID, SID2]) db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)').run(sid, 't');
  const paths = new MinisPaths(root);
  const lim = { ...DEFAULT_ATTACHMENT_LIMITS, chunkBytes: CHUNK, ...limits };
  const base = createAttachmentIo();
  const gates = { verify: makeGate(), copy: makeGate() };
  const copyError = { on: false };
  const io: AttachmentIo = {
    verify: async (p, s, n) => { await gates.verify.wait(); return base.verify(p, s, n); },
    hash: base.hash,
    copy: async (s, d) => { await gates.copy.wait(); if (copyError.on) throw new Error('注入的未预期异常'); return base.copy(s, d); },
    publish: base.publish,
  };
  const clock = { t: 1_000_000 };
  const block: Fx['block'] = { code: undefined };
  const paired = new Set([A, B]); const online = new Set([A, B]);
  const changed: string[] = [];
  const store = new AttachmentStore(db, root, paths, lim, io, () => clock.t, {
    onChanged: () => { /* 存储层的变化通知这里不关心 */ }, onLocalMissing: () => { /* 同上 */ }, publishBlock: () => block.code,
    sessionExists: sid => db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sid) !== undefined,
  });
  const recv = new AttachmentReceiver(store, lim, io, {
    now: () => clock.t, isPaired: fp => paired.has(fp), peerOnline: fp => online.has(fp),
    publishBlock: () => block.code, onChanged: sid => { changed.push(sid); },
  });
  let seq = 0;
  return {
    root, db, store, recv, clock, block, paired, online, changed, gates, copyError,
    bucket: (sid = SID) => paths.sessionBucket(sid, 'attachments'),
    part: data => store.partPath(sha256Of(data), data.length),
    async want(name, data, sid = SID) {
      const parts = JSON.stringify([{ type: 'mediaRef', value: { id: `m${seq}`, relativePath: `attachments/${name}`, mimeType: 'image/png' } }]);
      db.prepare('INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`msg-${sid}-${seq}`, sid, 'user', parts, seq, seq, seq);
      seq++;
      store.markDirty(sid);
      await store.ensureIndexed(sid);
      const r = await store.acceptRemote(sid, { name, size: data.length, sha256: sha256Of(data), mimeType: 'image/png' }, A);
      if (r.action !== 'want') throw new Error(`期望 want，实际 ${JSON.stringify(r)}`);
      return sha256Of(data);
    },
  };
}

const chunkOf = (data: Buffer, i: number): Buffer => data.subarray(i * CHUNK, Math.min(data.length, (i + 1) * CHUNK));

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { return e instanceof AttError ? e.message : `非 AttError: ${String(e)}`; }
  return '没有抛错';
}

/** 把整份内容按序写进去；返回最后一次 write 的结果。 */
async function writeAll(f: Fx, data: Buffer, owner = A, role: 'get' | 'put' = 'put', from = 0) {
  const sha = sha256Of(data);
  let last = { offset: from, done: false };
  for (let off = from; off < data.length; off += CHUNK) last = await f.recv.write(sha, data.length, off, data.subarray(off, Math.min(data.length, off + CHUNK)), owner, role);
  return last;
}

describe('F11A 接收器：begin', () => {
  it('没有暂存从 0 开始；半块截到块界；超长的暂存删掉；收满的暂存返回 size', async () => {
    const f = setup();
    const data = makePng(3000, 1).buf;
    const sha = await f.want('a.png', data);
    expect(f.recv.begin(sha, 3000, A, 'put')).toEqual({ offset: 0 });
    f.recv.release(sha, 3000, A, 'put', { deletePart: false });

    mkdirSync(join(f.root, 'sync-incoming'), { recursive: true });
    writeFileSync(f.part(data), data.subarray(0, CHUNK + 300));          // 一块半
    expect(f.recv.begin(sha, 3000, A, 'put')).toEqual({ offset: CHUNK });
    expect(statSync(f.part(data)).size).toBe(CHUNK);
    f.recv.release(sha, 3000, A, 'put', { deletePart: false });

    writeFileSync(f.part(data), Buffer.alloc(3001));                      // 比声明的还长
    expect(f.recv.begin(sha, 3000, A, 'put')).toEqual({ offset: 0 });
    expect(existsSync(f.part(data))).toBe(false);
    f.recv.release(sha, 3000, A, 'put', { deletePart: false });

    writeFileSync(f.part(data), data);
    expect(f.recv.begin(sha, 3000, A, 'put')).toEqual({ offset: 3000 });
    expect(f.recv.progress(sha, 3000)).toMatchObject({ received: 3000, owner: A, role: 'put' });
  });

  it('一个内容键一张票：别的传输拿不到（ATT_BUSY）；同主沿用；空闲超时、票主已取消配对、票主离线时可接管', async () => {
    const f = setup({ recvIdleMs: 500 });
    const data = makePng(3000, 2).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    expect(await codeOf(() => f.recv.begin(sha, 3000, B, 'put'))).toBe('ATT_BUSY');
    expect(await codeOf(() => f.recv.begin(sha, 3000, A, 'get'))).toBe('ATT_BUSY');   // 同一对端、另一个方向
    expect(f.recv.begin(sha, 3000, A, 'put')).toEqual({ offset: CHUNK });             // 同主沿用，重读磁盘

    f.clock.t += 499;
    expect(await codeOf(() => f.recv.begin(sha, 3000, B, 'put'))).toBe('ATT_BUSY');
    f.clock.t += 1;
    expect(f.recv.begin(sha, 3000, B, 'put')).toEqual({ offset: CHUNK });             // 空闲到点：接管并续传
    expect(f.recv.progress(sha, 3000)).toMatchObject({ owner: B, role: 'put' });
    expect(await codeOf(f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put'))).toBe('ATT_NO_TRANSFER');   // 旧票主的块不再收

    f.paired.delete(B);
    expect(f.recv.begin(sha, 3000, A, 'get')).toEqual({ offset: CHUNK });             // 票主已取消配对
    f.online.delete(A);
    expect(f.recv.begin(sha, 3000, B, 'put')).toEqual({ offset: CHUNK });             // 票主那个方向的连接不在了
  });
});

describe('F11A 接收器：write', () => {
  it('按序写满 → 校验 → 发布：文件出现在附件桶、哈希相等、暂存与票都没了', async () => {
    const f = setup();
    const data = makePng(3000, 3).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    expect(await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put')).toEqual({ offset: CHUNK, done: false });
    // 附件桶里从不出现部分文件
    expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
    expect(await f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put')).toEqual({ offset: 2 * CHUNK, done: false });
    expect(await f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(data, 2), A, 'put')).toEqual({ offset: 3000, done: true });
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha);
    expect(f.store.get(SID, 'a.png')!.state).toBe('present');
    expect(incomingFiles(f.root)).toEqual([]);
    expect(f.recv.progress(sha, 3000)).toBeUndefined();
    expect(f.changed).toContain(SID);
    // 收满之后再来一块：票已撤
    expect(await codeOf(f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(data, 2), A, 'put'))).toBe('ATT_NO_TRANSFER');
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha);
  });

  it('没有票、票主或方向不符 → ATT_NO_TRANSFER；偏移不在块界 → ATT_BAD_CHUNK', async () => {
    const f = setup();
    const data = makePng(3000, 4).buf;
    const sha = await f.want('a.png', data);
    expect(await codeOf(f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put'))).toBe('ATT_NO_TRANSFER');
    f.recv.begin(sha, 3000, A, 'put');
    expect(await codeOf(f.recv.write(sha, 3000, 0, chunkOf(data, 0), B, 'put'))).toBe('ATT_NO_TRANSFER');
    expect(await codeOf(f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'get'))).toBe('ATT_NO_TRANSFER');
    expect(await codeOf(f.recv.write(sha, 3000, 7, chunkOf(data, 0), A, 'put'))).toBe('ATT_BAD_CHUNK');
    expect(incomingFiles(f.root)).toEqual([]);
  });

  it('重复块不写盘、偏移不前进；跳块 → ATT_OFFSET expected=<已收>；块长不对 → ATT_BAD_CHUNK，暂存不动', async () => {
    const f = setup();
    const data = makePng(3000, 5).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    const before = readFileSync(f.part(data));
    // 同一块再来一次（内容换成别的也不会被写进去）
    expect(await f.recv.write(sha, 3000, 0, Buffer.alloc(CHUNK, 9), A, 'put')).toEqual({ offset: CHUNK, done: false });
    expect(readFileSync(f.part(data)).equals(before)).toBe(true);
    expect(await codeOf(f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(data, 2), A, 'put'))).toBe(`ATT_OFFSET expected=${CHUNK}`);
    expect(await codeOf(f.recv.write(sha, 3000, CHUNK, data.subarray(CHUNK, CHUNK + 100), A, 'put'))).toBe('ATT_BAD_CHUNK');       // 短了
    expect(await codeOf(f.recv.write(sha, 3000, CHUNK, Buffer.alloc(CHUNK + 1), A, 'put'))).toBe('ATT_BAD_CHUNK');                 // 长了
    expect(await codeOf(f.recv.write(sha, 3000, 2 * CHUNK, Buffer.alloc(CHUNK), A, 'put'))).toBe(`ATT_OFFSET expected=${CHUNK}`);  // 末块给整块也先撞偏移
    expect(readFileSync(f.part(data)).equals(before)).toBe(true);
    // 末块必须恰为剩余长度：给一整块会越过声明长度，拒收
    await f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put');
    expect(await codeOf(f.recv.write(sha, 3000, 2 * CHUNK, Buffer.alloc(CHUNK), A, 'put'))).toBe('ATT_BAD_CHUNK');
    expect(statSync(f.part(data)).size).toBe(2 * CHUNK);
    expect((await f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(data, 2), A, 'put')).done).toBe(true);
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha);
  });

  it('暂存文件被别的东西动过（长度对不上）：整份作废，删暂存、撤票，ATT_OFFSET expected=0', async () => {
    const f = setup();
    const data = makePng(3000, 6).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    writeFileSync(f.part(data), Buffer.alloc(CHUNK + 5));
    expect(await codeOf(f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put'))).toBe('ATT_OFFSET expected=0');
    expect(existsSync(f.part(data))).toBe(false);
    expect(f.recv.progress(sha, 3000)).toBeUndefined();
  });
});

describe('F11A 接收器：提交', () => {
  it('未校验不发布：校验的闸门没放行时最终路径不存在、行不是 present；放行后才出现', async () => {
    const f = setup();
    const data = makePng(3000, 10).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    await f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put');
    f.gates.verify.close();
    const last = f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(data, 2), A, 'put');
    await f.gates.verify.entered();
    expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
    expect(f.store.get(SID, 'a.png')!.state).toBe('missing');
    // 正在提交的票不能接管，也不收块
    expect(await codeOf(() => f.recv.begin(sha, 3000, B, 'put'))).toBe('ATT_BUSY');
    expect(await codeOf(f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put'))).toBe('ATT_NO_TRANSFER');
    f.gates.verify.release();
    expect(await last).toEqual({ offset: 3000, done: true });
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha);
  });

  it('损坏：整文件校验不过 → ATT_HASH，不发布、删暂存；第一次之后行仍 missing，再坏一次 → failed/hash_mismatch', async () => {
    const f = setup();
    const data = makePng(3000, 11).buf;
    const sha = await f.want('a.png', data);
    const bad = Buffer.from(data); bad[2999] ^= 0xff;                     // 最后一块翻转一个字节
    for (const round of [1, 2]) {
      f.recv.begin(sha, 3000, A, 'put');
      await f.recv.write(sha, 3000, 0, chunkOf(bad, 0), A, 'put');
      await f.recv.write(sha, 3000, CHUNK, chunkOf(bad, 1), A, 'put');
      expect(await codeOf(f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(bad, 2), A, 'put')), `第 ${round} 次`).toBe('ATT_HASH');
      expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
      expect(incomingFiles(f.root)).toEqual([]);
      expect(f.recv.progress(sha, 3000)).toBeUndefined();
      if (round === 1) expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', attempts: 1 });
    }
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'failed', failCode: 'hash_mismatch' });
  });

  it('提交前被挡（已暂停 / 已取消配对 / 已关停）：不发布、暂存保留、票已撤；放开后同一内容从暂存直接走校验与发布', async () => {
    for (const code of ['ATT_PAUSED', 'ATT_CANCELLED', 'ATT_STOPPING'] as const) {
      const f = setup();
      const data = makePng(3000, 12).buf;
      const sha = await f.want('a.png', data);
      f.recv.begin(sha, 3000, A, 'put');
      await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
      await f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put');
      f.gates.verify.close();
      const last = f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(data, 2), A, 'put');
      await f.gates.verify.entered();
      f.block.code = code;                                                // 最后一块送达之后、校验途中发生
      f.gates.verify.release();
      expect(await codeOf(last), code).toBe(code);
      expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
      expect(incomingFiles(f.root)).toEqual([`${sha}.3000.part`]);
      expect(statSync(f.part(data)).size).toBe(3000);
      expect(f.recv.progress(sha, 3000)).toBeUndefined();
      f.block.code = undefined;
      expect(f.recv.begin(sha, 3000, B, 'put')).toEqual({ offset: 3000 });   // 不回 ATT_BUSY
      await f.recv.finish(sha, 3000, B, 'put');
      expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha);
      expect(incomingFiles(f.root)).toEqual([]);
    }
  });

  it('提交后半段中止（闸门挂在发布阶段的 io.copy 上）：票不泄漏、没有 .stage、暂存是完整长度', async () => {
    const f = setup();
    const data = makePng(3000, 13).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    await f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put');
    f.gates.copy.close();
    const last = f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(data, 2), A, 'put');
    await f.gates.copy.entered();
    f.block.code = 'ATT_PAUSED';
    f.gates.copy.release();
    expect(await codeOf(last)).toBe('ATT_PAUSED');
    expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
    expect(incomingFiles(f.root)).toEqual([`${sha}.3000.part`]);
    expect(f.recv.progress(sha, 3000)).toBeUndefined();
    expect(f.store.get(SID, 'a.png')!.state).toBe('missing');
    f.block.code = undefined;
    expect(f.recv.begin(sha, 3000, A, 'put')).toEqual({ offset: 3000 });
    await f.recv.finish(sha, 3000, A, 'put');
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha);
  });

  it('提交途中 io.copy 抛未预期的异常：对外是 ATT_IO，票已撤、没有 .stage，随后的 begin 成功', async () => {
    const f = setup();
    const data = makePng(3000, 14).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    f.copyError.on = true;
    expect(await codeOf(writeAll(f, data))).toBe('ATT_IO');
    expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
    expect(incomingFiles(f.root).filter(n => n.endsWith('.stage'))).toEqual([]);
    expect(f.recv.progress(sha, 3000)).toBeUndefined();
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'failed', failCode: 'io_error' });
    f.copyError.on = false;
    f.store.retry(SID, 'a.png');
    expect(f.recv.begin(sha, 3000, A, 'put')).toEqual({ offset: 3000 });   // 暂存保留，重试不用重传
    await f.recv.finish(sha, 3000, A, 'put');
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha);
  });

  it('校验途中被用户取消（没有目标了）→ ATT_CANCELLED，不发布，删暂存', async () => {
    const f = setup();
    const data = makePng(3000, 15).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    await f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put');
    f.gates.verify.close();
    const last = f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(data, 2), A, 'put');
    await f.gates.verify.entered();
    f.store.hold(SID, 'a.png');
    f.gates.verify.release();
    expect(await codeOf(last)).toBe('ATT_CANCELLED');
    expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
    expect(incomingFiles(f.root)).toEqual([]);
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', want: false });
  });

  it('多目标：两个会话引用同一份内容，一次传输，两个桶里各发布一份', async () => {
    const f = setup();
    const data = makePng(3000, 16).buf;
    const sha = await f.want('a.png', data, SID);
    // 第二个会话引用同一份内容：本机还没有完成文件，去重用不上，仍是 want
    await f.want('b.png', data, SID2);
    f.recv.begin(sha, 3000, A, 'put');
    expect((await writeAll(f, data)).done).toBe(true);
    expect(sha256File(join(f.bucket(SID), 'a.png'))).toBe(sha);
    expect(sha256File(join(f.bucket(SID2), 'b.png'))).toBe(sha);
    expect(f.store.get(SID, 'a.png')!.state).toBe('present');
    expect(f.store.get(SID2, 'b.png')!.state).toBe('present');
    expect(incomingFiles(f.root)).toEqual([]);
  });

  it('多目标、提交途中其中一个会话被删：那一个不发布，另一个照常发布（不因为它整份中止）', async () => {
    const f = setup();
    const data = makePng(3000, 19).buf;
    const sha = await f.want('a.png', data, SID);
    await f.want('b.png', data, SID2);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    await f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put');
    f.gates.copy.close();
    const last = f.recv.write(sha, 3000, 2 * CHUNK, chunkOf(data, 2), A, 'put');
    await f.gates.copy.entered();                                         // 目标已经取好，第一个目标（SID）停在复制之前
    // chat.sessions.delete 的效果：消息行与会话行没了，没有人调 markDirty
    f.db.prepare('DELETE FROM messages WHERE session_id=?').run(SID);
    f.db.prepare('DELETE FROM sessions WHERE id=?').run(SID);
    f.gates.copy.release();
    expect(await last).toEqual({ offset: 3000, done: true });
    expect(existsSync(join(f.bucket(SID), 'a.png'))).toBe(false);
    expect(f.store.get(SID, 'a.png')!.state).toBe('missing');
    expect(sha256File(join(f.bucket(SID2), 'b.png'))).toBe(sha);
    expect(f.store.get(SID2, 'b.png')!.state).toBe('present');
    expect(incomingFiles(f.root)).toEqual([]);
    expect(f.recv.progress(sha, 3000)).toBeUndefined();
  });

  it('发布时最终名字被占（传输途中出现了别的内容）：不覆盖，行 failed/name_conflict', async () => {
    const f = setup();
    const data = makePng(3000, 17).buf; const other = makePng(2800, 18).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    mkdirSync(f.bucket(), { recursive: true });
    writeFileSync(join(f.bucket(), 'a.png'), other);
    await codeOf(writeAll(f, data, A, 'put', CHUNK));
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha256Of(other));
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'failed', failCode: 'name_conflict' });
    expect(incomingFiles(f.root)).toEqual([]);
    expect(f.recv.progress(sha, 3000)).toBeUndefined();
  });
});

describe('F11A 接收器：release / dropIfUnwanted / 空闲计时 / stop', () => {
  it('release 只撤自己的票：票属于别人时不撤票、不删暂存', async () => {
    const f = setup();
    const data = makePng(3000, 20).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    f.recv.release(sha, 3000, B, 'put', { deletePart: true });
    f.recv.release(sha, 3000, A, 'get', { deletePart: true });
    expect(f.recv.progress(sha, 3000)).toMatchObject({ owner: A, received: CHUNK });
    expect(statSync(f.part(data)).size).toBe(CHUNK);
    f.recv.release(sha, 3000, A, 'put', { deletePart: false });
    expect(f.recv.progress(sha, 3000)).toBeUndefined();
    expect(statSync(f.part(data)).size).toBe(CHUNK);
    f.recv.release(sha, 3000, A, 'put', { deletePart: true });     // 此刻没有票：删暂存
    expect(existsSync(f.part(data))).toBe(false);
  });

  it('dropIfUnwanted：还有要取的行（另一个会话）时票与暂存都不动；没有了才撤票删暂存', async () => {
    const f = setup();
    const data = makePng(3000, 21).buf;
    const sha = await f.want('a.png', data, SID);
    await f.want('b.png', data, SID2);
    f.recv.begin(sha, 3000, A, 'get');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'get');
    f.store.hold(SID, 'a.png');
    f.recv.dropIfUnwanted(sha, 3000);
    expect(f.recv.progress(sha, 3000)).toMatchObject({ received: CHUNK });
    expect(statSync(f.part(data)).size).toBe(CHUNK);
    f.store.hold(SID2, 'b.png');
    f.recv.dropIfUnwanted(sha, 3000);
    expect(f.recv.progress(sha, 3000)).toBeUndefined();
    expect(existsSync(f.part(data))).toBe(false);
  });

  it('dropIfUnwanted：票正在提交时不动', async () => {
    const f = setup();
    const data = makePng(2000, 22).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 2000, A, 'put');
    await f.recv.write(sha, 2000, 0, chunkOf(data, 0), A, 'put');
    f.gates.verify.close();
    const last = f.recv.write(sha, 2000, CHUNK, chunkOf(data, 1), A, 'put');
    await f.gates.verify.entered();
    f.store.hold(SID, 'a.png');
    f.recv.dropIfUnwanted(sha, 2000);
    expect(f.recv.progress(sha, 2000)).toBeDefined();
    expect(existsSync(f.part(data))).toBe(true);
    f.gates.verify.release();
    expect(await codeOf(last)).toBe('ATT_CANCELLED');       // 提交自己发现没有目标并收尾
    expect(incomingFiles(f.root)).toEqual([]);
  });

  it('票的空闲计时：到点通知一次（界面不会停在「传输中」）；有新块就顺延；撤票后不再触发', async () => {
    vi.useFakeTimers();
    const f = setup({ recvIdleMs: 300 });
    const data = makePng(3000, 23).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    f.changed.length = 0;
    f.clock.t += 200; await vi.advanceTimersByTimeAsync(200);
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');      // 第 200ms 来了一块
    f.changed.length = 0;
    f.clock.t += 100; await vi.advanceTimersByTimeAsync(100);           // 第 300ms：计时器到点，但距上一块才 100ms
    expect(f.changed).toEqual([]);
    f.clock.t += 200; await vi.advanceTimersByTimeAsync(200);           // 第 500ms：距上一块 300ms
    expect(f.changed).toEqual([SID]);
    f.clock.t += 1000; await vi.advanceTimersByTimeAsync(1000);
    expect(f.changed).toEqual([SID]);                                   // 只通知一次；票还在，等别人接管
    expect(f.recv.progress(sha, 3000)).toBeDefined();

    f.recv.begin(sha, 3000, B, 'put');                                  // 接管，重新计时
    f.recv.release(sha, 3000, B, 'put', { deletePart: false });
    f.changed.length = 0;
    f.clock.t += 1000; await vi.advanceTimersByTimeAsync(1000);
    expect(f.changed).toEqual([]);
  });

  it('stop()：撤掉全部票、保留暂存；此后 begin / write / finish 一律 ATT_STOPPING', async () => {
    const f = setup();
    const data = makePng(3000, 24).buf;
    const sha = await f.want('a.png', data);
    f.recv.begin(sha, 3000, A, 'put');
    await f.recv.write(sha, 3000, 0, chunkOf(data, 0), A, 'put');
    f.recv.stop();
    expect(f.recv.progress(sha, 3000)).toBeUndefined();
    expect(statSync(f.part(data)).size).toBe(CHUNK);
    expect(await codeOf(() => f.recv.begin(sha, 3000, A, 'put'))).toBe('ATT_STOPPING');
    expect(await codeOf(f.recv.write(sha, 3000, CHUNK, chunkOf(data, 1), A, 'put'))).toBe('ATT_STOPPING');
    expect(await codeOf(f.recv.finish(sha, 3000, A, 'put'))).toBe('ATT_STOPPING');
    expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
  });
});
