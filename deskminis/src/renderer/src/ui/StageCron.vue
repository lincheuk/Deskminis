<script setup lang="ts">
/** T5：定时任务。逻辑照搬旧面板（调度值三态转换、once 的本地墙钟 ↔ epoch 秒），
 *  版面重做成「舞台页」而不是右栏窄面板——定时任务是要读 prompt 全文的东西。
 *
 *  运行边界常驻页头：**应用没开就不会跑**。不写清楚的话，用户会以为它是 24/7 服务，
 *  错过一次就来问「为什么没执行」。 */
import { onMounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import { describeSchedule } from '../lib/cron/describe';
import UiIcon from './UiIcon.vue';

const chat = useChat();
onMounted(() => { void chat.refreshCronJobs(); });

const editing = ref('');          // ''=列表态；'new'=新建；其余=编辑该 id
const confirming = ref('');
const fName = ref(''); const fPrompt = ref('');
const fKind = ref<'interval' | 'once' | 'cron'>('interval');
const fInterval = ref('30'); const fOnce = ref(''); const fCron = ref('0 9 * * *');
const fAssistant = ref(''); const fWorkspace = ref('');
const err = ref('');

function startNew(): void {
  editing.value = 'new'; confirming.value = ''; err.value = '';
  fName.value = ''; fPrompt.value = ''; fKind.value = 'interval';
  fInterval.value = '30'; fOnce.value = ''; fCron.value = '0 9 * * *';
  fAssistant.value = ''; fWorkspace.value = '';
}
function startEdit(id: string): void {
  const j = chat.cronJobs.find(x => x.id === id);
  if (!j) return;
  editing.value = id; confirming.value = ''; err.value = '';
  fName.value = j.name; fPrompt.value = j.prompt; fKind.value = j.scheduleKind;
  fInterval.value = j.scheduleKind === 'interval' ? j.scheduleValue : '30';
  fCron.value = j.scheduleKind === 'cron' ? j.scheduleValue : '0 9 * * *';
  fOnce.value = j.scheduleKind === 'once' ? toLocalInput(Number(j.scheduleValue) * 1000) : '';
  fAssistant.value = j.assistantId ?? ''; fWorkspace.value = j.workspaceRoot ?? '';
}
/** epoch 毫秒 → datetime-local 的值（本地墙钟，input 要的就是这个格式）。 */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}
function scheduleValue(): string {
  if (fKind.value === 'interval') return fInterval.value.trim();
  if (fKind.value === 'cron') return fCron.value.trim();
  const ms = fOnce.value ? new Date(fOnce.value).getTime() : NaN;
  return String(Math.floor(ms / 1000));
}
async function save(): Promise<void> {
  err.value = '';
  const input = {
    name: fName.value, prompt: fPrompt.value,
    scheduleKind: fKind.value, scheduleValue: scheduleValue(),
    assistantId: fAssistant.value || undefined, workspaceRoot: fWorkspace.value || undefined,
  };
  try {
    if (editing.value === 'new') await chat.createCronJob(input);
    else await chat.updateCronJob(editing.value, input);
    editing.value = '';
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
async function toggleEnabled(id: string, enabled: boolean): Promise<void> {
  err.value = '';
  try { await chat.updateCronJob(id, { enabled }); }
  catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
async function onDelete(id: string): Promise<void> {
  await chat.deleteCronJob(id); confirming.value = '';
  if (editing.value === id) editing.value = '';
}
async function runNow(id: string): Promise<void> {
  err.value = '';
  try { await chat.runCronNow(id); }
  catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
function fmtTime(sec?: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
</script>

<template>
  <div class="scroll">
    <div class="col">
      <header class="head">
        <div class="htxt">
          <h1 class="t-h1">定时任务</h1>
          <p class="t-body sub">到点自动开一个会话跑你写好的 prompt。<b>应用没开就不会跑</b>——它不是后台服务。</p>
        </div>
        <button v-if="editing !== 'new'" class="f-btn primary" type="button" @click="startNew">
          <UiIcon name="plus" :size="14" />新建任务
        </button>
      </header>

      <p v-if="err" class="errline">{{ err }}</p>

      <form v-if="editing" class="f-card" @submit.prevent="save">
        <label class="f-label">
          <span>任务名</span>
          <input v-model="fName" class="f-input" placeholder="如「每天早上整理收件箱」" required />
        </label>
        <label class="f-label">
          <span>要做什么</span>
          <textarea v-model="fPrompt" class="f-area" placeholder="到点后发给 agent 的原话。写清楚在哪个目录做什么、做完怎么算完。" required></textarea>
        </label>
        <div class="f-grid">
          <label class="f-label">
            <span>什么时候跑</span>
            <select v-model="fKind" class="f-select">
              <option value="interval">每隔一段时间</option>
              <option value="cron">按 cron 表达式</option>
              <option value="once">只跑一次</option>
            </select>
          </label>
          <label v-if="fKind === 'interval'" class="f-label">
            <span>间隔（分钟）</span>
            <input v-model="fInterval" class="f-input tnum" type="number" min="1" required />
          </label>
          <label v-else-if="fKind === 'cron'" class="f-label">
            <span>cron 表达式</span>
            <input v-model="fCron" class="f-input" placeholder="0 9 * * *" required />
            <span class="f-hint">分 时 日 月 周。<code>0 9 * * *</code> = 每天 9:00。</span>
          </label>
          <label v-else class="f-label">
            <span>运行时刻</span>
            <input v-model="fOnce" class="f-input" type="datetime-local" required />
          </label>
        </div>
        <div class="f-grid">
          <label class="f-label">
            <span>用哪个助手（可选）</span>
            <select v-model="fAssistant" class="f-select">
              <option value="">不指定</option>
              <option v-for="a in chat.assistants" :key="a.id" :value="a.id">{{ a.avatar }} {{ a.name }}</option>
            </select>
          </label>
          <label class="f-label">
            <span>工作目录（可选）</span>
            <input v-model="fWorkspace" class="f-input" placeholder="留空用会话默认沙箱目录" />
          </label>
        </div>
        <div class="f-row">
          <button class="f-btn primary" type="submit">{{ editing === 'new' ? '创建' : '保存' }}</button>
          <button class="f-btn ghost" type="button" @click="editing = ''">取消</button>
        </div>
      </form>

      <div v-if="!chat.cronJobs.length && !editing" class="blank">
        <UiIcon name="clock" :size="26" />
        <p class="t-h2">还没有定时任务</p>
        <p class="t-body sub">比如「每天 9 点把昨天的日志汇总成一份 md」。</p>
        <button class="f-btn primary" type="button" @click="startNew">新建任务</button>
      </div>

      <div v-for="j in chat.cronJobs" :key="j.id" class="job" :class="{ off: !j.enabled }">
        <label class="f-switch" :title="j.enabled ? '停用' : '启用'">
          <input type="checkbox" :checked="j.enabled" @change="toggleEnabled(j.id, !j.enabled)" />
          <i></i>
        </label>
        <div class="jbody">
          <div class="jtop">
            <span class="jname">{{ j.name }}</span>
            <span class="f-tag">{{ describeSchedule(j.scheduleKind, j.scheduleValue) }}</span>
            <span v-if="j.lastStatus" class="f-tag" :class="{ ok: j.lastStatus === 'ok', err: j.lastStatus === 'error' }">
              上次 {{ j.lastStatus }}
            </span>
          </div>
          <p class="jprompt t-aux">{{ j.prompt }}</p>
          <p class="jtime t-aux tnum">下次 {{ fmtTime(j.nextRunAt) }} · 上次 {{ fmtTime(j.lastRunAt) }}</p>
        </div>
        <div class="jacts">
          <button class="f-btn ghost" type="button" title="立即运行一次" @click="runNow(j.id)"><UiIcon name="play" :size="14" /></button>
          <button v-if="j.lastSessionId" class="f-btn ghost" type="button" title="打开最近一次会话" @click="chat.open(j.lastSessionId!)">
            <UiIcon name="chat" :size="14" />
          </button>
          <button class="f-btn ghost" type="button" title="编辑" @click="startEdit(j.id)"><UiIcon name="pencil" :size="14" /></button>
          <template v-if="confirming === j.id">
            <span class="f-confirm">删掉？</span>
            <button class="f-btn danger" type="button" @click="onDelete(j.id)">确认</button>
            <button class="f-btn ghost" type="button" @click="confirming = ''">取消</button>
          </template>
          <button v-else class="f-btn danger" type="button" title="删除" @click="confirming = j.id"><UiIcon name="trash" :size="14" /></button>
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
.sub b { color: var(--c-ink-2); font-weight: var(--w-md); }

.blank {
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-3);
  padding: var(--sp-8); text-align: center; color: var(--c-ink-3);
  background: var(--c-bg-1); border-radius: var(--r-m);
}
.blank p { margin: 0; }
.blank .t-h2 { color: var(--c-ink); }

.job {
  display: flex; align-items: flex-start; gap: var(--sp-4);
  padding: var(--sp-5); background: var(--c-bg);
  border: 1px solid var(--c-line); border-radius: var(--r-m);
}
.job.off { opacity: .6; }
.job .f-switch { margin-top: 2px; }
.jbody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.jtop { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.jname { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.jprompt {
  margin: 0; color: var(--c-ink-2);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.jtime { margin: 0; color: var(--c-ink-3); }
.jacts { display: flex; align-items: center; gap: var(--sp-1); flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; max-width: 210px; }
.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
code { font-family: var(--f-mono); background: var(--c-bg-2); padding: 1px 5px; border-radius: 4px; }
</style>
