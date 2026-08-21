<script setup lang="ts">
/** T 波：产出物预览区——**主舞台**（用户 2026-08-21 参考图：对话只占左边一条，
 *  agent 做出来的东西占中间大块）。这是 Cowork 形态的核心：产出物是主角，对话是辅助。
 *
 *  能力边界（诚实）：md/文本/代码/图片本地直接渲染；U2 起 .docx/.xlsx/.pptx
 *  走 office.read 解出**内容预览**（文字/表格/大纲，非版式还原）；
 *  legacy .doc/.xls/.ppt 与 .pdf 是另一套二进制格式，明说不支持——照 OfficeCLI
 *  的教训，硬塞给解析器只会给用户假希望。 */
import { computed, ref, watch } from 'vue';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import { parseMarkdown } from '../lib/markdown/parse';
import MarkdownView from '../components/MarkdownView.vue';
import OfficeView from './OfficeView.vue';
import type { OfficeDoc } from '../../../minisd/office/parse';
import UiIcon from './UiIcon.vue';

const props = defineProps<{ path: string | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const chat = useChat();

interface Preview { path: string; size: number; content: string; truncated: boolean; binary: boolean }
const data = ref<Preview | null>(null);
/** U2：OOXML 解析结果。与 data 互斥——同一个文件不会既是文本又是 Office 文档。 */
const officeDoc = ref<OfficeDoc | null>(null);
const loading = ref(false);
const failed = ref('');
const officeFailed = ref('');
/** 三态（原图工具条：Source | Preview | 分栏）——分栏是他们那条工具条里
 *  唯一高亮成蓝色的按钮，说明是常用态：左边源码右边渲染，边改边看。 */
const mode = ref<'render' | 'source' | 'split'>('render');
const copied = ref(false);

const ext = computed(() => (props.path ?? '').toLowerCase().split('.').pop() ?? '');
const isMd = computed(() => ['md', 'markdown'].includes(ext.value));
const isImg = computed(() => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext.value));
/** 能解的（OOXML = ZIP + XML）与不能解的（legacy 二进制 / PDF）必须是**两个独立判定**：
 *  合成一个就会把老格式也喂给解析器，用户拿到的是一句解析失败而不是一句"这格式不支持"。 */
const isOoxml = computed(() => ['docx', 'xlsx', 'xlsm', 'pptx'].includes(ext.value));
const isLegacy = computed(() => ['doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'].includes(ext.value));
const canRender = computed(() => isMd.value && !!data.value && !data.value.binary);
const nodes = computed(() => (canRender.value && mode.value !== 'source')
  ? parseMarkdown(data.value!.content) : null);
