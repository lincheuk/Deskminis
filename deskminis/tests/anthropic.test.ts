import { describe, it, expect } from 'vitest';
import { AnthropicProvider, buildAnthropicBody } from '../src/minisd/providers/anthropic';
import type { StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';

const REQ: StreamRequest = {
  messages: [
    { role: 'user', parts: [{ type: 'text', value: '列出文件' }] },
    { role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } }] },
    { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
  ],
  systemPrompt: '你是 DeskMinis',
  tools: [{ name: 'shell_execute', description: '执行命令', parameters: { command: { type: 'string', description: '命令' }, tool_title: { type: 'string', description: '摘要' } }, required: ['command', 'tool_title'] }],
  maxTokens: 4096, thinkingLevel: 'off',
};

describe('buildAnthropicBody', () => {
  it('消息/工具/缓存断点正确', () => {
    const body = buildAnthropicBody(REQ, 'claude-sonnet-5') as any;
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0].input_schema.required).toEqual(['command', 'tool_title']);
    expect(body.tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'T1', input: { command: 'dir' } });
    expect(body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'T1', is_error: false });
    expect(body.messages[2].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(body.thinking).toBeUndefined();
  });
  it('thinking medium 在 maxTokens 不足时被封顶', () => {
    const body = buildAnthropicBody({ ...REQ, thinkingLevel: 'medium' }, 'm') as any;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4095 });
  });
  it('thinking medium 在 maxTokens 充足时用原始档位', () => {
    const body = buildAnthropicBody({ ...REQ, thinkingLevel: 'medium', maxTokens: 64000 }, 'm') as any;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 32768 });
  });
  it('thinking high 充足时 65536, 不足时被封顶', () => {
    // 注意: maxTokens 必须 > 65536 才能拿到完整档位; 64000 - 1 = 63999 仍会被封顶
    const roomy = buildAnthropicBody({ ...REQ, thinkingLevel: 'high', maxTokens: 128000 }, 'm') as any;
    expect(roomy.thinking).toEqual({ type: 'enabled', budget_tokens: 65536 });
    const tight = buildAnthropicBody({ ...REQ, thinkingLevel: 'high' }, 'm') as any;
    expect(tight.thinking).toEqual({ type: 'enabled', budget_tokens: 4095 });
  });
});

function sseResponse(frames: string): Response {
  return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('AnthropicProvider 流归一化', () => {
  it('text + tool_use + usage + done', async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好的"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"T9","name":"shell_execute"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"dir\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const p = new AnthropicProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(sse) });
    const events: AgentStreamEvent[] = [];
    for await (const e of p.streamAgentMessage(REQ)) events.push(e);
    expect(events).toContainEqual({ kind: 'textDelta', text: '好的' });
    expect(events).toContainEqual({ kind: 'toolCallComplete', toolUseId: 'T9', name: 'shell_execute', input: '{"command":"dir"}' });
    expect(events).toContainEqual({ kind: 'usage', usage: { inputTokens: 10, outputTokens: 25 } });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'toolUse' });
  });
  it('529 抛 retryable ProviderError, 429 不可 retry', async () => {
    const p529 = new AnthropicProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => new Response('overloaded', { status: 529 }) });
    await expect(async () => { for await (const _ of p529.streamAgentMessage(REQ)) void _; }).rejects.toMatchObject({ retryable: true });
    const p429 = new AnthropicProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => new Response('rate', { status: 429 }) });
    await expect(async () => { for await (const _ of p429.streamAgentMessage(REQ)) void _; }).rejects.toMatchObject({ retryable: false });
  });
});
