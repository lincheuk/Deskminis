<script setup lang="ts">
/** G3 扩展市场面板（设计稿 §4/§5）：工作台「扩展」tab 的全部内容。
 *  两子 tab（技能/MCP，默认技能）+ 搜索（防抖 300ms 在 renderer 端）+ 源过滤 chips
 *  （market.sources.list 动态生成，不可达源标灰）+ 卡片流（market.search 分页惰性加载，
 *  游标透传）+ 详情（面板内就地展开——既有 UI 无面板内滑层成例，设置模态的 section
 *  切换即就地换内容，照此惯例；README 只在详情态请求，复用 MarkdownView）+
 *  安装确认卡（§4 全项，scrim+sheet 照 SettingsModal 成例）+ 已装态（market.installed 比对）。
 *  G4 更新检查（§6）：chips 行「检查更新」按钮（仅手动触发，无后台轮询）→ checkUpdates
 *  结果区（可更新条目 mc-upd mono 标记 + Update 钮走 openConfirm 原路——确认卡/verdict/
 *  malicious 硬阻断全套复用，无独立 update 通道；unsupported 灰字；均为最新一句话）；
 *  MCP env 已存键「保留原值」（envPrefilled，更新不丢用户配置）。
 *
 *  Aurora 语言：全部实心浮岛，零 backdrop-filter（内容面板纪律；本组件在例 8
 *  POPUP_OWNERS 永久禁 blur 名单内——自带确认卡弹层）。verdict 徽章全走既有
 *  state/label 令牌，零新色。
 *
 *  性能纪律（审核盯点）：visited 惰性挂载保证不进 tab 不发任何 market 请求；
 *  搜索防抖；分页滚动到底才加载下一页；列表卡片静态阴影（无逐卡阴影动画）。
 *
 *  安全（§4）：malicious 条目 Install 钮直接禁用 + 红字说明（确认卡根本不开）；
 *  warn 需勾选确认；manualOnly 确认卡转「需手动配置」禁用态；MCP env 声明渲染输入行
 *  （isSecret 用 type=password），值随 market.install 传出；确认卡 Esc 关闭。 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import { parseMarkdown, type MdNode } from '../lib/markdown/parse';
import MarkdownView from './MarkdownView.vue';

/** 搜索防抖窗口（设计稿 §2：防抖在 renderer 端）。 */
const SEARCH_DEBOUNCE_MS = 300;

// ── 本地类型（renderer 不跨目标 import minisd 模块——chat.ts 本地接口同惯例） ──
type MarketKind = 'skill' | 'mcp';
type MarketVerdict = 'ok' | 'warn' | 'malicious' | 'unscanned';
interface MarketItem {
  id: string; kind: MarketKind; name: string; author: string; description: string;
  stats: { downloads: number; stars: number };
  verdict: MarketVerdict; sourceTier: 'official' | 'community';
  raw?: unknown;
}
interface MarketSourceStatus {
  id: string; name: string; tier: 'official' | 'community';
  kinds: readonly MarketKind[]; available: boolean; reachable: 'ok' | 'unreachable';
}
interface MarketEnvDecl { name: string; description: string; required: boolean; isSecret?: true }
interface MarketInstallPlan {
  id: string; kind: MarketKind;
  source: { id: string; name: string; tier: 'official' | 'community' };
  name: string; verdict: MarketVerdict;
  files?: string[]; contentHash?: string;
  command?: { command: string; args: string[] };
  url?: string; serverName?: string; env?: MarketEnvDecl[];
  /** G4 更新流：已存有值的声明键（键名，无值）——确认卡提示「保留原值」，必填项不再强制重输。 */
  envPrefilled?: string[];
  gating?: { envMissing?: string[]; binsMissing?: string[] };
  manualOnly?: true;
}
interface MarketInstalledItem { id: string; kind: MarketKind; localRef: string }
/** G4 market.checkUpdates 的单条可更新报告（服务端 MarketUpdateItem 同构）。 */
interface MarketUpdateItem {
  id: string; kind: MarketKind; name: string;
  current: string; latest: string; verdict: MarketVerdict;
}

const VERDICT_LABEL: Record<MarketVerdict, string> = {
  ok: '安全', warn: '可疑', malicious: '恶意', unscanned: '未扫描',
};

const chat = useChat();
// 「在设置中管理」跳转：沿用既有 openSettings 机制（App.vue provide）
const openSettings = inject<() => void>('openSettings', () => {});

// ── 子 tab 与搜索 ─────────────────────────────────────────────────────────────
const subTab = ref<MarketKind>('skill');
const searchInput = ref('');
const q = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
// 防抖：键入停止 300ms 后才把查询词喂给搜索（在 renderer 端，不打后端）
watch(searchInput, (v) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { q.value = v.trim(); }, SEARCH_DEBOUNCE_MS);
});

// ── 源清单与过滤 ─────────────────────────────────────────────────────────────
const sources = ref<MarketSourceStatus[]>([]);
const sourceFilter = ref('all');
const sourcesForKind = computed(() => sources.value.filter(s => s.kinds.includes(subTab.value)));

async function loadSources(): Promise<void> {
  try {
    const r = await rpc.call('market.sources.list');
    sources.value = r?.sources ?? [];
  } catch {
    // 源清单拉取失败不阻塞浏览：chips 只剩「全部」，搜索结果照常（聚合层自降级）
  }
}

