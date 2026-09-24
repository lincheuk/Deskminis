/**
 * W1b-2 · 数据根读写收窄（止血设计稿 §2「工具层」、§3 第 6 / 9 条；侦察 tools.md「W1b-datagate」；cross.md S10）。
 *
 * 旧行为：guardWrite / guardRead 只要路径在数据根内就一律免审——agent 能静默改 providers.json、
 * 写 mcp-servers/servers.json（其中的启动命令会被 DeskMinis 执行）、往 memory/SOUL.md 塞跨会话指令、
 * 读 minis.db 与其它会话的文件；工作区绑到数据根或它的祖先时，连「数据根内」这道判断都用不上，
 * 搜索三件套会一路扫进数据根。
 *
 * 新规则：
 * - 写：核心数据与凭据（以及 W1b-3 的数据根锁）硬拒，不进网关，full 档也照拒；
 *   当前会话各桶、shared 免审；mcp-servers / skills / memory / 其它会话 / 其余应用数据走卡并带 note；
 * - 读：当前会话各桶、shared、skills、memory、绑定工作区免审，数据根内其余一律走卡并带 note；
 * - 规范化：数据根、绑定工作区与目标都取 realpath（最近存在的祖先），经符号链接绕进数据根也按数据根判，
 *   数据根或工作区本身经链接给出时，里面的路径也不会被判成根外；
 * - 搜索：数据根落在基准之内时跳过它的子树，并在尾注说明。
 *
 * Linux 上 paths.resolveGuestPath 拒绝 POSIX 绝对路径（paths.ts「不支持的绝对 guest 路径」），
 * 所以宿主绝对路径的用例直接调用导出的 guardWrite / guardRead；/var/minis/* 与相对路径的用例走真工具。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileReadTool, fileWriteTool, fileEditTool, guardRead, guardWrite } from '../src/minisd/tools/files';
import { officeWriteTool } from '../src/minisd/tools/office';
import { fileGlobTool, fileGrepTool, fileListTool } from '../src/minisd/tools/search';
import { PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import { MinisPaths, DATA_ROOT_LOCK_NAME, DATA_ROOT_LOCK_RECOVERY_NAME } from '../src/minisd/paths';
import type { PermissionDecision, PermissionRequest, ToolContext } from '../src/minisd/tools/types';

/** 记下每次询问的假网关：decision 决定放行与否。 */
class RecordingGateway {
  asked: PermissionRequest[] = [];
  constructor(private decision: PermissionDecision) {}
  async check(r: PermissionRequest): Promise<PermissionDecision> { this.asked.push(r); return this.decision; }
  hasBridgeGrant(): boolean { return false; }
}

let root: string; let paths: MinisPaths; let reg: ToolRegistry;
let deny: RecordingGateway; let ctx: ToolContext;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-gate-'));
  paths = new MinisPaths(root);
  paths.ensureSessionDirs('S1');
  paths.ensureSessionDirs('S2');
  deny = new RecordingGateway('deny');
  ctx = { sessionId: 'S1', paths, permissions: deny };
  reg = new ToolRegistry();
  for (const t of [fileReadTool, fileWriteTool, fileEditTool, officeWriteTool, fileListTool, fileGlobTool, fileGrepTool]) reg.register(t);
});

const run = (name: string, args: Record<string, unknown>, c: ToolContext = ctx) =>
  reg.execute(name, JSON.stringify({ ...args, tool_title: '测' }), c);

/** 数据根根层的核心数据与凭据文件（W1b-3 的锁文件名取 paths.ts 的导出常量，两边不各写一份）。 */
const CORE = [
  'providers.json', 'providers.json.tmp', 'search-provider.json', 'search-provider.json.tmp',
  'minis.db', 'minis.db-wal', 'minis.db-shm', 'minis.db-journal',
  'pairing-index.json', 'pairing-index.json.tmp', 'peer-addresses.json', 'peer-addresses.json.tmp',
  'minisd-port.json', 'minisd-port.json.tmp', 'vault.json', 'vault.json.tmp',
];

