<script setup lang="ts">
/** 左栏 · 会话列表（MU2b Task 4，设计 §1.1-1 变体 A 定稿）——任务卡式：
 *  标题 + 相对时间 + 状态徽标（●进行中绿 / ⏸等待批准橙 / ✕失败红 / ✓完成灰）+ 产物计数角标。
 *  粘性日期分组头（置顶/今天/昨天/本周/本月/更早）沿用 M1 既有；底部固定「设置/设备」入口
 * （设置 → inject('openSettings') 开独立模态（Task 5 已切）；设备 → inject('openDevices') 开
 *  DevicesModal 配对管理面（Task 7 已填实））。
 *  数据源诚实说明：sessions.list RPC 无 running/messages 字段，徽标与角标仅活动会话可得（lib/session/status）。 */
import { computed, inject, onUnmounted, ref } from 'vue';
import { useChat } from '../stores/chat';
import { sessionBadge, artifactCountOf, type SessionBadge } from '../lib/session/status';
import { fmtRelative } from '../lib/time/relative';
import Icon from './Icon.vue';

/** MU5：展开态需要一条回到 52px 图标轨的路（折叠由 App.vue 持有状态，此处只发信号）。 */
const emit = defineEmits<{ collapse: [] }>();

const chat = useChat();
// App.vue provide：打开设置独立模态（Task 5 起）
const openSettings = inject<() => void>('openSettings', () => {});
// App.vue provide：打开配对管理面 DevicesModal（MU2b Task 7）
const openDevices = inject<() => void>('openDevices', () => {});

interface S { id: string; title: string; updatedAt?: number; pinnedAt?: number;
              memoryEnabled?: boolean; modelBinding?: string; assistantId?: string }

/** J2：会话行助手 emoji 前缀（绑定悬空/无绑定回空串，行渲染自动省略）。 */
function avatarOf(s: S): string {
  return s.assistantId ? (chat.assistants.find(a => a.id === s.assistantId)?.avatar ?? '') : '';
}

/** J2 随动修缺的显示侧：旧库存量绑定是裸 provider id（无前缀），select 选项已换前缀值——
 *  显示时归一化补前缀，否则旧绑定行会错显成「跟随全局默认」（后端兼容分支同一语义）。 */
function bindingValue(s: S): string {
  const b = s.modelBinding ?? '';
  if (b === '' || b.startsWith('provider:') || b.startsWith('group:')) return b;
  return 'provider:' + b;
}

/** MU6 会话操作：哪一行的操作区展开了；哪一行处在删除二次确认态。
 *  刻意做成**行内展开**而不是浮层菜单：.list 有 overflow:auto，浮层会被裁掉——
 *  MU5 §15 刚因为「弹层被容器裁掉」吃过一次「点了没反应」的亏，这里从一开始就绕开。 */
const menuFor = ref('');
const confirmDelete = ref('');
function toggleMenu(id: string): void {
  menuFor.value = menuFor.value === id ? '' : id;
  confirmDelete.value = ''; // 换行即清掉确认态，避免「在 A 行点了确认、切到 B 行还悬着」
  closeRename();
}
async function onDelete(id: string): Promise<void> {
  await chat.deleteSession(id);
  menuFor.value = ''; confirmDelete.value = '';
}

/** B1 重命名：哪一行在改名、改成什么、上一次为什么没改成。
 *  后端会拒空标题与超 50 字，错误必须落在菜单里——吞掉就成了「点了确认没反应」。 */
const renameFor = ref('');
const renameText = ref('');
const renameErr = ref('');
function closeRename(): void { renameFor.value = ''; renameText.value = ''; renameErr.value = ''; }
function startRename(s: S): void {
  renameFor.value = s.id;
  renameText.value = s.title || '';  // 预填现有标题：改名多半是微调而不是重写
  renameErr.value = '';
}
async function submitRename(id: string): Promise<void> {
  try {
    await chat.renameSession(id, renameText.value);
    closeRename();
    menuFor.value = '';
  } catch (e) { renameErr.value = e instanceof Error ? e.message : String(e); }
}

const GROUP_ORDER = ['置顶', '今天', '昨天', '本周', '本月', '更早'];

