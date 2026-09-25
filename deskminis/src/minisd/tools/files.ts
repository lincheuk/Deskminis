import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PermissionRequest, PermPreview, ReadRange, ToolExecutor } from './types';
import { describeEditFailure, editUtf8Bytes } from './edit-text';
import { dataGate, type DataGateScope } from './data-gate';

const MAX_READ = 1024 * 1024; // 1MB

/**
 * 分段读取（W1b-2d · 止血设计稿 §4.1）时的文件大小上限。整读仍是 1MB：整读的内容一次全进结果，
 * 再大就是往上下文里硬塞；分段读每次只取 limit 个字符，上限只防「为取一小段把几百 MB 读进内存」。
 * 16MB 的文本解码后约 1600 万个码元，按上限 100000 一段段读也要 160 多次，再大的文件该交给 shell 按行取。
 */
export const MAX_READ_PAGED = 16 * 1024 * 1024;

/** 分段读取每段最多返回的字符数（UTF-16 码元）。硬上限，防一次把十几 MB 塞进结果；
 *  读回卸载文件时由 loop 的 clampReadBack 另行封顶到 READBACK_MAX。 */
export const FILE_READ_LIMIT_MAX = 100_000;

/** 读工作区文件时建议的每段长度。片段加末行注记超过卸载阈值（agent/offload.ts 的 20000）就会被 loop 卸载成桩，
 *  模型得再读一次卸载文件，一段拆成好几趟（W1b-2d 审查）；留出注记的余量。读回本会话的卸载文件不受此限。 */
export const FILE_READ_SUGGESTED_LIMIT = 19_000;

/** 权限预览体积防线：preview 随 permission.request 广播给前端，超长文件的全文差分没人看得完
 *  还会撑大广播与权限卡内存，统一截到上限并尾标「…[截断]」——用户能看出被截，差分统计以截断后文本为准。 */
const PREVIEW_MAX_CHARS = 20000;
function previewClamp(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  return text.slice(0, PREVIEW_MAX_CHARS) + '…[截断]';
}

const TOOL_TITLE = { type: 'string' as const, description: '这次调用的 5-10 字中文摘要，用于 UI 卡片' };

type GuardCtx = Parameters<ToolExecutor['execute']>[1];

/** dataGate 的判定范围：数据根、会话、该会话的实际工作目录（认每会话覆盖值）。 */
function gateScope(ctx: GuardCtx): DataGateScope {
  return { root: ctx.paths.root, sessionId: ctx.sessionId, workspace: ctx.paths.workspaceOf(ctx.sessionId) };
}

/** 写入的权限门（U4 起 office 工具复用同一道门——不给新工具开后门）。
 *  W1b-2 起先过 dataGate（tools/data-gate.ts）：核心数据与凭据直接拒绝、不进网关（'full' 档也照拒）；
 *  当前会话各桶、shared 与绑定工作区免审；应用配置、其它会话与其余应用数据走卡，并把一句说明放进 note。
 *  buildPreview 惰性构造：免审的写入（绝大多数）根本不过网关，提前读原文件构造差分纯属白读；
 *  只在确认要弹权限卡时才求值。 */
export async function guardWrite(absPath: string, ctx: GuardCtx, toolTitle: string, buildPreview?: () => PermPreview): Promise<string | undefined> {
  const gate = dataGate(absPath, gateScope(ctx), 'write');
  if (gate.verdict === 'deny') return gate.reason;
  if (gate.verdict === 'free') return undefined;
  const req: PermissionRequest = { kind: 'file-write', detail: absPath, sessionId: ctx.sessionId, toolTitle, preview: buildPreview?.() };
  // note 只在有说明时才带：数据根外的普通走卡请求与以前逐字段一致，广播与审计里不多出一个空的 note 键
  if (gate.note !== undefined) req.note = gate.note;
  const d = await ctx.permissions.check(req);
  // 先看取消、再看拒绝（W1b-5）：关停 / 删除会话时后台先按 deny 了结卡片、紧接着 abort，那不是用户拒绝的；
  // 写成「被用户拒绝」的话，重开会话时界面与模型都以为是用户点了拒绝。MCP 调用一直是这个顺序
  if (ctx.signal?.aborted) return '[已取消]';
  if (d === 'deny') return `写入被用户拒绝: ${absPath}（可在设置-权限中调整）`;
  return undefined;
}

