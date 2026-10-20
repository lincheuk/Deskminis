/**
 * F11B 端到端夹具（文件名不匹配 *.test.ts）：同一进程里起两到三个真实的 minisd（各用一个临时数据根），
 * 经本机连接真调 remote.pair.begin / remote.pair.join 配对，同步走真实的加密通道与真实的 sync.* 路径。
 *
 * 拨号方向是确定的：数据根预先生成身份、按指纹升序排好；配对时指纹小的一方 join 并带上自己的监听端口。
 * 这样指纹小的一方既是首次连接的拨号方（join 之后立即拨），也是重启之后主从裁决的拨号方
 * （outbound-client.ts：myFp < peerFp 者主拨）。用例因此能指名「删除端是拨号方」还是「删除端是监听方」，重启任何一端方向不变。
 *
 * 断言尽量落在物理行上（rows() 另开只读连接直接查 minis.db），不只看被测 RPC 的返回。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { startMinisd, type MinisdHandle, type StartMinisdOpts } from '../src/minisd/index';
import { StaticIdentity } from '../src/minisd/remote/pairing';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { wsConnect, type RpcClient } from './att-engines-util';
import { waitFor } from './att-util';

export { waitFor } from './att-util';
export type { RpcClient } from './att-engines-util';

export interface NodeOpts {
  /** 这台设备的时钟比真实时间快（正）或慢（负）多少毫秒。 */
  skewMs?: number;
  runStopTimeoutMs?: number;
  tombstoneSeenTtlS?: number;
  permTimeoutMs?: number;
}

export interface TestNode {
  name: string; dir: string; fp: string; port: number;
  /** 这台设备的时钟偏移（毫秒）；seedText 造消息时间戳时也用它。 */
  skewMs: number;
  /** 本机连接（每次启动换新的；notifications 从这次启动开始记）。 */
  local: RpcClient;
  running: boolean;
  call<T = any>(method: string, params?: unknown): Promise<T>;
  /** 这次启动以来收到的某个方法的全部通知。 */
  notes(method: string): any[];
  stop(): Promise<void>;
  /** 同一个数据根重启（端口沿用 minisd-port.json 里记的那个）。opts 不传沿用上一次的。 */
  restart(opts?: NodeOpts): Promise<void>;
}

const live: Array<{ node: TestNode; handle?: MinisdHandle }> = [];
const dirs: string[] = [];

/** 建 n 个临时数据根并预先生成身份，按指纹升序返回（[0] 的指纹最小，是拨号方）。 */
export function orderedDirs(n: number): Array<{ dir: string; fp: string }> {
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const out = Array.from({ length: n }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'f11b-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'providers.json'), JSON.stringify({
      providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }], defaultProviderId: '__fake__',
    }, null, 2), 'utf8');
    // DESKMINIS_TEST=1 下引擎用的就是这个按数据根取的内存凭据库，所以这里生成的身份就是引擎启动后的身份
    return { dir, fp: StaticIdentity.loadOrCreate(InMemoryVault.forDataRoot(dir)).fingerprint };
  });
  return out.sort((x, y) => (x.fp < y.fp ? -1 : 1));
}

