<script setup lang="ts">
/** T 波：应用外壳（设计稿 §3）。三区栅格 TopBar / [NavRail | Stage | AsideDock]。
 *
 *  与旧 App.vue 的实质差别：
 *  ① Stage 内容**定宽居中**（--w-stage 760），不再撑满列宽——长行难读是旧 UI 通病；
 *  ② Aside（右栏工作台）**默认展开**（wsOpen 初值 true），标题栏「工作台」钮与托盘「切换右栏」开合它。
 *     设计稿写的是默认收起；T6b 之后工作区绑定入口只在右栏「文件」tab 里，收起就把它藏进了二级界面，
 *     所以 0.3.0 保持展开，「默认收起、有产出物时自动展开」排在 W8a（W2b-11a 订正：这里原写「默认收起」，与实现相反）；
 *  ③ 欢迎态与会话态是 Stage 内两个**并列视图**，不再靠 v-if 在同一棵组件树上叠条件。 */
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import { useChat } from '../stores/chat';
import { subscribeTrayMenu } from '../lib/tray/menu';
import TopBar from './TopBar.vue';
import { toggleTheme } from '../lib/theme';
import NavRail from './NavRail.vue';
import StageWelcome from './StageWelcome.vue';
import StageChat from './StageChat.vue';
import PreviewPane from './PreviewPane.vue';
import ChangeReview from './ChangeReview.vue';
import TabBar from './TabBar.vue';
import WorkspacePanel from './WorkspacePanel.vue';
import StageSettings from './StageSettings.vue';
import StageAssistants from './StageAssistants.vue';
import StageCron from './StageCron.vue';
import StageDevices from './StageDevices.vue';
import StageSearch from './StageSearch.vue';
import StageMarket from './StageMarket.vue';
import TerminalPane from './TerminalPane.vue';

const chat = useChat();
const railOpen = ref(true);
const wsOpen = ref(true);
/** 右栏开合。标题栏的「工作台」钮与托盘菜单的「切换右栏」走这同一个函数（W2b-11a）。 */
function toggleAside(): void { wsOpen.value = !wsOpen.value; }
/** 终端抽屉。默认收起——它是「需要时拉出来」的东西，常驻会白占 260px 高度。
 *  组件只在打开时挂载（v-if 不是 v-show）：xterm 是重实例，不用时不该活着。 */
const termOpen = ref(false);
/** 当前预览的产出物（相对工作区路径）。有值时舞台分栏：对话让到左边一条，预览占主位——
 *  这是 Cowork 形态的核心（用户 2026-08-21 参考图）：产出物是主角，对话是辅助。 */
const previewPath = ref<string | null>(null);
/** F08：正在审阅的那次改动（检查点 id）。有值时主舞台的分栏里挂审阅面板（前后对比、恢复、另存），不挂文件预览。 */
const reviewId = ref<string | null>(null);
/** 打开过的产出物：每个一个标签，来回对照不用重新找（agent 一轮常产出好几个文件）。 */
const openDocs = ref<string[]>([]);
function openDoc(p: string): void {
  if (!openDocs.value.includes(p)) openDocs.value.push(p);
  previewPath.value = p;
  reviewId.value = null;
}
function closeDoc(p: string): void {
  const i = openDocs.value.indexOf(p);
  if (i >= 0) openDocs.value.splice(i, 1);
  if (previewPath.value === p) previewPath.value = openDocs.value[i] ?? openDocs.value[i - 1] ?? null;
}
/** 点标签栏里的一个标签（null = 会话标签，回到纯对话）。审阅面板开着时它占着分栏、排在预览前面：
 *  只换预览路径的话标签高亮变了、舞台上还是审阅面板，点哪个标签都不动。点标签就是要看那个标签，一并关掉审阅面板。 */
function pickTab(p: string | null): void {
  previewPath.value = p;
  reviewId.value = null;
}
/** 标签栏把哪一个标成当前。审阅面板开着时舞台上既不是哪个文档也不是纯对话：一个都不标（undefined 对不上任何标签）。 */
const activeTab = computed(() => (reviewId.value ? undefined : previewPath.value));
/** 主视图：chat（欢迎/会话由 activeId 决定）| cron | assistants | settings | devices */
const view = ref<'chat' | 'search' | 'cron' | 'assistants' | 'market' | 'settings' | 'devices'>('chat');

/** 会话态 = 选中了会话且它已有消息；否则欢迎态。 */
const inChat = computed(() => !!chat.activeId && chat.messages.length > 0);

onMounted(() => { void chat.init(); });

