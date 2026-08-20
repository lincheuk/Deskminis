/** G1 市场缓存（设计稿 §2）：SQLite 追加式新表 market_cache（迁移见 store/db.ts MIGRATIONS[6]，
 *  只追加不动既有表）。策略：
 *  - TTL 软过期：列表 15 分钟 / 详情 24h（由适配器按端点性质传 ttlMs）；
 *  - 未过期直接命中**零网络请求**（性能纪律，审核盯点）；
 *  - 过期发 ETag 条件请求：304 只刷 fetched_at（不整取）；响应无 ETag 头时用正文哈希合成弱 ETag
 *    （三源只有 awesome-dsh 真发 ETag；合成值对不认 If-None-Match 的服务器无害——回 200 照常刷新）；
 *  - 网络失败（超时/5xx/截断）且有旧缓存 → 降级返回过期缓存并带 stale:true（UI 标注）；
 *    无旧缓存 → 响亮抛错，聚合层兜底。
 *  SQLite 走注入的既有连接（不新开）。 */
import type Database from 'better-sqlite3';
import type { MarketClient } from './client';
import { synthesizeEtag } from './client';

/** 缓存命中/降级的统一返回形态。 */
export interface MarketCacheEntry {
  body: string;
  etag?: string;
  /** true = 网络失败降级返回的过期缓存——调用方要透传到 UI 标注。 */
  stale: boolean;
}

interface CacheRow { etag: string | null; body: string; fetched_at: number }

export class MarketCache {
  /** 预编译语句：缓存是读侧热路径，别在每次命中时重新 prepare。 */
  private readonly select: Database.Statement;
  private readonly upsert: Database.Statement;
  private readonly touch: Database.Statement;

  constructor(private readonly db: Database.Database, private readonly client: MarketClient) {
    this.select = db.prepare('SELECT etag, body, fetched_at FROM market_cache WHERE key = ?');
    this.upsert = db.prepare(`
      INSERT INTO market_cache (key, etag, body, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, body = excluded.body, fetched_at = excluded.fetched_at
    `);
    this.touch = db.prepare('UPDATE market_cache SET fetched_at = ? WHERE key = ?');
  }

  /** 带 TTL/ETag/降级语义的 GET。key 由适配器构造（源前缀:端点:查询），与 URL 一一对应。 */
  async getText(key: string, url: string, opts: { maxBytes: number; ttlMs: number }): Promise<MarketCacheEntry> {
    const row = this.select.get(key) as CacheRow | undefined;
    const now = Date.now();
    // 未过期：直接命中，零网络请求（这是缓存存在的第一理由）。
    if (row && now - row.fetched_at < opts.ttlMs) {
      return { body: row.body, etag: row.etag ?? undefined, stale: false };
    }
    try {
      const r = await this.client.fetchText(url, { maxBytes: opts.maxBytes, etag: row?.etag ?? undefined });
      // 304：内容没变，只刷 fetched_at——不整取、不重算。
      if (r.status === 304 && row) {
        this.touch.run(now, key);
        return { body: row.body, etag: row.etag ?? undefined, stale: false };
      }
      // 2xx 且未截断才入库；截断的半截 JSON 绝不静默使用（按失败走降级）。
      if (r.status >= 200 && r.status < 300 && !r.truncated) {
        const etag = r.etag ?? synthesizeEtag(r.body);
        this.upsert.run(key, etag, r.body, now);
        return { body: r.body, etag, stale: false };
      }
      throw new Error(`市场源响应异常（status=${r.status}${r.truncated ? '，响应超体积上限被截断' : ''}）: ${url}`);
    } catch (e) {
      // 网络失败 + 有旧缓存：降级返回过期数据并标记 stale——读侧宁可旧数据也不能空手。
      if (row) return { body: row.body, etag: row.etag ?? undefined, stale: true };
      throw e; // 无旧数据可降级：失败要响亮，聚合层兜底
    }
  }
}
