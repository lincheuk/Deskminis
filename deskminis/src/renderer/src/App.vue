<script setup lang="ts">
/** 应用外壳。
 *
 *  MU2b：三栏 232 | 1fr | 360——对话伸展、右栏定宽可拖。
 *  MU5（布局 B，用户 2026-08-10 拍板）：**flex 关系反转**为
 *  图标轨 52（或展开 212）| 对话列 336 定宽可拖 | 工作台 1fr。
 *  变的不是数值，是哪一栏承担弹性：工作台要装网页与截图，越宽越有用，不该由用户手动挤；
 *  对话列反而有明确的舒适阅读区间，所以把定宽与拖拽给它。
 *
 *  可拖边界随之移到对话列右缘，区间 [280,520]、默宽 336，持久化键换名
 *  deskminis.rightW → deskminis.chatW —— 旧值 360 落在新区间内 clamp 拦不住，
 *  不换键就会被静默当成「用户设过的对话列宽」复原（计划决策 2-6）。
 *
 *  MU2b Task 5 遗留：设置独立模态（SettingsModal），右栏 gear 退场；托盘
 *  menu:open-settings/menu:toggle-right 死通道经 preload 两订阅接通；主题偏好持久化。 */
import { onMounted, onBeforeUnmount, ref, computed, provide, reactive } from 'vue';
import { useChat } from './stores/chat';
import { clampPaneWidth, nextWidth } from './lib/pane/drag';
import { loadTheme, saveTheme, type ThemeMode } from './lib/settings/theme';
import Icon from './components/Icon.vue';
import TitleBar from './components/TitleBar.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import FilesPanel from './components/FilesPanel.vue';
import ProgressPanel from './components/ProgressPanel.vue';
import ArtifactsPanel from './components/ArtifactsPanel.vue';
import SettingsModal from './components/SettingsModal.vue';
import DevicesModal from './components/DevicesModal.vue';

const chat = useChat();

/** 左区三态由两个开关组合：railOpen 决定左区在不在，sidebarExpanded 决定它是
 *  52px 图标轨还是 212px 完整列表。默认折叠为图标轨（计划决策 2-2「工作态默认纯图标」），
 *  展开时**挤压**对话列而非浮层覆盖——浮层会遮住正在读的内容。 */
const railOpen = ref(true);
const sidebarExpanded = ref(false);
const workbenchOpen = ref(true);
/** MU2b Task 5：settingsOpen 语义改为设置模态开关（原右栏 settings 分支退场） */
const settingsOpen = ref(false);
/** MU2b Task 7：配对管理面模态开关（左栏「设备」/ 设置模态「设备与同步」两入口） */
const devicesOpen = ref(false);
/** 工作台面板选择器。MU2b 是四值，MU5 增 browser/screen 两枚（本轮只出壳与空态，
 *  内容属后端里程碑 M8）。**四个内置面板的 v-show 绑定一字不动**——renderer-artifacts /
 *  renderer-files-panel / renderer-tasks-panel 三个文件锚在这些绑定上。 */
type WbPanel = 'progress' | 'artifacts' | 'files' | 'terminal' | 'browser' | 'screen';
const rightTab = ref<WbPanel>('progress');
/** 懒挂载 + v-show 保活（首次切到才创建组件，之后切换只隐藏不销毁）——仅四个内置面板需要。 */
const visited = reactive({ progress: true, artifacts: false, files: false, terminal: false });
function isLazy(t: WbPanel): t is 'progress' | 'artifacts' | 'files' | 'terminal' {
  return t === 'progress' || t === 'artifacts' || t === 'files' || t === 'terminal';
}

/** 标签**条**改数组渲染（可关闭、可多开）；标签**体**仍是上面那组 v-show 绑定。
 *  拆开的理由：多开的本体是文件标签，它们共用 FilesPanel 一个渲染器，只是预览路径不同。 */
