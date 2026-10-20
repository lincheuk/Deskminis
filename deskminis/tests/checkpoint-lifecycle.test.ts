/**
 * F08 × F11B（L 组）：会话删除变成「墓碑 + 物理清除」之后，文件检查点在每条路径上的行为。
 *
 * F08 写的时候会话只有一种删法（本机 deleteSession）。F11B 之后有三条清除路径（本机删除、对端墓碑、彻底删除保留副本），
 * 还多出一种状态：保留副本（会话已在别的设备删除、本机因为有对方没见过的内容而留着，隐藏、冻结，可显式恢复）。
 * 这里钉住的结论：
 *  - 三条清除路径都把这个会话的检查点记录清掉（还记着残留临时文件的行留成不带内容的占位），内容文件随后回收；
 *  - 清除不连累别的会话：同一个文件上别的会话更早的改动，文件字节仍是它写入的就照常能恢复（L9）；
 *    那个「别的会话」是保留副本时同样处理——它的记录只有文件 ID 被置空，显式恢复之后照常能恢复（L10）；
 *  - 保留副本的检查点记录与内容原样留着；已删除的会话（含保留副本）清单是空的，对比、预检、恢复、另存都拒绝，
 *    等锁期间落成保留副本的恢复在锁内重判时同样不动文件；显式恢复会话之后检查点照常可用；
 *  - 按保留期 / 容量的清理是全局的，对保留副本的记录一视同仁；
 *  - 启动次序：生命周期自检 → 检查点对账 → 运行恢复。
 * 全部用真实的库、真实的 ChatStore / CheckpointStore / CheckpointService，在临时目录上跑。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, linkSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoverOnBoot } from '../src/minisd/agent/run-recovery';
import { ChatStore } from '../src/minisd/store/chat-store';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import type { WireLifecycle } from '../src/minisd/sync/wire';
import { pathIdentity } from '../src/minisd/tools/data-gate';
import { closeAllCpEnvs, cpEnv, nextGeneration, sha, type CpEnv } from './checkpoint-fixture';
import { stripComments } from './strip-comments';
import { expectSame, callMark, onCall } from './engine-trace';
import { watchEngine, type EngineWatch } from './engine-wiring';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import type { StartMinisdOpts } from '../src/minisd/index';

const gens: { close(): void }[] = [];
afterEach(() => { for (const g of gens.splice(0)) g.close(); closeAllCpEnvs(); });

const qEngines: CapturedEngine[] = [];

const qSavedFake = process.env.DESKMINIS_FAKE_PROVIDER;

afterEach(async () => {
  for (const e of qEngines.splice(0).reverse()) await e.close();
  vi.restoreAllMocks();
  if (qSavedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER;
  else process.env.DESKMINIS_FAKE_PROVIDER = qSavedFake;
});

async function qStart(opts: StartMinisdOpts = {}): Promise<CapturedEngine> {
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const e = await startCapturedEngine(opts);
  qEngines.push(e);
  return e;
}

async function qRpc(e: CapturedEngine, name: string, p: any = {}, conn = probeConnection('local')): Promise<any> {
  return await e.methods[name](p, conn);
}

function qObserved(w: EngineWatch, name: string, owner: unknown, args: unknown[], invoke: () => unknown): unknown {
  const from = callMark();
  const result = invoke();
  expect(w.count(name, from)).toBe(1);
  expect(w.args(name)).toEqual(args);
  for (const [i, arg] of args.entries()) expectSame(w.args(name)[i], arg);
  expectSame(w.spy(name).mock.contexts.at(-1), owner);
  expect(result).toBe(w.spy(name).mock.results.at(-1)?.value);
  return result;
}

const KB = 1024;
const fill = (n: number, byte: number): Buffer => Buffer.alloc(n, byte);
/** 在用户目录里放一个文件并经真实工具覆盖它。返回这次写入留下的那一行。 */
async function overwrite(env: CpEnv, sid: string, name: string, original: Buffer | string, next = `new ${name}`) {
  const f = join(env.userDir, name);
  writeFileSync(f, original);
  const r = await env.runTool(sid, 'file_write', { path: f, content: next });
  expect(r.success, r.output).toBe(true);
  return { f, row: r.row, next };
}
const msgIds = (db: CpEnv['db'], sid: string): string[] =>
  (db.prepare('SELECT id FROM messages WHERE session_id=? ORDER BY id').all(sid) as { id: string }[]).map(r => r.id);
