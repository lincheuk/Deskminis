import { carryInputOrigin, fullyCoveredInputIds, observeInputRequest } from './input-provenance';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import { IMAGE_HEADER_BYTES } from '../providers/image-tokens';
import type { AgentMessage, AgentToolDefinition, ContentPart, RawMessage, StopReason, ThinkingLevel, TokenUsage } from '../../shared/types';
import { COMPACT_MIN_GAIN, limitName, type OutputLimitInfo, type RequestBudget } from '../../shared/request-budget';
import type { AgentProvider, StreamRequest, SystemPromptParts } from '../providers/types';
import { ProviderError, isFallbackable } from '../providers/types';
import type { ChatStore } from '../store/chat-store';
import type { ToolRegistry } from '../tools/registry';
import type { ToolContext } from '../tools/types';
import { sharedToolScheduler, type SchedulerEvent, type ToolScheduler } from '../tools/scheduler';
import type { RuntimeModel } from '../../shared/runtime-model';
import { countImageNeeds, planSlot, thinkingIsServerAdaptive, type RequestNeeds, type SlotPlan } from '../providers/runtime-model';
import { FALLBACK_WINDOW, type ContextPolicy } from './context-policy';
import type { OffloadEngine } from './offload';
import {
  CompactRejectedError, SUMMARY_MIN_OUTPUT, SUMMARY_SYSTEM_PROMPT, carriedUserTurns, isRealUserTurn, isUselessSummary, isUserTurn, pendingSummaryRange,
  previewSummaryMessage, type CompactEngine, type CompactFailReason, type SummarizeOptions, type SummaryFit,
} from './compact';
import { compactionViewOf, mediaName, renderEngineRecord, type ToolKindOf } from './compact-meta';
import { pruneOldToolResults, trimForRequest } from './prune';
import { toAgentMessage } from './agent-message';
import {
  FIXED_COST_ADVICE, briefOf, compactWorthwhile, computeSlotBudget, decideContextAction, finalizeUsage, fixedCostDominates, fixedCostMessage,
  joinSystemPrompt, lowerCeiling, measureMessages, needsRelief, orderToolDefinitions, outputExhaustedMessage, truncatedToolCallNotice, usageSourceOf,
  type RejectionCeiling, type SlotBudget,
} from './request-budget';
import { overflowHint } from '../providers/overflow';
import {
  COMPACT_FUSE_REASONS, RECOVERY_LIMITS,
  type AnchorRule, type BudgetBrief, type CompactTrigger, type CompactionView, type ContextRecoveryView, type RecoveryAction,
  type RecoveryLimits, type RecoveryStop, type TrimLevel,
} from '../../shared/compaction';
import { finalizeToolOutput, wrapToolOutput } from './tool-output';
import { ToolLoopGuard } from './tool-loop-guard';
import type { RunRecorder } from './run-recorder';
import { terminalOf, toolResultStatusOf } from '../../shared/run';

export type LoopEvent =
  | { kind: 'textDelta'; text: string }
  | { kind: 'thinkingDelta'; text: string }
  | { kind: 'toolStart'; toolUseId: string; name: string; title: string; input: string }
  | { kind: 'toolEnd'; toolUseId: string; success: boolean; output: string }
  | { kind: 'messagePersisted'; messageId: string }
  // outputLimit（F02）：只在 stopReason === 'maxTokens' 且这次请求有预算时带——截断时说得出这次 max_tokens 是多少、为什么是这个数
  | { kind: 'turnEnd'; stopReason: StopReason; outputLimit?: OutputLimitInfo }
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  // cause（W2a-2 · 设计稿 §3 第 2 条）：只在因上下文超窗降级到更大窗口时带，reason 固定为「上下文已满」——
  // 旧 reason 是英文原始报错，渲染端据 cause 给短句，不对原文跑正则。
  // F01：'capability' = 当前槽位接不了这一轮（不输出文本、本轮带图片而它不收图片），一次请求没发就换到接得住的槽位；
  // 它不是故障，index.ts 不据此改绑会话。F01R：每次运行至多一条，且先于水位判断与压缩（顺序见 runAgentLoop 的 I1–I3）
  // F02：'requestBudget' = 当前槽位放不下这次请求的固定部分（系统提示 + 工具定义），同样一次请求没发、不是故障、不改绑
  // F02b：'outputLimit' = 当前槽位的回复以 max_tokens 截断收尾、正文与工具调用都没有，而这次的 max_tokens 是模型自己的输出上限
  //   或手动填的最大输出（不是 F02 收紧出来的）：换到链上下一个接得住这一轮的槽位重发（换用的那一刻要先压缩对话才放得下的、
  //   修剪之后仍放不下的——对话太长，或固定开销按估算已占满它的输入上限——不算，说明后跳过）。
  //   请求发过一次，但槽位没有出故障，index.ts 不把它算作改绑的理由；reason 就是 outputLimit 错误会写的那句说明（没有可换的槽位时报的正是那条错误）
  | { kind: 'fallback'; from: string; to: string; reason: string; cause?: 'contextOverflow' | 'capability' | 'requestBudget' | 'outputLimit' }
  // F01：与用户意图不一致的兼容处理（跳过的槽位、改以文字发送的历史图片/工具记录、推理档位调整），逐条说出来，不静默
  // cause（F02）：'outputLimit' = 这条提示说的是输出被收紧的 max_tokens 截断（渲染端据此给专门的短句）
  | { kind: 'capability'; label: string; notices: string[]; cause?: 'outputLimit' }
  // detail（F03）：这条压缩记录的摘录——覆盖了多少条、因何触发、保留项计数、前后预算（不带摘要正文与用户原话）
  | { kind: 'compacted'; markerId: string; summary: string; detail?: CompactionView }
  | { kind: 'offloaded'; toolUseId: string; relativePath: string }
  // level / clipped（F03）：只在第 2、3 级裁剪时带（被端点拒绝过的槽位才会走到）；第 1 级修剪的事件与以前逐字段相同
  | { kind: 'pruned'; count: number; level?: 2 | 3; clipped?: number }
  // F03：一次超窗事故的恢复说明，每条带全量状态（同一 incident 下 seq 递增，后到的整体替换先到的）。
  // 事故做过动作才发：决定重发（resending）、端点收下了重发的请求（recovered）、换到别的槽位（switched）、失败（failed）；
  // 因超过每次运行的拒绝上限而放弃同槽的（stop: 'runLimit'）一定发
  | { kind: 'contextRecovery'; view: ContextRecoveryView }
  // code（W2a-2 · 设计稿 §3 第 1–3 条）：普通错误不带。contextFull = 超窗且找不到更大窗口，带 relayDraft
  // （新建会话接力用的草稿）；thinkingBinding = Claude 拒绝回放思考块。渲染端按 code 分流，不靠文案判断
  // F01：capability = 链上没有能接这一轮的槽位（不发请求），message 写明原因与出路
  // F02：requestBudget = 请求的固定部分（系统提示 + 工具定义）放不下，带 budget、不带 relayDraft（新建会话接力解决不了）。两个来源：
  //   发送前拒发（budget.status === 'blocked'，一次请求都没发）；端点以超窗拒绝、没有更大窗口可换、且固定开销占满上限（请求发过一次）
  // F02：outputLimit = 这次请求以 max_tokens 截断收尾、正文与工具调用都没有（输出额度在正文之前就用完了，多为推理占用）。
  //   这是截断，不是空响应：不按故障降级、不改绑、不注入空响应提醒；带 outputLimit（这次的 max_tokens 与它为什么是这个数）。
  //   F02b：max_tokens 是模型自己的上限或手动填的最大输出、且链上还有接得住这一轮的槽位时不报这个错，改发 fallback(cause:'outputLimit')；
  //   换过去的槽位都没接住这一轮时仍报这个错（故障、空响应、端点以超窗拒绝、思考块绑定、它自己也把输出用完——取消以外的终态都是），
  //   不带 relayDraft 与 budget——outputLimit 与说明是最先被换下的那个槽位的，说明后面附最后的失败原因
  // F03：recovery = 这次错误之前在同一模型上做过的超窗恢复（contextFull / requestBudget 才可能带；事故没做过动作时不带，
  //   与 F03 之前逐字段相同）
  | { kind: 'error'; message: string; code?: 'contextFull' | 'thinkingBinding' | 'capability' | 'requestBudget' | 'outputLimit'; relayDraft?: string; budget?: RequestBudget; outputLimit?: OutputLimitInfo; recovery?: ContextRecoveryView }
  // W2a-1（设计稿 §3 第 4 条）：压缩失败不打断回合，但必须说出来——旧实现空 catch 吞掉，
  // 用户看着水位贴顶却不知道压缩一直在失败。message 中文在前，请求失败时原始错误附在后面。
  // trigger（F03）：这次压缩因何而发（水位 / 余量不足 / 端点拒绝之后）
  | { kind: 'compactFailed'; reason: CompactFailReason; message: string; trigger?: CompactTrigger };

/** 被 max_tokens 截断时的说明材料（F02；定义在 shared/request-budget.ts，渲染端也要用）。 */
export type { OutputLimitInfo };

/** runtime（F01）：该槽位配置实例的运行时规格。有它时 max_tokens、推理参数、窗口、工具与图片都按它逐槽决定；
 *  没有时（旧调用方与单测）沿用 RunOptions 的 maxTokens / thinkingLevel / contextPolicy.windowOf(modelId)。 */
export interface ProviderSlot { provider: AgentProvider; label: string; runtime?: RuntimeModel }

/** systemPrompt 工厂函数入参（决策点 3 方案 a）：轮内动态重建 stable 段。
 *  sendTools（F01R）：这个槽位这次请求带不带工具定义（= SlotPlan.sendTools）。不带时工厂要换一份不声称工具能力的提示——
 *  工具摘掉了、系统提示却还说「你可以读写文件」「必须调用工具」，模型只会编造工具调用。 */
export interface SystemPromptCtx { modelId: string; sessionId: string; sendTools: boolean }

export interface RunOptions {
  sessionId: string; provider: AgentProvider; tools: ToolRegistry; toolContext: ToolContext;
  /** 系统提示——传 string 时每轮原样用（向后兼容）；传工厂函数时每轮用当前 activeSlot.provider.modelId 调工厂（降级/桥授权当轮生效）。
   *  F02：工厂可以返回 { stable, dynamic } 两段（全文 = 两段以空行相连）；返回 string 的旧工厂照常可用。
   *  同一轮同一槽位工厂只调一次：预算与请求用同一份文本。 */
  systemPrompt: string | ((ctx: SystemPromptCtx) => string | SystemPromptParts);
  /** 任务偏好的输出量（F02，正整数）：这次运行想要的单次输出额度，在模型上限与剩余空间之内生效。 */
  outputPreference?: number;
  /** 每次向一个槽位发请求之前调一次（F02；重试同一请求不重复调），收到的就是写进 max_tokens 的那个预算对象。
   *  回调抛错不影响运行。只在槽位带 runtime 时调。 */
  onRequestBudget?: (b: RequestBudget) => void;
  /** 输出上限——传 number 时全程固定（向后兼容）；传工厂函数时每次 slot 切换按当前 modelId 重算。
   *  必须随 slot 重算的原因：主模型 64K 上限、备胎是只认 16K 的兼容端点时，固定值会让降级请求
   *  连环 400 烧穿整条链（与 systemPrompt 工厂同款问题、同款解法）。 */
  maxTokens?: number | ((ctx: { modelId: string }) => number);
  /** 用户请求的推理档位。带 runtime 的槽位各自按自己的能力钳制 / 映射（F01：降级后不沿用主模型的推理参数）；
   *  没有 runtime 的槽位原样发送（旧行为，调用方自己钳过）。 */
  thinkingLevel?: ThinkingLevel; maxTurns?: number;
  signal?: AbortSignal; retryDelaysMs?: number[];
  fallbackChain?: ProviderSlot[];
  /** 首个 slot 的运行时规格（F01，生产路径由 chat.prompt 按配置实例解析后传入）。 */
  primaryRuntime?: RuntimeModel;
  /** 首个 slot 的显示名（进 fallback 事件的 from）。缺省的 'main' 只是内部占位——
   *  只有带降级链的调用才会发 fallback 事件，所以这类调用必须传真名：Z 波探针实测
   *  任务面板原样显示过「main → 备用(mock-backup)」（教训 §7-2 内部标识符上屏）。 */
  primaryLabel?: string;
  contextPolicy?: ContextPolicy;       // 上下文水位分层决策（Task 4）
  compactEngine?: CompactEngine;       // LLM 压缩摘要（Task 6）
  offloadEngine?: OffloadEngine;       // 大工具结果卸载（Task 5）
  excludedToolNames?: Set<string>;     // 按会话排除的工具（memory_enabled=false 时的记忆工具、会话禁用的 MCP 台）：不列给模型，调用了也不执行（W2a-8）
  /** F04：工具调度器。生产由 index.ts 传入本引擎实例唯一的一个（所有会话共用一张资源锁表）；
   *  不传时用进程级缺省实例——漏接线也不会退化成「每个 run 一把锁」。 */
  scheduler?: ToolScheduler;
  /** F04：工具调用阶段观察口（排队 / 开始 / 审批往返 / 落定）。回调抛错不影响执行。
   *  F05 的账本不从这里接：观察性事件的异常被吞、settled 也不带输出，做不到「意图落不下就不执行」，它走 recorder。 */
  onToolEvent?: (e: SchedulerEvent) => void;
  /** F05：运行记录器。生产由 index.ts 传入；不传时循环不记账，工具段的行为（事件、落库内容、status 的二值口径）与 F04 相同（旧调用方与单测）。 */
  recorder?: RunRecorder;
  /** F03：超窗恢复与压缩的熔断上限。缺省用 RECOVERY_LIMITS；测试与 G01 可收紧。 */
  recoveryLimits?: Partial<RecoveryLimits>;
  /** F07 synchronous admission only at a normal model boundary; observation never retries a request. */
  inputQueue?: {
    admit: (append: (text: string) => { id: string }) => { historyMessageId?: string }[];
    hasPending: () => boolean;
    delivered: (historyIds: ReadonlySet<string>) => void;
  };
}

const DEFAULT_RETRY = [3000, 5000, 10000, 15000, 30000];

