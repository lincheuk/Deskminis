/**
 * F08 × F11B（E 组）：真实引擎上的会话删除、对端墓碑、保留副本与文件检查点。
 *
 * 走真实 minisd（进程内起、RPC 驱动、假模型端点）；对端的墓碑经本机连接的 sync.push 注入（与 F11B 的端到端夹具同一做法），
 * 走的是真实的收包入口 → 宿主 → ChatStore.applyTombstone → 生命周期钩子。断言落在磁盘文件与库里的行上。
 *  E1：三条清除路径（加上保留副本被释放）之后，检查点行清掉，只被这个会话引用的内容文件当场从盘上消失——
 *      不等下一次写入、看清单或重启（生命周期钩子里的回收）。
 *  E2：保留副本的 RPC 口径（清单为空，预检 / 对比 / 恢复 / 另存报「会话已删除」），显式恢复会话之后检查点照常可用。
 *  E3：引擎在「保留副本带着一条没落定的检查点、隐藏标记还丢了」的库上启动：自检、对账、恢复三步都不抛，记录按实际文件落定。
 * 工作区都是临时建的普通目录（数据根之外），绝不碰用户的真实文件。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd, type StartMinisdOpts } from '../src/minisd/index';
import { makeSeen } from '../src/minisd/sync/lifecycle';
import type { WireLifecycle } from '../src/minisd/sync/wire';
import { eventsOf, mockLlm, readDb, rpcClient, waitFor, type Client, type LlmStep } from './run-ledger-fixture';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const scripts: Record<string, LlmStep[]> = {
  S1: [{ tools: [{ name: 'file_edit', input: { path: 'doc.txt', old_string: 'alpha', new_string: 'beta', tool_title: '修改' } }] }, { text: 'S1 完成' }],
};
let llm: Awaited<ReturnType<typeof mockLlm>>;
beforeAll(async () => { llm = await mockLlm(scripts); });
afterAll(async () => { await llm?.close(); });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

async function boot(opts: StartMinisdOpts = {}) {
  const fresh = opts.dataDir === undefined;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'dm-f08-e-'));
  process.env.DESKMINIS_TEST = '1';
  delete process.env.DESKMINIS_FAKE_PROVIDER;
  const srv = await startMinisd({ host: '127.0.0.1', port: 0, permTimeoutMs: 60000, ...opts, dataDir });
  let closed = false;
  const close = async (): Promise<void> => { if (!closed) { closed = true; await srv.close(); } };
  cleanups.push(close);
  const c = rpcClient(srv.port, srv.authToken);
  await c.ready;
  cleanups.push(() => c.close());
  if (fresh) {
    const prov = (await c.call('provider.instances.create', { name: 'f08-mock', kind: 'ollama', baseUrl: llm.baseUrl, modelId: 'f08-mock' })).result;
    expect((await c.call('provider.setDefault', { id: prov.id })).error).toBeUndefined();
  }
  return { ...srv, dataDir, c, close };
}

interface Sess { id: string; dir: string; file: string; original: string; edited: string; blob: string }
/** 建一个会话，工作区绑到一个新的临时目录，放一个内容各不相同的 doc.txt，让模型改它一次（留下一条检查点与一份内容）。 */
async function editedSession(c: Client, dataDir: string, label: string): Promise<Sess> {
  const dir = mkdtempSync(join(tmpdir(), `dm-f08-e-user-${label}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = (await c.call('chat.sessions.create', {})).result;
  expect((await c.call('workspace.set', { sessionId: s.id, root: dir })).error).toBeUndefined();
  const original = `${label} alpha\n`;
  const file = join(dir, 'doc.txt');
  writeFileSync(file, original, 'utf8');
  expect((await c.call('chat.prompt', { sessionId: s.id, text: '[[S1]] 请执行' })).error).toBeUndefined();
  await waitFor(`${label} 的运行结束`, () => eventsOf(c, s.id).some(e => e.kind === 'turnEnd'), 60_000);
  const hash = sha(original);
  return { id: s.id, dir, file, original, edited: original.replace('alpha', 'beta'), blob: join(dataDir, 'checkpoints', 'blobs', hash.slice(0, 2), hash) };
}
const cpRows = (dataDir: string, sessionId: string): any[] => readDb(dataDir, 'SELECT * FROM file_checkpoints WHERE session_id=? ORDER BY seq', sessionId);
const msgIds = (dataDir: string, sessionId: string): string[] =>
  (readDb(dataDir, 'SELECT id FROM messages WHERE session_id=? ORDER BY id', sessionId) as { id: string }[]).map(r => r.id);
const sessionRow = (dataDir: string, sessionId: string): { t: number | null } | undefined =>
  readDb(dataDir, 'SELECT remote_tombstoned_at AS t FROM sessions WHERE id=?', sessionId)[0];
async function ok(c: Client, method: string, params: unknown): Promise<any> {
  const r = await c.call(method, params);
  expect(r.error, `${method} 应当成功`).toBeUndefined();
  return r.result;
}
async function errorOf(c: Client, method: string, params: unknown): Promise<string> {
  const r = await c.call(method, params);
  expect(r.error, `${method} 应当被拒`).toBeDefined();
  return String(r.error.message);
}
/** 对端的墓碑，经本机连接注入。ids = 删除方见过的消息：给全 → 清除；给空 → 本机留副本。 */
function pushTombstone(c: Client, sessionId: string, v: number, opId: string, ids: string[]): Promise<any> {
  const lifecycle: WireLifecycle = { v, opId, originDeviceId: 'devRemote', at: 1, seen: makeSeen(ids) };
  return ok(c, 'sync.push', { sessionId, payload: { messages: [], markers: [], lifecycle } });
}

describe('F08 × F11B 生产链路：会话的删除、墓碑、保留副本与检查点', () => {
  it('E1 本机删除、对端墓碑清除、保留副本被释放、彻底删除保留副本：检查点行清掉，只被这个会话引用的内容文件当场从盘上消失（不等下一次写入、看清单或重启）；别的会话的行与内容不动，用户的文件不动', async () => {
    const { c, dataDir } = await boot();
    const keep = await editedSession(c, dataDir, 'keep');
    const local = await editedSession(c, dataDir, 'local');
    const remote = await editedSession(c, dataDir, 'remote');
    const released = await editedSession(c, dataDir, 'released');
    const purged = await editedSession(c, dataDir, 'purged');
    const all = [keep, local, remote, released, purged];
    for (const s of all) {
      expect(cpRows(dataDir, s.id).map(r => r.state)).toEqual(['applied']);
      expect(existsSync(s.blob)).toBe(true);
    }
    // 从这里起不再调任何会顺带回收内容的入口（chat.prompt、checkpoints.list、checkpoints.usage）
    const gone = (s: Sess, what: string): void => {
      expect(cpRows(dataDir, s.id), `${what}：检查点行`).toEqual([]);
      expect(existsSync(s.blob), `${what}：内容文件应当场回收`).toBe(false);
    };

    await ok(c, 'chat.sessions.delete', { sessionId: local.id, confirm: true });
    gone(local, '本机删除');

    await pushTombstone(c, remote.id, 1, 'OP-A', msgIds(dataDir, remote.id));
    expect(sessionRow(dataDir, remote.id)).toBeUndefined();
    gone(remote, '对端墓碑覆盖全部内容');

    // 删除方什么都没见过：本机留副本，检查点行与内容原样留着
    await pushTombstone(c, released.id, 1, 'OP-A', []);
    expect(sessionRow(dataDir, released.id)?.t).not.toBeNull();
    expect(cpRows(dataDir, released.id)).toHaveLength(1);
    expect(existsSync(released.blob)).toBe(true);
    // 同一代的另一条墓碑见过全部消息：副本被释放
    await pushTombstone(c, released.id, 1, 'OP-B', msgIds(dataDir, released.id));
    expect(sessionRow(dataDir, released.id)).toBeUndefined();
    gone(released, '保留副本被释放');

    await pushTombstone(c, purged.id, 1, 'OP-A', []);
    expect(cpRows(dataDir, purged.id)).toHaveLength(1);
    expect(existsSync(purged.blob)).toBe(true);
    await ok(c, 'chat.sessions.purgeRetained', { sessionId: purged.id, confirm: true });
    gone(purged, '彻底删除保留副本');

    // 别的会话的行与内容不动；登记表里也只剩它那一份
    expect(cpRows(dataDir, keep.id)).toHaveLength(1);
    expect(existsSync(keep.blob)).toBe(true);
    expect(readDb(dataDir, 'SELECT hash FROM checkpoint_blobs').map((r: any) => r.hash)).toEqual([sha(keep.original)]);
    // 删除会话不动用户的文件
    for (const s of all) expect(readFileSync(s.file, 'utf8')).toBe(s.edited);
  }, 180_000);

  it('E2 保留副本：checkpoints.list 是空清单，inspect / diff / restore / saveCopy 报「会话已删除」，文件与行不变、没有恢复或另存的审计；chat.sessions.restore 之后清单回来，恢复得到原始字节', async () => {
    const { c, dataDir } = await boot();
    const s = await editedSession(c, dataDir, 'retained');
    const id = cpRows(dataDir, s.id)[0].id as string;
    await pushTombstone(c, s.id, 1, 'OP-A', []);
    expect((await ok(c, 'chat.sessions.listRetained', {})).map((x: { id: string }) => x.id)).toEqual([s.id]);
    const rowsBefore = JSON.stringify(cpRows(dataDir, s.id));

    const list = await ok(c, 'checkpoints.list', { sessionId: s.id });
    expect(list.groups).toEqual([]);
    expect(list.coveredToolUseIds).toEqual([]);
    expect(list.usage.checkpointCount).toBe(1);                 // 占用是全局的：保留副本的那一条照算
    expect(await errorOf(c, 'checkpoints.inspect', { sessionId: s.id, ids: [id] })).toContain('会话已删除');
    expect(await errorOf(c, 'checkpoints.diff', { sessionId: s.id, id })).toContain('会话已删除');
    expect(await errorOf(c, 'checkpoints.restore', { sessionId: s.id, ids: [id], confirm: true })).toContain('会话已删除');
    expect(await errorOf(c, 'checkpoints.saveCopy', { sessionId: s.id, id, which: 'before', confirm: true })).toContain('会话已删除');
    expect(readFileSync(s.file, 'utf8')).toBe(s.edited);
    expect(readdirSync(s.dir)).toEqual(['doc.txt']);
    expect(JSON.stringify(cpRows(dataDir, s.id))).toBe(rowsBefore);
    expect(existsSync(s.blob)).toBe(true);
    expect(readDb(dataDir, "SELECT event_type FROM audit_logs WHERE event_type LIKE 'checkpoint.%'")).toEqual([]);

    // 显式恢复会话：检查点照常可用
    await ok(c, 'chat.sessions.restore', { sessionId: s.id, confirm: true });
    const back = await ok(c, 'checkpoints.list', { sessionId: s.id });
    expect(back.groups).toHaveLength(1);
    expect(back.groups[0].changes.map((x: any) => [x.id, x.state])).toEqual([[id, 'applied']]);
    expect((await ok(c, 'checkpoints.inspect', { sessionId: s.id, ids: [id] }))[0].verdict).toEqual({ kind: 'ready', action: 'overwrite' });
    const report = await ok(c, 'checkpoints.restore', { sessionId: s.id, ids: [id], confirm: true });
    expect(report.allRestored).toBe(true);
    expect(readFileSync(s.file, 'utf8')).toBe(s.original);
  }, 120_000);

  it('E3 启动：保留副本带着一条停在 pending 的检查点、隐藏标记又丢了——引擎照常启动，自检把它重新隐藏，对账把记录按实际文件落成 applied，文件没有被改动；它仍不出现在清单里，恢复会话之后可以恢复', async () => {
    const m = await boot();
    const s = await editedSession(m.c, m.dataDir, 'boot');
    await pushTombstone(m.c, s.id, 1, 'OP-A', []);
    await m.close();
    const db = new Database(join(m.dataDir, 'minis.db'), { fileMustExist: true });
    try {
      expect(db.prepare("UPDATE file_checkpoints SET state='pending', applied_at=NULL, file_dev=NULL, file_ino=NULL WHERE session_id=?").run(s.id).changes).toBe(1);
      expect(db.prepare('UPDATE sessions SET remote_tombstoned_at=NULL WHERE id=?').run(s.id).changes).toBe(1);
    } finally { db.close(); }

    const again = await boot({ dataDir: m.dataDir });
    // 只读库：这些都是引擎启动时做完的
    expect(sessionRow(m.dataDir, s.id)?.t).not.toBeNull();
    const rows = cpRows(m.dataDir, s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'applied', detail: 'reconciled', after_hash: sha(s.edited) });
    expect(readFileSync(s.file, 'utf8')).toBe(s.edited);
    expect((await ok(again.c, 'chat.sessions.list', undefined)).map((x: { id: string }) => x.id)).not.toContain(s.id);
    expect((await ok(again.c, 'checkpoints.list', { sessionId: s.id })).groups).toEqual([]);

    await ok(again.c, 'chat.sessions.restore', { sessionId: s.id, confirm: true });
    const report = await ok(again.c, 'checkpoints.restore', { sessionId: s.id, ids: [rows[0].id], confirm: true });
    expect(report.allRestored).toBe(true);
    expect(readFileSync(s.file, 'utf8')).toBe(s.original);
  }, 120_000);
});
