/**
 * F11A · 组件级（tests/att-node-util.ts 的 bootAttNode）：需要在两端内部挂闸门、调小时限与配额才测得到的路径。
 *
 * 两个节点都是真库、真 ChatStore、真配对、真 RpcServer / OutboundClient / SyncCoordinator / 附件引擎，
 * 字节经真实的加密通道传；块长缩到 1 KiB（两端一起缩），几千字节的文件就有好几块。
 * 时序全部靠闸门与条件等待：io.verify / io.hash 的闸门、处理器前后的拦截器、发送源 readChunk 外面包的闸门。
 *
 * 覆盖：未校验不发布；提交途中取消配对 / 暂停（票不泄漏，恢复后从保留的暂存直接发布）；等应答期间取消配对 / 暂停；
 * 读盘期间暂停 / 取消配对；调用超时；会话配额；两端互拨；登记预算；同名不同内容且尚未登记；清单早于消息到达；
 * 线路上没有任何一端的本机路径；本机去重期间取消配对 / 暂停（处理器对外抛对应的码，不发布）；
 * 交换过清单的会话里新到的引用在清单处理之前是「等待同步」（两个方向）；本机删掉会话之后不再送出、不再受理、不再发布。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeGate, makePng, sha256File, sha256Of, waitFor } from './att-util';
import { bootAttNode, pairNodes, type AttNode, type NodeCall } from './att-node-util';
import type { AttachmentLimits } from '../src/minisd/sync/attachments';

const CHUNK = 1024;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function node(name: string, limits: Partial<AttachmentLimits> = {}): Promise<AttNode> {
  const n = await bootAttNode({ name, limits: { chunkBytes: CHUNK, ...limits } });
  cleanups.push(() => n.close());
  return n;
}

/** D 拨 L。 */
async function pair2(limitsD: Partial<AttachmentLimits> = {}, limitsL: Partial<AttachmentLimits> = {}): Promise<{ D: AttNode; L: AttNode }> {
  const D = await node('D', limitsD);
  const L = await node('L', limitsL);
  await pairNodes(D, L);
  return { D, L };
}

const until = (n: AttNode, sid: string, name: string, want: string, timeoutMs = 9000): Promise<unknown> =>
  waitFor(`${n.name} 上 ${name} 的状态变成 ${want}`, async () => (await n.state(sid, name)) === want, timeoutMs);

const partName = (data: Buffer): string => `${sha256Of(data)}.${data.length}.part`;

/** 没有任何可以被当作完整附件的东西：最终路径不存在、状态不是 ready、读不到、没有 .stage。（提交阶段中止时 .part 可以是完整长度。） */
async function expectNotPublished(n: AttNode, sid: string, name: string): Promise<void> {
  expect(existsSync(join(n.bucket(sid), name)), `${n.name} 的最终路径上不该有文件`).toBe(false);
  const item = await n.item(sid, name);
  expect(item?.state).not.toBe('ready');
  expect(item?.localAvailable ?? false).toBe(false);
  await expect(n.local.call('attachments.read', { sessionId: sid, name })).rejects.toThrow('附件尚未同步到本机');
  expect(n.incoming().filter(f => f.name.endsWith('.stage'))).toEqual([]);
}

/** 这次调用已经有了结果（应答或错误）。 */
const settledCall = (c: { result?: unknown; error?: string } | undefined): boolean => !!c && (c.result !== undefined || c.error !== undefined);

describe('F11A 组件级：基线与线路内容', () => {
  it('双向各传一个文件，哈希相等；全部 sync.att.* 的参数与应答里没有任何一端的数据根、没有盘符路径', async () => {
    const { D, L } = await pair2();
    const sid = D.newSession('双向');
    const a = makePng(5000, 51).buf; const b = makePng(4000, 52).buf;
    D.addFile(sid, 'from-d.png', a);
    await until(L, sid, 'from-d.png', 'ready/');
    L.addFile(sid, 'from-l.png', b);
    await until(D, sid, 'from-l.png', 'ready/');
    expect(sha256File(join(L.bucket(sid), 'from-d.png'))).toBe(sha256Of(a));
    expect(sha256File(join(D.bucket(sid), 'from-l.png'))).toBe(sha256Of(b));
    expect(D.dir).not.toBe(L.dir);
    // D 是拨号方：全部 sync.att.* 都由 L 受理，L 的记录里有每一次的参数（D 给的）与应答（L 给的）
    const att = L.calls.filter(c => c.method.startsWith('sync.att.'));
    expect(att.some(c => c.method === 'sync.att.put') && att.some(c => c.method === 'sync.att.get')).toBe(true);
    const wire = JSON.stringify(att.map(c => [c.params, c.result, c.error]));
    for (const dir of [D.dir, L.dir]) expect(wire).not.toContain(JSON.stringify(dir).slice(1, -1));
    expect(wire).not.toContain('f11a-node-');
    expect(wire).not.toMatch(/[A-Za-z]:\\\\/);
    expect(wire).not.toMatch(/"(path|relativePath|localPath)"/);
  });
});

