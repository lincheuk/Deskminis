/**
 * F04 资源锁表（tools/resource-locks.ts）与路径身份：冲突矩阵、先到先得、整组授予、取消、跨会话等待超时。
 *
 * 超时类用例一律用 fake timers 推进时间（锁管理器的 now 缺省取 Date.now，一并被接管）：
 * 断言的是「推进到某一刻时谁已经落定、谁还在等」，不断言真实耗时，全量并行跑也不会偶发失败。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import {
  ResourceLockManager, claimKey, claimsOverlap, requestsConflict,
  type LockClaim, type LockResult,
} from '../src/minisd/tools/resource-locks';
import { planCall } from '../src/minisd/tools/scheduler';
import { pathIdentity } from '../src/minisd/tools/data-gate';
import { MinisPaths } from '../src/minisd/paths';
import type { ToolExecutor } from '../src/minisd/tools/types';

afterEach(() => { vi.useRealTimers(); });

type Mode = 'read' | 'write';
/** posix 形态的 path claim（纯数据，不碰文件系统）。 */
const P = (p: string, mode: Mode): LockClaim => ({ ns: 'path', root: '/', segs: p.split('/').filter(s => s !== ''), mode, display: p });
const S = (sid: string, mode: Mode): LockClaim => ({ ns: 'session', key: sid, mode, display: '本会话的工具队列' });
const N = (name: string, mode: Mode): LockClaim => ({ ns: 'named', key: name, mode, display: name });

/** 这个 acquire 此刻落定了没有：落定返回结果，否则 'pending'。入队与授予都是同步的，不需要先让出事件循环。 */
function peek(p: Promise<LockResult>): Promise<LockResult | 'pending'> {
  return Promise.race([p, Promise.resolve('pending' as const)]);
}
async function granted(p: Promise<LockResult>): Promise<Extract<LockResult, { ok: true }>> {
  const r = await peek(p);
  if (r === 'pending' || !r.ok) throw new Error(`应当已拿到锁，实际: ${r === 'pending' ? '还在等' : r.reason}`);
  return r;
}

describe('L1 路径身份：换写法得到的是同一把锁', () => {
  const paths = new MinisPaths('C:\\f04-root');
  const tool: ToolExecutor = {
    definition: { name: 'w', description: '', parameters: {}, required: [] },
    scheduling: {
      readOnly: false, concurrencySafe: true, sideEffects: 'local-files',
      resources: input => [{ kind: 'path', mode: 'write', path: String(input.path) }],
    },
    async execute() { return { output: '', success: true }; },
  };
  const keyOf = (p: string, realpath: (p: string) => string): string => {
    const plan = planCall(tool, { path: p }, { sessionId: 'S', paths }, { platform: 'win32', realpath });
    const claim = plan.claims.find(c => c.ns === 'path');
    if (!claim) throw new Error(`没有 path claim: ${p}`);
    return claimKey(claim);
  };
  const identity = (p: string): string => p;

  it('win32：大小写、正反斜杠、.. 段、尾点、ADS 流名经 planCall 得到同一个键', () => {
    const base = keyOf('C:\\X\\Foo.txt', identity);
    for (const alias of ['c:\\x\\FOO.TXT', 'C:/X/foo.txt', 'C:\\X\\sub\\..\\foo.txt', 'C:\\X\\foo.txt.', 'C:\\X\\foo.txt::$DATA']) {
      expect(keyOf(alias, identity), alias).toBe(base);
    }
    // 不是把所有路径都折成一个键
    expect(keyOf('C:\\X\\Foo2.txt', identity)).not.toBe(base);
    expect(keyOf('D:\\X\\Foo.txt', identity)).not.toBe(base);
  });

  it('注入 realpath：8.3 短名与 junction 路径同键；文件不存在时尾段拼回，与存在时同键', () => {
    const table = (exists: Record<string, string>) => (p: string): string => {
      const hit = exists[p];
      if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return hit;
    };
    const dirs = { 'C:\\': 'C:\\', 'C:\\X': 'C:\\X', 'C:\\X\\LongName': 'C:\\X\\LongName', 'C:\\X\\LONGNA~1': 'C:\\X\\LongName', 'D:\\': 'D:\\', 'D:\\j': 'C:\\X\\LongName' };
    const missing = table(dirs);
    const present = table({
      ...dirs,
      'C:\\X\\LongName\\a.txt': 'C:\\X\\LongName\\a.txt', 'C:\\X\\LONGNA~1\\a.txt': 'C:\\X\\LongName\\a.txt', 'D:\\j\\a.txt': 'C:\\X\\LongName\\a.txt',
    });
    const real = keyOf('C:\\X\\LongName\\a.txt', missing);
    expect(keyOf('C:\\X\\LONGNA~1\\a.txt', missing)).toBe(real);
    expect(keyOf('D:\\j\\a.txt', missing)).toBe(real);
    expect(keyOf('C:\\X\\LongName\\a.txt', present)).toBe(real);
    expect(keyOf('D:\\j\\A.TXT', present)).toBe(real);
  });

  it('pathIdentity 给出的段可直接做包含判定：父目录与子文件重叠，D 与 D-evil 不重叠', () => {
    const id = (p: string): LockClaim => ({ ns: 'path', ...pathIdentity(p, { platform: 'win32', realpath: identity }), mode: 'write', display: p });
    expect(claimsOverlap(id('C:\\D'), id('c:\\d\\sub\\x.txt'))).toBe(true);
    expect(claimsOverlap(id('C:\\D\\sub\\x.txt'), id('C:\\D'))).toBe(true);
    expect(claimsOverlap(id('C:\\D'), id('C:\\D-evil\\x.txt'))).toBe(false);
    expect(claimsOverlap(id('C:\\D'), id('E:\\D'))).toBe(false);
  });
});

