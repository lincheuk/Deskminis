/** U1/U3 Office 文档能力（设计稿 2026-08-21-office-design.md）。
 *  .docx/.xlsx/.pptx 都是 ZIP + OOXML，故先测 zip 往返，再测三种解析器。
 *  **往返验证**：用我们自己的 writer 造真实字节，再用 reader 读回——
 *  测试自洽、不依赖外部样本；生成物能否被真实 Office 打开是 Windows 真机验收项。 */
import { describe, it, expect } from 'vitest';
import { writeZip, readZip } from '../src/minisd/office/zip';
import { parseOffice } from '../src/minisd/office/parse';
import { buildDocx, buildXlsx, buildPptx } from '../src/minisd/office/build';

describe('U1 zip 往返', () => {
  it('写进去的条目能原样读回（含中文与二进制）', async () => {
    const bin = Buffer.from([0, 1, 2, 253, 254, 255]);
    const buf = writeZip([
      { path: 'a.txt', data: Buffer.from('你好，世界', 'utf8') },
      { path: 'dir/b.bin', data: bin },
    ]);
    const back = await readZip(buf);
    expect(back.get('a.txt')!.toString('utf8')).toBe('你好，世界');
    expect(Buffer.compare(back.get('dir/b.bin')!, bin)).toBe(0);
  });

  it('空内容与空文件名列表都不炸', async () => {
    const buf = writeZip([{ path: 'empty.txt', data: Buffer.alloc(0) }]);
    const back = await readZip(buf);
    expect(back.get('empty.txt')!.length).toBe(0);
  });

  it('不是 zip 的字节：报错而不是崩', async () => {
    await expect(readZip(Buffer.from('this is not a zip at all'))).rejects.toThrow();
  });
});

describe('U3→U1 docx 往返：生成 → 解析', () => {
  it('标题、段落、表格三类内容都能读回', async () => {
    const buf = buildDocx({
      title: '季度报告',
      blocks: [
        { kind: 'heading', level: 1, text: '季度报告' },
        { kind: 'para', text: '营收增长 25%，其中华东占比最高。' },
        { kind: 'table', rows: [['区域', '金额'], ['华东', '42'], ['华南', '31']] },
      ],
    });
    const doc = await parseOffice('report.docx', buf);
    expect(doc.kind).toBe('docx');
    const heads = doc.blocks.filter(b => b.kind === 'heading');
    expect(heads[0]).toMatchObject({ kind: 'heading', level: 1, text: '季度报告' });
    expect(doc.blocks.some(b => b.kind === 'para' && (b.text ?? '').includes('营收增长 25%'))).toBe(true);
    const tbl = doc.blocks.find(b => b.kind === 'table');
    expect(tbl && tbl.kind === 'table' && tbl.rows).toEqual([['区域', '金额'], ['华东', '42'], ['华南', '31']]);
  });

  it('XML 特殊字符不破坏结构（&<>"\' 全程转义）', async () => {
    const nasty = 'A & B < C > D "quoted" \'single\'';
    const doc = await parseOffice('x.docx', buildDocx({ blocks: [{ kind: 'para', text: nasty }] }));
    expect(doc.blocks.some(b => b.kind === 'para' && b.text === nasty)).toBe(true);
  });
});

describe('U3→U1 xlsx 往返', () => {
  it('多工作表、数字与文本单元格、空格都能读回', async () => {
    const buf = buildXlsx({
      sheets: [
        { name: '数据', rows: [['月份', '销量'], ['一月', 120], ['二月', 98.5]] },
        { name: '备注', rows: [['说明'], ['含空单元格'], ['', '右侧有值']] },
      ],
    });
    const doc = await parseOffice('data.xlsx', buf);
    expect(doc.kind).toBe('xlsx');
    expect(doc.sheets!.map(s => s.name)).toEqual(['数据', '备注']);
    expect(doc.sheets![0].rows[0]).toEqual(['月份', '销量']);
    expect(doc.sheets![0].rows[2]).toEqual(['二月', '98.5']);
    expect(doc.sheets![1].rows[2]).toEqual(['', '右侧有值']);
  });
});

describe('U3→U1 pptx 往返', () => {
  it('每页标题与要点都能读回', async () => {
    const buf = buildPptx({
      slides: [
        { title: '封面', bullets: ['2026 年度总结'] },
        { title: '业绩', bullets: ['营收 +25%', '成本 -8%', '净利 +33%'] },
      ],
    });
    const doc = await parseOffice('deck.pptx', buf);
    expect(doc.kind).toBe('pptx');
    expect(doc.slides!.length).toBe(2);
    expect(doc.slides![1].title).toBe('业绩');
    expect(doc.slides![1].bullets).toEqual(['营收 +25%', '成本 -8%', '净利 +33%']);
  });
});

