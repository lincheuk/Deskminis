<script setup lang="ts">
/** 右栏 · 进度面板（设计 §4.1，MU2b Task 2：TasksPanel 重做 → ProgressPanel）。
 *  任务句（会话标题亲和呈现）+ 步骤列表（与对话流 ToolLine 同数据、进度叙事呈现）
 *  + Token 两行 + 水位条（contextInfo 沿用）+ 等待批准显著化（pendingPerms>0 → 「去处理」滚动定位权限卡）。
 *  fallback/compacted/offloaded 三状态卡沿用 M2d（圆角卡 + 左 3px 色条；色值换 --state-* 语义槽）。
 *  数据全部来自 chat store（事实源：chat.messages.list 与 chat.event 推送，UI 无私有状态）。 */
import { computed, onUnmounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import { fmtDuration } from '../lib/toolline/duration';

const chat = useChat();

/** 任务句：当前会话标题（无标题会话兜底「未命名任务」）。 */
const taskTitle = computed(() => chat.sessions.find(s => s.id === chat.activeId)?.title || '未命名任务');

/** 最近一条带用量的 assistant 消息的 tokenUsage（倒序找）。 */
const lastUsage = computed(() => {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.role === 'assistant' && m.tokenUsage) return m.tokenUsage;
  }
  return undefined;
});

/** 会话累计（全部 assistant 消息的 input/output 求和）。 */
const totals = computed(() => {
  let input = 0; let output = 0;
  for (const m of chat.messages) {
    if (m.role === 'assistant' && m.tokenUsage) { input += m.tokenUsage.inputTokens; output += m.tokenUsage.outputTokens; }
  }
  return { input, output };
});

/** 水位：优先 chat.contextInfo（M2d #7 修正语义）；缓存空时回退「lastUsage input+output vs 200K」粗估。 */
const watermark = computed(() => {
  if (chat.contextInfo) {
    const { windowTokens, usedTokens } = chat.contextInfo;
    const pct = windowTokens > 0 ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : 0;
    return { used: usedTokens, window: windowTokens, pct };
  }
  const used = (lastUsage.value?.inputTokens ?? 0) + (lastUsage.value?.outputTokens ?? 0);
  return { used, window: 200_000, pct: Math.min(100, Math.round((used / 200_000) * 100)) };
});
const waterColor = computed(() =>
  watermark.value.pct < 60 ? 'var(--state-ok)' : watermark.value.pct < 85 ? 'var(--state-warn)' : 'var(--state-err)');

const toolStats = computed(() => {
  const done = chat.toolCards.filter(c => c.success !== undefined);
  const ok = done.filter(c => c.success).length;
  return { total: chat.toolCards.length, ok, fail: done.length - ok, running: chat.toolCards.length - done.length };
});

const STOP_LABEL: Record<string, string> = {
  endTurn: '正常结束', maxTokens: '达到输出上限', refusal: '模型拒绝', toolUse: '中断于工具调用',
  compact: '中断于上下文压缩（M2a）', offload: '中断于历史卸载（M2a）', fallback: '中断于模型降级（M2b）',
};
const stopLabel = computed(() => STOP_LABEL[chat.lastStopReason] ?? (chat.lastStopReason || '—'));

/** 事件三卡（M2d #10 平移）：渲染字段严格对齐 chat store 从 loop.ts 真实载荷派生的形状；色值换 --state-* 槽。 */
const eventCards = computed(() => {
  const cards: { kind: string; color: string; icon: string; title: string; body: string }[] = [];
  if (chat.fallbackState) {
    const s = chat.fallbackState;
    cards.push({ kind: 'fallback', color: 'var(--state-warn)', icon: '⚠', title: '模型已降级',
      body: `${s.from} → ${s.to}${s.reason ? `（${s.reason}）` : ''}` });
  }
  if (chat.compactedState) {
    const s = chat.compactedState;
    cards.push({ kind: 'compacted', color: 'var(--state-info)', icon: '≣', title: '上下文已压缩',
      body: s.summary });
  }
  if (chat.offloadedState) {
    const s = chat.offloadedState;
    const countPart = s.count > 1 ? `（累计 ${s.count} 条）` : '';
    cards.push({ kind: 'offloaded', color: 'var(--state-info)', icon: '↓', title: '大工具输出已卸载',
      body: s.lastRelativePath ? `${s.lastRelativePath}${countPart}` : `${s.count} 条` });
  }
  return cards;
});

