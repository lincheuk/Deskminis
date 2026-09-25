/** W2b-7（设计稿 §4 S25、§3 第 11 条 · 侦察 lifecycle.md「W2b-crashlog」）：主进程的崩溃记录与按天日志接线。
 *
 *  ① 行为：用 tests/main-window-guard-harness.ts 的 electron 桩把 src/main/index.ts 真跑一遍（whenReady 在 worker 里真跑，
 *     数据根是 mkdtemp 临时目录，日志落 <数据根>/logs——设了 DESKMINIS_DATA_DIR 时日志目录就是它；
 *     两者分开的情形在 tests/crash-log-logroot.test.ts），桩子进程把主进程挂上来的监听交给测试：
 *     - whenReady 在 process 上各挂一个 uncaughtException / unhandledRejection 监听，调它们就记进 crashes.json；
 *       未捕获异常还要弹一次错误框（挂了自己的监听，Electron 默认的框就不弹了），弹框那一刻记录与日志行已经在盘上；
 *     - 按天日志：fork、握手端口两行生命周期；stdout 的非握手行；stderr 按行切（分块到达的半行、半个汉字都拼回来）；
 *       握手行带 per-run token，一个字也不落盘；启动时删掉超过 7 天的（import 主进程之前预置 8 天前与昨天的两份，
 *       启动后前者没了、后者还在——没接上这一步，日志目录就只增不减，每天最多 10MB）；
 *     - 优雅退出：before-quit → 发 shutdown（日志记「请求引擎关停」）→ 引擎以 0 退出 → 不是崩溃，crashes.json 里没有 minisd_exit。
 *       这时 quitting 与 stopRequested 同时为真，两个条件任一成立这条都绿；只有 quitting 为真的那种退出
 *       （握手后建窗口失败，主进程自己 kill 引擎）在 tests/crash-log-window-fail.test.ts。
 *       「握手后、没请求过关停的退出记 minisd_exit」那一半在 tests/crash-log-fork.test.ts 里用真子进程跑，
 *       「握手前退出是启动失败、不记崩溃」在 tests/crash-log-startup-fail.test.ts。
 *  ② 源码守卫（先剥注释再匹配）：两个进程的崩溃监听都只经安装函数挂——main 在 whenReady 早退之后、起更新检查与 fork 之前；
 *     minisd 只在 standalone 分支、作为分支第一句（进程内起 minisd 的 20 个测试不能被装上钩子）；
 *     exit 监听里判崩溃用的是握手与退出流程两个状态，连传进去的值一起钉（stopRequested 只有这里钉得住，见守卫处的说明）。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';
import { bootMain, h } from './main-window-guard-harness';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

/** 本地日历上 n 天前那天的按天日志文件名（产品按本地日期分文件）。在这里另写一遍、不借产品的 localDateStamp：
 *  文件名长什么样由测试自己说了算，产品那边改了（比如换了格式），预置的名字不会跟着一起变。 */
function dailyLogNameDaysAgo(n: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `minisd-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`;
}
/** import 主进程之前预置的两份旧日志：8 天前的该删，昨天的该留。
 *  不预置正好 7 天前的边界：预置与清理之间跨了午夜，它就变成 8 天前、该删了（边界在 tests/daily-log.test.ts 用注入的时间测）；
 *  跨午夜对这两份没有影响——8 天前的只会更旧，昨天的变成前天也还在 7 天内。 */
const seeded = { stale: '', recent: '' };
const RECENT_TEXT = '（预置）昨天的按天日志\n';

let restore = (): void => {};
let logDir = '';
beforeAll(async () => {
  restore = await bootMain({
    rendererUrl: undefined,
    beforeImport: dataDir => {
      const dir = join(dataDir, 'logs');
      mkdirSync(dir, { recursive: true });
      seeded.stale = dailyLogNameDaysAgo(8);
      seeded.recent = dailyLogNameDaysAgo(1);
      writeFileSync(join(dir, seeded.stale), '（预置）8 天前的按天日志\n');
      writeFileSync(join(dir, seeded.recent), RECENT_TEXT);
    },
  });
  logDir = join(process.env.DESKMINIS_DATA_DIR ?? '', 'logs');
}, 30_000);
afterAll(() => { restore(); });

type Rec = { process: string; kind: string; message: string; version: string; exitCode?: number; stderrTail?: string };
const crashes = (): Rec[] => {
  try { return JSON.parse(readFileSync(join(logDir, 'crashes.json'), 'utf8')) as Rec[]; } catch { return []; }
};
/** 这次启动写的按天日志全文（跨午夜也不漏；不含预置的旧日志） */
const dailyLog = (): string => {
  try {
    return readdirSync(logDir).filter(f => /^minisd-\d{4}-\d{2}-\d{2}\.log$/.test(f) && f !== seeded.stale && f !== seeded.recent).sort()
      .map(f => readFileSync(join(logDir, f), 'utf8')).join('');
  } catch { return ''; }
};
/** 主进程把子进程输出转发到自己的 stderr：测试里闭嘴 */
function quietly(fn: () => void): void {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { fn(); } finally { spy.mockRestore(); }
}

