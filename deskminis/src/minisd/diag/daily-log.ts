/**
 * 按天日志 <logRoot>/minisd-YYYY-MM-DD.log（W2b-7 · 设计稿 §4 S25；侦察 lifecycle.md「W2b-crashlog」【按天日志】）。
 *
 * 主进程把 minisd 的 stdout（握手行除外）与 stderr、以及自己的生命周期行（fork、握手端口、请求关停、退出码）写进来。
 * 为什么要：打包后的 GUI 里 stderr 没人看。minisd 起不来的原因、崩溃前的输出、「权限超时时审计写失败」这类只记一笔的警告，
 * 以前全都随进程一起消失。
 *
 * 规则：
 *  - 按本地日期分文件：用户说「昨天下午出的问题」，找的是本地的昨天。每行前加带时区的 ISO 时间，日期部分与文件名一致。
 *  - 启动时删掉超过 7 天的（prune）。单日超过 10MB 停写，只记一行截断说明：引擎要是在某个循环里刷屏，
 *    日志不能把用户的磁盘吃满。重启后当天的文件已经超限就接着停写，不再补一行说明。
 *  - 构造不碰磁盘，第一次写时才建目录：主进程在模块顶层建它，单测会 import 主进程模块，不能在开发机上建目录。
 *  - 写不进（磁盘满、没权限、目录其实是个文件）一律静默：日志是旁路，不能打断主流程。
 *  - 只有主进程一个写者（minisd 的输出经主进程转写），不用跨进程加锁。
 *  - 同步写：量小（minisd 平时几乎不输出），换来崩溃前最后几行一定已经在盘上。
 *  - 日志里有路径与错误原文，可能夹带用户内容：只落本地；将来做诊断包导出时要脱敏（W6a）。
 */
import { appendFileSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DAILY_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DAILY_LOG_KEEP_DAYS = 7;
/** 单行上限（字符）：一行几 MB 的输出不能一口吃掉当天的额度。 */
export const DAILY_LOG_MAX_LINE_CHARS = 16 * 1024;
const DEFAULT_PREFIX = 'minisd';

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** 本地日期 YYYY-MM-DD（文件名用）。 */
export function localDateStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 带本地时区偏移的 ISO 8601 时间，形如 2026-09-25T08:00:07.123+08:00。
 *  不用 toISOString：它给的是 UTC，东八区凌晨写的行会带着前一天的日期，与按本地日期分的文件名对不上。 */
export function localIsoTime(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${localDateStamp(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${zone}`;
}

function clipLine(line: string): string {
  return line.length <= DAILY_LOG_MAX_LINE_CHARS
    ? line
    : `${line.slice(0, DAILY_LOG_MAX_LINE_CHARS)}…（此行过长已截断，原长 ${line.length} 字符）`;
}

function sizeOf(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

/** 当天在写的那个文件：已写字节数，与「今天已经停写」。 */
interface Day { file: string; size: number; full: boolean }

export class DailyLog {
  private readonly prefix: string;
  private readonly maxBytes: number;
  private day: Day | undefined;

  /** prefix：文件名前缀（缺省 minisd）；maxBytes：单日上限（缺省 10MB，测试注入小值）。 */
  constructor(readonly dir: string, opts: { prefix?: string; maxBytes?: number } = {}) {
    this.prefix = opts.prefix ?? DEFAULT_PREFIX;
    this.maxBytes = opts.maxBytes ?? DAILY_LOG_MAX_BYTES;
  }

  /** now 那天（本地日期）的日志文件。 */
  fileFor(now: Date): string {
    return join(this.dir, `${this.prefix}-${localDateStamp(now)}.log`);
  }

  /** 记一段文本：按行拆开，每行前加 now 的时间；空行不写。从不抛。 */
  append(text: string, now: Date = new Date()): void {
    try {
      const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
      if (lines.length === 0) return;
      const file = this.fileFor(now);
      if (this.day?.file !== file) {
        // 换了一天（或第一次写）：按盘上的实际大小接着算，重启前当天已经超限的就接着停写
        const size = sizeOf(file);
        this.day = { file, size, full: size >= this.maxBytes };
      }
      const day = this.day;
      if (day.full) return;
      const stamp = localIsoTime(now);
      const data = lines.map(l => `${stamp} ${clipLine(l)}\n`).join('');
      this.write(file, data);
      day.size += Buffer.byteLength(data);
      if (day.size >= this.maxBytes) {
        day.full = true;
        this.write(file, `${stamp} [日志] 今天的日志已达 ${Math.round(this.maxBytes / 1024 / 1024 * 10) / 10}MB 上限，之后的输出不再写入（明天换新文件）\n`);
      }
    } catch { /* 日志是旁路：写不进不打断调用方 */ }
  }

  /** 删掉超过 keepDays 天的按天日志（按本地日历天算：7 天前的留着，8 天前的删）。只删名字对得上的普通文件，别的一概不碰。从不抛。 */
  prune(now: Date = new Date(), keepDays: number = DAILY_LOG_KEEP_DAYS): void {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return; }
    const cutoff = localDateStamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays));
    const escaped = this.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
    for (const name of names) {
      const m = re.exec(name);
      // YYYY-MM-DD 定宽，按字符串比就是按日期比
      if (!m || m[1] >= cutoff) continue;
      try {
        const p = join(this.dir, name);
        if (lstatSync(p).isFile()) rmSync(p);
      } catch { /* 删不掉（被占用）的留到下次启动 */ }
    }
  }

  /** 追加写；目录不在（第一次写，或被删了）就建出来再写一次。 */
  private write(file: string, data: string): void {
    try {
      appendFileSync(file, data);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(file, data);
    }
  }
}
