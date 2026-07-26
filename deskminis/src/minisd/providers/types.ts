import type { AgentMessage, AgentStreamEvent, AgentToolDefinition, ThinkingLevel } from '../../shared/types';

export interface StreamRequest {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools: AgentToolDefinition[];
  maxTokens: number;
  thinkingLevel: ThinkingLevel;
}

export interface AgentProvider {
  readonly name: string;
  readonly modelId: string;
  streamAgentMessage(req: StreamRequest, signal?: AbortSignal): AsyncIterable<AgentStreamEvent>;
}

export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.status !== undefined && [500, 502, 503, 504, 529].includes(opts.status));
  }
}

export type FetchLike = typeof fetch;
