/** W1a-7b（设计稿 §4.1 W1a-7b / 附录 mcp.md W1a-mcplossy）：MCP 配置保存不再静默丢三样。
 *  旧行为：servers.json 读进来、写回去的过程中有三处静默丢数据。任何一次保存都是整份写回（添加、改名、
 *  删除、启停、市场安装与更新都走它），丢掉的东西就从文件里永久消失：
 *  (a) 认不出的条目（command 写成数组、还没写完、既没有 command 也没有 url 的草稿……）读入时被跳过；
 *  (b) 顶层 mcpServers 以外的键（从 claude_desktop_config.json 整份粘进来的 globalShortcut、$schema）没人记；
 *  (c) args / env / headers 里写成数字或布尔值的元素被当成「不是字符串」过滤掉（"--port", 8080 只剩 "--port"）。
 *  本文件钉住：
 *  ① 认不出的条目按原键存原文，保存时原样写回，跟在识别出的条目后面；撞名时以识别出的为准，被顶掉的旧草稿不会复活；
 *     单个裸条目认不出时整份按 default 存，mcpServers 写成数组时按名为 mcpServers 的条目存（W1a-7c）；
 *  ② 顶层其它键原样写回，键序照原文件（mcpServers 留在原来的位置）；
 *  ③ 有限数字与布尔值转成字符串收下；NaN / Infinity、对象、数组、null 仍不收；
 *  ④ 各条写路径（添加、改备注、改名、删除、启停）都不丢；应用开着时手改后重读（W1a-5）按新文件重新记，
 *     手改删掉的也不会被旧记忆写回去。
 *  ⑤ 撞名的那次没写成（临时文件写不进去、rename 报 EPERM），或者只是试连预览：同名原文仍留在内存里，
 *     之后任意一次保存照样写回。W1a-4 ③「写盘失败时内存不变」那条规矩，管到本步新加的这份内存。
 *  ⑥ 同一个 store 连续写成两次、中间没人动文件：第二次照样原样写回。⑤ 管写盘失败那条路，这里管成功那条路。
 *  list() 仍只列识别出的条目。市场安装与更新两条写路径见 market-install / market-update 的 W1a-7b 例。 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServersStore } from '../src/minisd/mcp/config';
import { MinisPaths } from '../src/minisd/paths';

// ⑤ 要模拟 Windows 上杀软锁住文件、rename 报 EPERM 的那种失败：给 node:fs 的 renameSync 包一层
// （同 crash-log.test.ts 的做法）。平时原样转给真的 renameSync，只在 ⑤ 里临时让它抛一次；
// 每例结束都复位，某例没走到 rename 就失败了，那次抛错也不会漏到下一例
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, renameSync: vi.fn(real.renameSync) };
});
afterEach(() => { vi.mocked(renameSync).mockReset(); });

function mkRoot(): string { return mkdtempSync(join(tmpdir(), 'dm-mcplossy-')); }
function cfgFile(root: string): string { return join(root, 'mcp-servers', 'servers.json'); }
function writeCfg(root: string, content: unknown): void {
  mkdirSync(join(root, 'mcp-servers'), { recursive: true });
  writeFileSync(cfgFile(root), typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}
function seed(root: string, content: unknown): McpServersStore {
  writeCfg(root, content);
  return new McpServersStore(new MinisPaths(root));
}
const readCfg = (root: string) => JSON.parse(readFileSync(cfgFile(root), 'utf8'));
const names = (store: McpServersStore) => store.list().map(s => s.name);
/** 重开一个 store 读回磁盘：证明写进文件的就是这样，而不只是内存里对 */
const reopen = (root: string) => new McpServersStore(new MinisPaths(root));

/** 两种常见的认不出的写法：command 写成数组（笔误）、还没写完的草稿。值不是对象、null、空名字见 ① 第二例 */
const BAD = { command: ['npx', '-y', 'pkg'], env: { TOKEN: 'keep-me' } };
const DRAFT = { note: '还没写完', args: ['--root', 'D:\\My Docs'] };

