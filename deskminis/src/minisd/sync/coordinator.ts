import type { ChatStore } from '../store/chat-store';
import type { RpcServer } from '../rpc/server';
import type { OutboundClient } from './outbound-client';
import type { AttachmentSyncPort } from './attachments/engine';
import { compareLifecycle, isDeletedVersion } from './lifecycle';
import { receiveRemotePayload, type SyncReceiveResult, type TombstoneHost } from './receive';
import { parseLifecycleHead, parseWireLifecycle, peerHasCap, SYNC_CAP, type WireLifecycleHead } from './wire';

export type { AttachmentSyncPort } from './attachments/engine';

export interface SyncCoordinatorOpts {
  debounceMs?: number;
  /** M3c Task 6：出站客户端（拨号方双职责 push+pull）；不传则仅监听方职责（broadcast sync.dirty）。 */
  outbound?: OutboundClient;
  /** F11A：附件同步的端口。不传时本协调器的行为与没有附件同步时逐字相同；端口方法永不抛。
   *  附件作业排在该会话的一次推或一次拉完成之后，不调 chat.onDirty，不引起消息层的往返。 */
  attachments?: AttachmentSyncPort;
  /** F11B：应用对端墓碑的宿主（index.ts 注入：先停 run 再落库）。不传 = 直接落库（单测）。 */
  lifecycleHost?: TombstoneHost;
}

/**
 * Q12：重连对账里同时在走的会话数上限（推、拉两段各自计）。
 *
 * 取舍：上限越小，同时读进内存的会话越少；但一轮对账的时长约为「RPC 数 × 往返时延 ÷ 上限」，
 * 而出站连接约每 30 秒重拨一次（OutboundClient 的令牌重铸），一轮走不完就被掐断、下一轮又从清单头上开始。
 * 16 是折中：两个方向各一个 RPC 的 1000 个会话，在 50 ms 往返时延下一轮约 6 秒（上限为 4 时约 25 秒）。
 * 这是按上式估的取值，不是在真实网络上调出来的。
 */
const RECONCILE_CONCURRENCY = 16;