describe('① ② 写应用配置走卡，带 note', () => {
  it('① file_write /var/minis/mcp-servers/servers.json：弹 1 卡 file-write，note 说明启动命令会被执行、不承诺时机，拒绝后文件未生成', async () => {
    const r = await run('file_write', { path: '/var/minis/mcp-servers/servers.json', content: '{"mcpServers":{}}' });
    expect(r.success).toBe(false);
    expect(deny.asked).toHaveLength(1);
    expect(deny.asked[0].kind).toBe('file-write');
    expect(deny.asked[0].detail).toBe(join(root, 'mcp-servers', 'servers.json'));
    const note = deny.asked[0].note ?? '';
    expect(note).toContain('将修改应用配置');
    expect(note).toContain('MCP');
    expect(note).toContain('启动命令');
    // 引擎不在每次运行前重读 servers.json：不许承诺「下次连接时执行」这种时机
    expect(note).not.toContain('下次连接');
    expect(existsSync(join(root, 'mcp-servers', 'servers.json'))).toBe(false);
  });

  it('② skills / memory 的 file_write、file_edit 记忆文件、office_write 到 skills：各弹 1 卡且带 note', async () => {
    writeFileSync(join(root, 'memory', 'GLOBAL.md'), '旧记忆');
    const cases: [string, Record<string, unknown>, string][] = [
      ['file_write', { path: '/var/minis/skills/x/SKILL.md', content: '---\nname: x\n---\n' }, '技能'],
      ['file_write', { path: '/var/minis/memory/SOUL.md', content: '你是…' }, 'SOUL.md'],
      ['file_edit', { path: '/var/minis/memory/GLOBAL.md', old_string: '旧', new_string: '新' }, '记忆'],
      ['office_write', { path: '/var/minis/skills/x/a.docx', content: '{"blocks":[]}' }, '技能'],
    ];
    for (const [tool, args, word] of cases) {
      const g = new RecordingGateway('deny');
      const r = await run(tool, args, { ...ctx, permissions: g });
      expect(r.success, `${tool} ${String(args.path)}`).toBe(false);
      expect(g.asked, `${tool} ${String(args.path)}`).toHaveLength(1);
      expect(g.asked[0].kind).toBe('file-write');
      expect(g.asked[0].note ?? '').toContain('将修改应用配置');
      expect(g.asked[0].note ?? '').toContain(word);
    }
    expect(existsSync(join(root, 'skills', 'x', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(root, 'memory', 'SOUL.md'))).toBe(false);
    expect(readFileSync(join(root, 'memory', 'GLOBAL.md'), 'utf8')).toBe('旧记忆');
  });

  it('批准后照常落盘（走卡不是拒绝）', async () => {
    const allow = new RecordingGateway('allow');
    const r = await run('file_write', { path: '/var/minis/skills/x/SKILL.md', content: 'body' }, { ...ctx, permissions: allow });
    expect(r.success).toBe(true);
    expect(allow.asked).toHaveLength(1);
    expect(readFileSync(join(root, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('body');
  });
});

describe('③ ④ 核心数据与凭据硬拒：不进网关，full 档也照拒', () => {
  it('③ AllowAll 网关：每个核心文件都返回含「核心数据」的拒绝串，网关 0 次调用', async () => {
    const allow = new RecordingGateway('allow');
    for (const f of [...CORE, DATA_ROOT_LOCK_NAME, DATA_ROOT_LOCK_RECOVERY_NAME, `${DATA_ROOT_LOCK_NAME}.tmp`]) {
      const out = await guardWrite(join(root, f), { ...ctx, permissions: allow }, '写');
      expect(out, f).toContain('核心数据');
      expect(out, f).toContain(join(root, f));
    }
    expect(allow.asked).toEqual([]);
  });

  it('锁文件名是 paths.ts 的导出常量（W1b-3 直接引用），接管闸若是目录，里面的路径同样硬拒', async () => {
    expect(DATA_ROOT_LOCK_NAME).toBe('minisd.lock');
    expect(DATA_ROOT_LOCK_RECOVERY_NAME).toBe('minisd.lock.recovery');
    const allow = new RecordingGateway('allow');
    expect(await guardWrite(join(root, DATA_ROOT_LOCK_RECOVERY_NAME, 'owner.json'), { ...ctx, permissions: allow }, '写')).toContain('核心数据');
    expect(allow.asked).toEqual([]);
  });

  it('④ 真网关 applyPreset(full)：硬拒类仍拒；走卡类跟随档位放行', async () => {
    const prompted: PermissionRequest[] = [];
    const gw = new PermissionGatewayImpl(async (r) => { prompted.push(r); return 'allow-once'; });
    gw.applyPreset('full');
    const full = { ...ctx, permissions: gw };
    for (const f of CORE) expect(await guardWrite(join(root, f), full, '写'), f).toContain('核心数据');
    // 设计稿 §2：full 档对「走卡」类跟随档位放行（kind 仍是 file-write，full 档本就 bypass）
    expect(await guardWrite(join(root, 'skills', 'x', 'SKILL.md'), full, '写')).toBeUndefined();
    expect(await guardRead(join(root, 'minis.db'), full, '读')).toBeUndefined();
    expect(prompted).toEqual([]);
  });

  it('工具层：file_write providers.json 被拒且文件字节不动', async () => {
    writeFileSync(join(root, 'providers.json'), '{"providers":[]}');
    const allow = new RecordingGateway('allow');
    paths.setWorkspaceResolver(() => root);
    const r = await run('file_write', { path: 'providers.json', content: 'x' }, { ...ctx, permissions: allow });
    expect(r.success).toBe(false);
    expect(r.output).toContain('核心数据');
    expect(allow.asked).toEqual([]);
    expect(readFileSync(join(root, 'providers.json'), 'utf8')).toBe('{"providers":[]}');
  });
});

describe('⑤ 数据根内的读取白名单与其它会话', () => {
  it('⑤ guardRead minis.db 及其 -wal：弹卡 file-read，note 说是会话数据库', async () => {
    for (const f of ['minis.db', 'minis.db-wal']) {
      const g = new RecordingGateway('deny');
      const out = await guardRead(join(root, f), { ...ctx, permissions: g }, '读');
      expect(out, f).toContain('读取被用户拒绝');
      expect(g.asked, f).toHaveLength(1);
      expect(g.asked[0].kind).toBe('file-read');
      expect(g.asked[0].detail).toBe(join(root, f));
      expect(g.asked[0].note ?? '').toContain('数据库');
    }
  });

  it('⑤ 其它会话（S2）的文件：读、写都弹卡，note 点名那个会话', async () => {
    const other = join(root, 'sessions', 'S2', 'workspace', 'x.txt');
    const r = new RecordingGateway('deny');
    expect(await guardRead(other, { ...ctx, permissions: r }, '读')).toBeDefined();
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0].kind).toBe('file-read');
    expect(r.asked[0].note ?? '').toContain('其它会话');
    expect(r.asked[0].note ?? '').toContain('S2');
    const w = new RecordingGateway('deny');
    expect(await guardWrite(other, { ...ctx, permissions: w }, '写')).toBeDefined();
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0].kind).toBe('file-write');
    expect(w.asked[0].note ?? '').toContain('其它会话');
    expect(w.asked[0].note ?? '').toContain('S2');
  });

  it('mcp-servers、凭据文件、其余根层文件与数据根本身的读取都走卡（白名单之外一律问）', async () => {
    const cases: [string, string][] = [
      [join(root, 'mcp-servers', 'servers.json'), 'MCP'],
      [join(root, 'minisd-port.json'), '凭据'],
      [join(root, 'providers.json'), '应用数据'],
      [join(root, 'models-dev-cache.json'), '应用数据'],
      [join(root, 'electron', 'Local State'), '应用数据'],
      [root, '应用数据'],
      [join(root, 'sessions'), '应用数据'],
    ];
    for (const [p, word] of cases) {
      const g = new RecordingGateway('deny');
      await guardRead(p, { ...ctx, permissions: g }, '读');
      expect(g.asked, p).toHaveLength(1);
      expect(g.asked[0].note ?? '', p).toContain(word);
    }
  });

  it('其余应用数据的写入走卡，note「将修改 DeskMinis 的应用数据」', async () => {
    for (const p of [join(root, 'models-dev-cache.json'), join(root, 'electron', 'Preferences'), join(root, 'sessions', 'S1', 'notes.txt')]) {
      const g = new RecordingGateway('deny');
      await guardWrite(p, { ...ctx, permissions: g }, '写');
      expect(g.asked, p).toHaveLength(1);
      expect(g.asked[0].note, p).toBe('将修改 DeskMinis 的应用数据');
    }
  });
});

