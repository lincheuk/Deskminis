<script setup lang="ts">
/** T 波：应用外壳（设计稿 §3）。三区栅格 TopBar / [NavRail | Stage | AsideDock]。
 *
 *  与旧 App.vue 的实质差别：
 *  ① Stage 内容**定宽居中**（--w-stage 760），不再撑满列宽——长行难读是旧 UI 通病；
 *  ② Aside **默认收起**，不再常驻挤压中栏到 336px（那是「胶囊塞不下」等一连串
 *     挤压问题的总根源）；
 *  ③ 欢迎态与会话态是 Stage 内两个**并列视图**，不再靠 v-if 在同一棵组件树上叠条件。 */
import { computed, onMounted, ref, watch } from 'vue';
import { useChat } from '../stores/chat';
import TopBar from './TopBar.vue';
import NavRail from './NavRail.vue';
import StageWelcome from './StageWelcome.vue';
import StageChat from './StageChat.vue';
import PreviewPane from './PreviewPane.vue';
import WorkspacePanel from './WorkspacePanel.vue';

const chat = useChat();
const railOpen = ref(true);
const wsOpen = ref(true);
/** 当前预览的产出物（相对工作区路径）。有值时舞台分栏：对话让到左边一条，预览占主位——
 *  这是 Cowork 形态的核心（用户 2026-08-21 参考图）：产出物是主角，对话是辅助。 */
const previewPath = ref<string | null>(null);
/** 主视图：chat（欢迎/会话由 activeId 决定）| cron | assistants | settings | devices */
const view = ref<'chat' | 'cron' | 'assistants' | 'settings' | 'devices'>('chat');

/** 会话态 = 选中了会话且它已有消息；否则欢迎态。 */
const inChat = computed(() => !!chat.activeId && chat.messages.length > 0);

onMounted(() => { void chat.init(); });

// 会话切换：上一会话的预览路径在新会话里没有意义
watch(() => chat.activeId, () => { previewPath.value = null; });
// 产物卡/其它入口写入的待预览路径（store 既有字段）——消费即清空
watch(() => chat.pendingFilePreview, (p) => {
  if (!p) return;
  chat.pendingFilePreview = null;
  previewPath.value = p;
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
      :rail-open="railOpen" :aside-open="wsOpen"
      @toggle-rail="railOpen = !railOpen"
      @toggle-aside="wsOpen = !wsOpen"
      @menu="toggleTheme"
    />
    <div class="body">
      <NavRail v-show="railOpen" :view="view" @view="v => (view = v)" />

      <main class="stage">
        <template v-if="view === 'chat'">
          <div v-if="inChat" class="split" :class="{ withPreview: !!previewPath }">
            <StageChat class="chatcol" :narrow="!!previewPath" />
            <PreviewPane v-if="previewPath" :path="previewPath" @close="previewPath = null" />
          </div>
          <StageWelcome v-else />
        </template>
        <div v-else class="todo">
          <p class="t-h2">{{ view }}</p>
          <p class="t-aux">这个视图在下一步接入</p>
        </div>
      </main>

      <WorkspacePanel
        v-show="wsOpen && view === 'chat'"
        :selected="previewPath"
        @open="p => (previewPath = p)"
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
.todo {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--sp-2); color: var(--c-ink-3);
}
.todo p { margin: 0; }
</style>
