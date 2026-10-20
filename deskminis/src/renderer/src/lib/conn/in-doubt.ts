/**
 * F06：断线时在途的调用——哪些算「写」、怎么认出「已发出、结果未知」的拒绝。
 *
 * 断线那一刻已经发出、没等到应答的调用，渲染端从不重发（引擎可能已经执行了）。重连之后要向用户如实交代：
 * 发送与权限答复各有专门的核对（state.outcomes）；其余的写调用只能说「结果未知，请核对」。
 * 只读调用丢了应答没有后果（重连后界面会整体重取），不算在内。
 *
 * 纯函数、无依赖：store 直接从这里取，不经 rpc 模块（既有用例把 rpc 模块整个桩掉，桩里只有 rpc 对象）。
 */

/** 只读方法的白名单。不在里面的一律按「写」处理——不认识的新方法宁可多说一句「结果未知」，也不默默略过。 */
const READ_ONLY: ReadonlySet<string> = new Set([
  'state.attach', 'state.outcomes',
  'assistants.list',
  'attachments.read', 'attachments.status',
  'chat.input.list', 'chat.annotations.list', 'chat.contextInfo', 'chat.messages.list', 'chat.sessions.list', 'chat.runs.snapshot',
  'control.status',
  'cron.list',
  'files.list', 'files.read', 'office.read',
  'market.checkUpdates', 'market.detail', 'market.installPlan', 'market.installed', 'market.search', 'market.sources.list',
  // 试连不落库；失败由界面内联展示
  'mcp.servers.list', 'mcp.servers.test',
  'modelgroup.list',
  'permission.getPreset',
  'provider.catalog.get', 'provider.getDefault', 'provider.instances.list', 'provider.models.fetch', 'provider.runtime.resolve',
  'remote.status',
  'search.provider.get',
  'skills.list', 'skills.importStatus',
  // 终端面板在重连后自己重新挂接（linkGeneration），这次挂接丢了应答不需要用户核对
  'terminal.attach',
  'workspace.get',
]);

export function isWriteMethod(method: string): boolean {
  return !READ_ONLY.has(method);
}

const MARK = 'inFlightLoss';

/** 给「断线时已发出、结果未知」的拒绝打标记（message 不变，仍是断线那句话）。 */
export function markInFlightLoss<E extends Error>(e: E): E {
  (e as unknown as Record<string, unknown>)[MARK] = true;
  return e;
}

/** 这个错误是不是「调用已发出、应答随断线丢了」。断线之后才发起、当场被拒的调用不带这个标记（它根本没发出去）。 */
export function isInFlightLoss(e: unknown): boolean {
  return e !== null && typeof e === 'object' && (e as Record<string, unknown>)[MARK] === true;
}
