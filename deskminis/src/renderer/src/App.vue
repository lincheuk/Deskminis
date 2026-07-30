<script setup lang="ts">
/** 应用外壳（设计 §4）——自绘标题栏（顶，全宽）+ 三栏 260 | 1fr | 300（右栏可收起）。 */
import { onMounted, ref, computed, provide, reactive } from 'vue';
import { useChat } from './stores/chat';
import TitleBar from './components/TitleBar.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import ProviderSettings from './components/ProviderSettings.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import FilesPanel from './components/FilesPanel.vue';
import Icon from './components/Icon.vue';

const chat = useChat();

const sidebarOpen = ref(true);
const rightOpen = ref(true);
const settingsOpen = ref(false);
const rightTab = ref<'terminal' | 'files' | 'tasks'>('terminal');
/** 懒挂载 + v-show 保活（首次切到才创建组件，之后切换只隐藏不销毁） */
const visited = reactive({ terminal: true, files: false, tasks: false });
function showTab(tab: 'terminal' | 'files' | 'tasks'): void {
  settingsOpen.value = false;
  rightTab.value = tab;
  visited[tab] = true;
}
function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
  if (!settingsOpen.value) visited[rightTab.value] = true;
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

onMounted(() => { void chat.init(); });
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
      <aside v-show="rightOpen" class="pane-r">
        <div class="tabs">
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'terminal' }" @click="showTab('terminal')">终端</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'files' }" @click="showTab('files')">文件</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'tasks' }" @click="showTab('tasks')">任务</div>
          <div class="tab gear" :class="{ on: settingsOpen }" title="模型设置" @click="toggleSettings"><Icon name="gear" :size="15" /></div>
        </div>
        <div v-if="settingsOpen" class="rbody"><ProviderSettings /></div>
        <template v-else>
          <div v-show="rightTab === 'terminal'" class="rfill"><TerminalPanel v-if="visited.terminal" /></div>
          <div v-show="rightTab === 'files'" class="rfill"><FilesPanel v-if="visited.files" /></div>
          <div v-if="rightTab === 'tasks'" class="rempty">M2d 后续任务填入任务进度</div>
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
  width: 300px; flex: 0 0 300px; border-left: .5px solid var(--separator); background: var(--bg);
  display: flex; flex-direction: column; overflow: hidden;
}
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
