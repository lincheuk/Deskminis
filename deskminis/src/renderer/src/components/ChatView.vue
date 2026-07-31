<script setup lang="ts">
/** 中栏 · 对话流（设计 §4.2）——不对称消息（助手无气泡、用户 12% 填充气泡）、
 *  工具胶囊、内联权限卡、错误横幅、浮动输入区（三胶囊 + 单色圆形发送/停止键）。
 *  渲染对 parts 全程空值兜底：parts.ts 允许 value:null 的 part，绝不解引用崩溃。 */
import { ref, computed, nextTick, watch } from 'vue';
import { useChat } from '../stores/chat';
import ToolPill from './ToolPill.vue';
import PermissionCard from './PermissionCard.vue';
import EmptyState from './EmptyState.vue';
import ModelPicker from './ModelPicker.vue';
import PermissionPicker from './PermissionPicker.vue';
import Icon from './Icon.vue';
import MarkdownView from './MarkdownView.vue';
import FadeText from './FadeText.vue';
import { MarkdownCache } from '../lib/markdown/cache';
import { stablePrefixEnd } from '../lib/markdown/prefix';
import { shouldFollow } from '../lib/scroll/follow';
import type { MdNode } from '../lib/markdown/parse';

const chat = useChat();
const input = ref('');
const streamEl = ref<HTMLElement | null>(null);

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
// 工具胶囊摘要：优先 input 里的 tool_title，回落 description / name
function pillTitle(v: unknown): string {
  if (!isRec(v)) return '工具';
  if (typeof v.input === 'string') {
    try { const o = JSON.parse(v.input); if (o && typeof o.tool_title === 'string' && o.tool_title) return o.tool_title; } catch { /* ignore */ }
  }
  if (typeof v.description === 'string' && v.description) return v.description;
  return typeof v.name === 'string' ? v.name : '工具';
}

const hasLive = computed(() =>
  chat.running || !!chat.streamingText || chat.toolCards.length > 0 || chat.pendingPerms.length > 0 || !!chat.retryNote,
);
const isEmpty = computed(() => chat.messages.length === 0 && !hasLive.value && chat.eventNotes.length === 0);

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
/** eventNotes 的内联条图标——严格复用 Icon.vue 已有路径，不新增。
 *  （Icon 内没有 compress/download，回落成 info：蓝 i 圈仍可读，语义不丢。） */
function eventIcon(kind: string): 'alert' | 'info' {
  if (kind === 'fallback') return 'alert';
  return 'info';
}

const canSend = computed(() => input.value.trim().length > 0 && !chat.running);

