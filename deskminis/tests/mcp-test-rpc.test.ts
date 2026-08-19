/** D6 MCP 试连 RPC（mcp.servers.test）+ mcp.servers.list 的 configError 布尔化脱敏。
 *  试连走独立临时 client：不进 manager 运行时、不注册工具、不落库；
 *  configError 是 D2 审核备忘的脱敏落实——parse 异常原文可能带文件片段（内含明文 headers），不出 minisd。
 *  boot minisd 集成模式照 web-search.test.ts（startMinisd + ws JSON-RPC）。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

/** 真起 fixture 子进程的 stdio 字段：electron 以 ELECTRON_RUN_AS_NODE=1 跑成 node */
const FIXTURE = join(__dirname, 'mcp-stdio-server.mjs');
const STDIO_FIELDS = { command: process.execPath, args: [FIXTURE], env: { ELECTRON_RUN_AS_NODE: '1' } };

interface Boot {
  dataDir: string;
  srv: { port: number; close(): Promise<void> };
  ws: WebSocket;
  call: (method: string, params?: unknown) => Promise<any>;
}

/** serversJson 必须在 startMinisd 之前落盘——McpServersStore 构造时一次性 load */
async function boot(serversJson: string | undefined): Promise<Boot> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-mcptest-'));
  if (serversJson !== undefined) {
    mkdirSync(join(dataDir, 'mcp-servers'), { recursive: true });
    writeFileSync(join(dataDir, 'mcp-servers', 'servers.json'), serversJson, 'utf8');
  }
  const { startMinisd } = await import('../src/minisd/index');
  process.env.DESKMINIS_TEST = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/?token=${encodeURIComponent(srv.authToken)}`);
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  const call = (method: string, params?: unknown) => new Promise<any>(res => {
    const id = Math.random().toString(36).slice(2);
    const onMsg = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.id === id) { ws.off('message', onMsg); res(msg); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  return { dataDir, srv, ws, call };
}

describe('D6 mcp.servers.test 试连 RPC', () => {
  let b: Boot;
  beforeAll(async () => {
    b = await boot(JSON.stringify({ mcpServers: { 'fixture-stdio': STDIO_FIELDS } }));
  });
  afterAll(async () => { b.ws.close(); await b.srv.close(); });

  it('1. { name } 试已存条目：ok:true 且 toolCount ≥ 1、elapsedMs 是数字', async () => {
    const r = (await b.call('mcp.servers.test', { name: 'fixture-stdio' })).result;
    expect(r.ok).toBe(true);
    expect(r.toolCount).toBeGreaterThanOrEqual(1);
    expect(typeof r.elapsedMs).toBe('number');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('2. 完整条目形态（保存前试连）：ok:true，且 servers.json 未被写入该条目', async () => {
    const r = (await b.call('mcp.servers.test', { name: 'ephemeral', ...STDIO_FIELDS })).result;
    expect(r.ok).toBe(true);
    expect(r.toolCount).toBeGreaterThanOrEqual(1);
    const text = readFileSync(join(b.dataDir, 'mcp-servers', 'servers.json'), 'utf8');
    expect(text).not.toContain('ephemeral');
  });

  it('3. 错误路径：command 指向不存在路径 → ok:false + 中文 error', async () => {
    const r = (await b.call('mcp.servers.test', {
      name: 'ghost', ...STDIO_FIELDS, command: join(b.dataDir, 'no-such-binary-xyz.exe'),
    })).result;
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error).toContain('命令不存在');
  });

  it('5. 表单校验：http 缺 url 的完整条目 → ok:false 中文校验错误（不发起连接）', async () => {
    const r = (await b.call('mcp.servers.test', { name: 'badhttp', type: 'http' })).result;
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error).toContain('必须提供');
    expect(r.error).toContain('url');
  });
});

describe('D6 mcp.servers.list configError 布尔化脱敏（4）', () => {
  it('坏 JSON 的 servers.json → configError:true 且不回显解析原文；正常文件 → false', async () => {
    const bad = await boot('{ 这不是合法 JSON, "mcpServers": {');
    try {
      const r = (await bad.call('mcp.servers.list')).result;
      expect(r.configError).toBe(true);
      // 脱敏红线：loadError 原文（含文件片段，可能带明文 headers）绝不出 minisd
      expect(JSON.stringify(r)).not.toContain('解析失败');
    } finally {
      bad.ws.close(); await bad.srv.close();
    }
    const good = await boot(JSON.stringify({ mcpServers: {} }));
    try {
      const r = (await good.call('mcp.servers.list')).result;
      expect(r.configError).toBe(false);
    } finally {
      good.ws.close(); await good.srv.close();
    }
  });
});
