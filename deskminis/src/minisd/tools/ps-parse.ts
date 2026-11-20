/** 执行隔离方案第 1 步：用 PowerShell 自己的解析器看命令。
 *
 *  起一个常驻的 powershell.exe，只调 [Parser]::ParseInput 把命令解析成语法树、摘出判断要用的几样东西，从不执行命令本身。
 *  解析器给不出结果（没起来、超时、输出不对）时返回 undefined，调用方照旧用按文本的规则判断——只会退回第 0 步的水平，不会更松。
 *
 *  输出全是 ASCII：字符串一律按 UTF-16LE 转 base64，省得处理转义、编码和孤立代理项。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname } from 'node:path';

/** 命令里的一个参数。p = 带名字的参数（-Path x：v 是常量值，x 是非常量值的原文）；s = 常量字符串；x = 其它表达式（变量、子表达式……）的原文。 */
export type PsArg =
  | { t: 'p'; n: string; v?: string; x?: string }
  | { t: 's'; v: string }
  | { t: 'x'; v: string };

/** 一次命令调用。n = GetCommandName()，命令名要运行时才知道时为 null；o = 调用符（Unknown / Ampersand / Dot）；
 *  sb = 被调用的是一个就地写出的脚本块（& { … }），里面的命令另有记录；r = 文件重定向的目标原文。 */
export interface PsCommand { n: string | null; o: string; sb: boolean; a: PsArg[]; r: string[] }

/** 一次 .NET 方法调用。s = 静态调用（[T]::M()）；ty = 静态调用的类型名（不是 [类型] 字面量时为 null）；m = 方法名（动态方法名为 null）。 */
export interface PsMember { s: boolean; ty: string | null; m: string | null }

export interface PsSummary {
  /** 语法错误个数。大于 0 的命令驱动也执行不了（[scriptblock]::Create 会抛错）。 */
  errors: number;
  /** 有 param / begin / process 块、trap、using、#requires 之类：结构超出「一串语句」，不按只读放行。 */
  complex: boolean;
  /** 顶层语句的位置（UTF-16 下标，与 JS 字符串一致）。 */
  statements: Array<[number, number]>;
  commands: PsCommand[];
  members: PsMember[];
}

/** 解析脚本。在解析进程里运行，只读 stdin 一行一条「<id> <base64 UTF-8 命令>」，回一行「<id> <JSON>」。 */
export const PARSER_PS = String.raw`
$ErrorActionPreference = 'Stop'
function B($s) {
  if ($null -eq $s) { return 'null' }
  return '"' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$s)) + '"'
}
function ArgOf($e) {
  if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
    $a = $e.Argument
    $h = '{"t":"p","n":' + (B $e.ParameterName)
    if ($null -eq $a) { return $h + '}' }
    if ($a -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return $h + ',"v":' + (B $a.Value) + '}' }
    return $h + ',"x":' + (B $a.Extent.Text) + '}'
  }
  if ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return '{"t":"s","v":' + (B $e.Value) + '}' }
  if ($e -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    $parts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($x in $e.Elements) {
      if ($x -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { $parts = $null; break }
      $parts.Add('{"t":"s","v":' + (B $x.Value) + '}')
    }
    if ($null -ne $parts) { return ($parts -join ',') }
  }
  return '{"t":"x","v":' + (B $e.Extent.Text) + '}'
}
function Summary([string]$src) {
  $tk = $null
  $er = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tk, [ref]$er)
  $cx = 0
  if (($null -ne $ast.ParamBlock) -or ($null -ne $ast.BeginBlock) -or ($null -ne $ast.ProcessBlock) -or ($null -ne $ast.DynamicParamBlock)) { $cx = 1 }
  if ($null -ne $ast.ScriptRequirements) { $cx = 1 }
  if (($null -ne $ast.UsingStatements) -and ($ast.UsingStatements.Count -gt 0)) { $cx = 1 }
  $st = New-Object 'System.Collections.Generic.List[string]'
  if ($null -ne $ast.EndBlock) {
    if (($null -ne $ast.EndBlock.Traps) -and ($ast.EndBlock.Traps.Count -gt 0)) { $cx = 1 }
    foreach ($s in $ast.EndBlock.Statements) { $st.Add('[' + [string]$s.Extent.StartOffset + ',' + [string]$s.Extent.EndOffset + ']') }
  }
  $cmds = New-Object 'System.Collections.Generic.List[string]'
  foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    $as = New-Object 'System.Collections.Generic.List[string]'
    $els = $c.CommandElements
    for ($i = 1; $i -lt $els.Count; $i++) { $as.Add((ArgOf $els[$i])) }
    $rd = New-Object 'System.Collections.Generic.List[string]'
    foreach ($r in $c.Redirections) {
      if ($r -is [System.Management.Automation.Language.FileRedirectionAst]) { $rd.Add((B $r.Location.Extent.Text)) }
    }
    $sb = 'false'
    if ($els[0] -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { $sb = 'true' }
    $cmds.Add('{"n":' + (B $c.GetCommandName()) + ',"o":"' + [string]$c.InvocationOperator + '","sb":' + $sb + ',"a":[' + ($as -join ',') + '],"r":[' + ($rd -join ',') + ']}')
  }
  $mem = New-Object 'System.Collections.Generic.List[string]'
  foreach ($m in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) {
    $ty = $null
    if ($m.Static -and ($m.Expression -is [System.Management.Automation.Language.TypeExpressionAst])) { $ty = $m.Expression.TypeName.FullName }
    $mn = $null
    if ($m.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $mn = $m.Member.Value }
    $isStatic = 'false'
    if ($m.Static) { $isStatic = 'true' }
    $mem.Add('{"s":' + $isStatic + ',"ty":' + (B $ty) + ',"m":' + (B $mn) + '}')
  }
  return '{"e":' + [string]$er.Count + ',"cx":' + [string]$cx + ',"s":[' + ($st -join ',') + '],"c":[' + ($cmds -join ',') + '],"m":[' + ($mem -join ',') + ']}'
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $sp = $line.IndexOf(' ')
  if ($sp -lt 1) { continue }
  $id = $line.Substring(0, $sp)
  $out = '{"fatal":1}'
  try {
    $src = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring($sp + 1)))
    $out = [string](Summary $src)
  } catch { $out = '{"fatal":1}' }
  [Console]::Out.WriteLine($id + ' ' + $out)
  [Console]::Out.Flush()
}
`;

