<script setup lang="ts">
/** F08：审阅面板的纯展示件——一次改动的前后对比、能不能恢复与为什么、恢复与另存的入口和结果。
 *  没有内部状态、不碰 rpc 与 store；取数、确认态、发请求在外壳 ChangeReview.vue。
 *  冲突时没有「仍然覆盖」：只提供另存改动前的版本。 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { readDiffLayout, writeDiffLayout, type DiffLayout } from '../lib/diff/view';
import type { ChangeDiff, DiffSide, RestoreReport, RestoreVerdict } from '../../../shared/checkpoint';
import { CHECKPOINT_SCOPE_NOTE } from '../../../shared/checkpoint';
import { formatBytes, lineDiff, noLineChangeNote } from '../lib/changes/model';
import UiDiff from './UiDiff.vue';

const props = defineProps<{
  diff: ChangeDiff | null;
  verdict: RestoreVerdict | null;
  /** 预检结论的那句话。 */
  message: string;
  /** 之后的改动里属于本会话的（可以一起恢复）与属于别的会话的（要到那个会话去恢复）。 */
  laterHere: string[];
  laterElsewhere: { sessionId: string; count: number }[];
  sessionTitles: Record<string, string>;
  /** 确认态：第一次点恢复只进确认态，第二次才真的发请求。 */
  confirming: 'single' | 'with-later' | null;
  result: RestoreReport | null;
  /** 另存成功后的路径。 */
  saved: string;
  busy: boolean;
  /** 取对比与预检的错误。 */
  error: string;
  /** 恢复 / 另存这次操作本身的错误（整次调用被拒）。不随重取而消失。 */
  actionError?: string;
}>();
const emit = defineEmits<{
  (e: 'restore'): void;
  (e: 'restore-with-later'): void;
  (e: 'save-copy', which: 'before' | 'after'): void;
  (e: 'goto-session', sessionId: string): void;
  /** 在预览里打开这个文件现在的样子（工作区相对路径）。 */
  (e: 'open-current', path: string): void;
  (e: 'close'): void;
}>();

const panel = ref<HTMLElement | null>(null);
const panelWidth = ref(0);
const layout = ref(readDiffLayout());
const narrow = computed(() => panelWidth.value < 560);
const split = computed(() => !narrow.value && layout.value === 'split');
function chooseLayout(value: DiffLayout): void {
  if (narrow.value) return;
  layout.value = value;
  writeDiffLayout(value);
}
let panelObserver: ResizeObserver | undefined;
watch(panel, el => {
  panelObserver?.disconnect();
  if (!el) return;
  panelWidth.value = el.getBoundingClientRect().width;
  if (typeof ResizeObserver === 'undefined') return;
  panelObserver = new ResizeObserver(() => { panelWidth.value = el.getBoundingClientRect().width; });
  panelObserver.observe(el);
}, { flush: 'post' });
onBeforeUnmount(() => panelObserver?.disconnect());

const change = computed(() => props.diff?.change ?? null);
const hasText = (s: DiffSide | undefined): boolean => s !== undefined && (s.form === 'text' || s.form === 'office-text') && s.text !== undefined;

/** 右侧拿什么比：「写入后」的内容拿得到就用它；拿不到（文件已被改过、检查点里也没有）退为当前文件，并写明。 */
const right = computed<{ side: DiffSide; isCurrent: boolean } | null>(() => {
  const d = props.diff;
  if (!d) return null;
  if (d.after.source !== 'unavailable') return { side: d.after, isCurrent: false };
  return { side: d.current, isCurrent: true };
});
const office = computed(() => props.diff?.before.form === 'office-text' || right.value?.side.form === 'office-text');
const truncated = computed(() => props.diff?.before.truncated === true || right.value?.side.truncated === true);

