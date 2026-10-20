/**
 * F11A · 附件索引与落盘（设计 §4.1–§4.5、§4.9「重启」）。真实临时目录加真实 sqlite，不接网络。
 *
 * 钉住的行为：
 *   ① 只登记被本机消息引用到的名字；登记先算整文件哈希；旧式名字不做回填直接登记。
 *   ② 受理对端 manifest：未引用不建行；本机已有同名未登记文件回 busy；同名不同内容不覆盖绑定。
 *   ③ 发布不覆盖：最终名字被占时比较内容；硬链接不可用走「确认不存在再改名」。
 *   ④ 发送源只读「已登记、仍被引用、内容与登记相符」的文件；桶目录被换成 junction 时拒绝；
 *      名字是符号链接时不算普通文件（真实链接的用例在没有建链接权限的机器上跳过，lstat 这一支另见 att-store-lstat.test.ts）；
 *      会话被删之后（删除不经 markDirty）引用当场为空：不再送出、不再是发布目标。
 *   ⑤ 启动自检：清 .stage、清无主或过期的 .part、清已不存在的会话的行（不删附件桶里的文件）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { MinisPaths } from '../src/minisd/paths';
import { dataGate } from '../src/minisd/tools/data-gate';
import { AttachmentStore, type AttachmentStoreDeps } from '../src/minisd/sync/attachments/store';
import { createAttachmentIo, removeFileQuiet, retryBusySync, type AttachmentIo } from '../src/minisd/sync/attachments/io';
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from '../src/minisd/sync/attachments/limits';
import { AttError, type AttErrorCode } from '../src/minisd/sync/attachments/wire';
import { incomingFiles, makeGate, makePng, randomBytesSeeded, sha256File, sha256Of } from './att-util';

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '22222222-3333-4444-8555-666666666666';
const FP = 'peer-fp-a';

interface Fixture {
  root: string; db: Database.Database; store: AttachmentStore; io: AttachmentIo;
  changed: string[]; localMissing: string[]; audits: Array<{ event: string; payload: Record<string, unknown> }>;
  hashCalls: string[]; clock: { t: number }; block: { code: AttErrorCode | undefined };
  bucket(sid?: string): string;
  put(name: string, data: Buffer, sid?: string): string;
  ref(name: string, sid?: string, mime?: string): void;
  rawRef(relativePath: unknown, sid?: string): void;
}

/** 这台机器能不能建文件符号链接（Windows 上要管理员或开发者模式）。不能时相关用例明确记成跳过，不算通过。 */
const canSymlinkFile = ((): boolean => {
  const d = mkdtempSync(join(tmpdir(), 'f11a-symprobe-'));
  try { writeFileSync(join(d, 't'), 'x'); symlinkSync(join(d, 't'), join(d, 'l'), 'file'); return true; }
  catch { return false; }
  finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
})();

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) { try { d.close(); } catch { /* 已关 */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 被占用时留给系统清 */ } }
});

function setup(opts: { limits?: Partial<AttachmentLimits>; io?: Partial<AttachmentIo>; sessions?: string[] } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'f11a-store-'));
  dirs.push(root);
  const db = openDb(join(root, 'minis.db'));
  dbs.push(db);
  for (const sid of opts.sessions ?? [SID, SID2]) {
    db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)').run(sid, 't');
  }
  const paths = new MinisPaths(root);
  const hashCalls: string[] = [];
  const base = createAttachmentIo();
  const io: AttachmentIo = {
    verify: opts.io?.verify ?? base.verify,
    hash: async p => { hashCalls.push(p); return (opts.io?.hash ?? base.hash)(p); },
    copy: opts.io?.copy ?? base.copy,
    publish: opts.io?.publish ?? base.publish,
  };
  const changed: string[] = []; const localMissing: string[] = [];
  const audits: Fixture['audits'] = [];
  const clock = { t: Date.now() };
  const block: Fixture['block'] = { code: undefined };
  const deps: AttachmentStoreDeps = {
    onChanged: sid => { changed.push(sid); },
    onLocalMissing: sid => { localMissing.push(sid); },
    // 与装配处同一口径：会话行在不在
    sessionExists: sid => db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sid) !== undefined,
    publishBlock: () => block.code,
    audit: (event, payload) => { audits.push({ event, payload }); },
  };
  const store = new AttachmentStore(db, root, paths, { ...DEFAULT_ATTACHMENT_LIMITS, ...opts.limits }, io, () => clock.t, deps);
  let seq = 0;
  const bucket = (sid = SID): string => paths.sessionBucket(sid, 'attachments');
  const rawRef = (relativePath: unknown, sid = SID, mime = 'image/png'): void => {
    const parts = JSON.stringify([{ type: 'text', value: 'x' }, { type: 'mediaRef', value: { id: `m${seq}`, relativePath, mimeType: mime } }]);
    db.prepare('INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`msg-${sid}-${seq}`, sid, 'user', parts, seq, seq, seq);
    seq++;
    store.markDirty(sid);
  };
  return {
    root, db, store, io, changed, localMissing, audits, hashCalls, clock, block, bucket,
    put(name, data, sid = SID) { mkdirSync(bucket(sid), { recursive: true }); const p = join(bucket(sid), name); writeFileSync(p, data); return p; },
    ref(name, sid = SID, mime = 'image/png') { rawRef(`attachments/${name}`, sid, mime); },
    rawRef,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return e instanceof AttError ? e.code : `非 AttError: ${String(e)}`; }
  return '没有抛错';
}

const wire = (name: string, data: Buffer, mime = 'image/png') => ({ name, size: data.length, sha256: sha256Of(data), mimeType: mime });

