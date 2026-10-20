/**
 * F06 fixture（不是测试）：带闸的模型端点、WebSocket 故障代理、记录原始帧的客户端、进程内引擎（可在同一数据根上重启）、
 * 在 Node 里装真实的渲染端 RpcClient 与 store。
 *
 * 产品代码里没有任何故障开关：丢帧、重复、乱序、吞应答、掐线全部发生在测试进程里的代理上；
 * 流式正文停在第几段由测试进程里的模型端点决定。断言落在状态与副作用上（端点被请求了几次、库里几条消息、
 * 代理转发了几条上行帧、文件写了几次）。
 *
 * 复用 run-ledger-fixture.ts（rpcClient、waitFor、spawnEngine、killTree、readDb、gatedScript），不改它。
 */
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { startMinisd, type StartMinisdOpts } from '../src/minisd/index';
import {
  StreamTracker, isAttachResult, isEventStamp,
  type AttachResult, type EventFrame, type PendingPermissionView, type SnapshotReason,
} from '../src/shared/event-stream';
import { rpcClient, waitFor, type Client } from './run-ledger-fixture';

// ---------- 带闸的模型端点（OpenAI 兼容 SSE） ----------

export type GatedStep =
  /** 正文分段发：每一段等闸放行（release / open）。tools 给了则正文之后再带一批工具调用。 */
  | { chunks: string[]; tools?: { name: string; input: Record<string, unknown> }[] }
  | { tools: { name: string; input: Record<string, unknown> }[] }
  | { text: string }
  /** 收到请求后不应答（连接挂着，直到对端断开或端点关闭）。 */
  | { hang: true }
  /** 直接回一个 HTTP 错误。 */
  | { status: number; body?: string };

export interface GatedHit { at: number; tag?: string; step: number; messages: any[]; stream: boolean; title: boolean }

/** 一个标签的闸：已发出几段、放行几段。 */
export interface Gate {
  /** 再放行 n 段（缺省 1）。 */
  release(n?: number): void;
  /** 不再设闸：此后的段落到了就发。 */
  open(): void;
  /** 这个标签名下已经写出去的正文段数（跨步骤累计）。 */
  sent(): number;
}

const TAG_RE = /\[\[(S\d+)\]\]/;
/** auto-title.ts 的系统提示开头：命名请求里也带着用户原文（含标签），不能按剧本答。 */
const TITLE_MARK = '标题生成器';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
}

/** 第 i 段正文：每段唯一，丢一段或重一段都看得出来。 */
export const seg = (i: number): string => `‹${i}›`;
export const segs = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => seg(from + i));

/**
 * 本地 OpenAI 兼容端点：POST <baseUrl>/chat/completions。
 * 剧本按请求里最后一条带标签的 user 文本中的标签（[[S1]]…）选；第几步 = 那条消息之后 assistant 消息的条数。
 * 命名请求（系统提示含「标题生成器」）与没有标签、剧本走完的请求立刻回一段短文本。
 * 工具调用的 id 是确定的：call_<标签>_<步>_<下标>。
 */
