<script setup lang="ts">
/** T 波：输入卡。两态同一组件——hero（欢迎页，24px 圆角、托盘+白卡双层）
 *  与 chat（会话页，20px 圆角、单层）。
 *
 *  形态取自 AionUi 实测（调研 §5）：**静止零阴影**，聚焦才上一层大扩散淡晕；
 *  卡与底的分离靠 1px 边 + 白底，不靠投影——常驻投影是「浮起」语言，静止态用它显廉价。
 *
 *  逻辑全部复用既有纯模块：rowsFor（自适应行数）、histStep（↑↓ 输入历史）、
 *  atToken/atMatch/applyAt/collectFiles（@ 文件引用）。本组件只管形与接线。 */
import { computed, nextTick, ref, watch } from 'vue';
import { useChat } from '../stores/chat';
import { rpc } from '../rpc';
import { rowsFor } from '../lib/composer/autogrow';
import { histStep } from '../lib/composer/history';
import { atToken, atMatch, applyAt, collectFiles } from '../lib/composer/at-files';
import { downsampleImageFile } from '../lib/attach/downsample';
import UiIcon from './UiIcon.vue';

const props = withDefaults(defineProps<{ variant?: 'hero' | 'chat' }>(), { variant: 'chat' });
const chat = useChat();

const text = ref('');
const field = ref<HTMLTextAreaElement | null>(null);
/** V6 待发附件（声明必须在 canSend 之前——computed 里引用了它）。
 *  path 是会话相对路径（后端据此落 mediaRef part），dataUrl 只用于本地缩略图。 */
const atts = ref<{ path: string; dataUrl: string }[]>([]);
// 只有附件没有文字也能发（「看看这张图」的常见开法）
const canSend = computed(() => (text.value.trim().length > 0 || atts.value.length > 0) && !chat.running);

/** 底行胶囊：当前模型与权限档。原图这两枚常驻——用户随时看得见「谁在跑、能做多狠」。 */
const modelLabel = computed(() => {
  const p = chat.providers.find(x => x.id === chat.defaultProviderId) ?? chat.providers[0];
  return p?.modelId || p?.name || '未配置模型';
});
const PERM_TEXT: Record<string, string> = { ask: '每次确认', session: '本会话沿用', full: '完全访问' };
const permLabel = computed(() => PERM_TEXT[chat.permTier] ?? '每次确认');

const placeholder = computed(() => {
  const a = chat.assistants.find(x => x.id === chat.welcomeAssistantId);
  return a ? `让 ${a.name} 做点什么…` : '让 DeskMinis 做点什么…';
});

// ---- 斜杠技能菜单：整行首 token 语义 ----
const slashQuery = computed(() => (/^\/(\S*)$/.exec(text.value)?.[1] ?? null));
const slashItems = computed(() => {
  const q = slashQuery.value;
  if (q === null) return [];
  const n = q.toLowerCase();
  return (n === '' ? chat.skills : chat.skills.filter(s =>
    s.name.toLowerCase().includes(n) || s.id.toLowerCase().includes(n))).slice(0, 8);
});
const slashOpen = computed(() => slashItems.value.length > 0);

// ---- @ 文件菜单：光标处 token 语义（与斜杠互斥，斜杠优先）----
const atQuery = ref<string | null>(null);
const atFiles = ref<string[] | null>(null);
const atTruncated = ref(false);
let atLoading = false;
const atItems = computed(() => {
  if (slashOpen.value || atQuery.value === null || !atFiles.value) return [];
  return atMatch(atFiles.value, atQuery.value);
});
const atOpen = computed(() => atItems.value.length > 0);
const menuIndex = ref(0);
watch([slashItems, atItems], () => { menuIndex.value = 0; });
watch(() => chat.activeId, () => { atFiles.value = null; atTruncated.value = false; atQuery.value = null; });

async function loadAtFiles(): Promise<void> {
  atLoading = true;
  const sid = chat.activeId;
  try {
    const r = await collectFiles((dir) => rpc.call('files.list', { sessionId: sid, dir }));
    if (sid === chat.activeId) { atFiles.value = r.paths; atTruncated.value = r.truncated; }
  } catch { /* 纯输入辅助：拉不到就不弹，不打扰输入 */ }
  finally { atLoading = false; }
}
/** 光标或内容一动就重判 token：读 DOM 现值——@input 与 v-model 同事件序不保证。 */
function syncAt(): void {
  const el = field.value;
  const t = el ? el.value : text.value;
  const caret = el?.selectionStart ?? t.length;
  atQuery.value = atToken(t.slice(0, caret));
  if (atQuery.value !== null && atFiles.value === null && !atLoading && chat.activeId) void loadAtFiles();
}

