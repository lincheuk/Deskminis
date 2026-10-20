/**
 * F02 验收 1 / 阻断 1：预算量的是「实际将发送的请求」——系统提示、工具定义、对话、回放推理、图片分别计入，
 * 用各协议自己的构建器生成请求体再分项估算；图片按尺寸而不是按 base64 字符量。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureRequest } from '../src/minisd/providers/request-measure';
import { IMAGE_HEADER_BYTES, estimateImageTokens, imageSizeFromBase64, readImageSize } from '../src/minisd/providers/image-tokens';
import { buildAnthropicBody } from '../src/minisd/providers/anthropic';
import { buildOpenAIBody } from '../src/minisd/providers/openai';
import { buildGeminiBody } from '../src/minisd/providers/gemini';
import type { StreamRequest } from '../src/minisd/providers/types';
import { buildPreviewMessages, buildRequestMessages, flattenToolHistory } from '../src/minisd/agent/loop';
import { countImageNeeds } from '../src/minisd/providers/runtime-model';
import { estimateTextTokens } from '../src/shared/token-estimate';
import type { AgentMessage, AgentToolDefinition, ContentPart } from '../src/shared/types';
import type { RuntimeModel } from '../src/shared/runtime-model';
import { gifBytes, jpegBytes, pngBytes, webpBytes } from './image-fixtures';

type Rt = Pick<RuntimeModel, 'protocol' | 'modelId' | 'kind'>;
const ANTHROPIC: Rt = { protocol: 'anthropic', modelId: 'claude-x', kind: 'anthropic' };
const OPENAI: Rt = { protocol: 'openai-chat', modelId: 'gpt-x', kind: 'openai-compat' };
const DEEPSEEK: Rt = { protocol: 'openai-chat', modelId: 'deepseek-v4-pro', kind: 'openai-compat' };
const GEMINI: Rt = { protocol: 'gemini', modelId: 'gem-v', kind: 'gemini' };
const ALL: Rt[] = [ANTHROPIC, OPENAI, GEMINI];

const tool = (name: string): AgentToolDefinition => ({
  name, description: `tool ${name} does something useful with files`,
  parameters: { path: { type: 'string', description: 'target path' }, tool_title: { type: 'string', description: 'title' } }, required: ['path', 'tool_title'],
});
const TOOLS = [tool('file_read'), tool('file_write'), tool('shell_execute')];
const user = (text: string): AgentMessage => ({ role: 'user', parts: [{ type: 'text', value: text }] });
const SHORT: AgentMessage[] = [user('hello'), { role: 'assistant', parts: [{ type: 'text', value: 'hi there' }] }, user('read the file')];
const image = (bytes: Uint8Array, mimeType = 'image/png'): ContentPart => ({ type: 'imageData', value: { mimeType, base64: Buffer.from(bytes).toString('base64') } });
const full = (req: Pick<StreamRequest, 'messages' | 'systemPrompt' | 'tools'>): StreamRequest => ({ ...req, maxTokens: 1, thinkingLevel: 'off' });

describe('请求度量：系统提示与工具', () => {
  it('M1 三种协议：system 是系统提示文本的估计，tools 是该协议构建器产出的工具数组的估计；不带工具时为 0', () => {
    const systemPrompt = 'You are a careful assistant. '.repeat(40);
    const req = { messages: SHORT, systemPrompt, tools: TOOLS };
    const built: Record<string, string> = {
      anthropic: JSON.stringify(buildAnthropicBody(full(req), 'claude-x').tools),
      'openai-chat': JSON.stringify(buildOpenAIBody(full(req), 'gpt-x').tools),
      gemini: JSON.stringify((buildGeminiBody(full(req), 'gem-v').tools as { functionDeclarations: unknown[] }[])[0].functionDeclarations),
    };
    for (const rt of ALL) {
      const m = measureRequest(rt, req);
      expect(m.system, rt.protocol).toBe(estimateTextTokens(systemPrompt));
      expect(m.systemStable, rt.protocol).toBe(m.system);
      expect(m.tools, rt.protocol).toBe(estimateTextTokens(built[rt.protocol]));
      expect(m.tools, rt.protocol).toBeGreaterThan(100);
      expect(m.toolCount, rt.protocol).toBe(3);
      expect(m.history, rt.protocol).toBeGreaterThan(0);
      const bare = measureRequest(rt, { ...req, tools: [] });
      expect(bare.tools, rt.protocol).toBe(0);
      expect(bare.toolCount, rt.protocol).toBe(0);
    }
  });

  it('M2 系统提示从 10 字换成 40,000 字：三个协议的 system 都增加，history 不变', () => {
    for (const rt of ALL) {
      const small = measureRequest(rt, { messages: SHORT, systemPrompt: 'be concise', tools: TOOLS });
      const big = measureRequest(rt, { messages: SHORT, systemPrompt: 'x'.repeat(40_000), tools: TOOLS });
      expect(big.system - small.system, rt.protocol).toBeGreaterThan(9_900);
      expect(big.history, rt.protocol).toBe(small.history);
      expect(big.tools, rt.protocol).toBe(small.tools);
    }
  });

  it('系统提示分了稳定段与动态段：systemStable 只算稳定段，system 仍是全文', () => {
    const parts = { stable: 's'.repeat(8_000), dynamic: 'd'.repeat(4_000) };
    const systemPrompt = `${parts.stable}\n\n${parts.dynamic}`;
    for (const rt of ALL) {
      const m = measureRequest(rt, { messages: SHORT, systemPrompt, systemPromptParts: parts, tools: [] });
      expect(m.system, rt.protocol).toBe(estimateTextTokens(systemPrompt));
      expect(m.systemStable, rt.protocol).toBe(2_000);
    }
  });
});

describe('请求度量：图片', () => {
  it('M3 3 MB 的图片按尺寸算，base64 的长度不进任何文本估算', () => {
    const messages: AgentMessage[] = [{ role: 'user', parts: [{ type: 'text', value: 'look' }, image(pngBytes(100, 100, 3_000_000))] }];
    const m = measureRequest(ANTHROPIC, { messages, systemPrompt: 'sys', tools: [] });
    expect(m.media).toEqual([{ kind: 'image', tokens: 16, basis: 'formula' }]);
    expect(m.history).toBeLessThan(200);
    for (const rt of [OPENAI, GEMINI]) {
      const other = measureRequest(rt, { messages, systemPrompt: 'sys', tools: [] });
      expect(other.media, rt.protocol).toHaveLength(1);
      expect(other.history, rt.protocol).toBeLessThan(200);
    }
  });

  it('M4 图片规则表：Anthropic 的 28 px 网格与上限，Gemini 的裁剪单元', () => {
    const a = (w: number, h: number) => estimateImageTokens('anthropic', { width: w, height: h });
    expect(a(1000, 1000)).toEqual({ kind: 'image', tokens: 1296, basis: 'formula' });
    expect(a(1920, 1080)).toEqual({ kind: 'image', tokens: 2691, basis: 'formula' });
    expect(a(3840, 2160)).toEqual({ kind: 'image', tokens: 4784, basis: 'formula' });
    const g = (w: number, h: number) => estimateImageTokens('gemini', { width: w, height: h });
    expect(g(300, 300)).toEqual({ kind: 'image', tokens: 258, basis: 'formula' });
    expect(g(960, 540)).toEqual({ kind: 'image', tokens: 1548, basis: 'formula' });
    // OpenAI 兼容端点背后是很多家，没有统一规则：借用 28 px 网格，标为保守近似
    expect(estimateImageTokens('openai-chat', { width: 1000, height: 1000 })).toEqual({ kind: 'image', tokens: 1296, basis: 'default' });
  });

  it('M5 读不出尺寸：取公布的单张上限或保守近似，不记 0', () => {
    expect(estimateImageTokens('anthropic', undefined)).toEqual({ kind: 'image', tokens: 4784, basis: 'upper-bound' });
    expect(estimateImageTokens('gemini', undefined)).toEqual({ kind: 'image', tokens: 2322, basis: 'default' });
    expect(estimateImageTokens('openai-chat', undefined)).toEqual({ kind: 'image', tokens: 4784, basis: 'default' });
    const messages: AgentMessage[] = [{ role: 'user', parts: [image(Buffer.from('not an image at all'))] }];
    expect(measureRequest(ANTHROPIC, { messages, tools: [] }).media).toEqual([{ kind: 'image', tokens: 4784, basis: 'upper-bound' }]);
  });

  it('M6 readImageSize：PNG / JPEG（SOF 在 EXIF 之后）/ GIF / WebP 三种子格式；截断的头与乱码返回 undefined、不抛', () => {
    expect(readImageSize(pngBytes(1000, 800))).toEqual({ width: 1000, height: 800 });
    expect(readImageSize(jpegBytes(640, 480, { appSegments: 2, appBytes: 3_000 }))).toEqual({ width: 640, height: 480 });
    expect(readImageSize(gifBytes(320, 200))).toEqual({ width: 320, height: 200 });
    expect(readImageSize(webpBytes('VP8 ', 800, 600))).toEqual({ width: 800, height: 600 });
    expect(readImageSize(webpBytes('VP8L', 1234, 567))).toEqual({ width: 1234, height: 567 });
    expect(readImageSize(webpBytes('VP8X', 4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(readImageSize(pngBytes(1000, 800).subarray(0, 20))).toBeUndefined();
    expect(readImageSize(jpegBytes(640, 480).subarray(0, 12))).toBeUndefined();
    expect(readImageSize(pngBytes(0, 800))).toBeUndefined();
    expect(readImageSize(Buffer.from('garbage bytes, definitely not an image header'))).toBeUndefined();
    expect(readImageSize(new Uint8Array(0))).toBeUndefined();
    // base64 只解前一段：与文件前 IMAGE_HEADER_BYTES 字节是同一段字节
    const big = pngBytes(1000, 800, 300_000);
    expect(imageSizeFromBase64(big.toString('base64'))).toEqual({ width: 1000, height: 800 });
    expect(imageSizeFromBase64(big.subarray(0, IMAGE_HEADER_BYTES).toString('base64'))).toEqual({ width: 1000, height: 800 });
  });
});

describe('请求度量：回放推理只数真正发出去的', () => {
  it('M7 Anthropic：带签名的思考块计入 reasoningReplay，无签名的被构建器丢弃、不计', () => {
    const messages: AgentMessage[] = [
      user('q'),
      { role: 'assistant', parts: [
        { type: 'thinking', value: { text: 't'.repeat(40_000), signature: 'sig-1' } },
        { type: 'thinking', value: { text: 'u'.repeat(40_000) } },
        { type: 'text', value: 'answer' },
      ] },
      user('next'),
    ];
    const m = measureRequest(ANTHROPIC, { messages, tools: [] });
    expect(m.reasoningReplay).toBeGreaterThanOrEqual(10_000);
    expect(m.reasoningReplay).toBeLessThan(10_100);
    expect(m.history).toBeLessThan(200);
  });

  it('M8 OpenAI 兼容：只有 deepseek-v4 族回放 reasoning_content；thinking part 两者都不发、不计', () => {
    const messages: AgentMessage[] = [
      user('q'),
      { role: 'assistant', parts: [{ type: 'thinking', value: { text: 'z'.repeat(40_000), signature: 's' } }, { type: 'text', value: 'answer' }], reasoningContent: 'r'.repeat(40_000) },
      user('next'),
    ];
    const v4 = measureRequest(DEEPSEEK, { messages, tools: [] });
    expect(v4.reasoningReplay).toBe(10_000);
    expect(v4.history).toBeLessThan(200);
    const gpt = measureRequest(OPENAI, { messages, tools: [] });
    expect(gpt.reasoningReplay).toBe(0);
    expect(gpt.history).toBeLessThan(200);
  });

  it('M9 Gemini：带 thoughtSignature 的 functionCall 计签名长度；无签名的历史工具调用作为文本进 history', () => {
    const signed: AgentMessage[] = [
      user('q'),
      { role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'file_read', input: '{"path":"a"}', thoughtSignature: 'S'.repeat(8_000) } }] },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'ok', success: true, status: 'success' } }] },
    ];
    const a = measureRequest(GEMINI, { messages: signed, tools: [] });
    expect(a.reasoningReplay).toBe(2_000);
    expect(a.history).toBeLessThan(200);
    const unsigned: AgentMessage[] = [
      user('q'),
      { role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'file_read', input: JSON.stringify({ path: 'p'.repeat(8_000) }) } }] },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'ok', success: true, status: 'success' } }] },
    ];
    const b = measureRequest(GEMINI, { messages: unsigned, tools: [] });
    expect(b.reasoningReplay).toBe(0);
    expect(b.history).toBeGreaterThan(2_000);
  });

  it('M10 不带工具的槽位：工具定义为 0，工具记录以文字计入 history', () => {
    const messages: AgentMessage[] = [
      user('q'),
      { role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'file_read', input: '{"path":"a"}' } }] },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'o'.repeat(4_000), success: true, status: 'success' } }] },
    ];
    for (const rt of ALL) {
      const m = measureRequest(rt, { messages: flattenToolHistory(messages), systemPrompt: 'sys', tools: [] });
      expect(m.tools, rt.protocol).toBe(0);
      expect(m.history, rt.protocol).toBeGreaterThan(1_000);
    }
  });
});

describe('请求度量：上下文条（只读文件头）与循环（整张图）量出同一个尺寸', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-measure-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('M11 headerOnly 与完整读取：media 逐项相等，远 SOF 的 JPEG 两边都落到读不出尺寸的档，缺失文件两边同一句', () => {
    const files: [string, Buffer, string][] = [
      ['a.png', pngBytes(1000, 800, 300_000), 'image/png'],
      ['b.jpg', jpegBytes(640, 480, { size: 20_000 }), 'image/jpeg'],
      // SOI 之后两个各 40,000 字节的 APP 段，SOF 落在第 65,535 字节之后
      ['c.jpg', jpegBytes(640, 480, { appSegments: 2, appBytes: 40_000, size: 120_000 }), 'image/jpeg'],
    ];
    for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
    const ref = (name: string, mimeType: string): ContentPart => ({ type: 'mediaRef', value: { id: name, relativePath: `attachments/${name}`, mimeType } });
    const history: AgentMessage[] = [{
      role: 'user',
      parts: [{ type: 'text', value: 'compare these' }, ...files.map(([name, , mime]) => ref(name, mime)), ref('gone.png', 'image/png')],
    }];
    const resolve = (rel: string) => join(dir, rel.replace('attachments/', ''));
    const whole = buildRequestMessages(history, new Map(), resolve);
    const header = buildRequestMessages(history, new Map(), resolve, { headerOnly: true });

    const base64Of = (ms: AgentMessage[]): string[] => ms.flatMap(m => m.parts.flatMap(p => p.type === 'imageData' ? [(p.value as { base64: string }).base64] : []));
    expect(base64Of(whole).map(b => b.length)).toEqual([400_000, 26_668, 160_000]);
    for (const b of base64Of(header)) expect(b.length).toBeLessThanOrEqual(87_380);
    const lost = (ms: AgentMessage[]): unknown[] => ms.flatMap(m => m.parts.filter(p => p.type === 'text' && String(p.value).startsWith('[附件已丢失')).map(p => p.value));
    expect(lost(whole)).toEqual(['[附件已丢失: gone.png]']);
    expect(lost(header)).toEqual(lost(whole));

    for (const rt of ALL) {
      const a = measureRequest(rt, { messages: whole, tools: [] }).media;
      const b = measureRequest(rt, { messages: header, tools: [] }).media;
      expect(b, rt.protocol).toEqual(a);
      expect(a, rt.protocol).toHaveLength(3);
    }
    const anth = measureRequest(ANTHROPIC, { messages: header, tools: [] }).media;
    expect(anth[0]).toEqual({ kind: 'image', tokens: 36 * 29, basis: 'formula' });
    expect(anth[1]).toEqual({ kind: 'image', tokens: 23 * 18, basis: 'formula' });
    expect(anth[2]).toEqual({ kind: 'image', tokens: 4784, basis: 'upper-bound' });
  });

  it('M12 空闲推算的请求消息：垫着下一条用户消息组——图片保留窗口与「当前轮」都把它算在内，组完拿掉占位', () => {
    writeFileSync(join(dir, 'a.png'), pngBytes(1000, 800, 300_000));
    const resolve = (rel: string) => join(dir, rel.replace('attachments/', ''));
    const withImage: AgentMessage = { role: 'user', parts: [{ type: 'text', value: 'look' }, { type: 'mediaRef', value: { id: 'a', relativePath: 'attachments/a.png', mimeType: 'image/png' } }] };
    const reply = (text: string): AgentMessage => ({ role: 'assistant', parts: [{ type: 'text', value: text }] });
    const next = (): AgentMessage => ({ role: 'user', parts: [{ type: 'text', value: '' }] });
    const images = (ms: AgentMessage[]): number => ms.flatMap(m => m.parts).filter(p => p.type === 'imageData').length;
    const preview = (h: AgentMessage[]) => buildPreviewMessages([...h, next()], new Map(), resolve);

    // 带图的那一轮刚答完：下一次请求里它是「上一轮」，图还在保留窗口内，但不是当前轮的图
    const one = preview([withImage, reply('a chart')]);
    expect(one.needs).toEqual({ currentImages: 0, historyImages: 1 });
    expect(one.messages).toHaveLength(2);
    expect(images(one.messages)).toBe(1);
    // 只读了文件头
    expect(((one.messages[0].parts[1].value) as { base64: string }).base64.length).toBeLessThanOrEqual(87_380);
    // 不垫下一条时，同一段历史会把带图的消息当成当前轮（这正是循环发请求时对「正在发送的那条」的看法，不是对下一次请求的）
    expect(countImageNeeds(buildRequestMessages([withImage, reply('a chart')], new Map(), resolve, { headerOnly: true }))).toEqual({ currentImages: 1, historyImages: 0 });

    // 又过了一轮纯文字：下一次请求只保留「将要发的那条 + 上一轮」，带图的那一轮已换成占位文字
    const two = preview([withImage, reply('a chart'), user('thanks'), reply('welcome')]);
    expect(two.needs).toEqual({ currentImages: 0, historyImages: 0 });
    expect(two.messages).toHaveLength(4);
    expect(images(two.messages)).toBe(0);
    expect(two.messages[0].parts).toEqual([{ type: 'text', value: 'look' }, { type: 'text', value: '[图片 a.png 已随上下文省略]' }]);
    // 占位的下一条已经拿掉：最后一条是那句回答，没有空文本的用户消息
    expect(two.messages.at(-1)).toEqual(reply('welcome'));

    // 历史以没有结果的工具调用收尾（执行途中被打断）：配对补上的「结果未知」并在下一条用户消息前面，拿掉占位后它留下
    const cut: AgentMessage = { role: 'assistant', parts: [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'file_read', input: '{"path":"a"}' } }] };
    const three = preview([user('go'), cut]);
    expect(three.messages).toHaveLength(3);
    expect(three.messages[2].role).toBe('user');
    expect(three.messages[2].parts).toEqual([{ type: 'toolResult', value: { toolUseId: 'T1', output: '[工具执行被中断，结果未知]', success: false, status: 'cancelled' } }]);

    // 新会话：只有占位，拿掉后是空的
    expect(preview([])).toEqual({ messages: [], needs: { currentImages: 0, historyImages: 0 } });
  });
});
