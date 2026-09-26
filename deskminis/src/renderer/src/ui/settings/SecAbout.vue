<script setup lang="ts">
/** T5：关于 + 自动更新。
 *  自动更新开关归主进程管（它才是做检查的那一方），这里只读写与手动触发。
 *  失败原因由主进程译成一句中文（main/update-status.ts 的 describeUpdateError），这里原样接在状态后面，
 *  不让用户对着「检查失败」猜，也不再漏英文堆栈和响应头。 */
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
  // 不说「重启后生效」（W3-upd）：主进程设了 autoInstallOnAppQuit = false，退出与重启都不会装，只有下载完成框里点「重启并安装」才装。
  // 那个框关掉了，旁边的「现在检查」再查一次：已下载的安装包核对通过，就重新弹出来。
  // 再查要先从发布页拉到版本信息才会去核对，离线时装不了，所以写「联网时」（W3-updb）
  downloaded: '新版已下载，还没安装：联网时点「现在检查」会重新弹出安装提示',
  // 不写「检查失败」：下载阶段的失败（如安装包校验不符）也落在 error，后面接的原因会说清是哪一步
  error: '更新失败',
  dev: '开发模式：不检查更新',
  disabled: '已关闭自动检查',
  // W2b-9：便携版主进程直接不检查、不下载（electron-updater 不认便携版，放它查会去下载安装包）
  portable: '便携版不自动更新，请到发布页下载新版',
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
          <span class="f-hint">启动时到 GitHub 上的 lincheuk/deskminis-releases 查一次新版本</span>
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
