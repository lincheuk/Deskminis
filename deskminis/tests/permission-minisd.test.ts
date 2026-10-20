/**
 * F13：真实 minisd（startMinisd + WebSocket）上的权限结果、审计 reason 与「一张卡只了结一次」。
 *
 * 本文件运行时不引入 F13 的新模块：标「先红」的用例在实现之前就能加载、红在行为上（设计 §7.2；先红日志 F13-impl-red）。
 * 时序只靠两样：挂着的权限卡（测试决定何时答复）与很短的真实 permTimeoutMs（只断言结果，不断言时长）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame } from '../src/minisd/bridge/frame';
import { pipeRequest } from './bridge-util';
import {
  bootMinisd, cards, resolvedOf, turnEnded, promptTool, toolResults, readAudit, failAuditOn, waitFor, rpcClient, eventsOf,
  type Client,
} from './permission-fixture';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

/** 走卡的写入：技能目录属于「应用配置」，file_write 要过权限卡。 */
const SKILL = (name: string): string => `/var/minis/skills/f13/${name}`;
const onDisk = (dataDir: string, name: string): string => join(dataDir, 'skills', 'f13', name);

async function newSession(c: { call(m: string, p?: unknown): Promise<any> }): Promise<string> {
  return (await c.call('chat.sessions.create', {})).result.id as string;
}

/** 发一个要走卡的 file_write，等到卡片出现，返回它的 requestId。 */
async function writeCard(c: Parameters<typeof cards>[0], sid: string, name: string): Promise<string> {
  await promptTool(c, sid, 'file_write', { path: SKILL(name), content: 'x', tool_title: '写技能' });
  await waitFor('permission.request', () => cards(c, sid).length > 0);
  return cards(c, sid)[0].params.requestId as string;
}

describe('先红 M1 / M2：超时不是用户拒绝；超时之后的批准不生效', () => {
  it('M1 超时：模型拿到「没有人答复」，广播与审计的 reason 是 timeout，文件没写', async () => {
    const m = await bootMinisd(cleanups, { permTimeoutMs: 300 });
    const sid = await newSession(m.c);
    const requestId = await writeCard(m.c, sid, 't.md');
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);

    const results = toolResults(m.dataDir, sid);
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(false);
    expect(results[0].output).not.toContain('被用户拒绝');
    expect(results[0].output).toContain('没有人答复');
    expect(existsSync(onDisk(m.dataDir, 't.md'))).toBe(false);

    const resolved = resolvedOf(m.c, requestId);
    expect(resolved.length).toBe(1);
    expect(resolved[0].params.reason).toBe('timeout');
    expect(resolved[0].params.outcome).toMatchObject({ decision: 'deny', reason: 'timeout' });
    const rows = readAudit(m.dataDir).filter(r => r.eventType === 'permission.resolved' && r.payload.requestId === requestId);
    expect(rows.length).toBe(1);
    expect(rows[0].payload.reason).toBe('timeout');
    expect(rows[0].payload.outcome).toMatchObject({ decision: 'deny', reason: 'timeout' });
  }, 30000);

  it('M2 超时之后再批准：applied:false、带 settled；不执行、不广播 answered，审计留一条 late-response', async () => {
    const m = await bootMinisd(cleanups, { permTimeoutMs: 300 });
    const sid = await newSession(m.c);
    const requestId = await writeCard(m.c, sid, 't.md');
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);

    const r = await m.c.call('permission.respond', { requestId, decision: 'allow-once' });
    expect(r.error).toBeUndefined();
    expect(r.result.applied).toBe(false);
    expect(r.result.settled).toMatchObject({ reason: 'timeout', decision: 'deny' });

    // 让晚到的批准有机会（错误地）生效：再发一次 RPC 往返，引擎一侧的续体都已跑过
    await m.c.call('chat.sessions.list', {});
    expect(existsSync(onDisk(m.dataDir, 't.md')), '超时的卡被晚到的批准执行了').toBe(false);
    expect(resolvedOf(m.c, requestId).map(n => n.params.reason)).toEqual(['timeout']);
    const late = readAudit(m.dataDir).filter(a => a.eventType === 'permission.late-response' && a.payload.requestId === requestId);
    expect(late.length).toBe(1);
  }, 30000);
});

describe('先红 M6：permission.request 的审计写入失败，卡片照常询问、批准后照常执行', () => {
  it('卡出现 → 批准 → 文件写出，回合正常结束；引擎存活', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => { uncaught.push(e); };
    process.on('uncaughtException', onUncaught);
    cleanups.push(() => { process.off('uncaughtException', onUncaught); });

    const m = await bootMinisd(cleanups);
    failAuditOn(m.dataDir, 'permission.request');
    const sid = await newSession(m.c);
    const requestId = await writeCard(m.c, sid, 'a.md');
    await m.c.call('permission.respond', { requestId, decision: 'allow-once' });
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);

    expect(toolResults(m.dataDir, sid)[0]).toMatchObject({ success: true });
    expect(existsSync(onDisk(m.dataDir, 'a.md'))).toBe(true);
    expect(uncaught).toEqual([]);
    expect((await m.c.call('chat.sessions.list', {})).error).toBeUndefined();
  }, 30000);
});

describe('先红 M8：permission.respond 的 decision 非法，卡不动', () => {
  it("decision:'yes' → RPC 报错、卡仍待批；随后的 allow-once 照常生效", async () => {
    const m = await bootMinisd(cleanups);
    const sid = await newSession(m.c);
    const requestId = await writeCard(m.c, sid, 'a.md');

    const bad = await m.c.call('permission.respond', { requestId, decision: 'yes' });
    expect(bad.error, '不认识的决定不是「用户点了拒绝」').toBeDefined();
    await m.c.call('chat.sessions.list', {});
    expect(resolvedOf(m.c, requestId).length, '卡不该被了结').toBe(0);

    const good = await m.c.call('permission.respond', { requestId, decision: 'allow-once' });
    expect(good.error).toBeUndefined();
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);
    expect(existsSync(onDisk(m.dataDir, 'a.md'))).toBe(true);
    expect(resolvedOf(m.c, requestId).map(n => n.params.reason)).toEqual(['answered']);
  }, 30000);
});

