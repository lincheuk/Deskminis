/**
 * F03 验收 2 / 3 的 summarize 级证据：真 CompactEngine + 真 OpenAIProvider + 脚本化的摘要端点。
 * 断言落在库里的行（compact_markers / compact_marker_meta）、有效历史与按真构建器组出的请求体上。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { toWireMessage } from '../src/minisd/sync/wire';
import { CompactEngine, CompactRejectedError, flattenForSummary, pendingSummaryRange } from '../src/minisd/agent/compact';
import { defaultToolKindOf, validateCompactMeta } from '../src/minisd/agent/compact-meta';
import { buildRelayDraft, buildRequestMessages } from '../src/minisd/agent/loop';
import { buildOpenAIBody } from '../src/minisd/providers/openai';
import { countImageNeeds } from '../src/minisd/providers/runtime-model';
import { OpenAIProvider } from '../src/minisd/providers/openai';
import type { AgentProvider, FetchLike } from '../src/minisd/providers/types';
import type { AgentMessage, CompactMarker, RawMessage } from '../src/shared/types';
import {
  PROSE_SUMMARY, bodyView, controlledSse, gate, markers, mkCatalog, mkCtx, openai, openaiOk, relay, runLoop, snapshotRaw, strictEndpoint, summaryReplyText,
  type Body, type Ctx, type SummarizerMode,
} from './overflow-recovery-fixture';
import { pngBytes } from './image-fixtures';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-f03-compact-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** 脚本化的摘要端点：真 OpenAIProvider，回复由收到的摘要请求正文推出。 */
function summaryProvider(mode: SummarizerMode) {
  const hits: Body[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Body;
    hits.push(body);
    if (mode === 'error500') return new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), { status: 500 });
    return openaiOk(summaryReplyText(mode, body), undefined, mode === 'refusal' ? 'content_filter' : mode === 'truncated' ? 'length' : 'stop');
  }) as unknown as FetchLike;
  return { hits, provider: new OpenAIProvider({ apiKey: 'k', modelId: 'sum-model', baseUrl: 'https://relay.example/v1', fetchImpl }) };
}

/** 按循环同一套组法把有效历史变成 OpenAI 请求体（真构建器），再读成结构。 */
function requestView(ctx: Ctx, eff: AgentMessage[]) {
  const attDir = ctx.paths.sessionBucket(ctx.sessionId, 'attachments');
  const messages = buildRequestMessages(eff, new Map(), rel => join(attDir, basename(rel)));
  return bodyView(buildOpenAIBody({ messages, systemPrompt: 'sys', tools: [], maxTokens: 1_024, thinkingLevel: 'off' }, 'm') as Body, false);
}
const history = (ctx: Ctx): RawMessage[] => ctx.store.listMessages(ctx.sessionId);
const anchorOf = (h: RawMessage[], m: CompactMarker): number => h.findIndex(x => x.id === m.lastCompactedMessageId);
const hasToolUse = (m: RawMessage | undefined): boolean => !!m && m.role === 'assistant' && m.parts.some(p => p.type === 'toolUse');
const hasToolResult = (m: RawMessage | undefined): boolean => !!m && m.role === 'user' && m.parts.some(p => p.type === 'toolResult');
/** 锚点两侧没有拆开工具对（I10）。 */
const splitsPair = (h: RawMessage[], idx: number): boolean => hasToolUse(h[idx]) && hasToolResult(h[idx + 1]);

describe('验收 3：工具调用与结果', () => {
  const idsOf = (ms: RawMessage[], type: 'toolUse' | 'toolResult'): string[] =>
    ms.flatMap(m => m.parts.filter(p => p.type === type).map(p => (p.value as { toolUseId: string }).toolUseId));
  /** 三种锚点共用的断言：锚点两侧没有拆开工具对；压缩后的请求体没有孤儿、缺失与补出来的占位；锚点之后落库的每一条工具结果
   *  都在请求体里（没有被当孤儿剥掉），每一次调用都带着自己的结果。返回锚点下标。 */
  function expectPairsWhole(ctx: Ctx, engine: CompactEngine, h: RawMessage[], marker: CompactMarker | undefined): number {
    expect(marker).toBeDefined();
    const idx = anchorOf(h, marker!);
    expect(splitsPair(h, idx)).toBe(false);
    const view = requestView(ctx, engine.buildEffectiveHistory(h, marker));
    expect(view.toolPairs).toEqual({ orphans: [], missing: [] });
    // 原历史里没有「结果未知」的占位：请求体里也不该有（pairToolResults 没有被迫补任何东西）
    expect(view.placeholders).toBe(0);
    const kept = h.slice(idx + 1);
    expect(view.messages.filter(m => m.role === 'tool').map(m => String(m.tool_call_id))).toEqual(idsOf(kept, 'toolResult'));
    expect(view.pairs.map(p => p.id)).toEqual(idsOf(kept, 'toolUse'));
    for (const p of view.pairs) expect(p.output).toContain(`result-${p.id.slice(1)} `);
    return idx;
  }
  const round = (ctx: Ctx, j: number): void => ctx.call(`K${j}`, 'echo', { text: `r${j}`, tool_title: `step ${j}` }, `result-${j} ${'x'.repeat(200)}`);

  it('K1 规则锚点 length − 15 正落在 toolUse 上（共 40 条，下标 25）：锚点不拆对，压缩后的请求体没有孤儿、缺失与补出来的占位', async () => {
    const ctx = mkCtx(dir);
    ctx.say('refactor the project step by step');
    for (let j = 1; j <= 19; j++) round(ctx, j);
    ctx.say('keep going');
    const h = history(ctx);
    expect(h).toHaveLength(40);
    expect(hasToolUse(h[25]) && hasToolResult(h[26])).toBe(true);

    const engine = new CompactEngine(ctx.store);
    const marker = await engine.summarize(h, ctx.sessionId, summaryProvider('faithful').provider);
    // 原历史里下标 26 的那条结果：要么随它的调用一起留在原文里，要么一起进了摘要请求，不会两边都没有
    expect(expectPairsWhole(ctx, engine, h, marker)).toBe(24);
    expect(marker!.meta!.coverage.rule).toBe('recent-messages');
  });

  it('K1 收紧锚点 length − 5 正落在 toolUse 上（共 16 条，下标 11）：锚点退一条，这一对整体留在原文里', async () => {
    const ctx = mkCtx(dir);
    ctx.say('refactor the project step by step');
    for (let j = 1; j <= 7; j++) round(ctx, j);
    ctx.say('keep going');
    const h = history(ctx);
    expect(h).toHaveLength(16);
    expect(hasToolUse(h[11]) && hasToolResult(h[12])).toBe(true);

    const engine = new CompactEngine(ctx.store);
    const sum = summaryProvider('faithful');
    const marker = await engine.summarize(h, ctx.sessionId, sum.provider, { rule: 'tight', trigger: 'overflow' });
    expect(expectPairsWhole(ctx, engine, h, marker)).toBe(10);
    expect(marker!.meta!.coverage).toMatchObject({ rule: 'tight', messageCount: 11 });
    // K6 的调用与结果都没有进摘要请求（它们留在原文里），K5 的都进了
    const text = String((sum.hits[0].messages as Body[])[1].content);
    expect(text).toContain('result-5 ');
    expect(text).not.toContain('step 6');
    expect(text).not.toContain('result-6 ');
  });

  it('K1 预算后退停在 toolUse 上（规则锚点在下标 21，摘要请求只放得下前 10 条，第 10 条正是 K5 的调用）：再退一条，不把这一对拆到锚点两侧', async () => {
    const ctx = mkCtx(dir);
    ctx.say('start the long job');
    for (let j = 1; j <= 10; j++) round(ctx, j);
    ctx.reply('answer 1'); ctx.say('question 2'); ctx.reply('answer 2'); ctx.say('question 3'); ctx.reply('answer 3'); ctx.say('question 4');
    const h = history(ctx);
    expect(pendingSummaryRange(h, undefined)).toEqual({ from: 0, to: 21, rule: 'recent-turns' });
    expect(hasToolUse(h[9]) && hasToolResult(h[10])).toBe(true);

    const engine = new CompactEngine(ctx.store);
    const sum = summaryProvider('faithful');
    // 受控的预算：正文里一出现 K5 的结果就放不下——放得下的最大前缀是下标 0–9，最后一条是 K5 的调用
    const fit = (text: string) => ({ fits: !text.includes('result-5 '), maxTokens: 4_096, estInput: Math.ceil(text.length / 4) });
    const marker = await engine.summarize(h, ctx.sessionId, sum.provider, { fit });
    expect(expectPairsWhole(ctx, engine, h, marker)).toBe(8);
    expect(marker!.meta!.coverage).toMatchObject({ rule: 'recent-turns', messageCount: 9 });
    // 发出去的摘要请求只有一个，取材到 K4 的结果为止：K5 的调用没有单独进摘要
    expect(sum.hits).toHaveLength(1);
    const text = String((sum.hits[0].messages as Body[])[1].content);
    expect(text).toContain('result-4 ');
    expect(text).not.toContain('step 5');
    // 没摘进去的留在原文里，下一次接着摘：增量紧接这次的锚点
    expect(pendingSummaryRange(h, marker)).toEqual({ from: 9, to: 21, rule: 'recent-turns' });
  });
});

