import { verbatimUserTextPart, userPartWithOrigin } from './input-provenance';
import type { AgentMessage, CompactMarker, ContentPart, RawMessage, StopReason } from '../../shared/types';
import { RECOVERY_LIMITS, type AnchorRule, type BudgetBrief, type CompactMeta, type CompactTrigger, type CoverageRule } from '../../shared/compaction';
import { ProviderError, type AgentProvider } from '../providers/types';
import type { ChatStore } from '../store/chat-store';
import { estimateTextTokens, FALLBACK_WINDOW } from './context-policy';
import { sanitizeMultiline, stripInvisible } from './sanitize';
import { toAgentMessage } from './agent-message';
import { headTailCut } from './clip';
import { RECENT_USER_TURNS, anchorIndexOf, carriedUserTurns, isRealUserTurn, isUselessSummary, isUserTurn } from './compact-turns';
import {
  buildCompactMeta, defaultToolKindOf, mediaName, parseSummaryReply, renderEngineRecord, summaryPrompt, userTurnText, validateCompactMeta,
  type ToolKindOf,
} from './compact-meta';

// 回合与锚点的基础判定在 compact-turns.ts（F03 挪出，供取证与校验共用）；按原名再导出，调用方不用改
export { anchorIndexOf, carriedUserTurns, isRealUserTurn, isUselessSummary, isUserTurn };

/** 摘要请求的输出上限封顶。摘要要求 ≤800 字，本不需要这么多；但 Opus 5.5 / Fable 5.1 关不掉思考、
 *  DeepSeek V4 默认也思考，思考计入 max_tokens——旧值 1024 常被思考吃光，拿回空摘要或半截摘要。
 *  按实际生成量计费，上限放宽本身不多花钱。 */
const SUMMARY_MAX_TOKENS = 16_384;
/** 摘要请求的输入预算绝对上限（token）。窗口再大，一次也只消化这么多；剩下的下一轮再压。 */
const INPUT_BUDGET_CAP = 100_000;
/** 摘要请求的系统提示。F03 起导出：循环给摘要请求算预算时要用同一份文本（值不变，既有用例靠它识别摘要请求）。 */
export const SUMMARY_SYSTEM_PROMPT = '你是对话摘要助手。';
/** 摘要请求至少要申请到这么多输出才值得发（模型上限更小时取上限）：再少多半以截断收尾，白花一次请求。 */
export const SUMMARY_MIN_OUTPUT = 4_096;

/** 压平时的逐项截断口径。工具输出与超长正文是撑大摘要请求的主力，
 *  逐项留头尾（而不是整段丢弃）能保住「做了什么、结果大意」，文件路径靠工具参数行保住。 */
const CAPS = {
  argChars: 200,          // 工具参数值超过它就只写「<N 字>」
  resultChars: 2000,      // 工具结果超过它就留头 1500 + 尾 500
  resultHead: 1500,
  resultTail: 500,
  textChars: 6000,        // 单条正文超过它就留头 4000 + 尾 2000
  textHead: 4000,
  textTail: 2000,
} as const;

/** 摘要被拒收的原因（设计稿 §3 第 4 条 compactFailed.reason 的前三种；'error' 是请求本身失败）。F03 新增五种：
 *  malformed 出现了小节标题而结构不完整，或自由文本落在不收它的情形里；invalid 结构与历史对不上；
 *  overflow 摘要请求自身放不进当前模型（没发，或缩减一次后仍被拒）；stale 摘要期间历史或压缩记录变了；
 *  budget 本次运行的摘要请求额度已用完（没发）。 */
export type CompactRejectReason = 'empty' | 'truncated' | 'refusal' | 'malformed' | 'invalid' | 'overflow' | 'stale' | 'budget';
export type CompactFailReason = CompactRejectReason | 'error';

/**
 * 摘要结果不可用：为空、被输出上限截断、被模型拒绝（F03：以及上面新增的五种）。都不写 marker——
 * marker 一旦写下，锚点之前的原文就只剩这段摘要代表；把「[摘要为空]」或半截摘要写进去，
 * 等于把之前的对话永久替换成一句废话（旧实现就是这么做的）。
 */
export class CompactRejectedError extends Error {
  constructor(readonly reason: CompactRejectReason, message: string) {
    super(message);
    this.name = 'CompactRejectedError';
  }
}

