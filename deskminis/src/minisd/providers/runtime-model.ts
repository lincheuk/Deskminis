/**
 * F01 resolveRuntimeModel：把「配置实例 + 端点/协议 + 模型 ID」解析成运行时契约 RuntimeModel（类型见 shared/runtime-model.ts），
 * 并给出每个槽位的请求计划（planSlot：max_tokens、推理参数、工具、图片怎么发、能不能接这一轮）。
 *
 * 取值顺序（数字）：实例手动修正 > 当前端点自己的目录记录 > 跨服务商汇总 / 备用目录 > 内置族表 > 无（窗口按 128K、输出按 8192 回退）。
 * 输出上限另过一道合理性检查（F01R）：非手动的值必须 ≤ 窗口的 3/4（outputCeiling），端点记录不满足就退到佐证值（同一条件），
 * 再退到 min(8192, 窗口的 3/4)——目录对没有单独输出上限的型号常把它写成等于窗口，原样发出去每条消息都被按窗口校验的端点拒绝。
 * 能力三层取交集：目录声明 × 当前端点是否确认 × 应用与协议是否实现。规则：
 *  - 手动修正与当前端点的记录是「确认」：给出 supported / unsupported；
 *  - 跨服务商汇总、备用目录、内置族表不代表当前端点：说有只是 unknown——中转不因为型号名相同就继承官方服务商的能力，
 *    官方 / 收录的端点自己没有这个型号的记录（或目录离线只剩内置族表）时也一样；
 *    说没有也要至少 3 家服务商有记录且全部否定才判 unsupported，不足的按 unknown（F01R：真实目录里的否定多数只有一家记录）；
 *  - 文本输入 / 输出没有手动修正项：当前端点的记录不列 text 而别家记录列了，按 unknown；没有任何记录列 text 才判 unsupported（F01R）；
 *  - 应用或协议没实现的传输（音视频 / PDF 原生输入、媒体生成、结构化输出、Ollama 的推理参数）一律 unavailable，手动修正打不开。
 * unknown 的运行时兼容选择：图片与工具照常发送（与 F01 之前一致，端点拒绝时走既有降级/报错；依据是不足 3 家的否定时另加提示）；
 * 推理参数不发并提示（F01R：未确认的端点不凭目录声明或型号名发推理参数，手动标为支持后才发）。
 *
 * 只读、无网络：不发探测请求，不碰密钥。
 */
import type { AgentMessage, ThinkingLevel } from '../../shared/types';
import type { ModelCatalogEntry } from '../../shared/model-metadata';
import {
  FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_OUTPUT, outputCeiling,
  type Capability, type CapabilityOverrides, type EndpointClass, type EvidenceSource, type InputMedium, type InstanceOverrides,
  type LimitValue, type OutputMedium, type ProviderKind, type ReasoningCapability, type RequestProtocol, type RuntimeModel,
} from '../../shared/runtime-model';
import { MIN_REQUEST_OUTPUT, type LimitProfile } from '../../shared/request-budget';
import type { BoolVotes, MediaConsensus, RuntimeCatalog } from './model-catalog';
import type { AdapterBudgetRule } from './types';
import { ANTHROPIC_BUDGET_RULE, ANTHROPIC_THINKING_BUDGETS, BINDING_MODELS } from './anthropic';
import { GEMINI_BUDGET_RULE, GEMINI_THINKING_BUDGETS } from './gemini';
import { OPENAI_CHAT_BUDGET_RULE } from './openai';

export interface RuntimeModelInput {
  id?: string;
  name?: string;
  kind: ProviderKind;
  baseUrl?: string;
  modelId: string;
  catalogProviderId?: unknown;
  /** 以下手动项原样来自 providers.json（可能是旧版本写下或手改的值），在这里归一与校验。 */
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  capabilityOverrides?: unknown;
}

// ───────────────────────── 端点 ─────────────────────────

/** 内置认得的官方端点（与设置页 F01 之前的判定一致）；其余服务商靠目录里的 api 地址前缀匹配。 */
const OFFICIAL_HOSTS: Readonly<Record<string, string>> = {
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google',
  'api.openai.com': 'openai',
};

/** baseUrl 留空时各类型实际请求的地址（与 ProviderStore.instantiate / 各 Provider 构造器的缺省值一致）。 */
const DEFAULT_BASE_URL: Readonly<Record<ProviderKind, string>> = {
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  'openai-compat': 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

function isLoopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

const trimPath = (p: string): string => p.replace(/\/+$/, '');

/**
 * 配置的 base URL 属于哪类端点。目录匹配要求「目录里的 api 地址是 base URL 的前缀」（同协议、同主机端口、路径按段前缀），
 * 取最长的那个；两个服务商的 api 地址一样长且都匹配时视为分不清，按中转处理——宁可未确认，也不错套别家的记录。
 * 回环地址不参与目录匹配（F01R）：它标识的是本机的一个端口，不是服务商——目录里有服务商把自己的 api 登记成回环地址
 * （LM Studio 等本机软件的默认端口），不能让它们认领本机上随便哪个服务并把自己的记录当成「已确认」。
 */
export function describeEndpoint(
  kind: ProviderKind, baseUrl: string | undefined, providerApis: Readonly<Record<string, string>> = {},
): { class: EndpointClass; host?: string; catalogProviderId?: string } {
  const raw = (typeof baseUrl === 'string' ? baseUrl.trim() : '') || DEFAULT_BASE_URL[kind];
  let url: URL;
  try { url = new URL(raw); } catch { return { class: 'relay' }; }
  const host = url.hostname.toLowerCase();
  // Object.hasOwn：主机名是 constructor、__proto__ 之类时，下标查表会取到原型上的东西、被当成官方端点（F01R）
  const official = Object.hasOwn(OFFICIAL_HOSTS, host) ? OFFICIAL_HOSTS[host] : undefined;
  if (official && url.protocol === 'https:') return { class: 'official', host, catalogProviderId: official };
  if (isLoopback(host)) return { class: 'local', host };
  const basePath = trimPath(url.pathname);
  let best: { id: string; len: number } | undefined;
  let tie = false;
  for (const [id, api] of Object.entries(providerApis)) {
    let a: URL;
    try { a = new URL(api); } catch { continue; }
    if (a.protocol !== url.protocol || a.host.toLowerCase() !== url.host.toLowerCase()) continue;
    const apiPath = trimPath(a.pathname);
    if (basePath !== apiPath && !basePath.startsWith(apiPath + '/')) continue;
    if (!best || apiPath.length > best.len) { best = { id, len: apiPath.length }; tie = false; }
    else if (apiPath.length === best.len) tie = true;
  }
  if (best && !tie) return { class: 'catalog', host, catalogProviderId: best.id };
  return { class: 'relay', host };
}

export function protocolOf(kind: ProviderKind): RequestProtocol {
  return kind === 'anthropic' ? 'anthropic' : kind === 'gemini' ? 'gemini' : 'openai-chat';
}

// ───────────────────────── 手动修正 ─────────────────────────

/** 正整数（安全整数）；纯数字字符串也收——M4.5 起就让用户手改 providers.json 的 contextWindow，旧运行时把 "200000" 当数用过。 */
function positiveInt(value: unknown): number | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 'invalid';
}

