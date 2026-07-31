import type { ChatStore } from '../store/chat-store';
import type { RpcServer } from '../rpc/server';

export interface SyncCoordinatorOpts {
  debounceMs?: number;
}

/**
 * 同步协调器（服务端被动，评审命门 4 收敛）。
 *
 * A. 事件驱动：chat.onDirty → 入 pendingQueue → 去抖 N ms → rpc.broadcast('sync.dirty', { sessionId, cursor })
 *    远端 GUI / CLI 收到 sync.dirty 后作为 RPC 客户端调本端 sync.pull（M3a 已建好 PASETO 长连）
 * B. 手动：CLI sync-cli.mjs（local token 连本端调 sync.* RPC）
 *
 * 本协调器不主动连对端（那是 M3c relay 的事）——「对端在线」由「对端 GUI 长连本端」体现，本端只广播。
 * start() 为空实现：评审命门 4 移除 5s 心跳，保留方法签名供 M3c relay 扩展，避免装配处条件判断。
 */
export class SyncCoordinator {
  private pendingQueue = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  private stopped = false;

  constructor(
    private chat: ChatStore,
    private rpc: RpcServer,
    opts: SyncCoordinatorOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 200;
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

  async flush(): Promise<void> {
    const sids = Array.from(this.pendingQueue);
    this.pendingQueue.clear();
    for (const sid of sids) {
      const cursor = this.chat.getSessionCursor(sid);
      this.rpc.broadcast('sync.dirty', { sessionId: sid, cursor });
    }
  }

  start(): void { /* 评审命门 4：心跳移除，空实现——留 M3c relay 实装 */ }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    this.pendingQueue.clear();
  }
}
