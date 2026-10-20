import type { TokenUsage } from './usage';
import type { CompactMeta } from './compaction';

export type Role = 'user' | 'assistant';

/** 标签联合，对齐 OpenMinis parts_json（设计 §3.2）。未知 type 用 unknown 分支透传。 */
export type ContentPart =
  | { type: 'text'; value: string }
  | { type: 'toolUse'; value: { toolUseId: string; name: string; input: string; description?: string; thoughtSignature?: string } }
  | { type: 'toolResult'; value: { toolUseId: string; output: string; success: boolean; status: 'success' | 'failed' | 'cancelled' | 'unknown' } }
  | { type: 'mediaRef'; value: { id: string; relativePath: string; mimeType: string; originalFileName?: string; linuxPath?: string } }
  // 仅请求侧合成、绝不落库：loop 在构建 provider 请求时把 user 消息里的 mediaRef 就地替换成
  // 本形态（读附件桶文件 → base64）。落库它会把图片字节冗余进 parts_json，同步/导出全量放大。
  | { type: 'imageData'; value: { mimeType: string; base64: string } }
  // Anthropic 思考块：signature 是回放必需的校验签名；redactedData 对应供应商已脱敏的
  // redacted_thinking 块（无签名，只能原样回放脱敏串）。两者都缺=无签名历史块，回放时丢弃。
  | { type: 'thinking'; value: { text: string; signature?: string; redactedData?: string } }
  | { type: string; value: unknown };

// F02：TokenUsage 挪到 shared/usage.ts（多了缓存 / 推理维度、来源、估计与费用）。文件开头引入、这里原名导出：
// 本文件的 RawMessage.tokenUsage 与 usage 事件都要用这个名字，只写 export … from 不会在本模块里引入它。
export type { TokenUsage };

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

/** Q14：chat.messages.list 的可选参数 have。调用方手里已有这个会话按列表顺序的前 count 条，其中最后一条是 lastId
 *  （count 为 0 时不给 lastId）。 */
export interface MessagesHave { count: number; lastId?: string }
/** Q14：chat.messages.list 带 have 时的应答。接得上：只给排在 lastId 之后的消息（append，可以为空）。
 *  接不上：完整列表，与不带 have 时相同。旧引擎不认 have，给的也是完整列表。 */
export type MessagesListResult = RawMessage[] | { append: RawMessage[] };

export interface SessionMeta {
  id: string; title: string; modelBinding?: string;
  memoryEnabled?: boolean;       // 会话级记忆开关，默认 true（db.ts memory_enabled DEFAULT 1）
  workspaceRoot?: string;        // 会话绑定的真实项目目录；缺省 = 回落沙箱桶 sessions/<id>/workspace
  mcpDisabled?: string[];        // D5 会话禁用的 MCP server 名单（mcp_disabled_json；空 = 无禁用）
  assistantId?: string;          // J1 会话绑定的助手 id（悬空 = 助手已删，注入侧查无即跳过）
  createdAt: number; updatedAt: number; pinnedAt?: number;
}

/** F11B：已在其他设备删除、本机因为有对方没见过的内容而保留的会话（设备页「已在其他设备删除」）。 */
export interface RetainedSession {
  id: string; title: string;
  /** 发起删除的设备指纹（登记的 originDeviceId） */
  deletedBy: string;
  /** 发起端墙钟，仅展示 */
  deletedAt: number;
  /** 本机应用墓碑的时刻（sessions.remote_tombstoned_at） */
  retainedAt: number;
  messageCount: number;
  /** null = 无法判断（墓碑已压实且本机副本与删除方当时的不完全相同） */
  unseenCount: number | null;
  /** 本机标注条数（标注不同步，删除方不可能见过） */
  annotationCount: number;
}

/** F11B：广播 chat.sessions.lifecycle 的载荷。不含标题与任何消息内容。 */
export interface SessionLifecycleNotice {
  sessionId: string;
  kind: 'deleted' | 'tombstone-applied' | 'retained-released' | 'restored' | 'restore-applied' | 'purged';
  /** 这次变化之后的登记版本：奇数 = 已删除，偶数 = 已恢复 */
  v: number;
  origin: 'local' | 'remote';
  /** 做出这次删除或恢复的设备指纹 */
  byDevice: string;
  /** remote：本机是从哪台已配对设备得知的 */
  viaPeer?: string;
  retained?: boolean;
  unseenCount?: number | null;
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  /** D5 MCP 工具的原始 JSON Schema（provider 侧优先直用，嵌套结构不平铺）。
   *  平铺 parameters 仍填 tool_title 单参数——旧路径/审计/预检零影响；
   *  MCP 侧真实必填由本字段的 required 表达，平铺 required 只管 tool_title。 */
  rawInputSchema?: unknown;
}

/** Provider 入参消息（与 RawMessage 解耦：无持久化字段）。
 *  reasoningContent（W2a-4）：assistant 这一轮捕获到的推理原文（OpenAI 兼容端点的 delta.reasoning_content）。
 *  只在 assistant 且库里有值时才带（不产生值为 undefined 的键）；只有 deepseek-v4 族的请求体写出它——
 *  V4 多轮工具调用要求把推理原样带回，缺了就 400。其它构建器一概不看这个字段。 */
export interface AgentMessage { role: Role; parts: ContentPart[]; reasoningContent?: string }

/** 压缩摘要 marker（设计 §4.2「压缩」）：锚定 lastCompactedMessageId，合成 effectiveAgentHistory。 */
export interface CompactMarker {
  id: string;
  sessionId: string;
  summary: string;
  lastCompactedMessageId: string;
  createdAt: number;
  /** F03：结构化标记（覆盖区间、模型写的各小节、程序根据落库消息生成的记录）。只有本机按 v2 写下、且 summary 与锚点
   *  没被同步合并改写过的 marker 才有；没有值时对象上不带这个键（旧版本写的、同步来的都没有）。读的一方必须容忍缺省。 */
  meta?: CompactMeta;
}
