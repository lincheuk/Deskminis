/** F10A · T6：Word 的内容核验（verifyDocxContent，引擎 deskminis-readback）。
 *
 *  它是「核验不过就不写文件」的那一道，所以两头都要钉住：改坏的字节必须判成不过，合法的输入绝不能误报
 *  （三百份固定种子的随机输入）。它查的是包与文字，**不是版式**——这里通过的文档在 Word 里长什么样，这里一概不知道。
 *  只测纯函数；「核验不过就不写」「核验过程出错照常写入」两条工具级断言在 office-write-flow（接线之后）。 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readZip, writeZip } from '../src/minisd/office/zip';
import { normalizeDocx, type DocxInput } from '../src/minisd/office/docx/model';
import { renderDocx } from '../src/minisd/office/docx/build';
import { expectedContent, verifyDocxContent } from '../src/minisd/office/docx/content-check';
import { parseDocx } from '../src/minisd/office/docx/parse';
import { officeVerificationLine, type OfficeVerification } from '../src/shared/office-verification';
import { DOCX_FIXTURES } from './office-docx-fixtures';
import { randomDocxInput } from './office-docx-random';

const subjectOf = (b: Buffer): { sha256: string; size: number } => ({ sha256: createHash('sha256').update(b).digest('hex'), size: b.length });
async function check(input: DocxInput, tamper?: (parts: Map<string, Buffer>) => void | Buffer): Promise<OfficeVerification> {
  const model = normalizeDocx(input).model;
  let bytes = renderDocx(model);
  if (tamper) {
    const parts = await readZip(bytes);
    const replaced = tamper(parts);
    bytes = replaced ?? writeZip([...parts].map(([path, data]) => ({ path, data })));
  }
  return verifyDocxContent(bytes, model, subjectOf(bytes));
}
const editPart = (name: string, fn: (xml: string) => string) => (parts: Map<string, Buffer>): void => {
  const before = parts.get(name)!.toString('utf8');
  const after = fn(before);
  if (after === before) throw new Error(`没有改到 ${name}`);
  parts.set(name, Buffer.from(after, 'utf8'));
};
const failedIds = (v: OfficeVerification): readonly string[] => (v.status === 'failed' ? v.failed : []);

const SAMPLE: DocxInput = {
  title: '样本',
  blocks: [
    { kind: 'heading', level: 2, text: '二级标题' },
    { kind: 'para', text: '第一段' },
    { kind: 'para', text: '第二段\n有换行\t有制表' },
    { kind: 'list', ordered: true, items: ['甲', { text: '乙', level: 1 }, '丙'] },
    { kind: 'table', rows: [['名称', '数值'], ['甲', '1']] },
  ],
};

describe('T6 好文件', () => {
  it('→ verified；一行文案写明比的是本次输入、不涉及版式', async () => {
    const v = await check(SAMPLE);
    expect(v.status).toBe('verified');
    expect(v.aspect).toBe('content');
    expect(v.status === 'verified' && v.engine).toEqual({ id: 'deskminis-readback', version: '1' });
    expect(v.status === 'verified' && v.checks.map(c => c.id)).toEqual(['parts', 'xml', 'roundtrip']);
    // 标题 1 + 段落 2 + 列表项 3 + 表格 1 = 7 项
    expect(officeVerificationLine(v)).toBe('内容核验：通过（deskminis-readback；生成文件回读与本次输入的 7 项一致；不涉及版式，也不代表与其它文档一致）');
  });

  it('核验结论绑定的是被核验的那份字节', async () => {
    const bytes = renderDocx(normalizeDocx(SAMPLE).model);
    const v = await verifyDocxContent(bytes, normalizeDocx(SAMPLE).model, subjectOf(bytes));
    expect(v.subject).toEqual(subjectOf(bytes));
  });

  it('全部固定夹具 → verified', async () => {
    for (const [name, make] of Object.entries(DOCX_FIXTURES)) expect((await check(make())).status, name).toBe('verified');
  });
});

describe('T6 改坏的字节', () => {
  it('去掉一个部件 → failed / parts', async () => {
    const v = await check(SAMPLE, parts => { parts.delete('word/styles.xml'); });
    expect(failedIds(v)).toEqual(['parts']);
    expect(v.message).toContain('word/styles.xml');
  });

  it('关系指向不存在的部件、内容类型没有登记 → failed / parts', async () => {
    const dangling = await check(SAMPLE, editPart('word/_rels/document.xml.rels', s => s.replace('Target="settings.xml"', 'Target="nowhere.xml"')));
    expect(failedIds(dangling)).toEqual(['parts']);
    expect(dangling.message).toContain('word/nowhere.xml');
    const untyped = await check(SAMPLE, parts => { parts.set('word/media/image1.png', Buffer.from([1, 2, 3])); });
    expect(failedIds(untyped)).toEqual(['parts']);
    expect(untyped.message).toContain('内容类型里没有登记 word/media/image1.png');
  });

  it('写入未转义的 & → failed / xml，点出是哪个部件', async () => {
    const v = await check(SAMPLE, editPart('word/document.xml', s => s.replace('第一段', '第一段 & 之后')));
    expect(failedIds(v)).toEqual(['xml']);
    expect(v.message).toContain('word/document.xml');
    const cut = await check(SAMPLE, editPart('word/styles.xml', s => s.replace('</w:styles>', '')));
    expect(failedIds(cut)).toEqual(['xml']);
  });

  it('删一段 → failed / roundtrip，where 写第一个不同的块', async () => {
    const v = await check(SAMPLE, editPart('word/document.xml', s => s.replace(/<w:p><w:pPr><w:pStyle w:val="BodyText"\/><\/w:pPr><w:r><w:rPr><w:rFonts w:hint="eastAsia"\/><\/w:rPr><w:t xml:space="preserve">第一段<\/w:t><\/w:r><\/w:p>/, '')));
    expect(failedIds(v)).toEqual(['roundtrip']);
    expect(v.status === 'failed' && v.checks.find(c => c.id === 'roundtrip')?.where).toBe('第 2 块');
  });

  it('换两段顺序、改一个字、改一格 → failed / roundtrip', async () => {
    const swapped = await check(SAMPLE, editPart('word/document.xml', s => s.replace('第一段', '#TMP#').replace('第二段', '第一段').replace('#TMP#', '第二段')));
    expect(failedIds(swapped)).toEqual(['roundtrip']);
    const typo = await check(SAMPLE, editPart('word/document.xml', s => s.replace('二级标题', '二级标提')));
    expect(failedIds(typo)).toEqual(['roundtrip']);
    const cell = await check(SAMPLE, editPart('word/document.xml', s => s.replace('>数值<', '>数字<')));
    expect(failedIds(cell)).toEqual(['roundtrip']);
  });

  it('列表的序号对不上（把有序改成无序的定义）→ failed / roundtrip', async () => {
    const v = await check(SAMPLE, editPart('word/numbering.xml', s => s.replace('<w:num w:numId="1"><w:abstractNumId w:val="1"/>', '<w:num w:numId="1"><w:abstractNumId w:val="0"/>')));
    expect(failedIds(v)).toEqual(['roundtrip']);
  });

  it('截掉一半的字节（ZIP 读不出）→ failed / parts，verifyDocxContent 自己不抛错', async () => {
    const v = await check(SAMPLE, parts => { const whole = writeZip([...parts].map(([path, data]) => ({ path, data }))); return whole.subarray(0, Math.floor(whole.length / 2)); });
    expect(failedIds(v)).toEqual(['parts']);
    expect(v.message).toContain('生成的包读不回来');
  });

  it('去掉 word/document.xml → failed / parts', async () => {
    const v = await check(SAMPLE, parts => { parts.delete('word/document.xml'); });
    expect(failedIds(v)).toEqual(['parts']);
  });

  it('不是 ZIP 的字节 → failed / parts', async () => {
    const model = normalizeDocx(SAMPLE).model;
    const junk = Buffer.from('这不是一个 zip');
    const v = await verifyDocxContent(junk, model, subjectOf(junk));
    expect(failedIds(v)).toEqual(['parts']);
  });
});

describe('T6 期望内容与解析器同一套约定', () => {
  it('空白段落、分页符、间隔段落不出现；列表序号按级别计、出现更浅的级别时更深的归零', () => {
    const model = normalizeDocx({ blocks: [
      { kind: 'para', text: '   ' }, { kind: 'heading', text: '' }, { kind: 'pageBreak' },
      { kind: 'list', ordered: true, items: ['一', { text: '一之一', level: 1 }, { text: '一之二', level: 1 }, '二', { text: '二之一', level: 1 }] },
      { kind: 'list', items: ['点'] },
      { kind: 'table', rows: [['a', '']] }, { kind: 'table', rows: [['b']] },
    ] }).model;
    expect(expectedContent(model)).toEqual([
      { kind: 'para', text: '一', list: { ordered: true, level: 0, index: 1 } },
      { kind: 'para', text: '一之一', list: { ordered: true, level: 1, index: 1 } },
      { kind: 'para', text: '一之二', list: { ordered: true, level: 1, index: 2 } },
      { kind: 'para', text: '二', list: { ordered: true, level: 0, index: 2 } },
      { kind: 'para', text: '二之一', list: { ordered: true, level: 1, index: 1 } },
      { kind: 'para', text: '点', list: { ordered: false, level: 0, index: 1 } },
      { kind: 'table', rows: [['a', '']] },
      { kind: 'table', rows: [['b']] },
    ]);
  });

  it('解析器读回的正是这份期望（含段内换行、制表符、单元格里的换行）', async () => {
    const model = normalizeDocx({ blocks: [
      { kind: 'para', text: '甲\n乙\t丙' }, { kind: 'table', rows: [['上\n下', 'x']] },
      { kind: 'list', items: [{ text: '深', level: 2 }, '浅'] },
    ] }).model;
    const got = parseDocx(await readZip(renderDocx(model))).blocks;
    expect(got).toEqual(expectedContent(model));
    expect(got[0].text).toBe('甲\n乙\t丙');
    expect(got[1].rows).toEqual([['上\n下', 'x']]);
  });
});

describe('T6 防误报', () => {
  it('三百份固定种子的随机合法输入（空白文本、控制字符、换行、嵌套列表、空表、各字段的非默认值）全部 verified', async () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const input = randomDocxInput(seed);
      for (const b of input.blocks) kinds.add(b.kind);
      const v = await check(input);
      expect(v.status, `seed ${seed}: ${v.message}`).toBe('verified');
    }
    // 生成器确实走到了五种块
    expect([...kinds].sort()).toEqual(['heading', 'list', 'pageBreak', 'para', 'table']);
  });
});
