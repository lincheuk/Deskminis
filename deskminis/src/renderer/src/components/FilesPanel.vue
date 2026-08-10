<script setup lang="ts">
/** 右栏 · 文件面板（设计 §7）——会话工作区文件树（懒加载）+ 文本预览。
 *  数据全部经 files.* RPC（minisd 为唯一事实源）；本组件只缓存「已展开的目录」这一视图状态。
 *  agent 回合结束（running 真→假）自动刷新根与已展开目录；外部挂载树在 M2 后续里程碑补（计划决策 4）。 */
import { onMounted, ref, watch } from 'vue';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import FileTreeNode from './FileTreeNode.vue';
import Icon from './Icon.vue';
import type { FileNode, FilePreview } from '../../../minisd/files';

const chat = useChat();
const root = ref<FileNode[] | null>(null);
const loading = ref(false);
const failed = ref('');
const refreshKey = ref(0);
const preview = ref<FilePreview | null>(null);
const previewLoading = ref(false);
const previewFailed = ref('');

async function loadRoot(): Promise<void> {
  if (!chat.activeId) { root.value = null; return; }
  loading.value = true;
  failed.value = '';
  try {
    root.value = await rpc.call('files.list', { sessionId: chat.activeId });
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e);
    root.value = null;
  } finally {
    loading.value = false;
  }
}

function refreshAll(): void {
  refreshKey.value++; // 已展开目录经 FileTreeNode 的 watch 重拉
  void loadRoot();
}

async function showPreview(path: string): Promise<void> {
  previewLoading.value = true;
  previewFailed.value = '';
  preview.value = null;
  try {
    preview.value = await rpc.call('files.read', { sessionId: chat.activeId, path });
  } catch (e) {
    previewFailed.value = e instanceof Error ? e.message : String(e);
  } finally {
    previewLoading.value = false;
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

watch(() => chat.activeId, () => {
  preview.value = null;
  previewFailed.value = '';
  refreshKey.value++;
  void loadRoot();
});
// 回合落盘结束 → 工作区可能已被 agent 改动：自动刷新（免手动）
watch(() => chat.running, (now, prev) => { if (prev && !now) refreshAll(); });
// MU2b Task 3：产物卡点击 → chat.pendingFilePreview 写入相对路径，此处走既有 preview 流程并清空
watch(() => chat.pendingFilePreview, (p) => {
  if (!p) return;
  chat.pendingFilePreview = null;
  void showPreview(p);
});
onMounted(() => {
  void loadRoot();
  // 产物卡点击时本面板可能尚未挂载（App.vue v-show + visited 懒挂载）：watch 不触发，挂载即消费待预览
  if (chat.pendingFilePreview) {
    const p = chat.pendingFilePreview;
    chat.pendingFilePreview = null;
    void showPreview(p);
  }
});
</script>

<template>
  <div class="fpanel">
    <div class="fhead">
      <span class="ftitle">工作区</span>
      <button class="fbtn" title="刷新" @click="refreshAll"><Icon name="refresh" :size="14" /></button>
    </div>
    <div class="ftree">
      <div v-if="!chat.activeId" class="fhint">先在左栏选择一个会话</div>
      <div v-else-if="loading && !root" class="fhint">加载中…</div>
      <div v-else-if="failed" class="fhint err">{{ failed }}</div>
      <div v-else-if="root && root.length === 0" class="fhint">工作区为空<br />agent 创建的文件会出现在这里</div>
      <FileTreeNode
        v-for="n in root ?? []" :key="n.path"
        :node="n" :session-id="chat.activeId" :depth="0" :refresh-key="refreshKey"
        @preview="showPreview"
      />
    </div>
    <div v-if="preview || previewLoading || previewFailed" class="fprev">
      <div class="phead">
        <span class="pname">{{ preview?.path ?? '读取中…' }}</span>
        <button class="fbtn" title="关闭预览" @click="preview = null; previewFailed = ''"><Icon name="x" :size="13" /></button>
      </div>
      <div v-if="previewLoading" class="fhint">读取中…</div>
      <div v-else-if="previewFailed" class="fhint err">{{ previewFailed }}</div>
      <template v-else-if="preview">
        <div class="pmeta">
          {{ fmtSize(preview.size) }}<template v-if="preview.truncated"> · 超过 256KB，仅显示前缀</template>
        </div>
        <div v-if="preview.binary" class="fhint">二进制文件不可预览</div>
        <pre v-else class="pbody">{{ preview.content }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.fpanel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fhead {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: .5px solid var(--separator); flex: 0 0 auto;
}
.ftitle { font-size: 13px; font-weight: 600; color: var(--label-strong); }
.fbtn {
  background: none; border: none; color: var(--label-secondary); cursor: pointer;
  display: inline-flex; padding: 4px; border-radius: var(--r-control);
}
.fbtn:hover { background: var(--fill-quaternary); color: var(--label); }
.ftree { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px; }
.fhint { font-size: 12px; color: var(--label-tertiary); padding: 12px; text-align: center; line-height: 1.6; }
.fhint.err { color: var(--red); }
.fprev {
  flex: 0 0 auto; max-height: 45%; display: flex; flex-direction: column;
  border-top: .5px solid var(--separator); background: var(--grouped-bg-secondary);
}
.phead { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px 4px; }
.pname { font-size: 12px; font-weight: 600; font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pmeta { font-size: 11px; color: var(--label-tertiary); padding: 0 12px 6px; font-variant-numeric: tabular-nums; }
.pbody {
  flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 0 12px 10px;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: var(--label);
  white-space: pre-wrap; word-break: break-word;
}
</style>