describe('F11A 存储层：引用', () => {
  it('只认 attachments/<合法名字> 的 mediaRef；不合规的引用单列；markDirty 使缓存失效', () => {
    const f = setup();
    f.ref('paste-1.png');
    f.ref('paste-1.png');                       // 同名多次引用合成一项
    f.ref('Doc.docx', SID, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    f.rawRef('attachments/../../../evil.png');
    f.rawRef('C:\\Users\\x\\secret.txt');
    f.rawRef(42);
    f.db.prepare(`INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES ('bad', ?, 'user', '{"mediaRef" 坏 JSON', 9, 9, 9)`).run(SID);
    f.store.markDirty(SID);
    const refs = f.store.referenced(SID);
    expect([...refs.keys()].sort()).toEqual(['doc.docx', 'paste-1.png']);
    expect(refs.get('doc.docx')).toMatchObject({ name: 'Doc.docx', relativePath: 'attachments/Doc.docx' });
    expect(f.store.invalidRefs(SID).map(r => r.relativePath).sort()).toEqual(['', 'C:\\Users\\x\\secret.txt', 'attachments/../../../evil.png'].sort());
    expect(f.store.referenced(SID2).size).toBe(0);
    // 缓存：不 markDirty 看不到新消息；markDirty 之后看得到
    f.db.prepare(`INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES ('late', ?, 'user', ?, 10, 10, 10)`)
      .run(SID, JSON.stringify([{ type: 'mediaRef', value: { id: 'z', relativePath: 'attachments/late.png', mimeType: 'image/png' } }]));
    expect(f.store.referenced(SID).has('late.png')).toBe(false);
    f.store.markDirty(SID);
    expect(f.store.referenced(SID).has('late.png')).toBe(true);
  });
});

describe('F11A 存储层：本机登记', () => {
  it('旧式名字的已有文件直接登记成 present（不做回填、不改名）；没被引用的文件不登记', async () => {
    const f = setup();
    const png = makePng(5000, 1).buf;
    f.put('paste-1700000000000.png', png);
    f.put('screenshot-1.png', makePng(4000, 2).buf);    // 桶里有、没有消息引用（截屏）
    f.ref('paste-1700000000000.png');
    await f.store.ensureIndexed(SID);
    const row = f.store.get(SID, 'paste-1700000000000.png')!;
    expect(row).toMatchObject({ state: 'present', sha256: sha256Of(png), size: 5000, mimeType: 'image/png', want: true, attempts: 0 });
    expect(row.sourceFp).toBeUndefined();
    expect(row.statSize).toBe(5000);
    expect(f.store.list(SID).map(r => r.name)).toEqual(['paste-1700000000000.png']);
    expect(f.store.listPresent(SID).map(r => r.name)).toEqual(['paste-1700000000000.png']);
    expect(existsSync(join(f.bucket(), 'paste-1700000000000.png'))).toBe(true);
    // 快路径：没有 markDirty 就不再算哈希
    const n = f.hashCalls.length;
    await f.store.ensureIndexed(SID);
    expect(f.hashCalls.length).toBe(n);
  });

  it('超限文件记 failed/too_large（不算哈希、不进清单）；不存在、空文件、目录不建行', async () => {
    const f = setup({ limits: { maxFileBytes: 4096 } });
    f.put('big.png', randomBytesSeeded(4097, 3));
    f.put('empty.png', Buffer.alloc(0));
    mkdirSync(join(f.bucket(), 'dir.png'));
    for (const n of ['big.png', 'empty.png', 'dir.png', 'gone.png']) f.ref(n);
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'big.png')).toMatchObject({ state: 'failed', failCode: 'too_large', sha256: '', size: 4097 });
    for (const n of ['empty.png', 'dir.png', 'gone.png']) expect(f.store.get(SID, n), n).toBeUndefined();
    expect(f.hashCalls).toEqual([]);
    expect(f.store.listPresent(SID)).toEqual([]);
  });

  it('缺省上限：32 MiB + 1 的稀疏文件记 too_large', async () => {
    const f = setup();
    mkdirSync(f.bucket(), { recursive: true });
    const fd = openSync(join(f.bucket(), 'huge.png'), 'w');
    ftruncateSync(fd, DEFAULT_ATTACHMENT_LIMITS.maxFileBytes + 1);
    closeSync(fd);
    f.ref('huge.png');
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'huge.png')).toMatchObject({ state: 'failed', failCode: 'too_large', size: DEFAULT_ATTACHMENT_LIMITS.maxFileBytes + 1 });
    expect(f.hashCalls).toEqual([]);
  });

  it('present 行：stat 变了内容没变只更新 stat；内容变了 → failed/local_changed；文件没了 → missing/local_missing 且只催一次', async () => {
    const f = setup();
    const a = makePng(3000, 4).buf; const b = makePng(3000, 5).buf; const c = makePng(3000, 6).buf;
    const pa = f.put('a.png', a); const pb = f.put('b.png', b); const pc = f.put('c.png', c);
    f.put('d.png', makePng(3000, 7).buf);
    for (const n of ['a.png', 'b.png', 'c.png', 'd.png']) f.ref(n);
    await f.store.ensureIndexed(SID);
    expect(f.store.list(SID).every(r => r.state === 'present')).toBe(true);

    utimesSync(pa, new Date(), new Date(Date.now() + 60_000));     // 只动修改时间
    writeFileSync(pb, makePng(3000, 50).buf);                       // 同长度、内容不同
    utimesSync(pb, new Date(), new Date(Date.now() + 120_000));
    rmSync(pc);
    writeFileSync(join(f.bucket(), 'd.png'), makePng(2999, 8).buf); // 长度都变了：不用算哈希
    f.hashCalls.length = 0;
    await f.store.ensureIndexed(SID, { force: true });
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'present', sha256: sha256Of(a) });
    expect(f.store.get(SID, 'b.png')).toMatchObject({ state: 'failed', failCode: 'local_changed', sha256: sha256Of(b) });
    expect(f.store.get(SID, 'c.png')).toMatchObject({ state: 'missing', failCode: 'local_missing', want: true, sha256: sha256Of(c) });
    expect(f.store.get(SID, 'd.png')).toMatchObject({ state: 'failed', failCode: 'local_changed' });
    expect(f.hashCalls.map(p => p.split(/[\\/]/).pop()).sort()).toEqual(['a.png', 'b.png']);
    expect(f.localMissing).toEqual([SID]);
    // a.png 的 stat 已更新：再来一次不重算
    f.hashCalls.length = 0;
    await f.store.ensureIndexed(SID, { force: true });
    expect(f.hashCalls.map(p => p.split(/[\\/]/).pop())).not.toContain('a.png');
    expect(f.localMissing).toEqual([SID]);     // 不重复触发
    // 被改动的行不再提供给其它设备
    expect(f.store.listPresent(SID).map(r => r.name)).toEqual(['a.png']);
    void pc;
  });

  it('failed/local_changed：文件恢复原样后只有 force 才重新核对并回到 present', async () => {
    const f = setup();
    const a = makePng(3000, 9).buf;
    const p = f.put('a.png', a); f.ref('a.png');
    await f.store.ensureIndexed(SID);
    writeFileSync(p, makePng(3000, 10).buf);
    utimesSync(p, new Date(), new Date(Date.now() + 60_000));
    await f.store.ensureIndexed(SID, { force: true });
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'failed', failCode: 'local_changed' });
    writeFileSync(p, a);
    f.store.markDirty(SID);
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'a.png')!.state).toBe('failed');
    await f.store.ensureIndexed(SID, { force: true });
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'present', sha256: sha256Of(a) });
    expect(f.store.get(SID, 'a.png')!.failCode).toBeUndefined();
  });

  it('missing 行：最终名字上出现同内容文件 → present（崩溃自愈）；内容不同 → failed/name_conflict', async () => {
    const f = setup();
    const a = makePng(3000, 11).buf; const b = makePng(3000, 12).buf;
    f.ref('a.png'); f.ref('b.png');
    await f.store.ensureIndexed(SID);
    expect((await f.store.acceptRemote(SID, wire('a.png', a), FP)).action).toBe('want');
    expect((await f.store.acceptRemote(SID, wire('b.png', b), FP)).action).toBe('want');
    f.put('a.png', a);
    f.put('b.png', makePng(3000, 13).buf);
    f.store.markDirty(SID);
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'present', sha256: sha256Of(a) });
    expect(f.store.get(SID, 'b.png')).toMatchObject({ state: 'failed', failCode: 'name_conflict', sha256: sha256Of(b) });
  });

  it('逐文件容错：读不了的名字本轮跳过、别的照常；下一次调用（不传 force）会再试', async () => {
    let busy = true;
    const base = createAttachmentIo();
    const f = setup({ io: { hash: async p => { if (busy && p.endsWith('locked.png')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return base.hash(p); } } });
    const ok = makePng(3000, 14).buf; const locked = makePng(3000, 15).buf;
    f.put('locked.png', locked); f.put('ok.png', ok);
    f.ref('locked.png'); f.ref('ok.png');
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'locked.png')).toBeUndefined();
    expect(f.store.get(SID, 'ok.png')!.state).toBe('present');
    busy = false;
    await f.store.ensureIndexed(SID);          // 没有记「已登记」，不走快路径
    expect(f.store.get(SID, 'locked.png')).toMatchObject({ state: 'present', sha256: sha256Of(locked) });
  });

  it('算哈希期间文件被改写：本轮不落行；下一轮登记到的是新内容', async () => {
    const gate = makeGate(true);
    const base = createAttachmentIo();
    const f = setup({ io: { hash: async p => { const r = await base.hash(p); await gate.wait(); return r; } } });
    const v1 = makePng(3000, 16).buf; const v2 = makePng(3100, 17).buf;
    const p = f.put('a.png', v1); f.ref('a.png');
    const run = f.store.ensureIndexed(SID);
    await gate.entered();
    writeFileSync(p, v2);
    gate.release();
    await run;
    expect(f.store.get(SID, 'a.png')).toBeUndefined();
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'present', sha256: sha256Of(v2), size: 3100 });
  });

  it('等哈希期间行被别人建了：按「有行」处理（相同置 present，不同置 name_conflict），不抛主键冲突', async () => {
    const gate = makeGate(true);
    const base = createAttachmentIo();
    const f = setup({ io: { hash: async p => { const r = await base.hash(p); await gate.wait(); return r; } } });
    const a = makePng(3000, 18).buf; const b = makePng(3000, 19).buf;
    f.put('a.png', a); f.put('b.png', b); f.ref('a.png'); f.ref('b.png');
    const ins = f.db.prepare(`INSERT INTO sync_attachments (session_id, name, sha256, size, mime_type, state, want, created_at, updated_at) VALUES (?, ?, ?, ?, 'image/png', 'missing', 1, 0, 0)`);
    const run = f.store.ensureIndexed(SID);
    await gate.entered();
    ins.run(SID, 'a.png', sha256Of(a), a.length);
    ins.run(SID, 'b.png', sha256Of(makePng(3000, 20).buf), 3000);
    gate.release();
    await run;
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'present', sha256: sha256Of(a) });
    expect(f.store.get(SID, 'b.png')).toMatchObject({ state: 'failed', failCode: 'name_conflict' });
  });

  it('A.png 与 a.png 落在同一行', async () => {
    const f = setup();
    const a = makePng(3000, 21).buf;
    f.put('A.png', a); f.ref('A.png');
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'a.png')).toMatchObject({ name: 'A.png', state: 'present' });
    expect(f.store.list(SID)).toHaveLength(1);
  });
});

