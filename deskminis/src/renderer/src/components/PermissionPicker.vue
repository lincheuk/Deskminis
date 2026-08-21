<script setup lang="ts">
/** 权限档位选择器（设计 §5.2）——输入区胶囊 → 向上弹出 action-sheet。
 *  三档双行行式：图标 + 标题 + 说明，当前档右侧对勾，危险档整行红。渲染端本地偏好。 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useChat } from '../stores/chat';
import Icon from './Icon.vue';

const chat = useChat();

type Tier = 'ask' | 'session' | 'full';
interface Row { tier: Tier; icon: string; title: string; sub: string; danger?: boolean }

const ROWS: Row[] = [
  { tier: 'ask', icon: 'hand', title: '每次确认', sub: '工作区内文件直接放行；其余每次询问' },
  { tier: 'session', icon: 'clock', title: '本会话沿用', sub: '批准过的命令原样重复时不再询问' },
  { tier: 'full', icon: 'alert', title: '完全访问', sub: '不再询问任何操作；不可逆的系统操作仍拦截', danger: true },
];

const label = computed(() => ROWS.find(r => r.tier === chat.permTier)?.title ?? '每次确认');

const open = ref(false);
async function pick(t: Tier): Promise<void> {
  open.value = false; // 先关菜单：切换失败也不把用户锁在弹层里
  try { await chat.setPermTier(t); } catch { /* 后端写入失败：store 保持原值，高亮不谎报已切换 */ }
}
function close(): void { open.value = false; }
onMounted(() => document.addEventListener('click', close));
onBeforeUnmount(() => document.removeEventListener('click', close));
</script>

<template>
  <div class="wrap" @click.stop>
    <div class="cpill" @click="open = !open" tabindex="0" role="button" @keydown.enter.prevent="open = !open" @keydown.space.prevent="open = !open" :aria-expanded="open">
      <Icon name="shield" :size="14" /><span>{{ label }}</span>
    </div>
    <div v-if="open" class="menu">
      <div class="mhead">应如何批准 DeskMinis 的操作？</div>
      <div
        v-for="r in ROWS" :key="r.tier"
        class="mrow" :class="{ danger: r.danger }" tabindex="0" role="option" @keydown.enter.prevent="pick(r.tier)" @keydown.space.prevent="pick(r.tier)"
        @click="pick(r.tier)"
      >
        <Icon :name="r.icon" :size="18" />
        <div class="mtxt"><div class="mt">{{ r.title }}</div><div class="ms">{{ r.sub }}</div></div>
        <Icon v-if="chat.permTier === r.tier" class="chk" name="check" :size="16" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { position: relative; }
.cpill {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: var(--r-pill);
  border: 1px solid var(--separator); background: var(--grouped-bg-secondary);
  font-size: 13px; color: var(--label-secondary); cursor: pointer;
}
.menu {
  position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 30; min-width: 300px;
  background: var(--grouped-bg-secondary); border: 1px solid var(--separator); border-radius: var(--r-card);
  padding: 6px; box-shadow: var(--shadow-pop);
}
.mhead { font-size: 12px; color: var(--label-secondary); padding: 8px 10px 6px; }
.mrow { display: flex; gap: 10px; padding: 9px 10px; border-radius: var(--r-control); cursor: pointer; align-items: flex-start; color: var(--label); }
.mrow:hover { background: var(--fill-quaternary); }
/* MU3 §2-5 焦点环 */
.mrow:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.mtxt { flex: 1; min-width: 0; }
.mt { font-size: 15px; font-weight: var(--fw-strong); color: var(--label-strong); }
.ms { font-size: 13px; color: var(--label-secondary); margin-top: 2px; }
.chk { margin-left: auto; color: var(--accent); flex: 0 0 auto; margin-top: 2px; }
.mrow.danger .mt, .mrow.danger .ms { color: var(--red); }
.mrow.danger :deep(svg) { stroke: var(--red); }
</style>
