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
import { runAgentLoop, type ProviderSlot } from './agent/loop';
import { RpcServer } from './rpc/server';
import { ProviderError, type AgentProvider, type StreamRequest } from './providers/types';
import type { AgentStreamEvent } from '../shared/types';
import { ModelCatalog } from './providers/model-catalog';
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
    // 测试用：用户文本 __fail__ → 抛 fallbackable 错误（模拟限流/无效 key）
    const fail = this.parseFail(req);
    if (fail) throw new ProviderError(fail, { status: 429 });
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

  /** 测试用：首条用户文本形如 `__fail__ <原因>` 时，返回原因（触发 fallbackable 抛错）。 */
  private parseFail(req: StreamRequest): string | undefined {
    for (const m of req.messages) {
      if (m.role !== 'user') continue;
      for (const part of m.parts) {
        const value: unknown = part.value;
        if (part.type !== 'text' || typeof value !== 'string') continue;
        const m2 = /^__fail__\s+(.+)$/.exec(value);
        if (m2) return m2[1];
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

  // 模型能力目录：后台预热 models.dev；失败静默回退磁盘缓存/内置兜底表
  const catalog = new ModelCatalog(join(root, 'models-dev-cache.json'));
  void catalog.refresh();

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
    'chat.sessions.setModelBinding': (p: { sessionId: string; binding?: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      chat.setModelBinding(sessionId, p.binding);
      return { ok: true };
    },
    'chat.messages.list': (p: { sessionId: string }) => chat.listMessages(assertSessionId(p.sessionId)),
    'chat.prompt': (p: { sessionId: string; text: string; providerId?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high'; modelGroupId?: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      // 纯空白的 text block 会被 Anthropic 以 400 拒收，而消息此时已落库 ⇒ 该会话此后每次请求都失败（永久变砖）
      if (typeof p.text !== 'string' || p.text.trim() === '') throw new Error('消息内容不能为空');
      if (inFlight.has(sessionId)) throw new Error('该会话正在运行中，请等待完成或取消');

      // ── 链式解析 provider + fallbackChain ──
      let provider: AgentProvider;
      let fallbackChain: ProviderSlot[] = [];

      if (p.modelGroupId) {
        // 显式指定模型组
        const members = providers.resolveGroupMembers(p.modelGroupId);
        if (members.length === 0) throw new Error('模型组无可用成员');
        provider = fakeEnabled ? new FakeProvider() : members[0].instantiate();
        fallbackChain = members.slice(1).map(m => ({ provider: fakeEnabled ? new FakeProvider() : m.instantiate(), label: `${m.instance.name}(${m.instance.modelId})`, instanceId: m.instance.id }));
      } else if (p.providerId) {
        // 显式指定单 provider（M1 既有行为）
        provider = (fakeEnabled && p.providerId === '__fake__') ? new FakeProvider() : providers.instantiate(p.providerId);
      } else {
        // 从会话绑定解析
        const session = chat.getSession(sessionId);
        const binding = session?.modelBinding;
        if (binding?.startsWith('group:')) {
          const gid = binding.slice('group:'.length);
          const members = providers.resolveGroupMembers(gid);
          if (members.length === 0) throw new Error('模型组无可用成员');
          provider = fakeEnabled ? new FakeProvider() : members[0].instantiate();
          fallbackChain = members.slice(1).map(m => ({ provider: fakeEnabled ? new FakeProvider() : m.instantiate(), label: `${m.instance.name}(${m.instance.modelId})`, instanceId: m.instance.id }));
        } else if (binding?.startsWith('provider:')) {
          const pid = binding.slice('provider:'.length);
          provider = (fakeEnabled && pid === '__fake__') ? new FakeProvider() : providers.instantiate(pid);
        } else {
          // 未绑定 → 默认 provider（M1 既有行为）
          const defaultId = providers.getDefaultId();
          if (!defaultId) throw new Error('尚未配置任何模型 provider，请先在设置中添加');
          provider = (fakeEnabled && defaultId === '__fake__') ? new FakeProvider() : providers.instantiate(defaultId);
        }
      }

      // thinkingLevel 钳制（Task 4）
      const clampedThinking = catalog.clampThinkingLevel(provider.modelId, p.thinkingLevel ?? 'off');

      // 从这里到 IIFE 启动之间没有 await：占位与释放不会被别的请求插进来
      inFlight.add(sessionId);
      const controller = new AbortController();
      controllers.set(sessionId, controller);
      chat.appendMessage({ id: chat.newId(), sessionId, role: 'user', parts: [{ type: 'text', value: p.text }], createdAt: chat.nowEpoch(), streamInterruptCount: 0 });
      paths.ensureSessionDirs(sessionId);
      void (async () => {
        let pendingRebind: string | undefined; // 降级候选 instanceId，等 turnEnd 才落库
        let rebound = false; // 是否已改写绑定（只改一次）
        try {
          for await (const event of runAgentLoop(chat, {
            sessionId, provider, tools,
            toolContext: { sessionId, paths, permissions: gateway },
            systemPrompt: SYSTEM_PROMPT, thinkingLevel: clampedThinking,
            signal: controller.signal,
            fallbackChain,
          })) {
            // fallback 事件：记下候选 instanceId，但不立即改写——等该 slot 真正跑通（turnEnd）才落库
            if (event.kind === 'fallback' && !rebound) {
              const target = fallbackChain.find(s => s.label === event.to) as (ProviderSlot & { instanceId?: string }) | undefined;
              if (target?.instanceId) pendingRebind = target.instanceId;
            }
            // turnEnd：该 slot 真正跑通，执行推迟的改写
            if (event.kind === 'turnEnd' && !rebound && pendingRebind) {
              rebound = true;
              chat.setModelBinding(sessionId, `provider:${pendingRebind}`);
              pendingRebind = undefined;
            }
            rpc.broadcast('chat.event', { sessionId, event });
          }
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
    'provider.instances.create': (p: { name: string; kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl?: string; modelId: string; apiKey?: string }) => {
      const baseUrl = (typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '') || undefined;
      if (p.kind === 'openai-compat' && !baseUrl) throw new Error('OpenAI 兼容 provider 需要 base URL');
      // ollama 本地端点免 key；其余类型必须带 key
      if (p.kind !== 'ollama' && (typeof p.apiKey !== 'string' || p.apiKey === '')) throw new Error('该 provider 类型需要 API key');
      return providers.create({ name: p.name, kind: p.kind, baseUrl, modelId: p.modelId }, p.apiKey || undefined);
    },
    /** 改配置不必删了重建；apiKey 省略/空串 = 保留原密钥（前端也永远拿不到旧密钥回显）。 */
    'provider.instances.update': (p: { id: string; name?: string; kind?: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl?: string; modelId?: string; apiKey?: string }) => {
      const cur = providers.list().find(x => x.id === p.id);
      if (!cur) throw new Error(`provider 不存在: ${p.id}`);
      const patch: Partial<{ name: string; kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl: string | undefined; modelId: string }> & { apiKey?: string } = {};
      if (typeof p.name === 'string' && p.name.trim()) patch.name = p.name.trim();
      if (p.kind === 'anthropic' || p.kind === 'openai-compat' || p.kind === 'gemini' || p.kind === 'ollama') patch.kind = p.kind;
      if (typeof p.modelId === 'string' && p.modelId.trim()) patch.modelId = p.modelId.trim();
      if (p.baseUrl !== undefined) patch.baseUrl = (typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '') || undefined;
      if (typeof p.apiKey === 'string' && p.apiKey !== '') patch.apiKey = p.apiKey;
      // 校验「改完之后」的形态，而不是补丁本身：openai-compat 没有 base URL 无法请求
      const kind = patch.kind ?? cur.kind;
      const baseUrl = 'baseUrl' in patch ? patch.baseUrl : cur.baseUrl;
      if (kind === 'openai-compat' && !baseUrl) throw new Error('OpenAI 兼容 provider 需要 base URL');
      providers.update(p.id, patch);
      return { ok: true };
    },
    'provider.instances.delete': (p: { id: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除 provider 需 confirm:true');
      providers.delete(p.id); return { ok: true };
    },
    'provider.setDefault': (p: { id: string }) => { providers.setDefaultId(p.id); return { ok: true }; },
    // ── ModelGroup ──
    'modelgroup.create': (p: { name: string; memberIds: string[] }) => {
      if (typeof p.name !== 'string' || p.name.trim() === '') throw new Error('模型组名称不能为空');
      if (!Array.isArray(p.memberIds) || p.memberIds.length === 0) throw new Error('模型组至少需要一个成员');
      return providers.createGroup(p.name.trim(), p.memberIds);
    },
    'modelgroup.list': () => providers.listGroups(),
    'modelgroup.get': (p: { id: string }) => {
      const g = providers.getGroup(p.id);
      if (!g) throw new Error(`模型组不存在: ${p.id}`);
      return g;
    },
    'modelgroup.update': (p: { id: string; name?: string; memberIds?: string[] }) => {
      const patch: { name?: string; memberIds?: string[] } = {};
      if (typeof p.name === 'string' && p.name.trim()) patch.name = p.name.trim();
      if (Array.isArray(p.memberIds) && p.memberIds.length > 0) patch.memberIds = p.memberIds;
      providers.updateGroup(p.id, patch);
      return { ok: true };
    },
    'modelgroup.delete': (p: { id: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除模型组需 confirm:true');
      providers.deleteGroup(p.id);
      return { ok: true };
    },
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
