/**
 * W2b-9 · 更新状态的人话（止血设计稿 §2「自动更新源」与发布工程一条；侦察 release.md「W2b-update」；cross.md S27）。
 *
 * 旧主进程把 electron-updater 的错误原样 String(e.message) 塞进状态：builder-util-runtime 的 HttpError
 * 文本自带「Headers: {json}」，newError 还会把内层 e.stack 拼进去——设置→关于的状态行于是出现
 * 英文堆栈加响应头。这里钉住：每类常见失败给一句中文说明，不漏堆栈、不漏响应头、不换行。
 *
 * 输入从哪来：凡是检查阶段的失败，都驱动已安装的 electron-updater 里**真的** GitHubProvider.getLatestVersion 得到，
 * 只把 HTTP 执行器换成按路径应答的桩。它依次走三跳：releases.atom → /releases/latest → /download/<tag>/latest.yml，
 * 每一跳的失败被包成什么样由它自己决定，测试不替它拼。
 * 为什么不手拼：第一版照着「第二跳的失败会以 LATEST_VERSION_NOT_FOUND 到达」手拼了输入，测试全绿；
 * 可按 6.8.9 的源码，那个错误在 getLatestVersion 里又被外层 catch 包成 INVALID_RELEASE_FEED（消息后面拼着整段 feed XML），
 * 断网、限流、只发了 pre-release 在界面上全成了「版本信息格式不对」（W2b-9 审查）。
 * 不经 provider 的失败（下载后的校验不符、Node 的 errno 网络错）按 builder-util-runtime 抛它们时的写法构造。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { CancellationToken, createHttpError, HttpExecutor, newError } from 'builder-util-runtime';
import { createServer, request as httpRequest, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppUpdater } from 'electron-updater';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider';
import {
  describeUpdateError, isPortableBuild, manualCheckDialog, RELEASES_PAGE_URL,
} from '../src/main/update-status';

const OWNER = 'lincheuk';
const REPO = 'deskminis-releases';
const BASE = `/${OWNER}/${REPO}/releases`;
const TAG = 'v0.3.1';
/** 三跳各自的请求路径（github.com 上的网页端点，不走 API）。 */
const HOP = { atom: `${BASE}.atom`, latest: `${BASE}/latest`, yml: `${BASE}/download/${TAG}/latest.yml` } as const;
type HopName = keyof typeof HOP;

/** 一跳的应答：正文、null（空 body，执行器就这么交出来）、或抛出的错误。 */
type Reply = string | null | Error;
type Site = Partial<Record<HopName, Reply>>;

function entry(tag: string, opts: { link?: boolean; title?: string } = {}): string {
  const link = opts.link === false ? ''
    : `<link rel="alternate" type="text/html" href="https://github.com${BASE}/tag/${tag}"/>`;
  return `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>2026-09-20T00:00:00Z</updated>${link}`
    + `<title>${opts.title ?? tag}</title><content type="html">No content.</content><author><name>${OWNER}</name></author></entry>`;
}
function feed(...entries: string[]): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">'
    + `<id>tag:github.com,2008:https://github.com${BASE}</id><title>Release notes from ${REPO}</title>`
    + `${entries.join('')}</feed>`;
}
const LATEST_YML = `version: 0.3.1
files:
  - url: DeskMinis-0.3.1-Setup.exe
    sha512: c2hhNTEy
    size: 1
path: DeskMinis-0.3.1-Setup.exe
sha512: c2hhNTEy
releaseDate: '2026-09-20T00:00:00.000Z'
`;
/** 三跳都正常时的应答；各例在它上面改一跳。 */
const OK: Required<Site> = { atom: feed(entry(TAG)), latest: JSON.stringify({ tag_name: TAG }), yml: LATEST_YML };

/** 同 builder-util-runtime 的 HttpExecutor.handleResponse：createHttpError，描述里带请求地址，随后是 Headers 的 JSON。 */
function httpFail(status: number, hop: HopName): Error {
  const text: Record<number, string> = {
    401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 410: 'Gone', 429: 'Too Many Requests',
    502: 'Bad Gateway', 503: 'Service Unavailable',
  };
  const res = { statusCode: status, statusMessage: text[status] ?? '', headers: { server: 'github.com', 'x-github-request-id': 'ABCD:1234' } };
  return createHttpError(res as unknown as IncomingMessage, `method: GET url: https://github.com${HOP[hop]}`);
}
/** Electron 的 net 模块报错只有 message（net::ERR_…）。 */
const netFail = (what: string): Error => new Error(`net::${what}`);

