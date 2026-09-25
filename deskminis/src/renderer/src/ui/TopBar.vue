<script setup lang="ts">
/** T 波：标题栏。frameless 窗口 + titleBarOverlay——系统在**右上角**画 min/max/close，
 *  所以右侧必须留出 140px 空位，否则我们的控件会被系统按钮压住（旧 TitleBar 踩过）。
 *  整条可拖拽，交互元素逐个 no-drag。 */
import { computed } from 'vue';
import { useChat } from '../stores/chat';
import UiIcon from './UiIcon.vue';

const props = defineProps<{ railOpen: boolean; asideOpen: boolean; termOpen: boolean }>();
const emit = defineEmits<{ (e: 'toggle-rail'): void; (e: 'toggle-aside'): void; (e: 'toggle-term'): void; (e: 'menu'): void }>();
const chat = useChat();

/** 标题 = 当前会话名；无会话时显示应用名。系统同步态用一个小点表示，不占文字位。 */
const title = computed(() => {
  const s = chat.sessions.find(x => x.id === chat.activeId);
  return s?.title || 'DeskMinis';
});
const syncDot = computed(() => {
  // Y3：暂停优先于三态——暂停是用户主动设的，橙点 + 提示，别让它伪装成「未连接」
  if (chat.syncPaused) return { c: 'var(--c-warn)', t: '已暂停设备间同步' };
  if (chat.syncState === 'syncing') return { c: 'var(--c-link)', t: '正在与其它设备同步' };
  if (chat.syncState === 'idle') return { c: 'var(--c-ok)', t: '已连接其它设备' };
  return { c: 'var(--c-ink-4)', t: '未连接其它设备' };
});
</script>

<template>
  <header class="bar">
    <div class="side">
      <button class="ib" type="button" :aria-pressed="props.railOpen" title="侧栏" @click="emit('toggle-rail')">
        <UiIcon name="panel" :size="17" />
      </button>
      <button class="ib" type="button" title="菜单" @click="emit('menu')">
        <UiIcon name="menu" :size="17" />
      </button>
    </div>

    <div class="mid"><span class="ttl">{{ title }}</span></div>

    <div class="side right">
      <span class="dot" :style="{ background: syncDot.c }" :title="syncDot.t"></span>
      <button class="ib" type="button" :aria-pressed="props.termOpen" title="终端" @click="emit('toggle-term')">
        <UiIcon name="terminal" :size="17" />
      </button>
      <button class="ib" type="button" :aria-pressed="props.asideOpen" title="工作台" @click="emit('toggle-aside')">
        <UiIcon name="aside" :size="17" />
      </button>
    </div>
  </header>
  <!-- W2b-3 断线横幅：标题栏下方独立一行。标题栏右侧 146px 被系统 min/max/close 盖着，塞不进那一行；
       走正常流、不设层级，舞台随之下移一行，不压住任何内容。重启的是整个应用（主进程 app:relaunch）。 -->
  <div v-if="chat.connection === 'lost'" class="lost" role="alert">
    <UiIcon name="alert" :size="16" />
    <span class="lmsg">与后台服务的连接已断开。进行中的任务可能已中止，新的操作不会执行。</span>
    <button class="f-btn primary" type="button" @click="chat.relaunchApp()">重启应用</button>
  </div>
</template>

<style scoped>
.bar {
  height: var(--h-topbar); flex: 0 0 auto;
  display: flex; align-items: center; gap: var(--sp-3);
  padding-left: var(--sp-3);
  /* 右侧给系统 min/max/close 让位（titleBarOverlay 约 138px），否则控件被压住 */
  padding-right: 146px;
  background: var(--c-bg-1);
  border-bottom: 1px solid var(--c-line);
  -webkit-app-region: drag;
  user-select: none;
}
.side { display: flex; align-items: center; gap: var(--sp-1); flex: 0 0 auto; -webkit-app-region: no-drag; }
.side.right { margin-left: auto; gap: var(--sp-3); }
.mid { flex: 1; min-width: 0; display: flex; justify-content: center; }
.ttl {
  font-size: var(--t-item-size); line-height: var(--t-item-lh); color: var(--c-ink-2);
  max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ib {
  width: var(--h-round); height: var(--h-round); border-radius: var(--r-s);
  display: inline-flex; align-items: center; justify-content: center;
  background: none; color: var(--c-ink-3); cursor: pointer; padding: 0;
}
.ib:hover { background: var(--c-bg-2); color: var(--c-ink); }
.ib[aria-pressed="true"] { color: var(--c-ink); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
/* W2b-3 断线横幅：错误浅底 + 错误色字（两套主题对比度都过 4.5，theme-contrast 钉着）。
   不在拖拽区里（-webkit-app-region 只挂在标题栏上），按钮点得到。 */
.lost {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3) var(--sp-2) var(--sp-4);
  background: var(--c-err-soft);
  color: var(--c-err);
  border-bottom: 1px solid var(--c-line);
}
.lmsg { flex: 1; min-width: 0; font-size: var(--t-item-size); line-height: var(--t-item-lh); }
</style>
