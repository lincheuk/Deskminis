/**
 * F03 验收 5：固定长任务。没有 API Key、不调真实模型——主模型与摘要模型都是脚本（下一步动作只由收到的请求体决定），
 * 走完整的 runAgentLoop、真 OpenAIProvider、真文件工具（临时工作区）。
 * 断言落在「压缩后发给模型的请求体」的结构、磁盘上的文件与工具的执行次数上，不是摘要里有没有某个字符串。
 *
 * 任务：单个用户回合，14 步，每步先读 ref/part-k.txt 再写 out/step-k.md；约束 C1（只能写 out/ 下）、C2（不改 out/KEEP.md）。
 * 资料窗口 64K（手动），端点真实上限 20K（按输入 + max_tokens 校验，Kimi 式报文）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelCatalog } from '../src/minisd/providers/model-catalog';
import type { LoopEvent } from '../src/minisd/agent/loop';
import { CompactEngine } from '../src/minisd/agent/compact';
import { compactionViewOf, validateCompactMeta, type ToolKindOf } from '../src/minisd/agent/compact-meta';
import type { CompactMarker, RawMessage } from '../src/shared/types';
import type { CompactMeta } from '../src/shared/compaction';
import type { RequestBudget } from '../src/shared/request-budget';
import {
  C1_TEXT, LIES, bodyView, errorsOf, eventsOf, execLog, longTaskPrompt, markers, mkCatalog, mkCtx, openai, partContent, relay, runLoop, scriptedAgent,
  scriptedSummarizer, stepContent, strictEndpoint, type BodyView, type Ctx, type ExecEntry, type SummarizerMode,
} from './overflow-recovery-fixture';

let dir: string;
let catalog: ModelCatalog;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-f03-long-'));
  catalog = await mkCatalog(dir);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const STEPS = 14;
const LIMIT = 20_000;
const KEEP = 'keep this file exactly as it is\n';
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

interface MainShot { view: BodyView; status: number; execCount: number; wroteOk: Set<string> }
interface LongRun {
  ctx: Ctx; events: LoopEvent[]; log: ExecEntry[]; shots: MainShot[]; history: RawMessage[]; u1: RawMessage;
  ep: ReturnType<typeof strictEndpoint>; budgets: RequestBudget[]; kindOf: ToolKindOf;
}
/** 库里的 marker（带解析过的 meta），按写入顺序。 */
function markerRows(run: LongRun): CompactMarker[] {
  const m = markers(run.ctx.db, run.ctx.sessionId);
  return m.markers.map(r => {
    const meta = m.meta.find(x => x.marker_id === r.id);
    return {
      id: String(r.id), sessionId: String(r.session_id), summary: String(r.summary), lastCompactedMessageId: String(r.last_compacted_message_id),
      createdAt: Number(r.created_at), ...(meta ? { meta: JSON.parse(String(meta.meta_json)) as CompactMeta } : {}),
    };
  });
}

/** 跑一遍固定长任务；每个主请求到达端点时记下那一刻的执行日志长度与已成功写入的路径。 */
async function runLongTask(mode: SummarizerMode): Promise<LongRun> {
  const exec = execLog();
  const ctx = mkCtx(dir, { tools: exec.tools });
  for (let k = 1; k <= STEPS; k++) ctx.seed(`ref/part-${k}.txt`, partContent(k));
  ctx.seed('out/KEEP.md', KEEP);
  const u1 = ctx.say(longTaskPrompt(STEPS));
  const cfg = relay(64_000);
  const agent = scriptedAgent({ failStep: 5 });
  const ep = strictEndpoint({ limit: LIMIT, style: 'kimi', main: agent, summary: scriptedSummarizer(mode) });
  // 端点收到每个主请求（含被拒的）时的现场：执行日志此刻的长度、此刻已成功的写入
  const marks: { execCount: number; wroteOk: Set<string> }[] = [];
  const fetchImpl: typeof ep.fetchImpl = (async (url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    if (body.messages?.[0]?.content !== '你是对话摘要助手。') {
      marks.push({ execCount: exec.log.length, wroteOk: new Set(exec.log.filter(e => e.name === 'file_write' && e.success).map(e => e.path)) });
    }
    return (ep.fetchImpl as unknown as (u: unknown, i: unknown) => Promise<Response>)(url, init);
  }) as unknown as typeof ep.fetchImpl;
  const { events, budgets } = await runLoop(ctx, catalog, { primary: { provider: openai(cfg, fetchImpl), input: cfg } });
  const shots = ep.mains().map((h, i) => ({ view: bodyView(h.body), status: h.status, ...marks[i] }));
  // 与循环同一套工具分类：按注册表的调度声明
  const kindOf: ToolKindOf = name => {
    const s = ctx.tools.get(name)?.scheduling;
    return !s ? 'effect' : s.readOnly ? 'read' : s.sideEffects === 'local-files' ? 'write' : 'effect';
  };
  return { ctx, events, log: exec.log, shots, history: ctx.store.listMessages(ctx.sessionId), u1, ep, budgets, kindOf };
}

