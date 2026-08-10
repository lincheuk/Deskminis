<script setup lang="ts">
/** 右栏 · 产物面板（MU2b Task 3，设计 §4.1）——本会话写/编过的文件汇总卡。
 *  数据：collectArtifacts(chat.messages, chat.toolCards) 纯模块（历史 + 实时双源，同路径 edit 优先去重）。
 *  点击卡：chat.pendingFilePreview = path + switchRightTab('files') → FilesPanel watch 走既有 preview 流程。 */
import { computed, inject } from 'vue';
import { useChat } from '../stores/chat';
import { collectArtifacts } from '../lib/artifacts/collect';
import Icon from './Icon.vue';

const chat = useChat();
// App.vue provide：切右栏 tab（产物 → 文件定位预览；与 tab 点击同一入口）
const switchRightTab = inject<(tab: 'progress' | 'artifacts' | 'files' | 'terminal') => void>('switchRightTab', () => {});

// 历史 messages + 实时 toolCards 双源汇总（chat.toolCards 的 input 是产物路径数据源）
const artifacts = computed(() => collectArtifacts(chat.messages, chat.toolCards));

function openInFiles(path: string): void {
  chat.pendingFilePreview = path;
  switchRightTab('files');
}
</script>

<template>
  <div class="apanel">
    <div v-if="artifacts.length === 0" class="ahint">本轮还没有产物<br />agent 写入或编辑的文件会出现在这里</div>
    <button
      v-for="a in artifacts" :key="a.path"
      class="acard" type="button" :title="a.path"
      @click="openInFiles(a.path)"
    >
      <span class="aicon"><Icon :name="a.kind === 'edit' ? 'edit' : 'file'" :size="14" /></span>
      <span class="apath">{{ a.path }}</span>
      <span v-if="a.kind === 'edit'" class="abadge">
        <span class="badd">{{ '+' }}{{ a.add }}</span><span class="bdel">{{ '−' }}{{ a.del }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
.apanel { flex: 1; min-height: 0; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.ahint { font-size: 12px; color: var(--label-tertiary); padding: 24px 12px; text-align: center; line-height: 1.6; }
.acard {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; text-align: left;
  background: var(--grouped-bg-secondary); border: .5px solid var(--separator); border-radius: var(--r-card);
  cursor: pointer; color: var(--label);
}
.acard:hover { background: var(--fill-quaternary); }
.aicon { flex: 0 0 auto; display: inline-flex; color: var(--label-secondary); }
.apath {
  flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 12px; color: var(--label-strong);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.abadge { flex: 0 0 auto; display: inline-flex; gap: 6px; font-size: 11px; font-variant-numeric: tabular-nums; }
.badd { color: var(--state-ok); }
.bdel { color: var(--state-err); }
</style>
