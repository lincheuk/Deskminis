<script setup lang="ts">
/** T 波：左导航。与旧 SessionList 的实质差别（设计稿 §3）——
 *  它是**分组导航**（会话/定时/助手三区 + 底部入口），不是一条会话列表加底部按钮。
 *  会话按自然日分组（lib/nav/group 纯模块），行高 34、圆角 8、选中用主色浅底。 */
import { computed, ref } from 'vue';
import { useChat } from '../stores/chat';
import { groupSessions } from '../lib/nav/group';
import { normalizeBinding, describeBinding } from '../lib/models/binding';
import UiIcon from './UiIcon.vue';

const chat = useChat();
const emit = defineEmits<{ (e: 'view', v: 'chat' | 'search' | 'cron' | 'assistants' | 'market' | 'settings' | 'devices'): void }>();
/** compact = 只剩图标的窄条。产出物预览打开时自动进入——舞台要让给产出物，
 *  会话列表这时不是必需品（参考图里有预览的几张，左侧都只剩一条图标栏）。 */
const props = defineProps<{ view: string; compact?: boolean }>();

const nowSec = ref(Math.floor(Date.now() / 1000));
setInterval(() => { nowSec.value = Math.floor(Date.now() / 1000); }, 60_000);

const groups = computed(() => groupSessions(chat.sessions, nowSec.value));
const emojiOf = (id: string): string => chat.assistants.find(a => a.id === id)?.avatar ?? '';
/** 会话前的彩色小图标：原图每条 conversation 都带一个彩色圆图标，
 *  一列纯文字很难扫。没有助手 emoji 时退化成纯色圆点，色相由会话 id 派生（稳定）。 */
function dotStyle(id: string): Record<string, string> {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return { background: `oklch(0.90 0.08 ${h})`, color: `oklch(0.45 0.15 ${h})` };
}

async function newChat(): Promise<void> {
  await chat.newSession();
  emit('view', 'chat');
}
function openSession(id: string): void {
  void chat.open(id);
  emit('view', 'chat');
}

// ---- Y1：会话行 ⋮ 菜单（MU6 / B1 / J2 立，T 波换壳丢；从旧 SessionList 逐项搬回）----
type S = (typeof chat.sessions)[number];
/** **行内展开，不浮层**：.list 是 overflow:auto，浮层会被裁掉——MU5 §15 为「弹层被容器裁掉」
 *  吃过一次「点了没反应」的亏，旧 SessionList 从一开始就绕开，这里照搬；顺带避开层级槽位的不变量。 */
const menuFor = ref('');
const confirmDelete = ref('');
const renameFor = ref('');
const renameText = ref('');
const renameErr = ref('');
/** W1b-4：删除运行中的会话，后端要先让它停下、等它收尾（最长约 10 秒），停不下来就报错不删。
 *  以前 onDelete await 完直接收菜单、不接异常：等待期间按钮毫无反应，失败是一次未处理拒绝——又是「点了没反应」。
 *  现在删除中这一行的两颗按钮禁用、删除钮改字；失败原因落在这一行的菜单里（与重命名同一种 .smenu-err），
 *  菜单不收，停下来之后可以再点一次。
 *  删除中与报错都按行记：后端 chat.sessions.delete 逐会话各自 stopRun，并发删不同会话没问题。
 *  审查逮到过全局闸的回归：A 删除中去 B 行点「删除」，按钮可点、却不发请求也不提示。
 *  报错也按行留着：A 删除中用户去开了 B 的菜单，A 的失败原因要等用户回 A 行看见，不能被换行开菜单清掉。 */
