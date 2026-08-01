/** Composer 自适应长高（MU2b Task 6，设计 §5.5）：按 \n 数 + 长行折估行数，clamp 1..maxRows。
 *  折估：composer 实际宽度下每可视行约 48 个半角字（15px 字号经验值）；
 *  宁可多估不可少估——少估会把已输入的可视行切出视口。 */
const CHARS_PER_ROW = 48;

export function rowsFor(text: string, maxRows = 8): number {
  let rows = 0;
  for (const ln of text.split('\n')) rows += Math.max(1, Math.ceil(ln.length / CHARS_PER_ROW));
  return Math.min(maxRows, Math.max(1, rows));
}
