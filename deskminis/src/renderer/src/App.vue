<script setup lang="ts">
/** 应用外壳。
 *
 *  MU2b：三栏 232 | 1fr | 360——对话伸展、右栏定宽可拖。
 *  MU5（布局 B，用户 2026-08-10 拍板）：**flex 关系反转**为
 *  图标轨 52（或展开 212）| 对话列 336 定宽可拖 | 工作台 1fr。
 *  变的不是数值，是哪一栏承担弹性：工作台要装网页与截图，越宽越有用，不该由用户手动挤；
 *  对话列反而有明确的舒适阅读区间，所以把定宽与拖拽给它。
 *
 *  可拖边界随之移到对话列右缘，区间 [280,520]、默宽 336，持久化键换名
 *  deskminis.rightW → deskminis.chatW —— 旧值 360 落在新区间内 clamp 拦不住，
 *  不换键就会被静默当成「用户设过的对话列宽」复原（计划决策 2-6）。
 *
 *  MU2b Task 5 遗留：设置独立模态（SettingsModal），右栏 gear 退场；托盘
 *  menu:open-settings/menu:toggle-right 死通道经 preload 两订阅接通；主题偏好持久化。 */
import { onMounted, onBeforeUnmount, ref, computed, provide, reactive, watch } from 'vue';
import { useChat } from './stores/chat';
import { isBlankState } from './lib/welcome/blank';
import { clampPaneWidth, nextWidth } from './lib/pane/drag';
import { loadTheme, saveTheme, type ThemeMode } from './lib/settings/theme';
import { fmtElapsed } from './lib/time/elapsed';
import Icon from './components/Icon.vue';
import TitleBar from './components/TitleBar.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import FilesPanel from './components/FilesPanel.vue';
import ProgressPanel from './components/ProgressPanel.vue';
import ArtifactsPanel from './components/ArtifactsPanel.vue';
import SettingsModal from './components/SettingsModal.vue';
import DevicesModal from './components/DevicesModal.vue';
import MarketPanel from './components/MarketPanel.vue';

const chat = useChat();

/** 左区三态由两个开关组合：railOpen 决定左区在不在，sidebarExpanded 决定它是
 *  52px 图标轨还是 212px 完整列表。默认折叠为图标轨（计划决策 2-2「工作态默认纯图标」），
 *  展开时**挤压**对话列而非浮层覆盖——浮层会遮住正在读的内容。 */
const railOpen = ref(true);
/** 大屏阈值（用户 2026-08-11 拍板 1600）。**只影响首次默认，不监听 resize**——
 *  窗口一变大就自动展开侧栏会打断用户手动折叠的意图，那比默认不对更烦人。 */
const LARGE_SCREEN_W = 1600;
const isLargeScreen = window.innerWidth >= LARGE_SCREEN_W;
/** 大屏默认展开会话列表（看得到会话名），小屏仍折为图标轨——
 *  窄窗口里 212px 侧栏会把对话列和工作台一起挤瘦。 */
const sidebarExpanded = ref(isLargeScreen);
/** 三个分区各自可隐藏，但**对话列与工作台不能同时隐藏**——那会留下一个空壳白屏。
 *  左区可以整个隐掉（它是导航，不是内容）。 */
const chatOpen = ref(true);
const workbenchOpen = ref(true);
/** I3 欢迎态（设计稿 2026-08-20 §5，AionUi Guid 页形态）：会话流完全空白时工作台退场、
 *  对话列铺满、ChatView 渲染 hero 居中空态。判据与 ChatView 的空态共用 isBlankState
 *  纯模块——两处各写一份布尔式必然漂移。workbenchOpen/Expanded 的用户偏好不动，
 *  只在 v-show 上叠条件：发首条消息 welcomeMode 翻 false，工作台按原状态回场。 */
const welcomeMode = computed(() => isBlankState(chat));
/** 工作台第三态：折叠为 40px 图标条——与侧栏的 52px 图标轨同一个模式。
 *  为什么需要：完全隐藏后「开了哪些文件标签、进度上有没有待批准橙点」全都看不见了，
 *  而侧栏折叠成图标轨时这些信息都还在。折叠是为了省地方，不是为了失明。 */
