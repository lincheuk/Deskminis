/** W2b-7（设计稿 §2「生命周期」· 侦察 lifecycle.md「W2b-crashlog」）：崩溃钩子的行为。
 *
 *  - minisd（只在 standalone 分支装）：uncaughtException 先同步记一条再 exit(1)，保持「会崩」的语义；
 *    unhandledRejection 记一条后继续跑——以前 Node 默认把它当未捕获异常直接打死引擎，界面永远停在「运行中」。
 *  - 主进程（whenReady 里装）：uncaughtException 记一条再弹错误框、继续运行（与 Electron 默认一样看得见，
 *    挂了自己的监听之后 Electron 那个默认框就不弹了，所以要自己弹）；unhandledRejection 只记一条。
 *    先落盘、后弹框（弹框那一刻记录与日志行已经记下）：真 Electron 里这个框阻塞主线程，托盘常驻的应用弹出的框
 *    可能一直没人点，接着关机、注销或被结束进程，框后面才写的记录就永远没了，框里给的记录位置也指向一条不存在的记录。
 *  - 握手之后、不在退出流程中的 minisd 退出才记 minisd_exit：握手前是启动失败（另有对话框），
 *    请求过关停或主进程已经在退出（例如建窗口失败后主进程自己 kill 掉它）都不是崩溃。
 *  - 日志目录：主进程经 DESKMINIS_LOG_DIR 下发；没下发（不经主进程直接起的 standalone）时按同一套规则回退。
 *  钩子装在注入的假 process（EventEmitter）上，退出、时间、stderr 都注入，不碰真进程。 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppDirs } from '../src/main/app-dirs';
import { defaultLogRoot, logRootFromEnv } from '../src/minisd/paths';

type Hooks = typeof import('../src/minisd/diag/crash-hooks');
let hooks: Hooks;
let added = { uncaught: -1, rejection: -1 };

beforeAll(async () => {
  const before = { uncaught: process.listenerCount('uncaughtException'), rejection: process.listenerCount('unhandledRejection') };
  hooks = await import('../src/minisd/diag/crash-hooks');
  added = {
    uncaught: process.listenerCount('uncaughtException') - before.uncaught,
    rejection: process.listenerCount('unhandledRejection') - before.rejection,
  };
});

const dirs: string[] = [];
function tmpLogRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dm-crashhooks-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NOW = new Date('2026-09-25T08:00:00.000Z');
type Rec = { timestamp: string; version: string; process: string; kind: string; message: string; stack: string | null; exitCode?: number; stderrTail?: string };
const crashes = (logRoot: string): Rec[] => {
  try { return JSON.parse(readFileSync(join(logRoot, 'crashes.json'), 'utf8')) as Rec[]; } catch { return []; }
};

it('import 本模块不在 process 上挂任何监听：钩子只在调用安装函数时才装', () => {
  expect(added).toEqual({ uncaught: 0, rejection: 0 });
});

describe('minisd 的钩子', () => {
  function install(logRoot: string, extra: { report?: (t: string) => void } = {}) {
    const proc = new EventEmitter();
    const exits: number[] = [];
    const reports: string[] = [];
    let seenAtExit: Rec[] | undefined;
    hooks.installMinisdCrashHandlers(logRoot, {
      version: '0.3.0-t', proc, now: () => NOW,
      exit: (code) => { seenAtExit ??= crashes(logRoot); exits.push(code); },
      report: extra.report ?? ((t) => { reports.push(t); }),
    });
    return { proc, exits, reports, seenAtExit: () => seenAtExit };
  }

  it('各挂一个 uncaughtException 与 unhandledRejection 监听', () => {
    const { proc } = install(tmpLogRoot());
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
  });

  it('unhandledRejection：记一条 minisd / unhandled_rejection，不退出，stderr 说一句「继续运行」', () => {
    const root = tmpLogRoot();
    const { proc, exits, reports } = install(root);
    const err = new Error('库忙');
    proc.emit('unhandledRejection', err, Promise.resolve());
    expect(crashes(root)).toEqual([{
      timestamp: NOW.toISOString(), version: '0.3.0-t', process: 'minisd', kind: 'unhandled_rejection', message: '库忙', stack: err.stack,
    }]);
    expect(exits).toEqual([]);
    expect(reports.join('')).toContain('库忙');
    expect(reports.join('')).toMatch(/继续/);
  });

  it('uncaughtException：先同步落盘，再 exit(1)，只退一次', () => {
    const root = tmpLogRoot();
    const { proc, exits, seenAtExit, reports } = install(root);
    proc.emit('uncaughtException', new Error('炸了'));
    expect(exits).toEqual([1]);
    expect(seenAtExit()?.map(r => [r.process, r.kind, r.message]), '退出那一刻记录已经在盘上').toEqual([['minisd', 'uncaught_exception', '炸了']]);
    expect(reports.join('')).toContain('炸了');
  });

  it('记不下来（日志目录是个普通文件）、stderr 也写不了：照样 exit(1)，监听自己不抛', () => {
    const plain = join(tmpLogRoot(), 'plain.txt');
    writeFileSync(plain, 'x');
    const { proc, exits } = install(plain, { report: () => { throw new Error('EPIPE'); } });
    expect(() => proc.emit('uncaughtException', new Error('炸了'))).not.toThrow();
    expect(exits).toEqual([1]);
    expect(() => proc.emit('unhandledRejection', 'x')).not.toThrow();
    expect(exits).toEqual([1]);
  });

  it('版本号缺省取 DESKMINIS_APP_VERSION（主进程下发），没有就是 unknown', () => {
    expect(hooks.appVersionFromEnv({ DESKMINIS_APP_VERSION: '0.3.0' })).toBe('0.3.0');
    expect(hooks.appVersionFromEnv({})).toBe('unknown');
    expect(hooks.appVersionFromEnv({ DESKMINIS_APP_VERSION: '' })).toBe('unknown');
  });
});

describe('主进程的钩子', () => {
  function install(logRoot: string, showErrorBox: (title: string, content: string) => void) {
    const proc = new EventEmitter();
    const logs: string[] = [];
    // 弹框那一刻盘上的记录与已经记下的日志行（同 minisd 那边的 seenAtExit）
    const atBox: Array<{ recs: Rec[]; logs: string[] }> = [];
    hooks.installMainCrashHandlers({
      logRoot, version: '0.3.0-m', proc, now: () => NOW,
      showErrorBox: (title, content) => { atBox.push({ recs: crashes(logRoot), logs: [...logs] }); showErrorBox(title, content); },
      log: (l) => { logs.push(l); }, report: () => {},
    });
    return { proc, logs, atBox };
  }

  it('uncaughtException：先记一条 main / uncaught_exception、按天日志记一行，再弹一次错误框（带原因与记录位置），不退出', () => {
    const root = tmpLogRoot();
    const boxes: Array<[string, string]> = [];
    const { proc, logs, atBox } = install(root, (t, c) => { boxes.push([t, c]); });
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    proc.emit('uncaughtException', new Error('托盘炸了'));
    expect(crashes(root).map(r => [r.process, r.kind, r.message, r.version])).toEqual([['main', 'uncaught_exception', '托盘炸了', '0.3.0-m']]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0][1]).toContain('托盘炸了');
    expect(boxes[0][1]).toContain(join(root, 'crashes.json'));
    expect(logs.join('\n')).toContain('托盘炸了');
    expect(atBox.map(s => s.recs.map(r => [r.process, r.kind, r.message])), '弹框那一刻记录已经在盘上')
      .toEqual([[['main', 'uncaught_exception', '托盘炸了']]]);
    expect(atBox[0]?.logs.join('\n'), '弹框那一刻按天日志那一行已经记下').toContain('托盘炸了');
  });

  it('unhandledRejection：只记一条 main / unhandled_rejection，不弹框', () => {
    const root = tmpLogRoot();
    const boxes: unknown[] = [];
    const { proc, logs } = install(root, (...a) => { boxes.push(a); });
    proc.emit('unhandledRejection', new Error('更新检查失败'), Promise.resolve());
    expect(crashes(root).map(r => [r.process, r.kind, r.message])).toEqual([['main', 'unhandled_rejection', '更新检查失败']]);
    expect(boxes).toEqual([]);
    expect(logs.join('\n')).toContain('更新检查失败');
  });

  it('弹框本身抛错、记录写不下：监听不抛（监听里再抛，进程就以 7 退出了）', () => {
    const plain = join(tmpLogRoot(), 'plain.txt');
    writeFileSync(plain, 'x');
    let tried = 0;
    const { proc } = install(plain, () => { tried++; throw new Error('还没 ready'); });
    expect(() => proc.emit('uncaughtException', new Error('x'))).not.toThrow();
    expect(tried, '记录写不下也照样弹框').toBe(1);
  });
});

describe('minisd 退出算不算崩溃', () => {
  const base = { code: 3, handshaken: true, stopRequested: false, quitting: false, version: '0.3.0', stderrTail: 'Error: boom\n' };

  it('握手之后、没请求关停、主进程也不在退出：记 minisd_exit，带退出码与 stderr 末尾', () => {
    expect(hooks.minisdExitCrash(base)).toEqual({
      process: 'minisd', kind: 'minisd_exit', version: '0.3.0', message: expect.stringContaining('3'), exitCode: 3, stderrTail: 'Error: boom\n',
    });
    expect(hooks.minisdExitCrash({ ...base, code: 0 })?.exitCode, '没人请求的退出，退出码是 0 也算：界面照样没了引擎').toBe(0);
  });

  it('握手前（启动失败，另有对话框）、请求过关停、主进程已在退出：都不记', () => {
    expect(hooks.minisdExitCrash({ ...base, handshaken: false })).toBeUndefined();
    expect(hooks.minisdExitCrash({ ...base, stopRequested: true })).toBeUndefined();
    expect(hooks.minisdExitCrash({ ...base, quitting: true })).toBeUndefined();
  });
});

describe('日志目录（minisd 侧）', () => {
  it('DESKMINIS_LOG_DIR 优先；其次 <DESKMINIS_DATA_DIR>/logs；都没有时按正式版规则回退；空串当没设', () => {
    expect(logRootFromEnv({ DESKMINIS_LOG_DIR: '/l', DESKMINIS_DATA_DIR: '/d' })).toBe('/l');
    expect(logRootFromEnv({ DESKMINIS_LOG_DIR: '', DESKMINIS_DATA_DIR: '/d' })).toBe(join('/d', 'logs'));
    const win = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', HOME: '/home/me' };
    expect(logRootFromEnv(win)).toBe(defaultLogRoot(win, 'prod'));
    expect(defaultLogRoot(win, 'prod')).toBe(join(win.LOCALAPPDATA, 'DeskMinis', 'logs'));
    expect(defaultLogRoot(win, 'dev')).toBe(join(win.LOCALAPPDATA, 'DeskMinis-dev', 'logs'));
    expect(defaultLogRoot({ HOME: '/home/me' }, 'prod')).toBe(join('/home/me', '.local', 'state', 'DeskMinis', 'logs'));
  });

  it('与主进程 resolveAppDirs 是同一套规则（两边各写一份迟早漂移）', () => {
    const base = mkdtempSync(join(tmpdir(), 'dm-logroot-'));
    dirs.push(base);
    for (const env of [{ LOCALAPPDATA: join(base, 'Local') }, { HOME: base }]) {
      expect(resolveAppDirs({ isPackaged: true, env }).logRoot).toBe(defaultLogRoot(env, 'prod'));
      expect(resolveAppDirs({ isPackaged: false, env }).logRoot).toBe(defaultLogRoot(env, 'dev'));
    }
  });
});
