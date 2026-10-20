import type { CompactMarker, RawMessage, SessionMeta, TokenUsage } from '../../shared/types';
import { serializeParts, parseParts } from '../../shared/parts';

/** 线格式 Message，对齐 OM SyncedMessage（SyncedTypes.swift L64-124）+ M3b 追加 originDeviceId/createdLocallyAt。 */
export interface WireMessage {
  id: string;
  sessionId: string;
  role: string;
  partsJson: string;
  tokenUsageJson: string | null;
  reasoningContent: string | null;
  streamInterruptCount: number;
  /** best-effort hint only（同 OM 注释 L72-76）： receivers MUST derive their own sort_order */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  // M3b 追加字段（OM 侧需加，本计划只定契约）
  originDeviceId: string;
  createdLocallyAt: number;
}

/** 线格式 CompactMarker，双锚齐备主锚 lastCompactedMessageId（§4.4）。 */
export interface WireCompactMarker {
  id: string;
  sessionId: string;
  summary: string;
  createdAt: number;
  lastCompactedMessageId?: string;
  firstKeptMessageId?: string;
  firstKeptSortOrder: number;
  compactedCount: number;
  boundaryMessageId?: string;
  uiBoundarySortOrder?: number;
  version: number;
}

export interface WireSession {
  id: string;
  title: string;
  category?: string;
  modelId?: string;
  createdAt: number;
  updatedAt: number;
  memoryEnabled: number;
  modelBinding?: string;
  pinnedAt?: number;
}

export interface WireSessionFile {
  sessionId: string;
  relativePath: string;
  fileSize: number;
  mimeType?: string;
  updatedAt: number;
  // M3b 追加字段（OM 侧需加）
  originDeviceId: string;
  sha256?: string;
  toolUseId?: string;
}

export function toWireMessage(m: RawMessage): WireMessage {
  return {
    id: m.id, sessionId: m.sessionId, role: m.role,
    partsJson: serializeParts(m.parts),
    tokenUsageJson: m.tokenUsage ? JSON.stringify(m.tokenUsage) : null,
    reasoningContent: m.reasoningContent ?? null,
    streamInterruptCount: m.streamInterruptCount,
    sortOrder: m.sortOrder, // best-effort
    createdAt: m.createdAt, updatedAt: m.updatedAt,
    originDeviceId: m.originDeviceId ?? 'legacy',
    createdLocallyAt: m.createdLocallyAt ?? m.createdAt,
  };
}

export function fromWireMessage(w: WireMessage): Omit<RawMessage, 'sortOrder' | 'updatedAt'> {
  return {
    id: w.id, sessionId: w.sessionId, role: w.role as RawMessage['role'],
    parts: parseParts(w.partsJson),
    createdAt: w.createdAt,
    tokenUsage: w.tokenUsageJson ? JSON.parse(w.tokenUsageJson) as TokenUsage : undefined,
    reasoningContent: w.reasoningContent ?? undefined,
    streamInterruptCount: w.streamInterruptCount,
    originDeviceId: w.originDeviceId,
    createdLocallyAt: w.createdLocallyAt,
  };
}

/** 出口：从本地 CompactMarker + 本地消息序列回填辅助锚。 */
export function toWireMarker(m: CompactMarker, messages: RawMessage[]): WireCompactMarker {
  const idx = messages.findIndex(x => x.id === m.lastCompactedMessageId);
  let firstKeptMessageId: string | undefined;
  let firstKeptSortOrder: number;
  if (idx >= 0 && idx + 1 < messages.length) {
    firstKeptMessageId = messages[idx + 1].id;
    firstKeptSortOrder = messages[idx + 1].sortOrder;
  } else if (idx >= 0) {
    // 锚=末条：firstKept 不存在，sortOrder = 末条 + 1
    firstKeptSortOrder = messages[idx].sortOrder + 1;
  } else {
    // 锚不在本地序（理论不该发生，防兜底）
    firstKeptSortOrder = 0;
  }
  return {
    id: m.id, sessionId: m.sessionId, summary: m.summary, createdAt: m.createdAt,
    lastCompactedMessageId: m.lastCompactedMessageId,
    firstKeptMessageId, firstKeptSortOrder,
    compactedCount: idx + 1, // 锚点前的消息数
    version: 2,
  };
}

/**
 * 入口：在 **合并排序后的消息序列** 上回算（§4.4 时序关键）。
 * 必须在 mergeSession() 完成消息合并排序之后调用——不能对 wire 原始记录直接算。
 */
