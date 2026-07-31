<script setup lang="ts">
/** MU2a Task 2：Markdown AST → 模板递归渲染（白名单节点闭集，设计 §2.3/§5.1）。
 *  XSS 红线（决策 2c）：全文不直出原始 HTML，文本一律 {{ }} 插值转义；
 *  块级自递归（ul/ol/blockquote 子节点回 MarkdownView）；行内委托 MarkdownInline。
 *  排版先保视觉等价（Task 4 统一迁移到尺度令牌）。 */
import { ref, onBeforeUnmount } from 'vue';
import type { MdNode } from '../lib/markdown/parse';
import MarkdownInline from './MarkdownInline.vue';
import Icon from './Icon.vue';

defineProps<{ nodes: MdNode[] }>();

// 围栏复制：transient ✓ 反馈（1.2s 后还原）；key = 节点在数组中的下标（组件内唯一）
const copiedKey = ref<number | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
async function copyCode(code: string, key: number): Promise<void> {
  try { await navigator.clipboard.writeText(code); } catch { return; } // 剪贴板不可用静默放弃
  copiedKey.value = key;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { copiedKey.value = null; }, 1200);
}
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });
</script>

<template>
  <div class="md">
    <template v-for="(n, i) in nodes" :key="i">
      <p v-if="n.type === 'paragraph'" class="md-p"><MarkdownInline :nodes="n.children" /></p>
      <h2 v-else-if="n.type === 'heading' && n.level === 2" class="md-h2"><MarkdownInline :nodes="n.children" /></h2>
      <h3 v-else-if="n.type === 'heading'" class="md-h3"><MarkdownInline :nodes="n.children" /></h3>
      <div v-else-if="n.type === 'codeBlock'" class="md-code">
        <div class="md-codebar">
          <span class="md-lang">{{ n.lang || 'text' }}</span>
          <button type="button" class="md-copy" @click="copyCode(n.code, i)">
            <Icon :name="copiedKey === i ? 'check' : 'copy'" :size="13" />
            <span>{{ copiedKey === i ? '已复制' : '复制' }}</span>
          </button>
        </div>
        <pre class="md-pre"><code>{{ n.code }}</code></pre>
      </div>
      <ul v-else-if="n.type === 'ul'" class="md-ul">
        <li v-for="(it, k) in n.items" :key="k" class="md-li"><MarkdownView :nodes="it.children" /></li>
      </ul>
      <ol v-else-if="n.type === 'ol'" class="md-ol" :start="n.start">
        <li v-for="(it, k) in n.items" :key="k" class="md-li"><MarkdownView :nodes="it.children" /></li>
      </ol>
      <blockquote v-else-if="n.type === 'blockquote'" class="md-quote"><MarkdownView :nodes="n.children" /></blockquote>
      <table v-else-if="n.type === 'table'" class="md-table">
        <thead><tr><th v-for="(c, k) in n.header" :key="k"><MarkdownInline :nodes="c" /></th></tr></thead>
        <tbody>
          <tr v-for="(row, r) in n.rows" :key="r">
            <td v-for="(c, k) in row" :key="k"><MarkdownInline :nodes="c" /></td>
          </tr>
        </tbody>
      </table>
      <hr v-else-if="n.type === 'hr'" class="md-hr" />
    </template>
  </div>
</template>

<style scoped>
.md { display: flex; flex-direction: column; gap: 8px; align-self: stretch; min-width: 0; }
.md-p { margin: 0; white-space: pre-wrap; word-break: break-word; }
.md-h2, .md-h3 { margin: 6px 0 0; line-height: 1.35; }
.md-h2 { font-size: 1.25em; }
.md-h3 { font-size: 1.1em; }
.md-code {
  border: .5px solid var(--separator); border-radius: var(--r-md);
  background: var(--grouped-bg-secondary); overflow: hidden; max-width: 100%;
}
.md-codebar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 6px 4px 10px; border-bottom: .5px solid var(--separator);
  color: var(--label-secondary); font-size: var(--fs-micro);
}
.md-lang { font-family: var(--font-mono); }
.md-copy {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px;
  background: none; border: none; border-radius: var(--r-control); cursor: pointer;
  color: var(--label-secondary); font-family: var(--font-ui); font-size: var(--fs-micro);
}
.md-copy:hover { background: var(--fill-tertiary); color: var(--label); }
.md-pre {
  margin: 0; padding: 10px 12px; overflow: auto;
  font-family: var(--font-mono); font-size: var(--fs-mono); line-height: 1.5; white-space: pre;
}
.md-ul, .md-ol { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 4px; }
.md-li { min-width: 0; }
.md-li > .md { gap: 4px; }
.md-quote {
  margin: 0; padding: 2px 0 2px 10px;
  border-left: 3px solid var(--separator); color: var(--label-secondary);
}
.md-table { border-collapse: collapse; font-size: var(--fs-ui); max-width: 100%; }
.md-table th, .md-table td {
  border: .5px solid var(--separator); padding: 5px 10px; text-align: left; vertical-align: top;
}
.md-table th { background: var(--grouped-bg-secondary); font-weight: 600; }
.md-hr { border: none; border-top: .5px solid var(--separator); margin: 4px 0; }
</style>