const deletingIds = ref(new Set<string>());
const deleteErrs = ref<Record<string, string>>({});
function closeRename(): void { renameFor.value = ''; renameText.value = ''; renameErr.value = ''; }
function toggleMenu(id: string): void {
  if (menuFor.value === id) delete deleteErrs.value[id]; // 自己收起这一行：报错看过了
  menuFor.value = menuFor.value === id ? '' : id;
  confirmDelete.value = ''; // 换行即清掉确认态，避免「在 A 行点了确认、切到 B 行还悬着」
  closeRename();
}
function cancelDelete(id: string): void {
  confirmDelete.value = '';
  delete deleteErrs.value[id];
}
async function onDelete(id: string): Promise<void> {
  if (deletingIds.value.has(id)) return; // 同一行等待期间连点不重复发；别的行照常删
  deletingIds.value.add(id);
  delete deleteErrs.value[id];
  try {
    await chat.deleteSession(id);
    // 等待期间用户可能已经去别的行开了菜单：只收自己这一行的，别把人家刚打开的关掉
    if (menuFor.value === id) { menuFor.value = ''; confirmDelete.value = ''; }
  } catch (e) {
    deleteErrs.value[id] = e instanceof Error ? e.message : String(e);
  } finally {
    deletingIds.value.delete(id);
  }
}
/** B1 重命名：预填现标题（改名多半是微调不是重写）。后端会拒空标题与超 50 字，
 *  错误必须落在菜单里——吞掉就成了「点了确认没反应」。 */
function startRename(s: S): void {
  renameFor.value = s.id;
  renameText.value = s.title || '';
  renameErr.value = '';
}
async function submitRename(id: string): Promise<void> {
  try {
    await chat.renameSession(id, renameText.value);
    closeRename();
    menuFor.value = '';
  } catch (e) { renameErr.value = e instanceof Error ? e.message : String(e); }
}
/** 绑定值回显归一化：旧库存量是裸 provider id（J2 之前），select 选项是带前缀的值——
 *  不补前缀，旧绑定行会错显成「跟随全局默认」（后端兼容分支同一语义）。
 *  Z2 起归一化收进纯模块 lib/models/binding（此前这里与 StageAssistants 各写一份）。 */
function bindingValue(s: S): string {
  return normalizeBinding(s.modelBinding);
}
/** 绑定指向的模型 / 模型组已被删除时，下拉里没有它的选项——补一个禁用项如实显示，而不是显示成空白。 */
function bindingView(s: S) { return describeBinding(s.modelBinding, chat.providers, chat.modelGroups, chat.defaultProviderId); }
</script>

