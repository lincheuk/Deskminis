<script setup lang="ts">
/** 应用外壳（设计 §4）——自绘标题栏（顶，全宽）+ 三栏 232 | 1fr | 360（右栏 320-480 可拖、可收起）。
 *  MU2b Task 5：设置独立模态（SettingsModal），右栏 gear 退场；托盘 menu:open-settings/menu:toggle-right
 *  死通道经 preload 两订阅接通；主题偏好 localStorage 持久化（lib/settings/theme）。 */
import { onMounted, onBeforeUnmount, ref, computed, provide, reactive } from 'vue';
import { useChat } from './stores/chat';
import { clampPaneWidth, nextWidth } from './lib/pane/drag';
import { loadTheme, saveTheme, type ThemeMode } from './lib/settings/theme';
import TitleBar from './components/TitleBar.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import FilesPanel from './components/FilesPanel.vue';
import ProgressPanel from './components/ProgressPanel.vue';
import ArtifactsPanel from './components/ArtifactsPanel.vue';
import SettingsModal from './components/SettingsModal.vue';

const chat = useChat();

const sidebarOpen = ref(true);
const rightOpen = ref(true);
/** MU2b Task 5：settingsOpen 语义改为设置模态开关（原右栏 settings 分支退场） */
const settingsOpen = ref(false);
const rightTab = ref<'progress' | 'artifacts' | 'files' | 'terminal'>('progress');
/** 懒挂载 + v-show 保活（首次切到才创建组件，之后切换只隐藏不销毁） */
const visited = reactive({ progress: true, artifacts: false, files: false, terminal: false });
function showTab(tab: 'progress' | 'artifacts' | 'files' | 'terminal'): void {
  settingsOpen.value = false;
  rightTab.value = tab;
  visited[tab] = true;
}

/** 右栏宽度：360 默认、320–480 分隔条拖拽（lib/pane/drag 纯逻辑），localStorage 持久化。 */
const rightW = ref(360);
function startRDrag(e: MouseEvent): void {
  const startX = e.clientX;
  const startW = rightW.value;
  const onMove = (ev: MouseEvent): void => { rightW.value = nextWidth(startX, startW, ev.clientX); };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    localStorage.setItem('deskminis.rightW', String(rightW.value));
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
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
// MU2b Task 3：产物卡点击 → 切右栏 tab（等价 tab 点击，供深层组件调用）
provide('switchRightTab', (tab: 'progress' | 'artifacts' | 'files' | 'terminal') => { rightOpen.value = true; showTab(tab); });

// Ctrl+, 开/关设置模态（设计 §1.1-2；不拦截输入区文本键入）
function onGlobalKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === ',') {
    e.preventDefault();
    settingsOpen.value = !settingsOpen.value;
  }
}

onMounted(() => {
  const saved = Number(localStorage.getItem('deskminis.rightW'));
  if (saved) rightW.value = clampPaneWidth(saved);
  applyTheme(); // 启动即应用 loadTheme 读回的偏好
  // MU2b Task 5：托盘菜单死通道接通（preload 白名单两订阅；main 侧零改动）
  const bridge = (window as { deskminis?: { onMenuOpenSettings?: (cb: () => void) => void; onMenuToggleRight?: (cb: () => void) => void } }).deskminis;
  bridge?.onMenuOpenSettings?.(() => { settingsOpen.value = true; });
  bridge?.onMenuToggleRight?.(() => { rightOpen.value = !rightOpen.value; });
  window.addEventListener('keydown', onGlobalKey);
  void chat.init();
});
onBeforeUnmount(() => { window.removeEventListener('keydown', onGlobalKey); });
</script>

<template>
  <div class="shell">
    <TitleBar
      :title="activeTitle"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @toggle-right="rightOpen = !rightOpen"
      @toggle-theme="cycleTheme"
    />
    <div class="win">
      <aside v-show="sidebarOpen" class="pane-l"><SessionList /></aside>
      <main class="pane-c"><ChatView /></main>
      <aside v-show="rightOpen" class="pane-r" :style="{ width: rightW + 'px', flex: '0 0 ' + rightW + 'px' }">
        <div class="rdrag" @mousedown="startRDrag"></div>
        <div class="tabs">
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'progress', 'dot-warn': chat.pendingPerms.length > 0 }" @click="showTab('progress')">进度</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'artifacts' }" @click="showTab('artifacts')">产物</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'files' }" @click="showTab('files')">文件</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'terminal' }" @click="showTab('terminal')">终端</div>
        </div>
        <div v-show="rightTab === 'progress'" class="rfill"><ProgressPanel v-if="visited.progress" /></div>
        <div v-show="rightTab === 'artifacts'" class="rfill"><ArtifactsPanel v-if="visited.artifacts" /></div>
        <div v-show="rightTab === 'files'" class="rfill"><FilesPanel v-if="visited.files" /></div>
        <div v-show="rightTab === 'terminal'" class="rfill"><TerminalPanel v-if="visited.terminal" /></div>
      </aside>
    </div>
    <SettingsModal v-if="settingsOpen" :theme="theme" @set-theme="setTheme" @close="settingsOpen = false" />
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100vh; background: var(--bg); }
.win { flex: 1; display: flex; min-height: 0; overflow: hidden; }

.pane-l {
  width: 232px; flex: 0 0 232px; background: var(--bg); border-right: .5px solid var(--separator);
  display: flex; flex-direction: column; overflow: hidden;
}
.pane-c { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
.pane-r {
  position: relative;
  width: 360px; flex: 0 0 360px; border-left: .5px solid var(--separator); background: var(--bg);
  display: flex; flex-direction: column; overflow: hidden;
}
/* 6px 拖拽热区：跨骑在右栏左缘（border 上），绝对定位不占布局 */
.rdrag { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
.tabs { display: flex; gap: 2px; padding: 10px; border-bottom: .5px solid var(--separator); }
.tab {
  flex: 1; text-align: center; padding: 6px; font-size: 13px; font-weight: 500; color: var(--label-secondary);
  border-radius: var(--r-control); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.tab.on { background: var(--fill-quaternary); color: var(--label); }
/* 进度 tab 等待批准橙点（审计 H4：pendingPerms>0 显著化） */
.tab.dot-warn { position: relative; }
.tab.dot-warn::after {
  content: ''; position: absolute; top: 4px; right: 8px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--state-warn);
}
.rfill { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
</style>
