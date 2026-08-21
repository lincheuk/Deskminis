<script setup lang="ts">
/** V1：权限确认卡（非模态，就地出现在对话流里）。
 *
 *  **这是 T 波换壳时漏掉的最严重一块**：默认档位就是「每次确认」，
 *  没有这张卡，agent 一请求权限就无声卡死到超时——界面看着在跑，其实永远没有下文。
 *
 *  三条不能动的规矩（沿旧卡，逐条有来由）：
 *  ① 路径/命令**逐字完整**、可换行、绝不省略号截断——看不全就没法判断该不该批准，
 *     那这张卡就白出了；
 *  ② 倒计时**纯显示**：超时判定权在 minisd（它广播 permission.resolved(reason=timeout)），
 *     组件自判会与后端广播打架；
 *  ③ shell 卡遇到桥命令要**双段告知**：一次批准同时放行 shell 与桥类目，
 *     不说清楚就是静默扩权。 */
import { computed, onUnmounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import { permTitle, permTriggerLabel } from '../lib/perm/copy';
import { remainSeconds, countdownTone } from '../lib/perm/countdown';
import { diffLines, countAddDel } from '../lib/diff/lcs';
import UiDiff from './UiDiff.vue';
import UiIcon from './UiIcon.vue';

const props = defineProps<{
  perm: {
    requestId: string; detail: string; kind: string; toolTitle: string;
    timeoutMs?: number; riskClass?: string; bridgeTriggers?: string[]; deadlineMs?: number;
    preview?: { oldText: string; newText: string };
  };
}>();
const chat = useChat();

const title = computed(() => permTitle(props.perm.kind));
const keyLabel = computed(() => (props.perm.kind === 'shell' ? '命令' : '路径'));
const isDanger = computed(() => props.perm.riskClass === 'danger');

const nowMs = ref(Date.now());
const tick = setInterval(() => { nowMs.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(tick));
const remain = computed(() => remainSeconds(props.perm.deadlineMs ?? nowMs.value, nowMs.value));
const tone = computed(() => countdownTone(remain.value));

/** 档位预选：每次确认 → 高亮「允许」；沿用/完全 → 高亮「本会话允许」。 */
const preselect = computed<'allow-once' | 'allow-session'>(() =>
  chat.permTier === 'ask' ? 'allow-once' : 'allow-session');

const lines = computed(() => (props.perm.preview ? diffLines(props.perm.preview.oldText, props.perm.preview.newText) : []));
const counts = computed(() => countAddDel(lines.value));
</script>

<template>
  <div class="perm" :class="{ danger: isDanger }">
    <header class="h">
      <span class="shield" :class="{ danger: isDanger }"><UiIcon name="shield" :size="18" /></span>
      <span class="htext">
        <span class="title">{{ title }}</span>
        <span class="sub t-aux">{{ isDanger ? '高风险操作' : '需要你的批准' }}</span>
      </span>
      <span class="cd tnum t-aux" :class="tone">{{ remain }}s</span>
    </header>

    <div v-if="perm.toolTitle" class="why t-aux">{{ perm.toolTitle }}</div>

    <div class="args">
      <div class="k t-aux">{{ keyLabel }}</div>
      <div class="v">{{ perm.detail }}</div>
    </div>

    <UiDiff v-if="perm.preview" :lines="lines" :add-count="counts.add" :del-count="counts.del" />

    <div v-if="perm.bridgeTriggers?.length" class="trig">
      <div class="tk t-aux">此命令将触发：</div>
      <div v-for="t in perm.bridgeTriggers" :key="t" class="tv t-aux">{{ permTriggerLabel(t) }}</div>
    </div>

    <div class="btns">
      <button class="pb primary" :class="{ pre: preselect === 'allow-once' }" type="button"
              @click="chat.respondPerm(perm.requestId, 'allow-once')">允许</button>
      <button class="pb" :class="{ pre: preselect === 'allow-session' }" type="button"
              @click="chat.respondPerm(perm.requestId, 'allow-session')">本会话允许</button>
      <button class="pb deny" type="button" @click="chat.respondPerm(perm.requestId, 'deny')">拒绝</button>
    </div>
  </div>
</template>

<style scoped>
.perm {
  display: flex; flex-direction: column; gap: var(--sp-4);
  padding: var(--sp-5); background: var(--c-bg);
  border: 1px solid var(--c-line); border-radius: var(--r-m);
  /* 左缘警示线走 inset 阴影：border-left 会把内容右推 3px，零位移才不抖 */
  box-shadow: inset 3px 0 0 var(--c-warn), var(--sh-pop);
}
.perm.danger { box-shadow: inset 3px 0 0 var(--c-err), var(--sh-pop); }

.h { display: flex; align-items: center; gap: var(--sp-3); }
.shield { display: inline-flex; color: var(--c-warn); flex: 0 0 auto; }
.shield.danger { color: var(--c-err); }
.htext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.title { font-size: var(--t-h2-size); line-height: var(--t-h2-lh); font-weight: var(--w-bd); color: var(--c-ink); }
.sub { color: var(--c-ink-3); }
.cd { flex: 0 0 auto; font-family: var(--f-mono); color: var(--c-ink-3); }
.cd.urgent { color: var(--c-warn); font-weight: var(--w-md); }
.cd.danger { color: var(--c-err); font-weight: var(--w-md); }

.why { color: var(--c-ink-2); }

.args {
  display: flex; flex-direction: column; gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-4); background: var(--c-bg-1); border-radius: var(--r-s);
}
.k { color: var(--c-ink-3); font-weight: var(--w-md); }
/* 逐字完整、可换行、绝不截断：看不全就没法判断该不该批准 */
.v {
  font-family: var(--f-mono); font-size: var(--t-code-size); line-height: 1.55;
  color: var(--c-ink); word-break: break-all; white-space: pre-wrap;
}

.trig {
  display: flex; flex-direction: column; gap: 2px;
  padding: var(--sp-3) var(--sp-4); border-radius: var(--r-s);
  background: var(--c-warn-soft);
}
.tk { color: var(--c-warn); font-weight: var(--w-md); }
.tv { color: var(--c-ink-2); }
.tv::before { content: '· '; color: var(--c-warn); }

.btns { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
.pb {
  height: var(--h-field); padding: 0 var(--sp-6); min-width: 92px; cursor: pointer;
  border-radius: var(--r-s); font-family: inherit;
  font-size: var(--t-item-size); font-weight: var(--w-md);
  background: var(--c-bg-2); color: var(--c-ink);
}
.pb:hover { background: var(--c-bg-3); }
.pb.primary { background: var(--c-brand); color: var(--c-brand-ink); }
.pb.primary:hover { filter: brightness(1.08); }
.pb.deny { background: none; color: var(--c-err); }
.pb.deny:hover { background: var(--c-err-soft); }
/* 档位预选：不替用户按，只把「按这里多半对」标出来 */
.pb.pre { box-shadow: 0 0 0 2px var(--c-brand); }
.pb.primary.pre { box-shadow: 0 0 0 2px var(--c-brand-line); }
</style>
