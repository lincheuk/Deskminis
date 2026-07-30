<script setup lang="ts">
/** 文件树节点（递归，按文件名自引用）：目录可展开（首次展开时懒加载一层），文件点击发 preview。
 *  refreshKey 由父级在「agent 回合结束 / 手动刷新 / 切会话」时递增：已展开目录重新拉一层。 */
import { ref, watch } from 'vue';
import { rpc } from '../rpc';
import Icon from './Icon.vue';
import type { FileNode } from '../../../minisd/files';

const props = defineProps<{ node: FileNode; sessionId: string; depth: number; refreshKey: number }>();
const emit = defineEmits<{ preview: [path: string] }>();

const expanded = ref(false);
const children = ref<FileNode[] | null>(null); // null = 尚未加载
const loading = ref(false);
const failed = ref('');

async function loadChildren(): Promise<void> {
  loading.value = true;
  failed.value = '';
  try {
    children.value = await rpc.call('files.list', { sessionId: props.sessionId, dir: props.node.path });
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e);
    children.value = null;
  } finally {
    loading.value = false;
  }
}

async function toggle(): Promise<void> {
  if (props.node.kind !== 'dir') { emit('preview', props.node.path); return; }
  expanded.value = !expanded.value;
  if (expanded.value && children.value === null) await loadChildren();
}

watch(() => props.refreshKey, () => { if (expanded.value && children.value !== null) void loadChildren(); });
</script>

<template>
  <div class="node">
    <button class="row" :style="{ paddingLeft: `${6 + depth * 14}px` }" @click="toggle">
      <span class="tw" :class="{ open: expanded, leaf: node.kind !== 'dir' }"><Icon name="chevron-down" :size="12" /></span>
      <span class="fi" :style="{ color: node.kind === 'dir' ? 'var(--orange)' : 'var(--cyan)' }">
        <Icon :name="node.kind === 'dir' ? 'folder' : 'file'" :size="15" />
      </span>
      <span class="nm">{{ node.name }}</span>
    </button>
    <div v-if="expanded && loading" class="hint" :style="{ paddingLeft: `${28 + depth * 14}px` }">加载中…</div>
    <div v-else-if="expanded && failed" class="hint err" :style="{ paddingLeft: `${28 + depth * 14}px` }">{{ failed }}</div>
    <div v-else-if="expanded && children && children.length === 0" class="hint" :style="{ paddingLeft: `${28 + depth * 14}px` }">空目录</div>
    <template v-else-if="expanded && children">
      <FileTreeNode
        v-for="c in children" :key="c.path"
        :node="c" :session-id="sessionId" :depth="depth + 1" :refresh-key="refreshKey"
        @preview="(p: string) => emit('preview', p)"
      />
    </template>
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px 4px 6px;
  background: none; border: none; cursor: pointer; font-family: var(--font-ui);
  font-size: 13px; color: var(--label); text-align: left; border-radius: var(--r-control);
}
.row:hover { background: var(--fill-quaternary); }
.tw { display: inline-flex; flex: 0 0 12px; color: var(--label-tertiary); transform: rotate(-90deg); transition: transform .12s; }
.tw.open { transform: none; }
.tw.leaf { visibility: hidden; }
.fi { display: inline-flex; flex: 0 0 auto; }
.nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.hint { font-size: 12px; color: var(--label-tertiary); padding: 3px 8px; }
.hint.err { color: var(--red); }
</style>