describe('F11A 组件级：未校验不发布；提交途中取消配对、暂停', () => {
  /** D 上有文件、L 来收；L 的整文件校验停在闸门上（此时最后一块已经写入暂存）。 */
  async function atVerify(seed: number): Promise<{ D: AttNode; L: AttNode; sid: string; name: string; data: Buffer }> {
    const { D, L } = await pair2();
    const sid = D.newSession('提交');
    const data = makePng(5000, seed).buf; const name = `paste-${seed}-c0ffee00.png`;
    L.gates.verify.close();
    D.addFile(sid, name, data);
    await L.gates.verify.entered();
    expect(L.incoming()).toEqual([{ name: partName(data), size: data.length }]);
    await expectNotPublished(L, sid, name);
    return { D, L, sid, name, data };
  }

  it('未校验不发布：最后一块写入之后、整文件校验放行之前，最终路径不存在、读不到；放行后才出现', async () => {
    const { L, sid, name, data } = await atVerify(53);
    L.gates.verify.release();
    await until(L, sid, name, 'ready/');
    expect(sha256File(join(L.bucket(sid), name))).toBe(sha256Of(data));
    expect(L.incoming()).toEqual([]);
  });

  it('提交途中取消配对：这次 put 抛 ATT_CANCELLED，不发布；重新配对后不再传字节，从保留的暂存校验并发布', async () => {
    const { D, L, sid, name, data } = await atVerify(54);
    await L.local.call('remote.unpair', { peerFingerprint: D.fp });
    L.gates.verify.release();
    await waitFor('最后一次 put 有了结果', () => settledCall(L.attCalls('put').at(-1)));
    expect(L.attCalls('put').at(-1)).toMatchObject({ error: 'ATT_CANCELLED' });
    expect(L.attCalls('put').at(-1)?.result).toBeUndefined();
    await expectNotPublished(L, sid, name);
    expect(L.incoming()).toEqual([{ name: partName(data), size: data.length }]);  // 票已撤，暂存还在、没有 .stage
    const puts = L.attCalls('put').length;
    await pairNodes(D, L);
    await until(L, sid, name, 'ready/');
    expect(sha256File(join(L.bucket(sid), name))).toBe(sha256Of(data));
    expect(L.attCalls('put').length).toBe(puts);                                  // 下一次受理没有回 busy，也没有重传
    expect(L.incoming()).toEqual([]);
  });

  it('提交途中暂停：这次 put 抛 ATT_PAUSED，不发布；恢复后不再传字节，从保留的暂存校验并发布', async () => {
    const { L, sid, name, data } = await atVerify(55);
    L.pause();
    L.gates.verify.release();
    await waitFor('最后一次 put 有了结果', () => settledCall(L.attCalls('put').at(-1)));
    expect(L.attCalls('put').at(-1)).toMatchObject({ error: 'ATT_PAUSED' });
    await expectNotPublished(L, sid, name);
    expect(await L.state(sid, name)).toBe('paused/');
    expect(L.incoming()).toEqual([{ name: partName(data), size: data.length }]);
    const puts = L.attCalls('put').length;
    await L.resume();
    await until(L, sid, name, 'ready/');
    expect(sha256File(join(L.bucket(sid), name))).toBe(sha256Of(data));
    expect(L.attCalls('put').length).toBe(puts);
    expect(L.incoming()).toEqual([]);
  });
});

