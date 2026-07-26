<script setup lang="ts">
import { useChat } from '../stores/chat';
const chat = useChat();
</script>
<template>
  <div>
    <button style="width:100%;padding:8px" @click="chat.newSession()">+ 新会话</button>
    <div v-for="s in chat.sessions" :key="s.id" :style="{ padding: '8px', cursor: 'pointer', background: s.id === chat.activeId ? '#eef' : '' }" @click="chat.open(s.id)">
      {{ s.title }}
    </div>
  </div>
</template>
