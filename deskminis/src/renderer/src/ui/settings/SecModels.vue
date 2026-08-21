<script setup lang="ts">
/** T5：模型 provider 配置。**这一节是应用能不能用的开关**——T 波换壳时它被留成占位，
 *  等于装好的应用配不了模型。
 *
 *  界面重做，但四条来之不易的逻辑原样保留（它们是踩出来的，不是设计出来的）：
 *  ① 密钥永不回显：列表只显示「已配密钥」，编辑时留空 = 不改；
 *  ② baseUrl 留空传 undefined 而不是空串（空串会被存下来，anthropic 拼出相对地址直接失败）；
 *  ③ base URL 里已含 /chat/completions 或 /v1/messages 时先警告——我们会再接一次，
 *     实际请求 404，但特殊网关确实存在，故是「再确认一次」而不是硬拦；
 *  ④ 取模型列表失败静默：手输是一等路径，弹错误反而打扰。 */
import { computed, reactive, ref, watch } from 'vue';
import { useChat } from '../../stores/chat';
import UiIcon from '../UiIcon.vue';

const chat = useChat();
type Kind = 'anthropic' | 'openai-compat' | 'gemini' | 'ollama';
const KINDS: { v: Kind; label: string; hint: string }[] = [
  { v: 'anthropic', label: 'Anthropic', hint: 'baseUrl 可留空，用官方端点' },
  { v: 'openai-compat', label: 'OpenAI 兼容', hint: '大多数第三方网关走这条，baseUrl 必填' },
  { v: 'gemini', label: 'Gemini', hint: 'Google AI Studio' },
  { v: 'ollama', label: 'Ollama', hint: '本地端点，免 API Key' },
];

const blank = { name: '', kind: 'openai-compat' as Kind, baseUrl: '', modelId: '', apiKey: '' };
const form = reactive({ ...blank });
const editingId = ref('');
const open = ref(false);
const err = ref('');
const forced = ref(false);
const modelOptions = ref<string[]>([]);
const fetching = ref(false);
const confirming = ref('');

const editing = computed(() => editingId.value !== '');
const needKey = computed(() => form.kind !== 'ollama');

const urlWarning = computed(() => {
  const b = form.baseUrl.trim();
  if (!b) return '';
  if (form.kind === 'openai-compat' && /chat\/completions/i.test(b)) {
    return 'base URL 里已经包含 chat/completions。DeskMinis 会在它后面再接一次，实际请求会变成 …/chat/completions/chat/completions（多半 404）。通常填到 /v1 就够了。';
  }
  if (form.kind === 'anthropic' && /\/v1\/messages/i.test(b)) {
    return 'base URL 里已经包含 /v1/messages。DeskMinis 会再接一次 /v1/messages，请求路径会重复。通常填到域名就够了。';
  }
  return '';
});
watch(() => [form.baseUrl, form.kind], () => { forced.value = false; });

const submitLabel = computed(() => {
  if (urlWarning.value && !forced.value) return editing.value ? '仍然保存' : '仍然添加';
  return editing.value ? '保存' : '添加';
});

function startNew(): void {
  Object.assign(form, blank);
  editingId.value = ''; err.value = ''; forced.value = false; modelOptions.value = []; open.value = true;
}
function startEdit(p: Record<string, unknown>): void {
  err.value = ''; forced.value = false; modelOptions.value = [];
  editingId.value = String(p.id);
  form.name = String(p.name ?? '');
  form.kind = (p.kind as Kind) ?? 'openai-compat';
  form.baseUrl = String(p.baseUrl ?? '');
  form.modelId = String(p.modelId ?? '');
  form.apiKey = '';                       // 密钥永不回显
  open.value = true;
}
function cancel(): void { open.value = false; editingId.value = ''; err.value = ''; forced.value = false; Object.assign(form, blank); }

