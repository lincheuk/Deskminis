<script setup lang="ts">
/** 中栏空状态（设计 §4.2）——居中标题 + 一行副文案（M1 先只放一行，能力卡等 M2 补）。 */
</script>

<template>
  <div class="empty">
    <h2>开始新的对话</h2>
    <p>让 DeskMinis 帮你读写文件、执行命令、完成任务</p>
  </div>
</template>

<style scoped>
.empty {
  flex: 1; height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center;
}
.empty h2 { font-size: 22px; font-weight: 700; color: var(--label); }
.empty p { font-size: 15px; color: var(--label-secondary); }
</style>