export async function startNode(name: string, at: { dir: string; fp: string }, opts: NodeOpts = {}): Promise<TestNode> {
  let current = opts;
  const entry: { node: TestNode; handle?: MinisdHandle } = { node: undefined as unknown as TestNode };
  const boot = async (): Promise<void> => {
    const o: StartMinisdOpts = { dataDir: at.dir, host: '127.0.0.1', port: 0 };
    node.skewMs = current.skewMs ?? 0;
    if (current.skewMs !== undefined) { const skew = current.skewMs; o.now = () => Date.now() + skew; }
    if (current.runStopTimeoutMs !== undefined) o.runStopTimeoutMs = current.runStopTimeoutMs;
    if (current.tombstoneSeenTtlS !== undefined) o.tombstoneSeenTtlS = current.tombstoneSeenTtlS;
    if (current.permTimeoutMs !== undefined) o.permTimeoutMs = current.permTimeoutMs;
    const handle = await startMinisd(o);
    entry.handle = handle;
    node.port = handle.port;
    node.local = await wsConnect(`ws://127.0.0.1:${handle.port}/?token=${handle.authToken}`);
    node.running = true;
  };
  const node: TestNode = {
    name, dir: at.dir, fp: at.fp, port: 0, skewMs: 0, local: undefined as unknown as RpcClient, running: false,
    call: (method, params) => node.local.call(method, params),
    notes: method => node.local.notifications.filter(n => n.method === method).map(n => n.params),
    async stop() {
      if (!node.running) return;
      node.running = false;
      try { node.local.close(); } catch { /* 已关 */ }
      await entry.handle?.close();
    },
    async restart(next) {
      await node.stop();
      if (next) current = next;
      const before = node.port;
      await boot();
      if (node.port !== before) throw new Error(`${name} 重启后端口变了（${before} → ${node.port}），对端的地址簿对不上`);
    },
  };
  entry.node = node;
  live.push(entry);
  await boot();
  return node;
}

/** 每条用例之后调：关掉全部实例，删临时数据根（被占用时留给系统清）。 */
export async function disposeAll(): Promise<void> {
  for (const e of live.splice(0).reverse()) { try { await e.node.stop(); } catch { /* 收尾尽力 */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统 */ } }
}

async function online(node: TestNode, peerFp: string): Promise<boolean> {
  const st = await node.call('remote.status');
  return (st.devices as Array<{ peerFingerprint: string; online: boolean }>).some(d => d.peerFingerprint === peerFp && d.online === true);
}

/** 配对（或重新配对）两台设备：指纹大的 begin，指纹小的 join 并带上自己的监听端口；等两边都看到对方在线。 */
export async function pair(x: TestNode, y: TestNode): Promise<void> {
  const [lo, hi] = x.fp < y.fp ? [x, y] : [y, x];
  const begin = await hi.call('remote.pair.begin', {});
  await lo.call('remote.pair.join', { host: '127.0.0.1', port: hi.port, pairingCode: begin.pairingCode, peerName: hi.name, listenPort: lo.port });
  await waitOnline(lo, hi);
}

export async function waitOnline(x: TestNode, y: TestNode, timeoutMs = 40_000): Promise<void> {
  await waitFor(`${x.name} 与 ${y.name} 互相在线`, async () => (await online(x, y.fp)) && (await online(y, x.fp)), timeoutMs, 50);
}