interface WbTab { id: string; label: string; panel: WbPanel; closable: boolean; live?: boolean }
const BUILTIN_TABS: WbTab[] = [
  { id: 'progress', label: '进度', panel: 'progress', closable: false },
  { id: 'artifacts', label: '产物', panel: 'artifacts', closable: false },
  { id: 'files', label: '文件', panel: 'files', closable: false },
  { id: 'terminal', label: '终端', panel: 'terminal', closable: false },
  { id: 'browser', label: '浏览器', panel: 'browser', closable: true },
  { id: 'screen', label: '屏幕', panel: 'screen', closable: true, live: true },
];
const hiddenTabs = ref<string[]>([]);
const fileTabs = ref<WbTab[]>([]);
const activeTabId = ref<string>('progress');
const openTabs = computed<WbTab[]>(() => [
  ...BUILTIN_TABS.filter(t => !hiddenTabs.value.includes(t.id)),
  ...fileTabs.value,
]);

function showTab(tab: WbPanel): void {
  settingsOpen.value = false;
  rightTab.value = tab;
  if (isLazy(tab)) visited[tab] = true;
  activeTabId.value = tab;
}
function pickTab(t: WbTab): void {
  showTab(t.panel);
  activeTabId.value = t.id;
  // 文件标签复用 MU2b 既有 preview 通路：写 pendingFilePreview，FilesPanel watch 自行取用
  if (t.id.startsWith('file:')) chat.pendingFilePreview = t.id.slice(5);
}
/** 产物卡点击 → 在工作台开一个可关闭的文件标签（同一路径不重复开）。 */
function openFileTab(p: string): void {
  const id = `file:${p}`;
  if (!fileTabs.value.some(t => t.id === id)) {
    fileTabs.value.push({ id, label: p.split(/[\\/]/).pop() || p, panel: 'files', closable: true });
  }
  showTab('files');
  activeTabId.value = id;
}
function closeTab(id: string): void {
  if (id.startsWith('file:')) fileTabs.value = fileTabs.value.filter(t => t.id !== id);
  else if (!hiddenTabs.value.includes(id)) hiddenTabs.value.push(id);
  // 关掉的正是当前标签时，落到剩下的第一枚（关闭不该把工作台留成空白）
  if (activeTabId.value === id) {
    const first = openTabs.value[0];
    if (first) pickTab(first);
  }
}
/** 关闭是隐藏不是销毁：一键把收起来的内置标签放回来，免得关错了没路回。 */
function restoreTabs(): void { hiddenTabs.value = []; }

/** 对话列宽度：336 默认、280–520 分隔条拖拽（lib/pane/drag 纯逻辑），localStorage 持久化。
 *  分隔条在对话列**右**缘，故右拖增宽（drag.ts 的符号已随之取反）。 */
const chatW = ref(336);
function startCDrag(e: MouseEvent): void {
  const startX = e.clientX;
  const startW = chatW.value;
  const onMove = (ev: MouseEvent): void => { chatW.value = nextWidth(startX, startW, ev.clientX); };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    localStorage.setItem('deskminis.chatW', String(chatW.value));
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/** 图标轨上的会话项：标题首字作标识（AionUi 用 agent 图标，DeskMinis 无 agent 概念，
 *  退而用标题首字——比通用圆点可辨认，且零新增资源）。 */
const railSessions = computed(() => chat.sessions.slice(0, 8) as { id: string; title: string }[]);
function railLabel(s: { title: string }): string {
  return (s.title || '新').slice(0, 1);
}

// 明暗：system 跟随系统 / light 强制浅 / dark 强制深——落到 <html data-theme>；localStorage 持久化（Task 5 前为内存态，重启丢失）
const theme = ref<ThemeMode>(loadTheme());
function applyTheme(): void {
  const el = document.documentElement;
  if (theme.value === 'system') el.removeAttribute('data-theme');
  else el.dataset.theme = theme.value;
}
function setTheme(t: ThemeMode): void {
  theme.value = t;
  saveTheme(t);
  applyTheme();
}
function cycleTheme(): void {
  setTheme(theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system');
}

// 当前会话标题（无选中时留空）——首帧 activeId 为空、sessions 为空也不解引用 undefined
const activeTitle = computed(() => chat.sessions.find(s => s.id === chat.activeId)?.title ?? '');

// ModelPicker「管理模型…」与左栏「设置」入口经此开设置模态（无需逐层 emit）
provide('openSettings', () => { settingsOpen.value = true; });
// MU2b Task 7：左栏「设备」与设置模态「设备与同步」入口经此开配对管理面；开设备面时收起设置模态避免叠层
provide('openDevices', () => { settingsOpen.value = false; devicesOpen.value = true; });
// MU2b Task 3：产物卡点击 → 切工作台 tab（等价 tab 点击，供深层组件调用）。
// MU5 增量：带着待预览文件切到 files 时，额外开一个可关闭的文件标签——
// ArtifactsPanel / FilesPanel 一行不用改，多开能力从既有通路上长出来。
provide('switchRightTab', (tab: WbPanel) => {
  workbenchOpen.value = true;
  const p = chat.pendingFilePreview;
  if (tab === 'files' && typeof p === 'string' && p) openFileTab(p);
  else showTab(tab);
});

// Ctrl+, 开/关设置模态（设计 §1.1-2；不拦截输入区文本键入）
function onGlobalKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === ',') {
    e.preventDefault();
    settingsOpen.value = !settingsOpen.value;
  }
}

