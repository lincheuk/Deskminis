<script setup lang="ts">
/** 中栏 · 对话流（设计 v2 §2.1）——回合结构：用户消息无气泡标签行（你 · HH:MM + hover 复制），
 *  助手回合容器（分隔线 + 间距），工具胶囊、内联权限卡、浮动输入区。
 *  渲染对 parts 全程空值兜底：parts.ts 允许 value:null 的 part，绝不解引用崩溃。 */
import { ref, computed, nextTick, watch, onBeforeUnmount } from 'vue';
import { useChat } from '../stores/chat';
import { matchQuote, resolveOffsets, absoluteOffset, type WalkNode } from '../lib/annotations/anchor';
import { isBlankState } from '../lib/welcome/blank';
import ToolLine from './ToolLine.vue';
import PermissionCard from './PermissionCard.vue';
import EmptyState from './EmptyState.vue';
import ModelPicker from './ModelPicker.vue';
import PermissionPicker from './PermissionPicker.vue';
import Icon from './Icon.vue';
import EventNote from './EventNote.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import MarkdownView from './MarkdownView.vue';
import FadeText from './FadeText.vue';
import { MarkdownCache } from '../lib/markdown/cache';
import { stablePrefixEnd } from '../lib/markdown/prefix';
import { shouldFollow } from '../lib/scroll/follow';
import { fmtHHMM } from '../lib/time/hhmm';
import { groupToolCards, isGroup, type ToolGroup } from '../lib/toolline/group';
import { eventCopy } from '../lib/eventnote/copy';
import { rowsFor } from '../lib/composer/autogrow';
import { histStep } from '../lib/composer/history';
import { downsampleImageFile } from '../lib/attach/downsample';
import type { MdNode } from '../lib/markdown/parse';

const chat = useChat();
const input = ref('');

// ---- 工作区（用户 2026-08-11：「这个点不开，无法使用」）----
const wsOpen = ref(false);
const wsPath = ref('');
const wsErr = ref('');
const wsBusy = ref(false);
/** chip 上只显示目录名，全路径挂 title——336px 的输入卡塞不下绝对路径。 */
const workspaceLabel = computed(() => {
  const r = chat.workspaceRoot;
  if (!r) return '工作区';
  if (chat.workspaceIsDefault) return '工作区';
  return r.split(/[\\/]/).filter(Boolean).pop() || '工作区';
});
/** 工作区是**每会话**的：没有活动会话时 setWorkspace 会带着空 sessionId 发出去，
 *  后端 UPDATE 匹配不到任何行——**静默什么也不发生**（用户 2026-08-11 实测撞到的正是这个）。
 *  故先建会话再设；按钮文案已写明「新建会话并…」，不做无声的副作用。 */
async function ensureSession(): Promise<void> {
  if (!chat.activeId) await chat.newSession();
}
async function applyWs(): Promise<void> {
  const v = wsPath.value.trim();
  if (!v) return;
  wsErr.value = ''; wsBusy.value = true;
  try { await ensureSession(); await chat.setWorkspace(v); wsPath.value = ''; wsOpen.value = false; }
  catch (e) { wsErr.value = e instanceof Error ? e.message : String(e); }
  finally { wsBusy.value = false; }
}
async function pickWs(): Promise<void> {
  wsErr.value = ''; wsBusy.value = true;
  try {
    const picked = await chat.pickWorkspaceFolder();
    if (picked === null) return;   // 用户取消——不是空串，不能当「清空」处理
    await ensureSession();
    await chat.setWorkspace(picked);
    wsOpen.value = false;
  } catch (e) { wsErr.value = e instanceof Error ? e.message : String(e); }
  finally { wsBusy.value = false; }
}
async function resetWs(): Promise<void> {
  wsErr.value = '';
  try { await chat.resetWorkspace(); } catch (e) { wsErr.value = e instanceof Error ? e.message : String(e); }
}

// ---- L5 会话级 MCP 勾选（pool-batch §5：D5 后端全通，这里是唯一 renderer 入口）----
const mcpOpen = ref(false);
// 组件创建即拉取一次：pill 显隐取决于「存在已启用 server」，不拉则 mcpServers 恒为空、入口永不出现。
// 设置页的增删改走同一 store（写后重拉），两处天然同步，无需订阅。
void chat.fetchMcpServers();
const enabledMcpServers = computed(() => chat.mcpServers.servers.filter(s => s.enabled));
const mcpPillVisible = computed(() => !!chat.activeId && enabledMcpServers.value.length > 0);
const sessionMcpDisabled = computed(() => chat.sessions.find(s => s.id === chat.activeId)?.mcpDisabled ?? []);
// 计数只数「已启用 ∩ 已禁用」：名单里可能残留已全局删除/停用的 server 名，光标数会对不上可见行
const mcpDisabledCount = computed(() => enabledMcpServers.value.filter(s => sessionMcpDisabled.value.includes(s.name)).length);
const mcpLabel = computed(() => mcpDisabledCount.value > 0 ? `MCP · 禁 ${mcpDisabledCount.value}` : 'MCP');
// 两个行内面板互斥展开：同时开会把 composer 顶出可视区（wspanel 挤压事故的教训，窄列 336px）
function toggleWs(): void {
  mcpOpen.value = false;
  wsOpen.value = !wsOpen.value;
}
function toggleMcp(): void {
  wsOpen.value = false;
  mcpOpen.value = !mcpOpen.value;
}
/** 翻转单个 server 的会话禁用位（AssistantSettings 技能勾选同一成例：按当前态翻转，不读事件）。
 *  整表覆写是后端 setMcpDisabled 的语义；顺带把残留的幽灵名单项一并保留原样（不越权清理）。 */
async function toggleSessionMcp(name: string): Promise<void> {
  const cur = sessionMcpDisabled.value;
  const next = cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name];
  await chat.setSessionMcpDisabled(chat.activeId, next);
}
const streamEl = ref<HTMLElement | null>(null);
const fieldEl = ref<HTMLTextAreaElement | null>(null);

// MU2b Task 6：空状态示例卡点击 → 填入输入框并聚焦
function fillInput(t: string): void {
  input.value = t;
  void nextTick(() => fieldEl.value?.focus());
}

function isRec(v: unknown): v is Record<string, any> { return typeof v === 'object' && v !== null; }

// 会话内所有 toolResult 汇成 toolUseId → 结果的表（工具结果落在紧随的合成 user 消息里）
const resultMap = computed(() => {
  const m = new Map<string, { output: string; success: boolean; status: string }>();
  for (const msg of chat.messages) {
    if (!Array.isArray(msg.parts)) continue;
    for (const p of msg.parts) {
      if (p && p.type === 'toolResult' && isRec(p.value) && typeof p.value.toolUseId === 'string') {
        m.set(p.value.toolUseId, { output: String(p.value.output ?? ''), success: !!p.value.success, status: String(p.value.status ?? '') });
      }
    }
  }
  return m;
});
function resultOf(id: unknown) { return typeof id === 'string' ? resultMap.value.get(id) : undefined; }

// 用户可见文本（合成的工具结果 user 消息不含文本 → 不渲染成气泡）
function userText(m: { parts?: any[] }): string {
  return (Array.isArray(m.parts) ? m.parts : [])
    .filter(p => p && p.type === 'text' && typeof p.value === 'string')
    .map(p => p.value).join('\n');
}
// 历史消息里的附件（mediaRef part）：渲染 chip 只取文件名等元数据，
// 不加载图片字节——历史缩略图需要 IPC 读图，属后续任务，本步不做
function userAttachments(m: { parts?: any[] }): { relativePath: string; originalFileName?: string }[] {
  return (Array.isArray(m.parts) ? m.parts : [])
    .filter(p => p && p.type === 'mediaRef' && isRec(p.value) && typeof p.value.relativePath === 'string')
    .map(p => p.value as { relativePath: string; originalFileName?: string });
}
// chip 文案：优先用户原始文件名，否则从会话相对路径取末段
function attLabel(a: { relativePath: string; originalFileName?: string }): string {
  return a.originalFileName || a.relativePath.split('/').pop() || a.relativePath;
}
function isResultCarrier(m: { role: string; parts?: any[] }): boolean {
  const parts = Array.isArray(m.parts) ? m.parts : [];
  const hasText = parts.some(p => p && p.type === 'text' && typeof p.value === 'string' && p.value.trim() !== '');
  return !hasText && parts.some(p => p && p.type === 'toolResult');
}
// 工具行标题：优先 input 里的 tool_title，回落 description / name
function toolTitle(v: unknown): string {
  if (!isRec(v)) return '工具';
  if (typeof v.input === 'string') {
    try { const o = JSON.parse(v.input); if (o && typeof o.tool_title === 'string' && o.tool_title) return o.tool_title; } catch { /* ignore */ }
  }
  if (typeof v.description === 'string' && v.description) return v.description;
  return typeof v.name === 'string' ? v.name : '工具';
}

