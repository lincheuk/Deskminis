import type { AgentToolDefinition } from '../../shared/types';
import type { MinisPaths } from '../paths';

export interface ToolOutcome { output: string; success: boolean }

export interface PermissionRequest { kind: 'shell' | 'file-write'; detail: string; sessionId: string; toolTitle: string }
export type PermissionDecision = 'allow' | 'deny';
export interface PermissionGateway { check(req: PermissionRequest): Promise<PermissionDecision> }

export interface ToolContext { sessionId: string; paths: MinisPaths; permissions: PermissionGateway }

export interface ToolExecutor {
  definition: AgentToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}
