/**
 * F11A 引擎级夹具（文件名不匹配 *.test.ts）：同一进程里起两个真实的 minisd（各用一个临时数据根），
 * 经两边的本机连接真调 remote.pair.begin / remote.pair.join 配对，连接走真实的 ?ch=1 加密通道。
 * 另有原始 TCP 转发器 tcpRelay：按方向计字节、受控地扣住与放行、掐断、解析 WebSocket 帧（客户端方向解掩码）。
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { expect } from 'vitest';
import { startMinisd } from '../src/minisd/index';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import type { AttachmentStatusResult, AttachmentView } from '../src/shared/attachments';
import { waitFor } from './att-util';
import { catalogFixtureF01R, jsonResponse } from './runtime-model-fixture';

export interface RpcClient {
  call<T = any>(method: string, params?: unknown): Promise<T>;
  notifications: Array<{ method: string; params: any }>;
  close(): void;
}

export function wsConnect(url: string): Promise<RpcClient> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let idc = 0;
    const pending = new Map<number, (m: any) => void>();
    const notifications: RpcClient['notifications'] = [];
    ws.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
      else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
    });
    ws.on('open', () => res({
      notifications,
      call: (method: string, params?: unknown) => new Promise((resolve, reject) => {
        const id = ++idc;
        pending.set(id, m => m.error ? reject(new Error(String(m.error.message ?? JSON.stringify(m.error)))) : resolve(m.result));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      }),
      close: () => { try { ws.close(); } catch { /* 已关 */ } },
    }));
    ws.on('error', rej);
  });
}

function writeFakeProviders(dir: string): void {
  writeFileSync(join(dir, 'providers.json'), JSON.stringify({
    providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }],
    defaultProviderId: '__fake__',
  }, null, 2), 'utf8');
}

// ---------- 本地假 OpenAI 端点 ----------

export interface MockOpenAI {
  /** 假端点收到的每个请求（按到达顺序）。 */
  hits: Array<{ url: string; body: Record<string, any> }>;
  /** 目录夹具里各「服务商」的 api 地址（保留域名；经改写后的 fetch 落到本地假端点）。 */
  api(vendor: string): string;
  /** 在一个还没启动的数据根里落一份新鲜的模型目录缓存：vendor-a 的 shared-model 是目录里确认收图片的模型。 */
  seedCatalog(dir: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * 做法同 tests/runtime-model-e2e.test.ts：回环地址不参与目录 api 匹配，夹具里的服务商 api 用保留域名（.test 不解析）；
 * 真 Provider 构造时取全局 fetch，这里只把这个域名改写回本地假端点——请求仍是真 HTTP，改写没生效时域名解析失败、用例变红。
 */
export async function mockOpenAI(): Promise<MockOpenAI> {
  const hits: MockOpenAI['hits'] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      hits.push({ url: String(req.url), body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '收到' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const host = 'f11a-mock.test';
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) =>
    realFetch(typeof input === 'string' ? input.replace(`http://${host}:${port}/`, `http://127.0.0.1:${port}/`) : input as never, init as never)) as typeof fetch;
  const api = (vendor: string): string => `http://${host}:${port}/${vendor}/v1`;
  return {
    hits, api,
    async seedCatalog(dir) {
      const seed = new ModelCatalog(join(dir, 'models-dev-cache.json'), async () => jsonResponse(catalogFixtureF01R({ vendorA: api('vendor-a'), vendorB: api('vendor-b'), tie: api('tie') })));
      if (!(await seed.refresh(true))) throw new Error('模型目录夹具没有写进缓存');
    },
    close: () => new Promise<void>(r => { globalThis.fetch = realFetch; server.close(() => r()); }),
  };
}

/** 发一条消息并等这一轮结束（turnEnd 或 error）；返回这一轮的事件。 */
export async function promptAndWait(local: RpcClient, params: { sessionId: string } & Record<string, unknown>, timeoutMs = 10000): Promise<any[]> {
  const mark = local.notifications.length;
  const mine = (): any[] => local.notifications.slice(mark).filter(n => n.method === 'chat.event' && n.params?.sessionId === params.sessionId && n.params.event != null).map(n => n.params.event);
  await local.call('chat.prompt', params);
  await waitFor('这一轮结束', () => mine().some(ev => ev?.kind === 'turnEnd' || ev?.kind === 'error'), timeoutMs);
  return mine();
}

/** 请求体里全部 image_url 的地址。 */
export function imageUrlsOf(body: Record<string, any>): string[] {
  const out: string[] = [];
  for (const m of (body.messages ?? []) as Array<{ content: unknown }>) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type?: string; image_url?: { url?: string } }>) if (part?.type === 'image_url') out.push(String(part.image_url?.url));
  }
  return out;
}