function sourceNameOf(it: MarketItem): string {
  const prefix = it.id.slice(0, it.id.indexOf(':'));
  return sources.value.find(s => s.id === prefix)?.name ?? prefix;
}

// ── 列表：分页 + stale + 源过滤（renderer 侧按 id 前缀过滤，不重发请求） ──────
const items = ref<MarketItem[]>([]);
const cursor = ref<string | undefined>(undefined);
const stale = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const loaded = ref(false);
const listError = ref('');
/** 竞态闸：搜索词/子 tab 快速切换时，迟到的旧页不得覆盖新查询的结果。 */
let searchSeq = 0;

async function fetchFirstPage(): Promise<void> {
  const seq = ++searchSeq;
  loading.value = true; listError.value = '';
  try {
    const page = await rpc.call('market.search', { kind: subTab.value, q: q.value });
    if (seq !== searchSeq) return; // 过期响应丢弃
    items.value = page.items ?? [];
    cursor.value = page.cursor;
    stale.value = page.stale === true;
  } catch (e) {
    if (seq !== searchSeq) return;
    listError.value = e instanceof Error ? e.message : String(e);
    items.value = []; cursor.value = undefined;
  } finally {
    if (seq === searchSeq) { loading.value = false; loaded.value = true; }
  }
}

async function loadMore(): Promise<void> {
  if (!cursor.value || loadingMore.value || loading.value) return;
  const seq = searchSeq;
  loadingMore.value = true;
  try {
    const page = await rpc.call('market.search', { kind: subTab.value, q: q.value, cursor: cursor.value });
    if (seq !== searchSeq) return;
    const seen = new Set(items.value.map(i => i.id));
    for (const it of page.items ?? []) if (!seen.has(it.id)) items.value.push(it);
    cursor.value = page.cursor;
    if (page.stale === true) stale.value = true;
  } catch (e) {
    if (seq === searchSeq) listError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === searchSeq) loadingMore.value = false;
  }
}

const filteredItems = computed(() =>
  sourceFilter.value === 'all'
    ? items.value
    : items.value.filter(it => it.id.startsWith(sourceFilter.value + ':')));

// 滚动到底加载下一页（分页惰性加载）
const listEl = ref<HTMLElement | null>(null);
function onScroll(): void {
  const el = listEl.value;
  if (!el || !cursor.value || loading.value || loadingMore.value) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) void loadMore();
}

watch([q, subTab], () => { void fetchFirstPage(); });

function switchSub(k: MarketKind): void {
  if (subTab.value === k) return;
  subTab.value = k;
  sourceFilter.value = 'all';
  detail.value = null;
}
function setSource(id: string): void { sourceFilter.value = id; }

// ── 已装态（market.installed 双向比对） ──────────────────────────────────────
const installedIds = ref(new Set<string>());
async function refreshInstalled(): Promise<void> {
  try {
    const s = await rpc.call('market.installed', { kind: 'skill' });
    const m = await rpc.call('market.installed', { kind: 'mcp' });
    const all: MarketInstalledItem[] = [...(s?.items ?? []), ...(m?.items ?? [])];
    installedIds.value = new Set(all.map(x => x.id));
  } catch { /* 比对失败不阻塞浏览：卡片按未装显示，安装时服务端仍复核 */ }
}

// ── G4 更新检查（§6：仅手动触发，v1 无后台轮询） ────────────────────────────
const checking = ref(false);
const checkResult = ref<{ updates: MarketUpdateItem[]; unsupported: string[]; errors: number } | null>(null);
const checkError = ref('');
/** 可更新条目索引：Update 行禁用判定（恶意新版本双保险）与 doInstall 收尾共用。 */
const updatesById = computed(() => new Map((checkResult.value?.updates ?? []).map(u => [u.id, u])));

async function doCheckUpdates(): Promise<void> {
  if (checking.value) return;
  checking.value = true; checkError.value = ''; checkResult.value = null;
  try {
    const r = await rpc.call('market.checkUpdates');
    checkResult.value = {
      updates: (r?.updates ?? []) as MarketUpdateItem[],
      unsupported: r?.unsupported ?? [],
      errors: typeof r?.errors === 'number' ? r.errors : 0,
    };
  } catch (e) {
    checkError.value = e instanceof Error ? e.message : String(e);
  } finally {
    checking.value = false;
  }
}

// ── 详情（就地展开；README 只在此态请求） ────────────────────────────────────
const detail = ref<MarketItem | null>(null);
const detailReadme = ref('');
const detailLoading = ref(false);
const detailError = ref('');
const readmeNodes = computed<MdNode[]>(() => parseMarkdown(detailReadme.value));

/** license 透出：ClawHub 的 README 即 SKILL.md 全文（含 frontmatter），从中取 license 字段。 */
const detailLicense = computed(() => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(detailReadme.value);
  if (!m) return '';
  const lm = /^license\s*:\s*(.+)$/m.exec(m[1]);
  return lm ? lm[1].trim() : '';
});
/** ClawHub hasWarnings 辅助提示（G1 审核候选）：security.status=clean 但带警告时灰字提示。
 *  数据源：适配器透出的 raw.scanHasWarnings（clawhub.ts 申报偏离项）。 */
const detailHasWarnings = computed(() => {
  const raw = detail.value?.raw as { scanHasWarnings?: boolean } | undefined;
  return detail.value?.verdict === 'ok' && raw?.scanHasWarnings === true;
});