onMounted(() => {
  const saved = Number(localStorage.getItem('deskminis.chatW'));
  if (saved) chatW.value = clampPaneWidth(saved);
  applyTheme(); // 启动即应用 loadTheme 读回的偏好
  // MU2b Task 5：托盘菜单死通道接通（preload 白名单两订阅；main 侧零改动）
  const bridge = (window as { deskminis?: { onMenuOpenSettings?: (cb: () => void) => void; onMenuToggleRight?: (cb: () => void) => void } }).deskminis;
  bridge?.onMenuOpenSettings?.(() => { settingsOpen.value = true; });
  bridge?.onMenuToggleRight?.(() => { workbenchOpen.value = !workbenchOpen.value; });
  window.addEventListener('keydown', onGlobalKey);
  void chat.init();
});
onBeforeUnmount(() => { window.removeEventListener('keydown', onGlobalKey); });
</script>

<template>
  <div class="shell">
    <TitleBar
      :title="activeTitle"
      @toggle-sidebar="railOpen = !railOpen"
      @toggle-right="workbenchOpen = !workbenchOpen"
      @toggle-theme="cycleTheme"
    />
    <div class="win">
      <!-- 折叠态：52px 图标轨（AionUi 工作视图——进入工作态后会话列表压成纯图标） -->
      <nav v-show="railOpen && !sidebarExpanded" class="rail">
        <button class="rl" type="button" title="新建会话" @click="chat.newSession()"><Icon name="plus" :size="16" /></button>
        <button class="rl" type="button" title="展开会话列表" @click="sidebarExpanded = true">☰</button>
        <button
          v-for="s in railSessions" :key="s.id" type="button"
          class="rl ag" :class="{ on: s.id === chat.activeId }" :title="s.title || '新会话'"
          @click="chat.open(s.id)"
        >
          {{ railLabel(s) }}
          <span v-if="s.id === chat.activeId && chat.pendingPerms.length > 0" class="rl-badge">{{ chat.pendingPerms.length }}</span>
        </button>
        <span class="rsp"></span>
        <button class="rl" type="button" title="设置" @click="settingsOpen = true"><Icon name="gear" :size="16" /></button>
      </nav>
      <!-- 展开态：212px 完整列表（挤压对话列，非浮层） -->
      <aside v-show="railOpen && sidebarExpanded" class="pane-l">
        <SessionList @collapse="sidebarExpanded = false" />
      </aside>
      <main class="pane-c" :style="workbenchOpen ? { width: chatW + 'px', flex: '0 0 ' + chatW + 'px' } : {}">
        <ChatView />
        <div class="cdrag" @mousedown="startCDrag"></div>
      </main>
      <section v-show="workbenchOpen" class="pane-w">
        <div class="wtabs">
          <div
            v-for="t in openTabs" :key="t.id"
            class="wtab" :class="{ on: !settingsOpen && activeTabId === t.id, 'dot-warn': t.id === 'progress' && chat.pendingPerms.length > 0 }"
          >
            <button class="wtab-main" type="button" @click="pickTab(t)">
              <span v-if="t.live" class="lv"></span>{{ t.label }}
            </button>
            <button v-if="t.closable" class="wtab-x" type="button" :title="`关闭 ${t.label}`" @click="closeTab(t.id)">✕</button>
          </div>
          <button v-if="hiddenTabs.length" class="wtab-more" type="button" title="恢复收起的标签" @click="restoreTabs">＋{{ hiddenTabs.length }}</button>
        </div>
        <!-- 模式段控 + 动作行：目前只有浏览器标签用得上（来源 AionUi 预览区头部） -->
        <div v-show="rightTab === 'browser'" class="wctl">
          <div class="seg">
            <button type="button" class="on">页面</button>
            <button type="button">源码</button>
            <button type="button">分屏</button>
          </div>
          <span class="wurl">about:blank</span>
          <div class="wact">
            <button type="button">快照</button>
            <button type="button">历史</button>
            <button type="button">系统打开</button>
            <button type="button">下载</button>
          </div>
        </div>
        <div v-show="rightTab === 'progress'" class="rfill"><ProgressPanel v-if="visited.progress" /></div>
        <div v-show="rightTab === 'artifacts'" class="rfill"><ArtifactsPanel v-if="visited.artifacts" /></div>
        <div v-show="rightTab === 'files'" class="rfill"><FilesPanel v-if="visited.files" /></div>
        <div v-show="rightTab === 'terminal'" class="rfill"><TerminalPanel v-if="visited.terminal" /></div>
        <!-- 浏览器 / 屏幕：本轮只出壳与空态，内容属后端里程碑（Playwright/CDP 与 computer use）。
             空态文案说清「为什么现在是空的、要什么才不空」，不做「敬请期待」这类无信息量占位。 -->
        <div v-show="rightTab === 'browser'" class="rfill wempty">
          <p class="we-t">浏览器视图尚未启用</p>
          <p class="we-d">启用后这里会实时显示 agent 正在浏览的页面、点了哪里、填了什么。<br />浏览器能力属独立里程碑，当前版本未包含。</p>
        </div>
        <div v-show="rightTab === 'screen'" class="rfill wempty">
          <p class="we-t">屏幕视图尚未启用</p>
          <p class="we-d">启用后这里会显示 agent 操作桌面时的实时画面与操作轨迹。<br />computer use 能力属独立里程碑，当前版本未包含。</p>
        </div>
      </section>
    </div>
    <SettingsModal v-if="settingsOpen" :theme="theme" @set-theme="setTheme" @close="settingsOpen = false" />
    <DevicesModal v-if="devicesOpen" @close="devicesOpen = false" />
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100vh; background: var(--bg); }
.win { flex: 1; display: flex; min-height: 0; overflow: hidden; }