describe('F11A 组件级：取回方向的复查（等应答期间、读盘期间）', () => {
  /** L 上有文件、D 来取；L 把第三块的应答算好之后扣住不回。此时 D 已经写下两块。 */
  async function replyHeld(seed: number): Promise<{ D: AttNode; L: AttNode; sid: string; name: string; data: Buffer; release(): void }> {
    const { D, L } = await pair2();
    const sid = L.newSession('取回');
    const data = makePng(5000, seed).buf; const name = `paste-${seed}-beef0000.png`;
    const gate = makeGate(true);
    let n = 0;
    L.intercept['sync.att.get'] = async (_p, next) => { const r = await next(); if (++n === 3) await gate.wait(); return r; };
    L.addFile(sid, name, data);
    await waitFor('第三块的应答被扣住', () => gate.waiting > 0);
    expect(D.incoming()).toEqual([{ name: partName(data), size: 2 * CHUNK }]);
    return { D, L, sid, name, data, release: () => gate.release() };
  }

  it('等应答期间取消配对：放行的那一块不写盘，暂存长度不变，没有完整文件', async () => {
    const { D, L, sid, name, data, release } = await replyHeld(56);
    await D.local.call('remote.unpair', { peerFingerprint: L.fp });
    release();
    await D.att.idle();
    expect(D.incoming()).toEqual([{ name: partName(data), size: 2 * CHUNK }]);
    await expectNotPublished(D, sid, name);
  });

  it('等应答期间暂停：放行的那一块不写盘；恢复后从已收的长度续传完成', async () => {
    const { D, L, sid, name, data, release } = await replyHeld(57);
    D.pause();
    release();
    await D.att.idle();
    expect(D.incoming()).toEqual([{ name: partName(data), size: 2 * CHUNK }]);
    await expectNotPublished(D, sid, name);
    expect(await D.state(sid, name)).toBe('paused/');
    const seen = L.attCalls('get').length;
    await D.resume();
    await until(D, sid, name, 'ready/');
    expect(L.attCalls('get')[seen].params.offset).toBe(2 * CHUNK);
    expect(sha256File(join(D.bucket(sid), name))).toBe(sha256Of(data));
  });

  /** L 上有文件、D 来取；L 读第二块的盘读完之后停在闸门上（应答还没发出）。 */
  async function readHeld(seed: number): Promise<{ D: AttNode; L: AttNode; sid: string; name: string; release(): void }> {
    const { D, L } = await pair2();
    const sid = L.newSession('读盘');
    const data = makePng(5000, seed).buf; const name = `paste-${seed}-feed0000.png`;
    const gate = makeGate(true);
    let n = 0;
    const store = L.att.store as unknown as { readChunk: (...a: unknown[]) => Promise<unknown> };
    const readChunk = store.readChunk.bind(store);
    store.readChunk = async (...a: unknown[]) => { const r = await readChunk(...a); if (++n === 2) await gate.wait(); return r; };
    L.addFile(sid, name, data);
    await waitFor('第二块读完后停在闸门上', () => gate.waiting > 0);
    return { D, L, sid, name, release: () => gate.release() };
  }

  it('读盘期间暂停：应答是 ATT_PAUSED 而不是数据；拨号方显示对方暂停，没有完整文件', async () => {
    const { D, L, sid, name, release } = await readHeld(58);
    L.pause();
    release();
    await waitFor('第二次 get 有了结果', () => settledCall(L.attCalls('get')[1]));
    expect(L.attCalls('get')[1]).toMatchObject({ error: 'ATT_PAUSED' });
    expect(L.attCalls('get')[1].result).toBeUndefined();
    await until(D, sid, name, 'pending/peer_paused');
    await expectNotPublished(D, sid, name);
    expect(D.incoming().map(f => f.size)).toEqual([CHUNK]);
  });

  it('读盘期间取消配对：应答是 ATT_CANCELLED 而不是数据', async () => {
    const { D, L, sid, name, release } = await readHeld(59);
    await L.local.call('remote.unpair', { peerFingerprint: D.fp });
    release();
    await waitFor('第二次 get 有了结果', () => settledCall(L.attCalls('get')[1]));
    expect(L.attCalls('get')[1]).toMatchObject({ error: 'ATT_CANCELLED' });
    expect(L.attCalls('get')[1].result).toBeUndefined();
    await D.att.idle();
    await expectNotPublished(D, sid, name);
    expect(D.incoming().map(f => f.size)).toEqual([CHUNK]);
  });
});