/** 太长的命令不解析（判断照旧走文本规则）：一行要经 stdin 传过去，解析结果也跟着变大。 */
export const PARSE_MAX_CHARS = 32_000;

const b64 = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return undefined;
  const bytes = Buffer.from(v, 'base64');
  return bytes.length % 2 === 0 ? bytes.toString('utf16le') : undefined;
};

class Bad extends Error {}
const str = (v: unknown): string => { const s = b64(v); if (typeof s !== 'string') throw new Bad(); return s; };
const strOrNull = (v: unknown): string | null => { const s = b64(v); if (s === undefined) throw new Bad(); return s; };
const arr = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new Bad(); return v; };
const obj = (v: unknown): Record<string, unknown> => { if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Bad(); return v as Record<string, unknown>; };

function argOf(v: unknown): PsArg {
  const o = obj(v);
  if (o.t === 'p') {
    const a: PsArg = { t: 'p', n: str(o.n) };
    if (o.v !== undefined) a.v = str(o.v);
    if (o.x !== undefined) a.x = str(o.x);
    return a;
  }
  if (o.t === 's') return { t: 's', v: str(o.v) };
  if (o.t === 'x') return { t: 'x', v: str(o.v) };
  throw new Bad();
}

/** 解析进程一行输出里的 JSON → PsSummary。形状不对返回 undefined（调用方回落文本规则）。 */
export function decodeSummary(json: string): PsSummary | undefined {
  try {
    const o = obj(JSON.parse(json));
    if (o.fatal !== undefined) return undefined;
    if (typeof o.e !== 'number' || typeof o.cx !== 'number') return undefined;
    const statements = arr(o.s).map(p => {
      const [a, b] = arr(p);
      if (typeof a !== 'number' || typeof b !== 'number' || a < 0 || b < a) throw new Bad();
      return [a, b] as [number, number];
    });
    const commands = arr(o.c).map((c): PsCommand => {
      const x = obj(c);
      if (typeof x.o !== 'string' || typeof x.sb !== 'boolean') throw new Bad();
      return { n: strOrNull(x.n), o: x.o, sb: x.sb, a: arr(x.a).map(argOf), r: arr(x.r).map(str) };
    });
    const members = arr(o.m).map((m): PsMember => {
      const x = obj(m);
      if (typeof x.s !== 'boolean') throw new Bad();
      return { s: x.s, ty: strOrNull(x.ty), m: strOrNull(x.m) };
    });
    return { errors: o.e, complex: o.cx !== 0, statements, commands, members };
  } catch {
    return undefined;
  }
}

