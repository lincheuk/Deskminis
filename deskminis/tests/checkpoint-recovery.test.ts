/**
 * F08 V 组：崩溃后「结果未知」的文件类调用，按检查点把事实补进结果消息（F05 的运行恢复经注入的 effectEvidence 读）。
 *
 * 做法：写入在指定注入点「崩溃」（同步取库快照，此后文件操作全部抛，磁盘停在那一刻）；在快照上开下一代：
 * 先对账检查点、再做运行恢复——与 index.ts 启动时的顺序相同。用的是真实的 CheckpointStore.effectEvidence，不是桩。
 * 账本终态仍是 unknown；恢复不执行任何工具。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORPHAN_TEXT, recoverOnBoot, settleOpenBatches, type RecoveryDeps } from '../src/minisd/agent/run-recovery';
import type { IoPoint } from '../src/minisd/checkpoints/fs';
import { ChatStore } from '../src/minisd/store/chat-store';
import { closeAllCpEnvs, cpEnv, nextGeneration, type CpEnv } from './checkpoint-fixture';
import { resultsOf } from './run-recovery-fixture';

const gens: { close(): void }[] = [];
afterEach(() => { for (const g of gens.splice(0)) g.close(); closeAllCpEnvs(); });

const UNKNOWN = ORPHAN_TEXT['effect-unknown'];
const ORIGINAL = 'original\n'; const NEXT = 'agent content\n';

/** 一次 file_write 在 point 处崩溃：快照里执行行停在 running、检查点停在 pending。 */
async function crashed(label: string, point: IoPoint, tool: 'file_write' | 'file_edit' = 'file_write') {
  const env = cpEnv(label); const sid = env.newSession();
  const f = join(env.userDir, 'target.txt');
  writeFileSync(f, ORIGINAL);
  env.io.crash(point, () => env.snapshotDb());
  await env.runTool(sid, tool, tool === 'file_write' ? { path: f, content: NEXT } : { path: f, old_string: 'original', new_string: 'agent content' });
  return { env, sid, f };
}
/** 下一代：先对账、再做运行恢复。mutate 在两步之前改快照库（造旧代次、去掉记录等）。 */
function reboot(env: CpEnv, o: { mutate?(db: import('better-sqlite3').Database, epoch: number): void; evidence?: RecoveryDeps['effectEvidence']; reconcile?: boolean } = {}) {
  const snap = env.io.crashedSnapshot();
  if (snap === undefined) throw new Error('没有取到崩溃快照');
  const g = nextGeneration(env, snap);
  gens.push(g);
  o.mutate?.(g.db, g.ledger.epoch);
  if (o.reconcile !== false) g.store.reconcile();
  const chat = new ChatStore(g.db);
  const report = recoverOnBoot({ ledger: g.ledger, chat, warn: () => undefined, effectEvidence: o.evidence ?? (row => g.store.effectEvidence(row)) });
  return { ...g, chat, report, execs: (): any[] => g.db.prepare('SELECT * FROM tool_executions ORDER BY call_index').all() };
}

