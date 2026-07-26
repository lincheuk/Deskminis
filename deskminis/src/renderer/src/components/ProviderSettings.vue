<script setup lang="ts">
import { reactive } from 'vue';
import { useChat } from '../stores/chat';
const chat = useChat();
const form = reactive({ name: '', kind: 'openai-compat' as 'anthropic' | 'openai-compat', baseUrl: '', modelId: '', apiKey: '' });
async function add() { await chat.createProvider({ ...form }); form.apiKey = ''; }
</script>
<template>
  <div style="margin-top:8px; font-size:13px">
    <div v-for="p in chat.providers" :key="p.id">{{ p.name }} <span v-if="p.hasApiKey">🔑</span></div>
    <hr />
    <input v-model="form.name" placeholder="名称" style="width:100%; margin:2px 0" />
    <select v-model="form.kind" style="width:100%; margin:2px 0"><option value="openai-compat">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select>
    <input v-model="form.baseUrl" placeholder="base URL（如 https://api.openai.com/v1）" style="width:100%; margin:2px 0" />
    <input v-model="form.modelId" placeholder="模型 ID" style="width:100%; margin:2px 0" />
    <input v-model="form.apiKey" type="password" placeholder="API Key" style="width:100%; margin:2px 0" />
    <button @click="add">添加</button>
  </div>
</template>