describe('① 主进程自己的崩溃', () => {
  it('whenReady 在 process 上各挂一个 uncaughtException 与 unhandledRejection 监听', () => {
    expect(h.crashListeners.uncaught).toHaveLength(1);
    expect(h.crashListeners.rejection).toHaveLength(1);
  });

  it('未捕获异常：记一条 main / uncaught_exception（版本号是 app.getVersion()），按天日志留一行，然后才弹一次错误框', () => {
    const boxes = h.errorBoxes.length;
    // 真 Electron 里这个框阻塞主线程：弹框那一刻盘上已经有什么，才是用户一直不点掉（接着关机、结束进程）时留下的
    const atBox: Array<{ recs: Rec[]; log: string }> = [];
    h.onBlockingDialog = () => { atBox.push({ recs: crashes(), log: dailyLog() }); };
    try {
      quietly(() => h.crashListeners.uncaught[0]?.(new Error('注入：主进程未捕获'), 'uncaughtException'));
    } finally {
      h.onBlockingDialog = undefined;
    }
    const recs = crashes().filter(r => r.process === 'main' && r.kind === 'uncaught_exception');
    expect(recs.map(r => [r.message, r.version])).toEqual([['注入：主进程未捕获', '0.0.0-test']]);
    expect(h.errorBoxes).toHaveLength(boxes + 1);
    expect(h.errorBoxes[boxes]?.[1]).toContain('注入：主进程未捕获');
    expect(dailyLog()).toContain('注入：主进程未捕获');
    expect(atBox.map(s => s.recs.filter(r => r.process === 'main' && r.kind === 'uncaught_exception').map(r => r.message)),
      '弹框那一刻记录已经在盘上').toEqual([['注入：主进程未捕获']]);
    expect(atBox[0]?.log, '弹框那一刻按天日志那一行已经在盘上').toMatch(/\[main\] 未捕获异常：Error: 注入：主进程未捕获/);
  });

  it('未处理拒绝：只记一条 main / unhandled_rejection，不弹框', () => {
    const boxes = h.errorBoxes.length;
    quietly(() => h.crashListeners.rejection[0]?.(new Error('注入：主进程未处理拒绝'), Promise.resolve()));
    expect(crashes().filter(r => r.process === 'main' && r.kind === 'unhandled_rejection').map(r => r.message))
      .toEqual(['注入：主进程未处理拒绝']);
    expect(h.errorBoxes).toHaveLength(boxes);
  });
});

describe('① 按天日志', () => {
  it('启动时删掉超过 7 天的：import 前预置的 8 天前那份没了，昨天那份原样还在', () => {
    expect([seeded.stale, seeded.recent], 'beforeImport 没跑：没有预置旧日志').toEqual([
      expect.stringMatching(/^minisd-\d{4}-\d{2}-\d{2}\.log$/), expect.stringMatching(/^minisd-\d{4}-\d{2}-\d{2}\.log$/),
    ]);
    expect(existsSync(join(logDir, seeded.stale)), `${seeded.stale} 应在启动时删掉`).toBe(false);
    expect(readFileSync(join(logDir, seeded.recent), 'utf8'), '7 天内的不能删、也不能动').toBe(RECENT_TEXT);
  });

  it('fork 与握手端口两行生命周期；握手行带的 token 不落盘', () => {
    const text = dailyLog();
    expect(text).toMatch(/\[main\] 启动引擎进程/);
    expect(text).toMatch(/\[main\] 引擎握手完成，端口 45678/);
    expect(text).not.toContain('wiring-test-token');
  });

  it('stdout 的非握手行进日志；再来一条握手样子的行也不落 token', () => {
    quietly(() => h.child.stdout[0]?.(Buffer.from('普通的一行\n' + JSON.stringify({ minisdPort: 1, authToken: 'second-token' }) + '\n')));
    const text = dailyLog();
    expect(text).toMatch(/\[minisd:out\] 普通的一行/);
    expect(text).not.toContain('second-token');
  });

  it('stderr 按行切：一块里的多行各成一行，分块到达的半行与半个汉字拼回整行', () => {
    const half = Buffer.from('半个汉字也拼得回来\n');
    quietly(() => {
      const feed = h.child.stderr[0];
      feed?.(Buffer.from('第一行\n第二'));
      feed?.(Buffer.from('行\n'));
      feed?.(half.subarray(0, 4));
      feed?.(half.subarray(4));
      feed?.(Buffer.from('没换行的尾巴'));
    });
    const text = dailyLog();
    expect(text).toMatch(/\[minisd:err\] 第一行\n/);
    expect(text).toMatch(/\[minisd:err\] 第二行\n/);
    expect(text).toMatch(/\[minisd:err\] 半个汉字也拼得回来\n/);
    expect(text).not.toContain('�');
    expect(text, '没换行的半行先留着').not.toContain('没换行的尾巴');
  });
});

