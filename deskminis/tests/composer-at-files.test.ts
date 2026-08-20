/** L2 @ 文件引用纯模块（设计稿 2026-08-20-pool-batch-design.md §2）。
 *  atToken：光标前 token 语义（slash 是整行首 token——调研点名的差异）；
 *  atMatch：文件名前缀加权 > 文件名子串 > 路径子串，取前 8；
 *  applyAt：把 `@片段`（含 @）换成相对路径 + 尾空格，光标落在空格后；
 *  collectFiles：files.list 受限递归——深度 ≤4、总数 ≤500、跳过大目录名单。 */
import { describe, it, expect } from 'vitest';
import { atToken, atMatch, applyAt, collectFiles, AT_SKIP_DIRS } from '../src/renderer/src/lib/composer/at-files';

describe('L2 atToken：光标前 token 判定', () => {
  it('@ 在行首或空白后才算；片段可空（刚敲 @）', () => {
    expect(atToken('@')).toBe('');
    expect(atToken('看看 @src/ma')).toBe('src/ma');
    expect(atToken('@README')).toBe('README');
  });
  it('非 token 位置不触发：无 @ / 邮箱式 a@b / token 已收尾', () => {
    expect(atToken('普通文本')).toBeNull();
    expect(atToken('mail a@b')).toBeNull();     // @ 前不是空白/行首——邮箱不劫持
    expect(atToken('看看 @a 然后')).toBeNull(); // 光标已离开 @ token
  });
});

describe('L2 atMatch：文件名前缀加权 + 前 8 截断', () => {
  const P = ['src/main.ts', 'docs/main-notes.md', 'lib/x-main.ts', 'src/util.ts'];
  it('文件名前缀 > 文件名子串 > 路径子串；大小写不敏感；不中者剔除', () => {
    expect(atMatch(P, 'main')).toEqual(['docs/main-notes.md', 'src/main.ts', 'lib/x-main.ts']);
    expect(atMatch(P, 'SRC')).toEqual(['src/main.ts', 'src/util.ts']); // 仅路径子串命中
    expect(atMatch(P, 'zzz')).toEqual([]);
  });
  it('空片段回全量前 8；命中超 8 也截 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    expect(atMatch(many, '')).toHaveLength(8);
    expect(atMatch(many, 'f')).toHaveLength(8);
  });
});

describe('L2 applyAt：`@片段` 整体换成路径 + 尾空格', () => {
  it('光标处替换，后段原样保留，光标落在尾空格后', () => {
    const r = applyAt('看看 @src 再说', 7, 'src/main.ts')!; // 光标在 '@src' 后（index 7）
    expect(r.text).toBe('看看 src/main.ts  再说');
    expect(r.caret).toBe(3 + 'src/main.ts '.length);
  });
  it('光标前无 @ token → null（调用方不动输入框）', () => {
    expect(applyAt('普通文本', 4, 'a.txt')).toBeNull();
  });
});

describe('L2 collectFiles：受限递归（深度/总数/跳过名单）', () => {
  type N = { name: string; path: string; kind: 'dir' | 'file' };
  const file = (p: string): N => ({ name: p.split('/').pop()!, path: p, kind: 'file' });
  const dir = (p: string): N => ({ name: p.split('/').pop()!, path: p, kind: 'dir' });

  it('深度 ≤4：第 4 层目录不再下探；跳过名单目录整棵不进（也不发请求）', async () => {
    const listed: (string | undefined)[] = [];
    const tree: Record<string, N[]> = {
      '': [file('a.txt'), dir('l1'), dir('node_modules')],
      'l1': [dir('l1/l2')],
      'l1/l2': [dir('l1/l2/l3')],
      'l1/l2/l3': [file('l1/l2/l3/ok.txt'), dir('l1/l2/l3/l4')],
      'l1/l2/l3/l4': [file('l1/l2/l3/l4/deep.txt')],
      'node_modules': [file('node_modules/x.js')],
    };
    const r = await collectFiles(async (d) => { listed.push(d); return tree[d ?? ''] ?? []; });
    expect(r.paths).toEqual(['a.txt', 'l1/l2/l3/ok.txt']);
    expect(r.truncated).toBe(false);
    expect(listed).not.toContain('node_modules');
    expect(listed).not.toContain('l1/l2/l3/l4');
    expect(AT_SKIP_DIRS).toContain('__pycache__'); // 名单本身守卫（设计 §2 点名七项）
  });
  it('总数 ≤500：到顶即停并标记截断；单目录 list 失败不废整树', async () => {
    const big = Array.from({ length: 600 }, (_, i) => file(`f${i}.txt`));
    const r = await collectFiles(async (d) => (d === undefined ? [...big, dir('sub')] : []));
    expect(r.paths).toHaveLength(500);
    expect(r.truncated).toBe(true);
    const r2 = await collectFiles(async (d) => {
      if (d === 'bad') throw new Error('EACCES');
      return d === undefined ? [dir('bad'), file('ok.txt')] : [];
    });
    expect(r2.paths).toEqual(['ok.txt']);
  });
});