<template>
  <nav class="rail" :class="{ compact: props.compact }">
    <div class="brand">
      <span class="mark"><UiIcon name="chat" :size="15" /></span>
      <span v-if="!props.compact" class="bname">DeskMinis</span>
    </div>

    <button class="newbtn" type="button" :title="props.compact ? '新建会话' : ''" @click="newChat">
      <UiIcon name="plus" :size="16" /><span v-if="!props.compact">新建会话</span>
    </button>

    <div class="nav">
      <button class="navit" type="button" :class="{ on: props.view === 'search' }" @click="emit('view', 'search')">
        <UiIcon name="search" :size="16" /><span v-if="!props.compact">搜索会话</span>
      </button>
      <button class="navit" type="button" :class="{ on: props.view === 'cron' }" @click="emit('view', 'cron')">
        <UiIcon name="clock" :size="16" /><span v-if="!props.compact">定时任务</span>
        <span v-if="!props.compact && chat.cronJobs.length" class="cnt tnum">{{ chat.cronJobs.length }}</span>
      </button>
      <button class="navit" type="button" :class="{ on: props.view === 'assistants' }" @click="emit('view', 'assistants')">
        <UiIcon name="robot" :size="16" /><span v-if="!props.compact">助手</span>
        <span v-if="!props.compact && chat.assistants.length" class="cnt tnum">{{ chat.assistants.length }}</span>
      </button>
      <button class="navit" type="button" :class="{ on: props.view === 'market' }" @click="emit('view', 'market')">
        <UiIcon name="puzzle" :size="16" /><span v-if="!props.compact">扩展市场</span>
      </button>
    </div>

    <div v-if="!props.compact" class="list">
      <div class="seghead">会话</div>
      <div v-if="!chat.sessions.length" class="empty">还没有会话<br />点上面「新建会话」开始</div>
      <template v-for="g in groups" :key="g.label">
        <div class="ghead">{{ g.label }}</div>
        <!-- v-for 挂在 template 上：会话行与它的行内菜单是**两个兄弟节点**。旧 SessionList 曾把 v-for
             挂在行上，菜单里的 s 变成 undefined，整个列表渲染挂掉——源码守卫与 typecheck 都抓不到，真跑才暴露。 -->
        <template v-for="s in g.items" :key="s.id">
          <div class="srw" :class="{ on: s.id === chat.activeId && props.view === 'chat', open: menuFor === s.id }">
            <button type="button" class="srow" @click="openSession(s.id)">
              <span class="semo" :style="dotStyle(s.id)">{{ emojiOf(String(s.assistantId ?? '')) || '' }}</span>
              <span class="stitle">{{ s.title || '新会话' }}</span>
            </button>
            <button type="button" class="smore" :title="`${s.title || '新会话'} 的更多操作`" :aria-expanded="menuFor === s.id" @click.stop="toggleMenu(s.id)">⋮</button>
          </div>
          <div v-if="menuFor === s.id" class="smenu">
            <button class="mi" type="button" @click="chat.setSessionMemory(s.id, s.memoryEnabled === false)">
              记忆<span class="mv">{{ s.memoryEnabled === false ? '已关闭' : '已开启' }}</span>
            </button>
            <label class="mi msel">
              <span>模型</span>
              <select
                class="f-select mselect" :value="bindingValue(s)"
                @change="chat.setSessionModelBinding(s.id, ($event.target as HTMLSelectElement).value || undefined)"
              >
                <option value="">跟随全局默认</option>
                <!-- 菜单里的下拉只有百来像素宽：用最短的说法，长了会把「组」字截掉，读成删的是模型（实拍逮到） -->
                <option v-if="bindingView(s).missing" :value="bindingValue(s)" disabled>{{ bindingView(s).kind === 'group' ? '组已删除' : '模型已删除' }}</option>
                <!-- 值带 provider: 前缀：chat.prompt 只认前缀，裸 id 只会落进 J2 留的兼容分支（能跑，但格式分叉） -->
                <option v-for="p in chat.providers" :key="p.id" :value="'provider:' + p.id">{{ p.name }}</option>
                <!-- Z5：模型组——排第一的出错时按序换下一个（设置 → 模型 → 模型组） -->
                <optgroup v-if="chat.modelGroups.length" label="模型组">
                  <option v-for="g in chat.modelGroups" :key="g.id" :value="'group:' + g.id">{{ g.name }}</option>
                </optgroup>
              </select>
            </label>
            <button v-if="renameFor !== s.id" class="mi" type="button" @click.stop="startRename(s)">重命名</button>
            <template v-else>
              <div class="mrow">
                <input
                  class="f-input minput" type="text" placeholder="会话标题" :value="renameText"
                  @input="renameText = ($event.target as HTMLInputElement).value"
                  @keydown.enter="submitRename(s.id)"
                />
                <button class="mi mok" type="button" @click.stop="submitRename(s.id)">确认</button>
              </div>
              <div v-if="renameErr" class="smenu-err">{{ renameErr }}</div>
            </template>
            <button v-if="confirmDelete !== s.id" class="mi danger" type="button" @click.stop="confirmDelete = s.id">删除会话</button>
            <template v-else>
              <div class="mask t-aux">确认删除？此操作不可撤销。</div>
              <div class="mrow">
                <button class="mi" type="button" :disabled="deletingIds.has(s.id)" @click.stop="cancelDelete(s.id)">取消</button>
                <button class="mi danger" type="button" :disabled="deletingIds.has(s.id)" @click.stop="onDelete(s.id)">{{ deletingIds.has(s.id) ? '删除中…' : '删除' }}</button>
              </div>
              <!-- 运行中的会话要先停下才删，最长要等约 10 秒：给句交代，不然像卡死 -->
              <div v-if="deletingIds.has(s.id)" class="mask t-aux">正在停止这个会话的任务…</div>
            </template>
            <!-- 放在确认态外面：删除中去别的行开过菜单再回来，确认态已被 toggleMenu 复位，失败原因也要看得见 -->
            <div v-if="deleteErrs[s.id]" class="smenu-err">{{ deleteErrs[s.id] }}</div>
          </div>
        </template>
      </template>
    </div>

    <div class="foot">
      <button class="navit" type="button" :class="{ on: props.view === 'settings' }" @click="emit('view', 'settings')">
        <UiIcon name="gear" :size="16" /><span v-if="!props.compact">设置</span>
      </button>
      <button class="navit" type="button" :class="{ on: props.view === 'devices' }" @click="emit('view', 'devices')">
        <UiIcon name="device" :size="16" /><span v-if="!props.compact">设备</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  width: var(--w-rail); flex: 0 0 var(--w-rail);
  transition: width .16s ease, flex-basis .16s ease;
  display: flex; flex-direction: column; min-height: 0;
  /* 原图侧栏是**纯白**，只靠右侧一条线与舞台分开；我原先做成灰底，白卡浮不出来 */
  background: var(--c-bg);
  border-right: 1px solid var(--c-line);
}

