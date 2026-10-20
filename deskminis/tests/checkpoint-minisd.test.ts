/**
 * F08 M 组（纯 RPC 的那几条：M1、M2、M4、M5、M7–M11）：生产链路上的写前检查点、变化清单与恢复。
 *
 * 走真实 minisd（进程内起、RPC 驱动、假模型端点）。本文件不引任何 F08 的新模块，也不引 checkpoint-fixture：
 * 只经 RPC、直接读库、读文件系统断言，所以在 F08 之前的基线上每条用例都能被收集、红在行为上（留红证据）。
 * 要 import 新模块的 M3、M6 在 checkpoint-minisd-wired.test.ts。
 *
 * 工作区都是临时建的普通目录（数据根之外、没有 .git），写入免审；绝不碰用户的真实文件与本仓库的工作区。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd, type StartMinisdOpts } from '../src/minisd/index';
import { autoAllow, cardsOf, eventsOf, mockLlm, readDb, rpcClient, waitFor, type Client, type LlmStep } from './run-ledger-fixture';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const MIB = 1024 * 1024;
const HAS_PS = process.platform === 'win32';

const ORIGINAL_EDIT = '第一行\r\n第二行 alpha\r\n第三行\r\n';
const DOCX_SPEC = JSON.stringify({ blocks: [{ kind: 'heading', level: 1, text: 'F08 标题' }, { kind: 'para', text: 'F08 正文' }] });

/** 剧本：标签选剧本，第几步 = 请求里 assistant 消息的条数。 */
const scripts: Record<string, LlmStep[]> = {
  // M1：一次运行里新建、修改、生成 Office 文档
  S1: [{
    tools: [
      { name: 'file_write', input: { path: 'new.txt', content: '新建的内容\n', tool_title: '新建' } },
      { name: 'file_edit', input: { path: 'edit.txt', old_string: 'alpha', new_string: 'beta', tool_title: '修改' } },
      { name: 'office_write', input: { path: 'doc.docx', content: DOCX_SPEC, tool_title: '生成文档' } },
    ],
  }, { text: 'S1 完成' }],
  // M2：一次写入加一条 shell
  S2: [{
    tools: [
      { name: 'file_write', input: { path: 'by-tool.txt', content: 'tool\n', tool_title: '写文件' } },
      { name: 'shell_execute', input: { command: "Set-Content -LiteralPath 'by-shell.txt' -Value 'shell'", tool_title: '用 shell 建文件' } },
    ],
  }, { text: 'S2 完成' }],
  // M4：两个会话各写一个文件
  S3: [{ tools: [{ name: 'file_write', input: { path: 'm4.txt', content: 'm4 new\n', tool_title: '写 m4' } }] }, { text: 'S3 完成' }],
  S4: [{ tools: [{ name: 'file_write', input: { path: 'other.txt', content: 'other new\n', tool_title: '写 other' } }] }, { text: 'S4 完成' }],
  // M5：第一次运行写完结束；第二次运行的模型请求挂着（会话保持运行中）
  S5: [{ tools: [{ name: 'file_write', input: { path: 'm5.txt', content: 'm5 new\n', tool_title: '写 m5' } }] }, { text: 'S5 完成' }, { hang: true }],
  // M7（S7）：「完全访问」档下写检查点目录，路径在用例里按数据根现填
  // M8：会话 A 三步各覆盖一个大文件（一步一批，seq 顺序确定）；会话 B 覆盖一个后挂起
  S8: [
    { tools: [{ name: 'file_write', input: { path: 'a1.bin', content: 'a1 new', tool_title: '覆盖 a1' } }] },
    { tools: [{ name: 'file_write', input: { path: 'b.bin', content: 'b new', tool_title: '覆盖 b' } }] },
    { tools: [{ name: 'file_write', input: { path: 'a2.bin', content: 'a2 new', tool_title: '覆盖 a2' } }] },
    { text: 'S8 完成' },
  ],
  S9: [{ tools: [{ name: 'file_write', input: { path: 'w.bin', content: 'w new', tool_title: '覆盖 w' } }] }, { hang: true }],
  // M9：同一批里对同一文件两次 file_edit、对三个文件各一次写入
  S10: [{
    tools: [
      { name: 'file_edit', input: { path: 'f.txt', old_string: 'one', new_string: 'two', tool_title: '第一次改 f' } },
      { name: 'file_edit', input: { path: 'f.txt', old_string: 'two', new_string: 'three', tool_title: '第二次改 f' } },
      { name: 'file_write', input: { path: 'x.txt', content: 'x new\n', tool_title: '写 x' } },
      { name: 'file_write', input: { path: 'y.txt', content: 'y new\n', tool_title: '写 y' } },
      { name: 'file_write', input: { path: 'z.txt', content: 'z new\n', tool_title: '写 z' } },
    ],
  }, { text: 'S10 完成' }],
  // M10：一次写入后有序关停、重启
  S11: [{ tools: [{ name: 'file_edit', input: { path: 'keep.txt', old_string: 'before', new_string: 'after', tool_title: '改 keep' } }] }, { text: 'S11 完成' }],
};

