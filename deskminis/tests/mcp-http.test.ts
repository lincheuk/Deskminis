/** D4 MCP streamable-http 传输客户端：fetch 全 mock（无真网络）——initialize 握手与请求头构造、
 *  Mcp-Session-Id 捕获/回显、headers $$VAR 逐请求解析、JSON/SSE 双形态响应分派、
 *  tools/list 翻页与防环、启动/调用两级超时、取消透传（notifications/cancelled）、
 *  非 2xx 不读体（密钥卫生）、JSON-RPC error 透传、dispose 收口（在途拒绝 + DELETE 告别）。 */
import { describe, it, expect, afterEach } from 'vitest';
import { McpHttpClient } from '../src/minisd/mcp/http';
import type { McpNotification } from '../src/minisd/mcp/stdio';

const RPC_URL = 'https://mcp.example/rpc';

/** 捕获型按调用序编程的 fetch mock（web-search.test.ts 捕获式 fakeFetch 同款思路）：
 *  程序表按序消费，耗尽后复用最后一项（写「永远 nextCursor」类用例省事）；
 *  body 支持函数形态——按请求体里的 JSON-RPC id 动态生成应答（翻页用例 id 递增）；
 *  hang 项返回只在 signal 中止时拒绝的 Promise（模拟原生 fetch 的中止语义）。 */
interface ProgItem {
  status?: number;
  headers?: Record<string, string>;
  body?: string | ((reqId: number | undefined) => string);
  hang?: boolean;
  throwErr?: Error;
}
interface HttpCall { url: string; method: string; headers: Record<string, string>; body?: string }

function seqFetch(prog: ProgItem[], calls: HttpCall[] = []): typeof fetch {
  let n = 0;
  return (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) for (const [k, v] of new Headers(init.headers as HeadersInit)) headers[k] = v;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const p = prog[Math.min(n, prog.length - 1)];
    n++;
    if (p.throwErr) throw p.throwErr;
    if (p.hang) {
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          const reason = (init.signal as AbortSignal).reason as DOMException | undefined;
          const e = new Error('aborted');
          e.name = reason?.name ?? 'AbortError';
          rej(e);
        });
      });
    }
    const h = { ...(p.headers ?? {}) };
    let body = p.body;
    if (typeof body === 'function') {
      const reqId = init?.body ? (JSON.parse(init.body as string) as { id?: number }).id : undefined;
      body = body(reqId);
    }
    if (body !== undefined && h['content-type'] === undefined) h['content-type'] = 'application/json';
    return new Response(body ?? '', { status: p.status ?? 200, headers: h });
  }) as typeof fetch;
}

/** JSON-RPC 应答/通知的常用拼装 */
const rpcOk = (id: number, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result });
const rpcErr = (id: number, error: unknown) => JSON.stringify({ jsonrpc: '2.0', id, error });
const note = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', method, params });
const INIT_RESULT = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture' } };
/** 约定调用序：#1 initialize（id=1）→ #2 initialized 通知（202 即可） */
const OK_INIT: ProgItem = { body: rpcOk(1, INIT_RESULT) };
const OK_NOTE: ProgItem = { status: 202, body: '' };
/** SSE 响应体：每条消息一个 data: 行，事件以空行分隔 */
const sseBody = (...msgs: string[]) => msgs.map((m) => `data: ${m}\n\n`).join('');

/** 抓 rejection 的 Error（比 rejects.toThrow 更方便做多段断言） */
async function errOf(p: Promise<unknown>): Promise<Error> {
  return (await p.catch((e) => e)) as Error;
}
const textOf = (result: unknown): string => {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  return r?.content?.[0]?.text ?? '';
};

