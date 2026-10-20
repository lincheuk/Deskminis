/** F10A · T5：Word 生成器写出的包（renderDocx）。
 *
 *  逐条对应设计 §4.2 / §4.5 的写法，以及在真实 Word 里量出来的几个缺陷的修法（兼容性模式、中文落到等线、
 *  标题字号被多乘了 2、列宽贴字、相邻两表被并成一张、空表）。
 *
 *  **这些是包结构与 XML 的断言，不是版式证据**：某个写法 Word 到底采不采用，要看 work\verify\F10A\ 的取证。 */
import { describe, it, expect } from 'vitest';
import { readZip } from '../src/minisd/office/zip';
import { checkWellFormed } from '../src/minisd/office/xml';
import { buildDocx } from '../src/minisd/office/build';
import { renderDocx, documentXml, docxParts } from '../src/minisd/office/docx/build';
import { normalizeDocx, type DocxInput } from '../src/minisd/office/docx/model';
import { docxPartNames } from '../src/minisd/office/docx/parts';
import { OfficeInputError } from '../src/minisd/office/format';
import { DOCX_FIXTURES, reportInput } from './office-docx-fixtures';
import { legacyBuildDocx, type LegacyDocxInput } from './office-legacy-docx';

async function partsOf(input: DocxInput): Promise<Map<string, string>> {
  const raw = await readZip(buildDocx(input));
  return new Map([...raw].map(([k, v]) => [k, v.toString('utf8')]));
}
const doc = (input: DocxInput): string => documentXml(normalizeDocx(input).model);
const count = (s: string, needle: string): number => s.split(needle).length - 1;
const BASIC: DocxInput = { blocks: [{ kind: 'heading', level: 1, text: '标题' }, { kind: 'para', text: '正文' }] };

describe('T5 包结构', () => {
  it('部件清单固定：缺省 10 个；有列表才有 numbering，无页码就没有 footer', async () => {
    expect([...(await partsOf(BASIC)).keys()]).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'word/_rels/document.xml.rels',
      'word/styles.xml', 'word/settings.xml', 'word/fontTable.xml', 'word/footer1.xml', 'word/document.xml',
    ]);
    const withList = await partsOf({ blocks: [{ kind: 'list', items: ['a'] }] });
    expect([...withList.keys()]).toContain('word/numbering.xml');
    const noFooter = await partsOf({ page: { pageNumber: 'none' }, blocks: [] });
    expect([...noFooter.keys()]).not.toContain('word/footer1.xml');
    expect(noFooter.get('word/document.xml')).not.toContain('w:footerReference');
    expect(noFooter.get('[Content_Types].xml')).not.toContain('footer');
    expect(noFooter.get('word/_rels/document.xml.rels')).not.toContain('footer');
  });

  it('全部夹具：每个部件都是良构的 XML，内容类型与关系互相对得上', async () => {
    for (const [name, make] of Object.entries(DOCX_FIXTURES)) {
      const model = normalizeDocx(make()).model;
      const parts = await readZip(renderDocx(model));
      expect([...parts.keys()], name).toEqual(docxPartNames(model));
      const types = parts.get('[Content_Types].xml')!.toString('utf8');
      for (const [part, data] of parts) {
        expect(checkWellFormed(data.toString('utf8')), `${name} / ${part}`).toBeNull();
        if (part !== '[Content_Types].xml' && !part.endsWith('.rels')) expect(types, `${name} / ${part}`).toContain(`PartName="/${part}"`);
      }
      const rels = parts.get('word/_rels/document.xml.rels')!.toString('utf8');
      for (const m of rels.matchAll(/Target="([^"]+)"/g)) expect(parts.has(`word/${m[1]}`), `${name} → ${m[1]}`).toBe(true);
      const root = parts.get('_rels/.rels')!.toString('utf8');
      for (const m of root.matchAll(/Target="([^"]+)"/g)) expect(parts.has(m[1]), `${name} → ${m[1]}`).toBe(true);
    }
  });

  it('同输入两次产出的字节相同', () => {
    for (const make of Object.values(DOCX_FIXTURES)) expect(Buffer.compare(buildDocx(make()), buildDocx(make()))).toBe(0);
  });

  it('输入不可用时 buildDocx 抛 OfficeInputError（不写出半截的包）', () => {
    expect(() => buildDocx({ blocks: [{ kind: 'image' }] } as unknown as DocxInput)).toThrow(OfficeInputError);
  });
});

