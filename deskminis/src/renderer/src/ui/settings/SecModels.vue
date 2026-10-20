<script setup lang="ts">
/** T5：模型 provider 配置。**这一节是应用能不能用的开关**——T 波换壳时它被留成占位，
 *  等于装好的应用配不了模型。
 *
 *  界面重做，但四条来之不易的逻辑原样保留（它们是踩出来的，不是设计出来的）：
 *  ① 密钥永不回显：列表只显示「已配密钥」，编辑时留空 = 不改；
 *  ② baseUrl 留空传 undefined 而不是空串（空串会被存下来，anthropic 拼出相对地址直接失败）；
 *  ③ base URL 里已含 /chat/completions 或 /v1/messages 时先警告——我们会再接一次，
 *     实际请求 404，但特殊网关确实存在，故是「再确认一次」而不是硬拦；
 *  ④ 取模型列表失败静默：手输是一等路径，弹错误反而打扰。
 *
 *  F01：规格卡显示的是运行时真正采用的结果（provider.runtime.resolve，与 Agent 循环同一个 resolver），
 *  不再在这里自己猜服务商——同名模型经官方端点、目录收录的服务商、中转、本机接入时各自解析；
 *  每项能力是「目录声明 × 当前端点是否确认 × 应用是否实现」的交集，未确认不显示成可用。
 *  手动修正（窗口、输出上限、图片 / 工具 / 推理）只存进这个配置，不影响同名模型的其他配置。 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { ModelCatalogStatus } from '@shared/model-metadata';
import { capabilityStateLabel, type Capability, type CapabilityOverrides, type LimitValue, type RuntimeModel } from '@shared/runtime-model';
import { DEFAULT_OUTPUT_PREFERENCE } from '@shared/request-budget';
import { useChat } from '../../stores/chat';
import { outputRequestNote } from '../../lib/budget/format';
import UiIcon from '../UiIcon.vue';

const chat = useChat();
type Kind = 'anthropic' | 'openai-compat' | 'gemini' | 'ollama';
const KINDS: { v: Kind; label: string; hint: string }[] = [
  { v: 'anthropic', label: 'Anthropic', hint: 'baseUrl 可留空，用官方端点' },
  { v: 'openai-compat', label: 'OpenAI 兼容', hint: '大多数第三方网关走这条，baseUrl 必填' },
  { v: 'gemini', label: 'Gemini', hint: 'Google AI Studio' },
  { v: 'ollama', label: 'Ollama', hint: '本地端点，免 API Key' },
];
/** 手动能力修正的三态：按资料 / 支持 / 不支持。 */
type Tri = 'auto' | 'on' | 'off';

const blank = {
  name: '', kind: 'openai-compat' as Kind, baseUrl: '', modelId: '', apiKey: '',
  catalogProviderId: '', contextWindow: '', maxOutputTokens: '', capImage: 'auto' as Tri, capTools: 'auto' as Tri, capReasoning: 'auto' as Tri,
};
const form = reactive({ ...blank });
const editingId = ref('');
const open = ref(false);
const err = ref('');
const forced = ref(false);
const modelOptions = ref<string[]>([]);
const fetching = ref(false);
const confirming = ref('');
const catalogStatus = ref<ModelCatalogStatus | null>(null);
const catalogRefreshing = ref(false);
const catalogNotice = ref('');
const runtime = ref<RuntimeModel | null>(null);
const automaticRuntime = ref<RuntimeModel | null>(null);
const catalogProviders = ref<{ id: string; api: string }[]>([]);
const providersNotice = ref('');
const officialEndpoint = computed(() => automaticRuntime.value?.endpoint.class === 'official');
const unlistedProvider = computed(() => !!form.catalogProviderId && !catalogProviders.value.some(p => p.id === form.catalogProviderId));
function apiHost(api: string): string {
  try { return new URL(api).host.toLowerCase(); } catch { return ''; }
}
const providerGroups = computed(() => {
  const host = apiHost(form.baseUrl);
  const ordered = [...catalogProviders.value].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    same: ordered.filter(p => host !== '' && apiHost(p.api) === host),
    other: ordered.filter(p => host === '' || apiHost(p.api) !== host),
  };
});
async function loadCatalogProviders(): Promise<void> {
  try { catalogProviders.value = (await chat.getCatalogProviders()).providers ?? []; providersNotice.value = ''; }
  catch { providersNotice.value = '服务商列表暂时不可用，已填写的值仍保留。'; }
}
const runtimeLoading = ref(false);
const runtimeError = ref('');
let lookupRevision = 0;
let lookupTimer: ReturnType<typeof setTimeout> | undefined;

