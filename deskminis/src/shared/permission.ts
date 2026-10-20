/**
 * F13：带原因的权限结果——引擎与渲染端共用的线上契约。
 *
 * 纯类型、常量与纯函数，没有任何 import（与 shared/runtime-model.ts 同一做法）。
 *
 * 以前权限结果只有 'allow' | 'deny'：90 秒没人答复、规则直接拦下、会话被取消、MCP 被停用，回给工具的都是同一个 'deny'，
 * 各工具一律说成「被用户拒绝」。这里把拒绝分成六种原因；放行只带来源，许可范围不由这个文件决定。
 *
 * 失败关闭：任何解析不出来的值都是拒绝（parsePermissionOutcome），从不是放行。
 */

export const PERMISSION_DENY_REASONS = ['user-denied', 'timeout', 'rule-blocked', 'cancelled', 'invalidated', 'unspecified'] as const;
export type PermissionDenyReason = (typeof PERMISSION_DENY_REASONS)[number];

/** 每种原因下的细分。后续任务加细分只改这张表（F05 'engine-restarted'、F07 'superseded' 等），不加 reason。 */
export const PERMISSION_DENY_CAUSES = {
  'user-denied': [],
  timeout: ['unanswered', 'unattended'],
  'rule-blocked': ['shell-danger', 'level-not-allowed', 'core-data', 'plan-mode'],
  cancelled: ['user-stop', 'session-deleted', 'shutdown', 'requester-gone'],
  // F05：'engine-restarted' = 卡片挂着时引擎停了，重启后这张卡已不存在（只出现在恢复补写的审计里）；
  // 'record-failed' = 批准已收到，但「已放行」这一笔没能落进执行账本——不放行，免得留下没有记录的操作
  invalidated: ['mcp-disabled', 'mcp-session-disabled', 'mcp-config-changed', 'mcp-removed', 'mcp-config-unreadable', 'search-config-changed', 'engine-restarted', 'record-failed'],
  unspecified: ['legacy-binary', 'invalid-outcome'],
} as const satisfies Record<PermissionDenyReason, readonly string[]>;
export type PermissionDenyCause = (typeof PERMISSION_DENY_CAUSES)[PermissionDenyReason][number];

/** 放行的来源。'legacy-binary' = 只有 check 的旧式二值网关回的 'allow'。 */
export const PERMISSION_ALLOW_VIAS = ['level-bypass', 'session-grant', 'bridge-grant', 'user-once', 'user-session', 'legacy-binary'] as const;
export type PermissionAllowVia = (typeof PERMISSION_ALLOW_VIAS)[number];

/** requestId：弹过卡才有，就是那张卡、permission.request / permission.resolved 广播与审计里的 id。 */
export interface PermissionAllowed { decision: 'allow'; via: PermissionAllowVia; requestId?: string }
/** waitedMs：卡片挂了多久（超时文案用）。 */
export interface PermissionDenied { decision: 'deny'; reason: PermissionDenyReason; cause?: PermissionDenyCause; requestId?: string; waitedMs?: number }
export type PermissionOutcome = PermissionAllowed | PermissionDenied;

export function allowed(via: PermissionAllowVia, requestId?: string): PermissionAllowed {
  return requestId === undefined ? { decision: 'allow', via } : { decision: 'allow', via, requestId };
}

export function denied(reason: PermissionDenyReason, cause?: PermissionDenyCause, extra?: { requestId?: string; waitedMs?: number }): PermissionDenied {
  const d: PermissionDenied = { decision: 'deny', reason };
  // cause 必须属于这个 reason：写错的组合（如 timeout + mcp-disabled）不带出去，原因本身保留
  if (cause !== undefined && (PERMISSION_DENY_CAUSES[reason] as readonly string[]).includes(cause)) d.cause = cause;
  if (extra?.requestId !== undefined) d.requestId = extra.requestId;
  if (extra?.waitedMs !== undefined) d.waitedMs = extra.waitedMs;
  return d;
}

