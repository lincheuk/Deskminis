/**
 * F06：接上在跑的回合（join）时，attach 往返里到达的 run 终止事件不被当成「快照已覆盖」丢掉。
 *
 * 真实的 store + 真实的 RpcClient，套接字是假的：每一帧什么时候到由用例定。引擎一侧的事实照搬——处理器同步返回后
 * 要过一个微任务才发应答，所以比水位更早广播的帧可能在客户端发出 attach 之后才到（那时客户端已经在扣帧）。
 *
 * 故障：别处起的回合第一条事件到达时，当前会话的窗口取一份带会话的快照（join）；紧跟着到的 error / turnEnd 落在水位之前，
 * 以前被判成「快照已覆盖」整条丢掉，只凭快照里那一行 run 去交代——一条不可重试的错误条，没有 lastError、没有按 code 选的短句；
 * 上下文已满没有「新建会话接力」；以截断收尾没有截断说明，也不刷新水位；取消没有「已取消」。同一帧平时到达时这些都在。
 *
 * 做法：同一组帧走两遍——① 终止帧落在 join 的 attach 往返里；② 快照先装好、终止帧随后才到（平时的路径）。
 * 两遍留下的事件条、lastError、接力草稿、截断说明、取水位的次数必须相同，而且每遍只交代一次。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeWebSocket {
  static last: FakeWebSocket;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  /** 假引擎：收到请求怎么答。state.attach 交给用例手动答（除非 autoAttach 给了应答）。 */
  server!: Server;
  constructor(public url: string) {
    FakeWebSocket.last = this;
    this.server = current!;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string): void {
    const f = JSON.parse(data);
    this.sent.push(f);
    this.server.onRequest(this, f);
  }
  close(): void { /* 用不到 */ }
  reply(id: number, result: unknown): void { this.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', id, result }) }); }
  push(seq: number, method: string, params: unknown): void { this.onmessage!({ data: JSON.stringify({ jsonrpc: '2.0', method, params, ev: { epoch: 1, seq } }) }); }
}

interface Server {
  sessions: any[]; history: Record<string, any[]>;
  /** 还没答的 state.attach（用例决定什么时候答、答什么）。 */
  attaches: { id: number; params: any }[];
  calls: string[];
  onRequest(ws: FakeWebSocket, f: any): void;
}
let current: Server | undefined;

const msg = (id: string, role: string, text: string) => ({ id, role, parts: [{ type: 'text', value: text }], createdAt: 1 });
const head = (lastSeq: number) => ({ protocol: 1, epoch: 1, instanceId: 'I', lastSeq, revision: 1, window: { firstSeq: 1, maxEvents: 8192, maxChars: 8_000_000 } });
function makeServer(): Server {
  const s: Server = {
    sessions: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }],
    history: { A: [msg('a1', 'user', '上一条'), msg('a2', 'assistant', '上一条的回答')], B: [] },
    attaches: [], calls: [],
    onRequest(ws, f) {
      s.calls.push(f.method);
      if (f.method === 'state.attach') { s.attaches.push({ id: f.id, params: f.params }); return; }
      const p = f.params ?? {};
      const result = f.method === 'chat.sessions.list' ? s.sessions
        : f.method === 'chat.messages.list' ? [...(s.history[p.sessionId] ?? [])]
        : f.method === 'permission.getPreset' ? { preset: 'ask' }
        : f.method === 'control.status' ? { syncPaused: false }
        : f.method === 'provider.getDefault' ? {}
        : f.method === 'chat.annotations.list' ? { annotations: [] }
        : f.method === 'attachments.status' ? { items: [] }
        : f.method === 'workspace.get' ? { root: '/w', isDefault: true }
        : f.method === 'chat.contextInfo' ? { windowTokens: 1000, usedTokens: 10, remaining: 990 }
        : ['provider.instances.list', 'modelgroup.list', 'assistants.list', 'skills.list', 'cron.list'].includes(f.method) ? []
        : undefined;
      // 应答晚一个微任务（与引擎一样：处理器返回之后才发）
      queueMicrotask(() => ws.reply(f.id, result));
    },
  };
  return s;
}
const snapshot = (srv: Server, lastSeq: number, o: Record<string, unknown> = {}) => ({
  ...head(lastSeq), mode: 'snapshot', reason: 'no-cursor',
  snapshot: { epoch: 1, instanceId: 'I', revision: 1, lastSeq, takenAt: 0, sessions: srv.sessions, runs: [], executions: [], live: [], pendingPermissions: [], artifacts: [], ...o },
});
/** 让出几轮：桩的应答都在微任务里，store 里没人等的异步（open、afterSync）走完。 */
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

