/**
 * F13：权限拒绝的文案——全仓只有这一张表。
 *
 * 给模型的话要说真实原因与可行的下一步：超时不是用户点了拒绝；规则拦截不能建议绕过、也不说「可在设置里调整」；
 * 取消就是「[已取消]」。「被用户拒绝」与「可在设置-权限中调整」只出现在 user-denied 一行。
 *
 * 只有工具、MCP、桥引这个文件；调度器不引（它为了危险命令要用分类器，分类器在网关实现里）。
 */
import type { PermissionDenied } from '../../shared/permission';
import type { PermissionRequest, ToolOutcome } from './types';
import { classifyShellCommand, MAX_UNANSWERED_STREAK } from './permissions';

/** 危险命令被规则拦下时回给模型的话（W1b-2g）。classifyShellCommand 判 danger 的命令在网关里是 notAllowed：
 *  不询问、三个档位都拒——没有哪个用户点过拒绝，设置里也调不开。照旧说「被用户拒绝（可在设置-权限中调整）」，
 *  模型会以为换个档位、再问一次就能过，或者向用户转述一个没发生过的拒绝。
 *  括号里只举危险表里真有的几类；「不要改写绕过」是因为规则按写法认，换个写法的命令会落到询问或（完全访问下）直接执行。 */
export const RULE_BLOCKED = '命令未执行：它命中了危险命令规则（删除、格式化、改注册表、结束进程、定义函数或别名等），由规则直接拦下，'
  + '不是用户拒绝的，换任何权限档位也不会放行。请不要改写命令绕过规则；确实需要的话，把命令和理由告诉用户，由用户决定是否自己执行。'
  // 危险规则按整段文本匹配，读 shutdown.ps1、搜 Stop-Process 字样这类无害的读和搜也会被拦（W1b-2g 审查）；
  // 不给出路的话，听话的模型会把它们推给用户，而文件工具不走这条规则
  + '如果只是要读的文件、要搜的文本里恰好含这些字样，改用 file_read / file_grep。';

/** 每个 kind 的名词。以 PermissionRequest['kind'] 为键：新增 kind 不补这里，tsc 过不去。
 *  七个桥类目走 bridgeDenialMessage，这里只为把表填齐。 */
const NOUNS: Record<PermissionRequest['kind'], string> = {
  shell: '命令', 'file-write': '写入', 'file-read': '读取', 'web-fetch': '抓取', 'web-search': '搜索', mcp: 'MCP 调用',
  'bridge-notify': '桥操作', 'bridge-clipboard-read': '桥操作', 'bridge-clipboard-write': '桥操作', 'bridge-open': '桥操作',
  'bridge-speak': '桥操作', 'bridge-screenshot': '桥操作', 'bridge-device': '桥操作',
};

type TextReq = Pick<PermissionRequest, 'kind' | 'detail'>;

/** 给模型的话。 */
export function denialText(d: PermissionDenied, req: TextReq): string {
  const noun = NOUNS[req.kind] ?? '操作';
  // 路径只有文件两类带：detail 是逐字的宿主路径，模型据此知道是哪一个文件没动
  const where = req.kind === 'file-write' || req.kind === 'file-read' ? `: ${req.detail}` : '';
  switch (d.reason) {
    case 'user-denied':
      return `${noun}被用户拒绝${where}（可在设置-权限中调整）`;
    case 'timeout': {
      if (d.cause === 'unattended') {
        return `${noun}未执行${where}：本轮已连续 ${MAX_UNANSWERED_STREAK} 次权限请求无人答复，这次没有再询问。`
          + '请停止重试需要批准的操作，把需要批准的内容和理由告诉用户；用户发来新消息后会重新询问。';
      }
      const seconds = d.waitedMs !== undefined ? Math.round(d.waitedMs / 1000) : 0;
      return `${noun}未执行${where}：权限请求${seconds >= 1 ? `等了 ${seconds} 秒` : ''}没有人答复，已自动按未批准处理。`
        + '这不是用户点了拒绝，权限档位也没有改变。用户可能暂时不在：不要立刻重复同一个请求，先用文字说明需要批准什么、为什么，等用户回复后再试。';
    }
    case 'rule-blocked':
      if (d.cause === 'shell-danger') return RULE_BLOCKED;
      if (d.cause === 'plan-mode') return `${noun}未执行${where}：当前是「只读 / 计划」档，不能改动任何东西——由规则直接拦下，没有弹出询问，也不是用户拒绝的。请不要换写法或换别的工具绕过；请先把要做的改动写成方案告诉用户（改哪些文件、怎么改、要跑哪些命令）；用户切换到其它档位后再执行。`;
      return `${noun}未执行${where}：当前权限规则不允许这类操作，由规则直接拦下——没有弹出询问，也不是用户拒绝的。`
        + '请不要换写法或换别的工具绕过；确实需要的话，把要做的事和理由告诉用户，由用户决定。';
    case 'cancelled':
      return '[已取消]';
    case 'invalidated':
      // F05：批准到了，但「已放行」没能写进执行账本。照样执行的话，崩溃后这次调用会被说成「未执行」，模型据此重做就是重复副作用
      if (d.cause === 'record-failed') {
        return `${noun}未执行：批准已收到，但执行记录写入失败，这次批准已失效。为避免留下没有记录的操作，这次没有执行；需要的话请重新发起（会重新询问）。`;
      }
      return `${noun}未执行：这次权限请求已失效（相关配置在等待期间被停用或修改），批准没有生效。需要的话请重新发起。`;
    case 'unspecified':
    default:
      // 旧式二值网关说不出原因。危险命令沿用现状：规则不随网关实现变，照样说是规则拦下的
      if (req.kind === 'shell' && classifyShellCommand(req.detail) === 'danger') return RULE_BLOCKED;
      return `${noun}未执行${where}：没有获得许可（权限网关没有说明原因，不能当作用户拒绝）。`;
  }
}

export function permissionFailure(d: PermissionDenied, req: TextReq): ToolOutcome {
  return { output: denialText(d, req), success: false };
}

/** 桥信封里的 error.message（error.code 恒为 PERMISSION_DENIED，另带 error.reason）。 */
export function bridgeDenialMessage(d: PermissionDenied, req: Pick<PermissionRequest, 'detail'>): string {
  switch (d.reason) {
    case 'user-denied': return `权限拒绝: ${req.detail}`;
    case 'timeout':
      // 这句话两头都会看到：agent 的 shell 子进程里是模型（bridge-cli 退出码 2，容易原样重跑），终端面板里是用户本人
      if (d.cause === 'unattended') {
        // 该会话有 run 在跑、又已连续无人答复到上限：这次没有弹卡。run 结束后桥询问不再受限，所以「本回合结束后」也恢复
        return `本轮已连续 ${MAX_UNANSWERED_STREAK} 次权限请求无人答复，这次没有再询问，未执行: ${req.detail}。`
          + '请停止重试，把需要批准的内容告诉用户；用户发来新消息或本回合结束后会重新询问。';
      }
      return `权限请求超时无人答复，未执行: ${req.detail}。这不是用户点了拒绝；用户可能暂时不在，不要立刻重试同一条命令。`;
    case 'rule-blocked':
      if (d.cause === 'plan-mode') return denialText(d, { kind: 'bridge-open', detail: req.detail });
      return `权限规则不允许，未执行: ${req.detail}`;
    case 'cancelled': return `权限请求已取消，未执行: ${req.detail}`;
    case 'invalidated': return `权限请求已失效，未执行: ${req.detail}`;
    case 'unspecified':
    default: return `未获许可，未执行: ${req.detail}`;
  }
}
