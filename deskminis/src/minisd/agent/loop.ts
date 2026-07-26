import type { AgentMessage, ContentPart, RawMessage, StopReason, ThinkingLevel, TokenUsage } from '../../shared/types';
import type { AgentProvider, StreamRequest } from '../providers/types';
import { ProviderError } from '../providers/types';
import type { ChatStore } from '../store/chat-store';
import type { ToolRegistry } from '../tools/registry';
import type { ToolContext } from '../tools/types';

export type LoopEvent =
  | { kind: 'textDelta'; text: string }
  | { kind: 'thinkingDelta'; text: string }
  | { kind: 'toolStart'; toolUseId: string; name: string; title: string; input: string }
  | { kind: 'toolEnd'; toolUseId: string; success: boolean; output: string }
  | { kind: 'messagePersisted'; messageId: string }
  | { kind: 'turnEnd'; stopReason: StopReason }
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  | { kind: 'error'; message: string };

export interface RunOptions {
  sessionId: string; provider: AgentProvider; tools: ToolRegistry; toolContext: ToolContext;
  systemPrompt: string; maxTokens?: number; thinkingLevel?: ThinkingLevel; maxTurns?: number;
  signal?: AbortSignal; retryDelaysMs?: number[];
}

const DEFAULT_RETRY = [3000, 5000, 10000, 15000, 30000];
const CONCURRENCY = 10;