.brand { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-5) var(--sp-5) var(--sp-3); }
.mark {
  width: 26px; height: 26px; border-radius: var(--r-s); flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  /* 品牌标记走 AOU 紫，交互蓝留给按钮/选中——两者分工，界面才有主次 */
  background: var(--c-aou); color: var(--c-brand-ink);
}
.bname { font-size: var(--t-h2-size); line-height: var(--t-h2-lh); font-weight: var(--w-bd); color: var(--c-ink); }

.newbtn {
  margin: 0 var(--sp-5) var(--sp-5); height: var(--h-field); flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
  border-radius: var(--r-s); cursor: pointer;
  /* 原图是浅蓝底 + 深蓝字的**轻**按钮，不是实底大色块——实底在白侧栏里太抢 */
  background: var(--c-brand-soft); color: var(--c-brand);
  font-size: var(--t-body-size); font-weight: var(--w-md); font-family: inherit;
}
.newbtn:hover { background: var(--c-brand-line); }

.nav { padding: 0 var(--sp-3) var(--sp-3); display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
.navit {
  display: flex; align-items: center; gap: var(--sp-3); width: 100%;
  height: var(--h-row); padding: 0 var(--sp-4); border-radius: var(--r-s);
  background: none; color: var(--c-ink-2); cursor: pointer; text-align: left;
  font-size: var(--t-item-size); font-family: inherit;
}
.navit:hover { background: var(--c-bg-2); color: var(--c-ink); }
.navit.on { background: var(--c-brand-soft); color: var(--c-ink); font-weight: var(--w-md); }
.navit > span:first-of-type { flex: 1; min-width: 0; }
.cnt { flex: 0 0 auto; font-size: var(--t-aux-size); color: var(--c-ink-3); }

.list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--sp-3) var(--sp-3); }
.empty {
  font-size: var(--t-aux-size); line-height: 1.7; color: var(--c-ink-3);
  text-align: center; padding: var(--sp-7) var(--sp-4);
}
.ghead {
  font-size: var(--t-aux-size); line-height: var(--t-aux-lh); color: var(--c-ink-4);
  padding: var(--sp-4) var(--sp-4) var(--sp-1);
}
/* 段头（原图 Teams/Projects/Conversations 那一级）：比日期分组更高一层 */
.seghead {
  font-size: var(--t-aux-size); line-height: var(--t-aux-lh); color: var(--c-ink-3);
  font-weight: var(--w-md); padding: var(--sp-5) var(--sp-4) var(--sp-1);
}
.rail.compact .seghead { display: none; }
/* 会话行 = 行按钮 + 行尾 ⋮ 两个并列按钮（按钮里不能再嵌按钮）；hover/选中/菜单开着的底色画在包裹层 */
.srw { display: flex; align-items: center; border-radius: var(--r-s); }
.srw:hover, .srw.open { background: var(--c-bg-2); }
.srw.on { background: var(--c-brand-soft); }
.srow {
  display: flex; align-items: center; gap: var(--sp-2); flex: 1; min-width: 0;
  height: var(--h-row); padding: 0 var(--sp-4); border-radius: var(--r-s);
  background: none; color: var(--c-ink-2); cursor: pointer; text-align: left;
  font-size: var(--t-item-size); font-family: inherit;
}
.srw:hover .srow, .srw.on .srow, .srw.open .srow { color: var(--c-ink); }
.srw.on .srow { font-weight: var(--w-md); }
/* 行尾 ⋮：平时淡出，hover / 键盘聚焦 / 菜单开着时显形——不抢会话标题的视觉 */
.smore {
  flex: 0 0 auto; width: var(--h-ctl); height: var(--h-ctl); margin-right: var(--sp-1);
  border-radius: var(--r-s); background: none; color: var(--c-ink-3); cursor: pointer; padding: 0;
  font-size: var(--t-item-size); line-height: 1; opacity: 0;
}
.srw:hover .smore, .srw:focus-within .smore, .srw.open .smore { opacity: 1; }
.smore:hover { background: var(--c-bg-3); color: var(--c-ink); }
/* 行内菜单：不浮层（.list 的 overflow:auto 会裁掉浮层） */
.smenu {
  margin: 2px 0 var(--sp-2) var(--sp-7); padding: var(--sp-2);
  display: flex; flex-direction: column; gap: 2px;
  background: var(--c-bg-1); border: 1px solid var(--c-line); border-radius: var(--r-s);
}
.mi {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  height: var(--h-ctl); padding: 0 var(--sp-3); border-radius: var(--r-s);
  background: none; color: var(--c-ink-2); cursor: pointer; text-align: left;
  font-size: var(--t-aux-size); font-family: inherit;
}
.mi:hover { background: var(--c-bg-2); color: var(--c-ink); }
.mi.danger { color: var(--c-err); }
.mi.danger:hover { background: var(--c-err-soft); }
/* 删除中：两颗按钮都禁用，要看得出点不动（与 theme.css 的 .f-btn:disabled 同一档透明度） */
.mi:disabled { opacity: .45; cursor: default; }
.mi:disabled:hover, .mi.danger:disabled:hover { background: none; }
.mv { margin-left: auto; color: var(--c-ink-3); }
.msel { cursor: default; }
.msel:hover { background: none; }
/* 右内边距只留箭头的位置：菜单只有 ~100px 给它，「跟随全局默认」六个字再多留就被裁 */
.mselect { flex: 1; min-width: 0; height: var(--h-mini); padding: 0 var(--sp-5) 0 var(--sp-2); font-size: var(--t-aux-size); }
.mrow { display: flex; gap: var(--sp-1); align-items: center; }
.mrow .mi { flex: 1; justify-content: center; }
.mrow .mok { flex: 0 0 auto; }
.minput { flex: 1; min-width: 0; height: var(--h-mini); padding: 0 var(--sp-2); font-size: var(--t-aux-size); }
.mask { padding: var(--sp-1) var(--sp-3); color: var(--c-ink-2); }
.smenu-err { padding: var(--sp-1) var(--sp-3); font-size: var(--t-aux-size); color: var(--c-err); }
.semo {
  flex: 0 0 auto; width: 20px; height: 20px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; line-height: 1;
}
.stitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.foot {
  flex: 0 0 auto; padding: var(--sp-3); display: flex; flex-direction: column; gap: 2px;
  border-top: 1px solid var(--c-line);
}

/* ---- compact：只剩一条图标栏 ---- */
.rail.compact { width: var(--w-rail-mini); flex: 0 0 var(--w-rail-mini); }
.rail.compact .brand { justify-content: center; padding: var(--sp-5) 0 var(--sp-3); }
.rail.compact .newbtn { margin: 0 auto var(--sp-5); width: var(--h-round); padding: 0; }
.rail.compact .nav,
.rail.compact .foot { padding-left: 0; padding-right: 0; align-items: center; }
.rail.compact .navit { width: var(--h-round); padding: 0; justify-content: center; }
/* compact 下 .list 不渲染，但留一段弹性把底部入口压到底 */
.rail.compact .nav { flex: 1; justify-content: flex-start; }
</style>
