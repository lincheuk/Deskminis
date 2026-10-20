/**
 * F11A · SyncCoordinator 与附件端口的接线（设计 §4.8）。假的 chat / rpc / outbound 与假的 AttachmentSyncPort，只看调用次序。
 *
 * 钉住的行为：
 *   - 推走完之后排附件作业，中途失败不排（消息没到，对端不会受理清单）；
 *   - 拉完（不论有没有变化）排附件作业；
 *   - 收到对端 sync.dirty：先 onRemoteDirty 再拉取（否则「已收敛」记号会把这次催促吞掉）；重连对账的拉取不调 onRemoteDirty；
 *   - 上线先 onPeerOnline 再对账；setPaused / stop / markDirty 透传；
 *   - 不注入端口时协调器照常工作。
 */
import { describe, it, expect } from 'vitest';
import { SyncCoordinator, type AttachmentSyncPort } from '../src/minisd/sync/coordinator';

const FP = 'peer-fp';
const tick = (): Promise<void> => new Promise(r => setImmediate(r));

function fixture(opts: { withPort?: boolean; pushFails?: boolean; batches?: number; hasChange?: boolean; remoteSessions?: string[] } = {}) {
  const log: string[] = [];
  const chat = {
    buildPushBatches: () => Array.from({ length: opts.batches ?? 2 }, (_, i) => ({ messages: [], markers: [], i })),
    getSessionCursor: () => ({ lastTs: 0 }),
    listSyncedSessions: () => [{ id: 'S1' }],
    mergeRemoteSession: () => { log.push('merge'); return { hasChange: opts.hasChange ?? false, mergedCount: 0, orphanMarkerIds: [] }; },
    // F11B：协调器现在还要问会话的生命周期登记。这份假 chat 里没有任何会话被删过
    isDeleted: () => false,
    getLifecycle: () => undefined,
    wireLifecycle: () => undefined,
    listTombstoneHeads: () => [],
  };
  const rpc = { broadcast: (m: string) => { log.push(`broadcast:${m}`); } };
  let pushes = 0;
  const outbound = {
    onRemoteDirty: undefined as undefined | ((fp: string, sid: string) => void),
    onOnline: undefined as undefined | ((fp: string) => void),
    start: () => { log.push('outbound.start'); },
    stop: () => { log.push('outbound.stop'); },
    dialedPeers: () => [FP],
    callRpc: async (_fp: string, method: string, params: any) => {
      log.push(`rpc:${method}`);
      if (method === 'sync.push') { pushes++; if (opts.pushFails && pushes === 2) throw new Error('连接断开'); return { hasChange: true }; }
      if (method === 'sync.list') return { sessions: (opts.remoteSessions ?? ['R1']).map(id => ({ id })) };
      if (method === 'sync.pull') return { messages: [], markers: [], sessionId: params.sessionId };
      return {};
    },
  };
  const port: AttachmentSyncPort = {
    markDirty: sid => { log.push(`att.markDirty:${sid}`); },
    onPeerOnline: fp => { log.push(`att.onPeerOnline:${fp}`); },
    onRemoteDirty: (fp, sid) => { log.push(`att.onRemoteDirty:${fp}:${sid}`); },
    schedule: (fp, sid) => { log.push(`att.schedule:${fp}:${sid}`); },
    setPaused: p => { log.push(`att.setPaused:${p}`); },
    stop: () => { log.push('att.stop'); },
  };
  const coord = new SyncCoordinator(chat as never, rpc as never, {
    debounceMs: 1, outbound: outbound as never, ...(opts.withPort === false ? {} : { attachments: port }),
  });
  return { coord, log, outbound };
}

describe('F11A 协调器 × 附件端口', () => {
  it('onDirty 透传 markDirty；推走完之后才排附件作业', async () => {
    const f = fixture({ batches: 2 });
    f.coord.start();
    f.coord.onDirty('S1');
    expect(f.log).toContain('att.markDirty:S1');
    await f.coord.flush();
    await tick(); await tick();
    const pushes = f.log.filter(l => l === 'rpc:sync.push').length;
    expect(pushes).toBe(2);
    expect(f.log.indexOf(`att.schedule:${FP}:S1`)).toBeGreaterThan(f.log.lastIndexOf('rpc:sync.push'));
    expect(f.log.filter(l => l.startsWith('att.schedule'))).toEqual([`att.schedule:${FP}:S1`]);
  });

  it('推到一半失败：不排附件作业', async () => {
    const f = fixture({ batches: 3, pushFails: true });
    f.coord.start();
    f.coord.onDirty('S1');
    await f.coord.flush();
    await tick(); await tick();
    expect(f.log.filter(l => l === 'rpc:sync.push')).toHaveLength(2);
    expect(f.log.some(l => l.startsWith('att.schedule'))).toBe(false);
  });

  it('收到对端 sync.dirty：先 onRemoteDirty，再拉取，拉完（合并没有变化也）排附件作业', async () => {
    const f = fixture({ hasChange: false });
    f.coord.start();
    f.outbound.onRemoteDirty!(FP, 'R9');
    await tick(); await tick();
    const seq = f.log.filter(l => l.startsWith('att.') || l === 'rpc:sync.pull' || l === 'merge');
    expect(seq).toEqual([`att.onRemoteDirty:${FP}:R9`, 'rpc:sync.pull', 'merge', `att.schedule:${FP}:R9`]);
  });

  it('上线：先 onPeerOnline 再对账；对账里的拉取不调 onRemoteDirty，推与拉完成后各排一次附件作业', async () => {
    const f = fixture({ batches: 1, remoteSessions: ['R1'] });
    f.coord.start();
    f.outbound.onOnline!(FP);
    await tick(); await tick(); await tick();
    expect(f.log.indexOf(`att.onPeerOnline:${FP}`)).toBeGreaterThanOrEqual(0);
    expect(f.log.indexOf(`att.onPeerOnline:${FP}`)).toBeLessThan(f.log.findIndex(l => l.startsWith('rpc:')));
    expect(f.log.some(l => l.startsWith('att.onRemoteDirty'))).toBe(false);
    expect(f.log.filter(l => l.startsWith('att.schedule')).sort()).toEqual([`att.schedule:${FP}:R1`, `att.schedule:${FP}:S1`]);
  });

  it('setPaused 与 stop 透传；附件的停止排在关出站连接之前', () => {
    const f = fixture();
    f.coord.start();
    f.coord.setPaused(true);
    f.coord.setPaused(false);
    expect(f.log.filter(l => l.startsWith('att.setPaused'))).toEqual(['att.setPaused:true', 'att.setPaused:false']);
    f.coord.stop();
    expect(f.log.indexOf('att.stop')).toBeGreaterThan(0);
    expect(f.log.indexOf('att.stop')).toBeLessThan(f.log.indexOf('outbound.stop'));
    // 停了之后的 onDirty 不再透传
    const n = f.log.length;
    f.coord.onDirty('S1');
    expect(f.log.length).toBe(n);
  });

  it('不注入端口：推、拉、对账照常，不出现任何附件调用', async () => {
    const f = fixture({ withPort: false, batches: 1 });
    f.coord.start();
    f.coord.onDirty('S1');
    await f.coord.flush();
    f.outbound.onRemoteDirty!(FP, 'R9');
    f.outbound.onOnline!(FP);
    await tick(); await tick(); await tick();
    expect(f.log.some(l => l.startsWith('att.'))).toBe(false);
    expect(f.log.filter(l => l === 'rpc:sync.push').length).toBeGreaterThanOrEqual(2);
    expect(f.log).toContain('rpc:sync.pull');
    f.coord.stop();
  });
});
