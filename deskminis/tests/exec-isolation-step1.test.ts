/** 执行隔离方案第 1 步：用 PowerShell 自己的解析器判断命令。
 *
 *  1. 解析进程（ps-parse.ts）：只解析不执行；超时、退出、输出不对一律给 undefined，连续失败到上限后不再尝试。
 *  2. 按语法树判断（shell-analysis.ts）：认出更多危险写法；命令名或代码运行时才拼出来的归「看不透」；
 *     只读免问要求参数与当前目录都在工作区里；; 串起来的只读命令也算只读。
 *  3. 网关接上钩子之后：看不透的命令询问时卡上带原因，完全访问档放行，只读 / 计划档拒绝。
 *  4. Windows 上用真的 powershell.exe 跑一遍解析脚本与当前目录查询（其它平台跳过）。 */
import { describe, it, expect, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { spawn } from 'node:child_process';
import { decodeSummary, PARSE_MAX_CHARS, PsParser, type PsArg, type PsCommand, type PsSummary } from '../src/minisd/tools/ps-parse';
import { analyzeShell, analyzeShellCommand, OPAQUE_NOTE, OUTSIDE_NOTE, type AnalyzeEnv } from '../src/minisd/tools/shell-analysis';
import { PermissionGatewayImpl, type ShellAnalysis } from '../src/minisd/tools/permissions';
import type { PermissionRequest } from '../src/minisd/tools/types';
import { PersistentShell } from '../src/minisd/tools/shell';
import { powershellPath } from '../src/minisd/proc/win-exec';
import { childEnv } from '../src/minisd/proc/child-env';

const WIN = process.platform === 'win32';

// ---------- 手搭语法树摘要 ----------
const S = (v: string): PsArg => ({ t: 's', v });
const P = (n: string, v?: string): PsArg => (v === undefined ? { t: 'p', n } : { t: 'p', n, v });
const X = (v: string): PsArg => ({ t: 'x', v });
const C = (n: string | null, ...a: PsArg[]): PsCommand => ({ n, o: 'Unknown', sb: false, a, r: [] });

/** 语句位置按 ; 与换行切（测试命令里没有引号内的 ;）。 */
function sum(command: string, commands: PsCommand[], extra: Partial<PsSummary> = {}): PsSummary {
  const statements: Array<[number, number]> = [];
  const re = /[^;\n]+/g;
  for (const m of command.matchAll(re)) {
    const lead = m[0].length - m[0].trimStart().length;
    const text = m[0].trim();
    if (text === '') continue;
    const a = (m.index ?? 0) + lead;
    statements.push([a, a + text.length]);
  }
  return { errors: 0, complex: false, statements, commands, members: [], ...extra };
}

const ENV: AnalyzeEnv = { workspace: 'C:\\ws', cwd: 'C:\\ws', platform: 'win32' };
const cls = (command: string, s: PsSummary | undefined, env: AnalyzeEnv = ENV): ShellAnalysis => analyzeShell(command, s, env);

describe('只读免问：参数与当前目录都要在工作区里', () => {
  it.each<[string, PsCommand[]]>([
    ['type src\\a.ts', [C('type', S('src\\a.ts'))]],
    ['gc C:\\ws\\a.txt', [C('gc', S('C:\\ws\\a.txt'))]],
    ['gc c:\\WS\\a.txt', [C('gc', S('c:\\WS\\a.txt'))]], // Windows 路径不分大小写
    ['rg TODO src', [C('rg', S('TODO'), S('src'))]],
    ['rg -n "import.*from" src', [C('rg', P('n'), S('import.*from'), S('src'))]],
    ['gc -Encoding utf8 a.txt', [C('gc', P('Encoding'), S('utf8'), S('a.txt'))]],
    ['gc -Encoding:utf8 a.txt', [C('gc', P('Encoding', 'utf8'), S('a.txt'))]],
    ['findstr /s /i foo *.ts', [C('findstr', S('/s'), S('/i'), S('foo'), S('*.ts'))]],
    ['git log --format=%H -- src', [C('git', S('log'), S('--format=%H'), S('--'), S('src'))]],
    ['sls "/api/v1" src\\*.ts', [C('sls', S('/api/v1'), S('src\\*.ts'))]], // select-string 的第一个位置参数是模式串
    ['gci | Select-Object Name, Length', [C('gci'), C('Select-Object', S('Name'), S('Length'))]],
    ['dir', [C('dir')]],
  ])('%s → readonly', (command, commands) => {
    expect(cls(command, sum(command, commands))).toEqual({ cls: 'readonly' });
  });

  it.each<[string, PsCommand[]]>([
    ['type C:\\Users\\u\\.ssh\\id_ed25519', [C('type', S('C:\\Users\\u\\.ssh\\id_ed25519'))]],
    ['rg foo D:\\other', [C('rg', S('foo'), S('D:\\other'))]],
    ['gc -Path C:\\secret.txt', [C('gc', P('Path'), S('C:\\secret.txt'))]],
    ['gc -P C:\\secret.txt', [C('gc', P('P'), S('C:\\secret.txt'))]], // -P 就是 -Path，不能当非路径参数跳过
    ['findstr /g:C:\\x\\p.txt foo a.txt', [C('findstr', S('/g:C:\\x\\p.txt'), S('foo'), S('a.txt'))]],
    ['dir /Windows', [C('dir', S('/Windows'))]], // dir 是 Get-ChildItem，/Windows 是 C:\Windows
    ['rg --ignore-file=C:\\x foo', [C('rg', S('--ignore-file=C:\\x'), S('foo'))]],
    ['Get-ItemProperty HKLM:\\SOFTWARE\\x', [C('Get-ItemProperty', S('HKLM:\\SOFTWARE\\x'))]],
    ['gci ~', [C('gci', S('~'))]],
    ['gc $f', [C('gc', X('$f'))]], // 变量：运行时才知道读哪里
    ['sls foo -Path C:\\x', [C('sls', S('foo'), P('Path'), S('C:\\x'))]],
  ])('%s → 询问，并说明读到了工作区外', (command, commands) => {
    expect(cls(command, sum(command, commands))).toEqual({ cls: 'gated', note: OUTSIDE_NOTE });
  });

  it('当前目录已经不在工作区里：不带参数的 dir 也询问', () => {
    expect(cls('dir', sum('dir', [C('dir')]), { ...ENV, cwd: 'C:\\elsewhere' })).toEqual({ cls: 'gated', note: OUTSIDE_NOTE });
  });

  it('当前目录说不清：只读命令询问', () => {
    expect(cls('git status', sum('git status', [C('git', S('status'))]), { ...ENV, cwd: undefined })).toEqual({ cls: 'gated', note: OUTSIDE_NOTE });
  });

  it('; 与换行串起来的只读命令算只读', () => {
    const a = 'git status; git diff';
    expect(cls(a, sum(a, [C('git', S('status')), C('git', S('diff'))]))).toEqual({ cls: 'readonly' });
    const b = 'git status\ngit log -n 3';
    expect(cls(b, sum(b, [C('git', S('status')), C('git', S('log'), P('n'), S('3'))]))).toEqual({ cls: 'readonly' });
  });

  it('串起来的里面有一条不是只读：照常询问，不加说明', () => {
    const c = 'git status; npm install';
    expect(cls(c, sum(c, [C('git', S('status')), C('npm', S('install'))]))).toEqual({ cls: 'gated' });
  });

  it('串起来的只读命令里任何一条点到工作区外：询问', () => {
    const c = 'git status; type C:\\x.txt';
    expect(cls(c, sum(c, [C('git', S('status')), C('type', S('C:\\x.txt'))])).cls).toBe('gated');
  });

  it('有 param / begin 块、trap 等结构的不按只读放行', () => {
    expect(cls('git status', sum('git status', [C('git', S('status'))], { complex: true })).cls).toBe('gated');
  });

  it('语句之间夹着别的东西（注释等）不按只读放行', () => {
    const c = 'git status <#x#> ; git diff';
    const s: PsSummary = { errors: 0, complex: false, statements: [[0, 10], [19, 27]], commands: [C('git', S('status')), C('git', S('diff'))], members: [] };
    expect(cls(c, s).cls).toBe('gated');
  });

  it('文件重定向的命令不按只读放行', () => {
    expect(cls('git status', sum('git status', [{ ...C('git', S('status')), r: ['out.txt'] }])).cls).toBe('gated');
  });
});

describe('按语法树认出更多危险写法', () => {
  it.each<[string, PsSummary]>([
    ['& "Re`move-Item" x', sum('x', [{ ...C('Remove-Item', S('x')), o: 'Ampersand' }])],
    ['& \'C:\\Windows\\System32\\cmd.exe\' \'/c\' \'del x\'', sum('x', [C('C:\\Windows\\System32\\cmd.exe', S('/c'), S('del x'))])],
    ['& "for`mat-volume" -DriveLetter D', sum('x', [C('Format-Volume', P('DriveLetter'), S('D'))])],
    ['(Get-Item a.txt).Delete()', sum('x', [C('Get-Item', S('a.txt'))], { members: [{ s: false, ty: null, m: 'Delete' }] })],
    ['[IO.File]::"Del`ete"("a")', sum('x', [], { members: [{ s: true, ty: 'IO.File', m: 'Delete' }] })],
    ['$fs::DeleteDirectory("a")', sum('x', [], { members: [{ s: true, ty: null, m: 'DeleteDirectory' }] })],
  ])('%s → danger', (command, s) => {
    expect(cls(command, s)).toEqual({ cls: 'danger' });
  });

  it('文本规则已判危险的，不看语法树', () => {
    expect(cls('Remove-Item x', undefined)).toEqual({ cls: 'danger' });
    expect(cls('Remove-Item x', sum('Remove-Item x', [C('Remove-Item', S('x'))]))).toEqual({ cls: 'danger' });
  });

  it('实例上的普通方法不算危险', () => {
    expect(cls('$list.Add(1)', sum('x', [], { members: [{ s: false, ty: null, m: 'Add' }] })).cls).toBe('gated');
  });
});

describe('看不透的命令', () => {
  const sb = (n: null, ...a: PsArg[]): PsCommand => ({ ...C(n, ...a), sb: true, o: 'Ampersand' });
  it.each<[string, PsSummary]>([
    ['& $x', sum('x', [{ ...C(null), o: 'Ampersand' }])],
    ['& ("Remove-" + "Item") x', sum('x', [{ ...C(null, S('x')), o: 'Ampersand' }])],
    ['. $script', sum('x', [{ ...C(null), o: 'Dot' }])],
    ['iex $code', sum('x', [C('iex', X('$code'))])],
    ['Invoke-Expression "gci"', sum('x', [C('Invoke-Expression', S('gci'))])],
    ['Add-Type -TypeDefinition $src', sum('x', [C('Add-Type', P('TypeDefinition'), X('$src'))])],
    ['powershell -Command $c', sum('x', [C('powershell', P('Command'), X('$c'))])],
    ['cmd /c $c', sum('x', [C('cmd', S('/c'), X('$c'))])],
    ['[scriptblock]::Create($s)', sum('x', [], { members: [{ s: true, ty: 'scriptblock', m: 'Create' }] })],
    ['$sb.Invoke()', sum('x', [], { members: [{ s: false, ty: null, m: 'Invoke' }] })],
    ['$ExecutionContext.InvokeCommand.InvokeScript($s)', sum('x', [], { members: [{ s: false, ty: null, m: 'InvokeScript' }] })],
    ['$o.$m()', sum('x', [], { members: [{ s: false, ty: null, m: null }] })],
    ['$t::Run()', sum('x', [], { members: [{ s: true, ty: null, m: 'Run' }] })],
  ])('%s → opaque', (command, s) => {
    expect(cls(command, s)).toEqual({ cls: 'opaque', note: OPAQUE_NOTE });
  });

  it('& { … } 的内容看得见：按里面的命令判断', () => {
    expect(cls('& { npm test }', sum('x', [sb(null), C('npm', S('test'))])).cls).toBe('gated');
    expect(cls('& { Remove-Item x }', sum('x', [sb(null), C('Remove-Item', S('x'))])).cls).toBe('danger');
  });

  it('危险优先于看不透', () => {
    expect(cls('& $x; & "Remo`ve-Item" y', sum('x', [{ ...C(null), o: 'Ampersand' }, C('Remove-Item', S('y'))])).cls).toBe('danger');
  });
});

describe('拿不到语法树时照旧按文本规则', () => {
  it.each([['git status', 'readonly'], ['npm install', 'gated'], ['git status; git diff', 'gated'], ['type C:\\x', 'readonly']])('%s → %s', (command, expected) => {
    expect(cls(command, undefined).cls).toBe(expected);
  });

  it('有语法错误的命令（驱动也执行不了）按文本规则', () => {
    expect(cls('gci (', sum('gci (', [C(null)], { errors: 1 }))).toEqual({ cls: 'gated' });
  });
});

describe('analyzeShellCommand', () => {
  const fakeParser = (s: PsSummary | undefined) => {
    const calls: string[] = [];
    return { calls, parse: async (c: string) => { calls.push(c); return s; } };
  };

  it('只在可能只读时才去问当前目录', async () => {
    let asked = 0;
    const env = { workspace: 'C:\\ws', platform: 'win32', cwd: async () => { asked++; return 'C:\\ws'; } };
    expect(await analyzeShellCommand('git status', env, fakeParser(sum('git status', [C('git', S('status'))])))).toEqual({ cls: 'readonly' });
    expect(asked).toBe(1);
    expect(await analyzeShellCommand('& $x', env, fakeParser(sum('& $x', [{ ...C(null), o: 'Ampersand' }]))))
      .toEqual({ cls: 'opaque', note: OPAQUE_NOTE });
    expect(asked).toBe(1);
  });

  it('解析器没给结果：返回 undefined（网关按文本规则）', async () => {
    const env = { workspace: 'C:\\ws', platform: 'win32', cwd: async () => 'C:\\ws' };
    expect(await analyzeShellCommand('git status', env, fakeParser(undefined))).toBeUndefined();
  });

  it('文本规则判危险的不送去解析', async () => {
    const p = fakeParser(undefined);
    expect(await analyzeShellCommand('Remove-Item x', { workspace: 'C:\\ws', cwd: async () => 'C:\\ws' }, p)).toBeUndefined();
    expect(p.calls).toEqual([]);
  });

  it('查当前目录出错：只读命令询问', async () => {
    const env = { workspace: 'C:\\ws', platform: 'win32', cwd: async () => { throw new Error('x'); } };
    expect(await analyzeShellCommand('git status', env, fakeParser(sum('git status', [C('git', S('status'))]))))
      .toEqual({ cls: 'gated', note: OUTSIDE_NOTE });
  });
});

describe('网关接上钩子', () => {
  const req = (detail: string): PermissionRequest => ({ kind: 'shell', detail, sessionId: 'S1', toolTitle: 't' });
  const gw = (analysis: ShellAnalysis | undefined | (() => never), answer: 'allow-once' | 'allow-session' | 'deny' = 'deny') => {
    const asked: PermissionRequest[] = [];
    let hookCalls = 0;
    const g = new PermissionGatewayImpl(async r => { asked.push(r); return answer; }, undefined, undefined, undefined, {
      analyzeShell: async () => { hookCalls++; return typeof analysis === 'function' ? analysis() : analysis; },
    });
    return { g, asked, hookCalls: () => hookCalls };
  };

  it('看不透的命令：询问档弹卡、卡上带原因；完全访问档放行', async () => {
    const t = gw({ cls: 'opaque', note: OPAQUE_NOTE });
    expect(await t.g.check(req('iex $c'))).toBe('deny');
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0].note).toBe(OPAQUE_NOTE);
    expect(t.asked[0].shellClass).toBe('opaque');
    t.g.applyPreset('full');
    expect(await t.g.check(req('iex $c'))).toBe('allow');
    expect(t.asked).toHaveLength(1);
  });

  it('看不透的命令：只读 / 计划档直接拒绝', async () => {
    const t = gw({ cls: 'opaque', note: OPAQUE_NOTE });
    t.g.applyPreset('plan');
    expect(await t.g.decide(req('iex $c'))).toEqual({ decision: 'deny', reason: 'rule-blocked', cause: 'plan-mode' });
    expect(t.asked).toHaveLength(0);
  });

  it('「本会话允许」过的看不透命令，同一条不再询问', async () => {
    const t = gw({ cls: 'opaque' }, 'allow-session');
    expect(await t.g.check(req('iex $c'))).toBe('allow');
    expect(await t.g.check(req('iex $c'))).toBe('allow');
    expect(t.asked).toHaveLength(1);
  });

  it('语法树认出的危险命令：任何档位都不问、直接拒绝', async () => {
    const t = gw({ cls: 'danger' });
    t.g.applyPreset('full');
    expect(await t.g.decide(req('& "Re`move-Item" x'))).toEqual({ decision: 'deny', reason: 'rule-blocked', cause: 'shell-danger' });
    expect(t.asked).toHaveLength(0);
  });

  it('串起来的只读命令：免问', async () => {
    const t = gw({ cls: 'readonly' });
    expect(await t.g.decide(req('git status; git diff'))).toEqual({ decision: 'allow', via: 'level-bypass' });
    expect(t.asked).toHaveLength(0);
  });

  it('读到工作区外的只读命令：询问档询问，完全访问档照旧放行', async () => {
    const t = gw({ cls: 'gated', note: OUTSIDE_NOTE });
    expect(await t.g.check(req('type C:\\x.txt'))).toBe('deny');
    expect(t.asked[0].note).toBe(OUTSIDE_NOTE);
    t.g.applyPreset('full');
    expect(await t.g.decide(req('type C:\\x.txt'))).toEqual({ decision: 'allow', via: 'level-bypass' });
  });

  it('计划档：读到工作区外的只读命令询问（与文本规则回落的只读命令一样）', async () => {
    const t = gw({ cls: 'gated', note: OUTSIDE_NOTE });
    t.g.applyPreset('plan');
    expect(await t.g.check(req('type C:\\x.txt'))).toBe('deny');
    expect(t.asked).toHaveLength(1);
  });

  it('钩子抛错或给不出结果：按文本规则', async () => {
    const a = gw(() => { throw new Error('boom'); });
    expect(await a.g.decide(req('git status'))).toEqual({ decision: 'allow', via: 'level-bypass' });
    const b = gw(undefined);
    expect(await b.g.check(req('npm install'))).toBe('deny');
    expect(b.asked[0].shellClass).toBeUndefined();
  });

  it('文本规则判危险的不调钩子；非 shell 请求也不调', async () => {
    const t = gw({ cls: 'readonly' });
    expect((await t.g.decide(req('Remove-Item x'))).decision).toBe('deny');
    await t.g.decide({ kind: 'file-read', detail: 'C:\\x', sessionId: 'S1', toolTitle: 't' });
    expect(t.hookCalls()).toBe(0);
  });

  it('请求自带的 note 不被覆盖', async () => {
    const t = gw({ cls: 'opaque', note: OPAQUE_NOTE });
    await t.g.check({ ...req('iex $c'), note: '原来的说明' });
    expect(t.asked[0].note).toBe('原来的说明');
  });
});

