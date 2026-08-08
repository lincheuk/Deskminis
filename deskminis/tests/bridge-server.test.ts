import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BridgeServer, bridgePipePath, makeBridgeEnv, resolveBridgeCliPath, resolveBridgeNode } from '../src/minisd/bridge/server';
import { encodeFrame, MAX_FRAME_BYTES } from '../src/minisd/bridge/frame';
import { okEnvelope, errEnvelope, type BridgeEnvelope } from '../src/minisd/bridge/handlers';
import { pipeRequest, uniquePipePath, startEchoServer } from './bridge-util';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe('bridgePipePath', () => {
  it('同名确定性 + 不同数据根不同管道', () => {
    const a = bridgePipePath('C:\\Data\\A');
    expect(a).toBe(bridgePipePath('C:\\Data\\A'));
    expect(a).toMatch(/^\\\\\.\\pipe\\deskminis-[0-9a-f]{8}$/);
    expect(a).not.toBe(bridgePipePath('C:\\Data\\B'));
  });

  it('大小写不敏感（Windows 路径语义）', () => {
    expect(bridgePipePath('C:\\Data\\A')).toBe(bridgePipePath('c:\\data\\a'));
  });
});

describe('BridgeServer', () => {
  it('echo 往返：args/stdin/sessionId 全保真', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const env = await pipeRequest(pipePath, {
      tool: 'windows-notify', action: 'show',
      args: { title: '标题①' }, sessionId: 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789', stdin: '多行\n载荷',
    });
    expect(env.ok).toBe(true);
    const echo = (env.data as { echo: Record<string, unknown> }).echo;
    expect(echo.tool).toBe('windows-notify');
    expect((echo.args as Record<string, string>).title).toBe('标题①');
    expect(echo.stdin).toBe('多行\n载荷');
  });

  it('半包请求：分两次写也正常应答', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const wire = encodeFrame({ tool: 't', action: 'a', args: {}, sessionId: 's' });
    const env = await new Promise<BridgeEnvelope>((resolvePromise, reject) => {
      const socket = net.connect(pipePath);
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write(wire.subarray(0, 3), () => {
          setTimeout(() => socket.write(wire.subarray(3)), 50);
        });
      });
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          socket.end();
          resolvePromise(JSON.parse(buf.subarray(4).toString('utf8')) as BridgeEnvelope);
        }
      });
    });
    expect(env.ok).toBe(true);
  });

  it('请求帧不是合法 JSON → INVALID_REQUEST 信封', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const bad = Buffer.concat([Buffer.alloc(4), Buffer.from('not-json', 'utf8')]);
    bad.writeUInt32BE(8, 0);
    const env = await new Promise<BridgeEnvelope>((resolvePromise, reject) => {
      const socket = net.connect(pipePath);
      socket.on('error', reject);
      socket.on('connect', () => socket.write(bad));
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          socket.end();
          resolvePromise(JSON.parse(buf.subarray(4).toString('utf8')) as BridgeEnvelope);
        }
      });
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_REQUEST');
  });

  it('长度头超上限 → INVALID_REQUEST 且连接关闭', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const env = await new Promise<BridgeEnvelope>((resolvePromise, reject) => {
      const socket = net.connect(pipePath);
      socket.on('error', reject);
      socket.on('connect', () => socket.write(evil));
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          resolvePromise(JSON.parse(buf.subarray(4).toString('utf8')) as BridgeEnvelope);
        }
      });
      socket.on('close', () => resolvePromise({ ok: false, tool: '', action: '', error: { code: 'CLOSED', message: '' }, timestamp: 0 }));
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code === 'INVALID_REQUEST' || env.error?.code === 'CLOSED').toBe(true);
  });

  it('dispatch 抛非 BridgeError → INTERNAL_REQUEST 级兜底 INTERNAL_ERROR 信封', async () => {
    const pipePath = uniquePipePath();
    const server = new BridgeServer(async () => { throw new Error('炸了'); });
    await server.listen(pipePath);
    cleanups.push(() => server.close());
    const env = await pipeRequest(pipePath, { tool: 't', action: 'a', args: {}, sessionId: 's' });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INTERNAL_ERROR');
    expect(env.error?.message).toContain('炸了');
  });

  it('同管道二次 listen → reject（调用方据此降级）', async () => {
    const pipePath = uniquePipePath();
    const s1 = new BridgeServer(async req => okEnvelope(req.tool, req.action, null));
    await s1.listen(pipePath);
    cleanups.push(() => s1.close());
    const s2 = new BridgeServer(async req => okEnvelope(req.tool, req.action, null));
    await expect(s2.listen(pipePath)).rejects.toThrow();
  });

  it('close 后新连接被拒', async () => {
    const { pipePath, close } = await startEchoServer();
    await close();
    await expect(pipeRequest(pipePath, { tool: 't', action: 'a', args: {}, sessionId: 's' }, 3000)).rejects.toThrow();
  });
});

