<script setup lang="ts">
/** 设置 · 助手管理（J2，设计稿 2026-08-20-assistants §5）——列表 + 新建/编辑表单 + 删除二次确认。
 *  模型选择写 'provider:' 前缀值（chat.prompt 解析只认前缀——J2 随动修缺的同一约定）；
 *  技能复选数据源是 allSkills（管理页要看得见禁用项，与斜杠菜单的 skills 不是一回事）。
 *  删助手不影响已绑会话（绑定悬空、会话继续可用）——文案在删除确认里说清。 */
import { computed, ref } from 'vue';
import { useChat } from '../stores/chat';

const chat = useChat();

/** 编辑态：''=列表态；'new'=新建；其余=编辑该 id。行内表单不弹层（.list overflow 裁浮层的老坑）。 */
const editing = ref('');
const confirmDelete = ref('');
const fName = ref(''); const fAvatar = ref(''); const fRules = ref('');
const fModel = ref(''); const fSkills = ref<string[]>([]); const fPrompts = ref('');
const formErr = ref('');

const modelOptions = computed(() => chat.providers.map(p => ({ value: 'provider:' + p.id, label: p.name })));

function startNew(): void {
  editing.value = 'new'; confirmDelete.value = '';
  fName.value = ''; fAvatar.value = ''; fRules.value = ''; fModel.value = '';
  fSkills.value = []; fPrompts.value = ''; formErr.value = '';
}
function startEdit(id: string): void {
  const a = chat.assistants.find(x => x.id === id);
  if (!a) return;
  editing.value = id; confirmDelete.value = '';
  fName.value = a.name; fAvatar.value = a.avatar; fRules.value = a.rules;
  fModel.value = a.modelBinding ?? '';
  fSkills.value = [...a.skillIds];
  fPrompts.value = a.prompts.join('\n');
  formErr.value = '';
}
function toggleSkill(id: string): void {
  fSkills.value = fSkills.value.includes(id) ? fSkills.value.filter(x => x !== id) : [...fSkills.value, id];
}
async function save(): Promise<void> {
  formErr.value = '';
  const input = {
    name: fName.value, avatar: fAvatar.value, rules: fRules.value,
    modelBinding: fModel.value, skillIds: fSkills.value,
    prompts: fPrompts.value.split('\n').map(s => s.trim()).filter(Boolean),
  };
  try {
    if (editing.value === 'new') await chat.createAssistant(input);
    else await chat.updateAssistant(editing.value, input);
    editing.value = '';
  } catch (e) { formErr.value = e instanceof Error ? e.message : String(e); }
}
async function onDelete(id: string): Promise<void> {
  try {
    await chat.deleteAssistant(id);
    confirmDelete.value = '';
    if (editing.value === id) editing.value = '';
  } catch (e) { formErr.value = e instanceof Error ? e.message : String(e); }
}
/** 列表行摘要：模型名（解析前缀查 provider）+ 技能数 */
function modelLabel(a: { modelBinding?: string }): string {
  if (!a.modelBinding) return '跟随全局';
  const pid = a.modelBinding.startsWith('provider:') ? a.modelBinding.slice('provider:'.length) : a.modelBinding;
  return chat.providers.find(p => p.id === pid)?.name ?? '（模型已删）';
}
</script>