describe('F11A 组件级：超时、配额、并发', () => {
  it('调用超时（chunkTimeoutMs = 300）：对方不应答时拨号方放弃这一次，状态是「传输中断」，暂存保留；之后续传完成', async () => {
    const { D, L } = await pair2({ chunkTimeoutMs: 300 });
    const sid = L.newSession('超时');
    const data = makePng(5000, 60).buf; const name = 'paste-60-0badf00d.png';
    const gate = makeGate(true);
    let n = 0;
    // 第二个 get 起一律扣在处理之前（放行之后不再扣）
    L.intercept['sync.att.get'] = async (_p, next) => { if (++n >= 2) await gate.wait(); return next(); };
    L.addFile(sid, name, data);
    await until(D, sid, name, 'pending/interrupted');
    expect(D.incoming()).toEqual([{ name: partName(data), size: CHUNK }]);
    await expectNotPublished(D, sid, name);
    gate.release();
    L.dirty(sid);
    await until(D, sid, name, 'ready/');
    const offsets = L.attCalls('get').map(c => c.params.offset as number);
    expect(offsets.filter(o => o === 0)).toHaveLength(1);                         // 没有从头再来
    expect([...new Set(offsets)].sort((x, y) => x - y)).toEqual([0, CHUNK, 2 * CHUNK, 3 * CHUNK, 4 * CHUNK]);
    expect(sha256File(join(D.bucket(sid), name))).toBe(sha256Of(data));
  });

  it('会话配额（注入小值）：超出的那一个被拒 quota，没有为它产生暂存，也没有收它的任何一块', async () => {
    const D = await node('D');
    const L = await node('L', { sessionQuotaBytes: 9000 });
    const sid = D.newSession('配额');
    const files = [61, 62, 63].map(seed => ({ name: `paste-${seed}-quota000.png`, data: makePng(4000, seed).buf }));
    for (const f of files) D.addFile(sid, f.name, f.data);
    await pairNodes(D, L);
    await waitFor('三条一起声明的那份清单有了应答', () => L.attCalls('manifest').some(c => c.params.entries.length === 3 && settledCall(c)));
    const m = L.attCalls('manifest').find(c => c.params.entries.length === 3)!;
    expect(m.result.want).toHaveLength(2);
    expect(m.result.rejected).toHaveLength(1);
    expect(m.result.rejected[0].code).toBe('quota');
    const over = m.params.entries[m.result.rejected[0].index].name as string;
    for (const f of files.filter(x => x.name !== over)) await until(L, sid, f.name, 'ready/');
    expect(await L.item(sid, over)).toMatchObject({ state: 'unavailable', reason: 'quota', localAvailable: false });
    expect(L.attCalls('put').filter(c => c.params.name === over)).toEqual([]);
    await expectNotPublished(L, sid, over);
    expect(L.incoming()).toEqual([]);
  });

  it('两端互拨：同一份内容只有一张票在写，收下的块数恰好是文件的块数，最终哈希相等', async () => {
    const A = await node('A');
    const B = await node('B');
    await pairNodes(A, B, { mutual: true });
    const sid = A.newSession('互拨');
    const data = makePng(8 * CHUNK, 64).buf; const name = 'paste-64-0ddba11.png';
    A.addFile(sid, name, data);
    await until(B, sid, name, 'ready/');
    expect(sha256File(join(B.bucket(sid), name))).toBe(sha256Of(data));
    await A.att.idle(); await B.att.idle();
    // A 作拨号方送（put，B 受理）与 B 作拨号方取（get，A 受理）两条路都通；字节只该经其中一条走一遍
    const putOk = B.attCalls('put').filter(c => c.result !== undefined).length;
    const getOk = A.attCalls('get').filter(c => c.result !== undefined).length;
    expect(putOk + getOk).toBe(8);
    expect(B.incoming()).toEqual([]);
  });
});