describe('F11A 存储层：受理对端的 manifest', () => {
  it('未引用不建行；无行且本机没有文件 → 建 missing 行要字节；再来一次仍是 want', async () => {
    const f = setup();
    const a = makePng(3000, 30).buf;
    expect(await f.store.acceptRemote(SID, wire('a.png', a), FP)).toEqual({ action: 'reject', code: 'not_referenced' });
    expect(f.store.get(SID, 'a.png')).toBeUndefined();
    f.ref('a.png');
    await f.store.ensureIndexed(SID);
    const r = await f.store.acceptRemote(SID, wire('a.png', a), FP);
    expect(r.action).toBe('want');
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', want: true, sha256: sha256Of(a), size: 3000, sourceFp: FP, mimeType: 'image/png' });
    expect((await f.store.acceptRemote(SID, wire('a.png', a), 'other-fp')).action).toBe('want');
    expect(f.store.wantedTargets(sha256Of(a), 3000).map(t => t.name)).toEqual(['a.png']);
    expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
  });

  it('无行而本机已有同名文件（还没登记）→ busy、不建行；登记之后按内容比较', async () => {
    const f = setup();
    const mine = makePng(3000, 31).buf; const theirs = makePng(3000, 32).buf;
    f.ref('a.png');
    await f.store.ensureIndexed(SID);           // 登记跑完时文件还不在
    f.put('a.png', mine);
    expect(await f.store.acceptRemote(SID, wire('a.png', theirs), FP)).toEqual({ action: 'reject', code: 'busy' });
    expect(f.store.get(SID, 'a.png')).toBeUndefined();
    f.store.markDirty(SID);
    await f.store.ensureIndexed(SID);
    expect(await f.store.acceptRemote(SID, wire('a.png', theirs), FP)).toEqual({ action: 'reject', code: 'name_conflict' });
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'present', sha256: sha256Of(mine), conflictSha256: sha256Of(theirs), conflictSize: 3000 });
  });

  it('同会话同名不同内容：本机先有的为准，绑定与文件都不变，冲突记在行上并记审计；同内容 → have', async () => {
    const f = setup();
    const mine = makePng(3000, 33).buf; const theirs = makePng(3200, 34).buf;
    const p = f.put('paste-1.png', mine); f.ref('paste-1.png');
    await f.store.ensureIndexed(SID);
    expect((await f.store.acceptRemote(SID, wire('paste-1.png', mine), FP)).action).toBe('have');
    expect(await f.store.acceptRemote(SID, wire('paste-1.png', theirs), FP)).toEqual({ action: 'reject', code: 'name_conflict' });
    const row = f.store.get(SID, 'paste-1.png')!;
    expect(row).toMatchObject({ state: 'present', sha256: sha256Of(mine), size: 3000, conflictSha256: sha256Of(theirs), conflictSize: 3200 });
    expect(sha256File(p)).toBe(sha256Of(mine));
    expect(incomingFiles(f.root)).toEqual([]);
    expect(f.audits.filter(a => a.event === 'attachment.conflict')).toHaveLength(1);
    // 审计载荷不含路径与完整哈希
    expect(JSON.stringify(f.audits)).not.toContain(f.root);
    expect(JSON.stringify(f.audits)).not.toContain(sha256Of(theirs));
  });

  it('超额：单文件超限 → failed/too_large；会话配额与条数 → failed/quota；都不要字节', async () => {
    const f = setup({ limits: { maxFileBytes: 10_000, sessionQuotaBytes: 7000, sessionMaxFiles: 3 } });
    for (const n of ['big.png', 'a.png', 'b.png', 'c.png', 'd.png']) f.ref(n);
    await f.store.ensureIndexed(SID);
    const sha = (n: number) => sha256Of(Buffer.from(String(n)));
    expect(await f.store.acceptRemote(SID, { name: 'big.png', size: 10_001, sha256: sha(1), mimeType: 'image/png' }, FP)).toEqual({ action: 'reject', code: 'too_large' });
    expect(f.store.get(SID, 'big.png')).toMatchObject({ state: 'failed', failCode: 'too_large', size: 10_001, sha256: sha(1) });
    expect((await f.store.acceptRemote(SID, { name: 'a.png', size: 4000, sha256: sha(2), mimeType: 'image/png' }, FP)).action).toBe('want');
    // 4000 + 3001 > 7000
    expect(await f.store.acceptRemote(SID, { name: 'b.png', size: 3001, sha256: sha(3), mimeType: 'image/png' }, FP)).toEqual({ action: 'reject', code: 'quota' });
    expect(f.store.get(SID, 'b.png')).toMatchObject({ state: 'failed', failCode: 'quota' });
    // 行数已到 3：再小也不收
    expect(await f.store.acceptRemote(SID, { name: 'c.png', size: 1, sha256: sha(4), mimeType: 'image/png' }, FP)).toEqual({ action: 'reject', code: 'quota' });
    // 重发同一份声明结果不变
    expect(await f.store.acceptRemote(SID, { name: 'big.png', size: 10_001, sha256: sha(1), mimeType: 'image/png' }, FP)).toEqual({ action: 'reject', code: 'too_large' });
    expect(await f.store.acceptRemote(SID, { name: 'b.png', size: 3001, sha256: sha(3), mimeType: 'image/png' }, FP)).toEqual({ action: 'reject', code: 'quota' });
    expect(f.store.wantedTargets(sha(3), 3001)).toEqual([]);
    expect(incomingFiles(f.root)).toEqual([]);
  });

  it('held 与 failed 的行不再要字节；重试之后重新要', async () => {
    const f = setup();
    const a = makePng(3000, 35).buf; const b = makePng(3000, 36).buf;
    f.ref('a.png'); f.ref('b.png');
    await f.store.ensureIndexed(SID);
    await f.store.acceptRemote(SID, wire('a.png', a), FP);
    await f.store.acceptRemote(SID, wire('b.png', b), FP);
    f.store.hold(SID, 'a.png');
    f.store.fail(SID, 'b.png', 'bad_chunk');
    expect(await f.store.acceptRemote(SID, wire('a.png', a), FP)).toEqual({ action: 'reject', code: 'held' });
    expect(await f.store.acceptRemote(SID, wire('b.png', b), FP)).toEqual({ action: 'reject', code: 'failed' });
    expect(f.store.wantedTargets(sha256Of(a), 3000)).toEqual([]);
    f.store.retry(SID, 'a.png'); f.store.retry(SID, 'b.png');
    expect((await f.store.acceptRemote(SID, wire('a.png', a), FP)).action).toBe('want');
    expect((await f.store.acceptRemote(SID, wire('b.png', b), FP)).action).toBe('want');
    expect(f.store.get(SID, 'b.png')).toMatchObject({ state: 'missing', want: true, attempts: 0 });
    expect(f.store.get(SID, 'b.png')!.failCode).toBeUndefined();
  });

  it('对同名不同内容的行，重发不同的声明不会改绑；只有用户重试才采纳冲突声明', async () => {
    const f = setup();
    const first = makePng(3000, 37).buf; const second = makePng(3100, 38).buf;
    f.ref('a.png');
    await f.store.ensureIndexed(SID);
    expect((await f.store.acceptRemote(SID, wire('a.png', first), FP)).action).toBe('want');
    expect(await f.store.acceptRemote(SID, wire('a.png', second), 'fp-b')).toEqual({ action: 'reject', code: 'name_conflict' });
    expect(f.store.get(SID, 'a.png')).toMatchObject({ sha256: sha256Of(first), size: 3000, conflictSha256: sha256Of(second) });
    f.store.retry(SID, 'a.png');
    const row = f.store.get(SID, 'a.png')!;
    expect(row).toMatchObject({ state: 'missing', want: true, sha256: sha256Of(second), size: 3100 });
    expect(row.conflictSha256).toBeUndefined();
  });
});