// 进行中步骤的实时 duration：1s tick（与 PermissionCard 倒计时同款模式；组件卸载即清）
const nowMs = ref(Date.now());
const tick = setInterval(() => { nowMs.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(tick));

function stepDuration(c: { startedAt?: number; endedAt?: number }): string {
  if (!c.startedAt) return '';
  return fmtDuration(c.startedAt, c.endedAt ?? nowMs.value);
}
function stepSymbol(c: { success?: boolean }): string {
  return c.success === undefined ? '●' : c.success ? '✓' : '✕';
}
function stepClass(c: { success?: boolean }): string {
  return c.success === undefined ? 'run' : c.success ? 'ok' : 'fail';
}

/** 等待批准显著化：「去处理」写入目标 requestId，ChatView watch 后 scrollIntoView 定位并清空。 */
function focusPerm(requestId: string): void {
  chat.permFocusRequestId = requestId;
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
</script>

<template>
  <div class="ppanel">
    <div v-if="!chat.activeId" class="phint">先在左栏选择一个会话</div>
    <template v-else>
      <div class="ptask">{{ taskTitle }}</div>

      <!-- 等待批准显著化（审计 H4）：tab 橙点（App.vue dot-warn）+ 卡内去处理 -->
      <div v-if="chat.pendingPerms.length > 0" class="psec pending">
        <div class="pending-row">
          <span class="pending-text">⏸ 等待批准 — {{ chat.pendingPerms[0].toolTitle || chat.pendingPerms[0].kind }}</span>
          <button class="gobtn" @click="focusPerm(chat.pendingPerms[0].requestId)">去处理</button>
        </div>
      </div>

      <!-- 事件三卡（M2d #10 沿用，换皮肤不换语义） -->
      <div v-for="c in eventCards" :key="c.kind" class="psec event" :style="{ borderLeft: `3px solid ${c.color}` }">
        <div class="phead" :style="{ color: c.color }"><span class="eicon">{{ c.icon }}</span>{{ c.title }}</div>
        <div class="ebody">{{ c.body }}</div>
      </div>

      <!-- 步骤列表（与对话流 ToolLine 同数据 toolCards，进度叙事呈现） -->
      <div class="psec">
        <div class="phead">步骤</div>
        <div v-if="!chat.toolCards.length" class="pempty">本回合还没有工具调用</div>
        <div v-for="c in chat.toolCards" :key="c.toolUseId" class="step">
          <span class="sicon" :class="stepClass(c)">{{ stepSymbol(c) }}</span>
          <span class="stitle">{{ c.title || c.name }}</span>
          <span class="sdur">{{ stepDuration(c) }}</span>
        </div>
      </div>

      <div class="psec">
        <div class="phead">回合</div>
        <div class="prow">
          <span class="plabel">状态</span>
          <span class="pval"><span class="dot" :class="{ run: chat.running }"></span>{{ chat.running ? '运行中' : '空闲' }}</span>
        </div>
        <div v-if="chat.retryNote" class="pnote">{{ chat.retryNote }}</div>
        <div class="prow">
          <span class="plabel">工具调用</span>
          <span class="pval">{{ toolStats.total }} 次<template v-if="toolStats.total">（成功 {{ toolStats.ok }} · 失败 {{ toolStats.fail }}<template v-if="toolStats.running"> · 进行中 {{ toolStats.running }}</template>）</template></span>
        </div>
        <div class="prow"><span class="plabel">停止原因</span><span class="pval">{{ stopLabel }}</span></div>
      </div>

      <div class="psec">
        <div class="phead">Token 用量</div>
        <div class="prow">
          <span class="plabel">上回合</span>
          <span class="pval">{{ lastUsage ? `输入 ${fmt(lastUsage.inputTokens)} · 输出 ${fmt(lastUsage.outputTokens)}` : '—' }}</span>
        </div>
        <div class="prow">
          <span class="plabel">会话累计</span>
          <span class="pval">{{ totals.input || totals.output ? `输入 ${fmt(totals.input)} · 输出 ${fmt(totals.output)}` : '—' }}</span>
        </div>
      </div>

      <div class="psec">
        <div class="phead">上下文水位<span class="pbadge" :style="{ background: waterColor }">{{ chat.contextInfo ? '实时' : '估算' }}</span></div>
        <div class="wbar"><div class="wfill" :style="{ width: watermark.pct + '%', background: waterColor }"></div></div>
        <div class="wnum">{{ fmt(watermark.used) }} / {{ fmt(watermark.window) }}（{{ watermark.pct }}%）</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ppanel { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.phint { font-size: var(--fs-caption); color: var(--label-tertiary); padding: 12px; text-align: center; line-height: 1.6; }
.ptask { font-size: var(--fs-title); font-weight: 600; color: var(--label-strong); padding: 2px 4px; line-height: 1.4; }
.psec { background: var(--surface-1); border-radius: var(--r-card); padding: 10px 12px; }
.psec.pending { border-left: 3px solid var(--state-warn); }
.pending-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pending-text { font-size: var(--fs-ui); color: var(--label); line-height: 1.5; }
.gobtn {
  flex: 0 0 auto; border: none; border-radius: var(--r-control); padding: 4px 10px; cursor: pointer;
  background: var(--action); color: var(--on-action); font-size: var(--fs-caption); font-weight: 600;
}
.phead { font-size: var(--fs-caption); font-weight: 600; color: var(--label-secondary); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.eicon { font-weight: 700; }
.ebody { font-size: var(--fs-caption); color: var(--label); line-height: 1.5; }
.pempty { font-size: var(--fs-caption); color: var(--label-tertiary); padding: 2px 0 4px; }
.step { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: var(--fs-ui); }
.sicon { flex: 0 0 auto; width: 16px; text-align: center; font-size: var(--fs-caption); }
.sicon.ok { color: var(--state-ok); }
.sicon.fail { color: var(--state-err); }
.sicon.run { color: var(--state-warn); animation: pulse 1.2s ease-in-out infinite; }
.stitle { flex: 1; min-width: 0; color: var(--label); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sdur { flex: 0 0 auto; color: var(--label-tertiary); font-family: var(--font-mono); font-size: var(--fs-mono); font-variant-numeric: tabular-nums; }
.pbadge { margin-left: auto; font-size: 10px; color: var(--on-action); padding: 1px 6px; border-radius: 999px; }
.prow { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: var(--fs-ui); }
.plabel { color: var(--label-secondary); flex: 0 0 auto; }
.pval { color: var(--label-strong); display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; text-align: right; }
.pnote { font-size: var(--fs-caption); color: var(--state-warn); padding: 2px 0 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--state-ok); flex: 0 0 auto; }
.dot.run { background: var(--state-warn); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.wbar { height: 6px; border-radius: var(--r-pill); background: var(--fill-quaternary); overflow: hidden; }
.wfill { height: 100%; border-radius: var(--r-pill); transition: width .3s ease; }
.wnum { font-size: var(--fs-micro); color: var(--label-tertiary); padding-top: 6px; font-variant-numeric: tabular-nums; }
</style>