// ---------- 原始 TCP 转发器 ----------

export type Dir = 'c2s' | 's2c';
export interface WsFrame { opcode: number; payload: Buffer }
export interface Relay {
  readonly port: number;
  readonly host: string;
  /** 转发器从这个方向的来源一侧收到的累计字节数（含被扣住还没转发的）。 */
  bytes(dir: Dir): number;
  /** 这个方向累计收到的字节越过 threshold 之后扣住数据（越界的那一段也不转发）；返回的 Promise 在扣住那一刻兑现。 */
  holdAfter(dir: Dir, threshold: number): Promise<void>;
  /** 把扣住的字节照常转发（客户端一侧已经关了也照发，只要目标一侧还开着），并解除扣留。 */
  release(): void;
  /** 销毁全部连接两端的套接字。被扣住的字节丢弃。 */
  cut(): void;
  /** 至今接受过的客户端连接数。 */
  accepted(): number;
  /** 两个方向连续 ms 毫秒没有新字节时兑现。 */
  quiet(ms: number, timeoutMs?: number): Promise<void>;
  /** 按 RFC 6455 解析这个方向上全部连接的帧（跳过 HTTP 升级头；客户端方向解掩码）。按转发器收到的算。 */
  frames(dir: Dir): WsFrame[];
  /** 这个方向上收到的全部原始字节（各连接依次拼接）。 */
  raw(dir: Dir): Buffer;
  close(): Promise<void>;
}

interface RelayConn { client: Socket; target: Socket; chunks: Record<Dir, Buffer[]>; held: Record<Dir, Buffer[]>; targetOpen: boolean; clientOpen: boolean }

