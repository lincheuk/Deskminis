<script setup lang="ts">
/** 思考折叠块——推理模型（DeepSeek/Kimi/GLM 经 OpenAI 兼容层、Anthropic/Gemini 原生）
 *  的思考流与正文分开呈现：正文是要「读」的，思考是要「可查」的，混排会把对话流撑成
 *  又臭又长的推理草稿。折叠交互与样式 token 向 ToolLine 看齐（button + aria-expanded
 *  + chevron），文案两态：流式「思考中…」/ 完成「已思考」。
 *  流式收起态额外露最后两行：用户能看到思考还在往前滚（窗口感），又不占正文高度。 */
import { computed, onBeforeUnmount, ref } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  text: string;
  streaming?: boolean;   // 流式态：收起时显示「思考中…」+ 末两行；完成态默认全收起
}>(), { streaming: false });

const open = ref(false);

// 收起态窗口：只取末两条逻辑行。line-clamp 兜视觉行——一条长逻辑行软换行后会
// 占好几行，没有 clamp 的话「窗口」会被一条长行撑破。
const tailLines = computed(() => props.text.trimEnd().split('\n').slice(-2).join('\n'));

/* E3（Aurora §4）「思考 · N 秒」读数：仅流式态有真实起点（挂载≈思考开始）；
   历史回放块 store 未跟踪真实时长，绝不伪造（与 ToolLine 耗时同一纪律）。 */
const elapsedSec = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
if (props.streaming) {
  const startAt = Date.now();
  timer = setInterval(() => { elapsedSec.value = Math.floor((Date.now() - startAt) / 1000); }, 1000);
}
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="tkwrap">
    <button class="tkline" type="button" :aria-expanded="open" @click="open = !open">
      <span class="tklabel">{{ streaming ? '思考中…' : '已思考' }}</span>
      <!-- E3 时长读数（纯展示）：流式态实时秒数，mono 等宽（§4 读数面） -->
      <span v-if="streaming" class="tkdur">{{ elapsedSec }}s</span>
      <span class="tkchev"><Icon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" /></span>
    </button>
    <div v-if="open" class="tktext">{{ text }}</div>
    <div v-else-if="streaming && tailLines" class="tktext tktail">{{ tailLines }}</div>
  </div>
</template>

<style scoped>
/* I4（AionUi 换向）：思考块换浅渐变条——AionUi thought-gradient 的令牌化写法
   （原料全是语义令牌，主题自动分叉；渐变结构非颜色字面量，例 9 零硬编码依然成立）；
   2px 内边距让行内 hover 底色不顶到卡缘 */
.tkwrap {
  display: flex; flex-direction: column; gap: 2px; max-width: 100%; align-self: stretch;
  background: linear-gradient(90deg, var(--secondary-subtle), var(--fill-quaternary));
  border-radius: var(--r-card);
  padding: 2px;
}
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
/* E3：「思考 · N 秒」时长读数走等宽（§4 读数面：耗时一律 mono） */
.tkdur { font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--label-tertiary); flex: 0 0 auto; }
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
