/**
 * F08 R 组：恢复协议——预检、取锁、锁内重判、先存后换、逐项结果、另存。
 * 断言以磁盘字节与库里的行为准。全部在临时目录上跑；没有任何用例动真实的用户文件。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitFileWrite } from '../src/minisd/checkpoints/commit';
import { planRunRestore, splitNotSent, summarizeReport } from '../src/renderer/src/lib/changes/model';
import { closeAllCpEnvs, cpEnv, holdOpen, junction, sha, type CpEnv } from './checkpoint-fixture';

const WIN = process.platform === 'win32';

// 子进程调用计数（R23）：node:child_process 的命名空间在 ESM 下不能 spy，整体换成「计数后转给原实现」的包装。
// 被测模块与夹具（holdOpen）拿到的都是这一份，行为不变。
const spawned = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const wrap = <F extends (...a: any[]) => any>(fn: F): F => ((...a: any[]) => { spawned.n += 1; return fn(...a); }) as F;
  return {
    ...real, spawn: wrap(real.spawn), spawnSync: wrap(real.spawnSync), exec: wrap(real.exec), execSync: wrap(real.execSync),
    execFile: wrap(real.execFile), execFileSync: wrap(real.execFileSync), fork: wrap(real.fork),
  };
});
const temps: string[] = [];
afterEach(() => {
  closeAllCpEnvs();
  for (const d of temps.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
});
const tmpDir = (label: string): string => { const d = mkdtempSync(join(tmpdir(), `dm-f08-r-${label}-`)); temps.push(d); return d; };
const noTemps = (dir: string): void => { expect(readdirSync(dir).filter(n => n.startsWith('.dm-'))).toEqual([]); };
const row = (env: CpEnv, id: string): any => env.rows().find(r => r.id === id);
const one = async (env: CpEnv, sid: string, id: string) => (await env.service.restore(sid, [id])).items[0];

/** 放一个文件并让 agent 覆盖它。 */
async function modified(env: CpEnv, sid: string, name: string, original = `original ${name}\n`, next = `agent wrote ${name}\n`) {
  const f = join(env.userDir, name);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, original);
  const r = await env.runTool(sid, 'file_write', { path: f, content: next });
  expect(r.success, r.output).toBe(true);
  return { f, id: r.row.id as string, original, next };
}
async function created(env: CpEnv, sid: string, name: string, content = `agent created ${name}\n`) {
  const f = join(env.userDir, name);
  const r = await env.runTool(sid, 'file_write', { path: f, content });
  expect(r.success, r.output).toBe(true);
  return { f, id: r.row.id as string, content };
}

