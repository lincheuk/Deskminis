import { describe, it, expect } from 'vitest';
import { GeminiProvider, buildGeminiBody } from '../src/minisd/providers/gemini';
import type { StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';

const TOOLS: StreamRequest['tools'] = [
  { name: 'shell_execute', description: '执行命令', parameters: { command: { type: 'string', description: '命令' }, tool_title: { type: 'string', description: '摘要' } }, required: ['command', 'tool_title'] },
];

const BASE: StreamRequest = {
  messages: [{ role: 'user', parts: [{ type: 'text', value: '列目录' }] }],
  systemPrompt: '你是 DeskMinis',
  tools: TOOLS,
  maxTokens: 4096, thinkingLevel: 'off',
};

describe('buildGeminiBody', () => {
  it('system_instruction / contents 角色 / 工具 / generationConfig 映射', () => {
    const body = buildGeminiBody(BASE, 'gemini-2.5-flash') as any;
    expect(body.system_instruction).toEqual({ parts: [{ text: '你是 DeskMinis' }] });
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: '列目录' }] });
    expect(body.tools[0].functionDeclarations[0].name).toBe('shell_execute');
    expect(body.tools[0].functionDeclarations[0].parameters.properties.command.type).toBe('STRING');
    expect(body.tools[0].functionDeclarations[0].parameters.required).toEqual(['command', 'tool_title']);
    expect(body.generationConfig.maxOutputTokens).toBe(4096);
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
    expect(body.model).toBeUndefined(); // model 在 URL 里，不在 body
  });

  it('thinking medium → thinkingBudget 封顶 min(16384, maxTokens-1)', () => {
    const tight = buildGeminiBody({ ...BASE, thinkingLevel: 'medium' }, 'm') as any;
    expect(tight.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 4095, includeThoughts: true });
    const roomy = buildGeminiBody({ ...BASE, thinkingLevel: 'medium', maxTokens: 64000 }, 'm') as any;
    expect(roomy.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 16384, includeThoughts: true });
  });

  it('带 thoughtSignature 的历史调用原样回放为 functionCall + functionResponse', () => {
    const req: StreamRequest = {
      ...BASE,
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '列目录' }] },
        { role: 'assistant', parts: [
          { type: 'text', value: '好的' },
          { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}', thoughtSignature: 'c2ln' } },
        ] },
        { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
      ],
    };
    const body = buildGeminiBody(req, 'm') as any;
    expect(body.contents[1].role).toBe('model');
    expect(body.contents[1].parts[0]).toEqual({ text: '好的' });
    expect(body.contents[1].parts[1]).toEqual({ functionCall: { name: 'shell_execute', args: { command: 'dir', tool_title: '列目录' } }, thoughtSignature: 'c2ln' });
    expect(body.contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'shell_execute', response: { result: 'a.txt' } } }] });
  });

  it('无签名的历史调用连同配对结果降级为文本摘要', () => {
    const req: StreamRequest = {
      ...BASE,
      messages: [
        { role: 'user', parts: [{ type: 'text', value: '列目录' }] },
        { role: 'assistant', parts: [
          { type: 'toolUse', value: { toolUseId: 'T1', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}' } },
        ] },
        { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'a.txt', success: true, status: 'success' } }] },
      ],
    };
    const body = buildGeminiBody(req, 'm') as any;
    expect(body.contents[1].parts[0]).toEqual({ text: '[历史工具调用] shell_execute 参数: {"command":"dir","tool_title":"列目录"}' });
    expect(body.contents[2].parts[0].text).toContain('[历史工具结果]');
    expect(body.contents[2].parts[0].text).toContain('a.txt');
    // 绝不出现裸 functionCall/functionResponse（Gemini 3 会因缺签名 400）
    const json = JSON.stringify(body);
    expect(json).not.toContain('functionCall');
    expect(json).not.toContain('functionResponse');
  });

  it('历史里的非法 toolUse.input 回放时降级为空对象参数', () => {
    const req: StreamRequest = {
      ...BASE,
      messages: [{ role: 'assistant', parts: [
        { type: 'toolUse', value: { toolUseId: 'B1', name: 'shell_execute', input: '{"bad', thoughtSignature: 's' } },
      ] }],
    };
    const body = buildGeminiBody(req, 'm') as any;
    expect(body.contents[0].parts[0]).toEqual({ functionCall: { name: 'shell_execute', args: {} }, thoughtSignature: 's' });
  });
});

