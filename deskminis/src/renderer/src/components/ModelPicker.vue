<script setup lang="ts">
/** 模型选择器（设计 §5.3）——输入区胶囊 → 向上弹出。列出 provider.instances.list：
 *  实例名 + 模型 id，当前项打勾；无密钥置灰并标「缺密钥」；底部「管理模型」进设置。
 *  绝不显示密钥——hasApiKey 只决定是否置灰。 */
import { ref, computed, inject, onMounted, onBeforeUnmount } from 'vue';
import { useChat } from '../stores/chat';
import Icon from './Icon.vue';

const chat = useChat();
const openSettings = inject<() => void>('openSettings', () => {});

const current = computed(() => chat.providers.find(p => p.id === chat.defaultProviderId));
const label = computed(() => current.value?.name ?? '选择模型');

const open = ref(false);
function pick(id: string, hasApiKey: boolean): void {
  if (!hasApiKey) return; // 缺密钥不可选
  void chat.setDefaultProvider(id);
  open.value = false;
}
function manage(): void { open.value = false; openSettings(); }
function close(): void { open.value = false; }
onMounted(() => document.addEventListener('click', close));
onBeforeUnmount(() => document.removeEventListener('click', close));
</script>

<template>
  <div class="wrap" @click.stop>
    <div class="cpill" @click="open = !open">
      <span>{{ label }}</span><Icon name="chevron-up" :size="12" />
    </div>
    <div v-if="open" class="menu">
      <div v-if="!chat.providers.length" class="mhead">尚未配置任何模型</div>
      <div
        v-for="p in chat.providers" :key="p.id"
        class="mrow" :class="{ off: !p.hasApiKey }"
        @click="pick(p.id, p.hasApiKey)"
      >
        <div class="mtxt">
          <div class="mt">{{ p.name }}</div>
          <div class="ms">{{ p.modelId || p.kind }}<span v-if="!p.hasApiKey"> · 缺密钥</span></div>
        </div>
        <Icon v-if="p.id === chat.defaultProviderId" class="chk" name="check" :size="16" />
      </div>
      <div class="mdiv"></div>
      <div class="mrow manage" @click="manage"><div class="mtxt"><div class="mt plain">管理模型…</div></div></div>
    </div>
  </div>
</template>

<style scoped>
.wrap { position: relative; }
.cpill {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: var(--r-pill);
  border: .5px solid var(--separator); background: var(--grouped-bg-secondary);
  font-size: 13px; color: var(--label-strong); cursor: pointer;
}
.menu {
  /* 左对齐胶囊（与 PermissionPicker 一致）；right:0 会让弹层从胶囊右缘向左伸出、看着没对齐 */
  position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 30; min-width: 240px;
  background: var(--grouped-bg-secondary); border: .5px solid var(--separator); border-radius: var(--r-card);
  padding: 6px; box-shadow: var(--shadow-pop);
}
.mhead { font-size: 12px; color: var(--label-secondary); padding: 8px 10px; }
.mrow { display: flex; gap: 10px; padding: 9px 10px; border-radius: var(--r-control); cursor: pointer; align-items: center; color: var(--label); }
.mrow:hover { background: var(--fill-quaternary); }
/* MU3 §2-5 焦点环 */
.mrow:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.mrow.off { opacity: .4; cursor: default; }
.mrow.off:hover { background: transparent; }
.mtxt { flex: 1; min-width: 0; }
.mt { font-size: 17px; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mt.plain { font-size: 14px; color: var(--label-secondary); }
.ms { font-size: 13px; color: var(--label-secondary); font-family: var(--font-mono); margin-top: 1px; }
.chk { margin-left: auto; color: var(--accent); flex: 0 0 auto; }
.mdiv { height: .5px; background: var(--separator); margin: 6px 10px; }
</style>
