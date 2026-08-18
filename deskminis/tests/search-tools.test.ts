import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileListTool, fileGlobTool, fileGrepTool, globToRegExp, walkDir } from '../src/minisd/tools/search';
import type { ToolContext, PermissionRequest, PermissionDecision } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

class AllowAllGateway { async check(_r: PermissionRequest): Promise<PermissionDecision> { return 'allow'; } hasBridgeGrant(): boolean { return false; } }
class DenyAllGateway { asked: PermissionRequest[] = []; async check(r: PermissionRequest): Promise<PermissionDecision> { this.asked.push(r); return 'deny'; } hasBridgeGrant(): boolean { return false; } }

let root: string; let ws: string; let ctx: ToolContext; let reg: ToolRegistry;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-search-'));
  const paths = new MinisPaths(root);
  paths.ensureSessionDirs('S1');
  ws = join(root, 'sessions', 'S1', 'workspace');
  ctx = { sessionId: 'S1', paths, permissions: new AllowAllGateway() };
  reg = new ToolRegistry();
  reg.register(fileListTool); reg.register(fileGlobTool); reg.register(fileGrepTool);
});

describe('globToRegExp 纯函数', () => {
  it('** 跨层匹配（含零层）', () => {
    const re = globToRegExp('**/*.ts');
    expect(re.test('a.ts')).toBe(true); // **/ 也匹配零层目录
    expect(re.test('sub/a.ts')).toBe(true);
    expect(re.test('sub/deep/a.ts')).toBe(true);
    expect(re.test('a.tsx')).toBe(false);
  });
  it('* 不跨层', () => {
    const re = globToRegExp('*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('sub/a.ts')).toBe(false);
  });
  it('? 单字符（且不匹配分隔符）', () => {
    const re = globToRegExp('a?.ts');
    expect(re.test('ab.ts')).toBe(true);
    expect(re.test('a.ts')).toBe(false);
    expect(re.test('abb.ts')).toBe(false);
    expect(re.test('a/.ts')).toBe(false);
  });
  it('正则元字符按字面量转义', () => {
    const plus = globToRegExp('a+b.ts');
    expect(plus.test('a+b.ts')).toBe(true);
    expect(plus.test('aab.ts')).toBe(false); // + 不再是「前一个字符重复」
    const dot = globToRegExp('a.ts');
    expect(dot.test('a.ts')).toBe(true);
    expect(dot.test('aXts')).toBe(false); // . 不再是任意字符
  });
  it('{}[]() 语法直接拒绝', () => {
    for (const p of ['{a,b}.ts', 'x[0-9].ts', 'f(n).ts']) expect(() => globToRegExp(p)).toThrow();
  });
});

describe('walkDir 纯函数', () => {
  it('收集文件与目录, 相对路径为正斜杠且按名排序', () => {
    mkdirSync(join(ws, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(ws, 'b.txt'), 'x');
    writeFileSync(join(ws, 'sub', 'a.txt'), 'x');
    const r = walkDir(ws);
    expect(r.files).toEqual(['b.txt', 'sub/a.txt']);
    expect(r.dirs).toEqual(['sub', 'sub/deep']);
  });
  it('junction 目录不进入、链接条目不进结果', () => {
    mkdirSync(join(ws, 'real'));
    writeFileSync(join(ws, 'real', 'x.ts'), 'x');
    symlinkSync(join(ws, 'real'), join(ws, 'link'), 'junction');
    const r = walkDir(ws);
    expect(r.files).toEqual(['real/x.ts']);
    expect(r.dirs).toEqual(['real']);
  });
});

describe('file_list', () => {
  it('目录在前、各自按名排序; 目录行带 /、文件行带字节数', async () => {
    writeFileSync(join(ws, 'b.txt'), '123');
    mkdirSync(join(ws, 'a'));
    writeFileSync(join(ws, 'c.txt'), 'x');
    const r = await reg.execute('file_list', JSON.stringify({ path: '.', tool_title: '列目录' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output.split('\n')).toEqual(['a/', 'b.txt\t3', 'c.txt\t1']);
  });
  it('上限 500 条, 超出截断并尾附总数', async () => {
    for (let i = 0; i < 502; i++) writeFileSync(join(ws, `f${String(i).padStart(3, '0')}.txt`), '');
    const r = await reg.execute('file_list', JSON.stringify({ path: '.', tool_title: '列目录' }), ctx);
    expect(r.success).toBe(true);
    const lines = r.output.split('\n');
    expect(lines).toHaveLength(501); // 500 条 + 1 行尾注
    expect(lines[500]).toBe('[已截断: 共 502 项]');
  });
  it('对文件路径调用返回 success:false', async () => {
    writeFileSync(join(ws, 'a.txt'), 'x');
    const r = await reg.execute('file_list', JSON.stringify({ path: 'a.txt', tool_title: '列目录' }), ctx);
    expect(r.success).toBe(false);
  });
});

describe('file_glob', () => {
  beforeEach(() => {
    writeFileSync(join(ws, 'r.ts'), 'x');
    writeFileSync(join(ws, 'n.md'), 'x');
    mkdirSync(join(ws, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(ws, 'sub', 's.ts'), 'x');
    writeFileSync(join(ws, 'sub', 'deep', 'd.ts'), 'x');
  });
  it('**/*.ts 跨层命中, 输出正斜杠相对路径并按名排序（默认基准为工作区根）', async () => {
    const r = await reg.execute('file_glob', JSON.stringify({ pattern: '**/*.ts', tool_title: '找ts' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output.split('\n')).toEqual(['r.ts', 'sub/deep/d.ts', 'sub/s.ts']);
  });
  it('*.ts 不跨层, 只命中基准目录单层', async () => {
    const r = await reg.execute('file_glob', JSON.stringify({ pattern: '*.ts', tool_title: '找ts' }), ctx);
    expect(r.output.split('\n')).toEqual(['r.ts']);
  });
  it('? 单字符', async () => {
    writeFileSync(join(ws, 'a1.ts'), 'x');
    writeFileSync(join(ws, 'ab2.ts'), 'x');
    const r = await reg.execute('file_glob', JSON.stringify({ pattern: 'a?.ts', tool_title: '找ts' }), ctx);
    expect(r.output.split('\n')).toEqual(['a1.ts']);
  });
  it('{a,b} 语法被拒绝', async () => {
    const r = await reg.execute('file_glob', JSON.stringify({ pattern: '{a,b}.ts', tool_title: '找文件' }), ctx);
    expect(r.success).toBe(false);
    expect(r.output).toContain('不支持');
  });
  it('junction 目录不进入', async () => {
    mkdirSync(join(ws, 'real'));
    writeFileSync(join(ws, 'real', 'x.ts'), 'x');
    symlinkSync(join(ws, 'real'), join(ws, 'link'), 'junction');
    const r = await reg.execute('file_glob', JSON.stringify({ pattern: '**/*.ts', tool_title: '找文件' }), ctx);
    expect(r.output).toContain('real/x.ts');
    expect(r.output).not.toContain('link/'); // junction 目标里的文件不能借链接路径被扫出
  });
});

describe('file_grep', () => {
  it('行号与内容正确', async () => {
    writeFileSync(join(ws, 'a.txt'), 'one\ntwo SEARCH\nthree');
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'b.txt'), 'SEARCH at top');
    const r = await reg.execute('file_grep', JSON.stringify({ pattern: 'SEARCH', tool_title: '搜索' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output.split('\n')).toEqual(['a.txt:2:two SEARCH', 'sub/b.txt:1:SEARCH at top']);
  });
  it('ignore_case 生效', async () => {
    writeFileSync(join(ws, 'a.txt'), 'MiXeD');
    const no = await reg.execute('file_grep', JSON.stringify({ pattern: 'mixed', tool_title: '搜' }), ctx);
    expect(no.output).toContain('未找到');
    const yes = await reg.execute('file_grep', JSON.stringify({ pattern: 'mixed', ignore_case: true, tool_title: '搜' }), ctx);
    expect(yes.output).toContain('a.txt:1:MiXeD');
  });
  it('glob 文件名过滤生效', async () => {
    writeFileSync(join(ws, 'a.ts'), 'HIT');
    writeFileSync(join(ws, 'b.md'), 'HIT');
    const r = await reg.execute('file_grep', JSON.stringify({ pattern: 'HIT', glob: '*.ts', tool_title: '搜' }), ctx);
    expect(r.output).toContain('a.ts:1:HIT');
    expect(r.output).not.toContain('b.md');
  });
  it('非法正则友好失败', async () => {
    const r = await reg.execute('file_grep', JSON.stringify({ pattern: '(', tool_title: '搜' }), ctx);
    expect(r.success).toBe(false);
    expect(r.output).toContain('正则');
  });
  it('二进制文件（含 \\0）被跳过并计入尾注', async () => {
    writeFileSync(join(ws, 'bin.dat'), Buffer.concat([Buffer.from('NEEDLE'), Buffer.from([0]), Buffer.from('tail')]));
    writeFileSync(join(ws, 'ok.txt'), 'NEEDLE here');
    const r = await reg.execute('file_grep', JSON.stringify({ pattern: 'NEEDLE', tool_title: '搜' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('ok.txt:1:NEEDLE here');
    expect(r.output).not.toContain('bin.dat:');
    expect(r.output).toContain('二进制');
  });
  it('超过 1MB 的文件被跳过并计入尾注', async () => {
    writeFileSync(join(ws, 'big.txt'), Buffer.concat([Buffer.alloc(1024 * 1024, 0x41), Buffer.from('NEEDLE')]));
    const r = await reg.execute('file_grep', JSON.stringify({ pattern: 'NEEDLE', tool_title: '搜' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).not.toContain('big.txt:');
    expect(r.output).toContain('1MB');
  });
  it('单行只扫前 10000 字符; 展示内容截断到 500 字符', async () => {
    // 命中点在前 10000 内 → 匹配成功, 但 606 字符的行只展示前 500
    writeFileSync(join(ws, 'hit.txt'), 'NEEDLE' + 'A'.repeat(600));
    const hit = await reg.execute('file_grep', JSON.stringify({ pattern: 'NEEDLE', tool_title: '搜' }), ctx);
    const line = hit.output.split('\n').find(l => l.startsWith('hit.txt:'))!;
    expect(line.slice('hit.txt:1:'.length).length).toBe(500);
    // 命中点在前 10000 之外 → 不匹配（防灾难回溯的输入面裁剪）
    writeFileSync(join(ws, 'beyond.txt'), 'B'.repeat(10000) + 'NEEDLE');
    const beyond = await reg.execute('file_grep', JSON.stringify({ pattern: 'NEEDLE', tool_title: '搜' }), ctx);
    expect(beyond.output).not.toContain('beyond.txt:');
  });
});

describe('search 工具权限', () => {
  it('绑定自定义工作区后三件套都不触发权限门', async () => {
    const deny = new DenyAllGateway();
    const custom = mkdtempSync(join(tmpdir(), 'dm-ws-'));
    mkdirSync(join(custom, 'd'));
    writeFileSync(join(custom, 'a.txt'), 'NEEDLE');
    ctx.paths.setWorkspaceResolver(() => custom);
    const l = await reg.execute('file_list', JSON.stringify({ path: 'd', tool_title: '列' }), { ...ctx, permissions: deny });
    const g = await reg.execute('file_glob', JSON.stringify({ pattern: '*.txt', tool_title: '找' }), { ...ctx, permissions: deny });
    const s = await reg.execute('file_grep', JSON.stringify({ pattern: 'NEEDLE', tool_title: '搜' }), { ...ctx, permissions: deny });
    expect(l.success && g.success && s.success).toBe(true);
    expect(deny.asked).toEqual([]);
  });
  it('工作区外基准 → 每个工具恰好一条 kind=file-read, detail 为基准绝对路径', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dm-out-'));
    mkdirSync(join(outside, 'sub'));
    writeFileSync(join(outside, 'sub', 'a.txt'), 'NEEDLE');
    const cases = [
      ['file_list', { path: outside }],
      ['file_glob', { pattern: '**/*.txt', path: outside }],
      ['file_grep', { pattern: 'NEEDLE', path: outside }],
    ] as const;
    for (const [name, args] of cases) {
      const deny = new DenyAllGateway();
      const r = await reg.execute(name, JSON.stringify({ ...args, tool_title: '外部' }), { ...ctx, permissions: deny });
      expect(r.success).toBe(false);
      expect(deny.asked).toHaveLength(1);
      expect(deny.asked[0].kind).toBe('file-read');
      expect(deny.asked[0].detail).toBe(resolve(outside));
    }
  });
  it('路径穿越（../ 越界）被 resolveGuestPath 拒绝', async () => {
    const cases = [
      ['file_list', { path: '../escape' }],
      ['file_glob', { pattern: '*', path: '../escape' }],
      ['file_grep', { pattern: 'x', path: '../escape' }],
    ] as const;
    for (const [name, args] of cases) {
      const r = await reg.execute(name, JSON.stringify({ ...args, tool_title: '穿越' }), ctx);
      expect(r.success).toBe(false);
      expect(r.output).toContain('路径穿越');
    }
  });
});

describe('search 工具取消', () => {
  it('预先 abort 的 signal → [已取消]', async () => {
    const controller = new AbortController();
    controller.abort();
    const cases = [
      ['file_list', { path: '.' }],
      ['file_glob', { pattern: '*' }],
      ['file_grep', { pattern: 'x' }],
    ] as const;
    for (const [name, args] of cases) {
      const r = await reg.execute(name, JSON.stringify({ ...args, tool_title: '取消' }), { ...ctx, signal: controller.signal });
      expect(r.success).toBe(false);
      expect(r.output).toBe('[已取消]');
    }
  });
});
