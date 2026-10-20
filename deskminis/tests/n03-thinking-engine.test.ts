import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import { rendererOn, wireClient, waitFor, type Renderer, type WireClient } from './state-sync-fixture';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { catalogFixture, jsonResponse } from './runtime-model-fixture';
import { buildOpenAIBody } from '../src/minisd/providers/openai';
import { buildAnthropicBody } from '../src/minisd/providers/anthropic';
import { buildGeminiBody } from '../src/minisd/providers/gemini';
import type { ThinkingLevel } from '../src/shared/types';

let engine: CapturedEngine | undefined, r: Renderer | undefined, c: WireClient | undefined, http: Server | undefined;
afterEach(async () => {
  await r?.close();
  c?.close();
  await engine?.close();
  if (http) await new Promise<void>(ok => http!.close(() => ok()));
  r = undefined;
  c = undefined;
  engine = undefined;
  http = undefined;
});

// 合成目录预置新鲜模型目录，避免验收依赖外部目录服务。
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'dm-n03-'));
  const catalog = new ModelCatalog(join(dir, 'models-dev-cache.json'), async () => jsonResponse(catalogFixture()));
  expect(await catalog.refresh(true)).toBe(true);
  engine = await startCapturedEngine({ dataDir: dir });
  return engine;
}

describe('N03 真实引擎与 provider 请求', () => {

  it('真实 renderer → RPC → 引擎 → HTTP：关省略键，三档进入请求体', async () => {
    // 本地合成端点记录实际 HTTP 请求，并返回最小合法流式答复。
    const hits: any[] = [];
    http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', b => chunks.push(b));
      req.on('end', () => {
        hits.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '验收答复' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(ok => http!.listen(0, '127.0.0.1', () => ok()));
    const port = (http.address() as { port: number }).port;

    // 真实引擎只使用合成实例与会话，渲染端经过实际 WebSocket RPC。
    const e = await boot();
    const local = probeConnection('local');
    const call = (m: string, p: any) => e.methods[m](p, local);
    const provider = await call('provider.instances.create', {
      name: 'N03',
      kind: 'openai-compat',
      baseUrl: 'http://127.0.0.1:' + port + '/v1',
      modelId: 'n03-synthetic',
      apiKey: 'synthetic',
      capabilityOverrides: { reasoning: true },
      maxOutputTokens: 32768
    }) as { id: string };
    await call('provider.setDefault', { id: provider.id });
    const s = await call('chat.sessions.create', { title: 'N03 验收' }) as { id: string };
    c = wireClient(e.handle.port, e.handle.authToken);
    await c.ready;
    r = await rendererOn({ info: () => ({ port: e.handle.port, token: e.handle.authToken, alive: true }) });
    r.chat.activeId = s.id;
    await r.chat.refreshSessions();
    await r.quiet();
    const prompts: any[] = [];
    const original = r.rpc.call.bind(r.rpc);
    r.rpc.call = ((m: string, p: any) => {
      if (m === 'chat.prompt') prompts.push(p);
      return original(m, p);
    }) as typeof r.rpc.call;

    // 每档等待真实回合结束，分别检查提交载荷与最终请求体。
    for (const level of ['off', 'low', 'medium', 'high'] as ThinkingLevel[]) {
      const n = hits.length, ended = c.notifications.filter(x => x.method === 'chat.event' && x.params.event?.kind === 'turnEnd').length;
      r.chat.setThinkingLevel(level);
      await r.chat.send('N03 ' + level);
      await waitFor('回合结束', () => c!.notifications.filter(x => x.method === 'chat.event' && x.params.event?.kind === 'turnEnd').length > ended, 20000);
      await r.quiet();
      expect(hits).toHaveLength(n + 1);
      if (level === 'off') {
        expect(prompts.at(-1)).not.toHaveProperty('thinkingLevel');
        expect(hits.at(-1)).not.toHaveProperty('reasoning_effort');
      } else {
        expect(prompts.at(-1).thinkingLevel).toBe(level);
        expect(hits.at(-1).reasoning_effort).toBe(level);
      }
    }
  }, 60000);

  it('真实 resolve 应答复用后端自适应判断，OpenAI 同名型号不误判', async () => {
    // 实际 RPC 应答区分 Anthropic 自适应型号、普通型号与其它协议同名型号。
    const e = await boot();
    const call = (p: any) => e.methods['provider.runtime.resolve'](p, probeConnection('local')) as Promise<{ thinkingServerAdaptive: boolean }>;
    for (const [kind, modelId, expected] of [
      ['anthropic', 'claude-opus-5-5', true],
      ['anthropic', 'claude-x', false],
      ['openai-compat', 'claude-opus-5-5', false]
    ] as const) {
      expect((await call({ kind, modelId, baseUrl: kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://relay.example/v1' })).thinkingServerAdaptive).toBe(expected);
    }
  }, 60000);

  for (const [level, budget, geminiBudget] of [
    ['off', undefined, undefined],
    ['low', 8192, 4096],
    ['medium', 32767, 16384],
    ['high', 32767, 24576]
  ] as const) {
    it('三家请求构建器的既有档位语义 ' + level, () => {
      // 既有三家映射与 maxTokens 夹取规则保持不变，关档省略推理字段。
      const req = { messages: [], tools: [], maxTokens: 32768, thinkingLevel: level };
      const o = buildOpenAIBody(req, 'm');
      const a = buildAnthropicBody(req, 'claude-x');
      const g = buildGeminiBody(req, 'm') as { generationConfig: Record<string, unknown> };
      if (level === 'off') {
        expect(o).not.toHaveProperty('reasoning_effort');
        expect(a).not.toHaveProperty('thinking');
        expect(g.generationConfig).not.toHaveProperty('thinkingConfig');
      } else {
        expect(o.reasoning_effort).toBe(level);
        expect(a.thinking).toEqual({ type: 'enabled', budget_tokens: budget });
        expect(g.generationConfig.thinkingConfig).toEqual({ thinkingBudget: geminiBudget, includeThoughts: true });
      }
    });
  }
});