export interface SummarizeOptions {
  /** N23：当前摘要槽位解析出的目录服务商，只用于请求头。 */
  catalogProviderId?: string;
  /** 调用方当前槽位的输出上限；摘要请求取 min(16384, 它, floor(窗口/4))。 */
  maxTokens?: number;
  /** 当前槽位的上下文窗口；缺省按 128K（FALLBACK_WINDOW）。 */
  windowTokens?: number;
  /** 取消信号：用户点停止时摘要请求要一起断，不能让它在后台把 marker 写完。 */
  signal?: AbortSignal;
  // ── 以下 F03 新增，全部可选；都不给时取材与预算同 F03 之前 ──
  /** 锚点规则，缺省 'standard'。 */
  rule?: AnchorRule;
  /** 这次压缩为什么发生，缺省 'watermark'。'overflow'（端点拒绝之后）时取材不用 0.6 的系数，一次摘走尽量多。 */
  trigger?: CompactTrigger;
  /** 记录用：发摘要请求的槽位、触发时主请求的预算。 */
  slot?: { label: string; modelId: string };
  before?: BudgetBrief;
  /** 给定摘要请求正文，按当前槽位算这次请求的预算（协议构建器、校准系数、拒绝上限与主请求同一把尺）。不给 = 沿用旧公式。 */
  fit?: (text: string) => SummaryFit;
  /** 工具分类。不给 = 按内置名单（defaultToolKindOf）。 */
  toolKindOf?: ToolKindOf;
  /** 提交前重读落库历史（摘要期间同步合并可能改了前缀）。不给 = 不做这项复核。 */
  reread?: () => RawMessage[];
  /** 每个摘要请求发出前同步调一次；返回 false = 本次运行的额度已用完，不发。
   *  rawInput：这次取材按本机估算的大小，不乘校准系数——与取材上限（一次最多 100,000）是同一口径，循环按它累计花费。
   *  estInput 给了 fit 时是校准后的值：拿它累计的话，校准系数高的配置上三次满额的水位压缩就会超过花费上限。 */
  onRequest?: (r: { estInput: number; maxTokens: number; attempt: 1 | 2; rawInput: number }) => boolean;
}

/** fit 的结果：这段正文的摘要请求放不放得下、能申请多少输出、输入估计多少。 */
export interface SummaryFit { fits: boolean; maxTokens: number; estInput: number }

const hasToolUse = (m: RawMessage | undefined): boolean => !!m && m.role === 'assistant' && m.parts.some(p => p.type === 'toolUse');
const hasToolResult = (m: RawMessage | undefined): boolean => !!m && m.role === 'user' && m.parts.some(p => p.type === 'toolResult');

/** 超长文本留头尾，中间注明原长——只看开头会丢掉结论，只看结尾会丢掉起因。 */
function clip(raw: string, max: number, head: number, tail: number): string {
  if (raw.length <= max) return raw;
  const s = stripInvisible(raw); // 让下面的凭据判定与脱敏看到同样的字符（见 stripInvisible）
  if (s.length <= max) return s;
  // 这里先截断、最后才整体消毒（W2a-1 写它时整体先消毒在长单行上是平方级；W2a-7 已把脱敏改成线性，这里的先后没跟着动）。
  // 切点不落进带口令的 URL、不切半个代理对：规则在 clip.ts 的 headTailCut（F03 起与请求侧的第 3 级裁剪共用）。
  // 切点由内容决定、每次都切在同一处，这条消息又留在增量里推不过去——切坏一次，这个会话以后每次压缩都失败。
  // 「原 N 字」与上面的 max 判定同为码元口径（offload 桩的字符数也是码元）。
  const cut = headTailCut(s, head, tail);
  return `${cut.head}\n…（中间省略，原 ${s.length} 字）…\n${cut.tail}`;
}

/** 收紧锚点（tight）：只留最近这么多条原文；历史不足 TIGHT_MIN_MESSAGES 条时不摘。 */
const TIGHT_KEEP = 4;
const TIGHT_MIN_MESSAGES = 8;

