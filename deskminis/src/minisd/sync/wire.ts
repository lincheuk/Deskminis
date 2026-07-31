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
