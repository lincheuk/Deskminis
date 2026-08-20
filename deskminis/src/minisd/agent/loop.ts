import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentMessage, ContentPart, RawMessage, StopReason, ThinkingLevel, TokenUsage } from '../../shared/types';
import type { AgentProvider, StreamRequest } from '../providers/types';
import { ProviderError, isFallbackable } from '../providers/types';
import type { ChatStore } from '../store/chat-store';
import type { ToolRegistry } from '../tools/registry';
import type { ToolContext } from '../tools/types';
import type { ContextPolicy } from './context-policy';
import type { OffloadEngine } from './offload';
import type { CompactEngine } from './compact';
import { pruneOldToolResults } from './prune';
import { sanitizeMultiline } from './sanitize';

export type LoopEvent =
  | { kind: 'textDelta'; text: string }
  | { kind: 'thinkingDelta'; text: string }
  | { kind: 'toolStart'; toolUseId: string; name: string; title: string; input: string }
  | { kind: 'toolEnd'; toolUseId: string; success: boolean; output: string }
  | { kind: 'messagePersisted'; messageId: string }
  | { kind: 'turnEnd'; stopReason: StopReason }
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  | { kind: 'fallback'; from: string; to: string; reason: string }
  | { kind: 'compacted'; markerId: string; summary: string }
  | { kind: 'offloaded'; toolUseId: string; relativePath: string }
  | { kind: 'pruned'; count: number }
  | { kind: 'error'; message: string };

export interface ProviderSlot { provider: AgentProvider; label: string }

/** systemPrompt 工厂函数入参（决策点 3 方案 a）：轮内动态重建 stable 段。 */
export interface SystemPromptCtx { modelId: string; sessionId: string }

export interface RunOptions {
  sessionId: string; provider: AgentProvider; tools: ToolRegistry; toolContext: ToolContext;
  /** 系统提示——传 string 时每轮原样用（向后兼容）；传工厂函数时每轮用当前 activeSlot.provider.modelId 调工厂（降级/桥授权当轮生效）。 */
  systemPrompt: string | ((ctx: SystemPromptCtx) => string);
  /** 输出上限——传 number 时全程固定（向后兼容）；传工厂函数时每次 slot 切换按当前 modelId 重算。
   *  必须随 slot 重算的原因：主模型 64K 上限、备胎是只认 16K 的兼容端点时，固定值会让降级请求
   *  连环 400 烧穿整条链（与 systemPrompt 工厂同款问题、同款解法）。 */
  maxTokens?: number | ((ctx: { modelId: string }) => number); thinkingLevel?: ThinkingLevel; maxTurns?: number;
  signal?: AbortSignal; retryDelaysMs?: number[];
  fallbackChain?: ProviderSlot[];
  contextPolicy?: ContextPolicy;       // 上下文水位分层决策（Task 4）
  compactEngine?: CompactEngine;       // LLM 压缩摘要（Task 6）
  offloadEngine?: OffloadEngine;       // 大工具结果卸载（Task 5）
  excludedToolNames?: Set<string>;     // 按会话过滤工具（memory_enabled=false 时排除记忆工具）
}

const DEFAULT_RETRY = [3000, 5000, 10000, 15000, 30000];
const CONCURRENCY = 10;

/** maxTokens 截断续写次数上限：只追续 2 次，防止「每次都差一点」的模型无限空转烧 token。 */
const MAX_CONTINUATIONS = 2;
/** 续写合成提示：仅追加在请求侧 messages 末尾、绝不落库（与 pairToolResults 同属请求构建边界）。 */
const CONTINUE_HINT = '[系统提示：上一条输出因长度上限被截断，请从截断处继续输出剩余内容，不要重复已输出的部分]';
/** 空响应提醒（文案沿用旧版原文）：tool_result 后模型空手而归时，仅请求侧合成 user 消息催它继续。
 *  绝不落库——落库会污染持久化历史，同步/导出时用户会看到这条机器留言。 */
const EMPTY_RESPONSE_REMINDER = '[系统提醒: 上一次工具调用后你返回了空响应，请继续]';

