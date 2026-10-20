<script setup lang="ts">
/** V3：思考块。模型的推理内容——默认收起，点开看全文。
 *  为什么要有：开了推理的模型每轮都在烧 reasoning token，
 *  界面一个字不显示等于这些 token 白花，出错时也无从判断它是怎么想歪的。
 *  流式态默认展开（正在想什么是当下有用的信息），落库后默认收起（历史里它是附录）。
 *  N25：生成中锁定展开；收起的高度过渡结束后释放长文本。 */
import { onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ text: string; live?: boolean }>(), { live: false });
const open = ref(props.live);
const rendered = ref(props.live);
let cleanup: ReturnType<typeof setTimeout> | undefined;
function clearCleanup(): void { clearTimeout(cleanup); cleanup = undefined; }
function finishClose(): void { if (!open.value) rendered.value = false; clearCleanup(); }
function reduced(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function toggle(): void {
  if (props.live) return;
  clearCleanup();
  open.value = !open.value;
  if (open.value) rendered.value = true;
  else if (reduced()) finishClose();
  // 无布局的测试宿主、后台页或被取消的过渡也要释放正文，不能只依赖 transitionend。
  else cleanup = setTimeout(finishClose, 220);
}
function transitioned(e: TransitionEvent): void {
  if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows') finishClose();
}
watch(() => props.live, v => { if (v) { clearCleanup(); rendered.value = true; open.value = true; } });
onBeforeUnmount(clearCleanup);
</script>

<template>
  <div v-if="props.text" class="think" :class="{ live: props.live }">
    <button class="thead t-aux" type="button" :aria-expanded="open" :aria-disabled="props.live"
      :title="props.live ? '生成中保持展开' : undefined" @click="toggle">
      <span class="dot"></span>
      <span>{{ props.live ? '正在思考' : '思考过程' }}</span>
      <span class="chev">{{ open ? '收起' : '展开' }}</span>
    </button>
    <div class="tbody" :class="{ open }" @transitionend="transitioned">
      <div v-if="rendered" class="tinner">{{ props.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.think { border-left: 2px solid var(--c-aou); padding-left: var(--sp-5); display: flex; flex-direction: column; gap: 0; }
.thead { display: inline-flex; align-items: center; gap: var(--sp-2); align-self: flex-start; background: none; cursor: pointer; color: var(--c-ink-3); font-family: inherit; padding: 0; }
.thead[aria-disabled="true"] { cursor: default; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-aou); flex: 0 0 auto; }
.think.live .dot { animation: dm-think-pulse 1.2s ease-in-out infinite; }
.chev { color: var(--c-ink-4); }
.tbody { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 200ms cubic-bezier(0.19, 1, 0.22, 1); }
.tbody.open { grid-template-rows: 1fr; }
.tinner { min-height: 0; overflow: hidden; font-size: var(--t-body-size); line-height: 1.7; color: var(--c-ink-3); white-space: pre-wrap; word-break: break-word; }
/* 间距随正文一起折叠，0fr 不再留下 flex gap；正文仍在过渡后释放。 */
.tinner::before { content: ''; display: block; height: var(--sp-2); }
</style>
