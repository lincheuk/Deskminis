import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataRoot, MinisPaths } from './paths';
import { openDb } from './store/db';
import { ChatStore } from './store/chat-store';
import { ProviderStore, KeyringVault, InMemoryVault, type SecretVault } from './store/provider-store';
import { ToolRegistry } from './tools/registry';
import { fileReadTool, fileWriteTool, fileEditTool } from './tools/files';
import { ShellManager, makeShellTool } from './tools/shell';
import { PermissionGatewayImpl, classifyShellCommand, type PermissionPrompt } from './tools/permissions';
import type { BridgePermissionKind, PermissionRequest } from './tools/types';
import { runAgentLoop, type ProviderSlot } from './agent/loop';
import { RpcServer } from './rpc/server';
import { ProviderError, type AgentProvider, type StreamRequest } from './providers/types';
import { PairingStore, PairingService } from './remote/pairing';
import { createRemoteMethods, createAdditionalVerify, guardBusinessMethod } from './remote';
import { SyncCoordinator, createSyncMethods } from './sync';
import type { AgentStreamEvent } from '../shared/types';
import { ModelCatalog } from './providers/model-catalog';
import { MemoryStore } from './store/memory-store';
import { MemoryInjector } from './store/memory-injector';
import { memoryWriteTool, memoryGetTool, MEMORY_TOOL_NAMES } from './tools/memory';
import { ContextPolicy } from './agent/context-policy';
import { OffloadEngine } from './agent/offload';
import { CompactEngine } from './agent/compact';
import { randomUUID } from 'node:crypto';
import { SkillStore, skillIdFromPath } from './skills/store';
import { buildSkillsBlock } from './skills/prompt';
import { SkillImporter, type ImportKind } from './skills/importer';
import { BridgeServer, bridgePipePath, makeBridgeEnv, resolveBridgeCliPath, resolveBridgeNode } from './bridge/server';
import { detectBridgeTriggers } from './bridge/detect';
import { makeBridgeDispatcher } from './bridge/handlers';
import { TerminalManager } from './terminal';
import { FilesService } from './files';

export const SYSTEM_PROMPT = '你是 DeskMinis，一个运行在用户 Windows 电脑上的 AI Agent。你可以读写文件、执行 PowerShell 命令来帮助用户完成任务。危险操作会请求用户确认。本机提供六个 Windows 能力桥，在 shell 中调用：& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> [参数]（若系统装有 Node.js，node "$env:MINIS_BRIDGE_CLI" ... 亦可）。工具：windows-notify（弹系统通知）、windows-clipboard（读/写剪贴板）、windows-open（用默认程序打开网址或文件）、windows-speak（语音播报文本）、windows-screenshot（截屏保存到会话附件目录）、windows-device（读取系统信息）。需要某个工具的详细参数时运行 & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> --help 查看；剪贴板读取与截屏等隐私敏感操作会向用户请求确认。';

/** sessionId 直接被拼进文件系统路径（paths.ensureSessionDirs），必须限死成 UUID 形态：
 *  '..\\..\\Windows' 这类值会逃出数据根，在宿主任意目录建目录/落文件。 */
const SESSION_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
function assertSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new Error('非法 sessionId');
  return id;
}

/** 权限询问未响应的兜底时限：与 PermissionGatewayImpl 的 askTimeoutMs 保持一致。 */
const PERM_TIMEOUT_MS = 90000;

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

