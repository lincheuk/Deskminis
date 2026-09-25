/**
 * 两个进程的崩溃钩子（W2b-7 · 设计稿 §2「生命周期」、§3 第 11 条；侦察 lifecycle.md「W2b-crashlog」）。
 *
 * 以前主进程与 minisd 都没有 uncaughtException / unhandledRejection 处理：
 *  - minisd 里漏接一次 promise 拒绝，Node 默认把它当未捕获异常，引擎当场退出，界面上所有会话一起断线、永远停在「运行中」；
 *  - 两边的崩溃都只进 stderr，打包后的 GUI 里没人看得见。
 * 现在各记一条到 <logRoot>/crashes.json（diag/crash-log.ts），语义按设计稿 §2 拍板：
 *  - minisd：uncaughtException 记完 exit(1)；unhandledRejection 记完继续跑；
 *  - 主进程：uncaughtException 记完照 Electron 默认弹错误框、继续运行；unhandledRejection 只记。
 *
 * 装在哪儿（钩子是进程级的，装错地方会装进测试 worker，吞掉测试框架自己的未捕获异常）：
 *  - minisd 只在 index.ts 的 standalone 分支装；进程内起 minisd 的测试不经过那里。
 *  - 主进程在 whenReady 回调里装；ipc-contract 等单测会 import 主进程模块，模块顶层装就装进了 worker。
 * 本模块 import 时什么都不挂，只有调安装函数才挂；process、退出、时间、stderr 都可注入，测试用假的 EventEmitter。
 */
import { inspect } from 'node:util';
import { crashLogPath, recordCrash, type CrashInput } from './crash-log';

type Env = Readonly<Record<string, string | undefined>>;

/** 挂监听用到的那一点 process：生产是真的 process，测试传一个 EventEmitter。 */
export type CrashEventSource = Pick<NodeJS.EventEmitter, 'on'>;

/** 版本号：主进程经 DESKMINIS_APP_VERSION 下发（它有 app.getVersion()）；不经主进程直接起的 standalone 记 unknown。 */
export function appVersionFromEnv(env: Env): string {
  return env.DESKMINIS_APP_VERSION || 'unknown';
}

/** 抛出物的完整描述（stderr、按天日志、错误框用）：Error 取堆栈，其余用 inspect。从不抛。 */
function describe(error: unknown): string {
  try {
    if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
    return inspect(error, { depth: 3, breakLength: Infinity });
  } catch {
    return '（无法描述的抛出物）';
  }
}

/** 崩溃路径上的旁路输出（stderr、日志、弹框）：失败了也不能再抛——监听里抛出，Node 就以 7 退出。 */
function quietly(fn: () => void): void {
  try { fn(); } catch { /* 见上 */ }
}

const writeStderr = (text: string): void => { process.stderr.write(text); };

export interface MinisdCrashHandlerOpts {
  /** 缺省取 DESKMINIS_APP_VERSION */
  version?: string;
  proc?: CrashEventSource;
  exit?: (code: number) => void;
  now?: () => Date;
  /** 往 stderr 说一句（主进程把它转写进按天日志）；缺省 process.stderr.write */
  report?: (text: string) => void;
}

/**
 * minisd 的崩溃钩子。logRoot 由调用方给（standalone 分支传 logRootFromEnv(process.env)）。
 *  - uncaughtException：同步记一条、stderr 说一句，然后 exit(1)。保持「会崩」：未捕获异常之后进程状态不可信，
 *    接着跑可能把库写坏。主进程的 exit 监听随后再记一条 minisd_exit，带上 stderr 末尾。
 *  - unhandledRejection：记一条、stderr 说一句，继续跑。一次漏接的拒绝多半只坏那一个操作，不值得让整个引擎陪葬
 *    （可能掩盖状态不一致，是设计稿 §2 拍板接受的取舍）。
 */
export function installMinisdCrashHandlers(logRoot: string, opts: MinisdCrashHandlerOpts = {}): void {
  const proc = opts.proc ?? process;
  const version = opts.version ?? appVersionFromEnv(process.env);
  const exit = opts.exit ?? ((code: number) => { process.exit(code); });
  const now = opts.now ?? (() => new Date());
  const report = opts.report ?? writeStderr;
  const path = crashLogPath(logRoot);
  proc.on('uncaughtException', (error: unknown) => {
    try {
      recordCrash({ process: 'minisd', kind: 'uncaught_exception', version, error }, path, now());
      quietly(() => report(`minisd 未捕获异常，已记入 ${path}，引擎退出: ${describe(error)}\n`));
    } finally {
      exit(1);
    }
  });
  proc.on('unhandledRejection', (reason: unknown) => {
    recordCrash({ process: 'minisd', kind: 'unhandled_rejection', version, error: reason }, path, now());
    quietly(() => report(`minisd 未处理的 Promise 拒绝，已记入 ${path}，引擎继续运行: ${describe(reason)}\n`));
  });
}

