import type { StreamRequest } from '../src/minisd/providers/types';

/** 固定内容用于改前/改后字节对照；会话传输元数据不属于JSON正文。 */
export function n23Requests(): Record<string, StreamRequest> {
  return {
    main: { messages: [{ role: 'user', parts: [{ type: 'text', value: 'N23 中文消息' }] }], systemPrompt: 'N23 synthetic system', tools: [], maxTokens: 4096, thinkingLevel: 'off' },
    thinking: { messages: [{ role: 'user', parts: [{ type: 'text', value: 'N23 reasoning' }] }], systemPrompt: 'N23 synthetic system', tools: [], maxTokens: 8192, thinkingLevel: 'high' },
    summary: { messages: [{ role: 'user', parts: [{ type: 'text', value: 'N23 摘要取材' }] }], systemPrompt: '你是对话摘要助手。', tools: [], maxTokens: 4096, thinkingLevel: 'off' },
    title: { messages: [{ role: 'user', parts: [{ type: 'text', value: 'N23 标题取材' }] }], systemPrompt: '你是标题生成器。', tools: [], maxTokens: 2048, thinkingLevel: 'off' },
  };
}