/** 历史下标 < covered 的消息里执行成功的 file_write 的路径（由落库消息独立算出，不看程序记录）。 */
function writesCoveredBy(history: RawMessage[], covered: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < covered; i++) {
    for (const p of history[i].parts) {
      if (p.type !== 'toolUse') continue;
      const u = p.value as { toolUseId: string; name: string; input: string };
      if (u.name !== 'file_write') continue;
      const r = history[i + 1].parts.find(x => x.type === 'toolResult' && (x.value as { toolUseId: string }).toolUseId === u.toolUseId);
      if (r && (r.value as { success: boolean }).success) out.add(String((JSON.parse(u.input) as { path: string }).path));
    }
  }
  return out;
}

/** 三个变体共同的结果：14 步各成功写入一次、约束没被违反、没有重放工具。 */
function expectTaskDone(run: LongRun): void {
  const { ctx, log, events, history } = run;
  expect(errorsOf(events)).toEqual([]);
  expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
  // 三种摘要脚本给的都是结构完整的分节文本：每一次压缩都该成功写入（校验拦下来的话恢复会退到只剩裁剪）
  expect(eventsOf(events, 'compactFailed')).toEqual([]);
  // 磁盘：14 个文件内容各对各；KEEP 没动；out/ 之外没有新文件
  for (let k = 1; k <= STEPS; k++) expect(readFileSync(join(ctx.workspace, `out/step-${k}.md`), 'utf8')).toBe(stepContent(k));
  expect(sha(readFileSync(join(ctx.workspace, 'out/KEEP.md')))).toBe(sha(KEEP));
  expect(readdirSync(ctx.workspace).sort()).toEqual(['out', 'ref']);
  expect(readdirSync(join(ctx.workspace, 'out')).sort()).toEqual(['KEEP.md', ...Array.from({ length: STEPS }, (_, i) => `step-${i + 1}.md`)].sort());
  // 执行日志：每一步的写入恰好成功一次；总执行次数等于历史里 toolUse 的条数（没有不落库的执行，也没有重放）
  for (let k = 1; k <= STEPS; k++) expect(log.filter(e => e.name === 'file_write' && e.path === `out/step-${k}.md` && e.success)).toHaveLength(1);
  expect(log.filter(e => e.name === 'file_write' && e.success)).toHaveLength(STEPS);
  const toolUses = history.flatMap(m => m.parts.filter(p => p.type === 'toolUse'));
  expect(log).toHaveLength(toolUses.length);
  // 每次事故从被拒到重发成功之间，工具执行次数不变
  run.shots.forEach((s, i) => {
    if (s.status !== 400) return;
    const next = run.shots.slice(i + 1).find(x => x.status === 200);
    expect(next?.execCount).toBe(s.execCount);
  });
}