describe('握手（1-2）', () => {
  it('initialize：POST、Content-Type/Accept 两头、体含 protocolVersion 与 clientInfo.name=deskminis；随后发出 initialized 通知 POST', async () => {
    const calls: HttpCall[] = [];
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([OK_INIT, OK_NOTE], calls));
    await c.connect();
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(RPC_URL);
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].headers['accept']).toBe('application/json, text/event-stream');
    const initBody = JSON.parse(calls[0].body!);
    expect(initBody.jsonrpc).toBe('2.0');
    expect(initBody.method).toBe('initialize');
    expect(initBody.params.protocolVersion).toBe('2025-06-18');
    expect(initBody.params.capabilities).toEqual({});
    expect(initBody.params.clientInfo.name).toBe('deskminis');
    // initialized 是通知：无 id，随后独立 POST
    const noteBody = JSON.parse(calls[1].body!);
    expect(calls[1].method).toBe('POST');
    expect(noteBody.method).toBe('notifications/initialized');
    expect(noteBody.id).toBeUndefined();
  });

  it('握手响应带 Mcp-Session-Id → 此后每请求（含 initialized 通知）回显该头', async () => {
    const calls: HttpCall[] = [];
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      { body: rpcOk(1, INIT_RESULT), headers: { 'Mcp-Session-Id': 'sess-abc-1' } },
      OK_NOTE,
      { body: rpcOk(2, { tools: [] }) },
    ], calls));
    await c.connect();
    await c.listTools();
    expect(calls[1].headers['mcp-session-id']).toBe('sess-abc-1'); // Headers 归一小写
    expect(calls[2].headers['mcp-session-id']).toBe('sess-abc-1');
  });

  it('握手响应不带 Mcp-Session-Id → 后续请求无此头', async () => {
    const calls: HttpCall[] = [];
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([OK_INIT, OK_NOTE, { body: rpcOk(2, { tools: [] }) }], calls));
    await c.connect();
    await c.listTools();
    expect('mcp-session-id' in calls[2].headers).toBe(false);
  });
});

describe('headers $$VAR（3）', () => {
  const VAL = 'dm-http-probe-secret-42';
  afterEach(() => {
    delete process.env.DM_HTTP_TOKEN;
    delete process.env.DM_HTTP_UNSET;
  });

  it('已设置：每次请求解析值进请求头，且绝不出现在 URL', async () => {
    process.env.DM_HTTP_TOKEN = VAL;
    const calls: HttpCall[] = [];
    const c = new McpHttpClient(
      { url: RPC_URL, headers: { Authorization: 'Bearer $$DM_HTTP_TOKEN' } },
      seqFetch([OK_INIT, OK_NOTE, { body: rpcOk(2, { tools: [] }) }], calls),
    );
    await c.connect();
    await c.listTools();
    expect(calls[2].headers['authorization']).toBe(`Bearer ${VAL}`);
    expect(calls[2].url).toBe(RPC_URL);
    expect(calls[2].url).not.toContain(VAL);
  });

  it('未设置：该请求直接拒绝，错误含 $$名、绝不含另一已设置变量的值', async () => {
    process.env.DM_HTTP_TOKEN = VAL; // 另一变量已设置——其值绝不能泄进错误文案
    delete process.env.DM_HTTP_UNSET;
    const c = new McpHttpClient(
      { url: RPC_URL, headers: { Authorization: 'Bearer $$DM_HTTP_UNSET', 'X-Other': '$$DM_HTTP_TOKEN' } },
      seqFetch([OK_INIT, OK_NOTE]),
    );
    const err = await errOf(c.connect());
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('$$DM_HTTP_UNSET');
    expect(err.message).not.toContain(VAL);
  });
});

describe('JSON 形态（4）', () => {
  it('tools/list：application/json 整体解析为单条应答', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { body: rpcOk(2, { tools: [{ name: 'echo', description: '回声' }, { name: 'slow' }] }) },
    ]));
    await c.connect();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'slow']);
    expect(tools[0].description).toBe('回声');
  });

  it('tools/call(echo)：参数原样往返，返回原始 result', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { body: rpcOk(2, { content: [{ type: 'text', text: '{"foo":"bar"}' }] }) },
    ]));
    await c.connect();
    const res = await c.callTool('echo', { foo: 'bar' });
    expect(JSON.parse(textOf(res))).toEqual({ foo: 'bar' });
  });
});