/**
 * summarize 这一次会取材的增量在 history 里的下标区间（闭区间 [from, to]）；没有新增可摘时返回 undefined。
 * 规则锚点（双轨）与旧 marker 的认定都在这一处，summarize 自己也用它。F02 起循环要在发付费的摘要请求之前先知道
 * 「这一次能从请求里摘走多少」（余量不足触发的压缩，见 loop.ts 减压第 ① 步）——两边各写一份规则迟早对不上。
 * 不看输入预算：放不下时 summarize 会把新锚点后退，实际摘的只会更少。纯函数，不读存储。
 *
 * F03：
 *  - rule（缺省 'standard'）。'tight' 只留最近 4 条原文，是超窗恢复的最后一档；它可以盖住最近 3 个用户回合，
 *    那些回合读的时候按原话全文带上（buildEffectiveHistory），不因此变成转述；
 *  - 规则锚点不拆工具对：锚点落在带 toolUse 的 assistant 上、下一条是它的 toolResult 时退一条。以前不查——
 *    留在原文里的 toolResult 没了前置 tool_use，请求构建时被当孤儿剥掉，结果两边都找不到。只会让锚点更早、摘得更少；
 *  - 数最近 3 个回合仍用 isRealUserTurn，不改用 isUserTurn（那样纯图片消息顶掉一个文字回合，锚点反而变晚）；
 *  - 返回值多一个 rule：这次的锚点是按哪条规则定的（写进 meta 的覆盖区间）。
 */
export function pendingSummaryRange(
  history: RawMessage[], latest: CompactMarker | undefined, rule: AnchorRule = 'standard',
): { from: number; to: number; rule: CoverageRule } | undefined {
  let ruleIdx: number; let coverage: CoverageRule;
  if (rule === 'tight') {
    if (history.length < TIGHT_MIN_MESSAGES) return undefined;
    ruleIdx = history.length - 1 - TIGHT_KEEP; coverage = 'tight';
  } else {
    // 从后往前数 3 个「真正的用户回合」
    const userIdxs: number[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (isRealUserTurn(history[i])) userIdxs.push(i);
      if (userIdxs.length >= RECENT_USER_TURNS) break;
    }
    if (userIdxs.length >= RECENT_USER_TURNS) {
      // 常规路径：锚点 = 第 3 个用户回合之前的那条消息（第 3 个回合就是首条消息时为 -1：没东西可摘）
      ruleIdx = userIdxs[userIdxs.length - 1] - 1; coverage = 'recent-turns';
    } else if (history.length >= 30) {
      // 双轨锚定：不足 3 回合但消息足够长 → 锚点取倒数第 15 条，保留最近 14 条原文
      ruleIdx = history.length - 15; coverage = 'recent-messages';
    } else {
      return undefined; // 不写毒 marker
    }
  }
  // 不拆对（I10）
  if (hasToolUse(history[ruleIdx]) && hasToolResult(history[ruleIdx + 1])) ruleIdx -= 1;
  if (ruleIdx < 0) return undefined;

  // 旧版本（W2a-1 之前）摘要为空时写下「[摘要为空]」兜底，纯空白的摘要也照写。那时取材每次从 history[0] 起，
  // 下一次非空摘要就把它盖掉，伤能自愈；改成「旧摘要 + 增量」后，若还把它当既有摘要、只取它锚点之后的增量，
  // 它锚点之前的原文就永远只剩这一句，以后哪次压缩都捡不回来。所以当作没有 marker：从头取材，预算与后退规则照旧；
  // 新 marker 成了最新的，buildEffectiveHistory 自动改用它。后退使新锚点早于毒锚点也无妨——多留些原文，下一轮接着摘。
  // 旧版本写下的半截摘要认不出来，只能随下一次压缩并入新摘要。
  const prev = latest && !isUselessSummary(latest.summary) ? latest : undefined;
  const oldIdx = anchorIndexOf(history, prev);
  if (ruleIdx <= oldIdx) return undefined; // 没有新增可摘
  return { from: oldIdx + 1, to: ruleIdx, rule: coverage };
}

/** 工具参数写成 k="v"：值超过 200 字只写字数（file_write 的整篇 content 对摘要毫无用处，path 才有用）。 */
function renderArgs(input: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(input || '{}'); } catch { parsed = undefined; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // 老数据里可能躺着非法 JSON：原样给出（超长写字数），不让一条坏参数弄垮整次压缩
    return input.length > CAPS.argChars ? `<${input.length} 字>` : input;
  }
  const obj = parsed as Record<string, unknown>;
  // tool_title 是模型自己写的一句话意图，最能说明这一步在干什么，排在最前
  const keys = Object.keys(obj).sort((a, b) => (a === 'tool_title' ? -1 : b === 'tool_title' ? 1 : 0));
  return keys.map(k => {
    const v = obj[k];
    const shown = typeof v === 'string' ? v : JSON.stringify(v);
    if (shown.length > CAPS.argChars) return `${k}=<${shown.length} 字>`;
    // 字符串加引号（转义换行与引号，一个参数不会拆成多行）；数字、布尔、对象原样写 JSON
    return `${k}=${typeof v === 'string' ? JSON.stringify(v) : shown}`;
  }).join(', ');
}

