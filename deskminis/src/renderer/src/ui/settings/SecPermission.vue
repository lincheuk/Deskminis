<script setup lang="ts">
/** T5：权限档位。档位是**全局默认**，权限卡上还能就地临时改——两处同一份 permTier
 *  镜像，后端 settings 表持久化。这三句话决定用户敢不敢开 full，所以每句都得是真话。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useChat, type UiSensitivePath } from '../../stores/chat';
import UiIcon from '../UiIcon.vue';

const chat = useChat();

// 执行隔离第 3 步：命令隔离。第 4 步起默认开。开关存在引擎的设置里，重启后生效；状态说的是这次启动时的实际情况
const sbxErr = ref('');
onMounted(() => { void chat.refreshSandbox(); });
async function toggleSandbox(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  sbxErr.value = '';
  try { await chat.setSandboxEnabled(el.checked); }
  catch (err) { el.checked = !el.checked; sbxErr.value = err instanceof Error ? err.message : String(err); }
}
const SBX_REASON: Record<string, string> = {
  'not-windows': '只支持 Windows',
  'agent-root-overlaps-data-root': 'agent 目录和数据目录重叠（启动时指定了数据目录），开不了',
  'data-root-unsupported': '数据目录所在的盘不支持完整性标签（FAT、exFAT 或网络盘），开不了',
};
const sbxLine = computed(() => {
  const s = chat.sandbox;
  if (!s) return '';
  const now = s.state === 'on' ? '当前：已开启'
    : s.state === 'starting' ? '当前：正在开启…'
    : s.state === 'unavailable' ? `当前：没有开启，${SBX_REASON[s.reason ?? ''] ?? s.reason ?? ''}`
    : s.reason && s.reason !== 'off' ? `当前：没有开启，${SBX_REASON[s.reason] ?? s.reason}` : '当前：未开启';
  const forced = s.forced === undefined ? '' : ` · 环境变量 DESKMINIS_SANDBOX 强制${s.forced ? '开启' : '关闭'}，这里的开关不起作用`;
  return `${now}${s.restartNeeded ? ' · 重启 DeskMinis 后生效' : ''}${forced}`;
});

// 执行隔离第 5 步：沙箱不许读的位置。改了马上生效；打标签要一会儿，期间隔一秒重取一次状态
const sensErr = ref('');
const extraText = ref('');
const extraDirty = ref(false);
watch(() => chat.sandbox?.sensitive?.extra, x => { if (!extraDirty.value) extraText.value = (x ?? []).map(p => p.path).join('\n'); }, { immediate: true });
let poll: ReturnType<typeof setTimeout> | undefined;
// 每次重取都换一个新对象，所以盯整个状态：还在打就再排一次
watch(() => chat.sandbox, s => {
  if (poll) clearTimeout(poll);
  if (s?.sensitive?.busy) poll = setTimeout(() => { void chat.refreshSandbox(); }, 1000);
});
onBeforeUnmount(() => { if (poll) clearTimeout(poll); });
async function toggleSensitive(id: string, e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  sensErr.value = '';
  try { await chat.setSandboxSensitive(id, el.checked); }
  catch (err) { el.checked = !el.checked; sensErr.value = err instanceof Error ? err.message : String(err); }
}
async function saveExtra(): Promise<void> {
  sensErr.value = '';
  try {
    await chat.setSandboxSensitiveExtra(extraText.value.split(/\r?\n/).map(x => x.trim()).filter(x => x !== ''));
    extraDirty.value = false;
    extraText.value = (chat.sandbox?.sensitive?.extra ?? []).map(p => p.path).join('\n');
  } catch (err) { sensErr.value = err instanceof Error ? err.message : String(err); }
}
function pathState(p: UiSensitivePath): string {
  switch (p.state) {
    case 'protected': return '已挡住';
    case 'pending': return '正在打标签…';
    case 'missing': return '这台电脑上没有';
    case 'off': return '';
    case 'inactive': return '命令隔离没开';
    case 'unsupported': return '所在的盘不支持完整性标签，挡不住';
    case 'failed': return `打标签失败（错误码 ${p.code ?? '?'}），沙箱里可能读得到`;
    case 'rejected': return `不能设：${p.problem ?? ''}`;
  }
  return '';
}
/** 一项的摘要：只说存在的路径；一个都没有就说这台电脑上没有。 */
function itemState(paths: UiSensitivePath[]): string {
  const there = paths.filter(p => p.state !== 'missing');
  if (there.length === 0) return '这台电脑上没有';
  return there.map(p => [pathState(p), there.length > 1 || p.state === 'failed' || p.state === 'rejected' ? p.path : ''].filter(Boolean).join('：')).filter(Boolean).join('；');
}
type Tier = 'ask' | 'session' | 'plan' | 'full';
const TIERS: { tier: Tier; icon: string; title: string; sub: string; danger?: boolean }[] = [
  // T6e-3 补搬：旧设置页写明了「90 秒未响应自动拒绝」，换壳时丢了。用户不知道这一点，
  // 就会以为离开一会儿回来任务还等着——其实已经按拒绝跑完了。
  // W1b-2g 审查：旧副标题只说「工作区内文件直接放行」，可只读的本地命令（dir、Get-Content、rg、git log 等）同样不问
  // F13：同一会话本轮连续两次询问没人回应之后，引擎不再弹卡、直接按未批准处理（minisd/tools/permissions.ts 的
  // MAX_UNANSWERED_STREAK），发下一条消息才恢复。只写「其余每次询问」的话，用户回来看到工具失败却没有卡，对不上这句话
  { tier: 'ask', icon: 'shield', title: '每次确认', sub: '工作区内的文件与普通只读本地命令直接放行；上级目录、用户目录、短名与目录通配等写法仍需询问；其余每次询问，90 秒没回应按拒绝处理；同一轮连续两次没人回应后不再询问，发下一条消息后恢复' },
  { tier: 'session', icon: 'clock', title: '本会话沿用', sub: '批准过的命令原样重复时不再询问' },
  { tier: 'plan', icon: 'shield', title: '只读 / 计划', sub: '可以读文件、跑只读命令，联网会问你；写文件、会改动的命令、MCP 和通知、打开、朗读、写剪贴板一律直接拒绝，适合先让它出方案' },
  // W1b-2g：旧副标题许诺「不可逆的系统操作仍拦截」，言过其实。危险规则是 minisd/tools/permissions.ts 的两张表
  // （DANGER_COMMANDS、DANGER_OTHER），按命令写法匹配：完全访问下，换个写法的不可逆操作（脚本文件里的、运行时拼出来的命令名）
  // 照样会执行。举的例子必须真在表里（tests/renderer-settings-modal.test.ts 逐个交给分类器判）。
  // 「沙箱之外的操作仍每次询问」是网关里 outsideSandbox 那条规则，开着命令隔离才有；细目写在下面命令隔离的说明里
  { tier: 'full', icon: 'alert', title: '完全访问', sub: '不再询问；开着命令隔离时，沙箱之外的操作仍每次询问（见下方「命令隔离」）；危险规则只按命令写法拦截（如 Remove-Item、reg delete），拦不住所有不可逆操作', danger: true },
];
</script>

