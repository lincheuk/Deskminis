<script setup lang="ts">
/** MU2a Task 2：行内节点递归渲染（bold/italic/strikethrough/inlineCode/link/text）。
 *  文本一律 {{ }} 插值转义，全文不直出原始 HTML（XSS 红线，决策 2c）；
 *  link 的 href 已在解析层过协议白名单（isSafeHref），此处仅负责渲染。 */
import type { MdInline } from '../lib/markdown/parse';

defineProps<{ nodes: MdInline[] }>();
</script>

<template>
  <template v-for="(n, i) in nodes" :key="i">
    <strong v-if="n.type === 'bold'" class="md-b"><MarkdownInline :nodes="n.children" /></strong>
    <em v-else-if="n.type === 'italic'" class="md-i"><MarkdownInline :nodes="n.children" /></em>
    <s v-else-if="n.type === 'strikethrough'" class="md-s"><MarkdownInline :nodes="n.children" /></s>
    <code v-else-if="n.type === 'inlineCode'" class="md-icode">{{ n.text }}</code>
    <a v-else-if="n.type === 'link'" class="md-link" :href="n.href" target="_blank" rel="noopener"><MarkdownInline :nodes="n.children" /></a>
    <template v-else>{{ n.type === 'text' ? n.text : '' }}</template>
  </template>
</template>

<style scoped>
.md-b { font-weight: var(--fw-strong); }
.md-icode {
  font-family: var(--font-mono); font-size: .88em;
  background: var(--fill-quaternary); border-radius: 4px; padding: 1px 5px;
  word-break: break-word;
}
.md-link { color: var(--link); text-decoration: none; }
.md-link:hover { text-decoration: underline; }
</style>