const CAPABILITY_KEYS: readonly (keyof CapabilityOverrides)[] = ['imageInput', 'toolCall', 'reasoning'];

function isCatalogProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

/**
 * 实例手动修正的归一与旧配置迁移（不改写文件）：
 *  - contextWindow：M4.5 起的旧字段，原名沿用；合法值照旧生效，但只作用于本实例（旧运行时按 modelId 全局生效，同名的其它实例会被带偏）；
 *  - 非法值（0、负数、小数、"200k" 之类）忽略并列进 invalid，界面与诊断照实显示——旧运行时会把它们当数用，水位判断失真却无人知道；
 *  - null 视为没填（JSON 里清空的写法）。
 */
export function normalizeInstanceOverrides(input: { contextWindow?: unknown; maxOutputTokens?: unknown; capabilityOverrides?: unknown; catalogProviderId?: unknown }, providerApis: Readonly<Record<string, string>> = {}): InstanceOverrides & { invalid: string[] } {
  const out: InstanceOverrides & { invalid: string[] } = { invalid: [] };
  const providerId = input.catalogProviderId;
  if (providerId !== undefined && providerId !== null) {
    if (!isCatalogProviderId(providerId)) out.invalid.push(`catalogProviderId=${JSON.stringify(providerId)}`);
    else if (!Object.hasOwn(providerApis, providerId.trim())) out.invalid.push(`catalogProviderId=${JSON.stringify(providerId)}（当前目录没有此服务商）`);
    else out.catalogProviderId = providerId.trim();
  }
  for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
    const v = positiveInt(input[key]);
    if (v === 'invalid') out.invalid.push(`${key}=${JSON.stringify(input[key])}`);
    else if (v !== undefined) out[key] = v;
  }
  const caps = input.capabilityOverrides;
  if (caps !== undefined && caps !== null) {
    if (typeof caps !== 'object' || Array.isArray(caps)) out.invalid.push(`capabilityOverrides=${JSON.stringify(caps)}`);
    else {
      const picked: CapabilityOverrides = {};
      for (const [key, v] of Object.entries(caps as Record<string, unknown>)) {
        // 只认三项：音视频 / PDF / 媒体生成没有修正项——应用没实现的传输，手动标「支持」也不能打开
        if (!(CAPABILITY_KEYS as readonly string[]).includes(key)) out.invalid.push(`capabilityOverrides.${key}`);
        else if (typeof v === 'boolean') picked[key as keyof CapabilityOverrides] = v;
        else if (v !== undefined && v !== null) out.invalid.push(`capabilityOverrides.${key}=${JSON.stringify(v)}`);
      }
      if (Object.keys(picked).length > 0) out.capabilityOverrides = picked;
    }
  }
  return out;
}

/**
 * provider.instances.create / update 的手动修正入参（F01）。只处理出现了的键：
 *  - null（JSON 里的清空写法）或 undefined → 清空该项；
 *  - contextWindow / maxOutputTokens 必须是正整数，capabilityOverrides 只收 imageInput / toolCall / reasoning 的布尔值
 *    （某项为 null = 回到按资料）；不合法当场报错、不落库——手改文件里的旧非法值走 normalizeInstanceOverrides 忽略。
 */
export function parseOverrideInput(p: Record<string, unknown>): { contextWindow?: number; maxOutputTokens?: number; capabilityOverrides?: CapabilityOverrides; catalogProviderId?: string; present: Set<string> } {
  const out: { contextWindow?: number; maxOutputTokens?: number; capabilityOverrides?: CapabilityOverrides; catalogProviderId?: string; present: Set<string> } = { present: new Set() };
  for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
    if (!(key in p)) continue;
    out.present.add(key);
    const v = p[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
      throw new Error(`${key === 'contextWindow' ? '上下文窗口' : '最大输出'}必须是正整数（留空表示按资料）`);
    }
    out[key] = v;
  }
  if ('catalogProviderId' in p) {
    out.present.add('catalogProviderId');
    const value = p.catalogProviderId;
    if (value !== null && value !== undefined) {
      if (!isCatalogProviderId(value)) throw new Error('目录里的服务商必须是非空字符串（最多 128 字符）');
      out.catalogProviderId = value.trim();
    }
  }
  if ('capabilityOverrides' in p) {
    out.present.add('capabilityOverrides');
    const caps = p.capabilityOverrides;
    if (caps !== null && caps !== undefined) {
      if (typeof caps !== 'object' || Array.isArray(caps)) throw new Error('能力修正必须是对象');
      const picked: CapabilityOverrides = {};
      for (const [key, v] of Object.entries(caps as Record<string, unknown>)) {
        if (!(CAPABILITY_KEYS as readonly string[]).includes(key)) throw new Error(`未知的能力修正项: ${key}`);
        if (v === null || v === undefined) continue;
        if (typeof v !== 'boolean') throw new Error(`能力修正 ${key} 必须是布尔值`);
        picked[key as keyof CapabilityOverrides] = v;
      }
      if (Object.keys(picked).length > 0) out.capabilityOverrides = picked;
    }
  }
  return out;
}

// ───────────────────────── 能力判定 ─────────────────────────

type Transport = Capability['transport'];

type CatalogSource = Capability['catalog']['source'];

interface Evidence {
  manual?: boolean;
  /** 当前端点记录里的值；undefined = 没有记录或记录没写这一项。 */
  endpoint?: boolean;
  /** 不限端点的资料（汇总 / 备用目录 / 内置族表）。 */
  declared?: boolean;
  declaredSource?: CatalogSource;
  /** declared === false 时，这个否定背后有几家服务商的记录；没有逐家资料（备用目录、内置族表）= 0。 */
  declaredVoters?: number;
  /** 汇总否定生效所需的家数，缺省 AGGREGATE_NEGATIVE_QUORUM；文本输入 / 输出传 1（没有任何记录列出才算）。 */
  negativeQuorum?: number;
  /** 当前端点的记录说没有、别家记录说有（只用于文本输入 / 输出）。 */
  endpointContradicted?: boolean;
  /** 当前端点在目录里认得出（官方 / 收录的服务商）时，它自己有没有这个型号的记录；中转与本机不传。
   *  只用来把「为什么未确认」说准（F01R）：官方端点不是中转。 */
  endpointRecord?: 'missing' | 'present';
}

