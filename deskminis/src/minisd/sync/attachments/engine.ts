/**
 * F11A 附件同步引擎：调度、作业、对端处理器的方法体、状态模型。
 *
 * 一对设备里只有持有出站连接的一端（D，拨号方）能发 RPC；被连入的一端（L，监听方）只应答和发通知。
 * 所以全部传输由 D 发起：一次 sync.att.manifest 往返同时得到「对方有什么」（D 用 get 取）与「对方要什么」（D 用 put 送）。
 * L 有需求时（用户重试、本机文件丢了）发既有的 sync.dirty 通知，D 收到后在同一条连接上重发清单。
 *
 * 字节只走现有加密通道上的 JSON-RPC：处理器要求连接是加密通道上的 remote 连接、对端在 sync.hello 里声明了 attachments。
 * 没有别的通路，对端不支持就是不可用，不降级。
 *
 * 暂停（附件收发全停）、取消配对、关停：每块之前、应答回来之后写盘之前、提交发布之前各复查一次。
 * 收敛记号（settled）只是省掉重复的清单往返，不是正确性的前提：凡是拿不准的情形一律不记。
 */
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { MinisPaths } from '../../paths';
import type { RpcConnection } from '../../rpc/server';
import { SYNC_CAP, peerHasCap, type SyncPeerInfo } from '../wire';
import {
  SESSION_ID_RE, localAttachmentName, localAttachmentNameOf, validateAttachmentName,
  type AttachmentReadResult, type AttachmentReason, type AttachmentRetryResult, type AttachmentState,
  type AttachmentStatusResult, type AttachmentView,
} from '../../../shared/attachments';
import {
  AttError, attErrorCodeOf, attOffsetExpected, parseGetRequest, parseGetResponse, parseManifestRequest,
  parseManifestResponse, parsePutRequest, parsePutResponse, toWire,
  type AttErrorCode, type AttGetResponse, type AttManifestResponse, type AttPutResponse, type WireAttachment,
} from './wire';
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from './limits';
import { createAttachmentIo, type AttachmentIo } from './io';
import { AttachmentStore, type AttachmentRow, type RefInfo } from './store';
import { AttachmentReceiver } from './receiver';

/** 交给 SyncCoordinator 的端口（结构类型，coordinator 只 import type）。方法永不抛。 */
export interface AttachmentSyncPort {
  markDirty(sessionId: string): void;
  onPeerOnline(peerFp: string): void;
  /** 本端拨出的对端发来了 sync.dirty：让这个对端这个会话的「已收敛」记号失效。协调器在拉取之前调。 */
  onRemoteDirty(peerFp: string, sessionId: string): void;
  schedule(peerFp: string, sessionId: string): void;
  setPaused(paused: boolean): void;
  stop(): void;
}

export interface AttachmentSyncDeps {
  db: Database.Database;
  root: string;
  paths: Pick<MinisPaths, 'sessionBucket'>;
  isPaired(fp: string): boolean;
  pairedPeers(): string[];
  sessionExists(sessionId: string): boolean;
  sessionCursor(sessionId: string): unknown;
  /** 懒取值：OutboundClient 在端口持久化之后才实例化。引擎只用这四个方法。 */
  outbound(): {
    isOnline(fp: string): boolean;
    dialedPeers(): string[];
    peerInfo(fp: string): SyncPeerInfo | undefined;
    callRpc(fp: string, method: string, params: unknown): Promise<unknown>;
  } | undefined;
  isInboundOnline(fp: string): boolean;
  broadcast(method: string, params: unknown): void;
  audit?(event: string, payload: Record<string, unknown>, sessionId?: string): void;
  /** 以下只给测试；index.ts 不传。 */
  limits?: Partial<AttachmentLimits>;
  io?: Partial<AttachmentIo>;
  now?: () => number;
}

/** 每个本端拨出的对端一份。 */
interface PeerState {
  /** 每次上线加一：旧连接上的循环在下一步退出，不会借新连接继续。 */
  epoch: number;
  pending: Set<string>;
  looping: boolean;
  /** 这个会话在这个对端上已收敛时的 stamp。 */
  settled: Map<string, string>;
  /** 这个会话在这个对端上被催过几次：作业期间被催过就不记收敛。 */
  gen: Map<string, number>;
  /** 当前连接周期里与它交换过清单的会话 → 发那份清单时本机的引用集（快照，见 OnlineContext.exchangedSince）。 */
  exchanged: Map<string, ReadonlyMap<string, RefInfo>>;
  /** 对端说过 ATT_PAUSED。 */
  paused: boolean;
  /** 对端声明了能力却不受理（未知方法 / ATT_CAP_REQUIRED / ATT_CHANNEL_REQUIRED）：本周期内不再对它发。 */
  refused: boolean;
  indexRetries: Map<string, number>;
}

/** 这几种拒绝是对端那边之后会变的状态（用户重试、另一条传输结束、消息到达）：记成已收敛的话清单就再也发不出去。 */
const UNSETTLED_REJECTS = new Set(['held', 'failed', 'busy', 'not_referenced', 'session_unknown']);
const CHANGED_THROTTLE_MS = 250;
const INDEX_RETRY_MAX = 5;

const holderKey = (name: string, sha256: string): string => `${name.toLowerCase()}:${sha256}`;