describe('F11A 存储层：发布与本机去重', () => {
  async function wantRow(f: Fixture, name: string, data: Buffer, sid = SID) {
    f.ref(name, sid);
    await f.store.ensureIndexed(sid);
    const r = await f.store.acceptRemote(sid, wire(name, data), FP);
    if (r.action !== 'want') throw new Error(`期望 want，实际 ${JSON.stringify(r)}`);
    return r.row;
  }
  async function staged(f: Fixture, data: Buffer) {
    mkdirSync(join(f.root, 'sync-incoming'), { recursive: true });
    const p = f.store.stagePath(sha256Of(data));
    writeFileSync(p, data);
    const v = await f.io.verify(p, sha256Of(data), data.length);
    if (!v) throw new Error('verify 应当通过');
    return v;
  }

  it('io.verify：长度或哈希不符、文件不存在都返回 undefined', async () => {
    const f = setup();
    const data = makePng(3000, 40).buf;
    const p = f.put('x.png', data);
    expect(await f.io.verify(p, sha256Of(data), 3000)).toMatchObject({ path: p, size: 3000 });
    expect(await f.io.verify(p, sha256Of(data), 2999)).toBeUndefined();
    expect(await f.io.verify(p, 'f'.repeat(64), 3000)).toBeUndefined();
    expect(await f.io.verify(join(f.root, 'nope'), sha256Of(data), 3000)).toBeUndefined();
  });

  it('发布到空位：文件出现在最终名字、行 present、暂存文件已删', async () => {
    const f = setup();
    const data = makePng(3000, 41).buf;
    const row = await wantRow(f, 'a.png', data);
    const v = await staged(f, data);
    expect(await f.store.publishVerified(row, v)).toBe('published');
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha256Of(data));
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'present', statSize: 3000 });
    expect(incomingFiles(f.root)).toEqual([]);
  });

  it('不覆盖：最终名字被占且内容不同 → conflict，那份文件不动，行 failed/name_conflict；内容相同 → exists_same', async () => {
    const f = setup();
    const data = makePng(3000, 42).buf; const other = makePng(3000, 43).buf;
    const row = await wantRow(f, 'a.png', data);
    const occupied = f.put('a.png', other);
    expect(await f.store.publishVerified(row, await staged(f, data))).toBe('conflict');
    expect(sha256File(occupied)).toBe(sha256Of(other));
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'failed', failCode: 'name_conflict' });
    expect(incomingFiles(f.root)).toEqual([]);

    const row2 = await wantRow(f, 'b.png', data);
    f.put('b.png', data);
    expect(await f.store.publishVerified(row2, await staged(f, data))).toBe('exists_same');
    expect(f.store.get(SID, 'b.png')!.state).toBe('present');
    expect(incomingFiles(f.root)).toEqual([]);
  });

  it('硬链接不可用（EPERM）：退回「确认不存在再改名」，同样不覆盖', async () => {
    const eperm = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    const f = setup({ io: { publish: createAttachmentIo({ linkSync: eperm }).publish } });
    const data = makePng(3000, 44).buf; const other = makePng(3000, 45).buf;
    const row = await wantRow(f, 'a.png', data);
    expect(await f.store.publishVerified(row, await staged(f, data))).toBe('published');
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha256Of(data));
    expect(incomingFiles(f.root)).toEqual([]);
    // 换一份内容：同内容的话本机去重会直接从 a.png 复制，走不到这里要测的发布
    const data2 = makePng(3000, 440).buf;
    const row2 = await wantRow(f, 'b.png', data2);
    const occupied = f.put('b.png', other);
    expect(await f.store.publishVerified(row2, await staged(f, data2))).toBe('conflict');
    expect(sha256File(occupied)).toBe(sha256Of(other));
    expect(incomingFiles(f.root)).toEqual([]);
  });

  it('拿别的内容的 VerifiedFile 来发布：拒绝（ATT_IO），最终名字不出现', async () => {
    const f = setup();
    const data = makePng(3000, 46).buf;
    const row = await wantRow(f, 'a.png', data);
    expect(await codeOf(f.store.publishVerified(row, await staged(f, makePng(3000, 47).buf)))).toBe('ATT_IO');
    expect(existsSync(join(f.bucket(), 'a.png'))).toBe(false);
  });

  it('桶目录被换成 junction：登记不建行、发布被拒、读块取不到', async ctx => {
    const f = setup();
    const data = makePng(3000, 48).buf;
    const outside = mkdtempSync(join(tmpdir(), 'f11a-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'a.png'), data);
    mkdirSync(join(f.root, 'sessions', SID), { recursive: true });
    // 建不了 junction 的平台明确记成跳过，不算通过
    try { symlinkSync(outside, f.bucket(), 'junction'); } catch { ctx.skip(); return; }
    f.ref('a.png');
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'a.png')).toBeUndefined();
    expect(f.store.localFile(SID, 'a.png')).toBeUndefined();
    const r = await f.store.acceptRemote(SID, wire('a.png', data), FP);
    expect(r.action).toBe('want');
    if (r.action !== 'want') return;
    expect(await codeOf(f.store.publishVerified(r.row, await staged(f, data)))).toBe('ATT_IO');
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'failed', failCode: 'io_error' });
    expect(readdirSync(outside)).toEqual(['a.png']);
    expect(await codeOf(f.store.readChunk(SID, 'a.png', sha256Of(data), 0))).toBe('ATT_NOT_FOUND');
  });

  // 真实的文件符号链接：Windows 上要管理员或开发者模式才建得了。建不了的机器上这一条记成跳过，
  // 「用 lstat 而不是 stat」另由 tests/att-store-lstat.test.ts 钉住（那里不需要建链接的权限）。
  it.skipIf(!canSymlinkFile)('被引用的名字是指向桶外文件的符号链接：不登记、本机不可用、不顺着链接去读；登记过的普通文件被换成符号链接后不再送出', async () => {
    const f = setup();
    const secret = makePng(3000, 80).buf;
    const outside = mkdtempSync(join(tmpdir(), 'f11a-outside-'));
    dirs.push(outside);
    const target = join(outside, 'secret.png');
    writeFileSync(target, secret);
    mkdirSync(f.bucket(), { recursive: true });
    symlinkSync(target, join(f.bucket(), 'link.png'), 'file');
    f.ref('link.png');
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'link.png')).toBeUndefined();
    expect(f.store.localFile(SID, 'link.png')).toBeUndefined();
    expect(f.store.listPresent(SID)).toEqual([]);
    expect(f.hashCalls).toEqual([]);
    expect(await codeOf(f.store.readChunk(SID, 'link.png', sha256Of(secret), 0))).toBe('ATT_NOT_FOUND');
    // 登记过的普通文件之后被换成符号链接：按「本机文件没了」处理，不把链接指向的内容送出去
    const mine = makePng(3000, 81).buf;
    const p = f.put('a.png', mine); f.ref('a.png');
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'a.png')!.state).toBe('present');
    rmSync(p);
    symlinkSync(target, p, 'file');
    expect(await codeOf(f.store.readChunk(SID, 'a.png', sha256Of(mine), 0))).toBe('ATT_NOT_FOUND');
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', failCode: 'local_missing' });
    expect(f.store.localFile(SID, 'a.png')).toBeUndefined();
    expect(sha256File(target)).toBe(sha256Of(secret));
  });

  it('本机去重：另一个会话已有同内容的完成文件 → 本机复制，直接 have', async () => {
    const f = setup();
    const data = makePng(5000, 49).buf;
    f.put('src.png', data, SID2); f.ref('src.png', SID2);
    await f.store.ensureIndexed(SID2);
    f.ref('dst.png');
    await f.store.ensureIndexed(SID);
    const r = await f.store.acceptRemote(SID, wire('dst.png', data), FP);
    expect(r.action).toBe('have');
    expect(sha256File(join(f.bucket(), 'dst.png'))).toBe(sha256Of(data));
    expect(f.store.get(SID, 'dst.png')!.state).toBe('present');
    expect(incomingFiles(f.root)).toEqual([]);
  });

  it('本机去重：来源文件被改过就不采用（来源行变 local_changed，目标仍 want）', async () => {
    const f = setup();
    const data = makePng(5000, 50).buf;
    const src = f.put('src.png', data, SID2); f.ref('src.png', SID2);
    await f.store.ensureIndexed(SID2);
    writeFileSync(src, makePng(5000, 51).buf);
    utimesSync(src, new Date(), new Date(Date.now() + 60_000));
    f.ref('dst.png');
    await f.store.ensureIndexed(SID);
    expect((await f.store.acceptRemote(SID, wire('dst.png', data), FP)).action).toBe('want');
    expect(existsSync(join(f.bucket(), 'dst.png'))).toBe(false);
    expect(f.store.get(SID2, 'src.png')).toMatchObject({ state: 'failed', failCode: 'local_changed' });
    expect(incomingFiles(f.root)).toEqual([]);
  });

  it('本机去重：publishBlock 有值（已暂停 / 已取消配对 / 已关停）→ 不发布，行仍 missing，没有 .stage', async () => {
    const f = setup();
    const data = makePng(5000, 52).buf;
    f.put('src.png', data, SID2); f.ref('src.png', SID2);
    await f.store.ensureIndexed(SID2);
    f.ref('dst.png');
    await f.store.ensureIndexed(SID);
    for (const code of ['ATT_PAUSED', 'ATT_CANCELLED', 'ATT_STOPPING'] as const) {
      f.block.code = code;
      expect((await f.store.acceptRemote(SID, wire('dst.png', data), FP)).action, code).toBe('want');
      expect(existsSync(join(f.bucket(), 'dst.png'))).toBe(false);
      expect(f.store.get(SID, 'dst.png')!.state).toBe('missing');
      expect(incomingFiles(f.root)).toEqual([]);
    }
    f.block.code = undefined;
    expect((await f.store.acceptRemote(SID, wire('dst.png', data), FP)).action).toBe('have');
  });
});