export async function gatedLlm(scripts: Record<string, GatedStep[]>): Promise<{
  baseUrl: string; hits: GatedHit[];
  /** 这个标签的剧本请求（不含命名请求）。 */
  hitsOf(tag: string): GatedHit[];
  gate(tag: string): Gate;
  close(): Promise<void>;
}> {
  const hits: GatedHit[] = [];
  const sockets = new Set<Socket>();
  const gates = new Map<string, { permits: number; sent: number; waiters: Set<() => void> }>();
  const gateOf = (tag: string) => {
    let g = gates.get(tag);
    if (!g) { g = { permits: 0, sent: 0, waiters: new Set() }; gates.set(tag, g); }
    return g;
  };
  const wake = (tag: string): void => { for (const w of [...gateOf(tag).waiters]) w(); };
  /** 等到这个标签有一段可发（占用一个名额）；响应已关闭则返回 false。 */
  const acquire = (tag: string, res: ServerResponse): Promise<boolean> => new Promise(resolve => {
    const g = gateOf(tag);
    const tryNow = (): boolean => {
      if (res.destroyed || res.writableEnded) { done(false); return true; }
      if (g.permits > 0) { g.permits -= 1; done(true); return true; }
      return false;
    };
    const done = (ok: boolean): void => { g.waiters.delete(tryNow); res.off('close', onClose); resolve(ok); };
    const onClose = (): void => { done(false); };
    if (tryNow()) return;
    g.waiters.add(tryNow);
    res.on('close', onClose);
  });

  const sse = async (res: ServerResponse, model: string, step: GatedStep | undefined, tag: string | undefined, stepNo: number, usage: boolean): Promise<void> => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.socket?.setNoDelay(true);
    const id = `chatcmpl-f06-${hits.length}`;
    const created = Math.floor(Date.now() / 1000);
    const send = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
    const chunk = (delta: unknown, finish: string | null = null): unknown =>
      ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
    send(chunk({ role: 'assistant', content: '' }));
    if (step && 'chunks' in step && tag) {
      for (const c of step.chunks) {
        if (!(await acquire(tag, res))) return; // 对端断开（取消、引擎被杀）：不再写
        send(chunk({ content: c }));
        gateOf(tag).sent += 1;
      }
    }
    const tools = step && 'tools' in step ? step.tools : undefined;
    if (tools && tools.length > 0) {
      tools.forEach((t, i) => {
        send(chunk({ tool_calls: [{ index: i, id: `call_${tag}_${stepNo}_${i}`, type: 'function', function: { name: t.name, arguments: '' } }] }));
        send(chunk({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(t.input) } }] }));
      });
      send(chunk({}, 'tool_calls'));
    } else {
      if (!(step && 'chunks' in step)) send(chunk({ content: step && 'text' in step ? step.text : '好的' }));
      send(chunk({}, 'stop'));
    }
    if (usage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => { raw += d; });
    req.on('end', () => {
      let body: any;
      try { body = JSON.parse(raw); } catch { res.writeHead(400).end('bad json'); return; }
      const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
      const title = messages.some(m => m?.role === 'system' && textOf(m.content).includes(TITLE_MARK));
      // 最后一条带标签的 user 消息定剧本，它之后的 assistant 条数定第几步：同一个会话里先后发两条带不同标签的消息时，
      // 第二条按它自己的剧本从第 0 步走（只有一条带标签的消息时，与「第一条 user 的标签 + 全部 assistant 条数」相同）
      let tagAt = -1;
      if (!title) for (let i = messages.length - 1; i >= 0; i--) { if (messages[i]?.role === 'user' && TAG_RE.test(textOf(messages[i].content))) { tagAt = i; break; } }
      const tag = tagAt >= 0 ? TAG_RE.exec(textOf(messages[tagAt].content))?.[1] : undefined;
      const stepNo = messages.slice(Math.max(tagAt, 0)).filter(m => m?.role === 'assistant').length;
      const step = tag ? scripts[tag]?.[stepNo] : undefined;
      hits.push({ at: Date.now(), tag, step: stepNo, messages, stream: body.stream === true, title });
      if (step && 'hang' in step) return; // 不应答
      if (step && 'status' in step) { res.writeHead(step.status, { 'content-type': 'application/json' }).end(step.body ?? JSON.stringify({ error: { message: 'f06 injected failure' } })); return; }
      if (body.stream !== true) {
        const text = step && 'text' in step ? step.text : step && 'chunks' in step ? step.chunks.join('') : '好的';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-f06', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
        return;
      }
      void sse(res, String(body.model ?? ''), step, tag, stepNo, body.stream_options?.include_usage === true).catch(() => { /* 对端断开 */ });
    });
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`, hits,
    hitsOf: tag => hits.filter(h => h.tag === tag && !h.title),
    gate: tag => ({
      release: (n = 1) => { gateOf(tag).permits += n; wake(tag); },
      open: () => { gateOf(tag).permits = Number.POSITIVE_INFINITY; wake(tag); },
      sent: () => gateOf(tag).sent,
    }),
    close: () => new Promise<void>(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
export type GatedLlm = Awaited<ReturnType<typeof gatedLlm>>;

// ---------- 记录原始帧的客户端 ----------

export interface WireFrame { id?: number; method?: string; params?: any; result?: any; error?: { code?: number; message: string }; ev?: { epoch: number; seq: number } }

/**
 * 真实 ws 客户端，原样记下每一帧（含顶层的 ev）。call 不抛：返回 { result } 或 { error }，
 * 连接断开时挂着的调用以 { error: 连接已断开 } 了结。
 */
export function wireClient(port: number, token: string, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}${query}`);
  let idc = 0;
  const pending = new Map<number, (v: WireFrame) => void>();
  /** 全部帧，按到达顺序。 */
  const frames: WireFrame[] = [];
  /** 通知帧（有 method、没有被当成应答的），按到达顺序。 */
  const notifications: WireFrame[] = [];
  const listeners: ((f: WireFrame) => void)[] = [];
  let closed = false;
  let closeInfo: { code: number } | undefined;
  ws.on('message', data => {
    const msg = JSON.parse(String(data)) as WireFrame;
    frames.push(msg);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); return; }
    if (msg.method) {
      notifications.push(msg);
      for (const l of listeners) { try { l(msg); } catch { /* 监听者的错误不影响收帧 */ } }
    }
  });
  ws.on('close', code => {
    closed = true; closeInfo = { code };
    for (const [id, res] of pending) { res({ error: { message: '连接已断开' } }); pending.delete(id); }
  });
  ws.on('error', () => undefined);
  const ready = new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  ready.catch(() => undefined);
  function call(method: string, params?: unknown): Promise<WireFrame> {
    if (closed) return Promise.resolve({ error: { message: '连接已断开' } });
    const id = ++idc;
    return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return {
    ws, ready, call, frames, notifications,
    onNotify: (l: (f: WireFrame) => void) => { listeners.push(l); },
    isClosed: () => closed, closeCode: () => closeInfo?.code,
    close: () => ws.close(), terminate: () => ws.terminate(),
  };
}
export type WireClient = ReturnType<typeof wireClient>;

