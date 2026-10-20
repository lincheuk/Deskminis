/**
 * F11A · 真引擎（拨号方）× 脚本监听方：取回方向（sync.att.get）的故障注入。
 *
 * 受测端是 startMinisd 起的真引擎，它经真实配对加入脚本监听方（tests/att-listener-util.ts）、用自己的 OutboundClient
 * 经真实加密通道拨过去，消息同步走监听方真实的 sync.list / pull；只有 sync.att.* 的应答由脚本控制。
 * 覆盖 tests/att-sync-adversarial.test.ts（脚本对端作拨号方，put 方向）测不到的另一半：
 * 重复 / 错位的应答、取回方向的坏哈希、应答超出声明、清单应答里的穿越名字、断点续传、等应答期间用户取消、
 * 同一内容两个会话只取消一个、来源消失、没有附件同步的旧构建监听方。
 *
 * 每个故障用例末尾都核对：附件桶里没有这个文件、状态不是 ready、读不到、sync-incoming/ 里没有可当作完整文件的东西。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';
import { makeGate, makePng, sha256File, sha256Of, treeOf, waitFor } from './att-util';
import {
  bucketOf, expectNotComplete, imageUrlsOf, itemOf, mockOpenAI, newSession, partsIn, promptAndWait, seedFile, seedText, wsConnect,
  type MockOpenAI, type RpcClient,
} from './att-engines-util';
import { ScriptedListener } from './att-listener-util';

const CHUNK = 256 * 1024;
const MiB = 1024 * 1024;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

interface Rig<T> { parent: string; root: string; local: RpcClient; L: ScriptedListener; seeded: T }

/**
 * 一个脚本监听方（配对之前由 prepare 布置好会话、文件与脚本）加一个真引擎；真引擎经真实配对拨过去。
 * 引擎的数据根放在专用的父目录里，方便断言「数据根之外没有多出任何文件」。
 */
