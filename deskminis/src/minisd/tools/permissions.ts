import type { BridgePermissionKind, PermissionDecision, PermissionGateway, PermissionRequest } from './types';

/** 危险层保留：这些命令即使用户想批准也硬拦截（不可逆/系统级/影子命名原语）。 */
export type CommandClass = 'danger' | 'readonly' | 'gated';
export type PermissionLevel = 'bypass' | 'askOnce' | 'notAllowed';
export type PermissionPrompt = (req: PermissionRequest) => Promise<'allow-once' | 'allow-session' | 'deny'>;
/** 权限选择器三档预设：'ask'/'session' 网关行为相同（差异只在前端预选高亮），'full' 放行除 danger 外全部。 */
export type PermissionPreset = 'ask' | 'session' | 'full';

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
    { sub: 'ls' }, { sub: 'view' }, { sub: 'outdated' },
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
  // --output 是 git 家族把只读查询结果写进文件的后门（diff/show/log 通用旗标），
  // 白名单内没有命令合法使用该前缀，全局按 token 前缀拒绝
  if (tokens.some(t => t.toLowerCase().startsWith('--output'))) return false;
  // 执行型旗标：白名单里的 rg 本身只读，但 --pre 之类会把它变成任意程序启动器
  if (tokens.some(t => EXEC_FLAG_RE.test(t))) return false;
  // 结构过滤已拒绝一切 &，这里再剥一次调用符前缀是防御性兜底：两道闸少一道也不至于漏
  const head = tokens[0].replace(/^&/, '').toLowerCase();
  if (!READONLY_ALLOWLIST.has(head)) return false;
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
  if (tokens.some(t => t.toLowerCase().startsWith('--output'))) return false;
  // 管道右侧同样有 rg/sls：这一侧必须用同一道闸，否则 gci | rg --pre cmd 就绕过去了
  if (tokens.some(t => EXEC_FLAG_RE.test(t))) return false;
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

export function classifyShellCommand(command: string): CommandClass {
  const c = command.trim();
  // 危险层两个表原样先行：readonly 判定绝不允许越过 danger（Remove-Item 开头必是 danger）
  if (DANGER_ANYWHERE.some(r => r.test(c))) return 'danger';
  if (DANGER_AT_COMMAND_POSITION.some(r => r.test(c))) return 'danger';
  if (isReadonlyCommand(c)) return 'readonly';
  return 'gated';
}

/** 权限判定类目：shell 命令分级 + 文件读写两类 + web 抓取/搜索两类 + windows-* 桥七类（其余 kind 即类目，绝不经 shell 分类器）。 */
export type PermissionClass = CommandClass | 'file-write' | 'file-read' | 'web-fetch' | 'web-search' | BridgePermissionKind;

