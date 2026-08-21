/** U4：Office 文档工具（设计稿 2026-08-21-office-design.md）。
 *
 *  参照 OfficeCLI 的能力分层，我们实现它的 **L1**（读 + 创建）：
 *  `office_read` 把 .docx/.xlsx/.pptx 读成结构化文本，`office_write` 从结构化输入产出文件。
 *  它的 L2（按路径精改 DOM，如 `set report.docx '/body/p[3]'`）需要完整 OOXML 对象模型，
 *  留候选——见设计稿 §1。
 *
 *  权限：读写各自复用既有 guardRead / guardWrite，与 file_read / file_write 同一道门，
 *  不给 Office 工具开后门。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolExecutor } from './types';
import { guardRead, guardWrite } from './files';
import { parseOffice, type OfficeDoc } from '../office/parse';
import { buildDocx, buildXlsx, buildPptx } from '../office/build';

const TOOL_TITLE = { type: 'string' as const, description: '这次调用的 5-10 字中文摘要，用于 UI 卡片' };
const MAX_OFFICE = 32 * 1024 * 1024;

/** 结构化内容 → 给模型看的纯文本。模型读的是内容不是版式，故用 Markdown 式排布：
 *  它天然懂标题层级与表格，比自造格式省 token 也少歧义。 */
export function docToText(doc: OfficeDoc): string {
  const out: string[] = [];
  if (doc.kind === 'docx') {
    for (const b of doc.blocks) {
      if (b.kind === 'heading') out.push(`${'#'.repeat(Math.min(b.level ?? 1, 6))} ${b.text ?? ''}`);
      else if (b.kind === 'para') out.push(b.text ?? '');
      else if (b.kind === 'table' && b.rows?.length) {
        const [head, ...body] = b.rows;
        out.push(`| ${head.join(' | ')} |`);
        out.push(`|${head.map(() => '---').join('|')}|`);
        for (const r of body) out.push(`| ${r.join(' | ')} |`);
      }
      out.push('');
    }
  } else if (doc.kind === 'xlsx') {
    for (const sh of doc.sheets ?? []) {
      out.push(`## 工作表：${sh.name}（${sh.rows.length} 行）`);
      for (const r of sh.rows) out.push(r.join('\t'));
      out.push('');
    }
  } else {
    (doc.slides ?? []).forEach((s, i) => {
      out.push(`## 第 ${i + 1} 页：${s.title}`);
      for (const b of s.bullets) out.push(`- ${b}`);
      out.push('');
    });
  }
  return out.join('\n').trim();
}

export const officeReadTool: ToolExecutor = {
  definition: {
    name: 'office_read',
    description: '读取 Office 文档（.docx/.xlsx/.pptx）的内容，返回结构化文本（标题/段落/表格/工作表/幻灯片大纲）。' +
      '只提取内容，不还原版式；旧版 .doc/.xls/.ppt 与 ODF 不支持。',
    parameters: { path: { type: 'string', description: '文档路径' }, tool_title: TOOL_TITLE },
    required: ['path', 'tool_title'],
  },
  async execute(input, ctx) {
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    const denied = await guardRead(abs, ctx, String(input.tool_title));
    if (denied) return { output: denied, success: false };
    try {
      const buf = readFileSync(abs);
      if (buf.length > MAX_OFFICE) return { output: `文件超过 32MB，拒绝解析：${abs}`, success: false };
      const doc = await parseOffice(abs, buf);
      const text = docToText(doc);
      return { output: text || '（文档为空）', success: true };
    } catch (e) {
      // 模型会拿它读任意文件，错误必须是可读的一句话而不是堆栈
      return { output: `读取失败：${e instanceof Error ? e.message : String(e)}`, success: false };
    }
  },
};

export const officeWriteTool: ToolExecutor = {
  definition: {
    name: 'office_write',
    description: '生成 Office 文档。docx 传 blocks（heading/para/table）；xlsx 传 sheets（name+rows）；' +
      'pptx 传 slides（title+bullets）。格式由扩展名决定。',
    parameters: {
      path: { type: 'string', description: '输出路径，扩展名决定格式（.docx/.xlsx/.pptx）' },
      content: { type: 'string', description: 'JSON 字符串：docx={"blocks":[{"kind":"heading","level":1,"text":"…"},{"kind":"para","text":"…"},{"kind":"table","rows":[["A","B"]]}]}；xlsx={"sheets":[{"name":"表1","rows":[["列","值"],["甲",1]]}]}；pptx={"slides":[{"title":"标题","bullets":["要点"]}]}' },
      tool_title: TOOL_TITLE,
    },
    required: ['path', 'content', 'tool_title'],
  },
  async execute(input, ctx) {
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
    const abs = ctx.paths.resolveGuestPath(ctx.sessionId, String(input.path));
    const ext = abs.toLowerCase().split('.').pop() ?? '';
    if (!['docx', 'xlsx', 'pptx'].includes(ext)) {
      return { output: `office_write 只能产出 .docx/.xlsx/.pptx，收到 .${ext}`, success: false };
    }

    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(String(input.content)) as Record<string, unknown>;
    } catch (e) {
      return { output: `content 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, success: false };
    }

    let data: Buffer;
    try {
      if (ext === 'docx') data = buildDocx({ blocks: (spec.blocks ?? []) as never });
      else if (ext === 'xlsx') data = buildXlsx({ sheets: (spec.sheets ?? []) as never });
      else data = buildPptx({ slides: (spec.slides ?? []) as never });
    } catch (e) {
      return { output: `生成失败：${e instanceof Error ? e.message : String(e)}`, success: false };
    }

    // 权限预览：二进制没有可读差分，给一句人话说明将写出什么
    const summary = ext === 'docx' ? `Word 文档，${((spec.blocks as unknown[]) ?? []).length} 个块`
      : ext === 'xlsx' ? `Excel 工作簿，${((spec.sheets as unknown[]) ?? []).length} 张表`
      : `PowerPoint 演示，${((spec.slides as unknown[]) ?? []).length} 页`;
    const denied = await guardWrite(abs, ctx, String(input.tool_title),
      () => ({ oldText: '', newText: `[二进制] ${summary}（${(data.length / 1024).toFixed(1)} KB）` }));
    if (denied) return { output: denied, success: false };
    if (ctx.signal?.aborted) return { output: '[已取消]', success: false };

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    return { output: `已生成 ${abs}（${summary}）`, success: true };
  },
};