describe('验收 3：纯图片用户消息', () => {
  it('K3b 单回合任务、唯一的用户消息只有一张图：压缩后请求体第一条 user 消息里仍有图片块与「[图片 文件名]」', async () => {
    const ctx = mkCtx(dir);
    ctx.add('user', [ctx.file('shot.png', pngBytes(800, 600))]);
    for (let j = 1; j <= 20; j++) ctx.call(`P${j}`, 'echo', { text: `r${j}`, tool_title: `step ${j}` }, `result-${j} ${'x'.repeat(200)}`);
    const h = history(ctx);
    expect(h).toHaveLength(41);
    const engine = new CompactEngine(ctx.store);
    const before = requestView(ctx, engine.buildEffectiveHistory(h, undefined));
    expect(before.images[0]).toBe(1);

    const marker = await engine.summarize(h, ctx.sessionId, summaryProvider('faithful').provider);
    expect(marker).toBeDefined();
    expect(anchorOf(h, marker!)).toBeGreaterThan(0);
    const view = requestView(ctx, engine.buildEffectiveHistory(h, marker));
    expect(view.summary).toBeDefined();
    expect(view.images[0]).toBe(1);
    expect(view.summary!.text).toContain('[图片 shot.png]');
    expect(view.summary!.carried?.closing).toBe('最后一条就是当前这一轮的用户指示。');
    expect(view.images.reduce((a, b) => a + b, 0)).toBe(before.images.reduce((a, b) => a + b, 0));
  });
});

describe('验收 2：取消', () => {
  it('S7c 最后一个分片之后、done 之前取消，流随后正常结束：不写 marker', async () => {
    const ctx = mkCtx(dir);
    for (let i = 1; i <= 5; i++) { ctx.say(`question ${i}`); ctx.reply(`answer ${i}`); }
    ctx.say('question 6');
    const h = history(ctx);
    const snap = snapshotRaw(ctx.store, ctx.sessionId);
    const inner = summaryProvider('faithful').provider;
    const reached = gate(); const release = gate();
    // 闸门卡在最后一个分片与 done 之间：测试在此取消，再放行让流正常结束
    const gated: AgentProvider = {
      name: inner.name, modelId: inner.modelId,
      async *streamAgentMessage(req, signal) {
        for await (const ev of inner.streamAgentMessage(req)) {
          if (ev.kind === 'done') { reached.open(); await release.wait; }
          yield ev;
        }
        void signal;
      },
    };
    const ac = new AbortController();
    const engine = new CompactEngine(ctx.store);
    const pending = engine.summarize(h, ctx.sessionId, gated, { signal: ac.signal }).then(m => ({ marker: m }), (e: unknown) => ({ error: e }));
    await reached.wait;
    ac.abort();
    release.open();
    const outcome = await pending;

    expect('error' in outcome).toBe(true);
    expect(markers(ctx.db, ctx.sessionId)).toEqual({ markers: [], meta: [] });
    expect(ctx.store.getLatestCompactMarker(ctx.sessionId)).toBeUndefined();
    expect(snapshotRaw(ctx.store, ctx.sessionId)).toBe(snap);
  });

  it('S7a / S7b 首个分片之前、流中途取消：抛出，不写 marker', async () => {
    for (const pushFirst of [false, true]) {
      const ctx = mkCtx(dir);
      for (let i = 1; i <= 5; i++) { ctx.say(`question ${i}`); ctx.reply(`answer ${i}`); }
      ctx.say('question 6');
      const ac = new AbortController();
      const started = gate();
      const fetchImpl = (async (_u: unknown, init?: { signal?: AbortSignal }) => {
        const s = controlledSse(init?.signal);
        if (pushFirst) s.push({ choices: [{ index: 0, delta: { content: '【目标】\n- half' } }] });
        started.open();
        return s.response;
      }) as unknown as FetchLike;
      const provider = new OpenAIProvider({ apiKey: 'k', modelId: 'sum-model', baseUrl: 'https://relay.example/v1', fetchImpl });
      const pending = new CompactEngine(ctx.store).summarize(history(ctx), ctx.sessionId, provider, { signal: ac.signal }).then(() => 'written', () => 'thrown');
      await started.wait;
      ac.abort();
      expect(await pending).toBe('thrown');
      expect(markers(ctx.db, ctx.sessionId)).toEqual({ markers: [], meta: [] });
    }
  });
});

// ───────────────────────── 验收 2：摘要失败时不替换有效 marker ─────────────────────────

/** 回复固定文本的摘要端点。 */
function fixedProvider(text: string) {
  const hits: Body[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => { hits.push(JSON.parse(String(init?.body)) as Body); return openaiOk(text); }) as unknown as FetchLike;
  return { hits, provider: new OpenAIProvider({ apiKey: 'k', modelId: 'sum-model', baseUrl: 'https://relay.example/v1', fetchImpl }) };
}
const C1 = '约束 C1：只能改 docs/ 下的文件。'; const C2 = '约束 C2：不要动 README。';
/** 四个用户回合（第 1 回合带两条约束）：标准锚点摘走第 1 回合。 */
function fourTurns(ctx: Ctx): void {
  ctx.say(`${C1}${C2}请开始整理`); ctx.reply('answer 1');
  ctx.say('question 2'); ctx.reply('answer 2');
  ctx.say('question 3'); ctx.reply('answer 3');
  ctx.say('question 4');
}
/** 再追加两个回合：标准锚点前移，有新的增量可摘。 */
function twoMore(ctx: Ctx): void { ctx.reply('answer 4'); ctx.say('question 5'); ctx.reply('answer 5'); ctx.say('question 6'); }
type Prior = 'M1' | 'L1';
/** 先有一条有效的 marker：M1 = v2 结构化；L1 = 旧文本 marker（没有 meta）。之后追加两个回合。 */
async function withPrior(kind: Prior): Promise<{ ctx: Ctx; engine: CompactEngine; prior: CompactMarker }> {
  const ctx = mkCtx(dir);
  fourTurns(ctx);
  const engine = new CompactEngine(ctx.store);
  const prior = kind === 'M1'
    ? (await engine.summarize(history(ctx), ctx.sessionId, summaryProvider('faithful').provider))!
    : ctx.store.appendCompactMarker(ctx.sessionId, 'old free text summary of turn one', history(ctx)[1].id);
  twoMore(ctx);
  return { ctx, engine, prior };
}
interface Frozen { latest: CompactMarker | undefined; rows: ReturnType<typeof markers>; raw: string; eff: AgentMessage[] }
const freeze = (ctx: Ctx, engine: CompactEngine): Frozen => {
  const latest = ctx.store.getLatestCompactMarker(ctx.sessionId);
  return { latest, rows: markers(ctx.db, ctx.sessionId), raw: snapshotRaw(ctx.store, ctx.sessionId), eff: engine.buildEffectiveHistory(history(ctx), latest) };
};
/** 共同断言：最新 marker 仍是原来那条、两张表的行不变、原历史逐字节不变、有效历史不变；随后换一个忠实的摘要再压一次能成功，增量紧接原锚点。 */
async function expectIntact(ctx: Ctx, engine: CompactEngine, before: Frozen): Promise<CompactMarker> {
  expect(ctx.store.getLatestCompactMarker(ctx.sessionId)).toEqual(before.latest);
  expect(markers(ctx.db, ctx.sessionId)).toEqual(before.rows);
  expect(snapshotRaw(ctx.store, ctx.sessionId)).toBe(before.raw);
  expect(engine.buildEffectiveHistory(history(ctx), ctx.store.getLatestCompactMarker(ctx.sessionId))).toEqual(before.eff);
  const h = history(ctx);
  const next = await engine.summarize(h, ctx.sessionId, summaryProvider('faithful').provider);
  expect(next?.meta).toBeDefined();
  const oldIdx = before.latest ? anchorOf(h, before.latest) : -1;
  expect(next!.meta!.coverage.increment.fromMessageId).toBe(h[oldIdx + 1].id);
  expect(next!.meta!.coverage.fromMessageId).toBe(h[0].id);
  expect(validateCompactMeta(next!.meta!, next!.summary, h, before.latest, defaultToolKindOf)).toEqual([]);
  return next!;
}
const reasonOf = async (p: Promise<unknown>): Promise<string> => p.then(() => 'written', (e: unknown) => e instanceof CompactRejectedError ? e.reason : `error:${e instanceof Error ? e.message : String(e)}`);

