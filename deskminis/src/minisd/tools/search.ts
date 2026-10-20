import { readdirSync, lstatSync, type Dirent, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolExecutor, ToolOutcome } from './types';
import { guardRead, guestPathClaims } from './files';
import { dataRootSkipRule, type SkipRule } from './data-gate';
import { grepInWorker, GREP_LIMITS } from './grep-scan';
import { walkDirAsync, walkDirSync, WALK_ENTRY_LIMIT, type WalkDirResult } from './walk-scan';

const TOOL_TITLE = { type: 'string' as const, description: '这次调用的 5-10 字用户语言摘要' };

// file_list 单层清单上限：一屏塞不下也读不完的清单只会淹没模型，500 条足够判断目录结构
const LIST_MAX = 500;
// file_glob 匹配结果上限：超出说明模式太宽，截断提示让模型自己收窄
const GLOB_MATCH_LIMIT = 1000;
// file_grep 的防线：文件大小、二进制嗅探、单行扫描与展示、匹配条数、输出体积几项上限在 grep-scan.ts 的 GREP_LIMITS（扫描在 worker 里跑，W3-sec2）；
// 这里留匹配条数（尾注要用）与时间预算——到时 terminate worker，灾难性回溯也停得下来
const GREP_MATCH_LIMIT = GREP_LIMITS.maxMatches;
const GREP_TIME_BUDGET_MS = 10000;

/** glob → RegExp。只支持 ** * ? 三种元字符的保守子集——宁缺勿歧义：
 *  {}[]() 这类语法的隐式规则（转义、优先级）最容易让模型写出「自以为」的模式然后怪工具不准。
 *  不支持的语法直接抛错，由调用方转成 success:false 的工具结果。 */
export function globToRegExp(pattern: string): RegExp {
  // Windows 反斜杠归一成 /：让 a\b.ts 与 a/b.ts 同义（匹配目标路径也统一归一为正斜杠形式）
  const p = pattern.replace(/\\/g, '/');
  let out = '^';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        while (p[i] === '*') i++; // 连续 * 归并为一个 **
        // `**/` 也匹配零层目录：**/*.ts 能命中基准下的 a.ts（与主流 glob 语义一致）
        if (p[i] === '/') { i++; out += '(?:[^/]+/)*'; }
        else out += '.*'; // 段尾 ** 跨任意字符（含 /）
      } else {
        i++;
        out += '[^/]*'; // * 只在单段内，不跨 /
      }
    } else if (c === '?') {
      i++;
      out += '[^/]';
    } else if (c === '{' || c === '}' || c === '[' || c === ']' || c === '(' || c === ')') {
      throw new Error(`不支持的通配符语法: ${c}（file_glob/file_grep 的 glob 只支持 ** * ? 三种元字符）`);
    } else {
      out += c.replace(/[.*+?^$|\\]/g, '\\$&'); // 其余字符一律按字面量转义
      i++;
    }
  }
  return new RegExp(out + '$');
}

export interface WalkDirOptions {
  entryLimit?: number;
  signal?: AbortSignal;
  /** 返回 true 的目录（相对 base 的正斜杠路径）整棵不进、也不列入结果。
   *  W1b-2：基准是数据根的祖先时用来跳过数据根（见 data-gate.ts 的 dataRootSkipper）。 */
  skipDir?: (rel: string) => boolean;
}
export type { WalkDirResult };

/** 递归遍历 base 的同步入口（遍历本体与安全前提见 walk-scan.ts 的 walkTree）。
 *  Q15：file_glob / file_grep 不再调它——同步遍历会占住引擎的事件循环，它们走 walkDirAsync，跑的是同一个 walkTree。 */
export function walkDir(base: string, opts: WalkDirOptions = {}): WalkDirResult {
  return walkDirSync(base, opts);
}

/** 跳过数据根时的尾注：告诉模型结果里少了一块、少的是什么，免得它以为那里真的没有匹配。 */
function skippedNote(skipped: string[]): string[] {
  return skipped.length === 0 ? [] : [`[已跳过 DeskMinis 数据目录：${skipped.join('、')}]`];
}

/** file_list/file_glob/file_grep 的公共闸：解析基准 → 权限判定（仅基准一次）→ 取消复查 → 确认是目录。
 *  只对基准判一次权限：遍历由 walkDir 保证不越出基准（lstat + 链接不进入），
 *  逐文件再卡既拖慢搜索也无安全增益。
 *  W1b-2：基准判定本身走 guardRead（数据根规则优先）；数据根落在基准之内时（工作区绑到用户主目录这类），
 *  再给出跳过规则让递归遍历跳过数据根——否则一次免审的搜索会顺带读到 servers.json 与其它会话的文件。
 *  file_list 只列一层、不读内容，数据根最多以一个目录名出现，不需要跳。 */
