/** W3-upd（设计稿 §4.1；DSH 桌面端对照报告 §1 U2、U3）：更新过程写进按天日志，下载完成框如实、点了才装。
 *
 *  为什么要日志：更新失败的原文以前只写 stderr，打包后的 GUI 里没人看得到（daily-log.ts 开头写的就是这个理由），
 *  界面上只有截断过的一句中文。0.3.0 → 0.3.1 的第一次自动更新由 0.3.0 装机的代码执行，
 *  那次出了问题能不能查到原因，全看 0.3.0 里有没有把过程留下来。每行带 [update]，与 [main]、[minisd:err] 并列好找。
 *
 *  用 tests/main-window-guard-harness.ts 的 electron 桩把 src/main/index.ts 真跑一遍（whenReady 在 worker 里真跑，
 *  数据根是 mkdtemp 临时目录，日志落 <数据根>/logs）。electron-updater 桩记下主进程挂上来的处理器，这里逐个触发：
 *  - update-available、update-not-available：各记一行（发现新版、交给后台下载，下载过的只核对；已是最新、发布页上的最新版本号）；
 *  - error：原文逐行写进日志、每行都带 [update]（堆栈的后几行不带前缀就混进别的行里认不出来），照旧也写 stderr；
 *  - update-downloaded：记一行；以主窗口为父弹 downloadedDialog(版本)，选「稍后再说」什么也不装；
 *  - 点「重启并安装」：先记一行，再请引擎关停，引擎退出之后才 quitAndInstall（顺序本身由 main-shutdown-wiring 的源码守卫钉着，
 *    这里钉「真的等到引擎退出」与日志的先后）。
 *  纯函数的文案在 tests/update-handoff.test.ts。 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootMain, h } from './main-window-guard-harness';
import { downloadedDialog } from '../src/main/update-status';

vi.mock('electron', async () => (await import('./main-window-guard-harness')).fakeElectron());
vi.mock('electron-updater', async () => (await import('./main-window-guard-harness')).fakeElectronUpdater());

let restore = (): void => {};
let logDir = '';
// 全量并发时起主进程可能慢，钩子时限放宽到 30s
beforeAll(async () => {
  restore = await bootMain({ rendererUrl: undefined });
  logDir = join(process.env.DESKMINIS_DATA_DIR ?? '', 'logs');
}, 30_000);
afterAll(() => { restore(); });

/** 这次启动写的按天日志全文（跨午夜也不漏） */
const dailyLog = (): string => {
  try {
    return readdirSync(logDir).filter(f => /^minisd-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
      .map(f => readFileSync(join(logDir, f), 'utf8')).join('');
  } catch { return ''; }
};
/** 调 fn 期间日志新增的行（主进程把东西转发到自己的 stderr：测试里闭嘴，写了什么记在 stderr 里交回） */
function during(fn: () => void): { lines: string[]; stderr: string } {
  const before = dailyLog().length;
  let stderr = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr += String(chunk); return true; });
  try { fn(); } finally { spy.mockRestore(); }
  return { lines: dailyLog().slice(before).split('\n').filter(l => l !== ''), stderr };
}
/** 主进程挂在 autoUpdater 上的处理器：每个事件恰好一个 */
function updater(event: string): (...args: unknown[]) => void {
  const fns = h.updaterOn.get(event);
  expect(fns?.length, `主进程没有（或不止一次）挂 autoUpdater.on('${event}')`).toBe(1);
  return fns![0] as (...args: unknown[]) => void;
}
/** 日志行：带时区的 ISO 时间、一个空格、[update]、一个空格，然后是正文 */
const UPDATE_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[update\] /;

