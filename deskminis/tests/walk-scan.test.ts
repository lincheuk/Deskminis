/** Q15：file_glob / file_grep 的目录遍历不占住引擎的事件循环。
 *
 *  以前遍历在事件循环里同步跑：一个带 node_modules 的工程约 1 秒，这期间所有会话的流式输出、权限卡、RPC 都停着；
 *  停止键的 RPC 进不来，遍历里的取消检查也就查不到。现在大目录放进 worker_threads 的 Worker 里走。
 *
 *  钉的行为：
 *  - 放进 worker 的遍历与本线程的遍历结果逐项相同（文件、目录、是否触上限、跳过了谁），各种形状的目录、各种上限都是；
 *  - 小目录（不到 200 个条目）与大目录走的是两条路，结果仍与本线程的遍历相同；
 *  - 大目录遍历期间事件循环照常转，中途点停止立即返回 [已取消]。
 *
 *  「大目录」用的是本仓库自己的 node_modules（真实位置；几万个条目，跑测试的机器上一定有），不另造几万个文件。 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileGlobTool, fileGrepTool, walkDir } from '../src/minisd/tools/search';
import { walkDirAsync, walkDirInWorker } from '../src/minisd/tools/walk-scan';
import { dataRootSkipRule, dataRootSkipper } from '../src/minisd/tools/data-gate';
import type { ToolContext, PermissionRequest, PermissionDecision } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';

class AllowAllGateway { async check(_r: PermissionRequest): Promise<PermissionDecision> { return 'allow'; } hasBridgeGrant(): boolean { return false; } }

/** 本仓库的依赖目录的真实位置（工作树里它是一个目录联接，遍历不进联接，所以先解析）。 */
const BIG = realpathSync(join(__dirname, '..', 'node_modules'));

let root: string; let ws: string; let ctx: ToolContext; let reg: ToolRegistry;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-walk-'));
  const paths = new MinisPaths(root);
  paths.ensureSessionDirs('S1');
  ws = join(root, 'sessions', 'S1', 'workspace');
  ctx = { sessionId: 'S1', paths, permissions: new AllowAllGateway() };
  reg = new ToolRegistry();
  reg.register(fileGlobTool); reg.register(fileGrepTool);
});

/** 在 dir 下造 n 个文件，分散在几个子目录里。返回条目总数（文件加目录）。 */
function fill(dir: string, n: number): number {
  const subs = ['', 'a', 'a/deep', 'b', '中文 目录'];
  for (const s of subs) if (s) mkdirSync(join(dir, s), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, subs[i % subs.length], `f${String(i).padStart(4, '0')}.${i % 2 ? 'ts' : 'md'}`), '');
  return n + subs.length - 1;
}
const plain = (r: { files: string[]; dirs: string[]; hitLimit: boolean; skipped: string[] }) =>
  ({ files: r.files, dirs: r.dirs, hitLimit: r.hitLimit, skipped: r.skipped });

