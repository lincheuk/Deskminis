import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { AuditLogger, auditRedact } from '../src/minisd/store/audit';
import { ChatStore } from '../src/minisd/store/chat-store';
import type Database from 'better-sqlite3';

// M6 决策点 2-3/2-4：审计落盘脱敏 + 条数 FIFO 轮转 + 密钥材料禁入。
let db: Database.Database;
let audit: AuditLogger;
beforeEach(() => {
  db = openDb(':memory:');
  audit = new AuditLogger(db);
});

describe('auditRedact（落盘脱敏：只洗凭据，保留正文）', () => {
  it('URL user:pass@ → 脱敏', () => {
    const r = auditRedact({ url: 'https://alice:secret@example.com/x', body: 'ok' });
    expect((r as any).url).toBe('https://***:***@example.com/x');
    expect((r as any).body).toBe('ok'); // 其余保留
  });

  it('常见密钥样式擦值保留键名', () => {
    const r = auditRedact({
      header: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxxx',
      sk: 'sk-abcdef1234567890',
      apiKey: 'x-api-key: 4f8a2b1c9d0e',
      shell: 'curl -H "Authorization: Bearer TOK_SECRET" https://api.example.com',
    }) as any;
    expect(r.header).not.toContain('eyJ');
    expect(r.sk).not.toContain('sk-abcdef');
    expect(r.apiKey).not.toContain('4f8a2b1c9d0e');
    // 命令正文保留，但嵌入式凭据被擦
    expect(r.shell).toContain('curl');
    expect(r.shell).not.toContain('TOK_SECRET');
  });

  it('密钥材料字段名直接剔除（白名单防御）', () => {
    const r = auditRedact({ authKey: 'base64secret', privateKey: 'x', sessionSecret: 'y', paseto: 'v4.local.xyz', ok: 1 }) as any;
    expect(r.authKey).toBeUndefined();
    expect(r.privateKey).toBeUndefined();
    expect(r.sessionSecret).toBeUndefined();
    expect(r.paseto).toBeUndefined();
    expect(r.ok).toBe(1);
  });

  it('命令主体/文件路径/剪贴板正文保留', () => {
    const r = auditRedact({ detail: 'rm -rf /tmp/build', path: 'C:\\Users\\me\\file.txt', text: 'hello world' }) as any;
    expect(r.detail).toBe('rm -rf /tmp/build');
    expect(r.path).toBe('C:\\Users\\me\\file.txt');
    expect(r.text).toBe('hello world');
  });
});

describe('AuditLogger', () => {
  it('append 落库 + list 读出（含 session_id 过滤）', () => {
    audit.append('permission.request', { requestId: 'R1', req: { kind: 'shell', detail: 'dir', sessionId: 'S1', toolTitle: 'shell' }, meta: { timeoutMs: 60000 } }, { sessionId: 'S1' });
    audit.append('permission.resolved', { requestId: 'R1', reason: 'answered', decision: 'allow-once' }, { sessionId: 'S1' });
    const all = audit.list({});
    expect(all.rows).toHaveLength(2);
    const byType = audit.list({ eventType: 'permission.resolved' });
    expect(byType.rows).toHaveLength(1);
    expect(byType.rows[0].payload.reason).toBe('answered');
    const bySid = audit.list({ sessionId: 'S1' });
    expect(bySid.rows).toHaveLength(2);
  });

  it('list 支持时间范围与分页', () => {
    audit.append('a', {}, { createdAt: 100 });
    audit.append('b', {}, { createdAt: 200 });
    audit.append('c', {}, { createdAt: 300 });
    const from = audit.list({ from: 150 }).rows;
    expect(from.map(r => r.payload)).toEqual([{}, {}]); // b,c
    const page = audit.list({ limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('条数 FIFO 轮转：超上限删最旧', () => {
    const small = new AuditLogger(db, { maxRows: 3 });
    small.append('a', {}, { createdAt: 1 });
    small.append('b', {}, { createdAt: 2 });
    small.append('c', {}, { createdAt: 3 });
    small.append('d', {}, { createdAt: 4 });
    const rows = small.list({}).rows;
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.payload)).toEqual([{}, {}, {}]); // b,c,d（a 被淘汰）
  });

  it('append 经 auditRedact 落盘（密钥不出现在存储）', () => {
    audit.append('permission.request', { req: { kind: 'shell', detail: 'curl -H "Authorization: Bearer SEC_REDACT" x', sessionId: 'S1', toolTitle: 'shell' } }, { sessionId: 'S1' });
    const row = db.prepare('SELECT payload_json FROM audit_logs').get() as { payload_json: string };
    expect(row.payload_json).not.toContain('SEC_REDACT');
    expect(row.payload_json).toContain('curl');
  });
});

describe('删会话审计保留（决策点 2-3：审计独立于会话生命周期）', () => {
  it('deleteSession 只清 messages/compact_markers/sessions，audit_logs 记录仍在', () => {
    const chat = new ChatStore(db, 'me');
    const s = chat.createSession();
    chat.appendMessage({ id: 'M1', sessionId: s.id, role: 'user', parts: [{ type: 'text', value: 'hi' }], createdAt: 1.0, streamInterruptCount: 0 });
    chat.appendCompactMarker(s.id, 'summary', 'M1');
    audit.append('permission.request', { requestId: 'R1', req: { kind: 'shell', detail: 'rm x', sessionId: s.id, toolTitle: 'shell' } }, { sessionId: s.id });

    const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    // 删除前：messages / compact_markers 各一条，审计一条
    expect(count('SELECT COUNT(*) AS c FROM messages')).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM compact_markers')).toBe(1);
    expect(audit.list({}).rows).toHaveLength(1);

    chat.deleteSession(s.id);

    expect(count('SELECT COUNT(*) AS c FROM messages')).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM compact_markers')).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM sessions')).toBe(0);
    // 审计独立存活：删会话不连带删审计记录
    expect(audit.list({}).rows).toHaveLength(1);
  });
});