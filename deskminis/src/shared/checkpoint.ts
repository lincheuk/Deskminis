/**
 * F08：普通文件检查点——引擎与渲染端共用的线上契约。
 *
 * 纯类型、常量与纯函数，没有任何 import（与 shared/run.ts、shared/permission.ts 同一做法）。
 *
 * 以前内置的文件写入直接覆盖原文件：改动前的内容没有任何地方留着，「改动」清单只是工具入参的投影，与磁盘事实无关。
 * 这里定下的是：每一次由内置文件 / Office 写入工具做的改动都有一条记录（写入前的版本、写入后的版本、路径身份、
 * 关联的 run 与工具执行），以及恢复它时可能得到的每一种结论。恢复从不盖掉用户后来的修改：对不上就是冲突，
 * 冲突时只提供「另存改动前的版本」。
 *
 * 文案只有这一处（引擎的结果 message 与界面共用；措辞守卫盯这个文件）。
 */

/** 会留下检查点的内置工具。shell、MCP、记忆写入等不在其中：它们改了什么无从枚举，不在可恢复范围。 */
export const CHECKPOINTED_TOOLS = ['file_write', 'file_edit', 'office_write'] as const;

/** 写入前的文件超过它：拒绝写入（没有检查点的覆盖无法撤销）。 */
export const CHECKPOINT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const CHECKPOINT_QUOTA_DEFAULT_BYTES = 1024 * 1024 * 1024;
/** = 2 × 单文件上限：再小就连两个大文件的改动都留不住。 */
export const CHECKPOINT_QUOTA_MIN_BYTES = 128 * 1024 * 1024;
export const CHECKPOINT_QUOTA_MAX_BYTES = 64 * 1024 * 1024 * 1024;
export const CHECKPOINT_RETENTION_DAYS = 30;
/** 与 files.read 的预览上限相同。 */
export const CHECKPOINT_DIFF_TEXT_MAX_BYTES = 256 * 1024;
/** 与 office_read 的解析上限相同。 */
export const CHECKPOINT_OFFICE_DIFF_MAX_BYTES = 32 * 1024 * 1024;
export const CHECKPOINT_RESTORE_MAX_ITEMS = 200;
export const CHECKPOINT_LIST_MAX_ROWS = 1000;
export const CHECKPOINT_RESTORE_LOCK_WAIT_MS = 10_000;
/** settings 表的键。 */
export const CHECKPOINT_QUOTA_KEY = 'checkpoints.quotaBytes';
/** settings 表的键：第一次带检查点启动的引擎代次。早于它的工具执行是不带检查点的引擎做的。 */
export const CHECKPOINT_SINCE_EPOCH_KEY = 'checkpoints.sinceEpoch';

/** pending：写前状态已存、目标文件还没确认替换。applied：替换完成。aborted：没有替换（目标确认未动）。
 *  restored：已恢复到写入前。unknown：中断后文件既不是写入前、也不是写入后的内容。 */
export type CheckpointState = 'pending' | 'applied' | 'aborted' | 'restored' | 'unknown';

/** 文件的一个版本，按内容寻址。exists=false 是「不存在」这个版本。 */
export interface FileVersion { exists: boolean; hash?: string; size?: number }

export interface FileChangeView {
  id: string; seq: number; sessionId: string;
  /** 关联运行账本：runId = agent_runs.id，executionId = tool_executions.id。不带账本的调用没有。 */
  runId?: string; executionId?: string; toolUseId?: string; toolName: string;
  /** 同一次工具执行里的第几个文件（从 0 起）。 */
  ordinal: number;
  /** path：写入时的真实路径（磁盘上当时的大小写）；恢复完成后更新成恢复那一刻的真实路径（只可能差在大小写）。
   *  displayPath：在会话当前工作区内时是相对路径（正斜杠），否则是绝对路径。 */
  path: string; displayPath: string; pathKey: string;
  kind: 'create' | 'modify'; state: CheckpointState;
  before: FileVersion; after: FileVersion;
  /** 写入前 / 写入后的内容此刻是否还在检查点存储里。 */
  beforeStored: boolean; afterStored: boolean;
  createdAt: number; appliedAt?: number; restoredAt?: number; prunedAt?: number;
  abortReason?: string; detail?: string;
}

