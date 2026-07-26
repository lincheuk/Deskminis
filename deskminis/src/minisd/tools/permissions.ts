import type { PermissionDecision, PermissionGateway, PermissionRequest } from './types';

export type CommandClass = 'read' | 'write' | 'danger';
export type PermissionLevel = 'bypass' | 'askOnce' | 'notAllowed';
export type PermissionPrompt = (req: PermissionRequest) => Promise<'allow-once' | 'allow-session' | 'deny'>;

/** 命令组合/求值/重定向符：出现任一即无法证明整条命令只读。 */
const COMPOSITION = /[;&`\n\r]|\||\$\(|@\(|>|</;

/** 危险：不可逆或系统级操作。顺序无关——危险动词出现在任何位置都算。 */
const DANGER = [
  /\b(remove-item|ri|rm|del|erase|rd|rmdir|remove-itemproperty|clear-content|clear-item)\b/i,
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
];

/** 只读白名单（仅在无组合符时适用）。 */
const READ_PATTERNS = [
  /^\s*(dir|ls|gci|type|cat|gc|pwd|whoami|hostname|tree|echo|write-output|write-host|select-string|findstr|where|which|measure-object)\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|rev-parse|describe|blame|ls-files|config\s+--get)\b/i,
  /^\s*get-[a-z]+\b/i,
];

export function classifyShellCommand(command: string): CommandClass {
  const c = command.trim();
  if (DANGER.some(r => r.test(c))) return 'danger';
  if (COMPOSITION.test(c)) return 'write';
  if (READ_PATTERNS.some(r => r.test(c))) return 'read';
  return 'write';
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
