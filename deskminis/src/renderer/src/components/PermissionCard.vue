<script setup lang="ts">
import { useChat } from '../stores/chat';
defineProps<{ perm: { requestId: string; detail: string; kind: string; toolTitle: string } }>();
const chat = useChat();
</script>
<template>
  <div style="border:1px solid #e5a; border-radius:6px; margin:6px 0; padding:8px; background:#fff0f5">
    <div>⚠️ 请求权限（{{ perm.kind }}）：{{ perm.toolTitle }}</div>
    <pre style="white-space:pre-wrap; font-size:12px">{{ perm.detail }}</pre>
    <button @click="chat.respondPerm(perm.requestId, 'allow-once')">仅此次</button>
    <button @click="chat.respondPerm(perm.requestId, 'allow-session')">本会话允许</button>
    <button @click="chat.respondPerm(perm.requestId, 'deny')">拒绝</button>
  </div>
</template>
