<script setup lang="ts">
/** 中栏空状态 · 任务起点页（MU2b Task 6，设计 §1.3）——3 示例指令卡（读代码/写脚本/跑命令，
 *  点击 emit('fill') 填入输入框）+ 最近任务 3 条（chat.sessions 前 3，点击 chat.open 直达，
 *  相对时间复用 lib/time/relative）。 */
import { useChat } from '../stores/chat';
import { fmtRelative } from '../lib/time/relative';
import Icon from './Icon.vue';

const chat = useChat();
const emit = defineEmits<{ (e: 'fill', text: string): void }>();

interface Example { icon: string; title: string; text: string }
const EXAMPLES: Example[] = [
  { icon: 'book', title: '读代码', text: '帮我读懂这个项目：从入口开始，讲清核心模块和它们的关系' },
  { icon: 'edit', title: '写脚本', text: '写一个 PowerShell 脚本：把 Downloads 里超过 30 天没动过的文件移入 archive 子目录' },
  { icon: 'terminal', title: '跑命令', text: '看一下当前工作区的目录结构，告诉我这个项目怎么跑起来' },
];

interface S { id: string; title: string; updatedAt?: number }
function recentThree(): S[] { return chat.sessions.slice(0, 3); }
function rel(s: S): string { return s.updatedAt ? fmtRelative(s.updatedAt, Date.now() / 1000) : ''; }
</script>

<template>
  <div class="empty">
    <!-- I3 hero 问候（AionUi Guid 页「Hi, what's your plan for today?」的中文位） -->
    <h2>你好，今天想做点什么？</h2>
    <p class="sub">让 DeskMinis 帮你读写文件、执行命令、完成任务</p>

    <div class="cards">
      <div v-for="ex in EXAMPLES" :key="ex.title" class="excard" @click="emit('fill', ex.text)" tabindex="0" role="button" @keydown.enter.prevent="emit('fill', ex.text)" @keydown.space.prevent="emit('fill', ex.text)">
        <Icon :name="ex.icon" :size="16" />
        <div class="extxt"><div class="extitle">{{ ex.title }}</div><div class="exsub">{{ ex.text }}</div></div>
      </div>
    </div>

    <div v-if="recentThree().length" class="recent">
      <div class="rhead">最近任务</div>
      <div
        v-for="s in recentThree()" :key="s.id"
        class="ritem" tabindex="0" role="button" @keydown.enter.prevent="chat.open(s.id)" @keydown.space.prevent="chat.open(s.id)"
        @click="chat.open(s.id)"
      >
        <span class="rtitle">{{ s.title || '新会话' }}</span>
        <span class="rtime">{{ rel(s) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty {
  flex: 1; height: 100%; display: flex; flex-direction: column;
  align-items: center; gap: 8px;
  /* safe center 而不是 center：**flexbox 的经典陷阱**——内容比容器高时，
     center 会把内容顶到滚动原点以上，上半截既看不见也滚不到。
     safe 在溢出时自动退回 start，内容永远从顶部开始、可滚。
     用户 2026-08-11 实测「开始新的对话怎么顶格了」正是这个：对话列变窄后
     示例卡从横排变竖排、空态整体变高，把下面那段固定的「上提」偏置挤成了溢出。 */
  justify-content: safe center;
  /* 底部多留白把内容上提：对话区很高，纯居中会让视觉重心偏低。
     偏置封顶 72px——10vh 在高窗口上会到 120px+，内容一高就直接把标题顶到贴边。 */
  /* 顶部 40 而非 24：safe center 在内容偏高时会退回 start（这是对的——内容比容器高时
     就该从顶部开始、可滚），此时顶部留白就是唯一的呼吸位，24 太紧。 */
  padding: 40px 24px calc(24px + min(10vh, 72px));
}
/* I3：hero 规格对齐 AionUi 欢迎标题（text-2xl/600），从面板题升为页面题 */
.empty h2 { font-size: 26px; font-weight: 600; color: var(--label-emphasis); }
.sub { font-size: 15px; color: var(--label-secondary); }

/* 示例指令卡：横排三张（窄了自动换行），点击填入输入框 */
/* I3 平面化（AionUi 助手卡语言）：白卡 + 1px 边 + 柔影，受光边退场 */
.cards { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; justify-content: center; }
.excard {
  width: 218px; display: flex; gap: 10px; align-items: flex-start; padding: 12px;
  border: 1px solid var(--separator); border-radius: var(--r-card); background: var(--surface-1);
  box-shadow: 0 2px 8px var(--shadow-color);
  cursor: pointer; color: var(--label-secondary);
}
.excard:hover { background: var(--fill-quaternary); color: var(--label); }
.excard :deep(svg) { flex: 0 0 auto; margin-top: 2px; }
.extxt { min-width: 0; text-align: left; }
.extitle { font-size: var(--fs-ui); font-weight: 600; color: var(--label-strong); }
.exsub {
  font-size: var(--fs-caption); color: var(--label-tertiary); margin-top: 3px; line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

/* 最近任务：标题 + 相对时间，点击直达会话 */
.recent { margin-top: 22px; width: 452px; max-width: 100%; }
.rhead { font-size: 12px; font-weight: 600; color: var(--label-tertiary); padding: 0 4px 6px; text-align: left; }
.ritem {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r-control);
  cursor: pointer; color: var(--label-secondary);
}
.ritem:hover { background: var(--fill-quaternary); color: var(--label); }
.rtitle { flex: 1; min-width: 0; font-size: var(--fs-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.rtime { flex: 0 0 auto; font-size: var(--fs-micro); color: var(--label-tertiary); font-variant-numeric: tabular-nums; }
</style>
