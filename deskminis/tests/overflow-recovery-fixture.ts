import { requestToolOutput } from './request-tool-output-fixture';
/**
 * F03 用例共用的夹具：按上限校验的假端点、由请求体决定回复的摘要脚本与主模型脚本、包住真文件工具的执行日志、
 * 把请求体读成结构的 bodyView。写法沿用 tests/request-budget-loop.test.ts（真 runAgentLoop + 真 Provider 类 + 抓请求体的假端点），
 * 那个文件不动，这里另写一份。
 *
 * 约定：
 *  - 大文本一律 ASCII：本机估算（非 CJK ÷4）与假端点的口径（JSON 长度 ÷4）才是同一个数；
 *  - 受控时序用闸门（测试持有的 promise），不用 sleep；
 *  - bodyView 自带解析器读请求体里的摘要消息，不调产品的渲染 / 解析函数（不用产品代码验证产品输出）；
 *  - 假端点命中超过 MAX_HITS 次直接抛错：无限循环会变红，不会挂住。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { ToolRegistry } from '../src/minisd/tools/registry';
import type { ToolContext, ToolExecutor } from '../src/minisd/tools/types';
import { fileEditTool, fileReadTool, fileWriteTool } from '../src/minisd/tools/files';
import { MinisPaths } from '../src/minisd/paths';
import { OpenAIProvider } from '../src/minisd/providers/openai';
import type { FetchLike } from '../src/minisd/providers/types';
import type { RuntimeModelInput } from '../src/minisd/providers/runtime-model';
import type { ContentPart, RawMessage } from '../src/shared/types';

export type Body = Record<string, any>;
export const MAX_HITS = 60;
export const SUMMARY_SYSTEM = '你是对话摘要助手。';

export const ascii = (n: number): string => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n);
/** 测试持有的闸门。 */
export function gate() { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { wait, open }; }

const RELAY = 'https://relay.example/v1';
/** 中转上目录未收录的型号 + 手动窗口：窗口是硬来源（manual），输出上限落到 min(8192, 窗口的 3/4)。 */
export const relay = (contextWindow: number, extra: Partial<RuntimeModelInput> = {}): RuntimeModelInput =>
  ({ id: 'inst-relay', kind: 'openai-compat', baseUrl: RELAY, modelId: 'unlisted-model', contextWindow, ...extra });
/** 窗口没有资料的中转配置（预算按 128K 回退值判水位，不据此收紧输出）。 */
export const relayUnknown = (extra: Partial<RuntimeModelInput> = {}): RuntimeModelInput =>
  ({ id: 'inst-unknown', kind: 'openai-compat', baseUrl: RELAY, modelId: 'unlisted-model', ...extra });
export const openai = (input: RuntimeModelInput, fetchImpl: FetchLike) =>
  new OpenAIProvider({ apiKey: 'k', modelId: input.modelId, baseUrl: input.baseUrl!, fetchImpl });

// ───────────────────────── SSE 应答 ─────────────────────────

export const sse = (frames: unknown[], done = true): Response =>
  new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
