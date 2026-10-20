/**
 * F11A 附件 chip 的状态映射（纯函数，有单测；.vue 不过 typecheck，判断都放这里）。
 *
 * 每个附件有两个互相独立的结论：
 *   - 本机有没有文件（view.localAvailable）：决定 chip 能不能点开、要不要提示「模型看不到」；
 *   - 同步状态（view.state / reason）：决定小字、色调与动作按钮。
 * 文件在本机而这一份不同步时（本机文件被改过、同名冲突、本机超限、文件名过不了同步的规则），chip 仍然能打开。
 * 动作按钮只在动作有东西可做时给：canRetry / canCancel 由引擎按行的状态给出（还没有行的「等待同步」两者都没有，没有按钮）。
 */
import {
  ATTACHMENT_CONFLICT_TEXT, ATTACHMENT_STATE_TEXT, attachmentStateText,
  type AttachmentRetryResult, type AttachmentView,
} from '@shared/attachments';

export type ChipTone = 'ok' | 'wait' | 'warn' | 'err';
export type ChipAction = 'retry' | 'download' | 'cancel';
export interface AttachmentChip {
  tone: ChipTone;
  /** chip 上的小字；空串表示不显示。 */
  label: string;
  /** 悬停说明。 */
  title: string;
  /** 能不能点开预览：只看本机有没有文件。 */
  open: boolean;
  action?: ChipAction;
}

export const CHIP_ACTION_TEXT: Readonly<Record<ChipAction, string>> = Object.freeze({ retry: '重试', download: '下载', cancel: '取消' });

/** 没有 view（旧引擎，或状态还没取到）时 chip 与以前一样：没有小字，可以点。 */
export function chipOf(view: AttachmentView | undefined): AttachmentChip {
  if (!view) return { tone: 'ok', label: '', title: '', open: true };
  const open = view.localAvailable;
  if (view.state === 'ready') {
    return view.conflict
      ? { tone: 'warn', label: '', title: ATTACHMENT_CONFLICT_TEXT, open }
      : { tone: 'ok', label: '', title: '', open };
  }
  const text = attachmentStateText(view.state, view.reason);
  if (view.localAvailable) {
    // 文件就在本机，只是这一份不同步：整句换成 local/<原因>，或在原文案后面接一句「本机这一份可以打开」
    let label: string;
    if (view.reason === 'too_large' || view.reason === 'name_conflict' || view.reason === 'bad_reference') label = ATTACHMENT_STATE_TEXT[`local/${view.reason}`];
    else if (view.state === 'failed' && view.reason === 'local_changed') label = text;
    else label = `${text}${ATTACHMENT_STATE_TEXT['local/suffix']}`;
    const chip: AttachmentChip = { tone: 'warn', label, title: label, open };
    if (view.canRetry) chip.action = 'retry';
    return chip;
  }
  if (view.state === 'transferring') {
    const pct = view.size && view.size > 0 ? Math.min(99, Math.floor(((view.received ?? 0) / view.size) * 100)) : 0;
    const label = `${ATTACHMENT_STATE_TEXT.transferring} ${pct}%`;
    return { tone: 'wait', label, title: label, open, action: 'cancel' };
  }
  if (view.state === 'held') return { tone: 'wait', label: text, title: text, open, action: 'download' };
  const tone: ChipTone = view.state === 'failed' || view.state === 'unavailable' ? 'err' : 'wait';
  const chip: AttachmentChip = { tone, label: text, title: view.conflict ? `${text}。${ATTACHMENT_CONFLICT_TEXT}` : text, open };
  if (view.canRetry) chip.action = 'retry';
  else if (view.canCancel) chip.action = 'cancel';
  return chip;
}

/** attachments.retry 没有真的发起时给用户看的一句话；发起了返回空串。 */
export function retryNote(r: AttachmentRetryResult | undefined): string {
  if (!r || r.started) return '';
  if (r.reason === 'paused') return ATTACHMENT_STATE_TEXT.paused;
  if (r.reason === 'source_offline') return ATTACHMENT_STATE_TEXT['pending/source_offline'];
  if (r.reason === 'peer_unsupported') return ATTACHMENT_STATE_TEXT['unavailable/peer_unsupported'];
  return '';
}

/** attachments.read 的 base64 → 文本视图用的内容。前 8KB 里有 NUL 就当二进制，不进文本视图。 */
export function decodeAttachmentText(base64: string): { content: string; binary: boolean } {
  let bin: string;
  try { bin = atob(base64); } catch { return { content: '', binary: true }; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const head = bytes.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return { content: '', binary: true };
  return { content: new TextDecoder('utf-8').decode(bytes), binary: false };
}
