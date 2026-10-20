/** 格式处理器的契约（F10A）：docx / xlsx / pptx 各实现一份，`tools/office.ts` 按扩展名分发。
 *
 *  为什么要这一层：三种格式原先写在同一个文件里，谁改 Word 都得碰 Excel 与 PowerPoint 的代码。
 *  拆开之后 F10B 只改 `office/xlsx/*`、F10C 只改 `office/pptx/*`，公共流程（权限、取消、落盘）
 *  留在 `tools/office.ts` 一处。
 *
 *  处理器是**纯代码**：拿不到 ToolContext，不碰文件、不问权限、不起进程——
 *  所以权限调用方名单与调度声明都不用因为它而改动。
 *
 *  这个文件只许追加成员，不许改已有成员的语义（F10B / F10C 直接消费）。 */
import type { OfficeDoc } from './parse';
import type { OfficeFormat, OfficeSubject, OfficeVerification } from '../../shared/office-verification';

export type { OfficeFormat };

/** 输入不可用。message 是给模型看的一句中文，原样进「生成失败：…」。 */
export class OfficeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeInputError';
  }
}

export interface OfficeWritePlan {
  /** 如 'Word 文档，12 个块'：权限预览与成功输出的首行都用它 */
  summary: string;
  /** 全部字节；同输入同字节 */
  bytes: Buffer;
  /** 未采用的字段、被清掉的字符、被跳过的空表……每条一行进工具输出 */
  notes: readonly string[];
  /** 内容核验：只看 bytes，不读盘、无副作用。不实现 = 这种格式还没接入（输出「内容核验：未核验」）。 */
  verifyContent?(subject: OfficeSubject): Promise<OfficeVerification>;
}

export interface OfficeFormatHandler {
  readonly format: OfficeFormat;
  /** 版式行文案里的程序名 */
  readonly app: 'Word' | 'Excel' | 'PowerPoint';
  /** 拼进 office_write 的 description（brief）与 content 参数说明（content） */
  readonly help: { readonly brief: string; readonly content: string };
  /** 同步、纯函数。输入不可用时抛错（OfficeInputError 的 message 原样给模型） */
  plan(spec: Record<string, unknown>): OfficeWritePlan;
  /** 覆盖已有文件前的判定：在落盘入口的 produce(before) 里同步调用，before 是替换前的原字节（长度 > 0）。
   *  返回字符串 = 不覆盖，整句原样给模型；不实现 = 照旧覆盖。 */
  refuseOverwrite?(before: Buffer, abs: string): string | undefined;
  /** 文档内容的文本（docToText 的本格式分支）；只有内容，不带任何给模型的提示 */
  toText(doc: OfficeDoc): string;
  /** office_read 追加在正文之后的一行说明（没提取到什么、想改该怎么办）。只由 office_read 工具追加，
   *  不进 toText / docToText：文件检查点的对比用的是 docToText，对比文本里不该混进给模型的提示。不实现 = 不追加。 */
  readNote?(doc: OfficeDoc): string | undefined;
}