export function resolveWireMarker(
  w: WireCompactMarker,
  mergedMessages: RawMessage[],
): { marker: CompactMarker; isOrphan: boolean } {
  const marker: CompactMarker = {
    id: w.id, sessionId: w.sessionId, summary: w.summary,
    lastCompactedMessageId: w.lastCompactedMessageId ?? '', // 占位，下面回填
    createdAt: w.createdAt,
  };
  // 1. 优先取 lastCompactedMessageId（非空且存在于 mergedMessages）
  if (w.lastCompactedMessageId) {
    const found = mergedMessages.some(m => m.id === w.lastCompactedMessageId);
    if (found) {
      marker.lastCompactedMessageId = w.lastCompactedMessageId;
      return { marker, isOrphan: false };
    }
  }
  // 2. 缺失/未命中 → firstKeptMessageId 在 mergedMessages 上找前一条
  if (w.firstKeptMessageId) {
    const idx = mergedMessages.findIndex(m => m.id === w.firstKeptMessageId);
    if (idx > 0) {
      marker.lastCompactedMessageId = mergedMessages[idx - 1].id;
      return { marker, isOrphan: false };
    }
    // idx === 0 → firstKept 是首条，无前一条 → orphan
    return { marker, isOrphan: true };
  }
  // 3. 两锚都缺 → firstKeptSortOrder 在 mergedMessages 上按 sortOrder 定位（legacy v1 链）
  const idxBySort = mergedMessages.findIndex(m => m.sortOrder === w.firstKeptSortOrder);
  if (idxBySort > 0) {
    marker.lastCompactedMessageId = mergedMessages[idxBySort - 1].id;
    return { marker, isOrphan: false };
  }
  return { marker, isOrphan: true };
}

export function toWireSession(s: SessionMeta): WireSession {
  return {
    id: s.id, title: s.title,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
    memoryEnabled: s.memoryEnabled === false ? 0 : 1,
    modelBinding: s.modelBinding,
    pinnedAt: s.pinnedAt,
  };
}

// ---- sync.hello 协议版本与能力位（W2b-8） ----
//
// 为什么要有：0.1.1 的 hello 只交换 {nonce} / {mac, listenPort}，对端是哪一版、能收哪些数据种类都无从得知；
// 以后（W5c）加新的同步数据种类时，必须能分清对端是 0.1.1 还是更新的版本，才能做到「对端不声明就不推」。
// 所以 0.3.0 起两端在 hello 里多带 protocolVersion 与 caps，但规则是「缺失一律视为旧版」：
//   - 不带合法版本号（≥2 的整数）的一方就是 0.1.1 那一代，记为 {protocolVersion: 1, caps: {}}，它发来的 caps 一概不信；
//   - 更高的版本号不拒绝、未知能力位照记但不使用——按版本拒绝对端会让新旧设备互相断连；
//   - 这些字段不进 MAC（MAC 输入仍是 'm3c-hello'+nonce）：一旦并进 MAC，0.1.1 两个方向的互认都会失败。
//     F11C 订正：这里原写「同步本身走 ws:// 明文，绑进 MAC 也不增加实际防护」——自 W3-sec6 起 sync.hello 跑在加密通道
//     （remote/channel.ts）里，能力位受通道的 AEAD 保护；通道的可信度等于配对的可信度。
// 解析必须是纯同步计算：0.1.1 的发起端对 RPC 有 10s 超时。

/** 本端说的 sync 协议版本。0.1.1 不带这个字段，视为 1。新能力只加能力位，不抬版本号（版本号不用于拒绝对端）。 */
export const SYNC_PROTOCOL_VERSION = 2;

/**
 * 能力位登记表：各任务共用这一份声明，各自追加一行，名字须过 SYNC_CAP_NAME。
 * 查询：入站处理器里 peerHasCap(conn.syncPeer, SYNC_CAP.X)；出站 peerHasCap(outbound.peerInfo(fp), SYNC_CAP.X)。
 * 对端不声明就是不可用，不降级、不猜；旧构建对未知能力位「照记但不使用」，多一个能力位不影响互通。
 */
export const SYNC_CAP = Object.freeze({
  /** F11C：本端支持认证配对 v2。只用于「可重新配对升级」提示，不改变同步行为。 */
  PAIR_V2: 'pairV2',
  /** F11A：本端受理并使用 sync.att.manifest / get / put（附件协议第 1 版，sync/attachments/wire.ts）。
   *  附件协议以后有不兼容的修订，换一个新的能力位名字，不复用这个名字。 */
  ATTACHMENTS: 'attachments',
  /** F11B：本端能收发会话墓碑与生命周期版本。对端不声明就不向它发墓碑；它推来的已删会话一律拒收。 */
  TOMBSTONES: 'tombstones',
} as const);