/** maxTokens 截断续写次数上限：只追续 2 次，防止「每次都差一点」的模型无限空转烧 token。 */
const MAX_CONTINUATIONS = 2;
/** 续写合成提示：仅追加在请求侧 messages 末尾、绝不落库（与 pairToolResults 同属请求构建边界）。 */
const CONTINUE_HINT = '[系统提示：上一条输出因长度上限被截断，请从截断处继续输出剩余内容，不要重复已输出的部分]';
/** 空响应提醒（文案沿用旧版原文）：tool_result 后模型空手而归时，仅请求侧合成 user 消息催它继续。
 *  绝不落库——落库会污染持久化历史，同步/导出时用户会看到这条机器留言。 */
const EMPTY_RESPONSE_REMINDER = '[系统提醒: 上一次工具调用后你返回了空响应，请继续]';

/** 超窗且没有更大窗口可换时的提示（W2a-2）。不附原始报错：那是一段英文 400 响应体，用户看了也不知道怎么办；
 *  原因与出路才是要说的。原文仍在 ProviderError 里，渲染端将来要展示「详情」可以另加字段。 */
const CONTEXT_FULL_MESSAGE = '上下文已满：当前模型放不下这段对话，可新建会话用摘要接力';
/** 接力草稿总长上限（设计稿 §3 第 2 条）：草稿要填进新会话的输入框，太长的话新会话第一条就又贴近窗口。 */
export const RELAY_DRAFT_MAX = 8000;
/** 草稿里「最后的请求」的上限：摘要是主体，用户的原话只需让新会话接得上。 */
const RELAY_USER_MAX = 2000;

/** 按 UTF-16 码元截到 max 以内，不把代理对切成半个（孤立代理项进了输入框再发出去，严格的 JSON 端会 400）。 */
function clipUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/**
 * 「上下文已满」时给新建会话接力用的草稿（W2a-2 · 设计稿 §3 第 2 条）：库里完整的最新 marker 摘要 + 最后一条真用户消息。
 * 为什么由引擎拼：渲染端手里只有 compacted 事件里截到 200 字的摘要，完整摘要只在库里。
 * 最后一条「真」用户消息：工具结果也以 role=user 落库，超窗常发生在一串工具调用之后，那时最后一条 user 是工具输出。
 * 旧版本写下的「[摘要为空]」marker 不当摘要用（与压缩取材同一判定）。
 * 总长封顶 RELAY_DRAFT_MAX：先保住用户的原话（≤2000），摘要吃剩下的；摘要被截时注明，免得接力方以为那就是全部。
 */
export function buildRelayDraft(
  store: Pick<ChatStore, 'getLatestCompactMarker'>, sessionId: string, history: RawMessage[],
): string {
  const marker = store.getLatestCompactMarker(sessionId);
  // F03：结构化 marker 的摘要后面接上程序记录（用户指示原话、文件变更、调用结果）——草稿里没有「保留的用户原话」段，
  // 用户指示都列在记录里。没有 meta 的 marker 与以前相同
  const summary = marker && !isUselessSummary(marker.summary)
    ? (marker.meta ? `${marker.summary.trim()}\n\n${renderEngineRecord(marker.meta)}` : marker.summary.trim())
    : '';
  let lastUser = '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!isRealUserTurn(m)) continue;
    lastUser = m.parts.filter(p => p.type === 'text').map(p => String(p.value ?? '')).join('\n').trim();
    if (lastUser) break;
  }
  // F03：找不到带文字的用户消息、而最新的用户回合是纯图片时照实说（图片进不了草稿，要在新会话重新添加）
  let lastImage = '';
  if (!lastUser) {
    const latest = [...history].reverse().find(isUserTurn);
    if (latest) lastImage = latest.parts.filter(p => p.type === 'mediaRef').map(p => mediaName(p.value)).join('、');
  }
  const head = '接续上一个会话（上下文已满）。\n\n之前对话的摘要：\n';
  const ask = !lastUser ? (lastImage ? `（最后一条消息是图片：${lastImage}，请在新会话重新添加）` : '（上一会话没有找到用户消息）')
    : lastUser.length > RELAY_USER_MAX ? `${clipUnits(lastUser, RELAY_USER_MAX)}\n…（原话过长，后面的部分已省略）` : lastUser;
  const userPart = `\n\n我最后的请求是：\n${ask}`;
  let summaryPart = summary || '（上一会话还没有生成摘要）';
  const room = RELAY_DRAFT_MAX - head.length - userPart.length;
  if (summaryPart.length > room) {
    const note = '\n…（摘要过长，后面的部分已省略）';
    summaryPart = clipUnits(summaryPart, Math.max(0, room - note.length)) + note;
  }
  return head + summaryPart + userPart;
}

/** 丢弃持久化专属字段，只留 Provider 需要的 {role, parts}（assistant 有推理时再加 reasoningContent）。
 *  逐条映射与 buildEffectiveHistory 共用 toAgentMessage（agent-message.ts）：两处各写一份时，W2a-4 之前一起丢了推理。 */
export function toAgentMessages(history: RawMessage[]): AgentMessage[] {
  return history.map(toAgentMessage);
}

/**
 * 附件请求侧合成：把 user 消息里的 mediaRef part 读文件替换成 imageData（base64）。
 * 与 pairToolResults / CONTINUE_HINT 同属请求构建边界——raw history 与 store 永不改写
 * （落库 base64 会把图片字节冗余进 parts_json，同步/导出全量放大）。
 * 文件缺失/读失败 → 替换为「[附件已丢失: 文件名]」文本 part：静默丢图的话模型会以为自己
 * 看过图并开始基于想象作答，比报缺失危险得多。
 * cache 为 run 级 Map<relativePath, base64|null>：同一附件多轮不重读（长任务几十轮
 * 不能每轮重读 5MB）；缺失也缓存（null），免得丢失附件每轮再撞一次磁盘。
 * headerOnly（F02）：每张图只读文件前 IMAGE_HEADER_BYTES 字节——chat.contextInfo 量尺寸用，结果绝不发给模型。
 * 请求度量只解 base64 的同一段前缀，所以只读文件头与读整张图量出的尺寸相同；缺失文件两种读法给出同一句文字。
 */
function synthesizeImageData(
  messages: AgentMessage[],
  cache: Map<string, string | null>,
  resolveAbs: (relativePath: string) => string,
  headerOnly = false,
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
          try { cache.set(v.relativePath, (headerOnly ? readFileHead(resolveAbs(v.relativePath), IMAGE_HEADER_BYTES) : readFileSync(resolveAbs(v.relativePath))).toString('base64')); }
          catch { cache.set(v.relativePath, null); }
        }
        const b64 = cache.get(v.relativePath);
        return b64 === null
          ? { type: 'text' as const, value: `[附件已丢失: ${basename(v.relativePath)}]` }
          : (headerOnly
            ? { type: 'imageData' as const, value: { mimeType: v.mimeType, base64: b64 } }
            : carryInputOrigin(p, { type: 'imageData', value: { mimeType: v.mimeType, base64: b64 } }));
      }),
    };
  });
}

