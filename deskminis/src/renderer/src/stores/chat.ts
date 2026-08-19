import { defineStore } from 'pinia';
import { rpc } from '../rpc';
import { mimeFromPath } from '@shared/parts';

let localSeq = 0;
// M3c Task 7：sync.dirty → syncing → 2s 回 idle 的回退定时器（模块级非响应式，单 store 实例）
let _syncDirtyTimer: ReturnType<typeof setTimeout> | undefined;

interface UiMessage { id: string; role: string; parts: any[]; createdAt?: number; tokenUsage?: { inputTokens: number; outputTokens: number }; originDeviceId?: string; reasoningContent?: string }
interface PendingPerm { requestId: string; detail: string; kind: string; toolTitle: string; timeoutMs?: number; riskClass?: string; bridgeTriggers?: string[]; deadlineMs?: number; preview?: { oldText: string; newText: string } }
interface UiProvider { id: string; name: string; hasApiKey: boolean; modelId?: string; kind?: string }
type PermTier = 'ask' | 'session' | 'full';
interface UiSkill { id: string; name: string; description: string; isEnabled: boolean; useCount: number }

export const useChat = defineStore('chat', {
  state: () => ({
    // 字段与后端 SessionMeta 对齐：chat.sessions.list 本就返回 memoryEnabled / modelBinding，
    // 此前本地只声明了四项，导致「有数据但界面读不到」——MU6 会话操作正需要这两项显示当前状态。
    sessions: [] as { id: string; title: string; updatedAt?: number; pinnedAt?: number;
                      memoryEnabled?: boolean; modelBinding?: string }[],
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
    providers: [] as UiProvider[],
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
    },
    // 循环报错（API Key 错误、provider 故障…）必须看得见，否则界面就是「按了没反应」
    lastError: '' as string,
    // 透明重试期间的提示；下一个 textDelta / turnEnd 清掉
    retryNote: '' as string,
    // 当前回合是否在跑：控制发送键 ↔ 停止键、以及底部实时助手块的显隐
    running: false as boolean,
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
    eventNotes: [] as { kind: 'fallback'|'compacted'|'offloaded'|'retry'|'error'|'synced'|'pruned'; ts: number; detail?: string; retryable?: boolean }[], // 对话流内联气泡（最多保留 10 条）；MU2a Task 8 扩 retry/error 两类（error 带 retryable 供重试钮）；M3c Task 7 扩 synced（同步完成）；A6 扩 pruned（修剪）
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
        if (sessionId === this.activeId) this.onEvent(event);
      });
      // M3c Task 7：sync.dirty notify → syncState='syncing' → 2s 后回 'idle'
      rpc.on('sync.dirty', () => {
        this.syncState = 'syncing';
        if (_syncDirtyTimer) clearTimeout(_syncDirtyTimer);
        _syncDirtyTimer = setTimeout(() => { this.syncState = 'idle'; _syncDirtyTimer = undefined; }, 2000);
      });
      // MU2a Task 10：params.meta 并入条目（超时秒数/风险分级/桥触发列表）；deadlineMs 在 push 时一次算定
      rpc.on('permission.request', ({ requestId, req, meta }: any) => this.pendingPerms.push({
        requestId, detail: req.detail, kind: req.kind, toolTitle: req.toolTitle,
        timeoutMs: meta?.timeoutMs, riskClass: meta?.riskClass, bridgeTriggers: meta?.bridgeTriggers,
        // 审批前变更预览（file_write/file_edit 才有）：权限卡据此渲染差分，写文件不再盲批
        preview: req.preview,
        deadlineMs: typeof meta?.timeoutMs === 'number' ? Date.now() + meta.timeoutMs : undefined,
      }));
      // 询问超时（90s）或别的窗口已答复时 minisd 广播 resolved：不摘掉卡片就会永远挂在界面上。
      // 决策 4b' 按 reason 分流：timeout → 摘卡 + 补「已超时拒绝」事件条（设计 §5.2-1）；answered/无 reason → 只摘卡。
      // renderer 不做 deadline 自判（恒晚于 minisd 一个广播延迟，自判永不触发——评审命门 1）。
      rpc.on('permission.resolved', ({ requestId, reason }: any) => {
        this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId);
        if (reason === 'timeout') {
          this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail: '权限请求已超时，自动拒绝', retryable: false }];
        }
      });
      await this.refreshSessions();
      await this.refreshProviders();
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
      // 本地默认选择未定/已失效时，回落到列表首个（与后端 create() 的默认策略一致）
      if (!this.providers.some(p => p.id === this.defaultProviderId)) this.defaultProviderId = this.providers[0]?.id ?? '';
    },
    async refreshSkills() {
      // 斜杠菜单只列生效启用集：有活动会话走会话覆盖，否则退回全局启用项
      this.skills = this.activeId
        ? await rpc.call('skills.list', { sessionId: this.activeId })
        : (await rpc.call('skills.list', {})).filter((s: UiSkill) => s.isEnabled);
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
        else { this.activeId = ''; this.messages = []; }
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
      // 工作区是每会话的，切会话必须重新取——否则 chip 会显示上一个会话的目录
      // 换会话才清错误横幅：turnEnd/error 之后的自刷新调用的也是 open，
      // 在那条路径上清掉的话，刚设置的 lastError 会被立刻抹掉（错误又变成看不见）。
      if (id !== this.activeId) {
        this.lastError = ''; this.retryNote = ''; this.running = false;
        this.lastStopReason = '';
        this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
        this.contextInfo = null;
      }
      this.activeId = id; this.messages = await rpc.call('chat.messages.list', { sessionId: id }); this.streamingText = ''; this.streamingThinking = ''; this.toolCards = [];
      void this.refreshSkills(); // 会话覆盖会改变生效启用集，换会话必须重取
      await this.refreshWorkspace();
    },
    async send(text: string, attachments?: string[]) {
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
      // chat.prompt 会同步拒绝（未配置 provider / 空文本 / 会话运行中 / 非法 sessionId）。
      // 不 catch 的话是一次未处理拒绝：用户只看到「按了没反应」。捕获后写进 lastError 让它可见，
      // 并摘掉这条从未落库的乐观消息（否则会留下一个假的「已发送」气泡）。
      try {
        await rpc.call('chat.prompt', { sessionId: this.activeId, text, attachments: atts });
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.messages = this.messages.filter(m => m.id !== optimisticId);
        this.running = false;
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
        if (e.stopReason) this.lastStopReason = String(e.stopReason);
        void this.open(this.activeId);
        void this.fetchContextInfo();
      }
      else if (e.kind === 'error') {
        // 先记错误再刷新：open 在同会话路径上不动 lastError，横幅得以留在界面上
        this.lastError = String(e.message ?? '未知错误');
        this.retryNote = '';
        this.streamingThinking = ''; // 回合已败，半截思考没有下文，留着只会悬在界面上
        this.running = false;
        // MU2a Task 8：错误进对话流内联（EventNote 短句 + 详情折叠 + 重试钮），errbar 横幅退场
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail: String(e.message ?? '未知错误'), retryable: true }];
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
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'fallback', ts: Date.now(), detail: `${String(e.from)} → ${String(e.to)}（${String(e.reason)}）` }];
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
  },
});
