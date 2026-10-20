<script setup lang="ts">
/** F08：「改动」页的纯展示件——按运行分组的变化清单、恢复前的逐项预检、恢复后的逐项结果、范围说明与检查点占用。
 *  没有内部状态、不碰 rpc 与 store：每个状态都由 props 给出，操作只 emit（取数与发请求在外壳 ChangeList.vue）。
 *  这样拆是为了让「页面上到底显示了什么」能按真实渲染断言。 */
import { computed } from 'vue';
import type { ChangeList, RestorePrecheck, RestoreReport } from '../../../shared/checkpoint';
import { CHECKPOINT_LIST_MAX_ROWS, CHECKPOINT_SCOPE_NOTE } from '../../../shared/checkpoint';
import type { Artifact } from '../lib/artifacts/collect';
import { formatBytes, groupTitle, planRunRestore, splitNotSent, stateLabel, summarizeReport, uncoveredNote } from '../lib/changes/model';

const props = defineProps<{
  list: ChangeList | null;
  /** 没有检查点的改动（通常是升级之前的会话、在其它设备上执行的）：只能看当前文件，没有恢复入口。 */
  legacy: Artifact[];
  /** 取清单的错误。 */
  error: string;
  /** 预检 / 恢复这次操作本身的错误（整次调用被拒）。不随清单重取而消失。 */
  actionError?: string;
  /** 清单还没取回来：这时不说「还没有文件改动」。 */
  loading?: boolean;
  /** 展开了恢复面板的那次运行。 */
  expandedRunId: string | null;
  precheck: RestorePrecheck[] | null;
  report: RestoreReport | null;
  busy: boolean;
  quotaEditing: boolean;
  quotaError: string;
  /** 正在审阅的检查点 id，或正在预览的路径（高亮用）。 */
  selected?: string | null;
}>();
const emit = defineEmits<{
  (e: 'review', id: string): void;
  (e: 'open', path: string): void;
  (e: 'inspect-run', runId: string): void;
  /** 确认恢复展开着的这次运行。发哪些记录由外壳按同一份预检结果算（planRunRestore），这里不传。 */
  (e: 'restore-run'): void;
  (e: 'collapse'): void;
  (e: 'edit-quota'): void;
  (e: 'set-quota', bytes: number): void;
}>();

const groups = computed(() => props.list?.groups ?? []);
/** 一条记录属于哪个文件：清单里的路径身份键（预检与结果里的路径可能只差在大小写）；清单里查不到的按路径。 */
const fileKeyOf = computed(() => {
  const m = new Map<string, string>();
  for (const g of groups.value) for (const c of g.changes) m.set(c.id, c.pathKey);
  return (i: { id: string; path: string }): string => m.get(i.id) ?? i.path;
});
const pre = computed(() => (props.precheck ? planRunRestore(props.precheck, fileKeyOf.value) : null));
/** 结果按文件汇总时把这次没有发的记录一并交进去（同一份预检算出来的 blocked）：同一个文件更早的一条在预检时就不能恢复，
 *  发出去的几条全做成了它也只是停在中间版本，标题不能把它数成「已恢复」。 */
const rep = computed(() => (props.report ? summarizeReport(props.report, fileKeyOf.value, pre.value?.blocked ?? []) : null));
/** 结果下面另列的「这次没有发的记录」。改动还留在文件里的按文件归成两堆：它的文件发过记录的（标题已经数过这个文件，
 *  这里只列原因），与一条都没发的文件的（标题没数，这里按文件数另计）；同一个文件不在两处各数一次。
 *  改动已经不在文件里的（以前恢复过的、当时没有写成的）单独一堆，不算「没有恢复」——预检时就是这个结论而没有发的，
 *  与预检过期、发出去之后引擎才回报这个结论的，都在这一堆里（后一种在结果里，不靠预检：没有预检也照样列）。 */
