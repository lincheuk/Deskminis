/**
 * F11A 附件同步：minisd 与渲染端共用的名字校验、状态类型与状态文案。不含任何 I/O。
 *
 * 逻辑身份是 (sessionId, name)：name 是 mediaRef.relativePath 去掉 'attachments/' 之后的单层文件名。
 * 文件永远落在本机数据根的 sessions/<sid>/attachments/<name>，路径只由本机拼，对端给的字符串必须先过这里的校验。
 */

/** 会话 id 的形态（与 minisd/index.ts、main/attachments.ts 同款）。附件入口各自校验，不依赖 sync.push 的行为。 */
export const SESSION_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
/** guest 路径前缀：paths.resolveGuestPath 把它解析到会话附件桶，预览区据此走附件分支。 */
export const ATTACHMENT_GUEST_PREFIX = '/var/minis/attachments/';
/** mediaRef.relativePath 的前缀。 */
export const ATTACHMENT_REL_PREFIX = 'attachments/';

/** 单层文件名：ASCII 字母数字开头，之后只许字母数字与 . _ -，总长 1–128。 */
const ATTACHMENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Windows 保留设备名：第一个 '.' 之前的部分命中就拒（CON.png 在 Windows 上打开的是设备，不是文件）。 */
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 单层文件名校验。合规返回原串，否则 undefined。两端共用同一份：线上的名字、消息里的引用都过它。 */
export function validateAttachmentName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!ATTACHMENT_NAME_RE.test(raw)) return undefined;
  if (raw.includes('..')) return undefined;
  // 结尾的 '.' 在 Windows 上会被文件系统吞掉：'x.' 与 'x' 是同一个文件
  if (raw.endsWith('.')) return undefined;
  const stem = raw.split('.')[0];
  if (WINDOWS_DEVICE_RE.test(stem)) return undefined;
  return raw;
}

/** 'attachments/<合法名字>' → 名字；绝对路径、反斜杠、多层目录、空串、非字符串一律 undefined。 */
export function attachmentNameOf(relativePath: unknown): string | undefined {
  if (typeof relativePath !== 'string') return undefined;
  if (!relativePath.startsWith(ATTACHMENT_REL_PREFIX)) return undefined;
  return validateAttachmentName(relativePath.slice(ATTACHMENT_REL_PREFIX.length));
}

/** 本机附件桶里的单层文件名，比同步的名字规则宽：字符集相同，但可以用 . _ - 开头、含 '..'、长到 255。 */
const LOCAL_NAME_RE = /^[A-Za-z0-9._-]{1,255}$/;
/** 本机引用的前缀：不分大小写，与 chat.prompt 的白名单同一种比法（那条正则整条带 /i）。只给 localAttachmentNameOf 用。 */
const LOCAL_REL_PREFIX_RE = /^attachments\//i;

/**
 * chat.prompt 的附件白名单（minisd/index.ts 的 ATTACHMENT_REL_RE）比同步的名字规则宽：`_shot.png`、`a..b.png` 它照收。
 * 这类名字不同步（过不了 validateAttachmentName，不登记、不上线路），但文件就在本机附件桶里，请求构建按文件名读得到。
 * 这里只回答「它是不是桶里的一个单层文件名」，给状态显示与本机预览用，不用于任何与对端有关的判断。
 * 仍然不认：分隔符与盘符（字符集里没有）、全是点的名字（'.'、'..' 是目录）、结尾的点、Windows 保留设备名。
 */
export function localAttachmentName(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !LOCAL_NAME_RE.test(raw)) return undefined;
  if (/^\.+$/.test(raw) || raw.endsWith('.')) return undefined;
  if (WINDOWS_DEVICE_RE.test(raw.split('.')[0])) return undefined;
  return raw;
}

/**
 * 'attachments/<本机单层文件名>' → 文件名；其余形态（多层目录、反斜杠、绝对路径、非字符串）一律 undefined。
 * 前缀不分大小写：chat.prompt 的白名单整条带 /i，`Attachments/x.png` 它照收并原样写进 mediaRef.relativePath，
 * 请求构建按 basename 读的是桶里的 x.png——文件在本机、模型读得到，这里就得认。
 * 同步侧的 attachmentNameOf 仍只认全小写的前缀：这种引用照旧不登记、不上线路，对端那边是「引用的文件名不合规」。
 */
export function localAttachmentNameOf(relativePath: unknown): string | undefined {
  if (typeof relativePath !== 'string') return undefined;
  if (!LOCAL_REL_PREFIX_RE.test(relativePath)) return undefined;
  return localAttachmentName(relativePath.slice(ATTACHMENT_REL_PREFIX.length));
}

