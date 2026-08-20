/** 欢迎态判据（I3）：会话流完全空白——无历史消息、无实时活动、无事件条。
 *
 *  为什么抽纯模块：App.vue（欢迎态收起工作台）与 ChatView.vue（渲染 hero 空态）
 *  必须用同一判据，各写一份布尔式必然漂移——漂移的症状是「工作台没了但空态没出现」
 *  这类半截欢迎页。快照字段与 ChatView 原 hasLive/isEmpty 的组成逐项对应。
 *
 *  乐观消息（local- id）也算 messages 的一员：发出瞬间 messages 非空，欢迎态立即退场，
 *  不会出现「消息已发、页面还在欢迎态」的闪回（设计稿 §5 红线）。 */
export interface BlankSnapshot {
  messages: readonly unknown[];
  running: boolean;
  streamingText: string;
  toolCards: readonly unknown[];
  pendingPerms: readonly unknown[];
  retryNote: unknown;
  eventNotes: readonly unknown[];
}

export function isBlankState(s: BlankSnapshot): boolean {
  const live = s.running || !!s.streamingText || s.toolCards.length > 0
    || s.pendingPerms.length > 0 || !!s.retryNote;
  return s.messages.length === 0 && !live && s.eventNotes.length === 0;
}
