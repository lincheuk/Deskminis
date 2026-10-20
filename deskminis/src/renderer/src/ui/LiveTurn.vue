<script setup lang="ts">
/** 实时正文与思考只在这个回合订阅，历史会话不随增量更新。 */
import { computed, onBeforeUnmount, shallowRef, watch, ref } from 'vue';
import { useChat } from '../stores/chat';
import { parseLiveMarkdown } from '../lib/markdown/parse';
import { showLiveReasoning } from '../lib/reasoning';
import { stepStatus, lastTurnStart, isResultCarrier } from '../lib/steps/status';
import { formatDuration } from '../lib/time/duration';
import MarkdownView from '../components/MarkdownView.vue';
import ThinkBlock from './ThinkBlock.vue';
import StepGroup from './StepGroup.vue';

const emit = defineEmits<{ (e: 'content'): void }>();
const chat = useChat();
// 增量各在一个任务里到达，只让显示快照每帧更新一次，避免反复解析、排版。
const display = shallowRef({ text: chat.streamingText, thinking: chat.streamingThinking });
let displayFrame: number | undefined;
function cancelDisplay(): void {
  if (displayFrame !== undefined) cancelAnimationFrame(displayFrame);
  displayFrame = undefined;
}
function publishDisplay(): void {
  cancelDisplay();
  const text = chat.streamingText, thinking = chat.streamingThinking;
  if (text === display.value.text && thinking === display.value.thinking) return;
  display.value = { text, thinking };
  emit('content');
}
const streamNodes = computed(() => display.value.text ? parseLiveMarkdown(display.value.text) : null);
const liveSteps = computed(() => chat.toolCards.map(c => ({
  name: c.name, title: c.title || c.name,
  status: stepStatus(c.success === undefined ? undefined : c, true),
  output: c.output ?? null, input: c.input,
})));
watch(() => [chat.streamingText, chat.streamingThinking] as const, ([text, thinking], [oldText, oldThinking]) => {
  // 清空、替换与终态不能晚一帧，否则会留下旧运行的尾巴；只有连续增长才合帧。
  if (!chat.running || !text.startsWith(oldText) || !thinking.startsWith(oldThinking)) {
    publishDisplay();
  } else if (displayFrame === undefined) {
    displayFrame = requestAnimationFrame(publishDisplay);
  }
}, { flush: 'sync' });
watch(() => [chat.activeId, chat.engineEpoch, chat.runOf[chat.activeId]?.runId,
  chat.runOf[chat.activeId]?.generation, chat.running, chat.midRun, chat.joinedTail] as const,
  publishDisplay, { flush: 'sync' });
onBeforeUnmount(cancelDisplay);

// 时钟只刷新标签，正文仍由显示快照驱动并缓存解析。
const shownAt = ref(Date.now() / 1000), now = ref(shownAt.value);
let elapsedTimer: ReturnType<typeof setInterval> | undefined;
function stopClock(): void {
  if (elapsedTimer !== undefined) clearInterval(elapsedTimer);
  elapsedTimer = undefined;
}
watch(() => [chat.activeId, chat.runOf[chat.activeId]?.runId, chat.runOf[chat.activeId]?.generation], () => {
  shownAt.value = now.value = Date.now() / 1000;
});
watch(() => chat.running, running => {
  stopClock();
  if (!running) return;
  now.value = Date.now() / 1000;
  elapsedTimer = setInterval(() => { now.value = Date.now() / 1000; }, 1000);
}, { immediate: true, flush: 'sync' });
const elapsed = computed(() => {
  const user = chat.messages[lastTurnStart(chat.messages)];
  const start = user?.role === 'user' && !isResultCarrier(user) && typeof user.createdAt === 'number' ? user.createdAt : shownAt.value;
  return formatDuration(now.value - start);
});
onBeforeUnmount(stopClock);
</script>

<template>
  <section class="turn" data-turn-id="live">
    <div v-if="chat.midRun" class="waiting t-aux" role="status">仍在运行（切换前的输出在本回合结束后显示）</div>
    <template v-else>
      <div v-if="showLiveReasoning(display.thinking)" class="ablock"><ThinkBlock live :text="display.thinking" /></div>
      <div v-if="chat.toolCards.length" class="ablock"><StepGroup live :steps="liveSteps" /></div>
      <div v-if="streamNodes" class="ablock"><MarkdownView class="t-chat" :nodes="streamNodes" /></div>
      <div v-else-if="chat.running" class="waiting t-aux">正在思考…</div>
    </template>
    <div v-if="chat.running && elapsed" class="turn-elapsed t-aux tnum">已用 {{ elapsed }}</div>
  </section>
</template>

<style scoped>
.turn { display: flex; flex-direction: column; gap: var(--sp-5); }
.ablock { color: var(--c-ink); }
.ablock :deep(.md) { font-size: var(--t-chat-size); line-height: var(--t-chat-lh); }
.turn-elapsed { height: 20px; line-height: 20px; flex: none; color: var(--c-ink-3); white-space: nowrap; }
.waiting { color: var(--c-ink-3); }
</style>
