/** D2 MCP 配置与存储：servers.json 三变体宽容导入（标准 mcpServers / 裸 map / 单裸条目）、
 *  原子写、条目归一（extra 收容未知字段，写回不丢数据）、CRUD 校验、
 *  $$VAR 环境变量引用解析 helper、mcp.servers.* RPC 全链路。 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { McpServersStore, resolveEnvRefs } from '../src/minisd/mcp/config';
import { MinisPaths } from '../src/minisd/paths';

function mkRoot(): string { return mkdtempSync(join(tmpdir(), 'dm-mcp-')); }
function cfgFile(root: string): string { return join(root, 'mcp-servers', 'servers.json'); }
/** 先落配置文件再构造 store——变体导入测试的播种器 */
function seed(root: string, obj: unknown): McpServersStore {
  mkdirSync(join(root, 'mcp-servers'), { recursive: true });
  writeFileSync(cfgFile(root), JSON.stringify(obj, null, 2), 'utf8');
  return new McpServersStore(new MinisPaths(root));
}
const mkStore = () => new McpServersStore(new MinisPaths(mkRoot()));

describe('标准形态导入与 roundtrip（1）', () => {
  it('标准形态导入：未知字段（oauth）进 extra，enabled 缺省 true', () => {
    const store = seed(mkRoot(), {
      mcpServers: {
        claude: { command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' }, note: '备注', oauth: { provider: 'google', refresh_token: 'r1' } },
      },
    });
    const e = store.list()[0];
    expect(e).toMatchObject({ name: 'claude', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' }, note: '备注', enabled: true });
    expect(e.extra).toEqual({ oauth: { provider: 'google', refresh_token: 'r1' } });
  });

  it('roundtrip：upsert 另一条后写回，原条目 oauth 字段仍在文件里，且始终写标准形态', () => {
    const root = mkRoot();
    const store = seed(root, {
      mcpServers: { claude: { command: 'npx', oauth: { provider: 'google', refresh_token: 'r1' } } },
    });
    store.upsert({ name: 'remote', url: 'https://mcp.example/api' });
    const raw = JSON.parse(readFileSync(cfgFile(root), 'utf8'));
    expect(Object.keys(raw)).toEqual(['mcpServers']);
    expect(raw.mcpServers.claude.oauth).toEqual({ provider: 'google', refresh_token: 'r1' });
    expect(raw.mcpServers.remote.url).toBe('https://mcp.example/api');
  });

  it('持久化：重开 store 读回一致（含 extra）', () => {
    const root = mkRoot();
    const store = seed(root, {
      mcpServers: { claude: { command: 'npx', oauth: { provider: 'google' } } },
    });
    store.upsert({ name: 'remote', url: 'https://mcp.example/api' });
    const reopened = new McpServersStore(new MinisPaths(root));
    expect(reopened.list().map(s => s.name)).toEqual(['claude', 'remote']);
    expect(reopened.list()[0].extra).toEqual({ oauth: { provider: 'google' } });
  });
});

describe('变体宽容导入（2-3）', () => {
  it('变体②：裸名字键控 map（非对象的杂项值跳过）', () => {
    const store = seed(mkRoot(), {
      fs: { command: 'npx', args: ['-y', 'fs-mcp'] },
      stray: 'not-an-object',
      web: { url: 'https://w.example/api' },
    });
    const list = store.list();
    expect(list.map(s => s.name)).toEqual(['fs', 'web']);
    expect(list.map(s => s.transport)).toEqual(['stdio', 'streamable-http']);
  });

  it('变体③：单裸条目，name 取 default', () => {
    const store = seed(mkRoot(), { command: 'node', args: ['server.js'] });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ name: 'default', transport: 'stdio', command: 'node', args: ['server.js'] });
  });
});

describe('enabled 兼容（4）', () => {
  it('disabled:true → enabled:false', () => {
    const store = seed(mkRoot(), { mcpServers: { a: { command: 'x', disabled: true } } });
    expect(store.list()[0].enabled).toBe(false);
  });

  it('enabled 缺省 true；显式 enabled:false 保留', () => {
    const store = seed(mkRoot(), { mcpServers: { a: { command: 'x' }, b: { command: 'y', enabled: false } } });
    const byName = Object.fromEntries(store.list().map(s => [s.name, s.enabled]));
    expect(byName.a).toBe(true);
    expect(byName.b).toBe(false);
  });
});

describe('判型全表（5）', () => {
  it('command → stdio', () => {
    const store = seed(mkRoot(), { mcpServers: { a: { command: 'node' } } });
    expect(store.list()[0].transport).toBe('stdio');
  });

  it('url → streamable-http', () => {
    const store = seed(mkRoot(), { mcpServers: { a: { url: 'https://x.example' } } });
    expect(store.list()[0].transport).toBe('streamable-http');
  });

  it.each(['http', 'streamable-http', 'streamable_http', 'sse'])('type=%s 归一为 streamable-http', (t) => {
    const store = seed(mkRoot(), { mcpServers: { a: { url: 'https://x.example', type: t } } });
    expect(store.list()[0].transport).toBe('streamable-http');
  });
});

describe('坏条目与坏文件容错（6）', () => {
  it('坏条目跳过：command 为数字，正常条照常加载', () => {
    const store = seed(mkRoot(), { mcpServers: { bad: { command: 123 }, good: { command: 'node' } } });
    expect(store.list().map(s => s.name)).toEqual(['good']);
  });

  it('坏条目跳过：空名字键', () => {
    const store = seed(mkRoot(), { mcpServers: { '': { command: 'node' }, ok: { command: 'go' } } });
    expect(store.list().map(s => s.name)).toEqual(['ok']);
  });

  it('整文件坏 JSON → 空配置 + loadError 非空，构造不抛', () => {
    const root = mkRoot();
    mkdirSync(join(root, 'mcp-servers'), { recursive: true });
    writeFileSync(cfgFile(root), '{ 这根本不是 json');
    const store = new McpServersStore(new MinisPaths(root));
    expect(store.list()).toEqual([]);
    expect(store.loadError).toBeTruthy();
  });
});

describe('原子写（7）', () => {
  it('save 后目标文件是合法 JSON 且 .tmp 不残留', () => {
    const root = mkRoot();
    const store = new McpServersStore(new MinisPaths(root));
    store.upsert({ name: 'a', command: 'x' });
    expect(() => JSON.parse(readFileSync(cfgFile(root), 'utf8'))).not.toThrow();
    expect(readdirSync(join(root, 'mcp-servers'))).not.toContain('servers.json.tmp');
  });
});

describe('upsert 时间戳（8）', () => {
  it('新增补 createdAt/updatedAt（ISO 串）', () => {
    const store = mkStore();
    store.upsert({ name: 'a', command: 'x' });
    const e = store.list()[0];
    expect(e.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(e.updatedAt).toBe(e.createdAt);
  });

  it('更新只动 updatedAt，createdAt 与 extra 保留', async () => {
    const store = mkStore();
    store.upsert({ name: 'a', command: 'x', oauth: { p: 'g' } }); // 新增：补时间戳，oauth 进 extra
    const before = store.list()[0];
    await new Promise(r => setTimeout(r, 10)); // 确保时间戳可分辨
    store.upsert({ name: 'a', command: 'y' });
    const after = store.list()[0];
    expect(after.command).toBe('y');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after.extra).toEqual({ oauth: { p: 'g' } });
  });
});

describe('upsert 校验（9）', () => {
  it('name 为空 → 中文错误', () => {
    const store = mkStore();
    expect(() => store.upsert({ name: '', command: 'x' })).toThrow(/名称/);
    expect(() => store.upsert({ command: 'x' })).toThrow(/名称/);
  });

  it('stdio 缺 command → 中文错误', () => {
    const store = mkStore();
    expect(() => store.upsert({ name: 'a' })).toThrow(/command/);
  });

  it('streamable-http 缺 url → 中文错误', () => {
    const store = mkStore();
    expect(() => store.upsert({ name: 'a', type: 'http' })).toThrow(/url/);
  });
});

describe('remove 与 toggle（10）', () => {
  it('remove 删除条目并落盘', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' }, b: { command: 'y' } } });
    store.remove('a');
    expect(store.list().map(s => s.name)).toEqual(['b']);
    const raw = JSON.parse(readFileSync(cfgFile(root), 'utf8'));
    expect(Object.keys(raw.mcpServers)).toEqual(['b']);
  });

  it('toggle 翻转 enabled 并持久化', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    store.toggle('a', false);
    expect(store.list()[0].enabled).toBe(false);
    const reopened = new McpServersStore(new MinisPaths(root));
    expect(reopened.list()[0].enabled).toBe(false);
  });

  it('toggle 不存在的 name → 中文错误', () => {
    const store = mkStore();
    expect(() => store.toggle('ghost', false)).toThrow(/不存在/);
  });
});