function sseResponse(frames: string): Response {
  return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chunkedResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
  return new Response(stream, { status: 200 });
}

async function drain(p: GeminiProvider, req: StreamRequest): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const e of p.streamAgentMessage(req)) events.push(e);
  return events;
}

/** 录制的 Gemini SSE 流：thinking → text → functionCall(带签名) → finish+usage。 */
const RECORDED = [
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"我先看下目录","thought":true}]}}]}\n\n',
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"好的"}]}}]}\n\n',
  'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"shell_execute","args":{"command":"dir","tool_title":"列目录"}},"thoughtSignature":"c2lnLTEyMw=="}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":18}}\n\n',
].join('');

describe('GeminiProvider 流归一化（录制回放）', () => {
  it('thinking/text/functionCall/usage/done 归一化，functionCall 合成 UUID id 并带签名', async () => {
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'gemini-2.5-flash', fetchImpl: async () => sseResponse(RECORDED) });
    const events = await drain(p, BASE);
    expect(events).toContainEqual({ kind: 'thinkingDelta', text: '我先看下目录' });
    expect(events).toContainEqual({ kind: 'textDelta', text: '好的' });
    const call = events.find(e => e.kind === 'toolCallComplete');
    expect(call).toMatchObject({ kind: 'toolCallComplete', name: 'shell_execute', input: '{"command":"dir","tool_title":"列目录"}', thoughtSignature: 'c2lnLTEyMw==' });
    expect((call as { toolUseId: string }).toolUseId).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(events).toContainEqual({ kind: 'usage', usage: { inputTokens: 42, outputTokens: 18 } });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'toolUse' });
  });

  it('同一 data 帧被拆到两个网络块（部分 JSON）仍正确解析', async () => {
    const cut = RECORDED.indexOf('"functionCall"');
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => chunkedResponse([RECORDED.slice(0, cut), RECORDED.slice(cut)]) });
    const events = await drain(p, BASE);
    expect(events.some(e => e.kind === 'toolCallComplete' && e.name === 'shell_execute')).toBe(true);
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'toolUse' });
  });

  it('纯文本回复 STOP → endTurn', async () => {
    const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n';
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(sse) });
    const events = await drain(p, BASE);
    expect(events).toContainEqual({ kind: 'textDelta', text: '你好' });
    expect(events.at(-1)).toEqual({ kind: 'done', stopReason: 'endTurn' });
  });

  it('MAX_TOKENS → maxTokens；promptFeedback.blockReason → refusal', async () => {
    const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"长"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4096}}\n\n';
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(sse) });
    expect((await drain(p, BASE)).at(-1)).toEqual({ kind: 'done', stopReason: 'maxTokens' });

    const blocked = 'data: {"promptFeedback":{"blockReason":"SAFETY"},"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":0}}\n\n';
    const p2 = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(blocked) });
    expect((await drain(p2, BASE)).at(-1)).toEqual({ kind: 'done', stopReason: 'refusal' });
  });

  it('断流（无 finishReason 无 usageMetadata）→ retryable 抛错', async () => {
    const half = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"半截"}]}}]}\n\n';
    const p = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => sseResponse(half) });
    await expect(drain(p, BASE)).rejects.toMatchObject({ retryable: true, message: 'SSE 流提前结束' });
  });

  it('429 → fallbackable 且不可 retry；529 → retryable；网络异常 → retryable', async () => {
    const p429 = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => new Response('rate', { status: 429 }) });
    await expect(drain(p429, BASE)).rejects.toMatchObject({ retryable: false, fallbackable: true, status: 429 });
    const p529 = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => new Response('overloaded', { status: 529 }) });
    await expect(drain(p529, BASE)).rejects.toMatchObject({ retryable: true, fallbackable: false });
    const pNet = new GeminiProvider({ apiKey: 'k', modelId: 'm', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(drain(pNet, BASE)).rejects.toMatchObject({ retryable: true });
  });
});
