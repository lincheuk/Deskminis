/** 权限卡文案映射（设计 §5.2-2/3 + 审计 H3）：七类桥专属标题 + 既有三类保留 + 未知兜底。
 *  permTitle 用于卡标题（「请求 xx」）；permTriggerLabel 用于 shell 卡双段告知的触发项短标（「xx 权限」）。 */

const TITLES: Record<string, string> = {
  'shell': '请求执行命令',
  'file-write': '请求写入文件',
  'file-read': '请求读取文件',
  'web-fetch': '请求访问网络',
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