/** 对端的墓碑。ids = 删除方见过的消息：给全就是「本机没有它没见过的内容」（清除），给空就是「全都没见过」（保留副本）。 */
function tomb(v: number, opId: string, ids: string[]): WireLifecycle {
  return { v, opId, originDeviceId: 'devRemote', at: 1, seen: makeSeen(ids) };
}
const retain = (env: CpEnv, sid: string, opId = 'OP-A'): void => {
  expect(env.chat.applyTombstone(sid, tomb(1, opId, []), { fromPeer: 'peer' })).toMatchObject({ status: 'applied', retained: true });
};

describe('F08 × F11B L 组：会话的删除、墓碑、保留副本与检查点', () => {
  it('L1 五种清除（本机删除、对端墓碑覆盖全部内容、保留副本被同代墓碑释放、彻底删除保留副本、对保留副本调 deleteSession）：检查点行随会话清掉，gc 后只被它引用的内容没了，别的会话的行与内容不动', async () => {
    const env = cpEnv('l1');
    const keep = env.newSession();
    const shared = fill(KB, 0x70);
    const kept = await overwrite(env, keep, 'keep.bin', shared);
    const purges: [string, (sid: string) => void][] = [
      ['本机删除', sid => { expect(env.chat.deleteSession(sid).kind).toBe('deleted'); }],
      ['对端墓碑覆盖全部内容', sid => {
        expect(env.chat.applyTombstone(sid, tomb(1, 'OP-A', msgIds(env.db, sid)), { fromPeer: 'peer' })).toMatchObject({ status: 'applied', hadLocalCopy: true, retained: false });
      }],
      ['保留副本被同一代的另一条墓碑释放', sid => {
        retain(env, sid);
        expect(env.rows(sid)).toHaveLength(2);                    // 保留副本：检查点行一条不少
        expect(env.chat.applyTombstone(sid, tomb(1, 'OP-B', msgIds(env.db, sid)), { fromPeer: 'peer' })).toEqual({ status: 'stale', released: true });
      }],
      ['彻底删除保留副本', sid => { retain(env, sid); expect(env.rows(sid)).toHaveLength(2); env.chat.purgeRetained(sid); }],
      ['对保留副本调 deleteSession', sid => { retain(env, sid); expect(env.chat.deleteSession(sid).kind).toBe('purged'); }],
    ];
    for (const [i, [label, purge]] of purges.entries()) {
      const sid = env.newSession();
      const only = fill(KB, 0x10 + i);
      await overwrite(env, sid, `only-${i}.bin`, only);
      await overwrite(env, sid, `shared-${i}.bin`, shared);
      expect(env.rows(sid), label).toHaveLength(2);
      purge(sid);
      expect(env.chat.isDeleted(sid), label).toBe(true);
      expect(env.rows(sid), `${label}：检查点行应随会话清掉`).toEqual([]);
      expect(env.store.listSession(sid), label).toEqual([]);
      env.store.gc();
      expect(existsSync(env.blobPath(sha(only))), `${label}：只被它引用的内容应被回收`).toBe(false);
      expect(existsSync(env.blobPath(sha(shared))), `${label}：别的会话还引用着的内容不能删`).toBe(true);
    }
    // 别的会话的记录不受影响，仍能恢复出原字节
    expect(env.rows(keep)).toHaveLength(1);
    expect((await env.service.restore(keep, [kept.row.id])).allRestored).toBe(true);
    expect(readFileSync(kept.f).equals(shared)).toBe(true);
  });

  it('L2 还记着残留临时文件的行：对端墓碑清除、彻底删除保留副本这两条路径上同样留成不带内容的占位；重复删除（absent）不动占位行；临时文件补删之后占位行自己消失', async () => {
    for (const [label, purge] of [
      ['对端墓碑', (env: CpEnv, sid: string) => { env.chat.applyTombstone(sid, tomb(1, 'OP-A', msgIds(env.db, sid)), { fromPeer: 'peer' }); }],
      ['彻底删除保留副本', (env: CpEnv, sid: string) => { retain(env, sid); env.chat.purgeRetained(sid); }],
    ] as const) {
      const env = cpEnv('l2');
      const sid = env.newSession();
      const f = join(env.userDir, 'made.txt');
      // 新建文件时「硬链接成功、删临时文件失败」：目标带着两个链接留下，临时文件的路径记在行上（与 S19 同一手法）
      env.io.replace('linkExclusive', () => (from, to) => linkSync(from, to));
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'first line\n' });
      expect(r.success, r.output).toBe(true);
      const tmp = r.row.tmp_path as string;
      expect(existsSync(tmp), label).toBe(true);
      env.io.reset();
      const plain = fill(KB, 0x55);
      await overwrite(env, sid, 'plain.bin', plain);

      purge(env, sid);
      const left = env.rows(sid);
      expect(left, label).toHaveLength(1);
      expect(left[0], label).toMatchObject({ id: r.row.id, state: 'aborted', abort_reason: 'session-deleted', tmp_path: tmp, before_blob: null, after_blob: null, restoring_at: null });
      // 占位行不进清单、不占内容
      expect(env.store.listSession(sid), label).toEqual([]);
      env.store.gc();
      expect(existsSync(env.blobPath(sha(plain))), label).toBe(false);
      // 再删一次：这个 id 名下已经没有会话行与消息，走 absent——占位行要留到临时文件确认不在
      expect(env.chat.deleteSession(sid), label).toEqual({ kind: 'absent' });
      expect(env.rows(sid), label).toHaveLength(1);
      // 对账补删临时文件，占位行随之消失；用户的文件没有被动过
      env.store.reconcile();
      expect(existsSync(tmp), label).toBe(false);
      expect(env.rows(sid), label).toEqual([]);
      expect(readFileSync(f, 'utf8'), label).toBe('first line\n');
      expect(readdirSync(env.userDir).filter(n => n.startsWith('.dm-')), label).toEqual([]);
    }
  });

  it('L3 保留副本：检查点行与内容原样留着；清单是空的，预检、对比、恢复、另存都抛「会话已删除」，文件、行、审计都不变；显式恢复会话之后清单回来、恢复得到原始字节', async () => {
    const env = cpEnv('l3'); const sid = env.newSession();
    const original = Buffer.from('original\n');
    const { f, row } = await overwrite(env, sid, 'a.txt', original, 'agent\n');
    const rowsBefore = JSON.stringify(env.rows(sid));
    retain(env, sid);
    // 保留副本不走物理清除：记录一条不少，内容文件在，回收也不碰它
    expect(JSON.stringify(env.rows(sid))).toBe(rowsBefore);
    env.store.gc();
    expect(existsSync(env.blobPath(sha(original)))).toBe(true);

    // 已删除的会话不显示：清单是空的（占用是全局的，照给），不抛
    const list = env.service.list(sid);
    expect(list.groups).toEqual([]);
    expect(list.coveredToolUseIds).toEqual([]);
    expect(list.truncated).toBe(false);
    expect(list.usage).toMatchObject({ checkpointCount: 1, usedBytes: original.length });
    // 其余四个按会话取数或动文件的入口一律拒绝
    expect(() => env.service.inspect(sid, [row.id])).toThrow('会话已删除');
    await expect(env.service.diff(sid, row.id)).rejects.toThrow('会话已删除');
    await expect(env.service.restore(sid, [row.id])).rejects.toThrow('会话已删除');
    expect(() => env.service.saveCopy(sid, row.id, 'before')).toThrow('会话已删除');
    expect(readFileSync(f, 'utf8')).toBe('agent\n');
    expect(JSON.stringify(env.rows(sid))).toBe(rowsBefore);
    expect(env.audits).toEqual([]);
    expect(readdirSync(env.userDir)).toEqual(['a.txt']);
    expect(env.scheduler.locks.snapshot()).toEqual({ held: [], waiting: [] });

    // 显式恢复会话：检查点照常可用
    env.chat.restoreSession(sid);
    const back = env.service.list(sid);
    expect(back.groups).toHaveLength(1);
    expect(back.groups[0].changes.map(c => [c.id, c.state])).toEqual([[row.id, 'applied']]);
    expect(env.service.inspect(sid, [row.id])[0].verdict).toEqual({ kind: 'ready', action: 'overwrite' });
    expect((await env.service.diff(sid, row.id)).before).toMatchObject({ exists: true, text: 'original\n' });
    const rep = await env.service.restore(sid, [row.id]);
    expect(rep.allRestored).toBe(true);
    expect(readFileSync(f).equals(original)).toBe(true);
    expect(env.audits.map(a => a.type)).toEqual(['checkpoint.restore']);
  });

  it('L3b 已清除的会话：清单是空的、不抛；拿着旧的检查点 id 调预检、对比、恢复、另存，得到的是「会话已删除」', async () => {
    const env = cpEnv('l3b'); const sid = env.newSession();
    const { f, row } = await overwrite(env, sid, 'a.txt', 'original\n', 'agent\n');
    expect(env.chat.deleteSession(sid).kind).toBe('deleted');
    const list = env.service.list(sid);
    expect(list.groups).toEqual([]);
    expect(list.coveredToolUseIds).toEqual([]);
    expect(list.usage.checkpointCount).toBe(0);
    expect(() => env.service.inspect(sid, [row.id])).toThrow('会话已删除');
    await expect(env.service.diff(sid, row.id)).rejects.toThrow('会话已删除');
    await expect(env.service.restore(sid, [row.id])).rejects.toThrow('会话已删除');
    expect(() => env.service.saveCopy(sid, row.id, 'before')).toThrow('会话已删除');
    expect(readFileSync(f, 'utf8')).toBe('agent\n');
    // 对照：从没删除过的会话拿着不存在的 id，仍是原来那一句
    const live = env.newSession();
    expect(() => env.service.inspect(live, [row.id])).toThrow('检查点不存在');
  });

  it('L4 恢复在等锁期间会话被对端删除、落成保留副本：拿到锁之后重判为「会话已删除」，不动文件、不动记录、放掉锁', async () => {
    const env = cpEnv('l4', { lockWaitMs: 30_000 }); const sid = env.newSession();
    const { f, row } = await overwrite(env, sid, 'a.txt', 'original\n', 'agent\n');
    const id = pathIdentity(f);
    const held = await env.scheduler.locks.acquire({ group: 'someone-else', label: 'holder', claims: [{ ns: 'path', root: id.root, segs: id.segs, mode: 'write', display: f }] });
    if (!held.ok) throw new Error('没拿到锁');
    const pending = env.service.restore(sid, [row.id]);
    await vi.waitFor(() => { expect(env.scheduler.locks.snapshot().waiting).toHaveLength(1); });
    retain(env, sid);
    held.release();
    const rep = await pending;
    expect(rep.allRestored).toBe(false);
    expect(rep.items).toHaveLength(1);
    expect(rep.items[0]).toMatchObject({ id: row.id, outcome: 'unavailable', verdict: { kind: 'unavailable', reason: 'session-deleted' } });
    expect(rep.items[0].message).toContain('已删除');
    expect(readFileSync(f, 'utf8')).toBe('agent\n');
    expect(env.rows(sid)[0]).toMatchObject({ state: 'applied', after_blob: null, restoring_at: null, restore_tmp_path: null });
    expect(readdirSync(env.userDir)).toEqual(['a.txt']);
    expect(env.scheduler.locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('L5 保留期清理是全局的：保留副本的记录到期照常标成已清理、内容回收（不算对会话的写入）；会话恢复之后那条记录显示为已清理、不能恢复；已清除的会话没有记录可清', async () => {
    let now = 1_800_000_000;
    const env = cpEnv('l5', { store: { now: () => now } });
    const kept = env.newSession(); const gone = env.newSession();
    const a = await overwrite(env, kept, 'a.bin', fill(KB, 1));
    await overwrite(env, gone, 'g.bin', fill(KB, 2));
    retain(env, kept);
    expect(env.chat.deleteSession(gone).kind).toBe('deleted');
    expect(env.store.usage()).toMatchObject({ checkpointCount: 1 });   // 只剩保留副本的那一条；已清除的会话没有行
    now += 31 * 86400;
    expect(env.store.prune()).toBe(1);
    expect(env.rows(kept)[0].pruned_at).not.toBeNull();
    expect(env.rows(kept)[0]).toMatchObject({ state: 'applied', before_blob: null });
    expect(env.blobFiles()).toEqual([]);
    // 清理没有动会话本身：仍是保留副本，消息一条不少
    expect(env.chat.listRetainedSessions().map(r => r.id)).toEqual([kept]);
    env.chat.restoreSession(kept);
    const list = env.service.list(kept);
    expect(list.groups[0].changes[0].prunedAt).toBeDefined();
    expect(env.service.inspect(kept, [a.row.id])[0].verdict).toEqual({ kind: 'unavailable', reason: 'pruned' });
  });

  it('L5b 容量清理同样是全局的：保留副本的记录最旧时先被挤掉（行还在、标成已清理、内容回收），别的会话的写入因此成功；保留副本的会话行与消息不动', async () => {
    const env = cpEnv('l5b', { store: { quotaBytes: () => 10 * KB } });
    const kept = env.newSession(); const live = env.newSession();
    const first = fill(6 * KB, 0x61);
    const a = await overwrite(env, kept, 'a.bin', first);
    retain(env, kept);
    const msgs = msgIds(env.db, kept);
    const second = fill(6 * KB, 0x62);
    const b = await overwrite(env, live, 'b.bin', second);       // 6 + 6 > 10：要先清掉最旧的那条——它属于保留副本
    const row = env.rows(kept)[0];
    expect(row).toMatchObject({ id: a.row.id, state: 'applied', before_blob: null });
    expect(row.pruned_at).not.toBeNull();
    expect(existsSync(env.blobPath(sha(first)))).toBe(false);
    expect(env.rows(live)[0]).toMatchObject({ id: b.row.id, state: 'applied', before_blob: sha(second) });
    expect(readFileSync(b.f, 'utf8')).toBe('new b.bin');
    expect(env.chat.listRetainedSessions().map(r => r.id)).toEqual([kept]);
    expect(msgIds(env.db, kept)).toEqual(msgs);
  });

  it('L6 启动次序（生命周期自检 → 检查点对账 → 运行恢复）：写入崩在半路、重启前这个会话的登记已是「已删除」而隐藏标记没打上——检查点按实际文件落定，运行恢复只关账、一条消息不补；恢复会话之后这次改动在清单里、可以恢复', async () => {
    const env = cpEnv('l6'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, 'original\n');
    env.io.crash('after-replace', () => env.snapshotDb());
    await env.runTool(sid, 'file_write', { path: f, content: 'agent content\n' });
    const snap = env.io.crashedSnapshot();
    if (snap === undefined) throw new Error('没有取到崩溃快照');
    const g = nextGeneration(env, snap);
    gens.push(g);
    const chat = new ChatStore(g.db);
    const before = msgIds(g.db, sid);
    expect(g.db.prepare('SELECT state FROM file_checkpoints').all()).toEqual([{ state: 'pending' }]);
    // 不一致的库：登记是奇数（已删除），会话行还在、没有隐藏标记
    g.db.prepare(`INSERT INTO session_lifecycle (session_id, version, op_id, origin_device_id, origin_at, recorded_at) VALUES (?, 1, 'OP-X', 'devRemote', 1, 1)`).run(sid);

    // 与 index.ts 启动时相同的次序
    expect(chat.repairLifecycle()).toEqual({ unhidden: 0, hidden: 1 });
    expect(g.store.reconcile().map(r => r.state)).toEqual(['applied']);
    const report = recoverOnBoot({ ledger: g.ledger, chat, warn: () => undefined, effectEvidence: row => g.store.effectEvidence(row) });
    expect(report.failed).toEqual([]);
    expect(report.batches).toMatchObject([{ sessionId: sid, superseded: true }]);
    expect(msgIds(g.db, sid)).toEqual(before);                    // 保留副本是冻结的：一条消息不补
    expect(readFileSync(f, 'utf8')).toBe('agent content\n');      // 对账与恢复都没有改用户的文件
    expect(g.db.prepare('SELECT state, active FROM agent_runs WHERE session_id=?').all(sid)).toMatchObject([{ state: 'interrupted', active: null }]);

    // 保留副本：清单是空的；恢复会话之后这次改动回到清单里，能恢复出原字节
    expect(g.service.list(sid).groups).toEqual([]);
    chat.restoreSession(sid);
    const list = g.service.list(sid);
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0].changes.map(c => c.state)).toEqual(['applied']);
    const rep = await g.service.restore(sid, [list.groups[0].changes[0].id]);
    expect(rep.allRestored).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('original\n');
  });

  it('L9 清除一个会话不连累别的会话在同一文件上更早的改动（本机删除、对端墓碑覆盖全部内容、彻底删除保留副本各一遍）：被清除的会话恢复过自己的改动、或把内容改回去过，文件字节正是别的会话当初写入的——那条更早的改动清除之后预检仍是就绪、恢复得到原始字节，不被判成「换成了另一份内容相同的文件」；同一路径上别的会话记录里的文件 ID 置空，别的路径上的不动；文件被改过时照样判 modified', async () => {
    const purges = [
      ['本机删除', (env: CpEnv, sid: string) => { expect(env.chat.deleteSession(sid).kind).toBe('deleted'); }],
      ['对端墓碑覆盖全部内容', (env: CpEnv, sid: string) => {
        expect(env.chat.applyTombstone(sid, tomb(1, 'OP-A', msgIds(env.db, sid)), { fromPeer: 'peer' })).toMatchObject({ status: 'applied', hadLocalCopy: true, retained: false });
      }],
      ['彻底删除保留副本', (env: CpEnv, sid: string) => { retain(env, sid); env.chat.purgeRetained(sid); }],
    ] as const;
    for (const [label, purge] of purges) {
      // 时钟严格递增：「哪一次恢复更晚」按时刻比，两次恢复落在同一个时刻不是这条用例要测的
      let tick = 1_800_000_000;
      const env = cpEnv('l9', { store: { now: () => (tick += 1) } });
      const a = env.newSession(); const b = env.newSession(); const d = env.newSession();
      const at = (name: string): string => join(env.userDir, name);
      const write = async (sid: string, name: string, content: string): Promise<string> => {
        const r = await env.runTool(sid, 'file_write', { path: at(name), content });
        expect(r.success, `${label} ${name}: ${r.output}`).toBe(true);
        return r.row.id as string;
      };
      const undo = async (sid: string, id: string): Promise<void> => {
        expect((await env.service.restore(sid, [id])).allRestored, label).toBe(true);
      };
      const rowOf = (id: string): any => env.rows().find(r => r.id === id);
      const verdictOf = (sid: string, id: string) => env.service.inspect(sid, [id])[0].verdict;
      for (const name of ['pair.txt', 'three.txt', 'flip.txt', 'edited.txt', 'only-a.txt']) writeFileSync(at(name), 'v0\n');

      // pair.txt：A 改、B 再改、B 恢复了自己的改动——文件回到 A 写入的内容，文件 ID 是 B 那次恢复留下的
      const aPair = await write(a, 'pair.txt', 'v1\n');
      await undo(b, await write(b, 'pair.txt', 'v2\n'));
      // three.txt：A、B、D 依次改，D 先恢复、B 再恢复——同一路径上还留着 D 那条「已恢复」的记录，它记的文件 ID 比 B 的恢复旧
      const aThree = await write(a, 'three.txt', 'v1\n');
      const bThree = await write(b, 'three.txt', 'v2\n');
      const dThree = await write(d, 'three.txt', 'v3\n');
      await undo(d, dThree);
      await undo(b, bThree);
      // flip.txt：A 改，B 改走又改回来（两条都没有恢复）——内容等于 A 写入的，文件 ID 是 B 第二次写入留下的
      const aFlip = await write(a, 'flip.txt', 'v1\n');
      await write(b, 'flip.txt', 'v2\n');
      await write(b, 'flip.txt', 'v1\n');
      // edited.txt：同 pair.txt，清除之后用户又手改了文件；only-a.txt：只有 A 改过，B 没碰过这条路径
      const aEdited = await write(a, 'edited.txt', 'v1\n');
      await undo(b, await write(b, 'edited.txt', 'v2\n'));
      const aOnly = await write(a, 'only-a.txt', 'v1\n');
      for (const name of ['pair.txt', 'three.txt', 'flip.txt', 'edited.txt']) expect(readFileSync(at(name), 'utf8'), `${label} ${name}`).toBe('v1\n');

      // 清除之前：恢复链都在记录里，A 的两条认得出来；flip.txt 上 B 的两次写入还挡着
      expect(verdictOf(a, aPair), label).toEqual({ kind: 'ready', action: 'overwrite' });
      expect(verdictOf(a, aThree), label).toEqual({ kind: 'ready', action: 'overwrite' });
      expect(verdictOf(a, aFlip), label).toMatchObject({ kind: 'conflict', reason: 'superseded' });
      const onlyBefore = [rowOf(aOnly).file_dev, rowOf(aOnly).file_ino];

      purge(env, b);
      expect(env.rows(b), label).toEqual([]);

      // 清除之后：B 在这些路径上做过什么已经不在记录里，A 的改动按文件现在的内容判——字节正是它写入的，就绪
      for (const id of [aPair, aThree, aFlip]) expect(verdictOf(a, id), `${label} ${rowOf(id).path}`).toEqual({ kind: 'ready', action: 'overwrite' });
      // 同一路径上别的会话的记录：文件 ID 置空（预检跳过这一条比对）；B 没碰过的路径上原样留着
      for (const id of [aPair, aThree, aFlip, aEdited]) expect(rowOf(id), `${label} ${rowOf(id).path}`).toMatchObject({ state: 'applied', file_dev: null, file_ino: null });
      expect(rowOf(dThree), label).toMatchObject({ state: 'restored', restored_dev: null, restored_ino: null });
      expect([rowOf(aOnly).file_dev, rowOf(aOnly).file_ino], label).toEqual(onlyBefore);
      // 内容的核对一条没少：清除之后用户手改过的文件照样是冲突，不动它
      writeFileSync(at('edited.txt'), 'the user kept working on it\n');
      expect(verdictOf(a, aEdited), label).toEqual({ kind: 'conflict', reason: 'modified' });

      const rep = await env.service.restore(a, [aPair, aThree, aFlip, aEdited, aOnly]);
      expect(rep.items.map(i => i.outcome), label).toEqual(['restored', 'restored', 'restored', 'conflict', 'restored']);
      for (const name of ['pair.txt', 'three.txt', 'flip.txt', 'only-a.txt']) expect(readFileSync(at(name), 'utf8'), `${label} ${name}`).toBe('v0\n');
      expect(readFileSync(at('edited.txt'), 'utf8'), label).toBe('the user kept working on it\n');
      expect(readdirSync(env.userDir).filter(n => n.startsWith('.dm-')), label).toEqual([]);
    }
  });

  it('L10 「别的会话」是保留副本时同样置空（三种清除各一遍）：保留副本 A 与会话 B 改过同一个文件，B 被清除——A 在这条路径上的记录的文件 ID 置空，状态、内容引用、会话行与消息都不动，它仍是保留副本（清单空、预检报「会话已删除」）；A 在别的路径上的记录原样。显式恢复 A 之后预检就绪、恢复得到原始字节，不被判成「换成了另一份内容相同的文件」', async () => {
    const purges = [
      ['本机删除', (env: CpEnv, sid: string) => { expect(env.chat.deleteSession(sid).kind).toBe('deleted'); }],
      ['对端墓碑覆盖全部内容', (env: CpEnv, sid: string) => {
        expect(env.chat.applyTombstone(sid, tomb(1, 'OP-B', msgIds(env.db, sid)), { fromPeer: 'peer' })).toMatchObject({ status: 'applied', hadLocalCopy: true, retained: false });
      }],
      ['彻底删除保留副本', (env: CpEnv, sid: string) => { retain(env, sid, 'OP-B'); env.chat.purgeRetained(sid); }],
    ] as const;
    for (const [label, purge] of purges) {
      let tick = 1_800_000_000;
      const env = cpEnv('l10', { store: { now: () => (tick += 1) } });
      const a = env.newSession(); const b = env.newSession();
      const at = (name: string): string => join(env.userDir, name);
      const write = async (sid: string, name: string, content: string): Promise<string> => {
        const r = await env.runTool(sid, 'file_write', { path: at(name), content });
        expect(r.success, `${label} ${name}: ${r.output}`).toBe(true);
        return r.row.id as string;
      };
      const rowOf = (id: string): any => env.rows().find(r => r.id === id);
      for (const name of ['pair.txt', 'only-a.txt']) writeFileSync(at(name), 'v0\n');

      // pair.txt：A 改、B 再改、B 恢复了自己的改动——文件回到 A 写入的字节，文件 ID 是 B 那次恢复留下的。only-a.txt：B 没碰过
      const aPair = await write(a, 'pair.txt', 'v1\n');
      const bPair = await write(b, 'pair.txt', 'v2\n');
      expect((await env.service.restore(b, [bPair])).allRestored, label).toBe(true);
      const aOnly = await write(a, 'only-a.txt', 'v1\n');
      expect(readFileSync(at('pair.txt'), 'utf8'), label).toBe('v1\n');

      // A 在别的设备上被删除，本机有对方没见过的消息：落成保留副本，检查点原样留着
      retain(env, a);
      const before = { pair: rowOf(aPair), only: rowOf(aOnly), msgs: msgIds(env.db, a) };
      expect(before.pair.file_ino, label).not.toBeNull();

      purge(env, b);
      expect(env.rows(b), label).toEqual([]);

      // 置空的只有文件 ID；状态、内容引用、清理标记不动
      expect(rowOf(aPair), label).toMatchObject({
        state: 'applied', file_dev: null, file_ino: null, restored_dev: null, restored_ino: null,
        before_blob: before.pair.before_blob, after_blob: before.pair.after_blob, pruned_at: null, restoring_at: null,
      });
      expect(rowOf(aOnly), label).toEqual(before.only);
      // 它仍是保留副本：会话行与消息不动，清单是空的，按会话取数的入口照旧拒绝
      expect(env.chat.listRetainedSessions().map(r => r.id), label).toEqual([a]);
      expect(msgIds(env.db, a), label).toEqual(before.msgs);
      expect(env.service.list(a).groups, label).toEqual([]);
      expect(() => env.service.inspect(a, [aPair]), label).toThrow('会话已删除');
      expect(readFileSync(at('pair.txt'), 'utf8'), label).toBe('v1\n');

      // 显式恢复之后：文件字节正是 A 当初写入的，就绪；恢复得到原始字节
      env.chat.restoreSession(a);
      expect(env.service.inspect(a, [aPair, aOnly]).map(p => p.verdict), label).toEqual([{ kind: 'ready', action: 'overwrite' }, { kind: 'ready', action: 'overwrite' }]);
      const rep = await env.service.restore(a, [aPair, aOnly]);
      expect(rep.items.map(i => i.outcome), label).toEqual(['restored', 'restored']);
      for (const name of ['pair.txt', 'only-a.txt']) expect(readFileSync(at(name), 'utf8'), `${label} ${name}`).toBe('v0\n');
      expect(readdirSync(env.userDir).filter(n => n.startsWith('.dm-')), label).toEqual([]);
    }
  });
});

