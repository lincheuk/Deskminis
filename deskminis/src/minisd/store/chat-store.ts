import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { CompactMarker, RawMessage, SessionMeta, TokenUsage } from '../../shared/types';
import { serializeParts, parseParts } from '../../shared/parts';
import { mergeSession } from '../sync/merge';
import type { WireCompactMarker, WireMessage, WireSession } from '../sync/wire';

interface MessageRow {
  id: string; session_id: string; role: string; parts_json: string;
  created_at: number; updated_at: number; token_usage: string | null;
  sort_order: number; reasoning_content: string | null;
  stream_interrupt_count: number; error_info: string | null;
  origin_device_id: string; created_locally_at: number | null;
}

export class ChatStore {
  /** M3b：脏数据钩子（Task 6 SyncCoordinator 注入），appendMessage/appendCompactMarker 等触发 */
  onDirty?: (sessionId: string) => void;

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
    this.onDirty?.(id);
  }

  /** 写入 sessions.model_binding；取值约定见 Global Constraints。undefined/空串 = 清除。 */
  setModelBinding(sessionId: string, binding: string | undefined): void {
    const val = (typeof binding === 'string' && binding.trim() !== '') ? binding.trim() : null;
    this.db.prepare('UPDATE sessions SET model_binding=?, updated_at=? WHERE id=?').run(val, this.nowEpoch(), sessionId);
    this.onDirty?.(sessionId);
  }

  /** 写入 sessions.memory_enabled（设计 §3.4 会话级记忆开关）。 */
  setMemoryEnabled(sessionId: string, enabled: boolean): void {
    this.db.prepare('UPDATE sessions SET memory_enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, this.nowEpoch(), sessionId);
    this.onDirty?.(sessionId);
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
    this.onDirty?.(sessionId);
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
    this.onDirty?.(full.sessionId);
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
    const row = this.db.prepare('SELECT session_id FROM messages WHERE id=?').get(id) as { session_id: string } | undefined;
    if (row) this.onDirty?.(row.session_id);
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

  // ===== M3b 同步接口 =====

  /** 返回会话全部压缩 marker（按 createdAt ASC，rowid ASC 兜底）。M3b mergeSession 需要全量做 LWW。 */
  listCompactMarkers(sessionId: string): CompactMarker[] {
    const rows = this.db.prepare('SELECT * FROM compact_markers WHERE session_id=? ORDER BY created_at ASC, rowid ASC').all(sessionId) as
      { id: string; session_id: string; summary: string; last_compacted_message_id: string; created_at: number }[];
    return rows.map(r => ({ id: r.id, sessionId: r.session_id, summary: r.summary, lastCompactedMessageId: r.last_compacted_message_id, createdAt: r.created_at }));
  }

  /** 返回 sync_orphan_markers 里的 orphan marker（评审命门 2：脱孤检查用）。 */
  listOrphanMarkers(sessionId: string): CompactMarker[] {
    const rows = this.db.prepare('SELECT * FROM sync_orphan_markers WHERE session_id=?').all(sessionId) as
      { id: string; session_id: string; summary: string; last_compacted_message_id: string; created_at: number; received_at: number }[];
    return rows.map(r => ({ id: r.id, sessionId: r.session_id, summary: r.summary, lastCompactedMessageId: r.last_compacted_message_id, createdAt: r.created_at }));
  }

  /** 返回会话 cursor（供 sync.cursor）：lastMessageTs / lastMarkerTs，空会话返回 0/0。 */
  getSessionCursor(sessionId: string): { lastMessageTs: number; lastMarkerTs: number } {
    const msgRow = this.db.prepare('SELECT MAX(created_at) mx FROM messages WHERE session_id=?').get(sessionId) as { mx: number | null };
    const markerRow = this.db.prepare('SELECT MAX(created_at) mx FROM compact_markers WHERE session_id=?').get(sessionId) as { mx: number | null };
    return { lastMessageTs: msgRow.mx ?? 0, lastMarkerTs: markerRow.mx ?? 0 };
  }

  /** 返回本地全部会话 + 各自 cursor（首次连接对端 sync.list 用）。 */
  listSyncedSessions(): Array<SessionMeta & { cursor: { lastMessageTs: number; lastMarkerTs: number } }> {
    return this.listSessions().map(s => ({ ...s, cursor: this.getSessionCursor(s.id) }));
  }

  /**
   * 合并远端会话数据并落库（设计 §1-M3b / 评审命门 1/2）。
   * 红线：
   *  - raw history 追加型永不改写：新消息 INSERT OR IGNORE，UPDATE 只碰 sort_order
   *  - orphan marker 只进 sync_orphan_markers，绝不进 compact_markers（评审命门 2）
   *  - 脱孤：本次 mergeSession 已 resolve 成功的 marker 若之前是 orphan → 删 sync_orphan_markers
   */
  mergeRemoteSession(
    remote: { messages: WireMessage[]; markers: WireCompactMarker[]; session?: WireSession },
    sessionId: string,
  ): { mergedCount: number; orphanMarkerIds: string[] } {
    const tx = this.db.transaction(() => {
      const local = { messages: this.listMessages(sessionId), markers: this.listCompactMarkers(sessionId) };
      const merged = mergeSession(local, remote);
      let mergedCount = 0;
      // 消息：INSERT OR IGNORE 新消息 + UPDATE sort_order（仅当不一致）
      for (const m of merged.messages) {
        const r = this.db.prepare(`INSERT OR IGNORE INTO messages (id, session_id, role, parts_json, created_at, updated_at, token_usage, sort_order, reasoning_content, stream_interrupt_count, error_info, origin_device_id, created_locally_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(m.id, m.sessionId, m.role, serializeParts(m.parts), m.createdAt, m.updatedAt ?? m.createdAt,
            m.tokenUsage ? JSON.stringify(m.tokenUsage) : null, m.sortOrder,
            m.reasoningContent ?? null, m.streamInterruptCount, m.errorInfo ?? null,
            m.originDeviceId ?? 'legacy', m.createdLocallyAt ?? m.createdAt);
        if (r.changes > 0) mergedCount++;
        this.db.prepare('UPDATE messages SET sort_order=? WHERE id=? AND sort_order != ?').run(m.sortOrder, m.id, m.sortOrder);
      }
      const orphanSet = new Set(merged.orphanMarkerIds);
      const resolvedIds = new Set(merged.markers.filter(m => !orphanSet.has(m.id)).map(m => m.id));
      // orphan marker → sync_orphan_markers（INSERT OR REPLACE，绝不进 compact_markers）
      for (const oid of merged.orphanMarkerIds) {
        const m = merged.markers.find(x => x.id === oid)!;
        this.db.prepare('INSERT OR REPLACE INTO sync_orphan_markers (id, session_id, summary, last_compacted_message_id, created_at, received_at) VALUES (?,?,?,?,?,?)')
          .run(m.id, m.sessionId, m.summary, m.lastCompactedMessageId, m.createdAt, this.nowEpoch());
      }
      // 非 orphan marker → compact_markers（INSERT OR IGNORE + LWW UPDATE summary/last_compacted_message_id，不改 created_at）
      for (const m of merged.markers) {
        if (orphanSet.has(m.id)) continue;
        this.db.prepare('INSERT OR IGNORE INTO compact_markers (id, session_id, summary, last_compacted_message_id, created_at) VALUES (?,?,?,?,?)')
          .run(m.id, m.sessionId, m.summary, m.lastCompactedMessageId, m.createdAt);
        const existing = local.markers.find(x => x.id === m.id);
        if (existing && m.createdAt > existing.createdAt) {
          this.db.prepare('UPDATE compact_markers SET summary=?, last_compacted_message_id=? WHERE id=?')
            .run(m.summary, m.lastCompactedMessageId, m.id);
        }
      }
      // 脱孤：之前在 sync_orphan_markers、本次已 resolve 成功的 marker → 删 sync_orphan_markers
      const existingOrphans = this.listOrphanMarkers(sessionId);
      for (const om of existingOrphans) {
        if (resolvedIds.has(om.id)) {
          this.db.prepare('DELETE FROM sync_orphan_markers WHERE id=?').run(om.id);
        }
      }
      // session 元数据 LWW on updatedAt；session 不存在时 INSERT（首次同步创建）
      if (remote.session) {
        const ws = remote.session;
        const localSession = this.getSession(sessionId);
        if (!localSession) {
          this.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at, memory_enabled, model_binding, pinned_at) VALUES (?,?,?,?,?,?,?)')
            .run(sessionId, ws.title, ws.createdAt, ws.updatedAt, ws.memoryEnabled ? 1 : 0, ws.modelBinding ?? null, ws.pinnedAt ?? null);
        } else if (ws.updatedAt > localSession.updatedAt) {
          this.db.prepare('UPDATE sessions SET title=?, updated_at=?, memory_enabled=?, model_binding=?, pinned_at=? WHERE id=?')
            .run(ws.title, ws.updatedAt, ws.memoryEnabled, ws.modelBinding ?? null, ws.pinnedAt ?? null, sessionId);
        }
      } else {
        this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(this.nowEpoch(), sessionId);
      }
      return { mergedCount, orphanMarkerIds: merged.orphanMarkerIds };
    });
    const result = tx();
    this.onDirty?.(sessionId);
    return result;
  }
}
