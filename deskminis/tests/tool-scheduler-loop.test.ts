/**
 * F04 循环级：同一批工具调用的可观察顺序、跨会话写同一文件、取消后排队的调用不再执行。
 *
 * 这里的每个 runAgentLoop 调用都不传 scheduler，走进程级缺省调度器（生产由 index.ts 显式传入，见 tool-scheduler-minisd）。
 * 所以本文件对 F04 的新模块没有运行时引入：P1–P5 在没有调度器的基线上也能加载，红在行为上；实现之后同一份文本转绿。
 * 共用一张锁表的用例之间靠「各自的数据根 + 各自的会话 id」隔离（loopEnv），不要复用。
 *
 * 受控延迟来自挂起的权限请求（ManualGateway）：/var/minis/skills/... 写要问、读免审；/var/minis/mcp-servers/... 读写都要问。
 * 断言看工具结果与磁盘内容，不看调度器事件。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { runAgentLoop, type LoopEvent } from '../src/minisd/agent/loop';
import { fileEditTool, fileReadTool, fileWriteTool } from '../src/minisd/tools/files';
import { ShellManager, makeShellTool } from '../src/minisd/tools/shell';
import { PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest, ToolContext, ToolExecutor } from '../src/minisd/tools/types';
// 只取类型：本文件对 F04 的新模块没有运行时引入（见文件头）
import type { SchedulerEvent } from '../src/minisd/tools/scheduler';
import {
  ManualGateway, ScriptProvider, allowAll, collect, loopEnv, settle, toolEndOf, toolTurn, waitFor, withDeadline,
} from './scheduler-fixture';

function fileEnv(label: string) {
  const env = loopEnv(label);
  env.tools.register(fileReadTool); env.tools.register(fileWriteTool);
  return env;
}

describe('F04 同批顺序（写→读、读→写、写→写）', () => {
  it('P1 写→读：写的权限卡挂着时，同批后面的读要等它写完，读到的是新内容', async () => {
    const env = fileEnv('P1');
    const sessionId = env.newSession();
    const gw = new ManualGateway(req => (req.kind === 'file-write' ? 'hold' : 'allow'));
    const guest = '/var/minis/skills/f04/a.txt';
    const provider = new ScriptProvider([toolTurn([
      { id: 'W', name: 'file_write', input: { path: guest, content: 'new', tool_title: '写' } },
      { id: 'R', name: 'file_read', input: { path: guest, tool_title: '读' } },
    ])]);
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: gw };
    const done = collect(runAgentLoop(env.store, { sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys' }));

    await gw.untilRequests(1);
    await settle();
    gw.allow();
    const events = await withDeadline(done, 10000, 'P1 回合结束');

    expect(toolEndOf(events, 'W')).toMatchObject({ success: true });
    expect(toolEndOf(events, 'R')).toMatchObject({ success: true, output: 'new' });
    expect(readFileSync(join(env.root, 'skills', 'f04', 'a.txt'), 'utf8')).toBe('new');
  });

  it('P2 读→写：读的权限卡挂着时，同批后面的写不能先落盘，读到的是旧内容', async () => {
    const env = fileEnv('P2');
    const sessionId = env.newSession();
    const abs = join(env.root, 'mcp-servers', 'f04.txt');
    mkdirSync(join(env.root, 'mcp-servers'), { recursive: true });
    writeFileSync(abs, 'old', 'utf8');
    const gw = new ManualGateway(req => (req.kind === 'file-read' ? 'hold' : 'allow'));
    const guest = '/var/minis/mcp-servers/f04.txt';
    const provider = new ScriptProvider([toolTurn([
      { id: 'R', name: 'file_read', input: { path: guest, tool_title: '读' } },
      { id: 'W', name: 'file_write', input: { path: guest, content: 'new', tool_title: '写' } },
    ])]);
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: gw };
    const done = collect(runAgentLoop(env.store, { sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys' }));

    await gw.untilRequests(1);
    await settle();
    // 读还没放行：写不得先落盘
    expect(readFileSync(abs, 'utf8')).toBe('old');
    gw.allow(req => req.kind === 'file-read');
    const events = await withDeadline(done, 10000, 'P2 回合结束');

    expect(toolEndOf(events, 'R')).toMatchObject({ success: true, output: 'old' });
    expect(toolEndOf(events, 'W')).toMatchObject({ success: true });
    expect(readFileSync(abs, 'utf8')).toBe('new');
  });

  it('P3 写→写：按调用顺序落盘，第二张权限卡的旧内容是第一次写入的结果', async () => {
    const env = fileEnv('P3');
    const sessionId = env.newSession();
    const guest = '/var/minis/skills/f04/p3.txt';
    // 第一次写（内容 one）的卡挂住，第二次写（内容 two）直接放行
    const gw = new ManualGateway(req => (req.preview?.newText === 'one' ? 'hold' : 'allow'));
    const provider = new ScriptProvider([toolTurn([
      { id: 'W1', name: 'file_write', input: { path: guest, content: 'one', tool_title: '写一' } },
      { id: 'W2', name: 'file_write', input: { path: guest, content: 'two', tool_title: '写二' } },
    ])]);
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: gw };
    const done = collect(runAgentLoop(env.store, { sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys' }));

    await gw.untilRequests(1);
    await settle();
    gw.allow(req => req.preview?.newText === 'one');
    const events = await withDeadline(done, 10000, 'P3 回合结束');

    expect(toolEndOf(events, 'W1')).toMatchObject({ success: true });
    expect(toolEndOf(events, 'W2')).toMatchObject({ success: true });
    expect(readFileSync(join(env.root, 'skills', 'f04', 'p3.txt'), 'utf8')).toBe('two');
    const second = gw.requests.find(r => r.preview?.newText === 'two');
    expect(second?.preview?.oldText).toBe('one');
  });
});

describe('F04 跨会话写同一文件', () => {
  it('P4 两个会话各自的回合写同一文件：后到的等前一个写完才问权限，卡上的旧内容是前一个写入的结果', async () => {
    const env = fileEnv('P4');
    const s1 = env.newSession();
    const s2 = env.newSession();
    const guest = '/var/minis/skills/f04/x.txt';
    const gw = new ManualGateway(() => 'hold');
    const run = (sessionId: string, id: string, content: string, into: LoopEvent[]): Promise<LoopEvent[]> => {
      const provider = new ScriptProvider([toolTurn([{ id, name: 'file_write', input: { path: guest, content, tool_title: `写 ${content}` } }])]);
      const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: gw };
      return collect(runAgentLoop(env.store, { sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys' }), into);
    };

    const ev1: LoopEvent[] = []; const ev2: LoopEvent[] = [];
    const done1 = run(s1, 'W1', 'one', ev1);
    await gw.untilRequests(1);
    expect(gw.requests[0].sessionId).toBe(s1);
    // 会话 1 的卡挂着时再起会话 2，等它的工具调用发出去
    const done2 = run(s2, 'W2', 'two', ev2);
    await waitFor('会话 2 的 toolStart', () => ev2.some(e => e.kind === 'toolStart'));
    await settle();

    gw.allow(req => req.sessionId === s1);
    await withDeadline(done1, 10000, 'P4 会话 1 回合结束');
    await gw.untilRequests(2);
    const second = gw.requests.find(r => r.sessionId === s2);
    expect(second?.preview?.oldText).toBe('one');
    gw.allow(req => req.sessionId === s2);
    await withDeadline(done2, 10000, 'P4 会话 2 回合结束');

    expect(toolEndOf(ev1, 'W1')).toMatchObject({ success: true });
    expect(toolEndOf(ev2, 'W2')).toMatchObject({ success: true });
    expect(readFileSync(join(env.root, 'skills', 'f04', 'x.txt'), 'utf8')).toBe('two');
  });
});

describe('F04 取消后排队的调用不再执行', () => {
  it.runIf(process.platform === 'win32')('P5 同批两条 shell：第一条在跑时取消，第二条不得执行（真实 PowerShell）', async () => {
    const env = loopEnv('P5');
    const shells = new ShellManager();
    env.tools.register(makeShellTool(shells));
    const sessionId = env.newSession();
    const ws = env.paths.workspaceOf(sessionId);
    const controller = new AbortController();
    const provider = new ScriptProvider([toolTurn([
      { id: 'S1', name: 'shell_execute', input: { command: "'s' > started.txt; Start-Sleep 5; 'a' > f1.txt", tool_title: '第一条' } },
      { id: 'S2', name: 'shell_execute', input: { command: "'b' > f2.txt", tool_title: '第二条' } },
    ])]);
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: allowAll, signal: controller.signal };
    const events: LoopEvent[] = [];
    try {
      const done = collect(runAgentLoop(env.store, { sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys', signal: controller.signal }), events);
      await waitFor('第一条命令开始执行（started.txt 出现）', () => existsSync(join(ws, 'started.txt')), 20000);
      controller.abort();
      // 回合收尾 = 两个调用都交回了结果。排队的第二条若仍被执行，此刻它已经跑完
      await withDeadline(done, 30000, 'P5 回合结束');

      expect(existsSync(join(ws, 'f2.txt'))).toBe(false);
      expect(existsSync(join(ws, 'f1.txt'))).toBe(false);
      expect(toolEndOf(events, 'S2')).toMatchObject({ success: false });
      expect(events.at(-1)).toEqual({ kind: 'error', message: '已取消' });
    } finally {
      await shells.disposeAll();
    }
  }, 60000);
});

// ---------- 以下是接入循环之后补的用例（P6–P11），同样不传 scheduler ----------

type PersistedResult = { toolUseId: string; output: string; success: boolean; status: string };

/** 落库消息里的工具调用与工具结果（按落库顺序）。
 *  ContentPart 有兜底成员 { type: string; value: unknown }，判别式收窄不生效，这里按 type 取出后显式标类型。 */