describe('Q15 worker 里的遍历与本线程的遍历结果相同', () => {
  it('嵌套目录、空目录、非 ASCII 与带空格的名字', async () => {
    fill(ws, 23);
    mkdirSync(join(ws, 'empty'));
    writeFileSync(join(ws, '带 空格.txt'), '');
    const sync = walkDir(ws);
    expect(sync.files).toHaveLength(24);
    expect(sync.dirs).toEqual(['a', 'a/deep', 'b', 'empty', '中文 目录']);
    expect(plain(await walkDirInWorker(ws))).toEqual(plain(sync));
    expect(await walkDirInWorker(ws)).toMatchObject({ aborted: false });
  });

  it('junction 目录不进入、链接条目不进结果', async () => {
    mkdirSync(join(ws, 'real'));
    writeFileSync(join(ws, 'real', 'x.ts'), 'x');
    symlinkSync(join(ws, 'real'), join(ws, 'link'), 'junction');
    const r = await walkDirInWorker(ws);
    expect(plain(r)).toEqual({ files: ['real/x.ts'], dirs: ['real'], hitLimit: false, skipped: [] });
    expect(plain(r)).toEqual(plain(walkDir(ws)));
  });

  it('基准不存在：与本线程一样给空结果，不抛', async () => {
    const gone = join(ws, 'nope');
    expect(plain(walkDir(gone))).toEqual({ files: [], dirs: [], hitLimit: false, skipped: [] });
    expect(plain(await walkDirInWorker(gone))).toEqual(plain(walkDir(gone)));
  });

  it('条目上限：从 0 到刚好够、再到用不完，每一档截在同一处', async () => {
    const total = fill(ws, 40);
    for (const limit of [0, 1, 2, 7, 20, total - 1, total, total + 1, 500]) {
      const sync = walkDir(ws, { entryLimit: limit });
      const worker = await walkDirInWorker(ws, { entryLimit: limit });
      expect(plain(worker), `上限 ${limit}`).toEqual(plain(sync));
      expect(sync.hitLimit, `上限 ${limit}`).toBe(limit < total);
    }
  });

  it('数据根在基准之下：整棵跳过并记下，与本线程用 dataRootSkipper 的结果相同（名字的大小写按平台的规则比）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dm-walk-base-'));
    const data = join(base, 'Nested', 'DataRoot');
    mkdirSync(join(data, 'sessions'), { recursive: true });
    writeFileSync(join(data, 'servers.json'), '{}');
    writeFileSync(join(base, 'Nested', 'keep.txt'), '');
    writeFileSync(join(base, 'top.txt'), '');
    const rule = dataRootSkipRule(base, data);
    const skipDir = dataRootSkipper(base, data);
    expect(rule).toBeDefined();
    const sync = walkDir(base, { skipDir });
    expect(plain(sync)).toEqual({ files: ['Nested/keep.txt', 'top.txt'], dirs: ['Nested'], hitLimit: false, skipped: ['Nested/DataRoot'] });
    expect(plain(await walkDirInWorker(base, { skip: rule }))).toEqual(plain(sync));
    expect(plain(await walkDirAsync(base, { skip: rule }))).toEqual(plain(sync));
    // 没给规则就不跳
    expect((await walkDirInWorker(base)).files).toContain('Nested/DataRoot/servers.json');
  });

  it('worker 里按规则跳目录：只跳规则指的那一个；win 规则下名字折叠后再比（大小写、尾部的点和空格），非 win 规则逐字比', async () => {
    fill(ws, 10);
    mkdirSync(join(ws, 'CamelCase', 'inner'), { recursive: true });
    writeFileSync(join(ws, 'CamelCase', 'inner', 'x.txt'), '');
    const sync = walkDir(ws);
    // 指的目录不存在、或在更深一层：什么都不跳
    for (const target of ['nope', 'a/nope', 'a/deep/x']) {
      expect(plain(await walkDirInWorker(ws, { skip: { target, win: true } })), target).toEqual(plain(sync));
    }
    const exact = await walkDirInWorker(ws, { skip: { target: 'a', win: false } });
    expect(exact.skipped).toEqual(['a']);
    expect(exact.files.some(f => f.startsWith('a/'))).toBe(false);
    expect(exact.dirs).toEqual(sync.dirs.filter(d => d !== 'a' && !d.startsWith('a/')));
    // win 规则：磁盘上叫 CamelCase，规则里是折叠后的 camelcase
    const folded = await walkDirInWorker(ws, { skip: { target: 'camelcase', win: true } });
    expect(folded.skipped).toEqual(['CamelCase']);
    expect(folded.files.some(f => f.startsWith('CamelCase/'))).toBe(false);
    const deep = await walkDirInWorker(ws, { skip: { target: 'camelcase/inner', win: true } });
    expect(deep.skipped).toEqual(['CamelCase/inner']);
    expect(deep.dirs).toContain('CamelCase');
    // 非 win 规则：大小写不同就不是同一个目录
    expect(plain(await walkDirInWorker(ws, { skip: { target: 'camelcase', win: false } }))).toEqual(plain(sync));
    // 每一种都与本线程用同一条规则的结果相同
    const { matchesSkipRule, stripWin32Segment } = await import('../src/minisd/tools/data-gate');
    for (const rule of [{ target: 'a', win: false }, { target: 'camelcase', win: true }, { target: 'camelcase/inner', win: true }, { target: 'camelcase', win: false }]) {
      const same = walkDir(ws, { skipDir: rel => matchesSkipRule(rule, rel, stripWin32Segment) });
      expect(plain(await walkDirInWorker(ws, { skip: rule })), JSON.stringify(rule)).toEqual(plain(same));
    }
  });

  it('真实的大目录（本仓库的 node_modules）：几万个条目，逐项相同', async () => {
    const sync = walkDir(BIG);
    expect(sync.files.length + sync.dirs.length).toBeGreaterThan(5000);
    const worker = await walkDirInWorker(BIG);
    expect(worker.hitLimit).toBe(sync.hitLimit);
    expect(worker.files).toEqual(sync.files);
    expect(worker.dirs).toEqual(sync.dirs);
    expect(worker.skipped).toEqual(sync.skipped);
  }, 120_000);
});

