import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataRoot, MinisPaths } from './paths';
import { openDb } from './store/db';
import { ChatStore } from './store/chat-store';
import { ProviderStore, KeyringVault, InMemoryVault, type SecretVault } from './store/provider-store';
import { ToolRegistry } from './tools/registry';
import { fileReadTool, fileWriteTool, fileEditTool } from './tools/files';
import { ShellManager, makeShellTool } from './tools/shell';
import { PermissionGatewayImpl, type PermissionPrompt } from './tools/permissions';
import type { PermissionRequest } from './tools/types';
import { runAgentLoop } from './agent/loop';
import { RpcServer } from './rpc/server';
import type { AgentProvider, StreamRequest } from './providers/types';
import type { AgentStreamEvent } from '../shared/types';
import { randomUUID } from 'node:crypto';

const SYSTEM_PROMPT = '你是 DeskMinis，一个运行在用户 Windows 电脑上的 AI Agent。你可以读写文件、执行 PowerShell 命令来帮助用户完成任务。危险操作会请求用户确认。';

/** 假 provider（仅测试用，DESKMINIS_FAKE_PROVIDER=1 时对 providerId '__fake__' 生效） */
class FakeProvider implements AgentProvider {
  readonly name = 'fake'; readonly modelId = 'fake';
  async *streamAgentMessage(_req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    yield { kind: 'textDelta', text: '（假回复）' };
    yield { kind: 'done', stopReason: 'endTurn' };
  }
}

export async function startMinisd(opts?: { dataDir?: string; host?: string; port?: number }): Promise<{ port: number; close(): Promise<void> }> {
  const root = opts?.dataDir ?? dataRoot();
  mkdirSync(root, { recursive: true });
  const paths = new MinisPaths(root);
  const db = openDb(join(root, 'minis.db'));
  const chat = new ChatStore(db);
  const vault: SecretVault = process.env.DESKMINIS_TEST ? new InMemoryVault() : new KeyringVault();
  const providers = new ProviderStore(root, vault);

  // 权限：把询问经 RPC 广播给 UI，UI 用 permission.respond 回决议
  const pendingPerms = new Map<string, (d: 'allow-once' | 'allow-session' | 'deny') => void>();
  let rpc: RpcServer;
  const prompt: PermissionPrompt = (req: PermissionRequest) => new Promise(resolve => {
    const requestId = randomUUID();
    pendingPerms.set(requestId, resolve);
    rpc.broadcast('permission.request', { requestId, req });
  });
  const gateway = new PermissionGatewayImpl(prompt);

  const shells = new ShellManager();
  const tools = new ToolRegistry();
  tools.register(fileReadTool); tools.register(fileWriteTool); tools.register(fileEditTool);
  tools.register(makeShellTool(shells));

  const fakeEnabled = process.env.DESKMINIS_FAKE_PROVIDER === '1';

  const methods = {
    'chat.sessions.list': () => chat.listSessions(),
    'chat.sessions.create': (p: { title?: string }) => chat.createSession(p.title),
    'chat.sessions.delete': (p: { sessionId: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除会话需 confirm:true');
      chat.deleteSession(p.sessionId); return { ok: true };
    },
    'chat.messages.list': (p: { sessionId: string }) => chat.listMessages(p.sessionId),
    'chat.prompt': (p: { sessionId: string; text: string; providerId?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' }) => {
      chat.appendMessage({ id: chat.newId(), sessionId: p.sessionId, role: 'user', parts: [{ type: 'text', value: p.text }], createdAt: chat.nowEpoch(), streamInterruptCount: 0 });
      const provider: AgentProvider = (fakeEnabled && p.providerId === '__fake__')
        ? new FakeProvider()
        : providers.instantiate(p.providerId ?? providers.getDefaultId()!);
      paths.ensureSessionDirs(p.sessionId);
      void (async () => {
        try {
          for await (const event of runAgentLoop(chat, {
            sessionId: p.sessionId, provider, tools,
            toolContext: { sessionId: p.sessionId, paths, permissions: gateway },
            systemPrompt: SYSTEM_PROMPT, thinkingLevel: p.thinkingLevel ?? 'off',
          })) rpc.broadcast('chat.event', { sessionId: p.sessionId, event });
        } catch (e) { rpc.broadcast('chat.event', { sessionId: p.sessionId, event: { kind: 'error', message: String(e) } }); }
      })();
      return { ok: true };
    },
    'provider.instances.list': () => providers.list(),
    'provider.instances.create': (p: { name: string; kind: 'anthropic' | 'openai-compat'; baseUrl?: string; modelId: string; apiKey: string }) =>
      providers.create({ name: p.name, kind: p.kind, baseUrl: p.baseUrl, modelId: p.modelId }, p.apiKey),
    'provider.instances.delete': (p: { id: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除 provider 需 confirm:true');
      providers.delete(p.id); return { ok: true };
    },
    'provider.setDefault': (p: { id: string }) => { providers.setDefaultId(p.id); return { ok: true }; },
    'permission.respond': (p: { requestId: string; decision: 'allow-once' | 'allow-session' | 'deny' }) => {
      const resolve = pendingPerms.get(p.requestId);
      if (resolve) { resolve(p.decision); pendingPerms.delete(p.requestId); }
      return { ok: true };
    },
  };

  rpc = new RpcServer(methods);
  const port = await rpc.listen(opts?.host ?? '127.0.0.1', opts?.port ?? 0);
  return { port, close: async () => { shells.disposeAll(); await rpc.close(); db.close(); } };
}

// 作为独立进程启动时（Electron utilityProcess / --headless）
if (process.env.DESKMINIS_STANDALONE === '1') {
  startMinisd().then(({ port }) => { process.stdout.write(JSON.stringify({ minisdPort: port }) + '\n'); });
}