async function rig<T>(prepare: (L: ScriptedListener) => T, opts: { legacy?: boolean; mock?: MockOpenAI } = {}): Promise<Rig<T>> {
  const L = await ScriptedListener.start({ legacy: opts.legacy });
  cleanups.push(() => L.close());
  const seeded = prepare(L);
  const parent = mkdtempSync(join(tmpdir(), 'f11a-get-'));
  const root = join(parent, 'data');
  mkdirSync(root);
  writeFileSync(join(root, 'providers.json'), JSON.stringify({ providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }], defaultProviderId: '__fake__' }), 'utf8');
  await opts.mock?.seedCatalog(root);
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir: root, host: '127.0.0.1', port: 0 });
  const local = await wsConnect(`ws://127.0.0.1:${srv.port}/?token=${srv.authToken}`);
  cleanups.push(async () => {
    local.close();
    await srv.close();
    try { rmSync(parent, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
  });
  await L.pairWith(local);
  return { parent, root, local, L, seeded };
}

const stateOf = async (local: RpcClient, sid: string, name: string): Promise<string> => {
  const i = await itemOf(local, sid, name);
  return i ? `${i.state}/${i.reason ?? ''}` : '无';
};
const until = (local: RpcClient, sid: string, name: string, want: string, timeoutMs = 9000): Promise<unknown> =>
  waitFor(`${name} 的状态变成 ${want}`, async () => (await stateOf(local, sid, name)) === want, timeoutMs);
const partSize = (root: string): number => partsIn(root).find(p => p.name.endsWith('.part'))?.size ?? -1;

/** 让真引擎对这个会话再走一轮清单，并等这一轮的应答到达监听方（此时上一轮作业已经整个跑完：同一对端的作业是串行的）。 */
async function nextRound(L: ScriptedListener, sid: string): Promise<void> {
  const before = L.manifests(sid).length;
  L.dirty(sid);
  await waitFor('真引擎再发一轮清单', () => L.manifests(sid).length > before, 8000);
}
/** 连走两轮：第二轮的清单到达时，第一轮的应答已经被真引擎处理完。 */
async function settle(L: ScriptedListener, sid: string): Promise<void> {
  await nextRound(L, sid);
  await nextRound(L, sid);
}

describe('F11A 对抗（取回方向）：块与哈希', () => {
  it('基线：监听方按协议作答 → 真引擎的附件桶里出现文件，哈希相等；线路上的请求里没有任何本机路径', async () => {
    const data = makePng(600_000, 31).buf; const name = 'paste-31-aaaa1111.png';
    const r = await rig(L => L.addSession('监听方的会话', [{ name, data }]));
    const sid = r.seeded;
    await until(r.local, sid, name, 'ready/');
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(data));
    expect(r.L.gets(name).map(c => c.params.offset)).toEqual([0, CHUNK, 2 * CHUNK]);
    expect(partsIn(r.root)).toEqual([]);
    // 包住的全部 sync.att.* 请求：只有逻辑名与内容身份，没有数据根、没有盘符路径
    const wire = JSON.stringify(r.L.calls.map(c => c.params));
    expect(wire).not.toContain(JSON.stringify(r.root).slice(1, -1));
    expect(wire).not.toMatch(/[A-Za-z]:\\\\/);
    for (const c of r.L.calls) expect(Object.keys(c.params).filter(k => /path/i.test(k))).toEqual([]);
  });

  it('重复的应答（offset 与请求不符）：记失败 bad_chunk，删暂存，不再要下一块；重试后传完', async () => {
    const data = makePng(MiB, 32).buf; const name = 'paste-32-aaaa2222.png';
    const r = await rig(L => {
      // 第二次请求返回的是第一次的应答
      L.on.get = (p, nth) => nth === 2 ? L.honestGet({ ...p, offset: 0 }) : L.honestGet(p);
      return L.addSession('重复应答', [{ name, data }]);
    });
    const sid = r.seeded;
    await until(r.local, sid, name, 'failed/bad_chunk');
    expect(await itemOf(r.local, sid, name)).toMatchObject({ canRetry: true, localAvailable: false });
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    expect(partsIn(r.root)).toEqual([]);
    await settle(r.L, sid);
    expect(r.L.gets(name).map(c => c.params.offset)).toEqual([0, CHUNK]);        // 失败之后没有再要过
    r.L.on.get = undefined;
    expect((await r.local.call('attachments.retry', { sessionId: sid, name })).started).toBe(true);
    await until(r.local, sid, name, 'ready/');
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(data));
  });

  it('offset 对、数据是上一块的：收满后整文件校验不过，不发布、删暂存；第一次不记失败，再坏一次才记', async () => {
    const data = makePng(MiB, 33).buf; const name = 'paste-33-aaaa3333.png';
    const gate = makeGate(true);
    const r = await rig(L => {
      L.on.get = p => p.offset === CHUNK ? { ...(L.honestGet(p) as object), data: (L.honestGet({ ...p, offset: 0 }) as { data: string }).data } : L.honestGet(p);
      // 第二轮清单先扣住：第一轮之后的断言不与下一轮抢（合并回推之后真引擎自己也会再排一次作业）
      L.on.manifest = async (p, nth) => { if (nth >= 2) await gate.wait(); return L.honestManifest(p); };
      return L.addSession('错位的数据', [{ name, data }]);
    });
    const sid = r.seeded;
    // 四块都收了、暂存已删：这一轮的整文件校验已经失败
    await waitFor('第一轮收满并校验失败', () => r.L.gets(name).length === 4 && partsIn(r.root).length === 0, 9000);
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    expect((await itemOf(r.local, sid, name))?.state).not.toBe('failed');        // 第一次不记失败：还会自动再取一次
    gate.release();
    r.L.dirty(sid);
    await until(r.local, sid, name, 'failed/hash_mismatch');
    expect(r.L.gets(name)).toHaveLength(8);
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    expect(partsIn(r.root)).toEqual([]);
  });

  it('损坏的哈希：末块翻转一个字节，两轮之后记失败 hash_mismatch；发给模型的是「附件已丢失」而不是坏字节；重试后用正确内容传完', async () => {
    const mock = await mockOpenAI();
    cleanups.push(() => mock.close());
    const data = makePng(600_000, 34).buf; const name = 'paste-34-aaaa4444.png';
    const gate = makeGate(true);
    const r = await rig(L => {
      L.on.get = p => {
        const ok = L.honestGet(p) as { data: string };
        if (p.offset !== 2 * CHUNK) return ok;
        const bytes = Buffer.from(ok.data, 'base64'); bytes[bytes.length - 1] ^= 0x01;
        return { ...ok, data: bytes.toString('base64') };
      };
      // 第二轮清单先扣住：第一轮之后的断言不与下一轮抢
      L.on.manifest = async (p, nth) => { if (nth >= 2) await gate.wait(); return L.honestManifest(p); };
      return L.addSession('坏哈希', [{ name, data }]);
    }, { mock });
    const sid = r.seeded;
    await waitFor('第一轮收满并校验失败', () => r.L.gets(name).length === 3 && partsIn(r.root).length === 0, 9000);
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    gate.release();
    r.L.dirty(sid);                                                              // 再来一轮，还是坏的
    await until(r.local, sid, name, 'failed/hash_mismatch');
    expect(r.L.gets(name).map(c => c.params.offset)).toEqual([0, CHUNK, 2 * CHUNK, 0, CHUNK, 2 * CHUNK]);
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    expect(partsIn(r.root)).toEqual([]);
    expect(await itemOf(r.local, sid, name)).toMatchObject({ canRetry: true, localAvailable: false });

    // 这个会话里只有这一张图的引用：此时发模型请求，坏字节一个都不该出现在请求体里
    const inst = await r.local.call('provider.instances.create', { name: '收图片', kind: 'openai-compat', baseUrl: mock.api('vendor-a'), modelId: 'shared-model', apiKey: 'test-key' });
    const events = await promptAndWait(r.local, { sessionId: sid, text: '图里是什么', providerId: inst.id });
    expect(events.filter(ev => ev.kind === 'error')).toEqual([]);
    const requests = mock.hits.filter(h => h.url === '/vendor-a/v1/chat/completions');
    expect(requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests[0].body)).toContain(`[附件已丢失: ${name}]`);
    expect(requests.flatMap(q => imageUrlsOf(q.body))).toEqual([]);

    r.L.on.get = undefined;
    expect((await r.local.call('attachments.retry', { sessionId: sid, name })).started).toBe(true);
    await until(r.local, sid, name, 'ready/');
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(data));
  });

  it('应答超出声明：size 与清单不符、数据比这一块该有的多、数据超过一块——都记失败 bad_chunk，没有超过声明长度的暂存', async () => {
    const small = makePng(5000, 35).buf; const mid = makePng(600_000, 36).buf; const big = makePng(600_000, 37).buf;
    const names = { size: 'paste-35-bbbb1111.png', longer: 'paste-36-bbbb2222.png', huge: 'paste-37-bbbb3333.png' };
    const r = await rig(L => {
      L.on.get = p => {
        const ok = L.honestGet(p) as { size: number; data: string };
        if (p.name === names.size) return { ...ok, size: ok.size + 1 };
        // 这一块该是 CHUNK 字节，给了 CHUNK + 3；超过一块的 base64 连信封都不合规
        if (p.name === names.longer) return { ...ok, data: Buffer.concat([Buffer.from(ok.data, 'base64'), Buffer.from([1, 2, 3])]).toString('base64') };
        return { ...ok, data: Buffer.alloc(2 * CHUNK, 7).toString('base64') };
      };
      return [
        L.addSession('size 不符', [{ name: names.size, data: small }]),
        L.addSession('多三个字节', [{ name: names.longer, data: mid }]),
        L.addSession('多一整块', [{ name: names.huge, data: big }]),
      ];
    });
    const cases: Array<[string, string, Buffer]> = [[r.seeded[0], names.size, small], [r.seeded[1], names.longer, mid], [r.seeded[2], names.huge, big]];
    for (const [sid, name, data] of cases) {
      await until(r.local, sid, name, 'failed/bad_chunk');
      await expectNotComplete(r.root, r.local, sid, name, data.length);
      expect(r.L.gets(name), name).toHaveLength(1);
    }
    expect(partsIn(r.root)).toEqual([]);
  });

  it('断点续传：监听方在第三块上断开；重连后第一个 get 的 offset 等于已收长度，哈希相等', async () => {
    const data = makePng(MiB, 38).buf; const name = 'paste-38-cccc1111.png';
    const gate = makeGate(true);
    const r = await rig(L => {
      let dropped = false;
      L.on.get = p => {
        if (p.offset === 2 * CHUNK && !dropped) { dropped = true; L.dropConnections(); }
        return L.honestGet(p);
      };
      // 重连之后的清单先扣住：下面对「中断那一刻」的断言不与续传抢
      L.on.manifest = async (p, nth) => { if (nth >= 2) await gate.wait(); return L.honestManifest(p); };
      return L.addSession('续传', [{ name, data }]);
    });
    const sid = r.seeded;
    await waitFor('真引擎重连并重发清单', () => gate.waiting > 0, 12000);
    expect(partSize(r.root)).toBe(2 * CHUNK);
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    const seen = r.L.gets(name).length;
    expect(r.L.gets(name).map(c => [c.conn, c.params.offset])).toEqual([[1, 0], [1, CHUNK], [1, 2 * CHUNK]]);
    gate.release();
    await until(r.local, sid, name, 'ready/');
    const after = r.L.gets(name).slice(seen);
    expect(after[0].params.offset).toBe(2 * CHUNK);                               // 不是从头再来
    expect(after.every(c => c.conn > 1)).toBe(true);
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(data));
    expect(partsIn(r.root)).toEqual([]);
  });
});

