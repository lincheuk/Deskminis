import { describe, it, expect } from 'vitest';
import { OpenAIProvider, buildOpenAIBody, type OpenAICompatFlags } from '../src/minisd/providers/openai';
import type { StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';

const REQ: StreamRequest = {
  messages: [{ role: 'user', parts: [{ type: 'text', value: 'hi' }] }],
  systemPrompt: 'sys',
  tools: [{ name: 'file_read', description: 'r', parameters: { path: { type: 'string', description: 'p' }, tool_title: { type: 'string', description: 't' } }, required: ['path', 'tool_title'] }],
  maxTokens: 2048, thinkingLevel: 'high',
};

describe('buildOpenAIBody 兼容 flag', () => {
  it('默认 flag 保持 M1 行为（stream_options + reasoning_effort）', () => {
    const b = buildOpenAIBody(REQ, 'qwen3') as any;
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.reasoning_effort).toBe('high');
  });
  it('reasoningEffort:false → 不发 reasoning_effort（Ollama 预设）', () => {
    const flags: OpenAICompatFlags = { reasoningEffort: false };
    const b = buildOpenAIBody(REQ, 'qwen3', flags) as any;
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.stream_options).toEqual({ include_usage: true });
  });
  it('includeStreamOptions:false → 不发 stream_options', () => {
    const b = buildOpenAIBody(REQ, 'm', { includeStreamOptions: false }) as any;
    expect(b.stream_options).toBeUndefined();
    expect(b.reasoning_effort).toBe('high');
  });
});

describe('OpenAIProvider 无 key 兼容（Ollama）', () => {
  function sseOk(): Response {
    const text = [
      'data: {"choices":[{"index":0,"delta":{"content":"本地"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    return new Response(text, { status: 200 });
  }

  it('apiKey 为空串 → 请求不带 authorization 头；流归一化照常', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const p = new OpenAIProvider({
      apiKey: '', modelId: 'qwen3', baseUrl: 'http://localhost:11434/v1', compat: { reasoningEffort: false },
      fetchImpl: async (_url, init) => { seenHeaders = (init?.headers ?? {}) as Record<string, string>; return sseOk(); },
    });
    const events: AgentStreamEvent[] = [];
    for await (const e of p.streamAgentMessage(REQ)) events.push(e);
    expect(seenHeaders?.authorization).toBeUndefined();
    expect(seenHeaders?.['content-type']).toBe('application/json');
    expect(events).toContainEqual({ kind: 'textDelta', text: '本地' });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'endTurn' });
  });

  it('apiKey 非空 → 照常带 authorization 头（M1 行为不变）', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const p = new OpenAIProvider({
      apiKey: 'sk-x', modelId: 'm', baseUrl: 'http://x/v1',
      fetchImpl: async (_url, init) => { seenHeaders = (init?.headers ?? {}) as Record<string, string>; return sseOk(); },
    });
    for await (const _ of p.streamAgentMessage(REQ)) void _;
    expect(seenHeaders?.authorization).toBe('Bearer sk-x');
  });
});
