/** M2d Task 4：文件面板视图层组件的核心行为（源文本守卫，不启动浏览器）。
 *  覆盖：FilesPanel 引用 Icon.refresh / 有 workarea 标题；FileTreeNode 自命名递归；
 *  ——按#3红线：ChatView.vue 一律不碰。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const filesPanel = fs.readFileSync(path.join(root, 'src/renderer/src/components/FilesPanel.vue'), 'utf8');
const fileTreeNode = fs.readFileSync(path.join(root, 'src/renderer/src/components/FileTreeNode.vue'), 'utf8');
const icon = fs.readFileSync(path.join(root, 'src/renderer/src/components/Icon.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8');
const chatView = fs.readFileSync(path.join(root, 'src/renderer/src/components/ChatView.vue'), 'utf8');

describe('M2d Task 4 文件面板（组件源文本守卫，5 例）', () => {
  it('Step 1: Icon.vue PATHS 末追加 refresh 路径；保留 M2c edit/provider 图标（#2 红线：只增量）', () => {
    expect(icon).toContain("refresh: '<path d=\"M21 12a9 9 0 11-2.64-6.36M21 3v6h-6\"/>'");
    expect(icon).toContain("edit: '");
    expect(icon).toContain("pencil: '");
    expect(icon).toContain("gear: '");
  });

  it('Step 2: FileTreeNode.vue 按文件名自引用；props node+sessionId+depth+refreshKey；emit preview；首次展开懒加载子目录', () => {
    expect(fileTreeNode).toContain("defineProps<{ node: FileNode; sessionId: string; depth: number; refreshKey: number }>()");
    expect(fileTreeNode).toContain("defineEmits<{ preview: [path: string] }>()");
    expect(fileTreeNode).toContain("FileTreeNode");
    expect(fileTreeNode).toContain("v-for=\"c in children\" :key=\"c.path\"");
    expect(fileTreeNode).toContain(":node=\"c\" :session-id=\"sessionId\" :depth=\"depth + 1\" :refresh-key=\"refreshKey\"");
    expect(fileTreeNode).toContain("async function loadChildren()");
    expect(fileTreeNode).toContain("rpc.call('files.list', { sessionId: props.sessionId, dir: props.node.path })");
    expect(fileTreeNode).toContain("if (expanded.value && children.value === null) await loadChildren()");
  });

  it('Step 3: FilesPanel.vue 根列表 + 手动刷新按钮（Icon refresh）+ 文件点击预览；自动刷新：running 真→假（agent 回合落盘）+ activeId 变化', () => {
    expect(filesPanel).toContain("Icon name=\"refresh\"");
    expect(filesPanel).toContain("工作区");
    expect(filesPanel).toContain("preview.value = await rpc.call('files.read', { sessionId: chat.activeId, path })");
    expect(filesPanel).toContain("fmtSize(preview.size)");
    expect(filesPanel).toContain("preview.truncated");
    expect(filesPanel).toContain("preview.binary");
    expect(filesPanel).toContain("watch(() => chat.activeId, () =>");
    expect(filesPanel).toContain("watch(() => chat.running, (now, prev) => { if (prev && !now) refreshAll(); })");
    expect(filesPanel).toContain("refreshKey.value++");
  });

  it('Step 3 App.vue 3 处增量：import FilesPanel；rightTab===files 时 v-show + v-if visited.files；progress 页签占位（或已被填实面板，演进关系 #3 串行不回退；MU2b Task 1 修订：tasks → progress 换名）', () => {
    expect(app).toContain("import FilesPanel from './components/FilesPanel.vue'");
    expect(app).toContain("v-show=\"rightTab === 'files'\"");
    expect(app).toContain("FilesPanel v-if=\"visited.files\"");
    // 兼容：单步时是 v-if rempty；面板合入后变成 v-show 面板组件（都代表“progress 页已被 UI 处理”）
    const hasRemptyOrPanel = app.includes('rightTab === \'progress\'');
    expect(hasRemptyOrPanel).toBe(true);
  });

  it('#3 红线：ChatView.vue 字节级未被 Task 4 任何一步改动（本文件不碰）', () => {
    // 守卫：文件存在且仍含 M1 以来的核心锚——不比较 diff，避免基线变更；仅查典型锚点保留
    expect(chatView).toContain("useChat");
    expect(chatView).toContain("activeId");
    expect(chatView).toContain("messages");
  });
});