/** 这个会话的 run 事件（带 event 字段的 chat.event）。 */
export const runEventsOf = (c: Pick<WireClient, 'notifications'>, sessionId: string): any[] =>
  c.notifications.filter(n => n.method === 'chat.event' && n.params?.sessionId === sessionId && n.params.event !== undefined).map(n => n.params.event);
/** 这个会话已发布的正文增量拼起来（不看重置点：只用于没有 retry / fallback / 工具回合的剧本）。 */
export const publishedText = (c: Pick<WireClient, 'notifications'>, sessionId: string): string =>
  runEventsOf(c, sessionId).filter(e => e.kind === 'textDelta').map(e => e.text).join('');

// ---------- WebSocket 故障代理 ----------

type FramePred = (f: WireFrame) => boolean;

/**
 * 夹在客户端与引擎之间的本机 WebSocket 中继，逐帧转发。握手原样透传（URL 的 path 与 query 不变）：引擎拒绝则客户端同样被拒。
 *
 * 下行（引擎 → 客户端）：
 *  - drop(pred, times)：吞掉接下来 times 条命中的帧；
 *  - duplicate(pred, times)：接下来 times 条命中的帧各发两次；
 *  - swapNext(pred)：命中的那一帧与它后面的一帧交换次序；
 *  - hold() / release()：扣住全部下行帧 / 按原序放出。
 * 上行（客户端 → 引擎）：
 *  - forwardThenCut(method)：下一条该方法的请求照常转给引擎，随即掐断客户端一侧；引擎的应答被吞掉，之后关掉上游；
 *  - cutBefore(method)：下一条该方法的请求不转发，两侧一起掐断。
 * cut()：掐断当前全部连接。refuse(on)：打开后新的连接在握手阶段被拒。
 * upstreamCalls：引擎实际收到的请求（方法名、帧 id、第几条连接），按转发顺序。
 * upstreamIdle()：已转发的请求都已有应答（或所在连接已关）时兑现。
 */