/** 汇总层的否定至少要这么多家服务商有记录且全部否定，才当作模型本身没有这项能力（F01R）。
 *  真实目录里汇总层对工具调用的否定八成只有一家记录，多是那家的转发特性或录入缺漏，不是模型属性。 */
const AGGREGATE_NEGATIVE_QUORUM = 3;

const SOURCE_TEXT: Readonly<Record<EvidenceSource, string>> = {
  manual: '手动修正', endpoint: '当前端点的目录记录', aggregate: '跨服务商汇总', basellm: '备用目录', builtin: '内置模型族资料', none: '无资料',
};

function capability(what: string, ev: Evidence, transport: Transport, transportReason?: string): Capability {
  let catalog: Capability['catalog'];
  let endpoint: Capability['endpoint'] = 'unconfirmed';
  if (ev.endpoint !== undefined) {
    catalog = { value: ev.endpoint, source: 'endpoint' };
    // 端点记录的否定被别家记录反驳（F01R，只有文本输入 / 输出会传）：目录仍照实记，但不算对当前端点的确认
    endpoint = ev.endpoint === false && ev.endpointContradicted ? 'unconfirmed' : 'confirmed';
  }
  else if (ev.declared !== undefined) catalog = { value: ev.declared, source: ev.declaredSource ?? 'aggregate' };
  else catalog = { source: 'none' };
  // 手动修正是本配置对当前端点的确认，与目录分开记：界面并排显示「目录怎么说」与「这里改成了什么」
  if (ev.manual !== undefined) endpoint = 'confirmed';
  const base = { catalog, ...(ev.manual !== undefined ? { manual: ev.manual } : {}), endpoint, transport };

  if (transport !== 'implemented') {
    return { state: 'unavailable', ...base, reason: transportReason ?? `DeskMinis 尚未实现${what}` };
  }
  if (ev.manual !== undefined) {
    return ev.manual ? { state: 'supported', ...base } : { state: 'unsupported', ...base, reason: `本配置已手动标为不支持${what}` };
  }
  if (catalog.value === undefined) {
    return { state: 'unknown', ...base, reason: `目录没有${what}的资料，当前端点未确认` };
  }
  const src = SOURCE_TEXT[catalog.source];
  if (catalog.source === 'endpoint') {
    if (endpoint === 'confirmed') {
      return catalog.value
        ? { state: 'supported', ...base }
        : { state: 'unsupported', ...base, reason: `${src}标注不支持${what}` };
    }
    // 走到这里只会是 endpointContradicted：文本没有手动修正项，一条录入错误不该让整个配置发不出消息
    return { state: 'unknown', ...base, reason: `当前端点的目录记录没有列出${what}，但其他服务商对同一型号的记录列了：按未确认处理，照常发送` };
  }
  // 汇总类资料不代表当前端点：说有只算未确认。没确认的原因按端点说（F01R）——官方 / 收录的服务商走到这里，
  // 是它自己的目录记录里没有这个型号（目录离线、只剩内置族表时也是），或记录没写这一项，不能说成「中转、本机或未收录」
  if (catalog.value) {
    const gap = ev.endpointRecord === 'missing' ? '当前端点没有这个型号的目录记录，未确认'
      : ev.endpointRecord === 'present' ? '当前端点的目录记录没有写这一项，未确认'
        : '当前端点（中转、本机或未收录）未确认';
    return { state: 'unknown', ...base, reason: `${src}标注支持${what}，但${gap}` };
  }
  // 说没有：要有足够多家的记录且全部否定才当作模型本身没有这项能力（F01R）；不足的只算未确认，运行时照常发送并提示
  const voters = ev.declaredVoters ?? 0;
  const quorum = ev.negativeQuorum ?? AGGREGATE_NEGATIVE_QUORUM;
  if (voters >= quorum) {
    return { state: 'unsupported', ...base, reason: quorum <= 1 ? `${src}里没有任何服务商的记录列出${what}` : `${src}里 ${voters} 家服务商的记录一致标注不支持${what}` };
  }
  return {
    state: 'unknown', ...base,
    reason: voters >= 1
      ? `${src}里只有 ${voters} 家服务商有这个型号的记录、都标注不支持${what}，不足 ${quorum} 家，不据此判定当前端点`
      : `${src}标注不支持${what}，但没有逐家记录可佐证，不据此判定当前端点`,
  };
}

const has = (list: string[] | undefined, medium: string): boolean | undefined => list === undefined ? undefined : list.includes(medium);

/** 汇总层的某一项模态：每家都列 → 是；没有一家列 → 否；有分歧 → 没资料。没有逐家资料时退回整组共识。 */
function declaredMedium(media: MediaConsensus | undefined, list: string[] | undefined, medium: string): boolean | undefined {
  if (!media) return has(list, medium);
  if (media.all.includes(medium)) return true;
  return media.any.includes(medium) ? undefined : false;
}

const INPUT_NAMES: Readonly<Record<InputMedium, string>> = { text: '文本输入', image: '图片输入', audio: '音频输入', video: '视频输入', pdf: 'PDF 输入' };
const OUTPUT_NAMES: Readonly<Record<OutputMedium, string>> = { text: '文本输出', image: '图片生成', audio: '音频生成', video: '视频生成' };

/** 应用没接的输入传输：模型声明支持时说清「模型支持、应用未实现」，界面靠这句区分两件事。 */
const INPUT_GAP: Readonly<Partial<Record<InputMedium, string>>> = {
  audio: 'DeskMinis 尚未接入音频上传（音视频适配见 G03）',
  video: 'DeskMinis 尚未接入视频上传（音视频适配见 G03）',
  pdf: 'DeskMinis 尚未接入 PDF 原生输入；可用文件工具读取文本',
};
const OUTPUT_GAP = '当前应用只接入文本输出，图片/音频/视频生成尚未实现（见 G03）';

function limit(manual: number | undefined, endpoint: number | undefined, declared: number | undefined, declaredSource: EvidenceSource): LimitValue {
  if (manual !== undefined) {
    const catalogValue = endpoint ?? declared; // 手动值生效时仍把目录原值带上，界面并排显示
    return catalogValue !== undefined ? { value: manual, source: 'manual', declared: catalogValue } : { value: manual, source: 'manual' };
  }
  if (endpoint !== undefined) return { value: endpoint, source: 'endpoint' };
  if (declared !== undefined) return { value: declared, source: declaredSource };
  return { source: 'none' };
}

