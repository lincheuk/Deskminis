/**
 * F11A · 存储层认文件用的是 lstat，不是 stat（设计 §4.2「符号链接与 junction 不算普通文件」、验收 4「不访问源设备任意文件」）。
 *
 * 真实的文件符号链接在 Windows 上要管理员或开发者模式才建得了（tests/att-store.test.ts 里那一条在建不了的机器上是跳过）。
 * 这里不建链接：桶里放一个真实的普通文件，再让 node:fs 的 lstatSync 对这一个路径回答「这是符号链接」，其余路径原样。
 * 这正是符号链接在两个调用上的差别：lstat 看到链接本身，stat（以及随后的 open、读）顺着链接看到一个普通文件。
 * 存储层若改用 statSync，这个路径在它眼里就是普通文件：会被登记成 present、列进清单、经 readChunk 送出，下面的断言变红。
 *
 * 只替换 lstatSync 一个函数、只对登记在 linked 里的路径生效；statSync、读写、哈希都是真的。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { MinisPaths } from '../src/minisd/paths';
import { AttachmentStore } from '../src/minisd/sync/attachments/store';
import { createAttachmentIo } from '../src/minisd/sync/attachments/io';
import { DEFAULT_ATTACHMENT_LIMITS } from '../src/minisd/sync/attachments/limits';
import { AttError } from '../src/minisd/sync/attachments/wire';
import { makePng, sha256Of } from './att-util';

/** 被当作符号链接的路径（小写、规范化）。 */
const linked = vi.hoisted(() => new Set<string>());

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const key = (p: unknown): string => (typeof p === 'string' ? p : String(p)).replace(/\\/g, '/').toLowerCase();
  const lstatSync = ((p: unknown, ...rest: unknown[]) => {
    const st = (actual.lstatSync as (...a: unknown[]) => unknown)(p, ...rest) as import('node:fs').Stats;
    if (!linked.has(key(p))) return st;
    // 链接本身：不是普通文件、不是目录
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
      isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true,
    });
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync, default: { ...actual, lstatSync } };
});

const SID = '11111111-2222-4333-8444-555555555555';
const keyOf = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase();

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  linked.clear();
  for (const d of dbs.splice(0)) { try { d.close(); } catch { /* 已关 */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'f11a-lstat-'));
  dirs.push(root);
  const db = openDb(join(root, 'minis.db'));
  dbs.push(db);
  db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)').run(SID, 't');
  const paths = new MinisPaths(root);
  const localMissing: string[] = [];
  const hashed: string[] = [];
  const base = createAttachmentIo();
  const store = new AttachmentStore(db, root, paths, { ...DEFAULT_ATTACHMENT_LIMITS }, { ...base, hash: async p => { hashed.push(p); return base.hash(p); } }, Date.now, {
    onChanged: () => { /* 不关心 */ },
    onLocalMissing: sid => { localMissing.push(sid); },
    sessionExists: sid => db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sid) !== undefined,
    publishBlock: () => undefined,
  });
  const bucket = paths.sessionBucket(SID, 'attachments');
  let seq = 0;
  return {
    store, localMissing, hashed, bucket,
    put(name: string, data: Buffer): string { mkdirSync(bucket, { recursive: true }); const p = join(bucket, name); writeFileSync(p, data); return p; },
    ref(name: string): void {
      const parts = JSON.stringify([{ type: 'mediaRef', value: { id: `m${seq}`, relativePath: `attachments/${name}`, mimeType: 'image/png' } }]);
      db.prepare('INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`msg-${seq}`, SID, 'user', parts, seq, seq, seq);
      seq++;
      store.markDirty(SID);
    },
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return e instanceof AttError ? e.code : `非 AttError: ${String(e)}`; }
  return '没有抛错';
}

describe('F11A 存储层：认文件用 lstat（符号链接不算普通文件）', () => {
  it('对照：替换只对登记的路径生效——stat 仍说它是普通文件，lstat 说它是链接；没登记的路径两者一致', async () => {
    const f = setup();
    const p = f.put('link.png', makePng(3000, 90).buf);
    const q = f.put('plain.png', makePng(3000, 91).buf);
    linked.add(keyOf(p));
    const fs = await import('node:fs');
    expect(fs.statSync(p).isFile()).toBe(true);
    expect(statSync(p).isFile()).toBe(true);
    expect(fs.lstatSync(p).isFile()).toBe(false);
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(q).isFile()).toBe(true);
  });

  it('被引用的名字是符号链接：不登记、不算哈希、本机不可用、不进清单、读块取不到；旁边的普通文件照常', async () => {
    const f = setup();
    const secret = makePng(3000, 92).buf; const plain = makePng(3100, 93).buf;
    const p = f.put('link.png', secret);
    f.put('plain.png', plain);
    linked.add(keyOf(p));
    f.ref('link.png'); f.ref('plain.png');
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'link.png')).toBeUndefined();
    expect(f.store.localFile(SID, 'link.png')).toBeUndefined();
    expect(f.hashed.map(x => x.split(/[\\/]/).pop())).toEqual(['plain.png']);
    expect(f.store.listPresent(SID).map(r => r.name)).toEqual(['plain.png']);
    expect(await codeOf(f.store.readChunk(SID, 'link.png', sha256Of(secret), 0))).toBe('ATT_NOT_FOUND');
    expect((await f.store.readChunk(SID, 'plain.png', sha256Of(plain), 0)).size).toBe(3100);
  });

  it('登记过的普通文件之后被换成符号链接：按本机文件没了处理（missing/local_missing，催一次），不再送出', async () => {
    const f = setup();
    const data = makePng(3000, 94).buf;
    const p = f.put('a.png', data); f.ref('a.png');
    await f.store.ensureIndexed(SID);
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'present', sha256: sha256Of(data) });
    expect((await f.store.readChunk(SID, 'a.png', sha256Of(data), 0)).size).toBe(3000);
    linked.add(keyOf(p));
    expect(await codeOf(f.store.readChunk(SID, 'a.png', sha256Of(data), 0))).toBe('ATT_NOT_FOUND');
    expect(f.store.get(SID, 'a.png')).toMatchObject({ state: 'missing', failCode: 'local_missing', want: true });
    expect(f.localMissing).toEqual([SID]);
    expect(f.store.localFile(SID, 'a.png')).toBeUndefined();
    expect(f.store.listPresent(SID)).toEqual([]);
    // 强制核对也不会把它认回来
    await f.store.ensureIndexed(SID, { force: true });
    expect(f.store.get(SID, 'a.png')!.state).toBe('missing');
  });
});
