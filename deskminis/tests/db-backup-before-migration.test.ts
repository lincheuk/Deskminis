/** 升级要补跑迁移之前，先留一份改之前的库（minis.db.bak）。
 *
 *  为什么：迁移过的库旧版本拒绝打开（见 db-newer-than-app.test.ts 的降级守卫）。新版本有问题、想装回旧版时，
 *  没有这一份就只能等修好的新版；有了它，把它换回去就是升级前的状态。
 *  只在确实要跑迁移时留，只留最近一次的；备份做不成不拦升级。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, runMigrations, dbBackupPath, MIGRATIONS } from '../src/minisd/store/db';

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'dm-dbbackup-'));
  dirs.push(d);
  return join(d, 'minis.db');
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const userVersion = (db: Database.Database): number => db.pragma('user_version', { simple: true }) as number;
const sessionIds = (db: Database.Database): string[] =>
  (db.prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[]).map(r => r.id);

/** 旧版本留下的库：只跑到第 version 条迁移，里面有一个会话。和真实的库一样是 WAL 模式。 */
function seedOldDb(file: string, version: number, sessionId = 'old-session'): void {
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  runMigrations(raw, MIGRATIONS.slice(0, version));
  raw.prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, 1, 1)').run(sessionId);
  raw.close();
}

/** 读备份里的版本号与会话。 */
function readBackup(file: string): { version: number; sessions: string[] } {
  const b = new Database(dbBackupPath(file), { readonly: true, fileMustExist: true });
  try { return { version: userVersion(b), sessions: sessionIds(b) }; } finally { b.close(); }
}

const OLD = MIGRATIONS.length - 1;

describe('要补跑迁移时先留一份旧库', () => {
  it('旧版本的库：备份停在升级前的版本、带着原来的数据；主库照常升到最新', () => {
    const file = tmpDb();
    seedOldDb(file, OLD);

    const db = openDb(file);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    expect(sessionIds(db)).toEqual(['old-session']);
    db.close();

    expect(readBackup(file)).toEqual({ version: OLD, sessions: ['old-session'] });
    expect(existsSync(`${dbBackupPath(file)}.tmp`), '临时文件已改名成正式的备份').toBe(false);
  });

  it('还没并回主文件的 WAL 内容也在备份里（上次没有正常退出）', () => {
    const file = tmpDb();
    seedOldDb(file, OLD);
    // 另一个连接一直开着，WAL 就不会在关连接时并回主文件——和上次没正常退出留下 -wal 是同一种状态
    const holder = new Database(file);
    holder.prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, 2, 2)').run('in-wal');
    expect(existsSync(`${file}-wal`)).toBe(true);

    openDb(file).close();
    holder.close();

    expect(readBackup(file).sessions).toEqual(['in-wal', 'old-session']);
  });

  it('备份是一份能直接打开的库：换回去之后旧版本（只认到 OLD 条迁移）照常打开', () => {
    const file = tmpDb();
    seedOldDb(file, OLD);
    openDb(file).close();

    const restored = new Database(dbBackupPath(file));
    expect(() => runMigrations(restored, MIGRATIONS.slice(0, OLD))).not.toThrow();
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    restored.close();
  });

  it('只留最近一次：再升级一次，备份换成这一次升级前的库', () => {
    const file = tmpDb();
    seedOldDb(file, OLD - 1, 'first');
    // 第一次「升级」到 OLD：手搭，等于装了中间那个版本
    const mid = new Database(file);
    runMigrations(mid, MIGRATIONS.slice(0, OLD));
    mid.prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, 2, 2)').run('second');
    mid.close();
    writeFileSync(dbBackupPath(file), '上一次升级留下的备份');

    openDb(file).close();

    expect(readBackup(file)).toEqual({ version: OLD, sessions: ['first', 'second'] });
    expect(readdirSync(join(file, '..')).filter(n => n.includes('.bak'))).toEqual(['minis.db.bak']);
  });
});

describe('升级没做完再启动', () => {
  it('后面的迁移失败：主库整个停在升级前的版本；再启动几次，备份都还是升级前那一份', () => {
    const file = tmpDb();
    seedOldDb(file, OLD - 1); // 差两条：第一条能过，最后一条失败
    const exec = Database.prototype.exec;
    const failing = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql === MIGRATIONS[MIGRATIONS.length - 1]) throw new Error('最后一条迁移失败');
      return exec.call(this, sql);
    });
    expect(() => openDb(file)).toThrow('最后一条迁移失败');
    expect(() => openDb(file)).toThrow('最后一条迁移失败');
    failing.mockRestore();

    expect(readBackup(file)).toEqual({ version: OLD - 1, sessions: ['old-session'] });
    const raw = new Database(file, { readonly: true });
    expect(userVersion(raw), '主库没有停在两条迁移之间').toBe(OLD - 1);
    raw.close();

    // 换了修好的版本：升级成功，备份仍是升级前的
    openDb(file).close();
    expect(readBackup(file).version).toBe(OLD - 1);
  });
});

describe('不需要迁移时不备份', () => {
  it('全新的空库（版本 0）：建表，不留备份', () => {
    const file = tmpDb();
    openDb(file).close();
    expect(existsSync(dbBackupPath(file))).toBe(false);
  });

  it('已经是最新版本：不备份，原有的备份原样留着', () => {
    const file = tmpDb();
    openDb(file).close();
    writeFileSync(dbBackupPath(file), '上一次升级留下的备份');

    openDb(file).close();

    expect(readFileSync(dbBackupPath(file), 'utf8')).toBe('上一次升级留下的备份');
  });

  it('库比应用新：照旧拒绝打开，不留备份', () => {
    const file = tmpDb();
    openDb(file).close();
    const raw = new Database(file);
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();

    expect(() => openDb(file)).toThrow(expect.objectContaining({ code: 'DB_NEWER_THAN_APP' }));
    expect(existsSync(dbBackupPath(file))).toBe(false);
  });
});

describe('备份做不成不拦升级', () => {
  it('上一次备份没做完（.tmp 还在）：这次不再备份，清掉 .tmp，升级照常，更早的备份不动', () => {
    const file = tmpDb();
    seedOldDb(file, OLD);
    writeFileSync(dbBackupPath(file), '更早的备份');
    writeFileSync(`${dbBackupPath(file)}.tmp`, '写到一半');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const db = openDb(file);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    db.close();

    expect(existsSync(`${dbBackupPath(file)}.tmp`)).toBe(false);
    expect(readFileSync(dbBackupPath(file), 'utf8')).toBe('更早的备份');
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('没有做完');
  });

  it('备份的位置写不了（那里是个目录）：记一行警告，升级照常', () => {
    const file = tmpDb();
    seedOldDb(file, OLD);
    mkdirSync(dbBackupPath(file));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const db = openDb(file);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    expect(sessionIds(db)).toEqual(['old-session']);
    db.close();

    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('升级前备份数据库失败');
    expect(existsSync(`${dbBackupPath(file)}.tmp`), '失败后不留 .tmp：留着的话下一次升级会被当成「上次没做完」而不备份').toBe(false);
  });

  it('备份写到一半失败：更早的备份原样留着，升级照常', () => {
    const file = tmpDb();
    seedOldDb(file, OLD);
    writeFileSync(dbBackupPath(file), '更早的备份');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.startsWith('VACUUM INTO')) throw new Error('磁盘满了');
      return prepare.call(this, sql);
    } as typeof prepare);

    const db = openDb(file);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    db.close();

    expect(readFileSync(dbBackupPath(file), 'utf8')).toBe('更早的备份');
  });
});
