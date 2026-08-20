<script setup lang="ts">
/** 中栏空状态 · 任务起点页（MU2b Task 6 → J2 两态 → I6 分部 + 药丸选择流）。
 *  I6（用户 2026-08-20 截图指令，AionUi Guid 页语义）：分两部随 ChatView 布局——
 *  part="hero" 在 composer 上（问候/助手身份），part="below" 在 composer 下
 *  （助手 chips 选择条 + 选中助手的预设 prompts / 示例卡 + 最近任务）。
 *  点 chip **只写选择态** chat.welcomeAssistantId，不建会话——会话在发送首条消息时
 *  按选择创建（ChatView send 消费）；再点同一 chip 取消选择。
 *  绑定态（活动会话带 assistantId）：hero 换助手身份、below 显示其 prompts。 */
import { computed } from 'vue';
import { useChat } from '../stores/chat';
import { fmtRelative } from '../lib/time/relative';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{ part?: 'hero' | 'below' }>(), { part: 'hero' });
const chat = useChat();
const emit = defineEmits<{ (e: 'fill', text: string): void }>();

interface Example { icon: string; title: string; text: string }
const EXAMPLES: Example[] = [
  { icon: 'book', title: '读代码', text: '帮我读懂这个项目：从入口开始，讲清核心模块和它们的关系' },
  { icon: 'edit', title: '写脚本', text: '写一个 PowerShell 脚本：把 Downloads 里超过 30 天没动过的文件移入 archive 子目录' },
  { icon: 'terminal', title: '跑命令', text: '看一下当前工作区的目录结构，告诉我这个项目怎么跑起来' },
];

interface S { id: string; title: string; updatedAt?: number; assistantId?: string }
function recentThree(): S[] { return chat.sessions.slice(0, 3); }
function rel(s: S): string { return s.updatedAt ? fmtRelative(s.updatedAt, Date.now() / 1000) : ''; }

/** 活动会话绑定的助手；绑定悬空（助手已删）回 undefined → 自动落回未绑态。 */
const boundAssistant = computed(() => {
  const s = chat.sessions.find(x => x.id === chat.activeId) as S | undefined;
  return s?.assistantId ? chat.assistants.find(a => a.id === s.assistantId) : undefined;
});
/** 欢迎屏选择态的助手（未建会话，仅 chips 高亮 + prompts 预览 + 占位符）。 */
const pickedAssistant = computed(() =>
  chat.welcomeAssistantId ? chat.assistants.find(a => a.id === chat.welcomeAssistantId) : undefined);
/** below 部展示 prompts 的来源：绑定态优先，其次选择态。 */
const promptSource = computed(() => boundAssistant.value ?? pickedAssistant.value);

function pickAssistant(id: string): void {
  // 再点同一 chip = 取消选择（回到通用示例卡）；绑定态下 chips 不渲染，无冲突
  chat.welcomeAssistantId = chat.welcomeAssistantId === id ? '' : id;
}
</script>

