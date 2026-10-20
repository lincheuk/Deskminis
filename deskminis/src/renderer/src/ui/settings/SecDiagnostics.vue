<script setup lang="ts">
/** N04：诊断只读现有 RPC 应答；每块独立报错，进页不自动运行自检。 */
import { computed, onMounted, reactive } from 'vue';
import { useChat } from '../../stores/chat';
import { formatBytes } from '../../lib/changes/model';

const chat = useChat();
interface LoadState<T> { data?: T; busy: boolean; error: string }
const processes = reactive<LoadState<Awaited<ReturnType<typeof chat.fetchProcSnapshot>>>>({ busy: false, error: '' });
const checkpoints = reactive<LoadState<Awaited<ReturnType<typeof chat.fetchCheckpointUsage>>>>({ busy: false, error: '' });
const audit = reactive<LoadState<Awaited<ReturnType<typeof chat.fetchAuditRecords>>>>({ busy: false, error: '' });
const selfCheck = reactive<LoadState<Awaited<ReturnType<typeof chat.runDiagnostics>>>>({ busy: false, error: '' });

async function load<T>(state: LoadState<T>, fetch: () => Promise<T>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.error = '';
  state.data = undefined;
  try { state.data = await fetch(); }
  catch (e) { state.error = e instanceof Error ? e.message : String(e); }
  finally { state.busy = false; }
}
const refreshProcesses = () => load(processes, () => chat.fetchProcSnapshot());
const refreshCheckpoints = () => load(checkpoints, () => chat.fetchCheckpointUsage());
const refreshAudit = () => load(audit, () => chat.fetchAuditRecords());
const runSelfCheck = () => load(selfCheck, () => chat.runDiagnostics());
onMounted(() => {
  void refreshProcesses();
  void refreshCheckpoints();
  void refreshAudit();
});

const ownershipText = computed(() => {
  const own = processes.data?.ownership;
  if (!own) return '';
  if (own.state === 'disabled') return '进程托管已停用';
  if (own.state === 'active') return '作业对象已生效';
  return '本次运行还没有启动过子进程';
});
const STATUS_TEXT = { ready: '就绪', warning: '需留意', blocked: '未就绪' };
const PROTECTION_TEXT = { pending: '等待归属', job: '已托管', none: '未托管' };
const KIND_TEXT = { shell: 'Agent shell', terminal: '终端', mcp: 'MCP' };
const checks = computed(() => {
  const c = selfCheck.data?.checks;
  if (!c) return [];
  return [
    { label: '模型配置', ...c.providers },
    { label: '默认模型', ...c.defaultProvider },
    { label: '模型组', ...c.fallbackChain },
    { label: '模型目录', ...c.modelCatalog },
    { label: 'Windows 桥', ...c.bridgeNode },
    { label: '同步状态', ...c.syncState },
    { label: '进程托管', ...c.processOwnership },
    ...c.skills.map((s, i) => ({ label: `技能 ${i + 1}`, ...s })),
  ];
});
</script>