// W2b-11a：托盘菜单的「打开设置」「切换右栏」。主进程一直在 webContents.send、preload 也暴露了订阅接口，
// 渲染端却从没订阅，两项点了没反应（死通道）。退订挂在组件作用域上：卸载时（开发态热重载会重建组件）两条一起摘，
// 不摘的话监听越积越多、点一次切好几次。用 onScopeDispose 而不是 onBeforeUnmount：卸载时同样会调，还不依赖组件实例。
onScopeDispose(subscribeTrayMenu((window as any).deskminis, {
  openSettings: () => { view.value = 'settings'; },
  toggleRight: toggleAside,
}));

// 会话切换：上一会话的预览路径在新会话里没有意义
watch(() => chat.activeId, () => { previewPath.value = null; openDocs.value = []; reviewId.value = null; });
// 产物卡/其它入口写入的待预览路径（store 既有字段）——消费即清空
watch(() => chat.pendingFilePreview, (p) => {
  if (!p) return;
  chat.pendingFilePreview = null;
  openDoc(p);
});

/** 本机分栏偏好。默认不写内联宽度，保留主题原有的逐像素布局。 */
const split = ref<HTMLElement | null>(null);
const paneOpen = computed(() => !!previewPath.value || !!reviewId.value);
const WIDTH_KEY = 'deskminis.chatColWidth';
function readColumnWidth(): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw === null || raw.trim() === '') return null;
    const width = Number(raw);
    return Number.isFinite(width) ? width : null;
  } catch { return null; }
}
const userWidth = ref<number | null>(readColumnWidth());
const splitWidth = ref(0);
const defaultWidth = ref(372);
const maxColumnWidth = computed(() => Math.max(320, splitWidth.value - 360));
const clampColumnWidth = (width: number): number => Math.max(320, Math.min(width, maxColumnWidth.value));
const columnWidth = computed(() => userWidth.value === null ? defaultWidth.value : clampColumnWidth(userWidth.value));
const columnStyle = computed(() => !paneOpen.value || userWidth.value === null ? undefined : { flex: '0 0 ' + columnWidth.value + 'px' });
const handleStyle = computed(() => userWidth.value === null ? undefined : { left: columnWidth.value - 4 + 'px' });
const paneDragging = ref(false);
let columnObserver: ResizeObserver | undefined;
watch(split, el => {
  columnObserver?.disconnect();
  if (!el) return;
  const measure = (): void => {
    splitWidth.value = el.getBoundingClientRect().width;
    const width = parseFloat(getComputedStyle(el).getPropertyValue('--w-chatcol'));
    if (Number.isFinite(width)) defaultWidth.value = width;
  };
  measure();
  columnObserver = new ResizeObserver(measure);
  columnObserver.observe(el);
}, { flush: 'post' });
function saveColumnWidth(): void {
  try {
    if (userWidth.value === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(userWidth.value));
  } catch { /* 本机偏好存不了不挡当前窗口使用。 */ }
}
let columnDrag: { id: number; x: number; width: number; before: number | null; handle: HTMLElement } | null = null;
/** 鼠标不继承键盘焦点可见态；Tab 入口与方向键保持原样。 */
function clearMouseFocus(event: MouseEvent): void { (event.currentTarget as HTMLElement).blur(); }
function startColumnDrag(event: PointerEvent): void {
  if (event.button !== 0 || columnDrag) return;
  const handle = event.currentTarget as HTMLElement;
  columnDrag = { id: event.pointerId, x: event.clientX, width: columnWidth.value, before: userWidth.value, handle };
  handle.setPointerCapture(event.pointerId);
  window.addEventListener('keydown', escapeColumnDrag);
}
function moveColumnDrag(event: PointerEvent): void {
  if (!columnDrag || event.pointerId !== columnDrag.id) return;
  const delta = event.clientX - columnDrag.x;
  if (!paneDragging.value && Math.abs(delta) <= 4) return;
  paneDragging.value = true;
  userWidth.value = clampColumnWidth(columnDrag.width + delta);
}
function finishColumnDrag(commit: boolean): void {
  if (!columnDrag) return;
  const drag = columnDrag;
  columnDrag = null;
  window.removeEventListener('keydown', escapeColumnDrag);
  if (!commit) userWidth.value = drag.before;
  else if (paneDragging.value) saveColumnWidth();
  paneDragging.value = false;
  if (drag.handle.hasPointerCapture(drag.id)) drag.handle.releasePointerCapture(drag.id);
}
function endColumnDrag(event: PointerEvent): void {
  if (columnDrag?.id === event.pointerId) finishColumnDrag(true);
}
function resetColumnWidth(): void {
  finishColumnDrag(false);
  userWidth.value = null;
  saveColumnWidth();
}
function columnKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && columnDrag) { event.preventDefault(); finishColumnDrag(false); return; }
  const width = event.key === 'ArrowLeft' ? columnWidth.value - 16 : event.key === 'ArrowRight' ? columnWidth.value + 16
    : event.key === 'Home' ? 320 : event.key === 'End' ? maxColumnWidth.value : null;
  if (width === null) return;
  event.preventDefault();
  finishColumnDrag(false);
  userWidth.value = clampColumnWidth(width);
  saveColumnWidth();
}
function escapeColumnDrag(event: KeyboardEvent): void {
  if (event.key === 'Escape' && columnDrag) { event.preventDefault(); finishColumnDrag(false); }
}
watch(paneOpen, open => { if (!open) finishColumnDrag(false); });
onScopeDispose(() => {
  finishColumnDrag(false);
  columnObserver?.disconnect();
});

