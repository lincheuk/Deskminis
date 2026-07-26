<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useChat } from './stores/chat';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import ProviderSettings from './components/ProviderSettings.vue';
const chat = useChat();
const showSettings = ref(false);
onMounted(() => chat.init());
</script>
<template>
  <div class="app">
    <aside class="left"><SessionList /></aside>
    <main class="center"><ChatView /></main>
    <aside class="right"><button @click="showSettings = !showSettings">模型设置</button><ProviderSettings v-if="showSettings" /></aside>
  </div>
</template>
<style>
.app { display: grid; grid-template-columns: 240px 1fr 280px; height: 100vh; font-family: system-ui; }
.left { border-right: 1px solid #ddd; overflow: auto; }
.right { border-left: 1px solid #ddd; padding: 8px; }
.center { display: flex; flex-direction: column; overflow: hidden; }
</style>