const workbenchExpanded = ref(true);
function collapseWorkbench(): void { workbenchExpanded.value = false; }
function toggleChat(): void {
  if (chatOpen.value && !workbenchOpen.value) return; // 已是「只剩对话列」，不许再关
  // 收起对话列时工作台必须回到完整态，否则整屏只剩一条 40px 的窄条
  if (chatOpen.value) workbenchExpanded.value = true;
  chatOpen.value = !chatOpen.value;
}
function toggleWorkbench(): void {
  if (workbenchOpen.value && !chatOpen.value) return; // 已是「只剩工作台」，不许再关
  workbenchOpen.value = !workbenchOpen.value;
}
/** MU2b Task 5：settingsOpen 语义改为设置模态开关（原右栏 settings 分支退场） */
const settingsOpen = ref(false);
/** MU2b Task 7：配对管理面模态开关（左栏「设备」/ 设置模态「设备与同步」两入口） */
const devicesOpen = ref(false);
/** 工作台面板选择器。MU2b 是四值，MU5 增 browser/screen 两枚（本轮只出壳与空态，
 *  内容属后端里程碑 M8）。G3 增 market（扩展市场，全局 tab——不随会话切换重置）。
 *  **四个内置面板的 v-show 绑定一字不动**——renderer-artifacts /
 *  renderer-files-panel / renderer-tasks-panel 三个文件锚在这些绑定上。 */
type WbPanel = 'progress' | 'artifacts' | 'files' | 'terminal' | 'browser' | 'screen' | 'market';
const rightTab = ref<WbPanel>('progress');
/** 懒挂载 + v-show 保活（首次切到才创建组件，之后切换只隐藏不销毁）——
 *  内置内容面板均走此模式（market 同例：不进「扩展」tab 不发任何 market 请求）。 */
const visited = reactive({ progress: true, artifacts: false, files: false, terminal: false, market: false });
function isLazy(t: WbPanel): t is 'progress' | 'artifacts' | 'files' | 'terminal' | 'market' {
  return t === 'progress' || t === 'artifacts' || t === 'files' || t === 'terminal' || t === 'market';
}

/** 标签**条**改数组渲染（可关闭、可多开）；标签**体**仍是上面那组 v-show 绑定。
 *  拆开的理由：多开的本体是文件标签，它们共用 FilesPanel 一个渲染器，只是预览路径不同。 */
/** icon/short 只服务折叠条：图标给形状记忆，2 字短名消歧义——
 *  单靠图标会撞（产物与文件都是文件系语义），单靠文字在 56px 里放不下全名。 */
interface WbTab { id: string; label: string; panel: WbPanel; closable: boolean; live?: boolean; icon?: string; short?: string }
const BUILTIN_TABS: WbTab[] = [
  { id: 'progress', label: '进度', panel: 'progress', closable: false, icon: 'clock', short: '进度' },
  { id: 'artifacts', label: '产物', panel: 'artifacts', closable: false, icon: 'pencil', short: '产物' },
  { id: 'files', label: '文件', panel: 'files', closable: false, icon: 'folder', short: '文件' },
  { id: 'terminal', label: '终端', panel: 'terminal', closable: false, icon: 'terminal', short: '终端' },
  // G3 扩展市场：全局 tab（不随会话切换重置），不可关闭；visited 惰性挂载（不进 tab 不发 market 请求）
  { id: 'market', label: '扩展', panel: 'market', closable: false, icon: 'book', short: '扩展' },
  { id: 'browser', label: '浏览器', panel: 'browser', closable: true, icon: 'globe', short: '浏览' },
  // live 曾写死 true——屏幕能力根本没建，却常亮一个绿点让人以为有东西在跑。
  // 常驻位上的状态必须要么真、要么不出现（与 ProgressPanel 的上下文水位同口径）。
  { id: 'screen', label: '屏幕', panel: 'screen', closable: true, icon: 'monitor', short: '屏幕' },
];
const hiddenTabs = ref<string[]>([]);
const fileTabs = ref<WbTab[]>([]);
const activeTabId = ref<string>('progress');
const openTabs = computed<WbTab[]>(() => [
  ...BUILTIN_TABS.filter(t => !hiddenTabs.value.includes(t.id)),
  ...fileTabs.value,
]);

