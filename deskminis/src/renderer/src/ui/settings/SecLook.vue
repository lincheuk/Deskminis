<script setup lang="ts">
/** 本机主题偏好；与标题栏共用当前选择和持久化路径。 */
import { themeMode as mode, setTheme as apply, type ThemeMode } from '../../lib/theme';
import UiIcon from '../UiIcon.vue';
const MODES: { v: ThemeMode; icon: string; label: string }[] = [
  { v: 'system', icon: 'device', label: '跟随系统' },
  { v: 'light', icon: 'sun', label: '浅色' },
  { v: 'dark', icon: 'moon', label: '深色' },
];
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