/** 两侧都拿得到文本（新建文件的「改动前」是空）才算行差分。 */
const cmp = computed(() => {
  const d = props.diff; const r = right.value;
  if (!d || !r) return null;
  const beforeOk = !d.before.exists || hasText(d.before);
  const rightOk = !r.side.exists || hasText(r.side);
  if (!beforeOk || !rightOk) return null;
  if (d.before.source === 'unavailable') return null;
  return lineDiff(d.before.text ?? '', r.side.text ?? '', { oldTruncated: d.before.truncated, newTruncated: r.side.truncated });
});
const binary = computed(() => {
  const d = props.diff; const r = right.value;
  return !!d && !!r && cmp.value === null && (d.before.form === 'binary' || r.side.form === 'binary');
});
const sideText = (s: DiffSide): string => (s.exists ? `${formatBytes(s.size)} · ${s.hash ? s.hash.slice(0, 12) : '无哈希'}` : '不存在');
/** 逐行比没有任何增删时的那一句（只改了行尾、Office 的文字没变、截断等）：不挂空差分，照实说差在哪、两侧各多大。 */
const noChange = computed(() => {
  const d = props.diff; const r = right.value; const c = cmp.value;
  if (!d || !r || !c || c.tooLarge || c.add + c.del > 0) return '';
  const rightLabel = r.isCurrent ? '当前' : '改动后';
  const note = noLineChangeNote({
    beforeExists: d.before.exists, rightExists: r.side.exists,
    sameHash: d.before.hash !== undefined && d.before.hash === r.side.hash,
    eolChanged: c.eolChanged, office: office.value === true, truncated: truncated.value, rightLabel,
  });
  // 两侧都在时带上各自的大小：文字一样，大小不一样，差的就是那几个看不见的字节
  if (!d.before.exists || !r.side.exists) return note;
  return `${note}改动前 ${formatBytes(d.before.size)}，${rightLabel} ${formatBytes(r.side.size)}。`;
});
/** 「查看当前文件」给预览的路径：文件在会话工作区内（displayPath 是相对路径）且现在还在，才有这个入口——预览只读工作区内的文件。 */
const previewPath = computed(() => {
  const c = change.value;
  return c && c.displayPath !== c.path && props.diff?.currentIs !== 'missing' ? c.displayPath : null;
});

const ready = computed(() => props.verdict?.kind === 'ready');
const superseded = computed(() => props.verdict?.kind === 'conflict' && props.verdict.reason === 'superseded');
const actionText = computed(() => (props.verdict?.kind === 'ready' && props.verdict.action === 'delete' ? '将删除' : '将覆盖'));
const done = computed(() => props.result?.items ?? []);
/** 那个会话还在不在会话列表里（sessionTitles 的键就是列表里的会话）。不在的是已删除的：F11B 之后，之后的改动可以属于
 *  「已在其他设备删除、本机留着副本」的会话——它的检查点记录留着，会话本身不显示。对它不给跳转：打开它就是把一个已删除的
 *  会话当成活的显示出来（提问、恢复都会被引擎拒绝）。要先在「设备」页恢复那个会话。 */
const listed = (sid: string): boolean => Object.prototype.hasOwnProperty.call(props.sessionTitles, sid);
const titleOf = (sid: string): string => props.sessionTitles[sid] || '未命名的会话';
</script>