describe('F11A 存储层：发送源', () => {
  it('按块读出登记过的文件；每个「取不到」都是 ATT_NOT_FOUND', async () => {
    const f = setup({ limits: { chunkBytes: 1024 } });
    const data = makePng(2500, 60).buf;
    const p = f.put('a.png', data); f.ref('a.png');
    f.put('shot.png', makePng(2000, 61).buf);                   // 桶里有、没被引用
    f.put('other.png', makePng(2000, 62).buf, SID2); f.ref('other.png', SID2);
    await f.store.ensureIndexed(SID); await f.store.ensureIndexed(SID2);
    const sha = sha256Of(data);
    const chunks = [];
    for (const off of [0, 1024, 2048]) {
      const c = await f.store.readChunk(SID, 'a.png', sha, off);
      expect(c.size).toBe(2500);
      chunks.push(c.bytes);
    }
    expect(chunks.map(c => c.length)).toEqual([1024, 1024, 452]);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);

    const nf = (name: string, s: string, off: number, sid = SID) => codeOf(f.store.readChunk(sid, name, s, off));
    expect(await nf('a.png', sha, 3072)).toBe('ATT_NOT_FOUND');          // offset 越过末尾
    expect(await nf('a.png', sha, 100)).toBe('ATT_NOT_FOUND');           // 不在块界上
    expect(await nf('a.png', 'e'.repeat(64), 0)).toBe('ATT_NOT_FOUND');  // sha256 不符
    expect(await nf('shot.png', sha256File(join(f.bucket(), 'shot.png')), 0)).toBe('ATT_NOT_FOUND');   // 没被消息引用
    expect(await nf('other.png', sha256File(join(f.bucket(SID2), 'other.png')), 0)).toBe('ATT_NOT_FOUND'); // 别的会话的附件
    expect(await nf('minis.db', sha, 0)).toBe('ATT_NOT_FOUND');
    expect(await nf('..\\..\\minis.db', sha, 0)).toBe('ATT_NOT_FOUND');
    expect(await nf('a.png', sha, 0, '..\\..\\x')).toBe('ATT_NOT_FOUND');

    // 文件被改：不再提供，行变 local_changed
    writeFileSync(p, makePng(2500, 63).buf);
    utimesSync(p, new Date(), new Date(Date.now() + 60_000));
    expect(await nf('a.png', sha, 0)).toBe('ATT_NOT_FOUND');
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'failed', failCode: 'local_changed' });
  });

  it('文件被删：取不到，行变 missing/local_missing 并催一次', async () => {
    const f = setup();
    const data = makePng(2500, 64).buf;
    const p = f.put('a.png', data); f.ref('a.png');
    await f.store.ensureIndexed(SID);
    rmSync(p);
    expect(await codeOf(f.store.readChunk(SID, 'a.png', sha256Of(data), 0))).toBe('ATT_NOT_FOUND');
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', failCode: 'local_missing', want: true });
    expect(f.localMissing).toEqual([SID]);
  });

  it('引用没了（消息被清除后 markDirty）：不再送出，也不再列进清单', async () => {
    const f = setup();
    const data = makePng(2500, 65).buf;
    f.put('a.png', data); f.ref('a.png');
    await f.store.ensureIndexed(SID);
    expect(f.store.listPresent(SID)).toHaveLength(1);
    f.db.prepare('DELETE FROM messages WHERE session_id=?').run(SID);
    f.store.markDirty(SID);
    expect(f.store.listPresent(SID)).toEqual([]);
    expect(await codeOf(f.store.readChunk(SID, 'a.png', sha256Of(data), 0))).toBe('ATT_NOT_FOUND');
  });

  it('会话被删（删除不经 markDirty）：引用当场为空，不再送出、不再列进清单、不再是发布目标；别的会话不受影响', async () => {
    const f = setup();
    const have = makePng(2500, 66).buf; const wanted = makePng(2600, 67).buf; const other = makePng(2700, 68).buf;
    f.put('a.png', have); f.ref('a.png'); f.ref('b.png');
    f.put('o.png', other, SID2); f.ref('o.png', SID2);
    await f.store.ensureIndexed(SID); await f.store.ensureIndexed(SID2);
    expect((await f.store.acceptRemote(SID, wire('b.png', wanted), FP)).action).toBe('want');
    expect(f.store.listPresent(SID)).toHaveLength(1);
    expect(f.store.wantedTargets(sha256Of(wanted), 2600)).toHaveLength(1);
    // chat.sessions.delete 的效果：消息行与会话行没了，没有任何人调 markDirty（引用缓存里还是删除之前的内容）
    f.db.prepare('DELETE FROM messages WHERE session_id=?').run(SID);
    f.db.prepare('DELETE FROM sessions WHERE id=?').run(SID);
    expect(f.store.referenced(SID).size).toBe(0);
    expect(f.store.invalidRefs(SID)).toEqual([]);
    expect(f.store.listPresent(SID)).toEqual([]);
    expect(await codeOf(f.store.readChunk(SID, 'a.png', sha256Of(have), 0))).toBe('ATT_NOT_FOUND');
    expect(f.store.wantedTargets(sha256Of(wanted), 2600)).toEqual([]);
    expect(await f.store.acceptRemote(SID, wire('b.png', wanted), FP)).toEqual({ action: 'reject', code: 'not_referenced' });
    expect(f.store.wantedRow(SID, 'b.png', sha256Of(wanted), 2600)).toBeUndefined();
    // 只是不再同步：行留到启动自检才清，文件不动
    expect(f.store.get(SID, 'a.png')!.state).toBe('present');
    expect(sha256File(join(f.bucket(), 'a.png'))).toBe(sha256Of(have));
    // 别的会话照常
    expect(f.store.listPresent(SID2).map(r => r.name)).toEqual(['o.png']);
    expect((await f.store.readChunk(SID2, 'o.png', sha256Of(other), 0)).size).toBe(2700);
  });

  it('wantedRow：仍是 missing、want=1、内容键没换、名字仍被引用才算还要；发布之前的最后一次复查用它', async () => {
    const f = setup();
    const data = makePng(2500, 69).buf; const sha = sha256Of(data);
    f.ref('a.png');
    await f.store.ensureIndexed(SID);
    await f.store.acceptRemote(SID, wire('a.png', data), FP);
    expect(f.store.wantedRow(SID, 'a.png', sha, 2500)).toMatchObject({ name: 'a.png', state: 'missing', want: true });
    expect(f.store.wantedRow(SID, 'a.png', 'e'.repeat(64), 2500)).toBeUndefined();   // 内容键换了
    expect(f.store.wantedRow(SID, 'a.png', sha, 2501)).toBeUndefined();
    expect(f.store.wantedRow(SID, 'nope.png', sha, 2500)).toBeUndefined();
    f.store.hold(SID, 'a.png');
    expect(f.store.wantedRow(SID, 'a.png', sha, 2500)).toBeUndefined();              // 用户取消了
    f.store.retry(SID, 'a.png');
    expect(f.store.wantedRow(SID, 'a.png', sha, 2500)).toBeDefined();
    f.db.prepare('DELETE FROM messages WHERE session_id=?').run(SID);
    f.store.markDirty(SID);
    expect(f.store.wantedRow(SID, 'a.png', sha, 2500)).toBeUndefined();              // 引用没了
  });
});