/** 从 claude_desktop_config.json 整份粘进来的样子：顶层有别的键，mcpServers 里夹着认不出的条目 */
const MIXED = {
  $schema: 'https://example.com/claude-desktop-config.schema.json',
  mcpServers: {
    local: { command: 'node', args: ['srv.js'] },
    bad: BAD,
    remote: { url: 'https://r.example/mcp' },
    draft: DRAFT,
  },
  globalShortcut: 'Ctrl+Q',
  preferences: { theme: 'dark', recent: [1, 2] },
};

describe('W1a-7b ① 认不出的条目原样写回', () => {
  it('toggle 之后，command 写成数组的 bad 原样还在文件里（附录先红例）', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { bad: { command: ['npx'] }, good: { command: 'x' } } });
    expect(names(store)).toEqual(['good']); // list 仍只列识别出的
    store.toggle('good', false);
    const servers = readCfg(root).mcpServers;
    expect(servers.bad).toEqual({ command: ['npx'] });
    expect(servers.good.enabled).toBe(false);
  });

  it('各种认不出的写法都原样写回：识别出的按插入顺序在前，认不出的按原顺序跟在后面', () => {
    const root = mkRoot();
    const store = seed(root, {
      mcpServers: {
        bad: BAD, a: { command: 'x' }, draft: DRAFT, b: { url: 'https://b.example/mcp' },
        stray: 'not-an-object', nul: null, '': { command: 'node' },
      },
    });
    expect(names(store)).toEqual(['a', 'b']);
    store.upsert({ name: 'c', command: 'z' });
    const servers = readCfg(root).mcpServers;
    expect(Object.keys(servers)).toEqual(['a', 'b', 'c', 'bad', 'draft', 'stray', 'nul', '']);
    expect(servers.bad).toEqual(BAD);
    expect(servers.draft).toEqual(DRAFT);
    expect(servers.stray).toBe('not-an-object');
    expect(servers.nul).toBeNull();
    expect(servers['']).toEqual({ command: 'node' });
    expect(names(store)).toEqual(['a', 'b', 'c']);
    // 再读再写一轮也稳定：认不出的还是那几条、还在末尾
    const again = reopen(root);
    expect(names(again)).toEqual(['a', 'b', 'c']);
    again.toggle('a', false);
    const servers2 = readCfg(root).mcpServers;
    expect(Object.keys(servers2)).toEqual(['a', 'b', 'c', 'bad', 'draft', 'stray', 'nul', '']);
    expect(servers2.bad).toEqual(BAD);
  });

  it.each([
    ['新建', (s: McpServersStore) => s.upsert({ name: 'bad', command: 'npx', args: ['-y', 'pkg'] })],
    ['改名', (s: McpServersStore) => s.upsert({ name: 'bad', renameFrom: 'a' })],
  ])('撞名时以识别出的为准（%s）：写进文件的是识别出的那条；之后删掉它，被顶掉的旧草稿不会复活', (_label, write) => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'npx', args: ['-y', 'pkg'] }, keep: { command: 'k' }, bad: BAD } });
    write(store);
    const servers = readCfg(root).mcpServers;
    expect(servers.bad).toMatchObject({ command: 'npx', args: ['-y', 'pkg'] });
    expect(servers.bad.env).toBeUndefined();
    expect(names(store)).toContain('bad');
    store.remove('bad');
    expect(Object.keys(readCfg(root).mcpServers)).not.toContain('bad');
    store.toggle('keep', false); // 再写一次也不复活
    expect(Object.keys(readCfg(root).mcpServers)).not.toContain('bad');
    expect(names(reopen(root))).not.toContain('bad');
  });

  it('变体②（裸名字键控）里认不出的值：随标准形态一起写进 mcpServers，原样保留', () => {
    const root = mkRoot();
    const store = seed(root, { fs: { command: 'npx' }, stray: 'not-an-object', draft: DRAFT });
    expect(names(store)).toEqual(['fs']);
    store.toggle('fs', false);
    const raw = readCfg(root);
    expect(Object.keys(raw)).toEqual(['mcpServers']);
    expect(Object.keys(raw.mcpServers)).toEqual(['fs', 'stray', 'draft']);
    expect(raw.mcpServers.fs).toMatchObject({ command: 'npx', enabled: false });
    expect(raw.mcpServers.stray).toBe('not-an-object');
    expect(raw.mcpServers.draft).toEqual(DRAFT);
  });

  it('变体③（单个裸条目）认不出时，整份按 default 原样写回——连同请求头里的密钥（W1a-7c）', () => {
    // 顶层自带 url 就按单个裸条目认；command 写成 null 解码不了。以前（与只解码不收原文的写法）这一整条读入时就丢了，
    // 下一次任意保存把只含新条目的配置写回去，密钥跟着永久消失（W1a-7b 三审变异 R1）
    const root = mkRoot();
    const lone = { url: 'https://x.example/mcp', command: null, headers: { Authorization: 'Bearer keep-me' } };
    const store = seed(root, lone);
    expect(names(store)).toEqual([]);
    store.upsert({ name: 'added', command: 'y' });
    const raw = readCfg(root);
    expect(Object.keys(raw.mcpServers)).toEqual(['added', 'default']);
    expect(raw.mcpServers.default).toEqual(lone);
  });

  it('变体②里 mcpServers 写成数组（从别家配置转过来的常见误写）：按名为 mcpServers 的条目原样写回（W1a-7c）', () => {
    // mcpServers 不是对象就不走标准形态，按裸名字键控读，它自己成了一个认不出的条目。觉得 mcpServers.mcpServers 看着怪、
    // 读入时把它跳过，数组就丢了（W1a-7b 三审变异 Y5）
    const root = mkRoot();
    const list = [{ name: 'fs', command: 'npx', args: ['-y', '@mcp/fs'] }];
    const store = seed(root, { mcpServers: list });
    expect(names(store)).toEqual([]);
    store.upsert({ name: 'added', command: 'y' });
    const raw = readCfg(root);
    expect(Object.keys(raw.mcpServers)).toEqual(['added', 'mcpServers']);
    expect(raw.mcpServers.mcpServers).toEqual(list);
  });
});

