<script setup lang="ts">
/** T 波：右侧工作区面板（用户参考图的 Workspace 栏）。两个 tab：
 *  **文件**——会话工作区文件树（懒加载）；**改动**——本会话 agent 写过的文件清单。
 *  「改动」这一 tab 是参考图里的 Changes：agent 干了什么，一眼可查、可点开对照。 */
import { computed, ref, watch } from 'vue';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import UiFileTree from './UiFileTree.vue';
import UiIcon from './UiIcon.vue';

const props = defineProps<{ selected: string | null }>();
const emit = defineEmits<{ (e: 'open', path: string): void }>();
const chat = useChat();

interface Node { name: string; path: string; kind: 'dir' | 'file'; size: number; mtime: number }
const tab = ref<'files' | 'changes'>('files');
const roots = ref<Node[] | null>(null);
const loading = ref(false);
const failed = ref('');
const refreshKey = ref(0);

async function load(): Promise<void> {
  if (!chat.activeId) { roots.value = null; return; }
  loading.value = true; failed.value = '';
  try { roots.value = await rpc.call('files.list', { sessionId: chat.activeId }); }
  catch (e) { failed.value = e instanceof Error ? e.message : String(e); roots.value = null; }
  finally { loading.value = false; }
}
function refresh(): void { refreshKey.value++; void load(); }

watch(() => chat.activeId, load, { immediate: true });
// agent 回合结束 → 工作区可能已被改动，自动刷新（免手动）
watch(() => chat.running, (now, prev) => { if (prev && !now) refresh(); });

/** 改动清单：从工具调用里提写过的路径（file_write / file_edit），去重保序。 */
const changes = computed(() => {
  const seen = new Set<string>();
  const out: { path: string; tool: string }[] = [];
  for (const m of chat.messages) {
    for (const p of (Array.isArray(m.parts) ? m.parts : [])) {
      if (p?.type !== 'toolUse' || !p.value || typeof p.value !== 'object') continue;
      const v = p.value as Record<string, unknown>;
      const name = String(v.name ?? '');
      if (name !== 'file_write' && name !== 'file_edit') continue;
      const input = typeof v.input === 'string' ? safeJson(v.input) : (v.input as Record<string, unknown> | undefined);
      const path = typeof input?.path === 'string' ? input.path : '';
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push({ path, tool: name });
    }
  }
  return out;
});
function safeJson(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return undefined; }
}
</script>

<template>
  <aside class="ws">
    <div class="tabs">
      <button type="button" :class="{ on: tab === 'files' }" @click="tab = 'files'">文件</button>
      <button type="button" :class="{ on: tab === 'changes' }" @click="tab = 'changes'">
        改动<span v-if="changes.length" class="n tnum">{{ changes.length }}</span>
      </button>
      <span class="grow"></span>
      <button class="ib" type="button" title="刷新" @click="refresh"><UiIcon name="refresh" :size="14" /></button>
    </div>

    <div class="body">
      <template v-if="tab === 'files'">
        <div v-if="!chat.activeId" class="hint">先开一个会话</div>
        <div v-else-if="loading && !roots" class="hint">加载中…</div>
        <div v-else-if="failed" class="hint err">{{ failed }}</div>
        <div v-else-if="roots && !roots.length" class="hint">工作区为空<br />agent 创建的文件会出现在这里</div>
        <UiFileTree
          v-for="n in roots ?? []" :key="n.path"
          :node="n" :session-id="chat.activeId" :depth="0" :refresh-key="refreshKey" :selected="props.selected"
          @open="p => emit('open', p)"
        />
      </template>

      <template v-else>
        <div v-if="!changes.length" class="hint">本会话还没有文件改动</div>
        <button v-for="c in changes" :key="c.path" type="button" class="chg" :class="{ on: props.selected === c.path }" @click="emit('open', c.path)">
          <span class="tag" :class="c.tool">{{ c.tool === 'file_write' ? '写' : '改' }}</span>
          <span class="cpath">{{ c.path }}</span>
        </button>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.ws {
  width: var(--w-aside); flex: 0 0 var(--w-aside);
  display: flex; flex-direction: column; min-height: 0;
  background: var(--c-bg-1); border-left: 1px solid var(--c-line);
}
.tabs {
  flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-1);
  height: var(--h-field); padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--c-line);
}
.tabs button {
  height: var(--h-mini); padding: 0 var(--sp-4); border-radius: var(--r-s);
  background: none; color: var(--c-ink-3); cursor: pointer;
  font-size: var(--t-aux-size); font-family: inherit;
  display: inline-flex; align-items: center; gap: var(--sp-2);
}
.tabs button:hover { color: var(--c-ink); }
.tabs button.on { background: var(--c-bg-2); color: var(--c-ink); font-weight: var(--w-md); }
.n { color: var(--c-ink-3); }
.grow { flex: 1; }
.ib { width: 24px; height: 24px; justify-content: center; padding: 0 !important; }

.body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--sp-2) var(--sp-3) var(--sp-4); }
.hint { padding: var(--sp-7) var(--sp-4); text-align: center; font-size: var(--t-aux-size); line-height: 1.7; color: var(--c-ink-3); }
.hint.err { color: var(--c-err); }

.chg {
  display: flex; align-items: center; gap: var(--sp-3); width: 100%;
  padding: var(--sp-2) var(--sp-3); border-radius: var(--r-s);
  background: none; cursor: pointer; text-align: left; font-family: inherit;
}
.chg:hover { background: var(--c-bg-2); }
.chg.on { background: var(--c-brand-soft); }
.tag {
  flex: 0 0 auto; width: 18px; height: 18px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: var(--w-md);
  background: var(--c-ok-soft); color: var(--c-ok);
}
.tag.file_edit { background: var(--c-warn-soft); color: var(--c-warn); }
.cpath {
  flex: 1; min-width: 0; font-family: var(--f-mono); font-size: var(--t-aux-size);
  color: var(--c-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
}
</style>
