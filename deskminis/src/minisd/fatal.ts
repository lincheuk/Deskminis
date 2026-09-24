/** minisd 致命行通道的 minisd 一侧（设计稿 §3 第 8 条）。
 *
 *  为什么要这条通道：minisd 启动失败以前只写 stderr 然后 exit(1)。打包后的 GUI 里 stderr 没人看，
 *  主进程只知道「子进程 code=1 退出了」，对话框里显示的是主进程自己的堆栈——真正的原因（库比应用新、
 *  数据目录被另一个实例占着）用户永远看不到，也就不知道该装新版还是先退出另一个窗口。
 *  现在对这几种「用户能自己处理」的失败，往 stdout 写一行结构化 JSON，主进程据此弹中文对话框。
 *
 *  契约：`{"minisdFatal":{code,…}}` 单独一行；只带白名单字段（不带堆栈、不带原始 message）；
 *  主进程侧解析在 src/main/minisd-fatal.ts，和这里共用 toMinisdFatal 做字段校验，两边不会各写一套。
 *  本模块不 import 任何 minisd 业务模块，主进程可以放心引用。 */

/** 走致命行的错误 code。DATA_ROOT_LOCKED 的抛出点（数据根锁）在 W1b，通道先按契约认它。 */
export const MINISD_FATAL_CODES = ['DB_NEWER_THAN_APP', 'DATA_ROOT_LOCKED'] as const;

export type MinisdFatal =
  | { code: 'DB_NEWER_THAN_APP'; dbVersion: number; appVersion: number; dataRoot: string }
  | { code: 'DATA_ROOT_LOCKED'; pid: number; dataRoot: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** 从错误对象（minisd 侧）或致命行里的 JSON（主进程侧）挑出白名单字段；不认识或缺字段返回 undefined。
 *  fallbackDataRoot：错误对象自己没带 dataRoot 时用调用方给的（DbNewerThanAppError 只知道版本号）。 */
export function toMinisdFatal(v: unknown, fallbackDataRoot?: string): MinisdFatal | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const dataRoot = typeof o.dataRoot === 'string' && o.dataRoot !== '' ? o.dataRoot : fallbackDataRoot;
  if (typeof dataRoot !== 'string' || dataRoot === '') return undefined;
  if (o.code === 'DB_NEWER_THAN_APP' && isInt(o.dbVersion) && isInt(o.appVersion)) {
    return { code: 'DB_NEWER_THAN_APP', dbVersion: o.dbVersion, appVersion: o.appVersion, dataRoot };
  }
  if (o.code === 'DATA_ROOT_LOCKED' && isInt(o.pid) && o.pid > 0) {
    return { code: 'DATA_ROOT_LOCKED', pid: o.pid, dataRoot };
  }
  return undefined;
}

/** 最后一次写完成之后，再等这么久才 exit(1)。
 *  为什么光等 write 回调不够（W1a-8 实拍逮到的，设计稿原写「写回调里 exit(1)」）：回调只说明数据进了管道，
 *  而 Electron utilityProcess 的主进程一侧一收到子进程 exit，就不再交付管道里还没读的数据，也不发 end/close。
 *  实测（数据与脚本见 W1a-8 的提交正文）：真实应用里回调中立刻 exit，致命行 11 次丢 10 次（子进程一侧记录
 *  write 返回 true、回调无错），用户看到的又是「code=1」；回调后等 30ms 起 4/4 不丢；exit 之后到达的字节数在所有轮次里都是 0。
 *  取 500ms 留足余量（Windows 真机更慢、杀软扫描）：主进程读到致命行就弹框，不等子进程退出，用户感觉不到这半秒；
 *  通用失败路径（主进程等 exit）也只慢半秒。 */
export const STARTUP_FAILURE_EXIT_DELAY_MS = 500;

export interface StartupFailureIo {
  stdout: { write(chunk: string, cb: () => void): unknown };
  stderr: { write(chunk: string, cb: () => void): unknown };
  exit(code: number): void;
  later(fn: () => void, ms: number): void;
}

const processIo: StartupFailureIo = {
  stdout: { write: (chunk, cb) => process.stdout.write(chunk, () => cb()) },
  stderr: { write: (chunk, cb) => process.stderr.write(chunk, () => cb()) },
  exit: code => process.exit(code),
  later: (fn, ms) => { setTimeout(fn, ms); },
};

/** standalone 启动失败的出口。stderr 那行「minisd 启动失败」照旧（开发时终端里看得见，主进程把它留进 stderr 末尾缓冲，
 *  通用失败框靠它说明真正原因）；属于致命行白名单的，再往 stdout 写一行给主进程弹专用对话框。
 *  最后一次写的回调里才排退出，并且再等 STARTUP_FAILURE_EXIT_DELAY_MS（原因见该常量）。
 *  回调在写失败（比如管道已断）时也会被调用，所以不会卡住不退。 */
export function reportStartupFailure(e: unknown, dataRoot: string, io: StartupFailureIo = processIo): void {
  const fatal = toMinisdFatal(e, dataRoot);
  const exitSoon = (): void => io.later(() => io.exit(1), STARTUP_FAILURE_EXIT_DELAY_MS);
  const stderrLine = 'minisd 启动失败: ' + (e instanceof Error ? e.stack ?? e.message : String(e)) + '\n';
  if (fatal === undefined) {
    io.stderr.write(stderrLine, exitSoon);
    return;
  }
  io.stderr.write(stderrLine, () => { /* 退出由下面致命行的写回调排，只排一次 */ });
  io.stdout.write(JSON.stringify({ minisdFatal: fatal }) + '\n', exitSoon);
}
