/**
 * F13：权限的唯一询问入口。
 *
 * 所有调用方（文件、Office、搜索、shell、web、MCP、桥、调度器的包装层）都从这里拿带原因的结果，
 * 不再各自调 gateway.check 再把二值的 'deny' 说成「被用户拒绝」。
 *
 * 这个文件只依赖 shared/permission 与 ./types（后者只取类型），不引网关实现（./permissions）、不做命令分类：
 * 调度器引的就是它，F04 的守卫要的是调度器够不着网关实现与分类器。文案在 permission-text.ts。
 *
 * 失败关闭：网关交回的任何不认识的值都是拒绝；旧式二值网关只有恰好 'allow' 才放行。
 */
import { allowed, cancelCauseOf, denied, parsePermissionOutcome, type PermissionDenied, type PermissionOutcome } from '../../shared/permission';
import type { PermissionAskOptions, PermissionGateway, PermissionRequest, ToolContext } from './types';

/** 网关一侧的唯一归一点。网关抛错原样外抛（工具落「工具执行异常」，不执行）。 */
export async function decidePermission(gateway: PermissionGateway, req: PermissionRequest, opts?: PermissionAskOptions): Promise<PermissionOutcome> {
  if (typeof gateway.decide === 'function') {
    // 字符串、缺 via 的对象、不认识的 reason 一律按无效结果处理：形状不对的东西不是放行
    return parsePermissionOutcome(await gateway.decide(req, opts));
  }
  // 旧式二值网关：只有 check，说不出原因。恰好 'allow' 才放行；'deny' 不说成用户拒绝，其余值当无效
  const raw: unknown = await gateway.check(req);
  if (raw === 'allow') return allowed('legacy-binary');
  return denied('unspecified', raw === 'deny' ? 'legacy-binary' : 'invalid-outcome');
}

/** noteDenied 的安全包装：网关没实现或抛错都不影响调用方。 */
export function reportDenied(gateway: PermissionGateway, req: PermissionRequest, d: PermissionDenied, opts?: Pick<PermissionAskOptions, 'toolUseId' | 'origin'>): void {
  try { gateway.noteDenied?.(req, d, opts); } catch { /* 记审计是尽力而为：拒绝本身已经成立 */ }
}

/** W8：免审写入与记忆写入在落盘之前同样拒绝，复用网关的审计出口。 */
export function planWriteDenial(gateway: PermissionGateway, req: PermissionRequest): PermissionDenied | undefined {
  if (!gateway.isPlanMode?.()) return undefined;
  const d = denied('rule-blocked', 'plan-mode');
  reportDenied(gateway, req, d);
  return d;
}

/**
 * 工具一侧的唯一询问入口 = decidePermission + 取消优先。
 *  - 进门已取消：不问。
 *  - 批准晚于取消：不放行。权限等待可长达 90 秒，已 abort 的 signal 不补发事件，闸后必须重查；
 *    一张卡被批准了、这次调用却没有执行时记一条（带同一个 requestId），否则审计里只看得到 answered / allow。
 *    没弹卡的放行（档位 bypass、会话授权）被取消不记：取消一次没弹卡的调用本来就不进权限审计。
 */
export async function askPermission(ctx: Pick<ToolContext, 'permissions' | 'signal'>, req: PermissionRequest): Promise<PermissionOutcome> {
  if (ctx.signal?.aborted) return denied('cancelled', cancelCauseOf(ctx.signal));
  const o = await decidePermission(ctx.permissions, req, { signal: ctx.signal });
  if (ctx.signal?.aborted) {
    const c = denied('cancelled', cancelCauseOf(ctx.signal), { requestId: o.requestId });
    if (o.decision === 'allow' && o.requestId !== undefined) reportDenied(ctx.permissions, req, c);
    return c;
  }
  return o;
}