export async function startMinisd(opts?: { dataDir?: string; host?: string; port?: number; permTimeoutMs?: number }): Promise<{ port: number; authToken: string; bridgePipe?: string; close(): Promise<void> }> {
  const root = opts?.dataDir ?? dataRoot();
  mkdirSync(root, { recursive: true });
  const paths = new MinisPaths(root);
  const db = openDb(join(root, 'minis.db'));
  // M3b 评审命门 3：PairingService 装配前移到 ChatStore 之前——
  // 静态身份（vault+dataDir）不依赖 db/chat，前移让 chat 构造时即可拿到 myFingerprint 注入 originDeviceId，
  // 避免 ChatStore 被多处引用（AgentLoop/CompactEngine/SyncCoordinator）前出现 setOriginDeviceId 注入空窗。
  const vault: SecretVault = process.env.DESKMINIS_TEST ? new InMemoryVault() : new KeyringVault();
  const pairingStore = new PairingStore(root, vault);
  const pairingService = new PairingService(pairingStore, vault);
  const chat = new ChatStore(db, pairingService.myFingerprint);
  const providers = new ProviderStore(root, vault);

  // 模型能力目录：后台预热 models.dev；失败静默回退磁盘缓存/内置兜底表
  const catalog = new ModelCatalog(join(root, 'models-dev-cache.json'));
  void catalog.refresh();

  // 权限：把询问经 RPC 广播给 UI，UI 用 permission.respond 回决议。
  // 广播给所有连接是安全的——RpcServer 现在要求 per-run token，能连上的只可能是本应用自己的窗口。
  interface PendingPerm {
    resolve: (d: 'allow-once' | 'allow-session' | 'deny') => void;
    timer: ReturnType<typeof setTimeout>;
    /** 原请求（决策 4c：respond 时取 sessionId 做桥合并授权）。 */
    req: PermissionRequest;
    /** shell 命令探测到的桥触发（决策 4b/4c；非桥命令恒为空数组）。 */
    bridgeTriggers: BridgePermissionKind[];
  }
  const pendingPerms = new Map<string, PendingPerm>();
  // 网关的兜底时限与这里的清理时限必须是同一个值，否则总有一侧留下悬挂状态
  const permTimeoutMs = opts?.permTimeoutMs ?? PERM_TIMEOUT_MS;
  let rpc: RpcServer;
  const prompt: PermissionPrompt = (req: PermissionRequest) => new Promise(resolve => {
    const requestId = randomUUID().toUpperCase();
    // 决策 4b：广播附 meta（超时秒数/风险分级/桥触发探测——bridgeTriggers 仅 shell kind 且探测非空时附加）
    const bridgeTriggers = req.kind === 'shell' ? detectBridgeTriggers(req.detail) : [];
    const meta: { timeoutMs: number; riskClass?: string; bridgeTriggers?: BridgePermissionKind[] } = { timeoutMs: permTimeoutMs };
    if (req.kind === 'shell') {
      meta.riskClass = classifyShellCommand(req.detail);
      if (bridgeTriggers.length > 0) meta.bridgeTriggers = bridgeTriggers;
    }
    // 超时不通知 UI 的话，卡片会永远留在界面上（而网关那边早已按 deny 继续），
    // 同时 pendingPerms 只增不减。到点主动清理 + 广播 resolved。
    const timer = setTimeout(() => {
      if (!pendingPerms.has(requestId)) return;
      pendingPerms.delete(requestId);
      rpc.broadcast('permission.resolved', { requestId, reason: 'timeout' }); // 决策 4b'：Task 10 超时留条的判定源
      resolve('deny');
    }, permTimeoutMs);
    timer.unref?.();
    pendingPerms.set(requestId, { resolve, timer, req, bridgeTriggers });
    rpc.broadcast('permission.request', { requestId, req, meta });
  });
  const gateway = new PermissionGatewayImpl(prompt, undefined, permTimeoutMs);

  // windows-* 桥：命名管道服务。占管（同数据根双实例）等失败只降级，不拖垮 minisd（架构决策 8）。
  // 装配位置说明：放在 shells/tools 之前（gateway 之后）而非 skills 装配段之后，是为了让下方
  // makeShellTool 的 envFor 闭包能引用 bridgePipe/bridgeCli 而不触发 TS2448（block-scoped used before declaration）。
  // envFor 是延迟执行（shell_execute 调用时才求值），运行时无 TDZ 问题；此位置符合计划指令 5 的备选。
  const bridgeCli = resolveBridgeCliPath();
  const bridgeNode = resolveBridgeNode();
  const pipePath = bridgePipePath(root);
  let bridge: BridgeServer | undefined;
  let bridgePipe: string | undefined;
  try {
    bridge = new BridgeServer(makeBridgeDispatcher({ permissions: gateway, paths }));
    await bridge.listen(pipePath);
    bridgePipe = pipePath;
  } catch (e) {
    console.warn('windows-* 桥服务监听失败，桥命令本次运行不可用:', e);
    bridge = undefined;
  }

  // 终端面板：交互式 powershell 独立实例（env 注入 MINIS_* 桥环境变量，#8 决策落地：用户可在终端手动调桥命令）
  const terminals = new TerminalManager(paths, (sessionId, data) => rpc.broadcast('terminal.output', { sessionId, data }),
    sessionId => makeBridgeEnv(sessionId, bridgePipe, bridgeCli, bridgeNode));
  const filesSvc = new FilesService(paths);

  const shells = new ShellManager();
  const tools = new ToolRegistry();
  tools.register(fileReadTool); tools.register(fileWriteTool); tools.register(fileEditTool);
  tools.register(makeShellTool(shells, ctx => makeBridgeEnv(ctx.sessionId, bridgePipe, bridgeCli, bridgeNode)));
  tools.register(memoryWriteTool); tools.register(memoryGetTool);

  // 记忆 + 压缩 + 卸载 引擎（设计 §3.4 + §4.2）
  const memoryStore = new MemoryStore(paths.globalDir('memory'));
  const memoryInjector = new MemoryInjector(memoryStore);
  const contextPolicy = new ContextPolicy(catalog);
  const offloadEngine = new OffloadEngine(paths);
  const compactEngine = new CompactEngine(chat);

  // ---- M2c 技能子系统装配：元数据在 minis.db（Task 2），正文永不预载（模型 file_read 自行读取）----
  const skillStore = new SkillStore(db);
  const skillsRoot = paths.globalDir('skills');
  mkdirSync(skillsRoot, { recursive: true });
  const importer = new SkillImporter(skillsRoot, skillStore, undefined, t => rpc.broadcast('skills.import.progress', t));
  // agent 直写目录的孤儿回收（设计 §5.1）：skillsRoot 下存在但不在表里的含 SKILL.md 目录入库
  importer.adoptOrphans();

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
      terminals.dispose(sessionId);
      chat.deleteSession(sessionId); return { ok: true };
    },
    'chat.sessions.setModelBinding': (p: { sessionId: string; binding?: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      chat.setModelBinding(sessionId, p.binding);
      return { ok: true };
    },
    'chat.sessions.setMemoryEnabled': (p: { sessionId: string; enabled: boolean }) => {
      const sessionId = assertSessionId(p.sessionId);
      chat.setMemoryEnabled(sessionId, p.enabled);
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

      // 记忆注入（设计 §3.4：每轮系统提示注入 GLOBAL/SOUL/日志）+ 工具过滤（memory_enabled=false 时排除记忆工具）
      const session = chat.getSession(sessionId);
      // 技能块属于 base，记忆注入包在最外层（技能与记忆是独立开关：memoryEnabled=false 时仍注入技能块）
      const baseWithSkills = SYSTEM_PROMPT + buildSkillsBlock(skillStore.listEnabledForSession(sessionId), skillsRoot, skillStore.nowEpoch());
      const injectedPrompt = memoryInjector.build(baseWithSkills, { memoryEnabled: session?.memoryEnabled ?? true });
      const excludedToolNames = (session?.memoryEnabled ?? true) ? undefined : new Set<string>(MEMORY_TOOL_NAMES);

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
            toolContext: {
              sessionId, paths, permissions: gateway,
              // use_count 采集点（Task 4 钩子）：仅恰好命中 <skillsRoot>/<id>/SKILL.md 的成功读取计数
              onFileRead: (abs) => {
                const id = skillIdFromPath(skillsRoot, abs);
                if (id && skillStore.get(id)) skillStore.bumpUseCount(id);
              },
            },
            systemPrompt: injectedPrompt, thinkingLevel: clampedThinking,
            signal: controller.signal,
            fallbackChain,
            contextPolicy, compactEngine, offloadEngine, excludedToolNames,
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
        // 决策 4c 桥双段授权合并：shell 卡批准时，对探测到的每个桥 kind 同步授权（会话级/一次性计数）
        if (p.decision === 'allow-session') for (const k of entry.bridgeTriggers) gateway.grantBridgeSession(entry.req.sessionId, k);
        else if (p.decision === 'allow-once') for (const k of entry.bridgeTriggers) gateway.grantBridgeOnce(entry.req.sessionId, k);
        entry.resolve(p.decision);
        // 同一个请求可能在多个窗口里显示：告诉所有客户端这张卡片已了结
        rpc.broadcast('permission.resolved', { requestId: p.requestId, reason: 'answered' }); // 决策 4b'
      }
      return { ok: true };
    },
    // ---- M2d: terminal.* + files.* + chat.contextInfo（水位条小型 RPC）----
    'terminal.attach': (p: { sessionId: string }) => ({ scrollback: terminals.attach(assertSessionId(p.sessionId)) }),
    'terminal.input': (p: { sessionId: string; data: string }) => { terminals.input(assertSessionId(p.sessionId), String(p.data ?? '')); return { ok: true }; },
    'files.list': (p: { sessionId: string; dir?: string }) => filesSvc.list(assertSessionId(p.sessionId), typeof p.dir === 'string' ? p.dir : undefined),
    'files.read': (p: { sessionId: string; path: string }) => filesSvc.read(assertSessionId(p.sessionId), String(p.path ?? '')),
    // chat.contextInfo（M2a 红线：usedTokens 必须基于 buildEffectiveHistory，禁止用原始 history 直接估算）
    'chat.contextInfo': (p: { sessionId: string }) => {
      const sid = assertSessionId(p.sessionId);
      const history = chat.listMessages(sid);
      const marker = chat.getLatestCompactMarker(sid);
      const effective = compactEngine.buildEffectiveHistory(history, marker);
      const usedTokens = contextPolicy.estimateTokens(effective);
      // 复用 chat.prompt（L217-L234）的会话绑定→provider/模型组解析链（内联复刻；模型组取链首 slot）
      let modelId: string;
      const session = chat.getSession(sid);
      const binding = session?.modelBinding;
      if (binding?.startsWith('group:')) {
        const members = providers.resolveGroupMembers(binding.slice('group:'.length));
        modelId = members[0] ? (fakeEnabled ? 'fake' : members[0].instance.modelId) : 'unknown';
      } else if (binding?.startsWith('provider:')) {
        const pid = binding.slice('provider:'.length);
        const prov = (fakeEnabled && pid === '__fake__') ? new FakeProvider() : providers.instantiate(pid);
        modelId = prov.modelId;
      } else {
        const defaultId = providers.getDefaultId();
        if (defaultId) {
          const prov = (fakeEnabled && defaultId === '__fake__') ? new FakeProvider() : providers.instantiate(defaultId);
          modelId = prov.modelId;
        } else {
          modelId = 'unknown';
        }
      }
      // 32000 对齐 context-policy.ts FALLBACK_WINDOW（未导出常量）
      const windowTokens = modelId === 'unknown' ? 32000 : (catalog.getModelContextWindow(modelId) ?? 32000);
      return { windowTokens, usedTokens, remaining: Math.max(0, windowTokens - usedTokens) };
    },
    // ---- M2c 技能 RPC 面 ----
    'skills.list': (p: { sessionId?: string }) =>
      // 带 sessionId 返回该会话的生效启用集（会话覆盖优先）；不带返回全部（含禁用）
      p.sessionId !== undefined ? skillStore.listEnabledForSession(assertSessionId(p.sessionId)) : skillStore.list(),
    'skills.import': (p: { kind: ImportKind; source: string }) => {
      if (p.kind !== 'github-url' && p.kind !== 'zip' && p.kind !== 'folder') throw new Error(`未知导入方式: ${String(p.kind)}`);
      if (typeof p.source !== 'string' || p.source.trim() === '') throw new Error('source 不能为空');
      return importer.startImport(p.kind, p.source.trim()); // 后台任务：脱离 UI 生命周期，进度走 importStatus/广播
    },
    'skills.importStatus': (p: { taskId?: string }) =>
      p.taskId !== undefined ? importer.status(p.taskId) ?? null : importer.listTasks(),
    'skills.setEnabled': (p: { id: string; enabled: boolean; sessionId?: string }) => {
      if (typeof p.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
      // 带 sessionId 写会话覆盖，否则写全局开关（技能不存在由 store 抛错）
      if (p.sessionId !== undefined) skillStore.setSessionOverride(assertSessionId(p.sessionId), p.id, p.enabled);
      else skillStore.setEnabled(p.id, p.enabled);
      rpc.broadcast('skills.changed', {});
      return { ok: true };
    },
    'skills.delete': (p: { id: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除技能需 confirm:true');
      // 存在性检查同时是路径穿越防线：能入库的 id 只会是 slug 或 readdir 单层目录名，join 不会逃出 skillsRoot
      if (!skillStore.get(p.id)) throw new Error(`技能不存在: ${p.id}`);
      // 先删目录再删表行：顺序反过来时，目录删除失败留下的残骸会在下次启动被孤儿回收「复活」
      rmSync(join(skillsRoot, p.id), { recursive: true, force: true });
      skillStore.delete(p.id); // 表行 + 会话覆盖（事务）
      rpc.broadcast('skills.changed', {});
      return { ok: true };
    },
  };

  const authToken = randomUUID().toUpperCase();

  // M3a 接线：PairingService 已前移至 ChatStore 之前（评审命门 3），此处仅接线 remote.* 方法面 + additionalVerify。
  // 沿用 M1 vault/keyring 路径（KeyringVault L26-36）；DESKMINIS_TEST=1 时 vault 已是 InMemoryVault
  // StaticIdentity 首次生成后持久化到 vault，后续启动复用（设计 §2.1「长期身份」）
  const remoteMethods = createRemoteMethods(pairingService);
  // 业务面方法（chat.*/permission.*/skills.* 等）统一加 pairing 模式守卫（红线 4c）：
  // pairing 模式只能调 remote.pair.complete，其他业务面全拒。
  // remote.* 方法自带 assertAuthMode 守卫，不重复包装。
  for (const k of Object.keys(methods)) {
    if (!k.startsWith('remote.')) (methods as any)[k] = guardBusinessMethod((methods as any)[k], k);
  }
  Object.assign(methods, remoteMethods);
  const additionalVerify = createAdditionalVerify(pairingService);

  // M3b 接线：sync.* 方法面（经 guardBusinessMethod 包装拒 pairing，红线 4e——sync.* 唯一接触点）
  // 注：计划伪代码先写 methods[k]=guard(syncMethods[k]) 再 Object.assign(methods, syncMethods) 会用未包装版本覆盖——
  // 最小修正为原地包装 syncMethods 后再 assign（Produces 接口不变：sync.* 仍经 guardBusinessMethod 拒 pairing）。
  const syncMethods = createSyncMethods(chat);
  for (const k of Object.keys(syncMethods)) {
    (syncMethods as any)[k] = guardBusinessMethod((syncMethods as any)[k], k);
  }
  Object.assign(methods, syncMethods);

  rpc = new RpcServer(methods, authToken, additionalVerify);
  const port = await rpc.listen(opts?.host ?? '127.0.0.1', opts?.port ?? 0);

  // M3b 接线：SyncCoordinator（服务端被动，评审命门 4）——chat.onDirty 去抖广播 sync.dirty
  const syncCoordinator = new SyncCoordinator(chat, rpc);
  chat.onDirty = sid => syncCoordinator.onDirty(sid);
  syncCoordinator.start(); // 空实现（评审命门 4），保留调用供 M3c 扩展

  return {
    port, authToken, bridgePipe,
    close: async () => {
      syncCoordinator.stop();
      for (const c of controllers.values()) c.abort();
      for (const { timer } of pendingPerms.values()) clearTimeout(timer);
      pendingPerms.clear();
      terminals.disposeAll(); shells.disposeAll(); await bridge?.close(); await rpc.close(); db.close();
    },
  };
}

// 作为独立进程启动时（Electron utilityProcess / --headless）
if (process.env.DESKMINIS_STANDALONE === '1') {
  // M3a：MINISD_HOST env 接线（设计 §3.1）——main/index.ts utilityProcess.fork 时 env 注入，
  // standalone 分支读 env 传入 startMinisd({ host })，不改 startMinisd 签名。
  // 默认 127.0.0.1（仅本机）；设 0.0.0.0 开放局域网（配 PASETO/配对码鉴权）。
  const startOpts = process.env.MINISD_HOST ? { host: process.env.MINISD_HOST } : undefined;
  startMinisd(startOpts)
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
