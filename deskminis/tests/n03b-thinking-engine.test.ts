import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import { wireClient, waitFor, runEventsOf, type WireClient } from './state-sync-fixture';
import { n03bCatalogFixture, NEW_LEVELS } from './n03b-thinking-fixture';
import { jsonResponse } from './runtime-model-fixture';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { InputQueueStore } from '../src/minisd/store/input-queue';

let engine: CapturedEngine | undefined, c: WireClient | undefined, http: Server | undefined;
afterEach(async () => {
  c?.close(); await engine?.close();
  if (http) await new Promise<void>(ok => http!.close(() => ok()));
  c = undefined; engine = undefined; http = undefined;
});

describe('N03b 真实RPC与本机HTTP请求', () => {
  for (const kind of ['openai-compat', 'anthropic', 'gemini'] as const) {
    it('chat.prompt收新值、请求体与提示到达 ' + kind, async () => {
      const hits: any[] = [];
      http = createServer((req, res) => {
        let raw = '';
        req.on('data', b => { raw += b; });
        req.on('end', () => {
          hits.push(JSON.parse(raw));
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const frames = kind === 'openai-compat' ? [
            { choices: [{ index: 0, delta: { content: '合成回复' } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ] : kind === 'anthropic' ? [
            { type: 'message_start', message: { usage: { input_tokens: 1 } } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '合成回复' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ] : [{ candidates: [{ content: { parts: [{ text: '合成回复' }] }, finishReason: 'STOP' }] }];
          for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
          res.end(kind === 'openai-compat' ? 'data: [DONE]\n\n' : '');
        });
      });
      await new Promise<void>(ok => http!.listen(0, '127.0.0.1', () => ok()));
      const api = `http://127.0.0.1:${(http.address() as { port: number }).port}/v1`;
      const dir = mkdtempSync(join(tmpdir(), 'dm-n03b-engine-'));
      const data = n03bCatalogFixture(api) as any;
      for (const modelId of ['claude-x', 'gem-v']) data.n03b.models[modelId] = {
        limit: { context: 200_000, output: 96_000 }, reasoning: true, tool_call: true,
        reasoning_options: [{ type: 'budget_tokens', min: 1024 }], modalities: { input: ['text'], output: ['text'] },
      };
      const cat = new ModelCatalog(join(dir, 'models-dev-cache.json'), async () => jsonResponse(data));
      expect(await cat.refresh(true)).toBe(true);
      engine = await startCapturedEngine({ dataDir: dir });
      c = wireClient(engine.handle.port, engine.handle.authToken); await c.ready;
      const call = (m: string, p: any) => engine!.methods[m](p, probeConnection('local'));

      const models = kind === 'openai-compat' ? ['six', 'three', 'plain', 'manual', 'toggle'] : [kind === 'anthropic' ? 'claude-x' : 'gem-v'];
      for (const modelId of models) {
        const provider = await call('provider.instances.create', { name: '合成槽位', kind, baseUrl: api, modelId, catalogProviderId: 'n03b', apiKey: 'synthetic',
          ...(modelId === 'manual' ? { capabilityOverrides: { reasoning: true } } : {}) }) as { id: string };
        let highBudget: number | undefined;
        for (const level of ['high', ...NEW_LEVELS, 'invalid'] as const) {
          const s = await call('chat.sessions.create', { title: 'N03b合成会话' }) as { id: string };
          const n = hits.length;
          const reply = await c.call('chat.prompt', { sessionId: s.id, providerId: provider.id, text: '合成提问', thinkingLevel: level });
          expect(reply.error).toBeUndefined();
          await waitFor('N03b回合结束', () => runEventsOf(c!, s.id).some(e => e.kind === 'turnEnd'), 20000);
          expect(hits).toHaveLength(n + 1);
          const b = hits.at(-1), notices = runEventsOf(c, s.id).filter(e => e.kind === 'capability').flatMap(e => e.notices).join('\n');
          if (kind === 'openai-compat') {
            if (level === 'invalid' || modelId === 'toggle') expect(b).not.toHaveProperty('reasoning_effort');
            else expect(b.reasoning_effort).toBe(modelId === 'six' ? level : 'high');
            if (NEW_LEVELS.includes(level as any) && modelId !== 'six') expect(notices).toContain(modelId === 'toggle' ? '当前接入只发送 reasoning_effort 档位' : modelId === 'three' ? `推理档位 ${level} 改为 high` : '当前端点没有声明这一档');
          } else {
            const budget = kind === 'anthropic' ? b.thinking?.budget_tokens : b.generationConfig.thinkingConfig?.thinkingBudget;
            if (level === 'invalid') expect(budget).toBeUndefined();
            else {
              expect(Number.isFinite(budget)).toBe(true);
              if (level === 'high') highBudget = budget;
              else { expect(budget).toBe(highBudget); expect(notices).toContain('这个接入按推理预算控制，最多到高'); }
            }
          }
          expect(runEventsOf(c, s.id).filter(e => e.kind === 'error')).toEqual([]);
        }
      }
    }, 60000);
  }

  for (const level of NEW_LEVELS) {
    it('队列新档位落库、重新打开与claim保留 ' + level, () => {
      const db = openDb(':memory:');
      try {
        const chat = new ChatStore(db), s = chat.createSession();
        let queue = new InputQueueStore(db, { isSessionDeleted: id => chat.isDeleted(id) });
        const input = { sessionId: s.id, messageId: 'new-level', mode: 'queue' as const, text: '排队', thinkingLevel: level };
        expect(queue.send(input).duplicate).toBe(false);
        queue = new InputQueueStore(db, { isSessionDeleted: id => chat.isDeleted(id) });
        expect(queue.send(input).duplicate).toBe(true);
        expect(queue.claimQueue(s.id)?.request.thinkingLevel).toBe(level);
        expect(() => queue.send({ ...input, messageId: 'bad', thinkingLevel: 'invalid' as any })).toThrow('非法推理档位');
      } finally { db.close(); }
    });
  }
});
