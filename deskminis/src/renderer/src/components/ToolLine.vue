<script setup lang="ts">
/** 工具行（设计 v2 §2.2）——32px 单行：状态符号（✓/✕/旋转圆环）+ 类型图标（中性色）+
 *  人话标题 + 耗时 mono 右置 + 展开 chevron；类型色五色退役，shimmer 取消。
 *  展开区默认呈现参数/输出（mono 内滚 240px）；默认插槽可覆写展开内容（同型成组时嵌子行）。 */
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import DiffView from './DiffView.vue';
import { fmtDuration } from '../lib/toolline/duration';
import { diffLines, countAddDel } from '../lib/diff/lcs';
import { extractEditPair } from '../lib/diff/payload';

const props = withDefaults(defineProps<{
  name?: string;
  title?: string;
  state?: 'running' | 'ok' | 'fail';
  duration?: string;          // 预格式化耗时（父级已知时）；缺省走内部计时
  input?: string | null;
  output?: string | null;
}>(), { name: '', title: '', state: 'ok' });

// 工具类型 → 图标（§6.1 图标语义与 OpenMinis 同构；颜色一律中性 --label-secondary，类型色退役）
const TYPE_ICON: Record<string, string> = {
  shell_execute: 'terminal',
  file_read: 'file',
  file_write: 'file',
  file_edit: 'pencil',
  memory: 'memory',
};
const icon = computed(() => TYPE_ICON[props.name] ?? 'gear');
const label = computed(() => (props.title ?? '').trim() || props.name || '工具');
/* E3：标题缺省时 label 回落为裸工具名（如 mcp__server__tool）——标识符读数走 mono（§4） */
const isRawName = computed(() => (props.title ?? '').trim() === '' && props.name !== '');

// file_edit 展开区换 diff 视图（§5.4）：载荷可提取即渲染 DiffView，否则回落参数/输出 JSON 区
const editPair = computed(() => (props.name === 'file_edit' ? extractEditPair(props.input) : null));
const editLines = computed(() => (editPair.value ? diffLines(editPair.value.oldStr, editPair.value.newStr) : []));
const editCounts = computed(() => countAddDel(editLines.value));

// 展开态
const open = ref(false);
const prettyInput = computed(() => {
  const raw = props.input;
  if (raw == null || raw === '') return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
});

// 执行中耗时：挂载即近似 toolStart 时刻（与 ToolPill 先例一致）；结束后冻结最后读数。
// 历史回放行从不进入 running，因而不显示耗时（store 未跟踪真实时长，绝不伪造）。
const elapsedMs = ref<number | null>(null);
let startAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function stopTimer() { if (timer) { clearInterval(timer); timer = undefined; } }
watch(() => props.state, s => {
  if (s === 'running') {
    startAt = Date.now();
    elapsedMs.value = 0;
    stopTimer();
    timer = setInterval(() => { elapsedMs.value = Date.now() - startAt; }, 100);
  } else {
    stopTimer();
  }
}, { immediate: true });
onBeforeUnmount(stopTimer);

const durText = computed(() => props.duration ?? (elapsedMs.value != null ? fmtDuration(0, elapsedMs.value) : ''));
</script>

<template>
  <div class="tlwrap">
    <button class="tline" type="button" :aria-expanded="open" @click="open = !open">
      <span v-if="state === 'running'" class="spin" aria-label="执行中"></span>
      <span v-else class="tmark" :class="state">{{ state === 'ok' ? '✓' : '✕' }}</span>
      <span class="tico"><Icon :name="icon" :size="14" /></span>
      <span class="ttitle" :class="{ mono: isRawName }">{{ label }}</span>
      <span v-if="durText" class="tdur">{{ durText }}</span>
      <span class="tchev"><Icon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" /></span>
    </button>
    <div v-if="open" class="texpand">
      <slot>
        <template v-if="editPair">
          <DiffView :path="editPair.path" :add-count="editCounts.add" :del-count="editCounts.del" :lines="editLines" />
          <div v-if="output" class="tblock">
            <div class="tlabel">输出</div>
            <pre>{{ output }}</pre>
          </div>
        </template>
        <template v-else>
          <div v-if="prettyInput" class="tblock">
            <div class="tlabel">参数</div>
            <pre>{{ prettyInput }}</pre>
          </div>
          <div v-if="output" class="tblock">
            <div class="tlabel">输出</div>
            <pre>{{ output }}</pre>
          </div>
          <div v-if="!prettyInput && !output" class="tlabel">无内容</div>
        </template>
      </slot>
    </div>
  </div>
</template>

<style scoped>
.tlwrap { display: flex; flex-direction: column; gap: 4px; max-width: 100%; align-self: stretch; }
.tline {
  display: flex; align-items: center; gap: 8px; height: var(--h-control); padding: 0 8px;
  background: none; border: none; border-radius: var(--r-control); cursor: pointer;
  font-family: var(--font-ui); font-size: var(--fs-ui); color: var(--label); text-align: left;
  width: 100%;
}
.tline:hover { background: var(--fill-quaternary); }
/* E3（Aurora §4）：运行中行左缘 2px accent 活动线——inset 阴影实现，零位移；
   :has(.spin) 选中运行态行，零 DOM 改动（.spin 仅在 running 态渲染） */
.tline:has(.spin) { box-shadow: inset 2px 0 0 var(--accent); }
/* MU3 §2-5 焦点环 */
.tline:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
/* 状态符号（✓ 绿 / ✕ 红）；类型色退役后唯一的色彩语义 */
.tmark { width: 15px; text-align: center; font-size: 12px; flex: 0 0 auto; }
.tmark.ok { color: var(--state-ok); }
.tmark.fail { color: var(--state-err); }
/* 执行中：14px CSS 旋转圆环（shimmer 取消，§2.2） */
.spin {
  width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto;
  border: 1.5px solid var(--label-quaternary); border-top-color: var(--label-secondary);
  animation: tlspin .8s linear infinite;
}
@keyframes tlspin { to { transform: rotate(360deg); } }
.tico { display: inline-flex; color: var(--label-secondary); flex: 0 0 auto; }
.ttitle { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; color: var(--label-strong); }
/* E3：裸工具名（无标题回落，如 mcp__server__tool）走 mono——标识符读数（§4） */
.ttitle.mono { font-family: var(--font-mono); }
.tdur { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--label-tertiary); flex: 0 0 auto; }
.tchev { display: inline-flex; color: var(--label-tertiary); flex: 0 0 auto; }
.texpand { margin: 2px 0 4px 23px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.tblock { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.tlabel { font-size: var(--fs-micro); font-weight: 600; color: var(--label-secondary); }
.texpand pre {
  font-family: var(--font-mono); font-size: var(--fs-mono); line-height: 1.5; color: var(--label);
  white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; margin: 0;
  background: var(--grouped-bg-tertiary); border-radius: var(--r-control); padding: 8px 10px;
}
</style>
