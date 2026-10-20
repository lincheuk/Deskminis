/**
 * F11A · 接线与边界的源码守卫。
 *
 * 行为由 att-sync-*.test.ts 的真引擎用例测；这里钉的是「不该出现的东西」：
 *   - 附件字节只走现有加密通道上的 RPC：sync/attachments/ 下不许出现任何自己开端口、自己连网的写法；
 *   - 线格式里没有路径字段；
 *   - 把行置成 present 的写入只有一处，且只被「登记（刚算过哈希）」与「校验后的发布」两条路调用；
 *   - 装配处把端口交给了协调器、把 onPeerHello 交给了 sync.hello、两组方法都包了业务守卫。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_SYNC_CAPS, SYNC_CAP, SYNC_PROTOCOL_VERSION } from '../src/minisd/sync/wire';
import { createSyncMethods } from '../src/minisd/sync/rpc';
import { callMark } from './engine-trace';
import { expectSame } from './engine-trace';

const SRC = join(__dirname, '..', 'src', 'minisd');
const ATT = join(SRC, 'sync', 'attachments');
const read = (p: string): string => readFileSync(p, 'utf8');
const attFiles = readdirSync(ATT).filter(f => f.endsWith('.ts'));

describe('F11A 接线守卫', () => {
  it('能力位：登记在 SYNC_CAP 里、本端声明了它；协议版本号不变', () => {
    expect(SYNC_CAP.ATTACHMENTS).toBe('attachments');
    expect(LOCAL_SYNC_CAPS.attachments).toBe(true);
    expect(SYNC_PROTOCOL_VERSION).toBe(2);
  });

  it('sync/attachments/ 下没有任何自己开端口、自己连网的写法（不另开下载端口、不走 HTTP）', () => {
    expect(attFiles.sort()).toEqual(['engine.ts', 'index.ts', 'io.ts', 'limits.ts', 'receiver.ts', 'rpc.ts', 'store.ts', 'wire.ts']);
    const banned = ['createServer', 'WebSocketServer', 'new WebSocket(', '.listen(', 'node:http', 'node:https', 'node:net', 'node:dgram', 'fetch(', "from 'ws'"];
    for (const f of attFiles) {
      const src = read(join(ATT, f));
      for (const b of banned) expect(src.includes(b), `${f} 里出现了 ${b}`).toBe(false);
    }
  });

  it('线格式没有路径字段：wire.ts 里不出现 path / relativePath / localPath 标识符', () => {
    const src = read(join(ATT, 'wire.ts'));
    expect(src).not.toMatch(/\b(relativePath|localPath|linuxPath|absPath)\b/);
    expect(src).not.toMatch(/\bpath\b/i);
  });

  it('把行置成 present 的写入只在 store.ts 的 writePresent 里；它只被登记与 publishVerified 调用', () => {
    const presentWrite = /SET\s+state\s*=\s*'present'|VALUES\s*\([^)]*'present'/;
    for (const f of attFiles) {
      if (f === 'store.ts') continue;
      expect(presentWrite.test(read(join(ATT, f))), `${f} 里有写 present 的 SQL`).toBe(false);
    }
    const store = read(join(ATT, 'store.ts'));
    const at = (needle: string): number => { const i = store.indexOf(needle); expect(i, `找不到 ${needle}`).toBeGreaterThan(0); return i; };
    const writeStart = at('private writePresent(');
    const writeEnd = at('private setState(');
    const hashedStart = at('private applyHashed(');
    const hashedEnd = at('async acceptRemote(');
    const publishStart = at('async publishVerified(');
    const publishEnd = at('private localStat(');
    // SQL 只在 writePresent 的函数体里
    const sqlHits = [...store.matchAll(new RegExp(presentWrite.source, 'g'))].map(m => m.index!);
    expect(sqlHits.length).toBeGreaterThan(0);
    for (const i of sqlHits) expect(i > writeStart && i < writeEnd, `store.ts 第 ${i} 字符处在 writePresent 之外写 present`).toBe(true);
    // 调用点只在「登记拿到哈希之后」与「publishVerified」两个函数体里
    const calls = [...store.matchAll(/this\.writePresent\(/g)].map(m => m.index!);
    expect(calls.length).toBeGreaterThan(1);
    for (const i of calls) {
      const inHashed = i > hashedStart && i < hashedEnd;
      const inPublish = i > publishStart && i < publishEnd;
      expect(inHashed || inPublish, `store.ts 第 ${i} 字符处在登记与发布之外调用 writePresent`).toBe(true);
    }
    // 其它改状态的入口在类型上就写不了 present
    expect(store).toMatch(/private setState\(row: AttachmentRow, state: 'missing' \| 'failed'/);
    // 发布只收 VerifiedFile（只有 io.verify 能造）
    expect(store).toMatch(/async publishVerified\(row: AttachmentRow, staged: VerifiedFile\)/);
    expect(read(join(ATT, 'io.ts')).match(/as VerifiedFile/g)).toHaveLength(1);
  });

  it('sync.att.* 没有混进 createSyncMethods（它的键集被别的测试钉住）；附件方法另开工厂', () => {
    expect(read(join(SRC, 'sync', 'rpc.ts'))).not.toContain('sync.att.');
    const keys = Object.keys(createSyncMethods({} as never));
    expect(keys.some(k => k.startsWith('sync.att.') || k.startsWith('attachments.'))).toBe(false);
    const rpc = read(join(ATT, 'rpc.ts'));
    for (const m of ['sync.att.manifest', 'sync.att.get', 'sync.att.put', 'attachments.status', 'attachments.retry', 'attachments.cancel', 'attachments.read']) {
      expect(rpc).toContain(`'${m}'`);
    }
    // 本机方法体内都先断言 local
    expect(rpc.match(/assertAuthMode\(conn, \['local'\], 'attachments\.(status|retry|cancel|read)',/g)).toHaveLength(4);
  });

  it('对端处理器开头的四道闸顺序固定：加密的 remote 连接 → 能力位 → 关停 → 暂停', () => {
    const engine = read(join(ATT, 'engine.ts'));
    const body = engine.slice(engine.indexOf('private enter(conn: RpcConnection)'), engine.indexOf('onPeerHello(peerFp'));
    const order = ['ATT_CHANNEL_REQUIRED', 'ATT_CAP_REQUIRED', 'ATT_STOPPING', 'ATT_PAUSED'].map(c => body.indexOf(c));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain("conn.authMode !== 'remote'");
    expect(body).toContain('conn.encrypted !== true');
    for (const h of ['handleManifest', 'handleGet', 'handlePut']) {
      const start = engine.indexOf(`async ${h}(`);
      expect(engine.slice(start, start + 260), `${h} 的第一句必须是 enter(conn)`).toMatch(/\{\s*const fp = this\.enter\(conn\);/);
    }
  });

  it('minisd/index.ts：端口交给协调器、onPeerHello 交给 sync.hello、两组方法均受业务守卫；RpcServer 只有一个', async () => {
    // Q20：不读 index.ts 的文本，起一台真实引擎看它装配出来的东西（engine-wiring.ts / engine-assembly.ts）
    const { watchEngine } = await import('./engine-wiring');
    const { accessResult, probeConnection, startCapturedEngine } = await import('./engine-assembly');
    const w = watchEngine();
    const eng = await startCapturedEngine();
    try {
      // 协调器拿到的附件端口，就是这台引擎建的那个附件同步的端口
      const attachmentSync = w.made<{ port: { stop(): void }; onPeerHello(fp: string | undefined, peer: unknown): void }>('createAttachmentSync');
      expect(w.count('createAttachmentSync')).toBe(1);
      expect(w.count('new SyncCoordinator')).toBe(1);
      expect(w.args('new SyncCoordinator')[2].attachments).toBe(attachmentSync.port);
      // sync.hello 的 onPeerHello 转给附件侧：调引擎交给 createSyncMethods 的那个回调，附件侧原样收到
      const hello = w.spy('attachments.onPeerHello');
      const peer = { protocolVersion: 2, caps: { attachments: true } };
      const callback = w.args('createSyncMethods')[1].onPeerHello;
      for (const fp of ['FP-HELLO', undefined]) {
        const from = callMark();
        const result = callback(fp, peer);
        expect(w.count('attachments.onPeerHello', from)).toBe(1);
        expect(w.args('attachments.onPeerHello')).toEqual([fp, peer]);
        expectSame(w.args('attachments.onPeerHello')[1], peer);
        expectSame(hello.mock.contexts.at(-1), attachmentSync);
        expect(result).toBe(hello.mock.results.at(-1)?.value);
        if (fp === 'FP-HELLO') expect(hello.mock.calls).toEqual([['FP-HELLO', peer]]);
      }

      const names = ['sync.att.manifest', 'sync.att.get', 'sync.att.put', 'attachments.status', 'attachments.retry', 'attachments.cancel', 'attachments.read'];
      for (const name of names) {
        expect(eng.methods[name], name).toBeTypeOf('function');
        expect(await accessResult(eng.methods[name], name, probeConnection('pairing')), name).toEqual({ allowed: false, error: `${name} 在 pairing 模式下不可用（配对期仅可调 remote.pair.complete）` });
      }
      const fp = await eng.pair();
      await eng.unpair(fp);
      for (const name of names) {
        let closed = false;
        expect(await accessResult(eng.methods[name], name, probeConnection('remote', () => { closed = true; }, fp)), name).toEqual({ allowed: false, error: `${name} 被拒：这台设备已取消配对` });
        expect(closed, name).toBe(true);
      }
      // 这台引擎只建了一个 RpcServer、只监听一次（附件不另开服务）
      expect(eng.servers).toBe(1);
      expect(w.count('rpc.listen')).toBe(1);
      // 附件的停止经协调器转发：关停时协调器只停一次，附件端口也只被停一次，而且是在协调器停的时候
      const portStop = w.spy('attachments.stop');
      await eng.close();
      expect(w.count('sync.stop')).toBe(1);
      expect(portStop.mock.calls).toHaveLength(1);
      expect(w.seq(['sync.stop', 'attachments.stop'])).toEqual(['sync.stop', 'attachments.stop']);
      expect(portStop.mock.calls).toEqual([[]]);
      expect(portStop.mock.contexts[0]).toBe(attachmentSync.port);
    } finally {
      await eng.close();
      vi.restoreAllMocks();
    }
    const coord = read(join(SRC, 'sync', 'coordinator.ts'));
    for (const call of ['markDirty(sessionId)', 'setPaused(paused)', 'schedule(peerFp, sid)', 'onRemoteDirty(peerFp, sid)', 'onPeerOnline(peerFp)', 'stop()']) {
      expect(coord, `协调器里缺 attachments?.${call}`).toContain(`this.attachments?.${call}`);
    }
  }, 60000);

  it('rpc/server.ts：连接对象带 encrypted，只在有 cipher 时为真', () => {
    const server = read(join(SRC, 'rpc', 'server.ts'));
    expect(server).toContain('readonly encrypted?: boolean;');
    expect(server.match(/encrypted: cipher !== undefined/g)).toHaveLength(1);
    // 纯追加：赋值单独成行，不与既有的那一行字段写在一起（别的任务也在改那一行，写在一起必然合并冲突）
    expect(server).toMatch(/\n[ \t]+encrypted: cipher !== undefined,\n/);
    expect(server).toMatch(/\n[ \t]+authMode, peerFingerprint, remoteAddress,[^\n]*\n/);
    expect(server).not.toMatch(/authMode, peerFingerprint, remoteAddress,[^\n]*encrypted/);
  });
});
