<script setup lang="ts">
/** T5：技能。技能 = 一个带 SKILL.md 的目录，导入后可在对话里用斜杠调用。
 *  这里列的是**全部**技能（含已禁用）——只列启用的话，关掉一个就再也找不回来了。 */
import { computed, onMounted, ref } from 'vue';
import { useChat } from '../../stores/chat';
import UiIcon from '../UiIcon.vue';

const chat = useChat();
const importPath = ref('');
const importErr = ref('');
const busy = ref(false);
const confirming = ref('');

onMounted(() => { void chat.refreshAllSkills(); });
const task = computed(() => chat.skillImport);

async function doImport(): Promise<void> {
  const src = importPath.value.trim();
  importErr.value = '';
  if (!src) { importErr.value = '请先填写技能目录的绝对路径'; return; }
  busy.value = true;
  try {
    const t = await chat.importSkillFolder(src);
    // 广播可能丢：拿到 taskId 后主动兜一次底，避免界面永远停在「进行中」
    if (t && typeof t.taskId === 'string') window.setTimeout(() => { void chat.pollSkillImport(t.taskId); }, 1200);
    importPath.value = '';
  } catch (e) {
    importErr.value = e instanceof Error ? e.message : String(e);
  } finally { busy.value = false; }
}
async function onDelete(id: string): Promise<void> { await chat.deleteSkill(id); confirming.value = ''; }
</script>

<template>
  <section class="f-sec">
    <h2>技能</h2>
    <p class="f-note">技能是一个带 SKILL.md 的目录。导入后在对话框里打 <code>/</code> 就能调用。</p>

    <div class="f-card">
      <label class="f-label">
        <span>导入技能目录</span>
        <span class="irow">
          <input v-model="importPath" class="f-input" placeholder="技能目录的绝对路径，如 D:\skills\writer" @keydown.enter.prevent="doImport" />
          <button class="f-btn primary" type="button" :disabled="busy" @click="doImport">{{ busy ? '导入中…' : '导入' }}</button>
        </span>
        <span class="f-hint">目录里要有 SKILL.md；一个目录下有多个子技能会一并导入。</span>
      </label>
      <p v-if="importErr" class="errline">{{ importErr }}</p>
      <p v-else-if="task" class="taskline t-aux" :class="{ bad: task.state === 'failed' }">
        <template v-if="task.state === 'running'">导入中 {{ task.completed }}/{{ task.total }}…</template>
        <template v-else-if="task.state === 'done'">
          成功 {{ task.succeeded.length }} 个<template v-if="task.failures.length">，失败 {{ task.failures.length }} 个</template>
        </template>
        <template v-else>导入失败：{{ task.error || '未知原因' }}</template>
      </p>
      <ul v-if="task?.failures.length" class="fails">
        <li v-for="f in task.failures" :key="f.name" class="t-aux">{{ f.name }}：{{ f.error }}</li>
      </ul>
    </div>

    <p v-if="!chat.allSkills.length" class="f-note">还没有技能。</p>
    <div v-for="s in chat.allSkills" :key="s.id" class="srow">
      <label class="f-switch" :title="s.isEnabled ? '停用' : '启用'">
        <input type="checkbox" :checked="s.isEnabled" @change="chat.setSkillEnabled(s.id, !s.isEnabled)" />
        <i></i>
      </label>
      <span class="sinfo">
        <span class="sname">{{ s.name }}</span>
        <span class="sdesc t-aux">{{ s.description || '没有描述' }}</span>
      </span>
      <span v-if="s.useCount" class="f-tag tnum">用过 {{ s.useCount }} 次</span>
      <template v-if="confirming === s.id">
        <span class="f-confirm">删掉？</span>
        <button class="f-btn danger" type="button" @click="onDelete(s.id)">确认删除</button>
        <button class="f-btn ghost" type="button" @click="confirming = ''">取消</button>
      </template>
      <button v-else class="f-btn danger" type="button" title="删除技能" @click="confirming = s.id">
        <UiIcon name="trash" :size="14" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.irow { display: flex; gap: var(--sp-3); align-items: center; }
.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
.taskline { margin: 0; color: var(--c-ok); }
.taskline.bad { color: var(--c-err); }
.fails { margin: 0; padding-left: 1.2em; color: var(--c-err); }
.srow {
  display: flex; align-items: center; gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4); background: var(--c-bg);
  border: 1px solid var(--c-line); border-radius: var(--r-s);
}
.sinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.sname { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.sdesc { color: var(--c-ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
code { font-family: var(--f-mono); background: var(--c-bg-2); padding: 1px 5px; border-radius: 4px; }
</style>
