/** U4：Office 文档工具，统一结构化读写与权限检查。
 *
 *  参照 OfficeCLI 的能力分层，我们实现它的 **L1**（读 + 创建）：
 *  `office_read` 把 .docx/.xlsx/.pptx 读成结构化文本，`office_write` 从结构化输入产出文件。
 *  它的 L2（按路径精改 DOM，如 `set report.docx '/body/p[3]'`）需要完整 OOXML 对象模型，
 *  留候选——见设计稿 §1。
 *
 *  权限：读写各自复用既有 guardRead / guardWrite，与 file_read / file_write 同一道门，
 *  不给 Office 工具开后门。 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { commitFileWrite } from '../checkpoints/commit';
import type { ToolExecutor } from './types';
import { guardRead, guardWrite, guestPathClaims } from './files';
import { parseOffice, type OfficeDoc } from '../office/parse';
import type { OfficeFormat, OfficeFormatHandler, OfficeWritePlan } from '../office/format';
import { isOfficeVerification, officeUnverified, officeVerificationLine, type OfficeVerification } from '../../shared/office-verification';
import { docxHandler } from '../office/docx/handler';
import { xlsxHandler } from '../office/xlsx/handler';
import { pptxHandler } from '../office/pptx/handler';

const TOOL_TITLE = { type: 'string' as const, description: '这次调用的 5-10 字中文摘要，用于 UI 卡片' };
const MAX_OFFICE = 32 * 1024 * 1024;

/** F10A：按扩展名分发到各格式的处理器。这个文件只管公共流程（权限、取消、落盘），
 *  不认识任何一种格式的输入长什么样——改 Word / Excel / PowerPoint 的生成都不用碰这里。 */
export const OFFICE_FORMATS: Readonly<Record<OfficeFormat, OfficeFormatHandler>> = {
  docx: docxHandler, xlsx: xlsxHandler, pptx: pptxHandler,
};

/** 结构化内容 → 给模型看的纯文本。模型读的是内容不是版式，故用 Markdown 式排布：
 *  它天然懂标题层级与表格，比自造格式省 token 也少歧义。各格式的排布在各自的处理器里。 */
export function docToText(doc: OfficeDoc): string {
  return OFFICE_FORMATS[doc.kind].toText(doc);
}

export const officeReadTool: ToolExecutor = {
  definition: {
    name: 'office_read',
    description: '读取 Office 文档（.docx/.xlsx/.pptx）的内容，返回结构化文本（标题/段落/表格/工作表/幻灯片大纲）。' +
      '只提取内容，不还原版式；旧版 .doc/.xls/.ppt 与 ODF 不支持。',
    parameters: { path: { type: 'string', description: '文档路径' }, tool_title: TOOL_TITLE },
    required: ['path', 'tool_title'],
  },
  // F04：调度声明与 file_read / file_write 同一套（见 files.ts 的 guestPathClaims）
  scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none', resources: guestPathClaims('read') },
  async execute(input, ctx) {
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    const denied = await guardRead(abs, ctx, String(input.tool_title));
    if (denied) return { output: denied, success: false };
    try {
      const buf = readFileSync(abs);
      if (buf.length > MAX_OFFICE) return { output: `文件超过 32MB，拒绝解析：${abs}`, success: false };
      const doc = await parseOffice(abs, buf);
      const text = docToText(doc);
      const note = OFFICE_FORMATS[doc.kind].readNote?.(doc);
      return { output: [text || '（文档为空）', note].filter(Boolean).join('\n\n'), success: true };
    } catch (e) {
      // 模型会拿它读任意文件，错误必须是可读的一句话而不是堆栈
      return { output: `读取失败：${e instanceof Error ? e.message : String(e)}`, success: false };
    }
  },
};

