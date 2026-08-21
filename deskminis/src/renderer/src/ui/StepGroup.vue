<script setup lang="ts">
/** T 波：工具调用折叠组（AionUi「View Steps」的中文位）。
 *  旧 UI 把每次工具调用摊成一条独立胶囊行，十几步下来正文被切得七零八落；
 *  这里默认收起成一行摘要，点开才列步骤——**对话的主角是对话**。 */
import { ref } from 'vue';
import UiIcon from './UiIcon.vue';

interface Step { name: string; title: string; ok: boolean; output?: string | null }
const props = defineProps<{ steps: Step[]; live?: boolean }>();
const open = ref(false);
const failed = () => props.steps.filter(s => !s.ok).length;
</script>

<template>
  <div class="grp" :class="{ live: props.live }">
    <button class="head" type="button" :aria-expanded="open" @click="open = !open">
      <UiIcon :name="open ? 'chevronDown' : 'chevronRight'" :size="14" />
      <span class="sum">
        <template v-if="props.live">正在执行…</template>
        <template v-else>已执行 {{ props.steps.length }} 步</template>
      </span>
      <span v-if="failed()" class="bad">{{ failed() }} 步失败</span>
    </button>
    <div v-if="open" class="body">
      <div v-for="(s, i) in props.steps" :key="i" class="step">
        <span class="dot" :class="{ bad: !s.ok }"></span>
        <span class="stitle">{{ s.title || s.name }}</span>
        <pre v-if="s.output" class="out">{{ s.output.slice(0, 2000) }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grp { border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg-1); overflow: hidden; }
.grp.live { border-color: var(--c-brand-line); }
.head {
  display: flex; align-items: center; gap: var(--sp-3); width: 100%;
  padding: var(--sp-3) var(--sp-4); background: none; cursor: pointer;
  color: var(--c-ink-2); font-size: var(--t-item-size); font-family: inherit; text-align: left;
}
.head:hover { background: var(--c-bg-2); }
.head :deep(svg) { color: var(--c-ink-3); flex: 0 0 auto; }
.sum { flex: 1; min-width: 0; }
.bad { color: var(--c-err); font-size: var(--t-aux-size); flex: 0 0 auto; }
.body { padding: 0 var(--sp-4) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); }
.step { display: grid; grid-template-columns: auto 1fr; gap: var(--sp-3); align-items: baseline; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-ok); }
.dot.bad { background: var(--c-err); }
.stitle { font-size: var(--t-item-size); color: var(--c-ink-2); min-width: 0; }
.out {
  grid-column: 2; margin: 0; padding: var(--sp-3);
  background: var(--c-bg-2); border-radius: var(--r-s);
  font-family: var(--f-mono); font-size: var(--t-code-size); line-height: var(--t-code-lh);
  color: var(--c-ink-2); white-space: pre-wrap; word-break: break-word;
  max-height: 220px; overflow: auto;
}
</style>
