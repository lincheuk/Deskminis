<script setup lang="ts">
/** T5：MCP 服务器。两种 transport——stdio（本地进程）与 streamable-http（远端 URL）。
 *  env / headers 里可以写 $$VAR 引用环境变量：**原样存取不解析**，
 *  界面上展示引用名本身是安全的，真正的解析在连接时发生（后端 D3/D4）。
 *  configError 只拿到布尔：加载失败的原文可能带明文 headers，不出 minisd；
 *  W1a-4 起另有 configErrorKind 枚举（read / parse / shape），只用来选横幅文案。 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useChat } from '../../stores/chat';
import UiIcon from '../UiIcon.vue';

const chat = useChat();
const blank = { name: '', transport: 'stdio' as 'stdio' | 'streamable-http', command: '', args: '', url: '', note: '' };
const form = reactive({ ...blank });
const open = ref(false);
const editingName = ref('');
const err = ref('');
const confirming = ref('');
const testing = ref('');
const testResult = ref<Record<string, string>>({});

/** W1a-5：后端 mcp.servers.list 每次先对比磁盘重读，横幅才敢说「修好后回到这页即可」。
 *  用户多半是切到编辑器改完 servers.json 再切回窗口，这一节并没有重新挂载——窗口重新拿到焦点时也重拉一次，
 *  「切回来」这种回法同样算数。重拉失败（比如引擎断线）不打扰：列表停在上一次的样子，下次挂载或聚焦再拉。 */
function onWindowFocus(): void { void chat.fetchMcpServers().catch(() => { /* 见上 */ }); }
onMounted(() => { void chat.fetchMcpServers(); window.addEventListener('focus', onWindowFocus); });
onBeforeUnmount(() => { window.removeEventListener('focus', onWindowFocus); });
const list = computed(() => chat.mcpServers.servers);
const statusOf = (name: string) => chat.mcpServers.statuses.find(s => s.name === name);

function startNew(): void { Object.assign(form, blank); editingName.value = ''; err.value = ''; open.value = true; }
function startEdit(s: Record<string, unknown>): void {
  err.value = '';
  editingName.value = String(s.name);
  form.name = String(s.name);
  form.transport = (s.transport as 'stdio' | 'streamable-http') ?? 'stdio';
  form.command = String(s.command ?? '');
  form.args = Array.isArray(s.args) ? (s.args as string[]).join(' ') : '';
  form.url = String(s.url ?? '');
  form.note = String(s.note ?? '');
  open.value = true;
}
function cancel(): void { open.value = false; editingName.value = ''; err.value = ''; Object.assign(form, blank); }

/** 参数按空格切：够用且可预期。真需要带空格的参数就改 servers.json——
 *  在这里做引号解析只会把「为什么我的参数被拆开了」变成第二个问题。 */
function payload(): Record<string, unknown> {
  const base: Record<string, unknown> = { name: form.name.trim(), transport: form.transport, enabled: true, note: form.note.trim() || undefined };
  if (form.transport === 'stdio') {
    base.command = form.command.trim();
    base.args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
  } else {
    base.url = form.url.trim();
  }
  return base;
}

