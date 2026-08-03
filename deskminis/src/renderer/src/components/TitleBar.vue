<script setup lang="ts">
/** 自绘标题栏（设计 §4.0）——frameless 顶栏，整条可拖拽、可点元素 no-drag。
 *  左：侧栏开关 + 菜单栏（仅真实可用项）；中：当前会话名；
 *  右：留空给 Electron titleBarOverlay 绘制的原生 min/max/close（DOM 不自绘）。
 *  MU2b Task 5 瘦身：无 handler 的前进/后退删除；菜单 noop 项全删（帮助组随之整组移除）。 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useChat } from '../stores/chat';
import Icon from './Icon.vue';

defineProps<{ title: string }>();
const emit = defineEmits<{
  (e: 'toggle-sidebar'): void;
  (e: 'toggle-right'): void;
  (e: 'toggle-theme'): void;
}>();

const chat = useChat();

// M3c Task 7：全局同步状态点三态（决策 7b）——offline 无在线设备（灰）/idle 已同步（绿）/syncing 同步中（橙脉冲）。
// 红砍掉（M3c LWW+orphan 自动裁决不产生人判冲突，无数据源）。数据源 chat.syncState + chat.devices.online。
const syncDisplay = computed<'offline' | 'idle' | 'syncing'>(() => {
  if (chat.syncState === 'syncing') return 'syncing';
  return chat.devices.some(d => d.online) ? 'idle' : 'offline';
});
const syncTitle = computed(() => {
  if (syncDisplay.value === 'syncing') return '同步中…';
  if (syncDisplay.value === 'idle') return `已同步（${chat.devices.filter(d => d.online).length} 台在线）`;
  return '无在线设备';
});

interface MenuItem { label?: string; kbd?: string; act?: string; sep?: boolean; danger?: boolean }
interface Menu { id: string; label: string; items: MenuItem[] }

const menus: Menu[] = [
  { id: 'file', label: '文件', items: [
    { label: '新建会话', kbd: 'Ctrl+N', act: 'new' },
    { sep: true },
    { label: '退出', kbd: 'Ctrl+Q', act: 'quit' },
  ] },
  { id: 'edit', label: '编辑', items: [
    { label: '撤销', kbd: 'Ctrl+Z', act: 'undo' },
    { label: '重做', kbd: 'Ctrl+Y', act: 'redo' },
    { sep: true },
    { label: '剪切', kbd: 'Ctrl+X', act: 'cut' },
    { label: '复制', kbd: 'Ctrl+C', act: 'copy' },
    { label: '粘贴', kbd: 'Ctrl+V', act: 'paste' },
  ] },
  { id: 'view', label: '视图', items: [
    { label: '切换侧栏', kbd: 'Ctrl+B', act: 'sidebar' },
    { label: '切换右侧面板', act: 'right' },
    { sep: true },
    { label: '明暗模式', act: 'theme' },
    { sep: true },
    { label: '重新加载', kbd: 'Ctrl+R', act: 'reload' },
  ] },
];

const openId = ref<string | null>(null);

function toggle(id: string): void { openId.value = openId.value === id ? null : id; }
function hover(id: string): void { if (openId.value !== null) openId.value = id; }

function run(item: MenuItem): void {
  openId.value = null;
  switch (item.act) {
    case 'new': void chat.newSession(); break;
    case 'quit': window.close(); break;
    case 'sidebar': emit('toggle-sidebar'); break;
    case 'right': emit('toggle-right'); break;
    case 'theme': emit('toggle-theme'); break;
    case 'reload': window.location.reload(); break;
    case 'undo': case 'redo': case 'cut': case 'copy': case 'paste':
      try { document.execCommand(item.act); } catch { /* best-effort */ }
      break;
  }
}

function closeAll(): void { openId.value = null; }
// 全局快捷键（仅安全的少数几个；不拦截 composer 输入）
function onKey(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); void chat.newSession(); }
  else if (k === 'b') { e.preventDefault(); emit('toggle-sidebar'); }
}
onMounted(() => { document.addEventListener('click', closeAll); window.addEventListener('keydown', onKey); });
onBeforeUnmount(() => { document.removeEventListener('click', closeAll); window.removeEventListener('keydown', onKey); });
</script>