describe('W1a-7b ② 顶层其它键原样写回', () => {
  it('upsert 之后文件里仍有 globalShortcut（附录先红例）', () => {
    const root = mkRoot();
    const store = seed(root, { globalShortcut: 'Ctrl+Q', mcpServers: { a: { command: 'x' } } });
    store.upsert({ name: 'b', command: 'y' });
    const raw = readCfg(root);
    expect(raw.globalShortcut).toBe('Ctrl+Q');
    expect(Object.keys(raw.mcpServers)).toEqual(['a', 'b']);
  });

  it('键序照原文件：mcpServers 在最前、在最后都留在原位，其它键的值（含嵌套对象）逐项不变', () => {
    const first = mkRoot();
    seed(first, { mcpServers: { a: { command: 'x' } }, globalShortcut: 'Ctrl+Q', extra: { k: [1, { z: true }] } }).toggle('a', false);
    expect(Object.keys(readCfg(first))).toEqual(['mcpServers', 'globalShortcut', 'extra']);
    expect(readCfg(first).extra).toEqual({ k: [1, { z: true }] });

    const last = mkRoot();
    seed(last, { $schema: 'https://example.com/s.json', globalShortcut: 'Ctrl+Q', mcpServers: { a: { command: 'x' } } }).toggle('a', false);
    expect(Object.keys(readCfg(last))).toEqual(['$schema', 'globalShortcut', 'mcpServers']);
  });
});