describe('⑥ ⑦ 规范化：工作区绑到数据根、符号链接绕进数据根', () => {
  it('⑥ 工作区绑到数据根：写 providers.json 硬拒；读 minis.db 走卡；写当前会话桶仍免审', async () => {
    paths.setWorkspaceResolver(() => root);
    const allow = new RecordingGateway('allow');
    const c = { ...ctx, permissions: allow };
    const w = await run('file_write', { path: 'providers.json', content: '{}' }, c);
    expect(w.success).toBe(false);
    expect(w.output).toContain('核心数据');
    expect(allow.asked).toEqual([]);
    writeFileSync(join(root, 'minis.db'), 'SQLITE');
    const g = new RecordingGateway('deny');
    const r = await run('file_read', { path: 'minis.db' }, { ...ctx, permissions: g });
    expect(r.success).toBe(false);
    expect(r.output).not.toContain('SQLITE');
    expect(g.asked).toHaveLength(1);
    expect(g.asked[0].note ?? '').toContain('数据库');
    const ok = await run('file_write', { path: 'sessions/S1/workspace/a.txt', content: 'x' }, { ...ctx, permissions: deny });
    expect(ok.success).toBe(true);
    expect(deny.asked).toEqual([]);
  });

  it('⑦ 指向数据根的符号链接：经链接写 providers.json 硬拒且不进网关', async () => {
    const L = join(mkdtempSync(join(tmpdir(), 'dm-gate-link-')), 'L');
    // junction：Windows 上建目录符号链接要管理员权限，junction 不用；Linux 上忽略这个参数
    symlinkSync(root, L, 'junction');
    const allow = new RecordingGateway('allow');
    expect(await guardWrite(join(L, 'providers.json'), { ...ctx, permissions: allow }, '写')).toContain('核心数据');
    // 经链接读当前会话的桶仍免审（规范化后落在当前会话桶里）
    expect(await guardRead(join(L, 'sessions', 'S1', 'offloads', 'T1.txt'), { ...ctx, permissions: allow }, '读')).toBeUndefined();
    expect(allow.asked).toEqual([]);
  });

  // 下面两例钉的是「比较的两头都取 realpath」：只给目标取、数据根或工作区仍按字面比，
  // 数据根一旦经链接给出（Linux 的 /tmp 链接、Windows 重定向的 AppData），所有路径都会被判成根外——
  // 硬拒落空成走卡、full 档下就是静默写入；绑定工作区也会次次弹卡。
  it('⑦ 数据根本身是别名：数据根同样取 realpath，经真实路径写核心文件照拒，读当前会话 offloads 照旧免审', async () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'dm-gate-realroot-'));
    const alias = join(mkdtempSync(join(tmpdir(), 'dm-gate-rootalias-')), 'root');
    symlinkSync(realRoot, alias, 'junction');
    const ap = new MinisPaths(alias);
    ap.ensureSessionDirs('S1');
    writeFileSync(join(realRoot, 'sessions', 'S1', 'offloads', 'x.txt'), 'off');
    // 写：放行网关——判成根外就会进网关并被放行，也就是 full 档下的静默写入
    const allow = new RecordingGateway('allow');
    expect(await guardWrite(join(realRoot, 'providers.json'), { sessionId: 'S1', paths: ap, permissions: allow }, '写')).toContain('核心数据');
    expect(allow.asked).toEqual([]);
    // 读：拒绝网关——判成根外就会弹卡并被拒
    const g = new RecordingGateway('deny');
    const c: ToolContext = { sessionId: 'S1', paths: ap, permissions: g };
    expect(await guardRead(join(realRoot, 'sessions', 'S1', 'offloads', 'x.txt'), c, '读')).toBeUndefined();
    // 工具层：/var/minis/offloads 经别名数据根解析出的路径，卸载读回仍零卡
    const r = await run('file_read', { path: '/var/minis/offloads/x.txt' }, c);
    expect(r.success).toBe(true);
    expect(r.output).toContain('off');
    expect(g.asked).toEqual([]);
  });

  it('⑦ 绑定的工作区是别名：工作区同样取 realpath，经真实路径写、经别名读都零卡', async () => {
    const wsReal = mkdtempSync(join(tmpdir(), 'dm-gate-wsreal-'));
    const wsAlias = join(mkdtempSync(join(tmpdir(), 'dm-gate-wsalias-')), 'ws');
    symlinkSync(wsReal, wsAlias, 'junction');
    writeFileSync(join(wsReal, 'a.txt'), 'x');
    paths.setWorkspaceResolver(() => wsAlias);
    // ctx 用的是拒绝网关：判成工作区外就会弹卡并返回拒绝串
    expect(await guardWrite(join(wsReal, 'a.txt'), ctx, '写')).toBeUndefined();
    expect(await guardRead(join(wsAlias, 'a.txt'), ctx, '读')).toBeUndefined();
    // 工具层：相对路径按别名工作区解析，照常落盘
    const w = await run('file_write', { path: 'b.txt', content: 'y' });
    expect(w.success).toBe(true);
    expect(readFileSync(join(wsReal, 'b.txt'), 'utf8')).toBe('y');
    expect(deny.asked).toEqual([]);
  });

  it('尚不存在的深层路径：取最近存在的祖先做 realpath 再拼回，当前会话桶照旧免审', async () => {
    const out = await guardWrite(join(root, 'sessions', 'S1', 'workspace', 'new', 'deep', 'x.txt'), ctx, '写');
    expect(out).toBeUndefined();
    expect(deny.asked).toEqual([]);
  });
});

