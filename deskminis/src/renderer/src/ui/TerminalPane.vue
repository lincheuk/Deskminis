<script setup lang="ts">
/** V4：终端。本会话的交互式 PowerShell——底部抽屉，全宽（244px 的右栏放不下一个终端）。
 *
 *  它和 agent 跑命令用的 shell 是两套实例（minisd 里终端归 TerminalManager、shell_execute 归 ShellManager，
 *  terminal.ts 自己也写着「与工具 shell 独立实例」），只是都起在本会话的工作区目录：cd、环境变量互不相通。
 *  W2b-11a 订正：这里和标题行、连接提示原先都写「与 agent 共用同一个长驻 shell」，用户照着在终端里 cd、设变量，
 *  以为 agent 接着用得上。
 *
 *  无 PTY 架构：minisd 侧终端驱动逐字符回显，前端**不做本地回显**，
 *  xterm 显示的一切都来自 terminal.attach 的滚动缓冲 + terminal.output 推送。
 *
 *  挂载时序是要害（旧面板踩出来的）：**先订阅推送并缓冲 → attach 拿滚动缓冲写入 → 再冲刷缓冲**。
 *  颠倒顺序的话，attach 往返途中到达的输出会掉进缝里，用户看到的是「命令跑了但没输出」。 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import UiIcon from './UiIcon.vue';

const emit = defineEmits<{ (e: 'close'): void }>();
const chat = useChat();
const host = ref<HTMLElement | null>(null);

let term: Terminal | undefined;
let fit: FitAddon | undefined;
let ro: ResizeObserver | undefined;
let mo: MutationObserver | undefined;
let attachedFor = '';
let pending: string[] = [];
let attaching = false;

/** xterm 配色从新令牌读（T 波换了命名空间：--bg/--label → --c-bg/--c-ink）。
 *  兜底值只是保险丝，正常路径一定读得到。 */
function readTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string): string => cs.getPropertyValue(n).trim();
  return {
    background: v('--c-bg') || '#0e0e0e',
    foreground: v('--c-ink') || '#e8eaee',
    cursor: v('--c-ink') || '#e8eaee',
    selectionBackground: v('--c-bg-3') || '#333333',
  };
}
function applyTheme(): void { if (term) term.options.theme = readTheme(); }

const media = window.matchMedia('(prefers-color-scheme: dark)');
const onMedia = (): void => applyTheme();

function onOutput(params: unknown): void {
  const p = params as { sessionId?: string; data?: string } | null;
  if (!p || p.sessionId !== chat.activeId) return;
  const data = String(p.data ?? '');
  if (attaching) pending.push(data); else term?.write(data);
}