<template>
  <section class="f-sec diagnostics">
    <h2>诊断</h2>
    <p class="f-note">查看本机运行状态。自检只检查配置，不调用模型、执行工具或连接 Windows 桥。</p>

    <div class="f-card" data-diagnostic="processes">
      <div class="f-row">
        <h3>进程树托管</h3>
        <button class="f-btn" type="button" :disabled="processes.busy" @click="refreshProcesses">{{ processes.busy ? '读取中…' : '刷新' }}</button>
      </div>
      <p v-if="processes.error" class="errline" role="alert">{{ processes.error }}</p>
      <template v-if="processes.data">
        <p class="statusline">{{ ownershipText }}</p>
        <p v-if="processes.data.ownership.reason" class="f-note">停用原因：{{ processes.data.ownership.reason }}</p>
        <p v-if="processes.data.ownership.lastFailure" class="f-note">最近一次托管失败：{{ processes.data.ownership.lastFailure }}</p>
        <p class="f-hint">本代引擎 {{ processes.data.epoch }} · 当前未结束与最近结束的进程树</p>
        <p v-if="!processes.data.trees.length" class="f-note">暂无进程树记录</p>
        <ul v-else class="records">
          <li v-for="tree in processes.data.trees" :key="tree.id">
            <div class="f-row"><strong>{{ KIND_TEXT[tree.kind] }}</strong><span>{{ PROTECTION_TEXT[tree.protection] }}</span></div>
            <p class="f-hint">PID {{ tree.root?.pid ?? '尚未取得' }} · {{ tree.endedAt ? '已结束' : '未结束' }}</p>
            <p v-if="tree.sessionId" class="f-hint">会话：{{ tree.sessionId }}</p>
            <p v-if="tree.ownerRef" class="f-hint">服务器：{{ tree.ownerRef }}</p>
            <p v-if="tree.protectionReason" class="f-note">{{ tree.protectionReason }}</p>
          </li>
        </ul>
      </template>
    </div>

    <div class="f-card" data-diagnostic="checkpoints">
      <div class="f-row">
        <h3>文件检查点</h3>
        <button class="f-btn" type="button" :disabled="checkpoints.busy" @click="refreshCheckpoints">{{ checkpoints.busy ? '读取中…' : '刷新' }}</button>
      </div>
      <p v-if="checkpoints.error" class="errline" role="alert">{{ checkpoints.error }}</p>
      <template v-if="checkpoints.data">
        <p class="statusline">占用 {{ formatBytes(checkpoints.data.usedBytes) }} / 配额 {{ formatBytes(checkpoints.data.quotaBytes) }}</p>
        <p class="f-note">{{ checkpoints.data.checkpointCount }} 条检查点 · {{ checkpoints.data.blobCount }} 个内容块 · 保留 {{ checkpoints.data.retentionDays }} 天</p>
        <p class="f-hint">受保护内容 {{ formatBytes(checkpoints.data.protectedBytes) }} · 单文件上限 {{ formatBytes(checkpoints.data.maxFileBytes) }}</p>
        <p v-if="checkpoints.data.overQuota" class="errline">受保护内容超过配额，不能自动清理。</p>
      </template>
    </div>

    <div class="f-card" data-diagnostic="self-check">
      <div class="f-row">
        <h3>配置自检</h3>
        <button class="f-btn primary" type="button" :disabled="selfCheck.busy" @click="runSelfCheck">{{ selfCheck.busy ? '自检中…' : '运行自检' }}</button>
      </div>
      <p v-if="selfCheck.error" class="errline" role="alert">{{ selfCheck.error }}</p>
      <p v-if="!selfCheck.data && !selfCheck.busy && !selfCheck.error" class="f-note">还没有运行自检</p>
      <template v-if="selfCheck.data">
        <p class="statusline">自检结果：{{ STATUS_TEXT[selfCheck.data.overall] }}</p>
        <ul class="records">
          <li v-for="check in checks" :key="check.label">
            <div class="f-row"><strong>{{ check.label }}</strong><span class="f-tag" :class="check.status === 'ready' ? 'ok' : ''">{{ STATUS_TEXT[check.status] }}</span></div>
            <p v-if="check.detail" class="f-note">{{ check.detail }}</p>
          </li>
        </ul>
        <p v-if="!selfCheck.data.checks.skills.length" class="f-note">没有启用的技能</p>
        <details>
          <summary>已配对设备（{{ selfCheck.data.checks.pairing.length }}）</summary>
          <ul class="records">
            <li v-for="peer in selfCheck.data.checks.pairing" :key="peer.peerFingerprint">
              <strong>{{ peer.peerName }}</strong>
              <p class="f-hint">{{ peer.peerFingerprint }}<template v-if="peer.address"> · {{ peer.address }}</template></p>
            </li>
          </ul>
        </details>
        <details class="prompt-preview">
          <summary>系统提示预览（约 {{ selfCheck.data.estimatedTokens }} tokens）</summary>
          <pre>{{ selfCheck.data.promptPreview }}</pre>
        </details>
      </template>
    </div>

    <div class="f-card" data-diagnostic="audit">
      <div class="f-row">
        <h3>最近审计记录</h3>
        <button class="f-btn" type="button" :disabled="audit.busy" @click="refreshAudit">{{ audit.busy ? '读取中…' : '刷新' }}</button>
      </div>
      <p class="f-note">最近 20 条权限与安全记录，载荷由引擎脱敏。展开可查看详情。</p>
      <p v-if="audit.error" class="errline" role="alert">{{ audit.error }}</p>
      <template v-if="audit.data">
        <p class="f-hint">共 {{ audit.data.total }} 条 · 显示 {{ audit.data.rows.length }} 条</p>
        <p v-if="!audit.data.rows.length" class="f-note">暂无审计记录</p>
        <details v-for="row in audit.data.rows" :key="row.id">
          <summary>{{ row.eventType }}<span v-if="row.sessionId"> · {{ row.sessionId }}</span></summary>
          <p class="f-hint">记录：{{ row.id }}</p>
          <pre>{{ JSON.stringify(row.payload, null, 2) }}</pre>
        </details>
      </template>
    </div>
  </section>
</template>

<style scoped>
h3 { margin: 0; font-size: var(--t-item-size); font-weight: var(--w-md); }
.f-row { justify-content: space-between; }
.statusline { margin: 0; font-size: var(--t-body-size); }
.errline { margin: 0; color: var(--c-err); font-size: var(--t-body-size); }
.records { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.records li { display: flex; flex-direction: column; gap: var(--sp-1); }
summary { cursor: pointer; font-size: var(--t-body-size); }
pre { margin: var(--sp-3) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: var(--t-aux-size)/1.6 var(--f-mono); }
.f-note, .f-hint, summary { overflow-wrap: anywhere; }
</style>
