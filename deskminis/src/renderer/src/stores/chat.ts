import { defineStore } from 'pinia';
import { rpc } from '../rpc';

let localSeq = 0;

interface UiMessage { id: string; role: string; parts: any[] }
interface PendingPerm { requestId: string; detail: string; kind: string; toolTitle: string }

export const useChat = defineStore('chat', {
  state: () => ({
    sessions: [] as { id: string; title: string }[],
    activeId: '' as string,
    messages: [] as UiMessage[],
    streamingText: '' as string,
    toolCards: [] as { toolUseId: string; name: string; title: string; output?: string; success?: boolean }[],
    pendingPerms: [] as PendingPerm[],
    providers: [] as { id: string; name: string; hasApiKey: boolean }[],
    // 循环报错（API Key 错误、provider 故障…）必须看得见，否则界面就是「按了没反应」
    lastError: '' as string,
    // 透明重试期间的提示；下一个 textDelta / turnEnd 清掉
    retryNote: '' as string,
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
    async refreshProviders() { this.providers = await rpc.call('provider.instances.list'); },
    async newSession() { const s = await rpc.call('chat.sessions.create', {}); await this.refreshSessions(); await this.open(s.id); },
    async open(id: string) {
      // 换会话才清错误横幅：turnEnd/error 之后的自刷新调用的也是 open，
      // 在那条路径上清掉的话，刚设置的 lastError 会被立刻抹掉（错误又变成看不见）。
      if (id !== this.activeId) { this.lastError = ''; this.retryNote = ''; }
      this.activeId = id; this.messages = await rpc.call('chat.messages.list', { sessionId: id }); this.streamingText = ''; this.toolCards = [];
    },
    async send(text: string) {
      this.streamingText = ''; this.toolCards = []; this.lastError = ''; this.retryNote = '';
      // 乐观消息用唯一 id：一次会话内连发多条时 'local' 会造成 :key 重复
      this.messages.push({ id: `local-${++localSeq}`, role: 'user', parts: [{ type: 'text', value: text }] });
      await rpc.call('chat.prompt', { sessionId: this.activeId, text });
    },
    async createProvider(p: any) { await rpc.call('provider.instances.create', p); await this.refreshProviders(); },
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
      else if (e.kind === 'turnEnd') { this.retryNote = ''; void this.open(this.activeId); }
      else if (e.kind === 'error') {
        // 先记错误再刷新：open 在同会话路径上不动 lastError，横幅得以留在界面上
        this.lastError = String(e.message ?? '未知错误');
        this.retryNote = '';
        void this.open(this.activeId);
      }
    },
  },
});