<template>
  <section ref="panel" class="rv">
    <header class="rh">
      <div class="rhmain">
        <span v-if="change" class="tag" :class="change.kind">{{ change.kind === 'create' ? '新建' : '修改' }}</span>
        <span class="rpath" :title="change?.path">{{ change?.displayPath ?? '改动' }}</span>
        <span v-if="change" class="meta t-aux">{{ change.toolName }}</span>
      </div>
      <!-- 这里只有行差分（Office 是提取出的文字）：渲染后的文档、表格要到预览里看 -->
      <button v-if="previewPath" type="button" class="btn" @click="emit('open-current', previewPath)">查看当前文件</button>
      <button type="button" class="btn" @click="emit('close')">关闭</button>
    </header>

    <div v-if="props.error" class="err">{{ props.error }}</div>
    <div v-if="props.actionError" class="err">{{ props.actionError }}</div>
    <div v-if="props.message" class="status" :class="props.verdict?.kind">{{ props.message }}</div>

    <div class="body">
      <div v-if="!props.diff && !props.error" class="hint">正在读取这次改动…</div>
      <template v-else-if="props.diff && right">
        <div class="sides t-aux">
          <span>{{ right.isCurrent ? '改动前 ↔ 当前文件' : '改动前 ↔ 改动后' }}</span>
          <span v-if="right.isCurrent" class="warn">当前文件已不是这次改动写入的内容</span>
          <span v-if="office">按提取出的文字对比，不含版式</span>
          <span v-if="truncated">只显示前 256 KB</span>
        </div>
        <div v-if="noChange" class="hint">{{ noChange }}</div>
        <template v-else-if="cmp && !cmp.tooLarge">
          <div class="count t-aux tnum">
            <span>增 {{ cmp.add }} 行 · 删 {{ cmp.del }} 行</span>
            <template v-if="cmp.eolChanged > 0"> · 另有 {{ cmp.eolChanged }} 行文字相同、只是行尾符或文件末尾的换行不同（没有列在下面）</template>
            <span class="layouts" role="group" aria-label="差分布局">
              <button v-for="choice in (['unified', 'split'] as const)" :key="choice" type="button" class="btn"
                :aria-pressed="(split ? 'split' : 'unified') === choice" :disabled="narrow"
                :title="narrow ? '面板太窄：拖宽分隔条或放大窗口' : undefined" @click="chooseLayout(choice)">{{ choice === 'unified' ? '统一' : '并排' }}</button>
            </span>
          </div>
          <UiDiff tall line-numbers :split="split" :lines="cmp.lines" :add-count="cmp.add" :del-count="cmp.del" :path="change?.displayPath" />
        </template>
        <div v-else-if="cmp && cmp.tooLarge" class="hint">
          文件过大，未做逐行对比（改动前 {{ cmp.oldLines }} 行 · {{ formatBytes(props.diff.before.size) }}，{{ right.isCurrent ? '当前' : '改动后' }} {{ cmp.newLines }} 行 · {{ formatBytes(right.side.size) }}）
        </div>
        <div v-else-if="binary" class="hint">
          二进制文件，不显示正文。改动前：{{ sideText(props.diff.before) }}；{{ right.isCurrent ? '当前' : '改动后' }}：{{ sideText(right.side) }}
        </div>
        <div v-else class="hint">
          这一侧的内容已不在检查点里，无法对比。改动前：{{ sideText(props.diff.before) }}；{{ right.isCurrent ? '当前' : '改动后' }}：{{ sideText(right.side) }}
        </div>
      </template>
    </div>

    <div class="acts">
      <div v-if="props.confirming === 'single'" class="confirm">{{ actionText }} {{ change?.path }}。再点一次确认。</div>
      <div v-if="props.confirming === 'with-later'" class="confirm">将把这个文件连同之后的 {{ props.laterHere.length }} 次改动一起恢复到这次改动之前。再点一次确认。</div>
      <div class="row">
        <button type="button" class="btn primary" :disabled="!ready || props.busy" @click="emit('restore')">
          {{ props.confirming === 'single' ? '确认恢复' : '恢复到这次改动之前' }}
        </button>
        <button
          v-if="superseded && props.laterElsewhere.length === 0 && props.laterHere.length > 0" type="button" class="btn"
          :disabled="props.busy" @click="emit('restore-with-later')"
        >{{ props.confirming === 'with-later' ? '确认一起恢复' : `连同之后的 ${props.laterHere.length} 次改动一起恢复` }}</button>
        <button type="button" class="btn" :disabled="!change?.beforeStored || props.busy" @click="emit('save-copy', 'before')">另存改动前的版本</button>
        <button v-if="change?.afterStored" type="button" class="btn" :disabled="props.busy" @click="emit('save-copy', 'after')">另存改动后的版本</button>
      </div>
      <div v-if="superseded && props.laterElsewhere.length > 0" class="else">
        <span>这个文件之后被另一个会话改过 {{ props.laterElsewhere.reduce((n, x) => n + x.count, 0) }} 次，需要先到那个会话恢复：</span>
        <template v-for="s in props.laterElsewhere" :key="s.sessionId">
          <button v-if="listed(s.sessionId)" type="button" class="link" @click="emit('goto-session', s.sessionId)">{{ titleOf(s.sessionId) }}</button>
          <span v-else class="gone">已不在列表里的会话（多半已在其他设备删除、本机留着副本：先在「设备」页恢复它，再到那里恢复这些改动）</span>
        </template>
        <span v-if="props.laterHere.length > 0">本会话之后还有 {{ props.laterHere.length }} 次改动。</span>
      </div>
      <div v-for="i in done" :key="i.id" class="res" :class="i.outcome">{{ i.message }}</div>
      <div v-if="done.some(i => i.outcome === 'restored' || i.outcome === 'deleted')" class="tell t-aux">模型不会自动得知这次恢复，继续对话时请告诉它。</div>
      <div v-if="props.saved" class="res ok">已另存到 {{ props.saved }}</div>
    </div>

    <footer class="foot t-aux">{{ CHECKPOINT_SCOPE_NOTE }}</footer>
  </section>