let llm: Awaited<ReturnType<typeof mockLlm>>;
beforeAll(async () => { llm = await mockLlm(scripts); });
afterAll(async () => { await llm?.close(); });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

/** 起一个进程内 minisd，默认模型指向假端点。dataDir 可指定（关停后在同一数据根上重开）。 */
async function boot(opts: StartMinisdOpts = {}) {
  const fresh = opts.dataDir === undefined;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'dm-f08-m-'));
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

/** 新建一个「用户目录」（数据根之外、没有 .git）并把会话的工作区绑过去。用例结束即删。 */
async function sessionIn(c: Client, label: string): Promise<{ id: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), `dm-f08-user-${label}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = (await c.call('chat.sessions.create', {})).result;
  expect((await c.call('workspace.set', { sessionId: s.id, root: dir })).error).toBeUndefined();
  return { id: s.id, dir };
}
const turnEnds = (c: Client, sessionId: string): number => eventsOf(c, sessionId).filter(e => e.kind === 'turnEnd').length;
async function run(c: Client, sessionId: string, tag: string, nth = 1): Promise<void> {
  const r = await c.call('chat.prompt', { sessionId, text: `[[${tag}]] 请执行` });
  expect(r.error).toBeUndefined();
  await waitFor(`${tag} 的第 ${nth} 次运行结束`, () => turnEnds(c, sessionId) >= nth, 60_000);
}
const cpRows = (dataDir: string, sessionId?: string): any[] => sessionId === undefined
  ? readDb(dataDir, 'SELECT * FROM file_checkpoints ORDER BY seq')
  : readDb(dataDir, 'SELECT * FROM file_checkpoints WHERE session_id=? ORDER BY seq', sessionId);
const execRows = (dataDir: string, sessionId: string): any[] =>
  readDb(dataDir, 'SELECT * FROM tool_executions WHERE session_id=? ORDER BY batch, call_index', sessionId);
const blobPath = (dataDir: string, hash: string): string => join(dataDir, 'checkpoints', 'blobs', hash.slice(0, 2), hash);
const changedFor = (c: Client, sessionId: string): number =>
  c.notifications.filter(n => n.method === 'checkpoints.changed' && n.params?.sessionId === sessionId).length;
/** 调一个 checkpoints.* 方法，要求成功。 */
async function ok(c: Client, method: string, params: unknown): Promise<any> {
  const r = await c.call(method, params);
  expect(r.error, `${method} 应当成功`).toBeUndefined();
  return r.result;
}

describe('F08 生产链路：写前检查点、变化清单与恢复', () => {
  it('M1 一次运行里新建、修改、生成 Office 文档（无 Git 的普通目录）：清单一组三条、关联到执行账本、对比是真实内容、恢复回原始字节、审计不带内容', async () => {
    const { c, dataDir } = await boot();
    const s = await sessionIn(c, 'm1');
    writeFileSync(join(s.dir, 'edit.txt'), ORIGINAL_EDIT, 'utf8');
    expect(existsSync(join(s.dir, '.git'))).toBe(false);
    await run(c, s.id, 'S1');

    // 工具照常成功、文件已是新内容
    expect(readFileSync(join(s.dir, 'new.txt'), 'utf8')).toBe('新建的内容\n');
    expect(readFileSync(join(s.dir, 'edit.txt'), 'utf8')).toBe(ORIGINAL_EDIT.replace('alpha', 'beta'));
    expect(statSync(join(s.dir, 'doc.docx')).size).toBeGreaterThan(0);

    expect(changedFor(c, s.id)).toBeGreaterThan(0);
    const list = await ok(c, 'checkpoints.list', { sessionId: s.id });
    expect(list.groups).toHaveLength(1);
    const changes: any[] = list.groups[0].changes;
    expect(changes).toHaveLength(3);
    expect(changes.map(x => x.displayPath).sort()).toEqual(['doc.docx', 'edit.txt', 'new.txt']);
    expect(changes.every(x => x.state === 'applied')).toBe(true);
    const byName = (n: string): any => changes.find(x => x.displayPath === n);
    expect(byName('new.txt').kind).toBe('create');
    expect(byName('edit.txt').kind).toBe('modify');
    expect(byName('doc.docx').kind).toBe('create');
    expect(list.groups[0].uncovered).toEqual({ shell: 0, mcp: 0, other: 0 });

    // 每行的 execution_id 能连到 tool_executions，run 相同，哈希是真实字节的 sha256
    const rows = cpRows(dataDir, s.id);
    const execs = execRows(dataDir, s.id);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      const e = execs.find(x => x.id === r.execution_id);
      expect(e, `检查点 ${r.path} 应连到一条执行记录`).toBeDefined();
      expect(e.tool_use_id).toBe(r.tool_use_id);
      expect(e.run_id).toBe(r.run_id);
      expect(e.tool_name).toBe(r.tool_name);
    }
    const editRow = rows.find(r => r.tool_name === 'file_edit');
    expect(editRow.before_hash).toBe(sha(Buffer.from(ORIGINAL_EDIT, 'utf8')));
    expect(editRow.after_hash).toBe(sha(readFileSync(join(s.dir, 'edit.txt'))));
    expect(readFileSync(blobPath(dataDir, editRow.before_hash)).equals(Buffer.from(ORIGINAL_EDIT, 'utf8'))).toBe(true);

    // 对比：两侧是真实文本
    const diff = await ok(c, 'checkpoints.diff', { sessionId: s.id, id: byName('edit.txt').id });
    expect(diff.before).toMatchObject({ exists: true, form: 'text', text: ORIGINAL_EDIT });
    expect(diff.after).toMatchObject({ exists: true, form: 'text', text: ORIGINAL_EDIT.replace('alpha', 'beta') });
    expect(diff.currentIs).toBe('after');
    const diffNew = await ok(c, 'checkpoints.diff', { sessionId: s.id, id: byName('new.txt').id });
    expect(diffNew.before).toMatchObject({ exists: false });
    expect(diffNew.after).toMatchObject({ exists: true, text: '新建的内容\n' });

    // 带 confirm 的恢复：修改的回到原始字节，新建的被删除
    const report = await ok(c, 'checkpoints.restore', { sessionId: s.id, ids: changes.map(x => x.id), confirm: true });
    expect(report.allRestored).toBe(true);
    expect(report.items).toHaveLength(3);
    expect(readFileSync(join(s.dir, 'edit.txt')).equals(Buffer.from(ORIGINAL_EDIT, 'utf8'))).toBe(true);
    expect(existsSync(join(s.dir, 'new.txt'))).toBe(false);
    expect(existsSync(join(s.dir, 'doc.docx'))).toBe(false);
    expect(readdirSync(s.dir).filter(n => n.startsWith('.dm-'))).toEqual([]);

    // 审计里有 checkpoint.restore，且不含文件内容
    const audits = readDb(dataDir, "SELECT payload_json FROM audit_logs WHERE event_type='checkpoint.restore'");
    expect(audits).toHaveLength(1);
    expect(audits[0].payload_json).not.toContain('第二行');
    expect(audits[0].payload_json).not.toContain('新建的内容');
  }, 90_000);

  it.runIf(HAS_PS)('M2 同一运行里的 shell 建的文件没有检查点；这次运行的未覆盖调用数里 shell 是 1', async () => {
    const { c, dataDir } = await boot();
    const s = await sessionIn(c, 'm2');
    autoAllow(c, new Set([s.id]));
    await run(c, s.id, 'S2');
    await waitFor('shell 建的文件出现', () => existsSync(join(s.dir, 'by-shell.txt')), 30_000);

    const rows = cpRows(dataDir, s.id);
    expect(rows.map(r => r.tool_name)).toEqual(['file_write']);
    expect(rows.some(r => String(r.path).toLowerCase().endsWith('by-shell.txt'))).toBe(false);
    const list = await ok(c, 'checkpoints.list', { sessionId: s.id });
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0].changes).toHaveLength(1);
    expect(list.groups[0].uncovered.shell).toBe(1);
  }, 90_000);

  it('M4 restore / saveCopy 不带 confirm、带别的会话的检查点 id：报错，文件与库零改动', async () => {
    const { c, dataDir } = await boot();
    const a = await sessionIn(c, 'm4a');
    const b = await sessionIn(c, 'm4b');
    writeFileSync(join(a.dir, 'm4.txt'), 'm4 old\n', 'utf8');
    writeFileSync(join(b.dir, 'other.txt'), 'other old\n', 'utf8');
    await run(c, a.id, 'S3');
    await run(c, b.id, 'S4');
    const mine = (await ok(c, 'checkpoints.list', { sessionId: a.id })).groups[0].changes[0];
    const theirs = (await ok(c, 'checkpoints.list', { sessionId: b.id })).groups[0].changes[0];
    const before = JSON.stringify(cpRows(dataDir));
    const filesBefore = readdirSync(a.dir).sort().join(',');

    const noConfirm = await c.call('checkpoints.restore', { sessionId: a.id, ids: [mine.id] });
    expect(noConfirm.error).toBeDefined();
    const noConfirmCopy = await c.call('checkpoints.saveCopy', { sessionId: a.id, id: mine.id, which: 'before' });
    expect(noConfirmCopy.error).toBeDefined();
    const foreign = await c.call('checkpoints.restore', { sessionId: a.id, ids: [mine.id, theirs.id], confirm: true });
    expect(foreign.error).toBeDefined();
    expect(String(foreign.error.message)).toContain('检查点不存在');
    const foreignCopy = await c.call('checkpoints.saveCopy', { sessionId: a.id, id: theirs.id, which: 'before', confirm: true });
    expect(foreignCopy.error).toBeDefined();

    expect(readFileSync(join(a.dir, 'm4.txt'), 'utf8')).toBe('m4 new\n');
    expect(readFileSync(join(b.dir, 'other.txt'), 'utf8')).toBe('other new\n');
    expect(readdirSync(a.dir).sort().join(',')).toBe(filesBefore);
    expect(JSON.stringify(cpRows(dataDir))).toBe(before);
  }, 90_000);

  it('M5 会话运行中（模型端点挂起）调 restore：逐项 run-active，文件不变', async () => {
    const { c, dataDir } = await boot();
    const s = await sessionIn(c, 'm5');
    writeFileSync(join(s.dir, 'm5.txt'), 'm5 old\n', 'utf8');
    await run(c, s.id, 'S5');
    const id = (await ok(c, 'checkpoints.list', { sessionId: s.id })).groups[0].changes[0].id;

    const hitsBefore = llm.hitsOf('S5').length;
    expect((await c.call('chat.prompt', { sessionId: s.id, text: '继续' })).error).toBeUndefined();
    await waitFor('第二次运行的请求到达假端点并挂起', () => llm.hitsOf('S5').length > hitsBefore);

    const report = await ok(c, 'checkpoints.restore', { sessionId: s.id, ids: [id], confirm: true });
    expect(report.allRestored).toBe(false);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ outcome: 'unavailable', verdict: { kind: 'unavailable', reason: 'run-active' } });
    expect(readFileSync(join(s.dir, 'm5.txt'), 'utf8')).toBe('m5 new\n');
    expect(cpRows(dataDir, s.id)[0].state).toBe('applied');
    await c.call('chat.cancel', { sessionId: s.id });
  }, 90_000);

  it('M7 「完全访问」档下 file_write 写 <数据根>/checkpoints/ 下的文件：硬拒，不弹卡，文件没有出现', async () => {
    const { c, dataDir } = await boot();
    const s = await sessionIn(c, 'm7');
    expect((await c.call('permission.setPreset', { preset: 'full' })).error).toBeUndefined();
    const target = join(dataDir, 'checkpoints', 'blobs', 'ab', 'planted.txt');
    // M7 的剧本按数据根现填（绝对路径）；假端点拿着 scripts 的引用，每个请求现查
    scripts.S7 = [{ tools: [{ name: 'file_write', input: { path: target, content: 'planted', tool_title: '写检查点目录' } }] }, { text: 'S7 完成' }];
    await run(c, s.id, 'S7');
    expect(existsSync(target)).toBe(false);
    expect(cardsOf(c, s.id)).toHaveLength(0);
    const results = eventsOf(c, s.id).filter(e => e.kind === 'toolEnd');
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(String(results[0].output)).toContain('核心数据');
  }, 90_000);

  it('M8 容量清理（真实数据量）：按 seq 逐条清、够了就停；不删仍被引用的内容；不清活动 run 的记录；越界设置报错；设置重启后仍在', async () => {
    const m = await boot();
    const { c, dataDir } = m;
    const a = await sessionIn(c, 'm8a');
    const b = await sessionIn(c, 'm8b');
    const X = Buffer.alloc(48 * MIB, 0x11); const Y = Buffer.alloc(48 * MIB, 0x22); const W = Buffer.alloc(48 * MIB, 0x33);
    const hX = sha(X); const hY = sha(Y); const hW = sha(W);
    writeFileSync(join(a.dir, 'a1.bin'), X); writeFileSync(join(a.dir, 'a2.bin'), X); writeFileSync(join(a.dir, 'b.bin'), Y);
    writeFileSync(join(b.dir, 'w.bin'), W);

    const t0 = Date.now();
    await run(c, a.id, 'S8');
    const tA = Date.now() - t0;
    const t1 = Date.now();
    expect((await c.call('chat.prompt', { sessionId: b.id, text: '[[S9]] 请执行' })).error).toBeUndefined();
    await waitFor('会话 B 的写入完成、模型端点挂起', () => llm.hitsOf('S9').length >= 2, 60_000);
    const tB = Date.now() - t1;

    // 此时：四条 applied，三份内容（X 去重），占用 144 MiB
    const rowsA = cpRows(dataDir, a.id);
    expect(rowsA.map(r => r.state)).toEqual(['applied', 'applied', 'applied']);
    expect(cpRows(dataDir, b.id).map(r => r.state)).toEqual(['applied']);
    const usage0 = await ok(c, 'checkpoints.usage', undefined);
    expect(usage0.usedBytes).toBe(144 * MIB);
    expect(existsSync(blobPath(dataDir, hX)) && existsSync(blobPath(dataDir, hY)) && existsSync(blobPath(dataDir, hW))).toBe(true);

    const t2 = Date.now();
    const usage1 = await ok(c, 'checkpoints.setQuota', { quotaBytes: 128 * MIB });
    const tQuota = Date.now() - t2;
    console.log(`F08-M8 耗时：会话 A 三次 48 MiB 覆盖（含三次模型往返）${tA} ms；会话 B 一次 48 MiB 覆盖 ${tB} ms；setQuota 清理 ${tQuota} ms`);

    // 按 seq 从旧到新逐条清、够了就停：a1（内容还被 a2 引用，占用不降）→ b（放掉 48 MiB，降到 96 MiB）→ 停
    const after = cpRows(dataDir, a.id);
    const [a1, bRow, a2] = after;
    expect(a1.pruned_at).not.toBeNull();
    expect(bRow.pruned_at).not.toBeNull();
    expect(a2.pruned_at).toBeNull();
    expect(after).toHaveLength(3);                         // 行都还在
    expect(existsSync(blobPath(dataDir, hY))).toBe(false); // Y 的内容没了
    expect(existsSync(blobPath(dataDir, hX))).toBe(true);  // X 还被 a2 引用：不删
    // 不清活动 run 的
    expect(cpRows(dataDir, b.id)[0].pruned_at).toBeNull();
    expect(existsSync(blobPath(dataDir, hW))).toBe(true);
    expect(usage1.usedBytes).toBe(96 * MIB);
    expect(usage1.quotaBytes).toBe(128 * MIB);

    // a2 仍可恢复出原始字节（清掉 a1 那条没有把被 a2 引用的内容删掉）
    const report = await ok(c, 'checkpoints.restore', { sessionId: a.id, ids: [a2.id], confirm: true });
    expect(report.items[0].outcome).toBe('restored');
    expect(sha(readFileSync(join(a.dir, 'a2.bin')))).toBe(hX);
    // 被清理的不能恢复，文件不动
    const pruned = await ok(c, 'checkpoints.restore', { sessionId: a.id, ids: [a1.id], confirm: true });
    expect(pruned.items[0]).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'pruned' } });
    expect(readFileSync(join(a.dir, 'a1.bin'), 'utf8')).toBe('a1 new');

    // 越界：报错，设置不变
    const bad = await c.call('checkpoints.setQuota', { quotaBytes: 1 });
    expect(bad.error).toBeDefined();
    expect((await ok(c, 'checkpoints.usage', undefined)).quotaBytes).toBe(128 * MIB);

    // 设置重启后仍在
    await c.call('chat.cancel', { sessionId: b.id });
    await m.close();
    const again = await boot({ dataDir });
    expect((await ok(again.c, 'checkpoints.usage', undefined)).quotaBytes).toBe(128 * MIB);
    await again.close();
    rmSync(join(dataDir, 'checkpoints'), { recursive: true, force: true });   // 约 100 MiB 的内容文件，跑完即删
  }, 240_000);

  it('M9 同一批里对同一文件两次 file_edit、对三个文件各一次写入：行与执行记录逐个对应、同一 run；链式恢复得到最初的字节', async () => {
    const { c, dataDir } = await boot();
    const s = await sessionIn(c, 'm9');
    const orig: Record<string, string> = { 'f.txt': 'value one\n', 'x.txt': 'x old\n', 'y.txt': 'y old\n', 'z.txt': 'z old\n' };
    for (const [n, t] of Object.entries(orig)) writeFileSync(join(s.dir, n), t, 'utf8');
    await run(c, s.id, 'S10');
    expect(readFileSync(join(s.dir, 'f.txt'), 'utf8')).toBe('value three\n');

    const rows = cpRows(dataDir, s.id);
    const execs = execRows(dataDir, s.id);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map(r => r.run_id)).size).toBe(1);
    expect(new Set(rows.map(r => r.execution_id)).size).toBe(5);
    for (const r of rows) {
      const e = execs.find(x => x.id === r.execution_id);
      expect(e).toBeDefined();
      expect(e.tool_use_id).toBe(r.tool_use_id);
      expect(r.state).toBe('applied');
    }
    // 同一文件的两条：第一次的 after 就是第二次的 before，seq 与调用顺序一致
    const onF = rows.filter(r => String(r.path).toLowerCase().endsWith('f.txt'));
    expect(onF).toHaveLength(2);
    expect(onF[0].before_hash).toBe(sha('value one\n'));
    expect(onF[0].after_hash).toBe(sha('value two\n'));
    expect(onF[1].before_hash).toBe(sha('value two\n'));
    expect(onF[1].after_hash).toBe(sha('value three\n'));
    const idx = (r: any): number => execs.find(x => x.id === r.execution_id).call_index;
    expect([idx(onF[0]), idx(onF[1])]).toEqual([0, 1]);

    // 只恢复第一次：被后来的改动挡住，文件不动
    const first = await ok(c, 'checkpoints.restore', { sessionId: s.id, ids: [onF[0].id], confirm: true });
    expect(first.items[0]).toMatchObject({ outcome: 'conflict', verdict: { kind: 'conflict', reason: 'superseded' } });
    expect(readFileSync(join(s.dir, 'f.txt'), 'utf8')).toBe('value three\n');

    // 一次传全部：链式恢复到最初的字节
    const all = await ok(c, 'checkpoints.restore', { sessionId: s.id, ids: rows.map(r => r.id), confirm: true });
    expect(all.allRestored).toBe(true);
    for (const [n, t] of Object.entries(orig)) expect(readFileSync(join(s.dir, n), 'utf8')).toBe(t);
  }, 90_000);

  it('M10 关停后重启：记录仍在、仍可恢复；启动时没有对账动作', async () => {
    const m = await boot();
    const s = await sessionIn(m.c, 'm10');
    writeFileSync(join(s.dir, 'keep.txt'), 'state before\n', 'utf8');
    await run(m.c, s.id, 'S11');
    expect(readFileSync(join(s.dir, 'keep.txt'), 'utf8')).toBe('state after\n');
    await m.close();

    const warn = vi.spyOn(console, 'warn');
    cleanups.push(() => warn.mockRestore());
    const again = await boot({ dataDir: m.dataDir });
    expect(warn.mock.calls.filter(a => String(a[0]).includes('检查点对账'))).toEqual([]);
    const list = await ok(again.c, 'checkpoints.list', { sessionId: s.id });
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0].changes).toHaveLength(1);
    expect(list.groups[0].changes[0]).toMatchObject({ state: 'applied', kind: 'modify', beforeStored: true });
    const report = await ok(again.c, 'checkpoints.restore', { sessionId: s.id, ids: [list.groups[0].changes[0].id], confirm: true });
    expect(report.allRestored).toBe(true);
    expect(readFileSync(join(s.dir, 'keep.txt'), 'utf8')).toBe('state before\n');
  }, 90_000);

  it('M11 启动对账的接线：关停后把记录退回 pending（等同崩溃在替换之后、记 applied 之前）再重启——不经任何 RPC，这一行已按实际文件落成 applied，文件没有被对账改动；随后照常可恢复', async () => {
    const m = await boot();
    const s = await sessionIn(m.c, 'm11');
    writeFileSync(join(s.dir, 'keep.txt'), 'state before\n', 'utf8');
    await run(m.c, s.id, 'S11');
    await m.close();
    const db = new Database(join(m.dataDir, 'minis.db'), { fileMustExist: true });
    try {
      expect(db.prepare("UPDATE file_checkpoints SET state='pending', applied_at=NULL, file_dev=NULL, file_ino=NULL WHERE session_id=?").run(s.id).changes).toBe(1);
    } finally { db.close(); }

    const warn = vi.spyOn(console, 'warn');
    cleanups.push(() => warn.mockRestore());
    const again = await boot({ dataDir: m.dataDir });
    // 只读库、不调 checkpoints.list（它自己进门也会对账）：这一行是引擎启动时落定的
    const rows = cpRows(m.dataDir, s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'applied', detail: 'reconciled', after_hash: sha('state after\n') });
    expect(rows[0].applied_at).not.toBeNull();
    expect(warn.mock.calls.some(a => String(a[0]).includes('检查点对账：1 条'))).toBe(true);
    expect(readFileSync(join(s.dir, 'keep.txt'), 'utf8')).toBe('state after\n');
    const report = await ok(again.c, 'checkpoints.restore', { sessionId: s.id, ids: [rows[0].id], confirm: true });
    expect(report.allRestored).toBe(true);
    expect(readFileSync(join(s.dir, 'keep.txt'), 'utf8')).toBe('state before\n');
  }, 90_000);
});
