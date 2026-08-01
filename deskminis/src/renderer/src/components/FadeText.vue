<script setup lang="ts">
/** MU2a Task 3：流式尾部纯文本词粒度淡入（设计 §2.4）。
 *  watch text → diffWords → 追加 span（新批词独立 0.08s 窗口交错，批间自然重叠——OpenMinis 同思路）；
 *  稳定前缀不落 span（committed 文本节点，零动画成本）；非前缀（流式重置）整体重来。
 *  reduced-motion 降级：动画关闭，全部即时呈现（§8）。 */
import { ref, watch } from 'vue';
import { diffWords, type FadeWord } from '../lib/fade/split';

const props = defineProps<{ text: string }>();

const stable = ref('');
const words = ref<FadeWord[]>([]);

watch(() => props.text, (next, prev) => {
  const d = diffWords(prev ?? '', next);
  if (d.stable === '') {
    // 整体重来（首帧 / 流式重置）：清空重切
    stable.value = '';
    words.value = d.added;
  } else {
    // 前缀追加：旧 span 留任（各自完成 0.3s 淡入），只追加新批
    words.value = words.value.concat(d.added);
  }
}, { immediate: true });
</script>

<template>
  <span class="fade-text">{{ stable }}<span v-for="(w, i) in words" :key="i" class="fade-word" :style="{ animationDelay: `${w.delay}s` }">{{ w.word }}</span></span>
</template>

<style scoped>
.fade-text { white-space: pre-wrap; word-break: break-word; align-self: stretch; }
.fade-word { animation: fade-word-in 0.3s ease-out both; }
@keyframes fade-word-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .fade-word { animation: none; }
}
</style>