const rest = computed(() => (props.report ? splitNotSent(props.report, pre.value?.blocked ?? [], fileKeyOf.value) : null));
const usage = computed(() => props.list?.usage ?? null);
/** 预检与结果的每一项按清单里的相对路径显示（右栏只有两百多像素宽，绝对路径一截断就看不出是哪个文件）；完整路径挂在 title 上。 */
const displayOf = computed(() => {
  const m = new Map<string, string>();
  for (const g of groups.value) for (const c of g.changes) m.set(c.id, c.displayPath);
  return m;
});
const nameOf = (i: { id: string; path: string }): string => displayOf.value.get(i.id) ?? i.path;
const empty = computed(() => !props.loading && groups.value.length === 0 && props.legacy.length === 0 && !props.error);
/** 下面那一节的标题与说明。标题只说事实，原因写成不排他的一句：这一节是按工具调用记录列的，引擎标为已覆盖的
 *  （有检查点的、由带检查点的引擎执行而没有改变文件的）与结果还没到的都已剔掉，剩下的多半是旧版本或别的设备做的——
 *  但不替它们下结论。清单没取到（远程连接看不了检查点）时这些写入有没有检查点根本不知道，换一个标题。 */
const legacyHead = computed(() => (props.list
  ? { title: '没有检查点的改动', note: '这些写入没有留下检查点记录，通常是升级之前、或在其它设备上执行的。这里只能查看当前文件，不能恢复。' }
  : { title: '本会话的文件写入（按工具调用记录）', note: '检查点清单没有取到，看不出这些写入有没有检查点。这里只能查看当前文件，不能恢复。' }));

/** 容量输入按 MB 填；表单自己不留状态，提交时现读输入框。 */
function submitQuota(ev: Event): void {
  const input = (ev.target as HTMLFormElement).elements.namedItem('mb') as HTMLInputElement | null;
  const mb = Number(input?.value);
  emit('set-quota', Number.isFinite(mb) ? Math.round(mb * 1024 * 1024) : Number.NaN);
}
</script>

