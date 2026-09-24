/** W1a-5（设计稿 §4 W1a-5 / 附录 mcp.md W1a-mcpstale / cross.md S4）：应用开着时手改的 servers.json 不被覆盖。
 *  旧行为：McpServersStore 只在构造时读一次盘，save 把内存副本整份写回。可设置页没有 env / headers 编辑器，
 *  参数框下的提示也叫用户「要带空格的参数请直接改 servers.json」——应用开着时改完，只要在界面上随手启停任意一台、
 *  或者在市场装一个，手改的内容就被旧副本盖掉。
 *  本文件钉住：
 *  ① 写前对比磁盘：upsert / remove / toggle 先重读，磁盘和上次读到或写出的不一样就整份重载，
 *     改动落在新读到的内容上；重读发现文件坏了，照 W1a-4 拒写，文件字节不动。
 *  ② refresh()：只读不写；外部写坏后进入拒写态，修好后自愈（不用重启）——read 类（权限、占用）同样自愈。
 *  ③ 拒写文案的末句从「重启」改为「修好后回到这页即可」：有了 ① ② 这句才是真话。
 *  ④ RPC：mcp.servers.list 先 refresh，设置页每次打开都看到磁盘现状。 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { McpServersStore } from '../src/minisd/mcp/config';
import { MinisPaths } from '../src/minisd/paths';

function mkRoot(): string { return mkdtempSync(join(tmpdir(), 'dm-mcpstale-')); }
function cfgFile(root: string): string { return join(root, 'mcp-servers', 'servers.json'); }
function writeCfg(root: string, obj: unknown): void {
  mkdirSync(join(root, 'mcp-servers'), { recursive: true });
  writeFileSync(cfgFile(root), JSON.stringify(obj, null, 2), 'utf8');
}
function seed(root: string, obj: unknown): McpServersStore {
  writeCfg(root, obj);
  return new McpServersStore(new MinisPaths(root));
}
const readCfg = (root: string) => JSON.parse(readFileSync(cfgFile(root), 'utf8'));
const BAD_JSON = '{ 这根本不是 json';
/** 用户在应用开着时手改：给 a 加 env，再加一台 b（设置页没有 env 编辑器，只能这么改） */
const HAND_EDITED = { mcpServers: { a: { command: 'x', env: { T: '1' } }, b: { url: 'https://b.example/mcp' } } };