describe('F11A 文件操作：被占用时的重试（注入抛错；真实被占用的文件上没有实测）', () => {
  const busy = (code: string): Error => Object.assign(new Error(code), { code });

  it('retryBusySync：EBUSY / EPERM / EACCES 至多重试 3 次；一直占用就把错抛出来；别的错当场抛、不重试', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      let n = 0;
      expect(retryBusySync(() => { if (++n <= 3) throw busy(code); return 'ok'; }), code).toBe('ok');
      expect(n, code).toBe(4);
    }
    let n = 0;
    expect(() => retryBusySync(() => { n++; throw busy('EBUSY'); })).toThrow('EBUSY');
    expect(n).toBe(4);
    n = 0;
    expect(() => retryBusySync(() => { n++; throw busy('ENOSPC'); })).toThrow('ENOSPC');
    expect(n).toBe(1);
  });

  it('removeFileQuiet：删掉了或本来就不存在都算成；删不掉（这里是目录）返回 false，不抛', () => {
    const f = setup();
    const p = f.put('x.png', makePng(3000, 82).buf);
    expect(removeFileQuiet(p)).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(removeFileQuiet(p)).toBe(true);
    expect(removeFileQuiet(f.bucket())).toBe(false);
    expect(existsSync(f.bucket())).toBe(true);
  });
});

