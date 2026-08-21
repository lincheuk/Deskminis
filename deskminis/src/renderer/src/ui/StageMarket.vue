<script setup lang="ts">
/** V7：扩展市场。技能 / MCP 两类，搜索 → 详情 → 确认卡 → 安装。
 *
 *  **这是唯一会把第三方代码装进本机的入口**，所以安全闸一条都不能少（逐条照旧面板）：
 *  ① malicious 条目根本不开确认卡——Install 钮直接禁用，这里是唯一开口；
 *  ② warn 必须勾一次「我知道风险」才给装；
 *  ③ manualOnly 转禁用态并说明要手动配置；
 *  ④ 必填 env 没填齐不给装；更新流排除 envPrefilled（已存值保留，不必重输）；
 *  ⑤ env 声明里 isSecret 的走 password 输入；
 *  ⑥ install 一律显式 confirm:true。
 *  服务端还会再复核一遍——渲染层的闸是「不给可点态」，不是唯一防线。
 *
 *  性能：搜索防抖 300ms 在渲染端；分页滚到底才取下一页；
 *  竞态闸 searchSeq——快速切词/切类时迟到的旧页不许覆盖新查询的结果。 */
import { computed, onMounted, ref, watch } from 'vue';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import { parseMarkdown, type MdNode } from '../lib/markdown/parse';
import MarkdownView from '../components/MarkdownView.vue';
import UiIcon from './UiIcon.vue';

const SEARCH_DEBOUNCE_MS = 300;

type MarketKind = 'skill' | 'mcp';
type MarketVerdict = 'ok' | 'warn' | 'malicious' | 'unscanned';
interface MarketItem {
  id: string; kind: MarketKind; name: string; author: string; description: string;
  stats: { downloads: number; stars: number };
  verdict: MarketVerdict; sourceTier: 'official' | 'community'; raw?: unknown;
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
  envPrefilled?: string[];
  gating?: { envMissing?: string[]; binsMissing?: string[] };
  manualOnly?: true;
}
interface MarketUpdateItem { id: string; kind: MarketKind; name: string; current: string; latest: string; verdict: MarketVerdict }

const VERDICT_LABEL: Record<MarketVerdict, string> = { ok: '安全', warn: '可疑', malicious: '恶意', unscanned: '未扫描' };
const chat = useChat();

// ---- 子类与搜索 ----
const kind = ref<MarketKind>('skill');
const searchInput = ref('');
const q = ref('');
let debounce: ReturnType<typeof setTimeout> | undefined;
watch(searchInput, (v) => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => { q.value = v.trim(); }, SEARCH_DEBOUNCE_MS);
});

// ---- 源清单 ----
const sources = ref<MarketSourceStatus[]>([]);
const sourceFilter = ref('all');
const sourcesForKind = computed(() => sources.value.filter(s => s.kinds.includes(kind.value)));
async function loadSources(): Promise<void> {
  try {
    const r = await rpc.call<{ sources?: MarketSourceStatus[] }>('market.sources.list');
    sources.value = r?.sources ?? [];
  } catch { /* 源清单拉不到不阻塞浏览：聚合层自降级 */ }
}
function sourceNameOf(it: MarketItem): string {
  const prefix = it.id.slice(0, it.id.indexOf(':'));
  return sources.value.find(s => s.id === prefix)?.name ?? prefix;
}

// ---- 列表 ----
const items = ref<MarketItem[]>([]);
const cursor = ref<string | undefined>(undefined);
const stale = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const loaded = ref(false);
const listError = ref('');
/** 竞态闸：搜索词/类目快速切换时，迟到的旧页不得覆盖新查询的结果。 */
let searchSeq = 0;