/** 丢弃持久化专属字段，只留 Provider 需要的 {role, parts}。出口侧消毒：toolResult.output 过 sanitizeMultiline（存储不动）。 */
export function toAgentMessages(history: RawMessage[]): AgentMessage[] {
  return history.map(m => ({
    role: m.role,
    parts: m.parts.map(p => {
      if (p.type === 'toolResult') {
        const v = p.value as { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' };
        return { type: 'toolResult' as const, value: { ...v, output: sanitizeMultiline(v.output) } };
      }
      return p;
    }),
  }));
}

/**
 * 附件请求侧合成：把 user 消息里的 mediaRef part 读文件替换成 imageData（base64）。
 * 与 pairToolResults / CONTINUE_HINT 同属请求构建边界——raw history 与 store 永不改写
 * （落库 base64 会把图片字节冗余进 parts_json，同步/导出全量放大）。
 * 文件缺失/读失败 → 替换为「[附件已丢失: 文件名]」文本 part：静默丢图的话模型会以为自己
 * 看过图并开始基于想象作答，比报缺失危险得多。
 * cache 为 run 级 Map<relativePath, base64|null>：同一附件多轮不重读（长任务几十轮
 * 不能每轮重读 5MB）；缺失也缓存（null），免得丢失附件每轮再撞一次磁盘。
 */
function synthesizeImageData(
  messages: AgentMessage[],
  cache: Map<string, string | null>,
  resolveAbs: (relativePath: string) => string,
): AgentMessage[] {
  if (!messages.some(m => m.role === 'user' && m.parts.some(p => p.type === 'mediaRef'))) return messages;
  return messages.map(m => {
    if (m.role !== 'user' || !m.parts.some(p => p.type === 'mediaRef')) return m;
    return {
      role: m.role,
      parts: m.parts.map(p => {
        if (p.type !== 'mediaRef') return p;
        const v = p.value as { relativePath: string; mimeType: string };
        if (!cache.has(v.relativePath)) {
          try { cache.set(v.relativePath, readFileSync(resolveAbs(v.relativePath)).toString('base64')); }
          catch { cache.set(v.relativePath, null); }
        }
        const b64 = cache.get(v.relativePath);
        return b64 === null
          ? { type: 'text' as const, value: `[附件已丢失: ${basename(v.relativePath)}]` }
          : { type: 'imageData' as const, value: { mimeType: v.mimeType, base64: b64 } };
      }),
    };
  });
}

/** F2b：历史图片占位——最近 keepRounds 轮（含当前正在发送的这轮）内的 mediaRef 照常
 * resolve，更早轮次替换为 `[图片 <文件名> 已随上下文省略]` 文本 part。
 * 为什么：多轮带图会话的历史图片 base64 会全量复带进每次请求，随轮次累计撞 provider
 * 载荷上限（字节校验管得住 5MB、管不住像素——视觉模型长边限制在像素维度）。
 * 轮次定义对齐 compact.ts isRealUserTurn 惯例（一问一答为一轮）：role='user' 且非
 * toolResult 载体即轮界；mediaRef-only 纯图消息也是一次提问，算轮界（isRealUserTurn
 * 的 hasText 判定会把纯图消息漏掉，此处不沿用那半个分支）。
 * 与 synthesizeImageData 同属请求构建边界，且必须排在 resolve 之前——被占位的引用
 * 不再读文件（省 IO），也不会落进 attCache；raw history 与 store 永不改写（DB 零迁移，
 * 占位只发生在组装请求时）。红线：占位文本恒非空、map 保序保长——绝不产生空 parts
 * 数组或空 text part（Anthropic 400 雷）。 */
export const KEEP_MEDIA_ROUNDS = 2;

export function placeholderOldMediaRefs(messages: AgentMessage[], keepRounds: number = KEEP_MEDIA_ROUNDS): AgentMessage[] {
  // 从新到旧数第 keepRounds 个轮界：下标小于 cutoff 的消息属于「更早轮次」
  let cutoff = -1;
  let rounds = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && !m.parts.some(p => p.type === 'toolResult')) {
      rounds++;
      if (rounds >= keepRounds) { cutoff = i; break; }
    }
  }
  if (cutoff <= 0) return messages; // 历史不足 keepRounds 轮：全部都在保留窗口内
  return messages.map((m, i) => {
    if (i >= cutoff || m.role !== 'user') return m;
    if (!m.parts.some(p => p.type === 'mediaRef')) return m;
    const parts = m.parts.map(p => p.type === 'mediaRef'
      ? { type: 'text' as const, value: `[图片 ${basename((p.value as { relativePath: string }).relativePath)} 已随上下文省略]` }
      : p);
    return { role: m.role, parts };
  });
}

