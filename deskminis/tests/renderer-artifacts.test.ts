/** MU2b Task 3：产物 tab（ArtifactsPanel）——collect 纯模块单测 + 组件/chat.ts/FilesPanel/App.vue 源文本守卫。
 *  数据源契约：历史 messages parts[].value = { name, input }（toolUse）；实时 toolCards 补 input（chat.ts 增量）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { collectArtifacts } from '../src/renderer/src/lib/artifacts/collect';

const root = path.resolve(__dirname, '..');
const artifactsPanel = fs.readFileSync(path.join(root, 'src/renderer/src/components/ArtifactsPanel.vue'), 'utf8');
const chatTs = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');
const filesPanel = fs.readFileSync(path.join(root, 'src/renderer/src/components/FilesPanel.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8');

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
  it('ArtifactsPanel.vue：卡列表锚（图标 + 路径 mono + 徽标 +N/−M）+ 空态「本轮还没有产物」+ 点击写 chat.pendingFilePreview 并切 files tab', () => {
    expect(artifactsPanel).toContain("chat.toolCards");
    expect(artifactsPanel).toContain("collectArtifacts");
    expect(artifactsPanel).toContain('本轮还没有产物');
    expect(artifactsPanel).toContain("chat.pendingFilePreview = ");
    expect(artifactsPanel).toContain("switchRightTab");
    expect(artifactsPanel).toContain("'+'");
    expect(artifactsPanel).toContain("'−'");
  });

  it('chat.ts 纯增量：state 追加 pendingFilePreview；toolCards 元素补 input（产物路径数据源）', () => {
    expect(chatTs).toContain("pendingFilePreview: null as string | null");
    expect(chatTs).toContain("input?: string");
  });

  it('FilesPanel 增量守卫：watch chat.pendingFilePreview → 触发既有 showPreview 流程并清空', () => {
    expect(filesPanel).toContain("watch(() => chat.pendingFilePreview");
    expect(filesPanel).toContain("showPreview(");
    expect(filesPanel).toContain("chat.pendingFilePreview = null");
  });

  it("App.vue：rightTab === 'artifacts' 挂 ArtifactsPanel（v-show + visited 模式沿用）；provide switchRightTab", () => {
    expect(app).toContain("import ArtifactsPanel from './components/ArtifactsPanel.vue'");
    expect(app).toContain("v-show=\"rightTab === 'artifacts'\"");
    expect(app).toContain("ArtifactsPanel v-if=\"visited.artifacts\"");
    expect(app).toContain("provide('switchRightTab'");
  });
});
