/* 部分改编自 pi-mono（https://github.com/badlogic/pi-mono）
 *   上游：packages/coding-agent/src/core/crash-log.ts @ 8676a0d（该文件最后一次改动在 63787ee）
 *   许可：MIT，Copyright (c) 2025 Mario Zechner（全文见仓库根 THIRD-PARTY-NOTICES.md）
 *   本文件已修改：记录加 process 字段与 unhandled_rejection / minisd_exit 两种、退出码与 stderr 末尾；写入时就剔除超过 7 天的
 *   （上游只在读出来提示时按 7 天筛）；先写临时文件再 rename 原子替换；时间与路径由调用方注入；超长字段截短；
 *   不是 Error 的抛出物用 util.inspect 描述；去掉会话文件、cwd、「已提示」标记与按堆栈认扩展。 */

/**
 * 本地崩溃记录 <logRoot>/crashes.json（W2b-7 · 设计稿 §2「生命周期」、§4 S25；侦察 lifecycle.md「W2b-crashlog」）。
 *
 * 为什么要：主进程与 minisd 以前都没有 uncaughtException / unhandledRejection 处理。打包后的 GUI 里 stderr 没人看，
 * 引擎崩了用户只看到界面断线，事后谁也说不清发生了什么。现在两个进程的崩溃、以及主进程看到的「引擎握手之后意外退出」
 * 各记一条到这里，只落本地、不上传。
 *
 * 为什么放在 minisd 这边的 diag/：主进程本来就 import ../minisd/paths，两个进程共用这一份，不依赖 electron。
 *
 * 取舍：
 *  - 最多 5 条、只留 7 天：崩溃本来就少，留多了没人看；写入时就剔除过期的，文件不会越攒越大。
 *  - 原子写（临时文件 + rename）：崩溃路径上进程随时会没，直接写目标文件写到一半就是一个坏文件，之前的记录也搭进去。
 *  - 写失败一律静默（返回 undefined）：调用方已经在崩溃路径上，这里再抛只会让崩溃更难收场。
 *  - 主进程与 minisd 同写这一个文件，读改写之间理论上可能丢一次更新（侦察接受的风险）；rename 保证文件本身不会坏。
 *  - 记录里有路径与错误原文，可能夹带用户内容：只落本地；将来做诊断包导出时要脱敏（W6a）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';

export const CRASH_LOG_NAME = 'crashes.json';
export const MAX_CRASH_RECORDS = 5;
export const CRASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 单个字段的长度上限（字符）：一条错误消息里可能夹着整个响应体，5 条记录不该撑成几 MB。 */
const MESSAGE_MAX_CHARS = 4000;
const STACK_MAX_CHARS = 16_000;
const TAIL_MAX_CHARS = 8000;

/** 出事的进程。minisd_exit 由主进程记，但出事的是引擎，所以也记 'minisd'。 */
export type CrashProcess = 'main' | 'minisd';
export type CrashKind = 'uncaught_exception' | 'unhandled_rejection' | 'minisd_exit';

export interface CrashRecord {
  /** ISO 时间（UTC） */
  timestamp: string;
  version: string;
  process: CrashProcess;
  kind: CrashKind;
  message: string;
  stack: string | null;
  /** 只有 minisd_exit 有 */
  exitCode?: number;
  /** 只有 minisd_exit 有：引擎 stderr 的末尾（主进程的 4KB 环形缓冲） */
  stderrTail?: string;
}

export interface CrashInput {
  process: CrashProcess;
  kind: CrashKind;
  version: string;
  /** 异常类记录的抛出物：message 与 stack 从它取（抛出的就是 undefined 也照记）。 */
  error?: unknown;
  /** 没有抛出物的记录（minisd_exit）直接给说明。 */
  message?: string;
  exitCode?: number;
  stderrTail?: string;
}

export function crashLogPath(logRoot: string): string {
  return join(logRoot, CRASH_LOG_NAME);
}

function isRecord(v: unknown): v is CrashRecord {
  return typeof v === 'object' && v !== null
    && typeof (v as CrashRecord).timestamp === 'string' && typeof (v as CrashRecord).message === 'string';
}

/** 读出全部记录。文件不存在、坏 JSON、不是数组都当空；数组里的坏条目丢掉。 */
export function readCrashLog(path: string): CrashRecord[] {
  try {
    const records: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(records) ? records.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…（已截断，原长 ${s.length} 字符）`;
}

/** 抛出物的一句话：Error 取 message（空就取 name）；其余用 inspect，对象也看得出长什么样（String 只给 [object Object]）。 */
function messageOf(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === 'string') return error;
    return inspect(error, { depth: 3, breakLength: Infinity });
  } catch {
    return '（无法描述的抛出物）';
  }
}

/** 先写同目录的临时文件再 rename 替换：rename 在同一卷上是原子的，读的人要么看到旧文件、要么看到新文件。
 *  失败时删掉临时文件再抛（临时文件名带 pid 与随机串，两个进程同时写也不会撞名）。 */
function writeAtomically(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 删不掉就留着：readCrashLog 不读它 */ }
    throw e;
  }
}

/** 记一条崩溃：读出 → 丢掉超过 7 天的 → 追加 → 只留最新 5 条 → 原子替换。返回记下的那条；写不进返回 undefined，从不抛。 */
export function recordCrash(input: CrashInput, path: string, now: Date = new Date()): CrashRecord | undefined {
  try {
    const hasError = Object.prototype.hasOwnProperty.call(input, 'error');
    const record: CrashRecord = {
      timestamp: now.toISOString(),
      version: input.version,
      process: input.process,
      kind: input.kind,
      message: clip(hasError ? messageOf(input.error) : (input.message ?? ''), MESSAGE_MAX_CHARS),
      stack: input.error instanceof Error && input.error.stack ? clip(input.error.stack, STACK_MAX_CHARS) : null,
    };
    if (input.exitCode !== undefined) record.exitCode = input.exitCode;
    if (input.stderrTail !== undefined) record.stderrTail = clip(input.stderrTail, TAIL_MAX_CHARS);
    const t = now.getTime();
    const kept = readCrashLog(path).filter((r) => {
      const at = Date.parse(r.timestamp);
      return Number.isFinite(at) && t - at <= CRASH_MAX_AGE_MS;
    });
    writeAtomically(path, `${JSON.stringify([...kept, record].slice(-MAX_CRASH_RECORDS), null, 2)}\n`);
    return record;
  } catch {
    return undefined;
  }
}
