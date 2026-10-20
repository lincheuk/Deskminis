/** Word generation, content readback, overwrite inspection and read advisories. */
import type { OfficeFormatHandler } from '../format';
import { renderDocx } from './build';
import { normalizeDocx } from './model';
import { verifyDocxContent } from './content-check';
import { refuseDocxOverwrite } from './inspect';

export const docxHandler: OfficeFormatHandler = {
  format: 'docx',
  app: 'Word',
  help: {
    brief: 'docx 只生成新文档，不能在已有文档上编辑；可设置页面、正文标题样式、列表和表格，外来文档请另存',
    content: 'docx={"title":"报告","page":{"size":"A4","orientation":"portrait","marginsCm":{"top":2.54,"bottom":2.54,"left":3.18,"right":3.18},"pageNumber":"bottom-center"},"style":{"bodyFont":{"eastAsia":"宋体","latin":"Times New Roman"},"headingFont":{"eastAsia":"黑体","latin":"Arial"},"bodySizePt":12,"headingSizesPt":[18,16,14,12,12,12],"tableSizePt":10.5,"lineSpacing":1.5,"paraSpacingPt":{"before":0,"after":0},"firstLineIndentChars":2},"blocks":[{"kind":"heading","level":1,"text":"标题","pageBreakBefore":false},{"kind":"para","text":"正文","align":"justify","keepWithNext":false},{"kind":"list","ordered":false,"items":[{"text":"要点","level":0}]},{"kind":"table","rows":[["A","B"]],"headerRows":0,"colWidths":[1,1],"allowRowSplit":false},{"kind":"pageBreak"}]}；page/style 可省略，使用中文默认值；不认识的字段会提示，未知块类型报错',
  },
  plan(spec) {
    const {model, notes} = normalizeDocx(spec);
    const bytes = renderDocx(model);
    return { summary: `Word 文档，${model.inputBlocks} 个块`, bytes, notes, verifyContent: subject => verifyDocxContent(bytes, model, subject) };
  },
  refuseOverwrite: refuseDocxOverwrite,
  readNote(doc) {
    return doc.omitted?.length ? `（未提取：${doc.omitted.join('、')}。office_read 只提取文字与表格；office_write 只会整份生成新文档，不能在这份文档上修改，也保留不了这些部分——需要改动请另存为新文件。）` : undefined;
  },
  toText(doc) {
    const out: string[] = [];
    // 单元格里的换行写成 <br>：原样的 \n 会把 Markdown 的表格行拆坏
    const cell = (s: string): string => s.replace(/\n/g, '<br>');
    doc.blocks.forEach((b, i) => {
      if (b.kind === 'heading') out.push(`${'#'.repeat(Math.min(b.level ?? 1, 6))} ${b.text ?? ''}`);
      else if (b.kind === 'para' && b.list) {
        // 列表项：每级缩进两个空格；相邻的列表项之间不空行
        out.push(`${'  '.repeat(b.list.level)}${b.list.ordered ? `${b.list.index}.` : '-'} ${b.text ?? ''}`);
        if (doc.blocks[i + 1]?.list) return;
      } else if (b.kind === 'para') out.push(b.text ?? '');
      else if (b.kind === 'table' && b.rows?.length) {
        const [head, ...body] = b.rows;
        out.push(`| ${head.map(cell).join(' | ')} |`);
        out.push(`|${head.map(() => '---').join('|')}|`);
        for (const r of body) out.push(`| ${r.map(cell).join(' | ')} |`);
      }
      out.push('');
    });
    return out.join('\n').trim();
  },
};
