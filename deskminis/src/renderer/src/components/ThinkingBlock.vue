<script setup lang="ts">
/** 思考折叠块——推理模型（DeepSeek/Kimi/GLM 经 OpenAI 兼容层、Anthropic/Gemini 原生）
 *  的思考流与正文分开呈现：正文是要「读」的，思考是要「可查」的，混排会把对话流撑成
 *  又臭又长的推理草稿。折叠交互与样式 token 向 ToolLine 看齐（button + aria-expanded
 *  + chevron），文案两态：流式「思考中…」/ 完成「已思考」。
 *  流式收起态额外露最后两行：用户能看到思考还在往前滚（窗口感），又不占正文高度。 */
import { computed, ref } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  text: string;
  streaming?: boolean;   // 流式态：收起时显示「思考中…」+ 末两行；完成态默认全收起
}>(), { streaming: false });

const open = ref(false);

// 收起态窗口：只取末两条逻辑行。line-clamp 兜视觉行——一条长逻辑行软换行后会
// 占好几行，没有 clamp 的话「窗口」会被一条长行撑破。
const tailLines = computed(() => props.text.trimEnd().split('\n').slice(-2).join('\n'));
</script>

<template>
  <div class="tkwrap">
    <button class="tkline" type="button" :aria-expanded="open" @click="open = !open">
      <span class="tklabel">{{ streaming ? '思考中…' : '已思考' }}</span>
      <span class="tkchev"><Icon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" /></span>
    </button>
    <div v-if="open" class="tktext">{{ text }}</div>
    <div v-else-if="streaming && tailLines" class="tktext tktail">{{ tailLines }}</div>
  </div>
</template>

<style scoped>
.tkwrap { display: flex; flex-direction: column; gap: 2px; max-width: 100%; align-self: stretch; }
.tkline {
  display: flex; align-items: center; gap: 8px; height: var(--h-control); padding: 0 8px;
  background: none; border: none; border-radius: var(--r-control); cursor: pointer;
  font-family: var(--font-ui); font-size: var(--fs-micro); color: var(--label-secondary);
  text-align: left; width: 100%;
}
.tkline:hover { background: var(--fill-quaternary); }
/* MU3 §2-5 焦点环（与 ToolLine 同规） */
.tkline:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.tklabel { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tkchev { display: inline-flex; color: var(--label-tertiary); flex: 0 0 auto; }
/* 思考文本一律次级色 + micro 字号：与正文（--fs-body / --label）拉开层级，
   扫读时一眼跳过，想看时展开即读 */
.tktext {
  margin: 0 8px 4px; font-size: var(--fs-micro); line-height: 1.6; color: var(--label-secondary);
  white-space: pre-wrap; word-break: break-word;
}
.tktail {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
</style>
