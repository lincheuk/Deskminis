<script setup lang="ts">
/** 权限确认内联卡 v2（设计 §5.2）——非模态，就地出现在对话流里。
 *  v2 补强：右上 mono 倒计时（≤10s 变橙）、danger/gated 盾牌分色分级文案、
 *  桥七类专属标题、shell 卡桥命令双段告知、主钮「允许」--action 实底、预选 2px --action 边框。
 *  倒计时纯显示：超时判定权在 minisd（permission.resolved 广播 reason），本组件不做 deadline 自判。 */
import { computed, onUnmounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import Icon from './Icon.vue';
import DiffView from './DiffView.vue';
import { permTitle, permTriggerLabel } from '../lib/perm/copy';
import { remainSeconds, countdownTone } from '../lib/perm/countdown';
import { diffLines, countAddDel } from '../lib/diff/lcs';

const props = defineProps<{ perm: { requestId: string; detail: string; kind: string; toolTitle: string; timeoutMs?: number; riskClass?: string; bridgeTriggers?: string[]; deadlineMs?: number; preview?: { oldText: string; newText: string } } }>();
const chat = useChat();

const title = computed(() => permTitle(props.perm.kind));
const keyLabel = computed(() => (props.perm.kind === 'shell' ? '命令' : '路径'));
// 风险分级（审计 H2/X-7）：danger 红盾 +「高风险操作」；gated 及其余 橙盾 +「需要你的批准」
const isDanger = computed(() => props.perm.riskClass === 'danger');
const subtitle = computed(() => (isDanger.value ? '高风险操作' : '需要你的批准'));

// 倒计时读秒：setInterval 1s 驱动 remain；unmount 清定时器
const nowMs = ref(Date.now());
const tick = setInterval(() => { nowMs.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(tick));
const remain = computed(() => remainSeconds(props.perm.deadlineMs ?? nowMs.value, nowMs.value));
const tone = computed(() => countdownTone(remain.value));

// 权限档位（渲染端本地偏好）预选高亮：本会话沿用/完全访问 → 高亮「本会话允许」；每次确认 → 高亮「允许」
const preselect = computed<'allow-once' | 'allow-session'>(() =>
  chat.permTier === 'ask' ? 'allow-once' : 'allow-session',
);

// 审批前变更预览：与 ToolLine 的 file_edit 展开区同款管线（diffLines/countAddDel/DiffView），
// 把执行后才能看到的差分前移到批准时刻——路径行上方已逐字显示路径，差分头不再重复放 path
const previewLines = computed(() => (props.perm.preview ? diffLines(props.perm.preview.oldText, props.perm.preview.newText) : []));
const previewCounts = computed(() => countAddDel(previewLines.value));
</script>

<template>
  <div class="perm">
    <div class="h">
      <span class="shield" :class="{ danger: isDanger }"><Icon name="shield" :size="20" /></span>
      <div class="htext">
        <div class="title">{{ title }}</div>
        <div class="sub">{{ subtitle }}</div>
      </div>
      <span class="countdown" :class="tone">{{ remain }}s</span>
    </div>
    <div class="args">
      <div class="k">{{ keyLabel }}</div>
      <div class="v">{{ perm.detail }}</div>
    </div>
    <!-- 变更预览（仅 file_write/file_edit 请求带 preview）：批准前可见将要写什么，差分体沿 DiffView 的 240px 内滚 -->
    <DiffView v-if="perm.preview" :path="''" :add-count="previewCounts.add" :del-count="previewCounts.del" :lines="previewLines" />
    <!-- 双段告知（审计 H3）：shell 卡识别到桥命令时列出将触发的桥权限，一次批准同时放行 shell 与桥类目 -->
    <div v-if="perm.bridgeTriggers?.length" class="triggers">
      <div class="tk">此命令将触发：</div>
      <div v-for="t in perm.bridgeTriggers" :key="t" class="tv">{{ permTriggerLabel(t) }}</div>
    </div>
    <div class="btns">
      <button class="btn primary" :class="{ pre: preselect === 'allow-once' }" @click="chat.respondPerm(perm.requestId, 'allow-once')">允许</button>
      <button class="btn" :class="{ pre: preselect === 'allow-session' }" @click="chat.respondPerm(perm.requestId, 'allow-session')">本会话允许</button>
      <button class="btn deny" @click="chat.respondPerm(perm.requestId, 'deny')">拒绝</button>
    </div>
  </div>
</template>

<style scoped>
.perm {
  background: var(--surface-1); border: 1px solid var(--separator); border-radius: var(--r-card);
  /* E3（Aurora §4）：浮岛卡 + 左缘 3px accent 警示线——警示线/顶缘高光全走 inset 阴影，
     不占布局零位移（border-left 会把内容右推 3px）；柔影给浮起感。实心材质，不用 blur（§5）。 */
  /* I4：受光边退场，左缘警示线与柔影保留（平面卡语言） */
  box-shadow: inset 3px 0 0 var(--accent), 0 2px 8px var(--shadow-color);
  padding: 12px; display: flex; flex-direction: column; gap: 10px; align-self: stretch;
}
.h { display: flex; align-items: center; gap: 8px; }
.shield { display: inline-flex; color: var(--state-warn); }
.shield.danger { color: var(--state-err); }
.htext { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.title { font-size: 17px; font-weight: var(--fw-strong); color: var(--label-strong); }
.sub { font-size: 12.5px; color: var(--label-secondary); }
/* 右上 mono 读秒；urgent（≤10s）变橙 */
.countdown { font-family: var(--font-mono); font-size: 13px; color: var(--label-secondary); }
.countdown.urgent { color: var(--state-warn); font-weight: var(--fw-medium); }
.args {
  background: var(--surface-2); border-radius: var(--r-md); padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.k { font-size: 13px; font-weight: var(--fw-medium); color: var(--label-secondary); }
/* 逐字完整、可换行、绝不截断 */
.v { font-size: 13px; font-family: var(--font-mono); color: var(--label-intense); word-break: break-all; white-space: pre-wrap; line-height: 1.5; }
.triggers {
  background: var(--state-warn-bg); border: 1px solid var(--state-warn-border); border-radius: var(--r-md);
  padding: 8px 12px; display: flex; flex-direction: column; gap: 4px;
}
.tk { font-size: 12.5px; font-weight: var(--fw-medium); color: var(--state-warn); }
.tv { font-size: 12.5px; color: var(--label); }
.tv::before { content: '· '; color: var(--state-warn); }
/* 窄列折行治理：nowrap 禁止按钮文字折断（「本会话允/许」这种断法比按钮换行难看得多），
   flex-wrap 让放不下的按钮整颗换到下一行；min-width 抬高换行判定基准——flex:1 的
   basis 是 0，没有最小宽约束时三颗按钮永远「挤得下」，wrap 永远不触发。 */
.btns { display: flex; gap: 8px; flex-wrap: wrap; }
.btn {
  flex: 1; min-width: 96px; padding: 10px; border-radius: var(--r-control); border: 1px solid var(--separator);
  background: var(--surface-1); color: var(--label); font-family: var(--font-ui);
  font-size: 15px; font-weight: var(--fw-medium); cursor: pointer; white-space: nowrap;
}
.btn:hover { background: var(--fill-quaternary); }
/* MU3 §2-5 焦点环：允许/会话允许走 --ring；拒绝钮走 --ring-danger */
.btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.btn.deny:focus-visible { outline: 2px solid var(--ring-danger); outline-offset: 1px; }
/* 主钮「允许」：--action 实底（设计 §5.2 按钮序） */
.btn.primary { background: var(--action); border-color: var(--action); color: var(--on-action); }
.btn.primary:hover { background: var(--action); }
/* 预选高亮：2px --action 边框（v1 的 1px 太弱） */
.btn.pre { border: 2px solid var(--action); }
.btn.deny { color: var(--state-err); }
</style>