async function fetchFirst(): Promise<void> {
  const seq = ++searchSeq;
  loading.value = true; listError.value = '';
  try {
    const page = await rpc.call<{ items?: MarketItem[]; cursor?: string; stale?: boolean }>('market.search', { kind: kind.value, q: q.value });
    if (seq !== searchSeq) return;
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
    const page = await rpc.call<{ items?: MarketItem[]; cursor?: string; stale?: boolean }>('market.search', { kind: kind.value, q: q.value, cursor: cursor.value });
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
/** 这一类的源全都连不上时，空结果的原因是**网络**不是**没搜到**。
 *  照实说——不然用户会一直换词试（实拍逮到：容器里两个源都不可达，
 *  界面却在劝人「换个词试试」）。 */
const allUnreachable = computed(() =>
  sourcesForKind.value.length > 0 && sourcesForKind.value.every(s => s.reachable !== 'ok'));

const shown = computed(() => (sourceFilter.value === 'all'
  ? items.value : items.value.filter(it => it.id.startsWith(sourceFilter.value + ':'))));

const listEl = ref<HTMLElement | null>(null);
function onScroll(): void {
  const el = listEl.value;
  if (!el || !cursor.value || loading.value || loadingMore.value) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) void loadMore();
}
watch([q, kind], () => { void fetchFirst(); });
function switchKind(k: MarketKind): void {
  if (kind.value === k) return;
  kind.value = k; sourceFilter.value = 'all'; detail.value = null;
}

// ---- 已装比对 ----
const installedIds = ref(new Set<string>());
async function refreshInstalled(): Promise<void> {
  try {
    const s = await rpc.call<{ items?: { id: string }[] }>('market.installed', { kind: 'skill' });
    const m = await rpc.call<{ items?: { id: string }[] }>('market.installed', { kind: 'mcp' });
    installedIds.value = new Set([...(s?.items ?? []), ...(m?.items ?? [])].map(x => x.id));
  } catch { /* 比对失败不阻塞浏览：按未装显示，安装时服务端仍复核 */ }
}

// ---- 更新检查（仅手动触发，无后台轮询） ----
const checking = ref(false);
const checkResult = ref<{ updates: MarketUpdateItem[]; unsupported: string[]; errors: number } | null>(null);
const checkError = ref('');
const updatesById = computed(() => new Map((checkResult.value?.updates ?? []).map(u => [u.id, u])));
async function doCheckUpdates(): Promise<void> {
  if (checking.value) return;
  checking.value = true; checkError.value = ''; checkResult.value = null;
  try {
    const r = await rpc.call<{ updates?: MarketUpdateItem[]; unsupported?: string[]; errors?: number }>('market.checkUpdates');
    checkResult.value = {
      updates: r?.updates ?? [], unsupported: r?.unsupported ?? [],
      errors: typeof r?.errors === 'number' ? r.errors : 0,
    };
  } catch (e) { checkError.value = e instanceof Error ? e.message : String(e); }
  finally { checking.value = false; }
}

// ---- 详情（就地展开；README 只在此态请求） ----
const detail = ref<MarketItem | null>(null);
const readme = ref('');
const detailLoading = ref(false);
const detailError = ref('');
const readmeNodes = computed<MdNode[]>(() => parseMarkdown(readme.value));
/** ClawHub 的 README 就是 SKILL.md 全文（含 frontmatter），license 从里面取。 */
const license = computed(() => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readme.value);
  if (!m) return '';
  return /^license\s*:\s*(.+)$/m.exec(m[1])?.[1].trim() ?? '';
});
async function openDetail(it: MarketItem): Promise<void> {
  detail.value = it; readme.value = ''; detailError.value = ''; detailLoading.value = true;
  try {
    const d = await rpc.call<{ item: MarketItem; readme?: string }>('market.detail', { id: it.id });
    if (detail.value?.id !== it.id) return;   // 用户已返回列表：过期响应丢弃
    detail.value = d.item; readme.value = d.readme ?? '';
  } catch (e) {
    if (detail.value?.id === it.id) detailError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (detail.value?.id === it.id) detailLoading.value = false;
  }
}

// ---- 确认卡（更新流复用同一张卡，没有独立 update 通道） ----
type ConfirmTarget = Pick<MarketItem, 'id' | 'kind' | 'name' | 'verdict'>;
const confirmFor = ref<ConfirmTarget | null>(null);
const plan = ref<MarketInstallPlan | null>(null);
const planLoading = ref(false);
const planError = ref('');
const warnAck = ref(false);
const envValues = ref<Record<string, string>>({});
const installing = ref(false);
const installError = ref('');
const isUpdate = ref(false);
const toast = ref('');

function showToast(t: string): void { toast.value = t; setTimeout(() => (toast.value = ''), 2600); }

/** malicious 条目根本不出确认卡——这是唯一开口。
 *  opts.update：更新流豁免「已装拦截」（条目本来就已装），安全闸一分不少。 */
