/** W3-upd（设计稿 §4.1；DSH 桌面端对照报告 §1 U1、U3）：更新交接的说法如实。
 *
 *  主进程设了 autoInstallOnAppQuit = false（下载完只提示，退出时不自动装），所以只有点「重启并安装」才会装：
 *  普通退出、重启都不会装，下次启动时（开着自动检查）也只是再问一次。以前有三处说法与此不符——
 *  下载完成框「现在重启即可用上新版本……下次启动时再装」、关于页「新版已下载，重启后生效」、托盘回执「重启应用后生效。」。
 *  「重启并安装」调的是不带参数的 quitAndInstall()：electron-updater 6.8.9 不传 /S，NSIS 走完整的安装向导
 *  （安装选项页不会因为是更新就跳过，完成页要用户点「完成」才启动新版；据模板读码，未上真机）。
 *  所以对话框要说清会打开安装程序、怎么点。行为一概不变，只改说法。
 *
 *  ① 纯函数：下载完成框的选项（downloadedDialog）与托盘回执的 downloaded 一格（manualCheckDialog）；
 *  ② 关于页 STATUS_TEXT 的 downloaded（按 SFC 解析器切出脚本段、剥掉注释再认）；
 *  ③ 源码守卫：update-downloaded 处理器把 downloadedDialog 交给 showMessageBox，主进程里不再内联说明文字。
 *  行为（处理器真的弹这个框、挂在主窗口上、点了才装）在 tests/update-handoff-wiring.test.ts。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadedDialog, manualCheckDialog } from '../src/main/update-status';
import { sfcBlocks } from './sfc-blocks';
import { stripComments } from './strip-comments';

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
/** 以前那几句不实的说法：重启就生效、下次启动自己装 */
const FALSE_PROMISE = /重启即可|重启后生效|重启应用后生效|下次启动时再装/;

describe('① downloadedDialog · 下载完成的对话框', () => {
  /** 在每一例里现调：模块加载时就调的话，函数一缺整份文件在收集阶段就挂了，后面各例各自红在哪里看不出来 */
  const dlg = (): ReturnType<typeof downloadedDialog> => downloadedDialog('0.3.1');

  it('主句带版本号', () => {
    expect(dlg().message).toContain('0.3.1');
  });

  it('说清点「重启并安装」会关闭 DeskMinis、打开安装程序：保持默认选项，最后一页点「完成」就打开新版', () => {
    const d = dlg();
    expect(d.detail).toContain('「重启并安装」');
    expect(d.detail).toContain('关闭 DeskMinis');
    expect(d.detail).toContain('安装程序');
    expect(d.detail).toContain('默认选项');
    expect(d.detail).toContain('「完成」');
  });

  it('说清关掉不会自动安装，以及之后从哪里再装（托盘「检查更新…」）', () => {
    const d = dlg();
    expect(d.detail).toContain('不会自动安装');
    expect(d.detail).toContain('「检查更新…」');
  });

  it('不再许诺「重启即可」「下次启动时再装」「重启后生效」', () => {
    const d = dlg();
    expect(`${d.title ?? ''}\n${d.message}\n${d.detail ?? ''}`).not.toMatch(FALSE_PROMISE);
  });

  it('按钮与焦点不变：稍后再说 / 重启并安装，默认焦点与取消都落在「稍后再说」（不在打断性的选项上）', () => {
    const d = dlg();
    expect(d.buttons).toEqual(['稍后再说', '重启并安装']);
    expect(d.defaultId).toBe(0);
    expect(d.cancelId).toBe(0);
    expect(d.type).toBe('info');
  });

  it('没有版本号时主句不留空洞，也不漏 undefined', () => {
    const e = downloadedDialog(undefined);
    expect(e.message).not.toMatch(/undefined|\s{2}|\s$/);
    expect(e.message).toContain('已下载完成');
  });
});

describe('① manualCheckDialog · 托盘回执的 downloaded 一格', () => {
  it('不说「重启应用后生效」；说清要在安装提示里点「重启并安装」、关掉不会自动安装、怎么让提示再弹出来', () => {
    const d = manualCheckDialog({ status: 'downloaded', version: '0.3.1' }, '0.3.0');
    expect(d.message).toContain('0.3.1');
    expect(`${d.message}\n${d.detail ?? ''}`).not.toMatch(FALSE_PROMISE);
    expect(d.detail).toContain('「重启并安装」');
    expect(d.detail).toContain('不会自动安装');
    expect(d.detail).toContain('「检查更新…」');
  });
});

describe('② 关于页 · downloaded 状态的文案', () => {
  const { script } = sfcBlocks(read('src/renderer/src/ui/settings/SecAbout.vue'), 'SecAbout.vue');
  const table = /const STATUS_TEXT\b[^=]*=\s*\{([\s\S]*?)\n\};/.exec(script)?.[1] ?? '';
  const downloaded = /^\s*downloaded:\s*'([^'\n]*)'/m.exec(table)?.[1];

  it('STATUS_TEXT 里有 downloaded 一格', () => {
    expect(table, '找不到 const STATUS_TEXT = { … }').not.toBe('');
    expect(downloaded, 'STATUS_TEXT 里没有 downloaded').toBeTypeOf('string');
  });

  it('不说「重启后生效」；说清还没安装，指向旁边的「现在检查」（再查一次会重新弹出安装提示）', () => {
    expect(downloaded).not.toMatch(FALSE_PROMISE);
    expect(downloaded).toContain('还没安装');
    expect(downloaded).toContain('「现在检查」');
  });
});

describe('③ 主进程 · update-downloaded 处理器用 downloadedDialog', () => {
  const main = stripComments(read('src/main/index.ts'));
  const at = main.search(/autoUpdater\.on\(\s*'update-downloaded'/);
  /** 处理器所在的那段：从 on('update-downloaded' 起，到下一个 autoUpdater.on( 为止 */
  const block = at < 0 ? '' : main.slice(at, at + 1 + main.slice(at + 1).search(/autoUpdater\.on\(/));

  it('dialog.showMessageBox(w, downloadedDialog(i?.version))：选项出自纯函数，挂在主窗口上', () => {
    expect(block, "找不到 autoUpdater.on('update-downloaded'").not.toBe('');
    expect(block).toMatch(/dialog\.showMessageBox\(\s*w\s*,\s*downloadedDialog\(\s*i\?\.version\s*\)\s*\)/);
  });

  it('处理器里不再内联说明文字（detail:）；主进程全文不再有「下次启动时再装」', () => {
    expect(block).not.toMatch(/\bdetail\s*:/);
    expect(main).not.toMatch(FALSE_PROMISE);
  });
});
