<script setup lang="ts">
/** T 波：左导航。与旧 SessionList 的实质差别（设计稿 §3）——
 *  它是**分组导航**（会话/定时/助手三区 + 底部入口），不是一条会话列表加底部按钮。
 *  会话按自然日分组（lib/nav/group 纯模块），行高 34、圆角 8、选中用主色浅底。 */
import { computed, ref } from 'vue';
import { useChat } from '../stores/chat';
import { groupSessions } from '../lib/nav/group';
import UiIcon from './UiIcon.vue';

const chat = useChat();
const emit = defineEmits<{ (e: 'view', v: 'chat' | 'search' | 'cron' | 'assistants' | 'market' | 'settings' | 'devices'): void }>();
/** compact = 只剩图标的窄条。产出物预览打开时自动进入——舞台要让给产出物，
 *  会话列表这时不是必需品（参考图里有预览的几张，左侧都只剩一条图标栏）。 */
const props = defineProps<{ view: string; compact?: boolean }>();

const nowSec = ref(Math.floor(Date.now() / 1000));
setInterval(() => { nowSec.value = Math.floor(Date.now() / 1000); }, 60_000);

const groups = computed(() => groupSessions(chat.sessions, nowSec.value));
const emojiOf = (id: string): string => chat.assistants.find(a => a.id === id)?.avatar ?? '';
/** 会话前的彩色小图标：原图每条 conversation 都带一个彩色圆图标，
 *  一列纯文字很难扫。没有助手 emoji 时退化成纯色圆点，色相由会话 id 派生（稳定）。 */
function dotStyle(id: string): Record<string, string> {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return { background: `oklch(0.90 0.08 ${h})`, color: `oklch(0.45 0.15 ${h})` };
}

async function newChat(): Promise<void> {
  await chat.newSession();
  emit('view', 'chat');
}
function openSession(id: string): void {
  void chat.open(id);
  emit('view', 'chat');
}
</script>

<template>
  <nav class="rail" :class="{ compact: props.compact }">
    <div class="brand">
      <span class="mark"><UiIcon name="chat" :size="15" /></span>
      <span v-if="!props.compact" class="bname">DeskMinis</span>
    </div>

    <button class="newbtn" type="button" :title="props.compact ? '新建会话' : ''" @click="newChat">
      <UiIcon name="plus" :size="16" /><span v-if="!props.compact">新建会话</span>
    </button>

    <div class="nav">
      <button class="navit" type="button" :class="{ on: props.view === 'search' }" @click="emit('view', 'search')">
        <UiIcon name="search" :size="16" /><span v-if="!props.compact">搜索会话</span>
      </button>
      <button class="navit" type="button" :class="{ on: props.view === 'cron' }" @click="emit('view', 'cron')">
        <UiIcon name="clock" :size="16" /><span v-if="!props.compact">定时任务</span>
        <span v-if="!props.compact && chat.cronJobs.length" class="cnt tnum">{{ chat.cronJobs.length }}</span>
      </button>
      <button class="navit" type="button" :class="{ on: props.view === 'assistants' }" @click="emit('view', 'assistants')">
        <UiIcon name="robot" :size="16" /><span v-if="!props.compact">助手</span>
        <span v-if="!props.compact && chat.assistants.length" class="cnt tnum">{{ chat.assistants.length }}</span>
      </button>
      <button class="navit" type="button" :class="{ on: props.view === 'market' }" @click="emit('view', 'market')">
        <UiIcon name="puzzle" :size="16" /><span v-if="!props.compact">扩展市场</span>
      </button>
    </div>

    <div v-if="!props.compact" class="list">
      <div class="seghead">会话</div>
      <div v-if="!chat.sessions.length" class="empty">还没有会话<br />点上面「新建会话」开始</div>
      <template v-for="g in groups" :key="g.label">
        <div class="ghead">{{ g.label }}</div>
        <button
          v-for="s in g.items" :key="s.id" type="button"
          class="srow" :class="{ on: s.id === chat.activeId && props.view === 'chat' }"
          @click="openSession(s.id)"
        >
          <span class="semo" :style="dotStyle(s.id)">{{ emojiOf(String(s.assistantId ?? '')) || '' }}</span>
          <span class="stitle">{{ s.title || '新会话' }}</span>
        </button>
      </template>
    </div>

    <div class="foot">
      <button class="navit" type="button" :class="{ on: props.view === 'settings' }" @click="emit('view', 'settings')">
        <UiIcon name="gear" :size="16" /><span v-if="!props.compact">设置</span>
      </button>
      <button class="navit" type="button" :class="{ on: props.view === 'devices' }" @click="emit('view', 'devices')">
        <UiIcon name="device" :size="16" /><span v-if="!props.compact">设备</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  width: var(--w-rail); flex: 0 0 var(--w-rail);
  transition: width .16s ease, flex-basis .16s ease;
  display: flex; flex-direction: column; min-height: 0;
  /* 原图侧栏是**纯白**，只靠右侧一条线与舞台分开；我原先做成灰底，白卡浮不出来 */
  background: var(--c-bg);
  border-right: 1px solid var(--c-line);
}