/**
 * 模型输出上限（F01R；F02 起它是上限，单次请求实际申请多少由请求预算在它之下再定）。手动值原样、不做任何检查；
 * 非手动值要过合理性检查——不超过窗口的 3/4（outputCeiling）：
 *  1. 端点记录可信 → 用它（各服务商仍各取各的，不取跨服务商最小值）；
 *  2. 端点记录是被本配置手动填的窗口挤掉的（按目录自己的窗口可信）→ 按手动窗口的 3/4 封顶后采用（F02）；
 *  3. 否则佐证值（汇总 / 备用目录 / 内置族表）可信 → 用它；
 *  4. 佐证值是被手动窗口挤掉的 → 同样按手动窗口的 3/4 封顶后采用（F02）；
 *  5. 再否则 min(8192, 窗口的 3/4)。按目录自己的窗口就落在 (3/4 窗口, 窗口] 的值不「封顶后采用」：那是按窗口比例算的占位。
 * 为什么不能原样发：目录对没有单独输出上限的型号常写成等于窗口（或窗口的 0.8 / 0.9），按「输入 + max_tokens ≤ 窗口」
 * 校验的端点对任何非空输入都会 400，报出来还是一句误导人的「上下文已满」。
 * 第 2、4 步为什么到 F02 才放开：F01R 时 max_tokens 就是这个上限本身，把它提到手动窗口的 3/4 会让「输入 + max_tokens」
 * 在历史稍长时超窗；现在每次请求按剩余空间收紧（RequestBudget），上限取大不再有这个风险。此前这类旧配置
 * （手动填了窗口、没填最大输出）落到佐证值或 8192，例如 claude-sonnet-4-6 加手动窗口 64000 时 128000 → 8192。
 * 没被采用的目录原值记在 declared，原因与出路记在 note（规格卡显示）。window 是生效窗口（含手动窗口与 200K 计法）。
 * 第 2、4 步的结果另带 cappedBy: 'manual-window'：这个上限是手动窗口算出来的、不是模型自己的，输出额度用完时的
 * 错误说明（agent/request-budget.ts 的 outputExhaustedMessage）据此给出路，不靠 value 与窗口的大小关系去猜。
 * catalogWindow：窗口是本配置手动填的时候，传「不填会按多少计」的目录窗口（含 200K 计法）；窗口不是手动填的传 undefined。
 * 一个目录值按目录自己的窗口可信、按手动窗口才放不下时，它是被手动窗口挤掉的（本身可能就是真实规格）：照实说是手动窗口，
 * 出路写成同时手动填最大输出；按目录自己的窗口就不可信的（不填手动窗口同样被弃用——照目录把窗口原样填上的配置就是这样），
 * 仍是目录的占位写法，说明与不填时相同，不让人去怀疑自己填的窗口。
 */
function resolveOutputLimit(
  manual: number | undefined, endpoint: number | undefined, declared: number | undefined,
  declaredSource: EvidenceSource, window: number, catalogWindow: number | undefined,
): { limit: LimitValue; requestMaxTokens: number } {
  if (manual !== undefined) return { limit: limit(manual, endpoint, declared, declaredSource), requestMaxTokens: manual };
  const ceiling = outputCeiling(window);
  const usable = (n: number | undefined): n is number => n !== undefined && n > 0;
  const trusted = (n: number | undefined): n is number => usable(n) && n <= ceiling;
  /** 这个（按生效窗口不可信的）目录值是被手动窗口挤掉的。 */
  const squeezed = (n: number | undefined): n is number => usable(n) && catalogWindow !== undefined && n <= outputCeiling(catalogWindow);
  const why = (n: number): string => {
    const windowName = squeezed(n) ? '本配置手动填写的上下文窗口' : '上下文窗口';
    return n >= window ? `不小于${windowName}` : `超过${windowName}的 3/4`;
  };
  const way = (n: number): string => squeezed(n) ? '需要更大的输出上限时可在本配置同时手动填写最大输出' : '确认真实上限后可在本配置手动填写最大输出';
  /** 封顶后采用的说明（第 2、4 步共用的后半句）。 */
  const capped = `输出上限按窗口的 3/4（${ceiling}）计，单次请求再按上下文剩余空间收紧`;

  if (trusted(endpoint)) return { limit: { value: endpoint, source: 'endpoint' }, requestMaxTokens: endpoint };
  if (squeezed(endpoint)) {
    return {
      limit: {
        value: ceiling, source: 'endpoint', declared: endpoint, cappedBy: 'manual-window',
        note: `当前端点记录的最大输出 ${endpoint} ${why(endpoint)}（窗口 ${window}）：${capped}。${way(endpoint)}`,
      },
      requestMaxTokens: ceiling,
    };
  }
  /** 端点记录写了、但按目录自己的窗口就不可信（走到这里的 usable 端点值都是这种）。 */
  const placeholder = usable(endpoint)
    ? `当前端点记录的最大输出 ${endpoint} ${why(endpoint)}（窗口 ${window}），没有给输入留出余量，多为目录的占位写法，未采用；` : '';
  if (trusted(declared)) {
    if (!usable(endpoint)) return { limit: { value: declared, source: declaredSource }, requestMaxTokens: declared };
    return {
      limit: {
        value: declared, source: declaredSource, declared: endpoint,
        note: `${placeholder}输出上限改按${SOURCE_TEXT[declaredSource]}的 ${declared} 计。${way(endpoint)}`,
      },
      requestMaxTokens: declared,
    };
  }
  if (squeezed(declared)) {
    // 端点记录另写着一个占位值时，出路要提醒先确认真实上限：规格卡上并排显示的是那个占位值，不能引人照着它去填
    const advice = placeholder ? '确认真实上限后可在本配置同时手动填写最大输出' : way(declared);
    return {
      limit: {
        value: ceiling, source: declaredSource, declared: usable(endpoint) ? endpoint : declared, cappedBy: 'manual-window',
        note: `${placeholder}${SOURCE_TEXT[declaredSource]}的最大输出 ${declared} ${why(declared)}（窗口 ${window}）：${capped}。${advice}`,
      },
      requestMaxTokens: ceiling,
    };
  }
  const fallback = Math.min(FALLBACK_MAX_OUTPUT, ceiling);
  const raw = usable(endpoint) ? endpoint : usable(declared) ? declared : undefined;
  if (raw !== undefined) {
    return {
      limit: { source: 'none', declared: raw, note: `目录记录的最大输出 ${raw} ${why(raw)}（窗口 ${window}），未采用，也没有可采用的佐证值；输出上限按 ${fallback} 计。${way(raw)}` },
      requestMaxTokens: fallback,
    };
  }
  // 目录没写，或明写 0（只出图 / 只出视频的型号）：显示与 F01 相同，请求走兜底值
  const plain = limit(undefined, endpoint, declared, declaredSource);
  return {
    limit: fallback < FALLBACK_MAX_OUTPUT ? { ...plain, note: `没有输出上限资料，上下文窗口只有 ${window}：输出上限按窗口的 3/4（${fallback}）计` } : plain,
    requestMaxTokens: fallback,
  };
}