function startOfDay(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

function groupOf(s: S): string {
  if (s.pinnedAt) return '置顶';
  const t = s.updatedAt ? s.updatedAt * 1000 : 0;
  if (!t) return '更早';
  const today = startOfDay(new Date());
  const day = 86400_000;
  if (t >= today) return '今天';
  if (t >= today - day) return '昨天';
  if (t >= today - 6 * day) return '本周';
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  if (t >= monthStart) return '本月';
  return '更早';
}

const grouped = computed(() => {
  const buckets = new Map<string, S[]>();
  for (const s of chat.sessions as S[]) {
    const g = groupOf(s);
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push(s);
  }
  return GROUP_ORDER.filter(g => buckets.has(g)).map(g => ({ group: g, items: buckets.get(g)! }));
});

// ---- 任务卡：相对时间（30s tick 刷新「N 分钟前」）+ 状态徽标 + 产物角标 ----
const nowSec = ref(Date.now() / 1000);
const tick = setInterval(() => { nowSec.value = Date.now() / 1000; }, 30_000);
onUnmounted(() => clearInterval(tick));

function relTime(s: S): string {
  return s.updatedAt ? fmtRelative(s.updatedAt, nowSec.value) : '';
}

/** 活动会话实时态（chat store 直取）；非活动会话 live=null → 徽标 null（数据源不可得，一期）。 */
const liveNow = computed(() => ({ running: chat.running, pendingPerms: chat.pendingPerms, lastStopReason: chat.lastStopReason }));
function badgeOf(s: S): SessionBadge {
  return sessionBadge(s, s.id === chat.activeId ? liveNow.value : null);
}
const BADGE_VIEW: Record<Exclude<SessionBadge, null>, { cls: string; text: string }> = {
  running: { cls: 'run', text: '● 进行中' },
  waiting: { cls: 'wait', text: '⏸ 等待批准' },
  failed: { cls: 'fail', text: '✕ 失败' },
  done: { cls: 'done', text: '✓ 完成' },
};

/** MU5：状态从「文字徽标」改「色点」后，颜色成了唯一编码——对色觉障碍不可读。
 *  补偿：把同一状态的文字挂到行的 title 上，hover 与读屏都拿得到。 */
function badgeText(s: S): string {
  const b = badgeOf(s);
  return b ? `${s.title || '新会话'} · ${BADGE_VIEW[b].text}` : (s.title || '新会话');
}

/** MU5 后端选择器：当前执行端。**只消费既有 chat.devices（remote.status）**，不新接 RPC。
 *  诚实说明：remote.status 只返回已配对对端列表，**不含本机设备名**——
 *  计划里写的「本机 · <设备名>」那个名字需要新通道，本轮红线 2 禁止，留给 MU6。 */
const backendLabel = computed(() => {
  const n = chat.devices.length;
  const base = n > 0 ? `本机 · 已配对 ${n} 台` : '本机';
  // MU6：同步暂停是个持久化的全局状态，改了却在常驻位上看不见，等于没接
  return chat.syncPaused ? `${base} · 同步已暂停` : base;
});

/** 产物角标：仅活动会话可得（messages 在 chat store）；0 不显示。 */
const activeArtifactCount = computed(() => artifactCountOf(chat.messages));
</script>

<template>
  <div class="pane">
    <!-- I6 品牌行（AionUi 新版侧栏：logo + 应用名置顶，折叠钮右置） -->
    <div class="brand">
      <span class="bmark">◆</span><span class="bname">DeskMinis</span>
      <button class="collapse" type="button" title="折叠为图标轨" @click="emit('collapse')"><Icon name="sidebar" :size="15" /></button>
    </div>
    <div class="lhead">
      <div class="newbtn" @click="chat.newSession()" tabindex="0" role="button" @keydown.enter.prevent="chat.newSession()" @keydown.space.prevent="chat.newSession()">
        <Icon name="plus" :size="16" /><span>新建会话</span>
      </div>
    </div>
    <div class="list">
      <template v-for="grp in grouped" :key="grp.group">
        <div class="datehead">
          <Icon v-if="grp.group === '置顶'" name="chevron-up" :size="11" /><span>{{ grp.group }}</span>
        </div>
        <!-- v-for 必须挂在 template 上：会话行与它的行内操作区是**两个兄弟节点**，
             若把 v-for 挂在 .scard 上，s 的作用域只覆盖 .scard 自己，
             下面 .smenu 里的 s 就是 undefined —— renderList 直接抛错、整个列表渲染挂掉。
             这个错源码文本守卫抓不到（字符串都在），typecheck 也抓不到（.vue 不在覆盖内），
             是 e2e:mu6 真跑起来才暴露的。 -->
        <template v-for="s in grp.items" :key="s.id">
        <div
          class="scard" :class="{ on: s.id === chat.activeId }" :data-sid="s.id" :title="badgeText(s)" tabindex="0" role="button" @keydown.enter.self.prevent="chat.open(s.id)" @keydown.space.self.prevent="chat.open(s.id)"
          @click="chat.open(s.id)"
        >
          <span class="sdot" :class="badgeOf(s) ? BADGE_VIEW[badgeOf(s)!].cls : 'idle'"></span>
          <span v-if="avatarOf(s)" class="semoji">{{ avatarOf(s) }}</span>
          <span class="stitle">{{ s.title || '新会话' }}</span>
          <span v-if="s.id === chat.activeId && activeArtifactCount > 0" class="scount">◈ {{ activeArtifactCount }}</span>
          <span class="stime">{{ relTime(s) }}</span>
          <button
            class="smore" type="button" :title="`${s.title || '新会话'} 的更多操作`"
            @click.stop="toggleMenu(s.id)"
          >⋮</button>
        </div>
        <!-- 行内操作区（非浮层，见上方注释） -->
        <div v-if="menuFor === s.id" class="smenu">
          <button class="smenu-item" type="button" @click.stop="chat.setSessionMemory(s.id, s.memoryEnabled === false)">
            记忆<span class="smenu-val">{{ s.memoryEnabled === false ? '已关闭' : '已开启' }}</span>
          </button>
          <label class="smenu-item smenu-sel">
            模型
            <select
              class="smenu-select" :value="bindingValue(s)"
              @click.stop @change="chat.setSessionModelBinding(s.id, ($event.target as HTMLSelectElement).value || undefined)"
            >
              <option value="">跟随全局默认</option>
              <!-- J2 随动修缺：写 'provider:' 前缀值——chat.prompt 解析只认前缀，
                   此前存裸 id 会静默落回默认模型（绑定形同虚设）。旧库存量裸 id 由后端兼容分支接住。 -->
              <option v-for="p in chat.providers" :key="p.id" :value="'provider:' + p.id">{{ p.name }}</option>
            </select>
          </label>
          <template v-if="renameFor !== s.id">
            <button class="smenu-item" type="button" @click.stop="startRename(s)">重命名</button>
          </template>
          <template v-else>
            <div class="smenu-row">
              <input
                class="smenu-input" type="text" placeholder="会话标题" :value="renameText"
                @click.stop @input="renameText = ($event.target as HTMLInputElement).value"
                @keydown.enter="submitRename(s.id)"
              >
              <button class="smenu-item smenu-keep smenu-ok" type="button" @click.stop="submitRename(s.id)">确认</button>
            </div>
            <div v-if="renameErr" class="smenu-err">{{ renameErr }}</div>
          </template>
          <template v-if="confirmDelete !== s.id">
            <button class="smenu-item smenu-danger" type="button" @click.stop="confirmDelete = s.id">删除会话</button>
          </template>
          <template v-else>
            <div class="smenu-ask">确认删除？此操作不可撤销。</div>
            <div class="smenu-row">
              <button class="smenu-item smenu-keep" type="button" @click.stop="confirmDelete = ''">取消</button>
              <button class="smenu-item smenu-danger" type="button" @click.stop="onDelete(s.id)">删除</button>
            </div>
          </template>
        </div>
        </template>
      </template>
    </div>
    <!-- 后端选择器钉底部（来源 Agent Canvas 侧栏底部 ● Local ⌄）：
         DeskMinis 有设备与同步能力，却从来没有「当前在哪台机器跑」的常驻入口。 -->
    <div class="bkrow">
      <span class="bk-dot" :class="{ paused: chat.syncPaused }"></span><span class="bk-name">{{ backendLabel }}</span>
    </div>
    <div class="lfoot">
      <button class="lfbtn" type="button" @click="openSettings()"><Icon name="gear" :size="14" /><span>设置</span></button>
      <button class="lfbtn" type="button" title="设备与同步" @click="openDevices()"><span>设备</span></button>
    </div>
  </div>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; height: 100%; background: var(--surface-1); overflow: hidden; }