/** 源码行号：原图编辑器左侧有行号槽，没有行号的代码块读起来没有坐标。 */
const lines = computed(() => (data.value?.content ?? '').split('\n'));

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function load(): Promise<void> {
  data.value = null; officeDoc.value = null; failed.value = ''; officeFailed.value = '';
  if (!props.path || !chat.activeId) return;
  loading.value = true; mode.value = 'render';
  try {
    if (isOoxml.value) {
      officeDoc.value = await rpc.call('office.read', { sessionId: chat.activeId, path: props.path });
    } else if (!isLegacy.value) {
      data.value = await rpc.call('files.read', { sessionId: chat.activeId, path: props.path });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 分开报：Office 解析失败要连着「换系统 Office 打开」的出路一起给
    if (isOoxml.value) officeFailed.value = msg; else failed.value = msg;
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
      <span v-if="canRender" class="seg">
        <button type="button" :class="{ on: mode === 'source' }" @click="mode = 'source'">源码</button>
        <button type="button" :class="{ on: mode === 'render' }" @click="mode = 'render'">渲染</button>
        <button type="button" class="ic" :class="{ on: mode === 'split' }" title="分栏对照" @click="mode = 'split'">
          <UiIcon name="aside" :size="14" />
        </button>
      </span>
      <button class="ib" type="button" :title="copied ? '已复制' : '复制完整路径'" @click="copyPath">
        <UiIcon :name="copied ? 'check' : 'copy'" :size="15" />
      </button>
      <button class="ib" type="button" title="关闭预览" @click="emit('close')"><UiIcon name="x" :size="15" /></button>
    </header>

    <div class="body">
      <div v-if="loading" class="hint t-body">读取中…</div>
      <div v-else-if="failed" class="hint t-body err">{{ failed }}</div>

      <!-- U2：OOXML 解出内容预览；解析失败也要给出路，不是一句红字了事 -->
      <OfficeView v-else-if="officeDoc" :doc="officeDoc" />
      <div v-else-if="officeFailed" class="card">
        <UiIcon name="alert" :size="28" />
        <p class="t-h2">{{ (props.path ?? '').split('/').pop() }}</p>
        <p class="t-body sub">{{ officeFailed }}</p>
        <p class="t-aux sub">文件可能损坏或不是标准 OOXML。用系统 Office 打开看看。</p>
        <button class="btn" type="button" @click="copyPath">{{ copied ? '路径已复制' : '复制完整路径' }}</button>
      </div>

      <!-- legacy 二进制 / PDF：明说不支持，别给假希望 -->
      <div v-else-if="isLegacy" class="card">
        <UiIcon name="file" :size="28" />
        <p class="t-h2">{{ (props.path ?? '').split('/').pop() }}</p>
        <p class="t-body sub">
          DeskMinis 只解 OOXML（.docx / .xlsx / .pptx）。这个是老版二进制或 PDF 格式，另一套编码，请用系统应用打开。
        </p>
        <button class="btn" type="button" @click="copyPath">{{ copied ? '路径已复制' : '复制完整路径' }}</button>
      </div>

      <div v-else-if="isImg" class="imgwrap"><img :src="`file://${chat.workspaceRoot}/${props.path}`" :alt="props.path ?? ''" /></div>
      <div v-else-if="data?.binary" class="hint t-body">二进制文件不可预览</div>

      <!-- 分栏对照：左源码右渲染（原图工具条里唯一高亮的那个态） -->
      <div v-else-if="mode === 'split' && canRender" class="split">
        <div class="half">
          <div class="halfhead t-aux">源码</div>
          <div class="code">
            <div class="gutter tnum"><span v-for="(l, i) in lines" :key="i">{{ i + 1 }}</span></div>
            <pre class="codebody">{{ data!.content }}</pre>
          </div>
        </div>
        <div class="half">
          <div class="halfhead t-aux">渲染</div>
          <div class="doc split-doc"><MarkdownView :nodes="nodes!" /></div>
        </div>
      </div>

      <div v-else-if="nodes" class="doc"><MarkdownView :nodes="nodes" /></div>
      <!-- 源码态：带行号槽（原图编辑器左侧有行号，没有行号的代码没坐标） -->
      <div v-else-if="data" class="code lone">
        <div class="gutter tnum"><span v-for="(l, i) in lines" :key="i">{{ i + 1 }}</span></div>
        <pre class="codebody">{{ data.content }}</pre>
      </div>
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
.seg .ic { display: inline-flex; align-items: center; padding: 2px 7px; }
.seg .ic :deep(svg) { color: inherit; }
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
/* 代码态：行号槽 + 正文，两列网格 */
.code {
  display: grid; grid-template-columns: auto 1fr;
  background: var(--c-bg); font-family: var(--f-mono);
  font-size: var(--t-code-size); line-height: var(--t-code-lh);
}
.code.lone {
  margin: var(--sp-7) auto; width: min(900px, 100% - var(--sp-7) * 2);
  border-radius: var(--r-s); box-shadow: var(--sh-paper); overflow: hidden;
}
.gutter {
  display: flex; flex-direction: column; text-align: right;
  padding: var(--sp-5) var(--sp-3); user-select: none;
  color: var(--c-ink-4); background: var(--c-bg-1); border-right: 1px solid var(--c-line);
}
.codebody {
  margin: 0; padding: var(--sp-5) var(--sp-5);
  color: var(--c-ink-2); white-space: pre; overflow-x: auto;
}

/* 分栏对照 */
.split { display: grid; grid-template-columns: 1fr 1fr; height: 100%; min-height: 0; }
.half { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: auto; background: var(--c-bg); }
.half + .half { border-left: 1px solid var(--c-line); }
.halfhead {
  position: sticky; top: 0; z-index: 1; flex: 0 0 auto;
  padding: var(--sp-3) var(--sp-5); color: var(--c-ink-3);
  background: var(--c-bg-1); border-bottom: 1px solid var(--c-line);
}
.split .code { min-height: 0; }
.split-doc {
  width: auto; margin: 0; padding: var(--sp-6) var(--sp-6) var(--sp-8);
  box-shadow: none; border-radius: 0;
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