async function attach(sessionId: string): Promise<void> {
  if (!term || !sessionId) return;
  attaching = true; pending = []; attachedFor = sessionId;
  term.reset();
  try {
    const r = await rpc.call<{ scrollback?: string }>('terminal.attach', { sessionId });
    if (attachedFor !== sessionId) return;   // 等待期间换了会话：丢弃这次结果
    if (r?.scrollback) term.write(String(r.scrollback));
    // 空滚动缓冲 = 这个会话的 shell 还没吐过任何东西。给一行灰提示，
    // 否则用户面对的是一整块纯黑，分不清「还没开始」和「坏了」。
    else term.writeln('\x1b[90m[终端已连接。输入命令回车执行；这是独立的 PowerShell，不与 agent 的 shell 共享 cd 和环境变量]\x1b[0m');
    const queued = pending; pending = []; attaching = false;
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
    fontSize: 12, cursorBlink: true, scrollback: 5000, theme: readTheme(),
    // W2b-6b：终端输出里的 OSC 8 超链接交给系统浏览器。不配 linkHandler 时 xterm 自己处理：先弹英文确认框，
    // 再 window.open() 开一个空白窗口、事后改它的地址——主进程的新窗口守卫（W2b-6）只看得到 about:blank，
    // 按规矩拒绝、交不出去，点了什么也不发生。这里把地址直接交给 window.open：主进程照样不开新窗口，
    // 把 http / https 交给系统浏览器（main/index.ts 的 openInSystem）。
    // OSC 8 的显示文字可以和地址不一样（输出里写着「文档」，指向的却是别的网站），所以先用确认框把真实地址给用户看，取消就不打开。
    // 框里给的、交给 window.open 的都是规范形 new URL(uri).href，不是 xterm 交来的原文：原文里夹一个 U+202E（从右到左覆盖）
    // 或一个同形字母（西里尔字母 U+0430），框里显示的主机就和实际去的不一样，显示文字骗人的把戏换到地址这一行上照样成立。
    // 规范形里双向控制符被百分号转义、非 ASCII 的主机名成了 punycode（xn--…），和主进程 openInSystem 交给系统浏览器的
    // 是同一个串。主机另起一行：https://apple.com@evil.example/ 这类地址前半截像 apple.com，真正去的是 @ 后面的主机。
    // 解析不了就不打开，不回落成原文（不开 allowNonHttpProtocols 时 xterm 只交解析得了的 http / https，这里是兜底）。
    // 不开 allowNonHttpProtocols：xterm 只让 http / https 的链接可点，javascript:、file: 之类根本不成链接。
    linkHandler: {
      activate: (_e, uri) => {
        let link: URL;
        try { link = new URL(uri); } catch { return; }
        if (!window.confirm(`用系统浏览器打开这个链接吗？\n\n网站：${link.host}\n实际地址：${link.href}`)) return;
        window.open(link.href);
      },
    },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value!);
  fit.fit();
  // 键入直送 stdin（回显由 minisd 完成）；无会话时忽略
  term.onData(data => {
    if (!chat.activeId) return;
    void rpc.call('terminal.input', { sessionId: chat.activeId, data }).catch(() => { /* 断开：下次 attach 重建 */ });
  });
  rpc.on('terminal.output', onOutput);          // 先订阅
  if (chat.activeId) void attach(chat.activeId); // 再 attach
  // 隐藏态尺寸为 0，fit 会抛：兜住，重新显示时 RO 会再触发
  ro = new ResizeObserver(() => { try { fit?.fit(); } catch { /* 隐藏态忽略 */ } });
  ro.observe(host.value!);
  media.addEventListener('change', onMedia);
  mo = new MutationObserver(applyTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});
onBeforeUnmount(() => {
  rpc.off('terminal.output', onOutput);
  ro?.disconnect(); mo?.disconnect();
  media.removeEventListener('change', onMedia);
  term?.dispose();
});
</script>

<template>
  <section class="term">
    <header class="thead">
      <UiIcon name="terminal" :size="15" />
      <span class="t-aux">终端 · 独立的 PowerShell，起在本会话工作区；不与 agent 的 shell 共享 cd 和环境变量</span>
      <button class="ib" type="button" title="收起终端" @click="emit('close')"><UiIcon name="x" :size="15" /></button>
    </header>
    <div ref="host" class="host"></div>
  </section>
</template>

<style scoped>
.term {
  flex: 0 0 auto; height: 260px; min-height: 0;
  display: flex; flex-direction: column;
  border-top: 1px solid var(--c-line); background: var(--c-bg);
}
.thead {
  flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-3);
  height: var(--h-field); padding: 0 var(--sp-4);
  background: var(--c-bg-1); border-bottom: 1px solid var(--c-line); color: var(--c-ink-3);
}
.thead > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ib {
  width: 26px; height: 26px; border-radius: var(--r-s); flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: none; cursor: pointer; color: var(--c-ink-3); padding: 0;
}
.ib:hover { background: var(--c-bg-2); color: var(--c-ink); }
.host { flex: 1; min-height: 0; padding: var(--sp-3) 0 var(--sp-3) var(--sp-4); overflow: hidden; }
.host :deep(.xterm) { height: 100%; }
</style>