async function resolveBaseDir(guestPath: string, ctx: ToolContext, toolTitle: string): Promise<{ abs: string; skip?: SkipRule } | { fail: ToolOutcome }> {
  const abs = ctx.paths.resolveGuestPath(ctx.sessionId, guestPath);
  const denied = await guardRead(abs, ctx, toolTitle);
  if (denied) return { fail: { output: denied, success: false } };
  // 权限等待可长达 90 秒；等待期间的取消不会补发 abort 事件（已 abort 的 signal 挂监听不触发），
  // 必须在闸后重查一次——否则「批准晚于取消」的搜索会照常执行（同 files.ts）
  if (ctx.signal?.aborted) return { fail: { output: '[已取消]', success: false } };
  let st: Stats;
  try { st = lstatSync(abs); } catch { return { fail: { output: `路径不存在: ${abs}`, success: false } }; }
  if (!st.isDirectory()) return { fail: { output: `不是目录: ${abs}`, success: false } };
  return { abs, skip: dataRootSkipRule(abs, ctx.paths.root) };
}

/** file_glob / file_grep 的遍历：不占住引擎的事件循环（Q15；大目录放在 worker 里走，见 walk-scan.ts），遍历中途点停止立即返回 [已取消]。 */
async function walkBase(base: { abs: string; skip?: SkipRule }, ctx: ToolContext, tool: string): Promise<WalkDirResult | { fail: ToolOutcome }> {
  let walked;
  try { walked = await walkDirAsync(base.abs, { signal: ctx.signal, skip: base.skip }); }
  catch (e) { return { fail: { output: `${tool} 遍历失败: ${e instanceof Error ? e.message : String(e)}`, success: false } }; }
  // 遍历被取消时 signal 一定已经是 aborted；遍历刚走完、还没用上就点了停止的，也在这里拦下
  if (ctx.signal?.aborted) return { fail: { output: '[已取消]', success: false } };
  return walked;
}

export const fileListTool: ToolExecutor = {
  definition: {
    name: 'file_list',
    description: '列出目录的单层内容（不递归，递归查找用 file_glob）。目录行以 / 结尾，文件行以制表符带字节数。',
    parameters: {
      path: { type: 'string', description: '目录路径（工作区相对路径、/var/minis/* 或绝对路径）' },
      tool_title: TOOL_TITLE,
    },
    required: ['path', 'tool_title'],
  },
  // F04：读这个目录（整棵子树）。同会话里往它下面写的调用会改变清单，要按顺序排
  scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none', resources: guestPathClaims('read') },
  async execute(input, ctx) {
    // 已取消：纯读操作没有副作用，但 abort 后再扫只会产出没人消费的结果
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    const base = await resolveBaseDir(String(input.path), ctx, String(input.tool_title));
    if ('fail' in base) return base.fail;
    let entries: Dirent[];
    try { entries = readdirSync(base.abs, { withFileTypes: true }); } catch (e) { return { output: `无法读取目录: ${String(e)}`, success: false }; }
    // 按 UTF-16 码元排（与默认的 sort() 相同），不用本地化排序。
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const dirLines: string[] = [];
    const files: { name: string; stat?: Stats }[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) { dirLines.push(`${entry.name}/`); continue; }
      if (entry.isFile()) { files.push({ name: entry.name }); continue; }
      // 链接与未知类型照旧 lstat：链接条目按链接本体计（不跟目标）——列目录不该顺带触发或探测链接目标；
      // 云目录的重解析点在 readdir 里也报成链接，lstat 才认得出它是目录。
      let st: Stats;
      try { st = lstatSync(join(base.abs, entry.name)); } catch { continue; }
      if (st.isDirectory()) dirLines.push(`${entry.name}/`);
      else files.push({ name: entry.name, stat: st });
    }
    // 目录在前、各自按名排序：模型最常先看子目录定位结构，再去挑文件
    const shown = dirLines.slice(0, LIST_MAX);
    let total = dirLines.length + files.length;
    for (const file of files) {
      if (shown.length >= LIST_MAX) break;
      let st = file.stat;
      try { st ??= lstatSync(join(base.abs, file.name)); } catch { total--; continue; }
      shown.push(`${file.name}\t${st.size}`);
    }
    // 窗口外的普通文件不再 lstat；枚举后被并发删除的仍计入总数。
    if (total > LIST_MAX) shown.push(`[已截断: 共 ${total} 项]`);
    return { output: shown.join('\n'), success: true };
  },
};