describe('验收 2：摘要被拒绝 / 为空 / 截断 / 格式坏 / 请求失败时不替换有效 marker，历史仍可恢复', () => {
  const cases: [string, SummarizerMode, string | RegExp][] = [
    ['S1', 'refusal', 'refusal'], ['S2', 'empty', 'empty'], ['S2', 'blank', 'empty'], ['S3', 'truncated', 'truncated'],
    ['S4', 'malformed-nogoal', 'malformed'], ['S4', 'malformed-dup', 'malformed'], ['S4', 'malformed-partial', 'malformed'],
    ['S6', 'error500', /^error:.*500/],
  ];
  for (const prior of ['M1', 'L1'] as const) {
    for (const [name, mode, want] of cases) {
      it(`${name} ${mode}（先有 ${prior}）`, async () => {
        const { ctx, engine } = await withPrior(prior);
        const before = freeze(ctx, engine);
        const got = await reasonOf(engine.summarize(history(ctx), ctx.sessionId, summaryProvider(mode).provider));
        if (typeof want === 'string') expect(got).toBe(want); else expect(got).toMatch(want);
        await expectIntact(ctx, engine, before);
      });
    }

    it(`S5 结构与历史对不上（先有 ${prior}）：invalid，不写`, async () => {
      const { ctx, engine } = await withPrior(prior);
      ctx.reply('answer 6'); ctx.call('E1', 'echo', { text: 'x', tool_title: 'run' }, 'ran'); ctx.say('question 7');
      const before = freeze(ctx, engine);
      // 工具分类在建 meta 与校验之间变了口径（第一次问是「有副作用」，之后都是「只读」）：建 meta 时保留并标注的验证结论，
      // 校验复算时成了没有任何成功调用可依——结构与历史对不上
      let asked = 0;
      const flaky = (): 'effect' | 'read' => (asked++ === 0 ? 'effect' : 'read');
      const reply = '【目标】\n- g\n【约束】\n- （无）\n【已完成】\n- 测试全部通过\n【进行中】\n- （无）\n【待办】\n- （无）\n【关键决策】\n- （无）\n【涉及文件】\n- （无）';
      // 让那次 echo 调用落在覆盖区间里：再追加两个回合
      ctx.reply('answer 7'); ctx.say('question 8'); ctx.reply('answer 8'); ctx.say('question 9');
      const again = freeze(ctx, engine);
      void before;
      expect(await reasonOf(engine.summarize(history(ctx), ctx.sessionId, fixedProvider(reply).provider, { toolKindOf: flaky }))).toBe('invalid');
      await expectIntact(ctx, engine, again);
    });

    it(`S8 摘要期间历史的前缀变了（先有 ${prior}）：stale，不写`, async () => {
      const { ctx, engine } = await withPrior(prior);
      const h = history(ctx);
      const inner = summaryProvider('faithful').provider;
      const reached = gate(); const release = gate();
      const gated: AgentProvider = {
        name: inner.name, modelId: inner.modelId,
        async *streamAgentMessage(req) { for await (const ev of inner.streamAgentMessage(req)) { if (ev.kind === 'done') { reached.open(); await release.wait; } yield ev; } },
      };
      const pending = reasonOf(engine.summarize(h, ctx.sessionId, gated, { reread: () => history(ctx) }));
      await reached.wait;
      // 同步合并进来一条时间更早的消息（真的 mergeRemoteSession，线格式由 toWireMessage 给出）：摘要代表的那段前缀已经不是摘要时的那段
      const early = h[0].createdAt - 1;
      const remote = toWireMessage({
        id: 'peer-early-message', sessionId: ctx.sessionId, role: 'user', parts: [{ type: 'text', value: 'merged from another device' }],
        createdAt: early, updatedAt: early, sortOrder: 0, streamInterruptCount: 0, originDeviceId: 'peer-device', createdLocallyAt: early,
      });
      expect(ctx.store.mergeRemoteSession({ messages: [remote], markers: [] }, ctx.sessionId)).toMatchObject({ mergedCount: 1, orphanMarkerIds: [], hasChange: true });
      expect(history(ctx).map(m => m.id)).toEqual(['peer-early-message', ...h.map(m => m.id)]);
      const before = freeze(ctx, engine);
      release.open();
      expect(await pending).toBe('stale');
      expect(ctx.store.getLatestCompactMarker(ctx.sessionId)).toEqual(before.latest);
      expect(markers(ctx.db, ctx.sessionId)).toEqual(before.rows);
    });

    it(`S9 写 meta 行失败（先有 ${prior}）：整个事务回滚，compact_markers 没有新行`, async () => {
      const { ctx, engine } = await withPrior(prior);
      const before = freeze(ctx, engine);
      ctx.db.exec("CREATE TRIGGER f03_block BEFORE INSERT ON compact_marker_meta BEGIN SELECT RAISE(ABORT, 'meta blocked'); END;");
      expect(await reasonOf(engine.summarize(history(ctx), ctx.sessionId, summaryProvider('faithful').provider))).toMatch(/^error:.*meta blocked/);
      expect(markers(ctx.db, ctx.sessionId)).toEqual(before.rows);
      ctx.db.exec('DROP TRIGGER f03_block');
      await expectIntact(ctx, engine, before);
    });

    it(`S7a / S7b / S7c 取消的三个时机（先有 ${prior}）：都不写，原来那条 marker 与历史不变，之后仍能接着压`, async () => {
      for (const timing of ['首个分片之前', '流中途', '最后一个分片之后、done 之前'] as const) {
        const { ctx, engine } = await withPrior(prior);
        const before = freeze(ctx, engine);
        const ac = new AbortController();
        const reached = gate(); const release = gate();
        let provider: AgentProvider;
        if (timing === '最后一个分片之后、done 之前') {
          // 闸门卡在最后一个分片与 done 之间：取消之后放行，流正常结束
          const inner = summaryProvider('faithful').provider;
          provider = {
            name: inner.name, modelId: inner.modelId,
            async *streamAgentMessage(req) { for await (const ev of inner.streamAgentMessage(req)) { if (ev.kind === 'done') { reached.open(); await release.wait; } yield ev; } },
          };
        } else {
          const fetchImpl = (async (_u: unknown, init?: { signal?: AbortSignal }) => {
            const s = controlledSse(init?.signal);
            if (timing === '流中途') s.push({ choices: [{ index: 0, delta: { content: '【目标】\n- half' } }] });
            reached.open();
            return s.response;
          }) as unknown as FetchLike;
          provider = new OpenAIProvider({ apiKey: 'k', modelId: 'sum-model', baseUrl: 'https://relay.example/v1', fetchImpl });
        }
        const pending = engine.summarize(history(ctx), ctx.sessionId, provider, { signal: ac.signal }).then(() => 'written', () => 'thrown');
        await reached.wait;
        ac.abort();
        release.open();
        expect(await pending, timing).toBe('thrown');
        await expectIntact(ctx, engine, before);
      }
    });
  }

  it('D1 同一会话并发两次 summarize：恰写入 1 条 marker，另一次 stale', async () => {
    const ctx = mkCtx(dir);
    fourTurns(ctx);
    const h = history(ctx);
    const engine = new CompactEngine(ctx.store);
    const both = gate(); const release = gate();
    let done = 0;
    const gatedOf = (): AgentProvider => {
      const inner = summaryProvider('faithful').provider;
      return {
        name: inner.name, modelId: inner.modelId,
        // 两个流都结束之后再放行提交
        async *streamAgentMessage(req) { for await (const ev of inner.streamAgentMessage(req)) { if (ev.kind === 'done') { if (++done === 2) both.open(); await release.wait; } yield ev; } },
      };
    };
    const a = reasonOf(engine.summarize(h, ctx.sessionId, gatedOf()));
    const b = reasonOf(engine.summarize(h, ctx.sessionId, gatedOf()));
    await both.wait;
    release.open();
    expect([await a, await b].sort()).toEqual(['stale', 'written']);
    expect(markers(ctx.db, ctx.sessionId).markers).toHaveLength(1);
    expect(markers(ctx.db, ctx.sessionId).meta).toHaveLength(1);
  });
});