export type AttachmentState = 'ready' | 'transferring' | 'pending' | 'paused' | 'held' | 'failed' | 'unavailable';
export type AttachmentReason =
  | 'queued' | 'interrupted' | 'source_offline' | 'peer_paused'                    // pending
  | 'hash_mismatch' | 'bad_chunk' | 'io_error' | 'name_conflict' | 'local_changed'  // failed
  | 'peer_unsupported' | 'no_source' | 'too_large' | 'quota' | 'bad_reference';     // unavailable

/** attachments.status 的一项。 */
export interface AttachmentView {
  /** 逻辑名：会话附件桶内的文件名。引用不合规（bad_reference）时：文件就在本机桶里（localAvailable 为真）的是那个文件名，
   *  其余是 basename 截到 128 字符（只给显示用）。 */
  name: string;
  /** 与 mediaRef.relativePath 相同，界面用它对上 chip。 */
  relativePath: string;
  mimeType: string;
  originalFileName?: string;
  state: AttachmentState;
  reason?: AttachmentReason;
  size?: number;
  sha256?: string;
  /** state='transferring' 时已落盘的字节数。 */
  received?: number;
  /** 另有设备声明了同名但内容不同的文件。 */
  conflict: boolean;
  /** 本机附件桶里此刻有没有这个名字的普通文件。与 state 是两回事：行是 failed/local_changed、
   *  failed/name_conflict、本机超限的 too_large、名字不合规而文件在桶里的 bad_reference 时文件就在本机，
   *  模型请求读得到，用户也打得开。 */
  localAvailable: boolean;
  /** localAvailable 为真时给出：本机绝对路径（attachments.* 只许本机连接调用）。 */
  localPath?: string;
  canRetry: boolean;
  canCancel: boolean;
}

export interface AttachmentStatusResult { sessionId: string; syncPaused: boolean; items: AttachmentView[] }

export interface AttachmentReadResult {
  name: string;
  mimeType: string;
  size: number;
  localPath: string;
  /** 文件不超过 8 MiB 时带全文。 */
  base64?: string;
}

export interface AttachmentRetryResult { ok: true; started: boolean; reason?: 'paused' | 'source_offline' | 'peer_unsupported' }

/**
 * 状态文案，界面与测试共用。键是 state 或 `${state}/${reason}`；
 * 另有 `local/${reason}`：文件就在本机、只是这一份不同步时用（chipOf 选用）。
 */
export const ATTACHMENT_STATE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'transferring': '传输中',
  'paused': '未同步：本机已暂停同步',
  'held': '未下载',
  'pending/queued': '等待同步',
  'pending/interrupted': '传输中断，会自动续传',
  'pending/source_offline': '未同步：没有已配对设备在线',
  'pending/peer_paused': '未同步：对方暂停了同步',
  'failed/hash_mismatch': '同步失败：内容校验不通过',
  'failed/bad_chunk': '同步失败：对方的应答不合规',
  'failed/io_error': '同步失败：写入本机磁盘出错',
  'failed/name_conflict': '同步失败：本机已有同名但内容不同的文件',
  'failed/local_changed': '本机文件在登记之后被改动，不再提供给其它设备',
  'unavailable/peer_unsupported': '不可用：对方的版本不支持附件同步',
  'unavailable/no_source': '不可用：在线的设备上没有这个文件',
  'unavailable/too_large': '不可用：超过 32 MB 上限',
  'unavailable/quota': '不可用：这个会话的附件已到上限',
  'unavailable/bad_reference': '不可用：引用的文件名不合规',
  'local/too_large': '本机可用；超过 32 MB 上限，不同步到其它设备',
  'local/name_conflict': '本机可用；另一台设备上有同名但内容不同的附件，那一份没有同步过来',
  'local/bad_reference': '本机可用；文件名不合规，不同步到其它设备',
  'local/suffix': '（本机这一份可以打开）',
});

/** 冲突标记的说明（chip 的 title）。 */
export const ATTACHMENT_CONFLICT_TEXT = '另一台设备上有同名但内容不同的附件；这里显示的是本机这一份';
/** 回合里有本机没有的附件时，chip 行下方的一句提示。 */
export const ATTACHMENT_MODEL_HINT = '未同步到本机的附件，模型暂时看不到';

/** 取一项状态的文案键对应的文字；没有对应键时退回 state 自己的文案或空串。 */
export function attachmentStateText(state: AttachmentState, reason?: AttachmentReason): string {
  if (reason !== undefined) {
    const t = ATTACHMENT_STATE_TEXT[`${state}/${reason}`];
    if (t !== undefined) return t;
  }
  return ATTACHMENT_STATE_TEXT[state] ?? '';
}
