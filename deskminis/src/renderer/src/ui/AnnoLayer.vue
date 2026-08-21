<script setup lang="ts">
/** V9：文本选区注释 / 引用层。挂在会话视图上，管两件事：
 *  ① 选中助手正文 → 浮条给「引用」「注释」；
 *  ② 已有注释在正文上着色，点开可看引文 / 改笔记 / 删。
 *
 *  **高亮走 CSS Custom Highlight API，零 DOM 改写**：跨节点 <mark> 包裹会改写 DOM，
 *  与 Vue 的视图一致性打架（重渲染后包裹层要么消失要么错位）。用 Range 着色则相反——
 *  重渲染后只需重算 Range。API 缺失时只是没颜色，数据面不受影响。
 *
 *  本地态一律不就地改：add/update/remove 落库后经 chat.annotations.changed 广播回流
 *  刷新 store，高亮随 watch 重算。单一代码路径，多窗口天然一致。 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useChat } from '../stores/chat';
import { matchQuote, resolveOffsets, absoluteOffset, type WalkNode } from '../lib/annotations/anchor';
import UiIcon from './UiIcon.vue';

const props = defineProps<{ host: HTMLElement | null }>();
const emit = defineEmits<{ (e: 'quote', text: string): void }>();
const chat = useChat();

interface Entry { id: string; range: Range; note: string; exact: string }
let ranges: Entry[] = [];
let pending: { messageId: string; exact: string; prefix: string; suffix: string; quoteText: string } | null = null;

const bar = ref<{ x: number; y: number } | null>(null);
const pop = ref<{ id: string; x: number; y: number; exact: string } | null>(null);
const noteText = ref('');
const noteEl = ref<HTMLTextAreaElement | null>(null);

function hideBar(): void { bar.value = null; pending = null; }
function closePop(): void { pop.value = null; }

/** 找选区所在的正文根：注释只锚在助手正文上，工具行/用户气泡不参与。 */
function rootOf(n: Node | null): HTMLElement | null {
  let e: Node | null = n;
  while (e && e.nodeType !== 1) e = e.parentNode;
  return (e as HTMLElement | null)?.closest?.('[data-anno-root]') ?? null;
}

function onMouseUp(ev: MouseEvent): void {
  // mouseup 一刻选区可能还没定稿（双击选词 / 三击选段）：推一帧再读才是最终选区
  requestAnimationFrame(() => {
    const wasPop = pop.value !== null;
    if (wasPop) closePop();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hideBar();
      // 塌缩点击：命中高亮即开气泡；刚关掉的那次点击不立刻复开（点外 = 关的手感）
      if (!wasPop) tryOpenPopAt(ev.clientX, ev.clientY);
      return;
    }
    const r = sel.getRangeAt(0);
    const root = rootOf(r.startContainer);
    // 两端点必须同一正文根：跨消息的选区两个动作语义都不成立
    if (!root || root !== rootOf(r.endContainer)) { hideBar(); return; }
    const mid = root.getAttribute('data-mid') ?? '';
    // 乐观消息 id（local- 前缀）落库后会被正式 id 换掉，此刻建的注释必成孤儿——不给入口
    if (!mid || mid.startsWith('local-')) { hideBar(); return; }
    const raw = root.textContent ?? '';
    const s = absoluteOffset(root as unknown as WalkNode, r.startContainer as unknown as WalkNode, r.startOffset);
    const e = absoluteOffset(root as unknown as WalkNode, r.endContainer as unknown as WalkNode, r.endOffset);
    if (e <= s || !raw.slice(s, e).trim()) { hideBar(); return; }
    pending = {
      messageId: mid,
      exact: raw.slice(s, e),
      prefix: raw.slice(Math.max(0, s - 32), s),
      suffix: raw.slice(e, e + 32),
      quoteText: sel.toString(),
    };
    const rect = r.getBoundingClientRect();
    const box = props.host?.getBoundingClientRect();
    if (!box) { hideBar(); return; }
    // 74 ≈ 浮条半宽：translate(-50%) 锚中点，夹紧到半宽才保证整条不捅出列
    bar.value = {
      x: Math.min(Math.max(rect.left + rect.width / 2 - box.left, 74), box.width - 74),
      y: Math.max(rect.top - box.top - 8, 8),
    };
  });
}

