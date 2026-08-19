import type { AgentToolDefinition } from '../../shared/types';
import type { MinisPaths } from '../paths';

export interface ToolOutcome { output: string; success: boolean }

/** windows-* 桥的能力类目：kind 即权限类目（与 file-write/file-read 同款 1:1 路由）。 */
export type BridgePermissionKind =
  | 'bridge-notify'
  | 'bridge-clipboard-read'
  | 'bridge-clipboard-write'
  | 'bridge-open'
  | 'bridge-speak'
  | 'bridge-screenshot'
  | 'bridge-device';

/** 审批前变更预览（仅 file-write 类请求携带）：把 ToolLine 执行后的 diff 能力前移到批准时刻，
 *  写文件不再是盲批。可选字段：shell/桥类请求的信息已由 detail 完整表达，不构造 preview。
 *  注意：preview 只进权限卡广播，不进审计落盘（审计只记有无布尔，见 minisd/index.ts）。 */
export interface PermPreview { oldText: string; newText: string }

export interface PermissionRequest { kind: 'shell' | 'file-write' | 'file-read' | 'web-fetch' | 'web-search' | 'mcp' | BridgePermissionKind; detail: string; sessionId: string; toolTitle: string; preview?: PermPreview }
export type PermissionDecision = 'allow' | 'deny';
export interface PermissionGateway {
  check(req: PermissionRequest): Promise<PermissionDecision>;
  /** M4 Task 2：查询会话是否曾授权过桥（sessionBridgeGrants 或 bridgeOnce 有记录）。用于 systemPrompt 工厂决定注入完整/精简桥段落。 */
  hasBridgeGrant(sessionId: string): boolean;
}

export interface ToolContext {
  sessionId: string; paths: MinisPaths; permissions: PermissionGateway;
  /** file_read 成功读取后的通知钩子（技能 use_count 采集点，M2c）；失败/被拒/超限不触发。 */
  onFileRead?: (absPath: string) => void;
  /** 会话级取消信号（chat.cancel 的 controller.signal）。工具收到后应立即中止：
   *  shell 长命令/文件写入不理会它的话，用户点了停止 UI 已空闲而动作还在跑。 */
  signal?: AbortSignal;
}

export interface ToolExecutor {
  definition: AgentToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}
