import { defineStore } from 'pinia';
import { rpc } from '../rpc';

let localSeq = 0;

interface UiMessage { id: string; role: string; parts: any[] }
interface PendingPerm { requestId: string; detail: string; kind: string; toolTitle: string }
interface UiProvider { id: string; name: string; hasApiKey: boolean; modelId?: string; kind?: string }
type PermTier = 'ask' | 'session' | 'full';

export const useChat = defineStore('chat', {
  state: () => ({
    sessions: [] as { id: string; title: string; updatedAt?: number; pinnedAt?: number }[],
    activeId: '' as string,
    messages: [] as UiMessage[],
    streamingText: '' as string,
    toolCards: [] as { toolUseId: string; name: string; title: string; output?: string; success?: boolean }[],
    pendingPerms: [] as PendingPerm[],
    providers: [] as UiProvider[],
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
  }),
  actions: {
    async init() {
      await rpc.connect();
      rpc.on('chat.event', ({ sessionId, event }: any) => { if (sessionId === this.activeId) this.onEvent(event); });
      rpc.on('permission.request', ({ requestId, req }: any) => this.pendingPerms.push({ requestId, detail: req.detail, kind: req.kind, toolTitle: req.toolTitle }));
      // 询问超时（30s）或别的窗口已答复时 minisd 广播 resolved：不摘掉卡片就会永远挂在界面上
      rpc.on('permission.resolved', ({ requestId }: any) => { this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId); });
      await this.refreshSessions();
      await this.refreshProviders();
    },
    async refreshSessions() { this.sessions = await rpc.call('chat.sessions.list'); },
    async refreshProviders() {
      this.providers = await rpc.call('provider.instances.list');
      // 本地默认选择未定/已失效时，回落到列表首个（与后端 create() 的默认策略一致）
      if (!this.providers.some(p => p.id === this.defaultProviderId)) this.defaultProviderId = this.providers[0]?.id ?? '';
    },
    async newSession() { const s = await rpc.call('chat.sessions.create', {}); await this.refreshSessions(); await this.open(s.id); },
    async open(id: string) {
      // 换会话才清错误横幅：turnEnd/error 之后的自刷新调用的也是 open，
      // 在那条路径上清掉的话，刚设置的 lastError 会被立刻抹掉（错误又变成看不见）。
      if (id !== this.activeId) { this.lastError = ''; this.retryNote = ''; this.running = false; }
      this.activeId = id; this.messages = await rpc.call('chat.messages.list', { sessionId: id }); this.streamingText = ''; this.toolCards = [];
    },
    async send(text: string) {
      this.streamingText = ''; this.toolCards = []; this.lastError = ''; this.retryNote = '';
      // 乐观消息用唯一 id：一次会话内连发多条时 'local' 会造成 :key 重复
      const optimisticId = `local-${++localSeq}`;
      this.messages.push({ id: optimisticId, role: 'user', parts: [{ type: 'text', value: text }] });
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
    async deleteProvider(id: string) { await rpc.call('provider.instances.delete', { id, confirm: true }); await this.refreshProviders(); },
    async respondPerm(requestId: string, decision: string) {
      this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId);
      await rpc.call('permission.respond', { requestId, decision });
    },
    onEvent(e: any) {
      if (e.kind === 'textDelta') { this.retryNote = ''; this.streamingText += e.text; }
      else if (e.kind === 'toolStart') this.toolCards.push({ toolUseId: e.toolUseId, name: e.name, title: e.title });
      else if (e.kind === 'toolEnd') { const c = this.toolCards.find(x => x.toolUseId === e.toolUseId); if (c) { c.output = e.output; c.success = e.success; } }
      else if (e.kind === 'retry') {
        // 循环会整回合重来，已缓冲的半截文本是过期的（不清就会和重试后的正文拼在一起）
        this.streamingText = '';
        this.retryNote = `正在重试…（第 ${e.attempt} 次，${Math.round((e.delayMs ?? 0) / 1000)}s 后）`;
      }
      else if (e.kind === 'turnEnd') { this.retryNote = ''; this.running = false; void this.open(this.activeId); }
      else if (e.kind === 'error') {
        // 先记错误再刷新：open 在同会话路径上不动 lastError，横幅得以留在界面上
        this.lastError = String(e.message ?? '未知错误');
        this.retryNote = '';
        this.running = false;
        void this.open(this.activeId);
      }
    },
  },
});