/**
 * 读取的权限门：静默 shell 只读层已取消后，无门的 file_read 会成为静默外泄通道（~/.ssh/id_rsa、浏览器 cookie 库）。
 * W1b-2 起数据根内也用白名单：当前会话各桶、shared、skills、memory 免审，
 * minis.db、其它会话、MCP 配置、凭据与其余应用数据走卡带 note——旧注释点名 minis.db 是外泄通道，代码却对整个数据根免审。
 * 用户显式绑定为工作区的真实项目目录（workspaceOf）仍免询问：绑定动作本身就是授权语义，
 * 否则会话绑定项目后每个新文件路径都会触发一次权限确认，确认沦为噪音。
 * 未绑定会话时 workspaceOf 回落当前会话的沙箱桶，由数据根规则判为免审，行为不变。
 */
export async function guardRead(absPath: string, ctx: GuardCtx, toolTitle: string): Promise<string | undefined> {
  const gate = dataGate(absPath, gateScope(ctx), 'read');
  // 读取没有硬拒类（dataGate 只对写入给 deny），这里照样接住，判定表以后加了也不会漏成放行
  if (gate.verdict === 'deny') return gate.reason;
  if (gate.verdict === 'free') return undefined;
  const req: PermissionRequest = { kind: 'file-read', detail: absPath, sessionId: ctx.sessionId, toolTitle };
  if (gate.note !== undefined) req.note = gate.note;
  const d = await ctx.permissions.check(req);
  // 先看取消、再看拒绝：理由同 guardWrite
  if (ctx.signal?.aborted) return '[已取消]';
  if (d === 'deny') return `读取被用户拒绝: ${absPath}（可在设置-权限中调整）`;
  return undefined;
}

/** 分段参数：undefined 表示没带。null 也当没带——与 registry 必填检查同一口径，
 *  有的模型（OpenAI 严格模式）会把没用上的可选参数填成 null，那不是「想分段读」。 */
type PageArgs = { offset?: number; limit?: number };

/** 校验 offset / limit。非法时返回一句中文说明（工具据此 success:false，不抛）。
 *  不接受数字字符串：schema 写的是 integer，放过 "3" 就等于替模型猜意思，猜错了读出来的是另一段。 */
/** 回显非法值：截到 40 个字符，模型传来的超长字符串不整段抄进工具结果。 */
function shown(v: unknown): string {
  const t = JSON.stringify(v) ?? String(v);
  if (t.length <= 40) return t;
  // 截点让开代理对（同 sliceRange）：半个 emoji 进了工具结果，这条结果留在历史里，严格的 JSON 端之后每轮都 400
  const cut = isHighSurrogate(t.charCodeAt(39)) ? 39 : 40;
  return `${t.slice(0, cut)}…（共 ${t.length} 字符）`;
}

function parsePageArgs(input: Record<string, unknown>): PageArgs | string {
  const out: PageArgs = {};
  const { offset, limit } = input;
  if (offset !== undefined && offset !== null) {
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      return `offset 必须是非负整数（从 0 起的字符偏移），收到的是 ${shown(offset)}`;
    }
    out.offset = offset;
  }
  if (limit !== undefined && limit !== null) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > FILE_READ_LIMIT_MAX) {
      return `limit 必须是 1 到 ${FILE_READ_LIMIT_MAX} 之间的整数（最多返回的字符数），收到的是 ${shown(limit)}`;
    }
    out.limit = limit;
  }
  return out;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * 在全文里切出 [offset, offset+limit) 这一段，切点让开代理对：半个 emoji 进了请求体，严格的 JSON 端直接 400。
 * 终点前一位是高代理项就前移一位，把整个字符留给下一段，注记给的下一段 offset 就指在高代理项上；
 * 所以照注记接着读，起点永远不会落在低代理项上，一个字符都不丢。起点落在低代理项上只会是模型自己算的 offset，
 * 这时后移一位——宁可跳过那半个字符，也不交出孤立代理项。
 * 例外：limit=1 且起点正好是高代理项时，前移会得到空片段、注记给的下一段 offset 还是原地，
 * 照着读就永远原地打转——这时把整个字符（2 个码元）给出去，宁可多 1 个码元也要保证每段都有进展。
 */
