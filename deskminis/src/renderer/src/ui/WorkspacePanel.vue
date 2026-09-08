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

// ---- T6b 工作区绑定。换壳时这块入口整个丢了：后端与 store 都通，ui/ 下零引用，
//      结果是每个会话只能在沙箱桶里干活，而 README 写着「每会话绑定真实项目目录」。----
const wsOpen = ref(false);
const wsPath = ref('');
const wsErr = ref('');
const wsBusy = ref(false);

/** 折叠态只显示目录名，全路径挂 title——244px 的右栏塞不下绝对路径。 */
const wsLabel = computed(() => {
  if (!chat.activeId) return '未选会话';
  if (chat.workspaceIsDefault) return '会话沙箱（默认）';
  return chat.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || '工作区';
});

/** 工作区是**每会话**的：没有活动会话时 setWorkspace 会带着空 sessionId 发出去，
 *  后端 UPDATE 匹配不到任何行——**静默什么也不发生**（旧实现实测撞到过）。
 *  故先建会话再设；按钮文案写明「新建会话并…」，不做无声的副作用。 */
async function ensureSession(): Promise<void> {
  if (!chat.activeId) await chat.newSession();
}
async function applyWs(): Promise<void> {
  const v = wsPath.value.trim();
  if (!v) return;
  wsErr.value = ''; wsBusy.value = true;
  try { await ensureSession(); await chat.setWorkspace(v); wsPath.value = ''; wsOpen.value = false; }
  catch (e) { wsErr.value = e instanceof Error ? e.message : String(e); }
  finally { wsBusy.value = false; }
}
async function pickWs(): Promise<void> {
  wsErr.value = ''; wsBusy.value = true;
  try {
    const picked = await chat.pickWorkspaceFolder();
    if (picked === null) return;   // 用户取消——**返回的是 null 不是空串**，空串会被当成「清空」
    await ensureSession();
    await chat.setWorkspace(picked);
    wsOpen.value = false;
  } catch (e) { wsErr.value = e instanceof Error ? e.message : String(e); }
  finally { wsBusy.value = false; }
}
async function resetWs(): Promise<void> {
  wsErr.value = '';
  try { await chat.resetWorkspace(); }
  catch (e) { wsErr.value = e instanceof Error ? e.message : String(e); }
}

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
/** T6b：换了绑定目录，树看的就是另一个目录了——必须重取。
 *  watch 根路径而不是在每个处理器里手调 refresh：绑定/恢复默认/换会话继承，
 *  任何一条改动路径都被这一处接住。 */
watch(() => chat.workspaceRoot, (now, prev) => { if (now !== prev) refresh(); });

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

    <!-- 绑定行只在「文件」tab 显示：文件树展示的就是这个目录的内容，
         说明「这是哪个目录」正该在树的正上方。tabs 那一行在 244px 里已经挤满，塞不下第四个元素。 -->
    <div v-if="tab === 'files'" class="wsbar">
      <button
        class="wstoggle" type="button" :aria-expanded="wsOpen"
        :title="chat.workspaceRoot || '未绑定目录'" @click="wsOpen = !wsOpen"
      >
        <UiIcon name="folder" :size="14" />
        <span class="wsname">{{ wsLabel }}</span>
        <UiIcon :name="wsOpen ? 'chevronUp' : 'chevronDown'" :size="12" />
      </button>

      <div v-if="wsOpen" class="wspanel">
        <div class="wsnow t-aux">
          <span v-if="!chat.activeId" class="wsnone">尚未选择会话——工作区是每个会话各自的</span>
          <span v-else class="wspath" :title="chat.workspaceRoot">{{ chat.workspaceRoot }}</span>
        </div>

        <!-- 主操作独占一行：文案有地方把「会先建会话」这个副作用说全。
             三个控件挤一行时输入框会被压到只剩两个字（旧实现在 336px 上就已经栽过，这里只有 244px）。 -->
        <button class="f-btn primary wsmain" type="button" :disabled="wsBusy" @click="pickWs">
          {{ chat.activeId ? '选择目录…' : '新建会话并选目录…' }}
        </button>
        <div class="wsrow">
          <input
            v-model="wsPath" class="f-input wsinput" type="text" placeholder="或粘贴绝对路径"
            @keydown.enter="applyWs"
          />
          <button class="f-btn" type="button" :disabled="wsBusy || !wsPath.trim()" @click="applyWs">应用</button>
        </div>

        <p class="wshint t-aux">
          shell 命令、终端、相对路径都以这里为基准；之后新建的会话也会继承它。
        </p>
        <button v-if="chat.activeId && !chat.workspaceIsDefault" class="f-btn ghost wsreset" type="button" @click="resetWs">
          恢复默认沙箱
        </button>
        <p v-if="wsErr" class="wserr t-aux">{{ wsErr }}</p>
      </div>
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

/* ---- T6b 工作区绑定行 ---- */
.wsbar { flex: 0 0 auto; border-bottom: 1px solid var(--c-line); background: var(--c-bg-1); }
.wstoggle {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  height: var(--h-row); padding: 0 var(--sp-4); cursor: pointer;
  background: none; color: var(--c-ink-2); font-family: inherit; font-size: var(--t-aux-size);
}
.wstoggle:hover { background: var(--c-bg-2); color: var(--c-ink); }
.wstoggle :deep(svg) { color: var(--c-ink-3); flex: 0 0 auto; }
.wsname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }

.wspanel { display: flex; flex-direction: column; gap: var(--sp-3); padding: 0 var(--sp-4) var(--sp-4); }
.wsnow { color: var(--c-ink-2); }
/* 路径按**尾部优先**截断：D:\…\myapp 比 D:\projects\very\lo… 有用 */
.wspath { display: block; direction: rtl; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--f-mono); }
.wsnone { color: var(--c-ink-3); }
.wsmain { width: 100%; }
.wsrow { display: flex; gap: var(--sp-2); }
.wsinput { min-width: 0; height: var(--h-ctl); font-size: var(--t-aux-size); }
.wshint { margin: 0; color: var(--c-ink-3); line-height: 1.6; }
.wsreset { align-self: flex-start; }
.wserr { margin: 0; color: var(--c-err); word-break: break-word; }
</style>
