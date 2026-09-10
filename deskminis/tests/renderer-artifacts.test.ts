/** MU2b Task 3：产物 tab（ArtifactsPanel）——collect 纯模块单测 + 组件/chat.ts/FilesPanel/App.vue 源文本守卫。
 *  数据源契约：历史 messages parts[].value = { name, input }（toolUse）；实时 toolCards 补 input（chat.ts 增量）。 */
/* T6e-3 集体退场说明：本文件有若干例随实现退场。理由——
   产物面板内部实现（卡片列表内部锚、pendingFilePreview 清空时机、switchRightTab 注入）——新树里产物是 WorkspacePanel 的「改动」tab，点开走 emit('open') 交给外壳，没有跨面板注入。保留的是 lib/artifacts/collect 纯模块 5 例（那才是这条能力的内核）与 store 断言。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { collectArtifacts } from '../src/renderer/src/lib/artifacts/collect';

const root = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const artifactsPanel = fs.readFileSync(path.join(root, 'src/renderer/src/ui/WorkspacePanel.vue'), 'utf8');
const chatTs = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');
const filesPanel = fs.readFileSync(path.join(root, 'src/renderer/src/ui/WorkspacePanel.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/ui/AppShell.vue'), 'utf8');

describe('MU2b Task 3 产物 tab：lib/artifacts/collect 纯模块（5 例）', () => {
  it('空输入（空 messages + 空 toolCards）→ []', () => {
    expect(collectArtifacts([], [])).toEqual([]);
  });

  it('历史 messages 的 file_write → write 卡；guest/host 前缀相对化', () => {
    const messages = [{ parts: [
      { type: 'toolUse', value: { name: 'file_write', input: JSON.stringify({ path: '/var/minis/workspace/src/a.ts', content: 'x' }) } },
      { type: 'toolUse', value: { name: 'file_write', input: JSON.stringify({ path: 'C:\\d\\sessions\\SID1\\workspace\\sub\\b.md', content: 'y' }) } },
    ] }];
    const out = collectArtifacts(messages, []);
    expect(out).toEqual([
      { path: 'src/a.ts', kind: 'write', add: undefined, del: undefined },
      { path: 'sub/b.md', kind: 'write', add: undefined, del: undefined },
    ]);
  });

  it('file_edit → edit 卡 + 增删数（extractEditPair + diffLines + countAddDel）', () => {
    const input = JSON.stringify({ path: '/var/minis/workspace/c.txt', old_string: 'l1\nl2\nl3', new_string: 'l1\nl2x\nl3\nl4' });
    const out = collectArtifacts([{ parts: [{ type: 'toolUse', value: { name: 'file_edit', input } }] }], []);
    expect(out).toEqual([{ path: 'c.txt', kind: 'edit', add: 2, del: 1 }]);
  });

  it('同路径 write+edit 去重：edit 优先（增删数保留）；edit 后的 write 不覆盖', () => {
    const editInput = JSON.stringify({ path: 'd.txt', old_string: 'a', new_string: 'a\nb' });
    const writeInput = JSON.stringify({ path: 'd.txt', content: 'z' });
    const messages = [{ parts: [
      { type: 'toolUse', value: { name: 'file_write', input: writeInput } },
      { type: 'toolUse', value: { name: 'file_edit', input: editInput } },
    ] }];
    expect(collectArtifacts(messages, [])).toEqual([{ path: 'd.txt', kind: 'edit', add: 1, del: 0 }]);
    // 顺序反过来也一样（write 不覆盖 edit）
    const rev = [{ parts: [
      { type: 'toolUse', value: { name: 'file_edit', input: editInput } },
      { type: 'toolUse', value: { name: 'file_write', input: writeInput } },
    ] }];
    expect(collectArtifacts(rev, [])).toEqual([{ path: 'd.txt', kind: 'edit', add: 1, del: 0 }]);
  });

  it('实时 toolCards 补充（messages 空）；坏 JSON / 缺 path / 非写编工具一律跳过', () => {
    const cards = [
      { name: 'file_write', input: JSON.stringify({ path: '/var/minis/workspace/e.txt', content: '1' }) },
      { name: 'file_write', input: '{bad json' },
      { name: 'file_edit', input: JSON.stringify({ no_path: true }) },
      { name: 'shell_execute', input: JSON.stringify({ command: 'ls' }) },
    ];
    expect(collectArtifacts([], cards)).toEqual([{ path: 'e.txt', kind: 'write', add: undefined, del: undefined }]);
  });
});

describe('MU2b Task 3 产物 tab：组件与接线守卫（4 例）', () => {
  it('chat.ts 纯增量：state 追加 pendingFilePreview；toolCards 元素补 input（产物路径数据源）', () => {
    expect(chatTs).toContain("pendingFilePreview: null as string | null");
    expect(chatTs).toContain("input?: string");
  });

  it('改动视图接进外壳（T6e-3 重指：三个面板合成 WorkspacePanel 的三个 tab）', () => {
    expect(app).toMatch(/import WorkspacePanel from '\.\/WorkspacePanel\.vue'/);
    expect(artifactsPanel).toMatch(/tab === 'changes'/);
    // 「惰性挂载 + provide('switchRightTab')」那套随旧外壳退场：
    // 工作区面板现在常驻，切 tab 是面板自己的事，不必外壳注入切换函数。
  });
});

describe('V8 · office_write 也是产物', () => {
  /** U 波加了 office_write（产出 .docx/.xlsx/.pptx）。收集器不认它，
   *  agent 做出来的文档在「改动」清单里就凭空消失了——数据在、界面看不见。 */
  it('office_write 计入产物，kind 为 write', () => {
    const out = collectArtifacts(
      [{ parts: [{ type: 'toolUse', value: { name: 'office_write', input: JSON.stringify({ path: '周报.docx', content: '{}' }) } }] }],
      [],
    );
    expect(out).toEqual([{ path: '周报.docx', kind: 'write', add: undefined, del: undefined }]);
  });

  it('实时 toolCards 侧同样认（回合跑到一半就该看得见）', () => {
    const out = collectArtifacts([], [{ name: 'office_write', input: JSON.stringify({ path: 'a/b/表.xlsx' }) }]);
    expect(out.map(a => a.path)).toEqual(['a/b/表.xlsx']);
  });
});