<template>
  <!-- hero 部：composer 之上，只有问候/身份，一屏重心留给 composer -->
  <div v-if="props.part === 'hero'" class="ehero">
    <template v-if="boundAssistant">
      <h2><span class="aemoji">{{ boundAssistant.avatar }}</span>{{ boundAssistant.name }}</h2>
      <p class="sub">由助手预设驱动——规则、默认技能与模型已按预设配置</p>
    </template>
    <template v-else>
      <!-- I3 hero 问候（AionUi Guid 页「Hi, what's your plan for today?」的中文位） -->
      <h2>你好，今天想做点什么？</h2>
      <p class="sub">{{ pickedAssistant ? `已选 ${pickedAssistant.avatar} ${pickedAssistant.name}——输入即以该预设开始` : '让 DeskMinis 帮你读写文件、执行命令、完成任务' }}</p>
    </template>
  </div>

  <!-- below 部：composer 之下——chips 选择条 → prompts / 示例卡 → 最近任务 -->
  <div v-else class="ebelow">
    <div v-if="chat.assistants.length && !boundAssistant" class="abar" role="group" aria-label="选择助手">
      <div
        v-for="a in chat.assistants" :key="a.id" class="ascard" :class="{ on: chat.welcomeAssistantId === a.id }"
        :title="a.rules.slice(0, 80) || a.name" tabindex="0" role="button" :aria-pressed="chat.welcomeAssistantId === a.id"
        @keydown.enter.prevent="pickAssistant(a.id)" @keydown.space.prevent="pickAssistant(a.id)"
        @click="pickAssistant(a.id)"
      >
        <span class="aavatar">{{ a.avatar || '🤖' }}</span><span class="acname">{{ a.name }}</span>
      </div>
    </div>

    <div v-if="promptSource && promptSource.prompts.length" class="prows">
      <div class="phint">试试这些开场：</div>
      <button
        v-for="(p, i) in promptSource.prompts" :key="i" type="button" class="prow"
        @click="emit('fill', p)"
      >
        <span class="ptext">{{ p }}</span><span class="parrow">↗</span>
      </button>
    </div>

    <div v-if="!promptSource" class="cards">
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
/* hero 部：贴 composer 上方，重心交给 ChatView 的 safe center 整组处理 */
.ehero {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 24px 24px 18px; text-align: center;
}
/* I3：hero 规格对齐 AionUi 欢迎标题（text-2xl/600） */
.ehero h2 { font-size: 26px; font-weight: 600; color: var(--label-emphasis); }
.aemoji { margin-right: 10px; }
.sub { font-size: 15px; color: var(--label-secondary); }

/* below 部：composer 之下整组居中，内容宽对齐 composer 的 792 契约 */
.ebelow {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  width: 100%; max-width: 792px; margin: 0 auto; padding-top: 10px;
}

/* I6 助手 chips 选择条（AionUi Guid 页助手 chips）：胶囊行，选中白底浮起 + 蓝描边 */
.abar {
  display: flex; flex-wrap: wrap; gap: 6px; justify-content: center;
  padding: 6px; border-radius: var(--r-pill); background: var(--fill-tertiary);
}
.ascard {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px;
  border-radius: var(--r-pill); border: 1px solid transparent;
  color: var(--label-secondary); font-size: var(--fs-ui); cursor: pointer; white-space: nowrap;
}
.ascard:hover { background: var(--fill-quaternary); color: var(--label); }
.ascard:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.ascard.on {
  background: var(--surface-1); border-color: var(--accent); color: var(--label);
  box-shadow: 0 2px 8px var(--shadow-color); font-weight: 600;
}
.aavatar { font-size: 15px; line-height: 1; }
.acname { line-height: 1; }

/* 选中/绑定助手的预设 prompts：AionUi 透明文字行 + hover 现箭头 */
.prows { display: flex; flex-direction: column; gap: 2px; width: 100%; max-width: 560px; margin-top: 6px; }
.phint { font-size: var(--fs-micro); color: var(--label-quaternary); padding: 0 2px 4px; text-align: left; }
.prow {
  display: flex; align-items: baseline; gap: 6px; width: 100%; padding: 6px 2px;
  border: none; background: none; cursor: pointer; text-align: left;
  font-size: var(--fs-ui); color: var(--label-secondary); line-height: 1.5;
}
.prow:hover { color: var(--label); }
.prow:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.ptext { min-width: 0; }
.parrow { flex: 0 0 auto; opacity: 0; color: var(--accent); transition: opacity .12s ease-out; }
.prow:hover .parrow, .prow:focus-visible .parrow { opacity: 1; }

/* 示例指令卡：横排三张（窄了自动换行），点击填入输入框（I3 平面卡语言） */
.cards { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; justify-content: center; }
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
.recent { margin-top: 16px; width: 452px; max-width: 100%; }
.rhead { font-size: 12px; font-weight: 600; color: var(--label-tertiary); padding: 0 4px 6px; text-align: left; }
.ritem {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r-control);
  cursor: pointer; color: var(--label-secondary);
}
.ritem:hover { background: var(--fill-quaternary); color: var(--label); }
.ritem:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.rtitle { flex: 1; min-width: 0; font-size: var(--fs-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.rtime { flex: 0 0 auto; font-size: var(--fs-micro); color: var(--label-tertiary); font-variant-numeric: tabular-nums; }
</style>
