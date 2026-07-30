<script setup lang="ts">
/** 权限确认内联卡（设计 §5.1）——非模态，就地出现在对话流里。
 *  橙色盾牌 + 逐字完整、可换行、绝不截断的命令/路径 + 三个决策按钮。 */
import { computed } from 'vue';
import { useChat } from '../stores/chat';
import Icon from './Icon.vue';

const props = defineProps<{ perm: { requestId: string; detail: string; kind: string; toolTitle: string } }>();
const chat = useChat();

const title = computed(() => {
  switch (props.perm.kind) {
    case 'shell': return '请求执行命令';
    case 'file-write': return '请求写入文件';
    case 'file-read': return '请求读取文件';
    default: return '请求权限';
  }
});
const keyLabel = computed(() => (props.perm.kind === 'shell' ? '命令' : '路径'));

// 权限档位（渲染端本地偏好）预选高亮：本会话沿用/完全访问 → 高亮「本会话允许」；每次确认 → 高亮「仅此次」
const preselect = computed<'allow-once' | 'allow-session'>(() =>
  chat.permTier === 'ask' ? 'allow-once' : 'allow-session',
);
</script>

<template>
  <div class="perm">
    <div class="h">
      <span class="shield"><Icon name="shield" :size="20" /></span>
      {{ title }}
    </div>
    <div class="args">
      <div class="k">{{ keyLabel }}</div>
      <div class="v">{{ perm.detail }}</div>
    </div>
    <div class="btns">
      <button class="btn" :class="{ pre: preselect === 'allow-once' }" @click="chat.respondPerm(perm.requestId, 'allow-once')">仅此次</button>
      <button class="btn" :class="{ pre: preselect === 'allow-session' }" @click="chat.respondPerm(perm.requestId, 'allow-session')">本会话允许</button>
      <button class="btn deny" @click="chat.respondPerm(perm.requestId, 'deny')">拒绝</button>
    </div>
  </div>
</template>

<style scoped>
.perm {
  background: var(--grouped-bg-secondary); border: .5px solid var(--separator); border-radius: var(--r-card);
  padding: 12px; display: flex; flex-direction: column; gap: 10px; align-self: stretch;
}
.h { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 600; }
.shield { display: inline-flex; color: var(--orange); }
.args {
  background: var(--grouped-bg-tertiary); border-radius: var(--r-md); padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.k { font-size: 13px; font-weight: 600; color: var(--label-secondary); }
/* 逐字完整、可换行、绝不截断 */
.v { font-size: 13px; font-family: var(--font-mono); word-break: break-all; white-space: pre-wrap; line-height: 1.5; }
.btns { display: flex; gap: 8px; }
.btn {
  flex: 1; padding: 10px; border-radius: var(--r-control); border: .5px solid var(--separator);
  background: var(--grouped-bg-secondary); color: var(--label); font-family: var(--font-ui);
  font-size: 15px; font-weight: 600; cursor: pointer;
}
.btn:hover { background: var(--fill-quaternary); }
.btn.pre { border-color: var(--label); border-width: 1px; }
.btn.deny { color: var(--red); }
.btn.deny.pre { border-color: var(--separator); }
</style>
