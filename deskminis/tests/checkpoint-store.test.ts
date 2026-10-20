/**
 * F08 S 组：检查点存储——内容去重、引用保护、容量与保留期清理、复用内容前查盘、给清理方的引用查询。
 * 上限注入成小值（真实下限的清理由 checkpoint-minisd 的 M8 用真实数据量测）。全部在真实文件系统的临时目录上跑。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, linkSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CheckpointError } from '../src/minisd/checkpoints/commit';
import { MIGRATIONS } from '../src/minisd/store/db';
import { closeAllCpEnvs, cpEnv, sha, type CpEnv } from './checkpoint-fixture';

afterEach(() => { closeAllCpEnvs(); });

const KB = 1024;
const fill = (n: number, byte: number): Buffer => Buffer.alloc(n, byte);
/** 在用户目录里放一个文件并经真实工具覆盖它。返回这次写入留下的那一行。 */
async function overwrite(env: CpEnv, sid: string, name: string, original: Buffer, next = `new ${name}`, o: { keepRunActive?: boolean } = {}) {
  const f = join(env.userDir, name);
  writeFileSync(f, original);
  const r = await env.runTool(sid, 'file_write', { path: f, content: next }, o);
  expect(r.success, r.output).toBe(true);
  return { f, row: r.row, handle: r.handle };
}
const restoreOne = async (env: CpEnv, sid: string, id: string) => (await env.service.restore(sid, [id])).items[0];