describe('先红 M5b：删除没有在跑的会话，同样了结它经桥挂着的卡', () => {
  it.skipIf(process.platform !== 'win32')('桥卡当场按 session-deleted 了结；请求方得到 cancelled；之后的批准不生效', async () => {
    const m = await bootMinisd(cleanups);
    expect(m.bridgePipe, '真实命名管道').toBeTruthy();
    const sid = await newSession(m.c);
    // 会话没有任何 run；管道客户端不是这个会话终端的子进程，等卡期间一直连着
    const pending = pipeRequest(m.bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: sid });
    pending.catch(() => undefined);
    await waitFor('桥的权限卡', () => cards(m.c, sid).length > 0);
    const requestId = cards(m.c, sid)[0].params.requestId as string;

    const del = await m.c.call('chat.sessions.delete', { sessionId: sid, confirm: true });
    expect(del.error).toBeUndefined();
    // 权限卡的兜底时限是 60 秒：3 秒内了结只能是删除触发的
    await waitFor('这张卡的 permission.resolved', () => resolvedOf(m.c, requestId).length > 0, 3000);
    const resolved = resolvedOf(m.c, requestId);
    expect(resolved.length).toBe(1);
    expect(resolved[0].params.reason).toBe('session-deleted');
    expect(resolved[0].params.outcome).toMatchObject({ decision: 'deny', reason: 'cancelled', cause: 'session-deleted' });
    const rows = readAudit(m.dataDir).filter(r => r.eventType === 'permission.resolved' && r.payload.requestId === requestId);
    expect(rows.map(r => r.payload.reason)).toEqual(['session-deleted']);

    // 分发器在执行之前就返回了（真实引擎的 PowerShell 不能注入，以信封为证）
    const env = await pending;
    expect(env.ok).toBe(false);
    expect(env.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'cancelled' });

    const late = await m.c.call('permission.respond', { requestId, decision: 'allow-once' });
    expect(late.result.applied).toBe(false);
    expect(late.result.settled).toMatchObject({ reason: 'session-deleted' });
  }, 30000);
});

describe('先红 M12：断线之后换一条连接、凭旧 requestId 发来的批准不生效', () => {
  it('发卡之后才建立的连接答不了这张卡；发卡时已连着的连接照常能答', async () => {
    const m = await bootMinisd(cleanups);
    const a = m.c;
    const b = await m.connect();
    const sid = await newSession(b);
    await promptTool(b, sid, 'file_write', { path: SKILL('a.md'), content: 'x', tool_title: '写技能' });
    await waitFor('A、B 都收到卡', () => cards(a, sid).length > 0 && cards(b, sid).length > 0);
    const requestId = cards(b, sid)[0].params.requestId as string;

    a.close();
    await a.closed;
    const a2 = rpcClient(m.port, m.authToken);
    await a2.ready;
    cleanups.push(() => a2.close());
    const stale = [];
    for (let i = 0; i < 3; i++) stale.push((await a2.call('permission.respond', { requestId, decision: 'allow-once' })).result);
    expect(stale).toEqual([
      { ok: true, applied: false, undelivered: true },
      { ok: true, applied: false, undelivered: true },
      { ok: true, applied: false, undelivered: true },
    ]);
    await b.call('chat.sessions.list', {});
    expect(existsSync(onDisk(m.dataDir, 'a.md')), '断线后的旧批准把文件写了出来').toBe(false);
    expect(resolvedOf(b, requestId).length, '卡不该被了结').toBe(0);
    const lateRows = readAudit(m.dataDir).filter(r => r.eventType === 'permission.late-response' && r.payload.requestId === requestId);
    expect(lateRows.map(r => r.payload)).toMatchObject([{ cause: 'stale-connection', by: 'local' }]);

    const ok = await b.call('permission.respond', { requestId, decision: 'allow-once' });
    expect(ok.result).toEqual({ ok: true, applied: true });
    await waitFor('回合结束', () => turnEnded(b, sid), 10000);
    expect(existsSync(onDisk(m.dataDir, 'a.md'))).toBe(true);
    expect(resolvedOf(b, requestId).map(n => n.params.reason)).toEqual(['answered']);
    const answered = readAudit(m.dataDir).filter(r => r.eventType === 'permission.resolved' && r.payload.requestId === requestId);
    expect(answered.map(r => r.payload)).toMatchObject([{ reason: 'answered', decision: 'allow-once', by: 'local' }]);
  }, 30000);
});

// =================================================================================================================
// 以下是先红之外的用例（实现之后补写）。
// =================================================================================================================

const RULE_BLOCKED_HEAD = '命令未执行：它命中了危险命令规则';
const auditOf = (dataDir: string, eventType: string, requestId?: string) =>
  readAudit(dataDir).filter(r => r.eventType === eventType && (requestId === undefined || r.payload.requestId === requestId));
/** 第 n 张卡（从 1 起）的 requestId：等到它出现。 */
async function nthCard(c: Client, sid: string, n: number): Promise<string> {
  await waitFor(`第 ${n} 张权限卡`, () => cards(c, sid).length >= n);
  return cards(c, sid)[n - 1].params.requestId as string;
}