describe('L2 冲突矩阵', () => {
  const req = (group: string, ...claims: LockClaim[]) => ({ group, claims });

  it('同一会话：读-读不冲突，读-写、写-写冲突', () => {
    expect(requestsConflict(req('a', P('/x', 'read')), req('a', P('/x', 'read')))).toBe(false);
    expect(requestsConflict(req('a', P('/x', 'read')), req('a', P('/x', 'write')))).toBe(true);
    expect(requestsConflict(req('a', P('/x', 'write')), req('a', P('/x', 'read')))).toBe(true);
    expect(requestsConflict(req('a', P('/x', 'write')), req('a', P('/x', 'write')))).toBe(true);
  });

  it('不同会话：只有写-写冲突，读不等写', () => {
    expect(requestsConflict(req('a', P('/x', 'read')), req('b', P('/x', 'read')))).toBe(false);
    expect(requestsConflict(req('a', P('/x', 'read')), req('b', P('/x', 'write')))).toBe(false);
    expect(requestsConflict(req('a', P('/x', 'write')), req('b', P('/x', 'read')))).toBe(false);
    expect(requestsConflict(req('a', P('/x', 'write')), req('b', P('/x', 'write')))).toBe(true);
  });

  it('path 按子树重叠；不相干的路径、不同命名空间不冲突', () => {
    expect(requestsConflict(req('a', P('/d', 'write')), req('b', P('/d/sub/x', 'write')))).toBe(true);
    expect(requestsConflict(req('a', P('/d/sub/x', 'write')), req('b', P('/d', 'write')))).toBe(true);
    expect(requestsConflict(req('a', P('/d', 'write')), req('b', P('/d-evil/x', 'write')))).toBe(false);
    expect(requestsConflict(req('a', P('/x', 'write')), req('a', P('/y', 'write')))).toBe(false);
    expect(requestsConflict(req('a', N('x', 'write')), req('a', S('x', 'write')))).toBe(false);
  });

  it('named 与 session 同理：按键全等，同会话读-写冲突、跨会话只有写-写冲突', () => {
    expect(requestsConflict(req('a', N('mcp:s', 'write')), req('b', N('mcp:s', 'write')))).toBe(true);
    expect(requestsConflict(req('a', N('mcp:s', 'write')), req('b', N('mcp:t', 'write')))).toBe(false);
    expect(requestsConflict(req('a', N('mcp:s', 'read')), req('b', N('mcp:s', 'write')))).toBe(false);
    expect(requestsConflict(req('a', N('mcp:s', 'read')), req('a', N('mcp:s', 'write')))).toBe(true);
    // 会话 claim：barrier（写）挡住同会话的一切，普通调用（读）之间互不挡
    expect(requestsConflict(req('a', S('a', 'write')), req('a', S('a', 'read')))).toBe(true);
    expect(requestsConflict(req('a', S('a', 'read')), req('a', S('a', 'read')))).toBe(false);
    expect(requestsConflict(req('a', S('a', 'write')), req('b', S('b', 'write')))).toBe(false);
  });
});

