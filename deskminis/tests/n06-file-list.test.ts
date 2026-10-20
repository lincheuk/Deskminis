import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, type Dirent, type Stats } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileListTool } from '../src/minisd/tools/search';
import { MinisPaths } from '../src/minisd/paths';
import type { ToolContext } from '../src/minisd/tools/types';

const probe = vi.hoisted(() => ({
  types: new Map<string, 'link' | 'unknown'>(),
  failures: new Set<string>(),
  calls: [] as string[],
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const key = (p: string): string => p.replace(/\\/g, '/');
  return {
    ...actual,
    readdirSync(dir: string, options?: { withFileTypes?: boolean }) {
      const entries = Reflect.apply(actual.readdirSync, actual, [dir, options]) as Dirent[];
      if (!options?.withFileTypes) return entries;
      return entries.map(entry => {
        const type = probe.types.get(key(`${dir}/${entry.name}`));
        if (!type) return entry;
        return Object.assign(Object.create(entry), {
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => type === 'link',
        }) as Dirent;
      });
    },
    lstatSync(file: string, ...args: unknown[]) {
      const p = key(String(file));
      probe.calls.push(p);
      if (probe.failures.has(p)) throw Object.assign(new Error('synthetic lstat failure'), { code: 'ENOENT' });
      return Reflect.apply(actual.lstatSync, actual, [file, ...args]);
    },
  };
});

const key = (p: string): string => resolve(p).replace(/\\/g, '/');
let root: string;
let ws: string;
let ctx: ToolContext;

beforeEach(() => {
  probe.types.clear();
  probe.failures.clear();
  probe.calls.length = 0;
  root = mkdtempSync(join(tmpdir(), 'n06-list-'));
  const paths = new MinisPaths(join(root, 'data'));
  paths.ensureSessionDirs('S1');
  ws = paths.workspaceOf('S1');
  ctx = { sessionId: 'S1', paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant() { return false; } } };
});

afterEach(() => {
  probe.failures.clear();
  probe.types.clear();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('cleanup outside synthetic TEMP');
  rmSync(root, { recursive: true, force: true });
});

/** 改前的单层算法：全部 lstat，默认 UTF-16 排序，目录在前，最后截断。 */
function oracle(dir: string): string {
  const names = readdirSync(dir);
  names.sort();
  const dirs: string[] = [];
  const files: string[] = [];
  for (const name of names) {
    let st: Stats;
    try { st = lstatSync(join(dir, name)); } catch { continue; }
    if (st.isDirectory()) dirs.push(`${name}/`);
    else files.push(`${name}\t${st.size}`);
  }
  const lines = [...dirs, ...files];
  const shown = lines.slice(0, 500);
  if (lines.length > 500) shown.push(`[已截断: 共 ${lines.length} 项]`);
  return shown.join('\n');
}

function files(n: number): void {
  for (let i = 0; i < n; i++) writeFileSync(join(ws, `f${String(i).padStart(4, '0')}.txt`), Buffer.alloc(i % 19, i % 256));
}

function dirs(n: number): void {
  for (let i = 0; i < n; i++) mkdirSync(join(ws, `z${String(i).padStart(4, '0')}`));
}

async function output(): Promise<string> {
  const r = await fileListTool.execute({ path: '.', tool_title: '列合成目录' }, ctx);
  expect(r.success).toBe(true);
  return r.output;
}

function entryCalls(): string[] {
  return probe.calls.filter(p => key(dirname(p)) === key(ws));
}