export async function faultProxy(enginePort: number) {
  let target = enginePort;
  let refusing = false;
  let connNo = 0;
  const upstreamCalls: { conn: number; id?: number; method: string }[] = [];
  /** 下行帧（代理从引擎收到的），按到达顺序；delivered = 实际发给了客户端几次。 */
  const downstream: { conn: number; frame: WireFrame; delivered: number }[] = [];
  const outstanding = new Set<string>();
  const idleWaiters: (() => void)[] = [];
  const noteIdle = (): void => { if (outstanding.size === 0) for (const w of idleWaiters.splice(0)) w(); };
  const dropRules: { pred: FramePred; left: number }[] = [];
  const dupRules: { pred: FramePred; left: number }[] = [];
  const swapRules: FramePred[] = [];
  const cutAfter = new Set<string>();
  const cutBeforeSet = new Set<string>();
  let holding = false;
  const held: (() => void)[] = [];
  const pairs = new Set<{ no: number; client?: WebSocket; up: WebSocket; kill(): void }>();

  const wss = new WebSocketServer({
    host: '127.0.0.1', port: 0,
    verifyClient: (info, cb) => {
      if (refusing) { cb(false, 503, 'refused'); return; }
      const up = new WebSocket(`ws://127.0.0.1:${target}${info.req.url ?? '/'}`);
      const early: { data: WebSocket.RawData; isBinary: boolean }[] = [];
      const onEarly = (data: WebSocket.RawData, isBinary: boolean): void => { early.push({ data, isBinary }); };
      up.on('message', onEarly);
      let settled = false;
      up.once('open', () => { if (settled) return; settled = true; (info.req as any).__up = { up, early, onEarly }; cb(true); });
      up.once('unexpected-response', (_req, res) => { if (settled) return; settled = true; cb(false, res.statusCode ?? 502, 'upstream refused'); try { up.terminate(); } catch { /* 已关 */ } });
      up.on('error', () => { if (settled) return; settled = true; cb(false, 502, 'upstream unreachable'); });
    },
  });
  await new Promise<void>(r => wss.once('listening', () => r()));

  wss.on('connection', (client, req) => {
    const { up, early, onEarly } = (req as any).__up as { up: WebSocket; early: { data: WebSocket.RawData; isBinary: boolean }[]; onEarly: (d: WebSocket.RawData, b: boolean) => void };
    const no = ++connNo;
    /** 被 forwardThenCut 吞应答的请求 id。 */
    const swallow = new Set<number>();
    let swapHeld: (() => void) | undefined;
    const pair = {
      no, client, up,
      kill: (): void => { try { client.terminate(); } catch { /* 已关 */ } try { up.terminate(); } catch { /* 已关 */ } },
    };
    pairs.add(pair);
    const dropOutstanding = (): void => {
      for (const k of [...outstanding]) if (k.startsWith(`${no}:`)) outstanding.delete(k);
      noteIdle();
    };
    client.on('error', () => undefined);
    up.on('error', () => undefined);
    client.on('close', () => {
      // 有被吞应答的请求在途时上游先留着（引擎照常处理那条请求），应答到了再关
      if (swallow.size === 0) { try { up.terminate(); } catch { /* 已关 */ } }
    });
    up.on('close', () => { pairs.delete(pair); dropOutstanding(); try { client.terminate(); } catch { /* 已关 */ } });

    const toClient = (data: WebSocket.RawData, isBinary: boolean, rec: { delivered: number }): void => {
      const sendNow = (): void => { if (client.readyState === WebSocket.OPEN) { client.send(data, { binary: isBinary }); rec.delivered += 1; } };
      if (holding) held.push(sendNow); else sendNow();
    };
    const onDown = (data: WebSocket.RawData, isBinary: boolean): void => {
      let frame: WireFrame = {};
      if (!isBinary) { try { frame = JSON.parse(String(data)) as WireFrame; } catch { frame = {}; } }
      const rec = { conn: no, frame, delivered: 0 };
      downstream.push(rec);
      if (frame.id !== undefined && frame.method === undefined) {
        outstanding.delete(`${no}:${frame.id}`);
        noteIdle();
        if (swallow.has(frame.id)) {
          swallow.delete(frame.id);
          if (swallow.size === 0 && client.readyState !== WebSocket.OPEN) { try { up.terminate(); } catch { /* 已关 */ } }
          return;
        }
      }
      const dr = dropRules.find(r => r.left > 0 && r.pred(frame));
      if (dr) { dr.left -= 1; return; }
      if (swapHeld) {
        // 上一帧被扣着等交换：先发这一帧，再发被扣的那一帧
        const prev = swapHeld; swapHeld = undefined;
        toClient(data, isBinary, rec);
        prev();
        return;
      }
      const si = swapRules.findIndex(p => p(frame));
      if (si >= 0) { swapRules.splice(si, 1); swapHeld = () => toClient(data, isBinary, rec); return; }
      toClient(data, isBinary, rec);
      const du = dupRules.find(r => r.left > 0 && r.pred(frame));
      if (du) { du.left -= 1; toClient(data, isBinary, rec); }
    };
    up.off('message', onEarly);
    for (const e of early.splice(0)) onDown(e.data, e.isBinary);
    up.on('message', onDown);

    client.on('message', (data, isBinary) => {
      let frame: WireFrame = {};
      if (!isBinary) { try { frame = JSON.parse(String(data)) as WireFrame; } catch { frame = {}; } }
      const method = frame.method;
      if (method !== undefined && cutBeforeSet.has(method)) {
        cutBeforeSet.delete(method);
        pair.kill();
        return;
      }
      if (up.readyState !== WebSocket.OPEN) return;
      if (method !== undefined) {
        upstreamCalls.push({ conn: no, method, ...(frame.id !== undefined ? { id: frame.id } : {}) });
        if (frame.id !== undefined) outstanding.add(`${no}:${frame.id}`);
      }
      const cutNow = method !== undefined && cutAfter.has(method);
      if (cutNow) { cutAfter.delete(method!); if (frame.id !== undefined) swallow.add(frame.id); }
      up.send(data, { binary: isBinary });
      if (cutNow) { try { client.terminate(); } catch { /* 已关 */ } }
    });
  });

  return {
    port: (wss.address() as AddressInfo).port,
    upstreamCalls, downstream,
    /** 引擎换了端口（重启）时改指向。 */
    retarget: (port: number): void => { target = port; },
    drop: (pred: FramePred, times = 1): void => { dropRules.push({ pred, left: times }); },
    duplicate: (pred: FramePred, times = 1): void => { dupRules.push({ pred, left: times }); },
    swapNext: (pred: FramePred): void => { swapRules.push(pred); },
    hold: (): void => { holding = true; },
    release: (): void => { holding = false; for (const f of held.splice(0)) f(); },
    forwardThenCut: (method: string): void => { cutAfter.add(method); },
    cutBefore: (method: string): void => { cutBeforeSet.add(method); },
    /** 把此前已经发过的下行帧里最近一条命中的再发一遍（晚到的重复帧）。返回是否找到并发出。 */
    replay: (pred: FramePred): boolean => {
      for (let i = downstream.length - 1; i >= 0; i--) {
        const d = downstream[i];
        if (d.delivered === 0 || !pred(d.frame)) continue;
        const p = [...pairs].find(x => x.no === d.conn);
        if (!p?.client || p.client.readyState !== WebSocket.OPEN) return false;
        p.client.send(JSON.stringify({ jsonrpc: '2.0', ...d.frame }));
        d.delivered += 1;
        return true;
      }
      return false;
    },
    cut: (): void => { for (const p of [...pairs]) p.kill(); },
    /** 只掐断第 no 条连接（双客户端：掐其中一个）。当前连着的连接序号见 connNos()。 */
    cutConn: (no: number): void => { for (const p of [...pairs]) if (p.no === no) p.kill(); },
    connNos: (): number[] => [...pairs].map(p => p.no).sort((a, b) => a - b),
    refuse: (on: boolean): void => { refusing = on; },
    /** 上行里这个方法被转发了几次。 */
    countUp: (method: string): number => upstreamCalls.filter(c => c.method === method).length,
    connections: (): number => pairs.size,
    upstreamIdle: (timeoutMs = 10_000): Promise<void> => new Promise<void>((resolve, reject) => {
      if (outstanding.size === 0) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error(`等待超时: 代理的上行请求还有 ${outstanding.size} 条没有应答`)), timeoutMs);
      idleWaiters.push(() => { clearTimeout(timer); resolve(); });
    }),
    close: (): Promise<void> => new Promise<void>(r => { for (const p of [...pairs]) p.kill(); wss.close(() => r()); }),
  };
}
export type FaultProxy = Awaited<ReturnType<typeof faultProxy>>;

