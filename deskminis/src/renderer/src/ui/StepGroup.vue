<script setup lang="ts">
/** T 波：工具调用折叠组（AionUi「View Steps」的中文位）。
 *  旧 UI 把每次工具调用摊成一条独立胶囊行，十几步下来正文被切得七零八落；
 *  这里默认收起成一行摘要，点开才列步骤——**对话的主角是对话**。 */
import { computed, ref } from 'vue';
import UiIcon from './UiIcon.vue';
import UiDiff from './UiDiff.vue';
import { extractEditPair } from '../lib/diff/payload';
import { diffLines, countAddDel } from '../lib/diff/lcs';

interface Step { name: string; title: string; ok: boolean; output?: string | null; input?: string }
const props = defineProps<{ steps: Step[]; live?: boolean }>();
const open = ref(false);
const failed = () => props.steps.filter(s => !s.ok).length;

/** 参数区：单行 JSON 人眼读不了，pretty 打印；不是 JSON 就原样给（别把坏载荷吞成空白）。 */
function pretty(raw?: string | null): string {
  if (raw == null || raw === '') return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
}

/** 展开内容预先算好，并且**只在展开时算**：diffLines 是 LCS，
 *  写进模板等于每次重渲染重跑一遍；实时回合里 steps 每来一个事件就变一次，
 *  收起状态下算了也没人看。 */
const views = computed(() => (open.value ? props.steps : []).map(s => {
  const pair = s.name === 'file_edit' ? extractEditPair(s.input ?? null) : null;
  const lines = pair ? diffLines(pair.oldStr, pair.newStr) : [];
  return { pair, lines, counts: countAddDel(lines), params: pretty(s.input) };
}));
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
        <!-- file_edit 载荷提得出来就渲差分（路径由 extractEditPair 相对化），提不出来回落参数区。
             一律走 ?. ——模板里的非空断言要靠编译器开 TS 插件才认，不值当赌这个。 -->
        <UiDiff
          v-if="views[i]?.pair"
          class="dv"
          :path="views[i]?.pair?.path"
          :lines="views[i]?.lines ?? []"
          :add-count="views[i]?.counts.add ?? 0"
          :del-count="views[i]?.counts.del ?? 0"
        />
        <div v-else-if="views[i]?.params" class="blk">
          <div class="blabel t-aux">参数</div>
          <pre class="out">{{ views[i]?.params.slice(0, 2000) }}</pre>
        </div>
        <div v-if="s.output" class="blk">
          <div class="blabel t-aux">输出</div>
          <pre class="out">{{ s.output.slice(0, 2000) }}</pre>
        </div>
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
.dv { grid-column: 2; min-width: 0; }
.blk { grid-column: 2; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.blabel { color: var(--c-ink-3); }
.out {
  margin: 0; padding: var(--sp-3);
  background: var(--c-bg-2); border-radius: var(--r-s);
  font-family: var(--f-mono); font-size: var(--t-code-size); line-height: var(--t-code-lh);
  color: var(--c-ink-2); white-space: pre-wrap; word-break: break-word;
  max-height: 220px; overflow: auto;
}
</style>
