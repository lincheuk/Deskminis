<script setup lang="ts">
/** diff 视图（设计 v2 §5.4）——文件头槽（相对路径 mono + +N/−M 徽标）+ 行级 diff：
 *  行号 mono、+ 绿底 / − 红底（--state-ok-bg/--state-err-bg 三模式槽）、上下文 2 行折叠
 *  「⋯ N 行未更改」（点击展开全量）。 */
import { computed, ref } from 'vue';
import { collapseCtx, type DiffLine } from '../lib/diff/lcs';

const props = defineProps<{
  path: string;
  addCount: number;
  delCount: number;
  lines: DiffLine[];
}>();

// 上下文折叠：默认 collapseCtx(lines, 2)；点击折叠行展开全量（单向，组件内状态）
const expanded = ref(false);
const displayLines = computed(() => (expanded.value ? props.lines : collapseCtx(props.lines, 2)));
</script>

<template>
  <div class="diff">
    <div class="diff-head">
      <span class="path">{{ path }}</span>
      <span class="diff-badge"><span class="add">+{{ addCount }}</span> <span class="del">−{{ delCount }}</span></span>
    </div>
    <div class="diff-body">
      <template v-for="(l, i) in displayLines" :key="i">
        <button v-if="l.type === 'fold'" class="diff-row fold" type="button" @click="expanded = true">⋯ {{ l.count }} 行未更改</button>
        <div v-else class="diff-row" :class="l.type">
          <span class="ln">{{ l.type === 'add' ? l.newNo : l.oldNo }}</span>
          <span class="lc">{{ l.text }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.diff {
  border: .5px solid var(--separator); border-radius: var(--r-md); overflow: hidden;
  background: var(--grouped-bg-secondary); max-width: 100%;
}
/* 文件头槽：相对路径 mono + 增删徽标 */
.diff-head {
  display: flex; align-items: center; gap: 8px; padding: 5px 10px;
  background: var(--grouped-bg-tertiary); border-bottom: .5px solid var(--separator);
}
.path {
  font-family: var(--font-mono); font-size: var(--fs-mono); color: var(--label-strong);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1;
}
.diff-badge { font-family: var(--font-mono); font-size: var(--fs-micro); flex: 0 0 auto; }
.diff-badge .add { color: var(--state-ok); }
.diff-badge .del { color: var(--state-err); }
.diff-body { max-height: 240px; overflow: auto; }
.diff-row {
  display: flex; align-items: baseline; gap: 8px; padding: 0 10px 0 0;
  font-family: var(--font-mono); font-size: var(--fs-mono); line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
}
.diff-row.add { background: var(--state-ok-bg); }
.diff-row.del { background: var(--state-err-bg); }
.ln {
  width: 34px; flex: 0 0 auto; text-align: right; padding-right: 8px;
  font-size: 10.5px; color: var(--label-quaternary); user-select: none;
}
.lc { min-width: 0; flex: 1; }
/* 折叠行：可点击展开全量上下文 */
.diff-row.fold {
  display: block; width: 100%; text-align: left; padding: 2px 10px 2px 42px;
  background: none; border: none; cursor: pointer;
  font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--label-tertiary);
}
.diff-row.fold:hover { color: var(--label-secondary); background: var(--fill-quaternary); }
</style>
