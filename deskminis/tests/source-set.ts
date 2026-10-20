/** Q20：主进程接线的文本守卫读“一组文件拼起来的文本”，不写死单一路径。
 *
 *  为什么还按文本守：主进程（src/main/**）在 Electron 的 Node 模式下起不来，这部分接线没法在测试里装配起来再查，
 *  文本守卫是有意的替代（任务清单 Q20「主进程接线类」）。
 *  为什么读一组：以前每个守卫写死读 src/main/index.ts，代码原样搬到 src/main 下的另一个文件就红，与行为无关。
 *  现在读整组，代码在组内的文件之间移动时守卫不红；搬出这组（比如挪进渲染端）照样会红。
 *
 *  拼接顺序固定（按相对路径排序），每个文件前加一行标记，便于报错时看出命中在哪个文件。
 *  “A 在 B 之前”这类位置断言只在同一个文件内有意义：要比先后的两段代码必须一起搬。 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const appRoot = join(__dirname, '..');

/** 主进程与预加载脚本的全部 .ts 源码（不含测试）。 */
export const MAIN_PROCESS_SOURCES = ['src/main', 'src/preload'] as const;

function collect(abs: string, out: string[]): void {
  const st = statSync(abs);
  if (st.isFile()) { if (/\.(ts|mts|cts)$/.test(abs) && !/\.d\.ts$/.test(abs)) out.push(abs); return; }
  for (const name of readdirSync(abs).sort()) collect(join(abs, name), out);
}

/** 读 roots（相对 deskminis 目录的文件或目录）下全部 .ts 源码，按相对路径排序后拼成一段文本（换行统一成 \n）。 */
export function readSourceSet(roots: readonly string[] = MAIN_PROCESS_SOURCES): string {
  const files: string[] = [];
  for (const r of roots) collect(join(appRoot, r), files);
  const uniq = [...new Set(files)].sort((a, b) => relative(appRoot, a).localeCompare(relative(appRoot, b)));
  return uniq.map(f => `// ==== ${relative(appRoot, f).replace(/\\/g, '/')} ====\n` + readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).join('\n');
}

/** 组里的文件清单（相对 deskminis 目录，正斜杠），给守卫自己的说明或断言用。 */
export function sourceSetFiles(roots: readonly string[] = MAIN_PROCESS_SOURCES): string[] {
  const files: string[] = [];
  for (const r of roots) collect(join(appRoot, r), files);
  return [...new Set(files)].map(f => relative(appRoot, f).replace(/\\/g, '/')).sort();
}