function persistedTools(env: ReturnType<typeof loopEnv>, sessionId: string): { uses: string[]; results: PersistedResult[] } {
  const parts: { type: string; value: unknown }[] = env.store.listMessages(sessionId).flatMap(m => m.parts);
  return {
    uses: parts.filter(p => p.type === 'toolUse').map(p => (p.value as { toolUseId: string }).toolUseId),
    results: parts.filter(p => p.type === 'toolResult').map(p => p.value as PersistedResult),
  };
}

describe('F04 结果与调用配对、阶段事件', () => {
  it('P6 一批三个调用（写 A、读 A、读 B）：toolEnd 与落库的 toolResult 按调用顺序；每个调用的阶段事件从 queued 到 settled', async () => {
    const env = fileEnv('P6');
    const sessionId = env.newSession();
    writeFileSync(join(env.paths.workspaceOf(sessionId), 'b.txt'), 'bbb', 'utf8');
    const provider = new ScriptProvider([toolTurn([
      { id: 'W', name: 'file_write', input: { path: 'a.txt', content: 'aaa', tool_title: '写 A' } },
      { id: 'RA', name: 'file_read', input: { path: 'a.txt', tool_title: '读 A' } },
      { id: 'RB', name: 'file_read', input: { path: 'b.txt', tool_title: '读 B' } },
    ])]);
    const toolEvents: SchedulerEvent[] = [];
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: allowAll };
    const events = await withDeadline(collect(runAgentLoop(env.store, {
      sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys', onToolEvent: e => { toolEvents.push(e); },
    })), 10000, 'P6 回合结束');

    expect(events.flatMap(e => (e.kind === 'toolEnd' ? [e.toolUseId] : []))).toEqual(['W', 'RA', 'RB']);
    expect(toolEndOf(events, 'RA')).toMatchObject({ success: true, output: 'aaa' });
    expect(toolEndOf(events, 'RB')).toMatchObject({ success: true, output: 'bbb' });
    const { uses, results } = persistedTools(env, sessionId);
    expect(uses).toEqual(['W', 'RA', 'RB']);
    expect(results.map(r => r.toolUseId)).toEqual(['W', 'RA', 'RB']);
    expect(results.map(r => r.status)).toEqual(['success', 'success', 'success']);

    for (const id of ['W', 'RA', 'RB']) {
      const mine = toolEvents.filter(e => e.toolUseId === id);
      expect(mine.every(e => e.sessionId === sessionId), id).toBe(true);
      const kinds = mine.map(e => e.kind);
      expect(kinds.slice(0, 2), id).toEqual(['queued', 'started']);
      expect(kinds.at(-1), id).toBe('settled');
      expect(kinds.filter(k => k === 'settled'), id).toHaveLength(1);
      expect(mine.at(-1), id).toMatchObject({ end: 'completed', started: true, success: true });
    }
    // 读 A 在写 A 落定之后才开始；读 B 与写 A 不冲突，不用等它
    const at = (id: string, kind: string): number => toolEvents.findIndex(e => e.toolUseId === id && e.kind === kind);
    expect(at('W', 'settled')).toBeLessThan(at('RA', 'started'));
    expect(at('RB', 'started')).toBeLessThan(at('W', 'settled'));
  });

  it('P8 批次中途取消：落库的结果消息里每个 toolUse 都有 toolResult，顺序一致，没有孤儿', async () => {
    const env = fileEnv('P8');
    const sessionId = env.newSession();
    const guest = '/var/minis/skills/f04/p8.txt';
    const gw = new ManualGateway(() => 'hold');
    const controller = new AbortController();
    const provider = new ScriptProvider([toolTurn([
      { id: 'W1', name: 'file_write', input: { path: guest, content: 'one', tool_title: '写一' } },
      { id: 'R', name: 'file_read', input: { path: guest, tool_title: '读' } },
      { id: 'W2', name: 'file_write', input: { path: '/var/minis/skills/f04/p8-other.txt', content: 'two', tool_title: '写二' } },
    ])]);
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: gw, signal: controller.signal };
    const done = collect(runAgentLoop(env.store, {
      sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys', signal: controller.signal,
    }));
    // 两个写互不冲突，卡都弹出来了；读在等第一个写
    await gw.untilRequests(2);
    controller.abort();
    const events = await withDeadline(done, 10000, 'P8 回合结束');

    expect(events.at(-1)).toEqual({ kind: 'error', message: '已取消' });
    expect(events.flatMap(e => (e.kind === 'toolEnd' ? [[e.toolUseId, e.success, e.output]] : [])))
      .toEqual([['W1', false, '[已取消]'], ['R', false, '[已取消]'], ['W2', false, '[已取消]']]);
    const { uses, results } = persistedTools(env, sessionId);
    expect(uses).toEqual(['W1', 'R', 'W2']);
    expect(results.map(r => [r.toolUseId, r.output, r.status]))
      .toEqual([['W1', '[已取消]', 'failed'], ['R', '[已取消]', 'failed'], ['W2', '[已取消]', 'failed']]);
    expect(existsSync(join(env.root, 'skills', 'f04', 'p8.txt'))).toBe(false);
    expect(existsSync(join(env.root, 'skills', 'f04', 'p8-other.txt'))).toBe(false);
    expect(gw.requests.map(r => r.kind)).toEqual(['file-write', 'file-write']);
  });

  it('P11 只给了循环级 signal（toolContext 没带）：排队等锁的调用照样认取消，不问权限、不落盘', async () => {
    const env = fileEnv('P11');
    const sessionId = env.newSession();
    const guest = '/var/minis/skills/f04/p11.txt';
    // 第一次写（内容 one）的卡挂住，第二次写（内容 two）直接放行
    const gw = new ManualGateway(req => (req.preview?.newText === 'one' ? 'hold' : 'allow'));
    const controller = new AbortController();
    const provider = new ScriptProvider([toolTurn([
      { id: 'W1', name: 'file_write', input: { path: guest, content: 'one', tool_title: '写一' } },
      { id: 'W2', name: 'file_write', input: { path: guest, content: 'two', tool_title: '写二' } },
    ])]);
    // toolContext 不带 signal：工具自己看不到取消，审批赛跑也无从认起。排队的那个只能靠循环交给调度器的 signal 拦下
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: gw };
    const done = collect(runAgentLoop(env.store, {
      sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys', signal: controller.signal,
    }));
    await gw.untilRequests(1);
    await settle();
    controller.abort();
    await settle();
    // 第一个写已经在等审批、看不到取消：放行后照常落盘。第二个写还在排队，取消后不得再执行
    gw.allow(req => req.preview?.newText === 'one');
    const events = await withDeadline(done, 10000, 'P11 回合结束');

    expect(toolEndOf(events, 'W1')).toMatchObject({ success: true });
    expect(toolEndOf(events, 'W2')).toEqual({ kind: 'toolEnd', toolUseId: 'W2', success: false, output: '[已取消]' });
    expect(gw.requests.map(r => r.preview?.newText)).toEqual(['one']);
    expect(readFileSync(join(env.root, 'skills', 'f04', 'p11.txt'), 'utf8')).toBe('one');
    expect(persistedTools(env, sessionId).results.map(r => [r.toolUseId, r.output, r.status]))
      .toEqual([['W1', expect.any(String), 'success'], ['W2', '[已取消]', 'failed']]);
    expect(events.at(-1)).toEqual({ kind: 'error', message: '已取消' });
  });
});

