<script setup lang="ts">
/** V3：思考块。模型的推理内容——默认收起，点开看全文。
 *  为什么要有：开了推理的模型每轮都在烧 reasoning token，
 *  界面一个字不显示等于这些 token 白花，出错时也无从判断它是怎么想歪的。
 *  流式态默认展开（正在想什么是当下有用的信息），落库后默认收起（历史里它是附录）。 */
import { ref, watch } from 'vue';

const props = withDefaults(defineProps<{ text: string; live?: boolean }>(), { live: false });
const open = ref(props.live);
watch(() => props.live, (v) => { if (v) open.value = true; });
</script>

<template>
  <div v-if="props.text" class="think" :class="{ live: props.live }">
    <button class="thead t-aux" type="button" :aria-expanded="open" @click="open = !open">
      <span class="dot"></span>
      <span>{{ props.live ? '正在思考' : '思考过程' }}</span>
      <span class="chev">{{ open ? '收起' : '展开' }}</span>
    </button>
    <div v-if="open" class="tbody">{{ props.text }}</div>
  </div>
</template>

<style scoped>
.think {
  border-left: 2px solid var(--c-aou); padding-left: var(--sp-5);
  display: flex; flex-direction: column; gap: var(--sp-2);
}
.thead {
  display: inline-flex; align-items: center; gap: var(--sp-2); align-self: flex-start;
  background: none; cursor: pointer; color: var(--c-ink-3); font-family: inherit; padding: 0;
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-aou); flex: 0 0 auto; }
.think.live .dot { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.chev { color: var(--c-ink-4); }
.tbody {
  font-size: var(--t-body-size); line-height: 1.7; color: var(--c-ink-3);
  white-space: pre-wrap; word-break: break-word;
}
</style>
