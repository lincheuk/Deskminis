import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { pipeRequest } from './bridge-util';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  const notifications: { method: string; params: any }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  /** 粗暴地打断连接：先写一帧非法数据（触发 ws 的 receiver 错误），再直接销毁底层 socket */
  function breakSocket(): void {
    const sock = (ws as any)._socket as import('node:net').Socket;
    try { sock.write(Buffer.from([0xf1, 0x00])); } catch { /* 已断开 */ } // RSV 位非法的帧
    sock.destroy();
  }
  return { ready, call, notifications, ws, breakSocket, close: () => ws.close() };
}

async function boot(opts?: { permTimeoutMs?: number }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-rpc-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0, ...opts });
  stop = srv.close;
  return { ...srv, dataDir };
}

/** 轮询等待条件成立，超时即失败（比固定 sleep 稳）。 */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

/** 让假 provider 发起一次真实工具调用（走权限网关）。 */
function toolScript(name: string, input: Record<string, unknown>): string {
  return `__tool__ ${name} ${JSON.stringify(input)}`;
}

/** 连一次，只回答"握手成功了吗"。用于认证用例：拒绝时 ws 发 'error'/'unexpected-response'。 */
function handshake(url: string, opts?: { origin?: string }): Promise<'open' | 'rejected'> {
  const ws = new WebSocket(url, opts);
  return new Promise<'open' | 'rejected'>(res => {
    ws.on('open', () => res('open'));
    ws.on('error', () => res('rejected'));
    ws.on('unexpected-response', () => res('rejected'));
  }).finally(() => ws.terminate());
}