/* 图标轨（折叠态）——来源 AionUi 工作视图：进入工作态后会话列表压成纯图标 */
.rail {
  width: 52px; flex: 0 0 52px; background: var(--bg-secondary);
  border-right: .5px solid var(--separator);
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  padding: 9px 0; overflow: hidden;
}
.rl {
  position: relative; flex: 0 0 auto; width: 34px; height: 34px;
  border-radius: var(--r-md); border: 1px solid transparent; background: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600; color: var(--label-tertiary); cursor: pointer;
}
.rl:hover { background: var(--fill-quaternary); color: var(--label); }
/* MU5 §5 红线 6：新增交互元素一律原生 button + :focus-visible 环，不再新增 div @click */
.rl:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.rl :deep(svg) { stroke: var(--label-secondary); }
.rl.ag { background: var(--surface-1); border-color: var(--separator); color: var(--label-secondary); font-size: 12px; }
.rl.on { border-color: var(--action); color: var(--action); }
/* 激活项左侧 2px 竖条（AionUi 的激活标识，比整块反白克制） */
.rl.on::before {
  content: ''; position: absolute; left: -9px; top: 8px; bottom: 8px;
  width: 2px; border-radius: 2px; background: var(--action);
}
/* 待批准计数徽标：原 .dot-warn 只挂在「进度」tab 上，折叠态根本看不见，故扩到图标轨 */
.rl-badge {
  position: absolute; top: -2px; right: -3px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: var(--r-pill); border: 1.5px solid var(--bg-secondary);
  background: var(--state-warn); color: var(--on-action);
  font-size: 9px; font-weight: 700; line-height: 11px; text-align: center;
}
.rsp { flex: 1; }

.pane-l {
  width: 212px; flex: 0 0 212px; background: var(--bg); border-right: .5px solid var(--separator);
  display: flex; flex-direction: column; overflow: hidden;
}
/* 对话列：MU5 反转后由它承担定宽与拖拽（工作台拿走弹性）。
   flex 写 1 1 auto 是为工作台收起时能自然铺满；工作台展开时由内联 style 覆写成 0 0 chatW。 */
