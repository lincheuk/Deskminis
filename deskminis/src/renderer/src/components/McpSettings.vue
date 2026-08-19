<script setup lang="ts">
/** 设置 · MCP（D6）。
 *
 *  为什么有这个页面：D2-D5 建成了 MCP 配置层/stdio/http/manager/权限/RPC，
 *  但渲染端零入口——servers.json 只能手编，手编笔误只能靠猜。本页消费
 *  既有四 RPC（list/upsert/remove/toggle）+ 本步新增的 mcp.servers.test（试连）
 *  与 list 的 configError 布尔。页面形态/类名习惯照 SkillsSettings.vue。
 *
 *  两处刻意的取舍：
 *  ① 试连不进 manager 运行时——后端用独立临时 client，connect+listTools 后即 dispose，
 *     不注册工具、不影响 run 期状态；完整条目形态也不落库（scratch 校验后即弃）。
 *  ② configError 只拿到布尔——loadError 原文可能带文件片段（内含明文 headers），
 *     页顶警示条用固定文案，绝不回显解析原文（D2 审核备忘的脱敏落实）。
 *
 *  Vue 结构红线（MU6 血案）：v-for 一律挂 <template> 包裹兄弟节点，
 *  绝不直接挂带 scoped 类名的元素；scoped 类名用 mx- 前缀避让既有组件（MU5 撞车前科）。 */
import { onMounted, reactive, ref } from 'vue';
import { useChat } from '../stores/chat';

const chat = useChat();

onMounted(() => { void chat.fetchMcpServers(); });

/** 状态点三态文案（idle 灰 / connected 绿 / error 红，着色在 scoped 样式） */
const STATUS_TEXT: Record<string, string> = { 'idle': '未连接', 'connected': '已连接', 'error': '连接失败' };

function statusOf(name: string) {
  return chat.mcpServers.statuses.find(s => s.name === name);
}

// ---- 表单模型 ----
interface KvPair { id: number; k: string; v: string }
let kvSeq = 0;
const mkPair = (k = '', v = ''): KvPair => ({ id: ++kvSeq, k, v });

/** editing：null=表单收起；''=新建；否则=正在编辑的服务器名。
 *  编辑时名称锁定——upsert 以 name 为键，允许改名等于「删旧建新」，本页不做这种隐式破坏。 */
const editing = ref<string | null>(null);
const form = reactive({
  name: '',
  transport: 'stdio' as 'stdio' | 'streamable-http',
  command: '',
  argsText: '', // 一行一个参数
  envPairs: [] as KvPair[],
  url: '',
  headerPairs: [] as KvPair[],
  note: '',
  timeoutText: '', // startupTimeoutSeconds，空=后端默认
});
const formError = ref('');
const formBusy = ref(false);
/** 表单内试连结果（内联，不弹窗） */
const formTest = ref<{ ok: boolean; text: string } | null>(null);
/** 列表行试连结果：按服务器名内联 */
const rowTests = reactive<Record<string, { ok: boolean; text: string }>>({});
const rowTesting = ref('');
/** 删除二次确认态（同技能页红线：破坏性操作必须二次确认，且「取消」排在危险项之前） */
const confirmRemove = ref('');

function pairsToRecord(pairs: KvPair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const p of pairs) if (p.k.trim() !== '') out[p.k.trim()] = p.v;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 表单值 → 完整条目（upsert 与 test 的「保存前试连」形态共用）。
 *  空 command/url 不下发——由后端归一校验翻译成中文错误（「必须提供 command/url」）。 */
function buildEntry(): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: form.name.trim(),
    type: form.transport === 'stdio' ? 'stdio' : 'http',
  };
  if (form.transport === 'stdio') {
    if (form.command.trim() !== '') p.command = form.command.trim();
    const args = form.argsText.split('\n').map(s => s.trim()).filter(s => s !== '');
    if (args.length > 0) p.args = args;
    const env = pairsToRecord(form.envPairs);
    if (env) p.env = env;
  } else {
    if (form.url.trim() !== '') p.url = form.url.trim();
    const headers = pairsToRecord(form.headerPairs);
    if (headers) p.headers = headers;
  }
  if (form.note.trim() !== '') p.note = form.note.trim();
  const t = Number(form.timeoutText);
  if (form.timeoutText.trim() !== '' && Number.isFinite(t) && t > 0) p.startupTimeoutSeconds = t;
  return p;
}

