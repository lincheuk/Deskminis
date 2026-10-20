/**
 * Q20：观察真实引擎交给 RpcServer 的方法表与事件日志。
 * startCapturedEngine 可调业务；startAccessProbeEngine 的方法表只供访问探测。
 * 探测引擎在真实 register 包守卫之前，把零形参主体换成停点；其余主体一读参数就停。
 * 已配对指纹须由另一台业务引擎走真实配对，关掉句柄后在同一临时根上起探测引擎。
 * 不屏蔽引擎原有的启动预热。导出上的 spy 保留原类，避免 vi.mock 的模块加载次序问题。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { AuthMode, RpcConnection, RpcMethods } from '../src/minisd/rpc/server';
import type { MinisdHandle, StartMinisdOpts } from '../src/minisd/index';
import type { PairBeginResult } from '../src/shared/pairing';

interface Captured { methods: RpcMethods; events: unknown }

export interface CapturedEngine {
  /** 只供访问探测；pair/unpair 不可调用。 */
  accessProbeOnly: boolean;
  handle: MinisdHandle;
  root: string;
  /** 引擎交给 RpcServer 的那张方法表（同一个对象）。 */
  methods: RpcMethods;
  /** 构造 RpcServer 时带的 events。 */
  events: unknown;
  /** 这台引擎装配期间构造了几个 RpcServer。 */
  servers: number;
  /** 业务方法名（remote.* 配对协议以外的全部），已排序。 */
  businessNames: string[];
  /** 走一遍真实配对（本机 remote.pair.begin → 配对连接 remote.pair.complete），返回对端指纹。 */
  pair(): Promise<string>;
  /** 真实的 remote.unpair。 */
  unpair(peerFingerprint: string): Promise<void>;
  /** 关引擎，删掉临时数据根，环境变量还原。可重复调用。 */
  close(): Promise<void>;
}

/** 起引擎失败时的记录：抛出的错误，失败之前构造了几个 RpcServer。 */
export interface FailedStart { error: unknown; servers: number; root: string; cleanup(): void }

function withTestEnv(): () => void {
  const before = process.env.DESKMINIS_TEST;
  process.env.DESKMINIS_TEST = '1';
  return () => { if (before === undefined) delete process.env.DESKMINIS_TEST; else process.env.DESKMINIS_TEST = before; };
}

/** 起一次引擎，期间记下它构造的每个 RpcServer 的实参。 */
async function startWatched(root: string, opts: StartMinisdOpts | undefined): Promise<{ handle?: MinisdHandle; error?: unknown; seen: Captured[] }> {
  const serverNs = await import('../src/minisd/rpc/server');
  const { startMinisd } = await import('../src/minisd/index');
  const Original = serverNs.RpcServer;
  const seen: Captured[] = [];
  const spy = vi.spyOn(serverNs, 'RpcServer').mockImplementation(function (...args: ConstructorParameters<typeof Original>) {
    seen.push({ methods: args[0], events: args[3]?.events });
    // 被 new 调用时返回对象，new 的结果就是它：照常构造原来的类
    return new Original(...args);
  } as never);
  Object.defineProperty(spy, Symbol.hasInstance, { value: (x: unknown) => x instanceof Original, configurable: true });
  try {
    // 保留可观察的 getter，避免辅助的对象展开先消费注入值。
    const startOpts: StartMinisdOpts = { dataDir: root, host: '127.0.0.1', port: 0 };
    Object.defineProperties(startOpts, Object.getOwnPropertyDescriptors(opts ?? {}));
    return { handle: await startMinisd(startOpts), seen };
  } catch (error) {
    return { error, seen };
  } finally {
    spy.mockRestore();
  }
}

/** 在临时数据根上起一台真实引擎，并交出它装配出来的 RPC 方法表。 */
export async function startCapturedEngine(opts?: StartMinisdOpts): Promise<CapturedEngine> {
  return captureEngine(opts, false);
}

/** 方法表只供访问探测，不可用来调业务。 */
export async function startAccessProbeEngine(opts?: StartMinisdOpts): Promise<CapturedEngine> {
  return captureEngine(opts, true);
}

