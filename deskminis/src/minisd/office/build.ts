/** U3：OOXML 生成——产出能被 Word / Excel / PowerPoint 正常打开的文件。
 *
 *  每种格式都是同一套骨架：`[Content_Types].xml` 声明部件类型、`_rels/.rels` 指向主文档、
 *  主文档自身，再加各格式必需的少量附件。
 *
 *  设计参考 OfficeCLI 的能力分层：它的 L1 是 create + 结构化写入，我们对应到这一层；
 *  它的 L2（DOM 精改）需要完整 OOXML 对象模型，留候选。
 *
 *  F10A 起这个文件**只剩转出口**：三种格式各自成目录，之后改哪种格式就只动哪个目录——
 *  Word 在 `docx/`（F10A），Excel 在 `xlsx/`（F10B），PowerPoint 在 `pptx/`（F10C）；
 *  共用的 XML 小件在 `xml.ts`。导出名与签名不变，原有的引用方不用改。 */
export { esc } from './xml';
export { buildDocx, type DocxBlock, type DocxInput } from './docx/build';
export { buildXlsx, type XlsxSheet, type XlsxInput } from './xlsx/build';
export { buildPptx, type PptxSlide, type PptxInput } from './pptx/build';