describe('V1 各种原因的输出与审计 reason', () => {
  it('M3 用户拒绝：文案逐字不变；审计 answered / deny / user-denied / by:local；卡片绑定到发起它的工具调用', async () => {
    const m = await bootMinisd(cleanups);
    const sid = await newSession(m.c);
    const requestId = await writeCard(m.c, sid, 'a.md');
    const card = cards(m.c, sid)[0].params;
    const started = eventsOf(m.c, sid).filter(e => e.kind === 'toolStart');
    expect(started.length).toBe(1);
    expect(card.meta.toolUseId, '卡片带发起它的工具调用 id').toBe(started[0].toolUseId);

    expect((await m.c.call('permission.respond', { requestId, decision: 'deny' })).result).toEqual({ ok: true, applied: true });
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);
    const abs = onDisk(m.dataDir, 'a.md');
    expect(toolResults(m.dataDir, sid)[0]).toMatchObject({ success: false, output: `写入被用户拒绝: ${abs}（可在设置-权限中调整）` });
    expect(existsSync(abs)).toBe(false);
    expect(resolvedOf(m.c, requestId).map(n => n.params)).toEqual([
      { requestId, reason: 'answered', outcome: { decision: 'deny', reason: 'user-denied', requestId, waitedMs: expect.any(Number) } },
    ]);
    const rows = auditOf(m.dataDir, 'permission.resolved', requestId);
    expect(rows.length).toBe(1);
    expect(rows[0].sessionId).toBe(sid);
    expect(rows[0].payload).toMatchObject({ reason: 'answered', decision: 'deny', by: 'local', toolUseId: started[0].toolUseId, outcome: { decision: 'deny', reason: 'user-denied' } });
    expect(auditOf(m.dataDir, 'permission.request', requestId)[0].payload.meta.toolUseId).toBe(started[0].toolUseId);
  }, 30000);

  it('M4 规则阻止：危险命令（ask 与 full 两档）与核心数据都不弹卡；审计各有一条 permission.denied', async () => {
    const m = await bootMinisd(cleanups);
    const run = async (name: string, input: Record<string, unknown>): Promise<{ sid: string; output: string }> => {
      const sid = await newSession(m.c);
      await promptTool(m.c, sid, name, input);
      await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);
      const results = toolResults(m.dataDir, sid);
      expect(results.length).toBe(1);
      expect(results[0].success).toBe(false);
      return { sid, output: results[0].output };
    };
    const expectRuleBlocked = (output: string): void => {
      expect(output.startsWith(RULE_BLOCKED_HEAD)).toBe(true);
      expect(output).toContain('不是用户拒绝的');
      expect(output).toContain('换任何权限档位也不会放行');
      expect(output).not.toContain('被用户拒绝');
      expect(output).not.toContain('可在设置-权限中调整');
    };
    const shellAsk = await run('shell_execute', { command: 'Remove-Item x', tool_title: '删' });
    expectRuleBlocked(shellAsk.output);
    expect((await m.c.call('permission.setPreset', { preset: 'full' })).error).toBeUndefined();
    const shellFull = await run('shell_execute', { command: 'Remove-Item x', tool_title: '删' });
    expectRuleBlocked(shellFull.output);

    // 核心数据：full 档也照拒，不进网关
    const core = join(m.dataDir, 'providers.json');
    const before = existsSync(core);
    const file = await run('file_write', { path: core, content: 'x', tool_title: '写' });
    expect(file.output).toContain('核心数据');
    expect(existsSync(core)).toBe(before);

    expect(m.c.notifications.filter(n => n.method === 'permission.request')).toEqual([]);
    const denied = auditOf(m.dataDir, 'permission.denied');
    expect(denied.map(r => [r.sessionId, r.payload.req.kind, r.payload.outcome, r.payload.origin])).toEqual([
      [shellAsk.sid, 'shell', { decision: 'deny', reason: 'rule-blocked', cause: 'shell-danger' }, 'tool'],
      [shellFull.sid, 'shell', { decision: 'deny', reason: 'rule-blocked', cause: 'shell-danger' }, 'tool'],
      [file.sid, 'file-write', { decision: 'deny', reason: 'rule-blocked', cause: 'core-data' }, 'tool'],
    ]);
    for (const r of denied) expect(typeof r.payload.toolUseId, '绑定到发起它的工具调用').toBe('string');
  }, 30000);

  it('M5 / M10 chat.cancel：卡按 cancelled / user-stop 了结，落库 [已取消]；之后的 allow-once 不生效', async () => {
    const m = await bootMinisd(cleanups);
    const sid = await newSession(m.c);
    const requestId = await writeCard(m.c, sid, 'a.md');
    expect((await m.c.call('chat.cancel', { sessionId: sid })).error).toBeUndefined();
    const late = await m.c.call('permission.respond', { requestId, decision: 'allow-once' });
    expect(late.result).toEqual({ ok: true, applied: false, settled: { reason: 'cancelled', decision: 'deny' } });
    await waitFor('toolResult 落库', () => toolResults(m.dataDir, sid).length > 0, 10000);
    await m.c.call('chat.sessions.list', {});

    expect(toolResults(m.dataDir, sid)[0]).toMatchObject({ output: '[已取消]', success: false });
    expect(existsSync(onDisk(m.dataDir, 'a.md')), '取消后的批准执行了').toBe(false);
    expect(resolvedOf(m.c, requestId).map(n => n.params.reason)).toEqual(['cancelled']);
    const rows = auditOf(m.dataDir, 'permission.resolved', requestId);
    expect(rows.map(r => [r.payload.reason, r.payload.outcome.reason, r.payload.outcome.cause])).toEqual([['cancelled', 'cancelled', 'user-stop']]);
    expect(rows[0].payload.decision, '系统代为了结的卡不记 decision').toBeUndefined();
    expect(auditOf(m.dataDir, 'permission.late-response', requestId).map(r => r.payload)).toMatchObject([{ decision: 'allow-once', by: 'local', cause: 'settled' }]);
  }, 30000);

  it('M5 删除会话：卡按 session-deleted 了结，cause 是 session-deleted；文件没写', async () => {
    const m = await bootMinisd(cleanups);
    const sid = await newSession(m.c);
    const requestId = await writeCard(m.c, sid, 'a.md');
    expect((await m.c.call('chat.sessions.delete', { sessionId: sid, confirm: true })).error).toBeUndefined();
    expect(resolvedOf(m.c, requestId).map(n => n.params.reason)).toEqual(['session-deleted']);
    const rows = auditOf(m.dataDir, 'permission.resolved', requestId);
    expect(rows.map(r => [r.payload.reason, r.payload.outcome.reason, r.payload.outcome.cause])).toEqual([['session-deleted', 'cancelled', 'session-deleted']]);
    expect((await m.c.call('permission.respond', { requestId, decision: 'allow-once' })).result).toMatchObject({ applied: false, settled: { reason: 'session-deleted' } });
    await m.c.call('chat.sessions.list', {});
    expect(existsSync(onDisk(m.dataDir, 'a.md'))).toBe(false);
  }, 30000);

  it('M5 / M11 关停：卡按 shutdown 了结、落库 [已取消]；同一数据根重开后，对旧卡的批准查无此卡、不执行', async () => {
    const m = await bootMinisd(cleanups);
    const sid = await newSession(m.c);
    const requestId = await writeCard(m.c, sid, 'a.md');
    await m.close();

    expect(toolResults(m.dataDir, sid)[0]).toMatchObject({ output: '[已取消]', success: false });
    const rows = auditOf(m.dataDir, 'permission.resolved', requestId);
    expect(rows.map(r => [r.payload.reason, r.payload.outcome.reason, r.payload.outcome.cause])).toEqual([['shutdown', 'cancelled', 'shutdown']]);
    expect(existsSync(onDisk(m.dataDir, 'a.md'))).toBe(false);

    // 重启后的旧批准：requestId 只在签发它的进程里有效
    const again = await bootMinisd(cleanups, { dataDir: m.dataDir });
    const auditBefore = readAudit(m.dataDir).length;
    const r = await again.c.call('permission.respond', { requestId, decision: 'allow-once' });
    expect(r.result).toEqual({ ok: true, applied: false });
    await again.c.call('chat.sessions.list', {});
    expect(existsSync(onDisk(m.dataDir, 'a.md'))).toBe(false);
    expect(again.c.notifications.filter(n => n.method === 'permission.resolved')).toEqual([]);
    expect(readAudit(m.dataDir).length, '不认识的 id 不写审计').toBe(auditBefore);
  }, 30000);

  it('M13 等待审批不改档位：超时、取消、拒绝各一次之后仍是 ask，审计里没有 permission.preset', async () => {
    // 三个会话各走一种非允许的终态（档位是全局的）：超时放最后，前两张卡在它的时限内就了结了
    const m = await bootMinisd(cleanups, { permTimeoutMs: 3000 });
    const cancelSid = await newSession(m.c);
    await promptTool(m.c, cancelSid, 'file_write', { path: SKILL('c.md'), content: 'x', tool_title: '写技能' });
    await nthCard(m.c, cancelSid, 1);
    await m.c.call('chat.cancel', { sessionId: cancelSid });
    await waitFor('取消的 toolResult 落库', () => toolResults(m.dataDir, cancelSid).length >= 1, 10000);

    const denySid = await newSession(m.c);
    await promptTool(m.c, denySid, 'file_write', { path: SKILL('d.md'), content: 'x', tool_title: '写技能' });
    await m.c.call('permission.respond', { requestId: await nthCard(m.c, denySid, 1), decision: 'deny' });
    await waitFor('拒绝的回合结束', () => turnEnded(m.c, denySid), 10000);

    const timeoutSid = await newSession(m.c);
    await writeCard(m.c, timeoutSid, 't.md');
    await waitFor('超时的回合结束', () => turnEnded(m.c, timeoutSid), 15000);

    expect(toolResults(m.dataDir, cancelSid)[0].output).toBe('[已取消]');
    expect(toolResults(m.dataDir, denySid)[0].output).toContain('写入被用户拒绝');
    expect(toolResults(m.dataDir, timeoutSid)[0].output).toContain('没有人答复');
    expect((await m.c.call('permission.getPreset', {})).result).toEqual({ preset: 'ask' });
    expect(auditOf(m.dataDir, 'permission.preset')).toEqual([]);
    for (const n of ['t.md', 'c.md', 'd.md']) expect(existsSync(onDisk(m.dataDir, n))).toBe(false);
  }, 60000);
});