/** 丢弃持久化专属字段，只留 Provider 需要的 {role, parts}。 */
function toAgentMessages(history: RawMessage[]): AgentMessage[] {
  return history.map(m => ({ role: m.role, parts: m.parts }));
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

interface AccumulatedCall { toolUseId: string; name: string; input: string }

/** 孤儿 tool_use 的占位结果文案（设计 §4.2 的历史自愈）。 */
const INTERRUPTED_OUTPUT = '[工具执行被中断，结果未知]';

/**
 * 循环入口的历史自愈（设计 §4.2）。
 *
 * assistant(toolUse) 与 user(toolResult) 是两次独立写库，中间隔着真实的工具执行
 * （shell 超时 120s、权限询问 30s）。进程在这个窗口里被杀 / 用户退出应用，会话就留下
 * 一条没有配对 tool_result 的尾部 assistant —— Anthropic 之后对该会话的**每一次**请求
 * 都会 400，会话永久变砖。开跑前补一条占位 toolResult 把历史修圆。
 *
 * 只看最后一条消息：中间的 tool_use 必然已被下一条 user(toolResult) 配对过。
 */
export function healInterruptedToolUses(store: ChatStore, sessionId: string): RawMessage | undefined {
  const history = store.listMessages(sessionId);
  const last = history.at(-1);
  if (!last || last.role !== 'assistant') return undefined;
  const orphanIds = last.parts
    .filter(p => p.type === 'toolUse')
    .map(p => (p.value as { toolUseId: string }).toolUseId)
    .filter(id => typeof id === 'string' && id !== '');
  if (orphanIds.length === 0) return undefined;
  const parts: ContentPart[] = orphanIds.map(id => ({
    type: 'toolResult',
    value: { toolUseId: id, output: INTERRUPTED_OUTPUT, success: false, status: 'cancelled' },
  }));
  // created_at 必须严格大于被修复的 assistant，否则 listMessages 的排序会把补丁排到它前面
  const createdAt = Math.max(store.nowEpoch(), last.createdAt + 0.001);
  return store.appendMessage({
    id: store.newId(), sessionId, role: 'user', parts, createdAt, streamInterruptCount: 0,
  });
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

  // 每次 runAgentLoop 只自愈一次：回合内的配对由循环自身保证
  const healed = healInterruptedToolUses(store, opts.sessionId);
  if (healed) yield { kind: 'messagePersisted', messageId: healed.id };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
    const history = store.listMessages(opts.sessionId);
    clock.observe(history);
    const req: StreamRequest = {
      messages: toAgentMessages(history),
      systemPrompt: opts.systemPrompt, tools: opts.tools.definitions(), maxTokens, thinkingLevel,
    };

    let text = ''; let reasoning = ''; let usage: TokenUsage | undefined; let stopReason: StopReason = 'endTurn';
    let calls: AccumulatedCall[] = [];
    let streamOk = false;

    // 透明重试：仅对 retryable 错误
    for (let attempt = 0; attempt <= retryLadder.length; attempt++) {
      // 每次尝试都必须清空累加器：第 1 次流出半截文本再失败时，若不清空，
      // 第 2 次会往同一个累加器上追加，落库的 assistant 文本会重复一遍（工具调用同理）。
      // 声明放在循环外，是为了让循环后的落库代码看到「最后一次尝试」的值。
      text = ''; reasoning = ''; usage = undefined; stopReason = 'endTurn'; calls = [];
      try {
        for await (const ev of opts.provider.streamAgentMessage(req, opts.signal)) {
          switch (ev.kind) {
            case 'textDelta': text += ev.text; yield ev; break;
            case 'thinkingDelta': reasoning += ev.text; yield ev; break;
            case 'toolCallComplete': calls.push({ toolUseId: ev.toolUseId, name: ev.name, input: ev.input }); break;
            case 'usage': usage = ev.usage; break;
            case 'done': stopReason = ev.stopReason; break;
            case 'toolInputDelta': break; // M1 UI 不用增量预览
          }
        }
        streamOk = true;
        break;
      } catch (e) {
        // 取消优先于重试梯：provider 把 AbortError 也包成 retryable ProviderError，
        // 若不在这里短路，取消会退化成「睡一觉再重试」。
        if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
        const err = e instanceof ProviderError ? e : new ProviderError(String(e), { retryable: false });
        if (!err.retryable || attempt >= retryLadder.length) { yield { kind: 'error', message: err.message }; return; }
        const d = retryLadder[attempt];
        yield { kind: 'retry', attempt: attempt + 1, delayMs: d, reason: err.message };
        await delay(d);
        if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
      }
    }
    if (!streamOk) { yield { kind: 'error', message: '流式请求失败' }; return; }

    // 持久化 assistant 消息（text + toolUse）
    const assistantParts: ContentPart[] = [];
    if (text) assistantParts.push({ type: 'text', value: text });
    for (const c of calls) {
      // 就地归一：落库/toolStart 事件/工具执行三处看到的入参必须是同一个值
      c.input = safeToolInput(c.input);
      assistantParts.push({ type: 'toolUse', value: { toolUseId: c.toolUseId, name: c.name, input: c.input } });
    }
    // 空 assistant 回合绝不落库：Anthropic 拒收 content 为空的消息，
    // 这一行会让该会话之后的每次请求都失败（永久变砖）。
    if (assistantParts.length === 0) {
      yield { kind: 'error', message: '模型返回了空响应' };
      return;
    }
    const assistant = store.appendMessage({
      id: store.newId(), sessionId: opts.sessionId, role: 'assistant', parts: assistantParts,
      createdAt: clock.next(), streamInterruptCount: 0, reasoningContent: reasoning || undefined, tokenUsage: usage,
    });
    yield { kind: 'messagePersisted', messageId: assistant.id };

    if (calls.length === 0) { yield { kind: 'turnEnd', stopReason }; return; }

    // 并发执行工具（上限 10），结果按原顺序拼回
    for (const c of calls) yield { kind: 'toolStart', toolUseId: c.toolUseId, name: c.name, title: extractTitle(c.input), input: c.input };
    const results = await runWithConcurrency(calls, CONCURRENCY, async c => {
      const outcome = await opts.tools.execute(c.name, c.input, opts.toolContext);
      return { c, outcome };
    });
    const resultParts: ContentPart[] = [];
    for (const { c, outcome } of results) {
      yield { kind: 'toolEnd', toolUseId: c.toolUseId, success: outcome.success, output: outcome.output };
      resultParts.push({ type: 'toolResult', value: { toolUseId: c.toolUseId, output: outcome.output, success: outcome.success, status: outcome.success ? 'success' : 'failed' } });
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
