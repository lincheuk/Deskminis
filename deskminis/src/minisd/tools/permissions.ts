import type { BridgePermissionKind, PermissionDecision, PermissionGateway, PermissionRequest } from './types';

/** 危险层保留：这些命令即使用户想批准也硬拦截（不可逆/系统级/影子命名原语）。 */
export type CommandClass = 'danger' | 'gated';
export type PermissionLevel = 'bypass' | 'askOnce' | 'notAllowed';
export type PermissionPrompt = (req: PermissionRequest) => Promise<'allow-once' | 'allow-session' | 'deny'>;

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

export function classifyShellCommand(command: string): CommandClass {
  const c = command.trim();
  if (DANGER_ANYWHERE.some(r => r.test(c))) return 'danger';
  if (DANGER_AT_COMMAND_POSITION.some(r => r.test(c))) return 'danger';
  return 'gated';
}

/** 权限判定类目：shell 命令分级 + 文件读写两类 + windows-* 桥七类（后九类 kind 即类目，绝不经 shell 分类器）。 */
export type PermissionClass = CommandClass | 'file-write' | 'file-read' | BridgePermissionKind;

const DEFAULT_LEVELS: Record<PermissionClass, PermissionLevel> = {
  danger: 'notAllowed', gated: 'askOnce', 'file-write': 'askOnce', 'file-read': 'askOnce',
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

export class PermissionGatewayImpl implements PermissionGateway {
  private levels: Record<PermissionClass, PermissionLevel>;
  /** 会话批准：按 (sessionId, kind, 精确命令/路径/能力串) 记忆——同一条命令原样重复才静默。 */
  private sessionGrants = new Set<string>();

  constructor(
    private prompt: PermissionPrompt,
    levels?: Partial<Record<PermissionClass, PermissionLevel>>,
    private askTimeoutMs = 30000,
  ) {
    this.levels = { ...DEFAULT_LEVELS, ...levels };
  }

  async check(req: PermissionRequest): Promise<PermissionDecision> {
    // 非 shell 请求的 detail 是路径/能力串，不能喂给 shell 分类器：
    // 例如 C:\tools\diskpart\notes.txt 会被误判成 danger 而静默拒绝；桥 kind 直接就是类目。
    const cls: PermissionClass = req.kind === 'shell' ? classifyShellCommand(req.detail) : req.kind;
    if (this.levels[cls] === 'bypass') return 'allow';
    if (this.levels[cls] === 'notAllowed') return 'deny';
    const grantKey = `${req.sessionId}\u0000${req.kind}\u0000${req.detail}`;
    if (this.sessionGrants.has(grantKey)) return 'allow';

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
