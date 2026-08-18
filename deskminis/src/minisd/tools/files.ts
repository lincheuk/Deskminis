import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { PermPreview, ToolExecutor } from './types';

const MAX_READ = 1024 * 1024; // 1MB

/** 权限预览体积防线：preview 随 permission.request 广播给前端，超长文件的全文差分没人看得完
 *  还会撑大广播与权限卡内存，统一截到上限并尾标「…[截断]」——用户能看出被截，差分统计以截断后文本为准。 */
const PREVIEW_MAX_CHARS = 20000;
function previewClamp(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  return text.slice(0, PREVIEW_MAX_CHARS) + '…[截断]';
}

const TOOL_TITLE = { type: 'string' as const, description: '这次调用的 5-10 字中文摘要，用于 UI 卡片' };

/** 归一化后的包含判断：避免 <root>\..\.. 形式的字符串前缀欺骗。 */
function isInsideRoot(absPath: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

/** 数据根之外的绝对宿主路径写入需过权限网关。
 *  buildPreview 惰性构造：工作区内的写入（绝大多数）根本不过网关，提前读原文件构造差分纯属白读；
 *  只在确认要弹权限卡时才求值。 */
async function guardWrite(absPath: string, ctx: Parameters<ToolExecutor['execute']>[1], toolTitle: string, buildPreview?: () => PermPreview): Promise<string | undefined> {
  if (!isInsideRoot(absPath, ctx.paths.root) && !isInsideRoot(absPath, ctx.paths.workspaceOf(ctx.sessionId))) {
    const d = await ctx.permissions.check({ kind: 'file-write', detail: absPath, sessionId: ctx.sessionId, toolTitle, preview: buildPreview?.() });
    if (d === 'deny') return `写入被用户拒绝: ${absPath}（可在设置-权限中调整）`;
  }
  return undefined;
}

/**
 * 数据根之外的读取同样需过权限网关：静默 shell 只读层已取消后，
 * 无门的 file_read 会成为唯一的静默外泄通道（~/.ssh/id_rsa、浏览器 cookie 库、minis.db 本身）。
 * 数据根之内是 agent 自己的工作区，保持免打扰。
 * 用户显式绑定为工作区的真实项目目录（workspaceOf）也算免询问：绑定动作本身就是授权语义，
 * 否则会话绑定项目后每个新文件路径都会触发一次权限确认，确认沦为噪音。
 * 未绑定会话时 workspaceOf 回落沙箱桶（在数据根内），上面的数据根判断已覆盖，行为不变。
 */
export async function guardRead(absPath: string, ctx: Parameters<ToolExecutor['execute']>[1], toolTitle: string): Promise<string | undefined> {
  if (!isInsideRoot(absPath, ctx.paths.root) && !isInsideRoot(absPath, ctx.paths.workspaceOf(ctx.sessionId))) {
    const d = await ctx.permissions.check({ kind: 'file-read', detail: absPath, sessionId: ctx.sessionId, toolTitle });
    if (d === 'deny') return `读取被用户拒绝: ${absPath}（可在设置-权限中调整）`;
  }
  return undefined;
}

export const fileReadTool: ToolExecutor = {
  definition: {
    name: 'file_read', description: '读取文本文件。支持 /var/minis/* 虚拟路径、工作区相对路径与绝对路径。',
    parameters: { path: { type: 'string', description: '文件路径' }, tool_title: TOOL_TITLE },
    required: ['path', 'tool_title'],
  },
  async execute(input, ctx) {
    // 已取消（用户点了停止）：文件操作多为一次性动作，abort 后再去读/写会产出没人消费的副作用
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    const denied = await guardRead(abs, ctx, String(input.tool_title));
    if (denied) return { output: denied, success: false };
    // 权限等待可长达 90 秒；等待期间的取消不会补发 abort 事件（已 abort 的 signal 挂监听不触发），
    // 必须在闸后重查一次——否则「批准晚于取消」的操作会照常执行
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    if (statSync(abs).size > MAX_READ) return { output: `文件超过 1MB，请用 shell_execute 分页读取: ${abs}`, success: false };
    const content = readFileSync(abs, 'utf8');
    // 技能 use_count 采集点（M2c）：只有真正读成功才计数；钩子里抛错不应弄砸这次读取
    try { ctx.onFileRead?.(abs); } catch { /* 计数失败不影响读取结果 */ }
    return { output: content, success: true };
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
    name: 'file_edit', description: '精确字符串替换。old_string 必须在文件中唯一出现；new_string 为空串表示删除。',
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
    const content = readFileSync(abs, 'utf8');
    const oldStr = String(input.old_string);
    const count = content.split(oldStr).length - 1;
    if (count === 0) return { output: `old_string 未找到于 ${abs}`, success: false };
    if (count > 1) return { output: `old_string 出现 ${count} 次，必须唯一。请提供更长的上下文。`, success: false };
    writeFileSync(abs, content.replace(oldStr, String(input.new_string ?? '')), 'utf8');
    return { output: `已编辑 ${abs}`, success: true };
  },
};