describe('F11A 组件级：登记预算与触发次序', () => {
  it('登记预算：本机文件的哈希还没算完时，清单应答是 indexing 且三个列表都空，库里没有新行、没有暂存；拨号方稍后重试，放行后完成', async () => {
    const D = await node('D', { indexRetryMs: 150 });
    const L = await node('L', { indexBudgetMs: 100 });
    const sid = L.newSession('登记预算');
    const data = makePng(5000, 65).buf; const name = 'paste-65-1dea0000.png';
    L.gates.hash.close();
    L.addFile(sid, name, data);
    await pairNodes(D, L);
    const indexing = (): number => L.attCalls('manifest').filter(c => c.result?.indexing === true).length;
    await waitFor('拨号方重试过一次，两次都还在登记', () => indexing() >= 2);
    for (const c of L.attCalls('manifest').filter(x => settledCall(x))) {
      expect(c.result).toEqual({ v: 1, entries: [], want: [], rejected: [], indexing: true });
    }
    expect(L.db.prepare('SELECT COUNT(*) n FROM sync_attachments').get()).toEqual({ n: 0 });
    expect(L.incoming()).toEqual([]);
    expect(D.incoming()).toEqual([]);
    expect(L.attCalls('get')).toEqual([]);
    L.gates.hash.release();
    L.dirty(sid);                                                                 // 重试次数用完也不影响下面的断言
    await until(D, sid, name, 'ready/');
    expect(sha256File(join(D.bucket(sid), name))).toBe(sha256Of(data));
  });

  it('本机有同名、内容不同、尚未登记的文件：登记完之前不受理；登记完后本机先有的为准，对端得到 name_conflict，不产生暂存', async () => {
    const D = await node('D', { indexRetryMs: 150 });
    const L = await node('L', { indexBudgetMs: 100 });
    await pairNodes(D, L);
    const sid = D.newSession('同名未登记');
    const mine = makePng(4000, 66).buf; const theirs = makePng(5000, 67).buf; const name = 'same-name.png';
    const gate = makeGate(true);
    L.intercept['sync.att.manifest'] = async (_p, next) => { await gate.wait(); return next(); };
    D.addFile(sid, name, theirs);
    await waitFor('拨号方的清单到了监听方（消息已先到）', () => gate.waiting > 0);
    L.putFile(sid, name, mine);                                                   // 监听方本机先有了同名文件，还没登记
    L.gates.hash.close();
    gate.release();
    await waitFor('第一份清单的应答是 indexing', () => L.attCalls('manifest').some(c => c.result?.indexing === true));
    expect(L.attCalls('manifest').find(c => settledCall(c))!.result).toEqual({ v: 1, entries: [], want: [], rejected: [], indexing: true });
    expect(L.incoming()).toEqual([]);
    L.gates.hash.release();
    L.dirty(sid);
    await waitFor('登记完之后的清单得到 name_conflict', () =>
      L.attCalls('manifest').some(c => c.result?.rejected?.some((x: { code: string }) => x.code === 'name_conflict')));
    expect(L.attCalls('manifest').every(c => (c.result?.want ?? []).length === 0)).toBe(true);
    expect(sha256File(join(L.bucket(sid), name))).toBe(sha256Of(mine));
    expect(await L.item(sid, name)).toMatchObject({ state: 'ready', conflict: true, sha256: sha256Of(mine) });
    expect(L.attCalls('put')).toEqual([]);
    expect(L.incoming()).toEqual([]);
  });

  it('清单早于消息到达：第一轮得到 not_referenced，不记收敛；消息到了之后同一条连接上再发一轮清单并传完', async () => {
    const { D, L } = await pair2();
    const sid = D.newSession('清单早于消息');
    D.addText(sid, '先同步一条文本');
    await waitFor('文本到了监听方', () => L.chat.listMessages(sid).length === 1);
    const gate = makeGate(true);
    L.intercept['sync.push'] = async (_p, next) => { await gate.wait(); return next(); };
    const data = makePng(5000, 68).buf; const name = 'paste-68-ea51e000.png';
    D.addFile(sid, name, data);
    await waitFor('带附件的那条消息的推送被扣住', () => gate.waiting > 0);
    const before = L.attCalls('manifest').length;
    L.dirty(sid);                                                                 // 拨号方拉（拉到的还是旧消息），拉完排附件作业
    await waitFor('清单先于消息到达并得到应答', () => settledCall(L.attCalls('manifest')[before]));
    const early = L.attCalls('manifest')[before];
    expect(early.params.entries.map((e: { name: string }) => e.name)).toEqual([name]);
    expect(early.result).toMatchObject({ want: [], rejected: [{ index: 0, code: 'not_referenced' }] });
    await expectNotPublished(L, sid, name);
    expect(L.incoming()).toEqual([]);
    gate.release();
    await until(L, sid, name, 'ready/');
    const later = L.attCalls('manifest').slice(before + 1).find(c => c.result?.want?.length === 1);
    expect(later, '消息到了之后又发了一轮清单并拿到 want').toBeDefined();
    expect(later!.conn).toBe(early.conn);
    expect(new Set(L.calls.map(c => c.conn)).size).toBe(1);                       // 没有经过重连
    expect(sha256File(join(L.bucket(sid), name))).toBe(sha256Of(data));
  });
});