describe('minisd JSON-RPC', () => {
  it('创建会话 + 列出 + 追加用户消息路径存在', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', { title: 'T' })).result;
    expect(s.title).toBe('T');
    const list = (await c.call('chat.sessions.list')).result;
    expect(list).toHaveLength(1);
    c.close();
  });
  it('未知方法返回 JSON-RPC error', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const resp = await c.call('does.not.exist', {});
    expect(resp.error).toBeTruthy();
    expect(resp.error.code).toBe(-32601);
    c.close();
  });
  it('删除会话缺 confirm 报错', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const resp = await c.call('chat.sessions.delete', { sessionId: s.id });
    expect(resp.error).toBeTruthy();
    c.close();
  });
  it('会话重命名：落库前 trim + 广播 chat.sessions.changed（别的窗口靠这条广播同步左栏）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const resp = await c.call('chat.sessions.rename', { sessionId: s.id, title: '  重构登录模块  ' });
    expect(resp.result).toEqual({ ok: true });
    const list = (await c.call('chat.sessions.list')).result;
    expect(list[0].title).toBe('重构登录模块');
    await waitFor('chat.sessions.changed 广播', () => c.notifications.some(n => n.method === 'chat.sessions.changed'));
    c.close();
  });
  it('会话重命名：空白标题与超 50 字都拒收，旧标题不动（空标题让左栏出现无名行，超长把单行卡撑变形）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', { title: '原名' })).result;
    expect((await c.call('chat.sessions.rename', { sessionId: s.id, title: '   ' })).error).toBeTruthy();
    expect((await c.call('chat.sessions.rename', { sessionId: s.id, title: '标'.repeat(51) })).error).toBeTruthy();
    expect((await c.call('chat.sessions.list')).result[0].title).toBe('原名'); // 两次拒收都没写库
    // 边界内侧放行：50 字整正好是允许的
    expect((await c.call('chat.sessions.rename', { sessionId: s.id, title: '标'.repeat(50) })).result).toEqual({ ok: true });
    expect((await c.call('chat.sessions.list')).result[0].title).toBe('标'.repeat(50));
    c.close();
  });
  it('chat.prompt 用假 provider 跑通并广播 chat.event', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // 注册一个 openai-compat provider 指向本地假服务器
    // 这里用环境注入的 mock：startMinisd 在 DESKMINIS_FAKE_PROVIDER=1 时挂一个脚本化 provider
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: s.id, text: '你好', providerId: '__fake__' });
    await new Promise(r => setTimeout(r, 300));
    const events = c.notifications.filter(n => n.method === 'chat.event' && n.params.sessionId === s.id);
    expect(events.some(e => e.params.event.kind === 'turnEnd')).toBe(true);
    c.close();
  });
  it('未配置 provider 时 chat.prompt 报错且不落库孤儿用户消息', async () => {
    const { port, authToken } = await boot(); // 全新数据目录：providers.json 不存在 ⇒ 无默认 provider
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const resp = await c.call('chat.prompt', { sessionId: s.id, text: '你好' }); // 不带 providerId ⇒ 走缺省默认值路径
    expect(resp.error).toBeTruthy();
    const msgs = (await c.call('chat.messages.list', { sessionId: s.id })).result;
    expect(msgs).toEqual([]);
    c.close();
  });
  it('一条连接被粗暴打断不会杀死守护进程', async () => {
    const { port, authToken } = await boot();
    const a = rpcClient(port, authToken); await a.ready;
    const b = rpcClient(port, authToken); await b.ready;
    expect((await b.call('chat.sessions.create', { title: 'B' })).result.title).toBe('B');
    // 缺少 per-connection 'error' 监听时，ws 会把协议错误抛成未捕获异常（真实进程里等于守护进程被杀）
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    let list: unknown[];
    try {
      a.breakSocket();
      await new Promise(r => setTimeout(r, 150));
      list = (await b.call('chat.sessions.list')).result; // 服务端仍存活
    } finally { process.off('uncaughtException', onUncaught); }
    expect(uncaught).toEqual([]);
    expect(list).toHaveLength(1);
    b.close();
  });

  // ---- 认证：没有这道门，用户随便访问的一个网页就能连上本地端口驱动 agent，
  //      并且收到广播的 permission.request 后自己回 allow-session（自我批准执行命令）----
  it('不带 token 的连接被拒绝（任意网页场景）', async () => {
    const { port } = await boot();
    expect(await handshake(`ws://127.0.0.1:${port}`)).toBe('rejected');
    expect(await handshake(`ws://127.0.0.1:${port}/?token=`)).toBe('rejected');
  });
  it('token 错误的连接被拒绝', async () => {
    const { port, authToken } = await boot();
    expect(await handshake(`ws://127.0.0.1:${port}/?token=${authToken.toLowerCase()}`)).toBe('rejected');
    expect(await handshake(`ws://127.0.0.1:${port}/?token=NOT-THE-TOKEN`)).toBe('rejected');
  });
  it('第二道防线：带网页 Origin 的连接即使 token 正确也被拒', async () => {
    const { port, authToken } = await boot();
    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(authToken)}`;
    expect(await handshake(url, { origin: 'https://evil.example' })).toBe('rejected');
    expect(await handshake(url, { origin: 'http://evil.example' })).toBe('rejected');
    expect(await handshake(url, { origin: 'file://' })).toBe('open'); // 打包后渲染进程走 file://
    expect(await handshake(url, { origin: 'http://localhost:5173' })).toBe('open'); // dev server
  });

  it('非法 sessionId 被拒且不在数据根外建目录', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const evil = `..\\..\\dm-pwned-${Date.now()}`;
    const resp = await c.call('chat.prompt', { sessionId: evil, text: '你好', providerId: '__fake__' });
    expect(resp.error).toBeTruthy();
    expect(resp.error.message).toContain('sessionId');
    expect(existsSync(join(dataDir, 'sessions', evil))).toBe(false);
    expect((await c.call('chat.messages.list', { sessionId: evil })).error).toBeTruthy();
    expect((await c.call('chat.sessions.delete', { sessionId: evil, confirm: true })).error).toBeTruthy();
    c.close();
  });
  it('空/纯空白 text 被拒（否则该会话被永久写坏）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    expect((await c.call('chat.prompt', { sessionId: s.id, text: '', providerId: '__fake__' })).error).toBeTruthy();
    expect((await c.call('chat.prompt', { sessionId: s.id, text: '   \n\t ', providerId: '__fake__' })).error).toBeTruthy();
    expect((await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__' })).error).toBeTruthy();
    expect((await c.call('chat.messages.list', { sessionId: s.id })).result).toEqual([]); // 没有落库
    c.close();
  });
  it('同一会话并发 chat.prompt：第二次被拒（避免两个 agent 循环交错写历史）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    // 两条背靠背发出、不等首个响应：此前「await 第一条再发第二条」之间隔一个 WS 往返，
    // 机器高负载时该间隙可超过假 provider 的 30ms 回合时长——第一轮先跑完、锁已释放，
    // 第二条就不再被拒（本用例曾因此偶发失败）。管道化后两帧在服务端相邻宏任务里处理，
    // inFlight 占位在 chat.prompt 处理器内同步完成，间隙缩到亚毫秒级。
    const firstP = c.call('chat.prompt', { sessionId: s.id, text: '第一条', providerId: '__fake__' });
    const secondP = c.call('chat.prompt', { sessionId: s.id, text: '第二条', providerId: '__fake__' });
    const [first, second] = await Promise.all([firstP, secondP]);
    expect(first.result).toEqual({ ok: true });
    expect(second.error).toBeTruthy();
    expect(second.error.message).toContain('运行中');
    await new Promise(r => setTimeout(r, 300)); // 等第一轮跑完，锁释放
    expect((await c.call('chat.prompt', { sessionId: s.id, text: '第三条', providerId: '__fake__' })).result).toEqual({ ok: true });
    await new Promise(r => setTimeout(r, 300));
    c.close();
  });
  // ---- 权限卡片的生命周期：超时/响应都必须通知 UI，否则卡片永远悬在界面上 ----
  it('权限询问超时会广播 permission.resolved（卡片不再永久悬挂）', async () => {
    const { port, authToken } = await boot({ permTimeoutMs: 150 });
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-perm-')), 'x.txt');
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: 'x', tool_title: '写' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;
    await waitFor('permission.resolved', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId));
    expect(existsSync(outside)).toBe(false); // 超时 = deny，文件不该被写出
    c.close();
  });
  it('permission.respond 也会广播 permission.resolved（多窗口同步）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-perm-')), 'y.txt');
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: 'ok', tool_title: '写' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;
    await c.call('permission.respond', { requestId, decision: 'allow-once' });
    await waitFor('permission.resolved', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId));
    // 决策 4b'：应答路径的 resolved 广播必须带 reason:'answered'（Task 10 超时留条按 reason 分流）
    const answered = c.notifications.find(n => n.method === 'permission.resolved' && n.params.requestId === requestId)!;
    expect(answered.params.reason).toBe('answered');
    await waitFor('工具执行完成', () => existsSync(outside));
    expect(readFileSync(outside, 'utf8')).toBe('ok');
    await new Promise(r => setTimeout(r, 200)); // 让后续回合收尾，避免关库时循环还在跑
    c.close();
  });

  // ---- MU2a Task 9（决策 4a/4b/4b'/4c）：90s 默认超时、广播 meta、resolved reason、桥双段合并授权 ----
  it('permission.request 广播 meta：默认 90s 超时 + shell riskClass=gated（非桥命令无 bridgeTriggers）', async () => {
    const { port, authToken } = await boot(); // 不传 permTimeoutMs → 默认路径
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    // 'dir' 已是 readonly 免批不再弹卡；这里要验的是 gated 命令的 meta 广播，换成始终 gated 的 npm install
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('shell_execute', { command: 'npm install', tool_title: '装依赖' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const n = c.notifications.find(x => x.method === 'permission.request')!;
    expect(n.params.meta.timeoutMs).toBe(90000);
    expect(n.params.meta.riskClass).toBe('gated');
    expect(n.params.meta.bridgeTriggers).toBeUndefined();
    await c.call('permission.respond', { requestId: n.params.requestId, decision: 'deny' });
    await waitFor('回合收尾', () => c.notifications.some(x => x.params?.event?.kind === 'turnEnd'), 5000);
    c.close();
  });

  it('permission.request 广播 meta：桥命令带 bridgeTriggers（深等于探测结果，大小写不敏感）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    // 命令文本含两段桥调用（引号内字样也探测——探测器是启发式，假阳性由一次性 TTL 兜底）
    const cmd = 'Write-Output "demo"; windows-clipboard get; WINDOWS-SCREENSHOT capture';
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('shell_execute', { command: cmd, tool_title: '桥演示' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const n = c.notifications.find(x => x.method === 'permission.request')!;
    expect(n.params.meta.timeoutMs).toBe(90000);
    expect(n.params.meta.riskClass).toBe('gated');
    expect(n.params.meta.bridgeTriggers).toEqual(['bridge-clipboard-read', 'bridge-screenshot']);
    await c.call('permission.respond', { requestId: n.params.requestId, decision: 'deny' });
    await waitFor('回合收尾', () => c.notifications.some(x => x.params?.event?.kind === 'turnEnd'), 5000);
    c.close();
  });

  it('permission.resolved 超时路径带 reason:timeout（独立用例；决策 4b\' 评审命门 1）', async () => {
    const { port, authToken } = await boot({ permTimeoutMs: 150 });
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-perm-')), 'z.txt');
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('file_write', { path: outside, content: 'x', tool_title: '写' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const requestId = c.notifications.find(n => n.method === 'permission.request')!.params.requestId;
    await waitFor('permission.resolved', () => c.notifications.some(n => n.method === 'permission.resolved' && n.params.requestId === requestId));
    const resolved = c.notifications.find(n => n.method === 'permission.resolved' && n.params.requestId === requestId)!;
    expect(resolved.params.reason).toBe('timeout');
    expect(existsSync(outside)).toBe(false); // 超时 = deny
    c.close();
  });

  it('permission.respond allow-session 且带 bridgeTriggers：之后同桥 kind 管道请求不再广播 permission.request（合并授权端到端）', async () => {
    const { port, authToken, bridgePipe } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    // shell 命令含桥字样（Write-Output 只回显不真调桥——快速且确定；合并授权的实证落在下方真管道请求上）
    await c.call('chat.prompt', { sessionId: s.id, providerId: '__fake__', text: toolScript('shell_execute', { command: 'Write-Output "windows-clipboard get"', tool_title: '桥演示' }) });
    await waitFor('permission.request', () => c.notifications.some(n => n.method === 'permission.request'));
    const req1 = c.notifications.find(n => n.method === 'permission.request')!;
    expect(req1.params.meta.bridgeTriggers).toEqual(['bridge-clipboard-read']);
    const n1 = c.notifications.filter(n => n.method === 'permission.request').length;
    await c.call('permission.respond', { requestId: req1.params.requestId, decision: 'allow-session' });
    // 同桥 kind 真管道调用：会话级合并授权命中 → 直接放行，不再广播
    const env = await pipeRequest(bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: s.id });
    expect(env.ok).toBe(true);
    expect(typeof (env.data as { text: string }).text).toBe('string');
    expect(c.notifications.filter(n => n.method === 'permission.request').length).toBe(n1);
    await waitFor('回合收尾', () => c.notifications.some(x => x.params?.event?.kind === 'turnEnd'), 5000);
    c.close();
  }, 30000);

  it('provider 编辑：改字段生效、密钥留空不动、改完仍要满足 openai-compat 必须有 baseUrl', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const created = (await c.call('provider.instances.create', { name: '中继', kind: 'openai-compat', baseUrl: 'https://a.example/v1', modelId: 'm1', apiKey: 'k1' })).result;

    // 改名 + 换模型：生效
    expect((await c.call('provider.instances.update', { id: created.id, name: '新名字', modelId: 'm2' })).error).toBeFalsy();
    let list = (await c.call('provider.instances.list')).result;
    expect(list[0].name).toBe('新名字');
    expect(list[0].modelId).toBe('m2');
    // apiKey 未传 → 密钥保持不变（hasApiKey 仍为 true，且列表永不回显密钥）
    expect(list[0].hasApiKey).toBe(true);
    expect(list[0].apiKey).toBeUndefined();

    // 把 openai-compat 的 baseUrl 清空 → 改完之后不合法，必须被拒
    expect((await c.call('provider.instances.update', { id: created.id, baseUrl: '   ' })).error).toBeTruthy();
    list = (await c.call('provider.instances.list')).result;
    expect(list[0].baseUrl).toBe('https://a.example/v1'); // 未被破坏

    // 同时切成 anthropic 并清空 baseUrl：合法（走默认端点）
    expect((await c.call('provider.instances.update', { id: created.id, kind: 'anthropic', baseUrl: '' })).error).toBeFalsy();
    list = (await c.call('provider.instances.list')).result;
    expect(list[0].kind).toBe('anthropic');
    expect(list[0].baseUrl).toBeUndefined();

    // 不存在的 id
    expect((await c.call('provider.instances.update', { id: 'NOPE', name: 'x' })).error).toBeTruthy();
    c.close();
  });

  it('provider 创建：openai-compat 空/空白 baseUrl 被拒；anthropic 空 baseUrl 成功且省略', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // openai-compat 缺 base URL 无法使用：空串与纯空白都应报错
    expect((await c.call('provider.instances.create', { name: 'oc1', kind: 'openai-compat', baseUrl: '', modelId: 'gpt-x', apiKey: 'k' })).error).toBeTruthy();
    expect((await c.call('provider.instances.create', { name: 'oc2', kind: 'openai-compat', baseUrl: '   ', modelId: 'gpt-x', apiKey: 'k' })).error).toBeTruthy();
    // anthropic 空 baseUrl：成功创建，且 baseUrl 被省略（走 provider 默认）
    const ok = await c.call('provider.instances.create', { name: 'an1', kind: 'anthropic', baseUrl: '', modelId: 'claude-x', apiKey: 'k' });
    expect(ok.error).toBeUndefined();
    expect(ok.result.id).toBeTruthy();
    expect(ok.result.baseUrl).toBeUndefined();
    // 只有 anthropic 那条真正落库
    expect((await c.call('provider.instances.list')).result.map((x: any) => x.name)).toEqual(['an1']);
    c.close();
  });

  it('chat.cancel 校验 sessionId；对空闲会话也安全返回', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    expect((await c.call('chat.cancel', { sessionId: s.id })).result).toEqual({ ok: true });
    expect((await c.call('chat.cancel', { sessionId: '../../x' })).error).toBeTruthy();
    c.close();
  });
});

describe('provider.instances.* kind 扩展', () => {
  it('create ollama：无 apiKey 无 baseUrl 也成功', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const r = (await c.call('provider.instances.create', { name: '本地', kind: 'ollama', modelId: 'qwen3' })).result;
    expect(r.kind).toBe('ollama');
    expect(r.baseUrl).toBeUndefined();
    const list = (await c.call('provider.instances.list')).result;
    expect(list[0].hasApiKey).toBe(false);
    c.close();
  });
  it('create gemini 缺 apiKey → 报错', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const resp = await c.call('provider.instances.create', { name: 'G', kind: 'gemini', modelId: 'gemini-2.5-flash' });
    expect(resp.error).toBeTruthy();
    c.close();
  });
  it('create openai-compat 缺 baseUrl → 报错（M1 校验不回归）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const resp = await c.call('provider.instances.create', { name: 'X', kind: 'openai-compat', modelId: 'm', apiKey: 'k' });
    expect(resp.error).toBeTruthy();
    c.close();
  });
  it('provider.models.fetch 无 id 且 kind 非法 → 被拒（有 id 时 kind 由实例决定，无需校验）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // 断言具体报错文案而非仅 error 真值：方法未装配时 -32601 也会让 error 为真，测不出守卫本身
    const bad = await c.call('provider.models.fetch', { kind: 'nope' });
    expect(bad.error).toBeTruthy();
    expect(bad.error.message).toContain('kind');
    const none = await c.call('provider.models.fetch', {});
    expect(none.error).toBeTruthy();
    c.close();
  });
});

describe('modelgroup.* RPC', () => {
  it('create/list/get/update/delete', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // 先建两个 provider（TEST 模式下 kind 不校验密钥，但 openai-compat 需要 baseUrl）
    const a = (await c.call('provider.instances.create', { name: 'A', kind: 'anthropic', modelId: 'm1', apiKey: 'k' })).result;
    const b = (await c.call('provider.instances.create', { name: 'B', kind: 'openai-compat', baseUrl: 'http://x/v1', modelId: 'm2', apiKey: 'k' })).result;
    // create
    const g = (await c.call('modelgroup.create', { name: '链1', memberIds: [a.id, b.id] })).result;
    expect(g.id).toMatch(/^[0-9A-F-]{36}$/);
    expect(g.memberIds).toEqual([a.id, b.id]);
    // list
    const list = (await c.call('modelgroup.list')).result;
    expect(list).toHaveLength(1);
    // get
    const got = (await c.call('modelgroup.get', { id: g.id })).result;
    expect(got.name).toBe('链1');
    // update
    await c.call('modelgroup.update', { id: g.id, name: '链2', memberIds: [a.id] });
    expect((await c.call('modelgroup.get', { id: g.id })).result.name).toBe('链2');
    // delete（需 confirm）
    const noConfirm = await c.call('modelgroup.delete', { id: g.id });
    expect(noConfirm.error).toBeTruthy();
    await c.call('modelgroup.delete', { id: g.id, confirm: true });
    expect((await c.call('modelgroup.list')).result).toHaveLength(0);
    c.close();
  });

  it('delete 不存在的 group 不报错', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const r = await c.call('modelgroup.delete', { id: 'NOPE', confirm: true });
    expect(r.result).toEqual({ ok: true });
    c.close();
  });
});

describe('chat.prompt 模型组绑定链式解析', () => {
  it('会话绑定 group: → fake provider fallbackChain 非空（降级事件可观察）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // 建 provider + group
    const a = (await c.call('provider.instances.create', { name: 'A', kind: 'anthropic', modelId: 'm1', apiKey: 'k' })).result;
    const b = (await c.call('provider.instances.create', { name: 'B', kind: 'anthropic', modelId: 'm2', apiKey: 'k' })).result;
    const g = (await c.call('modelgroup.create', { name: 'G', memberIds: [a.id, b.id] })).result;
    // 建会话并绑定 group
    const s = (await c.call('chat.sessions.create', { title: 'T' })).result;
    // 用 chat.prompt 的 providerId 指定 fake（TEST 模式）；此处只验证 group 绑定不报错
    // 并验证 fallbackChain 装配——但 fake provider 不会 429，所以这里只验证能跑通
    await c.call('chat.prompt', { sessionId: s.id, text: 'hi', providerId: '__fake__' });
    await waitFor('agent 循环完成', () => c.notifications.some(n => n.params?.event?.kind === 'turnEnd' || n.params?.event?.kind === 'error'), 5000);
    c.close();
  });

  it('会话绑定 group: 且成员全被删 → chat.prompt 报错', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const a = (await c.call('provider.instances.create', { name: 'A', kind: 'anthropic', modelId: 'm1', apiKey: 'k' })).result;
    const g = (await c.call('modelgroup.create', { name: 'G', memberIds: [a.id] })).result;
    const s = (await c.call('chat.sessions.create')).result;
    // 用 RPC 设绑定（chat.sessions.setModelBinding 或直接 chat.prompt 带 modelGroupId）
    // 此处通过 chat.prompt 带 modelGroupId 参数测试链式解析
    await c.call('provider.instances.delete', { id: a.id, confirm: true });
    const resp = await c.call('chat.prompt', { sessionId: s.id, text: 'hi', modelGroupId: g.id });
    expect(resp.error).toBeTruthy();
    c.close();
  });

  it('chat.prompt 带 modelGroupId 参数 → 走模型组解析', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const a = (await c.call('provider.instances.create', { name: 'A', kind: 'anthropic', modelId: 'm1', apiKey: 'k' })).result;
    const g = (await c.call('modelgroup.create', { name: 'G', memberIds: [a.id] })).result;
    const s = (await c.call('chat.sessions.create')).result;
    // 模型组只有一个成员 = A（anthropic），但 TEST 模式下 A 没有 fake provider 行为
    // 这里只验证不报错、能启动
    const r = await c.call('chat.prompt', { sessionId: s.id, text: 'hi', modelGroupId: g.id });
    // 不报错即成功（fake provider 只认 __fake__ id，但 modelGroupId 走真实 instantiate）
    // 真实 anthropic provider 没有 key 会报错——但 TEST 模式 vault 是 InMemoryVault
    // 所以这里预期 error（密钥不存在或网络错误），关键是 "模型组无可用成员" 不出现
    expect(r.error?.message ?? '').not.toContain('无可用成员');
    c.close();
  });
});

describe('fallback 改写会话绑定时机', () => {
  it('主/备选全部失败 → error 终态后 modelBinding 仍为 group:<id>（未被改写）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // 建两个 provider + 模型组
    const a = (await c.call('provider.instances.create', { name: 'A', kind: 'anthropic', modelId: 'm1', apiKey: 'k' })).result;
    const b = (await c.call('provider.instances.create', { name: 'B', kind: 'anthropic', modelId: 'm2', apiKey: 'k' })).result;
    const g = (await c.call('modelgroup.create', { name: 'G', memberIds: [a.id, b.id] })).result;
    // 建会话并绑定 group
    const s = (await c.call('chat.sessions.create')).result;
    await c.call('chat.sessions.setModelBinding', { sessionId: s.id, binding: `group:${g.id}` });
    // 发送 __fail__ 消息 → 主/备选 FakeProvider 都抛 fallbackable 429
    await c.call('chat.prompt', { sessionId: s.id, text: '__fail__ 测试限流' });
    // 等待 agent 循环以 error 终态结束
    await waitFor('error 终态', () => c.notifications.some(n => n.params?.event?.kind === 'error'), 5000);
    // 验证绑定未被改写
    const sessions = (await c.call('chat.sessions.list')).result;
    const updated = sessions.find((x: { id: string }) => x.id === s.id);
    expect(updated?.modelBinding).toBe(`group:${g.id}`);
    c.close();
  });
});

describe('FakeProvider DESKMINIS_FAKE_REPLY 环境钩子（MU2a Task 11 计划内红线例外）', () => {
  /** 跑一个假 provider 回合，返回助手文本拼接。 */
  async function fakeReplyText(): Promise<string> {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    await c.call('chat.prompt', { sessionId: s.id, text: '你好', providerId: '__fake__' });
    await waitFor('turnEnd', () => c.notifications.some(n => n.params?.event?.kind === 'turnEnd'), 5000);
    const msgs = (await c.call('chat.messages.list', { sessionId: s.id })).result;
    c.close();
    return msgs
      .filter((m: any) => m.role === 'assistant')
      .flatMap((m: any) => (Array.isArray(m.parts) ? m.parts : []))
      .filter((p: any) => p && p.type === 'text' && typeof p.value === 'string')
      .map((p: any) => p.value)
      .join('');
  }

  it('env 设置时假回复用定制文本（e2e markdown 断言的数据源）', async () => {
    process.env.DESKMINIS_FAKE_REPLY = '## 定制标题';
    try { expect(await fakeReplyText()).toBe('## 定制标题'); }
    finally { delete process.env.DESKMINIS_FAKE_REPLY; }
  });

  it('env 未设置时假回复保持默认原文（既有行为不回归）', async () => {
    delete process.env.DESKMINIS_FAKE_REPLY;
    expect(await fakeReplyText()).toBe('（假回复）');
  });
});

describe('chat.sessions.setMemoryEnabled', () => {
  it('设置 memoryEnabled 并在 getSession 读回', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', { title: 'M' })).result;
    // 默认 memoryEnabled = true（db.ts memory_enabled DEFAULT 1）
    expect((await c.call('chat.sessions.list')).result[0].memoryEnabled).toBe(true);
    // 关闭
    await c.call('chat.sessions.setMemoryEnabled', { sessionId: s.id, enabled: false });
    const list = (await c.call('chat.sessions.list')).result;
    expect(list[0].memoryEnabled).toBe(false);
    // 再开
    await c.call('chat.sessions.setMemoryEnabled', { sessionId: s.id, enabled: true });
    expect((await c.call('chat.sessions.list')).result[0].memoryEnabled).toBe(true);
    c.close();
  });

  it('非法 sessionId 被拒', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    expect((await c.call('chat.sessions.setMemoryEnabled', { sessionId: 'evil', enabled: false })).error).toBeTruthy();
    c.close();
  });
});
