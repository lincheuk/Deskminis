<script setup lang="ts">
import { ref } from 'vue';
defineProps<{ card: { name: string; title: string; output?: string; success?: boolean } }>();
const open = ref(false);
</script>
<template>
  <div style="border:1px solid #ccd; border-radius:6px; margin:4px 0; padding:6px; background:#f7f7fb">
    <div style="cursor:pointer" @click="open = !open">
      🔧 {{ card.title || card.name }}
      <span v-if="card.success === true">✅</span><span v-else-if="card.success === false">❌</span><span v-else>⏳</span>
    </div>
    <pre v-if="open && card.output" style="white-space:pre-wrap; font-size:12px; max-height:200px; overflow:auto">{{ card.output }}</pre>
  </div>
</template>
