<script setup lang="ts">
/** 右栏 · 任务面板（设计 §7）——回合进度 / token 用量 / 上下文水位条。
 *  数据全部来自 chat store（其事实源是 chat.messages.list 与 chat.event 推送，UI 无私有状态）。
 *  过时假设 #7 已修正：水位分母不再写死 200K，改由 chat.contextInfo（按 M2a ContextPolicy 32K/64K/128K/200K 分档 + M2b ModelCatalog 当前会话模型的真实窗口）返回的 windowTokens 计算。
 *  #10 事件 UI 接线：四种未消费事件（fallback/compacted/offloaded/retry）在此面板内联显示。 */
import { computed } from 'vue';
import { useChat } from '../stores/chat';

const chat = useChat();

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

/** （过时假设 #7 修正）水位：优先用 chat.contextInfo；当缓存为空时回退到「lastUsage input+output vs 200K」粗估。 */
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
  watermark.value.pct < 60 ? 'var(--green)' : watermark.value.pct < 85 ? 'var(--orange)' : 'var(--red)');

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

/** #10：四种未消费事件中，fallback / compacted / offloaded 在任务面板显示为彩色状态卡；retry 已用 tnote 呈现。
 *  渲染字段严格对齐 stores/chat.ts 从 loop.ts 真实载荷派生的形状（无 fromCount/toCount/freedTokens/oldestTs 这些不存在项，
 *  缺什么就不渲染——不再用 || '?' 或 ?? 0 把「字段根本不存在」静默成零值问号）。 */
const eventCards = computed(() => {
  const cards: { kind: string; color: string; icon: string; title: string; body: string }[] = [];
  if (chat.fallbackState) {
    const s = chat.fallbackState;
    cards.push({ kind: 'fallback', color: 'var(--orange)', icon: '⚠', title: '模型已降级',
      body: `${s.from} → ${s.to}${s.reason ? `（${s.reason}）` : ''}` });
  }
  if (chat.compactedState) {
    const s = chat.compactedState;
    cards.push({ kind: 'compacted', color: 'var(--info, #0a84ff)', icon: '≣', title: '上下文已压缩',
      body: s.summary }); // summary 已由 loop 截取前 200 字符；不再渲染 fromCount/toCount/freedTokens（loop 事件里没有）
  }
  if (chat.offloadedState) {
    const s = chat.offloadedState;
    const countPart = s.count > 1 ? `（累计 ${s.count} 条）` : '';
    cards.push({ kind: 'offloaded', color: 'var(--purple, #5e5ce6)', icon: '↓', title: '大工具输出已卸载',
      body: s.lastRelativePath ? `${s.lastRelativePath}${countPart}` : `${s.count} 条` });
  }
  return cards;
});

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
</script>

<template>
  <div class="tpanel">
    <div v-if="!chat.activeId" class="thint">先在左栏选择一个会话</div>
    <template v-else>
      <!-- #10 新增：事件 UI 状态卡（4 种未消费事件的呈现 → 3 张彩色卡 + retry 沿用 tnote） -->
      <div v-for="c in eventCards" :key="c.kind" class="tsec event" :style="{ borderLeft: `3px solid ${c.color}` }">
        <div class="thead" :style="{ color: c.color }"><span class="eicon">{{ c.icon }}</span>{{ c.title }}</div>
        <div class="ebody">{{ c.body }}</div>
      </div>
      <div class="tsec">
        <div class="thead">回合</div>
        <div class="trow">
          <span class="tlabel">状态</span>
          <span class="tval"><span class="dot" :class="{ run: chat.running }"></span>{{ chat.running ? '运行中' : '空闲' }}</span>
        </div>
        <div v-if="chat.retryNote" class="tnote">{{ chat.retryNote }}</div>
        <div class="trow">
          <span class="tlabel">工具调用</span>
          <span class="tval">{{ toolStats.total }} 次<template v-if="toolStats.total">（成功 {{ toolStats.ok }} · 失败 {{ toolStats.fail }}<template v-if="toolStats.running"> · 进行中 {{ toolStats.running }}</template>）</template></span>
        </div>
        <div class="trow"><span class="tlabel">停止原因</span><span class="tval">{{ stopLabel }}</span></div>
      </div>
      <div class="tsec">
        <div class="thead">Token 用量</div>
        <div class="trow">
          <span class="tlabel">上回合</span>
          <span class="tval">{{ lastUsage ? `输入 ${fmt(lastUsage.inputTokens)} · 输出 ${fmt(lastUsage.outputTokens)}` : '—' }}</span>
        </div>
        <div class="trow">
          <span class="tlabel">会话累计</span>
          <span class="tval">{{ totals.input || totals.output ? `输入 ${fmt(totals.input)} · 输出 ${fmt(totals.output)}` : '—' }}</span>
        </div>
      </div>
      <div class="tsec">
        <div class="thead">上下文水位<span class="tbadge" :style="{ background: waterColor }">{{ chat.contextInfo ? '实时' : '估算' }}</span></div>
        <div class="wbar"><div class="wfill" :style="{ width: watermark.pct + '%', background: waterColor }"></div></div>
        <div class="wnum">{{ fmt(watermark.used) }} / {{ fmt(watermark.window) }}（{{ watermark.pct }}%）</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tpanel { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.thint { font-size: 12px; color: var(--label-tertiary); padding: 12px; text-align: center; line-height: 1.6; }
.tsec { background: var(--grouped-bg-secondary); border-radius: var(--r-card); padding: 10px 12px; }
.tsec.event { padding-left: 10px; }
.thead { font-size: 12px; font-weight: 600; color: var(--label-secondary); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.eicon { font-weight: 700; }
.ebody { font-size: 12px; color: var(--label); line-height: 1.5; }
.tbadge { margin-left: auto; font-size: 10px; color: white; padding: 1px 6px; border-radius: 999px; }
.trow { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 13px; }
.tlabel { color: var(--label-secondary); flex: 0 0 auto; }
.tval { color: var(--label); display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; text-align: right; }
.tnote { font-size: 12px; color: var(--orange); padding: 2px 0 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex: 0 0 auto; }
.dot.run { background: var(--orange); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.wbar { height: 6px; border-radius: var(--r-pill); background: var(--fill-quaternary); overflow: hidden; }
.wfill { height: 100%; border-radius: var(--r-pill); transition: width .3s ease; }
.wnum { font-size: 11px; color: var(--label-tertiary); padding-top: 6px; font-variant-numeric: tabular-nums; }
</style>
