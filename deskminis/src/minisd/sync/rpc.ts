import type { AuthMode, RpcConnection, RpcMethods } from '../rpc/server';
import type { ChatStore } from '../store/chat-store';
import type { PairingService } from '../remote/pairing';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  toWireMessage, toWireMarker, toWireSession, parseSyncHello, SYNC_PROTOCOL_VERSION, LOCAL_SYNC_CAPS,
  type WireCompactMarker, type WireMessage, type WireSession,
} from './wire';

const MAX_PUSH_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB

function assertAuthMode(conn: RpcConnection, allowed: AuthMode[], what: string): void {
  if (!allowed.includes(conn.authMode)) {
    throw new Error(`${what} 需要 authMode=${allowed.join('/')}，当前=${conn.authMode}`);
  }
}

/** M3c createSyncMethods 可选第二参（Task 3 注入 pairingService/listenPort 供 sync.hello；Task 6 注入 onMergedRemote 供 sync.push 广播）。 */
export interface SyncMethodsOpts {
  /** sync.hello 查 authKey 用（Task 3） */
  pairingService?: PairingService;
  /** sync.hello 响应带的本端监听端口，供对端刷新地址簿（Task 3/4，端口漂移自愈） */
  listenPort?: number;
  /** sync.push handler 合并对若 hasChange=true 调此回调，供 Task 6 广播 chat.event synced（fromDevice = conn.peerFingerprint） */
  onMergedRemote?: (peerFingerprint: string | undefined, sessionId: string, result: { mergedCount: number; orphanMarkerIds: string[]; hasChange: boolean }) => void;
}

export function createSyncMethods(chat: ChatStore, opts?: SyncMethodsOpts): RpcMethods {
  return {
    'sync.push': async (p: { sessionId: string; payload: { messages: WireMessage[]; markers: WireCompactMarker[]; session?: WireSession } }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.push');
      const size = JSON.stringify(p.payload).length;
      if (size > MAX_PUSH_PAYLOAD_BYTES) {
        throw new Error(`sync.push payload 超过 1MB 限制（实际 ${size} 字节），请用 sync.pull 分批`);
      }
      const result = chat.mergeRemoteSession(p.payload, p.sessionId);
      // M3c Task 6：hasChange=true 时经 onMergedRemote 回调广播 chat.event synced（双路径）
      if (result.hasChange && opts?.onMergedRemote) {
        opts.onMergedRemote(conn.peerFingerprint, p.sessionId, result);
      }
      return result;
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

    // M3c Task 3：出站互认协议 sync.hello 挑战应答（决策 1 层 2，authMode=remote）
    // 连接建立后、任何同步流量前，OutboundClient 发 sync.hello { nonce }，
    // 服务端用 conn.peerFingerprint 找 PairingKey.authKey 算 HMAC-SHA256(authKey, 'm3c-hello'||nonce)，
    // 客户端用本地 authKey 算同样 HMAC 比对——验证失败即 terminate + 退避。
    // 响应带 listenPort 供对端刷新地址簿（端口漂移自愈，必改 4）。
    // W2b-8 版本协商：请求与响应都可多带 protocolVersion/caps；对端不带（0.1.1）就记为旧版 {1, {}}。
    // 0.1.1 的应答端忽略多余参数、0.1.1 的发起端只读 mac/listenPort，所以多带字段两个方向都互通；
    // MAC 输入保持 'm3c-hello'+nonce 不变——并进版本或能力位会让 0.1.1 互认失败。
    'sync.hello': async (p: { nonce: string; protocolVersion?: unknown; caps?: unknown }, conn) => {
      assertAuthMode(conn, ['remote'], 'sync.hello');
      if (!conn.peerFingerprint) throw new Error('sync.hello 需要 peerFingerprint（出站连接专用）');
      if (!opts?.pairingService) throw new Error('sync.hello 需要 pairingService 注入');
      const key = opts.pairingService.get(conn.peerFingerprint);
      if (!key) throw new Error('未配对设备');
      // 鉴权（已配对）通过之后才记对端声明：未配对连接发来的参数不能留在 conn 上被后续 sync.* 采信
      conn.syncPeer = parseSyncHello(p);
      const mac = hmac(sha256, key.authKey, new TextEncoder().encode('m3c-hello' + p.nonce));
      // caps 给副本：LOCAL_SYNC_CAPS 是全进程共享的冻结常量，响应对象交出去后谁再改它都不该碰到本端声明
      return { mac: Buffer.from(mac).toString('hex'), listenPort: opts.listenPort ?? 0, protocolVersion: SYNC_PROTOCOL_VERSION, caps: { ...LOCAL_SYNC_CAPS } };
    },
  };
}
