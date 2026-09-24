/** W1a-7：MCP 编辑表单 → 载荷的纯函数（src/renderer/src/lib/mcp/edit.ts）。设计稿 §4 W1a-7 / 附录 mcp.md W1a-mcpedit-ui。
 *  为什么要钉：表单原先整条提交——参数按空格切（`C:\Program Files\x` 被拆成两段）、固定塞 enabled:true
 *  （停用的服务器一保存就被重新启用）、note 为空时是 undefined（过 JSON 被丢，备注清不掉）。
 *  后端 W1a-6 已改成补丁语义，表单这边改成「参数每行一个、只提交改过的字段、改名走 renameFrom」。
 *  .vue 不在 typecheck 覆盖内，逻辑都放进这个纯模块直测；SecMcp 只剩接线，由源码守卫与 xvfb 实拍兜。 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  argsToText, textToArgs, buildMcpUpsert, formFromOrig, duplicateNameError,
  type McpForm, type McpOrig,
} from '../src/renderer/src/lib/mcp/edit';
import { McpServersStore } from '../src/minisd/mcp/config';
import { MinisPaths } from '../src/minisd/paths';

/** 走一遍 JSON：载荷真正是经 JSON-RPC 发出去的，undefined 会被丢掉、null 会留下——断言按线上看到的形态做 */
const wire = (p: Record<string, unknown>): unknown => JSON.parse(JSON.stringify(p));

const ORIG: McpOrig = { name: 'a', transport: 'stdio', command: 'npx', args: ['x y'], note: 'n' };
const FORM: McpForm = { name: 'a', transport: 'stdio', command: 'npx', args: 'x y', url: '', note: 'n' };

describe('W1a-7 参数每行一个', () => {
  it('textToArgs：按行切（CRLF 与 LF 都认），每行去首尾空白，空行丢掉；带空格的路径整行是一个参数', () => {
    expect(textToArgs('C:\\Program Files\\x\\srv.js\r\n--flag\n\n')).toEqual(['C:\\Program Files\\x\\srv.js', '--flag']);
    expect(textToArgs('  -y  \n\t@scope/pkg\t\n   \n')).toEqual(['-y', '@scope/pkg']);
    expect(textToArgs('')).toEqual([]);
    expect(textToArgs(' \n \r\n')).toEqual([]);
  });

  it('argsToText 与 textToArgs 往返逐元素不变（带空格的参数不再被拆开）', () => {
    const args = ['a b', 'D:\\My Docs', 'C:\\Program Files\\x'];
    expect(argsToText(args)).toBe('a b\nD:\\My Docs\nC:\\Program Files\\x');
    expect(textToArgs(argsToText(args))).toEqual(args);
    expect(argsToText(undefined)).toBe('');
    expect(argsToText([])).toBe('');
  });
});