export interface RunChangeGroup {
  runId: string | null; generation?: number; startedAt?: number; runState?: string;
  changes: FileChangeView[];
  /** 这次运行里已启动、副作用范围未知的调用数：它们的改动不在记录范围内。 */
  uncovered: { shell: number; mcp: number; other: number };
}
export interface CheckpointUsage {
  usedBytes: number; blobCount: number; checkpointCount: number;
  quotaBytes: number; retentionDays: number; maxFileBytes: number;
  /** 受保护、不会被自动清理的字节数。大于 quotaBytes 时 overQuota 为真。 */
  protectedBytes: number; overQuota: boolean;
}
export interface ChangeList {
  groups: RunChangeGroup[];
  /** 不该再按工具入参列成「没有检查点的改动」的写调用：已有检查点记录的，加上由带检查点的引擎执行过的文件写入调用
   *  （后者没有记录 = 写入的内容与原文件相同，或没写成）。不受 groups 的条数上限限制。 */
  coveredToolUseIds: string[];
  truncated: boolean; usage: CheckpointUsage;
}

export type RestoreConflict =
  | 'modified' | 'missing' | 'replaced' | 'identity-changed' | 'superseded' | 'read-only' | 'hard-linked' | 'not-a-file'
  /** 文件在，但此刻读不了（被别的程序独占打开等），无从核对内容。 */
  | 'unreadable';
export type RestoreUnavailable =
  | 'pruned' | 'already-restored' | 'not-applied' | 'unknown-state' | 'blob-missing' | 'blob-corrupt' | 'run-active' | 'rule-blocked'
  /** 记录停在 pending 或「恢复中」，这次对账没能把它落定（库写不进等）。 */
  | 'unsettled'
  /** 这条记录所属的会话已删除（F11B；含「已在其他设备删除、本机留着副本」）。只会在恢复等锁期间会话被删时出现：
   *  进门时已删除的会话整次调用直接报「会话已删除」。 */
  | 'session-deleted';
export type RestoreVerdict =
  | { kind: 'ready'; action: 'overwrite' | 'delete' }
  | { kind: 'conflict'; reason: RestoreConflict; later?: { id: string; sessionId: string }[] }
  | { kind: 'unavailable'; reason: RestoreUnavailable };
export interface RestorePrecheck { id: string; path: string; verdict: RestoreVerdict; message: string }

export interface RestoreItemResult {
  id: string; path: string;
  outcome: 'restored' | 'deleted' | 'conflict' | 'unavailable' | 'busy' | 'failed';
  verdict?: RestoreVerdict; message: string;
}
/** 多文件恢复不是原子的：逐项结果就是事实，allRestored 只是把它们与起来。 */
export interface RestoreReport { items: RestoreItemResult[]; allRestored: boolean }

export interface DiffSide {
  exists: boolean; size?: number; hash?: string;
  /** blob：检查点存储；file：磁盘上当前文件；unavailable：内容已不在（被清理，或文件已被改动）。 */
  source: 'blob' | 'file' | 'none' | 'unavailable';
  /** text：UTF-8 文本原文。office-text：从 docx / xlsx / pptx 提取的文字，不是版式。binary：不给正文。 */
  form: 'text' | 'office-text' | 'binary' | 'none';
  text?: string; truncated?: boolean;
}
export interface ChangeDiff {
  change: FileChangeView; before: DiffSide; after: DiffSide; current: DiffSide;
  currentIs: 'after' | 'before' | 'other' | 'missing';
}

