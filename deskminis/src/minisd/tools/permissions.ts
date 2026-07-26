import type { PermissionDecision, PermissionGateway, PermissionRequest } from './types';

export type CommandClass = 'read' | 'write' | 'danger';
export type PermissionLevel = 'bypass' | 'askOnce' | 'notAllowed';
export type PermissionPrompt = (req: PermissionRequest) => Promise<'allow-once' | 'allow-session' | 'deny'>;

const DANGER = [
  /\b(remove-item|ri|del|erase|rd|rmdir)\b[\s\S]*(-recurse|\/s)/i,
  /\brm\b\s+(-\w*r|--recursive)/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\breg\s+(add|delete)\b/i,
  /\b(shutdown|restart-computer|stop-computer)\b/i,
  /\b(diskpart|bcdedit|cipher\s+\/w|takeown|icacls[\s\S]*\/grant)\b/i,
  /\bsc(\.exe)?\s+(stop|delete|config)\b/i,
  /\bstop-service\b/i,
];
const READ = [
  /^\s*(dir|ls|gci|get-childitem|type|cat|gc|get-content|pwd|get-location|whoami|hostname|echo|write-output|select-string|findstr|where(\.exe)?|which|tree)\b[^>|]*$/i,
  /^\s*git\s+(status|log|diff|show|branch|remote)\b[^>|]*$/i,
  /^\s*(get-\w+)\b[^>|]*$/i,
];

export function classifyShellCommand(command: string): CommandClass {
  const c = command.trim();
  if (DANGER.some(r => r.test(c))) return 'danger';
  if (READ.some(r => r.test(c))) return 'read';
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
