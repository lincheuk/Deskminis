import { requestToolOutput } from './request-tool-output-fixture';
/**
 * F03 验收 1 / 3 / 4 的循环证据：真 runAgentLoop + 真 Provider 类 + 按上限校验的假端点（故障注入）。
 * 断言落在实际发出的请求体、事件序列、库里的行与工具的执行次数上。夹具见 overflow-recovery-fixture.ts。
 * 时序一律用闸门或端点脚本控制，没有 sleep；假端点命中超过 60 次直接抛错（无限循环会变红，不会挂住）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelCatalog } from '../src/minisd/providers/model-catalog';
import type { ToolExecutor } from '../src/minisd/tools/types';
import type { RuntimeModelInput } from '../src/minisd/providers/runtime-model';
import { RECOVERY_LIMITS, type CompactMeta, type ContextRecoveryView, type RecoveryLimits } from '../src/shared/compaction';
import { CompactEngine } from '../src/minisd/agent/compact';
import { pngBytes } from './image-fixtures';
import { EXAMPLE_APIS } from './runtime-model-fixture';
import {
  ascii, bodyView, controlledSse, dumpForUi, echoTool, errorsOf, eventsOf, execLog, gate, kindsOf, markers, mkCatalog, mkCtx, openai, openaiOk, openaiToolCall, relay,
  relayUnknown, runLoop, scriptedSummarizer, snapshotRaw, strictEndpoint, type Body, type Ctx, type HitInfo, type SummarizerMode,
} from './overflow-recovery-fixture';

let dir: string;
let catalog: ModelCatalog;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-f03-loop-'));
  catalog = await mkCatalog(dir);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const TURN_END = { kind: 'turnEnd', stopReason: 'endTurn' };
const ok = (_b: Body, info: HitInfo): Response => openaiOk('ok', info.usage);
const phases = (events: Parameters<typeof eventsOf>[0]): string[] => eventsOf(events, 'contextRecovery').map(e => e.view.phase as string);
const toolOutputs = (body: Body): string[] => (body.messages as Body[]).filter(m => m.role === 'tool').map(m => requestToolOutput(m.content));
/** compact_marker_meta 各行的 meta（按写入顺序）。 */
const metasOf = (ctx: Ctx): CompactMeta[] => markers(ctx.db, ctx.sessionId).meta.map(r => JSON.parse(String(r.meta_json)) as CompactMeta);
/** n 轮 file_write（落库历史里的样子）：入参里的 content 有 chars 个字符——修剪与裁剪只动工具结果，动不了入参。 */
function writeRounds(ctx: Ctx, n: number, chars: number): void {
  for (let j = 1; j <= n; j++) ctx.call(`W${j}`, 'file_write', { path: `out/f${j}.md`, content: ascii(chars), tool_title: `write ${j}` }, `已写入 out/f${j}.md`);
}

/** 8 个文字回合约 25K token（64K 窗口的水位不到修剪档，没有预防性减压），最后一条是用户消息。 */
function textRounds(ctx: Ctx, rounds = 8): void {
  for (let i = 1; i <= rounds; i++) {
    ctx.say(`question ${i}: ${ascii(6_000)}`);
    if (i < rounds) ctx.reply(`answer ${i}: ${ascii(6_500)}`);
  }
}
/** 5 组长问答（约 15.6K token，可摘）+ 3 个短回合 + 末尾 n 轮工具（每条结果 chars 个字符）。 */
function mixedHistory(ctx: Ctx, toolRounds: number, chars: number): void {
  for (let i = 1; i <= 5; i++) { ctx.say(`question ${i}: ${ascii(6_000)}`); ctx.reply(`answer ${i}: ${ascii(6_500)}`); }
  ctx.say('short question 6'); ctx.reply('short answer 6');
  ctx.say('short question 7'); ctx.reply('short answer 7');
  ctx.say('now run the tools');
  ctx.rounds('T', Array.from({ length: toolRounds }, () => chars));
}
/** 每次执行计一次数的工具（kind：只读或有副作用）。 */
function countingTool(name: string, output: () => string, readOnly = true): { tool: ToolExecutor; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    tool: {
      definition: { name, description: name, parameters: { tool_title: { type: 'string', description: 't' } }, required: ['tool_title'] },
      scheduling: readOnly ? { readOnly: true, concurrencySafe: true, sideEffects: 'none' } : { readOnly: false, concurrencySafe: false, sideEffects: 'unknown' },
      async execute() { n++; return { output: output(), success: true }; },
    },
  };
}

