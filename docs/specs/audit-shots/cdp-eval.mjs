// CDP 驱动：node cdp-eval.mjs "<js expression>" —— 在 DeskMinis 渲染进程里求值并打印 JSON 结果
import WebSocket from 'ws';

const expr = process.argv[2];
if (!expr) { console.error('usage: node cdp-eval.mjs "<expr>"'); process.exit(2); }

const list = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = list.find(t => t.type === 'page' && t.url.includes('localhost:5173'));
if (!page) { console.error('page not found', list.map(t => [t.type, t.url])); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.on('message', d => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
  }
});
await new Promise(r => ws.on('open', r));
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(res.result?.value ?? res, null, 1));
ws.close();
process.exit(0);