/**
 * 把一条消息压成摘要请求里的文本行。thinking part 与 reasoningContent 不进摘要：
 * 思考是过程不是结论，而且可能很长；Anthropic 的思考块还带签名，塞进别的请求毫无意义。
 */
export function renderMessageForSummary(m: RawMessage): string {
  const lines: string[] = [];
  const who = m.role === 'user' ? '[用户]' : '[助手]';
  for (const p of m.parts) {
    if (p.type === 'text') {
      const t = String(p.value ?? '');
      if (t.trim()) lines.push(`${who} ${clip(t, CAPS.textChars, CAPS.textHead, CAPS.textTail)}`);
    } else if (p.type === 'toolUse') {
      const v = p.value as { name: string; input: string };
      lines.push(`[工具调用] ${v.name}(${renderArgs(String(v.input ?? ''))})`);
    } else if (p.type === 'toolResult') {
      const v = p.value as { output: string; success: boolean; status?: 'success' | 'failed' | 'cancelled' | 'unknown' };
      const out = String(v.output ?? '');
      // F03：按 status 写四种——F05 的「已取消」「结果未知」写成「失败」的话，摘要模型会当成试过且失败了。
      // 没有 status 的旧数据按 success 二值，输出与以前逐字相同
      const label = v.status === 'cancelled' ? '已取消' : v.status === 'unknown' ? '结果未知' : v.success ? '成功' : '失败';
      lines.push(`[工具结果·${label}] ${clip(out, CAPS.resultChars, CAPS.resultHead, CAPS.resultTail)}`);
    } else if (p.type === 'mediaRef') {
      lines.push(`${who} [图片 ${mediaName(p.value)}]`);
    }
    // thinking / imageData / 未知类型：不进摘要
  }
  return lines.join('\n');
}

/**
 * 摘要请求的完整正文（纯函数，便于单测）：旧摘要 + 增量压平成一段文本，过 sanitizeMultiline。
 * 为什么压平成单条 user 文本、而不是逐条转发原消息：
 *  - 逐条转发以原历史最后一条结尾（常是 assistant），不少端点直接 400 或把它当续写；
 *  - 夹带 toolUse/toolResult 块，而摘要请求不带工具定义，块也可能在切口处失配——两种都会被端点拒收；
 *  - 原消息没法逐项截断，一个 5 万字的工具结果就能让摘要请求自己撑爆窗口。
 */
export function flattenForSummary(prevSummary: string | undefined, increment: RawMessage[]): string {
  return composeSummaryText(prevSummary, increment.map(renderMessageForSummary));
}

function composeSummaryText(prevSummary: string | undefined, blocks: string[]): string {
  // 头部（提示词 + 既有摘要 + 「新增对话」标题）在 compact-meta.ts 的 summaryPrompt：F03 起要求按七个小节输出
  return sanitizeMultiline(summaryPrompt(prevSummary) + blocks.filter(b => b).join('\n'));
}

/**
 * 摘要消息（有效历史下标 0 的那条 user 消息，头部条数恒为 1）。parts 依次是：
 *  1. 「[对话摘要] 」加摘要文本（与 F03 之前相同）；
 *  2. 有可用的 meta 时：程序记录段（以两个换行开头——OpenAI 兼容构建器把同一条消息的文本段直接拼接）；
 *  3. 有被摘要盖住的保留回合时：「保留的用户原话」段。
 * 没有 meta、也没有被带上的用户回合时只有第 1 项，与以前逐字节相同。
 *
 * 被带上的用户回合由 carriedUserTurns 按传入的 history 现算，不读 meta（I11）：meta 是写 marker 那一刻的快照，
 * 而「哪几条算最近的用户回合」「被带上的那条是不是当前这一轮」只有读的时候才知道；同步来的、旧版本写的 marker 也没有 meta。
 * 原话不截断、不过 sanitizeMultiline（与锚点之后的原文同样对待，那些消息压缩前就是这样发的），不计入程序记录的字符上限——
 * 放不下时由预算判 over，不靠掐掉用户的话过关。
 * 图片：只有被带上的最后一条挂原图（锚点之后没有别的用户回合时它就是当前轮，压缩前后对槽位的要求相同；之后由
 * placeholderOldMediaRefs 按轮老化，与不压缩时相同）；更早的回合写占位文字——它们若也挂原图会被算进当前轮，
 * 让不收图片的槽位整轮不接，而压缩前它是接的。
 */
