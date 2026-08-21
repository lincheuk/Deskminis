<script setup lang="ts">
/** T5：权限档位。档位是**全局默认**，权限卡上还能就地临时改——两处同一份 permTier
 *  镜像，后端 settings 表持久化。文案照旧版逐字保留：这三句话决定用户敢不敢开 full。 */
import { useChat } from '../../stores/chat';
import UiIcon from '../UiIcon.vue';

const chat = useChat();
type Tier = 'ask' | 'session' | 'full';
const TIERS: { tier: Tier; icon: string; title: string; sub: string; danger?: boolean }[] = [
  { tier: 'ask', icon: 'shield', title: '每次确认', sub: '工作区内文件直接放行；其余每次询问' },
  { tier: 'session', icon: 'clock', title: '本会话沿用', sub: '批准过的命令原样重复时不再询问' },
  { tier: 'full', icon: 'alert', title: '完全访问', sub: '不再询问任何操作；不可逆的系统操作仍拦截', danger: true },
];
</script>

<template>
  <section class="f-sec">
    <h2>权限</h2>
    <p class="f-note">agent 动文件、跑命令前要不要问你。改这里是改全局默认，单次询问卡上还能临时调。</p>
    <div class="tiers">
      <button
        v-for="t in TIERS" :key="t.tier" type="button"
        class="tier" :class="{ on: chat.permTier === t.tier, danger: t.danger }"
        :aria-pressed="chat.permTier === t.tier" @click="chat.setPermTier(t.tier)"
      >
        <UiIcon :name="t.icon" :size="18" />
        <span class="ttl">{{ t.title }}</span>
        <span class="sub t-aux">{{ t.sub }}</span>
      </button>
    </div>
    <p v-if="chat.permTier === 'full'" class="warnbox t-body">
      完全访问下 agent 会直接改文件、跑命令，不再逐条问你。只在你完全清楚它要做什么时开。
    </p>
  </section>
</template>

<style scoped>
.tiers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4); }
@media (max-width: 760px) { .tiers { grid-template-columns: minmax(0, 1fr); } }
.tier {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-5); text-align: left; cursor: pointer; font-family: inherit;
  background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-m);
}
.tier :deep(svg) { color: var(--c-ink-3); }
.tier:hover { border-color: var(--c-brand-line); }
.tier.on { border-color: var(--c-brand); background: var(--c-brand-soft); }
.tier.on :deep(svg) { color: var(--c-brand); }
.tier.danger.on { border-color: var(--c-err); background: var(--c-err-soft); }
.tier.danger.on :deep(svg) { color: var(--c-err); }
.ttl { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.sub { color: var(--c-ink-3); }
.warnbox {
  margin: 0; padding: var(--sp-4) var(--sp-5); border-radius: var(--r-s);
  background: var(--c-err-soft); color: var(--c-err);
}
</style>
