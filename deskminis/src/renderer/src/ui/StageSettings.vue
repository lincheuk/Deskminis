<script setup lang="ts">
/** T5：设置页。T 波换壳时这里是一句「这个视图在下一步接入」的占位——
 *  **没有设置页就配不了 provider，装好的应用等于不能用**。这是补齐的第一站。
 *
 *  形态：左侧一列小节 + 右侧定宽内容（不是弹窗）。弹窗放不下七节，
 *  且设置是「进去待一会儿」的地方，不是「点一下就走」的地方。 */
import { ref } from 'vue';
import UiIcon from './UiIcon.vue';
import SecModels from './settings/SecModels.vue';
import SecPermission from './settings/SecPermission.vue';
import SecSkills from './settings/SecSkills.vue';
import SecMcp from './settings/SecMcp.vue';
import SecSearch from './settings/SecSearch.vue';
import SecLook from './settings/SecLook.vue';
import SecAbout from './settings/SecAbout.vue';

type Sec = 'models' | 'perm' | 'skills' | 'mcp' | 'search' | 'look' | 'about';
const SECS: { k: Sec; icon: string; label: string }[] = [
  { k: 'models', icon: 'robot', label: '模型' },
  { k: 'perm', icon: 'shield', label: '权限' },
  { k: 'skills', icon: 'book', label: '技能' },
  { k: 'mcp', icon: 'puzzle', label: 'MCP' },
  { k: 'search', icon: 'search', label: '网络搜索' },
  { k: 'look', icon: 'sun', label: '外观' },
  { k: 'about', icon: 'alert', label: '关于' },
];
const sec = ref<Sec>('models');
</script>

<template>
  <div class="settings">
    <nav class="secnav">
      <button
        v-for="s in SECS" :key="s.k" type="button"
        class="secit" :class="{ on: sec === s.k }" :aria-pressed="sec === s.k" @click="sec = s.k"
      >
        <UiIcon :name="s.icon" :size="16" /><span>{{ s.label }}</span>
      </button>
    </nav>
    <div class="secbody">
      <div class="secol">
        <SecModels v-if="sec === 'models'" />
        <SecPermission v-else-if="sec === 'perm'" />
        <SecSkills v-else-if="sec === 'skills'" />
        <SecMcp v-else-if="sec === 'mcp'" />
        <SecSearch v-else-if="sec === 'search'" />
        <SecLook v-else-if="sec === 'look'" />
        <SecAbout v-else />
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings { flex: 1; min-height: 0; display: flex; }
.secnav {
  flex: 0 0 176px; display: flex; flex-direction: column; gap: 2px;
  padding: var(--sp-6) var(--sp-3); border-right: 1px solid var(--c-line);
  background: var(--c-bg-1); overflow-y: auto;
}
.secit {
  display: flex; align-items: center; gap: var(--sp-3); width: 100%;
  height: var(--h-row); padding: 0 var(--sp-4); border-radius: var(--r-s);
  background: none; color: var(--c-ink-2); cursor: pointer; text-align: left;
  font-size: var(--t-item-size); font-family: inherit;
}
.secit :deep(svg) { color: var(--c-ink-3); flex: 0 0 auto; }
.secit:hover { background: var(--c-bg-2); color: var(--c-ink); }
.secit.on { background: var(--c-brand-soft); color: var(--c-ink); font-weight: var(--w-md); }
.secit.on :deep(svg) { color: var(--c-brand); }

.secbody { flex: 1; min-width: 0; overflow-y: auto; background: var(--c-bg); }
/* 定宽居中：设置项撑满宽屏后，标签和输入框会拉开到看不出配对关系 */
.secol { width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto; padding: var(--sp-8) 0; }
</style>