describe('list 顺序（11）', () => {
  it('list 保持文件键序', () => {
    const store = seed(mkRoot(), { mcpServers: { zeta: { command: '1' }, alpha: { command: '2' }, mid: { command: '3' } } });
    expect(store.list().map(s => s.name)).toEqual(['zeta', 'alpha', 'mid']);
  });
});

describe('resolveEnvRefs（12）', () => {
  it('整值引用', () => {
    expect(resolveEnvRefs('$$TOK', { TOK: 'abc' })).toBe('abc');
  });

  it('嵌入中间（Bearer $$TOK）', () => {
    expect(resolveEnvRefs('Bearer $$TOK', { TOK: 'abc' })).toBe('Bearer abc');
  });

  it('一串多引用', () => {
    expect(resolveEnvRefs('$$A:$$B@$$C', { A: '1', B: '2', C: '3' })).toBe('1:2@3');
  });

  it('未设置变量抛错：错误信息含引用名，绝不含任何已解析值', () => {
    const env = { SET_ONE: 'SECRET-RESOLVED-VALUE' };
    try {
      resolveEnvRefs('$$SET_ONE and $$MISSING', env);
      expect.unreachable('应当抛错');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain('$$MISSING');
      expect(msg).not.toContain('SECRET-RESOLVED-VALUE');
    }
  });
});