const DEFAULT_LEVELS: Record<PermissionClass, PermissionLevel> = {
  danger: 'notAllowed',
  // 只读免批：保守子集判定通过即静默放行——查目录/看 git status 这类高频只读不再打断用户
  readonly: 'bypass',
  gated: 'askOnce', 'file-write': 'askOnce', 'file-read': 'askOnce',
  // web 抓取默认过卡：URL 的查询串/路径可携带会话内外传数据，是现成的静默外泄通道
  'web-fetch': 'askOnce',
  // web 搜索同理：查询串本身就是数据外传通道（论证同 web-fetch），默认过卡
  'web-search': 'askOnce',
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

export class PermissionGatewayImpl implements PermissionGateway {
  private levels: Record<PermissionClass, PermissionLevel>;
  /** 会话批准：按 (sessionId, kind, 精确命令/路径/能力串) 记忆——同一条命令原样重复才静默。 */
  private sessionGrants = new Set<string>();
  /** 桥会话合并授权（决策 4c）：按 (sessionId, 桥 kind) 记忆——shell 卡批准一次，该桥本会话不再弹卡。 */
  private sessionBridgeGrants = new Set<string>();
  /** 桥一次性合并授权：计数 + 最后授予时刻（120s TTL，check 时懒清理）。 */
  private bridgeOnce = new Map<string, { count: number; grantedAt: number }>();

  constructor(
    private prompt: PermissionPrompt,
    levels?: Partial<Record<PermissionClass, PermissionLevel>>,
    private askTimeoutMs = 90000,
    private now: () => number = Date.now, // 可注入时钟（TTL 测试用）；生产默认 Date.now
  ) {
    this.levels = { ...DEFAULT_LEVELS, ...levels };
  }

  /** 应用权限预设档位。'ask'/'session' 都把 levels 恢复为 DEFAULT_LEVELS——
   *  这两档的差异只在前端预选高亮，网关行为本就相同；'full' 把 danger 以外全部放行。
   *  只改 levels，不动 sessionGrants/bridgeOnce：切档不清掉既有的会话级/一次性授权，
   *  否则用户切一下档位就把已批准的记忆全丢了。 */
  applyPreset(preset: PermissionPreset): void {
    if (preset === 'full') {
      this.levels = {
        danger: 'notAllowed', // 不可逆/系统级操作不随「完全访问」放行——文案里「不可逆的系统操作仍拦截」是承诺，不是摆设
        readonly: 'bypass', gated: 'bypass', 'file-write': 'bypass', 'file-read': 'bypass',
        'web-fetch': 'bypass',
        'web-search': 'bypass',
        'bridge-device': 'bypass', 'bridge-notify': 'bypass',
        'bridge-clipboard-read': 'bypass', 'bridge-clipboard-write': 'bypass',
        'bridge-open': 'bypass', 'bridge-speak': 'bypass', 'bridge-screenshot': 'bypass',
      };
    } else {
      this.levels = { ...DEFAULT_LEVELS };
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

  /** M4 Task 2：查询会话是否曾授权过桥（sessionBridgeGrants 或 bridgeOnce 有记录，TTL 内有效）。 */
  hasBridgeGrant(sessionId: string): boolean {
    const prefix = `${sessionId}\u0000`;
    for (const k of this.sessionBridgeGrants) if (k.startsWith(prefix)) return true;
    for (const [k, v] of this.bridgeOnce) {
      if (k.startsWith(prefix) && this.now() - v.grantedAt <= BRIDGE_ONCE_TTL_MS) return true;
    }
    return false;
  }

  async check(req: PermissionRequest): Promise<PermissionDecision> {
    // 非 shell 请求的 detail 是路径/能力串，不能喂给 shell 分类器：
    // 例如 C:\tools\diskpart\notes.txt 会被误判成 danger 而静默拒绝；桥 kind 直接就是类目。
    const cls: PermissionClass = req.kind === 'shell' ? classifyShellCommand(req.detail) : req.kind;
    if (this.levels[cls] === 'bypass') return 'allow';
    if (this.levels[cls] === 'notAllowed') return 'deny';
    const grantKey = `${req.sessionId}\u0000${req.kind}\u0000${req.detail}`;
    if (this.sessionGrants.has(grantKey)) return 'allow';

    // 桥双段合并授权（决策 4c）：精确 key 之后、prompt 之前；先会话级按 kind，再一次性计数消费。
    if (req.kind.startsWith('bridge-')) {
      const bKey = `${req.sessionId}\u0000${req.kind}`;
      if (this.sessionBridgeGrants.has(bKey)) return 'allow';
      const once = this.bridgeOnce.get(bKey);
      if (once) {
        if (this.now() - once.grantedAt <= BRIDGE_ONCE_TTL_MS) {
          if (once.count > 1) once.count -= 1; else this.bridgeOnce.delete(bKey);
          return 'allow';
        }
        this.bridgeOnce.delete(bKey); // 过期懒清理：不消费，走 prompt
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'deny'>(res => { timer = setTimeout(() => res('deny'), this.askTimeoutMs); });
    let answer: 'allow-once' | 'allow-session' | 'deny';
    try {
      answer = await Promise.race([this.prompt(req), timeout]);
    } finally {
      if (timer) clearTimeout(timer); // 修复：prompt 先返回时清掉悬挂定时器
    }
    if (answer === 'allow-session') { this.sessionGrants.add(grantKey); return 'allow'; }
    return answer === 'allow-once' ? 'allow' : 'deny';
  }
}