/** 本端声明的能力位：SYNC_CAP 里本端已实现的各项，一行一个。冻结防止运行期被顺手改掉。 */
export const LOCAL_SYNC_CAPS: Readonly<Record<string, boolean>> = Object.freeze({
  [SYNC_CAP.PAIR_V2]: true,
  [SYNC_CAP.ATTACHMENTS]: true,
  [SYNC_CAP.TOMBSTONES]: true,
});

/** 从对端 hello 里解析出的声明。caps 只含值为 true 的能力位，查询一律走 peerHasCap。 */
export interface SyncPeerInfo {
  readonly protocolVersion: number;
  readonly caps: Readonly<Record<string, boolean>>;
}

/** 旧版（0.1.1）对端的缺省声明。整体冻结，可以放心共享同一个对象。 */
export const LEGACY_SYNC_PEER: SyncPeerInfo = Object.freeze({ protocolVersion: 1, caps: Object.freeze({}) });

/** 能力位键名：字母开头、字母数字下划线、最长 32 位——挡掉 __proto__ 一类的键和超长垃圾。 */
const SYNC_CAP_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** 最多记 32 个能力位：对端再多也只取前 32 个合法的，防止一条 hello 把 conn 撑大。 */
const MAX_SYNC_CAPS = 32;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * 把对端 hello 的请求参数（应答端）或响应（发起端）解析成 SyncPeerInfo。
 * 输入来自网络，按 unknown 处理；任何不合规的形状都退回旧版，绝不抛错（抛错会让互认失败、断连）。
 */
export function parseSyncHello(raw: unknown): SyncPeerInfo {
  if (!isPlainRecord(raw)) return LEGACY_SYNC_PEER;
  const v = raw.protocolVersion;
  // 没有合法版本号就是旧版：此时 caps 也一概忽略——旧版不会发 caps，发了也说明对端不按约定来
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 2) return LEGACY_SYNC_PEER;
  const caps: Record<string, boolean> = {};
  if (isPlainRecord(raw.caps)) {
    let n = 0;
    for (const [k, val] of Object.entries(raw.caps)) {
      if (n >= MAX_SYNC_CAPS) break;
      // 只认严格的 true：'true'、1 这类都不算，免得对端的笔误被当成承诺
      if (val !== true || !SYNC_CAP_NAME.test(k)) continue;
      caps[k] = true;
      n++;
    }
  }
  return { protocolVersion: v, caps: Object.freeze(caps) };
}

/** 对端是否声明了某个能力位。对端未知（undefined）一律 false；只看自有属性，constructor 之类原型上的名字不算。 */
export function peerHasCap(peer: SyncPeerInfo | undefined, name: string): boolean {
  if (!peer) return false;
  return Object.prototype.hasOwnProperty.call(peer.caps, name) && peer.caps[name] === true;
}

// ---- F11B 会话生命周期登记（墓碑与显式恢复） ----
//
// 为什么要有：以前删除只是物理删本机行，对端下一次对账就把会话推回来。现在每个会话至多一条登记 (v, opId)：
// v 为奇数 = 已删除（墓碑），偶数（≥2）= 删除后被显式恢复；没有登记等于 v = 0。各设备取全序最大值
// （v 大者胜，v 相同 opId 字典序小者胜），所以裁决与到达顺序、重复次数、两端时钟都无关。
// at 是发起端墙钟，只给人看和进审计，任何裁决都不读它。

/** 版本上限：挡掉对端发来的离谱数字；正常使用（删一次加一、恢复一次加一）到不了这里。 */
export const LIFECYCLE_MAX = 1_000_000;
/** 一条墓碑里最多带多少个消息 id；超过就不带列表（只带条数与摘要）。20000 个约 780KB，低于 sync.push 的 1MB 上限。 */
export const MAX_SEEN_IDS = 20_000;

/** 删除方在删除那一刻持有的消息 id 集合。ids 升序、去重；压实后或超过上限时没有 ids。
 *  digest = sha256(ids 按码元序升序、以 '\n' 连接、UTF-8 编码) 的小写十六进制。 */
export interface WireSeen { count: number; digest: string; ids?: string[] }

/** 一个会话的生命周期登记。从未删除过的会话不带这个字段。 */
export interface WireLifecycle {
  /** 奇数 = 已删除，偶数（≥2）= 删除后被显式恢复。 */
  v: number;
  /** 造成这个 v 的那次动作的 id（UUID 大写）。v 相同取 opId 字典序较小的那条。 */
  opId: string;
  /** 发起这次动作的设备指纹。 */
  originDeviceId: string;
  /** 发起端墙钟（epoch 秒）。只给人看和进审计，不参与任何裁决。 */
  at: number;
  /** 仅 v 为奇数时有意义。 */
  seen?: WireSeen;
}
export interface WireLifecycleHead { id: string; v: number; opId: string }

