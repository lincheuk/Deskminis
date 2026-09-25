import { join } from 'node:path';
import { sanitizeLiteral } from '../agent/sanitize';

/**
 * 系统提示 <available_skills> 注入（设计 §5.1）：只给 名 + ≤200字描述 + SKILL.md 绝对路径，
 * 正文永不预载 —— 模型需要时自行 file_read（同时触发 use_count 计数）。
 * >20 个时分级披露：内置 > 7 天内更新(≤10) > use_count 高→低；溢出只列名，并提示用 file_grep / file_list 查找。
 *
 * M4 出口侧消毒：name/description 先 sanitizeLiteral（剥控制字符）再 esc（转 XML 实体）——两者不叠加。
 */

export interface PromptSkill {
  id: string; name: string; description: string;
  updatedAt: number; useCount: number; importSource: string;
}

const MAX_FULL = 20;
const MAX_DESC = 200;
const RECENT_WINDOW_S = 7 * 24 * 3600;
const MAX_RECENT = 10;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 描述压成单行并截断到 max 字（含省略号）。 */
function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

/** 分级：内置 > 7 天内更新（至多 10 个，新→旧）> 其余按 use_count 高→低；full 上限 20。 */
export function tierSkills(skills: PromptSkill[], nowEpoch: number): { full: PromptSkill[]; rest: PromptSkill[] } {
  const builtin = skills.filter(s => s.importSource === 'builtin');
  const recent = skills
    .filter(s => s.importSource !== 'builtin' && nowEpoch - s.updatedAt <= RECENT_WINDOW_S)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECENT);
  const picked = new Set([...builtin, ...recent].map(s => s.id));
  const byUse = skills
    .filter(s => !picked.has(s.id))
    .sort((a, b) => b.useCount - a.useCount || a.id.localeCompare(b.id));
  const full = [...builtin, ...recent, ...byUse].slice(0, MAX_FULL);
  const fullIds = new Set(full.map(s => s.id));
  return { full, rest: skills.filter(s => !fullIds.has(s.id)) };
}

/** 0 个技能返回空串；≤20 全量披露；>20 分级 + 溢出只列名，并提示用文件工具查找。 */
export function buildSkillsBlock(skills: PromptSkill[], skillsRoot: string, nowEpoch: number): string {
  if (skills.length === 0) return '';
  const { full, rest } = skills.length > MAX_FULL ? tierSkills(skills, nowEpoch) : { full: skills, rest: [] as PromptSkill[] };
  const lines: string[] = ['', '<available_skills>'];
  for (const s of full) {
    lines.push('<skill>');
    lines.push(`<name>${esc(sanitizeLiteral(s.name))}</name>`);
    if (s.description) lines.push(`<description>${esc(truncate(sanitizeLiteral(s.description), MAX_DESC))}</description>`);
    lines.push(`<path>${esc(join(skillsRoot, s.id, 'SKILL.md'))}</path>`);
    lines.push('</skill>');
  }
  if (rest.length > 0) {
    lines.push('<overflowed_skills>');
    for (const s of rest) lines.push(`<name>${esc(sanitizeLiteral(s.name))}</name>`);
    lines.push('</overflowed_skills>');
    // 只指给读 skills 目录免审的文件工具（W1b-2b）。以前叫模型 shell_execute ls "<skillsRoot>"：
    // 正式版的 skillsRoot 在 %APPDATA%\DeskMinis 下，W1b-2 起 shell 只读命令点到含 DeskMinis 的路径就回落 gated，
    // 默认档下照我们自己的提示找技能也要弹卡，与设计稿 §2「skills 读取免审」相悖。
    // file_grep / file_list / file_read 都经 guardRead → dataGate，skills/ 判免审；skillsRoot 是盘符绝对路径，resolveGuestPath 原样接受
    lines.push(`另有 ${rest.length} 个技能未展开：可用 file_grep 在 "${skillsRoot}" 下按关键字查找（path 填这个目录），或用 file_list 列出这个目录；命中后用 file_read 读取对应的 SKILL.md。这几个文件工具读技能目录不需要用户批准。`);
  }
  lines.push('</available_skills>');
  lines.push('以上是已安装技能的索引（正文不预载）。当任务匹配某个技能时，先用 file_read 读取其 SKILL.md 获取完整指令再执行。');
  return lines.join('\n');
}