const sourceLabels = { 'models.dev': 'models.dev', basellm: '备用目录', builtin: '内置回退值', unknown: '未确认' };
const formatDate = (value: number | undefined) => value ? new Date(value).toLocaleString('zh-CN') : '尚未获取';
const formatCount = (value: number | undefined) => value === undefined ? '' : value.toLocaleString('zh-CN');
const SOURCE_TEXT: Record<string, string> = {
  manual: '手动修正', endpoint: '当前端点的目录记录', aggregate: '跨服务商汇总', basellm: '备用目录', builtin: '内置模型族资料', none: '无资料',
};
const ENDPOINT_TEXT: Record<string, string> = {
  official: '官方端点', catalog: '目录收录的服务商', relay: '中转或未收录的端点', local: '本机端点',
};
const MEDIA: Record<string, string> = { text: '文本', image: '图片', audio: '音频', video: '视频', pdf: 'PDF' };

function endpointText(r: RuntimeModel): string {
  if (r.endpoint.manual) return `手动指定为 models.dev / ${r.endpoint.catalogProviderId}`;
  const where = ENDPOINT_TEXT[r.endpoint.class] ?? r.endpoint.class;
  return r.endpoint.catalogProviderId ? `${where}（models.dev / ${r.endpoint.catalogProviderId}）` : where;
}
function recordText(r: RuntimeModel): string {
  if (r.catalog.record === 'endpoint') return '资料：当前端点自己的目录记录';
  if (r.catalog.record === 'aggregate') return '资料：跨服务商汇总——不代表当前端点，说支持的能力显示为未确认';
  if (r.catalog.record === 'basellm') return '资料：备用目录（只有窗口与推理标记）';
  if (r.catalog.record === 'builtin') return '资料：内置模型族回退值（只有数字与推理标记，媒体能力未确认）';
  return '目录尚未收录此型号；数字按保守值回退，可在下方手动修正';
}
function limitText(l: LimitValue, fallback: string): string {
  // F01R：目录写了但没被采用的值（如输出上限等于窗口的占位写法）照实写出来，原因在下面的 note 行
  if (l.value === undefined) return l.declared !== undefined ? `未采用目录值 ${formatCount(l.declared)}（${fallback}）` : `未确认（${fallback}）`;
  const base = `${formatCount(l.value)} tokens · ${SOURCE_TEXT[l.source] ?? l.source}`;
  return l.declared !== undefined && l.declared !== l.value ? `${base}（目录 ${formatCount(l.declared)}）` : base;
}
/** 依据列：可用时写来源（手动修正优先说），其余写原因；推理补上当前端点声明的控制方式。 */
function whyText(c: Capability, extra = ''): string {
  const source = c.manual !== undefined ? '手动修正' : (SOURCE_TEXT[c.catalog.source] ?? c.catalog.source);
  const main = c.state === 'supported' ? `依据：${source}` : (c.reason ?? '');
  return extra ? `${main}${main ? '；' : ''}${extra}` : main;
}
function reasoningExtra(r: RuntimeModel): string {
  // 不支持 / 不可用时不再讲怎么发——原因列只说为什么用不了
  if (r.reasoning.state === 'unsupported' || r.reasoning.state === 'unavailable') return '';
  // F01R：未确认的端点不发推理参数（手动标为支持后才发），不能再写「当前接入以…发送」
  if (r.reasoning.state === 'unknown') return '未确认时不发送推理参数';
  const c = r.reasoning.control;
  if (!c) return r.reasoning.param === 'none' ? '' : `当前接入以${r.reasoning.param === 'effort' ? ' reasoning_effort 档位' : '推理预算'}发送`;
  const parts = [c.efforts?.length ? `档位 ${c.efforts.join('/')}` : '', c.budget ? `预算${c.budget.min !== undefined ? ` ≥${c.budget.min}` : ''}${c.budget.max !== undefined ? ` ≤${c.budget.max}` : ''}` : '', c.toggle ? '开关' : ''].filter(Boolean);
  return parts.length ? `端点声明：${parts.join('、')}` : '端点未列出可调参数';
}

/** 规格卡的能力行：常用的四行总在；音视频 / PDF 输入、媒体生成、结构化输出只在目录声明模型有这项时出现，
 *  并写明「模型支持、当前接入不可用」的原因——不把「模型支持」当成「能用」，也不把文本模型列成能生成视频。 */
