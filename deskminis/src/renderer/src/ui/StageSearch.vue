<script setup lang="ts">
/** T5：会话搜索。
 *
 *  **边界要说清楚**：后端没有消息全文索引（没有 chat.sessions.search 这类 RPC），
 *  所以这里搜的是**会话标题**，不是消息正文。做全文搜索要在 minisd 侧建索引，
 *  是另一个量级的东西——留候选。界面上直说，不让用户以为搜不到就是没有。 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import { fmtRelative } from '../lib/time/relative';
import UiIcon from './UiIcon.vue';

const chat = useChat();
const emit = defineEmits<{ (e: 'view', v: 'chat'): void }>();
const q = ref('');
const box = ref<HTMLInputElement | null>(null);
const nowSec = Math.floor(Date.now() / 1000);

onMounted(async () => { await nextTick(); box.value?.focus(); });

const hits = computed(() => {
  const k = q.value.trim().toLowerCase();
  if (!k) return chat.sessions.slice(0, 30);
  return chat.sessions.filter(s => (s.title || '新会话').toLowerCase().includes(k));
});

function open(id: string): void { void chat.open(id); emit('view', 'chat'); }
</script>

<template>
  <div class="scroll">
    <div class="col">
      <div class="box">
        <UiIcon name="search" :size="17" />
        <input ref="box" v-model="q" class="qin" placeholder="按标题搜索会话" />
        <button v-if="q" class="clr" type="button" title="清空" @click="q = ''"><UiIcon name="x" :size="14" /></button>
      </div>
      <p class="f-hint edge">搜的是会话标题。消息正文还没有索引，搜不到不代表没有。</p>

      <p v-if="!hits.length" class="f-note">没有匹配的会话。</p>
      <button v-for="s in hits" :key="s.id" type="button" class="hit" @click="open(s.id)">
        <UiIcon name="chat" :size="15" />
        <span class="htitle">{{ s.title || '新会话' }}</span>
        <span class="htime t-aux tnum">{{ s.updatedAt ? fmtRelative(s.updatedAt, nowSec) : '' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.scroll { flex: 1; min-height: 0; overflow-y: auto; background: var(--c-bg); }
.col {
  width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto;
  padding: var(--sp-8) 0; display: flex; flex-direction: column; gap: var(--sp-2);
}
.box {
  display: flex; align-items: center; gap: var(--sp-4);
  height: 48px; padding: 0 var(--sp-6); margin-bottom: var(--sp-1);
  background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-input);
}
.box:focus-within { border-color: var(--c-brand); box-shadow: var(--sh-focus); }
.box :deep(svg) { color: var(--c-ink-3); flex: 0 0 auto; }
.qin {
  flex: 1; min-width: 0; background: none; font-family: inherit;
  font-size: var(--t-chat-size); color: var(--c-ink); outline: none;
}
.qin::placeholder { color: var(--c-ink-4); }
.clr {
  width: 24px; height: 24px; border-radius: 50%; flex: 0 0 auto; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; background: var(--c-bg-2);
}
.edge { margin: 0 0 var(--sp-4); padding-left: var(--sp-6); }

.hit {
  display: flex; align-items: center; gap: var(--sp-4); width: 100%;
  padding: var(--sp-3) var(--sp-5); border-radius: var(--r-s); cursor: pointer;
  background: none; color: var(--c-ink-2); text-align: left;
  font-size: var(--t-item-size); line-height: var(--t-item-lh); font-family: inherit;
}
.hit:hover { background: var(--c-bg-1); color: var(--c-ink); }
.hit :deep(svg) { color: var(--c-ink-4); flex: 0 0 auto; }
.htitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.htime { flex: 0 0 auto; color: var(--c-ink-3); }
</style>
