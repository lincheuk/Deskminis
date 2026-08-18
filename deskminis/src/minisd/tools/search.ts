import { readdirSync, lstatSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolExecutor, ToolOutcome } from './types';
import { guardRead } from './files';

const TOOL_TITLE = { type: 'string' as const, description: '这次调用的 5-10 字用户语言摘要' };

// file_list 单层清单上限：一屏塞不下也读不完的清单只会淹没模型，500 条足够判断目录结构
const LIST_MAX = 500;
// walkDir 访问条目硬上限：基准被指到超大目录（如整个用户盘）时不至于扫穿宿主
const WALK_ENTRY_LIMIT = 50000;
// file_glob 匹配结果上限：超出说明模式太宽，截断提示让模型自己收窄
const GLOB_MATCH_LIMIT = 1000;
// 以下均为 file_grep 的防线：复用 files.ts MAX_READ 的精神（1MB 以上交给 shell 分页），
// 二进制嗅探窗口、单行扫描上限（砍掉灾难回溯的输入面）、时间预算与输出体积上限
const GREP_MAX_FILE = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const LINE_SCAN_LIMIT = 10000;
const LINE_DISPLAY_LIMIT = 500;
const GREP_MATCH_LIMIT = 500;
const GREP_TIME_BUDGET_MS = 10000;
const OUTPUT_MAX = 100 * 1024; // 复用 shell 的 100KB 输出上限精神

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
}
export interface WalkDirResult {
  /** 相对 base 的正斜杠文件路径，按名排序 */
  files: string[];
  /** 相对 base 的正斜杠目录路径，按名排序（不含 base 自身） */
  dirs: string[];
  /** 是否因访问条目达硬上限提前停止（结果可能不全，调用方需注明） */
  hitLimit: boolean;
}

/** 递归遍历 base（文件与目录都收集，供 file_glob 匹配——`src/*` 这类模式天然要列出子目录）。
 *  「基准目录一次授权即覆盖全部遍历」的安全前提就在这里：
 *  - 一律 lstat，symlink/junction 目录绝不进入——跟随链接可越出已授权的工作区边界，也可能成环；
 *  - 指向文件的符号链接也整体排除——grep 若读它，目标可以指向基准之外，一次授权就盖不住了。 */
export function walkDir(base: string, opts: WalkDirOptions = {}): WalkDirResult {
  const entryLimit = opts.entryLimit ?? WALK_ENTRY_LIMIT;
  const files: string[] = [];
  const dirs: string[] = [];
  let visited = 0;
  let hitLimit = false;
  let aborted = false;
  // 显式栈而非递归：目录树深度不受调用栈限制；顺序无所谓，输出前统一排序
  const queue: { abs: string; rel: string }[] = [{ abs: base, rel: '' }];
  while (queue.length > 0) {
    const { abs, rel } = queue.pop()!;
    let names: string[];
    try { names = readdirSync(abs); } catch { continue; } // 读不了的目录（权限/占用）跳过，单个坏目录不毁整次遍历
    names.sort();
    for (const name of names) {
      // 每 200 个条目查一次取消：目录树可达数万条目，不查的话用户点停止后还要傻扫很久
      if (++visited % 200 === 0 && opts.signal?.aborted) { aborted = true; break; }
      if (visited > entryLimit) { hitLimit = true; break; }
      const childRel = rel ? `${rel}/${name}` : name;
      let st: Stats;
      try { st = lstatSync(join(abs, name)); } catch { continue; } // 遍历竞态中消失的条目跳过
      if (st.isSymbolicLink()) continue; // 见函数头安全注释：链接一律不进结果、不进入
      if (st.isDirectory()) {
        dirs.push(childRel);
        queue.push({ abs: join(abs, name), rel: childRel });
      } else if (st.isFile()) {
        files.push(childRel);
      }
    }
    if (aborted || hitLimit) break;
  }
  files.sort();
  dirs.sort();
  return { files, dirs, hitLimit };
}

/** file_list/file_glob/file_grep 的公共闸：解析基准 → 权限判定（仅基准一次）→ 取消复查 → 确认是目录。
 *  只对基准判一次权限：遍历由 walkDir 保证不越出基准（lstat + 链接不进入），
 *  逐文件再卡既拖慢搜索也无安全增益。 */