/** 只读文件的前 max 个字节（文件更短就读到末尾）。读不了照常抛，由调用方按「附件已丢失」处理。 */
function readFileHead(path: string, max: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    let got = 0;
    // readSync 可能一次读不满：读到凑够或到文件末尾为止
    while (got < max) {
      const n = readSync(fd, buf, got, max - got, got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}

/**
 * 把一段有效历史变成请求消息（F01R 抽出；F02 导出，chat.contextInfo 与循环共用同一套组法）。
 * 发送前在 provider 边界配对 tool_use/tool_result（修中断后会话永久损坏），不改存储。
 * 附件同属请求构建边界：先占位（F2b，resolve 之前——旧轮引用不读盘），再 mediaRef → imageData(base64) 就地合成，raw history 不动。
 * headerOnly：每张图只读文件头（量尺寸用，绝不发给模型），见 synthesizeImageData。
 */
export function buildRequestMessages(
  h: AgentMessage[], cache: Map<string, string | null>, resolveAbs: (relativePath: string) => string, opts: { headerOnly?: boolean } = {},
): AgentMessage[] {
  return pairToolResults(synthesizeImageData(placeholderOldMediaRefs(h), cache, resolveAbs, opts.headerOnly === true));
}

/**
 * 空闲时推算「下一次请求」的请求消息（F02，chat.contextInfo 用；循环自己不用，结果绝不发给模型，所以图片只读文件头）。
 * withNext 的最后一条必须是调用方垫的占位用户消息，代表还没发的那一条。循环组消息时两处都把正在发送的这一条算在内：
 * 历史图片只保留最近 KEEP_MEDIA_ROUNDS 轮（placeholderOldMediaRefs），以及「当前轮」带不带图（countImageNeeds）。
 * 推算时少了它，倒数第 2 个用户回合的图片会按整张图计入，而真正发出的请求里它们已是占位文字——条上的已用量偏高，
 * 窗口小时还会挂出一条实际不会发生的「端点可能拒绝」；上一条已答复的带图消息也会被当成当前轮，
 * 不收图片的槽位于是被判成接不了这一轮、整个预算不出。
 * 返回：needs 是带着占位数出的图片数（下一条按不带图算）；messages 已把占位拿掉——下一次请求里除新消息以外的部分。
 */
export function buildPreviewMessages(
  withNext: AgentMessage[], cache: Map<string, string | null>, resolveAbs: (relativePath: string) => string,
): { messages: AgentMessage[]; needs: RequestNeeds } {
  const built = buildRequestMessages(withNext, cache, resolveAbs, { headerOnly: true });
  const needs = countImageNeeds(built);
  const last = built[built.length - 1];
  const placeholder = withNext[withNext.length - 1];
  if (!last || !placeholder) return { messages: built, needs };
  // 占位恒在最后一条消息的末尾：pairToolResults 可能把被中断的工具的占位结果并到了它前面，那些结果在真实请求里也有，留下
  const rest = last.parts.slice(0, last.parts.length - placeholder.parts.length);
  return { messages: rest.length > 0 ? [...built.slice(0, -1), { ...last, parts: rest }] : built.slice(0, -1), needs };
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

/** F01：发给不收图片的槽位时，历史图片（已合成的 imageData）换成说明文字——模型知道那里本有一张图、这次没发给它，
 *  不会以为自己看过。当前轮带图片的情况不会走到这里：那种槽位整轮不接（planSlot.blocked）。
 *  与 placeholderOldMediaRefs 同属请求构建边界：只改请求侧副本，落库的 mediaRef 不动；占位文本恒非空、保序保长。 */
export function placeholderImageData(messages: AgentMessage[], label: string): AgentMessage[] {
  if (!messages.some(m => m.parts.some(p => p.type === 'imageData'))) return messages;
  return messages.map(m => {
    if (!m.parts.some(p => p.type === 'imageData')) return m;
    return { ...m, parts: m.parts.map(p => p.type === 'imageData' ? { type: 'text' as const, value: `[图片未发送：${label} 不支持图片输入]` } : p) };
  });
}

/** F01：发给不支持工具调用的槽位时不带工具定义，历史里的工具调用 / 结果改成文字（与 Gemini 无签名历史的降级同一写法）：
 *  带着 tool_use / tool_result 块却不给工具定义，Anthropic 等端点直接 400。只改请求侧副本，存储不动。
 *  F01R：同一条消息里除第一个文本段外，其余文本段前面加换行——OpenAI 兼容构建器把一条消息的全部文本段直接拼起来
 *  （不管相邻与否），不隔开的话「我来查[历史工具调用] …[历史工具调用] …」粘成一行，模型分不清哪里是一条记录。
 *  保序保长、不合并；Anthropic / Gemini 的独立文本块只多一个前导换行，文本仍非空。 */
export function flattenToolHistory(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(m => {
    if (!m.parts.some(p => p.type === 'toolUse' || p.type === 'toolResult')) return m;
    let seenText = false;
    const parts: ContentPart[] = m.parts.map(p => {
      let out: ContentPart = p;
      if (p.type === 'toolUse') {
        const v = p.value as { name: string; input: string };
        out = { type: 'text', value: `[历史工具调用] ${v.name} 参数: ${v.input || '{}'}` };
      } else if (p.type === 'toolResult') {
        const v = p.value as { output: string; success: boolean };
        out = { type: 'text', value: `[历史工具结果] ${v.success ? '成功' : '失败'}: ${wrapToolOutput(v.output || '（空）')}` };
      }
      if (out.type !== 'text') return out;
      const first = !seenText;
      seenText = true;
      return first ? out : carryInputOrigin(out, { ...out, value: `\n${out.value as string}` });
    });
    return { ...m, parts };
  });
}

/** 按槽位的请求计划改写请求消息（F02 把原来写在降级循环里的两步抽成导出函数，循环、预算与 chat.contextInfo 共用）：
 *  不收图片的槽位把历史图片换成说明文字，不带工具的槽位把工具记录转成文字。只改请求侧副本。 */
export function shapeMessagesForSlot(messages: AgentMessage[], plan: Pick<SlotPlan, 'imagePlaceholder' | 'sendTools'>, label: string): AgentMessage[] {
  let out = messages;
  if (plan.imagePlaceholder) out = placeholderImageData(out, label);
  if (!plan.sendTools) return flattenToolHistory(out);
  return out.map(m => !m.parts.some(p => p.type === 'toolResult') ? m : {
    ...m, parts: m.parts.map(p => {
      if (p.type !== 'toolResult') return p;
      const v = p.value as { toolUseId: string; output: string; success: boolean; status?: string };
      return { ...p, value: { ...v, output: wrapToolOutput(v.output) } };
    }),
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
  observeTimestamp(createdAt: number | undefined): void {
    if (createdAt !== undefined && createdAt > this.last) this.last = createdAt;
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
  const idOf = (p: ContentPart): string => (p.value as { toolUseId: string }).toolUseId;
  // F05：一条 tool_result 只有紧跟在「声明了它的那条 assistant」后面才留下。以前的条件是「这个 id 以前出现过」：
  // 恢复补写的结果消息（时间是恢复时刻）被之后同步合并进来的另一台设备的消息隔开时，它既被保留、占位又补在 assistant 后面，
  // 同一个 id 两份结果、其中一份不跟在带它的 assistant 后面，会话此后每次请求都被服务商拒绝。
  // owner = out 里紧邻的前一条若是 assistant，它声明的 tool_use id；否则 undefined
  let owner: Set<string> | undefined;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') {
      // 剥掉不属于紧邻那条 assistant 的 tool_result（孤儿、被隔开的、别的 assistant 的）；无变化则原样透传
      const own = owner;
      owner = undefined;
      const kept = m.parts.filter(p => p.type !== 'toolResult' || (own !== undefined && own.has(idOf(p))));
      out.push(kept.length === m.parts.length ? m : { role: 'user', parts: kept });
      continue;
    }
    out.push(m);
    const useIds = m.parts.filter(p => p.type === 'toolUse').map(idOf);
    const mine = new Set(useIds);
    owner = mine;
    if (useIds.length === 0) continue;
    // 收集紧随其后的那条 user 消息里已有的 tool_result id
    const next = messages[i + 1];
    const haveIds = new Set<string>();
    if (next && next.role === 'user') {
      for (const p of next.parts) if (p.type === 'toolResult') haveIds.add(idOf(p));
    }
    const missing = useIds.filter(id => !haveIds.has(id));
    // 都有结果：next 交给上面的分支处理（owner 还在，它的结果按归属留下）
    if (missing.length === 0) continue;
    const placeholders: ContentPart[] = missing.map(id => ({
      type: 'toolResult', value: { toolUseId: id, output: '[工具执行被中断，结果未知]', success: false, status: 'cancelled' },
    }));
    if (next && next.role === 'user') {
      // 把占位结果并入下一条 user 消息的最前面（tool_result 需先于其它内容）；并入时同样只留属于这条 assistant 的结果
      out.push({ role: 'user', parts: [...placeholders, ...next.parts.filter(p => p.type !== 'toolResult' || mine.has(idOf(p)))] });
      i++; // 跳过已合并的 next
    } else {
      out.push({ role: 'user', parts: placeholders });
    }
    owner = undefined;
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
  /** 没有 runtime 的槽位（旧调用方）按 modelId 解析输出上限：number 原样（向后兼容），工厂按 modelId 求值。 */
  const resolveMaxTokens = (modelId: string): number =>
    typeof opts.maxTokens === 'function' ? opts.maxTokens({ modelId }) : (opts.maxTokens ?? 4096);
  const requestedThinking: ThinkingLevel = opts.thinkingLevel ?? 'off';
  const clock = new MonotonicClock(store);
  const fallbackChain = opts.fallbackChain ?? [];
  // F04：整个 run 取一次调度器。同批调用的先后、并行与跨会话互斥都由它按资源决定
  const scheduler = opts.scheduler ?? sharedToolScheduler();
  const toolGuard = new ToolLoopGuard();

  // 当前生效的 provider slot：降级成功后切换到 backup，后续 turn 继续用它
  let activeSlot: ProviderSlot = { provider: opts.provider, label: opts.primaryLabel ?? 'main', runtime: opts.primaryRuntime };
  // 降级链指针：从 -1（主 provider）开始，降级时 +1
  let slotIndex = -1;
  let fellBack = false; // 是否发生过降级（用于区分「链耗尽」与「无链」的错误消息）
  // 这次降级是不是因为上下文超窗（W2a-2）：是的话 fallback 事件的 reason 写「上下文已满」并带 cause，发出后复位
  let overflowFallback = false;
  // F02b：这一轮最先因输出额度用完被换下的槽位的截断说明（按输出额度换槽时记下，只记第一个；有槽位给出回答后作废）。
  // 它没有出故障，出路在它身上：之后链上的备用都没接住这一轮时，不管从哪个出口收尾（取消除外），终态错误报的仍是这条说明（见 exhaustedError）
  let outputLimitLeft: { message: string; info: OutputLimitInfo } | undefined;
  // 本轮请求对槽位的要求（F01）：每轮开头组好请求消息后更新一次（先于按能力选槽位与水位判断），降级挑槽位时据此跳过接不了的
  let turnNeeds: RequestNeeds = { currentImages: 0, historyImages: 0 };
  // 已经说过的兼容处理（F01）：工具循环每轮都会重新规划，同一句话只说一次
  const noticed = new Set<string>();

  // ── F02 请求预算（run 级成员）。不变量接在 F01R 的 I1–I3 之后（F03 可依赖）：
  //  I4 发给带 runtime 的槽位的 max_tokens 只来自这次请求的 RequestBudget.output.requested；
  //  I5 水位的两个入参、max_tokens、onRequestBudget 收到的对象来自同一个预算函数（computeSlotBudget）；
  //     本轮没有修剪也没有换槽位时是同一个对象；
  //  I6 status === 'blocked' 的槽位一次请求都不发。
  // 新增的函数全部同步、没有 await，不新增取消点；预算与校准都在这个闭包里，两个会话同时跑互不影响。
  /** 本轮工具定义：按会话排除后排成确定顺序。 */
  let toolDefs: AgentToolDefinition[] = [];
  /** 本轮真正要发的消息 = 请求消息 + 续写提示 / 空响应提醒。 */
  let sendMessages: AgentMessage[] = [];
  /** 本轮原始历史（校准与实测上限用）。 */
  let turnHistory: RawMessage[] = [];
  const turnSystem = new Map<ProviderSlot, Map<boolean, { text: string; parts?: SystemPromptParts }>>();
  /** 每个槽位这一轮的预算；null = 算过、没有预算（计算抛了错）。 */
  const turnBudgets = new Map<ProviderSlot, SlotBudget | null>();
  let budgetWarned = false;
  /** 最近一次发出的请求的预算（落库 usage、截断说明、超窗分支用）。 */
  let sent: SlotBudget | undefined;
  /** 最近一次发出的请求体里带没带可调的推理参数（与 sent 同时更新）。截断说明据此决定提不提「调低推理档位」：
   *  用户选了档位、而请求体里并没有它时，那不是出路——这个槽位没发推理参数（能力未确认、放不下最小预算），
   *  或型号的思考由服务端自适应（构建器不看档位）。 */
  let sentThinking = false;

  // ── F03 同模型超窗恢复（run 级成员）。不变量接在 I1–I6 之后：
  //  I7  端点以超窗拒绝之后到下一次成功的流之间，不追加消息，不调调度器、记录器、权限网关。assistant 消息只在一次成功的流之后落库
  //      ——恢复只修请求构建，绝不重放工具；
  //  I8  同槽重发的请求，其预算（带拒绝上限）不是 over；因此输入估计（共享窗口下再加 max_tokens）比被拒的那次至少小 1,024；
  //  I9  marker 只在摘要完整、解析通过、结构校验通过、提交前复核通过后，与 meta 同一事务写入（compact.ts）；
  //  I10 锚点两侧不拆工具对；锚点之后至少 2 条消息；覆盖区间连续；
  //  I11 保留回合（最近 3 个真用户回合，并上最近 3 个含纯图片的用户回合）要么在锚点之后的原文里，要么随摘要消息带原话全文，
  //      其中最新一条的图片也带上（buildEffectiveHistory 按传入的历史保证，不依赖 marker 有没有 meta）；
  //  I12 程序记录只来自落库的消息；
  //  I13 全部重试都有次数、花费、无进展三种熔断（RECOVERY_LIMITS）：每次事故同槽重发 ≤ 2、每次运行处理的拒绝 ≤ 6、
  //      成功的压缩 ≤ 3、摘要请求 ≤ 5、摘要花费 ≤ 40 万；预算仍是 over 不重发，摘完之后的下限仍放不下不发摘要请求。
  // 恢复的重入点只有「回到轮首」：被拒后带着学到的上限重走同一条请求构建路径，预算、max_tokens、回调对象仍出自同一次计算（I4–I6 不变）。
  const LIMITS: RecoveryLimits = { ...RECOVERY_LIMITS, ...opts.recoveryLimits };
  /** 各槽位本次运行被端点拒绝后学到的上限（只降不升，留到运行结束；不跨运行保留）。一变就要清本轮预算缓存。 */
  const ceilings = new Map<ProviderSlot, RejectionCeiling>();
  /** 本次运行处理过的超窗拒绝次数。 */
  let runRejections = 0;
  /** 本次运行发出的摘要请求数与累计花费（每个请求计「取材的本机估算 + max_tokens」，成功与失败都算）。 */
  let summaryRequests = 0; let summarySpend = 0;
  /** 打开着的超窗事故：从端点拒绝到流成功（或换槽、失败）为止。acted：做过改动请求的动作、发过摘要请求或决定过重发——决定发不发恢复说明。 */
  let incident: {
    id: number; seq: number; slot: ProviderSlot; rejections: number; resends: number;
    before: BudgetBrief; actions: RecoveryAction[]; acted: boolean;
  } | undefined;
  let incidentSeq = 0;
  /** 最近一次被端点以超窗拒绝的请求（固定开销的判定与说明用）。 */
  let lastRejected: SlotBudget | undefined;
  // 轮级，每轮开头复位：
  /** 本轮做到了第几级裁剪（只由 applyTrim 置位；F02 自己的第 1 级修剪不动它）。 */
  let turnTrim: 0 | TrimLevel = 0;
  /** 本轮请求里已被桩或头尾替换的工具结果条数。 */
  let trimmed = 0;
  /** 轮首时有没有待注入的空响应提醒（回轮首重走时要还原）。 */
  let turnHadReminder = false;
  /** 降级循环里决定「回轮首重走这一轮」（端点以超窗拒绝、或故障换槽后新槽位需要先减压）。 */
  let redoTurn = false;

  /** 工具分类（陈述核对、程序记录、裁剪说明句共用）：按注册表的调度声明；没注册、没声明的按有副作用。 */
  const toolKindOf: ToolKindOf = name => {
    const s = opts.tools.get(name)?.scheduling;
    return !s ? 'effect' : s.readOnly ? 'read' : s.sideEffects === 'local-files' ? 'write' : 'effect';
  };
  const summaryAllowance = (): boolean => summaryRequests < LIMITS.summaryRequestsPerRun && summarySpend < LIMITS.summarySpendTokens;
  /** 每个摘要请求发出前记账；额度用完返回 false（summarize 不发，按 'budget' 失败）。
   *  花费按未校准的取材量记（rawInput），不按校准后的输入估计：40 万的上限是按「3 次满额摘要，各 100,000 取材加 16,384 输出」定的，
   *  取材上限本身就是未校准口径。按校准后的数记的话，校准系数 1.2 以上的配置上第 3 次水位压缩会被花费上限挡下——
   *  收紧了原有的「每次运行 3 次压缩」，还多出一条没有发出请求的压缩失败。 */
  const onSummaryRequest = (r: { rawInput: number; maxTokens: number }): boolean => {
    const cost = r.rawInput + r.maxTokens;
    if (summaryRequests >= LIMITS.summaryRequestsPerRun || summarySpend + cost > LIMITS.summarySpendTokens) return false;
    summaryRequests++; summarySpend += cost;
    return true;
  };
  /** 打开着的事故此刻的全量状态。 */
  const viewOf = (phase: ContextRecoveryView['phase'], extra: Partial<Pick<ContextRecoveryView, 'after' | 'stop' | 'switchedTo'>> = {}): ContextRecoveryView => {
    const inc = incident!;
    return {
      v: 1, incident: inc.id, seq: ++inc.seq,
      slot: { label: inc.slot.label, modelId: inc.slot.runtime?.modelId ?? inc.slot.provider.modelId },
      phase, rejections: inc.rejections, resends: inc.resends, runRejections,
      before: inc.before, actions: [...inc.actions],
      limits: { resendsPerIncident: LIMITS.resendsPerIncident, rejectionsPerRun: LIMITS.rejectionsPerRun },
      ...extra,
    };
  };

  /** 槽位的请求计划（F01）：有 runtime 按配置实例解析的规格逐槽决定；没有的沿用旧参数（不钳推理、工具与图片照发）。
   *  maxTokens（F02）：这次请求按预算定下的 max_tokens，给了就按它重算推理预算。
   *  spaceLimited（F02）：这个 max_tokens 是被上下文剩余空间收紧的（不是偏好）——推理预算要给可见输出留底。 */
  function planOf(slot: ProviderSlot, maxTokens?: number, spaceLimited = false): SlotPlan {
    if (slot.runtime) return planSlot(slot.runtime, requestedThinking, turnNeeds, slot.label, maxTokens, { spaceLimited });
    return { maxTokens: resolveMaxTokens(slot.provider.modelId), thinking: { level: requestedThinking }, sendTools: true, imagePlaceholder: false, notices: [] };
  }

  /** 这个槽位这一轮的系统提示。同一轮同一（槽位, 带不带工具）工厂只调一次：预算与请求用同一份文本。
   *  工厂按当前槽位的 modelId 调（降级 / 桥授权当轮生效）；传 string 时原样透传。工厂抛错照旧向外抛。 */
  function systemOf(slot: ProviderSlot, sendTools: boolean): { text: string; parts?: SystemPromptParts } {
    let perSlot = turnSystem.get(slot);
    if (!perSlot) { perSlot = new Map(); turnSystem.set(slot, perSlot); }
    const hit = perSlot.get(sendTools);
    if (hit) return hit;
    let out: { text: string; parts?: SystemPromptParts };
    if (typeof opts.systemPrompt === 'function') {
      const made = opts.systemPrompt({ modelId: slot.provider.modelId, sessionId: opts.sessionId, sendTools });
      out = typeof made === 'string' ? { text: made } : { text: joinSystemPrompt(made), parts: made };
    } else {
      out = { text: opts.systemPrompt };
    }
    perSlot.set(sendTools, out);
    return out;
  }

  /** 把续写提示与空响应提醒追加到一份新数组上（都只出现在请求里、绝不落库）。不改任何标志，不改入参。 */
  const withHints = (base: AgentMessage[]): AgentMessage[] => [
    ...base,
    // 上一轮 maxTokens 截断：让模型从截断处继续
    ...(continueCount > 0 ? [{ role: 'user' as const, parts: [{ type: 'text' as const, value: CONTINUE_HINT }] }] : []),
    // 上一轮 tool_result 后模型空手而归：催它继续
    ...(pendingEmptyReminder ? [{ role: 'user' as const, parts: [{ type: 'text' as const, value: EMPTY_RESPONSE_REMINDER }] }] : []),
    ...toolGuard.hints().map(value => ({ role: 'user' as const, parts: [{ type: 'text' as const, value }] })),
  ];

  /** 这个槽位发 sendMessages 时的预算。没有 runtime → undefined（旧路径），此时不调系统提示工厂。
   *  预算计算抛错时这个槽位本轮按旧口径发送（max_tokens 用模型上限，水位用旧估算），整个运行只警告一次——
   *  预算是附加检查，不该让本来能发的回合失败。系统提示工厂的异常不吞。
   *  probe（F02b）：给了就按这份请求消息试算，不读也不写本轮缓存——按输出额度换槽之前，要按回到轮首时会发的消息量候选槽位。
   *  F03：这个槽位本次运行被端点拒绝过时带上学到的上限（probe 试算同样带）。o.plain 为真时不带上限、不读不写本轮缓存：
   *  只给 fixedCostProven 用——「固定开销占满」的结论只按资料上限下。 */
  function budgetOf(slot: ProviderSlot, probe?: AgentMessage[], o: { plain?: boolean; shaped?: boolean } = {}): SlotBudget | undefined {
    if (!slot.runtime) return undefined;
    const cached = !probe && o.plain !== true;
    if (cached && turnBudgets.has(slot)) return turnBudgets.get(slot) ?? undefined;
    const ceiling = o.plain === true ? undefined : ceilings.get(slot);
    // 能力先定：带不带工具、历史图片是否占位、按模型上限算的推理预算
    const plan0 = planOf(slot);
    const sys = systemOf(slot, plan0.sendTools);
    let sb: SlotBudget | undefined;
    try {
      sb = computeSlotBudget({
        rt: slot.runtime, label: slot.label,
        messages: o.shaped ? probe! : shapeMessagesForSlot(probe ?? sendMessages, plan0, slot.label),
        system: sys, tools: plan0.sendTools ? toolDefs : [], history: turnHistory,
        ...(plan0.thinking.level !== 'off' && plan0.thinking.budgetTokens !== undefined ? { thinkingBudget: plan0.thinking.budgetTokens } : {}),
        ...(opts.outputPreference !== undefined ? { taskPreference: opts.outputPreference } : {}),
        ...(ceiling ? { ceiling } : {}),
      });
    } catch (e) {
      if (!budgetWarned) { budgetWarned = true; console.warn('[F02] 请求预算计算失败，本次运行按旧口径发送', e); }
    }
    if (cached) turnBudgets.set(slot, sb ?? null);
    return sb;
  }

  /**
   * 固定开销（系统提示 + 工具定义）自己就占满了输入上限：这个结论只按资料上限下，不按学到的上限下（F03）。
   * 预算不带拒绝上限时就是它自己；带的话用同一份请求不带上限重算。学到的上限多半来自步长猜测，窗口没有资料时更没有可比的硬数字——
   * 拿它断言「系统提示与工具定义已占满上限」会把用户引去停用 MCP 服务器，而真正的出路是压缩或接力。
   * 返回下结论所依据的预算（错误事件带的 budget 与说明里的数字都出自它）；不成立返回 undefined。
   */
  function fixedCostProven(sb: SlotBudget): RequestBudget | undefined {
    const b = sb.budget.limits.rejectedAt === undefined ? sb.budget : budgetOf(activeSlot, sb.request.messages, { plain: true, shaped: true })?.budget;
    return b && fixedCostDominates(b) ? b : undefined;
  }

  /** 这个槽位接不了这一轮的原因：能力不符（F01）或请求的固定部分放不下（F02）。两种都是一次请求不发就跳过。 */
  function blockOf(slot: ProviderSlot): { reason: string; cause: 'capability' | 'requestBudget'; budget?: RequestBudget } | undefined {
    const blocked = planOf(slot).blocked;
    if (blocked) return { reason: blocked, cause: 'capability' };
    const sb = budgetOf(slot);
    if (sb?.budget.status === 'blocked') {
      return { reason: `${slot.label} 放不下这次请求的固定部分（${sb.budget.reason}）`, cause: 'requestBudget', budget: sb.budget };
    }
    return undefined;
  }

  /** 槽位窗口：runtime 的窗口（实例手动 > 端点记录 > 汇总 > 内置；都没有按 128K）；旧调用方按 modelId 查 contextPolicy。 */
  function windowOfSlot(slot: ProviderSlot): number {
    if (slot.runtime) return slot.runtime.limits.contextWindow.value ?? FALLBACK_WINDOW;
    return opts.contextPolicy?.windowOf(slot.provider.modelId) ?? FALLBACK_WINDOW;
  }

  /**
   * 超窗时找接手的槽位：链上第一个窗口比当前槽位**更大**的（W2a-2）。窗口相同或更小的直接跳过、不发请求——
   * 旧实现按顺序挨个降级，同样大的窗口必然再回一次超窗 400，白花一次请求的钱和时间。
   * 没有 contextPolicy 时各槽位窗口视为相同（不知道谁大就不赌），结果只会是「上下文已满」。
   * F01：接不了这一轮的槽位（不输出文本、本轮带图而它不收图片）也跳过。F02：固定开销放不下的同样跳过。
   * 返回链下标，找不到返回 -1。
   */
  function findLargerWindowSlot(): number {
    if (!opts.contextPolicy) return -1;
    const curWin = windowOfSlot(activeSlot);
    for (let i = slotIndex + 1; i < fallbackChain.length; i++) {
      if (!blockOf(fallbackChain[i]) && windowOfSlot(fallbackChain[i]) > curWin) return i;
    }
    return -1;
  }

  /** 从当前 slotIndex 往后找下一个接得住这一轮的 slot（F01）：接不了的不发请求，说明原因后跳过。 */
  function* nextCompatibleSlot(): Generator<LoopEvent, ProviderSlot | undefined> {
    while (true) {
      slotIndex++;
      if (slotIndex >= fallbackChain.length) return undefined;
      const slot = fallbackChain[slotIndex];
      const b = blockOf(slot);
      if (!b) return slot;
      yield { kind: 'capability', label: slot.label, notices: [`已跳过：${b.reason}`] };
    }
  }

  /**
   * 按能力选槽位（F01R）：把 activeSlot 换成接得住本轮（turnNeeds）的槽位。
   * 接得住 → true，不发事件；接不了 → 沿链找（跳过的逐个说明），找到则发 fallback(cause:'capability')；
   * 整条链都接不了 → 发 error(code:'capability')，返回 false（一次请求都不发）。同步、没有 await，不新增取消点。
   * 每轮在水位判断之前调用：水位、压缩预算与摘要请求必须按接手这一轮的槽位算，不能按被跳过的那个。
   * F02：「接不了」多一种原因——请求的固定部分（系统提示 + 工具定义）连估算下界都放不下它的输入上限（budget.status === 'blocked'）。
   * 处理方式相同：链上有放得下的就换过去（fallback 的 cause 是 'requestBudget'），整条链都放不下就报 requestBudget 错误。
   */
  function* ensureCapableSlot(): Generator<LoopEvent, boolean> {
    const b = blockOf(activeSlot);
    if (!b) return true;
    const from = activeSlot.label;
    const nextSlot = yield* nextCompatibleSlot();
    if (!nextSlot) {
      // F02b：这一轮按输出额度换下过槽位、还没有槽位给出回答，而换过去的槽位回到轮首时接不了了（系统提示与工具表每轮重新求值）：
      // 报被换下槽位的截断说明并附上这里的原因。下面两句的「本轮没有发送给任何模型」这时不成立——这一轮发给过被换下的槽位
      if (outputLimitLeft) { yield exhaustedError(b.reason); return false; }
      if (b.cause === 'requestBudget') {
        // 压缩与接力都减不掉固定开销：不给接力草稿，出路写在说明里
        yield { kind: 'error', code: 'requestBudget', ...(b.budget ? { budget: b.budget } : {}), message: `${b.reason}。${FIXED_COST_ADVICE}。本轮没有发送给任何模型` };
      } else {
        yield { kind: 'error', code: 'capability', message: `${b.reason}；模型组里也没有能接这一轮的备选模型，本轮没有发送给任何模型。可以移除图片后重发，或在设置中换用支持该能力的模型` };
      }
      return false;
    }
    yield { kind: 'fallback', from, to: nextSlot.label, reason: b.reason, cause: b.cause };
    // 不置 fellBack：被跳过的槽位没有失败。接手的槽位随后若失败且链已用尽，报它自己的原始错误（比如密钥无效），
    // 而不是一句「所有模型均不可用」把真正的原因盖住
    activeSlot = nextSlot;
    return true;
  }

  /**
   * 链上再没有槽位接这一轮时的终态错误。plain 是各出口原来报的那句；detail 是最后一个槽位自己的失败原因（缺省与 plain 相同）。
   * F02b：这一轮曾因输出额度用完换下过某个槽位、之后还没有槽位给出回答时，报它的截断说明并附上 detail——那个槽位没有坏，只是输出被截断，
   * 调低推理档位 / 调高最大输出这些出路都在它身上；会话也没有改绑（这一轮没有跑通），下一条消息仍从会话绑定的模型组开头给起
   *（它是组里首成员时就是先给它）。只报「所有模型均不可用」或备用自己的报错，那句说明就只剩在中途的换槽提示里。
   * outputLimitLeft 有值时，取消以外的终态出口都报这一条（各出口原来带的 code、接力草稿、budget 都不带）：故障降级用尽、重试用尽、
   * 空响应用尽；端点以超窗拒绝且没有更大的窗口（不报「上下文已满」、不给接力草稿——被换下的槽位窗口多半还空着，新建会话接力
   * 解决不了它的输出上限）；固定开销占满；思考块绑定；回到轮首时接不了这一轮；接手的槽位自己也把输出用完（它那句说明作 detail）。
   * 取消不在其列：那是用户的动作，照旧报「已取消」。
   */
  const exhaustedError = (plain: string, detail: string = plain): LoopEvent => outputLimitLeft
    ? {
      kind: 'error', code: 'outputLimit', outputLimit: outputLimitLeft.info,
      message: `${outputLimitLeft.message}。随后换用的备用模型也没有给出回答（最后的错误：${detail}）`,
    }
    : { kind: 'error', message: plain };

  /**
   * 放弃在当前槽位上恢复这次超窗事故（F03）：有窗口更大的槽位就换过去（返回 'redo'，调用方回轮首按新槽位重走——
   * 为小窗口裁过的请求不会发给大窗口，水位按新槽位判）；没有就结束这次运行（返回 'ended'）：固定开销占满报 requestBudget，
   * 否则报 contextFull 并给接力草稿。error 的 code、message、relayDraft、budget 与 F03 之前逐字段相同。
   * 恢复说明：事故做过动作才发（contextRecovery 事件，error 上另带 recovery）；什么都减不了的事故保持静默，事件序列与以前相同。
   * 两种情形不看做没做过动作、一定说明：
   *  - 因超过每次运行的拒绝上限而放弃的（runLimit）——那以此前已经恢复过若干次为前提；
   *  - 这次事故里压缩是被本次运行的熔断挡下的（压缩次数、摘要请求次数、摘要花费用完，或压缩此前失败过已停用）——
   *    同样以此前压缩过或试过为前提，这次不是「没有可减的」而是「不让再减了」。
   * 这两种，用户看到的不能只是一句「上下文已满」：要说明停在哪一条熔断。
   */
  function* abandonSameSlot(stop: RecoveryStop): Generator<LoopEvent, 'ended' | 'redo'> {
    const fused = incident !== undefined
      && incident.actions.some(a => a.kind === 'compact' && a.result === 'skipped' && COMPACT_FUSE_REASONS.has(a.reason));
    const explain = incident !== undefined && (incident.acted || stop === 'runLimit' || fused);
    const target = findLargerWindowSlot();
    let next: ProviderSlot | undefined;
    // 指针停在目标前一格，nextCompatibleSlot 自增后正好取到目标；中间窗口不更大的槽位一次不请求
    if (target >= 0) { slotIndex = target - 1; next = yield* nextCompatibleSlot(); }
    if (!next) {
      const view = explain ? viewOf('failed', { stop }) : undefined;
      if (view) yield { kind: 'contextRecovery', view };
      const fc = lastRejected ? fixedCostProven(lastRejected) : undefined;
      incident = undefined;
      if (fc) {
        yield { kind: 'error', code: 'requestBudget', budget: fc, message: fixedCostMessage(activeSlot.label, fc), ...(view ? { recovery: view } : {}) };
      } else {
        yield { kind: 'error', code: 'contextFull', message: CONTEXT_FULL_MESSAGE, relayDraft: buildRelayDraft(store, opts.sessionId, turnHistory), ...(view ? { recovery: view } : {}) };
      }
      return 'ended';
    }
    if (explain) yield { kind: 'contextRecovery', view: viewOf('switched', { stop, switchedTo: next.label }) };
    yield { kind: 'fallback', from: activeSlot.label, to: next.label, reason: '上下文已满', cause: 'contextOverflow' };
    fellBack = true; activeSlot = next; incident = undefined;
    return 'redo';
  }

  let hadToolCallInPrevTurn = false; // 上一轮是否有工具调用（用于空响应两路处理判定）
  let remindedEmptyResponse = false; // 本循环是否已提醒过一次空响应（判重；替代旧的「查历史文本」法）
  let pendingEmptyReminder = false; // 下一轮请求是否要注入仅请求侧的空响应提醒（注入一次即清）
  let compactCount = 0; // 本循环已压缩次数（上限 3，设计 §4.2）
  // 本次运行是否已停用压缩（W2a-1）：失败一次就不再试。旧实现失败后 compactCount 不涨，
  // 带工具调用的长任务每一轮都再打一次必败的付费请求；停用后水位继续涨会走到溢出路径（W2a-2 给出路）。
  let compactDisabled = false;
  let continueCount = 0; // 本循环已注入的 maxTokens 续写次数（上限 MAX_CONTINUATIONS，防无限空转）

  // 附件 base64 的 run 级缓存（见 synthesizeImageData）：整个循环内同一附件只读一次盘。
  // 解析基准取 attachments 桶 + basename：mediaRef.relativePath 正常是 attachments/<file>，
  // basename 兜底保证任何形态的 relativePath 都逃不出桶（与 chat.prompt 校验正则双保险）。
  const attCache = new Map<string, string | null>();
  const attDir = opts.toolContext.paths.sessionBucket(opts.sessionId, 'attachments');

  /** 把一段有效历史变成请求消息（F01R 抽出：按能力选槽位要在水位判断之前就知道本轮带不带图）。组法见 buildRequestMessages。 */
  const buildMessages = (h: AgentMessage[]): AgentMessage[] =>
    buildRequestMessages(h, attCache, rel => join(attDir, basename(rel)));

  /**
   * F1：取消短路点共用的收尾——把流式中途已展示给用户的半截文本落库，再报「已取消」。
   * 不落的话屏幕上有、历史里没有：下轮提问模型看不到自己说过的半截话。
   * 红线与取舍：
   *  - text 为空（取消发生在任何 textDelta 之前）→ 什么都不落。「空 assistant 回合绝不落库」
   *    与主路径同级红线：Anthropic 拒收 content 为空的消息，落了会让会话后续每次请求都 400。
   *  - 只落 text part：calls 里已解析的 toolCallComplete 一律丢弃——落库 tool_use 而无配对
   *    tool_result 等于主动制造 pairToolResults 要修的那种孤儿，Anthropic 同样每次 400 变砖。
   *    thinking 块同理不落（历史 thinking 块只在回放时被引用，丢掉永远安全）；
   *    已累积的半截思考走 reasoningContent，有值就带上（W2a-4 起 deepseek-v4 族会把它原样回放，
   *    别的模型仍只展示；半截推理配半截正文，与这条消息本身一致）；tokenUsage 有就带。
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
        // F02：只盖 v 与来源，不带估计与费用——半截回复不当校准样本，也不估费用（服务商报了输入的，仍可计入实测上限）
        reasoningContent: reasoning || undefined, tokenUsage: finalizeUsage(usage, usageSourceOf(activeSlot)),
      });
      yield { kind: 'messagePersisted', messageId: m.id };
    }
    yield { kind: 'error', message: '已取消' };
  }

  let normalInputBoundary = true;
  // Independent of F03 incident: fallback may clear the incident before a successful stream.
  let deferInputAfterContextReject = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    // F1 侦察结论：此处不接半截落库——text 在流循环内累积、turn 头尚未开流，本轮恒空；
    // 能 continue 回到这里的路径（压缩/空响应两路/maxTokens 续写）里，非空文本要么早已
    // 正常落库（续写路径在上一轮就 persist 过），要么本就为空（空响应路径的定义）。
    if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
    clock.observeTimestamp(store.getMaxMessageCreatedAt(opts.sessionId));
    if (opts.inputQueue && normalInputBoundary && !deferInputAfterContextReject) {
      normalInputBoundary = false;
      const admitted = opts.inputQueue.admit(text => store.appendMessage({
        id: store.newId(), sessionId: opts.sessionId, role: 'user', parts: [{ type: 'text', value: text }],
        createdAt: clock.next(), streamInterruptCount: 0,
      }));
      if (admitted.length) continueCount = 0;
      for (const input of admitted) if (input.historyMessageId) yield { kind: 'messagePersisted', messageId: input.historyMessageId };
      if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return; }
    }
    normalInputBoundary = false;
    const history = store.listMessages(opts.sessionId);
    clock.observe(history);

    // 推理时合成 effectiveAgentHistory（设计 §4.2「推理时合成」）
    // raw history 永不改写；effectiveHistory 是水位估算与请求构建的唯一输入。
    // 用 let：offload 档修剪后要就地换成修剪版历史（只影响本轮请求）。
    const curMarker = opts.compactEngine ? store.getLatestCompactMarker(opts.sessionId) : undefined;
    let effectiveHistory = opts.compactEngine
      ? opts.compactEngine.buildEffectiveHistory(history, curMarker)
      : toAgentMessages(history);

    // F01R：先定「谁接这一轮」，再判水位。每轮的顺序是不变量：
    //  I1 进入水位判断之前，activeSlot 已是接得住本轮的槽位；
    //  I2 turnNeeds 只在每轮开头更新一次，先于按能力选槽位与水位判断（修剪只改工具结果文本，图片数与「当前轮」的位置都不变；
    //     续写/提醒那两条合成 user 消息不是用户的提问，在数完之后才追加）；
    //  I3 水位、压缩预算、摘要请求只读 activeSlot。
    // 旧顺序是先按首槽位判水位、发摘要，进了降级循环才换槽：首槽位接不了本轮（带图而它不收图）时，
    // 按它的大窗口判为不压缩 → 整段历史发给小窗口的接手槽位 → 超窗；或反过来把付费的摘要请求发给本轮并不接手的槽位。
    // 压缩成功后 continue 回到这里会重算：此时 activeSlot 已是接手的槽位，不再发事件——capability 的 fallback 每次运行至多一条
    let turnMessages = buildMessages(effectiveHistory);
    turnNeeds = countImageNeeds(turnMessages);
    // F02：本轮预算要用的材料。提示是在数完图片之后追加的（I2）；工具定义按会话排除后排成确定顺序
    turnHistory = history; turnSystem.clear(); turnBudgets.clear();
    sendMessages = withHints(turnMessages);
    // F03：轮级状态复位。turnHadReminder 记的是清标志之前的值——这一轮若因超窗或换槽回轮首重走，提醒不能丢
    turnTrim = 0; trimmed = 0; redoTurn = false; turnHadReminder = pendingEmptyReminder;
    const allToolDefs = opts.tools.definitions();
    toolDefs = orderToolDefinitions(opts.excludedToolNames ? allToolDefs.filter(t => !opts.excludedToolNames!.has(t.name)) : allToolDefs);
    if (!(yield* ensureCapableSlot())) return;

    // 上下文水位检查 + 减压（设计 §4.2「上下文水位检查」+「压缩」段；F02 改了喂进去的两个数与修剪、压缩的先后）
    // 关键：水位基于 effectiveHistory，不是 raw history——
    //   压缩写 marker 后 effectiveHistory 变小、水位自然下降，不会出现
    //   「存储不改写 → 水位永不降 → 每次都重复压缩到 3 次上限」的缺陷。
    // 每次运行 3 次的上限只拦压缩那一步（见 ②），修剪不受它限制：修剪是本地操作、不花钱。以前这个上限写在外层条件里，
    // 满 3 次后连修剪也一起停——32K–64K 窗口只有修剪这一档减压手段，长工具任务从此每轮净增一条完整的工具结果，几轮就超窗
    if (opts.contextPolicy && opts.compactEngine) {
      const policy = opts.contextPolicy; const engine = opts.compactEngine;
      // F03：轮首按能力换过槽位的，打开着的事故作废（它是别的槽位的）
      if (incident && incident.slot !== activeSlot) incident = undefined;
      /** 未修剪的有效历史：applyTrim 每一级都对它做，不叠加上一级的结果（说明里的原长才是真实原长）。 */
      const base = effectiveHistory;
      /** 修剪：offload 档是比压缩更便宜的减压手段——把旧的大工具结果换成单行桩，让本轮请求变小。
       *  只发生在请求侧合成数组上，raw history 与存储永不改写（与 compact 的「推理时合成」同一哲学）——
       *  否则修剪成了持久化行为，模型永远拿不回原文。修剪过则预算作废重算。 */
      const pruneTurn = function* (): Generator<LoopEvent> {
        const { pruned, history: prunedHistory } = pruneOldToolResults(effectiveHistory);
        if (pruned > 0) {
          yield { kind: 'pruned', count: pruned };
          effectiveHistory = prunedHistory;
          // 请求消息跟着换成修剪版（附件有 run 级缓存，不重读盘）
          turnMessages = buildMessages(effectiveHistory);
          sendMessages = withHints(turnMessages);
          turnBudgets.clear();
          trimmed = pruned; // F03：供 applyTrim 判断更高一级有没有多裁出东西
        }
      };
      /** 余量不足触发的压缩值不值得发：看 summarize 这一次真能从请求里摘走多少——它会取材的那段消息（旧锚点之后到规则锚点）
       *  按此刻在请求里的样子（已修剪）估算，不足 COMPACT_MIN_GAIN 就不发付费的摘要请求。
       *  compactWorthwhile 看的是整个请求的可压部分，而其中最近那十几条压缩并不会动：窗口 32K–64K 的单回合长工具任务里，
       *  撑满窗口的正是最近几条大结果，更早的已经修剪成桩——不加这道门槛，每一轮都为新增的两条消息发一次摘要，
       *  三轮就把每次运行 3 次的额度用完，请求却几乎没变小。
       *  没有新增可摘时照旧交给 summarize：它自己返回 undefined、不发请求。
       *  F03：rule 传给 pendingSummaryRange；可摘的那段里扣掉摘完之后仍按原话带上的用户回合（它们不会因为压缩而离开请求）。 */
      const reliefCompactPays = (rule: AnchorRule = 'standard'): boolean => {
        const rt = activeSlot.runtime;
        if (!rt) return true;
        const range = pendingSummaryRange(history, curMarker, rule);
        if (!range) return true;
        // effectiveHistory 的尾部与 history 的尾部逐条对应（修剪保序保长）；有 marker 时最前面多一条摘要占位，不算在可摘里
        const shift = effectiveHistory.length - history.length;
        const from = Math.max(curMarker ? 1 : 0, range.from + shift);
        const carried = new Set(carriedUserTurns(history, range.to));
        const part = effectiveHistory.slice(from, range.to + shift + 1).filter((_, k) => !carried.has(from + k - shift));
        try {
          // 图片不在这里合成：能摘走的旧轮图片在请求里本来就是占位文字；与预算同一把尺（协议构建器 + 校准系数）
          return measureMessages(rt, shapeMessagesForSlot(pairToolResults(part), planOf(activeSlot), activeSlot.label), history) >= COMPACT_MIN_GAIN;
        } catch { return false; } // 量不出来就不为它发付费请求：这一轮已经修剪过
      };

      // ── F03 恢复阶梯的轮内闭包。同一把尺：带拒绝上限的预算（算不出预算按 over）──
      const statusNow = (): RequestBudget['status'] => budgetOf(activeSlot)?.budget.status ?? 'over';
      const relief = (): boolean => { const s = statusNow(); return s === 'tight' || s === 'over'; };
      const over = (): boolean => statusNow() === 'over';
      const capacityNow = (): number => budgetOf(activeSlot)?.budget.limits.inputLimit ?? windowOfSlot(activeSlot);
      /** 第 level 级裁剪（只改本轮请求）。比已经裁掉的多裁出东西才换，并说出来。 */
      const applyTrim = function* (level: TrimLevel): Generator<LoopEvent> {
        const r = trimForRequest(base, level, toolKindOf);
        if (r.pruned + r.clipped <= trimmed) return;
        yield level === 1 ? { kind: 'pruned', count: r.pruned } : { kind: 'pruned', count: r.pruned, level, clipped: r.clipped };
        effectiveHistory = r.history;
        turnMessages = buildMessages(effectiveHistory);
        sendMessages = withHints(turnMessages);
        turnBudgets.clear();
        turnTrim = level; trimmed = r.pruned + r.clipped;
        if (incident) { incident.actions.push({ kind: 'trim', level, pruned: r.pruned, clipped: r.clipped }); incident.acted = true; }
      };
      /** 压缩这一步的无进展熔断：先试算「按这个锚点摘完之后最小能有多大」（摘要按空串、程序记录现算、锚点之后的原文按第 3 级裁剪），
       *  下限仍放不下就不发付费的摘要请求。真实的摘要只会比空串长、因输入预算后退时锚点只会更早，所以下限放不下，这次摘要必然白花；
       *  下限放得下不保证摘完一定放得下，那由摘完之后回轮首的重判兜住（次数受 I13 约束）。算不出预算时不拦。 */
      const fitsAfter = (rule: AnchorRule): boolean => {
        const range = pendingSummaryRange(history, curMarker, rule);
        if (!range) return false;
        const head = previewSummaryMessage(history, range.to, curMarker, toolKindOf);
        const tail = history.slice(range.to + 1).map(toAgentMessage);
        const sb = budgetOf(activeSlot, withHints(buildMessages(trimForRequest([head, ...tail], 3, toolKindOf).history)));
        return sb === undefined || sb.budget.status !== 'over';
      };
      /** 这一步的压缩发不发。不发时记下原因（动作只在有打开的事故时记，事故外只有事件）。 */
      const canCompact = (rule: AnchorRule): boolean => {
        const reason = compactDisabled ? 'disabled'
          : compactCount >= LIMITS.compactionsPerRun ? 'limit'
          : summaryRequests >= LIMITS.summaryRequestsPerRun ? 'requests'
          : summarySpend >= LIMITS.summarySpendTokens ? 'spendCap'
          : !pendingSummaryRange(history, curMarker, rule) ? 'nothingToSummarize'
          : !reliefCompactPays(rule) ? 'tooSmall'
          : over() && !fitsAfter(rule) ? 'wontFit'
          : undefined;
        if (reason !== undefined && incident) incident.actions.push({ kind: 'compact', result: 'skipped', reason });
        return reason === undefined;
      };
      /** 给定摘要请求正文，按当前槽位算这次请求的预算：与主请求同一把尺（协议构建器、校准系数、端点拒绝过的上限）。 */
      const summaryFit = (text: string): SummaryFit => {
        const ceiling = ceilings.get(activeSlot);
        const b = computeSlotBudget({
          rt: activeSlot.runtime!, label: activeSlot.label,
          messages: [{ role: 'user', parts: [{ type: 'text', value: text }] }],
          system: { text: SUMMARY_SYSTEM_PROMPT }, tools: [], history: turnHistory, taskPreference: 16_384,
          ...(ceiling ? { ceiling } : {}),
        }).budget;
        return {
          fits: b.status !== 'over' && b.status !== 'blocked' && b.output.requested >= Math.min(SUMMARY_MIN_OUTPUT, b.output.cap),
          maxTokens: b.output.requested, estInput: b.input.tokens,
        };
      };
      /** 摘要请求按当前槽位定预算：输出上限跟当前模型走（封顶 16384），输入按它的输入上限封顶；
       *  带上取消信号，用户点停止时摘要请求一起断，不在后台把 marker 写完。 */
      const summarizeOptions = (rule: AnchorRule, trigger: CompactTrigger): SummarizeOptions => {
        const sb = budgetOf(activeSlot);
        return {
          maxTokens: Math.min(16_384, planOf(activeSlot).maxTokens),
          windowTokens: capacityNow(),
          catalogProviderId: activeSlot.runtime?.endpoint.catalogProviderId,
          signal: opts.signal,
          rule, trigger,
          slot: { label: activeSlot.label, modelId: activeSlot.runtime?.modelId ?? activeSlot.provider.modelId },
          ...(sb ? { before: briefOf(sb.budget) } : {}),
          ...(activeSlot.runtime ? { fit: summaryFit } : {}),
          toolKindOf,
          reread: () => store.listMessages(opts.sessionId),
          onRequest: onSummaryRequest,
        };
      };
      /** 发一次摘要请求。'redo' = 写下了 marker，回轮首重读历史；'cancelled' = 已取消并已报；'next' = 没有产出，接着走下一步。 */
      const compactOnce = async function* (rule: AnchorRule, trigger: CompactTrigger): AsyncGenerator<LoopEvent, 'redo' | 'cancelled' | 'next'> {
        try {
          const newMarker = await engine.summarize(history, opts.sessionId, activeSlot.provider, summarizeOptions(rule, trigger));
          if (newMarker) {
            compactCount++;
            const detail = compactionViewOf(newMarker);
            yield { kind: 'compacted', markerId: newMarker.id, summary: newMarker.summary.slice(0, 200), detail };
            if (incident) {
              incident.actions.push({
                kind: 'compact', result: 'done', markerId: newMarker.id,
                rule: detail.rule ?? (rule === 'tight' ? 'tight' : 'recent-turns'), messages: detail.coverage?.incrementMessages ?? 0,
              });
              incident.acted = true;
            }
            return 'redo';
          }
          // summarize 返回 undefined（没有可摘的）：绝不能因此回轮首重试，否则 history 不变 → 再次 undefined → 死循环
          if (incident) incident.actions.push({ kind: 'compact', result: 'skipped', reason: 'nothingToSummarize' });
          return 'next';
        } catch (e) {
          // 取消优先：摘要请求是被停止键打断的，不是压缩失败，照其它取消点报「已取消」收尾
          if (opts.signal?.aborted) { yield { kind: 'error', message: '已取消' }; return 'cancelled'; }
          // 压缩失败不杀对话：本轮按原样继续，但要说出来，并停用本次运行的压缩
          compactDisabled = true;
          const reason: CompactFailReason = e instanceof CompactRejectedError ? e.reason : 'error';
          const message = e instanceof CompactRejectedError
            ? e.message
            : `摘要请求失败，未写入压缩记录（${e instanceof Error ? e.message : String(e)}）`;
          yield { kind: 'compactFailed', reason, message, trigger };
          if (incident) { incident.actions.push({ kind: 'compact', result: 'failed', reason }); incident.acted = true; }
          return 'next';
        }
      };
      /** 阶梯的后半段（事故内与事故外共用）：只在放不下（over）时做——动的是模型正要用的内容。
       *  第 2 级修剪 → 第 3 级裁剪最近的大结果 → 收紧锚点的压缩。'done' = 做完了（仍可能是 over）。 */
      const tightenTurn = async function* (): AsyncGenerator<LoopEvent, 'done' | 'redo' | 'cancelled'> {
        if (over()) yield* applyTrim(2);
        if (over()) yield* applyTrim(3);
        if (over() && canCompact('tight')) {
          const r = yield* compactOnce('tight', 'overflow');
          if (r !== 'next') return r;
        }
        return 'done';
      };
      /** 事故打开时的轮首：收输出（上限已进预算，max_tokens 由同一条公式收紧，不需要动作）→ 修剪两级 → 标准压缩 →
       *  裁剪最近结果 → 收紧锚点的压缩。每一档之后都用带上限的预算重判，够了就停。前两档按「余量不足」继续（与 F02 轮首减压
       *  对 tight 的处理一致，重发的请求不会只剩下限那点输出）；后两档只在放不下时做。仍放不下就放弃同槽，不重发（I8）。 */
      const recoverTurn = async function* (): AsyncGenerator<LoopEvent, 'send' | 'redo' | 'ended' | 'cancelled'> {
        if (relief()) yield* applyTrim(1);
        if (relief()) yield* applyTrim(2);
        if (relief() && canCompact('standard')) {
          const r = yield* compactOnce('standard', 'overflow');
          if (r !== 'next') return r;
        }
        const t = yield* tightenTurn();
        if (t !== 'done') return t;
        if (over() || !incident) return yield* abandonSameSlot('noProgress');
        incident.resends++; incident.acted = true;
        const sb = budgetOf(activeSlot);
        yield { kind: 'contextRecovery', view: viewOf('resending', sb ? { after: briefOf(sb.budget) } : {}) };
        return 'send';
      };

      if (incident) {
        const r = yield* recoverTurn();
        if (r === 'ended' || r === 'cancelled') return;
        if (r === 'redo') { turn--; continue; } // 不消耗 turn 额度；空响应提醒此时还没清（见下方 req 构建处）
        // r === 'send'：往下发请求
      } else {
        // F02：水位阈值表不动，变的是喂进去的两个数——分母是这个槽位的输入上限，分子是「实际将发送的请求」的估计
        //（系统提示、工具定义、回放推理、图片都在内）。没有预算的槽位（旧调用方、预算计算失败）沿用窗口与只数 parts 的旧估算。
        // F01：窗口按当前槽位的配置实例解析（同名模型的其它配置不再互相影响）
        let sb = budgetOf(activeSlot);
        const capacity = sb ? sb.budget.limits.inputLimit : windowOfSlot(activeSlot);
        const tier = policy.decideWindow(capacity, sb ? sb.budget.input.tokens : policy.estimateTokens(effectiveHistory));
        // 减压分三步，修剪是第一道（本地操作、不花钱）。必须排在压缩前面：窗口 32K–64K 的配置在输入到 65% 左右输出余量就不足了，
        // 比修剪档的门槛还早，而这类窗口的阈值表只有修剪一档、单个用户回合的长工具任务里摘要又做不成——
        // 余量不足时若直接走压缩，这些会话就一轮都不再修剪，一直涨到端点拒绝。
        let action = sb ? decideContextAction(tier, sb.budget) : tier;
        // F03：这次压缩因何而发——水位直接到了压缩档，还是修剪后余量仍不足
        let trigger: CompactTrigger = 'watermark';
        let triedPrune = false;
        // ① 先修剪；修剪后重算预算，仍然余量不足、可压部分够大、且这一次真能摘走的部分也够大，才考虑付费的压缩
        if (action === 'offload') {
          yield* pruneTurn();
          triedPrune = true;
          sb = budgetOf(activeSlot);
          action = sb && compactWorthwhile(sb.budget) && reliefCompactPays() ? 'compact' : 'none';
          trigger = 'relief';
        }
        // ② 压缩。compactDisabled 与每次运行 3 次的上限（设计 §4.2）都只拦压缩这一步：降级到大窗口后水位落回 offload 档时、
        //    以及已压缩满 3 次之后，修剪照常。F03：摘要请求的次数与花费上限同样只拦这一步（水位压缩与恢复共用）
        if (action === 'compact' && !compactDisabled && compactCount < LIMITS.compactionsPerRun && summaryAllowance()) {
          // summarize 返回 undefined（不足 3 个真正用户回合且消息数 < 30）时不发 compacted 事件、不回轮首——
          // 直接落到下面的 req 构建，用现有 effectiveHistory 继续流式请求
          const r = yield* compactOnce('standard', trigger);
          if (r === 'cancelled') return;
          if (r === 'redo') { turn--; continue; } // 压缩轮不消耗 turn 额度；重新取 history + effectiveHistory（含新 marker，水位下降）
        }
        // ③ 走到这里说明这一轮的压缩没有产出 marker（已停用、已满 3 次、没有可摘的、失败）：余量不足时退到修剪，不让它被压缩「吞掉」。
        //    水位在压缩档、余量够、压缩没产出时不修剪，与 F02 之前相同
        if (action === 'compact' && !triedPrune && sb && needsRelief(sb.budget)) yield* pruneTurn();
        // F03：被端点拒绝过的槽位，三步之后带上限的预算仍放不下时，轮首接着走阶梯的后半段再发请求。靠 2、3 级裁剪或收紧锚点的压缩
        // 恢复的会话，下一轮从落库历史重建后请求又是原样大小——没有这一段，每轮都要先被端点拒一次才裁剪。
        // 这一段不发主请求、不计重发与拒绝次数、不发恢复说明（没有事故）；做了什么由 pruned（带 level）与 compacted 两种事件说明。
        // 仍是 over 也照发（F02 的规则：学到的上限是 advisory，不据此拒发）；端点再拒则开新事故
        if (ceilings.has(activeSlot) && over()) {
          const r = yield* tightenTurn();
          if (r === 'cancelled') return;
          if (r === 'redo') { turn--; continue; }
        }
      }
    }

    /** 这个槽位在发请求之前需不需要先减压（F03 换槽后的补判用）：与轮首读同一张表。 */
    const reliefDue = (slot: ProviderSlot): boolean => {
      const policy = opts.contextPolicy;
      if (!policy) return false;
      const sb = budgetOf(slot);
      if (sb) return decideContextAction(policy.decideWindow(sb.budget.limits.inputLimit, sb.budget.input.tokens), sb.budget) !== 'none';
      return policy.decideWindow(windowOfSlot(slot), policy.estimateTokens(effectiveHistory)) !== 'none';
    };

    // 构建 req（复用上方已合成的请求消息，不重复计算 marker / effectiveHistory）。
    // 续写提示与空响应提醒已经在 sendMessages 里（withHints）：只出现在请求里、绝不落库——
    // 与 pairToolResults 同属请求构建边界，raw history 保持不动。
    const req: StreamRequest = {
      messages: sendMessages,
      // systemPrompt/maxTokens/thinkingLevel 占位——下方 while 循环内按当前 activeSlot 的请求计划重算（降级切换后当轮生效）
      systemPrompt: '',
      maxTokens: 0,
      tools: toolDefs, thinkingLevel: 'off',
    };
    // 空响应提醒注入一次即清——模型恢复后的后续请求不再携带；判重状态由 remindedEmptyResponse 持有，与本标志分离。
    // 清在这里而不是 withHints 里：压缩成功后 continue 回到轮首时这一轮还没发请求，提醒不能丢
    pendingEmptyReminder = false;

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
      if (blockOf(activeSlot)) {
        // 防御：正常到不了这里——每轮开头已按能力与固定开销选过槽位（ensureCapableSlot），故障降级挑的也是接得住的。
        // 留着是为了保证任何路径都不会把请求发给接不了这一轮的槽位（I6）
        if (!(yield* ensureCapableSlot())) return;
        continue;
      }
      // F01：当前槽位的请求计划——max_tokens、推理参数、工具、图片都按它的配置实例重新决定，不沿用主模型的
      const plan0 = planOf(activeSlot);
      // F02：这个槽位这次请求的预算（换过槽位后按新槽位自己的协议、窗口与校准系数算）。max_tokens 收紧过的话，
      // 推理预算按最终的 max_tokens 重算——budget_tokens 必须小于实际发出的 max_tokens，沿用按上限算的预算端点会 400。
      // max_tokens 是被剩余空间收紧的（limitedBy 为 window / floor）时，预算还要给可见输出留底：不留的话预算顶到 max_tokens − 1，
      // 思考用满时正文与工具入参一个 token 的额度都没有。偏好造成的不同（偏好之上本就加了推理预算）不在此列
      const sb = budgetOf(activeSlot);
      const spaceLimited = sb !== undefined && (sb.budget.output.limitedBy === 'window' || sb.budget.output.limitedBy === 'floor');
      const plan = sb && sb.budget.output.requested !== plan0.maxTokens ? planOf(activeSlot, sb.budget.output.requested, spaceLimited) : plan0;
      const fresh = plan.notices.filter(n => !noticed.has(n));
      if (fresh.length > 0) {
        for (const n of fresh) noticed.add(n);
        yield { kind: 'capability', label: activeSlot.label, notices: fresh };
      }
      // systemPrompt 工厂：每次 slot 切换后用当前 activeSlot.provider.modelId 重算（决策点 3 方案 a：降级当轮生效）；
      // 传 string 时原样透传（向后兼容——等价于改前行为）。F01R：带上这个槽位带不带工具，工厂据此换提示。
      // F02：同一轮同一槽位只调一次，这里拿到的与预算用的是同一份
      const sys = systemOf(activeSlot, plan.sendTools);
      const slotReq: StreamRequest = {
        session: { id: opts.sessionId, catalogProviderId: activeSlot.runtime?.endpoint.catalogProviderId },
        // 有预算时发的就是预算量过的那份消息；没有预算的槽位在这里按能力改写
        messages: sb ? sb.request.messages : shapeMessagesForSlot(req.messages, plan, activeSlot.label),
        systemPrompt: sys.text,
        ...(sys.parts ? { systemPromptParts: sys.parts } : {}),
        // maxTokens 同款按 slot 重算：降级到小输出上限的端点时，沿用主模型的大值会被对方 400 拒收，
        // 降级链会因此连环失败（「所有模型均不可用」的假象）。F02（I4）：带 runtime 的槽位发的是这次请求的预算值——
        // 偏好、模型上限、剩余空间三者的最小值
        maxTokens: sb ? sb.budget.output.requested : plan.maxTokens,
        tools: plan.sendTools ? req.tools : [],
        thinkingLevel: plan.thinking.level,
        ...(plan.thinking.level !== 'off' && (plan.thinking.effort !== undefined || plan.thinking.budgetTokens !== undefined)
          ? { thinking: { ...(plan.thinking.effort !== undefined ? { effort: plan.thinking.effort } : {}), ...(plan.thinking.budgetTokens !== undefined ? { budgetTokens: plan.thinking.budgetTokens } : {}) } }
          : {}),
      };
      sent = sb;
      sentThinking = plan.thinking.level !== 'off';
      // 例外：思考由服务端自适应的型号（Anthropic 协议上的 BINDING_MODELS）。计划里的档位仍是用户选的（decideThinking 不改写），
      // 但构建器不看它，请求体里没有可调的推理参数——这三个型号的思考关不掉，正是最容易把输出额度用在思考上的
      if (activeSlot.runtime && thinkingIsServerAdaptive(activeSlot.runtime)) sentThinking = false;
      // 观察口：每次向一个槽位发请求之前调一次（下面的重试梯重发同一个 slotReq，不重复调）。抛错不影响运行
      if (sb && opts.onRequestBudget) { try { opts.onRequestBudget(sb.budget); } catch { /* 观察口抛错不影响运行 */ } }

      // 透明重试：仅对 retryable 错误（M1 逻辑不变）
      let attemptSucceeded = false;
      for (let attempt = 0; attempt <= retryLadder.length; attempt++) {
        // 每次尝试都必须清空累加器：第 1 次流出半截文本再失败时，若不清空，
        // 第 2 次会往同一个累加器上追加，落库的 assistant 文本会重复一遍（工具调用同理）。
        text = ''; reasoning = ''; usage = undefined; stopReason = 'endTurn'; calls = []; thinking = [];
        try {
          const providerStream = currentProvider.streamAgentMessage(slotReq, opts.signal);
          const stream = opts.inputQueue ? observeInputRequest(providerStream,
            () => opts.inputQueue!.delivered(fullyCoveredInputIds(slotReq.messages)), opts.signal) : providerStream;
          for await (const ev of stream) {
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
          // 带分类码的错误在这里显式拦截（设计稿 §3 第 1 条），先于下面的降级与重试判断：
          // 那两条路径对非 fallbackable 的错误也会在链上还有槽位时降级，只靠 fallbackable=false 挡不住。
          // thinkingBinding：换模型解决不了（绑定的是这段对话的历史），原样报出，message 里有中文说明。
          // F02b：这一轮按输出额度换下过槽位、还没有槽位给出回答时，终态仍是被换下槽位的截断说明，绑定的说明附在后面（见 exhaustedError）
          if (err.code === 'thinkingBinding') {
            yield outputLimitLeft ? exhaustedError(err.message) : { kind: 'error', code: 'thinkingBinding', message: err.message };
            return;
          }
          if (err.code === 'contextOverflow') {
            deferInputAfterContextReject = true;
            // F03：先在同一个槽位上恢复——记下端点拒绝给出的上限（进预算），回轮首带着它重走：收输出 → 修剪 → 压缩 → 裁剪 →
            // 预算不再 over 才重发（见轮首的 recoverTurn）。到这里为止什么都没落库、工具一个没跑（I7），回轮首只是重新构建请求。
            // 不恢复、走下面原有分支的三种情形（行为与请求次数同 F03 之前）：这个槽位没有预算（旧调用方、预算计算抛错）；
            // 调用方没接水位与压缩；这一轮按输出额度换过槽、还没有槽位给出回答（F02b：出路在被换下的槽位上）
            if (sent && opts.contextPolicy && opts.compactEngine && outputLimitLeft === undefined) {
              runRejections++; lastRejected = sent;
              if (!incident || incident.slot !== activeSlot) {
                incident = { id: ++incidentSeq, seq: 0, slot: activeSlot, rejections: 0, resends: 0, before: briefOf(sent.budget), actions: [], acted: false };
              }
              incident.rejections++; incident.before = briefOf(sent.budget);
              const c = lowerCeiling(sent.budget, overflowHint(err.message), ceilings.get(activeSlot), LIMITS.stepRatio);
              ceilings.set(activeSlot, c); turnBudgets.clear();
              incident.actions.push({
                kind: 'ceiling', basis: c.basis,
                ...(c.input !== undefined ? { input: c.input } : {}), ...(c.total !== undefined ? { total: c.total } : {}),
                ...(c.output !== undefined ? { output: c.output } : {}),
              });
              // 三种不再同槽重发的情形：固定开销自己就占满了资料上限（压缩与接力都减不掉）；本次运行处理的拒绝已超过上限；
              // 这次事故已经重发满次数。都是先看有没有窗口更大的槽位可换，没有才结束
              const stop: RecoveryStop | undefined = fixedCostProven(sent) ? 'fixedCost'
                : runRejections > LIMITS.rejectionsPerRun ? 'runLimit'
                : incident.resends >= LIMITS.resendsPerIncident ? 'resendLimit' : undefined;
              lastError = err;
              if (stop && (yield* abandonSameSlot(stop)) === 'ended') return;
              redoTurn = true;
              break;
            }
            const target = findLargerWindowSlot();
            if (target < 0) {
              // F02b：这一轮按输出额度换下过槽位、还没有槽位给出回答时不走下面两个出口。换槽之前已经把修剪后仍放不下的候选跳过了，
              // 走到这里的是估算看不出来的（窗口没有资料、估计偏低）或随后故障降级到的槽位。被换下的槽位窗口多半还空着，
              // 问题在它的输出上限、出路也在它身上：报「上下文已满」并给接力草稿，是把用户引去新建会话。
              // 报它的截断说明，这里的原因（固定开销占满，或这个槽位放不下这段对话）附在后面，不带接力草稿与 budget
              if (outputLimitLeft) {
                yield exhaustedError(sent && fixedCostDominates(sent.budget)
                  ? fixedCostMessage(activeSlot.label, sent.budget)
                  : `上下文已满：${activeSlot.label} 放不下这段对话`);
                return;
              }
              // F02：固定开销（系统提示 + 工具定义）自己就占满了输入上限时，清空历史也放不下——新建会话接力解决不了，
              // 不报「上下文已满」、不给接力草稿，照实说是固定开销并给出对应的出路。没有预算或窗口没有资料时照旧
              if (sent && fixedCostDominates(sent.budget)) {
                yield { kind: 'error', code: 'requestBudget', budget: sent.budget, message: fixedCostMessage(activeSlot.label, sent.budget) };
                return;
              }
              // 没有更大的窗口可换：不报「所有模型均不可用」（那是假话，别的模型并没有坏），也不改绑（没有 turnEnd），
              // 给出原因和接力草稿。走到这里的是不做同槽恢复的调用（见上：没有预算、没接水位与压缩、按输出额度换过槽）
              yield { kind: 'error', code: 'contextFull', message: CONTEXT_FULL_MESSAGE, relayDraft: buildRelayDraft(store, opts.sessionId, history) };
              return;
            }
            // 指针停在目标前一格，下方 nextCompatibleSlot 自增后正好取到目标；中间窗口不更大的槽位一次不请求
            slotIndex = target - 1;
            overflowFallback = true;
            lastError = err;
            break;
          }
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
            yield exhaustedError(err.message); return;
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

      if (attemptSucceeded) {
        deferInputAfterContextReject = false;
        // F03：端点收下了重发的请求，这次事故到此结束（学到的上限留到运行结束）。「已恢复」说的是请求被收下；
        // 这次回复随后若是空的或被截断，由下面的既有分支另行处理
        if (incident) {
          if (incident.acted) yield { kind: 'contextRecovery', view: viewOf('recovered', sent ? { after: briefOf(sent.budget) } : {}) };
          incident = undefined;
        }
        streamOk = true; break;
      }
      // F03：回轮首重走这一轮（端点以超窗拒绝后的同槽恢复，或已换到更大窗口的槽位）
      if (redoTurn) break;

      // 到这里说明当前 slot 的流式请求失败了（fallbackable 或 retryable 耗尽）
      // 尝试降级到下一 slot（F01：接不了这一轮的槽位说明原因后跳过，不发请求）
      const nextSlot = yield* nextCompatibleSlot();
      if (!nextSlot) {
        // 链非空且已耗尽 →「所有模型均不可用」；链本就空 → 保留 M1 的原始错误消息。
        // F02b：这一轮按输出额度换下过槽位时两句都不报，报那个槽位的截断说明并附上最后的故障原因（exhaustedError）
        yield exhaustedError(fellBack ? '所有模型均不可用' : (lastError?.message ?? '所有模型均不可用'), lastError?.message ?? '未知错误');
        return;
      }
      yield overflowFallback
        ? { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: '上下文已满', cause: 'contextOverflow' }
        : { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: lastError?.message ?? '未知错误' };
      overflowFallback = false;
      fellBack = true;
      // F03：重发途中出了别的故障（5xx、限流…）换槽：打开着的事故是被换下的槽位的，到此作废（做过动作的说明一声）
      if (incident) {
        if (incident.acted) yield { kind: 'contextRecovery', view: viewOf('switched', { switchedTo: nextSlot.label }) };
        incident = undefined;
      }
      activeSlot = nextSlot;
      // F03 换槽后的补判：故障降级到的槽位窗口可能小得多。以前只重算预算就照发，新槽位放不下也发；现在它需要先减压
      //（水位到档或余量不足），或本轮的请求已为被换下的槽位裁过时，回轮首按新槽位把 I1–I3 的顺序重走一遍——
      // 水位、修剪、压缩、摘要请求都按接手的槽位算。fallback 事件上面已发，不重复。新槽位不需要减压且本轮没裁过请求时不回轮首，
      // 与以前逐步相同。按输出额度换过槽的轮次不补判（F02b 的行为：故障降级照发）。有界：只在换槽时触发，slotIndex 只增不减
      if (opts.contextPolicy && opts.compactEngine && outputLimitLeft === undefined && (turnTrim > 0 || reliefDue(activeSlot))) { redoTurn = true; break; }
      // 继续 while(true) 用新 slot 重新流式请求
    }

    // F03：回轮首重走。不消耗 turn 额度；空响应提醒还原成轮首时的值（续写提示由 continueCount 决定，本来就不丢）
    if (redoTurn) { pendingEmptyReminder = turnHadReminder; turn--; continue; }

    // 防御：上面的循环只在 streamOk 为真时跳出，正常到不了这里。出口与其它终态同一个口径（exhaustedError）
    if (!streamOk) { yield exhaustedError('流式请求失败'); return; }

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
      // F02：以 max_tokens 截断收尾的「空」不是空响应——输出额度在产出正文之前就用完了（多为推理占用）。F02 会把 max_tokens
      // 收到剩余空间甚至下限，带推理的模型很容易把它全用在推理上。按空响应处理的话，单槽位只报一句「模型返回了空响应」，
      // 组里有备用则按故障降级、回合结束后把会话改绑过去，用户始终看不到「输出被截断」这件事。所以先于空响应的两路判：
      // 不按故障降级、不改绑、不注入空响应提醒，照实说是截断并带上这次的 max_tokens 与它为什么是这个数。
      // 没有预算的旧调用方（sent 为空）说不出这两样，维持原来的空响应处理。
      // 这次请求的用量落不了库：没有可落的 assistant 消息（只有思考的消息不进历史，见上）——但说明里用得上它。
      // 说明按这一轮实际发出的请求给：请求体里带没带可调的推理参数、上限是兜底值还是
      // 按手动窗口封顶出来的（两样都不是模型自己的上限）、服务商报了多少输出
      if (stopReason === 'maxTokens' && sent) {
        const o = sent.budget.output;
        const message = outputExhaustedMessage(activeSlot.label, o, {
          thinkingSent: sentThinking,
          capIsFallback: activeSlot.runtime?.limits.maxOutputTokens.value === undefined,
          capFromManualWindow: activeSlot.runtime?.limits.maxOutputTokens.cappedBy === 'manual-window',
          ...(usage ? { usage } : {}),
        });
        // F02b：按这次的 max_tokens 为什么是这个数分两种。
        // window / floor / preference：额度是被剩余空间收紧的，或按额度申请的——报截断并给出路才对，换个模型只会把这件事盖住，不换。
        // model / manual：额度是模型自己的输出上限（含兜底值、按手动窗口 3/4 封顶的）或手动填的最大输出，与 F02 的收紧无关。
        // F02 之前这种回复按空响应在模型组里降到备用并得到回答，一律报错就比那时少了一条出路。所以链上还有接得住这一轮的槽位
        // 就换过去、回到轮首重发这一轮：水位按接手的槽位重判；这次回复什么都没落库，已执行的工具不重跑。
        // 它不是故障：fallback 带 cause，index.ts 不把它算作改绑的理由（会话仍绑着原来的组时，下一条消息仍先给这个槽位）；
        // 也不置 fellBack（这个槽位并没有坏）。接手的槽位若也把输出用完，回到这里按它自己的 limitedBy 再判；slotIndex 只增不减，
        // 链用尽就落到下面的错误。换过去的槽位都没接住这一轮时，报的仍是最先被换下槽位的截断说明（记在 outputLimitLeft，见 exhaustedError）。
        // 没有可换的槽位时那条说明仍是唯一的出路
        if (o.limitedBy === 'model' || o.limitedBy === 'manual') {
          // 挑接手的槽位。接得住这一轮（能力、固定开销，见 nextCompatibleSlot）之外，还有两种按「接不了」处理：说明后跳过、继续往后找。
          // ① 要先压缩对话才放得下的。换用的那一刻不为它压缩：回到轮首时水位按接手的槽位判（I3），它的窗口更小就会先发一次付费的
          //    摘要请求、写下压缩记录；而会话没有改绑，压缩记录对会话里所有槽位生效——被换下的槽位窗口还空着，早先的对话却已被摘要
          //    永久替换。第一跳就是故障的降级可以这样（会话随后改绑到接手的槽位），这里不行：被换下的槽位没有坏。
          //    只管这一跳、换用的那一刻。之后有两种情形仍按当时接手槽位的窗口压缩并写下记录，与按能力换槽之后相同（I3）；
          //    这次运行的第一跳不是故障时会话都不改绑（index.ts 按第一跳算），被换下的槽位之后读到的是摘要：
          //    · 换过去之后对话继续增长（它接着调工具）、到了它的压缩档——它要把这个任务做完确实需要压缩，禁了会在长工具任务里超窗；
          //    · 换过去的槽位自己回了空响应、再降到后面的槽位——那一跳是故障降级，挑槽位不过下面的 takeoverSkip，空响应又是回到
          //      轮首重发，水位按新接手的槽位重判：它在压缩档就压缩，对话没有增长也一样。（限流这类故障在降级循环里当场换槽、
          //      不回轮首，这一轮照原样发给新接手的槽位；它给出回答之后的轮次归上一种。）
          // ② 修剪之后仍放不下这段对话的（预算为 over）。故障降级时这样的请求照发、由端点裁决；这里不发：被换下的槽位没有坏，
          //    把这一轮发给多半会以超窗拒绝的槽位，换来的是一次白花的请求和一句「上下文已满」，它的截断说明反而被盖住。
          // 跳过的说明照放不下的原因写。撑满输入上限的是固定开销时（系统提示 + 工具定义按估算自己就占满了；下界没超过，所以没有在
          // nextCompatibleSlot 里按 blocked 跳过），①② 的两句都不对：压缩、修剪、缩短对话都减不掉固定开销，写成「要先压缩这段对话」
          // 「放不下这段对话」是把用户引去动对话。这时改说固定开销并带上各项数字（与端点拒绝之后用 fixedCostMessage 是同一个判断）。
          // 只换说明，跳不跳仍按 ①② 判。
          // 判法与轮首的减压读同一张表、量的是回到轮首时会发的那份消息（未修剪的有效历史 + 续写提示），按轮首的先后模拟：
          // 水位到了压缩档且可压部分够大 → 压缩；修剪档或余量不足 → 先修剪，之后余量仍不足且可压部分够大 → 压缩。
          // 修剪只动请求、不落库，只需修剪的照常接手。轮首本来就不会发摘要请求的不算 ①：本次运行已停用压缩或已满 3 次、
          // 没有可摘的（summarize 自己返回 undefined）——这时轮首只剩修剪（压缩档上压缩做不成而余量不足时也修剪，第 ③ 步），
          // 修剪之后的预算仍是 over 就归 ②。没接水位与压缩的调用方轮首不修剪，按原样的请求判 ②；没有预算的槽位（旧调用方）判不了 ②。
          // 轮首在修剪之后还会看这一次摘得走多少（不够就不发），这里不看：宁可少换一次，不写一条不该写的记录
          const takeoverSkip = (slot: ProviderSlot): string | undefined => {
            const policy = opts.contextPolicy; const engine = opts.compactEngine;
            const fresh = engine ? engine.buildEffectiveHistory(history, curMarker) : toAgentMessages(history);
            let sb = budgetOf(slot, withHints(buildMessages(fresh)));
            /** 撑满这份预算输入上限的是固定开销时的说明；不是这种情形返回 undefined（用 ①② 各自的那一句）。 */
            const fixedCostSkip = (b: RequestBudget | undefined): string | undefined => {
              if (!b || !fixedCostDominates(b)) return undefined;
              const c = b.input.components;
              return `已跳过：${slot.label} 放不下这次请求的固定部分（系统提示约 ${c.system}、工具定义约 ${c.tools}（${b.input.toolCount} 个）`
                + `已占满${limitName(b.limits)} ${b.limits.inputLimit}（估算），对话本身约占 ${c.history + c.reasoningReplay + c.media}）；`
                + '这次换用不是因为故障，不把这一轮发给它';
            };
            if (policy && engine) {
              const compactable = !compactDisabled && compactCount < LIMITS.compactionsPerRun && pendingSummaryRange(history, curMarker) !== undefined;
              const compactFirst = `已跳过：${slot.label} 要先压缩这段对话才放得下这一轮；这次换用不是因为故障，不为它压缩对话`;
              const tier = policy.decideWindow(sb ? sb.budget.limits.inputLimit : windowOfSlot(slot), sb ? sb.budget.input.tokens : policy.estimateTokens(fresh));
              const action = sb ? decideContextAction(tier, sb.budget) : tier;
              if (action === 'compact' && compactable) return fixedCostSkip(sb?.budget) ?? compactFirst;
              if (action === 'offload' || (action === 'compact' && sb !== undefined && needsRelief(sb.budget))) {
                const { pruned, history: prunedHistory } = pruneOldToolResults(fresh);
                if (pruned > 0) sb = budgetOf(slot, withHints(buildMessages(prunedHistory)));
                if (action === 'offload' && compactable && sb !== undefined && compactWorthwhile(sb.budget)) return fixedCostSkip(sb.budget) ?? compactFirst;
              }
            }
            if (sb?.budget.status !== 'over') return undefined;
            const b = sb.budget;
            return fixedCostSkip(b) ?? `已跳过：${slot.label} 放不下这段对话（预计输入约 ${b.input.tokens}，${limitName(b.limits)} ${b.limits.inputLimit} 留不出余量与最小输出）；`
              + '这次换用不是因为故障，不把这一轮发给它';
          };
          let nextSlot = yield* nextCompatibleSlot();
          while (nextSlot) {
            const skip = takeoverSkip(nextSlot);
            if (skip === undefined) break;
            yield { kind: 'capability', label: nextSlot.label, notices: [skip] };
            nextSlot = yield* nextCompatibleSlot();
          }
          if (nextSlot) {
            outputLimitLeft ??= { message, info: { requested: o.requested, limitedBy: o.limitedBy, continued: continueCount } };
            yield { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: message, cause: 'outputLimit' };
            activeSlot = nextSlot;
            turn--; // 不消耗 turn 额度，换个槽位重发这一轮
            continue;
          }
        }
        // 这一轮已经按输出额度换下过别的槽位、这个接手的槽位也把输出用完了（它的额度是收紧过的 / 按额度申请的，或链上再没有可换的）：
        // 终态仍是最先被换下槽位的说明，这个槽位自己的那句作为最后的失败原因附在后面——会话没有改绑，下一条消息仍从组的开头给起，
        // 那个槽位排在这个前面
        if (outputLimitLeft) { yield exhaustedError(message); return; }
        yield {
          kind: 'error', code: 'outputLimit',
          outputLimit: { requested: o.requested, limitedBy: o.limitedBy, continued: continueCount },
          message,
        };
        return;
      }
      if (!hadToolCallInPrevTurn) {
        // 首轮空响应：直接降级，不注入 system-reminder
        // F02b：这一轮先按输出额度换过槽位、换过去的槽位回了空响应时也走这里（下面提醒后仍空的那一支同理）。这一跳是故障降级，
        // 挑槽位不过 takeoverSkip；回到轮首后水位按新接手的槽位判，它在压缩档就压缩（取舍见上面按输出额度换槽处的 ①）
        const nextSlot = yield* nextCompatibleSlot();
        if (!nextSlot) { yield exhaustedError('模型返回了空响应'); return; }
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
      const nextSlot = yield* nextCompatibleSlot();
      if (!nextSlot) { yield exhaustedError('模型返回了空响应'); return; }
      yield { kind: 'fallback', from: activeSlot.label, to: nextSlot.label, reason: '空响应（reminder 重试后仍空）' };
      fellBack = true;
      activeSlot = nextSlot;
      turn--;
      continue;
    }
    // 空 assistant 回合绝不落库：Anthropic 拒收 content 为空的消息，
    // 这一行会让该会话之后的每次请求都失败（永久变砖）。
    // （空响应已在上方降级/reminder 分支处理，能走到这里说明 assistantParts 非空）

    // F02b：这一轮有槽位给出了回答，「按输出额度换下过谁」到此作废——之后的轮次若失败，报它自己的错误
    outputLimitLeft = undefined;
    const appendAssistant = (): RawMessage => store.appendMessage({
      id: store.newId(), sessionId: opts.sessionId, role: 'assistant', parts: assistantParts,
      createdAt: clock.next(), streamInterruptCount: 0, reasoningContent: reasoning || undefined,
      // F02：落库前盖章——v: 2 与来源无条件写；有预算时再带这次请求发出前的估计（下一轮据此校准）与按当次槽位价格估的费用。
      // 服务商没报 usage 时不落（不拿估算冒充用量）
      tokenUsage: finalizeUsage(usage, usageSourceOf(activeSlot), sent ? { estimate: sent.estimate, price: activeSlot.runtime?.price } : undefined),
    });
    // F05：带工具调用的 assistant 消息与整批「待执行」账本行同一个事务——下面的 toolStart 发出时，这一批已经在账本里
    const assistant = opts.recorder && calls.length > 0 ? opts.recorder.persistAssistant(calls, appendAssistant) : appendAssistant();
    yield { kind: 'messagePersisted', messageId: assistant.id };

    hadToolCallInPrevTurn = calls.length > 0;

    if (calls.length === 0) {
      // maxTokens 截断自动续写：本轮无工具调用且未到续写上限时，不 turnEnd，
      // 下一轮请求构建时注入 CONTINUE_HINT（见 withHints），让模型从截断处继续。
      // 只对 maxTokens 生效——endTurn/refusal 是模型的正常/拒绝收尾，不该被追续。
      if (stopReason === 'maxTokens' && continueCount < MAX_CONTINUATIONS) {
        continueCount++;
        normalInputBoundary = true;
        continue;
      }
      if (opts.inputQueue?.hasPending()) {
        // Keep this run: the next iteration admits pending input after this completed answer.
        normalInputBoundary = true;
        continue;
      }
      // F02：以截断收尾时带上这次请求的 max_tokens、它为什么是这个数、已续写几次——界面据此说明原因与出路
      yield {
        kind: 'turnEnd', stopReason,
        ...(stopReason === 'maxTokens' && sent
          ? { outputLimit: { requested: sent.budget.output.requested, limitedBy: sent.budget.output.limitedBy, continued: continueCount } }
          : {}),
      };
      return;
    }

    // 本轮发了工具调用 = 模型转入工具流程而非继续输出：续写状态作废。
    // 不清空的话，下一轮（工具结果后）还会误注入「上一条被截断」的提示，而那条早已不是被截断的输出。
    continueCount = 0;

    // F02：被收紧的 max_tokens 截断的是工具调用。这条路径不续写、直接执行工具，截断的入参已落成 '{}'，用户只会看到工具报
    // 「缺少必填参数」。以前写得完的大入参现在可能因为 max_tokens 收到剩余空间而被截断，所以要说出来。
    // 默认额度（65,536）造成的截断同样要说：上限更大的型号以前按上限发、这样的输出写得完，额度是 F02 引入的，
    // 不说的话用户只看到工具报缺参数、模型反复重试同一个大入参。
    // 固定句不含数字，沿用 noticed 去重，一次运行只说一次。任务指定的额度、手动填写的最大输出、模型上限造成的截断不是这里收紧的，不发
    if (stopReason === 'maxTokens' && sent) {
      const n = truncatedToolCallNotice(activeSlot.label, sent.budget.output);
      if (n && !noticed.has(n)) { noticed.add(n); yield { kind: 'capability', label: activeSlot.label, notices: [n], cause: 'outputLimit' }; }
    }

    // 工具交给调度器（F04）：按副作用与资源冲突排队——互不冲突的并行（每会话上限 10），写同一路径、shell / MCP 这类
    // 说不清会动什么的按调用顺序串行，别的会话正在写的资源要等；取消后还没启动的调用不再执行。
    // 每个调用恒有一个结果（取消、等锁超时、被拒的也有），按原顺序拼回
    for (const c of calls) yield { kind: 'toolStart', toolUseId: c.toolUseId, name: c.name, title: extractTitle(c.input), input: c.input };
    // 入队时查表；等锁期间被摘除的工具在 refused 结果处再复核。
    const available = calls.map(c => !!opts.tools.get(c.name) && !opts.excludedToolNames?.has(c.name));
    toolGuard.beginBatch();
    const results = await scheduler.runBatch({
      // 会话 id 取 toolContext.sessionId：锁的归属与工具执行时用的是同一个值
      calls, registry: opts.tools, ctx: opts.toolContext,
      signal: opts.signal ?? opts.toolContext.signal,
      // W2a-8：按会话排除的工具（关掉记忆的会话里的记忆工具、会话禁用的 MCP 台）执行侧也拒绝。只从工具表里剔除不够：
      // 历史里留着以前的调用，模型照着再叫一次，provider 照样把它交回来，registry 里又有这个工具，就会真的执行
      refuse: c => (opts.excludedToolNames?.has(c.name)
        ? { output: `本会话没有启用工具 ${c.name}，没有执行`, success: false }
        : undefined),
      onEvent: opts.onToolEvent,
      // F05：执行意图先落账、结果在落定时提交（调度器在放锁之前调）
      journal: opts.recorder?.journal,
    });
    const resultParts: ContentPart[] = [];
    const aborted = (opts.signal ?? opts.toolContext.signal)?.aborted ?? false;
    // 按下标取：同一个 toolUseId 在一批里可以出现两次，账本与结果都按调用位置配
    for (let i = 0; i < results.length; i++) {
      const { call: c, outcome, end, started } = results[i];
      // 落库形态：卸载（大结果换成桩，设计 §4.2）或读回封顶（W2a-5），规则在 tool-output.ts。
      // 带记录器时优先取它在调用落定那一刻算好的——账本里存的、恢复会补写的，与这里落库的是同一个字符串，卸载文件也只写一次
      const s = opts.recorder?.settledOf(i);
      const fin = s?.output ?? finalizeToolOutput(opts.offloadEngine, opts.sessionId, c, outcome);
      if (fin.offloadedPath) yield { kind: 'offloaded', toolUseId: c.toolUseId, relativePath: fin.offloadedPath };
      // toolEnd 事件广播替换前完整 output（UI 可见）；落库的是 outputToStore（可能是桩，或封顶后的读回内容）
      yield { kind: 'toolEnd', toolUseId: c.toolUseId, success: outcome.success, output: outcome.output };
      // 落库 status：带记录器按账本终态（取消类写 cancelled）；不带记录器保持 F04 的二值
      const status = opts.recorder
        ? toolResultStatusOf(s?.state ?? terminalOf({ end, started, success: outcome.success }, aborted).state)
        : (outcome.success ? 'success' : 'failed');
      resultParts.push({ type: 'toolResult', value: { toolUseId: c.toolUseId, output: fin.outputToStore, success: outcome.success, status } });
      // 不带记录器时仍按真实终态计数；保留旧落库的二值 status 契约。
      const guardStatus = toolResultStatusOf(s?.state ?? terminalOf({ end, started, success: outcome.success }, aborted).state);
      toolGuard.record(c, guardStatus, available[i] && !(end === 'refused' && !opts.tools.get(c.name)));
    }
    const appendResults = (): RawMessage => store.appendMessage({
      id: store.newId(), sessionId: opts.sessionId, role: 'user', parts: resultParts,
      createdAt: clock.next(), streamInterruptCount: 0,
    });
    // F05：结果消息与「已交付」同一个事务
    const resultMsg = opts.recorder ? opts.recorder.persistResults(results, appendResults) : appendResults();
    yield { kind: 'messagePersisted', messageId: resultMsg.id };
    if (toolGuard.stop) { yield { kind: 'error', message: toolGuard.stop }; return; }
    normalInputBoundary = true;
    // 继续下一轮
  }
  yield { kind: 'error', message: `已达最大回合数 ${maxTurns}` };
}

function extractTitle(inputJson: string): string {
  try { return String((JSON.parse(inputJson) as Record<string, unknown>).tool_title ?? ''); } catch { return ''; }
}
