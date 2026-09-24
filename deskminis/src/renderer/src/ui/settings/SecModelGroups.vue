<script setup lang="ts">
/** Z4：模型组编辑器（设置 → 模型，挂在 provider 列表之后）。
 *  后端 M2b 就全了（modelgroup.* 五个 RPC + group: 绑定 + 降级链），界面从来没有过——
 *  README 挂了好几波的最后一行 🟡。
 *
 *  三条从后端事实推出来的约束（设计稿 2026-09-24 §0）：
 *  ① 成员是**有序**的：第一个为主，出错按序往下换——所以要能上移下移，不是一组无序勾选框；
 *  ② modelgroup.update 对空 memberIds **静默忽略**（保留旧成员）——空成员必须在这里拦，否则界面谎报已保存；
 *  ③ 降级成功后会话会**改绑**到接手的模型、不再回组（M2b 的刻意设计）——编辑器必须把这句说清。 */
import { computed, onMounted, ref } from 'vue';
import { useChat } from '../../stores/chat';
import { groupChain } from '../../lib/models/binding';
import UiIcon from '../UiIcon.vue';

const chat = useChat();
const editing = ref('');          // ''=列表；'new'=新建；其余=编辑该 id
const confirming = ref('');
const fName = ref('');
const fMembers = ref<string[]>([]);
const pick = ref('');             // 「加入」下拉当前选中的 provider id
const err = ref('');