export const fileGlobTool: ToolExecutor = {
  definition: {
    name: 'file_glob',
    description: '按通配符递归查找路径，返回相对基准目录的正斜杠路径。只支持 **（跨层）、*（单层内）、?（单字符）。',
    parameters: {
      pattern: { type: 'string', description: '通配符模式，如 **/*.ts、docs/*.md' },
      path: { type: 'string', description: '基准目录（可选，默认工作区根）' },
      tool_title: TOOL_TITLE,
    },
    required: ['pattern', 'tool_title'],
  },
  // F04：path 可省，缺省 '.'——与下面 execute 里的 String(input.path ?? '.') 同一个表达式
  scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none', resources: guestPathClaims('read', '.') },
  async execute(input, ctx) {
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    let re: RegExp;
    try { re = globToRegExp(String(input.pattern)); }
    catch (e) { return { output: e instanceof Error ? e.message : String(e), success: false }; }
    const base = await resolveBaseDir(String(input.path ?? '.'), ctx, String(input.tool_title));
    if ('fail' in base) return base.fail;
    const walked = await walkBase(base, ctx, 'file_glob');
    if ('fail' in walked) return walked.fail;
    const { files, dirs, hitLimit, skipped } = walked;
    const matched = [...files, ...dirs].filter(p => re.test(p)).sort();
    const lines = matched.slice(0, GLOB_MATCH_LIMIT);
    if (matched.length > GLOB_MATCH_LIMIT) lines.push(`[已截断: 共 ${matched.length} 条匹配]`);
    if (hitLimit) lines.push(`[已截断: 遍历条目达上限 ${WALK_ENTRY_LIMIT}，结果可能不全]`);
    if (lines.length === 0) lines.push('没有匹配的路径');
    return { output: [...lines, ...skippedNote(skipped)].join('\n'), success: true };
  },
};

export const fileGrepTool: ToolExecutor = {
  definition: {
    name: 'file_grep',
    description: '在目录下逐文件逐行做正则搜索，输出 相对路径:行号:行内容。跳过二进制与超 1MB 文件。',
    parameters: {
      pattern: { type: 'string', description: 'JS 正则表达式（语法错误会直接返回错误）' },
      path: { type: 'string', description: '基准目录（可选，默认工作区根）' },
      glob: { type: 'string', description: '文件名通配符过滤（可选，如 *.ts；只支持 ** * ?）' },
      ignore_case: { type: 'boolean', description: '忽略大小写（可选）' },
      tool_title: TOOL_TITLE,
    },
    required: ['pattern', 'tool_title'],
  },
  scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none', resources: guestPathClaims('read', '.') },
  async execute(input, ctx) {
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    // 语法先在这里核一遍：错误信息照旧直接交回，不必起 worker
    try { new RegExp(String(input.pattern), input.ignore_case === true ? 'i' : ''); }
    catch (e) { return { output: `正则表达式无效: ${String(e)}`, success: false }; }
    let nameRe: RegExp | undefined;
    const globRaw = input.glob;
    if (globRaw !== undefined && globRaw !== null && String(globRaw) !== '') {
      try { nameRe = globToRegExp(String(globRaw)); }
      catch (e) { return { output: e instanceof Error ? e.message : String(e), success: false }; }
    }
    const base = await resolveBaseDir(String(input.path ?? '.'), ctx, String(input.tool_title));
    if ('fail' in base) return base.fail;
    const walked = await walkBase(base, ctx, 'file_grep');
    if ('fail' in walked) return walked.fail;
    const { files, hitLimit, skipped } = walked;

    // 不调用 ctx.onFileRead：三件套不返回完整文件内容（清单/路径/匹配行），
    // 不构成 file_read 那种「读了某文件」的语义，技能 use_count 追踪不适用。

    // glob 过滤的是文件名（basename）：`**/*.ts` 这类模式对 basename 依旧成立（**/ 可匹配零层）
    const targets = nameRe ? files.filter(rel => nameRe!.test(rel.slice(rel.lastIndexOf('/') + 1))) : files;
    // 逐行匹配放进可终止的 worker（W3-sec2）：调用方给的正则遇上灾难性回溯，以前会卡死整个引擎
    let scanned;
    try {
      scanned = await grepInWorker(
        { base: base.abs, files: targets, pattern: String(input.pattern), flags: input.ignore_case === true ? 'i' : '' },
        { budgetMs: GREP_TIME_BUDGET_MS, signal: ctx.signal },
      );
    } catch (e) {
      return { output: `file_grep 扫描失败: ${e instanceof Error ? e.message : String(e)}`, success: false };
    }
    if (scanned.aborted) return { output: '[已取消]', success: false };
    const { rows, skippedBig, skippedBin, cappedMatches, cappedOutput, timedOut } = scanned;
    const notes: string[] = [];

    if (skippedBig > 0) notes.push(`[已跳过 ${skippedBig} 个大于 1MB 的文件]`);
    if (skippedBin > 0) notes.push(`[已跳过 ${skippedBin} 个二进制文件]`);
    if (cappedMatches) notes.push(`[已达 ${GREP_MATCH_LIMIT} 条匹配上限，结果被截断]`);
    if (timedOut) notes.push(`[已达 ${GREP_TIME_BUDGET_MS / 1000} 秒时间预算，返回部分结果；正则回溯太慢时会在这里被终止，可以换个更简单的写法]`);
    if (cappedOutput) notes.push('[输出超过 100KB 被截断]');
    if (hitLimit) notes.push(`[已截断: 遍历条目达上限 ${WALK_ENTRY_LIMIT}，结果可能不全]`);
    notes.push(...skippedNote(skipped));
    const body = rows.length === 0 ? ['未找到匹配内容'] : rows;
    return { output: [...body, ...notes].join('\n'), success: true };
  },
};