describe('F08 V 组：崩溃恢复里的文件事实', () => {
  it('替换之后崩溃（文件已是新内容）：结果消息说「这次写入已完成」，账本终态仍是 unknown，文件没有被恢复过程改动', async () => {
    const { env, sid, f } = await crashed('v-after', 'after-replace');
    const g = reboot(env);
    const out = resultsOf(g.chat, sid);
    expect(out).toHaveLength(1);
    expect(out[0].output.startsWith(UNKNOWN)).toBe(true);
    expect(out[0].output).toContain('按文件检查点核实：');
    expect(out[0].output).toContain('这次写入已完成');
    expect(out[0].output).toContain('target.txt');
    expect(out[0]).toMatchObject({ success: false, status: 'unknown' });
    expect(g.execs()[0]).toMatchObject({ state: 'unknown', end_kind: 'effect-unknown' });
    expect(readFileSync(f, 'utf8')).toBe(NEXT);
    expect(g.report.failed).toEqual([]);
  });

  it('替换之前崩溃（文件仍是旧内容）：结果消息说「这次写入没有发生」', async () => {
    const { env, sid, f } = await crashed('v-before', 'after-tmp');
    const g = reboot(env);
    const out = resultsOf(g.chat, sid);
    expect(out[0].output).toContain('这次写入没有发生');
    expect(out[0].output).not.toContain('这次写入已完成');
    expect(g.execs()[0].state).toBe('unknown');
    expect(readFileSync(f, 'utf8')).toBe(ORIGINAL);
  });

  it('崩溃后重启前文件又被改成第三种内容：结果消息说「无法确认」并指向另存', async () => {
    const { env, sid, f } = await crashed('v-third', 'after-tmp');
    writeFileSync(f, 'third version\n');
    const g = reboot(env);
    const out = resultsOf(g.chat, sid);
    expect(out[0].output).toContain('无法确认');
    expect(out[0].output).toContain('另存');
    expect(readFileSync(f, 'utf8')).toBe('third version\n');
  });

  it('这次执行没有任何检查点行：说「没有留下写入记录」', async () => {
    const { env, sid } = await crashed('v-none', 'after-tmp');
    const g = reboot(env, { mutate: db => { db.prepare('DELETE FROM file_checkpoints').run(); } });
    expect(resultsOf(g.chat, sid)[0].output).toBe(`${UNKNOWN}\n按文件检查点核实：\n这次调用没有留下写入记录，目标文件没有被它改动。`);
  });

  it('工具是 shell_execute：文案与 F05 逐字相同', async () => {
    const { env, sid } = await crashed('v-shell', 'after-replace');
    const g = reboot(env, { mutate: db => { db.prepare("UPDATE tool_executions SET tool_name='shell_execute'").run(); } });
    expect(resultsOf(g.chat, sid)[0].output).toBe(UNKNOWN);
  });

  it('effectEvidence 抛错：恢复照常完成，文案退回原样', async () => {
    const { env, sid } = await crashed('v-throw', 'after-replace');
    const g = reboot(env, { evidence: () => { throw new Error('evidence lookup failed'); } });
    expect(resultsOf(g.chat, sid)[0].output).toBe(UNKNOWN);
    expect(g.execs()[0].state).toBe('unknown');
    expect(g.report.failed).toEqual([]);
  });

  it('旧代次的行（执行早于检查点启用代次、没有检查点行）：文案与 F05 逐字相同，不说「没有留下写入记录」', async () => {
    const { env, sid } = await crashed('v-old', 'after-tmp');
    const g = reboot(env, {
      mutate: (db, epoch) => {
        db.prepare('DELETE FROM file_checkpoints').run();
        db.prepare("UPDATE settings SET value=? WHERE key='checkpoints.sinceEpoch'").run(String(epoch));   // 检查点从这一代才启用
      },
    });
    const out = resultsOf(g.chat, sid)[0].output;
    expect(out).toBe(UNKNOWN);
    expect(out).not.toContain('没有留下写入记录');
  });

  it('settings 里没有 checkpoints.sinceEpoch：不追加任何句子', async () => {
    const { env, sid } = await crashed('v-nokey', 'after-tmp');
    const g = reboot(env, { mutate: db => { db.prepare("DELETE FROM settings WHERE key='checkpoints.sinceEpoch'").run(); } });
    expect(resultsOf(g.chat, sid)[0].output).toBe(UNKNOWN);
  });

  it('markSinceEpoch 只写一次：先后以代次 3、5 调两次，库里仍是 3', () => {
    const env = cpEnv('v-once');
    env.db.prepare("DELETE FROM settings WHERE key='checkpoints.sinceEpoch'").run();
    env.store.markSinceEpoch(3);
    env.store.markSinceEpoch(5);
    expect((env.db.prepare("SELECT value FROM settings WHERE key='checkpoints.sinceEpoch'").get() as { value: string }).value).toBe('3');
  });

  it('run 收尾路径上的 pending 行（同进程、不对账）：消息说「还没有核实」，不说文件两头都对不上', async () => {
    const env = cpEnv('v-pending'); const sid = env.newSession();
    const f = join(env.userDir, 'target.txt');
    writeFileSync(f, 'value original\n');
    let outputs: string[] = [];
    // 替换刚完成、applied 还没写进库的那一刻（执行行 running、检查点 pending、文件已是新内容）走一遍 run 收尾的收口
    env.io.hook('after-replace', () => {
      const run = env.db.prepare('SELECT id FROM agent_runs WHERE session_id=? AND active=1').get(sid) as { id: string };
      settleOpenBatches({ ledger: env.ledger, chat: env.chat, warn: () => undefined, effectEvidence: row => env.store.effectEvidence(row) }, { runId: run.id });
      outputs = resultsOf(env.chat, sid).map(r => r.output);
    });
    await env.runTool(sid, 'file_edit', { path: f, old_string: 'original', new_string: 'edited' });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toContain('还没有核实');
    expect(outputs[0]).not.toContain('既不是写入前的内容，也不是这次要写入的内容');
    expect(readFileSync(f, 'utf8')).toBe('value edited\n');
  });
});