describe('验收 1：没有更大窗口、首次请求超窗，压缩后同模型继续；次数有限', () => {
  it('R1 单槽位、资料窗口 64K、端点真实上限 24K：主请求 400 → 摘要 200 → 主请求 200，没有换模型也没有合成的「继续」', async () => {
    const ctx = mkCtx(dir);
    textRounds(ctx);
    const before = snapshotRaw(ctx.store, ctx.sessionId);
    const cfg = relay(64_000);
    const ep = strictEndpoint({ limit: 24_000, style: 'kimi', main: ok, summary: scriptedSummarizer('faithful') });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(ep.hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:400', 'summary:200', 'main:200']);
    expect(kindsOf(events).some(k => k.startsWith('fallback'))).toBe(false);
    expect(errorsOf(events)).toEqual([]);
    expect(events.at(-1)).toEqual(TURN_END);

    const first = bodyView(ep.hits[0].body); const resent = bodyView(ep.hits[2].body);
    // 重发的请求：第一条 user 消息是摘要消息，最后一条与原请求最后一条相同，没有新增的合成消息
    expect(resent.summary).toBeDefined();
    expect(resent.messages.at(-1)).toEqual(first.messages.at(-1));
    expect(resent.userText).not.toContain('继续');
    expect(resent.messages.length).toBeLessThan(first.messages.length);
    expect(resent.est + resent.maxTokens).toBeLessThanOrEqual(24_000);
    expect(resent.toolPairs).toEqual({ orphans: [], missing: [] });

    // 恢复说明：决定重发时一条、端点收下后一条，同一次事故、重发 1 次
    const rec = eventsOf(events, 'contextRecovery').map(e => e.view);
    expect(rec.map(v => v.phase)).toEqual(['resending', 'recovered']);
    expect(rec[1]).toMatchObject({ incident: rec[0].incident, resends: 1, rejections: 1 });
    expect(rec[1].seq).toBeGreaterThan(rec[0].seq);
    expect(rec[0].actions[0]).toMatchObject({ kind: 'ceiling', basis: 'hint' });
    expect(rec[0].actions.some((a: { kind: string; result?: string }) => a.kind === 'compact' && a.result === 'done')).toBe(true);
    expect(eventsOf(events, 'compacted')).toHaveLength(1);
    expect(eventsOf(events, 'compacted')[0].detail).toMatchObject({ v: 2, trigger: 'overflow', form: 'structured' });

    // 预算回调收到的对象与两次主请求的 max_tokens 各自相等（I4 / I5）
    expect(budgets).toHaveLength(2);
    expect(ep.hits[0].body.max_tokens).toBe(budgets[0].output.requested);
    expect(ep.hits[2].body.max_tokens).toBe(budgets[1].output.requested);
    expect(budgets[1].limits.rejectedAt).toBe(budgets[0].input.tokens);
    expect(budgets[1].status).not.toBe('over');

    // 原历史逐字节不变（新增的只有这一轮的 assistant 回复）；marker 与 meta 各一行
    const after = ctx.store.listMessages(ctx.sessionId);
    expect(JSON.stringify(after.slice(0, -1))).toBe(before);
    expect(after.at(-1)).toMatchObject({ role: 'assistant', parts: [{ type: 'text', value: 'ok' }] });
    const m = markers(ctx.db, ctx.sessionId);
    expect(m.markers).toHaveLength(1);
    expect(m.meta).toHaveLength(1);
  });

  it('R1b 报文不带数字、端点只校验输入：仍恢复成功，上限按步长定', async () => {
    const ctx = mkCtx(dir);
    textRounds(ctx);
    const cfg = relay(64_000);
    const ep = strictEndpoint({ limit: 20_000, counts: 'input', style: 'plain', main: ok, summary: scriptedSummarizer('faithful') });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(ep.mains().length).toBeLessThanOrEqual(3);
    expect(ep.mains().at(-1)?.status).toBe(200);
    expect(eventsOf(events, 'contextRecovery')[0].view.actions[0]).toMatchObject({ kind: 'ceiling', basis: 'step' });
    expect(phases(events).at(-1)).toBe('recovered');
  });

  it('R2 / R2b 窗口没有资料、手动最大输出 65,536：先收输出就能重发，不动历史；之后的轮次 max_tokens 停在 16,384，不提前修剪或压缩', async () => {
    const grow = countingTool('grow', () => ascii(8_000));
    const ctx = mkCtx(dir, { tools: [grow.tool] });
    ctx.say(`read this: ${ascii(144_000)}`);
    const cfg = relayUnknown({ maxOutputTokens: 65_536 });
    const ep = strictEndpoint({
      limit: 100_000, style: 'plain',
      main: (_b, info) => info.accepted < 5 ? openaiToolCall(`g${info.n}`, 'grow', { tool_title: 'grow' }, info.usage) : openaiOk('done', info.usage),
    });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(events.at(-1)).toEqual(TURN_END);
    expect(ep.hits[0].status).toBe(400);
    expect(ep.hits[0].body.max_tokens).toBe(65_536);
    // 重发：消息序列与第 1 次逐条相同，只有 max_tokens 收到 16,384
    expect(ep.hits[1].status).toBe(200);
    expect(ep.hits[1].body.max_tokens).toBe(16_384);
    expect(ep.hits[1].body.messages).toEqual(ep.hits[0].body.messages);
    expect(eventsOf(events, 'contextRecovery')[0].view.actions).toEqual([
      { kind: 'ceiling', basis: 'output-first', total: budgets[0].input.tokens + 65_536 - 1024, output: 16_384 },
    ]);
    // R2b：之后 5 个工具轮次（每轮输入涨约 2K）——端点再没有拒绝过，max_tokens 都是 16,384，没有修剪也没有压缩
    expect(ep.rejected()).toHaveLength(1);
    expect(ep.summaries()).toEqual([]);
    expect(ep.mains()).toHaveLength(7);
    expect(ep.mains().slice(1).map(h => h.body.max_tokens)).toEqual(Array.from({ length: 6 }, () => 16_384));
    expect(budgets.slice(1).map(b => b.status)).toEqual(Array.from({ length: 6 }, () => 'ok'));
    expect(budgets.at(-1)!.input.tokens).toBeGreaterThan(budgets[0].input.tokens + 9_000);
    expect(eventsOf(events, 'compacted')).toEqual([]);
    expect(eventsOf(events, 'pruned')).toEqual([]);
    expect(grow.calls()).toBe(5);
  });

  it('R3 端点对主请求恒回超窗：同一次事故至多重发 2 次，共 3 个主请求后报 contextFull，带恢复说明与接力草稿', async () => {
    const ctx = mkCtx(dir);
    mixedHistory(ctx, 6, 5_000);
    const cfg = relay(64_000);
    const ep = strictEndpoint({ limit: 1_000, style: 'plain', checkSummary: false, main: ok, summary: scriptedSummarizer('faithful') });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(ep.mains().map(h => h.status)).toEqual([400, 400, 400]);
    expect(eventsOf(events, 'compacted').length).toBeLessThanOrEqual(3);
    expect(ep.hits).toHaveLength(3 + ep.summaries().length);
    expect(ep.summaries().length).toBeGreaterThanOrEqual(1);
    const last = errorsOf(events).at(-1)!;
    expect(events.at(-1)).toBe(last);
    expect(last).toMatchObject({ code: 'contextFull', recovery: { phase: 'failed', stop: 'resendLimit', resends: 2, rejections: 3 } });
    expect(last.relayDraft).toContain('now run the tools');
    expect(phases(events)).toEqual(['resending', 'resending', 'failed']);
    // 每个重发的请求都比它前一次被拒的小（I8）
    const sizes = ep.mains().map(h => h.est);
    expect(sizes[1]).toBeLessThan(sizes[0] - 1024);
    expect(sizes[2]).toBeLessThan(sizes[1] - 1024);
  });

  it('R3c 每次运行处理的拒绝有上限：第 3 次拒绝直接放弃同槽，并说明是超过了上限（这次事故自己没有别的动作）', async () => {
    const grow = countingTool('grow', () => ascii(20_000), false);
    const ctx = mkCtx(dir, { tools: [grow.tool] });
    ctx.say('keep growing');
    const cfg = relayUnknown();
    // 三次各自可恢复的事故：第 8、11、14 个主请求被拒（端点报的上限是那次输入的八成）；被拒之后的重发都收下
    const rejectAt = new Set([8, 11, 14]);
    const ep = strictEndpoint({
      limit: 10_000_000, counts: 'input', style: 'anthropic',
      forceReject: ({ mainN, est }) => rejectAt.has(mainN) ? Math.floor(est * 0.8) : undefined,
      main: (_b, info) => openaiToolCall(`g${info.n}`, 'grow', { tool_title: 'grow' }, info.usage),
    });
    const { events } = await runLoop(ctx, catalog, {
      primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, extra: { recoveryLimits: { rejectionsPerRun: 2 } },
    });

    expect(ep.rejected().map(h => ep.mains().indexOf(h))).toEqual([8, 11, 14]);
    expect(ep.summaries()).toEqual([]);
    const views = eventsOf(events, 'contextRecovery').map(e => e.view);
    expect(views.filter(v => v.phase === 'resending')).toHaveLength(2);
    expect(views.filter(v => v.phase === 'recovered')).toHaveLength(2);
    const last = errorsOf(events).at(-1)!;
    expect(events.at(-1)).toBe(last);
    expect(last.code).toBe('contextFull');
    expect(last.recovery).toMatchObject({ phase: 'failed', stop: 'runLimit', runRejections: 3, resends: 0, limits: { rejectionsPerRun: 2 } });
    expect(last.recovery!.actions.map(a => a.kind)).toEqual(['ceiling']);
    expect(views.at(-1)).toEqual(last.recovery);
    // 被拒之后没有再执行任何工具：执行次数 = 被收下的主请求数
    expect(grow.calls()).toBe(ep.mains().filter(h => h.status === 200).length);
  });

  it('R4 / R4b 链上有同样大的、或更大窗口的备用：主槽位能恢复就不换模型，备用一次请求都没有', async () => {
    for (const backupWindow of [64_000, 1_000_000]) {
      const ctx = mkCtx(dir);
      textRounds(ctx);
      const cfg = relay(64_000); const bcfg = relay(backupWindow, { id: 'inst-backup' });
      const ep = strictEndpoint({ limit: 24_000, style: 'kimi', main: ok, summary: scriptedSummarizer('faithful') });
      const backup = strictEndpoint({ limit: 10_000_000, main: ok });
      const { events } = await runLoop(ctx, catalog, {
        primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, fallback: [{ provider: openai(bcfg, backup.fetchImpl), input: bcfg }],
      });
      expect(events.at(-1)).toEqual(TURN_END);
      expect(backup.hits).toEqual([]);
      expect(kindsOf(events).some(k => k.startsWith('fallback'))).toBe(false);
      expect(phases(events)).toEqual(['resending', 'recovered']);
    }
  });

  it('R4c 主槽位恒拒、链上有更大窗口的备用：同槽恢复用尽后才换；备用收到的是没有为小窗口裁过的请求', async () => {
    const ctx = mkCtx(dir);
    mixedHistory(ctx, 6, 5_000);
    const cfg = relay(64_000); const bcfg = relay(1_000_000, { id: 'inst-big' });
    const ep = strictEndpoint({ limit: 1_000, style: 'plain', checkSummary: false, main: ok, summary: scriptedSummarizer('faithful') });
    const backup = strictEndpoint({ limit: 10_000_000, main: ok });
    const { events } = await runLoop(ctx, catalog, {
      primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, fallback: [{ provider: openai(bcfg, backup.fetchImpl), input: bcfg }],
    });
    expect(ep.mains().map(h => h.status)).toEqual([400, 400, 400]);
    expect(events.filter(e => e.kind === 'fallback')).toEqual([{ kind: 'fallback', from: '主力', to: '备用1', reason: '上下文已满', cause: 'contextOverflow' }]);
    expect(phases(events).at(-1)).toBe('switched');
    expect(eventsOf(events, 'contextRecovery').at(-1)!.view).toMatchObject({ stop: 'resendLimit', switchedTo: '备用1' });
    expect(events.at(-1)).toEqual(TURN_END);
    // 备用只收到一个请求：工具结果都是原文（主槽位上做过的第 2 级修剪没有带过来）
    expect(backup.hits).toHaveLength(1);
    expect(toolOutputs(backup.hits[0].body)).toEqual(Array.from({ length: 6 }, () => ascii(5_000)));
    expect(bodyView(backup.hits[0].body).toolPairs).toEqual({ orphans: [], missing: [] });
  });

  it('R11 没接水位与压缩的调用方：请求次数与事件序列同 F03 之前（1 次请求加 contextFull）', async () => {
    const ctx = mkCtx(dir);
    textRounds(ctx);
    const cfg = relay(64_000);
    const ep = strictEndpoint({ limit: 24_000, style: 'kimi', main: ok });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, context: false });
    expect(ep.hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:400']);
    expect(kindsOf(events)).toEqual(['error:contextFull']);
    expect('recovery' in errorsOf(events)[0]).toBe(false);
    // 没有 runtime 的槽位（旧调用方）同样走原有分支
    const legacy = mkCtx(dir);
    textRounds(legacy);
    const ep2 = strictEndpoint({ limit: 24_000, style: 'kimi', main: ok });
    const r2 = await runLoop(legacy, catalog, { primary: { provider: openai(cfg, ep2.fetchImpl) } });
    expect(ep2.hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:400']);
    expect(kindsOf(r2.events)).toEqual(['error:contextFull']);
  });

  it('R13 固定开销占满手动窗口：不为它发付费的摘要请求，报 requestBudget，不给接力草稿，也没有恢复说明', async () => {
    const ctx = mkCtx(dir);
    ctx.say('hi');
    // 8 轮工具（每条结果 3,000 字符）：最早的两条在最近 12 条之外，轮首的预防性修剪会修掉它们——之后再没有恢复能做的本地动作
    ctx.rounds('T', Array.from({ length: 8 }, () => 3_000));
    const cfg = relay(32_000);
    const ep = strictEndpoint({ limit: 32_000, style: 'kimi', main: ok, summary: scriptedSummarizer('faithful') });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, systemPrompt: ascii(176_000) });
    expect(ep.hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:400']);
    // 被拒之后直接按固定开销收尾：不回轮首再修剪一遍，也不发恢复说明
    expect(kindsOf(events)).toEqual(['pruned', 'error:requestBudget']);
    const last = errorsOf(events)[0];
    expect(last.budget).toEqual(budgets[0]);
    expect(last.budget!.limits.rejectedAt).toBeUndefined();
    expect('relayDraft' in last).toBe(false);
    expect('recovery' in last).toBe(false);
  });

  it('R16 资料上限不可信的两种起点（窗口没有资料；目录窗口已被实测推翻）：学到的上限只由报文数字定，修剪后同模型重发，不与 128K 取小', async () => {
    // 一个用户回合、23 条（不足 30 条，标准压缩做不成）。请求约 177K：用户消息约 125K（裁不了），5 条 40,000 字符的旧结果约 50K（最近 12 条之外，
    // 第 1 级修剪能修掉），最近 6 轮都是小结果。端点真实输入上限 160K，报文带数字：修剪后约 127K，放得下
    const cases: { name: string; cfg: RuntimeModelInput; observed?: number }[] = [
      { name: '窗口没有资料', cfg: relayUnknown() },
      { name: '目录窗口 128K、历史里有实测输入 140K 的成功记录', cfg: { id: 'inst-reason', kind: 'openai-compat', baseUrl: EXAMPLE_APIS.vendorA, modelId: 'reason-model' }, observed: 140_000 },
    ];
    for (const { name, cfg, observed } of cases) {
      const ctx = mkCtx(dir);
      ctx.say(`analyze this dump: ${ascii(500_000)}`);
      for (let j = 1; j <= 5; j++) {
        // 第二种起点：第一轮的 assistant 消息带着同一配置实例上的实测 usage（F02 口径），输入 140K 已超过目录的 128K
        ctx.add('assistant', [{ type: 'toolUse', value: { toolUseId: `O${j}`, name: 'echo', input: JSON.stringify({ text: `o${j}`, tool_title: 't' }) } }],
          j === 1 && observed !== undefined
            ? { tokenUsage: { inputTokens: observed, outputTokens: 20, v: 2, source: { by: 'provider', protocol: 'openai-chat', modelId: cfg.modelId, instanceId: cfg.id } } }
            : {});
        ctx.add('user', [{ type: 'toolResult', value: { toolUseId: `O${j}`, output: ascii(40_000), success: true, status: 'success' } }]);
      }
      ctx.rounds('N', Array.from({ length: 6 }, () => 300));
      expect(ctx.store.listMessages(ctx.sessionId), name).toHaveLength(23);
      const before = snapshotRaw(ctx.store, ctx.sessionId);
      const ep = strictEndpoint({ limit: 160_000, counts: 'input', style: 'anthropic', main: ok });
      const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

      expect(ep.hits.map(h => `${h.kind}:${h.status}`), name).toEqual(['main:400', 'main:200']);
      expect(errorsOf(events), name).toEqual([]);
      expect(events.at(-1), name).toEqual(TURN_END);
      expect(phases(events), name).toEqual(['resending', 'recovered']);
      // 被拒的那次：预算不据资料上限判（第一种没有资料；第二种已被实测推翻），所以原样发了出去
      expect(budgets[0].limits.windowKnown, name).toBe(false);
      expect(budgets[0].limits.inputLimit, name).toBe(128_000);
      if (observed !== undefined) expect(budgets[0].limits.observedAbove, name).toBe(observed);
      expect(budgets[0].input.tokens, name).toBeGreaterThan(170_000);
      // 重发的那次：上限由报文数字换算（160K 留 5%），不是 128K；带着被拒那次的输入估计
      expect(budgets[1].limits.rejectedAt, name).toBe(budgets[0].input.tokens);
      expect(budgets[1].limits.inputLimit, name).toBeGreaterThan(140_000);
      expect(budgets[1].limits.inputLimit, name).toBeLessThan(160_000);
      expect(budgets[1].status, name).toBe('ok');
      // 只做了第 1 级修剪：5 条旧结果换成桩，没有压缩，也没有裁到最近的结果
      const view = eventsOf(events, 'contextRecovery')[0].view;
      expect(view.actions, name).toEqual([
        { kind: 'ceiling', basis: 'hint', input: budgets[1].limits.inputLimit }, { kind: 'trim', level: 1, pruned: 5, clipped: 0 },
      ]);
      expect(ep.summaries(), name).toEqual([]);
      const outs = toolOutputs(ep.hits[1].body);
      expect(outs.slice(0, 5).every(o => o.startsWith('[工具结果已修剪：原 40000 字符')), name).toBe(true);
      expect(outs.slice(5), name).toEqual(Array.from({ length: 6 }, () => ascii(300)));
      // 修剪后的输入比 128K 小不了多少：与回退值或被推翻的目录值取小的话，它加上余量仍判 over，整轮以 noProgress 收场
      expect(budgets[1].input.tokens, name).toBeGreaterThan(120_000);
      expect(budgets[1].input.tokens + budgets[1].safetyMargin, name).toBeGreaterThan(128_000);
      expect(JSON.stringify(ctx.store.listMessages(ctx.sessionId).slice(0, -1)), name).toBe(before);
    }
  });

  it('R16b 固定开销只按资料上限判，不按学到的上限判：窗口没有资料时报 contextFull 给接力草稿；手动窗口放不下时才报 requestBudget', async () => {
    const run = async (cfg: ReturnType<typeof relay>, grownChars: number) => {
      let grown = false;
      const expand: ToolExecutor = {
        definition: { name: 'expand', description: 'expand', parameters: { tool_title: { type: 'string', description: 't' } }, required: ['tool_title'] },
        scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none' },
        // 执行之后系统提示变大（模拟运行中多连上一台 MCP 服务器）
        async execute() { grown = true; return { output: 'expanded', success: true }; },
      };
      const ctx = mkCtx(dir, { tools: [expand, echoTool] });
      ctx.say('look at the log');
      ctx.rounds('T', [80_000]);
      // 第 1 个主请求被拒（不带数字）→ 裁剪后重发成功 → 调 expand → 系统提示涨到占满上限 → 第 3 个主请求再被拒
      const ep = strictEndpoint({
        limit: 10_000_000, counts: 'input', style: 'plain',
        forceReject: ({ mainN }) => (mainN === 0 || mainN === 2 ? 1 : undefined),
        main: (_b, info) => openaiToolCall(`x${info.n}`, 'expand', { tool_title: 'expand' }, info.usage),
      });
      const r = await runLoop(ctx, catalog, {
        primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, systemPrompt: () => ascii(grown ? grownChars : 80_000),
      });
      return { ...r, ep };
    };
    // 窗口没有资料：学到的上限约 30K（步长），系统提示涨到约 31K 也不下「固定开销占满」的结论
    const unknown = await run(relayUnknown(), 124_000);
    expect(unknown.ep.mains().map(h => h.status)).toEqual([400, 200, 400]);
    const a = errorsOf(unknown.events).at(-1)!;
    expect(a.code).toBe('contextFull');
    expect(a.relayDraft).toContain('look at the log');
    expect('budget' in a).toBe(false);
    // 对照：手动窗口 32K、系统提示自己就占满它 → requestBudget；说明里的数字出自资料上限，不是学到的那个
    const manual = await run(relay(32_000), 124_000);
    const b = errorsOf(manual.events).at(-1)!;
    expect(b.code).toBe('requestBudget');
    expect('relayDraft' in b).toBe(false);
    expect(b.budget!.limits).toMatchObject({ inputLimit: 32_000, authority: 'manual' });
    expect(b.budget!.limits.rejectedAt).toBeUndefined();
  });

  it('R14 靠压缩恢复之后同一次运行再跑三个工具轮次：端点没有再拒绝，后续预算带着学到的上限，每个工具只执行一次', async () => {
    const probe = countingTool('probe', () => 'probe ok');
    const ctx = mkCtx(dir, { tools: [probe.tool] });
    textRounds(ctx);
    const cfg = relay(64_000);
    const ep = strictEndpoint({
      limit: 24_000, style: 'kimi', summary: scriptedSummarizer('faithful'),
      main: (_b, info) => info.accepted < 3 ? openaiToolCall(`p${info.n}`, 'probe', { tool_title: 'probe' }, info.usage) : openaiOk('done', info.usage),
    });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(ep.rejected()).toHaveLength(1);
    expect(ep.mains().map(h => h.status)).toEqual([400, 200, 200, 200, 200]);
    expect(budgets.slice(1).every(b => b.limits.rejectedAt !== undefined && b.limits.authority === 'advisory')).toBe(true);
    expect(probe.calls()).toBe(3);
    expect(phases(events)).toEqual(['resending', 'recovered']);
  });

  it('R17 校准系数在运行中变化（端点的计数是本机估算的 1.5 倍）：学到的上限跟着换算，恢复后的轮次不因此多出裁剪或压缩', async () => {
    const probe = countingTool('probe', () => 'probe ok');
    const ctx = mkCtx(dir, { tools: [probe.tool, echoTool] });
    ctx.say('go through the logs');
    ctx.rounds('T', Array.from({ length: 10 }, () => 8_000));
    const cfg = relayUnknown();
    const ep = strictEndpoint({
      limit: 24_000, counts: 'input', style: 'anthropic', scale: 1.5,
      main: (_b, info) => info.accepted < 3 ? openaiToolCall(`p${info.n}`, 'probe', { tool_title: 'probe' }, info.usage) : openaiOk('done', info.usage),
    });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(events.at(-1)).toEqual(TURN_END);
    // 新会话第一轮被拒（还没有校准，系数 1），靠第 1 级修剪恢复
    expect(ep.mains().map(h => h.status)).toEqual([400, 200, 200, 200, 200]);
    expect(budgets).toHaveLength(5);
    expect(budgets[1].input.calibration.ratio).toBe(1);
    const learned = budgets[1].limits.inputLimit;
    expect(budgets[1].limits.rejectedAt).toBe(budgets[0].input.tokens);
    // 恢复后的那次成功响应带回了 usage：之后的轮次系数约 1.5，学到的上限按同一个系数换算
    for (const b of budgets.slice(2)) {
      const ratio = b.input.calibration.ratio;
      expect(ratio).toBeGreaterThan(1.3); expect(ratio).toBeLessThan(1.7);
      expect(Math.abs(b.limits.inputLimit - Math.floor(learned * ratio))).toBeLessThanOrEqual(1);
      expect(b.status).not.toBe('over');
    }
    // 估算放大了 1.5 倍而上限不动的话，后面的轮次会判 over，多出 2 / 3 级裁剪或付费的压缩
    expect(eventsOf(events, 'compacted')).toEqual([]);
    expect(ep.summaries()).toEqual([]);
    expect(eventsOf(events, 'pruned').filter(e => e.level !== undefined)).toEqual([]);
    expect(probe.calls()).toBe(3);
  });

  it('R12 重发时端点回 500：走原有的重试梯，不计入超窗重发次数；成功后报已恢复', async () => {
    const ctx = mkCtx(dir);
    textRounds(ctx);
    const cfg = relay(64_000);
    let failed = false;
    const ep = strictEndpoint({
      limit: 24_000, style: 'kimi', summary: scriptedSummarizer('faithful'),
      main: (_b, info) => {
        if (!failed) { failed = true; return new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), { status: 500 }); }
        return openaiOk('ok', info.usage);
      },
    });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(ep.hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:400', 'summary:200', 'main:500', 'main:200']);
    expect(kindsOf(events).filter(k => k === 'retry')).toHaveLength(1);
    expect(eventsOf(events, 'contextRecovery').map(e => [e.view.phase, e.view.resends])).toEqual([['resending', 1], ['recovered', 1]]);
    expect(events.at(-1)).toEqual(TURN_END);
  });

  it('R18 带空响应提醒的那一轮被端点以超窗拒绝：回轮首重走不丢提醒，恢复后重发的请求仍以它收尾；视图里的两项上限是缺省值', async () => {
    const REMINDER = '[系统提醒: 上一次工具调用后你返回了空响应，请继续]';
    // 15,000 字符：不到卸载阈值（原文落库），第 3 级裁剪能裁
    const grow = countingTool('grow', () => ascii(15_000), false);
    const ctx = mkCtx(dir, { tools: [grow.tool] });
    ctx.say('grow once, then answer');
    const cfg = relayUnknown();
    // 主请求 0：发工具调用；1：空响应（没有正文也没有工具调用）→ 下一轮的请求带提醒；2：带提醒的那一轮被端点拒绝；3：恢复后的重发
    const ep = strictEndpoint({
      limit: 10_000_000, counts: 'input', style: 'anthropic',
      forceReject: ({ mainN, est }) => mainN === 2 ? Math.floor(est * 0.8) : undefined,
      main: (_b, info) => info.mainN === 0 ? openaiToolCall('g0', 'grow', { tool_title: 'grow' }, info.usage)
        : info.mainN === 1 ? openaiOk('', info.usage)
        : openaiOk('done', info.usage),
    });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(ep.hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:200', 'main:200', 'main:400', 'main:200']);
    const reminders = (body: Body): number => (body.messages as Body[]).filter(m => m.role === 'user' && m.content === REMINDER).length;
    const lastOf = (body: Body): Body => (body.messages as Body[]).at(-1)!;
    // 空响应之前的两次请求没有提醒；被拒的那次带着它
    expect(ep.mains().slice(0, 2).map(h => reminders(h.body))).toEqual([0, 0]);
    expect(lastOf(ep.mains()[2].body)).toEqual({ role: 'user', content: REMINDER });
    // 恢复（第 3 级裁剪）后重发的请求：提醒还在、仍是最后一条、只有一条——提醒在被拒的那次请求之前已经清掉，回轮首重走时要还原
    expect(eventsOf(events, 'pruned').at(-1)).toMatchObject({ level: 3, clipped: 1 });
    expect(lastOf(ep.mains()[3].body)).toEqual({ role: 'user', content: REMINDER });
    expect(reminders(ep.mains()[3].body)).toBe(1);
    expect(phases(events)).toEqual(['resending', 'recovered']);
    expect(errorsOf(events)).toEqual([]);
    expect(events.at(-1)).toEqual(TURN_END);
    // 恢复过程中工具没有重跑；提醒只在请求里，不落库
    expect(grow.calls()).toBe(1);
    expect(snapshotRaw(ctx.store, ctx.sessionId)).not.toContain('返回了空响应');
    // 没有给 recoveryLimits：视图里带的是缺省上限（每次事故重发 2 次、每次运行处理 6 次拒绝）
    expect(eventsOf(events, 'contextRecovery').map(e => e.view.limits)).toEqual([
      { resendsPerIncident: 2, rejectionsPerRun: 6 }, { resendsPerIncident: 2, rejectionsPerRun: 6 },
    ]);
  });
});