describe('W1a-7b ③ 参数、环境变量、请求头里的数字与布尔值转成字符串', () => {
  it('args 里的 8080、env 里的 3000：toggle 之后读回是 "8080"、"3000"（附录先红例）', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'node', args: ['--port', 8080], env: { PORT: 3000 } } } });
    store.toggle('a', false);
    const e = reopen(root).list()[0];
    expect(e.args).toEqual(['--port', '8080']);
    expect(e.env).toEqual({ PORT: '3000' });
    const raw = readCfg(root).mcpServers.a;
    expect(raw.args).toEqual(['--port', '8080']);
    expect(raw.env).toEqual({ PORT: '3000' });
  });

  it('布尔值、负数、小数同样收下；headers 也一样；读进来当场就是字符串（子进程与请求拿到的就是它）', () => {
    const root = mkRoot();
    const store = seed(root, {
      mcpServers: {
        a: { command: 'node', args: ['--verbose', true, '--quiet', false, '--offset', -1, '--ratio', 0.5], env: { DEBUG: false, RETRIES: 3 } },
        r: { url: 'https://r.example/mcp', headers: { 'X-Retry': 2, 'X-Trace': true } },
      },
    });
    const [a, r] = store.list();
    expect(a.args).toEqual(['--verbose', 'true', '--quiet', 'false', '--offset', '-1', '--ratio', '0.5']);
    expect(a.env).toEqual({ DEBUG: 'false', RETRIES: '3' });
    expect(r.headers).toEqual({ 'X-Retry': '2', 'X-Trace': 'true' });
    // upsert 的输入走同一个归一入口
    store.upsert({ name: 'n', command: 'x', args: ['--port', 9090], env: { ON: true } });
    const n = reopen(root).list().find(e => e.name === 'n')!;
    expect(n.args).toEqual(['--port', '9090']);
    expect(n.env).toEqual({ ON: 'true' });
  });

  it('NaN / Infinity、对象、数组、null 仍不收（回归钉：转出来的字符串不是用户写的东西）', () => {
    const root = mkRoot();
    // 1e400 这种溢出字面量经 JSON.parse 读进来就是 Infinity
    const store = seed(root, '{"mcpServers":{"a":{"command":"node",'
      + '"args":["a",1e400,-1e400,null,{"k":1},[1],"b"],'
      + '"env":{"A":1e400,"B":null,"C":{"k":1},"D":[1],"E":"e"}}}}');
    const a = store.list()[0];
    expect(a.args).toEqual(['a', 'b']);
    expect(a.env).toEqual({ E: 'e' });
    // 进程内调用方直接给 NaN / Infinity
    store.upsert({ name: 'n', command: 'x', args: [NaN, Infinity, 'ok'], env: { N: NaN, I: -Infinity, OK: 'ok' } });
    const n = store.list().find(e => e.name === 'n')!;
    expect(n.args).toEqual(['ok']);
    expect(n.env).toEqual({ OK: 'ok' });
  });
});

describe('W1a-7b ④ 每条写路径都不丢；应用开着时手改后按新文件重新记', () => {
  it.each([
    ['添加', (s: McpServersStore) => s.upsert({ name: 'fresh', command: 'y' })],
    ['改备注', (s: McpServersStore) => s.upsert({ name: 'local', note: 'n' })],
    ['删除', (s: McpServersStore) => s.remove('remote')],
    ['启停', (s: McpServersStore) => s.toggle('local', false)],
  ])('%s之后：认不出的条目与顶层其它键都原样还在，顶层键序不变，认不出的跟在后面', (_label, write) => {
    const root = mkRoot();
    const store = seed(root, MIXED);
    write(store);
    const raw = readCfg(root);
    expect(Object.keys(raw)).toEqual(['$schema', 'mcpServers', 'globalShortcut', 'preferences']);
    expect(raw.$schema).toBe(MIXED.$schema);
    expect(raw.globalShortcut).toBe('Ctrl+Q');
    expect(raw.preferences).toEqual({ theme: 'dark', recent: [1, 2] });
    expect(raw.mcpServers.bad).toEqual(BAD);
    expect(raw.mcpServers.draft).toEqual(DRAFT);
    expect(Object.keys(raw.mcpServers).slice(-2)).toEqual(['bad', 'draft']);
  });

  it('改名（renameFrom 原位改名）之后：认不出的条目与顶层其它键都不丢，改名那条仍在原位', () => {
    const root = mkRoot();
    const store = seed(root, MIXED);
    store.upsert({ name: 'local2', renameFrom: 'local', note: 'z' });
    const raw = readCfg(root);
    expect(Object.keys(raw)).toEqual(['$schema', 'mcpServers', 'globalShortcut', 'preferences']);
    expect(raw.globalShortcut).toBe('Ctrl+Q');
    expect(raw.preferences).toEqual({ theme: 'dark', recent: [1, 2] });
    expect(Object.keys(raw.mcpServers)).toEqual(['local2', 'remote', 'bad', 'draft']);
    expect(raw.mcpServers.local2).toMatchObject({ command: 'node', args: ['srv.js'], note: 'z' });
    expect(raw.mcpServers.bad).toEqual(BAD);
    expect(raw.mcpServers.draft).toEqual(DRAFT);
    expect(names(store)).toEqual(['local2', 'remote']);
  });

  it('应用开着时手加的顶层键与认不出的条目：下一次保存照样写回（重读时重新记下）', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    writeCfg(root, { globalShortcut: 'Ctrl+Q', mcpServers: { a: { command: 'x' }, draft: DRAFT } });
    store.toggle('a', false);
    const raw = readCfg(root);
    expect(Object.keys(raw)).toEqual(['globalShortcut', 'mcpServers']);
    expect(Object.keys(raw.mcpServers)).toEqual(['a', 'draft']);
    expect(raw.mcpServers.draft).toEqual(DRAFT);
    expect(raw.mcpServers.a.enabled).toBe(false);
  });

  // 重读时认不出的条目与顶层键都要先清空再按新文件记。认不出的条目没清，四种都看得出；顶层没清，
  // 只有后三种看得出——新文件是标准形态时 load 会重新给顶层赋值，把没清的旧值盖掉了。所以四种都钉上
  it.each([
    ['手删了顶层键和认不出的条目', (root: string) => writeCfg(root, { mcpServers: { local: { command: 'node' } } }), ['local', 'c']],
    ['把整个文件删了', (root: string) => rmSync(cfgFile(root)), ['c']],
    ['把文件清空成 0 字节', (root: string) => writeCfg(root, ''), ['c']],
    ['改成裸名字键控的写法', (root: string) => writeCfg(root, { local: { command: 'node' } }), ['local', 'c']],
  ])('应用开着时%s：下一次保存不拿旧的记忆把它们写回去', (_label, edit, expected) => {
    const root = mkRoot();
    const store = seed(root, MIXED);
    edit(root);
    store.upsert({ name: 'c', command: 'z' });
    const raw = readCfg(root);
    expect(Object.keys(raw)).toEqual(['mcpServers']);
    expect(Object.keys(raw.mcpServers)).toEqual(expected);
  });

  it('refresh 之后再写：认不出的条目与顶层键照样在（refresh 只读，重载后的记忆与文件一致）', () => {
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' } } });
    writeCfg(root, { ...MIXED, mcpServers: { ...MIXED.mcpServers, a: { command: 'x' } } });
    store.refresh();
    expect(names(store)).toEqual(['local', 'remote', 'a']);
    store.toggle('a', false);
    const raw = readCfg(root);
    expect(raw.globalShortcut).toBe('Ctrl+Q');
    expect(Object.keys(raw.mcpServers)).toEqual(['local', 'remote', 'a', 'bad', 'draft']);
  });
});

