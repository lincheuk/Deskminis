import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { RpcMethodRegistry } from '../src/minisd/rpc/registry';
import { assertAuthMode } from '../src/minisd/rpc/access';
import { EventLog } from '../src/minisd/rpc/event-log';
import { accessMatrix, accessResult, probeConnection, startAccessProbeEngine, startCapturedEngine, startExpectingFailure, type CapturedEngine } from './engine-assembly';
import baseline from './fixtures/rpc-access-baseline.json';

// Q20：访问表从真实引擎取（engine-assembly.ts），不再按语法树抽 src/minisd/index.ts 的登记语句。
const engines: CapturedEngine[] = [];
async function engine(): Promise<CapturedEngine> {
  const e = await startCapturedEngine();
  engines.push(e);
  return e;
}
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { for (const e of [...engines].reverse()) await e.close(); });

async function probe(business: CapturedEngine): Promise<CapturedEngine> {
  await business.handle.close(); // 留临时根中的真实配对记录，另一台引擎读它。
  const e = await startAccessProbeEngine({ dataDir: business.root });
  engines.push(e);
  return e;
}

const register = RpcMethodRegistry.prototype.register;
const publishedOf = Object.getOwnPropertyDescriptor(RpcMethodRegistry.prototype, 'methods')!.get as (this: RpcMethodRegistry) => RpcMethodRegistry['methods'];

