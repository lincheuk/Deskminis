<script setup lang="ts">
/** 模型 provider 设置（右栏可达）——列出已配置实例、新增/删除。
 *  anthropic 留空 baseUrl → 传 undefined（用默认端点）；openai-compat 必填 baseUrl（后端强校验）。
 *  绝不回显密钥（列表只用 hasApiKey 标识）。 */
import { computed, reactive, ref } from 'vue';
import { useChat } from '../stores/chat';
import Icon from './Icon.vue';

const chat = useChat();
const form = reactive({ name: '', kind: 'openai-compat' as 'anthropic' | 'openai-compat', baseUrl: '', modelId: '', apiKey: '' });
const err = ref('');

const baseUrlPlaceholder = computed(() =>
  form.kind === 'anthropic'
    ? 'base URL（可留空，默认 https://api.anthropic.com）'
    : 'base URL（如 https://api.openai.com/v1）',
);

async function add(): Promise<void> {
  err.value = '';
  try {
    // 空串会被原样存成 baseUrl=''：anthropic 那边拼出相对地址、请求直接失败。
    // 留空 = 用 provider 默认端点，必须传 undefined 而不是 ''。
    await chat.createProvider({ ...form, baseUrl: form.baseUrl.trim() || undefined });
    form.name = ''; form.modelId = ''; form.baseUrl = ''; form.apiKey = '';
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
async function remove(id: string): Promise<void> {
  err.value = '';
  try { await chat.deleteProvider(id); } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
</script>

<template>
  <div class="settings">
    <div class="title3">模型设置</div>

    <div class="group">
      <div v-if="!chat.providers.length" class="hint">尚未配置任何模型 provider。</div>
      <div v-for="p in chat.providers" :key="p.id" class="prow">
        <div class="pinfo">
          <div class="pname">{{ p.name }}<span v-if="p.id === chat.defaultProviderId" class="badge">默认</span></div>
          <div class="pmodel">{{ p.modelId || p.kind }}<span v-if="!p.hasApiKey" class="miss"> · 缺密钥</span></div>
        </div>
        <button class="del" title="删除" @click="remove(p.id)"><Icon name="trash" :size="15" /></button>
      </div>
    </div>

    <div class="grouphead">添加 provider</div>
    <div class="group form">
      <input v-model="form.name" class="inp" placeholder="名称（如 我的中继）" />
      <select v-model="form.kind" class="inp">
        <option value="openai-compat">OpenAI 兼容</option>
        <option value="anthropic">Anthropic</option>
      </select>
      <input v-model="form.baseUrl" class="inp" :placeholder="baseUrlPlaceholder" />
      <input v-model="form.modelId" class="inp" placeholder="模型 ID（如 claude-sonnet-5）" />
      <input v-model="form.apiKey" class="inp" type="password" placeholder="API Key" />
      <button class="addbtn" @click="add">添加</button>
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
.prow { display: flex; align-items: center; gap: 8px; padding: 6px; }
.pinfo { flex: 1; min-width: 0; }
.pname { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.badge { font-size: 11px; font-weight: 500; color: var(--accent); border: .5px solid var(--accent); border-radius: var(--r-pill); padding: 0 6px; }
.pmodel { font-size: 12px; color: var(--label-secondary); font-family: var(--font-mono); margin-top: 2px; }
.miss { color: var(--orange); }
.del { background: none; border: none; color: var(--label-tertiary); cursor: pointer; padding: 4px; display: inline-flex; border-radius: var(--r-control); }
.del:hover { background: var(--fill-quaternary); color: var(--red); }
.form { padding: 10px; }
.inp {
  width: 100%; padding: 8px 10px; border-radius: var(--r-control); border: 1px solid var(--separator);
  background: var(--bg-tertiary); color: var(--label); font-family: var(--font-ui); font-size: 14px; outline: none;
}
.inp:focus { border-color: var(--accent); }
.addbtn {
  padding: 9px; border-radius: var(--r-control); border: .5px solid var(--separator); background: var(--grouped-bg-secondary);
  color: var(--label); font-size: 15px; font-weight: 600; cursor: pointer; font-family: var(--font-ui); margin-top: 2px;
}
.addbtn:hover { background: var(--fill-quaternary); }
.err { font-size: 13px; color: var(--red); line-height: 1.5; }
</style>