describe('W1a-7b ⑤ 撞名的那次没写成：同名原文仍留在内存里，之后任意一次保存照样写回', () => {
  // 撞名时 save 要把同名原文从内存里去掉（否则删掉那台之后它会复活，见 ①）。这一步必须与 entries 一样，
  // 落盘成功之后才换进内存。提前去掉的话，这次写盘一失败，文件里 bad 还在、内存里已经没了；下一次保存另一台时
  // 磁盘字节没变、不会重读，bad 连同 env 里的密钥就从文件里永久消失。
  // 两种失败都钉：临时文件写不进去（writeFileSync 抛），和附录写明的现实触发——Windows 上杀软锁住文件，
  // 临时文件已经写好、rename 报 EPERM。只钉前一种的话，把换进内存那一句挪到两次调用之间就漏过去了。
  type Breaker = (root: string) => () => void; // 布置失败，返回「挪开」
  // 第三列认报错：这次抛错确实出在布置的那一步，而不是别处先抛了（那样例子照样绿，钉的却不是这一步）
  const BREAKERS: [string, Breaker, RegExp][] = [
    ['临时文件写不进去（servers.json.tmp 被占成目录）', root => {
      mkdirSync(cfgFile(root) + '.tmp');
      return () => rmdirSync(cfgFile(root) + '.tmp');
    }, /servers\.json\.tmp/],
    ['rename 报 EPERM（Windows 上杀软锁住文件）', () => {
      vi.mocked(renameSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      });
      return () => {};
    }, /EPERM/],
  ];
  const COLLISIONS: [string, (s: McpServersStore) => unknown][] = [
    ['新建', s => s.upsert({ name: 'bad', command: 'npx' })],
    ['改名', s => s.upsert({ name: 'bad', renameFrom: 'a' })],
  ];

  describe.each(BREAKERS)('%s', (_how, breakDisk, thrown) => {
    it.each(COLLISIONS)('撞名%s抛错：list() 与文件字节都不变；失败挪开后启停另一台，bad 原样写回', (_what, write) => {
      const root = mkRoot();
      const store = seed(root, { mcpServers: { a: { command: 'x' }, bad: BAD } });
      const before = readFileSync(cfgFile(root));
      const snapshot = store.list();
      const unbreak = breakDisk(root);
      expect(() => write(store)).toThrow(thrown);
      expect(store.list()).toEqual(snapshot);
      expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);

      unbreak();
      store.toggle('a', false);
      const servers = readCfg(root).mcpServers;
      expect(Object.keys(servers)).toEqual(['a', 'bad']);
      expect(servers.bad).toEqual(BAD);
      expect(servers.a.enabled).toBe(false);
    });
  });

  it('试连预览撞名（新建、改名）：一个字节都不写，内存里的同名原文也不动，之后保存照样写回', () => {
    // 预览与 upsert 走同一个 compose。「去掉同名原文」要是挪进 compose，预览一次就把它从内存里抹掉了
    const root = mkRoot();
    const store = seed(root, { mcpServers: { a: { command: 'x' }, bad: BAD } });
    const before = readFileSync(cfgFile(root));
    expect(store.preview({ name: 'bad', command: 'npx' })).toMatchObject({ name: 'bad', command: 'npx' });
    expect(store.preview({ name: 'bad', renameFrom: 'a' })).toMatchObject({ name: 'bad', command: 'x' });
    expect(readFileSync(cfgFile(root)).equals(before)).toBe(true);
    expect(names(store)).toEqual(['a']);

    store.toggle('a', false);
    const servers = readCfg(root).mcpServers;
    expect(Object.keys(servers)).toEqual(['a', 'bad']);
    expect(servers.bad).toEqual(BAD);
  });
});

