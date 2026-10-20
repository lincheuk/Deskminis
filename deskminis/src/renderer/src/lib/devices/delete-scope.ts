/**
 * F11B：删除会话会影响到哪里（删除确认里的那一句说明），以及设备页配对入口旁的说明。纯函数与文案，便于单测。
 *
 * 为什么不能把「手里的设备列表是空的」直接当成「没有已配对的设备」：列表的初值就是空数组，只有设备页挂载时才去拉；
 * 没开过设备页的窗口第一次点删除时手里是初值。对破坏性操作，把范围说小是错的那一边——
 * 所以「只影响这台」只在本次确认里的刷新成功、应答确实是设备表、表为空时才说。
 *
 * 为什么 local 的文案不写「只删这台设备上的」：删除留下的记录不按设备划范围。以后配对（或重新配对）的设备上
 * 如果还有这个会话，对账时同样会被删除——防止旧副本把已删的会话带回来与「以前的删除不传给以后配对的设备」不能两全。
 */

/** 本次删除确认里设备列表的状态：checking = 刷新还没回来；fresh = 刷新成功且应答是设备表；failed = 刷新失败或应答不是设备表。 */
export type DeviceListState = 'checking' | 'fresh' | 'failed';
export type DeleteScope = 'checking' | 'unknown' | 'local' | 'paused' | 'propagate';

/** 手里的列表非空时（哪怕是旧的、这次刷新还没回来或失败了）按会传播说：只会把范围说大，不会说小。 */
export function deleteScope(pairedCount: number, syncPaused: boolean, list: DeviceListState): DeleteScope {
  if (pairedCount > 0) return syncPaused ? 'paused' : 'propagate';
  if (list === 'fresh') return 'local';
  return list === 'checking' ? 'checking' : 'unknown';
}

export const DELETE_SCOPE_TEXT: Readonly<Record<DeleteScope, string>> = Object.freeze({
  checking: '正在确认有没有已配对的设备…',
  unknown: '没能确认有没有已配对的设备。如果有，它们也会删除这个会话；以后配对的设备上如果还有它，也会被删除。',
  local: '现在没有已配对的设备，只影响这台设备。以后配对（或重新配对）的设备上如果还有这个会话，也会被删除。',
  paused: '同步已暂停：现在只删这台设备上的；恢复同步后，已配对的设备也会删除它。',
  propagate: '已配对的设备也会删除它，离线的等下次连上；不支持删除同步的旧版本会留着自己的副本。',
});

/** 设备页「发起配对」「加入配对」两个入口旁的同一句：配对是删除开始跨设备生效的那一步，要在按下按钮之前看得到。 */
export const PAIRING_DELETE_NOTE = '配对后，这台设备上已经删除的会话，在对方设备上如果还有，也会被删除；对方有你删除时没见过的内容时会留下，等对方处理。反过来也一样。';

/** 保留副本一行里的内容说明。unseenCount 为 null = 无法确认（删除记录里的消息清单已压实，且本机副本与删除方当时的不完全相同）。 */
export function retainedSummary(r: { messageCount: number; unseenCount: number | null; annotationCount: number }): string {
  const base = r.unseenCount === null
    ? `${r.messageCount} 条消息，无法确认对方是否全部见过`
    : `${r.messageCount} 条消息，其中 ${r.unseenCount} 条对方没见过`;
  return r.annotationCount > 0 ? `${base}，${r.annotationCount} 条本机标注` : base;
}