describe('F11A 组件级：本机去重期间取消配对 / 暂停（经引擎的清单处理器）', () => {
  /** L 的另一个会话里已有同内容的完成文件。D 的清单带来两条：一条内容相同（L 走本机去重，复制停在闸门上），一条是新内容。
   *  清单按名字升序：dupFirst 决定去重那一条排在前面还是后面——
   *  排在前面时，放行之后处理器在受理下一条之前的复查处停下；排在后面时，在清单末尾的复查处停下。 */
  async function atDedupeCopy(seed: number, dupFirst: boolean): Promise<{ D: AttNode; L: AttNode; sid: string; dup: string; other: string; same: Buffer; fresh: Buffer; call: NodeCall }> {
    const { D, L } = await pair2();
    const same = makePng(5000, seed).buf; const fresh = makePng(4000, seed + 100).buf;
    const s0 = L.newSession('去重来源');
    L.addFile(s0, 'src.png', same);
    await until(D, s0, 'src.png', 'ready/');
    expect(await L.state(s0, 'src.png')).toBe('ready/');                          // L 上已登记成 present：去重有来源
    await D.att.idle(); await L.att.idle();
    const sid = D.newSession('去重目标');
    const dup = dupFirst ? 'a-dup.png' : 'z-dup.png';
    const other = dupFirst ? 'z-new.png' : 'a-new.png';
    L.gates.copy.close();
    D.addFile(sid, dup, same);
    D.addFile(sid, other, fresh);
    await L.gates.copy.entered();                                                 // 去重的本机复制停在入口：校验与发布都还没做
    expect(existsSync(join(L.bucket(sid), dup))).toBe(false);
    // 正停在闸门上的那一次清单调用（拨号方同一时刻只有一个作业，此刻最后一条就是它）。之后暂停期间再来的清单在入口就被拒，不是这一条
    const call = L.attCalls('manifest').filter(c => c.params.sessionId === sid).at(-1)!;
    expect(call.params.entries.map((e: { name: string }) => e.name)).toEqual([dup, other].sort());
    expect(settledCall(call)).toBe(false);
    return { D, L, sid, dup, other, same, fresh, call };
  }

  for (const dupFirst of [true, false]) {
    const where = dupFirst ? '去重那一条在前：停在受理下一条之前的复查' : '去重那一条在后：停在清单末尾的复查';

    it(`去重的本机复制途中取消配对（${where}）：清单应答是 ATT_CANCELLED，不发布，行仍 missing，没有暂存`, async () => {
      const { D, L, sid, dup, other, call } = await atDedupeCopy(dupFirst ? 80 : 81, dupFirst);
      await L.local.call('remote.unpair', { peerFingerprint: D.fp });
      L.gates.copy.release();
      await waitFor('那份清单有了结果', () => settledCall(call));
      expect(call).toMatchObject({ error: 'ATT_CANCELLED' });
      expect(call.result).toBeUndefined();
      await L.att.idle();
      expect(existsSync(join(L.bucket(sid), dup))).toBe(false);
      expect(existsSync(join(L.bucket(sid), other))).toBe(false);
      expect(L.att.store.get(sid, dup)).toMatchObject({ state: 'missing' });
      // 排在去重之后的那一条：取消配对之后不再受理，连行都没有建
      if (dupFirst) expect(L.att.store.get(sid, other)).toBeUndefined();
      expect(L.incoming()).toEqual([]);                                           // 没有 .stage，也没有收任何一块
      expect(L.attCalls('put').filter(c => c.params.sessionId === sid)).toEqual([]);
    });

    it(`去重的本机复制途中暂停（${where}）：清单应答是 ATT_PAUSED，不发布；恢复后本机复制完成，不走网络`, async () => {
      const { L, sid, dup, other, same, fresh, call } = await atDedupeCopy(dupFirst ? 82 : 83, dupFirst);
      L.pause();
      L.gates.copy.release();
      await waitFor('那份清单有了结果', () => settledCall(call));
      expect(call).toMatchObject({ error: 'ATT_PAUSED' });
      expect(call.result).toBeUndefined();
      await L.att.idle();
      expect(existsSync(join(L.bucket(sid), dup))).toBe(false);
      expect(existsSync(join(L.bucket(sid), other))).toBe(false);
      expect(L.att.store.get(sid, dup)).toMatchObject({ state: 'missing' });
      if (dupFirst) expect(L.att.store.get(sid, other)).toBeUndefined();
      expect(await L.state(sid, dup)).toBe('paused/');
      expect(L.incoming()).toEqual([]);
      await L.resume();
      await until(L, sid, dup, 'ready/');
      await until(L, sid, other, 'ready/');
      expect(sha256File(join(L.bucket(sid), dup))).toBe(sha256Of(same));
      expect(sha256File(join(L.bucket(sid), other))).toBe(sha256Of(fresh));
      expect(L.attCalls('put').filter(c => c.params.name === dup)).toEqual([]);   // 相同内容始终没有经网络传
      expect(L.attCalls('put').some(c => c.params.name === other)).toBe(true);
    });
  }
});