function showTab(tab: WbPanel): void {
  settingsOpen.value = false;
  rightTab.value = tab;
  if (isLazy(tab)) visited[tab] = true;
  activeTabId.value = tab;
}
function pickTab(t: WbTab): void {
  showTab(t.panel);
  activeTabId.value = t.id;
  // 文件标签复用 MU2b 既有 preview 通路：写 pendingFilePreview，FilesPanel watch 自行取用
  if (t.id.startsWith('file:')) chat.pendingFilePreview = t.id.slice(5);
}
/** 产物卡点击 → 在工作台开一个可关闭的文件标签（同一路径不重复开）。 */
function openFileTab(p: string): void {
  const id = `file:${p}`;
  if (!fileTabs.value.some(t => t.id === id)) {
    fileTabs.value.push({ id, label: p.split(/[\\/]/).pop() || p, panel: 'files', closable: true });
  }
  showTab('files');
  activeTabId.value = id;
}
function closeTab(id: string): void {
  if (id.startsWith('file:')) fileTabs.value = fileTabs.value.filter(t => t.id !== id);
  else if (!hiddenTabs.value.includes(id)) hiddenTabs.value.push(id);
  // 关掉的正是当前标签时，落到剩下的第一枚（关闭不该把工作台留成空白）
  if (activeTabId.value === id) {
    const first = openTabs.value[0];
    if (first) pickTab(first);
  }
}
/** 折叠条上点某枚标签：展开工作台并切到它（等价于侧栏图标轨点会话）。 */
function expandWorkbenchTo(t: WbTab): void {
  workbenchExpanded.value = true;
  pickTab(t);
}
/** 关闭是隐藏不是销毁：一键把收起来的内置标签放回来，免得关错了没路回。 */
function restoreTabs(): void { hiddenTabs.value = []; }

/** 左区实际占宽（与 .rail / .pane-l 的 CSS 定宽一一对应；改 CSS 要同步改这里）。 */
const RAIL_W = 52;
const SIDEBAR_W = 212;
/** 视口宽度（响应式）——对话列上限要随它收缩，否则窄窗口下会把工作台饿死。 */
const viewportW = ref(window.innerWidth);
function onResize(): void { viewportW.value = window.innerWidth; }
const leftW = computed(() => (railOpen.value ? (sidebarExpanded.value ? SIDEBAR_W : RAIL_W) : 0));
/** 对话列与工作台共同瓜分的宽度。 */
const availableW = computed(() => viewportW.value - leftW.value);

/** 对话列宽度：336 默认、下限 280，上限 min(520, 可用宽 − 工作台最小宽)（lib/pane/drag 纯逻辑），
 *  localStorage 持久化。分隔条在对话列**右**缘，故右拖增宽（drag.ts 的符号已随之取反）。 */
/** 与 ChatView 的可读栏同值（那边是 CSS 里的 792px）。改一处必须改另一处——
 *  大屏上对话列若窄于可读栏，文字会提前折行而右侧空着，那不叫比例好。 */
const CHAT_MEASURE_W = 792;
/** 默认宽随屏幕分档：大屏给可读栏满宽，小屏沿用 336。
 *  仅是**默认**——localStorage 里存过的值优先（见 onMounted）。 */
const chatW = ref(isLargeScreen ? CHAT_MEASURE_W : 336);
/** 可用宽一变就重钳：窗口缩小、侧栏展开（多吃 160px）都会压缩上限。
 *  没有这条时，在大屏拖到 520 再把窗口缩到 900 并展开侧栏，工作台会只剩 168px。 */