describe('W1a-5 ① 写前对比磁盘：外部修改不被内存旧副本覆盖', () => {
  it('toggle：手改的 env 与新增的 b 都留在文件里，toggle 落在新内容上（附录先红例）', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    writeCfg(root, HAND_EDITED);
    store.toggle('a', false);
    const reopened = new McpServersStore(new MinisPaths(root));
    const a = reopened.list().find(s => s.name === 'a')!;
    expect(a.env).toEqual({ T: '1' });
    expect(a.enabled).toBe(false);
    expect(reopened.list().map(s => s.name)).toEqual(['a', 'b']);
    // 内存也换成了新内容，不是只把文件写对
    expect(store.list().map(s => s.name)).toEqual(['a', 'b']);
  });

  it('upsert 新条目：手改的内容一并保留', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    writeCfg(root, HAND_EDITED);
    store.upsert({ name: 'c', command: 'z' });
    const raw = readCfg(root);
    expect(Object.keys(raw.mcpServers)).toEqual(['a', 'b', 'c']);
    expect(raw.mcpServers.a.env).toEqual({ T: '1' });
  });

  it('remove：删 a 之后，手加的 b 还在', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    writeCfg(root, HAND_EDITED);
    store.remove('a');
    expect(Object.keys(readCfg(root).mcpServers)).toEqual(['b']);
  });

  it('toggle 一台已被手删的服务器：报「不存在」，文件不被旧副本复活', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' }, b: { command: 'y' } } });
    writeCfg(root, { mcpServers: { b: { command: 'y' } } });
    const before = readFileSync(cfgFile(root));
    expect(() => store.toggle('a', false)).toThrow(/不存在/);
    expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);
  });

  it('构造之后在外部把文件写坏：三个写方法都拒写，文件字节不变（附录先红例）', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    writeFileSync(cfgFile(root), BAD_JSON);
    const before = readFileSync(cfgFile(root));
    expect(() => store.upsert({ name: 'z', command: 'y' })).toThrow(/servers\.json/);
    expect(() => store.toggle('a', false)).toThrow(/servers\.json/);
    expect(() => store.remove('a')).toThrow(/servers\.json/);
    expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);
    expect(existsSync(cfgFile(root) + '.tmp')).toBe(false);
    expect(store.loadErrorKind).toBe('parse');
    expect(store.list()).toEqual([]);
  });

  it('启动时是坏的，修好之后直接能写，不用重启；写出的是修好后的内容加这次改动', () => {
    const root = mkRoot();
    mkdirSync(join(root, 'mcp-servers'), { recursive: true });
    writeFileSync(cfgFile(root), BAD_JSON);
    const store = new McpServersStore(new MinisPaths(root));
    expect(store.loadErrorKind).toBe('parse');
    writeCfg(root, HAND_EDITED);
    store.upsert({ name: 'c', command: 'z' });
    expect(store.loadError).toBeUndefined();
    expect(store.loadErrorKind).toBeUndefined();
    const raw = readCfg(root);
    expect(Object.keys(raw.mcpServers)).toEqual(['a', 'b', 'c']);
    expect(raw.mcpServers.a.env).toEqual({ T: '1' });
  });

  it('我方写过之后，编辑器把启动时的原文原样存回来：也算外部修改（对比基准是最近一次写出的内容，不是启动时读到的）', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    const original = readFileSync(cfgFile(root));
    store.upsert({ name: 'b', command: 'y' });
    // 用户的编辑器里还开着启动时那份内容，直接保存：b 被用户删回去了
    writeFileSync(cfgFile(root), original);
    store.toggle('a', false);
    const raw = readCfg(root);
    expect(Object.keys(raw.mcpServers)).toEqual(['a']);
    expect(raw.mcpServers.a.enabled).toBe(false);
  });

  it('文件被手删：当空配置（与首次运行一致），不拿旧副本把删掉的条目写回去', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    rmSync(cfgFile(root));
    store.upsert({ name: 'c', command: 'z' });
    expect(Object.keys(readCfg(root).mcpServers)).toEqual(['c']);
  });

  it('外部改成带 BOM 的合法文件（记事本另存）：照常重读、照常可写', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    writeFileSync(cfgFile(root), '﻿' + JSON.stringify(HAND_EDITED), 'utf8');
    store.toggle('b', false);
    const raw = readCfg(root);
    expect(Object.keys(raw.mcpServers)).toEqual(['a', 'b']);
    expect(raw.mcpServers.b.enabled).toBe(false);
  });
});

describe('W1a-5 ② refresh()：只读不写，坏了拒写、修好自愈', () => {
  it('外部新增的条目 refresh 后可见，且 refresh 不碰文件', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    // 带 BOM 与缩进的原文：refresh 若顺手写回，字节就会变
    writeFileSync(cfgFile(root), '﻿' + JSON.stringify(HAND_EDITED, null, 4), 'utf8');
    const before = readFileSync(cfgFile(root));
    store.refresh();
    expect(store.list().map(s => s.name)).toEqual(['a', 'b']);
    expect(store.list()[0].env).toEqual({ T: '1' });
    expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);
    expect(existsSync(cfgFile(root) + '.tmp')).toBe(false);
  });

  it('外部写坏 → refresh 进入拒写态；修好 → refresh 清掉错误、列表回来、可写', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    writeFileSync(cfgFile(root), BAD_JSON);
    store.refresh();
    expect(store.loadErrorKind).toBe('parse');
    expect(store.loadError).toBeTruthy();
    expect(store.list()).toEqual([]);
    expect(() => store.toggle('a', false)).toThrow(/servers\.json/);

    writeCfg(root, HAND_EDITED);
    store.refresh();
    expect(store.loadErrorKind).toBeUndefined();
    expect(store.loadError).toBeUndefined();
    expect(store.loadErrorCode).toBeUndefined();
    expect(store.list().map(s => s.name)).toEqual(['a', 'b']);
    store.toggle('a', false);
    expect(readCfg(root).mcpServers.a.enabled).toBe(false);
  });

  it('read 类（servers.json 是目录）同样自愈：挪走目录、放回合法文件后 refresh 即可写', () => {
    const root = mkRoot();
    mkdirSync(cfgFile(root), { recursive: true });
    const store = new McpServersStore(new MinisPaths(root));
    expect(store.loadErrorKind).toBe('read');
    store.refresh();
    expect(store.loadErrorKind).toBe('read');
    expect(store.loadErrorCode).toBe('EISDIR');

    rmdirSync(cfgFile(root));
    writeCfg(root, { mcpServers: { a: { command: 'x' } } });
    store.refresh();
    expect(store.loadErrorKind).toBeUndefined();
    expect(store.loadErrorCode).toBeUndefined();
    expect(store.list().map(s => s.name)).toEqual(['a']);
    store.upsert({ name: 'b', command: 'y' });
    expect(Object.keys(readCfg(root).mcpServers)).toEqual(['a', 'b']);
  });

  it('自己刚写出的内容 refresh 后原样：list 与写之前拿到的一致', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x', note: 'n' } } });
    store.upsert({ name: 'b', url: 'https://b.example/mcp' });
    store.toggle('a', false);
    const snapshot = store.list();
    store.refresh();
    expect(store.list()).toEqual(snapshot);
  });
});