async function submit(): Promise<void> {
  err.value = '';
  if (urlWarning.value && !forced.value) { forced.value = true; return; }
  try {
    const payload = { ...form, baseUrl: form.baseUrl.trim() || undefined };
    if (editing.value) await chat.updateProvider(editingId.value, payload);
    else await chat.createProvider(payload);
    cancel();
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}

async function remove(id: string): Promise<void> {
  err.value = ''; confirming.value = '';
  try { await chat.deleteProvider(id); if (editingId.value === id) cancel(); }
  catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}

async function fetchModels(): Promise<void> {
  if (fetching.value) return;
  fetching.value = true;
  try {
    const r = editing.value && !form.apiKey
      ? await chat.fetchProviderModels({ id: editingId.value })
      : await chat.fetchProviderModels({ kind: form.kind, baseUrl: form.baseUrl.trim() || undefined, apiKey: form.apiKey || undefined });
    modelOptions.value = Array.isArray(r?.models) ? r.models : [];
  } catch {
    modelOptions.value = [];        // 静默：手输是一等路径
  } finally { fetching.value = false; }
}
</script>

<template>
  <section class="f-sec">
    <h2>模型</h2>
    <p class="f-note">配置一个 provider 才能开始对话。密钥存在本机，界面永远不回显。</p>

    <div v-if="!chat.providers.length && !open" class="blank">
      <UiIcon name="robot" :size="26" />
      <p class="t-h2">还没有配置模型</p>
      <p class="t-body sub">加一个 provider——填地址、密钥和模型 id 就能用。</p>
      <button class="f-btn primary" type="button" @click="startNew">添加 provider</button>
    </div>

    <div v-for="p in chat.providers" :key="p.id" class="prow" :class="{ on: p.id === chat.defaultProviderId }">
      <button
        class="pick" type="button" :title="p.id === chat.defaultProviderId ? '当前默认' : '设为默认'"
        :aria-pressed="p.id === chat.defaultProviderId" @click="chat.setDefaultProvider(p.id)"
      >
        <UiIcon :name="p.id === chat.defaultProviderId ? 'check' : 'chevronRight'" :size="15" />
      </button>
      <span class="pinfo">
        <span class="pname">{{ p.name }}</span>
        <span class="pmeta t-aux">{{ p.kind }} · {{ p.modelId || '未指定模型' }}</span>
      </span>
      <span v-if="p.hasApiKey" class="f-tag ok">已配密钥</span>
      <span v-else-if="p.kind !== 'ollama'" class="f-tag err">缺密钥</span>
      <button class="f-btn ghost" type="button" @click="startEdit(p)">编辑</button>
      <template v-if="confirming === p.id">
        <span class="f-confirm">删掉？</span>
        <button class="f-btn danger" type="button" @click="remove(p.id)">确认删除</button>
        <button class="f-btn ghost" type="button" @click="confirming = ''">取消</button>
      </template>
      <button v-else class="f-btn danger" type="button" @click="confirming = p.id">删除</button>
    </div>

    <button v-if="chat.providers.length && !open" class="f-btn" type="button" @click="startNew">
      <UiIcon name="plus" :size="14" />添加 provider
    </button>

    <form v-if="open" class="f-card" @submit.prevent="submit">
      <div class="f-grid">
        <label class="f-label">
          <span>名称</span>
          <input v-model="form.name" class="f-input" placeholder="给这个配置起个名，如「工作号」" required />
        </label>
        <label class="f-label">
          <span>类型</span>
          <select v-model="form.kind" class="f-select">
            <option v-for="k in KINDS" :key="k.v" :value="k.v">{{ k.label }}</option>
          </select>
          <span class="f-hint">{{ KINDS.find(k => k.v === form.kind)?.hint }}</span>
        </label>
      </div>

      <label class="f-label">
        <span>base URL</span>
        <input
          v-model="form.baseUrl" class="f-input"
          :placeholder="form.kind === 'anthropic' ? '可留空，默认 https://api.anthropic.com' : '如 https://api.openai.com/v1'"
        />
        <span v-if="urlWarning" class="warn">{{ urlWarning }}</span>
      </label>

      <div class="f-grid">
        <label class="f-label">
          <span>模型 id</span>
          <span class="mrow">
            <input v-model="form.modelId" class="f-input" list="modelopts" placeholder="如 gpt-4o / claude-sonnet-4" required />
            <button class="f-btn" type="button" :disabled="fetching" @click="fetchModels">
              {{ fetching ? '获取中…' : '取列表' }}
            </button>
          </span>
          <datalist id="modelopts"><option v-for="m in modelOptions" :key="m" :value="m" /></datalist>
          <span v-if="modelOptions.length" class="f-hint">拉到 {{ modelOptions.length }} 个，点输入框选</span>
        </label>
        <label class="f-label">
          <span>API Key{{ needKey ? '' : '（Ollama 免填）' }}</span>
          <input v-model="form.apiKey" class="f-input" type="password" autocomplete="off" :placeholder="editing ? '留空 = 保持原密钥不变' : (needKey ? '必填' : '可留空')" />
          <span class="f-hint">存在本机，界面不回显。{{ editing ? '要换密钥才需要重填。' : '' }}</span>
        </label>
      </div>

      <p v-if="err" class="errline">{{ err }}</p>
      <div class="f-row">
        <button class="f-btn primary" type="submit">{{ submitLabel }}</button>
        <button class="f-btn ghost" type="button" @click="cancel">取消</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.blank {
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-3);
  padding: var(--sp-8); text-align: center; color: var(--c-ink-3);
  background: var(--c-bg-1); border-radius: var(--r-m);
}
.blank p { margin: 0; }
.blank .t-h2 { color: var(--c-ink); }
.blank .sub { max-width: 340px; }

.prow {
  display: flex; align-items: center; gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4) var(--sp-3) var(--sp-2);
  border: 1px solid var(--c-line); border-radius: var(--r-s); background: var(--c-bg);
}
.prow.on { border-color: var(--c-brand-line); background: var(--c-brand-soft); }
.pick {
  width: 28px; height: 28px; flex: 0 0 auto; border-radius: var(--r-s);
  display: inline-flex; align-items: center; justify-content: center;
  background: none; cursor: pointer; color: var(--c-ink-4);
}
.prow.on .pick { color: var(--c-brand); }
.pick:hover { background: var(--c-bg-2); }
.pinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pname { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.pmeta { color: var(--c-ink-3); font-family: var(--f-mono); }

.mrow { display: flex; gap: var(--sp-3); align-items: center; }
.warn {
  font-size: var(--t-aux-size); line-height: var(--t-aux-lh); color: var(--c-warn);
  background: var(--c-warn-soft); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-s);
}
.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
</style>
