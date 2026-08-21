<script setup lang="ts">
/** T5：网络搜索 provider（供 web_search 工具用，与模型 provider 无关）。
 *  后端 get 只回 {kind, hasKey, baseUrl?}——密钥永不回显；同 kind 留空保存 = 保持原密钥。 */
import { computed, onMounted, ref } from 'vue';
import { useChat } from '../../stores/chat';

const chat = useChat();
const kind = ref('none');
const apiKey = ref('');
const baseUrl = ref('');
const hasKey = ref(false);
const err = ref('');
const saved = ref(false);

/** 后端只认这三种（store/search-provider-store.ts 强校验），别自己加。
 *  brave/tavily 要密钥；searxng 是自建实例，要地址不要密钥。 */
const KINDS = [
  { v: 'none', label: '不启用', needKey: false, needUrl: false },
  { v: 'tavily', label: 'Tavily', needKey: true, needUrl: false },
  { v: 'brave', label: 'Brave Search', needKey: true, needUrl: false },
  { v: 'searxng', label: 'SearXNG（自建实例）', needKey: false, needUrl: true },
];
const cur = computed(() => KINDS.find(k => k.v === kind.value) ?? KINDS[0]);

function sync(r: { kind: string; hasKey: boolean; baseUrl?: string } | null | undefined): void {
  kind.value = r?.kind ?? 'none';
  hasKey.value = Boolean(r?.hasKey);
  baseUrl.value = r?.baseUrl ?? '';
  apiKey.value = '';
}
onMounted(async () => {
  try { sync(await chat.fetchSearchProvider()); } catch { /* 后端未就绪不值得打断 */ }
});

async function save(): Promise<void> {
  err.value = ''; saved.value = false;
  try {
    await chat.saveSearchProvider({
      kind: kind.value,
      apiKey: apiKey.value.trim() || undefined,   // 留空 = 保持原密钥
      baseUrl: baseUrl.value.trim() || undefined,
    });
    sync(chat.searchProvider);
    saved.value = true; setTimeout(() => (saved.value = false), 1600);
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}
</script>

<template>
  <section class="f-sec">
    <h2>网络搜索</h2>
    <p class="f-note">配好之后 agent 就能用 <code>web_search</code> 查资料。跟上面的模型 provider 是两回事。</p>
    <form class="f-card" @submit.prevent="save">
      <div class="f-grid">
        <label class="f-label">
          <span>服务</span>
          <select v-model="kind" class="f-select">
            <option v-for="k in KINDS" :key="k.v" :value="k.v">{{ k.label }}</option>
          </select>
        </label>
        <label class="f-label" :class="{ off: !cur.needKey }">
          <span>API Key</span>
          <input v-model="apiKey" class="f-input" type="password" autocomplete="off" :disabled="!cur.needKey"
                 :placeholder="!cur.needKey ? '这种服务不需要密钥' : (hasKey ? '留空 = 保持原密钥不变' : '必填')" />
          <span class="f-hint">{{ hasKey ? '已配置。要换密钥才需要重填。' : '存在本机，界面不回显。' }}</span>
        </label>
      </div>
      <label class="f-label" :class="{ off: kind === 'none' }">
        <span>base URL{{ cur.needUrl ? '' : '（可选）' }}</span>
        <input v-model="baseUrl" class="f-input" :disabled="kind === 'none'"
               :placeholder="cur.needUrl ? '自建实例地址，如 https://searx.example.com' : '留空用官方端点'" />
      </label>
      <p v-if="err" class="errline">{{ err }}</p>
      <div class="f-row">
        <button class="f-btn primary" type="submit">保存</button>
        <span v-if="saved" class="f-tag ok">已保存</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
.f-label.off { opacity: .5; }
code { font-family: var(--f-mono); background: var(--c-bg-2); padding: 1px 5px; border-radius: 4px; }
</style>
