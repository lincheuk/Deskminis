/** 执行隔离方案第 1 步：按 PowerShell 语法树判断 shell 命令。
 *
 *  文本规则（permissions.ts 的 classifyShellCommand）照旧先判；这里拿解析器的结果再看三件事：
 *  1. 危险：命令名经引号、反引号转义写出来的（& "Re`move-Item"）、参数拼回来之后命中危险规则的、.NET 删除调用（含实例上的 .Delete()）。
 *  2. 看不透（opaque）：命令名或代码要运行时才拼出来——& $x、Invoke-Expression、[scriptblock]::Create、动态方法名、
 *     powershell -Command $x 这类。危险规则认不出拼出来的东西，所以完全访问档下也询问。
 *  3. 只读免问收紧：每个参数都按路径解析，只有都落在工作区里、当前目录也在工作区里才免问；
 *     反过来，用 ; 或换行串起来的几条只读命令也认作只读（文本规则一律拒绝 ;）。
 *
 *  只判断「问不问」，不是边界：工作区里的符号链接 / 目录联接指向外面、脚本文件的内容、原生程序自己读什么，这里都看不到。
 *  真正的边界是方案后面的沙箱。 */
import { posix, win32 } from 'node:path';
import { asksEvenIfReadonly, classifyShellCommand, expandNestedShells, isReadonlyCommand, matchesDanger, type ShellAnalysis } from './permissions';
import type { PsArg, PsCommand, PsParser, PsSummary } from './ps-parse';

export const OPAQUE_NOTE = 'DeskMinis 看不出这条命令具体会执行什么（命令名或代码是运行时才拼出来的），完全访问档下也要你确认。';
export const OUTSIDE_NOTE = '这条命令只读，但会读取工作区以外的位置（或者要运行时才知道读哪里），所以要你确认。';

export interface AnalyzeEnv {
  /** 会话工作区。 */
  workspace: string;
  /** shell 此刻的当前目录；不知道时为 undefined（只读命令一律询问）。 */
  cwd: string | undefined;
  /** 路径按哪个平台的规则解析；缺省 process.platform。 */
  platform?: string;
}

/** 执行运行时代码的 cmdlet：参数里的字符串就是要执行的代码。 */
const EVAL_COMMANDS = new Set(['invoke-expression', 'iex', 'add-type']);
/** 拿到就能执行任意代码的方法：脚本块的调用、按字符串建脚本块、InvokeCommand 的几个入口。 */
const EVAL_MEMBERS = new Set(['invoke', 'invokereturnasis', 'invokewithcontext', 'begininvoke', 'invokescript', 'newscriptblock', 'expandstring']);
/** 再起一层 shell：参数里有变量之类的非常量，里层命令就是运行时拼的。 */
const SHELLS = new Set(['cmd', 'powershell', 'pwsh']);

/** 去掉目录与扩展名的命令名（小写）：C:\Windows\System32\cmd.exe → cmd。 */
function baseName(n: string): string {
  const last = n.split(/[\\/]/).pop() ?? n;
  return last.replace(/\.(exe|com|cmd|bat)$/i, '').toLowerCase();
}

function argText(a: PsArg): string {
  if (a.t === 'p') return `-${a.n}${a.v !== undefined ? ` ${a.v}` : a.x !== undefined ? ` ${a.x}` : ''}`;
  return a.v;
}

/** 一条命令按解析出来的值拼回文本（引号、转义已经去掉），交给危险规则与嵌套 shell 展开再判一次。 */
function commandText(c: PsCommand): string | undefined {
  if (c.n === null) return undefined;
  return [c.n, ...c.a.map(argText)].join(' ');
}

function isDangerAst(sum: PsSummary): boolean {
  for (const c of sum.commands) {
    const t = commandText(c);
    if (t === undefined) continue;
    const nested = expandNestedShells(t);
    if (nested.undecodable || nested.texts.some(matchesDanger)) return true;
  }
  for (const m of sum.members) {
    const name = m.m?.toLowerCase();
    if (name === undefined) continue;
    if (name === 'deletefile' || name === 'deletedirectory') return true;
    // [IO.File]::Delete / [System.IO.Directory]::Delete，以及 (Get-Item x).Delete() 这种 FileInfo / DirectoryInfo 上的删除
    if (name === 'delete' && (!m.s || /^(system\.)?io\.(file|directory)$/i.test(m.ty ?? ''))) return true;
  }
  return false;
}

