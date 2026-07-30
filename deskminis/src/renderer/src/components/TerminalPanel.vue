<script setup lang="ts">
/** 右栏 · 终端面板（设计 §7）——xterm.js 实况。
 *  无 PTY 架构（计划决策 2）：minisd 侧终端驱动逐字符回显，前端不做本地回显，
 *  xterm 显示的一切都来自 terminal.attach 滚动缓冲 + terminal.output 推送。
 *  挂载时序：先订阅推送并缓冲 → attach 拿滚动缓冲写入 → 再冲刷缓冲，避免缝隙丢数据。 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';

const chat = useChat();
const host = ref<HTMLElement | null>(null);

let term: Terminal | undefined;
let fit: FitAddon | undefined;
let ro: ResizeObserver | undefined;
let mo: MutationObserver | undefined;
let attachedFor = '';
/** attach 返回前到达的推送先缓冲，防止「滚动缓冲之后的输出」被吞 */
let pending: string[] = [];
let attaching = false;

/** xterm 主题跟随 tokens（暗色适配硬约束）：从计算样式读语义色，主题切换时重读。 */
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    background: v('--bg') || '#ffffff',
    foreground: v('--label') || '#000000',
    cursor: v('--label') || '#000000',
    selectionBackground: v('--fill') || 'rgba(120,120,128,.2)',
  };
}

function applyTheme(): void { if (term) term.options.theme = readTheme(); }

const media = window.matchMedia('(prefers-color-scheme: dark)');
const onMedia = () => applyTheme();

function onOutput(params: any): void {
  if (!params || params.sessionId !== chat.activeId) return;
  const data = String(params.data ?? '');
  if (attaching) pending.push(data);
  else term?.write(data);
}

async function attach(sessionId: string): Promise<void> {
  if (!term || !sessionId) return;
  attaching = true;
  pending = [];
  attachedFor = sessionId;
  term.reset();
  try {
    const r = await rpc.call('terminal.attach', { sessionId });
    if (attachedFor !== sessionId) return; // 等待期间又切了会话：丢弃这次结果（watch 已发起新 attach）
    if (r?.scrollback) term.write(String(r.scrollback));
    const queued = pending;
    pending = [];
    attaching = false;
    for (const d of queued) term.write(d);
  } catch (e) {
    attaching = false;
    term.writeln(`\x1b[31m[终端连接失败: ${e instanceof Error ? e.message : String(e)}]\x1b[0m`);
  }
}

watch(() => chat.activeId, id => { if (id && id !== attachedFor) void attach(id); });

onMounted(() => {
  term = new Terminal({
    fontFamily: '"Cascadia Code", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
    theme: readTheme(),
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value!);
  fit.fit();
  // 键入直送 stdin（回显由 minisd 驱动完成）；无会话时忽略（左栏必有可选会话时才用得上终端）
  term.onData(data => {
    if (!chat.activeId) return;
    void rpc.call('terminal.input', { sessionId: chat.activeId, data }).catch(() => { /* 连接断开：下次 attach 重建 */ });
  });
  rpc.on('terminal.output', onOutput);
  if (chat.activeId) void attach(chat.activeId);
  // v-show 隐藏时尺寸为 0，fit 会抛：兜住，重新显示时 RO 会再触发
  ro = new ResizeObserver(() => { try { fit?.fit(); } catch { /* 隐藏态忽略 */ } });
  ro.observe(host.value!);
  media.addEventListener('change', onMedia);
  // 强制明暗模式落在 <html data-theme>：观察属性变化重读 tokens
  mo = new MutationObserver(applyTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});

onBeforeUnmount(() => {
  rpc.off('terminal.output', onOutput);
  ro?.disconnect();
  mo?.disconnect();
  media.removeEventListener('change', onMedia);
  term?.dispose();
});
</script>

<template>
  <div ref="host" class="termhost"></div>
</template>

<style scoped>
.termhost { flex: 1; min-height: 0; padding: 8px 0 8px 10px; background: var(--bg); overflow: hidden; }
.termhost :deep(.xterm) { height: 100%; }
</style>
