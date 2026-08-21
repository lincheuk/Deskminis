<script setup lang="ts">
/** T 波：右侧工作区面板（用户参考图的 Workspace 栏）。两个 tab：
 *  **文件**——会话工作区文件树（懒加载）；**改动**——本会话 agent 写过的文件清单。
 *  「改动」这一 tab 是参考图里的 Changes：agent 干了什么，一眼可查、可点开对照。 */
import { computed, ref, watch } from 'vue';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import { collectArtifacts } from '../lib/artifacts/collect';
import UiFileTree from './UiFileTree.vue';
import TaskPanel from './TaskPanel.vue';
import UiIcon from './UiIcon.vue';

const props = defineProps<{ selected: string | null }>();
const emit = defineEmits<{ (e: 'open', path: string): void }>();
const chat = useChat();

interface Node { name: string; path: string; kind: 'dir' | 'file'; size: number; mtime: number }
const tab = ref<'files' | 'changes' | 'tasks'>('files');
const roots = ref<Node[] | null>(null);
const loading = ref(false);
const failed = ref('');
const refreshKey = ref(0);

async function load(): Promise<void> {
  if (!chat.activeId) { roots.value = null; return; }
  loading.value = true; failed.value = '';
  try { roots.value = await rpc.call('files.list', { sessionId: chat.activeId }); }
  catch (e) { failed.value = e instanceof Error ? e.message : String(e); roots.value = null; }
  finally { loading.value = false; }
}
function refresh(): void { refreshKey.value++; void load(); }

watch(() => chat.activeId, load, { immediate: true });
// agent 回合结束 → 工作区可能已被改动，自动刷新（免手动）
watch(() => chat.running, (now, prev) => { if (prev && !now) refresh(); });

/** 改动清单走 collectArtifacts 纯模块（V8）：手写的那版只扫历史 messages，
 *  拿不到**正在跑的这一轮**（实时 toolCards），也没有 edit 的增删数与路径相对化。
 *  同一份数据两处各写一遍的结果必然是两处不一致——统一走已有单测的那份。 */
const changes = computed(() => collectArtifacts(chat.messages, chat.toolCards));
</script>

<template>
  <aside class="ws">
    <div class="tabs">
      <button type="button" :class="{ on: tab === 'files' }" @click="tab = 'files'">文件</button>
      <button type="button" :class="{ on: tab === 'changes' }" @click="tab = 'changes'">
        改动<span v-if="changes.length" class="n tnum">{{ changes.length }}</span>
      </button>
      <button type="button" :class="{ on: tab === 'tasks' }" @click="tab = 'tasks'">
        任务<span v-if="chat.pendingPerms.length" class="n dot">·</span>
      </button>
      <span class="grow"></span>
      <button class="ib" type="button" title="刷新" @click="refresh"><UiIcon name="refresh" :size="14" /></button>
    </div>

    <div class="body">
      <template v-if="tab === 'files'">
        <div v-if="!chat.activeId" class="hint">先开一个会话</div>
        <div v-else-if="loading && !roots" class="hint">加载中…</div>
        <div v-else-if="failed" class="hint err">{{ failed }}</div>
        <div v-else-if="roots && !roots.length" class="hint">工作区为空<br />agent 创建的文件会出现在这里</div>
        <UiFileTree
          v-for="n in roots ?? []" :key="n.path"
          :node="n" :session-id="chat.activeId" :depth="0" :refresh-key="refreshKey" :selected="props.selected"
          @open="p => emit('open', p)"
        />
      </template>

      <template v-else-if="tab === 'changes'">
        <div v-if="!changes.length" class="hint">本会话还没有文件改动</div>
        <button v-for="c in changes" :key="c.path" type="button" class="chg" :class="{ on: props.selected === c.path }" @click="emit('open', c.path)">
          <span class="tag" :class="c.kind">{{ c.kind === 'edit' ? '改' : '写' }}</span>
          <span class="cpath">{{ c.path }}</span>
          <span v-if="c.kind === 'edit' && (c.add || c.del)" class="cnum t-aux tnum">
            <span class="a">+{{ c.add ?? 0 }}</span><span class="d">-{{ c.del ?? 0 }}</span>
          </span>
        </button>
      </template>

      <TaskPanel v-else />
    </div>
  </aside>
</template>

<style scoped>
.ws {
  width: var(--w-aside); flex: 0 0 var(--w-aside);
  display: flex; flex-direction: column; min-height: 0;
  background: var(--c-bg-1); border-left: 1px solid var(--c-line);
}
.tabs {
  flex: 0 0 auto; display: flex; align-items: center; gap: 2px;
  height: var(--h-field); padding: 0 var(--sp-2);
  border-bottom: 1px solid var(--c-line);
}
.tabs button {
  /* 三个 tab + 刷新钮要挤进 244px：nowrap 是硬要求——不加的话
     「文件」会被折成两行「文 / 件」（V4 实拍逮到），内边距也得收窄 */
  height: var(--h-mini); padding: 0 var(--sp-3); border-radius: var(--r-s);
  background: none; color: var(--c-ink-3); cursor: pointer; white-space: nowrap;
  font-size: var(--t-aux-size); font-family: inherit;
  display: inline-flex; align-items: center; gap: var(--sp-1); flex: 0 0 auto;
}
.tabs button:hover { color: var(--c-ink); }
.tabs button.on { background: var(--c-bg-2); color: var(--c-ink); font-weight: var(--w-md); }
.n { color: var(--c-ink-3); }
/* 有待批准请求时 tab 上点一个警示圆点：回合正卡在那儿，值得一眼看见 */
.n.dot { color: var(--c-warn); font-weight: var(--w-bd); }
.grow { flex: 1; }
.ib { width: 24px; height: 24px; justify-content: center; padding: 0 !important; }

.body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--sp-2) var(--sp-3) var(--sp-4); }
/* 任务面板自带内边距，外层再叠一层会把水位条挤窄 */
.body:has(.tp) { padding: 0; }
.hint { padding: var(--sp-7) var(--sp-4); text-align: center; font-size: var(--t-aux-size); line-height: 1.7; color: var(--c-ink-3); }
.hint.err { color: var(--c-err); }

.chg {
  display: flex; align-items: center; gap: var(--sp-3); width: 100%;
  padding: var(--sp-2) var(--sp-3); border-radius: var(--r-s);
  background: none; cursor: pointer; text-align: left; font-family: inherit;
}
.chg:hover { background: var(--c-bg-2); }
.chg.on { background: var(--c-brand-soft); }
.tag {
  flex: 0 0 auto; width: 18px; height: 18px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: var(--w-md);
  background: var(--c-ok-soft); color: var(--c-ok);
}
.tag.edit { background: var(--c-warn-soft); color: var(--c-warn); }
.cpath {
  flex: 1; min-width: 0; font-family: var(--f-mono); font-size: var(--t-aux-size);
  color: var(--c-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
}

/* 编辑增删数：写是「新出现一份」，改是「动了几行」——后者的量级才需要数字 */
.cnum { flex: 0 0 auto; display: inline-flex; gap: var(--sp-2); }
.cnum .a { color: var(--c-ok); }
.cnum .d { color: var(--c-err); }
</style>