describe('T5 实测缺陷的修法', () => {
  it('兼容模式 15：settings.xml 在包里，并在关系与内容类型里登记（没有它 Word 按 2007 的规则打开）', async () => {
    const p = await partsOf(BASIC);
    expect(p.get('word/settings.xml')).toContain('<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>');
    expect(p.get('word/settings.xml')).toContain('<w:useFELayout/>');
    expect(p.get('word/settings.xml')).toContain('<w:characterSpacingControl w:val="compressPunctuation"/>');
    expect(p.get('word/_rels/document.xml.rels')).toContain('Target="settings.xml"');
    expect(p.get('[Content_Types].xml')).toContain('PartName="/word/settings.xml"');
    // 子元素顺序：defaultTabStop, characterSpacingControl, compat, themeFontLang
    expect(p.get('word/settings.xml')).toMatch(/<w:defaultTabStop [^>]*\/><w:characterSpacingControl [^>]*\/><w:compat>.*<\/w:compat><w:themeFontLang [^>]*\/><\/w:settings>$/);
  });

  it('不写 w:docGrid（会把行距吸附放大）、不写 w:updateFields（会弹对话框）', async () => {
    const p = await partsOf(reportInput());
    for (const xml of p.values()) { expect(xml).not.toContain('docGrid'); expect(xml).not.toContain('updateFields'); }
  });

  it('字体多处同写：docDefaults 与每个样式的 rFonts 四槽齐全、写中文名；fontTable 有对应条目', async () => {
    const p = await partsOf(BASIC);
    const styles = p.get('word/styles.xml')!;
    const body = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>';
    const head = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体" w:cs="Arial"/>';
    expect(styles).toContain(`<w:rPrDefault><w:rPr>${body}<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>`);
    const ids = [...styles.matchAll(/<w:style [^>]*w:styleId="([^"]+)">([\s\S]*?)<\/w:style>/g)];
    expect(ids.map(m => m[1])).toEqual(['Normal', 'BodyText', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', 'ListParagraph', 'TableText', 'Footer', 'DmGap']);
    for (const [, id, inner] of ids) expect(inner, id).toContain(id.startsWith('Heading') ? head : body);
    const fonts = p.get('word/fontTable.xml')!;
    expect(fonts).toContain('<w:font w:name="宋体"><w:altName w:val="SimSun"/><w:charset w:val="86"/>');
    expect(fonts).toContain('<w:font w:name="黑体"><w:altName w:val="SimHei"/>');
    expect(fonts).toContain('<w:font w:name="Times New Roman"><w:charset w:val="00"/>');
    expect(fonts).toContain('<w:font w:name="Arial">');
    expect(count(fonts, '<w:font ')).toBe(4);
    expect(p.get('word/settings.xml')).toContain('<w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/>');
  });

  it('标题字号没有再被乘 2：一级 18 磅（w:sz=36），依次 16 / 14 / 12 / 12 / 12；不加粗', async () => {
    const styles = (await partsOf(BASIC)).get('word/styles.xml')!;
    const sizes = [1, 2, 3, 4, 5, 6].map(n => new RegExp(`w:styleId="Heading${n}">[\\s\\S]*?<w:sz w:val="(\\d+)"/><w:szCs w:val="(\\d+)"/>`).exec(styles)!.slice(1, 3).map(Number));
    expect(sizes).toEqual([[36, 36], [32, 32], [28, 28], [24, 24], [24, 24], [24, 24]]);
    expect(styles).not.toContain('<w:b/>');
  });

  it('标题样式：与下段同页、自身不拆、1.25 倍行距、一级居中其余左对齐，段前段后按级', async () => {
    const styles = (await partsOf(BASIC)).get('word/styles.xml')!;
    const h = (n: number): string => new RegExp(`w:styleId="Heading${n}">([\\s\\S]*?)</w:style>`).exec(styles)![1];
    expect(h(1)).toContain('<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="240" w:line="300" w:lineRule="auto"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr>');
    expect(h(2)).toContain('<w:spacing w:before="240" w:after="120" w:line="300" w:lineRule="auto"/><w:jc w:val="left"/><w:outlineLvl w:val="1"/>');
    expect(h(3)).toContain('<w:spacing w:before="180" w:after="120" w:line="300" w:lineRule="auto"/>');
    expect(h(6)).toContain('<w:spacing w:before="120" w:after="60" w:line="300" w:lineRule="auto"/>');
    expect(h(1)).toContain('<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/>');
  });

  it('正文样式：1.5 倍行距、首行缩进两字符（两个属性都写）、两端对齐；缩进不在 Normal 上', async () => {
    const styles = (await partsOf(BASIC)).get('word/styles.xml')!;
    expect(styles).toContain('w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="480"/><w:jc w:val="both"/></w:pPr>');
    expect(/w:styleId="Normal">([\s\S]*?)<\/w:style>/.exec(styles)![1]).not.toContain('w:ind');
    expect(styles).toContain('<w:pPrDefault><w:pPr><w:widowControl/><w:overflowPunct w:val="0"/></w:pPr></w:pPrDefault>');
  });
});

/** 对照：同一批要求放到 db2a0ab 的旧生成器上是红的。
 *  这是「先红」的证据做成了常设用例——上面那些断言不是恒真的，旧代码一条都过不了。
 *  真实 Word 一侧的对照在取证记录里：旧产物读回兼容模式 12、中文落到等线、一级标题 32 磅。 */
describe('T5 对照：旧生成器（db2a0ab 的冻结副本）不满足这些要求', () => {
  const legacy = async (input: LegacyDocxInput): Promise<Map<string, string>> =>
    new Map([...(await readZip(legacyBuildDocx(input)))].map(([k, v]) => [k, v.toString('utf8')]));
  const BLOCKS = BASIC.blocks as unknown as LegacyDocxInput['blocks'];

  it('没有 settings.xml（Word 以兼容性模式打开）、没有 fontTable、没有页脚', async () => {
    const p = await legacy({ blocks: BLOCKS });
    expect([...p.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/document.xml']);
  });

  it('一级标题的 w:sz 是 64（32 磅，被多乘了 2）；东亚字体只在 docDefaults 里写了英文名', async () => {
    const styles = (await legacy({ blocks: BLOCKS })).get('word/styles.xml')!;
    expect(/w:styleId="Heading1">[\s\S]*?<w:sz w:val="(\d+)"/.exec(styles)![1]).toBe('64');
    expect(styles).toContain('w:eastAsia="Microsoft YaHei"');
    expect(/w:styleId="Normal">([\s\S]*?)<\/w:style>/.exec(styles)![1]).not.toContain('w:rFonts');
  });

  it('表格是自动宽度、没有 tblGrid；相邻两表之间没有段落；空表写出没有行的 w:tbl', async () => {
    const xml = (await legacy({ blocks: [{ kind: 'table', rows: [['a']] }, { kind: 'table', rows: [['b']] }, { kind: 'table', rows: [] }] })).get('word/document.xml')!;
    expect(xml).toContain('<w:tblW w:w="0" w:type="auto"/>');
    expect(xml).not.toContain('<w:tblGrid>');
    expect(xml).toContain('</w:tbl><w:tbl>');
    expect(xml).toContain('</w:tblPr></w:tbl>');
  });

  it('控制字符原样进 XML（Word 打不开这样的部件）；换行与制表符留在 w:t 里被当成空白', async () => {
    const xml = (await legacy({ blocks: [{ kind: 'para', text: 'a\u0001b' }, { kind: 'para', text: '甲\n乙\t丙' }] })).get('word/document.xml')!;
    expect(checkWellFormed(xml)).toBe('含有 XML 不允许的字符');
    expect(xml).toContain('<w:t xml:space="preserve">甲\n乙\t丙</w:t>');
    expect(xml).not.toContain('<w:br/>');
  });

  it('title 被丢掉；未知的块类型被静默当成段落', async () => {
    const p = await legacy({ title: '季度报告', blocks: [{ kind: 'image', text: '当成了段落' } as unknown as LegacyDocxInput['blocks'][number]] });
    for (const xml of p.values()) expect(xml).not.toContain('季度报告');
    expect(p.get('word/document.xml')).toContain('当成了段落');
  });
});

describe('T5 正文', () => {
  it('块到段落：标题、正文、列表项各用自己的样式；一个段落一个 run', () => {
    const xml = doc({ blocks: [{ kind: 'heading', level: 3, text: 'T' }, { kind: 'para', text: 'P' }, { kind: 'list', ordered: true, items: ['L', { text: 'L2', level: 2 }] }] });
    expect(xml).toContain('<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t xml:space="preserve">T</w:t></w:r></w:p>');
    expect(xml).toContain('<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr><w:r><w:t xml:space="preserve">P</w:t></w:r></w:p>');
    expect(xml).toContain('<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">L</w:t></w:r></w:p>');
    expect(xml).toContain('<w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr>');
  });

  it('换行与制表符成为 w:br / w:tab；五个实体转义；含中文的 run 带 eastAsia 提示', () => {
    const xml = doc({ blocks: [{ kind: 'para', text: 'a\nb\tc & <d> "e" \'f\'' }, { kind: 'para', text: '中文“引号”' }] });
    expect(xml).toContain('<w:r><w:t xml:space="preserve">a</w:t><w:br/><w:t xml:space="preserve">b</w:t><w:tab/><w:t xml:space="preserve">c &amp; &lt;d&gt; &quot;e&quot; &apos;f&apos;</w:t></w:r>');
    expect(xml).toContain('<w:r><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr><w:t xml:space="preserve">中文“引号”</w:t></w:r>');
  });

  it('控制字符进不了 XML（先清洗再转义）', () => {
    const xml = doc({ blocks: [{ kind: 'para', text: 'a\u0001b\u000bc' }, { kind: 'table', rows: [['x\u0002y']] }] });
    expect(xml).toContain('>abc<');
    expect(xml).toContain('>xy<');
    expect(checkWellFormed(xml)).toBeNull();
  });

  it('段落的直接格式：对齐、与下段同页、段前分页，子元素顺序固定', () => {
    const xml = doc({ blocks: [
      { kind: 'para', text: 'c', align: 'center', keepWithNext: true }, { kind: 'para', text: 'r', align: 'right' },
      { kind: 'para', text: 'l', align: 'left' }, { kind: 'para', text: 'j', align: 'justify' },
      { kind: 'heading', level: 2, text: 'h', pageBreakBefore: true },
    ] });
    // 居中、靠右的段落不要首行缩进；靠左的保留
    expect(xml).toContain('<w:pPr><w:pStyle w:val="BodyText"/><w:keepNext/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/></w:pPr>');
    expect(xml).toContain('<w:pPr><w:pStyle w:val="BodyText"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="right"/></w:pPr>');
    expect(xml).toContain('<w:pPr><w:pStyle w:val="BodyText"/><w:jc w:val="left"/></w:pPr>');
    expect(xml).toContain('<w:pPr><w:pStyle w:val="BodyText"/></w:pPr><w:r><w:t xml:space="preserve">j</w:t>');
    expect(xml).toContain('<w:pPr><w:pStyle w:val="Heading2"/><w:pageBreakBefore/></w:pPr>');
  });

  it('空 blocks：正文是一个空的 BodyText 段落，不产出只有 sectPr 的正文', () => {
    for (const input of [{ blocks: [] }, { blocks: [{ kind: 'table', rows: [] }] }] as DocxInput[]) {
      expect(doc(input)).toContain('<w:body><w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr></w:p><w:sectPr>');
    }
  });

  it('分页符在间隔段落里；节属性的顺序是 footerReference, pgSz, pgMar', () => {
    const xml = doc({ blocks: [{ kind: 'para', text: 'a' }, { kind: 'pageBreak' }, { kind: 'para', text: 'b' }] });
    expect(xml).toContain('<w:p><w:pPr><w:pStyle w:val="DmGap"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>');
    expect(xml).toContain('<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter1"/><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>');
  });

  it('title 进 core.xml，不进正文；没有 title 时部件仍在、元素省略；app.xml 写生成器标记', async () => {
    const withTitle = await partsOf({ title: '季度报告 & <草稿>', blocks: [{ kind: 'para', text: '正文' }] });
    expect(withTitle.get('docProps/core.xml')).toContain('<dc:title>季度报告 &amp; &lt;草稿&gt;</dc:title>');
    expect(withTitle.get('word/document.xml')).not.toContain('季度报告');
    const without = await partsOf(BASIC);
    expect(without.get('docProps/core.xml')).not.toContain('dc:title');
    expect(without.get('docProps/app.xml')).toContain('<Application>DeskMinis</Application>');
    // 不写作者、不写任何时间：产出可复现
    for (const part of ['docProps/core.xml', 'docProps/app.xml']) expect(without.get(part)).not.toMatch(/creator|created|modified|lastModifiedBy/);
  });
});

describe('T5 表格', () => {
  const tableOf = (xml: string, i = 0): string => [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)][i][0];
  const nums = (xml: string, re: RegExp): number[] => [...xml.matchAll(re)].map(m => Number(m[1]));

  it('每张表：固定布局、总宽 = 版心宽、Σ gridCol = 版心宽、每格 tcW 与网格一致、tblInd=0', () => {
    for (const [name, make] of Object.entries(DOCX_FIXTURES)) {
      const model = normalizeDocx(make()).model;
      const xml = documentXml(model);
      for (const m of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)) {
        const t = m[0];
        const grid = nums(t, /<w:gridCol w:w="(\d+)"\/>/g);
        expect(grid.reduce((a, b) => a + b, 0), name).toBe(model.page.textWidthTw);
        expect(t, name).toContain(`<w:tblW w:w="${model.page.textWidthTw}" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/>`);
        expect(t, name).toContain('<w:tblLayout w:type="fixed"/>');
        for (const row of t.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)) expect(nums(row[0], /<w:tcW w:w="(\d+)" w:type="dxa"\/>/g), name).toEqual(grid);
      }
    }
  });

  it('tblPr 与 tcPr 的子元素顺序；0.5 磅黑色单线；单元格边距左右 108、上下 57；垂直居中', () => {
    const t = tableOf(doc({ blocks: [{ kind: 'table', rows: [['a', 'b'], ['c', 'd']] }] }));
    expect(t).toMatch(/^<w:tbl><w:tblPr><w:tblW [^>]*\/><w:tblInd [^>]*\/><w:tblBorders>.*<\/w:tblBorders><w:tblLayout [^>]*\/><w:tblCellMar>.*<\/w:tblCellMar><\/w:tblPr><w:tblGrid>/);
    expect(t).toContain('<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>');
    expect(t).toContain('<w:tblCellMar><w:top w:w="57" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="57" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>');
    expect(t).toContain('<w:tcPr><w:tcW w:w="4153" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:vAlign w:val="center"/></w:tcPr>');
    expect(t).toContain('<w:tcPr><w:tcW w:w="4153" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>');
  });

  it('表头行：跨页重复、不拆、加粗居中浅灰底；数据行不拆、不加粗', () => {
    const t = tableOf(doc({ blocks: [{ kind: 'table', rows: [['名称', '数值'], ['甲', '1']] }] }));
    const rows = [...t.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)].map(m => m[0]);
    expect(rows[0]).toContain('<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>');
    expect(rows[0]).toContain('<w:pPr><w:pStyle w:val="TableText"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:hint="eastAsia"/><w:b/><w:bCs/></w:rPr>');
    expect(rows[1]).toContain('<w:trPr><w:cantSplit/></w:trPr>');
    expect(rows[1]).not.toContain('<w:b/>');
    expect(rows[1]).not.toContain('w:shd');
  });

  it('高行没有 cantSplit；首行是长文的表没有 tblHeader，首行不加粗也不强留一页', () => {
    const tall = tableOf(doc(DOCX_FIXTURES['huge-cell']()));
    const rows = [...tall.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)].map(m => m[0]);
    expect(rows.map(r => r.includes('<w:cantSplit/>'))).toEqual([true, true, true, false, true, true]);
    const header = tableOf(doc(DOCX_FIXTURES['huge-header']()));
    expect(header).not.toContain('<w:tblHeader/>');
    const first = /<w:tr>[\s\S]*?<\/w:tr>/.exec(header)![0];
    expect(first).not.toContain('<w:cantSplit/>');
    expect(first).not.toContain('<w:b/>');
    expect(first).not.toContain('<w:trPr>');
  });

  it('降级的表：单元格左右边距 45', () => {
    const xml = doc(DOCX_FIXTURES['legacy-wide']());
    expect(tableOf(xml, 0)).toContain('<w:left w:w="45" w:type="dxa"/><w:bottom w:w="57" w:type="dxa"/><w:right w:w="45" w:type="dxa"/>');
    expect(tableOf(xml, 1)).toContain('<w:left w:w="45" w:type="dxa"/>');
  });

  it('两表相邻：中间有一个 6 磅的间隔段落；表在文末：后面有一个 1 磅的间隔段落', () => {
    const xml = doc({ blocks: [{ kind: 'table', rows: [['a']] }, { kind: 'table', rows: [['b']] }] });
    const gap = (line: number): string => `<w:p><w:pPr><w:pStyle w:val="DmGap"/><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="exact"/></w:pPr></w:p>`;
    expect(xml).toContain(`</w:tbl>${gap(120)}<w:tbl>`);
    expect(xml).toContain(`</w:tbl>${gap(20)}<w:sectPr>`);
    // 表后面是段落时不加间隔段落
    expect(doc({ blocks: [{ kind: 'table', rows: [['a']] }, { kind: 'para', text: 'p' }] })).toContain('</w:tbl><w:p><w:pPr><w:pStyle w:val="BodyText"/>');
  });

  it('空表不产出没有行的 w:tbl', () => {
    expect(doc({ blocks: [{ kind: 'table', rows: [] }, { kind: 'para', text: 'p' }] })).not.toContain('<w:tbl>');
  });
});