async function captureEngine(opts: StartMinisdOpts | undefined, accessProbeOnly: boolean): Promise<CapturedEngine> {
  const root = opts?.dataDir ?? mkdtempSync(join(tmpdir(), 'dm-engine-assembly-'));
  const restoreEnv = withTestEnv();
  const { RpcMethodRegistry } = await import('../src/minisd/rpc/registry');
  const register = RpcMethodRegistry.prototype.register;
  // 这五个带 conn 的主体不读 params；保留主体内访问检查，在第一项依赖调用处停住。
  const { CheckpointStore } = await import('../src/minisd/checkpoints/store');
  const { PairingService } = await import('../src/minisd/remote/pairing');
  const { ChatStore } = await import('../src/minisd/store/chat-store');
  const dependencies: Record<string, [object, string]> = {
    'checkpoints.usage': [CheckpointStore.prototype, 'prune'],
    'remote.pair.begin': [PairingService.prototype, 'policy'],
    'remote.pair.cancel': [PairingService.prototype, 'cancelPairing'],
    'remote.status': [PairingService.prototype, 'listWithAddress'],
    'sync.list': [ChatStore.prototype, 'listSyncedSessions'],
  };
  const diagnostics = await import('../src/minisd/diagnostics');
  const createDiagnostics = diagnostics.createDiagnosticsMethods;
  // dryRun 的第一句解构 deps；通过依赖停点保留前面的本机检查，不执行预检正文。
  const diagnosticStop = accessProbeOnly ? vi.spyOn(diagnostics, 'createDiagnosticsMethods').mockImplementation(deps =>
    createDiagnostics(new Proxy(deps, { get: stop }))) : undefined;
  const withDependencyStop = (name: string, handler: RpcMethods[string]): RpcMethods[string] => {
    const dependency = dependencies[name];
    if (!dependency) return handler;
    return async (params, conn) => {
      const spy = vi.spyOn(dependency[0] as never, dependency[1] as never).mockImplementation(stop);
      try { return await handler(params, conn); } finally { spy.mockRestore(); }
    };
  };
  const registration = accessProbeOnly ? vi.spyOn(RpcMethodRegistry.prototype, 'register').mockImplementation(function (this: InstanceType<typeof RpcMethodRegistry>, group, access) {
    const stopped = Object.fromEntries(Object.entries(group).map(([name, handler]) => [name, handler.length === 0 ? stop : withDependencyStop(name, handler)]));
    register.call(this, stopped, access);
  }) : undefined;
  let started: Awaited<ReturnType<typeof startWatched>>;
  try { started = await startWatched(root, opts); } finally { registration?.mockRestore(); diagnosticStop?.mockRestore(); }
  const { handle, error, seen } = started;
  if (!handle) { restoreEnv(); rmSync(root, { recursive: true, force: true }); throw error; }
  if (seen.length === 0) {
    await handle.close(); restoreEnv();
    throw new Error('引擎起来了，却没有看到它构造 RpcServer（rpc/server 的 RpcServer 导出改名或换了建法？）');
  }
  const { methods, events } = seen[seen.length - 1];
  let closed: Promise<void> | undefined;
  return {
    accessProbeOnly, handle, root, methods, events, servers: seen.length,
    businessNames: Object.keys(methods).filter(n => !n.startsWith('remote.')).sort(),
    pair: async () => {
      if (accessProbeOnly) throw new Error('访问探测引擎不可调配对业务');
      const { StaticIdentity } = await import('../src/minisd/remote/pairing');
      const peer = new StaticIdentity();
      const begin = await methods['remote.pair.begin']({}, probeConnection('local')) as PairBeginResult;
      await methods['remote.pair.complete']({
        pairingCode: begin.pairingCode, peerPublicKey: Buffer.from(peer.publicKey).toString('base64'), peerFingerprint: peer.fingerprint,
      }, probeConnection('pairing'));
      return peer.fingerprint;
    },
    unpair: async fp => { if (accessProbeOnly) throw new Error('访问探测引擎不可调撤销业务'); await methods['remote.unpair']({ peerFingerprint: fp }, probeConnection('local')); },
    close: () => (closed ??= (async () => {
      try { await handle.close(); }
      finally { restoreEnv(); try { rmSync(root, { recursive: true, force: true }); } catch { /* 被占用时留给系统清 */ } }
    })()),
  };
}

