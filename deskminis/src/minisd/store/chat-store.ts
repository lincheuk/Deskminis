import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { CompactMarker, RawMessage, SessionMeta, TokenUsage } from '../../shared/types';
import { serializeParts, parseParts } from '../../shared/parts';

interface MessageRow {
  id: string; session_id: string; role: string; parts_json: string;
  created_at: number; updated_at: number; token_usage: string | null;
  sort_order: number; reasoning_content: string | null;
  stream_interrupt_count: number; error_info: string | null;
  origin_device_id: string; created_locally_at: number | null;
}

export class ChatStore {
  constructor(private db: Database.Database, private defaultOriginDeviceId: string = 'local') {}

  nowEpoch(): number { return Date.now() / 1000; }
  newId(): string { return randomUUID().toUpperCase(); }

  createSession(title = '新会话'): SessionMeta {
    const s: SessionMeta = { id: this.newId(), title, createdAt: this.nowEpoch(), updatedAt: this.nowEpoch() };
    this.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)')
      .run(s.id, s.title, s.createdAt, s.updatedAt);
    return s;
  }

  getSession(id: string): SessionMeta | undefined {
    const r = this.db.prepare('SELECT id, title, model_binding, memory_enabled, created_at, updated_at, pinned_at FROM sessions WHERE id=?').get(id) as
      { id: string; title: string; model_binding: string | null; memory_enabled: number; created_at: number; updated_at: number; pinned_at: number | null } | undefined;
    if (!r) return undefined;
    return { id: r.id, title: r.title, modelBinding: r.model_binding ?? undefined, memoryEnabled: r.memory_enabled === 1, createdAt: r.created_at, updatedAt: r.updated_at, pinnedAt: r.pinned_at ?? undefined };
  }

  listSessions(): SessionMeta[] {
    const rows = this.db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC').all() as { id: string }[];
    return rows.map(r => this.getSession(r.id)!)
  }

  updateSessionTitle(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title=?, updated_at=? WHERE id=?').run(title, this.nowEpoch(), id);
  }

  /** 写入 sessions.model_binding；取值约定见 Global Constraints。undefined/空串 = 清除。 */
  setModelBinding(sessionId: string, binding: string | undefined): void {
    const val = (typeof binding === 'string' && binding.trim() !== '') ? binding.trim() : null;
    this.db.prepare('UPDATE sessions SET model_binding=?, updated_at=? WHERE id=?').run(val, this.nowEpoch(), sessionId);
  }

  /** 写入 sessions.memory_enabled（设计 §3.4 会话级记忆开关）。 */
  setMemoryEnabled(sessionId: string, enabled: boolean): void {
    this.db.prepare('UPDATE sessions SET memory_enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, this.nowEpoch(), sessionId);
  }

  deleteSession(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM compact_markers WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    });
    tx();
  }

  /** 追加压缩摘要 marker（设计 §4.2「压缩」）：锚定 lastCompactedMessageId，推理时合成 effectiveAgentHistory。 */
  appendCompactMarker(sessionId: string, summary: string, lastCompactedMessageId: string): CompactMarker {
    const m: CompactMarker = { id: this.newId(), sessionId, summary, lastCompactedMessageId, createdAt: this.nowEpoch() };
    this.db.prepare('INSERT INTO compact_markers (id, session_id, summary, last_compacted_message_id, created_at) VALUES (?,?,?,?,?)')
      .run(m.id, m.sessionId, m.summary, m.lastCompactedMessageId, m.createdAt);
    return m;
  }

  /** 取该会话最新的压缩 marker（按 createdAt DESC）；无则 undefined。
   *  rowid DESC 作 tiebreaker：Windows 下 Date.now() 分辨率约 15ms，连续两次 appendCompactMarker
   *  可能落到同一 createdAt，单按 created_at 排序非确定性，需以插入顺序（rowid）兜底确保「最新插入」返回。 */
  getLatestCompactMarker(sessionId: string): CompactMarker | undefined {
    const r = this.db.prepare('SELECT * FROM compact_markers WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(sessionId) as
      { id: string; session_id: string; summary: string; last_compacted_message_id: string; created_at: number } | undefined;
    if (!r) return undefined;
    return { id: r.id, sessionId: r.session_id, summary: r.summary, lastCompactedMessageId: r.last_compacted_message_id, createdAt: r.created_at };
  }

  appendMessage(m: Omit<RawMessage, 'sortOrder' | 'updatedAt'>): RawMessage {
    const { mx } = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) mx FROM messages WHERE session_id=?').get(m.sessionId) as { mx: number };
    const full: RawMessage = {
      ...m, sortOrder: mx + 1, updatedAt: this.nowEpoch(),
      originDeviceId: m.originDeviceId ?? this.defaultOriginDeviceId,
      createdLocallyAt: m.createdLocallyAt ?? m.createdAt,
    };
    this.db.prepare(`INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, token_usage, sort_order, reasoning_content, stream_interrupt_count, error_info, origin_device_id, created_locally_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(full.id, full.sessionId, full.role, serializeParts(full.parts), full.createdAt, full.updatedAt,
        full.tokenUsage ? JSON.stringify(full.tokenUsage) : null, full.sortOrder,
        full.reasoningContent ?? null, full.streamInterruptCount, full.errorInfo ?? null,
        full.originDeviceId, full.createdLocallyAt);
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
      originDeviceId: r.origin_device_id, createdLocallyAt: r.created_locally_at ?? r.created_at,
    }));
  }
}
