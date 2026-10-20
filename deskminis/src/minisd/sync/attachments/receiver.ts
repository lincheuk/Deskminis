/**
 * F11A 附件接收器：两种角色共用（本端作为拨号方主动取 'get'，作为监听方被推 'put'）。
 *
 * 未完成的字节只存在于 <数据根>/sync-incoming/<sha256>.<size>.part，附件桶里从不出现部分文件。
 * 一个内容键（sha256 + size）至多一张票：同一份内容同一时刻只有一条传输在写。
 * 写块是同步的「核对偏移 → 写 → 关」，中间不让出事件循环，所以同一连接上成串到达的块不会交叉；
 * 唯一的异步段是收满之后的提交（整文件校验 → 复制 → 再校验 → 不覆盖地发布），用 finishing 标志挡重入。
 * 提交全程包在 try / finally 里：不论从哪一步退出，票都被撤掉、本次建出来还没发布的 .stage 都被删掉。
 */
import { closeSync, lstatSync, mkdirSync, openSync, truncateSync, writeSync } from 'node:fs';
import { AttError, type AttErrorCode } from './wire';
import type { AttachmentLimits } from './limits';
import { removeFileQuiet, type AttachmentIo } from './io';
import type { AttachmentRow, AttachmentStore } from './store';

export type TransferRole = 'get' | 'put';

interface Ticket {
  owner: string;
  role: TransferRole;
  received: number;
  lastTouch: number;
  finishing: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface AttachmentReceiverDeps {
  now(): number;
  isPaired(fp: string): boolean;
  /** owner 在 role 这个方向上的连接还在不在（get：出站在线；put：入站在线）。 */
  peerOnline(owner: string, role: TransferRole): boolean;
  /** 提交前的最后一道闸：未关停、未暂停、owner 仍在配对表里。返回不让发布的原因，可以发布返回 undefined。 */
  publishBlock(owner: string): AttErrorCode | undefined;
  onChanged(sessionId: string): void;
}

/** 提交途中遇到这几个码就停在当前目标：保留暂存，恢复 / 重新配对后从收满的暂存直接续上。 */
const BLOCK_CODES: ReadonlySet<AttErrorCode> = new Set<AttErrorCode>(['ATT_PAUSED', 'ATT_STOPPING', 'ATT_CANCELLED']);

export class AttachmentReceiver {
  private tickets = new Map<string, Ticket>();
  private stopped = false;

  constructor(
    private readonly store: AttachmentStore,
    private readonly limits: AttachmentLimits,
    private readonly io: AttachmentIo,
    private readonly deps: AttachmentReceiverDeps,
  ) {}

  private key(sha256: string, size: number): string { return `${sha256}.${size}`; }

  private partLength(path: string): number | undefined {
    try { const st = lstatSync(path); return st.isFile() ? st.size : undefined; } catch { return undefined; }
  }

  private drop(key: string): void {
    const t = this.tickets.get(key);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    this.tickets.delete(key);
  }

  private notifyTargets(sha256: string, size: number): void {
    const seen = new Set<string>();
    for (const row of this.store.wantedTargets(sha256, size)) {
      if (seen.has(row.sessionId)) continue;
      seen.add(row.sessionId);
      try { this.deps.onChanged(row.sessionId); } catch { /* 通知失败不影响传输 */ }
    }
  }

