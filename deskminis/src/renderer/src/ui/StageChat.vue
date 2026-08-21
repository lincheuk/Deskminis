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
import PermCard from './PermCard.vue';
import EventNotes from './EventNotes.vue';
import ThinkBlock from './ThinkBlock.vue';
import UiIcon from './UiIcon.vue';

const props = withDefaults(defineProps<{ narrow?: boolean }>(), { narrow: false });
const chat = useChat();
const scroller = ref<HTMLElement | null>(null);

type Msg = (typeof chat.messages)[number];
interface Turn { id: string; user: Msg | null; blocks: { kind: 'text' | 'steps' | 'think'; text?: string; steps?: Step[] }[] }
interface Step { name: string; title: string; ok: boolean; output?: string | null }

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
function textOf(m: Msg): string {
  const p = Array.isArray(m.parts) ? m.parts.find((x: { type?: string }) => x?.type === 'text') : undefined;
  return typeof p?.value === 'string' ? p.value : '';
}
/** V6：消息里的附件（mediaRef part）。只取元数据渲染 chip——
 *  历史里不铺原图（一屏几张就把对话挤没了），要看点开预览。
 *  不渲染它的话，带图的那条消息在历史里会退化成一条空气泡。 */
function attsOf(m: Msg): { path: string; name: string }[] {
  if (!Array.isArray(m.parts)) return [];
  const out: { path: string; name: string }[] = [];
  for (const p of m.parts) {
    if (p?.type !== 'mediaRef' || !isRec(p.value)) continue;
    const rel = p.value.relativePath;
    if (typeof rel !== 'string' || !rel) continue;
    const name = typeof p.value.originalFileName === 'string' && p.value.originalFileName
      ? p.value.originalFileName : (rel.split('/').pop() ?? rel);
    out.push({ path: rel, name });
  }
  return out;
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
    // V3：落库的推理内容置于本条正文之前——它是「怎么想的」，读在结论前面才有用
    if (typeof m.reasoningContent === 'string' && m.reasoningContent) {
      t.blocks.push({ kind: 'think', text: m.reasoningContent });
    }
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
/** 贴底：nextTick 之后 Markdown 子树往往还没完成布局，此刻量到的 scrollHeight 是旧值——
 *  实测表现为「发完消息助手回复停在视口外」。故再等一帧（双 rAF）确认布局提交后再滚。 */
function stickBottom(): void {
  if (!following.value) return;
  void nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  })));
}
watch(
  () => [chat.messages.length, chat.streamingText, chat.toolCards.length, chat.pendingPerms.length] as const,
  stickBottom,
);
// 分栏开合会改变列宽 → 内容重排、总高改变。不重新贴底的话，刚才还在视野里的
// 助手回复会被顶出视口（T4 实拍逮到）。
watch(() => props.narrow, stickBottom);
</script>

<template>
  <div class="stage" :class="{ narrow: props.narrow }">
    <div ref="scroller" class="scroll" @scroll="onScroll">
      <div class="col">
        <section v-for="t in turns" :key="t.id" class="turn">
          <div v-if="t.user" class="urow">
            <div v-if="attsOf(t.user).length" class="uatts">
              <button
                v-for="a in attsOf(t.user)" :key="a.path" type="button" class="uatt"
                :title="a.path" @click="chat.pendingFilePreview = a.path"
              >
                <UiIcon name="file" :size="13" /><span>{{ a.name }}</span>
              </button>
            </div>
            <div v-if="textOf(t.user)" class="ubub t-chat">{{ textOf(t.user) }}</div>
            <div class="umeta t-aux tnum">{{ typeof t.user.createdAt === 'number' ? fmtHHMM(t.user.createdAt) : '' }}</div>
          </div>
          <div v-for="(b, i) in t.blocks" :key="i" class="ablock">
            <MarkdownView v-if="b.kind === 'text'" class="t-chat" :nodes="mdOf(b.text!)" />
            <ThinkBlock v-else-if="b.kind === 'think'" :text="b.text!" />
            <StepGroup v-else :steps="b.steps!" />
          </div>
        </section>

        <!-- 实时回合 -->
        <section v-if="chat.running || chat.streamingText || chat.streamingThinking" class="turn">
          <div v-if="chat.streamingThinking" class="ablock">
            <ThinkBlock live :text="chat.streamingThinking" />
          </div>
          <div v-if="chat.toolCards.length" class="ablock">
            <StepGroup
              live
              :steps="chat.toolCards.map(c => ({ name: c.name, title: c.title || c.name, ok: c.success !== false, output: c.output ?? null }))"
            />
          </div>
          <div v-if="streamNodes" class="ablock"><MarkdownView class="t-chat" :nodes="streamNodes" /></div>
          <div v-else-if="chat.running" class="waiting t-aux">正在思考…</div>
        </section>

        <!-- V2：事件条（降级/压缩/卸载/修剪/重试/出错/同步）——出错这条带重试入口 -->
        <EventNotes />

        <!-- V1：权限卡。**没有它，agent 一请求权限就无声卡死到超时**——
             T 波换壳时这块被落在旧组件树里，是当时最严重的一处漏接。 -->
        <div v-for="p in chat.pendingPerms" :key="p.requestId" class="ablock">
          <PermCard :perm="p" />
        </div>

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
/* 分栏态：对话退居左侧一条，不再定宽居中——420 列里再留 24 边距就没内容位置了 */
.stage.narrow { border-right: 1px solid var(--c-line); }
.stage.narrow .col { width: 100%; padding-left: var(--sp-5); padding-right: var(--sp-5); }
.stage.narrow .ubub { max-width: 92%; }
.scroll .col { padding: var(--sp-7) 0 var(--sp-8); display: flex; flex-direction: column; gap: var(--sp-8); }

/* 回合之间靠间距分隔，不画线——线会把对话切成表格 */
.turn { display: flex; flex-direction: column; gap: var(--sp-5); }

.urow { display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-1); }
.ubub {
  max-width: 82%; padding: var(--sp-4) var(--sp-5);
  /* 浅蓝紫底（AionUi --message-user-bg）：用户消息要一眼分得出来源，灰底混在界面里 */
  background: var(--c-brand-soft); color: var(--c-ink);
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

/* V6 附件 chip：历史里只显示文件名，点开走预览区（原图铺开会把对话挤没） */
.uatts { display: flex; gap: var(--sp-2); flex-wrap: wrap; justify-content: flex-end; margin-bottom: var(--sp-2); }
.uatt {
  display: inline-flex; align-items: center; gap: var(--sp-2); max-width: 220px;
  height: var(--h-mini); padding: 0 var(--sp-3); border-radius: var(--r-s); cursor: pointer;
  background: var(--c-bg-2); color: var(--c-ink-2); font-family: inherit; font-size: var(--t-aux-size);
}
.uatt:hover { background: var(--c-bg-3); color: var(--c-ink); }
.uatt span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