describe('验收 2：没有小节标题的自由文本（有条件地收）', () => {
  it('S10a 没有 marker、水位触发、标准锚点：写入，summary 与模型原文全等，form 是 text，程序记录照常生成', async () => {
    const ctx = mkCtx(dir);
    fourTurns(ctx);
    const m = await new CompactEngine(ctx.store).summarize(history(ctx), ctx.sessionId, summaryProvider('prose').provider);
    expect(m?.summary).toBe(PROSE_SUMMARY);
    expect(m?.meta).toMatchObject({ v: 2, model: { form: 'text', goal: '', constraints: [] }, coverage: { rule: 'recent-turns', messageCount: 2 } });
    expect(m!.meta!.evidence.userInstructions.map(u => u.text)).toEqual([`${C1}${C2}请开始整理`]);
    expect(ctx.store.getLatestCompactMarker(ctx.sessionId)).toEqual(m);
  });

  it('S10b 上一条是结构化的 M1：malformed，M1 仍是最新的有效 marker；随后的忠实摘要里 C1、C2 仍在', async () => {
    const { ctx, engine, prior } = await withPrior('M1');
    expect(prior.meta?.model.constraints).toEqual([C1, C2]);
    const before = freeze(ctx, engine);
    const err = await engine.summarize(history(ctx), ctx.sessionId, summaryProvider('prose').provider).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CompactRejectedError);
    expect(err).toMatchObject({ reason: 'malformed' });
    expect((err as Error).message).toContain('上一条压缩记录是结构化的');
    const sum = summaryProvider('faithful');
    expect(ctx.store.getLatestCompactMarker(ctx.sessionId)).toEqual(before.latest);
    const next = await engine.summarize(history(ctx), ctx.sessionId, sum.provider);
    // 【既有摘要】是 M1 的文本；约束沿用下来
    expect(String((sum.hits[0].messages as Body[])[1].content)).toContain(`【既有摘要】\n${prior.summary}\n`);
    const kept = [...next!.meta!.model.constraints, ...next!.meta!.model.carriedConstraints];
    expect(kept).toContain(C1); expect(kept).toContain(C2);
    expect(next!.meta!.coverage.prevMarkerId).toBe(prior.id);
  });

  it('S10c 上一条是旧文本 marker L1：写入，form 是 text；【既有摘要】是 L1 的文本', async () => {
    const { ctx, engine, prior } = await withPrior('L1');
    const sum = summaryProvider('prose');
    const m = await engine.summarize(history(ctx), ctx.sessionId, sum.provider);
    expect(m?.meta).toMatchObject({ model: { form: 'text' }, coverage: { prevMarkerId: prior.id } });
    expect(String((sum.hits[0].messages as Body[])[1].content)).toContain('【既有摘要】\nold free text summary of turn one\n');
    expect(m?.summary).toBe(PROSE_SUMMARY);
  });

  it('S10d 端点拒绝之后的压缩（overflow）与收紧锚点（tight）只收分节的摘要；同一历史按余量触发、标准锚点调用则写入（对照）', async () => {
    for (const prior of [undefined, 'L1'] as const) {
      const mk = async (): Promise<{ ctx: Ctx; engine: CompactEngine }> => {
        if (prior) return withPrior(prior);
        const ctx = mkCtx(dir); fourTurns(ctx); twoMore(ctx); ctx.reply('answer 6'); ctx.say('question 7');
        return { ctx, engine: new CompactEngine(ctx.store) };
      };
      for (const opts of [{ trigger: 'overflow' as const }, { rule: 'tight' as const }]) {
        const { ctx, engine } = await mk();
        const before = freeze(ctx, engine);
        const err = await engine.summarize(history(ctx), ctx.sessionId, summaryProvider('prose').provider, opts).then(() => undefined, (e: unknown) => e);
        expect(err, JSON.stringify(opts)).toMatchObject({ reason: 'malformed' });
        expect((err as Error).message).toContain('只接受分节的摘要');
        expect(markers(ctx.db, ctx.sessionId)).toEqual(before.rows);
      }
      const { ctx, engine } = await mk();
      const m = await engine.summarize(history(ctx), ctx.sessionId, summaryProvider('prose').provider, { trigger: 'relief', rule: 'standard' });
      expect(m?.meta?.model.form).toBe('text');
      // 分节的摘要在这两条路径上照常写入
      const t = await mk();
      const tight = await t.engine.summarize(history(t.ctx), t.ctx.sessionId, summaryProvider('faithful').provider, { rule: 'tight', trigger: 'overflow' });
      expect(tight?.meta).toMatchObject({ coverage: { rule: 'tight' }, record: { trigger: 'overflow' }, model: { form: 'structured' } });
      expect(anchorOf(history(t.ctx), tight!)).toBe(history(t.ctx).length - 5);
    }
  });
});

// ───────────────────────── 验收 3：其余夹具 ─────────────────────────

describe('验收 3：跨回合约束', () => {
  it('K2 第 1 回合的约束被摘要丢了（lossy）：压缩后的请求体里仍有它的原话；再压一次仍在；被覆盖的用户回合超过 6 个时首条仍在、未列出计数正确', async () => {
    const ctx = mkCtx(dir);
    ctx.say('只能改 docs/ 下的文件'); ctx.reply('好');
    for (let i = 2; i <= 6; i++) { ctx.say(`question ${i}`); ctx.reply(`answer ${i}`); }
    ctx.say('question 7');
    const engine = new CompactEngine(ctx.store);
    const first = await engine.summarize(history(ctx), ctx.sessionId, summaryProvider('lossy').provider);
    expect(first!.meta!.model.constraints).toEqual([]);
    let view = requestView(ctx, engine.buildEffectiveHistory(history(ctx), first));
    expect(view.summary!.sections.约束 ?? []).toEqual([]);
    expect(view.summary!.record!.instructions[0]).toBe('只能改 docs/ 下的文件');
    // 再压一次（上一条是 v2）：程序记录对整段重算，第 1 回合的原话仍在
    for (let i = 8; i <= 13; i++) { ctx.reply(`answer ${i - 1}`); ctx.say(`question ${i}`); }
    const second = await engine.summarize(history(ctx), ctx.sessionId, summaryProvider('lossy').provider);
    view = requestView(ctx, engine.buildEffectiveHistory(history(ctx), second));
    expect(view.summary!.record!.instructions[0]).toBe('只能改 docs/ 下的文件');
    // 覆盖了 10 个用户回合：列第一条加最近 5 条，另有 4 条未列出
    expect(second!.meta!.evidence).toMatchObject({ omittedInstructions: 4 });
    expect(view.summary!.record!.instructions).toEqual(['只能改 docs/ 下的文件', 'question 6', 'question 7', 'question 8', 'question 9', 'question 10']);
    expect(view.summary!.record!.raw).toContain('用户指示（较早的，原话，6 条，另有 4 条未列出）');
  });

  it('K2b 第一次摘要写了约束 C1、C2，第二次只写 C1：C2 进沿用的约束，请求体里有它', async () => {
    const ctx = mkCtx(dir);
    fourTurns(ctx);
    const engine = new CompactEngine(ctx.store);
    const sections = (constraints: string[]): string => `【目标】\n- 整理文档\n【约束】\n${constraints.map(c => `- ${c}`).join('\n')}\n【已完成】\n- （无）\n【进行中】\n- （无）\n【待办】\n- （无）\n【关键决策】\n- （无）\n【涉及文件】\n- （无）`;
    await engine.summarize(history(ctx), ctx.sessionId, fixedProvider(sections(['C1 只能改 docs/', 'C2 不要动 README'])).provider);
    twoMore(ctx);
    const second = await engine.summarize(history(ctx), ctx.sessionId, fixedProvider(sections(['C1 只能改 docs/'])).provider);
    expect(second!.meta!.model).toMatchObject({ constraints: ['C1 只能改 docs/'], carriedConstraints: ['C2 不要动 README'] });
    const view = requestView(ctx, engine.buildEffectiveHistory(history(ctx), ctx.store.getLatestCompactMarker(ctx.sessionId)));
    expect(view.summary!.record!.carriedConstraints).toEqual(['C2 不要动 README']);
    expect(view.summary!.sections.约束).toEqual(['C1 只能改 docs/']);
  });
});

