<script setup lang="ts">
/** T 波：欢迎视图（设计稿 §3）。次序 = hero → 输入卡 → 助手网格 → 最近会话。
 *  助手是**卡片网格**（AionUi assistantCard：32 圆头像 + 名 + 描述，三列），
 *  不再是旧版那条挤在一起的 chips——助手是要读描述才选得动的东西。
 *  点卡只写选择态，会话在发送首条消息时才建（选中再输入流）。 */
import { computed, ref } from 'vue';
import { useChat } from '../stores/chat';
import { fmtRelative } from '../lib/time/relative';
import Composer from './Composer.vue';
import ModelBar from './ModelBar.vue';
import UiIcon from './UiIcon.vue';

const chat = useChat();
const emit = defineEmits<{ (e: 'view', v: 'settings'): void }>();
const composer = ref<InstanceType<typeof Composer> | null>(null);

const picked = computed(() => chat.assistants.find(a => a.id === chat.welcomeAssistantId));
const recent = computed(() => chat.sessions.slice(0, 4));
const nowSec = Math.floor(Date.now() / 1000);

function pick(id: string): void {
  chat.welcomeAssistantId = chat.welcomeAssistantId === id ? '' : id;
  composer.value?.focus();
}
function useSample(t: string): void { composer.value?.fill(t); }

/** 助手图标底色：由 id 派生稳定色相。原图每张助手卡的图标底色都不同——
 *  满屏单色图标是界面显闷的主因之一，彩色点缀才有生气。 */
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
function avaStyle(id: string): Record<string, string> {
  const h = hueOf(id);
  return { background: `oklch(0.93 0.07 ${h})`, color: `oklch(0.45 0.14 ${h})` };
}

const SAMPLES = [
  '帮我读懂这个项目：从入口开始，讲清核心模块和它们的关系',
  '看一下当前工作区的目录结构，告诉我这个项目怎么跑起来',
  '把这个文件夹里的文件按类型整理进子目录，整理前先给我方案',
];
</script>

<template>
  <div class="scroll">
    <div class="col">
      <header class="hero">
        <h1 class="t-hero">你好，今天想做点什么？</h1>
        <p class="t-body sub">
          {{ picked ? `已选 ${picked.avatar} ${picked.name}——直接输入即以该预设开始` : '让 DeskMinis 帮你读写文件、执行命令、完成任务' }}
        </p>
      </header>

      <ModelBar @manage="emit('view', 'settings')" />
      <Composer ref="composer" variant="hero" />

      <section v-if="chat.assistants.length" class="block">
        <div class="bhead t-aux">选一个助手开始任务</div>
        <div class="grid">
          <button
            v-for="a in chat.assistants" :key="a.id" type="button"
            class="acard" :class="{ on: chat.welcomeAssistantId === a.id }"
            :aria-pressed="chat.welcomeAssistantId === a.id" @click="pick(a.id)"
          >
            <span class="ava" :style="avaStyle(a.id)">{{ a.avatar || '🤖' }}</span>
            <span class="atxt">
              <span class="aname">{{ a.name }}</span>
              <span class="adesc">{{ a.rules.slice(0, 40) || '没有额外规则' }}</span>
            </span>
          </button>
        </div>
      </section>

      <section v-if="picked && picked.prompts.length" class="block">
        <div class="bhead t-aux">试试这些开场</div>
        <button v-for="(p, i) in picked.prompts" :key="i" type="button" class="prow" @click="useSample(p)">
          <span class="ptext">{{ p }}</span>
          <UiIcon name="chevronRight" :size="14" />
        </button>
      </section>

      <section v-else class="block">
        <div class="bhead t-aux">试试这些开场</div>
        <button v-for="(p, i) in SAMPLES" :key="i" type="button" class="prow" @click="useSample(p)">
          <span class="ptext">{{ p }}</span>
          <UiIcon name="chevronRight" :size="14" />
        </button>
      </section>

      <section v-if="recent.length" class="block">
        <div class="bhead t-aux">最近</div>
        <button v-for="s in recent" :key="s.id" type="button" class="rrow" @click="chat.open(s.id)">
          <UiIcon name="chat" :size="15" />
          <span class="rtitle">{{ s.title || '新会话' }}</span>
          <span class="rtime t-aux tnum">{{ s.updatedAt ? fmtRelative(s.updatedAt, nowSec) : '' }}</span>
        </button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.scroll { flex: 1; min-height: 0; overflow-y: auto; }
/* 定宽居中：内容不撑满列宽——长行难读是旧 UI 的通病 */
.col {
  width: min(var(--w-stage), 100% - var(--sp-8) * 2);
  margin: 0 auto; padding: 8vh 0 var(--sp-8);
  display: flex; flex-direction: column; gap: var(--sp-7);
}

.hero { text-align: center; display: flex; flex-direction: column; gap: var(--sp-2); }
.hero h1 { margin: 0; color: var(--c-ink); }
.sub { margin: 0; color: var(--c-ink-2); }

.block { display: flex; flex-direction: column; gap: var(--sp-2); }
.bhead { color: var(--c-ink-3); padding: 0 var(--sp-1); text-align: center; }

.grid {
  /* 原图：助手卡**直接铺在舞台上**，没有整块托底——托底是上面那条工具条的语言，
     两处都铺会把版面压成两坨。 */
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4);
}
@media (max-width: 700px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.acard {
  display: flex; align-items: center; gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5); text-align: left; cursor: pointer;
  background: var(--c-bg); border: 1px solid var(--c-line); border-radius: 12px;
  font-family: inherit; transition: border-color .15s ease, box-shadow .15s ease;
}
.acard:hover { border-color: var(--c-brand-line); box-shadow: 0 2px 10px var(--c-aou-soft); }
.acard.on { border-color: var(--c-brand); background: var(--c-brand-soft); }
.ava {
  /* 原图是**圆角方块**图标底（不是圆头像），底色各卡不同 */
  width: 34px; height: 34px; flex: 0 0 auto; border-radius: 9px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 17px; line-height: 1;
}
.atxt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.aname { font-size: var(--t-item-size); line-height: var(--t-item-lh); font-weight: var(--w-md); color: var(--c-ink); }
.adesc {
  font-size: var(--t-aux-size); line-height: var(--t-aux-lh); color: var(--c-ink-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.prow, .rrow {
  display: flex; align-items: center; gap: var(--sp-3); width: 100%;
  /* 行内 padding 收到 8/12：40px 行高的列表项散得像目录，这里要的是「一眼扫完三条」 */
  padding: var(--sp-3) var(--sp-5); border-radius: var(--r-s);
  background: none; color: var(--c-ink-2); cursor: pointer; text-align: left;
  font-size: var(--t-item-size); line-height: var(--t-item-lh); font-family: inherit;
}
.prow:hover, .rrow:hover { background: var(--c-bg-1); color: var(--c-ink); }
.prow :deep(svg), .rrow :deep(svg) { color: var(--c-ink-4); flex: 0 0 auto; }
.ptext, .rtitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rtime { flex: 0 0 auto; color: var(--c-ink-3); }
</style>