/**
 * 单调时钟：store.listMessages 按 (created_at, id) 排序，而 nowEpoch() 只有毫秒精度，
 * 同一毫秒内连续追加会退化成按随机 UUID 排序 —— 回合内消息顺序必须靠严格递增的
 * created_at 来保证（回复确实发生在被回复的消息之后）。
 */
class MonotonicClock {
  private last = 0;
  constructor(private store: ChatStore) {}
  observe(history: RawMessage[]): void {
    for (const m of history) if (m.createdAt > this.last) this.last = m.createdAt;
  }
  next(): number {
    const now = this.store.nowEpoch();
    this.last = now > this.last ? now : this.last + 0.001;
    return this.last;
  }
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface AccumulatedCall { toolUseId: string; name: string; input: string; thoughtSignature?: string }

/**
 * 保证每个 assistant 的 tool_use 都有紧随其后的 user tool_result；补齐缺失的、丢弃孤儿 tool_result。
 * Anthropic/OpenAI 都要求 tool_use 与 tool_result 严格配对，这里在发送前修好整段历史（不改存储）。
 *
 * 真实故障序列：user('A')、assistant(toolUse T1) —— 工具执行途中进程被杀 —— 重启后
 * chat.prompt 又追加了新的 user('B')。孤儿 tool_use 因此落在历史**中间**，last.role 是 'user'，
 * 旧的「只看最后一条」自愈会直接放行，Anthropic 对该会话的每一次请求都 400，会话永久变砖。
 * 改在请求构建边界上、对整段消息数组做配对：既修尾部孤儿，也修中间孤儿与部分配对
 * （assistant 有 T1,T2,T3 但只回了 T1）。持久化历史保持原样。
 */
export function pairToolResults(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  // 已出现过的 tool_use id：用于顺手剥掉「前面没有对应 tool_use」的孤儿 tool_result
  const seenUseIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') {
      // 剥掉孤儿 tool_result（id 从未被任何前置 tool_use 声明过）；无变化则原样透传
      const kept = m.parts.filter(
        p => p.type !== 'toolResult' || seenUseIds.has((p.value as { toolUseId: string }).toolUseId),
      );
      out.push(kept.length === m.parts.length ? m : { role: 'user', parts: kept });
      continue;
    }
    out.push(m);
    const useIds = m.parts
      .filter(p => p.type === 'toolUse')
      .map(p => (p.value as { toolUseId: string }).toolUseId);
    for (const id of useIds) seenUseIds.add(id);
    if (useIds.length === 0) continue;
    // 收集紧随其后的那条 user 消息里已有的 tool_result id
    const next = messages[i + 1];
    const haveIds = new Set<string>();
    if (next && next.role === 'user') {
      for (const p of next.parts) if (p.type === 'toolResult') haveIds.add((p.value as { toolUseId: string }).toolUseId);
    }
    const missing = useIds.filter(id => !haveIds.has(id));
    if (missing.length === 0) continue;
    const placeholders: ContentPart[] = missing.map(id => ({
      type: 'toolResult', value: { toolUseId: id, output: '[工具执行被中断，结果未知]', success: false, status: 'cancelled' },
    }));
    if (next && next.role === 'user') {
      // 把占位结果并入下一条 user 消息的最前面（tool_result 需先于其它内容）
      out.push({ role: 'user', parts: [...placeholders, ...next.parts] });
      i++; // 跳过已合并的 next
    } else {
      out.push({ role: 'user', parts: placeholders });
    }
  }
  return out;
}

/**
 * 工具入参必须是合法 JSON 对象才可落库。
 *
 * 模型偶发吐出非法 JSON、流被截断也会留下半截 JSON；原样落库后
 * anthropic 的 partToBlock 会在该会话之后的**每一次**请求上抛 SyntaxError
 * （数组/标量则是 Anthropic 400）—— 同样是永久变砖。落成 '{}'，让工具注册表的
 * preflight 把「缺少必填参数」作为错误结果喂回模型，模型自己重试。
 */
function safeToolInput(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '{}';
    return input || '{}';
  } catch { return '{}'; }
}