describe('L3 先到先得，不插队', () => {
  it('同会话 读 X、写 X、读 X 依次入队：第三个读不得越过等待中的写', async () => {
    const locks = new ResourceLockManager();
    const r1 = locks.acquire({ group: 'a', label: 'r1', claims: [P('/x', 'read')] });
    const w = locks.acquire({ group: 'a', label: 'w', claims: [P('/x', 'write')] });
    const r2 = locks.acquire({ group: 'a', label: 'r2', claims: [P('/x', 'read')] });
    const h1 = await granted(r1);
    expect(await peek(w)).toBe('pending');
    expect(await peek(r2)).toBe('pending');
    expect(locks.snapshot().waiting.map(x => x.label)).toEqual(['w', 'r2']);

    h1.release();
    const hw = await granted(w);
    expect(await peek(r2)).toBe('pending');
    hw.release();
    (await granted(r2)).release();
    expect(locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('跨会话：A 持写，B 等；A 再来一个写排在 B 之后', async () => {
    const locks = new ResourceLockManager();
    const a1 = await granted(locks.acquire({ group: 'a', label: 'a1', claims: [P('/x', 'write')] }));
    const b = locks.acquire({ group: 'b', label: 'b', claims: [P('/x', 'write')] });
    const a2 = locks.acquire({ group: 'a', label: 'a2', claims: [P('/x', 'write')] });
    expect(locks.snapshot().waiting.map(x => x.label)).toEqual(['b', 'a2']);
    a1.release();
    const hb = await granted(b);
    expect(await peek(a2)).toBe('pending');
    hb.release();
    (await granted(a2)).release();
  });

  it('与前面都不冲突的后来者可以越过等待者；release 幂等', async () => {
    const locks = new ResourceLockManager();
    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/x', 'write')] }));
    const b = locks.acquire({ group: 'b', label: 'b', claims: [P('/x', 'write')] });
    const c = await granted(locks.acquire({ group: 'c', label: 'c', claims: [P('/y', 'write')] }));
    c.release(); c.release();
    a.release(); a.release();
    const hb = await granted(b);
    // 重复 release 没有把计数减成负数、也没有把 b 的锁放掉
    expect(locks.snapshot().held.map(x => x.label)).toEqual(['b']);
    hb.release();
  });

  it('多资源请求整组授予：拿不全就一条也不占', async () => {
    const locks = new ResourceLockManager();
    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/x', 'write')] }));
    // b 要 {x, y}：x 被占，y 也不能先占住
    const b = locks.acquire({ group: 'b', label: 'b', claims: [P('/x', 'write'), P('/y', 'write')] });
    expect(await peek(b)).toBe('pending');
    expect(locks.snapshot().held.map(x => x.label)).toEqual(['a']);
    a.release();
    (await granted(b)).release();
  });

  it('已取消的 signal 不入队；等待中取消立即落定为 cancelled', async () => {
    const locks = new ResourceLockManager();
    const dead = new AbortController(); dead.abort();
    expect(await peek(locks.acquire({ group: 'a', label: 'x', claims: [P('/x', 'write')], signal: dead.signal })))
      .toEqual({ ok: false, reason: 'cancelled', waitedMs: 0 });
    expect(locks.snapshot()).toEqual({ held: [], waiting: [] });

    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/x', 'write')] }));
    const ctl = new AbortController();
    const b = locks.acquire({ group: 'b', label: 'b', claims: [P('/x', 'write')], signal: ctl.signal });
    ctl.abort();
    expect(await peek(b)).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(locks.snapshot().waiting).toEqual([]);
    a.release();
  });
});

describe('L4–L6、L8、L9 跨会话等待超时（fake timers）', () => {
  it('L4 被别的会话挡住超过上限：到点才超时，blockedBy 是它自己的路径；之后锁表照常工作', async () => {
    vi.useFakeTimers();
    const locks = new ResourceLockManager({ waitTimeoutMs: 80 });
    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/a-side/x', 'write')] }));
    // b 给的是自己的写法（父目录），与 a 的路径重叠
    const b = locks.acquire({ group: 'b', label: 'b', claims: [P('/a-side', 'write')] });
    expect(locks.snapshot().waiting).toMatchObject([{ label: 'b', foreignBlocked: true, blockedBy: 'a' }]);

    vi.advanceTimersByTime(79);
    expect(await peek(b)).toBe('pending');
    vi.advanceTimersByTime(1);
    const rb = await peek(b);
    expect(rb).toMatchObject({ ok: false, reason: 'timeout', waitedMs: 80, blockedBy: { display: '/a-side' } });
    expect(locks.snapshot().waiting).toEqual([]);

    a.release();
    (await granted(locks.acquire({ group: 'b', label: 'b2', claims: [P('/a-side', 'write')] }))).release();
  });

  it('L5 只被本会话的调用挡住不计时', async () => {
    vi.useFakeTimers();
    const locks = new ResourceLockManager({ waitTimeoutMs: 30 });
    const w = await granted(locks.acquire({ group: 'a', label: 'w', claims: [P('/p', 'write')] }));
    const r = locks.acquire({ group: 'a', label: 'r', claims: [P('/p', 'read')] });
    vi.advanceTimersByTime(120);
    expect(await peek(r)).toBe('pending');
    expect(locks.snapshot().waiting).toMatchObject([{ label: 'r', foreignBlocked: false }]);
    w.release();
    (await granted(r)).release();
  });

  it('L6 同批里各自被别的会话挡住的调用各自计时、同时到点（不是一个超时了下一个才开始计）', async () => {
    vi.useFakeTimers();
    const locks = new ResourceLockManager({ waitTimeoutMs: 80 });
    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/x', 'write')] }));
    const bs = [1, 2, 3].map(i => locks.acquire({ group: 'b', label: `b${i}`, claims: [P('/x', 'write')] }));
    vi.advanceTimersByTime(79);
    for (const b of bs) expect(await peek(b)).toBe('pending');
    vi.advanceTimersByTime(1);
    for (const b of bs) expect(await peek(b)).toMatchObject({ ok: false, reason: 'timeout' });
    a.release();
  });

  it('L8(1) 等待者被取消出队后重新判定：只被它按先后挡住的请求当场拿到锁（持有者还没放）', async () => {
    vi.useFakeTimers();
    const locks = new ResourceLockManager({ waitTimeoutMs: 80 });
    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/x', 'write')] }));
    const ctl = new AbortController();
    const b = locks.acquire({ group: 'b', label: 'b', claims: [P('/x', 'write'), P('/y', 'write')], signal: ctl.signal });
    vi.advanceTimersByTime(10);
    const c = locks.acquire({ group: 'c', label: 'c', claims: [P('/y', 'write')] });
    // c 与持有者 a 不冲突，只被等待中的 b 挡住
    expect(locks.snapshot().waiting).toMatchObject([{ label: 'b', foreignBlocked: true }, { label: 'c', foreignBlocked: true, blockedBy: 'b' }]);

    ctl.abort();
    expect(await peek(b)).toMatchObject({ ok: false, reason: 'cancelled' });
    const hc = await granted(c);
    expect(locks.snapshot().held.map(x => x.label)).toEqual(['a', 'c']);
    hc.release(); a.release();
  });

  it('L8(2) 等待者超时出队后重新判定：排在它后面的请求在它超时的那一刻拿到锁，不会跟着超时', async () => {
    vi.useFakeTimers();
    const locks = new ResourceLockManager({ waitTimeoutMs: 80 });
    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/x', 'write')] }));
    const b = locks.acquire({ group: 'b', label: 'b', claims: [P('/x', 'write'), P('/y', 'write')] });
    vi.advanceTimersByTime(10);
    const c = locks.acquire({ group: 'c', label: 'c', claims: [P('/y', 'write')] });
    expect(locks.snapshot().waiting.map(x => x.label)).toEqual(['b', 'c']);

    // 第 80ms：b 的定时器到点（c 的要到第 90ms）
    vi.advanceTimersByTime(70);
    expect(await peek(b)).toMatchObject({ ok: false, reason: 'timeout' });
    const hc = await granted(c);
    expect(locks.snapshot().held.map(x => x.label)).toEqual(['a', 'c']);
    // 再过 10ms 也不会把已授予的 c 判成超时
    vi.advanceTimersByTime(10);
    expect(locks.snapshot().held.map(x => x.label)).toEqual(['a', 'c']);
    hc.release(); a.release();
  });

  it('L9 只被同批前序挡住的不计时；前序因等别的会话超时后，它照常拿到锁', async () => {
    vi.useFakeTimers();
    const locks = new ResourceLockManager({ waitTimeoutMs: 80 });
    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/x', 'write'), S('a', 'read')] }));
    const b1 = locks.acquire({ group: 'b', label: 'b1', claims: [P('/x', 'write'), S('b', 'read')] });
    // b2 是 barrier：只有会话 claim（写），不碰 X——与 a 不冲突，只被同批的 b1 挡住
    const b2 = locks.acquire({ group: 'b', label: 'b2', claims: [S('b', 'write')] });
    expect(locks.snapshot().waiting).toMatchObject([{ label: 'b1', foreignBlocked: true }, { label: 'b2', foreignBlocked: false }]);

    vi.advanceTimersByTime(79);
    expect(await peek(b1)).toBe('pending');
    expect(await peek(b2)).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(await peek(b1)).toMatchObject({ ok: false, reason: 'timeout' });
    const h2 = await granted(b2);
    expect(locks.snapshot().held.map(x => x.label)).toEqual(['a', 'b2']);
    h2.release(); a.release();
  });

  it('不再被别的会话挡住时计时清零：之后只被本会话前序挡住，等多久都不超时', async () => {
    vi.useFakeTimers();
    const locks = new ResourceLockManager({ waitTimeoutMs: 80 });
    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/x', 'write')] }));
    const b1 = locks.acquire({ group: 'b', label: 'b1', claims: [P('/x', 'write')] });
    const b2 = locks.acquire({ group: 'b', label: 'b2', claims: [P('/x', 'write')] });
    vi.advanceTimersByTime(50);
    a.release();
    const h1 = await granted(b1);
    // b2 现在只被本会话的 b1 挡住
    expect(locks.snapshot().waiting).toMatchObject([{ label: 'b2', foreignBlocked: false }]);
    vi.advanceTimersByTime(500);
    expect(await peek(b2)).toBe('pending');
    h1.release();
    (await granted(b2)).release();
  });
});

describe('L7 一个 signal 只挂一个 abort 监听', () => {
  it('同一 signal 下 20 个等待请求只有 1 个监听；全部授予后为 0', async () => {
    const locks = new ResourceLockManager({ maxConcurrentPerGroup: 50 });
    const a = await granted(locks.acquire({ group: 'a', label: 'a', claims: [P('/d', 'write')] }));
    const ctl = new AbortController();
    const waiting = Array.from({ length: 20 }, (_, i) =>
      locks.acquire({ group: 'b', label: `b${i}`, claims: [P(`/d/f${i}`, 'write')], signal: ctl.signal }));
    expect(locks.snapshot().waiting).toHaveLength(20);
    expect(getEventListeners(ctl.signal, 'abort').length).toBe(1);

    a.release();
    const held = await Promise.all(waiting.map(w => granted(w)));
    expect(getEventListeners(ctl.signal, 'abort').length).toBe(0);
    // 已授予的请求不受 abort 影响，由持有者放
    ctl.abort();
    expect(locks.snapshot().held).toHaveLength(20);
    for (const h of held) h.release();
    expect(locks.snapshot()).toEqual({ held: [], waiting: [] });
  });

  it('每会话并发上限是授予条件：到上限的请求留在队里，放掉一个才进下一个；别的会话不受影响', async () => {
    const locks = new ResourceLockManager({ maxConcurrentPerGroup: 2 });
    const a1 = await granted(locks.acquire({ group: 'a', label: 'a1', claims: [P('/1', 'read')] }));
    const a2 = await granted(locks.acquire({ group: 'a', label: 'a2', claims: [P('/2', 'read')] }));
    const a3 = locks.acquire({ group: 'a', label: 'a3', claims: [P('/3', 'read')] });
    expect(await peek(a3)).toBe('pending');
    expect(locks.snapshot().waiting).toMatchObject([{ label: 'a3', foreignBlocked: false }]);
    (await granted(locks.acquire({ group: 'b', label: 'b1', claims: [P('/3', 'read')] }))).release();
    a1.release();
    (await granted(a3)).release();
    a2.release();
  });
});
