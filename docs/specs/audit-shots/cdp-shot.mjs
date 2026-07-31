// CDP 截屏：node cdp-shot.mjs <name> —— 从合成器直接抓渲染进程视口，存 docs/specs/audit-shots/<name>.png
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const name = process.argv[2];
if (!name) { console.error('usage: node cdp-shot.mjs <name>'); process.exit(2); }

const list = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = list.find(t => t.type === 'page' && t.url.includes('localhost:5173'));
if (!page) { console.error('page not found'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
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
await send('Page.enable', {});
const shot = await send('Page.captureScreenshot', { format: 'png' });
const out = `docs/specs/audit-shots/${name}.png`;
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
ws.close();
process.exit(0);
