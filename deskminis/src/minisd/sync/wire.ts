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
//   - 这些字段不进 MAC（MAC 输入仍是 'm3c-hello'+nonce）：一旦并进 MAC，0.1.1 两个方向的互认都会失败，
//     而同步本身走 ws:// 明文，绑进 MAC 也不增加实际防护（中间人能剥掉 caps，后果只是少推数据）。
// 解析必须是纯同步计算：0.1.1 的发起端对 RPC 有 10s 超时。

/** 本端说的 sync 协议版本。0.1.1 不带这个字段，视为 1。 */
export const SYNC_PROTOCOL_VERSION = 2;

/** 本端声明的能力位。0.3.0 没有新的数据种类，所以是空的；第一个能力位留给 W5c。冻结防止运行期被顺手改掉。 */
export const LOCAL_SYNC_CAPS: Readonly<Record<string, boolean>> = Object.freeze({});

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