describe('V2 双客户端不同决定：只结算一次', () => {
  it.each([
    ['A 允许、B 拒绝', 'allow-once', 'deny'],
    ['A 拒绝、B 允许', 'deny', 'allow-once'],
  ] as const)('M7 %s（两条不等应答连发）：恰好一条生效；广播、审计各一条；文件存在当且仅当生效的是允许', async (_n, da, db) => {
    const m = await bootMinisd(cleanups);
    const a = m.c;
    const b = await m.connect();
    const sid = await newSession(a);
    await promptTool(a, sid, 'file_write', { path: SKILL('a.md'), content: 'x', tool_title: '写技能' });
    await waitFor('A、B 都收到卡', () => cards(a, sid).length > 0 && cards(b, sid).length > 0);
    const requestId = cards(a, sid)[0].params.requestId as string;

    const pa = a.call('permission.respond', { requestId, decision: da });
    const pb = b.call('permission.respond', { requestId, decision: db });
    const [ra, rb] = await Promise.all([pa, pb]);
    expect([ra.result.applied, rb.result.applied].filter(Boolean).length, '恰好一条生效').toBe(1);
    const winner = ra.result.applied ? da : db;
    const loser = ra.result.applied ? rb.result : ra.result;
    expect(loser).toEqual({ ok: true, applied: false, settled: { reason: 'answered', decision: winner === 'deny' ? 'deny' : 'allow' } });
    await waitFor('回合结束', () => turnEnded(a, sid), 10000);
    await b.call('chat.sessions.list', {});

    expect(existsSync(onDisk(m.dataDir, 'a.md'))).toBe(winner === 'allow-once');
    expect(resolvedOf(a, requestId).map(n => n.params.reason)).toEqual(['answered']);
    expect(resolvedOf(b, requestId).map(n => n.params.reason)).toEqual(['answered']);
    const rows = auditOf(m.dataDir, 'permission.resolved', requestId);
    expect(rows.map(r => r.payload.decision)).toEqual([winner]);
    expect(auditOf(m.dataDir, 'permission.late-response', requestId).length).toBe(1);
  }, 30000);

  it.skipIf(process.platform !== 'win32')('M7b 带桥触发的 shell 卡先拒绝、后 allow-session：晚到的答复不发桥授权，随后的桥请求仍然弹卡', async () => {
    const m = await bootMinisd(cleanups);
    const sid = await newSession(m.c);
    await promptTool(m.c, sid, 'shell_execute', { command: 'windows-clipboard get', tool_title: '读剪贴板' });
    const requestId = await nthCard(m.c, sid, 1);
    expect(cards(m.c, sid)[0].params.meta.bridgeTriggers).toEqual(['bridge-clipboard-read']);
    expect((await m.c.call('permission.respond', { requestId, decision: 'deny' })).result).toEqual({ ok: true, applied: true });
    expect((await m.c.call('permission.respond', { requestId, decision: 'allow-session' })).result).toMatchObject({ applied: false, settled: { reason: 'answered', decision: 'deny' } });
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);
    expect(toolResults(m.dataDir, sid)[0]).toMatchObject({ output: '命令被用户拒绝（可在设置-权限中调整）', success: false });

    // 晚到的 allow-session 若发了桥授权，这次桥请求就不会弹卡
    const bridge = pipeRequest(m.bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: sid });
    const second = await nthCard(m.c, sid, 2);
    expect(cards(m.c, sid)[1].params.req.kind).toBe('bridge-clipboard-read');
    await m.c.call('permission.respond', { requestId: second, decision: 'deny' });
    expect((await bridge).error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'user-denied' });
  }, 30000);

  // 变异检查补的：卡片了结搬进 broker 之后，「允许一次」发成会话级桥授权时没有用例变红
  // （rpc.test 只钉 allow-session 之后免审；网关级的一次性授权在 permissions-bridge-merge，不经 index.ts 的接线）
  it.skipIf(process.platform !== 'win32')('M7c 带桥触发的 shell 卡点「允许一次」：只发一次性桥授权——第一条同类桥请求免审，第二条重新弹卡', async () => {
    const m = await bootMinisd(cleanups);
    const sid = await newSession(m.c);
    // Write-Output 只回显、不真调桥：一次性授权留给下面的真管道请求来消费（同 rpc.test 的合并授权用例）
    await promptTool(m.c, sid, 'shell_execute', { command: 'Write-Output "windows-clipboard get"', tool_title: '桥演示' });
    const requestId = await nthCard(m.c, sid, 1);
    expect(cards(m.c, sid)[0].params.meta.bridgeTriggers).toEqual(['bridge-clipboard-read']);
    expect((await m.c.call('permission.respond', { requestId, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);

    // 第一条：一次性合并授权命中，不弹卡
    const first = await pipeRequest(m.bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: sid });
    expect(first.error?.code, '第一条桥请求不是被权限拦下的').not.toBe('PERMISSION_DENIED');
    expect(cards(m.c, sid).length, '第一条桥请求免审，没有新卡').toBe(1);
    // 第二条：授权已消费，重新弹卡——发成了会话级授权的话这里不会弹
    const second = pipeRequest(m.bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: sid });
    const card2 = await nthCard(m.c, sid, 2);
    expect(cards(m.c, sid)[1].params.req.kind).toBe('bridge-clipboard-read');
    await m.c.call('permission.respond', { requestId: card2, decision: 'deny' });
    expect((await second).error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'user-denied' });
  }, 30000);
});

