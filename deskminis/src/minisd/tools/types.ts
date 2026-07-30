import type { AgentToolDefinition } from '../../shared/types';
import type { MinisPaths } from '../paths';

export interface ToolOutcome { output: string; success: boolean }

export interface PermissionRequest { kind: 'shell' | 'file-write' | 'file-read'; detail: string; sessionId: string; toolTitle: string }
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
