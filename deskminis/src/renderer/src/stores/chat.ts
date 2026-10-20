import type {InputMode, InputSend, InputView, InputResult, RunStopSummary} from '@shared/inputs';
import { defineStore } from 'pinia';
import { toRaw } from 'vue';
import { rpc } from '../rpc';
import { mimeFromPath } from '@shared/parts';
import type { ModelCatalogStatus } from '@shared/model-metadata';
import type { CapabilityOverrides, RuntimeModel, ThinkingPreview } from '@shared/runtime-model';
import type { PairStatus, PairingPolicy } from '@shared/pairing';
import type { AttachmentRetryResult, AttachmentStatusResult, AttachmentView } from '@shared/attachments';
import type { ContextInfo, OutputLimitInfo } from '@shared/request-budget';
import type { TokenUsage } from '@shared/usage';
import type { ThinkingLevel } from '@shared/types';
import type { ProcSnapshot } from '@shared/proc';
import type { CheckpointUsage } from '@shared/checkpoint';
import type { DryRunResult } from '../../../minisd/diagnostics';
import type { AuditRow } from '../../../minisd/store/audit';
import type { MessagesHave, MessagesListResult, RetainedSession, SessionLifecycleNotice } from '@shared/types';
import { retryNote } from '../lib/attach/status';
import { capabilityShortByCause, errorShortByCode, fallbackShortByCause } from '../lib/eventnote/copy';
import { readOutputLimit } from '../lib/budget/format';
import { PERM_INVALIDATED_NOTE, permLateNote, permOutcomeNote } from '../lib/perm/copy';
import { isInFlightLoss, isWriteMethod } from '../lib/conn/in-doubt';
import type { AttachResult, OutcomesResult, PendingPermissionView, SnapshotReason, StateSnapshot, WriteRef } from '@shared/event-stream';
import type { RunView } from '@shared/run';
import type { LinkStatus, SyncCause, SyncInfo } from '../rpc';
import type { CompactionView, ContextRecoveryView } from '@shared/compaction';
import { prunedDetail, readCompactionView, readRecoveryView, recoveryLines, recoveryShort } from '../lib/recovery/format';

const THINKING_KEY = 'deskminis.thinkingLevel';
function readThinkingLevel(): ThinkingLevel {
  try {
    const value = localStorage.getItem(THINKING_KEY);
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
  } catch { /* 与外观设置相同：不可读时用默认值。 */ }
  return 'off';
}
/** 本窗口最近一次提交的档位；历史重取不丢，删除会话与重新初始化时释放。 */
const _lastThinking = new Map<string, { text: string; level: ThinkingLevel }>();
let localSeq = 0;
/** chat.contextInfo 的请求序号（模块级非响应式）：只收最新一次请求的应答，见 fetchContextInfo。 */
let contextInfoSeq = 0;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// M3c Task 7：sync.dirty → syncing → 2s 回 idle 的回退定时器（模块级非响应式，单 store 实例）
let _syncDirtyTimer: ReturnType<typeof setTimeout> | undefined;

// ---- F06：快照、续传与重连（模块级非响应式，单 store 实例；init() 开头整组复位） ----
/** send() 的在途表：乐观气泡 id → 这次提交。在表里的会话算「有未落定提交」——快照与续传校正不把它摘出运行集合、
 *  不替它收口、保留它的气泡：attach 可能先于 chat.prompt 到达引擎，应答里没有这次 run 不等于它没被接收。 */
const _sending = new Map<string, { sessionId: string; promptId: string }>();
/** permission.request 处理器本身。快照与续传校正对每张待批卡调同一个函数：字段映射只有处理器正文里那一份。 */
let _permIn: ((p: { requestId: string; req: any; meta: any }) => void) | undefined;
/** 校正时发现当前会话的历史要重取（正跟踪的 run 已结束、才认出它在跑或已不在跑）；afterSync 取走。 */
let _reloadWanted = false;
/** 最近一次同步把快照装进了哪个会话的历史；没装则为空串。 */
let _snapSession = '';
/** 尾巴模式的历史重取：只认最新一次（_histTicket）；发出那一刻缓冲里已落库的长度（_tailCut），应答到了从缓冲里切掉。 */
let _histTicket = 0;
let _tailCut: { text: number; thinking: number } | null = null;
/** Q14：messages 里落库的那一段此刻是哪个会话的历史，而且可以当作引擎那份列表的开头一段来续取（historyQuery）。
 *  '' = 不可以，下一次取完整列表。置上：每次把引擎给的历史装进 messages（open、快照、尾巴重取）。
 *  作废：收到这个会话的同步通知（别的设备的消息并进来了）、连接断过。 */
let _histOf = '';
/** Q14：send() 建过的乐观气泡的 id（「没有送达」的那条重建时沿用原 id）。messages 里 id 不在这里的才是落库的消息。 */
const _bubbleIds = new Set<string>();
/** init() 走完了（广播处理器登记全了）。之前断线按终态处理：重连回来的界面会缺处理器。 */
let _initDone = false;
/** 正在核对的在途写调用（'p:' + promptId / 'm:' + requestId）：两轮同步的收尾交错时，同一条不核对两遍、不留两条说明。 */
const _checking = new Set<string>();
/** 别的会话的交代（在途权限答复的结局、进入终态时「是否送达未知」）：事件条是当前会话的单缓冲、切会话即清，
 *  当场写进去会串到别的会话的对话流里，不写又等于没有交代。先按会话寄存，用户切过去时由 open() 放出来。
 *  requestId：这句话只在那张权限卡仍待批时才成立（「请重新选择」），放出来之前再看一眼。每个会话最多留 5 句。 */
const _parkedNotes = new Map<string, { short: string; requestId?: string }[]>();
/** 连接不可用时写进 lastError 的三句话。它们说的是「此刻」的连接：连上之后要清掉（onLinkStatus 的 open），
 *  不然顶栏的重连行已经消失，会话页的红条还在说正在重连 / 已断开。 */
const LINK_LOST_NOTE = '与后台服务的连接已断开';
const LINK_WAIT_SEND_NOTE = '正在重新连接后台服务，连上后再发送';
const LINK_WAIT_CANCEL_NOTE = '连接恢复后才能停止';
const LINK_NOTES: readonly string[] = [LINK_LOST_NOTE, LINK_WAIT_SEND_NOTE, LINK_WAIT_CANCEL_NOTE];
/** 核对出「没有送达」时事件条里带重试钮的那一句。 */
const UNDELIVERED_NOTE = '连接中断时这条消息没有送达，没有自动重发。点重试重新发送。';
const RUN_ACTIVE = (s: string): boolean => s === 'starting' || s === 'running';
/** 别处正在起跑的 run 最多跟这么久：没收掉的陈旧 starting 行不该让探测一直转。 */
const PENDING_START_MAX_MS = 120_000;
const ACTIVE_SESSION_KEY = 'deskminis.activeSession';
/** 重载后回到原会话：同一窗口的 sessionStorage（随窗口，不跨数据根）。读写都兜住；没有这个全局（测试、旧环境）就跳过。 */
const rememberActive = (id: string): void => {
  try {
    const ss = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!ss) return;
    if (id) ss.setItem(ACTIVE_SESSION_KEY, id); else ss.removeItem(ACTIVE_SESSION_KEY);
  } catch { /* 存不了就不记 */ }
};
const recallActive = (): string => {
  try { return String((globalThis as { sessionStorage?: Storage }).sessionStorage?.getItem(ACTIVE_SESSION_KEY) ?? ''); } catch { return ''; }
};

interface UiMessage { id: string; role: string; parts: any[]; createdAt?: number; tokenUsage?: TokenUsage; originDeviceId?: string; reasoningContent?: string }
/** F06：把「没有送达」的那一条重新画成乐观气泡，沿用原来的 id。气泡只活在 messages 里——切走再切回、open() 重取历史
 *  都会把它换掉，只能按记下的文本与附件重建。形态与 send() 推的那条相同（文本 + 每附件一枚 mediaRef）。 */
function undeliveredBubble(u: { optimisticId: string; text: string; attachments: string[] }): UiMessage {
  const parts: any[] = [];
  if (u.text.trim() !== '') parts.push({ type: 'text', value: u.text });
  for (const rel of u.attachments) {
    parts.push({ type: 'mediaRef', value: { id: crypto.randomUUID().toUpperCase(), relativePath: rel, mimeType: mimeFromPath(rel) ?? 'application/octet-stream', originalFileName: rel.split('/').pop() } });
  }
  return { id: u.optimisticId, role: 'user', parts, createdAt: Date.now() / 1000 };
}
/**
 * Q14：取这个会话历史的那一问怎么问、应答怎么用。手里已经有它的历史时（_histOf）只问引擎要排在最后一条之后的（have），
 * 应答接在后面；引擎判断接不上（同步合并进来了时间更早的消息）或者是旧引擎时，给回来的是完整列表，原样用。
 * 不管走哪条路，merge 的结果都是完整的落库消息列表，调用方照旧整体换掉 messages；乐观气泡留不留仍由各调用方自己定
 *（这里一律不带）。「手里有什么」在调用的这一刻取定：应答回来之前 messages 被别处换掉也不影响这次的结果。
 * 拆成「先算参数、应答到了再合」而不是包成一个 async 函数：调用点的 await 仍然直接等 rpc.call，应答到达后的时序与以前相同。
 */
function historyQuery(id: string, messages: UiMessage[]): { params: { sessionId: string; have?: MessagesHave }; merge(r: MessagesListResult): UiMessage[] } {
  const cur = toRaw(messages);
  const base = _histOf === id && Array.isArray(cur) ? cur.filter(m => !_bubbleIds.has(m.id)) : undefined;
  if (base === undefined) return { params: { sessionId: id }, merge: r => r as unknown as UiMessage[] };
  const have: MessagesHave = base.length > 0 ? { count: base.length, lastId: base[base.length - 1].id } : { count: 0 };
  return {
    params: { sessionId: id, have },
    merge: r => {
      const append = (r as { append?: unknown } | null | undefined)?.append; // 数组（完整列表）上没有这个属性
      return Array.isArray(append) ? [...base, ...(append as UiMessage[])] : r as unknown as UiMessage[];
    },
  };
}
/** 待批的权限卡。sessionId（W2b-2）是卡所属的会话，取自引擎广播的 PermissionRequest.sessionId（必填，设计稿 §3 第 6 条）——
 *  卡按会话分开渲染、超时留条只写给卡所属的会话，都靠它（判据在 lib/perm/scope）。 */
interface PendingPerm { requestId: string; sessionId: string; detail: string; kind: string; toolTitle: string; timeoutMs?: number; riskClass?: string; bridgeTriggers?: string[]; deadlineMs?: number; preview?: { oldText: string; newText: string }; note?: string }
interface UiProvider {
  id: string; name: string; hasApiKey: boolean; modelId?: string; kind?: string; baseUrl?: string;
  /** F01 实例级手动修正（provider.instances.list 原样带回；设置页编辑时回填）。 */
  contextWindow?: number; maxOutputTokens?: number; capabilityOverrides?: CapabilityOverrides; catalogProviderId?: string;
}
type PermTier = 'ask' | 'session' | 'plan' | 'full';
interface UiSkill { id: string; name: string; description: string; isEnabled: boolean; useCount: number }
/** J2 助手（字段对齐后端 AssistantMeta，assistants.list 原样返回）。 */
interface UiAssistant { id: string; name: string; avatar: string; rules: string; modelBinding?: string; skillIds: string[]; prompts: string[]; sortOrder: number }
/** Z3 模型组（字段对齐后端 ModelGroup，modelgroup.list 原样返回）。memberIds 有序：第一个为主，其余按序降级。 */
interface UiModelGroup { id: string; name: string; memberIds: string[]; createdAt?: number }
/** K2 定时任务（字段对齐后端 CronJob，cron.list 原样返回）。 */
interface UiCronJob {
  id: string; name: string; prompt: string;
  scheduleKind: 'interval' | 'once' | 'cron'; scheduleValue: string;
  assistantId?: string; workspaceRoot?: string;
  enabled: boolean; nextRunAt?: number; lastRunAt?: number;
  lastSessionId?: string; lastStatus: string;
}

