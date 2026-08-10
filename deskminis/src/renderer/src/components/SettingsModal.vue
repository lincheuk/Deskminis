<script setup lang="ts">
/** 设置独立模态（MU2b Task 5，设计 §1.1-2 决断 2）——左 180px section 导航 + 右内容。
 *  四 section：模型（ProviderSettings 平移，组件本体零改动）/ 外观（三模式单选 + 说明）
 *  / 权限（档位单选 + 90s 超时说明）/ 设备与同步（DevicesModal 入口，Task 7 已填实）。
 *  遮罩 rgba(0,0,0,.4) + 卡片 720px var(--r-sheet) + Esc 关闭；Ctrl+, 打开在 App.vue。 */
import { inject, onMounted, onBeforeUnmount, ref } from 'vue';
import { useChat } from '../stores/chat';
import ProviderSettings from './ProviderSettings.vue';
import SkillsSettings from './SkillsSettings.vue';
import Icon from './Icon.vue';
import type { ThemeMode } from '../lib/settings/theme';

const props = defineProps<{ theme: ThemeMode }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'set-theme', t: ThemeMode): void;
}>();

const chat = useChat();
// App.vue provide：开配对管理面（App 侧会同时收起本设置模态，避免两模态叠层）
const openDevices = inject<() => void>('openDevices', () => {});

type Section = 'model' | 'skills' | 'appearance' | 'permission' | 'devices';
const section = ref<Section>('model');
const NAV: { id: Section; label: string }[] = [
  { id: 'model', label: '模型' },
  { id: 'skills', label: '技能' },
  { id: 'appearance', label: '外观' },
  { id: 'permission', label: '权限' },
  { id: 'devices', label: '设备与同步' },
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
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-label="设置">
      <nav class="snav">
        <div class="shead">设置</div>
        <div
          v-for="n in NAV" :key="n.id"
          class="sitem" :class="{ on: section === n.id }"
          @click="section = n.id"
        >{{ n.label }}</div>
      </nav>
      <div class="sbody">
        <div class="stitle">{{ NAV.find(n => n.id === section)!.label }}</div>

        <ProviderSettings v-if="section === 'model'" />

        <SkillsSettings v-else-if="section === 'skills'" />

        <template v-else-if="section === 'appearance'">
          <div
            v-for="r in THEME_ROWS" :key="r.id"
            class="opt" :class="{ on: props.theme === r.id }"
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
            class="opt" :class="{ on: chat.permTier === r.id, danger: r.danger }"
            @click="chat.setPermTier(r.id)"
          >
            <div class="otxt"><div class="olabel">{{ r.label }}</div><div class="osub">{{ r.sub }}</div></div>
            <Icon v-if="chat.permTier === r.id" class="ochk" name="check" :size="16" />
          </div>
          <div class="snote">危险命令始终拦截；每次确认默认 90 秒未响应自动拒绝。权限档位为渲染端本地偏好，影响权限卡预选高亮。</div>
        </template>

        <template v-else>
          <div class="snote">查看已配对设备、发起新配对。</div>
          <button class="devbtn" type="button" @click="openDevices()">管理设备…</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 100; background: var(--scrim);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 720px; max-width: calc(100vw - 64px); height: 480px; max-height: calc(100vh - 64px);
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
.sitem.on { background: var(--fill-tertiary); color: var(--label); font-weight: 600; }
/* MU3 §2-5 焦点环 */
.sitem:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.sbody { flex: 1; min-width: 0; overflow: auto; padding: 18px 20px; }
.stitle { font-size: var(--fs-display); font-weight: 700; color: var(--label-intense); margin-bottom: 14px; }
.opt {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 6px;
  border: .5px solid var(--separator); border-radius: var(--r-card); cursor: pointer;
  background: var(--surface-1);
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
.devbtn {
  margin-top: 8px; padding: 8px 14px; border: .5px solid var(--separator); border-radius: var(--r-control);
  background: var(--surface-1); color: var(--label); font-size: var(--fs-ui); cursor: pointer;
}
.devbtn:hover { background: var(--fill-quaternary); }
.devbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
</style>