describe('F08 R 组：冲突安全的恢复', () => {
  it('R1 写入后用户手改再恢复：冲突 / modified，磁盘上是用户的内容，行仍 applied；另存生成新文件、内容是原始字节', async () => {
    const env = cpEnv('r1'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    writeFileSync(m.f, 'the user kept working on it\n');
    const item = await one(env, sid, m.id);
    expect(item).toMatchObject({ outcome: 'conflict', verdict: { kind: 'conflict', reason: 'modified' } });
    expect(item.message).toContain('另存');
    expect(readFileSync(m.f, 'utf8')).toBe('the user kept working on it\n');
    expect(row(env, m.id)).toMatchObject({ state: 'applied', restoring_at: null });
    const copy = env.service.saveCopy(sid, m.id, 'before');
    expect(copy.path).not.toBe(m.f);
    expect(readFileSync(copy.path, 'utf8')).toBe(m.original);
    expect(readFileSync(m.f, 'utf8')).toBe('the user kept working on it\n');
    // 同样大小的手改也要认出来（不能只比大小）
    const m2 = await modified(env, sid, 'b.txt', 'original\n', 'AGENT-12\n');
    writeFileSync(m2.f, 'USER--34\n');
    expect(await one(env, sid, m2.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'modified' } });
    expect(readFileSync(m2.f, 'utf8')).toBe('USER--34\n');
  });

  it('R2 写入后文件被移走：冲突 / missing，原位置没有被新建文件，移走的那份不动', async () => {
    const env = cpEnv('r2'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const moved = join(env.userDir, 'moved-away.txt');
    renameSync(m.f, moved);
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'missing' } });
    expect(existsSync(m.f)).toBe(false);
    expect(readFileSync(moved, 'utf8')).toBe(m.next);
  });

  it('R3 被另一份不同内容的文件替换：冲突 / modified，不变', async () => {
    const env = cpEnv('r3'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const other = join(env.userDir, 'other.txt');
    writeFileSync(other, 'a different document\n');
    renameSync(other, m.f);
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'modified' } });
    expect(readFileSync(m.f, 'utf8')).toBe('a different document\n');
  });

  it('R4 被内容相同的另一份文件替换（文件 ID 不同）：冲突 / replaced，不变', async (ctx) => {
    const env = cpEnv('r4'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    if (row(env, m.id).file_ino === null) { console.log('F08-R4 跳过：这个文件系统取不到稳定的文件 ID'); ctx.skip(); return; }
    const twin = join(env.userDir, 'twin.txt');
    copyFileSync(m.f, twin);
    unlinkSync(m.f);
    renameSync(twin, m.f);
    const snap = env.snapshotOf(m.f);
    const item = await one(env, sid, m.id);
    expect(item).toMatchObject({ outcome: 'conflict', verdict: { reason: 'replaced' } });
    expect(item.message).toContain('另存');
    expect(env.snapshotOf(m.f)).toEqual(snap);
  });

  it('R5 原路径变成目录：冲突 / not-a-file', async () => {
    const env = cpEnv('r5'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    unlinkSync(m.f);
    mkdirSync(m.f);
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'not-a-file' } });
    expect(readdirSync(m.f)).toEqual([]);
  });

  it('R6 链接别名：经目录链接写入后把链接改指另一个目录，那里有一份内容完全相同的文件——冲突 / identity-changed，两处都不变', async () => {
    const env = cpEnv('r6'); const sid = env.newSession();
    const d1 = join(env.userDir, 'D1'); const d2 = join(env.userDir, 'D2'); const j = join(env.userDir, 'J');
    mkdirSync(d1); mkdirSync(d2);
    writeFileSync(join(d1, 'f.txt'), 'original\n');
    junction(d1, j);
    const r = await env.runTool(sid, 'file_write', { path: join(j, 'f.txt'), content: 'agent wrote\n' });
    expect(r.success, r.output).toBe(true);
    rmSync(j);
    junction(d2, j);
    writeFileSync(join(d2, 'f.txt'), 'agent wrote\n');   // 与写入后的内容完全相同
    const s1 = env.snapshotOf(join(d1, 'f.txt')); const s2 = env.snapshotOf(join(d2, 'f.txt'));
    // 工具当时给的路径（经链接）现在指向 D2：路径身份已变。只比内容的实现会去改 D2 里那份同内容的文件
    const item = await one(env, sid, r.row.id);
    expect(item).toMatchObject({ outcome: 'conflict', verdict: { kind: 'conflict', reason: 'identity-changed' } });
    expect(env.snapshotOf(join(d1, 'f.txt'))).toEqual(s1);
    expect(env.snapshotOf(join(d2, 'f.txt'))).toEqual(s2);
    expect(env.rows().find(x => x.id === r.row.id).state).toBe('applied');
  });

  it('R7 把写入时的目录自己换成指向另一个目录的链接：冲突 / identity-changed，那个目录里的同内容文件不变', async () => {
    const env = cpEnv('r7'); const sid = env.newSession();
    const d1 = join(env.userDir, 'D1'); const d2 = join(env.userDir, 'D2');
    mkdirSync(d1); mkdirSync(d2);
    writeFileSync(join(d1, 'f.txt'), 'original\n');
    const r = await env.runTool(sid, 'file_write', { path: join(d1, 'f.txt'), content: 'agent wrote\n' });
    expect(r.success, r.output).toBe(true);
    writeFileSync(join(d2, 'f.txt'), 'agent wrote\n');
    rmSync(d1, { recursive: true });
    junction(d2, d1);                                    // D1 现在是指向 D2 的链接
    const s2 = env.snapshotOf(join(d2, 'f.txt'));
    const item = await one(env, sid, r.row.id);
    expect(item).toMatchObject({ outcome: 'conflict', verdict: { reason: 'identity-changed' } });
    expect(env.snapshotOf(join(d2, 'f.txt'))).toEqual(s2);
    expect(row(env, r.row.id).state).toBe('applied');
  });

  it('R6b 记录里的真实路径与它的路径身份键对不上（行被改坏，指向别处一份内容完全相同的文件）：冲突 / identity-changed，预检也不说可以恢复，两处都不变', async () => {
    const env = cpEnv('r6b'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    mkdirSync(join(env.userDir, 'elsewhere'));
    const twin = join(env.userDir, 'elsewhere', 'a.txt');
    writeFileSync(twin, m.next);                         // 与写入后的内容完全相同：只比内容的实现会去改它
    env.db.prepare('UPDATE file_checkpoints SET path=? WHERE id=?').run(twin, m.id);
    const s1 = env.snapshotOf(m.f); const s2 = env.snapshotOf(twin);
    // 恢复对「记录里的真实路径」做 IO，而持有的写锁是按路径身份键取的：两者对不上就不能动手
    expect(env.service.inspect(sid, [m.id])[0].verdict).toEqual({ kind: 'conflict', reason: 'identity-changed' });
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'conflict', verdict: { kind: 'conflict', reason: 'identity-changed' } });
    expect(env.snapshotOf(m.f)).toEqual(s1);
    expect(env.snapshotOf(twin)).toEqual(s2);
    expect(row(env, m.id)).toMatchObject({ state: 'applied', restoring_at: null });
  });

  it.runIf(WIN)('R8 win32 大小写：写 Dir\\File.TXT，用户改名为 file.txt 后恢复——成功，目录项仍是 file.txt，行的路径更新；新建的 New.TXT 改名成 new.txt 后恢复——文件被删', async () => {
    const env = cpEnv('r8'); const sid = env.newSession();
    const m = await modified(env, sid, join('Dir', 'File.TXT'));
    const dir = join(env.userDir, 'Dir');
    renameSync(m.f, join(dir, 'file.txt'));
    expect(readdirSync(dir)).toEqual(['file.txt']);
    expect((await one(env, sid, m.id)).outcome).toBe('restored');
    expect(readdirSync(dir)).toEqual(['file.txt']);       // 没有被改回 File.TXT，也没有残留临时文件
    expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe(m.original);
    expect(String(row(env, m.id).path).endsWith('file.txt')).toBe(true);

    const c = await created(env, sid, join('Dir', 'New.TXT'));
    renameSync(c.f, join(dir, 'new.txt'));
    expect((await one(env, sid, c.id)).outcome).toBe('deleted');
    expect(readdirSync(dir)).toEqual(['file.txt']);
  });

  it('R9 只读：写入后设只读再恢复、新建后设只读再恢复——冲突 / read-only，文件还在、内容不变', async () => {
    const env = cpEnv('r9'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const c = await created(env, sid, 'c.txt');
    chmodSync(m.f, 0o444); chmodSync(c.f, 0o444);
    try {
      expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'read-only' } });
      expect(await one(env, sid, c.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'read-only' } });
      expect(readFileSync(m.f, 'utf8')).toBe(m.next);
      expect(readFileSync(c.f, 'utf8')).toBe(c.content);   // Windows 的 unlink 删得掉只读文件：必须显式挡住
    } finally { chmodSync(m.f, 0o666); chmodSync(c.f, 0o666); }
  });

  it('R10 写入后用户给文件加了第二个硬链接：冲突 / hard-linked，两个名字都不变', async () => {
    const env = cpEnv('r10'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const second = join(env.userDir, 'second-name.txt');
    linkSync(m.f, second);
    const item = await one(env, sid, m.id);
    expect(item).toMatchObject({ outcome: 'conflict', verdict: { reason: 'hard-linked' } });
    expect(readFileSync(m.f, 'utf8')).toBe(m.next);
    expect(readFileSync(second, 'utf8')).toBe(m.next);
    expect(env.snapshotOf(m.f)!.nlink).toBe(2);
  });

  describe('R11 同文件连续修改', () => {
    const chain = async (label: string) => {
      const env = cpEnv(label); const sid = env.newSession();
      const f = join(env.userDir, 'chain.txt');
      writeFileSync(f, 'v0\n');
      const cp1 = (await env.runTool(sid, 'file_write', { path: f, content: 'v1\n' })).row.id as string;
      const cp2 = (await env.runTool(sid, 'file_write', { path: f, content: 'v2\n' })).row.id as string;
      return { env, sid, f, cp1, cp2 };
    };

    it('只恢复 cp1：superseded（带上 cp2），文件不动；恢复 cp2 得 v1；再恢复 cp1 得 v0（文件 ID 沿恢复链取，不误报 replaced）', async () => {
      const { env, sid, f, cp1, cp2 } = await chain('r11a');
      const blocked = await one(env, sid, cp1);
      expect(blocked).toMatchObject({ outcome: 'conflict', verdict: { reason: 'superseded', later: [{ id: cp2, sessionId: sid }] } });
      expect(blocked.message).toContain('之后还有 1 次改动');
      expect(readFileSync(f, 'utf8')).toBe('v2\n');
      expect((await one(env, sid, cp2)).outcome).toBe('restored');
      expect(readFileSync(f, 'utf8')).toBe('v1\n');
      expect((await one(env, sid, cp1)).outcome).toBe('restored');
      expect(readFileSync(f, 'utf8')).toBe('v0\n');
    });

    it('一次传 [cp1, cp2]：锁内按从新到旧逐项做，两条都恢复，得 v0；结果与入参同序', async () => {
      const { env, sid, f, cp1, cp2 } = await chain('r11b');
      const rep = await env.service.restore(sid, [cp1, cp2]);
      expect(rep.items.map(i => [i.id, i.outcome])).toEqual([[cp1, 'restored'], [cp2, 'restored']]);
      expect(rep.allRestored).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe('v0\n');
    });

    it('同一个文件连续改了三次、一次传三条，而且每次恢复都落在同一个时刻（时钟不动；真实时钟是毫秒精度，一次「恢复这次运行」里相邻两条可以落在同一毫秒）：三条都恢复，得 v0——最早那条不因为时刻并列取到旧的文件 ID 而被判成 replaced；文件真被换成另一份同内容的文件时照样认得出来', async () => {
      const env = cpEnv('r11-tie', { store: { now: () => 1_800_000_000 } }); const sid = env.newSession();
      const f = join(env.userDir, 'chain.txt');
      writeFileSync(f, 'v0\n');
      const ids: string[] = [];
      for (const v of ['v1\n', 'v2\n', 'v3\n']) ids.push((await env.runTool(sid, 'file_write', { path: f, content: v })).row.id as string);
      const rep = await env.service.restore(sid, ids);
      expect(rep.items.map(i => [i.outcome, (i.verdict as any)?.reason])).toEqual([['restored', undefined], ['restored', undefined], ['restored', undefined]]);
      expect(rep.allRestored).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe('v0\n');
      expect(env.rows(sid).map(r => r.state)).toEqual(['restored', 'restored', 'restored']);
      noTemps(env.userDir);

      // 对照：同样时刻并列，恢复了后两条（文件回到 v1，文件 ID 是恢复 cp2 时留下的）之后，文件被换成另一份内容相同的文件——cp1 仍是 replaced
      const g = join(env.userDir, 'twin-chain.txt');
      writeFileSync(g, 'v0\n');
      const gs: string[] = [];
      for (const v of ['v1\n', 'v2\n', 'v3\n']) gs.push((await env.runTool(sid, 'file_write', { path: g, content: v })).row.id as string);
      expect((await env.service.restore(sid, [gs[1], gs[2]])).allRestored).toBe(true);
      expect(readFileSync(g, 'utf8')).toBe('v1\n');
      expect(env.service.inspect(sid, [gs[0]])[0].verdict).toEqual({ kind: 'ready', action: 'overwrite' });
      if (row(env, gs[1]).restored_ino !== null) {             // 取不到稳定文件 ID 的文件系统上没有这一条比对
        const twin = join(env.userDir, 'twin.txt');
        copyFileSync(g, twin);
        unlinkSync(g);
        renameSync(twin, g);
        expect(await one(env, sid, gs[0])).toMatchObject({ outcome: 'conflict', verdict: { reason: 'replaced' } });
        expect(readFileSync(g, 'utf8')).toBe('v1\n');
      }
    });

    it('cp2 之后用户手改，传 [cp1, cp2]：cp2 modified、cp1 superseded，文件仍是用户的内容', async () => {
      const { env, sid, f, cp1, cp2 } = await chain('r11c');
      writeFileSync(f, 'v2 edited by user\n');
      const rep = await env.service.restore(sid, [cp1, cp2]);
      expect(rep.items.map(i => (i.verdict as any)?.reason)).toEqual(['superseded', 'modified']);
      expect(rep.allRestored).toBe(false);
      expect(readFileSync(f, 'utf8')).toBe('v2 edited by user\n');
    });

    it('v0→v1、v1→v2、v2→v1 之后只恢复 cp1（文件内容恰好等于 cp1 写入的）：仍是 superseded，不越过后来的两次改动', async () => {
      const { env, sid, f, cp1 } = await chain('r11d');
      expect((await env.runTool(sid, 'file_write', { path: f, content: 'v1\n' })).success).toBe(true);   // cp3：v2 → v1
      const item = await one(env, sid, cp1);
      expect(item).toMatchObject({ outcome: 'conflict', verdict: { reason: 'superseded' } });
      expect((item.verdict as any).later).toHaveLength(2);
      expect(readFileSync(f, 'utf8')).toBe('v1\n');
    });

    it('同一次运行里同一个文件改了三次、另一个文件改了一次：预检的结论按「恢复这次运行」的发法（就绪的，加上后续改动都在这次要发的记录里的）一次发出——全部恢复，文件回到这次运行之前的字节，不是停在中间版本', async () => {
      const env = cpEnv('r11-run'); const sid = env.newSession();
      const a = join(env.userDir, 'a.txt'); const b = join(env.userDir, 'b.txt');
      writeFileSync(a, 'value zero\n'); writeFileSync(b, 'other original\n');
      const run = await env.runBatch(sid, [
        { name: 'file_write', input: { tool_title: 't', path: a, content: 'value one\n' } },
        { name: 'file_edit', input: { tool_title: 't', path: a, old_string: 'one', new_string: 'two' } },
        { name: 'file_edit', input: { tool_title: 't', path: a, old_string: 'two', new_string: 'three' } },
        { name: 'file_write', input: { tool_title: 't', path: b, content: 'other changed\n' } },
      ]);
      expect(run.results.map(r => r.outcome.success)).toEqual([true, true, true, true]);
      expect(readFileSync(a, 'utf8')).toBe('value three\n');
      // 界面发 inspect 的顺序：这次运行的全部记录，从新到旧
      const ids = env.service.list(sid).groups.find(g => g.runId === run.runId)!.changes.map(c => c.id);
      expect(ids).toHaveLength(4);
      const pre = env.service.inspect(sid, ids);
      // a.txt 只有最后一次改动是就绪的，前两次各自被后面的挡着（孤立地看）；b.txt 那一条就绪
      expect(pre.map(p => (p.verdict.kind === 'ready' ? 'ready' : (p.verdict as any).reason)).sort()).toEqual(['ready', 'ready', 'superseded', 'superseded']);
      const plan = planRunRestore(pre);
      expect(plan.blocked).toEqual([]);
      expect(plan.send).toHaveLength(4);
      const rep = await env.service.restore(sid, plan.send.map(i => i.id));
      expect(rep.items.map(i => i.outcome)).toEqual(['restored', 'restored', 'restored', 'restored']);
      expect(rep.allRestored).toBe(true);
      expect(readFileSync(a, 'utf8')).toBe('value zero\n');      // 一次确认就回到运行之前
      expect(readFileSync(b, 'utf8')).toBe('other original\n');
      expect(env.rows(sid).map(r => r.state)).toEqual(['restored', 'restored', 'restored', 'restored']);
      noTemps(env.userDir);
    });

    it('同一次运行里同一个文件改了三次、最早那条的检查点随后按容量被清掉：「恢复这次运行」只发得出后两条，文件停在第一次写入之后的版本（不是运行之前）——计划标出这个文件回不到运行之前，结果汇总不把它数成已恢复', async () => {
      let quota = 1024 * 1024;
      const env = cpEnv('r11-pruned-head', { store: { quotaBytes: () => quota } });
      const sid = env.newSession();
      const a = join(env.userDir, 'a.txt');
      const v = (n: number): string => String(n).repeat(4096);
      writeFileSync(a, v(0));
      const run = await env.runBatch(sid, [1, 2, 3].map(n => ({ name: 'file_write', input: { tool_title: 't', path: a, content: v(n) } })));
      expect(run.results.map(r => r.outcome.success)).toEqual([true, true, true]);
      // 三条记录各存一份 4 KiB 的写入前内容；上限调到只容得下两份——清理从最旧的记录起，清掉的正是这次运行对 a.txt 的第一次改动
      quota = 8 * 1024;
      expect(env.store.prune()).toBe(1);
      expect(env.rows(sid).map(r => r.pruned_at !== null)).toEqual([true, false, false]);
      // 界面的做法：inspect 这次运行的全部记录（从新到旧），文件的身份取清单里的路径身份键
      const changes = env.service.list(sid).groups.find(g => g.runId === run.runId)!.changes;
      const keyOf = (i: { id: string; path: string }): string => changes.find(c => c.id === i.id)?.pathKey ?? i.path;
      const pre = env.service.inspect(sid, changes.map(c => c.id));
      expect(pre.map(p => (p.verdict.kind === 'ready' ? 'ready' : (p.verdict as any).reason))).toEqual(['ready', 'superseded', 'pruned']);
      const plan = planRunRestore(pre, keyOf);
      expect(plan.send.map(i => i.id)).toEqual([changes[0].id, changes[1].id]);
      expect(plan.blocked.map(i => i.id)).toEqual([changes[2].id]);
      expect([plan.files, plan.partial]).toEqual([1, 1]);
      const rep = await env.service.restore(sid, plan.send.map(i => i.id));
      // 引擎这边每一条都做成了；「全部恢复」说的只是发出去的那两条
      expect(rep.items.map(i => i.outcome)).toEqual(['restored', 'restored']);
      expect(rep.allRestored).toBe(true);
      expect(readFileSync(a, 'utf8')).toBe(v(1));          // 这次运行第一次写入之后的版本，不是运行之前的 v(0)
      const s = summarizeReport(rep, keyOf, plan.blocked);
      expect(s).toMatchObject({ done: 0, notDone: 1, partial: 1, anyDone: true });
      expect(s.headline).toContain('只恢复了后面的几次改动，文件停在中间的版本');
      expect(s.headline).not.toContain('已恢复 1 个文件');
      noTemps(env.userDir);
    });

    it('过期预检：预检之后、确认之前先单独恢复了其中两条（a.txt 最新的一次、c.txt 唯一的一次），再按原来那份预检把整次运行发出去——引擎对那两条回报 unavailable / already-restored、不取锁不动文件，其余照常恢复，两个文件都回到运行之前；结果汇总不把它们数成「没有恢复」，也不把 a.txt 说成停在中间版本', async () => {
      const env = cpEnv('r11-stale');
      const sid = env.newSession();
      const a = join(env.userDir, 'a.txt'); const c = join(env.userDir, 'c.txt');
      writeFileSync(a, 'a zero\n'); writeFileSync(c, 'c zero\n');
      const run = await env.runBatch(sid, [
        { name: 'file_write', input: { tool_title: 't', path: a, content: 'a one\n' } },
        { name: 'file_write', input: { tool_title: 't', path: a, content: 'a two\n' } },
        { name: 'file_write', input: { tool_title: 't', path: a, content: 'a three\n' } },
        { name: 'file_write', input: { tool_title: 't', path: c, content: 'c one\n' } },
      ]);
      expect(run.results.map(r => r.outcome.success)).toEqual([true, true, true, true]);
      // 界面的做法：点「恢复这次运行…」时 inspect 这次运行的全部记录，面板就停在这份预检上
      const changes = env.service.list(sid).groups.find(g => g.runId === run.runId)!.changes;
      const keyOf = (i: { id: string; path: string }): string => changes.find(x => x.id === i.id)?.pathKey ?? i.path;
      const plan = planRunRestore(env.service.inspect(sid, changes.map(x => x.id)), keyOf);
      expect(plan.send).toHaveLength(4);
      expect(plan.blocked).toEqual([]);
      const ofA = changes.filter(x => x.displayPath.endsWith('a.txt')).sort((x, y) => y.seq - x.seq).map(x => x.id);
      const ofC = changes.filter(x => x.displayPath.endsWith('c.txt')).map(x => x.id);
      expect([ofA.length, ofC.length]).toEqual([3, 1]);
      // 预检面板开着的时候，在审阅面板里单独恢复了两条
      expect((await one(env, sid, ofC[0])).outcome).toBe('restored');
      expect((await one(env, sid, ofA[0])).outcome).toBe('restored');
      expect(readFileSync(a, 'utf8')).toBe('a two\n');
      // 回到右栏点确认：发的仍是那份预检算出来的四条
      const rep = await env.service.restore(sid, plan.send.map(i => i.id));
      const by = new Map(rep.items.map(i => [i.id, i]));
      for (const id of [ofA[0], ofC[0]]) expect(by.get(id)).toMatchObject({ outcome: 'unavailable', verdict: { kind: 'unavailable', reason: 'already-restored' } });
      expect([by.get(ofA[1])?.outcome, by.get(ofA[2])?.outcome]).toEqual(['restored', 'restored']);
      expect(rep.allRestored).toBe(false);                 // 逐项事实：有两条这次没有动手
      expect(readFileSync(a, 'utf8')).toBe('a zero\n');     // 两个文件都是运行之前的内容
      expect(readFileSync(c, 'utf8')).toBe('c zero\n');
      expect(env.rows(sid).map(r => r.state)).toEqual(['restored', 'restored', 'restored', 'restored']);
      // 界面的汇总：a.txt 算已恢复（不是「只恢复了后面的几次改动」），c.txt 不算「没有恢复」
      const s = summarizeReport(rep, keyOf, plan.blocked);
      expect(s).toMatchObject({ done: 1, notDone: 0, partial: 0, anyDone: true, headline: '已恢复 1 个文件。' });
      expect(s.items.map(i => i.id).sort()).toEqual([ofA[1], ofA[2]].sort());
      const rest = splitNotSent(rep, plan.blocked, keyOf);
      expect(rest.notNeeded.map(i => i.id).sort()).toEqual([ofA[0], ofC[0]].sort());
      expect([rest.sameFile, rest.otherFiles, rest.otherFileCount]).toEqual([[], [], 0]);
      noTemps(env.userDir);
    });

    it('跨会话：cp1 属于会话 A、cp2 属于会话 B——在 A 里恢复 cp1 是 superseded（文案说另一个会话）；A 里一起传报「检查点不存在」、零改动；到 B 恢复 cp2 后回 A 恢复 cp1 成功', async () => {
      const env = cpEnv('r11e'); const a = env.newSession(); const b = env.newSession();
      const f = join(env.userDir, 'shared.txt');
      writeFileSync(f, 'v0\n');
      const cp1 = (await env.runTool(a, 'file_write', { path: f, content: 'v1\n' })).row.id as string;
      const cp2 = (await env.runTool(b, 'file_write', { path: f, content: 'v2\n' })).row.id as string;
      const item = await one(env, a, cp1);
      expect(item).toMatchObject({ outcome: 'conflict', verdict: { reason: 'superseded', later: [{ id: cp2, sessionId: b }] } });
      expect(item.message).toContain('另一个会话');
      const before = JSON.stringify(env.rows());
      await expect(env.service.restore(a, [cp1, cp2])).rejects.toThrow('检查点不存在');
      expect(readFileSync(f, 'utf8')).toBe('v2\n');
      expect(JSON.stringify(env.rows())).toBe(before);
      expect((await one(env, b, cp2)).outcome).toBe('restored');
      expect((await one(env, a, cp1)).outcome).toBe('restored');
      expect(readFileSync(f, 'utf8')).toBe('v0\n');
    });
  });

  it('R12 多文件部分冲突：三个文件、其中一个被用户改过，一次恢复三条——restored / conflict / restored，allRestored 为假，三个文件各自符合', async () => {
    const env = cpEnv('r12'); const sid = env.newSession();
    const a = await modified(env, sid, 'a.txt'); const b = await modified(env, sid, 'b.txt'); const c = await modified(env, sid, 'c.txt');
    writeFileSync(b.f, 'user changed b\n');
    const rep = await env.service.restore(sid, [a.id, b.id, c.id]);
    expect(rep.items.map(i => i.outcome)).toEqual(['restored', 'conflict', 'restored']);
    expect(rep.items).toHaveLength(3);
    expect(rep.allRestored).toBe(false);
    expect(readFileSync(a.f, 'utf8')).toBe(a.original);
    expect(readFileSync(b.f, 'utf8')).toBe('user changed b\n');
    expect(readFileSync(c.f, 'utf8')).toBe(c.original);
    expect(env.audits.filter(x => x.type === 'checkpoint.restore')).toHaveLength(1);
    expect(JSON.stringify(env.audits)).not.toContain('original a.txt');
  });

  it('R13 新建的文件未变，恢复：文件被删，删除前的内容已存下，另存得到 agent 写的字节', async () => {
    const env = cpEnv('r13'); const sid = env.newSession();
    const c = await created(env, sid, 'made.txt');
    expect((await one(env, sid, c.id)).outcome).toBe('deleted');
    expect(existsSync(c.f)).toBe(false);
    expect(row(env, c.id)).toMatchObject({ state: 'restored', after_blob: sha(c.content) });
    expect(readFileSync(env.service.saveCopy(sid, c.id, 'after').path, 'utf8')).toBe(c.content);
    expect(() => env.service.saveCopy(sid, c.id, 'before')).toThrow('没有改动前的版本');
  });

  it('R14 新建的文件被用户改过：冲突 / modified，文件还在', async () => {
    const env = cpEnv('r14'); const sid = env.newSession();
    const c = await created(env, sid, 'made.txt');
    writeFileSync(c.f, 'the user put real work in here\n');
    expect(await one(env, sid, c.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'modified' } });
    expect(readFileSync(c.f, 'utf8')).toBe('the user put real work in here\n');
  });

  it('R15 写入没有生效（aborted）的新建记录、同名位置上有用户文件：unavailable / not-applied，用户文件不被删', async () => {
    const env = cpEnv('r15'); const sid = env.newSession();
    const f = join(env.userDir, 'appears.txt');
    env.io.hook('before-replace', () => writeFileSync(f, 'user file'));
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'agent' });
    expect(r.row.state).toBe('aborted');
    env.io.reset();
    expect(await one(env, sid, r.row.id)).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'not-applied' } });
    expect(readFileSync(f, 'utf8')).toBe('user file');
  });

  it('R16 会话在跑：unavailable / run-active，不变', async () => {
    const env = cpEnv('r16'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    env.running.add(sid);
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'run-active' } });
    expect(readFileSync(m.f, 'utf8')).toBe(m.next);
  });

  /** 以另一个 group 的身份持有某个文件的写锁。 */
  const holdLock = async (env: CpEnv, f: string) => {
    const id = (await import('../src/minisd/tools/data-gate')).pathIdentity(f);
    const lock = await env.scheduler.locks.acquire({ group: 'someone-else', label: 'holder', claims: [{ ns: 'path', root: id.root, segs: id.segs, mode: 'write', display: f }] });
    if (!lock.ok) throw new Error('没拿到锁');
    return lock;
  };

  it('R17 另一个 group 持着同一路径的写锁：全部 busy，不变', async () => {
    const env = cpEnv('r17', { lockWaitMs: 50 }); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const lock = await holdLock(env, m.f);
    try {
      const rep = await env.service.restore(sid, [m.id]);
      expect(rep.items[0].outcome).toBe('busy');
      expect(readFileSync(m.f, 'utf8')).toBe(m.next);
      expect(row(env, m.id)).toMatchObject({ state: 'applied', restoring_at: null });
    } finally { lock.release(); }
    expect(env.scheduler.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('R17a 等锁期间由不就绪变就绪：锁内重判为就绪并恢复，而且那一刻确实持着这条路径的写锁', async () => {
    const env = cpEnv('r17a', { lockWaitMs: 30_000 }); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    writeFileSync(m.f, 'temporarily different\n');       // 无锁预检：modified
    const lock = await holdLock(env, m.f);
    let heldAtRestore: string[] = [];
    env.io.hook('restore-after-mark', () => { heldAtRestore = env.scheduler.locks.snapshot().held.filter(h => h.group === `restore:${sid}`).flatMap(h => h.claims); });
    const p = env.service.restore(sid, [m.id]);
    await vi.waitFor(() => { expect(env.scheduler.locks.snapshot().waiting).toHaveLength(1); });
    writeFileSync(m.f, m.next);                           // 改回写入后的内容
    lock.release();
    const rep = await p;
    expect(rep.items[0].outcome).toBe('restored');
    expect(readFileSync(m.f, 'utf8')).toBe(m.original);
    expect(heldAtRestore).toHaveLength(1);
    expect(heldAtRestore[0]).toBe(`path:${row(env, m.id).path_key}`);
    expect(env.scheduler.locks.snapshot().held).toEqual([]);
  });

  it('R17b 等锁期间由就绪变不就绪：冲突 / modified，磁盘上是用户的内容', async () => {
    const env = cpEnv('r17b', { lockWaitMs: 30_000 }); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const lock = await holdLock(env, m.f);
    const p = env.service.restore(sid, [m.id]);
    await vi.waitFor(() => { expect(env.scheduler.locks.snapshot().waiting).toHaveLength(1); });
    writeFileSync(m.f, 'changed while waiting\n');
    lock.release();
    expect((await p).items[0]).toMatchObject({ outcome: 'conflict', verdict: { reason: 'modified' } });
    expect(readFileSync(m.f, 'utf8')).toBe('changed while waiting\n');
  });

  it('R18 恢复过程中文件被改（临时文件写好之后）：冲突 / modified，磁盘上是刚改的内容，行仍 applied、「恢复中」已清，无临时文件', async () => {
    const env = cpEnv('r18'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    env.io.hook('restore-after-tmp', () => writeFileSync(m.f, 'slipped in during restore\n'));
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'modified' } });
    expect(readFileSync(m.f, 'utf8')).toBe('slipped in during restore\n');
    expect(row(env, m.id)).toMatchObject({ state: 'applied', restoring_at: null, restore_tmp_path: null });
    noTemps(env.userDir);
  });

  it('R18a 锁内只读一次：整次恢复里对目标的读恰好两次（无锁预检一次、锁内一次）；存下的写入后内容就是算过哈希的那一份', async () => {
    const env = cpEnv('r18a'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    // 第 3 次读只有「锁内又读了一遍」的实现才会走到：那一刻把目标改掉
    env.io.hook('readStable', () => writeFileSync(m.f, 'changed between two reads\n'), { nth: 3, pred: p => p === m.f });
    const before = env.io.callsOf('readStable', p => p === m.f).length;
    expect((await one(env, sid, m.id)).outcome).toBe('restored');
    expect(env.io.callsOf('readStable', p => p === m.f).length - before).toBe(2);
    expect(readFileSync(m.f, 'utf8')).toBe(m.original);
    expect(row(env, m.id).after_blob).toBe(row(env, m.id).after_hash);
    expect(readFileSync(env.blobPath(sha(m.next)), 'utf8')).toBe(m.next);
  });

  it('R18b 读完并存下内容之后目标被改（修改类、新建类各一条）：冲突 / modified，磁盘上是刚改的内容，文件没有被删', async () => {
    const env = cpEnv('r18b'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const c = await created(env, sid, 'c.txt');
    for (const t of [m, c]) {
      env.io.reset();
      env.io.hook('restore-after-mark', () => writeFileSync(t.f, 'changed right after the read\n'));
      expect(await one(env, sid, t.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'modified' } });
      expect(readFileSync(t.f, 'utf8')).toBe('changed right after the read\n');
      expect(row(env, t.id)).toMatchObject({ state: 'applied', restoring_at: null });
    }
    noTemps(env.userDir);
  });

  it('R18c 恢复过程中文件被原地改成同样大小的另一份内容（临时文件写好之后）：冲突 / modified，磁盘上是刚改的内容——动手前比的是整个签名（含修改时间），不只是大小', async () => {
    const env = cpEnv('r18c'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt', 'original\n', 'AGENT-12\n');
    const user = 'USER--34\n';
    expect(Buffer.byteLength(user)).toBe(Buffer.byteLength(m.next));
    const ino = env.snapshotOf(m.f)!.ino;
    // 原地覆盖：文件 ID 与大小都不变，变的只有内容与修改时间。修改时间显式拨开，不依赖时钟粒度
    env.io.hook('restore-after-tmp', () => { writeFileSync(m.f, user); utimesSync(m.f, new Date(), new Date(Date.now() + 60_000)); });
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'conflict', verdict: { reason: 'modified' } });
    expect(readFileSync(m.f, 'utf8')).toBe(user);
    expect(env.snapshotOf(m.f)!.ino).toBe(ino);
    expect(row(env, m.id)).toMatchObject({ state: 'applied', restoring_at: null, restore_tmp_path: null });
    noTemps(env.userDir);
  });

  it('R19 恢复时改名做不了、原地覆盖可行：restored，文件是原始字节、文件 ID 不变，无临时文件；另存得到写入后的字节', async () => {
    const env = cpEnv('r19'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const ino = env.snapshotOf(m.f)!.ino;
    env.io.fail('rename', p => p === m.f, 'EPERM');
    expect((await one(env, sid, m.id)).outcome).toBe('restored');
    expect(readFileSync(m.f, 'utf8')).toBe(m.original);
    expect(env.snapshotOf(m.f)!.ino).toBe(ino);
    expect(row(env, m.id).state).toBe('restored');
    noTemps(env.userDir);
    expect(readFileSync(env.service.saveCopy(sid, m.id, 'after').path, 'utf8')).toBe(m.next);
  });

  it('R19a 改名报 EPERM、原地打开也报 EBUSY：failed、文案含「文件没有改动」，文件仍是写入后的内容，行仍 applied、「恢复中」已清，无临时文件', async () => {
    const env = cpEnv('r19a'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    env.io.fail('rename', p => p === m.f, 'EPERM');
    env.io.fail('overwriteInPlace', p => p === m.f, 'EBUSY');
    const item = await one(env, sid, m.id);
    expect(item.outcome).toBe('failed');
    expect(item.message).toContain('文件没有改动');
    expect(readFileSync(m.f, 'utf8')).toBe(m.next);
    expect(row(env, m.id)).toMatchObject({ state: 'applied', restoring_at: null });
    noTemps(env.userDir);
  });

  it('R19b 恢复的原地覆盖中途失败：failed，行 unknown；另存「改动前」「改动后」各得到原始字节与写入后的字节', async () => {
    const env = cpEnv('r19b'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    env.io.fail('rename', p => p === m.f, 'EPERM');
    env.io.hook('restore-before-inplace', () => writeFileSync(m.f, m.next.slice(0, 5)));
    env.io.fail('overwriteInPlace', p => p === m.f, 'EIO');
    const item = await one(env, sid, m.id);
    expect(item.outcome).toBe('failed');
    expect(item.message).toContain('另存');
    expect(item.message).not.toContain('文件没有改动');
    expect(row(env, m.id).state).toBe('unknown');
    env.io.reset();
    expect(readFileSync(env.service.saveCopy(sid, m.id, 'before').path, 'utf8')).toBe(m.original);
    expect(readFileSync(env.service.saveCopy(sid, m.id, 'after').path, 'utf8')).toBe(m.next);
  });

  it('R19d 恢复的原地覆盖返回了但内容不对（少写一个字节）：failed、行 unknown 而不是 restored；另存「改动前」「改动后」各得到两头的字节', async () => {
    const env = cpEnv('r19d'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    env.io.fail('rename', p => p === m.f, 'EPERM');
    env.io.replace('overwriteInPlace', base => (p, d) => base(p, d.subarray(0, d.length - 1)));
    const item = await one(env, sid, m.id);
    expect(item.outcome).toBe('failed');
    expect(item.message).toContain('另存');
    expect(item.message).not.toContain('文件没有改动');
    expect(readFileSync(m.f, 'utf8')).toBe(m.original.slice(0, -1));   // 原地覆盖不是原子的：盘上是那份残缺的内容，不能说成已恢复
    expect(row(env, m.id)).toMatchObject({ state: 'unknown', restoring_at: null });
    env.io.reset();
    expect(readFileSync(env.service.saveCopy(sid, m.id, 'before').path, 'utf8')).toBe(m.original);
    expect(readFileSync(env.service.saveCopy(sid, m.id, 'after').path, 'utf8')).toBe(m.next);
  });

  it('R19e 恢复时改名报 EPERM、回落之前目标被改：冲突 / modified，磁盘上是别人写的内容，没有原地覆盖，行仍 applied、「恢复中」已清，无临时文件', async () => {
    const env = cpEnv('r19e'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    env.io.hook('rename', () => writeFileSync(m.f, 'user edited meanwhile\n'), { pred: p => p === m.f });
    env.io.fail('rename', p => p === m.f, 'EPERM');
    const item = await one(env, sid, m.id);
    expect(item).toMatchObject({ outcome: 'conflict', verdict: { kind: 'conflict', reason: 'modified' } });
    expect(readFileSync(m.f, 'utf8')).toBe('user edited meanwhile\n');
    expect(env.io.callsOf('overwriteInPlace')).toEqual([]);
    // 文件没有被这次恢复动过：记录不落成 unknown，等用户处理完冲突还能再恢复或另存
    expect(row(env, m.id)).toMatchObject({ state: 'applied', restoring_at: null, restore_tmp_path: null });
    noTemps(env.userDir);
  });

  it.runIf(WIN)('R19c win32 真机：全共享只读句柄下恢复成功（原地）；只许共享读时 failed、文件不变；独占打开时冲突 / unreadable；新建的文件在只读句柄开着时恢复——文件被删', async () => {
    const env = cpEnv('r19c'); const sid = env.newSession();
    const a = await modified(env, sid, 'a.txt'); const b = await modified(env, sid, 'b.txt');
    const c = await modified(env, sid, 'c.txt'); const d = await created(env, sid, 'd.txt');
    let rel = await holdOpen(a.f, 'ReadWrite, Delete');
    let item; try { item = await one(env, sid, a.id); } finally { await rel(); }
    expect(item.outcome).toBe('restored');
    expect(readFileSync(a.f, 'utf8')).toBe(a.original);

    rel = await holdOpen(b.f, 'Read');
    try { item = await one(env, sid, b.id); } finally { await rel(); }
    expect(item.outcome).toBe('failed');
    expect(item.message).toContain('文件没有改动');
    expect(readFileSync(b.f, 'utf8')).toBe(b.next);

    rel = await holdOpen(c.f, 'None');
    try { item = await one(env, sid, c.id); } finally { await rel(); }
    expect(item).toMatchObject({ outcome: 'conflict', verdict: { reason: 'unreadable' } });
    expect(readFileSync(c.f, 'utf8')).toBe(c.next);

    rel = await holdOpen(d.f, 'ReadWrite, Delete');
    try { item = await one(env, sid, d.id); } finally { await rel(); }
    expect(item.outcome).toBe('deleted');
    expect(existsSync(d.f)).toBe(false);
    noTemps(env.userDir);
  }, 180_000);

  it('R20 把内容文件改坏一个字节：unavailable / blob-corrupt，目标不变', async () => {
    const env = cpEnv('r20'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const blob = env.blobPath(sha(m.original));
    const bad = readFileSync(blob); bad[0] ^= 0xff;
    writeFileSync(blob, bad);
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'blob-corrupt' } });
    expect(readFileSync(m.f, 'utf8')).toBe(m.next);
    expect(row(env, m.id)).toMatchObject({ state: 'applied', restoring_at: null });
    noTemps(env.userDir);
    // 内容文件不在：预检就说 blob-missing
    rmSync(blob);
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'blob-missing' } });
  });

  it('R21 重复恢复：第二次 already-restored，目标零写入', async () => {
    const env = cpEnv('r21'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    expect((await one(env, sid, m.id)).outcome).toBe('restored');
    const mark = env.io.calls.length;
    expect(await one(env, sid, m.id)).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'already-restored' } });
    expect(env.io.calls.slice(mark).filter(c => ['rename', 'unlink', 'overwriteInPlace', 'writeDurable', 'linkExclusive'].includes(c.op))).toEqual([]);
    expect(readFileSync(m.f, 'utf8')).toBe(m.original);
  });

  it('R22 另存的目标名已存在：生成带 -2 的新名字，已有文件不变', async () => {
    const env = cpEnv('r22'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    vi.useFakeTimers({ now: new Date(2026, 9, 4, 12, 0, 0), toFake: ['Date'] });
    try {
      const first = env.service.saveCopy(sid, m.id, 'before');
      writeFileSync(first.path, 'the user already edited this copy');
      const second = env.service.saveCopy(sid, m.id, 'before');
      expect(second.path).not.toBe(first.path);
      expect(second.path).toContain('-2');
      expect(readFileSync(first.path, 'utf8')).toBe('the user already edited this copy');
      expect(readFileSync(second.path, 'utf8')).toBe(m.original);
      expect(first.path).toContain('a.改动前-20261004-120000.txt');
    } finally { vi.useRealTimers(); }
  });

  it('R23 目标目录是一个版本库（.git 目录、未跟踪文件、已改文件）：恢复只动目标一个文件，其余不变，没有起任何子进程', async () => {
    const env = cpEnv('r23'); const sid = env.newSession();
    mkdirSync(join(env.userDir, '.git', 'objects'), { recursive: true });
    writeFileSync(join(env.userDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(env.userDir, '.git', 'index'), 'fake index');
    writeFileSync(join(env.userDir, 'untracked.txt'), 'untracked work\n');
    writeFileSync(join(env.userDir, 'dirty.txt'), 'locally modified, not committed\n');
    const m = await modified(env, sid, 'a.txt');
    const calls0 = spawned.n;
    {
      const before = env.tree(env.userDir);
      expect((await one(env, sid, m.id)).outcome).toBe('restored');
      const after = env.tree(env.userDir);
      expect(after['a.txt']).toBe(sha(m.original));
      for (const k of Object.keys(before)) if (k !== 'a.txt') expect(after[k], k).toBe(before[k]);
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      expect(spawned.n).toBe(calls0);
    }
    // 对照：计数是活的（不是恒为 0 的空断言）
    try { childProcess.spawnSync(''); } catch { /* 空命令起不来，只为过一次包装 */ }
    expect(spawned.n).toBe(calls0 + 1);
  });

  it('R24 inspect：结论与随后真实恢复的逐项结果相同；预检期间目标零写入，没有待对账的行时库也零写入', async () => {
    const env = cpEnv('r24'); const sid = env.newSession();
    const a = await modified(env, sid, 'a.txt'); const b = await modified(env, sid, 'b.txt'); const c = await created(env, sid, 'c.txt');
    writeFileSync(b.f, 'user changed b\n');
    const rowsBefore = JSON.stringify(env.rows()); const treeBefore = env.tree(env.userDir);
    const mark = env.io.calls.length;
    const pre = env.service.inspect(sid, [a.id, b.id, c.id]);
    expect(pre.map(p => p.verdict.kind)).toEqual(['ready', 'conflict', 'ready']);
    expect(pre.map(p => (p.verdict as any).action ?? (p.verdict as any).reason)).toEqual(['overwrite', 'modified', 'delete']);
    expect(pre.every(p => p.message.length > 0)).toBe(true);
    expect(JSON.stringify(env.rows())).toBe(rowsBefore);
    expect(env.tree(env.userDir)).toEqual(treeBefore);
    expect(env.io.calls.slice(mark).filter(x => ['rename', 'unlink', 'overwriteInPlace', 'writeDurable', 'linkExclusive', 'mkdirp'].includes(x.op))).toEqual([]);
    const rep = await env.service.restore(sid, [a.id, b.id, c.id]);
    expect(rep.items.map(i => i.outcome)).toEqual(['restored', 'conflict', 'deleted']);
    await expect(async () => env.service.inspect(sid, ['no-such-id'])).rejects.toThrow('检查点不存在');
  });

  it('R25 锁内抛错也放锁：该项 failed、同批后面的项照常恢复、锁表为空；随后对同一路径的写入立刻成功', async () => {
    for (const mode of ['readBlob', 'lstat'] as const) {
      const env = cpEnv(`r25-${mode}`, { schedulerLockWaitMs: 200 }); const sid = env.newSession();
      const a = await modified(env, sid, 'a.txt'); const b = await modified(env, sid, 'b.txt');
      if (mode === 'readBlob') {
        const real = env.store.readBlob.bind(env.store);
        vi.spyOn(env.store, 'readBlob').mockImplementation(h => { if (h === sha(b.original)) throw new Error('unexpected failure'); return real(h); });
      } else {
        // 锁内「动手前复核」的那一次 lstat（无锁预检 1 次、锁内预检 1 次、复核是第 3 次）
        env.io.fail('lstat', p => p === b.f, 'EIO', 3);
      }
      const rep = await env.service.restore(sid, [a.id, b.id]);   // 锁内从新到旧：先 b（失败），再 a
      expect(rep.items.map(i => i.outcome)).toEqual(['restored', 'failed']);
      expect(readFileSync(a.f, 'utf8')).toBe(a.original);
      expect(env.scheduler.locks.snapshot().held).toEqual([]);
      vi.restoreAllMocks(); env.io.reset();
      // 没放锁的话，这次写入要等满调度器的等锁上限（注入成 200 ms）然后以超时失败
      const w = await env.runTool(sid, 'file_write', { path: b.f, content: 'next write goes through\n' });
      expect(w.success, w.output).toBe(true);
    }
  });

  it('R26 审计写库失败、变更通知抛错：restore 不抛，逐项结果仍是 restored，文件是原始字节，行 restored', async () => {
    const env = cpEnv('r26', { store: { onChange: () => { throw new Error('broadcast failed'); } } }); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    (env.service as any).deps.audit = () => { throw new Error('audit insert failed'); };
    const rep = await env.service.restore(sid, [m.id]);
    expect(rep.items[0].outcome).toBe('restored');
    expect(rep.allRestored).toBe(true);
    expect(readFileSync(m.f, 'utf8')).toBe(m.original);
    expect(row(env, m.id).state).toBe('restored');
  });

  it('R27 「恢复中」的陈旧行：恢复完成的写库失败之后再 inspect——先对账，得 already-restored 而不是 modified；对账落不定时得 unsettled，文件不动', async () => {
    let failTx = 0;
    const env = cpEnv('r27', { plainTx: true, store: {} });
    const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const spy = vi.spyOn(env.store, 'finishRestore').mockImplementation(() => { throw new Error('db write failed'); });
    const item = await one(env, sid, m.id);
    spy.mockRestore();
    expect(item.outcome).toBe('restored');                 // 文件已恢复：不因为记录没写成而说失败
    expect(readFileSync(m.f, 'utf8')).toBe(m.original);
    expect(row(env, m.id)).toMatchObject({ state: 'applied' });
    expect(row(env, m.id).restoring_at).not.toBeNull();
    // 对账落不定：注入对账抛错
    const rec = vi.spyOn(env.store, 'reconcile').mockImplementation(() => { failTx += 1; return []; });
    expect(env.service.inspect(sid, [m.id])[0].verdict).toEqual({ kind: 'unavailable', reason: 'unsettled' });
    expect(failTx).toBe(1);
    expect(readFileSync(m.f, 'utf8')).toBe(m.original);
    rec.mockRestore();
    expect(env.service.inspect(sid, [m.id])[0].verdict).toEqual({ kind: 'unavailable', reason: 'already-restored' });
    expect(row(env, m.id)).toMatchObject({ state: 'restored', restoring_at: null });
  });

  it('R28 新建文件留下了残留临时文件之后恢复：预检先补删残留，结论 ready；恢复后文件被删，目录里没有临时文件', async () => {
    const env = cpEnv('r28'); const sid = env.newSession();
    const f = join(env.userDir, 'made.txt');
    env.io.replace('linkExclusive', () => (from, to) => linkSync(from, to));
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'x\n' });
    expect(env.snapshotOf(f)!.nlink).toBe(2);
    env.io.reset();
    expect(env.service.inspect(sid, [r.row.id])[0].verdict).toEqual({ kind: 'ready', action: 'delete' });
    expect((await one(env, sid, r.row.id)).outcome).toBe('deleted');
    expect(existsSync(f)).toBe(false);
    noTemps(env.userDir);
  });

  it('R29 恢复时检查点目录写满、当前内容存不下来：不恢复——failed 并说「没能先保存当前内容」，目标的字节、文件 ID、修改时间都不变，行仍 applied、没有标「恢复中」、没有存下写入后的内容；修改类、新建类各一条', async () => {
    const env = cpEnv('r29'); const sid = env.newSession();
    const m = await modified(env, sid, 'a.txt');
    const c = await created(env, sid, 'c.txt');
    env.io.fail('writeDurable', p => p.startsWith(env.cpDir), 'ENOSPC');
    for (const t of [m, c]) {
      const snap = env.snapshotOf(t.f);
      const mark = env.io.calls.length;
      const item = await one(env, sid, t.id);
      expect(item.outcome).toBe('failed');
      expect(item.message).toContain('没能先保存当前内容');
      expect(item.message).toContain('文件没有改动');
      expect(env.snapshotOf(t.f)).toEqual(snap);
      expect(row(env, t.id)).toMatchObject({ state: 'applied', restoring_at: null, after_blob: null, restore_tmp_path: null });
      // 先存后换：存不下来就没有任何一步动到目标所在的目录
      expect(env.io.calls.slice(mark).filter(x => ['rename', 'unlink', 'overwriteInPlace', 'writeDurable', 'linkExclusive'].includes(x.op) && x.path.startsWith(env.userDir))).toEqual([]);
    }
    noTemps(env.userDir);
    expect(env.scheduler.locks.snapshot().held).toEqual([]);
    // 盘有空间之后照常恢复
    env.io.reset();
    expect((await one(env, sid, m.id)).outcome).toBe('restored');
    expect(readFileSync(m.f, 'utf8')).toBe(m.original);
    expect((await one(env, sid, c.id)).outcome).toBe('deleted');
    expect(readFileSync(env.service.saveCopy(sid, c.id, 'after').path, 'utf8')).toBe(c.content);
  });

  it('R30 记录的目标落在 DeskMinis 的核心数据里（检查点目录下的一个文件；工具写不到那里，这条记录直接经写入入口造出）：预检与恢复都是 unavailable / rule-blocked，文件不动、目标零写入；另存也不往那里放副本', async () => {
    const env = cpEnv('r30'); const sid = env.newSession();
    const dir = join(env.cpDir, 'planted');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'note.txt');
    writeFileSync(f, 'before\n');
    const w = commitFileWrite(env.ctx(sid), { path: f, produce: () => Buffer.from('after\n') });
    expect(w).toMatchObject({ ok: true, created: false });
    const id = (w as { checkpointId?: string }).checkpointId as string;
    expect(row(env, id)).toMatchObject({ state: 'applied', before_blob: sha('before\n') });
    const pre = env.service.inspect(sid, [id])[0];
    expect(pre.verdict).toEqual({ kind: 'unavailable', reason: 'rule-blocked' });
    expect(pre.message).toContain('核心数据');
    const mark = env.io.calls.length;
    expect(await one(env, sid, id)).toMatchObject({ outcome: 'unavailable', verdict: { kind: 'unavailable', reason: 'rule-blocked' } });
    expect(readFileSync(f, 'utf8')).toBe('after\n');
    expect(row(env, id)).toMatchObject({ state: 'applied', restoring_at: null, after_blob: null });
    expect(env.io.calls.slice(mark).filter(c => ['rename', 'unlink', 'overwriteInPlace', 'writeDurable', 'linkExclusive'].includes(c.op))).toEqual([]);
    expect(env.scheduler.locks.snapshot()).toEqual({ held: [], waiting: [] });
    // 另存默认放在原文件旁边：那里是核心数据，不放
    const names = readdirSync(dir).sort();
    expect(() => env.service.saveCopy(sid, id, 'before')).toThrow('核心数据');
    expect(readdirSync(dir).sort()).toEqual(names);
  });

  it('另存：版本已不在检查点里时报错；原目录不在时放进会话工作桶的「恢复副本」', async () => {
    const env = cpEnv('r-copy'); const sid = env.newSession();
    const m = await modified(env, sid, join('gone', 'a.txt'));
    expect(() => env.service.saveCopy(sid, m.id, 'after')).toThrow('已不在检查点里');
    rmSync(join(env.userDir, 'gone'), { recursive: true });
    const copy = env.service.saveCopy(sid, m.id, 'before');
    expect(copy.path.startsWith(join(env.paths.sessionBucket(sid, 'workspace'), '恢复副本'))).toBe(true);
    expect(readFileSync(copy.path, 'utf8')).toBe(m.original);
    expect(existsSync(join(env.userDir, 'gone'))).toBe(false);
    temps.push(tmpDir('unused'));
  });

  it('清单上限：恰好 1000 条时不标截断；第 1001 条进来后只给最近 1000 条并标 truncated（最旧的那条不在清单里，行还在库里）', () => {
    const env = cpEnv('r-list-cap'); const sid = env.newSession();
    const now = Date.now() / 1000;
    const ins = env.db.prepare(`INSERT INTO file_checkpoints
      (id, session_id, tool_use_id, tool_name, requested_path, path, path_key, state, before_exists, after_hash, after_size, created_at, applied_at, updated_at)
      VALUES (?,?,?,?,?,?,?,'applied',0,?,?,?,?,?)`);
    const add = (n: number): void => {
      const p = join(env.userDir, `cap-${n}.txt`);
      ins.run(`CAP-${n}`, sid, `tu-cap-${n}`, 'file_write', p, p, `cap/${n}`, sha(`cap-${n}`), 1, now, now, now);
    };
    env.db.transaction(() => { for (let n = 1; n <= 1000; n++) add(n); })();
    const full = env.service.list(sid);
    expect(full.truncated).toBe(false);
    expect(full.groups.flatMap(g => g.changes)).toHaveLength(1000);
    add(1001);
    const cut = env.service.list(sid);
    expect(cut.truncated).toBe(true);
    const ids = cut.groups.flatMap(g => g.changes).map(c => c.id);
    expect(ids).toHaveLength(1000);
    expect(ids[0]).toBe('CAP-1001');                 // 从新到旧
    expect(ids).not.toContain('CAP-1');              // 被截掉的是最旧的那条
    // 已覆盖的写调用不跟着清单截断：被截掉的那条仍然有检查点，界面不该把它列进「没有检查点的改动」
    expect(cut.coveredToolUseIds).toHaveLength(1001);
    expect(cut.coveredToolUseIds).toContain('tu-cap-1');
    expect(env.rows(sid)).toHaveLength(1001);        // 只是不列，行没有被删
  });
});