function doQuote(): void {
  const p = pending;
  if (!p) return;
  emit('quote', p.quoteText.split('\n').map(l => '> ' + l).join('\n') + '\n\n');
  hideBar();
  window.getSelection()?.removeAllRanges();
}
function doAnnotate(): void {
  const p = pending;
  hideBar();
  window.getSelection()?.removeAllRanges();
  if (p) void chat.addAnnotation(p.messageId, { exact: p.exact, prefix: p.prefix, suffix: p.suffix });
}

function openPop(en: Entry, cx: number, cy: number): void {
  const box = props.host?.getBoundingClientRect();
  if (!box) return;
  noteText.value = en.note;
  pop.value = {
    id: en.id,
    exact: en.exact.length > 80 ? en.exact.slice(0, 80) + '…' : en.exact,
    // 130 ≈ 气泡半宽（260px 卡）：夹紧到半宽整卡才不出列
    x: Math.min(Math.max(cx - box.left, 130), box.width - 130),
    y: Math.min(cy - box.top + 10, box.height - 40),
  };
  void nextTick(() => noteEl.value?.focus());   // 焦点进笔记框：Esc 关卡的键盘闭环由此成立
}
function saveNote(): void {
  const p = pop.value;
  if (!p) return;
  closePop();
  void chat.updateAnnotationNote(p.id, noteText.value.trim());
}
function delAnno(): void {
  const p = pop.value;
  if (!p) return;
  closePop();
  void chat.removeAnnotation(p.id);
}
/** 塌缩点击的高亮命中判定：与着色同源的 Range 几何，不做任何 DOM 包裹。 */
function tryOpenPopAt(cx: number, cy: number): void {
  if (!ranges.length) return;
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const caret = doc.caretRangeFromPoint?.(cx, cy);
  if (!caret) return;
  const hit = ranges.find(a => {
    try { return a.range.isPointInRange(caret.startContainer, caret.startOffset); } catch { return false; }
  });
  if (hit) openPop(hit, cx, cy);
}

function repaint(): void {
  const HL = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  if (!HL || !registry) return;         // API 缺失只是没颜色，数据面不受影响
  const all: Range[] = [];
  const noted: Range[] = [];
  const entries: Entry[] = [];
  const host = props.host;
  if (host && chat.annotations.length) {
    const byMid = new Map<string, typeof chat.annotations>();
    for (const a of chat.annotations) {
      const list = byMid.get(a.messageId) ?? [];
      list.push(a);
      byMid.set(a.messageId, list);
    }
    for (const [mid, list] of byMid) {
      // mid 是 UUID（hex + 连字符），attr 选择器字面拼接安全
      const roots = host.querySelectorAll(`[data-anno-root][data-mid="${mid}"]`);
      for (const a of list) {
        for (const root of roots) {
          const m = matchQuote(root.textContent ?? '', a);
          if (!m) continue;
          const pts = resolveOffsets(root as unknown as WalkNode, m.start, m.end);
          if (!pts) continue;
          const range = document.createRange();
          range.setStart(pts.start.node as Node, pts.start.offset);
          range.setEnd(pts.end.node as Node, pts.end.offset);
          all.push(range);
          if (a.note) noted.push(range);
          entries.push({ id: a.id, range, note: a.note, exact: a.exact });
          break;                        // 每条注释锚进首个命中的正文根
        }
      }
    }
  }
  ranges = entries;
  // 气泡指向的注释被删（本窗或别窗）：随重算即关，不留悬空卡
  if (pop.value && !entries.some(en => en.id === pop.value!.id)) closePop();
  registry.set('dm-anno', new HL(...all));
  registry.set('dm-anno-noted', new HL(...noted));
}

