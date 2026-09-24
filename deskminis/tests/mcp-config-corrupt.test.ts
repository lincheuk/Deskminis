/** W1a-4（设计稿 §4 W1a-4 / 附录 mcp.md W1a-mcpcorrupt）：servers.json 读不出来时拒绝一切写入。
 *  旧行为：解析失败只记一笔 loadError、按空配置加载，之后第一次 upsert 就用「只有新条目」的
 *  {mcpServers} 整份覆盖原文件——用户原来的配置被静默抹掉。入口是设置页添加与市场安装。
 *  本文件钉住：
 *  ① 读取分流：ENOENT 当空配置可写；其它 errno 记 'read'（只记错误码）；剥 BOM；空文件与纯空白当空配置；
 *     JSON 语法错记 'parse'；顶层不是对象记 'shape'。
 *  ② 拒写：upsert / remove / toggle 在任何名称校验与内存改动之前被拒，文件字节不变，内存不变；
 *     save() 自己再拦一道。拒写文案是常量，绝不带出 loadError 原文（JSON.parse 的报错会带出源码片段，可能是密钥）。
 *  ③ 写盘失败时内存也不变（本步追加）：设置页开关失败后靠重拉列表回滚勾选态，只有后端内存与磁盘一致，
 *     重拉回来的才是真相。
 *  ④ RPC：mcp.servers.upsert/remove/toggle 回中文拒写错误；list 只在出错时带 configErrorKind。 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { McpServersStore } from '../src/minisd/mcp/config';
import { MinisPaths } from '../src/minisd/paths';

function mkRoot(): string { return mkdtempSync(join(tmpdir(), 'dm-mcpbad-')); }
function cfgFile(root: string): string { return join(root, 'mcp-servers', 'servers.json'); }
/** 原样落盘（字符串或字节）后再构造 store：这里测的是构造时那一次读盘（W1a-5 起写前与 refresh 也会重读，见 mcp-config-stale） */
function seedRaw(root: string, content: string | Buffer): McpServersStore {
  mkdirSync(join(root, 'mcp-servers'), { recursive: true });
  writeFileSync(cfgFile(root), content);
  return new McpServersStore(new MinisPaths(root));
}
const BAD_JSON = '{ 这根本不是 json';

describe('W1a-4 ① 读取分流', () => {
  it('没有文件（ENOENT）：loadError 为 undefined，upsert 能建出文件（首次运行的正常路径，回归钉）', () => {
    const root = mkRoot();
    const store = new McpServersStore(new MinisPaths(root));
    expect(store.loadError).toBeUndefined();
    expect(store.loadErrorKind).toBeUndefined();
    store.upsert({ name: 'a', command: 'x' });
    const raw = JSON.parse(readFileSync(cfgFile(root), 'utf8'));
    expect(Object.keys(raw.mcpServers)).toEqual(['a']);
  });

  it('带 UTF-8 BOM 的合法文件（记事本另存）照常加载，且可写', () => {
    const root = mkRoot();
    const store = seedRaw(root, '﻿{"mcpServers":{"a":{"command":"x"}}}');
    expect(store.list().map(s => s.name)).toEqual(['a']);
    expect(store.loadError).toBeUndefined();
    expect(store.loadErrorKind).toBeUndefined();
    store.upsert({ name: 'b', command: 'y' });
    const raw = JSON.parse(readFileSync(cfgFile(root), 'utf8'));
    expect(Object.keys(raw.mcpServers)).toEqual(['a', 'b']);
  });

  it.each([
    ['0 字节', ''],
    ['只有空白', '  \n\t\r\n  '],
    ['只有 BOM', '﻿'],
    ['BOM 加空白', '﻿ \r\n '],
  ])('%s的文件当可写的空配置：没有数据可丢，拒写只会让用户卡住', (_label, content) => {
    const root = mkRoot();
    const store = seedRaw(root, content);
    expect(store.list()).toEqual([]);
    expect(store.loadError).toBeUndefined();
    expect(store.loadErrorKind).toBeUndefined();
    store.upsert({ name: 'a', command: 'x' });
    const raw = JSON.parse(readFileSync(cfgFile(root), 'utf8'));
    expect(Object.keys(raw.mcpServers)).toEqual(['a']);
  });

  it("JSON 语法错：loadErrorKind === 'parse'", () => {
    const store = seedRaw(mkRoot(), BAD_JSON);
    expect(store.loadErrorKind).toBe('parse');
    expect(store.loadError).toBeTruthy();
    expect(store.list()).toEqual([]);
  });

  it("servers.json 是个目录（EISDIR）：loadErrorKind === 'read'，loadError 只记错误码、不再冒充「解析失败」", () => {
    // 容器里是 root，chmod 000 挡不住读，所以用目录触发非 ENOENT 的读错误
    const root = mkRoot();
    mkdirSync(cfgFile(root), { recursive: true });
    const store = new McpServersStore(new MinisPaths(root));
    expect(store.loadErrorKind).toBe('read');
    expect(store.loadError).toBe('servers.json 读取失败: EISDIR');
    expect(store.loadError).not.toContain('解析失败');
    expect(store.list()).toEqual([]);
  });
});