describe('⑨ 免审守卫（现状即绿，钉住收窄后仍免审）', () => {
  it('写当前会话各桶与 shared：零卡', async () => {
    for (const p of ['/var/minis/workspace/a.txt', '/var/minis/shared/a.txt', '/var/minis/attachments/a.png', '/var/minis/offloads/x.txt', '/var/minis/browser/b.txt', 'rel.txt']) {
      const r = await run('file_write', { path: p, content: 'x' });
      expect(r.success, p).toBe(true);
    }
    expect(deny.asked).toEqual([]);
  });

  it('读 skills、memory、shared 与当前会话各桶（含 offloads，卸载读回依赖它）：零卡', async () => {
    mkdirSync(join(root, 'skills', 'x'), { recursive: true });
    writeFileSync(join(root, 'skills', 'x', 'SKILL.md'), 'skill');
    writeFileSync(join(root, 'memory', 'GLOBAL.md'), 'mem');
    writeFileSync(join(root, 'shared', 's.txt'), 'shared');
    writeFileSync(join(root, 'sessions', 'S1', 'offloads', 'x.txt'), 'off');
    writeFileSync(join(root, 'sessions', 'S1', 'attachments', 'a.txt'), 'att');
    for (const p of ['/var/minis/skills/x/SKILL.md', '/var/minis/memory/GLOBAL.md', '/var/minis/shared/s.txt', '/var/minis/offloads/x.txt', '/var/minis/attachments/a.txt']) {
      const r = await run('file_read', { path: p });
      expect(r.success, p).toBe(true);
    }
    expect(deny.asked).toEqual([]);
  });

  it('数据根与工作区之外：照旧走卡且不带 note', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'dm-gate-out-')), 'x.txt');
    await guardWrite(outside, ctx, '写');
    await guardRead(outside, ctx, '读');
    expect(deny.asked.map(a => a.kind)).toEqual(['file-write', 'file-read']);
    expect(deny.asked.every(a => a.note === undefined)).toBe(true);
  });
});