/** 对 minis.db 另开只读连接直接查表（WAL 下可与运行中的引擎并存）。 */
export function rows<T = Record<string, any>>(dir: string, sql: string, ...args: unknown[]): T[] {
  const db = new Database(join(dir, 'minis.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
}
export const msgRows = (n: TestNode, sid: string): string[] =>
  rows<{ id: string }>(n.dir, 'SELECT id FROM messages WHERE session_id=? ORDER BY id', sid).map(r => r.id);
export const sessionRow = (n: TestNode, sid: string): Record<string, any> | undefined =>
  rows(n.dir, 'SELECT id, title, remote_tombstoned_at FROM sessions WHERE id=?', sid)[0];
export const regRow = (n: TestNode, sid: string): Record<string, any> | undefined =>
  rows(n.dir, 'SELECT * FROM session_lifecycle WHERE session_id=?', sid)[0];
/** 登记里各设备应当相同的列。 */
export const regCore = (n: TestNode, sid: string): unknown => {
  const r = regRow(n, sid);
  return r && { version: r.version, op_id: r.op_id, origin_device_id: r.origin_device_id, origin_at: r.origin_at };
};

export interface Digest { alive: string[]; msgs: Record<string, string[]>; registers: string[] }

/** 经本机连接取这台设备的同步面：存活会话、每个存活会话的消息 id、全部登记的头。 */
export async function digest(n: TestNode): Promise<Digest> {
  const list = await n.call('sync.list', {});
  const sessions = list.sessions as Array<{ id: string; lifecycle?: { v: number; opId: string } }>;
  const alive = sessions.map(s => s.id).sort();
  const msgs: Record<string, string[]> = {};
  for (const id of alive) {
    const p = await n.call('sync.pull', { sessionId: id });
    msgs[id] = (p.messages as Array<{ id: string }>).map(m => m.id).sort();
  }
  const registers = [
    ...((list.tombstones ?? []) as Array<{ id: string; v: number; opId: string }>).map(t => `${t.id}:${t.v}:${t.opId}`),
    ...sessions.filter(s => s.lifecycle).map(s => `${s.id}:${s.lifecycle!.v}:${s.lifecycle!.opId}`),
  ].sort();
  return { alive, msgs, registers };
}

/** 等各节点的 digest 相等，且在 quietMs 内不再变化；返回收敛后的 digest。 */
export async function settle(nodes: TestNode[], timeoutMs = 45_000, quietMs = 600): Promise<Digest> {
  const deadline = Date.now() + timeoutMs;
  let last = ''; let since = Date.now(); let lastAll: string[] = [];
  for (;;) {
    const all = await Promise.all(nodes.map(async n => JSON.stringify(await digest(n))));
    lastAll = all;
    const same = all.every(d => d === all[0]);
    if (same && all[0] === last) { if (Date.now() - since >= quietMs) return JSON.parse(all[0]) as Digest; }
    else { last = same ? all[0] : ''; since = Date.now(); }
    if (Date.now() > deadline) throw new Error(`等待收敛超时（${timeoutMs}ms）：\n${nodes.map((n, i) => `${n.name}: ${lastAll[i]}`).join('\n')}`);
    await new Promise<void>(r => setTimeout(r, 60));
  }
}

export async function newSession(n: TestNode, title: string): Promise<string> {
  return (await n.call('chat.sessions.create', { title })).id as string;
}

/** 经本机连接调 sync.push 注入一条纯文本用户消息（不起模型请求）；返回消息 id。 */
export async function seedText(n: TestNode, sid: string, text: string): Promise<string> {
  const id = randomUUID().toUpperCase();
  const now = (Date.now() + n.skewMs) / 1000;
  await n.call('sync.push', { sessionId: sid, payload: { messages: [{
    id, sessionId: sid, role: 'user', partsJson: JSON.stringify([{ type: 'text', value: text }]), tokenUsageJson: null, reasoningContent: null,
    streamInterruptCount: 0, sortOrder: 0, createdAt: now, updatedAt: now, originDeviceId: n.fp, createdLocallyAt: now,
  }], markers: [] } });
  return id;
}

/** 建一个带若干条消息的会话。 */
export async function seedSession(n: TestNode, title: string, count = 2): Promise<{ sid: string; ids: string[] }> {
  const sid = await newSession(n, title);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(await seedText(n, sid, `${title}-${i}`));
  return { sid, ids };
}

/** 这台设备上某个会话的整包载荷（等价于对端来拉时拿到的）。会话不存在或已删除时抛错。 */
export async function payloadOf(n: TestNode, sid: string): Promise<Record<string, any>> {
  return n.call('sync.pull', { sessionId: sid });
}

/** 经本机连接注入一个载荷：重复、乱序、伪造的墓碑，或从没配过对的旧副本。 */
export function inject(n: TestNode, sid: string, payload: unknown): Promise<any> {
  return n.call('sync.push', { sessionId: sid, payload });
}

export async function aliveIds(n: TestNode): Promise<string[]> {
  return ((await n.call('chat.sessions.list')) as Array<{ id: string }>).map(s => s.id);
}
export async function retained(n: TestNode): Promise<Array<Record<string, any>>> {
  return n.call('chat.sessions.listRetained', {});
}
export async function auditTypes(n: TestNode, sid: string): Promise<Array<{ type: string; payload: any }>> {
  const r = await n.call('audit.list', { sessionId: sid, limit: 200 });
  return (r.rows as Array<Record<string, any>>).map(x => ({ type: (x.eventType ?? x.event_type ?? x.type) as string, payload: x.payload }));
}
export const deleteSession = (n: TestNode, sid: string): Promise<any> => n.call('chat.sessions.delete', { sessionId: sid, confirm: true });
