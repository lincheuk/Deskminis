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

export interface PermissionRequest { kind: 'shell' | 'file-write' | 'file-read' | BridgePermissionKind; detail: string; sessionId: string; toolTitle: string }
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
