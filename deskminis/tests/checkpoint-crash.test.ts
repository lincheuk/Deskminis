/**
 * F08 K 组（进程内崩溃模型）：在指定注入点同步取库快照（那一刻已提交状态的完整副本），此后每个文件操作都抛——
 * 磁盘停在那一刻；再在快照上开下一代存储做对账。原进程后续写进旧库的东西不在快照里。
 * 它模拟的是「已提交状态」；真实进程的强杀在 checkpoint-crash-process.test.ts。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, linkSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IoPoint } from '../src/minisd/checkpoints/fs';
import { closeAllCpEnvs, cpEnv, nextGeneration, sha, type CpEnv } from './checkpoint-fixture';

const gens: { close(): void }[] = [];
afterEach(() => { for (const g of gens.splice(0)) g.close(); closeAllCpEnvs(); });
const dmFiles = (dir: string): string[] => readdirSync(dir).filter(n => n.startsWith('.dm-'));
const ORIGINAL = 'original content\n';
const NEXT = 'content the agent wanted\n';

/** 下一代：在崩溃那一刻的库快照上开新存储。 */
function reboot(env: CpEnv, snapshot = env.io.crashedSnapshot()) {
  if (snapshot === undefined) throw new Error('没有取到崩溃快照（注入点没被走到）');
  const g = nextGeneration(env, snapshot);
  gens.push(g);
  return { ...g, rows: (): any[] => g.db.prepare('SELECT * FROM file_checkpoints ORDER BY seq').all() };
}
/** 一次覆盖写入在 point 处崩溃。 */
async function crashWrite(label: string, point: IoPoint, o: { create?: boolean } = {}) {
  const env = cpEnv(label); const sid = env.newSession();
  const f = join(env.userDir, 'target.txt');
  if (!o.create) writeFileSync(f, ORIGINAL);
  env.io.crash(point, () => env.snapshotDb());
  const r = await env.runTool(sid, 'file_write', { path: f, content: NEXT });
  return { env, sid, f, r };
}
/** 一次恢复在 point 处崩溃（先正常写入一次）。 */
async function crashRestore(label: string, point: IoPoint) {
  const env = cpEnv(label); const sid = env.newSession();
  const f = join(env.userDir, 'target.txt');
  writeFileSync(f, ORIGINAL);
  const w = await env.runTool(sid, 'file_write', { path: f, content: NEXT });
  env.io.crash(point, () => env.snapshotDb());
  const rep = await env.service.restore(sid, [w.row.id]);
  return { env, sid, f, id: w.row.id as string, rep };
}

