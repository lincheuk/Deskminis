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
import { permsOf } from '../lib/perm/scope';
import {
  MISSING_USAGE_TEXT, barOf, breakdownOf, costText, estimateNoteOf, lastRequestOf, limitNoteOf, outputNoteOf, truncationText, usageLine,
} from '../lib/budget/format';
import { compactionLines, recoveryLines, recoveryShort } from '../lib/recovery/format';
import UiIcon from './UiIcon.vue';

const chat = useChat();
/** F03：「上下文已压缩」卡多出的两行（覆盖与触发、保留项计数）；没有摘录（旧引擎、旧压缩记录）时为空。 */
const compactionNotes = computed(() => (chat.compactionDetail ? compactionLines(chat.compactionDetail) : []));
let timer: ReturnType<typeof setInterval> | null = null;
/** W2b-2：只数当前会话的卡。卡按会话分开渲染以后，数全局的就是替别的会话报数——
 *  「N 个请求等在对话里」，对话里却一张卡也没有。 */
const permsHere = computed(() => permsOf(chat.pendingPerms, chat.activeId));

function poll(): void { if (chat.activeId) void chat.fetchContextInfo(); }
onMounted(() => { poll(); timer = setInterval(poll, 15_000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
// 换会话 / 回合结束都要重算：水位是回合后才变的
watch(() => chat.activeId, poll);
watch(() => chat.running, (now, prev) => { if (prev && !now) poll(); });

/** F02：条的分母是输入上限（共享窗口叫「上下文窗口」，独立上限叫「输入上限」），分子是完整请求的估计——
 *  系统提示、工具定义、回放推理、图片都在内。旧版本引擎不给预算时退回「历史估计 / 窗口」。 */
const bar = computed(() => (chat.contextInfo ? barOf(chat.contextInfo) : null));
const pct = computed(() => bar.value?.pct ?? 0);
const budget = computed(() => chat.contextInfo?.budget ?? null);
/** 输入分项（数值为 0 的行不出）。 */
const breakdown = computed(() => (budget.value ? breakdownOf(budget.value) : []));
/** 余量不足（tight / over）时引擎给的中文原因；blocked 走错误条，不在这里重复。 */
const budgetWarning = computed(() => {
  const b = budget.value;
  return b && (b.status === 'tight' || b.status === 'over') && b.reason ? b.reason : '';
});
/** 「上次请求」：当前会话最后一条 assistant 消息的用量与费用（不回溯到更早的消息）。 */
const lastRequest = computed(() => lastRequestOf(chat.messages));
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
/** F02：被 max_tokens 截断时说清那次的 max_tokens 是多少、为什么是这个数、续写了几次、出路是什么。 */
const truncation = computed(() => (chat.lastStopReason === 'maxTokens' ? truncationText(chat.lastOutputLimit) : ''));
</script>

<template>
  <div class="tp">
    <section class="blk">
      <div class="bh t-aux">上下文</div>
      <template v-if="chat.contextInfo && bar">
        <div class="bar"><span class="fill" :class="tone" :style="{ width: `${pct}%` }"></span></div>
        <div class="brow t-aux tnum">
          <span>{{ fmtK(bar.used) }} / {{ fmtK(bar.limit) }} · {{ bar.limitLabel }}</span>
          <span :class="tone">{{ pct }}%</span>
        </div>
        <p v-if="pct >= 70" class="hint t-aux" :class="tone">
          {{ pct >= 90 ? '快满了。下一轮很可能触发压缩，早期消息会被摘要替换。' : '过半了。长对话可以考虑新开一个会话，上下文更干净。' }}
        </p>
        <!-- F02：这些数字怎么来的——约束形态、本次 max_tokens、是不是校准过的、输入各占多少 -->
        <template v-if="budget">
          <p v-if="budgetWarning" class="hint t-aux warn" data-budget="warning">{{ budgetWarning }}</p>
          <p class="hint t-aux" data-budget="limits">{{ limitNoteOf(budget.limits) }}</p>
          <p class="hint t-aux" data-budget="output">{{ outputNoteOf(budget.output) }}</p>
          <p class="hint t-aux" data-budget="estimate">{{ estimateNoteOf(budget) }}{{ chat.contextInfo.live ? '' : '（按下一次请求推算）' }}</p>
          <details v-if="breakdown.length" class="bd t-aux">
            <summary>输入分项</summary>
            <ul>
              <li v-for="row in breakdown" :key="row.key" class="tnum"><span>{{ row.label }}</span><span>{{ row.tokens.toLocaleString('en-US') }}</span></li>
            </ul>
          </details>
        </template>
      </template>
      <p v-else class="hint t-aux">还没有数据（发一轮消息后才有）</p>
    </section>

    <!-- F02：上次请求的用量与费用。费用只在价格与计费规则确定时估算，其余写「未知」并带原因 -->
    <section v-if="lastRequest.state !== 'none'" class="blk" data-budget="last-request">
      <div class="bh t-aux">上次请求</div>
      <div class="card">
        <UiIcon name="clock" :size="15" />
        <span v-if="lastRequest.state === 'usage'" class="t-aux tnum">
          {{ usageLine(lastRequest.view) }}<br />{{ costText(lastRequest.view.cost) }}
        </span>
        <span v-else class="t-aux">
          {{ MISSING_USAGE_TEXT }}<br />{{ costText({ status: 'unknown', reason: 'no-usage' }) }}
        </span>
      </div>
    </section>

    <section v-if="permsHere.length" class="blk">
      <div class="bh t-aux">等你批准</div>
      <div class="card warn">
        <UiIcon name="shield" :size="15" />
        <span class="t-aux">{{ permsHere.length }} 个请求等在对话里——回合正卡在这</span>
      </div>
    </section>

    <section v-if="chat.fallbackState" class="blk">
      <div class="bh t-aux">模型降级</div>
      <div class="card warn">
        <UiIcon name="alert" :size="15" />
        <span class="t-aux">{{ chat.fallbackState.from }} → {{ chat.fallbackState.to }}：{{ chat.fallbackState.reason }}</span>
      </div>
    </section>

    <!-- F03：本次运行里刚压缩过（compacted 事件，带摘要开头），或这个会话的库里有压缩记录（chat.contextInfo 带回的摘录——
         重开会话、重启之后没有事件，也要看得到「这段对话压缩过、覆盖了多少条、保留了什么」） -->
    <section v-if="chat.compactedState || chat.compactionDetail" class="blk" data-compaction="card">
      <div class="bh t-aux">上下文已压缩</div>
      <div class="card">
        <UiIcon name="refresh" :size="15" />
        <span class="t-aux">{{ chat.compactedState?.summary || '早期消息已被摘要替换' }}</span>
      </div>
      <!-- F03：这条压缩记录覆盖了多少条、因何触发、保留了什么（引擎给的摘录；旧记录没有这些，不显示） -->
      <p v-for="(line, i) in compactionNotes" :key="i" class="hint t-aux" data-compaction="line">{{ line }}</p>
    </section>

    <!-- F03：最近一次同模型超窗恢复——被拒的那次、做了哪几步、重发的那次、结果 -->
    <section v-if="chat.contextRecoveryState" class="blk" data-recovery="card">
      <div class="bh t-aux">上下文恢复</div>
      <div class="card">
        <UiIcon name="refresh" :size="15" />
        <span class="t-aux" data-recovery="short">{{ recoveryShort(chat.contextRecoveryState) }}</span>
      </div>
      <p v-for="(line, i) in recoveryLines(chat.contextRecoveryState)" :key="i" class="hint t-aux" data-recovery="line">{{ line }}</p>
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
      <div class="card warn">
        <UiIcon name="alert" :size="15" />
        <span class="t-aux">{{ stopText }}<template v-if="truncation"><br />{{ truncation }}</template></span>
      </div>
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
.bd { color: var(--c-ink-3); }
.bd summary { cursor: pointer; }
.bd ul { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.bd li { display: flex; justify-content: space-between; gap: var(--sp-3); }
.bd li span:first-child { min-width: 0; word-break: break-word; }

.card {
  display: flex; align-items: flex-start; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4); border-radius: var(--r-s);
  background: var(--c-bg-1); color: var(--c-ink-2);
}
.card.warn { background: var(--c-warn-soft); color: var(--c-warn); }
.card :deep(svg) { flex: 0 0 auto; margin-top: 1px; }
.card span { min-width: 0; word-break: break-word; }
</style>