watch(availableW, (av) => { chatW.value = clampPaneWidth(chatW.value, av); });
function startCDrag(e: MouseEvent): void {
  const startX = e.clientX;
  const startW = chatW.value;
  const onMove = (ev: MouseEvent): void => { chatW.value = nextWidth(startX, startW, ev.clientX, availableW.value); };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    localStorage.setItem('deskminis.chatW', String(chatW.value));
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/** 顶部任务条——把「过程」摆到常驻位。
 *  诊断根一（v4 §2）：右栏四标签装的全是**结果**（进度/产物/文件/终端都是操作完的产物），
 *  agent 正在干什么、干到第几步、烧了多少上下文，全程没有一个常驻的地方能看到。
 *  数据全部取自既有 store 字段（running / toolCards / contextInfo / pendingPerms），零新 RPC。 */
const runStartedAt = ref(0);
const nowMs = ref(Date.now());
let taskTick: ReturnType<typeof setInterval> | null = null;
watch(() => chat.running, (r) => { if (r) runStartedAt.value = Date.now(); });

/** 上下文水位：contextInfo 缺席时返回 null 而不是编一个 0——
 *  常驻位上的数字必须要么真、要么不出现（ProgressPanel 同口径）。 */
const contextPct = computed<number | null>(() => {
  const ci = chat.contextInfo;
  if (!ci || ci.windowTokens <= 0) return null;
  return Math.min(100, Math.round((ci.usedTokens / ci.windowTokens) * 100));
});
const taskbarText = computed(() => {
  const seg: string[] = [];
  const cards = chat.toolCards;
  const cur = [...cards].reverse().find(c => c.success === undefined);
  if (chat.running) seg.push(cur ? (cur.title || cur.name) : '思考中');
  else seg.push(chat.activeId ? '空闲' : '未开始会话');
  if (cards.length) seg.push(`第 ${cards.filter(c => c.success !== undefined).length + (cur ? 1 : 0)}/${cards.length} 步`);
  if (chat.running && runStartedAt.value) seg.push(fmtElapsed(nowMs.value - runStartedAt.value));
  const pct = contextPct.value;
  if (pct !== null) seg.push(`上下文 ${pct}%`);
  return seg.join(' · ');
});

/** 图标轨上的会话项。
 *  会话是**实例**不是类别，给它们配图标只会全都一样、毫无信息——所以这里用文字。
 *  初版取首字不可读（两个「E2E 验收」都显示 E）；竖排可读但难看。
 *  定形：取前 2 字横排 + 状态点。2 字在 34px 里放得下，也足以区分同前缀的会话。 */
const railSessions = computed(() => chat.sessions.slice(0, 8) as { id: string; title: string }[]);
function railLabel(s: { title: string }): string {
  return (s.title || '新会话').trim().slice(0, 2);
}

// 明暗：system 跟随系统 / light 强制浅 / dark 强制深——落到 <html data-theme>；localStorage 持久化（Task 5 前为内存态，重启丢失）
const theme = ref<ThemeMode>(loadTheme());
function applyTheme(): void {
  const el = document.documentElement;
  if (theme.value === 'system') el.removeAttribute('data-theme');
  else el.dataset.theme = theme.value;
}
function setTheme(t: ThemeMode): void {
  theme.value = t;
  saveTheme(t);
  applyTheme();
}
function cycleTheme(): void {
  setTheme(theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system');
}

// 当前会话标题（无选中时留空）——首帧 activeId 为空、sessions 为空也不解引用 undefined
const activeTitle = computed(() => chat.sessions.find(s => s.id === chat.activeId)?.title ?? '');

// ModelPicker「管理模型…」与左栏「设置」入口经此开设置模态（无需逐层 emit）
provide('openSettings', () => { settingsOpen.value = true; });
// MU2b Task 7：左栏「设备」与设置模态「设备与同步」入口经此开配对管理面；开设备面时收起设置模态避免叠层
provide('openDevices', () => { settingsOpen.value = false; devicesOpen.value = true; });
// MU2b Task 3：产物卡点击 → 切工作台 tab（等价 tab 点击，供深层组件调用）。
// MU5 增量：带着待预览文件切到 files 时，额外开一个可关闭的文件标签——
// ArtifactsPanel / FilesPanel 一行不用改，多开能力从既有通路上长出来。
provide('switchRightTab', (tab: WbPanel) => {
  workbenchOpen.value = true;
  const p = chat.pendingFilePreview;
  if (tab === 'files' && typeof p === 'string' && p) openFileTab(p);
  else showTab(tab);
});

// Ctrl+, 开/关设置模态（设计 §1.1-2；不拦截输入区文本键入）
function onGlobalKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === ',') {
    e.preventDefault();
    settingsOpen.value = !settingsOpen.value;
  }
}

onMounted(() => {
  // 存过的值优先；没存过则用上面按屏幕分档的默认。两条都要过 clamp——
  // 大屏默认 792 在 1600 窗口上会超过「不占过半 + 工作台不饿死」的上限。
  const saved = Number(localStorage.getItem('deskminis.chatW'));
  chatW.value = clampPaneWidth(saved || chatW.value, availableW.value);
  applyTheme(); // 启动即应用 loadTheme 读回的偏好
  // MU2b Task 5：托盘菜单死通道接通（preload 白名单两订阅；main 侧零改动）
  const bridge = (window as { deskminis?: { onMenuOpenSettings?: (cb: () => void) => void; onMenuToggleRight?: (cb: () => void) => void } }).deskminis;
  bridge?.onMenuOpenSettings?.(() => { settingsOpen.value = true; });
  bridge?.onMenuToggleRight?.(() => { toggleWorkbench(); });
  taskTick = setInterval(() => { nowMs.value = Date.now(); }, 1000);
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onGlobalKey);
  void chat.init();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey);
  window.removeEventListener('resize', onResize);
  if (taskTick) clearInterval(taskTick);
});
</script>

