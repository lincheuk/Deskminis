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

/** 思考开启 + assistant 消息带 thinking part（新版本落库形态）：预算档位测试用，
 *   REQ 的末条 assistant 只含 toolUse、无 thinking，会触发「旧数据降级思考」分支（见下）。 */
const THINKING_REQ: StreamRequest = {
  ...REQ,
  thinkingLevel: 'medium',
  messages: [
    { role: 'user', parts: [{ type: 'text', value: '列出文件' }] },
    { role: 'assistant', parts: [
      { type: 'thinking', value: { text: '思考过程', signature: 'sig-abc' } },
      { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } },
    ] },
    { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
  ],
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
  // 既有预算档位测试改用 THINKING_REQ：REQ 的末条 assistant 无 thinking part，按新规则会降级思考
  it('thinking medium 在 maxTokens 不足时被封顶', () => {
    const body = buildAnthropicBody(THINKING_REQ, 'm') as any;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4095 });
  });
  it('thinking medium 在 maxTokens 充足时用原始档位', () => {
    const body = buildAnthropicBody({ ...THINKING_REQ, maxTokens: 64000 }, 'm') as any;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 32768 });
  });
  it('thinking high 充足时 65536, 不足时被封顶', () => {
    // 注意: maxTokens 必须 > 65536 才能拿到完整档位; 64000 - 1 = 63999 仍会被封顶
    const roomy = buildAnthropicBody({ ...THINKING_REQ, thinkingLevel: 'high', maxTokens: 128000 }, 'm') as any;
    expect(roomy.thinking).toEqual({ type: 'enabled', budget_tokens: 65536 });
    const tight = buildAnthropicBody({ ...THINKING_REQ, thinkingLevel: 'high' }, 'm') as any;
    expect(tight.thinking).toEqual({ type: 'enabled', budget_tokens: 4095 });
  });
  it('回放含 thinking part 的 assistant 消息 → content 首块是 thinking 且带 signature', () => {
    const body = buildAnthropicBody(THINKING_REQ, 'm') as any;
    const content = body.messages[1].content;
    // thinking 块必须排在 content 最前（Anthropic 的块序要求：thinking 先于 tool_use）
    expect(content[0]).toEqual({ type: 'thinking', thinking: '思考过程', signature: 'sig-abc' });
    expect(content[1]).toMatchObject({ type: 'tool_use', id: 'T1' });
  });
  it('thinking 开启 + 末条 assistant 含 toolUse 但无 thinking part → body.thinking 为 undefined（旧数据降级）', () => {
    // REQ 末条 assistant 正是老版本落库形态（含 toolUse 无 thinking）：整请求降级关闭思考
    const body = buildAnthropicBody({ ...REQ, thinkingLevel: 'medium' }, 'm') as any;
    expect(body.thinking).toBeUndefined();
  });
  it('redacted_thinking 块 → 回放为 redacted_thinking', () => {
    const req: StreamRequest = {
      ...THINKING_REQ,
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '分析' }] },
        { role: 'assistant', parts: [
          { type: 'thinking', value: { text: '', redactedData: '[REMOVED]' } },
          { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } },
        ] },
        { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
      ],
    };
    const body = buildAnthropicBody(req, 'm') as any;
    expect(body.messages[1].content[0]).toEqual({ type: 'redacted_thinking', data: '[REMOVED]' });
  });
  it('末条 assistant 含 toolUse + 无签名无 redactedData 的 thinking part → body.thinking 为 undefined', () => {
    // 该 thinking part 无法回放（partToBlock 会丢块），判定必须把它视为「没有 thinking 块」→ 降级关闭思考
    const req: StreamRequest = {
      ...THINKING_REQ,
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '列出文件' }] },
        { role: 'assistant', parts: [
          { type: 'thinking', value: { text: '无法回放的思考' } }, // 无 signature 无 redactedData
          { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } },
        ] },
        { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
      ],
    };
    const body = buildAnthropicBody(req, 'm') as any;
    expect(body.thinking).toBeUndefined();
  });
  it('imageData part → image 块（source.base64 + media_type）', () => {
    const req: StreamRequest = {
      ...REQ,
      messages: [
        { role: 'user', parts: [
          { type: 'text', value: '看图' },
          { type: 'imageData', value: { mimeType: 'image/png', base64: 'iVBORw0KGgo=' } },
        ] },
      ],
    };
    const body = buildAnthropicBody(req, 'm') as any;
    // toMatchObject：该块作为末条 user 消息的最后一块会被打上 cache_control（既有缓存断点行为，不是映射错误）
    expect(body.messages[0].content[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });
  it('夹含 mediaRef-only 的 user 消息 → 整条剔除，缓存断点仍落在真实存在的最后两条 user 消息上', () => {
    const req: StreamRequest = {
      ...THINKING_REQ,
      messages: [
        { role: 'user', parts: [{ type: 'mediaRef', value: { id: 'M1', relativePath: 'a.png', mimeType: 'image/png' } }] }, // 只含 mediaRef → content 空，整条剔除
        { role: 'user', parts: [{ type: 'text', value: '列出文件' }] },
        { role: 'assistant', parts: [
          { type: 'thinking', value: { text: '思考过程', signature: 'sig-abc' } },
          { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } },
        ] },
        { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
      ],
    };
    const body = buildAnthropicBody(req, 'm') as any;
    // mediaRef-only 消息被整条剔除，body.messages 里没有空 content 项
    expect(body.messages).not.toContainEqual(expect.objectContaining({ content: [] }));
    // 剔除后 user 消息只剩「列出文件」与 tool_result 两条，两者末尾都打上缓存断点（断点不受剔除影响）
    const userMsgs = body.messages.filter((m: any) => m.role === 'user');
    expect(userMsgs).toHaveLength(2);
    for (const um of userMsgs) expect(um.content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
  });
  it('rawInputSchema 存在时 input_schema 直用（嵌套结构原样），不存在时旧平铺路径不变', () => {
    const raw = { type: 'object' as const, properties: { q: { type: 'string', description: '查询' }, opts: { type: 'object', properties: { deep: { type: 'boolean' } } } }, required: ['q'] };
    const body = buildAnthropicBody({ ...REQ, tools: [...REQ.tools, { name: 'mcp__a__search', description: '搜索', parameters: { tool_title: { type: 'string', description: '摘要' } }, required: ['tool_title'], rawInputSchema: raw }] }, 'm') as any;
    const mcpTool = body.tools.find((t: any) => t.name === 'mcp__a__search');
    expect(mcpTool.input_schema).toEqual(raw); // 嵌套 properties 原样透传，不平铺、不重排
    const legacyTool = body.tools.find((t: any) => t.name === 'shell_execute');
    expect(legacyTool.input_schema.required).toEqual(['command', 'tool_title']);
    expect(legacyTool.input_schema.properties.command).toEqual({ type: 'string', description: '命令' });
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
  it('thinking 块: thinking_delta + signature_delta + content_block_stop → 产出 thinkingComplete 事件', async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"推断 A"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"推断 B"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-123"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const p = new AnthropicProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(sse) });
    const events: AgentStreamEvent[] = [];
    for await (const e of p.streamAgentMessage({ ...REQ, thinkingLevel: 'medium' })) events.push(e);
    // thinking_delta 仍发 thinkingDelta（展示用），stop 时发带完整文本与签名的 thinkingComplete
    expect(events).toContainEqual({ kind: 'thinkingDelta', text: '推断 A' });
    expect(events).toContainEqual({ kind: 'thinkingComplete', text: '推断 A推断 B', signature: 'sig-123', redactedData: undefined });
  });
  it('529 抛 retryable ProviderError, 429 不可 retry', async () => {
    const p529 = new AnthropicProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => new Response('overloaded', { status: 529 }) });
    await expect(async () => { for await (const _ of p529.streamAgentMessage(REQ)) void _; }).rejects.toMatchObject({ retryable: true });
    const p429 = new AnthropicProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => new Response('rate', { status: 429 }) });
    await expect(async () => { for await (const _ of p429.streamAgentMessage(REQ)) void _; }).rejects.toMatchObject({ retryable: false });
  });
});