  /** 票的空闲计时：只为界面服务。票变陈旧是纯时间事件，对端一去不回时没有这一下，状态会一直停在「传输中」。 */
  private armIdle(key: string, sha256: string, size: number, delay: number): void {
    const t = this.tickets.get(key);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      const cur = this.tickets.get(key);
      if (cur !== t) return;
      t.timer = undefined;
      const idle = this.deps.now() - t.lastTouch;
      if (idle < this.limits.recvIdleMs) { this.armIdle(key, sha256, size, this.limits.recvIdleMs - idle); return; }
      // 票本身留着，等别的传输按 begin 的接管条件接手
      this.notifyTargets(sha256, size);
    }, Math.max(1, delay));
    t.timer.unref?.();
  }

  /** 同步。拿到或接管这份内容的票，返回续传起点；拿不到抛 ATT_BUSY。 */
  begin(sha256: string, size: number, owner: string, role: TransferRole): { offset: number } {
    if (this.stopped) throw new AttError('ATT_STOPPING');
    const key = this.key(sha256, size);
    const t = this.tickets.get(key);
    if (t) {
      // 正在提交的票不能接管；它活不过那次提交（commit 的 finally）
      if (t.finishing) throw new AttError('ATT_BUSY');
      if (!(t.owner === owner && t.role === role)) {
        const stale = this.deps.now() - t.lastTouch >= this.limits.recvIdleMs
          || !this.deps.isPaired(t.owner) || !this.deps.peerOnline(t.owner, t.role);
        if (!stale) throw new AttError('ATT_BUSY');
      }
    }
    const part = this.store.partPath(sha256, size);
    const chunk = this.limits.chunkBytes;
    const len = this.partLength(part);
    let received = 0;
    if (len === undefined) received = 0;
    else if (len > size) { removeFileQuiet(part); received = 0; }
    else if (len === size) received = size;
    else {
      // 截到块界：半块是上一次中断在块中间留下的，不可信
      received = len - (len % chunk);
      if (received !== len) {
        try { truncateSync(part, received); } catch { removeFileQuiet(part); received = 0; }
      }
    }
    this.drop(key);
    this.tickets.set(key, { owner, role, received, lastTouch: this.deps.now(), finishing: false });
    this.armIdle(key, sha256, size, this.limits.recvIdleMs);
    return { offset: received };
  }

  /** 写一块。收满后在同一次调用里完成校验与发布。 */
  async write(sha256: string, size: number, offset: number, bytes: Uint8Array, owner: string, role: TransferRole): Promise<{ offset: number; done: boolean }> {
    if (this.stopped) throw new AttError('ATT_STOPPING');
    const key = this.key(sha256, size);
    const t = this.tickets.get(key);
    if (!t || t.owner !== owner || t.role !== role || t.finishing) throw new AttError('ATT_NO_TRANSFER');
    const chunk = this.limits.chunkBytes;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % chunk !== 0) throw new AttError('ATT_BAD_CHUNK');
    // 重复块：不写盘
    if (offset + bytes.length <= t.received) return { offset: t.received, done: false };
    if (offset !== t.received) throw new AttError('ATT_OFFSET', `expected=${t.received}`);
    // 每块恰为 min(块长, 剩余)：任何一次写入都不可能越过声明长度
    if (bytes.length !== Math.min(chunk, size - offset)) throw new AttError('ATT_BAD_CHUNK');
    const part = this.store.partPath(sha256, size);
    // 复查磁盘：暂存文件被别的东西动过（长度对不上）就整份作废，从头来
    if ((this.partLength(part) ?? 0) !== t.received) {
      removeFileQuiet(part);
      this.drop(key);
      throw new AttError('ATT_OFFSET', 'expected=0');
    }
    let fd: number | undefined;
    try {
      // 每块开关一次，不留长期句柄
      mkdirSync(this.store.incomingDir(), { recursive: true });
      fd = openSync(part, t.received === 0 ? 'w' : 'r+');
      let done = 0;
      while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done, t.received + done);
      closeSync(fd);
      fd = undefined;
    } catch {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关闭 */ } }
      removeFileQuiet(part);
      this.drop(key);
      // 磁盘写满之类：不自动重试，避免每轮触发都撞一次
      this.store.failContent(sha256, size, 'io_error');
      throw new AttError('ATT_IO');
    }
    t.received += bytes.length;
    t.lastTouch = this.deps.now();
    this.notifyTargets(sha256, size);
    if (t.received < size) return { offset: t.received, done: false };
    await this.commit(key, t, sha256, size);
    return { offset: size, done: true };
  }

  /** begin 返回的 offset 已等于 size 时调：直接走校验与发布。 */
  async finish(sha256: string, size: number, owner: string, role: TransferRole): Promise<void> {
    if (this.stopped) throw new AttError('ATT_STOPPING');
    const key = this.key(sha256, size);
    const t = this.tickets.get(key);
    if (!t || t.owner !== owner || t.role !== role || t.finishing || t.received !== size) throw new AttError('ATT_NO_TRANSFER');
    await this.commit(key, t, sha256, size);
  }

  /** 提交：整文件校验 → 逐个目标复制、再校验、不覆盖地发布。 */
  private async commit(key: string, t: Ticket, sha256: string, size: number): Promise<void> {
    t.finishing = true;
    const part = this.store.partPath(sha256, size);
    let stage: string | undefined;
    try {
      const v = await this.io.verify(part, sha256, size);
      if (!v) {
        removeFileQuiet(part);
        this.store.noteIntegrityFailure(sha256, size);
        throw new AttError('ATT_HASH');
      }
      // 已关停、已暂停、已取消配对：不发布，暂存保留
      const blocked = this.deps.publishBlock(t.owner);
      if (blocked) throw new AttError(blocked);
      const targets = this.store.wantedTargets(sha256, size);
      if (targets.length === 0) {
        // 期间被用户取消，或引用没了
        removeFileQuiet(part);
        throw new AttError('ATT_CANCELLED');
      }
      const published: AttachmentRow[] = [];
      for (const row of targets) {
        try {
          stage = this.store.stagePath(sha256);
          await this.io.copy(part, stage);
          const s = await this.io.verify(stage, sha256, size);
          if (!s) throw new Error('复制后的校验不通过');
          // 每个目标发布前再查一次：前面的复制与校验有 await
          const again = this.deps.publishBlock(t.owner);
          if (again) throw new AttError(again);
          // 这一个目标此刻还要不要：复制与校验期间用户可能取消了它，它所在的会话也可能被删了（引用随之没了）
          const cur = this.store.wantedRow(row.sessionId, row.name, sha256, size);
          if (!cur) {
            removeFileQuiet(stage); stage = undefined;
            continue;
          }
          const r = await this.store.publishVerified(cur, s);
          stage = undefined;
          if (r !== 'conflict') published.push(cur);
        } catch (e) {
          if (stage) { removeFileQuiet(stage); stage = undefined; }
          if (e instanceof AttError && BLOCK_CODES.has(e.code)) throw e;
          // 这一个目标失败不影响其余目标
          this.store.fail(row.sessionId, row.name, 'io_error');
        }
      }
      if (published.length === 0) {
        // 一个目标都没发布成：撞名的行自己已记 name_conflict，其余记了 io_error；暂存留着，重试时不用重传
        if (this.store.wantedTargets(sha256, size).length === 0 && !targets.some(r => this.store.get(r.sessionId, r.name)?.failCode === 'io_error')) {
          removeFileQuiet(part);
          throw new AttError('ATT_CANCELLED');
        }
        throw new AttError('ATT_IO');
      }
      removeFileQuiet(part);
      for (const row of published) {
        this.store.noteReceived(row, t.owner);
        try { this.deps.onChanged(row.sessionId); } catch { /* 通知失败不影响结果 */ }
      }
    } catch (e) {
      if (e instanceof AttError) throw e;
      // 未预期的异常（库不可用、文件操作出错）：暂存保留，对外只给码
      throw new AttError('ATT_IO');
    } finally {
      if (stage) removeFileQuiet(stage);
      if (this.tickets.get(key) === t) this.drop(key);
    }
  }

  /** 只撤 (owner, role) 相符的票。票属于别的传输、或票正在提交时什么都不做（不删别人正在写的暂存）。 */
  release(sha256: string, size: number, owner: string, role: TransferRole, opts: { deletePart: boolean }): void {
    const key = this.key(sha256, size);
    const t = this.tickets.get(key);
    if (t) {
      if (t.owner !== owner || t.role !== role || t.finishing) return;
      this.drop(key);
    }
    if (opts.deletePart) removeFileQuiet(this.store.partPath(sha256, size));
  }

  progress(sha256: string, size: number): { received: number; owner: string; role: TransferRole; lastTouch: number } | undefined {
    const t = this.tickets.get(this.key(sha256, size));
    return t ? { received: t.received, owner: t.owner, role: t.role, lastTouch: t.lastTouch } : undefined;
  }

  /** 这份内容已没有要取的行时，撤票并删暂存；还有要取的行（别的会话引用同一份内容）时不动；票正在提交时不动。 */
  dropIfUnwanted(sha256: string, size: number): void {
    const key = this.key(sha256, size);
    const t = this.tickets.get(key);
    if (t?.finishing) return;
    if (this.store.wantedTargets(sha256, size).length > 0) return;
    this.drop(key);
    removeFileQuiet(this.store.partPath(sha256, size));
  }

  /** 本端暂停时调：撤掉全部不在提交中的票，保留暂存（恢复后 begin 从暂存长度续传）。正在提交的票由提交的 finally 撤。 */
  releaseAll(): void {
    for (const [key, t] of [...this.tickets]) if (!t.finishing) this.drop(key);
  }

  /** 撤掉全部票，保留暂存；此后 begin / write / finish 一律抛 ATT_STOPPING。 */
  stop(): void {
    this.stopped = true;
    for (const key of [...this.tickets.keys()]) this.drop(key);
  }
}