describe('W1a-5 ③ 拒写文案：修好后回到这页即可（有了重读，这句才是真话）', () => {
  it('parse / shape：固定中文句子，末句是「修好后回到这页即可」，不再叫人重启', () => {
    const root = mkRoot();
    mkdirSync(join(root, 'mcp-servers'), { recursive: true });
    writeFileSync(cfgFile(root), BAD_JSON);
    const store = new McpServersStore(new MinisPaths(root));
    let msg = '';
    try { store.upsert({ name: 'a', command: 'x' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toBe('servers.json 格式有误。为免覆盖你原来的配置，MCP 服务器暂时不能添加、修改、启停或删除。修好后回到这页即可。');
  });

  it('read：带错误码，说权限或占用，末句同样是「修好后回到这页即可」', () => {
    const root = mkRoot();
    mkdirSync(cfgFile(root), { recursive: true });
    const store = new McpServersStore(new MinisPaths(root));
    let msg = '';
    try { store.toggle('a', true); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^servers\.json 无法读取（EISDIR）/);
    expect(msg).toContain('请检查文件权限或是否被其它程序占用');
    expect(msg).toMatch(/修好后回到这页即可。$/);
    expect(msg).not.toContain('重启');
  });
});

// ── ④ RPC：boot minisd 集成模式照 mcp-config-corrupt.test.ts ──
interface Boot {
  dataDir: string;
  file: string;
  srv: { port: number; close(): Promise<void> };
  ws: WebSocket;
  call: (method: string, params?: unknown) => Promise<any>;
}
async function boot(initial: unknown): Promise<Boot> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-mcpstalerpc-'));
  writeCfg(dataDir, initial);
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
  return { dataDir, file: cfgFile(dataDir), srv, ws, call };
}

describe('W1a-5 ④ RPC：mcp.servers.list 先 refresh', () => {
  it('minisd 启动后在外部追加一条 c：list 里看得到 c（附录先红例），statuses 也跟上', async () => {
    const b = await boot({ mcpServers: { a: { command: 'x' } } });
    try {
      expect((await b.call('mcp.servers.list')).result.servers.map((s: { name: string }) => s.name)).toEqual(['a']);
      writeCfg(b.dataDir, { mcpServers: { a: { command: 'x' }, c: { url: 'https://c.example/mcp' } } });
      const r = (await b.call('mcp.servers.list')).result;
      expect(r.servers.map((s: { name: string }) => s.name)).toEqual(['a', 'c']);
      expect(r.statuses.map((s: { name: string }) => s.name)).toEqual(['a', 'c']);
      expect(r.configError).toBe(false);
    } finally {
      b.ws.close(); await b.srv.close();
    }
  });

  it('启动后外部写坏：list 报 parse、toggle 拒写且文件不变；修好后 list 恢复、toggle 照常', async () => {
    const b = await boot({ mcpServers: { a: { command: 'x' } } });
    try {
      writeFileSync(b.file, BAD_JSON);
      const before = readFileSync(b.file);
      const broken = (await b.call('mcp.servers.list')).result;
      expect(broken.configError).toBe(true);
      expect(broken.configErrorKind).toBe('parse');
      expect(broken.servers).toEqual([]);
      const tg = await b.call('mcp.servers.toggle', { name: 'a', enabled: false });
      expect(tg.error?.message).toMatch(/servers\.json 格式有误/);
      expect(tg.error?.message).toContain('修好后回到这页即可');
      expect(readFileSync(b.file).equals(before)).toBe(true);

      writeCfg(b.dataDir, { mcpServers: { a: { command: 'x' } } });
      const fixed = (await b.call('mcp.servers.list')).result;
      expect(fixed.configError).toBe(false);
      expect('configErrorKind' in fixed).toBe(false);
      expect(fixed.servers.map((s: { name: string }) => s.name)).toEqual(['a']);
      expect((await b.call('mcp.servers.toggle', { name: 'a', enabled: false })).result).toEqual({ ok: true });
      expect(readCfg(b.dataDir).mcpServers.a.enabled).toBe(false);
    } finally {
      b.ws.close(); await b.srv.close();
    }
  });
});
