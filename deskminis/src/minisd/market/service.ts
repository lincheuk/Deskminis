/** G1 市场聚合服务（设计稿 §6 读侧三件）：sources.list / search / detail。
 *  聚合纪律（审核盯点）：
 *  - 多源 search 用 Promise.allSettled 并发聚合——不串行、单源挂不拖垮整体（部分源给结果）；
 *  - 全部源都挂才抛错（完全空手比报错更误导）；
 *  - 分页每页 ≤30：按源数均分配额（ceil(30/N)），聚合游标编码各源游标（base64url JSON），
 *    上游游标透传（有则用）、无游标的源在适配器内本地切页；
 *  - 读操作免批（与 skills.list 同档）：本层不做任何权限询问。
 *  SQLite 走注入的既有连接（service 构造收 db，不新开）。 */
import type Database from 'better-sqlite3';
import { MarketClient } from './client';
import { MarketCache } from './cache';
import { ClawHubSource } from './clawhub';
import { McpRegistrySource } from './mcp-registry';
import { AwesomeDshSource } from './awesome-dsh';
import type { MarketItem, MarketKind, MarketPage, MarketSource, MarketSourceStatus, MarketDetail } from './types';

/** RPC 分页上限：每页 ≤30 条。 */
const PAGE_MAX = 30;
const LIST_TTL_MS = 15 * 60 * 1000;

/** 源探活端点（轻量 GET，走缓存：与对应列表缓存同键的共用一条——探活即暖缓存）。
 *  clawhub 用 /.well-known/clawhub.json（138B 发现文档）；registry 用 limit=1 列表；
 *  awesome-dsh 探活即拉索引本体（1.28MB<2MB 上限，且与搜索共用缓存键，后续搜索零网络）。 */
const PROBES: Record<string, { url: string; key: string; maxBytes: number }> = {
  'clawhub': { url: 'https://clawhub.ai/.well-known/clawhub.json', key: 'clawhub:probe', maxBytes: 64 * 1024 },
  'mcp-registry': { url: 'https://registry.modelcontextprotocol.io/v0.1/servers?limit=1', key: 'mcp-registry:probe', maxBytes: 64 * 1024 },
  'awesome-dsh': { url: 'https://awesome-dsh-plugin.com/plugins.json', key: 'awesome-dsh:index', maxBytes: 2 * 1024 * 1024 },
};

function encodeCursor(per: Record<string, string>): string {
  return Buffer.from(JSON.stringify(per), 'utf8').toString('base64url');
}

/** 坏游标（非 base64url JSON / 非字符串值映射）一律响亮报错——静默回第一页会造成分页错位。 */
function decodeCursor(c: string): Record<string, string> {
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
  } catch {
    throw new Error('非法分页游标');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('非法分页游标');
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error('非法分页游标');
  }
  return obj as Record<string, string>;
}

export class MarketService {
  private readonly cache: MarketCache;
  private readonly sources: MarketSource[];

  /** G2 起支持注入共享装配（client/cache/sources）：index.ts 让读侧服务与安装链路
   *  （MarketInstaller）共用同一份缓存与并发预算；不传时自建（单测/独立用法同 G1 行为）。 */
  constructor(db: Database.Database, opts?: { client?: MarketClient; cache?: MarketCache; sources?: MarketSource[] }) {
    const client = opts?.client ?? new MarketClient();
    this.cache = opts?.cache ?? new MarketCache(db, client);
    this.sources = opts?.sources ?? [
      new ClawHubSource(this.cache),
      new McpRegistrySource(this.cache),
      new AwesomeDshSource(this.cache),
    ];
  }

  /** market.sources.list：源清单 + 可达状态。available=配置态（B 计划占位时 false，
   *  G1 三源实抓全部可用无占位）；reachable=探活（走缓存，未过期零网络）。 */
  async sourcesList(): Promise<{ sources: MarketSourceStatus[] }> {
    const settled = await Promise.allSettled(this.sources.map(async (s) => {
      const probe = PROBES[s.id];
      if (probe) {
        await this.cache.getText(probe.key, probe.url, { maxBytes: probe.maxBytes, ttlMs: LIST_TTL_MS });
      }
      return { id: s.id, name: s.name, tier: s.tier, kinds: [...s.kinds], available: true, reachable: 'ok' as const };
    }));
    return {
      sources: settled.map((r, i) => {
        const s = this.sources[i];
        // 探活失败不拖垮清单：源还在（available），只是当下不可达。
        if (r.status === 'rejected') {
          return { id: s.id, name: s.name, tier: s.tier, kinds: [...s.kinds], available: true, reachable: 'unreachable' as const };
        }
        return r.value;
      }),
    };
  }

  /** market.search({kind, q, category?, cursor?})：kind 路由到服务该类别的源集合，
   *  并发聚合分页。category G1 收下不参与过滤（三源无分类面，G3 chips 再接）。 */
  async search(p: { kind?: unknown; q?: unknown; category?: unknown; cursor?: unknown }): Promise<MarketPage> {
    const kind = p.kind;
    if (kind !== 'skill' && kind !== 'mcp') throw new Error(`非法 kind: ${String(kind)}`);
    const q = typeof p.q === 'string' ? p.q : '';
    if (p.cursor !== undefined && typeof p.cursor !== 'string') throw new Error('非法分页游标');
    const per = p.cursor === undefined ? {} : decodeCursor(p.cursor);

    const sources = this.sources.filter((s) => (s.kinds as readonly MarketKind[]).includes(kind));
    if (sources.length === 0) throw new Error(`无源服务 kind=${kind}`);
    const quota = Math.ceil(PAGE_MAX / sources.length); // 每源配额：skill 双源 15、mcp 单源 30

    // 第二页起只调上一页还持有游标的源；空映射（或全空）视作第一页调全部源。
    const targets = Object.keys(per).length === 0
      ? sources
      : sources.filter((s) => per[s.id] !== undefined);
    const settled = await Promise.allSettled(
      targets.map((s) => s.search(q, kind, per[s.id], quota)),
    );

    const items: MarketItem[] = [];
    const next: Record<string, string> = {};
    let stale = false;
    let fulfilled = 0;
    settled.forEach((r, i) => {
      if (r.status === 'rejected') return; // 单源挂不拖垮整体：其余源照常给结果
      fulfilled++;
      items.push(...r.value.items);
      if (r.value.stale) stale = true;
      if (r.value.cursor) next[targets[i].id] = r.value.cursor;
    });
    if (fulfilled === 0) {
      // 全部源都失败且无降级可用：响亮报错（聚合层兜底点）。
      const first = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      throw first.reason instanceof Error ? first.reason : new Error(String(first.reason));
    }
    const page: MarketPage = { items };
    if (items.length > PAGE_MAX) page.items = items.slice(0, PAGE_MAX); // 保险：绝不超页
    if (Object.keys(next).length > 0) page.cursor = encodeCursor(next);
    if (stale) page.stale = true;
    return page;
  }

  /** market.detail({id})：按源前缀路由；未知前缀/缺 id 报错（detail 是定点查询，失败要响亮）。
   *  全 id 透传给适配器（适配器统一接口：detail 收归一 id，自剥本源前缀）。 */
  async detail(p: { id?: unknown }): Promise<MarketDetail> {
    const id = p.id;
    if (typeof id !== 'string' || id === '' || !id.includes(':')) throw new Error('缺少或非法的市场条目 id');
    const prefix = id.slice(0, id.indexOf(':'));
    const src = this.sources.find((s) => s.id === prefix);
    if (!src) throw new Error(`未知市场源前缀: ${prefix}`);
    return src.detail(id);
  }
}
