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

/** sessionId 直接被拼进文件系统路径（paths.ensureSessionDirs），必须限死成 UUID 形态：
 *  '..\\..\\Windows' 这类值会逃出数据根，在宿主任意目录建目录/落文件。 */
const SESSION_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
function assertSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new Error('非法 sessionId');
  return id;
}

/** 权限询问未响应的兜底时限：与 PermissionGatewayImpl 的 askTimeoutMs 保持一致。 */
const PERM_TIMEOUT_MS = 30000;

/** 假 provider（仅测试用，DESKMINIS_FAKE_PROVIDER=1 时对 providerId '__fake__' 生效） */
class FakeProvider implements AgentProvider {
  readonly name = 'fake'; readonly modelId = 'fake';
  /** 脚本化的工具调用只发一次：否则用户消息一直是 __tool__ 前缀，循环会一路撞到 maxTurns。 */
  private toolCallSpent = false;

  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    const script = this.parseScript(req);
    if (script && !this.toolCallSpent) {
      this.toolCallSpent = true;
      yield { kind: 'toolCallComplete', toolUseId: randomUUID().toUpperCase(), name: script.name, input: script.input };
      yield { kind: 'done', stopReason: 'toolUse' };
      return;
    }
    yield { kind: 'textDelta', text: '（假回复）' };
    // 真 provider 是网络 I/O：这里也让出一个宏任务，否则整个 agent 循环在微任务里
    // 一口气跑完，"会话运行中"这个状态在外部永远观察不到（并发锁将无法测试）。
    await new Promise(r => setTimeout(r, 30));
    yield { kind: 'done', stopReason: 'endTurn' };
  }

  /** 首条用户文本形如 `__tool__ <工具名> <inputJSON>` 时，改为发起一次工具调用。 */
  private parseScript(req: StreamRequest): { name: string; input: string } | undefined {
    for (const m of req.messages) {
      if (m.role !== 'user') continue;
      for (const part of m.parts) {
        const value: unknown = part.value; // ContentPart 有兜底成员 { type: string; value: unknown }，判别式收窄不生效
        if (part.type !== 'text' || typeof value !== 'string') continue;
        const m2 = /^__tool__ (\S+) ([\s\S]+)$/.exec(value);
        if (m2) return { name: m2[1], input: m2[2] };
      }
    }
    return undefined;
  }
}