/** 官方 Anthropic 端点的 200K 以上窗口要靠长上下文 beta 头开启，DeskMinis 不发这个头：按 200K 计（低估只是更早压缩，高估会撞硬上限）。 */
const ANTHROPIC_STANDARD_WINDOW = 200_000;

export function resolveRuntimeModel(input: RuntimeModelInput, catalog: RuntimeCatalog): RuntimeModel {
  const providerApis = catalog.providerApiUrls();
  const overrides = normalizeInstanceOverrides(input, providerApis);
  const modelId = input.modelId;
  const protocol = protocolOf(input.kind);
  let endpoint: RuntimeModel['endpoint'] = describeEndpoint(input.kind, input.baseUrl, providerApis);
  // 官方主机有专门的请求约束，不能借手动目录项绕开；其它端点复用目录收录的整条解析链。
  if (endpoint.class === 'official' && input.catalogProviderId != null) {
    overrides.invalid.push(`catalogProviderId=${JSON.stringify(input.catalogProviderId)}（官方端点不改）`);
    delete overrides.catalogProviderId;
  } else if (overrides.catalogProviderId) {
    endpoint = { ...endpoint, class: 'catalog', catalogProviderId: overrides.catalogProviderId, manual: true };
  }
  const status = catalog.getStatus();
  const record: ModelCatalogEntry | undefined = endpoint.catalogProviderId ? catalog.getEndpointRecord(endpoint.catalogProviderId, modelId) : undefined;
  const declaredHit = catalog.getDeclaredRecord(modelId);
  const declared = declaredHit?.entry;
  const declaredSource: CatalogSource = declaredHit?.tier ?? 'none';

  // ── 数字 ──
  /** 窗口怎么取；manual 传 undefined 得到的就是「不填手动窗口时会按多少计」。 */
  const windowOf = (manual: number | undefined): LimitValue => {
    const w = limit(manual, record?.contextWindow, declared?.contextWindow, declaredSource);
    // 只看「请求打到官方 Anthropic 主机」与「不是手动值」（F01R）：窗口来自哪一层资料、用哪种协议接入，都一样没发 beta 头
    if (endpoint.class === 'official' && endpoint.catalogProviderId === 'anthropic'
      && w.source !== 'manual' && w.value !== undefined && w.value > ANTHROPIC_STANDARD_WINDOW) {
      w.declared = w.value;
      w.value = ANTHROPIC_STANDARD_WINDOW;
      w.note = '官方端点 200K 以上的窗口需要长上下文 beta 头，DeskMinis 未发送，按 200K 计；确认可用时可在本配置手动填写窗口';
    }
    return w;
  };
  const contextWindow = windowOf(overrides.contextWindow);
  const maxInputTokens = limit(undefined, record?.maxInputTokens, declared?.maxInputTokens, declaredSource);
  // 输出上限按生效窗口（含手动窗口与上面的 200K 计法）判是否可信，所以放在窗口之后算。
  // 窗口是手动填的时候另带上目录自己的窗口（同一套取法、不带手动值）：note 靠它分清目录值是被手动窗口挤掉的，还是本来就不可信
  const { limit: maxOutputTokens, requestMaxTokens } = resolveOutputLimit(
    overrides.maxOutputTokens, record?.maxOutputTokens, declared?.maxOutputTokens, declaredSource,
    contextWindow.value ?? FALLBACK_CONTEXT_WINDOW,
    contextWindow.source === 'manual' ? windowOf(undefined).value ?? FALLBACK_CONTEXT_WINDOW : undefined);

  // ── 模态 ──
  const manualCaps = overrides.capabilityOverrides ?? {};
  const media = declaredHit?.media;
  const votes = declaredHit?.votes;
  /** 汇总的否定背后有几家：有一家明确说支持就不算一致否定。 */
  const noVoters = (v: BoolVotes | undefined): number => v && v.yes === 0 ? v.no : 0;
  /** 端点认得出是哪家服务商（官方 / 目录收录）时，带上它有没有这个型号的记录：只影响「未确认」的原因怎么说。 */
  const known: Pick<Evidence, 'endpointRecord'> = endpoint.catalogProviderId !== undefined ? { endpointRecord: record ? 'present' : 'missing' } : {};
  const inputCap = (m: InputMedium): Capability => {
    const ev: Evidence = {
      ...known,
      manual: m === 'image' ? manualCaps.imageInput : undefined,
      endpoint: has(record?.inputModalities, m),
      declared: declaredMedium(media?.input, declared?.inputModalities, m), declaredSource,
      declaredVoters: media?.input?.voters ?? 0,
      // 文本没有手动修正项：只要有一家的记录列了 text，就不让当前端点记录的缺漏整轮拒发；没有任何记录列才算不支持
      ...(m === 'text' ? { negativeQuorum: 1, endpointContradicted: has(record?.inputModalities, 'text') === false && media?.input?.any.includes('text') === true } : {}),
    };
    const gap = INPUT_GAP[m];
    if (!gap) return capability(INPUT_NAMES[m], ev, 'implemented');
    // 应用没接：手动修正也打不开；模型确实声明支持时把「模型支持」写进原因
    const said = ev.endpoint ?? ev.declared;
    return capability(INPUT_NAMES[m], { ...ev, manual: undefined }, 'app-missing', said ? `模型支持${INPUT_NAMES[m]}，但${gap}` : gap);
  };
  const outputCap = (m: OutputMedium): Capability => {
    const ev: Evidence = {
      ...known,
      endpoint: has(record?.outputModalities, m), declared: declaredMedium(media?.output, declared?.outputModalities, m), declaredSource,
      declaredVoters: media?.output?.voters ?? 0,
      ...(m === 'text' ? { negativeQuorum: 1, endpointContradicted: has(record?.outputModalities, 'text') === false && media?.output?.any.includes('text') === true } : {}),
    };
    if (m === 'text') return capability(OUTPUT_NAMES[m], ev, 'implemented');
    const said = ev.endpoint ?? ev.declared;
    return capability(OUTPUT_NAMES[m], ev, 'app-missing', said ? `模型可${OUTPUT_NAMES[m]}，但${OUTPUT_GAP}` : OUTPUT_GAP);
  };

  const toolCall = capability('工具调用', {
    ...known, manual: manualCaps.toolCall, endpoint: record?.toolCall, declared: declared?.toolCall, declaredSource, declaredVoters: noVoters(votes?.toolCall),
  }, 'implemented');
  const structuredOutput = capability('结构化输出', { endpoint: record?.structuredOutput, declared: declared?.structuredOutput, declaredSource },
    'app-missing', 'DeskMinis 目前不发送结构化输出请求');

  // ── 推理 ──
  const param: ReasoningCapability['param'] = input.kind === 'ollama' ? 'none' : protocol === 'openai-chat' ? 'effort' : 'budget';
  const reasoningBase = capability('推理', {
    ...known, manual: manualCaps.reasoning, endpoint: record?.thinking, declared: declared?.thinking, declaredSource, declaredVoters: noVoters(votes?.thinking),
  }, param === 'none' ? 'protocol-missing' : 'implemented', 'Ollama 接入不发送推理参数（其 OpenAI 兼容端点不认 reasoning_effort）');
  const reasoning: ReasoningCapability = {
    ...reasoningBase, param,
    // 推理控制方式只认当前端点自己的记录：中转与汇总不带（它们的推理是未确认，不发参数，见 decideThinking）
    ...(record?.reasoningControl ? { control: record.reasoningControl } : {}),
  };

  return {
    ...(input.id !== undefined ? { instanceId: input.id } : {}),
    ...(input.name !== undefined ? { instanceName: input.name } : {}),
    modelId, kind: input.kind, protocol,
    endpoint,
    catalog: {
      record: record ? 'endpoint' : declaredHit ? declaredHit.tier : 'none',
      ...((record?.name ?? declared?.name) !== undefined ? { name: record?.name ?? declared?.name } : {}),
      ...(status.fetchedAt !== undefined ? { fetchedAt: status.fetchedAt } : {}),
      stale: status.stale,
    },
    limits: { contextWindow, maxInputTokens, maxOutputTokens },
    requestMaxTokens,
    // F02：价格只认当前端点自己的记录（record 只在 official / catalog 端点上有）——中转不借用同名模型在别家的价格
    ...(record?.price ? { price: record.price } : {}),
    input: { text: inputCap('text'), image: inputCap('image'), audio: inputCap('audio'), video: inputCap('video'), pdf: inputCap('pdf') },
    output: { text: outputCap('text'), image: outputCap('image'), audio: outputCap('audio'), video: outputCap('video') },
    toolCall, structuredOutput, reasoning,
    overrides,
  };
}

