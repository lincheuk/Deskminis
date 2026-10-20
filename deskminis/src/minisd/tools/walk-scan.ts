import { Worker } from 'node:worker_threads';
import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { matchesSkipRule, stripWin32Segment, type SkipRule } from './data-gate';

/**
 * file_glob / file_grep 的目录遍历，放在 worker_threads 里跑（Q15）。
 *
 * 为什么：遍历是同步的 readdir 加每个条目一次 lstat，最多 5 万个条目。以前在引擎的事件循环里跑：一个带 node_modules 的
 * 工程约 1 秒（磁盘缓存是冷的时候 8 秒多），这期间所有会话的流式输出、权限卡、RPC 都停着；停止键的 RPC 进不来，
 * 循环里每 200 个条目查一次的取消信号也就翻不了。放进 Worker 之后引擎的事件循环一直能动，点停止就 terminate。
 *
 * 做法与 grep-scan.ts 相同：Worker 的源码由自包含的函数 toString 拼出来（不加构建入口，测试与打包形态走同一条路）。
 * 所以 walkTree 不许引用函数外的任何东西——fs、path、跳过谁、要不要停都从参数进来。
 * 主线程的同步入口 walkDirSync 调的是同一个 walkTree，两边不会各写一份。
 */

// 访问条目硬上限：基准被指到超大目录（如整个用户盘）时不至于扫穿宿主
export const WALK_ENTRY_LIMIT = 50000;

export interface WalkDirResult {
  /** 相对 base 的正斜杠文件路径，按名排序 */
  files: string[];
  /** 相对 base 的正斜杠目录路径，按名排序（不含 base 自身） */
  dirs: string[];
  /** 是否因访问条目达硬上限提前停止（结果可能不全，调用方需注明） */
  hitLimit: boolean;
  /** 被跳过的目录（相对 base 的正斜杠路径），调用方据此写尾注 */
  skipped: string[];
}

interface WalkFs {
  readdirSync(p: string): string[];
  lstatSync(p: string): { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean };
}

/** 遍历本体：递归遍历 base（文件与目录都收集，供 file_glob 匹配——`src/*` 这类模式天然要列出子目录）。
 *  「基准目录一次授权即覆盖全部遍历」的安全前提就在这里：
 *  - 一律 lstat，symlink/junction 目录绝不进入——跟随链接可越出已授权的工作区边界，也可能成环；
 *  - 指向文件的符号链接也整体排除——grep 若读它，目标可以指向基准之外，一次授权就盖不住了。
 *  skipDir 返回 true 的目录整棵不进、也不列入结果，记进 skipped。 */
function walkTree(
  base: string,
  entryLimit: number,
  fs: WalkFs,
  path: { join(...p: string[]): string },
  skipDir: ((rel: string) => boolean) | undefined,
  stopRequested: () => boolean,
): WalkDirResult {
  const files: string[] = [];
  const dirs: string[] = [];
  const skipped: string[] = [];
  let visited = 0;
  let hitLimit = false;
  let aborted = false;
  // 显式栈而非递归：目录树深度不受调用栈限制；顺序无所谓，输出前统一排序
  const queue: { abs: string; rel: string }[] = [{ abs: base, rel: '' }];
  while (queue.length > 0) {
    const { abs, rel } = queue.pop()!;
    let names: string[];
    try { names = fs.readdirSync(abs); } catch { continue; } // 读不了的目录（权限/占用）跳过，单个坏目录不毁整次遍历
    names.sort();
    for (const name of names) {
      // 每 200 个条目查一次要不要停（同步入口用；worker 里靠 terminate，这里恒为否）
      if (++visited % 200 === 0 && stopRequested()) { aborted = true; break; }
      if (visited > entryLimit) { hitLimit = true; break; }
      const childRel = rel ? `${rel}/${name}` : name;
      let st: ReturnType<WalkFs['lstatSync']>;
      try { st = fs.lstatSync(path.join(abs, name)); } catch { continue; } // 遍历竞态中消失的条目跳过
      if (st.isSymbolicLink()) continue; // 见函数头安全注释：链接一律不进结果、不进入
      if (st.isDirectory()) {
        if (skipDir?.(childRel)) { skipped.push(childRel); continue; }
        dirs.push(childRel);
        queue.push({ abs: path.join(abs, name), rel: childRel });
      } else if (st.isFile()) {
        files.push(childRel);
      }
    }
    if (aborted || hitLimit) break;
  }
  files.sort();
  dirs.sort();
  return { files, dirs, hitLimit, skipped };
}

