/**
 * F11B 旧版对端夹具（文件名不匹配 *.test.ts）：一台只有同步面的「旧版设备」。
 *
 * 同步代码是提交 9d0a32d 的逐字快照（tests/fixtures/legacy-sync-9d0a32d/：wire、merge、rpc、coordinator、
 * outbound-client、chat-store，只改了 import 路径）——它不声明任何能力位、不认识墓碑、删除就是物理删行。
 * 通道与配对用的是当前的代码（RpcServer、加密通道、PairingService、业务守卫），本任务没有改它们：
 * 新旧设备之间能连上、能同步消息，差别只在同步这一层，正是混连要测的。
 *
 * 为什么不在生产代码里加一个「关掉能力位」的开关来充当旧版：那只是新版少说一句话，合并与删除逻辑仍是新的；
 * 手写一份旧形状的处理器则是「作者以为的旧行为」。快照是旧代码本身。
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/minisd/store/db';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { PairingStore, PairingService } from '../src/minisd/remote/pairing';
import { createRemoteMethods, createAdditionalVerify, guardBusinessMethod } from '../src/minisd/remote';
import { RpcServer, type RpcMethods } from '../src/minisd/rpc/server';
import { ChatStore as LegacyChatStore } from './fixtures/legacy-sync-9d0a32d/chat-store';
import { createSyncMethods as legacyCreateSyncMethods } from './fixtures/legacy-sync-9d0a32d/rpc';
import { SyncCoordinator as LegacySyncCoordinator } from './fixtures/legacy-sync-9d0a32d/coordinator';
import { OutboundClient as LegacyOutboundClient } from './fixtures/legacy-sync-9d0a32d/outbound-client';
import { wsConnect, type RpcClient } from './att-engines-util';

export interface LegacyPeer {
  name: string; dir: string; fp: string; port: number;
  local: RpcClient;
  call<T = any>(method: string, params?: unknown): Promise<T>;
  /** 旧版的会话库（同进程，直接驱动）。 */
  chat: LegacyChatStore;
  /** 收到的每一个 sync.* 请求（按到达顺序），以及处理结果是成功还是报错。 */
  requests: Array<{ method: string; params: any; authMode: string; error?: string; result?: any }>;
  /** 旧版自己发出去的每一次出站调用与它拿到的应答或错误（它的 pushToPeer / pullFromPeer 会吞掉错误，这里另记一份）。 */
  outCalls: Array<{ method: string; params: any; result?: any; error?: string }>;
  newSession(title: string): string;
  append(sid: string, text: string): string;
  /** 旧版的删除：物理删行，不留任何痕迹。 */
  physicalDelete(sid: string): void;
  messageIds(sid: string): string[];
  sessionIds(): string[];
  stop(): Promise<void>;
}

export async function startLegacyPeer(name: string, at: { dir: string; fp: string }): Promise<LegacyPeer> {
  const db = openDb(join(at.dir, 'minis.db'));
  const vault = InMemoryVault.forDataRoot(at.dir);
  const pairingStore = new PairingStore(at.dir, vault);
  const pairingService = new PairingService(pairingStore, vault);
  if (pairingService.myFingerprint !== at.fp) throw new Error('旧版对端的指纹与预生成的不一致');
  const chat = new LegacyChatStore(db, pairingService.myFingerprint);
  const requests: LegacyPeer['requests'] = [];

  // 以下照 src/minisd/index.ts 同步装配段的顺序
  let rpc: RpcServer;
  let outbound: LegacyOutboundClient | undefined;
  const remoteMethods = createRemoteMethods(pairingService, {
    onPairComplete: (fp, remoteAddr, listenPort) => {
      if (listenPort && listenPort > 0) pairingStore.setAddress(fp, `${remoteAddr?.replace(/^::ffff:/, '') ?? '127.0.0.1'}:${listenPort}`);
    },
    getOutbound: () => outbound,
    getRpcServer: () => rpc,
  });
  const isPaired = (fp: string): boolean => pairingService.get(fp) !== undefined;
  const syncOpts = {
    pairingService, listenPort: 0,
    onMergedRemote: (peerFp: string | undefined, sid: string, result: { mergedCount: number }) => {
      rpc.broadcast('chat.event', { kind: 'synced', sessionId: sid, mergedCount: result.mergedCount, fromDevice: peerFp });
    },
  };
  const syncMethods = legacyCreateSyncMethods(chat, syncOpts);
  const methods: RpcMethods = {};
  for (const k of Object.keys(syncMethods)) {
    const inner = syncMethods[k]!;
    const recorded = async (p: any, conn: any): Promise<unknown> => {
      const entry: LegacyPeer['requests'][number] = { method: k, params: p, authMode: conn.authMode };
      requests.push(entry);
      try { const r = await inner(p, conn); entry.result = r; return r; }
      catch (e) { entry.error = String((e as Error).message ?? e); throw e; }
    };
    methods[k] = guardBusinessMethod(recorded, k, isPaired);
  }
  Object.assign(methods, remoteMethods);
  const authToken = randomUUID().toUpperCase();
  rpc = new RpcServer(methods, authToken, createAdditionalVerify(pairingService));
  const port = await rpc.listen('127.0.0.1', 0);
  syncOpts.listenPort = port;
  outbound = new LegacyOutboundClient(pairingService, pairingService.myFingerprint);
  // 只在这个实例上包一层记录，快照文件本身不动
  const outCalls: LegacyPeer['outCalls'] = [];
  const rawCall = outbound.callRpc.bind(outbound);
  outbound.callRpc = (async (peerFp: string, method: string, params: unknown) => {
    const entry: LegacyPeer['outCalls'][number] = { method, params };
    outCalls.push(entry);
    try { const r = await rawCall(peerFp, method, params); entry.result = r; return r; }
    catch (e) { entry.error = String((e as Error).message ?? e); throw e; }
  }) as typeof outbound.callRpc;
  const coordinator = new LegacySyncCoordinator(chat, rpc, { outbound });
  chat.onDirty = sid => coordinator.onDirty(sid);
  coordinator.start();

  const local = await wsConnect(`ws://127.0.0.1:${port}/?token=${authToken}`);
  let stopped = false;
  return {
    name, dir: at.dir, fp: at.fp, port, local, chat, requests, outCalls,
    call: (method, params) => local.call(method, params),
    newSession: title => chat.createSession(title).id,
    append(sid, text) {
      const id = chat.newId();
      chat.appendMessage({ id, sessionId: sid, role: 'user', parts: [{ type: 'text', value: text }], createdAt: chat.nowEpoch(), streamInterruptCount: 0 });
      return id;
    },
    physicalDelete: sid => chat.deleteSession(sid),
    messageIds: sid => chat.listMessages(sid).map(m => m.id).sort(),
    sessionIds: () => chat.listSessions().map(s => s.id),
    async stop() {
      if (stopped) return;
      stopped = true;
      try { local.close(); } catch { /* 已关 */ }
      coordinator.stop();
      await rpc.close();
      db.close();
    },
  };
}