// ───────────────────────── 约束形态（F02） ─────────────────────────

/** 各协议对「输入、输出与窗口」的约束，出处写在各 adapter 的导出处。 */
const BUDGET_RULES: Readonly<Record<RequestProtocol, AdapterBudgetRule>> = {
  anthropic: ANTHROPIC_BUDGET_RULE, 'openai-chat': OPENAI_CHAT_BUDGET_RULE, gemini: GEMINI_BUDGET_RULE,
};

/**
 * 这个配置实例的输入、输出与窗口是什么约束形态（F02）。不给所有 API 套一条「输入 + 输出 ≤ 窗口」：
 *  1. 协议规则是各有各的上限（Gemini）→ separate；
 *  2. 目录另给了输入上限 I，且 I + 输出上限 ≤ 窗口 → separate（两个额度互不占用，如官方 gpt-5：400,000 = 272,000 + 128,000）；
 *  3. 有 I 但 I + 输出上限 > 窗口 → shared，输入另受 I 限制；
 *  4. 其余 → shared，输入上限就是窗口。
 * 窗口是手动填的时候不看目录的输入上限：用户填的窗口是他对这个接入的断言，目录值不再压过它。I 不满足 0 < I < 窗口 时也当作没有。
 *
 * authority 说的是 inputLimit 这个数有多硬。跨服务商汇总（取被佐证的最小值）、备用目录、内置族表（取当代主力型号的下界）、
 * 官方 Anthropic 的 200K 计法都是有意取低的值——低估只是让压缩提前。它们照常用来判水位与收紧输出，但不能据此拒发：
 * 把「早压缩」的保守值当硬事实，会变成会话级的硬失败。只有本配置手动填的、或当前端点自己记录的原值才允许拒发。
 */
export function limitProfile(rt: RuntimeModel): LimitProfile {
  const cw = rt.limits.contextWindow; const mi = rt.limits.maxInputTokens;
  const W = cw.value ?? FALLBACK_CONTEXT_WINDOW;
  const C = rt.requestMaxTokens;
  const I = cw.source !== 'manual' && mi.value !== undefined && mi.value > 0 && mi.value < W ? mi.value : undefined;
  const rule = BUDGET_RULES[rt.protocol];
  const src: LimitValue = I !== undefined ? mi : cw;
  const authority: LimitProfile['authority'] = src.value === undefined ? 'none'
    : src.source === 'manual' ? 'manual'
    // 带 declared 的非手动值是被改小过的（200K 计法把目录原值记在 declared），不算端点记录的原值
    : src.source === 'endpoint' && src.declared === undefined ? 'endpoint'
    : 'advisory';
  const base = { outputCap: C, windowKnown: cw.value !== undefined, authority };
  if (rule.window === 'separate') {
    const inputLimit = I ?? W;
    return { ...base, kind: 'separate', inputLimit, basis: 'adapter-separate', note: `输入上限 ${inputLimit} 与输出上限 ${C} 分开计（${rule.note}）` };
  }
  if (I !== undefined && I + C <= W) {
    return { ...base, kind: 'separate', inputLimit: I, basis: 'catalog-input', note: `目录给出独立的输入上限 ${I}，输出上限 ${C} 另计` };
  }
  if (I !== undefined) {
    return { ...base, kind: 'shared', inputLimit: I, sharedWindow: W, basis: 'catalog-input+window', note: `目录给出输入上限 ${I}；输入与输出另共用 ${W} 的窗口（${rule.note}）` };
  }
  return { ...base, kind: 'shared', inputLimit: W, sharedWindow: W, basis: 'window', note: `输入与输出共用 ${W} 的窗口（${rule.note}）` };
}

// ───────────────────────── 请求计划 ─────────────────────────

export interface ThinkingPlan {
  level: ThinkingLevel;
  /** OpenAI 兼容端点实际发送的 reasoning_effort（目录声明了档位时映射过）。 */
  effort?: string;
  /** Anthropic / Gemini 实际发送的推理预算。 */
  budgetTokens?: number;
  /** 与用户请求的档位不一致时的说明。 */
  note?: string;
}

const EFFORT_RANK: Readonly<Record<string, number>> = { minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/** 请求档位映射到目录声明的档位：同名直用；否则取不高于它的最高档，没有再取高于它的最低档。'none' 等于关，不作映射目标。 */
export function mapEffort(requested: Exclude<ThinkingLevel, 'off'>, values: readonly string[]): string | undefined {
  const usable = values.filter(v => v in EFFORT_RANK);
  if (usable.includes(requested)) return requested;
  const rank = EFFORT_RANK[requested];
  const below = usable.filter(v => EFFORT_RANK[v] <= rank).sort((a, b) => EFFORT_RANK[b] - EFFORT_RANK[a]);
  if (below.length > 0) return below[0];
  return usable.filter(v => EFFORT_RANK[v] > rank).sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b])[0];
}