describe('W1a-7 编辑：只提交改过的字段', () => {
  it('表单与原条目完全一致：载荷精确等于 {name}（不带 enabled / args / command / note）', () => {
    expect(buildMcpUpsert(ORIG, { ...FORM })).toEqual({ name: 'a' });
    expect(wire(buildMcpUpsert(ORIG, { ...FORM }))).toEqual({ name: 'a' });
  });

  it('formFromOrig 回填后原样提交，载荷只有 {name}：stdio、远端、没有备注、没有参数都一样', () => {
    const origs: McpOrig[] = [
      ORIG,
      { name: 'local', transport: 'stdio', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Program Files\\srv\\index.js', '--root', 'D:\\My Docs'], note: 'old' },
      { name: 'bare', transport: 'stdio', command: 'x' },
      { name: 'remote', transport: 'streamable-http', url: 'https://mcp.example/api' },
      { name: 'remote2', transport: 'streamable-http', url: 'https://mcp.example/api', note: 'r' },
    ];
    for (const o of origs) expect(buildMcpUpsert(o, formFromOrig(o)), o.name).toEqual({ name: o.name });
  });

  it('formFromOrig：参数一行一个，缺省字段回填空串', () => {
    expect(formFromOrig({ name: 'l', transport: 'stdio', command: 'node', args: ['C:\\Program Files\\x', '--v'] }))
      .toEqual({ name: 'l', transport: 'stdio', command: 'node', args: 'C:\\Program Files\\x\n--v', url: '', note: '' });
    expect(formFromOrig({ name: 'r', transport: 'streamable-http', url: 'https://x', note: 'hi' }))
      .toEqual({ name: 'r', transport: 'streamable-http', command: '', args: '', url: 'https://x', note: 'hi' });
  });

  it('只改备注：{name, note}；备注清空（含只剩空白）发 note:null——过 JSON 仍在，后端据此删键', () => {
    expect(buildMcpUpsert(ORIG, { ...FORM, note: 'm' })).toEqual({ name: 'a', note: 'm' });
    expect(buildMcpUpsert(ORIG, { ...FORM, note: '  m  ' })).toEqual({ name: 'a', note: 'm' });
    expect(wire(buildMcpUpsert(ORIG, { ...FORM, note: '' }))).toEqual({ name: 'a', note: null });
    expect(wire(buildMcpUpsert(ORIG, { ...FORM, note: '   ' }))).toEqual({ name: 'a', note: null });
    // 原来没有备注、现在填了
    expect(buildMcpUpsert({ ...ORIG, note: undefined }, { ...FORM, note: 'first' })).toEqual({ name: 'a', note: 'first' });
  });

  it('框里的值没动就不提交：原条目的备注 / 命令首尾带空白（手改 servers.json 留下的），不因回填而被改写', () => {
    const o: McpOrig = { name: 'a', transport: 'stdio', command: ' npx ', args: [], note: ' spaced ' };
    expect(buildMcpUpsert(o, formFromOrig(o))).toEqual({ name: 'a' });
  });

  it('只改参数框：带 args，按行切出来的数组；参数没动就不带（原参数里有换行这种按行表示不了的也安全）', () => {
    expect(buildMcpUpsert(ORIG, { ...FORM, args: 'x y\nC:\\Program Files\\z' }))
      .toEqual({ name: 'a', args: ['x y', 'C:\\Program Files\\z'] });
    expect(buildMcpUpsert(ORIG, { ...FORM, args: '' })).toEqual({ name: 'a', args: [] });
    const odd: McpOrig = { name: 'a', transport: 'stdio', command: 'npx', args: ['line1\nline2', ' keep-space '] };
    expect(buildMcpUpsert(odd, formFromOrig(odd))).toEqual({ name: 'a' });
  });

  it('只改命令：{name, command}（去首尾空白）', () => {
    expect(buildMcpUpsert(ORIG, { ...FORM, command: ' uvx ' })).toEqual({ name: 'a', command: 'uvx' });
  });

  it('远端只改 URL：{name, url}；表单里残留的 command / args 不会跟着发出去', () => {
    const o: McpOrig = { name: 'r', transport: 'streamable-http', url: 'https://a' };
    expect(buildMcpUpsert(o, { ...formFromOrig(o), url: 'https://b ', command: 'junk', args: 'junk' }))
      .toEqual({ name: 'r', url: 'https://b' });
  });

  it('改名：带 renameFrom 为原名（不先删后加）；改名同时改备注', () => {
    expect(buildMcpUpsert(ORIG, { ...FORM, name: 'b' })).toEqual({ name: 'b', renameFrom: 'a' });
    expect(buildMcpUpsert(ORIG, { ...FORM, name: '  b  ', note: '' })).toEqual({ name: 'b', renameFrom: 'a', note: null });
    // 名字只是多了首尾空白：不算改名
    expect(buildMcpUpsert(ORIG, { ...FORM, name: ' a ' })).toEqual({ name: 'a' });
  });

  it('换传输类型：带 transport 与新族的完整字段——stdio → 远端是 {name, transport, url}', () => {
    expect(buildMcpUpsert(ORIG, { ...FORM, transport: 'streamable-http', url: 'https://x' }))
      .toEqual({ name: 'a', transport: 'streamable-http', url: 'https://x' });
    const r: McpOrig = { name: 'r', transport: 'streamable-http', url: 'https://a', note: 'r' };
    expect(buildMcpUpsert(r, { ...formFromOrig(r), transport: 'stdio', command: 'npx', args: '-y\nC:\\Program Files\\p' }))
      .toEqual({ name: 'r', transport: 'stdio', command: 'npx', args: ['-y', 'C:\\Program Files\\p'] });
  });

  it('任何编辑载荷都不带 enabled——启停只归列表行的开关管', () => {
    const forms: McpForm[] = [
      { ...FORM }, { ...FORM, note: '' }, { ...FORM, name: 'b' }, { ...FORM, args: 'q' },
      { ...FORM, transport: 'streamable-http', url: 'https://x' },
    ];
    for (const f of forms) expect(buildMcpUpsert(ORIG, f)).not.toHaveProperty('enabled');
  });
});

describe('W1a-7 新建', () => {
  it('stdio：{name, transport, command, args}，参数按行切；不带 enabled；备注为空不带', () => {
    const f: McpForm = { name: ' fs ', transport: 'stdio', command: ' npx ', args: '-y\n@scope/server-fs\nC:\\Program Files\\x\n', url: 'junk', note: '  ' };
    expect(buildMcpUpsert(undefined, f)).toEqual({
      name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@scope/server-fs', 'C:\\Program Files\\x'],
    });
  });

  it('远端：{name, transport, url}；备注非空才带', () => {
    const f: McpForm = { name: 'r', transport: 'streamable-http', command: 'junk', args: 'junk', url: ' https://x ', note: ' hi ' };
    expect(buildMcpUpsert(undefined, f)).toEqual({ name: 'r', transport: 'streamable-http', url: 'https://x', note: 'hi' });
    expect(buildMcpUpsert(undefined, f)).not.toHaveProperty('enabled');
  });
});

describe('W1a-7 同名新建前端拦截', () => {
  it('新建时名字（去首尾空白后）与已有条目同名：报「已有同名服务器」，不然回空串', () => {
    const names = ['a', 'fs'];
    expect(duplicateNameError(undefined, ' fs ', names)).toBe('已有同名服务器「fs」，请换个名字或编辑它');
    expect(duplicateNameError(undefined, 'new', names)).toBe('');
    expect(duplicateNameError(undefined, 'FS', names)).toBe('');
  });

  it('编辑不拦：名字没变是在改它自己；改成别人的名字由后端报「已存在同名」', () => {
    expect(duplicateNameError(ORIG, 'a', ['a', 'b'])).toBe('');
    expect(duplicateNameError(ORIG, 'b', ['a', 'b'])).toBe('');
  });
});

describe('W1a-7 载荷接到后端补丁语义上（真 McpServersStore）', () => {
  // 附录 xvfb 场景的纯函数版：带 env / headers / 带空格参数 / 停用 / extra 的两台，表单回填后只改备注保存
  const SEED = {
    mcpServers: {
      local: {
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:\\Program Files\\srv\\index.js', '--root', 'D:\\My Docs'],
        env: { TOKEN: '$$TOK', MODE: 'x' }, cwd: 'D:\\work', startupTimeoutSeconds: 45,
        enabled: false, note: 'old', oauth: { p: 'g' },
      },
      remote: { url: 'https://mcp.example/api', headers: { Authorization: 'Bearer $$TOK' }, enabled: false, note: 'r' },
    },
  };
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'dm-mcp-form-'));
    mkdirSync(join(root, 'mcp-servers'), { recursive: true });
    const file = join(root, 'mcp-servers', 'servers.json');
    writeFileSync(file, JSON.stringify(SEED, null, 2), 'utf8');
    const store = new McpServersStore(new MinisPaths(root));
    const disk = () => JSON.parse(readFileSync(file, 'utf8')).mcpServers as Record<string, Record<string, unknown>>;
    /** 与 SecMcp.startEdit 同一取法：列表条目里表单认得的那几项 */
    const origOf = (name: string): McpOrig => {
      const e = store.list().find(x => x.name === name)!;
      return { name: e.name, transport: e.transport, command: e.command, args: e.args, url: e.url, note: e.note };
    };
    const save = (o: McpOrig | undefined, f: McpForm) => store.upsert(wire(buildMcpUpsert(o, f)) as Record<string, unknown>);
    return { store, disk, origOf, save };
  }

  it('stdio：只改备注保存，env、args（逐元素）、cwd、超时、停用、oauth 全部不变', () => {
    const { disk, origOf, save } = setup();
    const o = origOf('local');
    save(o, { ...formFromOrig(o), note: 'new' });
    // 时间戳由后端补（种子没带 createdAt，补丁也不会凭空造一个），其余键逐项与种子相同
    const { note, updatedAt, createdAt: _c, ...rest } = disk().local;
    expect(note).toBe('new');
    const { note: _n, ...seedRest } = SEED.mcpServers.local;
    expect(rest).toEqual(seedRest);
    expect(typeof updatedAt).toBe('string');
  });

  it('远端：只改备注保存，headers、停用不变；清空备注后文件里没有 note 键', () => {
    const { disk, origOf, save } = setup();
    const o = origOf('remote');
    save(o, { ...formFromOrig(o), note: 'n2' });
    expect(disk().remote.headers).toEqual({ Authorization: 'Bearer $$TOK' });
    expect(disk().remote.enabled).toBe(false);
    expect(disk().remote.note).toBe('n2');
    const o2 = origOf('remote');
    save(o2, { ...formFromOrig(o2), note: '' });
    expect(disk().remote).not.toHaveProperty('note');
    expect(disk().remote.headers).toEqual({ Authorization: 'Bearer $$TOK' });
  });

  it('改参数：带空格的路径逐元素落盘；env 与停用状态保留', () => {
    const { disk, origOf, save } = setup();
    const o = origOf('local');
    save(o, { ...formFromOrig(o), args: 'C:\\Program Files\\srv\\index.js\n--root\nE:\\Other Docs' });
    expect(disk().local.args).toEqual(['C:\\Program Files\\srv\\index.js', '--root', 'E:\\Other Docs']);
    expect(disk().local.env).toEqual({ TOKEN: '$$TOK', MODE: 'x' });
    expect(disk().local.enabled).toBe(false);
  });

  it('改名：原位换名，旧名不留孤儿，字段全带过去；文件里没有 renameFrom', () => {
    const { store, disk, origOf, save } = setup();
    const o = origOf('local');
    save(o, { ...formFromOrig(o), name: 'local2' });
    expect(store.list().map(e => e.name)).toEqual(['local2', 'remote']);
    expect(disk().local2.env).toEqual({ TOKEN: '$$TOK', MODE: 'x' });
    expect(disk().local2.args).toEqual(SEED.mcpServers.local.args);
    expect(JSON.stringify(disk())).not.toContain('renameFrom');
  });
});
