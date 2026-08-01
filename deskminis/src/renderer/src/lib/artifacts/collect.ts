/** 产物收集（MU2b Task 3，设计 §4.1）：本会话写/编过的文件汇总。
 *  数据源：历史 messages parts 的 toolUse（file_write/file_edit）+ 实时 toolCards（input JSON）。
 *  同路径去重（edit 优先）；edit 增删数 = extractEditPair + diffLines + countAddDel（Task 7 成果复用）。
 *  路径相对化经 relativizePath（guest /var/minis/<bucket>/ 与 host sessions/<sid>/<bucket>/ 双前缀）。 */
import { extractEditPair, relativizePath } from '../diff/payload';
import { diffLines, countAddDel } from '../diff/lcs';

export interface Artifact {
  path: string;
  kind: 'write' | 'edit';
  add?: number;
  del?: number;
}

/** 与 chat store UiMessage 对齐的最小契约：parts[].value = { name, input }（toolUse part）。 */
interface MsgLike { parts?: unknown }
/** 与 chat store toolCards 对齐的最小契约。 */
interface ToolCardLike { name: string; input?: string }

/** file_write input JSON → 相对路径（坏 JSON/缺 path → null）。 */
function writePath(inputJson: string | undefined): string | null {
  if (!inputJson) return null;
  try {
    const o = JSON.parse(inputJson) as Record<string, unknown> | null;
    return typeof o?.path === 'string' ? relativizePath(o.path) : null;
  } catch { return null; }
}

export function collectArtifacts(messages: MsgLike[], toolCards: ToolCardLike[]): Artifact[] {
  const byPath = new Map<string, Artifact>();
  const push = (path: string | null, kind: 'write' | 'edit', add?: number, del?: number): void => {
    if (!path) return;
    const prev = byPath.get(path);
    if (prev?.kind === 'edit' && kind === 'write') return; // edit 优先：write 不覆盖 edit（保增删数）
    byPath.set(path, { path, kind, add, del });
  };
  const scan = (name: string, input: string | undefined): void => {
    if (name === 'file_write') {
      push(writePath(input), 'write');
    } else if (name === 'file_edit') {
      const pair = extractEditPair(input);
      if (pair) {
        const { add, del } = countAddDel(diffLines(pair.oldStr, pair.newStr));
        push(pair.path, 'edit', add, del);
      }
    }
  };
  for (const m of messages ?? []) {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    for (const p of parts) {
      const v = (p as { type?: string; value?: { name?: unknown; input?: unknown } } | null)?.value;
      if ((p as { type?: string } | null)?.type === 'toolUse' && v && typeof v.name === 'string') {
        scan(v.name, typeof v.input === 'string' ? v.input : undefined);
      }
    }
  }
  for (const c of toolCards ?? []) scan(c.name, c.input);
  return [...byPath.values()];
}
