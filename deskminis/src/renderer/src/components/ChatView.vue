<script setup lang="ts">
import { ref } from 'vue';
import { useChat } from '../stores/chat';
import ToolCard from './ToolCard.vue';
import PermissionCard from './PermissionCard.vue';
const chat = useChat();
const input = ref('');
function partText(p: any): string { return p.type === 'text' ? p.value : ''; }
async function send() { const t = input.value.trim(); if (!t || !chat.activeId) return; input.value = ''; await chat.send(t); }
</script>
<template>
  <div style="flex:1; overflow:auto; padding:12px">
    <div v-for="m in chat.messages" :key="m.id" style="margin:8px 0">
      <b>{{ m.role === 'user' ? '你' : 'DeskMinis' }}：</b>
      <template v-for="(p, i) in m.parts" :key="i">
        <span v-if="p.type === 'text'" style="white-space:pre-wrap">{{ partText(p) }}</span>
        <span v-else-if="p.type === 'toolUse'" style="color:#88a">[工具 {{ p.value.name }}]</span>
      </template>
    </div>
    <div v-if="chat.streamingText" style="margin:8px 0"><b>DeskMinis：</b><span style="white-space:pre-wrap">{{ chat.streamingText }}</span></div>
    <ToolCard v-for="c in chat.toolCards" :key="c.toolUseId" :card="c" />
    <PermissionCard v-for="p in chat.pendingPerms" :key="p.requestId" :perm="p" />
  </div>
  <div style="border-top:1px solid #ddd; padding:8px; display:flex; gap:8px">
    <input v-model="input" style="flex:1; padding:8px" placeholder="说点什么…（Enter 发送）" @keydown.enter="send" />
    <button @click="send">发送</button>
  </div>
</template>