const g = globalThis as any;
let saved: { ws: unknown; win: unknown };
beforeEach(() => { saved = { ws: g.WebSocket, win: g.window }; g.WebSocket = FakeWebSocket; g.window = { deskminis: { minisdInfo: async () => ({ port: 1, token: 't', alive: true }) } }; });
afterEach(() => { g.WebSocket = saved.ws; g.window = saved.win; current = undefined; });

/** 装一份全新的渲染端（真实 rpc 单例 + 真实 store），走完 init() 并停在会话 A 上（A 没在跑）。 */
async function mount() {
  const srv = makeServer();
  current = srv;
  vi.resetModules();
  const { rpc } = await import('../src/renderer/src/rpc');
  const { createPinia, setActivePinia } = await import('pinia');
  const { useChat } = await import('../src/renderer/src/stores/chat');
  // 关掉静默探测（不留周期定时器在 worker 里）
  const enable = rpc.enableRecovery.bind(rpc);
  rpc.enableRecovery = (hooks, opts) => enable(hooks, { ...opts, policy: { ...opts?.policy, probeIdleMs: 0 } });
  const pinia = createPinia();
  setActivePinia(pinia);
  const chat = useChat(pinia);
  const init = chat.init();
  // 首次同步：水位 5 的快照
  await vi.waitFor(() => { if (srv.attaches.length !== 1) throw new Error('首次 state.attach 还没发'); });
  const ws = FakeWebSocket.last;
  ws.reply(srv.attaches.shift()!.id, snapshot(srv, 5));
  await init;
  await chat.open('A');
  await settle();
  expect([chat.syncOn, chat.activeId, chat.running]).toEqual([true, 'A', false]);
  srv.calls.length = 0;
  return { chat, srv, ws };
}

const RUN = { id: 'r1', generation: 1, epoch: 1 };
const ev = (event: Record<string, unknown>) => ({ sessionId: 'A', event, run: RUN });
const runView = (o: Record<string, unknown>) => ({
  runId: 'r1', sessionId: 'A', generation: 1, epoch: 1, state: 'running', step: 'model', toolBatches: 0,
  origin: { kind: 'user' }, createdAt: 1, updatedAt: 1, userMessageId: 'a3', ...o,
});

interface Outcome {
  notes: unknown[]; lastError: string; relay: unknown; outputLimit: unknown; stopReason: string;
  running: boolean; runningSessions: string[]; messages: string[]; contextInfoCalls: number; streamingText: string;
}
/**
 * 别处在会话 A 里起了一次 run：第一条事件（seq 6）到达，窗口发出 join 的 attach；随后是终止帧（seq 7）。
 * race = true：终止帧在 attach 的应答之前到（落在水位 7 之前）；false：快照（水位 6）先装好，终止帧随后才到。
 */
async function play(race: boolean, first: Record<string, unknown>, end: Record<string, unknown>, ended: Record<string, unknown>): Promise<Outcome> {
  const { chat, srv, ws } = await mount();
  srv.history.A = [...srv.history.A, msg('a3', 'user', '别处发的')];
  const session = (): unknown => ({ sessionId: 'A', exists: true, messages: [...srv.history.A] });
  ws.push(6, 'chat.event', ev(first));
  // 处理器的同一段同步代码里 join 的 attach 已经发出：此后到的帧只进缓冲
  expect(srv.attaches).toHaveLength(1);
  expect([chat.running, chat.midRun]).toEqual([true, true]);
  const attach = srv.attaches.shift()!;
  expect(attach.params.sessionId).toBe('A');
  if (race) {
    ws.push(7, 'chat.event', ev(end));
    ws.reply(attach.id, snapshot(srv, 7, { runs: [runView(ended)], session: session() }));
  } else {
    ws.reply(attach.id, snapshot(srv, 6, { runs: [runView({})], live: [{ runId: 'r1', sessionId: 'A', generation: 1, epoch: 1, text: '', thinking: '', seq: 6 }], session: session() }));
    await settle();
    ws.push(7, 'chat.event', ev(end));
  }
  await settle();
  // 终止之后别的 attach 都照常答（turnEnd / error 的 open() 不在跑，不会再 join；兜一下，免得挂住）
  expect(srv.attaches).toEqual([]);
  return {
    notes: chat.eventNotes.map(n => { const { ts, ...rest } = n; void ts; return rest; }),
    lastError: chat.lastError, relay: chat.relaySource, outputLimit: chat.lastOutputLimit, stopReason: chat.lastStopReason,
    running: chat.running, runningSessions: [...chat.runningSessions], messages: chat.messages.map(m => m.id),
    contextInfoCalls: srv.calls.filter(m => m === 'chat.contextInfo').length, streamingText: chat.streamingText,
  };
}