describe('T5 列表与页脚', () => {
  it('两个有序列表 → 两个 w:num，各带三级 startOverride；无序列表不带', async () => {
    const p = await partsOf({ blocks: [{ kind: 'list', ordered: true, items: ['a'] }, { kind: 'list', items: ['b'] }, { kind: 'list', ordered: true, items: ['c'] }] });
    const numbering = p.get('word/numbering.xml')!;
    const over = [0, 1, 2].map(l => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('');
    expect(numbering).toContain(`<w:num w:numId="1"><w:abstractNumId w:val="1"/>${over}</w:num>`);
    expect(numbering).toContain('<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>');
    expect(numbering).toContain(`<w:num w:numId="3"><w:abstractNumId w:val="1"/>${over}</w:num>`);
    expect(count(numbering, '<w:abstractNum ')).toBe(2);
    expect(p.get('word/document.xml')).toContain('<w:numId w:val="3"/>');
  });

  it('三级：无序 ● ○ ■，有序 1. （1） a)；第 L 级左缩进 2 字 ×(L+2)、悬挂 2 字', async () => {
    const numbering = (await partsOf({ blocks: [{ kind: 'list', items: ['a'] }] })).get('word/numbering.xml')!;
    for (const [i, sym] of ['●', '○', '■'].entries()) {
      expect(numbering).toContain(`<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${sym}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${480 * (i + 2)}" w:hanging="480"/></w:pPr>`);
    }
    expect(numbering).toContain('<w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>');
    expect(numbering).toContain('<w:numFmt w:val="decimal"/><w:lvlText w:val="（%2）"/>');
    expect(numbering).toContain('<w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%3)"/>');
    // 有无序列表时项目符号的字体进 fontTable（这里正文字体本来就是宋体，不重复）
    expect(count((await partsOf({ style: { bodyFont: { eastAsia: '黑体' } }, blocks: [{ kind: 'list', items: ['a'] }] })).get('word/fontTable.xml')!, 'w:name="宋体"')).toBe(1);
  });

  it('页脚：居中的 PAGE 域（begin / instrText / separate / 缓存值 / end），节里有 footerReference', async () => {
    const p = await partsOf(BASIC);
    expect(p.get('word/footer1.xml')).toContain('<w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
    expect(p.get('word/_rels/document.xml.rels')).toContain('<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>');
    expect(p.get('word/styles.xml')).toMatch(/w:styleId="Footer">[\s\S]*?<w:jc w:val="center"\/>[\s\S]*?<w:sz w:val="18"\/>/);
  });

  it('docxParts 与写进 ZIP 的内容一致（取证的部件摘要就是对它算的）', async () => {
    const model = normalizeDocx(reportInput()).model;
    const zipped = await readZip(renderDocx(model));
    for (const [name, xml] of docxParts(model)) expect(zipped.get(name)!.toString('utf8')).toBe(xml);
  });
});
