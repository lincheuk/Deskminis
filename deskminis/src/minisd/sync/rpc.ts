import type { AuthMode, RpcConnection, RpcMethods } from '../rpc/server';
import type { ChatStore } from '../store/chat-store';
import { toWireMessage, toWireMarker, toWireSession, type WireCompactMarker, type WireMessage, type WireSession } from './wire';

const MAX_PUSH_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB

function assertAuthMode(conn: RpcConnection, allowed: AuthMode[], what: string): void {
  if (!allowed.includes(conn.authMode)) {
    throw new Error(`${what} 需要 authMode=${allowed.join('/')}，当前=${conn.authMode}`);
  }
}

export function createSyncMethods(chat: ChatStore): RpcMethods {
  return {
    'sync.push': async (p: { sessionId: string; payload: { messages: WireMessage[]; markers: WireCompactMarker[]; session?: WireSession } }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.push');
      const size = JSON.stringify(p.payload).length;
      if (size > MAX_PUSH_PAYLOAD_BYTES) {
        throw new Error(`sync.push payload 超过 1MB 限制（实际 ${size} 字节），请用 sync.pull 分批`);
      }
      return chat.mergeRemoteSession(p.payload, p.sessionId);
    },

    'sync.pull': async (p: { sessionId: string; afterTs?: number }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.pull');
      const session = chat.getSession(p.sessionId);
      if (!session) throw new Error(`sync.pull 会话不存在: ${p.sessionId}`);
      const afterTs = p.afterTs ?? 0;
      const allMsgs = chat.listMessages(p.sessionId);
      const messages = allMsgs.filter(m => m.createdAt > afterTs).map(toWireMessage);
      const allMarkers = chat.listCompactMarkers(p.sessionId);
      const markers = allMarkers.filter(m => m.createdAt > afterTs).map(m => toWireMarker(m, allMsgs));
      return { messages, markers, session: toWireSession(session) };
    },

    'sync.cursor': async (p: { sessionIds?: string[] }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.cursor');
      const ids = p.sessionIds ?? chat.listSessions().map(s => s.id);
      return ids.map(id => ({ sessionId: id, ...chat.getSessionCursor(id) }));
    },

    'sync.list': async (_p, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.list');
      return { sessions: chat.listSyncedSessions() };
    },

    'sync.ack': async (p: { sessionId: string; lastMergedTs: number }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.ack');
      // 直接 SQL UPDATE（ChatStore 没必要加方法）
      (chat as any).db.prepare('UPDATE sessions SET last_synced_at=? WHERE id=?').run(p.lastMergedTs, p.sessionId);
      return { ok: true };
    },
  };
}
