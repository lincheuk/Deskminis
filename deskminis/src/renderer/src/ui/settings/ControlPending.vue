<script setup lang="ts">
/** 执行隔离第 2 步（二）：被 DeskMinis 以外的程序改过的 MCP 配置、技能、记忆。
 *  确认之前引擎不连接这台 MCP 服务器、不把这个技能列进索引、不注入这个记忆文件。
 *  内容由引擎给（启动命令、文件开头），像密钥的值已遮掉；确认时带上看到的那一版指纹，看过之后又被改过就会被拒。 */
import { onMounted, ref } from 'vue';
import { useChat, type UiControlPending } from '../../stores/chat';

const chat = useChat();
const busy = ref('');
const error = ref('');
const KIND_TEXT: Record<UiControlPending['kind'], string> = {
  mcp: '确认之前不会启动或连接它。',
  skill: '确认之前不会列进技能索引。',
  memory: '确认之前不会注入对话。',
};
const keyOf = (i: UiControlPending): string => `${i.kind}:${i.key}`;

async function confirm(i: UiControlPending): Promise<void> {
  if (busy.value) return;
  busy.value = keyOf(i);
  error.value = '';
  try { await chat.confirmControlPending(i); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = ''; }
}
onMounted(() => { void chat.refreshControlPending(); });
</script>

<template>
  <section class="f-sec" data-control-pending>
    <h2>外部改动</h2>
    <p class="f-note">
      MCP 服务器的启动命令会被执行，技能和记忆会进对话。它们被 DeskMinis 以外的程序（包括 agent 跑的命令）改过时，
      先在这里看一眼再用。不认识的改动不要确认：可以到 MCP、技能页删掉，或把记忆文件改回去。
    </p>
    <p v-if="error" class="errline t-body" role="alert">{{ error }}</p>
    <p v-if="!chat.controlPending.length" class="f-hint">没有等你确认的改动。</p>
    <div v-for="i in chat.controlPending" :key="keyOf(i)" class="f-card item">
      <div class="f-row head">
        <strong>{{ i.title }}</strong>
        <span class="tag t-aux">{{ i.reason === 'new' ? '新出现' : '内容变了' }}</span>
      </div>
      <p class="f-hint">{{ KIND_TEXT[i.kind] }}</p>
      <pre class="preview">{{ i.preview }}</pre>
      <div class="f-row">
        <button class="f-btn primary" type="button" :disabled="!!busy" @click="confirm(i)">
          {{ busy === keyOf(i) ? '确认中…' : '我看过了，可以使用' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.item { gap: var(--sp-3); }
.head { justify-content: space-between; }
.tag { padding: 0 var(--sp-3); border-radius: var(--r-s); background: var(--c-warn-soft); color: var(--c-warn); }
.preview {
  margin: 0; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-all;
  padding: var(--sp-4); border-radius: var(--r-s); background: var(--c-bg-1); color: var(--c-ink-2);
  font-family: var(--f-mono); font-size: var(--t-aux-size); line-height: var(--t-aux-lh);
}
.errline { margin: 0; color: var(--c-err); }
</style>
