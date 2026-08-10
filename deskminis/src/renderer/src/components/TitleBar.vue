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
  (e: 'toggle-chat'): void;
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
    { label: '切换对话列', act: 'chat' },
    { label: '切换工作台', act: 'right' },
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
    case 'chat': emit('toggle-chat'); break;
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
    <!-- 三个分区开关。MU5 前只有「切换侧栏」一枚图标，工作台开关藏在「视图」菜单里，
         对话列根本不能隐藏——想「只留主要模块」做不到。三枚一并提到可见处，
         且用原生 button（旧的 .tb-ico 是 div @click，Tab 走不到，属 MU3 遗留；其样式已随之删除）。 -->
    <div class="tb-segs">
      <button class="tb-seg" type="button" title="切换侧栏（Ctrl+B）" @click="emit('toggle-sidebar')"><Icon name="sidebar" :size="16" /></button>
      <button class="tb-seg" type="button" title="切换对话列" @click="emit('toggle-chat')">对话</button>
      <button class="tb-seg" type="button" title="切换工作台" @click="emit('toggle-right')">工作台</button>
    </div>
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
  background: var(--bg);
  border-bottom: .5px solid var(--separator);
  -webkit-app-region: drag; user-select: none; flex: 0 0 40px;
  /* MU3 材质全退场：毛玻璃改实底，滤镜摘除。
     下面的 position/z-index 保留为「防御性层级槽位」（论证见 renderer-titlebar-stacking.test.ts 头注）：
     背景滤镜曾创建层叠上下文、把下拉菜单 .pop 的 z-index:40 困在 titlebar 内部，
     当时靠给 titlebar 自身定位+层级把整棵子树抬到主体之上修复（CDP 实测取证）。
     诱因虽消失，但保留槽位可继续固化「主体所有 z-index < 50 < 模态 100/110」不变量，
     且未来任何滤镜/transform 重新引入层叠上下文时陷阱不复发；保留成本为零。 */
  position: relative; z-index: 50;
}
.menubar, .mi, .tb-segs { -webkit-app-region: no-drag; }
/* 分区开关：常驻可见，一眼看出哪些区能收起 */
.tb-segs { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.tb-seg {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 26px; padding: 0 8px; border: none; border-radius: var(--r-control);
  background: none; color: var(--label-secondary); cursor: pointer;
  font-size: var(--fs-micro); white-space: nowrap;
}
.tb-seg:hover { background: var(--fill-quaternary); color: var(--label); }
.tb-seg:focus-visible { outline: 2px solid var(--ring); outline-offset: -1px; }
.tb-seg :deep(svg) { stroke: var(--label-secondary); }
.menubar { display: flex; gap: 1px; }
.mi {
  position: relative; font-size: 13px; padding: 5px 10px; border-radius: var(--r-control);
  color: var(--label); cursor: pointer;
}
.mi:hover, .mi.open { background: var(--fill-quaternary); }
.mi:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
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
.it:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.it.danger { color: var(--red); }
.it .kbd { margin-left: auto; font-size: 12px; color: var(--label-tertiary); font-family: var(--font-mono); }
.it:hover .kbd { color: var(--on-action); opacity: .7; }
.sep { height: .5px; background: var(--separator); margin: 5px 8px; }
.tb-title {
  flex: 1; text-align: center; font-size: 13px; font-weight: 600; color: var(--label-strong);
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