/**
 * 形状校验，失败关闭。从不抛，返回新对象、只带认识的字段。
 *  - 是对象、decision === 'allow' 且 via 在 PERMISSION_ALLOW_VIAS 里 → 允许；
 *  - 是对象、decision === 'deny' 且 reason 在 PERMISSION_DENY_REASONS 里 → 该拒绝；cause 不在该 reason 的表里就丢掉 cause；
 *  - 其余任何值（字符串 'allow'、缺 via、不认识的 reason、undefined、取属性抛错的对象）→ denied('unspecified', 'invalid-outcome')。
 */
export function parsePermissionOutcome(raw: unknown): PermissionOutcome {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return denied('unspecified', 'invalid-outcome');
    const o = raw as Record<string, unknown>;
    const decision = o.decision;
    const requestId = typeof o.requestId === 'string' && o.requestId !== '' ? o.requestId : undefined;
    if (decision === 'allow') {
      const via = o.via;
      if (typeof via === 'string' && (PERMISSION_ALLOW_VIAS as readonly string[]).includes(via)) return allowed(via as PermissionAllowVia, requestId);
      return denied('unspecified', 'invalid-outcome');
    }
    if (decision === 'deny') {
      const reason = o.reason;
      if (typeof reason !== 'string' || !(PERMISSION_DENY_REASONS as readonly string[]).includes(reason)) return denied('unspecified', 'invalid-outcome');
      const cause = typeof o.cause === 'string' ? (o.cause as PermissionDenyCause) : undefined;
      const waitedMs = typeof o.waitedMs === 'number' && Number.isFinite(o.waitedMs) && o.waitedMs >= 0 ? o.waitedMs : undefined;
      return denied(reason as PermissionDenyReason, cause, { requestId, waitedMs });
    }
    return denied('unspecified', 'invalid-outcome');
  } catch {
    // 取属性时抛错的对象（Proxy、带 getter 的对象）：照样是拒绝
    return denied('unspecified', 'invalid-outcome');
  }
}

/** 取消信号的 reason → cause：'session-deleted' | 'shutdown' | 'requester-gone' 原样，其余（含没有 reason）记 'user-stop'。 */
export function cancelCauseOf(signal: { readonly reason?: unknown } | undefined): 'user-stop' | 'session-deleted' | 'shutdown' | 'requester-gone' {
  let r: unknown;
  try { r = signal?.reason; } catch { r = undefined; }
  return r === 'session-deleted' || r === 'shutdown' || r === 'requester-gone' ? r : 'user-stop';
}

/** 用户在卡上的三种选择（permission.respond 的 decision；也是旧式询问函数的返回值）。 */
export type UserDecision = 'allow-once' | 'allow-session' | 'deny';
export const USER_DECISIONS: readonly UserDecision[] = ['allow-once', 'allow-session', 'deny'];

/** permission.resolved 的 reason：线上旧字段，取值只增不改。本任务新增 'invalidated'（'cancelled' 由 F04 引入）。 */
export type PermissionResolvedReason = 'answered' | 'timeout' | 'cancelled' | 'session-deleted' | 'shutdown' | 'invalidated';
export interface PermissionResolvedParams { requestId: string; reason: PermissionResolvedReason; outcome: PermissionOutcome }
export interface PermissionSettledInfo { reason: PermissionResolvedReason; decision: 'allow' | 'deny' }

/**
 * permission.respond 的返回值。applied:false = 这次答复没有生效。
 *  - settled：这张卡已经了结（本引擎进程的最近记录里查得到）。
 *  - undelivered：这张卡还在待批，但答复来自发卡之后才建立的连接（它没有收到过这张卡）；卡不动。
 *  - 两者都缺省：本引擎进程不认识这个 requestId（重启前的卡，或已滚出最近记录）。
 */
export type PermissionRespondResult =
  | { ok: true; applied: true }
  | { ok: true; applied: false; settled?: PermissionSettledInfo; undelivered?: true };
