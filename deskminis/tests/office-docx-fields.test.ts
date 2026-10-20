/** F10A · T3：字段生效矩阵——「收下的字段必须落到文档里」。
 *
 *  DOCX_FIELDS 的每一项取两个值，断言指定部件里对应的 OOXML 值跟着变，并且等于换算结果。
 *  模型收下一个字段而生成器不读它，对应的 XML 就不会变，这里就红；新增字段不进矩阵，元测试红。
 *
 *  这证明的是「字段写进了包」；Word 采不采用，由取证里 variants 夹具的逐项读回证明（DOCX_FIELD_CHECKS）。 */
import { describe, it, expect } from 'vitest';
import { normalizeDocx, DOCX_FIELDS } from '../src/minisd/office/docx/model';
import { docxParts } from '../src/minisd/office/docx/build';
import { docxHandler } from '../src/minisd/office/docx/handler';
import { OfficeInputError } from '../src/minisd/office/format';

type Parts = Map<string, string>;
const gen = (input: unknown): Parts => new Map(docxParts(normalizeDocx(input).model));
const one = (xml: string | undefined, re: RegExp): string => re.exec(xml ?? '')?.slice(1).join('x') ?? '(无)';
const count = (xml: string | undefined, needle: string): string => String((xml ?? '').split(needle).length - 1);
const styleOf = (p: Parts, id: string): string => new RegExp(`w:styleId="${id}">([\\s\\S]*?)</w:style>`).exec(p.get('word/styles.xml')!)?.[1] ?? '';
const DOC = 'word/document.xml';
const para = (extra: Record<string, unknown>): unknown => ({ blocks: [{ kind: 'para', text: 'p', ...extra }] });
const style = (s: Record<string, unknown>): unknown => ({ style: s, blocks: [{ kind: 'para', text: 'p' }] });
const page = (p: Record<string, unknown>): unknown => ({ page: p, blocks: [] });
const table = (extra: Record<string, unknown>): unknown => ({ blocks: [{ kind: 'table', rows: [['a', 'b'], ['c', 'd'], ['e', 'f']], ...extra }] });