function resetForm(): void {
  form.name = ''; form.transport = 'stdio';
  form.command = ''; form.argsText = ''; form.envPairs = [];
  form.url = ''; form.headerPairs = [];
  form.note = ''; form.timeoutText = '';
  formError.value = ''; formTest.value = null;
}

function openCreate(): void { editing.value = ''; resetForm(); }

function openEdit(name: string): void {
  const s = chat.mcpServers.servers.find(x => x.name === name);
  if (!s) return;
  editing.value = name;
  form.name = s.name;
  form.transport = s.transport;
  form.command = s.command ?? '';
  form.argsText = (s.args ?? []).join('\n');
  form.envPairs = Object.entries(s.env ?? {}).map(([k, v]) => mkPair(k, v));
  form.url = s.url ?? '';
  form.headerPairs = Object.entries(s.headers ?? {}).map(([k, v]) => mkPair(k, v));
  form.note = s.note ?? '';
  form.timeoutText = s.startupTimeoutSeconds !== undefined ? String(s.startupTimeoutSeconds) : '';
  formError.value = ''; formTest.value = null;
}

function testResultText(r: { ok: boolean; toolCount?: number; elapsedMs?: number; error?: string }): { ok: boolean; text: string } {
  return r.ok
    ? { ok: true, text: `✓ 连接成功，${r.toolCount ?? 0} 个工具（${r.elapsedMs ?? 0} ms）` }
    : { ok: false, text: `✗ ${r.error ?? '未知错误'}` };
}

async function onSave(): Promise<void> {
  formError.value = '';
  formBusy.value = true;
  try {
    await chat.upsertMcpServer(buildEntry());
    editing.value = null;
  } catch (e) {
    // 后端归一校验的中文错误（名称空/缺 command/缺 url…）内联展示，不静默吞掉
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    formBusy.value = false;
  }
}