// ---------- 进程内引擎 ----------

export interface BootOpts extends StartMinisdOpts {
  /** 给了就建一个指向它的 provider 并设为默认（引擎用真实的 OpenAI 兼容客户端请求它）。 */
  llm?: GatedLlm;
  /** 起之前往数据根里铺文件（MCP 配置等）。 */
  seed?: (dir: string) => void;
}

/**
 * 进程内起一个真实引擎（DESKMINIS_TEST=1，不用假 provider）。
 * restart()：在同一数据根上有序关停再起（新代次、新 token；端口沿用数据根里记着的那个，被占时换一个）。
 * 有序关停会先了结权限卡、把 run 收尾成 cancelled / shutdown；要得到 interrupted 与审批过期必须强杀进程（spawnEngine + killTree）。
 */
export async function bootEngine(opts: BootOpts = {}) {
  const { llm, seed, ...startOpts } = opts;
  const dataDir = startOpts.dataDir ?? mkdtempSync(join(tmpdir(), 'dm-f06-'));
  process.env.DESKMINIS_TEST = '1';
  delete process.env.DESKMINIS_FAKE_PROVIDER;
  seed?.(dataDir);
  const start = (): ReturnType<typeof startMinisd> => startMinisd({ host: '127.0.0.1', port: 0, permTimeoutMs: 60_000, ...startOpts, dataDir });
  let srv = await start();
  const direct: Client[] = [];
  const connect = async (): Promise<Client> => {
    const c = rpcClient(srv.port, srv.authToken);
    await c.ready;
    direct.push(c);
    return c;
  };
  if (llm) {
    const c = await connect();
    const prov = (await c.call('provider.instances.create', { name: 'f06-gated', kind: 'ollama', baseUrl: llm.baseUrl, modelId: 'f06-gated' })).result;
    const r = await c.call('provider.setDefault', { id: prov.id });
    if (r.error) throw new Error(`设默认 provider 失败: ${r.error.message}`);
    c.close();
  }
  const engine = {
    dataDir,
    get port(): number { return srv.port; },
    get token(): string { return srv.authToken; },
    /** 渲染端 minisdInfo 的返回值（当前这一代的端口与 token）。 */
    info: (): { port: number; token: string; alive: boolean } => ({ port: srv.port, token: srv.authToken, alive: true }),
    /** 直连引擎的原始客户端（run-ledger-fixture 的 rpcClient）。 */
    connect,
    restart: async (): Promise<void> => {
      for (const c of direct.splice(0)) c.close();
      await srv.close();
      srv = await start();
    },
    close: async (): Promise<void> => {
      for (const c of direct.splice(0)) c.close();
      await srv.close();
    },
  };
  return engine;
}
export type BootedEngine = Awaited<ReturnType<typeof bootEngine>>;

/**
 * 握手永远不应答的本地 MCP 服务：chat.prompt 卡在连 MCP 那一步（run 停在 starting），直到启动超时，不理会 abort
 *（F05 的 M8 / M15 用的同一个办法）。返回往数据根里铺配置的 seed 与关掉它的函数。
 * release()：让挂着的握手立刻失败（连接被掐）——MCP 连接失败由引擎内部消化，run 随即照常起跑。
 */
