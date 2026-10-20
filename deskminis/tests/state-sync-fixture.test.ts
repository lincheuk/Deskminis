/**
 * F06 fixture 自检：故障代理与带闸端点确实做了它们声称的事。
 * 用到它们的用例断言的是「丢了一帧之后客户端补得回来」「应答丢了之后不重发」——注入本身没发生的话，那些用例绿得没有意义。
 * 这里不起引擎：代理的对面是一个裸的 ws 服务端，端点直接用 fetch 读。
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { faultProxy, gatedLlm, seg, segs, waitFor, wireClient } from './state-sync-fixture';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
});

/** 裸服务端：记下收到的每个请求；`emit` 请求先推 n 条通知（params.n = 0..n-1）再应答，其余请求直接应答。 */
async function bareServer(): Promise<{ port: number; received: { method: string; id?: number }[]; urls: string[] }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => wss.once('listening', () => r()));
  cleanups.push(() => new Promise<void>(r => { for (const s of wss.clients) s.terminate(); wss.close(() => r()); }));
  const received: { method: string; id?: number }[] = [];
  const urls: string[] = [];
  wss.on('connection', (sock, req) => {
    urls.push(req.url ?? '');
    sock.on('message', raw => {
      const msg = JSON.parse(String(raw)) as { id?: number; method: string; params?: { n?: number } };
      received.push({ method: msg.method, ...(msg.id !== undefined ? { id: msg.id } : {}) });
      if (msg.method === 'emit') {
        for (let i = 0; i < (msg.params?.n ?? 0); i++) sock.send(JSON.stringify({ jsonrpc: '2.0', method: 'tick', params: { n: i } }));
      }
      if (msg.id !== undefined) sock.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, method: msg.method } }));
    });
  });
  return { port: (wss.address() as AddressInfo).port, received, urls };
}