</script>

<template>
  <div class="shell">
    <TopBar
      :rail-open="railOpen" :aside-open="wsOpen" :term-open="termOpen"
      @toggle-rail="railOpen = !railOpen"
      @toggle-aside="toggleAside"
      @toggle-term="termOpen = !termOpen"
      @toggle-theme="toggleTheme"
    />
    <div class="body">
      <NavRail v-show="railOpen" :view="view" :compact="!!previewPath" @view="v => (view = v)" />

      <main class="stage">
        <template v-if="view === 'chat'">
          <template v-if="inChat">
            <TabBar
              v-if="openDocs.length" :open="openDocs" :active="activeTab"
              @pick="pickTab" @close="closeDoc"
            />
            <div ref="split" class="split" :class="{ withPreview: paneOpen }" :data-pane-dragging="paneDragging ? '' : undefined">
              <StageChat class="chatcol" :narrow="!!previewPath || !!reviewId" :style="columnStyle" />
              <div v-if="paneOpen" class="pane-handle" :style="handleStyle" role="separator" tabindex="0"
                aria-orientation="vertical" aria-label="调整对话列宽度"
                :aria-valuenow="columnWidth" :aria-valuemin="320" :aria-valuemax="maxColumnWidth"
                @mousedown.prevent="clearMouseFocus" @pointerdown="startColumnDrag" @pointermove="moveColumnDrag" @pointerup="endColumnDrag"
                @pointercancel="finishColumnDrag(false)" @lostpointercapture="finishColumnDrag(false)"
                @keydown="columnKey" @dblclick="resetColumnWidth"
              ></div>
              <ChangeReview v-if="reviewId" :id="reviewId" @close="reviewId = null" @open="openDoc" />
              <PreviewPane v-else-if="previewPath" :path="previewPath" @close="closeDoc(previewPath)" />
            </div>
          </template>
          <StageWelcome v-else @view="v => (view = v)" />
        </template>
        <StageSearch v-else-if="view === 'search'" @view="v => (view = v)" />
        <StageCron v-else-if="view === 'cron'" />
        <StageAssistants v-else-if="view === 'assistants'" />
        <StageMarket v-else-if="view === 'market'" />
        <StageDevices v-else-if="view === 'devices'" />
        <StageSettings v-else />
        <TerminalPane v-if="termOpen" @close="termOpen = false" />
      </main>

      <WorkspacePanel
        v-show="wsOpen && view === 'chat'"
        :selected="previewPath" :reviewing="reviewId"
        @open="openDoc" @review="id => (reviewId = id)"
      />
    </div>
  </div>
</template>

<style scoped>
.shell { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.body { flex: 1; min-height: 0; display: flex; }
.stage { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--c-bg); overflow: hidden; }
/* 舞台分栏：无预览时对话独占（内容自己定宽居中）；有预览时对话收成左边一条固定宽，
   预览吃掉剩余——产出物是主角 */
.split { position: relative; flex: 1; min-height: 0; display: flex; }
.split .chatcol { flex: 1; min-width: 0; }
.split.withPreview .chatcol { flex: 0 0 var(--w-chatcol); }
.pane-handle {
  position: absolute; z-index: 10; top: 0; bottom: 0;
  left: calc(var(--w-chatcol) - 4px); width: 8px;
  cursor: col-resize; touch-action: none;
}
.pane-handle::after { content: ''; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; }
.pane-handle:hover::after, .pane-handle:focus-visible::after,
.split[data-pane-dragging] .pane-handle::after { background: var(--c-brand); }
.split[data-pane-dragging] { user-select: none; }
.split[data-pane-dragging] > :last-child { pointer-events: none; }
</style>
