<script setup lang="ts">
/** T5：助手管理。助手 = 一份预设（人设规则 + 绑定模型 + 技能集 + 开场白）。
 *  欢迎页的助手卡读的就是这份目录，改这里那边立刻变（assistants.changed 广播回流）。 */
import { onMounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import UiIcon from './UiIcon.vue';

const chat = useChat();
onMounted(() => { void chat.refreshAssistants(); });

const editing = ref('');           // ''=列表；'new'=新建；其余=编辑该 id
const confirming = ref('');
const fName = ref(''); const fAvatar = ref('🤖'); const fRules = ref('');
const fModel = ref(''); const fPrompts = ref('');
const err = ref('');

const EMOJIS = ['🤖', '📝', '📊', '🎨', '🔍', '🧮', '📮', '🗂️', '🧪', '⚙️', '📚', '💡'];

function startNew(): void {
  editing.value = 'new'; confirming.value = ''; err.value = '';
  fName.value = ''; fAvatar.value = '🤖'; fRules.value = ''; fModel.value = ''; fPrompts.value = '';
}
function startEdit(id: string): void {
  const a = chat.assistants.find(x => x.id === id);
  if (!a) return;
  editing.value = id; confirming.value = ''; err.value = '';
  fName.value = a.name; fAvatar.value = a.avatar || '🤖'; fRules.value = a.rules;
  fModel.value = a.modelBinding ?? '';
  // 开场白一行一条：数组编辑器在这个规模下是过度设计，一个 textarea 更好用
  fPrompts.value = (a.prompts ?? []).join('\n');
}
async function save(): Promise<void> {
  err.value = '';
  const input = {
    name: fName.value.trim(), avatar: fAvatar.value, rules: fRules.value,
    modelBinding: fModel.value || undefined,
    prompts: fPrompts.value.split('\n').map(s => s.trim()).filter(Boolean),
  };
  try {
    if (editing.value === 'new') await chat.createAssistant(input);
    else await chat.updateAssistant(editing.value, input);
    editing.value = '';
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
async function onDelete(id: string): Promise<void> {
  err.value = '';
  try { await chat.deleteAssistant(id); confirming.value = ''; if (editing.value === id) editing.value = ''; }
  catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
async function startWith(id: string): Promise<void> { await chat.newSessionWithAssistant(id); }

/** 图标底色由 id 派生（与欢迎页同一算法，两处颜色必须一致，否则同一个助手在两页是两个颜色）。 */
function avaStyle(id: string): Record<string, string> {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return { background: `oklch(0.93 0.07 ${h})`, color: `oklch(0.45 0.14 ${h})` };
}
</script>

<template>
  <div class="scroll">
    <div class="col">
      <header class="head">
        <div class="htxt">
          <h1 class="t-h1">助手</h1>
          <p class="t-body sub">一份预设：人设规则 + 绑定模型 + 开场白。欢迎页的卡片读的就是这里。</p>
        </div>
        <button v-if="editing !== 'new'" class="f-btn primary" type="button" @click="startNew">
          <UiIcon name="plus" :size="14" />新建助手
        </button>
      </header>

      <p v-if="err" class="errline">{{ err }}</p>

      <form v-if="editing" class="f-card" @submit.prevent="save">
        <div class="f-grid">
          <label class="f-label">
            <span>名称</span>
            <input v-model="fName" class="f-input" placeholder="如「文案助手」" required />
          </label>
          <label class="f-label">
            <span>绑定模型（可选）</span>
            <select v-model="fModel" class="f-select">
              <option value="">用当前默认</option>
              <option v-for="p in chat.providers" :key="p.id" :value="p.id">{{ p.name }} · {{ p.modelId }}</option>
            </select>
          </label>
        </div>
        <label class="f-label">
          <span>图标</span>
          <span class="emojis">
            <button
              v-for="e in EMOJIS" :key="e" type="button" class="emo" :class="{ on: fAvatar === e }"
              @click="fAvatar = e"
            >{{ e }}</button>
          </span>
        </label>
        <label class="f-label">
          <span>规则</span>
          <textarea v-model="fRules" class="f-area" placeholder="写清楚它是谁、按什么风格做事、有什么禁忌。这段会放进每轮对话的系统提示。"></textarea>
        </label>
        <label class="f-label">
          <span>开场白（一行一条）</span>
          <textarea v-model="fPrompts" class="f-area" placeholder="帮我把这段话改成正式一点的书面语&#10;检查这份文档有没有前后矛盾的地方"></textarea>
          <span class="f-hint">选中这个助手后，欢迎页会把它们列成可点的开场。</span>
        </label>
        <div class="f-row">
          <button class="f-btn primary" type="submit">{{ editing === 'new' ? '创建' : '保存' }}</button>
          <button class="f-btn ghost" type="button" @click="editing = ''">取消</button>
        </div>
      </form>

      <div v-if="!chat.assistants.length && !editing" class="blank">
        <UiIcon name="robot" :size="26" />
        <p class="t-h2">还没有助手</p>
        <p class="t-body sub">给常做的事各建一个预设，就不用每次重复交代背景了。</p>
        <button class="f-btn primary" type="button" @click="startNew">新建助手</button>
      </div>

      <div v-for="a in chat.assistants" :key="a.id" class="acard">
        <span class="ava" :style="avaStyle(a.id)">{{ a.avatar || '🤖' }}</span>
        <div class="abody">
          <div class="atop">
            <span class="aname">{{ a.name }}</span>
            <span v-if="a.modelBinding" class="f-tag">{{ chat.providers.find(p => p.id === a.modelBinding)?.name ?? '已绑模型' }}</span>
            <span v-if="a.prompts?.length" class="f-tag">{{ a.prompts.length }} 条开场</span>
          </div>
          <p class="arules t-aux">{{ a.rules || '没有额外规则' }}</p>
        </div>
        <div class="aacts">
          <button class="f-btn ghost" type="button" title="用它开一个会话" @click="startWith(a.id)"><UiIcon name="chat" :size="14" /></button>
          <button class="f-btn ghost" type="button" title="编辑" @click="startEdit(a.id)"><UiIcon name="pencil" :size="14" /></button>
          <template v-if="confirming === a.id">
            <span class="f-confirm">删掉？</span>
            <button class="f-btn danger" type="button" @click="onDelete(a.id)">确认</button>
            <button class="f-btn ghost" type="button" @click="confirming = ''">取消</button>
          </template>
          <button v-else class="f-btn danger" type="button" title="删除" @click="confirming = a.id"><UiIcon name="trash" :size="14" /></button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scroll { flex: 1; min-height: 0; overflow-y: auto; background: var(--c-bg); }
.col {
  width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto;
  padding: var(--sp-8) 0; display: flex; flex-direction: column; gap: var(--sp-6);
}
.head { display: flex; align-items: flex-start; gap: var(--sp-5); }
.htxt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.head h1 { margin: 0; color: var(--c-ink); }
.sub { margin: 0; color: var(--c-ink-3); }

.emojis { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.emo {
  width: var(--h-round); height: var(--h-round); border-radius: var(--r-s); cursor: pointer;
  font-size: 17px; line-height: 1; background: var(--c-bg-2); font-family: inherit;
}
.emo.on { background: var(--c-brand-soft); box-shadow: inset 0 0 0 1px var(--c-brand); }

.blank {
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-3);
  padding: var(--sp-8); text-align: center; color: var(--c-ink-3);
  background: var(--c-bg-1); border-radius: var(--r-m);
}
.blank p { margin: 0; }
.blank .t-h2 { color: var(--c-ink); }

.acard {
  display: flex; align-items: flex-start; gap: var(--sp-4);
  padding: var(--sp-5); background: var(--c-bg);
  border: 1px solid var(--c-line); border-radius: var(--r-m);
}
.ava {
  width: 38px; height: 38px; flex: 0 0 auto; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center; font-size: 18px; line-height: 1;
}
.abody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.atop { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.aname { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.arules {
  margin: 0; color: var(--c-ink-2);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.aacts { display: flex; align-items: center; gap: var(--sp-1); flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; max-width: 200px; }
.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
</style>
