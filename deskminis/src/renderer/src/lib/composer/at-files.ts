/** L2 @ 文件引用（设计稿 2026-08-20-pool-batch-design.md §2）。
 *
 *  与斜杠菜单的语义差异（调研点名）：slash 是**整行首 token**，@ 是**光标处 token**——
 *  用户可以在长句中途 @ 出文件路径。选中后把 `@片段`（含 @）换成工作区相对路径文本：
 *  agent 读的是纯文本路径（file_read 自己去打开），零协议开销。
 *  纯模块：不碰 DOM 不碰 rpc；受限递归的 IO 经注入的 list 回调，方便假树穷举边界。 */

/** 光标前文本里的 @ token 判定。@ 必须在行首或空白后（邮箱 a@b 不劫持）；
 *  返回 @ 后的片段（可为空串——刚敲下 @），非 token 位置返回 null。 */
const AT_RE = /(?:^|\s)@([^\s@]*)$/;

export function atToken(before: string): string | null {
  const m = AT_RE.exec(before);
  return m ? m[1] : null;
}

/** 模糊匹配：文件名前缀（0）> 文件名子串（1）> 路径子串（2），同权重按路径字典序稳定；
 *  大小写不敏感；取前 8（slashmenu 同款容量）。空片段 = 全量前 8（刚敲 @ 先给个概览）。 */
export function atMatch(paths: readonly string[], q: string): string[] {
  if (q === '') return paths.slice(0, 8);
  const needle = q.toLowerCase();
  const scored: { p: string; w: number }[] = [];
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    const w = base.startsWith(needle) ? 0 : base.includes(needle) ? 1 : p.toLowerCase().includes(needle) ? 2 : -1;
    if (w >= 0) scored.push({ p, w });
  }
  scored.sort((a, b) => a.w - b.w || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return scored.slice(0, 8).map(s => s.p);
}

/** 把光标前的 `@片段`（含 @ 本身）替换为 path + 尾空格，光标落在空格后；
 *  光标后的文本原样保留。光标前无 token 时返回 null——调用方不动输入框。 */
export function applyAt(text: string, caret: number, path: string): { text: string; caret: number } | null {
  const m = AT_RE.exec(text.slice(0, caret));
  if (!m) return null;
  const start = caret - m[1].length - 1; // 回退到 @ 本身
  const inserted = path + ' ';
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length };
}

/** 受限递归跳过的目录名（设计 §2 点名七项）：体积怪不进补全池，也不发多余请求。 */
export const AT_SKIP_DIRS = ['.git', 'node_modules', 'out', 'dist', 'build', '__pycache__', '.venv'];

/** files.list（单层懒加载语义不动）之上的前端受限递归：BFS 收集文件相对路径。
 *  深度 ≤4（根为第 1 层；第 4 层目录不再下探）、总数 ≤500（到顶即停 + truncated 标记，
 *  上限不静默——菜单尾行明示）；单目录 list 失败跳过不废整树（权限/竞态删除都可能）。
 *  BFS 而非 DFS：浅层文件优先进名单——@ 补全常用的恰是浅层文件。 */
export async function collectFiles(
  list: (dir?: string) => Promise<readonly { name: string; path: string; kind: 'dir' | 'file' }[]>,
  limits: { depth?: number; total?: number } = {},
): Promise<{ paths: string[]; truncated: boolean }> {
  const maxDepth = limits.depth ?? 4;
  const maxTotal = limits.total ?? 500;
  const paths: string[] = [];
  const queue: { dir: string | undefined; level: number }[] = [{ dir: undefined, level: 1 }];
  while (queue.length > 0) {
    const { dir, level } = queue.shift()!;
    let entries: readonly { name: string; path: string; kind: 'dir' | 'file' }[];
    try { entries = await list(dir); } catch { continue; }
    for (const e of entries) {
      if (e.kind === 'file') {
        if (paths.length >= maxTotal) return { paths, truncated: true };
        paths.push(e.path);
      } else if (level < maxDepth && !AT_SKIP_DIRS.includes(e.name)) {
        queue.push({ dir: e.path, level: level + 1 });
      }
    }
  }
  return { paths, truncated: false };
}
