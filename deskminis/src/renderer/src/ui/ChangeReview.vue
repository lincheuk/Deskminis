<script setup lang="ts">
/** F08：审阅面板的取数外壳。取这次改动的对比与预检结论，管确认态（恢复要点两次），发恢复与另存，把结果喂给展示件。
 *  之后的改动里有别的会话做的：不发恢复请求（引擎要求一次恢复的记录都属于同一个会话），只给说明与跳转。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChangeDiff, RestorePrecheck, RestoreReport } from '../../../shared/checkpoint';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import { splitLater } from '../lib/changes/model';
import ChangeReviewView from './ChangeReviewView.vue';

const props = defineProps<{ id: string }>();
/** open：在预览里打开这个文件现在的样子（工作区相对路径）。审阅面板只给行差分，渲染后的文档要到预览里看。 */
const emit = defineEmits<{ (e: 'close'): void; (e: 'open', path: string): void }>();
const chat = useChat();

const diff = ref<ChangeDiff | null>(null);
const pre = ref<RestorePrecheck | null>(null);
const confirming = ref<'single' | 'with-later' | null>(null);
const result = ref<RestoreReport | null>(null);
const saved = ref('');
const busy = ref(false);
/** 取对比与预检的错误。每次重取都重新定。 */
const error = ref('');
/** 恢复 / 另存这次操作本身的错误。与取数的错误分开放：恢复之后紧跟着一次重取（checkpoints.changed 也会触发），
 *  重取成功就把取数的错误清空——合在一起的话这句只闪一下。留到下一次操作或换条目。 */
const actionError = ref('');

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function load(): Promise<void> {
  const sid = chat.activeId; const id = props.id;
  if (!sid) return;
  try {
    const [d, p] = await Promise.all([
      rpc.call('checkpoints.diff', { sessionId: sid, id }),
      rpc.call('checkpoints.inspect', { sessionId: sid, ids: [id] }),
    ]);
    if (chat.activeId !== sid || props.id !== id) return;   // 等的时候换了会话或换了条目
    diff.value = d; pre.value = (p as RestorePrecheck[])[0] ?? null; error.value = '';
  } catch (e) {
    if (chat.activeId !== sid || props.id !== id) return;
    error.value = msgOf(e);
  }
}
function onChanged(p: { sessionId?: string } | undefined): void {
  if (!p || p.sessionId === undefined || p.sessionId === chat.activeId) void load();
}
onMounted(() => { rpc.on('checkpoints.changed', onChanged); void load(); });
onBeforeUnmount(() => { rpc.off('checkpoints.changed', onChanged); });
watch(() => props.id, () => {
  diff.value = null; pre.value = null; confirming.value = null; result.value = null; saved.value = ''; error.value = ''; actionError.value = '';
  void load();
});
// F06：重连之后的整体刷新——丢在断线里的 checkpoints.changed 不会补发，预检结论（能不能恢复）可能已经变了。只重取，不清确认态与结果
watch(() => chat.refreshTick, () => { void load(); });

const later = computed(() => splitLater(pre.value?.verdict.kind === 'conflict' ? pre.value.verdict.later : undefined, chat.activeId ?? ''));
const sessionTitles = computed(() => {
  const out: Record<string, string> = {};
  for (const s of chat.sessions as { id: string; title?: string }[]) out[s.id] = s.title ?? '';
  return out;
});

async function doRestore(ids: string[]): Promise<void> {
  const sid = chat.activeId;
  if (!sid) return;
  actionError.value = ''; busy.value = true;
  try { result.value = await rpc.call('checkpoints.restore', { sessionId: sid, ids, confirm: true }); }
  catch (e) { actionError.value = msgOf(e); }
  finally { busy.value = false; confirming.value = null; }
  void load();
}

/** 第一次点只进确认态（展示件写明将覆盖还是删除哪个文件），第二次才发请求。 */
function onRestore(): void {
  if (pre.value?.verdict.kind !== 'ready') return;
  if (confirming.value !== 'single') { confirming.value = 'single'; return; }
  void doRestore([props.id]);
}

/** 连同之后的改动一起恢复：只在之后的改动全部属于本会话时可用；有别的会话的记录时绝不发请求。 */
function onRestoreWithLater(): void {
  const l = later.value;
  if (l.elsewhere.length > 0 || l.here.length === 0) return;
  if (confirming.value !== 'with-later') { confirming.value = 'with-later'; return; }
  void doRestore([props.id, ...l.here]);
}

async function onSaveCopy(which: 'before' | 'after'): Promise<void> {
  const sid = chat.activeId;
  if (!sid) return;
  actionError.value = ''; busy.value = true;
  try {
    const r = await rpc.call('checkpoints.saveCopy', { sessionId: sid, id: props.id, which, confirm: true });
    saved.value = (r as { path: string }).path;
  } catch (e) { actionError.value = msgOf(e); }
  finally { busy.value = false; }
}

function gotoSession(sessionId: string): void { void chat.open(sessionId); }

/** 「查看当前文件」：交给外壳在预览里打开（预览只读工作区内的文件，展示件只在那种情况下给这个入口）。 */
function openCurrent(path: string): void { emit('open', path); }
</script>

<template>
  <ChangeReviewView
    :diff="diff" :verdict="pre?.verdict ?? null" :message="pre?.message ?? ''"
    :later-here="later.here" :later-elsewhere="later.elsewhere" :session-titles="sessionTitles"
    :confirming="confirming" :result="result" :saved="saved" :busy="busy" :error="error" :action-error="actionError"
    @restore="onRestore" @restore-with-later="onRestoreWithLater" @save-copy="onSaveCopy"
    @goto-session="gotoSession" @open-current="openCurrent" @close="emit('close')"
  />
</template>
