/** 自动更新状态的人话与判定（W2b-9；止血设计稿 §2「自动更新源」、发布工程一条）。
 *  不 import electron（只有类型），便于在 ELECTRON_RUN_AS_NODE 下直接单测——与 minisd-fatal.ts 同一手法。 */
import type { MessageBoxOptions } from 'electron';

/** 主进程记下的最近一次更新状态，设置→关于与托盘回执都读它。 */
export interface UpdateState { status: string; version?: string; error?: string }

/** 发布页：与 electron-builder.yml 的 publish 段同一个 owner/repo（tests/update-error-text.test.ts 核对两边一致）。
 *  写死在这里而不是运行时读 app-update.yml：对话框里给用户看的地址不该取决于安装目录里一个文件在不在。 */
export const RELEASES_PAGE_URL = 'https://github.com/lincheuk/deskminis-releases/releases';

const TEXT = {
  notFound: '发布页上还没有可用的版本（发布仓库不存在，或还没发过正式版）',
  throttled: '更新服务器暂时拒绝访问（可能被限流），稍后再试',
  serverError: '更新服务器出错，稍后再试',
  network: '连不上更新服务器（离线或网络受限）',
  checksum: '新版安装包校验不符，已丢弃，下次启动重试',
  badInfo: '版本信息格式不对，已跳过本次检查',
} as const;

/** electron-updater / GitHubProvider 报「没有可用版本」的码（LATEST_VERSION_NOT_FOUND 另走 latestTagFailure）。
 *  空仓库的 releases.atom 没有 <entry>，它在那里抛的是 XML 缺元素（ERR_XML_MISSED_ELEMENT），
 *  文案却是「No published versions」，要一并认。 */
const NOT_FOUND_CODES = new Set(['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND']);
/** GitHubProvider 在 getLatestVersion 里把 feed 解析阶段的错误包成 INVALID_RELEASE_FEED，消息形如
 *  「Cannot parse releases feed: <内层错误的 stack>,\nXML:\n<整段 feed>」。分类只看这个标记之前的内层错误。 */
const FEED_XML_MARK = '\nXML:\n';
/** getLatestTagName（/releases/latest 那一跳）抛 LATEST_VERSION_NOT_FOUND 时的特征句（6.8.9 的 GitHubProvider 与 PrivateGitHubProvider 同句）。 */
const LATEST_TAG_TEXT = 'Unable to find latest version on GitHub';
/** 同一句的后半截，冒号之后拼的就是内层错误（e.stack || e.message）。 */
const LATEST_TAG_CAUSE = /please ensure a production release exists: ([\s\S]*)$/;
const NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH']);
/** Electron 的 net 模块报错只有 message（net::ERR_…），Node 的报错 errno 也会写进 message，两种一起认。 */
const NET_TEXT = /net::ERR_|\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH)\b/;
/** 最后一类兜底给原文首行，截到这个长度：状态行与托盘对话框都只放得下一行。 */
const RAW_MAX = 120;

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : '';
}
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : String(e);
}

/** 按 HTTP 状态码归类：429 / 403 当限流（GitHub 未登录访问被限就回这两个），5xx 当服务器出错，404 当没有版本。 */
function byStatus(status: number): string | undefined {
  if (status === 404) return TEXT.notFound;
  if (status === 403 || status === 429) return TEXT.throttled;
  if (status >= 500 && status <= 599) return TEXT.serverError;
  return undefined;
}

/** 把 electron-updater 的错误变成一行中文。原文（带响应头与堆栈）由调用方写 stderr，不进界面。
 *
 *  判定顺序有讲究：
 *  - 校验不符、格式不对先认：这两类的 message 里拼着清单原文或整段 feed XML，里面出现什么字样都不能把分类带偏；
 *  - INVALID_RELEASE_FEED 不全是「格式不对」：GitHubProvider 检查分三跳（releases.atom → /releases/latest → latest.yml），
 *    第二跳的任何失败（断网、403/429 限流、5xx、只发了 pre-release 时的 404）先被 getLatestTagName 包成
 *    LATEST_VERSION_NOT_FOUND，再被 getLatestVersion 的 catch 包成 INVALID_RELEASE_FEED 并拼上整段 feed XML
 *    （electron-updater 6.8.9 GitHubProvider.js 的 getLatestVersion 与 getLatestTagName）。
 *    所以只取 XML 之前那段内层错误：含 LATEST_VERSION_NOT_FOUND 的特征句就按第二跳的失败细分，否则才是真的格式不对；
 *  - 然后才看断网与 HTTP 状态码：第一跳、第三跳的失败原样抛出，不经包装。 */
