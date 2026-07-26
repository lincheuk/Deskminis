import { defineStore } from 'pinia';
import { rpc } from '../rpc';

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
  }),
  actions: {
    async init() {
      await rpc.connect();
      rpc.on('chat.event', ({ sessionId, event }: any) => { if (sessionId === this.activeId) this.onEvent(event); });
      rpc.on('permission.request', ({ requestId, req }: any) => this.pendingPerms.push({ requestId, detail: req.detail, kind: req.kind, toolTitle: req.toolTitle }));
      await this.refreshSessions();
      await this.refreshProviders();
    },
    async refreshSessions() { this.sessions = await rpc.call('chat.sessions.list'); },
    async refreshProviders() { this.providers = await rpc.call('provider.instances.list'); },
    async newSession() { const s = await rpc.call('chat.sessions.create', {}); await this.refreshSessions(); await this.open(s.id); },
    async open(id: string) { this.activeId = id; this.messages = await rpc.call('chat.messages.list', { sessionId: id }); this.streamingText = ''; this.toolCards = []; },
    async send(text: string) {
      this.streamingText = ''; this.toolCards = [];
      this.messages.push({ id: 'local', role: 'user', parts: [{ type: 'text', value: text }] });
      await rpc.call('chat.prompt', { sessionId: this.activeId, text });
    },
    async createProvider(p: any) { await rpc.call('provider.instances.create', p); await this.refreshProviders(); },
    async respondPerm(requestId: string, decision: string) {
      this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId);
      await rpc.call('permission.respond', { requestId, decision });
    },
    onEvent(e: any) {
      if (e.kind === 'textDelta') this.streamingText += e.text;
      else if (e.kind === 'toolStart') this.toolCards.push({ toolUseId: e.toolUseId, name: e.name, title: e.title });
      else if (e.kind === 'toolEnd') { const c = this.toolCards.find(x => x.toolUseId === e.toolUseId); if (c) { c.output = e.output; c.success = e.success; } }
      else if (e.kind === 'turnEnd' || e.kind === 'error') { void this.open(this.activeId); }
    },
  },
});