describe('① 优雅退出不是崩溃（放在最后：之后引擎就算退出了）', () => {
  it('before-quit → 发 shutdown，日志记「请求引擎关停」→ 以 0 退出：不记 minisd_exit；日志记退出码，留着的半行也写进去', async () => {
    const beforeQuit = h.appOn.get('before-quit')?.[0];
    expect(beforeQuit, '主进程没挂 before-quit').toBeTypeOf('function');
    let prevented = false;
    quietly(() => beforeQuit?.({ preventDefault: () => { prevented = true; } }));
    expect(prevented, '第一次 before-quit 要挡住，等引擎停完').toBe(true);
    expect(h.child.posted).toEqual([{ type: 'shutdown' }]);
    expect(dailyLog()).toMatch(/\[main\] 请求引擎关停/);

    quietly(() => h.child.exit[0]?.(0));
    await new Promise(r => setTimeout(r, 20));
    expect(crashes().filter(r => r.kind === 'minisd_exit'), '退出流程里的退出不是崩溃').toEqual([]);
    const text = dailyLog();
    expect(text).toMatch(/\[main\] 引擎进程退出 code=0/);
    expect(text).toMatch(/\[minisd:err\] 没换行的尾巴\n/);
  });
});

describe('② 源码守卫', () => {
  const read = (rel: string): string => stripComments(readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n'));
  const main = read('src/main/index.ts');
  const minisd = read('src/minisd/index.ts');
  /** 挂监听的各种写法（与 tests/main-shutdown-wiring.test.ts 同一个认法），事件名是两个崩溃事件之一 */
  const CRASH_HOOK = /\.(?:on|once|addListener|prependListener|prependOnceListener)\s*(?:\?\.)?\s*\(\s*['"`](?:uncaughtException|unhandledRejection)['"`]/;

  /** 从 anchor 之后的第一个 { 起按括号配对取块体 */
  function blockAfter(src: string, anchor: RegExp): string {
    const m = anchor.exec(src);
    if (!m) return '';
    const open = src.indexOf('{', m.index + m[0].length - 1);
    let depth = 1; let i = open + 1;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    return src.slice(open + 1, i - 1);
  }

  it('主进程不自己挂崩溃监听：只在 whenReady 里调 installMainCrashHandlers(，在早退之后、权限处理器 / 更新检查 / fork 之前', () => {
    expect(main).not.toMatch(CRASH_HOOK);
    expect(main.match(/\binstallMainCrashHandlers\(/g) ?? [], '只调一次').toHaveLength(1);
    const ready = blockAfter(main, /app\.whenReady\(\)\.then\(async \(\) => \{/);
    const iInstall = ready.search(/\binstallMainCrashHandlers\(/);
    expect(iInstall, 'whenReady 回调里调它（模块顶层会装进 import 主进程的单测 worker）').toBeGreaterThan(ready.indexOf('if (!gotSingleInstanceLock) return;'));
    for (const later of [/setPermissionRequestHandler\(/, /\bsetupUpdater\(\)/, /\bstartMinisdProcess\(\)/]) {
      expect(ready.search(later), later.source).toBeGreaterThan(iInstall);
    }
  });

  it('minisd 不自己挂崩溃监听：standalone 分支第一句是 installMinisdCrashHandlers(logRootFromEnv(process.env));，全文件只此一处', () => {
    expect(minisd).not.toMatch(CRASH_HOOK);
    expect(minisd.match(/\binstallMinisdCrashHandlers\(/g) ?? []).toHaveLength(1);
    const standalone = blockAfter(minisd, /if \(process\.env\.DESKMINIS_STANDALONE === '1'\) \{/);
    expect(standalone).toMatch(/^\s*installMinisdCrashHandlers\(\s*logRootFromEnv\(\s*process\.env\s*\)\s*\);/);
  });

  it('exit 监听按「握手了没有」「请求过关停没有」「主进程在不在退出」判崩溃（传的是哪个值也钉住），判出来的才 recordCrash(', () => {
    const start = blockAfter(main, /function startMinisdProcess\(\): Promise<number> \{/);
    const listener = blockAfter(start, /minisd\.on\(\s*'exit'\s*,\s*\(?\s*code\s*\)?\s*=>\s*\{/);
    const call = blockAfter(listener, /\bminisdExitCrash\(\s*(?=\{)/);
    // 传进去的值一起钉，每个属性的值到逗号为止（审查实测：只认 quitting 这个词时，换成 quitting: false 照样绿）。
    // stopRequested 只有这里钉得住：现有代码里请求关停的两条路（before-quit、重启并安装）都先把 quitting 置真，
    // 把它换成 false 行为上看不出区别，行为测试杀不死这个变异。留着它是设计稿 §3 第 11 条定的判法：
    // 停止器请求过关停之后的退出就不是崩溃，不指望每条停止的路都记得先置 quitting。
    expect(call).toMatch(/(?:^|,)\s*handshaken:\s*minisdPort !== 0\s*(?:,|$)/);
    expect(call).toMatch(/(?:^|,)\s*stopRequested:\s*exitWatch\.stopRequested\s*(?:,|$)/);
    expect(call, 'quitting 只认简写或 quitting: quitting').toMatch(/(?:^|,)\s*quitting(?:\s*:\s*quitting)?\s*(?:,|$)/);
    expect(listener).toMatch(/\brecordCrash\(/);
  });
});
