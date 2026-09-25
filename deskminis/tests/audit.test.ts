import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { AuditLogger, auditRedact } from '../src/minisd/store/audit';
import { ChatStore } from '../src/minisd/store/chat-store';
import type Database from 'better-sqlite3';
import { URL_CRED_SPEC } from './sanitize-spec';

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
describe('W2a-7b：审计落盘脱敏的 URL 凭据一步改走线性扫描，结果与原管线逐字相同', () => {
  // 原来 store/audit.ts 自带一份 URL 凭据正则，长单行上平方级：权限卡的 detail（一条很长的 shell 命令）经它落盘，
  // audit.list 读出时还要再跑一遍，引擎主线程被卡上好几秒（W2a-7 审查 nit）。
  // 下面是 W2a-7b 之前 redactString 的原样管线：URL 凭据 → Bearer → sk- → api_key，后三步抄自 store/audit.ts
  const BEARER = /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
  const SK_PREFIX = /(\bsk-[A-Za-z0-9_-]+)/g;
  const APIKEY_VALUE = /(api[_-]?key['"]?\s*[:=]\s*)([A-Za-z0-9._~+/=-]+)/gi;
  const spec = (s: string): string => s
    .replace(URL_CRED_SPEC, '$1://***:***@')
    .replace(BEARER, '$1***')
    .replace(SK_PREFIX, 'sk-***')
    .replace(APIKEY_VALUE, '$1***');

  it('随机拼接的多行字符串：auditRedact 与原管线逐字相同', () => {
    let st = 20260926;
    const rnd = (): number => {
      st = (st + 0x6d2b79f5) | 0;
      let t = Math.imul(st ^ (st >>> 15), 1 | st);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const toks = [
      'https', 'h', 'svn+ssh', 'a_b', '9', '-', '.', '://', ':', '/', '@', 'u', 'pw', ' ', '\n', '\r\n', '\t', '\u000b', '\u00a0', '\u3000', '测',
      'https://u:pw@', 'h://u@x:p@', 'svn+ssh://a:b:c@', '9x://u:p@', '://u:p@', 'h://:p@', 'h://u:@', 'h://u/v:p@', 'a://b://c:d@',
      'Authorization: Bearer ', 'abc.DEF-1', 'sk-', 'sk-abc_1', 'api_key=', 'API-KEY: ', "apikey'=", 'x9https://u:p@h',
    ];
    const bad: string[] = [];
    let changed = 0;
    for (let n = 0; n < 5000 && bad.length < 5; n++) {
      let s = '';
      const k = 1 + Math.floor(rnd() * 16);
      for (let j = 0; j < k; j++) s += toks[Math.floor(rnd() * toks.length)];
      const want = spec(s);
      if (want !== s) changed++;
      if (auditRedact(s) !== want) bad.push(JSON.stringify(s));
    }
    expect(bad).toEqual([]);
    expect(changed).toBeGreaterThan(1000); // 大量命中了真要脱敏的情形，不是空转
  });

  it('20 万字符的长单行（很长的一条 shell 命令）脱敏在 300ms 内完成，凭据照样打码', () => {
    const line = 'a'.repeat(100_000) + ' git clone https://user:secret@example.com/r.git ' + 'b1+.-'.repeat(20_000);
    const t0 = performance.now();
    const out = auditRedact({ kind: 'shell', detail: line }) as { detail: string };
    const ms = performance.now() - t0;
    expect(out.detail).toContain('https://***:***@example.com/r.git');
    expect(out.detail).not.toContain('secret');
    expect(ms, `耗时 ${ms.toFixed(0)}ms`).toBeLessThan(300);
  });
});