describe('V1 MCP 停用：挂着的卡当场作废；闸前拒绝留痕', () => {
  /** 真实 stdio 桩（electron 以 ELECTRON_RUN_AS_NODE=1 跑成 node，同 mcp-manager.test.ts 的 RPC 集成用例）。 */
  async function bootWithMcp(names: string[] = ['fx']) {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-f13-mcp-'));
    mkdirSync(join(dataDir, 'mcp-servers'), { recursive: true });
    const FX = { command: process.execPath, args: [join(__dirname, 'mcp-stdio-server.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
    writeFileSync(join(dataDir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: Object.fromEntries(names.map(n => [n, FX])) }), 'utf8');
    return bootMinisd(cleanups, { dataDir });
  }
  /** 发起一次 mcp__fx__echo，等到它的权限卡。 */
  async function mcpCard(c: Client): Promise<{ sid: string; requestId: string }> {
    const sid = await newSession(c);
    await promptTool(c, sid, 'mcp__fx__echo', { tool_title: '调 MCP', text: 'hi' });
    const requestId = await nthCard(c, sid, 1);
    expect(cards(c, sid)[0].params.req).toMatchObject({ kind: 'mcp', detail: 'fx' });
    return { sid, requestId };
  }

  it.each([
    ['toggle 停用', 'mcp.servers.toggle', { name: 'fx', enabled: false }, 'mcp-disabled', '该 MCP server 已停用'],
    ['remove 移除', 'mcp.servers.remove', { name: 'fx' }, 'mcp-removed', '该 MCP server 已不在配置中'],
    ['upsert 改配置', 'mcp.servers.upsert', { name: 'fx', note: '改了' }, 'mcp-config-changed', '该 MCP server 配置刚被修改，本次调用未执行'],
    // 变异检查补的：改名时旧名字挂着的卡也要作废（此前只有源码守卫认这一行）
    ['upsert 改名（旧名的卡）', 'mcp.servers.upsert', { name: 'fz', renameFrom: 'fx' }, 'mcp-config-changed', '该 MCP server 已不在配置中'],
  ] as const)('M9 %s：卡按 invalidated 了结，工具立即返回原话，不等超时；之后的 allow-once 不生效', async (_n, method, params, cause, output) => {
    const m = await bootWithMcp();
    const { sid, requestId } = await mcpCard(m.c);
    expect((await m.c.call(method, params)).error).toBeUndefined();
    // 兜底时限 60 秒：几秒内了结只能是失效钩子触发的
    await waitFor('permission.resolved', () => resolvedOf(m.c, requestId).length > 0, 3000);
    expect(resolvedOf(m.c, requestId).map(n => n.params)).toMatchObject([{ reason: 'invalidated', outcome: { decision: 'deny', reason: 'invalidated', cause } }]);
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);
    expect(toolResults(m.dataDir, sid)[0]).toMatchObject({ output, success: false });
    expect(auditOf(m.dataDir, 'permission.resolved', requestId).map(r => [r.payload.reason, r.payload.outcome.cause])).toEqual([['invalidated', cause]]);
    expect((await m.c.call('permission.respond', { requestId, decision: 'allow-once' })).result).toEqual({ ok: true, applied: false, settled: { reason: 'invalidated', decision: 'deny' } });
  }, 30000);

  it('M9 setMcpDisabled：只作废本会话的卡——别的会话禁用同一台，这张卡不动', async () => {
    const m = await bootWithMcp();
    const { sid, requestId } = await mcpCard(m.c);
    const other = await newSession(m.c);
    expect((await m.c.call('chat.sessions.setMcpDisabled', { sessionId: other, servers: ['fx'] })).error).toBeUndefined();
    await m.c.call('chat.sessions.list', {});
    expect(resolvedOf(m.c, requestId), '别的会话的禁用不该动这张卡').toEqual([]);

    expect((await m.c.call('chat.sessions.setMcpDisabled', { sessionId: sid, servers: ['fx'] })).error).toBeUndefined();
    expect(resolvedOf(m.c, requestId).map(n => n.params)).toMatchObject([{ reason: 'invalidated', outcome: { cause: 'mcp-session-disabled' } }]);
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);
    expect(toolResults(m.dataDir, sid)[0]).toMatchObject({ output: '该 MCP server 已在本会话禁用', success: false });
  }, 30000);

  // 变异检查补的：失效钩子的匹配条件少一项（不看是哪一台 / 不看是不是 MCP 卡）时，上面几条都不红——它们只挂着一张卡
  it('M9c 失效只认这一台的 MCP 卡：停用 fx，别的服务器（fy）的卡、detail 恰好也叫 fx 的 shell 卡都不动，照常能答', async () => {
    const m = await bootWithMcp(['fx', 'fy']);
    const a = await mcpCard(m.c);                                                   // 会话 A：mcp / fx
    const sidB = await newSession(m.c);
    await promptTool(m.c, sidB, 'mcp__fy__echo', { tool_title: '调另一台', text: 'hi' });
    const cardB = await nthCard(m.c, sidB, 1);
    expect(cards(m.c, sidB)[0].params.req).toMatchObject({ kind: 'mcp', detail: 'fy' });
    const sidC = await newSession(m.c);
    await promptTool(m.c, sidC, 'shell_execute', { command: 'fx', tool_title: '跑一个叫 fx 的命令' });
    const cardC = await nthCard(m.c, sidC, 1);
    expect(cards(m.c, sidC)[0].params.req).toMatchObject({ kind: 'shell', detail: 'fx' });

    expect((await m.c.call('mcp.servers.toggle', { name: 'fx', enabled: false })).error).toBeUndefined();
    await waitFor('fx 的卡作废', () => resolvedOf(m.c, a.requestId).length > 0, 3000);
    await m.c.call('chat.sessions.list', {});   // 三张卡的广播出自同一段同步代码：再等一个来回，该到的都到了
    expect(resolvedOf(m.c, cardB), '别的服务器的卡不动').toEqual([]);
    expect(resolvedOf(m.c, cardC), '不是 MCP 的卡不动（哪怕 detail 同名）').toEqual([]);

    expect((await m.c.call('permission.respond', { requestId: cardB, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    expect((await m.c.call('permission.respond', { requestId: cardC, decision: 'deny' })).result).toEqual({ ok: true, applied: true });
    await waitFor('三个回合都结束', () => turnEnded(m.c, a.sid) && turnEnded(m.c, sidB) && turnEnded(m.c, sidC), 15000);
    expect(toolResults(m.dataDir, a.sid)[0]).toMatchObject({ output: '该 MCP server 已停用', success: false });
    expect(toolResults(m.dataDir, sidB)[0].success, 'fy 照常调通').toBe(true);
    expect(toolResults(m.dataDir, sidC)[0]).toMatchObject({ output: '命令被用户拒绝（可在设置-权限中调整）', success: false });
  }, 40000);

  it('M9b 调用前已停用：不弹卡，输出原话，审计一条 permission.denied（invalidated / mcp-disabled）', async () => {
    const m = await bootWithMcp();
    // 先连上并真的调通一次
    const first = await mcpCard(m.c);
    await m.c.call('permission.respond', { requestId: first.requestId, decision: 'allow-once' });
    await waitFor('回合结束', () => turnEnded(m.c, first.sid), 10000);
    expect(toolResults(m.dataDir, first.sid)[0].success).toBe(true);

    await m.c.call('mcp.servers.toggle', { name: 'fx', enabled: false });
    const sid = await newSession(m.c);
    await promptTool(m.c, sid, 'mcp__fx__echo', { tool_title: '调 MCP', text: 'hi' });
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);
    expect(cards(m.c, sid), '停用的服务器不弹卡').toEqual([]);
    expect(toolResults(m.dataDir, sid)[0]).toMatchObject({ output: '该 MCP server 已停用', success: false });
    const denied = auditOf(m.dataDir, 'permission.denied').filter(r => r.sessionId === sid);
    expect(denied.map(r => [r.payload.req.kind, r.payload.req.detail, r.payload.outcome])).toEqual([
      ['mcp', 'fx', { decision: 'deny', reason: 'invalidated', cause: 'mcp-disabled' }],
    ]);
  }, 30000);
});

describe('V4 审计写入失败：卡片照常了结、引擎存活', () => {
  function spyWarn(): string[] {
    const warns: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    cleanups.push(() => { warn.mockRestore(); });
    return warns;
  }

  it('M14 permission.resolved 的审计写不进去：respond 仍返回 applied:true，文件写出，只留一条警告', async () => {
    const warns = spyWarn();
    const m = await bootMinisd(cleanups);
    failAuditOn(m.dataDir, 'permission.resolved');
    const sid = await newSession(m.c);
    const requestId = await writeCard(m.c, sid, 'a.md');
    const r = await m.c.call('permission.respond', { requestId, decision: 'allow-once' });
    expect(r.error, '审计失败不该让答复报错').toBeUndefined();
    expect(r.result).toEqual({ ok: true, applied: true });
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);
    expect(existsSync(onDisk(m.dataDir, 'a.md'))).toBe(true);
    expect(resolvedOf(m.c, requestId).map(n => n.params.reason)).toEqual(['answered']);
    expect(warns.some(w => w.includes(requestId) && w.includes('审计'))).toBe(true);
    expect(auditOf(m.dataDir, 'permission.resolved', requestId)).toEqual([]);
  }, 30000);

  it('M15 permission.denied 的审计写不进去：规则拦截的输出不变，回合正常结束，只留一条含「审计」的警告', async () => {
    const warns = spyWarn();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => { uncaught.push(e); };
    process.on('uncaughtException', onUncaught);
    cleanups.push(() => { process.off('uncaughtException', onUncaught); });
    const m = await bootMinisd(cleanups);
    failAuditOn(m.dataDir, 'permission.denied');
    const sid = await newSession(m.c);
    await promptTool(m.c, sid, 'shell_execute', { command: 'Remove-Item x', tool_title: '删' });
    await waitFor('回合结束', () => turnEnded(m.c, sid), 10000);
    expect(toolResults(m.dataDir, sid)[0].output.startsWith(RULE_BLOCKED_HEAD)).toBe(true);
    expect(warns.some(w => w.includes('审计') && w.includes('权限拒绝'))).toBe(true);
    expect(uncaught).toEqual([]);
    expect((await m.c.call('chat.sessions.list', {})).error).toBeUndefined();
    expect(auditOf(m.dataDir, 'permission.denied')).toEqual([]);
  }, 30000);
});

describe('M17 用户发新消息后重新询问（chat.prompt 清掉连续无人答复的计数）', () => {
  /** 上一回合的 turnEnd 发出之后，run 收尾还要一点时间：被「会话正在运行」拒掉就重发（被拒的 prompt 没有任何副作用）。 */
  async function promptWhenIdle(c: Client, sid: string, name: string, input: Record<string, unknown>): Promise<void> {
    const deadline = Date.now() + 10000;
    for (;;) {
      const r = await c.call('chat.prompt', { sessionId: sid, providerId: '__fake__', text: `__tool__ ${name} ${JSON.stringify(input)}` });
      if (!r.error) return;
      if (Date.now() > deadline) throw new Error(`chat.prompt 一直被拒: ${r.error.message}`);
      await new Promise(res => setTimeout(res, 20));
    }
  }

  it('同一会话连发三条消息、每条一个要询问的写入、都不答复：三次都弹了卡', async () => {
    const m = await bootMinisd(cleanups, { permTimeoutMs: 200 });
    const sid = await newSession(m.c);
    for (let i = 1; i <= 3; i++) {
      await promptWhenIdle(m.c, sid, 'file_write', { path: SKILL(`m17-${i}.md`), content: 'x', tool_title: '写技能' });
      await waitFor(`第 ${i} 回合结束`, () => turnEnded(m.c, sid, i), 15000);
    }
    expect(cards(m.c, sid).length, '第三次没有弹卡：chat.prompt 没清计数').toBe(3);
    // 每条消息里都只有一次询问、都按超时了结
    expect(cards(m.c, sid).map(n => resolvedOf(m.c, n.params.requestId).map(x => x.params.reason))).toEqual([['timeout'], ['timeout'], ['timeout']]);
    expect(auditOf(m.dataDir, 'permission.denied')).toEqual([]);
  }, 60000);
});

describe('M18 桥发起的卡也受无人答复上限约束——只在该会话有 run 在跑时（复核 A1 / B1）', () => {
  // 以前桥询问一律不计数、不受限：agent 的 shell 子进程（命令已获会话授权、又探测不到桥触发）能无人值守地反复弹桥卡。
  // 现在 index.ts 把「这个会话有没有 run 在跑」交给网关：有 run 时桥询问与工具询问同样计数、同样受限；
  // 没有 run 的会话（用户在终端面板里手动跑的桥命令）照旧。
  it.skipIf(process.platform !== 'win32')('有 run 的会话：两张桥卡超时后不再弹卡、立即拒回；没有 run 的会话照常弹卡；回合结束后恢复', async () => {
    // 让一个 run 一直在跑、又不占着权限卡：真实 stdio 桩的 slow 工具，批准之后 20 秒才应答（MCP 调用自身的时限是 60 秒）
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-f13-m18-'));
    mkdirSync(join(dataDir, 'mcp-servers'), { recursive: true });
    const FX = { command: process.execPath, args: [join(__dirname, 'mcp-stdio-server.mjs'), '--slow-ms', '20000'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    writeFileSync(join(dataDir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { fx: FX } }), 'utf8');
    const m = await bootMinisd(cleanups, { dataDir, permTimeoutMs: 1500 });
    expect(m.bridgePipe, '真实命名管道').toBeTruthy();
    const busy = await newSession(m.c);
    const idle = await newSession(m.c);
    await promptTool(m.c, busy, 'mcp__fx__slow', { tool_title: '慢调用' });
    const mcpCard = await nthCard(m.c, busy, 1);
    expect((await m.c.call('permission.respond', { requestId: mcpCard, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    // 此后 busy 的 run 挂在 slow 调用上：在跑，没有待批的卡

    const clip = (sid: string) => pipeRequest(m.bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: sid });
    const bridgeCards = (sid: string) => cards(m.c, sid).filter(n => n.params.req.kind === 'bridge-clipboard-read');

    // 两个会话各发两次桥请求，都没人答复：四张卡都挂满时限后超时
    for (let i = 1; i <= 2; i++) {
      const [b, d] = await Promise.all([clip(busy), clip(idle)]);
      expect(b.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'timeout' });
      expect(d.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'timeout' });
      expect(bridgeCards(busy).length).toBe(i);
      expect(bridgeCards(idle).length).toBe(i);
    }
    expect(eventsOf(m.c, busy).some(e => e.kind === 'turnEnd'), 'busy 的回合应当还在跑').toBe(false);

    // 第三次。busy：不弹卡、不等时限，立即拒回，审计一条 origin 为 bridge 的 unattended
    const third = await clip(busy);
    expect(third.ok).toBe(false);
    expect(third.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'timeout' });
    expect(third.error!.message).toContain('这次没有再询问');
    expect(bridgeCards(busy).length, '有 run 的会话到上限后还在弹桥卡').toBe(2);
    const denied = auditOf(m.dataDir, 'permission.denied');
    expect(denied.map(r => [r.sessionId, r.payload.req.kind, r.payload.outcome, r.payload.origin])).toEqual([
      [busy, 'bridge-clipboard-read', { decision: 'deny', reason: 'timeout', cause: 'unattended' }, 'bridge'],
    ]);
    // idle：没有 run，照常弹卡（用户在终端面板里手动跑的命令，人就在跟前）
    const idleThird = clip(idle);
    await waitFor('idle 的第三张桥卡', () => bridgeCards(idle).length === 3);
    await m.c.call('permission.respond', { requestId: bridgeCards(idle)[2].params.requestId, decision: 'deny' });
    expect((await idleThird).error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'user-denied' });
    expect(auditOf(m.dataDir, 'permission.denied').filter(r => r.sessionId === idle)).toEqual([]);

    // busy 的回合结束之后：桥询问不再受限（计数还在，要等下一条消息清零，但没有 run 的会话桥询问不看计数）。
    // 收尾是异步的：收尾之前到达的桥请求仍被立即拒回，所以重发到弹出第三张卡为止
    expect((await m.c.call('chat.cancel', { sessionId: busy })).error).toBeUndefined();
    const deadline = Date.now() + 15000;
    let last: ReturnType<typeof clip>;
    for (;;) {
      const p = clip(busy);
      let returned = false;
      p.then(() => { returned = true; }, () => { returned = true; });
      await waitFor('桥请求被拒回或弹了卡', () => returned || bridgeCards(busy).length === 3, 10000);
      if (bridgeCards(busy).length === 3) { last = p; break; }
      if (Date.now() > deadline) throw new Error('回合结束之后桥请求仍然不弹卡');
      await new Promise(res => setTimeout(res, 20));
    }
    await m.c.call('permission.respond', { requestId: bridgeCards(busy)[2].params.requestId, decision: 'deny' });
    expect((await last).error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'user-denied' });
  }, 60000);

  // 复核 R1-1：请求方先走一步。shell_execute 的 timeout_seconds 小于卡片时限时，命令先被杀掉进程树，bridge-cli 随之退出、
  // 管道断开——桥卡按 cancelled / requester-gone 了结，不是挂满时限按 timeout 了结。只认 timeout 的话这条路上计数一直是 0。
  // 这里用真实管道：发完请求帧、等卡弹出就把连接断掉（与被杀掉的 bridge-cli 在管道上的表现相同）。
  it.skipIf(process.platform !== 'win32')('有 run 的会话：桥卡被请求方断开了结两次之后同样不再弹卡、立即拒回；没有 run 的会话照常弹卡', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-f13-m18b-'));
    mkdirSync(join(dataDir, 'mcp-servers'), { recursive: true });
    const FX = { command: process.execPath, args: [join(__dirname, 'mcp-stdio-server.mjs'), '--slow-ms', '20000'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    writeFileSync(join(dataDir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { fx: FX } }), 'utf8');
    // 卡片时限用 bootMinisd 的缺省 60 秒：下面几秒内的了结只能是请求方断开触发的
    const m = await bootMinisd(cleanups, { dataDir });
    expect(m.bridgePipe, '真实命名管道').toBeTruthy();
    const busy = await newSession(m.c);
    const idle = await newSession(m.c);
    await promptTool(m.c, busy, 'mcp__fx__slow', { tool_title: '慢调用' });
    const mcpCard = await nthCard(m.c, busy, 1);
    expect((await m.c.call('permission.respond', { requestId: mcpCard, decision: 'allow-once' })).result).toEqual({ ok: true, applied: true });
    // 此后 busy 的 run 挂在 slow 调用上：在跑，没有待批的卡

    const CLIP = (sid: string) => ({ tool: 'windows-clipboard', action: 'get', args: {}, sessionId: sid });
    const bridgeCards = (sid: string) => cards(m.c, sid).filter(n => n.params.req.kind === 'bridge-clipboard-read');
    /** 发一个桥请求，等它的卡弹出来就把管道断掉，再等这张卡了结。 */
    const askThenLeave = async (sid: string, n: number): Promise<void> => {
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(m.bridgePipe!);
        s.on('error', reject);
        s.on('connect', () => s.write(encodeFrame(CLIP(sid)), () => { s.off('error', reject); s.on('error', () => undefined); resolve(s); }));
      });
      await waitFor(`第 ${n} 张桥卡`, () => bridgeCards(sid).length >= n);
      expect(bridgeCards(sid).length).toBe(n);
      const requestId = bridgeCards(sid)[n - 1].params.requestId as string;
      socket.destroy();
      await waitFor('这张卡的 permission.resolved', () => resolvedOf(m.c, requestId).length > 0, 5000);
      expect(resolvedOf(m.c, requestId).map(x => [x.params.reason, x.params.outcome.cause])).toEqual([['cancelled', 'requester-gone']]);
    };
    for (let i = 1; i <= 2; i++) { await askThenLeave(busy, i); await askThenLeave(idle, i); }
    expect(eventsOf(m.c, busy).some(e => e.kind === 'turnEnd'), 'busy 的回合应当还在跑').toBe(false);
    expect(auditOf(m.dataDir, 'permission.denied')).toEqual([]);

    // 第三次。busy：不弹卡、立即拒回（没计数的话这里会弹出第三张卡，一直挂到有人答复）
    const third = pipeRequest(m.bridgePipe!, CLIP(busy));
    let returned = false;
    third.then(() => { returned = true; }, () => { returned = true; });
    await waitFor('桥请求被拒回或弹了卡', () => returned || bridgeCards(busy).length === 3, 10000);
    expect(bridgeCards(busy).length, '请求方断开的桥卡没有计数：有 run 的会话还在弹桥卡').toBe(2);
    const env = await third;
    expect(env.error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'timeout' });
    expect(env.error!.message).toContain('这次没有再询问');
    expect(auditOf(m.dataDir, 'permission.denied').map(r => [r.sessionId, r.payload.req.kind, r.payload.outcome, r.payload.origin])).toEqual([
      [busy, 'bridge-clipboard-read', { decision: 'deny', reason: 'timeout', cause: 'unattended' }, 'bridge'],
    ]);
    // idle：没有 run（用户在终端面板里手动跑的命令，按了 Ctrl+C），断开不计数，第三次照常弹卡
    const idleThird = pipeRequest(m.bridgePipe!, CLIP(idle));
    await waitFor('idle 的第三张桥卡', () => bridgeCards(idle).length === 3);
    await m.c.call('permission.respond', { requestId: bridgeCards(idle)[2].params.requestId, decision: 'deny' });
    expect((await idleThird).error).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'user-denied' });
    expect(auditOf(m.dataDir, 'permission.denied').filter(r => r.sessionId === idle)).toEqual([]);

    expect((await m.c.call('chat.cancel', { sessionId: busy })).error).toBeUndefined();
  }, 60000);
});