async function openDetail(it: MarketItem): Promise<void> {
  detail.value = it;
  detailReadme.value = ''; detailError.value = ''; detailLoading.value = true;
  try {
    const d = await rpc.call('market.detail', { id: it.id });
    // 详情回来前用户已返回列表：过期响应丢弃
    if (detail.value?.id !== it.id) return;
    detail.value = d.item;
    detailReadme.value = d.readme ?? '';
  } catch (e) {
    if (detail.value?.id === it.id) detailError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (detail.value?.id === it.id) detailLoading.value = false;
  }
}
function closeDetail(): void { detail.value = null; }

// ── 安装确认卡（§4 全项；G4 更新流同卡复用——无独立 update 通道） ─────────────
/** 确认卡目标：列表/详情条目或 checkUpdates 的可更新条目（结构同构子集）。 */
type ConfirmTarget = Pick<MarketItem, 'id' | 'kind' | 'name' | 'verdict'>;
const confirmFor = ref<ConfirmTarget | null>(null);
const plan = ref<MarketInstallPlan | null>(null);
const planLoading = ref(false);
const planError = ref('');
const warnAck = ref(false);
const envValues = ref<Record<string, string>>({});
const installing = ref(false);
const installError = ref('');
/** 本次确认卡是更新流（标题/收尾 toast/已装拦截豁免）。 */
const isUpdate = ref(false);

/** malicious 条目根本不出确认卡——Install 钮直接禁用（卡片层），此函数是唯一开口。
 *  opts.update（G4）：更新流豁免「已装拦截」（条目本来就已装）——安全闸一分不少：
 *  verdict 照判、确认卡照弹，malicious 照拦。 */
function openConfirm(it: ConfirmTarget, opts?: { update?: boolean }): void {
  if (it.verdict === 'malicious') return;
  if (!opts?.update && installedIds.value.has(it.id)) return;
  isUpdate.value = opts?.update === true;
  confirmFor.value = it;
  plan.value = null; planError.value = ''; installError.value = '';
  warnAck.value = false; envValues.value = {};
  planLoading.value = true;
  rpc.call('market.installPlan', { id: it.id })
    .then((p) => { if (confirmFor.value?.id === it.id) plan.value = p; })
    .catch((e) => { if (confirmFor.value?.id === it.id) planError.value = e instanceof Error ? e.message : String(e); })
    .finally(() => { if (confirmFor.value?.id === it.id) planLoading.value = false; });
}
function closeConfirm(): void { confirmFor.value = null; }

/** 必填 env 实时缺口（确认闸 + gating 提示共用）。
 *  更新流排除 envPrefilled（已存值保留原值，不必重输——服务端 mergeEnvForUpdate 同规则）。 */
const envMissingNow = computed(() =>
  (plan.value?.env ?? []).filter(d => d.required
    && !(envValues.value[d.name] ?? '').trim()
    && !(plan.value?.envPrefilled ?? []).includes(d.name)).map(d => d.name));

const canConfirm = computed(() =>
  !!plan.value && !planLoading.value && !installing.value
  && plan.value.verdict !== 'malicious' // 双保险：服务端也拦，渲染层不给可点态
  && plan.value.manualOnly !== true
  && (plan.value.verdict !== 'warn' || warnAck.value)
  && envMissingNow.value.length === 0);

async function doInstall(): Promise<void> {
  const it = confirmFor.value;
  if (!it || !canConfirm.value) return;
  installing.value = true; installError.value = '';
  try {
    await rpc.call('market.install', { id: it.id, confirm: true, env: envValues.value });
    installedIds.value = new Set([...installedIds.value, it.id]);
    if (isUpdate.value) {
      // 更新收尾：从可更新清单移除（标记消失）+ toast 报新版本（服务端 provenance 已刷新）
      const u = updatesById.value.get(it.id);
      if (checkResult.value) {
        checkResult.value = { ...checkResult.value, updates: checkResult.value.updates.filter(x => x.id !== it.id) };
      }
      closeConfirm();
      showToast(`已更新「${it.name}」${u ? `至 ${u.latest}` : ''}`);
    } else {
      closeConfirm();
      showToast(`已安装「${it.name}」`);
    }
    void refreshInstalled();
    if (it.kind === 'skill') void chat.refreshAllSkills();
  } catch (e) {
    // 失败红字展示服务端错误（不静默吞）
    installError.value = e instanceof Error ? e.message : String(e);
  } finally {
    installing.value = false;
  }
}

/** 技能安装进度：走既有 skills.import.progress 广播（chat.skillImport）。 */
const importProgress = computed(() => chat.skillImport);

// ── toast（面板内瞬态提示，2.6s 自灭） ───────────────────────────────────────
const toastMsg = ref('');
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string): void {
  toastMsg.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg.value = ''; }, 2600);
}

// ── 确认卡 Esc 关闭（照 SettingsModal 成例：capture + stopPropagation） ──────
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && confirmFor.value) { e.stopPropagation(); closeConfirm(); }
}

onMounted(() => {
  window.addEventListener('keydown', onKey, true);
  // 组件由 visited 惰性挂载：以下请求只在首次进入「扩展」tab 时发生
  void loadSources();
  void fetchFirstPage();
  void refreshInstalled();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
  if (debounceTimer) clearTimeout(debounceTimer);
  if (toastTimer) clearTimeout(toastTimer);
});

