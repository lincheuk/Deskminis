/** MU2a Task 1：流式稳定前缀切分（决策 3）。
 *  stablePrefixEnd(src) 返回「最后完整块边界」：
 *  成对空行（\n\n，兼容 \r\n\r\n）之后、且前缀内代码围栏已闭合的最后一个偏移。
 *  无可用边界返回 0（调用方把整个 src 当尾部重解析）。 */

export function stablePrefixEnd(src: string): number {
  const re = /\n\r?\n/g;
  const boundaries: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) boundaries.push(m.index + m[0].length);
  for (let k = boundaries.length - 1; k >= 0; k--) {
    if (fenceClosed(src.slice(0, boundaries[k]))) return boundaries[k];
  }
  return 0;
}

/** 前缀内 ``` 围栏是否成对闭合（按行判定，行首三个反引号计一次开/合）。 */
function fenceClosed(s: string): boolean {
  let count = 0;
  for (const line of s.split('\n')) {
    if (/^```/.test(line)) count++;
  }
  return count % 2 === 0;
}
