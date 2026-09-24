// 本地假 OpenAI 兼容端点（Z 波实拍用）：让**真 provider**走一遍模型组降级，不靠 FakeProvider。
//   POST /fail/v1/chat/completions → 429（fallbackable：loop 立刻换下一个成员）
//   POST /ok/v1/chat/completions   → 200 SSE，流式回一段文本 + finish_reason:stop + [DONE]
// 每次请求记一行 hits，剧本据此断言「主力真的被请求过、备用真的接了手」。
import { createServer } from 'node:http';

export async function startMockOpenAI({ reply = '备用模型接手了这条消息。' } = {}) {
  const hits = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let model = '';
      try { model = JSON.parse(body || '{}').model ?? ''; } catch { /* 非 JSON 也记一笔 */ }
      hits.push({ path: req.url, model, at: Date.now() });
      if (req.url?.startsWith('/fail/')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited (mock)', type: 'rate_limit' } }));
        return;
      }
      if (req.url?.startsWith('/ok/') && req.url.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
        chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: reply } }] });
        chunk({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found (mock)' } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { port, hits, close: () => new Promise((r) => srv.close(() => r())) };
}
