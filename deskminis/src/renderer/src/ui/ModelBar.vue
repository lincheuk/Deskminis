<script setup lang="ts">
/** T 波：欢迎页模型切换条（对应官方原图 homepage.png 里那条紫底胶囊工具条）。
 *  原图形态：浅紫圆角长条，左端是当前选中的 CLI（白底胶囊 + logo），
 *  竖分隔线后排一行彩色品牌图标，末尾一个 +。它是整个欢迎页的**视觉焦点**——
 *  一排彩色图标把大片留白撑住，缺了它版面就只剩黑白灰。
 *
 *  我们没有多 CLI，对应物是**已配置的模型 provider**：选中哪个，下一条消息就用它。
 *  provider 无品牌 logo，故用首字母徽标 + id 派生色相，达到同样的「一排彩色」效果。 */
import { computed } from 'vue';
import { useChat } from '../stores/chat';
import UiIcon from './UiIcon.vue';

const chat = useChat();
const emit = defineEmits<{ (e: 'manage'): void }>();

const items = computed(() => chat.providers);
const activeId = computed(() => chat.defaultProviderId || items.value[0]?.id || '');
const active = computed(() => items.value.find(p => p.id === activeId.value));

function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
function badge(p: { id: string; name?: string }): Record<string, string> {
  const h = hue(p.id);
  return { background: `oklch(0.90 0.09 ${h})`, color: `oklch(0.42 0.16 ${h})` };
}
const initial = (n: string): string => (n || '?').trim().charAt(0).toUpperCase();
async function pick(id: string): Promise<void> {
  if (id === activeId.value) return;
  try { await chat.setDefaultProvider(id); } catch { /* 写入失败：保持原选择，不谎报已切换 */ }
}
</script>

<template>
  <div v-if="items.length" class="bar">
    <span class="cur">
      <span class="badge" :style="badge(active ?? { id: '' })">{{ initial(active?.name ?? '') }}</span>
      <span class="cname">{{ active?.modelId || active?.name || '默认模型' }}</span>
    </span>
    <span class="div"></span>
    <button
      v-for="p in items" :key="p.id" type="button"
      class="dot" :class="{ on: p.id === activeId }"
      :title="`${p.name}${p.modelId ? ' · ' + p.modelId : ''}`" @click="pick(p.id)"
    >
      <span class="badge" :style="badge(p)">{{ initial(p.name) }}</span>
    </button>
    <button class="add" type="button" title="添加模型" @click="emit('manage')">
      <UiIcon name="plus" :size="15" />
    </button>
  </div>

  <!-- 一个 provider 都没配时，这条就是引导位——不藏起来，否则新用户找不到入口 -->
  <button v-else class="empty" type="button" @click="emit('manage')">
    <UiIcon name="plus" :size="15" /><span>先添加一个模型，才能开始对话</span>
  </button>
</template>

<style scoped>
.bar {
  display: inline-flex; align-items: center; gap: var(--sp-2);
  align-self: center; max-width: 100%;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-pill);
  /* AOU 紫调长条（他们的 --color-guid-agent-bar） */
  background: var(--c-aou-bar);
  overflow-x: auto;
}
.cur {
  display: inline-flex; align-items: center; gap: var(--sp-2); flex: 0 0 auto;
  height: var(--h-ctl); padding: 0 var(--sp-4) 0 var(--sp-2);
  border-radius: var(--r-pill); background: var(--c-bg);
  font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink);
}
.cname { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.div { width: 1px; height: 18px; background: var(--c-aou); opacity: .35; flex: 0 0 auto; margin: 0 var(--sp-1); }
.badge {
  width: 22px; height: 22px; flex: 0 0 auto; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: var(--w-bd); line-height: 1;
}
.dot {
  display: inline-flex; flex: 0 0 auto; padding: 3px; border-radius: 10px;
  background: none; cursor: pointer;
}
.dot:hover { background: var(--c-bg); }
.dot.on { background: var(--c-bg); }
.add {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  width: 26px; height: 26px; border-radius: 8px;
  background: none; color: var(--c-ink-3); cursor: pointer; padding: 0;
}
.add:hover { background: var(--c-bg); color: var(--c-ink); }

.empty {
  align-self: center; display: inline-flex; align-items: center; gap: var(--sp-2);
  height: var(--h-field); padding: 0 var(--sp-6); border-radius: var(--r-pill);
  background: var(--c-aou-bar); color: var(--c-ink-2); cursor: pointer;
  font-size: var(--t-item-size); font-family: inherit;
}
.empty:hover { color: var(--c-ink); }
</style>
