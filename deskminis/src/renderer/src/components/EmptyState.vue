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
    <h2>开始新的对话</h2>
    <p class="sub">让 DeskMinis 帮你读写文件、执行命令、完成任务</p>

    <div class="cards">
      <div v-for="ex in EXAMPLES" :key="ex.title" class="excard" @click="emit('fill', ex.text)">
        <Icon :name="ex.icon" :size="16" />
        <div class="extxt"><div class="extitle">{{ ex.title }}</div><div class="exsub">{{ ex.text }}</div></div>
      </div>
    </div>

    <div v-if="recentThree().length" class="recent">
      <div class="rhead">最近任务</div>
      <div
        v-for="s in recentThree()" :key="s.id"
        class="ritem"
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
  align-items: center; justify-content: center; gap: 8px;
  /* 底部多留白把内容上提：对话区很高，纯居中会让视觉重心偏低 */
  padding: 24px 24px calc(24px + 10vh);
}
.empty h2 { font-size: 22px; font-weight: 700; color: var(--label-emphasis); }
.sub { font-size: 15px; color: var(--label-secondary); }

/* 示例指令卡：横排三张（窄了自动换行），点击填入输入框 */
.cards { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; justify-content: center; }
.excard {
  width: 218px; display: flex; gap: 10px; align-items: flex-start; padding: 12px;
  border: .5px solid var(--separator); border-radius: var(--r-card); background: var(--surface-1);
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
