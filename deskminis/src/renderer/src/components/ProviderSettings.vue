<script setup lang="ts">
/** 模型 provider 设置（右栏可达）——列出已配置实例、新增/编辑/删除。
 *  anthropic 留空 baseUrl → 传 undefined（用默认端点）；openai-compat 必填 baseUrl（后端强校验）。
 *  绝不回显密钥（列表只用 hasApiKey 标识；编辑时留空 = 不改密钥）。 */
import { computed, reactive, ref, watch } from 'vue';
import { useChat } from '../stores/chat';
import Icon from './Icon.vue';

const chat = useChat();
const blank = { name: '', kind: 'openai-compat' as 'anthropic' | 'openai-compat', baseUrl: '', modelId: '', apiKey: '' };
const form = reactive({ ...blank });
const editingId = ref('');
const err = ref('');
/** 路径重复只是「多半错了」，不是一定错：确认过一次就放行，以便对付特殊网关。 */
const forced = ref(false);

const editing = computed(() => editingId.value !== '');

const baseUrlPlaceholder = computed(() =>
  form.kind === 'anthropic'
    ? 'base URL（可留空，默认 https://api.anthropic.com）'
    : 'base URL（如 https://api.openai.com/v1）',
);

/** DeskMinis 请求时会自己接上 /chat/completions（或 /v1/messages）。
 *  用户把完整端点填进来就会拼成 …/chat/completions/chat/completions → 404。 */
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

// 地址或类型一变，之前的「强行确认」就作废，避免改成另一个可疑地址后被静默放行
watch(() => [form.baseUrl, form.kind], () => { forced.value = false; });

const submitLabel = computed(() => {
  if (urlWarning.value && !forced.value) return editing.value ? '仍然保存' : '仍然添加';
  return editing.value ? '保存' : '添加';
});

function startEdit(p: { id: string; name: string; kind: 'anthropic' | 'openai-compat'; baseUrl?: string; modelId: string }): void {
  err.value = ''; forced.value = false;
  editingId.value = p.id;
  form.name = p.name; form.kind = p.kind; form.baseUrl = p.baseUrl ?? ''; form.modelId = p.modelId;
  form.apiKey = ''; // 密钥永不回显；留空 = 保持不变
}

function cancel(): void {
  editingId.value = ''; err.value = ''; forced.value = false;
  Object.assign(form, blank);
}

