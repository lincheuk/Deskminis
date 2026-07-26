<script setup lang="ts">
/** 工具调用胶囊（设计 §4.2）——36px 高 Capsule，不是方卡。
 *  按工具类型给前导图标配色；状态覆盖图标色；点击展开参数/输出（等宽，最高 200px 内滚）。 */
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  name?: string;
  title?: string;
  input?: string | null;
  output?: string | null;
  success?: boolean;          // undefined = 结果未知（执行中或缺失）
  status?: string;            // 'success' | 'failed' | 'cancelled'
  running?: boolean;
}>(), { name: '', title: '', running: false });

// 工具类型 → 图标 + 颜色
const TYPE = {
  shell_execute: { icon: 'terminal', color: 'var(--green)' },
  file_read: { icon: 'file', color: 'var(--cyan)' },
  file_write: { icon: 'file', color: 'var(--blue)' },
  file_edit: { icon: 'pencil', color: 'var(--orange)' },
  memory: { icon: 'memory', color: 'var(--purple)' },
} as Record<string, { icon: string; color: string }>;

const meta = computed(() => TYPE[props.name ?? ''] ?? { icon: 'gear', color: 'var(--label-secondary)' });

// 展示状态：running / success / failed / cancelled / idle
const state = computed<'running' | 'success' | 'failed' | 'cancelled' | 'idle'>(() => {
  if (props.running && props.success === undefined) return 'running';
  if (props.status === 'cancelled') return 'cancelled';
  if (props.success === true) return 'success';
  if (props.success === false) return 'failed';
  return 'idle';
});

// 前导图标色：有状态则用状态色覆盖，否则用类型色
const iconColor = computed(() => {
  switch (state.value) {
    case 'success': return 'var(--green)';
    case 'failed': return 'var(--red)';
    case 'cancelled': return 'var(--yellow)';
    default: return meta.value.color; // running / idle 用类型色
  }
});

const label = computed(() => {
  const t = (props.title ?? '').trim();
  if (t) return t;
  return props.name ?? '工具';
});

// 展开态
const open = ref(false);
const prettyInput = computed(() => {
  const raw = props.input;
  if (raw == null || raw === '') return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
});

// 实时耗时：仅在执行中计时（挂载即近似 toolStart 时刻）；停止后冻结最后读数。
// 历史回放的胶囊从不进入 running，因而不显示耗时（store 未跟踪真实时长，绝不伪造）。
const elapsed = ref<number | null>(null);
let startAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function stopTimer() { if (timer) { clearInterval(timer); timer = undefined; } }
watch(() => props.running, run => {
  if (run) {
    startAt = Date.now();
    elapsed.value = 0;
    stopTimer();
    timer = setInterval(() => { elapsed.value = (Date.now() - startAt) / 1000; }, 100);
  } else {
    stopTimer();
  }
}, { immediate: true });
onBeforeUnmount(stopTimer);

const durationText = computed(() => {
  if (state.value === 'running') return '运行中…';
  if (elapsed.value != null) return `${elapsed.value.toFixed(1)}s`;
  return '';
});
</script>

<template>
  <div class="pillwrap">
    <button class="pill" :class="{ running: state === 'running' }" @click="open = !open">
      <span class="ico" :style="{ color: iconColor }"><Icon :name="meta.icon" :size="15" /></span>
      <span class="ptitle">{{ label }}</span>
      <span v-if="durationText" class="dur">{{ durationText }}</span>
      <span v-if="state === 'running'" class="dots"><i></i><i></i><i></i></span>
      <span v-else-if="state === 'success'" class="ico" style="color:var(--green)"><Icon name="check" :size="14" /></span>
      <span v-else-if="state === 'failed'" class="ico" style="color:var(--red)"><Icon name="x" :size="14" /></span>
      <span v-else-if="state === 'cancelled'" class="ico" style="color:var(--yellow)"><Icon name="x" :size="14" /></span>
    </button>
    <div v-if="open" class="expand">
      <div v-if="prettyInput" class="block">
        <div class="blabel">参数</div>
        <pre>{{ prettyInput }}</pre>
      </div>
      <div v-if="output" class="block">
        <div class="blabel">输出</div>
        <pre>{{ output }}</pre>
      </div>
      <div v-if="!prettyInput && !output" class="blabel">无内容</div>
    </div>
  </div>
</template>

<style scoped>
.pillwrap { align-self: flex-start; max-width: 100%; display: flex; flex-direction: column; gap: 6px; }
.pill {
  display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px;
  background: var(--grouped-bg-tertiary); border: .5px solid var(--separator); border-radius: var(--r-pill);
  font-family: var(--font-ui); font-size: 13px; font-weight: 500; color: var(--label);
  cursor: pointer; max-width: 100%; position: relative; overflow: hidden;
}
.ico { display: inline-flex; align-items: center; flex: 0 0 auto; }
.ptitle { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.dur { font-family: var(--font-mono); font-size: 11px; color: var(--label-secondary); flex: 0 0 auto; }
/* 执行中：微光扫过 + 三点跳动 */
.pill.running::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(100deg, transparent 30%, var(--fill-quaternary) 50%, transparent 70%);
  background-size: 200% 100%; animation: shimmer 1.4s linear infinite;
}
@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.dots { display: inline-flex; gap: 3px; flex: 0 0 auto; }
.dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--label-tertiary); animation: jump 1s infinite ease-in-out; }
.dots i:nth-child(2) { animation-delay: .15s; }
.dots i:nth-child(3) { animation-delay: .3s; }
@keyframes jump { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-3px); opacity: 1; } }
.expand {
  background: var(--grouped-bg-tertiary); border: .5px solid var(--separator); border-radius: var(--r-md);
  padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; max-width: 100%;
}
.block { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.blabel { font-size: 11px; font-weight: 600; color: var(--label-secondary); }
.expand pre {
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: var(--label);
  white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; margin: 0;
}
</style>
