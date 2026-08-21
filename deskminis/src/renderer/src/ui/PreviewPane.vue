<script setup lang="ts">
/** T 波：产出物预览区——**主舞台**（用户 2026-08-21 参考图：对话只占左边一条，
 *  agent 做出来的东西占中间大块）。这是 Cowork 形态的核心：产出物是主角，对话是辅助。
 *
 *  能力边界（诚实）：md/文本/代码/图片本地直接渲染；.docx/.xlsx/.pptx 这类
 *  Office 二进制我们没有渲染器（AionUi 靠他们自家 OfficeCLI），故给文件信息 +
 *  路径复制，不假装能预览。 */
import { computed, ref, watch } from 'vue';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import { parseMarkdown } from '../lib/markdown/parse';
import MarkdownView from '../components/MarkdownView.vue';
import UiIcon from './UiIcon.vue';

const props = defineProps<{ path: string | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const chat = useChat();

interface Preview { path: string; size: number; content: string; truncated: boolean; binary: boolean }
const data = ref<Preview | null>(null);
const loading = ref(false);
const failed = ref('');
const mode = ref<'render' | 'source'>('render');
const copied = ref(false);

const ext = computed(() => (props.path ?? '').toLowerCase().split('.').pop() ?? '');
const isMd = computed(() => ['md', 'markdown'].includes(ext.value));
const isImg = computed(() => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext.value));
const isOffice = computed(() => ['docx', 'xlsx', 'xlsm', 'pptx', 'doc', 'xls', 'ppt', 'pdf'].includes(ext.value));
const nodes = computed(() => (isMd.value && mode.value === 'render' && data.value && !data.value.binary)
  ? parseMarkdown(data.value.content) : null);

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function load(): Promise<void> {
  if (!props.path || !chat.activeId) { data.value = null; return; }
  loading.value = true; failed.value = ''; data.value = null; mode.value = 'render';
  try {
    data.value = await rpc.call('files.read', { sessionId: chat.activeId, path: props.path });
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e);
  } finally { loading.value = false; }
}
watch(() => props.path, load, { immediate: true });
// 回合落盘后 agent 可能改了正在看的文件：自动重读
watch(() => chat.running, (now, prev) => { if (prev && !now) void load(); });

async function copyPath(): Promise<void> {
  const abs = `${chat.workspaceRoot || ''}/${props.path ?? ''}`.replace(/\/+/g, '/');
  try { await navigator.clipboard.writeText(abs); copied.value = true; setTimeout(() => (copied.value = false), 1400); }
  catch { /* 剪贴板不可用：静默 */ }
}
</script>

<template>
  <section class="pane">
    <header class="head">
      <UiIcon :name="isImg ? 'file' : 'file'" :size="15" />
      <span class="name">{{ props.path }}</span>
      <span v-if="data" class="meta t-aux tnum">
        {{ fmtSize(data.size) }}<template v-if="data.truncated"> · 仅前缀</template>
      </span>
      <span v-if="isMd && data && !data.binary" class="seg">
        <button type="button" :class="{ on: mode === 'render' }" @click="mode = 'render'">渲染</button>
        <button type="button" :class="{ on: mode === 'source' }" @click="mode = 'source'">源码</button>
      </span>
      <button class="ib" type="button" :title="copied ? '已复制' : '复制完整路径'" @click="copyPath">
        <UiIcon :name="copied ? 'check' : 'copy'" :size="15" />
      </button>
      <button class="ib" type="button" title="关闭预览" @click="emit('close')"><UiIcon name="x" :size="15" /></button>
    </header>

    <div class="body">
      <div v-if="loading" class="hint t-body">读取中…</div>
      <div v-else-if="failed" class="hint t-body err">{{ failed }}</div>

      <!-- Office 二进制：没有渲染器就说没有，不拿一堆乱码假装预览 -->
      <div v-else-if="isOffice" class="card">
        <UiIcon name="file" :size="28" />
        <p class="t-h2">{{ (props.path ?? '').split('/').pop() }}</p>
        <p class="t-body sub">这类文件需要 Office 应用打开，DeskMinis 暂不内嵌渲染。</p>
        <button class="btn" type="button" @click="copyPath">{{ copied ? '路径已复制' : '复制完整路径' }}</button>
      </div>

      <div v-else-if="isImg" class="imgwrap"><img :src="`file://${chat.workspaceRoot}/${props.path}`" :alt="props.path ?? ''" /></div>
      <div v-else-if="data?.binary" class="hint t-body">二进制文件不可预览</div>
      <div v-else-if="nodes" class="doc"><MarkdownView :nodes="nodes" /></div>
      <pre v-else-if="data" class="src">{{ data.content }}</pre>
      <div v-else class="hint t-body">选择左侧文件查看</div>
    </div>
  </section>
