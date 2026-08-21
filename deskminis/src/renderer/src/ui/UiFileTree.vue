<script setup lang="ts">
/** T 波：工作区文件树节点（递归）。目录懒加载——展开才拉 files.list，
 *  不预拉整棵（工作区可能是个几万文件的项目目录）。 */
import { ref, watch } from 'vue';
import { rpc } from '../rpc';
import UiIcon from './UiIcon.vue';

interface Node { name: string; path: string; kind: 'dir' | 'file'; size: number; mtime: number }
const props = defineProps<{ node: Node; sessionId: string; depth: number; refreshKey: number; selected: string | null }>();
const emit = defineEmits<{ (e: 'open', path: string): void }>();

const open = ref(false);
const kids = ref<Node[] | null>(null);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try { kids.value = await rpc.call('files.list', { sessionId: props.sessionId, dir: props.node.path }); }
  catch { kids.value = []; }
  finally { loading.value = false; }
}
async function toggle(): Promise<void> {
  if (props.node.kind === 'file') { emit('open', props.node.path); return; }
  open.value = !open.value;
  if (open.value && !kids.value) await load();
}
// 外部刷新（agent 回合结束）：已展开的目录重拉
watch(() => props.refreshKey, () => { if (open.value) void load(); });
</script>

<template>
  <div class="node">
    <button
      class="row" :class="{ on: props.selected === props.node.path }"
      type="button" :style="{ paddingLeft: `${6 + props.depth * 13}px` }" @click="toggle"
    >
      <span class="tw">
        <UiIcon v-if="props.node.kind === 'dir'" :name="open ? 'chevronDown' : 'chevronRight'" :size="12" />
      </span>
      <UiIcon :name="props.node.kind === 'dir' ? 'folder' : 'file'" :size="14" />
      <span class="nm">{{ props.node.name }}</span>
    </button>
    <template v-if="open">
      <div v-if="loading" class="sub">加载中…</div>
      <div v-else-if="kids && !kids.length" class="sub">空目录</div>
      <UiFileTree
        v-for="k in kids ?? []" :key="k.path"
        :node="k" :session-id="props.sessionId" :depth="props.depth + 1"
        :refresh-key="props.refreshKey" :selected="props.selected"
        @open="p => emit('open', p)"
      />
    </template>
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  height: 28px; padding-right: var(--sp-3); border-radius: var(--r-s);
  background: none; color: var(--c-ink-2); cursor: pointer; text-align: left;
  font-size: var(--t-aux-size); font-family: inherit;
}
.row:hover { background: var(--c-bg-2); color: var(--c-ink); }
.row.on { background: var(--c-brand-soft); color: var(--c-ink); font-weight: var(--w-md); }
.tw { width: 12px; flex: 0 0 auto; display: inline-flex; }
.row :deep(svg) { color: var(--c-ink-3); flex: 0 0 auto; }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { padding: 2px 0 2px 30px; font-size: var(--t-aux-size); color: var(--c-ink-3); }
</style>