describe('F11A 存储层：失败计数、取消、stamp、启动自检', () => {
  it('整文件校验失败：第一次仍 missing（自动再取一次），第二次 failed/hash_mismatch；重试清零', async () => {
    const f = setup();
    const data = makePng(3000, 70).buf;
    f.ref('a.png');
    await f.store.ensureIndexed(SID);
    await f.store.acceptRemote(SID, wire('a.png', data), FP);
    f.store.noteIntegrityFailure(sha256Of(data), 3000);
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', attempts: 1 });
    f.store.noteIntegrityFailure(sha256Of(data), 3000);
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'failed', failCode: 'hash_mismatch', attempts: 2 });
    expect(f.audits.some(a => a.event === 'attachment.failed')).toBe(true);
    f.store.retry(SID, 'a.png');
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', attempts: 0, want: true });
  });

  it('noteInterrupted 只给还要取的 missing 行留原因；hold 之后不再是要取的；stamp 随每次行变化而变', async () => {
    const f = setup();
    const data = makePng(3000, 71).buf;
    f.ref('a.png');
    await f.store.ensureIndexed(SID);
    const s0 = f.store.stamp(SID);
    await f.store.acceptRemote(SID, wire('a.png', data), FP);
    const s1 = f.store.stamp(SID);
    expect(s1).not.toBe(s0);
    f.store.noteInterrupted(SID, 'a.png');
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', failCode: 'interrupted', want: true });
    const s2 = f.store.stamp(SID);
    expect(s2).not.toBe(s1);
    f.store.hold(SID, 'a.png');
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', want: false });
    expect(f.store.get(SID, 'a.png')!.failCode).toBeUndefined();
    expect(f.store.stamp(SID)).not.toBe(s2);
    f.store.noteInterrupted(SID, 'a.png');     // 已取消的行不被写成中断
    expect(f.store.get(SID, 'a.png')!.failCode).toBeUndefined();
    expect(f.changed.length).toBeGreaterThan(0);
  });

  it('重试：too_large / quota 的行删掉重判；name_conflict 且本机同名文件还在时不重置', async () => {
    const f = setup({ limits: { maxFileBytes: 4000 } });
    f.ref('big.png'); f.ref('c.png');
    await f.store.ensureIndexed(SID);
    await f.store.acceptRemote(SID, { name: 'big.png', size: 4001, sha256: 'c'.repeat(64), mimeType: 'image/png' }, FP);
    f.store.retry(SID, 'big.png');
    expect(f.store.get(SID, 'big.png')).toBeUndefined();
    const theirs = makePng(3000, 72).buf;
    await f.store.acceptRemote(SID, wire('c.png', theirs), FP);
    f.put('c.png', makePng(3000, 73).buf);
    f.store.markDirty(SID);
    await f.store.ensureIndexed(SID, { force: true });
    expect(f.store.get(SID, 'c.png')).toMatchObject({ state: 'failed', failCode: 'name_conflict' });
    f.store.retry(SID, 'c.png');
    expect(f.store.get(SID, 'c.png')).toMatchObject({ state: 'failed', failCode: 'name_conflict' });
    rmSync(join(f.bucket(), 'c.png'));
    f.store.retry(SID, 'c.png');
    expect(f.store.get(SID, 'c.png')).toMatchObject({ state: 'missing', want: true });
  });

  it('recover()：删已不存在的会话的行（不删文件）、清 .stage、只留还有人要且没超长没过期的 .part', async () => {
    const f = setup({ limits: { partTtlMs: 1000 } });
    const data = makePng(3000, 74).buf; const sha = sha256Of(data);
    f.ref('a.png');
    await f.store.ensureIndexed(SID);
    await f.store.acceptRemote(SID, wire('a.png', data), FP);
    // 孤儿行：会话已不在
    const GONE = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    f.db.prepare(`INSERT INTO sync_attachments (session_id, name, sha256, size, state, created_at, updated_at) VALUES (?, 'x.png', ?, 5, 'present', 0, 0)`).run(GONE, 'd'.repeat(64));
    mkdirSync(join(f.root, 'sessions', GONE, 'attachments'), { recursive: true });
    writeFileSync(join(f.root, 'sessions', GONE, 'attachments', 'x.png'), 'keep');
    const inc = join(f.root, 'sync-incoming');
    mkdirSync(inc, { recursive: true });
    const keep = `${sha}.3000.part`;
    writeFileSync(join(inc, keep), data.subarray(0, 1024));
    writeFileSync(join(inc, `${sha}.abcd1234.stage`), data);
    writeFileSync(join(inc, `${'e'.repeat(64)}.3000.part`), 'nobody wants');     // 没有要取的行
    writeFileSync(join(inc, `${sha}.2000.part`), 'wrong size key');               // 内容键不同
    writeFileSync(join(inc, 'garbage.part'), 'x');                                // 文件名不合规
    writeFileSync(join(inc, 'note.txt'), 'x');                                    // 别的文件不动
    f.store.recover();
    expect(incomingFiles(f.root)).toEqual([keep, 'note.txt'].sort());
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM sync_attachments WHERE session_id=?').get(GONE)).toEqual({ n: 0 });
    expect(readFileSync(join(f.root, 'sessions', GONE, 'attachments', 'x.png'), 'utf8')).toBe('keep');
    expect(f.store.get(SID, 'a.png')!.state).toBe('missing');

    // 超过声明长度的暂存、过期的暂存都删
    writeFileSync(join(inc, keep), Buffer.alloc(3001));
    f.store.recover();
    expect(incomingFiles(f.root)).toEqual(['note.txt']);
    writeFileSync(join(inc, keep), data.subarray(0, 1024));
    f.clock.t = Date.now() + 5000;                                                // 注入的时钟走过 TTL
    f.store.recover();
    expect(incomingFiles(f.root)).toEqual(['note.txt']);
  });

  it('暂存目录对 agent 的文件工具不是免审区：读写都要过卡', () => {
    const f = setup();
    const scope = { root: f.root, sessionId: SID, workspace: join(f.root, 'sessions', SID, 'workspace') };
    const part = join(f.root, 'sync-incoming', `${'a'.repeat(64)}.3000.part`);
    expect(dataGate(part, scope, 'read').verdict).toBe('ask');
    expect(dataGate(part, scope, 'write').verdict).toBe('ask');
  });

  it('路径只由本机拼：不合规的会话 id、名字、哈希在拼路径前就被拒', () => {
    const f = setup();
    expect(() => f.store.finalPath('..\\..\\x', 'a.png')).toThrow('ATT_BAD_REQUEST');
    expect(() => f.store.finalPath(SID, '..\\evil.png')).toThrow('ATT_BAD_REQUEST');
    expect(() => f.store.partPath('zz', 10)).toThrow('ATT_BAD_REQUEST');
    expect(() => f.store.partPath('a'.repeat(64), -1)).toThrow('ATT_BAD_REQUEST');
    expect(f.store.finalPath(SID, 'a.png')).toBe(join(f.root, 'sessions', SID, 'attachments', 'a.png'));
    expect(f.store.partPath('a'.repeat(64), 10)).toBe(join(f.root, 'sync-incoming', `${'a'.repeat(64)}.10.part`));
  });
});