export async function hangingMcp(startupTimeoutSeconds: number): Promise<{ seed: (dir: string) => void; release(): void; close(): Promise<void> }> {
  let released = false;
  // 放开之后的请求当场回 500：客户端若换一种传输再试一次，不会又挂住
  const server = createServer((req, res) => { if (released) { res.writeHead(500).end(); return; } req.resume(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return {
    seed: dir => {
      mkdirSync(join(dir, 'mcp-servers'), { recursive: true });
      writeFileSync(join(dir, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { hang: { url, startupTimeoutSeconds } } }), 'utf8');
    },
    release: () => { released = true; server.closeAllConnections(); },
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** 走权限卡的写入：技能目录的写要问（data-gate.ts），放行前不落盘。这是 file_write 的入参。 */
export const skillWriteInput = (name: string, content = 'x'): Record<string, unknown> =>
  ({ path: `/var/minis/skills/f06/${name}`, content, tool_title: `写 ${name}` });
/** 上面那次写入落盘后的宿主路径。 */
export const skillFile = (dataDir: string, name: string): string => join(dataDir, 'skills', 'f06', name);

// ---------- 带游标的客户端（与渲染端 RpcClient 用同一个 StreamTracker） ----------

export interface TailView { runId: string; sessionId: string; text: string; thinking: string }

/**
 * 真实 ws 客户端，入序帧交给 shared 的 StreamTracker：去重、空洞触发续传、同步期间扣帧。
 * 它自己按 §4.3 的表把 run 事件折叠成各 run 的尾巴、把权限广播折叠成待批卡集合——这份折叠与引擎的 LiveTails 是两份独立实现，
 * 用例拿「经故障代理的客户端」与「直连的参照客户端」的折叠结果、以及引擎快照里的 live 互相比对。
 *
 * attach()：手动同步一轮（缺省带游标）。空洞 / 别的代次的帧会自动触发同步；settled() 在没有同步在跑时兑现。
 * reconnect()：换一条新套接字（保留游标）再同步——旧套接字晚到的帧一律不认。
 */
export function streamClient(port: number, token: string) {
  const tracker = new StreamTracker();
  let sock = wireClient(port, token);
  let sockNo = 1;
  /** 全部通知帧（跨套接字，含被丢弃的重复帧），按到达顺序。 */
  const notifications: WireFrame[] = [];
  /** 实际应用的入序帧，按应用顺序。 */
  const applied: EventFrame[] = [];
  /** 每装一次快照记一笔：水位、此前已应用了几条。appliedSeqs 的连续性按它分段核对。 */
  const snapshotMarks: { lastSeq: number; appliedBefore: number }[] = [];
  /** 快照水位之前、作为 uncovered 交付的帧。 */
  const uncovered: EventFrame[] = [];
  const attaches: { mode: 'resume' | 'snapshot'; reason?: SnapshotReason; accepted: boolean; lastSeq: number; events?: number }[] = [];
  const results: AttachResult[] = [];
  const tails = new Map<string, TailView & { generation: number; epoch: number; seq: number }>();
  const cards = new Map<string, PendingPermissionView | { requestId: string; req: unknown; meta: unknown }>();
  let runs: any[] = [];
  const errors: unknown[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  let syncing = 0;

  const fold = (f: EventFrame): void => {
    const p = f.params as any;
    if (f.method === 'permission.request') { cards.set(p.requestId, { requestId: p.requestId, req: p.req, meta: p.meta }); return; }
    if (f.method === 'permission.resolved') { cards.delete(p.requestId); return; }
    if (f.method !== 'chat.event' || !p?.run || !p?.event) return;
    const e = p.event;
    if (e.kind === 'turnEnd' || e.kind === 'error') { tails.delete(p.run.id); return; }
    const t = tails.get(p.run.id) ?? { runId: p.run.id, sessionId: p.sessionId, generation: p.run.generation, epoch: p.run.epoch, text: '', thinking: '', seq: f.ev.seq };
    if (e.kind === 'textDelta') t.text += e.text;
    else if (e.kind === 'thinkingDelta') t.thinking += e.text;
    else if (e.kind === 'retry' || e.kind === 'fallback' || e.kind === 'messagePersisted') { t.text = ''; t.thinking = ''; }
    t.seq = f.ev.seq;
    tails.set(p.run.id, t);
  };
  const apply = (f: EventFrame): void => { applied.push(f); fold(f); };

  const wire = (s: WireClient, no: number): void => {
    s.onNotify(msg => {
      if (no !== sockNo) return; // 旧套接字晚到的帧
      notifications.push(msg);
      if (!isEventStamp(msg.ev)) return;
      const r = tracker.offer({ method: msg.method!, params: msg.params, ev: msg.ev });
      for (const f of r.deliver) apply(f);
      if (r.need) void attach({ forceSnapshot: r.need === 'snapshot' }).catch(e => { errors.push(e); });
    });
  };
  wire(sock, sockNo);

  async function attachOnce(o: { sessionId?: string; forceSnapshot?: boolean; newConnection?: boolean }): Promise<AttachResult> {
    for (let round = 0; round < 5; round++) {
      const resume = tracker.begin({ newConnection: o.newConnection === true && round === 0, forceSnapshot: o.forceSnapshot === true || round >= 2 });
      const res = await sock.call('state.attach', { ...(resume ? { resume } : {}), ...(o.sessionId ? { sessionId: o.sessionId } : {}), protocol: 1 });
      if (res.error) throw new Error(`state.attach 失败: ${res.error.message}`);
      const r = res.result as AttachResult;
      if (!isAttachResult(r)) throw new Error('state.attach 的应答形状不对');
      const out = tracker.settle(r);
      results.push(r);
      attaches.push({ mode: r.mode, ...(r.mode === 'snapshot' ? { reason: r.reason } : { events: r.events.length }), accepted: out.accepted, lastSeq: r.lastSeq });
      if (out.accepted) {
        if (r.mode === 'snapshot') {
          snapshotMarks.push({ lastSeq: r.snapshot.lastSeq, appliedBefore: applied.length });
          tails.clear();
          for (const t of r.snapshot.live) tails.set(t.runId, { runId: t.runId, sessionId: t.sessionId, generation: t.generation, epoch: t.epoch, text: t.text, thinking: t.thinking, seq: t.seq });
          cards.clear();
          for (const c of r.snapshot.pendingPermissions) cards.set(c.requestId, c);
          runs = r.snapshot.runs;
          uncovered.push(...out.uncovered);
        } else {
          for (const f of out.replay) apply(f);
          // 用应答里的权威值校正待批卡
          const ids = new Set(r.pendingPermissions.map(c => c.requestId));
          for (const id of [...cards.keys()]) if (!ids.has(id)) cards.delete(id);
          for (const c of r.pendingPermissions) cards.set(c.requestId, c);
          runs = r.runs;
        }
        for (const f of out.after) apply(f);
      }
      if (!out.need) return r;
      o = { ...o, forceSnapshot: out.need === 'snapshot' };
    }
    throw new Error('同步 5 轮没有对齐');
  }
  /** 串行：同一时刻最多一轮。 */
  function attach(o: { sessionId?: string; forceSnapshot?: boolean; newConnection?: boolean } = {}): Promise<AttachResult> {
    syncing += 1;
    const p = chain.then(() => attachOnce(o));
    chain = p.catch(() => undefined).finally(() => { syncing -= 1; });
    return p;
  }

  return {
    tracker, notifications, applied, attaches, results, uncovered, errors,
    get sock(): WireClient { return sock; },
    ready: sock.ready,
    call: (method: string, params?: unknown): Promise<WireFrame> => sock.call(method, params),
    attach,
    /** 换一条新套接字（旧的直接掐断），保留游标，再同步一轮。 */
    reconnect: async (p: number, tk: string, o: { sessionId?: string; forceSnapshot?: boolean } = {}): Promise<AttachResult> => {
      sock.terminate();
      sockNo += 1;
      sock = wireClient(p, tk);
      wire(sock, sockNo);
      await sock.ready;
      return attach({ ...o, newConnection: true });
    },
    /** 没有同步在跑。 */
    settled: (): boolean => syncing === 0,
    appliedSeqs: (): number[] => applied.map(f => f.ev.seq),
    /** 应用序列的连续性：每一段（两次快照之间）逐一递增，快照之后的第一条恰好是水位加一。有问题返回说明，没有返回 undefined。 */
    continuity: (): string | undefined => {
      const seqs = applied.map(f => f.ev.seq);
      const marks = [...snapshotMarks];
      let expectNext: number | undefined;
      for (let i = 0; i < seqs.length; i++) {
        while (marks.length > 0 && marks[0].appliedBefore <= i) expectNext = marks.shift()!.lastSeq + 1;
        if (expectNext !== undefined && seqs[i] !== expectNext) return `第 ${i} 条应用的是 seq ${seqs[i]}，应为 ${expectNext}`;
        expectNext = seqs[i] + 1;
      }
      return undefined;
    },
    /** 已应用的 run 事件（这个会话的）。 */
    eventsOf: (sessionId: string): any[] => applied.filter(f => f.method === 'chat.event' && (f.params as any)?.sessionId === sessionId && (f.params as any).event !== undefined).map(f => (f.params as any).event),
    tails: (): TailView[] => [...tails.values()].map(t => ({ runId: t.runId, sessionId: t.sessionId, text: t.text, thinking: t.thinking })).sort((a, b) => a.runId.localeCompare(b.runId)),
    tailOf: (sessionId: string): TailView | undefined => [...tails.values()].find(t => t.sessionId === sessionId),
    cardIds: (): string[] => [...cards.keys()].sort(),
    cards: (): any[] => [...cards.values()],
    runs: (): any[] => runs,
    close: (): void => sock.close(),
  };
}
export type StreamClient = ReturnType<typeof streamClient>;

// ---------- 在 Node 里装真实的渲染端（真实 RpcClient + 真实 store） ----------

export interface RendererOpts {
  /** 渲染端向主进程要端口与 token（preload 的 minisdInfo）。每次重连都会再问一遍。 */
  info: () => { port: number; token: string; alive?: boolean } | Promise<{ port: number; token: string; alive?: boolean }>;
  /** 重连与探测的时间参数（小退避表、startPollMs 等）。经 enableRecovery 的第二参注入，产品代码不为此留开关。 */
  policy?: Record<string, unknown>;
  /** 同一个「窗口」的 sessionStorage：重载前后传同一个 Map。 */
  storage?: Map<string, string>;
}

/**
 * 真实的渲染端：globalThis.WebSocket 换成 ws 的客户端、globalThis.window 给一个只有 minisdInfo 的桥
 *（rpc-disconnect.test.ts 的做法），vi.resetModules() 之后重新 import rpc 与 store——每次调用得到一份全新的模块实例。
 * 「重载」= close() 之后再调一次（传同一个 storage）；双客户端各调一次。
 *
 * 多个实例共用 globalThis.window：它们的 info 要指向同一个入口（同一个故障代理）。
 * unhandled()：从创建到此刻进程里出现过几次未处理的拒绝（掐线类用例结尾断言它为 0）。
 */
export async function rendererOn(o: RendererOpts) {
  const g = globalThis as any;
  const { vi } = await import('vitest');
  const mem = o.storage ?? new Map<string, string>();
  const win = { deskminis: { minisdInfo: async () => o.info() } };
  g.WebSocket = WebSocket;
  g.window = win;
  g.sessionStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
  };
  vi.resetModules();
  const { rpc } = await import('../src/renderer/src/rpc');
  const { createPinia, setActivePinia } = await import('pinia');
  const { useChat } = await import('../src/renderer/src/stores/chat');
  // 时间参数与定时器在测试侧注入：包一层 enableRecovery。定时器记下来，close() 时全部清掉，不留到别的用例里
  let closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const enable = rpc.enableRecovery.bind(rpc);
  rpc.enableRecovery = (hooks, opts) => enable(hooks, {
    ...opts,
    policy: { delaysMs: [20, 20, 40, 40, 80, 80, 160, 160], jitter: 0, probeIdleMs: 0, ...opts?.policy, ...o.policy },
    timers: {
      set: (fn, ms) => {
        if (closed) return undefined;
        const h = setTimeout(() => { timers.delete(h); if (!closed) fn(); }, ms);
        timers.add(h);
        return h;
      },
      clear: h => { if (h !== undefined) { clearTimeout(h as ReturnType<typeof setTimeout>); timers.delete(h as ReturnType<typeof setTimeout>); } },
    },
  });
  // 数在途的调用（只为下面的 quiet()）：返回给调用方的还是原来那个 promise
  let inflight = 0;
  const call = rpc.call.bind(rpc);
  rpc.call = ((method: string, params?: unknown) => {
    inflight += 1;
    const p = call(method, params);
    const done = (): void => { inflight -= 1; };
    p.then(done, done);
    return p;
  }) as typeof rpc.call;
  /**
   * 渲染端静下来了：没有在途的调用，而且让出事件循环之后仍然没有。
   * store 里有不少一个接一个的调用（open() 取完消息再取技能、注释、附件、工作区），上一个的应答到了、下一个才发；
   * 只看「此刻没有在途」会在两个调用之间的空档里误判。应答之后紧接着发起的调用在同一轮微任务里就算进来了，
   * 所以让出一轮宏任务再看、连续几轮都是零才算。掐线类用例在掐线前先等它：免得把「掐线那一刻恰好在途的
   * void refreshX()」这类没人接的拒绝算进来（设计 §9 风险 16）——要测在途调用的用例自己指定在途的是哪一个。
   */
  const quiet = async (timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (let stable = 0; stable < 3;) {
      if (Date.now() > deadline) throw new Error(`等待超时: 渲染端还有 ${inflight} 个在途调用`);
      if (inflight > 0) { stable = 0; await new Promise<void>(r => setTimeout(r, 2)); continue; }
      await new Promise<void>(r => setImmediate(r));
      stable = inflight === 0 ? stable + 1 : 0;
    }
  };
  let unhandled = 0;
  const reasons: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled += 1; reasons.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const pinia = createPinia();
  setActivePinia(pinia);
  const chat = useChat(pinia);
  await chat.init();
  return {
    chat, rpc, storage: mem,
    unhandled: (): number => unhandled,
    unhandledReasons: (): unknown[] => reasons,
    /**
     * 渲染端静下来了：没有在途的调用，而且让出事件循环之后仍然没有。
     * store 里有不少一个接一个的调用（open() 取完消息再取技能、注释、附件、工作区），上一个的应答到了、下一个才发；
     * 只看「此刻没有在途」会在两个调用之间的空档里误判。应答之后紧接着发起的调用在同一轮微任务里就算进来了，
     * 所以让出一轮宏任务再看、连续几轮都是零才算。掐线类用例在掐线前先等它：免得把「掐线那一刻恰好在途的
     * void refreshX()」这类没人接的拒绝算进来（设计 §9 风险 16）——要测在途调用的用例自己指定在途的是哪一个。
     */
    quiet,
    /**
     * 关掉这个渲染端（页面没了）。先摘掉全部广播处理器（晚到的广播不再触发新的调用）、等在途的调用落定，再掐套接字——
     * 不然收尾那一刻恰好在途的 void refreshX() 会变成没人接的拒绝，算到别的用例头上。
     * abrupt：不等（在途的调用就是用例要的，比如挂在连 MCP 上的 chat.prompt）。
     */
    close: async (o: { abrupt?: boolean } = {}): Promise<void> => {
      if (closed) return;
      (rpc as unknown as { handlers: Map<string, unknown> }).handlers.clear();
      if (!o.abrupt) { try { await quiet(5000); } catch { /* 等不到就照掐 */ } }
      closed = true;
      for (const h of timers) clearTimeout(h);
      timers.clear();
      const ws = (rpc as unknown as { ws?: { close(): void; terminate?: () => void } }).ws;
      try { if (typeof ws?.terminate === 'function') ws.terminate(); else ws?.close(); } catch { /* 已关 */ }
      // 掐线带来的拒绝（abrupt 时在途的那个调用）在下一轮里落定，等它过去再摘计数器
      await new Promise<void>(r => setTimeout(r, 0));
      await new Promise<void>(r => setImmediate(r));
      process.off('unhandledRejection', onUnhandled);
    },
  };
}
export type Renderer = Awaited<ReturnType<typeof rendererOn>>;

export { waitFor };