/** sync.push 的 payload、sync.pull 的返回。墓碑载荷 = { messages: [], markers: [], lifecycle（v 为奇数）}。 */
export interface SyncPayload {
  messages: WireMessage[]; markers: WireCompactMarker[]; session?: WireSession; lifecycle?: WireLifecycle;
}

const LIFECYCLE_OP_ID = /^[A-Za-z0-9-]{1,64}$/;
/** 首字符必须是字母数字：挡掉 __proto__ 一类的键。 */
const LIFECYCLE_DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SEEN_DIGEST = /^[0-9a-f]{64}$/;
const SEEN_ID_MAX_LEN = 128;

/** 落单的代理项（不成对的 U+D800..U+DFFF）。带 u 标志时成对的代理项算一个码点，不会被这条匹配到。 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Q12c：对端载荷里消息与摘要的 id 必须是 1..128 个码元、不含落单代理项的字符串；不合规的那一条在合并时丢弃
 * （ChatStore.mergeRemoteSession），同一个载荷里其余的照常合并。
 *
 * 为什么是这几条：id 是 messages / compact_markers / sync_orphan_markers 的主键，而这些形状进了库就不再是它自己——
 *  - null：主键挡不住 NULL。消息表里落下一条没有 id 的消息；摘要表里每合并一次多一行，而且每次都算「有变化」；
 *  - 数字：TEXT 列把 7 存成 '7.0'，与字符串 '7.0' 成了同一行，再拿 7 去比又对不上（孤儿摘要因此每次合并都重写并算「有变化」）；
 *  - 落单代理项：存成 UTF-8 时一律变成 U+FFFD，两个不同的 id 落成同一行；
 *  - 空串：别处把空串当「没有 id」（摘要的锚点是空串就等于没有锚点）。
 * 守约的对端发的是大写 UUID（36 个字符）；这里只卡形状、不卡字符集，免得误拒别的实现。
 * 长度上限与墓碑里 seen.ids 的单项上限是同一个数：再长的 id 进不了墓碑的 id 清单。
 */
export function isSyncId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= SEEN_ID_MAX_LEN && !LONE_SURROGATE.test(v);
}

function parseLifecycleVersion(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= LIFECYCLE_MAX ? v : undefined;
}

/** seen 不合规就整个丢弃；只有 ids 不合规时只丢 ids。丢弃的方向都是让接收端更保守（保留而不是清除）。 */
function parseWireSeen(raw: unknown): WireSeen | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const { count, digest, ids } = raw;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return undefined;
  if (typeof digest !== 'string' || !SEEN_DIGEST.test(digest)) return undefined;
  const seen: WireSeen = { count, digest };
  // 先看长度再逐个看：一个超长数组不值得遍历
  if (!Array.isArray(ids) || ids.length > MAX_SEEN_IDS || count > MAX_SEEN_IDS) return seen;
  const uniq = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length < 1 || id.length > SEEN_ID_MAX_LEN) return seen;
    uniq.add(id);
  }
  // 个数与 count 对不上的列表不可信：采信它可能把对方没见过的消息当成见过
  if (uniq.size !== count) return seen;
  seen.ids = [...uniq].sort();
  return seen;
}

/**
 * 把对端载荷里的 lifecycle 解析成 WireLifecycle。输入来自网络，按 unknown 处理，绝不抛错。
 * 顶层任何一项不合规返回 undefined，调用方按「不带版本」处理——垃圾输入不会被当成墓碑，也不会被当成恢复。
 */
export function parseWireLifecycle(raw: unknown): WireLifecycle | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const v = parseLifecycleVersion(raw.v);
  if (v === undefined) return undefined;
  const { opId, originDeviceId, at } = raw;
  if (typeof opId !== 'string' || !LIFECYCLE_OP_ID.test(opId)) return undefined;
  if (typeof originDeviceId !== 'string' || !LIFECYCLE_DEVICE_ID.test(originDeviceId)) return undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  const out: WireLifecycle = { v, opId, originDeviceId, at };
  if (v % 2 === 1) {
    const seen = parseWireSeen(raw.seen);
    if (seen) out.seen = seen;
  }
  return out;
}

/** { v, opId } 的解析（sync.list 的头清单用），规则同上；不合规返回 undefined。 */
export function parseLifecycleHead(raw: unknown): { v: number; opId: string } | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const v = parseLifecycleVersion(raw.v);
  if (v === undefined) return undefined;
  const { opId } = raw;
  if (typeof opId !== 'string' || !LIFECYCLE_OP_ID.test(opId)) return undefined;
  return { v, opId };
}
