/** MU2a Task 7：diff 视图（设计 §5.4）——lib/diff/lcs.ts + lib/diff/payload.ts 纯模块（11 例）
 *  + DiffView/ToolLine/tokens 源文本守卫（3 例）。守卫工具：源文本读取统一归一化 CRLF→LF。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffLines, collapseCtx, countAddDel, MAX_LCS_LINES } from '../src/renderer/src/lib/diff/lcs';
import { extractEditPair } from '../src/renderer/src/lib/diff/payload';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const diffView = R('../src/renderer/src/components/DiffView.vue');
const toolLine = R('../src/renderer/src/components/ToolLine.vue');
const tokens = R('../src/renderer/src/styles/tokens.css');

describe('MU2a Task 7 diffLines（6 例）', () => {
  it('同文件 → 全 ctx，行号双轨同步', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc');
    expect(lines).toEqual([
      { type: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'ctx', text: 'b', oldNo: 2, newNo: 2 },
      { type: 'ctx', text: 'c', oldNo: 3, newNo: 3 },
    ]);
  });

  it('纯插入：old 空串 → 全 add（新建文件）', () => {
    const lines = diffLines('', 'x\ny');
    expect(lines).toEqual([
      { type: 'add', text: 'x', newNo: 1 },
      { type: 'add', text: 'y', newNo: 2 },
    ]);
  });

  it('纯删除：new 空串 → 全 del（清空文件）', () => {
    const lines = diffLines('x\ny', '');
    expect(lines).toEqual([
      { type: 'del', text: 'x', oldNo: 1 },
      { type: 'del', text: 'y', oldNo: 2 },
    ]);
  });

  it('中段替换：前后 ctx 夹 del/add 配对', () => {
    const lines = diffLines('keep1\nold-line\nkeep2', 'keep1\nnew-line\nkeep2');
    expect(lines).toEqual([
      { type: 'ctx', text: 'keep1', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'old-line', oldNo: 2 },
      { type: 'add', text: 'new-line', newNo: 2 },
      { type: 'ctx', text: 'keep2', oldNo: 3, newNo: 3 },
    ]);
  });

  it('\\r\\n 归一：CRLF 与 LF 同内容 → 全 ctx', () => {
    const lines = diffLines('a\r\nb\r\n', 'a\nb\n');
    expect(lines.every(l => l.type === 'ctx')).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it(`超 ${MAX_LCS_LINES} 行降级整段替换：旧全 del 新全 add、无 ctx（性能闸）`, () => {
    const oldS = Array.from({ length: MAX_LCS_LINES + 1 }, (_, i) => `o${i}`).join('\n');
    const newS = Array.from({ length: MAX_LCS_LINES + 1 }, (_, i) => `n${i}`).join('\n');
    const lines = diffLines(oldS, newS);
    expect(lines.some(l => l.type === 'ctx')).toBe(false);
    expect(lines.filter(l => l.type === 'del')).toHaveLength(MAX_LCS_LINES + 1);
    expect(lines.filter(l => l.type === 'add')).toHaveLength(MAX_LCS_LINES + 1);
  });
});

describe('MU2a Task 7 collapseCtx + countAddDel（2 例）', () => {
  it('collapseCtx：上下文 >2*keep 折中段；边界不足不折', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'ctx' as const, text: `c${i}`, oldNo: i + 1, newNo: i + 1 }));
    // 单段 8 行 ctx → keep2：头 2 + fold 4 + 尾 2；尾段 4 行 ctx（=2*keep）不折
    const lines = [...mk(8), { type: 'del' as const, text: 'x', oldNo: 9 }, ...mk(4).map(l => ({ ...l, oldNo: l.oldNo! + 9, newNo: l.newNo! + 8 }))];
    const out = collapseCtx(lines, 2);
    const fold = out.find(l => l.type === 'fold');
    expect(fold).toEqual({ type: 'fold', count: 4 });
    // 折叠行位置：前段 keep 2 行（c0/c1）之后、尾段 keep 2 行（c6/c7）之前，再后才是 del
    const foldIdx = out.findIndex(l => l.type === 'fold');
    expect(out[foldIdx - 1]).toMatchObject({ type: 'ctx', text: 'c1' });
    expect(out[foldIdx + 1]).toMatchObject({ type: 'ctx', text: 'c6' });
    expect(out[foldIdx + 3]).toMatchObject({ type: 'del', text: 'x' });
    // 4 行 ctx（=2*keep）不折
    const small = collapseCtx([...mk(2), { type: 'add' as const, text: 'y', newNo: 3 }, ...mk(2)], 2);
    expect(small.some(l => l.type === 'fold')).toBe(false);
  });

  it('countAddDel：只数 add/del，ctx 不计', () => {
    const lines = diffLines('a\nb\nc', 'a\nx\nc\ny');
    expect(countAddDel(lines)).toEqual({ add: 2, del: 1 });
  });
});

describe('MU2a Task 7 extractEditPair（3 例）', () => {
  it('正常提取 + guest 路径相对化（workspace 去前缀，其它 ns 留名）', () => {
    const p1 = extractEditPair(JSON.stringify({ path: '/var/minis/workspace/docs/a.txt', old_string: 'o', new_string: 'n' }));
    expect(p1).toEqual({ path: 'docs/a.txt', oldStr: 'o', newStr: 'n' });
    const p2 = extractEditPair(JSON.stringify({ path: '/var/minis/memory/profile.md', old_string: 'o' }));
    expect(p2).toEqual({ path: 'memory/profile.md', oldStr: 'o', newStr: '' }); // new_string 缺省 → ''
    const p3 = extractEditPair(JSON.stringify({ path: 'rel/a.txt', old_string: 'o', new_string: 'n' }));
    expect(p3!.path).toBe('rel/a.txt'); // 相对路径原样
  });

  it('Windows 绝对路径：数据根 sessions/<sid>/<bucket>/ 结构前缀剥掉（反斜杠归一）', () => {
    const abs = 'C:\\Users\\x\\AppData\\Roaming\\DeskMinis\\sessions\\SID-1\\workspace\\sub\\a.txt';
    const p = extractEditPair(JSON.stringify({ path: abs, old_string: 'o', new_string: 'n' }));
    expect(p!.path).toBe('sub/a.txt');
    expect(p!.path).not.toContain('DeskMinis');
    expect(p!.path).not.toContain('AppData');
  });

  it('坏 JSON / 缺 path / 缺 old_string → null（回落 JSON 展开）', () => {
    expect(extractEditPair('not json')).toBeNull();
    expect(extractEditPair(JSON.stringify({ old_string: 'o' }))).toBeNull();
    expect(extractEditPair(JSON.stringify({ path: 'a.txt' }))).toBeNull();
    expect(extractEditPair(null)).toBeNull();
    expect(extractEditPair(undefined)).toBeNull();
  });
});

describe('MU2a Task 7 DiffView 守卫（3 例）', () => {
  it('DiffView.vue：props 契约 + 文件头槽（path mono + +N/−M 徽标）+ 行列表 + 折叠行锚 + 状态槽底色', () => {
    expect(diffView).toContain('path: string');
    expect(diffView).toContain('addCount: number');
    expect(diffView).toContain('delCount: number');
    expect(diffView).toContain('lines:');
    expect(diffView).toContain('class="diff-head"');
    expect(diffView).toContain('class="path"');
    expect(diffView).toContain('class="diff-badge"');
    expect(diffView).toContain('class="diff-row fold"');
    expect(diffView).toContain('class="ln"'); // 行号
    expect(diffView).toContain('var(--state-ok-bg)');
    expect(diffView).toContain('var(--state-err-bg)');
    expect(diffView).toContain('collapseCtx(');
  });

  it('ToolLine 接线：file_edit 且 extractEditPair 命中 → DiffView；否则原参数/输出区', () => {
    expect(toolLine).toContain("import DiffView from './DiffView.vue'");
    expect(toolLine).toContain('extractEditPair(');
    expect(toolLine).toContain("props.name === 'file_edit'");
    expect(toolLine).toContain('diffLines(');
    expect(toolLine).toContain('countAddDel(');
    expect(toolLine).toContain('<DiffView');
  });

  it('tokens.css 四段语义槽：--state-ok-bg / --state-err-bg 各 4 处（浅/媒体暗/强制暗/强制浅）', () => {
    expect(tokens.match(/--state-ok-bg:/g)).toHaveLength(4);
    expect(tokens.match(/--state-err-bg:/g)).toHaveLength(4);
    expect(tokens).toContain('--state-ok-bg: var(--success-subtle)'); // MU3 §3-3：Appica 直给 alpha，color-mix 清零
    expect(tokens).toContain('--state-err-bg: var(--error-subtle)');
  });
});
