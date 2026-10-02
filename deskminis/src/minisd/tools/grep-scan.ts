import { Worker } from 'node:worker_threads';

/**
 * file_grep 的逐行正则扫描，放在 worker_threads 里跑（W3-sec2，安全审计第 4 条）。
 *
 * 为什么：正则是调用方（模型）给的，以前在引擎的事件循环里同步 re.test。灾难性回溯——41 字节的 aaa…! 配 (a+)+$——
 * 能把整个 minisd 卡死：所有会话、停止键、RPC 一起停；10 秒预算只在每个文件扫完之后才查，单个文件里卡住就永远查不到。
 * 放进 Worker 之后，到时或点停止就 terminate（硬中断，不靠扫描自己配合），引擎的事件循环一直能动。
 *
 * 为什么用 eval 起 Worker、而不是单独打一个 worker 文件：worker 文件要加构建入口，打包后还得从 asar 里起；
 * eval 的源码由下面这个自包含的函数 toString 拼出来，测试与打包形态走同一条路。所以 scanFiles 不许引用函数外的任何东西
 * （fs、path、发消息都从参数进来），只用 Node 自带模块。
 */

/** 交给 worker 的活：base 下的相对路径清单（glob 过滤在主线程做完）、正则源与 flags、各项上限。 */
export interface GrepJob {
  base: string;
  files: string[];
  pattern: string;
  flags: string;
  limits?: Partial<GrepLimits>;
}

export interface GrepLimits {
  maxFile: number;
  sniffBytes: number;
  lineScan: number;
  lineDisplay: number;
  maxMatches: number;
  maxOutput: number;
}

/** 与 search.ts 原来的常量相同（行为不变）：1MB 以上跳过、前 8KB 判二进制、单行扫前 10000 字、展示 500 字、500 条、100KB。 */
export const GREP_LIMITS: GrepLimits = {
  maxFile: 1024 * 1024,
  sniffBytes: 8192,
  lineScan: 10000,
  lineDisplay: 500,
  maxMatches: 500,
  maxOutput: 100 * 1024,
};

/** worker 发回来的一条：这一批新增的行与到目前为止的累计计数。每扫完一个有结果或被跳过的文件发一次，扫完再发 done——
 *  中途被 terminate 时，已经发回来的行照样算数。 */
export interface GrepProgress {
  rows: string[];
  skippedBig: number;
  skippedBin: number;
  cappedMatches: boolean;
  cappedOutput: boolean;
  done: boolean;
}

export interface GrepResult {
  rows: string[];
  skippedBig: number;
  skippedBin: number;
  cappedMatches: boolean;
  cappedOutput: boolean;
  /** 到时被终止（返回的是部分结果） */
  timedOut: boolean;
  /** 点了停止被终止 */
  aborted: boolean;
}

/** 扫描本体：在 worker 里跑。逻辑照搬 search.ts 原来的循环。 */
function scanFiles(
  job: GrepJob & { limits: GrepLimits },
  fs: { lstatSync(p: string): { size: number }; readFileSync(p: string): Buffer },
  path: { join(...p: string[]): string },
  post: (m: GrepProgress) => void,
): void {
  const L = job.limits;
  const re = new RegExp(job.pattern, job.flags);
  let rowsLen = 0, matches = 0, skippedBig = 0, skippedBin = 0;
  let cappedMatches = false, cappedOutput = false;
  const send = (rows: string[], done: boolean): void => post({ rows, skippedBig, skippedBin, cappedMatches, cappedOutput, done });
  scan: for (let fi = 0; fi < job.files.length; fi++) {
    const rel = job.files[fi];
    const abs = path.join(job.base, rel);
    let buf: Buffer;
    try {
      if (fs.lstatSync(abs).size > L.maxFile) { skippedBig++; send([], false); continue; }
      buf = fs.readFileSync(abs);
    } catch { continue; } // 竞态消失/无权读的文件跳过
    // 前 8KB 含 \0 判二进制：合法 UTF-8 文本不含 \0，硬扫 exe/图片只会产出乱码匹配
    if (buf.subarray(0, L.sniffBytes).includes(0)) { skippedBin++; send([], false); continue; }
    const rows: string[] = [];
    const lines = buf.toString('utf8').split('\n');
    for (let li = 0; li < lines.length; li++) {
      let line = lines[li];
      if (line.endsWith('\r')) line = line.slice(0, -1); // CRLF 行尾的 \r 不属于内容
      // 单行只扫前 10000 字符：超长行（压缩 JS/base64）照旧裁掉；回溯本身由 worker 的硬时限兜住
      if (!re.test(line.slice(0, L.lineScan))) continue;
      matches++;
      const shown = line.length > L.lineDisplay ? line.slice(0, L.lineDisplay) : line;
      const row = `${rel}:${li + 1}:${shown}`;
      rows.push(row);
      rowsLen += row.length + 1;
      if (rowsLen > L.maxOutput) { cappedOutput = true; send(rows, false); break scan; }
      if (matches >= L.maxMatches) { cappedMatches = true; send(rows, false); break scan; }
    }
    if (rows.length > 0) send(rows, false);
  }
  send([], true);
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(${scanFiles.toString()})(workerData, require('node:fs'), require('node:path'), (m) => parentPort.postMessage(m));
`;

/** 起一个 worker 扫 job，budgetMs 到时或 signal 中止就 terminate。worker 自己出错（起不来、正则在 worker 里抛）按异常抛给调用方。 */
export function grepInWorker(job: GrepJob, opts: { budgetMs: number; signal?: AbortSignal }): Promise<GrepResult> {
  const res: GrepResult = { rows: [], skippedBig: 0, skippedBin: 0, cappedMatches: false, cappedOutput: false, timedOut: false, aborted: false };
  if (opts.signal?.aborted) return Promise.resolve({ ...res, aborted: true });
  return new Promise<GrepResult>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { ...job, limits: { ...GREP_LIMITS, ...job.limits } } });
    let settled = false;
    const finish = (stop: 'timedOut' | 'aborted' | undefined, err?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (stop) res[stop] = true;
      // 不 await：terminate 的 Promise 只在 worker 真停下之后落定，这里先把结果交回去
      void worker.terminate().catch(() => { /* 已经停了 */ });
      if (err !== undefined) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(res);
    };
    const onAbort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('timedOut'), opts.budgetMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m: GrepProgress) => {
      if (settled) return;
      res.rows.push(...m.rows);
      res.skippedBig = m.skippedBig;
      res.skippedBin = m.skippedBin;
      res.cappedMatches = m.cappedMatches;
      res.cappedOutput = m.cappedOutput;
      if (m.done) finish(undefined);
    });
    worker.on('error', e => finish(undefined, e));
    // 没发 done 就退出（正常扫完一定先发 done；terminate 引起的退出此时已 settled，finish 直接返回）
    worker.on('exit', code => finish(undefined, new Error(`file_grep 的扫描线程意外退出（${code}）`)));
  });
}