function summaryMessage(history: RawMessage[], anchorIdx: number, summary: string, meta: CompactMeta | undefined): AgentMessage {
  const parts: ContentPart[] = [{ type: 'text', value: `[对话摘要] ${sanitizeMultiline(summary)}` }];
  const carried = carriedUserTurns(history, anchorIdx);
  if (meta) {
    const skip = new Set(carried.map(i => history[i].id));
    parts.push({ type: 'text', value: `\n\n${sanitizeMultiline(renderEngineRecord(meta, { skip }))}` });
  }
  if (carried.length > 0) {
    const n = carried.length;
    parts.push({ type: 'text', value: `\n\n【保留的用户原话】以下 ${n} 条是摘要覆盖范围内最近的用户消息，按时间顺序原样保留。` });
    carried.forEach((idx, k) => {
      const m = history[idx];
      parts.push(verbatimUserTextPart(m, `\n\n（${k + 1}/${n}）\n`));
      for (const [partIndex, p] of m.parts.entries()) {
        if (p.type !== 'mediaRef') continue;
        parts.push(k === n - 1 ? userPartWithOrigin(m, partIndex) : { type: 'text', value: `\n[图片 ${mediaName(p.value)} 已随上下文省略]` });
      }
    });
    // 收尾句看锚点之后有没有用户回合：有的话这些已是答复过的旧指示，不能让模型当成这一轮要做的事
    const later = history.slice(anchorIdx + 1).some(isUserTurn);
    parts.push({ type: 'text', value: `\n\n${later ? '之后用户又发了新消息（见下文），有出入时以新消息为准。' : '最后一条就是当前这一轮的用户指示。'}` });
  }
  return { role: 'user', parts };
}

/**
 * 摘要占位（循环的试算下限用）：假设按 toIdx 这个锚点摘完，摘要消息最小是什么样——模型那一半按空串，
 * 程序记录按这个锚点现算（取证是确定性的，不需要模型；沿用的约束取自 prev），被带上的用户回合照样全文接上。
 * 与 buildEffectiveHistory 的摘要消息同一套组法。纯函数，不读写存储。
 */
export function previewSummaryMessage(history: RawMessage[], toIdx: number, prev: CompactMarker | undefined, toolKindOf: ToolKindOf = defaultToolKindOf): AgentMessage {
  const { meta } = buildCompactMeta({
    history, to: toIdx, rule: 'tight', prev, reply: { ok: true, form: 'text', text: '' }, toolKindOf,
    record: { trigger: 'overflow', request: { estInput: 0, maxTokens: 0, attempts: 1 } },
  });
  return summaryMessage(history, toIdx, '', meta);
}

/**
 * LLM 压缩摘要（设计 §4.2「压缩」段）。
 * 摘要存 compact_markers，推理时合成 effectiveAgentHistory，不改写存储历史。
 * 保留最近 3 个真正的用户回合原文；锚点丢失按 createdAt 自愈。
 *
 * 数据流契约（与 Task 7 一致）：
 *  - raw history 在本类里只用于「取材（增量）」和「锚点定位」——永不改写。
 *  - effectiveAgentHistory 由 buildEffectiveHistory 合成，是请求构建与水位估算的唯一输入。
 */
export class CompactEngine {
  constructor(private chat: ChatStore) {}

