/** U1：OOXML 解析——把 .docx/.xlsx/.pptx 解成结构化内容。
 *
 *  **定位是「内容预览」不是「版式还原」**：文字、表格、幻灯片大纲都拿得到，
 *  字体/精确排版/图片位置/动画不还原（那需要版式引擎，是另一个量级的东西）。
 *  这条边界要在 UI 上说清楚——照 OfficeCLI 的教训：把渲染不了的格式硬塞给渲染器，
 *  只会让用户对着"请安装 X"发呆。
 *
 *  F10A 起这个文件只剩组合类型与按扩展名分派：三种格式的解析各在自己的目录里
 *  （`docx/parse.ts`、`xlsx/parse.ts`、`pptx/parse.ts`），共用的标签扫描在 `xml.ts`。 */
import { readZip } from './zip';
import { parseDocx, type DocBlock } from './docx/parse';
import { parseXlsx, type SheetData } from './xlsx/parse';
import { parsePptx, type SlideData } from './pptx/parse';

export type { DocBlock, SheetData, SlideData };
export interface OfficeDoc {
  kind: 'docx' | 'xlsx' | 'pptx';
  blocks: DocBlock[];
  sheets?: SheetData[];
  slides?: SlideData[];
  omitted?: string[];
}

/** 入口：按扩展名分派。不认识的格式**明说不支持**——照 OfficeCLI 的教训，
 *  legacy .doc/.xls/.ppt 与 ODF 跟 OOXML 无关，硬塞给解析器只会给用户假希望。 */
export async function parseOffice(fileName: string, buf: Buffer): Promise<OfficeDoc> {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (!['docx', 'xlsx', 'xlsm', 'pptx'].includes(ext)) {
    throw new Error(`不支持的格式 .${ext}——只能读 OOXML（.docx/.xlsx/.pptx）；` +
      `旧版 .doc/.xls/.ppt 与 ODF 是另一套二进制格式，请用 Office 应用打开`);
  }
  const parts = await readZip(buf);
  if (ext === 'docx') return parseDocx(parts);
  if (ext === 'pptx') return parsePptx(parts);
  return parseXlsx(parts);
}
