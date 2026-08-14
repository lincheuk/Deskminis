export type Role = 'user' | 'assistant';

/** 标签联合，对齐 OpenMinis parts_json（设计 §3.2）。未知 type 用 unknown 分支透传。 */
export type ContentPart =
  | { type: 'text'; value: string }
  | { type: 'toolUse'; value: { toolUseId: string; name: string; input: string; description?: string; thoughtSignature?: string } }
  | { type: 'toolResult'; value: { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' } }
  | { type: 'mediaRef'; value: { id: string; relativePath: string; mimeType: string; originalFileName?: string; linuxPath?: string } }
  // Anthropic 思考块：signature 是回放必需的校验签名；redactedData 对应供应商已脱敏的
  // redacted_thinking 块（无签名，只能原样回放脱敏串）。两者都缺=无签名历史块，回放时丢弃。
  | { type: 'thinking'; value: { text: string; signature?: string; redactedData?: string } }
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
  // M3b 同步字段（设计 §4.2）
  originDeviceId?: string;      // 生成端 fingerprint；缺省=本机；旧数据迁移后='legacy'
  createdLocallyAt?: number;    // 端内单调时钟（epoch 秒）；缺省=createdAt
}

export interface SessionMeta {
  id: string; title: string; modelBinding?: string;
  memoryEnabled?: boolean;       // 会话级记忆开关，默认 true（db.ts memory_enabled DEFAULT 1）
  workspaceRoot?: string;        // 会话绑定的真实项目目录；缺省 = 回落沙箱桶 sessions/<id>/workspace
  createdAt: number; updatedAt: number; pinnedAt?: number;
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';
export type StopReason = 'endTurn' | 'toolUse' | 'maxTokens' | 'refusal';

export type AgentStreamEvent =
  | { kind: 'textDelta'; text: string }
  | { kind: 'thinkingDelta'; text: string }
  | { kind: 'toolInputDelta'; toolUseId: string; name: string; accumulatedJson: string }
  | { kind: 'toolCallComplete'; toolUseId: string; name: string; input: string; thoughtSignature?: string }
  // 一个 thinking 块收尾时发出（含完整文本与回放必需签名），供 loop 持久化
  | { kind: 'thinkingComplete'; text: string; signature?: string; redactedData?: string }
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

/** 压缩摘要 marker（设计 §4.2「压缩」）：锚定 lastCompactedMessageId，合成 effectiveAgentHistory。 */
export interface CompactMarker {
  id: string;
  sessionId: string;
  summary: string;
  lastCompactedMessageId: string;
  createdAt: number;
}
