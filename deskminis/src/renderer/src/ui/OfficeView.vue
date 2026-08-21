<script setup lang="ts">
/** U2：Office 文档内容预览（设计稿 §1）。
 *
 *  三种 kind 用三种版式渲染，因为它们本来就是三种阅读方式：
 *  docx = 一张纸（顺序读）、xlsx = 表格（按行列扫）、pptx = 幻灯片列表（按页翻）。
 *  塞进同一个"文本列表"里就等于把三种文档都读坏了。
 *
 *  **边界写在界面上，不写在文档里**：我们解的是内容（文字/表格/大纲），
 *  字体、精确排版、图片位置、动画都不还原。照 OfficeCLI 的教训——渲染不了就说清楚，
 *  别让用户以为看到的是最终版式。
 *
 *  文本一律走插值（禁 v-html）：内容来自用户工作区的任意文件，不能当可信 HTML。 */
import { computed, ref } from 'vue';
import UiIcon from './UiIcon.vue';
// 类型直接取自解析器本身（与 FilesPanel 取 FileNode 同一先例）：
// 结构改了这里立刻编译报错，比手抄一份接口靠谱
import type { OfficeDoc } from '../../../minisd/office/parse';

const props = defineProps<{ doc: OfficeDoc }>();

/** 多工作表：Excel 的 sheet 标签页。默认看第一张。 */
const sheetIdx = ref(0);
const sheet = computed(() => props.doc.sheets?.[sheetIdx.value]);
/** 表格最宽的一行决定列数——单元格可能跳列，按最长行补齐才不会错位。 */
const colCount = computed(() => Math.max(0, ...(sheet.value?.rows ?? []).map(r => r.length)));
/** 0 基列号 → Excel 列名（0→A, 25→Z, 26→AA），表头那一行要显示它。 */
function colName(i: number): string {
  let n = i, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
/** docx 标题级别 → 标签。级别只认 1..6，越界夹回来（外部文件可能写 Heading9）。 */
function hTag(lv: number | undefined): string { return `h${Math.min(6, Math.max(1, lv ?? 1))}`; }

const empty = computed(() => {
  if (props.doc.kind === 'xlsx') return !props.doc.sheets?.length;
  if (props.doc.kind === 'pptx') return !props.doc.slides?.length;
  return !props.doc.blocks.length;
});
</script>

<template>
  <div class="office">
    <!-- 能力边界条：常驻，不可关。用户随时该知道自己看的是内容不是版式 -->
    <div class="edge t-aux">
      <UiIcon name="alert" :size="14" />
      <span>内容预览：文字、表格、大纲都在，<b>字体、精确排版、图片位置、动画不还原</b>。要看最终版式请用系统 Office 打开。</span>
    </div>

    <div v-if="empty" class="hint t-body">这个文档里没有可提取的文本内容</div>

    <!-- ---- Word：一张有页边距的纸 ---- -->
    <article v-else-if="props.doc.kind === 'docx'" class="paper">
      <template v-for="(b, i) in props.doc.blocks" :key="i">
        <component :is="hTag(b.level)" v-if="b.kind === 'heading'" class="dh">{{ b.text }}</component>
        <p v-else-if="b.kind === 'para'" class="dp">{{ b.text }}</p>
        <div v-else-if="b.kind === 'table'" class="tblwrap">
          <table class="dtbl">
            <tbody>
              <tr v-for="(row, ri) in b.rows" :key="ri">
                <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </article>

    <!-- ---- Excel：行号列名俱全的网格，多表用标签页 ---- -->
    <div v-else-if="props.doc.kind === 'xlsx'" class="grid">
      <div v-if="(props.doc.sheets?.length ?? 0) > 1" class="tabs">
        <button
          v-for="(s, i) in props.doc.sheets" :key="s.name + i" type="button"
          class="tab" :class="{ on: i === sheetIdx }" @click="sheetIdx = i"
        >{{ s.name }}</button>
      </div>
      <div class="gridwrap">
        <table class="sheet">
          <thead>
            <tr>
              <th class="corner"></th>
              <th v-for="c in colCount" :key="c" class="colh">{{ colName(c - 1) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, ri) in sheet?.rows ?? []" :key="ri">
              <th class="rowh tnum">{{ ri + 1 }}</th>
              <td v-for="c in colCount" :key="c" :class="{ num: /^-?[\d.]+$/.test(row[c - 1] ?? '') }">{{ row[c - 1] ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="foot t-aux">{{ sheet?.rows.length ?? 0 }} 行 × {{ colCount }} 列</div>
    </div>

    <!-- ---- PowerPoint：一页一张 16:9 卡片，像幻灯片浏览视图 ---- -->
    <div v-else class="deck">
      <section v-for="(s, i) in props.doc.slides ?? []" :key="i" class="slide">
        <div class="sno t-aux tnum">{{ i + 1 }}</div>
        <div class="sbody">
          <h3 class="stitle">{{ s.title || '(无标题)' }}</h3>
          <ul v-if="s.bullets.length" class="sbul">
            <li v-for="(b, bi) in s.bullets" :key="bi">{{ b }}</li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.office { display: flex; flex-direction: column; min-height: 100%; }
.edge {
  flex: 0 0 auto; display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-5); color: var(--c-ink-2);
  background: var(--c-aou-bar); border-bottom: 1px solid var(--c-line);
}
.edge :deep(svg) { color: var(--c-aou); flex: 0 0 auto; margin-top: 2px; }
.edge b { font-weight: var(--w-md); color: var(--c-ink); }
.hint { padding: var(--sp-8); text-align: center; color: var(--c-ink-3); }

/* ---- docx ---- */
.paper {
  width: min(760px, 100% - var(--sp-7) * 2);
  margin: var(--sp-7) auto; padding: 56px 64px 72px;
  background: var(--c-bg); border-radius: 2px; box-shadow: var(--sh-paper);
  color: var(--c-ink);
}
@media (max-width: 900px) { .paper { padding: 32px 28px 48px; } }
.dh { margin: 1.4em 0 .5em; line-height: 1.35; font-weight: var(--w-bd); }
.dh:first-child { margin-top: 0; }
h1.dh { font-size: 26px; } h2.dh { font-size: 21px; } h3.dh { font-size: 18px; }
h4.dh, h5.dh, h6.dh { font-size: 16px; }
.dp { margin: 0 0 .85em; font-size: var(--t-chat-size); line-height: 1.75; }
.tblwrap { overflow-x: auto; margin: 0 0 1.2em; }
.dtbl { border-collapse: collapse; width: 100%; font-size: var(--t-body-size); }
.dtbl td { border: 1px solid var(--c-line); padding: var(--sp-2) var(--sp-4); vertical-align: top; }
.dtbl tr:first-child td { background: var(--c-bg-1); font-weight: var(--w-md); }

/* ---- xlsx ---- */
.grid { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--c-bg); }
.tabs { flex: 0 0 auto; display: flex; gap: 2px; padding: var(--sp-2) var(--sp-4) 0; border-bottom: 1px solid var(--c-line); }
.tab {
  padding: var(--sp-2) var(--sp-5); cursor: pointer; font-family: inherit;
  font-size: var(--t-item-size); color: var(--c-ink-2);
  background: none; border-radius: var(--r-s) var(--r-s) 0 0;
}
.tab:hover { background: var(--c-bg-1); }
.tab.on { background: var(--c-brand-soft); color: var(--c-brand); font-weight: var(--w-md); }
.gridwrap { flex: 1; min-height: 0; overflow: auto; }
.sheet { border-collapse: collapse; font-size: var(--t-body-size); }
.sheet th, .sheet td {
  border: 1px solid var(--c-line); padding: 3px var(--sp-3);
  min-width: 84px; max-width: 320px; white-space: pre; overflow: hidden; text-overflow: ellipsis;
}
/* 行号/列名槽吸边：横竖滚动时坐标不能跟着跑掉 */
.sheet thead th { position: sticky; top: 0; z-index: 2; background: var(--c-bg-2); color: var(--c-ink-3); font-weight: var(--w-md); }
.sheet .rowh { position: sticky; left: 0; z-index: 1; background: var(--c-bg-2); color: var(--c-ink-3); min-width: 44px; text-align: right; font-weight: 400; }
.sheet .corner { position: sticky; left: 0; z-index: 3; min-width: 44px; }
.sheet td { color: var(--c-ink); }
.sheet td.num { text-align: right; font-variant-numeric: tabular-nums; }
.foot { flex: 0 0 auto; padding: var(--sp-2) var(--sp-5); color: var(--c-ink-3); border-top: 1px solid var(--c-line); }

/* ---- pptx ---- */
.deck { padding: var(--sp-7); display: flex; flex-direction: column; gap: var(--sp-6); }
.slide { display: flex; gap: var(--sp-4); }
.sno { flex: 0 0 24px; text-align: right; color: var(--c-ink-4); padding-top: var(--sp-5); }
.sbody {
  flex: 1; min-width: 0; aspect-ratio: 16 / 9; overflow: auto;
  padding: var(--sp-7) var(--sp-8);
  background: var(--c-bg); border: 1px solid var(--c-line);
  border-radius: var(--r-s); box-shadow: var(--sh-paper);
}
.stitle { margin: 0 0 var(--sp-5); font-size: 20px; line-height: 1.4; font-weight: var(--w-bd); color: var(--c-ink); }
.sbul { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: var(--sp-2); }
.sbul li { font-size: var(--t-body-size); line-height: 1.6; color: var(--c-ink-2); }
</style>
