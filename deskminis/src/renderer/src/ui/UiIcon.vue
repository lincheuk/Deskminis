<script setup lang="ts">
/** T 波基础件：线性图标。描边样式由 theme.css 的 svg 基线统一给，这里只出路径。
 *  与旧 Icon.vue 的差别：图形按 24 网格重画（旧的混了 20/24 两套网格，粗细不齐）。 */
const P: Record<string, string> = {
  // 导航
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
  aside: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14.5 4v16"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronUp: '<path d="M6 14.5l6-6 6 6"/>',
  // 实体
  chat: '<path d="M20 15a2.5 2.5 0 01-2.5 2.5H8L4 21V6a2.5 2.5 0 012.5-2.5h11A2.5 2.5 0 0120 6z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  robot: '<rect x="4" y="7.5" width="16" height="12" rx="3"/><path d="M12 4v3.5"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/>',
  folder: '<path d="M3.5 7.5a2 2 0 012-2h3.2l2 2h7.8a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>',
  file: '<path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5z"/><path d="M14 3.5V8.5h5"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 10l2.5 2.5-2.5 2.5M13 15h4"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.5 1.5M7.5 16.5L6 18M18 18l-1.5-1.5M7.5 7.5L6 6"/>',
  device: '<rect x="4" y="4.5" width="16" height="11" rx="2"/><path d="M9 19.5h6"/>',
  book: '<path d="M5 5.5A2 2 0 017 3.5h12v14H7a2 2 0 00-2 2z"/><path d="M5 19.5a2 2 0 012-2h12"/>',
  // 动作
  send: '<path d="M12 19V6M6 12l6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.5"/><path d="M15 6.5A2.5 2.5 0 0012.5 4h-6A2.5 2.5 0 004 6.5v6A2.5 2.5 0 006.5 15"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 011.5-1.5h2a1.5 1.5 0 011.5 1.5V7M6.5 7l.8 12a2 2 0 002 1.9h5.4a2 2 0 002-1.9L18.5 7"/>',
  refresh: '<path d="M20 12a8 8 0 11-2.3-5.6M20 4v5h-5"/>',
  pencil: '<path d="M4 20h4L19 9a2.5 2.5 0 00-3.5-3.5L4.5 16.5z"/>',
  shield: '<path d="M12 21s7-3.5 7-8.8V5.8L12 3 5 5.8v6.4C5 17.5 12 21 12 21z"/>',
  dots: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16v.5"/>',
  moon: '<path d="M20.5 13.5A8.5 8.5 0 1110.5 3.5a6.8 6.8 0 0010 10z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3"/>',
  play: '<path d="M7.5 5.5l11 6.5-11 6.5z"/>',
  link: '<path d="M10 13.5a3.5 3.5 0 005 0l3.5-3.5a3.5 3.5 0 00-5-5L12 6.5"/><path d="M14 10.5a3.5 3.5 0 00-5 0L5.5 14a3.5 3.5 0 005 5l1.5-1.5"/>',
  key: '<circle cx="8" cy="14" r="3.8"/><path d="M10.8 11.2L19 3h2.5v2.5L20 7l-1.5-1.5"/>',
  puzzle: '<path d="M9.5 4.5h5v2a2 2 0 104 0v2h2v5h-2a2 2 0 100 4h2v2h-5v-2a2 2 0 10-4 0v2h-5v-5h2a2 2 0 100-4h-2v-6z"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-4 8"/>',
};

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 });
</script>

<template>
  <!-- stroke 必须显式给 currentColor：theme.css 的 svg 基线只设了 fill:none，
       少了 stroke 就是「画了但全透明」（T2 实拍逮到，整套图标一个都没显形）。 -->
  <svg
    :width="props.size" :height="props.size" viewBox="0 0 24 24"
    stroke="currentColor" aria-hidden="true" v-html="P[props.name] ?? P.dots"
  />
</template>