describe('F08 × F11B L 组：源码守卫（先剥注释）', () => {
  const src = (...p: string[]): string => stripComments(readFileSync(join(__dirname, '..', 'src', ...p), 'utf8'));

  it('L7 chat-store.ts：file_checkpoints 的三句都在 purgeSessionRows 里、排在登记检查之后与 DELETE FROM sessions 之前——先把同一路径上别的会话记录里的文件 ID 置空（那时本会话的行还在，才知道是哪些路径），再删行、留占位；别处不碰检查点的两张表', () => {
    const c = src('minisd', 'store', 'chat-store.ts');
    const start = c.indexOf('private purgeSessionRows(');
    expect(start).toBeGreaterThan(0);
    const body = c.slice(start, c.indexOf('\n  }\n', start));
    const ids = body.search(/UPDATE\s+file_checkpoints\s+SET\s+file_dev=NULL,\s*file_ino=NULL,\s*restored_dev=NULL,\s*restored_ino=NULL[^`]*WHERE\s+session_id<>\?[^`]*path_key\s+IN\s*\(\s*SELECT\s+path_key\s+FROM\s+file_checkpoints\s+WHERE\s+session_id=\?\s+AND\s+state<>'aborted'\s*\)/i);
    const del = body.search(/DELETE\s+FROM\s+file_checkpoints\s+WHERE\s+session_id=\?\s+AND\s+tmp_path\s+IS\s+NULL\s+AND\s+restore_tmp_path\s+IS\s+NULL/i);
    const upd = body.search(/UPDATE\s+file_checkpoints\s+SET\s+state='aborted',\s*abort_reason='session-deleted',\s*before_blob=NULL,\s*after_blob=NULL/i);
    expect(ids).toBeGreaterThan(body.indexOf('登记不是已删除'));
    expect(del).toBeGreaterThan(ids);
    expect(upd).toBeGreaterThan(del);
    expect(body.search(/DELETE\s+FROM\s+sessions\b/i)).toBeGreaterThan(upd);
    // 整个文件里这两张表只出现在那三句里（第一句带一个子查询，表名出现两次）：保留副本、absent 分支、恢复都不动检查点
    expect(c.match(/file_checkpoints/g) ?? []).toHaveLength(4);
    expect(c).not.toContain('checkpoint_blobs');
  });

  it('L8 index.ts：检查点服务按 chat.isDeleted 判已删除；生命周期钩子在会话被物理清除时回收内容；启动次序是自检 → 开账本 → 检查点对账 → 运行恢复 → 启动清扫', async () => {
    // 完整启动次序包括清扫参数；服务构造恰一次，删除判据问引擎的ChatStore。
    const w = watchEngine();
    await qStart();
    const order = ['chat.repairLifecycle', 'new RunLedger', 'new CheckpointStore', 'checkpoints.reconcile', 'recoverOnBoot', 'checkpoints.sweep', 'rpc.listen'];
    expect(w.seq(order)).toEqual(order);
    expect(w.count('new CheckpointService')).toBe(1);
    expect(w.args('checkpoints.sweep')).toEqual([{ sweep: true }]);
    const chat = w.made('new ChatStore');
    const store = w.made('new CheckpointStore');
    const deleted = w.args('new CheckpointService')[0].isSessionDeleted;
    const sid = chat.createSession('Q20A L8').id;
    for (const id of [sid, 'Q20A-NEVER-EXISTED']) {
      expect(qObserved(w, 'chat.isDeleted', chat, [id], () => deleted(id))).toBe(false);
    }
    chat.deleteSession(sid);
    expect(qObserved(w, 'chat.isDeleted', chat, [sid], () => deleted(sid))).toBe(true);
    // 直接调用真实生命周期钩子：四种物理清除均回收一次，保留/缺少本地副本/恢复均不回收。
    expect(typeof chat.onLifecycle).toBe('function');
    const { allLifecycleEvents } = await import('./engine-trace');
    const events = allLifecycleEvents('Q20A-NO-LOCAL-COPY', { v: 1, opId: 'Q20A-OP', originDeviceId: 'Q20A-DEVICE', at: 0 });
    const tombstone = events.find(e => e.kind === 'tombstone-applied')!;
    for (const event of [...events,
    { ...tombstone, hadLocalCopy: true, retained: true },
    { ...tombstone, hadLocalCopy: false, retained: false },
    { ...tombstone, hadLocalCopy: false, retained: true },
    ]) {
      const from = callMark();
      chat.onLifecycle(event);
      const collect = ['deleted', 'purged', 'retained-released'].includes(event.kind) || event.kind === 'tombstone-applied' && event.hadLocalCopy && !event.retained;
      expect(w.count('checkpoints.gc', from), JSON.stringify(event)).toBe(collect ? 1 : 0);
      if (collect) {
        expect(w.args('checkpoints.gc')).toEqual([]);
        expectSame(w.spy('checkpoints.gc').mock.contexts.at(-1), store);
      }
    }
  }, 60000);
});