export async function startMinisd(opts?: { dataDir?: string; host?: string; port?: number; permTimeoutMs?: number }): Promise<{ port: number; authToken: string; close(): Promise<void> }> {
  const root = opts?.dataDir ?? dataRoot();
  mkdirSync(root, { recursive: true });
  const paths = new MinisPaths(root);
  const db = openDb(join(root, 'minis.db'));
  const chat = new ChatStore(db);
  const vault: SecretVault = process.env.DESKMINIS_TEST ? new InMemoryVault() : new KeyringVault();
  const providers = new ProviderStore(root, vault);

  // 权限：把询问经 RPC 广播给 UI，UI 用 permission.respond 回决议。
  // 广播给所有连接是安全的——RpcServer 现在要求 per-run token，能连上的只可能是本应用自己的窗口。
  interface PendingPerm { resolve: (d: 'allow-once' | 'allow-session' | 'deny') => void; timer: ReturnType<typeof setTimeout> }
  const pendingPerms = new Map<string, PendingPerm>();
  // 网关的兜底时限与这里的清理时限必须是同一个值，否则总有一侧留下悬挂状态
  const permTimeoutMs = opts?.permTimeoutMs ?? PERM_TIMEOUT_MS;
  let rpc: RpcServer;
  const prompt: PermissionPrompt = (req: PermissionRequest) => new Promise(resolve => {
    const requestId = randomUUID().toUpperCase();
    // 超时不通知 UI 的话，卡片会永远留在界面上（而网关那边早已按 deny 继续），
    // 同时 pendingPerms 只增不减。到点主动清理 + 广播 resolved。
    const timer = setTimeout(() => {
      if (!pendingPerms.has(requestId)) return;
      pendingPerms.delete(requestId);
      rpc.broadcast('permission.resolved', { requestId });
      resolve('deny');
    }, permTimeoutMs);
    timer.unref?.();
    pendingPerms.set(requestId, { resolve, timer });
    rpc.broadcast('permission.request', { requestId, req });
  });
  const gateway = new PermissionGatewayImpl(prompt, undefined, permTimeoutMs);

  const shells = new ShellManager();
  const tools = new ToolRegistry();
  tools.register(fileReadTool); tools.register(fileWriteTool); tools.register(fileEditTool);
  tools.register(makeShellTool(shells));

  const fakeEnabled = process.env.DESKMINIS_FAKE_PROVIDER === '1';

  /** 同一会话同时只允许跑一个 agent 循环：两个循环会读到彼此写了一半的历史，
   *  交错落库出 Anthropic 直接 400 的消息序列（tool_use 没有配对的 tool_result）。 */
  const inFlight = new Set<string>();
  const controllers = new Map<string, AbortController>();

  const methods = {
    'chat.sessions.list': () => chat.listSessions(),
    'chat.sessions.create': (p: { title?: string }) => chat.createSession(p.title),
    'chat.sessions.delete': (p: { sessionId: string; confirm?: boolean }) => {
      const sessionId = assertSessionId(p.sessionId);
      if (p.confirm !== true) throw new Error('删除会话需 confirm:true');
      chat.deleteSession(sessionId); return { ok: true };
    },
    'chat.messages.list': (p: { sessionId: string }) => chat.listMessages(assertSessionId(p.sessionId)),
    'chat.prompt': (p: { sessionId: string; text: string; providerId?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' }) => {
      const sessionId = assertSessionId(p.sessionId);
      // 纯空白的 text block 会被 Anthropic 以 400 拒收，而消息此时已落库 ⇒ 该会话此后每次请求都失败（永久变砖）
      if (typeof p.text !== 'string' || p.text.trim() === '') throw new Error('消息内容不能为空');
      if (inFlight.has(sessionId)) throw new Error('该会话正在运行中，请等待完成或取消');
      // 先解析 provider 再落库：否则首次运行（未配置 provider）会留下孤儿用户消息
      const providerId = p.providerId ?? providers.getDefaultId();
      if (!providerId) throw new Error('尚未配置任何模型 provider，请先在设置中添加');
      const provider: AgentProvider = (fakeEnabled && providerId === '__fake__')
        ? new FakeProvider()
        : providers.instantiate(providerId);
      // 从这里到 IIFE 启动之间没有 await：占位与释放不会被别的请求插进来
      inFlight.add(sessionId);
      const controller = new AbortController();
      controllers.set(sessionId, controller);
      chat.appendMessage({ id: chat.newId(), sessionId, role: 'user', parts: [{ type: 'text', value: p.text }], createdAt: chat.nowEpoch(), streamInterruptCount: 0 });
      paths.ensureSessionDirs(sessionId);
      void (async () => {
        try {
          for await (const event of runAgentLoop(chat, {
            sessionId, provider, tools,
            toolContext: { sessionId, paths, permissions: gateway },
            systemPrompt: SYSTEM_PROMPT, thinkingLevel: p.thinkingLevel ?? 'off',
            signal: controller.signal,
          })) rpc.broadcast('chat.event', { sessionId, event });
        } catch (e) { rpc.broadcast('chat.event', { sessionId, event: { kind: 'error', message: String(e) } }); }
        finally { inFlight.delete(sessionId); controllers.delete(sessionId); }
      })();
      return { ok: true };
    },
    'chat.cancel': (p: { sessionId: string }) => {
      const c = controllers.get(assertSessionId(p.sessionId));
      if (c) c.abort();
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
      const entry = pendingPerms.get(p.requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingPerms.delete(p.requestId);
        entry.resolve(p.decision);
        // 同一个请求可能在多个窗口里显示：告诉所有客户端这张卡片已了结
        rpc.broadcast('permission.resolved', { requestId: p.requestId });
      }
      return { ok: true };
    },
  };

  const authToken = randomUUID().toUpperCase();
  rpc = new RpcServer(methods, authToken);
  const port = await rpc.listen(opts?.host ?? '127.0.0.1', opts?.port ?? 0);
  return {
    port, authToken,
    close: async () => {
      for (const c of controllers.values()) c.abort();
      for (const { timer } of pendingPerms.values()) clearTimeout(timer);
      pendingPerms.clear();
      shells.disposeAll(); await rpc.close(); db.close();
    },
  };
}

// 作为独立进程启动时（Electron utilityProcess / --headless）
if (process.env.DESKMINIS_STANDALONE === '1') {
  startMinisd()
    // 握手行同时交出 token：主进程必须把它经 ipcMain.handle('minisd:info') 交给渲染进程，
    // 否则渲染进程连不上自己的守护进程。
    .then(({ port, authToken }) => { process.stdout.write(JSON.stringify({ minisdPort: port, authToken }) + '\n'); })
    // 没有 .catch 的话，DB / 密钥库任一失败都只是一次未处理拒绝：进程静默退出，
    // 父进程只能看到 "exit code=1"，真正的原因（哪一行、什么错）永远看不到。
    .catch(e => {
      process.stderr.write('minisd 启动失败: ' + (e instanceof Error ? e.stack ?? e.message : String(e)) + '\n');
      process.exit(1);
    });
}