describe('验收 2（循环级）：恢复里的摘要失败时不写 marker，恢复接着走裁剪', () => {
  /** 5 组长问答 + 3 个短回合 + 末尾两条 40,000 字符的结果（在最近 4 条里：修剪动不了，第 3 级裁剪能裁）。 */
  const scenario = (): Ctx => { const ctx = mkCtx(dir); mixedHistory(ctx, 2, 40_000); return ctx; };
  const cases: [string, SummarizerMode, string][] = [
    ['L1', 'refusal', 'refusal'], ['L2', 'empty', 'empty'], ['L3', 'truncated', 'truncated'], ['L4', 'malformed-partial', 'malformed'],
    ['L5', 'prose', 'malformed'], ['TO1 / S6', 'error500', 'error'],
  ];
  for (const [name, mode, reason] of cases) {
    it(`${name} 摘要是 ${mode}：compactFailed(${reason}) 恰 1 条，摘要请求恰 1 次，没有 marker，裁剪后同模型重发成功`, async () => {
      const ctx = scenario();
      const before = snapshotRaw(ctx.store, ctx.sessionId);
      const cfg = relay(64_000);
      const ep = strictEndpoint({ limit: 30_000, style: 'kimi', main: ok, summary: scriptedSummarizer(mode), checkSummary: false });
      const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

      const failed = eventsOf(events, 'compactFailed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ reason, trigger: 'overflow' });
      expect(ep.summaries()).toHaveLength(1);
      expect(markers(ctx.db, ctx.sessionId)).toEqual({ markers: [], meta: [] });
      expect(eventsOf(events, 'compacted')).toEqual([]);
      // 恢复继续：最近两条大结果裁成头尾后重发成功；本次运行不再发摘要请求
      expect(ep.mains().map(h => h.status)).toEqual([400, 200]);
      expect(eventsOf(events, 'pruned').at(-1)).toMatchObject({ level: 3, clipped: 2 });
      expect(events.at(-1)).toEqual(TURN_END);
      const view = eventsOf(events, 'contextRecovery').at(-1)!.view;
      expect(view.phase).toBe('recovered');
      expect(view.actions).toContainEqual({ kind: 'compact', result: 'failed', reason });
      expect(JSON.stringify(ctx.store.listMessages(ctx.sessionId).slice(0, -1))).toBe(before);
    });
  }

  it('L5（先有 M1）恢复里的摘要是没有小节的自由文本：compactFailed(malformed) 恰 1 条，M1 与它的 meta 原样，裁剪后同模型重发成功', async () => {
    const ctx = mkCtx(dir);
    for (let i = 1; i <= 5; i++) { ctx.say(`question ${i}: ${ascii(6_000)}`); ctx.reply(`answer ${i}: ${ascii(6_500)}`); }
    // 先有一条有效的结构化 marker M1：盖住前两组问答
    const sum = strictEndpoint({ limit: 10_000_000, main: ok, summary: scriptedSummarizer('faithful') });
    const engine = new CompactEngine(ctx.store);
    const m1 = await engine.summarize(ctx.store.listMessages(ctx.sessionId), ctx.sessionId, openai(relay(1_000_000), sum.fetchImpl));
    expect(m1?.meta).toMatchObject({ model: { form: 'structured' }, coverage: { messageCount: 4 } });
    ctx.say('short question 6'); ctx.reply('short answer 6');
    ctx.say('short question 7'); ctx.reply('short answer 7');
    ctx.say('now run the tools');
    ctx.rounds('T', [40_000, 40_000]);
    const before = snapshotRaw(ctx.store, ctx.sessionId);
    const rows = markers(ctx.db, ctx.sessionId);
    const effBefore = engine.buildEffectiveHistory(ctx.store.listMessages(ctx.sessionId), ctx.store.getLatestCompactMarker(ctx.sessionId));

    const cfg = relay(64_000);
    const ep = strictEndpoint({ limit: 30_000, style: 'kimi', main: ok, summary: scriptedSummarizer('prose'), checkSummary: false });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    const failed = eventsOf(events, 'compactFailed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ reason: 'malformed', trigger: 'overflow' });
    // 那一个摘要请求带着 M1 的文本作既有摘要（增量紧接 M1 的锚点），回来的是自由文本：不收
    expect(ep.summaries()).toHaveLength(1);
    expect(String((ep.summaries()[0].body.messages as Body[])[1].content)).toContain(`【既有摘要】\n${m1!.summary}\n`);
    expect(eventsOf(events, 'compacted')).toEqual([]);
    // M1 仍是最新的有效 marker，两张表的行不变；原历史逐字节不变；有效历史与失败前相同
    expect(markers(ctx.db, ctx.sessionId)).toEqual(rows);
    expect(ctx.store.getLatestCompactMarker(ctx.sessionId)).toEqual(m1);
    const after = ctx.store.listMessages(ctx.sessionId);
    expect(JSON.stringify(after.slice(0, -1))).toBe(before);
    expect(engine.buildEffectiveHistory(after.slice(0, -1), ctx.store.getLatestCompactMarker(ctx.sessionId))).toEqual(effBefore);
    // 恢复继续：最近两条大结果裁成头尾后重发成功；重发的请求仍以 M1 的摘要开头
    expect(ep.mains().map(h => h.status)).toEqual([400, 200]);
    expect(eventsOf(events, 'pruned').at(-1)).toMatchObject({ level: 3, clipped: 2 });
    expect(events.at(-1)).toEqual(TURN_END);
    const view = eventsOf(events, 'contextRecovery').at(-1)!.view;
    expect(view.phase).toBe('recovered');
    expect(view.actions).toContainEqual({ kind: 'compact', result: 'failed', reason: 'malformed' });
    const resent = bodyView(ep.mains()[1].body);
    expect(resent.summary!.model).toBe(m1!.summary);
    expect(resent.summary!.record).toBeDefined();
  });
});

describe('验收 3：巨大工具结果', () => {
  it('K4 单回合、不足 30 条、最近 4 条里有一条 160,000 字符的结果、手动窗口 32K：裁成头尾后同模型重发，不压缩、不写回存储', async () => {
    const ctx = mkCtx(dir);
    ctx.say('summarize the log');
    ctx.rounds('T', [160_000]);
    const before = snapshotRaw(ctx.store, ctx.sessionId);
    const cfg = relay(32_000);
    const ep = strictEndpoint({ limit: 32_000, style: 'kimi', main: ok });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    dumpForUi('k4', { events: events.filter(e => e.kind !== 'textDelta'), budget: budgets.at(-1) });

    expect(ep.hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:400', 'main:200']);
    expect(eventsOf(events, 'compacted')).toEqual([]);
    expect(errorsOf(events)).toEqual([]);
    expect(events.at(-1)).toEqual(TURN_END);
    expect(eventsOf(events, 'pruned').at(-1)).toMatchObject({ kind: 'pruned', level: 3, clipped: 1 });

    // 重发的请求体里那条结果是「头 + 说明 + 尾」，说明里的原长等于真实长度
    const out = String(bodyView(ep.hits[1].body).pairs[0].output);
    const full = ascii(160_000);
    expect(out.length).toBeLessThan(5_000);
    expect(out.startsWith(full.slice(0, 3_000))).toBe(true);
    expect(out.endsWith(full.slice(-1_000))).toBe(true);
    expect(out).toContain('原 160000 字符');
    expect(bodyView(ep.hits[1].body).toolPairs).toEqual({ orphans: [], missing: [] });

    // 存储不动：那条结果仍是全文，success / status 原样
    const after = ctx.store.listMessages(ctx.sessionId);
    expect(JSON.stringify(after.slice(0, -1))).toBe(before);
    expect(after[2].parts[0]).toEqual({ type: 'toolResult', value: { toolUseId: 'T1', output: full, success: true, status: 'success' } });
    expect(markers(ctx.db, ctx.sessionId).markers).toEqual([]);
    expect(phases(events)).toEqual(['resending', 'recovered']);
  });

  it('K3b（循环级）被摘要盖住的纯图片用户消息仍算当前轮的图片：不收图片的槽位整轮不接、一次请求不发；收图片的槽位请求体里有图片块', async () => {
    const ctx = mkCtx(dir);
    ctx.add('user', [ctx.file('shot.png', pngBytes(800, 600))]);
    ctx.rounds('P', Array.from({ length: 20 }, () => 300));
    // 先写下一条盖住那条图片消息的 marker（单回合 41 条：按 length − 15 取锚点）
    const sum = strictEndpoint({ limit: 10_000_000, main: ok, summary: scriptedSummarizer('faithful') });
    const marker = await new CompactEngine(ctx.store).summarize(ctx.store.listMessages(ctx.sessionId), ctx.sessionId, openai(relay(1_000_000), sum.fetchImpl));
    expect(marker?.meta?.coverage.rule).toBe('recent-messages');

    const blind = relay(64_000, { capabilityOverrides: { imageInput: false } });
    const ep = strictEndpoint({ limit: 10_000_000, main: ok });
    const r = await runLoop(ctx, catalog, { primary: { provider: openai(blind, ep.fetchImpl), input: blind } });
    expect(ep.hits).toEqual([]);
    expect(errorsOf(r.events).at(-1)).toMatchObject({ code: 'capability' });

    const seeing = relay(64_000, { capabilityOverrides: { imageInput: true } });
    const ep2 = strictEndpoint({ limit: 10_000_000, main: ok });
    const r2 = await runLoop(ctx, catalog, { primary: { provider: openai(seeing, ep2.fetchImpl), input: seeing } });
    expect(r2.events.at(-1)).toEqual(TURN_END);
    const view = bodyView(ep2.hits[0].body);
    expect(view.images[0]).toBe(1);
    expect(view.summary!.carried?.quotes).toEqual(['[图片 shot.png]']);
    expect(view.summary!.record).toBeDefined();
  });

  it('K3d 循环级：压缩之后用户又发了两条消息——主模型回答的是新消息，不把随摘要带上的旧指示当成这一轮重做；图片按轮老化；marker 与 meta 的行不变', async () => {
    const look = countingTool('look_at_image', () => 'the picture is a bar chart');
    const ctx = mkCtx(dir, { tools: [look.tool, echoTool] });
    ctx.add('user', [ctx.file('shot.png', pngBytes(800, 600))]);
    ctx.rounds('P', Array.from({ length: 20 }, () => 300));
    const sum = strictEndpoint({ limit: 10_000_000, main: ok, summary: scriptedSummarizer('faithful') });
    await new CompactEngine(ctx.store).summarize(ctx.store.listMessages(ctx.sessionId), ctx.sessionId, openai(relay(1_000_000), sum.fetchImpl));
    const rows = markers(ctx.db, ctx.sessionId);
    expect(rows.markers).toHaveLength(1);

    const CURRENT = '最后一条就是当前这一轮的用户指示。';
    const LATER = '之后用户又发了新消息（见下文），有出入时以新消息为准。';
    // 主模型的脚本，下一步只由请求体决定：摘要消息说被带上的那条就是当前这一轮、而这一轮还没看过图 → 去看图（调一次工具）；
    // 看过了就答图；否则回答最后一条用户消息
    const ep = strictEndpoint({
      limit: 10_000_000,
      main: (body, info) => {
        const v = bodyView(body);
        const lastUserAt = v.messages.map(m => m.role).lastIndexOf('user');
        const looked = v.pairs.some(p => p.name === 'look_at_image' && p.index > lastUserAt && p.output !== undefined);
        if (v.summary?.carried?.closing === CURRENT && !looked) return openaiToolCall(`look_${info.n}`, 'look_at_image', { tool_title: 'look at the picture' }, info.usage);
        return openaiOk(looked ? 'it is a bar chart' : `answer to: ${String(v.messages[lastUserAt].content)}`, info.usage);
      },
    });
    const cfg = relay(64_000, { capabilityOverrides: { imageInput: true } });
    const run = () => runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    const lastReply = (): unknown => ctx.store.listMessages(ctx.sessionId).at(-1)!.parts[0].value;

    // 第 0 轮：那条纯图片消息就是当前这一轮——看一次图，回答
    expect((await run()).events.at(-1)).toEqual(TURN_END);
    expect(bodyView(ep.mains()[0].body).summary!.carried).toMatchObject({ quotes: ['[图片 shot.png]'], closing: CURRENT });
    expect(look.calls()).toBe(1);
    expect(lastReply()).toBe('it is a bar chart');

    // 第 1 条新消息：收尾句改成「以新消息为准」，图片仍随摘要消息发（上一轮的图）；模型回答新消息，没有再去看图
    ctx.say('new question one');
    let from = ep.mains().length;
    expect((await run()).events.at(-1)).toEqual(TURN_END);
    expect(ep.mains()).toHaveLength(from + 1);
    let view = bodyView(ep.mains()[from].body);
    expect(view.summary!.carried!.closing).toBe(LATER);
    expect(view.summary!.text).not.toContain('当前这一轮');
    expect(view.images[0]).toBe(1);
    expect(view.images.slice(1).every(n => n === 0)).toBe(true);
    expect(view.messages.at(-1)).toEqual({ role: 'user', content: 'new question one' });
    expect(lastReply()).toBe('answer to: new question one');
    expect(look.calls()).toBe(1);

    // 第 2 条新消息：图片换成占位文字（最近两轮之外）；仍然回答新消息
    ctx.say('new question two');
    from = ep.mains().length;
    expect((await run()).events.at(-1)).toEqual(TURN_END);
    expect(ep.mains()).toHaveLength(from + 1);
    view = bodyView(ep.mains()[from].body);
    expect(view.images.every(n => n === 0)).toBe(true);
    expect(view.summary!.text).toContain('[图片 shot.png 已随上下文省略]');
    expect(view.summary!.carried!.closing).toBe(LATER);
    expect(lastReply()).toBe('answer to: new question two');
    expect(look.calls()).toBe(1);
    expect(markers(ctx.db, ctx.sessionId)).toEqual(rows);
  });

  it('K4b 接 K4：恢复后再跑 6 个工具轮次——被拒过的槽位轮首就按学到的上限裁剪，端点没有再拒绝', async () => {
    const probe = countingTool('probe', () => 'probe ok');
    const ctx = mkCtx(dir, { tools: [probe.tool, echoTool] });
    ctx.say('summarize the log');
    ctx.rounds('T', [160_000]);
    const cfg = relay(32_000);
    const ep = strictEndpoint({
      limit: 32_000, style: 'kimi',
      main: (_b, info) => info.accepted < 6 ? openaiToolCall(`p${info.n}`, 'probe', { tool_title: 'probe' }, info.usage) : openaiOk('done', info.usage),
    });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(events.at(-1)).toEqual(TURN_END);
    expect(errorsOf(events)).toEqual([]);
    expect(ep.rejected()).toHaveLength(1);
    expect(ep.summaries()).toEqual([]);
    expect(ep.mains()).toHaveLength(8);
    // 后 7 个主请求里那条 16 万字符的结果都不是全文：先是「头 + 说明 + 尾」，滑出最近 4 条之后是修剪桩
    const shown = ep.mains().slice(1).map(h => String(bodyView(h.body).pairs[0].output));
    for (const s of shown) expect(s.length).toBeLessThan(5_000);
    expect(shown[0]).toContain('这里只保留开头与结尾');
    expect(shown.at(-1)).toContain('工具结果已修剪');
    expect(eventsOf(events, 'pruned').some(e => e.level === 3)).toBe(true);
    // 只有 K4 那一次事故的两条说明；每个工具调用只执行一次；落库的那条结果仍是全文
    expect(phases(events)).toEqual(['resending', 'recovered']);
    expect(probe.calls()).toBe(6);
    expect((ctx.store.listMessages(ctx.sessionId)[2].parts[0].value as { output: string }).output).toBe(ascii(160_000));
  });

  it('K4c 被裁剪的是有副作用的调用的结果：说明句不提「重新调用」，脚本不会把这次调用再执行一遍', async () => {
    const ledgerFile = join(dir, 'ledger.txt');
    const ledger: ToolExecutor = {
      definition: { name: 'ledger_post', description: 'post one entry', parameters: { tool_title: { type: 'string', description: 't' } }, required: ['tool_title'] },
      // 没有 scheduling 声明：按说不清会动什么处理（有副作用）
      async execute() { appendFileSync(ledgerFile, 'posted\n'); return { output: ascii(15_000), success: true }; },
    };
    const ctx = mkCtx(dir, { tools: [ledger] });
    ctx.say('post the entry');
    const cfg = relayUnknown();
    const ep = strictEndpoint({
      limit: 10_000_000, counts: 'input', style: 'anthropic',
      // 带着那条 15,000 字符结果的第 2 个主请求被拒，端点报的上限逼出第 3 级裁剪
      forceReject: ({ mainN }) => mainN === 1 ? 2_000 : undefined,
      main: (body, info) => {
        const last = toolOutputs(body).at(-1);
        // 脚本：还没调过就调一次；结果里出现「重新调用」就照说明把同一个调用再发一遍；否则收尾
        if (last === undefined || last.includes('重新调用')) return openaiToolCall(`l${info.n}`, 'ledger_post', { tool_title: 'post' }, info.usage);
        return openaiOk('posted', info.usage);
      },
    });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(events.at(-1)).toEqual(TURN_END);
    expect(ep.mains().map(h => h.status)).toEqual([200, 400, 200]);
    const clipped = toolOutputs(ep.mains()[2].body)[0];
    expect(clipped).toContain('不要为了查看省略部分重新执行这次调用');
    expect(clipped).not.toContain('重新调用');
    expect(clipped.startsWith(ascii(15_000).slice(0, 3_000))).toBe(true);
    expect(existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : '').toBe('posted\n');
  });
});

describe('验收 4：降级到小窗口、摘要请求自身超窗仍受预算约束；不无限压缩、不循环重试', () => {
  /** 6 组问答（每组约 2K token）+ 一个用户回合带 10 轮工具（每条结果 10,000 字符）：约 37K token。 */
  function fortyK(ctx: Ctx): void {
    for (let i = 1; i <= 6; i++) { ctx.say(`question ${i}: ${ascii(4_000)}`); ctx.reply(`answer ${i}: ${ascii(4_000)}`); }
    ctx.say('go through the logs');
    ctx.rounds('T', Array.from({ length: 10 }, () => 10_000));
  }
  const rateLimited = (): Response => new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429 });

  it('R5 主槽位限流、故障降级到手动窗口 32K 的备用：先按它的窗口减压再发，备用端点一次 400 都没回', async () => {
    const ctx = mkCtx(dir);
    fortyK(ctx);
    const big = relay(1_000_000); const small = relay(32_000, { id: 'inst-small' });
    const main = strictEndpoint({ limit: 10_000_000, main: rateLimited });
    const backup = strictEndpoint({ limit: 32_000, style: 'kimi', main: ok, summary: scriptedSummarizer('faithful') });
    const { events } = await runLoop(ctx, catalog, {
      primary: { provider: openai(big, main.fetchImpl), input: big }, fallback: [{ provider: openai(small, backup.fetchImpl), input: small }],
    });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(backup.rejected()).toEqual([]);
    expect(backup.hits.length).toBeGreaterThanOrEqual(2);
    for (const h of backup.hits) expect(h.est + Number(h.body.max_tokens)).toBeLessThanOrEqual(32_000);
    const kinds = kindsOf(events);
    expect(kinds.filter(k => k.startsWith('fallback'))).toEqual(['fallback:failure']);
    const at = kinds.indexOf('fallback:failure');
    expect(kinds.indexOf('pruned')).toBeGreaterThan(at);
    expect(kinds.indexOf('compacted')).toBeGreaterThan(at);
    expect(kinds.slice(0, at).some(k => k === 'pruned' || k === 'compacted')).toBe(false);
    // 这不是超窗事故：没有恢复说明
    expect(eventsOf(events, 'contextRecovery')).toEqual([]);
  });

  it('R5b 同上但历史很短：不回轮首，备用只收到 1 个请求，系统提示工厂对备用只调 1 次', async () => {
    const ctx = mkCtx(dir);
    ctx.say('hi');
    const big = relay(1_000_000); const small = relay(32_000, { id: 'inst-small', modelId: 'small-model' });
    const main = strictEndpoint({ limit: 10_000_000, main: rateLimited });
    const backup = strictEndpoint({ limit: 32_000, main: ok });
    const made: string[] = [];
    const { events } = await runLoop(ctx, catalog, {
      primary: { provider: openai(big, main.fetchImpl), input: big }, fallback: [{ provider: openai(small, backup.fetchImpl), input: small }],
      systemPrompt: c => { made.push(c.modelId); return 'sys'; },
    });
    expect(events.at(-1)).toEqual(TURN_END);
    expect(backup.hits).toHaveLength(1);
    expect(made.filter(m => m === 'small-model')).toHaveLength(1);
  });

  it('R6 摘要请求按学到的上限取材；自身超窗时取材减半再发一次（只此一次），写下的 marker 记着 2 次', async () => {
    const ctx = mkCtx(dir);
    textRounds(ctx);
    const cfg = relayUnknown();
    const ep = strictEndpoint({ limit: 20_000, counts: 'input', style: 'plain', main: ok, summary: scriptedSummarizer('faithful', { overflowFirst: 1 }) });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(events.at(-1)).toEqual(TURN_END);
    const sums = ep.summaries();
    // 第 1 个被摘要端点以超窗拒绝，减半后的第 2 个成功；减半后摘得少，回轮首重判时可以再压一次（次数受每次运行的上限约束）
    expect(sums.slice(0, 2).map(h => h.status)).toEqual([400, 200]);
    expect(sums.length).toBeLessThanOrEqual(3);
    // 第 1 个摘要请求的估算不超过学到的上限（不是按 128K 回退值的 0.6 取材）
    expect(sums[0].est).toBeLessThanOrEqual(budgets[1].limits.inputLimit);
    const blocks = (b: Body): number => (String((b.messages as Body[])[1].content).match(/^\[(用户|助手)\] /gm) ?? []).length;
    expect(blocks(sums[0].body)).toBeGreaterThanOrEqual(2);
    expect(blocks(sums[1].body)).toBeLessThanOrEqual(blocks(sums[0].body) / 2);
    const firstMeta = JSON.parse(String(markers(ctx.db, ctx.sessionId).meta[0].meta_json)) as { record: unknown };
    expect(firstMeta.record).toMatchObject({ trigger: 'overflow', request: { attempts: 2 } });
    expect(ep.mains().map(h => h.status)).toEqual([400, 200]);
  });

  it('R7 摘要请求恒回超窗：这次 summarize 恰 2 个请求，compactFailed(overflow)，不写 marker，之后不再发摘要请求', async () => {
    const ctx = mkCtx(dir);
    textRounds(ctx);
    const cfg = relayUnknown();
    const ep = strictEndpoint({ limit: 20_000, counts: 'input', style: 'plain', main: ok, summary: scriptedSummarizer('faithful', { overflowFirst: 99 }) });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(ep.summaries().map(h => h.status)).toEqual([400, 400]);
    expect(eventsOf(events, 'compactFailed')).toHaveLength(1);
    expect(eventsOf(events, 'compactFailed')[0]).toMatchObject({ reason: 'overflow', trigger: 'overflow' });
    expect(markers(ctx.db, ctx.sessionId)).toEqual({ markers: [], meta: [] });
    // 纯文字历史没有可裁的：放不下，不重发
    expect(ep.mains().map(h => h.status)).toEqual([400]);
    expect(errorsOf(events).at(-1)).toMatchObject({ code: 'contextFull', recovery: { stop: 'noProgress' } });
  });

  it('R8 摘要花费有上限：累计到上限后第 2 次摘要不发', async () => {
    const ctx = mkCtx(dir);
    // 末尾 30 轮小结果（每条 1,900 字符，修剪与裁剪都动不了）：标准压缩之后只剩收紧锚点的压缩可做
    mixedHistory(ctx, 30, 1_900);
    const cfg = relay(64_000);
    const ep = strictEndpoint({ limit: 1_000, style: 'plain', checkSummary: false, main: ok, summary: scriptedSummarizer('faithful') });
    const { events } = await runLoop(ctx, catalog, {
      primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, extra: { recoveryLimits: { summarySpendTokens: 30_000 } },
    });
    expect(ep.summaries()).toHaveLength(1);
    expect(eventsOf(events, 'compacted')).toHaveLength(1);
    const failed = eventsOf(events, 'compactFailed');
    const actions = errorsOf(events).at(-1)!.recovery!.actions;
    const skippedForSpend = actions.some(a => a.kind === 'compact' && a.result === 'skipped' && a.reason === 'spendCap');
    expect(failed.some(e => e.reason === 'budget') || skippedForSpend).toBe(true);
    expect(errorsOf(events).at(-1)!.code).toBe('contextFull');
  });

  // ── 次数熔断：成功的压缩每次运行 ≤ 3、摘要请求每次运行 ≤ 5（I13）──
  /** 写不完的长任务：主模型每一轮都再写一个文件（入参约 2K token，修剪与裁剪都动不了），端点真实上限（输入 + 输出）20K。
   *  请求只能靠收紧锚点的压缩变小，所以压缩与摘要请求的次数熔断是这条路径上实际起作用的那一条
   *  （40 万的花费上限在夹具的 60 次命中之内到不了）。主模型永不收尾：运行只会以熔断结束。 */
  async function writeForever(recoveryLimits: Partial<RecoveryLimits>, summary = scriptedSummarizer('faithful')) {
    const exec = execLog();
    const ctx = mkCtx(dir, { tools: exec.tools });
    ctx.say('keep writing report files until told to stop');
    const cfg = relay(64_000);
    const ep = strictEndpoint({
      limit: 20_000, style: 'kimi', summary,
      main: (_b, info) => openaiToolCall(`w${info.n}`, 'file_write', { path: `out/f${info.accepted + 1}.md`, content: ascii(8_000), tool_title: `write ${info.accepted + 1}` }, info.usage),
    });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, extra: { recoveryLimits } });
    return { ctx, ep, events, budgets, log: exec.log };
  }
  type Forever = Awaited<ReturnType<typeof writeForever>>;
  /** 四条用例共用：以「上下文已满」收尾并带恢复说明；每个被收下的主请求带出的那次写入恰好执行一次，被拒到收尾之间没有再执行任何工具。 */
  function expectFusedEnd({ ctx, ep, events, log }: Forever): ContextRecoveryView {
    const last = errorsOf(events).at(-1)!;
    expect(events.at(-1)).toBe(last);
    expect(last.code).toBe('contextFull');
    expect(last.recovery).toMatchObject({ phase: 'failed', stop: 'noProgress', resends: 0 });
    // 终态之前发过同一份恢复说明（事件条与任务面板靠它解释这次失败）
    expect(eventsOf(events, 'contextRecovery').at(-1)!.view).toEqual(last.recovery);
    expect(ep.hits.length).toBeLessThan(60);
    const uses = ctx.store.listMessages(ctx.sessionId).flatMap(m => m.parts.filter(p => p.type === 'toolUse'));
    const accepted = ep.mains().filter(h => h.status === 200).length;
    expect(log).toHaveLength(accepted);
    expect(uses).toHaveLength(accepted);
    expect(log.every(e => e.success)).toBe(true);
    expect(log.map(e => e.path)).toEqual(Array.from({ length: accepted }, (_, i) => `out/f${i + 1}.md`));
    for (const e of log) expect(existsSync(join(ctx.workspace, e.path))).toBe(true);
    return last.recovery!;
  }
  const skippedFor = (reason: string) => ({ kind: 'compact', result: 'skipped', reason });

  it('F1 成功的压缩每次运行至多 3 次（恢复路径）：第 4 次不发摘要请求，以「上下文已满」收尾并说明停在压缩次数上', async () => {
    const run = await writeForever({});
    dumpForUi('f1', { events: run.events.filter(e => e.kind !== 'textDelta'), budget: run.budgets.at(-1) });
    const recovery = expectFusedEnd(run);
    const compacted = eventsOf(run.events, 'compacted');
    expect(compacted.map(e => [e.detail.trigger, e.detail.rule])).toEqual(Array.from({ length: 3 }, () => ['overflow', 'tight']));
    expect(run.ep.summaries().map(h => h.status)).toEqual([200, 200, 200]);
    expect(markers(run.ctx.db, run.ctx.sessionId).markers).toHaveLength(3);
    expect(eventsOf(run.events, 'compactFailed')).toEqual([]);
    // 最后这次事故：标准与收紧两种锚点的压缩都是被「压缩次数用完」挡下的，没有别的动作——以前这种情况只有一句「上下文已满」
    expect(recovery.actions.filter(a => a.kind === 'compact')).toEqual([skippedFor('limit'), skippedFor('limit')]);
    expect(recovery.actions.some(a => a.kind === 'trim')).toBe(false);
  });

  it('F2 摘要请求每次运行至多 5 个（放开压缩次数之后轮到它）：第 6 个不发，没有多出来的压缩失败，说明停在摘要请求次数上', async () => {
    const run = await writeForever({ compactionsPerRun: 999 });
    const recovery = expectFusedEnd(run);
    expect(eventsOf(run.events, 'compacted')).toHaveLength(5);
    expect(run.ep.summaries().map(h => h.status)).toEqual([200, 200, 200, 200, 200]);
    // 是在发之前就跳过的（canCompact），不是进了 summarize 才被额度挡下——后者会多出一条 compactFailed(budget) 并停用压缩
    expect(eventsOf(run.events, 'compactFailed')).toEqual([]);
    expect(recovery.actions.filter(a => a.kind === 'compact')).toEqual([skippedFor('requests'), skippedFor('requests')]);
  });

  it('F3 摘要请求额度收到 1：第 1 次压缩照常，之后不再发摘要请求（跳过，不算压缩失败）', async () => {
    const run = await writeForever({ summaryRequestsPerRun: 1 });
    const recovery = expectFusedEnd(run);
    expect(eventsOf(run.events, 'compacted')).toHaveLength(1);
    expect(run.ep.summaries().map(h => h.status)).toEqual([200]);
    expect(eventsOf(run.events, 'compactFailed')).toEqual([]);
    expect(recovery.actions.filter(a => a.kind === 'compact')).toEqual([skippedFor('requests'), skippedFor('requests')]);
  });

  it('F4 摘要请求额度收到 1、第 1 个摘要请求自身超窗：减半后的第 2 个不发（summarize 里的那次重发也受次数约束），按额度用完失败，不写 marker', async () => {
    const run = await writeForever({ summaryRequestsPerRun: 1 }, scriptedSummarizer('faithful', { overflowFirst: 1 }));
    const recovery = expectFusedEnd(run);
    expect(run.ep.summaries().map(h => h.status)).toEqual([400]);
    expect(eventsOf(run.events, 'compactFailed').map(e => [e.reason, e.trigger])).toEqual([['budget', 'overflow']]);
    expect(eventsOf(run.events, 'compacted')).toEqual([]);
    expect(markers(run.ctx.db, run.ctx.sessionId)).toEqual({ markers: [], meta: [] });
    // 那次失败发生在两次事故之间的轮首减压里（压缩从此停用）；最后这次事故的压缩是被「已停用」挡下的，同样要说明
    expect(recovery.actions.filter(a => a.kind === 'compact')).toEqual([skippedFor('disabled'), skippedFor('disabled')]);
  });

  it('F5 校准系数 1.3 的大窗口配置：三次满额的水位压缩都发得出（花费按未校准的取材量记，不收紧原有的 3 次）；第 4 次被压缩次数挡下，没有多出来的压缩失败', async () => {
    const ctx = mkCtx(dir);
    const cfg = relay(2_000_000);
    // 同一配置实例上的一条校准样本：发送前估计 10,000、端点实测 13,000 → 系数 1.3
    ctx.say('warm up');
    ctx.add('assistant', [{ type: 'text', value: 'ready' }], {
      tokenUsage: {
        inputTokens: 13_000, outputTokens: 20, v: 2, estimate: { text: 10_000, media: 0, input: 10_000 },
        source: { by: 'provider', protocol: 'openai-chat', modelId: cfg.modelId, instanceId: cfg.id },
      },
    });
    // 约 125 万 token 的问答（校准后约 162 万，200 万窗口的 81%）：一次摘要最多取 10 万（未校准），压三次之后水位仍在压缩档
    for (let i = 1; i <= 455; i++) { ctx.say(`question ${i}: ${ascii(5_500)}`); ctx.reply(`answer ${i}: ${ascii(5_500)}`); }
    ctx.say('final question');
    const ep = strictEndpoint({ limit: 10_000_000, scale: 1.3, main: ok, summary: scriptedSummarizer('faithful') });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(events.at(-1)).toEqual(TURN_END);
    expect(eventsOf(events, 'compactFailed')).toEqual([]);
    const compacted = eventsOf(events, 'compacted');
    expect(compacted.map(e => e.detail.trigger)).toEqual(['watermark', 'watermark', 'watermark']);
    expect(ep.hits.map(h => `${h.kind}:${h.status}`)).toEqual(['summary:200', 'summary:200', 'summary:200', 'main:200']);
    // 每个摘要请求的取材都在 10 万（未校准）之内，三次的花费合计不到 40 万；按校准后的输入估计记的话已经超过——第 3 次会被花费上限挡下
    const requests = compacted.map(e => e.detail.request as { estInput: number; maxTokens: number });
    for (const h of ep.summaries()) expect(h.est).toBeLessThanOrEqual(100_500);
    expect(ep.summaries().reduce((s, h) => s + h.est + Number(h.body.max_tokens), 0)).toBeLessThan(RECOVERY_LIMITS.summarySpendTokens);
    expect(requests.reduce((s, r) => s + r.estInput + r.maxTokens, 0)).toBeGreaterThan(RECOVERY_LIMITS.summarySpendTokens);
    // 发出去的那个主请求：系数 1.3，水位仍在压缩档（> 12.8 万的窗口是 60%）——第 4 次压缩是被每次运行 3 次的上限挡下的
    expect(budgets).toHaveLength(1);
    expect(budgets[0].input.calibration.ratio).toBeCloseTo(1.3, 5);
    expect(budgets[0].limits.inputLimit).toBe(2_000_000);
    expect(budgets[0].input.tokens / budgets[0].limits.inputLimit).toBeGreaterThanOrEqual(0.6);
  });

  it('R10 最后一条用户消息自身就超限：两种锚点的下限都放不下，一个付费的摘要请求都不发，也不重发', async () => {
    const ctx = mkCtx(dir);
    ctx.say(`question 1: ${ascii(6_000)}`);
    ctx.rounds('OLD', [10_000, 10_000]);
    ctx.reply(`answer 1: ${ascii(6_500)}`);
    for (let i = 2; i <= 5; i++) { ctx.say(`question ${i}: ${ascii(6_000)}`); ctx.reply(`answer ${i}: ${ascii(6_500)}`); }
    ctx.say(`the last ask ${ascii(140_000)}`);
    const before = markers(ctx.db, ctx.sessionId);
    // 窗口没有资料（按 128K 计，约 56K 的请求水位不到修剪档）：第一次请求之前没有预防性的减压，摘要只可能出自恢复
    const cfg = relayUnknown();
    const ep = strictEndpoint({ limit: 30_000, style: 'kimi', main: ok, summary: scriptedSummarizer('faithful') });
    const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    dumpForUi('r10', { events: events.filter(e => e.kind !== 'textDelta'), budget: budgets.at(-1) });

    expect(ep.summaries()).toEqual([]);
    expect(markers(ctx.db, ctx.sessionId)).toEqual(before);
    expect(ep.mains().map(h => h.status)).toEqual([400]);
    const last = errorsOf(events).at(-1)!;
    expect(last).toMatchObject({ code: 'contextFull', recovery: { phase: 'failed', stop: 'noProgress', resends: 0 } });
    expect(last.relayDraft).toContain('the last ask');
    expect(last.recovery!.actions.filter(a => a.kind === 'compact')).toEqual([
      { kind: 'compact', result: 'skipped', reason: 'wontFit' }, { kind: 'compact', result: 'skipped', reason: 'wontFit' },
    ]);
    // 做过的本地修剪照实说了
    expect(last.recovery!.actions.some(a => a.kind === 'trim' && a.pruned > 0)).toBe(true);
  });

  it('R9 轮首的水位压缩刚成功、端点随后仍拒：恢复里按收紧锚点再压一次；两条 marker 的增量首尾相接、不重叠，压缩合计 2 次', async () => {
    // 8 组长问答（约 20K，标准锚点摘得走）+ 2 个短回合 + 最后一个回合带 14 轮 file_write（入参各约 2K token，修剪与裁剪都动不了）。
    // 手动窗口 64K：约 49K 的请求水位到了压缩档，第一次请求之前先做一次水位压缩；压完约 31K，端点真实上限（输入 + 输出）34K，仍被拒
    const ctx = mkCtx(dir, { tools: [...execLog().tools, echoTool] });
    for (let i = 1; i <= 8; i++) { ctx.say(`question ${i}: ${ascii(5_000)}`); ctx.reply(`answer ${i}: ${ascii(5_000)}`); }
    ctx.say('short question 9'); ctx.reply('short answer 9');
    ctx.say('short question 10'); ctx.reply('short answer 10');
    ctx.say('now write the files');
    writeRounds(ctx, 14, 8_000);
    const h = ctx.store.listMessages(ctx.sessionId);
    expect(h).toHaveLength(49);
    const before = snapshotRaw(ctx.store, ctx.sessionId);
    const cfg = relay(64_000);
    const ep = strictEndpoint({ limit: 34_000, style: 'kimi', main: ok, summary: scriptedSummarizer('faithful') });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    // 水位压缩（摘要请求自己放得下端点）→ 主请求被拒 → 恢复里的收紧锚点压缩 → 重发成功。请求次数在上界之内：主请求 ≤ 3、摘要请求 ≤ 5
    expect(ep.hits.map(h2 => `${h2.kind}:${h2.status}`)).toEqual(['summary:200', 'main:400', 'summary:200', 'main:200']);
    expect(events.at(-1)).toEqual(TURN_END);
    expect(errorsOf(events)).toEqual([]);
    const compacted = eventsOf(events, 'compacted');
    expect(compacted.map(e => [e.detail.trigger, e.detail.rule])).toEqual([['watermark', 'recent-turns'], ['overflow', 'tight']]);
    expect(eventsOf(events, 'compactFailed')).toEqual([]);

    // 两条 marker 的增量首尾相接、不重叠：第一条从会话开头摘到第 8 组问答，第二条紧接它摘到只留最近 4 条
    const rows = markers(ctx.db, ctx.sessionId);
    const metas = metasOf(ctx);
    expect(rows.markers).toHaveLength(2);
    expect(metas).toHaveLength(2);
    const at = (id: string): number => h.findIndex(m => m.id === id);
    expect(metas.map(m => [at(m.coverage.increment.fromMessageId), at(m.coverage.increment.toMessageId), m.coverage.increment.messageCount])).toEqual([[0, 15, 16], [16, 44, 29]]);
    for (let i = 1; i < metas.length; i++) {
      expect(at(metas[i].coverage.increment.fromMessageId)).toBe(at(metas[i - 1].coverage.increment.toMessageId) + 1);
      expect(metas[i].coverage.prevMarkerId).toBe(rows.markers[i - 1].id);
    }
    // 第二条代表的是从会话开头到新锚点的整段
    expect(metas[1].coverage).toMatchObject({ fromMessageId: h[0].id, toMessageId: h[44].id, messageCount: 45, rule: 'tight' });
    expect(metas.map(m => m.record.trigger)).toEqual(['watermark', 'overflow']);

    // 恢复说明：标准锚点已经没有新增可摘（刚压过），不重复压同一段；收紧锚点的那次写下了第二条 marker
    const rec = eventsOf(events, 'contextRecovery').map(e => e.view);
    expect(rec.map(v => v.phase)).toEqual(['resending', 'recovered']);
    expect(rec[0].actions.filter((a: { kind: string }) => a.kind === 'compact')).toEqual([
      { kind: 'compact', result: 'skipped', reason: 'nothingToSummarize' },
      { kind: 'compact', result: 'done', markerId: rows.markers[1].id, rule: 'tight', messages: 29 },
    ]);

    // 重发的请求：程序记录列着被摘走的 12 次写入；最近两轮写入的入参原样在；三个被盖住的用户回合按原话带上；工具对完整
    const first = bodyView(ep.mains()[0].body); const resent = bodyView(ep.mains()[1].body);
    expect(first.summary?.record?.fileChanges).toEqual([]);
    expect(first.pairs.map(p => p.id)).toEqual(Array.from({ length: 14 }, (_, i) => `W${i + 1}`));
    expect(resent.summary!.record!.fileChanges).toEqual(Array.from({ length: 12 }, (_, i) => `out/f${i + 1}.md`));
    expect(resent.pairs.map(p => [p.id, String(p.args.content).length, p.output])).toEqual([['W13', 8_000, '已写入 out/f13.md'], ['W14', 8_000, '已写入 out/f14.md']]);
    expect(resent.summary!.carried!.quotes).toEqual(['short question 9', 'short question 10', 'now write the files']);
    expect(resent.toolPairs).toEqual({ orphans: [], missing: [] });
    expect(resent.messages.at(-1)).toEqual(first.messages.at(-1));
    expect(resent.est + resent.maxTokens).toBeLessThanOrEqual(34_000);
    expect(JSON.stringify(ctx.store.listMessages(ctx.sessionId).slice(0, -1))).toBe(before);
  });

  it('R10b 标准锚点摘完的下限放不下、收紧锚点的放得下：不为标准锚点发付费的摘要，只发 1 次收紧锚点的摘要，随后重发成功', async () => {
    // 5 个用户回合：前 2 个各带 3 轮小结果（共约 8K token，标准锚点摘得走、够得上最小收益），后 3 个都很短；
    // 最后一个回合之后是 20 轮 file_write，入参各约 2K token（修剪与裁剪都动不了）。端点上限（输入 + 输出）20K
    const ctx = mkCtx(dir, { tools: [...execLog().tools, echoTool] });
    for (let t = 1; t <= 2; t++) {
      ctx.say(`question ${t}: ${ascii(5_000)}`);
      ctx.rounds(`E${t}_`, [1_900, 1_900, 1_900]);
      ctx.reply(`answer ${t}: ${ascii(5_000)}`);
    }
    ctx.say('short question 3'); ctx.reply('short answer 3');
    ctx.say('short question 4'); ctx.reply('short answer 4');
    ctx.say('now write the files');
    writeRounds(ctx, 20, 8_000);
    const h = ctx.store.listMessages(ctx.sessionId);
    expect(h).toHaveLength(61);
    const before = snapshotRaw(ctx.store, ctx.sessionId);
    // 窗口没有资料（按 128K 计，约 49K 的请求水位不到修剪档）：第一次请求之前没有预防性的减压，摘要只可能出自恢复
    const cfg = relayUnknown();
    const ep = strictEndpoint({ limit: 20_000, style: 'kimi', main: ok, summary: scriptedSummarizer('faithful') });
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });

    expect(ep.hits.map(h2 => `${h2.kind}:${h2.status}`)).toEqual(['main:400', 'summary:200', 'main:200']);
    expect(events.at(-1)).toEqual(TURN_END);
    expect(errorsOf(events)).toEqual([]);
    // 写下的唯一一条 marker 是收紧锚点的：只留最近 4 条原文
    const rows = markers(ctx.db, ctx.sessionId);
    const metas = metasOf(ctx);
    expect(rows.markers).toHaveLength(1);
    expect(metas[0].coverage).toMatchObject({ rule: 'tight', fromMessageId: h[0].id, toMessageId: h[56].id, messageCount: 57 });
    expect(metas[0].record).toMatchObject({ trigger: 'overflow', request: { attempts: 1 } });
    // 标准锚点那一步是试算之后跳过的（摘完剩下的 20 轮写入仍有约 40K），不是发了才发现没用
    const rec = eventsOf(events, 'contextRecovery').map(e => e.view);
    expect(rec.map(v => v.phase)).toEqual(['resending', 'recovered']);
    expect(rec[0].actions.filter((a: { kind: string }) => a.kind === 'compact')).toEqual([
      { kind: 'compact', result: 'skipped', reason: 'wontFit' },
      { kind: 'compact', result: 'done', markerId: rows.markers[0].id, rule: 'tight', messages: 57 },
    ]);
    expect(rec[0].actions.some((a: { kind: string }) => a.kind === 'trim')).toBe(false);
    // 摘要请求按学到的上限取材，端点收下了
    expect(ep.summaries()[0].est + Number(ep.summaries()[0].body.max_tokens)).toBeLessThanOrEqual(20_000);

    // 重发的请求：18 次被摘走的写入在程序记录里；最近两轮写入原样；后 3 个用户回合按原话带上
    const resent = bodyView(ep.mains()[1].body);
    expect(resent.summary!.record!.fileChanges).toEqual(Array.from({ length: 18 }, (_, i) => `out/f${i + 1}.md`));
    expect(resent.pairs.map(p => [p.id, String(p.args.content).length])).toEqual([['W19', 8_000], ['W20', 8_000]]);
    expect(resent.summary!.carried).toMatchObject({ quotes: ['short question 3', 'short question 4', 'now write the files'], closing: '最后一条就是当前这一轮的用户指示。' });
    expect(resent.toolPairs).toEqual({ orphans: [], missing: [] });
    expect(resent.est + resent.maxTokens).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(ctx.store.listMessages(ctx.sessionId).slice(0, -1))).toBe(before);
  });

  it('R15 性质（固定种子）：随机历史、窗口、端点上限与报文样式下循环必定结束，被拒的主请求 ≤ 7、摘要请求 ≤ 5', async () => {
    let seed = 20261004;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const styles = ['kimi', 'openai', 'anthropic', 'plain', 'lying'] as const;
    const modes: SummarizerMode[] = ['faithful', 'lossy', 'prose', 'malformed-dup', 'empty'];
    for (let i = 0; i < 24; i++) {
      const ctx = mkCtx(dir);
      const turns = 1 + Math.floor(rnd() * 6);
      for (let t = 1; t <= turns; t++) {
        ctx.say(`question ${t}: ${ascii(500 + Math.floor(rnd() * 12_000))}`);
        const tools = Math.floor(rnd() * 5);
        if (tools > 0) ctx.rounds(`T${t}_`, Array.from({ length: tools }, () => 500 + Math.floor(rnd() * 30_000)));
        if (t < turns) ctx.reply(`answer ${t}: ${ascii(500 + Math.floor(rnd() * 6_000))}`);
      }
      const window = [16_000, 32_000, 64_000, 200_000][Math.floor(rnd() * 4)];
      const cfg = rnd() < 0.3 ? relayUnknown() : relay(window);
      const limit = 4_000 + Math.floor(rnd() * 40_000);
      const ep = strictEndpoint({
        limit, counts: rnd() < 0.5 ? 'input' : 'total', style: styles[Math.floor(rnd() * styles.length)],
        main: ok, summary: scriptedSummarizer(modes[Math.floor(rnd() * modes.length)]),
      });
      const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
      const label = `#${i} limit=${limit} window=${window}`;
      expect(['turnEnd', 'error'], label).toContain(events.at(-1)!.kind);
      expect(ep.mains().filter(h => h.status === 400).length, label).toBeLessThanOrEqual(7);
      expect(ep.summaries().length, label).toBeLessThanOrEqual(5);
      // 每个重发的请求都比它前一次被拒的小
      const mains = ep.mains();
      for (let k = 1; k < mains.length; k++) if (mains[k - 1].status === 400) expect(mains[k].est + Number(mains[k].body.max_tokens), label).toBeLessThan(mains[k - 1].est + Number(mains[k - 1].body.max_tokens));
    }
  });
});

