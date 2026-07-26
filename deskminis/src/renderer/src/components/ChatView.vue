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
        <details
          v-else-if="p.type === 'toolResult'"
          open
          style="border:1px solid #ccd; border-radius:6px; margin:4px 0; padding:6px; background:#f7f7fb"
        >
          <summary style="cursor:pointer">
            🔧 工具输出
            <span v-if="p.value.success">✅</span><span v-else>❌</span>
          </summary>
          <pre style="white-space:pre-wrap; font-size:12px; max-height:200px; overflow:auto; margin:6px 0 0">{{ p.value.output }}</pre>
        </details>
      </template>
    </div>
    <div v-if="chat.streamingText" style="margin:8px 0"><b>DeskMinis：</b><span style="white-space:pre-wrap">{{ chat.streamingText }}</span></div>
    <div v-if="chat.retryNote" style="margin:8px 0; color:#a60; font-size:13px">⏳ {{ chat.retryNote }}</div>
    <ToolCard v-for="c in chat.toolCards" :key="c.toolUseId" :card="c" />
    <PermissionCard v-for="p in chat.pendingPerms" :key="p.requestId" :perm="p" />
  </div>
  <div
    v-if="chat.lastError"
    style="border-top:1px solid #e0a0a0; background:#fdecec; color:#a11; padding:8px 12px; font-size:13px; display:flex; gap:8px; align-items:flex-start"
  >
    <span style="flex:1; white-space:pre-wrap">⚠️ {{ chat.lastError }}</span>
    <button style="flex:none" @click="chat.lastError = ''">关闭</button>
  </div>
  <div style="border-top:1px solid #ddd; padding:8px; display:flex; gap:8px">
    <input v-model="input" style="flex:1; padding:8px" placeholder="说点什么…（Enter 发送）" @keydown.enter="send" />
    <button @click="send">发送</button>
  </div>
</template>