export function describeUpdateError(e: unknown): string {
  const code = codeOf(e);
  const msg = messageOf(e);
  if (code === 'ERR_CHECKSUM_MISMATCH') return TEXT.checksum;
  if (code === 'ERR_UPDATER_INVALID_UPDATE_INFO') return TEXT.badInfo;
  if (code === 'ERR_UPDATER_INVALID_RELEASE_FEED') {
    const cut = msg.indexOf(FEED_XML_MARK);
    const inner = cut < 0 ? msg : msg.slice(0, cut);
    return inner.includes(LATEST_TAG_TEXT) ? latestTagFailure(inner) : TEXT.badInfo;
  }
  if (NET_CODES.has(code) || NET_TEXT.test(msg)) return TEXT.network;

  const direct = /^HTTP_ERROR_(\d{3})$/.exec(code);
  if (direct) return byStatus(Number(direct[1])) ?? rawLine(msg);
  // 没被外层再包一层就到达的 LATEST_VERSION_NOT_FOUND（其他 provider 的写法）同样细分
  if (code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND') return latestTagFailure(msg);
  if (NOT_FOUND_CODES.has(code)) return TEXT.notFound;
  if (code === 'ERR_XML_MISSED_ELEMENT' && /No published versions/i.test(msg)) return TEXT.notFound;
  return rawLine(msg);
}

/** /releases/latest 这一跳失败时的细分。text 是 LATEST_VERSION_NOT_FOUND 的消息（已去掉 feed XML），
 *  只看冒号后面拼着的内层错误：断网是 net::ERR_… 或 errno，HTTP 失败首行是「HttpError: <状态码> …」，
 *  回来的不是 JSON（被代理换成网页）是 JSON.parse 的 SyntaxError。
 *  只发了 pre-release 时 GitHub 在这里回 404，走的是 byStatus 的 404 →「还没有」
 *  （draft 不公开，未登录拿到的 releases.atom 里就没有它，停在第一跳）。
 *  认不出的内层错误（服务器中途断开、重定向过多……）不硬归「还没有」：那会把人引去翻发布页，
 *  与直接到达的 HTTP_ERROR_ 未知状态码一样，给内层错误自己的首行。 */
function latestTagFailure(text: string): string {
  const cause = LATEST_TAG_CAUSE.exec(text)?.[1] ?? text;
  if (NET_TEXT.test(cause)) return TEXT.network;
  const st = /HttpError: (\d{3})\b/.exec(cause);
  if (st) return byStatus(Number(st[1])) ?? rawLine(cause);
  if (/\bSyntaxError\b/.test(cause)) return TEXT.badInfo;
  return rawLine(cause);
}

/** 兜底：原文首行，去掉 Error: 前缀，最多 RAW_MAX 字。
 *  不以「检查失败」开头：设置→关于的状态行本身已经是「更新失败 · 」，再叠一次就是同一句说两遍。 */
function rawLine(msg: string): string {
  const first = (msg.split(/\r?\n/).find(l => l.trim() !== '') ?? '').trim().replace(/^(?:\w*Error:\s*)+/, '');
  if (first === '') return '未知原因';
  const cut = first.length > RAW_MAX ? first.slice(0, RAW_MAX - 1) + '…' : first;
  return `未知原因：${cut}`;
}

/** 便携版：app-builder-lib 的 portable.nsi 启动时设 PORTABLE_EXECUTABLE_DIR（解压前 exe 所在目录）。
 *  安装包的 app-update.yml 便携版里也带着，electron-updater 自己不区分——不拦的话它会去下载 NSIS 安装包
 *  （侦察据源码推断，重启后会在旁边装出一份安装版，未在真机确认）。所以便携版直接不检查、不下载，状态为 portable。 */
export function isPortableBuild(env: Record<string, string | undefined>): boolean {
  const v = env.PORTABLE_EXECUTABLE_DIR;
  return typeof v === 'string' && v !== '';
}

/** 托盘「检查更新…」的回执。只有一个「知道了」：这是告诉用户结果，不是要用户做决定——
 *  真要做决定的（下载完是否重启安装）由 update-downloaded 那个对话框负责。 */
export function manualCheckDialog(s: UpdateState, currentVersion: string): MessageBoxOptions {
  const base = { title: '检查更新', buttons: ['知道了'], defaultId: 0, cancelId: 0, noLink: true };
  const v = s.version ? ` ${s.version}` : '';
  switch (s.status) {
    case 'latest':
      return { ...base, type: 'info', message: '已是最新版本', detail: `当前版本 v${currentVersion}。` };
    case 'available':
    case 'downloading':
      return { ...base, type: 'info', message: `发现新版本${v}，正在后台下载`,
        detail: '下载完成后会再提示你选择何时重启安装，期间可以照常使用。' };
    case 'downloaded':
      return { ...base, type: 'info', message: `新版本${v} 已下载完成`, detail: '重启应用后生效。' };
    case 'portable':
      return { ...base, type: 'info', message: '便携版不自动更新',
        detail: `请到发布页下载新版：${RELEASES_PAGE_URL}` };
    case 'dev':
      return { ...base, type: 'info', message: '开发模式不检查更新', detail: '打包后的安装版才会检查。' };
    case 'error':
      return { ...base, type: 'warning', message: '检查更新失败', detail: s.error ?? '未知原因' };
    default:
      // checking：另一处检查还在进行（electron-updater 复用同一个 promise，正常走不到这里）
      return { ...base, type: 'info', message: '检查已发起', detail: '结果稍后可在「设置 → 关于」里查看。' };
  }
}