describe('Q15 工具用的入口：小目录当场走完，大目录交给 worker，结果都与本线程的遍历相同', () => {
  it.each([0, 1, 150, 194, 195, 196, 260, 450])('%i 个文件', async n => {
    const total = fill(ws, n);
    const sync = walkDir(ws);
    expect(sync.files.length + sync.dirs.length).toBe(total);
    expect(plain(await walkDirAsync(ws))).toEqual(plain(sync));
    // 带上限时同样
    for (const limit of [3, 199, 200, 201]) expect(plain(await walkDirAsync(ws, { entryLimit: limit })), `上限 ${limit}`).toEqual(plain(walkDir(ws, { entryLimit: limit })));
  });

  it('调用之前已经取消：直接返回 aborted，不遍历', async () => {
    fill(ws, 10);
    const c = new AbortController();
    c.abort();
    expect(await walkDirAsync(ws, { signal: c.signal })).toEqual({ files: [], dirs: [], hitLimit: false, skipped: [], aborted: true });
    expect(await walkDirInWorker(ws, { signal: c.signal })).toEqual({ files: [], dirs: [], hitLimit: false, skipped: [], aborted: true });
  });
});

describe('Q15 大目录遍历期间引擎的事件循环照常转，中途点停止立即返回', () => {
  // 下面两条的 tick 数与耗时受机器负载影响；保留计时断言，无自动重试。
  it('file_glob 走完整个大目录：期间定时器一直在跳', async () => {
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 10);
    const t0 = Date.now();
    const r = await reg.execute('file_glob', JSON.stringify({ pattern: '**/package.json', path: BIG, tool_title: '找' }), ctx);
    const took = Date.now() - t0;
    clearInterval(iv);
    expect(r.success).toBe(true);
    expect(r.output.split('\n').length).toBeGreaterThan(100);
    // 遍历在本线程里同步跑的话，这段时间里定时器一拍都跳不了（最多在收尾时补一两拍）
    expect(ticks, `遍历用了 ${took} 毫秒，期间事件循环被卡住了`).toBeGreaterThanOrEqual(Math.min(10, Math.floor(took / 40)));
    expect(ticks).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('file_glob 遍历中途点停止：立即返回 [已取消]，不等遍历走完', async () => {
    // 先不取消走一遍，知道走完要多久（也把磁盘缓存热起来）
    const t0 = Date.now();
    const full = await reg.execute('file_glob', JSON.stringify({ pattern: '**/package.json', path: BIG, tool_title: '找' }), ctx);
    const fullMs = Date.now() - t0;
    expect(full.success).toBe(true);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const t1 = Date.now();
    const r = await reg.execute('file_glob', JSON.stringify({ pattern: '**/package.json', path: BIG, tool_title: '找' }), { ...ctx, signal: controller.signal });
    const cancelledMs = Date.now() - t1;
    expect(r).toEqual({ output: '[已取消]', success: false });
    // 走完要 fullMs；取消是第 30 毫秒发的。给调度留足余量，但必须明显早于走完
    expect(cancelledMs, `走完要 ${fullMs} 毫秒，取消后 ${cancelledMs} 毫秒才返回`).toBeLessThan(Math.max(250, fullMs * 0.6));
  }, 120_000);

  it('file_grep 遍历中途点停止：同样立即返回 [已取消]', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const r = await reg.execute('file_grep', JSON.stringify({ pattern: 'Q15-NOT-THERE', path: BIG, glob: '*.md', tool_title: '搜' }), { ...ctx, signal: controller.signal });
    expect(r).toEqual({ output: '[已取消]', success: false });
  }, 120_000);
});