describe('mcp.servers.* RPC（13：upsert → list → toggle → remove 全链路）', () => {
  it('WebSocket RPC 全过；list 返回 headers 原文（$$VAR 不解析）', async () => {
    const { startMinisd } = await import('../src/minisd/index');
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-mcprpc-'));
    process.env.DESKMINIS_TEST = '1';
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    try {
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

      expect((await call('mcp.servers.list')).result).toEqual({ servers: [] });

      const up = await call('mcp.servers.upsert', {
        name: 'remote', url: 'https://mcp.example/api', headers: { Authorization: 'Bearer $$TOK' },
      });
      expect(up.result).toEqual({ ok: true });

      const lst = (await call('mcp.servers.list')).result;
      expect(lst.servers).toHaveLength(1);
      expect(lst.servers[0]).toMatchObject({ name: 'remote', transport: 'streamable-http', enabled: true });
      // $$VAR 原样返回不解析——渲染端展示引用名本身是安全的
      expect(lst.servers[0].headers).toEqual({ Authorization: 'Bearer $$TOK' });

      expect((await call('mcp.servers.toggle', { name: 'remote', enabled: false })).result).toEqual({ ok: true });
      expect((await call('mcp.servers.list')).result.servers[0].enabled).toBe(false);

      expect((await call('mcp.servers.remove', { name: 'remote' })).result).toEqual({ ok: true });
      expect((await call('mcp.servers.list')).result).toEqual({ servers: [] });
      ws.close();
    } finally {
      await srv.close();
    }
  });
});
