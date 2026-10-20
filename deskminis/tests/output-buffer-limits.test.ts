import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeShellOutput, makeShellTool, PersistentShell, ShellManager } from '../src/minisd/tools/shell';
import { MinisPaths } from '../src/minisd/paths';
import { McpStdioClient } from '../src/minisd/mcp/stdio';

const HEAD = 100 * 1024;
const LINE = 16 * 1024 * 1024;
const cleanups: Array<() => Promise<void>> = [];
const shellTestRoot = mkdtempSync(join(tmpdir(), 'dm-q05-unit-'));
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(() => { rmSync(shellTestRoot, { recursive: true, force: true }); });

function child() {
  const emitter = new EventEmitter();
  const p = Object.assign(emitter, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 4242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    killed: false, kills: 0,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      this.kills++; this.killed = true; this.signalCode = signal;
      queueMicrotask(() => { emitter.emit('exit', null); emitter.emit('close', null); });
      return true;
    },
  });
  return p;
}

function shellProc(emit: (p: ReturnType<typeof child>, marker: string) => void) {
  const p = child();
  p.stdin.on('data', (data: Buffer) => queueMicrotask(() => emit(p, data.toString().split(' ')[0])));
  return { p, proc: { platform: 'linux', spawnImpl: (() => p) as unknown as typeof spawn } };
}

async function shellBytes(bytes: Buffer, splits: number[] = []): Promise<string> {
  const { proc } = shellProc((p, marker) => {
    let start = 0;
    for (const end of [...splits, bytes.length]) { p.stdout.emit('data', bytes.subarray(start, end)); start = end; }
    p.stdout.emit('data', Buffer.from(`__MINIS_DONE_${marker}_EXIT_0__\r\n`));
  });
  const manager = new ShellManager(proc);
  cleanups.push(() => manager.disposeAll());
  const paths = new MinisPaths(shellTestRoot);
  const result = await makeShellTool(manager).execute({ command: 'fixture', tool_title: '输出' }, {
    sessionId: 'S1', paths,
    permissions: { check: async () => 'allow', hasBridgeGrant: () => false },
  });
  expect(result.success).toBe(true);
  return result.output.replace(/, \d+ms\]/, ', <duration>ms]');
}

function oldToolOutput(bytes: Buffer): string {
  let output = decodeShellOutput(bytes).replace(/\r\n/g, '\n').trimEnd();
  if (output.length > HEAD) output = output.slice(0, HEAD) + '\n[输出超过 100KB 被截断]';
  return output + '\n[exit=0, <duration>ms]';
}

