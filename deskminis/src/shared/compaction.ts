/**
 * F03 契约：同模型超窗恢复与结构化压缩标记（minisd 的循环与压缩引擎写，渲染端与后续任务读）。
 * 只放类型与常量；只引 shared/request-budget.ts 的类型。
 *
 * 两样东西：
 *  - 有界恢复序列：超窗 → 固定开销判定 → 记拒绝上限、重算预算 → 收输出 → 修剪两级 → 标准压缩 → 裁剪最近结果 →
 *    收紧锚点的压缩 → 预算不再 over 才同槽重发（每事故 ≤ RECOVERY_LIMITS.resendsPerIncident）→ 更大窗口槽位 →
 *    requestBudget / contextFull。事件是 ContextRecoveryView（每条带全量状态）。
 *  - 结构化摘要标记：CompactMarker.meta（CompactMeta v2），存在 compact_marker_meta 表。读的一方必须容忍 meta 缺省
 *    （旧版本写的、同步来的 marker 都没有）。
 */
import type { BudgetStatus } from './request-budget';

/** 没有 meta 行的 marker 视为 v1。 */
export const COMPACT_META_VERSION = 2 as const;

/** 全部熔断上限。G01 的预算从这里读，不另抄常量。这几个数没有对着真实端点调过。 */
export const RECOVERY_LIMITS = Object.freeze({
  /** 一次超窗事故里同槽重发的次数。 */
  resendsPerIncident: 2,
  /** 一次运行里处理的超窗拒绝次数；超过后的那一次直接放弃同槽。 */
  rejectionsPerRun: 6,
  /** 一次运行里成功的压缩次数（水位压缩与恢复共用）。 */
  compactionsPerRun: 3,
  /** 一次运行里发出的摘要请求数，成功与失败都算。 */
  summaryRequestsPerRun: 5,
  /** 一次运行里摘要请求的累计花费：每个请求计「取材的本机估算（不乘校准系数，与一次取材最多 100,000 的上限同一口径）+ max_tokens」。
   *  来历：3 次满额摘要（各 100,000 加 16,384）约 35 万——不收紧「每次运行 3 次压缩」，只在重试叠加时起作用。 */
  summarySpendTokens: 400_000,
  /** 一次 summarize 最多发几个请求；第 2 个只在摘要请求自身超窗时发。 */
  summaryAttemptsPerCall: 2,
  /** 报文里没有可用数字时，上限按被拒输入的这个比例下调。 */
  stepRatio: 0.25,
});
export type RecoveryLimits = { -readonly [K in keyof typeof RECOVERY_LIMITS]: number };

/** 摘要结构的各项上限（解析、取证、渲染共用）。 */
export const COMPACT_CAPS = Object.freeze({
  goalChars: 600, itemChars: 400,
  constraints: 20, done: 30, todo: 20, decisions: 15, files: 30, carriedConstraints: 10,
  /** 程序记录里列的用户指示：第一条，另加最近这么多条。 */
  recentInstructions: 5,
  /** 程序记录里较早的用户指示超过 head + tail 字符时留头尾。保留回合（最近的用户回合）不走这里：读的时候全文带上。 */
  instructionHead: 600, instructionTail: 200,
  fileChanges: 40, pathChars: 260, runs: 12, titleChars: 80,
  recordChars: 8_000, metaBytes: 65_536,
});

/** watermark / relief：F02 三步里的压缩（水位到档 / 修剪后余量仍不足）。
 *  overflow：这个槽位本次运行被端点拒绝过，为放进学到的上限而压缩（事故内，或之后轮首的后半段阶梯）。 */
export type CompactTrigger = 'watermark' | 'relief' | 'overflow';
/** standard：最近 3 个用户回合之前（不足 3 回合且满 30 条时留最近 14 条）；tight：只留最近 4 条。 */
export type AnchorRule = 'standard' | 'tight';
/** 请求侧裁剪的级别：1 = 修剪 12 条之前的大结果；2 = 保留条数收到 4；3 = 再把仍然很大的结果裁成头尾。 */
export type TrimLevel = 1 | 2 | 3;
export type CoverageRule = 'recent-turns' | 'recent-messages' | 'tight';

/** 一次请求预算的摘录（事件、审计、meta 共用，不带文本）。 */
export interface BudgetBrief { slot: string; inputTokens: number; inputLimit: number; maxTokens: number; status: BudgetStatus }

export interface CompactCoverage {
  /** 这条 marker 代表的第一条消息（提交时的 history[0]）。 */
  fromMessageId: string;
  /** 必须等于 marker.lastCompactedMessageId。 */
  toMessageId: string;
  messageCount: number;
  /** 这一次新摘进来的那一段（上一个锚点之后一条到新锚点）。 */
  increment: { fromMessageId: string; toMessageId: string; messageCount: number };
  prevMarkerId?: string;
  rule: CoverageRule;
}

