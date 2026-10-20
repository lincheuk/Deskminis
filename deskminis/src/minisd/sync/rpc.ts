import type { RpcConnection, RpcMethods } from '../rpc/server';
import { assertAuthMode } from '../rpc/access';
import type { ChatStore } from '../store/chat-store';
import type { PairingService } from '../remote/pairing';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  toWireMessage, toWireMarker, toWireSession, parseSyncHello, peerHasCap, SYNC_PROTOCOL_VERSION, LOCAL_SYNC_CAPS, SYNC_CAP,
  type SyncPayload, type SyncPeerInfo,
} from './wire';
import { receiveRemotePayload, type SyncReceiveResult, type TombstoneHost } from './receive';

const MAX_PUSH_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB

/** M3c createSyncMethods 可选第二参（Task 3 注入 pairingService/listenPort 供 sync.hello；Task 6 注入 onMergedRemote 供 sync.push 广播）。 */
export interface SyncMethodsOpts {
  /** sync.hello 查 authKey 用（Task 3） */
  pairingService?: PairingService;
  /** sync.hello 响应带的本端监听端口，供对端刷新地址簿（Task 3/4，端口漂移自愈） */
  listenPort?: number;
  /** sync.push handler 合并对若 hasChange=true 调此回调，供 Task 6 广播 chat.event synced（fromDevice = conn.peerFingerprint） */
  onMergedRemote?: (peerFingerprint: string | undefined, sessionId: string, result: SyncReceiveResult) => void;
  /** F11A：sync.hello 鉴权通过、记下对端声明之后调一次（每条入站连接一次）。附件同步据此知道入站对端支不支持、
   *  并把「这个连接周期里交换过哪些会话」清零。回调抛错被吞掉，不影响互认。 */
  onPeerHello?: (peerFingerprint: string | undefined, peer: SyncPeerInfo) => void;
  /** F11B：应用对端墓碑的宿主（index.ts 注入：先停 run 再落库）。不传 = 直接落库（单测）。 */
  lifecycleHost?: TombstoneHost;
  /** F11B：本端是否暂停同步。为真时对 remote 连接不交出任何墓碑（界面写的是「已暂停：不再与其它设备收发会话」）。 */
  isPaused?: () => boolean;
}

