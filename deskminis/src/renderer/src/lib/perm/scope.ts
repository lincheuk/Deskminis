/** W2b-2 权限卡按会话区分（止血设计稿 §2「渲染端」、§3 第 6 条）：从待批的卡看会话，三种看法，纯函数。
 *
 *  卡片的 sessionId 取自引擎广播的 PermissionRequest.sessionId（必填），卡片按到达先后排在 store 的 pendingPerms 里。
 *  StageChat、NavRail、TaskPanel、WorkspacePanel 四处共用这一份判据，不各写一遍 filter——
 *  以前它们都直接读全局的 pendingPerms：B 的卡渲染进 A 的对话流，任务面板替别的会话报数。
 *  不写成 store getter：getter 的方法语法会被能力入口清单的自守例当成 action 数
 *  （tests/mu6-capability-wiring 的「store 里零 UI 调用的 action」），纯函数也更好单测。 */

interface Scoped { sessionId: string }

/** 某个会话自己的卡，保持到达先后。StageChat 只渲染当前会话的这些，任务面板与工作区面板的计数也只数这些。 */
export function permsOf<P extends Scoped>(perms: readonly P[], sessionId: string): P[] {
  return perms.filter(p => p.sessionId === sessionId);
}

/** 有卡在等批准的会话，去重，按各自最早那张卡的到达先后（Set 保持插入顺序）。
 *  某个会话在不在等就是 `.has(id)`——NavRail 据此给会话行标盾牌。 */
export function waitingSessionIds(perms: readonly Scoped[]): Set<string> {
  return new Set(perms.map(p => p.sessionId));
}

/** 除当前会话之外还在等批准的会话，按最早那张卡的到达先后。长度就是「另有 N 个会话在等你批准」的 N；
 *  排第一的是点提示时切过去的那个——每张卡的超时一样长（minisd 的 90 秒），最早到的离被自动拒绝最近。 */
export function waitingElsewhere(perms: readonly Scoped[], activeId: string): string[] {
  return [...waitingSessionIds(perms)].filter(id => id !== activeId);
}