describe('解析进程（假进程）', () => {
  const enc = (s: string): string => Buffer.from(s, 'utf16le').toString('base64');
  const EMPTY = '{"e":0,"cx":0,"s":[],"c":[],"m":[]}';

  class FakeChild extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    exitCode: number | null = null;
    killed = false;
    lines: string[] = [];
    constructor(reply: ((line: string, child: FakeChild) => void) | undefined) {
      super();
      let buf = '';
      this.stdin.on('data', (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          this.lines.push(line);
          reply?.(line, this);
        }
      });
    }
    kill(): boolean { this.killed = true; this.exitCode = 1; setImmediate(() => this.emit('exit', 1, null)); return true; }
    unref(): void { /* 测试里不管 */ }
  }

  function setup(reply?: (line: string, child: FakeChild) => void) {
    const children: FakeChild[] = [];
    const spawnImpl = ((..._a: unknown[]) => { const c = new FakeChild(reply); children.push(c); return c; }) as unknown as typeof spawn;
    const parser = new PsParser({ exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', spawnImpl, timeoutMs: 50, firstTimeoutMs: 50 });
    return { parser, children };
  }
  const answer = (json: string) => (line: string, child: FakeChild): void => {
    const id = line.split(' ')[0];
    child.stdout.write(`${id} ${json}\r\n`);
  };

  it('一行一条：命令按 UTF-8 base64 传过去，结果解码成摘要', async () => {
    const json = `{"e":0,"cx":0,"s":[[0,10]],"c":[{"n":"${enc('git')}","o":"Unknown","sb":false,"a":[{"t":"s","v":"${enc('状态')}"},{"t":"p","n":"${enc('n')}","v":"${enc('3')}"},{"t":"x","v":"${enc('$x')}"}],"r":[]}],"m":[{"s":true,"ty":"${enc('IO.File')}","m":null}]}`;
    const { parser, children } = setup(answer(json));
    const s = await parser.parse('git 状态');
    expect(s).toEqual({
      errors: 0, complex: false, statements: [[0, 10]],
      commands: [{ n: 'git', o: 'Unknown', sb: false, a: [{ t: 's', v: '状态' }, { t: 'p', n: 'n', v: '3' }, { t: 'x', v: '$x' }], r: [] }],
      members: [{ s: true, ty: 'IO.File', m: null }],
    });
    const [, b64] = children[0].lines[0].split(' ');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('git 状态');
    parser.dispose();
  });

  it('同一个进程答多条', async () => {
    const { parser, children } = setup(answer(EMPTY));
    await parser.parse('a');
    await parser.parse('b');
    expect(children).toHaveLength(1);
    parser.dispose();
  });

  it('解析脚本出错（fatal）或输出不对：undefined', async () => {
    const a = setup(answer('{"fatal":1}'));
    expect(await a.parser.parse('x')).toBeUndefined();
    a.parser.dispose();
    const b = setup(answer('{"e":0,"cx":0,"s":"oops","c":[],"m":[]}'));
    expect(await b.parser.parse('x')).toBeUndefined();
    b.parser.dispose();
  });

  it('超时：undefined，杀掉进程，下一次起新的', async () => {
    let n = 0;
    const { parser, children } = setup((line, child) => { if (n++ > 0) answer(EMPTY)(line, child); });
    expect(await parser.parse('x')).toBeUndefined();
    expect(children[0].killed).toBe(true);
    expect(await parser.parse('y')).toBeDefined();
    expect(children).toHaveLength(2);
    parser.dispose();
  });

  it('进程在等结果时退出：undefined', async () => {
    const { parser } = setup((_l, child) => { child.exitCode = 1; child.emit('exit', 1, null); });
    expect(await parser.parse('x')).toBeUndefined();
    parser.dispose();
  });

  it('连续失败 3 次后不再尝试', async () => {
    const { parser, children } = setup(answer('{"fatal":1}'));
    for (let i = 0; i < 3; i++) expect(await parser.parse('x')).toBeUndefined();
    expect(parser.available).toBe(false);
    const before = children[0].lines.length;
    expect(await parser.parse('x')).toBeUndefined();
    expect(children[0].lines.length).toBe(before);
    parser.dispose();
  });

  it('太长的命令不送去解析', async () => {
    const { parser, children } = setup(answer(EMPTY));
    expect(await parser.parse('x'.repeat(PARSE_MAX_CHARS + 1))).toBeUndefined();
    expect(children).toHaveLength(0);
    expect(parser.available).toBe(true);
  });

  it('起进程就抛错：undefined，不抛', async () => {
    const parser = new PsParser({ exe: 'C:\\x\\powershell.exe', spawnImpl: (() => { throw new Error('ENOENT'); }) as unknown as typeof spawn });
    expect(await parser.parse('x')).toBeUndefined();
  });

  it('decodeSummary 拒绝形状不对的输入', () => {
    expect(decodeSummary(EMPTY)).toEqual({ errors: 0, complex: false, statements: [], commands: [], members: [] });
    expect(decodeSummary('not json')).toBeUndefined();
    expect(decodeSummary('{"e":0,"cx":0,"s":[[5,1]],"c":[],"m":[]}')).toBeUndefined();
    expect(decodeSummary('{"e":0,"cx":0,"s":[],"c":[{"n":"!!","o":"Unknown","sb":false,"a":[],"r":[]}],"m":[]}')).toBeUndefined();
    expect(decodeSummary('{"e":0,"cx":0,"s":[],"c":[],"m":[{"s":1,"ty":null,"m":null}]}')).toBeUndefined();
  });
});