describe('SSE 形态（5）', () => {
  it('一个流里先通知、垃圾 data 行、后匹配 id 应答：应答 resolve、通知进回调、垃圾计数 >0', async () => {
    const notes: McpNotification[] = [];
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      {
        headers: { 'content-type': 'text/event-stream' },
        body: sseBody(
          note('notifications/progress', { progress: 1 }),
          '{这条不是 JSON',
          rpcOk(2, { content: [{ type: 'text', text: 'ok' }] }),
        ),
      },
    ]));
    c.onNotification = (n) => notes.push(n);
    await c.connect();
    const res = await c.callTool('echo', {});
    expect(textOf(res)).toBe('ok');
    expect(notes).toHaveLength(1);
    expect(notes[0].method).toBe('notifications/progress');
    expect(notes[0].params).toEqual({ progress: 1 });
    expect(c.garbageEvents).toBeGreaterThan(0);
  });

  it('流读完仍无匹配 id 的应答 → 「MCP 服务器响应无法解析」', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { headers: { 'content-type': 'text/event-stream' }, body: sseBody(note('notifications/progress')) },
    ]));
    await c.connect();
    const err = await errOf(c.callTool('echo', {}));
    expect(err.message).toContain('MCP 服务器响应无法解析');
  });
});

describe('翻页（6）', () => {
  it('nextCursor 两页拼接完整，第二页带 cursor 参数', async () => {
    const calls: HttpCall[] = [];
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { body: rpcOk(2, { tools: [{ name: 'a' }], nextCursor: 'c1' }) },
      { body: rpcOk(3, { tools: [{ name: 'b' }] }) },
    ], calls));
    await c.connect();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    const listCalls = calls.filter((x) => x.body?.includes('"tools/list"'));
    expect(listCalls).toHaveLength(2);
    expect(JSON.parse(listCalls[1].body!).params).toEqual({ cursor: 'c1' });
  });

  it('mock 永远给 nextCursor → 恰好请求 10 次后停（防环上限）', async () => {
    const calls: HttpCall[] = [];
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { body: (id) => rpcOk(id!, { tools: [], nextCursor: 'forever' }) },
    ], calls));
    await c.connect();
    await c.listTools();
    expect(calls.filter((x) => x.body?.includes('"tools/list"'))).toHaveLength(10);
  });
});

describe('超时（7 + 启动超时）', () => {
  it('调用超时：短 callTimeoutMs + 永挂 fetch → 中文超时错误；随后再调一次正常成功（连接不因超时报废）', async () => {
    const c = new McpHttpClient(
      { url: RPC_URL, callTimeoutMs: 150 },
      seqFetch([OK_INIT, OK_NOTE, { hang: true }, { body: rpcOk(3, { content: [{ type: 'text', text: 'alive' }] }) }]),
    );
    await c.connect();
    const err = await errOf(c.callTool('slow'));
    expect(err.message).toContain('工具调用超时');
    expect(await c.callTool('echo', {})).toMatchObject({ content: [{ type: 'text', text: 'alive' }] });
  });

  it('启动超时：initialize 永挂 + startupTimeoutSeconds=0.2 → 「MCP server 启动超时（0.2 秒）」', async () => {
    const c = new McpHttpClient(
      { url: RPC_URL, startupTimeoutSeconds: 0.2 },
      seqFetch([{ hang: true }]),
    );
    const err = await errOf(c.connect());
    expect(err.message).toContain('MCP server 启动超时');
    expect(err.message).toContain('0.2');
  });
});

describe('取消（8）', () => {
  it('abort → 本地立即「已取消」，随后捕获 notifications/cancelled 的 POST（不等其响应）', async () => {
    const calls: HttpCall[] = [];
    const c = new McpHttpClient(
      { url: RPC_URL },
      seqFetch([OK_INIT, OK_NOTE, { hang: true }, OK_NOTE], calls),
    );
    await c.connect();
    const ac = new AbortController();
    const t0 = Date.now();
    const p = c.callTool('slow', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 80);
    const err = await errOf(p);
    expect(err.message).toContain('已取消');
    expect(Date.now() - t0).toBeLessThan(2000); // 没有干等永挂的应答
    const cancelCall = calls.find((x) => x.body?.includes('notifications/cancelled'));
    expect(cancelCall).toBeDefined();
    const cancelBody = JSON.parse(cancelCall!.body!);
    expect(cancelBody.id).toBeUndefined(); // 通知无 id
    expect(cancelBody.params.requestId).toBe(2); // 被取消的 tools/call 的 id
    expect(cancelBody.params.reason).toBe('user');
  });
});