/* I6 品牌行：AionUi 新版侧栏置顶 logo + 名（bmark 用字符标不引图片资产，零新资产） */
.brand {
  display: flex; align-items: center; gap: 8px; padding: 12px 14px 6px; flex: 0 0 auto;
}
.bmark {
  width: 24px; height: 24px; border-radius: 7px; background: var(--accent); color: var(--on-action);
  display: inline-flex; align-items: center; justify-content: center; font-size: 12px; flex: 0 0 auto;
}
.bname { flex: 1; min-width: 0; font-size: var(--fs-title); font-weight: 700; color: var(--label-emphasis); }
/* I6：New Chat 从灰底块钮改「透明行 + hover 灰」（AionUi 新版行式导航） */
.lhead { display: flex; align-items: center; gap: 6px; margin: 4px 8px 8px; flex: 0 0 auto; }
.collapse {
  flex: 0 0 auto; width: 28px; height: 28px; border-radius: var(--r-md);
  border: none; background: none; color: var(--label-tertiary); cursor: pointer;
  font-size: 13px; display: flex; align-items: center; justify-content: center;
}
.collapse:hover { background: var(--fill-quaternary); color: var(--label); }
.collapse:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.newbtn {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--r-control);
  background: none; color: var(--label); font-size: var(--fs-ui); font-weight: var(--fw-medium); cursor: pointer;
}
.newbtn:hover { background: var(--fill-tertiary); }
/* MU3 §2-5 焦点环 */
.newbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.newbtn :deep(svg) { stroke: var(--label); }
.list { flex: 1; min-height: 0; overflow: auto; padding: 0 6px 8px; }
.datehead {
  position: sticky; top: 0; z-index: 1; padding: 6px 10px; font-size: 12px; font-weight: var(--fw-medium);
  color: var(--label-secondary); background: var(--surface-1); display: flex; align-items: center; gap: 4px;
}
/* MU5：会话行由「两行任务卡」压成单行「状态点 + 标题 + 右对齐相对时间」
   （来源 Agent Canvas 侧栏）。MU2b 的两行卡在 212px 宽里占太多竖向空间，
   而侧栏的职责是「一眼扫完有哪些会话、哪个在跑」，不是展示每个会话的全部元数据。 */