export const useChat = defineStore('chat', {
  state: () => ({
    // 字段与后端 SessionMeta 对齐：chat.sessions.list 本就返回 memoryEnabled / modelBinding，
    // 此前本地只声明了四项，导致「有数据但界面读不到」——MU6 会话操作正需要这两项显示当前状态。
    sessions: [] as { id: string; title: string; updatedAt?: number; pinnedAt?: number;
                      memoryEnabled?: boolean; modelBinding?: string; assistantId?: string;
                      mcpDisabled?: string[] }[],
    activeId: '' as string,
    thinkingLevel: readThinkingLevel(),
    messages: [] as UiMessage[],
    streamingText: '' as string,
    // 流式思考缓冲（loop 早已广播 thinkingDelta，此前 onEvent 无分支消费，推理 token 白烧）。
    // 生命周期与 streamingText 一致：send/重试/降级/turnEnd/error/换会话时同步清空——
    // 回合落库后历史侧由消息的 reasoningContent 接管渲染，缓冲若残留会与历史块并存重复。
    streamingThinking: '' as string,
    toolCards: [] as { toolUseId: string; name: string; title: string; output?: string; success?: boolean; startedAt?: number; endedAt?: number; input?: string }[],
    pendingPerms: [] as PendingPerm[],
    // MU2b Task 2：进度面板「去处理」点击写入目标权限卡 requestId，ChatView watch 后滚动定位并清空
    permFocusRequestId: null as string | null,
    // MU2b Task 3：产物卡点击写入待预览相对路径，FilesPanel watch 后走既有 preview 流程并清空
    pendingFilePreview: null as string | null,
    /** X 波：输入卡发送期间寄存的草稿。发送被同步拒绝（未配置模型 / 建会话失败）时由输入卡取回——
     *  必须放 store 而不是组件里：首条消息乐观入列的一瞬欢迎页换成会话页，发它的那个输入卡实例已卸载，
     *  拒绝回来时欢迎页新建的实例只能从这里拿。与 pendingFilePreview 同款「一处写、消费即清」。 */
    draft: null as null | { text: string; attachments: { path: string; dataUrl: string }[] },
    /** W2a-6 接力草稿（设计稿 §2「渲染端」、§3 第 5 条）：「新建会话接力」建好新会话后、open() 之前写在这里，
     *  由新会话欢迎页新挂载的输入卡在 setup 时取走，且只取 sessionId === activeId 的——
     *  open() 的 await 期间旧会话页的输入卡还挂着，它的 setup 早已跑完，拿不到；换成 watch 消费的话它会先抢走，
     *  随后欢迎页替换会话页、它被卸载，草稿就丢了。
     *  不复用上面的 draft：draft 的取回闸要求 lastError 非空，而 open() 换会话会清 lastError，接力草稿永远取不出；
     *  放宽那道闸又会让「发送中寄存」的草稿被新实例抢走（X 波堵上的口子）。 */
    relayDraft: null as null | { sessionId: string; text: string },
    /** W2a-6：引擎随 contextFull 给出的接力草稿（库里完整的最新摘要 + 最后一条真用户消息），等用户点「新建会话接力」。
     *  不直接放进 relayDraft：那时它只能指向出事的旧会话，用户切走再切回、旧会话页的输入卡重新挂载时，
     *  会把接力文本填进旧会话的输入框。
     *  createdId / note：接力会话已建出、但没能切过去时记下它和没跟过来的继承项——再点只切过去，不再新建。 */
    relaySource: null as null | { sessionId: string; text: string; createdId?: string; note?: string },
    providers: [] as UiProvider[],
    /** Z3 模型组（设置页编辑；会话菜单 / 助手编辑器的绑定下拉与输入卡模型胶囊都要读）。 */
    modelGroups: [] as UiModelGroup[],
    /** J2 助手目录（欢迎页卡区 + 设置管理页共用；变更经 assistants.changed 广播回流刷新）。 */
    assistants: [] as UiAssistant[],
    /** I6 欢迎屏选择态（AionUi Guid 页语义）：选中的助手 id，点卡只改它、**不建会话**。
     *  W2b-4 起它是「当前空会话的助手选择」：open() 换会话时从会话已绑的助手初始化（不再清成 ''），
     *  所以 newSessionWithAssistant、「用它开始」建出的空会话回到欢迎页时卡片高亮与副标题如实；
     *  没有会话时发送按它建会话，有空会话时发送前按它套用 / 解绑（Composer send → applyAssistantToSession）。 */
    welcomeAssistantId: '' as string,
    /** K2 定时任务列表（工作台「定时」面板数据源；变更经 cron.changed 广播回流）。 */
    cronJobs: [] as UiCronJob[],
    /** 网络搜索 provider 状态（设置页用）：后端 get 只回 {kind, hasKey, baseUrl?}，密钥永不回显。 */
    searchProvider: null as null | { kind: string; hasKey: boolean; baseUrl?: string },
    skills: [] as UiSkill[],
    /** MU6 技能管理页数据源。**与上面的 skills 不是一回事**：那份是斜杠菜单用的，
     *  带 sessionId 时只返回该会话生效的启用集、不带时还过滤掉了禁用项——
     *  管理页必须看得见禁用的技能，否则关掉一个就再也找不回来了。 */
    allSkills: [] as UiSkill[],
    /** 最近一次导入任务的进度（字段对齐 importer.ts 的 ImportProgress，不自造）。 */
    skillImport: null as null | {
      taskId: string; state: 'running' | 'done' | 'failed';
      total: number; completed: number; succeeded: string[];
      failures: { name: string; error: string }[]; error?: string;
    },
    /** D6 MCP 设置页数据源：servers 条目 + 运行态 statuses + configError 布尔。
     *  configError 只拿到布尔是有意的——loadError 原文可能带文件片段（内含明文 headers），
     *  不出 minisd；前端据布尔显示固定警示文案，绝不回显原文。 */
    mcpServers: { servers: [], statuses: [], configError: false } as {
      servers: {
        name: string; transport: 'stdio' | 'streamable-http'; enabled: boolean;
        command?: string; args?: string[]; env?: Record<string, string>;
        url?: string; headers?: Record<string, string>; note?: string; startupTimeoutSeconds?: number;
      }[];
      statuses: { name: string; status: 'connected' | 'error' | 'idle'; lastError?: string; toolCount: number; truncated?: number; limitSkipped?: string[]; collisionSkipped?: string[] }[];
      configError: boolean;
      /** W1a-4：只在 configError 时有值——read 是读不到（权限 / 占用），parse / shape 是格式坏了；横幅据此选文案 */
      configErrorKind?: 'read' | 'parse' | 'shape';
    },
    /** H2 文本选区注释：当前会话的注释集（高亮重锚定的数据源）。
     *  变更一律经 chat.annotations.changed 广播回流刷新——add/update/remove 不就地改本地态，
     *  单一代码路径，多窗口天然一致。 */
    annotations: [] as { id: string; messageId: string; exact: string; prefix: string; suffix: string; note: string; color: string }[],
    // 循环报错（API Key 错误、provider 故障…）必须看得见，否则界面就是「按了没反应」
    lastError: '' as string,
    // 透明重试期间的提示；下一个 textDelta / turnEnd 清掉
    retryNote: '' as string,
    // 当前回合是否在跑：控制发送键 ↔ 停止键、以及底部实时助手块的显隐
    running: false as boolean,
    /** W2b-1：哪些会话的回合正在跑——按会话记账，非当前会话的事件同样维护（trackRun）。
     *  旧实现只认当前会话的事件、换会话一律 running=false：A 跑着切到 B 再切回 A，停止键没了、发送键亮着，
     *  按下去撞后端「该会话正在运行中」。用数组不用 Set：与其余状态同款，可响应、可序列化。 */
    runningSessions: [] as string[],
    /** W2b-1：当前会话的回合是从中途接上的（切回仍在跑的会话，或重载后才收到它的事件）。
     *  这时流式缓冲里只有接上之后的半截，StageChat 显示占位，不从句子中间开始长；
     *  回合结束（turnEnd / error）清掉，由 open() 重取完整历史。 */
    midRun: false as boolean,
    /** W2b-3：与 minisd 的连接。'lost' = ws 断了（引擎崩溃、被杀、端口被关）——顶栏下方出横幅、发送键置灰。
     *  F06：'reconnecting' = 断了、正在自动重连。引擎里的任务还在跑，所以运行条、权限卡、已流出的正文都留着，
     *  只是发送 / 批准 / 停止 / 换会话不执行；连上并同步完成后回到 'ok'。重连用尽或引擎已退出才是 'lost'
     *  （连旧引擎、桩时没有重连，仍然只会从 ok 变成 lost）。 */
    connection: 'ok' as 'ok' | 'reconnecting' | 'lost',
    /** F06：重连进度（第几次 / 共几次 / 这次之前等多久），只在 reconnecting 时有值。 */
    link: null as null | { attempt: number; maxAttempts: number; retryInMs?: number },
    /** F06：终态 lost 能不能手动重连（开过恢复且引擎没有退出）。 */
    linkRetryable: false,
    /** F06：每完成一次重连同步加一（终端面板据此重新挂接：终端输出不入序、不续传）。 */
    linkGeneration: 0,
    /** F06：每做一次整体刷新（refreshAll：重连之后、补洞走了快照之后、水位之前有帧没到齐时）加一。
     *  不往 store 里放状态、自己取数的组件（F08「改动」页的清单与审阅面板）据此重取：它们平时靠 checkpoints.changed
     *  这条「请重取」的提示，而丢在断线里的提示在走快照时不会补发。 */
    refreshTick: 0,
    /** F06：装过一次快照 = 引擎支持续传（旧引擎、测试桩恒为 false，下面这组状态都不参与）。 */
    syncOn: false,
    engineEpoch: 0,
    /** F06：最近一次看到的持久状态修订号；续传后它变了就重拉没有广播的列表。 */
    streamRevision: 0,
    inputsOn: false,
    inputsBySession: {} as Record<string, InputView[]>,
    inDoubtInputs: [] as InputSend[],
    inputRetryBySession: {} as Record<string, InputSend>,
    failedInputDrafts: {} as Record<string, InputSend[]>,
    stopSummaries: {} as Record<string, RunStopSummary>,
    /** F06：本窗口跟踪的每个会话最近一次 run。晚到事件按 generation / ended 过滤；收口只认 ended:false 的那一次。 */
    runOf: {} as Record<string, { runId: string; generation: number; ended: boolean }>,
    /** F06：别处正在起跑（starting，连 MCP 那一段不发事件）、本窗口还没点亮的 run，键是会话 id。
     *  起跑前失败没有事件，不能凭快照点亮；非空时用短周期探测跟到它变成 running。 */
    pendingStarts: {} as Record<string, { runId: string; since: number }>,
    /** F06：本窗口见过又消失的会话 id（最多 200）。它们晚到的 run 事件不再把运行条点回来。 */
    goneSessions: [] as string[],
    /** F06：当前会话的 run 是经快照接上的——历史里已有它已落库的消息，实时区只放还没落库的尾巴
     *  （每落一条消息重取一次历史并从缓冲里切掉已落库的部分）。为假时逐字是以前的行为。 */
    joinedTail: false,
    /** F06：断线时已发出、不知道引擎收没收到的提交。没有重发；重连后用 state.outcomes 核对，有了结论才摘。 */
    inDoubtPrompts: [] as { sessionId: string; promptId: string; text: string; attachments: string[]; optimisticId: string; thinkingLevel?: ThinkingLevel }[],
    inDoubtPerms: [] as { requestId: string; sessionId: string }[],
    /** F06：核对出「没有送达」的那一条。事件条的「重试」沿用它的 promptId 重新提交（引擎按 promptId 去重）。
     *  error：起跑前失败的原因（有才带）。气泡与重试入口由 showUndelivered() 在它所属的会话里补上。 */
    undelivered: null as null | { sessionId: string; promptId: string; text: string; attachments: string[]; optimisticId: string; error?: string; thinkingLevel?: ThinkingLevel },
    // 后端没有暴露「读取默认 provider」的 RPC；渲染端本地镜像当前选择（模型胶囊显示 + 打勾）。
    // 初值置为首个 provider —— 后端 create() 也把首个建的 provider 设为默认。
    defaultProviderId: '' as string,
    // 权限档位：现已持久化在后端 settings 表（permission.preset）并真实作用于权限网关；
    // 这里只是本地镜像，供权限卡预选高亮。初值 'ask'，init() 从后端读回覆盖。
    permTier: 'ask' as PermTier,
    // M2d · Task 5：上回合停止原因（turnEnd.stopReason）
    lastStopReason: '' as string,
    // M2d · #10 事件 UI 接线：四种目前未消费事件（fallback/compacted/offloaded/retry）的状态。
    //   retry 已有 retryNote 字段沿用；其余三种新增会话级环内联提示 + 任务面板状态字典。
    eventNotes: [] as { kind: 'fallback'|'compacted'|'offloaded'|'retry'|'error'|'synced'|'pruned'|'compactFailed'|'capability'|'contextRecovery'; ts: number; key?: string; detail?: string; retryable?: boolean; relay?: boolean; short?: string; retry?: { attempt: number; delayMs: number } }[], // 对话流内联气泡（最多保留 10 条）；MU2a Task 8 扩 retry/error 两类（error 带 retryable 供重试钮）；M3c Task 7 扩 synced（同步完成）；A6 扩 pruned（修剪）；W2a-1 扩 compactFailed（压缩失败，追加在末尾：既有守卫按前缀子串匹配）；W2a-6 加 relay（给「新建会话接力」钮）与 short（按 code / cause 定好的短句，EventNotes 优先用它）；F01 扩 capability（模型能力不符时的兼容处理：跳过槽位、历史图片/工具改文字、推理档位调整）；F03 扩 contextRecovery（同模型超窗恢复的说明）与 key（同一次事故的那一条就地替换，不重复追加）
    fallbackState: null as null | { from: string; to: string; reason: string }, // 任务面板「降级」卡（对齐 loop.ts: fallback(from,to,reason)）
    compactedState: null as null | { markerId: string; summary: string }, // 任务面板「压缩」卡（对齐 loop.ts: compacted(markerId,summary)；无 fromCount/toCount/freedTokens）
    offloadedState: null as null | { count: number; lastRelativePath?: string }, // 任务面板「卸载」卡（对齐 loop.ts: offloaded(toolUseId,relativePath)；逐条自增计数，附最近一条路径）
    // F03：最近一次同模型超窗恢复的状态（任务面板「上下文恢复」卡；同一事故后到的整体替换先到的）与最新压缩记录的摘录
    //（「上下文已压缩」卡的覆盖与保留项两行）。都来自引擎的事件或 chat.contextInfo，界面不另算
    contextRecoveryState: null as null | ContextRecoveryView,
    compactionDetail: null as null | CompactionView,
    // M2d · #7：chat.contextInfo 轮询缓存（任务面板水位条显示窗口 + 当次用量）
    // F02：前三项是一直就有的（窗口、已用、剩余）；另多了这次 / 下一次请求的预算（budget）与是否运行中（live）。
    // 旧版本引擎只返回前三项，照旧可用
    contextInfo: null as null | ({ windowTokens: number; usedTokens: number; remaining: number } & Pick<ContextInfo, 'budget' | 'live'>),
    // F02：上一回合以 max_tokens 截断收尾时的说明材料（那次的 max_tokens、原因、续写次数）；其它收尾为 null
    lastOutputLimit: null as null | OutputLimitInfo,
    // MU2b Task 7：配对管理面（DevicesModal）——已配对设备脱敏列表（remote.status；
    // 指纹/名称/roomId/配对时间，无密钥材料）。M3c Task 5 增 online/lastSeenAt（命门 2 出站∪入站合并）。
    devices: [] as { peerFingerprint: string; peerName: string; roomId: string; createdAt: number; online: boolean; lastSeenAt: number }[],
    // 发起配对中的会话（remote.pair.begin 返回）；null = 未在发起。expiresIn 秒、startedAt ms。
    pairingSession: null as null | { code: string; myFingerprint: string; expiresIn: number; startedAt: number },
    // F11C 认证配对：每台设备的配对方式与能否升级（remote.status 每行的新字段）、本机策略与发起侧状态
    //（remote.status 顶层的 pairing；旧引擎没有这个字段，为 null 时设备页不显示开关）、当前这次发起用的协议与次数上限。
    deviceMeta: {} as Record<string, { pairingProtocol: 1 | 2; canUpgradePairing: boolean }>,
    pairStatus: null as null | PairStatus,
    pairingMeta: null as null | { protocol: 1 | 2; attempts?: number },
    // F11A 附件同步：当前会话各附件的状态（attachments.status），键是 mediaRef.relativePath。
    // 旧引擎没有这个方法时是空对象，chip 回到没有状态的样子。
    attachmentViews: {} as Record<string, AttachmentView>,
    // F11B 删除同步：已在其他设备删除、本机因为有对方没见过的内容而留下的会话（chat.sessions.listRetained）。
    // 设备页列出它们，可恢复或彻底删除。旧引擎没有这个方法时是空数组。
    retainedSessions: [] as RetainedSession[],
    // F11B：最近一次 remote.status 的应答是不是设备表。删除确认据此分清「确认过没有已配对设备」与「还不知道」——
    // devices 的初值就是空数组，不能把它当成「没有已配对设备」。
    devicesLoaded: false,
    // M3c Task 7：全局同步状态点三态（TitleBar）——offline 无设备/idle 空闲/syncing 同步中。
    // sync.dirty notify → syncing → 2s 后回 idle（一期简化，无 sync.settled 事件）。
    syncState: 'offline' as 'offline' | 'idle' | 'syncing',
    /** MU6：M6 的同步暂停开关。**暂停的是设备间同步，不是正在跑的 agent 回合**——
     *  后者是 chat.cancel（早已接线）。这两件事混淆的代价很实在：用户以为点了能停下任务。 */
    syncPaused: false,
    /** 当前会话的实际工作目录（后端算好的：设过就是设的，否则是沙箱桶）。 */
    workspaceRoot: '',
    /** true = 还没设过，用的是会话沙箱桶。用来决定界面上要不要显示「恢复默认」。 */
    workspaceIsDefault: true,
  }),
  actions: {
    setThinkingLevel(level: ThinkingLevel) {
      this.thinkingLevel = level;
      try { localStorage.setItem(THINKING_KEY, level); } catch { /* 不可写时本窗口照常使用。 */ }
    },
    async init() {
      // W2b-3：断线订阅挂在 connect 之前——首次就连不上时（浏览器先 error 后 close），断线通知在 connect 的 await 期间就到，
      // 晚挂一步就接不到，首启失败时横幅就不出现
      rpc.onLost(() => this.markConnectionLost());
      // F06：这组模块级状态以 init() 为起点
      _lastThinking.clear();
      _sending.clear(); _checking.clear(); _reloadWanted = false; _snapSession = ''; _tailCut = null; _initDone = false; _histOf = '';
      _parkedNotes.clear();
      // F06：开启重连与续传。特性探测：旧测试的 rpc 桩没有这些方法，整段跳过，行为与以前相同
      if (typeof (rpc as any).enableRecovery === 'function') {
        rpc.enableRecovery({
          attachParams: () => (this.activeId ? { sessionId: this.activeId } : {}),
          applySnapshot: (snap, info) => this.applySnapshot(snap, info),
          resumed: r => this.reconcileResume(r),
          synced: info => { void this.afterSync(info); },
          status: s => this.onLinkStatus(s),
          // 别处正在起跑的 run 不发事件：短周期探测到它变成 running；有活动 run 或待批卡时防尾帧丢失、半开连接
          wantProbe: () => Object.values(this.pendingStarts).some(s => Date.now() - s.since <= PENDING_START_MAX_MS) ? 'poll'
            : (this.runningSessions.length > 0 || this.pendingPerms.length > 0) ? 'idle' : false,
          canRecover: () => _initDone,
        });
      }
      await rpc.connect();
      // M3c Task 7：chat.event 兼容两种 payload——
      //   ① 既有 LoopEvent：{ sessionId, event: { kind, ... } } → onEvent(event)
      //   ② M3c synced：{ kind:'synced', sessionId, mergedCount, fromDevice } → 推入 eventNotes
      rpc.on('chat.event', (payload: any) => {
        const { sessionId, event } = payload;
        if (payload.kind === 'synced') {
          // 同步也会改会话属性（含置顶与取消），无论当前打开哪条都要刷新左栏。
          void this.refreshSessions();
          // Q14：别的设备的消息并进来了（可能排在已有消息之前）——手里这份历史不再续取，下一次取完整列表
          if (sessionId === _histOf) _histOf = '';
          if (sessionId === this.activeId) {
            this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'synced' as const, ts: Date.now(), detail: `已同步 ${Number(payload.mergedCount ?? 0)} 条来自 ${String(payload.fromDevice ?? '').slice(0, 6)}` }];
            void this.refreshAttachments(); // F11A：同步来的消息可能带附件引用
          }
          return;
        }
        // F06：晚到的事件不复活旧状态——已结束的那次 run、更早的 run、别的代次、已消失的会话，整条丢弃
        if (!this.acceptRunEvent(sessionId, event, payload.run)) return;
        // W2b-1：先按会话记账、再按 activeId 过滤——非当前会话的事件以前在这里整条丢掉，渲染端就不知道谁在跑
        this.trackRun(sessionId, event);
        if (sessionId === this.activeId) this.onEvent(event);
      });
      rpc.on('chat.inputs.changed', (p: {sessionId: string; inputs: InputView[]}) => {
        if (!this.goneSessions.includes(p.sessionId)) this.adoptInputs(p.inputs, p.sessionId);
      });
      rpc.on('chat.inputs.stopped', (p: RunStopSummary) => {
        if (!this.goneSessions.includes(p.sessionId)) this.stopSummaries = {...this.stopSummaries, [p.sessionId]: p};
      });
      // H2：注释变更广播（本窗口的写操作也走这条回流——见 annotations 状态注释）
      rpc.on('chat.annotations.changed', (p: { sessionId?: string }) => {
        if (p?.sessionId === this.activeId) void this.refreshAnnotations();
      });
      // F11A：附件状态变了（传输进度、到达、失败、暂停）
      rpc.on('attachments.changed', (p: { sessionId?: string }) => {
        if (p?.sessionId === this.activeId) void this.refreshAttachments();
      });
      // M3c Task 7：sync.dirty notify → syncState='syncing' → 2s 后回 'idle'
      rpc.on('sync.dirty', () => {
        this.syncState = 'syncing';
        if (_syncDirtyTimer) clearTimeout(_syncDirtyTimer);
        _syncDirtyTimer = setTimeout(() => { this.syncState = 'idle'; _syncDirtyTimer = undefined; }, 2000);
      });
      // MU2a Task 10：params.meta 并入条目（超时秒数/风险分级/桥触发列表）；deadlineMs 在 push 时一次算定
      // F06：处理器另存进 _permIn——快照与续传校正里的待批卡走同一个函数，字段映射只有下面这一份
      //（抄第二份迟早漏字段：note、preview 都是后来加的）。同一个 requestId 再来一次（回放、快照）原位替换，不出第二张
      rpc.on('permission.request', _permIn = ({ requestId, req, meta }: any): void => {
        const card = {
          // W2b-2：记下卡属于哪个会话。以前不记，界面只能把所有会话的卡都渲染进当前对话流——
          // B 的回合卡在权限上，卡却出现在 A 里，在 A 里点「允许」放行的其实是 B 的操作
          requestId, sessionId: req.sessionId, detail: req.detail, kind: req.kind, toolTitle: req.toolTitle,
          timeoutMs: meta?.timeoutMs, riskClass: meta?.riskClass, bridgeTriggers: meta?.bridgeTriggers,
          // 审批前变更预览（file_write/file_edit 才有）：权限卡据此渲染差分，写文件不再盲批
          preview: req.preview,
          // W1b-2：数据根内走卡的文件操作带一句说明（改应用配置 / 其它会话 / 读会话数据库…）。
          // 这里逐字段拷贝，不写这一行 note 就在渲染端丢了
          note: req.note,
          deadlineMs: typeof meta?.timeoutMs === 'number' ? Date.now() + meta.timeoutMs : undefined,
        };
        const i = this.pendingPerms.findIndex(x => x.requestId === requestId);
        if (i >= 0) this.pendingPerms.splice(i, 1, card); else this.pendingPerms.push(card);
      });
      // 询问超时（90s）或别的窗口已答复时 minisd 广播 resolved：不摘掉卡片就会永远挂在界面上。
      // 决策 4b' 按 reason 分流：timeout → 摘卡，卡属于当前会话时再补「已超时拒绝」事件条（设计 §5.2-1；W2b-2 起按会话判）；
      // answered/无 reason → 只摘卡。
      // renderer 不做 deadline 自判（恒晚于 minisd 一个广播延迟，自判永不触发——评审命门 1）。
      rpc.on('permission.resolved', ({ requestId, reason }: any) => {
        // W2b-2：摘卡之前先认出它属于哪个会话——超时留条只写给卡所属的会话。eventNotes 是当前会话的单会话缓冲，
        // 别的会话的卡超时了写进来，就串进了当前会话的对话流；手里没有这张卡（渲染端重载后才收到）就不猜、不写。
        // 卡属于别的会话时这条留条没有去处（切过去时 open() 会清 eventNotes），留给 W6c 的交互登记
        const hit = this.pendingPerms.find(x => x.requestId === requestId);
        this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId);
        if (reason === 'timeout' && hit?.sessionId === this.activeId) {
          this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail: '权限请求已超时，自动拒绝', retryable: false }];
        } else if (reason === 'invalidated' && hit?.sessionId === this.activeId) {
          // F13：相关 MCP 服务被停用 / 改配置 / 移除，卡被引擎作废——卡片当场消失，不留一句的话用户不知道它去哪了。
          // 只读 reason，不读 outcome：旧引擎没有这个取值也没有 outcome，走不到这里。其余 reason（取消 / 删除 / 关停 / 已答复）只摘卡
          this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail: PERM_INVALIDATED_NOTE, retryable: false }];
        }
      });
      // J2：助手目录变更广播（本窗口的写操作也走这条回流——单一代码路径，多窗口一致）
      rpc.on('assistants.changed', () => { void this.refreshAssistants(); });
      // K2：调度器触发/终态/CRUD 全走 cron.changed 回流——面板「下次运行/上次状态」保持活值
      rpc.on('cron.changed', () => { void this.refreshCronJobs(); });
      // F06：首次同步——取一份快照（运行中的会话、待批的权限卡、会话列表），此后入序事件按序放行。
      // 重载后的窗口靠它恢复运行条与卡片。取不到（旧引擎、首次同步失败）就按以前的方式继续
      if (typeof (rpc as any).resync === 'function') { try { await rpc.resync('initial'); } catch { /* 见上 */ } }
      await this.refreshSessions();
      await this.refreshProviders();
      // Z3：模型组是可选能力。拉不到不该让整个启动失败（后面还有会话、助手、权限档要读）；
      // 设置页进页会再拉一次，那里的失败会显示出来——这里不是吞错，是把报错留给有地方显示的入口。
      try { await this.refreshModelGroups(); } catch { /* 见上 */ }
      await this.refreshAssistants();
      await this.refreshAllSkills();
      // 暂停是持久化设置（settings 表），重启后仍生效——启动就得读回来，否则界面会谎报「同步中」
      await this.refreshSyncPaused();
      // 权限档位同样持久化在后端；启动读回，否则重启后界面高亮回落到默认而网关仍保留旧档，
      // 两者不一致会让用户误以为「完全访问」没生效（或反过来高亮骗人说关了却没关）。
      const preset = await rpc.call('permission.getPreset');
      if (preset && (preset.preset === 'ask' || preset.preset === 'session' || preset.preset === 'plan' || preset.preset === 'full')) this.permTier = preset.preset;
      // 技能菜单数据源：开关/删除广播 changed；导入是后台任务不广播 changed，
      // 靠 progress 终态刷新（否则导入完成菜单里看不到）
      rpc.on('skills.changed', () => { void this.refreshSkills(); });
      // 会话标题会被后端自己改（首回合结束的自动命名），不是每次都由本窗口发起——
      // 不订阅这条广播的话，取好的名字要等到下次手动刷新列表才看得见。
      rpc.on('chat.sessions.changed', () => { void this.refreshSessions(); });
      // F11B：会话被删除（本机或已配对设备上）、被恢复、保留副本被清掉——重拉列表与保留副本；正开着的会话没了就切走
      rpc.on('chat.sessions.lifecycle', (p: any) => { void this.onSessionLifecycle(p); });
      rpc.on('skills.import.progress', (t: any) => {
        if (t && typeof t.taskId === 'string') this.skillImport = t;
        if (t && t.state !== 'running') { void this.refreshSkills(); void this.refreshAllSkills(); }
      });
      await this.refreshSkills();
      // #7：水位动态刷新——每次 turnEnd/重试/压缩/卸载 之后拉一次 chat.contextInfo 存 state.contextInfo（供 TasksPanel 用，不直接写死 200K）
      void this.fetchContextInfo();
      // F11B：有没有保留副本（左栏「设备」项的角标要用）
      void this.refreshRetained();
      // F06：处理器登记全了，此后断线可以靠重连恢复（rpc 的 canRecover）
      _initDone = true;
      // F06：重载后回到原会话（同一窗口的 sessionStorage）——进行中的回合、待批的卡都在那个会话里，
      // 停在欢迎页的话它们只剩侧栏上的一个标记。只在引擎支持续传时做；会话已不在列表里就留在欢迎页
      if (this.syncOn && !this.activeId) {
        const last = recallActive();
        if (last && this.sessions.some(s => s.id === last)) { try { await this.open(last); } catch { /* 留在欢迎页 */ } }
      }
    },
    async refreshSessions() {
      const before = this.sessions;
      this.sessions = await rpc.call('chat.sessions.list');
      this.noteSessionsChanged(before);
    },
    /** F06：会话列表换了之后——从列表里消失的会话记进 goneSessions（它晚到的 run 事件不再点亮运行条），
     *  并把它从运行集合与待批卡里去掉；重新出现的（对端同步把同一个 id 带回来）从 goneSessions 里拿掉。 */
    noteSessionsChanged(before: { id: string }[]) {
      const now = new Set((Array.isArray(this.sessions) ? this.sessions : []).map(s => s.id));
      const gone = (Array.isArray(before) ? before : []).map(s => s.id).filter(id => !now.has(id));
      if (this.goneSessions.some(id => now.has(id))) this.goneSessions = this.goneSessions.filter(id => !now.has(id));
      if (gone.length) this.markGone(gone);
    },
    markGone(ids: string[]) {
      for (const id of ids) _lastThinking.delete(id);
      this.goneSessions = [...this.goneSessions.filter(id => !ids.includes(id)), ...ids].slice(-200);
      if (this.runningSessions.some(id => ids.includes(id))) this.runningSessions = this.runningSessions.filter(id => !ids.includes(id));
      if (this.pendingPerms.some(p => ids.includes(p.sessionId))) this.pendingPerms = this.pendingPerms.filter(p => !ids.includes(p.sessionId));
      for (const id of ids) if (this.pendingStarts[id]) delete this.pendingStarts[id];
      // 会话消失，它的 generation 序列随之作废：引擎删会话时连 run 行一起删，同一个 id 被对端同步带回来之后 generation 从 1 重来。
      // 旧条目留着的话，带回来之后新 run 的事件会被当成「更早的 run / 已结束的那一次」整条丢掉——本窗口发起的回合没有正文、
      // 收不了尾，别处起的回合点不亮。消失期间晚到的旧事件由 goneSessions 挡着，用不着它
      for (const id of ids) { if (this.runOf[id]) delete this.runOf[id]; _parkedNotes.delete(id); }
      // 这个会话名下还没落定的东西一并放下：核对出「没有送达」的那一条、断线时在途等核对的发送与权限答复。会话没了，
      // 它们的结局没有地方交代，重试也只会被引擎以「会话已删除」拒绝。放在这里而不是各条删除路径里：F11B 之后会话有
      // 四条消失的路（本窗口删除、生命周期广播、会话列表广播、快照），都经过这个函数，谁先到都一样。
      // 只靠 send() 的 catch 里那句「会话已删的不放回」不够：删除运行中的会话时引擎先停 run，chat.prompt 的「已取消」
      // 应答先于删除的应答（或别的窗口删除时的广播）到达，那一刻会话还不在 goneSessions 里，那一条被放了回去，
      // 之后再没有人清它。待核对的条目留着的话，校正会因为「有未落定提交」把这个会话并回运行集合
      if (this.undelivered !== null && ids.includes(this.undelivered.sessionId)) this.undelivered = null;
      this.inDoubtInputs = this.inDoubtInputs.filter(p => !ids.includes(p.sessionId));
      for (const id of ids) {delete this.inputsBySession[id];delete this.failedInputDrafts[id];delete this.stopSummaries[id];delete this.inputRetryBySession[id];}
      if (this.inDoubtPrompts.some(p => ids.includes(p.sessionId))) this.inDoubtPrompts = this.inDoubtPrompts.filter(p => !ids.includes(p.sessionId));
      if (this.inDoubtPerms.some(p => ids.includes(p.sessionId))) this.inDoubtPerms = this.inDoubtPerms.filter(p => !ids.includes(p.sessionId));
    },
    async refreshProviders() {
      this.providers = await rpc.call('provider.instances.list');
      // T5b：默认 provider 必须**从后端读回**。以前这里是「猜列表第一个」，
      // 设置页把这个猜测显示成「当前默认」高亮——用户看到 A、后端实际用 B。
      // getDefault 不可用（旧后端）时静默走下面的回落，刷新本身不能因此失败。
      try {
        const r = await rpc.call<{ id?: string }>('provider.getDefault');
        if (r && typeof r.id === 'string' && r.id !== '') this.defaultProviderId = r.id;
      } catch { /* 旧后端没有这个 RPC：走回落 */ }
      // 后端未设/已失效时回落到列表首个（与后端 create() 的默认策略一致）
      if (!this.providers.some(p => p.id === this.defaultProviderId)) this.defaultProviderId = this.providers[0]?.id ?? '';
    },
    async refreshSkills() {
      // 斜杠菜单只列生效启用集：有活动会话走会话覆盖，否则退回全局启用项
      this.skills = this.activeId
        ? await rpc.call('skills.list', { sessionId: this.activeId })
        : (await rpc.call('skills.list', {})).filter((s: UiSkill) => s.isEnabled);
    },
    // ---- J2 助手体系（设计稿 §5）----
    async refreshAssistants() {
      this.assistants = await rpc.call('assistants.list');
      // W2b-4：选中的助手被删了（助手页或别的窗口删的）——选择回落到会话自己绑的助手（没有会话就是「没选」）。
      // 不回落的话卡片不亮、胶囊说默认，发送却仍去套用那个不存在的助手，每发一次「套用助手失败」一次（xvfb 场景 G 实测）。
      // 会话绑的助手本身已删、选择只是它的镜像时回落结果还是它：两边相等，不触发套用
      const sel = this.welcomeAssistantId;
      if (sel && !this.assistants.some(a => a.id === sel)) {
        this.welcomeAssistantId = this.sessions.find(s => s.id === this.activeId)?.assistantId ?? '';
      }
    },
    /** 点助手卡 → 新建绑定会话并切入（预设三件由后端 create 一并应用）。 */
    async newSessionWithAssistant(assistantId: string) {
      const s = await rpc.call('chat.sessions.create', { assistantId });
      await this.refreshSessions();
      await this.open(s.id);
    },
    /** W2b-4：给空会话套用助手（assistantId 传 '' 即解绑）。后端把助手 id、模型绑定、技能覆盖一起重置，
     *  有消息或运行中的会话会被拒——错误原样抛给调用方（输入卡据此说「套用助手失败」、文字留在框里）。
     *  重拉会话列表：胶囊、NavRail 的助手 emoji、标题都读它；技能覆盖变了，斜杠菜单的生效集也得重取。 */
    async applyAssistantToSession(id: string, assistantId: string) {
      await rpc.call('chat.sessions.applyAssistant', { sessionId: id, assistantId });
      await this.refreshSessions();
      void this.refreshSkills();
    },
    /** W2b-4：隐式建会话（贴图、选工作区都要先有会话）按欢迎页的选择建。以前这两处直接 newSession()：
     *  建出无助手的会话，open() 再把选择清掉，「已选 X」就这样静默作废。已有会话时什么也不做——
     *  空会话上的选择留到发送前由输入卡套用。 */
    async ensureSession() {
      if (this.activeId) return;
      if (this.welcomeAssistantId) await this.newSessionWithAssistant(this.welcomeAssistantId);
      else await this.newSession();
    },
    async createAssistant(input: { name: string; avatar?: string; rules?: string; modelBinding?: string; skillIds?: string[]; prompts?: string[] }) {
      const a = await rpc.call('assistants.create', input);
      await this.refreshAssistants();
      return a;
    },
    async updateAssistant(id: string, patch: { name?: string; avatar?: string; rules?: string; modelBinding?: string; skillIds?: string[]; prompts?: string[] }) {
      const a = await rpc.call('assistants.update', { id, ...patch });
      await this.refreshAssistants();
      return a;
    },
    /** 后端强制 confirm:true——漏了会抛错，界面表现为「点了删除没反应」（deleteSession 同款）。 */
    async deleteAssistant(id: string) {
      await rpc.call('assistants.delete', { id, confirm: true });
      await this.refreshAssistants();
    },
    // ---- K2 定时任务（设计稿 §5）----
    async refreshCronJobs() { this.cronJobs = await rpc.call('cron.list'); },
    async createCronJob(input: { name: string; prompt: string; scheduleKind: string; scheduleValue: string; assistantId?: string; workspaceRoot?: string }) {
      const j = await rpc.call('cron.create', input);
      await this.refreshCronJobs();
      return j;
    },
    async updateCronJob(id: string, patch: Record<string, unknown>) {
      const j = await rpc.call('cron.update', { id, ...patch });
      await this.refreshCronJobs();
      return j;
    },
    /** 后端强制 confirm:true（deleteSession 同款）。 */
    async deleteCronJob(id: string) {
      await rpc.call('cron.delete', { id, confirm: true });
      await this.refreshCronJobs();
    },
    async runCronNow(id: string) {
      await rpc.call('cron.runNow', { id });
      await this.refreshCronJobs();
      await this.refreshSessions(); // 立即运行会新建会话，列表立刻可见
    },
    // ---- MU6 会话操作（消费既有 RPC，不新增方法）----
    /** 删除会话。后端强制 confirm:true——漏了它会抛错，界面表现为「点了删除没反应」。 */
    async deleteSession(id: string) {
      await rpc.call('chat.sessions.delete', { sessionId: id, confirm: true });
      this.markGone([id]); // F06：删掉的会话晚到的 run 事件不再把运行条点回来
      await this.refreshSessions();
      // 删掉的正是当前会话时要落到别处，否则界面停在一个已不存在的会话上
      if (this.activeId === id) {
        const next = this.sessions[0];
        if (next) await this.open(next.id);
        else {
          // 落到欢迎页：被删会话的临时态一并清掉，字段与 open() 换会话时清的同一组。W1b-4 起删除运行中的会话
          // 会先中止它，loop 报的「已取消」早于删除完成到达、写进了 lastError；不清的话欢迎页输入卡
          // 顶着一条已删会话的错误（xvfb 实拍逮到）。落到别的会话时 open() 已经清过，不用再管。
          // W2b-4：选择态镜像的是会话的助手，会话都没了就回到「没选」——不把已删会话的助手带进下一次开局
          this.activeId = ''; this.messages = []; this.welcomeAssistantId = '';
          this.lastError = ''; this.retryNote = ''; this.running = false; this.lastStopReason = ''; this.lastOutputLimit = null;
          this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
          this.contextInfo = null; this.streamingText = ''; this.streamingThinking = ''; this.toolCards = [];
          this.midRun = false; this.joinedTail = false; rememberActive(''); // F06：重载后不再回到这个已删的会话
          this.contextRecoveryState = null; this.compactionDetail = null;
        }
      }
    },
    // ---- F11B 删除同步：保留副本与生命周期广播 ----
    /** 重拉保留副本列表。旧引擎没有这个方法、或应答不是数组时置空（不报错：这只是一块可选的界面）。 */
    async refreshRetained() {
      try {
        const r = await rpc.call('chat.sessions.listRetained', {});
        this.retainedSessions = Array.isArray(r) ? r : [];
      } catch { this.retainedSessions = []; }
    },
    /** 恢复一个已在其他设备删除、本机留着内容的会话：它会重新出现在所有已配对设备上。失败原因原样抛给调用方显示。 */
    async restoreSession(id: string) {
      await rpc.call('chat.sessions.restore', { sessionId: id, confirm: true });
      await this.refreshSessions();
      await this.refreshRetained();
    },
    /** 彻底删除一个保留副本（清掉本机留着的内容，无法恢复）。用专门的方法，不用 chat.sessions.delete：
     *  后端只在它此刻仍是保留副本时才清。这份清单可能已经过期——另一台设备（或另一个窗口）刚把它恢复了、这里还没重拉——
     *  那时用通用的删除，就成了在所有设备上再删一次刚恢复的会话。
     *  被拒时两份列表都重拉（它多半已经回到会话列表里），原因原样抛给调用方显示。 */
    async purgeRetainedSession(id: string) {
      try {
        await rpc.call('chat.sessions.purgeRetained', { sessionId: id, confirm: true });
      } catch (e) {
        try { await this.refreshSessions(); } catch { /* 列表拉不到不盖住真正的失败原因 */ }
        await this.refreshRetained();
        throw e;
      }
      await this.refreshRetained();
    },
    /** 引擎广播的会话生命周期变化。删除（本机别的窗口发起的，或已配对设备上的）要把正开着的会话切走。 */
    async onSessionLifecycle(p: SessionLifecycleNotice) {
      if (!p || typeof p.sessionId !== 'string') return;
      await this.refreshSessions();
      // 保留副本列表当场发起、不等它，先把正开着的会话切走。F06：这条广播也会在重连的续传里回放——那时 afterSync 紧跟着
      // 带当前会话取一份快照（reloadActive），排在上面那次 chat.sessions.list 之后。切走的那一步要是再等一个往返
      //（保留副本列表是在那份快照的请求之后才发的），快照的应答先到，说「会话已不存在」，视图落到欢迎页，这里见 activeId
      // 已空就什么也不做——明明还有别的会话，也知道是谁删的，却既没切过去、也没说那一句。先切走的话，那份快照带的是旧会话，
      // 与 activeId 对不上，不动视图。refreshRetained 自己兜住失败、不会拒绝，不等它不会留下没人接的拒绝
      const retained = this.refreshRetained();
      if (p.kind === 'deleted' || p.kind === 'tombstone-applied') await this.leaveDeletedSession(p.sessionId, p.origin === 'remote');
      await retained;
    },
    /** 正开着的会话被删掉了：落到别的会话或欢迎页。本窗口自己发起的删除也会收到广播——deleteSession 的尾段做的是同一件事，
     *  谁先到谁做，另一个发现 activeId 已变（或会话还在列表里）就直接返回。remote = 是别的设备删的，多说一句原因。 */
    async leaveDeletedSession(id: string, remote: boolean) {
      if (this.activeId !== id || this.sessions.some(s => s.id === id)) return;
      const next = this.sessions[0];
      if (next) {
        await this.open(next.id);
        // open 换会话会清事件条，所以这一条在它之后追加
        if (remote) this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'synced' as const, ts: Date.now(), short: '刚才打开的会话已在另一台设备上删除' }];
        return;
      }
      // 没有别的会话：落到欢迎页，清的字段与 deleteSession 的 else 分支是同一组。照写一遍、不调 dropToWelcome()：
      // tests/renderer-delete-propagation 的守卫按文本比这两段赋了哪些字段（别的任务往那边加字段，这边不能落下）——
      // F06 往那边加的尾巴状态与重载记忆，这里同样带上
      this.activeId = ''; this.messages = []; this.welcomeAssistantId = '';
      this.lastError = ''; this.retryNote = ''; this.running = false; this.lastStopReason = ''; this.lastOutputLimit = null;
      this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
      this.contextInfo = null; this.streamingText = ''; this.streamingThinking = ''; this.toolCards = [];
      this.midRun = false; this.joinedTail = false; rememberActive(''); // F06：重载后不再回到这个已删的会话
      this.contextRecoveryState = null; this.compactionDetail = null;
    },
    /** F06：当前会话已经不存在（快照说的：断线期间、或在别的窗口被删）——落到欢迎页。
     *  清的字段与上面 deleteSession 落到欢迎页的分支是同一组（那一段被用例按文本钉着，这里不合并）。 */
    dropToWelcome() {
      this.activeId = ''; this.messages = []; this.welcomeAssistantId = '';
      this.lastError = ''; this.retryNote = ''; this.running = false; this.lastStopReason = ''; this.lastOutputLimit = null;
      this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
      this.contextInfo = null; this.streamingText = ''; this.streamingThinking = ''; this.toolCards = [];
      this.midRun = false; this.joinedTail = false; rememberActive('');
      this.contextRecoveryState = null; this.compactionDetail = null;
    },
    /** 重命名会话。后端会拒空标题与超 50 字，错误原样抛给调用方——
     *  菜单里要把这句话显示出来，静默吞掉就成了「点了确认没反应」。 */
    async renameSession(id: string, title: string) {
      await rpc.call('chat.sessions.rename', { sessionId: id, title });
      // 后端也会广播 sessions.changed，但那条是异步到达的；这里补一次
      // 让「点完确认列表立刻是新名字」成为确定行为（与同组其他 action 一致）
      await this.refreshSessions();
    },
    async setSessionPinned(id: string, pinned: boolean) {
      await rpc.call('chat.sessions.setPinned', { sessionId: id, pinned });
      await this.refreshSessions();
    },
    async setSessionMemory(id: string, enabled: boolean) {
      await rpc.call('chat.sessions.setMemoryEnabled', { sessionId: id, enabled });
      await this.refreshSessions();
    },
    /** binding 传 undefined / 空串即解绑（后端 setModelBinding 的取值约定）。 */
    async setSessionModelBinding(id: string, binding?: string) {
      await rpc.call('chat.sessions.setModelBinding', { sessionId: id, binding });
      await this.refreshSessions();
    },
    /** L5 会话级 MCP 禁用名单整体覆写（D5 后端语义即全量替换，非增量）。
     *  写后重拉列表镜像最新事实——与同组 action 一致，不就地改本地态。 */
    async setSessionMcpDisabled(id: string, servers: string[]) {
      await rpc.call('chat.sessions.setMcpDisabled', { sessionId: id, servers });
      await this.refreshSessions();
    },
    // ---- MU6 技能管理（消费既有 RPC，不新增方法）----
    async refreshAllSkills() { this.allSkills = await rpc.call('skills.list', {}); },
    /** 本轮只做**全局**启停：不传 sessionId 即写全局开关；传了才是会话覆盖。
     *  作用范围必须在界面上说清（计划 §6 第一坑）。 */
    async setSkillEnabled(id: string, enabled: boolean) {
      await rpc.call('skills.setEnabled', { id, enabled });
      await this.refreshAllSkills();
      await this.refreshSkills();
    },
    async deleteSkill(id: string) {
      await rpc.call('skills.delete', { id, confirm: true });
      await this.refreshAllSkills();
      await this.refreshSkills();
    },
    /** 导入本地技能目录。§2-4 拍板只接 kind:'folder'——原生目录选择器要走主进程 dialog，破红线 1。
     *  后端立即返回 taskId，真正的进度靠 skills.import.progress 广播喂 skillImport。 */
    async importSkillFolder(source: string) {
      this.skillImport = null;
      const t = await rpc.call('skills.import', { kind: 'folder', source });
      // 广播可能早于返回，也可能晚于返回：先占位，让界面立刻有「进行中」的反馈
      if (t && typeof t.taskId === 'string' && !this.skillImport) {
        this.skillImport = { taskId: t.taskId, state: 'running', total: 0, completed: 0, succeeded: [], failures: [] };
      }
      return t;
    },
    /** 轮询兜底：广播漏了也能把终态捞回来（导入是脱离 UI 生命周期的后台任务）。 */
    async pollSkillImport(taskId: string) {
      const t = await rpc.call('skills.importStatus', { taskId });
      if (t) this.skillImport = t;
      return t;
    },
    // ---- D6 MCP 服务器管理（设置页消费；upsert/toggle/remove 后统一重拉，列表即最新事实）----
    async fetchMcpServers() {
      const r = await rpc.call('mcp.servers.list');
      this.mcpServers = {
        servers: r?.servers ?? [],
        statuses: r?.statuses ?? [],
        configError: r?.configError === true,
        configErrorKind: r?.configErrorKind,
      };
    },
    async upsertMcpServer(entry: Record<string, unknown>) {
      await rpc.call('mcp.servers.upsert', entry);
      await this.fetchMcpServers();
    },
    async removeMcpServer(name: string) {
      await rpc.call('mcp.servers.remove', { name });
      await this.fetchMcpServers();
    },
    async toggleMcpServer(name: string, enabled: boolean) {
      await rpc.call('mcp.servers.toggle', { name, enabled });
      await this.fetchMcpServers();
    },
    /** 试连两形态：{ name } 试已存条目；完整条目 = 表单保存前试连（不落库）。
     *  失败不抛——返回 { ok:false, error } 由界面内联展示。 */
    async testMcpServer(p: Record<string, unknown>): Promise<{ ok: boolean; toolCount?: number; elapsedMs?: number; error?: string }> {
      return await rpc.call('mcp.servers.test', p);
    },
    // ---- MU6 同步控制（消费 M6 既有 control.* 三方法）----
    async refreshSyncPaused() {
      const r = await rpc.call('control.status');
      this.syncPaused = !!(r && r.syncPaused);
    },
    async setSyncPaused(paused: boolean) {
      // 后端 resume 内部顺序敏感（先清标志再触发收敛），这里只管调，不复制它的逻辑
      const r = await rpc.call(paused ? 'control.pause' : 'control.resume');
      this.syncPaused = r && typeof r.syncPaused === 'boolean' ? r.syncPaused : paused;
    },
    // ---- 工作区可选（用户 2026-08-11：「这个点不开，无法使用」）----
    async refreshWorkspace() {
      if (!this.activeId) { this.workspaceRoot = ''; this.workspaceIsDefault = true; return; }
      const r = await rpc.call('workspace.get', { sessionId: this.activeId });
      this.workspaceRoot = r?.root ?? '';
      this.workspaceIsDefault = !!r?.isDefault;
    },
    async setWorkspace(root: string) {
      await rpc.call('workspace.set', { sessionId: this.activeId, root });
      await this.refreshWorkspace();
      // 工作区变了，终端与文件树都得跟着变——终端已起的会话要重开才会落到新 cwd
      this.pendingFilePreview = '';
    },
    async resetWorkspace() {
      await rpc.call('workspace.reset', { sessionId: this.activeId });
      await this.refreshWorkspace();
    },
    /** 原生目录选择器（主进程 dialog）。取消返回 null——不能当空串用。 */
    async pickWorkspaceFolder(): Promise<string | null> {
      const bridge = (window as any).deskminis;
      if (!bridge || typeof bridge.pickFolder !== 'function') return null;
      return await bridge.pickFolder();
    },
    async newSession() { const s = await rpc.call('chat.sessions.create', {}); await this.refreshSessions(); await this.open(s.id); },
    async open(id: string) {
      // W2b-3b：断线之后什么都不做。下面先改 activeId 再取消息，取消息被拒时标题已换成 B、对话流还是 A 的消息与半截正文；
      // 横幅已经说「新的操作不会执行」，换会话也是新操作——当前视图原样留着，半截正文还能复制
      if (this.connection === 'lost') return;
      // F06：重连期间同样不换会话（取消息的调用发不出去）；重连后的同步会重取当前会话
      if (this.connection === 'reconnecting') return;
      // 工作区是每会话的，切会话必须重新取——否则 chip 会显示上一个会话的目录
      // 换会话才清错误横幅：turnEnd/error 之后的自刷新调用的也是 open，
      // 在那条路径上清掉的话，刚设置的 lastError 会被立刻抹掉（错误又变成看不见）。
      if (id !== this.activeId) {
        // W2b-1：running 取这个会话自己的运行态，不再一律归零——切回仍在跑的会话，停止键得回来（chat.cancel 按 activeId 取消）。
        // 流式缓冲在下面清空，之后到达的只是半截，所以同时打上 midRun 占位
        this.lastError = ''; this.retryNote = ''; this.running = this.runningSessions.includes(id);
        this.midRun = this.running;
        this.lastStopReason = ''; this.lastOutputLimit = null;
        this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
        this.contextInfo = null;
        this.contextRecoveryState = null; this.compactionDetail = null;
        // W2b-4：选择态镜像这个会话已绑的助手。以前一律清成 ''：新建的带助手会话回到欢迎页时卡片不亮、副标题说没选，
        // 用户再点一次就会被当成「改选」；贴图、选工作区隐式建会话后，刚点的选择也在这里被静默作废。
        // 只在换会话时取：同一会话的自刷新（turnEnd / error 后的 open）不能覆盖用户刚点、还没发出去的选择
        this.welcomeAssistantId = this.sessions.find(s => s.id === id)?.assistantId ?? '';
        this.joinedTail = false; // F06：尾巴模式随会话走；这个会话在跑的话由下面的 joinRun 重新接上
      }
      const hq = historyQuery(id, this.messages); // Q14：能续取就只取增量
      this.activeId = id; this.messages = hq.merge(await rpc.call('chat.messages.list', hq.params)); _histOf = id; this.streamingText = ''; this.streamingThinking = ''; this.toolCards = [];
      // F06：这一份历史作废在途的尾巴重取（它的应答比这份旧）；记下当前会话供重载后回来
      _histTicket += 1; _tailCut = null;
      if (this.activeId === id) rememberActive(id);
      // F06：这个会话有话要交代，而出结论的那一刻用户在看别的会话（或这份历史刚把气泡换掉了）：
      // 核对出「没有送达」的那条消息——气泡接回末尾、带重试钮的说明补上；寄存给它的说明（权限答复的结局、是否送达未知）放出来
      if (this.activeId === id) { this.showUndelivered(); this.flushParked(id); }
      // F06：这个会话的回合正在跑——取一份带会话的快照，把「历史 + 还没落库的尾巴」一次接上。
      // 切到在跑的会话、重载后打开它、同会话的中途刷新，都不再是占位，也不丢已经流出的正文。
      // 旧引擎（syncOn 为假）保持占位
      if (this.syncOn && this.running && this.activeId === id) await this.joinRun();
      void this.refreshSkills(); // 会话覆盖会改变生效启用集，换会话必须重取
      void this.refreshAnnotations(); // H2：注释随会话装载（高亮重锚定数据源）
      void this.refreshAttachments(); // F11A：附件状态随会话装载
      await this.refreshWorkspace();
    },
    // ── F11A 附件同步状态 ──
    async refreshAttachments() {
      if (!this.activeId) { this.attachmentViews = {}; return; }
      const id = this.activeId;
      let r: AttachmentStatusResult | undefined;
      // 旧引擎没有这个方法：状态表置空，chip 回到没有状态的样子
      try { r = await rpc.call('attachments.status', { sessionId: id }); } catch { r = undefined; }
      if (this.activeId !== id) return; // 等待期间换了会话就丢弃，防串台
      const next: Record<string, AttachmentView> = {};
      for (const item of r?.items ?? []) next[item.relativePath] = item;
      this.attachmentViews = next;
    },
    /** 重试 / 下载（「下载」是对用户取消过的附件重新要）。没有真的发起时把原因写进 lastError 让它可见。 */
    async retryAttachment(name: string) {
      if (!this.activeId) return;
      try {
        const r: AttachmentRetryResult = await rpc.call('attachments.retry', { sessionId: this.activeId, name });
        const note = retryNote(r);
        if (note) this.lastError = note;
      } catch (e) { this.lastError = errText(e); }
      await this.refreshAttachments();
    },
    async cancelAttachment(name: string) {
      if (!this.activeId) return;
      try { await rpc.call('attachments.cancel', { sessionId: this.activeId, name }); } catch (e) { this.lastError = errText(e); }
      await this.refreshAttachments();
    },
    // ── H2 文本选区注释（写操作不就地改本地态，统一靠 changed 广播回流刷新）──
    async refreshAnnotations() {
      if (!this.activeId) { this.annotations = []; return; }
      const id = this.activeId;
      const r = await rpc.call('chat.annotations.list', { sessionId: id });
      if (this.activeId === id) this.annotations = r?.annotations ?? []; // 等待期间换了会话就丢弃，防串台
    },
    async addAnnotation(messageId: string, sel: { exact: string; prefix: string; suffix: string }) {
      if (!this.activeId) return;
      await rpc.call('chat.annotations.add', { sessionId: this.activeId, messageId, ...sel });
    },
    async updateAnnotationNote(id: string, note: string) {
      await rpc.call('chat.annotations.update', { id, note });
    },
    async removeAnnotation(id: string) {
      await rpc.call('chat.annotations.remove', { id });
    },
    /** F07 inputs are receipts/queue rows; they never reset or optimistically interrupt a running reply. */
    adoptInputs(inputs: InputView[], sessionId?: string) {
      const grouped: Record<string, InputView[]> = sessionId ? {...this.inputsBySession, [sessionId]: []} : {};
      for (const input of inputs) {
        if (!input || typeof input.sessionId !== 'string' || this.goneSessions.includes(input.sessionId)) continue;
        if (sessionId && input.sessionId !== sessionId) continue;
        (grouped[input.sessionId] ??= []).push(input);
      }
      this.inputsBySession = grouped;
    },
    noteInput(input: InputView) {
      if (this.goneSessions.includes(input.sessionId)) return;
      const old = this.inputsBySession[input.sessionId] ?? [];
      const current = old.find(i => i.messageId === input.messageId);
      // A send response can arrive after a later input broadcast. Do not regress that fact.
      if (current && current.updatedAt > input.updatedAt) return;
      this.inputsBySession = {...this.inputsBySession, [input.sessionId]: [...old.filter(i => i.messageId !== input.messageId), input].sort((a,b)=>(a.position??a.seq)-(b.position??b.seq)||a.seq-b.seq)};
    },
    async refreshInputs(sessionId = '') {
      if (!sessionId) sessionId = this.activeId;
      if (!this.inputsOn || !sessionId || this.goneSessions.includes(sessionId)) return;
      const ticket = this.engineEpoch;
      try {
        const r = await rpc.call<{sessionId: string; inputs: InputView[]}>('chat.input.list', {sessionId});
        if (ticket === this.engineEpoch && !this.goneSessions.includes(sessionId)) this.adoptInputs(r.inputs, sessionId);
      } catch { /* Snapshot or the next ordered broadcast remains authoritative. */ }
    },
    async sendInput(mode: InputMode, text: string, attachments: string[] = []): Promise<boolean> {
      const sessionId = this.activeId;
      if (!sessionId || !this.inputsOn) {this.lastError = '当前后台不支持运行中输入'; return false;}
      if (this.connection === 'lost' || this.connection === 'reconnecting') {this.lastError = '连接未就绪，输入没有发送'; return false;}
      const run = this.runOf[sessionId];
      if (mode === 'steer' && (!run || run.ended || !run.runId)) {this.lastError = '尚未确认当前运行，请稍候或选择排队'; return false;}
      const epoch = this.engineEpoch, old = this.inputRetryBySession[sessionId];
      const reuse = old && old.mode === mode && old.text === text && (old.runId ?? '') === (mode === 'steer' ? run!.runId : '')
        && (old.attachments ?? []).length === attachments.length && (old.attachments ?? []).every((a,i)=>a === attachments[i]);
      const p: InputSend = reuse ? {...old,attachments:[...attachments]} : {sessionId, messageId: crypto.randomUUID(), mode, text, attachments,
        ...(mode === 'steer' ? {runId: run!.runId} : {}),
        ...(this.thinkingLevel === 'off' ? {} : {thinkingLevel: this.thinkingLevel})};
      this.lastError = '';
      try {
        const r = await rpc.call<InputResult>('chat.input.send', p);
        if (reuse && this.inputRetryBySession[sessionId]?.messageId === p.messageId) delete this.inputRetryBySession[sessionId];
        if (epoch !== this.engineEpoch) {
          if (!this.goneSessions.includes(sessionId)) {this.inDoubtInputs = [...this.inDoubtInputs,p];void this.settleInputsInDoubt();}
          return true;
        }
        this.noteInput(r.input);
        // A queue may already be starting; join the authoritative run instead of inventing a generation.
        if (mode === 'queue' && p.sessionId === this.activeId && (r.input.state === 'starting' || r.input.state === 'admitted')) void this.joinRun();
        return true;
      } catch (e) {
        if (this.syncOn && isInFlightLoss(e)) {
          if (reuse && this.inputRetryBySession[sessionId]?.messageId === p.messageId) delete this.inputRetryBySession[sessionId];
          if (!this.goneSessions.includes(sessionId)) this.inDoubtInputs = [...this.inDoubtInputs, p];
          return true; // Retained as an uncertain row until state.outcomes resolves it. Never resend.
        }
        if (sessionId === this.activeId && !this.goneSessions.includes(sessionId)) this.lastError = errText(e);
        return false;
      }
    },
    async changeInput(messageId: string, action: 'cancel' | 'resume') {
      const sessionId = this.activeId;
      if (!sessionId || this.connection === 'lost' || this.connection === 'reconnecting') {this.lastError = '连接未就绪，队列操作没有发送'; return;}
      try {
        const epoch = this.engineEpoch;
        const r = await rpc.call<{input: InputView}>(`chat.input.${action}`, {sessionId,messageId});
        if (epoch !== this.engineEpoch) {void this.refreshInputs(sessionId); return;}
        this.noteInput(r.input);
        if (action === 'resume' && sessionId === this.activeId) void this.joinRun();
      } catch (e) {if (sessionId === this.activeId) this.lastError = errText(e);}
    },
    /** Row operations propagate errors to the inline editor and never apply an old-engine receipt. */
    async updateQueueInput(method: 'chat.input.hold' | 'chat.input.edit' | 'chat.input.move' | 'chat.input.steer' | 'chat.input.resume', params: Record<string,unknown>, sessionId: string) {
      if (!sessionId || this.connection === 'lost' || this.connection === 'reconnecting') throw Error('连接未就绪，队列操作没有发送');
      const epoch = this.engineEpoch;
      try {
        const r = await rpc.call<{input: InputView}>(method, {...params,sessionId});
        if (epoch !== this.engineEpoch || this.goneSessions.includes(sessionId)) throw Error('后台已更换，请重新打开队列');
        this.noteInput(r.input);
        if (method === 'chat.input.move') await this.refreshInputs(sessionId);
        if ((method === 'chat.input.resume' || (method === 'chat.input.edit' && params.resume)) && sessionId === this.activeId) void this.joinRun();
        return r.input;
      } catch (e) {await this.refreshInputs(sessionId);throw e;}
    },
    holdQueueInput(messageId: string, sessionId?: string) {
      return this.updateQueueInput('chat.input.hold', {messageId}, sessionId ?? this.activeId);
    },
    editQueueInput(messageId: string, text: string, updatedAt: number, resume: boolean, sessionId?: string) {
      return this.updateQueueInput('chat.input.edit', {messageId,text,updatedAt,resume}, sessionId ?? this.activeId);
    },
    moveQueueInput(messageId: string, beforeMessageId: string | null, sessionId?: string) {
      return this.updateQueueInput('chat.input.move', {messageId,beforeMessageId}, sessionId ?? this.activeId);
    },
    steerQueueInput(messageId: string, runId: string, sessionId?: string) {
      return this.updateQueueInput('chat.input.steer', {messageId,runId}, sessionId ?? this.activeId);
    },
    resumeQueueInput(messageId: string, sessionId?: string) {
      return this.updateQueueInput('chat.input.resume', {messageId}, sessionId ?? this.activeId);
    },
    async settleInputsInDoubt() {
      const inputs = this.inDoubtInputs.filter(p => !_checking.has('i:' + p.sessionId + ':' + p.messageId));
      for (let at = 0; at < inputs.length; at += 64) {
        const batch = inputs.slice(at, at+64), keys = batch.map(p => 'i:' + p.sessionId + ':' + p.messageId);
        for (const key of keys) _checking.add(key);
        let result: OutcomesResult;
        const epoch = this.engineEpoch;
        try {result = await rpc.call<OutcomesResult>('state.outcomes', {refs: batch.map(p=>({kind:'input',sessionId:p.sessionId,messageId:p.messageId}))});}
        catch {return;} finally {for (const key of keys) _checking.delete(key);}
        if (epoch !== this.engineEpoch) {void this.settleInputsInDoubt(); return;} // Keep uncertain IDs for the current engine query.
        for (const outcome of result.outcomes ?? []) {
          if (outcome.kind !== 'input') continue;
          const p = batch.find(p=>p.sessionId === outcome.sessionId && p.messageId === outcome.messageId);
          if (!p) continue;
          this.inDoubtInputs = this.inDoubtInputs.filter(i=>i.sessionId !== p.sessionId || i.messageId !== p.messageId);
          if (this.goneSessions.includes(p.sessionId)) continue;
          if (outcome.status === 'accepted') this.noteInput(outcome.input);
          else {
            this.failedInputDrafts = {...this.failedInputDrafts,[p.sessionId]: [...(this.failedInputDrafts[p.sessionId]??[]),p]};
            this.sessionNote(p.sessionId, '追加输入没有送达，草稿已保留，请自行决定是否发送');
          }
        }
      }
    },

    async send(text: string, attachments?: string[], requestedThinking?: ThinkingLevel) {
      // 记下发给谁（到 chat.prompt 之前没有 await，sid 就是 prompt 发往的会话）：prompt 可能要等很久才被拒
      // （W1b-4 起，会话在连 MCP 期间被删或被停止会以「会话已取消」拒绝，要等连接超时才回来），
      // 那时用户可能已经在看别的会话了，见下面 catch
      const sid = this.activeId;
      // W2b-3：断线之后什么都不动就退。发送键置灰管不到键盘——Enter 照样进到这里，事件条的「重试」（retryLast）也是；
      // 必须在下面清缓冲之前：断线时特意留下的半截回复与事件条（markConnectionLost）是给用户复制、查看的，
      // 往下走的话一次按键就全清空（rpc 的拒绝要到清空之后才回来），还会推一个发不出去的乐观气泡、把停止键点亮。
      // 写 lastError 是交代，也是给输入卡的信号：它见 lastError 才把寄存的草稿交回框里（Composer send 之后那行 takeDraft）
      if (this.connection === 'lost') { this.lastError = LINK_LOST_NOTE; return; }
      // F06：重连期间不发——发出去的结果注定未知。同样写 lastError，输入卡据此把草稿交回框里（连上之后这句由 onLinkStatus 清掉）
      if (this.connection === 'reconnecting') { this.lastError = LINK_WAIT_SEND_NOTE; return; }
      // F06：重发「没有送达」的那一条（会话、文本、附件都相同）沿用原来的 promptId——引擎按它持久去重，
      // 万一那一帧其实晚到了也不会起第二个 run。旧的乐观气泡先摘掉，下面会推一条新的；
      // 这次发送被引擎拒绝的话，记录与气泡在 catch 里原样放回
      const atts0 = attachments ?? [];
      const und = this.undelivered;
      const reuse = und !== null && und.sessionId === sid && und.text === text
        && und.attachments.length === atts0.length && und.attachments.every((a, i) => a === atts0[i]);
      const thinkingLevel = reuse && und !== null ? und.thinkingLevel ?? 'off' : requestedThinking ?? this.thinkingLevel;
      const thinking = thinkingLevel === 'off' ? {} : { thinkingLevel };
      const promptId = reuse && und !== null ? und.promptId : crypto.randomUUID();
      if (und !== null && und.sessionId === sid) { this.messages = this.messages.filter(m => m.id !== und.optimisticId); this.undelivered = null; }
      this.joinedTail = false; _tailCut = null; // 本窗口发起的回合从头看着，不走尾巴模式
      this.streamingText = ''; this.streamingThinking = ''; this.toolCards = []; this.lastError = ''; this.retryNote = '';
      this.lastStopReason = ''; this.lastOutputLimit = null; this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
      // F03：恢复说明是上一次运行的，清掉。compactionDetail 不清——它是这个会话的压缩记录的摘录（来自库，不属于哪一次运行），
      // 「上下文已压缩」卡靠它显示；发送之后没有人立刻去取 chat.contextInfo（正文、工具卡事件不触发取数），
      // 在这里清的话卡片当场消失，要等下一次轮询或回合结束才回来。换会话、删除会话那两处照旧清
      this.contextRecoveryState = null;
      // F03：此刻还在途的 chat.contextInfo 应答作废——它是发这条消息之前问的，带着上一次运行留下的恢复说明
      //（引擎要到收下 chat.prompt 才清）；晚到的话会把刚清掉的恢复卡写回来。到 chat.prompt 之前没有 await，之后再问的排在它后面
      contextInfoSeq++;
      // 乐观消息用唯一 id：一次会话内连发多条时 'local' 会造成 :key 重复
      const optimisticId = `local-${++localSeq}`;
      // 乐观消息与后端落库形态同构：文本 + 每附件一枚 mediaRef（chip 渲染靠它；
      // turnEnd 后 open() 重取的消息会带后端生成的正式 mediaRef 把乐观版换掉）
      const atts = attachments ?? [];
      const parts: any[] = [];
      if (text.trim() !== '') parts.push({ type: 'text', value: text });
      for (const rel of atts) {
        parts.push({
          type: 'mediaRef',
          value: {
            id: crypto.randomUUID().toUpperCase(),
            relativePath: rel,
            mimeType: mimeFromPath(rel) ?? 'application/octet-stream',
            originalFileName: rel.split('/').pop(),
          },
        });
      }
      _bubbleIds.add(optimisticId);
      this.messages.push({ id: optimisticId, role: 'user', parts, createdAt: Date.now() / 1000 });
      this.running = true;
      // W2b-1：本窗口发起的回合是从头看着的，不算中途接上。流式缓冲上面已清空，这里不清 midRun 的话，
      // 残留的占位会把这一回合整段挡到 turnEnd。可达路径：EventNotes 的重试钮不看 running，
      // 别处起的回合被本窗口中途接上（midRun）时照样能点，后端拒绝后也不该留下「midRun 却没在跑」的矛盾态。
      this.midRun = false;
      // W2b-1：发出即记账——回合第一个事件到达之前就切走的话，切回时停止键靠这一条才回得来（sid 见函数开头）
      if (!this.runningSessions.includes(sid)) this.runningSessions = [...this.runningSessions, sid];
      // chat.prompt 会同步拒绝（未配置 provider / 空文本 / 会话运行中 / 非法 sessionId）。
      // 不 catch 的话是一次未处理拒绝：用户只看到「按了没反应」。捕获后写进 lastError 让它可见，
      // 并摘掉这条从未落库的乐观消息（否则会留下一个假的「已发送」气泡）。
      // F06：登记在途（见 _sending 的注释）；调用落定即摘
      _sending.set(optimisticId, { sessionId: sid, promptId });
      try {
        // F05：每次发送一个新的 promptId（标识这一次提交）。引擎按它持久去重：同一个 id 重复到达——
        // 重连后的重发、另一个窗口的同一次提交——不会起第二个 run、不会落第二条消息
        // F06：promptId 在函数开头取（重发「没有送达」的那一条时沿用原来的）
        const r = await rpc.call('chat.prompt', { sessionId: this.activeId, text, attachments: atts, promptId, ...thinking });
        if (!this.goneSessions.includes(sid)) _lastThinking.set(sid, { text, level: thinkingLevel });
        _sending.delete(optimisticId);
        // F06：记下本窗口跟踪的是哪一次 run（带 promptId 的提交应答里都有；桩与旧引擎回 { ok: true } 时跳过）。
        // 从第一个事件到来之前起就知道，重连 / 快照之后的收口只认它
        if (r && typeof r.runId === 'string' && typeof r.generation === 'number') this.noteSubmitted(sid, optimisticId, r);
      } catch (e) {
        _sending.delete(optimisticId);
        // F06：调用已经发出、应答随断线丢了——不知道引擎收没收到。不撤气泡、不动运行态、不写错误、**不重发**：
        // 记下来，重连后用 state.outcomes 核对（已接收 → 照常显示；没接收 → 说明没有送达，由用户点重试）。
        // 与摘出在途表在同一段同步代码里：中间不让出，快照不会在两张表之间的空档里把这个会话摘掉
        if (this.syncOn && isInFlightLoss(e)) {
          if (!this.goneSessions.includes(sid)) _lastThinking.set(sid, { text, level: thinkingLevel });
          this.inDoubtPrompts = [...this.inDoubtPrompts, { sessionId: sid, promptId, text, attachments: atts, optimisticId, ...thinking }];
          return;
        }
        // W2b-1：回合没起来，不能留一个「在跑」的假账——不管用户现在停在哪个会话上都要撤
        this.runningSessions = this.runningSessions.filter(x => x !== sid);
        // 只在还停在发它的那个会话上时才写：先切到 B 再删 A，A 的「会话已取消」若照写，会顶在 B 的输入卡上，
        // B 正在跑的话还会被误标成没在跑（停止钮消失、能再发）。换了会话就丢掉这个错误：A 删了就没了，
        // 停止是用户自己点的；乐观消息在 open() 换会话时已随 messages 换掉，不用再撤
        if (this.activeId === sid) {
          this.lastError = e instanceof Error ? e.message : String(e);
          this.messages = this.messages.filter(m => m.id !== optimisticId);
          this.running = false;
        }
        // F06：这次发送没有发生（引擎当场拒绝：会话正在运行、模型还没配好、附件已不在、关停中……）——函数开头摘掉的
        // 那条「没有送达」原样放回：记录、气泡、带重试钮的说明。重试不经输入卡，没有草稿可交还；不放回的话这条消息的
        // 文字与附件引用就找不回来，重试入口也没了。用户改发别的一条被拒时同理：那一条由输入卡交还，这一条仍留着。
        // 槽位只有一个：等待期间别的会话核对出了新的一条就不覆盖；会话已删的不放回（删了就没了）。
        // 已经不在发它的会话上时只恢复记录，气泡与说明由切回去时的 open() 接回（showUndelivered 自己判）
        if (und !== null && und.sessionId === sid && this.undelivered === null && !this.goneSessions.includes(sid)) {
          this.undelivered = und;
          this.showUndelivered();
        }
      }
    },
    /** F06：chat.prompt 成功返回、应答带着 run 的身份。duplicate = 这个 promptId 早已被接收（重发「没有送达」的那一条时，
     *  原来那一帧其实晚到了）：真实消息已在历史里，摘掉这条乐观气泡并重取；那次 run 已结束的话运行标记一并撤掉——
     *  不撤的话没有事件会来收它，停止键永远亮着。 */
    noteSubmitted(sid: string, optimisticId: string, r: { runId: string; generation: number; duplicate?: boolean; state?: string }) {
      const t = this.runOf[sid];
      const ended = r.duplicate === true && typeof r.state === 'string' && !RUN_ACTIVE(r.state);
      if (!t || r.generation > t.generation) this.runOf[sid] = { runId: r.runId, generation: r.generation, ended };
      if (r.duplicate !== true) return;
      if (ended) this.runningSessions = this.runningSessions.filter(x => x !== sid);
      if (this.activeId !== sid) return;
      this.messages = this.messages.filter(m => m.id !== optimisticId);
      if (ended) { this.running = false; this.midRun = false; }
      void this.reloadActive();
    },
    async cancel() {
      if (!this.activeId) return;
      // F06：重连期间不发（发不出去，发出去结果也未知）。引擎里的回合还在跑，停止键留着
      if (this.connection === 'reconnecting') { this.lastError = LINK_WAIT_CANCEL_NOTE; return; }
      const sessionId = this.activeId, run = this.runOf[sessionId];
      if (this.inputsOn && (!run || run.ended || !run.runId)) {this.lastError = '尚未确认当前运行，请稍候再停止'; return;}
      try { await rpc.call('chat.cancel', { sessionId, ...(run && !run.ended ? {runId: run.runId} : {}) }); }
      catch (e) { this.lastError = e instanceof Error ? e.message : String(e); }
    },
    async setDefaultProvider(id: string) {
      await rpc.call('provider.setDefault', { id });
      this.defaultProviderId = id;
    },
    async setPermTier(tier: PermTier) {
      // 真正写后端并持久化；成功后更新本地镜像。rpc 失败会抛错，本地值保持原样——
      // 界面高亮不得谎报「已切换」，否则用户以为关了「完全访问」其实网关还开着。
      const r = await rpc.call('permission.setPreset', { preset: tier });
      if (r && r.ok) this.permTier = tier;
    },
    // ---- Z3 模型组（M2b 后端全通：modelgroup.* 五个 RPC；设置页 SecModelGroups 消费，写后统一重拉）----
    async refreshModelGroups() { this.modelGroups = await rpc.call('modelgroup.list'); },
    async createModelGroup(name: string, memberIds: string[]) {
      const g = await rpc.call('modelgroup.create', { name, memberIds });
      await this.refreshModelGroups();
      return g;
    },
    /** 后端对空 memberIds **静默忽略**（保留旧成员）——调用方必须先拦空成员，否则界面会谎报「已保存」。 */
    async updateModelGroup(id: string, patch: { name?: string; memberIds?: string[] }) {
      await rpc.call('modelgroup.update', { id, ...patch });
      await this.refreshModelGroups();
    },
    /** 后端强制 confirm:true（deleteSession 同款：漏了会抛错，界面表现为「点了删除没反应」）。 */
    async deleteModelGroup(id: string) {
      await rpc.call('modelgroup.delete', { id, confirm: true });
      await this.refreshModelGroups();
    },
    async createProvider(p: any) { await rpc.call('provider.instances.create', p); await this.refreshProviders(); },
    async updateProvider(id: string, p: any) { await rpc.call('provider.instances.update', { id, ...p }); await this.refreshProviders(); },
    async deleteProvider(id: string) { await rpc.call('provider.instances.delete', { id, confirm: true }); await this.refreshProviders(); },
    /** 设置页「获取列表」：拉端点模型清单（纯查询，不刷新 providers）。失败由调用方静默回退手输。 */
    async fetchProviderModels(p: { id?: string; kind?: string; baseUrl?: string; apiKey?: string }) { return await rpc.call<{ models: string[] }>('provider.models.fetch', p); },
    async getCatalogProviders() { return await rpc.call<{ providers: { id: string; api: string }[] }>('provider.catalog.providers'); },
    async getModelCatalogStatus() { return await rpc.call<ModelCatalogStatus>('provider.catalog.get'); },
    async refreshModelCatalog() { return await rpc.call<{ refreshed: boolean; status: ModelCatalogStatus }>('provider.catalog.refresh'); },
    /** F01：运行时规格（与 Agent 循环同一个 resolver）。传 id 解析已保存的配置；传表单字段解析还没保存的草稿。纯查询、不带密钥。
     *  取代设置页原先的 getModelMetadata（只按「官方域名 → 服务商」自己猜，看不到手动修正与应用是否实现）；
     *  目录原始视图的 RPC provider.models.metadata 仍在。 */
    async resolveRuntime(p: { id: string } | { kind: string; modelId: string; baseUrl?: string; name?: string; contextWindow?: unknown; maxOutputTokens?: unknown; capabilityOverrides?: unknown; catalogProviderId?: unknown }) {
      return await rpc.call<{ runtime: RuntimeModel; status: ModelCatalogStatus; thinkingServerAdaptive?: boolean; thinkingPreview?: ThinkingPreview }>('provider.runtime.resolve', p);
    },
    /** N04：诊断页只读取既有接口，应答留在组件内，不改变会话状态。 */
    async fetchProcSnapshot() { return await rpc.call<ProcSnapshot>('proc.trees.snapshot'); },
    async fetchCheckpointUsage() { return await rpc.call<CheckpointUsage>('checkpoints.usage'); },
    async runDiagnostics() { return await rpc.call<DryRunResult>('diagnostics.dryRun'); },
    async fetchAuditRecords() { return await rpc.call<{ rows: AuditRow[]; total: number }>('audit.list', { limit: 20, offset: 0 }); },
    /** 网络搜索 provider：读状态（无密钥本体，只有 hasKey）/ 保存配置（kind 传 none 清除）。 */
    async fetchSearchProvider() { const r = await rpc.call<{ kind: string; hasKey: boolean; baseUrl?: string }>('search.provider.get'); this.searchProvider = r; return r; },
    async saveSearchProvider(p: { kind: string; apiKey?: string; baseUrl?: string }) { await rpc.call('search.provider.set', p); await this.fetchSearchProvider(); },
    async respondPerm(requestId: string, decision: string) {
      // F06：重连期间不摘卡、不发答复（按钮也禁用了；这里挡键盘与别的入口）。连上之后卡还在，再选
      if (this.connection === 'reconnecting') return;
      // 摘卡之前先取出它：答复没生效时要知道这张卡属于哪个会话（留条只写给当前会话，同超时留条）
      const hit = this.pendingPerms.find(x => x.requestId === requestId);
      this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId);
      let r: { applied?: boolean; settled?: { reason?: string } } | undefined;
      try {
        r = await rpc.call<{ applied?: boolean; settled?: { reason?: string } } | undefined>('permission.respond', { requestId, decision });
      } catch (e) {
        // F06：答复已经发出、应答随断线丢了——不知道引擎收没收到。**不重发**（重发可能批准一张已经换了内容的卡）：
        // 记下来，重连后核对（卡又出现 = 没送达，请重新选择；否则查 state.outcomes 说清它的结局）
        if (this.syncOn && isInFlightLoss(e)) {
          this.inDoubtPerms = [...this.inDoubtPerms, { requestId, sessionId: hit?.sessionId ?? '' }];
          return;
        }
        // 其它失败（引擎报错、没开恢复时的断线）：以前是一次没人接的拒绝，按了没反应；现在说出来
        this.lastError = errText(e);
        return;
      }
      // F13：引擎回 applied:false = 这次点击没有生效（卡已超时 / 已在别处处理 / 已取消 / 已失效）。以前悄悄没反应。
      // applied 缺省（旧引擎只回 { ok: true }）时不留条，行为与以前相同
      if (r?.applied === false && hit?.sessionId === this.activeId) {
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail: permLateNote(r.settled), retryable: false }];
      }
    },
    /** W2b-3：连接断了。回合与权限卡都已无人接收：停止键、在跑的会话标记、一排点了没反应的权限按钮都撤掉。
     *  已流出的正文与消息留着，半截回复留给用户复制；实时区的步骤卡撤掉——那一组标着「正在执行…」，引擎已经没了。
     *  中途接上的回合（midRun）手里只有接上之后的半截，与 turnEnd / error 同一口径一起丢，占位也撤下（它说「仍在运行」）。
     *  不写 lastError：顶栏横幅已经在说，会话页红条再说一遍就是同一句话说两遍。
     *  设备同步在引擎里跑，引擎没了就谈不上「已连接其它设备」：同步点回到未连接，sync.dirty 留下的 2 秒回落定时器也撤掉——
     *  不撤的话它到点把点翻成绿的「已连接其它设备」，正压在断线横幅上面（xvfb 实拍逮到）。 */
    markConnectionLost() {
      this.connection = 'lost';
      this.running = false;
      this.runningSessions = [];
      this.pendingPerms = [];
      this.retryNote = '';
      this.streamingThinking = '';
      this.toolCards = [];
      if (this.midRun) { this.streamingText = ''; this.midRun = false; }
      if (_syncDirtyTimer) { clearTimeout(_syncDirtyTimer); _syncDirtyTimer = undefined; }
      this.syncState = 'offline';
      // F06：尾巴模式随运行态一起撤；别处起跑的跟踪也不再有意义
      this.joinedTail = false; _tailCut = null; this.pendingStarts = {};
    },
    // ==================== F06：快照、续传、重连之后的重建与核对 ====================
    /** 事件条里留一句交代。走 error 类（与 F13 的权限留条同一类）并自带 short：EventNotes 优先用 short，
     *  不对这句话跑状态码正则。只写给当前会话的视图：eventNotes 是当前会话的单缓冲。 */
    linkNote(short: string, o: { retryable?: boolean; detail?: string } = {}) {
      this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error' as const, ts: Date.now(), short, retryable: o.retryable === true, ...(o.detail ? { detail: o.detail } : {}) }];
    },
    /** 这个会话有没有本窗口自己发出、结果还没落定的提交（在途，或断线时在途、等核对）。 */
    hasUnsettled(sid: string): boolean {
      for (const v of _sending.values()) if (v.sessionId === sid) return true;
      return this.inDoubtPrompts.some(p => p.sessionId === sid);
    },
    /** rpc 的 status 钩子。reconnecting：运行态、卡片、正文一律不动（引擎里的任务还在跑，不能显示成已结束）。
     *  open：重连后 connection 回到 'ok' 的唯一一处，发生在开闸的同一刻、任何回放帧分发之前——
     *  回放的 turnEnd / error 调到的 open(activeId) 才不会被 reconnecting 的判断挡回去。
     *  lost：终态；运行态由随后的 markConnectionLost() 清。 */
    onLinkStatus(s: LinkStatus) {
      // Q14：连接断过，断线期间引擎里发生了什么不知道——重连之后第一次取历史取完整列表
      if (s.state !== 'open') _histOf = '';
      if (s.state === 'reconnecting') {
        this.connection = 'reconnecting';
        this.link = { attempt: s.attempt, maxAttempts: s.maxAttempts, ...(s.retryInMs !== undefined ? { retryInMs: s.retryInMs } : {}) };
        return;
      }
      this.link = null;
      if (s.state === 'open') {
        this.connection = 'ok';
        // 断线期间写下的「正在重新连接… / 已断开 / 连接恢复后才能停止」到这里已经不成立：清掉，不然连上了红条还在说没连上。
        // 只清这三句——回放帧里 error 事件写的 lastError 在这之后才到，别的来源的错误也原样留着
        if (LINK_NOTES.includes(this.lastError)) this.lastError = '';
        return;
      }
      this.linkRetryable = s.reason !== 'engine-exited';
      // 还没核对出结论的在途写调用：如实说「不知道」，不猜、不重发。每个会话各说一句：是当前会话就进事件条，
      // 不是就寄存到用户切过去时（终态下换不了会话，手动重连成功之后才看得到）
      for (const sid of new Set(this.inDoubtPrompts.map(p => p.sessionId))) this.sessionNote(sid, '连接中断时有一条消息是否送达未知，请查看对话后再决定是否重发');
      for (const sid of new Set(this.inDoubtPerms.map(p => p.sessionId))) this.sessionNote(sid, '连接中断时有一次权限答复是否送达未知；对应操作是否执行以对话里的工具结果为准');
      this.inDoubtPrompts = []; this.inDoubtPerms = [];
    },
    /** 给某个会话留一句交代（在途写调用的核对结果）。是当前会话：进事件条。不是：按会话寄存，切过去时由 open() 放出来
     *  （见 _parkedNotes）。同一句话对同一个会话只留一份。 */
    sessionNote(sid: string, short: string, o: { requestId?: string } = {}) {
      if (sid === this.activeId) { this.linkNote(short); return; }
      // 已消失的会话不寄存：没有人会切过去看；同一个 id 日后被带回来时，也不该带着一句删除之前的旧话
      if (!sid || this.goneSessions.includes(sid)) return;
      const rest = (_parkedNotes.get(sid) ?? []).filter(n => n.short !== short);
      _parkedNotes.set(sid, [...rest, { short, ...(o.requestId ? { requestId: o.requestId } : {}) }].slice(-5));
    },
    /** 把寄存给这个会话的交代放进事件条（open() 取完历史之后调）。带 requestId 的只在那张卡仍待批时才说。 */
    flushParked(sid: string) {
      const list = _parkedNotes.get(sid);
      if (!list) return;
      _parkedNotes.delete(sid);
      for (const n of list) if (n.requestId === undefined || this.pendingPerms.some(p => p.requestId === n.requestId)) this.linkNote(n.short);
    },
    /** 当前会话有一条核对出「没有送达」的消息：气泡不在对话流里就接回末尾，带重试钮的那句说明不在事件条里就补上。幂等。
     *  三处调：核对出结论的那一刻（settleInDoubt）；open() 取完历史之后——出结论时用户在看别的会话的话，气泡早被换掉、
     *  事件条也写不进去，回到这个会话时消息就像凭空没了，重试入口也没有；同会话重取历史同样会把气泡换掉；
     *  send() 被引擎拒绝之后——它开头摘掉了记录与气泡、清了事件条，那次发送既然没有发生，就原样放回。
     *  这里重建是安全的：undelivered 只在核对出「引擎没有接收」之后才有、下一次在这个会话发送时清掉（被拒则放回）；
     *  万一那一帧其实晚到了，重试沿用原 promptId，引擎回 duplicate，气泡随即被摘掉（noteSubmitted）。 */
    showUndelivered() {
      const u = this.undelivered;
      if (!u || !this.activeId || u.sessionId !== this.activeId) return;
      if (!this.messages.some(m => m.id === u.optimisticId)) this.messages = [...this.messages, undeliveredBubble(u)];
      if (!this.eventNotes.some(n => n.short === UNDELIVERED_NOTE)) this.linkNote(UNDELIVERED_NOTE, { retryable: true, ...(u.error ? { detail: u.error } : {}) });
    },
    /** 终态横幅上的「重新连接」：引擎还活着而自动重连用尽时，不必重启整个应用。 */
    retryConnection() {
      if (typeof (rpc as any).retryNow === 'function') rpc.retryNow();
    },
    /**
     * 晚到的 run 事件要不要应用。返回 false 即整条丢弃（不进 trackRun / onEvent）：
     *  - 已消失的会话（删除后晚到的事件）；
     *  - 别的引擎代次的 run；
     *  - 比本窗口跟踪的那次更早的 run，或同一次 run 的终止事件之后才到的事件（取消后晚到的增量）。
     * 没有 run 字段的事件照旧应用（旧引擎、既有用例的事件形态）。
     */
    acceptRunEvent(sessionId: string, e: any, run?: { id?: unknown; generation?: unknown; epoch?: unknown }): boolean {
      if (this.goneSessions.includes(sessionId)) return false;
      if (!run || typeof run.generation !== 'number') return true;
      if (this.engineEpoch !== 0 && run.epoch !== this.engineEpoch) return false;
      const t = this.runOf[sessionId];
      if (t && (run.generation < t.generation || (run.generation === t.generation && t.ended))) return false;
      if (!t || run.generation > t.generation) {
        this.runOf[sessionId] = { runId: String(run.id ?? ''), generation: run.generation, ended: false };
        // 别处起跑的那次 run 发出了第一条事件：它已经在跑，不用再探测
        if (this.pendingStarts[sessionId]) delete this.pendingStarts[sessionId];
      }
      if (e?.kind === 'turnEnd' || e?.kind === 'error') this.runOf[sessionId].ended = true;
      return true;
    },
    /** 把一张待批卡装进来（快照、续传校正共用）：字段映射走 permission.request 处理器本身（_permIn），
     *  只把倒计时改成按引擎给的剩余时间算——回放与快照到达的时刻晚于发卡，按 timeoutMs 从现在起算会偏长。 */
    adoptPerm(v: PendingPermissionView) {
      _permIn?.({ requestId: v.requestId, req: v.req, meta: v.meta });
      const card = this.pendingPerms.find(x => x.requestId === v.requestId);
      if (card && typeof v.remainingMs === 'number') card.deadlineMs = Date.now() + v.remainingMs;
    },
    /**
     * 按应答里的 runs（快照或续传，lastSeq 时刻的权威值）校正运行集合、pendingStarts、runOf，并对已结束的那次 run 收口。
     *
     * 运行集合 = { 本代次 running 的会话 } ∪ ( 原集合 ∩ { starting 的会话 } ) ∪ { 有未落定提交的会话 }。
     *  - starting 只在本窗口已经认为它在跑时才保留：起跑前失败没有事件，别的窗口不能凭一份快照把它点亮
     *    （点亮了就再也灭不掉）。别处的 starting 记进 pendingStarts，由探测跟到它变成 running。
     *  - 本窗口自己刚发出、结果未定的会话不由这里摘：attach 可能先于 chat.prompt 到达引擎，也可能那次提交根本没送达；
     *    这两类只由 send() 的 catch 或核对结果摘。
     */
    reconcileRuns(runs: RunView[], epoch: number, epochChanged: boolean) {
      const mine = runs.filter(r => r.epoch === epoch);
      const set = new Set<string>();
      for (const r of mine) {
        if (r.state === 'running') set.add(r.sessionId);
        else if (r.state === 'starting' && this.runningSessions.includes(r.sessionId)) set.add(r.sessionId);
      }
      for (const v of _sending.values()) set.add(v.sessionId);
      for (const p of this.inDoubtPrompts) set.add(p.sessionId);
      const next = [...this.runningSessions.filter(id => set.has(id)), ...[...set].filter(id => !this.runningSessions.includes(id))];
      const now = Date.now();
      const starts: Record<string, { runId: string; since: number }> = {};
      for (const r of mine) {
        if (r.state !== 'starting' || set.has(r.sessionId)) continue;
        const prev = this.pendingStarts[r.sessionId];
        starts[r.sessionId] = { runId: r.runId, since: prev && prev.runId === r.runId ? prev.since : now };
      }
      this.runningSessions = next;
      this.pendingStarts = starts;
      // 收口：只对本窗口正跟踪着（ended:false）的那一次 run。从不拿「该会话最近一次 run」来交代——
      // 提交没送达时那是更早的一次 run，照它说话会凭空多一条旧的错误条
      for (const sid of Object.keys(this.runOf)) {
        const t = this.runOf[sid];
        if (t.ended || this.hasUnsettled(sid)) continue;
        const view = runs.find(r => r.runId === t.runId);
        if (!view) { t.ended = true; continue; }            // 应答只列活动 run 与所带会话的最近一次 run：不在里面 = 已结束，不留条
        if (!RUN_ACTIVE(view.state)) this.concludeRun(view);
      }
      if (epochChanged) this.runOf = {};
      for (const r of mine) {
        const t = this.runOf[r.sessionId];
        if (RUN_ACTIVE(r.state)) {
          // 没点亮的 starting（别处起跑）不算本窗口在跟踪：它起跑失败时不该由本窗口交代
          if (set.has(r.sessionId) && !(t && t.runId === r.runId)) this.runOf[r.sessionId] = { runId: r.runId, generation: r.generation, ended: false };
        } else if (!t || r.generation >= t.generation) {
          // 这次 run 就是本窗口那条结果待核对的提交：它的结局留给核对结果去交代（settleInDoubt → concludeRun）。
          // 在这里先记成已结束的话，核对时会被当成「终止事件已经处理过」，失败 / 被中断的那一句就没有人说了
          if (r.promptId && this.inDoubtPrompts.some(p => p.promptId === r.promptId)) continue;
          if (!(t && t.runId === r.runId && t.ended)) this.runOf[r.sessionId] = { runId: r.runId, generation: r.generation, ended: true };
        }
      }
    },
    /**
     * 收口：一次 run 已是终态而本窗口没有收到（或不会收到）它的终止事件。只有两处调：reconcileRuns 里正跟踪着、
     * 应答里已是终态的那一次；核对出「已接收且已结束」的提交。同一次 run 至多交代一次。
     */
    concludeRun(run: RunView) {
      const t = this.runOf[run.sessionId];
      if (t && t.runId === run.runId && t.ended) return;
      if (t && run.generation < t.generation) return;
      this.runOf[run.sessionId] = { runId: run.runId, generation: run.generation, ended: true };
      if (!this.hasUnsettled(run.sessionId)) this.runningSessions = this.runningSessions.filter(x => x !== run.sessionId);
      if (run.sessionId !== this.activeId) return;
      this.running = false; this.midRun = false; this.joinedTail = false; this.retryNote = '';
      this.streamingText = ''; this.streamingThinking = ''; this.toolCards = [];
      _tailCut = null;
      _reloadWanted = true; // 历史交给 afterSync 重取；这一轮的快照已经换过历史时它会跳过
      if (run.state === 'completed') { if (run.stopReason) this.lastStopReason = String(run.stopReason); }
      else if (run.state === 'failed') {
        // 与 error 事件的分流同一口径（onEvent 的 error 分支）：账本里 failed 的 stopReason 就是那条 error 事件的 code。
        // 上下文已满、思考块绑定、能力不符、请求放不下——原样重发结果一样，不给重试；其余给。短句按 code 选，
        // 不让 EventNotes 对原始报文跑状态码正则。只在这次 run 落过 user 消息时给重试：起跑前失败（start-failed）没有落消息，
        // retryLast 会重发更早的一条。接力草稿（contextFull 的 relayDraft）随事件走、账本里没有，这条路补不回接力钮
        const detail = String(run.stopDetail || run.stopReason || '运行失败');
        const code = run.stopReason;
        const short = errorShortByCode(code);
        const noRetry = code === 'contextFull' || code === 'thinkingBinding' || code === 'capability' || code === 'requestBudget';
        this.lastError = detail;
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail, retryable: !noRetry && !!run.userMessageId, ...(short ? { short } : {}) }];
      } else if (run.state === 'interrupted') {
        this.linkNote('后台服务已重启，上一次运行被中断，没有自动续跑；没有保存的输出已丢失');
      }
      // cancelled：不说话（停止是用户点的；关停取消时重建说明已经在）
    },
    /** 运行标记的兜底摘除（幂等）：这个会话没有未落定的提交、本窗口跟踪的那次 run 也已经结束，就不该还标着在跑。
     *  为什么需要：核对期间的校正会因为「有未落定提交」把会话并回运行集合（reconcileRuns），而那次 run 的终止事件
     *  可能早已在回放里处理过——concludeRun 见它处理过就提前返回（不说第二遍），也可能本窗口跟踪的已是更晚的一次 run；
     *  两种情形都走不到 concludeRun 里的摘除。未落定提交只由核对结果摘，所以核对出「已接收且已结束」之后在这里收尾。 */
    dropRunMark(sid: string) {
      if (this.hasUnsettled(sid)) return;
      const t = this.runOf[sid];
      if (t && !t.ended) return; // 更晚的一次 run 还在跑：标记归它
      if (this.runningSessions.includes(sid)) this.runningSessions = this.runningSessions.filter(x => x !== sid);
      if (sid === this.activeId && this.running) { this.running = false; this.midRun = false; this.joinedTail = false; }
    },
    /** 替换历史之前，从旧 messages 里取出这个会话还要留着的乐观气泡：仍在途、等核对、或就是「没有送达」的那一条。
     *  手里有 runs 时再去掉已经有真实消息的（同 promptId 的 run 带 userMessageId = 那条消息已在历史里）。 */
    optimisticToKeep(runs?: RunView[]): UiMessage[] {
      const ids = new Map<string, string>();
      for (const [oid, v] of _sending) if (v.sessionId === this.activeId) ids.set(oid, v.promptId);
      for (const p of this.inDoubtPrompts) if (p.sessionId === this.activeId) ids.set(p.optimisticId, p.promptId);
      if (this.undelivered && this.undelivered.sessionId === this.activeId) ids.set(this.undelivered.optimisticId, this.undelivered.promptId);
      if (ids.size === 0) return [];
      return this.messages.filter(m => ids.has(m.id) && !(runs ?? []).some(r => r.promptId === ids.get(m.id) && r.userMessageId));
    },
    /**
     * 用快照重建（rpc 的 applySnapshot 钩子）。同步、不发调用：返回之后 rpc 才放行水位之后的事件。
     * 快照覆盖的域：会话列表、运行集合、待批卡、所带会话的历史与流式尾巴；其余的域由 afterSync 重取。
     * connection 不在这里改（重连时由 onLinkStatus('open') 在开闸那一刻置回）。
     */
    applySnapshot(snap: StateSnapshot, info: { reason: SnapshotReason; cause: SyncCause; epochChanged: boolean }) {
      this.inputsOn = snap.inputs !== undefined;this.adoptInputs(snap.inputs ?? []);
      const wasBusy = this.runningSessions.length > 0 || this.pendingPerms.length > 0;
      this.engineEpoch = snap.epoch; this.streamRevision = snap.revision; this.syncOn = true;
      const before = this.sessions;
      this.sessions = snap.sessions as typeof this.sessions;
      this.noteSessionsChanged(before);
      this.reconcileRuns(snap.runs, snap.epoch, info.epochChanged);
      // 待批卡整体替换：同一个 requestId 重新出现（这条连接已被登记，可以答复）；断线期间了结的卡直接消失
      this.pendingPerms = [];
      for (const v of snap.pendingPermissions) this.adoptPerm(v);
      _snapSession = '';
      const ss = snap.session;
      if (ss && this.activeId && ss.sessionId === this.activeId) {
        _snapSession = this.activeId;
        if (!ss.exists) this.dropToWelcome();
        else {
          // 作废在途的历史重取：这份历史比它们新
          _histTicket += 1; _tailCut = null;
          const keep = this.optimisticToKeep(snap.runs);
          this.messages = [...(ss.messages as unknown as UiMessage[]), ...keep]; _histOf = this.activeId;
          this.toolCards = []; this.retryNote = '';
          if (this.runningSessions.includes(this.activeId)) {
            // 历史 + 尾巴：历史里是这次 run 已落库的消息，实时区只放最近一次落库之后已发布的正文与思考
            this.running = true;
            const run = snap.runs.find(r => r.sessionId === this.activeId && r.epoch === snap.epoch && RUN_ACTIVE(r.state));
            const live = run ? snap.live.find(l => l.runId === run.runId) : undefined;
            if (live?.truncated) { this.midRun = true; this.streamingText = ''; this.streamingThinking = ''; this.joinedTail = false; }
            else { this.streamingText = live?.text ?? ''; this.streamingThinking = live?.thinking ?? ''; this.midRun = false; this.joinedTail = true; }
            const off = run ? snap.artifacts.filter(a => a.runId === run.runId && a.offloadPath) : [];
            this.offloadedState = off.length ? { count: off.length, lastRelativePath: off[off.length - 1].offloadPath } : null;
          } else {
            // 不在跑：历史已是权威的，缓冲无条件清空（activeId 换过而缓冲还是上一个会话的，也在这里清掉）
            this.running = false; this.midRun = false; this.joinedTail = false;
            this.streamingText = ''; this.streamingThinking = '';
          }
        }
      }
      if (info.epochChanged && wasBusy && this.activeId) this.linkNote('后台服务已重新启动，界面已按最新状态重建');
      // 无条件收尾（快照没带当前会话时也要算）
      const was = this.running;
      this.running = this.activeId !== '' && this.runningSessions.includes(this.activeId);
      if (was && !this.running) { this.midRun = false; this.joinedTail = false; if (_snapSession !== this.activeId) _reloadWanted = true; }
      else if (!was && this.running) { this.midRun = true; _reloadWanted = true; }
    },
    /** 续传的事件已经按序走过各处理器，再用应答里的权威值校正（rpc 的 resumed 钩子）。同步。 */
    reconcileResume(r: Extract<AttachResult, { mode: 'resume' }>) {
      if (r.inputs !== undefined) {this.inputsOn = true;this.adoptInputs(r.inputs);}
      // 待批卡：只留应答里还在的；缺的补上；倒计时按剩余时间重算（回放的 permission.request 是按回放时刻起算的，偏长）
      const ids = new Set(r.pendingPermissions.map(v => v.requestId));
      if (this.pendingPerms.some(p => !ids.has(p.requestId))) this.pendingPerms = this.pendingPerms.filter(p => ids.has(p.requestId));
      for (const v of r.pendingPermissions) this.adoptPerm(v);
      this.reconcileRuns(r.runs, r.epoch, false);
      const was = this.running;
      this.running = this.activeId !== '' && this.runningSessions.includes(this.activeId);
      // 回放里没有它的终止事件却已不在跑 / 这次应答才认出当前会话在跑：历史要重取
      if (was && !this.running) { this.midRun = false; this.joinedTail = false; _reloadWanted = true; }
      else if (!was && this.running) { this.midRun = true; _reloadWanted = true; }
      this.engineEpoch = r.epoch; _snapSession = '';
    },
    /** 接上在跑的回合：取一份带当前会话的快照（历史 + 尾巴经 applySnapshot 装进来）。旧引擎不做；取不到就保持占位。 */
    async joinRun() {
      if (!this.syncOn || typeof (rpc as any).resync !== 'function') return;
      try { await rpc.resync('join'); } catch { /* 保持占位；断线的话重连后的同步会重取 */ }
    },
    /**
     * 重取当前会话：把历史、尾巴、运行态一次换成引擎此刻的样子。调用点只有 afterSync（与核对结果、重复提交）。
     * 走快照而不走 open()：历史、尾巴、缓冲、乐观气泡在 applySnapshot 里一次换完，没有「历史已换、缓冲刚清、尾巴还没到」的一拍；
     * 在跑与不在跑是同一条路。它修正的状态：断线期间结束的回合（历史停在断线前）；换会话的 open() 在途时断线留下的
     * 「activeId 已换、对话流还是上一个会话的」；校正时才发现当前会话在跑或已不在跑。
     */
    async reloadActive() {
      const id = this.activeId;
      if (!id) return;
      if (this.syncOn && typeof (rpc as any).resync === 'function') {
        _snapSession = ''; // 只认这一次取回来的快照
        try { await rpc.resync('join'); } catch { /* 落到兜底 */ }
        if (this.activeId !== id || _snapSession === id) return;
      }
      if (this.connection !== 'ok' || this.activeId !== id) return;
      // 兜底：open() 整体替换 messages，先把还没落定的乐观气泡留出来再接回去
      const keep = this.optimisticToKeep();
      try {
        await this.open(id);
        if (this.activeId === id && keep.length) this.messages = [...this.messages, ...keep.filter(k => !this.messages.some(m => m.id === k.id))];
      } catch { /* 留给下一次同步 */ }
    },
    /**
     * 尾巴模式下一条消息落库了（messagePersisted）：重取历史，并把缓冲里已经落库的那一段切掉。不闪、不重复：
     * 应答到达之前界面是「旧历史 + 完整缓冲」，之后是「新历史 + 切剩的缓冲」，任何时刻同一段文字只出现一次。
     * 只认最新一次：这之间又落了一条消息的话，它的事件帧排在这次应答之前到达，会发起更新的一次重取，本次应答丢弃。
     */
    async refreshJoinedHistory() {
      const id = this.activeId;
      const ticket = ++_histTicket;
      // 事件到达这一刻，缓冲里的全部内容刚落库
      _tailCut = { text: this.streamingText.length, thinking: this.streamingThinking.length };
      let msgs: UiMessage[];
      const hq = historyQuery(id, this.messages); // Q14：能续取就只取增量
      try { msgs = hq.merge(await rpc.call('chat.messages.list', hq.params)); } catch { return; }
      if (ticket !== _histTicket || this.activeId !== id || !this.joinedTail) return;
      const cut = _tailCut ?? { text: 0, thinking: 0 };
      this.messages = [...msgs, ...this.optimisticToKeep().filter(k => !msgs.some(m => m.id === k.id))]; _histOf = id;
      this.streamingText = this.streamingText.slice(cut.text);
      this.streamingThinking = this.streamingThinking.slice(cut.thinking);
      _tailCut = null;
    },
    /** 快照没覆盖、也可能没有事件的域整体重取（重连之后、走了快照的补洞之后、join 的水位之前有帧没到齐时）。
     *  逐项兜住，自身不抛。 */
    async refreshAll() {
      const safe = async (f: () => Promise<unknown>): Promise<void> => { try { await f(); } catch { /* 逐项兜住：一项失败不拦别的 */ } };
      const imp = this.skillImport;
      // 自己取数的组件（F08 的「改动」清单与审阅面板）跟着重取：见 refreshTick
      this.refreshTick += 1;
      await Promise.all([
        // F11B：保留副本列表靠 chat.sessions.lifecycle 重拉，那条广播丢在断线里时快照带不回来
        safe(() => this.refreshRetained()),
        safe(() => this.refreshProviders()),
        safe(() => this.refreshModelGroups()),
        safe(() => this.refreshAssistants()),
        safe(() => this.refreshAllSkills()),
        safe(() => this.refreshSkills()),
        safe(() => this.refreshCronJobs()),
        safe(() => this.refreshSyncPaused()),
        safe(async () => {
          const preset = await rpc.call('permission.getPreset');
          if (preset && (preset.preset === 'ask' || preset.preset === 'session' || preset.preset === 'plan' || preset.preset === 'full')) this.permTier = preset.preset;
        }),
        safe(() => this.refreshAnnotations()),
        safe(() => this.refreshAttachments()),
        safe(() => this.refreshWorkspace()),
        safe(() => this.fetchContextInfo()),
        // 导入的终态帧可能正好丢在断线里
        ...(imp && imp.state === 'running' ? [safe(() => this.pollSkillImport(imp.taskId))] : []),
      ]);
    },
    /**
     * 一轮同步完成（rpc 的 synced 钩子；重连时一定在开闸之后，里面的调用都发得出去）。整体兜住，不抛未处理的拒绝。
     *  1. 重连之后一律 refreshAll()（不分续传还是快照：没有广播的域不会被回放带回来）并重取当前会话
     *     （不依赖回放帧处理器的副作用）；
     *  2. 核对断线时在途的发送与权限答复（state.outcomes）——只查询，**从不重发**；
     *  3. 其余结果未知的写调用如实说明。
     */
    async afterSync(info: SyncInfo) {
      try {
        const reconnected = info.cause === 'reconnect' || info.cause === 'retry';
        if (reconnected) this.linkGeneration += 1;
        let all: Promise<void> | undefined;
        if (reconnected || info.missed || (info.via === 'snapshot' && (info.cause === 'gap' || info.cause === 'foreign' || info.cause === 'probe'))) {
          all = this.refreshAll(); // 当场发起、不等它：重取当前会话不排在十几个往返后面
        }
        if (info.via === 'resume' && info.revision !== this.streamRevision) {
          // 别的窗口做过不广播的改动（建会话、改绑定）
          this.streamRevision = info.revision;
          try { await this.refreshSessions(); } catch { /* 下一次同步再取 */ }
        }
        const wanted = _reloadWanted;
        _reloadWanted = false;
        if ((reconnected || wanted) && this.activeId && _snapSession !== this.activeId) await this.reloadActive();
        await this.settleInDoubt();
        const others = info.inDoubt.filter(c => isWriteMethod(c.method) && c.method !== 'chat.prompt' && c.method !== 'permission.respond' && c.method !== 'chat.input.send');
        if (others.length > 0) {
          if (all) await all; // 「已按当前状态刷新」要成立
          const msg = `连接中断时有 ${others.length} 个操作的结果未知，界面已按当前状态刷新，请核对后再决定是否重做`;
          if (this.activeId) this.linkNote(msg); else this.lastError = msg;
        }
        if (all) await all;
      } catch { /* 兜住：留给下一次同步 */ }
    },
    /** 核对断线时在途的发送与权限答复。条目有了结论才摘（核对期间到达的快照靠它们保住运行标记与气泡）；
     *  查询本身失败（又断了）条目留着，下次同步后再核对。 */
    async settleInDoubt() {
      await this.settleInputsInDoubt();
      const prompts = this.inDoubtPrompts.filter(p => !_checking.has('p:' + p.promptId));
      const perms: { requestId: string; sessionId: string }[] = [];
      for (const p of this.inDoubtPerms) {
        if (_checking.has('m:' + p.requestId)) continue;
        if (this.pendingPerms.some(x => x.requestId === p.requestId)) {
          // 卡又出现了：答复没有送达。卡已重新显示，由用户再选一次
          this.inDoubtPerms = this.inDoubtPerms.filter(x => x.requestId !== p.requestId);
          this.sessionNote(p.sessionId, '连接中断时你的选择没有送达，请重新选择', { requestId: p.requestId });
        } else perms.push(p);
      }
      if (prompts.length === 0 && perms.length === 0) return;
      const refs: WriteRef[] = [
        ...prompts.map(p => ({ kind: 'prompt' as const, sessionId: p.sessionId, promptId: p.promptId })),
        ...perms.map(p => ({ kind: 'permission' as const, requestId: p.requestId })),
      ];
      const keys = [...prompts.map(p => 'p:' + p.promptId), ...perms.map(p => 'm:' + p.requestId)];
      for (const k of keys) _checking.add(k);
      let res: OutcomesResult;
      try { res = await rpc.call<OutcomesResult>('state.outcomes', { refs }); }
      catch { return; }
      finally { for (const k of keys) _checking.delete(k); }
      for (const o of Array.isArray(res?.outcomes) ? res.outcomes : []) {
        if (o.kind === 'prompt') {
          const p = prompts.find(x => x.promptId === o.promptId && x.sessionId === o.sessionId);
          if (!p) continue;
          this.inDoubtPrompts = this.inDoubtPrompts.filter(x => x.promptId !== p.promptId);
          // 查询挂着的这段时间里会话消失了（被删，本机或别的设备）：条目已由 markGone 放下，这条结论没有地方交代。
          // 不记 run、不留「没有送达」；校正期间可能因为这条提交被并回去的运行标记在这里摘掉
          if (this.goneSessions.includes(p.sessionId)) {
            if (!this.hasUnsettled(p.sessionId)) this.runningSessions = this.runningSessions.filter(x => x !== p.sessionId);
            continue;
          }
          if (o.status === 'accepted') {
            // 这条消息已被接收，不做任何发送。真实消息在历史里：摘掉乐观的那条，重取（仍在跑则带着尾巴）
            if (RUN_ACTIVE(o.run.state)) {
              const t = this.runOf[p.sessionId];
              if (!t || o.run.generation >= t.generation) this.runOf[p.sessionId] = { runId: o.run.runId, generation: o.run.generation, ended: false };
              if (!this.runningSessions.includes(p.sessionId)) this.runningSessions = [...this.runningSessions, p.sessionId];
            } else {
              // 已接收且已结束。收口之后再兜底摘一次运行标记：终止事件已在回放里处理过（或本窗口跟踪的已是更晚的一次 run）时
              // concludeRun 提前返回，而校正刚因为这条未落定的提交把会话并回了运行集合——不摘的话它一直标着在跑
              this.concludeRun(o.run);
              this.dropRunMark(p.sessionId);
            }
            if (p.sessionId === this.activeId) {
              this.messages = this.messages.filter(m => m.id !== p.optimisticId);
              await this.reloadActive();
            }
          } else {
            // 没有被接收（没送达，或起跑前失败）。不重取历史、不收口、**不自动重发**：气泡留在原处，给一个重试入口
            const t = this.runOf[p.sessionId];
            if (!(t && !t.ended)) {
              this.runningSessions = this.runningSessions.filter(x => x !== p.sessionId);
              if (p.sessionId === this.activeId) { this.running = false; this.midRun = false; }
            }
            this.undelivered = o.error ? { ...p, error: o.error } : p;
            // 是当前会话：当场交代（气泡在就不动，不在就接回；带重试钮的说明）。不是：留着 undelivered，
            // 用户切回那个会话时由 open() 补上——那时气泡早已随 messages 换掉，不补的话消息就像凭空没了
            this.showUndelivered();
          }
        } else if (o.kind === 'permission') {
          const p = perms.find(x => x.requestId === o.requestId);
          if (!p) continue;
          this.inDoubtPerms = this.inDoubtPerms.filter(x => x.requestId !== p.requestId);
          // 留条写给卡所属的会话：是当前会话就进事件条，不是就寄存到用户切过去时（sessionNote）——用户点完就切走的话，
          // 这次答复的结局不能只因为他此刻在看别的会话就不交代
          if (o.status === 'settled') this.sessionNote(p.sessionId, permOutcomeNote(o));
          else if (o.status === 'pending') this.sessionNote(p.sessionId, '连接中断时你的选择没有送达，请重新选择', { requestId: p.requestId });
          else this.sessionNote(p.sessionId, '这次权限答复的结果未知；对应操作是否执行以对话里的工具结果为准');
        }
      }
    },
    /** W2b-3：断线横幅的「重启应用」。重启整个应用（设计稿 §2「生命周期」）：渲染端的 rpc 不重连、没有代次（W6），
     *  只重启引擎的话界面状态与新引擎对不上。桥的访问形态与 pickWorkspaceFolder 相同；走不通就说清楚出路——
     *  横幅的按钮不接 catch，这里不能往外抛。 */
    async relaunchApp() {
      const b = (window as any).deskminis;
      if (typeof b?.relaunchApp !== 'function') {
        this.lastError = '无法自动重启，请手动退出并重新打开 DeskMinis';
        return;
      }
      try { await b.relaunchApp(); }
      catch (e) { this.lastError = `无法自动重启（${errText(e)}），请手动退出并重新打开 DeskMinis`; }
    },
    /** W2b-1：按会话维护运行集合。chat.event 处理器在按 activeId 过滤之前调，非当前会话的事件同样记账。
     *  回合的终止事件只有 turnEnd 与 error（loop.ts；run IIFE 的 catch 也发 error），其余任何回合事件都说明它还在跑。
     *  synced 不是回合事件，处理器在前面已经分流，到不了这里。 */
    trackRun(sessionId: string, e: any) {
      if (typeof sessionId !== 'string' || !sessionId || typeof e?.kind !== 'string') return;
      if (e.kind === 'turnEnd' || e.kind === 'error') {
        if (this.runningSessions.includes(sessionId)) this.runningSessions = this.runningSessions.filter(x => x !== sessionId);
        return;
      }
      if (!this.runningSessions.includes(sessionId)) this.runningSessions = [...this.runningSessions, sessionId];
      // 当前会话收到回合中途的事件、本窗口却以为它没在跑（渲染端重载后，或回合不是本窗口发起的）：
      // 同样是从中途接上——停止键要出来，流式区打占位，否则发送键亮着、按下去撞「该会话正在运行中」
      if (sessionId === this.activeId && !this.running) {
        this.running = true; this.midRun = true;
        // F06：占位只显示到快照装完为止——取一份带会话的快照，把历史与已流出的尾巴接上（旧引擎不做，保持占位）
        void this.joinRun();
      }
    },
    onEvent(e: any) {
      if (e.kind === 'textDelta') { this.retryNote = ''; this.streamingText += e.text; }
      // 思考流与正文分开累积：ThinkingBlock 折叠块渲染它，不进 Markdown 正文。
      // 不清 retryNote——retryNote 的既有契约是「下一个 textDelta / turnEnd 清掉」，不扩界。
      else if (e.kind === 'thinkingDelta') this.streamingThinking += e.text;
      // F06 尾巴模式（经快照接上的回合）：不建步骤卡——带工具调用的 assistant 消息先于 toolStart 落库，
      // 历史里那个 toolUse 按既有判定画成「结果还没到」（lib/steps/live）；再建一张卡就是同一步显示两遍
      else if (e.kind === 'toolStart' && this.joinedTail) { /* 见上 */ }
      // F06 尾巴模式：一条消息落库了——重取历史，并把缓冲里已落库的那一段切掉。普通模式不消费这个事件（与以前相同）
      else if (e.kind === 'messagePersisted') { if (this.joinedTail) void this.refreshJoinedHistory(); }
      else if (e.kind === 'toolStart') this.toolCards.push({ toolUseId: e.toolUseId, name: e.name, title: e.title, startedAt: Date.now(), input: e.input });
      else if (e.kind === 'toolEnd') { const c = this.toolCards.find(x => x.toolUseId === e.toolUseId); if (c) { c.output = e.output; c.success = e.success; c.endedAt = Date.now(); } }
      else if (e.kind === 'retry') {
        // 循环会整回合重来，已缓冲的半截文本是过期的（不清就会和重试后的正文拼在一起）
        this.streamingText = '';
        // 思考缓冲同理：重试会重新推理，旧半截思考留着会拼进新思考
        this.streamingThinking = '';
        if (_tailCut) _tailCut = { text: 0, thinking: 0 }; // F06：缓冲清了，在途的历史重取不能再按旧长度切
        this.retryNote = `正在重试…（第 ${e.attempt} 次，${Math.round((e.delayMs ?? 0) / 1000)}s 后）`;
        // retryNote 的既有清空时机决定是否仍在等待；事件保留原延迟与接收时间供界面读秒。
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'retry', ts: Date.now(), detail: `第 ${e.attempt} 次，${Math.round((e.delayMs ?? 0) / 1000)}s 后`, retry: { attempt: e.attempt, delayMs: e.delayMs ?? 0 } }];
      }
      else if (e.kind === 'turnEnd') {
        this.retryNote = ''; this.running = false;
        // 思考已随消息落库（reasoningContent），历史块会接管渲染；
        // 这里同步清缓冲——open() 重取是异步的，残值会与历史块短暂并存
        this.streamingThinking = '';
        // W2b-1：中途接上的回合，缓冲里只有切回之后的半截——open() 重取完整历史是异步的，
        // 不在这里同步丢掉的话，占位撤下到历史到达之间会闪出从句子中间开始的半截文字
        if (this.midRun) { this.streamingText = ''; this.toolCards = []; this.midRun = false; }
        this.joinedTail = false; _tailCut = null; // F06：回合结束，尾巴模式随之结束（下面的 open() 重取完整历史）
        if (e.stopReason) this.lastStopReason = String(e.stopReason);
        // F02：以截断收尾时引擎带上这次的 max_tokens、它为什么是这个数、已续写几次；其它收尾清掉上一回合留下的
        this.lastOutputLimit = readOutputLimit(e.outputLimit);
        // F03：回合结束时恢复说明还停在「正在重发」= 那次重发没有完成（正常路径上 recovered 先于 turnEnd 到达，走不到这里）
        this.settleStuckRecovery();
        void this.open(this.activeId);
        void this.fetchContextInfo();
      }
      else if (e.kind === 'error') {
        // 先记错误再刷新：open 在同会话路径上不动 lastError，横幅得以留在界面上
        const detail = String(e.message ?? '未知错误');
        this.lastError = detail;
        this.retryNote = '';
        this.streamingThinking = ''; // 回合已败，半截思考没有下文，留着只会悬在界面上
        this.running = false;
        // F03：重发被取消或以别的错误收尾——恢复卡收起，那条事件条留着并改说「这次重发没有完成」
        this.settleStuckRecovery();
        if (this.midRun) { this.streamingText = ''; this.toolCards = []; this.midRun = false; } // 同 turnEnd：半截不闪出来
        this.joinedTail = false; _tailCut = null; // F06：同 turnEnd
        // W2a-6：按引擎给的 code 分流（设计稿 §3 第 2、3 条），不靠文案判断。短句也按 code 在 copy.ts 里选好随条带上，
        // 不让 EventNotes 对原始报文跑状态码正则（绑定错误的响应体里一个独立的 5xx 就会被说成「服务暂时不可用」）。
        if (e.code === 'contextFull') {
          // 上下文已满：原地重试必然再满，不给重试；给「新建会话接力」。草稿先存 relaySource，点了钮才交给新会话
          const draft = typeof e.relayDraft === 'string' ? e.relayDraft : '';
          this.relaySource = draft ? { sessionId: this.activeId, text: draft } : null;
          this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail, retryable: false, relay: !!draft, short: errorShortByCode(e.code) }];
        } else if (e.code === 'thinkingBinding' || e.code === 'capability' || e.code === 'requestBudget') {
          // 思考块绑定：绑定的是这段对话的历史，原样重发必然同样 400，不给重试（message 里已写明请新建会话）。
          // F01 capability：链上没有能接这一轮的模型（不输出文本、本轮带图而都不收图片），原样重试结果一样，不给重试；出路在 message 里。
          // F02 requestBudget：系统提示与工具定义占满了输入上限，原样重试结果一样，新建会话接力也解决不了——不给重试、不给接力钮
          this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail, retryable: false, short: errorShortByCode(e.code) }];
        } else if (e.code === 'outputLimit') {
          // F02 outputLimit：输出额度在产出正文之前就用完了（多为推理占用），是截断不是故障。短句按 code 给——
          // 交给 humanizeError 的话，详情里的 max_tokens 数字恰好是 5xx 样子时会被说成「服务暂时不可用」。
          // 留着重试钮：按详情里的出路改过之后（调低推理档位、填大最大输出、换模型，哪条适用由引擎按那次请求写明）重发有可能成
          this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail, retryable: true, short: errorShortByCode(e.code) }];
        } else {
          // MU2a Task 8：错误进对话流内联（EventNote 短句 + 详情折叠 + 重试钮），errbar 横幅退场
          this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail, retryable: true }];
        }
        void this.open(this.activeId);
      }
      // M2d · #10：四种未消费事件（M2b 降级 / M2a 压缩 / M2a 卸载 / retry）——retry 分支已有，仅补其余三种并在任务面板挂状态。
      // 字段严格对齐 loop.ts 的 LoopEvent 联合类型，禁止用 ?? 0 / ?? '' 静默兜底掩盖缺失。
      else if (e.kind === 'fallback') {
        // 循环会切到备选模型重播，已缓冲的半截正文是过期的（不清就会和重播后的正文拼在一起）
        this.streamingText = '';
        // 与正文同款防拼接：备选模型重新推理，旧思考残值必须丢弃
        this.streamingThinking = '';
        if (_tailCut) _tailCut = { text: 0, thinking: 0 }; // F06：同 retry
        // loop.ts L19: { kind: 'fallback'; from: string; to: string; reason: string }
        this.fallbackState = { from: String(e.from), to: String(e.to), reason: String(e.reason) };
        // W2a-6：因超窗降级（cause:'contextOverflow'）时短句写明「因上下文已满改用 X」——换的是窗口更大、往往更贵的模型，
        // 回合跑通后会话还会改绑过去；通用的「已切换到备选模型」说不出这两件事。其它原因的降级不带 short，照旧
        const short = fallbackShortByCause(e.cause, String(e.to));
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'fallback', ts: Date.now(), detail: `${String(e.from)} → ${String(e.to)}（${String(e.reason)}）`, ...(short ? { short } : {}) }];
        void this.fetchContextInfo(); // 降级后上下文窗口可能变（小模型 → 小窗口）
      }
      else if (e.kind === 'compacted') {
        // loop.ts L20: { kind: 'compacted'; markerId: string; summary: string } —— summary 已由 loop 截取前 200 字符
        this.compactedState = { markerId: String(e.markerId), summary: String(e.summary) };
        this.compactionDetail = readCompactionView(e.detail); // F03：覆盖了多少条、因何触发、保留项计数（旧引擎不带 detail → null）
        const snippet = String(e.summary).slice(0, 30).replace(/\s+/g, ' ');
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'compacted', ts: Date.now(), detail: snippet ? `已压缩（摘要：${snippet}…）` : '已压缩' }];
        void this.fetchContextInfo(); // 压缩后用量减少
      }
      else if (e.kind === 'offloaded') {
        // loop.ts L21: { kind: 'offloaded'; toolUseId: string; relativePath: string } —— 每条大工具输出各发一次，非聚合；store 自行累计本会话计数
        const prev = this.offloadedState;
        const count = (prev?.count ?? 0) + 1;
        const lastRelativePath = String(e.relativePath);
        this.offloadedState = { count, lastRelativePath };
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'offloaded', ts: Date.now(), detail: `卸载工具输出 → ${lastRelativePath}` }];
        void this.fetchContextInfo();
      }
      else if (e.kind === 'contextRecovery') {
        // F03 loop.ts: { kind: 'contextRecovery'; view } —— 端点以超窗拒绝后在同一模型上的恢复，每条带这次事故的全量状态。
        const view = readRecoveryView(e.view);
        if (view) {
          // 决定重发：与 retry / fallback 同理，已缓冲的半截正文与思考是被拒那次的，不清就会和重发后的拼在一起
          if (view.phase === 'resending') { this.streamingText = ''; this.streamingThinking = ''; }
          this.contextRecoveryState = view;
          // 同一次事故只占一条事件条：后到的状态就地替换先到的，没有才追加
          const key = `cr${view.incident}`;
          const note = { kind: 'contextRecovery' as const, ts: Date.now(), detail: recoveryLines(view).join('\n'), short: recoveryShort(view), key };
          const at = this.eventNotes.findIndex(n => n.key === key);
          this.eventNotes = at >= 0 ? this.eventNotes.map((n, i) => (i === at ? note : n)) : [...this.eventNotes.slice(-9), note];
          void this.fetchContextInfo();
        }
      }
      else if (e.kind === 'pruned' && (e.level === 2 || e.level === 3)) {
        // F03 loop.ts: { kind: 'pruned'; count; level: 2 | 3; clipped } —— 被端点拒绝过的模型上更深的两级裁剪：
        // 保留的最近结果收到 4 条，仍然很大的结果只留头尾。同样只动请求，落库原文还在
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'pruned', ts: Date.now(), detail: prunedDetail(e) }];
        void this.fetchContextInfo();
      }
      else if (e.kind === 'pruned') {
        // loop.ts: { kind: 'pruned'; count: number } —— 本轮降水位只动了请求侧合成历史，落库原文还在；
        // 提示用户「已修剪」，并刷新水位让条回落（修剪后用量必然下降）
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'pruned', ts: Date.now(), detail: `已修剪 ${Number(e.count) || 0} 条历史工具结果` }];
        void this.fetchContextInfo();
      }
      else if (e.kind === 'compactFailed') {
        // loop.ts: { kind: 'compactFailed'; reason; message } —— 压缩失败不结束回合（本轮按原样继续，
        // 不碰 running / lastError、不给重试钮），但要说出来：旧实现把失败吞掉，用户看着水位贴顶却不知道压缩一直在失败。
        // message 是引擎给的中文说明（为空 / 被截断 / 被拒绝 / 请求失败附原始错误），原样进详情
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'compactFailed', ts: Date.now(), detail: String(e.message) }];
      }
      else if (e.kind === 'capability') {
        // F01 loop.ts: { kind: 'capability'; label; notices } —— 回合照常进行，但用了与用户意图不同的兼容处理
        // （跳过接不了这一轮的模型、历史图片或工具记录改以文字发送、推理档位调整）。不能静默：逐条进详情
        const notices = Array.isArray(e.notices) ? e.notices.map(String) : [];
        // F02：cause 是 'outputLimit' 时这条提示说的是输出被收紧的 max_tokens 截断，给专门的短句；
        // 没有 cause 时不带 short 键，与以前逐字段相同（通用短句）
        const short = capabilityShortByCause(e.cause);
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'capability', ts: Date.now(), detail: notices.join('\n') || String(e.label ?? ''), ...(short ? { short } : {}) }];
      }
    },
    async fetchContextInfo() {
      const activeId = this.activeId;
      if (!activeId) return;
      // 记下问的是哪个会话、这是第几次问：应答可能晚到。任务面板每 15 秒轮询一次，不少事件之后也各取一次——
      // 请求在途时换了会话，或发了新消息（send 里把序号往前拨了一格），这份应答说的就是别的会话、或上一次运行的事了
      const seq = ++contextInfoSeq;
      try {
        const info = await rpc.call('chat.contextInfo', { sessionId: activeId }) as ContextInfo;
        // 整条丢弃（做法同 refreshAttachments / refreshAnnotations）。恢复说明是「当前为空才写」的：晚到的应答把上一个会话
        // （或上一次运行）的说明写进来之后，之后的应答不带这一项就换不掉它，那张卡会一直挂到下一次发送
        if (this.activeId !== activeId) return;
        if (seq !== contextInfoSeq) return;
        this.contextInfo = info;
        // F03：压缩记录的摘录来自库（重开会话、重启后仍在），以应答为准——这个会话没有压缩记录时清掉；
        // 恢复说明来自引擎内存里最近的一份。
        // 「正在重发」只在运行中有意义：会话不在运行中时不显示（重发没有完成的，引擎收尾时已清）
        this.compactionDetail = readCompactionView(info.compaction);
        const recovery = readRecoveryView(info.recovery);
        if (recovery && (recovery.phase !== 'resending' || this.running) && !this.contextRecoveryState) this.contextRecoveryState = recovery;
      } catch { /* 水位 RPC 失败不影响主流程；缓存保持上一次值，任务面板显示「数据暂缺」 */ }
    },
    /** F03：回合已结束而恢复说明还停在「正在重发」——那次重发没有完成。恢复卡收起；事件条留着，短句改成没有完成。 */
    settleStuckRecovery() {
      const v = this.contextRecoveryState;
      if (v?.phase !== 'resending') return;
      const key = `cr${v.incident}`;
      this.eventNotes = this.eventNotes.map(n => (n.key === key ? { ...n, short: recoveryShort(v, { interrupted: true }) } : n));
      this.contextRecoveryState = null;
    },
    // MU2b Task 7：配对管理面四 actions——只消费既有 remote.status/pair.begin/unpair 三 RPC
    // （红线：不新增 RPC；remote.* 仅 local authMode 可调，渲染端 per-run token 连接天然满足）。
    async refreshDevices() {
      const r = await rpc.call('remote.status');
      this.devices = Array.isArray(r?.devices) ? r.devices : [];
      // F11C：配对方式与升级提示另存一份（不改 devices 的形状）。不认识的值一律按旧方式、不可升级
      const meta: Record<string, { pairingProtocol: 1 | 2; canUpgradePairing: boolean }> = {};
      for (const d of this.devices as Array<{ peerFingerprint: string; pairingProtocol?: unknown; canUpgradePairing?: unknown }>) {
        meta[d.peerFingerprint] = { pairingProtocol: d.pairingProtocol === 2 ? 2 : 1, canUpgradePairing: d.canUpgradePairing === true };
      }
      this.deviceMeta = meta;
      this.pairStatus = r?.pairing !== null && typeof r?.pairing === 'object' ? r.pairing as PairStatus : null;
      // F11B：这次应答是不是设备表。调用抛错时这一句执行不到，保持原值，由调用方在失败分支里另行处理
      this.devicesLoaded = Array.isArray(r?.devices);
    },
    async beginPairing() {
      const r = await rpc.call('remote.pair.begin');
      this.pairingSession = {
        code: String(r.pairingCode), myFingerprint: String(r.myFingerprint),
        expiresIn: Number(r.expiresIn), startedAt: Date.now(),
      };
      this.pairingMeta = { protocol: r.protocol === 2 ? 2 : 1, attempts: typeof r.attempts === 'number' ? r.attempts : undefined };
    },
    // F11C：取消要真正到达引擎。以前只清界面状态，引擎里的码仍有效到过期。
    // 没有在发起就不调（轮询发现对端完成时也走这里收尾：那时码已经消费，再取消是空操作）。
    cancelPairing() {
      const had = this.pairingSession !== null;
      this.pairingSession = null;
      this.pairingMeta = null;
      if (had) void rpc.call('remote.pair.cancel').catch(() => { /* 取消失败不打扰界面：码到期自己会作废 */ });
    },
    async unpair(fingerprint: string) {
      await rpc.call('remote.unpair', { peerFingerprint: fingerprint });
      await this.refreshDevices();
    },
    // F11C：切换本机配对策略（legacy / authenticated）。引擎会同时清掉全部待用的码，所以界面上的发起态一并清空。
    async setPairingPolicy(policy: PairingPolicy) {
      await rpc.call('remote.pair.setPolicy', { policy });
      this.pairingSession = null;
      this.pairingMeta = null;
      await this.refreshDevices();
    },
    // M3c Task 7：加入配对（免手抄公钥，决策 3）——调 remote.pair.join 真出站完成配对，
    // 成功后刷新设备列表 + 返回 peerFingerprint 供 UI 人工比对。RPC 由 Task 4 实装。
    // M4.6 Task 3：透传本端 minisd 监听端口 listenPort——begin 侧断线后靠它回拨，
    // 否则重连收敛只剩单方向。取不到本端端口时传 undefined 维持现状，不阻塞配对。
    async joinPairing(p: { host: string; port: number; pairingCode: string; peerName?: string; listenPort?: number }): Promise<string> {
      let listenPort = p.listenPort;
      if (listenPort === undefined) {
        try {
          const bridge = (window as any).deskminis;
          if (typeof bridge?.minisdInfo === 'function') {
            const info = await bridge.minisdInfo();
            listenPort = info?.port;
          }
        } catch { listenPort = undefined; } // 取不到不阻塞配对
      }
      const r = await rpc.call('remote.pair.join', { ...p, listenPort });
      await this.refreshDevices();
      return String(r.peerFingerprint);
    },
    // MU2a Task 8：错误条「重试」——重发最后一条非结果载体的真实用户消息（结果载体无文本，被 text.trim() 自然跳过）；
    // 找不到可重发消息则静默无操作（ChatView 侧以 canRetry 保证按钮不出现）
    async retryLast() {
      // F06：「没有送达」的那一条——用它原来的文本与附件重发（send() 认出是同一条，沿用原 promptId）
      const und = this.undelivered;
      if (und && und.sessionId === this.activeId) { await this.send(und.text, und.attachments); return; }
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m.role !== 'user' || !Array.isArray(m.parts)) continue;
        const text = m.parts.filter(p => p && p.type === 'text' && typeof p.value === 'string').map(p => p.value).join('\n');
        if (text.trim()) {
          const prior = _lastThinking.get(this.activeId);
          // 用户裁定：本窗口有原提交就沿用；没有记录时用输入卡当前档位。
          await this.send(text, undefined, prior?.text === text ? prior.level : this.thinkingLevel);
          return;
        }
      }
    },
    /** W2a-6「新建会话接力」（EventNotes 的接力钮调用；设计稿 §2「渲染端」、§3 第 2、5 条）：
     *  上下文已满时建一个新会话，把引擎给的接力草稿交给新会话的输入卡——只预填、不发送，由用户确认后自己发。
     *  新会话尽量照原会话开局：助手（还在的话）、模型绑定、工作区。不继承绑定会落到默认模型，窗口可能更小，接力后立即再满；
     *  工作区不管的话，后端建会话一律用「上次用过的工作区」——那可能是别的会话选的、与这段对话无关的目录，agent 就在那里接着干活。
     *  会话建出以后的继承步骤都是尽力而为：失败不拦接力（拦下的话每点一次多一个空会话，接力永远成不了），
     *  照常切过去，在新会话的输入卡上说清楚哪一项没跟过来、现在用的是什么。 */
    async relayToNewSession() {
      const src = this.relaySource;
      const fromId = this.activeId;
      // 草稿只对出事的那个会话有效；先取走再 await——连点第二下拿不到它，不会建出两个会话
      if (!src || src.sessionId !== fromId) return;
      this.relaySource = null;
      let createdId = src.createdId ?? '';
      let note = src.note ?? '';
      try {
        if (!createdId) {
          const from = this.sessions.find(s => s.id === fromId);
          const fromBinding = from?.modelBinding || undefined;
          const customRoot = this.workspaceIsDefault ? '' : this.workspaceRoot;
          // 助手删掉后会话的 assistant_id 悬空（assistants/store.ts remove），带着它建会话后端会抛「助手不存在」，接力就永远走不通。
          // 只在助手还在时带；不在就建普通会话——原会话那边这个助手本来也已不生效，两边一致
          const assistantId = from?.assistantId && this.assistants.some(a => a.id === from.assistantId) ? from.assistantId : '';
          // 带助手建会话：后端套用助手预设（技能快照、规则、助手自己的绑定），与原会话当初的开局一致
          const s = await rpc.call('chat.sessions.create', assistantId ? { assistantId } : {});
          createdId = String(s.id);
          const misses: string[] = [];
          // 绑定照抄原会话而不是照助手：原会话可能手动改过绑定，或溢出降级后改绑到了更大窗口的模型
          if ((s?.modelBinding || undefined) !== fromBinding) {
            try { await rpc.call('chat.sessions.setModelBinding', { sessionId: createdId, binding: fromBinding }); }
            catch (e) { misses.push(`没能沿用原会话的模型绑定（${errText(e)}）`); }
          }
          // 工作区与原会话同一语义：原会话设过目录就设同一个；原会话用的是默认沙箱（或它的目录已被删掉、移走），
          // 新会话就回到自己的沙箱，而不是留在后端给的 lastUsed。旧沙箱里的文件不随过去——沙箱每会话一个，这条边界保留
          let wsGone = '';
          if (customRoot) {
            try { await rpc.call('workspace.set', { sessionId: createdId, root: customRoot }); }
            catch (e) { wsGone = errText(e); }
          }
          let resetErr = '';
          if ((!customRoot || wsGone) && s?.workspaceRoot) {
            try { await rpc.call('workspace.reset', { sessionId: createdId }); }
            catch (e) { resetErr = errText(e); }
          }
          if (wsGone || resetErr) {
            misses.push((wsGone ? `原会话的工作区用不了（${wsGone}），` : '')
              + (resetErr ? `没能把新会话放回默认工作区（${resetErr}），现在用的是 ${String(s.workspaceRoot)}` : '新会话改用默认工作区'));
          }
          note = misses.length ? `接力会话已建好，但${misses.join('；')}` : '';
        }
        // 必须在 open() 之前写好：open() 取完新会话的（空）消息后，欢迎页替换会话页，新挂载的输入卡在 setup 里取它
        this.relayDraft = { sessionId: createdId, text: src.text };
        await this.refreshSessions();
        await this.open(createdId);
        // open() 换会话会清 lastError，所以放在它之后；欢迎页的输入卡把 lastError 显示在卡上
        if (note) this.lastError = note;
      } catch (e) {
        if (createdId) {
          // 会话已经建出来了：记住它（连同没跟过来的继承项），再点只切过去、不再新建——否则每点一次多一个空会话。
          // 草稿也留着指向它：用户从会话列表点进去，欢迎页的输入卡照样取得到
          this.relaySource = { ...src, createdId, note };
          this.relayDraft = { sessionId: createdId, text: src.text };
          this.lastError = `接力会话已建好，但没能切过去：${errText(e)}。可在会话列表里打开它，接力文本会自动填进输入框`;
          try { await this.refreshSessions(); } catch { /* 列表刷新失败不盖掉上面的报错 */ }
        } else {
          // 会话没建出来：如实说，把草稿放回去让钮可以再点
          this.relayDraft = null;
          this.relaySource = src;
          this.lastError = `新建接力会话失败：${errText(e)}`;
        }
      }
    },
  },
});