function fmtNum(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
</script>

<template>
  <div class="mkp">
    <!-- 顶部：两子 tab + 搜索框 -->
    <div class="mkhead">
      <div class="mkseg">
        <button type="button" :class="{ on: subTab === 'skill' }" @click="switchSub('skill')">技能</button>
        <button type="button" :class="{ on: subTab === 'mcp' }" @click="switchSub('mcp')">MCP</button>
      </div>
      <input
        v-model="searchInput" class="mksearch" type="text"
        :placeholder="subTab === 'skill' ? '搜索技能（名称 / 描述）' : '搜索 MCP 服务器'"
      />
    </div>

    <!-- 源过滤 chips（market.sources.list 动态生成；不可达源标灰）+ stale 标注 +
         G4 检查更新（仅手动触发，覆盖全部已装条目，不分子 tab） -->
    <div class="mkchips">
      <button type="button" class="chip" :class="{ on: sourceFilter === 'all' }" @click="setSource('all')">全部</button>
      <template v-for="s in sourcesForKind" :key="s.id">
        <button
          type="button" class="chip"
          :class="{ on: sourceFilter === s.id, off: s.reachable !== 'ok' }"
          :title="s.reachable === 'ok' ? s.name : `${s.name}（当前不可达，结果可能缺失）`"
          @click="setSource(s.id)"
        >{{ s.name }}</button>
      </template>
      <button
        type="button" class="chip mkupd-btn" :disabled="checking"
        :title="'检查全部已装条目是否有新版本（awesome-dsh 直装条目不支持）'"
        @click="doCheckUpdates"
      ><span v-if="checking" class="mkspin" aria-hidden="true"></span>{{ checking ? '检查中…' : '检查更新' }}</button>
    </div>
    <div v-if="stale" class="mkstalebar">离线缓存——网络不可达，以下为上次抓取的结果</div>

    <!-- G4 更新检查结果（aria-live：检查完成播报；结果区常驻至下次检查） -->
    <div v-if="checking || checkError || checkResult" class="mkupd" aria-live="polite">
      <div v-if="checking" class="mkupd-line"><span class="mkspin" aria-hidden="true"></span>正在检查已装条目的更新…</div>
      <div v-else-if="checkError" class="mkerr">{{ checkError }}</div>
      <template v-else-if="checkResult">
        <div
          v-if="checkResult.updates.length === 0 && checkResult.unsupported.length === 0 && checkResult.errors === 0"
          class="mkupd-all"
        >均为最新</div>
        <template v-else>
          <template v-for="it in checkResult.updates" :key="it.id">
            <div class="updrow">
              <span class="updname">{{ it.name }}</span>
              <span class="mc-upd mono">可更新 {{ it.current ? `${it.current}→` : '' }}{{ it.latest }}</span>
              <span class="vb" :class="'vb-' + it.verdict">{{ VERDICT_LABEL[it.verdict] }}</span>
              <button
                type="button" class="mc-install"
                :disabled="updatesById.get(it.id)!.verdict === 'malicious'"
                :title="updatesById.get(it.id)!.verdict === 'malicious' ? '上游安全裁定为恶意，更新已被硬阻断' : '更新到新版本（走安装确认卡）'"
                @click="openConfirm(it, { update: true })"
              >Update</button>
            </div>
            <p v-if="updatesById.get(it.id)!.verdict === 'malicious'" class="upd-blocknote">
              新版本被上游裁定为恶意，更新已禁用（服务端安装层同样硬阻断）。
            </p>
          </template>
          <div v-if="checkResult.unsupported.length > 0" class="mkupd-uns">
            {{ checkResult.unsupported.length }} 个已装条目来自 awesome-dsh（GitHub 直装），此源不支持更新检查
          </div>
          <div v-if="checkResult.errors > 0" class="mkupd-err">
            {{ checkResult.errors }} 项检查失败已跳过（可稍后重试）
          </div>
        </template>
      </template>
    </div>

    <!-- 详情（就地展开，替换列表区） -->
    <div v-if="detail" class="mkdetail">
      <div class="mkdhead">
        <button type="button" class="mkback" @click="closeDetail">← 返回列表</button>
        <span class="mkname">{{ detail.name }}</span>
        <span class="vb" :class="'vb-' + detail.verdict">{{ VERDICT_LABEL[detail.verdict] }}</span>
        <span class="srcbadge">{{ sourceNameOf(detail) }}</span>
      </div>
      <div class="mkdmeta">
        <span>{{ detail.author }}</span>
        <span class="mono">{{ fmtNum(detail.stats.downloads) }} 下载 · {{ fmtNum(detail.stats.stars) }} star</span>
        <span v-if="detailLicense" class="mono">license: {{ detailLicense }}</span>
        <button
          v-if="installedIds.has(detail.id)" class="mkmanage" type="button" @click="openSettings()"
        >已装 · 在设置中管理</button>
        <button
          v-else-if="detail.verdict === 'malicious'" class="mkinstall" type="button" disabled
          title="上游安全裁定为恶意，禁止安装"
        >Install</button>
        <button v-else class="mkinstall" type="button" @click="openConfirm(detail)">Install</button>
      </div>
      <p v-if="detail.verdict === 'malicious'" class="mkblocknote">上游安全裁定为 malicious，安装已被禁用（无任何绕过通道）。</p>
      <p v-if="detailHasWarnings" class="mkwarnline">上游扫描含警告项（裁定仍为 clean，安装前请留意）。</p>
      <div v-if="detailLoading" class="mkloading">详情加载中…</div>
      <div v-else-if="detailError" class="mkerr">{{ detailError }}</div>
      <div v-else class="mkreadme"><MarkdownView :nodes="readmeNodes" /></div>
    </div>

    <!-- 卡片流（分页惰性加载） -->
    <div v-else ref="listEl" class="mklist" @scroll="onScroll">
      <div v-if="listError" class="mkerr">{{ listError }}</div>
      <div v-if="loading" class="mkloading">加载中…</div>
      <div
        v-else-if="loaded && filteredItems.length === 0" class="mkempty"
      >{{ subTab === 'skill' && q === '' ? 'ClawHub 搜索需要查询词——输入关键词浏览技能；awesome-dsh 精选见「全部」' : '没有匹配的条目' }}</div>
      <template v-for="it in filteredItems" :key="it.id">
        <div
          class="mcard" :class="{ blocked: it.verdict === 'malicious' }"
          tabindex="0" role="button" @click="openDetail(it)"
          @keydown.enter.prevent="openDetail(it)" @keydown.space.prevent="openDetail(it)"
        >
          <div class="mc-top">
            <span class="mc-name">{{ it.name }}</span>
            <span class="vb" :class="'vb-' + it.verdict">{{ VERDICT_LABEL[it.verdict] }}</span>
          </div>
          <div class="mc-author">{{ it.author }} <span class="srcbadge">{{ sourceNameOf(it) }}</span></div>
          <div class="mc-stats mono">{{ fmtNum(it.stats.downloads) }} 下载 · {{ fmtNum(it.stats.stars) }} star</div>
          <p class="mc-desc">{{ it.description }}</p>
          <div class="mc-act">
            <button v-if="installedIds.has(it.id)" class="mc-installed" type="button" disabled>已装</button>
            <button
              v-else-if="it.verdict === 'malicious'" class="mc-install" type="button" disabled
              title="上游安全裁定为恶意，禁止安装"
            >Install</button>
            <button v-else class="mc-install" type="button" @click.stop="openConfirm(it)">Install</button>
          </div>
          <p v-if="it.verdict === 'malicious'" class="mc-blocknote">malicious：安装已禁用</p>
        </div>
      </template>
      <div v-if="loadingMore" class="mkloading">加载更多…</div>
    </div>

    <!-- 安装确认卡（§4；scrim+sheet 照 SettingsModal 成例。G4：更新流同卡复用） -->
    <div v-if="confirmFor" class="mask" @click.self="closeConfirm">
      <div class="sheet" role="dialog" :aria-label="isUpdate ? '更新确认' : '安装确认'">
        <div class="shhead">
          <span class="shtitle">{{ isUpdate ? '更新' : '安装' }} {{ confirmFor.name }}</span>
          <button class="xbtn" type="button" title="关闭" :aria-label="isUpdate ? '关闭更新确认' : '关闭安装确认'" @click="closeConfirm">✕</button>
        </div>
        <div class="shbody">
          <div v-if="planLoading" class="mkloading">正在组装确认数据…</div>
          <div v-else-if="planError" class="mkerr">{{ planError }}</div>
          <template v-else-if="plan">
            <!-- §4-1 来源与层级 -->
            <div class="shrow">
              <span class="shlabel">来源</span>
              <span>{{ plan.source.name }}</span>
              <span class="tierbadge" :class="'tier-' + plan.source.tier">{{ plan.source.tier === 'official' ? '官方精选' : '社区' }}</span>
            </div>
            <!-- §4-3 verdict 三态（malicious 双保险禁用） -->
            <div class="shrow">
              <span class="shlabel">安全裁定</span>
              <span class="vb" :class="'vb-' + plan.verdict">{{ VERDICT_LABEL[plan.verdict] }}</span>
            </div>
            <p v-if="plan.verdict === 'malicious'" class="mkblocknote">
              上游安全裁定为 malicious，安装被硬阻断——确认卡不给任何安装通道。
            </p>
            <p v-else-if="plan.verdict === 'warn'" class="mkwarnnote">
              上游裁定为可疑（warn）。请阅读下方将发生的内容，勾选确认后才可安装。
            </p>
            <p v-else-if="plan.verdict === 'unscanned'" class="mkunscanned">该条目无上游扫描裁定（unscanned），请自行审阅内容。</p>

            <!-- §4-2 将发生什么 -->
            <div v-if="plan.files" class="shrow col">
              <span class="shlabel">将落盘的文件</span>
              <div class="filelist mono">
                <template v-for="f in plan.files" :key="f"><div>{{ f }}</div></template>
              </div>
              <span v-if="plan.contentHash" class="mono hashline">sha256: {{ plan.contentHash.slice(0, 12) }}…</span>
            </div>
            <div v-else-if="plan.command" class="shrow col">
              <span class="shlabel">完整启动命令（原样）</span>
              <code class="cmdline mono">{{ plan.command.command }} {{ plan.command.args.join(' ') }}</code>
            </div>
            <div v-else-if="plan.url" class="shrow col">
              <span class="shlabel">服务 URL</span>
              <code class="cmdline mono">{{ plan.url }}</code>
            </div>

            <!-- §4-4 gating 提示 -->
            <div v-if="plan.gating?.binsMissing?.length" class="mkgate">
              启动命令二进制缺失：{{ plan.gating.binsMissing.join(', ') }}（仍可安装，运行时将报错）
            </div>
            <div v-if="plan.manualOnly" class="mkblocknote">
              该条目无白名单内的一键安装命令，需手动配置（设置 → MCP 页手动添加）。
            </div>

            <!-- §4-5 MCP env 声明（只带键名与说明；值在此本地收集，isSecret 密文输入）。
                 G4 更新流：envPrefilled 键提示「保留原值」——留空即沿用已存值（更新不丢用户配置） -->
            <template v-if="plan.env && plan.env.length > 0">
              <div class="shlabel envhead">环境变量（值只存在本机，绝不来自注册表）</div>
              <template v-for="d in plan.env" :key="d.name">
                <div class="envrow">
                  <label class="envname mono" :for="'env-' + d.name">
                    {{ d.name }}<span v-if="d.required" class="envreq">必填</span><span
                      v-if="(plan.envPrefilled ?? []).includes(d.name)" class="envsaved"
                      title="已保存的值将保留原样，留空即沿用"
                    >保留原值</span>
                  </label>
                  <input
                    :id="'env-' + d.name" v-model="envValues[d.name]" class="envinput"
                    :type="d.isSecret ? 'password' : 'text'"
                    :placeholder="(plan.envPrefilled ?? []).includes(d.name)
                      ? `已保存——留空沿用原值（${d.description || d.name}）`
                      : (d.description || d.name)"
                  />
                </div>
              </template>
              <div v-if="envMissingNow.length > 0" class="mkgate">必填环境变量缺失：{{ envMissingNow.join(', ') }}</div>
            </template>

            <!-- warn 勾选确认 -->
            <label v-if="plan.verdict === 'warn'" class="warnack">
              <input v-model="warnAck" type="checkbox" />
              <span>我已了解该条目被上游标记为可疑，仍要安装</span>
            </label>

            <!-- 技能安装进度（既有 skills.import.progress 广播） -->
            <div v-if="installing && confirmFor.kind === 'skill' && importProgress" class="mkprogress mono">
              导入中：{{ importProgress.completed }}/{{ importProgress.total }}
            </div>
            <div v-else-if="installing" class="mkprogress">安装中…</div>
            <div v-if="installError" class="mkerr">{{ installError }}</div>
          </template>
        </div>
        <div class="shfoot">
          <button type="button" class="shcancel" @click="closeConfirm">取消</button>
          <button
            type="button" class="shok" :disabled="!canConfirm"
            :title="plan?.manualOnly ? '需手动配置' : ''"
            @click="doInstall"
          >{{ plan?.manualOnly ? '需手动配置' : (isUpdate ? '确认更新' : '确认安装') }}</button>
        </div>
      </div>
    </div>

    <!-- toast -->
    <div v-if="toastMsg" class="mktoast" role="status">{{ toastMsg }}</div>
  </div>
</template>

<style scoped>
/* Aurora 语言：全部实心浮岛，零背景模糊滤镜（内容面板纪律；本组件在例 8
   POPUP_OWNERS 永久禁 blur 名单内）。色一律走既有令牌，零硬编码 hex/rgba。 */
.mkp {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg); position: relative;
}