async function onTestForm(): Promise<void> {
  formTest.value = null;
  formBusy.value = true;
  try {
    formTest.value = testResultText(await chat.testMcpServer(buildEntry()));
  } catch (e) {
    formTest.value = { ok: false, text: `✗ ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    formBusy.value = false;
  }
}

async function onTestRow(name: string): Promise<void> {
  rowTesting.value = name;
  try {
    rowTests[name] = testResultText(await chat.testMcpServer({ name }));
  } catch (e) {
    rowTests[name] = { ok: false, text: `✗ ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    rowTesting.value = '';
  }
}

async function onRemove(name: string): Promise<void> {
  await chat.removeMcpServer(name);
  confirmRemove.value = '';
}
</script>

<template>
  <div class="mxs">
    <!-- configError 警示条：固定文案，不回显解析原文（脱敏红线） -->
    <div v-if="chat.mcpServers.configError" class="mxwarn">
      servers.json 解析失败，已按空配置加载——请检查文件语法
    </div>

    <div class="mxnote">
      MCP 服务器为 agent 提供外部工具，连接在对话开始时按需建立。
      这里的启停是<strong>全局</strong>的——对所有会话生效。
    </div>

    <!-- 服务器列表：含停用项（管理页必须看得见停用的，否则关掉就找不回来了） -->
    <div v-if="!chat.mcpServers.servers.length" class="mxempty">还没有配置任何 MCP 服务器。</div>
    <template v-for="s in chat.mcpServers.servers" :key="s.name">
      <div class="mxrow" :class="{ mxoff: !s.enabled }">
        <span
          class="mxdot" :class="statusOf(s.name)?.status ?? 'idle'"
          :title="STATUS_TEXT[statusOf(s.name)?.status ?? 'idle']"
        ></span>
        <div class="mxmain">
          <div class="mxname">
            {{ s.name }}
            <span class="mxbadge">{{ s.transport === 'stdio' ? 'stdio' : 'http' }}</span>
            <span v-if="(statusOf(s.name)?.toolCount ?? 0) > 0" class="mxtools">{{ statusOf(s.name)?.toolCount }} 个工具</span>
          </div>
          <div v-if="statusOf(s.name)?.status === 'error'" class="mxerr">{{ statusOf(s.name)?.lastError }}</div>
          <div v-if="rowTests[s.name]" class="mxtest" :class="{ mxok: rowTests[s.name].ok }">{{ rowTests[s.name].text }}</div>
        </div>
        <button class="mxtestbtn" type="button" :disabled="rowTesting === s.name" @click="onTestRow(s.name)">
          {{ rowTesting === s.name ? '测试中…' : '测试连接' }}
        </button>
        <button
          class="mxtoggle" type="button" :class="{ mxon: s.enabled }"
          :title="s.enabled ? '停用（全局）' : '启用（全局）'"
          @click="chat.toggleMcpServer(s.name, !s.enabled)"
        >{{ s.enabled ? '已启用' : '已停用' }}</button>
        <button class="mxedit" type="button" @click="openEdit(s.name)">编辑</button>
        <template v-if="confirmRemove !== s.name">
          <button class="mxdel" type="button" title="删除服务器" @click="confirmRemove = s.name">删除</button>
        </template>
        <template v-else>
          <button class="mxkeep" type="button" @click="confirmRemove = ''">取消</button>
          <button class="mxdel mxdanger" type="button" @click="onRemove(s.name)">确认删除</button>
        </template>
      </div>
    </template>

    <!-- 添加/编辑表单 -->
    <div v-if="editing === null" class="mxaddrow">
      <button class="mxadd" type="button" @click="openCreate">添加服务器…</button>
    </div>
    <div v-else class="mxform">
      <div class="mxftitle">{{ editing === '' ? '添加服务器' : `编辑：${editing}` }}</div>

      <label class="mxflabel" for="mcp-f-name">名称</label>
      <input
        id="mcp-f-name" v-model="form.name" class="mxinput" type="text"
        :disabled="editing !== ''" placeholder="唯一标识，如 filesystem"
      />

      <label class="mxflabel">类型</label>
      <div class="mxtypes">
        <button type="button" class="mxtype" :class="{ mxon: form.transport === 'stdio' }" @click="form.transport = 'stdio'">stdio（本地子进程）</button>
        <button type="button" class="mxtype" :class="{ mxon: form.transport === 'streamable-http' }" @click="form.transport = 'streamable-http'">http（远程端点）</button>
      </div>

      <template v-if="form.transport === 'stdio'">
        <label class="mxflabel" for="mcp-f-command">command</label>
        <input id="mcp-f-command" v-model="form.command" class="mxinput mxmono" type="text" placeholder="可执行文件，如 npx / uvx / 绝对路径" />
        <label class="mxflabel" for="mcp-f-args">args（一行一个参数）</label>
        <textarea id="mcp-f-args" v-model="form.argsText" class="mxta mxmono" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem"></textarea>
        <label class="mxflabel">env（键值对）</label>
        <template v-for="p in form.envPairs" :key="p.id">
          <div class="mxkvrow">
            <input v-model="p.k" class="mxinput mxmono" type="text" placeholder="变量名" />
            <input v-model="p.v" class="mxinput mxmono" type="text" placeholder="值" />
            <button class="mxkvdel" type="button" title="删除该行" @click="form.envPairs = form.envPairs.filter(x => x.id !== p.id)">×</button>
          </div>
        </template>
        <button class="mxkvadd" type="button" @click="form.envPairs.push(mkPair())">+ 添加环境变量</button>
        <div class="mxhint">敏感值建议填 $$环境变量名（发起连接时才解析）</div>
      </template>

      <template v-else>
        <label class="mxflabel" for="mcp-f-url">url</label>
        <input id="mcp-f-url" v-model="form.url" class="mxinput mxmono" type="text" placeholder="https://example.com/mcp" />
        <label class="mxflabel">headers（键值对）</label>
        <template v-for="p in form.headerPairs" :key="p.id">
          <div class="mxkvrow">
            <input v-model="p.k" class="mxinput mxmono" type="text" placeholder="Header 名" />
            <input v-model="p.v" class="mxinput mxmono" type="text" placeholder="值" />
            <button class="mxkvdel" type="button" title="删除该行" @click="form.headerPairs = form.headerPairs.filter(x => x.id !== p.id)">×</button>
          </div>
        </template>
        <button class="mxkvadd" type="button" @click="form.headerPairs.push(mkPair())">+ 添加 Header</button>
        <div class="mxhint">敏感值建议填 $$环境变量名（发起连接时才解析）</div>
      </template>

      <label class="mxflabel" for="mcp-f-note">备注</label>
      <input id="mcp-f-note" v-model="form.note" class="mxinput" type="text" placeholder="可选，给自己看的说明" />

      <details class="mxadv">
        <summary>高级</summary>
        <label class="mxflabel" for="mcp-f-timeout">启动超时（秒）</label>
        <input id="mcp-f-timeout" v-model="form.timeoutText" class="mxinput" type="number" min="1" placeholder="默认 30" />
      </details>

      <div v-if="formError" class="mxferr">{{ formError }}</div>
      <div v-if="formTest" class="mxtest" :class="{ mxok: formTest.ok }">{{ formTest.text }}</div>

      <div class="mxbtns">
        <button class="mxcancel" type="button" @click="editing = null">取消</button>
        <button class="mxtestbtn" type="button" :disabled="formBusy" @click="onTestForm">测试连接</button>
        <button class="mxsave" type="button" :disabled="formBusy" @click="onSave">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mxs { display: flex; flex-direction: column; gap: 10px; }
/* configError 警示条：固定文案（脱敏），视觉对齐同步页的命门文案条 */
.mxwarn {
  padding: 8px 12px; border-radius: var(--r-card);
  border: .5px solid var(--state-warn); background: var(--grouped-bg-secondary);
  font-size: var(--fs-micro); line-height: 1.6; color: var(--state-warn);
}
.mxnote { font-size: var(--fs-ui); line-height: 1.7; color: var(--label-secondary); }
.mxnote strong { color: var(--label); font-weight: 600; }
.mxempty { font-size: var(--fs-ui); color: var(--label-tertiary); padding: 12px 0; }

/* 列表行（形态对齐技能页：状态点 + 主区 + 操作钮排） */
/* E3（Aurora §4）：服务器行浮岛化——顶缘高光 + 柔影；实心材质不用 blur */
.mxrow {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-radius: var(--r-card);
  border: .5px solid var(--separator); background: var(--surface-1);
  box-shadow: inset 0 1px 0 var(--glass-edge), 0 2px 8px var(--shadow-color);
}
.mxrow.mxoff { opacity: .62; }
.mxdot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--label-quaternary); }
.mxdot.connected { background: var(--state-ok); }
.mxdot.error { background: var(--state-err); }
.mxmain { flex: 1; min-width: 0; }
.mxname {
  display: flex; align-items: center; gap: 8px;
  font-size: var(--fs-ui); font-weight: 600; color: var(--label);
}
.mxbadge {
  font-size: var(--fs-micro); font-weight: 400; color: var(--label-tertiary);
  border: .5px solid var(--separator); border-radius: var(--r-control); padding: 0 6px;
}
/* E3：工具数是「计数读数」，走 mono（Aurora §4 读数面） */
.mxtools { font-size: var(--fs-micro); font-weight: 400; color: var(--label-tertiary); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.mxerr { margin-top: 2px; font-size: var(--fs-micro); line-height: 1.5; color: var(--state-err); }
.mxtest { margin-top: 2px; font-size: var(--fs-micro); line-height: 1.5; color: var(--state-err); }
.mxtest.mxok { color: var(--state-ok); }

.mxtestbtn, .mxedit, .mxkeep {
  flex: 0 0 auto; padding: 4px 10px; border-radius: var(--r-control);
  border: .5px solid var(--separator); background: none;
  font-size: var(--fs-micro); color: var(--label-secondary); cursor: pointer; white-space: nowrap;
}
.mxtestbtn:disabled { color: var(--label-quaternary); cursor: default; }
.mxtoggle {
  flex: 0 0 auto; padding: 4px 12px; border-radius: var(--r-pill);
  border: .5px solid var(--separator); background: none;
  font-size: var(--fs-micro); color: var(--label-secondary); cursor: pointer; white-space: nowrap;
}
.mxtoggle.mxon { border-color: var(--state-ok); color: var(--state-ok); }
.mxdel {
  flex: 0 0 auto; padding: 4px 10px; border: none; border-radius: var(--r-control); background: none;
  font-size: var(--fs-micro); color: var(--label-tertiary); cursor: pointer; white-space: nowrap;
}
.mxdel:hover, .mxdel.mxdanger { color: var(--state-err); }
.mxdel.mxdanger { background: var(--state-err-bg); }
.mxtestbtn:focus-visible, .mxtoggle:focus-visible, .mxedit:focus-visible,
.mxdel:focus-visible, .mxkeep:focus-visible, .mxtype:focus-visible,
.mxkvadd:focus-visible, .mxkvdel:focus-visible, .mxsave:focus-visible,
.mxcancel:focus-visible, .mxadd:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

.mxaddrow { display: flex; }
.mxadd {
  padding: 7px 16px; border-radius: var(--r-control);
  border: .5px solid var(--separator); background: var(--surface-1);
  font-size: var(--fs-ui); color: var(--label); cursor: pointer;
}
.mxadd:hover { background: var(--fill-quaternary); }

/* 添加/编辑表单（卡片化，对齐技能页导入卡） */
/* E3：表单卡浮岛化——顶缘高光 + 柔影 */
.mxform {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px; border-radius: var(--r-card);
  background: var(--grouped-bg-secondary); border: .5px solid var(--separator);
  box-shadow: inset 0 1px 0 var(--glass-edge), 0 2px 8px var(--shadow-color);
}
.mxftitle { font-size: var(--fs-ui); font-weight: 700; color: var(--label); margin-bottom: 4px; }
.mxflabel { font-size: var(--fs-micro); font-weight: 600; color: var(--label-secondary); margin-top: 4px; }
.mxinput {
  width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: var(--r-control);
  border: .5px solid var(--separator); background: var(--surface-1);
  color: var(--label); font-size: var(--fs-ui);
}
.mxinput:disabled { color: var(--label-tertiary); }
.mxmono { font-family: var(--font-mono); }
.mxinput:focus-visible, .mxta:focus-visible { outline: 2px solid var(--ring-input); outline-offset: 1px; }
.mxta {
  width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: var(--r-control);
  border: .5px solid var(--separator); background: var(--surface-1);
  color: var(--label); font-size: var(--fs-ui); resize: vertical;
}
.mxtypes { display: flex; gap: 8px; }
.mxtype {
  flex: 1; padding: 7px 10px; border-radius: var(--r-control);
  border: .5px solid var(--separator); background: var(--surface-1);
  font-size: var(--fs-ui); color: var(--label-secondary); cursor: pointer;
}
.mxtype.mxon { border-color: var(--action); color: var(--label); font-weight: 600; }
.mxkvrow { display: flex; gap: 6px; align-items: center; }
.mxkvrow .mxinput { flex: 1; min-width: 0; }
.mxkvdel {
  flex: 0 0 auto; width: 26px; height: 26px; border: none; border-radius: var(--r-control);
  background: none; color: var(--label-tertiary); cursor: pointer; font-size: var(--fs-ui);
}
.mxkvdel:hover { color: var(--state-err); }
.mxkvadd {
  align-self: flex-start; padding: 4px 10px; border: .5px dashed var(--separator); border-radius: var(--r-control);
  background: none; font-size: var(--fs-micro); color: var(--label-secondary); cursor: pointer;
}
.mxhint { font-size: var(--fs-micro); line-height: 1.6; color: var(--label-tertiary); }
.mxadv { margin-top: 4px; font-size: var(--fs-micro); color: var(--label-secondary); }
.mxadv summary { cursor: pointer; font-weight: 600; }
.mxferr { font-size: var(--fs-micro); line-height: 1.6; color: var(--state-err); }
.mxbtns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.mxcancel {
  padding: 7px 14px; border-radius: var(--r-control);
  border: .5px solid var(--separator); background: var(--surface-1);
  font-size: var(--fs-ui); color: var(--label); cursor: pointer;
}
/* E3：主钮青底——accent 底 + on-action 字（§4），两主题自动对 */
.mxsave {
  padding: 7px 16px; border-radius: var(--r-control); border: none;
  background: var(--accent); color: var(--on-action);
  font-size: var(--fs-ui); font-weight: 600; cursor: pointer;
}
.mxsave:disabled { background: var(--label-quaternary); cursor: default; }
</style>