/** 预期起不来的引擎：返回抛出的错误，以及失败之前构造了几个 RpcServer。
 *  装配半途失败时引擎自己只放数据根锁（startMinisd 的外壳），已经打开的库与已经监听的桥都留着——产品里这种失败之后进程就退了。
 *  测试进程不退，这里替它关掉：不然临时数据根删不掉，桥的命名管道也一直占着。 */
export async function startExpectingFailure(opts?: StartMinisdOpts): Promise<FailedStart> {
  const dbMod = await import('../src/minisd/store/db');
  const { BridgeServer } = await import('../src/minisd/bridge/server');
  const openDb = dbMod.openDb;
  const opened: { close(): void }[] = [];
  const dbSpy = vi.spyOn(dbMod, 'openDb').mockImplementation((...a: Parameters<typeof openDb>) => { const db = openDb(...a); opened.push(db); return db; });
  const bridgeSpy = vi.spyOn(BridgeServer.prototype, 'listen');
  const root = opts?.dataDir ?? mkdtempSync(join(tmpdir(), 'dm-engine-assembly-'));
  const restoreEnv = withTestEnv();
  const { handle, error, seen } = await startWatched(root, opts);
  restoreEnv();
  const bridges = bridgeSpy.mock.contexts as { close(): Promise<void> }[];
  dbSpy.mockRestore(); bridgeSpy.mockRestore();
  if (handle) { await handle.close(); rmSync(root, { recursive: true, force: true }); throw new Error('引擎起来了，预期它起不来'); }
  for (const b of bridges) { try { await b.close(); } catch { /* 尽力 */ } }
  for (const db of opened) { try { db.close(); } catch { /* 尽力 */ } }
  return { error, servers: seen.length, root, cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 被占用时留给系统清 */ } } };
}

/** 没有走真实配对的调用用它当对端指纹（引擎不认识它：remote 连接会被当成未配对）。 */
export const UNPAIRED_PEER = 'Q20-UNPAIRED-PEER';

export function probeConnection(authMode: AuthMode, onClose = (): void => {}, peerFingerprint: string = UNPAIRED_PEER): RpcConnection {
  return {
    authMode, notify: () => {}, peerFingerprint, encrypted: true,
    syncPeer: { protocolVersion: 2, caps: { attachments: true, tombstones: true } }, closeAfterReply: onClose,
  };
}

const PARAMS_READ = 'Q20_PARAMS_READ';
const stop = (): never => { throw new Error(PARAMS_READ); };
/** 读任何属性都抛的参数对象：访问检查都排在读参数之前，处理器一碰参数就停下，不往下做事。 */
export const untouchableParams = (): unknown => new Proxy({}, { get: stop, has: stop, ownKeys: stop, getOwnPropertyDescriptor: stop });

export interface AccessCell { allowed: boolean; error?: string }

/** 调一格：放行（碰到停点；正常返回另记 completed）还是被拒（记拒绝原文）。既不是放行也不是已知的拒绝就抛，不猜。 */
export async function accessResult(method: RpcMethods[string], name: string, conn: RpcConnection, completed?: string[]): Promise<AccessCell> {
  try { await method(untouchableParams(), conn); completed?.push(`${name}/${conn.authMode}`); return { allowed: true }; }
  catch (e) {
    const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    if (message === PARAMS_READ) return { allowed: true };
    if (message.includes('pairing 模式下不可用') || message.includes('需要 authMode=') || message.includes('只允许本机连接')
      || message.includes('文件检查点只能') || message.includes('取消配对') || message === 'ATT_CHANNEL_REQUIRED') return { allowed: false, error: message };
    throw new Error(`访问探测没有落在已知的访问检查或处理器正文上: ${name}: ${message}`);
  }
}

/** 整张访问表：方法名（排序）× 本机 / 配对中 / 已配对远端。remoteFingerprint 是 pair() 返回的指纹。 */
export async function accessMatrix(methods: RpcMethods, remoteFingerprint: string, completed: string[]): Promise<Record<string, Record<AuthMode, AccessCell>>> {
  const matrix: Record<string, Record<AuthMode, AccessCell>> = {};
  for (const name of Object.keys(methods).sort()) {
    const row = {} as Record<AuthMode, AccessCell>;
    for (const mode of ['local', 'pairing', 'remote'] as const) row[mode] = await accessResult(methods[name], name, probeConnection(mode, undefined, remoteFingerprint), completed);
    matrix[name] = row;
  }
  return matrix;
}
