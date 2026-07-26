import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RawMessage, SessionMeta, TokenUsage } from '../../shared/types';
import { serializeParts, parseParts } from '../../shared/parts';

interface MessageRow {
  id: string; session_id: string; role: string; parts_json: string;
  created_at: number; updated_at: number; token_usage: string | null;
  sort_order: number; reasoning_content: string | null;
  stream_interrupt_count: number; error_info: string | null;
}

export class ChatStore {
  constructor(private db: Database.Database) {}

  nowEpoch(): number { return Date.now() / 1000; }
  newId(): string { return randomUUID().toUpperCase(); }

  createSession(title = '新会话'): SessionMeta {
    const s: SessionMeta = { id: this.newId(), title, createdAt: this.nowEpoch(), updatedAt: this.nowEpoch() };
    this.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)')
      .run(s.id, s.title, s.createdAt, s.updatedAt);
    return s;
  }

  getSession(id: string): SessionMeta | undefined {
    const r = this.db.prepare('SELECT id, title, model_binding, created_at, updated_at, pinned_at FROM sessions WHERE id=?').get(id) as
      { id: string; title: string; model_binding: string | null; created_at: number; updated_at: number; pinned_at: number | null } | undefined;
    if (!r) return undefined;
    return { id: r.id, title: r.title, modelBinding: r.model_binding ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at, pinnedAt: r.pinned_at ?? undefined };
  }

  listSessions(): SessionMeta[] {
    const rows = this.db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC').all() as { id: string }[];
    return rows.map(r => this.getSession(r.id)!)
  }

  updateSessionTitle(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title=?, updated_at=? WHERE id=?').run(title, this.nowEpoch(), id);
  }

  deleteSession(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM compact_markers WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    });
    tx();
  }

  appendMessage(m: Omit<RawMessage, 'sortOrder' | 'updatedAt'>): RawMessage {
    const { mx } = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) mx FROM messages WHERE session_id=?').get(m.sessionId) as { mx: number };
    const full: RawMessage = { ...m, sortOrder: mx + 1, updatedAt: this.nowEpoch() };
    this.db.prepare(`INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, token_usage, sort_order, reasoning_content, stream_interrupt_count, error_info)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(full.id, full.sessionId, full.role, serializeParts(full.parts), full.createdAt, full.updatedAt,
        full.tokenUsage ? JSON.stringify(full.tokenUsage) : null, full.sortOrder,
        full.reasoningContent ?? null, full.streamInterruptCount, full.errorInfo ?? null);
    this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(full.updatedAt, full.sessionId);
    return full;
  }

  updateMessage(id: string, patch: { parts?: RawMessage['parts']; tokenUsage?: TokenUsage; errorInfo?: string; streamInterruptCount?: number }): void {
    const sets: string[] = ['updated_at=@now'];
    const args: Record<string, unknown> = { id, now: this.nowEpoch() };
    if (patch.parts !== undefined) { sets.push('parts_json=@parts'); args.parts = serializeParts(patch.parts); }
    if (patch.tokenUsage !== undefined) { sets.push('token_usage=@usage'); args.usage = JSON.stringify(patch.tokenUsage); }
    if (patch.errorInfo !== undefined) { sets.push('error_info=@err'); args.err = patch.errorInfo; }
    if (patch.streamInterruptCount !== undefined) { sets.push('stream_interrupt_count=@sic'); args.sic = patch.streamInterruptCount; }
    this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id=@id`).run(args);
  }

  listMessages(sessionId: string): RawMessage[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC, id ASC').all(sessionId) as MessageRow[];
    return rows.map(r => ({
      id: r.id, sessionId: r.session_id, role: r.role as RawMessage['role'],
      parts: parseParts(r.parts_json), createdAt: r.created_at, updatedAt: r.updated_at,
      sortOrder: r.sort_order, tokenUsage: r.token_usage ? JSON.parse(r.token_usage) : undefined,
      reasoningContent: r.reasoning_content ?? undefined,
      streamInterruptCount: r.stream_interrupt_count, errorInfo: r.error_info ?? undefined,
    }));
  }
}