/** 字段 → [输入甲, 期望甲, 输入乙, 期望乙, 从包里取出对应的值] */
const MATRIX: Record<string, [unknown, string, unknown, string, (p: Parts) => string]> = {
  title: [{ title: '甲' }, '甲', { title: '乙' }, '乙', p => one(p.get('docProps/core.xml'), /<dc:title>([^<]*)</)],
  'page.size': [page({ size: 'A4' }), '11906x16838', page({ size: 'Letter' }), '12240x15840', p => one(p.get(DOC), /<w:pgSz w:w="(\d+)" w:h="(\d+)"/)],
  'page.orientation': [page({ orientation: 'portrait' }), '11906x16838x', page({ orientation: 'landscape' }), '16838x11906x w:orient="landscape"',
    p => one(p.get(DOC), /<w:pgSz w:w="(\d+)" w:h="(\d+)"([^/]*)\/>/)],
  'page.marginsCm.top': [page({ marginsCm: { top: 2 } }), '1134', page({ marginsCm: { top: 3 } }), '1701', p => one(p.get(DOC), /<w:pgMar w:top="(\d+)"/)],
  'page.marginsCm.bottom': [page({ marginsCm: { bottom: 2 } }), '1134', page({ marginsCm: { bottom: 1 } }), '567', p => one(p.get(DOC), /<w:pgMar [^>]*w:bottom="(\d+)"/)],
  'page.marginsCm.left': [page({ marginsCm: { left: 2 } }), '1134', page({ marginsCm: { left: 2.5 } }), '1417', p => one(p.get(DOC), /<w:pgMar [^>]*w:left="(\d+)"/)],
  'page.marginsCm.right': [page({ marginsCm: { right: 2 } }), '1134', page({ marginsCm: { right: 4 } }), '2268', p => one(p.get(DOC), /<w:pgMar [^>]*w:right="(\d+)"/)],
  'page.pageNumber': [page({ pageNumber: 'bottom-center' }), '1/true', page({ pageNumber: 'none' }), '0/false',
    p => `${count(p.get(DOC), '<w:footerReference ')}/${p.has('word/footer1.xml')}`],
  'style.bodyFont.eastAsia': [style({ bodyFont: { eastAsia: '宋体' } }), '宋体', style({ bodyFont: { eastAsia: '楷体' } }), '楷体', p => one(styleOf(p, 'BodyText'), /w:eastAsia="([^"]*)"/)],
  'style.bodyFont.latin': [style({ bodyFont: { latin: 'Times New Roman' } }), 'Times New RomanxTimes New Roman', style({ bodyFont: { latin: 'Calibri' } }), 'CalibrixCalibri',
    p => one(styleOf(p, 'BodyText'), /w:ascii="([^"]*)" w:hAnsi="([^"]*)"/)],
  'style.headingFont.eastAsia': [style({ headingFont: { eastAsia: '黑体' } }), '黑体', style({ headingFont: { eastAsia: '微软雅黑' } }), '微软雅黑', p => one(styleOf(p, 'Heading1'), /w:eastAsia="([^"]*)"/)],
  'style.headingFont.latin': [style({ headingFont: { latin: 'Arial' } }), 'Arial', style({ headingFont: { latin: 'Calibri' } }), 'Calibri', p => one(styleOf(p, 'Heading3'), /w:ascii="([^"]*)"/)],
  'style.bodySizePt': [style({ bodySizePt: 12 }), '24x24x480', style({ bodySizePt: 10.5 }), '21x21x420',
    p => `${one(styleOf(p, 'BodyText'), /<w:sz w:val="(\d+)"\/><w:szCs w:val="(\d+)"/)}x${one(styleOf(p, 'BodyText'), /w:firstLine="(\d+)"/)}`],
  'style.headingSizesPt': [style({ headingSizesPt: [20] }), '40/32', style({ headingSizesPt: [22, 15] }), '44/30',
    p => `${one(styleOf(p, 'Heading1'), /<w:sz w:val="(\d+)"/)}/${one(styleOf(p, 'Heading2'), /<w:sz w:val="(\d+)"/)}`],
  'style.tableSizePt': [style({ tableSizePt: 10.5 }), '21', style({ tableSizePt: 9 }), '18', p => one(styleOf(p, 'TableText'), /<w:sz w:val="(\d+)"/)],
  'style.lineSpacing': [style({ lineSpacing: 1.5 }), '360/360', style({ lineSpacing: 2 }), '480/480',
    p => `${one(styleOf(p, 'BodyText'), /w:line="(\d+)"/)}/${one(styleOf(p, 'ListParagraph'), /w:line="(\d+)"/)}`],
  'style.paraSpacingPt.before': [style({ paraSpacingPt: { before: 0 } }), '0', style({ paraSpacingPt: { before: 6 } }), '120', p => one(styleOf(p, 'BodyText'), /w:before="(\d+)"/)],
  'style.paraSpacingPt.after': [style({ paraSpacingPt: { after: 3 } }), '60', style({ paraSpacingPt: { after: 12 } }), '240', p => one(styleOf(p, 'BodyText'), /w:after="(\d+)"/)],
  'style.firstLineIndentChars': [style({ firstLineIndentChars: 2 }), '200x480', style({ firstLineIndentChars: 0 }), '0x0',
    p => one(styleOf(p, 'BodyText'), /w:firstLineChars="(\d+)" w:firstLine="(\d+)"/)],
  'blocks[].kind': [{ blocks: [{ kind: 'heading', text: 't' }] }, 'Heading1', { blocks: [{ kind: 'para', text: 't' }] }, 'BodyText', p => one(p.get(DOC), /<w:pStyle w:val="([^"]*)"/)],
  'blocks[].level': [{ blocks: [{ kind: 'heading', level: 1, text: 't' }] }, 'Heading1', { blocks: [{ kind: 'heading', level: 4, text: 't' }] }, 'Heading4', p => one(p.get(DOC), /<w:pStyle w:val="([^"]*)"/)],
  'blocks[].text': [para({ text: '甲文' }), '甲文', para({ text: '乙文' }), '乙文', p => one(p.get(DOC), /<w:t xml:space="preserve">([^<]*)</)],
  'blocks[].pageBreakBefore': [{ blocks: [{ kind: 'heading', text: 't', pageBreakBefore: true }] }, '1', { blocks: [{ kind: 'heading', text: 't', pageBreakBefore: false }] }, '0',
    p => count(p.get(DOC), '<w:pageBreakBefore/>')],
  'blocks[].align': [para({ align: 'center' }), 'center', para({ align: 'right' }), 'right', p => one(p.get(DOC), /<w:jc w:val="([^"]*)"/)],
  'blocks[].keepWithNext': [para({ keepWithNext: true }), '1', para({ keepWithNext: false }), '0', p => count(p.get(DOC), '<w:keepNext/>')],
  'blocks[].ordered': [{ blocks: [{ kind: 'list', ordered: true, items: ['a'] }] }, '1x3', { blocks: [{ kind: 'list', ordered: false, items: ['a'] }] }, '0x0',
    p => `${one(p.get('word/numbering.xml'), /<w:num w:numId="1"><w:abstractNumId w:val="(\d)"/)}x${count(p.get('word/numbering.xml'), '<w:startOverride ')}`],
  'blocks[].items': [{ blocks: [{ kind: 'list', items: ['a'] }] }, '1', { blocks: [{ kind: 'list', items: ['a', 'b', 'c'] }] }, '3', p => count(p.get(DOC), '<w:numPr>')],
  'blocks[].items[].text': [{ blocks: [{ kind: 'list', items: [{ text: '甲项' }] }] }, '甲项', { blocks: [{ kind: 'list', items: [{ text: '乙项' }] }] }, '乙项',
    p => one(p.get(DOC), /<w:t xml:space="preserve">([^<]*)</)],
  'blocks[].items[].level': [{ blocks: [{ kind: 'list', items: [{ text: 'a', level: 0 }] }] }, '0', { blocks: [{ kind: 'list', items: [{ text: 'a', level: 2 }] }] }, '2',
    p => one(p.get(DOC), /<w:ilvl w:val="(\d)"/)],
  'blocks[].rows': [{ blocks: [{ kind: 'table', rows: [['a']] }] }, '1/1', table({}), '3/6', p => `${count(p.get(DOC), '<w:tr>')}/${count(p.get(DOC), '<w:tc>')}`],
  'blocks[].headerRows': [table({ headerRows: 0 }), '0', table({ headerRows: 2 }), '2', p => count(p.get(DOC), '<w:tblHeader/>')],
  'blocks[].colWidths': [table({ colWidths: [1, 1] }), '4153,4153', table({ colWidths: [1, 3] }), '2076,6230',
    p => [...p.get(DOC)!.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(m => m[1]).join(',')],
  'blocks[].allowRowSplit': [table({ allowRowSplit: false }), '3', table({ allowRowSplit: true }), '1', p => count(p.get(DOC), '<w:cantSplit/>')],
};

describe('T3 字段生效矩阵', () => {
  for (const [field, [a, wantA, b, wantB, probe]] of Object.entries(MATRIX)) {
    it(`${field}：两个取值写出两个不同的值，且都等于换算结果`, () => {
      expect(probe(gen(a))).toBe(wantA);
      expect(probe(gen(b))).toBe(wantB);
      expect(wantA).not.toBe(wantB);
    });
  }
});

/** 带全部字段的一份输入：每种块各一个，每个字段都出现。 */
const FULL = {
  title: 't',
  page: { size: 'A4', orientation: 'portrait', marginsCm: { top: 2.54, bottom: 2.54, left: 3, right: 3 }, pageNumber: 'bottom-center' },
  style: {
    bodyFont: { eastAsia: '宋体', latin: 'Arial' }, headingFont: { eastAsia: '黑体', latin: 'Arial' },
    bodySizePt: 12, headingSizesPt: [18], tableSizePt: 10.5, lineSpacing: 1.5, paraSpacingPt: { before: 0, after: 0 }, firstLineIndentChars: 2,
  },
  blocks: [
    { kind: 'heading', level: 1, text: 'h', pageBreakBefore: false },
    { kind: 'para', text: 'p', align: 'left', keepWithNext: false },
    { kind: 'list', ordered: true, items: [{ text: 'i', level: 0 }] },
    { kind: 'table', rows: [['a', 'b'], ['c', 'd']], headerRows: 1, colWidths: [1, 1], allowRowSplit: false },
    { kind: 'pageBreak' },
  ],
};
/** 把 path 指到的叶子键改名（加 X），返回改名后的具体路径（如 blocks[2].items[0].levelX）。 */
function renameLeaf(root: unknown, path: string): string[] {
  const segs = path.split('.');
  const out: string[] = [];
  const walk = (node: unknown, i: number, at: string): void => {
    if (typeof node !== 'object' || node === null) return;
    const seg = segs[i];
    const each = seg.endsWith('[]');
    const key = each ? seg.slice(0, -2) : seg;
    const obj = node as Record<string, unknown>;
    if (!(key in obj)) return;
    const here = at ? `${at}.${key}` : key;
    if (i === segs.length - 1) {
      obj[`${key}X`] = obj[key];
      delete obj[key];
      out.push(`${here}X`);
    } else if (each) {
      (obj[key] as unknown[]).forEach((child, n) => walk(child, i + 1, `${here}[${n}]`));
    } else walk(obj[key], i + 1, here);
  };
  walk(root, 0, '');
  return out;
}

describe('T3 元测试', () => {
  it('矩阵的键集合 = DOCX_FIELDS（新增字段不进矩阵就红）', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...DOCX_FIELDS].sort());
    expect(new Set(DOCX_FIELDS).size).toBe(DOCX_FIELDS.length);
  });

  it('带全部字段的输入：没有任何「未采用」的提示', () => {
    expect(normalizeDocx(structuredClone(FULL)).notes).toEqual([]);
  });

  it('把 DOCX_FIELDS 里任一项的键改个名：规范化就不认它了（多出对应的提示；kind / items 是必填，改名即报错）', () => {
    const required = ['blocks[].kind', 'blocks[].items'];
    for (const field of DOCX_FIELDS) {
      const input = structuredClone(FULL);
      const renamed = renameLeaf(input, field);
      expect(renamed.length, field).toBeGreaterThan(0);
      if (required.includes(field)) {
        expect(() => normalizeDocx(input), field).toThrow(OfficeInputError);
        continue;
      }
      const notes = normalizeDocx(input).notes;
      for (const r of renamed) expect(notes, field).toContain(`未采用的字段 ${r}`);
    }
  });

  it('docx 工具说明里出现的字段名都在 DOCX_FIELDS 里（说明里不许写没实现的字段）', () => {
    const names = new Set(DOCX_FIELDS.flatMap(f => f.split('.').map(s => s.replace('[]', ''))));
    const used = [...docxHandler.help.content.matchAll(/"(\w+)":/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const u of used) expect(names.has(u), `说明里的 ${u}`).toBe(true);
  });
});
