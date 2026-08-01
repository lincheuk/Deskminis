/**
 * 桥触发探测（决策 4b）：从 shell 命令文本里启发式识别将触发哪些 windows-* 桥能力，
 * 结果放进 permission.request 广播的 meta.bridgeTriggers，供权限卡「双段告知」与
 * permission.respond 的桥双段合并授权（决策 4c）使用。
 *
 * 探测器是启发式：引号内/注释里的桥字样也会命中（假阳性）。假阳性的代价由
 * 一次性授权的 120s TTL 懒清理兜底（决策 4c 评审命门 2），此处不做语法级解析。
 */

import type { BridgePermissionKind } from '../tools/types';

/** 与 handlers.ts ROUTES 同款的七路由（tool|action → 权限 kind）。 */
const ROUTE_KINDS: Record<string, BridgePermissionKind> = {
  'windows-notify|show': 'bridge-notify',
  'windows-clipboard|get': 'bridge-clipboard-read',
  'windows-clipboard|set': 'bridge-clipboard-write',
  'windows-open|open': 'bridge-open',
  'windows-speak|say': 'bridge-speak',
  'windows-screenshot|capture': 'bridge-screenshot',
  'windows-device|info': 'bridge-device',
};

const PATTERN = /\bwindows-(notify|clipboard|open|speak|screenshot|device)\s+([a-zA-Z-]+)/gi;

/** 探测命令文本中的桥调用，返回去重保序的权限 kind 数组；无 action 段/未知 action 不计。 */
export function detectBridgeTriggers(command: string): BridgePermissionKind[] {
  const out: BridgePermissionKind[] = [];
  const seen = new Set<BridgePermissionKind>();
  for (const m of command.matchAll(PATTERN)) {
    const kind = ROUTE_KINDS[`windows-${m[1].toLowerCase()}|${m[2].toLowerCase()}`];
    if (kind && !seen.has(kind)) { seen.add(kind); out.push(kind); }
  }
  return out;
}