function controlKinds(control: NonNullable<ReasoningCapability['control']>): string {
  const kinds = [control.toggle ? '开关' : '', control.efforts?.length ? `档位（${control.efforts.join('/')}）` : '', control.budget ? '预算' : ''].filter(Boolean);
  return kinds.join('、');
}

/** 推理预算怎么随循环定下的 max_tokens 调整（F02）。
 *  tightened：maxTokens 是循环按这次请求的预算定下的值，不是模型上限。放不下最小预算时的说明改用不含数字的固定句——
 *  收紧后的值每轮都在变，带数字的话循环按文本去重就失效，工具循环里每一轮都刷一条。
 *  spaceLimited：这个值是被上下文剩余空间收紧的（预算的 limitedBy 为 window / floor）。这时预算要给可见输出留底：
 *  最多到 max_tokens − min(1024, max_tokens 的一半)。不留的话预算顶到 max_tokens − 1，思考用满时正文与工具调用的入参
 *  连一个 token 的额度都没有——上限大于档位预算的型号以前有几万 token 的可见输出，收紧不该把它变成 1。
 *  偏好造成的不同不在此列：偏好之上本就加了推理预算（resolveOutputPreference），可见输出的额度已经留在里面。 */
export interface ThinkingFit { tightened?: boolean; spaceLimited?: boolean }

function budgetPlan(rt: RuntimeModel, level: 'low' | 'medium' | 'high', maxTokens: number, range: { min?: number; max?: number }, who: string, fit: ThinkingFit = {}): ThinkingPlan {
  const tightened = fit.tightened === true;
  const table = rt.protocol === 'anthropic' ? ANTHROPIC_THINKING_BUDGETS : GEMINI_THINKING_BUDGETS;
  // Anthropic 的 budget_tokens 至少 1024，且必须小于 max_tokens
  const floor = Math.max(range.min ?? 0, rt.protocol === 'anthropic' ? 1024 : 0);
  // 给可见输出留的底：平时只保证预算小于 max_tokens；被剩余空间收紧时留出最小输出（空间连两倍最小输出都不到时留一半）
  const visible = fit.spaceLimited === true ? Math.max(1, Math.min(MIN_REQUEST_OUTPUT, Math.floor(maxTokens / 2))) : 1;
  const ceiling = Math.min(maxTokens - visible, range.max ?? Number.MAX_SAFE_INTEGER);
  let tokens = Math.min(table[level], ceiling);
  if (tokens < floor) {
    if (floor > ceiling) {
      return { level: 'off', note: tightened
        ? `${who} 的上下文剩余空间容不下最小推理预算，本轮未开启推理`
        : `${who} 的输出上限 ${maxTokens} 容不下最小推理预算 ${floor}，本轮未开启推理` };
    }
    tokens = floor;
  }
  return { level, budgetTokens: tokens };
}

/**
 * 这个槽位的思考由服务端自适应：Anthropic 协议上的三个型号（anthropic.ts BINDING_MODELS）。构建器不看档位——官方端点写
 * adaptive，中转上不写 thinking——所以 decideThinking 原样返回的档位进不了请求体：ThinkingPlan.level 不是 off 不等于
 * 「请求带了可调的推理参数」，调档位改变不了下一次请求。循环给截断说明报「这次带没带推理参数」时要看这里（F02）。
 * 同名型号经 OpenAI 兼容协议接入的不在此列：那边照常发 reasoning_effort。
 */
export function thinkingIsServerAdaptive(rt: Pick<RuntimeModel, 'protocol' | 'modelId'>): boolean {
  return rt.protocol === 'anthropic' && BINDING_MODELS.has(rt.modelId);
}

/**
 * 每个槽位各自决定推理参数（降级到别的槽位时重新算，不沿用主模型的参数）：
 *  - 不支持 / 协议不发 / 未确认 → 关。未确认（中转、本机、收录端点但没有该型号的记录、记录缺推理字段、内置族表与备用目录的
 *    声明）一律不发并提示（F01R）：目录里任一家说支持、或型号名命中内置族表，都不代表当前端点认这个参数；手动标为支持后才发。
 *    官方端点不例外：官方服务商自己的记录里没有这个型号、或目录离线只剩内置族表时，同样是未确认、不发（含官方 Gemini）；
 *  - 当前端点目录声明了控制方式：只发与当前接入参数一致的那种（effort 映射档位；预算夹进声明的区间），对不上就关并说明。
 *    例外是官方 Gemini（F01R）：有端点记录、但记录没声明预算时回到 F01 之前的档位预算表；
 *  - 没有声明控制方式（手动标支持、端点记录只写了 reasoning: true）：按档位发送，Anthropic 预算仍守 1024 下限。
 */
