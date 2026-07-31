import type { CompactMarker, RawMessage } from '../../shared/types';
import { fromWireMessage, resolveWireMarker, type WireCompactMarker, type WireMessage } from './wire';

export interface MergeInput {
  messages: RawMessage[];
  markers: CompactMarker[];
}
export interface WireMergeInput {
  messages: WireMessage[];
  markers: WireCompactMarker[];
}
export interface MergeResult {
  messages: RawMessage[];
  markers: CompactMarker[];
  orphanMarkerIds: string[];
}

/**
 * 合并本地与远端会话数据（设计 §1-M3b / §4.4）。
 * 单次 O(N log N)（去重 O(N) + k 路归并 O(N log k)，k ≤ 5）。
 *
 * 红线：
 *  - raw history 追加型永不改写——id 重复时保留 local（信任本端已落库）
 *  - sortOrder 只是本地展示索引，合并后按统一序重排
 *  - marker 锚换算必须在 k 路归并后做（§4.4 时序关键）
 *  - orphan marker 不入 compact_markers（评审命门 2）——只返回 orphanMarkerIds，由 mergeRemoteSession 落 sync_orphan_markers
 */
export function mergeSession(local: MergeInput, remote: WireMergeInput): MergeResult {
  // 1. 三路去重（id 为准），重复时保留 local
  const byId = new Map<string, RawMessage>();
  for (const m of local.messages) byId.set(m.id, m);
  for (const w of remote.messages) {
    if (!byId.has(w.id)) {
      byId.set(w.id, fromWireMessage(w) as RawMessage);
    }
  }

  // 2. k 路归并（评审命门 1）：按 originDeviceId 分流，流内 createdLocallyAt 升序，流间归并按流头 ts
  //    平局用 (originDeviceId 字典序, id 字典序) 决出确定性——保证两端独立调用结果逐位一致。
  const streams = new Map<string, RawMessage[]>();
  for (const m of byId.values()) {
    const origin = m.originDeviceId ?? 'legacy';
    const arr = streams.get(origin);
    if (arr) arr.push(m); else streams.set(origin, [m]);
  }
  // 流内排序（稳定：createdLocallyAt 升序，平局 id 字典序）
  for (const arr of streams.values()) {
    arr.sort((a, b) => {
      const ta = a.createdLocallyAt ?? a.createdAt;
      const tb = b.createdLocallyAt ?? b.createdAt;
      if (ta !== tb) return ta - tb;
      return a.id < b.id ? -1 : 1;
    });
  }
  // k 路归并：用最小堆（实测 k ≤ 5，简单线性扫流头即可，O(N·k) ≈ O(N log k) 当 k 小）
  const heads: { origin: string; msg: RawMessage }[] = [];
  const streamArr = Array.from(streams.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1); // 流间按 origin 字典序（仅影响平局时取流顺序）
  const cursors = new Map<string, number>();
  for (const [origin, arr] of streamArr) {
    cursors.set(origin, 0);
    heads.push({ origin, msg: arr[0] });
  }
  const merged: RawMessage[] = [];
  while (heads.length > 0) {
    // 找流头 ts 最小者；平局用 (origin 字典序, id 字典序)
    let pickIdx = 0;
    for (let i = 1; i < heads.length; i++) {
      const a = heads[pickIdx].msg, b = heads[i].msg;
      const ta = a.createdLocallyAt ?? a.createdAt;
      const tb = b.createdLocallyAt ?? b.createdAt;
      if (ta !== tb) { if (tb < ta) pickIdx = i; continue; }
      // 平局：origin 字典序
      if (heads[i].origin < heads[pickIdx].origin) { pickIdx = i; continue; }
      if (heads[i].origin > heads[pickIdx].origin) continue;
      // 仍平局：id 字典序
      if (b.id < a.id) pickIdx = i;
    }
    const picked = heads[pickIdx];
    merged.push(picked.msg);
    const arr = streams.get(picked.origin)!;
    const next = (cursors.get(picked.origin) ?? 0) + 1;
    cursors.set(picked.origin, next);
    if (next < arr.length) {
      heads[pickIdx] = { origin: picked.origin, msg: arr[next] };
    } else {
      heads.splice(pickIdx, 1);
    }
  }

  // 3. sortOrder 按合并后顺序重排（0,1,2,...）
  merged.forEach((m, i) => { m.sortOrder = i; });

  // 4. marker LWW：id 重复取 createdAt 较晚者；同 createdAt local 优先
  const byMarkerId = new Map<string, { marker: CompactMarker; createdAt: number; isLocal: boolean }>();
  for (const m of local.markers) {
    byMarkerId.set(m.id, { marker: m, createdAt: m.createdAt, isLocal: true });
  }
  // remote markers 先转 wire → resolveWireMarker（在 merged 上回算）→ 再 LWW
  const orphanMarkerIds: string[] = [];
  const resolvedRemote: CompactMarker[] = [];
  for (const w of remote.markers) {
    const { marker, isOrphan } = resolveWireMarker(w, merged);
    if (isOrphan) orphanMarkerIds.push(marker.id);
    resolvedRemote.push(marker);
  }
  for (const m of resolvedRemote) {
    const existing = byMarkerId.get(m.id);
    if (!existing) {
      byMarkerId.set(m.id, { marker: m, createdAt: m.createdAt, isLocal: false });
    } else {
      // LWW：createdAt 较晚者胜；同 createdAt local 优先
      if (m.createdAt > existing.createdAt) {
        byMarkerId.set(m.id, { marker: m, createdAt: m.createdAt, isLocal: false });
      }
      // 否则保留 existing（local 优先）
    }
  }

  return {
    messages: merged,
    markers: Array.from(byMarkerId.values()).map(x => x.marker),
    orphanMarkerIds,
  };
}