describe('F11A 对抗（取回方向）：名字、取消、来源、旧构建', () => {
  it('清单应答里的穿越名字与没被引用的名字：条目被丢弃或被拒，没有发出任何 get，数据根内外都没有多出文件', async () => {
    const data = makePng(5000, 39).buf; const sha = sha256Of(data);
    const badNames: unknown[] = ['..\\..\\evil.png', '../x', 'a/b.png', 'C:evil', 'x.png:ads', 'CON.png', 'nul', '.hidden', 'x.', '', 'x\u0000y.png', 'n'.repeat(129), 42, null];
    const r = await rig(L => {
      L.on.manifest = () => ({
        v: 1, want: [], rejected: [], indexing: false,
        entries: [...badNames, 'unreferenced.png'].map(name => ({ name, size: data.length, sha256: sha, mimeType: 'image/png' })),
      });
      return L.addSession('穿越名字', [{ name: 'ok.png' }]);
    });
    const sid = r.seeded;
    const outside = (): string[] => treeOf(r.parent, rel => rel === 'data' || rel.startsWith('data/'));
    const before = outside();
    await waitFor('真引擎发过清单', () => r.L.manifests(sid).length > 0, 9000);
    await settle(r.L, sid);
    expect(r.L.gets()).toEqual([]);
    expect(outside()).toEqual(before);
    expect(treeOf(r.root).filter(l => /evil|\.\.|ads|hidden|unreferenced/i.test(l))).toEqual([]);
    expect(partsIn(r.root)).toEqual([]);
    expect(existsSync(join(bucketOf(r.root, sid), 'unreferenced.png'))).toBe(false);
  });

  it('等应答期间用户取消：状态是「未下载」而不是失败，这一块不写盘、暂存已删、不再要下一块；点下载后从头传完', async () => {
    const data = makePng(MiB, 40).buf; const name = 'paste-40-dddd1111.png';
    const gate = makeGate(true);
    const r = await rig(L => {
      let held = false;
      L.on.get = async p => {
        if (p.offset === 2 * CHUNK && !held) { held = true; await gate.wait(); }
        return L.honestGet(p);
      };
      return L.addSession('等应答时取消', [{ name, data }]);
    });
    const sid = r.seeded;
    await waitFor('第三块的应答被扣住', () => gate.waiting > 0, 9000);
    expect(partSize(r.root)).toBe(2 * CHUNK);
    expect(await r.local.call('attachments.cancel', { sessionId: sid, name })).toEqual({ ok: true });
    expect(partsIn(r.root)).toEqual([]);
    gate.release();
    await settle(r.L, sid);
    const item = await itemOf(r.local, sid, name);
    expect(item).toMatchObject({ state: 'held', canRetry: true, localAvailable: false });
    expect(item?.reason).toBeUndefined();
    expect(partsIn(r.root)).toEqual([]);                                          // 放行的那一块没有写盘
    expect(r.L.gets(name).map(c => c.params.offset)).toEqual([0, CHUNK, 2 * CHUNK]);
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    expect((await r.local.call('attachments.retry', { sessionId: sid, name })).started).toBe(true);
    await until(r.local, sid, name, 'ready/');
    expect(r.L.gets(name).slice(3).map(c => c.params.offset)).toEqual([0, CHUNK, 2 * CHUNK, 3 * CHUNK]);
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(data));
  });

  it('取消后立刻重试，再放行那个旧应答：始终不出现失败，最终就绪', async () => {
    const data = makePng(MiB, 41).buf; const name = 'paste-41-dddd2222.png';
    const gate = makeGate(true);
    const r = await rig(L => {
      let held = false;
      L.on.get = async p => {
        if (p.offset === 2 * CHUNK && !held) { held = true; await gate.wait(); }
        return L.honestGet(p);
      };
      return L.addSession('取消后立刻重试', [{ name, data }]);
    });
    const sid = r.seeded;
    await waitFor('第三块的应答被扣住', () => gate.waiting > 0, 9000);
    await r.local.call('attachments.cancel', { sessionId: sid, name });
    expect((await r.local.call('attachments.retry', { sessionId: sid, name })).started).toBe(true);
    gate.release();
    const seen: string[] = [];
    await waitFor(`${name} 就绪`, async () => {
      const s = await stateOf(r.local, sid, name);
      seen.push(s);
      return s === 'ready/';
    }, 9000);
    expect(seen.filter(s => s.startsWith('failed'))).toEqual([]);
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(data));
    expect(partsIn(r.root)).toEqual([]);
  });

  it('同一份内容两个会话都要、只取消其中一个：暂存留给另一个会话，它从已收的长度续传；被取消的那一行是「未下载」', async () => {
    const data = makePng(MiB, 42).buf; const sha = sha256Of(data);
    const names = ['paste-42-eeee1111.png', 'paste-42-eeee2222.png'];
    const r = await rig(L => {
      // 第一阶段：每个 get 都回一个瞬时错误——两行都建起来、都还要取，暂存还没有。
      // 这一阶段里真引擎重复排几次作业都一样（合并回推之后的那次推送也会再排一次），结果不变
      L.on.get = () => { throw new Error('脚本：这一次不给'); };
      return names.map((name, i) => L.addSession(`两个会话之${i + 1}`, [{ name, data }]));
    });
    const sids = r.seeded;
    for (const i of [0, 1]) await until(r.local, sids[i], names[i], 'pending/interrupted');
    expect(partsIn(r.root)).toEqual([]);

    // 第二阶段：照常作答。同一对端的作业是串行的，先跑到第三块的那个会话记作甲、扣住它的应答；
    // 另一个会话记作乙：扣住之后乙的第一个 get 也先扣住，好在「甲的作业已结束、乙还没开始写」的那一刻下断言
    const holdX = makeGate(true); const holdY = makeGate(true);
    let x = -1;
    const resumed: number[] = [];
    r.L.on.get = async p => {
      const i = names.indexOf(p.name);
      if (x === -1 && p.offset === 2 * CHUNK) { x = i; await holdX.wait(); }
      else if (x !== -1 && i !== x) { resumed.push(p.offset); if (resumed.length === 1) await holdY.wait(); }
      return r.L.honestGet(p);
    };
    for (const sid of sids) r.L.dirty(sid);
    await waitFor('先跑的那个会话第三块的应答被扣住', () => holdX.waiting > 0, 9000);
    const y = 1 - x;
    expect(partSize(r.root)).toBe(2 * CHUNK);
    await r.local.call('attachments.cancel', { sessionId: sids[x], name: names[x] });
    expect(partSize(r.root)).toBe(2 * CHUNK);                                     // 乙还要这份内容：暂存不删
    holdX.release();
    r.L.dirty(sids[y]);
    await waitFor('乙的第一个 get 到达', () => holdY.waiting > 0, 9000);
    // 甲的作业已结束：放行的那一块没有写盘，暂存长度没有减；乙从这个长度续传，不是从头
    expect(partSize(r.root)).toBe(2 * CHUNK);
    expect(resumed).toEqual([2 * CHUNK]);
    expect(await stateOf(r.local, sids[x], names[x])).toBe('held/');
    holdY.release();
    await until(r.local, sids[y], names[y], 'ready/');
    expect(resumed).toEqual([2 * CHUNK, 3 * CHUNK]);
    expect(sha256File(join(bucketOf(r.root, sids[y]), names[y]))).toBe(sha);
    expect(await stateOf(r.local, sids[x], names[x])).toBe('held/');
    expect(existsSync(join(bucketOf(r.root, sids[x]), names[x]))).toBe(false);    // 被取消的那一行没有被顺带发布
    expect(partsIn(r.root)).toEqual([]);
  });

  it('来源消失：对方说没有、下一轮清单也不再列它 → 「找不到来源」且可重试，不是等待同步；来源回来后重试传完', async () => {
    const data = makePng(600_000, 43).buf; const name = 'paste-43-ffff1111.png';
    const r = await rig(L => {
      // 回「没有」的同时就不再声明它：之后的每一轮清单都不列这一条（真引擎自己再排的作业也一样）
      L.on.get = p => { L.removeFile(p.sessionId, p.name); throw new Error('ATT_NOT_FOUND'); };
      return L.addSession('来源消失', [{ name, data }]);
    });
    const sid = r.seeded;
    await waitFor('第一次 get 被回了没有', () => r.L.gets(name).length === 1, 9000);
    await settle(r.L, sid);
    const gone = await itemOf(r.local, sid, name);
    expect(gone).toMatchObject({ state: 'unavailable', reason: 'no_source', canRetry: true, localAvailable: false });
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    expect(r.L.gets(name)).toHaveLength(1);
    r.L.on.get = undefined;
    r.L.setFile(sid, name, data);
    expect((await r.local.call('attachments.retry', { sessionId: sid, name })).started).toBe(true);
    await until(r.local, sid, name, 'ready/');
    expect(sha256File(join(bucketOf(r.root, sid), name))).toBe(sha256Of(data));
  });

  it('没有附件同步的旧构建监听方：消息照常同步，三个 sync.att.* 一次都没发，界面显示对方版本不支持', async () => {
    const data = makePng(5000, 44).buf; const name = 'paste-44-ffff2222.png';
    const r = await rig(L => L.addSession('旧构建上的会话', [{ name, data }]), { legacy: true });
    const sid = r.seeded;
    // 消息 id 序列照常收敛（拉）
    await waitFor('旧构建上的消息拉到了', async () => (await r.local.call('chat.messages.list', { sessionId: sid })).length === 1, 9000);
    expect((await r.local.call('chat.messages.list', { sessionId: sid })).map((m: any) => m.id)).toEqual(r.L.chat.listMessages(sid).map(m => m.id));
    // 真引擎自己也有一个带附件的会话要推：消息推得过去（推），附件一个字节都不发
    const mine = await newSession(r.local, '真引擎自己的附件');
    await seedFile(r.local, r.root, mine, 'real.png', makePng(5000, 45).buf, 'image/png');
    for (const text of ['再推一轮', '又推一轮']) {
      await seedText(r.local, sid, text);
      await waitFor(`旧构建收到「${text}」`, () => JSON.stringify(r.L.chat.listMessages(sid)).includes(text), 8000);
    }
    await waitFor('旧构建收到真引擎的会话', () => r.L.chat.listMessages(mine).length === 1, 8000);
    expect(r.L.probes).toEqual({ 'sync.att.manifest': 0, 'sync.att.get': 0, 'sync.att.put': 0 });
    expect(await itemOf(r.local, sid, name)).toMatchObject({ state: 'unavailable', reason: 'peer_unsupported', localAvailable: false });
    await expectNotComplete(r.root, r.local, sid, name, data.length);
    expect(partsIn(r.root)).toEqual([]);
  });
});