describe('shell 输出头部与编码兼容', () => {
  it.each([
    Buffer.from('\uFEFF你好😀\r\nabc  \r\n'),
    Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
    Buffer.from('literal \uFFFD\r\n'),
    Buffer.from([0xe4, 0xbd]),
    Buffer.from(''),
    Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256)),
  ])('任意字节边界分块，返回与旧整体解码逐字节相同：%j', async bytes => {
    expect(await shellBytes(bytes, Array.from({ length: bytes.length }, (_, i) => i))).toBe(oldToolOutput(bytes));
  });

  it.each([HEAD - 1, HEAD, HEAD + 1])('原有 100KB 截断边界：%i', async n => {
    const bytes = Buffer.from('a'.repeat(n));
    expect(await shellBytes(bytes, [1, 63, 64, 65])).toBe(oldToolOutput(bytes));
  });

  it('UTF-8 汉字和代理对穿过保存头部及 chunk 边界，不误判 GBK', async () => {
    const bytes = Buffer.from('汉'.repeat(HEAD - 1) + '😀尾' + '汉'.repeat(HEAD));
    expect(await shellBytes(bytes, [2, 64, 3 * (HEAD - 1) + 1])).toBe(oldToolOutput(bytes));
  });

  it.each([Buffer.from([0xff]), Buffer.from('\uFFFD')])('丢弃尾部中的替换符仍决定整个头部按 GBK 解码：%j', async tail => {
    const prefix = Buffer.from('汉'.repeat(400000));
    const bytes = Buffer.concat([prefix, tail]);
    expect(await shellBytes(bytes, [prefix.length])).toBe(oldToolOutput(bytes));
  });

  it.each([false, true])('大段空白后是否又有正文：%j，trimEnd 与旧结果完全相同', async late => {
    const bytes = Buffer.from('begin' + ' \r\n'.repeat(700000) + (late ? 'end' : ''));
    expect(await shellBytes(bytes, [128, 4096])).toBe(oldToolOutput(bytes));
  });

  it('20 MiB 实际进入 PersistentShell：内部结果有界，100KB 头部及退出码保留', async () => {
    const { proc } = shellProc((p, marker) => {
      const block = Buffer.alloc(64 * 1024, 'A');
      for (let i = 0; i < 320; i++) p.stdout.emit('data', block);
      p.stdout.emit('data', Buffer.from(`__MINIS_DONE_${marker}_EXIT_-2147483648__\r\n`));
    });
    const shell = new PersistentShell(tmpdir(), undefined, proc);
    cleanups.push(() => shell.dispose());
    const result = await shell.run('fixture');
    expect(result.output).toBe('A'.repeat(HEAD + 1));
    expect(result.exitCode).toBe(-2147483648);
  });

  it('大输出之后，哨兵在每个字节边界拆开仍定位正确，同块后续字节不进入解码', async () => {
    for (let split = 0; split < 42; split++) {
      const { proc } = shellProc((p, marker) => {
        const block = Buffer.from('汉'.repeat(30000));
        for (let i = 0; i < 8; i++) p.stdout.emit('data', block);
        const sentinel = Buffer.from(`__MINIS_DONE_${marker}_EXIT_-2147483648__`);
        p.stdout.emit('data', sentinel.subarray(0, split));
        p.stdout.emit('data', Buffer.concat([sentinel.subarray(split), Buffer.from([0xff])]));
      });
      const shell = new PersistentShell(tmpdir(), undefined, proc);
      cleanups.push(() => shell.dispose());
      const result = await shell.run('fixture');
      expect(result.output).toBe('汉'.repeat(HEAD + 1));
      expect(result.exitCode).toBe(-2147483648);
    }
  });

  it.each(['close', 'timeout'] as const)('未完成命令的尾部与状态保留：%s', async end => {
    const { proc } = shellProc(p => {
      p.stdout.emit('data', Buffer.from('你好\r\n '));
      if (end === 'close') p.emit('close', 1);
    });
    const shell = new PersistentShell(tmpdir(), undefined, proc);
    cleanups.push(() => shell.dispose());
    const result = await shell.run('fixture', end === 'timeout' ? 20 : 1000);
    expect(result.exitCode).toBe(end === 'timeout' ? 124 : 129);
    expect(result.output).toBe('你好\n \n' + (end === 'timeout' ? '[命令超时被终止]' : '[shell 进程意外退出]'));
  });
});

async function mcp(onInit?: (p: ReturnType<typeof child>) => void) {
  const p = child();
  const writes: Array<Record<string, any>> = [];
  p.stdin.on('data', (data: Buffer) => {
    const request = JSON.parse(data.toString()); writes.push(request);
    if (request.method === 'initialize') queueMicrotask(() => {
      if (onInit) onInit(p);
      else p.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n');
    });
  });
  const client = new McpStdioClient({ command: '/fixture', callTimeoutMs: 2000,
    proc: { platform: 'linux', spawnImpl: (() => { queueMicrotask(() => p.emit('spawn')); return p; }) as unknown as typeof spawn },
  });
  cleanups.push(() => client.dispose());
  await client.connect();
  return { p, client, writes };
}
const errOf = (promise: Promise<unknown>): Promise<Error> => promise.then(() => { throw new Error('应拒绝'); }, error => error);