describe('F08 K 组：崩溃后的对账（进程内模型）', () => {
  it('K1 内容文件已写、记录未提交：没有行，目标是旧内容，残留的内容文件被启动清扫删掉', async () => {
    const env = cpEnv('k1', { store: { commit: () => { throw new Error('crashed before commit'); } } }); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, ORIGINAL);
    await env.runTool(sid, 'file_write', { path: f, content: NEXT });
    expect(env.blobFiles()).toEqual([sha(ORIGINAL)]);          // 内容文件已落盘
    const g = reboot(env, env.snapshotDb());
    expect(g.store.reconcile()).toEqual([]);
    expect(g.rows()).toEqual([]);
    expect(readFileSync(f, 'utf8')).toBe(ORIGINAL);
    g.store.gc({ sweep: true });
    expect(env.blobFiles()).toEqual([]);
  });

  it('K2 崩溃在记录已提交、临时文件未写：行 aborted / interrupted，目标是旧内容', async () => {
    const { env, f } = await crashWrite('k2', 'after-prepare');
    const g = reboot(env);
    expect(g.rows()[0].state).toBe('pending');                  // 目标 IO 之前记录已持久
    const settled = g.store.reconcile();
    expect(settled).toHaveLength(1);
    expect(g.rows()[0]).toMatchObject({ state: 'aborted', abort_reason: 'interrupted', before_blob: null });
    expect(readFileSync(f, 'utf8')).toBe(ORIGINAL);
  });

  it('K3 崩溃在替换之前（临时文件已写）：行 aborted，目标是旧内容，临时文件被清', async () => {
    const { env, f } = await crashWrite('k3', 'after-tmp');
    expect(dmFiles(env.userDir)).toHaveLength(1);               // 磁盘停在那一刻：临时文件还在
    const g = reboot(env);
    expect(g.rows()[0].state).toBe('pending');
    g.store.reconcile();
    expect(g.rows()[0]).toMatchObject({ state: 'aborted', abort_reason: 'interrupted', tmp_path: null });
    expect(readFileSync(f, 'utf8')).toBe(ORIGINAL);
    expect(dmFiles(env.userDir)).toEqual([]);
  });

  it('K4 崩溃在替换之后、记 applied 之前：行 applied、带文件 ID，目标是新内容；随后恢复得到原字节', async () => {
    const { env, sid, f } = await crashWrite('k4', 'after-replace');
    const g = reboot(env);
    expect(g.rows()[0].state).toBe('pending');
    g.store.reconcile();
    expect(g.rows()[0]).toMatchObject({ state: 'applied', detail: 'reconciled', file_ino: env.snapshotOf(f)!.ino });
    expect(readFileSync(f, 'utf8')).toBe(NEXT);
    expect((await g.service.restore(sid, [g.rows()[0].id])).items[0].outcome).toBe('restored');
    expect(readFileSync(f, 'utf8')).toBe(ORIGINAL);
  });

  it('K5 K3 之后、对账之前目标被改成第三种内容：行 unknown，文件是第三种内容；另存得到原字节；恢复得 unknown-state', async () => {
    const { env, sid, f } = await crashWrite('k5', 'after-tmp');
    writeFileSync(f, 'a third version nobody recorded\n');
    const g = reboot(env);
    g.store.reconcile();
    const row = g.rows()[0];
    expect(row.state).toBe('unknown');
    expect(row.before_blob).toBe(sha(ORIGINAL));                // 写入前的内容保留
    expect(readFileSync(g.service.saveCopy(sid, row.id, 'before').path, 'utf8')).toBe(ORIGINAL);
    expect((await g.service.restore(sid, [row.id])).items[0]).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'unknown-state' } });
    expect(readFileSync(f, 'utf8')).toBe('a third version nobody recorded\n');
  });

  it.each(['restore-after-mark', 'restore-after-tmp'] as const)('K6 恢复崩溃在 %s：行仍 applied、「恢复中」已清，目标是写入后的内容，临时文件被清', async (point) => {
    const { env, f } = await crashRestore(`k6-${point}`, point);
    const g = reboot(env);
    expect(g.rows()[0].restoring_at).not.toBeNull();
    g.store.reconcile();
    expect(g.rows()[0]).toMatchObject({ state: 'applied', restoring_at: null, restore_tmp_path: null });
    expect(readFileSync(f, 'utf8')).toBe(NEXT);
    expect(dmFiles(env.userDir)).toEqual([]);
  });

  it('K7 恢复崩溃在替换之后：行 restored，目标是原字节', async () => {
    const { env, f } = await crashRestore('k7', 'restore-after-replace');
    const g = reboot(env);
    expect(g.rows()[0]).toMatchObject({ state: 'applied' });
    expect(g.rows()[0].restoring_at).not.toBeNull();
    g.store.reconcile();
    expect(g.rows()[0]).toMatchObject({ state: 'restored', restoring_at: null });
    expect(g.rows()[0].restored_ino).toBe(env.snapshotOf(f)!.ino);
    expect(readFileSync(f, 'utf8')).toBe(ORIGINAL);
  });

  it('K8 新建文件的写入在替换之后崩溃：行 applied；恢复后文件被删', async () => {
    const { env, sid, f } = await crashWrite('k8', 'after-replace', { create: true });
    const g = reboot(env);
    g.store.reconcile();
    expect(g.rows()[0]).toMatchObject({ state: 'applied', before_exists: 0 });
    expect((await g.service.restore(sid, [g.rows()[0].id])).items[0].outcome).toBe('deleted');
    expect(existsSync(f)).toBe(false);
    expect(dmFiles(env.userDir)).toEqual([]);
  });

  it('K8b 新建文件的写入在替换之前崩溃：行 aborted，文件不存在，临时文件被清', async () => {
    const { env, f } = await crashWrite('k8b', 'after-tmp', { create: true });
    const g = reboot(env);
    g.store.reconcile();
    expect(g.rows()[0]).toMatchObject({ state: 'aborted', abort_reason: 'interrupted' });
    expect(existsSync(f)).toBe(false);
    expect(dmFiles(env.userDir)).toEqual([]);
  });

  it('K9 对账跑两次：第二次零改动', async () => {
    const { env } = await crashWrite('k9', 'after-replace');
    const g = reboot(env);
    expect(g.store.reconcile()).toHaveLength(1);
    const once = JSON.stringify(g.rows());
    expect(g.store.reconcile()).toEqual([]);
    expect(JSON.stringify(g.rows())).toBe(once);
  });

  it('K10 对账时某一行的路径读不了：该行 unknown，其余行照常，不抛', async () => {
    const env = cpEnv('k10'); const sid = env.newSession();
    const a = join(env.userDir, 'a.txt'); const b = join(env.userDir, 'b.txt');
    writeFileSync(a, ORIGINAL); writeFileSync(b, ORIGINAL);
    await env.runTool(sid, 'file_write', { path: a, content: NEXT });
    await env.runTool(sid, 'file_write', { path: b, content: NEXT });
    env.db.prepare("UPDATE file_checkpoints SET state='pending', applied_at=NULL").run();   // 两条都退回「替换后、applied 没写进库」
    const g = reboot(env, env.snapshotDb());
    g.io.fail('lstat', p => p === a, 'EIO');
    expect(() => g.store.reconcile()).not.toThrow();
    expect(g.rows().map(r => r.state)).toEqual(['unknown', 'applied']);
  });

  it('K11 原地覆盖写到一半崩溃：行 unknown；另存得到原字节；恢复得 unknown-state', async () => {
    const env = cpEnv('k11'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, ORIGINAL);
    env.io.fail('rename', p => p === f, 'EPERM');
    env.io.crash('before-inplace', () => { writeFileSync(f, NEXT.slice(0, 6)); return env.snapshotDb(); });   // 半截文件留在盘上
    await env.runTool(sid, 'file_write', { path: f, content: NEXT });
    const g = reboot(env);
    g.store.reconcile();
    const row = g.rows()[0];
    expect(row.state).toBe('unknown');
    expect(readFileSync(g.service.saveCopy(sid, row.id, 'before').path, 'utf8')).toBe(ORIGINAL);
    expect((await g.service.restore(sid, [row.id])).items[0]).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'unknown-state' } });
    expect(readFileSync(f, 'utf8')).toBe(NEXT.slice(0, 6));
  });

  it('K12 恢复的原地覆盖写到一半崩溃：行 unknown；另存「改动前」「改动后」各得到两头的字节', async () => {
    const env = cpEnv('k12'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, ORIGINAL);
    const w = await env.runTool(sid, 'file_write', { path: f, content: NEXT });
    env.io.fail('rename', p => p === f, 'EPERM');
    env.io.crash('restore-before-inplace', () => { writeFileSync(f, ORIGINAL.slice(0, 4)); return env.snapshotDb(); });
    await env.service.restore(sid, [w.row.id]);
    const g = reboot(env);
    g.store.reconcile();
    const row = g.rows()[0];
    expect(row.state).toBe('unknown');
    expect(readFileSync(g.service.saveCopy(sid, row.id, 'before').path, 'utf8')).toBe(ORIGINAL);
    expect(readFileSync(g.service.saveCopy(sid, row.id, 'after').path, 'utf8')).toBe(NEXT);
  });

  it('K13 对账补删残留：applied 行带着临时文件路径、文件还在——临时文件被删、该列清空、行仍 applied；删不掉时该列保留，下一次对账再试', async () => {
    const env = cpEnv('k13'); const sid = env.newSession();
    const f = join(env.userDir, 'made.txt');
    env.io.replace('linkExclusive', () => (from, to) => linkSync(from, to));   // 只建链接、不删临时文件
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'x\n' });
    const tmp = r.row.tmp_path as string;
    expect(existsSync(tmp)).toBe(true);
    env.io.reset();
    env.io.fail('unlink', p => p === tmp, 'EPERM');
    env.store.reconcile();
    expect(existsSync(tmp)).toBe(true);
    expect(env.rows()[0]).toMatchObject({ state: 'applied', tmp_path: tmp });
    env.io.reset();
    env.store.reconcile();
    expect(existsSync(tmp)).toBe(false);
    expect(env.rows()[0]).toMatchObject({ state: 'applied', tmp_path: null });
    expect(env.snapshotOf(f)!.nlink).toBe(1);
    // 只删库里记着的那一条：目录里别的 .dm-*.tmp 样子的文件不碰
    const stranger = join(env.userDir, '.dm-0123456789abcdef.tmp');
    writeFileSync(stranger, 'not ours');
    env.store.reconcile();
    expect(existsSync(stranger)).toBe(true);
  });

  it('K13b 行上记着的「临时文件」路径指向名字不是 .dm-<16 位十六进制>.tmp 的文件（行被改坏）：对账、按路径补删、看清单都不删它，该列留着', async () => {
    const env = cpEnv('k13b'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, ORIGINAL);
    const w = await env.runTool(sid, 'file_write', { path: f, content: NEXT });
    const precious = join(env.userDir, 'thesis-final.docx');
    const nearMiss = join(env.userDir, '.dm-0123456789abcdef.tmp.bak');
    writeFileSync(precious, 'the only copy');
    writeFileSync(nearMiss, 'also not ours');
    env.db.prepare('UPDATE file_checkpoints SET tmp_path=?, restore_tmp_path=? WHERE id=?').run(precious, nearMiss, w.row.id);
    env.store.reconcile();
    env.store.releaseTemps(w.row.path_key);
    env.service.list(sid);
    expect(readFileSync(precious, 'utf8')).toBe('the only copy');
    expect(readFileSync(nearMiss, 'utf8')).toBe('also not ours');
    expect(env.io.callsOf('unlink', p => p === precious || p === nearMiss)).toEqual([]);
    expect(env.rows()[0]).toMatchObject({ state: 'applied', tmp_path: precious, restore_tmp_path: nearMiss });
    expect(readFileSync(f, 'utf8')).toBe(NEXT);
  });
});