.pane-c {
  position: relative;
  width: 336px; flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; background: var(--bg);
}
/* 工作台：承担弹性——它装网页与截图，越宽越有用 */
.pane-w {
  flex: 1; min-width: 0; border-left: .5px solid var(--separator); background: var(--bg);
  display: flex; flex-direction: column; overflow: hidden;
}
/* 6px 拖拽热区：跨骑在对话列右缘（border 上），绝对定位不占布局 */
.cdrag { position: absolute; right: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
/* 工作台标签条：数组渲染、可关闭、可多开（来源 AionUi 预览区的多标签形态）。
   与 MU2b 的等分四枚不同——标签按内容宽度排，才容得下多开的文件名。 */
.wtabs {
  display: flex; align-items: center; gap: 3px; padding: 7px 10px 0;
  border-bottom: .5px solid var(--separator); overflow-x: auto;
}
.wtab {
  position: relative; flex: 0 0 auto; display: flex; align-items: center;
  border-radius: var(--r-control) var(--r-control) 0 0; border: 1px solid transparent; border-bottom: none;
}
.wtab-main {
  display: flex; align-items: center; gap: 6px; padding: 5px 4px 5px 10px;
  border: none; background: none; cursor: pointer;
  font-size: var(--fs-ui); font-weight: 500; color: var(--label-tertiary); white-space: nowrap;
}
.wtab-x {
  border: none; background: none; cursor: pointer; padding: 5px 8px 5px 2px;
  font-size: 11px; line-height: 1; color: var(--label-tertiary);
}
.wtab-main:focus-visible, .wtab-x:focus-visible, .wtab-more:focus-visible {
  outline: 2px solid var(--ring); outline-offset: -2px;
}
.wtab:hover { background: var(--fill-quaternary); }
.wtab-x:hover { color: var(--label); }
.wtab.on { background: var(--surface-1); border-color: var(--separator); }
.wtab.on .wtab-main { color: var(--label); font-weight: 600; }
/* 实时标签绿点（屏幕/浏览器这类会持续变化的视图） */
.lv { width: 6px; height: 6px; border-radius: 50%; background: var(--state-ok); flex: 0 0 auto; }
.wtab-more {
  flex: 0 0 auto; margin-left: 2px; padding: 4px 8px; border: .5px solid var(--separator);
  border-radius: var(--r-control); background: none; cursor: pointer;
  font-size: var(--fs-micro); color: var(--label-secondary);
}
/* 进度标签等待批准橙点（审计 H4：pendingPerms>0 显著化） */
.wtab.dot-warn::after {
  content: ''; position: absolute; top: 2px; right: 4px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--state-warn);
}

/* 模式段控 + 地址 + 右对齐动作行（来源 AionUi 预览区头部） */
.wctl {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border-bottom: .5px solid var(--separator); background: var(--surface-1); flex: 0 0 auto;
}
.seg { display: flex; border: .5px solid var(--separator); border-radius: var(--r-control); overflow: hidden; }
.seg button {
  border: none; background: none; cursor: pointer;
  padding: 3px 10px; font-size: var(--fs-micro); color: var(--label-secondary);
}
.seg button.on { background: var(--action); color: var(--on-action); font-weight: 600; }
.seg button:focus-visible, .wact button:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.wurl {
  flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-micro);
  color: var(--label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 动作行右对齐、低对比——它是随时可用但不该抢戏的一层 */
.wact { display: flex; gap: 12px; margin-left: auto; flex: 0 0 auto; }
.wact button {
  border: none; background: none; cursor: pointer; padding: 2px 0;
  font-size: var(--fs-micro); color: var(--label-tertiary); white-space: nowrap;
}
.wact button:hover { color: var(--label); }

/* 未启用能力的空态：说清「为什么空、要什么才不空」 */
.wempty { align-items: center; justify-content: center; text-align: center; padding: 0 32px; }
.we-t { margin: 0 0 8px; font-size: var(--fs-title); font-weight: 600; color: var(--label-secondary); }
.we-d { margin: 0; font-size: var(--fs-ui); line-height: 1.7; color: var(--label-tertiary); }
.rfill { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
</style>