export interface MainCrashHandlerOpts {
  logRoot: string;
  version: string;
  /** dialog.showErrorBox：挂了自己的 uncaughtException 监听之后，Electron 默认的错误框就不弹了，由这里弹。 */
  showErrorBox: (title: string, content: string) => void;
  /** 顺手在按天日志里记一笔（可选） */
  log?: (line: string) => void;
  proc?: CrashEventSource;
  now?: () => Date;
  /** 缺省 process.stderr.write（开发时终端里看得见） */
  report?: (text: string) => void;
}

/**
 * 主进程的崩溃钩子。
 *  - uncaughtException：记一条，再弹错误框，然后继续运行——与 Electron 的默认处理一样（默认只弹框、不退出）。
 *    Electron 的默认处理见到别人也挂了 uncaughtException 监听就什么都不做，所以框得自己弹；
 *    弹框放最后：Linux 上它会阻塞主线程直到用户点掉，记录与日志要先落盘。
 *  - unhandledRejection：只记一条。主进程里多半是更新检查这类旁路的失败，弹框只会打扰用户。
 */
export function installMainCrashHandlers(opts: MainCrashHandlerOpts): void {
  const proc = opts.proc ?? process;
  const now = opts.now ?? (() => new Date());
  const report = opts.report ?? writeStderr;
  const path = crashLogPath(opts.logRoot);
  proc.on('uncaughtException', (error: unknown) => {
    recordCrash({ process: 'main', kind: 'uncaught_exception', version: opts.version, error }, path, now());
    const text = describe(error);
    quietly(() => report(`DeskMinis 主进程未捕获异常，已记入 ${path}: ${text}\n`));
    quietly(() => opts.log?.(`[main] 未捕获异常：${text}`));
    const shown = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    quietly(() => opts.showErrorBox('DeskMinis 主进程出错',
      `发生了一个没有处理的错误，应用会继续运行；如果界面不正常，请重启 DeskMinis。\n崩溃记录：${path}\n\n${shown}`));
  });
  proc.on('unhandledRejection', (reason: unknown) => {
    recordCrash({ process: 'main', kind: 'unhandled_rejection', version: opts.version, error: reason }, path, now());
    const text = describe(reason);
    quietly(() => report(`DeskMinis 主进程未处理的 Promise 拒绝，已记入 ${path}: ${text}\n`));
    quietly(() => opts.log?.(`[main] 未处理的 Promise 拒绝：${text}`));
  });
}

/** 主进程唯一的 exit 监听（设计稿 §3 第 11 条）看到的一次引擎退出。 */
export interface MinisdExitFacts {
  code: number;
  /** 握过手了（minisdPort 已上报） */
  handshaken: boolean;
  /** 请求过关停（托盘退出、before-quit、重启并安装都走 stopMinisdGracefully） */
  stopRequested: boolean;
  /** 主进程已在退出 */
  quitting: boolean;
  version: string;
  stderrTail: string;
}

/**
 * 这次退出算不算崩溃：算就返回要记的那条 minisd_exit，不算返回 undefined。
 *  - 握手前退出：启动失败，已有专门的对话框（致命行，或附 stderr 末尾的错误框），不重复记；
 *  - 请求过关停：正常退出，超时被 kill 也算正常；
 *  - 主进程已在退出（例如建窗口失败后主进程自己 kill 了它）：不是引擎自己的问题；
 *  - 其余：引擎在运行中自己没了，界面从此断线。记下退出码与 stderr 末尾（真正的原因多半在那里）。
 *    退出码是 0 也算：没人请求的退出，界面照样没了引擎。
 */
export function minisdExitCrash(f: MinisdExitFacts): CrashInput | undefined {
  if (!f.handshaken || f.stopRequested || f.quitting) return undefined;
  return {
    process: 'minisd',
    kind: 'minisd_exit',
    version: f.version,
    message: `引擎进程在运行中意外退出（code=${f.code}）`,
    exitCode: f.code,
    stderrTail: f.stderrTail,
  };
}
