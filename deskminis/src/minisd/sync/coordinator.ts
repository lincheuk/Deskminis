import type { ChatStore } from '../store/chat-store';
import type { RpcServer } from '../rpc/server';
import type { OutboundClient } from './outbound-client';

export interface SyncCoordinatorOpts {
  debounceMs?: number;
  /** M3c Task 6：出站客户端（拨号方双职责 push+pull）；不传则仅监听方职责（broadcast sync.dirty）。 */
  outbound?: OutboundClient;
}

/**
 * 同步协调器（M3c 决策 4 同步职责模型）。
 *
 * 职责拓扑：
 *   - 监听方职责（恒执行）：chat.onDirty → 入 pendingQueue → 去抖 N ms → rpc.broadcast('sync.dirty', { sessionId, cursor })
 *     远端 GUI / CLI / 拨号方出站连接收到 sync.dirty 后作为 RPC 客户端调本端 sync.pull
 *   - 拨号方职责（opts.outbound 注入时执行）：flush 时对每个本端拨号的对端 `dialedPeers()` 主动分批 push
 *     （消除 >1MB 死区，决策 4「push 载荷分批」）；收到对端 sync.dirty notify（OutboundClient.onRemoteDirty）→ pullFromPeer
 *
 * ping-pong 终止性（决策 4）：
 *   - mergeRemoteSession 内部 hasChange=true 才调 onDirty（Task 1 必改 6）
 *   - 对端回灌 id 全重合 → hasChange=false → 不再 onDirty → 链终止
 *
 * chat.event synced 双路径广播（小项 7e）：
 *   - 拨号方路径：pullFromPeer mergeRemoteSession hasChange=true → 本协调器广播 chat.event synced
 *   - 监听方路径：sync.push handler hasChange=true → 经 onMergedRemote 回调广播（index.ts 注入）
 *
 * 计划内修正 1：保留 M3b 的 200ms 去抖（计划伪代码为直 broadcast+push）；push 并入 flush()。
 *   理由：现有 sync-coordinator.test.ts 依赖去抖行为，去掉会回归 793 基线。
 * 计划内修正 2：outbound 并入 SyncCoordinatorOpts（计划伪代码为构造函数第 3 参）。
 *   理由：计划把 outbound 插为第 3 参会把 opts 挤到第 4 参，破坏现有 `new SyncCoordinator(chat, rpc, { debounceMs })` 调用（793 回归）。
 *   最小修正：outbound 作为 opts 字段，保持 constructor(chat, rpc, opts?) 签名不变。Produces 接口不变。
 */
export class SyncCoordinator {
  private pendingQueue = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  private readonly outbound?: OutboundClient;
  private stopped = false;
  /** M6 R2 本端暂停（决策点 2-5/2-7）：暂停时本端不发起任何同步（flush 的 broadcast+push、reconcile 的 push），
   *  但收下对端数据照常（onRemoteDirty/pull、sync.push 合并不受影响）。 */
  private paused = false;
  /** 出站客户端是否已启动拨号（暂停态启动时跳过拨号，恢复时补拨——否则方案 A 的 push 无对端可推）。 */
  private dialed = false;
  /** M3c 修复：重连双向对账 in-flight 标志（per-peer，防连接抖动风暴）。 */
  private reconciling = new Set<string>();

  constructor(
    private chat: ChatStore,
    private rpc: RpcServer,
    opts: SyncCoordinatorOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 200;
    this.outbound = opts.outbound;
  }

