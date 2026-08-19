/** D3 MCP stdio 传输客户端：真子进程 fixture 全链路——initialize 握手、换行分帧（跨 chunk/
 *  单 chunk 多消息/垃圾行）、tools/list 翻页、tools/call、$$VAR 环境解析、启动/调用两级超时、
 *  取消透传、进程崩溃拒绝、ENOENT 与 .cmd 兜底、dispose 幂等。 */
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { McpStdioClient, spawnWithCmdFallback, type McpNotification } from '../src/minisd/mcp/stdio';

const FIXTURE = fileURLToPath(new URL('./mcp-stdio-server.mjs', import.meta.url));

/** vitest 跑在 electron 二进制上，process.execPath 即 electron——子进程必须带
 *  ELECTRON_RUN_AS_NODE=1 才是 Node 模式，否则会拉起 GUI 应用 */
function mkClient(flags: string[] = [], extra: Record<string, unknown> = {}): McpStdioClient {
  return new McpStdioClient({
    command: process.execPath,
    args: [FIXTURE, ...flags],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    ...extra,
  });
}

/** 每例结束统一 dispose，不留孤儿 fixture 进程拖慢整个套件 */
const clients: McpStdioClient[] = [];
function track<T extends McpStdioClient>(c: T): T {
  clients.push(c);
  return c;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

/** 真定时器轮询等待（进程退出、通知到达等异步事实） */
async function until(cond: () => boolean, ms = 5000, what = ''): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`轮询超时: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 进程已终止：自然退出给 exitCode；被 kill 的进程在 Windows 上 exitCode 恒为 null、只有 signalCode */
const isGone = (c: McpStdioClient): boolean => c.exitCode !== null || c.signalCode !== null;

/** 取 tools/call 结果里 content[0].text（fixture 约定：文本负载都放第一个 text 块） */
function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  return r?.content?.[0]?.text ?? '';
}
/** 抓 rejection 的 Error（比 rejects.toThrow 更方便做多段断言） */
async function errOf(p: Promise<unknown>): Promise<Error> {
  return (await p.catch((e) => e)) as Error;
}

describe('握手（1）', () => {
  it('initialize 带 protocolVersion=2025-06-18 与 clientInfo.name=deskminis，随后发送 notifications/initialized', async () => {
    const c = track(mkClient(['--initdump']));
    await c.connect();
    // fixture 把收到的 initialize 参数经 initdump 工具响应回传，供断言
    const dump = JSON.parse(textOf(await c.callTool('initdump')));
    expect(dump.initialize.protocolVersion).toBe('2025-06-18');
    expect(dump.initialize.clientInfo.name).toBe('deskminis');
    expect(dump.initialize.capabilities).toEqual({});
    expect(dump.initializedReceived).toBe(true);
  });
});

describe('tools/list（2）', () => {
  it('正常返回 echo 与 slow 两个工具', async () => {
    const c = track(mkClient());
    await c.connect();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'slow']);
    expect(tools.every((t) => typeof t.description === 'string' && t.inputSchema !== undefined)).toBe(true);
  });

  it('--paginated：两页经 nextCursor 拼接完整', async () => {
    const c = track(mkClient(['--paginated']));
    await c.connect();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'slow']);
  });
});

describe('tools/call（3）', () => {
  it('echo 参数原样往返', async () => {
    const c = track(mkClient());
    await c.connect();
    const args = { foo: 'bar', n: 1, nested: { list: [1, 2] } };
    const res = await c.callTool('echo', args);
    expect(JSON.parse(textOf(res))).toEqual(args);
  });
});

describe('分帧（4）', () => {
  it('--garbage-lines：非 JSON 行被跳过且计数，协议照常工作', async () => {
    const c = track(mkClient(['--garbage-lines']));
    await c.connect();
    expect((await c.listTools()).length).toBe(2);
    const res = await c.callTool('echo', { a: 1 });
    expect(JSON.parse(textOf(res))).toEqual({ a: 1 });
    expect(c.garbageLines).toBeGreaterThan(0);
  });

  it('单 chunk 多消息：两条并发请求各自按 id 配对应答', async () => {
    // fixture 攒 50ms 一次 write，两条应答必然落在同一个 stdout chunk 里
    const c = track(mkClient(['--batch-responses']));
    await c.connect();
    const [tools, echoed] = await Promise.all([c.listTools(), c.callTool('echo', { x: 'y' })]);
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'slow']);
    expect(JSON.parse(textOf(echoed))).toEqual({ x: 'y' });
  });
});

describe('$$VAR 环境引用（5）', () => {
  const VAL = 'dm-probe-secret-value-42';
  afterEach(() => {
    delete process.env.DM_TEST_VAR;
    delete process.env.DM_UNSET_XYZ;
  });

  it('已设置：解析后的值真进了子进程环境', async () => {
    process.env.DM_TEST_VAR = VAL;
    const c = track(new McpStdioClient({
      command: process.execPath,
      args: [FIXTURE, '--env-echo'],
      env: { ELECTRON_RUN_AS_NODE: '1', PROBE: '$$DM_TEST_VAR' },
    }));
    await c.connect();
    const res = await c.callTool('envdump', { name: 'PROBE' });
    expect(textOf(res)).toBe(VAL);
  });

  it('未设置：connect 拒绝，错误含 $$名、绝不含任何已解析值', async () => {
    process.env.DM_TEST_VAR = VAL; // 场景里另一个变量已设置——其值绝不能泄进错误文案
    delete process.env.DM_UNSET_XYZ;
    const c = track(new McpStdioClient({
      command: process.execPath,
      args: [FIXTURE, '--env-echo'],
      env: { ELECTRON_RUN_AS_NODE: '1', PROBE: '$$DM_UNSET_XYZ' },
    }));
    const err = await errOf(c.connect());
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('$$DM_UNSET_XYZ');
    expect(err.message).not.toContain(VAL);
  });
});

describe('超时（6-7）', () => {
  it('启动超时：--no-init-response + startupTimeoutSeconds=0.5 → 中文超时错误且子进程已被杀', async () => {
    const c = track(mkClient(['--no-init-response'], { startupTimeoutSeconds: 0.5 }));
    const err = await errOf(c.connect());
    expect(err.message).toContain('启动超时');
    expect(err.message).toContain('0.5');
    await until(() => isGone(c), 5000, '超时后子进程被杀');
  });

  it('调用超时：单次调用失败不迁怒整台 server，连接仍可用', async () => {
    const c = track(mkClient(['--slow-ms', '5000'], { callTimeoutMs: 300 }));
    await c.connect();
    const err = await errOf(c.callTool('slow'));
    expect(err.message).toContain('工具调用超时');
    const res = await c.callTool('echo', { alive: true });
    expect(JSON.parse(textOf(res))).toEqual({ alive: true });
  });
});

describe('取消（8）', () => {
  it('AbortController 中止 → 立即以「已取消」拒绝，cancelled 通知透传到 server', async () => {
    const c = track(mkClient(['--slow-ms', '5000']));
    const notes: McpNotification[] = [];
    c.onNotification = (n) => notes.push(n);
    await c.connect();
    const ac = new AbortController();
    const t0 = Date.now();
    const p = c.callTool('slow', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const err = await errOf(p);
    expect(err.message).toContain('取消');
    expect(Date.now() - t0).toBeLessThan(2000); // 没有干等 slow 的 5 秒应答
    // 取消透传是通知（不等 server 应答），fixture 收到后回一条测试通知
    await until(() => notes.some((n) => n.method === 'test/cancelled-received'), 5000, 'test/cancelled-received');
  });
});

describe('崩溃与关闭（9, 11）', () => {
  it('--exit-after-init：退出后在途/新调用均以「进程已退出」拒绝，closed 可见', async () => {
    const c = track(mkClient(['--exit-after-init', '--slow-ms', '5000']));
    await c.connect();
    const pending = errOf(c.callTool('slow')); // 退出时刻仍挂在途的调用
    await until(() => c.closed, 5000, 'fixture 自行退出');
    expect((await pending).message).toContain('进程已退出');
    expect((await errOf(c.callTool('echo', {}))).message).toContain('进程已退出');
    expect(c.closed).toBe(true);
  });

  it('dispose：子进程退出，二次调用不抛（幂等）', async () => {
    const c = track(mkClient());
    await c.connect();
    c.dispose();
    await until(() => isGone(c), 5000, 'dispose 后子进程退出');
    expect(() => c.dispose()).not.toThrow();
  });
});

describe('ENOENT 与 .cmd 兜底（10）', () => {
  it('不存在的命令 → 「命令不存在」文案（含命令名）', async () => {
    const c = track(new McpStdioClient({ command: 'dm-definitely-missing-xyz' }));
    const err = await errOf(c.connect());
    expect(err.message).toContain('命令不存在');
    expect(err.message).toContain('dm-definitely-missing-xyz');
  });

  it('兜底函数·win32 平台参数：裸名 ENOENT 后补试 .cmd（attempts 可见）', async () => {
    // 本机 Node 对 *.cmd + shell:false 一律同步抛 EINVAL（批处理护栏），补试必然失败——
    // 以 attempts 序列观察「确实补试过」，最终文案仍按「命令不存在」归一
    const err = await errOf(spawnWithCmdFallback(
      'dm-missing-xyz', [], { env: { ...process.env } }, 'win32',
    ));
    expect(err.message).toContain('命令不存在: dm-missing-xyz');
    expect((err as { attempts?: string[] }).attempts).toEqual(['dm-missing-xyz', 'dm-missing-xyz.cmd']);
  });

  it('兜底函数·非 win32 平台参数：不补试，首次 ENOENT 直接拒绝', async () => {
    const err = await errOf(spawnWithCmdFallback(
      'dm-missing-xyz', [], { env: { ...process.env } }, 'linux',
    ));
    expect(err.message).toContain('命令不存在: dm-missing-xyz');
    expect((err as { attempts?: string[] }).attempts).toEqual(['dm-missing-xyz']);
  });
});