function openConfirm(it: ConfirmTarget, opts?: { update?: boolean }): void {
  if (it.verdict === 'malicious') return;
  if (!opts?.update && installedIds.value.has(it.id)) return;
  isUpdate.value = opts?.update === true;
  confirmFor.value = it;
  plan.value = null; planError.value = ''; installError.value = '';
  warnAck.value = false; envValues.value = {};
  planLoading.value = true;
  rpc.call<MarketInstallPlan>('market.installPlan', { id: it.id })
    .then(p => { if (confirmFor.value?.id === it.id) plan.value = p; })
    .catch(e => { if (confirmFor.value?.id === it.id) planError.value = e instanceof Error ? e.message : String(e); })
    .finally(() => { if (confirmFor.value?.id === it.id) planLoading.value = false; });
}
function closeConfirm(): void { confirmFor.value = null; }

const envMissingNow = computed(() =>
  (plan.value?.env ?? []).filter(d => d.required
    && !(envValues.value[d.name] ?? '').trim()
    && !(plan.value?.envPrefilled ?? []).includes(d.name)).map(d => d.name));

const canConfirm = computed(() =>
  !!plan.value && !planLoading.value && !installing.value
  && plan.value.verdict !== 'malicious'
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
    const u = updatesById.value.get(it.id);
    if (isUpdate.value && checkResult.value) {
      checkResult.value = { ...checkResult.value, updates: checkResult.value.updates.filter(x => x.id !== it.id) };
    }
    closeConfirm();
    showToast(isUpdate.value ? `已更新「${it.name}」${u ? `至 ${u.latest}` : ''}` : `已安装「${it.name}」`);
    void refreshInstalled();
    if (it.kind === 'skill') void chat.refreshAllSkills();
    else void chat.fetchMcpServers();
  } catch (e) {
    installError.value = e instanceof Error ? e.message : String(e);   // 服务端错误照实显示，不静默吞
  } finally { installing.value = false; }
}

onMounted(() => { void loadSources(); void refreshInstalled(); void fetchFirst(); });
const fmtN = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
</script>

