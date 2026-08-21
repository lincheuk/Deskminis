<script setup lang="ts">
/** V1 基础件：差分视图。权限卡的「批准前先看要写什么」靠它。
 *  行内滚动上限 240px——差分可能很长，但权限卡不该把整屏吃掉；
 *  真要细看，批准后在预览区看全文。 */
// 类型取自 lib/diff/lcs（字段是 type 不是 kind——自造一份接口就会在这里对不上）
import type { DiffLine } from '../lib/diff/lcs';
const props = defineProps<{ lines: DiffLine[]; addCount: number; delCount: number; path?: string }>();
</script>

<template>
  <div class="diff">
    <div class="dh t-aux">
      <span v-if="props.path" class="dpath">{{ props.path }}</span>
      <span class="add tnum">+{{ props.addCount }}</span>
      <span class="del tnum">-{{ props.delCount }}</span>
    </div>
    <div class="dbody">
      <div v-for="(l, i) in props.lines" :key="i" class="dline" :class="l.type">
        <span class="sign">{{ l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ' }}</span>
        <span class="dtext">{{ l.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff { border: 1px solid var(--c-line); border-radius: var(--r-s); overflow: hidden; background: var(--c-bg); }
.dh {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4); background: var(--c-bg-1);
  border-bottom: 1px solid var(--c-line); color: var(--c-ink-3);
}
.dpath { flex: 1; min-width: 0; font-family: var(--f-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.add { color: var(--c-ok); }
.del { color: var(--c-err); }
.dbody { max-height: 240px; overflow: auto; font-family: var(--f-mono); font-size: var(--t-code-size); line-height: var(--t-code-lh); }
.dline { display: flex; gap: var(--sp-2); padding: 0 var(--sp-3); white-space: pre-wrap; word-break: break-all; }
.dline.add { background: var(--c-ok-soft); }
.dline.del { background: var(--c-err-soft); }
.sign { flex: 0 0 auto; width: 10px; color: var(--c-ink-4); }
.dline.add .sign { color: var(--c-ok); }
.dline.del .sign { color: var(--c-err); }
.dtext { flex: 1; min-width: 0; color: var(--c-ink-2); }
.dline.add .dtext, .dline.del .dtext { color: var(--c-ink); }
</style>
