/**
 * F06：流式尾巴——每个活动 run 最近一次落库之后已经发布、还没进历史的正文与思考。
 *
 * 落库的粒度是整条消息（assistant 每个模型回合一条，结果每批一条）；textDelta / thinkingDelta 只广播不落库。
 * 重载或重连的客户端从历史里拿得到已落库的部分，流到一半的那一截以前无处可取。这里在内存里跟着广播折叠出它，
 * 随 state.attach 的快照交出去：历史 + 尾巴 = 这一刻已经发布的全部内容。
 *
 * 折叠挂在 EventLog.append 分配序号的同一步里（onAppend）：尾巴恒等于 seq <= lastSeq 的增量的折叠。
 * 只在内存里，引擎重启即无（没落库的半截本来就随旧进程丢失）。
 */
import type { RunLiveView } from '../../shared/event-stream';

/** 每个 run 的正文、思考各自的上限。超过就停止追加并标 truncated（客户端退回占位）。 */
export const LIVE_TAIL_MAX_CHARS = 1_000_000;

interface Tail { runId: string; sessionId: string; generation: number; epoch: number; text: string; thinking: string; truncated: boolean; seq: number }

export class LiveTails {
  private readonly tails = new Map<string, Tail>();

  constructor(private readonly maxChars: number = LIVE_TAIL_MAX_CHARS) {}

  /**
   * EventLog.onAppend 的回调体。只看 method === 'chat.event' 且 params.run、params.event 都在的帧
   * （kind:'synced' 的同步通知没有 event，不看）。
   *  - textDelta / thinkingDelta：追加；
   *  - retry / fallback：清空（循环会整段重来，与渲染端 onEvent 的清空口径相同）；
   *  - messagePersisted：清空（已进历史；思考随 reasoningContent 一起落了）；
   *  - turnEnd / error：删掉这个 run 的条目；
   *  - 其它：只更新 seq。
   */
  observe(method: string, params: unknown, seq: number): void {
    if (method !== 'chat.event' || params === null || typeof params !== 'object') return;
    const p = params as { sessionId?: unknown; event?: { kind?: unknown; text?: unknown }; run?: { id?: unknown; generation?: unknown; epoch?: unknown } };
    const run = p.run;
    const e = p.event;
    if (!run || typeof run.id !== 'string' || !e || typeof e.kind !== 'string') return;
    if (e.kind === 'turnEnd' || e.kind === 'error') { this.tails.delete(run.id); return; }
    let t = this.tails.get(run.id);
    if (!t) {
      t = {
        runId: run.id, sessionId: typeof p.sessionId === 'string' ? p.sessionId : '',
        generation: typeof run.generation === 'number' ? run.generation : 0, epoch: typeof run.epoch === 'number' ? run.epoch : 0,
        text: '', thinking: '', truncated: false, seq,
      };
      this.tails.set(run.id, t);
    }
    if (e.kind === 'textDelta' || e.kind === 'thinkingDelta') {
      const add = typeof e.text === 'string' ? e.text : '';
      const key = e.kind === 'textDelta' ? 'text' : 'thinking';
      // 截断之后两个缓冲都不再追加：内容已经不完整，客户端按占位处理，直到下一个重置点
      if (!t.truncated) {
        if (t[key].length + add.length > this.maxChars) t.truncated = true;
        else t[key] += add;
      }
    } else if (e.kind === 'retry' || e.kind === 'fallback' || e.kind === 'messagePersisted') {
      t.text = ''; t.thinking = ''; t.truncated = false;
    }
    t.seq = seq;
  }

  /** 当前全部尾巴，每次返回新对象：应答在处理器返回之后才序列化，中间隔着微任务，
   *  返回的对象若会被后来的事件就地修改，快照里就会混进 seq > lastSeq 的内容。 */
  list(): RunLiveView[] {
    return [...this.tails.values()].map(t => ({
      runId: t.runId, sessionId: t.sessionId, generation: t.generation, epoch: t.epoch,
      text: t.text, thinking: t.thinking, ...(t.truncated ? { truncated: true as const } : {}), seq: t.seq,
    }));
  }

  /** 只留下这些 run 的条目（快照时用账本的活动 run 清一次，防止没有终止事件的 run 留下条目）。 */
  retain(runIds: ReadonlySet<string>): void {
    for (const id of [...this.tails.keys()]) if (!runIds.has(id)) this.tails.delete(id);
  }
}