  /**
   * 调用 provider 生成摘要并写入 compact_markers。
   * lastCompactedMessageId 锚定到「保留最近 3 个用户回合」之前的最后一条消息。
   *
   * 双轨锚定：常规路径数最近 3 个真正的用户回合；不足 3 回合时（单回合长任务如
   * 「帮我重构这个项目」永远到不了三回合门槛，旧实现直接返回 undefined = 永远无法压缩），
   * 改为按消息数锚定——只要消息足够长（≥30 条）就按「保留最近 14 条消息原文」压缩。
   * 为什么按消息数而非回合数：单回合长任务里「最近的工具轨迹」是模型继续工作的必需品，
   * 保留条数按消息算才有意义；回合数会被单个长任务稀释成 1，等于永远不压缩。
   * 消息不足 30 条仍返回 undefined——小会话没有压缩价值，且毒 marker 防御必须保留
   * （否则写个锚点=最后一条的 marker，下一轮 effectiveHistory 只剩摘要占位、整个对话被抹掉）。
   *
   * W2a-1 取材改为「最新 marker 的摘要 + 旧锚点之后到新锚点的增量」：旧实现每次都从 history[0] 摘起、
   * 不用旧摘要——第二次压缩把第一次摘过的原文从头再摘一遍，请求随会话长度无限增长，
   * 越是需要压缩的长会话，压缩请求自己越容易撑爆窗口。
   * 新锚点不在旧锚点之后（没有新增可摘）→ 返回 undefined，loop 落到正常请求，不死循环。
   *
   * 预算：输出上限 = min(16384, 调用方上限, floor(窗口/4))；输入预算 = min(floor(窗口×0.6) − 输出上限, 100000)。
   * 增量按时间顺序累加，放不下就停——新锚点后退到最后一条放得下的消息（至少一条）。
   * 为什么后退而不是省略增量中段：省略的内容既不在摘要里、也不在保留原文里，等于永久丢失；
   * 后退则没摘进去的消息仍留在原文里，下一轮水位还高时再压（loop 每次运行最多 3 次）。
   *
   * 拒收：摘要为空、以 maxTokens 截断、被 refusal 拒绝 → 抛 CompactRejectedError，不写 marker。
   */
  async summarize(history: RawMessage[], sessionId: string, provider: AgentProvider, opts: SummarizeOptions = {}): Promise<CompactMarker | undefined> {
    const rule: AnchorRule = opts.rule ?? 'standard';
    const trigger: CompactTrigger = opts.trigger ?? 'watermark';
    const toolKindOf = opts.toolKindOf ?? defaultToolKindOf;
    // 取材区间（规则锚点、旧 marker 的认定、有没有新增可摘）由 pendingSummaryRange 定：循环在发请求前也用同一个函数估这次能摘走多少
    const latest = this.chat.getLatestCompactMarker(sessionId);
    const range = pendingSummaryRange(history, latest, rule);
    if (!range) return undefined; // 小会话不写毒 marker；没有新增可摘
    // 「[摘要为空]」这类代表不了内容的旧 marker 不当既有摘要（理由见 pendingSummaryRange）
    const prev = latest && !isUselessSummary(latest.summary) ? latest : undefined;
    const increment = history.slice(range.from, range.to + 1);

    const window = opts.windowTokens ?? FALLBACK_WINDOW;
    const legacyMax = Math.max(1, Math.min(SUMMARY_MAX_TOKENS, opts.maxTokens ?? SUMMARY_MAX_TOKENS, Math.floor(window / 4)));
    const inputBudget = Math.min(Math.floor(window * 0.6) - legacyMax, INPUT_BUDGET_CAP);

    // 逐条估算；每段带上它后面的换行一起估，分段向上取整只会高估（见 estimateTextTokens 注释）
    const blocks = increment.map(renderMessageForSummary);
    const costs = blocks.map(b => estimateTextTokens(`${b}\n`));
    const base = estimateTextTokens(SUMMARY_SYSTEM_PROMPT) + estimateTextTokens(summaryPrompt(prev?.summary));
    const usedOf = (n: number): number => costs.slice(0, n).reduce((sum, c) => sum + c, base);
    /** 按时间顺序累加，放不下就停（至少一条）：不超过 budget 的最大前缀。 */
    const takeWithin = (budget: number): number => {
      let used = base; let n = 0;
      for (const c of costs) { if (n > 0 && used + c > budget) break; used += c; n++; }
      return n;
    };
    const textOf = (n: number): string => composeSummaryText(prev?.summary, blocks.slice(0, n));
    /** 后退停在带 toolUse 的 assistant 上、下一条恰是它的 toolResult 时，不能把这一对拆到锚点两侧：
     *  留在原文里的 toolResult 没了前置 tool_use，请求构建时会被 pairToolResults 当孤儿剥掉——
     *  结果既不在摘要里也不在原文里。能再退一条就退（这对整体留在原文），只剩一条就把结果也带上。 */
    const keepPair = (n: number): number => {
      if (n >= increment.length) return n;
      if (!(hasToolUse(increment[n - 1]) && hasToolResult(increment[n]))) return n;
      return n > 1 ? n - 1 : n + 1;
    };

    // F03：给了 fit 时，摘要请求与主请求用同一把尺（协议构建器、校准系数、端点拒绝过的上限）。fit 抛错按没有 fit 处理
    const fit = opts.fit;
    let fitFailed = false;
    const fitOf = (n: number): SummaryFit | undefined => {
      if (!fit || fitFailed) return undefined;
      try { return fit(textOf(n)); } catch { fitFailed = true; return undefined; }
    };
    /** [1, hi] 里 fit 为真的最大前缀；连 1 条都放不下返回 0。 */
    const largestFitting = (hi: number): number => {
      if (fitOf(hi)?.fits !== false) return hi;
      let lo = 0; let top = hi; // 不变量：lo 放得下（0 = 还没找到），top 放不下
      while (top - lo > 1) {
        const mid = (lo + top) >> 1;
        if (fitOf(mid)?.fits !== false) lo = mid; else top = mid;
      }
      return lo;
    };
    // 取材：没有 fit 用现有公式（窗口的 0.6 减输出）；有 fit 时，水位 / 余量触发的先按现有公式取、再用 fit 校验（只会取得更少）；
    // 端点拒绝之后的（overflow）不用 0.6 的系数——恢复时一次付费请求要摘走尽量多
    let take = takeWithin(fit && trigger === 'overflow' ? INPUT_BUDGET_CAP : inputBudget);
    if (fit) {
      const n = largestFitting(take);
      if (!fitFailed) {
        if (n === 0) throw new CompactRejectedError('overflow', '摘要请求放不进当前模型，未发送');
        take = n;
      } else {
        take = takeWithin(inputBudget); // fit 中途抛错：退回旧公式
      }
    }
    take = keepPair(take);

    let summary = '';
    let stopReason: StopReason | undefined;
    let attempts: 1 | 2 = 1;
    let request = { estInput: 0, maxTokens: 0 };
    for (;;) {
      const f = fitOf(take);
      // 输出上限：现有公式与 fit 给的取小，只会更小
      const maxTokens = f ? Math.max(1, Math.min(legacyMax, f.maxTokens)) : legacyMax;
      request = { estInput: f ? f.estInput : usedOf(take), maxTokens };
      // 额度：每个摘要请求发出前问一次（循环按次数与花费记账）
      if (opts.onRequest && !opts.onRequest({ ...request, attempt: attempts, rawInput: usedOf(take) })) {
        throw new CompactRejectedError('budget', '本次运行的摘要请求额度已用完，未发送');
      }
      const messages: AgentMessage[] = [{ role: 'user', parts: [{ type: 'text', value: textOf(take) }] }];
      summary = ''; stopReason = undefined;
      try {
        for await (const ev of provider.streamAgentMessage({
          session: { id: sessionId, catalogProviderId: opts.catalogProviderId },
          messages, systemPrompt: SUMMARY_SYSTEM_PROMPT,
          tools: [], maxTokens, thinkingLevel: 'off',
        }, opts.signal)) {
          if (ev.kind === 'textDelta') summary += ev.text;
          else if (ev.kind === 'done') stopReason = ev.stopReason;
        }
        break;
      } catch (e) {
        // 取消与其它错误（5xx、网络、流停滞）原样抛出：付费的摘要请求不走重试梯
        if (opts.signal?.aborted || !(e instanceof ProviderError) || e.code !== 'contextOverflow') throw e;
        // 摘要请求自身超窗：取材减半再发一次（只此一次）；仍超窗就放弃。不更新主请求的拒绝上限
        if (attempts < RECOVERY_LIMITS.summaryAttemptsPerCall && take > 1) {
          take = keepPair(Math.max(1, Math.floor(take / 2)));
          attempts = 2;
          continue;
        }
        throw new CompactRejectedError('overflow', '摘要请求自身超出模型上限，未写入压缩记录');
      }
    }
    const anchorIdx = range.from + take - 1;

    // 拒收顺序：截断 → 拒绝 → 空 → 格式（含自由文本的收受）→ 结构校验。
    // 截断与拒绝先于「空」判：思考吃光输出上限时正文也是空的，报「被截断」才说得清原因
    if (stopReason === 'maxTokens') throw new CompactRejectedError('truncated', '摘要被输出上限截断，未写入压缩记录');
    if (stopReason === 'refusal') throw new CompactRejectedError('refusal', '摘要请求被模型拒绝，未写入压缩记录');
    if (!summary.trim()) throw new CompactRejectedError('empty', '摘要为空：摘要模型返回了空内容，未写入压缩记录');
    const parsed = parseSummaryReply(summary);
    if (!parsed.ok) throw new CompactRejectedError('malformed', `摘要格式不符（${parsed.why}），未写入压缩记录`);
    if (parsed.form === 'text') {
      // 自由文本的收受（自上而下取第一条命中的）。F03 之前任何非空完整文本都能成为摘要；写不好格式的端点不该因此每次压缩都失败，
      // 所以在以前就有的路径上（水位或余量触发、标准锚点）照收。两种情形不收：
      //  - 端点拒绝之后的压缩与收紧锚点的压缩是新增的路径：tight 只留最近 4 条原文，一句答非所问但正常收尾的回复一旦成为 marker，
      //    会对之后所有运行生效——这两条路径上的摘要必须过结构校验与陈述核对；
      //  - 上一条是结构化 marker：让一段没有小节的文字顶掉校验过的目标、约束、待办，下一次压缩的【既有摘要】就只剩这段文字
      if (trigger === 'overflow' || rule === 'tight') {
        throw new CompactRejectedError('malformed', '摘要没有按小节输出；端点拒绝之后的压缩与收紧锚点的压缩只接受分节的摘要，未写入压缩记录');
      }
      if (prev?.meta?.model.form === 'structured') {
        throw new CompactRejectedError('malformed', '摘要没有按小节输出，而上一条压缩记录是结构化的，未替换');
      }
    }
    const built = buildCompactMeta({
      history, to: anchorIdx, rule: range.rule, prev, reply: parsed, toolKindOf,
      record: {
        trigger,
        ...(opts.slot ? { slot: opts.slot } : {}),
        ...(opts.before ? { before: opts.before } : {}),
        request: { ...request, attempts },
      },
    });
    const problems = validateCompactMeta(built.meta, built.summary, history, prev, toolKindOf);
    if (problems.length > 0) throw new CompactRejectedError('invalid', `摘要结构校验未通过（${problems.join('；')}），未写入压缩记录`);

    // 提交前复核与写入（I9）。按顺序，任一不过都不写；这四步之间没有 await：
    //  1. 已取消——流可以在取消之后正常结束（最后一个分片已到），不能让它把 marker 写完；
    //  2. 最新 marker 变了（含从无到有）——同一会话并发的另一次压缩，或同步合并进来的；
    //  3. 历史的前缀变了（同步合并进了更早的消息）——摘要代表的那段已经不是摘要时的那段；
    //  4. marker 与 meta 同一个事务写入。
    if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    if (this.chat.getLatestCompactMarker(sessionId)?.id !== latest?.id) throw new CompactRejectedError('stale', '摘要期间压缩记录发生变化，未写入');
    if (opts.reread) {
      const now = opts.reread();
      for (let i = 0; i <= anchorIdx; i++) {
        if (now[i]?.id !== history[i].id) throw new CompactRejectedError('stale', '摘要期间压缩记录发生变化，未写入');
      }
    }
    return this.chat.appendCompactMarker(sessionId, built.summary, history[anchorIdx].id, built.meta);
  }