/**
 * 同进程里记录的状态写库失败（不是崩溃）：commit / restore 把它吞掉、留给对账收口。在下一次对账之前同一文件又被写了一次时，
 * 文件现在的内容与那一行的两头都对不上——对账要看后一条记录在动手前看到的内容，不能把一次完整生效的写入说成「被打断」。
 */
describe('F08 K 组：记录状态写库失败之后同一文件又被写入（对账看后一条记录的旁证）', () => {
  /** 存储的 tx 可以按次数注入失败（其余照常走账本）。 */
  function flakyEnv(label: string): { env: CpEnv; failNext(n?: number): void; left(): number } {
    let fail = 0;
    const env: CpEnv = cpEnv(label, { store: { tx: fn => { if (fail > 0) { fail -= 1; throw new Error('SQLITE_BUSY: database is locked'); } return env.ledger.atomic(fn); } } });
    return { env, failNext: (n = 1) => { fail = n; }, left: () => fail };
  }
  const state = (env: CpEnv, id: string): any => env.rows().find(r => r.id === id);

  it('K14 applied 的写库失败（行停在 pending，文件其实已是新内容）之后再写一次：对账把前一条落成 applied，不是 unknown；整条链恢复到最初的字节', async () => {
    const { env, failNext, left } = flakyEnv('k14'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, 'v0\n');
    failNext();
    const w1 = await env.runTool(sid, 'file_write', { path: f, content: 'v1\n' });
    expect(w1.success, w1.output).toBe(true);                  // 文件已替换：不因为记录没写成而说失败
    expect(left()).toBe(0);                                    // 注入的那一次失败确实打在 applied 上
    expect(w1.row.state).toBe('pending');
    const w2 = await env.runTool(sid, 'file_write', { path: f, content: 'v2\n' });
    expect(w2.row).toMatchObject({ state: 'applied', before_hash: w1.row.after_hash });
    // 打开「改动」页（进门对账）：文件现在是 v2，与前一条的两头都对不上；后一条的写入前内容正是前一条写入的
    const listed = env.service.list(sid).groups.flatMap(g => g.changes);
    expect(listed.map(c => c.state)).toEqual(['applied', 'applied']);
    expect(state(env, w1.row.id)).toMatchObject({ state: 'applied', detail: 'reconciled-by-successor', file_ino: null, before_blob: sha('v0\n') });
    expect(env.service.inspect(sid, [w1.row.id, w2.row.id]).map(p => (p.verdict as any).reason ?? p.verdict.kind)).toEqual(['superseded', 'ready']);
    const rep = await env.service.restore(sid, [w1.row.id, w2.row.id]);
    expect(rep.items.map(i => i.outcome)).toEqual(['restored', 'restored']);
    expect(readFileSync(f, 'utf8')).toBe('v0\n');
  });

  it('K14b aborted 的写库失败（行停在 pending，文件没动）之后重试写入了同样的内容：对账把前一条落成 aborted——文件现在的内容恰好等于它要写的，也不算它生效过', async () => {
    const { env, failNext, left } = flakyEnv('k14b'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, 'v0\n');
    env.io.fail('rename', p => p === f, 'EIO');                // 不是占用类的错：不回落，写入失败、文件未动
    failNext();
    const w1 = await env.runTool(sid, 'file_write', { path: f, content: 'v1\n' });
    expect(w1.success).toBe(false);
    expect(left()).toBe(0);
    expect(w1.row.state).toBe('pending');
    expect(readFileSync(f, 'utf8')).toBe('v0\n');
    env.io.reset();
    const w2 = await env.runTool(sid, 'file_write', { path: f, content: 'v1\n' });   // 模型重试同样的内容
    expect(w2.row).toMatchObject({ state: 'applied', before_hash: sha('v0\n'), after_hash: w1.row.after_hash });
    const listed = env.service.list(sid).groups.flatMap(g => g.changes);
    expect(listed.map(c => c.id)).toEqual([w2.row.id]);        // 没生效的那一条不进清单
    expect(state(env, w1.row.id)).toMatchObject({ state: 'aborted', abort_reason: 'interrupted', before_blob: null });
    expect((await env.service.restore(sid, [w2.row.id])).items[0].outcome).toBe('restored');
    expect(readFileSync(f, 'utf8')).toBe('v0\n');
  });

  it('K15 恢复完成的写库失败（行停在「恢复中」，文件已是改动前的内容）之后再写一次：对账把它落成 restored，不是 unknown；更早就恢复过的后续记录不当旁证', async () => {
    const env = cpEnv('k15'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, 'v0\n');
    const cp1 = (await env.runTool(sid, 'file_write', { path: f, content: 'v1\n' })).row.id as string;
    const cp2 = (await env.runTool(sid, 'file_write', { path: f, content: 'v2\n' })).row.id as string;
    // cp2 先恢复掉：它排在 cp1 后面（seq 更大），写入前的内容正是 cp1 写入的——但它是在 cp1 的恢复开始之前建的，说明不了那次恢复的结果
    expect((await env.service.restore(sid, [cp2])).items[0].outcome).toBe('restored');
    const spy = vi.spyOn(env.store, 'finishRestore').mockImplementationOnce(() => { throw new Error('SQLITE_BUSY: database is locked'); });
    expect((await env.service.restore(sid, [cp1])).items[0].outcome).toBe('restored');   // 文件已恢复：不因为记录没写成而说失败
    spy.mockRestore();
    expect(readFileSync(f, 'utf8')).toBe('v0\n');
    expect(state(env, cp1).state).toBe('applied');
    expect(state(env, cp1).restoring_at).not.toBeNull();
    const w3 = await env.runTool(sid, 'file_write', { path: f, content: 'v3\n' });
    expect(w3.row).toMatchObject({ state: 'applied', before_hash: sha('v0\n') });
    env.service.list(sid);
    expect(state(env, cp1)).toMatchObject({ state: 'restored', restoring_at: null, before_blob: sha('v0\n') });
    expect(env.service.inspect(sid, [cp1])[0].verdict).toEqual({ kind: 'unavailable', reason: 'already-restored' });
    expect((await env.service.restore(sid, [w3.row.id])).items[0].outcome).toBe('restored');
    expect(readFileSync(f, 'utf8')).toBe('v0\n');
  });

  it('K15b 恢复没做成、撤掉「恢复中」的写库也失败（文件仍是写入后的内容）之后再写一次：对账只清「恢复中」、行仍 applied；整条链恢复到最初的字节', async () => {
    const env = cpEnv('k15b'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, 'v0\n');
    const cp1 = (await env.runTool(sid, 'file_write', { path: f, content: 'v1\n' })).row.id as string;
    env.io.fail('rename', p => p === f, 'EIO');                // 恢复时改名失败（不是占用类）：文件没动
    const spy = vi.spyOn(env.store, 'cancelRestore').mockImplementationOnce(() => { throw new Error('SQLITE_BUSY: database is locked'); });
    expect((await env.service.restore(sid, [cp1])).items[0].outcome).toBe('failed');
    spy.mockRestore(); env.io.reset();
    expect(readFileSync(f, 'utf8')).toBe('v1\n');
    expect(state(env, cp1).restoring_at).not.toBeNull();
    const cp2 = (await env.runTool(sid, 'file_write', { path: f, content: 'v2\n' })).row.id as string;
    env.service.list(sid);
    expect(state(env, cp1)).toMatchObject({ state: 'applied', restoring_at: null, restore_tmp_path: null });
    const rep = await env.service.restore(sid, [cp1, cp2]);
    expect(rep.items.map(i => i.outcome)).toEqual(['restored', 'restored']);
    expect(readFileSync(f, 'utf8')).toBe('v0\n');
    expect(dmFiles(env.userDir)).toEqual([]);
  });

  it('K16 对照：没有后一条记录时照旧按文件现在的内容判；后一条记录看到的两头都不是（中间被别的程序改过）时也是——判不出来仍是 unknown', async () => {
    const { env, failNext } = flakyEnv('k16'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, 'v0\n');
    failNext();
    const w1 = await env.runTool(sid, 'file_write', { path: f, content: 'v1\n' });
    expect(w1.row.state).toBe('pending');
    writeFileSync(f, 'edited by the user in between\n');       // 两次写入之间用户改了文件
    const w2 = await env.runTool(sid, 'file_write', { path: f, content: 'v2\n' });
    expect(w2.row.state).toBe('applied');
    env.service.list(sid);
    expect(state(env, w1.row.id).state).toBe('unknown');        // 后一条看到的既不是 v0 也不是 v1，文件现在是 v2：判不出来
    expect(readFileSync(env.service.saveCopy(sid, w1.row.id, 'before').path, 'utf8')).toBe('v0\n');
  });
});
