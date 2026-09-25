/**
 * W2b-3 · 重启通道与「重启并安装」兜底（止血设计稿 §3 第 7 条、§2「生命周期」、§4.1 W2b-3 行；
 * 侦察 lifecycle.md「W2b-relaunch」；cross.md S20）。
 *
 * 断线横幅的「重启应用」重启整个应用，不单独重启引擎：渲染端的 rpc 不重连、没有代次（W6），只换引擎的话
 * 界面状态与新引擎对不上。通道是 preload.relaunchApp() ↔ ipcMain.handle('app:relaunch')（ipc-contract 自动核对成对）。
 *
 * 主进程要在 Electron 里才能跑，处理体的接线只能按调用形态认（先剥注释，注释里写着旧调用也喂不饱断言）；
 * 能拆成纯函数的部分（relaunch 参数怎么算）按行为测：
 *  - 处理体第一句校验 sender 是主窗口，不是就抛；已经在退出就什么也不做（再登记一次会在旧进程退出后多起一份）；
 *  - app.relaunch(…) 在 app.quit() 之前；不 app.exit、不 kill、不自己停 minisd——退出走 before-quit 的 quitGate，
 *    它先请 minisd 有序关停（已崩就立即放行），关库放锁都在那条路上；
 *  - 便携版重启到外面那个便携 exe（PORTABLE_EXECUTABLE_FILE），不是它解压到临时目录的副本；
 *  - 「重启并安装」：quitAndInstall() 之后 3 秒还没退就 app.quit()——electron-updater 的 install() 返回 false 时
 *    不调 app.quit，引擎却已经停了，不兜底就留下一个开着窗口、什么也做不了的应用。
 *    兜底与 quitAndInstall 写在同一行、紧随其后：auto-update.test.ts 的负向正则认「quitAndInstall 调用后紧跟换行」，
 *    main-shutdown-wiring.test.ts 认「停 → markStopped → quitAndInstall」的顺序，两条都不动。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const main = stripComments(read('src/main/index.ts'));
const preload = stripComments(read('src/preload/index.ts'));
/** 纯模块按需加载：模块还不存在时只让用到它的例子红，不连累源码守卫一起加载失败。 */
const loadRelaunch = () => import('../src/main/relaunch');

/** 从 anchor 命中处之后的第一个 { 起，按括号配对取出块体（不含外层花括号）；找不到返回 ''。 */
function blockAfter(src: string, anchor: RegExp): string {
  const m = anchor.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return '';
  let depth = 1; let i = open + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(open + 1, i - 1);
}

describe('W2b-3 · preload 暴露 relaunchApp', () => {
  it("relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch')", () => {
    expect(preload).toMatch(/\brelaunchApp: \(\): Promise<void> => ipcRenderer\.invoke\('app:relaunch'\),/);
  });
});

describe("W2b-3 · 主进程 ipcMain.handle('app:relaunch')", () => {
  const head = /ipcMain\.handle\('app:relaunch', \((\w+)\) => \{/;
  const ev = head.exec(main)?.[1] ?? '';
  const body = blockAfter(main, head);

  it('只注册一次', () => {
    expect(main.match(/ipcMain\.handle\(\s*['"`]app:relaunch['"`]/g) ?? []).toHaveLength(1);
    expect(body, "找不到 ipcMain.handle('app:relaunch', (e) => { … })").not.toBe('');
  });

  it('第一句：sender 不是主窗口就抛错（别的 webContents 不该有权让应用重启）', () => {
    expect(body).toMatch(new RegExp(String.raw`^\s*if \(mainWindow === undefined \|\| ${ev}\.sender !== mainWindow\.webContents\) throw new Error\(`));
  });

  it('已经在退出就什么也不做；否则先置 quitting 再 relaunch', () => {
    expect(body).toMatch(/\bif \(quitting\) return;\s*quitting = true;\s*app\.relaunch\(/);
  });

  it('app.relaunch(relaunchOptions(process.env, process.argv)) 在 app.quit() 之前，两者各一次', () => {
    expect(body).toMatch(/app\.relaunch\(relaunchOptions\(process\.env, process\.argv\)\);\s*app\.quit\(\);\s*$/);
    expect(body.match(/app\.relaunch\(/g) ?? []).toHaveLength(1);
    expect(body.match(/app\.quit\(/g) ?? []).toHaveLength(1);
  });

  it('不 app.exit、不 kill、不自己停 minisd、不 markStopped：退出只走 before-quit 的 quitGate（优雅停在那条路上）', () => {
    expect(body).not.toMatch(/app\.exit\(/);
    expect(body).not.toMatch(/\.kill\(/);
    expect(body).not.toMatch(/stopMinisdGracefully\(|markStopped\(/);
  });
});

describe('W2b-3 · relaunch 参数（纯函数，行为）', () => {
  it('便携版：execPath 是外面那个便携 exe（PORTABLE_EXECUTABLE_FILE），命令行参数照旧带上', async () => {
    const { relaunchOptions } = await loadRelaunch();
    const argv = ['C:\\Users\\me\\AppData\\Local\\Temp\\nsx1.tmp\\app\\DeskMinis.exe', '--foo', 'bar'];
    expect(relaunchOptions({ PORTABLE_EXECUTABLE_FILE: 'D:\\Tools\\DeskMinis-0.3.0-win-x64-portable.exe' }, argv))
      .toEqual({ execPath: 'D:\\Tools\\DeskMinis-0.3.0-win-x64-portable.exe', args: ['--foo', 'bar'] });
  });

  it('安装版与开发态（没有 PORTABLE_EXECUTABLE_FILE，或为空）：undefined，沿用 Electron 默认（同一个 exe、同一组参数）', async () => {
    const { relaunchOptions } = await loadRelaunch();
    expect(relaunchOptions({}, ['C:\\Program Files\\DeskMinis\\DeskMinis.exe'])).toBeUndefined();
    expect(relaunchOptions({ PORTABLE_EXECUTABLE_FILE: '' }, ['x'])).toBeUndefined();
    // 只有目录没有文件名：猜不出便携 exe 叫什么，不猜
    expect(relaunchOptions({ PORTABLE_EXECUTABLE_DIR: 'D:\\Tools' }, ['x'])).toBeUndefined();
  });
});

describe('W2b-3 · 「重启并安装」安装没起来时的退出兜底', () => {
  const body = blockAfter(main, /autoUpdater\.on\(\s*'update-downloaded'/);

  it('兜底时限 3 秒', async () => {
    const { INSTALL_QUIT_FALLBACK_MS } = await loadRelaunch();
    expect(INSTALL_QUIT_FALLBACK_MS).toBe(3_000);
  });

  it('quitAndInstall() 之后紧跟 setTimeout(() => app.quit(), INSTALL_QUIT_FALLBACK_MS)，与它同一行', () => {
    expect(body).toMatch(/autoUpdater\.quitAndInstall\(\); setTimeout\(\(\) => app\.quit\(\), INSTALL_QUIT_FALLBACK_MS\);/);
    // 只在点了「重启并安装」的那个分支里：数一遍，全文件就这一处
    expect(main.match(/INSTALL_QUIT_FALLBACK_MS\)/g) ?? []).toHaveLength(1);
  });

  it('兜底走 app.quit() 而不是 app.exit()：markStopped 之后 before-quit 直接放行，窗口与托盘照常收掉', () => {
    expect(body).not.toMatch(/app\.exit\(/);
  });
});
