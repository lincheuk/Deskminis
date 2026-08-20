<script setup lang="ts">
/** 设置独立模态（MU2b Task 5，设计 §1.1-2 决断 2）——左 180px section 导航 + 右内容。
 *  四 section：模型（ProviderSettings 平移，组件本体零改动）/ 外观（三模式单选 + 说明）
 *  / 权限（档位单选 + 90s 超时说明）/ 设备与同步（DevicesModal 入口，Task 7 已填实）。
 *  遮罩 rgba(0,0,0,.4) + 卡片 720px var(--r-sheet) + Esc 关闭；Ctrl+, 打开在 App.vue。 */
import { inject, onMounted, onBeforeUnmount, ref } from 'vue';
import { useChat } from '../stores/chat';
import ProviderSettings from './ProviderSettings.vue';
import SkillsSettings from './SkillsSettings.vue';
import McpSettings from './McpSettings.vue';
import Icon from './Icon.vue';
import type { ThemeMode } from '../lib/settings/theme';

const props = defineProps<{ theme: ThemeMode }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'set-theme', t: ThemeMode): void;
}>();

const chat = useChat();

// ---- 关于与更新（用户 2026-08-11 拍板：GitHub Releases + 启动检查可关）----
const appVersion = ref('');
const autoCheck = ref(true);
const updState = ref<{ status: string; version?: string; error?: string }>({ status: 'idle' });
const checking = ref(false);
const UPD_TEXT: Record<string, string> = {
  idle: '尚未检查', checking: '正在检查…', available: '发现新版本，正在下载…',
  downloading: '正在下载…', downloaded: '新版本已下载，重启即可安装',
  latest: '已是最新版本', disabled: '自动检查已关闭',
  dev: '开发模式不检查更新', error: '检查失败',
};
async function loadUpdate(): Promise<void> {
  const b = (window as any).deskminis;
  if (!b || typeof b.getUpdatePrefs !== 'function') return;
  const r = await b.getUpdatePrefs();
  appVersion.value = r.version; autoCheck.value = r.autoCheck; updState.value = r.state;
}
async function toggleAutoCheck(): Promise<void> {
  const b = (window as any).deskminis;
  if (!b) return;
  await b.setUpdateEnabled(!autoCheck.value);
  await loadUpdate();
}
async function checkNow(): Promise<void> {
  const b = (window as any).deskminis;
  if (!b) return;
  checking.value = true;
  try { updState.value = await b.checkForUpdates(); } finally { checking.value = false; }
}
// App.vue provide：开配对管理面（App 侧会同时收起本设置模态，避免两模态叠层）
const openDevices = inject<() => void>('openDevices', () => {});

type Section = 'model' | 'skills' | 'mcp' | 'appearance' | 'permission' | 'devices' | 'about';
const section = ref<Section>('model');
const NAV: { id: Section; label: string }[] = [
  { id: 'model', label: '模型' },
  { id: 'skills', label: '技能' },
  { id: 'mcp', label: 'MCP' },
  { id: 'appearance', label: '外观' },
  { id: 'permission', label: '权限' },
  { id: 'devices', label: '设备与同步' },
  { id: 'about', label: '关于与更新' },
];

const THEME_ROWS: { id: ThemeMode; label: string; sub: string }[] = [
  { id: 'system', label: '跟随系统', sub: '随 Windows 明暗设置自动切换' },
  { id: 'light', label: '浅色', sub: '始终使用浅色外观' },
  { id: 'dark', label: '深色', sub: '始终使用深色外观' },
];

