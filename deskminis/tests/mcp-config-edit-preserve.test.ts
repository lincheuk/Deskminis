/** W1a-6：MCP 编辑不丢字段（后端）。设计稿 §4 W1a-6 / 附录 mcp.md W1a-mcpedit。
 *  upsert 从「整条替换」改成「以旧条目为底打补丁」：没给的键保留、给了的覆盖、null 表示删键；
 *  换传输类型时先清掉旧族字段；renameFrom 原位改名、一次写盘；preview 走同一套合并与校验但不写盘。
 *  为什么：设置页只改一个备注，env / headers / cwd / 超时和停用状态就全没了；市场「更新」会把
 *  用户停掉的服务器悄悄重新启用。 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServersStore } from '../src/minisd/mcp/config';
import { MinisPaths } from '../src/minisd/paths';

const CREATED = '2026-01-01T00:00:00.000Z';
/** 附录指定的两条种子：带空格的 Windows 路径、$$ 引用、停用、备注、未识别字段 oauth 一应俱全 */
const SEED = {
  mcpServers: {
    local: {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\srv\\index.js', '--root', 'D:\\My Docs'],
      env: { TOKEN: '$$TOK', MODE: 'x' },
      cwd: 'D:\\work',
      startupTimeoutSeconds: 45,
      enabled: false,
      note: 'old',
      oauth: { p: 'g' },
      createdAt: CREATED,
      updatedAt: CREATED,
    },
    remote: {
      url: 'https://mcp.example/api',
      headers: { Authorization: 'Bearer $$TOK' },
      enabled: false,
      note: 'r',
      createdAt: CREATED,
      updatedAt: CREATED,
    },
  },
};

function setup(content: string = JSON.stringify(SEED, null, 2)) {
  const root = mkdtempSync(join(tmpdir(), 'dm-mcp-edit-'));
  mkdirSync(join(root, 'mcp-servers'), { recursive: true });
  const file = join(root, 'mcp-servers', 'servers.json');
  writeFileSync(file, content, 'utf8');
  const store = new McpServersStore(new MinisPaths(root));
  const get = (name: string) => store.list().find(e => e.name === name);
  /** 重开一个 store 读回磁盘——证明改动真的落了盘，而不只是内存里对 */
  const reopen = (name: string) => new McpServersStore(new MinisPaths(root)).list().find(e => e.name === name);
  const disk = () => JSON.parse(readFileSync(file, 'utf8')).mcpServers as Record<string, Record<string, unknown>>;
  return { root, file, store, get, reopen, disk };
}