// ---- 输入历史 ----
const histCursor = ref(-1);
const userTexts = computed<string[]>(() => chat.messages
  .filter(m => m.role === 'user')
  .map(m => {
    const p = Array.isArray(m.parts) ? m.parts.find((x: { type?: string }) => x?.type === 'text') : undefined;
    return typeof p?.value === 'string' ? p.value : '';
  })
  .filter(t => t !== ''));
watch(() => chat.activeId, () => { histCursor.value = -1; });

function pickSlash(name: string): void {
  text.value = `/${name} `;
  void nextTick(() => field.value?.focus());
}
function pickAt(p: string): void {
  const el = field.value;
  const caret = el?.selectionStart ?? text.value.length;
  const r = applyAt(text.value, caret, p);
  atQuery.value = null;
  if (!r) return;
  text.value = r.text;
  void nextTick(() => { el?.focus(); el?.setSelectionRange(r.caret, r.caret); });
}

function onNav(delta: -1 | 1, e: KeyboardEvent): void {
  // 优先级：斜杠菜单 > @ 菜单 > 输入历史 > 光标本职
  if (slashOpen.value) { e.preventDefault(); menuIndex.value = (menuIndex.value + delta + slashItems.value.length) % slashItems.value.length; return; }
  if (atOpen.value) { e.preventDefault(); menuIndex.value = (menuIndex.value + delta + atItems.value.length) % atItems.value.length; return; }
  const r = histStep(userTexts.value, text.value, histCursor.value, delta);
  if (r) { e.preventDefault(); text.value = r.text; histCursor.value = r.cursor; }
}
function onEnter(): void {
  if (slashOpen.value) { pickSlash(slashItems.value[menuIndex.value].name); return; }
  if (atOpen.value) { pickAt(atItems.value[menuIndex.value]); return; }
  void send();
}
function onTab(e: KeyboardEvent): void {
  if (slashOpen.value) { e.preventDefault(); pickSlash(slashItems.value[menuIndex.value].name); return; }
  if (atOpen.value) { e.preventDefault(); pickAt(atItems.value[menuIndex.value]); }
}
function closeMenus(): void { atQuery.value = null; }

// ---- V6 附件：粘贴 / 拖拽 / ＋ 钮三条入口 ----
const fileEl = ref<HTMLInputElement | null>(null);
const attErr = ref('');

const bridge = (): { saveAttachment?: (s: string, d: string) => Promise<string> } | undefined =>
  (window as unknown as { deskminis?: { saveAttachment?: (s: string, d: string) => Promise<string> } }).deskminis;

function pickImages(list: FileList | null): File[] {
  return Array.from(list ?? []).filter(f => f.type.startsWith('image/'));
}
async function saveImages(files: File[]): Promise<void> {
  if (!files.length) return;
  attErr.value = '';
  if (!chat.activeId) await chat.newSession();   // 附件挂在会话目录下：先确保有会话
  const id = chat.activeId;
  const b = bridge();
  if (!id || typeof b?.saveAttachment !== 'function') { attErr.value = '这个环境不支持附件'; return; }
  for (const f of files) {
    try {
      // 入库前降采样：超 1568px 长边的先缩再传（gif / 边界内原字节直传，见 lib/attach/downsample）
      const dataUrl = await downsampleImageFile(f);
      atts.value.push({ path: await b.saveAttachment(id, dataUrl), dataUrl });
    } catch (e) {
      attErr.value = e instanceof Error ? e.message : String(e);
    }
  }
}
function onPaste(e: ClipboardEvent): void {
  const files = pickImages(e.clipboardData?.files ?? null);
  if (!files.length) return;      // 没有图片：让默认的文本粘贴照常发生
  e.preventDefault();
  void saveImages(files);
}
function onDrop(e: DragEvent): void {
  const files = pickImages(e.dataTransfer?.files ?? null);
  if (!files.length) return;
  e.preventDefault();
  void saveImages(files);
}
function onPick(e: Event): void {
  const el = e.target as HTMLInputElement;
  void saveImages(pickImages(el.files));
  el.value = '';                  // 清空以允许连续选同一个文件
}
function dropAtt(i: number): void { atts.value.splice(i, 1); }