<template>
  <section class="f-sec">
    <h2>权限</h2>
    <p class="f-note">agent 动文件、跑命令前要不要问你。改这里是改全局默认，单次询问卡上还能临时调。</p>
    <div class="tiers">
      <button
        v-for="t in TIERS" :key="t.tier" type="button"
        class="tier" :class="{ on: chat.permTier === t.tier, danger: t.danger }"
        :aria-pressed="chat.permTier === t.tier" @click="chat.setPermTier(t.tier)"
      >
        <UiIcon :name="t.icon" :size="18" />
        <span class="ttl">{{ t.title }}</span>
        <span class="sub t-aux">{{ t.sub }}</span>
      </button>
    </div>
    <p v-if="chat.permTier === 'full'" class="warnbox t-body">
      完全访问下 agent 会直接改文件、跑命令，不再逐条问你。只在你完全清楚它要做什么时开。
    </p>

    <div v-if="chat.sandbox" class="f-card sbx">
      <div class="f-row">
        <label class="f-switch" title="命令隔离">
          <input type="checkbox" :checked="chat.sandbox.setting" :disabled="chat.sandbox.forced !== undefined" @change="toggleSandbox" />
          <i></i>
        </label>
        <span class="f-label" style="gap:1px">
          <span>命令隔离</span>
          <span class="f-hint">agent 跑的命令放进低权限沙箱：读写不了 DeskMinis 自己的数据（会话、API key），只能写工作区和临时目录。沙箱之外的操作每次都会问你，完全访问档也问：要在沙箱外跑的命令、打开本机文件，以及文件工具写工作区和 agent 目录以外的位置、读写 DeskMinis 数据目录里要确认的内容和下面「不许读」的位置。默认开启，只支持 Windows；改了重启 DeskMinis 后生效。少数工具在沙箱里写不了用户目录下的缓存，遇到时可以让它在沙箱外运行，或在这里关掉</span>
        </span>
      </div>
      <p class="statusline t-aux">{{ sbxLine }}</p>
      <p v-if="sbxErr" class="statusline t-aux bad">{{ sbxErr }}</p>

      <div v-if="chat.sandbox.sensitive" class="sens">
        <h3 class="t-body">沙箱不许读的位置</h3>
        <p class="f-hint">沙箱挡得住写，挡不住读没设防的用户文件。勾上的位置打上和 DeskMinis 数据目录一样的标签，沙箱里的命令读不到，你自己的程序照常用；对应的命令行工具（ssh、aws、az、kubectl、gh 等）在沙箱里也就用不了这些凭据，要用时让它申请在沙箱外运行。改了马上生效。浏览器配置目录没有列：Chrome、Edge 自己有进程也跑在低权限下，挡住了会掉登录</p>
        <label v-for="it in chat.sandbox.sensitive.items" :key="it.id" class="sens-row">
          <input type="checkbox" :checked="it.enabled" @change="toggleSensitive(it.id, $event)" />
          <span class="sens-txt">
            <span>{{ it.label }}</span>
            <span v-if="it.enabled" class="t-aux sens-state">{{ itemState(it.paths) }}</span>
            <span v-if="it.note" class="f-hint">{{ it.note }}</span>
          </span>
        </label>
        <div class="sens-extra">
          <span class="f-label">自己加的位置（每行一个完整路径，文件或目录）</span>
          <textarea v-model="extraText" class="f-area" rows="3" spellcheck="false" placeholder="D:\keys" @input="extraDirty = true"></textarea>
          <div class="f-row sens-actions">
            <button type="button" class="f-btn" :disabled="!extraDirty" @click="saveExtra">保存</button>
          </div>
          <p v-for="p in chat.sandbox.sensitive.extra" :key="p.path" class="t-aux sens-state">{{ p.path }}：{{ pathState(p) }}</p>
        </div>
        <p v-if="sensErr" class="statusline t-aux bad">{{ sensErr }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tiers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
@media (max-width: 760px) { .tiers { grid-template-columns: minmax(0, 1fr); } }
.tier {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-5); text-align: left; cursor: pointer; font-family: inherit;
  background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-m);
}
.tier :deep(svg) { color: var(--c-ink-3); }
.tier:hover { border-color: var(--c-brand-line); }
.tier.on { border-color: var(--c-brand); background: var(--c-brand-soft); }
.tier.on :deep(svg) { color: var(--c-brand); }
.tier.danger.on { border-color: var(--c-err); background: var(--c-err-soft); }
.tier.danger.on :deep(svg) { color: var(--c-err); }
.ttl { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.sub { color: var(--c-ink-3); }
.sbx { margin-top: var(--sp-5); }
.statusline { margin: var(--sp-3) 0 0; color: var(--c-ink-3); }
.sens { margin-top: var(--sp-5); padding-top: var(--sp-4); border-top: 1px solid var(--c-line); display: flex; flex-direction: column; gap: var(--sp-3); }
.sens h3 { margin: 0; font-weight: var(--w-md); color: var(--c-ink); }
.sens-row { display: flex; align-items: flex-start; gap: var(--sp-3); cursor: pointer; }
.sens-row input { margin-top: 3px; }
.sens-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.sens-state { color: var(--c-ink-3); overflow-wrap: anywhere; margin: 0; }
.sens-extra { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-2); }
.sens-extra textarea { width: 100%; box-sizing: border-box; font-family: var(--f-mono, monospace); resize: vertical; }
.sens-actions { justify-content: flex-end; }
.statusline.bad { color: var(--c-err); }
.warnbox {
  margin: 0; padding: var(--sp-4) var(--sp-5); border-radius: var(--r-s);
  background: var(--c-err-soft); color: var(--c-err);
}
</style>