async function send(): Promise<void> {
  const t = input.value.trim();
  if (!t || chat.running) return;
  // 没有选中会话就先建一个再发（避免「按了没反应」）
  if (!chat.activeId) await chat.newSession();
  input.value = '';
  await chat.send(t);
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
      <EmptyState v-if="isEmpty" />
      <template v-else>
        <template v-for="m in chat.messages" :key="m.id">
          <!-- 用户消息（跳过仅承载工具结果的合成消息） -->
          <div v-if="m.role === 'user' && !isResultCarrier(m)" class="msg-u">
            <div>{{ userText(m) }}</div>
          </div>
          <!-- 助手消息：无气泡，图标 + 名称 + 内容块 -->
          <div v-else-if="m.role === 'assistant'" class="msg-a">
            <div class="ahead"><div class="aicon"></div><div class="aname">DeskMinis</div></div>
            <div class="abody">
              <template v-for="(p, i) in (Array.isArray(m.parts) ? m.parts : [])" :key="i">
                <MarkdownView v-if="p && p.type === 'text' && typeof p.value === 'string' && p.value" :nodes="mdOf(`${m.id}:${i}`)" />
                <ToolPill
                  v-else-if="p && p.type === 'toolUse' && p.value"
                  :name="isRec(p.value) ? p.value.name : ''"
                  :title="pillTitle(p.value)"
                  :input="isRec(p.value) && typeof p.value.input === 'string' ? p.value.input : null"
                  :output="resultOf(isRec(p.value) ? p.value.toolUseId : undefined)?.output ?? null"
                  :success="resultOf(isRec(p.value) ? p.value.toolUseId : undefined)?.success"
                  :status="resultOf(isRec(p.value) ? p.value.toolUseId : undefined)?.status"
                />
              </template>
            </div>
          </div>
        </template>

        <!-- 实时助手块：流式文本 + 执行中胶囊 + 权限卡 + 重试提示 -->
        <div v-if="hasLive" class="msg-a">
          <div class="ahead"><div class="aicon"></div><div class="aname">DeskMinis</div></div>
          <div class="abody">
            <MarkdownView v-if="streamStable.length" :nodes="streamStable" />
            <FadeText v-if="streamTailText" :text="streamTailText" />
            <ToolPill
              v-for="c in chat.toolCards" :key="c.toolUseId"
              :name="c.name" :title="c.title || c.name"
              :output="c.output ?? null" :success="c.success"
              :running="c.success === undefined"
            />
            <PermissionCard v-for="p in chat.pendingPerms" :key="p.requestId" :perm="p" />
            <div v-if="chat.retryNote" class="retry"><Icon name="clock" :size="14" /><span>{{ chat.retryNote }}</span></div>
            <div v-if="chat.running && !chat.streamingText && !chat.toolCards.length && !chat.pendingPerms.length && !chat.retryNote" class="dots"><i></i><i></i><i></i></div>
          </div>
        </div>

        <!-- #10：对话流内联事件条（M2b 降级 / M2a 压缩 / M2a 卸载）——store 已保证最多 10 条，直接 v-for 不截断。
             kind 配色与任务面板卡保持一致（橙/蓝/紫），颜色走 tokens.css 变量，不写死。 -->
        <div
          v-for="note in chat.eventNotes" :key="note.ts + note.kind + (note.detail || '')"
          class="evnote" :class="note.kind"
        ><Icon :name="eventIcon(note.kind)" :size="14" /><span>{{ note.detail ?? '' }}</span></div>
      </template>
    </div>

    <button
      v-if="!following" class="back-bottom" type="button"
      title="回到底部" aria-label="回到底部" @click="backToBottom"
    ><Icon name="chevron-down" :size="16" /></button>

    <div v-if="chat.lastError" class="errbar">
      <Icon name="alert" :size="16" />
      <span class="etext">{{ chat.lastError }}</span>
      <button class="eclose" @click="chat.lastError = ''"><Icon name="x" :size="14" /></button>
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
      <textarea
        v-model="input" class="field" rows="1"
        placeholder="让 DeskMinis 做点什么…"
        @keydown.enter.exact.prevent="onEnterKey"
        @keydown.up="onSlashNav(-1, $event)"
        @keydown.down="onSlashNav(1, $event)"
        @keydown.tab="onSlashTab"
        @keydown.esc="slashOpen = false"
      ></textarea>
      <div class="ctools">
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
.stream { flex: 1; overflow: auto; padding: 12px 0; }

/* 解除跟随后右下浮出的「回到底部」小圆钮（设计 §2.4） */
.back-bottom {
  position: absolute; right: 20px; bottom: 96px; z-index: 20;
  width: 32px; height: 32px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--material-tint); backdrop-filter: var(--material-thin);
  border: .5px solid var(--separator); color: var(--label-secondary);
  cursor: pointer; box-shadow: 0 4px 16px rgba(0, 0, 0, .14);
}
.back-bottom:hover { color: var(--label); background: var(--fill-tertiary); }

/* 用户消息：右对齐 12% 填充气泡，左留空槽 */
.msg-u { display: flex; justify-content: flex-end; padding: 5px 16px 5px 76px; }
.msg-u > div {
  background: var(--fill-tertiary); border-radius: var(--r-bubble); padding: 10px 14px;
  font-size: 16.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-width: 100%;
}
/* 助手消息：无气泡 */
.msg-a { padding: 5px 16px; }
.ahead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.aicon { width: 18px; height: 18px; border-radius: 5px; background: var(--assistant-gradient); flex: 0 0 auto; }
.aname { font-size: 17px; font-weight: 600; }
.abody { font-size: 16.5px; line-height: 1.55; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }

.retry { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--orange); }