/** 在 listenHost:listenPort 上监听，转发到 127.0.0.1:targetPort。 */
export function tcpRelay(targetPort: number, listenHost: string, listenPort: number): Promise<Relay> {
  const conns: RelayConn[] = [];
  const total: Record<Dir, number> = { c2s: 0, s2c: 0 };
  const hold: Record<Dir, { threshold: number; fired: boolean; resolve?: () => void } | undefined> = { c2s: undefined, s2c: undefined };
  const holding: Record<Dir, boolean> = { c2s: false, s2c: false };
  let lastActivity = Date.now();
  let acceptedCount = 0;

  const forward = (c: RelayConn, dir: Dir, data: Buffer): void => {
    const dst = dir === 'c2s' ? c.target : c.client;
    const open = dir === 'c2s' ? c.targetOpen : c.clientOpen;
    if (open) { try { dst.write(data); } catch { /* 对面已关 */ } }
  };
  const onData = (c: RelayConn, dir: Dir, data: Buffer): void => {
    lastActivity = Date.now();
    total[dir] += data.length;
    c.chunks[dir].push(data);
    const h = hold[dir];
    if (h && !h.fired && total[dir] > h.threshold) { h.fired = true; holding[dir] = true; h.resolve?.(); }
    if (holding[dir]) { c.held[dir].push(data); return; }
    forward(c, dir, data);
  };

  const server: Server = createServer(client => {
    acceptedCount++;
    const target = connect({ host: '127.0.0.1', port: targetPort });
    const c: RelayConn = { client, target, chunks: { c2s: [], s2c: [] }, held: { c2s: [], s2c: [] }, targetOpen: true, clientOpen: true };
    conns.push(c);
    client.on('data', d => onData(c, 'c2s', d as Buffer));
    target.on('data', d => onData(c, 's2c', d as Buffer));
    // 一侧关了就关另一侧；但 c2s 方向有被扣住的字节时先不关目标侧，等 release() 把它们发完
    client.on('close', () => { c.clientOpen = false; if (c.held.c2s.length === 0) { try { target.destroy(); } catch { /* 已关 */ } } });
    target.on('close', () => { c.targetOpen = false; try { client.destroy(); } catch { /* 已关 */ } });
    client.on('error', () => { /* close 事件里处理 */ });
    target.on('error', () => { /* close 事件里处理 */ });
  });

  const parseFrames = (buf: Buffer): WsFrame[] => {
    const out: WsFrame[] = [];
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return out;
    let p = headerEnd + 4;
    while (p + 2 <= buf.length) {
      const opcode = buf[p] & 0x0f;
      const masked = (buf[p + 1] & 0x80) !== 0;
      let len = buf[p + 1] & 0x7f;
      let q = p + 2;
      if (len === 126) { if (q + 2 > buf.length) break; len = buf.readUInt16BE(q); q += 2; }
      else if (len === 127) { if (q + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(q)); q += 8; }
      let mask: Buffer | undefined;
      if (masked) { if (q + 4 > buf.length) break; mask = buf.subarray(q, q + 4); q += 4; }
      if (q + len > buf.length) break;
      const payload = Buffer.from(buf.subarray(q, q + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      out.push({ opcode, payload });
      p = q + len;
    }
    return out;
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      resolve({
        port: listenPort, host: listenHost,
        bytes: dir => total[dir],
        holdAfter(dir, threshold) {
          return new Promise<void>(res => {
            const h = { threshold, fired: false, resolve: res };
            hold[dir] = h;
            if (total[dir] > threshold) { h.fired = true; holding[dir] = true; res(); }
          });
        },
        release() {
          for (const dir of ['c2s', 's2c'] as Dir[]) {
            holding[dir] = false; hold[dir] = undefined;
            for (const c of conns) {
              const pending = c.held[dir]; c.held[dir] = [];
              for (const d of pending) forward(c, dir, d);
              if (dir === 'c2s' && !c.clientOpen) { try { c.target.end(); } catch { /* 已关 */ } }
            }
          }
        },
        cut() {
          // 扣留一并解除：之后的新连接照常转发
          for (const dir of ['c2s', 's2c'] as Dir[]) { holding[dir] = false; hold[dir] = undefined; }
          for (const c of conns) {
            c.held.c2s = []; c.held.s2c = [];
            try { c.client.destroy(); } catch { /* 已关 */ }
            try { c.target.destroy(); } catch { /* 已关 */ }
          }
        },
        accepted: () => acceptedCount,
        quiet(ms, timeoutMs = 8000) {
          const deadline = Date.now() + timeoutMs;
          return new Promise<void>((res, rej) => {
            const tick = (): void => {
              if (Date.now() - lastActivity >= ms) { res(); return; }
              if (Date.now() > deadline) { rej(new Error(`转发器在 ${timeoutMs}ms 内没有安静下来`)); return; }
              setTimeout(tick, 20);
            };
            tick();
          });
        },
        frames: dir => conns.flatMap(c => parseFrames(Buffer.concat(c.chunks[dir]))),
        raw: dir => Buffer.concat(conns.flatMap(c => c.chunks[dir])),
        close: () => new Promise<void>(res => {
          for (const c of conns) { try { c.client.destroy(); } catch { /* */ } try { c.target.destroy(); } catch { /* */ } }
          server.close(() => res());
        }),
      });
    });
  });
}

// ---------- 两个真引擎 ----------

