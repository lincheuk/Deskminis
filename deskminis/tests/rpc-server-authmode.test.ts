import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { networkInterfaces } from 'node:os';
import { RpcServer, type AuthMode } from '../src/minisd/rpc/server';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot(additionalVerify?: Parameters<RpcServer['constructor']>[2], host = '127.0.0.1') {
  const rpc = new RpcServer({ echo: (p) => p }, 'LOCAL-TOKEN', additionalVerify);
  const port = await rpc.listen(host, 0);
  cleanups.push(() => rpc.close());
  return { port, rpc };
}

/** 找一个非 internal 的本机 IPv4 用于「LAN 源地址」测试；没有则返回 undefined（用例跳过）。 */
function pickLanIpv4(): string | undefined {
  for (const nets of Object.values(networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return undefined;
}

function connect(port: number, query: string): Promise<{ ws: WebSocket; authMode?: AuthMode }> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?${query}`);
    ws.on('open', () => {
      // 发一个 echo 调用，回包里能间接确认连接已就绪
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { hi: 1 } }));
      ws.once('message', () => res({ ws }));
    });
    ws.on('error', rej);
  });
}

describe('老 token 路径不回归', () => {
  it('?token=LOCAL-TOKEN → local 模式 + Origin 放行', async () => {
    const { port } = await boot();
    const { ws } = await connect(port, 'token=LOCAL-TOKEN');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('?token=错 → 401 拒绝（无 additionalVerify 时）', async () => {
    const { port } = await boot();
    await expect(new Promise((_, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=WRONG`);
      ws.on('open', () => rej(new Error('不该连上')));
      ws.on('error', rej);
    })).rejects.toThrow();
  });

  it('Origin 白名单仍对 local 生效：http://evil.com Origin → 拒', async () => {
    const { port } = await boot();
    await expect(new Promise((_, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=LOCAL-TOKEN`, { headers: { origin: 'http://evil.com' } });
      ws.on('open', () => rej(new Error('不该连上')));
      ws.on('error', rej);
    })).rejects.toThrow();
  });
});

describe('local 模式 = 老 token + 回环源地址双条件（评审缺口修订）', () => {
  // 跑 CI/无网环境可能没有非 internal 接口；此时跳过本组（不跳过会假绿——服务器无 LAN IP 可绑）
  const lanIp = pickLanIpv4();
  it.skipIf(!lanIp)('listen 0.0.0.0 + LAN IP 携老 token → 401（防嗅探 token 升权）', async () => {
    const { port } = await boot(undefined, '0.0.0.0');
    // 从 LAN IP 连过来：socket.remoteAddress 是 LAN IP，非回环
    await expect(new Promise((_, rej) => {
      const ws = new WebSocket(`ws://${lanIp}:${port}?token=LOCAL-TOKEN`);
      ws.on('open', () => rej(new Error('LAN IP 携老 token 不该连上')));
      ws.on('error', rej);
    })).rejects.toThrow();
  });

  it.skipIf(!lanIp)('listen 0.0.0.0 + LAN IP + paseto 合法 → 仍连上（remote 不绑源地址）', async () => {
    const { port } = await boot(async () => ({ ok: true as const, authMode: 'remote' as AuthMode }), '0.0.0.0');
    const ws = await new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(`ws://${lanIp}:${port}?paseto=VALID`);
      w.on('open', () => res(w)); w.on('error', rej);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('回环 127.0.0.1 + 老 token 仍 local（不回归本机渲染进程连接）', async () => {
    const { port } = await boot(undefined, '0.0.0.0');
    const { ws } = await connect(port, 'token=LOCAL-TOKEN');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('additionalVerify 分级', () => {
  it('?paseto=xxx → additionalVerify 返回 {ok:true, authMode:remote} → 连上', async () => {
    const { port } = await boot(async ({ url }) => {
      const p = url.searchParams.get('paseto');
      return p === 'VALID' ? { ok: true as const, authMode: 'remote' as AuthMode } : { ok: false };
    });
    const { ws } = await connect(port, 'paseto=VALID');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('additionalVerify 返回 {ok:false} → 401', async () => {
    const { port } = await boot(async () => ({ ok: false }));
    await expect(new Promise((_, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?paseto=BAD`);
      ws.on('error', rej);
    })).rejects.toThrow();
  });

  it('remote 模式跳过 Origin 白名单：http://evil.com Origin 但 paseto 合法 → 连上', async () => {
    const { port } = await boot(async () => ({ ok: true as const, authMode: 'remote' as AuthMode }));
    const ws = await new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}?paseto=VALID`, { headers: { origin: 'http://evil.com' } });
      w.on('open', () => res(w)); w.on('error', rej);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('pairing 模式同样跳过 Origin 白名单', async () => {
    const { port } = await boot(async () => ({ ok: true as const, authMode: 'pairing' as AuthMode }));
    const ws = await new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}?pairingCode=ABCD1234`, { headers: { origin: 'http://evil.com' } });
      w.on('open', () => res(w)); w.on('error', rej);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('RpcConnection.authMode 透传到方法处理器', () => {
  it('local 连接调 echo → handler 收到 authMode=local', async () => {
    let seen: AuthMode | undefined;
    const rpc = new RpcServer({ echo: (_p, conn) => { seen = conn.authMode; return 'ok'; } }, 'LOCAL-TOKEN');
    const port = await rpc.listen('127.0.0.1', 0);
    cleanups.push(() => rpc.close());
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=LOCAL-TOKEN`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: {} }));
    await new Promise<void>(r => ws.once('message', () => r()));
    expect(seen).toBe('local');
    ws.close();
  });

  it('remote 连接 → handler 收到 authMode=remote', async () => {
    let seen: AuthMode | undefined;
    const rpc = new RpcServer({ echo: (_p, conn) => { seen = conn.authMode; return 'ok'; } }, 'LOCAL-TOKEN', async () => ({ ok: true as const, authMode: 'remote' as AuthMode }));
    const port = await rpc.listen('127.0.0.1', 0);
    cleanups.push(() => rpc.close());
    const ws = new WebSocket(`ws://127.0.0.1:${port}?paseto=X`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: {} }));
    await new Promise<void>(r => ws.once('message', () => r()));
    expect(seen).toBe('remote');
    ws.close();
  });
});

describe('broadcast 不回归', () => {
  it('local + remote 两个连接都收到 broadcast', async () => {
    const rpc = new RpcServer({}, 'LOCAL-TOKEN', async () => ({ ok: true as const, authMode: 'remote' as AuthMode }));
    const port = await rpc.listen('127.0.0.1', 0);
    cleanups.push(() => rpc.close());
    const wsLocal = new WebSocket(`ws://127.0.0.1:${port}?token=LOCAL-TOKEN`);
    const wsRemote = new WebSocket(`ws://127.0.0.1:${port}?paseto=X`);
    await Promise.all([
      new Promise<void>((r, e) => { wsLocal.on('open', () => r()); wsLocal.on('error', e); }),
      new Promise<void>((r, e) => { wsRemote.on('open', () => r()); wsRemote.on('error', e); }),
    ]);
    const recv: string[] = [];
    wsLocal.on('message', d => recv.push('local:' + String(d)));
    wsRemote.on('message', d => recv.push('remote:' + String(d)));
    rpc.broadcast('chat.event', { x: 1 });
    await new Promise(r => setTimeout(r, 100));
    expect(recv.some(x => x.startsWith('local:'))).toBe(true);
    expect(recv.some(x => x.startsWith('remote:'))).toBe(true);
    wsLocal.close(); wsRemote.close();
  });
});
