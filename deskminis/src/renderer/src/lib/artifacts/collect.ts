/** 产物收集（MU2b Task 3，设计 §4.1）：本会话写/编过的文件汇总。
 *  数据源：历史 messages parts 的 toolUse（file_write/file_edit/office_write）+ 实时 toolCards（input JSON）。
 *  同路径去重（edit 优先）；edit 增删数 = extractEditPair + diffLines + countAddDel（Task 7 成果复用）。
 *  路径相对化经 relativizePath（guest /var/minis/<bucket>/ 与 host sessions/<sid>/<bucket>/ 双前缀）。
 *
 *  W2b-11d：按工具结果判，不再只看调用本身。原先失败的、历史回合里中断没有结果的写工具也列成改动，file_edit 还带着增删数——
 *  与 W2b-11a 修掉的「没结果的工具显示成功」是同一类界面假话。每一步的状态与对话流（StageChat）用同一套判据：
 *  配结果 toolResultsById、定状态 stepStatus、最后一个回合从哪条算起 lastTurnStart（lib/steps/status），
 *  「最后一个回合还在不在跑」由调用方经 lib/steps/live 的 useLastTurnLive 传进来。
 *  - 成功（ok，含老库里没有 success 字段的结果）：照旧列；
 *  - 失败（failed）：不列——没写成，列出来就等于说它改了；
 *  - 已中断 · 结果未知（interrupted：没有结果、所在回合已不在跑）：不列。可能写了也可能没写，
 *    对话流里那一步标着「已中断 · 结果未知」，照实交代了；「改动」只列确知做了的（设计稿 §4.1 W2b-11d）；
 *  - 结果还没到（pending：所在回合还在跑）：照旧列，回合跑到一半就该看得见（V8），结果到了再按上面几条判。 */
import { extractEditPair, relativizePath } from '../diff/payload';
import { diffLines, countAddDel } from '../diff/lcs';
import { lastTurnStart, stepStatus, toolResultsById, type StepStatus } from '../steps/status';

export interface Artifact {
  path: string;
  kind: 'write' | 'edit';
  add?: number;
  del?: number;
}

/** 与 chat store UiMessage 对齐的最小契约：parts[].value = { toolUseId, name, input }（toolUse part）/ { toolUseId, success }（toolResult part）；
 *  role 用来切回合（结果载体不开新回合，见 lastTurnStart）。 */
interface MsgLike { role?: unknown; parts?: unknown }
/** 与 chat store toolCards 对齐的最小契约：success 在 toolEnd 时才有，没到是 undefined。 */
interface ToolCardLike { name: string; input?: string; success?: boolean }

/** 算作改动的步骤状态：确知做了的（ok）与结果还没到的（pending）。写成白名单：以后状态多出一种，默认不当成改动。 */
const LISTED: ReadonlySet<StepStatus> = new Set<StepStatus>(['ok', 'pending']);

/** file_write input JSON → 相对路径（坏 JSON/缺 path → null）。 */
function writePath(inputJson: string | undefined): string | null {
  if (!inputJson) return null;
  try {
    const o = JSON.parse(inputJson) as Record<string, unknown> | null;
    return typeof o?.path === 'string' ? relativizePath(o.path) : null;
  } catch { return null; }
}

/** lastTurnLive：messages 里最后一个回合是不是还在跑——调用方用 useLastTurnLive 取，与 StageChat 同一份判定。 */
export function collectArtifacts(messages: MsgLike[], toolCards: ToolCardLike[], lastTurnLive: boolean): Artifact[] {
  const byPath = new Map<string, Artifact>();
  const push = (path: string | null, kind: 'write' | 'edit', add?: number, del?: number): void => {
    if (!path) return;
    const prev = byPath.get(path);
    if (prev?.kind === 'edit' && kind === 'write') return; // edit 优先：write 不覆盖 edit（保增删数）
    byPath.set(path, { path, kind, add, del });
  };
  const scan = (name: string, input: string | undefined): void => {
    // office_write（U 波）与 file_write 同形：都是「整份写出去」，input.path 就是产物路径。
    // 不认它的话，agent 做的 docx/xlsx/pptx 在产物清单里凭空消失。
    if (name === 'file_write' || name === 'office_write') {
      push(writePath(input), 'write');
    } else if (name === 'file_edit') {
      const pair = extractEditPair(input);
      if (pair) {
        const { add, del } = countAddDel(diffLines(pair.oldStr, pair.newStr));
        push(pair.path, 'edit', add, del);
      }
    }
  };
  const list = messages ?? [];
  const results = toolResultsById(list);
  // 与 StageChat 的 turns 同一句：从这一条起是最后一个回合；它不在跑时取 Infinity，所有回合里没结果的步骤都判中断
  const liveFrom = lastTurnLive ? lastTurnStart(list) : Infinity;
  for (const [i, m] of list.entries()) {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    for (const p of parts) {
      const v = (p as { type?: string; value?: { toolUseId?: unknown; name?: unknown; input?: unknown } } | null)?.value;
      if ((p as { type?: string } | null)?.type === 'toolUse' && v && typeof v.name === 'string') {
        const r = typeof v.toolUseId === 'string' ? results.get(v.toolUseId) : undefined;
        if (LISTED.has(stepStatus(r, i >= liveFrom))) scan(v.name, typeof v.input === 'string' ? v.input : undefined);
      }
    }
  }
  // 实时卡片就是正在跑的那个回合的，与 StageChat 的 liveSteps 同一句：toolEnd 一定带 success，还是 undefined 就是结果没到，绝不判中断
  for (const c of toolCards ?? []) {
    if (LISTED.has(stepStatus(c.success === undefined ? undefined : c, true))) scan(c.name, c.input);
  }
  return [...byPath.values()];
}
