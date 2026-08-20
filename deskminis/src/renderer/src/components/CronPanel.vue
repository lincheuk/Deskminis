<script setup lang="ts">
/** 工作台 · 定时任务面板（K2，设计稿 2026-08-20-cron-design.md §5）。
 *  列表（人话调度/下次运行/上次状态 + 最近会话跳转/启停/立即运行/删除二次确认）+
 *  行内新建/编辑表单（浮层会被面板 overflow 裁掉——MU5 §15 老坑，行内展开成例）。
 *  运行边界与权限语义常驻面板头：不假装 24/7、不静默扩权（设计稿 §0 两裁定的用户可见面）。 */
import { onMounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import { describeSchedule } from '../lib/cron/describe';
import Icon from './Icon.vue';

const chat = useChat();
onMounted(() => { void chat.refreshCronJobs(); });

const editing = ref('');        // ''=列表态；'new'=新建；其余=编辑该 id
const confirmDelete = ref('');
const fName = ref(''); const fPrompt = ref('');
const fKind = ref<'interval' | 'once' | 'cron'>('interval');
const fInterval = ref('30'); const fOnce = ref(''); const fCron = ref('0 9 * * *');
const fAssistant = ref(''); const fWorkspace = ref('');
const formErr = ref('');

function startNew(): void {
  editing.value = 'new'; confirmDelete.value = ''; formErr.value = '';
  fName.value = ''; fPrompt.value = ''; fKind.value = 'interval';
  fInterval.value = '30'; fOnce.value = ''; fCron.value = '0 9 * * *';
  fAssistant.value = ''; fWorkspace.value = '';
}
function startEdit(id: string): void {
  const j = chat.cronJobs.find(x => x.id === id);
  if (!j) return;
  editing.value = id; confirmDelete.value = ''; formErr.value = '';
  fName.value = j.name; fPrompt.value = j.prompt; fKind.value = j.scheduleKind;
  fInterval.value = j.scheduleKind === 'interval' ? j.scheduleValue : '30';
  fCron.value = j.scheduleKind === 'cron' ? j.scheduleValue : '0 9 * * *';
  // once 的 epoch 秒 → datetime-local 值（本地时区，input 需要的就是本地墙钟）
  fOnce.value = j.scheduleKind === 'once' ? toLocalInput(Number(j.scheduleValue) * 1000) : '';
  fAssistant.value = j.assistantId ?? ''; fWorkspace.value = j.workspaceRoot ?? '';
}
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}
function scheduleValue(): string {
  if (fKind.value === 'interval') return fInterval.value.trim();
  if (fKind.value === 'cron') return fCron.value.trim();
  // datetime-local → epoch 秒；空值交给后端校验报「必须是 epoch 秒数」
  const ms = fOnce.value ? new Date(fOnce.value).getTime() : NaN;
  return String(Math.floor(ms / 1000));
}
async function save(): Promise<void> {
  formErr.value = '';
  const input = {
    name: fName.value, prompt: fPrompt.value,
    scheduleKind: fKind.value, scheduleValue: scheduleValue(),
    assistantId: fAssistant.value || undefined, workspaceRoot: fWorkspace.value || undefined,
  };
  try {
    if (editing.value === 'new') await chat.createCronJob(input);
    else await chat.updateCronJob(editing.value, input);
    editing.value = '';
  } catch (e) { formErr.value = e instanceof Error ? e.message : String(e); }
}
async function toggleEnabled(id: string, enabled: boolean): Promise<void> {
  formErr.value = '';
  try { await chat.updateCronJob(id, { enabled }); }
  catch (e) { formErr.value = e instanceof Error ? e.message : String(e); }
}
async function onDelete(id: string): Promise<void> {
  await chat.deleteCronJob(id);
  confirmDelete.value = '';
  if (editing.value === id) editing.value = '';
}
async function runNow(id: string): Promise<void> {
  formErr.value = '';
  try { await chat.runCronNow(id); }
  catch (e) { formErr.value = e instanceof Error ? e.message : String(e); }
}
function fmtTime(sec?: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
function assistantLabel(id?: string): string {
  if (!id) return '';
  const a = chat.assistants.find(x => x.id === id);
  return a ? `${a.avatar} ${a.name}` : '（助手已删）';
}
function statusTone(s: string): string {
  if (s.startsWith('error')) return 'err';
  if (s === 'ok') return 'ok';
  if (s === 'running' || s.startsWith('running')) return 'run';
  return '';
}
</script>

<template>
  <div class="cpanel">
    <div class="chint">
      定时任务在<strong>应用运行时</strong>生效——DeskMinis 不驻留后台，应用没开就不跑
      （interval/cron 错过跳到下一次，一次性任务开机补跑）。无人值守时权限卡
      <strong>90 秒未响应自动拒绝</strong>、任务以「被拒」继续收尾；要全自动请在设置把
      权限档切到完全访问（全局生效，慎用）。
    </div>

    <div v-for="j in chat.cronJobs" :key="j.id" class="crow" :class="{ off: !j.enabled }">
      <div class="crtxt">
        <div class="crname">
          {{ j.name }}
          <span class="crsched">{{ describeSchedule(j.scheduleKind, j.scheduleValue) }}</span>
          <span v-if="j.assistantId" class="crassist">{{ assistantLabel(j.assistantId) }}</span>
        </div>
        <div class="crsub">
          下次 {{ j.enabled ? fmtTime(j.nextRunAt) : '已停用' }} · 上次 {{ fmtTime(j.lastRunAt) }}
          <span v-if="j.lastStatus" class="crstatus" :class="statusTone(j.lastStatus)">{{ j.lastStatus }}</span>
          <button v-if="j.lastSessionId" class="crjump" type="button" @click="chat.open(j.lastSessionId!)">查看会话</button>
        </div>
      </div>
      <button class="crbtn" type="button" :title="j.enabled ? '停用' : '启用'" @click="toggleEnabled(j.id, !j.enabled)">
        {{ j.enabled ? '停用' : '启用' }}
      </button>
      <button class="crbtn" type="button" title="立即运行一次" @click="runNow(j.id)">运行</button>
      <button class="crbtn" type="button" @click="startEdit(j.id)">编辑</button>
      <template v-if="confirmDelete !== j.id">
        <button class="crbtn danger" type="button" @click="confirmDelete = j.id">删除</button>
      </template>
      <template v-else>
        <button class="crbtn" type="button" @click="confirmDelete = ''">取消</button>
        <button class="crbtn danger" type="button" title="已产生的会话不受影响" @click="onDelete(j.id)">确认删除</button>
      </template>
    </div>
    <div v-if="!chat.cronJobs.length" class="chint">
      还没有定时任务。建一个让 DeskMinis 定点干活：巡检目录、生成日报、跑清理脚本……
    </div>

    <button v-if="!editing" class="cnew" type="button" @click="startNew()"><Icon name="clock" :size="14" /> 新建定时任务</button>

    <div v-if="editing" class="cform">
      <div class="cftitle">{{ editing === 'new' ? '新建定时任务' : '编辑定时任务' }}</div>
      <input v-model="fName" class="cfinput" type="text" placeholder="任务名称（必填，50 字内）" />
      <textarea v-model="fPrompt" class="cfarea" rows="3" placeholder="触发时发给 agent 的指令，例：检查工作区里的 TODO.md，把逾期项整理成清单"></textarea>
      <div class="cfrow">
        <select v-model="fKind" class="cfselect">
          <option value="interval">每隔 N 分钟</option>
          <option value="once">指定时刻一次</option>
          <option value="cron">cron 表达式</option>
        </select>
        <input v-if="fKind === 'interval'" v-model="fInterval" class="cfinput" type="number" min="5" placeholder="分钟数（≥5）" />
        <input v-else-if="fKind === 'once'" v-model="fOnce" class="cfinput" type="datetime-local" />
        <input v-else v-model="fCron" class="cfinput mono" type="text" placeholder="分 时 日 月 周，如 0 9 * * 1-5" />
      </div>
      <div v-if="fKind === 'cron'" class="cfhint">五段：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-7)；支持 * 、*/n、a-b、逗号列表；日/周同限任一命中即触发。预览：{{ describeSchedule('cron', fCron) }}</div>
      <div class="cfrow">
        <select v-model="fAssistant" class="cfselect">
          <option value="">不用助手</option>
          <option v-for="a in chat.assistants" :key="a.id" :value="a.id">{{ a.avatar }} {{ a.name }}</option>
        </select>
        <input v-model="fWorkspace" class="cfinput" type="text" placeholder="工作区目录（可选，缺省用全局上次目录）" />
      </div>
      <div v-if="formErr" class="cferr">{{ formErr }}</div>
      <div class="cfops">
        <button class="crbtn" type="button" @click="editing = ''">取消</button>
        <button class="cfsave" type="button" @click="save()">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cpanel { flex: 1; min-height: 0; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: var(--bg); }
