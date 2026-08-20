import { describe, it, expect } from 'vitest';
import { skeletonWithMap, matchQuote, resolveOffsets, absoluteOffset } from '../src/renderer/src/lib/annotations/anchor';

/** H2 选区锚定纯核心（设计稿 §1-1/§2）。
 *  关键决策：匹配域 = 去除**全部**空白的骨架 + 偏移映射表。
 *  为什么不是「空白折叠为单空格」：块级边界处 selection.toString() 有合成换行，
 *  而 textContent 没有任何分隔（两个 <p> 相邻即"甲。乙。"）——折叠成单空格两边仍不等，
 *  唯有去尽空白才能让「选区文本」与「容器文本」进同一匹配域；中文正文本就无空格，零损失。 */

// 极简节点桩：resolveOffsets/absoluteOffset 是 DOM 形状无关的（只看 nodeType/childNodes/data），
// node 环境用对象字面量即可真测跨节点行为，不需要 jsdom。
const t = (data: string) => ({ nodeType: 3, data });
const el = (...childNodes: any[]) => ({ nodeType: 1, childNodes });

describe('skeletonWithMap', () => {
  it('去尽空白并保留原始偏移映射', () => {
    const { skel, map } = skeletonWithMap('a b\n\nc\td');
    expect(skel).toBe('abcd');
    expect(map).toEqual([0, 2, 5, 7]);
  });
  it('纯空白 → 空骨架', () => {
    expect(skeletonWithMap(' \n\t ').skel).toBe('');
  });
});

describe('matchQuote', () => {
  it('块级边界：选区带合成换行、容器无分隔，仍然命中', () => {
    // 容器渲染文本（两个 <p> 的 textContent 相邻）vs 选区文本（toString 带 \n）
    const raw = '第一段结论。第二段开头';
    const m = matchQuote(raw, { exact: '段结论。\n第二段' });
    expect(m).toEqual({ start: 2, end: 9 });
  });
  it('exact 多处出现时 prefix+suffix 全串消歧命中第二处', () => {
    const raw = '甲说对。乙说对。丙说错。';
    const m = matchQuote(raw, { exact: '说对。', prefix: '乙', suffix: '丙' });
    expect(m).toEqual({ start: 5, end: 8 });
  });
  it('全串失配退 exact 首个命中', () => {
    const raw = '甲说对。乙说对。';
    const m = matchQuote(raw, { exact: '说对。', prefix: '早已不存在的前文', suffix: '' });
    expect(m).toEqual({ start: 1, end: 4 });
  });
  it('端点映射回原始偏移：命中段内含空白时 end 覆盖到原文末字符', () => {
    const raw = 'AB  CD EF';
    const m = matchQuote(raw, { exact: 'B CD' });
    // 骨架 'BCD' 映射回原文 [1, 6)——含中间两个空格
    expect(m).toEqual({ start: 1, end: 6 });
  });
  it('exact 空白化为空 / 整体不命中 → null', () => {
    expect(matchQuote('abc', { exact: ' \n ' })).toBeNull();
    expect(matchQuote('abc', { exact: 'xyz' })).toBeNull();
  });
});

describe('resolveOffsets / absoluteOffset（跨节点，DOM 形状无关）', () => {
  it('偏移跨行内节点边界解析到正确的文本节点', () => {
    // <div>前<strong>中段</strong>后</div>
    const t1 = t('前'); const t2 = t('中段'); const t3 = t('后');
    const root = el(t1, el(t2), t3);
    const r = resolveOffsets(root as any, 1, 3);
    expect(r).not.toBeNull();
    expect(r!.start.node).toBe(t2);
    expect(r!.start.offset).toBe(0);
    expect(r!.end.node).toBe(t2);
    expect(r!.end.offset).toBe(2);
  });
  it('end 恰在节点末尾/root 文本长度处仍可解析', () => {
    const t1 = t('ab'); const root = el(t1);
    const r = resolveOffsets(root as any, 0, 2);
    expect(r!.end.node).toBe(t1);
    expect(r!.end.offset).toBe(2);
  });
  it('越界 → null', () => {
    expect(resolveOffsets(el(t('ab')) as any, 0, 3)).toBeNull();
  });
  it('absoluteOffset 是 resolveOffsets 的逆：文本节点内偏移 → 容器绝对偏移', () => {
    const t1 = t('前'); const t2 = t('中段'); const t3 = t('后');
    const root = el(t1, el(t2), t3);
    expect(absoluteOffset(root as any, t2 as any, 1)).toBe(2);
    expect(absoluteOffset(root as any, t3 as any, 0)).toBe(3);
  });
  it('absoluteOffset 收元素节点（selection 端点可为元素+子下标）：算前 N 个孩子的文本长', () => {
    const t1 = t('前'); const inner = el(t('中段')); const t3 = t('后');
    const root = el(t1, inner, t3);
    // (root, 2) = 前两个孩子之后 = '前中段' 之后 = 3
    expect(absoluteOffset(root as any, root as any, 2)).toBe(3);
  });
});
