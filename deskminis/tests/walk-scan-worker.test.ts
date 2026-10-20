/** Q15：遍历用的 worker 怎么起、怎么收、出了岔子怎么办。
 *
 *  node:worker_threads 的 Worker 换成一个记账的假件（不起线程），由用例决定它发什么事件：
 *  - 小目录不起 worker，大目录恰好起一个，交给它的活是基准、条目上限与跳过规则；
 *  - worker 交回结果就用它，之后的退出不算数；用完就 terminate；
 *  - worker 报错、没交结果就退出：按异常交给调用方，工具给出「遍历失败」的结果，不让异常冒出去；
 *  - 中途点停止：terminate，返回 aborted，之后晚到的结果不算数。
 *  真实的 worker 在 tests/walk-scan.test.ts 里跑。 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { made } = vi.hoisted(() => ({ made: [] as any[] }));

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    terminated = 0;
    constructor(public source: string, public options: { eval?: boolean; workerData?: unknown }) { super(); made.push(this); }
    terminate(): Promise<number> { this.terminated += 1; return Promise.resolve(0); }
  }
  return { Worker };
});

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { getEventListeners } from 'node:events';
// eslint-disable-next-line import/first
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
// eslint-disable-next-line import/first
import { tmpdir } from 'node:os';
// eslint-disable-next-line import/first
import { join } from 'node:path';
// eslint-disable-next-line import/first
import { walkDirAsync, walkDirInWorker, WALK_ENTRY_LIMIT } from '../src/minisd/tools/walk-scan';
// eslint-disable-next-line import/first
import { fileGlobTool, walkDir } from '../src/minisd/tools/search';
// eslint-disable-next-line import/first
import { MinisPaths } from '../src/minisd/paths';
// eslint-disable-next-line import/first
import type { ToolContext, PermissionRequest, PermissionDecision } from '../src/minisd/tools/types';

class AllowAllGateway { async check(_r: PermissionRequest): Promise<PermissionDecision> { return 'allow'; } hasBridgeGrant(): boolean { return false; } }

let dir: string;
const files = (n: number): void => { for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${String(i).padStart(4, '0')}.txt`), ''); };
const RESULT = { files: ['x.txt'], dirs: ['d'], hitLimit: true, skipped: ['s'] };
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  made.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'dm-walk-w-'));
});

describe('Q15 什么时候起 worker', () => {
  it('不到 200 个条目：当场走完，不起 worker', async () => {
    files(199);
    const r = await walkDirAsync(dir);
    expect(made).toHaveLength(0);
    expect(r.files).toHaveLength(199);
    expect(r).toMatchObject({ aborted: false, hitLimit: false });
  });

  it('到了 200 个条目：恰好起一个 worker，交给它基准、条目上限与跳过规则；本线程走的那一段丢掉，用 worker 交回的', async () => {
    files(200);
    const rule = { target: 'x/y', win: true };
    const p = walkDirAsync(dir, { skip: rule });
    expect(made).toHaveLength(1);
    expect(made[0].options).toEqual({ eval: true, workerData: { base: dir, entryLimit: WALK_ENTRY_LIMIT, skip: rule } });
    expect(typeof made[0].source).toBe('string');
    made[0].emit('message', RESULT);
    expect(await p).toEqual({ ...RESULT, aborted: false });
    expect(made[0].terminated).toBe(1);
  });

  it('没有跳过规则、另给了条目上限：交给 worker 的活里没有 skip，上限是给的那个', async () => {
    files(200);
    const p = walkDirAsync(dir, { entryLimit: 1234 });
    expect(made[0].options.workerData).toEqual({ base: dir, entryLimit: 1234 });
    made[0].emit('message', RESULT);
    await p;
  });

  it('调用之前已经取消：不起 worker', async () => {
    files(300);
    const c = new AbortController();
    c.abort();
    expect((await walkDirAsync(dir, { signal: c.signal })).aborted).toBe(true);
    expect((await walkDirInWorker(dir, { signal: c.signal })).aborted).toBe(true);
    expect(made).toHaveLength(0);
  });
});

describe('Q15 worker 的结局', () => {
  it('交回结果之后的退出不算数', async () => {
    const p = walkDirInWorker(dir);
    made[0].emit('message', RESULT);
    made[0].emit('exit', 1);
    expect(await p).toEqual({ ...RESULT, aborted: false });
  });

  it('报错：按那个错误拒绝，并 terminate', async () => {
    const p = walkDirInWorker(dir);
    made[0].emit('error', new Error('起不来'));
    await expect(p).rejects.toThrow('起不来');
    expect(made[0].terminated).toBe(1);
  });

  it('没交结果就退出：拒绝，错误里带退出码', async () => {
    const p = walkDirInWorker(dir);
    made[0].emit('exit', 3);
    await expect(p).rejects.toThrow('文件遍历线程意外退出（3）');
  });

  it('中途点停止：terminate，返回 aborted；晚到的结果不算数', async () => {
    const c = new AbortController();
    const p = walkDirInWorker(dir, { signal: c.signal });
    await tick();
    expect(made[0].terminated).toBe(0);
    c.abort();
    made[0].emit('message', RESULT);
    expect(await p).toEqual({ files: [], dirs: [], hitLimit: false, skipped: [], aborted: true });
    expect(made[0].terminated).toBe(1);
  });

  it('正常结束之后再取消：不再 terminate 第二次；挂在 signal 上的监听用完就摘掉', async () => {
    const c = new AbortController();
    const p = walkDirInWorker(dir, { signal: c.signal });
    expect(getEventListeners(c.signal, 'abort')).toHaveLength(1);
    made[0].emit('message', RESULT);
    await p;
    expect(getEventListeners(c.signal, 'abort')).toHaveLength(0);
    c.abort();
    await tick();
    expect(made[0].terminated).toBe(1);
  });
});

describe('Q15 工具对 worker 出岔子的交代', () => {
  const ctxOf = (): ToolContext => {
    const root = mkdtempSync(join(tmpdir(), 'dm-walk-root-'));
    const paths = new MinisPaths(root);
    paths.ensureSessionDirs('S1');
    return { sessionId: 'S1', paths, permissions: new AllowAllGateway() };
  };

  it('worker 报错：file_glob 给出「遍历失败」，不抛', async () => {
    files(250);
    const p = fileGlobTool.execute({ pattern: '**/*.txt', path: dir, tool_title: '找' }, ctxOf());
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0].emit('error', new Error('线程起不来'));
    expect(await p).toEqual({ output: 'file_glob 遍历失败: 线程起不来', success: false });
  });

  it('worker 交回结果：file_glob 按它过滤、排序、加尾注', async () => {
    files(250);
    const p = fileGlobTool.execute({ pattern: '**/*.txt', path: dir, tool_title: '找' }, ctxOf());
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0].emit('message', { files: ['b.txt', 'a.md', 'sub/c.txt'], dirs: ['sub', 'z.txt'], hitLimit: true, skipped: ['Data'] });
    expect(await p).toEqual({
      output: ['b.txt', 'sub/c.txt', 'z.txt', `[已截断: 遍历条目达上限 ${WALK_ENTRY_LIMIT}，结果可能不全]`, '[已跳过 DeskMinis 数据目录：Data]'].join('\n'),
      success: true,
    });
  });

  it('小目录：file_glob 不起 worker，结果与本线程的遍历一致', async () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'c.txt'), '');
    files(3);
    const r = await fileGlobTool.execute({ pattern: '**/*.txt', path: dir, tool_title: '找' }, ctxOf());
    expect(made).toHaveLength(0);
    expect(r.output.split('\n')).toEqual([...walkDir(dir).files].sort());
  });
});
