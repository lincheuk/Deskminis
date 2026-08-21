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