.brand { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-5) var(--sp-5) var(--sp-3); }
.mark {
  width: 26px; height: 26px; border-radius: var(--r-s); flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  /* 品牌标记走 AOU 紫，交互蓝留给按钮/选中——两者分工，界面才有主次 */
  background: var(--c-aou); color: var(--c-brand-ink);
}
.bname { font-size: var(--t-h2-size); line-height: var(--t-h2-lh); font-weight: var(--w-bd); color: var(--c-ink); }

.newbtn {
  margin: 0 var(--sp-5) var(--sp-5); height: var(--h-field); flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
  border-radius: var(--r-s); cursor: pointer;
  /* 原图是浅蓝底 + 深蓝字的**轻**按钮，不是实底大色块——实底在白侧栏里太抢 */
  background: var(--c-brand-soft); color: var(--c-brand);
  font-size: var(--t-body-size); font-weight: var(--w-md); font-family: inherit;
}
.newbtn:hover { background: var(--c-brand-line); }

.nav { padding: 0 var(--sp-3) var(--sp-3); display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
.navit {
  display: flex; align-items: center; gap: var(--sp-3); width: 100%;
  height: var(--h-row); padding: 0 var(--sp-4); border-radius: var(--r-s);
  background: none; color: var(--c-ink-2); cursor: pointer; text-align: left;
  font-size: var(--t-item-size); font-family: inherit;
}
.navit:hover { background: var(--c-bg-2); color: var(--c-ink); }
.navit.on { background: var(--c-brand-soft); color: var(--c-ink); font-weight: var(--w-md); }
.navit > span:first-of-type { flex: 1; min-width: 0; }
.cnt { flex: 0 0 auto; font-size: var(--t-aux-size); color: var(--c-ink-3); }

.list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--sp-3) var(--sp-3); }
.empty {
  font-size: var(--t-aux-size); line-height: 1.7; color: var(--c-ink-3);
  text-align: center; padding: var(--sp-7) var(--sp-4);
}
.ghead {
  font-size: var(--t-aux-size); line-height: var(--t-aux-lh); color: var(--c-ink-4);
  padding: var(--sp-4) var(--sp-4) var(--sp-1);
}
/* 段头（原图 Teams/Projects/Conversations 那一级）：比日期分组更高一层 */
.seghead {
  font-size: var(--t-aux-size); line-height: var(--t-aux-lh); color: var(--c-ink-3);
  font-weight: var(--w-md); padding: var(--sp-5) var(--sp-4) var(--sp-1);
}
.rail.compact .seghead { display: none; }
.srow {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  height: var(--h-row); padding: 0 var(--sp-4); border-radius: var(--r-s);
  background: none; color: var(--c-ink-2); cursor: pointer; text-align: left;
  font-size: var(--t-item-size); font-family: inherit;
}
.srow:hover { background: var(--c-bg-2); color: var(--c-ink); }
.srow.on { background: var(--c-brand-soft); color: var(--c-ink); font-weight: var(--w-md); }
.semo {
  flex: 0 0 auto; width: 20px; height: 20px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; line-height: 1;
}
.stitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.foot {
  flex: 0 0 auto; padding: var(--sp-3); display: flex; flex-direction: column; gap: 2px;
  border-top: 1px solid var(--c-line);
}

/* ---- compact：只剩一条图标栏 ---- */
.rail.compact { width: var(--w-rail-mini); flex: 0 0 var(--w-rail-mini); }
.rail.compact .brand { justify-content: center; padding: var(--sp-5) 0 var(--sp-3); }
.rail.compact .newbtn { margin: 0 auto var(--sp-5); width: var(--h-round); padding: 0; }
.rail.compact .nav,
.rail.compact .foot { padding-left: 0; padding-right: 0; align-items: center; }
.rail.compact .navit { width: var(--h-round); padding: 0; justify-content: center; }
/* compact 下 .list 不渲染，但留一段弹性把底部入口压到底 */
.rail.compact .nav { flex: 1; justify-content: flex-start; }
</style>