function sliceRange(content: string, args: PageArgs): ReadRange {
  const total = content.length;
  let start = Math.min(args.offset ?? 0, total);
  if (start > 0 && start < total && isLowSurrogate(content.charCodeAt(start))) start += 1;
  let end = args.limit === undefined ? total : Math.min(start + args.limit, total);
  if (end > start && end < total && isHighSurrogate(content.charCodeAt(end - 1))) end -= 1;
  // 只有上面那条前移能把 end 拉回到 start（没给 limit 时 end 就是 total）
  if (end === start && start < total) end = start + 2;
  return { start, end, total };
}

/** 片段末尾的范围注记（另起一行）。a–b 是实际返回的范围（a 含 b 不含，按 UTF-16 码元从 0 计），
 *  明说有没有下一段、下一段从哪起，模型不用自己算。 */
function rangeNote(r: ReadRange, requestedOffset: number | undefined): string {
  let tail: string;
  if (r.end < r.total) tail = `未读完，下一段 offset=${r.end}`;
  else if (requestedOffset !== undefined && requestedOffset > r.total) tail = `已读到末尾（offset ${requestedOffset} 超出了全文长度）`;
  else tail = '已读到末尾';
  return `[第 ${r.start}–${r.end} 字符，共 ${r.total} 字符，${tail}]`;
}

export const fileReadTool: ToolExecutor = {
  definition: {
    name: 'file_read',
    description: '读取文本文件。支持 /var/minis/* 虚拟路径、工作区相对路径与绝对路径。不带 offset/limit 时整读（上限 1MB）；带任一参数时分段读（文件上限 16MB），结果末尾另起一行注明实际范围、全文长度与下一段的 offset。',
    parameters: {
      path: { type: 'string', description: '文件路径' },
      offset: { type: 'integer', description: '可选。从第几个字符开始读（按 UTF-16 码元计，从 0 起，默认 0）' },
      limit: { type: 'integer', description: `可选。最多返回多少个字符，1–${FILE_READ_LIMIT_MAX}；不填则读到末尾。读普通文件建议每段不超过 ${FILE_READ_SUGGESTED_LIMIT}（更长的一段会被卸载到文件，要再读一次）。切点不会劈开 emoji 等代理对，所以实际返回可能少 1 个字符，limit=1 遇到这类字符时多 1 个` },
      tool_title: TOOL_TITLE,
    },
    required: ['path', 'tool_title'],
  },
  async execute(input, ctx) {
    // 已取消（用户点了停止）：文件操作多为一次性动作，abort 后再去读/写会产出没人消费的副作用
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    // 参数先校验、再过权限闸：参数错了读不成，不该先让用户批一张卡再报错
    const page = parsePageArgs(input);
    if (typeof page === 'string') return { output: page, success: false };
    const paged = page.offset !== undefined || page.limit !== undefined;
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    const denied = await guardRead(abs, ctx, String(input.tool_title));
    if (denied) return { output: denied, success: false };
    // 权限等待可长达 90 秒；等待期间的取消不会补发 abort 事件（已 abort 的 signal 挂监听不触发），
    // 必须在闸后重查一次——否则「批准晚于取消」的操作会照常执行
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    const size = statSync(abs).size;
    // 超限提示（W1b-2d）：16MB 以内指回 file_read 自己的分段读取。以前一律叫模型用 shell_execute 分页读，
    // 而数据根里的文件（卸载文件就在那里）W1b-2 起 shell 只读命令点到就回落询问，照提示读每次都弹卡；
    // 文件工具读当前会话的桶是免审的。超过 16MB 分段读也不接，这时才让模型去用 shell
    if (size > MAX_READ_PAGED) {
      return { output: `文件超过 16MB，file_read 分段读取也不支持这么大的文件，请用 shell_execute 按行范围读取: ${abs}`, success: false };
    }
    if (!paged && size > MAX_READ) {
      return { output: `文件超过 1MB，不能一次整读，请用 file_read 的 offset/limit 分段读取（offset 从 0 起，每段 limit 建议不超过 ${FILE_READ_SUGGESTED_LIMIT}、最多 ${FILE_READ_LIMIT_MAX} 字符，超过 ${FILE_READ_SUGGESTED_LIMIT} 的一段会被卸载到文件、要再读一次；结果末尾会注明下一段的 offset）: ${abs}`, success: false };
    }
    const content = readFileSync(abs, 'utf8');
    // 技能 use_count 采集点（M2c）：只有真正读成功才计数；钩子里抛错不应弄砸这次读取。
    // 分段读只在从头读起、读到了内容的那一段计一次：一个 SKILL.md 分 N 段读完不是用了 N 次（W1b-2d 审查）
    const countRead = (): void => { try { ctx.onFileRead?.(abs); } catch { /* 计数失败不影响读取结果 */ } };
    // 不带参数：原样返回全文，与分段读取上线前逐字一致（没有末行注记）
    if (!paged) { countRead(); return { output: content, success: true }; }
    const range = sliceRange(content, page);
    if (range.start === 0 && range.end > 0) countRead();
    // readRange 交给 loop：读回卸载文件时 clampReadBack 靠它分清片段与注记、按文件坐标给下一段 offset
    return { output: `${content.slice(range.start, range.end)}\n${rangeNote(range, page.offset)}`, success: true, readRange: range };
  },
};