<template>
  <div class="titlebar">
    <div class="tb-ico" title="切换侧栏" @click="emit('toggle-sidebar')"><Icon name="sidebar" :size="17" /></div>
    <div class="menubar" @click.stop>
      <div
        v-for="mn in menus" :key="mn.id"
        class="mi" :class="{ open: openId === mn.id }"
        @click.stop="toggle(mn.id)" @mouseenter="hover(mn.id)"
      >
        {{ mn.label }}
        <div v-if="openId === mn.id" class="pop">
          <div class="mpop">
            <template v-for="(it, i) in mn.items" :key="i">
              <div v-if="it.sep" class="sep"></div>
              <div v-else class="it" :class="{ danger: it.danger }" @click.stop="run(it)">
                {{ it.label }}<span v-if="it.kbd" class="kbd">{{ it.kbd }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
    <div class="tb-title">{{ title }}</div>
    <div class="syncdot" :class="syncDisplay" :title="syncTitle"></div>
    <div class="tb-spacer"></div>
  </div>
</template>

<style scoped>
.titlebar {
  height: 40px; display: flex; align-items: center; gap: 2px; padding: 0 4px 0 10px;
  background: var(--material-tint); backdrop-filter: var(--material-thin);
  border-bottom: .5px solid var(--separator);
  -webkit-app-region: drag; user-select: none; flex: 0 0 40px;
  /* backdrop-filter 会创建层叠上下文，把下拉菜单 .pop 的 z-index:40 困在 titlebar 内部；
     而 titlebar 本身是 static/z-auto，在根层叠上下文里按「非定位元素」绘制，
     顺序低于主体中任何定位元素 —— 菜单会被 .datehead(sticky,z1,不透明背景)、
     .stream/.empty（静态但 DOM 在后）盖住：前者显示为横条遮挡，后者抢走点击命中。
     故给 titlebar 自身一个定位与层级，让整棵子树抬到主体之上；
     50 低于 SettingsModal(100)/DevicesModal(110)，保证模态仍能盖住标题栏。 */
  position: relative; z-index: 50;
}
.tb-ico, .menubar, .mi { -webkit-app-region: no-drag; }
.tb-ico {
  width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
  border-radius: var(--r-control); color: var(--label-secondary); cursor: pointer;
}
.tb-ico:hover { background: var(--fill-quaternary); }
.menubar { display: flex; gap: 1px; }
.mi {
  position: relative; font-size: 13px; padding: 5px 10px; border-radius: var(--r-control);
  color: var(--label); cursor: pointer;
}
.mi:hover, .mi.open { background: var(--fill-quaternary); }
.pop { position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; min-width: 230px; }
.mpop {
  background: var(--grouped-bg-secondary); border: .5px solid var(--separator); border-radius: var(--r-md);
  padding: 5px; box-shadow: var(--shadow-pop);
}
.it {
  display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 6px;
  font-size: 13px; cursor: pointer; white-space: nowrap; color: var(--label);
}
.it:hover { background: var(--accent); color: var(--on-action); }
.it.danger { color: var(--red); }
.it .kbd { margin-left: auto; font-size: 12px; color: var(--label-tertiary); font-family: var(--font-mono); }
.it:hover .kbd { color: rgba(255, 255, 255, .7); }
.sep { height: .5px; background: var(--separator); margin: 5px 8px; }
.tb-title {
  flex: 1; text-align: center; font-size: 13px; font-weight: 600; color: var(--label-secondary);
  letter-spacing: .01em; pointer-events: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 右上角留给系统原生窗口控制（titleBarOverlay），此占位保证自绘内容不被遮挡 */
.tb-spacer { flex: 0 0 140px; }
/* M3c Task 7：同步状态点三态（决策 7b）——灰无设备/绿已同步/橙脉冲同步中 */
.syncdot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; -webkit-app-region: no-drag; }
.syncdot.offline { background: var(--label-tertiary); opacity: .5; }
.syncdot.idle { background: var(--state-ok); }
.syncdot.syncing { background: var(--state-warn); animation: m3c-pulse 1.2s ease-in-out infinite; }
@keyframes m3c-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
</style>