function isOpaque(sum: PsSummary): boolean {
  for (const c of sum.commands) {
    // & { … } 的脚本块内容就在命令里，里面的命令另有记录；其余命令名为 null 的（& $x、& (…)、. $x）看不透
    if (c.n === null) { if (!c.sb) return true; continue; }
    const b = baseName(c.n);
    if (EVAL_COMMANDS.has(b)) return true;
    if (SHELLS.has(b) && c.a.some(a => a.t === 'x' || (a.t === 'p' && a.x !== undefined))) return true;
  }
  for (const m of sum.members) {
    if (m.m === null) return true; // $o.$name()、[T]::$name()
    if (m.s && m.ty === null) return true; // $t::M()：类型是运行时的值
    const name = m.m.toLowerCase();
    if (EVAL_MEMBERS.has(name)) return true;
    if (name === 'create' && /(^|\.)scriptblock$/i.test(m.ty ?? '')) return true;
  }
  return false;
}

/** 认 / 开关的原生程序：/s、/G:file 这类是开关不是路径（冒号后的值仍按路径看）。dir 在 PowerShell 里是 Get-ChildItem，不在此列。 */
const SLASH_SWITCH_COMMANDS = new Set(['findstr', 'tree', 'systeminfo', 'where', 'whoami', 'hostname']);
const SLASH_SWITCH_RE = /^\/([A-Za-z?]{1,7})(?::([\s\S]*))?$/;

/** 原生程序（参数原样交给它，PowerShell 的提供程序路径对它没有意义）。其余白名单命令是 cmdlet 或其别名。 */
const NATIVE_COMMANDS = new Set(['rg', 'findstr', 'tree', 'whoami', 'hostname', 'systeminfo', 'where', 'git', 'npm', 'node', 'python']);

/** cmdlet 上值不是路径的参数（按 PowerShell 的前缀规则认，至少两个字母）。认不出的参数一律当路径看——只会多问。 */
const NON_PATH_PARAMS = [
  'pattern', 'filter', 'include', 'exclude', 'encoding', 'property', 'expandproperty', 'first', 'last', 'skip', 'context',
  'delimiter', 'totalcount', 'tail', 'readcount', 'depth', 'attributes', 'name', 'id', 'format', 'uformat', 'culture',
  'displayname', 'module', 'verb', 'noun', 'commandtype', 'membertype', 'view', 'category', 'component', 'functionality', 'role',
];
/** 与 path / literalpath 共享前缀的写法不能当成非路径参数跳过：-P、-Pa 在 Get-Content 上就是 -Path。 */
const isPathLikeParam = (n: string): boolean => 'path'.startsWith(n) || 'literalpath'.startsWith(n) || n === 'lp' || n === 'pspath';
const isNonPathParam = (n: string): boolean => n.length >= 2 && !isPathLikeParam(n) && NON_PATH_PARAMS.some(p => p.startsWith(n));

type PathMod = typeof win32;

function insideDir(dir: string, target: string, P: PathMod): boolean {
  const rel = P.relative(P.resolve(dir), P.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel));
}

/** 只读命令的参数是否都落在工作区里。值不是路径的（模式串、名字）多半解析到当前目录下，也算在里面。 */
function argsInside(c: PsCommand, env: Required<AnalyzeEnv> & { cwd: string }, P: PathMod): boolean {
  if (c.n === null || c.r.length > 0) return false;
  const name = baseName(c.n);
  const native = NATIVE_COMMANDS.has(name);
  const slash = SLASH_SWITCH_COMMANDS.has(name);
  const inside = (v: string): boolean => {
    if (v === '') return true;
    // cmdlet 的提供程序路径（HKLM:\、Cert:\、Variable:x、FileSystem::…）与 ~（用户目录）都不在工作区里
    if (!native && (/^[A-Za-z][\w.-]+::?/.test(v) || v.startsWith('~'))) return false;
    return insideDir(env.workspace, P.resolve(env.cwd, v), P);
  };
  // select-string 的第一个位置参数是模式串（没有显式写 -Pattern 时）
  let skipFirstPositional = (name === 'select-string' || name === 'sls') && !c.a.some(a => a.t === 'p' && a.n.length >= 3 && 'pattern'.startsWith(a.n.toLowerCase()));
  for (const a of c.a) {
    if (a.t === 'x') return false;
    if (a.t === 'p') {
      if (a.x !== undefined) return false;
      if (a.v === undefined) continue;
      if (!native && isNonPathParam(a.n.toLowerCase())) continue;
      if (!inside(a.v)) return false;
      continue;
    }
    let v = a.v;
    if (skipFirstPositional) { skipFirstPositional = false; continue; }
    if (/^[-\u2013-\u2015]/.test(v)) {
      // --flag=值：值按路径看；单独的 --flag 不是路径
      const eq = v.indexOf('=');
      if (eq < 0) continue;
      v = v.slice(eq + 1);
    } else if (slash) {
      const m = SLASH_SWITCH_RE.exec(v);
      if (m) { if (m[2] === undefined) continue; v = m[2]; }
    }
    if (!inside(v)) return false;
  }
  return true;
}