describe('F04 失败、拦截与排除', () => {
  it('P7 危险命令经调度器执行照样被规则拦下：零询问、不起进程（完全访问档也一样）', async () => {
    const env = loopEnv('P7');
    const spawned: unknown[][] = [];
    const noSpawn = ((...args: unknown[]) => { spawned.push(args); throw new Error('不该启动 shell：命令要真的执行了'); }) as unknown as typeof spawn;
    env.tools.register(makeShellTool(new ShellManager({ spawnImpl: noSpawn })));
    const sessionId = env.newSession();
    const asked: PermissionRequest[] = [];
    const gw = new PermissionGatewayImpl(async r => { asked.push(r); return 'allow-once'; });
    gw.applyPreset('full');
    const provider = new ScriptProvider([toolTurn([
      { id: 'S', name: 'shell_execute', input: { command: 'Remove-Item -Recurse -Force C:\\work\\build', tool_title: '清理' } },
    ])]);
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: gw };
    const events = await withDeadline(
      collect(runAgentLoop(env.store, { sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys' })), 10000, 'P7 回合结束');

    const end = toolEndOf(events, 'S');
    expect(end?.success).toBe(false);
    expect(end?.output).toContain('危险命令规则');
    expect(end?.output).toContain('不是用户拒绝');
    expect(asked).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });

  it('P9 工具失败后同批后面的调用照常执行：编辑不存在的文件失败 → 写同一文件成功 → 读到新内容', async () => {
    const env = fileEnv('P9');
    env.tools.register(fileEditTool);
    const sessionId = env.newSession();
    const provider = new ScriptProvider([toolTurn([
      { id: 'E', name: 'file_edit', input: { path: 'p9.txt', old_string: 'a', new_string: 'b', tool_title: '改' } },
      { id: 'W', name: 'file_write', input: { path: 'p9.txt', content: 'fresh', tool_title: '写' } },
      { id: 'R', name: 'file_read', input: { path: 'p9.txt', tool_title: '读' } },
    ])]);
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: allowAll };
    const events = await withDeadline(
      collect(runAgentLoop(env.store, { sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys' })), 10000, 'P9 回合结束');

    expect(toolEndOf(events, 'E')).toMatchObject({ success: false });
    expect(toolEndOf(events, 'W')).toMatchObject({ success: true });
    expect(toolEndOf(events, 'R')).toMatchObject({ success: true, output: 'fresh' });
    expect(persistedTools(env, sessionId).results.map(r => r.status)).toEqual(['failed', 'success', 'success']);
    expect(events.at(-1)?.kind).toBe('turnEnd');
  });

  it('P10 会话排除的工具与正常工具同批：被排除的不执行、文案不变、不进调度队列，其余调用照常', async () => {
    const env = fileEnv('P10');
    let ran = 0;
    const hidden: ToolExecutor = {
      definition: { name: 'hidden', description: '应被隐藏', parameters: { tool_title: { type: 'string', description: 't' } }, required: ['tool_title'] },
      async execute() { ran += 1; return { output: '不该被调用', success: true }; },
    };
    env.tools.register(hidden);
    const sessionId = env.newSession();
    const provider = new ScriptProvider([toolTurn([
      { id: 'H', name: 'hidden', input: { tool_title: '照历史再叫一次' } },
      { id: 'W', name: 'file_write', input: { path: 'p10.txt', content: 'ok', tool_title: '写' } },
      { id: 'R', name: 'file_read', input: { path: 'p10.txt', tool_title: '读' } },
    ])]);
    const toolEvents: SchedulerEvent[] = [];
    const toolContext: ToolContext = { sessionId, paths: env.paths, permissions: allowAll };
    const events = await withDeadline(collect(runAgentLoop(env.store, {
      sessionId, provider, tools: env.tools, toolContext, systemPrompt: 'sys',
      excludedToolNames: new Set(['hidden']), onToolEvent: e => { toolEvents.push(e); },
    })), 10000, 'P10 回合结束');

    expect(ran).toBe(0);
    expect(toolEndOf(events, 'H')).toEqual({ kind: 'toolEnd', toolUseId: 'H', success: false, output: '本会话没有启用工具 hidden，没有执行' });
    expect(toolEndOf(events, 'W')).toMatchObject({ success: true });
    expect(toolEndOf(events, 'R')).toMatchObject({ success: true, output: 'ok' });
    // 被排除的调用没有排队（它没声明调度元数据，排了队就是 barrier）：只有一个落定事件
    expect(toolEvents.filter(e => e.toolUseId === 'H').map(e => e.kind)).toEqual(['settled']);
    expect(toolEvents.find(e => e.toolUseId === 'H')).toMatchObject({ end: 'refused', started: false });
    expect(persistedTools(env, sessionId).results.map(r => [r.toolUseId, r.status]))
      .toEqual([['H', 'failed'], ['W', 'success'], ['R', 'success']]);
  });
});