/* #10：事件内联小条——与 .retry 同族（小字号、行内、图标+detail）；颜色按 kind 区分，走 tokens.css 变量不写死 */
.evnote {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; margin: 3px 0;
  border-radius: var(--r-md); font-size: 12.5px; line-height: 1.45;
  border: .5px solid var(--separator);
  background: var(--grouped-bg-secondary);
  color: var(--label-secondary);
  max-width: 100%;
}
.evnote :deep(svg) { flex: 0 0 auto; margin-top: -1px; }
.evnote > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evnote.fallback  { color: var(--orange); background: color-mix(in srgb, var(--orange) 10%, transparent); border-color: color-mix(in srgb, var(--orange) 30%, transparent); }
.evnote.compacted { color: var(--link, --blue); background: color-mix(in srgb, var(--link, --blue) 10%, transparent); border-color: color-mix(in srgb, var(--link, --blue) 30%, transparent); }
.evnote.offloaded { color: var(--purple); background: color-mix(in srgb, var(--purple) 10%, transparent); border-color: color-mix(in srgb, var(--purple) 30%, transparent); }
.evnote.fallback :deep(svg)  { stroke: var(--orange); }
.evnote.compacted :deep(svg) { stroke: var(--link, --blue); }
.evnote.offloaded :deep(svg) { stroke: var(--purple); }
.dots { display: inline-flex; gap: 4px; padding: 4px 0; }
.dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--label-tertiary); animation: jump 1s infinite ease-in-out; }
.dots i:nth-child(2) { animation-delay: .15s; }
.dots i:nth-child(3) { animation-delay: .3s; }
@keyframes jump { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-3px); opacity: 1; } }

/* 错误横幅——循环报错必须看得见 */
.errbar {
  display: flex; align-items: flex-start; gap: 8px; padding: 10px 16px; margin: 0 16px 8px;
  border-radius: var(--r-md); background: color-mix(in srgb, var(--red) 12%, transparent);
  border: .5px solid color-mix(in srgb, var(--red) 30%, transparent); color: var(--red); font-size: 13px;
}
.errbar :deep(svg) { stroke: var(--red); flex: 0 0 auto; margin-top: 1px; }
.etext { flex: 1; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.eclose { background: none; border: none; color: var(--red); cursor: pointer; padding: 0; display: inline-flex; flex: 0 0 auto; }

/* 输入区：浮动容器 + 材质 */
.composer {
  margin: 0 16px 16px; border-radius: var(--r-input); background: var(--material-tint);
  backdrop-filter: var(--material-thin); border: .5px solid var(--separator);
  padding: 10px; display: flex; flex-direction: column; gap: 10px; flex: 0 0 auto;
  position: relative;
}
.slashmenu {
  position: absolute; left: 10px; right: 10px; bottom: calc(100% + 6px); z-index: 10;
  display: flex; flex-direction: column; padding: 6px; gap: 2px; max-height: 260px; overflow: auto;
  background: var(--material-tint); backdrop-filter: var(--material-thin);
  border: .5px solid var(--separator); border-radius: var(--r-md);
  box-shadow: 0 8px 28px rgba(0, 0, 0, .18);
}
.slashitem {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: none; background: none;
  border-radius: var(--r-control); cursor: pointer; color: var(--label); font-family: var(--font-ui);
  font-size: 14px; text-align: left;
}
.slashitem.on { background: var(--fill-tertiary); }
.slashitem :deep(svg) { stroke: var(--label-secondary); flex: 0 0 auto; }
.sname { font-weight: 600; flex: 0 0 auto; }
.sdesc { color: var(--label-tertiary); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.field {
  background: var(--bg-tertiary); border: 1px solid var(--separator); border-radius: var(--r-control);
  padding: 10px 12px; font-size: 16.5px; color: var(--label); font-family: var(--font-ui);
  min-height: 44px; max-height: 200px; resize: none; line-height: 1.5; outline: none; width: 100%;
}
.field::placeholder { color: var(--label-tertiary); }
.ctools { display: flex; align-items: center; gap: 8px; }
.cpill {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: var(--r-pill);
  border: .5px solid var(--separator); background: var(--grouped-bg-secondary);
  font-size: 13px; color: var(--label-secondary);
}
.cpill.static { cursor: default; }
.send {
  margin-left: auto; width: 34px; height: 34px; border-radius: 50%; background: var(--label);
  display: flex; align-items: center; justify-content: center; flex: 0 0 auto; border: none; cursor: pointer; padding: 0;
}
.send :deep(svg) { stroke: var(--bg); }
.send:disabled { background: var(--label-quaternary); cursor: default; }
.send.stop :deep(svg) { stroke: var(--bg); fill: var(--bg); }
</style>
