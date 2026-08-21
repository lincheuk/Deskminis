<script setup lang="ts">
/** V5：任务面板。「这一轮到底怎么了」的唯一去处。
 *
 *  四类回合状态（降级 / 压缩 / 卸载 / 待批准）平时没人看，出问题时是唯一线索：
 *  比如输出突然变差 → 多半是 fallback 到备选模型了；上下文突然「忘事」→ 是 compacted。
 *  没有这块面板，这些事只在日志里，用户只能感觉「今天它变笨了」。
 *
 *  上下文水位按 chat.contextInfo（后端基于 buildEffectiveHistory 算，不是原始 history 估算）。 */
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useChat } from '../stores/chat';
import UiIcon from './UiIcon.vue';

const chat = useChat();
let timer: ReturnType<typeof setInterval> | null = null;

function poll(): void { if (chat.activeId) void chat.fetchContextInfo(); }
onMounted(() => { poll(); timer = setInterval(poll, 15_000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
// 换会话 / 回合结束都要重算：水位是回合后才变的
watch(() => chat.activeId, poll);
watch(() => chat.running, (now, prev) => { if (prev && !now) poll(); });

const pct = computed(() => {
  const c = chat.contextInfo;
  if (!c || !c.windowTokens) return 0;
  return Math.min(100, Math.round((c.usedTokens / c.windowTokens) * 100));
});
/** 70% 起提醒、90% 起告警——到 100% 才说就晚了，那时压缩已经发生。 */
const tone = computed(() => (pct.value >= 90 ? 'err' : pct.value >= 70 ? 'warn' : 'ok'));
const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** StopReason（src/shared/types.ts 四值）→ 人话。原样显示 'endTurn' 是把内部枚举
 *  漏给用户看——实拍逮到一次（V5）。未知值原样带出，总比空着强。 */
const STOP_TEXT: Record<string, string> = {
  endTurn: '正常结束',
  toolUse: '停在工具调用（还有后续）',
  maxTokens: '达到单轮输出上限——回答可能被截断',
  refusal: '模型拒绝作答',
};
const stopText = computed(() => STOP_TEXT[chat.lastStopReason] ?? chat.lastStopReason);
/** 只有异常终止才值得占一块——「正常结束」写出来是噪音。 */
const showStop = computed(() => chat.lastStopReason !== '' && chat.lastStopReason !== 'endTurn');
</script>

<template>
  <div class="tp">
    <section class="blk">
      <div class="bh t-aux">上下文</div>
      <template v-if="chat.contextInfo">
        <div class="bar"><span class="fill" :class="tone" :style="{ width: `${pct}%` }"></span></div>
        <div class="brow t-aux tnum">
          <span>{{ fmtK(chat.contextInfo.usedTokens) }} / {{ fmtK(chat.contextInfo.windowTokens) }}</span>
          <span :class="tone">{{ pct }}%</span>
        </div>
        <p v-if="pct >= 70" class="hint t-aux" :class="tone">
          {{ pct >= 90 ? '快满了。下一轮很可能触发压缩，早期消息会被摘要替换。' : '过半了。长对话可以考虑新开一个会话，上下文更干净。' }}
        </p>
      </template>
      <p v-else class="hint t-aux">还没有数据（发一轮消息后才有）</p>
    </section>

    <section v-if="chat.pendingPerms.length" class="blk">
      <div class="bh t-aux">等你批准</div>
      <div class="card warn">
        <UiIcon name="shield" :size="15" />
        <span class="t-aux">{{ chat.pendingPerms.length }} 个请求等在对话里——回合正卡在这</span>
      </div>
    </section>

    <section v-if="chat.fallbackState" class="blk">
      <div class="bh t-aux">模型降级</div>
      <div class="card warn">
        <UiIcon name="alert" :size="15" />
        <span class="t-aux">{{ chat.fallbackState.from }} → {{ chat.fallbackState.to }}：{{ chat.fallbackState.reason }}</span>
      </div>
    </section>

    <section v-if="chat.compactedState" class="blk">
      <div class="bh t-aux">上下文已压缩</div>
      <div class="card">
        <UiIcon name="refresh" :size="15" />
        <span class="t-aux">{{ chat.compactedState.summary || '早期消息已被摘要替换' }}</span>
      </div>
    </section>

    <section v-if="chat.offloadedState" class="blk">
      <div class="bh t-aux">大段输出已卸载</div>
      <div class="card">
        <UiIcon name="folder" :size="15" />
        <span class="t-aux">
          {{ chat.offloadedState.count }} 次
          <template v-if="chat.offloadedState.lastRelativePath"> · 最近 {{ chat.offloadedState.lastRelativePath }}</template>
        </span>
      </div>
    </section>

    <section v-if="showStop" class="blk">
      <div class="bh t-aux">上轮结束原因</div>
      <div class="card warn"><UiIcon name="alert" :size="15" /><span class="t-aux">{{ stopText }}</span></div>
    </section>
  </div>
</template>

<style scoped>
.tp { display: flex; flex-direction: column; gap: var(--sp-6); padding: var(--sp-5) var(--sp-4); }
.blk { display: flex; flex-direction: column; gap: var(--sp-2); }
.bh { color: var(--c-ink-3); font-weight: var(--w-md); }

.bar { height: 6px; border-radius: var(--r-pill); background: var(--c-bg-2); overflow: hidden; }
.fill { display: block; height: 100%; border-radius: var(--r-pill); background: var(--c-brand); transition: width .3s ease; }
.fill.warn { background: var(--c-warn); }
.fill.err { background: var(--c-err); }
.brow { display: flex; justify-content: space-between; color: var(--c-ink-3); }
.brow .warn { color: var(--c-warn); }
.brow .err { color: var(--c-err); }
.hint { margin: 0; color: var(--c-ink-3); line-height: 1.6; }
.hint.warn { color: var(--c-warn); }
.hint.err { color: var(--c-err); }

.card {
  display: flex; align-items: flex-start; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4); border-radius: var(--r-s);
  background: var(--c-bg-1); color: var(--c-ink-2);
}
.card.warn { background: var(--c-warn-soft); color: var(--c-warn); }
.card :deep(svg) { flex: 0 0 auto; margin-top: 1px; }
.card span { min-width: 0; word-break: break-word; }
</style>