export interface Engines {
  localA: RpcClient; localB: RpcClient;
  dirA: string; dirB: string;
  portA: number; portB: number;
  /** B 的本机 token（重启后会变）。只用来经转发器开一条明文的本机连接做抓包的正向对照。 */
  tokenB: string;
  relay?: Relay;
  /** 关掉 B 再用同一个数据根重启（端口沿用 minisd-port.json 里记的那个）。返回新的本机连接。 */
  restartB(): Promise<RpcClient>;
  closeB(): Promise<void>;
  /** 按当前的拨号方向重新配对（取消配对之后用）。 */
  pair(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * dialer='A'：A 拨 B（A 是拨号方 D，B 是监听方 L）；dialer='B' 反过来。listenPort: 0，所以只有加入方拨号。
 * relay=true（只支持 dialer='A'）：转发器监听 127.0.0.2:<B 的端口>、转发到 127.0.0.1:<B 的端口>，A 以 host 127.0.0.2 加入——
 * sync.hello 回的端口与转发器端口相同，地址簿自愈不会绕开转发器。
 * prepareB：B 启动之前在它的数据根里做的布置（比如先落一份模型目录缓存，让 B 能配一个确认收图片的实例）。
 */
export async function bootEngines(opts: { dialer: 'A' | 'B'; relay?: boolean; prepareB?: (dir: string) => void | Promise<void> }): Promise<Engines> {
  const dirA = mkdtempSync(join(tmpdir(), 'f11a-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'f11a-b-'));
  writeFakeProviders(dirA);
  writeFakeProviders(dirB);
  await opts.prepareB?.(dirB);
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';

  const a = await startMinisd({ dataDir: dirA, host: '127.0.0.1', port: 0 });
  let b = await startMinisd({ dataDir: dirB, host: '127.0.0.1', port: 0 });
  let bClosed = false;
  const localA = await wsConnect(`ws://127.0.0.1:${a.port}/?token=${a.authToken}`);
  let localB = await wsConnect(`ws://127.0.0.1:${b.port}/?token=${b.authToken}`);
  const portB = b.port;
  let relay: Relay | undefined;
  if (opts.relay) {
    if (opts.dialer !== 'A') throw new Error('relay 只支持 A 拨 B');
    relay = await tcpRelay(portB, '127.0.0.2', portB);
  }

  const engines: Engines = {
    localA, localB, dirA, dirB, portA: a.port, portB, tokenB: b.authToken, relay,
    async pair() {
      if (opts.dialer === 'A') {
        const begin = await engines.localB.call('remote.pair.begin', {});
        await localA.call('remote.pair.join', { host: relay ? relay.host : '127.0.0.1', port: relay ? relay.port : portB, pairingCode: begin.pairingCode, peerName: 'B-设备', listenPort: 0 });
      } else {
        const begin = await localA.call('remote.pair.begin', {});
        await engines.localB.call('remote.pair.join', { host: '127.0.0.1', port: a.port, pairingCode: begin.pairingCode, peerName: 'A-设备', listenPort: 0 });
      }
      const dialerLocal = opts.dialer === 'A' ? localA : engines.localB;
      await waitFor('配对后互认上线', async () => {
        const st = await dialerLocal.call('remote.status');
        return st.devices.some((d: any) => d.online === true);
      }, 8000);
    },
    async closeB() {
      if (bClosed) return;
      bClosed = true;
      engines.localB.close();
      await b.close();
    },
    async restartB() {
      await engines.closeB();
      b = await startMinisd({ dataDir: dirB, host: '127.0.0.1', port: 0 });
      bClosed = false;
      if (b.port !== portB) throw new Error(`B 重启后端口变了（${portB} → ${b.port}），转发器与地址簿对不上`);
      localB = await wsConnect(`ws://127.0.0.1:${b.port}/?token=${b.authToken}`);
      engines.localB = localB;
      engines.tokenB = b.authToken;
      return localB;
    },
    async dispose() {
      try { localA.close(); } catch { /* */ }
      try { engines.localB.close(); } catch { /* */ }
      try { await a.close(); } catch { /* */ }
      if (!bClosed) { bClosed = true; try { await b.close(); } catch { /* */ } }
      if (relay) await relay.close();
      for (const d of [dirA, dirB]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 被占用时留给系统清 */ } }
    },
  };
  await engines.pair();
  return engines;
}

// ---------- 种数据 ----------

export async function newSession(local: RpcClient, title: string): Promise<string> {
  return (await local.call('chat.sessions.create', { title })).id as string;
}

export function bucketOf(root: string, sid: string): string { return join(root, 'sessions', sid, 'attachments'); }

/** 产品路径：文件写进附件桶（与主进程的落盘位置相同），再 chat.prompt 带上它。 */
export async function seedImage(local: RpcClient, root: string, sid: string, name: string, bytes: Buffer, text = '请看这张图'): Promise<void> {
  mkdirSync(bucketOf(root, sid), { recursive: true });
  writeFileSync(join(bucketOf(root, sid), name), bytes);
  await local.call('chat.prompt', { sessionId: sid, text, providerId: '__fake__', attachments: [`attachments/${name}`] });
  // 等这一轮跑完：之后的断言不与在跑的 run 抢
  await waitFor('这一轮回复落库', async () => {
    const msgs = await local.call('chat.messages.list', { sessionId: sid });
    return msgs.some((m: any) => m.role === 'assistant');
  }, 8000);
}

function wireMessage(sid: string, parts: unknown[]): Record<string, unknown> {
  const now = Date.now();
  return {
    id: randomUUID().toUpperCase(), sessionId: sid, role: 'user', partsJson: JSON.stringify(parts),
    tokenUsageJson: null, reasoningContent: null, streamInterruptCount: 0, sortOrder: now, createdAt: now, updatedAt: now,
    originDeviceId: 'f11a-test-seed', createdLocallyAt: now,
  };
}

/** 经本机连接调 sync.push 注入一条带 mediaRef 的用户消息（文档、越界引用用它；产品没有文档入口）。不起模型请求。 */
export async function seedRef(local: RpcClient, sid: string, ref: { relativePath: string; mimeType: string; originalFileName?: string }, text = '附件'): Promise<void> {
  const parts = [{ type: 'text', value: text }, { type: 'mediaRef', value: { id: randomUUID(), ...ref } }];
  await local.call('sync.push', { sessionId: sid, payload: { messages: [wireMessage(sid, parts)], markers: [] } });
}

/** 文件放进附件桶并注入引用它的消息（不经 chat.prompt，所以不受 5MB 与图片类型的限制）。 */
export async function seedFile(local: RpcClient, root: string, sid: string, name: string, bytes: Buffer, mimeType: string): Promise<void> {
  mkdirSync(bucketOf(root, sid), { recursive: true });
  writeFileSync(join(bucketOf(root, sid), name), bytes);
  await seedRef(local, sid, { relativePath: `attachments/${name}`, mimeType });
}

/** 注入一条纯文本用户消息：不起模型请求，只触发一轮推送与附件作业。 */
export async function seedText(local: RpcClient, sid: string, text: string): Promise<void> {
  await local.call('sync.push', { sessionId: sid, payload: { messages: [wireMessage(sid, [{ type: 'text', value: text }])], markers: [] } });
}

/** 这一端配对表里（唯一的）对端指纹。 */
export async function peerFpOf(local: RpcClient): Promise<string> {
  const st = await local.call('remote.status');
  return st.devices[0].peerFingerprint as string;
}

// ---------- 断言 ----------

export async function statusOf(local: RpcClient, sid: string): Promise<AttachmentStatusResult> {
  return local.call<AttachmentStatusResult>('attachments.status', { sessionId: sid });
}

export async function itemOf(local: RpcClient, sid: string, name: string): Promise<AttachmentView | undefined> {
  return (await statusOf(local, sid)).items.find(i => i.name === name);
}

export function partsIn(root: string): Array<{ name: string; size: number }> {
  const dir = join(root, 'sync-incoming');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map(name => ({ name, size: statSync(join(dir, name)).size }));
}

/** 每个故障用例末尾都跑：没有任何可以被当作完整附件的东西。 */
export async function expectNotComplete(root: string, local: RpcClient, sid: string, name: string, size: number): Promise<void> {
  expect(existsSync(join(bucketOf(root, sid), name)), '最终路径上不该有文件').toBe(false);
  const item = await itemOf(local, sid, name);
  expect(item?.state, '状态不该是 ready').not.toBe('ready');
  expect(item?.localAvailable ?? false).toBe(false);
  await expect(local.call('attachments.read', { sessionId: sid, name })).rejects.toThrow('附件尚未同步到本机');
  const files = partsIn(root);
  expect(files.filter(f => f.name.endsWith('.stage'))).toEqual([]);
  for (const f of files.filter(x => x.name.endsWith('.part'))) expect(f.size, `${f.name} 不该是完整长度`).toBeLessThan(size);
}