describe('取消', () => {
  it('C1 主请求被拒的那一刻取消：报「已取消」，之后一次请求都不发，不写 marker', async () => {
    const ctx = mkCtx(dir);
    textRounds(ctx);
    const cfg = relay(64_000);
    const ac = new AbortController();
    const ep = strictEndpoint({ limit: 24_000, style: 'kimi', main: ok, summary: scriptedSummarizer('faithful') });
    // 闸门卡在拒绝响应返回处：端点回 400 的同时取消
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      const res = await (ep.fetchImpl as unknown as (u: unknown, i: unknown) => Promise<Response>)(url, init);
      if (res.status === 400) ac.abort();
      return res;
    }) as unknown as typeof ep.fetchImpl;
    const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, fetchImpl), input: cfg }, extra: { signal: ac.signal } });
    expect(kindsOf(events)).toEqual(['error:已取消']);
    expect(ep.hits).toHaveLength(1);
    expect(markers(ctx.db, ctx.sessionId)).toEqual({ markers: [], meta: [] });
  });

  it('C2 恢复里的摘要流途中取消：报「已取消」，没有 compactFailed，不写 marker，不重发', async () => {
    const ctx = mkCtx(dir);
    textRounds(ctx);
    const cfg = relay(64_000);
    const ac = new AbortController();
    const started = gate();
    const ep = strictEndpoint({
      limit: 24_000, style: 'kimi', main: ok,
      summary: (_b, info) => {
        const s = controlledSse(info.signal);
        s.push({ choices: [{ index: 0, delta: { content: '【目标】\n- half' } }] });
        started.open();
        return s.response;
      },
    });
    const running = runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, extra: { signal: ac.signal } });
    await started.wait;
    ac.abort();
    const { events } = await running;
    expect(kindsOf(events)).toEqual(['error:已取消']);
    expect(ep.hits.map(h => h.kind)).toEqual(['main', 'summary']);
    expect(markers(ctx.db, ctx.sessionId)).toEqual({ markers: [], meta: [] });
  });

  it('C3 重发的流出了半截正文后取消：半截正文落库，恢复里写下的 marker 保留且有效，下一次运行正常', async () => {
    const ctx = mkCtx(dir);
    textRounds(ctx);
    const cfg = relay(64_000);
    const ac = new AbortController();
    const shown = gate();
    let hold = true;
    const ep = strictEndpoint({
      limit: 24_000, style: 'kimi', summary: scriptedSummarizer('faithful'),
      main: (_b, info) => {
        if (!hold) return openaiOk('ok', info.usage);
        const s = controlledSse(info.signal);
        s.push({ choices: [{ index: 0, delta: { content: 'half of the answer' } }] });
        return s.response;
      },
    });
    const running = runLoop(ctx, catalog, {
      primary: { provider: openai(cfg, ep.fetchImpl), input: cfg }, extra: { signal: ac.signal },
      onEvent: e => { if (e.kind === 'textDelta') shown.open(); },
    });
    await shown.wait;
    ac.abort();
    const { events } = await running;
    expect(kindsOf(events).slice(-2)).toEqual(['messagePersisted', 'error:已取消']);
    expect(ctx.store.listMessages(ctx.sessionId).at(-1)).toMatchObject({ role: 'assistant', streamInterruptCount: 1, parts: [{ type: 'text', value: 'half of the answer' }] });
    // 重发没有完成：只有「正在重发」，没有「已恢复」；恢复里写下的 marker 是完整有效的，保留
    expect(phases(events)).toEqual(['resending']);
    const rows = markers(ctx.db, ctx.sessionId);
    expect(rows.markers).toHaveLength(1);
    expect(ctx.store.getLatestCompactMarker(ctx.sessionId)?.meta?.model.form).toBe('structured');
    // 下一次运行从落库历史与这条 marker 重建，正常跑完
    hold = false;
    ctx.say('next question');
    const again = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
    expect(again.events.at(-1)).toEqual(TURN_END);
    const body = bodyView(ep.mains().at(-1)!.body);
    expect(body.summary?.record).toBeDefined();
    expect(JSON.stringify(body.messages)).toContain('half of the answer');
    expect(markers(ctx.db, ctx.sessionId)).toEqual(rows);
  });

  it('D2 两个会话同时恢复：计数与学到的上限互不影响；其中一个在摘要途中取消，另一个照常恢复', async () => {
    const cfg = relay(64_000);
    const a = mkCtx(dir); textRounds(a);
    const b = mkCtx(dir); textRounds(b);
    const epA = strictEndpoint({ limit: 24_000, style: 'kimi', main: ok, summary: scriptedSummarizer('faithful') });
    const ac = new AbortController();
    const bInSummary = gate(); const release = gate();
    // b 的摘要请求挂在闸门上；期间 a 走完整个恢复，随后取消 b 再放行
    const epB = strictEndpoint({
      limit: 24_000, style: 'kimi', main: ok,
      summary: async (body, info) => { bInSummary.open(); await release.wait; return scriptedSummarizer('faithful')(body, info); },
    });
    const runB = runLoop(b, catalog, { primary: { provider: openai(cfg, epB.fetchImpl), input: cfg }, extra: { signal: ac.signal } });
    await bInSummary.wait;
    const ra = await runLoop(a, catalog, { primary: { provider: openai(cfg, epA.fetchImpl), input: cfg } });
    ac.abort();
    release.open();
    const rb = await runB;
    // a 的命中数与单独运行时相同（R1）
    expect(epA.hits.map(h => `${h.kind}:${h.status}`)).toEqual(['main:400', 'summary:200', 'main:200']);
    expect(ra.events.at(-1)).toEqual(TURN_END);
    expect(phases(ra.events)).toEqual(['resending', 'recovered']);
    expect(markers(a.db, a.sessionId).markers).toHaveLength(1);
    // b：摘要流在取消之后正常结束，提交前的复核拦下，不写 marker、不重发
    expect(kindsOf(rb.events)).toEqual(['error:已取消']);
    expect(epB.hits.map(h => h.kind)).toEqual(['main', 'summary']);
    expect(markers(b.db, b.sessionId)).toEqual({ markers: [], meta: [] });
  });
});