/** ; 或换行串起来的每条语句都过只读判定、参数都在工作区里，才算只读。 */
function readonlyByAst(command: string, sum: PsSummary, env: AnalyzeEnv): boolean {
  if (sum.complex || sum.statements.length === 0 || sum.members.length > 0) return false;
  if (env.cwd === undefined) return false;
  const P = (env.platform ?? process.platform) === 'win32' ? win32 : posix as unknown as PathMod;
  // 当前目录已经不在工作区里（之前批准过 cd 到别处）：不带参数的 dir、git status 读的也是外面
  if (!insideDir(env.workspace, env.cwd, P)) return false;
  // 语句之间只能是空白和 ;（注释之类一律不认）
  let pos = 0;
  for (const [a, b] of sum.statements) {
    if (a < pos || b > command.length || !/^[\s;]*$/.test(command.slice(pos, a))) return false;
    const text = command.slice(a, b);
    if (!isReadonlyCommand(text) || asksEvenIfReadonly(text)) return false;
    pos = b;
  }
  if (!/^[\s;]*$/.test(command.slice(pos))) return false;
  const full = { workspace: env.workspace, cwd: env.cwd, platform: env.platform ?? process.platform };
  return sum.commands.length > 0 && sum.commands.every(c => argsInside(c, full, P));
}

/** 文本规则 + 语法树的判断。sum 为 undefined（解析器不可用、没给出结果）时就是文本规则的结果。 */
export function analyzeShell(command: string, sum: PsSummary | undefined, env: AnalyzeEnv): ShellAnalysis {
  const base = classifyShellCommand(command);
  if (base === 'danger') return { cls: 'danger' };
  // 有语法错误的命令驱动执行不了（[scriptblock]::Create 抛错，什么都不跑），按文本规则问就行
  if (sum === undefined || sum.errors > 0) return { cls: base };
  if (isDangerAst(sum)) return { cls: 'danger' };
  if (isOpaque(sum)) return { cls: 'opaque', note: OPAQUE_NOTE };
  if (readonlyByAst(command, sum, env)) return { cls: 'readonly' };
  // 文本规则认作只读、但参数伸到工作区外（或当前目录不明）：询问，并在卡上说明
  if (base === 'readonly') return { cls: 'gated', note: OUTSIDE_NOTE };
  return { cls: base };
}

/** 文本规则判为只读或可能只读（含 ; 的串联）时才需要当前目录；其余不去问 shell。 */
function mayBeReadonly(command: string): boolean {
  return /^[^&`(){}<>]*$/.test(command);
}

/** 网关钩子用：解析、按需取当前目录、判断。解析器给不出结果时返回 undefined（网关照旧按文本规则）。 */
export async function analyzeShellCommand(
  command: string,
  env: { workspace: string; cwd: () => Promise<string | undefined>; platform?: string },
  parser: Pick<PsParser, 'parse'>,
): Promise<ShellAnalysis | undefined> {
  if (classifyShellCommand(command) === 'danger') return undefined;
  const sum = await parser.parse(command);
  if (sum === undefined) return undefined;
  let cwd: string | undefined;
  if (sum.errors === 0 && mayBeReadonly(command)) {
    try { cwd = await env.cwd(); } catch { cwd = undefined; }
  }
  return analyzeShell(command, sum, { workspace: env.workspace, cwd, platform: env.platform });
}