describe('W1a-4 ② 损坏时拒绝一切写入', () => {
  it('坏 JSON 下 upsert 被拒，文件逐字节不变', () => {
    const root = mkRoot();
    const store = seedRaw(root, BAD_JSON);
    const before = readFileSync(cfgFile(root));
    expect(() => store.upsert({ name: 'a', command: 'x' })).toThrow(/servers\.json/);
    expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);
    expect(existsSync(cfgFile(root) + '.tmp')).toBe(false);
  });

  it('坏 JSON 下 remove / toggle（名字不存在）也抛拒写错误，不再静默成功或报「不存在」', () => {
    const root = mkRoot();
    const store = seedRaw(root, BAD_JSON);
    const before = readFileSync(cfgFile(root));
    expect(() => store.remove('a')).toThrow(/servers\.json/);
    expect(() => store.toggle('a', false)).toThrow(/servers\.json/);
    expect(() => store.toggle('a', false)).not.toThrow(/不存在/);
    expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);
  });

  it('名称校验也排在拒写之后：空名字同样报拒写，而不是「名称不能为空」', () => {
    const store = seedRaw(mkRoot(), BAD_JSON);
    expect(() => store.upsert({ name: '' })).toThrow(/servers\.json/);
  });

  it('拒写之后内存也没动：list() 仍为 []（闸若只放在 save() 里，内存会先被改掉）', () => {
    const store = seedRaw(mkRoot(), BAD_JSON);
    expect(() => store.upsert({ name: 'a', command: 'x' })).toThrow(/servers\.json/);
    expect(store.list()).toEqual([]);
  });

  it("顶层是 [] 时 loadErrorKind === 'shape'，upsert 被拒，文件字节不变", () => {
    const root = mkRoot();
    const store = seedRaw(root, '[]');
    expect(store.loadErrorKind).toBe('shape');
    const before = readFileSync(cfgFile(root));
    expect(() => store.upsert({ name: 'a', command: 'x' })).toThrow(/servers\.json/);
    expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);
  });

  it('read 类（EISDIR）：三个写方法都被拒，文案说「无法读取」并带错误码，目录原样还在', () => {
    const root = mkRoot();
    mkdirSync(cfgFile(root), { recursive: true });
    const store = new McpServersStore(new MinisPaths(root));
    const err = (() => { try { store.upsert({ name: 'a', command: 'x' }); } catch (e) { return e as Error; } })();
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/servers\.json 无法读取（EISDIR）/);
    expect(() => store.remove('a')).toThrow(/servers\.json 无法读取/);
    expect(() => store.toggle('a', true)).toThrow(/servers\.json 无法读取/);
    expect(existsSync(cfgFile(root) + '.tmp')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('parse / shape 的拒写文案是固定中文句子，指明修好后回到这页即可', () => {
    // W1a-5 重指：末句原为「请修好这个文件后重启 DeskMinis。」。写前与 list 前都会重读磁盘之后，
    // 修好文件不用重启，这句改成「修好后回到这页即可。」（附录 mcp.md W1a-mcpcorrupt 文案建议的末条）
    const store = seedRaw(mkRoot(), BAD_JSON);
    const err = (() => { try { store.upsert({ name: 'a', command: 'x' }); } catch (e) { return e as Error; } })();
    expect(err!.message).toBe('servers.json 格式有误。为免覆盖你原来的配置，MCP 服务器暂时不能添加、修改、启停或删除。修好后回到这页即可。');
    const shape = seedRaw(mkRoot(), '"just a string"');
    expect(shape.loadErrorKind).toBe('shape');
    expect(() => shape.upsert({ name: 'a', command: 'x' })).toThrow(err!.message);
  });

  it('拒写文案不带出 loadError 原文：JSON.parse 的报错会带出源码上下文（可能是密钥片段）', () => {
    const store = seedRaw(mkRoot(), '{"mcpServers":{"a":{"env":{"TOKEN":"sk-SECRET789"}, "x": undefined}}}');
    expect(store.loadErrorKind).toBe('parse');
    let msg = '';
    try { store.upsert({ name: 'b', command: 'y' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/servers\.json/);
    expect(msg).not.toContain('SECRET');
    expect(msg).not.toContain('undefined}');
  });

  it('第二道防线：绕过公开方法直接调 save() 也被拒，文件字节不变', () => {
    const root = mkRoot();
    const store = seedRaw(root, BAD_JSON);
    const before = readFileSync(cfgFile(root));
    expect(() => (store as unknown as { save(): void }).save()).toThrow(/servers\.json/);
    expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);
  });
});

describe('W1a-4 ③ 写盘失败时内存不变（设置页开关回滚靠重拉列表，后端内存必须与磁盘一致）', () => {
  it('servers.json.tmp 被占成目录 → upsert / toggle / remove 都抛错，list() 与文件字节都不变；挪开后照常可写', () => {
    const root = mkRoot();
    const store = seedRaw(root, JSON.stringify({ mcpServers: { a: { command: 'x' } } }, null, 2));
    const before = readFileSync(cfgFile(root));
    const snapshot = store.list();
    mkdirSync(cfgFile(root) + '.tmp');

    expect(() => store.toggle('a', false)).toThrow();
    expect(store.list()).toEqual(snapshot);           // enabled 仍为 true，updatedAt 没被改
    expect(() => store.upsert({ name: 'b', command: 'y' })).toThrow();
    expect(store.list().map(s => s.name)).toEqual(['a']);
    expect(() => store.remove('a')).toThrow();
    expect(store.list()).toEqual(snapshot);
    expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);

    rmdirSync(cfgFile(root) + '.tmp');
    store.toggle('a', false);
    expect(store.list()[0].enabled).toBe(false);
    const reopened = new McpServersStore(new MinisPaths(root));
    expect(reopened.list()[0].enabled).toBe(false);
  });
});

