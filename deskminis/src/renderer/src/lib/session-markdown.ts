/** W10：已落库会话的Markdown导出；回合、工具状态、正文和用时沿用界面口径。 */
import { isResultCarrier, stepStatus, toolResultsById } from './steps/status';
import { turnMarkdown } from './turn-text';
import { formatDuration } from './time/duration';

type Message = { role?: unknown; createdAt?: unknown; parts?: unknown };
type Block = { kind: 'text'; text: string } | { kind: 'steps'; lines: string[] };
interface Turn { user: Message | null; endedAt?: unknown; blocks: Block[] }
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const pad = (n: number): string => String(n).padStart(2, '0');
function localMinute(date: Date): string {
  return Number.isFinite(date.getTime()) ? date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) : '';
}
function partsOf(m: Message): { type?: unknown; value?: unknown }[] { return Array.isArray(m.parts) ? m.parts : []; }
function titleOf(value: Record<string, unknown>): string {
  const raw = typeof value.input === 'string' ? value.input : isRec(value.input) ? JSON.stringify(value.input) : '';
  try {
    const input: unknown = JSON.parse(raw || '{}');
    if (isRec(input) && typeof input.tool_title === 'string' && input.tool_title) return input.tool_title;
  } catch { /* 历史坏载荷与界面一样回落工具名。 */ }
  return String(value.name ?? '');
}

export function sessionMarkdown(messages: readonly Message[], title: string, exportedAt: Date): string {
  const out = ['# ' + (title || '新会话'), '> 由 DeskMinis 导出 · ' + localMinute(exportedAt)];
  if (!messages.length) return (out.concat('（这个会话还没有消息）').join('\n\n') + '\n').replace(/\r\n?/g, '\n');
  const results = toolResultsById(messages), turns: Turn[] = [];
  const labels = { ok: '成功', failed: '失败', interrupted: '已中断', pending: '已中断' };
  for (const m of messages) {
    if (m.role === 'user' && !isResultCarrier(m)) { turns.push({ user: m, blocks: [] }); continue; }
    if (turns.length) turns[turns.length - 1].endedAt = m.createdAt;
    if (m.role !== 'assistant') continue;
    if (!turns.length) turns.push({ user: null, blocks: [] });
    const turn = turns[turns.length - 1];
    for (const p of partsOf(m)) {
      if (p?.type === 'text' && typeof p.value === 'string' && p.value) turn.blocks.push({ kind: 'text', text: p.value });
      else if (p?.type === 'toolUse' && isRec(p.value)) {
        const result = typeof p.value.toolUseId === 'string' ? results.get(p.value.toolUseId) : undefined;
        const line = '- 工具：' + titleOf(p.value).replace(/[\r\n]+/g, ' ') + '（' + labels[stepStatus(result, false)] + '）';
        const last = turn.blocks[turn.blocks.length - 1];
        if (last?.kind === 'steps') last.lines.push(line); else turn.blocks.push({ kind: 'steps', lines: [line] });
      }
    }
  }
  for (const turn of turns) {
    if (turn.user) {
      const time = typeof turn.user.createdAt === 'number' ? localMinute(new Date(turn.user.createdAt * 1000)) : '';
      out.push('## 你' + (time ? ' · ' + time : ''));
      const parts = partsOf(turn.user), first = parts.find(p => p?.type === 'text');
      if (typeof first?.value === 'string' && first.value) out.push(first.value);
      const attachments = parts.flatMap(p => {
        if (p?.type !== 'mediaRef' || !isRec(p.value) || typeof p.value.relativePath !== 'string' || !p.value.relativePath) return [];
        return [typeof p.value.originalFileName === 'string' && p.value.originalFileName ? p.value.originalFileName : p.value.relativePath.split(/[\\/]/).pop() ?? p.value.relativePath];
      });
      if (attachments.length) out.push('附件：' + attachments.join('、'));
    }
    if (!turn.blocks.length) continue;
    const duration = typeof turn.user?.createdAt === 'number' && typeof turn.endedAt === 'number' ? formatDuration(turn.endedAt - turn.user.createdAt) : '';
    out.push('## DeskMinis' + (duration ? ' · 用时 ' + duration : ''));
    for (const block of turn.blocks) out.push(block.kind === 'text' ? turnMarkdown([block]) : block.lines.join('\n'));
  }
  return (out.join('\n\n') + '\n').replace(/\r\n?/g, '\n');
}