describe('验收 3：纯图片用户消息与锚点', () => {
  let n = 0;
  const rawMsg = (role: 'user' | 'assistant', parts: RawMessage['parts']): RawMessage =>
    ({ id: `G${++n}`, sessionId: 's', role, parts, createdAt: n, updatedAt: n, sortOrder: n, streamInterruptCount: 0 });
  const text = (t: string): RawMessage => rawMsg('user', [{ type: 'text', value: t }]);
  const image = (name: string): RawMessage => rawMsg('user', [{ type: 'mediaRef', value: { id: name, relativePath: `attachments/${name}`, mimeType: 'image/png' } }]);
  const asst = (t: string): RawMessage => rawMsg('assistant', [{ type: 'text', value: t }]);
  /** F03 之前的规则锚点（冻结在这里）：数最近 3 个带文字的用户回合；不足 3 个且满 30 条取 length − 15。 */
  const oldAnchor = (h: RawMessage[]): number | undefined => {
    const idxs: number[] = [];
    for (let i = h.length - 1; i >= 0 && idxs.length < 3; i--) {
      const m = h[i];
      if (m.role === 'user' && m.parts.some(p => p.type === 'text') && !m.parts.some(p => p.type === 'toolResult')) idxs.push(i);
    }
    if (idxs.length >= 3) return idxs[2] - 1;
    return h.length >= 30 ? h.length - 15 : undefined;
  };

  it('K3 定值：文字回合在 2 / 10 / 20 / 30、纯图回合在 25——锚点是 9，与旧实现相同；下标 10 的指示与下标 25 的图片都在锚点之后的原文里', () => {
    const h: RawMessage[] = [];
    for (let i = 0; i <= 30; i++) h.push(i === 25 ? image('mid.png') : [2, 10, 20, 30].includes(i) ? text(`instruction at ${i}`) : asst(`reply ${i}`));
    const range = pendingSummaryRange(h, undefined)!;
    expect(range).toEqual({ from: 0, to: 9, rule: 'recent-turns' });
    expect(oldAnchor(h)).toBe(9);
    const eff = new CompactEngine(undefined as never).buildEffectiveHistory(h, { id: 'K', sessionId: 's', summary: 'S', lastCompactedMessageId: h[9].id, createdAt: 99 });
    expect(eff[0].parts).toHaveLength(1);
    expect(eff[1]).toEqual({ role: 'user', parts: [{ type: 'text', value: 'instruction at 10' }] });
    expect(eff.some(m => m.parts.some(p => p.type === 'mediaRef'))).toBe(true);
  });

  it('K3 性质（固定种子 100 份夹杂纯图回合的历史）：锚点不晚于旧实现算出的锚点；拆对时只会更早一条', () => {
    let seed = 4242;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let k = 0; k < 100; k++) {
      const h: RawMessage[] = [];
      const len = 5 + Math.floor(rnd() * 50);
      while (h.length < len) {
        const r = rnd();
        if (r < 0.2) h.push(text(`t${h.length}`));
        else if (r < 0.35) h.push(image(`i${h.length}.png`));
        else if (r < 0.7) {
          const id = `U${k}_${h.length}`;
          h.push(rawMsg('assistant', [{ type: 'toolUse', value: { toolUseId: id, name: 'echo', input: '{}' } }]));
          h.push(rawMsg('user', [{ type: 'toolResult', value: { toolUseId: id, output: 'ok', success: true, status: 'success' } }]));
        } else h.push(asst(`a${h.length}`));
      }
      const got = pendingSummaryRange(h, undefined);
      const old = oldAnchor(h);
      if (old === undefined || old < 0) { expect(got, `#${k}`).toBeUndefined(); continue; }
      if (!got) { expect(old, `#${k}`).toBeLessThanOrEqual(0); continue; }
      expect(got.to, `#${k}`).toBeLessThanOrEqual(old);
      expect(got.to, `#${k}`).toBeGreaterThanOrEqual(old - 1);
      expect(splitsPair(h, got.to), `#${k}`).toBe(false);
    }
  });

  it('K3d 压缩之后用户又发了新消息：收尾句改成「以新消息为准」；随摘要带上的图片按轮老化（与不压缩时相同）；marker 与 meta 的行不变', async () => {
    const ctx = mkCtx(dir);
    ctx.add('user', [ctx.file('shot.png', pngBytes(800, 600))]);
    for (let j = 1; j <= 20; j++) ctx.call(`P${j}`, 'echo', { text: `r${j}`, tool_title: `step ${j}` }, `result-${j}`);
    const engine = new CompactEngine(ctx.store);
    await engine.summarize(history(ctx), ctx.sessionId, summaryProvider('faithful').provider);
    const rows = markers(ctx.db, ctx.sessionId);
    const effective = (): AgentMessage[] => engine.buildEffectiveHistory(history(ctx), ctx.store.getLatestCompactMarker(ctx.sessionId));
    const needs = () => countImageNeeds(buildRequestMessages(effective(), new Map(), rel => join(ctx.paths.sessionBucket(ctx.sessionId, 'attachments'), basename(rel))));
    expect(requestView(ctx, effective()).summary!.carried!.closing).toBe('最后一条就是当前这一轮的用户指示。');
    expect(needs()).toEqual({ currentImages: 1, historyImages: 0 });

    // 第 1 条新消息之后：那条图片消息已是答复过的旧指示；图片仍随摘要消息发（上一轮的图）
    ctx.reply('here is what the picture shows'); ctx.say('new question one');
    let view = requestView(ctx, effective());
    expect(view.summary!.carried!.closing).toBe('之后用户又发了新消息（见下文），有出入时以新消息为准。');
    expect(view.summary!.text).not.toContain('当前这一轮');
    expect(view.images[0]).toBe(1);
    expect(needs()).toEqual({ currentImages: 0, historyImages: 1 });
    expect(view.messages.at(-1)).toEqual({ role: 'user', content: 'new question one' });

    // 第 2 条新消息之后：图片换成占位文字（最近两轮之外）
    ctx.reply('answer one'); ctx.say('new question two');
    view = requestView(ctx, effective());
    expect(view.images[0]).toBe(0);
    expect(view.summary!.text).toContain('[图片 shot.png 已随上下文省略]');
    expect(needs()).toEqual({ currentImages: 0, historyImages: 0 });
    // 第 3 条新消息之后：它退出保留回合，不再带原话（回到程序记录的用户指示列表里）
    ctx.reply('answer two'); ctx.say('new question three');
    view = requestView(ctx, effective());
    expect(view.summary!.carried).toBeUndefined();
    expect(view.summary!.record!.instructions[0]).toContain('[图片 shot.png]');
    expect(markers(ctx.db, ctx.sessionId)).toEqual(rows);
  });

  it('K3c 最后一条用户消息是纯图片时的接力草稿：写明是图片与文件名，不写「没有找到用户消息」', () => {
    const ctx = mkCtx(dir);
    ctx.add('user', [ctx.file('shot.png', pngBytes(64, 64))]);
    ctx.reply('看到了');
    const draft = buildRelayDraft(ctx.store, ctx.sessionId, history(ctx));
    expect(draft).toContain('（最后一条消息是图片：shot.png，请在新会话重新添加）');
    expect(draft).not.toContain('没有找到用户消息');
  });
});

