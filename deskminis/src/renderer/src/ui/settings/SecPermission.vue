<script setup lang="ts">
/** T5：权限档位。档位是**全局默认**，权限卡上还能就地临时改——两处同一份 permTier
 *  镜像，后端 settings 表持久化。这三句话决定用户敢不敢开 full，所以每句都得是真话。 */
import { computed, onMounted, ref } from 'vue';
import { useChat } from '../../stores/chat';
import UiIcon from '../UiIcon.vue';

const chat = useChat();

// 执行隔离第 3 步：命令隔离（Beta）。开关存在引擎的设置里，重启后生效；状态说的是这次启动时的实际情况
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
  // （DANGER_ANYWHERE、DANGER_AT_COMMAND_POSITION），按命令写法匹配：完全访问下，换个写法的删除（[IO.File]::Delete）、
  // 表里没有的 Format-Volume 照样会执行。举的例子必须真在表里（tests/renderer-settings-modal.test.ts 逐个交给分类器判）
  { tier: 'full', icon: 'alert', title: '完全访问', sub: '除了点到 DeskMinis 数据目录或 AppData 的命令、看不出会执行什么的命令，不再询问；危险规则只按命令写法拦截（如 Remove-Item、reg delete），拦不住所有不可逆操作', danger: true },
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
          <span>命令隔离 <span class="beta t-aux">Beta</span></span>
          <span class="f-hint">agent 跑的命令放进低权限沙箱：读写不了 DeskMinis 自己的数据（会话、API key），只能写工作区和临时目录。要在沙箱外跑的命令每次都会问你，完全访问档也问。只支持 Windows，重启 DeskMinis 后生效</span>
        </span>
      </div>
      <p class="statusline t-aux">{{ sbxLine }}</p>
      <p v-if="sbxErr" class="statusline t-aux bad">{{ sbxErr }}</p>
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
.beta { padding: 0 var(--sp-2); border: 1px solid var(--c-line); border-radius: var(--r-pill); }
.statusline { margin: var(--sp-3) 0 0; color: var(--c-ink-3); }
.statusline.bad { color: var(--c-err); }
.warnbox {
  margin: 0; padding: var(--sp-4) var(--sp-5); border-radius: var(--r-s);
  background: var(--c-err-soft); color: var(--c-err);
}
</style>