export async function* runAgentLoop(store: ChatStore, opts: RunOptions): AsyncGenerator<LoopEvent> {
  const maxTurns = opts.maxTurns ?? 200;
  const retryLadder = opts.retryDelaysMs ?? DEFAULT_RETRY;
  /** 按当前 slot 的 modelId 解析输出上限：number 原样（向后兼容），工厂按 modelId 求值。 */
  const resolveMaxTokens = (modelId: string): number =>
    typeof opts.maxTokens === 'function' ? opts.maxTokens({ modelId }) : (opts.maxTokens ?? 4096);
  const thinkingLevel: ThinkingLevel = opts.thinkingLevel ?? 'off';
  const clock = new MonotonicClock(store);
  const fallbackChain = opts.fallbackChain ?? [];

  // 当前生效的 provider slot：降级成功后切换到 backup，后续 turn 继续用它
  let activeSlot: ProviderSlot = { provider: opts.provider, label: 'main' };
  // 降级链指针：从 -1（主 provider）开始，降级时 +1
  let slotIndex = -1;
  let fellBack = false; // 是否发生过降级（用于区分「链耗尽」与「无链」的错误消息）

  /** 尝试从当前 slotIndex 开始找下一个可用 slot */
  function tryFallback(): ProviderSlot | undefined {
    slotIndex++;
    if (slotIndex >= fallbackChain.length) return undefined;
    return fallbackChain[slotIndex];
  }

  let hadToolCallInPrevTurn = false; // 上一轮是否有工具调用（用于空响应两路处理判定）
  let remindedEmptyResponse = false; // 本循环是否已提醒过一次空响应（判重；替代旧的「查历史文本」法）
  let pendingEmptyReminder = false; // 下一轮请求是否要注入仅请求侧的空响应提醒（注入一次即清）
  let compactCount = 0; // 本循环已压缩次数（上限 3，设计 §4.2）
  let continueCount = 0; // 本循环已注入的 maxTokens 续写次数（上限 MAX_CONTINUATIONS，防无限空转）

  // 附件 base64 的 run 级缓存（见 synthesizeImageData）：整个循环内同一附件只读一次盘。
  // 解析基准取 attachments 桶 + basename：mediaRef.relativePath 正常是 attachments/<file>，
  // basename 兜底保证任何形态的 relativePath 都逃不出桶（与 chat.prompt 校验正则双保险）。
  const attCache = new Map<string, string | null>();
  const attDir = opts.toolContext.paths.sessionBucket(opts.sessionId, 'attachments');

  /**
   * F1：取消短路点共用的收尾——把流式中途已展示给用户的半截文本落库，再报「已取消」。
   * 不落的话屏幕上有、历史里没有：下轮提问模型看不到自己说过的半截话。
   * 红线与取舍：
   *  - text 为空（取消发生在任何 textDelta 之前）→ 什么都不落。「空 assistant 回合绝不落库」
   *    与主路径同级红线：Anthropic 拒收 content 为空的消息，落了会让会话后续每次请求都 400。
   *  - 只落 text part：calls 里已解析的 toolCallComplete 一律丢弃——落库 tool_use 而无配对
   *    tool_result 等于主动制造 pairToolResults 要修的那种孤儿，Anthropic 同样每次 400 变砖。
   *    thinking 块同理不落（历史 thinking 块只在回放时被引用，丢掉永远安全）；
   *    已累积的半截思考走 reasoningContent（仅展示不回放），有值就带上；tokenUsage 有就带。
   *  - streamInterruptCount=1：该字段语义即「本消息的流中断计数」（shared/types.ts RawMessage），
   *    半截消息正是流被中断的产物；当前全链路恒写 0 且无读取方，置 1 只是把既有语义用起来。
   *  - 先发 messagePersisted 再发 error：renderer 的 error 分支靠 open() 重取历史刷新，
   *    顺序反了的话重取时消息还没进库，屏幕上的半截话就凭空消失了。
   */
  function* cancelWithPartialReply(text: string, reasoning: string, usage: TokenUsage | undefined): Generator<LoopEvent> {
    if (text) {
      const m = store.appendMessage({
        id: store.newId(), sessionId: opts.sessionId, role: 'assistant', parts: [{ type: 'text', value: text }],
        createdAt: clock.next(), streamInterruptCount: 1,
        reasoningContent: reasoning || undefined, tokenUsage: usage,
      });
      yield { kind: 'messagePersisted', messageId: m.id };
    }
    yield { kind: 'error', message: '已取消' };
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    // F1 侦察结论：此处不接半截落库——text 在流循环内累积、turn 头尚未开流，本轮恒空；
    // 能 continue 回到这里的路径（压缩/空响应两路/maxTokens 续写）里，非空文本要么早已
    // 正常落库（续写路径在上一轮就 persist 过），要么本就为空（空响应路径的定义）。
    if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
    const history = store.listMessages(opts.sessionId);
    clock.observe(history);

    // 推理时合成 effectiveAgentHistory（设计 §4.2「推理时合成」）
    // raw history 永不改写；effectiveHistory 是水位估算与请求构建的唯一输入。
    // 用 let：offload 档修剪后要就地换成修剪版历史（只影响本轮请求）。
    const curMarker = opts.compactEngine ? store.getLatestCompactMarker(opts.sessionId) : undefined;
    let effectiveHistory = opts.compactEngine
      ? opts.compactEngine.buildEffectiveHistory(history, curMarker)
      : toAgentMessages(history);

    // 上下文水位检查 + 压缩（设计 §4.2「上下文水位检查」+「压缩」段）
    // 关键：estimateTokens 基于 effectiveHistory，不是 raw history——
    //   压缩写 marker 后 effectiveHistory 变小、水位自然下降，不会出现
    //   「存储不改写 → 水位永不降 → 每次都重复压缩到 3 次上限」的缺陷。
    if (opts.contextPolicy && opts.compactEngine && compactCount < 3) {
      const action = opts.contextPolicy.decide(
        activeSlot.provider.modelId,
        opts.contextPolicy.estimateTokens(effectiveHistory),
      );
      if (action === 'compact') {
        try {
          const newMarker = await opts.compactEngine.summarize(history, opts.sessionId, activeSlot.provider);
          if (newMarker) {
            compactCount++;
            yield { kind: 'compacted', markerId: newMarker.id, summary: newMarker.summary.slice(0, 200) };
            turn--; // 压缩轮不消耗 turn 额度
            continue; // 重新取 history + effectiveHistory（含新 marker，水位下降）
          }
          // summarize 返回 undefined（不足 3 个真正用户回合且消息数 < 30）：
          //  不发 compacted 事件、不 turn--、不 continue——直接落到下面的 req 构建，
          //  用现有 effectiveHistory 继续流式请求。
          //  关键：绝不能因 undefined 而 continue 重试，否则 history 不变 → 水位不变 →
          //  再次 compact → 再次 undefined → 死循环。落下去发请求才是正路。
        } catch {
          // 压缩失败（provider 抛错）不杀对话：跳过本次压缩，继续流式请求
        }
      } else if (action === 'offload') {
        // offload 档是比压缩更便宜的减压手段：把旧的大工具结果换成单行桩，让本轮请求变小。
        // 修剪只发生在请求侧合成数组上，raw history 与存储永不改写（与 compact 的
        // 「推理时合成」同一哲学）——否则修剪成了持久化行为，模型永远拿不回原文。
        const { pruned, history: prunedHistory } = pruneOldToolResults(effectiveHistory);
        if (pruned > 0) {
          yield { kind: 'pruned', count: pruned };
          effectiveHistory = prunedHistory;
        }
      }
    }

    // 构建 req（复用上方已合成的 effectiveHistory，不重复计算 marker / effectiveHistory）
    const allToolDefs = opts.tools.definitions();
    const toolDefs = opts.excludedToolNames ? allToolDefs.filter(t => !opts.excludedToolNames!.has(t.name)) : allToolDefs;
    const req: StreamRequest = {
      // 发送前在 provider 边界配对 tool_use/tool_result（修中断后会话永久损坏），不改存储。
      // 附件同属请求构建边界：先占位（F2b，resolve 之前——旧轮引用不读盘），
      // 再 mediaRef → imageData(base64) 就地合成，raw history 不动。
      messages: pairToolResults(synthesizeImageData(placeholderOldMediaRefs(effectiveHistory), attCache, rel => join(attDir, basename(rel)))),
      // systemPrompt/maxTokens 占位——下方 while 循环内按当前 activeSlot 重算（降级切换后当轮生效）
      systemPrompt: '',
      maxTokens: 0,
      tools: toolDefs, thinkingLevel,
    };
    // 上一轮 maxTokens 截断：在请求侧 messages 末尾追加合成 user 提示，让模型从截断处继续。
    // 只出现在请求里、绝不落库——与 pairToolResults 同属请求构建边界，raw history 保持不动。
    if (continueCount > 0) {
      req.messages.push({ role: 'user', parts: [{ type: 'text', value: CONTINUE_HINT }] });
    }
    // 空响应提醒同款注入（CONTINUE_HINT 模式）：上一轮 tool_result 后模型空手而归，
    // 这里追加一次性合成 user 消息催它继续。注入一次即清——模型恢复后的后续请求
    // 不再携带；判重状态由 remindedEmptyResponse 持有，与本标志分离。
    if (pendingEmptyReminder) {
      req.messages.push({ role: 'user', parts: [{ type: 'text', value: EMPTY_RESPONSE_REMINDER }] });
      pendingEmptyReminder = false;
    }

    let text = ''; let reasoning = ''; let usage: TokenUsage | undefined; let stopReason: StopReason = 'endTurn';
    let calls: AccumulatedCall[] = [];
    // thinking 块按到达顺序累积：Anthropic 要求回放时 thinking 排在最前，故单独收集、落库前置
    let thinking: { text: string; signature?: string; redactedData?: string }[] = [];
    let streamOk = false;
    let lastError: ProviderError | undefined;

    // 降级循环：主 slot → fallbackChain[0] → [1] → …
    // 每次 slot 切换后重置累加器，从头流式请求
    while (true) {
      text = ''; reasoning = ''; usage = undefined; stopReason = 'endTurn'; calls = []; thinking = [];
      const currentProvider = activeSlot.provider;
      // systemPrompt 工厂：每次 slot 切换后用当前 activeSlot.provider.modelId 重算（决策点 3 方案 a：降级当轮生效）；
      // 传 string 时原样透传（向后兼容——等价于改前行为）
      req.systemPrompt = typeof opts.systemPrompt === 'function'
        ? opts.systemPrompt({ modelId: currentProvider.modelId, sessionId: opts.sessionId })
        : opts.systemPrompt;
      // maxTokens 同款按 slot 重算：降级到小输出上限的端点时，沿用主模型的大值会被对方 400 拒收，
      // 降级链会因此连环失败（「所有模型均不可用」的假象）。thinking 预算随 req.maxTokens 自然回正。
      req.maxTokens = resolveMaxTokens(currentProvider.modelId);

      // 透明重试：仅对 retryable 错误（M1 逻辑不变）
      let attemptSucceeded = false;
      for (let attempt = 0; attempt <= retryLadder.length; attempt++) {
        // 每次尝试都必须清空累加器：第 1 次流出半截文本再失败时，若不清空，
        // 第 2 次会往同一个累加器上追加，落库的 assistant 文本会重复一遍（工具调用同理）。
        text = ''; reasoning = ''; usage = undefined; stopReason = 'endTurn'; calls = []; thinking = [];
        try {
          for await (const ev of currentProvider.streamAgentMessage(req, opts.signal)) {
            switch (ev.kind) {
              case 'textDelta': text += ev.text; yield ev; break;
              case 'thinkingDelta': reasoning += ev.text; yield ev; break;
              case 'thinkingComplete': thinking.push({ text: ev.text, ...(ev.signature !== undefined ? { signature: ev.signature } : {}), ...(ev.redactedData !== undefined ? { redactedData: ev.redactedData } : {}) }); break;
              case 'toolCallComplete': calls.push({ toolUseId: ev.toolUseId, name: ev.name, input: ev.input, ...(ev.thoughtSignature !== undefined ? { thoughtSignature: ev.thoughtSignature } : {}) }); break;
              case 'usage': usage = ev.usage; break;
              case 'done': stopReason = ev.stopReason; break;
              case 'toolInputDelta': break; // M1 UI 不用增量预览
            }
          }
          attemptSucceeded = true;
          break;
        } catch (e) {
          // 取消优先于重试梯：provider 把 AbortError 也包成 retryable ProviderError，
          // 若不在这里短路，取消会退化成「睡一觉再重试」。
          // F1：此处 text 持有本 attempt 已展示给用户的半截文本——取消时先落库再终止。
          if (opts.signal?.aborted) { yield* cancelWithPartialReply(text, reasoning, usage); return; }
          const err = e instanceof ProviderError ? e : new ProviderError(String(e), { retryable: false });
          // fallbackable 错误：不重试，立刻降级
          if (isFallbackable(err)) {
            lastError = err;
            break; // 跳出重试梯，进入下方降级逻辑
          }
          // 非 fallbackable 错误：retryable 先走重试梯；非 retryable 或重试梯耗尽 → 有备选则降级，无备选报错终止
          if (!err.retryable || attempt >= retryLadder.length) {
            // 还有降级备选时先降级，否则报错终止
            if (slotIndex + 1 < fallbackChain.length) {
              lastError = err;
              break;
            }
            yield { kind: 'error', message: err.message }; return;
          }
          // retryable：走重试梯
          const d = retryLadder[attempt];
          yield { kind: 'retry', attempt: attempt + 1, delayMs: d, reason: err.message };
          await delay(d);
          // F1：重试等待期取消——text 仍是失败 attempt 的半截文本（要到下次 attempt 开头才清空），
          // 屏幕上已展示过它，取消时同样先落库再终止。
          if (opts.signal?.aborted) { yield* cancelWithPartialReply(text, reasoning, usage); return; }
        }
      }

      if (attemptSucceeded) { streamOk = true; break; }

      // 到这里说明当前 slot 的流式请求失败了（fallbackable 或 retryable 耗尽）
      // 尝试降级到下一 slot
      const nextSlot = tryFallback();
      if (!nextSlot) {
        // 链非空且已耗尽 →「所有模型均不可用」；链本就空 → 保留 M1 的原始错误消息
        yield { kind: 'error', message: fellBack ? '所有模型均不可用' : (lastError?.message ?? '所有模型均不可用') };
        return;
      }
      yield { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: lastError?.message ?? '未知错误' };
      fellBack = true;
      activeSlot = nextSlot;
      // 继续 while(true) 用新 slot 重新流式请求
    }

    if (!streamOk) { yield { kind: 'error', message: '流式请求失败' }; return; }

    // 持久化 assistant 消息（thinking + text + toolUse）
    const assistantParts: ContentPart[] = [];
    // thinking 必须排在最前（Anthropic 块序要求：thinking 先于 text 与 tool_use）
    for (const t of thinking) {
      assistantParts.push({ type: 'thinking', value: { text: t.text, ...(t.signature !== undefined ? { signature: t.signature } : {}), ...(t.redactedData !== undefined ? { redactedData: t.redactedData } : {}) } });
    }
    if (text) assistantParts.push({ type: 'text', value: text });
    for (const c of calls) {
      // 就地归一：落库/toolStart 事件/工具执行三处看到的入参必须是同一个值
      c.input = safeToolInput(c.input);
      assistantParts.push({ type: 'toolUse', value: { toolUseId: c.toolUseId, name: c.name, input: c.input, ...(c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {}) } });
    }

    // 空响应处理（设计 §4.2 空响应两路）
    // 判定看「无正文且无工具调用」而非 assistantParts 是否为空：A1 把 thinking 块前置进了
    // assistantParts，thinking-only（有思考、无正文无工具）的响应此时 parts 非空，若按长度判
    // 定会绕过空响应两路恢复、落库一条用户看不见任何内容的 thinking-only 消息后直接 turnEnd。
    // 改为 text 为空且 calls 为空即视作空响应 → 不落库、走既有降级/reminder 两路；同时保证
    // thinking-only 这一新消息形态永远不会进入历史。
    if (!text && calls.length === 0) {
      if (!hadToolCallInPrevTurn) {
        // 首轮空响应：直接降级，不注入 system-reminder
        const nextSlot = tryFallback();
        if (!nextSlot) { yield { kind: 'error', message: '模型返回了空响应' }; return; }
        yield { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: '空响应' };
        fellBack = true;
        activeSlot = nextSlot;
        turn--; // 不消耗 turn 额度，重试这一轮
        continue;
      }
      // tool_result 后空响应：先注入一次 system-reminder 重试。
      // 判重靠循环内存标志而非检查最后一条 user 消息是否含「系统提醒」——
      // 提醒已不落库（见 EMPTY_RESPONSE_REMINDER），历史里本就没有它可查；
      // 且按文本判重会把恰好含这四个字的用户正文误认成已注入的提醒，
      // 直接跳过恢复机会报「模型返回了空响应」。
      if (!remindedEmptyResponse) {
        remindedEmptyResponse = true;
        pendingEmptyReminder = true; // 下一轮请求构建时注入（见 req 构建处）
        turn--; // 不消耗 turn 额度，重试这一轮
        continue;
      }
      // reminder 重试仍空：降级
      const nextSlot = tryFallback();
      if (!nextSlot) { yield { kind: 'error', message: '模型返回了空响应' }; return; }
      yield { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: '空响应（reminder 重试后仍空）' };
      fellBack = true;
      activeSlot = nextSlot;
      turn--;
      continue;
    }
    // 空 assistant 回合绝不落库：Anthropic 拒收 content 为空的消息，
    // 这一行会让该会话之后的每次请求都失败（永久变砖）。
    // （空响应已在上方降级/reminder 分支处理，能走到这里说明 assistantParts 非空）

    const assistant = store.appendMessage({
      id: store.newId(), sessionId: opts.sessionId, role: 'assistant', parts: assistantParts,
      createdAt: clock.next(), streamInterruptCount: 0, reasoningContent: reasoning || undefined, tokenUsage: usage,
    });
    yield { kind: 'messagePersisted', messageId: assistant.id };

    hadToolCallInPrevTurn = calls.length > 0;

    if (calls.length === 0) {
      // maxTokens 截断自动续写：本轮无工具调用且未到续写上限时，不 turnEnd，
      // 下一轮请求构建时注入 CONTINUE_HINT（见 req 构建处），让模型从截断处继续。
      // 只对 maxTokens 生效——endTurn/refusal 是模型的正常/拒绝收尾，不该被追续。
      if (stopReason === 'maxTokens' && continueCount < MAX_CONTINUATIONS) {
        continueCount++;
        continue;
      }
      yield { kind: 'turnEnd', stopReason };
      return;
    }

    // 本轮发了工具调用 = 模型转入工具流程而非继续输出：续写状态作废。
    // 不清空的话，下一轮（工具结果后）还会误注入「上一条被截断」的提示，而那条早已不是被截断的输出。
    continueCount = 0;

    // 并发执行工具（上限 10），结果按原顺序拼回
    for (const c of calls) yield { kind: 'toolStart', toolUseId: c.toolUseId, name: c.name, title: extractTitle(c.input), input: c.input };
    const results = await runWithConcurrency(calls, CONCURRENCY, async c => {
      const outcome = await opts.tools.execute(c.name, c.input, opts.toolContext);
      return { c, outcome };
    });
    const resultParts: ContentPart[] = [];
    for (const { c, outcome } of results) {
      // 卸载：大工具结果落库前替换为桩（设计 §4.2「大工具结果卸载」）
      let outputToStore = outcome.output;
      if (opts.offloadEngine && opts.offloadEngine.shouldOffload(outcome.output)) {
        const { stub, relativePath } = opts.offloadEngine.offload(opts.sessionId, c.toolUseId, outcome.output);
        yield { kind: 'offloaded', toolUseId: c.toolUseId, relativePath };
        outputToStore = stub;
      }
      // toolEnd 事件广播替换前完整 output（UI 可见）；落库的是 outputToStore（可能是桩）
      yield { kind: 'toolEnd', toolUseId: c.toolUseId, success: outcome.success, output: outcome.output };
      resultParts.push({ type: 'toolResult', value: { toolUseId: c.toolUseId, output: outputToStore, success: outcome.success, status: outcome.success ? 'success' : 'failed' } });
    }
    const resultMsg = store.appendMessage({
      id: store.newId(), sessionId: opts.sessionId, role: 'user', parts: resultParts,
      createdAt: clock.next(), streamInterruptCount: 0,
    });
    yield { kind: 'messagePersisted', messageId: resultMsg.id };
    // 继续下一轮
  }
  yield { kind: 'error', message: `已达最大回合数 ${maxTurns}` };
}

function extractTitle(inputJson: string): string {
  try { return String((JSON.parse(inputJson) as Record<string, unknown>).tool_title ?? ''); } catch { return ''; }
}

/** 保持输入顺序的并发执行器。 */
async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