describe('验收 3：旧 marker 与同步来的 marker', () => {
  it('K5b 旧文本 marker 之上压一次：程序记录对整段重算，旧锚点之前成功的写入也在；覆盖从 history[0] 起', async () => {
    const ctx = mkCtx(dir);
    ctx.say('start'); ctx.call('W1', 'file_write', { path: 'docs/early.md', content: 'x', tool_title: 'write early' }, '已写入'); ctx.reply('answer 1');
    ctx.say('question 2'); ctx.reply('answer 2'); ctx.say('question 3'); ctx.reply('answer 3'); ctx.say('question 4');
    const old = ctx.store.appendCompactMarker(ctx.sessionId, 'OLD TEXT SUMMARY', history(ctx)[3].id);
    expect(ctx.store.getLatestCompactMarker(ctx.sessionId)).toEqual(old);
    expect('meta' in ctx.store.getLatestCompactMarker(ctx.sessionId)!).toBe(false);
    twoMore(ctx);
    const sum = summaryProvider('faithful');
    const m = await new CompactEngine(ctx.store).summarize(history(ctx), ctx.sessionId, sum.provider);
    expect(m!.meta!.evidence.fileChanges.map(f => f.path)).toEqual(['docs/early.md']);
    expect(m!.meta!.coverage).toMatchObject({ fromMessageId: history(ctx)[0].id, prevMarkerId: old.id });
    expect(String((sum.hits[0].messages as Body[])[1].content)).toContain('【既有摘要】\nOLD TEXT SUMMARY\n');
  });

  it('K5c v2 marker 的 summary 或锚点被改写过（同步 LWW）：meta 作废，退化成旧 marker，不抛错', async () => {
    for (const column of ['summary', 'last_compacted_message_id'] as const) {
      const { ctx, engine, prior } = await withPrior('M1');
      expect(ctx.store.getLatestCompactMarker(ctx.sessionId)?.meta).toBeDefined();
      const value = column === 'summary' ? 'rewritten by a peer' : history(ctx)[0].id;
      ctx.db.prepare(`UPDATE compact_markers SET ${column}=? WHERE id=?`).run(value, prior.id);
      const got = ctx.store.getLatestCompactMarker(ctx.sessionId)!;
      expect('meta' in got).toBe(false);
      const view = requestView(ctx, engine.buildEffectiveHistory(history(ctx), got));
      expect(view.summary!.record).toBeUndefined();
      expect(view.summary!.text).not.toContain('【程序记录】');
    }
  });

  it('K5d 同步到另一库的 tight marker（buildPushBatches → mergeRemoteSession，对端没有 meta 行）：对端发出的请求体里没有程序记录，但被盖住的最近用户回合仍是原话全文、最新一条的图片在，与有 meta 的一侧逐字相同', async () => {
    const TWO = `turn two: ${'detail '.repeat(1_500)}END-OF-TWO`;
    const a = mkCtx(dir);
    a.say('turn one: 整理 docs/'); a.reply('answer 1');
    a.say(TWO); a.reply('answer 2');
    a.add('user', [{ type: 'text', value: 'turn three with a picture' }, a.file('shot.png', pngBytes(320, 200))]);
    for (let j = 1; j <= 3; j++) a.call(`X${j}`, 'echo', { text: `r${j}`, tool_title: `step ${j}` }, `result-${j}`);
    const engineA = new CompactEngine(a.store);
    const marker = await engineA.summarize(history(a), a.sessionId, summaryProvider('faithful').provider, { rule: 'tight', trigger: 'overflow' });
    expect(marker!.meta!.coverage.rule).toBe('tight');
    expect(anchorOf(history(a), marker!)).toBe(6);
    expect(markers(a.db, a.sessionId).meta).toHaveLength(1);

    // 另一台设备：空库，用 A 的推送批次合并进来（meta 不上同步线路）；附件文件按 F11A 的做法落到对端同一会话的 attachments 桶
    const batches = a.store.buildPushBatches(a.sessionId);
    expect(JSON.stringify(batches)).not.toContain('coverage');
    const b = mkCtx(join(dir, 'peer'), { sessionId: a.sessionId });
    for (const batch of batches) b.store.mergeRemoteSession(batch, a.sessionId);
    copyFileSync(join(a.paths.sessionBucket(a.sessionId, 'attachments'), 'shot.png'), join(b.paths.sessionBucket(b.sessionId, 'attachments'), 'shot.png'));
    expect(history(b).map(m => [m.id, m.role, m.parts])).toEqual(history(a).map(m => [m.id, m.role, m.parts]));
    const rowsB = markers(b.db, b.sessionId);
    expect(rowsB.markers).toMatchObject([{ id: marker!.id, summary: marker!.summary, last_compacted_message_id: marker!.lastCompactedMessageId }]);
    expect(rowsB.meta).toEqual([]);
    expect('meta' in b.store.getLatestCompactMarker(b.sessionId)!).toBe(false);

    // 两边各接着跑下一轮（不追加新消息）：真循环发出的第一个请求体
    const catalog = await mkCatalog(dir);
    const cfg = relay(1_000_000, { capabilityOverrides: { imageInput: true } });
    const firstBody = async (ctx: Ctx): Promise<ReturnType<typeof bodyView>> => {
      const ep = strictEndpoint({ limit: 10_000_000, main: (_b, info) => openaiOk('ok', info.usage) });
      const { events } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, ep.fetchImpl), input: cfg } });
      expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
      expect(ep.hits).toHaveLength(1);
      return bodyView(ep.hits[0].body);
    };
    const viewA = await firstBody(a);
    const viewB = await firstBody(b);
    expect(viewA.summary!.record).toBeDefined();
    expect(viewB.summary!.record).toBeUndefined();
    expect(viewB.summary!.text).not.toContain('【程序记录】');
    // 「保留的用户原话」段两边逐字相同：三个被盖住的用户回合都是原话全文（6,000 多字符的那条没有被截断），收尾句指明最后一条是当前这一轮
    expect(viewB.summary!.carried).toEqual(viewA.summary!.carried);
    expect(viewB.summary!.carried!.quotes).toEqual(['turn one: 整理 docs/', TWO, 'turn three with a picture']);
    expect(viewB.summary!.carried!.closing).toBe('最后一条就是当前这一轮的用户指示。');
    // 最新一条的图片块在摘要消息里（对端读的是合并进来的附件文件）
    expect(viewB.images[0]).toBe(1);
    expect(viewB.images).toEqual(viewA.images);
    // 锚点之后的原文两边相同；模型写的那一半也相同（同一条 marker 的 summary）
    expect(viewB.summary!.model).toBe(viewA.summary!.model);
    expect(viewB.messages.slice(1)).toEqual(viewA.messages.slice(1));
    // 跑这一轮没有给对端补出 meta 行
    expect(markers(b.db, b.sessionId).meta).toEqual([]);
  });

  it('K7 结果未知 / 已取消的调用：摘要请求正文照实写四态；程序记录里它们不算文件变更', async () => {
    const ctx = mkCtx(dir);
    ctx.say('start');
    ctx.call('A', 'file_write', { path: 'a.md', content: 'x', tool_title: 'w' }, '[已取消]', { success: false, status: 'cancelled' });
    ctx.call('B', 'shell_execute', { command: 'x', tool_title: 'run it' }, '[结果未知]', { success: false, status: 'unknown' });
    ctx.call('C', 'file_write', { path: 'c.md', content: 'x', tool_title: 'w' }, '已写入');
    ctx.call('D', 'file_write', { path: 'd.md', content: 'x', tool_title: 'w' }, 'EACCES', { success: false });
    ctx.reply('answer 1'); ctx.say('question 2'); ctx.reply('answer 2'); ctx.say('question 3'); ctx.reply('answer 3'); ctx.say('question 4');
    const sum = summaryProvider('faithful');
    const m = await new CompactEngine(ctx.store).summarize(history(ctx), ctx.sessionId, sum.provider);
    const text = String((sum.hits[0].messages as Body[])[1].content);
    expect(text).toContain('[工具结果·已取消] [已取消]');
    expect(text).toContain('[工具结果·结果未知] [结果未知]');
    expect(text).toContain('[工具结果·成功] 已写入');
    expect(text).toContain('[工具结果·失败] EACCES');
    expect(m!.meta!.evidence).toMatchObject({ unsettledCalls: 2, fileChanges: [{ path: 'c.md' }], runs: [{ tool: 'shell_execute', state: 'unknown', title: 'run it' }] });
  });
});

describe('toolUseId 不唯一的会话（端点按响应内序号发 id，或不给 id）照常压缩', () => {
  for (const id of ['call_0', 'functions.file_write:0', '']) {
    for (const mode of ['faithful', 'prose'] as const) {
      it(`K8 跨轮复用 id ${JSON.stringify(id)}、较早那次写入失败之后才成功（${mode} 摘要）：marker 写入，文件变更是成功的那次`, async () => {
        const ctx = mkCtx(dir);
        ctx.say('write the report');
        ctx.call(id, 'file_write', { path: 'out', content: 'x', tool_title: 'wrong path' }, 'EISDIR: illegal operation on a directory', { success: false });
        ctx.call(id, 'file_write', { path: 'out/a.md', content: 'x', tool_title: 'right path' }, '已写入 out/a.md');
        ctx.reply('answer 1'); ctx.say('question 2'); ctx.reply('answer 2'); ctx.say('question 3'); ctx.reply('answer 3'); ctx.say('question 4');
        const h = history(ctx);
        const engine = new CompactEngine(ctx.store);
        const sum = summaryProvider(mode);
        // 校验按 id 在整段历史里取第一条调用的话，取到的是失败的那次：这里会抛 invalid，付了一次摘要请求却写不下 marker
        const m = await engine.summarize(h, ctx.sessionId, sum.provider);
        expect(sum.hits).toHaveLength(1);
        expect(m?.meta?.evidence.fileChanges).toEqual([{ path: 'out/a.md', tool: 'file_write', count: 1, lastToolUseId: id, lastMessageId: h[3].id }]);
        expect(markers(ctx.db, ctx.sessionId)).toMatchObject({ markers: [{ id: m!.id }], meta: [{ marker_id: m!.id }] });
        expect(validateCompactMeta(m!.meta!, m!.summary, h, undefined, defaultToolKindOf)).toEqual([]);
        // 压缩后的请求体：程序记录的文件变更只有成功写入的那个路径
        expect(requestView(ctx, engine.buildEffectiveHistory(h, m)).summary!.record!.fileChanges).toEqual(['out/a.md']);
      });
    }
  }

  it('K8b 同一批里两个 file_write 的 id 相同、第一个成功第二个失败：失败的路径不进「文件变更」，也不随请求发给主模型', async () => {
    const ctx = mkCtx(dir);
    ctx.say('write both files');
    ctx.add('assistant', ['out/ok.md', 'out/bad.md'].map(path => ({ type: 'toolUse' as const, value: { toolUseId: 'dup', name: 'file_write', input: JSON.stringify({ path, content: 'x', tool_title: 'w' }) } })));
    ctx.add('user', [
      { type: 'toolResult', value: { toolUseId: 'dup', output: '已写入 out/ok.md', success: true, status: 'success' } },
      { type: 'toolResult', value: { toolUseId: 'dup', output: 'EACCES', success: false, status: 'failed' } },
    ]);
    ctx.reply('answer 1'); ctx.say('question 2'); ctx.reply('answer 2'); ctx.say('question 3'); ctx.reply('answer 3'); ctx.say('question 4');
    const h = history(ctx);
    const engine = new CompactEngine(ctx.store);
    const m = await engine.summarize(h, ctx.sessionId, summaryProvider('prose').provider);
    expect(m!.meta!.evidence.fileChanges.map(f => f.path)).toEqual(['out/ok.md']);
    const view = requestView(ctx, engine.buildEffectiveHistory(h, m));
    expect(view.summary!.record!.fileChanges).toEqual(['out/ok.md']);
    expect(view.summary!.record!.raw).not.toContain('out/bad.md');
  });
});

