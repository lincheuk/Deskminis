<script setup lang="ts">
/** 统一事件条（MU2a Task 8，设计 v2 §5.3）：retry/fallback/compacted/offloaded/error
 *  五类一套语法 `[图标] 短句 · 详情[›] [重试]`。色调走 --state-*-bg/border 槽，不写死颜色。 */
import Icon from './Icon.vue';
import type { EventNoteTone } from '../lib/eventnote/copy';

defineProps<{
  kind: string;
  icon: string;
  short: string;
  tone: EventNoteTone;
  detail?: string;
  retryable?: boolean;
}>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="eventnote" :class="`tone-${tone}`">
    <Icon :name="icon" :size="14" />
    <span class="eshort">{{ short }}</span>
    <details v-if="detail" class="edetail">
      <summary>详情</summary>
      <span class="edtext">{{ detail }}</span>
    </details>
    <button v-if="retryable" class="eretry" type="button" @click="emit('retry')">重试</button>
  </div>
</template>

<style scoped>
.eventnote {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; margin: 3px 0;
  border-radius: var(--r-md); font-size: var(--fs-mono); line-height: 1.45;
  border: 1px solid var(--separator);
  background: var(--grouped-bg-secondary);
  color: var(--label-secondary);
  max-width: 100%;
}
.eventnote :deep(svg) { flex: 0 0 auto; margin-top: -1px; }
.eshort { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 色调 → §3.2 状态槽（组件内零写死颜色、零混色百分比） */
.tone-warn { color: var(--state-warn); background: var(--state-warn-bg); border-color: var(--state-warn-border); }
.tone-info { color: var(--state-info); background: var(--state-info-bg); border-color: var(--state-info-border); }
.tone-err  { color: var(--state-err);  background: var(--state-err-bg);  border-color: var(--state-err-border); }
.tone-warn :deep(svg) { stroke: var(--state-warn); }
.tone-info :deep(svg) { stroke: var(--state-info); }
.tone-err  :deep(svg) { stroke: var(--state-err); }
/* 详情折叠：summary 只留「详情 ›」锚，展开后原文换行可读 */
.edetail { display: contents; }
.edetail > summary {
  cursor: pointer; list-style: none; flex: 0 0 auto;
  color: inherit; opacity: .8; font-size: var(--fs-mono);
}
.edetail > summary::after { content: ' ›'; }
.edetail[open] > summary::after { content: ' ⌄'; }
.edetail > summary::-webkit-details-marker { display: none; }
.edtext {
  flex: 1 1 100%; white-space: pre-wrap; word-break: break-word;
  font-size: var(--fs-caption); color: var(--label-tertiary); padding-top: 2px;
}
.eventnote:has(.edetail[open]) { flex-wrap: wrap; }
/* 重试钮：文本级，继承条色调 */
.eretry {
  background: none; border: none; padding: 0 2px; cursor: pointer; flex: 0 0 auto;
  font-size: var(--fs-mono); font-weight: var(--fw-medium); color: inherit; text-decoration: underline;
}
</style>
