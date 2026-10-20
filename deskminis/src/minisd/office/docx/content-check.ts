/** Word 的内容核验（F10A，产品运行时；引擎 deskminis-readback）。
 *
 *  对**最终字节**做：把生成出来的包读回来，查包结构、XML 良构、读回的内容与本次输入是否一致。
 *  它查的是包与文字，**不是版式**——分页、字体是否被 Word 采用、表格是否越界，这里一概不知道；
 *  类型上它也只能出现在「内容核验」一行（见 shared/office-verification.ts 的硬规则）。
 *
 *  「生成的包读不回来」算不过（failed），不算核验过程出错：连自己都读不回来的包是最该拦住的情形。 */
import { readZip } from '../zip';
import { checkWellFormed } from '../xml';
import {
  officeVerified, officeFailed, type OfficeCheckItem, type OfficeSubject, type OfficeVerification,
} from '../../../shared/office-verification';
import type { DocxModel } from './model';
import { parseDocx, type DocBlock } from './parse';
import { docxPartNames } from './parts';

const ENGINE = { id: 'deskminis-readback', version: '1' } as const;

/** 模型在解析器眼里应有的样子。与解析器同一套约定：空白段落不出现；分页符与间隔段落不出现；
 *  列表序号按「同一 numId、同一级别递增，出现更浅的级别时更深的归零」计。 */
export function expectedContent(model: DocxModel): DocBlock[] {
  const out: DocBlock[] = [];
  for (const b of model.blocks) {
    if (b.kind === 'heading') {
      if (b.text.trim()) out.push({ kind: 'heading', level: b.level, text: b.text });
    } else if (b.kind === 'para') {
      if (b.text.trim()) out.push({ kind: 'para', text: b.text });
    } else if (b.kind === 'list') {
      const counters: number[] = [];
      for (const it of b.items) {
        counters[it.level] = (counters[it.level] ?? 0) + 1;
        counters.length = it.level + 1;
        out.push({ kind: 'para', text: it.text, list: { ordered: b.ordered, level: it.level, index: counters[it.level] } });
      }
    } else if (b.kind === 'table') {
      out.push({ kind: 'table', rows: b.rows.map(r => [...r]) });
    }
  }
  return out;
}

function sameBlock(a: DocBlock, b: DocBlock): boolean {
  if (a.kind !== b.kind || a.level !== b.level || a.text !== b.text) return false;
  if ((a.list === undefined) !== (b.list === undefined)) return false;
  if (a.list && b.list && (a.list.ordered !== b.list.ordered || a.list.level !== b.list.level || a.list.index !== b.list.index)) return false;
  if ((a.rows === undefined) !== (b.rows === undefined)) return false;
  if (a.rows && b.rows) {
    if (a.rows.length !== b.rows.length) return false;
    for (let r = 0; r < a.rows.length; r++) {
      if (a.rows[r].length !== b.rows[r].length) return false;
      for (let c = 0; c < a.rows[r].length; c++) if (a.rows[r][c] !== b.rows[r][c]) return false;
    }
  }
  return true;
}
const brief = (b: DocBlock | undefined): string => {
  if (!b) return '没有这一块';
  const t = b.kind === 'table' ? `${b.rows?.length ?? 0} 行的表格` : JSON.stringify((b.text ?? '').slice(0, 30));
  return `${b.kind}${b.list ? '（列表项）' : ''} ${t}`;
};

/** 关系文件的目标相对它所属部件的目录解析：`_rels/.rels` → 包根；`word/_rels/document.xml.rels` → `word/`。 */
function relTargets(relsName: string, xml: string): string[] {
  const base = relsName.replace(/_rels\/[^/]*$/, '');
  const out: string[] = [];
  for (const m of xml.matchAll(/<Relationship\s[^>]*?\bTarget="([^"]*)"[^>]*>/g)) {
    if (/\bTargetMode="External"/.test(m[0])) continue;
    out.push(m[1].startsWith('/') ? m[1].slice(1) : base + m[1]);
  }
  return out;
}

export async function verifyDocxContent(bytes: Buffer, model: DocxModel, subject: OfficeSubject): Promise<OfficeVerification> {
  const checks: OfficeCheckItem[] = [];
  const failParts = (actual: string): OfficeVerification =>
    officeFailed('content', subject, ENGINE, [{ id: 'parts', ok: false, actual }], `生成的包读不回来：${actual}`);

  // ---- parts：包读得出来、该有的部件都在、内容类型与关系对得上
  let parts: Map<string, Buffer>;
  try {
    parts = await readZip(bytes);
  } catch (e) {
    return failParts(e instanceof Error ? e.message : String(e));
  }
  const problems: string[] = [];
  for (const name of docxPartNames(model)) if (!parts.has(name)) problems.push(`缺少部件 ${name}`);
  const types = parts.get('[Content_Types].xml')?.toString('utf8') ?? '';
  const defaults = new Set([...types.matchAll(/<Default\s[^>]*?\bExtension="([^"]*)"/g)].map(m => m[1].toLowerCase()));
  const overrides = new Set([...types.matchAll(/<Override\s[^>]*?\bPartName="([^"]*)"/g)].map(m => m[1]));
  for (const name of parts.keys()) {
    if (name === '[Content_Types].xml') continue;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (!overrides.has('/' + name) && !defaults.has(ext)) problems.push(`内容类型里没有登记 ${name}`);
  }
  for (const [name, data] of parts) {
    if (!name.endsWith('.rels')) continue;
    for (const target of relTargets(name, data.toString('utf8'))) {
      if (!parts.has(target)) problems.push(`关系 ${name} 指向不存在的部件 ${target}`);
    }
  }
  if (problems.length > 0) return failParts(problems[0]);
  checks.push({ id: 'parts', ok: true });

  // ---- xml：每个 XML 部件良构
  for (const [name, data] of parts) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const bad = checkWellFormed(data.toString('utf8'));
    if (bad) {
      checks.push({ id: 'xml', ok: false, where: name, actual: bad });
      return officeFailed('content', subject, ENGINE, checks, `部件 ${name} 不是良构的 XML：${bad}`);
    }
  }
  checks.push({ id: 'xml', ok: true });

  // ---- roundtrip：读回的内容与本次输入逐块相等
  let got: DocBlock[];
  try {
    got = parseDocx(parts).blocks;
  } catch (e) {
    return failParts(e instanceof Error ? e.message : String(e));
  }
  const want = expectedContent(model);
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++) {
    if (i < want.length && i < got.length && sameBlock(want[i], got[i])) continue;
    checks.push({ id: 'roundtrip', ok: false, where: `第 ${i + 1} 块`, expected: brief(want[i]), actual: brief(got[i]) });
    return officeFailed('content', subject, ENGINE, checks, `读回的内容与输入不一致（第 ${i + 1} 块：应为 ${brief(want[i])}，读回 ${brief(got[i])}）`);
  }
  checks.push({ id: 'roundtrip', ok: true });

  // 限定语不能省：回读只拿本次输入去比，没有读过任何别的文档
  return officeVerified('content', subject, ENGINE, checks,
    `生成文件回读与本次输入的 ${want.length} 项一致；不涉及版式，也不代表与其它文档一致`);
}