const capabilityRows = computed(() => {
  const r = runtime.value;
  if (!r) return [];
  const rows: { key: string; label: string; cap: Capability; why: string }[] = [];
  const manualProvider = r.endpoint.manual ? `手动指定为 models.dev / ${r.endpoint.catalogProviderId}` : '';
  const push = (key: string, label: string, cap: Capability, extra = '') => rows.push({ key, label, cap, why: whyText(cap, [manualProvider, extra].filter(Boolean).join('；')) });
  if (r.input.text.state === 'unsupported' || r.input.text.state === 'unavailable') push('in-text', '文本输入', r.input.text);
  push('in-image', '图片输入', r.input.image);
  for (const m of ['audio', 'video', 'pdf'] as const) if (r.input[m].catalog.value === true) push(`in-${m}`, `${MEDIA[m]}输入`, r.input[m]);
  push('out-text', '文本输出', r.output.text);
  for (const m of ['image', 'audio', 'video'] as const) if (r.output[m].catalog.value === true) push(`out-${m}`, `${MEDIA[m]}生成`, r.output[m]);
  push('tools', '工具调用', r.toolCall);
  push('reasoning', '推理', r.reasoning, reasoningExtra(r));
  if (r.structuredOutput.catalog.value === true) push('structured', '结构化输出', r.structuredOutput);
  return rows;
});
/** 目录对模型本身的声明（不分端点是否确认），与上面的「当前接入」并排，两件事不混在一起。 */
const declaredMedia = computed(() => {
  const r = runtime.value;
  if (!r) return '';
  const ins = (['text', 'image', 'audio', 'video', 'pdf'] as const).filter(m => r.input[m].catalog.value === true).map(m => MEDIA[m]);
  const outs = (['text', 'image', 'audio', 'video'] as const).filter(m => r.output[m].catalog.value === true).map(m => MEDIA[m]);
  if (!ins.length && !outs.length) return '';
  return `目录声明：输入 ${ins.join('、') || '未说明'}；输出 ${outs.join('、') || '未说明'}`;
});
/** 手动修正输入框的占位：留空时按什么值走。 */
function catalogValueOf(l: LimitValue | undefined): number | undefined {
  return l ? (l.source === 'manual' ? l.declared : l.value) : undefined;
}
const windowPlaceholder = computed(() => {
  const v = catalogValueOf(runtime.value?.limits.contextWindow);
  return v !== undefined ? `留空 = 按资料（${formatCount(v)}）` : '留空 = 按资料（暂无，按 128,000 计）';
});
const outputPlaceholder = computed(() => {
  const r = runtime.value;
  // F01R：没填手动值时，留空实际发出去的就是 requestMaxTokens（目录值不可信时是佐证值或兜底值，不一定等于目录值）。
  // 「按资料」只在确有被采用的资料值（value > 0）时说：没有资料、目录值没被采用、目录明写 0 时发的是兜底值，
  // 不能冒充资料——同一张卡的「最大输出」行这时写的是「未确认 / 未采用目录值…（按 N 计）」，两处口径要一致
  if (r && r.limits.maxOutputTokens.source !== 'manual') {
    const adopted = r.limits.maxOutputTokens.value;
    const sent = formatCount(r.requestMaxTokens);
    // F02：上限大于默认输出额度时，留空不是「按资料发」——单次请求默认申请 65,536，资料值只是上限
    if (r.requestMaxTokens > DEFAULT_OUTPUT_PREFERENCE) return `留空 = 默认按 ${formatCount(DEFAULT_OUTPUT_PREFERENCE)} 申请（资料上限 ${sent}）`;
    return adopted !== undefined && adopted > 0 ? `留空 = 按资料（${sent}）` : `留空 = 按 ${sent} 计（目录无可用值）`;
  }
  const v = catalogValueOf(r?.limits.maxOutputTokens);
  return v !== undefined && v > 0 ? `留空 = 按资料（${formatCount(v)}）` : '留空 = 按资料（暂无，按 8,192 计）';
});
/** 手动修正区默认展开与否只在打开表单时定一次（有修正就展开）：跟着输入实时变的话，清空最后一项时区块会在手底下合上。 */
const ovrOpen = ref(false);
const hasOverrides = (): boolean => !!(form.catalogProviderId.trim() || form.contextWindow.trim() || form.maxOutputTokens.trim()
  || form.capImage !== 'auto' || form.capTools !== 'auto' || form.capReasoning !== 'auto');