<template>
  <div class="market">
    <header class="head">
      <div class="htxt">
        <h1 class="t-h1">扩展市场</h1>
        <p class="t-body sub">装技能和 MCP 服务器。<b>装的是别人写的代码</b>——扫描结论就在卡片上，看清楚再装。</p>
      </div>
      <button class="f-btn" type="button" :disabled="checking" @click="doCheckUpdates">
        <UiIcon name="refresh" :size="14" />{{ checking ? '检查中…' : '检查更新' }}
      </button>
    </header>

    <div class="bar">
      <span class="seg">
        <button type="button" :class="{ on: kind === 'skill' }" @click="switchKind('skill')">技能</button>
        <button type="button" :class="{ on: kind === 'mcp' }" @click="switchKind('mcp')">MCP</button>
      </span>
      <span class="qbox">
        <UiIcon name="search" :size="15" />
        <input v-model="searchInput" class="qin" :placeholder="kind === 'skill' ? '搜技能，如「翻译」「PPT」' : '搜 MCP 服务器'" />
      </span>
    </div>

    <div v-if="sourcesForKind.length" class="chips">
      <button type="button" class="chip" :class="{ on: sourceFilter === 'all' }" @click="sourceFilter = 'all'">全部</button>
      <button
        v-for="s in sourcesForKind" :key="s.id" type="button"
        class="chip" :class="{ on: sourceFilter === s.id, off: s.reachable !== 'ok' }"
        :title="s.reachable !== 'ok' ? '这个源现在连不上' : s.name"
        @click="sourceFilter = s.id"
      >{{ s.name }}<span v-if="s.tier === 'official'" class="tier">官方</span></button>
    </div>

    <!-- 更新检查结果 -->
    <div v-if="checkError" class="line err">{{ checkError }}</div>
    <div v-else-if="checkResult" class="upd">
      <template v-if="checkResult.updates.length">
        <div class="uh t-aux">{{ checkResult.updates.length }} 个可更新</div>
        <div v-for="u in checkResult.updates" :key="u.id" class="urow">
          <span class="uname">{{ u.name }}</span>
          <span class="uver t-aux tnum">{{ u.current }} → {{ u.latest }}</span>
          <span v-if="u.verdict !== 'ok'" class="f-tag" :class="u.verdict === 'malicious' ? 'err' : ''">{{ VERDICT_LABEL[u.verdict] }}</span>
          <button class="f-btn" type="button" :disabled="u.verdict === 'malicious'" @click="openConfirm(u, { update: true })">更新</button>
        </div>
      </template>
      <div v-else class="line t-aux">都是最新的<template v-if="checkResult.unsupported.length">（{{ checkResult.unsupported.length }} 个来源不支持检查）</template></div>
    </div>

    <div v-if="stale" class="line warn t-aux">索引可能不是最新（源暂时连不上，显示的是缓存）</div>

    <!-- 详情态：就地换内容 -->
    <section v-if="detail" class="detail">
      <button class="back f-btn ghost" type="button" @click="detail = null"><UiIcon name="chevronRight" :size="14" />返回列表</button>
      <div class="dhead">
        <span class="dname t-h2">{{ detail.name }}</span>
        <span class="f-tag" :class="detail.verdict === 'ok' ? 'ok' : detail.verdict === 'malicious' ? 'err' : ''">{{ VERDICT_LABEL[detail.verdict] }}</span>
        <span v-if="license" class="f-tag">{{ license }}</span>
        <span class="grow"></span>
        <button
          class="f-btn primary" type="button"
          :disabled="detail.verdict === 'malicious' || installedIds.has(detail.id)"
          @click="openConfirm(detail)"
        >{{ installedIds.has(detail.id) ? '已安装' : '安装' }}</button>
      </div>
      <p class="dmeta t-aux">{{ detail.author }} · {{ sourceNameOf(detail) }} · ↓{{ fmtN(detail.stats.downloads) }} · ★{{ fmtN(detail.stats.stars) }}</p>
      <p v-if="detail.verdict === 'malicious'" class="line err">扫描判定为恶意，不提供安装。</p>
      <div v-if="detailLoading" class="line t-aux">读取说明…</div>
      <div v-else-if="detailError" class="line err">{{ detailError }}</div>
      <div v-else-if="readme" class="readme"><MarkdownView :nodes="readmeNodes" /></div>
      <p v-else class="line t-aux">这个条目没有提供说明文档。</p>
    </section>

    <!-- 列表态 -->
    <div v-else ref="listEl" class="list" @scroll="onScroll">
      <div v-if="loading" class="line t-aux">搜索中…</div>
      <div v-else-if="listError" class="line err">{{ listError }}</div>
      <div v-else-if="loaded && !shown.length" class="blank">
        <UiIcon :name="allUnreachable ? 'alert' : 'puzzle'" :size="26" />
        <p class="t-h2">{{ allUnreachable ? '连不上市场' : '没有找到' }}</p>
        <p class="t-body sub">
          <template v-if="allUnreachable">
            这一类的源现在都连不上（上面的名字是灰的）。检查网络或代理后再试；
            本地技能仍可在设置里按路径导入。
          </template>
          <template v-else-if="kind === 'mcp'">当前索引还没有收录 MCP 服务器。可以在设置里手动添加。</template>
          <template v-else>换个词试试，或者去设置里按路径导入本地技能。</template>
        </p>
      </div>
      <button v-for="it in shown" :key="it.id" type="button" class="card" @click="openDetail(it)">
        <span class="ctop">
          <span class="cname">{{ it.name }}</span>
          <span class="f-tag" :class="it.verdict === 'ok' ? 'ok' : it.verdict === 'malicious' ? 'err' : ''">{{ VERDICT_LABEL[it.verdict] }}</span>
          <span v-if="installedIds.has(it.id)" class="f-tag on">已装</span>
        </span>
        <span class="cdesc t-aux">{{ it.description || '没有描述' }}</span>
        <span class="cmeta t-aux">{{ it.author }} · {{ sourceNameOf(it) }} · ↓{{ fmtN(it.stats.downloads) }}</span>
      </button>
      <div v-if="loadingMore" class="line t-aux">加载更多…</div>
    </div>

    <!-- 安装确认卡 -->
    <div v-if="confirmFor" class="scrim" @click.self="closeConfirm">
      <div class="sheet" role="dialog" @keydown.esc="closeConfirm">
        <header class="sh">
          <span class="t-h2">{{ isUpdate ? '更新' : '安装' }}「{{ confirmFor.name }}」</span>
          <button class="f-btn ghost" type="button" @click="closeConfirm"><UiIcon name="x" :size="15" /></button>
        </header>

        <div v-if="planLoading" class="line t-aux">读取安装信息…</div>
        <div v-else-if="planError" class="line err">{{ planError }}</div>
        <template v-else-if="plan">
          <div class="krow"><span class="kk t-aux">来源</span><span class="kv">{{ plan.source.name }}<span v-if="plan.source.tier === 'official'" class="f-tag on">官方</span></span></div>
          <div class="krow"><span class="kk t-aux">扫描</span><span class="kv">{{ VERDICT_LABEL[plan.verdict] }}</span></div>
          <div v-if="plan.files?.length" class="krow">
            <span class="kk t-aux">将写入</span>
            <span class="kv mono">{{ plan.files.length }} 个文件<template v-if="plan.contentHash"> · {{ plan.contentHash.slice(0, 12) }}</template></span>
          </div>
          <div v-if="plan.command" class="krow">
            <span class="kk t-aux">将运行</span>
            <span class="kv mono">{{ plan.command.command }} {{ (plan.command.args ?? []).join(' ') }}</span>
          </div>
          <div v-if="plan.url" class="krow"><span class="kk t-aux">连接到</span><span class="kv mono">{{ plan.url }}</span></div>

          <div v-if="plan.env?.length" class="envs">
            <div class="kk t-aux">需要的环境变量</div>
            <label v-for="d in plan.env" :key="d.name" class="f-label">
              <span>{{ d.name }}<span v-if="d.required" class="req">*</span></span>
              <input
                v-model="envValues[d.name]" class="f-input"
                :type="d.isSecret ? 'password' : 'text'" autocomplete="off"
                :placeholder="(plan.envPrefilled ?? []).includes(d.name) ? '已有值，留空 = 保留原值' : (d.required ? '必填' : '可留空')"
              />
              <span class="f-hint">{{ d.description }}</span>
            </label>
          </div>

          <p v-if="plan.manualOnly" class="line warn">这个条目需要手动配置，装不了——按它的说明自己加。</p>
          <p v-else-if="plan.gating?.binsMissing?.length" class="line warn">
            本机缺少：{{ plan.gating.binsMissing.join('、') }}。装上之后它才能跑起来。
          </p>

          <label v-if="plan.verdict === 'warn'" class="ack">
            <input v-model="warnAck" type="checkbox" />
            <span class="t-aux">扫描把它标成了可疑。我看过来源，知道风险，仍然要装。</span>
          </label>

          <p v-if="installError" class="line err">{{ installError }}</p>
          <div class="f-row">
            <button class="f-btn primary" type="button" :disabled="!canConfirm" @click="doInstall">
              {{ installing ? '安装中…' : (isUpdate ? '更新' : '安装') }}
            </button>
            <button class="f-btn ghost" type="button" @click="closeConfirm">取消</button>
            <span v-if="envMissingNow.length" class="t-aux miss">还差：{{ envMissingNow.join('、') }}</span>
          </div>
        </template>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.market { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--c-bg); overflow: hidden; }