  /**
   * 合成 effectiveAgentHistory（设计 §4.2「推理时合成」）。
   * 无 marker → 原样；有 marker → 摘要 + 锚点之后的消息；锚点丢失按 createdAt 自愈。
   * raw history 只读，永不改写。
   * F03：摘要消息仍是下标 0 的一条 user 消息（头部条数恒为 1），可能多出程序记录段与「保留的用户原话」段，见 summaryMessage。
   */
  buildEffectiveHistory(history: RawMessage[], marker: CompactMarker | undefined): AgentMessage[] {
    // 逐条映射走 toAgentMessage（与 loop 的 toAgentMessages 共用）：出口侧消毒 toolResult.output（存储不动），
    // assistant 有推理时带上 reasoningContent——DeepSeek V4 要回放它（W2a-4），旧实现只映射 {role, parts} 把它丢了
    if (!marker) return history.map(toAgentMessage);

    // 锚点之后的消息留原文；锚点丢失按 createdAt 自愈、全早于 marker 则保留全部（规则见 anchorIndexOf，
    // 与 summarize 取增量共用——两边不一致就会有消息既不在摘要里也不在原文里）
    const anchorIdx = anchorIndexOf(history, marker);
    const after = history.slice(anchorIdx + 1).map(toAgentMessage);
    return [summaryMessage(history, anchorIdx, marker.summary, marker.meta), ...after];
  }
}
