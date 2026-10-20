/**
 * F02 请求度量：把「实际将发送的请求」分项估成 token——系统提示、工具定义、对话、回放推理、图片。
 *
 * 做法：用这个协议自己的构建器生成请求体，再从请求体里取各段。预算看到的就是构建器真正会发的东西，不另写一份序列化规则：
 *  - 不带工具的槽位、历史图片改占位、工具记录转文字这些差异，已经体现在传进来的消息里；
 *  - 回放推理只数真正发出去的：Anthropic 无签名的思考块被构建器丢弃，不计；OpenAI 兼容只有 deepseek-v4 族写
 *    reasoning_content；OpenAI 与 Gemini 不发 thinking part，也就不数；
 *  - 图片先换成占位再构建：base64 的长度不进任何文本估算，token 数按尺寸另算（image-tokens.ts）。
 * 文本一律用 estimateTextTokens（CJK ÷1.6、其余 ÷4），系数与水位旧口径相同——变的是量了什么，不是系数。
 * 纯函数，不发网络，不调任何计数接口。
 */
import type { AgentMessage } from '../../shared/types';
import type { RuntimeModel } from '../../shared/runtime-model';
import type { BudgetMeasure } from '../../shared/request-budget';
import { estimateTextTokens } from '../../shared/token-estimate';
import type { StreamRequest } from './types';
import { buildAnthropicBody } from './anthropic';
import { buildOpenAIBody } from './openai';
import { buildGeminiBody } from './gemini';
import { estimateImageTokens, imageSizeFromBase64, type ImageSize } from './image-tokens';

/** history = 消息体，不含回放推理与图片；reasoningReplay = 这个协议这次真的会带回去的推理。 */
export type RequestMeasure = BudgetMeasure;

/** 从一份请求体里取出的各段文本（还没估算）。images 是请求体里图片块对应的占位序号。 */
interface Segments { system: string; tools: string; toolCount: number; history: string; replay: string; images: number[] }

type Obj = Record<string, unknown>;
const list = (v: unknown): Obj[] => Array.isArray(v) ? v as Obj[] : [];

function anthropicSegments(body: Obj): Segments {
  const replay: string[] = []; const images: number[] = [];
  const messages = list(body.messages).map(m => ({
    role: m.role,
    content: list(m.content).filter(b => {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') { replay.push(JSON.stringify(b)); return false; }
      if (b.type === 'image') { images.push(Number((b.source as Obj | undefined)?.data)); return false; }
      return true;
    }),
  }));
  const tools = list(body.tools);
  return {
    // 两块（稳定段 + 动态段）时按拼好的全文算，与单块的口径一致
    system: list(body.system).map(b => String(b.text ?? '')).join('\n\n'),
    tools: tools.length > 0 ? JSON.stringify(tools) : '', toolCount: tools.length,
    history: JSON.stringify(messages), replay: replay.join(''), images,
  };
}

function openaiSegments(body: Obj): Segments {
  const all = list(body.messages);
  const hasSystem = all[0]?.role === 'system';
  const replay: string[] = []; const images: number[] = [];
  const messages = (hasSystem ? all.slice(1) : all).map(m => {
    let out = m;
    // 推理原文算进回放；键本身留在消息里（值清空），壳的那点字符仍计入 history
    if (typeof m.reasoning_content === 'string') { replay.push(m.reasoning_content); out = { ...out, reasoning_content: '' }; }
    if (Array.isArray(out.content)) {
      out = { ...out, content: list(out.content).filter(c => {
        if (c.type !== 'image_url') return true;
        const url = String((c.image_url as Obj | undefined)?.url ?? '');
        images.push(Number(url.slice(url.lastIndexOf(',') + 1)));
        return false;
      }) };
    }
    return out;
  });
  const tools = list(body.tools);
  return {
    system: hasSystem ? String(all[0].content ?? '') : '',
    tools: tools.length > 0 ? JSON.stringify(tools) : '', toolCount: tools.length,
    history: JSON.stringify(messages), replay: replay.join(''), images,
  };
}

function geminiSegments(body: Obj): Segments {
  const replay: string[] = []; const images: number[] = [];
  const contents = list(body.contents).map(c => ({
    role: c.role,
    parts: list(c.parts).filter(p => {
      if (!p.inlineData) return true;
      images.push(Number((p.inlineData as Obj).data));
      return false;
    }).map(p => {
      if (typeof p.thoughtSignature !== 'string') return p;
      replay.push(p.thoughtSignature);
      return { ...p, thoughtSignature: '' };
    }),
  }));
  const declarations = list((list(body.tools)[0] as Obj | undefined)?.functionDeclarations);
  return {
    system: list((body.system_instruction as Obj | undefined)?.parts).map(p => String(p.text ?? '')).join('\n\n'),
    tools: declarations.length > 0 ? JSON.stringify(declarations) : '', toolCount: declarations.length,
    history: JSON.stringify(contents), replay: replay.join(''), images,
  };
}

export function measureRequest(
  rt: Pick<RuntimeModel, 'protocol' | 'modelId' | 'kind'>,
  req: Pick<StreamRequest, 'messages' | 'systemPrompt' | 'systemPromptParts' | 'tools'>,
): RequestMeasure {
  // 剥图：base64 换成占位序号（保序），同时从原 base64 的文件头取尺寸。构建器照常产出图片块，块里带的是序号
  const sizes: (ImageSize | undefined)[] = [];
  const messages: AgentMessage[] = req.messages.map(m => {
    if (!m.parts.some(p => p.type === 'imageData')) return m;
    return { ...m, parts: m.parts.map(p => {
      if (p.type !== 'imageData') return p;
      const v = p.value as { mimeType: string; base64: string };
      sizes.push(imageSizeFromBase64(v.base64));
      return { type: 'imageData' as const, value: { mimeType: v.mimeType, base64: String(sizes.length - 1) } };
    }) };
  });
  const stripped: StreamRequest = {
    messages, tools: req.tools, maxTokens: 1, thinkingLevel: 'off',
    ...(req.systemPrompt !== undefined ? { systemPrompt: req.systemPrompt } : {}),
    ...(req.systemPromptParts ? { systemPromptParts: req.systemPromptParts } : {}),
  };
  const seg = rt.protocol === 'anthropic' ? anthropicSegments(buildAnthropicBody(stripped, rt.modelId))
    : rt.protocol === 'gemini' ? geminiSegments(buildGeminiBody(stripped, rt.modelId))
    // Ollama 的 OpenAI 端点不发 reasoning_effort（与 ProviderStore 实例化时的 compat 一致）；推理档位这里恒为 off，两者请求体相同
    : openaiSegments(buildOpenAIBody(stripped, rt.modelId, rt.kind === 'ollama' ? { reasoningEffort: false } : {}));
  const system = seg.system ? estimateTextTokens(seg.system) : 0;
  return {
    system,
    systemStable: req.systemPromptParts ? Math.min(system, estimateTextTokens(req.systemPromptParts.stable)) : system,
    tools: seg.tools ? estimateTextTokens(seg.tools) : 0,
    toolCount: seg.toolCount,
    history: estimateTextTokens(seg.history),
    reasoningReplay: seg.replay ? estimateTextTokens(seg.replay) : 0,
    media: seg.images.map(i => estimateImageTokens(rt.protocol, sizes[i])),
  };
}