describe('⑩ 搜索三件套跳过数据根子树', () => {
  it('工作区绑到数据根的上级：file_grep / file_glob 不进数据根，尾注说明跳过；零卡', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dm-gate-parent-'));
    const inner = join(parent, 'data');
    const p2 = new MinisPaths(inner);
    p2.ensureSessionDirs('S1');
    writeFileSync(join(inner, 'mcp-servers', 'servers.json'), '{"NEEDLE":1}');
    writeFileSync(join(inner, 'sessions', 'S1', 'workspace', 'w.json'), 'NEEDLE');
    writeFileSync(join(parent, 'proj.json'), 'NEEDLE');
    p2.setWorkspaceResolver(() => parent);
    const g = new RecordingGateway('deny');
    const c: ToolContext = { sessionId: 'S1', paths: p2, permissions: g };
    const grep = await run('file_grep', { pattern: 'NEEDLE' }, c);
    expect(grep.success).toBe(true);
    expect(grep.output).toContain('proj.json:1:');
    expect(grep.output).not.toContain('servers.json');
    expect(grep.output).not.toContain('w.json');
    expect(grep.output).toContain('已跳过 DeskMinis 数据目录');
    const glob = await run('file_glob', { pattern: '**/*.json' }, c);
    expect(glob.success).toBe(true);
    expect(glob.output).toContain('proj.json');
    expect(glob.output).not.toContain('servers.json');
    expect(glob.output).toContain('已跳过 DeskMinis 数据目录');
    expect(g.asked).toEqual([]);
  });

  it('基准就在数据根内（默认工作区）：不出跳过尾注', async () => {
    writeFileSync(join(root, 'sessions', 'S1', 'workspace', 'a.txt'), 'NEEDLE');
    const grep = await run('file_grep', { pattern: 'NEEDLE' });
    expect(grep.output).toContain('a.txt:1:');
    expect(grep.output).not.toContain('已跳过');
  });
});
