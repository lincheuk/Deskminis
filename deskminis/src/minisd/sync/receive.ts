/**
 * F11B：对端载荷的唯一收包入口（监听方的 sync.push 处理器与拨号方的 pullFromPeer 都走这里）。
 *
 * 为什么收成一处：载荷有两种——内容（消息、摘要、会话行，可带偶数登记）与墓碑（登记为奇数）。
 * 墓碑不能直接落库：本机这个会话可能正在跑，要先让 run 停下、终端与 shell 释放，再在一个事务里写登记并处置内容
 * （与本机删除同序）。这件事只有装配处（index.ts）做得了，所以经 TombstoneHost 交给它；
 * 两条收包路径各写一遍分流，迟早有一条漏掉「先停再落」。src 下 mergeRemoteSession 的调用点只有这里（源码守卫钉住）。
 */
import type { ChatStore, MergeRemoteResult, TombstoneApplyResult } from '../store/chat-store';
import { isDeletedVersion } from './lifecycle';
import { parseWireLifecycle, type SyncPayload, type WireLifecycle } from './wire';

export type TombstoneOutcome =
  | TombstoneApplyResult
  /** 没有落库。paused = 本端暂停同步；closing = 进程正在关停；run-stopping = 这个会话的 run 还没停下（停稳后本机自行重试）；
   *  unpaired = 送来这条墓碑的设备此刻已不在配对表里，这条墓碑被丢弃。 */
  | { status: 'deferred'; reason: 'paused' | 'closing' | 'run-stopping' | 'unpaired' };

/** 由 index.ts 实现：停 run → 释放终端与 shell → 落库，与本机删除同序。
 *  落库之前（入口、每次 await 之后、延后重试的入口）复查：未关停、未暂停、fromPeer 仍在配对表里。 */
export interface TombstoneHost {
  applyRemoteTombstone(sessionId: string, t: WireLifecycle, fromPeer: string | undefined): Promise<TombstoneOutcome>;
}

export interface SyncReceiveResult extends MergeRemoteResult {
  /** 这是一个墓碑载荷时的结果。 */
  tombstone?: TombstoneOutcome['status'];
}

const SESSION_ID_MAX = 128;

/**
 * 收下对端的一个载荷。
 *  - sessionId 必须是 1..128 字符的字符串；payload 必须是对象且 messages、markers 是数组，否则抛 Error('同步载荷不合规')；
 *  - lifecycle 解析后为奇数 → 墓碑：交给宿主（没有宿主时直接落库，只在单测里出现），消息与摘要一概不看；
 *  - 否则 → 内容：ChatStore.mergeRemoteSession（入口闸在它的事务第一步）。
 * 畸形的 lifecycle 解析为 undefined，按「不带版本」的内容处理——垃圾输入不会被当成墓碑。
 */
export async function receiveRemotePayload(
  chat: ChatStore, host: TombstoneHost | undefined, sessionId: string, payload: unknown, fromPeer: string | undefined,
): Promise<SyncReceiveResult> {
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > SESSION_ID_MAX) throw new Error('同步载荷不合规');
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('同步载荷不合规');
  const p = payload as { messages?: unknown; markers?: unknown; lifecycle?: unknown };
  if (!Array.isArray(p.messages) || !Array.isArray(p.markers)) throw new Error('同步载荷不合规');

  const lifecycle = parseWireLifecycle(p.lifecycle);
  if (lifecycle && isDeletedVersion(lifecycle.v)) {
    const outcome = host
      ? await host.applyRemoteTombstone(sessionId, lifecycle, fromPeer)
      : chat.applyTombstone(sessionId, lifecycle, { fromPeer });
    const out: SyncReceiveResult = {
      mergedCount: 0, orphanMarkerIds: [],
      // 登记换成了对端的才算有变化；调用方看到 tombstone 字段就不会把它当成「同步了 N 条」广播
      hasChange: outcome.status === 'applied' || outcome.status === 'superseded',
      tombstone: outcome.status,
    };
    const after = chat.wireLifecycle(sessionId);
    if (after) out.lifecycle = after;
    return out;
  }
  return chat.mergeRemoteSession(payload as SyncPayload, sessionId, { fromPeer });
}