// ---- 同型工具成组（MU2a Task 6，设计 §2.2）：实时卡连续 ≥3 同 name 折叠为一行 ----
type LiveCard = (typeof chat.toolCards)[number];
const liveItems = computed(() => groupToolCards(chat.toolCards));
function liveState(c: LiveCard): 'running' | 'ok' | 'fail' {
  return c.success === undefined ? 'running' : c.success ? 'ok' : 'fail';
}
function gkey(g: ToolGroup<LiveCard>): string { return `${g.name}:${g.items[0].toolUseId}`; }
function groupState(g: ToolGroup<LiveCard>): 'running' | 'ok' | 'fail' {
  if (g.items.some(c => c.success === undefined)) return 'running';
  return g.items.every(c => c.success) ? 'ok' : 'fail';
}
// 组标题人话化（「读取 4 个文件」）；未映射 name 回落「name × N」
const GROUP_PHRASE: Record<string, (n: number) => string> = {
  file_read: n => `读取 ${n} 个文件`,
  file_write: n => `写入 ${n} 个文件`,
  file_edit: n => `编辑 ${n} 个文件`,
  shell_execute: n => `执行 ${n} 条命令`,
  memory: n => `${n} 次记忆操作`,
};
function groupTitle(name: string, n: number): string { return GROUP_PHRASE[name]?.(n) ?? `${name} × ${n}`; }

const hasLive = computed(() =>
  chat.running || !!chat.streamingText || chat.toolCards.length > 0 || chat.pendingPerms.length > 0 || !!chat.retryNote,
);
/** I3：空态判据抽到 lib/welcome/blank 与 App.vue（欢迎态收工作台）共用——双写必漂移 */
const isEmpty = computed(() => isBlankState(chat));
/** I6：占位符随助手走——绑定会话 > 欢迎屏选择态 > 默认（AionUi「Aion CLI, Send a message…」位） */
const composerPlaceholder = computed(() => {
  const boundId = chat.sessions.find(s => s.id === chat.activeId)?.assistantId;
  const a = chat.assistants.find(x => x.id === (boundId || chat.welcomeAssistantId));
  return a ? `让 ${a.name} 做点什么…` : '让 DeskMinis 做点什么…';
});

// ---- 回合结构（MU2a Task 5，设计 v2 §2.1）----
// 一回合 = 用户消息 + 其后助手工作区。仅承载工具结果的合成 user 消息不产生新回合。
type UiMsg = (typeof chat.messages)[number];
interface Turn { id: string; user: { msg: UiMsg; text: string } | null; assistants: UiMsg[] }
const turns = computed<Turn[]>(() => {
  const out: Turn[] = [];
  for (const m of chat.messages) {
    if (m.role === 'user') {
      if (isResultCarrier(m)) continue; // 结果载体回合内隐没（结果挂到对应 toolUse 下渲染）
      out.push({ id: m.id, user: { msg: m, text: userText(m) }, assistants: [] });
    } else if (m.role === 'assistant') {
      if (out.length === 0) out.push({ id: m.id, user: null, assistants: [] });
      out[out.length - 1].assistants.push(m);
    }
  }
  return out;
});
// 用户消息时间（乐观消息也有 createdAt；历史缺失兜底空串）
function userTime(m: UiMsg): string { return typeof m.createdAt === 'number' ? fmtHHMM(m.createdAt) : ''; }
// hover 复制：用户正文纯文本进剪贴板
function copyUser(text: string): void { void navigator.clipboard.writeText(text); }

// M3c Task 7：回合区消息设备标（决策 7c）——originDeviceId 映射色 + 6 字短名（数据源 M3b 已有）
function deviceHue(fp: string): number {
  let h = 0;
  for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) % 360;
  return h;
}
function deviceColor(fp: string | undefined): string {
  return fp ? `hsl(${deviceHue(fp)}, 65%, 50%)` : 'var(--label-tertiary)';
}
function deviceShortName(fp: string | undefined): string {
  return fp ? fp.slice(0, 6) : '';
}

// ---- Markdown 渲染（MU2a Task 2）：每消息一 MarkdownCache 实例（决策 3 稳定前缀缓存）----
// 静态历史文本零重解析（cache 对同文本幂等）；会话切换清空，防内存滞留。
const mdCaches = new Map<string, MarkdownCache>();
function cacheFor(key: string): MarkdownCache {
  let c = mdCaches.get(key);
  if (!c) { c = new MarkdownCache(); mdCaches.set(key, c); }
  return c;
}
watch(() => chat.activeId, () => { mdCaches.clear(); });
function merged(r: { stableNodes: MdNode[]; tailNodes: MdNode[] }): MdNode[] {
  return r.tailNodes.length ? r.stableNodes.concat(r.tailNodes) : r.stableNodes;
}
// 历史助手正文 → AST（deps 仅 chat.messages：输入框键入等无关重渲染不重算）
const mdByMsg = computed(() => {
  const out = new Map<string, MdNode[]>();
  for (const m of chat.messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.parts)) continue;
    m.parts.forEach((p: any, i: number) => {
      if (p && p.type === 'text' && typeof p.value === 'string' && p.value) {
        out.set(`${m.id}:${i}`, merged(cacheFor(`${m.id}:${i}`).update(p.value)));
      }
    });
  }
  return out;
});
function mdOf(key: string): MdNode[] { return mdByMsg.value.get(key) ?? []; }
// 流式区（MU2a Task 3 决策 3）：稳定区 Markdown 直接呈现（块级结构淡入会闪）；
// 尾部（未闭合块/围栏）纯文本兜底 + 词粒度淡入，闭合后整块翻正进稳定区。
const streamStable = computed<MdNode[]>(() =>
  chat.streamingText ? cacheFor('__stream__').update(chat.streamingText).stableNodes : [],
);
const streamTailText = computed(() =>
  chat.streamingText ? chat.streamingText.slice(stablePrefixEnd(chat.streamingText)) : '',
);
/** MU2a Task 8：eventNotes → EventNote 视图模型（文案/图标/语调走 lib/eventnote/copy 纯模块）。
 *  五类统一：retry/fallback/compacted/offloaded/error。 */
const noteViews = computed(() => chat.eventNotes.map(n => ({ note: n, copy: eventCopy(n.kind, n.detail) })));
// 错误「重试」前提：会话里存在可重发的真实用户消息（无 → 按钮不出现，retryLast 空转兜底）
const canRetry = computed(() => chat.messages.some(m => m.role === 'user' && userText(m).trim() !== ''));

// ---- MU2b Task 6：图片粘贴/拖拽附件（main 落盘会话附件目录 → 48px chip → 发送附件参数）----
interface PendingAttachment { path: string; dataUrl: string }
const pendingAttachments = ref<PendingAttachment[]>([]);

// 发送键放行条件：「有文本或有附件」——纯图片消息（空文本+附件）也是合法输入
const canSend = computed(() => (input.value.trim().length > 0 || pendingAttachments.value.length > 0) && !chat.running);

function pickImages(list: FileList | null): File[] {
  return Array.from(list ?? []).filter(f => f.type.startsWith('image/'));
}
async function saveImages(files: File[]): Promise<void> {
  if (!files.length) return;
  if (!chat.activeId) await chat.newSession(); // 附件挂在会话目录下：先确保有会话
  const id = chat.activeId;
  const bridge = (window as { deskminis?: { saveAttachment?: (s: string, d: string) => Promise<string> } }).deskminis;
  if (!id || !bridge?.saveAttachment) return;
  for (const f of files) {
    // F2a：入库降采样——超 1568px 长边的先缩再传（gif/边界内原字节直传，见 lib/attach/downsample）
    const dataUrl = await downsampleImageFile(f);
    const path = await bridge.saveAttachment(id, dataUrl); // 返回会话相对路径 attachments/paste-<ts>.<ext>
    pendingAttachments.value.push({ path, dataUrl });
  }
}
function onPaste(e: ClipboardEvent): void {
  const files = pickImages(e.clipboardData?.files ?? null);
  if (!files.length) return; // 无图片：走默认文本粘贴
  e.preventDefault();
  void saveImages(files);
}
function onDrop(e: DragEvent): void {
  const files = pickImages(e.dataTransfer?.files ?? null);
  if (!files.length) return;
  e.preventDefault();
  void saveImages(files);
}
function removeAttachment(i: number): void { pendingAttachments.value.splice(i, 1); }