describe('F11A 组件级：清单处理之前的状态（新到的引用）', () => {
  it('已交换过清单的会话里新到的附件（监听方）：列出它的清单还没处理时是「等待同步」，没有重试也没有取消；处理后传完', async () => {
    const { D, L } = await pair2();
    const sid = D.newSession('新引用');
    const one = makePng(3000, 84).buf; const two = makePng(4000, 85).buf;
    D.addFile(sid, 'one.png', one);
    await until(L, sid, 'one.png', 'ready/');                                     // 这个会话在这条连接上已经交换过清单
    const gate = makeGate(true);
    // 只扣列出 two.png 的清单；别的清单照常在到达的那一刻处理
    L.intercept['sync.att.manifest'] = async (p, next) => {
      if ((p.entries as Array<{ name: string }>).some(e => e.name === 'two.png')) await gate.wait();
      return next();
    };
    D.addFile(sid, 'two.png', two);
    await waitFor('带 two.png 的消息到了监听方，列出它的清单被扣住', async () => gate.waiting > 0 && (await L.item(sid, 'two.png')) !== undefined);
    const held = await L.item(sid, 'two.png');
    expect(held).toMatchObject({ state: 'pending', reason: 'queued', canRetry: false, canCancel: false, localAvailable: false });
    // 这时调取消没有东西可记：不建行、状态不变（这个状态在界面上没有取消按钮）
    expect(await L.local.call('attachments.cancel', { sessionId: sid, name: 'two.png' })).toEqual({ ok: true });
    expect(L.att.store.get(sid, 'two.png')).toBeUndefined();
    expect(await L.item(sid, 'two.png')).toEqual(held);
    gate.release();
    await until(L, sid, 'two.png', 'ready/');
    expect(sha256File(join(L.bucket(sid), 'two.png'))).toBe(sha256Of(two));
  });

  it('已交换过清单的会话里新到的附件（拨号方）：问对端的那份清单还没有应答时是「等待同步」；应答回来后取完', async () => {
    const { D, L } = await pair2();
    const sid = L.newSession('新引用·取回');
    const one = makePng(3000, 86).buf; const three = makePng(4000, 87).buf;
    L.addFile(sid, 'one.png', one);
    await until(D, sid, 'one.png', 'ready/');                                     // 拨号方与对端已经交换过这个会话的清单
    await D.att.idle();
    const gate = makeGate(true);
    let hold = false;
    L.intercept['sync.att.manifest'] = async (_p, next) => { if (hold) await gate.wait(); return next(); };
    hold = true;
    L.addFile(sid, 'three.png', three);
    await waitFor('带 three.png 的消息到了拨号方，它发出的清单被对端扣住', async () => gate.waiting > 0 && (await D.item(sid, 'three.png')) !== undefined);
    expect(await D.item(sid, 'three.png')).toMatchObject({ state: 'pending', reason: 'queued', canRetry: false, canCancel: false, localAvailable: false });
    gate.release();
    await until(D, sid, 'three.png', 'ready/');
    expect(sha256File(join(D.bucket(sid), 'three.png'))).toBe(sha256Of(three));
  });
});

