<script setup lang="ts">
/** T5：外观。主题三态——跟随系统 / 浅 / 深。
 *  存 localStorage 而不是后端：它是**这台机器这个窗口**的偏好，
 *  跟着账号同步过去反而会在另一台机器上给出错误的亮度。 */
import { onMounted, ref } from 'vue';
import UiIcon from '../UiIcon.vue';

type Mode = 'system' | 'light' | 'dark';
const mode = ref<Mode>('system');
const MODES: { v: Mode; icon: string; label: string }[] = [
  { v: 'system', icon: 'device', label: '跟随系统' },
  { v: 'light', icon: 'sun', label: '浅色' },
  { v: 'dark', icon: 'moon', label: '深色' },
];

function apply(m: Mode): void {
  mode.value = m;
  const el = document.documentElement;
  if (m === 'system') delete el.dataset.theme; else el.dataset.theme = m;
  try { localStorage.setItem('deskminis.theme', m); } catch { /* 隐私模式下不可写：忽略 */ }
}
onMounted(() => {
  try {
    const saved = localStorage.getItem('deskminis.theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') apply(saved);
  } catch { /* 同上 */ }
});
</script>

<template>
  <section class="f-sec">
    <h2>外观</h2>
    <p class="f-note">主题只影响这台机器上的这个应用，不跟着账号走。</p>
    <div class="modes">
      <button
        v-for="m in MODES" :key="m.v" type="button"
        class="mode" :class="{ on: mode === m.v }" :aria-pressed="mode === m.v" @click="apply(m.v)"
      >
        <UiIcon :name="m.icon" :size="17" /><span>{{ m.label }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.modes { display: flex; gap: var(--sp-4); flex-wrap: wrap; }
.mode {
  display: inline-flex; align-items: center; gap: var(--sp-3);
  height: var(--h-field); padding: 0 var(--sp-6); cursor: pointer; font-family: inherit;
  font-size: var(--t-item-size); color: var(--c-ink-2);
  background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-s);
}
.mode :deep(svg) { color: var(--c-ink-3); }
.mode.on { border-color: var(--c-brand); background: var(--c-brand-soft); color: var(--c-ink); font-weight: var(--w-md); }
.mode.on :deep(svg) { color: var(--c-brand); }
</style>