describe('W1a-7b ⑥ 同一个 store 连续两次写成：第二次照样原样写回', () => {
  // 第二次写前对比磁盘（W1a-5）看到的是自己上次写出的字节，不重读：这次写回的认不出的条目与顶层，全靠上次落盘后
  // 换进内存的那一份。那一份要是只活过第一次保存，设置页连点两次启停、添加后又删掉，第二次写盘时它们
  // （连同认不出的条目 env 里的密钥）就从文件里永久消失。
  // 前面各例看不出这一点：同一份读入状态上大都只成功写一次；撞名例连写三次，可第一次写完就已经没有可丢的了。
  // 第一次写分别由 toggle、upsert、remove 打头：哪一个写方法写完把记忆丢了，都有一例是它先写
  type Write = (s: McpServersStore) => unknown;
  const TWICE: [string, Write, Write, string[]][] = [
    ['先停再启', s => s.toggle('local', false), s => s.toggle('local', true), ['local', 'remote', 'bad', 'draft']],
    ['先添加再删除', s => s.upsert({ name: 'fresh', command: 'y' }), s => s.remove('fresh'), ['local', 'remote', 'bad', 'draft']],
    ['先删除再启停', s => s.remove('remote'), s => s.toggle('local', false), ['local', 'bad', 'draft']],
  ];

  it.each(TWICE)('%s：第二次写完，认不出的条目与顶层其它键仍原样在文件里', (_label, first, second, servers) => {
    const root = mkRoot();
    const store = seed(root, MIXED);
    first(store);
    const afterFirst = readFileSync(cfgFile(root));
    second(store);
    const afterSecond = readFileSync(cfgFile(root));
    // 第二次确实写了盘：没写的话文件还是第一次写出的样子，下面的断言什么也钉不住
    expect(afterSecond.equals(afterFirst)).toBe(false);
    const raw = JSON.parse(afterSecond.toString('utf8'));
    expect(Object.keys(raw)).toEqual(['$schema', 'mcpServers', 'globalShortcut', 'preferences']);
    expect(raw.$schema).toBe(MIXED.$schema);
    expect(raw.globalShortcut).toBe('Ctrl+Q');
    expect(raw.preferences).toEqual({ theme: 'dark', recent: [1, 2] });
    expect(Object.keys(raw.mcpServers)).toEqual(servers);
    expect(raw.mcpServers.bad).toEqual(BAD);
    expect(raw.mcpServers.draft).toEqual(DRAFT);
  });
});
