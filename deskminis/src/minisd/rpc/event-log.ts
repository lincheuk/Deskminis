/**
 * F06：广播的入序与保留窗口。
 *
 * 以前 RpcServer.broadcast 现拼一帧就发，帧没有序号、发完即弃：客户端分不清重复、漏帧、乱序，断线期间的事件也无处可补。
 * 现在每条广播（UNSEQUENCED_METHODS 除外）在这里拿到本代次内连续的序号，带着 ev { epoch, seq } 成帧，并在内存里留一段窗口：
 * 短暂断线的客户端凭游标要回 (游标, lastSeq] 的原帧（state.attach 的续传）；窗口盖不住就改取快照。
 *
 * 窗口不落库：引擎重启后代次变了，旧序号全部作废，持久窗口没有读者；快照永远能从权威状态现算。
 * 这里只有内存里的字符串，没有要收尾的资源。
 */
import { eventSessionId, UNSEQUENCED_METHODS, type EventFrame } from '../../shared/event-stream';

export const EVENT_RETAIN_MAX_EVENTS = 8192;
/** 帧字符串长度之和的上限。 */
export const EVENT_RETAIN_MAX_CHARS = 8_000_000;
/** 一次续传最多回放这么多字符，超过改给快照。 */
export const RESUME_MAX_CHARS = 2_000_000;

export interface EventLogOptions {
  epoch: number; maxEvents?: number; maxChars?: number; unsequenced?: readonly string[];
  /** 序号分配之后、帧入窗口之前同步调用（流式尾巴靠它）。抛错被兜住、只告警一次，不影响序号与帧。 */
  onAppend?: (method: string, params: unknown, seq: number) => void;
  warn?: (msg: string, e?: unknown) => void;
}

export class EventLog {
  readonly epoch: number;
  private readonly maxEvents: number;
  private readonly maxChars: number;
  private readonly unsequenced: ReadonlySet<string>;
  private readonly onAppend: ((method: string, params: unknown, seq: number) => void) | undefined;
  private readonly warn: (msg: string, e?: unknown) => void;
  private warned = false;
  /** 已分配的最大序号。 */
  private seq = 0;
  /** 窗口：items[head..] 是留着的帧，seq 连续升序。出队只挪 head，攒够了再整体截掉（不逐条 shift）。
   *  items[0..head) 是已经淘汰、还没截掉的位置：帧字符串在淘汰那一刻就放掉（置空），只剩一个空壳——
   *  不放的话，大帧占多数时（toolEnd 带完整输出）被淘汰的上千条大帧还留在堆里，实际占用是字符上限的几十倍。 */
  private items: { seq: number; frame: string; sessionId?: string }[] = [];
  private head = 0;
  private chars = 0;

  constructor(o: EventLogOptions) {
    this.epoch = o.epoch;
    this.maxEvents = Math.max(1, Math.floor(o.maxEvents ?? EVENT_RETAIN_MAX_EVENTS));
    this.maxChars = Math.max(1, Math.floor(o.maxChars ?? EVENT_RETAIN_MAX_CHARS));
    this.unsequenced = new Set(o.unsequenced ?? UNSEQUENCED_METHODS);
    this.onAppend = o.onAppend;
    this.warn = o.warn ?? ((msg, e) => { console.warn(msg, e); });
  }

  /** 已分配的最大序号；还没有事件时是 0。 */
  get lastSeq(): number { return this.seq; }
  /** 窗口里最早一条的序号；窗口为空时是 lastSeq + 1。 */
  get firstSeq(): number { return this.head < this.items.length ? this.items[this.head].seq : this.seq + 1; }
  get limits(): { maxEvents: number; maxChars: number } { return { maxEvents: this.maxEvents, maxChars: this.maxChars }; }

  /**
   * RpcServer.broadcast 的出帧步骤。不入序的方法返回 undefined（调用方照旧现拼一帧）。
   * 序列化失败原样抛出且不消耗 seq（与 broadcast 以前 JSON.stringify 抛错的行为相同，序号不留空洞）。
   * 同步：seq 的分配顺序 = 每条连接上的发送顺序。没有任何连接时照常分配并入窗口（断线期间的事件靠它续传）。
   */
  append(method: string, params: unknown): string | undefined {
    if (this.unsequenced.has(method)) return undefined;
    const seq = this.seq + 1;
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params, ev: { epoch: this.epoch, seq } });
    this.seq = seq;
    // 尾巴在分配序号的同一步里折叠：「尾巴 = seq <= lastSeq 的增量的折叠」由构造保证，与哪个调用点发布无关
    if (this.onAppend) {
      try { this.onAppend(method, params, seq); }
      catch (e) {
        if (!this.warned) { this.warned = true; this.warn('事件入序回调出错（帧与序号不受影响；此后同类错误不再提示）:', e); }
      }
    }
    this.items.push({ seq, frame, sessionId: eventSessionId(method, params) });
    this.chars += frame.length;
    // 淘汰最老的；刚入窗口的那一帧不删（单帧超上限时窗口里只剩它）
    while (this.items.length - this.head > 1 && (this.items.length - this.head > this.maxEvents || this.chars > this.maxChars)) {
      this.chars -= this.items[this.head].frame.length;
      this.items[this.head].frame = ''; // 当场放掉字符串：since() 只读 head 之后的条目，不会再碰它
      this.head += 1;
    }
    if (this.head >= 1024 && this.head * 2 >= this.items.length) { this.items = this.items.slice(this.head); this.head = 0; }
    return frame;
  }

  /** Erase retained content at the deletion boundary, including retained copies.
   * Keep epoch/seq so a reconnecting client can advance across the erased payload.
   * Restoration exposes durable history again; it never resurrects these old frames. */
  redactSession(sessionId: string): void {
    for (let i = this.head; i < this.items.length; i++) {
      const item = this.items[i];
      if (item.sessionId !== sessionId) continue;
      const frame = JSON.stringify({ jsonrpc: '2.0', method: 'state.redacted', params: {}, ev: { epoch: this.epoch, seq: item.seq } });
      this.chars += frame.length - item.frame.length;
      item.frame = frame;
      item.sessionId = undefined;
    }
  }

  /**
   * (afterSeq, lastSeq] 的全部帧，升序、新解析的对象；afterSeq === lastSeq → []。
   * 窗口盖不住返回 'expired'，字符数之和超过 maxChars 返回 'too-large'。调用方先判过 afterSeq <= lastSeq。
   */
  since(afterSeq: number, maxChars: number = Number.POSITIVE_INFINITY): EventFrame[] | 'expired' | 'too-large' {
    if (afterSeq >= this.seq) return [];
    if (afterSeq + 1 < this.firstSeq) return 'expired';
    const from = this.head + (afterSeq + 1 - this.firstSeq);
    let total = 0;
    for (let i = from; i < this.items.length; i++) {
      total += this.items[i].frame.length;
      if (total > maxChars) return 'too-large';
    }
    const out: EventFrame[] = [];
    for (let i = from; i < this.items.length; i++) {
      const f = JSON.parse(this.items[i].frame) as { method: string; params?: unknown; ev: EventFrame['ev'] };
      out.push({ method: f.method, params: f.params, ev: f.ev });
    }
    return out;
  }
}
