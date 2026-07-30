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
export interface PermissionGateway { check(req: PermissionRequest): Promise<PermissionDecision> }

export interface ToolContext {
  sessionId: string; paths: MinisPaths; permissions: PermissionGateway;
  /** file_read 成功读取后的通知钩子（技能 use_count 采集点，M2c）；失败/被拒/超限不触发。 */
  onFileRead?: (absPath: string) => void;
}

export interface ToolExecutor {
  definition: AgentToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}