export function decideThinking(rt: RuntimeModel, requested: ThinkingLevel, maxTokens: number, who: string, opts: ThinkingFit = {}): ThinkingPlan {
  if (requested === 'off') return { level: 'off' };
  const r = rt.reasoning;
  if (r.state === 'unavailable') return { level: 'off', note: `${who}：${r.reason}，本轮未开启推理` };
  if (r.state === 'unsupported') return { level: 'off', note: `${who} 不支持推理（${r.manual !== undefined ? SOURCE_TEXT.manual : SOURCE_TEXT[r.catalog.source]}），本轮未开启推理` };
  // 这三个模型的思考由服务端自适应（anthropic.ts BINDING_MODELS），构建器不看档位，这里不改写也不提示。
  // 放在「未确认」之前：否则中转上的它们会多出一句与请求体无关的提示
  if (thinkingIsServerAdaptive(rt)) return { level: requested };
  if (r.state === 'unknown') {
    return { level: 'off', note: `${who} 的推理能力未确认（${r.reason}），本轮未发送推理参数；确认支持后可在「设置 → 模型 → 编辑 → 手动修正」把推理标为支持` };
  }
  const control = r.control;
  if (requested === 'xhigh' || requested === 'max') {
    if (r.param === 'effort' && control?.efforts?.includes(requested)) return { level: requested, effort: requested };
    // 未声明同名档位时，与请求高走完全相同的能力、控制方式与预算判断。
    const high = decideThinking(rt, 'high', maxTokens, who, opts);
    if (high.level === 'off') return high;
    const actual = high.effort ?? high.level;
    const note = r.param === 'budget' ? `${who}：这个接入按推理预算控制，最多到高，本轮按 high 发送`
      : control?.efforts?.length ? `推理档位 ${requested} 改为 ${actual}（${who} 只接受 ${control.efforts.join('/')}）`
      : `${who}：当前端点没有声明这一档，本轮按 ${actual} 发送`;
    return { ...high, note: high.note ? high.note + '；' + note : note };
  }
  if (control) {
    // 官方 Gemini：目录没声明预算（只有档位 / 开关，或写了空数组）时回到 F01 之前的档位预算表（F01R）。
    // thinkingBudget 是 F01 之前一直在发的参数，构建器照旧带 includeThoughts，不加提示。先于下面的 noKnob 判：
    // 空数组的记录在官方 Gemini 上同样回退。官方 Anthropic 不在此列——它只声明档位的型号对 budget_tokens 直接 400
    if (!control.budget && rt.endpoint.class === 'official' && rt.endpoint.catalogProviderId === 'google' && rt.protocol === 'gemini') {
      return budgetPlan(rt, requested, maxTokens, {}, who, opts);
    }
    const noKnob = !control.toggle && !control.efforts?.length && !control.budget;
    if (noKnob) return { level: 'off', note: `${who} 的目录记录没有列出可调的推理参数，不另发推理参数` };
    if (r.param === 'effort') {
      const effort = control.efforts?.length ? mapEffort(requested, control.efforts) : undefined;
      if (!effort) return { level: 'off', note: `${who} 的推理参数是${controlKinds(control)}，当前接入只发送 reasoning_effort 档位，本轮未开启推理` };
      return effort === requested
        ? { level: requested, effort }
        : { level: requested, effort, note: `推理档位 ${requested} 改为 ${effort}（${who} 只接受 ${control.efforts!.join('/')}）` };
    }
    if (!control.budget) return { level: 'off', note: `${who} 的推理参数是${controlKinds(control)}，当前接入只实现推理预算参数，本轮未开启推理` };
    return budgetPlan(rt, requested, maxTokens, control.budget, who, opts);
  }
  if (r.param === 'budget') return budgetPlan(rt, requested, maxTokens, {}, who, opts);
  return { level: requested };
}

/** 这一轮请求对槽位的要求：currentImages = 最近一条真实用户消息里要发的图片；historyImages = 更早轮次仍在保留窗口内的图片。 */
export interface RequestNeeds { currentImages: number; historyImages: number }

export interface SlotPlan {
  /** 这个槽位接不了这一轮（不发请求）；原因给人看。 */
  blocked?: string;
  maxTokens: number;
  thinking: ThinkingPlan;
  /** false：不带工具定义，历史工具记录改以文字发送。 */
  sendTools: boolean;
  /** true：历史图片改为文字占位（当前轮图片不会走到这里——那种情况 blocked）。 */
  imagePlaceholder: boolean;
  /** 与用户意图不一致的兼容处理，逐条说出来（事件条显示）。 */
  notices: string[];
}

const off = (c: Capability): boolean => c.state === 'unsupported' || c.state === 'unavailable';
/** 目录有否定、但不足以判定当前端点（F01R）：照常发送，同时把这件事说出来，给出手动修正的出路。 */
const doubted = (c: Capability): boolean => c.state === 'unknown' && c.catalog.value === false;

/** maxTokensOverride（F02，可选）：循环按这次请求的预算定下的 max_tokens。给了就用它算推理预算（budget_tokens 必须小于
 *  实际发出的 max_tokens）；不给仍是 rt.requestMaxTokens。SlotPlan.maxTokens 的语义不变：这份计划是按哪个 max_tokens 算的。
 *  opts.spaceLimited（F02，可选）：maxTokensOverride 是被上下文剩余空间收紧的值，推理预算要给可见输出留底（见 ThinkingFit）。 */
export function planSlot(
  rt: RuntimeModel, requested: ThinkingLevel, needs: RequestNeeds, who: string, maxTokensOverride?: number, opts: { spaceLimited?: boolean } = {},
): SlotPlan {
  const notices: string[] = [];
  let blocked: string | undefined;
  if (off(rt.output.text)) blocked = `${who} 不输出文本（${rt.output.text.reason}）`;
  else if (off(rt.input.text)) blocked = `${who} 不接受文本输入（${rt.input.text.reason}）`;
  else if (needs.currentImages > 0 && off(rt.input.image)) {
    blocked = `${who} 不支持图片输入（${rt.input.image.reason}），本轮消息带 ${needs.currentImages} 张图片`;
  }
  const maxTokens = maxTokensOverride ?? rt.requestMaxTokens;
  const thinking = decideThinking(rt, requested, maxTokens, who, {
    tightened: maxTokensOverride !== undefined,
    spaceLimited: maxTokensOverride !== undefined && opts.spaceLimited === true,
  });
  if (thinking.note) notices.push(thinking.note);
  const sendTools = !off(rt.toolCall);
  if (!sendTools) notices.push(`${who} 不支持工具调用（${rt.toolCall.reason}）：本轮不提供工具，历史工具记录改以文字发送`);
  else if (doubted(rt.toolCall)) notices.push(`${who} 的工具调用未确认（${rt.toolCall.reason}）：本轮照常提供工具；端点拒绝时可在「设置 → 模型 → 编辑 → 手动修正」标为不支持，确认可用可标为支持`);
  const imagePlaceholder = needs.historyImages > 0 && off(rt.input.image);
  if (imagePlaceholder) notices.push(`${who} 不支持图片输入：历史中 ${needs.historyImages} 张图片改以文字占位发送`);
  // 提示里不写图片张数：同一句话在一次运行里只说一次（循环按文本去重）
  if (!blocked && needs.currentImages + needs.historyImages > 0 && doubted(rt.input.image)) {
    notices.push(`${who} 的图片输入未确认（${rt.input.image.reason}）：图片照常发送；端点拒绝时可在手动修正里标为不支持，确认可用可标为支持`);
  }
  return { ...(blocked ? { blocked } : {}), maxTokens, thinking, sendTools, imagePlaceholder, notices };
}

/** 统计一份请求消息（已合成 imageData、未追加续写/提醒）里当前轮与历史的图片数。
 *  当前轮 = 最后一条含非 toolResult 内容的 user 消息（pairToolResults 可能把占位结果并进真实用户消息的前面）。 */
export function countImageNeeds(messages: readonly AgentMessage[]): RequestNeeds {
  let current = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.parts.some(p => p.type !== 'toolResult')) { current = i; break; }
  }
  let currentImages = 0; let historyImages = 0;
  messages.forEach((m, i) => {
    const n = m.parts.filter(p => p.type === 'imageData').length;
    if (i === current) currentImages += n; else historyImages += n;
  });
  return { currentImages, historyImages };
}