async function submit(): Promise<void> {
  err.value = '';
  // 第一次点：只把警告转成需要再确认一次；第二次点才真的提交
  if (urlWarning.value && !forced.value) { forced.value = true; return; }
  try {
    // 空串会被原样存成 baseUrl=''：anthropic 那边拼出相对地址、请求直接失败。
    // 留空 = 用 provider 默认端点，必须传 undefined 而不是 ''。
    const payload = { ...form, baseUrl: form.baseUrl.trim() || undefined };
    if (editing.value) await chat.updateProvider(editingId.value, payload);
    else await chat.createProvider(payload);
    cancel();
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}

async function remove(id: string): Promise<void> {
  err.value = '';
  try {
    await chat.deleteProvider(id);
    if (editingId.value === id) cancel();
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
</script>

<template>
  <div class="settings">
    <div class="title3">模型设置</div>

    <div class="group">
      <div v-if="!chat.providers.length" class="hint">尚未配置任何模型 provider。</div>
      <div v-for="p in chat.providers" :key="p.id" class="prow" :class="{ on: p.id === editingId }">
        <div class="pinfo">
          <div class="pname">{{ p.name }}<span v-if="p.id === chat.defaultProviderId" class="badge">默认</span></div>
          <div class="pmodel">{{ p.modelId || p.kind }}<span v-if="!p.hasApiKey" class="miss"> · 缺密钥</span></div>
        </div>
        <button class="act" title="编辑" @click="startEdit(p)"><Icon name="edit" :size="15" /></button>
        <button class="act del" title="删除" @click="remove(p.id)"><Icon name="trash" :size="15" /></button>
      </div>
    </div>

    <div class="grouphead">{{ editing ? '编辑 provider' : '添加 provider' }}</div>
    <div class="group form">
      <input v-model="form.name" class="inp" placeholder="名称（如 我的中继）" />
      <select v-model="form.kind" class="inp">
        <option value="openai-compat">OpenAI 兼容</option>
        <option value="anthropic">Anthropic</option>
      </select>
      <input v-model="form.baseUrl" class="inp" :class="{ warn: urlWarning }" :placeholder="baseUrlPlaceholder" />
      <div v-if="urlWarning" class="warnmsg">
        <Icon name="shield" :size="14" /><span>{{ urlWarning }}</span>
      </div>
      <input v-model="form.modelId" class="inp" placeholder="模型 ID（如 claude-sonnet-5）" />
      <input
        v-model="form.apiKey" class="inp" type="password"
        :placeholder="editing ? 'API Key（留空 = 不修改）' : 'API Key'"
      />
      <div class="btnrow">
        <button class="addbtn" :class="{ confirm: urlWarning && forced }" @click="submit">{{ submitLabel }}</button>
        <button v-if="editing" class="cancelbtn" @click="cancel">取消</button>
      </div>
      <div v-if="err" class="err">{{ err }}</div>
    </div>
  </div>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 12px; }
.title3 { font-size: 20px; font-weight: 600; }
.grouphead { font-size: 15px; font-weight: 600; color: var(--label-secondary); margin-top: 4px; }
.group { background: var(--grouped-bg-secondary); border: .5px solid var(--separator); border-radius: var(--r-md); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.hint { font-size: 13px; color: var(--label-tertiary); padding: 6px; }
.prow { display: flex; align-items: center; gap: 4px; padding: 6px; border-radius: var(--r-control); }
.prow.on { background: var(--fill-quaternary); }
.pinfo { flex: 1; min-width: 0; }
.pname { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.badge { font-size: 11px; font-weight: 500; color: var(--accent); border: .5px solid var(--accent); border-radius: var(--r-pill); padding: 0 6px; }
.pmodel { font-size: 12px; color: var(--label-secondary); font-family: var(--font-mono); margin-top: 2px; }
.miss { color: var(--orange); }
.act { background: none; border: none; color: var(--label-tertiary); cursor: pointer; padding: 4px; display: inline-flex; border-radius: var(--r-control); }
.act:hover { background: var(--fill-quaternary); color: var(--label); }
.del:hover { color: var(--red); }
.form { padding: 10px; }
.inp {
  width: 100%; padding: 8px 10px; border-radius: var(--r-control); border: 1px solid var(--separator);
  background: var(--bg-tertiary); color: var(--label); font-family: var(--font-ui); font-size: 14px; outline: none;
}
.inp:focus { border-color: var(--accent); }
.inp.warn { border-color: var(--orange); }
.warnmsg {
  display: flex; gap: 6px; align-items: flex-start; font-size: 12px; line-height: 1.5;
  color: var(--orange); padding: 2px 2px 0;
}
.warnmsg :deep(svg) { flex: 0 0 auto; margin-top: 2px; }
.btnrow { display: flex; gap: 6px; margin-top: 2px; }
.addbtn {
  flex: 1; padding: 9px; border-radius: var(--r-control); border: .5px solid var(--separator); background: var(--grouped-bg-secondary);
  color: var(--label); font-size: 15px; font-weight: 600; cursor: pointer; font-family: var(--font-ui);
}
.addbtn:hover { background: var(--fill-quaternary); }
.addbtn.confirm { border-color: var(--orange); color: var(--orange); }
.cancelbtn {
  padding: 9px 14px; border-radius: var(--r-control); border: .5px solid var(--separator); background: transparent;
  color: var(--label-secondary); font-size: 15px; cursor: pointer; font-family: var(--font-ui);
}
.cancelbtn:hover { background: var(--fill-quaternary); }
.err { font-size: 13px; color: var(--red); line-height: 1.5; }
</style>