<template>
  <div class="shell">
    <TitleBar
      :title="activeTitle"
      :welcome="welcomeMode"
      @toggle-sidebar="railOpen = !railOpen"
      @toggle-chat="toggleChat"
      @toggle-right="toggleWorkbench"
      @toggle-theme="cycleTheme"
    />
    <!-- 任务条：状态点 · 当前动作/步数/耗时/上下文水位 · 待批准计数（常驻，不随标签切换消失） -->
    <div class="taskbar">
      <span class="tb-dot" :class="{ live: chat.running }"></span>
      <span class="tb-text">{{ taskbarText }}</span>
      <button
        v-if="chat.pendingPerms.length" class="tb-pend" type="button"
        title="有权限请求等待批准" @click="showTab('progress')"
      >{{ chat.pendingPerms.length }} 项待批准</button>
    </div>
    <div class="win">
      <!-- 折叠态：52px 图标轨（AionUi 工作视图——进入工作态后会话列表压成纯图标） -->
      <nav v-show="railOpen && !sidebarExpanded" class="rail">
        <button class="rl" type="button" title="新建会话" @click="chat.newSession()"><Icon name="plus" :size="16" /></button>
        <button class="rl" type="button" title="展开会话列表" @click="sidebarExpanded = true">☰</button>
        <button
          v-for="s in railSessions" :key="s.id" type="button"
          class="rl ag" :class="{ on: s.id === chat.activeId }" :title="s.title || '新会话'"
          @click="chat.open(s.id)"
        >
          <span class="rl-txt">{{ railLabel(s) }}</span>
          <span v-if="s.id === chat.activeId && chat.pendingPerms.length > 0" class="rl-badge">{{ chat.pendingPerms.length }}</span>
        </button>
        <span class="rsp"></span>
        <button class="rl" type="button" title="设置" @click="settingsOpen = true"><Icon name="gear" :size="16" /></button>
      </nav>
      <!-- 展开态：212px 完整列表（挤压对话列，非浮层） -->
      <aside v-show="railOpen && sidebarExpanded" class="pane-l">
        <SessionList @collapse="sidebarExpanded = false" />
      </aside>
      <!-- I3：welcomeMode 下三处同步——工作台隐、折叠条隐、对话列解除定宽铺满。
           少一处就是「工作台隐了、对话列还钉在 336px」的死白（H 波教训 2 同族）。 -->
      <main v-show="chatOpen" class="pane-chat" :style="workbenchOpen && workbenchExpanded && !welcomeMode ? { width: chatW + 'px', flex: '0 0 ' + chatW + 'px' } : {}">
        <ChatView />
        <div class="cdrag" @mousedown="startCDrag"></div>
      </main>
      <section v-show="workbenchOpen && workbenchExpanded && !welcomeMode" class="pane-w">
        <div class="wtabs">
          <div
            v-for="t in openTabs" :key="t.id"
            class="wtab" :class="{ on: !settingsOpen && activeTabId === t.id, 'dot-warn': t.id === 'progress' && chat.pendingPerms.length > 0 }"
          >
            <button class="wtab-main" type="button" @click="pickTab(t)">
              <span v-if="t.live" class="lv"></span>{{ t.label }}
            </button>
            <button v-if="t.closable" class="wtab-x" type="button" :title="`关闭 ${t.label}`" @click="closeTab(t.id)">✕</button>
          </div>
          <button v-if="hiddenTabs.length" class="wtab-more" type="button" title="恢复收起的标签" @click="restoreTabs">＋{{ hiddenTabs.length }}</button>
          <button class="wtab-collapse" type="button" title="折叠为图标条" @click="collapseWorkbench">⇥</button>
        </div>
        <!-- 模式段控 + 动作行：目前只有浏览器标签用得上（来源 AionUi 预览区头部）。
             **全部 disabled**：浏览器能力属独立里程碑、当前版本未包含（面板正文已写明），
             但这排控件原本是能点的真 button——点了没反应，正是用户在工作区 chip 上指出的同一类问题。
             保留可见是为了说清设计意图，disabled + title 说清为什么点不了。 -->
        <div v-show="rightTab === 'browser'" class="wctl">
          <div class="seg">
            <button type="button" class="on" disabled title="浏览器能力尚未启用">页面</button>
            <button type="button" disabled title="浏览器能力尚未启用">源码</button>
            <button type="button" disabled title="浏览器能力尚未启用">分屏</button>
          </div>
          <span class="wurl">about:blank</span>
          <div class="wact">
            <button type="button" disabled title="浏览器能力尚未启用">快照</button>
            <button type="button" disabled title="浏览器能力尚未启用">历史</button>
            <button type="button" disabled title="浏览器能力尚未启用">系统打开</button>
            <button type="button" disabled title="浏览器能力尚未启用">下载</button>
          </div>
        </div>
        <div v-show="rightTab === 'progress'" class="rfill"><ProgressPanel v-if="visited.progress" /></div>
        <div v-show="rightTab === 'artifacts'" class="rfill"><ArtifactsPanel v-if="visited.artifacts" /></div>
        <div v-show="rightTab === 'files'" class="rfill"><FilesPanel v-if="visited.files" /></div>
        <div v-show="rightTab === 'terminal'" class="rfill"><TerminalPanel v-if="visited.terminal" /></div>
        <div v-show="rightTab === 'market'" class="rfill"><MarketPanel v-if="visited.market" /></div>
        <!-- 浏览器 / 屏幕：本轮只出壳与空态，内容属后端里程碑（Playwright/CDP 与 computer use）。
             空态文案说清「为什么现在是空的、要什么才不空」，不做「敬请期待」这类无信息量占位。 -->
        <div v-show="rightTab === 'browser'" class="rfill wempty">
          <p class="we-t">浏览器视图尚未启用</p>
          <p class="we-d">启用后这里会实时显示 agent 正在浏览的页面、点了哪里、填了什么。<br />浏览器能力属独立里程碑，当前版本未包含。</p>
        </div>
        <div v-show="rightTab === 'screen'" class="rfill wempty">
          <p class="we-t">屏幕视图尚未启用</p>
          <p class="we-d">启用后这里会显示 agent 操作桌面时的实时画面与操作轨迹。<br />computer use 能力属独立里程碑，当前版本未包含。</p>
        </div>
      </section>
      <!-- 折叠态：56px 图标条（对齐侧栏图标轨的模式）。两轮返工的结论：
           ① 单字缩写（进/产/文/终/浏/屏）不可读——中文单字脱离词没有意义；
           ② 竖排完整词可读但不好看——窄框里堆成又高又瘦的块、3 字项比 2 字项高一截、
              激活描边套上去像盖了个印章，且与「苹果磨砂科技感」方向相冲
              （VS Code / Slack / Discord / AionUi 的边栏全是图标轨，没人竖排）。
           定形：**图标 + 2 字短名**。图标给形状记忆，短名消歧义——
           单靠图标会撞（产物与文件都是文件系语义），单靠文字在 56px 里放不下全名。 -->
      <nav v-show="workbenchOpen && !workbenchExpanded && !welcomeMode" class="wbrail">
        <button
          v-for="t in openTabs" :key="t.id" type="button"
          class="wbr" :class="{ on: activeTabId === t.id }" :title="t.label"
          @click="expandWorkbenchTo(t)"
        >
          <span v-if="t.live" class="wbr-live"></span>
          <Icon :name="t.icon || 'file'" :size="17" />
          <span class="wbr-txt">{{ t.short || t.label.slice(0, 2) }}</span>
          <span v-if="t.id === 'progress' && chat.pendingPerms.length > 0" class="wbr-badge">{{ chat.pendingPerms.length }}</span>
        </button>
      </nav>
    </div>
    <SettingsModal v-if="settingsOpen" :theme="theme" @set-theme="setTheme" @close="settingsOpen = false" />
    <DevicesModal v-if="devicesOpen" @close="devicesOpen = false" />
  </div>