/** 「改动」页页脚与审阅面板底部的范围说明：哪些改动在记录里、哪些不在。 */
export const CHECKPOINT_SCOPE_NOTE =
  '只有内置的文件写入、文件编辑和 Office 文档生成会在这里留下可恢复的记录。'
  + 'shell 命令、MCP 工具、记忆写入、终端和其它程序做的改动不在记录里，不能在这里撤销；恢复也不会删除当时新建的目录。';

const UNAVAILABLE_TEXT: Record<RestoreUnavailable, string> = {
  'unsettled': '这条记录上一次写入或恢复被打断，状态还没有核实完。请稍后再试。',
  'pruned': '这次改动的检查点已按容量或保留期清理，不能恢复。',
  'already-restored': '这次改动已经恢复过了。',
  'not-applied': '这次写入没有生效，不需要恢复。',
  'unknown-state': '这次写入中途被打断，文件现在的内容既不是写入前的、也不是这次要写入的。没有自动处理；可以把写入前的版本另存出来。',
  'blob-missing': '检查点里保存的旧内容缺失，不能恢复。',
  'blob-corrupt': '检查点里保存的旧内容校验不一致，不能恢复。',
  'run-active': '这个会话正在运行。等它结束或先停止，再恢复。',
  'rule-blocked': '这个位置是 DeskMinis 的核心数据，不能通过恢复修改。',
  'session-deleted': '这个会话已删除，没有恢复，文件没有改动。如果它列在「设备」页的「已在其他设备删除」里，先在那里恢复会话。',
};

const CONFLICT_TEXT: Record<Exclude<RestoreConflict, 'superseded'>, string> = {
  'modified': '文件在这次改动之后又被修改过。恢复会盖掉那些修改，所以没有执行。可以把改动前的版本另存成一个新文件，再手动比对。',
  'missing': '文件已被移走或删除，没有可以恢复的对象。可以把改动前的版本另存成一个新文件。',
  'replaced': '这个位置上的文件已经换成了另一份内容相同的文件。为稳妥起见没有自动恢复，可以另存改动前的版本。',
  'identity-changed': '这个路径现在指向别的位置（链接或目录的指向变了）。恢复会改到另一份文件，所以没有执行。',
  'read-only': '文件现在是只读的，没有改动它。去掉只读属性后可以再试。',
  'hard-linked': '文件现在有多个硬链接，恢复会把链接拆开，所以没有执行。可以另存改动前的版本。',
  'not-a-file': '这个位置现在不是一个普通文件，没有改动它。',
  'unreadable': '文件现在读不了（可能正被其它程序独占打开），没法核对它的内容，所以没有恢复。关掉占用它的程序后再试。',
};

/**
 * 预检结论的一句话。viewSessionId：从哪个会话看这条记录——superseded 的 later 里有别的会话的记录时换一句
 * （那些要到那个会话去恢复，这里不能一起恢复）；不传按「都是本会话的」说。
 */
export function describeVerdict(v: RestoreVerdict, viewSessionId?: string): string {
  if (v.kind === 'ready') {
    return v.action === 'overwrite'
      ? '可以恢复：文件现在的内容与这次改动写入的一致。'
      : '可以恢复：这个文件是这次改动新建的，之后没有变过。恢复会删除它，删除前会把内容存进检查点，可以另存。';
  }
  if (v.kind === 'unavailable') return UNAVAILABLE_TEXT[v.reason];
  if (v.reason !== 'superseded') return CONFLICT_TEXT[v.reason];
  const later = v.later ?? [];
  const elsewhere = viewSessionId === undefined ? 0 : later.filter(x => x.sessionId !== viewSessionId).length;
  const n = Math.max(later.length, 1);
  if (elsewhere > 0) return `这个文件之后还有 ${n} 次改动，其中 ${elsewhere} 次是另一个会话做的。要先到那个会话恢复它们，这里不能一起恢复。`;
  return `这个文件之后还有 ${n} 次改动。要先恢复后面的改动，或连同它们一起恢复。`;
}