/** 工厂只为测试注入处理器（用假处理器测公共流程）；产品只用下面的 officeWriteTool。 */
export function makeOfficeWriteTool(formats: Readonly<Record<OfficeFormat, OfficeFormatHandler>> = OFFICE_FORMATS): ToolExecutor {
  const { docx, xlsx, pptx } = formats;
  return {
    definition: {
      name: 'office_write',
      // 说明文字由三个处理器各出一段拼成：某种格式的输入形态变了，只改它自己的处理器
      description: `生成 Office 文档。${docx.help.brief}；${xlsx.help.brief}；` +
        `${pptx.help.brief}。格式由扩展名决定。`,
      parameters: {
        path: { type: 'string', description: '输出路径，扩展名决定格式（.docx/.xlsx/.pptx）' },
        content: { type: 'string', description: `JSON 字符串：${docx.help.content}；${xlsx.help.content}；${pptx.help.content}` },
        tool_title: TOOL_TITLE,
      },
      required: ['path', 'content', 'tool_title'],
    },
    scheduling: { readOnly: false, concurrencySafe: true, sideEffects: 'local-files', resources: guestPathClaims('write') },
    async execute(input, ctx) {
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
      const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
      const ext = abs.toLowerCase().split('.').pop() ?? '';
      // hasOwnProperty：扩展名来自模型，不能让 'constructor' 之类的原型键当成一种格式
      const handler = Object.prototype.hasOwnProperty.call(formats, ext) ? formats[ext as OfficeFormat] : undefined;
      if (!handler) {
        return { output: `office_write 只能产出 .docx/.xlsx/.pptx，收到 .${ext}`, success: false };
      }

      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(String(input.content)) as Record<string, unknown>;
      } catch (e) {
        return { output: `content 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, success: false };
      }

      let data: Buffer;
      let summary: string;
      let plan: OfficeWritePlan;
      try {
        plan = handler.plan(spec);
        data = plan.bytes;
        // 权限预览：二进制没有可读差分，给一句人话说明将写出什么
        summary = plan.summary;
      } catch (e) {
        return { output: `生成失败：${e instanceof Error ? e.message : String(e)}`, success: false };
      }

      const subject = {sha256: createHash('sha256').update(data).digest('hex'), size: data.length};
      let content: OfficeVerification;
      try {
        content = plan.verifyContent ? await plan.verifyContent(subject)
          : officeUnverified('content', subject, 'not-implemented', '这种格式还没有接入内容核验');
        if (!isOfficeVerification(content) || content.aspect !== 'content' || content.subject.sha256 !== subject.sha256 || content.subject.size !== subject.size) throw new Error('核验结果没有绑定本次生成字节');
      } catch (e) {
        content = officeUnverified('content', subject, 'engine-error', `内容核验过程出错：${e instanceof Error ? e.message : String(e)}`);
      }
      if (ctx.signal?.aborted) return {output:'[已取消]', success:false};
      if (content.status === 'failed') return {output: `生成失败：内容核验未通过——${content.message}`, success: false};

      const denied = await guardWrite(abs, ctx, String(input.tool_title),
        () => ({ oldText: '', newText: `[二进制] ${summary}（${(data.length / 1024).toFixed(1)} KB）` }));
      if (denied) return { output: denied, success: false };
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };

      const r = commitFileWrite(ctx, { path: abs, produce: before => {
        if (before.exists && before.size > 0) {
          let why: string | undefined;
          try { why = handler.refuseOverwrite?.(before.bytes, abs); }
          catch { why = `没有覆盖 ${abs}：检查原文件时出错，不能确认覆盖不会丢内容。原文件没有改动；请换一个文件名另存。`; }
          if (why) return {abort: why};
        }
        return data;
      } });
      if (!r.ok) return { output: r.message, success: false };
      const layout = officeUnverified('layout', subject, 'not-run', handler.app === 'Word'
        ? '本版本不在运行时启动 Word：分页、页数、字体是否落到声明的字体、表格是否越出版心都没有检查。交付前请用 Word 打开确认。'
        : `本版本不在运行时启动 ${handler.app}：没有在真实 ${handler.app} 里打开过，显示效果没有检查。`);
      const notes = plan.notes.flatMap(n => n.split(/\r?\n/));
      return { output: [`已生成 ${abs}（${summary}）`, officeVerificationLine(content), officeVerificationLine(layout),
        ...notes.slice(0,20).map(n => `提示：${n}`), ...(notes.length > 20 ? [`提示：另有 ${notes.length - 20} 条`] : [])].join('\n'), success: true };
    },
  };
}

export const officeWriteTool: ToolExecutor = makeOfficeWriteTool();