</template>

<style scoped>
/* E2 极光底：background-color 与 background-image 分两属性写——--aurora-ground 是 image
   列表，并进 background 简写会把颜色冲掉。I2（AionUi 换向）：--aurora-1..3 已全透明，
   斑不再显形，但结构保留——将来若回极光只动参考文件，这里一行不用改 */
.shell {
  display: flex; flex-direction: column; height: 100vh;
  background-color: var(--bg); background-image: var(--aurora-ground);
}
.win { flex: 1; display: flex; min-height: 0; overflow: hidden; }

/* 顶部任务条：常驻的「现在在干什么」。两家参考产品都没有这一条——
   是 DeskMinis 自己的命题（过程可见），故不照抄而是自定（v4 §4-1）。 */
.taskbar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  height: 34px; padding: 0 12px;
  /* I2 平面化：实色底 + 底边框（AionUi 卡片语言）。玻璃/受光边退场是对 2026-08-10
     「苹果磨砂」要求的覆盖性偏离（设计稿 2026-08-20 §0，用户新指令优先） */
  background: var(--surface-1);
  border-bottom: 1px solid var(--separator);
}
.tb-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--label-quaternary); flex: 0 0 auto; }
/* E2：运行点换青 + --glow-accent 光晕 + 脉冲（设计稿 §5：running 态用青点脉冲表达活动） */
.tb-dot.live {
  background: var(--accent); box-shadow: 0 0 8px var(--glow-accent);
  animation: tb-pulse 1.6s ease-in-out infinite;
}
@keyframes tb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
.tb-text {
  flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-mono);
  color: var(--label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* E2：权限徽记换青底深字胶囊（Aurora 单强调色语言；警示语义仍由进度 tab 的橙点承担） */
.tb-pend {
  flex: 0 0 auto; padding: 2px 9px; border-radius: var(--r-pill);
  border: none; background: var(--accent);
  color: var(--on-action); font-size: var(--fs-micro); font-weight: 600; cursor: pointer;
}
.tb-pend:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

/* 图标轨（折叠态）——来源 AionUi 工作视图：进入工作态后会话列表压成纯图标 */
.rail {
  width: 52px; flex: 0 0 52px;
  /* I2 平面化：实色轨（AionUi 侧栏白底语言） */
  background: var(--surface-1);
  border-right: 1px solid var(--separator);
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  padding: 9px 0; overflow: hidden;
}
.rl {
  position: relative; flex: 0 0 auto; width: 34px; height: 34px;
  border-radius: var(--r-md); border: 1px solid transparent; background: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600; color: var(--label-tertiary); cursor: pointer;
}
.rl:hover { background: var(--fill-quaternary); color: var(--label); }
/* MU5 §5 红线 6：新增交互元素一律原生 button + :focus-visible 环，不再新增 div @click */
.rl:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.rl :deep(svg) { stroke: var(--label-secondary); }
.rl.ag {
  background: var(--surface-1); border-color: var(--separator); color: var(--label-secondary);
  font-size: 11px; font-weight: 500;
}
.rl-txt { line-height: 1; white-space: nowrap; letter-spacing: .01em; }
.rl.on { border-color: var(--action); color: var(--action); }
/* 激活项左侧 2px 竖条（AionUi 的激活标识，比整块反白克制）；E2 直指 --accent（Aurora 单强调色） */
.rl.on::before {
  content: ''; position: absolute; left: -9px; top: 8px; bottom: 8px;
  width: 2px; border-radius: 2px; background: var(--accent);
}
/* 待批准计数徽标：原 .dot-warn 只挂在「进度」tab 上，折叠态根本看不见，故扩到图标轨 */
.rl-badge {
  position: absolute; top: -2px; right: -3px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: var(--r-pill); border: 1.5px solid var(--bg-secondary);
  background: var(--state-warn); color: var(--on-action);
  font-size: 9px; font-weight: 700; line-height: 11px; text-align: center;
}
.rsp { flex: 1; }

.pane-l {
  width: 212px; flex: 0 0 212px; background: var(--bg); border-right: .5px solid var(--separator);
  display: flex; flex-direction: column; overflow: hidden;
}
/* 对话列外壳。**类名不能叫 .pane-c**——ChatView 的根元素正是 .pane-c，而 Vue 的
   子组件根会同时带上父组件的 scope id，App.vue 的 .pane-c 规则会**泄漏进 ChatView 根**。
   MU2b 时这条规则只有 flex:1，泄漏无害；MU5 给它加了 width:336px，泄漏就把 ChatView
   钉死在 336px——收起工作台时外壳铺满 1228 而内容仍是 336，右边一大片死白。
   真机截图逮到，1048 例源码守卫与 e2e 8/8 全绿都看不见（两层同宽时无从分辨）。
   flex 写 1 1 auto 是为工作台收起时能自然铺满；工作台展开时由内联 style 覆写成 0 0 chatW。 */
.pane-chat {
  position: relative;
  width: 336px; flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; background: var(--bg);
}
/* 工作台：承担弹性——它装网页与截图，越宽越有用 */
.pane-w {
  flex: 1; min-width: 0; border-left: .5px solid var(--separator); background: var(--bg);
  display: flex; flex-direction: column; overflow: hidden;
}
/* 6px 拖拽热区：跨骑在对话列右缘（border 上），绝对定位不占布局 */
.cdrag { position: absolute; right: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
/* 工作台标签条：数组渲染、可关闭、可多开（来源 AionUi 预览区的多标签形态）。
   与 MU2b 的等分四枚不同——标签按内容宽度排，才容得下多开的文件名。 */
.wtabs {
  display: flex; align-items: center; gap: 3px; padding: 7px 10px 0;
  /* I2 平面化：实色页签条 */
  background: var(--surface-1);
  border-bottom: 1px solid var(--separator); overflow-x: auto;
}
.wtab {
  position: relative; flex: 0 0 auto; display: flex; align-items: center;
  border-radius: var(--r-control) var(--r-control) 0 0; border: 1px solid transparent; border-bottom: none;
}
.wtab-main {
  display: flex; align-items: center; gap: 6px; padding: 5px 4px 5px 10px;
  border: none; background: none; cursor: pointer;
  font-size: var(--fs-ui); font-weight: 500; color: var(--label-tertiary); white-space: nowrap;
}
.wtab-x {
  border: none; background: none; cursor: pointer; padding: 5px 8px 5px 2px;
  font-size: 11px; line-height: 1; color: var(--label-tertiary);
}
.wtab-main:focus-visible, .wtab-x:focus-visible, .wtab-more:focus-visible {
  outline: 2px solid var(--ring); outline-offset: -2px;
}
.wtab:hover { background: var(--fill-quaternary); }
.wtab-x:hover { color: var(--label); }
/* E2：活跃页签加底缘 2px 青色指示线——inset 阴影不占布局，避免 border 引起位移 */
.wtab.on {
  background: var(--surface-1); border-color: var(--separator);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.wtab.on .wtab-main { color: var(--label); font-weight: 600; }
/* 实时标签活动点（屏幕/浏览器这类会持续变化的视图）；E2 换青（Aurora 单强调色） */
.lv { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: 0 0 auto; }
.wtab-more {
  flex: 0 0 auto; margin-left: 2px; padding: 4px 8px; border: .5px solid var(--separator);
  border-radius: var(--r-control); background: none; cursor: pointer;
  font-size: var(--fs-micro); color: var(--label-secondary);
}
/* 进度标签等待批准橙点（审计 H4：pendingPerms>0 显著化） */
.wtab.dot-warn::after {
  content: ''; position: absolute; top: 2px; right: 4px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--state-warn);
}

/* 模式段控 + 地址 + 右对齐动作行（来源 AionUi 预览区头部） */
.wctl {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border-bottom: .5px solid var(--separator); background: var(--surface-1); flex: 0 0 auto;
}
.wctl .seg button:disabled, .wctl .wact button:disabled { opacity: var(--opacity-disabled); cursor: default; }
.seg { display: flex; border: .5px solid var(--separator); border-radius: var(--r-control); overflow: hidden; }
.seg button {
  border: none; background: none; cursor: pointer;
  padding: 3px 10px; font-size: var(--fs-micro); color: var(--label-secondary);
}
.seg button.on { background: var(--action); color: var(--on-action); font-weight: 600; }
.seg button:focus-visible, .wact button:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.wurl {
  flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-micro);
  color: var(--label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 动作行右对齐、低对比——它是随时可用但不该抢戏的一层 */
.wact { display: flex; gap: 12px; margin-left: auto; flex: 0 0 auto; }
.wact button {
  border: none; background: none; cursor: pointer; padding: 2px 0;
  font-size: var(--fs-micro); color: var(--label-tertiary); white-space: nowrap;
}
.wact button:hover { color: var(--label); }

/* 折叠钮：把工作台收成 40px 图标条 */
.wtab-collapse {
  flex: 0 0 auto; margin-left: auto; padding: 4px 8px; border: none; background: none;
  border-radius: var(--r-control); color: var(--label-tertiary); cursor: pointer; font-size: 12px;
}
.wtab-collapse:hover { background: var(--fill-quaternary); color: var(--label); }
.wtab-collapse:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }

/* 工作台折叠条（第三态）——与 .rail 同一个模式，只是竖排的是标签不是会话 */
.wbrail {
  flex: 0 0 56px; width: 56px; background: var(--bg-secondary);
  border-left: .5px solid var(--separator);
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px 0; overflow: hidden;
}
.wbr {
  position: relative; flex: 0 0 auto; width: 48px; padding: 7px 0 6px;
  border-radius: var(--r-md); border: 1px solid transparent; background: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  font-size: 10px; font-weight: 500; color: var(--label-tertiary); cursor: pointer;
}
.wbr :deep(svg) { stroke: currentColor; }
.wbr-txt { line-height: 1; white-space: nowrap; letter-spacing: .02em; }
.wbr:hover { background: var(--fill-quaternary); color: var(--label); }
.wbr:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.wbr.on { background: var(--surface-1); border-color: var(--action); color: var(--action); }
.wbr-live {
  position: absolute; top: 4px; right: 8px;
  width: 5px; height: 5px; border-radius: 50%; background: var(--state-ok);
}
/* 折叠态仍要看得见待批准——折叠是省地方，不是失明 */
.wbr-badge {
  position: absolute; top: -3px; right: -4px; min-width: 13px; height: 13px; padding: 0 3px;
  border-radius: var(--r-pill); border: 1.5px solid var(--bg-secondary);
  background: var(--state-warn); color: var(--on-action);
  font-size: 9px; font-weight: 700; line-height: 10px; text-align: center;
}

/* 未启用能力的空态：说清「为什么空、要什么才不空」 */
.wempty { align-items: center; justify-content: center; text-align: center; padding: 0 32px; }
.we-t { margin: 0 0 8px; font-size: var(--fs-title); font-weight: 600; color: var(--label-secondary); }
.we-d { margin: 0; font-size: var(--fs-ui); line-height: 1.7; color: var(--label-tertiary); }
.rfill { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
</style>
