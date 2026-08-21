<script setup lang="ts">
/** V2：事件提示条。降级 / 压缩 / 卸载 / 修剪 / 重试 / 出错 / 同步七类一套语法：
 *  `[图标] 短句 · 详情[›] [重试]`。
 *
 *  为什么必须有：出错时没有重试入口，用户只能重新打一遍问题；
 *  降级到备选模型时不告知，用户拿着次一档模型的输出以为是主模型给的。
 *  文案与语调走 lib/eventnote/copy（纯函数，已有单测），这里只负责渲染。 */
import { useChat } from '../stores/chat';
import { eventCopy } from '../lib/eventnote/copy';
import UiIcon from './UiIcon.vue';

const chat = useChat();

/** copy 层给的是旧 Icon.vue 的名字，新图标集没有 info：统一在这里落地映射，
 *  漏掉的一律退回 alert（宁可图标不精确，也不要一个透明的空位）。 */
const ICONS: Record<string, string> = {
  fallback: 'alert', compacted: 'refresh', offloaded: 'folder',
  pruned: 'trash', retry: 'clock', error: 'alert', synced: 'check',
};
const TONES: Record<string, string> = {
  fallback: 'warn', compacted: 'info', offloaded: 'info',
  pruned: 'info', retry: 'warn', error: 'err', synced: 'ok',
};
function shortOf(n: { kind: string; detail?: string }): string {
  if (n.kind === 'synced') return '已与其他设备同步';
  return eventCopy(n.kind, n.detail).short || n.detail || '';
}
</script>

<template>
  <div v-if="chat.eventNotes.length" class="notes">
    <div v-for="(n, i) in chat.eventNotes" :key="i" class="note" :class="`tone-${TONES[n.kind] ?? 'info'}`">
      <UiIcon :name="ICONS[n.kind] ?? 'alert'" :size="14" />
      <span class="short">{{ shortOf(n) }}</span>
      <details v-if="n.detail" class="det">
        <summary>详情</summary>
        <span class="dtext">{{ n.detail }}</span>
      </details>
      <button v-if="n.retryable" class="rt" type="button" @click="chat.retryLast()">重试</button>
    </div>
  </div>
</template>

<style scoped>
.notes { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); }
.note {
  display: inline-flex; align-items: center; gap: var(--sp-2); max-width: 100%;
  padding: var(--sp-2) var(--sp-4); border-radius: var(--r-s);
  font-size: var(--t-aux-size); line-height: var(--t-aux-lh);
  background: var(--c-bg-1); color: var(--c-ink-2);
}
.note :deep(svg) { flex: 0 0 auto; }
.short { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tone-warn { background: var(--c-warn-soft); color: var(--c-warn); }
.tone-info { background: var(--c-tips); color: var(--c-ink-2); }
.tone-err { background: var(--c-err-soft); color: var(--c-err); }
.tone-ok { background: var(--c-ok-soft); color: var(--c-ok); }

.det { min-width: 0; }
.det summary { cursor: pointer; color: inherit; opacity: .75; }
.dtext { display: block; margin-top: var(--sp-2); font-family: var(--f-mono); word-break: break-all; white-space: pre-wrap; }
.rt {
  flex: 0 0 auto; height: var(--h-mini); padding: 0 var(--sp-4); cursor: pointer;
  border-radius: var(--r-pill); font-family: inherit; font-size: var(--t-aux-size); font-weight: var(--w-md);
  background: var(--c-err); color: var(--c-err-ink);
}
.rt:hover { filter: brightness(1.08); }
</style>
