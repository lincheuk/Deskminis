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
 *  ⑥⑦ 写日志的原文（W3-updb、W3-updd）：带错误码、截掉整段 feed XML 与 HttpError 附带的响应头（GitHub 匿名访问也回会话 cookie）。
 *  行为（处理器真的弹这个框、挂在主窗口上、点了才装）在 tests/update-handoff-wiring.test.ts。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { createHttpError } from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider';
import { downloadedDialog, manualCheckDialog, MANUAL_CHECK_SETTLE_MS, updateErrorForLog, updaterLogText } from '../src/main/update-status';
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

  it('说清点「重启并安装」会关闭 DeskMinis、打开安装程序：保持默认选项，最后一页点完成就打开新版', () => {
    const d = dlg();
    expect(d.detail).toContain('「重启并安装」');
    expect(d.detail).toContain('关闭 DeskMinis');
    expect(d.detail).toContain('安装程序');
    expect(d.detail).toContain('默认选项');
    // 「完成」不加引号（W3-updb）：安装程序的语言跟随 Windows 显示语言，英文系统上那个按钮是 Finish
    expect(d.detail).toContain('点完成');
  });

  it('说清关掉不会自动安装，以及之后从哪里再装（联网时从托盘「检查更新…」）', () => {
    const d = dlg();
    expect(d.detail).toContain('不会自动安装');
    expect(d.detail).toContain('「检查更新…」');
    // 再查要先从发布页拉到版本信息，才会去核对已下载的安装包：离线时装不了（W3-updb）
    expect(d.detail).toContain('联网时');
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
    expect(downloaded).toContain('联网时');
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

// ── W3-updb（设计稿 §4.1）：checkUpdates 接住自动下载的 downloadPromise。行为在 tests/update-recheck-wiring.test.ts ──
describe('④ MANUAL_CHECK_SETTLE_MS · 手动检查等下载落定的上限', () => {
  it('在 1–2 秒之间：缓存核对（同一进程里几毫秒，跨启动要重算 sha512）等得到，真在下载的又不把回执拖太久', () => {
    expect(MANUAL_CHECK_SETTLE_MS).toBeGreaterThanOrEqual(1_000);
    expect(MANUAL_CHECK_SETTLE_MS).toBeLessThanOrEqual(2_000);
  });
});

describe('⑤ 主进程 · checkUpdates 不论自动还是手动都接住 downloadPromise', () => {
  const main = stripComments(read('src/main/index.ts'));
  const at = main.search(/async function checkUpdates\(/);
  /** 函数体：签名之后第一个「{ 换行」起按花括号配平（返回类型里没有花括号，但照 auto-update.test.ts 的认法写，稳一点） */
  const body = ((): string => {
    if (at < 0) return '';
    const open = at + main.slice(at).search(/\{[ \t]*\n/);
    let depth = 0;
    for (let i = open; i < main.length; i++) {
      if (main[i] === '{') depth++;
      else if (main[i] === '}' && --depth === 0) return main.slice(open, i + 1);
    }
    return '';
  })();

  it('checkForUpdates() 的结果上挂处理：downloadPromise?.then(成功, 失败)，排在「只有手动才等」那一句之前、不在它里面', () => {
    expect(body, '找不到 async function checkUpdates(').not.toBe('');
    const iAttach = body.search(/\.downloadPromise\?\.then\(/);
    const iManual = body.search(/if \(manual && /);
    expect(iAttach, '没有给 downloadPromise 挂处理').toBeGreaterThan(-1);
    expect(iManual, '手动检查要等它落定（if (manual && …)）').toBeGreaterThan(iAttach);
    // 挂处理的那一句自己不在任何 if 里：它所在的行以 const 起头
    const line = body.slice(body.lastIndexOf('\n', iAttach) + 1, body.indexOf('\n', iAttach));
    expect(line).toMatch(/^\s*const \w+ = /);
  });
});

describe('⑥ updateErrorForLog · 写进 stderr 与按天日志的出错原文', () => {
  it('Error：原样用 stack（含首行消息与调用栈）', () => {
    const e = new Error('net::ERR_CONNECTION_RESET');
    e.stack = 'Error: net::ERR_CONNECTION_RESET\n    at emit (node:events:519:28)';
    expect(updateErrorForLog(e)).toBe(e.stack);
  });

  it('带错误码的接在后面（describeUpdateError 按 code 分类，而 code 不在 stack 里）；stack 里已经有了就不重复', () => {
    const e = Object.assign(new Error('Cannot find channel "latest.yml" update info'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    e.stack = 'Error: Cannot find channel "latest.yml" update info\n    at x (y.js:1:1)';
    expect(updateErrorForLog(e)).toBe(`${e.stack}\n错误码：ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`);
    const f = Object.assign(new Error('x'), { code: 'ERR_UPDATER_X' });
    f.stack = 'Error: ERR_UPDATER_X 已写在消息里\n    at x (y.js:1:1)';
    expect(updateErrorForLog(f)).toBe(f.stack);
  });

  it('INVALID_RELEASE_FEED 拼在后面的整段 releases.atom 截掉，留一句说明', () => {
    const e = Object.assign(new Error('x'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' });
    e.stack = 'Error: Cannot parse releases feed: Error: boom,\nXML:\n<?xml version="1.0"?>\n<feed>\n' + '<entry/>\n'.repeat(300) + '</feed>';
    const out = updateErrorForLog(e);
    expect(out).toContain('Cannot parse releases feed: Error: boom,');
    expect(out).not.toContain('<entry/>');
    expect(out).toContain('releases.atom');
    expect(out).toContain('错误码：ERR_UPDATER_INVALID_RELEASE_FEED');
    expect(out.split('\n').length).toBeLessThan(10);
  });

  it('不是 Error 的：字符串原样；转不成文字的怪对象不抛', () => {
    expect(updateErrorForLog('ERR_X: 出错了')).toBe('ERR_X: 出错了');
    expect(() => updateErrorForLog(Object.create(null))).not.toThrow();
    expect(updateErrorForLog(Object.create(null))).toContain('转不成文字');
    expect(updateErrorForLog(undefined)).toBe('undefined');
  });
});

/** GitHub 回的响应头：匿名访问也带会话 cookie（Windows 真机验证时日志里见到的就是这几条，值是编的）。 */
const GH_HEADERS = {
  server: 'github.com',
  'content-type': 'text/html; charset=utf-8',
  'set-cookie': [
    '_gh_sess=SESSIONVALUE; path=/; secure; HttpOnly; SameSite=Lax',
    '_octo=GH1.1.123.456; Path=/; Domain=github.com; Secure; SameSite=Lax',
    'logged_in=no; Path=/; Domain=github.com; HttpOnly; Secure; SameSite=Lax',
  ],
  'x-github-request-id': 'ABCD:1234:5678',
};
/** 响应头里的东西一样都不能出现在日志原文里 */
const HEADER_TEXT = /set-cookie|_gh_sess|SESSIONVALUE|_octo|logged_in|x-github-request-id|"server"|content-type/;
const RELEASES = '/lincheuk/deskminis-releases/releases';
/** 同 builder-util-runtime 的 HttpExecutor.handleResponse：createHttpError，描述里带请求地址，随后是 Headers 的 JSON */
function httpFail(status: number, statusMessage: string, path: string, headers: object = GH_HEADERS): Error {
  return createHttpError({ statusCode: status, statusMessage, headers } as unknown as IncomingMessage, `method: GET url: https://github.com${path}`);
}
const FEED = '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">'
  + `<entry><id>tag:github.com,2008:Repository/1/v0.3.1</id><updated>2026-09-20T00:00:00Z</updated>`
  + `<link rel="alternate" type="text/html" href="https://github.com${RELEASES}/tag/v0.3.1"/><title>v0.3.1</title></entry></feed>`;
/** 用真 GitHubProvider 走一遍检查（HTTP 执行器换成按路径应答的桩，同 tests/update-error-text.test.ts）：
 *  第二跳、第三跳的失败被它包几层、拼上什么，由它自己决定，测试不替它拼。 */
async function providerError(replies: Record<string, string | Error>): Promise<unknown> {
  const executor = {
    request: async (o: { path?: string }): Promise<string | null> => {
      const r = replies[String(o.path)];
      if (r === undefined) throw new Error(`桩没配这一跳：${o.path}`);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const updater = { allowPrerelease: false, channel: null, fullChangelog: false, currentVersion: null } as unknown as AppUpdater;
  const provider = new GitHubProvider({ provider: 'github', owner: 'lincheuk', repo: 'deskminis-releases' }, updater,
    { isUseMultipleRangeRequest: false, platform: 'win32', executor } as unknown as ConstructorParameters<typeof GitHubProvider>[2]);
  try { await provider.getLatestVersion(); } catch (e) { return e; }
  throw new Error('期望检查失败，实际成功了');
}

describe('⑦ 写日志的原文不带 HttpError 附带的响应头（W3-updd）', () => {
  it('直接到达的 HttpError（第一跳 releases.atom 被限流）：Headers 整段换成一句说明；状态行、请求地址、堆栈、错误码照留', () => {
    const out = updateErrorForLog(httpFail(429, 'Too Many Requests', `${RELEASES}.atom`));
    expect(out).not.toMatch(HEADER_TEXT);
    expect(out).toContain('HttpError: 429 Too Many Requests');
    expect(out).toContain(`url: https://github.com${RELEASES}.atom`);
    expect(out).toContain('Headers: （响应头略）');
    expect(out).toMatch(/\n {4}at createHttpError /);
    expect(out).toContain('错误码：HTTP_ERROR_429');
  });

  it('第二跳 /releases/latest 404：LATEST_VERSION_NOT_FOUND 裹着 HttpError，外面再包 INVALID_RELEASE_FEED 拼整段 feed——响应头与 XML 都截', async () => {
    const e = await providerError({ [`${RELEASES}.atom`]: FEED, [`${RELEASES}/latest`]: httpFail(404, 'Not Found', `${RELEASES}/latest`) });
    expect((e as { code?: string }).code).toBe('ERR_UPDATER_INVALID_RELEASE_FEED');
    const out = updateErrorForLog(e);
    expect(out).not.toMatch(HEADER_TEXT);
    expect(out).not.toContain('<entry>');
    expect(out).toContain('Unable to find latest version on GitHub');
    expect(out).toContain('HttpError: 404 Not Found');
    expect(out).toContain(`url: https://github.com${RELEASES}/latest`);
    expect(out).toContain('Headers: （响应头略）');
    expect(out).toContain('releases.atom，略');
    expect(out).toContain('错误码：ERR_UPDATER_INVALID_RELEASE_FEED');
  });

  it('第三跳 latest.yml 404（Release 里漏传）：CHANNEL_FILE_NOT_FOUND 拼着 HttpError 的 stack——响应头截，找不到的文件与地址照留', async () => {
    const e = await providerError({
      [`${RELEASES}.atom`]: FEED,
      [`${RELEASES}/latest`]: JSON.stringify({ tag_name: 'v0.3.1' }),
      [`${RELEASES}/download/v0.3.1/latest.yml`]: httpFail(404, 'Not Found', `${RELEASES}/download/v0.3.1/latest.yml`),
    });
    expect((e as { code?: string }).code).toBe('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
    const out = updateErrorForLog(e);
    expect(out).not.toMatch(HEADER_TEXT);
    expect(out).toContain('Cannot find latest.yml in the latest release artifacts');
    expect(out).toContain('Headers: （响应头略）');
    expect(out).toMatch(/\n {4}at /);
  });

  it('空的响应头 {} 原样留着，也不把它后面的堆栈连同下一段响应头一起吞掉；一段原文里有几段响应头就截几段', () => {
    const inner = httpFail(404, 'Not Found', `${RELEASES}/latest`);
    const innermost = httpFail(403, 'Forbidden', `${RELEASES}.atom`);
    const text = `HttpError: 500 Internal Server Error\nHeaders: {}\n    at a (a.js:1:1)\n    at b (b.js:2:2)\ncaused by: ${inner.stack}\ncaused by: ${innermost.stack}`;
    const out = updateErrorForLog(text);
    expect(out).toContain('Headers: {}\n    at a (a.js:1:1)\n    at b (b.js:2:2)\ncaused by: HttpError: 404 Not Found');
    expect(out).not.toMatch(HEADER_TEXT);
    expect(out.match(/Headers: （响应头略）\n {4}at createHttpError /g)).toHaveLength(2);
    expect(out).toContain('caused by: HttpError: 403 Forbidden');
  });

  it('updaterLogText：electron-updater 经 logger 交来的整段堆栈（它在 error 事件上自己挂的监听会把 e.stack 再交一遍）同样截响应头与 feed XML', async () => {
    const e = await providerError({ [`${RELEASES}.atom`]: FEED, [`${RELEASES}/latest`]: httpFail(403, 'Forbidden', `${RELEASES}/latest`) });
    // AppUpdater 构造时挂的监听：this._logger.error(`Error: ${error.stack || error.message}`)
    const out = updaterLogText(`Error: ${(e as Error).stack}`);
    expect(out).not.toMatch(HEADER_TEXT);
    expect(out).not.toContain('<entry>');
    expect(out).toContain('HttpError: 403 Forbidden');
    expect(out).toContain('Headers: （响应头略）');
    expect(out).toContain('releases.atom，略');
    // 其余记录原样；转不成文字的不抛回 electron-updater
    expect(updaterLogText('Install: isSilent: false, isForceRunAfter: true')).toBe('Install: isSilent: false, isForceRunAfter: true');
    expect(() => updaterLogText(Object.create(null))).not.toThrow();
    expect(updaterLogText(Object.create(null))).toContain('转不成文字');
  });
});