</template>

<style scoped>
.pane { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--c-bg); border-left: 1px solid var(--c-line); }
.head {
  flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-3);
  height: var(--h-field); padding: 0 var(--sp-4);
  border-bottom: 1px solid var(--c-line); background: var(--c-bg-1);
}
.head :deep(svg) { color: var(--c-ink-3); flex: 0 0 auto; }
.name {
  flex: 1; min-width: 0; font-family: var(--f-mono);
  font-size: var(--t-aux-size); color: var(--c-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.meta { flex: 0 0 auto; color: var(--c-ink-3); }
.seg { display: inline-flex; flex: 0 0 auto; border: 1px solid var(--c-line); border-radius: var(--r-s); overflow: hidden; }
.seg button {
  padding: 2px 8px; background: none; cursor: pointer;
  font-size: var(--t-aux-size); color: var(--c-ink-2); font-family: inherit;
}
.seg button.on { background: var(--c-brand); color: var(--c-brand-ink); font-weight: var(--w-md); }
.ib {
  width: 26px; height: 26px; border-radius: var(--r-s); flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: none; cursor: pointer; padding: 0;
}
.ib:hover { background: var(--c-bg-2); }

/* 灰底衬纸：产出物预览是「看文档」不是「看数据」，纸感来自 底色/白纸/阴影/页边距 四件套 */
.body { flex: 1; min-height: 0; overflow: auto; background: var(--c-bg-2); }
.hint { padding: var(--sp-8); text-align: center; color: var(--c-ink-3); }
.hint.err { color: var(--c-err); }

/* 文档态：真·白纸——灰底上一张有页边距的纸，A4 比例的观感 */
.doc {
  width: min(760px, 100% - var(--sp-7) * 2);
  margin: var(--sp-7) auto;
  padding: 56px 64px 72px;
  background: var(--c-bg);
  border-radius: 2px;                 /* 纸不该有大圆角 */
  box-shadow: var(--sh-paper);
  font-size: var(--t-chat-size); line-height: 1.75; color: var(--c-ink);
}
@media (max-width: 900px) { .doc { padding: 32px 28px 48px; } }
.src {
  margin: var(--sp-7) auto; width: min(880px, 100% - var(--sp-7) * 2);
  background: var(--c-bg); border-radius: var(--r-s);
  box-shadow: var(--sh-paper);
  padding: var(--sp-6) var(--sp-7);
  font-family: var(--f-mono); font-size: var(--t-code-size); line-height: var(--t-code-lh);
  color: var(--c-ink-2); white-space: pre-wrap; word-break: break-word;
}
.imgwrap { padding: var(--sp-7); display: flex; justify-content: center; }
.imgwrap img { max-width: 100%; border-radius: var(--r-m); }

.card {
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-3);
  padding: 12vh var(--sp-8); text-align: center; color: var(--c-ink-3);
}
.card p { margin: 0; }
.card .t-h2 { color: var(--c-ink); font-family: var(--f-mono); }
.card .sub { color: var(--c-ink-3); max-width: 360px; }
.btn {
  margin-top: var(--sp-2); height: var(--h-ctl); padding: 0 var(--sp-6);
  border-radius: var(--r-s); cursor: pointer; font-family: inherit;
  background: var(--c-bg-2); color: var(--c-ink); font-size: var(--t-body-size);
}
.btn:hover { background: var(--c-bg-3); }
</style>
