/** 会话状态徽标推导（MU2b Task 4，设计 §1.1-1 变体 A）。
 *  数据源诚实说明：chat.sessions.list RPC 无 running/messages 字段——非活动会话状态不可得，
 *  一期 live 传 null → 返回 null（全局徽标需 minisd 扩字段，列入非目标）。
 *  error 系 = maxTokens / refusal（StopReason 联合中的异常终止；endTurn/toolUse 视为回合落幕 → done）。 */
import { collectArtifacts } from '../artifacts/collect';

export interface SessionLike { id: string; updatedAt?: number; pinnedAt?: number }
/** 活动会话实时态（chat store 直取）：running / pendingPerms / lastStopReason。 */
export interface LiveState { running: boolean; pendingPerms: unknown[]; lastStopReason: string }
export type SessionBadge = 'running' | 'waiting' | 'failed' | 'done' | null;

const ERROR_STOPS = new Set(['maxTokens', 'refusal']);

export function sessionBadge(_s: SessionLike, live: LiveState | null): SessionBadge {
  if (!live) return null;
  if (live.running) return 'running';
  if (live.pendingPerms.length > 0) return 'waiting';
  if (ERROR_STOPS.has(live.lastStopReason)) return 'failed';
  if (live.lastStopReason) return 'done'; // endTurn/toolUse：完成过回合即有消息
  return null;
}

/** 产物计数：复用 Task 3 collect（file_write/file_edit 同路径去重后条数）。 */
export function artifactCountOf(messages: { parts?: unknown }[]): number {
  return collectArtifacts(messages, []).length;
}
