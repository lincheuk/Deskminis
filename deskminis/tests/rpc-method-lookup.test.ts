import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { RpcServer, type RpcMethods } from '../src/minisd/rpc/server';
import { RpcMethodRegistry } from '../src/minisd/rpc/registry';

const TOKEN = 'q06b-local-fixture';
const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
const modes = ['local', 'pairing', 'remote-paired', 'remote-unpaired'] as const;
type Mode = typeof modes[number];
type Reply = { jsonrpc: string; id: number; result?: unknown; error?: { code: number; message: string } };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function connect(mode: Mode, suppliedMethods?: RpcMethods) {
  const registry = new RpcMethodRegistry(fp => fp === 'paired-fixture');
  registry.register({ 'business.echo': (p: unknown) => p }, 'business');
  registry.register({ 'handshake.echo': (p: unknown) => p }, { authModes: ['pairing'] });
  const server = new RpcServer(suppliedMethods ?? registry.methods, TOKEN, req => {
    const candidate = new URL(req.url ?? '/', 'http://fixture').searchParams.get('fixtureMode');
    if (candidate === 'pairing') return { ok: true, authMode: 'pairing' };
    if (candidate === 'remote-paired' || candidate === 'remote-unpaired') return {
      ok: true, authMode: 'remote', peerFingerprint: candidate === 'remote-paired' ? 'paired-fixture' : 'revoked-fixture',
    };
    return { ok: false };
  });
  cleanups.push(() => server.close());
  const port = await server.listen('127.0.0.1', 0);
  const query = mode === 'local' ? 'token=' + TOKEN : 'fixtureMode=' + mode;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?${query}`);
  cleanups.push(() => ws.terminate());
  let id = 0;
  const pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  ws.on('message', raw => {
    const reply = JSON.parse(String(raw)) as Reply;
    const request = pending.get(reply.id);
    if (request) { clearTimeout(request.timer); pending.delete(reply.id); request.resolve(reply); }
  });
  ws.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('RPC fixture connection closed')); }
    pending.clear();
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    call(method: string, params: unknown): Promise<Reply> {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`RPC fixture reply timeout: ${method}`)); }, 3000);
        pending.set(requestId, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
      });
    },
  };
}

describe('Q06b RPC 方法只从表自身查找（真实 WebSocket）', () => {
  it.each(modes)('%s：Object.prototype 的每个继承名称都返回原有未知方法错误', async mode => {
    const client = await connect(mode);
    for (const name of prototypeNames) {
      const reply = await client.call(name, { marker: 'must-not-be-echoed' });
      expect(reply, name).toEqual({ jsonrpc: '2.0', id: reply.id, error: { code: -32601, message: `未知方法: ${name}` } });
    }
  });

  it.each(modes)('%s：普通未知方法的完整应答不变', async mode => {
    const client = await connect(mode);
    expect(await client.call('does.not.exist', { marker: 'unused' })).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: '未知方法: does.not.exist' } });
  });

  it.each(modes)('%s：实际登记的方法仍执行原有访问检查及返回值', async mode => {
    const client = await connect(mode);
    const params = { text: '你好', list: [1, 'two'], nested: { enabled: true } };
    const name = mode === 'pairing' ? 'handshake.echo' : 'business.echo';
    const reply = await client.call(name, params);
    if (mode === 'remote-unpaired') {
      expect(reply).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'business.echo 被拒：这台设备已取消配对' } });
    } else {
      expect(reply).toEqual({ jsonrpc: '2.0', id: 1, result: params });
    }
  });

  it('显式登记与继承名称同名的方法仍可调用，不使用字符串黑名单', async () => {
    const registry = new RpcMethodRegistry(() => true);
    registry.register(Object.fromEntries(prototypeNames.map(name => [name, (p: unknown) => ({ method: name, params: p })])), 'business');
    const client = await connect('local', registry.methods);
    for (const name of prototypeNames) {
      expect((await client.call(name, { value: 7 })).result, name).toEqual({ method: name, params: { value: 7 } });
    }
  });

  it('不读取自定义原型上的函数和 getter，未知名称也不改变业务状态', async () => {
    const inherited = vi.fn(() => 'inherited');
    const getter = vi.fn(() => inherited);
    const prototype = Object.create(null, { inheritedMethod: { value: inherited }, inheritedGetter: { get: getter } });
    const table = Object.create(prototype) as RpcMethods;
    table.ownMethod = (p: unknown) => p;
    const client = await connect('local', table);
    for (const name of ['inheritedMethod', 'inheritedGetter']) {
      expect((await client.call(name, {})).error, name).toEqual({ code: -32601, message: `未知方法: ${name}` });
    }
    expect(inherited).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect((await client.call('ownMethod', { value: 8 })).result).toEqual({ value: 8 });
  });
});