describe('F06：join 的 attach 往返里到达的终止事件照原路处理', () => {
  const CAP = { kind: 'capability', label: '兼容处理', notices: ['历史图片改以文字发送'] };

  it('上下文已满：接力草稿与「新建会话接力」、按 code 的短句、lastError 都在，只交代一次——与平时到达逐项相同', async () => {
    const end = { kind: 'error', code: 'contextFull', message: '上下文已满（原始错误：HTTP 500）', relayDraft: '接力草稿：摘要 + 最后一条消息' };
    const ended = { state: 'failed', stopReason: 'contextFull', stopDetail: '上下文已满（原始错误：HTTP 500）' };
    const raced = await play(true, CAP, end, ended);
    const normal = await play(false, CAP, end, ended);
    expect(raced).toEqual(normal);
    expect(raced.notes.filter((n: any) => n.kind === 'error')).toEqual([
      { kind: 'error', detail: '上下文已满（原始错误：HTTP 500）', retryable: false, relay: true, short: '上下文已满，当前模型放不下这段对话' },
    ]);
    expect(raced.relay).toEqual({ sessionId: 'A', text: '接力草稿：摘要 + 最后一条消息' });
    expect([raced.lastError, raced.running, raced.runningSessions]).toEqual(['上下文已满（原始错误：HTTP 500）', false, []]);
    expect(raced.messages).toEqual(['a1', 'a2', 'a3']);
  });

  it('普通错误：带重试钮；取消：留下「已取消」——都只一条', async () => {
    const raced = await play(true, { kind: 'textDelta', text: '半句' }, { kind: 'error', message: 'HTTP 502 Bad Gateway' }, { state: 'failed', stopReason: 'error', stopDetail: 'HTTP 502 Bad Gateway' });
    const normal = await play(false, { kind: 'textDelta', text: '半句' }, { kind: 'error', message: 'HTTP 502 Bad Gateway' }, { state: 'failed', stopReason: 'error', stopDetail: 'HTTP 502 Bad Gateway' });
    expect(raced).toEqual(normal);
    expect(raced.notes).toEqual([{ kind: 'error', detail: 'HTTP 502 Bad Gateway', retryable: true }]);
    expect([raced.running, raced.streamingText]).toEqual([false, '']);

    const cancelled = await play(true, { kind: 'textDelta', text: '半句' }, { kind: 'error', message: '已取消' }, { state: 'cancelled', stopReason: 'user-stop' });
    expect(cancelled).toEqual(await play(false, { kind: 'textDelta', text: '半句' }, { kind: 'error', message: '已取消' }, { state: 'cancelled', stopReason: 'user-stop' }));
    expect(cancelled.notes).toHaveLength(1);
    expect([cancelled.lastError, cancelled.running]).toEqual(['已取消', false]);
  });

  it('以 max_tokens 截断收尾：截断说明（lastOutputLimit）在，水位照常重取', async () => {
    const end = { kind: 'turnEnd', stopReason: 'maxTokens', outputLimit: { requested: 4096, limitedBy: 'preference', continued: 2 } };
    const ended = { state: 'completed', stopReason: 'maxTokens' };
    const raced = await play(true, { kind: 'textDelta', text: '半句' }, end, ended);
    const normal = await play(false, { kind: 'textDelta', text: '半句' }, end, ended);
    expect(raced).toEqual(normal);
    expect(raced.outputLimit).toEqual({ requested: 4096, limitedBy: 'preference', continued: 2 });
    expect([raced.stopReason, raced.running, raced.notes]).toEqual(['maxTokens', false, []]);
    expect(raced.contextInfoCalls).toBeGreaterThanOrEqual(1);
  });
});
