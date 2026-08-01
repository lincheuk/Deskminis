/** file_edit 工具载荷提取（设计 v2 §5.4）：从工具 input JSON 取 path/old_string/new_string，
 *  缺字段或坏 JSON → null（调用方回落 JSON 展开）。路径相对化：guest 前缀与数据根
 *  sessions/<sid>/<bucket>/ 结构前缀剥掉（结构识别，不硬编码数据根）。 */
export interface EditPair {
  path: string;   // 相对路径（workspace 桶去前缀；其它命名空间留名如 memory/x.md）
  oldStr: string;
  newStr: string;
}

/** 显示用相对路径：/var/minis/workspace/a.txt → a.txt；/var/minis/memory/x.md → memory/x.md；
 *  C:\…\sessions\<sid>\workspace\sub\a.txt → sub\a.txt；相对路径原样。反斜杠归一为 /。 */
export function relativizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  const guest = s.match(/^\/var\/minis\/([^/]+)\/(.*)$/);
  if (guest) return guest[1] === 'workspace' ? guest[2] : `${guest[1]}/${guest[2]}`;
  const host = s.match(/\/sessions\/[^/]+\/(workspace|attachments|offloads|browser)\/(.*)$/);
  if (host) return host[1] === 'workspace' ? host[2] : `${host[1]}/${host[2]}`;
  return s;
}

export function extractEditPair(inputJson: string | null | undefined): EditPair | null {
  if (inputJson == null || inputJson === '') return null;
  let o: unknown;
  try { o = JSON.parse(inputJson); } catch { return null; }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.path !== 'string' || typeof r.old_string !== 'string') return null;
  return {
    path: relativizePath(r.path),
    oldStr: r.old_string,
    newStr: typeof r.new_string === 'string' ? r.new_string : '',
  };
}
