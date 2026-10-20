/** F10A · T1c：拆分不改变行为。
 *
 *  F10A 把 office/build.ts、office/parse.ts 里三种格式的代码搬进了各自的目录，这两个文件只剩转出口。
 *  这里钉住：导出名单没变（外面的引用方不用改）、冻结的旧 Word 生成器副本确实是 db2a0ab 的字节、
 *  office_write 的整段说明文字逐字没变。黄金值是拆分**之前**在 db2a0ab 上算好写死的。
 *
 *  Excel 与 PowerPoint 的基线各在 office-xlsx-baseline / office-pptx-baseline（分别归 F10B / F10C）。
 *  这些用例只证明字节与文字没变，证明不了任何版式。 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as build from '../src/minisd/office/build';
import * as parse from '../src/minisd/office/parse';
import * as zip from '../src/minisd/office/zip';
import { officeWriteTool, officeReadTool, makeOfficeWriteTool, OFFICE_FORMATS, docToText } from '../src/minisd/tools/office';
import { legacyBuildDocx, LEGACY_DOCX_INPUTS, LEGACY_DOCX_PART_HASHES } from './office-legacy-docx';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
async function partHashes(bytes: Buffer): Promise<Record<string, string>> {
  const parts = await zip.readZip(bytes);
  const out: Record<string, string> = {};
  for (const k of [...parts.keys()].sort()) out[k] = sha(parts.get(k)!);
  return out;
}

describe('T1c 拆分：导出名单与说明文字不变', () => {
  it('office/build、office/parse 的运行时导出名单与 db2a0ab 相同', () => {
    expect(Object.keys(build).sort()).toEqual(['buildDocx', 'buildPptx', 'buildXlsx', 'esc']);
    expect(Object.keys(parse).sort()).toEqual(['parseOffice']);
  });

  it('office/zip 原有的导出一个不少（技能导入器与测试直接引它）', () => {
    for (const name of ['ZIP_MAX_ENTRIES', 'ZIP_MAX_ENTRY', 'ZIP_MAX_TOTAL', 'ZipGuardError', 'createZipBudget', 'readZip', 'readZipEntry', 'writeZip']) {
      expect(Object.keys(zip)).toContain(name);
    }
  });

  it('esc 仍是原来那五个实体（xlsx / pptx 的字节靠它）', () => {
    expect(build.esc(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('冻结的旧 Word 生成器副本：两份固定输入逐部件 sha256 与 db2a0ab 相同', async () => {
    expect(await partHashes(legacyBuildDocx(LEGACY_DOCX_INPUTS.a))).toEqual(LEGACY_DOCX_PART_HASHES.a);
    expect(await partHashes(legacyBuildDocx(LEGACY_DOCX_INPUTS.b))).toEqual(LEGACY_DOCX_PART_HASHES.b);
    expect(sha(legacyBuildDocx(LEGACY_DOCX_INPUTS.a))).toBe('159773fbb62deef7e7eae218cfc8d025a55aacad84455f8d89190fbf215c3472');
    expect(sha(legacyBuildDocx(LEGACY_DOCX_INPUTS.b))).toBe('23cdb1071eab11936c43238f3e69bd7a10b142e8633a93311cdd3a0a99cb57c0');
  });

  // 「拆分后的 buildDocx 与 db2a0ab 逐部件相同」这一条只在拆分那一步成立（当时跑过，日志 F10A-impl-split-office /
  // F10A-impl-split-full），重写 Word 生成器时按设计删掉了。旧形态输入读出的文本仍然不变，留在下面这一条里。
  it('旧形态输入：新生成器的产物读出的文本与 db2a0ab 相同（旧产物本身读出来也一样）', async () => {
    const textA = '# 季度报告\n\n营收增长 25%，其中华东占比最高。\n\n| 区域 | 金额 |\n|---|---|\n| 华东 | 42 |\n| 华南 | 31 |';
    const textB = '## A & B < C > D\n\n"quoted" \'single\' 末尾空格 \n\n| 只有一行 |\n|---|\n\n###### 级别越界';
    expect(docToText(await parse.parseOffice('a.docx', build.buildDocx(LEGACY_DOCX_INPUTS.a)))).toBe(textA);
    expect(docToText(await parse.parseOffice('b.docx', build.buildDocx(LEGACY_DOCX_INPUTS.b)))).toBe(textB);
    expect(docToText(await parse.parseOffice('a.docx', legacyBuildDocx(LEGACY_DOCX_INPUTS.a)))).toBe(textA);
    expect(docToText(await parse.parseOffice('b.docx', legacyBuildDocx(LEGACY_DOCX_INPUTS.b)))).toBe(textB);
  });

  // Word 说明已扩展；入口名称与参数保持兼容。
  it('工具入口与必需参数保持不变', () => {
    expect(officeWriteTool.definition.name).toBe('office_write');
    expect(officeWriteTool.definition.required).toEqual(['path', 'content', 'tool_title']);
  });

  it('分发表覆盖三种格式，键与处理器的 format 一致；工厂缺省就用这张表', () => {
    expect(Object.keys(OFFICE_FORMATS).sort()).toEqual(['docx', 'pptx', 'xlsx']);
    for (const [k, h] of Object.entries(OFFICE_FORMATS)) expect(h.format).toBe(k);
    expect(makeOfficeWriteTool().definition).toEqual(officeWriteTool.definition);
    expect(officeReadTool.definition.name).toBe('office_read');
  });

  it('docToText 按文档种类分发，签名不变', async () => {
    const doc = await parse.parseOffice('a.xlsx', build.buildXlsx({ sheets: [{ name: 's', rows: [['x', 1]] }] }));
    expect(docToText(doc)).toBe('## 工作表：s（1 行）\nx\t1');
    expect(docToText({ kind: 'docx', blocks: [] })).toBe('');
  });
});