.head {
  flex: 0 0 auto; display: flex; align-items: flex-start; gap: var(--sp-5);
  width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto; padding: var(--sp-8) 0 var(--sp-5);
}
.htxt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.head h1 { margin: 0; color: var(--c-ink); }
.sub { margin: 0; color: var(--c-ink-3); }
.sub b { color: var(--c-ink-2); font-weight: var(--w-md); }

.bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-4);
  width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto var(--sp-4);
}
.seg { display: inline-flex; border: 1px solid var(--c-line); border-radius: var(--r-s); overflow: hidden; flex: 0 0 auto; }
.seg button {
  height: var(--h-ctl); padding: 0 var(--sp-5); background: none; cursor: pointer;
  font-size: var(--t-item-size); color: var(--c-ink-2); font-family: inherit;
}
.seg button.on { background: var(--c-brand); color: var(--c-brand-ink); font-weight: var(--w-md); }
.qbox {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-3);
  height: var(--h-field); padding: 0 var(--sp-5);
  background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-input);
}
.qbox:focus-within { border-color: var(--c-brand); box-shadow: var(--sh-focus); }
.qbox :deep(svg) { color: var(--c-ink-3); flex: 0 0 auto; }
.qin { flex: 1; min-width: 0; background: none; font-family: inherit; font-size: var(--t-body-size); color: var(--c-ink); outline: none; }
.qin::placeholder { color: var(--c-ink-4); }

