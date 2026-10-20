/** Conservative overwrite inspection; no IO, permissions or document regeneration. */
import {dirname, basename, join} from 'node:path';
import {listZipSync, readZipEntrySync} from '../zip';
import {checkWellFormed, unesc} from '../xml';
import {DOCX_APPLICATION, footerXml} from './parts';

export const DOCX_LEGACY_PARTS: readonly string[] = ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/document.xml'];
export const DOCX_OWN_PARTS: ReadonlySet<string> = new Set([...DOCX_LEGACY_PARTS,
  'docProps/core.xml', 'docProps/app.xml', 'word/settings.xml', 'word/fontTable.xml', 'word/numbering.xml', 'word/footer1.xml']);
export const DOCX_OWN_ELEMENTS: ReadonlySet<string> = new Set(('b bCs body bottom br cantSplit document footerReference gridCol ilvl ind insideH insideV jc keepNext left numId numPr p pageBreakBefore pgMar pgSz pPr pStyle r rFonts right rPr sectPr shd spacing t tab tbl tblBorders tblCellMar tblGrid tblHeader tblInd tblLayout tblPr tblW tc tcPr tcW top tr trPr vAlign').split(' ').map(n => `w:${n}`));
export type DocxOrigin = 'deskminis' | 'deskminis-legacy' | 'other';
export interface DocxInventory { origin: DocxOrigin | 'unreadable'; why?: string; lost: {label: string; count: number}[] }

export function classifyDocx(names: Iterable<string>, appXml: string | undefined, documentXml: string | undefined, decodedParts?: ReadonlyMap<string, Buffer>): DocxOrigin {
  const parts = new Set(names);
  if (!documentXml || !parts.has('word/styles.xml') || !parts.has('[Content_Types].xml') || checkWellFormed(documentXml)) return 'other';
  if ([...parts].some(n => !DOCX_OWN_PARTS.has(n))) return 'other';
  // A generator marker cannot prove that a supported footer part still contains only our PAGE field.
  if (parts.has('word/footer1.xml') && decodedParts?.get('word/footer1.xml')?.toString('utf8') !== footerXml()) return 'other';
  const elements = [...documentXml.matchAll(/<([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*|[A-Za-z_][\w.-]*)[\s/>]/g)].map(m => m[1]);
  if (!elements.includes('w:document') || !elements.includes('w:body') || elements.some(n => !DOCX_OWN_ELEMENTS.has(n))) return 'other';
  const app = /<(?:\w+:)?Application(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Application>/.exec(appXml ?? '')?.[1];
  if (app !== undefined && !checkWellFormed(appXml!) && unesc(app).trim() === DOCX_APPLICATION) return 'deskminis';
  if (parts.size === DOCX_LEGACY_PARTS.length && DOCX_LEGACY_PARTS.every(n => parts.has(n))) return 'deskminis-legacy';
  return 'other';
}

export function docxLostParts(names: Iterable<string>, documentXml = '', commentsXml?: string): {label: string; count: number}[] {
  const parts = [...names], lost: {label: string; count: number}[] = [];
  const add = (label: string, count: number): void => { if (count > 0) lost.push({label, count}); };
  add('图片或媒体', parts.filter(n => n.startsWith('word/media/') && !n.endsWith('/')).length);
  add('页眉', parts.filter(n => /^word\/header[^/]*\.xml$/.test(n)).length);
  add('页脚', parts.filter(n => /^word\/footer[^/]*\.xml$/.test(n)).length);
  const commentParts = parts.filter(n => /^word\/comments[^/]*\.xml$/.test(n)).length;
  add('批注', commentsXml ? [...commentsXml.matchAll(/<(?:\w+:)?comment[\s>]/g)].length || commentParts : commentParts);
  for (const [tag, label] of [['footnoteReference','脚注'],['endnoteReference','尾注'],['ins|del','修订'],['drawing|pict','图形或文本框']] as const) {
    add(label,[...documentXml.matchAll(new RegExp(`<(?:\\w+:)?(?:${tag})[\\s/>]`,'g'))].length);
  }
  add('图表或嵌入对象', parts.filter(n => /^word\/(?:charts|embeddings|diagrams)\//.test(n) && !n.endsWith('/')).length);
  add('宏', parts.filter(n => /(?:^|\/)vbaProject\.bin$/i.test(n)).length);
  return lost;
}

export function inspectDocx(before: Buffer): DocxInventory {
  if (before.length > 32 * 1024 * 1024) return {origin:'unreadable', why:'文件过大', lost:[]};
  try {
    const entries = listZipSync(before), names = entries.map(e => e.name);
    const text = (name: string, limit: number): string | undefined => {
      const entry = entries.find(e => e.name === name);
      return entry && readZipEntrySync(before, entry, limit).toString('utf8');
    };
    const document = text('word/document.xml',32 * 1024 * 1024), app = text('docProps/app.xml',64 * 1024);
    const footer = text('word/footer1.xml',1024 * 1024);
    const decoded = new Map<string,Buffer>();
    if (footer !== undefined) decoded.set('word/footer1.xml',Buffer.from(footer));
    return {origin:classifyDocx(names,app,document,decoded), lost:docxLostParts(names,document,text('word/comments.xml',1024 * 1024))};
  } catch (e) {
    return {origin:'unreadable', why:e instanceof Error ? e.message : String(e), lost:[]};
  }
}
export function refuseDocxOverwrite(before: Buffer, abs: string): string | undefined {
  if (before.length === 0) return undefined;
  const inventory = inspectDocx(before);
  if (inventory.origin === 'deskminis' || inventory.origin === 'deskminis-legacy') return undefined;
  if (inventory.origin === 'unreadable') return `没有覆盖 ${abs}：原文件无法检查（${inventory.why}），不能确认覆盖不会丢内容。原文件没有改动；请换一个文件名另存。`;
  const lost = inventory.lost.map(p => `${p.label} ${p.count} ${p.label === '批注' ? '条' : '个'}`).join('、');
  const suggested = join(dirname(abs),`${basename(abs, '.docx')}-新.docx`);
  return `没有覆盖 ${abs}：它不是 office_write 可识别的生成文档${lost ? `，其中有 ${lost}` : ''}。office_write 只会整份生成新文档，不是在原文件上编辑；覆盖会丢掉这些内容和原有格式。原文件没有改动。请把 path 换成新文件名另存，例如 ${suggested}（得到的是按这次 content 新生成的文档，不是原文档的副本：原文档里没写进 content 的内容不会在里面），由用户决定要不要替换原文件。`;
}