describe('非 2xx 与网络异常（9-10）', () => {
  it('401：认证失败或无权限（HTTP 401），响应体里的 token 绝不进错误文案', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { status: 401, body: 'unauthorized: Bearer tok-leak-9' },
    ]));
    await c.connect();
    const err = await errOf(c.callTool('echo', {}));
    expect(err.message).toContain('认证失败或无权限');
    expect(err.message).toContain('HTTP 401');
    expect(err.message).not.toContain('tok-leak-9');
  });

  it('403：同样归入认证失败或无权限（HTTP 403）', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { status: 403, body: 'forbidden tok-leak-9' },
    ]));
    await c.connect();
    const err = await errOf(c.callTool('echo', {}));
    expect(err.message).toContain('认证失败或无权限');
    expect(err.message).toContain('HTTP 403');
    expect(err.message).not.toContain('tok-leak-9');
  });

  it('500：MCP 服务器错误（HTTP 500），同样不读响应体', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { status: 500, body: 'Internal Boom tok-leak-9' },
    ]));
    await c.connect();
    const err = await errOf(c.callTool('echo', {}));
    expect(err.message).toBe('MCP 服务器错误（HTTP 500）');
    expect(err.message).not.toContain('Boom');
  });

  it('fetch 网络异常 → 「MCP 服务器连接失败: <message>」', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { throwErr: new TypeError('fetch failed') },
    ]));
    await c.connect();
    const err = await errOf(c.callTool('echo', {}));
    expect(err.message).toContain('MCP 服务器连接失败');
    expect(err.message).toContain('fetch failed');
  });
});

describe('JSON-RPC error 对象（11）', () => {
  it('带 message：原样透传', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { body: rpcErr(2, { code: -32000, message: '工具执行失败' }) },
    ]));
    await c.connect();
    const err = await errOf(c.callTool('echo', {}));
    expect(err.message).toBe('工具执行失败');
  });

  it('无 message → 「MCP 服务器返回错误」', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { body: rpcErr(2, { code: -32000 }) },
    ]));
    await c.connect();
    const err = await errOf(c.callTool('echo', {}));
    expect(err.message).toBe('MCP 服务器返回错误');
  });
});

describe('损坏响应（12）', () => {
  it('application/json 但体损坏 → 「MCP 服务器响应无法解析」', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([
      OK_INIT, OK_NOTE,
      { body: '{broken json', headers: { 'content-type': 'application/json' } },
    ]));
    await c.connect();
    const err = await errOf(c.callTool('echo', {}));
    expect(err.message).toContain('MCP 服务器响应无法解析');
  });
});

describe('dispose（13）', () => {
  it('在途请求以「连接已关闭」拒绝；有 session id 时发出 DELETE（携带该头）', async () => {
    const calls: HttpCall[] = [];
    const c = new McpHttpClient(
      { url: RPC_URL },
      seqFetch([
        { body: rpcOk(1, INIT_RESULT), headers: { 'Mcp-Session-Id': 'sess-del-1' } },
        OK_NOTE,
        { hang: true },
        { status: 200 },
      ], calls),
    );
    await c.connect();
    const pending = errOf(c.callTool('slow', {}));
    c.dispose();
    const err = await pending;
    expect(err.message).toContain('连接已关闭');
    const del = calls.find((x) => x.method === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.headers['mcp-session-id']).toBe('sess-del-1');
    expect(del!.url).toBe(RPC_URL);
  });

  it('二次 dispose 不抛（幂等）；dispose 后新请求立即「连接已关闭」', async () => {
    const c = new McpHttpClient({ url: RPC_URL }, seqFetch([OK_INIT, OK_NOTE]));
    await c.connect();
    c.dispose();
    expect(() => c.dispose()).not.toThrow();
    expect(c.closed).toBe(true);
    const err = await errOf(c.callTool('echo', {}));
    expect(err.message).toContain('连接已关闭');
  });
});
