/** M2d Task 4：文件面板视图层组件的核心行为（源文本守卫，不启动浏览器）。
 *  覆盖：FilesPanel 引用 Icon.refresh / 有 workarea 标题；FileTreeNode 自命名递归；
 *  ——按#3红线：ChatView.vue 一律不碰。 */
/* T6e-3 集体退场说明：本文件有若干例随实现退场。理由——
   文件面板内部实现（预览块、大小/截断读数、树节点内部锚）——新树里预览独立成 ui/PreviewPane.vue、树独立成 ui/UiFileTree.vue，面板本身只剩 tab 与绑定行。这些例锚的是**旧面板的内脏**，没有一一对应物。新落点的守卫：tests/renderer-workspace-shell.test.ts（9 例，含 T6b 补回的绑定入口）与本文件保留的树/图标例。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const filesPanel = fs.readFileSync(path.join(root, 'src/renderer/src/ui/WorkspacePanel.vue'), 'utf8');
const fileTreeNode = fs.readFileSync(path.join(root, 'src/renderer/src/ui/UiFileTree.vue'), 'utf8');
const icon = fs.readFileSync(path.join(root, 'src/renderer/src/components/Icon.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/ui/AppShell.vue'), 'utf8');
const chatView = fs.readFileSync(path.join(root, 'src/renderer/src/ui/StageChat.vue'), 'utf8');

describe('M2d Task 4 文件面板（组件源文本守卫，5 例）', () => {
  it('Step 1: Icon.vue PATHS 末追加 refresh 路径；保留 M2c edit/provider 图标（#2 红线：只增量）', () => {
    expect(icon).toContain("refresh: '<path d=\"M21 12a9 9 0 11-2.64-6.36M21 3v6h-6\"/>'");
    expect(icon).toContain("edit: '");
    expect(icon).toContain("pencil: '");
    expect(icon).toContain("gear: '");
  });

});