/** 状态模型用的在线概况：已配对设备里谁在线（出站 ∪ 入站）、谁声明了能力、是否都暂停了、是否都交换过这个会话。 */
interface OnlineContext {
  online: number;
  supporting: string[];
  allPaused: boolean;
  /** 在线且支持的设备在当前连接周期里都与本端交换过这个会话的清单。 */
  allExchanged: boolean;
  /** 同上，并且每台设备的那次交换都发生在这个名字（小写）被本机消息引用之后。
   *  没有行的引用只有这样才能说「在线的设备上没有」：新消息刚带来的引用还没被问过，是等待，不是没有。 */
  exchangedSince(nameKey: string): boolean;
  /** 在线且支持的设备里有没有谁在最近一次清单里列着这一条。 */
  holds(key: string): boolean;
}

export class AttachmentEngine {
  readonly store: AttachmentStore;
  readonly receiver: AttachmentReceiver;
  readonly limits: AttachmentLimits;
  private readonly io: AttachmentIo;
  private readonly now: () => number;
  private stopped = false;
  private paused = false;
  private peers = new Map<string, PeerState>();
  /** 来源表：对端在最近一次清单交换里声明自己有的条目（整体替换）。只给状态显示用。out：本端拨出；in：对端拨入。 */
  private holdersOut = new Map<string, Map<string, Set<string>>>();
  private holdersIn = new Map<string, Map<string, Set<string>>>();
  /** 入站对端的声明与本连接周期里交换过的会话（sync.hello 时重置）。exchanged 的值是受理那份清单时本机的引用集（快照）。 */
  private inbound = new Map<string, { peer: SyncPeerInfo; exchanged: Map<string, ReadonlyMap<string, RefInfo>> }>();
  private notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private notifiedAt = new Map<string, number>();
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private active = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: AttachmentSyncDeps) {
    this.limits = { ...DEFAULT_ATTACHMENT_LIMITS, ...deps.limits };
    this.io = { ...createAttachmentIo(), ...deps.io };
    this.now = deps.now ?? Date.now;
    this.store = new AttachmentStore(deps.db, deps.root, deps.paths, this.limits, this.io, this.now, {
      onChanged: sid => this.changed(sid),
      // 放到微任务里：存储层正在自己的同步段里，催促会重入登记
      onLocalMissing: sid => { queueMicrotask(() => { this.kick(sid); }); },
      sessionExists: sid => deps.sessionExists(sid),
      publishBlock: fp => this.publishBlock(fp),
      audit: deps.audit,
    });
    this.receiver = new AttachmentReceiver(this.store, this.limits, this.io, {
      now: this.now,
      isPaired: fp => this.isPairedQuiet(fp),
      peerOnline: (owner, role) => {
        try { return role === 'get' ? deps.outbound()?.isOnline(owner) === true : deps.isInboundOnline(owner); } catch { return false; }
      },
      publishBlock: fp => this.publishBlock(fp),
      onChanged: sid => this.changed(sid),
    });
  }

  // ---- 共用的闸 ----

  private isPairedQuiet(fp: string): boolean {
    try { return this.deps.isPaired(fp); } catch { return false; }
  }

  /** 提交前的最后一道闸：未关停、未暂停、owner 仍在配对表里。 */
  publishBlock(owner: string): AttErrorCode | undefined {
    if (this.stopped) return 'ATT_STOPPING';
    if (this.paused) return 'ATT_PAUSED';
    if (!this.isPairedQuiet(owner)) return 'ATT_CANCELLED';
    return undefined;
  }

  get isPaused(): boolean { return this.paused; }

  // ---- 通知 ----

  /** 广播 attachments.changed：每会话最多 250 毫秒一次；静了一阵之后的第一次变化立即发，其余合并到尾沿。只带会话 id。 */
  private changed(sessionId: string): void {
    if (this.stopped || this.notifyTimers.has(sessionId)) return;
    const since = this.now() - (this.notifiedAt.get(sessionId) ?? 0);
    const send = (): void => {
      this.notifyTimers.delete(sessionId);
      if (this.stopped) return;
      this.notifiedAt.set(sessionId, this.now());
      try { this.deps.broadcast('attachments.changed', { sessionId }); } catch { /* 广播失败不影响同步 */ }
    };
    if (since >= CHANGED_THROTTLE_MS) { send(); return; }
    const timer = setTimeout(send, CHANGED_THROTTLE_MS - since);
    timer.unref?.();
    this.notifyTimers.set(sessionId, timer);
  }

  // ---- 拨号方 D：调度 ----

  private peer(fp: string): PeerState {
    let st = this.peers.get(fp);
    if (!st) {
      st = { epoch: 0, pending: new Set(), looping: false, settled: new Map(), gen: new Map(), exchanged: new Map(), paused: false, refused: false, indexRetries: new Map() };
      this.peers.set(fp, st);
    }
    return st;
  }

  private bump(st: PeerState, sessionId: string): void {
    st.gen.set(sessionId, (st.gen.get(sessionId) ?? 0) + 1);
    st.settled.delete(sessionId);
  }

  markDirty(sessionId: string): void {
    try {
      this.store.markDirty(sessionId);
      for (const st of this.peers.values()) this.bump(st, sessionId);
    } catch { /* 端口方法永不抛 */ }
  }

  onPeerOnline(peerFp: string): void {
    const st = this.peer(peerFp);
    st.epoch += 1;
    st.settled.clear(); st.gen.clear(); st.exchanged.clear(); st.indexRetries.clear();
    st.paused = false; st.refused = false;
    this.holdersOut.delete(peerFp);
  }

  onRemoteDirty(peerFp: string, sessionId: string): void {
    // 对端这个会话有变化：可能只是它的附件行变了（它那边点了重试、它的本机文件丢了），本端没有任何痕迹。
    // 不在这里让跳过判断失效，随后那次 schedule 就会被吞掉，只能等下一次重拨。
    this.bump(this.peer(peerFp), sessionId);
  }

  schedule(peerFp: string, sessionId: string): void {
    if (this.stopped || this.paused) return;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return;
    const st = this.peer(peerFp);
    st.pending.add(sessionId);
    if (!st.looping) void this.runLoop(peerFp, st);
  }

  /** 同一对端同一时刻只有一个作业，一个作业里的文件逐个传；不同对端的循环互不等待。 */
  private async runLoop(fp: string, st: PeerState): Promise<void> {
    st.looping = true;
    this.active++;
    try {
      while (!this.stopped && !this.paused && st.pending.size > 0) {
        const sid = st.pending.values().next().value as string;
        st.pending.delete(sid);
        // 任何未预期的异常只结束当前作业，循环继续
        try { await this.job(fp, st, st.epoch, sid); } catch { /* 见上 */ }
      }
      if (this.stopped || this.paused) st.pending.clear();
    } finally {
      st.looping = false;
      this.leave();
    }
  }

  private leave(): void {
    this.active--;
    this.checkIdle();
  }

  private checkIdle(): void {
    if (this.active > 0 || this.retryTimers.size > 0) return;
    const run = this.idleWaiters; this.idleWaiters = [];
    for (const w of run) w();
  }

  /** 没有在跑的循环、处理器与待重排的计时时 resolve（只给测试）。 */
  idle(): Promise<void> {
    if (this.active === 0 && this.retryTimers.size === 0) return Promise.resolve();
    return new Promise<void>(resolve => { this.idleWaiters.push(resolve); });
  }

  private live(fp: string, st: PeerState, epoch: number): boolean {
    if (this.stopped || this.paused || st.epoch !== epoch || !this.isPairedQuiet(fp)) return false;
    try { return this.deps.outbound()?.isOnline(fp) === true; } catch { return false; }
  }

  /** 每个 sync.att.* 调用由引擎自己计时。计时先到按超时处理；底层那次调用之后回来的结果被丢弃。 */
  private call(fp: string, method: string, params: unknown): Promise<unknown> {
    const out = this.deps.outbound();
    if (!out) return Promise.reject(new Error('出站客户端还没就绪'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), this.limits.chunkTimeoutMs);
      timer.unref?.();
      out.callRpc(fp, method, params).then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
      );
    });
  }

  private setHolders(table: Map<string, Map<string, Set<string>>>, fp: string, sessionId: string, entries: Array<{ name: string; sha256: string }>): void {
    let per = table.get(fp);
    if (!per) { per = new Map(); table.set(fp, per); }
    per.set(sessionId, new Set(entries.map(e => holderKey(e.name, e.sha256))));
  }

  private notePeerPaused(st: PeerState, epoch: number, sessionId: string): void {
    if (st.epoch !== epoch || st.paused) return;
    st.paused = true;
    this.changed(sessionId);
  }

  private async job(fp: string, st: PeerState, epoch: number, sid: string): Promise<void> {
    // 不在线、对端没声明能力：一个 sync.att.* 都不发
    if (!this.live(fp, st, epoch) || st.refused) return;
    if (!peerHasCap(this.deps.outbound()?.peerInfo(fp), SYNC_CAP.ATTACHMENTS)) return;
    await this.store.ensureIndexed(sid);
    if (!this.live(fp, st, epoch)) return;
    if (this.store.referenced(sid).size === 0) return;
    const g0 = st.gen.get(sid) ?? 0;
    if (st.settled.get(sid) === this.store.stamp(sid)) return;
    // 两句在同一个同步段里，对应同一份库状态
    const mine = this.store.listPresent(sid);
    const stamp0 = this.store.stamp(sid);
    // 发清单这一刻本机的引用集：应答回来时可能已经来了新消息，对端这次的应答并没有被问到那些新引用
    const refs0 = this.store.referenced(sid);
    let raw: unknown;
    try {
      raw = await this.call(fp, 'sync.att.manifest', { v: 1, sessionId: sid, entries: mine.map(toWire) });
    } catch (e) {
      const code = attErrorCodeOf(e);
      if (code === 'ATT_PAUSED') this.notePeerPaused(st, epoch, sid);
      else if (code === 'ATT_CAP_REQUIRED' || code === 'ATT_CHANNEL_REQUIRED' || /未知方法/.test(String((e as Error)?.message))) {
        if (st.epoch === epoch) st.refused = true;
      }
      return;
    }
    if (!this.live(fp, st, epoch)) return;
    let resp: AttManifestResponse;
    try { resp = parseManifestResponse(raw, this.limits.chunkBytes); } catch { return; }
    if (st.paused) { st.paused = false; this.changed(sid); }

    let transferred = false;
    let needIndex = false;
    const fetch: AttachmentRow[] = [];
    const emptyIndexing = resp.indexing && resp.entries.length === 0 && resp.want.length === 0 && resp.rejected.length === 0;
    if (!emptyIndexing) {
      st.exchanged.set(sid, refs0);
      this.setHolders(this.holdersOut, fp, sid, resp.entries);
      // 来源表变了，还没到的附件的状态可能跟着变
      if (this.store.hasWanted(sid)) this.changed(sid);
      for (const entry of resp.entries) {
        const r = await this.store.acceptRemote(sid, entry, fp);
        if (!this.live(fp, st, epoch)) return;
        if (r.action === 'want') fetch.push(r.row);
        else if (r.action === 'reject' && r.code === 'busy') needIndex = true;
      }
      for (const row of fetch) {
        transferred = true;
        await this.fetchOne(fp, st, epoch, row);
      }
      for (const item of resp.want) {
        const row = mine.find(m => m.name.toLowerCase() === item.name.toLowerCase() && m.sha256 === item.sha256);
        if (!row) continue;
        transferred = true;
        await this.sendOne(fp, st, epoch, row, item.offset);
      }
    }
    if (resp.indexing || needIndex) this.retryLater(fp, st, epoch, sid);

    // 收尾：下面几条全部成立才记收敛（本轮发起过任何 get / put 都不记：它们的成败由下一轮清单确认）。
    // 记的是发清单之前取的 stamp0——作业期间本机行有任何变化，当前 stamp 就与 stamp0 不等，
    // 下一次 schedule 不会被跳过，最多多发一轮清单后收敛。
    const settled = this.live(fp, st, epoch) && !transferred
      && resp.want.length === 0 && fetch.length === 0 && !resp.indexing && !needIndex
      && !resp.rejected.some(r => UNSETTLED_REJECTS.has(r.code))
      && (st.gen.get(sid) ?? 0) === g0;
    if (settled) st.settled.set(sid, stamp0);
    else st.settled.delete(sid);

    // 本轮有文件到了：给本端拨出的其它对端各排一次作业（第三台设备不用等下一次重连）
    if (fetch.some(row => this.store.get(row.sessionId, row.name)?.state === 'present')) {
      let others: string[] = [];
      try { others = this.deps.outbound()?.dialedPeers() ?? []; } catch { others = []; }
      for (const other of others) if (other !== fp) this.schedule(other, sid);
    }
  }

  private retryLater(fp: string, st: PeerState, epoch: number, sid: string): void {
    const n = st.indexRetries.get(sid) ?? 0;
    if (n >= INDEX_RETRY_MAX || this.stopped) return;
    st.indexRetries.set(sid, n + 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (st.epoch === epoch) this.schedule(fp, sid);
      this.checkIdle();
    }, this.limits.indexRetryMs);
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  /** 行还要取：重新取到的行是 missing、want=1，且内容键仍是开始时那一份（用户取消会改 want，取消后重试可能换绑），
   *  并且名字仍被这个会话的消息引用。
   *  F11B：最后一条是为保留副本加的——会话在别的设备上被删、本机留着内容时，行还在（冻结），但这个会话已不参与同步；
   *  只看行的话会把整个文件取完，到提交时才被丢弃。已清除的会话行已随会话一起删掉，本来就过不了前面几条。 */
  private stillWanted(row: AttachmentRow): boolean {
    return this.store.wantedRow(row.sessionId, row.name, row.sha256, row.size) !== undefined;
  }

  private async fetchOne(fp: string, st: PeerState, epoch: number, row: AttachmentRow): Promise<void> {
    if (!this.live(fp, st, epoch)) return;
    const { sessionId: sid, name, sha256, size } = row;
    let offset: number;
    // ATT_BUSY：别的传输正在带它回来，完成后行自然变成 present
    try { offset = this.receiver.begin(sha256, size, fp, 'get').offset; } catch { return; }
    const release = (deletePart: boolean): void => this.receiver.release(sha256, size, fp, 'get', { deletePart });
    // 删不删暂存由「这份内容还有没有要取的行」决定，不由「这一行是不是被取消了」决定
    const abandon = (): void => { release(false); this.receiver.dropIfUnwanted(sha256, size); };
    const onWriteError = (e: unknown): void => {
      const code = attErrorCodeOf(e);
      if (code === 'ATT_OFFSET' || code === 'ATT_BAD_CHUNK') { release(true); this.store.fail(sid, name, 'bad_chunk'); return; }
      // 取回方向上 ATT_NO_TRANSFER 只可能来自本机状态的变化（票在等应答期间被撤了或换了主），不是对端的错：
      // 不记失败；暂存此刻可能正由新票主在写，不能删
      if (code === 'ATT_NO_TRANSFER' && this.stillWanted(row)) this.store.noteInterrupted(sid, name);
      // 其余（ATT_HASH / ATT_IO / ATT_CANCELLED / ATT_PAUSED / ATT_STOPPING）：行的状态接收器已写好，票由提交的 finally 撤掉
    };
    if (offset === size) {
      try { await this.receiver.finish(sha256, size, fp, 'get'); } catch (e) { onWriteError(e); }
      return;
    }
    for (;;) {
      if (!this.live(fp, st, epoch)) { release(false); return; }
      if (!this.stillWanted(row)) { abandon(); return; }
      let raw: unknown;
      try {
        raw = await this.call(fp, 'sync.att.get', { v: 1, sessionId: sid, name, sha256, offset });
      } catch (e) {
        const code = attErrorCodeOf(e);
        if (code === 'ATT_PAUSED') this.notePeerPaused(st, epoch, sid);
        // 对端明说它没有：从来源表里去掉这一条
        if (code === 'ATT_NOT_FOUND') this.holdersOut.get(fp)?.get(sid)?.delete(holderKey(name, sha256));
        // 瞬时：不计失败次数，暂存保留
        release(false);
        if (this.stillWanted(row)) this.store.noteInterrupted(sid, name);
        this.changed(sid);
        return;
      }
      // 应答回来之后、写盘之前复查两样（等应答期间什么都可能发生）
      if (!this.live(fp, st, epoch)) { release(false); return; }
      if (!this.stillWanted(row)) { abandon(); return; }
      let bytes: Buffer;
      try { bytes = parseGetResponse(raw, { offset, size }, this.limits.chunkBytes); }
      catch { release(true); this.store.fail(sid, name, 'bad_chunk'); return; }
      let r: { offset: number; done: boolean };
      try { r = await this.receiver.write(sha256, size, offset, bytes, fp, 'get'); }
      catch (e) { onWriteError(e); return; }
      if (r.done) return;
      offset = r.offset;
    }
  }

  /** 送的一方不改自己的任何状态。 */
  private async sendOne(fp: string, st: PeerState, epoch: number, row: AttachmentRow, startOffset: number): Promise<void> {
    const chunk = this.limits.chunkBytes;
    const { size } = row;
    const isBoundary = (n: number): boolean => Number.isSafeInteger(n) && n >= 0 && n < size && n % chunk === 0;
    if (!isBoundary(startOffset)) return;
    let offset = startOffset;
    let adjusted = false;
    const maxRounds = Math.ceil(size / chunk) + 2;
    for (let i = 0; i < maxRounds; i++) {
      if (!this.live(fp, st, epoch)) return;
      let piece: { bytes: Buffer; size: number };
      // 本机文件变了或没了
      try { piece = await this.store.readChunk(row.sessionId, row.name, row.sha256, offset); } catch { return; }
      if (!this.live(fp, st, epoch)) return;
      let raw: unknown;
      try {
        raw = await this.call(fp, 'sync.att.put', { v: 1, sessionId: row.sessionId, name: row.name, sha256: row.sha256, offset, data: piece.bytes.toString('base64') });
      } catch (e) {
        const expected = attOffsetExpected(e);
        if (!adjusted && expected !== undefined && isBoundary(expected)) { adjusted = true; offset = expected; continue; }
        if (attErrorCodeOf(e) === 'ATT_PAUSED') this.notePeerPaused(st, epoch, row.sessionId);
        // 其余：对端那一行的去向由对端自己记，下一次清单它会回 want 或 rejected，不在这里循环重传
        return;
      }
      let r: AttPutResponse;
      try { r = parsePutResponse(raw, size, chunk); } catch { return; }
      if (r.done) return;
      if (!(r.offset > offset && isBoundary(r.offset))) return;
      offset = r.offset;
    }
  }

  // ---- 催促 ----

  /** 让对端在同一条连接上重发清单：本端是 D 时直接排作业；本端是 L 时发 sync.dirty，对方 D 收到后重新来一轮。 */
  kick(sessionId: string): void {
    if (this.stopped) return;
    try {
      for (const st of this.peers.values()) this.bump(st, sessionId);
      const out = this.deps.outbound();
      for (const fp of out?.dialedPeers() ?? []) {
        if (peerHasCap(out?.peerInfo(fp), SYNC_CAP.ATTACHMENTS)) this.schedule(fp, sessionId);
      }
      if (!this.paused && this.deps.pairedPeers().some(fp => this.deps.isInboundOnline(fp))) {
        this.deps.broadcast('sync.dirty', { sessionId, cursor: this.deps.sessionCursor(sessionId) });
      }
    } catch { /* 催促失败不影响别的 */ }
  }

  setPaused(paused: boolean): void {
    try {
      if (this.paused === paused) return;
      this.paused = paused;
      if (paused) {
        for (const st of this.peers.values()) st.pending.clear();
        // 在途的票当场撤掉（正在提交的由提交自己的 publishBlock 挡住）；暂存保留，恢复后从它的长度续传
        this.receiver.releaseAll();
      } else {
        // 恢复：既有的 resumeSync() 会把全部会话重新推一遍并广播 sync.dirty，两种角色都由此重新进入作业
        for (const st of this.peers.values()) { st.settled.clear(); st.paused = false; }
      }
      for (const sid of this.store.sessionsWithUnfinished()) this.changed(sid);
    } catch { /* 端口方法永不抛 */ }
  }

  /** 同步、不抛。此后不再碰库、不再发布：在途的 await 回来后先查已停。 */
  stop(): void {
    this.stopped = true;
    for (const st of this.peers.values()) st.pending.clear();
    for (const t of this.notifyTimers.values()) clearTimeout(t);
    this.notifyTimers.clear();
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    try { this.receiver.stop(); } catch { /* 不抛 */ }
    this.checkIdle();
  }

  // ---- 监听方 L：处理器 ----

  /** 每个 sync.att.* 处理器的开头，顺序固定。返回对端指纹。 */
  private enter(conn: RpcConnection): string {
    const fp = conn.peerFingerprint;
    // 只认加密通道上的 remote 连接：回环上的明文 ?paseto= 连接、本机 token 连接都不行
    if (conn.authMode !== 'remote' || conn.encrypted !== true || typeof fp !== 'string' || fp === '') {
      throw new AttError('ATT_CHANNEL_REQUIRED');
    }
    if (!peerHasCap(conn.syncPeer, SYNC_CAP.ATTACHMENTS)) throw new AttError('ATT_CAP_REQUIRED');
    if (this.stopped) throw new AttError('ATT_STOPPING');
    if (this.paused) throw new AttError('ATT_PAUSED');
    return fp;
  }

  onPeerHello(peerFp: string | undefined, peer: SyncPeerInfo): void {
    try {
      if (!peerFp) return;
      // 新连接：这个连接周期里「交换过」的会话与来源表从头记
      this.inbound.set(peerFp, { peer, exchanged: new Map() });
      this.holdersIn.delete(peerFp);
    } catch { /* 永不抛 */ }
  }

  private async within(ms: number, p: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); });
    const done = await Promise.race([p.then(() => true), timeout]);
    if (timer) clearTimeout(timer);
    return done;
  }

  async handleManifest(raw: unknown, conn: RpcConnection): Promise<AttManifestResponse> {
    const fp = this.enter(conn);
    const req = parseManifestRequest(raw);
    const sid = req.sessionId;
    if (!this.deps.sessionExists(sid)) {
      return { v: 1, entries: [], want: [], rejected: req.entries.map((_, index) => ({ index, code: 'session_unknown' as const })), indexing: false };
    }
    // 受理这份清单那一刻本机的引用集（下面有 await，期间来的新消息带来的引用不算被这份清单问过）
    const refs0 = this.store.referenced(sid);
    this.active++;
    const opened: Array<{ sha256: string; size: number }> = [];
    try {
      // 登记没跑完就受理，会把本机还没登记的同名文件当成「无行」：预算内没等到就整份不受理，让对方稍后重来
      if (!(await this.within(this.limits.indexBudgetMs, this.store.ensureIndexed(sid)))) {
        return { v: 1, entries: [], want: [], rejected: [], indexing: true };
      }
      const want: AttManifestResponse['want'] = [];
      const rejected: AttManifestResponse['rejected'] = [];
      const accepted: WireAttachment[] = [];
      const openedKeys = new Set<string>();
      let indexing = false;
      for (let i = 0; i < req.entries.length; i++) {
        const e = req.entries[i];
        if (!e.ok) { rejected.push({ index: i, code: e.code }); continue; }
        accepted.push(e.value);
        const blocked = this.publishBlock(fp);
        if (blocked) throw new AttError(blocked);
        const r = await this.store.acceptRemote(sid, e.value, fp);
        if (r.action === 'reject') {
          rejected.push({ index: i, code: r.code });
          // 这个名字的本机文件还没登记：让对方稍后重来
          if (r.code === 'busy') indexing = true;
          continue;
        }
        if (r.action === 'have') continue;
        const { sha256, size } = r.row;
        // 同一份内容在这份清单里出现两次（两个名字）：一次传输，提交时两个目标一起发布
        if (openedKeys.has(`${sha256}.${size}`)) continue;
        let offset: number;
        try { offset = this.receiver.begin(sha256, size, fp, 'put').offset; }
        catch (err) {
          if (attErrorCodeOf(err) !== 'ATT_BUSY') throw err;
          rejected.push({ index: i, code: 'busy' });
          continue;
        }
        if (offset === size) {
          // 暂存已收满（上次停在提交之前）：直接走校验与发布
          try { await this.receiver.finish(sha256, size, fp, 'put'); } catch { rejected.push({ index: i, code: 'failed' }); }
          continue;
        }
        opened.push({ sha256, size });
        openedKeys.add(`${sha256}.${size}`);
        want.push({ name: r.row.name, sha256, offset });
      }
      // 前面有 await：结束后再查一次已关停、已暂停、已取消配对
      const blocked = this.publishBlock(fp);
      if (blocked) throw new AttError(blocked);
      const listed = new Set(accepted.map(a => holderKey(a.name, a.sha256)));
      const entries = this.store.listPresent(sid).filter(row => !listed.has(holderKey(row.name, row.sha256))).map(toWire);
      const inbound = this.inbound.get(fp);
      if (inbound) inbound.exchanged.set(sid, refs0);
      this.setHolders(this.holdersIn, fp, sid, accepted);
      if (this.store.hasWanted(sid)) this.changed(sid);
      return { v: 1, entries, want, rejected, indexing };
    } catch (e) {
      for (const o of opened) this.receiver.release(o.sha256, o.size, fp, 'put', { deletePart: false });
      throw e;
    } finally {
      this.leave();
    }
  }

  async handleGet(raw: unknown, conn: RpcConnection): Promise<AttGetResponse> {
    const fp = this.enter(conn);
    const req = parseGetRequest(raw, this.limits.chunkBytes);
    this.active++;
    try {
      const { bytes, size } = await this.store.readChunk(req.sessionId, req.name, req.sha256, req.offset);
      // 读完之后再查一次：读盘期间可能已暂停、已取消配对、已关停，这一块不返回
      const blocked = this.publishBlock(fp);
      if (blocked) throw new AttError(blocked);
      return { v: 1, offset: req.offset, size, data: bytes.toString('base64') };
    } finally {
      this.leave();
    }
  }

  async handlePut(raw: unknown, conn: RpcConnection): Promise<AttPutResponse> {
    const fp = this.enter(conn);
    const req = parsePutRequest(raw, this.limits.chunkBytes);
    const row = this.store.get(req.sessionId, req.name);
    // 收满并发布之后再来的块：传输已经结束
    if (row && row.state === 'present' && row.sha256 === req.sha256) throw new AttError('ATT_NO_TRANSFER');
    // 没有对应的 want（未引用、被用户取消、已失败、内容对不上）：一律不收
    if (!row || row.state !== 'missing' || !row.want || row.sha256 !== req.sha256 || !this.store.referenced(req.sessionId).has(row.name.toLowerCase())) {
      throw new AttError('ATT_CANCELLED');
    }
    this.active++;
    try {
      // 提交路径里的配对、暂停、关停复查由 publishBlock 在发布之前做
      const r = await this.receiver.write(row.sha256, row.size, req.offset, req.bytes, fp, 'put');
      return { v: 1, offset: r.offset, done: r.done };
    } finally {
      this.leave();
    }
  }

  // ---- 状态模型与本机 RPC ----

  private onlineContext(sessionId: string): OnlineContext {
    const out = this.deps.outbound();
    let online = 0;
    const supporting: string[] = [];
    let allPaused = true;
    let allExchanged = true;
    /** 每台在线且支持的设备：它与本端各次交换时本机的引用集（出站、入站各至多一份）。 */
    const snapshots: Array<Array<ReadonlyMap<string, RefInfo>>> = [];
    for (const fp of this.deps.pairedPeers()) {
      let outOn = false; let inOn = false;
      try { outOn = out?.isOnline(fp) === true; inOn = this.deps.isInboundOnline(fp); } catch { /* 当作不在线 */ }
      if (!outOn && !inOn) continue;
      online++;
      const inbound = this.inbound.get(fp);
      const supports = (outOn && peerHasCap(out?.peerInfo(fp), SYNC_CAP.ATTACHMENTS)) || (inOn && peerHasCap(inbound?.peer, SYNC_CAP.ATTACHMENTS));
      if (!supports) continue;
      supporting.push(fp);
      const st = this.peers.get(fp);
      // 只有拨号方能从 ATT_PAUSED 得知对方暂停
      if (!(outOn && st?.paused === true)) allPaused = false;
      const snaps: Array<ReadonlyMap<string, RefInfo>> = [];
      const viaOut = outOn ? st?.exchanged.get(sessionId) : undefined;
      const viaIn = inOn ? inbound?.exchanged.get(sessionId) : undefined;
      if (viaOut) snaps.push(viaOut);
      if (viaIn) snaps.push(viaIn);
      if (snaps.length === 0) allExchanged = false;
      snapshots.push(snaps);
    }
    const exchangedSince = (nameKey: string): boolean =>
      snapshots.length > 0 && snapshots.every(snaps => snaps.some(refs => refs.has(nameKey)));
    const holds = (key: string): boolean => supporting.some(fp =>
      this.holdersOut.get(fp)?.get(sessionId)?.has(key) === true || this.holdersIn.get(fp)?.get(sessionId)?.has(key) === true);
    return { online, supporting, allPaused: supporting.length > 0 && allPaused, allExchanged: supporting.length > 0 && allExchanged, exchangedSince, holds };
  }

  private viewOf(sessionId: string, ref: RefInfo, ctx: OnlineContext): AttachmentView {
    const row = this.store.get(sessionId, ref.name);
    const local = this.store.localFile(sessionId, ref.name);
    let state: AttachmentState; let reason: AttachmentReason | undefined;
    let received: number | undefined;
    const ticket = row && row.state === 'missing' && row.want ? this.receiver.progress(row.sha256, row.size) : undefined;
    if (row?.state === 'present') state = 'ready';
    else if (row?.state === 'failed') {
      const code = (row.failCode ?? 'io_error') as AttachmentReason;
      state = code === 'too_large' || code === 'quota' ? 'unavailable' : 'failed';
      reason = code;
    } else if (!this.paused && ticket && this.now() - ticket.lastTouch < this.limits.recvIdleMs) { state = 'transferring'; received = ticket.received; }
    // 本端已暂停：收发全停，票已在暂停那一刻撤掉（暂存保留），不再显示「传输中」
    else if (this.paused) state = 'paused';
    else if (row && !row.want) state = 'held';
    else if (ctx.online === 0) { state = 'pending'; reason = 'source_offline'; }
    else if (ctx.supporting.length === 0) { state = 'unavailable'; reason = 'peer_unsupported'; }
    else if (ctx.allPaused) { state = 'pending'; reason = 'peer_paused'; }
    // 来源永久没了：行还在、还要取，但在线设备最近一次清单里都没列它。行本身不改，来源重新出现后状态自己回到 pending
    else if (row && ctx.allExchanged && !ctx.holds(holderKey(row.name, row.sha256))) { state = 'unavailable'; reason = 'no_source'; }
    else if (row && row.failCode === 'interrupted') { state = 'pending'; reason = 'interrupted'; }
    else if (row) { state = 'pending'; reason = 'queued'; }
    // 没有行：对端的清单还没告诉本机这份内容是什么。只有这个引用出现之后的那次交换里对端仍没列它，才能说在线的设备上没有；
    // 交换发生在引用出现之前（新消息刚到，带它的清单还没处理，或排在别的会话的传输后面）是等待，不是没有
    else if (ctx.exchangedSince(ref.name.toLowerCase())) { state = 'unavailable'; reason = 'no_source'; }
    else { state = 'pending'; reason = 'queued'; }

    const localAvailable = local !== undefined;
    // 取消只对「知道内容身份、还要取」的行有东西可记（cancel() 的条件与此相同）。还没有行的「等待同步」不给取消：
    // 那时取消记不下任何东西，清单一到照样会下载
    const wanted = row !== undefined && row.state === 'missing' && row.want;
    const canRetry = (state === 'failed' && !(reason === 'name_conflict' && localAvailable))
      || state === 'held' || (state === 'pending' && reason !== 'queued')
      || (state === 'unavailable' && (reason === 'no_source' || reason === 'quota'));
    const view: AttachmentView = {
      name: ref.name, relativePath: ref.relativePath, mimeType: ref.mimeType || row?.mimeType || 'application/octet-stream',
      state, conflict: row?.conflictSha256 !== undefined, localAvailable,
      canRetry, canCancel: wanted && (state === 'transferring' || state === 'pending'),
    };
    if (ref.originalFileName !== undefined) view.originalFileName = ref.originalFileName;
    if (reason !== undefined) view.reason = reason;
    if (row && (row.state !== 'failed' || row.sha256 !== '')) view.size = row.size;
    if (row?.state === 'present') view.sha256 = row.sha256;
    if (received !== undefined) view.received = received;
    if (local) view.localPath = local.path;
    return view;
  }

  async status(sessionId: string): Promise<AttachmentStatusResult> {
    // 强制核对：ready 的项一定刚确认过文件在本机
    await this.store.ensureIndexed(sessionId, { force: true });
    const ctx = this.onlineContext(sessionId);
    const items: AttachmentView[] = [];
    for (const ref of this.store.referenced(sessionId).values()) items.push(this.viewOf(sessionId, ref, ctx));
    for (const bad of this.store.invalidRefs(sessionId)) {
      // 名字过不了同步的规则、但文件就在本机附件桶里（chat.prompt 的白名单比同步的名字规则宽）：这一份不同步，
      // 可请求构建按文件名读本机文件、模型照常看得到——「本机有没有」照实说，界面据此不提示「模型看不到」，也打得开
      const local = this.store.localFileLoose(sessionId, bad.relativePath);
      const view: AttachmentView = {
        name: local?.name ?? basename(bad.relativePath.replace(/\\/g, '/')).slice(0, 128), relativePath: bad.relativePath, mimeType: bad.mimeType,
        state: 'unavailable', reason: 'bad_reference', conflict: false, localAvailable: local !== undefined, canRetry: false, canCancel: false,
      };
      if (local) view.localPath = local.path;
      if (bad.originalFileName !== undefined) view.originalFileName = bad.originalFileName;
      items.push(view);
    }
    return { sessionId, syncPaused: this.paused, items };
  }

  /** F11B：已删除的会话（已清除的，或在别的设备上被删、本机留着内容的保留副本）不接受对附件行的任何改动。
   *  界面到不了隐藏的会话；这是给直接调本机方法的防线——保留副本是冻结的，恢复之前它的附件行也不该变。 */
  private assertSessionLive(sessionId: string): void {
    if (!this.deps.sessionExists(sessionId)) throw new Error('会话已删除或不存在');
  }

  async retry(sessionId: string, name: string): Promise<AttachmentRetryResult> {
    this.assertSessionLive(sessionId);
    await this.store.ensureIndexed(sessionId, { force: true });
    this.store.retry(sessionId, name);
    this.kick(sessionId);
    this.changed(sessionId);
    if (this.paused) return { ok: true, started: false, reason: 'paused' };
    const ctx = this.onlineContext(sessionId);
    if (ctx.online === 0) return { ok: true, started: false, reason: 'source_offline' };
    if (ctx.supporting.length === 0) return { ok: true, started: false, reason: 'peer_unsupported' };
    return { ok: true, started: true };
  }

  cancel(sessionId: string, name: string): { ok: true } {
    this.assertSessionLive(sessionId);
    const row = this.store.get(sessionId, name);
    if (row && row.state === 'missing' && row.want) {
      this.store.hold(sessionId, row.name);
      // 这份内容没有别的要取的行时撤票并删暂存；另一个会话还要它时暂存留给那一行续传
      this.receiver.dropIfUnwanted(row.sha256, row.size);
      this.changed(sessionId);
    }
    return { ok: true };
  }

  read(sessionId: string, name: string): AttachmentReadResult {
    const ref = this.store.referenced(sessionId).get(name.toLowerCase());
    let found: { name: string; mimeType: string; path: string; size: number } | undefined;
    if (ref) {
      // 不要求行是 present：附件桶里的文件只可能来自本机自己或校验后的发布，本机文件被改过时用户照样能打开自己的文件
      const local = this.store.localFile(sessionId, ref.name);
      const row = this.store.get(sessionId, ref.name);
      if (local) found = { name: ref.name, mimeType: ref.mimeType || row?.mimeType || 'application/octet-stream', path: local.path, size: local.size };
    } else {
      // 名字过不了同步规则的引用（状态里 localAvailable 为真的 bad_reference 项）：仍然只读被本机消息引用到的、桶里的那个文件
      const bad = this.store.invalidRefs(sessionId).find(r => localAttachmentNameOf(r.relativePath) === name);
      const local = bad ? this.store.localFileLoose(sessionId, bad.relativePath) : undefined;
      if (bad && local) found = { name: local.name, mimeType: bad.mimeType || 'application/octet-stream', path: local.path, size: local.size };
    }
    if (!found) throw new Error('附件尚未同步到本机');
    const out: AttachmentReadResult = { name: found.name, mimeType: found.mimeType, size: found.size, localPath: found.path };
    if (found.size <= this.limits.previewMaxBytes) {
      try { out.base64 = readFileSync(found.path).toString('base64'); } catch { throw new Error('附件尚未同步到本机'); }
    }
    return out;
  }

  /** 本机方法的参数校验（会话 id 与名字都不直接进路径）。
   *  localName 为真（只有 attachments.read）时名字另认「本机附件桶里的单层文件名」：那一类不同步，但用户打得开自己的文件。 */
  static assertLocalArgs(p: unknown, needName: boolean, localName = false): { sessionId: string; name: string } {
    const { sessionId, name } = (p ?? {}) as { sessionId?: unknown; name?: unknown };
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new Error('非法 sessionId');
    if (!needName) return { sessionId, name: '' };
    const n = validateAttachmentName(name) ?? (localName ? localAttachmentName(name) : undefined);
    if (n === undefined) throw new Error('非法附件名');
    return { sessionId, name: n };
  }
}