describe('F11A 组件级：本机删掉会话之后（不重启）', () => {
  /** 拨号方合并之后的那次回推已经走完：之后没有别的推送会把监听方删掉的会话带回来。 */
  const pushedBack = (L: AttNode, sid: string): Promise<unknown> => waitFor('拨号方的回推已经走完', () =>
    L.calls.some(c => c.method === 'sync.push' && c.params?.sessionId === sid && (c.params?.payload?.messages?.length ?? 0) > 0 && settledCall(c)));

  it('对端来取这个会话的附件：ATT_NOT_FOUND，不再给字节（删除之前同一个请求拿得到）', async () => {
    const { D, L } = await pair2();
    const sid = L.newSession('要删的会话');
    const data = makePng(3000, 88).buf; const name = 'paste-88-de1e7e00.png';
    L.addFile(sid, name, data);
    await until(D, sid, name, 'ready/');
    await pushedBack(L, sid);
    await D.att.idle(); await L.att.idle();
    const get = (): Promise<unknown> => D.outbound.callRpc(L.fp, 'sync.att.get', { v: 1, sessionId: sid, name, sha256: sha256Of(data), offset: 0 });
    expect(await get()).toMatchObject({ v: 1, offset: 0, size: 3000 });
    L.chat.deleteSession(sid);                                                    // chat.sessions.delete 调的就是它：不经 onDirty
    expect(L.chat.getSession(sid)).toBeUndefined();
    await expect(get()).rejects.toThrow('ATT_NOT_FOUND');
    expect(L.attCalls('get').at(-1)).toMatchObject({ error: 'ATT_NOT_FOUND' });
    expect(L.attCalls('get').at(-1)!.result).toBeUndefined();
    expect(await L.local.call('attachments.status', { sessionId: sid })).toMatchObject({ items: [] });
    // 只是不再同步：文件不删
    expect(sha256File(join(L.bucket(sid), name))).toBe(sha256Of(data));
  });

  it('在途的 put 跨过删除：下一块得到 ATT_CANCELLED，暂存不再增长，文件不出现', async () => {
    const { D, L } = await pair2();
    const sid = D.newSession('收到一半被删');
    const data = makePng(5000, 89).buf; const name = 'paste-89-de1e7e01.png';
    const gate = makeGate(true);
    let n = 0;
    L.intercept['sync.att.put'] = async (_p, next) => { if (++n === 3) await gate.wait(); return next(); };
    D.addFile(sid, name, data);
    await waitFor('第三块停在处理之前', () => gate.waiting > 0);
    expect(L.incoming()).toEqual([{ name: partName(data), size: 2 * CHUNK }]);
    L.chat.deleteSession(sid);
    gate.release();
    await waitFor('第三次 put 有了结果', () => settledCall(L.attCalls('put')[2]));
    expect(L.attCalls('put')[2]).toMatchObject({ error: 'ATT_CANCELLED' });
    await D.att.idle();
    expect(L.attCalls('put')).toHaveLength(3);
    expect(existsSync(join(L.bucket(sid), name))).toBe(false);
    expect(L.incoming()).toEqual([{ name: partName(data), size: 2 * CHUNK }]);
  });

  for (const at of ['verify', 'copy'] as const) {
    it(`提交途中会话被删（停在${at === 'verify' ? '整文件校验' : '发布前的复制'}上）：这次 put 是 ATT_CANCELLED，不发布，暂存不留`, async () => {
      const { D, L } = await pair2();
      const sid = D.newSession('提交途中被删');
      const data = makePng(5000, at === 'verify' ? 90 : 91).buf; const name = `paste-${at}-de1e7e02.png`;
      L.gates[at].close();
      D.addFile(sid, name, data);
      await L.gates[at].entered();
      expect(L.incoming().some(f => f.name === partName(data) && f.size === data.length)).toBe(true);   // 已经收满
      L.chat.deleteSession(sid);
      L.gates[at].release();
      await waitFor('最后一次 put 有了结果', () => settledCall(L.attCalls('put').at(-1)));
      expect(L.attCalls('put').at(-1)).toMatchObject({ error: 'ATT_CANCELLED' });
      expect(L.attCalls('put').at(-1)!.result).toBeUndefined();
      await L.att.idle();
      expect(existsSync(join(L.bucket(sid), name))).toBe(false);
      expect(L.att.store.get(sid, name)?.state).not.toBe('present');
      expect(L.incoming()).toEqual([]);
    });
  }
});