const triOf = (v: boolean | undefined): Tri => v === undefined ? 'auto' : v ? 'on' : 'off';
function capabilityPayload(): CapabilityOverrides | null {
  const o: CapabilityOverrides = {};
  if (form.capImage !== 'auto') o.imageInput = form.capImage === 'on';
  if (form.capTools !== 'auto') o.toolCall = form.capTools === 'on';
  if (form.capReasoning !== 'auto') o.reasoning = form.capReasoning === 'on';
  return Object.keys(o).length ? o : null;
}
/** 正整数或留空；其余返回 'bad'。 */
function parseCount(raw: string): number | null | 'bad' {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return 'bad';
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : 'bad';
}

async function loadRuntime(revision: number): Promise<void> {
  try {
    const params = {
      kind: form.kind, modelId: form.modelId.trim(), baseUrl: form.baseUrl.trim() || undefined, name: form.name.trim() || undefined,
      // 原样交给 resolver：不合法的值由它列进 overrides.invalid，卡片照实说「已忽略」，而不是整个预览报错
      contextWindow: form.contextWindow.trim() || null, maxOutputTokens: form.maxOutputTokens.trim() || null,
      capabilityOverrides: capabilityPayload(), catalogProviderId: form.catalogProviderId.trim() || null,
    };
    const result = await chat.resolveRuntime(params);
    // 自动判断单独展示，不能把已经手动指定的结果冒充成按地址认定。
    const automatic = params.catalogProviderId ? await chat.resolveRuntime({ ...params, catalogProviderId: null }) : result;
    if (revision !== lookupRevision) return;
    runtime.value = result.runtime;
    automaticRuntime.value = automatic.runtime;
    catalogStatus.value = result.status;
  } catch {
    if (revision === lookupRevision) runtimeError.value = '暂时无法读取模型规格，可继续填写模型。';
  } finally {
    if (revision === lookupRevision) runtimeLoading.value = false;
  }
}

watch(() => [open.value, form.modelId, form.kind, form.baseUrl, form.catalogProviderId, form.contextWindow, form.maxOutputTokens, form.capImage, form.capTools, form.capReasoning], () => {
  if (lookupTimer) clearTimeout(lookupTimer);
  const revision = ++lookupRevision;
  runtime.value = null; automaticRuntime.value = null; runtimeError.value = ''; runtimeLoading.value = false;
  if (!open.value || !form.modelId.trim()) return;
  runtimeLoading.value = true;
  lookupTimer = setTimeout(() => { void loadRuntime(revision); }, 250);
});
onMounted(async () => {
  try { catalogStatus.value = await chat.getModelCatalogStatus(); }
  catch { catalogNotice.value = '目录状态暂时不可用。'; }
  await loadCatalogProviders();
});
onBeforeUnmount(() => { ++lookupRevision; if (lookupTimer) clearTimeout(lookupTimer); });

async function refreshCatalog(): Promise<void> {
  if (catalogRefreshing.value) return;
  catalogRefreshing.value = true; catalogNotice.value = '';
  try {
    const result = await chat.refreshModelCatalog();
    catalogStatus.value = result.status;
    await loadCatalogProviders();
    catalogNotice.value = result.refreshed ? '模型目录已更新。' : '刷新未成功，继续使用现有资料。';
    if (open.value && form.modelId.trim()) {
      if (lookupTimer) clearTimeout(lookupTimer);
      runtimeLoading.value = true; runtimeError.value = '';
      await loadRuntime(++lookupRevision);
    }
  } catch { catalogNotice.value = '刷新未成功，继续使用现有资料。'; }
  finally { catalogRefreshing.value = false; }
}

const editing = computed(() => editingId.value !== '');
const needKey = computed(() => form.kind !== 'ollama');

const urlWarning = computed(() => {
  const b = form.baseUrl.trim();
  if (!b) return '';
  if (form.kind === 'openai-compat' && /chat\/completions/i.test(b)) {
    return 'base URL 里已经包含 chat/completions。DeskMinis 会在它后面再接一次，实际请求会变成 …/chat/completions/chat/completions（多半 404）。通常填到 /v1 就够了。';
  }
  if (form.kind === 'anthropic' && /\/v1\/messages/i.test(b)) {
    return 'base URL 里已经包含 /v1/messages。DeskMinis 会再接一次 /v1/messages，请求路径会重复。通常填到域名就够了。';
  }
  return '';
});
watch(() => [form.baseUrl, form.kind], () => { forced.value = false; });

