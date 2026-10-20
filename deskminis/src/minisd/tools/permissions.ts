import type { BridgePermissionKind, PermissionAskOptions, PermissionDecision, PermissionGateway, PermissionRequest } from './types';
import {
  allowed, cancelCauseOf, denied, PERMISSION_DENY_CAUSES,
  type PermissionAllowed, type PermissionDenied, type PermissionDenyCause, type PermissionOutcome, type UserDecision,
} from '../../shared/permission';

/** 危险层保留：这些命令即使用户想批准也硬拦截（不可逆/系统级/影子命名原语）。 */
export type CommandClass = 'danger' | 'readonly' | 'gated';
export type PermissionLevel = 'bypass' | 'askOnce' | 'notAllowed';

/** F13：网关放弃这次询问的原因，作为 PromptControl.signal 的 abort reason。 */
export class PromptAbort {
  constructor(readonly reason: 'timeout' | 'cancelled', readonly cause?: PermissionDenyCause) {}
}

/** F13：网关交给询问函数的控制参数。旧式询问函数（只收 req）可以不理会它——网关自己照样有时限、照样认取消。 */
export interface PromptControl {
  /** abort = 网关不再等：兜底时限到（PromptAbort('timeout','unanswered')）或询问方取消（PromptAbort('cancelled', cause)）。
   *  询问函数必须当场把这次询问了结，之后的答复一律无效。 */
  signal: AbortSignal;
  toolUseId?: string;
  origin: 'tool' | 'bridge';
  /** 询问函数建好卡之后同步回报 requestId。 */
  issued?(requestId: string): void;
}

/** F13：询问函数的结构化答复。 */
export type PromptAnswer =
  | { answer: 'allow-once' | 'allow-session'; requestId?: string }
  | { answer: 'deny'; reason: 'user-denied' | 'timeout' | 'cancelled' | 'invalidated'; cause?: PermissionDenyCause; requestId?: string; waitedMs?: number };

/** 返回裸的 UserDecision = 用户亲自作答（'deny' 即用户拒绝）；超时、取消、失效必须用结构化的 PromptAnswer。 */
export type PermissionPrompt = (req: PermissionRequest, ctl: PromptControl) => Promise<PromptAnswer | UserDecision>;

/** F13：同一会话本轮连续这么多次权限卡无人答复之后，不再弹新卡。同时挂着的几张卡一起超时算一次。
 *  超时后模型重发就再弹一张、再等 90 秒，没有上限的话一轮无人值守能弹到回合上限。它只会多拒，不会多放。 */
export const MAX_UNANSWERED_STREAK = 2;
/** 权限选择器四档预设：ask/session 差异只在前端预选；plan 只读；full 放行除 danger 外全部。 */
export type PermissionPreset = 'ask' | 'session' | 'plan' | 'full';