type Tier = 'ask' | 'session' | 'full';
const TIER_ROWS: { id: Tier; label: string; sub: string; danger?: boolean }[] = [
  { id: 'ask', label: '每次确认', sub: '工作区内文件直接放行；其余每次询问' },
  { id: 'session', label: '本会话沿用', sub: '批准过的命令原样重复时不再询问' },
  { id: 'full', label: '完全访问', sub: '不再询问任何操作；不可逆的系统操作仍拦截', danger: true },
];

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); emit('close'); }
}
onMounted(() => {
  window.addEventListener('keydown', onKey, true);
  void loadUpdate();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-label="设置">
      <nav class="snav">
        <div class="shead">设置</div>
        <div
          v-for="n in NAV" :key="n.id"
          class="sitem" :class="{ on: section === n.id }" tabindex="0" role="tab" @keydown.enter.prevent="section = n.id" @keydown.space.prevent="section = n.id"
          @click="section = n.id"
        >{{ n.label }}</div>
      </nav>
      <div class="sbody">
        <div class="stitlerow">
          <div class="stitle">{{ NAV.find(n => n.id === section)!.label }}</div>
          <!-- 用户 2026-08-11：「没有一个 X 方便关闭窗口，人不一定知道点外面可以回到主界面」。
               点遮罩关闭与 Esc 都保留，但它们是**隐性**的——显式出口不能只靠用户猜。 -->
          <button class="xbtn" type="button" title="关闭设置" aria-label="关闭设置" @click="emit('close')">
            <Icon name="x" :size="15" />
          </button>
        </div>

        <ProviderSettings v-if="section === 'model'" />

        <SkillsSettings v-else-if="section === 'skills'" />

        <McpSettings v-else-if="section === 'mcp'" />

        <template v-else-if="section === 'appearance'">
          <div
            v-for="r in THEME_ROWS" :key="r.id"
            class="opt" :class="{ on: props.theme === r.id }" tabindex="0" role="radio" @keydown.enter.prevent="emit('set-theme', r.id)" @keydown.space.prevent="emit('set-theme', r.id)"
            @click="emit('set-theme', r.id)"
          >
            <div class="otxt"><div class="olabel">{{ r.label }}</div><div class="osub">{{ r.sub }}</div></div>
            <Icon v-if="props.theme === r.id" class="ochk" name="check" :size="16" />
          </div>
          <div class="snote">选择立即生效，并保留到下次启动。</div>
        </template>

        <template v-else-if="section === 'permission'">
          <div
            v-for="r in TIER_ROWS" :key="r.id"
            class="opt" :class="{ on: chat.permTier === r.id, danger: r.danger }" tabindex="0" role="radio" @keydown.enter.prevent="chat.setPermTier(r.id)" @keydown.space.prevent="chat.setPermTier(r.id)"
            @click="chat.setPermTier(r.id)"
          >
            <div class="otxt"><div class="olabel">{{ r.label }}</div><div class="osub">{{ r.sub }}</div></div>
            <Icon v-if="chat.permTier === r.id" class="ochk" name="check" :size="16" />
          </div>
          <div class="snote">危险命令始终拦截；每次确认默认 90 秒未响应自动拒绝。权限档位为渲染端本地偏好，影响权限卡预选高亮。</div>
        </template>

        <template v-else-if="section === 'about'">
          <div class="snote">
            DeskMinis <strong>v{{ appVersion || '—' }}</strong> · 本地优先的桌面 Agent 应用。
            会话与记忆只存在本机与你自己配对的设备之间。
          </div>
          <div class="syncbox">
            <div class="syncrow">
              <div class="synctxt">
                <div class="synclabel">启动时检查更新</div>
                <div class="syncsub">
                  {{ UPD_TEXT[updState.status] || updState.status }}<template v-if="updState.version"> （{{ updState.version }}）</template>
                </div>
              </div>
              <button class="syncbtn" type="button" :class="{ paused: !autoCheck }" @click="toggleAutoCheck">
                {{ autoCheck ? '已开启' : '已关闭' }}
              </button>
            </div>
            <div class="syncwarn">
              这是<strong>唯一</strong>会主动联网的功能，只向 GitHub 查一次版本号；关掉后完全不联网。
              下载完<strong>不会自动重启</strong>——正在跑的任务不会被打断，何时安装由你决定。
            </div>
            <div class="syncrow" style="margin-top: 10px">
              <button class="devbtn" type="button" :disabled="checking" @click="checkNow">
                {{ checking ? '检查中…' : '立即检查更新' }}
              </button>
            </div>
            <div v-if="updState.status === 'error'" class="uerr">{{ updState.error }}</div>
          </div>
        </template>

        <template v-else>
          <div class="snote">查看已配对设备、发起新配对。</div>
          <button class="devbtn" type="button" @click="openDevices()">管理设备…</button>

          <!-- MU6：M6 的同步暂停开关。后端完整建成（含审计落盘、13 笔 commit），此前界面上一个开关都没有。 -->
          <div class="syncbox">
            <div class="syncrow">
              <div class="synctxt">
                <div class="synclabel">设备间同步</div>
                <div class="syncsub">
                  {{ chat.syncPaused ? '已暂停：不再与其它设备收发会话与记忆。' : '进行中：会话与记忆在已配对设备之间自动同步。' }}
                </div>
              </div>
              <button
                class="syncbtn" type="button" :class="{ paused: chat.syncPaused }"
                @click="chat.setSyncPaused(!chat.syncPaused)"
              >{{ chat.syncPaused ? '恢复同步' : '暂停同步' }}</button>
            </div>
            <div class="syncwarn">
              暂停的只是<strong>设备间同步</strong>，<strong>不会中断</strong>正在执行的任务——
              要停下当前回合请用输入框旁的停止按钮。暂停状态会保留到下次启动。
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.uerr { margin-top: 8px; font-size: var(--fs-micro); color: var(--state-err); line-height: 1.5; }
/* MU6 同步暂停开关 */
/* E3（Aurora §4）：设置分组卡浮岛化——顶缘高光 + 柔影；实心材质不用 blur
   （§5：SettingsModal 在 POPUP_OWNERS 永久禁用清单内） */
.syncbox {
  margin-top: 14px; padding: 12px; border-radius: var(--r-card);
  background: var(--grouped-bg-secondary); border: .5px solid var(--separator);
  box-shadow: 0 2px 8px var(--shadow-color);
}
.syncrow { display: flex; align-items: center; gap: 12px; }
.synctxt { flex: 1; min-width: 0; }
.synclabel { font-size: var(--fs-ui); font-weight: 600; color: var(--label); }
.syncsub { margin-top: 2px; font-size: var(--fs-micro); line-height: 1.6; color: var(--label-secondary); }
.syncbtn {
  flex: 0 0 auto; padding: 6px 14px; border-radius: var(--r-control);
  border: .5px solid var(--separator); background: var(--surface-1);
  font-size: var(--fs-ui); font-weight: 600; color: var(--label); cursor: pointer; white-space: nowrap;
}
.syncbtn.paused { border-color: var(--state-warn); color: var(--state-warn); }
.syncbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
/* 命门文案：不写清楚的话，用户会以为这个开关能停下正在跑的 agent 回合 */
.syncwarn { margin-top: 10px; font-size: var(--fs-micro); line-height: 1.7; color: var(--label-tertiary); }
.syncwarn strong { color: var(--label-secondary); font-weight: 600; }
.mask {
  position: fixed; inset: 0; z-index: 100; background: var(--scrim);
  display: flex; align-items: center; justify-content: center;
}
/* 尺寸从死的 720×480 改为随视口伸展（用户 2026-08-11：「比例很奇怪」「为什么要有上下滑动」）。
   480px 高在 1080 屏上只占 44%，模型页的「已有 provider + 添加表单」根本装不下，
   于是每次进来都得滚——而右边还空着一大片。上限设死是为了超宽屏不至于拉成一条。 */
.modal {
  width: min(920px, calc(100vw - 96px)); height: min(680px, calc(100vh - 96px));
  background: var(--bg); border-radius: var(--r-sheet); box-shadow: var(--shadow-pop);
  display: flex; overflow: hidden;
}
.snav {
  width: 180px; flex: 0 0 180px; padding: 14px 10px; background: var(--grouped-bg-secondary);
  border-right: .5px solid var(--separator); display: flex; flex-direction: column; gap: 2px;
}
.shead { font-size: var(--fs-title); font-weight: 700; color: var(--label-emphasis); padding: 4px 10px 12px; }
.sitem {
  padding: 7px 10px; border-radius: var(--r-control); font-size: var(--fs-ui);
  color: var(--label-secondary); cursor: pointer;
}
.sitem:hover { background: var(--fill-quaternary); }
/* E3：活跃导航项左缘 2px accent 指示线（inset 零位移），沿用既有 .on 机制只加缘线 */
.sitem.on { background: var(--fill-tertiary); color: var(--label); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
/* MU3 §2-5 焦点环 */
.sitem:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.sbody { flex: 1; min-width: 0; overflow: auto; padding: 18px 20px; }
.stitlerow { display: flex; align-items: flex-start; gap: 12px; }
.stitlerow .stitle { flex: 1; min-width: 0; }
.xbtn {
  flex: 0 0 auto; width: 28px; height: 28px; border: none; border-radius: var(--r-control);
  background: none; color: var(--label-secondary); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.xbtn:hover { background: var(--fill-tertiary); color: var(--label); }
.xbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.xbtn :deep(svg) { stroke: currentColor; }
.stitle { font-size: var(--fs-display); font-weight: 700; color: var(--label-intense); margin-bottom: 14px; }
/* E3：选项行（外观/权限分组卡）浮岛化——顶缘高光 + 柔影 */
.opt {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 6px;
  border: .5px solid var(--separator); border-radius: var(--r-card); cursor: pointer;
  background: var(--surface-1);
  box-shadow: 0 2px 8px var(--shadow-color);
}
.opt:hover { background: var(--fill-quaternary); }
.opt.on { border-color: var(--action); }
.opt:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.otxt { flex: 1; min-width: 0; }
.olabel { font-size: var(--fs-ui); font-weight: 600; color: var(--label); }
.osub { font-size: var(--fs-caption); color: var(--label-secondary); margin-top: 2px; }
.opt.danger .olabel, .opt.danger .osub { color: var(--state-err); }
.ochk { color: var(--action); flex: 0 0 auto; }
.snote { font-size: var(--fs-caption); color: var(--label-tertiary); line-height: 1.6; padding: 8px 2px; }
/* E3：页内主钮（管理设备/立即检查更新）青底——accent 底 + on-action 字，两主题自动对（§4） */
.devbtn {
  margin-top: 8px; padding: 8px 14px; border: .5px solid var(--accent); border-radius: var(--r-control);
  background: var(--accent); color: var(--on-action); font-size: var(--fs-ui); font-weight: 600; cursor: pointer;
}
.devbtn:hover { background: var(--accent); }
.devbtn:disabled { opacity: var(--opacity-disabled); cursor: default; }
.devbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
</style>