describe('makeBridgeEnv', () => {
  it('桥可用：四个变量齐全', () => {
    const env = makeBridgeEnv('S1', '\\\\.\\pipe\\deskminis-abcdef01', 'C:\\app\\bridge-cli.mjs', 'C:\\electron.exe');
    expect(env).toEqual({
      MINIS_CHAT_SESSION_ID: 'S1',
      MINIS_BRIDGE_PIPE: '\\\\.\\pipe\\deskminis-abcdef01',
      MINIS_BRIDGE_CLI: 'C:\\app\\bridge-cli.mjs',
      MINIS_BRIDGE_NODE: 'C:\\electron.exe',
    });
  });

  it('桥不可用：PIPE/CLI 为空串（stub 读到空串按不可用报错）', () => {
    const env = makeBridgeEnv('S1', undefined, undefined, 'C:\\electron.exe');
    expect(env.MINIS_BRIDGE_PIPE).toBe('');
    expect(env.MINIS_BRIDGE_CLI).toBe('');
    expect(env.MINIS_CHAT_SESSION_ID).toBe('S1');
  });
});

describe('resolveBridgeCliPath', () => {
  it('仓库布局下解析到存在的 bridge-cli.mjs', () => {
    const p = resolveBridgeCliPath();
    expect(p).toBeTruthy();
    expect(p!).toMatch(/bridge-cli\.mjs$/);
  });

  it('打包态候选：给定含 bridge-cli.mjs 的资源目录，返回该 stub（Task 1）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-bridge-cli-'));
    const stub = join(dir, 'bridge-cli.mjs');
    writeFileSync(stub, 'export {};\n');
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); });
    const p = resolveBridgeCliPath(dir);
    expect(p).toBe(stub);
  });
});

describe('resolveBridgeNode', () => {
  it('返回的路径 existsSync 为真', () => {
    const p = resolveBridgeNode();
    expect(existsSync(p)).toBe(true);
  });

  it('打包态候选优先垫片：给定含 bridge-node.cmd 的资源目录，返回该垫片而非回退 process.execPath（Task 2）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-bridge-node-'));
    const shim = join(dir, 'bridge-node.cmd');
    writeFileSync(shim, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\DeskMinis.exe" %*\r\n');
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); });
    const p = resolveBridgeNode(dir);
    expect(p).toBe(shim);
  });

  it('PATH 有 node.exe 时返回真 node（而非 electron GUI PE）；PATH 缺失时退回 process.execPath', () => {
    const wh = spawnSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true });
    const firstLine = wh.status === 0 ? wh.stdout.split(/\r?\n/).map(s => s.trim()).find(s => s && existsSync(s)) : undefined;
    const p = resolveBridgeNode();
    if (firstLine) {
      // 有 node 在 PATH：resolveBridgeNode 应返回该 node.exe（basename=node.exe），而不是 electron.exe
      expect(basename(p).toLowerCase()).toBe('node.exe');
      expect(p.toLowerCase()).toBe(firstLine.toLowerCase());
    } else {
      // PATH 没有 node：退回 process.execPath（开发机少见但 CI 可能有此情况）
      expect(p).toBe(process.execPath);
    }
  });
});
