<script setup lang="ts">
/** 中栏 · 对话流（设计 v2 §2.1）——回合结构：用户消息无气泡标签行（你 · HH:MM + hover 复制），
 *  助手回合容器（分隔线 + 间距），工具胶囊、内联权限卡、浮动输入区。
 *  渲染对 parts 全程空值兜底：parts.ts 允许 value:null 的 part，绝不解引用崩溃。 */
import { ref, computed, nextTick, watch } from 'vue';
import { useChat } from '../stores/chat';
import ToolLine from './ToolLine.vue';
import PermissionCard from './PermissionCard.vue';
import EmptyState from './EmptyState.vue';
import ModelPicker from './ModelPicker.vue';
import PermissionPicker from './PermissionPicker.vue';
import Icon from './Icon.vue';
import EventNote from './EventNote.vue';
import MarkdownView from './MarkdownView.vue';
import FadeText from './FadeText.vue';
import { MarkdownCache } from '../lib/markdown/cache';
import { stablePrefixEnd } from '../lib/markdown/prefix';
import { shouldFollow } from '../lib/scroll/follow';
import { fmtHHMM } from '../lib/time/hhmm';
import { groupToolCards, isGroup, type ToolGroup } from '../lib/toolline/group';
import { eventCopy } from '../lib/eventnote/copy';
import { rowsFor } from '../lib/composer/autogrow';
import { attachNote } from '../lib/composer/attach';
import type { MdNode } from '../lib/markdown/parse';

const chat = useChat();
const input = ref('');
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
const isEmpty = computed(() => chat.messages.length === 0 && !hasLive.value && chat.eventNotes.length === 0);

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

const canSend = computed(() => input.value.trim().length > 0 && !chat.running);

// ---- MU2b Task 6：图片粘贴/拖拽附件（main 落盘会话附件目录 → 48px chip → 发送尾注）----
interface PendingAttachment { path: string; dataUrl: string }
const pendingAttachments = ref<PendingAttachment[]>([]);

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(f);
  });
}
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
    const dataUrl = await fileToDataUrl(f);
    const path = await bridge.saveAttachment(id, dataUrl); // 返回会话相对路径 attachments/paste-<ts>.png
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
  if (!t || chat.running) return;
  // 没有选中会话就先建一个再发（避免「按了没反应」）
  if (!chat.activeId) await chat.newSession();
  input.value = '';
  // 附件 chip → 文本尾注（[附件] attachments/paste-…png），发送后清空
  const note = attachNote(pendingAttachments.value.map(a => a.path));
  pendingAttachments.value = [];
  await chat.send(t + note);
}

// ---- 滚动跟随治理（MU2a Task 3，治审计 X-2）：用户上翻 >40px 解除跟随，回到底部恢复 ----
const following = ref(true);
function onScroll(): void {
  const el = streamEl.value;
  if (!el) return;
  following.value = shouldFollow(el.scrollTop, el.scrollHeight, el.clientHeight, following.value);
}
// 新内容到达时贴底滚动（仅在跟随态；解除后不抢回）
watch(
  () => [chat.messages.length, chat.streamingText, chat.toolCards.length, chat.retryNote, chat.pendingPerms.length, chat.eventNotes.length] as const,
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
function onSlashNav(delta: number, e: KeyboardEvent): void {
  if (!slashOpen.value) return;
  e.preventDefault();
  slashIndex.value = (slashIndex.value + delta + slashItems.value.length) % slashItems.value.length;
}
function onSlashTab(e: KeyboardEvent): void {
  if (!slashOpen.value) return;
  e.preventDefault();
  const s = slashItems.value[slashIndex.value];
  if (s) slashPick(s.name);
}
</script>

<template>
  <div class="pane-c">
    <div ref="streamEl" class="stream" @scroll="onScroll">
      <EmptyState v-if="isEmpty" @fill="fillInput" />
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
              <div class="utext">{{ t.user.text }}</div>
            </div>
          </template>
          <div v-for="m in t.assistants" :key="m.id" class="msg-a">
            <div class="abody">
              <div v-if="m.originDeviceId" class="devmark-line"><span class="devdot" :style="{ background: deviceColor(m.originDeviceId) }"></span><span class="devname" :style="{ color: deviceColor(m.originDeviceId) }">{{ deviceShortName(m.originDeviceId) }}</span></div>
              <template v-for="(p, i) in (Array.isArray(m.parts) ? m.parts : [])" :key="i">
                <MarkdownView v-if="p && p.type === 'text' && typeof p.value === 'string' && p.value" :nodes="mdOf(`${m.id}:${i}`)" />
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
            <div v-if="chat.running && !chat.streamingText && !chat.toolCards.length && !chat.pendingPerms.length && !chat.retryNote" class="dots"><i></i><i></i><i></i></div>
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
        placeholder="让 DeskMinis 做点什么…"
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
        <div class="cpill static"><Icon name="folder" :size="14" /><span>工作区</span></div>
        <PermissionPicker />
        <ModelPicker />
        <button v-if="!chat.running" class="send" :disabled="!canSend" @click="send"><Icon name="send" :size="17" /></button>
        <button v-else class="send stop" title="停止" @click="chat.cancel()"><Icon name="stop" :size="16" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
.turn {
  padding: 0 16px; display: flex; flex-direction: column; gap: 8px;
  max-width: 792px; margin-inline: auto; width: 100%;
}
.turn + .turn { border-top: .5px solid var(--separator); margin-top: var(--sp-6); padding-top: var(--sp-6); }

/* 用户消息：无气泡，左对齐标签行「你 · HH:MM」+ hover 复制钮（Codex 式回合归属） */
.ublock { display: flex; flex-direction: column; gap: 4px; }
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
.utext { font-size: var(--fs-body); line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
/* 助手消息：无气泡（名称行只留实时回合一处） */
.msg-a { padding: 0; }
.ahead { display: flex; align-items: center; gap: 8px; }
.aicon { width: 18px; height: 18px; border-radius: 5px; background: var(--assistant-gradient); flex: 0 0 auto; }
.aname { font-size: var(--fs-title); font-weight: 600; color: var(--label-strong); }
/* MU5：文档式排版——行高 1.55 → 1.72（来源 AionUi 会话视图：助手输出按文档排，不进气泡）。
   气泡本身 MU2a 就已去掉（.msg-a{padding:0}），本轮补的是「读起来像文档」的那一半。 */
.abody { font-size: var(--fs-body); line-height: 1.72; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }

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
  /* MU5：卡片浮起（来源 AionUi 输入区）——此前是平贴的容器，与对话流没有层次差 */
  box-shadow: var(--shadow-fab);
  padding: 10px; display: flex; flex-direction: column; gap: 10px; flex: 0 0 auto;
  position: relative;
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
.cpill, .ctools :deep(.cpill) {
  flex: 0 1 auto; min-width: 0;
  padding: 4px 8px; font-size: var(--fs-micro); gap: 5px;
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
</style>