// ── ④ RPC：boot minisd 集成模式照 mcp-test-rpc.test.ts ──
interface Boot {
  dataDir: string;
  srv: { port: number; close(): Promise<void> };
  ws: WebSocket;
  call: (method: string, params?: unknown) => Promise<any>;
}
/** 在 startMinisd 之前落盘：测的是启动时就读到坏文件（启动后才改文件的情形见 mcp-config-stale 的 RPC 例） */
async function boot(prepare: (mcpDir: string) => void): Promise<Boot> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-mcpbadrpc-'));
  const mcpDir = join(dataDir, 'mcp-servers');
  mkdirSync(mcpDir, { recursive: true });
  prepare(mcpDir);
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

describe('W1a-4 ④ RPC', () => {
  it("坏 JSON 启动：upsert/remove/toggle 回中文拒写错误、文件不变；list 带 configError:true 与 configErrorKind:'parse'，不含原文", async () => {
    const SECRET_JSON = '{"mcpServers":{"a":{"env":{"TOKEN":"sk-SECRET789"}, "x": undefined}}}';
    const b = await boot(dir => writeFileSync(join(dir, 'servers.json'), SECRET_JSON, 'utf8'));
    try {
      const file = join(b.dataDir, 'mcp-servers', 'servers.json');
      const before = readFileSync(file);
      const up = await b.call('mcp.servers.upsert', { name: 'a', command: 'x' });
      expect(up.result).toBeUndefined();
      expect(up.error?.message).toMatch(/servers\.json/);
      expect(up.error?.message).not.toContain('SECRET');
      const rm = await b.call('mcp.servers.remove', { name: 'a' });
      expect(rm.error?.message).toMatch(/servers\.json/);
      const tg = await b.call('mcp.servers.toggle', { name: 'a', enabled: false });
      expect(tg.error?.message).toMatch(/servers\.json/);
      expect(readFileSync(file).equals(before)).toBe(true);

      const r = (await b.call('mcp.servers.list')).result;
      expect(r.configError).toBe(true);
      expect(r.configErrorKind).toBe('parse');
      expect(r.servers).toEqual([]);
      const text = JSON.stringify(r);
      expect(text).not.toContain('解析失败');
      expect(text).not.toContain('SECRET');
    } finally {
      b.ws.close(); await b.srv.close();
    }
  });

  it("servers.json 是目录：list 带 configErrorKind:'read'；正常文件：list 不带 configErrorKind 键", async () => {
    const bad = await boot(dir => mkdirSync(join(dir, 'servers.json')));
    try {
      const r = (await bad.call('mcp.servers.list')).result;
      expect(r.configError).toBe(true);
      expect(r.configErrorKind).toBe('read');
    } finally {
      bad.ws.close(); await bad.srv.close();
    }
    const good = await boot(dir => writeFileSync(join(dir, 'servers.json'), JSON.stringify({ mcpServers: {} }), 'utf8'));
    try {
      const r = (await good.call('mcp.servers.list')).result;
      expect(r.configError).toBe(false);
      expect('configErrorKind' in r).toBe(false);
    } finally {
      good.ws.close(); await good.srv.close();
    }
  });
});
