import { describe, expect, it, vi } from 'vitest';
import { ToolLoopGuard } from '../src/minisd/agent/tool-loop-guard';
import { ToolScheduler } from '../src/minisd/tools/scheduler';
import { answer, call, Capture, fixture, hints, testTool } from './w1w2-fixture';
import { ledgerEnv, startRun } from './run-recovery-fixture';

describe('W2 runAgentLoop failure fuse', () => {
  it('3/4 reminders only in the next request, 5 results persisted before error with no sixth request', async () => {
    const f = fixture();
    const p = new Capture(n => call('test_tool', { value: { b: [1, 2], a: '<&>' }, tool_title: 'title ' + n }, 'T' + n));
    const events = await f.run(p);
    expect(p.requests).toHaveLength(5);
    expect(p.requests.map(r => hints(r).length)).toEqual([0, 0, 0, 1, 1]);
    expect(hints(p.requests[3])[0]).toContain('test_tool 连续失败 3 次');
    expect(hints(p.requests[4])[0]).toContain('test_tool 连续失败 4 次');
    expect(hints(p.requests[3])[0]).toContain('不要原样再试');
    expect(f.outputs()).toEqual(Array(5).fill('failed < & >'));
    expect(events.at(-1)).toEqual({ kind: 'error', message: '同一个工具调用（test_tool）用相同参数连续失败 5 次，已停下这一轮' });
    expect(events.at(-2)?.kind).toBe('messagePersisted');
    expect(events.filter(e => e.kind === 'turnEnd')).toEqual([]);
    expect(JSON.stringify(f.history())).not.toContain('[系统提醒');
    expect(events.some(e => JSON.stringify(e).includes('[系统提醒'))).toBe(false);
  });

  it('recursive object key ordering ignores JSON whitespace and top-level title, arrays keep their order', async () => {
    const f = fixture();
    const p = new Capture(n => call('test_tool', n % 2
      ? { tool_title: String(n), nested: { b: 2, a: [{ z: 1, y: 2 }] }, list: [1, 2] }
      : { list: [1, 2], nested: { a: [{ y: 2, z: 1 }], b: 2 }, tool_title: String(n) }, String(n)));
    await f.run(p);
    expect(p.requests).toHaveLength(5);
    expect(hints(p.requests[3])).toHaveLength(1);
    const g = new ToolLoopGuard();
    const a = { name: 'test_tool', input: '{ "n":1,"a":[1,2],"tool_title":"a" }' };
    const b = { name: 'test_tool', input: '{"tool_title":"b","a":[1,2],"n":1}' };
    g.record(a, 'failed', true); g.record(b, 'failed', true); g.record(a, 'failed', true);
    expect(g.hints()[0]).toContain('3 次');
    g.beginBatch();
    g.record({ ...a, input: '{"n":1,"a":[2,1]}' }, 'failed', true);
    expect(g.hints()).toEqual([]);
  });

  it('changing any other argument, nested tool_title, or tool name uses a distinct key', async () => {
    const f = fixture();
    f.tools.register({ ...testTool(), definition: { ...testTool().definition, name: 'other_tool' } });
    const p = new Capture(n => n <= 10 ? call(n % 2 ? 'test_tool' : 'other_tool', { value: n, nested: { tool_title: String(n) } }, String(n)) : answer);
    expect((await f.run(p)).at(-1)?.kind).toBe('turnEnd');
    expect(p.requests.every(r => hints(r).length === 0)).toBe(true);
    const g = new ToolLoopGuard();
    for (let n = 0; n < 10; n++) g.record({ name: n < 5 ? 'test_tool' : 'other_tool', input: JSON.stringify({ nested: { tool_title: n % 5 } }) }, 'failed', true);
    expect(g.stop).toBeUndefined();
    expect(g.hints()).toEqual([]);
  });

  it('one success resets that key, and each run starts fresh', async () => {
    let executed = 0;
    const f = fixture(testTool(async () => ({ output: 'result', success: ++executed === 4 })));
    const p = new Capture(n => n <= 8 ? call('test_tool', { value: 'same' }, String(n)) : answer);
    expect((await f.run(p)).at(-1)?.kind).toBe('turnEnd');
    expect(p.requests.map(r => hints(r).map(h => /失败 (\d) 次/.exec(h)?.[1]))).toEqual([[], [], [], ['3'], [], [], [], ['3'], ['4']]);
    const next = new Capture(n => n <= 2 ? call() : answer);
    expect((await f.run(next)).at(-1)?.kind).toBe('turnEnd');
    expect(next.requests.every(r => hints(r).length === 0)).toBe(true);
  });

  it('tool name is part of the key and another tool succeeding cannot reset that key', async () => {
    const f = fixture();
    f.tools.register({ ...testTool(), definition: { ...testTool().definition, name: 'other_tool' } });
    const p = new Capture(n => n <= 3 ? call('test_tool', {}, String(n)) : n <= 6 ? call('other_tool', {}, String(n)) : answer);
    expect((await f.run(p)).at(-1)?.kind).toBe('turnEnd');
    expect(p.requests).toHaveLength(7);
    expect(hints(p.requests[6])[0]).toContain('other_tool 连续失败 3 次');
    const g = fixture();
    g.tools.register({ ...testTool(async () => ({ success: true, output: 'ok' })), definition: { ...testTool().definition, name: 'success_tool' } });
    const q = new Capture(n => call(n === 4 ? 'success_tool' : 'test_tool', {}, String(n)));
    expect((await g.run(q)).at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('test_tool') });
    expect(q.requests).toHaveLength(6);
  });

  it('cancelled-before-start does not count or reset even without a recorder', async () => {
    const f = fixture();
    const actual = f.scheduler.runBatch.bind(f.scheduler);
    let batch = 0;
    const spy = vi.spyOn(f.scheduler, 'runBatch').mockImplementation(async opts => {
      if (++batch === 2 || batch === 4) return opts.calls.map(c => ({ call: c, outcome: { output: 'cancelled', success: false }, end: 'cancelled-before-start' as const, started: false, waitedMs: 0 }));
      return actual(opts);
    });
    try {
      const p = new Capture(n => n <= 5 ? call('test_tool', { value: 'x' }, String(n)) : answer);
      expect((await f.run(p)).at(-1)?.kind).toBe('turnEnd');
      expect(p.requests).toHaveLength(6);
      expect(hints(p.requests[4])).toEqual([]);
      expect(hints(p.requests[5])[0]).toContain('3 次');
    } finally { spy.mockRestore(); }
  });

  it.each(['cancelled', 'unknown'] as const)('%s status neither counts nor resets a key', status => {
    const g = new ToolLoopGuard(); const c = { name: 'test_tool', input: '{"x":1}' };
    g.record(c, 'failed', true); g.record(c, 'failed', true);
    for (let i = 0; i < 7; i++) g.record(c, status, true);
    expect(g.stop).toBeUndefined(); expect(g.hints()).toEqual([]);
    g.record(c, 'failed', true); expect(g.hints()[0]).toContain('3 次');
  });

  it('unknown tools stop at 10 across calls with distinct arguments, including session-excluded tools', async () => {
    for (const excluded of [false, true]) {
      let executes = 0;
      const f = fixture(testTool(async () => { executes++; return { success: true, output: 'must not execute' }; }));
      const p = new Capture(n => call(excluded ? 'test_tool' : 'missing_' + n, { value: n }, String(n)));
      const events = await f.run(p, excluded ? { excludedToolNames: new Set(['test_tool']) } : {});
      expect(p.requests).toHaveLength(10); expect(f.outputs()).toHaveLength(10); expect(executes).toBe(0);
      expect(events.at(-1)).toEqual({ kind: 'error', message: '连续调用不存在的工具 10 次，已停下这一轮' });
      expect(events.at(-2)?.kind).toBe('messagePersisted');
    }
  });

  it('9 unknown calls then an existing failed tool resets the unknown streak', async () => {
    const f = fixture();
    const p = new Capture(n => n <= 9 ? call('missing_' + n, {}, String(n))
      : n === 10 ? call('test_tool', {}, String(n))
      : n <= 19 ? call('missing_' + n, {}, String(n)) : answer);
    expect((await f.run(p)).at(-1)?.kind).toBe('turnEnd');
    expect(p.requests).toHaveLength(20);
  });

  it('counts a mixed parallel batch by original call order and persists the whole batch on a stop', async () => {
    const f = fixture();
    const p = new Capture(n => n === 1 ? [
      ...Array.from({ length: 9 }, (_, i) => call('missing_' + i, {}, String(i))[0]),
      call('test_tool', { value: 'reset' }, 'reset')[0],
      ...Array.from({ length: 10 }, (_, i) => call('gone_' + i, {}, 'g' + i)[0]),
      call('test_tool', { value: 'last' }, 'last')[0],
      { kind: 'done', stopReason: 'toolUse' },
    ] : answer);
    const events = await f.run(p);
    expect(p.requests).toHaveLength(1); expect(f.outputs()).toHaveLength(21);
    expect(events.filter(e => e.kind === 'toolEnd')).toHaveLength(21);
    expect(events.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('不存在') });
  });

  it('five identical failures within one batch persist all following results before stopping', async () => {
    const f = fixture();
    const p = new Capture(() => [...Array.from({ length: 6 }, (_, i) => call('test_tool', {}, String(i))[0]), { kind: 'done', stopReason: 'toolUse' }]);
    const events = await f.run(p);
    expect(p.requests).toHaveLength(1); expect(f.outputs()).toHaveLength(6);
    expect(events.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('5 次') });
  });

  it('retains the normal maxTurns guard', async () => {
    const f = fixture(testTool(async () => ({ output: 'ok', success: true })));
    const p = new Capture(n => call('test_tool', {}, String(n)));
    expect((await f.run(p, { maxTurns: 3 })).at(-1)).toEqual({ kind: 'error', message: '已达最大回合数 3' });
    expect(p.requests).toHaveLength(3);
  });

  it('recorded run persists five complete results and ends the ledger as failed', async () => {
    const env = ledgerEnv('w2-fuse');
    try {
      env.tools.register(testTool());
      const sid = env.newSession();
      const p = new Capture(n => call('test_tool', {}, String(n)));
      const run = startRun(env, sid, p);
      expect((await run.done).at(-1)).toMatchObject({ kind: 'error' });
      expect(p.requests).toHaveLength(5);
      expect(env.store.listMessages(sid).flatMap(m => m.parts.filter(p => p.type === 'toolResult'))).toHaveLength(5);
      expect(env.ledger.getRun(run.handle.ref.runId)).toMatchObject({ state: 'failed', stopReason: 'error' });
    } finally { env.db.close(); }
  });
});
