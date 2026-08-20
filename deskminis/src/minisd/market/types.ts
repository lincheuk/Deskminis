/** G1 市场客户端类型（设计稿 §2）：跨源归一的数据模型 + 适配器统一接口。
 *  归一是消费端唯一防线的一部分——raw 只作排查留档，永远不参与安装决策（安装走 G2 的
 *  显式字段核验），防止上游在 raw 里夹带的任何「指令性内容」被下游误信。 */

/** 市场条目类别。G1 只开两类读侧；主题与 DSH 代码插件类在 awesome-dsh 适配器源头即丢弃。 */
export type MarketKind = 'skill' | 'mcp';

/** 上游安全裁定（消费上游扫描结论，不自建扫描）：
 *  - ok：扫描通过；warn：可疑（需用户确认）；malicious：恶意（G2 硬阻断）；
 *  - unscanned：无上游裁定（awesome-dsh 全部、各源列表态默认）。 */
export type MarketVerdict = 'ok' | 'warn' | 'malicious' | 'unscanned';

/** 源信任层级：official=官方人工审核层；community=开放提交层（ClawHub 平台扫描≠官方背书，
 *  ClawHavoc 教训：社区源即便带 scan 结论也只标 community）。 */
export type MarketSourceTier = 'official' | 'community';

/** 跨源归一条目（设计 §2）：id 带源前缀（如 clawhub:owner/slug），供 detail/install 定点寻址。 */
export interface MarketItem {
  id: string;
  kind: MarketKind;
  name: string;
  author: string;
  description: string;
  stats: { downloads: number; stars: number };
  verdict: MarketVerdict;
  sourceTier: MarketSourceTier;
  /** 源内分类（awesome-dsh 的 category 等）；无分类语义的源不填。 */
  category?: string;
  /** 上游原始条目（排查留档，不参与安装决策）。 */
  raw?: unknown;
}

/** 搜索结果页：cursor 存在即还有下一页；stale=true 表示网络失败降级返回了过期缓存（UI 要标注）。 */
export interface MarketPage {
  items: MarketItem[];
  cursor?: string;
  stale?: boolean;
}

/** 详情：item（归一字段）+ readme（SKILL.md 全文 / description），README 只在 detail 拉取不进列表。
 *  latestVersion（G4）：源内最新版本串（ClawHub latestVersion.version / registry server.version），
 *  无版本概念的源不填——checkUpdates 的「可更新 vX→vY」标记数据源。 */
export interface MarketDetail {
  item: MarketItem;
  readme: string;
  stale?: boolean;
  latestVersion?: string;
}

/** 适配器统一接口（设计 §2）：三源各实现一份，聚合层（service）只认这个接口。 */
export interface MarketSource {
  /** 源 id，即条目 id 前缀：'clawhub' | 'mcp-registry' | 'awesome-dsh'。 */
  id: string;
  name: string;
  tier: MarketSourceTier;
  /** 该源服务的条目类别（用于聚合路由与 sources.list 报告）。只读：源的能力清单不允许实现外被改写。 */
  kinds: readonly MarketKind[];
  /** 搜索；cursor 语义由适配器自定（上游游标透传或本地偏移），limit 为调用方页配额。 */
  search(q: string, kind: MarketKind, cursor?: string, limit?: number): Promise<MarketPage>;
  /** 定点详情；id 是归一全形态（含本源前缀，适配器自剥）；失败要响亮（detail 是用户点名要看的东西）。
   *  opts.ttlMs（G4）：缓存 TTL 覆盖——checkUpdates 传 0 强制走条件请求（详情缓存 24h，
   *  刚发布的更新不能被缓存挡住）；缺省用适配器端点档位。 */
  detail(id: string, opts?: { ttlMs?: number }): Promise<MarketDetail>;
}

/** sources.list 的单源报告：available=源是否启用（B 计划占位时 false），
 *  reachable=探活结果（'ok' | 'unreachable'，探活走缓存不额外打网络）。 */
export interface MarketSourceStatus {
  id: string;
  name: string;
  tier: MarketSourceTier;
  kinds: readonly MarketKind[];
  available: boolean;
  reachable: 'ok' | 'unreachable';
}