describe('W1a-6 ① 补丁语义：没给的字段一律保留', () => {
  it('只改 local 的备注：env、args（逐元素）、cwd、超时、停用、extra.oauth、createdAt 全部不变', () => {
    const { store, get, reopen } = setup();
    store.upsert({ name: 'local', note: 'new' });
    for (const e of [get('local')!, reopen('local')!]) {
      expect(e.note).toBe('new');
      expect(e.transport).toBe('stdio');
      expect(e.command).toBe('C:\\Program Files\\nodejs\\node.exe');
      expect(e.args).toEqual(['C:\\Program Files\\srv\\index.js', '--root', 'D:\\My Docs']);
      expect(e.env).toEqual({ TOKEN: '$$TOK', MODE: 'x' });
      expect(e.cwd).toBe('D:\\work');
      expect(e.startupTimeoutSeconds).toBe(45);
      expect(e.enabled).toBe(false);
      expect(e.extra).toEqual({ oauth: { p: 'g' } });
      expect(e.createdAt).toBe(CREATED);
      expect(e.updatedAt).not.toBe(CREATED);
    }
  });

  it('只改 remote 的备注：headers 与停用状态不变', () => {
    const { store, get, reopen } = setup();
    store.upsert({ name: 'remote', note: 'n2' });
    for (const e of [get('remote')!, reopen('remote')!]) {
      expect(e.note).toBe('n2');
      expect(e.transport).toBe('streamable-http');
      expect(e.url).toBe('https://mcp.example/api');
      expect(e.headers).toEqual({ Authorization: 'Bearer $$TOK' });
      expect(e.enabled).toBe(false);
    }
  });

  it('旧界面载荷（不带 enabled）换 command 与 args：两者被替换，env、cwd、超时、停用、备注保留', () => {
    const { store, reopen } = setup();
    store.upsert({ name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
    const e = reopen('local')!;
    expect(e.command).toBe('npx');
    expect(e.args).toEqual(['-y', 'pkg']);
    expect(e.env).toEqual({ TOKEN: '$$TOK', MODE: 'x' });
    expect(e.cwd).toBe('D:\\work');
    expect(e.startupTimeoutSeconds).toBe(45);
    expect(e.enabled).toBe(false);
    expect(e.note).toBe('old');
  });

  it('值为 undefined 的键当作没出现（进程内调用方的可选字段），不是删除', () => {
    const { store, get } = setup();
    store.upsert({ name: 'local', note: undefined, env: undefined, cwd: 'E:\\w' });
    expect(get('local')!.note).toBe('old');
    expect(get('local')!.env).toEqual({ TOKEN: '$$TOK', MODE: 'x' });
    expect(get('local')!.cwd).toBe('E:\\w');
  });

  it('createdAt 取旧条目：输入里带的 createdAt 不能改写创建时间；updatedAt 取当下', () => {
    const { store, get } = setup();
    const before = Date.now();
    store.upsert({ name: 'local', note: 'x', createdAt: '1999-01-01T00:00:00.000Z', updatedAt: '1999-01-01T00:00:00.000Z' });
    expect(get('local')!.createdAt).toBe(CREATED);
    expect(Date.parse(get('local')!.updatedAt!)).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('W1a-6 ② null 删键，整值替换不深合并', () => {
  it('note:null → 备注删掉；文件里也没有 note 键', () => {
    const { store, get, disk } = setup();
    store.upsert({ name: 'local', note: null });
    expect(get('local')!.note).toBeUndefined();
    expect('note' in disk().local).toBe(false);
    // 其余不受影响
    expect(get('local')!.env).toEqual({ TOKEN: '$$TOK', MODE: 'x' });
  });

  it('未识别字段也能删：oauth:null → extra 为 undefined，文件里没有 oauth', () => {
    const { store, get, disk } = setup();
    store.upsert({ name: 'local', oauth: null });
    expect(get('local')!.extra).toBeUndefined();
    expect('oauth' in disk().local).toBe(false);
  });

  it('env:null → env 为 undefined（市场更新到不再声明任何 env 的版本时靠它清空）', () => {
    const { store, get, disk } = setup();
    store.upsert({ name: 'local', env: null });
    expect(get('local')!.env).toBeUndefined();
    expect('env' in disk().local).toBe(false);
    expect(get('local')!.command).toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('env 给新值时整值替换、不与旧值合并（市场「移除未声明的键」依赖这一点）', () => {
    const { store, get } = setup();
    store.upsert({ name: 'local', env: { NEW: '1' } });
    expect(get('local')!.env).toEqual({ NEW: '1' });
  });

  it('headers 同样整值替换；startupTimeoutSeconds:null 回到缺省', () => {
    const { store, get } = setup();
    store.upsert({ name: 'remote', headers: { 'X-A': '1' } });
    expect(get('remote')!.headers).toEqual({ 'X-A': '1' });
    store.upsert({ name: 'local', startupTimeoutSeconds: null });
    expect(get('local')!.startupTimeoutSeconds).toBeUndefined();
  });

  it('note:"" 仍按原样存成空串（与 null 区分）', () => {
    const { store, get } = setup();
    store.upsert({ name: 'local', note: '' });
    expect(get('local')!.note).toBe('');
  });
});

describe('W1a-6 ③ 换传输类型先清旧族字段', () => {
  it('stdio → streamable-http：command、args、env、cwd 全清；备注、停用、超时、extra 保留', () => {
    const { store, get, disk } = setup();
    store.upsert({ name: 'local', transport: 'streamable-http', url: 'https://x' });
    const e = get('local')!;
    expect(e.transport).toBe('streamable-http');
    expect(e.url).toBe('https://x');
    expect(e.command).toBeUndefined();
    expect(e.args).toBeUndefined();
    expect(e.env).toBeUndefined();
    expect(e.cwd).toBeUndefined();
    expect(e.note).toBe('old');
    expect(e.enabled).toBe(false);
    expect(e.startupTimeoutSeconds).toBe(45);
    expect(e.extra).toEqual({ oauth: { p: 'g' } });
    // 落盘也没有旧族字段：不清掉的话 command 还在，重读时 decodeEntry 会把它判回 stdio
    expect(Object.keys(disk().local).sort()).toEqual(
      ['createdAt', 'enabled', 'note', 'oauth', 'startupTimeoutSeconds', 'updatedAt', 'url'],
    );
  });

  it('只给 url（不写 transport）也算换成 http', () => {
    const { store, reopen } = setup();
    store.upsert({ name: 'local', url: 'https://x' });
    const e = reopen('local')!;
    expect(e.transport).toBe('streamable-http');
    expect(e.url).toBe('https://x');
    expect(e.command).toBeUndefined();
    expect(e.note).toBe('old');
    expect(e.enabled).toBe(false);
  });

  it('http 别名（type:"sse"）同样触发换族', () => {
    const { store, get } = setup();
    store.upsert({ name: 'local', type: 'sse', url: 'https://s' });
    expect(get('local')!.transport).toBe('streamable-http');
    expect(get('local')!.command).toBeUndefined();
  });

  it('streamable-http → stdio：url、headers 清掉；备注与停用保留', () => {
    const { store, get, disk } = setup();
    store.upsert({ name: 'remote', transport: 'stdio', command: 'npx', args: ['-y', 'r'] });
    const e = get('remote')!;
    expect(e.transport).toBe('stdio');
    expect(e.command).toBe('npx');
    expect(e.url).toBeUndefined();
    expect(e.headers).toBeUndefined();
    expect(e.note).toBe('r');
    expect(e.enabled).toBe(false);
    expect('url' in disk().remote).toBe(false);
    expect('headers' in disk().remote).toBe(false);
  });

  it('只给 command 也算换成 stdio', () => {
    const { store, get } = setup();
    store.upsert({ name: 'remote', command: 'node' });
    expect(get('remote')!.transport).toBe('stdio');
    expect(get('remote')!.url).toBeUndefined();
  });

  it('同族不清：remote 只换 url（市场远端分支的载荷形状），用户的 headers 保留', () => {
    const { store, get } = setup();
    store.upsert({ name: 'remote', transport: 'streamable-http', url: 'https://mcp.example/v2' });
    expect(get('remote')!.url).toBe('https://mcp.example/v2');
    expect(get('remote')!.headers).toEqual({ Authorization: 'Bearer $$TOK' });
    expect(get('remote')!.note).toBe('r');
  });

  it('换成 http 却没给 url：报原来那句中文错误，文件字节不变', () => {
    const { store, file } = setup();
    const before = readFileSync(file);
    expect(() => store.upsert({ name: 'local', transport: 'streamable-http' })).toThrow('streamable-http 类型必须提供 url');
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('换成 stdio 却没给 command：报「stdio 类型必须提供 command」', () => {
    const { store } = setup();
    expect(() => store.upsert({ name: 'remote', transport: 'stdio' })).toThrow('stdio 类型必须提供 command');
  });

  it('校验看的是合并之后的条目：给已存条目塞非字符串 command 仍报「command 必须是字符串」', () => {
    const { store } = setup();
    expect(() => store.upsert({ name: 'local', command: 5 })).toThrow('command 必须是字符串');
    expect(() => store.upsert({ name: 'remote', url: 5 })).toThrow('url 必须是字符串');
  });
});

describe('W1a-6 ④ enabled', () => {
  it('显式 enabled:true 才会启用', () => {
    const { store, reopen } = setup();
    store.upsert({ name: 'local', enabled: true });
    expect(reopen('local')!.enabled).toBe(true);
  });

  it('disabled:false 同样表示启用（旧 enabled:false 不能把它压回去）', () => {
    const { store, get } = setup();
    store.upsert({ name: 'local', disabled: false });
    expect(get('local')!.enabled).toBe(true);
  });

  it('回归：新建条目不给 enabled 时缺省启用，createdAt 等于 updatedAt', () => {
    const { store, get } = setup();
    store.upsert({ name: 'fresh', command: 'x' });
    expect(get('fresh')!.enabled).toBe(true);
    expect(get('fresh')!.createdAt).toBe(get('fresh')!.updatedAt);
  });
});

describe('W1a-6 ⑤ renameFrom 原位改名', () => {
  it('local → local2：位置不变、字段与 createdAt 全部带过去、文件里没有 renameFrom 也没有旧名', () => {
    const { store, file, reopen } = setup();
    store.upsert({ name: 'local2', renameFrom: 'local', note: 'z' });
    expect(store.list().map(e => e.name)).toEqual(['local2', 'remote']);
    const e = reopen('local2')!;
    expect(e.note).toBe('z');
    expect(e.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(e.args).toEqual(['C:\\Program Files\\srv\\index.js', '--root', 'D:\\My Docs']);
    expect(e.env).toEqual({ TOKEN: '$$TOK', MODE: 'x' });
    expect(e.cwd).toBe('D:\\work');
    expect(e.startupTimeoutSeconds).toBe(45);
    expect(e.enabled).toBe(false);
    expect(e.extra).toEqual({ oauth: { p: 'g' } });
    expect(e.createdAt).toBe(CREATED);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('renameFrom');
    expect(Object.keys(JSON.parse(text).mcpServers)).toEqual(['local2', 'remote']);
  });

  it('改到末尾那条也原位：remote → remote2 仍排第二', () => {
    const { store } = setup();
    store.upsert({ name: 'remote2', renameFrom: 'remote' });
    expect(store.list().map(e => e.name)).toEqual(['local', 'remote2']);
    expect(store.list()[1].headers).toEqual({ Authorization: 'Bearer $$TOK' });
  });

  it('新名已被别的条目占用 → 「已存在同名」，文件字节不变', () => {
    const { store, file } = setup();
    const before = readFileSync(file);
    expect(() => store.upsert({ name: 'remote', renameFrom: 'local' })).toThrow(/已存在同名 MCP server: remote/);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(store.list().map(e => e.name)).toEqual(['local', 'remote']);
  });

  it('旧名不存在 → 「MCP server 不存在」', () => {
    const { store } = setup();
    expect(() => store.upsert({ name: 'x', renameFrom: 'ghost', command: 'y' })).toThrow('MCP server 不存在: ghost');
    expect(store.list().map(e => e.name)).toEqual(['local', 'remote']);
  });

  it('renameFrom 与 name 相同 → 就是普通补丁', () => {
    const { store, get } = setup();
    store.upsert({ name: 'local', renameFrom: 'local', note: 'same' });
    expect(store.list().map(e => e.name)).toEqual(['local', 'remote']);
    expect(get('local')!.note).toBe('same');
    expect(get('local')!.extra).toEqual({ oauth: { p: 'g' } });
  });

  it('renameFrom 不是字符串 → 报错而不是悄悄当成新建', () => {
    const { store } = setup();
    expect(() => store.upsert({ name: 'n', renameFrom: 3, command: 'x' })).toThrow(/renameFrom/);
    expect(store.list().map(e => e.name)).toEqual(['local', 'remote']);
  });
});

describe('W1a-6 ⑥ preview：同一套合并与校验，不写盘', () => {
  it('preview 返回合并后的条目，文件字节与 list() 都不变', () => {
    const { store, file } = setup();
    const before = readFileSync(file);
    const listBefore = store.list();
    const p = store.preview({ name: 'local', note: 'q' });
    expect(p.note).toBe('q');
    expect(p.env).toEqual({ TOKEN: '$$TOK', MODE: 'x' });
    expect(p.cwd).toBe('D:\\work');
    expect(p.startupTimeoutSeconds).toBe(45);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(store.list()).toEqual(listBefore);
  });

  it('preview 校验错误与 upsert 同句', () => {
    const { store } = setup();
    expect(() => store.preview({ name: 'z', type: 'http' })).toThrow('streamable-http 类型必须提供 url');
    expect(() => store.preview({ name: '' })).toThrow('MCP server 名称不能为空');
  });

  it('配置读坏时 preview 不受拒写拦截（试连是摸一下，不写盘），文件字节不变', () => {
    const { store, file } = setup('{ 这根本不是 json');
    const before = readFileSync(file);
    expect(store.loadErrorKind).toBe('parse');
    const p = store.preview({ name: 'n', command: 'x' });
    expect(p).toMatchObject({ name: 'n', transport: 'stdio', command: 'x', enabled: true });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('preview 也先对比磁盘：应用开着时手改的 env 会进试连', () => {
    const { store, file } = setup();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.mcpServers.local.env = { TOKEN: 'hand' };
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    expect(store.preview({ name: 'local', note: 'q' }).env).toEqual({ TOKEN: 'hand' });
  });
});