/** 危险：不可逆或系统级操作，顺序无关。 */
const DANGER_ANYWHERE = [
  /\b(remove-item|remove-itemproperty|clear-content|clear-item)\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i,
  /\b(shutdown|restart-computer|stop-computer|logoff)\b/i,
  /\b(diskpart|bcdedit|takeown)\b/i,
  /\bcipher\b[\s\S]*\/w/i,
  /\bicacls\b[\s\S]*\/(grant|deny|setowner)/i,
  /\bsc(\.exe)?\s+(stop|delete|config|create)\b/i,
  /\b(stop-service|remove-service|new-service|set-service)\b/i,
  /\bset-executionpolicy\b/i,
  /\b(stop-process|taskkill)\b/i,
  // 名字绑定原语：影子命名（把无害名字重绑为任意行为）。含常见别名 nal/sal。
  /(^|[;|&(]\s*)(function|filter|workflow)\s/i,
  /\b(set-alias|new-alias|nal|sal)\b/i,
  /\b(set-item|new-item)\b[\s\S]*\b(alias|function):/i,
  /\bset-content\b\s+function:/i,
  /\$(function|alias):/i,
];

/** 短别名歧义大（"del old code" 散文会误伤），仅在命令位匹配。 */
const DANGER_AT_COMMAND_POSITION = [
  /(^|[;|&(]\s*)(rm|ri|del|erase|rd|rmdir)\b/i,
];

/** 只读免批白名单（保守子集）：首 token 小写精确命中才可能免批。
 *  Measure-Object / Where-Object 刻意不收：二者脱离管道没有独立语义（管道右侧形态由
 *  READONLY_PIPE_FILTERS 承接，measure-object 在彼列），收进「源」白名单只扩大免批面、
 *  不带来任何收益；裸 where（Where-Object 的别名）同理不收，只收 where.exe。 */
const READONLY_ALLOWLIST = new Set([
  'get-childitem', 'gci', 'ls', 'dir',
  'get-content', 'gc', 'cat', 'type',
  'get-item', 'get-itemproperty', 'get-location', 'pwd',
  'get-process', 'gps', 'ps',
  'get-service', 'get-date', 'get-host',
  'get-command', 'gcm', 'get-member', 'gm', 'get-help', 'help',
  'select-string', 'sls', 'test-path', 'resolve-path',
  'rg', 'findstr', 'tree', 'whoami', 'hostname', 'systeminfo', 'where.exe',
  // 这四个是多段命令：首 token 命中后还要过第二 token 规则表
  'git', 'npm', 'node', 'python',
]);

/** 二段式规则表：git/npm/node/python 的子命令/旗标约束，数据化便于后续扩展。
 *  sub 形态：第二个 token 精确命中即放行（third 可选：还要求第三个 token 精确等于，如 git config --get；
 *  restFlagsOnly 可选：其后所有 token 必须取自旗标集——branch/remote 这类「列表读 / 建删写」同名双形态
 *  的子命令，放行列表态、把一切带非旗标参数的写形态挡回 gated）；
 *  flagsOnly 形态：其后所有 token 只能取自旗标集——node/python 若只查第二 token，
 *  "node --version -e 代码" 这类混入执行旗标的形态就会漏进免批。 */
type SecondTokenRule = { sub: string; third?: string; restFlagsOnly?: string[] } | { flagsOnly: string[] };
const READONLY_SECOND_TOKEN_RULES: Record<string, SecondTokenRule[]> = {
  git: [
    { sub: 'status' }, { sub: 'log' }, { sub: 'diff' }, { sub: 'show' },
    // branch/remote 是同名双形态命令：裸/带列表旗标是读（高频，免批），带任何非旗标参数是写
    // （git branch xxx 建分支、-D 删分支、git remote add 写 .git/config）——写形态回落 gated
    { sub: 'branch', restFlagsOnly: ['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '--show-current'] },
    { sub: 'remote', restFlagsOnly: ['-v', '--verbose'] },
    { sub: 'ls-files' }, { sub: 'blame' },
    { sub: 'config', third: '--get' }, // 不带 --get 的 git config 是写形态（可改仓库配置），回落 gated
  ],
  npm: [
    // view / outdated 不收（W1b-2g）：两者都要连 npm 源，view 还接受任意网址（npm view <url>）——
    // 免询问白名单只收只读本地的命令；ls 读本地 node_modules、config get 读本地配置，留着
    // （npm 自己的更新检查 update-notifier 默认最多一周连一次 npm 源，只查 npm 版本、不带命令参数，不算这里要管的访问）
    { sub: 'ls' },
    { sub: 'config', third: 'get' }, // npm config set 写配置，只放行 get 形态
  ],
  node: [{ flagsOnly: ['--version', '-v'] }], // -e/--eval 执行任意代码，绝不放行
  python: [{ flagsOnly: ['--version', '-v'] }], // -c/-m 执行代码，同理排除
};

/** 管道右侧允许的纯过滤 cmdlet 白名单（B4 受限管道）。入选标准：只能是「读入→变换→输出」
 *  的纯过滤器——无一能写盘/执行代码/发网络；将来扩名单必须逐个照此审（out-file/tee-object
 *  会写盘、foreach-object/where-object 靠 {} 脚本块变换、cmd/git 可执行任意动作，均不收）。 */
const READONLY_PIPE_FILTERS = new Set([
  'select-object', 'select-string', 'sls', 'sort-object', 'measure-object',
  'format-table', 'ft', 'format-list', 'fl', 'out-string', 'findstr', 'rg',
]);

/** 结构过滤拒绝的字符：覆盖复合/子表达式/重定向/脚本块/splatting/换行，对每个管道段独立生效。
 *  | 不在此列——顶层管道分隔改由 isReadonlyCommand 分段处理（引号内的 | 是字面量，不能当
 *  分隔符误切），分段后各段套用本表，段内再出现 ; > { } 等仍一律拒绝；
 *  裸括号也一并拒：(...) 是表达式求值，(Set-Content …) 会在参数位静默执行写操作；
 *  $(/@( 与 ${ 无非是括号/花括号族成员，按单字符拒绝即全覆盖。 */
const READONLY_FORBIDDEN_CHARS = [';', '&', '`', '(', ')', '<', '>', '{', '}', '\n', '\r'];

/** 执行型旗标：旗标值是外部程序路径，命中即等于任意代码执行——与 --output 后门同级拒绝。
 *  ripgrep 的 --pre <程序> 会对每个待搜文件调用该程序（rg --pre cmd x 即任意执行），
 *  --pre-glob 是它的配套过滤器，--hostname-bin 同样把外部程序的输出当主机名。
 *  刻意用精确匹配而非 --pre 前缀：git log --pretty=… 与 rg --pretty 都是高频只读用法，
 *  前缀匹配会把它们一并误伤回 gated——免批面该收窄，但不该收窄到常用只读命令头上。 */
const EXEC_FLAG_RE = /^--(pre|pre-glob|hostname-bin)(=|$)/i;

/** PowerShell 认作引号的字符（含弯引号 ‘ ’ ‚ ‛ “ ” „）。它把引号和紧挨着的字拼成一个参数、去掉引号再交给原生程序：
 *  "--pre=x"、--p"re"=x 到 rg 手里都是 --pre=x。 */
const QUOTE_CHARS_RE = /["'\u2018-\u201e]/g;

/** 只读判定里一个 token 该不该让整条命令回落询问（W3-sec1，安全审计第 1 条）：
 *  --output 前缀与执行型旗标按去掉引号后的样子认（以前只认原文，引号开头的写法漏掉，rg "--pre=…" 被静默执行）；
 *  另外，带引号、去掉引号后以 - 开头的 token 一律回落——引号包住的旗标没有正当的只读用途，认不全的写法宁可多问一次。 */
function flagTokenUnsafe(token: string): boolean {
  const raw = token.toLowerCase();
  const bare = raw.replace(QUOTE_CHARS_RE, '');
  if (bare.startsWith('--output') || EXEC_FLAG_RE.test(bare)) return true;
  return bare !== raw && bare.startsWith('-');
}

/** PowerShell 参数 token 的名字（小写）：-Name、-Name:值 都取 Name；长短横线 – — ― PowerShell 也认作参数前缀。不是参数返回 undefined。 */
function paramName(token: string): string | undefined {
  const m = /^[-\u2013-\u2015]([a-z]+)(?::|$)/i.exec(token);
  return m ? m[1].toLowerCase() : undefined;
}

/** PowerShell 参数名可以写成任意无歧义前缀（-C、-Comp、-ComputerName 是同一个参数），按前缀认。 */
const namesParam = (full: string, alias?: string) => (token: string): boolean => {
  const n = paramName(token);
  return n !== undefined && (full.startsWith(n) || n === alias);
};

/** 带上就伸到本机之外的参数（W1b-2g 补，与远程共享路径同类）：命令本身在只读白名单里，这些参数让它去问别的机器或开浏览器。
 *  Windows PowerShell 5.1 的 Get-Process / Get-Service 带 -ComputerName（别名 -Cn）查的是另一台机器——这两个 cmdlet
 *  以 c 起头的参数只有 ComputerName，前缀一律算它；systeminfo /S <主机> 查远程计算机；
 *  Get-Help -Online 打开浏览器访问帮助网址（前缀 -o 有歧义时 PowerShell 报错不执行，一并算上只是多问一次）。 */
const COMPUTER_NAME = namesParam('computername', 'cn');
const ONLINE = namesParam('online');
const REACH_OUT_PARAMS: Record<string, (token: string) => boolean> = {
  'get-process': COMPUTER_NAME, gps: COMPUTER_NAME, ps: COMPUTER_NAME, 'get-service': COMPUTER_NAME,
  systeminfo: (t) => /^[/-]s(?::|$)/i.test(t),
  'get-help': ONLINE, help: ONLINE,
};

/** 引号必须配对，且引号内不得出现 $ 与反引号（防字符串内展开）。
 *  PS 单引号串本是字面量（$ 不展开），这里仍一并拒绝：少依赖一层语言语义，判定只看字符结构。 */
function readonlyQuotesSafe(c: string): boolean {
  let quote: '"' | "'" | undefined;
  for (const ch of c) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else if (ch === '$' || ch === '`') return false;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    }
  }
  return quote === undefined; // 扫描结束仍在引号内 = 未配对，结构不明不收
}

/** 引号感知切分顶层管道：单双引号内的 | 是字面量（正则模式里极常见），不算分隔。
 *  调用前 readonlyQuotesSafe 已保证引号配对，扫描不会以「悬空引号内」状态收尾。 */
function splitTopLevelPipes(c: string): string[] {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  for (const ch of c) {
    if (quote !== undefined) {
      cur += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      cur += ch;
      quote = ch;
    } else if (ch === '|') {
      segments.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  segments.push(cur);
  return segments;
}

/** 单段命令的只读判定（B4 从导出函数抽出，既有语义完整承接）。与旧版唯一差异：不再拒绝 | ——
 *  顶层管道分隔由 isReadonlyCommand 分段处理，引号内的 | 在段内是字面量。 */
function isReadonlySingle(segment: string): boolean {
  const c = segment.trim();
  if (c === '') return false;
  if (READONLY_FORBIDDEN_CHARS.some(ch => c.includes(ch))) return false;
  if (!readonlyQuotesSafe(c)) return false;
  const tokens = c.split(/\s+/);
  // --output 是 git 家族把只读查询结果写进文件的后门（diff/show/log 通用旗标），白名单内没有命令合法使用该前缀；
  // 执行型旗标：白名单里的 rg 本身只读，但 --pre 之类会把它变成任意程序启动器。两样都按去引号后的样子认（flagTokenUnsafe）
  if (tokens.some(flagTokenUnsafe)) return false;
  // 结构过滤已拒绝一切 &，这里再剥一次调用符前缀是防御性兜底：两道闸少一道也不至于漏
  const head = tokens[0].replace(/^&/, '').toLowerCase();
  if (!READONLY_ALLOWLIST.has(head)) return false;
  // 命令只读，参数却让它去问别的机器或开浏览器（W1b-2g）：不算只读本地，回落 gated
  const reachOut = REACH_OUT_PARAMS[head];
  if (reachOut !== undefined && tokens.slice(1).some(reachOut)) return false;
  const rules = READONLY_SECOND_TOKEN_RULES[head];
  if (rules === undefined) return true; // 白名单直收命令（dir/rg/…），参数不再限制
  const rest = tokens.slice(1).map(t => t.toLowerCase());
  if (rest.length === 0) return false; // 裸 git/npm/node 是交互态或无只读语义，回落 gated
  for (const rule of rules) {
    if ('flagsOnly' in rule) {
      if (rest.every(t => rule.flagsOnly.includes(t))) return true;
    } else if (rest[0] === rule.sub) {
      // restFlagsOnly：子命令后只许旗标集内成员（含空）——branch foo / -D foo / remote add 全被挡回 gated
      if (rule.restFlagsOnly !== undefined) {
        if (rest.slice(1).every(t => rule.restFlagsOnly!.includes(t))) return true;
      } else if (rule.third === undefined || rest[1] === rule.third) return true;
    }
  }
  return false;
}

/** 管道右侧单段判定：首 token 必须命中纯过滤白名单；禁字符/引号内容/--output 对每段独立生效——
 *  { } 仍全局禁 → 脚本块过滤（ForEach-Object/Where-Object）天然不可能通过；
 *  > 仍禁 → 管道尾重定向不可能；段内 ; 等复合结构同样穿透不了管道。 */
function isPureFilterSegment(segment: string): boolean {
  if (READONLY_FORBIDDEN_CHARS.some(ch => segment.includes(ch))) return false;
  if (!readonlyQuotesSafe(segment)) return false;
  const tokens = segment.split(/\s+/);
  // 管道右侧同样有 rg/sls：这一侧必须用同一道闸，否则 gci | rg --pre cmd 就绕过去了
  if (tokens.some(flagTokenUnsafe)) return false;
  // 结构过滤已拒绝一切 &，剥调用符前缀与段 1 同理是防御性兜底
  const head = tokens[0].replace(/^&/, '').toLowerCase();
  return READONLY_PIPE_FILTERS.has(head);
}

/** 只读免批判定（B4 受限管道）：全部条件满足才 true，任何一处存疑一律 false 回落 gated。
 *  免批判定被绕过等于静默放行，所以宁可漏放（该问的多问一次）、不可错放（不该放的被静默执行）。
 *  管道规则：段 1 走 isReadonlySingle 既有判定（含二段规则）；段 2..n 首 token 必须是纯过滤
 *  白名单成员；段数上限 3——保守上限，真实只读组合两级过滤足够，更长的链宁可多问一次。 */
export function isReadonlyCommand(command: string): boolean {
  const c = command.trim();
  if (c === '') return false;
  // 分段之前必须先证明引号配对：否则 "a|b" 里的竖线会被误当分隔符，把前半段切出悬空引号、
  // 后半段切进下一段的参数位——不配对直接整体回落 gated
  if (!readonlyQuotesSafe(c)) return false;
  const segments = splitTopLevelPipes(c).map(s => s.trim());
  if (segments.length === 1) return isReadonlySingle(segments[0]);
  if (segments.length > 3) return false;
  if (!isReadonlySingle(segments[0])) return false;
  for (const seg of segments.slice(1)) {
    if (seg === '') return false; // 尾随/连续管道（gci | 或 a || b）留下空段，结构不明
    if (!isPureFilterSegment(seg)) return false;
  }
  return true;
}

/** 只读命令点到数据根的迹象（W1b-2，止血设计稿 §2「shell 只读白名单读数据根」）。
 *  文件工具已把「读 minis.db / servers.json / 连接凭据」收成走卡，只读白名单却能一句
 *  Get-Content $env:APPDATA\DeskMinis\minis.db 静默读走——命中这些字样的只读命令回落为 gated，弹卡问一次。
 *  不采纳侦察原推荐的「含未加引号的 $ 就回落」：PowerShell 的 $_、$PWD 这类变量太常见，会让大量只读命令弹卡。
 *  W4：默认工作区就在数据根里，上级目录路径可能从工作区读到会话库等核心数据；
 *  因此上级目录、用户目录、短名与目录通配也回落询问（仍按命令写法判断）。 */
const DATA_ROOT_HINT_RE = /deskminis|\$env:|%appdata%|%localappdata%/i;

/** 远程共享路径（W1b-2g，止血设计稿 §4.1）：UNC 与类 UNC 路径会连到别的机器（SMB / WebDAV），只读命令点到它就不是「只读本地」。
 *  认「两个分隔符打头、后面跟着主机名」的路径记号：\\host\share、//host/share（混写的 \/、/\ 在 Windows 上同样是 UNC）、
 *  \\?\UNC\host、\\.\ 设备路径、\\host@SSL\DavWWWRoot（WebDAV）；另收 NT 前缀 \??\（\??\UNC\host 经原生程序直通到远程共享）。
 *  「打头」看记号前面紧挨着什么（REMOTE_PATH_START）：行首、空白、引号（含 PowerShell 也认的弯引号 ‘ ’ ‚ ‛ “ ” „）、=、逗号；
 *  或者是 REMOTE_PATH_PREFIXES 里的几种参数写法。
 *  不算：URL 的 scheme://（冒号前是 scheme 字母，rg "https://example.com" 是在本地文件里搜这串字）、盘符后的 C:\\（本地路径）、
 *  路径中段的 a\\b；两个分隔符后面紧跟空白、引号或到头的也不算——那里没有主机名，rg "// TODO" 照旧免询问。
 *  宁可多问：引号里以 \\ 起头的正则（rg "\\d+"）也会回落询问。 */
const REMOTE_PATH_START = String.raw`(?:^|[\s"'=,\u2018-\u201e])`;
const REMOTE_PATH_PREFIXES = [
  String.raw`[-/\u2013-\u2015][^\s"'=,:\u2018-\u201e]*:`, // 参数值冒号绑定：-Path:\\host（PowerShell）、/G:\\host（findstr）
  String.raw`-[a-z]+`,                                    // 短旗标紧贴值：-f\\host（rg -f 从这个文件读模式）
  String.raw`\$[^\s"'=,\\/\u2018-\u201e]*`,               // 变量前缀：$x\\host（$x 没定义时展开为空，剩下 \\host）
  String.raw`[^\s"'=,\u2018-\u201e]*::`,                  // 提供程序限定：FileSystem::\\host、Microsoft.PowerShell.Core\FileSystem::\\host
];
const REMOTE_PATH_HEAD = String.raw`(?:[\\/]{2}(?=[^\s"'\u2018-\u201e])|[\\/]\?\?[\\/])`;
const REMOTE_PATH_RE = new RegExp(`${REMOTE_PATH_START}(?:${REMOTE_PATH_PREFIXES.join('|')})?${REMOTE_PATH_HEAD}`, 'i');

/** 环境变量提供程序（W1b-2g）：不带 $ 的 env: 驱动器路径（Get-ChildItem env:、gci Env:\、Get-Content env:PATH）与提供程序限定的
 *  Environment::PATH，会把环境变量（可能含各类 API key）整个读进工具结果，与 $env: 同理回落。
 *  \b 让 myenv: 这类词中间的字样不算；rg "env:" 这样搜字面的也会回落询问，宁可多问一次。 */
const ENV_PROVIDER_RE = /\benv:|\benvironment::/i;

/** 只读判定命中之后仍要回落询问的字样：点到数据根（W1b-2），远程共享路径与 env: 提供程序（W1b-2g）。 */
// 段边界避免把 main..feature 当路径；~数字只有后接路径分隔符或点才像 8.3 短名。
const PARENT_PATH_RE = /(?:^|[\s"'=:,\\/\u2018-\u201e])\.\.(?=[\\/]|[\s"',\u2018-\u201e]|$)/;
const USER_PATH_RE = /\$HOME\b|(?:^|[\s"'=:,\u2018-\u201e])~[\\/]|%USERPROFILE%|AppData/i;
const SHORT_PATH_RE = /~\d+(?=[\\/.])/;
// 只收目录段：通配符与后续分隔符必须在同一个参数里，末段 *.ts 不受影响。
const WILDCARD_DIR_RE = /[*?][^\\/]*[\\/]/;
const ASK_EVEN_IF_READONLY = [DATA_ROOT_HINT_RE, REMOTE_PATH_RE, ENV_PROVIDER_RE, PARENT_PATH_RE, USER_PATH_RE, SHORT_PATH_RE];

/** 原文与「去掉引号」的文本各判一次：PowerShell 把引号和紧挨着的字拼成一个参数（Desk''Minis → DeskMinis、e''nv: → env:、
 *  \''\host → \\host），只看原文会被引号拆开的字样骗过；原文那一遍保留「引号后面紧跟 \\host 也算打头」。 */
function asksEvenIfReadonly(c: string): boolean {
  const joined = c.replace(QUOTE_CHARS_RE, '');
  // 按带引号的参数取路径，目录名里的空格不会漏掉，也不会跨到下一参数的分隔符。
  const tokens = c.replace(/[\u2018-\u201b]/g, "'").replace(/[\u201c-\u201e]/g, '"')
    .match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.some(t => WILDCARD_DIR_RE.test(t.replace(QUOTE_CHARS_RE, '')))
    || ASK_EVEN_IF_READONLY.some(re => re.test(c) || re.test(joined));
}

export function classifyShellCommand(command: string): CommandClass {
  const c = command.trim();
  // 危险层两个表原样先行：readonly 判定绝不允许越过 danger（Remove-Item 开头必是 danger）
  if (DANGER_ANYWHERE.some(r => r.test(c))) return 'danger';
  if (DANGER_AT_COMMAND_POSITION.some(r => r.test(c))) return 'danger';
  if (isReadonlyCommand(c)) return asksEvenIfReadonly(c) ? 'gated' : 'readonly';
  return 'gated';
}

/** 权限判定类目：shell 命令分级 + 文件读写两类 + web 抓取/搜索两类 + MCP 一类 + windows-* 桥七类（其余 kind 即类目，绝不经 shell 分类器）。 */
export type PermissionClass = CommandClass | 'file-write' | 'file-read' | 'web-fetch' | 'web-search' | 'mcp' | BridgePermissionKind;

const DEFAULT_LEVELS: Record<PermissionClass, PermissionLevel> = {
  danger: 'notAllowed',
  // 只读免批：保守子集判定通过即静默放行——查目录/看 git status 这类高频只读不再打断用户
  readonly: 'bypass',
  gated: 'askOnce', 'file-write': 'askOnce', 'file-read': 'askOnce',
  // web 抓取默认过卡：URL 的查询串/路径可携带会话内外传数据，是现成的静默外泄通道
  'web-fetch': 'askOnce',
  // web 搜索同理：查询串本身就是数据外传通道（论证同 web-fetch），默认过卡
  'web-search': 'askOnce',
  // MCP 工具语义未知——同一台 server 上的工具可读可写可外呼，无法按调用内容分级；
  // 用户添加 server 时已过「装什么」一关，运行期只需把关「本会话可不可以用这台」，
  // 故类目粒度 = server 名（detail），默认每次询问（askOnce）。
  'mcp': 'askOnce',
  // 桥（设计 §4.5 + M2e 计划"架构决策 3"）：device 只读系统信息放行；剪贴板读/截图隐私敏感确认；
  // 剪贴板写覆盖用户既有内容确认；notify/open/speak 可被打扰性滥用确认。
  'bridge-device': 'bypass',
  'bridge-notify': 'askOnce',
  'bridge-clipboard-read': 'askOnce',
  'bridge-clipboard-write': 'askOnce',
  'bridge-open': 'askOnce',
  'bridge-speak': 'askOnce',
  'bridge-screenshot': 'askOnce',
};

/** 桥一次性合并授权的 TTL（决策 4c 评审命门 2）：超时未消费的授权懒清理，防探测假阳性留悬挂授权。 */
const BRIDGE_ONCE_TTL_MS = 120_000;

/** 会话授权的键：同一条命令 / 路径 / 能力串原样重复才命中。记授权（decide）与收回授权（revokeGrant）用同一个。 */
const grantKeyOf = (req: PermissionRequest): string => `${req.sessionId}\u0000${req.kind}\u0000${req.detail}`;

export class PermissionGatewayImpl implements PermissionGateway {
  private levels: Record<PermissionClass, PermissionLevel>;
  private preset: PermissionPreset = 'ask';

  isPlanMode(): boolean { return this.preset === 'plan'; }
  /** 会话批准：按 (sessionId, kind, 精确命令/路径/能力串) 记忆——同一条命令原样重复才静默。 */
  private sessionGrants = new Set<string>();
  /** 桥会话合并授权（决策 4c）：按 (sessionId, 桥 kind) 记忆——shell 卡批准一次，该桥本会话不再弹卡。 */
  private sessionBridgeGrants = new Set<string>();
  /** 桥一次性合并授权：计数 + 最后授予时刻（120s TTL，check 时懒清理）。 */
  private bridgeOnce = new Map<string, { count: number; grantedAt: number }>();
  /** F13：每个会话「连续无人答复」的段数。streak 记到 MAX_UNANSWERED_STREAK 之后，受上限管的新询问不再弹卡
   *  （工具发起的，以及该会话有 run 在跑时到达的桥询问——见 decide 里的 capped）。
   *  记一段的两种情形：卡片挂满时限没人答；桥卡没等到答复、请求方就断开了（见 decide 里的 requesterLeft）。
   *  coveredSeq = 上一次记数那一刻已经发出的最大询问序号：在那之前发出的询问再无人答复，属于同一段，不重复记。
   *  计数为 0 的会话不占条目。只影响「问不问」，从不放行。 */
  private unanswered = new Map<string, { streak: number; coveredSeq: number }>();
  /** F13：网关内单调递增的询问序号（所有会话、所有 origin 共用）。用序号不用时钟：可注入的 now 在测试里可能不走，
   *  紧挨着的两次询问也可能落在同一毫秒。 */
  private askSeq = 0;

  constructor(
    private prompt: PermissionPrompt,
    levels?: Partial<Record<PermissionClass, PermissionLevel>>,
    private askTimeoutMs = 90000,
    private now: () => number = Date.now, // 可注入时钟（TTL 测试用）；生产默认 Date.now
    /** F13 宿主钩子。
     *  - onDenied：不弹卡的拒绝、批准之后没执行的操作，交给宿主记审计。
     *  - runActive：该会话此刻有没有 agent 的 run 在跑。给了它，run 在跑期间到达的桥询问与工具询问一样计入
     *    「连续无人答复」、到上限后不再弹卡；没给或返回 false 时桥询问不计数、不受限（见 decide 里的 capped）。
     *  - onRevoked（F05）：一张卡的放行被收回（revokeGrant）。会话授权网关自己撤；这张卡批准时宿主另发的授权
     *    （shell 卡带出的桥合并授权）由宿主在这里撤。 */
    private hooks?: {
      onDenied?(req: PermissionRequest, d: PermissionDenied, opts?: Pick<PermissionAskOptions, 'toolUseId' | 'origin'>): void;
      runActive?(sessionId: string): boolean;
      onRevoked?(req: PermissionRequest, a: PermissionAllowed): void;
    },
  ) {
    this.levels = { ...DEFAULT_LEVELS, ...levels };
  }

  /** 应用权限预设档位。'ask'/'session' 都把 levels 恢复为 DEFAULT_LEVELS——
   *  这两档的差异只在前端预选高亮，网关行为本就相同；'full' 把 danger 以外全部放行。
   *  只改预设与 levels，不动 sessionGrants/bridgeOnce：切档不清掉既有的会话级/一次性授权，
   *  否则用户切一下档位就把已批准的记忆全丢了。 */
  applyPreset(preset: PermissionPreset): void {
    this.preset = preset;
    if (preset === 'full') {
      this.levels = {
        // 命中危险规则的命令不随「完全访问」放行，shell 回给模型的话也据此说「换任何档位都不放行」（W1b-2g）。
        // 危险规则按命令写法认（DANGER_ANYWHERE、DANGER_AT_COMMAND_POSITION），拦不住所有不可逆操作——设置页副标题照此如实写
        danger: 'notAllowed',
        readonly: 'bypass', gated: 'bypass', 'file-write': 'bypass', 'file-read': 'bypass',
        'web-fetch': 'bypass',
        'web-search': 'bypass',
        'mcp': 'bypass',
        'bridge-device': 'bypass', 'bridge-notify': 'bypass',
        'bridge-clipboard-read': 'bypass', 'bridge-clipboard-write': 'bypass',
        'bridge-open': 'bypass', 'bridge-speak': 'bypass', 'bridge-screenshot': 'bypass',
      };
    } else {
      this.levels = { ...DEFAULT_LEVELS };
      if (preset === 'plan') {
        for (const cls of ['gated', 'file-write', 'mcp', 'bridge-notify', 'bridge-clipboard-write', 'bridge-open', 'bridge-speak'] as const) {
          this.levels[cls] = 'notAllowed';
        }
      }
    }
  }

  /** 决策 4c：shell 卡「本会话允许」时对该命令探测到的每个桥 kind 做会话级授权。 */
  grantBridgeSession(sessionId: string, kind: BridgePermissionKind): void {
    this.sessionBridgeGrants.add(`${sessionId}\u0000${kind}`);
  }

  /** 决策 4c：shell 卡「允许一次」时计数 +1；同 kind 多次 grant 的 grantedAt 以最后一次为准。 */
  grantBridgeOnce(sessionId: string, kind: BridgePermissionKind): void {
    const key = `${sessionId}\u0000${kind}`;
    const cur = this.bridgeOnce.get(key);
    this.bridgeOnce.set(key, { count: (cur?.count ?? 0) + 1, grantedAt: this.now() });
  }

  /** F05：收回 grantBridgeSession 发出的会话级桥授权。按 (会话, 桥 kind) 记的，同一个 kind 若还有别的卡也授过，
   *  会一并收回——代价只是以后多问一次，不会多放。 */
  revokeBridgeSession(sessionId: string, kind: BridgePermissionKind): void {
    this.sessionBridgeGrants.delete(`${sessionId}\u0000${kind}`);
  }

  /** F05：收回一次 grantBridgeOnce（计数减一，减到零删条目）。已经被消费或过期清掉的不动。 */
  revokeBridgeOnce(sessionId: string, kind: BridgePermissionKind): void {
    const key = `${sessionId}\u0000${kind}`;
    const cur = this.bridgeOnce.get(key);
    if (!cur) return;
    if (cur.count > 1) cur.count -= 1; else this.bridgeOnce.delete(key);
  }

  /**
   * F05：收回一张卡的放行带来的授权。调用方是运行账本的权限接缝：批准已收到，但「已放行」没能落进执行账本，
   * 这次放行被改成了拒绝（invalidated / record-failed），回给模型的话是「这次批准已失效……会重新询问」。
   * 「本会话允许」在 decide 交回放行之前就记下了会话授权：不收回，同样的请求下一次不弹卡直接放行，与那句话、与审计里的「已失效」都对不上。
   * 只认卡片上的允许（user-once / user-session）：档位免审、既有的会话授权与桥合并授权不是这张卡带来的，不动。
   * 只会收回，从不放行；不抛。
   */
  revokeGrant(req: PermissionRequest, a: PermissionAllowed): void {
    if (a.via !== 'user-once' && a.via !== 'user-session') return;
    // 这张卡发出之前键一定不在（在的话 decide 走会话授权、不会弹卡），删掉就是回到发卡之前
    if (a.via === 'user-session') this.sessionGrants.delete(grantKeyOf(req));
    try { this.hooks?.onRevoked?.(req, a); } catch { /* 宿主钩子的错误不能变成「工具执行异常」 */ }
  }

  /** M4 Task 2：查询会话是否曾授权过桥（sessionBridgeGrants 或 bridgeOnce 有记录，TTL 内有效）。 */
  hasBridgeGrant(sessionId: string): boolean {
    const prefix = `${sessionId}\u0000`;
    for (const k of this.sessionBridgeGrants) if (k.startsWith(prefix)) return true;
    for (const [k, v] of this.bridgeOnce) {
      if (k.startsWith(prefix) && this.now() - v.grantedAt <= BRIDGE_ONCE_TTL_MS) return true;
    }
    return false;
  }

  /** 旧式二值结果：decide 的投影。留给只认二值的调用方与既有断言；src 里的工具都走 decide（经 permission-outcome.ts）。 */
  async check(req: PermissionRequest): Promise<PermissionDecision> {
    return (await this.decide(req)).decision;
  }

  /**
   * F13：带原因的判定。放行的出口与顺序同以前的 check 逐行对应（档位 bypass → 会话授权 → 桥合并授权 → 卡片上的允许），
   * 只是每个出口带上来源；新增的两步（询问方已取消、连续无人答复）只会拒。其余任何值都是拒绝。
   */
  async decide(req: PermissionRequest, opts: PermissionAskOptions = {}): Promise<PermissionOutcome> {
    // 非 shell 请求的 detail 是路径/能力串，不能喂给 shell 分类器：
    // 例如 C:\tools\diskpart\notes.txt 会被误判成 danger 而静默拒绝；桥 kind 直接就是类目。
    const cls: PermissionClass = req.kind === 'shell' ? classifyShellCommand(req.detail) : req.kind;
    // plan 仍询问只因路径等敏感字样回落的只读命令；其它三档沿用原分类与档位。
    const level = this.isPlanMode() && cls === 'gated' && isReadonlyCommand(req.detail) ? 'askOnce' : this.levels[cls];
    if (level === 'bypass') return allowed('level-bypass');
    if (level === 'notAllowed') {
      // 规则直接拦下：不询问。以前这里不留任何痕迹，现在报给宿主记一条审计
      const d = denied('rule-blocked', cls === 'danger' ? 'shell-danger' : this.isPlanMode() ? 'plan-mode' : 'level-not-allowed');
      this.noteDenied(req, d, noteOptsOf(opts));
      return d;
    }
    const grantKey = grantKeyOf(req);
    if (this.sessionGrants.has(grantKey)) return allowed('session-grant');

    // 桥双段合并授权（决策 4c）：精确 key 之后、prompt 之前；先会话级按 kind，再一次性计数消费。
    if (req.kind.startsWith('bridge-')) {
      const bKey = `${req.sessionId}\u0000${req.kind}`;
      if (this.sessionBridgeGrants.has(bKey)) return allowed('bridge-grant');
      const once = this.bridgeOnce.get(bKey);
      if (once) {
        if (this.now() - once.grantedAt <= BRIDGE_ONCE_TTL_MS) {
          if (once.count > 1) once.count -= 1; else this.bridgeOnce.delete(bKey);
          return allowed('bridge-grant');
        }
        this.bridgeOnce.delete(bKey); // 过期懒清理：不消费，走 prompt
      }
    }

    // 以下都是「要询问」的请求。新增的两步只会拒，排在所有放行出口之后——它们挡不住本来就免审的操作
    // 询问方已经不要这次许可了：不弹卡，不记审计
    if (opts.signal?.aborted) return denied('cancelled', cancelCauseOf(opts.signal));
    const origin = opts.origin ?? 'tool';
    // 这次询问受不受「连续无人答复」上限管。工具发起的一律受。桥发起的分两种，都只带会话 id、分不开：
    //  - 该会话有 run 在跑：多半是 agent 的 shell 子进程发的。shell 命令已获「本会话允许」、命令文本里又探测不到桥触发
    //    （省略默认动作的写法，或经脚本间接调桥）时没有合并授权，每次都弹一张桥卡；没人在场时桥卡挂满时限超时
    //    （命令自己的超时更短的话，是 bridge-cli 先被杀掉、桥卡按请求方断开了结），模型原样重跑同一条命令又弹一张——
    //    桥不受限的话，这条路上能一直弹到回合上限。所以与工具询问同样计数、同样受限。
    //  - 没有 run 在跑：不是 agent 发的——用户在终端面板里手动跑的命令，人就在跟前，不计数、不受限。
    // 代价：run 在跑、计数又已到上限时，用户本人在终端面板里手动跑的桥命令同样不弹卡（bridge-cli 的输出会说明，
    // 回合结束或发下一条消息后恢复）。
    // 只在发起这一刻判一次，下面记数沿用同一个结论。它只决定「问不问」，排在所有放行出口之后，不会多放
    const capped = origin === 'tool' || this.runActiveNow(req.sessionId);
    // 连续无人答复到上限：不再弹卡
    if (capped && (this.unanswered.get(req.sessionId)?.streak ?? 0) >= MAX_UNANSWERED_STREAK) {
      const d = denied('timeout', 'unattended');
      this.noteDenied(req, d, noteOptsOf(opts));
      return d;
    }

    const mySeq = ++this.askSeq;
    const ask = new AbortController();
    const startedAt = this.now();
    let issuedId: string | undefined;
    // 网关放弃这次询问（兜底时限到 / 询问方取消）：先挂这个监听，再调询问函数——
    // 询问函数自己挂的 abort 监听排在它后面，同一拍里先兑现的是这里，原因以网关的为准
    const abandoned = new Promise<PromptAnswer>(res => {
      ask.signal.addEventListener('abort', () => {
        const a = ask.signal.reason as PromptAbort;
        res({ answer: 'deny', reason: a.reason, cause: a.cause, waitedMs: this.now() - startedAt });
      }, { once: true });
    });
    // 兜底时限不再自己「回 deny」，而是放弃这次询问：询问函数（broker）在同一个回调里同步把卡了结，之后到达的答复查不到条目
    const watchdog = setTimeout(() => ask.abort(new PromptAbort('timeout', 'unanswered')), this.askTimeoutMs);
    const outer = opts.signal;
    const onOuter = (): void => ask.abort(new PromptAbort('cancelled', cancelCauseOf(outer)));
    outer?.addEventListener('abort', onOuter, { once: true });
    let raw: unknown;
    try {
      // 询问函数同步调用：卡片在 decide 的同一拍登记
      const p = Promise.resolve(this.prompt(req, {
        signal: ask.signal, toolUseId: opts.toolUseId, origin,
        issued: id => { issuedId = id; try { opts.onIssued?.(id); } catch { /* 观察者的错误不影响判定 */ } },
      }));
      p.catch(() => undefined); // 放弃之后晚到的拒绝不成未处理拒绝
      raw = await Promise.race([p, abandoned]);
    } finally {
      clearTimeout(watchdog); // 询问函数先返回时清掉悬挂定时器
      outer?.removeEventListener('abort', onOuter);
    }

    const a = normalizeAnswer(raw);
    const requestId = a.requestId ?? issuedId;
    if (a.kind === 'allow') {
      // 用户亲自作答：清掉这个会话的无人答复计数
      this.unanswered.delete(req.sessionId);
      if (a.via === 'user-session') this.sessionGrants.add(grantKey);
      return allowed(a.via, requestId);
    }
    // 桥卡弹出来了，没等到任何人答复，请求方（管道另一头的 bridge-cli）先走了。与挂满时限超时一样算一段无人答复：
    // shell_execute 的超时秒数是模型给的，比卡片时限短时命令先被杀掉进程树，bridge-cli 随之退出、管道断开，这张桥卡走不到
    // timeout、而是按 cancelled / requester-gone 了结。只认 timeout 的话这条路上计数一直是 0——模型拿到的是「[命令超时被终止]」
    // （没有任何权限提示），原样重跑又弹一张，能一直弹到回合上限。
    // 只认桥询问的这一种 cause：工具询问的取消，以及桥卡被用户停止 / 删除会话 / 关停了结，都是人或系统主动收的，不算没人在；
    // 进门前请求方就走了的（上面 opts.signal.aborted 那一步）没弹过卡，也不算。
    // 代价：run 在跑时用户本人在终端面板里手动跑桥命令、没答卡就按了 Ctrl+C，同样记一段（下面还要过 capped，没有 run 时不记）。
    const requesterLeft = origin === 'bridge' && a.reason === 'cancelled' && a.cause === 'requester-gone';
    if (a.reason === 'user-denied') {
      this.unanswered.delete(req.sessionId);
    } else if ((a.reason === 'timeout' || requesterLeft) && capped) {
      // 按「一段无人答复」记，不按卡片张数记：同批并排的几张卡一起超时只算一次（F04 之后同批不冲突的写入是同时弹卡的）
      const u = this.unanswered.get(req.sessionId) ?? { streak: 0, coveredSeq: 0 };
      if (mySeq > u.coveredSeq) this.unanswered.set(req.sessionId, { streak: u.streak + 1, coveredSeq: this.askSeq });
    }
    // 其余的取消、失效、说不清的结果都不计数；任何非允许的结果都不留授权。计数只决定以后「问不问」，这次交回的原因照实不变
    const cause = a.reason === 'timeout' ? (a.cause ?? 'unanswered') : a.cause;
    return denied(a.reason, cause, { requestId, waitedMs: a.waitedMs });
  }

  /** F13：把一次「没问就拒」或「批准了却没执行」交给宿主记审计。不改变任何判定；钩子抛错被兜住。 */
  noteDenied(req: PermissionRequest, d: PermissionDenied, opts?: Pick<PermissionAskOptions, 'toolUseId' | 'origin'>): void {
    try { this.hooks?.onDenied?.(req, d, opts); } catch { /* 审计钩子的错误不能变成「工具执行异常」 */ }
  }

  /** F13：用户在场的证据——发了新消息，或对这个会话的卡做了答复（哪怕晚到、没生效）：清掉该会话的「连续无人答复」计数。 */
  resetUnanswered(sessionId: string): void {
    this.unanswered.delete(sessionId);
  }

  /** F13：该会话此刻有没有 run 在跑（宿主的 runActive 钩子）。没接钩子 = 没有。
   *  钩子抛错按「在跑」处理：受上限管只会少弹卡、多拒，不会多放。 */
  private runActiveNow(sessionId: string): boolean {
    const hooks = this.hooks;
    if (!hooks?.runActive) return false;
    try { return hooks.runActive(sessionId) === true; } catch { return true; }
  }
}

function noteOptsOf(opts: PermissionAskOptions): Pick<PermissionAskOptions, 'toolUseId' | 'origin'> {
  return { ...(opts.toolUseId !== undefined ? { toolUseId: opts.toolUseId } : {}), origin: opts.origin ?? 'tool' };
}

type NormalizedAnswer =
  | { kind: 'allow'; via: 'user-once' | 'user-session'; requestId?: string }
  | { kind: 'deny'; reason: PermissionDenied['reason']; cause?: PermissionDenyCause; requestId?: string; waitedMs?: number };

/** 询问函数给出的值 → 归一结果。失败关闭：只有两种 allow-* 是允许；说不清的一律 unspecified / invalid-outcome。从不抛。 */
function normalizeAnswer(raw: unknown): NormalizedAnswer {
  const invalid: NormalizedAnswer = { kind: 'deny', reason: 'unspecified', cause: 'invalid-outcome' };
  try {
    // 裸三值 = 用户亲自作答
    if (raw === 'allow-once') return { kind: 'allow', via: 'user-once' };
    if (raw === 'allow-session') return { kind: 'allow', via: 'user-session' };
    if (raw === 'deny') return { kind: 'deny', reason: 'user-denied' };
    if (raw === null || typeof raw !== 'object') return invalid;
    const o = raw as Record<string, unknown>;
    const requestId = typeof o.requestId === 'string' && o.requestId !== '' ? o.requestId : undefined;
    if (o.answer === 'allow-once') return { kind: 'allow', via: 'user-once', requestId };
    if (o.answer === 'allow-session') return { kind: 'allow', via: 'user-session', requestId };
    if (o.answer !== 'deny') return { ...invalid, requestId };
    const reason = o.reason;
    if (reason !== 'user-denied' && reason !== 'timeout' && reason !== 'cancelled' && reason !== 'invalidated') return { ...invalid, requestId };
    const cause = typeof o.cause === 'string' && (PERMISSION_DENY_CAUSES[reason] as readonly string[]).includes(o.cause)
      ? (o.cause as PermissionDenyCause) : undefined;
    const waitedMs = typeof o.waitedMs === 'number' && Number.isFinite(o.waitedMs) && o.waitedMs >= 0 ? o.waitedMs : undefined;
    return { kind: 'deny', reason, cause, requestId, waitedMs };
  } catch {
    return invalid;
  }
}
