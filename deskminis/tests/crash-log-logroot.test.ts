/** W2b-7（设计稿 §2「生命周期」· 侦察 lifecycle.md「W2b-crashlog」【目录】）：主进程自己写的日志都落在日志目录，
 *  也就是下发给 minisd 的 DESKMINIS_LOG_DIR，不落在数据根下。
 *
 *  规则（src/main/app-dirs.ts）：日志与崩溃记录在 LOCALAPPDATA 下的 DeskMinis[-dev]/logs，数据根在 APPDATA 下；
 *  只有设了 DESKMINIS_DATA_DIR 时两者才都在它下面（日志在 <DATA_DIR>/logs）。别的接线测试都经 bootMain 设了 DATA_DIR，
 *  这时日志目录恰好等于 <数据根>/logs：主进程写日志的三处（按天日志、main 的崩溃记录、exit 监听里记的 minisd_exit）
 *  改成写「数据根下的 logs」，或按 minisd 那边的回退规则另算（logRootFromEnv），那些测试照样全绿（三审实测）。
 *  写错了的后果：打包后主进程的日志进 Roaming\DeskMinis\logs（随漫游 / OneDrive 同步，还在数据根里、按写闸的「其余」走卡），
 *  minisd 仍按 DESKMINIS_LOG_DIR 写 Local 下的 crashes.json，一次引擎崩溃的两条记录分在两个文件里；
 *  或者 dev 的日志写进正式版的目录。
 *
 *  所以这里用 bootMain 的 platformDirs：不设 DATA_DIR，APPDATA 与 LOCALAPPDATA 各指向一个临时目录，两条规则分得开。
 *  桩的 isPackaged 是 false：数据根是 <APPDATA>/DeskMinis-dev，日志目录应是 <LOCALAPPDATA>/DeskMinis-dev/logs。
 *  目录规则在这里照设计稿另写一遍、不借产品的 resolveAppDirs：产品把规则算错了，这里要跟着红。
 *  主进程模块每个 worker 只能 import 一次，所以单开一个文件；electron 桩与启动器在 tests/main-window-guard-harness.ts。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { logRootFromEnv } from '../src/minisd/paths';
import { bootMain, h } from './main-window-guard-harness';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

let restore = (): void => {};
let appData = '';
let localAppData = '';
let logDir = '';
beforeAll(async () => {
  restore = await bootMain({ rendererUrl: undefined, platformDirs: true });
  appData = process.env.APPDATA ?? '';
  localAppData = process.env.LOCALAPPDATA ?? '';
  logDir = join(localAppData, 'DeskMinis-dev', 'logs');
}, 30_000);
afterAll(() => { restore(); });

type Rec = { process: string; kind: string; message: string; exitCode?: number };
const crashesIn = (dir: string): Rec[] => {
  try { return JSON.parse(readFileSync(join(dir, 'crashes.json'), 'utf8')) as Rec[]; } catch { return []; }
};
const DAILY_LOG = /^minisd-\d{4}-\d{2}-\d{2}\.log$/;
/** dir 里按天日志的全文（跨午夜也不漏） */
const dailyLogIn = (dir: string): string => {
  try {
    return readdirSync(dir).filter(f => DAILY_LOG.test(f)).sort().map(f => readFileSync(join(dir, f), 'utf8')).join('');
  } catch { return ''; }
};
/** root 之下的全部文件（递归） */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(root);
  return out;
}
/** 主进程往 stderr 说的那几句：测试里闭嘴 */
function quietly(fn: () => void): void {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { fn(); } finally { spy.mockRestore(); }
}

describe('不设 DESKMINIS_DATA_DIR：主进程的日志与崩溃记录在 <LOCALAPPDATA>/DeskMinis-dev/logs，与数据根分开，也就是下发给 minisd 的那个目录', () => {
  it('前提：没设 DATA_DIR，APPDATA 与 LOCALAPPDATA 是两个不同的临时目录；主进程 fork 了一次引擎、握手完、建好了托盘', () => {
    expect(process.env.DESKMINIS_DATA_DIR).toBeUndefined();
    expect(appData).not.toBe('');
    expect(localAppData).not.toBe('');
    expect(localAppData).not.toBe(appData);
    expect(h.forks).toHaveLength(1);
    expect(h.trayCreated).toBe(true);
  });

  it('下发给 minisd 的 DESKMINIS_LOG_DIR 就是这个目录，数据根另在 <APPDATA>/DeskMinis-dev；minisd 按这份 env 算出的也是它', () => {
    const env = h.forks[0]?.env ?? {};
    expect(env.DESKMINIS_LOG_DIR).toBe(logDir);
    expect(env.DESKMINIS_DATA_DIR).toBe(join(appData, 'DeskMinis-dev'));
    // standalone 分支按 logRootFromEnv(process.env) 装崩溃钩子（crash-log-wiring 的源码守卫钉着），它拿到的就是这份 env
    expect(logRootFromEnv(env)).toBe(logDir);
  });

  it('主进程未捕获异常、引擎握手后意外退出：两条记录都进这个目录的 crashes.json（引擎自己写的也是它），错误框里指的也是它', () => {
    const boxes = h.errorBoxes.length;
    quietly(() => h.crashListeners.uncaught[0]?.(new Error('注入：主进程未捕获'), 'uncaughtException'));
    // 桩子进程已经握过手，没请求过关停，主进程也不在退出：这次退出是崩溃
    quietly(() => h.child.exit[0]?.(1));
    expect(crashesIn(logDir).map(r => [r.process, r.kind, r.message])).toEqual([
      ['main', 'uncaught_exception', '注入：主进程未捕获'],
      ['minisd', 'minisd_exit', expect.stringContaining('code=1')],
    ]);
    expect(h.errorBoxes).toHaveLength(boxes + 1);
    expect(h.errorBoxes[boxes]?.[1]).toContain(join(logDir, 'crashes.json'));
  });

  it('按天日志也在这个目录：生命周期行、主进程未捕获异常那一行、引擎意外退出那一行', () => {
    const text = dailyLogIn(logDir);
    expect(text).toMatch(/\[main\] 启动引擎进程/);
    expect(text).toMatch(/\[main\] 引擎握手完成，端口 45678/);
    expect(text).toMatch(/\[main\] 未捕获异常：Error: 注入：主进程未捕获/);
    expect(text).toMatch(/\[main\] 引擎进程退出 code=1（意外退出，已记入崩溃记录）/);
  });

  it('别处没有：数据根下没有 logs；两个临时目录里，这个目录以外没有 crashes.json，也没有按天日志', () => {
    expect(existsSync(join(appData, 'DeskMinis-dev', 'logs')), '日志不进数据根（Roaming 下会跟着漫游 / OneDrive 同步）').toBe(false);
    const stray = [...filesUnder(appData), ...filesUnder(localAppData)]
      .filter(p => (basename(p) === 'crashes.json' || DAILY_LOG.test(basename(p))) && dirname(p) !== logDir);
    expect(stray).toEqual([]);
  });
});
