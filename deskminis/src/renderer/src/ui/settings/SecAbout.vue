<script setup lang="ts">
/** T5：关于 + 自动更新。
 *  自动更新开关归主进程管（它才是做检查的那一方），这里只读写与手动触发。
 *  仓库私有期间检查会 404——照实说明，不让用户对着「检查失败」猜。 */
import { computed, onMounted, ref } from 'vue';
import UiIcon from '../UiIcon.vue';

const version = ref('');
const autoCheck = ref(false);
const state = ref<{ status: string; version?: string; error?: string }>({ status: 'idle' });
const checking = ref(false);
const bridge = (window as unknown as { deskminis?: Record<string, (...a: never[]) => Promise<unknown>> }).deskminis;

/** 键取自 main/index.ts 的 updateState.status（**是 status 值不是事件名**——
 *  第一版照事件名写成 'update-available'，实拍下来一条都对不上，直接漏出原始状态串）。 */
const STATUS_TEXT: Record<string, string> = {
  idle: '还没检查过',
  checking: '检查中…',
  available: '有新版本',
  latest: '已是最新',
  downloading: '下载中…',
  downloaded: '新版已下载，重启后生效',
  error: '检查失败',
  dev: '开发模式：不检查更新',
  disabled: '已关闭自动检查',
};
/** dev / disabled 自带解释，再把 error 字段接上去就是同一句说两遍。 */
const showErr = computed(() => Boolean(state.value.error) && !['dev', 'disabled'].includes(state.value.status));

async function load(): Promise<void> {
  if (typeof bridge?.getUpdatePrefs !== 'function') return;
  try {
    const p = await bridge.getUpdatePrefs() as { autoCheck: boolean; version: string; state: typeof state.value };
    version.value = p.version; autoCheck.value = p.autoCheck; state.value = p.state;
  } catch { /* 主进程未就绪：留空 */ }
}
onMounted(load);

async function toggleAuto(): Promise<void> {
  if (typeof bridge?.setUpdateEnabled !== 'function') return;
  autoCheck.value = !autoCheck.value;
  try { await bridge.setUpdateEnabled(autoCheck.value as never); }
  catch { autoCheck.value = !autoCheck.value; }   // 失败就退回去，别显示一个假的开
}
async function checkNow(): Promise<void> {
  if (typeof bridge?.checkForUpdates !== 'function' || checking.value) return;
  checking.value = true;
  try { state.value = await bridge.checkForUpdates() as typeof state.value; }
  catch (e) { state.value = { status: 'error', error: e instanceof Error ? e.message : String(e) }; }
  finally { checking.value = false; }
}
</script>

<template>
  <section class="f-sec">
    <h2>关于</h2>
    <div class="f-card">
      <div class="idrow">
        <span class="logo"><UiIcon name="chat" :size="20" /></span>
        <span class="idtxt">
          <span class="t-h2">DeskMinis</span>
          <span class="t-aux ver tnum">{{ version ? `v${version}` : '版本信息读取中…' }}</span>
        </span>
      </div>
      <p class="f-note">本机运行的桌面 Agent：读写文件、执行命令、连 MCP、做 Office 文档。数据都存在本机。</p>
    </div>

    <div class="f-card">
      <div class="f-row">
        <label class="f-switch" title="自动检查更新">
          <input type="checkbox" :checked="autoCheck" @change="toggleAuto" />
          <i></i>
        </label>
        <span class="f-label" style="gap:1px">
          <span>自动检查更新</span>
          <span class="f-hint">启动时到 GitHub Release 看一眼有没有新版</span>
        </span>
        <button class="f-btn" type="button" :disabled="checking" @click="checkNow">
          {{ checking ? '检查中…' : '现在检查' }}
        </button>
      </div>
      <p class="statusline t-aux" :class="{ bad: state.status === 'error' }">
        {{ STATUS_TEXT[state.status] ?? state.status }}
        <template v-if="state.version"> · {{ state.version }}</template>
        <template v-if="showErr"> · {{ state.error }}</template>
      </p>
      <p class="f-hint">仓库还是私有的话，检查会返回 404——这是预期的，不是坏了。</p>
    </div>
  </section>
</template>

<style scoped>
.idrow { display: flex; align-items: center; gap: var(--sp-4); }
.logo {
  width: 40px; height: 40px; flex: 0 0 auto; border-radius: var(--r-m);
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--c-aou); color: var(--c-brand-ink);
}
.idtxt { display: flex; flex-direction: column; gap: 1px; }
.ver { color: var(--c-ink-3); font-family: var(--f-mono); }
.statusline { margin: 0; color: var(--c-ink-2); }
.statusline.bad { color: var(--c-err); }
</style>