async function send(): Promise<void> {
  const t = text.value.trim();
  const paths = atts.value.map(a => a.path);
  // 只有附件没有文字也算一条消息（「看看这张图」的常见开法）
  if ((!t && !paths.length) || chat.running) return;
  if (!chat.activeId) {
    if (chat.welcomeAssistantId) await chat.newSessionWithAssistant(chat.welcomeAssistantId);
    else await chat.newSession();
  }
  text.value = '';
  histCursor.value = -1;
  atQuery.value = null;
  atts.value = [];
  await chat.send(t, paths.length ? paths : undefined);
}

/** V9 引用：追加不覆盖——用户已敲的草稿排在引用块前面。 */
function quote(block: string): void {
  text.value = text.value.trim() ? `${text.value.replace(/\s+$/, '')}\n\n${block}` : block;
  void nextTick(() => field.value?.focus());
}

defineExpose({
  focus: () => field.value?.focus(),
  fill: (t: string) => { text.value = t; void nextTick(() => field.value?.focus()); },
  quote,
});
</script>

<template>
  <div class="wrap" :class="props.variant">
    <div class="card">
      <!-- 菜单置于卡内顶部、向上弹：.ctools 裁浮层的老坑不再有（卡本身不设 overflow） -->
      <div v-if="slashOpen" class="menu">
        <button
          v-for="(s, i) in slashItems" :key="s.id" type="button"
          class="mitem" :class="{ on: i === menuIndex }"
          @mousedown.prevent="pickSlash(s.name)" @mouseenter="menuIndex = i"
        >
          <UiIcon name="book" :size="15" />
          <span class="mname">/{{ s.name }}</span>
          <span class="mdesc">{{ s.description }}</span>
        </button>
      </div>
      <div v-else-if="atOpen" class="menu">
        <button
          v-for="(p, i) in atItems" :key="p" type="button"
          class="mitem" :class="{ on: i === menuIndex }"
          @mousedown.prevent="pickAt(p)" @mouseenter="menuIndex = i"
        >
          <UiIcon name="file" :size="15" />
          <span class="mpath">{{ p }}</span>
        </button>
        <div v-if="atTruncated" class="mtail">工作区文件过多，仅收录前 500 项</div>
      </div>

      <div v-if="atts.length" class="atts">
        <span v-for="(a, i) in atts" :key="a.path" class="att">
          <img :src="a.dataUrl" alt="" />
          <button type="button" class="ax" title="去掉这张" @click="dropAtt(i)"><UiIcon name="x" :size="11" /></button>
        </span>
      </div>
      <p v-if="attErr" class="atterr t-aux">{{ attErr }}</p>

      <textarea
        ref="field" v-model="text" class="field" :rows="rowsFor(text)" :placeholder="placeholder"
        @paste="onPaste" @drop="onDrop" @dragover.prevent
        @keydown.enter.exact.prevent="onEnter"
        @keydown.up="onNav(-1, $event)"
        @keydown.down="onNav(1, $event)"
        @keydown.tab="onTab"
        @keydown.esc="closeMenus"
        @input="syncAt" @click="syncAt" @keyup="syncAt"
      ></textarea>

      <div class="tools">
        <button class="tb" type="button" title="添加图片（也可直接粘贴或拖进来）" @click="fileEl?.click()">
          <UiIcon name="plus" :size="16" />
        </button>
        <input ref="fileEl" class="hidden" type="file" accept="image/*" multiple @change="onPick" />
        <button class="tb" type="button" title="引用工作区文件：在输入框里打 @" @click="() => { text += (text && !text.endsWith(' ') ? ' @' : '@'); field?.focus(); syncAt(); }">
          <UiIcon name="at" :size="16" />
        </button>
        <span class="grow"></span>
        <!-- 原图底行右侧是 模型 + 权限 两枚胶囊，再接圆形发送键 -->
        <span class="cap" :title="modelLabel"><UiIcon name="robot" :size="13" /><span>{{ modelLabel }}</span></span>
        <span class="cap" :title="`权限档：${permLabel}`"><UiIcon name="shield" :size="13" /><span>{{ permLabel }}</span></span>
        <button v-if="!chat.running" class="go" type="button" :disabled="!canSend" title="发送" @click="send">
          <UiIcon name="send" :size="17" />
        </button>
        <button v-else class="go stop" type="button" title="停止" @click="chat.cancel()">
          <UiIcon name="stop" :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* hero 态：灰托盘裹白卡（AionUi 首页双层结构）——托盘让输入卡从大片留白里"坐实" */