/** 用桩执行器驱动真 GitHubProvider 走一遍检查。unrouted 记下桩没配的请求——有它说明路由写错了，结论不可信。 */
async function run(site: Site): Promise<{ ok: boolean; value: unknown; unrouted: string[] }> {
  const unrouted: string[] = [];
  const executor = {
    request: async (o: { path?: string }): Promise<string | null> => {
      const hop = (Object.keys(HOP) as HopName[]).find(k => HOP[k] === o.path);
      const r = hop === undefined ? undefined : site[hop];
      if (r === undefined) { unrouted.push(String(o.path)); throw new Error(`桩没配这一跳：${o.path}`); }
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const updater = { allowPrerelease: false, channel: null, fullChangelog: false, currentVersion: null } as unknown as AppUpdater;
  const provider = new GitHubProvider({ provider: 'github', owner: OWNER, repo: REPO }, updater,
    { isUseMultipleRangeRequest: false, platform: 'win32', executor } as unknown as ConstructorParameters<typeof GitHubProvider>[2]);
  try { return { ok: true, value: await provider.getLatestVersion(), unrouted }; }
  catch (e) { return { ok: false, value: e, unrouted }; }
}
/** 检查必须失败，且每一跳都是桩配过的；返回错误码与 describeUpdateError 的结果。 */
async function failureOf(site: Site): Promise<{ code: string; text: string }> {
  const r = await run(site);
  expect(r.unrouted, '桩没配的请求路径').toEqual([]);
  expect(r.ok, '期望检查失败，实际成功了').toBe(false);
  const code = String((r.value as { code?: unknown }).code ?? '');
  return { code, text: describeUpdateError(r.value) };
}

/** 一句人话：不漏响应头、不漏堆栈、不换行（状态行与托盘对话框都只放得下一行）。 */
function expectOneLiner(s: string, max: number): void {
  expect(s).not.toMatch(/Headers/);
  expect(s).not.toMatch(/\n/);
  expect(s).not.toMatch(/\bat\s+\S+\s+\(/);
  expect(s).not.toMatch(/<feed|XML/);
  expect(s.length).toBeLessThanOrEqual(max);
}

describe('桩执行器本身可信', () => {
  it('三跳都正常应答时，真 GitHubProvider 解析出 0.3.1——路由对，下面各例的失败才是 provider 自己抛的', async () => {
    const r = await run(OK);
    expect(r.unrouted).toEqual([]);
    expect(r.ok).toBe(true);
    expect((r.value as { version?: string }).version).toBe('0.3.1');
  });
});

describe('describeUpdateError · 真 GitHubProvider 各跳失败，各给一句中文说明', () => {
  it('发布仓库不存在：releases.atom 就回 404 →「还没有」，不漏响应头', async () => {
    const f = await failureOf({ atom: httpFail(404, 'atom') });
    expect(f.code).toBe('HTTP_ERROR_404');
    expect(f.text).toContain('还没有');
    expectOneLiner(f.text, 60);
  });

  it('空仓库：feed 里一个 entry 都没有（抛的是 XML 缺元素）→「还没有」', async () => {
    const f = await failureOf({ atom: feed() });
    expect(f.code).toBe('ERR_XML_MISSED_ELEMENT');
    expect(f.text).toContain('还没有');
    expectOneLiner(f.text, 60);
  });

  it('只发了 pre-release：/releases/latest 回 404，被外层包成 INVALID_RELEASE_FEED →「还没有」，不说「格式不对」', async () => {
    // RELEASE.md §4 专门提醒不能勾 pre-release；真勾错了，状态行要把人引向发布页，而不是让人去查清单格式
    const f = await failureOf({ ...OK, atom: feed(entry('v0.3.1-beta.1')), latest: httpFail(404, 'latest') });
    expect(f.code, '第二跳的失败先包成 LATEST_VERSION_NOT_FOUND，再被 getLatestVersion 的 catch 包成这个').toBe('ERR_UPDATER_INVALID_RELEASE_FEED');
    expect(f.text).toContain('还没有');
    expect(f.text).not.toContain('格式');
    expectOneLiner(f.text, 60);
  });

  it('/releases/latest 回空 body（NO_PUBLISHED_VERSIONS）→「还没有」', async () => {
    const f = await failureOf({ ...OK, latest: null });
    expect(f.code).toBe('ERR_UPDATER_NO_PUBLISHED_VERSIONS');
    expect(f.text).toContain('还没有');
  });

  it('Release 里漏传 latest.yml（CHANNEL_FILE_NOT_FOUND 包着 404）→「还没有」', async () => {
    const f = await failureOf({ ...OK, yml: httpFail(404, 'yml') });
    expect(f.code).toBe('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
    expect(f.text).toContain('还没有');
    expectOneLiner(f.text, 60);
  });

  it('限流 / 拒绝访问：三跳里哪一跳回 403、429 都是「限流」，不误报成「还没有」或「格式不对」', async () => {
    for (const hop of Object.keys(HOP) as HopName[]) {
      for (const status of [403, 429]) {
        const f = await failureOf({ ...OK, [hop]: httpFail(status, hop) });
        expect(f.text, `${hop} 回 ${status}（code ${f.code}）`).toContain('限流');
        expect(f.text).not.toMatch(/还没有|格式/);
        expectOneLiner(f.text, 60);
      }
    }
  });

  it('服务器 5xx：三跳里哪一跳回 502、503 都是「服务器出错」', async () => {
    for (const hop of Object.keys(HOP) as HopName[]) {
      for (const status of [502, 503]) {
        const f = await failureOf({ ...OK, [hop]: httpFail(status, hop) });
        expect(f.text, `${hop} 回 ${status}（code ${f.code}）`).toContain('服务器出错');
        expectOneLiner(f.text, 60);
      }
    }
  });

  it('断网：三跳里哪一跳断都是「连不上」，不误报成「还没有」或「格式不对」', async () => {
    for (const hop of Object.keys(HOP) as HopName[]) {
      for (const what of ['ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_RESET', 'ERR_NAME_NOT_RESOLVED']) {
        const f = await failureOf({ ...OK, [hop]: netFail(what) });
        expect(f.text, `${hop} ${what}（code ${f.code}）`).toContain('连不上');
        expect(f.text).not.toMatch(/还没有|格式/);
        expectOneLiner(f.text, 60);
      }
    }
  });

  it('/releases/latest 回的不是 JSON（被代理换成了网页）→「格式」', async () => {
    const f = await failureOf({ ...OK, latest: '<!DOCTYPE html><html><body>portal</body></html>' });
    expect(f.code).toBe('ERR_UPDATER_INVALID_RELEASE_FEED');
    expect(f.text).toContain('格式');
    expectOneLiner(f.text, 60);
  });

  it('/releases/latest 认不出的失败（服务器中途断开，HttpExecutor 的原话）→ 给内层原因的首行，不硬说「还没有」', async () => {
    const f = await failureOf({ ...OK, latest: new Error('Request has been aborted by the server') });
    expect(f.code).toBe('ERR_UPDATER_INVALID_RELEASE_FEED');
    expect(f.text).toContain('Request has been aborted by the server');
    expect(f.text).not.toMatch(/还没有|格式/);
    expectOneLiner(f.text, 130);
  });

  it('认不出的状态码（401、410）：三跳里哪一跳回都是「未知原因：<状态码> <短语>」，不带 HttpError: 前缀', async () => {
    // 第二跳的内层原因取自 HttpError 的 stack，首行是「HttpError: 401 Unauthorized」——前缀不去掉，状态行上就挂着英文类名。
    // 第一、三跳的 HttpError 原样抛出，message 首行本来就是「401 Unauthorized」；三跳给出同一句，才说明前缀去干净了
    for (const hop of Object.keys(HOP) as HopName[]) {
      for (const [status, phrase] of [[401, 'Unauthorized'], [410, 'Gone']] as const) {
        const f = await failureOf({ ...OK, [hop]: httpFail(status, hop) });
        expect(f.text, `${hop} 回 ${status}（code ${f.code}）`).toBe(`未知原因：${status} ${phrase}`);
        expect(f.text).not.toMatch(/\bError:/);
        if (hop === 'latest') expect(f.code).toBe('ERR_UPDATER_INVALID_RELEASE_FEED');
      }
    }
  });

  it('feed 条目坏了（entry 没有 link）→「格式」；拼在后面的 feed 正文里写着什么都不带偏分类', async () => {
    const bait = 'net::ERR_FAKE HttpError: 429 Unable to find latest version on GitHub';
    const f = await failureOf({ ...OK, atom: feed(entry(TAG, { link: false, title: bait })) });
    expect(f.code).toBe('ERR_UPDATER_INVALID_RELEASE_FEED');
    expect(f.text).toContain('格式');
    expect(f.text).not.toMatch(/连不上|限流|还没有/);
    expectOneLiner(f.text, 60);
  });

  it('latest.yml 写坏了（INVALID_UPDATE_INFO）→「格式」；拼在后面的清单原文不带偏分类', async () => {
    const f = await failureOf({ ...OK, yml: 'version: [0.3.1\nnote: net::ERR_FAKE HttpError: 404' });
    expect(f.code).toBe('ERR_UPDATER_INVALID_UPDATE_INFO');
    expect(f.text).toContain('格式');
    expect(f.text).not.toMatch(/连不上|还没有/);
    expectOneLiner(f.text, 60);
  });
});

/** 下载安装包那一跳用的是 builder-util-runtime 的 HttpExecutor.doDownload（Electron 里的 ElectronHttpExecutor 继承它，
 *  报错同一句）。换成 Node 的 http.request 就能在本机起服务器驱动真代码，拿到它自己拼出来的错误。 */
class NodeHttpExecutor extends HttpExecutor<ClientRequest> {
  createRequest(options: Parameters<HttpExecutor<ClientRequest>['createRequest']>[0], callback: (response: unknown) => void): ClientRequest {
    return httpRequest(options as never, callback as never);
  }
}

/** 本机服务器对下载请求回 status，返回 downloadToBuffer 抛出的原始错误。路径仿 GitHub 发布资产的签名 URL，故意很长。 */
async function downloadFailure(status: number): Promise<unknown> {
  const srv = createServer((_req, res) => { res.statusCode = status; res.end('nope'); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const { port } = srv.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${port}/${OWNER}/${REPO}/releases/download/${TAG}/DeskMinis-0.3.1-Setup.exe`
    + `?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${'A'.repeat(90)}&X-Amz-Signature=${'f'.repeat(64)}`);
  try {
    await new NodeHttpExecutor().downloadToBuffer(url, { headers: {}, cancellationToken: new CancellationToken() });
    return undefined;
  } catch (e) {
    return e;
  } finally {
    srv.close();
  }
}

describe('describeUpdateError · 下载安装包那一跳的失败（W2b-9b）', () => {
  it('原始错误确实是 HttpExecutor 拼的「Cannot download \"<URL>\", status <码>」——下面各例的输入是真代码给的', async () => {
    const e = await downloadFailure(404);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/^Cannot download "http:\/\/127\.0\.0\.1(?::\d+)?\/.+", status 404: Not Found$/);
  });

  it('404：latest.yml 已经拿到、安装包却没有 → 说漏传了安装包，不说「仓库不存在或还没发过版」', async () => {
    const text = describeUpdateError(await downloadFailure(404));
    expect(text).toBe('发布页上找不到新版安装包（Release 里可能漏传了 Setup.exe）');
  });

  it('403、429 →「限流」；502、503 →「服务器出错」', async () => {
    for (const st of [403, 429]) expect(describeUpdateError(await downloadFailure(st))).toBe('更新服务器暂时拒绝访问（可能被限流），稍后再试');
    for (const st of [502, 503]) expect(describeUpdateError(await downloadFailure(st))).toBe('更新服务器出错，稍后再试');
  });

  it('认不出的状态码：给状态码，不给 URL，不带英文原句', async () => {
    const text = describeUpdateError(await downloadFailure(401));
    expect(text).toBe('未知原因：下载安装包失败（HTTP 401）');
    expect(text).not.toMatch(/https?:\/\/|Cannot download/);
  });

  it('各状态的说明都不漏 URL 与签名参数', async () => {
    for (const st of [401, 403, 404, 429, 502, 503]) {
      const text = describeUpdateError(await downloadFailure(st));
      expect(text).not.toMatch(/https?:\/\/|X-Amz|Cannot download/);
    }
  });
});

describe('describeUpdateError · 不经 provider 的失败与怪输入', () => {
  it('Node 的网络错（errno 写在 code 上，message 里也有）→ 含「连不上」', () => {
    const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' });
    expect(describeUpdateError(enotfound)).toContain('连不上');
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(describeUpdateError(reset)).toContain('连不上');
  });

  it('下载后校验不符（ERR_CHECKSUM_MISMATCH，builder-util-runtime DigestTransform 的写法）→ 含「校验」', () => {
    const e = newError('sha512 checksum mismatch, expected abc, got def', 'ERR_CHECKSUM_MISMATCH');
    const s = describeUpdateError(e);
    expect(s).toContain('校验');
    expectOneLiner(s, 60);
  });

  it('未归类的错误：给原文首行，不带堆栈，总长有上限', () => {
    const e = new Error('Something odd happened in the updater\n    at foo (bar.js:1:2)\n    at baz (qux.js:3:4)');
    const s = describeUpdateError(e);
    expect(s).toBe('未知原因：Something odd happened in the updater');
    expect(s).not.toMatch(/\bError:/);
    expectOneLiner(s, 130);
    const long = describeUpdateError(new Error('x'.repeat(500)));
    expect(long.length).toBeLessThanOrEqual(130);
  });

  it('原文首行以 Error: 之类开头时去掉前缀，叠了几层也去干净', () => {
    // 第一版这里断言「不以 Error: 开头」，可输出总以「未知原因：」开头，那条断言永远成立（W2b-9 第二轮审查变异 M-O）
    expect(describeUpdateError('Error: plain string failure')).toBe('未知原因：plain string failure');
    expect(describeUpdateError(new Error('Error: TypeError: nested failure'))).toBe('未知原因：nested failure');
  });

  it('没有原型的对象（String() 会抛）也不抛，给「未知原因」', () => {
    expect(() => describeUpdateError(Object.create(null))).not.toThrow();
    expect(describeUpdateError(Object.create(null))).toBe('未知原因');
  });

  it('不是 Error 的怪输入也不抛：字符串、null、裸对象', () => {
    expect(describeUpdateError('Error: plain string failure')).toBe('未知原因：plain string failure');
    expect(describeUpdateError(null).length).toBeGreaterThan(0);
    expect(describeUpdateError({ weird: true }).length).toBeGreaterThan(0);
  });
});

describe('isPortableBuild · 便携版认环境变量', () => {
  it('便携版的启动器会设 PORTABLE_EXECUTABLE_DIR（app-builder-lib portable.nsi）；有值才算便携版', () => {
    expect(isPortableBuild({ PORTABLE_EXECUTABLE_DIR: 'C:\\Users\\me\\Desktop' })).toBe(true);
    expect(isPortableBuild({})).toBe(false);
    expect(isPortableBuild({ PORTABLE_EXECUTABLE_DIR: '' })).toBe(false);
  });
});

describe('manualCheckDialog · 托盘手动检查的结果对话框', () => {
  it('已是最新：说清楚，并带上当前版本号', () => {
    const d = manualCheckDialog({ status: 'latest' }, '0.3.0');
    expect(d.message).toContain('已是最新');
    expect(`${d.message}${d.detail ?? ''}`).toContain('0.3.0');
  });

  it('有新版：版本号 + 正在后台下载（available 与 downloading 同一句）', () => {
    for (const status of ['available', 'downloading']) {
      const d = manualCheckDialog({ status, version: '0.3.1' }, '0.3.0');
      expect(d.message).toContain('0.3.1');
      expect(`${d.message}${d.detail ?? ''}`).toContain('下载');
    }
  });

  it('失败：说失败，并把 describeUpdateError 给的原因原样放进 detail', () => {
    const reason = describeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'));
    const d = manualCheckDialog({ status: 'error', error: reason }, '0.3.0');
    expect(d.message).toContain('失败');
    expect(d.detail).toContain(reason);
    expect(d.type).not.toBe('info');
  });

  it('便携版：说不自动更新，并给出发布页地址', () => {
    const d = manualCheckDialog({ status: 'portable' }, '0.3.0');
    expect(d.message).toContain('便携版');
    expect(d.detail).toContain(RELEASES_PAGE_URL);
  });

  it('只有一个「知道了」按钮：这是回执，不是要用户做决定', () => {
    for (const status of ['latest', 'available', 'error', 'portable', 'dev', 'downloaded']) {
      expect(manualCheckDialog({ status }, '0.3.0').buttons).toEqual(['知道了']);
    }
  });
});

describe('发布页地址与 electron-builder.yml 的 publish 段一致', () => {
  it('RELEASES_PAGE_URL 指向 publish 段的 owner/repo（改更新源时两边一起改）', () => {
    const yml = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8')
      .replace(/\r\n/g, '\n').replace(/(^|\s)#.*$/gm, '$1');
    const pub = yml.slice(yml.search(/^publish:/m));
    const owner = /^\s+owner:\s*(\S+)/m.exec(pub)?.[1];
    const repo = /^\s+repo:\s*(\S+)/m.exec(pub)?.[1];
    expect(RELEASES_PAGE_URL).toBe(`https://github.com/${owner}/${repo}/releases`);
  });
});