</template>

<style scoped>
.rv { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--c-bg); border-left: 1px solid var(--c-line); }
.rh { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--c-line); }
.rhmain { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2); }
.tag { flex: 0 0 auto; padding: 0 var(--sp-2); border-radius: var(--r-s); background: var(--c-bg-2); color: var(--c-ink-3); }
.tag.create { color: var(--c-ok); }
.rpath { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--f-mono); color: var(--c-ink); }
.meta { flex: 0 0 auto; color: var(--c-ink-3); }
.status { padding: var(--sp-2) var(--sp-4); color: var(--c-ink-2); background: var(--c-bg-1); border-bottom: 1px solid var(--c-line); white-space: normal; word-break: break-word; }
.status.conflict, .status.unavailable { color: var(--c-err); }
.err { padding: var(--sp-2) var(--sp-4); color: var(--c-err); word-break: break-word; }
.body { flex: 1; min-height: 0; overflow: auto; padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); }
.sides { display: flex; gap: var(--sp-3); flex-wrap: wrap; color: var(--c-ink-3); }
.sides .warn { color: var(--c-err); }
.count { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; color: var(--c-ink-3); }
.layouts { display: inline-flex; gap: var(--sp-1); }
.layouts .btn[aria-pressed="true"] { color: var(--c-brand); border-color: var(--c-brand); }
.hint { color: var(--c-ink-3); white-space: normal; word-break: break-word; }
.acts { padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--c-line); display: flex; flex-direction: column; gap: var(--sp-2); }
.row { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.btn { padding: var(--sp-1) var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-s); background: var(--c-bg); color: var(--c-ink-2); cursor: pointer; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { border-color: var(--c-brand); color: var(--c-brand); }
.confirm { color: var(--c-err); word-break: break-all; }
.else { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; color: var(--c-ink-2); }
.link { border: 0; background: transparent; color: var(--c-brand); cursor: pointer; text-decoration: underline; padding: 0; }
/* 已删除的会话：不是链接，只是一句说明 */
.gone { color: var(--c-ink-3); white-space: normal; word-break: break-word; }
.res { color: var(--c-ink-2); white-space: normal; word-break: break-word; }
.res.conflict, .res.failed, .res.busy, .res.unavailable { color: var(--c-err); }
.res.ok, .res.restored, .res.deleted { color: var(--c-ok); }
.tell { color: var(--c-ink-3); }
.foot { padding: var(--sp-2) var(--sp-4); border-top: 1px solid var(--c-line); color: var(--c-ink-3); white-space: normal; word-break: break-word; }
</style>