.wrap.hero {
  width: 100%; padding: var(--sp-2);
  border-radius: var(--r-hero); background: var(--c-bg-2);
}
.wrap.chat { width: 100%; }

.card {
  position: relative;
  display: flex; flex-direction: column; gap: var(--sp-3);
  padding: var(--sp-5);
  background: var(--c-bg);
  border: 1px solid var(--c-line);
  border-radius: var(--r-input);
  /* 静止零阴影——聚焦才出晕（见下） */
  box-shadow: none;
  transition: border-color .18s ease, box-shadow .18s ease;
}
.wrap.hero .card { border-radius: var(--r-hero); }
.card:focus-within { border-color: var(--c-brand-line); box-shadow: var(--sh-focus); }

.field {
  width: 100%; resize: none; border: none; outline: none; background: none;
  padding: 0; color: var(--c-ink); font-family: inherit;
  font-size: var(--t-body-size); line-height: var(--t-body-lh);
  max-height: 200px; overflow-y: auto;
}
.field::placeholder { color: var(--c-ink-3); }

.tools { display: flex; align-items: center; gap: var(--sp-2); }
.grow { flex: 1; }
.tb {
  width: var(--h-ctl); height: var(--h-ctl); border-radius: var(--r-s);
  display: inline-flex; align-items: center; justify-content: center;
  background: none; color: var(--c-ink-3); cursor: pointer; padding: 0;
}
.tb:hover { background: var(--c-bg-2); color: var(--c-ink); }
/* 状态胶囊：只读展示，不是按钮——原图里它们也只是「看得见」，切换走各自的菜单 */
.cap {
  display: inline-flex; align-items: center; gap: var(--sp-2); flex: 0 0 auto;
  height: var(--h-mini); padding: 0 var(--sp-4); border-radius: var(--r-pill);
  background: var(--c-bg-2); color: var(--c-ink-2);
  font-size: var(--t-aux-size); max-width: 190px;
}
.cap :deep(svg) { color: var(--c-ink-3); flex: 0 0 auto; }
.cap > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.go {
  width: var(--h-round); height: var(--h-round); border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--c-brand); color: var(--c-brand-ink); cursor: pointer; padding: 0;
}
.go:disabled { background: var(--c-bg-3); color: var(--c-ink-4); cursor: default; }
.go.stop { background: var(--c-err); color: var(--c-err-ink); }

/* 菜单：卡内向上弹，宽度随卡 */
.menu {
  position: absolute; left: 0; right: 0; bottom: calc(100% + var(--sp-2)); z-index: 20;
  display: flex; flex-direction: column; gap: 1px; padding: var(--sp-2);
  max-height: 280px; overflow-y: auto;
  background: var(--c-bg); border: 1px solid var(--c-line);
  border-radius: var(--r-m); box-shadow: var(--sh-pop);
}
.mitem {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4); border-radius: var(--r-s);
  background: none; color: var(--c-ink); cursor: pointer; text-align: left;
  font-size: var(--t-item-size); font-family: inherit;
}
.mitem.on { background: var(--c-bg-2); }
.mitem :deep(svg) { color: var(--c-ink-3); flex: 0 0 auto; }
.mname { font-weight: var(--w-md); flex: 0 0 auto; }
.mdesc { color: var(--c-ink-3); font-size: var(--t-aux-size); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mpath { font-family: var(--f-mono); font-size: var(--t-aux-size); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mtail { padding: var(--sp-1) var(--sp-4); font-size: var(--t-aux-size); color: var(--c-ink-3); }

/* ---- V6 附件缩略条 ---- */
.atts { display: flex; gap: var(--sp-3); flex-wrap: wrap; padding: 0 var(--sp-2) var(--sp-3); }
.att { position: relative; width: 56px; height: 56px; flex: 0 0 auto; }
.att img { width: 100%; height: 100%; object-fit: cover; border-radius: var(--r-s); display: block; }
.ax {
  position: absolute; top: -5px; right: -5px; width: 18px; height: 18px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
  background: var(--c-ink); color: var(--c-bg);
}
.atterr { margin: 0 0 var(--sp-3); padding: 0 var(--sp-2); color: var(--c-err); }
.hidden { display: none; }
</style>