export interface PsParserOptions {
  /** powershell.exe 的路径（生产用 System32 下的绝对路径，见 proc/win-exec.ts 的 powershellPath）。 */
  exe: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  /** 每次解析的时限；进程刚起时（还没答过一次）用 firstTimeoutMs。 */
  timeoutMs?: number;
  firstTimeoutMs?: number;
  /** 连续失败（超时、进程退出、输出不对）这么多次之后不再尝试，一直回落文本规则。 */
  maxFailures?: number;
}

type Pending = { resolve: (s: PsSummary | undefined) => void; timer: NodeJS.Timeout };

/** 常驻解析进程。parse 从不抛错、从不悬挂：拿不到结果就是 undefined。 */
export class PsParser {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private answered = false;
  private buf = '';
  private seq = 0;
  private failures = 0;
  private disposed = false;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: PsParserOptions) {}

  /** 还会不会尝试解析（连续失败到上限或已释放之后为 false）。 */
  get available(): boolean {
    return !this.disposed && this.failures < (this.opts.maxFailures ?? 3);
  }

  parse(command: string): Promise<PsSummary | undefined> {
    if (!this.available || command.length > PARSE_MAX_CHARS) return Promise.resolve(undefined);
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = this.ensure();
    } catch {
      this.fail();
      return Promise.resolve(undefined);
    }
    const id = String(++this.seq);
    const ms = this.answered ? (this.opts.timeoutMs ?? 3000) : (this.opts.firstTimeoutMs ?? 15000);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
        // 卡住了：杀掉重起，下一次请求用新进程
        this.fail();
        this.kill();
      }, ms);
      this.pending.set(id, { resolve, timer });
      try {
        proc.stdin.write(`${id} ${Buffer.from(command, 'utf8').toString('base64')}\n`);
      } catch {
        this.settle(id, undefined);
        this.fail();
        this.kill();
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const encoded = Buffer.from(PARSER_PS, 'utf16le').toString('base64');
    const proc = (this.opts.spawnImpl ?? spawn)(this.opts.exe, ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      cwd: dirname(this.opts.exe), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.opts.env,
    });
    this.proc = proc;
    this.answered = false;
    this.buf = '';
    const gone = (): void => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      if (this.pending.size > 0) this.fail();
      for (const id of [...this.pending.keys()]) this.settle(id, undefined);
    };
    proc.on('error', gone);
    proc.on('exit', gone);
    proc.stdin.on('error', () => { /* 进程已退出时写入的 EPIPE：exit/error 那边收口 */ });
    proc.stderr.resume();
    proc.stdout.setEncoding('ascii');
    proc.stdout.on('data', (chunk: string) => {
      if (this.proc !== proc) return;
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).replace(/\r$/, '');
        this.buf = this.buf.slice(nl + 1);
        const sp = line.indexOf(' ');
        if (sp < 1) continue;
        const id = line.slice(0, sp);
        if (!this.pending.has(id)) continue;
        const s = decodeSummary(line.slice(sp + 1));
        this.answered = true;
        if (s) this.failures = 0; else this.fail();
        this.settle(id, s);
      }
      // 一行不会无限长：解析结果超过这个长度说明出了问题
      if (this.buf.length > 4 * 1024 * 1024) { this.fail(); this.kill(); }
    });
    // 解析进程不该拖住 minisd 退出：等着结果的请求自有定时器
    proc.unref();
    for (const s of [proc.stdin, proc.stdout, proc.stderr] as Array<{ unref?: () => void }>) s.unref?.();
    return proc;
  }

  private settle(id: string, s: PsSummary | undefined): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(s);
  }

  private fail(): void {
    this.failures++;
    if (this.failures === (this.opts.maxFailures ?? 3)) console.warn('PowerShell 解析进程连续失败，命令判断回落到按文本的规则');
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = undefined;
    for (const id of [...this.pending.keys()]) this.settle(id, undefined);
    if (proc) { try { proc.kill(); } catch { /* 已经退出 */ } }
  }
}