// 重算只由消息 / 注释 / 会话切换触发（输入框键入零重算），nextTick + rAF 合帧
let queued = false;
watch(() => [chat.messages, chat.annotations, chat.activeId] as const, () => {
  if (queued) return;
  queued = true;
  void nextTick(() => requestAnimationFrame(() => { queued = false; repaint(); }));
}, { immediate: true });

// 选区塌缩（点击别处 / Esc）即收浮条
function onSelChange(): void {
  const sel = window.getSelection();
  if ((!sel || sel.isCollapsed) && bar.value) hideBar();
}
document.addEventListener('selectionchange', onSelChange);
onBeforeUnmount(() => { document.removeEventListener('selectionchange', onSelChange); });

defineExpose({ onMouseUp });
</script>

<template>
  <div class="anno">
    <div v-if="bar" class="abar" :style="{ left: `${bar.x}px`, top: `${bar.y}px` }">
      <button type="button" @mousedown.prevent="doQuote"><UiIcon name="chat" :size="13" />引用</button>
      <button type="button" @mousedown.prevent="doAnnotate"><UiIcon name="pencil" :size="13" />注释</button>
    </div>

    <div v-if="pop" class="apop" :style="{ left: `${pop.x}px`, top: `${pop.y}px` }" @keydown.esc="closePop">
      <p class="aq t-aux">「{{ pop.exact }}」</p>
      <textarea ref="noteEl" v-model="noteText" class="an" rows="3" placeholder="写点什么（留空也行，只标记不写字）"></textarea>
      <div class="aacts">
        <button class="f-btn primary" type="button" @click="saveNote">保存</button>
        <button class="f-btn ghost" type="button" @click="closePop">取消</button>
        <span class="grow"></span>
        <button class="f-btn danger" type="button" @click="delAnno"><UiIcon name="trash" :size="13" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.anno { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
.abar, .apop { position: absolute; pointer-events: auto; }

.abar {
  transform: translate(-50%, -100%);
  display: flex; gap: 2px; padding: 3px;
  background: var(--c-ink); border-radius: var(--r-s); box-shadow: var(--sh-pop);
}
.abar button {
  display: inline-flex; align-items: center; gap: var(--sp-2);
  height: var(--h-mini); padding: 0 var(--sp-4); border-radius: 6px; cursor: pointer;
  background: none; color: var(--c-bg); font-family: inherit; font-size: var(--t-aux-size);
}
.abar button:hover { background: var(--c-ink-2); }

.apop {
  transform: translateX(-50%);
  width: 260px; display: flex; flex-direction: column; gap: var(--sp-3);
  padding: var(--sp-4); background: var(--c-bg);
  border: 1px solid var(--c-line); border-radius: var(--r-m); box-shadow: var(--sh-pop);
}
.aq {
  margin: 0; color: var(--c-ink-3);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.an {
  width: 100%; resize: vertical; font-family: inherit;
  font-size: var(--t-item-size); line-height: 1.6; color: var(--c-ink);
  background: var(--c-bg-1); border-radius: var(--r-s); padding: var(--sp-3);
}
.an:focus { outline: none; box-shadow: 0 0 0 1px var(--c-brand); }
.aacts { display: flex; align-items: center; gap: var(--sp-2); }
.grow { flex: 1; }
</style>

<style>
/* 注释高亮。::highlight 是**文档级伪元素**：scoped 会给选择器缀 [data-v-*]
   使其永不匹配，这一块必须非 scoped（旧实现踩过，照抄结论）。
   着色只叠主色低透明度底，正文对比度由原文字色保证；
   有笔记的一档加深并带虚线下划线作「可点」提示。 */
::highlight(dm-anno) { background-color: color-mix(in srgb, var(--c-brand) 20%, transparent); }
::highlight(dm-anno-noted) {
  background-color: color-mix(in srgb, var(--c-brand) 30%, transparent);
  text-decoration: underline dotted;
}
</style>