describe('程序记录里的用户指示：切点落在 emoji 中间', () => {
  it('K9 第一条用户消息 901 码元、尾段起点正是代理对的低半：meta、压缩后的请求体与接力草稿里都没有孤立代理项', async () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const ctx = mkCtx(dir);
    ctx.say(`${'a'.repeat(700)}😀${'b'.repeat(199)}`); ctx.reply('answer 1');
    for (let i = 2; i <= 5; i++) { ctx.say(`question ${i}`); ctx.reply(`answer ${i}`); }
    ctx.say('question 6');
    const engine = new CompactEngine(ctx.store);
    await engine.summarize(history(ctx), ctx.sessionId, summaryProvider('faithful').provider);
    // 读回来的 marker（指纹相符，meta 照用）
    const m = ctx.store.getLatestCompactMarker(ctx.sessionId)!;
    const ins = m.meta!.evidence.userInstructions[0];
    expect(ins).toMatchObject({ clipped: true, text: `${'a'.repeat(600)}…${'b'.repeat(199)}` });
    expect(lone.test(ins.text)).toBe(false);
    // 这条指示不在保留回合里（之后还有 5 个用户回合），随程序记录进之后每一次请求
    const attDir = ctx.paths.sessionBucket(ctx.sessionId, 'attachments');
    const body = buildOpenAIBody({
      messages: buildRequestMessages(engine.buildEffectiveHistory(history(ctx), m), new Map(), rel => join(attDir, basename(rel))),
      systemPrompt: 'sys', tools: [], maxTokens: 1_024, thinkingLevel: 'off',
    }, 'm') as Body;
    const view = bodyView(body, false);
    expect(view.summary!.record!.instructions[0]).toBe(`${ins.text}（原话过长，已省略中间部分）`);
    expect(lone.test(view.summary!.text)).toBe(false);
    // JSON.stringify 只把孤立的代理项写成 \udXXX 转义（成对的原样输出）：线上的 JSON 里不该有这种转义
    expect(JSON.stringify(body)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    expect(lone.test(buildRelayDraft(ctx.store, ctx.sessionId, history(ctx)))).toBe(false);
  });
});

describe('陈述核对（summarize 级）', () => {
  it('S11 只读过的路径、写入失败的路径上的「已修改」不进 marker 与之后的请求；带日期与斜杠列举的真实条目留下', async () => {
    const ctx = mkCtx(dir);
    ctx.say('重写调度逻辑');
    ctx.call('R1', 'file_read', { path: 'src/core/engine.ts', tool_title: 'read' }, 'export const x = 1');
    ctx.call('W1', 'file_write', { path: 'src/core/broken.ts', content: 'x', tool_title: 'write' }, 'EACCES', { success: false });
    ctx.call('S1', 'shell_execute', { command: 'dir', tool_title: 'list' }, 'a b c');
    ctx.reply('answer 1'); ctx.say('question 2'); ctx.reply('answer 2'); ctx.say('question 3'); ctx.reply('answer 3'); ctx.say('question 4');
    const reply = [
      '【目标】', '- 重写调度逻辑', '【约束】', '- （无）',
      '【已完成】', '- 已修改 src/core/engine.ts，重写了调度逻辑', '- 已修改 src/core/broken.ts', '- 于 2026/10/04 完成了部署配置的梳理', '- 梳理了增/删/改三类接口的调用关系', '- 测试全部通过',
      '【进行中】', '- （无）', '【待办】', '- （无）', '【关键决策】', '- （无）',
      '【涉及文件】', '- src/core/engine.ts', '- src/core/broken.ts',
    ].join('\n');
    const engine = new CompactEngine(ctx.store);
    const m = await engine.summarize(history(ctx), ctx.sessionId, fixedProvider(reply).provider);
    const kept = ['于 2026/10/04 完成了部署配置的梳理', '梳理了增/删/改三类接口的调用关系', '测试全部通过（验证结论是模型的陈述，程序没有核对）'];
    expect(m!.meta!.model).toMatchObject({ done: kept, files: ['src/core/engine.ts', 'src/core/broken.ts'], dropped: { unverified: 2 } });
    expect(m!.meta!.evidence.fileChanges).toEqual([]);
    // 同步给对端的 summary 与压缩后的请求体里都没有那两条
    expect(m!.summary).not.toContain('已修改');
    const view = requestView(ctx, engine.buildEffectiveHistory(history(ctx), m));
    expect(view.summary!.sections.已完成).toEqual(kept);
    expect(view.summary!.text).not.toContain('已修改');
    expect(view.summary!.sections.涉及文件).toEqual(['src/core/engine.ts', 'src/core/broken.ts']);
  });

  /** 七个小节的回复（约束、关键决策为空）。 */
  const sectionsReply = (o: { goal: string; done: string[]; current?: string; todo?: string[]; files: string[] }): string => [
    '【目标】', `- ${o.goal}`, '【约束】', '- （无）',
    '【已完成】', ...o.done.map(x => `- ${x}`),
    '【进行中】', `- ${o.current ?? '（无）'}`, '【待办】', ...(o.todo?.length ? o.todo.map(x => `- ${x}`) : ['- （无）']), '【关键决策】', '- （无）',
    '【涉及文件】', ...o.files.map(x => `- ${x}`),
  ].join('\n');

  it('S12 只读排查的会话（只有成功的 file_read）：如实写的「已阅读 X，定位到根因…」「检查了 X，确认…」留在 marker 与压缩后的请求体里，【进行中】不挪走；同一路径上的「已修改」仍不进', async () => {
    const LOOP = 'src/minisd/agent/loop.ts'; const COMPACT = 'src/minisd/agent/compact.ts';
    const ctx = mkCtx(dir);
    ctx.say('排查压缩为什么不记 skipped');
    ctx.call('R1', 'file_read', { path: LOOP, tool_title: 'read loop' }, 'export function runAgentLoop() {}');
    ctx.call('R2', 'file_read', { path: COMPACT, tool_title: 'read compact' }, 'export class CompactEngine {}');
    ctx.reply('answer 1'); ctx.say('question 2'); ctx.reply('answer 2'); ctx.say('question 3'); ctx.reply('answer 3'); ctx.say('question 4');
    // 第二条的路径两侧只有反引号、没有空格（中文行文的常见写法）
    const findings = [`已阅读 ${LOOP}，定位到根因：canCompact 在事故外不记 skipped`, `检查了\`${COMPACT}\`，确认 summarize 的取材上限是 100,000`];
    const current = `正在核对 ${LOOP} 的 abandonSameSlot`;
    const reply = sectionsReply({ goal: '排查压缩为什么不记 skipped', done: [...findings, `已修改 ${LOOP} 的 canCompact`], current, todo: ['向用户汇报结论'], files: [LOOP, COMPACT] });
    const engine = new CompactEngine(ctx.store);
    const m = await engine.summarize(history(ctx), ctx.sessionId, fixedProvider(reply).provider);
    expect(m!.meta!.model).toMatchObject({ done: findings, current, todo: ['向用户汇报结论'], files: [LOOP, COMPACT], dropped: { unverified: 1 } });
    expect(m!.meta!.evidence.fileChanges).toEqual([]);
    // 同步给对端的 summary 里有结论、没有编造的修改
    expect(m!.summary).toContain('定位到根因：canCompact 在事故外不记 skipped');
    expect(m!.summary).toContain('确认 summarize 的取材上限是 100,000');
    expect(m!.summary).not.toContain('已修改');
    // 压缩后发给主模型的请求体：结论与当前步骤都在各自的小节里，程序记录没有文件变更
    const view = requestView(ctx, engine.buildEffectiveHistory(history(ctx), m));
    expect(view.summary!.sections.已完成).toEqual(findings);
    expect(view.summary!.sections.进行中).toEqual([current]);
    expect(view.summary!.sections.待办).toEqual(['向用户汇报结论']);
    expect(view.summary!.text).not.toContain('已修改');
    expect(view.summary!.record!.fileChanges).toEqual([]);
  });

  it('F03 close R2-1: read-only findings retain names containing modification words in the marker and next request', async () => {
    const file = 'src/core/update-status.ts';
    const ctx = mkCtx(dir);
    ctx.say('Review the deletion flow without changing files');
    ctx.call('R1', 'file_read', { path: file, tool_title: 'read' }, 'deleteSession reads createdAt; append-only log');
    ctx.reply('answer 1'); ctx.say('question 2'); ctx.reply('answer 2'); ctx.say('question 3'); ctx.reply('answer 3'); ctx.say('question 4');
    const findings = [
      `已阅读 ${file}，确认 deleteSession 按 createdAt 排序，日志是 append-only`,
      `Read ${file} and located the delete_session call in Store.deleteSession`,
      `检查了\`${file}\`，确认字段 \`createdAt\` 与函数 \`update\` 的调用关系`,
    ];
    const current = `正在核对 ${file} 中 deleteSession 的 createdAt 条件`;
    const falseClaims = [`已修改 ${file} 的 deleteSession`, `Updated ${file} to fix the deletion flow`];
    const reply = sectionsReply({ goal: 'Review deletion flow', done: [...findings, ...falseClaims], current, todo: ['向用户汇报结论'], files: [file] });
    const engine = new CompactEngine(ctx.store);
    const m = await engine.summarize(history(ctx), ctx.sessionId, fixedProvider(reply).provider);
    expect(m!.meta!.model).toMatchObject({ done: findings, current, todo: ['向用户汇报结论'], dropped: { unverified: 2 } });
    expect(m!.meta!.evidence.fileChanges).toEqual([]);
    const view = requestView(ctx, engine.buildEffectiveHistory(history(ctx), m));
    expect(view.summary!.sections.已完成).toEqual(findings);
    expect(view.summary!.sections.进行中).toEqual([current]);
    expect(view.summary!.record!.fileChanges).toEqual([]);
    for (const text of falseClaims) expect(view.summary!.text).not.toContain(text);
  });

  it('S13 读 A 改 B（file_read A 成功、file_edit B 成功）：「参照 A 的写法，在 B 里新增了…」留在 marker 与请求体里，「已修改 A」仍移除，文件变更只有 B', async () => {
    const LOOP = 'src/minisd/agent/loop.ts'; const COMPACT = 'src/minisd/agent/compact.ts';
    const ctx = mkCtx(dir);
    ctx.say('给 summarize 加 rule 参数');
    ctx.call('R1', 'file_read', { path: LOOP, tool_title: 'read loop' }, 'export function runAgentLoop() {}');
    ctx.call('E1', 'file_edit', { path: COMPACT, old_string: 'summarize(', new_string: 'summarize(rule, ', tool_title: 'edit compact' }, '已修改 1 处');
    ctx.reply('answer 1'); ctx.say('question 2'); ctx.reply('answer 2'); ctx.say('question 3'); ctx.reply('answer 3'); ctx.say('question 4');
    const kept = [`参照 ${LOOP} 的写法，在 ${COMPACT} 的 summarize 里新增了 rule 参数`, `在\`${COMPACT}\`里补上了注释`];
    const reply = sectionsReply({ goal: '给 summarize 加 rule 参数', done: [kept[0], `已修改 ${LOOP}`, kept[1]], files: [LOOP, COMPACT] });
    const engine = new CompactEngine(ctx.store);
    const m = await engine.summarize(history(ctx), ctx.sessionId, fixedProvider(reply).provider);
    expect(m!.meta!.model).toMatchObject({ done: kept, dropped: { unverified: 1 } });
    expect(m!.meta!.evidence.fileChanges).toMatchObject([{ path: COMPACT, tool: 'file_edit', count: 1 }]);
    expect(m!.summary).toContain('新增了 rule 参数');
    expect(m!.summary).not.toContain(`已修改 ${LOOP}`);
    const view = requestView(ctx, engine.buildEffectiveHistory(history(ctx), m));
    expect(view.summary!.sections.已完成).toEqual(kept);
    expect(view.summary!.text).not.toContain(`已修改 ${LOOP}`);
    // 哪些文件确实被工具改过，以程序记录为准：只有 B
    expect(view.summary!.record!.fileChanges).toEqual([COMPACT]);
  });
});