export function createSyncMethods(chat: ChatStore, opts?: SyncMethodsOpts): RpcMethods {
  /** 调用方认识墓碑：本机连接（这台设备自己），或在 sync.hello 里声明了 tombstones 能力的对端。
   *  经本机回环 ?paseto= 进来的 remote 连接没做过 sync.hello，按旧版处理。 */
  const capable = (conn: RpcConnection): boolean => conn.authMode === 'local' || peerHasCap(conn.syncPeer, SYNC_CAP.TOMBSTONES);
  /** 对这条连接静默：本端暂停期间不向 remote 连接交出墓碑。本机连接（渲染端、CLI、测试）不受影响。 */
  const quiet = (conn: RpcConnection): boolean => conn.authMode === 'remote' && opts?.isPaused?.() === true;

  return {
    'sync.push': async (p: { sessionId: string; payload: SyncPayload }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.push');
      const size = JSON.stringify(p.payload ?? null).length;
      if (size > MAX_PUSH_PAYLOAD_BYTES) {
        throw new Error(`sync.push payload 超过 1MB 限制（实际 ${size} 字节），请用 sync.pull 分批`);
      }
      // F11B：内容与墓碑走同一个收包入口（墓碑经宿主先停 run 再落库；内容的防复活闸在合并事务的第一步）
      const result = await receiveRemotePayload(chat, opts?.lifecycleHost, p.sessionId, p.payload, conn.peerFingerprint);
      // 旧版对端推来本机已删的会话：抛错。它的 pushToPeer 遇错即停，后面的分批不再发；
      // 回一个它不认识的 rejected 字段的话，它每次对账都会把整个会话再推一遍
      if (result.rejected === 'tombstoned' && !capable(conn)) {
        throw new Error(`sync.push 被拒：会话已删除: ${p.sessionId}`);
      }
      // M3c Task 6：hasChange=true 时经 onMergedRemote 回调广播 chat.event synced（双路径）。
      // 墓碑与被拒的载荷不算「同步了 N 条」
      if (result.tombstone === undefined && !result.rejected && result.hasChange && opts?.onMergedRemote) {
        opts.onMergedRemote(conn.peerFingerprint, p.sessionId, result);
      }
      if (quiet(conn)) {
        const { lifecycle: _withheld, ...rest } = result;
        return rest;
      }
      return result;
    },

    'sync.pull': async (p: { sessionId: string; afterTs?: number }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.pull');
      // F11B：本机已删除的会话（含保留副本）只交出墓碑，而且只交给认识它的调用方；
      // 其余照旧报「会话不存在」，与从未存在过的会话逐字相同
      if (chat.isDeleted(p.sessionId)) {
        if (capable(conn) && !quiet(conn)) return { messages: [], markers: [], lifecycle: chat.wireLifecycle(p.sessionId) };
        throw new Error(`sync.pull 会话不存在: ${p.sessionId}`);
      }
      const session = chat.getSession(p.sessionId);
      if (!session) throw new Error(`sync.pull 会话不存在: ${p.sessionId}`);
      const afterTs = p.afterTs ?? 0;
      const allMsgs = chat.listMessages(p.sessionId);
      const messages = allMsgs.filter(m => m.createdAt > afterTs).map(toWireMessage);
      const allMarkers = chat.listCompactMarkers(p.sessionId);
      const markers = allMarkers.filter(m => m.createdAt > afterTs).map(m => toWireMarker(m, allMsgs));
      // 恢复过的会话带上偶数登记（旧版忽略多余字段）
      const lifecycle = chat.wireLifecycle(p.sessionId);
      return lifecycle ? { messages, markers, session: toWireSession(session), lifecycle } : { messages, markers, session: toWireSession(session) };
    },

    'sync.cursor': async (p: { sessionIds?: string[] }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.cursor');
      const ids = p.sessionIds ?? chat.listSessions().map(s => s.id);
      return ids.map(id => ({ sessionId: id, ...chat.getSessionCursor(id) }));
    },

    'sync.list': async (_p, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.list');
      const sessions = chat.listSyncedSessions();
      // F11B：旧版看到的键与以前相同；认识墓碑的调用方多拿到墓碑头清单（对账只比头、只补差量）。
      // 本端暂停时不给清单，只说一声 lifecyclePaused：对端这一轮不向本端推墓碑、也不来拉墓碑
      if (!capable(conn)) return { sessions };
      if (quiet(conn)) return { sessions, lifecyclePaused: true };
      return { sessions, tombstones: chat.listTombstoneHeads() };
    },

    'sync.ack': async (p: { sessionId: string; lastMergedTs: number }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.ack');
      // 直接 SQL UPDATE（ChatStore 没必要加方法）
      // F11B：保留副本（remote_tombstoned_at 非空）对这里等同不存在，与 getSession 同一条过滤——它是冻结的，会话行一列都不改。
      // 不报错：对不存在的会话 ack 本来就是空操作，已删除的会话要与之分不出来（旧版对端看到的面不变；本端暂停时也不借报错漏出墓碑）
      (chat as any).db.prepare('UPDATE sessions SET last_synced_at=? WHERE id=? AND remote_tombstoned_at IS NULL').run(p.lastMergedTs, p.sessionId);
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
      const peer = parseSyncHello(p);
      conn.syncPeer = peer;
      try { opts.onPeerHello?.(conn.peerFingerprint, peer); } catch { /* 回调出错不影响互认 */ }
      const mac = hmac(sha256, key.authKey, new TextEncoder().encode('m3c-hello' + p.nonce));
      // caps 给副本：LOCAL_SYNC_CAPS 是全进程共享的冻结常量，响应对象交出去后谁再改它都不该碰到本端声明
      return { mac: Buffer.from(mac).toString('hex'), listenPort: opts.listenPort ?? 0, protocolVersion: SYNC_PROTOCOL_VERSION, caps: { ...LOCAL_SYNC_CAPS } };
    },
  };
}