describe('U1 边界：agent 会拿它读任意文件，解析器不许炸', () => {
  it('扩展名对但内容是垃圾 → 抛可读错误，不是未捕获异常', async () => {
    await expect(parseOffice('fake.docx', Buffer.from('not a zip')))
      // 错误文案会原样出现在预览卡上：必须是中文人话，不能是 yauzl 的英文原文
      .rejects.toThrow(/不是一个有效的 OOXML 包/);
  });
  it('是 zip 但缺主文档部件 → 明确报缺件', async () => {
    const buf = writeZip([{ path: 'hello.txt', data: Buffer.from('hi') }]);
    await expect(parseOffice('empty.docx', buf)).rejects.toThrow(/缺少|找不到/);
  });
  it('不认识的扩展名 → 明说不支持（照 OfficeCLI 的教训，不给假希望）', async () => {
    await expect(parseOffice('old.doc', Buffer.from('x'))).rejects.toThrow(/不支持/);
  });
});

/** F10A 追加：生成器开始写列表、段内换行与制表符，解析器必须读得回来——
 *  否则自己生成的文档读回会丢结构，内容核验也比不了。 */
describe('F10A docx 往返：列表、段内换行、制表符', () => {
  it('有序 / 无序 / 两级列表：读回有序与否、级别与序号', async () => {
    const doc = await parseOffice('l.docx', buildDocx({
      blocks: [
        { kind: 'list', ordered: true, items: ['第一', { text: '第一之一', level: 1 }, { text: '第一之二', level: 1 }, '第二'] },
        { kind: 'para', text: '中间一段' },
        { kind: 'list', items: ['圆点', { text: '二级圆点', level: 1 }] },
        { kind: 'list', ordered: true, items: ['重新从一开始'] },
      ],
    }));
    expect(doc.blocks).toEqual([
      { kind: 'para', text: '第一', list: { ordered: true, level: 0, index: 1 } },
      { kind: 'para', text: '第一之一', list: { ordered: true, level: 1, index: 1 } },
      { kind: 'para', text: '第一之二', list: { ordered: true, level: 1, index: 2 } },
      { kind: 'para', text: '第二', list: { ordered: true, level: 0, index: 2 } },
      { kind: 'para', text: '中间一段' },
      { kind: 'para', text: '圆点', list: { ordered: false, level: 0, index: 1 } },
      { kind: 'para', text: '二级圆点', list: { ordered: false, level: 1, index: 1 } },
      { kind: 'para', text: '重新从一开始', list: { ordered: true, level: 0, index: 1 } },
    ]);
  });

  it('段内换行与制表符原样读回；单元格里的换行也在', async () => {
    const doc = await parseOffice('n.docx', buildDocx({
      blocks: [
        { kind: 'para', text: '第一行\n第二行\t制表之后' },
        { kind: 'table', rows: [['上\n下', '左\t右'], ['a', 'b']] },
      ],
    }));
    expect(doc.blocks[0]).toEqual({ kind: 'para', text: '第一行\n第二行\t制表之后' });
    expect(doc.blocks[1]).toEqual({ kind: 'table', rows: [['上\n下', '左\t右'], ['a', 'b']] });
  });

  it('分页符与间隔段落不算内容：读回只有前后两段', async () => {
    const doc = await parseOffice('b.docx', buildDocx({ blocks: [{ kind: 'para', text: '前' }, { kind: 'pageBreak' }, { kind: 'para', text: '后' }, { kind: 'table', rows: [['末']] }] }));
    expect(doc.blocks).toEqual([{ kind: 'para', text: '前' }, { kind: 'para', text: '后' }, { kind: 'table', rows: [['末']] }]);
  });

  it('别的程序写的包：自闭合的空段落不吞掉下一段；单元格里多个段落用换行连接；没有 numbering 的 numPr 当普通段落', async () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const xml = `<?xml version="1.0"?><w:document ${W}><w:body>` +
      `<w:p w:rsidR="00A1"/><w:p><w:r><w:t>甲</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>编号查不到</w:t></w:r></w:p>` +
      `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>一</w:t></w:r></w:p><w:p><w:r><w:t>二</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
      `<w:p><w:r><w:t>软</w:t><w:br/><w:t>回车</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>` +
      `</w:body></w:document>`;
    const doc = await parseOffice('f.docx', writeZip([{ path: 'word/document.xml', data: Buffer.from(xml, 'utf8') }]));
    expect(doc.blocks).toEqual([
      { kind: 'para', text: '甲' },
      { kind: 'para', text: '编号查不到' },
      { kind: 'table', rows: [['一\n二']] },
      { kind: 'para', text: '软\n回车' },
    ]);
  });
});