/** 模型写的那一半（解析、截断、陈述核对之后）。form === 'text' 时 goal / current 为空串、各列表为空，正文在 marker.summary。 */
export interface CompactModelPart {
  form: 'structured' | 'text';
  goal: string;
  constraints: string[];
  /** 模型的陈述；其中的路径与验证结论过了陈述核对，没有工具记录佐证的已移除。 */
  done: string[];
  current: string;
  todo: string[];
  decisions: string[];
  /** 【涉及文件】：模型列的路径（可带一句说明），过了陈述核对；确实被工具改过的以 evidence.fileChanges 为准。 */
  files: string[];
  /** 上一份摘要里有、这次没复述的约束。 */
  carriedConstraints: string[];
  /** items：超出条数上限丢掉的；unknownSections：规定之外的小节；unverified：陈述核对移除或改放的条目数。 */
  dropped: { items: number; unknownSections: number; unverified: number };
}

export interface UserInstruction { messageId: string; text: string; clipped: boolean; images: number }
export interface FileChange { path: string; tool: string; count: number; lastToolUseId: string; lastMessageId: string }
export interface EffectRun { tool: string; title: string; state: 'ok' | 'failed' | 'cancelled' | 'unknown'; toolUseId: string; messageId: string }

/** 程序根据落库的消息生成，模型的回复改不了。 */
export interface CompactEvidence {
  /** 第一条加最近 5 条被覆盖的用户回合，按时间顺序。 */
  userInstructions: UserInstruction[];
  omittedInstructions: number;
  /** 写入那一刻被带上的用户回合的消息 id（快照，供界面计数与审计）。读的一方不依赖它：有效历史每次按 history 现算。 */
  carriedUserMessageIds: string[];
  /** 写本地文件的工具且结果成功，最近 40 个路径。 */
  fileChanges: FileChange[];
  omittedFileChanges: number;
  /** 其它有副作用的调用，最近 12 次。 */
  runs: EffectRun[];
  omittedRuns: number;
  /** 覆盖区间内没有结果、结果未知或已取消的调用数。 */
  unsettledCalls: number;
}

export interface CompactRecord {
  trigger: CompactTrigger;
  slot?: { label: string; modelId: string };
  before?: BudgetBrief;
  request: { estInput: number; maxTokens: number; attempts: 1 | 2 };
}

export interface CompactMeta {
  v: 2;
  coverage: CompactCoverage;
  model: CompactModelPart;
  evidence: CompactEvidence;
  record: CompactRecord;
  /** marker.summary 的 sha256 前 16 位十六进制：summary 被同步合并改写过时 meta 作废。 */
  summaryDigest: string;
}

/** 事件与 chat.contextInfo 用的摘录（不带摘要正文与用户原话）。 */
export interface CompactionView {
  markerId: string; v: 1 | 2; createdAt?: number;
  form?: 'structured' | 'text'; trigger?: CompactTrigger; rule?: CoverageRule;
  coverage?: { messages: number; incrementMessages: number; fromMessageId: string; toMessageId: string };
  counts?: { constraints: number; todo: number; done: number; files: number; userInstructions: number; fileChanges: number; runs: number; unverified: number };
  before?: BudgetBrief;
  request?: CompactRecord['request'];
}

export type RecoveryAction =
  | { kind: 'ceiling'; basis: 'hint' | 'output-first' | 'step'; input?: number; total?: number; output?: number }
  | { kind: 'trim'; level: TrimLevel; pruned: number; clipped: number }
  | { kind: 'compact'; result: 'done'; markerId: string; rule: CoverageRule; messages: number }
  | { kind: 'compact'; result: 'failed' | 'skipped'; reason: string };
export type RecoveryStop = 'fixedCost' | 'noProgress' | 'resendLimit' | 'runLimit';
/** 压缩被跳过的原因里，属于「本次运行的熔断」的那几种：压缩已停用（此前失败过）、压缩次数、摘要请求次数、摘要花费用完。
 *  与 nothingToSummarize / tooSmall / wontFit（这次确实没有可减的）不同——停在这几种上的事故，恢复说明一定要发，
 *  界面要写明停在哪一条（循环的 abandonSameSlot 与渲染端的短句共用这张表）。 */
export const COMPACT_FUSE_REASONS: ReadonlySet<string> = new Set(['disabled', 'limit', 'requests', 'spendCap']);

/** 一次超窗事故的全量状态。同一 incident 下 seq 递增，后到的整体替换先到的。 */
export interface ContextRecoveryView {
  v: 1; incident: number; seq: number;
  slot: { label: string; modelId: string };
  phase: 'resending' | 'recovered' | 'switched' | 'failed';
  /** 这次事故里的拒绝次数、重发次数。 */
  rejections: number; resends: number;
  /** 本次运行累计的拒绝次数（与 limits.rejectionsPerRun 对照；stop 为 runLimit 时靠它说明）。 */
  runRejections: number;
  /** 最近一次被拒的请求。 */
  before: BudgetBrief;
  /** 将要重发（或已被收下）的请求。 */
  after?: BudgetBrief;
  actions: RecoveryAction[];
  stop?: RecoveryStop;
  switchedTo?: string;
  limits: { resendsPerIncident: number; rejectionsPerRun: number };
}