<template>
  <div class="cl">
    <div v-if="props.error" class="err">{{ props.error }}</div>
    <div v-if="props.actionError" class="err">{{ props.actionError }}</div>
    <div v-if="empty" class="hint">本会话还没有文件改动</div>

    <section v-for="g in groups" :key="g.runId ?? ''" class="grp">
      <header class="gh">
        <span class="gt">{{ groupTitle(g) }}</span>
        <button v-if="g.runId !== null" type="button" class="gbtn" :disabled="props.busy" @click="emit('inspect-run', g.runId)">恢复这次运行…</button>
      </header>
      <button
        v-for="c in g.changes" :key="c.id" type="button" class="chg" :class="{ on: props.selected === c.id }"
        :title="c.path" @click="emit('review', c.id)"
      >
        <span class="tag" :class="c.kind">{{ c.kind === 'create' ? '新' : '改' }}</span>
        <span class="cpath">{{ c.displayPath }}</span>
        <span v-if="stateLabel(c)" class="st t-aux">{{ stateLabel(c) }}</span>
      </button>
      <div v-if="uncoveredNote(g.uncovered)" class="unc t-aux">{{ uncoveredNote(g.uncovered) }}</div>

      <div v-if="g.runId !== null && props.expandedRunId === g.runId && (rep || pre)" class="rp">
        <template v-if="rep && props.report">
          <div class="rph">{{ rep.headline }}</div>
          <!-- 列的是标题数过的记录（rep.items）。发出去之后引擎回报「已经恢复过 / 当时没有写成」的不在这里：
               它们没有动文件、也不算没做成，列在最下面「不需要恢复」一节，不标成出错的颜色 -->
          <div v-for="i in rep.items" :key="i.id" class="ri" :class="i.outcome">
            <span class="rpath" :title="i.path">{{ nameOf(i) }}</span>
            <span class="rmsg t-aux">{{ i.message }}</span>
          </div>
          <!-- 确认时没有发预检时不能恢复的那几项；它们照样列在结果里，不让「已恢复 N 个」读起来像是全部。
               分两节，每个文件只数一次：上面发过记录的文件已经在标题里数过，它没发的记录只列原因、不再算一个；
               一条都没发的文件才是「另有 N 个」，按文件数（与标题同一个单位） -->
          <template v-if="rest && rest.sameFile.length > 0">
            <div class="rph">上面的文件里，有 {{ rest.sameFile.length }} 次改动这次没有恢复（预检时不能恢复）：</div>
            <div v-for="b in rest.sameFile" :key="b.id" class="ri conflict">
              <span class="rpath" :title="b.path">{{ nameOf(b) }}</span>
              <span class="rmsg t-aux">{{ b.message }}</span>
            </div>
          </template>
          <template v-if="rest && rest.otherFiles.length > 0">
            <div class="rph">另有 {{ rest.otherFileCount }} 个没有恢复（预检时不能恢复）：</div>
            <div v-for="b in rest.otherFiles" :key="b.id" class="ri conflict">
              <span class="rpath" :title="b.path">{{ nameOf(b) }}</span>
              <span class="rmsg t-aux">{{ b.message }}</span>
            </div>
          </template>
          <!-- 改动已经不在文件里的记录（以前恢复过的、当时就没有写成的）：没有发，也不需要发；预检过期时发了出去、
               引擎回报同一个结论的也在这里。照样逐条列出，但不算「没有恢复」、不标成出错的颜色——
               一个早就恢复好的文件不该读起来像是这次出了问题 -->
          <template v-if="rest && rest.notNeeded.length > 0">
            <div class="rph">有 {{ rest.notNeeded.length }} 次改动不需要恢复（之前已经恢复过，或当时没有写成）：</div>
            <div v-for="b in rest.notNeeded" :key="b.id" class="ri">
              <span class="rpath" :title="b.path">{{ nameOf(b) }}</span>
              <span class="rmsg t-aux">{{ b.message }}</span>
            </div>
          </template>
          <div v-if="rep.anyDone" class="tell t-aux">模型不会自动得知这次恢复，继续对话时请告诉它。</div>
          <button type="button" class="gbtn" @click="emit('collapse')">收起</button>
        </template>
        <template v-else-if="pre">
          <!-- 左边按文件数（同一个文件在这次运行里改了几次都算一个），右边按记录数（每条各有原因，逐条列在下面） -->
          <div class="rph">可恢复 {{ pre.files }} 个；不能恢复 {{ pre.blocked.length }} 个</div>
          <div v-if="pre.chained.length > 0" class="rnote t-aux">
            共 {{ pre.send.length }} 次改动：同一个文件在这次运行里改了多次的，会连同之后的改动一起恢复（从最新的一次起依次恢复）。
          </div>
          <div v-for="b in pre.blocked" :key="b.id" class="ri conflict">
            <span class="rpath" :title="b.path">{{ nameOf(b) }}</span>
            <span class="rmsg t-aux">{{ b.message }}</span>
          </div>
          <!-- 「可恢复 N 个」数的是会动到的文件：其中更早的改动列在上面「不能恢复」里的，恢复完也回不到这次运行之前，确认之前就写明 -->
          <div v-if="pre.partial > 0" class="rnote t-aux">
            其中 {{ pre.partial }} 个文件回不到这次运行之前：更早的改动不能恢复（原因见上），只会恢复后面的几次改动，文件停在中间的版本。
          </div>
          <div class="ract">
            <button
              v-if="pre.send.length > 0" type="button" class="gbtn primary" :disabled="props.busy"
              @click="emit('restore-run')"
            >恢复可恢复的 {{ pre.files }} 个文件</button>
            <button type="button" class="gbtn" @click="emit('collapse')">收起</button>
          </div>
        </template>
      </div>
    </section>
    <!-- 清单只取最近的若干条：被截断时照实写明，不让更早的改动悄悄从页面上消失 -->
    <div v-if="props.list && props.list.truncated" class="unc t-aux">只显示最近 {{ CHECKPOINT_LIST_MAX_ROWS }} 条改动，更早的没有列出。</div>

    <section v-if="props.legacy.length" class="grp legacy">
      <header class="gh"><span class="gt">{{ legacyHead.title }}</span></header>
      <div class="unc t-aux">{{ legacyHead.note }}</div>
      <button
        v-for="c in props.legacy" :key="c.path" type="button" class="chg" :class="{ on: props.selected === c.path }"
        @click="emit('open', c.path)"
      >
        <span class="tag" :class="c.kind">{{ c.kind === 'edit' ? '改' : '写' }}</span>
        <span class="cpath">{{ c.path }}</span>
        <span v-if="c.kind === 'edit' && (c.add || c.del)" class="cnum t-aux tnum">
          <span class="a">+{{ c.add ?? 0 }}</span><span class="d">-{{ c.del ?? 0 }}</span>
        </span>
      </button>
    </section>

    <footer class="foot t-aux">
      <p class="scope">{{ CHECKPOINT_SCOPE_NOTE }}</p>
      <div v-if="usage" class="usage">
        <span>检查点占用 {{ formatBytes(usage.usedBytes) }} / {{ formatBytes(usage.quotaBytes) }} · 保留 {{ usage.retentionDays }} 天</span>
        <button type="button" class="gbtn" @click="emit('edit-quota')">调整</button>
      </div>
      <div v-if="usage && usage.overQuota" class="err">受保护的检查点已超过上限，新的覆盖写入会被拒绝，请调大上限</div>
      <!-- novalidate：越界的值照样提交，由引擎给出原因并原样显示（浏览器自带的校验气泡只会悄悄拦下提交） -->
      <form v-if="props.quotaEditing" class="quota" novalidate @submit.prevent="submitQuota">
        <label>上限（MB）<input name="mb" type="number" min="128" max="65536" step="1" :value="usage ? Math.round(usage.quotaBytes / 1048576) : 1024" /></label>
        <button type="submit" class="gbtn primary" :disabled="props.busy">确定</button>
      </form>
      <div v-if="props.quotaError" class="err">{{ props.quotaError }}</div>
    </footer>
  </div>