/* I4（AionUi 换向）：会话行平面化——透明底、hover 灰、活跃灰底 + 左缘蓝线。
   AionUi 侧栏行语言：行不是卡，选中态靠底色说话（浮岛三件套退场）。 */
.scard {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 9px; border-radius: var(--r-card); margin-bottom: 1px; cursor: pointer;
}
.scard:hover { background: var(--fill-quaternary); }
.scard:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
/* 活跃行：灰底 + 左缘 2px accent 指示线（inset 零位移，I1 起为蓝） */
.scard.on {
  background: var(--fill-tertiary);
  box-shadow: inset 2px 0 0 var(--accent);
}
/* 状态点四态：类名与色令牌沿用 MU2b 的 BADGE_VIEW，只是从文字换成色点。
   色觉障碍补偿见 badgeText()——同一状态的文字挂在行 title 上。 */
.sdot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--label-quaternary); }
.sdot.run { background: var(--state-ok); }
.sdot.wait { background: var(--state-warn); }
.sdot.fail { background: var(--state-err); }
.sdot.done { background: var(--label-tertiary); }
.sdot.idle { background: var(--label-quaternary); }
/* J2：助手 emoji 前缀——只占内容宽，无绑定时元素不渲染（v-if），行高不变 */
.semoji { flex: 0 0 auto; font-size: 13px; line-height: 1; }
.stitle {
  flex: 1; min-width: 0;
  font-size: var(--fs-ui); font-weight: 500; color: var(--label-strong);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.scard.on .stitle { color: var(--action); font-weight: var(--fw-medium); }
/* E3：产物计数是「计数读数」，走 mono（Aurora §4 读数面） */
.scount { flex: 0 0 auto; font-size: var(--fs-micro); color: var(--label-secondary); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
/* 时间右对齐：等宽数字让各行的时间列自然对齐，不需要固定宽度 */
.stime {
  flex: 0 0 auto; margin-left: auto;
  font-size: var(--fs-micro); color: var(--label-tertiary); font-variant-numeric: tabular-nums;
}

/* MU6 行尾「⋮」：平时淡出，hover 或键盘聚焦时显形——不抢会话标题的视觉 */
.smore {
  flex: 0 0 auto; width: 20px; height: 20px; padding: 0; border: none; background: none;
  border-radius: var(--r-control); color: var(--label-tertiary); cursor: pointer;
  font-size: 13px; line-height: 1; opacity: 0; transition: opacity .12s ease-out;
}
.scard:hover .smore, .smore:focus-visible { opacity: 1; }
.smore:hover { background: var(--fill); color: var(--label); }
.smore:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

/* 行内操作区：撑在会话行下方，不是浮层——.list 的 overflow:auto 会把浮层裁掉 */
.smenu {
  margin: 2px 4px 6px; padding: 4px; border-radius: var(--r-md);
  background: var(--fill-quaternary); border: 1px solid var(--separator);
  display: flex; flex-direction: column; gap: 2px;
}
.smenu-item {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 6px 8px; border: none; border-radius: var(--r-control); background: none;
  font-size: var(--fs-micro); color: var(--label-secondary); cursor: pointer; text-align: left;
}
.smenu-item:hover { background: var(--fill-tertiary); color: var(--label); }
.smenu-item:focus-visible { outline: 2px solid var(--ring); outline-offset: -1px; }
.smenu-val { margin-left: auto; color: var(--label-tertiary); }
.smenu-sel { cursor: default; }
.smenu-select {
  margin-left: auto; max-width: 108px; border: 1px solid var(--separator);
  border-radius: var(--r-control); background: var(--surface-1); color: var(--label);
  font-size: var(--fs-micro); padding: 2px 4px; cursor: pointer;
}
.smenu-select:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
/* 危险项：颜色区分 + 二次确认。红线 6 要求默认焦点不落在危险项上——
   确认态里「取消」排在「删除」左边、且是先出现的可聚焦元素。 */
.smenu-danger { color: var(--state-err); }
.smenu-danger:hover { background: var(--state-err-bg); color: var(--state-err); }
.smenu-ask { padding: 6px 8px; font-size: var(--fs-micro); color: var(--label-secondary); line-height: 1.5; }
/* 重命名输入行：与 .smenu-select 同一套外观令牌，免得菜单里两种输入控件长得不像一家 */
.smenu-input {
  flex: 1; min-width: 0; padding: 4px 6px;
  border: 1px solid var(--separator); border-radius: var(--r-control);
  background: var(--surface-1); color: var(--label); font-size: var(--fs-micro);
}
.smenu-input:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
/* 选择器要带 .smenu-row：上面 `.smenu-row .smenu-item{flex:1}` 特指度更高，
   单写 .smenu-ok 压不过它，确认钮会被拉成和输入框一样宽 */
.smenu-row .smenu-ok { flex: 0 0 auto; }
/* 后端拒了要说清为什么（空标题 / 超 50 字），不然确认按钮看着像失灵 */
.smenu-err { padding: 4px 8px 2px; font-size: var(--fs-micro); color: var(--state-err); line-height: 1.5; }
.smenu-row { display: flex; gap: 4px; }
.smenu-row .smenu-item { flex: 1; justify-content: center; }
.smenu-keep { background: var(--surface-1); border: 1px solid var(--separator); }

/* 后端选择器：常驻的「当前在哪台机器跑」。本轮是纯指示（无交互元素，
   故不需要 button）——切换执行端的能力尚不存在，不做假的下拉箭头。 */
.bkrow {
  flex: 0 0 auto; display: flex; align-items: center; gap: 7px;
  padding: 7px 14px; border-top: 1px solid var(--separator);
  font-size: var(--fs-micro); color: var(--label-secondary);
}
.bk-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--state-ok); flex: 0 0 auto; }
.bk-dot.paused { background: var(--state-warn); }
.bk-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 底部固定入口：设置（独立模态）/ 设备（DevicesModal，Task 7 已填实） */
.lfoot {
  flex: 0 0 auto; display: flex; gap: 2px; padding: 8px 10px;
  border-top: 1px solid var(--separator);
}
.lfbtn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 7px 10px; border: none; border-radius: var(--r-control); background: none;
  font-size: var(--fs-ui); font-weight: 500; color: var(--label-secondary); cursor: pointer;
}
.lfbtn:hover { background: var(--fill-quaternary); color: var(--label); }
.lfbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
</style>