describe('更新过程写进按天日志', () => {
  it('update-available：记一行「发现新版本 0.3.1」，说明接着后台下载（已经下载过的只核对一遍）', () => {
    const { lines } = during(() => updater('update-available')({ version: '0.3.1' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(UPDATE_LINE);
    expect(lines[0]).toContain('发现新版本 0.3.1');
    expect(lines[0]).toContain('下载');
  });

  it('update-not-available：记一行「已是最新」，带发布页上的最新版本号（排查「怎么一直没更新」时看得出它查过、查到了什么）', () => {
    const { lines } = during(() => updater('update-not-available')({ version: '0.3.0' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(UPDATE_LINE);
    expect(lines[0]).toContain('已是最新');
    expect(lines[0]).toContain('0.3.0');
    // 当前版本也在（桩的 app.getVersion() 是 0.0.0-test）：两个都在，才看得出是「已是最新」还是「这一版还没轮到本机」
    expect(lines[0]).toContain('当前 0.0.0-test');
  });

  it('error：原文逐行写进日志、每行都带 [update]，空行不写；错误码接在后面；照旧也写 stderr', () => {
    const e = Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: 'ERR_NET_TEST' });
    // 中间夹一个空行（HttpError 的消息里就有）：不能写出一行光秃秃的「[update]」
    e.stack = 'Error: net::ERR_CONNECTION_RESET\n\n    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:1)\n    at emit (node:events:519:28)';
    const { lines, stderr } = during(() => updater('error')(e));
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(l).toMatch(UPDATE_LINE);
    for (const l of lines) expect(l.replace(UPDATE_LINE, '').trim(), l).not.toBe('');
    expect(lines[0]).toContain('net::ERR_CONNECTION_RESET');
    expect(lines[2]).toContain('at emit (node:events:519:28)');
    expect(lines[3]).toContain('错误码：ERR_NET_TEST');
    expect(stderr).toContain('[update] Error: net::ERR_CONNECTION_RESET');
  });

  it('error 的实参不是 Error 也照样整句写进去（防御：不假定 electron-updater 永远交 Error）', () => {
    const { lines } = during(() => updater('error')('ERR_UPDATER_INVALID_UPDATE_INFO: 版本信息缺字段'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(UPDATE_LINE);
    expect(lines[0]).toContain('ERR_UPDATER_INVALID_UPDATE_INFO: 版本信息缺字段');
  });
});

describe('electron-updater 自己的记录（W3-updb）', () => {
  it('主进程把 autoUpdater.logger 接到按天日志：info / warn / error 三级都写，每行带 [update] 与来源', () => {
    const logger = h.autoUpdater?.logger as { info(m: unknown): void; warn(m: unknown): void; error(m: unknown): void } | undefined;
    expect(logger, '主进程没有设 autoUpdater.logger（它缺省写 console，打包后没人看得见）').toBeDefined();
    const { lines } = during(() => {
      logger!.info('Install: isSilent: false, isForceRunAfter: true');
      logger!.warn('disableWebInstaller is set to false');
      logger!.error('Cannot download differentially, fallback to full download: Error: x\n    at y (z.js:1:1)');
    });
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(l).toMatch(UPDATE_LINE);
    expect(lines[0]).toContain('electron-updater: Install: isSilent: false, isForceRunAfter: true');
    expect(lines[1]).toContain('electron-updater 警告：disableWebInstaller is set to false');
    expect(lines[2]).toContain('electron-updater 报错：Cannot download differentially');
    expect(lines[3]).toContain('at y (z.js:1:1)');
  });
});

describe('下载完成：弹框如实，点了「重启并安装」才装', () => {
  it('没有窗口可挂（极端情形）：照样记「已下载完成」，不弹框', () => {
    h.listWindows = false;
    const boxes = h.messageBoxes.length;
    const { lines } = during(() => updater('update-downloaded')({ version: '0.3.1' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('0.3.1 已下载完成');
    expect(h.messageBoxes.length).toBe(boxes);
  });

  it('update-downloaded：记一行；以主窗口为父弹 downloadedDialog(版本)；选「稍后再说」什么也不装', async () => {
    h.listWindows = true;
    h.messageBoxResponse = 0;
    const boxes = h.messageBoxes.length;
    const { lines } = during(() => updater('update-downloaded')({ version: '0.3.1' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(UPDATE_LINE);
    expect(lines[0]).toContain('0.3.1 已下载完成');
    expect(h.windows.length, '主进程没有建主窗口').toBeGreaterThan(0);
    expect(h.messageBoxes.slice(boxes)).toEqual([[h.windows[0], downloadedDialog('0.3.1')]]);
    // 对话框的 .then 在微任务里跑：让它跑完，再看有没有装、有没有请引擎关停，日志里也不能记成「点了重启并安装」
    const before = dailyLog().length;
    await new Promise(r => setTimeout(r, 20));
    expect(h.quitAndInstalls).toBe(0);
    expect(h.child.posted).toEqual([]);
    expect(dailyLog().slice(before)).not.toContain('「重启并安装」');
  });

  it('点「重启并安装」：先记日志，再请引擎关停；引擎退出之前不装，退出之后才 quitAndInstall', async () => {
    h.listWindows = true;
    h.messageBoxResponse = 1;
    const before = dailyLog().length;
    during(() => updater('update-downloaded')({ version: '0.3.1' }));
    await vi.waitFor(() => { expect(h.child.posted).toEqual([{ type: 'shutdown' }]); });
    const log = dailyLog().slice(before);
    const iClick = log.search(/ \[update\] [^\n]*「重启并安装」/);
    const iStop = log.indexOf('[main] 请求引擎关停');
    expect(iClick, '日志里没有「用户点了重启并安装」那一行').toBeGreaterThan(-1);
    expect(iStop, '日志里没有「请求引擎关停」').toBeGreaterThan(iClick);
    // 引擎还没退：不能装（装的时候引擎还开着库、挂着 MCP 子进程）
    await new Promise(r => setTimeout(r, 50));
    expect(h.quitAndInstalls).toBe(0);
    during(() => h.child.exit[0]?.(0));
    await vi.waitFor(() => { expect(h.quitAndInstalls).toBe(1); });
  });
});