const submitLabel = computed(() => {
  if (urlWarning.value && !forced.value) return editing.value ? '仍然保存' : '仍然添加';
  return editing.value ? '保存' : '添加';
});

function startNew(): void {
  Object.assign(form, blank);
  editingId.value = ''; err.value = ''; forced.value = false; modelOptions.value = []; ovrOpen.value = false; open.value = true;
}
function startEdit(p: Record<string, unknown>): void {
  err.value = ''; forced.value = false; modelOptions.value = [];
  editingId.value = String(p.id);
  form.name = String(p.name ?? '');
  form.kind = (p.kind as Kind) ?? 'openai-compat';
  form.baseUrl = String(p.baseUrl ?? '');
  form.modelId = String(p.modelId ?? '');
  form.apiKey = '';                       // 密钥永不回显
  // F01：回填本配置的手动修正（只属于这个实例；旧版本手改的非法值会在规格卡里显示「已忽略」）
  form.catalogProviderId = p.catalogProviderId === undefined || p.catalogProviderId === null ? '' : String(p.catalogProviderId);
  form.contextWindow = p.contextWindow === undefined || p.contextWindow === null ? '' : String(p.contextWindow);
  form.maxOutputTokens = p.maxOutputTokens === undefined || p.maxOutputTokens === null ? '' : String(p.maxOutputTokens);
  const caps = (p.capabilityOverrides ?? {}) as CapabilityOverrides;
  form.capImage = triOf(caps.imageInput); form.capTools = triOf(caps.toolCall); form.capReasoning = triOf(caps.reasoning);
  ovrOpen.value = hasOverrides();
  open.value = true;
}
function cancel(): void { open.value = false; editingId.value = ''; err.value = ''; forced.value = false; Object.assign(form, blank); }

async function submit(): Promise<void> {
  err.value = '';
  if (urlWarning.value && !forced.value) { forced.value = true; return; }
  const contextWindow = parseCount(form.contextWindow);
  const maxOutputTokens = parseCount(form.maxOutputTokens);
  if (contextWindow === 'bad') { err.value = '上下文窗口必须是正整数（留空表示按资料）'; return; }
  if (maxOutputTokens === 'bad') { err.value = '最大输出必须是正整数（留空表示按资料）'; return; }
  try {
    // 手动修正显式带上：null = 清空（JSON 里 undefined 会被丢掉，后端就不知道要清）
    const payload = {
      name: form.name, kind: form.kind, baseUrl: form.baseUrl.trim() || undefined, modelId: form.modelId, apiKey: form.apiKey,
      contextWindow, maxOutputTokens, capabilityOverrides: capabilityPayload(), catalogProviderId: form.catalogProviderId.trim() || null,
    };
    if (editing.value) await chat.updateProvider(editingId.value, payload);
    else await chat.createProvider(payload);
    cancel();
  } catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}

/** Z4：删 provider 前告知它在几个模型组里——后端解析组成员时静默跳过已删的，组还能用，但链变短了。 */
function groupsUsing(id: string): number { return chat.modelGroups.filter(g => g.memberIds.includes(id)).length; }
async function remove(id: string): Promise<void> {
  err.value = ''; confirming.value = '';
  try { await chat.deleteProvider(id); if (editingId.value === id) cancel(); }
  catch (e) { err.value = e instanceof Error ? e.message : String(e); }
}

async function fetchModels(): Promise<void> {
  if (fetching.value) return;
  fetching.value = true;
  try {
    const r = editing.value && !form.apiKey
      ? await chat.fetchProviderModels({ id: editingId.value })
      : await chat.fetchProviderModels({ kind: form.kind, baseUrl: form.baseUrl.trim() || undefined, apiKey: form.apiKey || undefined });
    modelOptions.value = Array.isArray(r?.models) ? r.models : [];
  } catch {
    modelOptions.value = [];        // 静默：手输是一等路径
  } finally { fetching.value = false; }
}
</script>

