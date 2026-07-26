import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { ToolExecutor } from './types';

const MAX_READ = 1024 * 1024; // 1MB

const TOOL_TITLE = { type: 'string' as const, description: '这次调用的 5-10 字用户语言摘要' };

/** 归一化后的包含判断：避免 <root>\..\.. 形式的字符串前缀欺骗。 */
function isInsideRoot(absPath: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

/** 数据根之外的绝对宿主路径写入需过权限网关。 */
async function guardWrite(absPath: string, ctx: Parameters<ToolExecutor['execute']>[1], toolTitle: string): Promise<string | undefined> {
  if (!isInsideRoot(absPath, ctx.paths.root)) {
    const d = await ctx.permissions.check({ kind: 'file-write', detail: absPath, sessionId: ctx.sessionId, toolTitle });
    if (d === 'deny') return `写入被用户拒绝: ${absPath}（可在设置-权限中调整）`;
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
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    if (statSync(abs).size > MAX_READ) return { output: `文件超过 1MB，请用 shell_execute 分页读取: ${abs}`, success: false };
    return { output: readFileSync(abs, 'utf8'), success: true };
  },
};

export const fileWriteTool: ToolExecutor = {
  definition: {
    name: 'file_write', description: '写入文本文件（覆盖），自动创建父目录。',
    parameters: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '完整文件内容' }, tool_title: TOOL_TITLE },
    required: ['path', 'content', 'tool_title'],
  },
  async execute(input, ctx) {
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    const denied = await guardWrite(abs, ctx, String(input.tool_title));
    if (denied) return { output: denied, success: false };
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
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    const denied = await guardWrite(abs, ctx, String(input.tool_title));
    if (denied) return { output: denied, success: false };
    const content = readFileSync(abs, 'utf8');
    const oldStr = String(input.old_string);
    const count = content.split(oldStr).length - 1;
    if (count === 0) return { output: `old_string 未找到于 ${abs}`, success: false };
    if (count > 1) return { output: `old_string 出现 ${count} 次，必须唯一。请提供更长的上下文。`, success: false };
    writeFileSync(abs, content.replace(oldStr, String(input.new_string ?? '')), 'utf8');
    return { output: `已编辑 ${abs}`, success: true };
  },
};
