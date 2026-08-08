import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// M6 R4 审计日志（决策点 2-3/2-4）：
//   - 审计事件写入 audit_logs 表，跨会话查询面（AuditLogger.list）。
//   - 保留与轮转：独立于会话生命周期（deleteSession 不碰 audit_logs），按条数上限 FIFO 淘汰（决策点 2-3）。
//   - 脱敏边界：contrast 于 M4 的「入 prompt 出口消毒」（agent/sanitize.ts）——落盘方向只洗「密钥/凭据样式」，
//     保留命令正文/文件路径/剪贴板内容（那是审计存在的核心价值）；密钥材料字段名直接剔除（白名单防御）。

/** URL user:pass@ → 脱敏（复用 M4 URL_CRED 语义）。 */
const URL_CRED = /([a-zA-Z][a-zA-Z0-9+\-.]*):\/\/[^/\s:]+:[^/\s@]+@/g;

/** 常见密钥样式：Bearer 令牌 / sk-... / api_key 系列头。擦值保留键名。 */
const BEARER = /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
const SK_PREFIX = /(\bsk-[A-Za-z0-9_-]+)/g;
const APIKEY_VALUE = /(api[_-]?key['"]?\s*[:=]\s*)([A-Za-z0-9._~+/=-]+)/gi;

/** 密钥材料字段名（白名单防御）：出现即整字段剔除，禁入审计落盘（红线）。 */
const KEY_FIELD_NAMES = new Set(['authKey', 'privateKey', 'sessionSecret', 'paseto', 'token', 'mac', 'nonce']);

function redactString(s: string): string {
  return s
    .replace(URL_CRED, '$1://***:***@')
    .replace(BEARER, '$1***')
    .replace(SK_PREFIX, 'sk-***')
    .replace(APIKEY_VALUE, '$1***');
}

/** 深拷贝并脱敏任意 JSON 值；密钥材料字段名直接剔除。 */
export function auditRedact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(item => auditRedact(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (KEY_FIELD_NAMES.has(k)) continue; // 密钥材料字段剔除
      out[k] = auditRedact(v);
    }
    return out;
  }
  return value;
}

export interface AuditListOpts {
  eventType?: string;
  sessionId?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}
export interface AuditRow { id: string; eventType: string; sessionId: string | null; payload: Record<string, unknown> }
export interface AuditAppendOpts { sessionId?: string; peerFingerprint?: string; createdAt?: number }

export class AuditLogger {
  private readonly maxRows: number;

  constructor(private db: Database.Database, opts: { maxRows?: number } = {}) {
    this.maxRows = opts.maxRows ?? 100_000;
  }

  /** 追加审计事件（经 auditRedact 落盘）+ 条数 FIFO 轮转。 */
  append(eventType: string, payload: unknown, opts: AuditAppendOpts = {}): void {
    const id = randomUUID().toUpperCase();
    const createdAt = opts.createdAt ?? Date.now() / 1000;
    const redacted = auditRedact(payload);
    this.db.prepare(
      'INSERT INTO audit_logs (id, event_type, session_id, peer_fingerprint, payload_json, created_at) VALUES (?,?,?,?,?,?)',
    ).run(id, eventType, opts.sessionId ?? null, opts.peerFingerprint ?? null, JSON.stringify(redacted), createdAt);
    this.prune();
  }

  /** 条数 FIFO 轮转：超 maxRows 删最旧（决策点 2-3）。 */
  private prune(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get() as { c: number }).c;
    if (count <= this.maxRows) return;
    const surplus = count - this.maxRows;
    this.db.prepare(
      'DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs ORDER BY created_at ASC, id ASC LIMIT ?)',
    ).run(surplus);
  }

  /** 跨会话查询视图。 */
  list(opts: AuditListOpts): { rows: AuditRow[]; total: number } {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (opts.eventType) { conds.push('event_type=?'); args.push(opts.eventType); }
    if (opts.sessionId) { conds.push('session_id=?'); args.push(opts.sessionId); }
    if (opts.from !== undefined) { conds.push('created_at>=?'); args.push(opts.from); }
    if (opts.to !== undefined) { conds.push('created_at<=?'); args.push(opts.to); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM audit_logs${where}`).get(...args) as { c: number }).c;
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const rows = this.db.prepare(
      `SELECT id, event_type, session_id, payload_json FROM audit_logs${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset) as { id: string; event_type: string; session_id: string | null; payload_json: string }[];
    return {
      total,
      rows: rows.map(r => ({
        id: r.id,
        eventType: r.event_type,
        sessionId: r.session_id,
        payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      })),
    };
  }
}