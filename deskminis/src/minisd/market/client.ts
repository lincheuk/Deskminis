/** G1 市场客户端 fetch 封装（设计稿 §2/§7 安全锚点）：
 *  - 域名白名单是**运行时闸**（assertWhitelisted）：闸在 fetchImpl 之前，白名单外直接 throw，
 *    注入的 fetch 实现绝不被调用——比源码扫描硬，是「URL 查询串即外泄通道」纪律的执行点；
 *  - 预算上限（C 波纪律沿用）：超时 AbortSignal.timeout（默认 10s）、响应体积读流计数超限即断
 *    （不先整读再截断）、并发 ≤2（简单信号量）；
 *  - 请求卫生：头只带 accept 与条件 if-none-match，无任何本机标识/密钥/telemetry；
 *    URL 查询串由适配器构造、只含功能参数。
 *  零新依赖：Node 22 全局 fetch。 */
import { createHash } from 'node:crypto';

/** 三源实抓（2026-08-20，g1-probe-run.txt）裁定的域名集合——编译期常量。
 *  ClawHub / MCP 官方注册表 / awesome-dsh-plugin 全部可达，无 B 计划占位。
 *  增删源 = 改这里 + 改对应适配器，白名单闸会拦住其它一切域名（含仿冒子域）。 */
export const MARKET_DOMAIN_WHITELIST: readonly string[] = [
  'clawhub.ai',
  'registry.modelcontextprotocol.io',
  'awesome-dsh-plugin.com',
];

/** 运行时白名单闸：校验 URL 形态 + 协议 + 域名精确匹配。
 *  仿冒子域（clawhub.ai.evil.com）不走后缀匹配而是全等比对——子域不继承信任。 */
export function assertWhitelisted(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`市场请求 URL 非法: ${url}`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(`市场请求必须走 https（当前 ${u.protocol}）: ${url}`);
  }
  if (!MARKET_DOMAIN_WHITELIST.includes(u.hostname)) {
    throw new Error(`市场请求域名不在白名单（${MARKET_DOMAIN_WHITELIST.join(' / ')}）: ${u.hostname}`);
  }
  return u;
}

export interface MarketFetchOpts {
  /** 响应体积上限（字节）：列表 2MB / 详情与 README 512KB，由调用方按端点性质给。 */
  maxBytes: number;
  /** 本调用超时覆盖（测试注入短时限用；默认 10s 在构造配置）。 */
  timeoutMs?: number;
  /** 条件请求 ETag（缓存层传入；304 透传回缓存层判断）。 */
  etag?: string;
}

export interface MarketFetchResult {
  status: number;
  body: string;
  etag?: string;
  /** true = 读流计数超上限被截断——调用方（缓存层）按失败处理，绝不静默用半截 JSON。 */
  truncated: boolean;
}

/** 并发 ≤2 的简单信号量：市场是后台读侧，不该挤占用户主动网络。
 *  G2 名额转交式（G1 审核发现的竞态修复）：release 把名额直接转交给队首排队者
 *  （唤醒其 acquire 续体，计数不减），无排队者才减计数。旧实现先减计数再唤醒、
 *  被唤醒者在微任务里补计数——同步窗口内新 acquire 看到已减的计数直接进入，
 *  瞬时并发可到 3；转交式下计数在窗口内仍含已转交名额，插队不可能。 */
class Semaphore {
  private inflight = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.inflight < this.max) { this.inflight++; return; }
    // 名额由 release 转交而来（计数已保留）——被唤醒路径不再补计数
    await new Promise<void>((res) => this.queue.push(res));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();            // 名额直接转交给排队者，计数不减
    else this.inflight--;
  }
}

/** 默认超时 10s：市场列表是可降级读，挂 10s 已远超用户耐心，宁可走 stale 缓存。 */
const DEFAULT_TIMEOUT_MS = 10_000;

export class MarketClient {
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly sem = new Semaphore(2);