describe('Q06 RPC 注册与访问边界', () => {
  it('实际装配的方法全集 × 三种连接与改前快照逐格一致，含拒绝原文', async () => {
    const business = await engine();
    const fp = await business.pair();
    const eng = await probe(business);
    const completed: string[] = [];
    expect(await accessMatrix(eng.methods, fp, completed)).toEqual(baseline.matrix);
    expect(completed).toEqual([]);
    expect(eng.events).toBeInstanceOf(EventLog);
  }, 60000);

  it('把业务组注册移到所有协议/附件组之后，仍拒 pairing，全部权限格保持不变', async () => {
    const business = await engine();
    const fp = await business.pair();
    // 真实引擎的每一次登记先扣下，等引擎来取方法表（交给 RpcServer 的那一刻）再倒着补：
    // 业务组全部排到配对协议组之后，各组之间的先后也整个反过来
    const held = new Map<RpcMethodRegistry, Parameters<typeof register>[]>();
    const asWritten: string[] = [];
    const asReplayed: string[] = [];
    /** 一组方法的记号：带 chat.sessions.list 的是内联业务组，带 remote.pair.complete 的是配对协议组，其余记第一个方法名。 */
    const tag = (group: Parameters<typeof register>[0]): string =>
      'chat.sessions.list' in group ? '业务组' : 'remote.pair.complete' in group ? '配对协议组' : Object.keys(group)[0];
    vi.spyOn(RpcMethodRegistry.prototype, 'register').mockImplementation(function (this: RpcMethodRegistry, ...args) {
      asWritten.push(tag(args[0]));
      held.set(this, [...(held.get(this) ?? []), args]);
    });
    vi.spyOn(RpcMethodRegistry.prototype, 'methods', 'get').mockImplementation(function (this: RpcMethodRegistry) {
      for (const args of (held.get(this) ?? []).splice(0).reverse()) {
        asReplayed.push(tag(args[0]));
        register.apply(this, args);
      }
      return publishedOf.call(this);
    });
    const eng = await probe(business);
    vi.restoreAllMocks();
    // 确实换了次序：引擎写的是业务组先登记、配对协议组在后；补登记时业务组排到了最后
    expect(asWritten.length).toBeGreaterThan(3);
    expect(asWritten.indexOf('业务组')).toBeGreaterThanOrEqual(0);
    expect(asWritten.indexOf('业务组')).toBeLessThan(asWritten.indexOf('配对协议组'));
    expect(asReplayed).toEqual([...asWritten].reverse());
    expect(asReplayed.indexOf('业务组')).toBeGreaterThan(asReplayed.indexOf('配对协议组'));
    const completed: string[] = [];
    expect(await accessMatrix(eng.methods, fp, completed)).toEqual(baseline.matrix);
    expect(completed).toEqual([]);
  }, 60000);

  it('重名当场报错，整个失败组不写入，也不覆盖原方法', () => {
    const registry = new RpcMethodRegistry(() => true);
    const original = () => 'original';
    registry.register({ existing: original }, 'business');
    const before = registry.methods;
    expect(() => registry.register({ newMethod: () => 'new', existing: () => 'replacement' }, 'business')).toThrow('RPC 方法重复注册: existing');
    expect(Object.keys(registry.methods)).toEqual(['existing']);
    expect(registry.methods.existing).toBe(before.existing);
    expect(registry.methods.existing({}, probeConnection('local'))).toBe('original');
  });

  it('模型元数据或输入队列与基础方法同名也报错', () => {
    const registry = new RpcMethodRegistry(() => true);
    registry.register({ 'provider.catalog.get': () => {}, 'chat.input.send': () => {} }, 'business');
    for (const name of ['provider.catalog.get', 'chat.input.send']) {
      expect(() => registry.register({ [name]: () => {} }, 'business')).toThrow(`RPC 方法重复注册: ${name}`);
    }
  });

  it('实际引擎装配语句中追加重名组，在构造 RpcServer 之前报错', async () => {
    // 引擎来取方法表（就是构造 RpcServer 的那句的实参）之前，往它自己的登记表里再登记一组同名方法
    vi.spyOn(RpcMethodRegistry.prototype, 'methods', 'get').mockImplementation(function (this: RpcMethodRegistry) {
      this.register({ 'chat.sessions.list': () => 'replacement' }, 'business');
      return publishedOf.call(this);
    });
    const failed = await startExpectingFailure();
    try {
      expect(String((failed.error as Error)?.message ?? failed.error)).toBe('RPC 方法重复注册: chat.sessions.list');
      // 报错发生在构造之前：这次启动一个 RpcServer 都没有建
      expect(failed.servers).toBe(0);
    } finally {
      failed.cleanup();
    }
  }, 60000);

  it('声明 business 就受保护，方法名没有 remote 前缀特权，晚注册也一样', () => {
    const registry = new RpcMethodRegistry(() => true);
    registry.register({ initial: () => 'ok' }, 'business');
    registry.register({ 'remote.business': () => 'ok' }, 'business');
    expect(() => registry.methods['remote.business']({}, probeConnection('pairing'))).toThrow('pairing 模式下不可用');
    expect(registry.methods['remote.business']({}, probeConnection('remote'))).toBe('ok');
    expect(registry.methods['remote.business']({}, probeConnection('local'))).toBe('ok');
  });

  it('显式协议访问类型不由名字决定', () => {
    const registry = new RpcMethodRegistry(() => false);
    registry.register({ 'handshake.complete': () => 'ok' }, { authModes: ['pairing'] });
    expect(registry.methods['handshake.complete']({}, probeConnection('pairing'))).toBe('ok');
    for (const mode of ['local', 'remote'] as const) expect(() => registry.methods['handshake.complete']({}, probeConnection(mode))).toThrow(`handshake.complete 需要 authMode=pairing，当前=${mode}`);
  });

  it('配对撤销后，每个实际业务方法都拒远端且请求关闭连接，本机仍保持原可达性', async () => {
    const business = await engine();
    const fp = await business.pair();
    await business.unpair(fp);
    const eng = await probe(business);
    const completed: string[] = [];
    expect(eng.businessNames.length).toBeGreaterThan(100);
    for (const name of eng.businessNames) {
      let closes = 0;
      expect(await accessResult(eng.methods[name], name, probeConnection('remote', () => { closes++; }, fp)), name).toEqual({ allowed: false, error: `${name} 被拒：这台设备已取消配对` });
      expect(closes, name).toBe(1);
      expect(await accessResult(eng.methods[name], name, probeConnection('local'), completed), name).toEqual(baseline.matrix[name as keyof typeof baseline.matrix].local);
    }
    expect(completed).toEqual([]);
  }, 60000);

  it('没有指纹的 remote 也被拒，且不执行业务正文', () => {
    const body = () => { throw new Error('should not execute'); };
    const registry = new RpcMethodRegistry(() => true);
    registry.register({ business: body }, 'business');
    const conn = probeConnection('remote');
    delete conn.peerFingerprint;
    expect(() => registry.methods.business({}, conn)).toThrow('已取消配对');
  });

  it('交给服务器的是冻结副本，保留同步返回值且后续注册不改变旧表', () => {
    const registry = new RpcMethodRegistry(() => true);
    registry.register({ first: () => 7 }, 'business');
    const published = registry.methods;
    expect(Object.isFrozen(published)).toBe(true);
    expect(published.first({}, probeConnection('local'))).toBe(7);
    registry.register({ second: () => 8 }, 'business');
    expect(Object.keys(published)).toEqual(['first']);
    expect(Object.keys(registry.methods)).toEqual(['first', 'second']);
  });

  it('共享检查保留各域报错与检查点无连接时的拒绝', () => {
    expect(() => assertAuthMode(probeConnection('remote'), ['local'], 'x')).toThrow('x 需要 authMode=local，当前=remote');
    expect(() => assertAuthMode(undefined, ['local'], 'x', 'checkpoint local only')).toThrow('checkpoint local only');
    expect(() => assertAuthMode(probeConnection('local'), ['local', 'remote'], 'x')).not.toThrow();
  });
});
