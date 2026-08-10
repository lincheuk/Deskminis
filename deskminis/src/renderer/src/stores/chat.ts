import { defineStore } from 'pinia';
import { rpc } from '../rpc';

let localSeq = 0;
// M3c Task 7：sync.dirty → syncing → 2s 回 idle 的回退定时器（模块级非响应式，单 store 实例）
let _syncDirtyTimer: ReturnType<typeof setTimeout> | undefined;

interface UiMessage { id: string; role: string; parts: any[]; createdAt?: number; tokenUsage?: { inputTokens: number; outputTokens: number }; originDeviceId?: string }
interface PendingPerm { requestId: string; detail: string; kind: string; toolTitle: string; timeoutMs?: number; riskClass?: string; bridgeTriggers?: string[]; deadlineMs?: number }
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
    toolCards: [] as { toolUseId: string; name: string; title: string; output?: string; success?: boolean; startedAt?: number; endedAt?: number; input?: string }[],
    pendingPerms: [] as PendingPerm[],
    // MU2b Task 2：进度面板「去处理」点击写入目标权限卡 requestId，ChatView watch 后滚动定位并清空
    permFocusRequestId: null as string | null,
    // MU2b Task 3：产物卡点击写入待预览相对路径，FilesPanel watch 后走既有 preview 流程并清空
    pendingFilePreview: null as string | null,
    providers: [] as UiProvider[],
    skills: [] as UiSkill[],
    // 循环报错（API Key 错误、provider 故障…）必须看得见，否则界面就是「按了没反应」
    lastError: '' as string,
    // 透明重试期间的提示；下一个 textDelta / turnEnd 清掉
    retryNote: '' as string,
    // 当前回合是否在跑：控制发送键 ↔ 停止键、以及底部实时助手块的显隐
    running: false as boolean,
    // 后端没有暴露「读取默认 provider」的 RPC；渲染端本地镜像当前选择（模型胶囊显示 + 打勾）。
    // 初值置为首个 provider —— 后端 create() 也把首个建的 provider 设为默认。
    defaultProviderId: '' as string,
    // 权限档位为 M1 渲染端本地偏好（后端网关一次性构造、无对应设置）：只影响权限卡里预选高亮哪个按钮。
    permTier: 'ask' as PermTier,
    // M2d · Task 5：上回合停止原因（turnEnd.stopReason）
    lastStopReason: '' as string,
    // M2d · #10 事件 UI 接线：四种目前未消费事件（fallback/compacted/offloaded/retry）的状态。
    //   retry 已有 retryNote 字段沿用；其余三种新增会话级环内联提示 + 任务面板状态字典。
    eventNotes: [] as { kind: 'fallback'|'compacted'|'offloaded'|'retry'|'error'|'synced'; ts: number; detail?: string; retryable?: boolean }[], // 对话流内联气泡（最多保留 10 条）；MU2a Task 8 扩 retry/error 两类（error 带 retryable 供重试钮）；M3c Task 7 扩 synced（同步完成）
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
      // 技能菜单数据源：开关/删除广播 changed；导入是后台任务不广播 changed，
      // 靠 progress 终态刷新（否则导入完成菜单里看不到）
      rpc.on('skills.changed', () => { void this.refreshSkills(); });
      rpc.on('skills.import.progress', (t: any) => { if (t && t.state !== 'running') void this.refreshSkills(); });
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
    async setSessionMemory(id: string, enabled: boolean) {
      await rpc.call('chat.sessions.setMemoryEnabled', { sessionId: id, enabled });
      await this.refreshSessions();
    },
    /** binding 传 undefined / 空串即解绑（后端 setModelBinding 的取值约定）。 */
    async setSessionModelBinding(id: string, binding?: string) {
      await rpc.call('chat.sessions.setModelBinding', { sessionId: id, binding });
      await this.refreshSessions();
    },
    async newSession() { const s = await rpc.call('chat.sessions.create', {}); await this.refreshSessions(); await this.open(s.id); },
    async open(id: string) {
      // 换会话才清错误横幅：turnEnd/error 之后的自刷新调用的也是 open，
      // 在那条路径上清掉的话，刚设置的 lastError 会被立刻抹掉（错误又变成看不见）。
      if (id !== this.activeId) {
        this.lastError = ''; this.retryNote = ''; this.running = false;
        this.lastStopReason = '';
        this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
        this.contextInfo = null;
      }
      this.activeId = id; this.messages = await rpc.call('chat.messages.list', { sessionId: id }); this.streamingText = ''; this.toolCards = [];
      void this.refreshSkills(); // 会话覆盖会改变生效启用集，换会话必须重取
    },
    async send(text: string) {
      this.streamingText = ''; this.toolCards = []; this.lastError = ''; this.retryNote = '';
      this.lastStopReason = ''; this.eventNotes = []; this.fallbackState = null; this.compactedState = null; this.offloadedState = null;
      // 乐观消息用唯一 id：一次会话内连发多条时 'local' 会造成 :key 重复
      const optimisticId = `local-${++localSeq}`;
      this.messages.push({ id: optimisticId, role: 'user', parts: [{ type: 'text', value: text }], createdAt: Date.now() / 1000 });
      this.running = true;
      // chat.prompt 会同步拒绝（未配置 provider / 空文本 / 会话运行中 / 非法 sessionId）。
      // 不 catch 的话是一次未处理拒绝：用户只看到「按了没反应」。捕获后写进 lastError 让它可见，
      // 并摘掉这条从未落库的乐观消息（否则会留下一个假的「已发送」气泡）。
      try {
        await rpc.call('chat.prompt', { sessionId: this.activeId, text });
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
    setPermTier(tier: PermTier) { this.permTier = tier; },
    async createProvider(p: any) { await rpc.call('provider.instances.create', p); await this.refreshProviders(); },
    async updateProvider(id: string, p: any) { await rpc.call('provider.instances.update', { id, ...p }); await this.refreshProviders(); },
    async deleteProvider(id: string) { await rpc.call('provider.instances.delete', { id, confirm: true }); await this.refreshProviders(); },
    async respondPerm(requestId: string, decision: string) {
      this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId);
      await rpc.call('permission.respond', { requestId, decision });
    },
    onEvent(e: any) {
      if (e.kind === 'textDelta') { this.retryNote = ''; this.streamingText += e.text; }
      else if (e.kind === 'toolStart') this.toolCards.push({ toolUseId: e.toolUseId, name: e.name, title: e.title, startedAt: Date.now(), input: e.input });
      else if (e.kind === 'toolEnd') { const c = this.toolCards.find(x => x.toolUseId === e.toolUseId); if (c) { c.output = e.output; c.success = e.success; c.endedAt = Date.now(); } }
      else if (e.kind === 'retry') {
        // 循环会整回合重来，已缓冲的半截文本是过期的（不清就会和重试后的正文拼在一起）
        this.streamingText = '';
        this.retryNote = `正在重试…（第 ${e.attempt} 次，${Math.round((e.delayMs ?? 0) / 1000)}s 后）`;
        // MU2a Task 8：retryNote 同时流转为 eventNotes 一条（kind retry）——双写过渡，MU2b Task 2 收口
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'retry', ts: Date.now(), detail: `第 ${e.attempt} 次，${Math.round((e.delayMs ?? 0) / 1000)}s 后` }];
      }
      else if (e.kind === 'turnEnd') {
        this.retryNote = ''; this.running = false;
        if (e.stopReason) this.lastStopReason = String(e.stopReason);
        void this.open(this.activeId);
        void this.fetchContextInfo();
      }
      else if (e.kind === 'error') {
        // 先记错误再刷新：open 在同会话路径上不动 lastError，横幅得以留在界面上
        this.lastError = String(e.message ?? '未知错误');
        this.retryNote = '';
        this.running = false;
        // MU2a Task 8：错误进对话流内联（EventNote 短句 + 详情折叠 + 重试钮），errbar 横幅退场
        this.eventNotes = [...this.eventNotes.slice(-9), { kind: 'error', ts: Date.now(), detail: String(e.message ?? '未知错误'), retryable: true }];
        void this.open(this.activeId);
      }
      // M2d · #10：四种未消费事件（M2b 降级 / M2a 压缩 / M2a 卸载 / retry）——retry 分支已有，仅补其余三种并在任务面板挂状态。
      // 字段严格对齐 loop.ts 的 LoopEvent 联合类型，禁止用 ?? 0 / ?? '' 静默兜底掩盖缺失。
      else if (e.kind === 'fallback') {
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
