import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 依赖冻结守卫（W1a-1 · 止血波设计稿 §0「不做：新 npm 依赖」，交接文档 §2 第 1 条「零新 npm 依赖」）。
//
// 为什么要有：这条纪律此前只靠人记。tests/ 里只有两条单点检查（auto-update 的 electron-updater、
// build-config 的 @electron/rebuild），加一个新包、悄悄升一个版本范围、或者清单和锁文件对不上，
// 都要等到 Windows 真机 `npm ci` 才会炸。这里把清单整体钉成快照，Linux 上就能报出来。
//
// 确需改依赖时：先征得用户点头，再同步改下面的 FROZEN，并在 commit 正文申报（docs/RELEASE.md §6）。
// 只比对 dependencies / devDependencies 与锁根的同名字段；锁根的 version / license 元数据归
// tests/license-consistency.test.ts 管，两边互不牵扯。

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(appRoot, rel), 'utf8')) as Record<string, unknown>;

type DepMap = Record<string, string>;

/** 2026-09-24 的依赖清单，逐字照抄 package.json（11 条 + 14 条）。 */
const FROZEN: { dependencies: DepMap; devDependencies: DepMap } = {
  dependencies: {
    '@napi-rs/keyring': '^1.3.0',
    '@noble/ciphers': '^2.2.0',
    '@noble/curves': '^2.2.0',
    '@noble/hashes': '^2.2.0',
    '@xterm/addon-fit': '^0.11.0',
    '@xterm/xterm': '^6.0.0',
    'better-sqlite3': '^12.11.1',
    'electron-updater': '^6.8.9',
    undici: '^8.9.0',
    ws: '^8.21.1',
    yauzl: '^2.10.0',
  },
  devDependencies: {
    '@electron/rebuild': '^4.2.0',
    '@types/better-sqlite3': '^7.6.13',
    '@types/node': '^26.1.1',
    '@types/ws': '^8.18.1',
    '@types/yauzl': '^2.10.3',
    '@vitejs/plugin-vue': '^6.0.8',
    'cross-env': '^10.1.0',
    electron: '^38.8.6',
    'electron-builder': '^26.15.3',
    'electron-vite': '^4.0.1',
    pinia: '^3.0.4',
    typescript: '^5.9.3',
    vitest: '^3.2.7',
    vue: '^3.5.40',
  },
};

/** 这些键会绕开上面两张表引入或改写依赖（可选依赖、对等依赖、打包依赖、版本覆盖），一律不许出现。 */
const FORBIDDEN_KEYS = [
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'overrides',
  'resolutions',
] as const;

/** 清单差异，失败信息用：`+ 名@范围` 新增，`- 名@范围` 删除，`~ 名 旧→新` 改了范围。按包名排序，输出稳定。 */
function diffDeps(actual: DepMap, frozen: DepMap): string[] {
  // 用 Object.hasOwn：普通对象上 'constructor' 这类名字经原型链「存在」，in / 下标取值都会误判成已有依赖。
  const names = [...new Set([...Object.keys(actual), ...Object.keys(frozen)])].sort();
  const out: string[] = [];
  for (const name of names) {
    const inActual = Object.hasOwn(actual, name);
    const inFrozen = Object.hasOwn(frozen, name);
    if (inActual && !inFrozen) out.push(`+ ${name}@${actual[name]}`);
    else if (!inActual && inFrozen) out.push(`- ${name}@${frozen[name]}`);
    else if (actual[name] !== frozen[name]) out.push(`~ ${name} ${frozen[name]}→${actual[name]}`);
  }
  return out;
}

function explain(where: string, diff: string[]): string {
  return (
    `依赖清单变了（${where}）：${diff.join('；')}。` +
    '本项目零新依赖，确需变更须用户点头，然后同步改本快照并在 commit 正文申报'
  );
}

const depsOf = (obj: Record<string, unknown>, field: 'dependencies' | 'devDependencies'): DepMap =>
  (obj[field] ?? {}) as DepMap;

describe('diffDeps（失败信息生成器）', () => {
  it('新增记 +，删除记 -，改范围记 ~ 旧→新', () => {
    expect(diffDeps({ a: '1' }, {})).toEqual(['+ a@1']);
    expect(diffDeps({}, { a: '1' })).toEqual(['- a@1']);
    expect(diffDeps({ a: '2' }, { a: '1' })).toEqual(['~ a 1→2']);
  });

  it('没变化时为空；多项变化按包名排序', () => {
    expect(diffDeps({ a: '1', b: '2' }, { b: '2', a: '1' })).toEqual([]);
    expect(diffDeps({ ws: '^8.21.2', 'left-pad': '^1.3.0' }, { ws: '^8.21.1', yauzl: '^2.10.0' })).toEqual([
      '+ left-pad@^1.3.0',
      '~ ws ^8.21.1→^8.21.2',
      '- yauzl@^2.10.0',
    ]);
  });

  it('原型链上的名字不算已有依赖', () => {
    expect(diffDeps({ constructor: '1' }, {})).toEqual(['+ constructor@1']);
  });
});

describe('依赖冻结：package.json', () => {
  const pkg = readJson('package.json');

  for (const field of ['dependencies', 'devDependencies'] as const) {
    it(`${field} 与快照一致`, () => {
      const diff = diffDeps(depsOf(pkg, field), FROZEN[field]);
      expect(diff, explain(`package.json ${field}`, diff)).toEqual([]);
      expect(depsOf(pkg, field)).toStrictEqual(FROZEN[field]);
    });
  }

  it('没有绕开快照的依赖类键', () => {
    const present = FORBIDDEN_KEYS.filter((k) => Object.hasOwn(pkg, k));
    expect(present, `package.json 出现了 ${present.join('、')}——这些键同样会引入或改写依赖，零新依赖纪律一并禁止`).toEqual([]);
  });
});

describe('依赖冻结：package-lock.json 与清单同步', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const packages = (lock.packages ?? {}) as Record<string, Record<string, unknown>>;
  const root = packages[''] ?? {};

  it('锁文件是 lockfileVersion 3（下面的比对依赖 packages[""] 的结构）', () => {
    expect(lock.lockfileVersion, 'npm 换了锁文件格式——先核对 packages[""] 结构是否仍同，再改本断言').toBe(3);
  });

  for (const field of ['dependencies', 'devDependencies'] as const) {
    it(`packages[""].${field} 与 package.json 完全一致`, () => {
      const diff = diffDeps(depsOf(root, field), depsOf(pkg, field));
      expect(
        diff,
        `锁文件根与 package.json 的 ${field} 对不上（+ 只在锁里，- 只在清单里，~ 清单→锁）：${diff.join('；')}。` +
          'Windows 上 npm ci 会直接拒绝这样的锁文件',
      ).toEqual([]);
    });
  }

  it('锁根也没有绕开快照的依赖类键', () => {
    const present = FORBIDDEN_KEYS.filter((k) => Object.hasOwn(root, k));
    expect(present).toEqual([]);
  });

  it('每个直接依赖在锁里都有解析条目', () => {
    const direct = [...Object.keys(FROZEN.dependencies), ...Object.keys(FROZEN.devDependencies)];
    const missing = direct.filter((name) => typeof packages[`node_modules/${name}`]?.version !== 'string');
    expect(missing, `锁文件缺这些直接依赖的解析条目：${missing.join('、')}——npm ci 装不出来`).toEqual([]);
  });
});