.chint { font-size: var(--fs-caption); color: var(--label-tertiary); line-height: 1.7; padding: 2px 2px 4px; }
.chint strong { color: var(--label-secondary); }
.crow {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border: 1px solid var(--separator); border-radius: var(--r-card); background: var(--surface-1);
  box-shadow: 0 2px 8px var(--shadow-color);
}
.crow.off { opacity: .68; }
.crtxt { flex: 1; min-width: 0; }
.crname { font-size: var(--fs-ui); font-weight: 600; color: var(--label); display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.crsched { font-size: var(--fs-micro); font-weight: 500; color: var(--accent); font-family: var(--font-mono); }
.crassist { font-size: var(--fs-micro); font-weight: 500; color: var(--label-tertiary); }
.crsub { margin-top: 3px; font-size: var(--fs-micro); color: var(--label-tertiary); display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.crstatus { font-family: var(--font-mono); }
.crstatus.ok { color: var(--state-ok); }
.crstatus.err { color: var(--state-err); }
.crstatus.run { color: var(--accent); }
.crjump { border: none; background: none; padding: 0; font-size: var(--fs-micro); color: var(--link); cursor: pointer; }
.crjump:hover { text-decoration: underline; }
.crjump:focus-visible, .crbtn:focus-visible, .cnew:focus-visible, .cfsave:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.crbtn {
  flex: 0 0 auto; padding: 5px 10px; border: 1px solid var(--separator); border-radius: var(--r-control);
  background: var(--surface-1); color: var(--label-secondary); font-size: var(--fs-micro); cursor: pointer; white-space: nowrap;
}
.crbtn:hover { background: var(--fill-quaternary); color: var(--label); }
.crbtn.danger { color: var(--state-err); }
.crbtn.danger:hover { background: var(--state-err-bg); }
.cnew {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 6px;
  margin-top: 2px; padding: 7px 14px; border: none; border-radius: var(--r-control);
  background: var(--accent); color: var(--on-action); font-size: var(--fs-ui); font-weight: 600; cursor: pointer;
}
.cnew :deep(svg) { stroke: currentColor; }
.cform {
  margin-top: 4px; padding: 12px; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--separator); border-radius: var(--r-card); background: var(--surface-1);
}
.cftitle { font-size: var(--fs-ui); font-weight: 700; color: var(--label); }
.cfrow { display: flex; gap: 8px; }
.cfrow .cfselect { flex: 0 0 168px; }
.cfinput, .cfselect, .cfarea {
  flex: 1; min-width: 0; padding: 7px 9px; border: 1px solid var(--separator); border-radius: var(--r-control);
  background: var(--bg-tertiary); color: var(--label); font-size: var(--fs-ui); font-family: var(--font-ui);
}
.cfinput.mono { font-family: var(--font-mono); }
.cfarea { resize: vertical; line-height: 1.6; }
.cfinput:focus-visible, .cfselect:focus-visible, .cfarea:focus-visible { outline: 2px solid var(--ring-input); outline-offset: 1px; }
.cfhint { font-size: var(--fs-micro); color: var(--label-quaternary); line-height: 1.6; }
.cferr { font-size: var(--fs-micro); color: var(--state-err); line-height: 1.5; }
.cfops { display: flex; justify-content: flex-end; gap: 8px; }
.cfsave {
  padding: 6px 16px; border: none; border-radius: var(--r-control);
  background: var(--accent); color: var(--on-action); font-size: var(--fs-ui); font-weight: 600; cursor: pointer;
}
</style>