describe('验收 5：固定长任务压缩后保留用户约束、未完成步骤与真实修改路径', () => {
  it('T1 faithful 摘要：14 步各一次；压缩后的每个请求体里，文件变更等于真实成功的写入、待办含全部未做步骤、U1 原话在', async () => {
    const run = await runLongTask('faithful');
    expectTaskDone(run);
    const { events, shots, history, u1, ep } = run;

    const withSummary = shots.filter(s => s.view.summary);
    expect(withSummary.length).toBeGreaterThan(0);
    for (const s of withSummary) {
      const sum = s.view.summary!;
      const covered = sum.record!.covered!;
      // 程序记录的文件变更 = 那一刻锚点之前执行成功的写入；第 5 步写错的那个路径（目录）不在里面
      expect(new Set(sum.record!.fileChanges)).toEqual(writesCoveredBy(history, covered));
      expect(sum.record!.fileChanges).not.toContain('out');
      // 模型部分的待办包含所有还没执行的步骤
      const todo = (sum.sections.待办 ?? []).join('\n');
      for (let k = 1; k <= STEPS; k++) if (!s.wroteOk.has(`out/step-${k}.md`)) expect(todo).toContain(`out/step-${k}.md`);
      // U1 被覆盖：原话全文随摘要消息带上，收尾句说明它就是当前这一轮
      expect(sum.carried?.quotes).toEqual([longTaskPrompt(STEPS)]);
      expect(sum.carried?.closing).toBe('最后一条就是当前这一轮的用户指示。');
      expect(s.view.toolPairs).toEqual({ orphans: [], missing: [] });
      if (s.status === 200) expect(s.view.est + s.view.maxTokens).toBeLessThanOrEqual(LIMIT);
    }

    // 事件：至少一次在同一模型上恢复、至少一次覆盖了 U1 的压缩；学到的上限让后面的轮次提前减压，不再逐轮撞端点
    expect(eventsOf(events, 'contextRecovery').some(e => e.view.phase === 'recovered')).toBe(true);
    const compacted = eventsOf(events, 'compacted');
    expect(compacted.length).toBeGreaterThan(0);
    expect(compacted[0].detail.coverage.fromMessageId).toBe(u1.id);
    expect(ep.rejected().length).toBeLessThanOrEqual(3);
    expect(events.some(e => e.kind === 'fallback')).toBe(false);
    // 库：原历史只追加不改写；每条 marker 的 meta 都通过结构校验
    expect(history[0]).toEqual(u1);
    const rows = markerRows(run);
    expect(rows.length).toBe(compacted.length);
    rows.forEach((m, i) => expect(validateCompactMeta(m.meta!, m.summary, history, rows[i - 1], run.kindOf), `marker ${i}`).toEqual([]));

    // 界面验证用的导出（设了 DM_F03_DUMP 才写；平时不写任何文件）
    const dump = process.env.DM_F03_DUMP;
    if (dump) {
      mkdirSync(dump, { recursive: true });
      const latest = run.ctx.store.getLatestCompactMarker(run.ctx.sessionId)!;
      writeFileSync(join(dump, 't1.json'), JSON.stringify({
        events: events.filter(e => e.kind !== 'textDelta' && e.kind !== 'toolEnd'),
        contextInfo: { windowTokens: 64_000, usedTokens: run.budgets.at(-1)!.input.tokens, remaining: 0, budget: run.budgets.at(-1), live: false, compaction: compactionViewOf(latest), recovery: eventsOf(events, 'contextRecovery').at(-1)!.view },
      }, null, 1), 'utf8');
    }
  });

  it('T2 lossy 摘要（不写约束与待办）：任务仍然 14 步各一次、约束没被违反——约束来自随摘要带上的用户原话，进度来自程序记录', async () => {
    const run = await runLongTask('lossy');
    expectTaskDone(run);
    const withSummary = run.shots.filter(s => s.view.summary);
    expect(withSummary.length).toBeGreaterThan(0);
    for (const s of withSummary) {
      // 模型那一半里没有约束也没有待办；脚本看得到的约束只在「保留的用户原话」段里
      expect(s.view.summary!.sections.约束 ?? []).toEqual([]);
      expect(s.view.summary!.sections.待办 ?? []).toEqual([]);
      expect(s.view.summary!.model).not.toContain(C1_TEXT);
      expect(s.view.summary!.carried?.quotes).toEqual([longTaskPrompt(STEPS)]);
      expect(new Set(s.view.summary!.record!.fileChanges)).toEqual(writesCoveredBy(run.history, s.view.summary!.record!.covered!));
    }
  });

  it('T3 liar 摘要（声称改了没改的文件、写「测试全部通过」）：没有工具记录佐证的陈述不进摘要，也不进之后的任何请求；第 9 步照常执行恰一次', async () => {
    const run = await runLongTask('liar');
    expectTaskDone(run);
    const { history, shots } = run;
    // 第 9 步的写入在历史里的位置（结果消息的下标）
    const step9 = history.findIndex(m => m.parts.some(p => p.type === 'toolUse' && (p.value as { input: string }).input.includes('"out/step-9.md"'))) + 1;
    expect(step9).toBeGreaterThan(0);
    const early = shots.filter(s => s.view.summary && !s.wroteOk.has('out/step-9.md'));
    expect(early.length).toBeGreaterThan(0);
    for (const s of early) {
      const sum = s.view.summary!;
      for (const sec of ['已完成', '进行中', '涉及文件'] as const) expect((sum.sections[sec] ?? []).join('\n'), sec).not.toContain('out/step-9.md');
      expect(sum.text).not.toContain('测试全部通过');
      expect(sum.text).not.toContain('【文件变更】');
      expect(sum.record!.fileChanges).not.toContain('out/step-9.md');
      // 【涉及文件】里留下的每个路径都在那一刻之前的工具入参里出现过
      const seen = new Set<string>();
      for (let i = 0; i < sum.record!.covered!; i++) for (const p of history[i].parts) if (p.type === 'toolUse') seen.add(String((JSON.parse((p.value as { input: string }).input) as { path?: string }).path));
      for (const f of sum.sections.涉及文件 ?? []) expect(seen.has(f.split(/\s+/)[0]), f).toBe(true);
      expect((sum.sections.涉及文件 ?? []).some(f => f.startsWith('ref/part-'))).toBe(true);
    }
    // 落库的 marker：第 9 步执行之前写下的，三条编造的陈述都被移除（同步给对端的 summary 里也没有）；多出来的小节计数
    const rows = markerRows(run);
    const before9 = rows.filter(m => m.meta!.coverage.messageCount <= step9);
    expect(before9.length).toBeGreaterThan(0);
    for (const m of before9) {
      expect(m.meta!.model.dropped).toMatchObject({ unverified: 3, unknownSections: 1 });
      // 三条编造的陈述都不在（「第 9 步」作为待办出现是对的，不在此列）
      for (const lie of [...LIES.done, LIES.file, '【文件变更】']) expect(m.summary, lie).not.toContain(lie);
      expect(m.meta!.model.done.join('\n')).not.toContain('out/step-9.md');
      expect(m.meta!.model.files.join('\n')).not.toContain('out/step-9.md');
      expect(m.meta!.evidence.fileChanges.map(f => f.path)).not.toContain('out/step-9.md');
    }
    // 对照：第 9 步执行之后再摘要一次，「已修改 out/step-9.md」与【涉及文件】里那一条都留下（有工具入参佐证），只剩验证结论被移除
    let after9 = rows.filter(m => m.meta!.coverage.messageCount > step9);
    if (after9.length === 0) {
      const sum = strictEndpoint({ limit: 10_000_000, main: () => new Response('', { status: 500 }), summary: scriptedSummarizer('liar') });
      const made = await new CompactEngine(run.ctx.store).summarize(history, run.ctx.sessionId, openai(relay(1_000_000), sum.fetchImpl), { rule: 'tight', trigger: 'overflow', toolKindOf: run.kindOf });
      expect(made?.meta).toBeDefined();
      after9 = [made!];
    }
    for (const m of after9) {
      expect(m.meta!.model.dropped.unverified).toBe(1);
      expect(m.meta!.model.done).toContain('已修改 out/step-9.md');
      expect(m.meta!.model.files).toContain('out/step-9.md 已改');
      expect(m.summary).not.toContain('测试全部通过');
    }
  });
});
