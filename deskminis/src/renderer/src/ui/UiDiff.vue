<script setup lang="ts">
/** V1 基础件：差分视图。权限卡的「批准前先看要写什么」靠它。
 *  行内滚动上限 240px——差分可能很长，但权限卡不该把整屏吃掉；
 *  真要细看，批准后在预览区看全文。
 *  N25：连续相同行折叠，折叠不改原始行号与增删计数；审阅面板可选并排。 */
// 类型取自 lib/diff/lcs（字段是 type 不是 kind——自造一份接口就会在这里对不上）
import { computed, ref, watch } from 'vue';
import type { DiffLine } from '../lib/diff/lcs';
import { diffRows, foldLines } from '../lib/diff/view';
// tall（F08）：审阅面板里差分就是正文，不设 240px 上限、跟着面板滚。缺省行为不变
const props = defineProps<{ lines: DiffLine[]; addCount: number; delCount: number; path?: string; tall?: boolean; lineNumbers?: boolean; split?: boolean }>();
const expanded = ref(new Set<number>());
watch(() => props.lines, () => { expanded.value = new Set(); }, { deep: true, flush: 'sync' });
const rows = computed(() => diffRows(foldLines(props.lines, expanded.value), props.split === true));
function expand(start: number): void { expanded.value = new Set([...expanded.value, start]); }
/** 两列按整份差分的最大行号同宽；至少留四位，各列右对齐。 */
const numberWidth = computed(() => props.lines.reduce((digits, line) => Math.max(digits, String(line.oldNo ?? '').length, String(line.newNo ?? '').length), 4) + 'ch');
</script>

<template>
  <div class="diff">
    <div class="dh t-aux">
      <span v-if="props.path" class="dpath">{{ props.path }}</span>
      <span class="add tnum">+{{ props.addCount }}</span>
      <span class="del tnum">-{{ props.delCount }}</span>
    </div>
    <div class="dbody" :class="{ tall: props.tall, split: props.split }">
      <template v-for="(row, i) in rows" :key="i">
        <button v-if="row.kind === 'fold'" class="fold" type="button" @click="expand(row.start)">展开 {{ row.count }} 行未改动</button>
        <div v-else-if="row.kind === 'unified'" class="dline" :class="row.line.type">
          <template v-if="props.lineNumbers">
            <span class="no tnum" :style="{ flexBasis: numberWidth }" aria-hidden="true">{{ row.line.oldNo ?? '' }}</span>
            <span class="no tnum" :style="{ flexBasis: numberWidth }" aria-hidden="true">{{ row.line.newNo ?? '' }}</span>
          </template>
          <span class="sign">{{ row.line.type === 'add' ? '+' : row.line.type === 'del' ? '-' : ' ' }}</span>
          <span class="dtext">{{ row.line.text }}</span>
        </div>
        <div v-else class="srow">
          <div v-for="(line, side) in [row.old, row.next]" :key="side" class="dline" :class="line?.type ?? 'empty'" :aria-hidden="!line || undefined">
            <template v-if="line">
              <span class="no tnum" :style="{ flexBasis: numberWidth }" aria-hidden="true">{{ (side === 0 ? line.oldNo : line.newNo) ?? '' }}</span>
              <span class="sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
              <span class="dtext">{{ line.text }}</span>
            </template>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.diff { border: 1px solid var(--c-line); border-radius: var(--r-s); overflow: hidden; background: var(--c-bg); flex: 0 0 auto; }
.dh { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-4); background: var(--c-bg-1); border-bottom: 1px solid var(--c-line); color: var(--c-ink-3); }
.dpath { flex: 1; min-width: 0; font-family: var(--f-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.add { color: var(--c-ok); }
.del { color: var(--c-err); }
.dbody { max-height: 240px; overflow: auto; font-family: var(--f-mono); font-size: var(--t-code-size); line-height: var(--t-code-lh); }
.dbody.tall { max-height: none; }
.dline { display: flex; gap: var(--sp-2); padding: 0 var(--sp-3); white-space: pre-wrap; word-break: break-all; min-width: 0; }
.dline.add { background: var(--c-ok-soft); }
.dline.del { background: var(--c-err-soft); }
.no { flex: 0 0 auto; text-align: right; color: var(--c-ink-3); user-select: none; }
.sign { flex: 0 0 auto; width: 10px; color: var(--c-ink-4); }
.dline.add .sign { color: var(--c-ok); }
.dline.del .sign { color: var(--c-err); }
.dtext { flex: 1; min-width: 0; color: var(--c-ink-2); }
.dline.add .dtext, .dline.del .dtext { color: var(--c-ink); }
.fold { display: block; width: 100%; padding: var(--sp-1) var(--sp-3); font: inherit; color: var(--c-brand); background: var(--c-bg-1); cursor: pointer; text-align: center; }
.fold:hover { background: var(--c-bg-2); }
.srow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.srow > :first-child { border-right: 1px solid var(--c-line); }
.empty { background: var(--c-bg-1); }
</style>
