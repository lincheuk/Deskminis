/** W1a-8：minisd 致命行通道（设计稿 §3 第 8 条）与主进程对话框。
 *
 *  链路：minisd standalone 启动失败时，若错误的 code 属于 {DB_NEWER_THAN_APP, DATA_ROOT_LOCKED}，
 *  往 stdout 写一行 `{"minisdFatal":{code,…}}`，在 write 的回调里再等一小段才 exit(1)；stderr 那行「minisd 启动失败」照旧。
 *  「再等一小段」是 W1a-8 实拍逮到的：utilityProcess 的主进程一侧收到 exit 后不再交付管道里剩下的数据，
 *  回调里立刻 exit，真实应用里致命行 11 次丢 10 次（证据见 src/minisd/fatal.ts 的 STARTUP_FAILURE_EXIT_DELAY_MS）。
 *  主进程在 stdout 行循环里先认致命行，以 MinisdFatalError 结束启动等待，catch 分支用
 *  showMessageBoxSync(fatalDialogOptions(…)) 弹只有「退出」的中文对话框。其余失败走 showErrorBox，并附 stderr 末尾。
 *  用同步版而不是侦察计划写的 showMessageBox：W1a-8 实拍发现异步版在 Linux 上点了按钮、窗口已消失，
 *  promise 却要等主进程下一次被别的事件唤醒才 resolve（空应用里约 30s，DeskMinis 里等到 8s 的更新检查定时器），
 *  应用迟迟不退出；同步版点完 0.1s 内返回。启动已经失败、没有任何窗口，阻塞主线程没有代价。
 *
 *  为什么要这条通道：以前 minisd 只写 stderr 然后 exit(1)，打包后的 GUI 进程里 stderr 没人看，
 *  用户看到的只有主进程自己的「minisd 退出 code=1」堆栈——真正的原因（例如库比应用新）进不了对话框。
 *
 *  本文件不 import src/main/index.ts（那要给 electron 打桩，ipc-contract.test.ts 已有一份，不再复制第二份）；
 *  主进程的接线用源码守卫核对调用形态，被调的纯函数在这里单测。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMinisdFatal, fatalDialogOptions, MinisdFatalError, withStderrTail } from '../src/main/minisd-fatal';
import {
  toMinisdFatal, reportStartupFailure, MINISD_FATAL_CODES, STARTUP_FAILURE_EXIT_DELAY_MS, type MinisdFatal,
} from '../src/minisd/fatal';
import { DbNewerThanAppError } from '../src/minisd/store/db';
import { DATA_ROOT_LOCK_NAME } from '../src/minisd/paths';

const repoRoot = join(__dirname, '..');
const readSrc = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');

const ROOT = 'C:\\Users\\me\\AppData\\Roaming\\DeskMinis';
const DB_NEWER: MinisdFatal = { code: 'DB_NEWER_THAN_APP', dbVersion: 12, appVersion: 11, dataRoot: ROOT };
const LOCKED: MinisdFatal = { code: 'DATA_ROOT_LOCKED', pid: 4242, dataRoot: ROOT };

/** 从 anchor 之后的第一个 `{` 起做括号配对，取出块体（源码守卫用；本仓库这几段里没有不配对的花括号字符串）。 */
function blockAfter(src: string, anchor: string, from = 0): string {
  const at = src.indexOf(anchor, from);
  expect(at, `源码里找不到锚点 ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', at + anchor.length - 1);
  let depth = 1; let i = open + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(open + 1, i - 1);
}

/** 假的 stdout / stderr / exit / 定时器：记录调用顺序。write 回调与定时器都由测试手动触发，
 *  模拟「管道稍后才写完」「延迟稍后才到点」。 */
function fakeIo() {
  const events: string[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const pendingWrites: Array<() => void> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  return {
    events, stdoutLines, stderrLines, timers,
    /** 让所有已发出的 write 完成（按发出顺序调回调）。 */
    flushWrites: (): void => { for (const cb of pendingWrites.splice(0)) cb(); },
    /** 让所有已排的定时器到点。 */
    runTimers: (): void => { for (const t of timers.splice(0)) t.fn(); },
    io: {
      stdout: { write: (s: string, cb: () => void): boolean => { events.push('stdout'); stdoutLines.push(s); pendingWrites.push(cb); return true; } },
      stderr: { write: (s: string, cb: () => void): boolean => { events.push('stderr'); stderrLines.push(s); pendingWrites.push(cb); return true; } },
      exit: (code: number): void => { events.push(`exit:${code}`); },
      later: (fn: () => void, ms: number): void => { events.push(`later:${ms}`); timers.push({ fn, ms }); },
    },
  };
}

describe('parseMinisdFatal（主进程侧解析）', () => {
  it('解析两种致命行', () => {
    expect(parseMinisdFatal(JSON.stringify({ minisdFatal: DB_NEWER }))).toEqual(DB_NEWER);
    expect(parseMinisdFatal(JSON.stringify({ minisdFatal: LOCKED }))).toEqual(LOCKED);
  });

  it('普通日志行、握手行、未知 code、缺字段、类型不对 → undefined（当普通日志转发）', () => {
    expect(parseMinisdFatal('minisd 启动失败: Error: boom')).toBeUndefined();
    expect(parseMinisdFatal('not json')).toBeUndefined();
    expect(parseMinisdFatal('null')).toBeUndefined();
    expect(parseMinisdFatal('[1,2]')).toBeUndefined();
    expect(parseMinisdFatal(JSON.stringify({ minisdPort: 51234, authToken: 'T' }))).toBeUndefined();
    expect(parseMinisdFatal(JSON.stringify({ minisdFatal: { ...DB_NEWER, code: 'SOMETHING_ELSE' } }))).toBeUndefined();
    expect(parseMinisdFatal(JSON.stringify({ minisdFatal: { code: 'DB_NEWER_THAN_APP', dataRoot: ROOT } }))).toBeUndefined();
    expect(parseMinisdFatal(JSON.stringify({ minisdFatal: { ...DB_NEWER, dbVersion: '12' } }))).toBeUndefined();
    expect(parseMinisdFatal(JSON.stringify({ minisdFatal: { ...DB_NEWER, dataRoot: 7 } }))).toBeUndefined();
    expect(parseMinisdFatal(JSON.stringify({ minisdFatal: { code: 'DATA_ROOT_LOCKED', dataRoot: ROOT } }))).toBeUndefined();
    expect(parseMinisdFatal(JSON.stringify({ minisdFatal: 'DB_NEWER_THAN_APP' }))).toBeUndefined();
  });

  it('只带出白名单字段：错误对象上的其它字段（堆栈、消息）不进对话框', () => {
    const line = JSON.stringify({ minisdFatal: { ...DB_NEWER, stack: 'at secret (C:\\x)', message: 'boom' } });
    expect(parseMinisdFatal(line)).toEqual(DB_NEWER);
  });

  it('白名单恰为设计稿 §3 第 8 条的两个 code', () => {
    expect([...MINISD_FATAL_CODES].sort()).toEqual(['DATA_ROOT_LOCKED', 'DB_NEWER_THAN_APP']);
  });
});

describe('minisd 侧：reportStartupFailure 写致命行、写完再延迟 exit(1)', () => {
  it('DbNewerThanAppError：stderr 那行照旧；stdout 恰一行致命行，主进程能原样解析回来', () => {
    const f = fakeIo();
    reportStartupFailure(new DbNewerThanAppError(12, 11), ROOT, f.io);
    expect(f.stderrLines.join('')).toMatch(/^minisd 启动失败: /);
    expect(f.stdoutLines).toHaveLength(1);
    expect(f.stdoutLines[0].endsWith('\n')).toBe(true);
    expect(f.stdoutLines[0].slice(0, -1)).not.toContain('\n');
    expect(parseMinisdFatal(f.stdoutLines[0].trimEnd())).toEqual(DB_NEWER);
  });

  it('exit(1) 在 stdout 写回调之后、再等 STARTUP_FAILURE_EXIT_DELAY_MS 才发生——早退会丢掉这一行', () => {
    const f = fakeIo();
    reportStartupFailure(new DbNewerThanAppError(12, 11), ROOT, f.io);
    expect(f.events.filter(e => /^(exit|later)/.test(e)), '写回调之前既不得 exit 也不得排退出').toEqual([]);
    f.flushWrites();
    expect(f.events.filter(e => e.startsWith('exit')), '写回调里不得立刻 exit：主进程收到 exit 就不再读管道').toEqual([]);
    expect(f.timers.map(t => t.ms)).toEqual([STARTUP_FAILURE_EXIT_DELAY_MS]);
    f.runTimers();
    expect(f.events.filter(e => e.startsWith('exit'))).toEqual(['exit:1']);
  });

  it('延迟取值：不小于实测够用的 30ms，也不大到让通用失败框明显变慢', () => {
    expect(STARTUP_FAILURE_EXIT_DELAY_MS).toBeGreaterThanOrEqual(30);
    expect(STARTUP_FAILURE_EXIT_DELAY_MS).toBeLessThanOrEqual(1_000);
  });

  it('错误自带 dataRoot 时以它为准（W1b 的 DataRootLockedError 会带），否则用调用方给的数据根', () => {
    const locked = Object.assign(new Error('locked'), { code: 'DATA_ROOT_LOCKED', pid: 4242, dataRoot: 'D:\\other' });
    expect(toMinisdFatal(locked, ROOT)).toEqual({ code: 'DATA_ROOT_LOCKED', pid: 4242, dataRoot: 'D:\\other' });
    expect(toMinisdFatal(new DbNewerThanAppError(12, 11), ROOT)).toEqual(DB_NEWER);
  });

  it('非致命错误：不写 stdout；stderr 照旧，同样等它写完再延迟退出（它是通用失败框里「真正原因」的来源）', () => {
    const f = fakeIo();
    reportStartupFailure(new Error('EADDRINUSE'), ROOT, f.io);
    expect(f.stdoutLines).toEqual([]);
    expect(f.stderrLines.join('')).toContain('minisd 启动失败: Error: EADDRINUSE');
    expect(f.events).toEqual(['stderr']);
    f.flushWrites();
    expect(f.events).toEqual(['stderr', `later:${STARTUP_FAILURE_EXIT_DELAY_MS}`]);
    f.runTimers();
    expect(f.events).toEqual(['stderr', `later:${STARTUP_FAILURE_EXIT_DELAY_MS}`, 'exit:1']);
  });

  it('致命错误只排一次退出（stderr 与 stdout 两次写，只有最后那次的回调排退出）', () => {
    const f = fakeIo();
    reportStartupFailure(new DbNewerThanAppError(12, 11), ROOT, f.io);
    expect(f.events).toEqual(['stderr', 'stdout']);
    f.flushWrites();
    f.runTimers();
    expect(f.events).toEqual(['stderr', 'stdout', `later:${STARTUP_FAILURE_EXIT_DELAY_MS}`, 'exit:1']);
  });

  it('非 Error 抛出物也能处理', () => {
    const f = fakeIo();
    reportStartupFailure('plain string', ROOT, f.io);
    expect(f.stderrLines.join('')).toContain('plain string');
    f.flushWrites(); f.runTimers();
    expect(f.events).toEqual(['stderr', `later:${STARTUP_FAILURE_EXIT_DELAY_MS}`, 'exit:1']);
  });
});

describe('fatalDialogOptions（对话框文案）', () => {
  const allText = (o: ReturnType<typeof fatalDialogOptions>): string =>
    [o.title, o.message, o.detail, ...(o.buttons ?? [])].join('\n');

  it('DB_NEWER_THAN_APP：只有「退出」，中文，带两个版本号与数据目录，不出现任何破坏性字眼', () => {
    const o = fatalDialogOptions(DB_NEWER);
    expect(o.buttons).toEqual(['退出']);
    expect(o.type).toBe('error');
    expect(o.title).toBe('DeskMinis 无法打开数据');
    expect(o.message).toBe('这份数据来自更新版本的 DeskMinis');
    const text = allText(o);
    expect(text).toContain('更新版本');
    expect(text).toContain('12');
    expect(text).toContain('11');
    expect(text).toContain(ROOT);
    expect(text).not.toMatch(/清空|删除|重置|覆盖/);
    expect(o.defaultId).toBe(0);
    expect(o.cancelId).toBe(0);
  });

  it('DATA_ROOT_LOCKED：只有「退出」，带进程号与数据目录，不出现任何破坏性字眼', () => {
    const o = fatalDialogOptions(LOCKED);
    expect(o.buttons).toEqual(['退出']);
    expect(o.title).toBe('DeskMinis 已在运行');
    const text = allText(o);
    expect(text).toContain('4242');
    expect(text).toContain(ROOT);
    expect(text).not.toMatch(/清空|删除|重置|覆盖/);
  });

  it('DATA_ROOT_LOCKED 的 detail 写明锁文件路径（W1b-3）：Windows 会复用进程号，误判「已在运行」时，照着路径找得到那把锁', () => {
    const o = fatalDialogOptions(LOCKED);
    expect(o.detail).toContain(join(ROOT, DATA_ROOT_LOCK_NAME));
    expect(o.buttons, '仍然只有「退出」').toEqual(['退出']);
  });

  it('文案里不漏内部标识符（code 名不上屏）', () => {
    expect(allText(fatalDialogOptions(DB_NEWER))).not.toMatch(/DB_NEWER_THAN_APP|minisdFatal/);
    expect(allText(fatalDialogOptions(LOCKED))).not.toMatch(/DATA_ROOT_LOCKED|minisdFatal/);
  });

  it('MinisdFatalError 带着解析出的致命信息', () => {
    const e = new MinisdFatalError(DB_NEWER);
    expect(e).toBeInstanceOf(Error);
    expect(e.fatal).toEqual(DB_NEWER);
  });
});

describe('withStderrTail（通用失败框附 stderr 末尾）', () => {
  it('有尾巴就附上，没有就原样', () => {
    const out = withStderrTail('Error: minisd 退出 code=1', 'minisd 启动失败: Error: boom\n');
    expect(out.startsWith('Error: minisd 退出 code=1')).toBe(true);
    expect(out).toContain('minisd 启动失败: Error: boom');
    expect(withStderrTail('Error: x', '')).toBe('Error: x');
    expect(withStderrTail('Error: x', '  \n')).toBe('Error: x');
  });
});

describe('接线（源码守卫：认调用形态）', () => {
  const main = readSrc('src/main/index.ts');
  const minisd = readSrc('src/minisd/index.ts');

  it('主进程 whenReady 的 catch 分支：致命错误走 showMessageBoxSync(fatalDialogOptions(…))，其余走 showErrorBox 并附 stderr 末尾', () => {
    const ready = main.indexOf('app.whenReady().then(');
    expect(ready).toBeGreaterThanOrEqual(0);
    const catchBody = blockAfter(main, '} catch (e) {', ready);
    expect(catchBody).toMatch(/instanceof MinisdFatalError/);
    expect(catchBody).toMatch(/\bshowMessageBoxSync\(\s*fatalDialogOptions\(/);
    expect(catchBody, '异步版在 Linux 上点完要等下一次事件唤醒才 resolve，应用迟迟不退').not.toMatch(/\bshowMessageBox\(/);
    expect(catchBody).toMatch(/\bfatalDialogOptions\(/);
    expect(catchBody).toMatch(/\bshowErrorBox\(/);
    expect(catchBody).toMatch(/\bwithStderrTail\(/);
    expect(catchBody).toMatch(/app\.quit\(\)/);
  });

  it('主进程 stdout 行循环先认致命行（parseMinisdFatal 在 parseHandshake 之前），命中即以 MinisdFatalError 结束等待', () => {
    const body = blockAfter(main, "minisd.stdout?.on('data'");
    const iFatal = body.search(/\bparseMinisdFatal\(/);
    const iHs = body.search(/\bparseHandshake\(/);
    expect(iFatal).toBeGreaterThanOrEqual(0);
    expect(iHs).toBeGreaterThan(iFatal);
    expect(body).toMatch(/new MinisdFatalError\(/);
  });

  it('主进程 stderr 进 4KB 环形缓冲（只实现一次，后续步骤复用同一个模块级实例）', () => {
    const body = blockAfter(main, "minisd.stderr?.on('data'");
    expect(body).toMatch(/minisdStderrTail\.push\(/);
    expect(main).toMatch(/const minisdStderrTail = new TailBuffer\(STDERR_TAIL_BYTES\)/);
    expect(main.match(/new TailBuffer\(/g) ?? [], '环形缓冲只建一个').toHaveLength(1);
  });

  it('minisd standalone 的 catch 调 reportStartupFailure(e, dataRoot())', () => {
    const standalone = minisd.slice(minisd.indexOf("if (process.env.DESKMINIS_STANDALONE === '1')"));
    expect(standalone).toMatch(/\.catch\(\s*e\s*=>\s*reportStartupFailure\(\s*e\s*,\s*dataRoot\(\)\s*\)\s*\)/);
  });
});
