import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { openDb } from '../src/minisd/store/db';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// M6 Task 3（决策点 2-1/2-3）：权限决议落库——permission.request / permission.resolved（timeout/answered）
// 必须成对写入 audit_logs，且含 requestId 关联；脱敏后的 detail 落盘。

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  const notifications: { method: string; params: any }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

async function boot(opts?: { permTimeoutMs?: number }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-perm-audit-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0, ...opts });
  stop = srv.close;
  return { ...srv, dataDir };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

function toolScript(name: string, input: Record<string, unknown>): string {
  return `__tool__ ${name} ${JSON.stringify(input)}`;
}

/** 打开正在运行的 minisd 的 audit_logs 表（同一进程内二次连接，读后即关）。 */
function readAudit(dataDir: string): { eventType: string; sessionId: string | null; payloadJson: string }[] {
  const db = openDb(join(dataDir, 'minis.db'));
  try {
    return db.prepare('SELECT event_type AS eventType, session_id AS sessionId, payload_json AS payloadJson FROM audit_logs ORDER BY created_at ASC, id ASC').all() as never[];
  } finally {
    db.close();
  }
}

describe('M6 Task 3：权限决议落库', () => {
  it('permission.request 与 permission.resolved(answered) 成对落库，requestId 关联', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-perm-audit-')), 'x.txt');
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: 'ok', tool_title: '写' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;
    await c.call('permission.respond', { requestId, decision: 'allow-once' });
    await waitFor('permission.resolved(answered)', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId && n.params.reason === 'answered'));
    await new Promise(r => setTimeout(r, 200)); // 让 resolved 广播落盘

    const rows = readAudit(dataDir);
    const reqRow = rows.find(r => r.eventType === 'permission.request');
    const resRow = rows.find(r => r.eventType === 'permission.resolved');
    expect(reqRow).toBeTruthy();
    expect(resRow).toBeTruthy();
    // requestId 关联成对
    expect(JSON.parse(reqRow!.payloadJson).requestId).toBe(requestId);
    expect(JSON.parse(resRow!.payloadJson).requestId).toBe(requestId);
    expect(JSON.parse(resRow!.payloadJson).reason).toBe('answered');
    expect(JSON.parse(resRow!.payloadJson).decision).toBe('allow-once');
    // session_id 写入
    expect(reqRow!.sessionId).toBe(s.id);
    // req.detail（含工具正文）经 auditRedact 落盘
    const reqPayload = JSON.parse(reqRow!.payloadJson);
    expect(JSON.stringify(reqPayload.req)).toContain('x.txt');
    c.close();
  }, 30000);

  it('permission.resolved(timeout) 落库（reason=timeout）', async () => {
    const { port, authToken, dataDir } = await boot({ permTimeoutMs: 120 });
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-perm-audit-')), 'y.txt');
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: 'x', tool_title: '写' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;
    await waitFor('permission.resolved(timeout)', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId && n.params.reason === 'timeout'));
    await new Promise(r => setTimeout(r, 200));

    const rows = readAudit(dataDir);
    const resRow = rows.find(r => r.eventType === 'permission.resolved');
    expect(resRow).toBeTruthy();
    expect(JSON.parse(resRow!.payloadJson).requestId).toBe(requestId);
    expect(JSON.parse(resRow!.payloadJson).reason).toBe('timeout');
    c.close();
  }, 30000);

  it('permission.request 审计剔除 preview 全文（只记 hasPreview 布尔）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-perm-audit-')), 'pv.txt');
    // 正文打独特标记：若 preview 全文泄入审计落盘，此断言即失败
    const marker = 'PREVIEW-SECRET-BODY-9f2e';
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: marker, tool_title: '写' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    // 广播侧要带全文（权限卡渲染差分的唯一数据源）
    const broadcast = c.notifications.find(n => n.method === 'permission.request')!;
    expect(broadcast.params.req.preview).toEqual({ oldText: '', newText: marker });
    const requestId = broadcast.params.requestId;
    await c.call('permission.respond', { requestId, decision: 'deny' });
    await waitFor('permission.resolved(answered)', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId));
    await new Promise(r => setTimeout(r, 200));

    const rows = readAudit(dataDir);
    const reqRow = rows.find(r => r.eventType === 'permission.request');
    expect(reqRow).toBeTruthy();
    // 审计不落 preview 全文：文件内容副本会让审计库膨胀（单条最多 2×20000 字符）
    expect(reqRow!.payloadJson).not.toContain(marker);
    const reqPayload = JSON.parse(reqRow!.payloadJson);
    expect(reqPayload.req.preview).toBeUndefined();
    expect(reqPayload.hasPreview).toBe(true);
    c.close();
  }, 30000);

  it('audit.list RPC：可查、过滤生效、payload 防御性再脱敏', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-perm-audit-')), 'z.txt');
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: 'ok', tool_title: '写' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;
    await c.call('permission.respond', { requestId, decision: 'deny' });
    await waitFor('permission.resolved(answered)', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId));
    await new Promise(r => setTimeout(r, 200));

    const all = (await c.call('audit.list', {})).result;
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.rows.length).toBeGreaterThanOrEqual(2);
    expect(all.rows[0]).toHaveProperty('eventType');
    expect(all.rows[0]).toHaveProperty('payload');
    // 过滤：按 sessionId / eventType
    const byType = (await c.call('audit.list', { eventType: 'permission.request' })).result;
    expect(byType.rows.every((r: any) => r.eventType === 'permission.request')).toBe(true);
    const bySid = (await c.call('audit.list', { sessionId: s.id })).result;
    expect(bySid.rows.length).toBeGreaterThanOrEqual(2);
    // double-redact：哪怕落盘 payload 里的 detail 被读回，出口仍无密钥样式
    const detail = JSON.stringify(bySid.rows.map((r: any) => r.payload));
    expect(detail).not.toContain('sk-');
    expect(detail).not.toContain('Bearer ');
    c.close();
  }, 30000);
});