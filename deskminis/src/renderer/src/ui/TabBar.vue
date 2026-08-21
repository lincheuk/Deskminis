<script setup lang="ts">
/** T 波：舞台标签页（参考图里对话区上方那排 tab）。
 *  两类标签并排：
 *  ① **会话标签**——当前会话（带助手 emoji），点它回到纯对话；
 *  ② **产出物标签**——打开过的文件各一个，点切换、× 关闭。
 *  这比「一个预览区被反复覆盖」好用：agent 一轮做出好几个文件时，来回对照不用重新找。 */
import { computed } from 'vue';
import { useChat } from '../stores/chat';
import UiIcon from './UiIcon.vue';

const props = defineProps<{ open: string[]; active: string | null }>();
const emit = defineEmits<{
  (e: 'pick', path: string | null): void;
  (e: 'close', path: string): void;
}>();
const chat = useChat();

const sessionTitle = computed(() => {
  const s = chat.sessions.find(x => x.id === chat.activeId);
  return s?.title || '新会话';
});
const sessionEmoji = computed(() => {
  const s = chat.sessions.find(x => x.id === chat.activeId);
  return s?.assistantId ? (chat.assistants.find(a => a.id === s.assistantId)?.avatar ?? '') : '';
});
const baseName = (p: string): string => p.split('/').pop() ?? p;
</script>

<template>
  <div class="tabs">
    <button class="tab" :class="{ on: props.active === null }" type="button" @click="emit('pick', null)">
      <span v-if="sessionEmoji" class="emo">{{ sessionEmoji }}</span>
      <UiIcon v-else name="chat" :size="14" />
      <span class="tt">{{ sessionTitle }}</span>
    </button>

    <button
      v-for="p in props.open" :key="p" type="button"
      class="tab" :class="{ on: props.active === p }" @click="emit('pick', p)"
    >
      <UiIcon name="file" :size="14" />
      <span class="tt">{{ baseName(p) }}</span>
      <span class="x" role="button" :aria-label="`关闭 ${baseName(p)}`" @click.stop="emit('close', p)">
        <UiIcon name="x" :size="12" />
      </span>
    </button>
  </div>
</template>

<style scoped>
.tabs {
  flex: 0 0 auto; display: flex; align-items: flex-end; gap: var(--sp-1);
  height: var(--h-field); padding: 0 var(--sp-3);
  background: var(--c-bg-1); border-bottom: 1px solid var(--c-line);
  overflow-x: auto; overflow-y: hidden;
}
.tab {
  display: inline-flex; align-items: center; gap: var(--sp-2); flex: 0 0 auto;
  max-width: 220px; height: 30px; padding: 0 var(--sp-3) 0 var(--sp-4);
  border-radius: var(--r-s) var(--r-s) 0 0;
  background: none; color: var(--c-ink-3); cursor: pointer;
  font-size: var(--t-aux-size); font-family: inherit;
}
.tab:hover { background: var(--c-bg-2); color: var(--c-ink-2); }
/* 选中页与下方内容同底色，视觉上「连成一片」——这是标签页该有的从属感 */
.tab.on { background: var(--c-bg); color: var(--c-ink); font-weight: var(--w-md); }
.tab :deep(svg) { flex: 0 0 auto; }
.emo { font-size: 13px; line-height: 1; flex: 0 0 auto; }
.tt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.x {
  flex: 0 0 auto; width: 16px; height: 16px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center; color: var(--c-ink-3);
}
.x:hover { background: var(--c-bg-3); color: var(--c-ink); }
</style>