<template>
  <div class="apage">
    <div class="ahint">
      助手 = 命名预设：规则追加进系统提示词，默认技能与模型在<strong>新建会话时</strong>应用。
      改助手规则对已有会话下一轮生效；改技能/模型勾选只影响之后新建的会话。
    </div>

    <div v-for="a in chat.assistants" :key="a.id" class="arow">
      <span class="aravatar">{{ a.avatar || '🤖' }}</span>
      <div class="artxt">
        <div class="arname">{{ a.name }}</div>
        <div class="arsub">{{ modelLabel(a) }} · 技能 {{ a.skillIds.length ? a.skillIds.length + ' 项' : '跟随全局' }} · 示例 {{ a.prompts.length }} 条</div>
      </div>
      <button class="arbtn" type="button" @click="startEdit(a.id)">编辑</button>
      <template v-if="confirmDelete !== a.id">
        <button class="arbtn danger" type="button" @click="confirmDelete = a.id">删除</button>
      </template>
      <template v-else>
        <button class="arbtn" type="button" @click="confirmDelete = ''">取消</button>
        <button class="arbtn danger" type="button" title="已用该助手建的会话不受影响" @click="onDelete(a.id)">确认删除</button>
      </template>
    </div>
    <div v-if="!chat.assistants.length" class="ahint">还没有助手。新建一个，把常用的规则、技能与模型打包成一键预设。</div>

    <button v-if="!editing" class="newbtn" type="button" @click="startNew()">＋ 新建助手</button>

    <div v-if="editing" class="aform">
      <div class="aftitle">{{ editing === 'new' ? '新建助手' : '编辑助手' }}</div>
      <div class="afrow2">
        <input v-model="fAvatar" class="afinput femoji" type="text" placeholder="🤖" title="emoji 头像" />
        <input v-model="fName" class="afinput" type="text" placeholder="助手名称（必填，50 字内）" />
      </div>
      <textarea v-model="fRules" class="afarea" rows="5" placeholder="规则（追加进系统提示词）：这个助手是谁、怎么做事、有什么红线…"></textarea>
      <label class="aflabel">默认模型
        <select v-model="fModel" class="afselect">
          <option value="">跟随全局默认</option>
          <option v-for="o in modelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <div class="aflabel">默认技能（不勾任何项 = 跟随全局启用集；勾选 = 该助手的会话只启用勾选技能）</div>
      <div v-if="chat.allSkills.length" class="afskills">
        <label v-for="s in chat.allSkills" :key="s.id" class="afskill" :title="s.description">
          <input type="checkbox" :checked="fSkills.includes(s.id)" @change="toggleSkill(s.id)" />
          <span>{{ s.name }}</span><span v-if="!s.isEnabled" class="afoff">（全局已停用）</span>
        </label>
      </div>
      <div v-else class="ahint">尚未安装任何技能——技能页导入或扩展市场安装后可在此勾选。</div>
      <textarea v-model="fPrompts" class="afarea" rows="3" placeholder="示例指令（每行一条，最多 8 条）——显示在该助手的欢迎页上"></textarea>
      <div v-if="formErr" class="aferr">{{ formErr }}</div>
      <div class="afops">
        <button class="arbtn" type="button" @click="editing = ''">取消</button>
        <button class="afsave" type="button" @click="save()">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.apage { display: flex; flex-direction: column; gap: 8px; }
.ahint { font-size: var(--fs-caption); color: var(--label-tertiary); line-height: 1.6; padding: 2px 2px 6px; }
.ahint strong { color: var(--label-secondary); }
.arow {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border: 1px solid var(--separator); border-radius: var(--r-card); background: var(--surface-1);
  box-shadow: 0 2px 8px var(--shadow-color);
}
.aravatar { flex: 0 0 auto; font-size: 18px; }
.artxt { flex: 1; min-width: 0; }
.arname { font-size: var(--fs-ui); font-weight: var(--fw-strong); color: var(--label); }
.arsub { font-size: var(--fs-micro); color: var(--label-tertiary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arbtn {
  flex: 0 0 auto; padding: 5px 10px; border: 1px solid var(--separator); border-radius: var(--r-control);
  background: var(--surface-1); color: var(--label-secondary); font-size: var(--fs-micro); cursor: pointer;
}
.arbtn:hover { background: var(--fill-quaternary); color: var(--label); }
.arbtn.danger { color: var(--state-err); }
.arbtn.danger:hover { background: var(--state-err-bg); }
.arbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.newbtn {
  align-self: flex-start; margin-top: 4px; padding: 7px 14px; border: none; border-radius: var(--r-control);
  background: var(--accent); color: var(--on-action); font-size: var(--fs-ui); font-weight: var(--fw-medium); cursor: pointer;
}
.newbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.aform {
  margin-top: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--separator); border-radius: var(--r-card); background: var(--surface-1);
}
.aftitle { font-size: var(--fs-ui); font-weight: 700; color: var(--label); }
.afrow2 { display: flex; gap: 8px; }
.femoji { flex: 0 0 56px; text-align: center; }
.afinput, .afselect, .afarea {
  flex: 1; min-width: 0; padding: 7px 9px; border: 1px solid var(--separator); border-radius: var(--r-control);
  background: var(--bg-tertiary); color: var(--label); font-size: var(--fs-ui); font-family: var(--font-ui);
}
.afarea { resize: vertical; line-height: 1.6; }
.afinput:focus-visible, .afselect:focus-visible, .afarea:focus-visible { outline: 2px solid var(--ring-input); outline-offset: 1px; }
.aflabel { display: flex; align-items: center; gap: 10px; font-size: var(--fs-caption); color: var(--label-secondary); }
.aflabel .afselect { flex: 0 1 260px; }
.afskills { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 2px 0; }
.afskill { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-caption); color: var(--label-secondary); cursor: pointer; }
.afskill input:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.afoff { color: var(--label-quaternary); }
.aferr { font-size: var(--fs-micro); color: var(--state-err); line-height: 1.5; }
.afops { display: flex; justify-content: flex-end; gap: 8px; }
.afsave {
  padding: 6px 16px; border: none; border-radius: var(--r-control);
  background: var(--accent); color: var(--on-action); font-size: var(--fs-ui); font-weight: var(--fw-medium); cursor: pointer;
}
.afsave:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
</style>