// ---------- Windows：真的 powershell.exe ----------
describe.skipIf(!WIN)('真实 PowerShell 解析器', () => {
  const parser = new PsParser({ exe: powershellPath(process.env), env: childEnv(process.env) });
  const ws = WIN ? mkdtempSync(join(tmpdir(), 'dm-step1-ws-')) : '';
  afterAll(() => { parser.dispose(); if (ws) rmSync(ws, { recursive: true, force: true }); });
  const env = (): AnalyzeEnv => ({ workspace: ws, cwd: ws, platform: 'win32' });

  it('摘要的形状：语句位置、命令名、参数', async () => {
    const s = await parser.parse('git status; type "a b.txt" -Encoding:utf8 $x');
    expect(s).toBeDefined();
    expect(s!.errors).toBe(0);
    expect(s!.statements).toEqual([[0, 10], [12, 44]]);
    expect(s!.commands.map(c => c.n)).toEqual(['git', 'type']);
    expect(s!.commands[1].a).toEqual([{ t: 's', v: 'a b.txt' }, { t: 'p', n: 'Encoding', v: 'utf8' }, { t: 'x', v: '$x' }]);
  }, 30_000);

  it('语法错误、脚本块、静态调用', async () => {
    expect((await parser.parse('gci ('))!.errors).toBeGreaterThan(0);
    const s = await parser.parse('& { gci }; [IO.File]::Exists("a")');
    expect(s!.commands.map(c => [c.n, c.sb])).toEqual([[null, true], ['gci', false]]);
    expect(s!.members).toEqual([{ s: true, ty: 'IO.File', m: 'Exists' }]);
  }, 30_000);

  it.each([
    ['type a.txt', 'readonly'],
    ['type 中文目录\\说明.txt', 'readonly'],
    ['git status; git diff', 'readonly'],
    ['gci | Select-Object Name, Length', 'readonly'],
    ['rg -n TODO src', 'readonly'],
    ['type C:\\Windows\\win.ini', 'gated'],
    ['Get-ItemProperty HKLM:\\SOFTWARE', 'gated'],
    ['npm install', 'gated'],
    ['& { npm test }', 'gated'],
    ['& "Re`move-Item" x', 'danger'],
    ['(Get-Item a.txt).Delete()', 'danger'],
    ['& $x', 'opaque'],
    ["iex 'gci'", 'opaque'],
    ["[scriptblock]::Create('gci').Invoke()", 'opaque'],
    ['powershell -Command $c', 'opaque'],
  ])('%s → %s', async (command, expected) => {
    const s = await parser.parse(command);
    expect(s).toBeDefined();
    expect(analyzeShell(command, s, env()).cls).toBe(expected);
  }, 30_000);

  it('解析不执行命令', async () => {
    const marker = join(ws, 'should-not-exist.txt');
    const s = await parser.parse(`Set-Content -Path '${marker}' -Value x; New-Item -ItemType Directory '${marker}.d'`);
    expect(s).toBeDefined();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${marker}.d`)).toBe(false);
  }, 30_000);
});

describe.skipIf(!WIN)('常驻 shell 的当前目录', () => {
  // 展开成长路径：tmpdir 在 CI 上是 8.3 短名（RUNNER~1），PowerShell 报的位置跟着出生目录的写法走
  const root = WIN ? realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-step1-loc-'))) : '';
  const shells: PersistentShell[] = [];
  afterAll(async () => { for (const s of shells) await s.dispose(); if (root) rmSync(root, { recursive: true, force: true }); });

  it('还没起驱动是出生目录；cd 之后问得到新目录；只读命令之后沿用', async () => {
    const sub = join(root, 'sub');
    mkdirSync(sub);
    const s = new PersistentShell(sub);
    shells.push(s);
    expect(await s.location()).toBe(sub);
    await s.run('Get-Date');
    expect((await s.location())?.toLowerCase()).toBe(sub.toLowerCase());
    await s.run('cd ..');
    expect((await s.location())?.toLowerCase()).toBe(dirname(sub).toLowerCase());
    await s.run('Get-Date', 30_000, { keepsLocation: true });
    expect((await s.location())?.toLowerCase()).toBe(dirname(sub).toLowerCase());
  }, 60_000);

  it('cd 到注册表之类的非文件系统位置：说不清', async () => {
    const s = new PersistentShell(root);
    shells.push(s);
    await s.run('Set-Location HKCU:\\');
    expect(await s.location()).toBeUndefined();
  }, 60_000);
});
