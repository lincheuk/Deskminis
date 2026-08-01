<script setup lang="ts">
/** 应用外壳（设计 §4）——自绘标题栏（顶，全宽）+ 三栏 260 | 1fr | 360（右栏 320-480 可拖、可收起）。 */
import { onMounted, ref, computed, provide, reactive } from 'vue';
import { useChat } from './stores/chat';
import { clampPaneWidth, nextWidth } from './lib/pane/drag';
import TitleBar from './components/TitleBar.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import ProviderSettings from './components/ProviderSettings.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import FilesPanel from './components/FilesPanel.vue';
import TasksPanel from './components/TasksPanel.vue';
import Icon from './components/Icon.vue';

const chat = useChat();

const sidebarOpen = ref(true);
const rightOpen = ref(true);
const settingsOpen = ref(false);
const rightTab = ref<'progress' | 'artifacts' | 'files' | 'terminal'>('progress');
/** 懒挂载 + v-show 保活（首次切到才创建组件，之后切换只隐藏不销毁） */
const visited = reactive({ progress: true, artifacts: false, files: false, terminal: false });
function showTab(tab: 'progress' | 'artifacts' | 'files' | 'terminal'): void {
  settingsOpen.value = false;
  rightTab.value = tab;
  visited[tab] = true;
}
function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
  if (!settingsOpen.value) visited[rightTab.value] = true;
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

// 明暗：appearanceMode 0 跟随系统 / 1 强制浅 / 2 强制深——循环切换并落到 <html data-theme>
type Theme = 'system' | 'light' | 'dark';
const theme = ref<Theme>('system');
function applyTheme(): void {
  const el = document.documentElement;
  if (theme.value === 'system') el.removeAttribute('data-theme');
  else el.dataset.theme = theme.value;
}
function cycleTheme(): void {
  theme.value = theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system';
  applyTheme();
}

// 当前会话标题（无选中时留空）——首帧 activeId 为空、sessions 为空也不解引用 undefined
const activeTitle = computed(() => chat.sessions.find(s => s.id === chat.activeId)?.title ?? '');

// ModelPicker 的「管理模型…」经此进入设置面板（无需逐层 emit）
provide('openSettings', () => { settingsOpen.value = true; rightOpen.value = true; });

onMounted(() => {
  const saved = Number(localStorage.getItem('deskminis.rightW'));
  if (saved) rightW.value = clampPaneWidth(saved);
  void chat.init();
});
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
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'progress' }" @click="showTab('progress')">进度</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'artifacts' }" @click="showTab('artifacts')">产物</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'files' }" @click="showTab('files')">文件</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'terminal' }" @click="showTab('terminal')">终端</div>
          <div class="tab gear" :class="{ on: settingsOpen }" title="模型设置" @click="toggleSettings"><Icon name="gear" :size="15" /></div>
        </div>
        <div v-if="settingsOpen" class="rbody"><ProviderSettings /></div>
        <template v-else>
          <div v-show="rightTab === 'progress'" class="rfill"><TasksPanel v-if="visited.progress" /></div>
          <div v-show="rightTab === 'artifacts'" class="rfill"><div v-if="visited.artifacts" class="rempty">产物面板（MU2b Task 3 填实）</div></div>
          <div v-show="rightTab === 'files'" class="rfill"><FilesPanel v-if="visited.files" /></div>
          <div v-show="rightTab === 'terminal'" class="rfill"><TerminalPanel v-if="visited.terminal" /></div>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100vh; background: var(--bg); }
.win { flex: 1; display: flex; min-height: 0; overflow: hidden; }

.pane-l {
  width: 260px; flex: 0 0 260px; background: var(--bg); border-right: .5px solid var(--separator);
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
.tab.gear { flex: 0 0 32px; }
.tab.on { background: var(--fill-quaternary); color: var(--label); }
.rbody { flex: 1; overflow: auto; padding: 12px 14px; }
.rfill { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.rempty {
  flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
  font-size: 13px; color: var(--label-tertiary); padding: 24px; line-height: 1.6;
}
</style>