describe('验收 3：性质——不丢消息、不拆对、保留回合全文都在', () => {
  it('K6 固定种子 200 份随机历史 × 两种规则 × 有无旧 marker', () => {
    let seed = 777;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const engine = new CompactEngine(undefined as never);
    let n = 0; let checked = 0;
    const rawMsg = (role: 'user' | 'assistant', parts: RawMessage['parts']): RawMessage =>
      ({ id: `Q${++n}`, sessionId: 's', role, parts, createdAt: n, updatedAt: n, sortOrder: n, streamInterruptCount: 0 });
    for (let k = 0; k < 200; k++) {
      const h: RawMessage[] = []; const tags: string[][] = [];
      const len = 6 + Math.floor(rnd() * 55);
      while (h.length < len) {
        const i = h.length; const r = rnd();
        if (r < 0.18) {
          // 用户文字回合；其中一部分超过 6,000 字符（首、中、尾各有标签）
          const long = rnd() < 0.3;
          const t = long ? `#h${k}_${i}# ${'x'.repeat(3_500)} #m${k}_${i}# ${'y'.repeat(3_500)} #t${k}_${i}#` : `#h${k}_${i}# short ask`;
          h.push(rawMsg('user', [{ type: 'text', value: t }])); tags.push(long ? [`#h${k}_${i}#`, `#m${k}_${i}#`, `#t${k}_${i}#`] : [`#h${k}_${i}#`]);
        } else if (r < 0.28) {
          h.push(rawMsg('user', [{ type: 'mediaRef', value: { id: 'x', relativePath: `attachments/img-${k}-${i}.png`, mimeType: 'image/png' } }])); tags.push([`img-${k}-${i}.png`]);
        } else if (r < 0.7) {
          const id = `C${k}_${i}`;
          h.push(rawMsg('assistant', [{ type: 'toolUse', value: { toolUseId: id, name: 'echo', input: JSON.stringify({ tool_title: `#u${k}_${i}#` }) } }])); tags.push([`#u${k}_${i}#`]);
          h.push(rawMsg('user', [{ type: 'toolResult', value: { toolUseId: id, output: `#r${k}_${i + 1}# out`, success: true, status: 'success' } }])); tags.push([`#r${k}_${i + 1}#`]);
        } else { h.push(rawMsg('assistant', [{ type: 'text', value: `#a${k}_${i}# reply` }])); tags.push([`#a${k}_${i}#`]); }
      }
      for (const rule of ['standard', 'tight'] as const) {
        for (const withOld of [false, true]) {
          const first = withOld ? pendingSummaryRange(h.slice(0, Math.max(8, Math.floor(h.length / 2))), undefined, 'standard') : undefined;
          if (withOld && !first) continue;
          const old: CompactMarker | undefined = first ? { id: 'OLD', sessionId: 's', summary: 'OLD', lastCompactedMessageId: h[first.to].id, createdAt: 1e9 } : undefined;
          const range = pendingSummaryRange(h, old, rule);
          if (!range) continue;
          checked++;
          const label = `#${k} ${rule} old=${withOld}`;
          // I10：不拆对、锚点之后至少 2 条、增量紧接上一个锚点
          expect(splitsPair(h, range.to), label).toBe(false);
          expect(range.to, label).toBeLessThanOrEqual(h.length - 3);
          expect(range.from, label).toBe(first ? first.to + 1 : 0);
          // 下标 ≤ 锚点的每条消息：标签在摘要请求正文里，或属于既有覆盖
          const request = flattenForSummary(old?.summary, h.slice(range.from, range.to + 1));
          for (let i = range.from; i <= range.to; i++) expect(request, `${label} msg ${i}`).toContain(tags[i][0]);
          // 下标 > 锚点的每条消息都在有效历史里
          const eff = engine.buildEffectiveHistory(h, { id: 'NEW', sessionId: 's', summary: 'NEW', lastCompactedMessageId: h[range.to].id, createdAt: 2e9 });
          const effText = JSON.stringify(eff);
          for (let i = range.to + 1; i < h.length; i++) for (const t of tags[i]) expect(effText, `${label} msg ${i}`).toContain(t);
          // 保留回合（最近 3 个真用户回合 ∪ 最近 3 个含纯图片的用户回合）全文都在：锚点之后的原文，或「保留的用户原话」段
          const real: number[] = []; const any: number[] = [];
          for (let i = h.length - 1; i >= 0; i--) {
            const m = h[i];
            if (m.role !== 'user' || m.parts.some(p => p.type === 'toolResult')) continue;
            if (any.length < 3) any.push(i);
            if (real.length < 3 && m.parts.some(p => p.type === 'text')) real.push(i);
          }
          for (const i of new Set([...real, ...any])) for (const t of tags[i]) expect(effText, `${label} kept turn ${i}`).toContain(t);
          if (range.rule === 'recent-turns') expect(effText, label).not.toContain('【保留的用户原话】');
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});