async function resolveBaseDir(guestPath: string, ctx: ToolContext, toolTitle: string): Promise<{ abs: string } | { fail: ToolOutcome }> {
  const abs = ctx.paths.resolveGuestPath(ctx.sessionId, guestPath);
  const denied = await guardRead(abs, ctx, toolTitle);
  if (denied) return { fail: { output: denied, success: false } };
  // 权限等待可长达 90 秒；等待期间的取消不会补发 abort 事件（已 abort 的 signal 挂监听不触发），
  // 必须在闸后重查一次——否则「批准晚于取消」的搜索会照常执行（同 files.ts）
  if (ctx.signal?.aborted) return { fail: { output: '[已取消]', success: false } };
  let st: Stats;
  try { st = lstatSync(abs); } catch { return { fail: { output: `路径不存在: ${abs}`, success: false } }; }
  if (!st.isDirectory()) return { fail: { output: `不是目录: ${abs}`, success: false } };
  return { abs };
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
  async execute(input, ctx) {
    // 已取消：纯读操作没有副作用，但 abort 后再扫只会产出没人消费的结果
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    const base = await resolveBaseDir(String(input.path), ctx, String(input.tool_title));
    if ('fail' in base) return base.fail;
    let names: string[];
    try { names = readdirSync(base.abs); } catch (e) { return { output: `无法读取目录: ${String(e)}`, success: false }; }
    names.sort();
    const dirLines: string[] = [];
    const fileLines: string[] = [];
    for (const name of names) {
      // lstat：链接条目按链接本体计（不跟目标）——列目录不该顺带触发或探测链接目标
      let st: Stats;
      try { st = lstatSync(join(base.abs, name)); } catch { continue; }
      if (st.isDirectory()) dirLines.push(`${name}/`);
      else fileLines.push(`${name}\t${st.size}`);
    }
    // 目录在前、各自按名排序：模型最常先看子目录定位结构，再去挑文件
    const lines = [...dirLines, ...fileLines];
    const total = lines.length;
    const shown = lines.slice(0, LIST_MAX);
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
  async execute(input, ctx) {
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    let re: RegExp;
    try { re = globToRegExp(String(input.pattern)); }
    catch (e) { return { output: e instanceof Error ? e.message : String(e), success: false }; }
    const base = await resolveBaseDir(String(input.path ?? '.'), ctx, String(input.tool_title));
    if ('fail' in base) return base.fail;
    const { files, dirs, hitLimit } = walkDir(base.abs, { signal: ctx.signal });
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    const matched = [...files, ...dirs].filter(p => re.test(p)).sort();
    const lines = matched.slice(0, GLOB_MATCH_LIMIT);
    if (matched.length > GLOB_MATCH_LIMIT) lines.push(`[已截断: 共 ${matched.length} 条匹配]`);
    if (hitLimit) lines.push(`[已截断: 遍历条目达上限 ${WALK_ENTRY_LIMIT}，结果可能不全]`);
    if (lines.length === 0) return { output: '没有匹配的路径', success: true };
    return { output: lines.join('\n'), success: true };
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
  async execute(input, ctx) {
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    let re: RegExp;
    try { re = new RegExp(String(input.pattern), input.ignore_case === true ? 'i' : ''); }
    catch (e) { return { output: `正则表达式无效: ${String(e)}`, success: false }; }
    let nameRe: RegExp | undefined;
    const globRaw = input.glob;
    if (globRaw !== undefined && globRaw !== null && String(globRaw) !== '') {
      try { nameRe = globToRegExp(String(globRaw)); }
      catch (e) { return { output: e instanceof Error ? e.message : String(e), success: false }; }
    }
    const base = await resolveBaseDir(String(input.path ?? '.'), ctx, String(input.tool_title));
    if ('fail' in base) return base.fail;
    const { files, hitLimit } = walkDir(base.abs, { signal: ctx.signal });
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };

    // 不调用 ctx.onFileRead：三件套不返回完整文件内容（清单/路径/匹配行），
    // 不构成 file_read 那种「读了某文件」的语义，技能 use_count 追踪不适用。

    const deadline = Date.now() + GREP_TIME_BUDGET_MS;
    const rows: string[] = [];
    let rowsLen = 0;
    const notes: string[] = [];
    let matches = 0, skippedBig = 0, skippedBin = 0;
    let cappedMatches = false, timedOut = false, cappedOutput = false;

    scan: for (let fi = 0; fi < files.length; fi++) {
      // 每 200 个文件查一次取消：数万文件的目录树不查会拖住「停止」按钮
      if (fi % 200 === 0 && ctx.signal?.aborted) return { output: '[已取消]', success: false };
      const rel = files[fi];
      // glob 过滤的是文件名（basename）：`**/*.ts` 这类模式对 basename 依旧成立（**/ 可匹配零层）
      if (nameRe && !nameRe.test(rel.slice(rel.lastIndexOf('/') + 1))) continue;
      let buf: Buffer;
      try {
        if (lstatSync(join(base.abs, rel)).size > GREP_MAX_FILE) { skippedBig++; continue; }
        buf = readFileSync(join(base.abs, rel));
      } catch { continue; } // 竞态消失/无权读的文件跳过
      // 前 8KB 含 \0 判二进制：合法 UTF-8 文本不含 \0，硬扫 exe/图片只会产出乱码匹配
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) { skippedBin++; continue; }
      const lines = buf.toString('utf8').split('\n');
      for (let li = 0; li < lines.length; li++) {
        let line = lines[li];
        if (line.endsWith('\r')) line = line.slice(0, -1); // CRLF 行尾的 \r 不属于内容
        // 单行只扫前 10000 字符：超长行（压缩 JS/base64）遇上回溯型正则会卡死整个搜索
        if (!re.test(line.slice(0, LINE_SCAN_LIMIT))) continue;
        matches++;
        const shown = line.length > LINE_DISPLAY_LIMIT ? line.slice(0, LINE_DISPLAY_LIMIT) : line;
        const row = `${rel}:${li + 1}:${shown}`;
        rows.push(row);
        rowsLen += row.length + 1;
        if (rowsLen > OUTPUT_MAX) { cappedOutput = true; break scan; }
        if (matches >= GREP_MATCH_LIMIT) { cappedMatches = true; break scan; }
      }
      if (Date.now() > deadline) { timedOut = true; break; }
    }

    if (skippedBig > 0) notes.push(`[已跳过 ${skippedBig} 个大于 1MB 的文件]`);
    if (skippedBin > 0) notes.push(`[已跳过 ${skippedBin} 个二进制文件]`);
    if (cappedMatches) notes.push(`[已达 ${GREP_MATCH_LIMIT} 条匹配上限，结果被截断]`);
    if (timedOut) notes.push(`[已达 ${GREP_TIME_BUDGET_MS / 1000} 秒时间预算，返回部分结果]`);
    if (cappedOutput) notes.push('[输出超过 100KB 被截断]');
    if (hitLimit) notes.push(`[已截断: 遍历条目达上限 ${WALK_ENTRY_LIMIT}，结果可能不全]`);
    const body = rows.length === 0 ? ['未找到匹配内容'] : rows;
    return { output: [...body, ...notes].join('\n'), success: true };
  },
};
