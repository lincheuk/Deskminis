/**
 * F08 M 组里要 import 新模块的两条（M3、M6）。在基线上收集不了，所以不进留红基线（那在 checkpoint-minisd.test.ts）。
 *  M3：七个 checkpoints.* 方法对远程连接全部拒绝。
 *  M6：检查点目录写满（经 StartMinisdOpts.checkpointIo 注入）走整条生产链路——模型收到失败且说明原因，文件不变，下一轮照常。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpointMethods } from '../src/minisd/checkpoints/rpc';
import { startMinisd } from '../src/minisd/index';
import type { RpcConnection } from '../src/minisd/rpc/server';
import { closeAllCpEnvs, cpEnv, recIo } from './checkpoint-fixture';
import { eventsOf, mockLlm, readDb, rpcClient, runsSnapshot, waitFor, type LlmStep } from './run-ledger-fixture';

const scripts: Record<string, LlmStep[]> = {
  S1: [
    { tools: [{ name: 'file_write', input: { path: 'keep.txt', content: 'overwrite attempt', tool_title: '覆盖' } }] },
    { text: '第一轮完成' },
    { tools: [{ name: 'file_write', input: { path: 'keep.txt', content: 'second attempt works', tool_title: '再覆盖' } }] },
    { text: '第二轮完成' },
  ],
};
let llm: Awaited<ReturnType<typeof mockLlm>>;
beforeAll(async () => { llm = await mockLlm(scripts); });
afterAll(async () => { await llm?.close(); });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
  closeAllCpEnvs();
});

describe('F08 生产链路（需要新模块的两条）', () => {
  it('M3 远程连接调七个 checkpoints.* 方法：全部抛错，文件与库零改动', async () => {
    const env = cpEnv('m3'); const sid = env.newSession();
    const f = join(env.userDir, 'a.txt');
    writeFileSync(f, 'original');
    const w = await env.runTool(sid, 'file_write', { path: f, content: 'agent' });
    const methods = createCheckpointMethods(env.service, env.store);
    expect(Object.keys(methods).sort()).toEqual([
      'checkpoints.diff', 'checkpoints.inspect', 'checkpoints.list', 'checkpoints.restore', 'checkpoints.saveCopy', 'checkpoints.setQuota', 'checkpoints.usage',
    ]);
    const conn = (authMode: string): RpcConnection => ({ notify: () => undefined, authMode } as unknown as RpcConnection);
    const params: Record<string, unknown> = {
      'checkpoints.list': { sessionId: sid },
      'checkpoints.inspect': { sessionId: sid, ids: [w.row.id] },
      'checkpoints.diff': { sessionId: sid, id: w.row.id },
      'checkpoints.restore': { sessionId: sid, ids: [w.row.id], confirm: true },
      'checkpoints.saveCopy': { sessionId: sid, id: w.row.id, which: 'before', confirm: true },
      'checkpoints.usage': {},
      'checkpoints.setQuota': { quotaBytes: 256 * 1024 * 1024 },
    };
    const rowsBefore = JSON.stringify(env.rows()); const treeBefore = env.tree(env.userDir);
    for (const mode of ['remote', 'pairing']) {
      for (const [name, p] of Object.entries(params)) {
        await expect((async () => methods[name](p, conn(mode)))(), `${name} 对 ${mode} 连接`).rejects.toThrow('只能在运行 DeskMinis 引擎的这台电脑上');
      }
    }
    expect(JSON.stringify(env.rows())).toBe(rowsBefore);
    expect(env.tree(env.userDir)).toEqual(treeBefore);
    expect(env.db.prepare("SELECT value FROM settings WHERE key='checkpoints.quotaBytes'").get()).toBeUndefined();
    // 对照：本机连接照常
    const list = await methods['checkpoints.list'](params['checkpoints.list'], conn('local')) as { groups: unknown[] };
    expect(list.groups).toHaveLength(1);
  });

  it('M6 检查点目录写满走整条链：模型收到的工具结果是失败且含「检查点」，文件不变，该调用在账本里是 failed；撤掉故障后下一轮照常写入', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-f08-m6-'));
    const userDir = mkdtempSync(join(tmpdir(), 'dm-f08-m6-user-'));
    cleanups.push(() => rmSync(userDir, { recursive: true, force: true }));
    const io = recIo();
    const cpDir = join(dataDir, 'checkpoints');
    io.fail('writeDurable', p => p.startsWith(cpDir), 'ENOSPC');
    process.env.DESKMINIS_TEST = '1';
    delete process.env.DESKMINIS_FAKE_PROVIDER;
    const srv = await startMinisd({ host: '127.0.0.1', port: 0, dataDir, checkpointIo: io });
    cleanups.push(() => srv.close());
    const c = rpcClient(srv.port, srv.authToken);
    await c.ready;
    cleanups.push(() => c.close());
    const prov = (await c.call('provider.instances.create', { name: 'f08-mock', kind: 'ollama', baseUrl: llm.baseUrl, modelId: 'f08-mock' })).result;
    await c.call('provider.setDefault', { id: prov.id });
    const s = (await c.call('chat.sessions.create', {})).result;
    expect((await c.call('workspace.set', { sessionId: s.id, root: userDir })).error).toBeUndefined();
    const f = join(userDir, 'keep.txt');
    writeFileSync(f, 'precious original');

    const turnEnds = (): number => eventsOf(c, s.id).filter(e => e.kind === 'turnEnd').length;
    expect((await c.call('chat.prompt', { sessionId: s.id, text: '[[S1]] 请执行' })).error).toBeUndefined();
    await waitFor('第一轮结束', () => turnEnds() >= 1, 60_000);
    expect(readFileSync(f, 'utf8')).toBe('precious original');
    const ends = eventsOf(c, s.id).filter(e => e.kind === 'toolEnd');
    expect(ends).toHaveLength(1);
    expect(ends[0].success).toBe(false);
    expect(String(ends[0].output)).toContain('检查点');
    // 模型在下一步请求里收到的就是这条失败
    const second = llm.hitsOf('S1')[1];
    expect(JSON.stringify(second.messages)).toContain('检查点');
    const snap = await runsSnapshot(c, { sessionId: s.id });
    expect(snap.executions.filter((x: any) => x.sessionId === s.id).map((x: any) => x.state)).toEqual(['failed']);
    expect(readDb(dataDir, 'SELECT COUNT(*) AS n FROM file_checkpoints')[0].n).toBe(0);

    // 撤掉故障：下一轮照常
    io.reset();
    expect((await c.call('chat.prompt', { sessionId: s.id, text: '再来一次' })).error).toBeUndefined();
    await waitFor('第二轮结束', () => turnEnds() >= 2, 60_000);
    expect(readFileSync(f, 'utf8')).toBe('second attempt works');
    expect(readDb(dataDir, 'SELECT state FROM file_checkpoints').map((r: any) => r.state)).toEqual(['applied']);
  }, 120_000);
});