/** 同步入口：在调用方的线程里直接遍历。工具不走这里（它会占住引擎的事件循环），留给测试与不在乎阻塞的调用方。 */
export function walkDirSync(base: string, opts: { entryLimit?: number; signal?: AbortSignal; skipDir?: (rel: string) => boolean } = {}): WalkDirResult {
  return walkTree(base, opts.entryLimit ?? WALK_ENTRY_LIMIT, { readdirSync, lstatSync }, { join }, opts.skipDir, () => opts.signal?.aborted === true);
}

/** 交给 worker 的活。skip 是数据根的跳过规则（data-gate.ts 的 dataRootSkipRule），没有就不跳。 */
interface WalkJob { base: string; entryLimit: number; skip?: SkipRule }

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const strip = (${stripWin32Segment.toString()});
const matches = (${matchesSkipRule.toString()});
const rule = workerData.skip;
parentPort.postMessage((${walkTree.toString()})(
  workerData.base, workerData.entryLimit, require('node:fs'), require('node:path'),
  rule ? (rel) => matches(rule, rel, strip) : undefined, () => false,
));
`;

export interface WalkAsyncOptions { skip?: SkipRule; signal?: AbortSignal; entryLimit?: number }
export type WalkAsyncResult = WalkDirResult & { aborted: boolean };
const stopped = (): WalkAsyncResult => ({ files: [], dirs: [], hitLimit: false, skipped: [], aborted: true });

/** 工具用的入口：不占住事件循环的遍历。aborted 为真时其余字段是空的。
 *  小目录不值得起线程（起一个 worker 约 50 毫秒，走 200 个条目只要几毫秒）：先在本线程里走，走到遍历本体第一次问
 *  「要不要停」的地方（第 200 个条目）还没走完，才丢掉这次的、整棵交给 worker 重走。两条路跑的是同一个 walkTree，
 *  走完了的结果是同一个。 */
export function walkDirAsync(base: string, opts: WalkAsyncOptions = {}): Promise<WalkAsyncResult> {
  if (opts.signal?.aborted) return Promise.resolve(stopped());
  const rule = opts.skip;
  let big = false;
  const quick = walkTree(base, opts.entryLimit ?? WALK_ENTRY_LIMIT, { readdirSync, lstatSync }, { join },
    rule ? (rel: string) => matchesSkipRule(rule, rel, stripWin32Segment) : undefined, () => (big = true));
  return big ? walkDirInWorker(base, opts) : Promise.resolve({ ...quick, aborted: false });
}

/** 起一个 worker 遍历 base，signal 中止就 terminate。aborted 为真时其余字段是空的。
 *  worker 自己出错（起不来、意外退出）按异常抛给调用方。 */
export function walkDirInWorker(base: string, opts: WalkAsyncOptions = {}): Promise<WalkAsyncResult> {
  if (opts.signal?.aborted) return Promise.resolve(stopped());
  return new Promise((resolve, reject) => {
    const job: WalkJob = { base, entryLimit: opts.entryLimit ?? WALK_ENTRY_LIMIT, ...(opts.skip ? { skip: opts.skip } : {}) };
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: job });
    let settled = false;
    const finish = (result: WalkAsyncResult | undefined, err?: unknown): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      // 不 await：terminate 的 Promise 只在 worker 真停下之后落定，这里先把结果交回去
      void worker.terminate().catch(() => { /* 已经停了 */ });
      if (result) resolve(result);
      else reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onAbort = (): void => finish(stopped());
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m: WalkDirResult) => finish({ ...m, aborted: false }));
    worker.on('error', e => finish(undefined, e));
    // 没交结果就退出（正常遍历完一定先交结果；terminate 引起的退出此时已 settled，finish 直接返回）
    worker.on('exit', code => finish(undefined, new Error(`文件遍历线程意外退出（${code}）`)));
  });
}
