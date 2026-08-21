<script setup lang="ts">
/** T 波：会话视图（设计稿 §3）。内容定宽居中 760，回合之间靠间距分隔而非分隔线。
 *  用户消息右对齐浅底块，助手输出**满宽文档式**（不进气泡），工具调用收进 StepGroup。 */
import { computed, nextTick, ref, watch } from 'vue';
import { useChat } from '../stores/chat';
import { parseMarkdown } from '../lib/markdown/parse';
import { fmtHHMM } from '../lib/time/hhmm';
import MarkdownView from '../components/MarkdownView.vue';
import Composer from './Composer.vue';
import StepGroup from './StepGroup.vue';
import UiIcon from './UiIcon.vue';

const chat = useChat();
const scroller = ref<HTMLElement | null>(null);

type Msg = (typeof chat.messages)[number];
interface Turn { id: string; user: Msg | null; blocks: { kind: 'text' | 'steps'; text?: string; steps?: Step[] }[] }
interface Step { name: string; title: string; ok: boolean; output?: string | null }

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
function textOf(m: Msg): string {
  const p = Array.isArray(m.parts) ? m.parts.find((x: { type?: string }) => x?.type === 'text') : undefined;
  return typeof p?.value === 'string' ? p.value : '';
}
/** 仅承载工具结果的合成 user 消息不产生新回合（后端用它回传 toolResult）。 */
function isResultCarrier(m: Msg): boolean {
  return Array.isArray(m.parts) && m.parts.length > 0
    && m.parts.every((p: { type?: string }) => p?.type === 'toolResult');
}
function resultOf(id: string | undefined): { ok: boolean; output?: string } | undefined {
  if (!id) return undefined;
  for (const m of chat.messages) {
    for (const p of (Array.isArray(m.parts) ? m.parts : [])) {
      if (p?.type === 'toolResult' && isRec(p.value) && p.value.toolUseId === id) {
        return { ok: p.value.success !== false, output: typeof p.value.output === 'string' ? p.value.output : undefined };
      }
    }
  }
  return undefined;
}

/** 回合切分 + 助手块内把连续的工具调用聚成一个 StepGroup（相邻文本不合并，保留段落节奏）。 */
const turns = computed<Turn[]>(() => {
  const out: Turn[] = [];
  for (const m of chat.messages) {
    if (m.role === 'user') {
      if (isResultCarrier(m)) continue;
      out.push({ id: m.id, user: m, blocks: [] });
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (!out.length) out.push({ id: m.id, user: null, blocks: [] });
    const t = out[out.length - 1];
    for (const p of (Array.isArray(m.parts) ? m.parts : [])) {
      if (p?.type === 'text' && typeof p.value === 'string' && p.value) {
        t.blocks.push({ kind: 'text', text: p.value });
      } else if (p?.type === 'toolUse' && isRec(p.value)) {
        const id = typeof p.value.toolUseId === 'string' ? p.value.toolUseId : undefined;
        const r = resultOf(id);
        const step: Step = {
          name: String(p.value.name ?? ''),
          title: String((isRec(p.value.input) ? p.value.input.tool_title : '') || p.value.name || ''),
          ok: r ? r.ok : true,
          output: r?.output ?? null,
        };
        const last = t.blocks[t.blocks.length - 1];
        if (last && last.kind === 'steps') last.steps!.push(step);
        else t.blocks.push({ kind: 'steps', steps: [step] });
      }
    }
  }
  return out;
});

const streamNodes = computed(() => (chat.streamingText ? parseMarkdown(chat.streamingText) : null));
const mdOf = (s: string) => parseMarkdown(s);

// 新内容到达贴底（用户上翻时不抢——scrollTop 距底 >120 视为在看历史）
const following = ref(true);
function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
watch(
  () => [chat.messages.length, chat.streamingText, chat.toolCards.length, chat.pendingPerms.length] as const,
  () => { if (following.value) void nextTick(() => { const el = scroller.value; if (el) el.scrollTop = el.scrollHeight; }); },
);
</script>

<template>
  <div class="stage">
    <div ref="scroller" class="scroll" @scroll="onScroll">
      <div class="col">
        <section v-for="t in turns" :key="t.id" class="turn">
          <div v-if="t.user" class="urow">
            <div class="ubub t-chat">{{ textOf(t.user) }}</div>
            <div class="umeta t-aux tnum">{{ typeof t.user.createdAt === 'number' ? fmtHHMM(t.user.createdAt) : '' }}</div>
          </div>
          <div v-for="(b, i) in t.blocks" :key="i" class="ablock">
            <MarkdownView v-if="b.kind === 'text'" class="t-chat" :nodes="mdOf(b.text!)" />
            <StepGroup v-else :steps="b.steps!" />
          </div>
        </section>

        <!-- 实时回合 -->
        <section v-if="chat.running || chat.streamingText" class="turn">
          <div v-if="chat.toolCards.length" class="ablock">
            <StepGroup
              live
              :steps="chat.toolCards.map(c => ({ name: c.name, title: c.title || c.name, ok: c.success !== false, output: c.output ?? null }))"
            />
          </div>
          <div v-if="streamNodes" class="ablock"><MarkdownView class="t-chat" :nodes="streamNodes" /></div>
          <div v-else-if="chat.running" class="waiting t-aux">正在思考…</div>
        </section>

        <div v-if="chat.lastError" class="err t-body">
          <UiIcon name="alert" :size="16" /><span>{{ chat.lastError }}</span>
        </div>
      </div>
    </div>

    <div class="dock">
      <div class="col"><Composer variant="chat" /></div>
    </div>
  </div>
</template>

<style scoped>
.stage { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; }
.col { width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto; }
.scroll .col { padding: var(--sp-7) 0 var(--sp-8); display: flex; flex-direction: column; gap: var(--sp-8); }

/* 回合之间靠间距分隔，不画线——线会把对话切成表格 */
.turn { display: flex; flex-direction: column; gap: var(--sp-5); }

.urow { display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-1); }
.ubub {
  max-width: 82%; padding: var(--sp-4) var(--sp-5);
  background: var(--c-bg-2); color: var(--c-ink);
  /* 右上缺角：来源侧一目了然（AionUi 同形） */
  border-radius: var(--r-m) 4px var(--r-m) var(--r-m);
  white-space: pre-wrap; word-break: break-word;
}
.umeta { color: var(--c-ink-3); }

.ablock { color: var(--c-ink); }
.ablock :deep(.md) { font-size: var(--t-chat-size); line-height: var(--t-chat-lh); }
.waiting { color: var(--c-ink-3); }

.err {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5); border-radius: var(--r-m);
  background: var(--c-err-soft); color: var(--c-err);
}

.dock { flex: 0 0 auto; padding: 0 0 var(--sp-6); background: var(--c-bg); }
</style>