/* 顶部：子 tab 段控 + 搜索框 */
.mkhead {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 10px 14px 8px;
}
.mkseg { display: flex; border: .5px solid var(--separator); border-radius: var(--r-control); overflow: hidden; flex: 0 0 auto; }
.mkseg button {
  border: none; background: none; cursor: pointer;
  padding: 4px 14px; font-size: var(--fs-ui); color: var(--label-secondary);
}
.mkseg button.on { background: var(--action); color: var(--on-action); font-weight: 600; }
.mkseg button:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.mksearch {
  flex: 1; min-width: 0; padding: 5px 10px;
  border: .5px solid var(--separator); border-radius: var(--r-input);
  background: var(--surface-1); color: var(--label);
  font-size: var(--fs-ui);
}
.mksearch:focus-visible { outline: 2px solid var(--ring-input); outline-offset: -1px; }
.mksearch::placeholder { color: var(--label-tertiary); }

/* 源过滤 chips */
.mkchips { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 0 14px 8px; flex-wrap: wrap; }
.chip {
  padding: 2px 10px; border-radius: var(--r-pill);
  border: .5px solid var(--separator); background: var(--surface-1);
  color: var(--label-secondary); font-size: var(--fs-micro); cursor: pointer;
}
.chip.on { border-color: var(--action); color: var(--action); font-weight: 600; }
.chip.off { color: var(--label-quaternary); }
.chip:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