async function submit(): Promise<void> {
  err.value = '';
  try {
    // 改名 = 换了一台服务器：先删旧条目，否则会留下一条同配置的孤儿
    if (editingName.value && editingName.value !== form.name.trim()) await chat.removeMcpServer(editingName.value);
    await chat.upsertMcpServer(payload());
    cancel();
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
/** W1a-4 开关失败要回滚。勾选框是 :checked 单向绑定，点下去 DOM 已经翻了；后端拒绝时 s.enabled 没变，
 *  Vue 比对 vnode 发现 checked 没变就不会重写 DOM，框会一直停在错的状态。
 *  所以失败后重拉列表（后端写盘失败时内存不变，列表即事实），再把框拨回列表里的值。 */
async function onToggle(s: { name: string; enabled: boolean }, ev: Event): Promise<void> {
  const box = ev.target as HTMLInputElement;
  err.value = '';
  try {
    await chat.toggleMcpServer(s.name, !s.enabled);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
    try { await chat.fetchMcpServers(); } catch { /* 重拉也失败：按点之前的值拨回 */ }
    const now = chat.mcpServers.servers.find(x => x.name === s.name);
    box.checked = now ? now.enabled : s.enabled;
  }
}
async function remove(name: string): Promise<void> {
  err.value = ''; confirming.value = '';
  try { await chat.removeMcpServer(name); if (editingName.value === name) cancel(); }
  catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
async function test(): Promise<void> {
  const key = form.name.trim() || '__new__';
  testing.value = key;
  try {
    const r = await chat.testMcpServer(payload());
    testResult.value[key] = r.ok ? `连上了，${r.toolCount ?? 0} 个工具（${r.elapsedMs ?? 0}ms）` : `连不上：${r.error ?? '未知原因'}`;
  } catch (e) {
    testResult.value[key] = `连不上：${e instanceof Error ? e.message : String(e)}`;
  } finally { testing.value = ''; }
}
</script>

<template>
  <section class="f-sec">
    <h2>MCP 服务器</h2>
    <p class="f-note">MCP 服务器给 agent 提供额外工具。改动即时生效，不用重启。</p>

    <!-- T6e-3 补搬：后端 mcp.servers.list 一直回 configError，store 也存着，
         但界面从没读过——servers.json 语法坏了的时候，用户看到的是一个空列表，
         以为服务器凭空消失了。空列表和「读不出来」必须是两句不同的话。
         W1a-4：这里原先有两条横幅同时出现（T5 一条、T6e-3 补搬又加一条），T5 那条还说「修好后回到这页会重读」，
         而 store 只在启动时读一次盘——合成一条。配置读坏时后端拒绝一切写入，横幅要把这件事说出来；
         read 类（权限 / 占用）不是语法问题，不能叫人去查语法。
         W1a-5：后端写前与 list 前都对比磁盘重读，修好文件不用重启了——末句改成「修好后回到这页即可」。
         切到别的设置节再切回来（重新挂载），或者从编辑器切回窗口（onWindowFocus），都会重拉列表。 -->
    <p v-if="chat.mcpServers.configError" class="cfgerr t-body">
      <template v-if="chat.mcpServers.configErrorKind === 'read'">
        servers.json 读不出来——可能没有读取权限、正被其它程序占用，或者同名的是个文件夹。你配置的服务器这次都没有加载。
      </template>
      <template v-else>
        servers.json 解析失败，已按空配置加载——请检查文件语法。你配置的服务器这次都没有加载。
      </template>
      <!-- 分两行：模板分支与后句之间的换行会被压成一个空格，夹在中文句号后面很扎眼 -->
      <br />
      为免覆盖原文件，这里暂时不能添加、修改、启停或删除 MCP 服务器；修好后回到这页即可。
    </p>
    <p v-if="!list.length && !chat.mcpServers.configError" class="f-note">还没有配置 MCP 服务器。</p>
    <div v-for="s in list" :key="s.name" class="mrow">
      <label class="f-switch" :title="s.enabled ? '停用' : '启用'">
        <input type="checkbox" :checked="s.enabled" @change="onToggle(s, $event)" />
        <i></i>
      </label>
      <span class="minfo">
        <span class="mname">{{ s.name }}</span>
        <span class="mmeta t-aux">{{ s.transport === 'stdio' ? (s.command || '（未填命令）') : (s.url || '（未填地址）') }}</span>
      </span>
      <span
        v-if="statusOf(s.name)" class="f-tag"
        :class="{ ok: statusOf(s.name)!.status === 'connected', err: statusOf(s.name)!.status === 'error' }"
        :title="statusOf(s.name)!.lastError || ''"
      >
        {{ statusOf(s.name)!.status === 'connected' ? `${statusOf(s.name)!.toolCount} 个工具`
           : statusOf(s.name)!.status === 'error' ? '连不上' : '空闲' }}
      </span>
      <button class="f-btn ghost" type="button" @click="startEdit(s)">编辑</button>
      <template v-if="confirming === s.name">
        <span class="f-confirm">删掉？</span>
        <button class="f-btn danger" type="button" @click="remove(s.name)">确认删除</button>
        <button class="f-btn ghost" type="button" @click="confirming = ''">取消</button>
      </template>
      <button v-else class="f-btn danger" type="button" @click="confirming = s.name"><UiIcon name="trash" :size="14" /></button>
    </div>

    <!-- 行内操作（开关 / 删除）的错误：表单关着时表单里那条 err 行不渲染，失败就成了「点了没反应」 -->
    <p v-if="err && !open" class="errline">{{ err }}</p>

    <!-- 配置读坏时后端拒绝写入，添加按钮留着只会让人填完一整张表才被拒 -->
    <button v-if="!open && !chat.mcpServers.configError" class="f-btn" type="button" @click="startNew"><UiIcon name="plus" :size="14" />添加服务器</button>

    <form v-if="open" class="f-card" @submit.prevent="submit">
      <div class="f-grid">
        <label class="f-label">
          <span>名称</span>
          <input v-model="form.name" class="f-input" placeholder="如 filesystem" required />
        </label>
        <label class="f-label">
          <span>连接方式</span>
          <select v-model="form.transport" class="f-select">
            <option value="stdio">stdio（本地进程）</option>
            <option value="streamable-http">streamable-http（远端）</option>
          </select>
        </label>
      </div>

      <template v-if="form.transport === 'stdio'">
        <label class="f-label">
          <span>命令</span>
          <input v-model="form.command" class="f-input" placeholder="如 npx" required />
        </label>
        <label class="f-label">
          <span>参数</span>
          <input v-model="form.args" class="f-input" placeholder="空格分隔，如 -y @modelcontextprotocol/server-filesystem D:\\work" />
          <span class="f-hint">按空格切分。要带空格的参数请直接改 servers.json。</span>
        </label>
      </template>
      <label v-else class="f-label">
        <span>URL</span>
        <input v-model="form.url" class="f-input" placeholder="如 https://mcp.example.com/sse" required />
      </label>

      <label class="f-label">
        <span>备注（可选）</span>
        <input v-model="form.note" class="f-input" placeholder="给自己留一句：这台是干什么的" />
      </label>

      <p v-if="err" class="errline">{{ err }}</p>
      <p v-if="testResult[form.name.trim() || '__new__']" class="testline t-aux">
        {{ testResult[form.name.trim() || '__new__'] }}
      </p>
      <div class="f-row">
        <button class="f-btn primary" type="submit">{{ editingName ? '保存' : '添加' }}</button>
        <button class="f-btn" type="button" :disabled="!!testing" @click="test">{{ testing ? '试连中…' : '试连接' }}</button>
        <button class="f-btn ghost" type="button" @click="cancel">取消</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.mrow {
  display: flex; align-items: center; gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4); background: var(--c-bg);
  border: 1px solid var(--c-line); border-radius: var(--r-s);
}
.minfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.mname { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.mmeta { color: var(--c-ink-3); font-family: var(--f-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
.testline { margin: 0; color: var(--c-ink-2); }
.cfgerr {
  margin: 0; padding: var(--sp-4) var(--sp-5); border-radius: var(--r-s);
  background: var(--c-err-soft); color: var(--c-err);
}
</style>
