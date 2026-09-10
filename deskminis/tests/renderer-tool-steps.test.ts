/** T6e-2 补搬守卫：工具步骤要看得见「调了什么」。
 *
 *  立项事实（T6 清场时实测）：T 波换壳把工具行重做成 `ui/StepGroup.vue`，
 *  但 `Step` 接口只有 `{name,title,ok,output}`——**连 `input` 字段都没有**。
 *  旧 `components/ToolLine.vue` 有的两样东西一起丢了：
 *    ① `file_edit` 展开渲成差分视图（`extractEditPair` + `DiffView`，路径还做了相对化）；
 *    ② 提不出载荷时回落「参数」JSON 区。
 *  结果：agent 改了文件，界面上只有一段 output，看不到改的是哪个文件、改了什么。
 *
 *  数据一直在手边——`stores/chat.ts` 的 `toolCards` 带 `input`，历史消息路径上
 *  `StageChat.vue` 甚至读了 `input.tool_title` 当标题、**把剩下的整个对象扔了**。
 *  所以这不是「能力没实现」，是**映射时顺手丢字段**，本文件钉住两条链路都别再丢。
 *
 *  ⚠️ 手法边界（与 mu6 守卫同一句话）：源码文本守卫只能证明「传下去了」，
 *  证明不了「点开真的看得见」。实拍 `drive-t6e.mjs` 不可被本文件替代。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string =>
  fs.readFileSync(path.join(root, 'src/renderer/src/', p), 'utf8').replace(/\r\n/g, '\n');

const group = read('ui/StepGroup.vue');
const stage = read('ui/StageChat.vue');

describe('T6e-2 工具步骤展开区：file_edit 走差分，其余回落参数（4 例）', () => {
  it('StepGroup 的 Step 接口必须带 input——字段不在，后面全是空谈', () => {
    const iface = group.match(/interface Step \{[^}]*\}/)?.[0] ?? '';
    expect(iface).not.toBe('');
    expect(iface).toMatch(/input\?:\s*string/);
  });

  it('StepGroup 复用既有的 extractEditPair / diffLines / UiDiff，不自造一套', () => {
    // 这三样都现成且已测（lib/diff/payload.ts、lib/diff/lcs.ts、ui/UiDiff.vue）。
    // 自己再写一份路径相对化或差分算法 = 把已测逻辑换成未测逻辑，正是 T6e-1 记过的那笔账。
    expect(group).toMatch(/from\s+'\.\.\/lib\/diff\/payload'/);
    expect(group).toMatch(/from\s+'\.\.\/lib\/diff\/lcs'/);
    expect(group).toContain('extractEditPair');
    expect(group).toMatch(/import UiDiff from '\.\/UiDiff\.vue'/);
    expect(group).toContain('<UiDiff');
  });

  it('提不出载荷时回落「参数」区，而不是什么都不显示', () => {
    // 旧 ToolLine 的回落链：editPair 出得来走 DiffView，否则参数 JSON + 输出，都没有才「无内容」。
    // 只做 file_edit 一种、别的工具展开一片空白，等于换了个方式继续瞒着用户。
    expect(group).toContain('参数');
    expect(group).toMatch(/JSON\.parse/);   // 参数要 pretty 打印，原始单行 JSON 没法读
  });

  it('参数区必须截断——载荷可能是整个文件内容，撑爆的是用户的滚动条', () => {
    // output 那边本来就 slice(0, 2000)，参数区漏了截断的话，一次 file_write 大文件就把对话撑没了。
    const slices = [...group.matchAll(/\.slice\(0,\s*\d+\)/g)].length;
    expect(slices).toBeGreaterThanOrEqual(2);
  });
});

describe('T6e-2 两条链路都要把 input 传下去（2 例）', () => {
  it('实时路径：toolCards 映射必须带 input', () => {
    // chat.toolCards 在 toolStart 时就存了 input，映射里不写这一行就等于当场扔掉。
    const map = stage.match(/chat\.toolCards\.map\([\s\S]{0,300}?\)\)/)?.[0] ?? '';
    expect(map).not.toBe('');
    expect(map).toMatch(/input:/);
  });

  it('历史路径：step 字面量必须带 input（同一处已经读了 input.tool_title）', () => {
    // 回归锚：这里原本写着 `p.value.input.tool_title` 取标题，取完把 p.value.input 整个丢了——
    // 数据就在手上却不往下传，是本次补搬里最容易再犯的一种。
    const lit = stage.match(/const step: Step = \{[\s\S]*?\};/)?.[0] ?? '';
    expect(lit).not.toBe('');
    expect(lit).toMatch(/input:/);
  });
});