/* stale 离线缓存提示条 */
.mkstalebar {
  flex: 0 0 auto; margin: 0 14px 8px; padding: 5px 10px;
  border: .5px solid var(--state-warn-border); border-radius: var(--r-control);
  background: var(--state-warn-bg); color: var(--label-secondary);
  font-size: var(--fs-micro);
}

/* G4 更新检查：按钮（chips 行右端）+ 结果区 */
.mkupd-btn { margin-left: auto; }
.mkupd-btn:disabled { opacity: var(--opacity-disabled); cursor: default; }
.mkupd {
  flex: 0 0 auto; margin: 0 14px 8px; padding: 6px 10px;
  border: .5px solid var(--separator); border-radius: var(--r-control);
  background: var(--surface-1);
  display: flex; flex-direction: column; gap: 4px;
}
.mkupd-line { display: flex; align-items: center; gap: 8px; color: var(--label-secondary); font-size: var(--fs-micro); }
.mkupd-all { color: var(--state-ok); font-size: var(--fs-micro); }
.mkupd-uns { color: var(--label-quaternary); font-size: var(--fs-micro); }
.mkupd-err { color: var(--state-warn); font-size: var(--fs-micro); }
.updrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.updname {
  flex: 0 1 auto; min-width: 0; font-size: var(--fs-ui); font-weight: 600; color: var(--label);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 可更新标记（mono）：action 色系——可执行的动作信号，非警告语义 */
.mc-upd {
  flex: 0 0 auto; padding: 1px 8px; border-radius: var(--r-pill);
  border: .5px solid var(--action); color: var(--action); font-weight: 600;
}
.upd-blocknote { margin: 0; font-size: var(--fs-micro); color: var(--state-err); }
/* 转圈：既有令牌上色的细环（零新色） */
.mkspin {
  flex: 0 0 auto; width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid var(--fill-tertiary); border-top-color: var(--action);
  animation: mkspin-rot .8s linear infinite;
}
@keyframes mkspin-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mkspin { animation-duration: 2.4s; } }