<template>
  <section class="f-sec">
    <h2>模型</h2>
    <p class="f-note">配置一个 provider 才能开始对话。密钥存在本机，界面永远不回显。</p>

    <div class="catalog-source">
      <div>
        <span>模型规格来源：<a href="https://models.dev/" target="_blank" rel="noreferrer">models.dev</a></span>
        <p v-if="catalogStatus" class="f-hint">
          当前资料：{{ sourceLabels[catalogStatus.source] }} · {{ catalogStatus.modelCount }} 个模型
          · 获取时间：{{ formatDate(catalogStatus.fetchedAt) }}{{ catalogStatus.stale ? '（待更新）' : '' }}
        </p>
        <p class="f-hint">资料缓存 24 小时；无需为目录填写 API Key。</p>
        <p v-if="catalogNotice" class="f-hint" role="status">{{ catalogNotice }}</p>
      </div>
      <button class="f-btn" type="button" :disabled="catalogRefreshing" @click="refreshCatalog">
        {{ catalogRefreshing ? '刷新中…' : '刷新元数据' }}
      </button>
    </div>

    <div v-if="!chat.providers.length && !open" class="blank">
      <UiIcon name="robot" :size="26" />
      <p class="t-h2">还没有配置模型</p>
      <p class="t-body sub">加一个 provider——填地址、密钥和模型 id 就能用。</p>
      <button class="f-btn primary" type="button" @click="startNew">添加 provider</button>
    </div>

    <div v-for="p in chat.providers" :key="p.id" class="prow" :class="{ on: p.id === chat.defaultProviderId }">
      <button
        class="pick" type="button" :title="p.id === chat.defaultProviderId ? '当前默认' : '设为默认'"
        :aria-pressed="p.id === chat.defaultProviderId" @click="chat.setDefaultProvider(p.id)"
      >
        <UiIcon :name="p.id === chat.defaultProviderId ? 'check' : 'chevronRight'" :size="15" />
      </button>
      <span class="pinfo">
        <span class="pname">{{ p.name }}</span>
        <span class="pmeta t-aux">{{ p.kind }} · {{ p.modelId || '未指定模型' }}</span>
      </span>
      <span v-if="p.hasApiKey" class="f-tag ok">已配密钥</span>
      <span v-else-if="p.kind !== 'ollama'" class="f-tag err">缺密钥</span>
      <button class="f-btn ghost" type="button" @click="startEdit(p)">编辑</button>
      <template v-if="confirming === p.id">
        <span class="f-confirm">{{ groupsUsing(p.id) ? `在 ${groupsUsing(p.id)} 个模型组里，删后组内会跳过它。删掉？` : '删掉？' }}</span>
        <button class="f-btn danger" type="button" @click="remove(p.id)">确认删除</button>
        <button class="f-btn ghost" type="button" @click="confirming = ''">取消</button>
      </template>
      <button v-else class="f-btn danger" type="button" @click="confirming = p.id">删除</button>
    </div>

    <button v-if="chat.providers.length && !open" class="f-btn" type="button" @click="startNew">
      <UiIcon name="plus" :size="14" />添加 provider
    </button>

    <form v-if="open" class="f-card" @submit.prevent="submit">
      <div class="f-grid">
        <label class="f-label">
          <span>名称</span>
          <input v-model="form.name" class="f-input" placeholder="给这个配置起个名，如「工作号」" required />
        </label>
        <label class="f-label">
          <span>类型</span>
          <select v-model="form.kind" class="f-select">
            <option v-for="k in KINDS" :key="k.v" :value="k.v">{{ k.label }}</option>
          </select>
          <span class="f-hint">{{ KINDS.find(k => k.v === form.kind)?.hint }}</span>
        </label>
      </div>

      <label class="f-label">
        <span>base URL</span>
        <input
          v-model="form.baseUrl" class="f-input"
          :placeholder="form.kind === 'anthropic' ? '可留空，默认 https://api.anthropic.com' : '如 https://api.openai.com/v1'"
        />
        <span v-if="urlWarning" class="warn">{{ urlWarning }}</span>
      </label>

      <div class="f-grid">
        <label class="f-label">
          <span>模型 id</span>
          <span class="mrow">
            <input v-model="form.modelId" class="f-input" list="modelopts" placeholder="如 gpt-4o / claude-sonnet-4" required />
            <button class="f-btn" type="button" :disabled="fetching" @click="fetchModels">
              {{ fetching ? '获取中…' : '取列表' }}
            </button>
          </span>
          <datalist id="modelopts"><option v-for="m in modelOptions" :key="m" :value="m" /></datalist>
          <span v-if="modelOptions.length" class="f-hint">拉到 {{ modelOptions.length }} 个，点输入框选</span>
        </label>
        <label class="f-label">
          <span>API Key{{ needKey ? '' : '（Ollama 免填）' }}</span>
          <input v-model="form.apiKey" class="f-input" type="password" autocomplete="off" :placeholder="editing ? '留空 = 保持原密钥不变' : (needKey ? '必填' : '可留空')" />
          <span class="f-hint">存在本机，界面不回显。{{ editing ? '要换密钥才需要重填。' : '' }}</span>
        </label>
      </div>

      <details class="ovr" :open="ovrOpen">
        <summary>手动修正（只作用于这个配置）</summary>
        <label class="f-label">
          <span>目录里的服务商</span>
          <select v-model="form.catalogProviderId" class="f-select" data-override="catalog-provider" :disabled="officialEndpoint">
            <option value="">自动（按地址判断）</option>
            <option v-if="unlistedProvider" :value="form.catalogProviderId">{{ form.catalogProviderId }}（当前目录未收录）</option>
            <optgroup v-if="providerGroups.same.length" label="与地址同主机">
              <option v-for="p in providerGroups.same" :key="p.id" :value="p.id">{{ p.id }}</option>
            </optgroup>
            <optgroup v-if="providerGroups.other.length" label="其它服务商">
              <option v-for="p in providerGroups.other" :key="p.id" :value="p.id">{{ p.id }}</option>
            </optgroup>
          </select>
          <span class="f-hint">自动判断：{{ automaticRuntime ? endpointText(automaticRuntime) : (runtimeLoading ? '读取中…' : '填写型号后显示') }}</span>
          <span v-if="officialEndpoint" class="f-hint">官方端点按地址认定，不用手动指定</span>
          <span v-if="providersNotice" class="f-hint" role="status">{{ providersNotice }}</span>
        </label>
        <div class="f-grid">
          <label class="f-label">
            <span>上下文窗口（tokens）</span>
            <input v-model="form.contextWindow" class="f-input" inputmode="numeric" :placeholder="windowPlaceholder" />
          </label>
          <label class="f-label">
            <span>最大输出（tokens）</span>
            <input v-model="form.maxOutputTokens" class="f-input" inputmode="numeric" :placeholder="outputPlaceholder" />
          </label>
        </div>
        <div class="tri-grid">
          <label class="f-label">
            <span>图片输入</span>
            <select v-model="form.capImage" class="f-select"><option value="auto">按资料</option><option value="on">支持</option><option value="off">不支持</option></select>
          </label>
          <label class="f-label">
            <span>工具调用</span>
            <select v-model="form.capTools" class="f-select"><option value="auto">按资料</option><option value="on">支持</option><option value="off">不支持</option></select>
          </label>
          <label class="f-label">
            <span>推理</span>
            <select v-model="form.capReasoning" class="f-select"><option value="auto">按资料</option><option value="on">支持</option><option value="off">不支持</option></select>
          </label>
        </div>
        <p class="f-hint">留空或「按资料」即用目录资料。修正不影响同名模型的其他配置；音视频、PDF 原生输入与图片 / 音视频生成尚未接入，手动也打不开。</p>
      </details>

      <div v-if="form.modelId.trim()" class="model-specs" aria-live="polite">
        <p v-if="runtimeLoading" class="f-hint">读取模型规格…</p>
        <p v-else-if="runtimeError" class="f-hint">{{ runtimeError }}</p>
        <template v-else-if="runtime">
          <p class="spec-title">{{ runtime.catalog.name || form.modelId }} · {{ endpointText(runtime) }}</p>
          <p class="f-hint">{{ recordText(runtime) }}{{ runtime.catalog.stale ? '（目录待更新）' : '' }}</p>
          <dl class="spec-grid">
            <div><dt>上下文窗口</dt><dd>{{ limitText(runtime.limits.contextWindow, '按 128,000 计') }}</dd></div>
            <div v-if="runtime.limits.maxInputTokens.value !== undefined"><dt>最大输入</dt><dd>{{ limitText(runtime.limits.maxInputTokens, '') }}</dd></div>
            <div><dt>最大输出</dt><dd>{{ limitText(runtime.limits.maxOutputTokens, `按 ${formatCount(runtime.requestMaxTokens)} 计`) }}</dd></div>
          </dl>
          <p v-if="runtime.limits.contextWindow.note" class="f-hint">{{ runtime.limits.contextWindow.note }}</p>
          <p v-if="runtime.limits.maxOutputTokens.note" class="f-hint">{{ runtime.limits.maxOutputTokens.note }}</p>
          <!-- F02：「最大输出」那一行说的是上限；单次请求实际申请多少另写一行 -->
          <p class="f-hint" data-spec="output-request">{{ outputRequestNote(runtime) }}</p>
          <table class="cap-table">
            <thead><tr><th scope="col">能力</th><th scope="col">当前接入</th><th scope="col">依据 / 原因</th></tr></thead>
            <tbody>
              <tr v-for="row in capabilityRows" :key="row.key" :class="`st-${row.cap.state}`">
                <th scope="row">{{ row.label }}</th>
                <td class="st">{{ capabilityStateLabel(row.cap.state) }}</td>
                <td>{{ row.why }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="declaredMedia" class="f-hint">{{ declaredMedia }}</p>
          <p v-if="runtime.overrides.invalid.length" class="warn">以下手动值不合法，已忽略：{{ runtime.overrides.invalid.join('，') }}</p>
          <p class="f-hint">「当前接入」是目录声明、当前端点是否确认与 DeskMinis 是否已实现三者的交集。未确认的能力不当作已支持：图片与工具照常尝试发送，推理参数在未确认时不发送，确认后可在手动修正里标为支持；端点拒绝时会说明。</p>
        </template>
      </div>

      <p v-if="err" class="errline">{{ err }}</p>
      <div class="f-row">
        <button class="f-btn primary" type="submit">{{ submitLabel }}</button>
        <button class="f-btn ghost" type="button" @click="cancel">取消</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.catalog-source {
  display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4); border: 1px solid var(--c-line); border-radius: var(--r-s);
}
.catalog-source a { color: var(--c-brand); }
.catalog-source p, .model-specs p { margin: var(--sp-2) 0 0; }
.model-specs { padding: var(--sp-3) var(--sp-4); background: var(--c-bg-1); border-radius: var(--r-s); }
.model-specs .spec-title { margin-top: 0; color: var(--c-ink); overflow-wrap: anywhere; }
.spec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--sp-3); margin: var(--sp-3) 0; }
.spec-grid dt { font-size: var(--t-aux-size); color: var(--c-ink-3); }
.spec-grid dd { margin: var(--sp-1) 0 0; overflow-wrap: anywhere; }
/* F01 能力表：「当前接入」一列按结论着色；原因写全不截断（原因就是出路） */
.cap-table { width: 100%; border-collapse: collapse; margin: var(--sp-2) 0; font-size: var(--t-aux-size); }
.cap-table th, .cap-table td { text-align: left; vertical-align: top; padding: var(--sp-2) var(--sp-3) var(--sp-2) 0; border-top: 1px solid var(--c-line); overflow-wrap: anywhere; }
.cap-table thead th { border-top: none; color: var(--c-ink-3); font-weight: 400; white-space: nowrap; }
.cap-table tbody th { font-weight: var(--w-md); color: var(--c-ink); white-space: nowrap; }
.cap-table .st { white-space: nowrap; font-weight: var(--w-md); }
.st-supported .st { color: var(--c-ok); }
.st-unsupported .st, .st-unavailable .st { color: var(--c-warn); }
.st-unknown .st { color: var(--c-ink-3); }
.ovr { padding: var(--sp-3) var(--sp-4); border: 1px solid var(--c-line); border-radius: var(--r-s); }
.ovr summary { cursor: pointer; color: var(--c-ink-2); font-size: var(--t-item-size); }
.ovr .f-grid, .ovr .tri-grid { margin-top: var(--sp-3); }
.ovr p { margin: var(--sp-2) 0 0; }
.tri-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--sp-3); }
.blank {
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-3);
  padding: var(--sp-8); text-align: center; color: var(--c-ink-3);
  background: var(--c-bg-1); border-radius: var(--r-m);
}
.blank p { margin: 0; }
.blank .t-h2 { color: var(--c-ink); }
.blank .sub { max-width: 340px; }

.prow {
  display: flex; align-items: center; gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4) var(--sp-3) var(--sp-2);
  border: 1px solid var(--c-line); border-radius: var(--r-s); background: var(--c-bg);
}
.prow.on { border-color: var(--c-brand-line); background: var(--c-brand-soft); }
.pick {
  width: 28px; height: 28px; flex: 0 0 auto; border-radius: var(--r-s);
  display: inline-flex; align-items: center; justify-content: center;
  background: none; cursor: pointer; color: var(--c-ink-4);
}
.prow.on .pick { color: var(--c-brand); }
.pick:hover { background: var(--c-bg-2); }
.pinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pname { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.pmeta { color: var(--c-ink-3); font-family: var(--f-mono); }

.mrow { display: flex; gap: var(--sp-3); align-items: center; }
.warn {
  font-size: var(--t-aux-size); line-height: var(--t-aux-lh); color: var(--c-warn);
  background: var(--c-warn-soft); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-s);
}
.errline { margin: 0; font-size: var(--t-body-size); color: var(--c-err); }
</style>
