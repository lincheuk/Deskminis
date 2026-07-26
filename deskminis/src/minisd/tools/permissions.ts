import type { PermissionDecision, PermissionGateway, PermissionRequest } from './types';

export type CommandClass = 'read' | 'write' | 'danger';
export type PermissionLevel = 'bypass' | 'askOnce' | 'notAllowed';
export type PermissionPrompt = (req: PermissionRequest) => Promise<'allow-once' | 'allow-session' | 'deny'>;

/**
 * 求值/组合/重定向字符：出现任一即无法证明整条命令只读。用字符串集合而非正则，避免转义歧义。
 * 注意 `\x60` 即 PowerShell 的反引号（转义符/续行符），写成十六进制转义以免与 JS 模板字面量混淆。
 */
const OPERATOR_CHARS = '()$;|&\x60<>{}[]';

/** 惰性字符集：只允许字母(含 CJK)、数字、空格/制表符与不具求值能力的标点。 */
const INERT_CHARS = /^[\p{L}\p{N}\p{M}_ \t\-.:\\/*?,=+#%'"@]*$/u;

/** 闭合的只读内建 cmdlet 列表——不再使用 get-* 通配符（用户自定义函数可冒充）。 */
const READ_COMMANDS = new Set([
  'dir', 'ls', 'gci', 'pwd', 'whoami', 'hostname', 'tree', 'cat', 'type', 'gc',
  'get-content', 'get-childitem', 'get-location', 'get-date', 'get-item',
  'get-itemproperty', 'get-command', 'get-help', 'get-member', 'get-module',
  'get-process', 'get-service', 'get-variable',
  'test-path', 'select-string', 'findstr', 'measure-object',
]);

/** git 只保留确定只读的子命令：branch/remote 有改写形态，故排除。 */
const READ_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'blame', 'ls-files',
]);

/** 危险：不可逆或系统级操作。顺序无关。 */
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
  // 名字绑定原语：长驻 shell 中可用来给只读白名单里的名字挂上任意行为（影子命名提权）
  /(^|[;|&(]\s*)(function|filter|workflow)\s/i,
  /\b(set-alias|new-alias|doskey)\b/i,
  /\b(set-item|new-item)\b[\s\S]*\b(alias|function):/i,
];

/** 短别名歧义大（"del old code" 这类散文会误伤），故仅在命令位匹配：行首或组合符之后。 */
const DANGER_AT_COMMAND_POSITION = [
  /(^|[;|&(]\s*)(rm|ri|del|erase|rd|rmdir)\b/i,
];

export function classifyShellCommand(command: string): CommandClass {
  const c = command.trim();
  if (DANGER_ANYWHERE.some(r => r.test(c))) return 'danger';
  if (DANGER_AT_COMMAND_POSITION.some(r => r.test(c))) return 'danger';
  if (isProvablyReadOnly(c)) return 'read';
  return 'write';
}

/** 四条件全满足才可证明只读；任一不满足即降级为需确认。 */
function isProvablyReadOnly(c: string): boolean {
  if (/[\n\r]/.test(c)) return false;                                // 1. 多行可串联多条命令
  if ([...c].some(ch => OPERATOR_CHARS.includes(ch))) return false;   // 2. 任何求值/组合/重定向字符
  if (!INERT_CHARS.test(c)) return false;                            // 3. 仅惰性字符
  const first = c.match(/^([\p{L}\p{N}_.\-]+)/u);                    // 4. 首 token 在闭合列表内
  if (!first) return false;
  const verb = first[1].toLowerCase();
  if (verb === 'git') {
    const sub = c.match(/^git\s+([\w-]+)/i);
    return sub !== null && READ_GIT_SUBCOMMANDS.has(sub[1].toLowerCase());
  }
  return READ_COMMANDS.has(verb);
}

const DEFAULT_LEVELS: Record<CommandClass | 'file-write', PermissionLevel> = {
  read: 'bypass', write: 'askOnce', danger: 'notAllowed', 'file-write': 'askOnce',
};

export class PermissionGatewayImpl implements PermissionGateway {
  private levels: Record<CommandClass | 'file-write', PermissionLevel>;
  private sessionGrants = new Set<string>(); // `${sessionId}:${class}`

  constructor(private prompt: PermissionPrompt, levels?: Partial<Record<CommandClass | 'file-write', PermissionLevel>>, private askTimeoutMs = 30000) {
    this.levels = { ...DEFAULT_LEVELS, ...levels };
  }

  async check(req: PermissionRequest): Promise<PermissionDecision> {
    const cls: CommandClass | 'file-write' = req.kind === 'file-write' ? 'file-write' : classifyShellCommand(req.detail);
    const level = this.levels[cls];
    if (level === 'bypass') return 'allow';
    if (level === 'notAllowed') return 'deny';
    const grantKey = `${req.sessionId}:${cls}`;
    if (this.sessionGrants.has(grantKey)) return 'allow';
    const answer = await Promise.race([
      this.prompt(req),
      new Promise<'deny'>(res => setTimeout(() => res('deny'), this.askTimeoutMs)),
    ]);
    if (answer === 'allow-session') { this.sessionGrants.add(grantKey); return 'allow'; }
    return answer === 'allow-once' ? 'allow' : 'deny';
  }
}