  constructor(fetchImpl?: typeof fetch, opts?: { timeoutMs?: number }) {
    this.defaultTimeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const base = fetchImpl ?? fetch;
    // 测试注入口：把白名单域名的请求重写到本地 node:http fixture。
    // 闸已经在 fetch 之前校验过生产 URL——注入只重写网络层路由，不绕闸。
    const fixture = process.env.DESKMINIS_MARKET_FIXTURE_URL;
    this.fetchImpl = fixture
      ? (input, init) => base(String(input).replace(/^https:\/\/[^/]+/, fixture), init)
      : base;
  }

  /** 取文本响应。闸 → 信号量 → fetch → 读流计数。
   *  体积超限不是 throw 而是 truncated:true——「读到上限字节即断」这个行为本身要可观测，
   *  失败语义由缓存层统一决定（有旧缓存降级 stale，无旧缓存才响亮抛错）。 */
  async fetchText(url: string, opts: MarketFetchOpts): Promise<MarketFetchResult> {
    // 闸在一切之前：白名单外/非 https 在这里就死，fetchImpl 永不被调用。
    assertWhitelisted(url);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.etag) headers['if-none-match'] = opts.etag;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    await this.sem.acquire();
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } finally {
      this.sem.release();
    }

    // 304/204 无正文：直接透传状态给缓存层（只刷 fetched_at 的判断在那边做）。
    const etag = res.headers.get('etag') ?? undefined;
    if (res.status === 304 || res.status === 204 || !res.body) {
      return { status: res.status, body: '', etag, truncated: false };
    }

    // 读流计数：累计到 maxBytes 即 cancel 流并截断到恰 maxBytes 字节。
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > opts.maxBytes) {
          truncated = true;
          await reader.cancel().catch(() => { /* 取消失败不影响截断结果 */ });
          break;
        }
      }
    } catch (e) {
      // 读流中途被超时信号打断等：按失败抛出，交给缓存层降级。
      throw e;
    }

    const buf = new Uint8Array(Math.min(total, opts.maxBytes));
    let off = 0;
    for (const c of chunks) {
      if (off >= buf.length) break;
      const take = Math.min(c.length, buf.length - off);
      buf.set(c.subarray(0, take), off);
      off += take;
    }
    return {
      status: res.status,
      body: new TextDecoder('utf-8').decode(buf),
      etag,
      truncated,
    };
  }

  /** 取二进制响应（G2 安装物下载，实抓裁定 clawhub /api/v1/download 回 application/zip）：
   *  闸 → 信号量 → fetch → 读流计数——与 fetchText 同一套预算纪律，但不经缓存层
   *  （安装物要内容哈希，每次定点直取）且失败要响亮：非 2xx / 超体积直接 throw，
   *  无降级语义（半截 zip 落盘比失败更糟）。 */
  async fetchBytes(url: string, opts: MarketFetchOpts): Promise<{ bytes: Buffer; etag?: string }> {
    assertWhitelisted(url);
    const headers: Record<string, string> = { accept: 'application/octet-stream' };
    if (opts.etag) headers['if-none-match'] = opts.etag;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    await this.sem.acquire();
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } finally {
      this.sem.release();
    }
    if (res.status < 200 || res.status >= 300 || !res.body) {
      throw new Error(`安装物下载失败（HTTP ${res.status}）: ${url}`);
    }
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      chunks.push(buf);
      total += buf.length;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => { /* 取消失败不影响抛错 */ });
        throw new Error(`安装物超过体积上限（${opts.maxBytes} 字节）: ${url}`);
      }
    }
    return { bytes: Buffer.concat(chunks, total), etag: res.headers.get('etag') ?? undefined };
  }
}

/** 响应无 ETag 头时用正文哈希合成一个（弱 ETag 形态）：
 *  三源里只有 awesome-dsh（GitHub Pages）真发 ETag；ClawHub/registry 不发。
 *  合成值用于过期后的条件重取——不认 If-None-Match 的服务器会直接回 200（照常刷新缓存），
 *  认的服务器能省一次整取。合成失败不可能（sha256 总能算）。 */
export function synthesizeEtag(body: string): string {
  return `W/"${createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32)}"`;
}