/** MU5：输入卡底部的 ＋ 钮。此前加附件只能粘贴或拖拽——能力有、入口无，
 *  正是本轮「后端做了但前端没体现」的一个缩影。复用既有 pickImages/saveImages，零新通道。 */
const attachEl = ref<HTMLInputElement | null>(null);
function openAttach(): void { attachEl.value?.click(); }
function onAttachPick(e: Event): void {
  const el = e.target as HTMLInputElement;
  void saveImages(pickImages(el.files));
  el.value = ''; // 清空以允许连续选同一个文件
}

async function send(): Promise<void> {
  const t = input.value.trim();
  const atts = pendingAttachments.value.map(a => a.path);
  if ((!t && !atts.length) || chat.running) return;
  // 没有选中会话就先建一个再发（避免「按了没反应」）。
  // I6：欢迎屏选了助手（AionUi「选中再输入」流）→ 按选择建绑定会话，预设三件随之应用
  if (!chat.activeId) {
    if (chat.welcomeAssistantId) await chat.newSessionWithAssistant(chat.welcomeAssistantId);
    else await chat.newSession();
  }
  input.value = '';
  histCursor.value = -1; // L1：发送即离开历史态（下次 ↑ 从最新一条重新进）
  // 附件以 attachments 参数进模型（后端落 mediaRef part + 请求侧合成 base64），发送后清空
  pendingAttachments.value = [];
  await chat.send(t, atts.length ? atts : undefined);
}

// ---- 滚动跟随治理（MU2a Task 3，治审计 X-2）：用户上翻 >40px 解除跟随，回到底部恢复 ----
const following = ref(true);
function onScroll(): void {
  const el = streamEl.value;
  if (!el) return;
  following.value = shouldFollow(el.scrollTop, el.scrollHeight, el.clientHeight, following.value);
}
// 新内容到达时贴底滚动（仅在跟随态；解除后不抢回）。
// streamingThinking 必须在依赖里：推理模型先想后答，纯思考阶段没有 textDelta，
// 少了它思考块会静默长高、滚动条不跟——「窗口感」直接破产。
watch(
  () => [chat.messages.length, chat.streamingText, chat.streamingThinking, chat.toolCards.length, chat.retryNote, chat.pendingPerms.length, chat.eventNotes.length] as const,
  () => {
    if (!following.value) return;
    void nextTick(() => { const el = streamEl.value; if (el) el.scrollTop = el.scrollHeight; });
  },
);
function backToBottom(): void {
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
  following.value = true;
}

