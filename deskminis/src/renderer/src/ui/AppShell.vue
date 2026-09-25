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
import NavRail from './NavRail.vue';
import StageWelcome from './StageWelcome.vue';
import StageChat from './StageChat.vue';
import PreviewPane from './PreviewPane.vue';
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
/** 打开过的产出物：每个一个标签，来回对照不用重新找（agent 一轮常产出好几个文件）。 */
const openDocs = ref<string[]>([]);
function openDoc(p: string): void {
  if (!openDocs.value.includes(p)) openDocs.value.push(p);
  previewPath.value = p;
}
function closeDoc(p: string): void {
  const i = openDocs.value.indexOf(p);
  if (i >= 0) openDocs.value.splice(i, 1);
  if (previewPath.value === p) previewPath.value = openDocs.value[i] ?? openDocs.value[i - 1] ?? null;
}
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
watch(() => chat.activeId, () => { previewPath.value = null; openDocs.value = []; });
// 产物卡/其它入口写入的待预览路径（store 既有字段）——消费即清空
watch(() => chat.pendingFilePreview, (p) => {
  if (!p) return;
  chat.pendingFilePreview = null;
  openDoc(p);
});

/** 主题：跟随系统，用户可在菜单里覆写（T5 接菜单，先留接口）。 */
function toggleTheme(): void {
  const el = document.documentElement;
  el.dataset.theme = el.dataset.theme === 'dark' ? 'light' : 'dark';
}
</script>

<template>
  <div class="shell">
    <TopBar
      :rail-open="railOpen" :aside-open="wsOpen" :term-open="termOpen"
      @toggle-rail="railOpen = !railOpen"
      @toggle-aside="toggleAside"
      @toggle-term="termOpen = !termOpen"
      @menu="toggleTheme"
    />
    <div class="body">
      <NavRail v-show="railOpen" :view="view" :compact="!!previewPath" @view="v => (view = v)" />

      <main class="stage">
        <template v-if="view === 'chat'">
          <template v-if="inChat">
            <TabBar
              v-if="openDocs.length" :open="openDocs" :active="previewPath"
              @pick="p => (previewPath = p)" @close="closeDoc"
            />
            <div class="split" :class="{ withPreview: !!previewPath }">
              <StageChat class="chatcol" :narrow="!!previewPath" />
              <PreviewPane v-if="previewPath" :path="previewPath" @close="closeDoc(previewPath)" />
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
        :selected="previewPath"
        @open="openDoc"
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
.split { flex: 1; min-height: 0; display: flex; }
.split .chatcol { flex: 1; min-width: 0; }
.split.withPreview .chatcol { flex: 0 0 var(--w-chatcol); }
</style>
