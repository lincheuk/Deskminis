import { describe, it, expect } from 'vitest';
import { OpenAIProvider, buildOpenAIBody } from '../src/minisd/providers/openai';
import type { StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';

const REQ: StreamRequest = {
  messages: [
    { role: 'user', parts: [{ type: 'text', value: 'hi' }] },
    { role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'file_read', input: '{"path":"a.txt","tool_title":"读文件"}' } }] },
    { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'content', success: true, status: 'success' } }] },
  ],
  systemPrompt: 'sys',
  tools: [{ name: 'file_read', description: 'r', parameters: { path: { type: 'string', description: 'p' }, tool_title: { type: 'string', description: 't' } }, required: ['path', 'tool_title'] }],
  maxTokens: 2048, thinkingLevel: 'off',
};

describe('buildOpenAIBody', () => {
  it('消息与工具映射', () => {
    const b = buildOpenAIBody(REQ, 'gpt-x') as any;
    expect(b.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(b.messages[2].tool_calls[0]).toMatchObject({ id: 'T1', type: 'function', function: { name: 'file_read' } });
    expect(b.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'T1', content: 'content' });
    expect(b.tools[0].function.name).toBe('file_read');
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.reasoning_effort).toBeUndefined();
  });
  it('thinking high → reasoning_effort', () => {
    expect((buildOpenAIBody({ ...REQ, thinkingLevel: 'high' }, 'm') as any).reasoning_effort).toBe('high');
  });
});

function sseResponse(chunks: object[]): Response {
  const text = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { status: 200 });
}

describe('OpenAIProvider 流归一化', () => {
  it('文本 + 分片工具调用 + usage + done', async () => {
    const p = new OpenAIProvider({ apiKey: 'k', modelId: 'm', baseUrl: 'http://x/v1', fetchImpl: async () => sseResponse([
      { choices: [{ index: 0, delta: { content: '嗯' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'C1', function: { name: 'file_read', arguments: '{"pa' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } },
    ]) });
    const events: AgentStreamEvent[] = [];
    for await (const e of p.streamAgentMessage(REQ)) events.push(e);
    expect(events).toContainEqual({ kind: 'textDelta', text: '嗯' });
    expect(events).toContainEqual({ kind: 'toolCallComplete', toolUseId: 'C1', name: 'file_read', input: '{"path":"a"}' });
    expect(events).toContainEqual({ kind: 'usage', usage: { inputTokens: 5, outputTokens: 9 } });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'toolUse' });
  });

  it('工具调用中途断流(无 finish_reason 无 [DONE])→ retryable 抛错', async () => {
    const body = `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"C1","function":{"name":"file_read","arguments":"{\\"pa"}}]}}]}\n\n`;
    const p = new OpenAIProvider({ apiKey: 'k', modelId: 'm', baseUrl: 'http://x/v1', fetchImpl: async () => new Response(body, { status: 200 }) });
    await expect(async () => { for await (const _ of p.streamAgentMessage(REQ)) void _; }).rejects.toMatchObject({ retryable: true, message: 'SSE 流提前结束' });
  });

  it('宽松网关:仅 [DONE] 无 finish_reason,带工具调用 → stopReason=toolUse', async () => {
    const p = new OpenAIProvider({ apiKey: 'k', modelId: 'm', baseUrl: 'http://x/v1', fetchImpl: async () => sseResponse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'C9', function: { name: 'file_read', arguments: '{"path":"a"}' } }] } }] },
    ]) });
    const events: AgentStreamEvent[] = [];
    for await (const e of p.streamAgentMessage(REQ)) events.push(e);
    expect(events).toContainEqual({ kind: 'toolCallComplete', toolUseId: 'C9', name: 'file_read', input: '{"path":"a"}' });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'toolUse' });
  });
});