describe('MCP stdio 单行字节上限', () => {
  it('恰好 16 MiB 的有效 JSON 可用，CRLF 和跨 UTF-8 字节分块保持原响应', async () => {
    const { p, client, writes } = await mcp();
    const pending = client.callTool('big');
    const id = writes.at(-1)!.id;
    const start = JSON.stringify({ id, result: '' }).slice(0, -2);
    const tail = '"}\r';
    const text = '汉😀' + 'A'.repeat(LINE - Buffer.byteLength(start + tail + '汉😀'));
    const bytes = Buffer.from(start + text + tail + '\n');
    for (let i = 0; i < bytes.length; i += 65535) p.stdout.write(bytes.subarray(i, i + 65535));
    expect(await pending).toBe(text);
    expect(client.closed).toBe(false);
    expect(p.kills).toBe(0);
  });

  it.each(['single', 'chunks', 'utf8'] as const)('单行超限（%s）立即拒绝全部在途，回收一次，不被 exit 或后续数据覆盖', async mode => {
    const { p, client, writes } = await mcp();
    const ac = new AbortController();
    const first = errOf(client.callTool('one', {}, { signal: ac.signal }));
    const second = errOf(client.callTool('two'));
    if (mode === 'single') p.stdout.write('A'.repeat(LINE + 1) + '\n{"method":"late"}\n');
    else if (mode === 'chunks') {
      const block = Buffer.alloc(65536, 'A');
      for (let i = 0; i < 256; i++) p.stdout.write(block);
      expect(client.closed).toBe(false);
      p.stdout.write('X');
    } else p.stdout.write('汉'.repeat(Math.floor(LINE / 3) + 1));
    const e1 = await first; const e2 = await second;
    expect(e1.message).toBe('MCP server 单行响应超过 16 MiB 上限，连接已断开');
    expect(e2).toBe(e1);
    expect(client.closed).toBe(true);
    await client.dispose();
    expect(p.kills).toBe(1);
    const count = writes.length; ac.abort();
    expect(writes).toHaveLength(count);
    expect(await errOf(client.callTool('again'))).toBe(e1);
    expect(client.garbageLines).toBe(0);
  });

  it('同一 chunk 合计超过 16 MiB、各行低于上限：通知和两条并发响应全部保留', async () => {
    const { p, client, writes } = await mcp();
    const notes: string[] = []; client.onNotification = n => notes.push(n.method);
    const a = client.callTool('a'); const aId = writes.at(-1)!.id;
    const b = client.callTool('b'); const bId = writes.at(-1)!.id;
    const notification = JSON.stringify({ method: 'large', params: 'A'.repeat(6 * 1024 * 1024) }) + '\n';
    p.stdout.write(notification.repeat(3) + JSON.stringify({ id: bId, result: 'b' }) + '\n' + JSON.stringify({ id: aId, result: 'a' }) + '\n');
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(notes).toEqual(['large', 'large', 'large']);
    expect(client.closed).toBe(false);
    expect(p.kills).toBe(0);
  });

  it('坏 UTF-8 垃圾行仍按原始字节计数，16 MiB 未超限，下一行响应正常', async () => {
    const { p, client, writes } = await mcp();
    const pending = client.callTool('echo'); const id = writes.at(-1)!.id;
    const block = Buffer.alloc(65536, 0xff);
    for (let i = 0; i < 256; i++) p.stdout.write(block);
    p.stdout.write('\n' + JSON.stringify({ id, result: 'alive' }) + '\n');
    expect(await pending).toBe('alive');
    expect(client.garbageLines).toBe(1);
    expect(client.closed).toBe(false);
  });

  it('启动握手期间无换行的大响应同样拒绝并回收', async () => {
    let process: ReturnType<typeof child> | undefined;
    const error = await errOf(mcp(p => { process = p; p.stdout.write('A'.repeat(LINE + 1)); }));
    expect(error.message).toBe('MCP server 单行响应超过 16 MiB 上限，连接已断开');
    expect(process?.kills).toBe(1);
  });

  it('真实 MCP 进程连续写出超限无换行数据：调用明确失败且进程实际被回收', async () => {
    let exited: Promise<void> | undefined;
    const client = new McpStdioClient({ command: process.execPath,
      args: [join(__dirname, 'mcp-output-fixture.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' },
      proc: { spawnImpl: ((command: string, args: string[], options: SpawnOptions) => {
        const spawned = spawn(command, args, options);
        if (args.includes(join(__dirname, 'mcp-output-fixture.mjs'))) {
          exited = new Promise(resolve => spawned.once('exit', () => resolve()));
        }
        return spawned;
      }) as typeof spawn },
    });
    cleanups.push(() => client.dispose());
    await client.connect();
    const error = await errOf(client.callTool('flood'));
    expect(error.message).toBe('MCP server 单行响应超过 16 MiB 上限，连接已断开');
    await client.dispose();
    // taskkill 完成与 Node 收到目标的 exit 是两个事件；等真实退出事件，不猜时间。
    expect(exited).toBeDefined();
    await exited;
    expect(client.closed).toBe(true);
    expect(client.exitCode !== null || client.signalCode !== null).toBe(true);
  });
});