/** 对端应答按 unknown 处理：取一个字段，取不到就是 undefined。 */
function fieldOf(res: unknown, key: string): unknown {
  return res !== null && typeof res === 'object' ? (res as Record<string, unknown>)[key] : undefined;
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
  private readonly attachments?: AttachmentSyncPort;
  private readonly lifecycleHost?: TombstoneHost;
  /** F11B：暂停期间本机做的删除（会话 id）。暂停时墓碑不发出，恢复同步时靠它补发——
   *  存活会话恢复时会全量重排，已删除的不在那份清单里，所以单独记。只在内存里：
   *  进程在暂停期间重启过的，靠恢复后的第一次对账按差量补。 */
  private pausedTombstones = new Set<string>();
  private stopped = false;
  /** M6 R2 本端暂停（决策点 2-5/2-7）：暂停时本端不发起任何同步（flush 的 broadcast+push、reconcile 的 push），
   *  但收下对端数据照常（onRemoteDirty/pull、sync.push 合并不受影响）。 */
  private paused = false;
  /** 出站客户端是否已启动拨号（暂停态启动时跳过拨号，恢复时补拨——否则方案 A 的 push 无对端可推）。 */
  private dialed = false;
  /** M3c 修复：重连双向对账 in-flight 标志（per-peer，防连接抖动风暴）。 */
  private reconciling = new Set<string>();
  /** Q12：每个对端上线过几次。一轮对账只属于起它的那条连接，发现这个数变了（连接换过）就收手。 */
  private onlineCount = new Map<string, number>();
  /** Q12：对账还在走的时候对端又上线了一次——等这一轮收手后补一轮。每个对端至多记一笔。 */
  private reconcileAgain = new Set<string>();
  /** Q12：对账里已经报过「跳过」的会话。每个会话只报一次，否则每一轮（约 30 秒）一行。 */
  private skipWarned = new Set<string>();

  constructor(
    private chat: ChatStore,
    private rpc: RpcServer,
    opts: SyncCoordinatorOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 200;
    this.outbound = opts.outbound;
    this.attachments = opts.attachments;
    this.lifecycleHost = opts.lifecycleHost;
  }

  /** F11B：这个对端认不认识墓碑。只看它在 sync.hello 里的声明；不在线、没声明、出站客户端取不到，一律当不认识。 */
  private peerCap(peerFp: string): boolean {
    return peerHasCap(this.outbound?.peerInfo?.(peerFp), SYNC_CAP.TOMBSTONES);
  }

  /** 本端拨出去的这条连接此刻是否在线。 */
  private peerOnline(peerFp: string): boolean {
    return this.outbound?.dialedPeers().includes(peerFp) ?? false;
  }

  /**
   * Q12：对账里对一批会话逐个推或拉，最多 RECONCILE_CONCURRENCY 个同时在走；已经开始的都结束了才返回。
   *
   * 以前是对全部会话 void 调用。pushToPeer 在第一个 await 之前就把整个会话读出来、切好批次，于是同一个 tick 里
   * 全库的批次都在内存，每个会话一个 10 秒超时的 RPC 同时挂在一条连接上；拉取同理，应答是整个会话一帧。
   * 这里只管对账自己发起的推和拉：flush() 与收到 sync.dirty 之后的拉取仍是各自一次全发。
   *
   * current() 为假（关停、对端掉线、连接换过）之后不再取新的会话——剩下的每一个只会白读一遍库再失败；
   * 已经开始的那几个照常走完。单个会话失败或抛错（比如它的某一行读不出来）只影响它自己，后面的会话照常。
   */
  private async eachSession(ids: readonly string[], current: () => boolean, run: (sid: string) => Promise<unknown>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length && current()) {
        const sid = ids[next++];
        try {
          await run(sid);
        } catch (e) {
          this.warnSkipped(sid, e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, ids.length) }, worker));
  }

  /** 对账里某个会话抛了错：记一行警告。只记是哪个会话、哪类错误——错误文本里可能带着消息内容。 */
  private warnSkipped(sid: string, e: unknown): void {
    if (this.skipWarned.has(sid)) return;
    this.skipWarned.add(sid);
    const code = fieldOf(e, 'code');
    const kind = (e instanceof Error ? e.name : typeof e) + (typeof code === 'string' ? ` ${code}` : '');
    console.warn(`reconcilePeer: 会话 ${sid} 出错，对账跳过它（${kind}）；同一个会话只报这一次`);
  }

  onDirty(sessionId: string): void {
    if (this.stopped) return;
    // F11A：消息变了，附件的引用缓存与「已收敛」记号跟着失效
    this.attachments?.markDirty(sessionId);
    this.pendingQueue.add(sessionId);
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  /** M6 R2：切换暂停阀。暂停时本端不发起同步；解除后收敛靠 control.resume 显式触发（方案 A），不靠队列残留。 */
  setPaused(paused: boolean): void {
    // F11A：附件按「收发全停」处理（比消息严：成块的字节，用户按暂停就是要停下传输）
    this.attachments?.setPaused(paused);
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
    // F11B：暂停期间本机做的删除也补发（拨号方角色推墓碑；监听方角色广播 sync.dirty，对端来拉时拿到墓碑）
    for (const sid of this.pausedTombstones) this.onDirty(sid);
    this.pausedTombstones.clear();
    await this.flush();
  }

  async flush(): Promise<void> {
    const sids = Array.from(this.pendingQueue);
    this.pendingQueue.clear();
    // M6 R2 暂停阀（决策点 2-7）：暂停期间本端 dirty 信号到此丢弃（队列已清空），不 broadcast 不 push。
    // 恢复收敛不由残留队列驱动——由 control.resume 显式 onDirty 全部会话 + 本 flush 触发（方案 A，见 Task 5）。
    // F11B：被丢弃的信号里，已删除的会话记一笔，resumeSync 据此补发墓碑
    if (this.paused) {
      for (const sid of sids) if (this.chat.isDeleted(sid)) this.pausedTombstones.add(sid);
      return;
    }
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

  /**
   * 分批推送给对端（决策 4「push 载荷分批」，消除 >1MB 死区，必改 1）。
   * F11B：本机已删除的会话推的是墓碑（一个载荷，不分批），而且只推给认识墓碑的对端。
   * 返回 false 只表示 RPC 失败或本端此刻不能发（对账里串行补推墓碑时据此停下，剩下的下次再补）；`void` 调用的地方不看它。
   */
  private async pushToPeer(peerFp: string, sid: string): Promise<boolean> {
    if (!this.outbound || this.paused) return false;
    if (this.chat.isDeleted(sid)) {
      // 旧版对端：不发它不认识的东西，也不算失败。它手里的副本留着，删除传不过去（规格文档的混连边界）
      if (!this.peerCap(peerFp)) return true;
      let res: unknown;
      try {
        res = await this.outbound.callRpc(peerFp, 'sync.push', { sessionId: sid, payload: { messages: [], markers: [], lifecycle: this.chat.wireLifecycle(sid) } });
      } catch {
        // 超时、断线、对端离线：墓碑在本机库里，下次对账按差量补推
        return false;
      }
      await this.absorb(peerFp, sid, res);
      // 墓碑分支到此为止：不排附件作业（对已删的会话发清单，对端只会回 session_unknown）
      return true;
    }
    const batches = this.chat.buildPushBatches(sid); // 默认 maxBytes=512KB
    let last: unknown;
    let refused = false;
    for (const batch of batches) {
      let res: unknown;
      try {
        res = await this.outbound.callRpc(peerFp, 'sync.push', { sessionId: sid, payload: batch });
      } catch {
        // 中途断线 → 重连后整会话重推（INSERT OR IGNORE 幂等，安全）；
        // 一期接受失败留日志，不降级 sync.dirty（监听方无出站无法 pull）
        return false;
      }
      last = res;
      const rejected = fieldOf(res, 'rejected');
      if (rejected !== undefined && rejected !== null) refused = true;
      // 对端已删这个会话：剩下的批次不再推（每一批都会被拒）。
      // session-required 不中断：后面带会话行的批次还能让对端建行，下一轮整推补齐
      if (rejected === 'tombstoned') break;
    }
    await this.absorb(peerFp, sid, last);
    // F11A：消息推完之后排这个会话的附件作业（中途失败的不排：消息没到，对端不会受理清单）。
    // F11B：有批次被拒的也不排——对端没有这个会话，清单只会换来 session_unknown
    if (!refused) this.attachments?.schedule(peerFp, sid);
    return true;
  }

  /** F11B：对端在 sync.push 的应答里带回它的登记。比本机的新就追平：
   *  奇数 = 对端已删（本机拿着旧副本）→ 当场按墓碑处理；偶数 = 对端已恢复 → 去拉内容。 */
  private async absorb(peerFp: string, sid: string, res: unknown): Promise<void> {
    const theirs = parseWireLifecycle(fieldOf(res, 'lifecycle'));
    if (!theirs || compareLifecycle(theirs, this.chat.getLifecycle(sid)) <= 0) return;
    if (!isDeletedVersion(theirs.v)) { void this.pullFromPeer(peerFp, sid); return; }
    try {
      const r = await receiveRemotePayload(this.chat, this.lifecycleHost, sid, { messages: [], markers: [], lifecycle: theirs }, peerFp);
      this.afterReceive(peerFp, sid, r);
    } catch {
      // 落库失败：登记没动，下次对账对端还会再给
    }
  }

  /** 收到对端 sync.dirty notify → 拉取并合并（拨号方 pull 职责，决策 4）。 */
  private async pullFromPeer(peerFp: string, sid: string): Promise<void> {
    if (!this.outbound) return;
    // F11B：本机已删、对端是旧版——它手里只可能是旧副本，拉回来也只会被入口闸拒掉
    if (this.chat.isDeleted(sid) && !this.peerCap(peerFp)) return;
    try {
      const payload = await this.outbound.callRpc(peerFp, 'sync.pull', { sessionId: sid, afterTs: 0 });
      const result = await receiveRemotePayload(this.chat, this.lifecycleHost, sid, payload, peerFp);
      this.afterReceive(peerFp, sid, result);
      // F11A：拉完（不论有没有变化）排这个会话的附件作业——对端只是附件行变了的时候合并没有变化。
      // F11B：拿到的是墓碑、或内容被拒时不排
      if (result.tombstone === undefined && !result.rejected) this.attachments?.schedule(peerFp, sid);
    } catch {
      // 对端断线或超时 → OutboundClient 会自动重连，下次 sync.dirty 再触发 pull
    }
  }

  /** 收下一个载荷之后的广播与回推（拉取与 absorb 共用）。 */
  private afterReceive(peerFp: string, sid: string, r: SyncReceiveResult): void {
    // Task 1 门控：hasChange=false 不再 onDirty（防 ping-pong）。应用墓碑不算「同步了 N 条」
    if (r.hasChange && r.tombstone === undefined && !r.rejected) {
      // 小项 7e：拨号方路径广播 chat.event synced 供 renderer 消费
      this.rpc.broadcast('chat.event', { kind: 'synced', sessionId: sid, mergedCount: r.mergedCount, fromDevice: peerFp });
      // mergeRemoteSession 内部已调 onDirty → 触发拓扑分流（broadcast + push）
      // → 但对端回灌 id 全重合 → hasChange=false → 终止
    }
    // F11B：合并新建了会话行，或让保留副本重新可见——界面要重拉列表（恢复出来的会话才会出现）
    if (r.sessionCreated) this.rpc.broadcast('chat.sessions.changed', {});
    // 对方拿着本机已删会话的旧副本：把墓碑给它（暂停时不发；旧版对端在 pushToPeer 里跳过）
    if (r.rejected === 'tombstoned' && !this.paused) void this.pushToPeer(peerFp, sid);
  }

  /** 实装：挂 OutboundClient.onRemoteDirty + onOnline + 启动出站拨号（决策 8 装配）。 */
  start(): void {
    if (this.outbound) {
      this.outbound.onRemoteDirty = (peerFp, sid) => {
        // F11A：先让附件对这个对端这个会话的「已收敛」记号失效，再拉取（拉完会排附件作业）。
        // 只有这条路径调；重连对账里的拉取不调（那时 onPeerOnline 已经把记号清空了）
        this.attachments?.onRemoteDirty(peerFp, sid);
        void this.pullFromPeer(peerFp, sid);
      };
      // M3c 修复：重连双向对账挂钩 onOnline（补 Task 6 计划缺口）。
      //   onOnline 只在拨号方触发（OutboundClient.dial 成功 + sync.hello 互认通过），
      //   监听方不拨号无此回调。重连场景下持数据方可能是任意一侧——
      //   单向 pull 在「持数据方 = 拨号方」时失效（拨号方 pull 对端拿不到自己宕机期数据），
      //   故必须双向：push 本端全部 + pull 对端全部，hasChange 门控吸收冗余。
      //   首次配对连接亦触发全量对账（合理副作用：历史会话首连即同步）。
      this.outbound.onOnline = (peerFp) => {
        // F11A：新连接是新的连接周期，旧连接上的附件循环不得借它继续
        this.attachments?.onPeerOnline(peerFp);
        // Q12：每次上线都是一条新连接；还在走的那一轮据此知道自己该收手了
        this.onlineCount.set(peerFp, (this.onlineCount.get(peerFp) ?? 0) + 1);
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
   *   Q12 起两个方向都经 eachSession 限并发地走，本方法等它们走完才返回，
   *   所以 in-flight 标志现在一直持有到两个方向都走完。一轮只属于起它的那条连接：对端掉线或连接换过之后
   *   不再取新的会话，已经开始的会话结束后释放标志（通常立刻，因为在途的 RPC 随连接断开而失败；
   *   正等本机 run 停下的那一个要等它停稳）。
   *   F11B 起清单先取，并多两段墓碑差量：先收对端有而本端没有（或更旧）的墓碑，再推对端缺的墓碑（函数体里的 1、2、3）。
   *
   * 终止性论证（决策 4 ping-pong 门控延续）：
   *   - 两方向回灌均经 mergeRemoteSession，hasChange=false（id 全重合）→ 不 onDirty → 链终止
   *   - 冗余有界于一轮对账：本方法不在对账中触发递归 onOnline
   *   - in-flight 标志防连接抖动风暴：对账进行中重入不并行起第二轮。Q12 起改为记一笔、这一轮收手后补一轮
   *     （以前直接丢弃；现在标志持有得久，丢弃会让一次真实的重连得不到对账）。补的轮数不超过上线的次数
   *
   * dialNow 一过性说明（backlog 跟踪）：
   *   remote.pair.join 成功后调 dialNow 立即拨号（绕过主从裁决），属于一次性初连手段；
   *   进程重启后 start() 恢复主从裁决，dialNow 不再触发，行为已可接受。
   */
  private async reconcilePeer(peerFp: string): Promise<void> {
    if (!this.outbound) return;
    // 防抖：对账进行中不并行起第二轮，记一笔，由进行中的那一轮在收手时补
    if (this.reconciling.has(peerFp)) { this.reconcileAgain.add(peerFp); return; }
    this.reconciling.add(peerFp);
    const startedAt = this.onlineCount.get(peerFp);
    /** 这一轮还该不该往下走：没关停、起它的那条连接没被换掉、对端在线。 */
    const current = (): boolean => !this.stopped && this.onlineCount.get(peerFp) === startedAt && this.peerOnline(peerFp);
    try {
      // F11B：sync.list 提到最前——要先看对端的墓碑头清单，才知道哪些会话不该再推、哪些墓碑它还缺。
      // 对账是无状态的：不记「谁确认过哪条墓碑」，每次上线比头清单、只补差量；稳态下墓碑不产生额外 RPC。
      const cap = this.peerCap(peerFp);
      let list: unknown;
      let listed = true;
      try { list = await this.outbound.callRpc(peerFp, 'sync.list', {}); } catch { listed = false; }
      // 对端暂停中：它这一轮不交出墓碑，本端也不向它推墓碑
      const peerQuiet = fieldOf(list, 'lifecyclePaused') === true;
      const heads = new Map<string, { v: number; opId: string }>();
      const peerTombstones: WireLifecycleHead[] = [];
      const rawTombstones = fieldOf(list, 'tombstones');
      for (const raw of Array.isArray(rawTombstones) ? rawTombstones : []) {
        const id = fieldOf(raw, 'id');
        const head = parseLifecycleHead(raw);
        if (typeof id !== 'string' || id.length < 1 || id.length > 128 || !head || !isDeletedVersion(head.v)) continue;
        heads.set(id, head);
        peerTombstones.push({ id, ...head });
      }
      const peerSessions: string[] = [];
      const rawSessions = fieldOf(list, 'sessions');
      for (const raw of Array.isArray(rawSessions) ? rawSessions : []) {
        const id = fieldOf(raw, 'id');
        if (typeof id !== 'string') continue;
        peerSessions.push(id);
        heads.set(id, parseLifecycleHead(fieldOf(raw, 'lifecycle')) ?? { v: 0, opId: '' });
      }

      // 1. 先收对端的墓碑（串行：每条可能要等本机的 run 停下）。本端暂停、对端静默、对端是旧版时整段跳过。
      //    先收后推：否则本端会把对端已删的会话当成存活的整推一遍
      if (cap && !this.paused && !peerQuiet) {
        for (const h of peerTombstones) {
          if (!current()) return;
          if (compareLifecycle(h, this.chat.getLifecycle(h.id)) > 0) await this.pullFromPeer(peerFp, h.id);
        }
      }

      // 2. push 方向：本端全部会话推给对端——M6 R2 暂停时跳过（本端不发起同步），但保留 pull（决策点 2-7）
      if (!this.paused) {
        const mine = this.chat.listSyncedSessions().map(s => s.id);
        await this.eachSession(mine, current, sid => this.pushToPeer(peerFp, sid));
        // 对端缺的墓碑逐条补推。串行：首次配对时可能缺上千条，一次全发会在一条连接上同时挂上千个 10 秒超时的 RPC
        if (cap && listed && !peerQuiet) {
          for (const t of this.chat.listTombstoneHeads()) {
            if (!current()) return;
            if (compareLifecycle(t, heads.get(t.id)) <= 0) continue;
            if (!(await this.pushToPeer(peerFp, t.id))) break; // RPC 失败就停，剩下的下次对账再补
          }
        }
      }

      // 3. pull 方向：拉对端会话清单，逐个合并（不受暂停影响，对端数据照常收下）
      await this.eachSession(peerSessions, current, async id => {
        const local = this.chat.getLifecycle(id);
        // 本机已删、对方清单里的是旧副本：不拉（第 2 步已把墓碑给它；对方是旧版或有一方暂停时它留着自己的副本）
        if (local && isDeletedVersion(local.v) && compareLifecycle(local, heads.get(id)) > 0) return;
        await this.pullFromPeer(peerFp, id);
      });
    } catch {
      // 对端刚离线 → 静默放弃，等下次重连再对账
    } finally {
      this.reconciling.delete(peerFp);
      // 这一轮走着的时候对端又上线过：给那条新连接补一轮（清单重新取）
      if (this.reconcileAgain.delete(peerFp) && !this.stopped) void this.reconcilePeer(peerFp);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    this.pendingQueue.clear();
    this.pausedTombstones.clear();
    this.reconcileAgain.clear();
    // F11A：附件的停止经这里转发（同步、不抛）；关停序列里不另加句子
    this.attachments?.stop();
    this.outbound?.stop();
  }
}
