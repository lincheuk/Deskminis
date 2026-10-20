/**
 * F03 的纯函数：拒绝上限（lowerCeiling / rescale / applyCeiling）、overflowHint、摘要答复解析与陈述核对、
 * 请求侧裁剪、程序记录与「保留的用户原话」的渲染、meta 校验。不发请求、不碰存储。
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_REQUEST_OUTPUT, OUTPUT_RESERVE, buildRequestBudget, type LimitProfile, type RequestBudget,
} from '../src/shared/request-budget';
import { COMPACT_CAPS, RECOVERY_LIMITS, type CompactMeta } from '../src/shared/compaction';
import { applyCeiling, lowerCeiling, rescale, type RejectionCeiling } from '../src/minisd/agent/request-budget';
import { overflowHint } from '../src/minisd/providers/overflow';
import { pruneOldToolResults, trimForRequest } from '../src/minisd/agent/prune';
import {
  buildCompactMeta, checkClaims, collectEvidence, defaultToolKindOf, parseCompactMeta, parseSummaryReply, pathTokens, renderEngineRecord,
  renderModelPart, summaryDigestOf, summaryPrompt, validateCompactMeta, type ParsedReply,
} from '../src/minisd/agent/compact-meta';
import { CompactEngine, carriedUserTurns, pendingSummaryRange } from '../src/minisd/agent/compact';
import type { AgentMessage, CompactMarker, ContentPart, RawMessage } from '../src/shared/types';

// ───────────────────────── 夹具 ─────────────────────────

/** 固定种子的伪随机（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const limitsOf = (o: Partial<LimitProfile> & { window: number; cap: number; kind?: 'shared' | 'separate' }): LimitProfile => ({
  kind: o.kind ?? 'shared', inputLimit: o.inputLimit ?? o.window, ...((o.kind ?? 'shared') === 'shared' ? { sharedWindow: o.window } : {}),
  outputCap: o.cap, windowKnown: o.windowKnown ?? true, authority: o.authority ?? 'manual', basis: 'window', note: 'n',
});
interface BudgetSpec { text: number; limits: LimitProfile; pref?: number; ratio?: number; calibrated?: boolean; obs?: number; system?: number }
const budgetOf = (s: BudgetSpec): RequestBudget => buildRequestBudget({
  slot: { label: 'L', modelId: 'm', key: 'k' },
  measure: { system: s.system ?? 0, systemStable: 0, tools: 0, toolCount: 0, history: s.text, reasoningReplay: 0, media: [] },
  limits: s.limits,
  calibration: { ratio: s.ratio ?? 1, calibrated: s.calibrated ?? false, ...(s.obs !== undefined ? { observedMaxInput: s.obs } : {}) },
  preference: { tokens: s.pref ?? s.limits.outputCap, source: 'default' },
});

let seq = 0;
const raw = (role: 'user' | 'assistant', parts: ContentPart[]): RawMessage =>
  ({ id: `M${++seq}`, sessionId: 's', role, parts, createdAt: seq, updatedAt: seq, sortOrder: seq, streamInterruptCount: 0 });
const say = (text: string): RawMessage => raw('user', [{ type: 'text', value: text }]);
const img = (name: string): ContentPart => ({ type: 'mediaRef', value: { id: name, relativePath: `attachments/${name}`, mimeType: 'image/png' } });
const reply = (text: string): RawMessage => raw('assistant', [{ type: 'text', value: text }]);
const use = (id: string, name: string, input: Record<string, unknown> | string): RawMessage =>
  raw('assistant', [{ type: 'toolUse', value: { toolUseId: id, name, input: typeof input === 'string' ? input : JSON.stringify(input) } }]);
const result = (id: string, output: string, o: { success?: boolean; status?: 'success' | 'failed' | 'cancelled' | 'unknown' } = {}): RawMessage =>
  raw('user', [{ type: 'toolResult', value: { toolUseId: id, output, success: o.success ?? true, status: o.status ?? ((o.success ?? true) ? 'success' : 'failed') } }]);
const call = (id: string, name: string, input: Record<string, unknown>, output = 'ok', o: Parameters<typeof result>[2] = {}): RawMessage[] => [use(id, name, input), result(id, output, o)];
const textOfMsg = (m: AgentMessage): string => m.parts.filter(p => p.type === 'text').map(p => String(p.value)).join('');
const engine = new CompactEngine(undefined as never);
const markerAt = (history: RawMessage[], idx: number, summary = 'S', meta?: CompactMeta): CompactMarker =>
  ({ id: 'K', sessionId: 's', summary, lastCompactedMessageId: history[idx].id, createdAt: 10_000, ...(meta ? { meta } : {}) });
const structured = (over: Partial<Record<'goal' | 'current', string> & Record<'constraints' | 'done' | 'todo' | 'decisions' | 'files', string[]>> = {}): ParsedReply => {
  const text = renderModelPart({
    goal: over.goal ?? 'ship it', constraints: over.constraints ?? [], done: over.done ?? [], current: over.current ?? '',
    todo: over.todo ?? [], decisions: over.decisions ?? [], files: over.files ?? [],
  });
  return parseSummaryReply(text);
};
const okReply = (r: ParsedReply): Extract<ParsedReply, { ok: true }> => { if (!r.ok) throw new Error(r.why); return r; };
const RECORD = { trigger: 'watermark' as const, request: { estInput: 100, maxTokens: 200, attempts: 1 as const } };

// ───────────────────────── P1 拒绝上限 ─────────────────────────

describe('P1 lowerCeiling / rescale / applyCeiling', () => {
  it('性质：上限比被拒的那次至少小 1,024；与上一次合并后只降不升（固定种子 300 组）', () => {
    const r = rng(20261004);
    for (let i = 0; i < 300; i++) {
      const window = 8_000 + Math.floor(r() * 400_000);
      const kind = r() < 0.7 ? 'shared' as const : 'separate' as const;
      const b = budgetOf({ text: 3_000 + Math.floor(r() * window * 1.4), limits: limitsOf({ window, cap: 1_024 + Math.floor(r() * 80_000), kind }), ratio: 0.5 + r() * 1.5 });
      const T = b.input.tokens; const S = T + b.output.requested;
      const hint = r() < 0.6 ? { limit: 1_024 + Math.floor(r() * 2 * window), actual: Math.floor(r() * 3 * S) + 1, basis: r() < 0.5 ? 'input' as const : 'total' as const } : undefined;
      const first = lowerCeiling(b, hint);
      if (first.input !== undefined) expect(first.input).toBeLessThanOrEqual(Math.max(1, T - 1024));
      if (first.total !== undefined) expect(first.total).toBeLessThanOrEqual(Math.max(1, S - 1024));
      expect(first.input !== undefined || first.total !== undefined).toBe(true);
      expect(first).toMatchObject({ rejectedInput: T, rejectedTotal: S, rejections: 1 });
      const second = lowerCeiling(b, r() < 0.5 ? hint : undefined, first);
      expect(second.rejections).toBe(2);
      if (first.input !== undefined) expect(second.input).toBeLessThanOrEqual(first.input);
      if (first.total !== undefined) expect(second.total).toBeLessThanOrEqual(first.total);
      if (first.output !== undefined) expect(second.output).toBe(first.output);
    }
  });

  it('定值：三条规则各一组', () => {
    // ① 报文带可用的数字（共享窗口、报的是输入加输出）：按「端点数的 ÷ 本机估的」换算后留 5%
    const a = budgetOf({ text: 25_000, limits: limitsOf({ window: 64_000, cap: 8_192 }) });
    expect(a.output.requested).toBe(8_192);
    expect(lowerCeiling(a, { limit: 24_000, actual: 33_192, basis: 'total' })).toEqual({ total: 22_800, rejectedInput: 25_000, rejectedTotal: 33_192, ratio: 1, rejections: 1, basis: 'hint' });
    // 提示离谱（差了十倍）不用：退到步长
    expect(lowerCeiling(a, { limit: 24_000, actual: 400_000, basis: 'total' }).basis).toBe('step');
    // 报的是输入：记成输入上限
    expect(lowerCeiling(a, { limit: 20_000, actual: 25_000, basis: 'input' })).toMatchObject({ input: 19_000, basis: 'hint' });
    // ② 先收输出：共享窗口、第一次被拒、申请的输出明显大于预留值——total 只记端点证明了的事，output 钉在预留值
    const big = budgetOf({ text: 40_000, limits: limitsOf({ window: 128_000, cap: 65_536, windowKnown: false, authority: 'none' }) });
    const S = 40_000 + 65_536;
    const first = lowerCeiling(big, undefined);
    expect(first).toEqual({ total: S - 1024, output: OUTPUT_RESERVE, rejectedInput: 40_000, rejectedTotal: S, ratio: 1, rejections: 1, basis: 'output-first' });
    // 之后再被拒一次：不再「先收输出」，output 仍在
    const again = lowerCeiling(big, undefined, first);
    expect(again).toMatchObject({ basis: 'step', output: OUTPUT_RESERVE, input: 30_000, total: S - 10_000, rejections: 2 });
    // ③ 步长：没有数字、输出不大——上限按被拒输入的 25% 下调
    const c = budgetOf({ text: 70_000, limits: limitsOf({ window: 200_000, cap: 8_192 }) });
    expect(lowerCeiling(c, undefined)).toEqual({ input: 52_500, total: 78_192 - 17_500, rejectedInput: 70_000, rejectedTotal: 78_192, ratio: 1, rejections: 1, basis: 'step' });
    expect(RECOVERY_LIMITS.stepRatio).toBe(0.25);
    // 独立上限（separate）：没有总量
    const sep = budgetOf({ text: 70_000, limits: limitsOf({ window: 200_000, cap: 8_192, kind: 'separate' }) });
    expect(lowerCeiling(sep, undefined)).toMatchObject({ input: 52_500, basis: 'step' });
    expect('total' in lowerCeiling(sep, undefined)).toBe(false);
  });

  it('RECOVERY_LIMITS 定值：七项熔断上限的缺省值（循环不给 recoveryLimits 时用的就是它们）；对象已冻结', () => {
    // 循环级用例多数用自定的上限钉机制（R3c 的 rejectionsPerRun: 2、R8 的花费上限）：缺省值改大了它们照样绿，所以在这里钉住
    expect({ ...RECOVERY_LIMITS }).toEqual({
      resendsPerIncident: 2, rejectionsPerRun: 6, compactionsPerRun: 3, summaryRequestsPerRun: 5,
      summarySpendTokens: 400_000, summaryAttemptsPerCall: 2, stepRatio: 0.25,
    });
    expect(Object.isFrozen(RECOVERY_LIMITS)).toBe(true);
  });

  it('applyCeiling 的实测下限：同一实例收下过的输入不会被步长猜到它以下；实测不小于被拒输入时不抬高', () => {
    const l = limitsOf({ window: 200_000, cap: 8_192 });
    const c = lowerCeiling(budgetOf({ text: 70_000, limits: l }), undefined);
    expect(applyCeiling(l, c, { ratio: 1, calibrated: true, observedMaxInput: 60_000 }).inputLimit).toBe(60_000);
    expect(applyCeiling(l, c, { ratio: 1, calibrated: true }).inputLimit).toBe(52_500);
    expect(applyCeiling(l, c, { ratio: 1, calibrated: true, observedMaxInput: 90_000 }).inputLimit).toBe(52_500);
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const T = 5_000 + Math.floor(r() * 150_000);
      const cc = lowerCeiling(budgetOf({ text: T, limits: l }), undefined);
      const obs = 1 + Math.floor(r() * (T - 1));
      expect(applyCeiling(l, cc, { ratio: 1, calibrated: true, observedMaxInput: obs }).inputLimit).toBeGreaterThanOrEqual(Math.min(obs, T - 2048));
    }
  });

  it('校准系数换算：系数不变原样返回；1 → 1.5 时输入部分放大 1.5 倍，被拒那次的 max_tokens 不变，output 不变', () => {
    const c: RejectionCeiling = { input: 30_000, total: 50_000, output: 16_384, rejectedInput: 40_000, rejectedTotal: 60_000, ratio: 1, rejections: 1, basis: 'step' };
    expect(rescale(c, 1)).toBe(c);
    expect(rescale(c, 1.5)).toEqual({ input: 45_000, total: 30_000 * 1.5 + 20_000, output: 16_384, rejectedInput: 60_000, rejectedTotal: 80_000, ratio: 1.5, rejections: 1, basis: 'step' });
    // 同一段纯文本在两个系数下各算一次带上限的预算：输入占上限的比例相同（差在取整以内）——系数变化本身不会把放得下变成放不下
    const l = limitsOf({ window: 128_000, cap: 8_192, kind: 'separate', windowKnown: false, authority: 'none' });
    const rejected = budgetOf({ text: 40_000, limits: l });
    const ceiling = lowerCeiling(rejected, undefined);
    const at = (ratio: number): RequestBudget => budgetOf({ text: 28_000, limits: applyCeiling(l, ceiling, { ratio, calibrated: true }), ratio, calibrated: true });
    const one = at(1); const scaled = at(1.5);
    expect(scaled.limits.inputLimit).toBe(Math.floor(one.limits.inputLimit * 1.5));
    expect(Math.abs(scaled.input.tokens / scaled.limits.inputLimit - one.input.tokens / one.limits.inputLimit)).toBeLessThan(0.001);
    expect(scaled.status).toBe(one.status);
  });
});

// ───────────────────────── P2 overflowHint ─────────────────────────

describe('P2 overflowHint', () => {
  it('带两个数的每条报文样例都取出正确的数与口径', () => {
    const cases: [string, { limit: number; actual: number; basis: 'input' | 'total' }][] = [
      ['prompt is too long: 213462 tokens > 200000 maximum', { limit: 200_000, actual: 213_462, basis: 'input' }],
      ["This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens", { limit: 131_072, actual: 140_000, basis: 'total' }],
      ["This model's maximum context length is 131,072 tokens. However, you requested 140,000 tokens (139000 in the messages, 1000 in the completion).", { limit: 131_072, actual: 140_000, basis: 'total' }],
      ['Your request exceeded model token limit: 24000 (requested: 33192)', { limit: 24_000, actual: 33_192, basis: 'total' }],
      ['The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)', { limit: 1_048_575, actual: 1_196_265, basis: 'input' }],
      ["Input length (265330) exceeds model's maximum context length (262144).", { limit: 262_144, actual: 265_330, basis: 'input' }],
      ['Input length 300000 exceeds the maximum allowed input length of 262144 tokens.', { limit: 262_144, actual: 300_000, basis: 'input' }],
      ["This model's maximum prompt length is 131072 but the request contains 537812 tokens", { limit: 131_072, actual: 537_812, basis: 'input' }],
      ["The input (9000 tokens) is longer than the model's context length (8192 tokens).", { limit: 8_192, actual: 9_000, basis: 'input' }],
      ['Prompt has 70000 tokens, but the configured context size is 65536 tokens', { limit: 65_536, actual: 70_000, basis: 'input' }],
      ['prompt token count of 140000 exceeds the limit of 128000', { limit: 128_000, actual: 140_000, basis: 'input' }],
    ];
    for (const [msg, want] of cases) expect(overflowHint(`OpenAI HTTP 400: {"error":{"message":"${msg}"}}`), msg).toEqual(want);
  });

  it('数字颠倒、少一个数、上限小于 1,024、没有数字：返回 undefined', () => {
    expect(overflowHint('Your request exceeded model token limit: 33192 (requested: 24000)')).toBeUndefined();
    expect(overflowHint("This model's maximum context length is 131072 tokens")).toBeUndefined();
    expect(overflowHint('prompt is too long: 900 tokens > 512 maximum')).toBeUndefined();
    expect(overflowHint('the request exceeds the available context size, try increasing it')).toBeUndefined();
  });
});

// ───────────────────────── P3 上限进预算 ─────────────────────────

describe('P3 applyCeiling 之后的预算', () => {
  it('永不为 blocked（学到的上限只用来判水位、收紧输出、判 over）；I-B1 / I-B2 仍成立；实测推翻不再生效', () => {
    const r = rng(11);
    for (let i = 0; i < 300; i++) {
      const window = 8_000 + Math.floor(r() * 200_000);
      const l = limitsOf({ window, cap: 1_024 + Math.floor(r() * 60_000), kind: r() < 0.7 ? 'shared' : 'separate', windowKnown: r() < 0.7, authority: r() < 0.5 ? 'manual' : 'endpoint' });
      const text = Math.floor(r() * window); const system = Math.floor(r() * window * 3);
      const before = budgetOf({ text, system, limits: l });
      const c = lowerCeiling(before, undefined);
      const obs = r() < 0.5 ? Math.floor(r() * window * 2) : undefined;
      const cal = { ratio: 1, calibrated: false, ...(obs !== undefined ? { observedMaxInput: obs } : {}) };
      const limits = applyCeiling(l, c, cal);
      const b = buildRequestBudget({ slot: before.slot, measure: { system, systemStable: 0, tools: 0, toolCount: 0, history: text, reasoningReplay: 0, media: [] }, limits, calibration: cal, preference: { tokens: l.outputCap, source: 'default' } });
      expect(b.status).not.toBe('blocked');
      expect(b.limits).toMatchObject({ windowKnown: true, authority: 'advisory', rejectedAt: before.input.tokens });
      expect('observedAbove' in b.limits).toBe(false);
      const comp = b.input.components;
      expect(b.input.tokens).toBe(comp.system + comp.tools + comp.history + comp.reasoningReplay + comp.media);
      expect(b.output.requested).toBeGreaterThanOrEqual(1);
      expect(b.output.requested).toBeLessThanOrEqual(b.output.preference);
      expect(b.output.preference).toBeLessThanOrEqual(b.output.cap);
    }
  });

  it('outputCeiling：max_tokens 钉在它上面、不随输入增长缩小，直到窗口真的放不下；cap 与 preference 不变', () => {
    const l = limitsOf({ window: 128_000, cap: 65_536, windowKnown: false, authority: 'none' });
    const first = lowerCeiling(budgetOf({ text: 40_000, limits: l }), undefined);
    expect(first.basis).toBe('output-first');
    let pinned = 0;
    for (let text = 1_000; text <= 104_000; text += 1_000) {
      const b = budgetOf({ text, limits: applyCeiling(l, first, { ratio: 1, calibrated: false }) });
      expect(b.output.requested).toBeLessThanOrEqual(OUTPUT_RESERVE);
      expect(b.output).toMatchObject({ cap: 65_536, preference: 65_536 });
      expect(['window', 'floor']).toContain(b.output.limitedBy);
      if (b.output.available >= OUTPUT_RESERVE) { expect(b.output.requested).toBe(OUTPUT_RESERVE); expect(b.status).toBe('ok'); pinned++; }
    }
    // 被拒的是 40K 输入 + 65,536 输出：之后输入涨到 7 万多都还按 16,384 申请，不提前收紧
    expect(pinned).toBeGreaterThan(70);
  });

  it('资料上限不可信的两种起点只用学到的值；可信时仍与它取小', () => {
    const hint = { limit: 1_000_000, actual: 1_100_000, basis: 'input' as const };
    // 窗口没有资料（128K 回退值）：学到 95 万就是 95 万，不回落到 128K；只有输入上限、没有总量证据时不收紧输出
    const unknown = limitsOf({ window: 128_000, cap: 8_192, windowKnown: false, authority: 'none' });
    const rejected = budgetOf({ text: 1_100_000, limits: unknown });
    const c = lowerCeiling(rejected, hint);
    expect(c).toMatchObject({ basis: 'hint', input: 950_000 });
    const lim = applyCeiling(unknown, c, { ratio: 1, calibrated: false });
    expect(lim).toMatchObject({ inputLimit: 950_000, sharedWindow: 950_000 + 8_192, windowKnown: true, authority: 'advisory', rejectedAt: 1_100_000 });
    const under = budgetOf({ text: 800_000, limits: lim });
    expect([under.status, under.output.requested]).toEqual(['ok', rejected.output.requested]);
    // 资料上限已被实测推翻（目录 128K、实测收下过 140K）：同样只用学到的值
    const overturned = limitsOf({ window: 128_000, cap: 8_192, authority: 'endpoint' });
    expect(applyCeiling(overturned, c, { ratio: 1, calibrated: true, observedMaxInput: 140_000 }).inputLimit).toBe(950_000);
    // 可信（手动 200K、没被实测推翻）：与它取小，只把 authority 降为 advisory
    const manual = limitsOf({ window: 200_000, cap: 8_192 });
    expect(applyCeiling(manual, c, { ratio: 1, calibrated: false })).toMatchObject({ inputLimit: 200_000, sharedWindow: 200_000, authority: 'advisory' });
    // 带总量证据的共享窗口：窗口取学到的总量，输入上限是它减最小输出
    const t = lowerCeiling(budgetOf({ text: 25_000, limits: limitsOf({ window: 64_000, cap: 8_192 }) }), { limit: 24_000, actual: 33_192, basis: 'total' });
    expect(applyCeiling(limitsOf({ window: 64_000, cap: 8_192 }), t, { ratio: 1, calibrated: false })).toMatchObject({ sharedWindow: 22_800, inputLimit: 22_800 - MIN_REQUEST_OUTPUT });
  });
});

// ───────────────────────── P4 解析与陈述核对 ─────────────────────────

describe('P4 parseSummaryReply 与 checkClaims', () => {
  const FULL = '【目标】\n- finish the refactor\n【约束】\n- only touch docs/\n- 不要改 README\n【已完成】\n- 写了 docs/a.md\n【进行中】\n- 正在核对链接\n【待办】\n- 写 docs/b.md\n【关键决策】\n- （无）\n【涉及文件】\n- docs/a.md 已写';

  it('三种结果：分节的、没有任何小节标题的自由文本、出现了标题而结构不完整的', () => {
    const p = okReply(parseSummaryReply(FULL));
    expect(p).toMatchObject({ form: 'structured', part: { goal: 'finish the refactor', constraints: ['only touch docs/', '不要改 README'], done: ['写了 docs/a.md'], current: '正在核对链接', todo: ['写 docs/b.md'], decisions: [], files: ['docs/a.md 已写'] } });
    expect(parseSummaryReply('  just prose, no headings at all.  ')).toEqual({ ok: true, form: 'text', text: 'just prose, no headings at all.' });
    expect(parseSummaryReply(FULL.replace('【待办】\n- 写 docs/b.md\n', ''))).toEqual({ ok: false, why: '缺少小节【待办】' });
    expect(parseSummaryReply(`${FULL}\n【约束】\n- again`)).toEqual({ ok: false, why: '小节【约束】重复' });
    expect(parseSummaryReply(FULL.replace('- finish the refactor', '- （无）'))).toEqual({ ok: false, why: '【目标】为空' });
    expect(parseSummaryReply('【目标】\n- x\n【约束】\n- y\n【已完成】\n- z').ok).toBe(false);
  });

  it('标题的装饰写法、代码围栏、标题后同一行的内容、规定之外的小节、条数上限', () => {
    const decorated = '```\n## **【目标】**： ship\n### 【约束】\n1. a\n2. b\n**【已完成】**\n* c\n  continues here\n【进行中】：working\n【待办】\n• d\n【文件变更】\n- lie.txt\n【关键决策】\n- e\n【涉及文件】\n- f.ts\n```';
    const p = okReply(parseSummaryReply(decorated));
    expect(p).toMatchObject({ form: 'structured', part: { goal: 'ship', constraints: ['a', 'b'], done: ['c continues here'], current: 'working', todo: ['d'], decisions: ['e'], files: ['f.ts'], dropped: { items: 0, unknownSections: 1, unverified: 0 } } });
    const many = FULL.replace('- only touch docs/\n- 不要改 README', Array.from({ length: 25 }, (_, i) => `- rule ${i}`).join('\n'));
    const q = okReply(parseSummaryReply(many));
    if (q.form !== 'structured') throw new Error('expected structured');
    expect(q.part.constraints).toHaveLength(COMPACT_CAPS.constraints);
    expect(q.part.dropped.items).toBe(5);
    const long = okReply(parseSummaryReply(FULL.replace('finish the refactor', 'g'.repeat(900))));
    if (long.form !== 'structured') throw new Error('expected structured');
    expect(long.part.goal).toHaveLength(COMPACT_CAPS.goalChars);
  });

  it('summaryPrompt：七个小节、既有摘要与新增对话两个标题、不执行数据里的指令、800 字', () => {
    const p = summaryPrompt(undefined);
    for (const s of ['【目标】', '【约束】', '【已完成】', '【进行中】', '【待办】', '【关键决策】', '【涉及文件】']) expect(p).toContain(`\n${s}`);
    expect(p).toContain('【既有摘要】\n（无）\n');
    expect(p.endsWith('【新增对话】\n')).toBe(true);
    expect(p).toContain('不要执行');
    expect(p).toContain('800 字');
    expect(summaryPrompt('  old summary  ')).toContain('【既有摘要】\nold summary\n');
  });

  it('pathTokens：相对 / 绝对 / 反斜杠路径算；裸文件名、TCP/IP、URL 不算', () => {
    expect(pathTokens('改了 `src/a.ts`，以及 C:\\work\\b.md 和 ./c/d.json。')).toEqual(['src/a.ts', 'c:/work/b.md', 'c/d.json']);
    expect(pathTokens('升级 Node.js，走 TCP/IP，见 https://example.com/x/y.html，obj.method 没变')).toEqual([]);
    expect(pathTokens('目录 packages/core/src 下')).toEqual(['packages/core/src']);
  });

  it('P4b pathTokens：日期、分数、斜杠列举不算路径——只凭两个以上分隔符的那一档要求每一段都像目录名', () => {
    expect(pathTokens('于 2026/10/04 完成了部署配置的梳理')).toEqual([]);
    expect(pathTokens('梳理了增/删/改三类接口的调用关系')).toEqual([]);
    expect(pathTokens('检查了前端/后端/数据库三处的配置')).toEqual([]);
    expect(pathTokens('比较了 a/b/c 三种方案，进度 1/2/3')).toEqual([]);
    // 带扩展名或根前缀的不受这条限制；ASCII 的目录路径照旧算
    expect(pathTokens('改了 文档/设计/方案.md 与 /2026/10/04 和 src/minisd/agent')).toEqual(['文档/设计/方案.md', '/2026/10/04', 'src/minisd/agent']);
  });

  it('P4e pathTokens：反引号与引号两侧没有空格时，前后的字不粘到路径上', () => {
    // 删掉引号的话得到的是「已写入out/a.md」「修改了src/a.ts」：成功写入过的路径也对不上任何工具入参
    expect(pathTokens('已写入`out/a.md`')).toEqual(['out/a.md']);
    expect(pathTokens('修改了`src/a.ts`，并更新了"docs/b.md"与‘lib/c.ts’的引用')).toEqual(['src/a.ts', 'docs/b.md', 'lib/c.ts']);
    // 贴着路径的后文同理：「`src/never.ts`的调度逻辑」以前整个片段不像路径、不核对，现在认得出
    expect(pathTokens('已修改`src/never.ts`的调度逻辑')).toEqual(['src/never.ts']);
    // 路径里自带撇号的：从撇号处断开，后半段仍是原路径的子串，对得上佐证
    expect(pathTokens("改了 src/o'brien/a.ts")).toEqual(['brien/a.ts']);
  });

  it('checkClaims 定值表', () => {
    seq = 0;
    const h: RawMessage[] = [
      say('请整理 docs/，另外看看 notes/todo.txt'),
      ...call('T1', 'file_write', { path: 'docs/a.md', content: 'x', tool_title: 'w' }, '已写入'),
      ...call('T2', 'file_read', { path: 'package.json', tool_title: 'r' }, '{}'),
      ...call('T3', 'shell_execute', { command: 'sed -i s/a/b/ scripts/build.sh', tool_title: 's' }, 'done'),
      reply('ok'), say('next'), reply('ok'),
    ];
    const to = h.length - 3;
    const part = (o: Parameters<typeof structured>[0]) => { const p = okReply(structured(o)); if (p.form !== 'structured') throw new Error('x'); return p.part; };
    // 有工具入参佐证的路径留下（相对路径、模型写成绝对路径、只出现在 shell 命令串里的）
    const kept = checkClaims(part({ done: ['写了 docs/a.md', '写了 /work/proj/docs/a.md', '改了 scripts/build.sh'] }), h, to, defaultToolKindOf);
    expect(kept.done).toEqual(['写了 docs/a.md', '写了 /work/proj/docs/a.md', '改了 scripts/build.sh']);
    expect(kept.dropped.unverified).toBe(0);
    // 没有佐证的路径：【已完成】整条移除；【进行中】原样挪到【待办】第一条
    const moved = checkClaims(part({ done: ['已修改 src/never.ts', '整理了目录'], current: '正在写 docs/b.md', todo: ['收尾'] }), h, to, defaultToolKindOf);
    expect(moved).toMatchObject({ done: ['整理了目录'], current: '', todo: ['正在写 docs/b.md', '收尾'], dropped: { unverified: 2 } });
    // 【涉及文件】：工具入参里的裸文件名留下、只在用户消息里提到的路径留下、对话里没出现过的移除
    const files = checkClaims(part({ files: ['package.json 读过', 'notes/todo.txt 用户提到', 'ghost/file.ts'] }), h, to, defaultToolKindOf);
    expect(files).toMatchObject({ files: ['package.json 读过', 'notes/todo.txt 用户提到'], dropped: { unverified: 1 } });
    // 验证类结论：覆盖区间内有成功的有副作用调用 → 保留并注明；同一输入跑两遍结果相同
    const noted = checkClaims(part({ done: ['测试全部通过', 'all tests passed', '已验证链接'] }), h, to, defaultToolKindOf);
    expect(noted.done).toEqual(['测试全部通过', 'all tests passed', '已验证链接'].map(x => `${x}（验证结论是模型的陈述，程序没有核对）`));
    expect(checkClaims(noted, h, to, defaultToolKindOf)).toEqual(noted);
    // 没有任何成功的有副作用调用（区间只到 file_read 为止）→ 移除
    const none = checkClaims(part({ done: ['测试全部通过', 'build succeeded', '写了 docs/a.md'], current: '类型检查通过' }), h, 4, defaultToolKindOf);
    expect(none).toMatchObject({ done: ['写了 docs/a.md'], current: '', dropped: { unverified: 3 } });
    // 【目标】【约束】【待办】【关键决策】不核对
    const free = checkClaims(part({ goal: '重写 src/new/thing.ts', constraints: ['不要动 lib/x.ts'], todo: ['写 src/new/thing.ts'], decisions: ['放在 src/new/ 下'] }), h, to, defaultToolKindOf);
    expect(free.dropped.unverified).toBe(0);
  });

  it('P4c checkClaims：只读过的路径、写入失败或已取消的路径佐证不了「已修改」；带日期与斜杠列举的真实条目不误删', () => {
    seq = 0;
    const h: RawMessage[] = [
      say('看看调度逻辑'),
      ...call('T1', 'file_read', { path: 'src/core/engine.ts', tool_title: 'r' }, 'export const x = 1'),
      ...call('T2', 'file_write', { path: 'src/core/broken.ts', content: 'x', tool_title: 'w' }, 'EACCES', { success: false }),
      ...call('T3', 'file_write', { path: 'src/core/cancelled.ts', content: 'x', tool_title: 'w' }, '已取消', { success: false, status: 'cancelled' }),
      ...call('T4', 'shell_execute', { command: 'dir', tool_title: 'ls' }, 'a b c'),
      reply('ok'), say('next'), reply('ok'),
    ];
    const to = h.length - 3;
    const part = (o: Parameters<typeof structured>[0]) => { const p = okReply(structured(o)); if (p.form !== 'structured') throw new Error('x'); return p.part; };
    const got = checkClaims(part({
      done: [
        '已修改 src/core/engine.ts，重写了调度逻辑', '已修改 src/core/broken.ts', '已写入 src/core/cancelled.ts',
        '于 2026/10/04 完成了部署配置的梳理', '梳理了增/删/改三类接口的调用关系', '测试全部通过',
      ],
      current: '正在读 src/core/engine.ts',
      todo: ['收尾'],
      files: ['src/core/engine.ts 读过', 'src/core/broken.ts 写入失败'],
    }), h, to, defaultToolKindOf);
    // 读过的、写失败的、已取消的三条路径陈述都移除；日期与列举两条如实的条目留下
    expect(got.done).toEqual([
      '于 2026/10/04 完成了部署配置的梳理', '梳理了增/删/改三类接口的调用关系',
      // 现状（设计 §4.8.6，未收紧）：覆盖区间内有任意一次成功的有副作用调用（这里是 dir），验证结论就保留并加注——程序分不清哪条命令是在验证
      '测试全部通过（验证结论是模型的陈述，程序没有核对）',
    ]);
    // 【进行中】说的是「正在读」一个确实读过的文件：如实的当前步骤，留在原处（fix2：以前会被挪到待办并计入没有佐证的陈述）
    expect(got).toMatchObject({ current: '正在读 src/core/engine.ts', todo: ['收尾'], dropped: { unverified: 3 } });
    // 【涉及文件】只要求路径在对话里出现过：读过的、写失败的都算
    expect(got.files).toEqual(['src/core/engine.ts 读过', 'src/core/broken.ts 写入失败']);
    expect(checkClaims(got, h, to, defaultToolKindOf)).toEqual(got);
    // 【进行中】声称正在改一个只读过的文件、或写入失败的文件：这一步还没有动手改成，挪到待办第一条
    for (const current of ['正在修改 src/core/engine.ts 的调度逻辑', '正在重写 src/core/broken.ts', '正在改 src/core/engine.ts']) {
      expect(checkClaims(part({ current, todo: ['收尾'] }), h, to, defaultToolKindOf)).toMatchObject({ current: '', todo: [current, '收尾'], dropped: { unverified: 1 } });
    }

    // 同一个路径后来写成功了：陈述有了佐证
    const later: RawMessage[] = [...h.slice(0, to + 1), ...call('T5', 'file_write', { path: 'src/core/broken.ts', content: 'y', tool_title: 'w' }, '已写入'), reply('ok'), say('next'), reply('ok')];
    expect(checkClaims(part({ done: ['已修改 src/core/broken.ts'] }), later, later.length - 3, defaultToolKindOf)).toMatchObject({ done: ['已修改 src/core/broken.ts'], dropped: { unverified: 0 } });
    // 工具分类由调用方给：注册表把它标成只读的工具，入参不算佐证
    expect(checkClaims(part({ done: ['已修改 src/core/broken.ts'] }), later, later.length - 3, () => 'read').done).toEqual([]);
  });

  it('P4d checkClaims：只读过的路径上说「读了、查了、定位到」的留下，带修改类字眼的移除；「读 A 改 B」的条目留下；工具从没碰过的路径怎么说都不留', () => {
    seq = 0;
    const LOOP = 'src/minisd/agent/loop.ts'; const COMPACT = 'src/minisd/agent/compact.ts'; const PRUNE = 'src/minisd/agent/prune.ts';
    const h: RawMessage[] = [
      say('排查压缩为什么不记 skipped'),
      ...call('T1', 'file_read', { path: LOOP, tool_title: 'r' }, 'export function runAgentLoop() {}'),
      ...call('T2', 'file_grep', { pattern: 'summarize', path: 'src/minisd/agent', tool_title: 'g' }, 'compact.ts:1'),
      ...call('T3', 'file_edit', { path: COMPACT, old_string: 'a', new_string: 'b', tool_title: 'e' }, '已修改'),
      ...call('T4', 'file_write', { path: PRUNE, content: 'x', tool_title: 'w' }, 'EACCES', { success: false }),
      reply('ok'), say('next'), reply('ok'),
    ];
    const to = h.length - 3;
    const part = (o: Parameters<typeof structured>[0]) => { const p = okReply(structured(o)); if (p.form !== 'structured') throw new Error('x'); return p.part; };
    // 只读排查的结论：路径确实被工具读过、条目没有声称改过 → 留下
    const findings = [
      `已阅读 ${LOOP}，定位到根因：canCompact 在事故外不记 skipped`,
      `检查了\`${LOOP}\`的 abandonSameSlot，确认它只在事故里调用`,
      '梳理了 src/minisd/agent 下各文件的调用关系',
      `Reviewed ${LOOP}; the limit is checked before the request goes out`,
    ];
    // 读 A 改 B：A 只读过、B 有成功的写入 → 留下
    const mixed = `参照 ${LOOP} 的写法，在 ${COMPACT} 的 summarize 里新增了 rule 参数`;
    const got = checkClaims(part({
      done: [
        ...findings, mixed,
        // 只读过的路径上声称改过（字眼在路径前、在路径后的另一个分句、英文）→ 移除
        `已修改 ${LOOP}`, `${LOOP}：重写了 abandonSameSlot`, `Updated ${LOOP} to record skipped`,
        // 读 A 改 B，而 B 的写入失败了：两个路径都没有动过 → 移除
        `参照 ${LOOP} 的写法改写了 ${PRUNE}`,
        // 工具从没碰过的路径：说的是「读了」也不留
        '已阅读 src/minisd/agent/ghost.ts，结构清楚',
      ],
      current: `正在核对 ${LOOP} 的 abandonSameSlot`,
      todo: ['向用户汇报结论'],
    }), h, to, defaultToolKindOf);
    expect(got.done).toEqual([...findings, mixed]);
    expect(got).toMatchObject({ current: `正在核对 ${LOOP} 的 abandonSameSlot`, todo: ['向用户汇报结论'], dropped: { unverified: 5 } });
    expect(checkClaims(got, h, to, defaultToolKindOf)).toEqual(got);
    // 「读 A 改 B」留下靠的是 B 那次成功的写入：把工具都算成只读，这一条就只剩修改类字眼、没有动过的路径
    expect(checkClaims(part({ done: [mixed, findings[0]] }), h, to, () => 'read')).toMatchObject({ done: [findings[0]], dropped: { unverified: 1 } });
    // 【进行中】同一套判法：正要写一个工具还没碰过的文件 → 挪到待办第一条
    expect(checkClaims(part({ current: '正在查看 src/minisd/agent/ghost.ts', todo: ['收尾'] }), h, to, defaultToolKindOf))
      .toMatchObject({ current: '', todo: ['正在查看 src/minisd/agent/ghost.ts', '收尾'], dropped: { unverified: 1 } });
    // 现状（启发式的两头，文档里照实写了）：
    //  - 误删：只读过的路径上，如实的条目里出现了修改类字眼——程序分不清说的是自己做的事还是代码的行为；
    //  - 漏放：一条里既有动过的路径又有只读过的路径时整条留下，分不清修改类字眼说的是哪一个（确实改过哪些文件以程序记录的文件变更为准）
    const edge = checkClaims(part({ done: [`检查了 ${LOOP}，无需修改`, `已阅读 ${LOOP}，定位到根因：写入前没有加锁`, `已修改 ${LOOP} 和 ${COMPACT}`] }), h, to, defaultToolKindOf);
    expect(edge).toMatchObject({ done: [`已修改 ${LOOP} 和 ${COMPACT}`], dropped: { unverified: 2 } });
  });
});

// ───────────────────────── P5 请求侧裁剪 ─────────────────────────

describe('P5 trimForRequest', () => {
  const agent = (h: RawMessage[]): AgentMessage[] => h.map(m => ({ role: m.role, parts: m.parts }));
  const outputs = (h: AgentMessage[]): string[] => h.flatMap(m => m.parts.filter(p => p.type === 'toolResult').map(p => (p.value as { output: string }).output));

  it('1 级与 pruneOldToolResults 的输出相同；2、3 级保序保长，其余字段照抄', () => {
    seq = 0;
    const h = agent([say('go'), ...Array.from({ length: 10 }, (_, i) => call(`T${i}`, 'file_read', { path: `f${i}`, tool_title: 't' }, 'x'.repeat(3_000 + i))).flat()]);
    const base = pruneOldToolResults(h);
    expect(trimForRequest(h, 1)).toEqual({ pruned: base.pruned, clipped: 0, history: base.history });
    for (const level of [2, 3] as const) {
      const t = trimForRequest(h, level);
      expect(t.history).toHaveLength(h.length);
      t.history.forEach((m, i) => {
        expect(m.role).toBe(h[i].role);
        expect(m.parts.map(p => p.type)).toEqual(h[i].parts.map(p => p.type));
        m.parts.forEach((p, k) => {
          if (p.type !== 'toolResult') { expect(p).toBe(h[i].parts[k]); return; }
          const { output: _o, ...rest } = p.value as Record<string, unknown>; const { output: _b, ...orig } = h[i].parts[k].value as Record<string, unknown>;
          void _o; void _b;
          expect(rest).toEqual(orig);
        });
      });
      // 最近 4 条之前的大结果都成了桩；最近 4 条里的（不超过 6,000）原样
      expect(t.pruned).toBe(8);
      expect(outputs(t.history).slice(-2)).toEqual(outputs(h).slice(-2));
    }
  });

  it('说明句按工具分两种：只读工具提「重新调用」，其余写明不要重新执行', () => {
    seq = 0;
    const big = 'y'.repeat(9_000);
    const h = agent([
      say('go'),
      ...call('R1', 'file_read', { path: 'a', tool_title: 't' }, big), ...call('S1', 'shell_execute', { command: 'x', tool_title: 't' }, big),
      ...call('M1', 'mcp__x__y', { tool_title: 't' }, big), ...call('U1', 'never_registered', { tool_title: 't' }, big),
      result('ORPHAN', big),
      ...call('R2', 'file_read', { path: 'b', tool_title: 't' }, big), ...call('S2', 'shell_execute', { command: 'x', tool_title: 't' }, big),
    ]);
    const l2 = outputs(trimForRequest(h, 2).history);
    expect(l2[0]).toContain('请重新调用相应工具获取');
    for (const i of [1, 2, 3, 4]) { expect(l2[i]).not.toContain('重新调用'); expect(l2[i]).toContain('不要为了查看结果重新执行它'); expect(l2[i]).toContain('原 9000 字符'); }
    expect(l2.slice(5)).toEqual([big, big]);
    const l3 = trimForRequest(h, 3);
    expect(l3).toMatchObject({ pruned: 5, clipped: 2 });
    const [r2, s2] = outputs(l3.history).slice(5);
    expect(r2).toContain('需要中间部分请重新调用工具并缩小范围');
    expect(s2).not.toContain('重新调用');
    expect(s2).toContain('不要为了查看省略部分重新执行这次调用');
    expect(s2.startsWith(big.slice(0, 3_000))).toBe(true);
    expect(s2.endsWith(big.slice(-1_000))).toBe(true);
    // kindOf 由调用方给时按它分（循环按注册表的调度声明给）
    const custom = outputs(trimForRequest(h, 3, () => 'read').history);
    expect(custom[6]).toContain('请重新调用工具并缩小范围');
  });

  it('P5b toolUseId 跨轮复用、为空串或同批重复：工具名取紧邻的前一条 assistant 声明的调用，有副作用的结果不会被写成「请重新调用」', () => {
    const big = 'y'.repeat(9_000);
    for (const id of ['call_0', '']) {
      seq = 0;
      // 同一个 id 先属于 shell（有副作用），后属于 file_read（只读）
      const pair = [...call(id, 'shell_execute', { command: 'x', tool_title: 't' }, big), ...call(id, 'file_read', { path: 'a', tool_title: 't' }, big)];
      // 第 2 级：两条结果都在最近 4 条之前
      const [shell2, read2] = outputs(trimForRequest(agent([say('go'), ...pair, reply('a'), say('b'), reply('c'), say('d')]), 2).history);
      expect(shell2, `id=${JSON.stringify(id)}`).toContain('这次调用已经执行过，不要为了查看结果重新执行它');
      expect(shell2).not.toContain('重新调用');
      expect(read2).toContain('如仍需要，请重新调用相应工具获取');
      // 第 3 级：两条结果都在最近 4 条里，裁成头尾
      const l3 = trimForRequest(agent([say('go'), ...pair]), 3);
      expect(l3).toMatchObject({ pruned: 0, clipped: 2 });
      const [shell3, read3] = outputs(l3.history);
      expect(shell3).toContain('完整内容仍在会话记录里，不要为了查看省略部分重新执行这次调用');
      expect(shell3).not.toContain('重新调用');
      expect(read3).toContain('需要中间部分请重新调用工具并缩小范围');
    }
    // 同一批里两个调用 id 相同：按出现次序配
    seq = 0;
    const batch = agent([
      say('go'),
      raw('assistant', [
        { type: 'toolUse', value: { toolUseId: 'dup', name: 'shell_execute', input: '{}' } },
        { type: 'toolUse', value: { toolUseId: 'dup', name: 'file_read', input: '{}' } },
      ]),
      raw('user', [
        { type: 'toolResult', value: { toolUseId: 'dup', output: big, success: true, status: 'success' } },
        { type: 'toolResult', value: { toolUseId: 'dup', output: big, success: true, status: 'success' } },
      ]),
    ]);
    const [first, second] = outputs(trimForRequest(batch, 3).history);
    expect(first).toContain('不要为了查看省略部分重新执行这次调用');
    expect(second).toContain('需要中间部分请重新调用工具并缩小范围');
    // 结果与声明它的 assistant 之间隔着别的消息（请求构建时本来就会被当孤儿剥掉）：按非只读处理
    seq = 0;
    const apart = agent([say('go'), use('R', 'file_read', { path: 'a' }), say('interleaved'), result('R', big)]);
    expect(outputs(trimForRequest(apart, 3).history)[0]).toContain('不要为了查看省略部分重新执行这次调用');
  });

  it('3 级的切点不切半个代理对、不落进带口令的 URL', () => {
    seq = 0;
    const emoji = `${'a'.repeat(2_999)}😀${'b'.repeat(6_000)}😀${'c'.repeat(999)}`;
    const url = `${'a'.repeat(2_990)} https://user:secretpass@host.example/x ${'b'.repeat(8_000)}`;
    const h = agent([say('go'), ...call('E', 'echo', { tool_title: 't' }, emoji), ...call('U', 'echo', { tool_title: 't' }, url)]);
    const [e, u] = outputs(trimForRequest(h, 3).history);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(e)).toBe(false);
    expect(u).not.toContain('secretpass');
    expect(u).not.toContain('user:');
  });
});

// ───────────────────────── P6 渲染 ─────────────────────────

describe('P6 程序记录与「保留的用户原话」', () => {
  function sample(): { h: RawMessage[]; meta: CompactMeta; summary: string } {
    seq = 0;
    const h: RawMessage[] = [
      say('只能改 docs/ 下的文件'),
      ...call('T1', 'file_write', { path: 'docs/a.md', content: 'x', tool_title: '写 a' }, '已写入'),
      ...call('T2', 'file_write', { path: 'docs\\A.md', content: 'y', tool_title: '再写 a' }, '已写入'),
      ...call('T3', 'file_write', { path: 'docs/bad', content: 'z', tool_title: '写错' }, 'EISDIR', { success: false }),
      ...call('T4', 'shell_execute', { command: 'npm test', tool_title: '跑测试' }, 'ok'),
      ...call('T5', 'shell_execute', { command: 'rm x', tool_title: '清理' }, '', { success: false, status: 'unknown' }),
      raw('user', [{ type: 'text', value: '看这张图' }, img('shot.png')]),
      reply('好'), say('继续'), reply('好'), say('再继续'), reply('好'), say('最后一步'),
    ];
    const to = h.findIndex(m => m.parts.some(p => p.type === 'mediaRef')) + 1;
    const prev = markerAt(h, 0, 'S', { v: 2, model: { form: 'structured', goal: 'g', constraints: ['C-old'], done: [], current: '', todo: [], decisions: [], files: [], carriedConstraints: ['C-older'], dropped: { items: 0, unknownSections: 0, unverified: 0 } } } as unknown as CompactMeta);
    const built = buildCompactMeta({ history: h, to, rule: 'recent-turns', prev, reply: okReply(structured({ constraints: ['C-new'] })), toolKindOf: defaultToolKindOf, record: RECORD });
    return { h, ...built };
  }

  it('renderEngineRecord 金样（不带 skip / 带 skip）', () => {
    const { h, meta } = sample();
    expect(meta.evidence.fileChanges).toEqual([{ path: 'docs\\A.md', tool: 'file_write', count: 2, lastToolUseId: 'T2', lastMessageId: h[3].id }]);
    expect(meta.evidence.runs.map(r => `${r.tool}:${r.state}`)).toEqual(['shell_execute:ok', 'shell_execute:unknown']);
    expect(meta.evidence.unsettledCalls).toBe(1);
    expect(meta.model.carriedConstraints).toEqual(['C-older', 'C-old']);
    expect(renderEngineRecord(meta)).toBe([
      '【程序记录】以下由程序根据会话记录生成；与上面的摘要不一致时以这里为准。摘要里提到而这里没有记录的文件修改或验证结果，没有工具记录佐证。',
      '覆盖：会话开头起的 13 条消息已摘要，之后的消息原文在下面。',
      '用户指示（较早的，原话，2 条）：',
      '1. 只能改 docs/ 下的文件',
      '2. 看这张图［附图 1 张］',
      '文件变更（工具执行成功的记录，1 个路径；经 shell 等命令做的改动不在此列）：',
      '- docs\\A.md（file_write ×2）',
      '其它有副作用的调用（最近 2 次）：',
      '- [成功] shell_execute：跑测试',
      '- [结果未知] shell_execute：清理',
      '结果未知或已取消的调用 1 次：不要假定它们已经执行成功。',
      '沿用的约束（此前的摘要记录、这次没有复述；与更新的用户指示冲突时以较新的为准）：',
      '- C-older',
      '- C-old',
    ].join('\n'));
    const skipped = renderEngineRecord(meta, { skip: new Set([meta.evidence.userInstructions[1].messageId]) });
    expect(skipped).toContain('用户指示（较早的，原话，1 条；最近的 1 条在下面原样保留）：\n1. 只能改 docs/ 下的文件\n文件变更');
    expect(skipped).not.toContain('看这张图');
  });

  it('超过 8,000 字符时的丢弃顺序：非首条用户指示 → 调用 → 沿用约束 → 文件路径；首条用户指示留到最后', () => {
    seq = 0;
    const h: RawMessage[] = [say(`FIRST ${'f'.repeat(700)}`)];
    for (let i = 0; i < 8; i++) h.push(say(`ins-${i} ${'u'.repeat(780)}`), reply('ok'));
    for (let i = 0; i < 45; i++) h.push(...call(`W${i}`, 'file_write', { path: `out/${'p'.repeat(200)}-${i}.md`, content: 'c', tool_title: 't' }, '已写入'));
    for (let i = 0; i < 14; i++) h.push(...call(`S${i}`, 'shell_execute', { command: 'x', tool_title: `run-${i} ${'t'.repeat(70)}` }, 'ok'));
    h.push(say('a'), reply('b'), say('c'), reply('d'), say('e'));
    const to = h.length - 6;
    const { meta } = buildCompactMeta({ history: h, to, rule: 'recent-turns', prev: undefined, reply: okReply(structured()), toolKindOf: defaultToolKindOf, record: RECORD });
    expect(meta.evidence).toMatchObject({ omittedInstructions: 3, omittedFileChanges: 5, omittedRuns: 2 });
    expect(meta.evidence.userInstructions).toHaveLength(6);
    expect(meta.evidence.fileChanges).toHaveLength(40);
    expect(meta.evidence.runs).toHaveLength(12);
    const text = renderEngineRecord(meta);
    expect(text.length).toBeLessThanOrEqual(COMPACT_CAPS.recordChars);
    expect(text).toContain('1. FIRST ');
    // 用户指示与调用先丢光（各自的「未列出」计数跟着涨），文件路径最后才动
    expect(text).toContain('用户指示（较早的，原话，1 条，另有 8 条未列出）');
    expect(text).not.toContain('其它有副作用的调用');
    expect(/文件变更（工具执行成功的记录，(\d+) 个路径，另有较早的 (\d+) 个未列出/.exec(text)?.slice(1).map(Number).reduce((a, b) => a + b, 0)).toBe(45);
    expect(text).toContain(`-44.md（file_write ×1）`);
  });

  it('carriedUserTurns 定值表', () => {
    seq = 0;
    // 常规锚点（最近 3 个真回合之前）：恒为空
    const multi = [say('q1'), reply('a'), say('q2'), reply('a'), say('q3'), reply('a'), say('q4')];
    expect(carriedUserTurns(multi, pendingSummaryRange(multi, undefined)!.to)).toEqual([]);
    // 单回合任务：唯一的用户消息被 length − 15 盖住
    const single = [say('do it'), ...Array.from({ length: 20 }, (_, i) => call(`T${i}`, 'echo', { tool_title: 't' })).flat()];
    const sr = pendingSummaryRange(single, undefined)!;
    expect(sr).toMatchObject({ rule: 'recent-messages', to: 26 });
    expect(carriedUserTurns(single, sr.to)).toEqual([0]);
    // tight 盖住 2 个回合；之后追加 1、2、3 条用户消息，旧回合逐个退出保留回合
    const t = [say('u1'), reply('a'), say('u2'), reply('a'), raw('user', [img('p.png')]), ...Array.from({ length: 3 }, (_, i) => call(`X${i}`, 'echo', { tool_title: 't' })).flat()];
    const tr = pendingSummaryRange(t, undefined, 'tight')!;
    expect(tr).toMatchObject({ rule: 'tight', to: t.length - 5 });
    expect(carriedUserTurns(t, tr.to)).toEqual([0, 2, 4]);
    const more = [...t];
    more.push(reply('a'), say('n1'));
    expect(carriedUserTurns(more, tr.to)).toEqual([0, 2, 4]);
    more.push(reply('a'), say('n2'));
    expect(carriedUserTurns(more, tr.to)).toEqual([2, 4]);
    more.push(reply('a'), say('n3'));
    expect(carriedUserTurns(more, tr.to)).toEqual([]);
    more.push(reply('a'), say('n4'));
    expect(carriedUserTurns(more, tr.to)).toEqual([]);
  });

  it('「保留的用户原话」段金样：两种收尾句、纯图片回合、非末条回合的图片占位；没有 meta 的 marker 也带', () => {
    seq = 0;
    const h = [
      raw('user', [{ type: 'text', value: 'first words' }, img('old.png')]), reply('a'),
      raw('user', [img('only.png')]),
      ...Array.from({ length: 3 }, (_, i) => call(`X${i}`, 'echo', { tool_title: 't' })).flat(),
    ];
    const to = pendingSummaryRange(h, undefined, 'tight')!.to;
    const eff = engine.buildEffectiveHistory(h, markerAt(h, to, 'SUM'));
    expect(eff).toHaveLength(1 + (h.length - 1 - to));
    expect(eff[0].parts.map(p => p.type)).toEqual(['text', 'text', 'text', 'text', 'text', 'mediaRef', 'text']);
    expect(textOfMsg(eff[0])).toBe([
      '[对话摘要] SUM',
      '',
      '【保留的用户原话】以下 2 条是摘要覆盖范围内最近的用户消息，按时间顺序原样保留。',
      '',
      '（1/2）',
      'first words',
      '[图片 old.png 已随上下文省略]',
      '',
      '（2/2）',
      '[图片 only.png]',
      '',
      '最后一条就是当前这一轮的用户指示。',
    ].join('\n'));
    expect(eff[0].parts[5]).toStrictEqual(h[2].parts[0]);
    // F07 origins are scoped to each raw message; a complete media part keeps its value in a distinct object.
    expect(eff[0].parts[5]).not.toBe(h[2].parts[0]);
    // 之后用户又发了新消息：收尾句换成「以新消息为准」；图片块仍挂着（由既有的按轮老化规则处理）
    const later = [...h, reply('done'), say('new question')];
    const eff2 = engine.buildEffectiveHistory(later, markerAt(later, to, 'SUM'));
    expect(textOfMsg(eff2[0]).endsWith('\n\n之后用户又发了新消息（见下文），有出入时以新消息为准。')).toBe(true);
    expect(eff2[0].parts.some(p => p.type === 'mediaRef')).toBe(true);
    // 常规锚点的 marker、没有 meta：摘要消息只有一段，与 F03 之前逐字节相同
    const multi = [say('q1'), reply('a'), say('q2'), reply('a'), say('q3'), reply('a'), say('q4')];
    expect(engine.buildEffectiveHistory(multi, markerAt(multi, 1, 'OLD'))[0]).toEqual({ role: 'user', parts: [{ type: 'text', value: '[对话摘要] OLD' }] });
  });
});

// ───────────────────────── P7 校验 ─────────────────────────

describe('P7 validateCompactMeta 与 parseCompactMeta', () => {
  function good(): { h: RawMessage[]; meta: CompactMeta; summary: string } {
    seq = 0;
    const h: RawMessage[] = [
      say('q1'), ...call('T1', 'file_write', { path: 'out/a.md', content: 'x', tool_title: 't' }, '已写入'), reply('a1'),
      say('q2'), reply('a2'), say('q3'), reply('a3'), say('q4'),
    ];
    const built = buildCompactMeta({ history: h, to: 3, rule: 'recent-turns', prev: undefined, reply: okReply(structured({ done: ['写了 out/a.md'] })), toolKindOf: defaultToolKindOf, record: RECORD });
    return { h, ...built };
  }
  const clone = (m: CompactMeta): CompactMeta => JSON.parse(JSON.stringify(m)) as CompactMeta;

  it('好样本没有问题；写入再读回全等（没有值为 undefined 的键）', () => {
    const { h, meta, summary } = good();
    expect(validateCompactMeta(meta, summary, h, undefined, defaultToolKindOf)).toEqual([]);
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
    expect(parseCompactMeta(JSON.stringify(meta), { summary, lastCompactedMessageId: h[3].id })).toEqual(meta);
  });

  it('逐条规则各一份坏样本', () => {
    const { h, meta, summary } = good();
    const bad = (mutate: (m: CompactMeta) => void, s = summary, hist = h, prev?: CompactMarker): string[] => { const m = clone(meta); mutate(m); return validateCompactMeta(m, s, hist, prev, defaultToolKindOf); };
    expect(bad(m => { (m as { v: number }).v = 3; })).toContain('版本不是 2');
    expect(bad(() => undefined, `${summary} `)).toContain('摘要指纹与正文不符');
    expect(bad(m => { m.model.decisions = Array.from({ length: 15 }, () => 'd'.repeat(5_000)); })).toContain('结构超过 64KB');
    expect(bad(m => { m.coverage.toMessageId = 'nope'; })).toEqual(['覆盖区间的消息不在历史里']);
    expect(bad(m => { m.coverage.fromMessageId = h[1].id; })).toContain('覆盖区间的先后不对');
    expect(bad(m => { m.coverage.messageCount = 9; })).toContain('覆盖区间的条数不符');
    expect(bad(() => undefined, summary, h, markerAt(h, 1))).toContain('增量没有紧接上一个锚点');
    expect(bad(m => { m.coverage.toMessageId = h[h.length - 2].id; m.coverage.increment.toMessageId = h[h.length - 2].id; })).toContain('锚点之后不足 2 条消息');
    expect(bad(m => { m.coverage.toMessageId = h[1].id; m.coverage.increment.toMessageId = h[1].id; })).toContain('锚点拆开了工具调用与结果');
    expect(bad(m => { m.evidence.userInstructions.push({ messageId: h[6].id, text: 'q3', clipped: false, images: 0 }); })).toContain('用户指示不在覆盖区间内');
    expect(bad(m => { m.evidence.carriedUserMessageIds = [h[0].id]; })).toContain('被带上的用户回合与历史不符');
    expect(bad(m => { m.evidence.fileChanges.push({ path: 'ghost.md', tool: 'file_write', count: 1, lastToolUseId: 'T9', lastMessageId: h[1].id }); })).toContain('文件变更没有对应的成功调用');
    expect(bad(m => { m.model.goal = ' '; })).toContain('【目标】为空');
    expect(bad(m => { m.model.todo = Array.from({ length: 21 }, (_, i) => `t${i}`); })).toContain('列表超过条数上限');
    expect(bad(m => { m.model.done.push('已修改 src/never.ts'); })).toContain('有没有工具记录佐证的陈述');
  });

  it('parseCompactMeta：坏 JSON、版本不认识、形状不对、超过 64KB、锚点或摘要被改写过 → undefined', () => {
    const { h, meta, summary } = good();
    const mk = { summary, lastCompactedMessageId: h[3].id };
    const json = JSON.stringify(meta);
    expect(parseCompactMeta(null, mk)).toBeUndefined();
    expect(parseCompactMeta('{not json', mk)).toBeUndefined();
    expect(parseCompactMeta(JSON.stringify({ ...meta, v: 3 }), mk)).toBeUndefined();
    expect(parseCompactMeta(JSON.stringify({ ...meta, evidence: 1 }), mk)).toBeUndefined();
    expect(parseCompactMeta(JSON.stringify({ ...meta, pad: 'x'.repeat(70_000) }), mk)).toBeUndefined();
    expect(parseCompactMeta(json, { ...mk, lastCompactedMessageId: h[5].id })).toBeUndefined();
    expect(parseCompactMeta(json, { ...mk, summary: `${summary}!` })).toBeUndefined();
    expect(meta.summaryDigest).toBe(summaryDigestOf(summary));
    expect(meta.summaryDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('collectEvidence：结果四态、失败的写入不进文件变更、没有 path 的写入算调用', () => {
    seq = 0;
    const h = [
      say('q'),
      ...call('A', 'file_write', { path: 'a.md', content: 'x', tool_title: 't' }, '已取消', { success: false, status: 'cancelled' }),
      ...call('B', 'file_write', { path: 'b.md', content: 'x', tool_title: 't' }, '?', { success: false, status: 'unknown' }),
      ...call('C', 'file_edit', { tool_title: 'no path' }, 'ok'),
      use('D', 'shell_execute', { command: 'x', tool_title: 'hang' }),
    ];
    const ev = collectEvidence(h, h.length - 1, defaultToolKindOf);
    expect(ev.fileChanges).toEqual([]);
    expect(ev.runs.map(r => `${r.tool}:${r.state}`)).toEqual(['file_edit:ok', 'shell_execute:unknown']);
    expect(ev.unsettledCalls).toBe(3);
  });

  it('P7b toolUseId 跨轮复用（含空串）、较早那次没成功：文件变更记的是后来成功的那次，校验按消息定位它，不判 invalid', () => {
    const earlier = [{ success: false }, { success: false, status: 'cancelled' as const }, { success: false, status: 'unknown' as const }];
    for (const id of ['call_0', 'functions.file_write:0', '']) {
      for (const o of earlier) {
        seq = 0;
        const h: RawMessage[] = [
          say('q1'),
          ...call(id, 'file_write', { path: 'out', content: 'x', tool_title: 't' }, 'EISDIR', o),
          ...call(id, 'file_write', { path: 'out/a.md', content: 'x', tool_title: 't' }, '已写入'),
          reply('a1'), say('q2'), reply('a2'), say('q3'), reply('a3'), say('q4'),
        ];
        const built = buildCompactMeta({ history: h, to: 5, rule: 'recent-turns', prev: undefined, reply: okReply(structured({ done: ['写了 out/a.md'] })), toolKindOf: defaultToolKindOf, record: RECORD });
        const where = `id=${JSON.stringify(id)} earlier=${JSON.stringify(o)}`;
        expect(built.meta.evidence.fileChanges, where).toEqual([{ path: 'out/a.md', tool: 'file_write', count: 1, lastToolUseId: id, lastMessageId: h[3].id }]);
        expect(built.meta.model.done, where).toEqual(['写了 out/a.md']);
        expect(validateCompactMeta(built.meta, built.summary, h, undefined, defaultToolKindOf), where).toEqual([]);
        // 指到较早那次（没成功的）调用所在的消息、或换成别的路径：对不上
        const moved = JSON.parse(JSON.stringify(built.meta)) as CompactMeta; moved.evidence.fileChanges[0].lastMessageId = h[1].id;
        expect(validateCompactMeta(moved, built.summary, h, undefined, defaultToolKindOf)).toContain('文件变更没有对应的成功调用');
        const other = JSON.parse(JSON.stringify(built.meta)) as CompactMeta; other.evidence.fileChanges[0].path = 'out/ghost.md';
        expect(validateCompactMeta(other, built.summary, h, undefined, defaultToolKindOf)).toContain('文件变更没有对应的成功调用');
      }
    }
  });

  it('P7c 同一批里两个调用 id 相同、成败不同：结果按出现次序配，失败的写入不进文件变更，成功的不漏记', () => {
    const batch = (outcomes: boolean[]): RawMessage[] => {
      seq = 0;
      return [
        say('q'),
        raw('assistant', ['out/a.md', 'out/b.md'].map(path => ({ type: 'toolUse' as const, value: { toolUseId: 'dup', name: 'file_write', input: JSON.stringify({ path, content: 'x', tool_title: 't' }) } }))),
        raw('user', outcomes.map(ok => ({ type: 'toolResult' as const, value: { toolUseId: 'dup', output: ok ? '已写入' : 'EACCES', success: ok, status: ok ? 'success' as const : 'failed' as const } }))),
        reply('a'), say('q2'), reply('a2'), say('q3'),
      ];
    };
    const changed = (h: RawMessage[]): string[] => collectEvidence(h, 2, defaultToolKindOf).fileChanges.map(f => f.path);
    expect(changed(batch([true, false]))).toEqual(['out/a.md']);
    expect(changed(batch([false, true]))).toEqual(['out/b.md']);
    expect(changed(batch([true, true]))).toEqual(['out/a.md', 'out/b.md']);
    // 只回了一条结果：第二个调用没有结果，算未结的调用，不借第一条的结果
    const one = batch([true]);
    expect(changed(one)).toEqual(['out/a.md']);
    expect(collectEvidence(one, 2, defaultToolKindOf).unsettledCalls).toBe(1);
    // 建 meta 与校验用同一套配对：第二个成功、第一个失败时也通过
    const h = batch([false, true]);
    const built = buildCompactMeta({ history: h, to: 2, rule: 'recent-turns', prev: undefined, reply: okReply(structured({ done: ['写了 out/b.md', '写了 out/a.md'] })), toolKindOf: defaultToolKindOf, record: RECORD });
    // 入参不分成败的话 out/a.md 也算有佐证；它的写入失败了，这条陈述移除
    expect(built.meta.model.done).toEqual(['写了 out/b.md']);
    expect(validateCompactMeta(built.meta, built.summary, h, undefined, defaultToolKindOf)).toEqual([]);
  });

  it('P7d collectEvidence：超长用户指示的头尾两个切点都不把代理对切成半个', () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const instruction = (text: string): { text: string; clipped: boolean } => {
      seq = 0;
      const h = [say(text), reply('a1'), say('q2'), reply('a2'), say('q3'), reply('a3'), say('q4')];
      const { text: t, clipped } = collectEvidence(h, 1, defaultToolKindOf).userInstructions[0];
      return { text: t, clipped };
    };
    // 长 901：尾段的起点（下标 701）正是 emoji 的低半——后挪一位，整个 emoji 归入省略的中段
    const tail = instruction(`${'a'.repeat(700)}😀${'b'.repeat(199)}`);
    expect(tail).toEqual({ text: `${'a'.repeat(600)}…${'b'.repeat(199)}`, clipped: true });
    // 头段的末位（下标 599）正是 emoji 的高半——少取一位
    const head = instruction(`${'a'.repeat(599)}😀${'b'.repeat(400)}`);
    expect(head).toEqual({ text: `${'a'.repeat(599)}…${'b'.repeat(200)}`, clipped: true });
    // 尾段正好从 emoji 的高半开始：整个保留
    const whole = instruction(`${'a'.repeat(700)}😀${'b'.repeat(198)}`);
    expect(whole).toEqual({ text: `${'a'.repeat(600)}…😀${'b'.repeat(198)}`, clipped: true });
    for (const x of [tail, head, whole]) expect(lone.test(x.text)).toBe(false);
  });
});
