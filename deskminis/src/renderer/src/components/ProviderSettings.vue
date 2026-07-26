<script setup lang="ts">
import { computed, reactive } from 'vue';
import { useChat } from '../stores/chat';
const chat = useChat();
const form = reactive({ name: '', kind: 'openai-compat' as 'anthropic' | 'openai-compat', baseUrl: '', modelId: '', apiKey: '' });
const baseUrlPlaceholder = computed(() =>
  form.kind === 'anthropic'
    ? 'base URL（可留空，默认 https://api.anthropic.com）'
    : 'base URL（如 https://api.openai.com/v1）',
);
async function add() {
  // 空串会被原样存成 baseUrl=''：anthropic 那边拼出 '/v1/messages' 这种相对地址，
  // 请求直接失败。留空 = 用 provider 的默认端点，必须传 undefined 而不是 ''。
  await chat.createProvider({ ...form, baseUrl: form.baseUrl.trim() || undefined });
  form.apiKey = '';
}
</script>
<template>
  <div style="margin-top:8px; font-size:13px">
    <div v-for="p in chat.providers" :key="p.id">{{ p.name }} <span v-if="p.hasApiKey">🔑</span></div>
    <hr />
    <input v-model="form.name" placeholder="名称" style="width:100%; margin:2px 0" />
    <select v-model="form.kind" style="width:100%; margin:2px 0"><option value="openai-compat">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select>
    <input v-model="form.baseUrl" :placeholder="baseUrlPlaceholder" style="width:100%; margin:2px 0" />
    <input v-model="form.modelId" placeholder="模型 ID" style="width:100%; margin:2px 0" />
    <input v-model="form.apiKey" type="password" placeholder="API Key" style="width:100%; margin:2px 0" />
    <button @click="add">添加</button>
  </div>
</template>
