export type Role = 'user' | 'assistant';

/** 标签联合，对齐 OpenMinis parts_json（设计 §3.2）。未知 type 用 unknown 分支透传。 */
export type ContentPart =
  | { type: 'text'; value: string }
  | { type: 'toolUse'; value: { toolUseId: string; name: string; input: string; description?: string; thoughtSignature?: string } }
  | { type: 'toolResult'; value: { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' } }
  | { type: 'mediaRef'; value: { id: string; relativePath: string; mimeType: string; originalFileName?: string; linuxPath?: string } }
  | { type: string; value: unknown };

export interface TokenUsage { inputTokens: number; outputTokens: number }

export interface RawMessage {
  id: string;               // UUID 大写
  sessionId: string;
  role: Role;
  parts: ContentPart[];
  createdAt: number;        // epoch 秒（浮点）
  updatedAt: number;
  sortOrder: number;
  tokenUsage?: TokenUsage;
  reasoningContent?: string;
  streamInterruptCount: number;
  errorInfo?: string;       // 设备本地列，不同步
}

export interface SessionMeta {
  id: string; title: string; modelBinding?: string;
  createdAt: number; updatedAt: number; pinnedAt?: number;
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';
export type StopReason = 'endTurn' | 'toolUse' | 'maxTokens' | 'refusal';

export type AgentStreamEvent =
  | { kind: 'textDelta'; text: string }
  | { kind: 'thinkingDelta'; text: string }
  | { kind: 'toolInputDelta'; toolUseId: string; name: string; accumulatedJson: string }
  | { kind: 'toolCallComplete'; toolUseId: string; name: string; input: string }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'done'; stopReason: StopReason };

export interface AgentToolParam {
  type: 'string' | 'integer' | 'boolean';
  description: string;
  enumValues?: string[];
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, AgentToolParam>; // 必含 tool_title
  required: string[];
}

/** Provider 入参消息（与 RawMessage 解耦：无持久化字段） */
export interface AgentMessage { role: Role; parts: ContentPart[] }