describe('N06 file_list：无并发修改时逐字节保持旧输出', () => {

  it.each([0, 1, 499, 500, 501, 502])('旧算法逐字一致：%i 个文件', async count => {
    files(count);
    const expected = oracle(ws);
    expect(await output()).toBe(expected);
  });

  it('超过500个目录：只展示目录，保留全部总数', async () => {
    dirs(503);
    expect(await output()).toBe(oracle(ws));
    expect((await output()).split('\n').at(-1)).toBe('[已截断: 共 503 项]');
  });

  it('499个目录后文件补到500条，大小不同且目录优先', async () => {
    dirs(499);
    files(5);
    const expected = oracle(ws);
    const actual = await output();
    expect(actual).toBe(expected);
    expect(actual.split('\n')[499]).toBe('f0000.txt\t0');
    expect(actual.split('\n')[500]).toBe('[已截断: 共 504 项]');
  });

  it('大小写、数字、中文、点与空格名字按UTF-16默认顺序', async () => {
    const names = ['a', 'A', 'Z', 'z', '10', '2', '中文', '.dot', ' leading', 'has space', 'é'];
    for (const [i, name] of names.entries()) writeFileSync(join(ws, name), Buffer.alloc(i + 1));
    mkdirSync(join(ws, 'zzz目录'));
    expect(await output()).toBe(oracle(ws));
  });
});

describe('N06 file_list：只取展示文件的元数据', () => {

  it('2000个普通文件只lstat展示的500个', async () => {
    files(2000);
    probe.calls.length = 0;
    const actual = await output();
    expect(entryCalls()).toHaveLength(500);
    expect(actual.split('\n')).toHaveLength(501);
    expect(actual.split('\n').at(-1)).toBe('[已截断: 共 2000 项]');
  });

  it('600个目录占满窗口，10个文件与目录都不lstat', async () => {
    dirs(600);
    files(10);
    probe.calls.length = 0;
    const actual = await output();
    expect(entryCalls()).toHaveLength(0);
    expect(actual).toBe(oracle(ws));
  });
});

describe('N06 file_list：链接与未知类型按lstat分类', () => {

  it.each(['link', 'unknown'] as const)('%s 报告的真实目录仍以斜杠列出', async type => {
    mkdirSync(join(ws, 'cloud'));
    probe.types.set(key(join(ws, 'cloud')), type);
    probe.calls.length = 0;
    expect(await output()).toBe('cloud/');
    expect(entryCalls()).toHaveLength(1);
  });

  it.each(['link', 'unknown'] as const)('%s 报告的真实文件复用一次lstat的大小', async type => {
    writeFileSync(join(ws, 'odd.txt'), '12345');
    probe.types.set(key(join(ws, 'odd.txt')), type);
    probe.calls.length = 0;
    expect(await output()).toBe('odd.txt\t5');
    expect(entryCalls()).toHaveLength(1);
  });

  it('未知类型分类时lstat失败，跳过且不计总数', async () => {
    files(2);
    probe.types.set(key(join(ws, 'f0000.txt')), 'unknown');
    probe.failures.add(key(join(ws, 'f0000.txt')));
    expect(await output()).toBe(oracle(ws));
    expect(await output()).toBe('f0001.txt\t1');
  });
});

describe('N06 file_list：消失的条目', () => {

  it('展示文件lstat失败：跳过、补位、总数减一，与旧算法相同', async () => {
    files(502);
    probe.failures.add(key(join(ws, 'f0000.txt')));
    const actual = await output();
    expect(actual).toBe(oracle(ws));
    expect(actual.split('\n')[0]).toBe('f0001.txt\t1');
    expect(actual.split('\n')[499]).toBe('f0500.txt\t6');
    expect(actual.split('\n')[500]).toBe('[已截断: 共 501 项]');
  });

  it('窗口之外消失的普通文件仍计入总数，这是允许的唯一差别', async () => {
    files(502);
    const missing = key(join(ws, 'f0501.txt'));
    probe.failures.add(missing);
    probe.calls.length = 0;
    const actual = await output();
    expect(probe.calls).not.toContain(missing);
    const expected = oracle(ws);
    expect(actual.split('\n').slice(0, 500)).toEqual(expected.split('\n').slice(0, 500));
    expect(actual.split('\n')[500]).toBe('[已截断: 共 502 项]');
    expect(expected.split('\n')[500]).toBe('[已截断: 共 501 项]');
  });
});