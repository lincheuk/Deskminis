import { defineStore } from 'pinia';
import { rpc } from '../rpc';
import { mimeFromPath } from '@shared/parts';
import { errorShortByCode, fallbackShortByCause } from '../lib/eventnote/copy';

let localSeq = 0;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// M3c Task 7：sync.dirty → syncing → 2s 回 idle 的回退定时器（模块级非响应式，单 store 实例）
let _syncDirtyTimer: ReturnType<typeof setTimeout> | undefined;

interface UiMessage { id: string; role: string; parts: any[]; createdAt?: number; tokenUsage?: { inputTokens: number; outputTokens: number }; originDeviceId?: string; reasoningContent?: string }
/** 待批的权限卡。sessionId（W2b-2）是卡所属的会话，取自引擎广播的 PermissionRequest.sessionId（必填，设计稿 §3 第 6 条）——
 *  卡按会话分开渲染、超时留条只写给卡所属的会话，都靠它（判据在 lib/perm/scope）。 */
interface PendingPerm { requestId: string; sessionId: string; detail: string; kind: string; toolTitle: string; timeoutMs?: number; riskClass?: string; bridgeTriggers?: string[]; deadlineMs?: number; preview?: { oldText: string; newText: string }; note?: string }
interface UiProvider { id: string; name: string; hasApiKey: boolean; modelId?: string; kind?: string }
type PermTier = 'ask' | 'session' | 'full';
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
      statuses: { name: string; status: 'connected' | 'error' | 'idle'; lastError?: string; toolCount: number }[];
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
     *  只会从 ok 变成 lost，不会变回来：不重连（W6），出路是横幅上的「重启应用」。 */
    connection: 'ok' as 'ok' | 'lost',
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
    eventNotes: [] as { kind: 'fallback'|'compacted'|'offloaded'|'retry'|'error'|'synced'|'pruned'|'compactFailed'; ts: number; detail?: string; retryable?: boolean; relay?: boolean; short?: string }[], // 对话流内联气泡（最多保留 10 条）；MU2a Task 8 扩 retry/error 两类（error 带 retryable 供重试钮）；M3c Task 7 扩 synced（同步完成）；A6 扩 pruned（修剪）；W2a-1 扩 compactFailed（压缩失败，追加在末尾：既有守卫按前缀子串匹配）；W2a-6 加 relay（给「新建会话接力」钮）与 short（按 code / cause 定好的短句，EventNotes 优先用它）
    fallbackState: null as null | { from: string; to: string; reason: string }, // 任务面板「降级」卡（对齐 loop.ts: fallback(from,to,reason)）
    compactedState: null as null | { markerId: string; summary: string }, // 任务面板「压缩」卡（对齐 loop.ts: compacted(markerId,summary)；无 fromCount/toCount/freedTokens）
    offloadedState: null as null | { count: number; lastRelativePath?: string }, // 任务面板「卸载」卡（对齐 loop.ts: offloaded(toolUseId,relativePath)；逐条自增计数，附最近一条路径）
    // M2d · #7：chat.contextInfo 轮询缓存（任务面板水位条显示窗口 + 当次用量）
    contextInfo: null as null | { windowTokens: number; usedTokens: number; remaining: number },
    // MU2b Task 7：配对管理面（DevicesModal）——已配对设备脱敏列表（remote.status；
    // 指纹/名称/roomId/配对时间，无密钥材料）。M3c Task 5 增 online/lastSeenAt（命门 2 出站∪入站合并）。
    devices: [] as { peerFingerprint: string; peerName: string; roomId: string; createdAt: number; online: boolean; lastSeenAt: number }[],
    // 发起配对中的会话（remote.pair.begin 返回）；null = 未在发起。expiresIn 秒、startedAt ms。
    pairingSession: null as null | { code: string; myFingerprint: string; expiresIn: number; startedAt: number },
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
    async init() {
      // W2b-3：断线订阅挂在 connect 之前——首次就连不上时（浏览器先 error 后 close），断线通知在 connect 的 await 期间就到，
      // 晚挂一步就接不到，首启失败时横幅就不出现
      rpc.onLost(() => this.markConnectionLost());
      await rpc.connect();
      // M3c Task 7：chat.event 兼容两种 payload——
      //   ① 既有 LoopEvent：{ sessionId, event: { kind, ... } } → onEvent(event)
      //   ② M3c synced：{ kind:'synced', sessionId, mergedCount, fromDevice } → 推入 eventNotes
      rpc.on('chat.event', (payload: any) => {
        const { sessionId, event } = payload;
        if (payload.kind === 'synced') {
          if (sessionId === this.activeId) {
            this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'synced' as const, ts: Date.now(), detail: `已同步 ${Number(payload.mergedCount ?? 0)} 条来自 ${String(payload.fromDevice ?? '').slice(0, 6)}` }];
          }
          return;
        }
        // W2b-1：先按会话记账、再按 activeId 过滤——非当前会话的事件以前在这里整条丢掉，渲染端就不知道谁在跑
        this.trackRun(sessionId, event);
        if (sessionId === this.activeId) this.onEvent(event);
      });
      // H2：注释变更广播（本窗口的写操作也走这条回流——见 annotations 状态注释）
      rpc.on('chat.annotations.changed', (p: { sessionId?: string }) => {
        if (p?.sessionId === this.activeId) void this.refreshAnnotations();
      });
      // M3c Task 7：sync.dirty notify → syncState='syncing' → 2s 后回 'idle'
      rpc.on('sync.dirty', () => {
        this.syncState = 'syncing';
        if (_syncDirtyTimer) clearTimeout(_syncDirtyTimer);
        _syncDirtyTimer = setTimeout(() => { this.syncState = 'idle'; _syncDirtyTimer = undefined; }, 2000);
      });
      // MU2a Task 10：params.meta 并入条目（超时秒数/风险分级/桥触发列表）；deadlineMs 在 push 时一次算定
      rpc.on('permission.request', ({ requestId, req, meta }: any) => this.pendingPerms.push({
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
      }));
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
        }
      });
      // J2：助手目录变更广播（本窗口的写操作也走这条回流——单一代码路径，多窗口一致）
      rpc.on('assistants.changed', () => { void this.refreshAssistants(); });
      // K2：调度器触发/终态/CRUD 全走 cron.changed 回流——面板「下次运行/上次状态」保持活值
      rpc.on('cron.changed', () => { void this.refreshCronJobs(); });
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
      if (preset && (preset.preset === 'ask' || preset.preset === 'session' || preset.preset === 'full')) this.permTier = preset.preset;
      // 技能菜单数据源：开关/删除广播 changed；导入是后台任务不广播 changed，
      // 靠 progress 终态刷新（否则导入完成菜单里看不到）
      rpc.on('skills.changed', () => { void this.refreshSkills(); });
      // 会话标题会被后端自己改（首回合结束的自动命名），不是每次都由本窗口发起——
      // 不订阅这条广播的话，取好的名字要等到下次手动刷新列表才看得见。
      rpc.on('chat.sessions.changed', () => { void this.refreshSessions(); });
      rpc.on('skills.import.progress', (t: any) => {
        if (t && typeof t.taskId === 'string') this.skillImport = t;
        if (t && t.state !== 'running') { void this.refreshSkills(); void this.refreshAllSkills(); }
      });
      await this.refreshSkills();
      // #7：水位动态刷新——每次 turnEnd/重试/压缩/卸载 之后拉一次 chat.contextInfo 存 state.contextInfo（供 TasksPanel 用，不直接写死 200K）
      void this.fetchContextInfo();
    },
    async refreshSessions() { this.sessions = await rpc.call('chat.sessions.list'); },
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
          this.lastError = ''; this.retryNote = ''; this.running = false; this.lastStopReason = '';
          this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
          this.contextInfo = null; this.streamingText = ''; this.streamingThinking = ''; this.toolCards = [];
        }
      }
    },
    /** 重命名会话。后端会拒空标题与超 50 字，错误原样抛给调用方——
     *  菜单里要把这句话显示出来，静默吞掉就成了「点了确认没反应」。 */
    async renameSession(id: string, title: string) {
      await rpc.call('chat.sessions.rename', { sessionId: id, title });
      // 后端也会广播 sessions.changed，但那条是异步到达的；这里补一次
      // 让「点完确认列表立刻是新名字」成为确定行为（与同组其他 action 一致）
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
      // 工作区是每会话的，切会话必须重新取——否则 chip 会显示上一个会话的目录
      // 换会话才清错误横幅：turnEnd/error 之后的自刷新调用的也是 open，
      // 在那条路径上清掉的话，刚设置的 lastError 会被立刻抹掉（错误又变成看不见）。
      if (id !== this.activeId) {
        // W2b-1：running 取这个会话自己的运行态，不再一律归零——切回仍在跑的会话，停止键得回来（chat.cancel 按 activeId 取消）。
        // 流式缓冲在下面清空，之后到达的只是半截，所以同时打上 midRun 占位
        this.lastError = ''; this.retryNote = ''; this.running = this.runningSessions.includes(id);
        this.midRun = this.running;
        this.lastStopReason = '';
        this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
        this.contextInfo = null;
        // W2b-4：选择态镜像这个会话已绑的助手。以前一律清成 ''：新建的带助手会话回到欢迎页时卡片不亮、副标题说没选，
        // 用户再点一次就会被当成「改选」；贴图、选工作区隐式建会话后，刚点的选择也在这里被静默作废。
        // 只在换会话时取：同一会话的自刷新（turnEnd / error 后的 open）不能覆盖用户刚点、还没发出去的选择
        this.welcomeAssistantId = this.sessions.find(s => s.id === id)?.assistantId ?? '';
      }
      this.activeId = id; this.messages = await rpc.call('chat.messages.list', { sessionId: id }); this.streamingText = ''; this.streamingThinking = ''; this.toolCards = [];
      void this.refreshSkills(); // 会话覆盖会改变生效启用集，换会话必须重取
      void this.refreshAnnotations(); // H2：注释随会话装载（高亮重锚定数据源）
      await this.refreshWorkspace();
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
    async send(text: string, attachments?: string[]) {
      // 记下发给谁（到 chat.prompt 之前没有 await，sid 就是 prompt 发往的会话）：prompt 可能要等很久才被拒
      // （W1b-4 起，会话在连 MCP 期间被删或被停止会以「会话已取消」拒绝，要等连接超时才回来），
      // 那时用户可能已经在看别的会话了，见下面 catch
      const sid = this.activeId;
      // W2b-3：断线之后什么都不动就退。发送键置灰管不到键盘——Enter 照样进到这里，事件条的「重试」（retryLast）也是；
      // 必须在下面清缓冲之前：断线时特意留下的半截回复与事件条（markConnectionLost）是给用户复制、查看的，
      // 往下走的话一次按键就全清空（rpc 的拒绝要到清空之后才回来），还会推一个发不出去的乐观气泡、把停止键点亮。
      // 写 lastError 是交代，也是给输入卡的信号：它见 lastError 才把寄存的草稿交回框里（Composer send 之后那行 takeDraft）
      if (this.connection === 'lost') { this.lastError = '与后台服务的连接已断开'; return; }
      this.streamingText = ''; this.streamingThinking = ''; this.toolCards = []; this.lastError = ''; this.retryNote = '';
      this.lastStopReason = ''; this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
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
      try {
        await rpc.call('chat.prompt', { sessionId: this.activeId, text, attachments: atts });
      } catch (e) {
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
      }
    },
    async cancel() {
      if (!this.activeId) return;
      try { await rpc.call('chat.cancel', { sessionId: this.activeId }); }
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
    /** 网络搜索 provider：读状态（无密钥本体，只有 hasKey）/ 保存配置（kind 传 none 清除）。 */
    async fetchSearchProvider() { const r = await rpc.call<{ kind: string; hasKey: boolean; baseUrl?: string }>('search.provider.get'); this.searchProvider = r; return r; },
    async saveSearchProvider(p: { kind: string; apiKey?: string; baseUrl?: string }) { await rpc.call('search.provider.set', p); await this.fetchSearchProvider(); },
    async respondPerm(requestId: string, decision: string) {
      this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId);
      await rpc.call('permission.respond', { requestId, decision });
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
      if (sessionId === this.activeId && !this.running) { this.running = true; this.midRun = true; }
    },
    onEvent(e: any) {
      if (e.kind === 'textDelta') { this.retryNote = ''; this.streamingText += e.text; }
      // 思考流与正文分开累积：ThinkingBlock 折叠块渲染它，不进 Markdown 正文。
      // 不清 retryNote——retryNote 的既有契约是「下一个 textDelta / turnEnd 清掉」，不扩界。
      else if (e.kind === 'thinkingDelta') this.streamingThinking += e.text;
      else if (e.kind === 'toolStart') this.toolCards.push({ toolUseId: e.toolUseId, name: e.name, title: e.title, startedAt: Date.now(), input: e.input });
      else if (e.kind === 'toolEnd') { const c = this.toolCards.find(x => x.toolUseId === e.toolUseId); if (c) { c.output = e.output; c.success = e.success; c.endedAt = Date.now(); } }
      else if (e.kind === 'retry') {
        // 循环会整回合重来，已缓冲的半截文本是过期的（不清就会和重试后的正文拼在一起）
        this.streamingText = '';
        // 思考缓冲同理：重试会重新推理，旧半截思考留着会拼进新思考
        this.streamingThinking = '';
        this.retryNote = `正在重试…（第 ${e.attempt} 次，${Math.round((e.delayMs ?? 0) / 1000)}s 后）`;
        // MU2a Task 8：retryNote 同时流转为 eventNotes 一条（kind retry）——双写过渡，MU2b Task 2 收口
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'retry', ts: Date.now(), detail: `第 ${e.attempt} 次，${Math.round((e.delayMs ?? 0) / 1000)}s 后` }];
      }
      else if (e.kind === 'turnEnd') {
        this.retryNote = ''; this.running = false;
        // 思考已随消息落库（reasoningContent），历史块会接管渲染；
        // 这里同步清缓冲——open() 重取是异步的，残值会与历史块短暂并存
        this.streamingThinking = '';
        // W2b-1：中途接上的回合，缓冲里只有切回之后的半截——open() 重取完整历史是异步的，
        // 不在这里同步丢掉的话，占位撤下到历史到达之间会闪出从句子中间开始的半截文字
        if (this.midRun) { this.streamingText = ''; this.toolCards = []; this.midRun = false; }
        if (e.stopReason) this.lastStopReason = String(e.stopReason);
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
        if (this.midRun) { this.streamingText = ''; this.toolCards = []; this.midRun = false; } // 同 turnEnd：半截不闪出来
        // W2a-6：按引擎给的 code 分流（设计稿 §3 第 2、3 条），不靠文案判断。短句也按 code 在 copy.ts 里选好随条带上，
        // 不让 EventNotes 对原始报文跑状态码正则（绑定错误的响应体里一个独立的 5xx 就会被说成「服务暂时不可用」）。
        if (e.code === 'contextFull') {
          // 上下文已满：原地重试必然再满，不给重试；给「新建会话接力」。草稿先存 relaySource，点了钮才交给新会话
          const draft = typeof e.relayDraft === 'string' ? e.relayDraft : '';
          this.relaySource = draft ? { sessionId: this.activeId, text: draft } : null;
          this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail, retryable: false, relay: !!draft, short: errorShortByCode(e.code) }];
        } else if (e.code === 'thinkingBinding') {
          // 思考块绑定：绑定的是这段对话的历史，原样重发必然同样 400，不给重试（message 里已写明请新建会话）
          this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail, retryable: false, short: errorShortByCode(e.code) }];
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
    },
    async fetchContextInfo() {
      if (!this.activeId) return;
      try {
        this.contextInfo = await rpc.call('chat.contextInfo', { sessionId: this.activeId });
      } catch { /* 水位 RPC 失败不影响主流程；缓存保持上一次值，任务面板显示「数据暂缺」 */ }
    },
    // MU2b Task 7：配对管理面四 actions——只消费既有 remote.status/pair.begin/unpair 三 RPC
    // （红线：不新增 RPC；remote.* 仅 local authMode 可调，渲染端 per-run token 连接天然满足）。
    async refreshDevices() {
      const r = await rpc.call('remote.status');
      this.devices = Array.isArray(r?.devices) ? r.devices : [];
    },
    async beginPairing() {
      const r = await rpc.call('remote.pair.begin');
      this.pairingSession = {
        code: String(r.pairingCode), myFingerprint: String(r.myFingerprint),
        expiresIn: Number(r.expiresIn), startedAt: Date.now(),
      };
    },
    cancelPairing() { this.pairingSession = null; },
    async unpair(fingerprint: string) {
      await rpc.call('remote.unpair', { peerFingerprint: fingerprint });
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
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m.role !== 'user' || !Array.isArray(m.parts)) continue;
        const text = m.parts.filter(p => p && p.type === 'text' && typeof p.value === 'string').map(p => p.value).join('\n');
        if (text.trim()) { await this.send(text); return; }
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
