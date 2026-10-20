/**
 * F09 进程树的线上类型（共享契约；本文件没有任何 import）。
 *
 * 一棵「进程树」= 引擎为 shell、终端或 stdio MCP 起的那个根进程，连同根再起的全部后代。
 * 根进程自己建一个不许脱离、带 KILL_ON_JOB_CLOSE 的作业对象并把自己放进去（见 minisd/proc/owned.ts）；
 * 这里的类型描述每棵树的身份、托管状态与结束方式，供进程账本、只读 RPC（proc.trees.snapshot）与诊断使用。
 * 时间字段（startedAt、stopAt、endedAt、takenAt）都是 Unix 秒（带小数），与 F05 运行账本同一个单位。
 */

/** G02 追加 'browser'：库里这一列是无约束的 TEXT，加值不需要迁移。 */
export const PROC_TREE_KINDS = ['shell', 'terminal', 'mcp'] as const;
export type ProcTreeKind = (typeof PROC_TREE_KINDS)[number];

/** pending：根已起，归属结论还没到。
 *  job：根自己报告「作业已建、自己已在里面、属主监视已就位」，且报告里的 pid 与引擎手里的子进程相符。
 *  none：没有托管，原因在 protectionReason。 */
export type ProcProtection = 'pending' | 'job' | 'none';

/** 引擎发起回收的原因。disposed：调用方没给原因。 */
export type ProcStopCause =
  | 'cancel' | 'timeout' | 'session-deleted' | 'shutdown' | 'startup-failed'
  | 'config-changed' | 'idle-evicted' | 'server-error' | 'probe-done' | 'disposed';

/** exited：根自己退出。stopped：引擎发起回收之后退出。spawn-failed：根没起来。
 *  engine-lost：引擎停止时这棵树还开着、也没有发起过回收；只由后一代的启动恢复写。 */
export type ProcEndKind = 'exited' | 'stopped' | 'spawn-failed' | 'engine-lost';

/** createdAt：进程自己报的创建时间（FILETIME，十进制字符串）。PID 只有和它一起才算身份。 */
export interface ProcIdentity { pid: number; createdAt?: string }

export interface ProcTreeView {
  id: string; epoch: number; kind: ProcTreeKind;
  /** shell、终端 */
  sessionId?: string;
  /** MCP：服务器名 */
  ownerRef?: string;
  /** shell：这棵树出生时该会话的活动 run（F05 的 runId） */
  runId?: string;
  root?: ProcIdentity;
  /** MCP：launcher 起的 server 的 pid */
  targetPid?: number;
  protection: ProcProtection; protectionReason?: string;
  /** 归属之前根是否已在某个作业里（通常是运行时自带的那个）。只作诊断，不参与 protection 的判定。 */
  preJob?: boolean;
  startedAt: number;
  stopCause?: ProcStopCause; stopRunId?: string; stopAt?: number;
  endedAt?: number; endKind?: ProcEndKind; exitCode?: number; exitSignal?: string;
  /** 只由后一代关账时写。job：当时 protection 是 job，整棵树已随引擎由系统结束。unverified：没有依据。 */
  reaped?: 'job' | 'unverified';
  recoveredEpoch?: number;
}

/** untested：本次运行还没有根报告过归属结论。active：至少一棵树到过 job。disabled：本次运行不再尝试托管，reason 是原因。
 *  lastFailure：最近一棵没托管成的树的原因；之后有树到了 job 就清空。 */
export interface ProcOwnershipStatus { state: 'untested' | 'active' | 'disabled'; reason?: string; lastFailure?: string }

export interface ProcSnapshot { epoch: number; takenAt: number; ownership: ProcOwnershipStatus; trees: ProcTreeView[] }