describe('F06 fixture 自检', () => {
  it('代理：丢帧、复制帧、交换相邻两帧、扣帧再放——客户端收到的序列与注入的故障逐一对应；握手的 URL 原样透传', async () => {
    const srv = await bareServer();
    const proxy = await faultProxy(srv.port);
    cleanups.push(() => proxy.close());
    const c = wireClient(proxy.port, 'T-1', '&x=1');
    await c.ready;
    cleanups.push(() => c.close());
    expect(srv.urls).toEqual(['/?token=T-1&x=1']);

    const ns = (): number[] => c.notifications.filter(f => f.method === 'tick').map(f => f.params.n as number);
    proxy.drop(f => f.method === 'tick' && f.params.n === 1);
    proxy.duplicate(f => f.method === 'tick' && f.params.n === 3);
    expect((await c.call('emit', { n: 5 })).result).toEqual({ ok: true, method: 'emit' });
    expect(ns()).toEqual([0, 2, 3, 3, 4]);
    // 代理自己的记录：第 1 帧一次都没发给客户端，第 3 帧发了两次
    const ticks = proxy.downstream.filter(d => d.frame.method === 'tick');
    expect(ticks.map(d => d.delivered)).toEqual([1, 0, 1, 2, 1]);

    c.notifications.length = 0;
    proxy.swapNext(f => f.method === 'tick' && f.params.n === 1);
    await c.call('emit', { n: 4 });
    expect(ns()).toEqual([0, 2, 1, 3]);

    c.notifications.length = 0;
    const seen = proxy.downstream.length;
    proxy.hold();
    const pending = c.call('emit', { n: 3 });
    await waitFor('三条通知与应答都到了代理', () => proxy.downstream.length >= seen + 4);
    expect(proxy.downstream.slice(seen).map(d => d.delivered)).toEqual([0, 0, 0, 0]);
    expect(ns()).toEqual([]);
    proxy.release();
    await pending;
    expect(ns()).toEqual([0, 1, 2]);
  }, 20_000);

  it('代理：forwardThenCut 的请求确实到了上游、应答被吞、客户端被掐断；cutBefore 的请求上游一条都没收到', async () => {
    const srv = await bareServer();
    const proxy = await faultProxy(srv.port);
    cleanups.push(() => proxy.close());

    const a = wireClient(proxy.port, 'T');
    await a.ready;
    expect((await a.call('read.one')).result).toMatchObject({ ok: true });
    proxy.forwardThenCut('write.one');
    const lost = await a.call('write.one', { v: 1 });
    expect(lost.error?.message).toBe('连接已断开');
    expect(a.frames.some(f => f.result?.method === 'write.one')).toBe(false);
    await waitFor('上游收到 write.one', () => srv.received.some(r => r.method === 'write.one'));
    expect(srv.received.filter(r => r.method === 'write.one')).toHaveLength(1);
    expect(proxy.countUp('write.one')).toBe(1);
    await proxy.upstreamIdle();
    await waitFor('代理关掉了这条连接的上游', () => proxy.connections() === 0);

    const b = wireClient(proxy.port, 'T');
    await b.ready;
    proxy.cutBefore('write.two');
    const cut = await b.call('write.two', { v: 2 });
    expect(cut.error?.message).toBe('连接已断开');
    // 再走一条新连接发一个读请求：它到了上游，说明 write.two 不是「还在路上」
    const c = wireClient(proxy.port, 'T');
    await c.ready;
    cleanups.push(() => c.close());
    expect((await c.call('read.two')).result).toMatchObject({ ok: true });
    expect(srv.received.filter(r => r.method === 'write.two')).toEqual([]);
    expect(proxy.countUp('write.two')).toBe(0);
    expect(proxy.upstreamCalls.map(u => u.method)).toEqual(['read.one', 'write.one', 'read.two']);

    // refuse：握手阶段被拒，上游没有新连接
    const before = srv.urls.length;
    proxy.refuse(true);
    const d = wireClient(proxy.port, 'T');
    await expect(d.ready).rejects.toBeDefined();
    expect(srv.urls.length).toBe(before);
    proxy.refuse(false);
    const e = wireClient(proxy.port, 'T');
    await e.ready;
    cleanups.push(() => e.close());
    proxy.cut();
    await waitFor('cut 之后客户端断开', () => e.isClosed() && c.isClosed());
  }, 20_000);

  it('带闸端点：放行两段就只发两段，再放一段才有第三段；命名请求不走剧本、不计入 hitsOf', async () => {
    const llm = await gatedLlm({ S1: [{ chunks: segs(4) }] });
    cleanups.push(() => llm.close());
    const res = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: '[[S1]] 分四段' }] }),
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const contents = (): string[] => buf.split('\n\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)))
      .map(o => o.choices?.[0]?.delta?.content).filter((x): x is string => typeof x === 'string' && x !== '');
    const readUntil = async (cond: () => boolean): Promise<void> => {
      while (!cond()) {
        const { done, value } = await reader.read();
        if (done) throw new Error('流提前结束');
        buf += dec.decode(value, { stream: true });
      }
    };
    const gate = llm.gate('S1');
    expect(gate.sent()).toBe(0);
    gate.release(2);
    await readUntil(() => contents().length >= 2);
    // 客户端已读到两段的这一刻，没设闸的端点早就把四段全写出去了
    expect(gate.sent()).toBe(2);
    expect(contents()).toEqual([seg(0), seg(1)]);
    gate.release();
    await readUntil(() => contents().length >= 3);
    expect(gate.sent()).toBe(3);
    gate.open();
    await readUntil(() => buf.includes('[DONE]'));
    expect(contents()).toEqual(segs(4));

    // 命名请求带着同一段用户原文（含标签）：立刻回短文本，不占剧本的步数
    const title = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'system', content: '你是标题生成器。' }, { role: 'user', content: '[[S1]] 分四段' }] }),
    });
    expect(await title.text()).toContain('好的');
    expect(llm.hitsOf('S1')).toHaveLength(1);
    expect(llm.hits).toHaveLength(2);
  }, 20_000);
});
