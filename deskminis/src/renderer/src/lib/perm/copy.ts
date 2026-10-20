/** 权限卡文案映射（设计 §5.2-2/3 + 审计 H3）：七类桥专属标题 + 既有三类保留 + 未知兜底。
 *  permTitle 用于卡标题（「请求 xx」）；permTriggerLabel 用于 shell 卡双段告知的触发项短标（「xx 权限」）。 */

const TITLES: Record<string, string> = {
  'shell': '请求执行命令',
  'file-write': '请求写入文件',
  'file-read': '请求读取文件',
  'web-fetch': '请求访问网络',
  'web-search': '请求网络搜索',
  'mcp': '请求调用 MCP 工具',
  'bridge-notify': '请求发送通知',
  'bridge-clipboard-read': '请求读取剪贴板',
  'bridge-clipboard-write': '请求写入剪贴板',
  'bridge-open': '请求打开链接或文件',
  'bridge-speak': '请求语音播报',
  'bridge-screenshot': '请求截屏',
  'bridge-device': '请求读取设备信息',
};

const TRIGGER_LABELS: Record<string, string> = {
  'web-fetch': '访问网络权限',
  'bridge-notify': '通知权限',
  'bridge-clipboard-read': '读取剪贴板权限',
  'bridge-clipboard-write': '写入剪贴板权限',
  'bridge-open': '打开链接或文件权限',
  'bridge-speak': '语音播报权限',
  'bridge-screenshot': '截屏权限',
  'bridge-device': '读取设备信息权限',
};

export function permTitle(kind: string): string {
  return TITLES[kind] ?? '请求权限';
}

export function permTriggerLabel(kind: string): string {
  return TRIGGER_LABELS[kind] ?? '权限';
}

/** F13：权限卡因相关服务被停用 / 配置被修改而作废时，留给当前会话的事件条。 */
export const PERM_INVALIDATED_NOTE = '权限请求已失效（相关服务被停用或配置已修改），没有执行';

/** F13：点了按钮、引擎回「没有生效」（permission.respond 的 applied:false）时留给当前会话的事件条。
 *  settled 是引擎告知的这张卡的了结方式；没有（引擎不认识这张卡、或卡仍待批但答复来自发卡之后才建立的连接）就说「已失效」。
 *  以前晚到的点击悄悄没生效：卡摘了、什么也没发生，用户以为批了。 */
export function permLateNote(settled?: { reason?: string }): string {
  const how = ((): string => {
    switch (settled?.reason) {
      case 'timeout': return '已超时';
      case 'answered': return '已在别处处理';
      case 'cancelled': case 'session-deleted': case 'shutdown': return '已取消';
      case 'invalidated': default: return '已失效';
    }
  })();
  return `这张权限卡${how}，你的选择没有生效`;
}

/** F06：断线时点下的权限选择，应答随断线丢了；重连后查到这张卡已经了结（state.outcomes 的 settled），按真实原因说它的结局。
 *  引擎分不出「已处理」的那一次是不是本窗口断线前的点击，所以只说卡的结局，不说「你的选择生效了」。
 *  原因分离沿用 F13：超时、取消、失效、过期不说成用户拒绝。
 *  source:'broker' = 本引擎进程了结的卡（settled 是 permission.resolved 的同一份）；
 *  source:'ledger' = 执行账本里的审批记录（可以是前一代引擎的）。 */
export function permOutcomeNote(o:
  | { source: 'broker'; settled?: { reason?: string; decision?: string } }
  | { source: 'ledger'; approval?: { state?: string; reason?: string; cause?: string } },
): string {
  const how = ((): string => {
    if (o.source === 'broker') {
      switch (o.settled?.reason) {
        case 'answered': return o.settled.decision === 'allow' ? '已按「允许」处理' : '已按「拒绝」处理';
        case 'timeout': return '已超时，没有放行';
        case 'cancelled': case 'session-deleted': case 'shutdown': return '已随运行取消（停止、删除会话或后台服务关停），没有执行';
        case 'invalidated': return '已失效（相关服务被停用或配置已修改），没有执行';
        default: return '没有放行';
      }
    }
    const a = o.approval;
    if (a?.state === 'allowed') return '已按「允许」处理';
    if (a?.state === 'expired') return '已随后台服务重启失效，没有批准，也没有执行';
    switch (a?.reason) {
      case 'user-denied': return '已按「拒绝」处理';
      case 'timeout': return '已超时，没有放行';
      case 'cancelled': return '已随运行取消（停止、删除会话或后台服务关停），没有执行';
      case 'invalidated': return '已失效（相关服务被停用或配置已修改），没有执行';
      default: return '没有放行';
    }
  })();
  return `这张权限卡${how}。对应操作是否执行以对话里的工具结果为准`;
}