</template>

<style scoped>
.cl { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.hint { padding: var(--sp-5) var(--sp-4); color: var(--c-ink-3); text-align: center; }
.err { padding: var(--sp-2) var(--sp-3); color: var(--c-err); word-break: break-word; }
.grp { display: flex; flex-direction: column; min-width: 0; }
/* 组头：标题独占一行（右栏窄，和按钮挤在一行就只剩「第 2 次…」），按钮在它下面 */
.gh { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); color: var(--c-ink-2); }
.gt { flex: 1 1 100%; min-width: 0; font-weight: 600; white-space: normal; word-break: break-word; }
.gbtn {
  flex: 0 0 auto; padding: 2px var(--sp-3); border: 1px solid var(--c-line); border-radius: var(--r-s);
  background: var(--c-bg); color: var(--c-ink-2); cursor: pointer; white-space: nowrap;
}
.gbtn:disabled { opacity: 0.5; cursor: default; }
.gbtn.primary { border-color: var(--c-brand); color: var(--c-brand); }
.chg {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%; min-width: 0;
  padding: var(--sp-1) var(--sp-3); border: 0; background: transparent; color: var(--c-ink-2); text-align: left; cursor: pointer;
}
.chg:hover, .chg.on { background: var(--c-bg-1); }
.tag { flex: 0 0 auto; width: 18px; text-align: center; border-radius: var(--r-s); background: var(--c-bg-2); color: var(--c-ink-3); }
.tag.create { color: var(--c-ok); }
.cpath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--f-mono); }
.st { flex: 0 0 auto; color: var(--c-ink-3); }
.cnum { flex: 0 0 auto; display: flex; gap: var(--sp-1); }
.cnum .a { color: var(--c-ok); }
.cnum .d { color: var(--c-err); }
.unc { padding: var(--sp-1) var(--sp-3); color: var(--c-ink-3); white-space: normal; word-break: break-word; }
.rp { margin: var(--sp-2) var(--sp-3); padding: var(--sp-2); border: 1px solid var(--c-line); border-radius: var(--r-s); display: flex; flex-direction: column; gap: var(--sp-2); }
.rph { font-weight: 600; color: var(--c-ink-2); }
.rnote { color: var(--c-ink-3); white-space: normal; word-break: break-word; }
.ri { display: flex; flex-direction: column; min-width: 0; }
.rpath { font-family: var(--f-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rmsg { color: var(--c-ink-3); white-space: normal; word-break: break-word; }
.ri.conflict .rpath, .ri.failed .rpath, .ri.busy .rpath, .ri.unavailable .rpath { color: var(--c-err); }
.ract { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.tell { color: var(--c-ink-3); }
.foot { margin-top: auto; padding: var(--sp-3); border-top: 1px solid var(--c-line); color: var(--c-ink-3); display: flex; flex-direction: column; gap: var(--sp-2); }
.scope { margin: 0; white-space: normal; word-break: break-word; }
.usage { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.quota { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.quota input { width: 96px; margin-left: var(--sp-2); }
</style>
