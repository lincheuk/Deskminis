import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOpenCodeGo, sessionHeaders } from '../src/minisd/providers/session-headers';
import { OpenAIProvider } from '../src/minisd/providers/openai';
import { AnthropicProvider } from '../src/minisd/providers/anthropic';
import { GeminiProvider } from '../src/minisd/providers/gemini';
import type { StreamRequest } from '../src/minisd/providers/types';

afterEach(() => vi.unstubAllEnvs());
describe('N23 OpenCode Go识别', () => {
  it.each(['https://opencode.ai/zen/go/v1', 'https://opencode.ai/inference/go/v1', 'https://OPENCODE.AI/zen/go/v1'])('%s', url => expect(isOpenCodeGo(url)).toBe(true));
  it.each(['https://xopencode.ai/zen/go/v1', 'https://opencode.ai/inference/v1', 'https://opencode.ai/zen/v1', 'https://example.com/zen/go/v1', 'https://opencode.ai.evil.com/zen/go/v1', 'https://opencode.ai/other/zen/go/v1', 'https://opencode.ai/other/inference/go/v1', 'https://opencode.ai/zen/gopher/v1', 'not a url'])('%s不认', url => expect(isOpenCodeGo(url)).toBe(false));
  it('解析出的opencode-go目录服务商可识别本机中转，不靠型号名', () => {
    expect(isOpenCodeGo('http://127.0.0.1:8000/v1', 'opencode-go')).toBe(true);
    expect(isOpenCodeGo('http://127.0.0.1:8000/v1', 'opencode')).toBe(false);
  });
  it('版本有值与缺省', () => {
    const session = { id: 'session-A', catalogProviderId: 'opencode-go' };
    vi.stubEnv('DESKMINIS_APP_VERSION', '0.3.0');
    expect(sessionHeaders('https://relay.example', session)).toEqual({ 'x-opencode-session': 'session-A', 'User-Agent': 'DeskMinis/0.3.0' });
    vi.stubEnv('DESKMINIS_APP_VERSION', '');
    expect(sessionHeaders('https://relay.example', session)).toEqual({ 'x-opencode-session': 'session-A', 'User-Agent': 'DeskMinis' });
  });
  it('无会话、空会话与其它服务商均不声明两个头', () => {
    expect(sessionHeaders('https://opencode.ai/zen/go/v1')).toEqual({});
    expect(sessionHeaders('https://opencode.ai/zen/go/v1', { id: '' })).toEqual({});
    expect(sessionHeaders('https://other.example/v1', { id: 'session-A' })).toEqual({});
  });
});

const baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures/n23-request-bodies.json'), 'utf8')) as { rows: { protocol: string; name: string; request: StreamRequest; body: string }[] };
describe('N23 三家provider真实传输头与改前正文', () => {
  for (const row of baseline.rows) {
    it.each(['host', 'catalog', 'other', 'no-session'] as const)(row.protocol + '/' + row.name + '/%s', async mode => {
      vi.stubEnv('DESKMINIS_APP_VERSION', '0.3.0');
      let got: RequestInit | undefined;
      const Cls = { openai: OpenAIProvider, anthropic: AnthropicProvider, gemini: GeminiProvider }[row.protocol]!;
      const provider = new Cls({ apiKey: 'synthetic', modelId: 'n23-synthetic', baseUrl: mode === 'host' || mode === 'no-session' ? 'https://opencode.ai/zen/go/v1' : 'https://relay.example/v1', fetchImpl: async (_url, init) => { got = init; return new Response('synthetic', { status: 403 }); } });
      const request: StreamRequest = { ...row.request, ...(mode !== 'no-session' ? { session: { id: 'session-A', ...(mode === 'catalog' ? { catalogProviderId: 'opencode-go' } : {}) } } : {}) };
      await expect(async () => { for await (const _ of provider.streamAgentMessage(request)) { /* capture only */ } }).rejects.toThrow('403');
      expect(got?.body).toBe(row.body);
      const headers = new Headers(got?.headers);
      expect(headers.get('x-opencode-session')).toBe(mode === 'host' || mode === 'catalog' ? 'session-A' : null);
      expect(headers.get('user-agent')).toBe(mode === 'host' || mode === 'catalog' ? 'DeskMinis/0.3.0' : null);
    });
  }
});