/** 进页重拉一次：init 那次拉取失败时是不报错的（不该拖垮启动），这里要把错误显示出来。 */
async function refresh(): Promise<void> {
  try { await chat.refreshModelGroups(); }
  catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
onMounted(refresh);

/** 加入下拉只列还没进组的 provider（同一个模型排两次没有意义，后端也不拦）。 */
const addable = computed(() => chat.providers.filter(p => !fMembers.value.includes(p.id)));
const provOf = (id: string) => chat.providers.find(p => p.id === id);

function startNew(): void {
  editing.value = 'new'; confirming.value = ''; err.value = '';
  fName.value = ''; fMembers.value = []; pick.value = '';
}
function startEdit(id: string): void {
  const g = chat.modelGroups.find(x => x.id === id);
  if (!g) return;
  editing.value = id; confirming.value = ''; err.value = '';
  // 已删的成员也原样带进来并标出——保存的就是看到的，不在用户背后悄悄清理
  fName.value = g.name; fMembers.value = [...g.memberIds]; pick.value = '';
}
function cancel(): void { editing.value = ''; err.value = ''; }
function addMember(): void {
  if (!pick.value || fMembers.value.includes(pick.value)) return;
  fMembers.value = [...fMembers.value, pick.value];
  pick.value = '';
}
function moveMember(i: number, d: -1 | 1): void {
  const j = i + d;
  if (j < 0 || j >= fMembers.value.length) return;
  const next = [...fMembers.value];
  [next[i], next[j]] = [next[j], next[i]];
  fMembers.value = next;
}
function removeMember(i: number): void {
  fMembers.value = fMembers.value.filter((_, k) => k !== i);
}
async function save(): Promise<void> {
  err.value = '';
  const name = fName.value.trim();
  if (!name) { err.value = '给模型组起个名字'; return; }
  // 后端对空 memberIds 静默忽略——不在这里拦，就是「点了保存、界面说好了、其实没改」
  if (!fMembers.value.length) { err.value = '至少选一个模型'; return; }
  try {
    if (editing.value === 'new') await chat.createModelGroup(name, fMembers.value);
    else await chat.updateModelGroup(editing.value, { name, memberIds: fMembers.value });
    editing.value = '';
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}

/** 删除前先数绑定：后端不级联解绑，绑着这个组的会话与助手之后发消息会报「模型组无可用成员」。 */
function boundOf(id: string): { sessions: number; assistants: number } {
  return {
    sessions: chat.sessions.filter(s => s.modelBinding === 'group:' + id).length,
    assistants: chat.assistants.filter(a => a.modelBinding === 'group:' + id).length,
  };
}
function usedText(id: string): string {
  const b = boundOf(id);
  return [b.sessions ? `${b.sessions} 个会话` : '', b.assistants ? `${b.assistants} 个助手` : ''].filter(Boolean).join('、');
}
function deleteAsk(id: string): string {
  const who = usedText(id);
  return who
    ? `${who}绑定了它；删除后它们发消息会报「模型组无可用成员」，需要重新绑定。`
    : '删掉这个模型组？';
}
async function onDelete(id: string): Promise<void> {
  err.value = '';
  try {
    await chat.deleteModelGroup(id);
    confirming.value = '';
    if (editing.value === id) editing.value = '';
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
</script>

<template>
  <section class="f-sec">
    <h2>模型组</h2>
    <p class="f-note">把几个模型排成一个顺序；会话或助手绑定到组后，排第一的出错就自动换下一个。</p>

    <p v-if="err && !editing" class="errline">{{ err }}</p>

    <div v-if="!chat.modelGroups.length && !editing" class="blank">
      <p class="t-body sub">
        {{ chat.providers.length >= 2 ? '还没有模型组。常见用法：主力模型限流或密钥失效时，自动切到备用的那个。' : '先在上面添加至少两个模型，组才有降级可言。' }}
      </p>
      <button v-if="chat.providers.length" class="f-btn" type="button" @click="startNew">
        <UiIcon name="plus" :size="14" />新建模型组
      </button>
    </div>

    <div v-for="g in chat.modelGroups" :key="g.id" class="gcard">
      <div class="gtop">
        <span class="ginfo">
          <span class="gname">{{ g.name }}</span>
          <span class="gchain t-aux">{{ groupChain(g, chat.providers).names.join(' → ') }}</span>
        </span>
        <span v-if="groupChain(g, chat.providers).live === 0" class="f-tag err">无可用成员</span>
        <span v-else-if="usedText(g.id)" class="f-tag">{{ usedText(g.id) }}在用</span>
        <button class="f-btn ghost" type="button" @click="startEdit(g.id)">编辑</button>
        <button v-if="confirming !== g.id" class="f-btn danger" type="button" @click="confirming = g.id">删除</button>
      </div>
      <div v-if="confirming === g.id" class="gask">
        <span class="f-confirm">{{ deleteAsk(g.id) }}</span>
        <span class="f-row">
          <button class="f-btn danger" type="button" @click="onDelete(g.id)">确认删除</button>
          <button class="f-btn ghost" type="button" @click="confirming = ''">取消</button>
        </span>
      </div>
    </div>

    <button v-if="chat.modelGroups.length && !editing" class="f-btn" type="button" @click="startNew">
      <UiIcon name="plus" :size="14" />新建模型组
    </button>

    <form v-if="editing" class="f-card" @submit.prevent="save">
      <label class="f-label">
        <span>名称</span>
        <input v-model="fName" class="f-input" placeholder="如「主力 + 备用」" />
      </label>

      <!-- 外层 div 不用 label：里面有多个按钮与一个下拉，label 只能关联一个控件 -->
      <div class="f-label">
        <span>成员（按顺序使用）</span>
        <ol v-if="fMembers.length" class="mlist">
          <li v-for="(id, i) in fMembers" :key="id" class="mrow" :class="{ gone: !provOf(id) }">
            <span class="mnum tnum">{{ i + 1 }}</span>
            <span class="mname">{{ provOf(id)?.name ?? '（已删除的模型）' }}</span>
            <span class="mrole t-aux">{{ i === 0 ? '主' : '备用' }}{{ provOf(id)?.modelId ? ' · ' + provOf(id)?.modelId : '' }}</span>
            <button class="ib" type="button" title="上移" :disabled="i === 0" @click="moveMember(i, -1)"><UiIcon name="chevronUp" :size="14" /></button>
            <button class="ib" type="button" title="下移" :disabled="i === fMembers.length - 1" @click="moveMember(i, 1)"><UiIcon name="chevronDown" :size="14" /></button>
            <button class="ib" type="button" title="移出" @click="removeMember(i)"><UiIcon name="x" :size="14" /></button>
          </li>
        </ol>
        <span v-else class="f-hint">还没有成员——从下面加入。</span>
        <span v-if="addable.length" class="addrow">
          <select v-model="pick" class="f-select">
            <option value="">选一个模型加入…</option>
            <option v-for="p in addable" :key="p.id" :value="p.id">{{ p.name }}{{ p.modelId ? ' · ' + p.modelId : '' }}</option>
          </select>
          <button class="f-btn" type="button" :disabled="!pick" @click="addMember">加入</button>
        </span>
        <span v-if="fMembers.length === 1" class="f-hint">只有一个成员时不会降级，效果和直接选这个模型一样。</span>
      </div>

      <p class="f-hint">按顺序使用：排第一的出错时自动换下一个。限流、密钥失效、请求被拒会立刻换；网络中断和服务端 5xx 先在原模型上重试约一分钟再换。</p>
      <p class="f-hint">换成功后，这个会话会改绑到接手的模型，之后不再回到组里；想回到组，在会话菜单里重新选它。</p>

      <p v-if="err" class="errline">{{ err }}</p>
      <div class="f-row">
        <button class="f-btn primary" type="submit">{{ editing === 'new' ? '创建' : '保存' }}</button>
        <button class="f-btn ghost" type="button" @click="cancel">取消</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.blank {
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-3);
  padding: var(--sp-6); text-align: center; color: var(--c-ink-3);
  background: var(--c-bg-1); border-radius: var(--r-m);
}
.blank p { margin: 0; }
.blank .sub { max-width: 380px; }

.gcard {
  display: flex; flex-direction: column; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--c-line); border-radius: var(--r-s); background: var(--c-bg);
}
.gtop { display: flex; align-items: center; gap: var(--sp-4); }
.ginfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.gname { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.gchain { color: var(--c-ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gask { display: flex; align-items: center; gap: var(--sp-4); flex-wrap: wrap; padding-top: var(--sp-3); border-top: 1px solid var(--c-line); }
.gask .f-confirm { flex: 1; min-width: 240px; line-height: var(--t-aux-lh); }

.mlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.mrow {
  display: flex; align-items: center; gap: var(--sp-3);
  height: var(--h-field); padding: 0 var(--sp-2) 0 var(--sp-3);
  border-radius: var(--r-s); background: var(--c-bg-1);
}
.mnum {
  width: 20px; height: 20px; flex: 0 0 auto; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: var(--t-aux-size); background: var(--c-brand-soft); color: var(--c-brand);
}
.mname { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-ink); font-weight: var(--w-md); font-size: var(--t-item-size); }
.mrole { flex: 1; min-width: 0; color: var(--c-ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--f-mono); }
.mrow.gone .mname { color: var(--c-err); }
.mrow.gone .mnum { background: var(--c-err-soft); color: var(--c-err); }
.ib {
  width: var(--h-ctl); height: var(--h-ctl); flex: 0 0 auto; border-radius: var(--r-s);
  display: inline-flex; align-items: center; justify-content: center;
  background: none; color: var(--c-ink-3); cursor: pointer; padding: 0;
}
.ib:hover { background: var(--c-bg-2); color: var(--c-ink); }
.ib:disabled { opacity: .35; cursor: default; }
.ib:disabled:hover { background: none; color: var(--c-ink-3); }
.addrow { display: flex; gap: var(--sp-3); align-items: center; }
.addrow .f-select { flex: 1; min-width: 0; }

.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
</style>
