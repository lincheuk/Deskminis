import type { AgentMessage, ContentPart, RawMessage, StopReason, ThinkingLevel, TokenUsage } from '../../shared/types';
import type { AgentProvider, StreamRequest } from '../providers/types';
import { ProviderError, isFallbackable } from '../providers/types';
import type { ChatStore } from '../store/chat-store';
import type { ToolRegistry } from '../tools/registry';
import type { ToolContext } from '../tools/types';
import type { ContextPolicy } from './context-policy';
import type { OffloadEngine } from './offload';
import type { CompactEngine } from './compact';
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
  | { kind: 'error'; message: string };

export interface ProviderSlot { provider: AgentProvider; label: string }

/** systemPrompt 工厂函数入参（决策点 3 方案 a）：轮内动态重建 stable 段。 */
export interface SystemPromptCtx { modelId: string; sessionId: string }

export interface RunOptions {
  sessionId: string; provider: AgentProvider; tools: ToolRegistry; toolContext: ToolContext;
  /** 系统提示——传 string 时每轮原样用（向后兼容）；传工厂函数时每轮用当前 activeSlot.provider.modelId 调工厂（降级/桥授权当轮生效）。 */
  systemPrompt: string | ((ctx: SystemPromptCtx) => string); maxTokens?: number; thinkingLevel?: ThinkingLevel; maxTurns?: number;
  signal?: AbortSignal; retryDelaysMs?: number[];
  fallbackChain?: ProviderSlot[];
  contextPolicy?: ContextPolicy;       // 上下文水位分层决策（Task 4）
  compactEngine?: CompactEngine;       // LLM 压缩摘要（Task 6）
  offloadEngine?: OffloadEngine;       // 大工具结果卸载（Task 5）
  excludedToolNames?: Set<string>;     // 按会话过滤工具（memory_enabled=false 时排除记忆工具）
}

const DEFAULT_RETRY = [3000, 5000, 10000, 15000, 30000];
const CONCURRENCY = 10;

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
  const maxTokens = opts.maxTokens ?? 4096;
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
  let compactCount = 0; // 本循环已压缩次数（上限 3，设计 §4.2）

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
    const history = store.listMessages(opts.sessionId);
    clock.observe(history);

    // 推理时合成 effectiveAgentHistory（设计 §4.2「推理时合成」）
    // raw history 永不改写；effectiveHistory 是水位估算与请求构建的唯一输入。
    const curMarker = opts.compactEngine ? store.getLatestCompactMarker(opts.sessionId) : undefined;
    const effectiveHistory = opts.compactEngine
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
          // summarize 返回 undefined（不足 3 个真正用户回合）：
          //  不发 compacted 事件、不 turn--、不 continue——直接落到下面的 req 构建，
          //  用现有 effectiveHistory 继续流式请求。
          //  关键：绝不能因 undefined 而 continue 重试，否则 history 不变 → 水位不变 →
          //  再次 compact → 再次 undefined → 死循环。落下去发请求才是正路。
        } catch {
          // 压缩失败（provider 抛错）不杀对话：跳过本次压缩，继续流式请求
        }
      }
    }

    // 构建 req（复用上方已合成的 effectiveHistory，不重复计算 marker / effectiveHistory）
    const allToolDefs = opts.tools.definitions();
    const toolDefs = opts.excludedToolNames ? allToolDefs.filter(t => !opts.excludedToolNames!.has(t.name)) : allToolDefs;
    const req: StreamRequest = {
      // 发送前在 provider 边界配对 tool_use/tool_result（修中断后会话永久损坏），不改存储
      messages: pairToolResults(effectiveHistory),
      // systemPrompt 占位——下方 while 循环内按当前 activeSlot 重算（降级切换后当轮生效）
      systemPrompt: '',
      tools: toolDefs, maxTokens, thinkingLevel,
    };

    let text = ''; let reasoning = ''; let usage: TokenUsage | undefined; let stopReason: StopReason = 'endTurn';
    let calls: AccumulatedCall[] = [];
    let streamOk = false;
    let lastError: ProviderError | undefined;

    // 降级循环：主 slot → fallbackChain[0] → [1] → …
    // 每次 slot 切换后重置累加器，从头流式请求
    while (true) {
      text = ''; reasoning = ''; usage = undefined; stopReason = 'endTurn'; calls = [];
      const currentProvider = activeSlot.provider;
      // systemPrompt 工厂：每次 slot 切换后用当前 activeSlot.provider.modelId 重算（决策点 3 方案 a：降级当轮生效）；
      // 传 string 时原样透传（向后兼容——等价于改前行为）
      req.systemPrompt = typeof opts.systemPrompt === 'function'
        ? opts.systemPrompt({ modelId: currentProvider.modelId, sessionId: opts.sessionId })
        : opts.systemPrompt;

      // 透明重试：仅对 retryable 错误（M1 逻辑不变）
      let attemptSucceeded = false;
      for (let attempt = 0; attempt <= retryLadder.length; attempt++) {
        // 每次尝试都必须清空累加器：第 1 次流出半截文本再失败时，若不清空，
        // 第 2 次会往同一个累加器上追加，落库的 assistant 文本会重复一遍（工具调用同理）。
        text = ''; reasoning = ''; usage = undefined; stopReason = 'endTurn'; calls = [];
        try {
          for await (const ev of currentProvider.streamAgentMessage(req, opts.signal)) {
            switch (ev.kind) {
              case 'textDelta': text += ev.text; yield ev; break;
              case 'thinkingDelta': reasoning += ev.text; yield ev; break;
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
          if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
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
          if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
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

    // 持久化 assistant 消息（text + toolUse）
    const assistantParts: ContentPart[] = [];
    if (text) assistantParts.push({ type: 'text', value: text });
    for (const c of calls) {
      // 就地归一：落库/toolStart 事件/工具执行三处看到的入参必须是同一个值
      c.input = safeToolInput(c.input);
      assistantParts.push({ type: 'toolUse', value: { toolUseId: c.toolUseId, name: c.name, input: c.input, ...(c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {}) } });
    }

    // 空响应处理（设计 §4.2 空响应两路）
    if (assistantParts.length === 0) {
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
      // tool_result 后空响应：先注入一次 system-reminder 重试
      // 检查是否已经注入过 reminder（避免无限循环）
      const lastUserMsg = history.filter(m => m.role === 'user').at(-1);
      const alreadyReminded = lastUserMsg?.parts.some(p => p.type === 'text' && (p.value as string).includes('系统提醒')) ?? false;
      if (!alreadyReminded) {
        // 注入 system-reminder 作为 user 消息
        store.appendMessage({
          id: store.newId(), sessionId: opts.sessionId, role: 'user',
          parts: [{ type: 'text', value: '[系统提醒: 上一次工具调用后你返回了空响应，请继续]' }],
          createdAt: clock.next(), streamInterruptCount: 0,
        });
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

    if (calls.length === 0) { yield { kind: 'turnEnd', stopReason }; return; }

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
