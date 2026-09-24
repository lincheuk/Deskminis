/** W1a-8（侦察 lifecycle.md W1a-dbguard）：数据库降级守卫 + 每条迁移一个事务。
 *
 *  为什么要这道守卫：openDb 旧写法 `for (v = current; v < MIGRATIONS.length; v++)` 对「比本应用新」的库
 *  一次都不循环、静默返回——用户装回旧版时，旧代码会带着对新列一无所知的 SQL 去读写新库，
 *  坏数据写进去就回不来了。现在要在**任何写入之前**（连 WAL 切换都不做）识别出来并拒绝打开。
 *
 *  为什么要事务回滚：旧写法 BEGIN / exec / COMMIT 在 exec 抛错时没有 ROLLBACK——半条迁移留在连接上、
 *  事务悬挂，同一连接后续的任何写入都会被一并提交，user_version 却没前进，下次启动再跑一遍就撞「表已存在」。
 *
 *  「连接已关」的证据用 WAL 旁路文件：WAL 库上最后一个连接关闭时 SQLite 会删掉 -wal / -shm，
 *  连接漏关则两者留在盘上（W1a-8 动手前在本机用 better-sqlite3 实测过这一行为）。 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, runMigrations, MIGRATIONS, DbNewerThanAppError } from '../src/minisd/store/db';

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'dm-dbguard-'));
  dirs.push(d);
  return join(d, 'minis.db');
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const userVersion = (db: Database.Database): number => db.pragma('user_version', { simple: true }) as number;
const tableNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name);

/** 按正常路径建一个完整的库，再用裸连接把 user_version 改到 v（模拟「更新版本的应用」动过它）。 */
function seedDbAtVersion(file: string, v: number): void {
  openDb(file).close();
  const raw = new Database(file);
  raw.pragma(`user_version = ${v}`);
  raw.close();
}

describe('降级守卫：库比应用新时拒绝打开且一个字节都不写', () => {
  it('user_version = MIGRATIONS.length + 1：openDb 抛 DB_NEWER_THAN_APP，主库文件哈希不变，连接已关', () => {
    const file = tmpDb();
    const newer = MIGRATIONS.length + 1;
    seedDbAtVersion(file, newer);
    const before = sha256File(file);

    expect(() => openDb(file)).toThrow(expect.objectContaining({ code: 'DB_NEWER_THAN_APP' }));

    // 只对准主库文件：WAL 库在读版本时会临时建 -shm/-wal，关连接后应被 SQLite 清掉（见下一条断言）
    expect(sha256File(file), '降级守卫不得改动主库文件的任何字节').toBe(before);
    expect(existsSync(`${file}-wal`) || existsSync(`${file}-shm`),
      '抛错前必须先关连接——留着 -wal/-shm 说明连接泄漏，Windows 上还会一直锁着这个库').toBe(false);
    // 裸连接复核：版本仍是「新版本」写下的值，没被本应用改回去
    const raw = new Database(file, { readonly: true });
    expect(userVersion(raw)).toBe(newer);
    raw.close();
  });

  it('库是回滚日志模式（非 WAL）时也一个字节都不写：判新旧必须在切 WAL 之前', () => {
    // 上一条的库本来就是 WAL，先切 WAL 再判也不会改字节；这里换成默认的 delete 模式，
    // 若实现先 `journal_mode = WAL` 再判新旧，库头（文件格式读写版本字节）就被改掉了。
    const file = tmpDb();
    const raw = new Database(file);
    raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    raw.pragma('user_version = 99');
    raw.close();
    const before = sha256File(file);

    expect(() => openDb(file)).toThrow(expect.objectContaining({ code: 'DB_NEWER_THAN_APP' }));
    expect(sha256File(file), '先切 WAL 再判新旧会改写库头').toBe(before);
    const check = new Database(file, { readonly: true });
    expect(check.pragma('journal_mode', { simple: true })).toBe('delete');
    check.close();
  });

  it('错误带上 dbVersion / appVersion，message 是中文，是 DbNewerThanAppError 实例', () => {
    const file = tmpDb();
    seedDbAtVersion(file, 99);
    let caught: unknown;
    try { openDb(file); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DbNewerThanAppError);
    const e = caught as DbNewerThanAppError;
    expect(e.code).toBe('DB_NEWER_THAN_APP');
    expect(e.dbVersion).toBe(99);
    expect(e.appVersion).toBe(MIGRATIONS.length);
    expect(e.message).toMatch(/[一-鿿]/);
    expect(e.message).toContain('99');
  });

  it('user_version 恰等于 MIGRATIONS.length 时照常打开（守卫只拦「更新」，不拦「一样新」）', () => {
    const file = tmpDb();
    seedDbAtVersion(file, MIGRATIONS.length);
    const db = openDb(file);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    db.close();
  });

  it('runMigrations 自己也判新旧：直接对「更新」的连接调用同样抛 DB_NEWER_THAN_APP', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 3');
    expect(() => runMigrations(db, [MIGRATIONS[0]])).toThrow(expect.objectContaining({
      code: 'DB_NEWER_THAN_APP', dbVersion: 3, appVersion: 1,
    }));
    expect(userVersion(db)).toBe(3);
    db.close();
  });
});

describe('迁移事务：失败整条回滚，连接上不留悬挂事务', () => {
  it('第二条迁移中途失败：同一连接上 inTransaction=false、t_ok 不存在、user_version 停在 1', () => {
    const db = new Database(':memory:');
    // 第二条前半句合法、后半句语法错——旧写法会把 t_ok 留在一个永不结束的事务里
    expect(() => runMigrations(db, [MIGRATIONS[0], 'CREATE TABLE t_ok(x); CREATE TABLE t_bad('])).toThrow();
    expect(db.inTransaction, '失败的迁移必须回滚，不能把事务挂在连接上').toBe(false);
    expect(tableNames(db)).not.toContain('t_ok');
    expect(tableNames(db), '第一条迁移已提交，不受第二条失败影响').toContain('sessions');
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  it('openDb 里某条迁移失败：先关连接再抛，user_version 不前进', () => {
    const file = tmpDb();
    // 造一个「停在 10、但 [10] 要建的表已经在了」的库：补跑 MIGRATIONS[10] 必撞「表已存在」
    const raw = new Database(file);
    raw.pragma('journal_mode = WAL');
    for (let i = 0; i < 10; i++) raw.exec(MIGRATIONS[i]);
    raw.exec(MIGRATIONS[10]);
    raw.pragma('user_version = 10');
    raw.close();

    expect(() => openDb(file)).toThrow(/already exists/);
    expect(existsSync(`${file}-wal`) || existsSync(`${file}-shm`),
      '迁移失败时 openDb 必须先 close 再抛——否则连接泄漏、Windows 上库文件一直被锁').toBe(false);
    const check = new Database(file, { readonly: true });
    expect(userVersion(check)).toBe(10);
    check.close();
  });

  it('正常路径不变：新库一次跑完到 MIGRATIONS.length，重开幂等', () => {
    const file = tmpDb();
    const db = openDb(file);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
    const again = openDb(file);
    expect(userVersion(again)).toBe(MIGRATIONS.length);
    again.close();
  });
});