describe('F08 S 组：检查点存储', () => {
  it('S1 两个文件原内容相同：只有一个内容文件，用量只算一次', async () => {
    const env = cpEnv('s1');
    const sid = env.newSession();
    const same = fill(4 * KB, 0x41);
    await overwrite(env, sid, 'a.bin', same);
    await overwrite(env, sid, 'b.bin', same);
    expect(env.blobFiles()).toEqual([sha(same)]);
    expect(env.store.usage()).toMatchObject({ usedBytes: 4 * KB, blobCount: 1, checkpointCount: 2 });
  });

  it('S2 两条记录共用一份内容，清掉其中一条：内容文件还在，另一条仍可恢复出原字节', async () => {
    let now = 1_800_000_000;
    const env = cpEnv('s2', { store: { now: () => now } });
    const sid = env.newSession();
    const same = fill(8 * KB, 0x42);
    const a = await overwrite(env, sid, 'a.bin', same);
    now += 20 * 86400;
    const b = await overwrite(env, sid, 'b.bin', same);
    now += 15 * 86400;                                  // a 已 35 天、b 才 15 天：保留期只清 a
    expect(env.store.prune()).toBe(1);
    const rows = env.rows(sid);
    expect(rows.map(r => r.id)).toEqual([a.row.id, b.row.id]);
    expect(rows[0].pruned_at).not.toBeNull();
    expect(rows[0].before_blob).toBeNull();
    expect(rows[1].pruned_at).toBeNull();
    // 清掉 a 那条没有把仍被 b 引用的内容删掉
    expect(readFileSync(env.blobPath(sha(same))).equals(same)).toBe(true);
    expect(env.store.usage().usedBytes).toBe(8 * KB);
    expect((await restoreOne(env, sid, b.row.id)).outcome).toBe('restored');
    expect(readFileSync(b.f).equals(same)).toBe(true);
  });

  it('S2b 只清共用内容的其中一条（配额刚好不必再清）：内容文件不删，另一条恢复出原字节', async () => {
    const env = cpEnv('s2b', { plainTx: true });
    const sid = env.newSession();
    const same = fill(8 * KB, 0x44);
    const a = await overwrite(env, sid, 'a.bin', same);
    const b = await overwrite(env, sid, 'b.bin', same);
    // 直接把 a 标成已清理（清理的单位是记录），再做内容回收
    env.db.prepare('UPDATE file_checkpoints SET pruned_at=1, before_blob=NULL, after_blob=NULL WHERE id=?').run(a.row.id);
    expect(env.store.gc()).toBe(0);
    expect(existsSync(env.blobPath(sha(same)))).toBe(true);
    expect((await restoreOne(env, sid, b.row.id)).outcome).toBe('restored');
    expect(readFileSync(b.f).equals(same)).toBe(true);
    // b 恢复之后它的 before_blob 仍在（记录没被清）；把它也标清理后内容才会被回收
    env.db.prepare('UPDATE file_checkpoints SET pruned_at=1, before_blob=NULL, after_blob=NULL WHERE id=?').run(b.row.id);
    expect(env.store.gc()).toBeGreaterThanOrEqual(1);
    expect(existsSync(env.blobPath(sha(same)))).toBe(false);
  });

  it('S3 容量恰好容不下下一次、旧 run 已结束：最旧的记录标 pruned_at、行还在、内容文件没了；新写入成功', async () => {
    const env = cpEnv('s3', { store: { quotaBytes: () => 10 * KB } });
    const sid = env.newSession();
    const first = fill(6 * KB, 0x51);
    const a = await overwrite(env, sid, 'a.bin', first);
    const second = fill(6 * KB, 0x52);
    const b = await overwrite(env, sid, 'b.bin', second);   // 6 + 6 > 10：要先清掉 a
    const rows = env.rows(sid);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(a.row.id);
    expect(rows[0].pruned_at).not.toBeNull();
    expect(rows[0].before_blob).toBeNull();
    expect(existsSync(env.blobPath(sha(first)))).toBe(false);
    expect(rows[1].state).toBe('applied');
    expect(readFileSync(b.f, 'utf8')).toBe('new b.bin');
    expect(existsSync(env.blobPath(sha(second)))).toBe(true);
  });

  it('S4 最旧的记录属于活动 run / 是 pending / 是 unknown：都不被清；被清的是次旧的已结束 run 的；全受保护时新覆盖因空间用满被拒、文件不变', async () => {
    const env = cpEnv('s4', { store: { quotaBytes: () => 20 * KB } });
    const sActive = env.newSession(); const sDone = env.newSession(); const sNew = env.newSession();
    const act = await overwrite(env, sActive, 'active.bin', fill(6 * KB, 0x61), 'x', { keepRunActive: true });
    const done = await overwrite(env, sDone, 'done.bin', fill(6 * KB, 0x62));
    const unk = await overwrite(env, sDone, 'unknown.bin', fill(6 * KB, 0x63));
    env.db.prepare("UPDATE file_checkpoints SET state='unknown' WHERE id=?").run(unk.row.id);
    // 18 KB 已占；再来 6 KB 要清：最旧的 act 受保护（run 活动），unknown 受保护，只有 done 可清
    await overwrite(env, sNew, 'n1.bin', fill(6 * KB, 0x64));
    const byId = (id: string): any => env.rows().find(r => r.id === id);
    expect(byId(act.row.id).pruned_at).toBeNull();
    expect(byId(unk.row.id).pruned_at).toBeNull();
    expect(byId(done.row.id).pruned_at).not.toBeNull();
    expect(existsSync(env.blobPath(sha(fill(6 * KB, 0x61))))).toBe(true);

    // 把刚写的那条也变成 pending（还没落定的受保护），此时全受保护：新覆盖被拒
    env.db.prepare("UPDATE file_checkpoints SET state='pending' WHERE session_id=?").run(sNew);
    const f = join(env.userDir, 'n2.bin');
    const original = fill(6 * KB, 0x65);
    writeFileSync(f, original);
    const before = env.snapshotOf(f)!;
    const r = await env.runTool(sNew, 'file_write', { path: f, content: 'nope' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('空间已用满');
    const after = env.snapshotOf(f)!;
    expect(after.bytes.equals(original) && after.ino === before.ino && after.mtimeNs === before.mtimeNs).toBe(true);
    expect(env.rows().filter(x => x.pruned_at !== null).map(x => x.id)).toEqual([done.row.id]);
    expect(env.store.usage().overQuota).toBe(false);
    act.handle.end({ state: 'completed', reason: 'end_turn' });
  });

  it('S5 31 天前的记录（注入 now）：被清，unknown 的也被清，活动 run 的不被清', async () => {
    let now = 1_800_000_000;
    const env = cpEnv('s5', { store: { now: () => now } });
    const sid = env.newSession(); const sAct = env.newSession();
    const a = await overwrite(env, sid, 'a.bin', fill(KB, 1));
    const u = await overwrite(env, sid, 'u.bin', fill(KB, 2));
    env.db.prepare("UPDATE file_checkpoints SET state='unknown' WHERE id=?").run(u.row.id);
    const act = await overwrite(env, sAct, 'act.bin', fill(KB, 3), 'x', { keepRunActive: true });
    now += 31 * 86400;
    env.store.prune();
    const byId = (id: string): any => env.rows().find(r => r.id === id);
    expect(byId(a.row.id).pruned_at).not.toBeNull();
    expect(byId(u.row.id).pruned_at).not.toBeNull();
    expect(byId(act.row.id).pruned_at).toBeNull();
    expect(env.blobFiles()).toEqual([sha(fill(KB, 3))]);
    act.handle.end({ state: 'completed', reason: 'end_turn' });
  });

  it('S6 blobs/ 下没登记的文件、tmp/ 下的文件：gc({ sweep: true }) 都删，有登记的不动；不带 sweep 时不删', async () => {
    const env = cpEnv('s6');
    const sid = env.newSession();
    const kept = fill(KB, 7);
    await overwrite(env, sid, 'a.bin', kept);
    const stray = join(env.cpDir, 'blobs', 'zz', 'z'.repeat(64));
    mkdirSync(join(env.cpDir, 'blobs', 'zz'), { recursive: true });
    writeFileSync(stray, 'stray');
    const tmp = join(env.cpDir, 'tmp', 'leftover');
    writeFileSync(tmp, 'tmp');
    env.store.gc();
    expect(existsSync(stray) && existsSync(tmp)).toBe(true);
    env.store.gc({ sweep: true });
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(env.blobPath(sha(kept)))).toBe(true);
  });

  it('S7 setQuota 越界抛错、设置不变；合法值写进设置', () => {
    const env = cpEnv('s7');
    const before = env.store.usage().quotaBytes;
    expect(before).toBe(1024 * 1024 * 1024);
    for (const bad of [1, 128 * 1024 * 1024 - 1, 64 * 1024 * 1024 * 1024 + 1, 1.5e9 + 0.5, Number.NaN]) {
      expect(() => env.store.setQuota(bad)).toThrow();
    }
    expect(env.store.usage().quotaBytes).toBe(before);
    expect(env.db.prepare("SELECT value FROM settings WHERE key='checkpoints.quotaBytes'").get()).toBeUndefined();
    expect(env.store.setQuota(256 * 1024 * 1024).quotaBytes).toBe(256 * 1024 * 1024);
    // 直接改库改到下限之下：读出来被夹回下限
    env.db.prepare("UPDATE settings SET value='5' WHERE key='checkpoints.quotaBytes'").run();
    expect(env.store.usage().quotaBytes).toBe(128 * 1024 * 1024);
  });

  it('S8 删除会话：行没了；gc 后只被它引用的内容没了，被别的会话引用的还在', async () => {
    const env = cpEnv('s8');
    const s1 = env.newSession(); const s2 = env.newSession();
    const shared = fill(KB, 0x71); const only = fill(KB, 0x72);
    await overwrite(env, s1, 'shared1.bin', shared);
    await overwrite(env, s1, 'only.bin', only);
    await overwrite(env, s2, 'shared2.bin', shared);
    env.chat.deleteSession(s1);
    expect(env.rows(s1)).toEqual([]);
    expect(env.rows(s2)).toHaveLength(1);
    env.store.gc();
    expect(existsSync(env.blobPath(sha(only)))).toBe(false);
    expect(existsSync(env.blobPath(sha(shared)))).toBe(true);
  });

  it('S9 isPathReferenced：applied 为真（经大小写别名问结果相同）；恢复、清理、aborted 之后为假', async () => {
    const env = cpEnv('s9');
    const sid = env.newSession();
    const a = await overwrite(env, sid, 'Ref.txt', Buffer.from('v0'));
    expect(env.store.isPathReferenced(a.f)).toBe(true);
    if (process.platform === 'win32') expect(env.store.isPathReferenced(join(env.userDir, 'REF.TXT'))).toBe(true);
    expect(env.store.referencedPaths(sid)).toHaveLength(1);
    expect((await restoreOne(env, sid, a.row.id)).outcome).toBe('restored');
    expect(env.store.isPathReferenced(a.f)).toBe(false);

    const b = await overwrite(env, sid, 'Pruned.txt', Buffer.from('v0'));
    env.db.prepare('UPDATE file_checkpoints SET pruned_at=1, before_blob=NULL WHERE id=?').run(b.row.id);
    expect(env.store.isPathReferenced(b.f)).toBe(false);

    const c = await overwrite(env, sid, 'Aborted.txt', Buffer.from('v0'));
    env.db.prepare("UPDATE file_checkpoints SET state='aborted' WHERE id=?").run(c.row.id);
    expect(env.store.isPathReferenced(c.f)).toBe(false);
    expect(env.store.referencedPaths(sid)).toEqual([]);
  });

  it('S10 被清理项的恢复：pruned，文件不动；新建文件的记录没有内容，不受按容量清理影响，仍可恢复', async () => {
    let quota = 1024 * KB;
    const env = cpEnv('s10', { store: { quotaBytes: () => quota } });
    const sid = env.newSession();
    const created = join(env.userDir, 'created.txt');
    const cr = await env.runTool(sid, 'file_write', { path: created, content: 'made' });
    expect(cr.row.before_exists).toBe(0);
    const a = await overwrite(env, sid, 'a.bin', fill(4 * KB, 9));
    quota = 1;
    env.store.prune();
    expect(env.rows(sid).find(r => r.id === a.row.id).pruned_at).not.toBeNull();
    expect(env.rows(sid).find(r => r.id === cr.row.id).pruned_at).toBeNull();
    const item = await restoreOne(env, sid, a.row.id);
    expect(item).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'pruned' } });
    expect(readFileSync(a.f, 'utf8')).toBe('new a.bin');
    expect((await restoreOne(env, sid, cr.row.id)).outcome).toBe('deleted');
    expect(existsSync(created)).toBe(false);
  });

  it('S11 迁移：两张表与索引存在，user_version 等于迁移条数', () => {
    const env = cpEnv('s11');
    const names = (env.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%checkpoint%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
    for (const n of ['file_checkpoints', 'checkpoint_blobs', 'idx_file_checkpoints_session', 'idx_file_checkpoints_path',
      'idx_file_checkpoints_execution', 'idx_file_checkpoints_before_blob', 'idx_file_checkpoints_after_blob']) expect(names).toContain(n);
    expect(env.db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });

  it('S12 唯一引用在本次 prepare 的保留期清理里被清掉：新记录的内容文件在盘上，恢复得到原始字节', async () => {
    let now = 1_800_000_000;
    const env = cpEnv('s12', { store: { now: () => now } });
    const sid = env.newSession();
    const H0 = fill(4 * KB, 0x30);
    const registeredAt = now;
    const first = await overwrite(env, sid, 'F.bin', H0);
    expect((await restoreOne(env, sid, first.row.id)).outcome).toBe('restored');   // F 回到 H0；这条旧记录是 H0 的唯一引用
    now += 31 * 86400;
    const r = await env.runTool(sid, 'file_write', { path: first.f, content: 'second write' });   // 写入前仍是 H0
    expect(r.success, r.output).toBe(true);
    // 这次清理里 H0 失去了唯一的引用，而它正是本次要引用的内容：登记行与文件原样留着，不是删掉之后再重写一遍
    expect(env.io.callsOf('unlink', p => p === env.blobPath(sha(H0)))).toEqual([]);
    expect(env.db.prepare('SELECT created_at FROM checkpoint_blobs WHERE hash=?').get(sha(H0))).toEqual({ created_at: registeredAt });
    const rows = env.rows(sid);
    expect(rows[0].pruned_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ state: 'applied', before_blob: sha(H0) });
    expect(readFileSync(env.blobPath(sha(H0))).equals(H0)).toBe(true);
    expect((await restoreOne(env, sid, rows[1].id)).outcome).toBe('restored');
    expect(readFileSync(first.f).equals(H0)).toBe(true);
  });

  it('S12b 容量挤掉旧记录、而本次要引用的正是它放掉的那份内容：登记行与文件都留着，新记录可恢复', async () => {
    let quota = 1024 * KB;
    const env = cpEnv('s12b', { store: { quotaBytes: () => quota } });
    const sid = env.newSession();
    const H0 = fill(4 * KB, 0x31);
    const first = await overwrite(env, sid, 'F.bin', H0);
    writeFileSync(first.f, H0);                    // 用户把文件改回原内容；旧记录仍是 H0 的唯一引用
    const other = await overwrite(env, sid, 'G.bin', fill(4 * KB, 0x32));
    quota = 5 * KB;                                // 已占 8 KB：这次 prepare 的清理会挤掉最旧的 first（放掉 H0），而本次的写入前正是 H0
    const r = await env.runTool(sid, 'file_write', { path: first.f, content: 'again' });
    expect(r.success, r.output).toBe(true);
    const rows = env.rows(sid);
    expect(rows.find(x => x.id === first.row.id).pruned_at).not.toBeNull();
    expect(r.row).toMatchObject({ state: 'applied', before_blob: sha(H0) });
    expect(readFileSync(env.blobPath(sha(H0))).equals(H0)).toBe(true);
    expect((await restoreOne(env, sid, r.row.id)).outcome).toBe('restored');
    expect(readFileSync(first.f).equals(H0)).toBe(true);
    expect(other.row.id).toBeDefined();
  });

  it('S13 登记行在、内容文件被删：同内容的下一次覆盖把内容文件重建；两条记录都能恢复出原字节', async () => {
    const env = cpEnv('s13');
    const sid = env.newSession();
    const H = fill(2 * KB, 0x55);
    const f1 = await overwrite(env, sid, 'F1.bin', H);
    rmSync(env.blobPath(sha(H)));
    const f2 = await overwrite(env, sid, 'F2.bin', H);
    expect(sha(readFileSync(env.blobPath(sha(H))))).toBe(sha(H));
    expect((await restoreOne(env, sid, f2.row.id)).outcome).toBe('restored');
    expect(readFileSync(f2.f).equals(H)).toBe(true);
    expect((await restoreOne(env, sid, f1.row.id)).outcome).toBe('restored');
    expect(readFileSync(f1.f).equals(H)).toBe(true);
  });

  it('S14 S13 的状态下重建失败（检查点目录写满）：工具失败、文案含「检查点」，目标一个字节没动、没被替换，没有新行', async () => {
    const env = cpEnv('s14');
    const sid = env.newSession();
    const H = fill(2 * KB, 0x56);
    await overwrite(env, sid, 'F1.bin', H);
    rmSync(env.blobPath(sha(H)));
    const f2 = join(env.userDir, 'F2.bin');
    writeFileSync(f2, H);
    const before = env.snapshotOf(f2)!;
    env.io.fail('writeDurable', p => p.startsWith(env.cpDir), 'ENOSPC');
    const r = await env.runTool(sid, 'file_write', { path: f2, content: 'nope' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('检查点');
    const after = env.snapshotOf(f2)!;
    expect(after.bytes.equals(H) && after.ino === before.ino && after.mtimeNs === before.mtimeNs).toBe(true);
    expect(env.rows(sid)).toHaveLength(1);
  });

  it('S15 blobs/ 下有同名、同大小、内容不对且没登记的残留文件：被重写成正确内容，恢复得到原始字节', async () => {
    const env = cpEnv('s15');
    const sid = env.newSession();
    const H = fill(2 * KB, 0x57);
    mkdirSync(join(env.cpDir, 'blobs', sha(H).slice(0, 2)), { recursive: true });
    writeFileSync(env.blobPath(sha(H)), fill(2 * KB, 0x00));   // 上次崩溃的残留：名字、大小都对，内容不对
    const a = await overwrite(env, sid, 'F.bin', H);
    expect(readFileSync(env.blobPath(sha(H))).equals(H)).toBe(true);
    expect((await restoreOne(env, sid, a.row.id)).outcome).toBe('restored');
    expect(readFileSync(a.f).equals(H)).toBe(true);
  });

  it('S16 提交前内容文件不见了（对内容文件的最后一次 lstat 返回不存在）：CheckpointError(io)，目标不变，没有行', () => {
    const env = cpEnv('s16');
    const sid = env.newSession();
    const H = fill(KB, 0x58);
    const blob = env.blobPath(sha(H));
    env.io.replace('lstat', base => p => (p === blob ? undefined : base(p)));
    let err: unknown;
    try {
      env.store.prepare({ sessionId: sid, requestedPath: 'x', path: 'x', pathKey: 'x', before: { bytes: H, hash: sha(H), mode: 0o666 }, afterHash: sha('n'), afterSize: 1, tmpPath: 'x.tmp' });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CheckpointError);
    expect((err as CheckpointError).code).toBe('io');
    expect(env.rows()).toEqual([]);
  });

  it('S17 beginRestore 走同一段逻辑：「写入后」的哈希已登记而内容文件被删，恢复照样成功、内容文件被重建，另存得到写入后的字节', async () => {
    const env = cpEnv('s17');
    const sid = env.newSession();
    const v0 = Buffer.from('version zero\n'); const v1 = 'version one\n';
    const a = await overwrite(env, sid, 'F.txt', v0, v1);              // cp1：v0 → v1
    const r2 = await env.runTool(sid, 'file_write', { path: a.f, content: 'version two\n' });   // cp2：写入前是 v1（已登记）
    expect((await restoreOne(env, sid, r2.row.id)).outcome).toBe('restored');                   // 文件回到 v1
    rmSync(env.blobPath(sha(v1)));                                       // v1 的登记行在、文件没了
    const item = await restoreOne(env, sid, a.row.id);                   // 恢复 cp1：要先把当前的 v1 存进检查点
    expect(item.outcome).toBe('restored');
    expect(readFileSync(a.f).equals(v0)).toBe(true);
    expect(readFileSync(env.blobPath(sha(v1)), 'utf8')).toBe(v1);
    const copy = env.service.saveCopy(sid, a.row.id, 'after');
    expect(readFileSync(copy.path, 'utf8')).toBe(v1);
  });

  it('S18 逐条清理：三条记录各占一份内容，配额只差一份的空间——只清最旧的一条，另两条仍可恢复', async () => {
    let quota = 1024 * KB;
    const env = cpEnv('s18', { store: { quotaBytes: () => quota } });
    const sid = env.newSession();
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await overwrite(env, sid, `f${i}.bin`, fill(4 * KB, 0x80 + i)));
    quota = 8 * KB;
    expect(env.store.prune()).toBe(1);
    const rows = env.rows(sid);
    expect(rows.map(r => r.pruned_at !== null)).toEqual([true, false, false]);
    for (const m of made.slice(1)) {
      expect((await restoreOne(env, sid, m.row.id)).outcome).toBe('restored');
      expect(readFileSync(m.f).length).toBe(4 * KB);
    }
  });

  it('S19 删会话时还记着残留临时文件的行不直接删：留成不带内容的占位；别的会话随后写同一个文件——残留被补删、写入成功、占位行也没了', async () => {
    const env = cpEnv('s19');
    const s1 = env.newSession(); const s2 = env.newSession();
    const f = join(env.userDir, 'made.txt');
    // 新建文件时「硬链接成功、删临时文件失败」：目标带着两个链接留下，临时文件的路径记在行上
    env.io.replace('linkExclusive', () => (from, to) => linkSync(from, to));
    const r = await env.runTool(s1, 'file_write', { path: f, content: 'first line\n' });
    expect(r.success, r.output).toBe(true);
    const tmp = r.row.tmp_path as string;
    expect(existsSync(tmp)).toBe(true);
    expect(env.snapshotOf(f)!.nlink).toBe(2);
    env.io.reset();
    // 同一个会话里另有一条普通记录（没有残留）：照常随会话删掉
    await overwrite(env, s1, 'plain.bin', fill(KB, 0x55));
    env.chat.deleteSession(s1);
    // 会话的记录不再可见、不再占内容；记着临时文件的那一行还在，是一条占位
    const left = env.rows(s1);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: r.row.id, state: 'aborted', abort_reason: 'session-deleted', tmp_path: tmp, before_blob: null, after_blob: null, restoring_at: null });
    expect(env.store.listSession(s1)).toEqual([]);
    env.store.gc();
    expect(env.blobFiles()).toEqual([]);                        // plain.bin 的原内容不再被任何记录引用
    expect(env.store.isPathReferenced(f)).toBe(false);
    // 另一个会话写这个文件：先补删记录在案的残留，不报「有 2 个硬链接」
    const e = await env.runTool(s2, 'file_edit', { path: f, old_string: 'first', new_string: 'second' });
    expect(e.success, e.output).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('second line\n');
    expect(existsSync(tmp)).toBe(false);
    expect(readdirSync(env.userDir).filter(n => n.startsWith('.dm-'))).toEqual([]);
    expect(env.snapshotOf(f)!.nlink).toBe(1);
    expect(env.rows(s1)).toEqual([]);                           // 临时文件确认不在了：占位行也删掉
    // 占位行不算「之后的改动」：那个会话已删，s2 这一条可以正常恢复
    expect((await restoreOne(env, s2, e.row.id)).outcome).toBe('restored');
    expect(readFileSync(f, 'utf8')).toBe('first line\n');
  });

  it('S19b 覆盖写入留下的残留临时文件（改名失败、临时文件一时删不掉）：删会话后占位行还记着它，下一次对账补删并删掉占位行；删不掉时占位行留着', async () => {
    const env = cpEnv('s19b');
    const sid = env.newSession();
    const f = join(env.userDir, 'busy.txt');
    writeFileSync(f, 'original\n');
    env.io.fail('rename', p => p === f, 'EIO');                 // 不是占用类的错：不回落，写入失败、文件未动
    env.io.fail('unlink', p => p.includes('.dm-'), 'EPERM');    // 临时文件一时删不掉
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'next\n' });
    expect(r.success).toBe(false);
    expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'write-failed' });
    const tmp = r.row.tmp_path as string;
    expect(tmp).not.toBeNull();
    expect(existsSync(tmp)).toBe(true);
    env.chat.deleteSession(sid);
    expect(env.rows(sid)).toHaveLength(1);
    expect(env.rows(sid)[0]).toMatchObject({ abort_reason: 'session-deleted', tmp_path: tmp });
    // 还是删不掉：占位行留着，下次再试
    env.store.reconcile();
    expect(existsSync(tmp)).toBe(true);
    expect(env.rows(sid)).toHaveLength(1);
    env.io.reset();
    env.store.reconcile();
    expect(existsSync(tmp)).toBe(false);
    expect(env.rows(sid)).toEqual([]);
    expect(readFileSync(f, 'utf8')).toBe('original\n');
    // 没有残留的普通 aborted 行不受这条规则影响（不会被对账删掉）
    const s2 = env.newSession();
    env.io.fail('rename', p => p === f, 'EIO');
    const r2 = await env.runTool(s2, 'file_write', { path: f, content: 'next\n' });
    env.io.reset();
    expect(r2.row).toMatchObject({ state: 'aborted', tmp_path: null });
    env.store.reconcile();
    expect(env.rows(s2)).toHaveLength(1);
  });

  it('S20 coveredToolUseIds：有记录的调用，加上由带检查点的引擎执行、没有留下记录的写调用（内容相同）；早于启用代次的执行与别的会话的不算', async () => {
    const env = cpEnv('s20');
    const sid = env.newSession(); const other = env.newSession();
    const f = join(env.userDir, 'same.txt');
    writeFileSync(f, 'unchanged\n');
    const changed = await overwrite(env, sid, 'a.bin', fill(KB, 0x61));
    const same = await env.runTool(sid, 'file_write', { path: f, content: 'unchanged\n' });   // 内容相同：成功、没有记录
    expect(same.success).toBe(true);
    expect(same.rows).toEqual([]);
    // 夹具的 toolUseId 按「会话内第几次运行」编号：让另一个会话多跑两次，取一个本会话没有的 id
    await overwrite(env, other, 'b1.bin', fill(KB, 0x62));
    await overwrite(env, other, 'b2.bin', fill(KB, 0x63));
    const elsewhere = await overwrite(env, other, 'b3.bin', fill(KB, 0x64));
    const tu = (row: any): string => row.tool_use_id as string;
    expect([tu(changed.row), same.exec.tool_use_id]).not.toContain(tu(elsewhere.row));
    expect(env.service.list(sid).coveredToolUseIds.sort()).toEqual([tu(changed.row), same.exec.tool_use_id].sort());
    expect(env.service.list(sid).coveredToolUseIds).not.toContain(tu(elsewhere.row));
    // 那次没有记录的调用不在清单里（它没有改动文件）
    expect(env.service.list(sid).groups.flatMap(g => g.changes).map(c => c.toolUseId)).toEqual([tu(changed.row)]);
    // 早于检查点启用代次的执行（不带检查点的引擎做的）：没有记录不代表没有改动，不算已覆盖
    env.db.prepare('UPDATE tool_executions SET epoch=? WHERE id=?').run(env.ledger.epoch - 1, same.exec.id);
    expect(env.store.coveredToolUseIds(sid)).toEqual([tu(changed.row)]);
    // 启用代次没写成：只按有记录的算
    env.db.prepare('UPDATE tool_executions SET epoch=? WHERE id=?').run(env.ledger.epoch, same.exec.id);
    env.db.prepare("DELETE FROM settings WHERE key='checkpoints.sinceEpoch'").run();
    expect(env.store.coveredToolUseIds(sid)).toEqual([tu(changed.row)]);
  });

  it('S21 恢复时存下的「写入后」内容只被 after_blob 引用：内容回收（gc、看清单时的清理）不删它，另存「改动后」得到那份字节；记录放掉引用之后才回收', async () => {
    const env = cpEnv('s21');
    const sid = env.newSession();
    const f = join(env.userDir, 'made.txt');
    const made = 'the agent created this\n';
    const c = await env.runTool(sid, 'file_write', { path: f, content: made });   // 新建：没有写入前的内容
    expect(c.success, c.output).toBe(true);
    expect((await restoreOne(env, sid, c.row.id)).outcome).toBe('deleted');
    expect(env.rows(sid)[0]).toMatchObject({ state: 'restored', before_blob: null, after_blob: sha(made) });
    expect(env.store.gc()).toBe(0);
    env.service.list(sid);                                  // 进门先清理（含内容回收）
    expect(readFileSync(env.blobPath(sha(made)), 'utf8')).toBe(made);
    expect(env.store.usage()).toMatchObject({ usedBytes: Buffer.byteLength(made), blobCount: 1 });
    expect(readFileSync(env.service.saveCopy(sid, c.row.id, 'after').path, 'utf8')).toBe(made);
    env.db.prepare('UPDATE file_checkpoints SET pruned_at=1, before_blob=NULL, after_blob=NULL WHERE id=?').run(c.row.id);
    expect(env.store.gc()).toBe(1);
    expect(existsSync(env.blobPath(sha(made)))).toBe(false);
  });

  it('S22 按容量清掉一条记录时，它放掉的内容还被另一条记录的 after_blob 指着（那条记录恢复时存下的「写入后」）：内容不删，那条记录另存「改动后」仍得到原字节', async () => {
    let quota = 1024 * KB;
    const env = cpEnv('s22', { store: { quotaBytes: () => quota } });
    const s1 = env.newSession(); const s2 = env.newSession();
    const C0 = fill(4 * KB, 0x41);
    const p = await overwrite(env, s1, 'F1.bin', C0);                           // P：写入前是 C0（before_blob = C0）
    const f2 = join(env.userDir, 'F2.bin');
    writeFileSync(f2, fill(KB, 0x42));
    // Q：把 C0 写进 F2 再恢复——恢复时存下的「写入后」正是 C0（after_blob = C0）。它的运行不结束：这条记录受保护
    const q = await env.runTool(s2, 'file_write', { path: f2, content: C0.toString('utf8') }, { keepRunActive: true });
    expect(q.success, q.output).toBe(true);
    expect((await restoreOne(env, s2, q.row.id)).outcome).toBe('restored');
    expect(env.rows(s2)[0]).toMatchObject({ state: 'restored', after_blob: sha(C0) });
    expect(env.store.usage().usedBytes).toBe(5 * KB);
    quota = 4 * KB;                                                               // 已占 5 KB：要清。P 最旧、可清；Q 受保护
    expect(env.store.prune()).toBe(1);
    expect(env.rows(s1).find(r => r.id === p.row.id).pruned_at).not.toBeNull();
    expect(env.rows(s2)[0].pruned_at).toBeNull();
    expect(readFileSync(env.blobPath(sha(C0))).equals(C0)).toBe(true);
    expect(env.store.usage().usedBytes).toBe(5 * KB);
    expect(readFileSync(env.service.saveCopy(s2, q.row.id, 'after').path).equals(C0)).toBe(true);
    q.handle.end({ state: 'completed', reason: 'end_turn' });
  });
});