export const fileWriteTool: ToolExecutor = {
  definition: {
    name: 'file_write', description: '写入文本文件（覆盖），自动创建父目录。',
    parameters: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '完整文件内容' }, tool_title: TOOL_TITLE },
    required: ['path', 'content', 'tool_title'],
  },
  async execute(input, ctx) {
    // 已取消：写入会真落盘，取消后再写只会留下无人消费的脏文件
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    // 审批前预览：把现有内容 vs 待写内容的差分随权限请求带给权限卡（用户批准前能看到将要写什么）。
    // 读取失败（不存在/权限/编码错）一律按空串——预览失败不能反过来阻塞审批，门本身只依赖路径判定。
    const denied = await guardWrite(abs, ctx, String(input.tool_title), () => {
      let oldText = '';
      try { oldText = readFileSync(abs, 'utf8'); } catch { /* 读不到按新建文件：差分显示全新增 */ }
      return { oldText: previewClamp(oldText), newText: previewClamp(String(input.content)) };
    });
    if (denied) return { output: denied, success: false };
    // 同 file_read：权限闸后重查取消（已 abort 的 signal 不补发事件），防「批准晚于取消」仍写盘
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, String(input.content), 'utf8');
    return { output: `已写入 ${abs}`, success: true };
  },
};

export const fileEditTool: ToolExecutor = {
  definition: {
    name: 'file_edit', description: '精确字符串替换（仅限 UTF-8 文本）。old_string 必须在文件中唯一出现（重叠出现也算多处），不能为空；new_string 为空串表示删除。CRLF 文件可用 LF 写 old_string；写回保持原行尾与 BOM。',
    parameters: { path: { type: 'string', description: '文件路径' }, old_string: { type: 'string', description: '被替换的原文' }, new_string: { type: 'string', description: '替换后的文本，可为空串' }, tool_title: TOOL_TITLE },
    required: ['path', 'old_string', 'tool_title'],
  },
  async execute(input, ctx) {
    // 已取消：编辑同样会落盘，取消后再改只留下没人消费的脏文件
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    // 编辑的差分正文就是 old_string/new_string 本身，无需回读文件
    const denied = await guardWrite(abs, ctx, String(input.tool_title), () => ({
      oldText: previewClamp(String(input.old_string)),
      newText: previewClamp(String(input.new_string ?? '')),
    }));
    if (denied) return { output: denied, success: false };
    // 同 file_write：权限闸后重查取消，防「批准晚于取消」仍改盘
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    // 按原字节读：非 UTF-8 要在写回之前拒掉，按 utf8 读成字符串那一刻坏字节就已经变成 U+FFFD 了。
    // 匹配、行尾、BOM、唯一性全在 edit-text.ts 的纯函数里；失败时文件一个字节都不写。
    const r = editUtf8Bytes(readFileSync(abs), String(input.old_string), String(input.new_string ?? ''));
    if (!r.ok) return { output: describeEditFailure(r.failure, abs), success: false };
    writeFileSync(abs, r.text, 'utf8');
    return { output: `已编辑 ${abs}`, success: true };
  },
};