// MU2b Task 2：进度面板「去处理」→ chat.permFocusRequestId 写入目标权限卡 requestId，
// 此处 watch 后滚动定位（PermissionCard 根元素带 data-req），定位完清空等待下一次。
watch(() => chat.permFocusRequestId, (rid) => {
  if (!rid) return;
  void nextTick(() => {
    document.querySelector(`.perm[data-req="${rid}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    chat.permFocusRequestId = null;
  });
});

// ---- /名字 斜杠菜单（设计 §5.1：纯输入辅助 —— 只把 /name 填进输入框，加载仍走模型侧 file_read）----
const slashOpen = ref(false);
const slashIndex = ref(0);
// 仅首 token 激活：整行形如 /片段（尚无空白）；补全后带空格 → query 变 null → 菜单自闭
const slashQuery = computed(() => (/^\/(\S*)$/.exec(input.value)?.[1] ?? null));
const slashItems = computed(() => {
  const q = slashQuery.value;
  if (q === null) return [];
  const needle = q.toLowerCase();
  const hits = needle === '' ? chat.skills : chat.skills.filter(s =>
    s.name.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle));
  return hits.slice(0, 8);
});
watch(slashItems, items => { slashOpen.value = items.length > 0; slashIndex.value = 0; });

function slashPick(name: string): void {
  input.value = `/${name} `; // 尾部空格：关闭菜单并让模型拿到完整技能名
  slashOpen.value = false;
}
function onEnterKey(): void {
  const s = slashOpen.value ? slashItems.value[slashIndex.value] : undefined;
  if (s) { slashPick(s.name); return; } // 菜单开着时 Enter = 选中，不是发送
  void send();
}
// ---- L1 输入历史上翻（设计稿 pool-batch §1）：↑↓ 的第二职责，斜杠菜单开着时让位 ----
// 数据源含乐观 local- 消息——刚发出去的那条最该能一键召回
const histCursor = ref(-1);
const userTexts = computed<string[]>(() => chat.messages
  .filter(m => m.role === 'user')
  .map(m => {
    const p = Array.isArray(m.parts) ? m.parts.find((x: { type?: string }) => x?.type === 'text') : undefined;
    return typeof p?.value === 'string' ? p.value : '';
  })
  .filter(t => t !== ''));
watch(() => chat.activeId, () => { histCursor.value = -1; });

function onSlashNav(delta: number, e: KeyboardEvent): void {
  if (!slashOpen.value) {
    // 历史态判定在纯模块里：不应用（有草稿/越界/编辑过）就返回 null，按键回归光标本职
    const r = histStep(userTexts.value, input.value, histCursor.value, delta as -1 | 1);
    if (r) { e.preventDefault(); input.value = r.text; histCursor.value = r.cursor; }
    return;
  }
  e.preventDefault();
  slashIndex.value = (slashIndex.value + delta + slashItems.value.length) % slashItems.value.length;
}
function onSlashTab(e: KeyboardEvent): void {
  if (!slashOpen.value) return;
  e.preventDefault();
  const s = slashItems.value[slashIndex.value];
  if (s) slashPick(s.name);
}

// ---- H2 文本选区注释（设计稿 §2）：选区浮条（引用/标注）+ 高亮重锚定渲染 ----
const paneEl = ref<HTMLElement | null>(null);
const annoBar = ref<{ x: number; y: number } | null>(null);
// 待定选区：exact/prefix/suffix 取自容器 textContent（与重锚定同一文本域）；
// quoteText 单独取 selection.toString()——它带可读换行，引用块要的是这份
let pendingSel: { messageId: string; exact: string; prefix: string; suffix: string; quoteText: string } | null = null;

function hideAnnoBar(): void { annoBar.value = null; pendingSel = null; }

function annoRootOf(n: Node | null): HTMLElement | null {
  let el: HTMLElement | null = n instanceof HTMLElement ? n : (n?.parentElement ?? null);
  for (; el; el = el.parentElement) {
    if (el.hasAttribute('data-anno-root')) return el;
    if (el === streamEl.value) return null;
  }
  return null;
}

function onStreamMouseUp(ev: MouseEvent): void {
  // mouseup 一刻选区可能尚未定稿（双击/三击选词选段）：推一帧再读才是最终选区。
  // 点击命中高亮也走本手势面（不另挂 <div @click>——键盘可达守卫口径，一个手势面也更干净）
  requestAnimationFrame(() => {
    const wasPop = annoPop.value !== null;
    if (wasPop) closeAnnoPop(); // 流内任意 mouseup 先关已开气泡（气泡自身在 .stream 外，不受此路径影响）
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hideAnnoBar();
      // 塌缩点击：命中高亮即开气泡；刚关掉的那次点击不立刻复开（点外=关的手感）
      if (!wasPop) tryOpenPopAt(ev.clientX, ev.clientY);
      return;
    }
    const r = sel.getRangeAt(0);
    const root = annoRootOf(r.startContainer);
    // 两端点必须同一正文根：跨消息/跨工具行的选区两个动作语义都不成立
    if (!root || root !== annoRootOf(r.endContainer)) { hideAnnoBar(); return; }
    const mid = root.getAttribute('data-mid') ?? '';
    // 乐观消息 id（local- 前缀）落库后会被正式 id 换掉，此刻建的注释必成孤儿——不给入口
    if (!mid || mid.startsWith('local-')) { hideAnnoBar(); return; }
    const raw = root.textContent ?? '';
    const s = absoluteOffset(root as WalkNode, r.startContainer as unknown as WalkNode, r.startOffset);
    const e = absoluteOffset(root as WalkNode, r.endContainer as unknown as WalkNode, r.endOffset);
    if (e <= s || !raw.slice(s, e).trim()) { hideAnnoBar(); return; }
    pendingSel = {
      messageId: mid,
      exact: raw.slice(s, e),
      prefix: raw.slice(Math.max(0, s - 32), s),
      suffix: raw.slice(e, e + 32),
      quoteText: sel.toString(),
    };
    const rect = r.getBoundingClientRect();
    const host = paneEl.value?.getBoundingClientRect();
    if (!host) { hideAnnoBar(); return; }
    // 74 ≈ 浮条半宽：translate(-50%) 锚中点，夹紧到半宽才保证整条不捅出对话列
    annoBar.value = {
      x: Math.min(Math.max(rect.left + rect.width / 2 - host.left, 74), host.width - 74),
      y: Math.max(rect.top - host.top - 8, 8),
    };
  });
}

function quoteSelection(): void {
  const p = pendingSel;
  if (!p) return;
  const quote = p.quoteText.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
  // 追加不覆盖：用户已敲的草稿排在引用块前面
  input.value = input.value.trim() ? input.value.replace(/\s+$/, '') + '\n\n' + quote : quote;
  hideAnnoBar();
  window.getSelection()?.removeAllRanges();
  void nextTick(() => fieldEl.value?.focus());
}

function annotateSelection(): void {
  const p = pendingSel;
  hideAnnoBar();
  window.getSelection()?.removeAllRanges();
  // 本地态不就地改：add 落库后 changed 广播回流刷新 store，高亮随 watch 重算（单一代码路径）
  if (p) void chat.addAnnotation(p.messageId, { exact: p.exact, prefix: p.prefix, suffix: p.suffix });
}

// 选区塌缩（点击别处 / Esc）即收浮条；document 级监听，卸载时摘除
function onSelectionChange(): void {
  const sel = window.getSelection();
  if ((!sel || sel.isCollapsed) && annoBar.value) hideAnnoBar();
}
document.addEventListener('selectionchange', onSelectionChange);
onBeforeUnmount(() => { document.removeEventListener('selectionchange', onSelectionChange); });

// ---- H3 注释气泡：点击高亮 → 查看引文/编辑笔记/删除（命中判定用与 Highlight 同一批 Range）----
interface AnnoRangeEntry { id: string; range: Range; note: string; exact: string }
let annoRanges: AnnoRangeEntry[] = []; // repaintHighlights 每轮整批重建，与着色永远同源
const annoPop = ref<{ id: string; x: number; y: number; exact: string } | null>(null);
const annoNote = ref('');
const annoNoteEl = ref<HTMLTextAreaElement | null>(null);

function openAnnoPop(entry: AnnoRangeEntry, clientX: number, clientY: number): void {
  const host = paneEl.value?.getBoundingClientRect();
  if (!host) return;
  annoNote.value = entry.note;
  annoPop.value = {
    id: entry.id,
    exact: entry.exact.length > 80 ? entry.exact.slice(0, 80) + '…' : entry.exact,
    // 130 ≈ 气泡半宽（260px 卡）：夹紧到半宽整卡才不出列
    x: Math.min(Math.max(clientX - host.left, 130), host.width - 130),
    y: Math.min(clientY - host.top + 10, host.height - 40),
  };
  void nextTick(() => annoNoteEl.value?.focus()); // 焦点进笔记框：Esc 关卡的键盘闭环由此成立
}
function closeAnnoPop(): void { annoPop.value = null; }
function saveAnnoNote(): void {
  const p = annoPop.value;
  if (!p) return;
  closeAnnoPop();
  void chat.updateAnnotationNote(p.id, annoNote.value.trim());
}
function deleteAnno(): void {
  const p = annoPop.value;
  if (!p) return;
  closeAnnoPop();
  void chat.removeAnnotation(p.id);
}
/** 塌缩点击的高亮命中判定：与着色同源的 Range 几何，不做任何 DOM 包裹。 */
function tryOpenPopAt(clientX: number, clientY: number): void {
  if (!annoRanges.length) return;
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const caret = doc.caretRangeFromPoint?.(clientX, clientY);
  if (!caret) return;
  const hit = annoRanges.find(a => {
    try { return a.range.isPointInRange(caret.startContainer, caret.startOffset); } catch { return false; }
  });
  if (hit) openAnnoPop(hit, clientX, clientY);
}

/** 高亮渲染：CSS Custom Highlight API——零 DOM 改写（跨节点 <mark> 包裹会破坏 Vue 视图一致性），
 *  重渲染后只需重算 Range。API 缺失（理论不发生，Chromium 140）只是无着色，数据面不受影响。 */
function repaintHighlights(): void {
  const HL = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  if (!HL || !registry) return;
  const all: Range[] = [];
  const noted: Range[] = [];
  const entries: AnnoRangeEntry[] = [];
  const stream = streamEl.value;
  if (stream && chat.annotations.length) {
    const byMid = new Map<string, typeof chat.annotations>();
    for (const a of chat.annotations) {
      const list = byMid.get(a.messageId) ?? [];
      list.push(a);
      byMid.set(a.messageId, list);
    }
    for (const [mid, list] of byMid) {
      // mid 是 UUID（hex + 连字符），attr 选择器字面拼接安全
      const roots = stream.querySelectorAll(`[data-anno-root][data-mid="${mid}"]`);
      for (const a of list) {
        for (const root of roots) {
          const m = matchQuote(root.textContent ?? '', a);
          if (!m) continue;
          const pts = resolveOffsets(root as WalkNode, m.start, m.end);
          if (!pts) continue;
          const range = document.createRange();
          range.setStart(pts.start.node as Node, pts.start.offset);
          range.setEnd(pts.end.node as Node, pts.end.offset);
          all.push(range);
          if (a.note) noted.push(range);
          entries.push({ id: a.id, range, note: a.note, exact: a.exact });
          break; // 每条注释锚进首个命中的正文根
        }
      }
    }
  }
  annoRanges = entries;
  // 气泡指向的注释被删（本窗或别窗）：随重算即关，不留悬空卡
  if (annoPop.value && !entries.some(en => en.id === annoPop.value!.id)) closeAnnoPop();
  registry.set('dm-anno', new HL(...all));
  registry.set('dm-anno-noted', new HL(...noted));
}
// 重算只由消息/注释/会话切换触发（输入框键入零重算），nextTick + rAF 合帧
let repaintQueued = false;
watch(() => [chat.messages, chat.annotations, chat.activeId] as const, () => {
  if (repaintQueued) return;
  repaintQueued = true;
  void nextTick(() => requestAnimationFrame(() => { repaintQueued = false; repaintHighlights(); }));
});
</script>

<template>
  <div ref="paneEl" class="pane-c" :class="{ welcome: isEmpty }">
    <div ref="streamEl" class="stream" @scroll="onScroll" @mouseup="onStreamMouseUp">
      <EmptyState v-if="isEmpty" part="hero" @fill="fillInput" />
      <template v-else>
        <!-- 回合流：用户消息（无气泡标签行）+ 助手工作区（无名称行，回合容器承载归属） -->
        <section v-for="t in turns" :key="t.id" class="turn">
          <template v-if="t.user">
            <div class="ublock">
              <div class="urow">
                <span class="utag">你 · <span class="utime">{{ userTime(t.user.msg) }}</span></span>
                <span v-if="t.user.msg.originDeviceId" class="devmark" :style="{ color: deviceColor(t.user.msg.originDeviceId) }" :title="`来自 ${t.user.msg.originDeviceId}`">● {{ deviceShortName(t.user.msg.originDeviceId) }}</span>
                <button class="uops" type="button" title="复制" @click="copyUser(t.user!.text)"><Icon name="copy" :size="13" /></button>
              </div>
              <div class="utext" data-anno-root :data-mid="t.user.msg.id">{{ t.user.text }}</div>
              <!-- 历史附件 chip：📎 + 文件名（元数据渲染，不加载图片字节） -->
              <div v-if="userAttachments(t.user.msg).length" class="uchips">
                <span
                  v-for="(a, i) in userAttachments(t.user.msg)" :key="i" class="uchip"
                  :title="a.relativePath"
                >📎 {{ attLabel(a) }}</span>
              </div>
            </div>
          </template>
          <div v-for="m in t.assistants" :key="m.id" class="msg-a">
            <div class="abody">
              <div v-if="m.originDeviceId" class="devmark-line"><span class="devdot" :style="{ background: deviceColor(m.originDeviceId) }"></span><span class="devname" :style="{ color: deviceColor(m.originDeviceId) }">{{ deviceShortName(m.originDeviceId) }}</span></div>
              <!-- 历史思考块：reasoningContent 落库字段，默认收起（「已思考」），置正文前 -->
              <ThinkingBlock v-if="m.reasoningContent" :text="m.reasoningContent" />
              <template v-for="(p, i) in (Array.isArray(m.parts) ? m.parts : [])" :key="i">
                <!-- 锚域 = 单个文本 part 的渲染根：工具行的展开/收起会改 textContent，绝不能进锚域 -->
                <div v-if="p && p.type === 'text' && typeof p.value === 'string' && p.value" class="anno-root" data-anno-root :data-mid="m.id">
                  <MarkdownView :nodes="mdOf(`${m.id}:${i}`)" />
                </div>
                <ToolLine
                  v-else-if="p && p.type === 'toolUse' && p.value"
                  :name="isRec(p.value) ? p.value.name : ''"
                  :title="toolTitle(p.value)"
                  :state="resultOf(isRec(p.value) ? p.value.toolUseId : undefined)?.success === false ? 'fail' : 'ok'"
                  :input="isRec(p.value) && typeof p.value.input === 'string' ? p.value.input : null"
                  :output="resultOf(isRec(p.value) ? p.value.toolUseId : undefined)?.output ?? null"
                />
              </template>
            </div>
          </div>
        </section>

        <!-- 实时助手块：流式文本 + 执行中胶囊 + 权限卡 + 重试提示（进行中的回合，保名称行） -->
        <section v-if="hasLive" class="turn live">
          <div class="ahead"><div class="aicon"></div><div class="aname">DeskMinis</div></div>
          <div class="abody">
            <!-- 实时思考块：流式正文上方，收起态露末两行（思考还在滚动的窗口感） -->
            <ThinkingBlock v-if="chat.streamingThinking" :text="chat.streamingThinking" streaming />
            <MarkdownView v-if="streamStable.length" :nodes="streamStable" />
            <FadeText v-if="streamTailText" :text="streamTailText" />
            <!-- 实时工具行：连续 ≥3 同型成组（组头展开嵌子行， ToolLine 默认插槽覆写） -->
            <template v-for="item in liveItems" :key="isGroup(item) ? gkey(item) : item.toolUseId">
              <ToolLine
                v-if="isGroup(item)"
                :name="item.name" :title="groupTitle(item.name, item.count)" :state="groupState(item)"
              >
                <ToolLine
                  v-for="card in item.items" :key="card.toolUseId"
                  :name="card.name" :title="card.title || card.name" :state="liveState(card)"
                  :output="card.output ?? null"
                />
              </ToolLine>
              <ToolLine
                v-else
                :name="item.name" :title="item.title || item.name" :state="liveState(item)"
                :output="item.output ?? null"
              />
            </template>
            <PermissionCard v-for="p in chat.pendingPerms" :key="p.requestId" :perm="p" :data-req="p.requestId" />
            <!-- dots 排除 streamingThinking：纯思考阶段已由上方 ThinkingBlock 的「思考中…」占位，
                 不排除的话两套「正在干活」指示会同屏叠着 -->
            <div v-if="chat.running && !chat.streamingText && !chat.streamingThinking && !chat.toolCards.length && !chat.pendingPerms.length && !chat.retryNote" class="dots"><i></i><i></i><i></i></div>
          </div>
        </section>

        <!-- 统一事件条（MU2a Task 8，设计 §5.3）：retry/fallback/compacted/offloaded/error 五类一套语法。
             store 已保证最多 10 条，直接 v-for；error 条带重试钮（无可重发用户消息时钮不出现）。 -->
        <EventNote
          v-for="v in noteViews" :key="v.note.ts + v.note.kind + (v.note.detail || '')"
          :kind="v.note.kind" :icon="v.copy.icon" :short="v.copy.short" :tone="v.copy.tone"
          :detail="v.note.detail" :retryable="!!v.note.retryable && canRetry"
          @retry="chat.retryLast()"
        />
      </template>
    </div>

    <button
      v-if="!following" class="back-bottom" type="button"
      title="回到底部" aria-label="回到底部" @click="backToBottom"
    ><Icon name="chevron-down" :size="16" /></button>

    <!-- 选区浮条：mousedown.prevent 是必须的——默认 mousedown 会先塌掉选区，click 就永远打不到 -->
    <div v-if="annoBar" class="annobar" role="toolbar" aria-label="选区操作" :style="{ left: annoBar.x + 'px', top: annoBar.y + 'px' }">
      <button type="button" class="annobtn" aria-label="引用到输入框" @mousedown.prevent="quoteSelection"><Icon name="copy" :size="13" /><span>引用</span></button>
      <button type="button" class="annobtn" aria-label="添加标注" @mousedown.prevent="annotateSelection"><Icon name="book" :size="13" /><span>标注</span></button>
    </div>

    <!-- 注释气泡：点击高亮弹出；Esc（焦点在笔记框，事件冒泡到卡）/流内点击别处/删除/保存即关 -->
    <div
      v-if="annoPop" class="annopop" role="dialog" aria-label="标注"
      :style="{ left: annoPop.x + 'px', top: annoPop.y + 'px' }"
      @keydown.esc="closeAnnoPop"
    >
      <div class="annoquote">{{ annoPop.exact }}</div>
      <textarea ref="annoNoteEl" v-model="annoNote" class="annonote" rows="2" placeholder="添加笔记…" aria-label="标注笔记"></textarea>
      <div class="annoops">
        <button type="button" class="annodel" aria-label="删除标注" @click="deleteAnno">删除</button>
        <button type="button" class="annosave" aria-label="保存笔记" @click="saveAnnoNote">保存</button>
      </div>
    </div>

    <div class="composer">
      <div v-if="slashOpen" class="slashmenu">
        <button
          v-for="(s, i) in slashItems" :key="s.id" type="button"
          class="slashitem" :class="{ on: i === slashIndex }"
          @mousedown.prevent="slashPick(s.name)" @mouseenter="slashIndex = i"
        >
          <Icon name="book" :size="14" />
          <span class="sname">/{{ s.name }}</span>
          <span class="sdesc">{{ s.description }}</span>
        </button>
      </div>
      <div v-if="pendingAttachments.length" class="achips">
        <div v-for="(a, i) in pendingAttachments" :key="a.path" class="achip">
          <img :src="a.dataUrl" :alt="a.path" />
          <button class="adel" type="button" title="移除附件" @click="removeAttachment(i)">×</button>
        </div>
      </div>
      <textarea
        ref="fieldEl"
        v-model="input" class="field" :rows="rowsFor(input)"
        :placeholder="composerPlaceholder"
        @keydown.enter.exact.prevent="onEnterKey"
        @keydown.up="onSlashNav(-1, $event)"
        @keydown.down="onSlashNav(1, $event)"
        @keydown.tab="onSlashTab"
        @keydown.esc="slashOpen = false"
        @paste="onPaste"
        @drop="onDrop"
        @dragover.prevent
      ></textarea>
      <div class="ctools">
        <input ref="attachEl" class="attachinput" type="file" accept="image/*" multiple @change="onAttachPick" />
        <button class="attach" type="button" title="添加附件" @click="openAttach"><Icon name="plus" :size="15" /></button>
        <button
          class="cpill wsbtn" type="button" :title="`工作区：${chat.workspaceRoot || '未设置'}`"
          @click="toggleWs"
        ><Icon name="folder" :size="14" /><span>{{ workspaceLabel }}</span></button>
        <button
          v-if="mcpPillVisible" class="cpill mcpbtn" type="button"
          :title="`MCP 服务器：本会话已禁用 ${mcpDisabledCount} 个`"
          @click="toggleMcp"
        ><Icon name="globe" :size="14" /><span>{{ mcpLabel }}</span></button>
        <PermissionPicker />
        <ModelPicker />
        <button v-if="!chat.running" class="send" :disabled="!canSend" @click="send"><Icon name="send" :size="17" /></button>
        <button v-else class="send stop" title="停止" @click="chat.cancel()"><Icon name="stop" :size="16" /></button>
      </div>
      <!-- 工作区面板：**行内展开**而非浮层——.ctools 的 overflow 会把浮层裁掉
           （MU5 §15 与 MU6 会话菜单都栽在同一处，这里从一开始就绕开）。 -->
      <div v-if="wsOpen" class="wspanel">
        <div class="wsnow">
          <span class="wslabel">当前工作区</span>
          <span v-if="chat.activeId" class="wspath" :title="chat.workspaceRoot">{{ chat.workspaceRoot }}</span>
          <span v-else class="wspath wsnone">尚未选择会话——工作区是每个会话各自的</span>
          <span v-if="chat.activeId && chat.workspaceIsDefault" class="wstag">会话沙箱（默认）</span>
        </div>
        <!-- 两行而不是三个控件挤一行：336px 的对话列塞不下。
             挤在一行时输入框会被压到只剩两个字（用户 2026-08-11 实测截图），
             而恰恰是「没有会话」时按钮文案最长——我上一轮为说清副作用加长了文案，反把它挤坏了。
             主操作独占一行（文案有地方把副作用说全），粘贴路径退居第二行。 -->
        <button class="wsbtn-main" type="button" :disabled="wsBusy" @click="pickWs">
          {{ chat.activeId ? '选择目录…' : '新建会话并选目录…' }}
        </button>
        <div class="wsrow">
          <input
            v-model="wsPath" class="wsinput" type="text" placeholder="或粘贴绝对路径，如 D:\projects\my-app"
            @keydown.enter="applyWs"
          />
          <button class="wsbtn-apply" type="button" :disabled="wsBusy || !wsPath.trim()" @click="applyWs">应用</button>
        </div>
        <div class="wsfoot">
          <span class="wshint">
            shell 命令、终端、相对路径都以这里为基准。<template v-if="!chat.activeId">应用时会先新建一个会话。</template>
          </span>
          <button v-if="!chat.workspaceIsDefault" class="wsreset" type="button" @click="resetWs">恢复默认沙箱</button>
        </div>
        <div v-if="wsErr" class="wserr">{{ wsErr }}</div>
      </div>
      <!-- L5 会话级 MCP 面板：同 wspanel 走行内展开（.ctools overflow 会裁浮层，老坑不再踩） -->
      <div v-if="mcpOpen" class="mcpanel">
        <div class="mchead">
          <span class="mclabel">MCP 服务器</span>
          <span class="mctag">勾选 = 本会话禁用</span>
        </div>
        <label v-for="s in enabledMcpServers" :key="s.name" class="mcrow">
          <input type="checkbox" :checked="sessionMcpDisabled.includes(s.name)" @change="toggleSessionMcp(s.name)" />
          <span class="mcname">{{ s.name }}</span>
        </label>
        <div class="mchint">勾选即落库，下一回合起不再向模型提供该 server 的工具（进行中的回合里调用也会被拒）。全局启停在 设置 → MCP。</div>
      </div>
    </div>
    <!-- I6 欢迎屏下半区（AionUi Guid 页次序：hero → composer → 助手区）：
         助手 chips/预设 prompts/示例卡/最近任务全在 composer 之下，EmptyState 分部渲染 -->
    <div v-if="isEmpty" class="wbelow">
      <EmptyState part="below" @fill="fillInput" />
    </div>
  </div>
</template>

<style scoped>
/* 工作区 chip 与行内面板 */
.wsbtn { cursor: pointer; }
.wspanel {
  margin: 8px 10px 2px; padding: 10px 12px; border-radius: var(--r-md);
  background: var(--fill-quaternary); border: .5px solid var(--separator);
  display: flex; flex-direction: column; gap: 8px;
}
.wsnow { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: var(--fs-micro); }
.wslabel { color: var(--label-tertiary); flex: 0 0 auto; }
.wspath {
  flex: 1; min-width: 0; color: var(--label); font-family: var(--font-mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
}
.wstag { flex: 0 0 auto; color: var(--label-tertiary); }
.wsnone { color: var(--label-tertiary); font-family: var(--font-ui); direction: ltr; }
.wsrow { display: flex; gap: 6px; }
.wsinput {
  /* min-width 给下限：flex 默认 min-width:auto 会被兄弟挤到只剩几像素。
     宁可整行换行，也不要一个压成缝的输入框。 */
  flex: 1 1 auto; min-width: 140px; padding: 5px 8px; border-radius: var(--r-control);
  border: .5px solid var(--separator); background: var(--surface-1);
  color: var(--label); font-size: var(--fs-micro); font-family: var(--font-mono);
}
.wsinput:focus-visible { outline: 2px solid var(--ring-input); outline-offset: 1px; }
.wsbtn-main, .wsbtn-apply, .wsreset {
  flex: 0 0 auto; padding: 5px 12px; border-radius: var(--r-control);
  font-size: var(--fs-micro); cursor: pointer; white-space: nowrap;
}
/* 主操作独占一行：文案在没有会话时会变长（「新建会话并选目录…」），
   与输入框同排必然把后者挤没 */
.wsbtn-main { width: 100%; border: none; background: var(--action); color: var(--on-action); font-weight: 600; }
.wsbtn-apply { border: .5px solid var(--separator); background: var(--surface-1); color: var(--label); }
.wsbtn-main:disabled, .wsbtn-apply:disabled { opacity: var(--opacity-disabled); cursor: default; }
.wsreset { border: .5px solid var(--separator); background: none; color: var(--label-secondary); margin-left: auto; }
.wsbtn-main:focus-visible, .wsbtn-apply:focus-visible, .wsreset:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.wsfoot { display: flex; align-items: center; gap: 8px; }
.wshint { font-size: var(--fs-micro); color: var(--label-tertiary); line-height: 1.5; }
.wserr { font-size: var(--fs-micro); color: var(--state-err); line-height: 1.5; }
/* L5 会话级 MCP 行内面板（wspanel 同款视觉，行结构对齐 AssistantSettings 技能勾选） */
.mcpanel {
  margin: 8px 10px 2px; padding: 10px 12px; border-radius: var(--r-md);
  background: var(--fill-quaternary); border: .5px solid var(--separator);
  display: flex; flex-direction: column; gap: 6px;
}
.mchead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: var(--fs-micro); }
.mclabel { color: var(--label-tertiary); }
.mctag { color: var(--label-secondary); font-weight: 600; }
.mcrow { display: flex; align-items: center; gap: 8px; font-size: var(--fs-micro); cursor: pointer; }
.mcrow input { accent-color: var(--action); }
.mcname { color: var(--label); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mchint { font-size: var(--fs-micro); color: var(--label-tertiary); line-height: 1.5; }
.pane-c { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); overflow: hidden; position: relative; }
/* scrollbar-gutter 对称预留：滚动条 15px 会让正文在「减掉滚动条」的宽里居中，
   而输入卡在完整宽里居中，两者左缘差 8px（实测）。both-edges 让两边各留一份，
   正文与输入卡就精确对齐；顺带解决另一个毛病——消息多到撑出滚动条时整列文字横跳 15px。 */
.stream { flex: 1; overflow: auto; padding: 12px 0; scrollbar-gutter: stable both-edges; }

/* 解除跟随后右下浮出的「回到底部」小圆钮（设计 §2.4） */
.back-bottom {
  position: absolute; right: 20px; bottom: 96px; z-index: 20;
  width: 32px; height: 32px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--surface-1);
  border: .5px solid var(--separator); color: var(--label-secondary);
  cursor: pointer; box-shadow: 0 4px 16px var(--shadow-color);
}
.back-bottom:hover { color: var(--label); background: var(--fill-tertiary); }
/* MU3 §2-5 焦点环：键盘 :focus-visible 出环，鼠标点击无环 */
.back-bottom:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

/* 回合容器（设计 v2 §2.1）：回合间 1px 分隔线 + 24px 间距，回合内块间 8px */
/* MU5：对话列现在可以拖到可用宽的一半（2560 屏上到 1254px），但**正文不该跟着拉长**——
   实测 1254px 时每行约 157 字符，远超 45–90 的可读区间。
   列宽是布局问题，行长是排版问题，两件事：容器随列宽伸展，正文按可读宽度居中。
   792 = 760 可读宽 + 左右 16px 内边距（box-sizing: border-box）。 */
/* 阅读栏宽度是**对话列的统一契约**，不是「消息」独有的。
   初版只给了 .turn，结果空态与事件条不受约束——大屏 + 折叠工作台时空态整块横跨 1877px，
   而输入卡是 792 居中，两者左缘差 59px，看着就是「比例不对」。
   改成管住 .stream 的全部直接子元素，一处定义、处处对齐。 */
.stream > * { width: 100%; max-width: 792px; margin-inline: auto; }
.turn { padding: 0 16px; display: flex; flex-direction: column; gap: 8px; }
.turn + .turn { border-top: .5px solid var(--separator); margin-top: var(--sp-6); padding-top: var(--sp-6); }

/* I4（AionUi 换向）：用户消息右对齐浅蓝气泡——「谁说的」由方位编码（右=你，左=助手），
   标签行随块右对齐。右上角收平是 AionUi 的方向切角（指向发话者）。 */
.ublock { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
.urow { display: flex; align-items: center; gap: 8px; min-height: 20px; }
.utag { font-size: var(--fs-ui); font-weight: 600; color: var(--label-secondary); }
.utime { font-weight: 400; font-size: var(--fs-caption); color: var(--label-tertiary); }
.uops {
  opacity: 0; transition: opacity .12s ease-out;
  background: none; border: none; padding: 2px; cursor: pointer;
  color: var(--label-tertiary); display: inline-flex; border-radius: var(--r-control);
}
.ublock:hover .uops, .uops:focus-visible { opacity: 1; }
.uops:hover { color: var(--label); background: var(--fill-tertiary); }
.uops:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.utext {
  font-size: var(--fs-body); line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  background: var(--secondary-subtle);
  border-radius: var(--r-control) 0 var(--r-control) var(--r-control);
  padding: 8px 12px; max-width: 86%; text-align: left;
}
/* 历史附件 chip（mediaRef）：样式随 .cpill 同款 chip token；只显示文件名不显示图 */
.uchips { display: flex; flex-wrap: wrap; gap: 6px; }
.uchip {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: var(--r-pill);
  border: .5px solid var(--separator); background: var(--grouped-bg-secondary);
  font-size: var(--fs-ui); color: var(--label-secondary); max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 助手消息：无气泡（名称行只留实时回合一处） */
.msg-a { padding: 0; }
.ahead { display: flex; align-items: center; gap: 8px; }
.aicon { width: 18px; height: 18px; border-radius: 5px; background: var(--assistant-gradient); flex: 0 0 auto; }
.aname { font-size: var(--fs-title); font-weight: 600; color: var(--label-strong); }
/* MU5：文档式排版——行高 1.55 → 1.72（来源 AionUi 会话视图：助手输出按文档排，不进气泡）。
   气泡本身 MU2a 就已去掉（.msg-a{padding:0}），本轮补的是「读起来像文档」的那一半。 */
/* I4（AionUi 换向）：助手输出**无背景满行宽平铺**——文档式排版回归（E3 浮岛卡退场）。
   AionUi 的会话语言：用户是气泡、助手是文档；层次由方位与排版承担，不靠卡片框。 */
.abody {
  font-size: var(--fs-body); line-height: 1.72; display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
  align-self: stretch;
}

.dots { display: inline-flex; gap: 4px; padding: 4px 0; }
.dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--label-tertiary); animation: jump 1s infinite ease-in-out; }
.dots i:nth-child(2) { animation-delay: .15s; }
.dots i:nth-child(3) { animation-delay: .3s; }
@keyframes jump { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-3px); opacity: 1; } }

/* 输入区：浮动容器（MU3：材质退场改实底） */
.composer {
  /* 与正文同宽同轴：窄列时靠 100% - 32px 保住 16px 边距，宽列时封顶 792 并居中。
     必须写 width 而不是只写 max-width——.composer 是列向 flex 容器里的 flex item，
     **auto 外边距会关掉 cross 轴的 stretch**，只给 max-width 的话它会退回按内容收缩
     （实测宽列里只剩 339px）。显式 width 才拿得到该有的宽度。 */
  width: min(792px, 100% - 32px); margin: 0 auto 16px;
  border-radius: var(--r-input); background: var(--surface-1);
  border: .5px solid var(--separator);
  /* I4：受光边退场——AionUi 输入大卡 = 白底 + 1px 边 + 柔影（24px 圆角随 I1 --r-input） */
  box-shadow: var(--shadow-fab);
  padding: 10px; display: flex; flex-direction: column; gap: 10px; flex: 0 0 auto;
  position: relative;
}
/* 输入卡是视觉主角——聚焦时外光 2px --glow-accent 一档（I1 起为蓝，AionUi 聚焦光环位），
   叠加在柔影上而不是替换，失焦即回到常态（:focus-within 覆盖卡内全部控件） */
.composer:focus-within {
  box-shadow: var(--shadow-fab), 0 0 0 2px var(--glow-accent);
}
.slashmenu {
  position: absolute; left: 10px; right: 10px; bottom: calc(100% + 6px); z-index: 10;
  display: flex; flex-direction: column; padding: 6px; gap: 2px; max-height: 260px; overflow: auto;
  background: var(--surface-1);
  border: .5px solid var(--separator); border-radius: var(--r-md);
  box-shadow: 0 8px 28px var(--shadow-color);
}
.slashitem {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: none; background: none;
  border-radius: var(--r-control); cursor: pointer; color: var(--label); font-family: var(--font-ui);
  font-size: var(--fs-body); text-align: left;
}
.slashitem.on { background: var(--fill-tertiary); }
.slashitem:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.slashitem :deep(svg) { stroke: var(--label-secondary); flex: 0 0 auto; }
.sname { font-weight: 600; flex: 0 0 auto; color: var(--label-strong); }
.sdesc { color: var(--label-tertiary); font-size: var(--fs-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.field {
  /* MU5：卡片本身即边界，输入框自己不再描边——去掉「框中框」 */
  background: none; border: none; border-radius: var(--r-control);
  padding: 8px 12px; font-size: var(--fs-body); color: var(--label); font-family: var(--font-ui);
  min-height: 36px; max-height: 176px; resize: none; line-height: 20px; width: 100%;
  overflow-y: auto; /* 超 8 行（176px）内滚 */
}
.field::placeholder { color: var(--label-tertiary); }
/* MU3 §2-5：输入类焦点环 --ring-input（原灭绝默认环写法退场，键盘/鼠标聚焦均有环） */
.field:focus-visible { outline: 2px solid var(--ring-input); outline-offset: 1px; }
/* 附件 chip（设计 §5.5：48px 圆角 --r-control，对齐 OpenMinis AttachmentChip 语义） */
.achips { display: flex; gap: 8px; flex-wrap: wrap; }
.achip {
  position: relative; width: 48px; height: 48px; border-radius: var(--r-control);
  overflow: hidden; border: .5px solid var(--separator); flex: 0 0 auto;
}
.achip img { width: 100%; height: 100%; object-fit: cover; display: block; }
.adel {
  position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 50%;
  border: none; background: var(--surface-1); color: var(--label); font-size: 11px; line-height: 1;
  display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
}
/* MU5：对话列由弹性收成 336 定宽后，底部这排 chip 挤不下会**逐字换行**
   （「工作区」竖成三行），真机截图才逮到——1048 例源码守卫与 e2e 8/8 全绿也看不见这种事。
   处置：一律禁止换行，放不下由各自省略号收尾，发送钮靠 margin-left:auto 永远钉在右端。 */
/* ⚠️ 这里**不能**写 overflow: hidden。
   曾为防 chip 换行加过，结果把权限档/模型两枚 chip 向上弹出的下拉菜单整个裁掉
   （菜单 300×248 弹在 .ctools 盒子外 251px 处，而盒子只有 32px 高）——
   表现就是「点了没反应」。不换行由子元素自己的 nowrap + min-width:0 + 省略号保证，
   容器不必也不该裁剪，否则任何弹出层都会被闷死在里面。 */
.ctools { display: flex; align-items: center; gap: 8px; position: relative; }
.ctools > :deep(.wrap) { flex: 0 1 auto; min-width: 0; }
/* 336px 里要塞下「＋ 工作区 权限档 模型 发送」，13px/11px 内边距的常规 chip 一共约 244px，
   可用宽只有约 194px——差 50px。故在输入卡这一处收紧到 11px 字号与 8px 内边距（约省 54px）。
   只在 .ctools 作用域内收紧，其它地方的 .cpill 不受影响。 */
/* E3：chip 文字走 mono（Aurora §4 读数面——工作区名/权限档/模型名都是「标识符读数」） */
.cpill, .ctools :deep(.cpill) {
  flex: 0 1 auto; min-width: 0;
  padding: 4px 8px; font-size: var(--fs-micro); gap: 5px;
  font-family: var(--font-mono);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ctools :deep(.mt) { font-size: var(--fs-micro); }
.send { width: 28px; height: 28px; }
/* 对话列可窄至 280px，而 PermissionPicker / ModelPicker 的弹层原本
   `position:absolute; left:0; min-width:240px`（权限档实测 300px 宽）以 chip 为锚向右展开。
   窄列里弹层右缘会捅出对话列，被 ChatView 根的 overflow:hidden 裁掉——**表现就是「点了没反应」**。
   MU5 之前对话列是弹性的（八百多 px），放得下，所以这问题是本轮收窄后才显形的。

   处置：把 .wrap 的定位参照让出去，改以 .ctools 为锚、左右对齐铺满，宽度随列宽自适应——
   窄列不再溢出，宽列也不会拉成一条。用 .ctools 而不是 .composer 作参照，是因为弹层原本的
   bottom: calc(100% + 6px) 可原样生效，不必去猜输入卡高度（它随输入行数与附件 chip 变）。
   两个 picker 组件本身一行不改——它们不该为「外面有多宽」负责。 */
.ctools :deep(.wrap) { position: static; }
.ctools :deep(.menu) { left: 0; right: 0; min-width: 0; width: auto; }

/* MU5 附件入口：隐藏的原生 file input + 可聚焦的 ＋ 钮（红线 6） */
.attachinput { display: none; }
.attach {
  flex: 0 0 auto; width: 26px; height: 26px; padding: 0;
  border-radius: var(--r-control); border: .5px solid var(--separator); background: none;
  color: var(--label-secondary); display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.attach:hover { background: var(--fill-quaternary); color: var(--label); }
.attach:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.attach :deep(svg) { stroke: var(--label-secondary); }
.cpill {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: var(--r-pill);
  border: .5px solid var(--separator); background: var(--grouped-bg-secondary);
  font-size: var(--fs-ui); color: var(--label-secondary);
}
.cpill.static { cursor: default; }
/* 发送键（MU2b Task 6 色权修正）：32px 圆形 --action 实底——唯一主行动色，黑底（var(--label)）退场 */
.send {
  margin-left: auto; width: 32px; height: 32px; border-radius: 50%; background: var(--action);
  display: flex; align-items: center; justify-content: center; flex: 0 0 auto; border: none; cursor: pointer; padding: 0;
}
.send :deep(svg) { stroke: var(--on-action); }
.send:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.send:disabled { background: var(--label-quaternary); cursor: default; }
.send.stop :deep(svg) { stroke: var(--on-action); fill: var(--on-action); }
/* M3c Task 7：回合区消息设备标（决策 7c）——originDeviceId 映射色点 + 6 字短名 */
.devmark { font-size: var(--fs-micro); font-family: var(--font-mono); opacity: .8; }
.devmark-line { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }
.devdot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.devname { font-size: var(--fs-micro); font-family: var(--font-mono); opacity: .8; }

/* H2 选区注释：锚域包装继承 .md 的伸展（否则窄于 .abody，选区高亮右缘裁切） */
.anno-root { align-self: stretch; min-width: 0; }
/* 浮条：实底浮岛（ChatView 不在 blur 白名单例 8 的 ALLOW，也不申请扩——零 blur 纪律） */
.annobar {
  position: absolute; z-index: 30; transform: translate(-50%, -100%);
  /* width: max-content 是必须的：absolute 盒按「left 到右缘」shrink-to-fit，
     选区靠右时可用宽塌缩，CJK 按钮文字会逐字竖排（真机截图逮到的） */
  width: max-content; white-space: nowrap;
  display: inline-flex; gap: 2px; padding: 3px;
  background: var(--surface-1); border: .5px solid var(--separator); border-radius: var(--r-md);
  box-shadow: 0 8px 28px var(--shadow-color);
}
.annobtn {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
  border: none; background: none; border-radius: var(--r-control); cursor: pointer;
  color: var(--label); font-family: var(--font-ui); font-size: var(--fs-micro);
}
.annobtn:hover { background: var(--fill-tertiary); }
.annobtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.annobtn :deep(svg) { stroke: var(--label-secondary); }
/* 注释气泡：260px 实底浮岛卡（同零 blur 纪律） */
.annopop {
  position: absolute; z-index: 30; transform: translateX(-50%);
  width: 260px; display: flex; flex-direction: column; gap: 8px; padding: 10px;
  background: var(--surface-1); border: .5px solid var(--separator); border-radius: var(--r-md);
  box-shadow: 0 8px 28px var(--shadow-color);
}
.annoquote {
  font-size: var(--fs-micro); color: var(--label-secondary); line-height: 1.5;
  padding-left: 8px; border-left: 3px solid var(--accent);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.annonote {
  resize: none; padding: 6px 8px; border-radius: var(--r-control);
  border: .5px solid var(--separator); background: var(--bg); color: var(--label);
  font-family: var(--font-ui); font-size: var(--fs-micro); line-height: 1.5;
}
.annonote:focus-visible { outline: 2px solid var(--ring-input); outline-offset: 1px; }
.annoops { display: flex; justify-content: space-between; gap: 8px; }
.annodel {
  border: none; background: none; color: var(--state-err); font-size: var(--fs-micro);
  cursor: pointer; padding: 4px 8px; border-radius: var(--r-control);
}
.annodel:hover { background: var(--fill-tertiary); }
.annosave {
  border: none; background: var(--action); color: var(--on-action); font-size: var(--fs-micro);
  font-weight: 600; cursor: pointer; padding: 4px 12px; border-radius: var(--r-control);
}
.annodel:focus-visible, .annosave:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

/* I3 欢迎态（AionUi Guid 页形态，设计稿 §5）：hero 空态 + composer 作为一组垂直居中。
   justify-content 用 safe center——EmptyState 自己就踩过「center 把溢出内容顶出滚动
   原点」的坑（其 <style> 头注），小窗口下这里同样会溢出，safe 让它退回 start 可滚。
   ⚠️ 本组规则必须排在文件末尾：多个源码守卫用「首个 `.composer {`/`.stream {` 匹配」
   取规则块，welcome 变体若排在原始块之前会被守卫误当主块（i3 实测踩中）。 */
.pane-c.welcome { justify-content: safe center; }
.pane-c.welcome .stream { flex: 0 1 auto; }
/* I6 次序改造（AionUi Guid 页）：hero(stream) → composer → 助手区(.wbelow)。
   重心上移从 composer 底边距移到 wbelow 底 padding——中间不能再隔一块 10vh 的空白 */
.pane-c.welcome .composer { margin-bottom: 0; }
.wbelow {
  flex: 0 1 auto; min-height: 0; overflow: auto;
  padding: 6px 16px min(8vh, 72px);
}
</style>

<style>
/* H2 标注高亮（设计稿 §1-2/§1-9）。::highlight 是文档级伪元素：scoped 会给选择器
   缀 [data-v-*] 使其永不匹配，这一块必须非 scoped。着色只叠 accent 低透明度底，
   正文对比度由原文字色保证（AA 口径）；有笔记的一档加深并带虚线下划线作可点提示。 */
::highlight(dm-anno) { background-color: color-mix(in srgb, var(--accent) 22%, transparent); }
::highlight(dm-anno-noted) {
  background-color: color-mix(in srgb, var(--accent) 30%, transparent);
  text-decoration: underline dotted;
}
</style>
