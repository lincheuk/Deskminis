/** W1a-8：钉住已发布的历史迁移 MIGRATIONS[0..10]。
 *
 *  为什么要钉：迁移 runner 只对 user_version < N 的库跑 MIGRATIONS[0..N-1]。已发布的条目一旦被改，
 *  新装用户和老用户就会得到两种不同的表结构，而老用户的库永远拿不到这次改动——这种分叉不会让任何
 *  现有测试变红（它们都从空库一次跑完）。只有逐条钉内容哈希才挡得住。
 *
 *  哈希对象是字符串本身（utf8）：按 ECMAScript 规范，模板字面量里的 CRLF 会被归一成 LF，
 *  仓库也设了 `* text=auto eol=lf`，所以 Windows / Linux 任何 checkout 下值都一样；
 *  条目之间的注释不在字符串里，改注释不影响哈希。
 *
 *  下面的值是 W1a-8 动手前从 db.ts 源文本独立算出来的（没 import 被测模块），并对照过仓库里
 *  每一个改过 db.ts 的历史版本：[0..10] 在各版本间都只有一个取值。
 *  **红了不许改这里的值**：只允许在 MIGRATIONS 尾部追加新迁移（并给新条目在 PINNED 尾部追加一行）。 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { MIGRATIONS } from '../src/minisd/store/db';

const PINNED: readonly string[] = [
  'fc2e4418679c47d1723bcf005c54339e0c74e2e62f6a99ee14faa8ba7c78ab14', // [0]  M1 sessions / messages / compact_markers
  'ccaaafaea3254832216efd8a739b95c52b33c3081d340aefee2d07c8630e0bcb', // [1]  M2a compact_markers 索引
  '78fe64b2cfdd6d5ab040f86fdf850fc50f5cee067063ca96717a97bc94e07182', // [2]  M2c 技能
  '1ca01d647d7a02d2b7f64af3fc358ea1d33b5fecdb2e8edaf52346e159bd23f7', // [3]  M3b 同步来源列 + 孤儿隔离表
  'bf22f050dd98ed427f2c6dde8d89d749b34f3e555cbc1bf1cec45d1a6b62438c', // [4]  M6 审计 + 设置
  '4ea9d8b980563c3cdfea6205a9e5e68de9e4579586846f65bca60c3f4e19ea2f', // [5]  工作区列
  '09802f85ae8ac514066480c319edcdfadedd30b956c2d7e2a2220e5cd4f3f85b', // [6]  G1 市场缓存
  'e6dbccd43ca7bb9abef948be8c322c182c9969667a1377eae21c9eaae1bb0817', // [7]  G2 市场安装登记
  '84885c752aa7a532e13d7528a07696331db933090cbc3ca4499b3df59b0283f6', // [8]  H1 注释
  'f779174c5ad42ffe73abb73b1b0de321e745802ddc4696359d747f9e3cd0905c', // [9]  J1 助手
  '6b12e4667a736149405f8197875b854ceb71483b99dfd8ec712af682d3db498d', // [10] K1 定时任务
];

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const RULE = '已发布的迁移一个字符都不能改（空白也不行）；只允许在 MIGRATIONS 尾部追加新迁移。';

describe('历史迁移不可变（sha256 钉）', () => {
  it('MIGRATIONS 已导出、冻结，且至少有 11 条', () => {
    expect(Array.isArray(MIGRATIONS), 'MIGRATIONS 必须 export 出来供守卫读取').toBe(true);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(PINNED.length);
    expect(Object.isFrozen(MIGRATIONS), '运行期冻结：任何代码都不能 push / 改写已发布的迁移').toBe(true);
    // 冻结是真冻结：严格模式（ESM）下写入冻结数组直接抛 TypeError
    expect(() => { (MIGRATIONS as string[])[0] = 'DROP TABLE sessions'; }).toThrow(TypeError);
    expect(() => { (MIGRATIONS as string[]).push('SELECT 1'); }).toThrow(TypeError);
  });

  for (let i = 0; i < PINNED.length; i++) {
    it(`MIGRATIONS[${i}] 的 sha256 与钉值一致`, () => {
      expect(sha256(MIGRATIONS[i]), `MIGRATIONS[${i}] 被改动了。${RULE}`).toBe(PINNED[i]);
    });
  }

  it('自证：给 [3] 的副本末尾加一个空格，哈希就不同（守卫对空白改动也会咬人）', () => {
    const copy = [...MIGRATIONS];
    copy[3] = copy[3] + ' ';
    expect(sha256(copy[3])).not.toBe(PINNED[3]);
    expect(sha256(MIGRATIONS[3]), '副本改动不得影响原数组').toBe(PINNED[3]);
  });
});