/* 卡片流 */
.mklist {
  flex: 1; min-height: 0; overflow-y: auto; padding: 2px 14px 16px;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px; align-content: start;
}
/* 浮岛卡片：实心面 + 静态阴影（性能纪律：无逐卡阴影动画）+ 顶缘内高光 */
.mcard {
  display: flex; flex-direction: column; gap: 4px; padding: 10px 12px;
  border: .5px solid var(--separator); border-radius: var(--r-card);
  background: var(--surface-1); cursor: pointer;
  box-shadow: inset 0 1px 0 var(--glass-edge), 0 2px 8px var(--shadow-color);
}
.mcard:hover { background: var(--fill-quaternary); }
.mcard:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.mcard.blocked { border-color: var(--state-err-border); }
.mc-top { display: flex; align-items: center; gap: 8px; }
.mc-name {
  flex: 1; min-width: 0; font-size: var(--fs-ui); font-weight: 600; color: var(--label);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mc-author {
  font-size: var(--fs-micro); color: var(--label-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mc-stats { font-size: var(--fs-micro); color: var(--label-tertiary); }
/* 描述两行截断 */
.mc-desc {
  margin: 2px 0 4px; font-size: var(--fs-micro); line-height: 1.5; color: var(--label-secondary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.mc-act { display: flex; align-items: center; gap: 8px; margin-top: auto; }
.mc-install {
  padding: 3px 14px; border: none; border-radius: var(--r-control);
  background: var(--action); color: var(--on-action);
  font-size: var(--fs-micro); font-weight: 600; cursor: pointer;
}
.mc-install:disabled { opacity: var(--opacity-disabled); cursor: default; background: var(--fill); color: var(--label-tertiary); }
.mc-install:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.mc-installed {
  padding: 3px 14px; border: .5px solid var(--state-ok-border); border-radius: var(--r-control);
  background: var(--state-ok-bg); color: var(--label-secondary);
  font-size: var(--fs-micro); cursor: default;
}
.mc-blocknote { margin: 2px 0 0; font-size: var(--fs-micro); color: var(--state-err); }
.mkblocknote { margin: 6px 0; font-size: var(--fs-micro); line-height: 1.6; color: var(--state-err); }
.mkwarnnote { margin: 6px 0; font-size: var(--fs-micro); line-height: 1.6; color: var(--state-warn); }
.mkwarnline { margin: 4px 0; font-size: var(--fs-micro); color: var(--label-tertiary); }
.mkunscanned { margin: 6px 0; font-size: var(--fs-micro); color: var(--label-tertiary); }

/* verdict 徽章：四态全走既有 state/label 令牌，零新色 */
.vb { flex: 0 0 auto; padding: 1px 8px; border-radius: var(--r-pill); font-size: var(--fs-micro); font-weight: 600; }
.vb-ok { color: var(--state-ok); border: .5px solid var(--state-ok-border); background: var(--state-ok-bg); }
.vb-warn { color: var(--state-warn); border: .5px solid var(--state-warn-border); background: var(--state-warn-bg); }
.vb-malicious { color: var(--state-err); border: .5px solid var(--state-err-border); background: var(--state-err-bg); }
.vb-unscanned { color: var(--label-tertiary); border: .5px solid var(--separator); background: var(--surface-2); }

/* 源徽章 */
.srcbadge {
  padding: 0 6px; border-radius: var(--r-pill); border: .5px solid var(--separator);
  font-size: var(--fs-micro); color: var(--label-tertiary);
}
.tierbadge { padding: 0 6px; border-radius: var(--r-pill); font-size: var(--fs-micro); }
.tier-official { color: var(--state-ok); border: .5px solid var(--state-ok-border); }
.tier-community { color: var(--label-tertiary); border: .5px solid var(--separator); }

.mono { font-family: var(--font-mono); font-size: var(--fs-mono); }
.mkloading { grid-column: 1 / -1; padding: 18px 0; text-align: center; color: var(--label-tertiary); font-size: var(--fs-ui); }
.mkempty { grid-column: 1 / -1; padding: 26px 12px; text-align: center; color: var(--label-tertiary); font-size: var(--fs-ui); line-height: 1.7; }
.mkerr { grid-column: 1 / -1; margin: 6px 0; padding: 8px 10px; border-radius: var(--r-control); background: var(--state-err-bg); color: var(--state-err); font-size: var(--fs-micro); line-height: 1.6; }

/* 详情（就地展开） */
.mkdetail { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 16px 20px; }
.mkdhead { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.mkback {
  flex: 0 0 auto; border: none; background: none; cursor: pointer;
  color: var(--label-secondary); font-size: var(--fs-ui); padding: 3px 6px; border-radius: var(--r-control);
}
.mkback:hover { background: var(--fill-quaternary); color: var(--label); }
.mkback:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.mkname { flex: 1; min-width: 0; font-size: var(--fs-title); font-weight: 700; color: var(--label-strong); }
.mkdmeta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; color: var(--label-secondary); font-size: var(--fs-micro); }
.mkinstall {
  padding: 4px 18px; border: none; border-radius: var(--r-control);
  background: var(--action); color: var(--on-action); font-size: var(--fs-ui); font-weight: 600; cursor: pointer;
}
.mkinstall:disabled { opacity: var(--opacity-disabled); cursor: default; background: var(--fill); color: var(--label-tertiary); }
.mkinstall:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.mkmanage {
  padding: 4px 14px; border: .5px solid var(--state-ok-border); border-radius: var(--r-control);
  background: var(--state-ok-bg); color: var(--label-secondary); font-size: var(--fs-micro); cursor: pointer;
}
.mkmanage:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.mkreadme { border-top: .5px solid var(--separator); padding-top: 12px; }

/* 安装确认卡：scrim + sheet（照 SettingsModal 成例；z-index 同档 100） */
.mask {
  position: fixed; inset: 0; z-index: 100; background: var(--scrim);
  display: flex; align-items: center; justify-content: center;
}
.sheet {
  width: min(560px, calc(100vw - 64px)); max-height: min(640px, calc(100vh - 96px));
  background: var(--bg); border-radius: var(--r-sheet); box-shadow: var(--shadow-pop);
  display: flex; flex-direction: column; overflow: hidden;
}
.shhead {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 14px 16px 10px; border-bottom: .5px solid var(--separator);
}
.shtitle { flex: 1; min-width: 0; font-size: var(--fs-title); font-weight: 700; color: var(--label-emphasis); }
.xbtn {
  flex: 0 0 auto; width: 26px; height: 26px; border: none; border-radius: var(--r-control);
  background: none; color: var(--label-secondary); cursor: pointer; font-size: 13px;
}
.xbtn:hover { background: var(--fill-tertiary); color: var(--label); }
.xbtn:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.shbody { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; }
.shrow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.shrow.col { flex-direction: column; align-items: stretch; }
.shlabel { font-size: var(--fs-micro); color: var(--label-tertiary); flex: 0 0 auto; }
.filelist {
  max-height: 140px; overflow-y: auto; padding: 8px 10px;
  border: .5px solid var(--separator); border-radius: var(--r-control); background: var(--surface-1);
}
.hashline { color: var(--label-tertiary); }
.cmdline {
  display: block; padding: 8px 10px; border: .5px solid var(--separator);
  border-radius: var(--r-control); background: var(--surface-1); color: var(--label);
  word-break: break-all;
}
.mkgate { margin: 6px 0; font-size: var(--fs-micro); color: var(--state-warn); line-height: 1.6; }
.envhead { margin: 8px 0 4px; }
.envrow { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.envname { font-size: var(--fs-micro); color: var(--label-secondary); }
.envreq { margin-left: 6px; color: var(--state-warn); font-size: var(--fs-micro); }
/* G4 更新流「保留原值」徽标：已存值沿用（state-ok 系，零新色） */
.envsaved { margin-left: 6px; color: var(--state-ok); font-size: var(--fs-micro); }
.envinput {
  padding: 5px 10px; border: .5px solid var(--separator); border-radius: var(--r-input);
  background: var(--surface-1); color: var(--label); font-size: var(--fs-ui);
}
.envinput:focus-visible { outline: 2px solid var(--ring-input); outline-offset: -1px; }
.warnack { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; font-size: var(--fs-micro); color: var(--label-secondary); cursor: pointer; }
.mkprogress { margin: 8px 0; font-size: var(--fs-micro); color: var(--label-secondary); }
.shfoot {
  flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px 14px; border-top: .5px solid var(--separator);
}
.shcancel {
  padding: 5px 16px; border: .5px solid var(--separator); border-radius: var(--r-control);
  background: none; color: var(--label-secondary); font-size: var(--fs-ui); cursor: pointer;
}
.shcancel:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.shok {
  padding: 5px 18px; border: none; border-radius: var(--r-control);
  background: var(--action); color: var(--on-action); font-size: var(--fs-ui); font-weight: 600; cursor: pointer;
}
.shok:disabled { opacity: var(--opacity-disabled); cursor: default; }
.shok:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

/* toast：面板底部浮岛（实心，无 blur） */
.mktoast {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
  padding: 7px 16px; border-radius: var(--r-pill);
  background: var(--surface-2); border: .5px solid var(--separator);
  box-shadow: var(--shadow-pop); color: var(--label); font-size: var(--fs-ui);
  z-index: 5;
}
</style>