  onDirty(sessionId: string): void {
    if (this.stopped) return;
    this.pendingQueue.add(sessionId);
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  /** M6 R2：切换暂停阀。暂停时本端不发起同步；解除后收敛靠 control.resume 显式触发（方案 A），不靠队列残留。 */
  setPaused(paused: boolean): void {
    this.paused = paused;
    // 仅在「从未拨号」（暂停态启动跳过首拨）时补拨——否则方案 A 的 push 无对端可推。
    // 已在线连接不得重连：dial() 会 cleanup 旧连接并重连，重连触发 onOnline → reconcilePeer 双向对账，
    //   等效实现收敛，会掩盖方案 A 的缺失（M6 先红门控正是被这条副作用掩盖成假绿的）。
    //   因此这里用 !this.dialed（真·从未拨号）而非恒真的 dialed=start 被调过。
    if (!paused && this.outbound && !this.dialed) { this.outbound.start(); this.dialed = true; }
  }

  /**
   * M6 R2 方案 A：恢复收敛（决策点 2-7）。必须在暂停阀已关闭（setPaused(false)）之后调用——
   * 否则重新入队的 sid 会被仍开着的暂停阀在 flush() 里丢弃（「恢复了但什么也没推出去」）。
   * 对全部 synced session 重新 onDirty 入队后 flush()：监听方角色走 flush 的 broadcast(sync.dirty)
   * （远端拨号方客户端收到后 pull 本端），拨号方角色走 flush 的 pushToPeer（本端主动 push），一次覆盖两种角色。
   */
  async resumeSync(): Promise<void> {
    for (const s of this.chat.listSyncedSessions()) {
      this.onDirty(s.id);
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    const sids = Array.from(this.pendingQueue);
    this.pendingQueue.clear();
    // M6 R2 暂停阀（决策点 2-7）：暂停期间本端 dirty 信号到此丢弃（队列已清空），不 broadcast 不 push。
    // 恢复收敛不由残留队列驱动——由 control.resume 显式 onDirty 全部会话 + 本 flush 触发（方案 A，见 Task 5）。
    if (this.paused) return;
    for (const sid of sids) {
      const cursor = this.chat.getSessionCursor(sid);
      // 监听方职责：广播 sync.dirty 给本端入站客户端（拨号方作为入站客户端会收到）
      this.rpc.broadcast('sync.dirty', { sessionId: sid, cursor });
      // 拨号方职责：对每个本端拨号的对端，主动分批 push（决策 4）
      if (this.outbound) {
        for (const peerFp of this.outbound.dialedPeers()) {
          void this.pushToPeer(peerFp, sid);
        }
      }
    }
  }

  /** 分批推送给对端（决策 4「push 载荷分批」，消除 >1MB 死区，必改 1）。 */
  private async pushToPeer(peerFp: string, sid: string): Promise<void> {
    if (!this.outbound) return;
    const batches = this.chat.buildPushBatches(sid); // 默认 maxBytes=512KB
    for (const batch of batches) {
      try {
        await this.outbound.callRpc(peerFp, 'sync.push', { sessionId: sid, payload: batch });
      } catch {
        // 中途断线 → 重连后整会话重推（INSERT OR IGNORE 幂等，安全）；
        // 一期接受失败留日志，不降级 sync.dirty（监听方无出站无法 pull）
        return;
      }
    }
  }

  /** 收到对端 sync.dirty notify → 拉取并合并（拨号方 pull 职责，决策 4）。 */
  private async pullFromPeer(peerFp: string, sid: string): Promise<void> {
    if (!this.outbound) return;
    try {
      const payload = await this.outbound.callRpc(peerFp, 'sync.pull', { sessionId: sid, afterTs: 0 });
      const result = this.chat.mergeRemoteSession(payload as Parameters<ChatStore['mergeRemoteSession']>[0], sid);
      // Task 1 门控：hasChange=false 不再 onDirty（防 ping-pong）
      if (result.hasChange) {
        // 小项 7e：拨号方路径广播 chat.event synced 供 renderer 消费
        this.rpc.broadcast('chat.event', { kind: 'synced', sessionId: sid, mergedCount: result.mergedCount, fromDevice: peerFp });
        // mergeRemoteSession 内部已调 onDirty → 触发拓扑分流（broadcast + push）
        // → 但对端回灌 id 全重合 → hasChange=false → 终止
      }
    } catch {
      // 对端断线或超时 → OutboundClient 会自动重连，下次 sync.dirty 再触发 pull
    }
  }

  /** 实装：挂 OutboundClient.onRemoteDirty + onOnline + 启动出站拨号（决策 8 装配）。 */
  start(): void {
    if (this.outbound) {
      this.outbound.onRemoteDirty = (peerFp, sid) => {
        void this.pullFromPeer(peerFp, sid);
      };
      // M3c 修复：重连双向对账挂钩 onOnline（补 Task 6 计划缺口）。
      //   onOnline 只在拨号方触发（OutboundClient.dial 成功 + sync.hello 互认通过），
      //   监听方不拨号无此回调。重连场景下持数据方可能是任意一侧——
      //   单向 pull 在「持数据方 = 拨号方」时失效（拨号方 pull 对端拿不到自己宕机期数据），
      //   故必须双向：push 本端全部 + pull 对端全部，hasChange 门控吸收冗余。
      //   首次配对连接亦触发全量对账（合理副作用：历史会话首连即同步）。
      this.outbound.onOnline = (peerFp) => {
        void this.reconcilePeer(peerFp);
      };
      // M6 R2：暂停态启动不拨号（决策点 2-5/2-7「暂停态不拨号」）；恢复时 setPaused(false) 补拨。
      // dialed 语义 = 「是否真的拨过号」，而非「start() 被调过」——暂停态启动跳过首拨时置 false，
      // setPaused(false) 才能据 !dialed 补拨；已在线连接不得由此重连（见 setPaused 注释）。
      if (!this.paused) { this.outbound.start(); this.dialed = true; }
    }
  }

  /**
   * M3c 修复：重连双向对账（补 Task 6 计划缺口）。
   *
   * 触发：OutboundClient.onOnline（拨号方重连或首次拨号成功）。
   * 行为：
   *   a. push 方向：本端全部会话推给对端（含宕机期新写）
   *   b. pull 方向：拉对端全部会话清单，逐个 pullFromPeer 合并
   *
   * 终止性论证（决策 4 ping-pong 门控延续）：
   *   - 两方向回灌均经 mergeRemoteSession，hasChange=false（id 全重合）→ 不 onDirty → 链终止
   *   - 冗余有界于一轮对账：本方法不在对账中触发递归 onOnline
   *   - in-flight 标志防连接抖动风暴：对账进行中重入直接跳过
   *
   * dialNow 一过性说明（backlog 跟踪）：
   *   remote.pair.join 成功后调 dialNow 立即拨号（绕过主从裁决），属于一次性初连手段；
   *   进程重启后 start() 恢复主从裁决，dialNow 不再触发，行为已可接受。
   */
  private async reconcilePeer(peerFp: string): Promise<void> {
    if (!this.outbound) return;
    if (this.reconciling.has(peerFp)) return; // 防抖：对账进行中跳过重入
    this.reconciling.add(peerFp);
    try {
      // a. push 方向：本端全部会话推给对端——M6 R2 暂停时跳过（本端不发起同步），但保留 pull（决策点 2-7）
      if (!this.paused) {
        for (const s of this.chat.listSyncedSessions()) {
          void this.pushToPeer(peerFp, s.id);
        }
      }
      // b. pull 方向：拉对端会话清单，逐个合并（不受暂停影响，对端数据照常收下）
      const list = await this.outbound.callRpc(peerFp, 'sync.list', {}) as { sessions: Array<{ id: string }> };
      for (const s of list.sessions ?? []) {
        void this.pullFromPeer(peerFp, s.id);
      }
    } catch {
      // 对端刚离线 / sync.list 失败 → 静默放弃，等下次重连再对账
    } finally {
      this.reconciling.delete(peerFp);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    this.pendingQueue.clear();
    this.outbound?.stop();
  }
}