.chips {
  flex: 0 0 auto; display: flex; gap: var(--sp-2); flex-wrap: wrap;
  width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto var(--sp-4);
}
.chip {
  height: var(--h-mini); padding: 0 var(--sp-4); border-radius: var(--r-pill); cursor: pointer;
  background: var(--c-bg-2); color: var(--c-ink-2); font-family: inherit; font-size: var(--t-aux-size);
  display: inline-flex; align-items: center; gap: var(--sp-2);
}
.chip.on { background: var(--c-brand-soft); color: var(--c-brand); font-weight: var(--w-md); }
.chip.off { opacity: .45; }
.tier { color: var(--c-aou); }

.list, .detail {
  flex: 1; min-height: 0; overflow-y: auto;
  width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto;
  padding-bottom: var(--sp-8); display: flex; flex-direction: column; gap: var(--sp-3);
}
.card {
  display: flex; flex-direction: column; gap: var(--sp-2); text-align: left; cursor: pointer;
  padding: var(--sp-5); background: var(--c-bg);
  border: 1px solid var(--c-line); border-radius: var(--r-m); font-family: inherit;
}
.card:hover { border-color: var(--c-brand-line); }
.ctop { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.cname { font-size: var(--t-item-size); font-weight: var(--w-md); color: var(--c-ink); }
.cdesc { color: var(--c-ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cmeta { color: var(--c-ink-3); }

.back { align-self: flex-start; }
.back :deep(svg) { transform: rotate(180deg); }
.dhead { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.dname { color: var(--c-ink); }
.grow { flex: 1; }
.dmeta { margin: 0; color: var(--c-ink-3); }
.readme {
  padding: var(--sp-6); background: var(--c-bg-1); border-radius: var(--r-m);
  font-size: var(--t-body-size); line-height: 1.7; color: var(--c-ink);
}

.line { margin: 0; padding: var(--sp-3) 0; font-size: var(--t-body-size); color: var(--c-ink-3); }
.line.err { color: var(--c-err); }
.line.warn { color: var(--c-warn); }
.blank {
  display: flex; flex-direction: column; align-items: center; gap: var(--sp-3);
  padding: var(--sp-8); text-align: center; color: var(--c-ink-3);
  background: var(--c-bg-1); border-radius: var(--r-m);
}
.blank p { margin: 0; }
.blank .t-h2 { color: var(--c-ink); }

.upd {
  width: min(var(--w-stage), 100% - var(--sp-8) * 2); margin: 0 auto var(--sp-4);
  display: flex; flex-direction: column; gap: var(--sp-2);
}
.uh { color: var(--c-ink-3); }
.urow {
  display: flex; align-items: center; gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4); background: var(--c-bg-1); border-radius: var(--r-s);
}
.uname { flex: 1; min-width: 0; font-size: var(--t-item-size); color: var(--c-ink); }
.uver { color: var(--c-ink-3); font-family: var(--f-mono); }

.scrim {
  /* 模态层级归 100 档（层级序不变量：主体 < 标题栏 50 < 模态 100）；
     遮罩色走 --c-scrim，组件内不写 rgba */
  position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
  background: var(--c-scrim); padding: var(--sp-8);
}
.sheet {
  width: min(560px, 100%); max-height: 84vh; overflow-y: auto;
  display: flex; flex-direction: column; gap: var(--sp-4);
  padding: var(--sp-7); background: var(--c-bg); border-radius: var(--r-l); box-shadow: var(--sh-pop);
}
.sh { display: flex; align-items: center; gap: var(--sp-4); }
.sh > span { flex: 1; min-width: 0; color: var(--c-ink); }
.krow { display: flex; gap: var(--sp-4); align-items: baseline; }
.kk { flex: 0 0 72px; color: var(--c-ink-3); }
.kv { flex: 1; min-width: 0; font-size: var(--t-body-size); color: var(--c-ink); display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.kv.mono { font-family: var(--f-mono); font-size: var(--t-code-size); word-break: break-all; }
.envs { display: flex; flex-direction: column; gap: var(--sp-4); padding-top: var(--sp-2); }
.req { color: var(--c-err); }
.ack { display: flex; align-items: flex-start; gap: var(--sp-3); color: var(--c-warn); cursor: pointer; }
.ack input { margin-top: 2px; cursor: pointer; }
.miss { color: var(--c-warn); }

.toast {
  position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); z-index: 100;
  padding: var(--sp-3) var(--sp-6); border-radius: var(--r-pill);
  background: var(--c-ink); color: var(--c-bg); font-size: var(--t-item-size);
  box-shadow: var(--sh-pop);
}
</style>