export const openaiOk = (text: string, usage?: Record<string, unknown>, finish = 'stop'): Response => sse([
  { choices: [{ index: 0, delta: { content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ...(usage ? [{ choices: [], usage }] : []),
]);
export const openaiToolCall = (id: string, name: string, args: Record<string, unknown>, usage?: Record<string, unknown>): Response => sse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ...(usage ? [{ choices: [], usage }] : []),
]);
/** 可由测试逐帧放行的 SSE 流：push 一帧出一帧，close 正常结束，fail 以错误结束。取消信号到达时流以 AbortError 结束。 */
export function controlledSse(signal?: AbortSignal) {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  let closed = false;
  const fail = (e: unknown) => { if (!closed) { closed = true; try { ctrl.error(e); } catch { /* 已结束 */ } } };
  signal?.addEventListener('abort', () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (frame: unknown) => { if (!closed) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`)); },
    close: () => { if (!closed) { closed = true; ctrl.enqueue(enc.encode('data: [DONE]\n\n')); ctrl.close(); } },
    fail,
  };
}

// ───────────────────────── 假端点 ─────────────────────────

/** 假端点估算输入的口径：请求体的 messages（含 system）与 tools 的 JSON 长度 ÷ 4。 */
export const estOf = (body: Body): number =>
  Math.ceil((JSON.stringify(body.messages ?? []).length + (body.tools ? JSON.stringify(body.tools).length : 0)) / 4);
export const isSummaryRequest = (body: Body): boolean => body.messages?.[0]?.role === 'system' && body.messages[0].content === SUMMARY_SYSTEM;

export type RejectStyle = 'kimi' | 'openai' | 'anthropic' | 'plain' | 'lying';
/** 各家超窗报文（overflow.ts 的模式表都认得）。lying：两个数颠倒，提示不可用。 */
export function rejection(style: RejectStyle, limit: number, requested: number): Response {
  const message = style === 'kimi' ? `Invalid request: Your request exceeded model token limit: ${limit} (requested: ${requested})`
    : style === 'openai' ? `This model's maximum context length is ${limit} tokens. However, you requested about ${requested} tokens (${requested} in the messages). Please reduce the length of the messages or completion.`
    : style === 'anthropic' ? `prompt is too long: ${requested} tokens > ${limit} maximum`
    : style === 'lying' ? `Invalid request: Your request exceeded model token limit: ${requested} (requested: ${limit})`
    : 'the request exceeds the available context size, try increasing it';
  return new Response(JSON.stringify({ error: { message } }), { status: 400 });
}

export interface Hit { kind: 'main' | 'summary'; body: Body; est: number; count: number; status: number }
export interface HitInfo {
  /** 这是第几次命中（从 0 起）；mainN / summaryN：同类请求里的序号。 */
  n: number; mainN: number; summaryN: number;
  /** 已被收下（没有被上限拒绝）的主请求数，不含这一次。 */
  accepted: number;
  est: number; count: number; signal?: AbortSignal;
  /** 按端点口径回报的 usage（末帧带上它，循环会拿去校准）。 */
  usage: Record<string, unknown>;
}
export type Responder = (body: Body, info: HitInfo) => Response | Promise<Response>;

export interface StrictEndpointOptions {
  /** 端点的真实上限。函数形态：入参是已收下的主请求数（恢复成功后再降一档的场景用）。 */
  limit: number | ((acceptedMain: number) => number);
  /** total：输入 + max_tokens ≤ limit；input：只校验输入。缺省 total。 */
  counts?: 'total' | 'input';
  style?: RejectStyle;
  /** 端点的计数是本机估算的多少倍（缺省 1）。校验与回报的 usage 都按它算。 */
  scale?: number;
  main: Responder;
  /** 摘要请求的应答；不给时摘要请求按 500 处理（用例没预期会有摘要请求）。 */
  summary?: Responder;
  /** false：摘要请求不过上限校验（由摘要脚本自己决定回什么）。缺省 true。 */
  checkSummary?: boolean;
  /** 按主请求序号强行拒绝（不看 limit）：返回报文里要报的上限；返回 undefined 则照常按 limit 校验。 */
  forceReject?: (info: { mainN: number; est: number }) => number | undefined;
}

/** 按上限校验的假端点。每次命中记 { kind, body, est, count, status }；命中超过 MAX_HITS 次直接抛错。 */
export function strictEndpoint(o: StrictEndpointOptions) {
  const hits: Hit[] = [];
  let accepted = 0;
  const scale = o.scale ?? 1;
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    if (hits.length >= MAX_HITS) throw new Error(`假端点命中超过 ${MAX_HITS} 次：循环没有收敛`);
    const body = JSON.parse(String(init?.body)) as Body;
    const kind: Hit['kind'] = isSummaryRequest(body) ? 'summary' : 'main';
    const est = estOf(body);
    const count = Math.ceil(est * scale);
    const hit: Hit = { kind, body, est, count, status: 200 };
    const info: HitInfo = {
      n: hits.length, mainN: hits.filter(h => h.kind === 'main').length, summaryN: hits.filter(h => h.kind === 'summary').length,
      accepted, est, count, signal: init?.signal,
      usage: { prompt_tokens: count, completion_tokens: 7, total_tokens: count + 7 },
    };
    hits.push(hit);
    const requested = count + (o.counts === 'input' ? 0 : Number(body.max_tokens ?? 0));
    const forced = kind === 'main' ? o.forceReject?.({ mainN: info.mainN, est }) : undefined;
    if (forced !== undefined) {
      hit.status = 400;
      return rejection(o.style ?? 'kimi', forced, requested);
    }
    const limit = typeof o.limit === 'function' ? o.limit(accepted) : o.limit;
    if ((kind === 'main' || o.checkSummary !== false) && requested > limit) {
      hit.status = 400;
      return rejection(o.style ?? 'kimi', limit, requested);
    }
    if (kind === 'main') accepted++;
    const res = await (kind === 'summary' ? (o.summary ?? (() => new Response('no summary expected', { status: 500 }))) : o.main)(body, info);
    hit.status = res.status;
    return res;
  }) as unknown as FetchLike;
  return {
    fetchImpl, hits,
    mains: () => hits.filter(h => h.kind === 'main'),
    summaries: () => hits.filter(h => h.kind === 'summary'),
    rejected: () => hits.filter(h => h.status === 400),
  };
}

// ───────────────────────── 会话与工具 ─────────────────────────

export interface CtxOptions { db?: Database.Database; sessionId?: string; tools?: ToolExecutor[] }
export function mkCtx(dir: string, opts: CtxOptions = {}) {
  const db = opts.db ?? openDb(':memory:');
  const store = new ChatStore(db);
  const sessionId = opts.sessionId ?? store.createSession().id;
  const tools = new ToolRegistry();
  for (const t of opts.tools ?? [echoTool]) tools.register(t);
  const paths = new MinisPaths(join(dir, 'root')); paths.ensureSessionDirs(sessionId);
  const toolContext: ToolContext = { sessionId, paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } };
  // listMessages 按 (created_at, id) 排序、nowEpoch 只到毫秒：同一毫秒里连着追加会按随机 id 排，这里给严格递增的时间
  let at = store.nowEpoch();
  const add = (role: 'user' | 'assistant', parts: ContentPart[], extra: Partial<RawMessage> = {}): RawMessage =>
    store.appendMessage({ id: store.newId(), sessionId, role, parts, createdAt: (at += 0.01), streamInterruptCount: 0, ...extra });
  const say = (text: string): RawMessage => add('user', [{ type: 'text', value: text }]);
  const reply = (text: string): RawMessage => add('assistant', [{ type: 'text', value: text }]);
  /** 一轮工具调用：assistant(toolUse) + user(toolResult)。 */
  const call = (id: string, name: string, input: Record<string, unknown>, output: string, o: { success?: boolean; status?: 'success' | 'failed' | 'cancelled' | 'unknown' } = {}): void => {
    add('assistant', [{ type: 'toolUse', value: { toolUseId: id, name, input: JSON.stringify(input) } }]);
    const success = o.success ?? true;
    add('user', [{ type: 'toolResult', value: { toolUseId: id, output, success, status: o.status ?? (success ? 'success' : 'failed') } }]);
  };
  /** 一串 echo 调用回合：sizes[i] 是第 i 轮工具结果的字符数。 */
  const rounds = (prefix: string, sizes: number[]): void => sizes.forEach((size, i) =>
    call(`${prefix}${i + 1}`, 'echo', { text: `r${i + 1}`, tool_title: 't' }, ascii(size)));
  const file = (name: string, bytes: Uint8Array): ContentPart => {
    writeFileSync(join(paths.sessionBucket(sessionId, 'attachments'), name), bytes);
    return { type: 'mediaRef', value: { id: name, relativePath: `attachments/${name}`, mimeType: name.endsWith('.png') ? 'image/png' : 'image/jpeg' } };
  };
  const workspace = paths.sessionBucket(sessionId, 'workspace');
  /** 在工作区里预置文件（相对路径）。 */
  const seed = (rel: string, content: string): void => { const abs = join(workspace, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content, 'utf8'); };
  return { db, store, tools, toolContext, sessionId, paths, workspace, add, say, reply, call, rounds, file, seed };
}
export type Ctx = ReturnType<typeof mkCtx>;

export const echoTool: ToolExecutor = {
  definition: { name: 'echo', description: 'echo', parameters: { text: { type: 'string', description: 't' }, tool_title: { type: 'string', description: 't' } }, required: ['text', 'tool_title'] },
  scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none' },
  async execute(input) { return { output: `echo:${String(input.text)}`, success: true }; },
};

export interface ExecEntry { seq: number; name: string; path: string; success: boolean }
/** 包住真的 file_write / file_edit / file_read（临时工作区），记每次 execute 的工具名、路径、序号与成败。
 *  extra：另外要记账的工具（照样包一层）。 */
export function execLog(extra: ToolExecutor[] = []) {
  const log: ExecEntry[] = [];
  const wrap = (t: ToolExecutor): ToolExecutor => ({
    ...t,
    async execute(input, ctx) {
      const entry: ExecEntry = { seq: log.length, name: t.definition.name, path: String(input.path ?? ''), success: false };
      log.push(entry); // 先记后执行：执行器抛错（比如向目录路径写）也算执行过一次
      const r = await t.execute(input, ctx);
      entry.success = r.success;
      return r;
    },
  });
  return { log, tools: [fileReadTool, fileWriteTool, fileEditTool, ...extra].map(wrap) };
}

/** 界面验证用的导出（work\verify\F03\verify-f03-ui.mjs 把这些真引擎产生的事件喂给真组件）：设了 DM_F03_DUMP 才写，平时不写任何文件。 */
export function dumpForUi(name: string, data: unknown): void {
  const out = process.env.DM_F03_DUMP;
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.json`), JSON.stringify(data, null, 1), 'utf8');
}

/** listMessages 的 JSON：用来逐字节比对原历史。 */
export const snapshotRaw = (store: ChatStore, sessionId: string): string => JSON.stringify(store.listMessages(sessionId));
/** compact_markers 与 compact_marker_meta 的行（meta 表在迁移之前不存在时给空数组）。 */
export function markers(db: Database.Database, sessionId: string): { markers: Record<string, unknown>[]; meta: Record<string, unknown>[] } {
  const rows = db.prepare('SELECT * FROM compact_markers WHERE session_id=? ORDER BY created_at ASC, rowid ASC').all(sessionId) as Record<string, unknown>[];
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='compact_marker_meta'").get();
  const meta = has ? db.prepare('SELECT * FROM compact_marker_meta WHERE session_id=? ORDER BY created_at ASC, rowid ASC').all(sessionId) as Record<string, unknown>[] : [];
  return { markers: rows, meta };
}

// ───────────────────────── 请求体 → 结构 ─────────────────────────

const SECTION_NAMES = ['目标', '约束', '已完成', '进行中', '待办', '关键决策', '涉及文件'] as const;
type SectionName = typeof SECTION_NAMES[number];

/** 把分节文本读成 { 小节名: 条目[] }（夹具自己的解析器）。「（无）」不算条目。 */
export function readSections(text: string): Partial<Record<SectionName, string[]>> {
  const out: Partial<Record<SectionName, string[]>> = {};
  let cur: SectionName | undefined;
  for (const line of text.split('\n')) {
    const m = /^【(目标|约束|已完成|进行中|待办|关键决策|涉及文件)】\s*(.*)$/.exec(line.trim());
    if (m) { cur = m[1] as SectionName; out[cur] = out[cur] ?? []; if (m[2]) out[cur]!.push(m[2]); continue; }
    if (/^【.+】/.test(line.trim())) { cur = undefined; continue; }
    if (!cur) continue;
    const item = line.replace(/^\s*[-•*]\s*/, '').trim();
    if (item && item !== '（无）' && item !== '无') out[cur]!.push(item);
  }
  return out;
}

export interface RecordView {
  raw: string;
  /** 「覆盖：会话开头起的 N 条消息已摘要」里的 N。 */
  covered?: number;
  instructions: string[];
  /** 文件变更：路径（工具名 ×次数）里的路径。 */
  fileChanges: string[];
  runs: string[];
  carriedConstraints: string[];
  unsettled?: number;
}
function readRecord(raw: string): RecordView {
  const v: RecordView = { raw, instructions: [], fileChanges: [], runs: [], carriedConstraints: [] };
  const cov = /覆盖：会话开头起的 (\d+) 条消息已摘要/.exec(raw);
  if (cov) v.covered = Number(cov[1]);
  const uns = /结果未知或已取消的调用 (\d+) 次/.exec(raw);
  if (uns) v.unsettled = Number(uns[1]);
  let mode: 'ins' | 'files' | 'runs' | 'carried' | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('用户指示（')) { mode = 'ins'; continue; }
    if (line.startsWith('文件变更（')) { mode = 'files'; continue; }
    if (line.startsWith('其它有副作用的调用（')) { mode = 'runs'; continue; }
    if (line.startsWith('沿用的约束（')) { mode = 'carried'; continue; }
    if (line.startsWith('结果未知或已取消的调用') || line.startsWith('覆盖：') || line.startsWith('【程序记录】')) { mode = undefined; continue; }
    if (mode === 'ins') { const m = /^(\d+)\. (.*)$/.exec(line); if (m) v.instructions.push(m[2]); else if (v.instructions.length > 0) v.instructions[v.instructions.length - 1] += `\n${line}`; }
    else if (mode === 'files' && line.startsWith('- ')) v.fileChanges.push(line.slice(2).replace(/（[^（）]*）$/, ''));
    else if (mode === 'runs' && line.startsWith('- ')) v.runs.push(line.slice(2));
    else if (mode === 'carried' && line.startsWith('- ')) v.carriedConstraints.push(line.slice(2));
  }
  return v;
}

export interface SummaryView {
  /** 整条摘要消息的文字。 */
  text: string;
  /** 模型那一半（「[对话摘要] 」之后、程序记录之前）。 */
  model: string;
  sections: Partial<Record<SectionName, string[]>>;
  record?: RecordView;
  /** 「保留的用户原话」段：各条原话与收尾句。 */
  carried?: { raw: string; count: number; quotes: string[]; closing: string };
  images: number;
}
export interface PairView { id: string; name: string; args: Record<string, any>; output?: string; index: number }
export interface BodyView {
  system: string;
  /** system 之外的消息。 */
  messages: Body[];
  summary?: SummaryView;
  /** 工具调用与结果的配对（按出现顺序）。 */
  pairs: PairView[];
  /** orphans：前一条 assistant 没有声明的 tool 消息；missing：没有紧随其后的 tool 消息的调用。 */
  toolPairs: { orphans: string[]; missing: string[] };
  /** 「[工具执行被中断，结果未知]」占位的条数。 */
  placeholders: number;
  /** 各条 user 消息的图片块数（与 messages 等长；非 user 为 0）。 */
  images: number[];
  /** 全部 user 消息的文字（不含 tool 消息）。 */
  userText: string;
  est: number;
  maxTokens: number;
}
const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(c => c && c.type === 'text').map(c => String(c.text)).join('') : '';
const imagesOf = (content: unknown): number => Array.isArray(content) ? content.filter(c => c && c.type === 'image_url').length : 0;

/** 把 OpenAI 形态的请求体读成结构。 */
export function bodyView(body: Body, wrapped = true): BodyView {
  const all = body.messages as Body[];
  const system = all[0]?.role === 'system' ? String(all[0].content) : '';
  const messages = all[0]?.role === 'system' ? all.slice(1) : all;
  const pairs: PairView[] = [];
  const orphans: string[] = []; const missing: string[] = [];
  let declared = new Set<string>();
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      // 上一条 assistant 声明而没有等到结果的调用
      for (const id of declared) missing.push(id);
      declared = new Set();
      for (const tc of (m.tool_calls ?? []) as Body[]) {
        let args: Record<string, any> = {};
        try { args = JSON.parse(String(tc.function?.arguments ?? '{}')) as Record<string, any>; } catch { /* 留空 */ }
        pairs.push({ id: String(tc.id), name: String(tc.function?.name), args, index: i });
        declared.add(String(tc.id));
      }
    } else if (m.role === 'tool') {
      const id = String(m.tool_call_id);
      if (!declared.has(id)) orphans.push(id);
      else { declared.delete(id); const p = pairs.find(x => x.id === id && x.output === undefined); if (p) p.output = wrapped ? requestToolOutput(m.content) : String(m.content); }
    } else {
      for (const id of declared) missing.push(id);
      declared = new Set();
    }
  });
  for (const id of declared) missing.push(id);

  let summary: SummaryView | undefined;
  const first = messages[0];
  const firstText = first?.role === 'user' ? textOf(first.content) : '';
  if (firstText.startsWith('[对话摘要] ')) {
    const recAt = firstText.indexOf('\n\n【程序记录】');
    const carAt = firstText.indexOf('\n\n【保留的用户原话】');
    const modelEnd = Math.min(...[recAt, carAt, firstText.length].filter(x => x >= 0));
    const model = firstText.slice('[对话摘要] '.length, modelEnd);
    summary = { text: firstText, model, sections: readSections(model), images: imagesOf(first.content) };
    if (recAt >= 0) summary.record = readRecord(firstText.slice(recAt + 2, carAt >= 0 && carAt > recAt ? carAt : firstText.length));
    if (carAt >= 0) {
      const raw = firstText.slice(carAt + 2);
      const count = Number(/以下 (\d+) 条是摘要覆盖范围内最近的用户消息/.exec(raw)?.[1] ?? 0);
      const quotes: string[] = [];
      let rest = raw;
      for (let i = 1; i <= count; i++) {
        const head = `\n\n（${i}/${count}）\n`;
        const at = rest.indexOf(head);
        if (at < 0) break;
        const from = at + head.length;
        const nextHead = i < count ? rest.indexOf(`\n\n（${i + 1}/${count}）\n`, from) : rest.lastIndexOf('\n\n');
        quotes.push(rest.slice(from, nextHead < 0 ? rest.length : nextHead));
        rest = rest.slice(nextHead < 0 ? rest.length : nextHead);
      }
      summary.carried = { raw, count, quotes, closing: raw.slice(raw.lastIndexOf('\n\n') + 2) };
    }
  }
  return {
    system, messages, summary, pairs, toolPairs: { orphans, missing },
    placeholders: messages.filter(m => m.role === 'tool' && m.content === '[工具执行被中断，结果未知]').length,
    images: messages.map(m => m.role === 'user' ? imagesOf(m.content) : 0),
    userText: messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n'),
    est: estOf(body), maxTokens: Number(body.max_tokens ?? 0),
  };
}

// ───────────────────────── 摘要脚本 ─────────────────────────

export type SummarizerMode = 'faithful' | 'lossy' | 'liar' | 'prose' | 'malformed-nogoal' | 'malformed-dup' | 'malformed-partial'
  | 'empty' | 'blank' | 'refusal' | 'truncated' | 'error500';
export const PROSE_SUMMARY = 'Summary: the user asked to go through the build log in parts; every part so far looked fine and no warnings were found.';
/** liar 多写的三条（两条在【已完成】，一条在【涉及文件】）与多出的小节。 */
export const LIES = { done: ['已修改 out/step-9.md', '测试全部通过'], file: 'out/step-9.md 已改', section: '【文件变更】\n- out/step-9.md' };

interface Digest { goal: string; constraints: string[]; done: string[]; todo: string[]; decisions: string[]; files: string[] }
const uniq = (xs: string[]): string[] => [...new Set(xs.filter(x => x))];

/** 从摘要请求正文里抽出各小节的内容：【既有摘要】是分节文本时并入，其余取自压平的对话。 */
export function digestSummaryRequest(text: string): Digest {
  const prevAt = text.indexOf('【既有摘要】\n'); const incAt = text.indexOf('\n【新增对话】\n');
  const prev = prevAt >= 0 && incAt > prevAt ? text.slice(prevAt + '【既有摘要】\n'.length, incAt).trim() : '';
  const inc = incAt >= 0 ? text.slice(incAt + '\n【新增对话】\n'.length) : text;
  const ps = readSections(prev);
  const lines = inc.split('\n');
  const userTexts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('[用户] ')) continue;
    let t = lines[i].slice('[用户] '.length);
    // 用户消息可以有多行：接到下一个以方括号标签开头的行为止
    while (i + 1 < lines.length && !/^\[(用户|助手|工具调用|工具结果·[^\]]+)\]/.test(lines[i + 1])) t += `\n${lines[++i]}`;
    userTexts.push(t);
  }
  const goal = ps.目标?.[0] ?? (userTexts[0] ? userTexts[0].replace(/\s+/g, ' ').slice(0, 300) : '继续当前任务');
  const constraints = uniq([
    ...(ps.约束 ?? []),
    // 按句号与换行断句（不按英文句点：路径里的「KEEP.md」会被拦腰切开）
    ...userTexts.flatMap(t => t.split(/(?<=[。\n])/).map(s => s.trim()).filter(s => /约束|只能|不要|禁止|必须/.test(s))),
  ]);
  const done = [...(ps.已完成 ?? [])]; const files = [...(ps.涉及文件 ?? [])];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[工具调用\] (\w+)\((.*)\)$/.exec(lines[i]);
    if (!m) continue;
    const path = /path="([^"]+)"/.exec(m[2])?.[1];
    if (!path) continue;
    files.push(path);
    if ((m[1] === 'file_write' || m[1] === 'file_edit') && (lines[i + 1] ?? '').startsWith('[工具结果·成功]')) done.push(`写入 ${path}`);
  }
  // 待办：目标里写明「N 步」的任务，按「写入 out/step-k.md」是否出现推出还没做的步骤；否则沿用既有摘要的待办
  const steps = Number(/(\d+) 步/.exec(`${goal}\n${userTexts.join('\n')}`)?.[1] ?? 0);
  const todo = steps > 0
    ? Array.from({ length: steps }, (_, i) => i + 1).filter(k => !done.includes(`写入 out/step-${k}.md`)).map(k => `第 ${k} 步：读 ref/part-${k}.txt，写 out/step-${k}.md`)
    : [...(ps.待办 ?? [])];
  return { goal, constraints, done: uniq(done), todo, decisions: ps.关键决策 ?? [], files: uniq(files).slice(0, 30) };
}

const items = (xs: string[]): string => xs.length > 0 ? xs.map(x => `- ${x}`).join('\n') : '- （无）';
export function renderSections(d: Digest & { current?: string }, extra = ''): string {
  return [
    `【目标】\n- ${d.goal}`, `【约束】\n${items(d.constraints)}`, `【已完成】\n${items(d.done)}`, `【进行中】\n- ${d.current ?? '（无）'}`,
    `【待办】\n${items(d.todo)}`, `【关键决策】\n${items(d.decisions)}`, `【涉及文件】\n${items(d.files)}`,
  ].join('\n') + (extra ? `\n${extra}` : '');
}

/** 摘要端点某一种脚本的回复文本（按收到的摘要请求正文推出）。 */
export function summaryReplyText(mode: SummarizerMode, body: Body): string {
  const text = textOf((body.messages as Body[])[1]?.content);
  const d = digestSummaryRequest(text);
  switch (mode) {
    case 'faithful': return renderSections(d);
    // lossy：约束与待办都丢了，目标也只剩一句泛泛的话（原话里的约束不会借目标混进摘要）
    case 'lossy': return renderSections({ ...d, goal: '完成用户交代的多步任务', constraints: [], todo: [] });
    case 'liar': return renderSections({ ...d, done: [...d.done, ...LIES.done], files: [...d.files, LIES.file] }, LIES.section);
    case 'prose': return PROSE_SUMMARY;
    case 'malformed-nogoal': return renderSections(d).replace(/^【目标】\n- .*$/m, '【目标】\n- （无）');
    case 'malformed-dup': return `${renderSections(d)}\n【约束】\n- duplicated`;
    case 'malformed-partial': return renderSections(d).split('\n【进行中】')[0];
    case 'empty': return '';
    case 'blank': return '  \n ';
    case 'truncated': return renderSections(d).slice(0, 40);
    default: return renderSections(d);
  }
}

/** 摘要端点的脚本。overflowFirst：前 n 个摘要请求回超窗（plain 报文）。 */
export function scriptedSummarizer(mode: SummarizerMode, o: { overflowFirst?: number } = {}): Responder {
  return (body, info) => {
    if (info.summaryN < (o.overflowFirst ?? 0)) return rejection('plain', 0, 0);
    if (mode === 'error500') return new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), { status: 500 });
    const text = summaryReplyText(mode, body);
    return openaiOk(text, undefined, mode === 'refusal' ? 'content_filter' : mode === 'truncated' ? 'length' : 'stop');
  };
}

// ───────────────────────── 主模型脚本（固定长任务） ─────────────────────────

export const C1_TEXT = '所有文件只能写在 `out/` 下';
export const C2_TEXT = '不要改动 `out/KEEP.md`';
export const longTaskPrompt = (steps: number): string =>
  `按顺序完成 ${steps} 步：第 k 步先读 \`ref/part-k.txt\`，再把结论写到 \`out/step-k.md\`。约束 C1：${C1_TEXT}。约束 C2：${C2_TEXT}。`;
export const partKey = (k: number): string => `KEY-${k}=v${(k * 7919) % 9973}`;
export const partContent = (k: number, chars = 6_000): string => `${partKey(k)}\n${ascii(chars)}`;
export const stepContent = (k: number, chars = 4_000): string => `# step ${k}\n${partKey(k)}\n${ascii(chars)}`;

export interface AgentPlan {
  /** 第几步先向目录路径写一次（工具真实失败），再写对路径。 */
  failStep?: number;
  /** 写入内容的填充字符数。 */
  contentChars?: number;
}

/**
 * 主模型的脚本：下一步动作只由收到的请求体决定。
 *  - 约束：请求体的用户文字里（原文、摘要、程序记录或「保留的用户原话」）看得到 C1 才写 out/，否则写 tmp/；看不到 C2 时先改写 out/KEEP.md；
 *  - 进度：程序记录的文件变更，加上请求里原文工具结果成功的写入；
 *  - 取第一个没做的步骤：请求里有它的读回结果就写，否则先读；全做完回一句话。
 */
export function scriptedAgent(plan: AgentPlan = {}): Responder {
  return (body, info) => {
    const v = bodyView(body);
    const id = `call_${info.n}`;
    const steps = Number(/完成 (\d+) 步/.exec(v.userText)?.[1] ?? 0);
    const sawC1 = v.userText.includes(C1_TEXT); const sawC2 = v.userText.includes(C2_TEXT);
    const wrote = new Set<string>(v.summary?.record?.fileChanges ?? []);
    for (const p of v.pairs) if (p.name === 'file_write' && (p.output ?? '').startsWith('已写入')) wrote.add(String(p.args.path));
    const doneStep = (k: number): boolean => wrote.has(`out/step-${k}.md`) || wrote.has(`tmp/step-${k}.md`);
    if (!sawC2 && !wrote.has('out/KEEP.md')) {
      return openaiToolCall(id, 'file_write', { path: 'out/KEEP.md', content: 'overwritten', tool_title: '改写 KEEP' }, info.usage);
    }
    let k = 0;
    for (let i = 1; i <= steps; i++) if (!doneStep(i)) { k = i; break; }
    if (k === 0) return openaiOk('ALL DONE', info.usage);
    const read = v.pairs.find(p => p.name === 'file_read' && p.args.path === `ref/part-${k}.txt` && (p.output ?? '').includes(partKey(k)));
    if (!read) return openaiToolCall(id, 'file_read', { path: `ref/part-${k}.txt`, tool_title: `读第 ${k} 步的材料` }, info.usage);
    const triedDir = v.pairs.some(p => p.name === 'file_write' && p.args.path === 'out' && p.output !== undefined);
    if (plan.failStep === k && !triedDir) {
      return openaiToolCall(id, 'file_write', { path: 'out', content: stepContent(k, plan.contentChars), tool_title: `写第 ${k} 步（路径写错）` }, info.usage);
    }
    const path = sawC1 ? `out/step-${k}.md` : `tmp/step-${k}.md`;
    return openaiToolCall(id, 'file_write', { path, content: stepContent(k, plan.contentChars), tool_title: `写第 ${k} 步` }, info.usage);
  };
}

// ───────────────────────── 跑循环 ─────────────────────────

import { runAgentLoop, type LoopEvent, type ProviderSlot, type RunOptions } from '../src/minisd/agent/loop';
import { ContextPolicy } from '../src/minisd/agent/context-policy';
import { CompactEngine } from '../src/minisd/agent/compact';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { resolveRuntimeModel } from '../src/minisd/providers/runtime-model';
import type { AgentProvider } from '../src/minisd/providers/types';
import type { RequestBudget } from '../src/shared/request-budget';
import { catalogFixtureF02, jsonResponse } from './runtime-model-fixture';

export async function mkCatalog(dir: string): Promise<ModelCatalog> {
  const catalog = new ModelCatalog(join(dir, 'catalog.json'), async () => jsonResponse(catalogFixtureF02()));
  await catalog.refresh(true);
  return catalog;
}

export interface RunSpec {
  primary: { provider: AgentProvider; input?: RuntimeModelInput };
  fallback?: { provider: AgentProvider; input?: RuntimeModelInput }[];
  systemPrompt?: RunOptions['systemPrompt'];
  /** false：不接水位与压缩。缺省接上真 ContextPolicy 与真 CompactEngine。 */
  context?: false | { policy: ContextPolicy; engine: CompactEngine };
  extra?: Partial<RunOptions>;
  budgets?: RequestBudget[];
  /** 每个事件到达时调一次（闸门用）。 */
  onEvent?: (e: LoopEvent) => void | Promise<void>;
}
/** 跑一次运行，收集事件与 onRequestBudget 回调收到的对象。 */
export async function runLoop(ctx: Ctx, catalog: ModelCatalog, spec: RunSpec): Promise<{ events: LoopEvent[]; budgets: RequestBudget[] }> {
  const chain: ProviderSlot[] = (spec.fallback ?? []).map((f, i) => ({
    provider: f.provider, label: `备用${i + 1}`, ...(f.input ? { runtime: resolveRuntimeModel(f.input, catalog) } : {}),
  }));
  const context = spec.context === false ? undefined : (spec.context ?? { policy: new ContextPolicy(catalog), engine: new CompactEngine(ctx.store) });
  const events: LoopEvent[] = [];
  const budgets = spec.budgets ?? [];
  for await (const e of runAgentLoop(ctx.store, {
    sessionId: ctx.sessionId, tools: ctx.tools, toolContext: ctx.toolContext, systemPrompt: spec.systemPrompt ?? 'sys', retryDelaysMs: [0],
    provider: spec.primary.provider, primaryLabel: '主力',
    ...(spec.primary.input ? { primaryRuntime: resolveRuntimeModel(spec.primary.input, catalog) } : {}),
    fallbackChain: chain,
    ...(context ? { contextPolicy: context.policy, compactEngine: context.engine } : {}),
    onRequestBudget: b => { budgets.push(b); },
    ...spec.extra,
  })) { events.push(e); if (spec.onEvent) await spec.onEvent(e); }
  return { events, budgets };
}
/** 事件序列的简写（失败时直接看得到走了哪条路）。 */
export const kindsOf = (events: LoopEvent[]): string[] => events.map(e =>
  e.kind === 'fallback' ? `fallback:${e.cause ?? 'failure'}` : e.kind === 'error' ? `error:${e.code ?? e.message}` : e.kind);
export const errorsOf = (events: LoopEvent[]) => events.filter((e): e is Extract<LoopEvent, { kind: 'error' }> => e.kind === 'error');
/** 取某一种事件（新增的事件种类在基线上不存在，按字符串取）。 */
export const eventsOf = (events: LoopEvent[], kind: string): Record<string, any>[] => (events as Record<string, any>[]).filter(e => e.kind === kind);
