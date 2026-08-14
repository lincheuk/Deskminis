import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataRoot, MinisPaths } from './paths';
import { openDb } from './store/db';
import { AuditLogger, auditRedact, type AuditListOpts } from './store/audit';
import { SettingsStore, SYNC_PAUSE_KEY, PERMISSION_PRESET_KEY } from './store/settings';

/** 全局「上次用过的工作区」——新建会话继承它（用户拍板：每会话各自设 + 继承上次）。 */
const WORKSPACE_LAST_KEY = 'workspace.lastUsed';
import { ChatStore } from './store/chat-store';
import { ProviderStore, KeyringVault, InMemoryVault, FileVault, type SecretVault } from './store/provider-store';
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
import { SyncCoordinator, createSyncMethods, OutboundClient } from './sync';
import type { AgentStreamEvent } from '../shared/types';
import { ModelCatalog, createProxyFetch } from './providers/model-catalog';
import { MemoryStore } from './store/memory-store';
import { MemoryInjector } from './store/memory-injector';
import { memoryWriteTool, memoryGetTool, MEMORY_TOOL_NAMES } from './tools/memory';
import { ContextPolicy } from './agent/context-policy';
import { OffloadEngine } from './agent/offload';
import { CompactEngine } from './agent/compact';
import { createStableCache } from './agent/system-prompt';
import { buildDisciplineBlock } from './agent/model-discipline';
import { createDiagnosticsMethods } from './diagnostics';
import { randomUUID } from 'node:crypto';
import { SkillStore, skillIdFromPath } from './skills/store';
import { buildSkillsBlock } from './skills/prompt';
import { SkillImporter, type ImportKind } from './skills/importer';
import { BridgeServer, bridgePipePath, makeBridgeEnv, resolveBridgeCliPath, resolveBridgeNode } from './bridge/server';
import { detectBridgeTriggers } from './bridge/detect';
import { makeBridgeDispatcher } from './bridge/handlers';
import { TerminalManager } from './terminal';
import { FilesService } from './files';

export { SYSTEM_PROMPT } from './agent/system-prompt';

/** sessionId 直接被拼进文件系统路径（paths.ensureSessionDirs），必须限死成 UUID 形态：
 *  '..\\..\\Windows' 这类值会逃出数据根，在宿主任意目录建目录/落文件。 */
const SESSION_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
function assertSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new Error('非法 sessionId');
  return id;
}

/** 权限询问未响应的兜底时限：与 PermissionGatewayImpl 的 askTimeoutMs 保持一致。 */
const PERM_TIMEOUT_MS = 90000;

/** M3c Task 4：端口持久化文件名（必改 4b）。 */
const PORT_FILE = 'minisd-port.json';

/**
 * M3c Task 4：端口持久化（必改 4b）——读 minisd-port.json → 复用 → 占用回退随机 → 写文件。
 * @param dataDir 数据根目录
 * @param host 监听地址
 * @param requestedPort 调用方请求的端口（0 = 不指定，读文件复用）
 * @param listen 实际监听函数（host, port）→ 实际端口
 * @returns 实际监听端口
 */
export async function resolveAndPersistPort(
  dataDir: string,
  host: string,
  requestedPort: number,
  listen: (host: string, port: number) => Promise<number>,
  authToken?: string,
): Promise<number> {
  const portFile = join(dataDir, PORT_FILE);
  // 读持久化端口
  let preferred = requestedPort;
  if (preferred === 0 && existsSync(portFile)) {
    try {
      const obj = JSON.parse(readFileSync(portFile, 'utf8').replace(/\r\n/g, '\n'));
      if (typeof obj.port === 'number' && obj.port > 0) preferred = obj.port;
    } catch { /* 文件损坏，忽略 */ }
  }
  // 尝试 preferred port
  if (preferred > 0) {
    try {
      const port = await listen(host, preferred);
      writePersistedPort(portFile, port, authToken);
      return port;
    } catch { /* 端口被占用，回退随机 */ }
  }
  // 随机分配
  const port = await listen(host, 0);
  writePersistedPort(portFile, port, authToken);
  return port;
}

function writePersistedPort(portFile: string, port: number, authToken?: string): void {
  const tmp = portFile + '.tmp';
  const data: Record<string, unknown> = { port };
  // M4 Task 4：authToken 追加写入 minisd-port.json（明文），供 CLI dry-run.mjs 免交互连接。
  //
  // 【安全权衡申报——这是安全姿态的实质变更，不是缺口补齐】
  // 变更前：authToken 只存在于内存，经 IPC 交给渲染进程；磁盘上没有副本。
  // 变更后：明文落盘于 %APPDATA%\Roaming\DeskMinis\minisd-port.json。
  //
  // 权限边界：该目录默认 ACL 仅当前用户账户可读写。
  //
  // 对「同用户攻击者」不扩大攻击面：能以同一账户执行代码的攻击者，本就能通过 DPAPI
  // 解开 KeyringVault 取到 provider API key 与 PairingKey/StaticIdentity 私钥——
  // 那些是长期机密，价值远高于本 token。
  //
  // 与 KeyringVault 的定位差异：vault 存长期机密；authToken 是每次启动 randomUUID()
  // 重新生成的短期凭据，进程退出即失去意义（下次启动换新 token，旧值不再被任何监听者接受）。
  //
  // 实际扩大的暴露面有两条，如实记录：
  //   ① 文件在进程退出后仍留在磁盘。残留的是陈旧 token，无监听者时无法利用，
  //      但它会一直躺在那里直到下次启动被覆盖。
  //   ② Roaming 是漫游配置目录——域环境的漫游用户配置、OneDrive 等同步工具会同步该目录，
  //      token 可能因此离开本机。这是本次变更中最值得注意的一条。
  //
  // token 的权限范围受 M3a 双条件校验约束：授予 authMode=local（业务面全开 + remote.pair.*），
  // 但必须同时满足「持有 token」与「来自回环连接」，非回环持 token 者一律 401（M3a 命门修复）。
  // 因此即使 token 经同步离开本机，远端也无法凭它连回来。
  //
  // 缓解方向见计划 Backlog：dry-run 独立运行模式（不连 minisd，直接静态解析数据根），
  // 可彻底移除落盘需求。
  if (authToken) data.authToken = authToken;
  writeFileSync(tmp, JSON.stringify(data), 'utf8');
  renameSync(tmp, portFile);
}

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
    // MU2a Task 11（计划内红线例外）：e2e 经 DESKMINIS_FAKE_REPLY 定制回复文本（markdown DOM 断言用）；未设置时默认原文不变
    yield { kind: 'textDelta', text: process.env.DESKMINIS_FAKE_REPLY ?? '（假回复）' };
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

export async function startMinisd(opts?: { dataDir?: string; host?: string; port?: number; permTimeoutMs?: number }): Promise<{ port: number; listenPort: number; authToken: string; bridgePipe?: string; close(): Promise<void> }> {
  const root = opts?.dataDir ?? dataRoot();
  mkdirSync(root, { recursive: true });
  const paths = new MinisPaths(root);
  const db = openDb(join(root, 'minis.db'));
  // M6 R4 审计日志：跨会话事件审计（权限决议等），独立于会话生命周期（决策点 2-3）。
  const audit = new AuditLogger(db);
  // M6 R2 全局设置：key-value 落 settings 表，重启后仍生效（决策点 2-6）。现唯一用途是暂停标志 sync.paused。
  const settings = new SettingsStore(db);
  // M3b 评审命门 3：PairingService 装配前移到 ChatStore 之前——
  // 静态身份（vault+dataDir）不依赖 db/chat，前移让 chat 构造时即可拿到 myFingerprint 注入 originDeviceId，
  // 避免 ChatStore 被多处引用（AgentLoop/CompactEngine/SyncCoordinator）前出现 setOriginDeviceId 注入空窗。
  // M3c 修复：e2e 跨进程持久化用 FileVault（DESKMINIS_E2E=1），单测用 InMemoryVault.forDataRoot 单例，
  //   生产用 KeyringVault。FileVault 明文存 dataRoot/vault.json，隔离于临时数据根，不污染真实凭据库。
  const vault: SecretVault = process.env.DESKMINIS_E2E
    ? new FileVault(root)
    : (process.env.DESKMINIS_TEST ? InMemoryVault.forDataRoot(root) : new KeyringVault());
  const pairingStore = new PairingStore(root, vault);
  const pairingService = new PairingService(pairingStore, vault);
  const chat = new ChatStore(db, pairingService.myFingerprint);
  // Paths 不认识 DB，故用注入的方式把「会话工作区覆盖值」喂给 workspaceOf。
  paths.setWorkspaceResolver(id => chat.getWorkspaceRoot(id));
  const providers = new ProviderStore(root, vault);

  // 模型能力目录：后台预热 models.dev；失败静默回退磁盘缓存/内置兜底表
  const catalog = new ModelCatalog(join(root, 'models-dev-cache.json'), createProxyFetch());
  void catalog.refresh();
  // M4.5 Task 3：从 providers.json 同步手动 contextWindow 覆盖到 catalog（启动 + provider 变更后调）。
  // 优先级：手动值 > models.dev 缓存 > BUILTIN > undefined。用户修正目录错误值的终极兜底。
  function syncManualOverrides(): void {
    for (const p of providers.list()) {
      if (p.contextWindow !== undefined) catalog.setManualOverride(p.modelId, p.contextWindow);
    }
  }
  syncManualOverrides();

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
      audit.append('permission.resolved', { requestId, reason: 'timeout' }, { sessionId: req.sessionId });
      resolve('deny');
    }, permTimeoutMs);
    timer.unref?.();
    pendingPerms.set(requestId, { resolve, timer, req, bridgeTriggers });
    rpc.broadcast('permission.request', { requestId, req, meta });
    audit.append('permission.request', { requestId, req, meta }, { sessionId: req.sessionId });
  });
  const gateway = new PermissionGatewayImpl(prompt, undefined, permTimeoutMs);
  // 权限档位持久化（permission.preset）：启动读回并应用，否则用户上次选的「完全访问」重启后就失效。
  // 白名单校验：库里的脏值/旧值一律忽略，落到默认档（gateway 构造即默认 ask）。
  const savedPreset = settings.get(PERMISSION_PRESET_KEY);
  if (savedPreset === 'ask' || savedPreset === 'session' || savedPreset === 'full') gateway.applyPreset(savedPreset);

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
  // M4 Task 2：stable 段缓存（按 sessionId+modelId+bridgeGranted 三元组，内存态）
  const stableCache = createStableCache();
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
    // ---- 工作区可选（用户 2026-08-11 拍板：每会话各自设，新会话继承上次用过的）----
    // 注意：这不是权限边界。resolveGuestPath 对绝对路径本就放行、越界由权限系统把关；
    // 这里改的是**默认工作目录**（shell cwd / 终端启动目录 / 相对路径解析的基准）。
    'workspace.get': (p: { sessionId: string }) => ({
      root: paths.workspaceOf(p.sessionId),
      custom: chat.getWorkspaceRoot(p.sessionId),
      isDefault: !chat.getWorkspaceRoot(p.sessionId),
      fallback: paths.sessionBucket(p.sessionId, 'workspace'),
    }),
    'workspace.set': (p: { sessionId: string; root: string }) => {
      const root = String(p.root ?? '').trim();
      if (!root) throw new Error('工作区路径不能为空（要回到默认请用 workspace.reset）');
      // 命门：目录不存在时必须当场抛错。存下去的话 shell 会在一个不存在的 cwd 里起，
      // 报错形态是「命令莫名其妙失败」，比「设置时就告诉你路径不对」难查十倍。
      if (!existsSync(root)) throw new Error(`目录不存在: ${root}`);
      if (!statSync(root).isDirectory()) throw new Error(`不是目录: ${root}`);
      chat.setWorkspaceRoot(p.sessionId, root);
      settings.set(WORKSPACE_LAST_KEY, root);   // 新建会话继承这个
      return { root: paths.workspaceOf(p.sessionId), isDefault: false };
    },
    'workspace.reset': (p: { sessionId: string }) => {
      chat.setWorkspaceRoot(p.sessionId, undefined);
      return { root: paths.workspaceOf(p.sessionId), isDefault: true };
    },
    'chat.sessions.list': () => chat.listSessions(),
    'chat.sessions.create': (p: { title?: string }) => chat.createSession(p.title, settings.get(WORKSPACE_LAST_KEY)),
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
      // M4 Task 2：systemPrompt 改工厂函数（决策点 3 方案 a）——每轮用当前 activeSlot.provider.modelId 调工厂，
      // 走 stable 段缓存 + 桥段落条件注入（会话授权状态当轮生效）+ 技能块 + 记忆注入。
      // memoryBlock 用 __BASE__ 占位符：buildSystemPrompt 用 stable+skillsBlock 替换占位符。
      const memoryEnabled = session?.memoryEnabled ?? true;
      const promptConfig = providers.getPromptConfig();
      const promptFactory = (ctx: { modelId: string; sessionId: string }): string => {
        const bridgeGranted = gateway.hasBridgeGrant(ctx.sessionId);
        // M4 Task 3：纪律块按 modelId 分派（降级切换后当轮跟着变）；stable 段走缓存
        const disciplineBlock = buildDisciplineBlock(ctx.modelId, promptConfig.discipline ?? {});
        const stable = stableCache.get(ctx.sessionId, { bridgeGranted, modelId: ctx.modelId, config: promptConfig, disciplineBlock });
        const skillsBlock = buildSkillsBlock(skillStore.listEnabledForSession(ctx.sessionId), skillsRoot, skillStore.nowEpoch());
        const memoryBlock = memoryInjector.build('__BASE__', { memoryEnabled });
        const base = stable + skillsBlock;
        return memoryBlock ? memoryBlock.replace('__BASE__', base) : base;
      };
      const excludedToolNames = memoryEnabled ? undefined : new Set<string>(MEMORY_TOOL_NAMES);

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
            systemPrompt: promptFactory, thinkingLevel: clampedThinking,
            // maxTokens 取模型目录的输出上限（手动 > models.dev > BUILTIN），目录无数据时兜底 8192。
            // 兜底不选更大：部分 OpenAI 兼容端点对超大 max_tokens 直接 400，宁低勿高（比 M1 固定 4096 宽裕，
            // 又不会因超限被拒——长文截断由 loop 的 maxTokens 自动续写兜底，见 agent/loop.ts CONTINUE_HINT）。
            maxTokens: catalog.getModelMaxOutput(provider.modelId) ?? 8192,
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
    'provider.instances.create': (p: { name: string; kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl?: string; modelId: string; apiKey?: string; contextWindow?: number }) => {
      const baseUrl = (typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '') || undefined;
      if (p.kind === 'openai-compat' && !baseUrl) throw new Error('OpenAI 兼容 provider 需要 base URL');
      // ollama 本地端点免 key；其余类型必须带 key
      if (p.kind !== 'ollama' && (typeof p.apiKey !== 'string' || p.apiKey === '')) throw new Error('该 provider 类型需要 API key');
      const created = providers.create({ name: p.name, kind: p.kind, baseUrl, modelId: p.modelId, contextWindow: p.contextWindow }, p.apiKey || undefined);
      syncManualOverrides();
      return created;
    },
    /** 改配置不必删了重建；apiKey 省略/空串 = 保留原密钥（前端也永远拿不到旧密钥回显）。 */
    'provider.instances.update': (p: { id: string; name?: string; kind?: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl?: string; modelId?: string; apiKey?: string; contextWindow?: number }) => {
      const cur = providers.list().find(x => x.id === p.id);
      if (!cur) throw new Error(`provider 不存在: ${p.id}`);
      const patch: Partial<{ name: string; kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl: string | undefined; modelId: string; contextWindow: number | undefined }> & { apiKey?: string } = {};
      if (typeof p.name === 'string' && p.name.trim()) patch.name = p.name.trim();
      if (p.kind === 'anthropic' || p.kind === 'openai-compat' || p.kind === 'gemini' || p.kind === 'ollama') patch.kind = p.kind;
      if (typeof p.modelId === 'string' && p.modelId.trim()) patch.modelId = p.modelId.trim();
      if (p.baseUrl !== undefined) patch.baseUrl = (typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '') || undefined;
      if (typeof p.apiKey === 'string' && p.apiKey !== '') patch.apiKey = p.apiKey;
      // M4.5 Task 3：contextWindow 支持「显式传 undefined 清空」——'contextWindow' in p 判定是否显式传入
      if ('contextWindow' in p) patch.contextWindow = typeof p.contextWindow === 'number' ? p.contextWindow : undefined;
      // 校验「改完之后」的形态，而不是补丁本身：openai-compat 没有 base URL 无法请求
      const kind = patch.kind ?? cur.kind;
      const baseUrl = 'baseUrl' in patch ? patch.baseUrl : cur.baseUrl;
      if (kind === 'openai-compat' && !baseUrl) throw new Error('OpenAI 兼容 provider 需要 base URL');
      providers.update(p.id, patch);
      syncManualOverrides();
      return { ok: true };
    },
    'provider.instances.delete': (p: { id: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除 provider 需 confirm:true');
      providers.delete(p.id);
      syncManualOverrides();
      return { ok: true };
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
        // M4 Task 2：桥授权状态变化 → 失效该会话 stable 缓存，下一轮工厂重建（精简→完整桥段落当轮生效）
        if (p.decision !== 'deny' && entry.bridgeTriggers.length > 0) stableCache.invalidate(entry.req.sessionId);
        entry.resolve(p.decision);
        // 同一个请求可能在多个窗口里显示：告诉所有客户端这张卡片已了结
        rpc.broadcast('permission.resolved', { requestId: p.requestId, reason: 'answered' }); // 决策 4b'
        audit.append('permission.resolved', { requestId: p.requestId, reason: 'answered', decision: p.decision }, { sessionId: entry.req.sessionId });
      }
      return { ok: true };
    },
    // ---- 权限档位预设（permission.preset）：三档真实作用于权限网关 ----
    'permission.getPreset': () => ({ preset: settings.get(PERMISSION_PRESET_KEY) ?? 'ask' }),
    'permission.setPreset': (p: { preset: string }) => {
      const preset = String(p?.preset ?? '');
      // 白名单校验：非三档一律拒绝。非法值若落库，重启时启动读回会把它兜到默认档，
      // 但当场不应静默接受——界面高亮与网关行为必须一致，说不清的档位不如直接报错。
      if (preset !== 'ask' && preset !== 'session' && preset !== 'full') throw new Error(`非法权限档位: ${preset}`);
      const prev = settings.get(PERMISSION_PRESET_KEY) ?? 'ask';
      gateway.applyPreset(preset);
      settings.set(PERMISSION_PRESET_KEY, preset);
      // 审计带新旧值：切到「完全访问」是高风险动作，未来排查「谁放行了什么」要有据可查
      audit.append('permission.preset', { preset, prev });
      return { ok: true, preset };
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
      // 128000 对齐 context-policy.ts FALLBACK_WINDOW（未导出常量）
      const windowTokens = modelId === 'unknown' ? 128_000 : (catalog.getModelContextWindow(modelId) ?? 128_000);
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
    // ---- M6 Task 4：审计查询面 audit.list（决策点 2-2：只留 RPC 接缝，不出 UI）----
    // 透传 AuditLogger.list 过滤参数；payload 防御性再脱敏一次（double-redact，红线：密钥材料不出现在任何出口）。
    'audit.list': (p: AuditListOpts) => {
      const res = audit.list(p ?? {});
      return { total: res.total, rows: res.rows.map(r => ({ ...r, payload: auditRedact(r.payload) })) };
    },
    // ---- M6 Task 5：R2 本端暂停 control.pause/resume/status（决策点 2-5/2-6/2-7）----
    // 只停同步收敛，不停 agent 循环/工具执行（决策点 2-5）。暂停标志落 settings 表，重启后仍生效（决策点 2-6）。
    'control.pause': () => {
      settings.setBool(SYNC_PAUSE_KEY, true);
      syncCoordinator.setPaused(true);
      audit.append('sync.paused', {});
      return { ok: true, syncPaused: true };
    },
    'control.resume': () => {
      settings.setBool(SYNC_PAUSE_KEY, false);
      // 陷阱顺序：必须先清暂停标志，再触发方案 A 收敛——顺序反了的话，onDirty 重新入队的 sid
      // 会被仍开着的暂停阀在 flush() 里丢弃（「恢复了但什么也没推出去」）。
      syncCoordinator.setPaused(false);
      // 方案 A（决策点 2-7 / Task 5）：对全部 synced session 重 onDirty + flush，兜住两种角色
      //（监听方 broadcast sync.dirty / 拨号方 push）。启动即暂停场景由恢复时补拨的 reconcile 覆盖，
      //  这里统一触发的方案 A 保证运行时暂停的本端改动也流出。
      void syncCoordinator.resumeSync();
      audit.append('sync.resumed', {});
      return { ok: true, syncPaused: false };
    },
    'control.status': () => ({ syncPaused: settings.getBool(SYNC_PAUSE_KEY, false) }),
  };

  const authToken = randomUUID().toUpperCase();

  // M4 Task 4：diagnostics.dryRun RPC 方法（authMode=local，仅本机渲染进程/CLI 可调）
  // 注册在 guardBusinessMethod 循环之前——会被循环包装（拒 pairing），方法体内另拒 remote（双重保险）
  const diagnosticsMethods = createDiagnosticsMethods({
    providers, vault, catalog, skillStore, pairingService, skillsRoot,
    config: providers.getPromptConfig(),
    // M6 R2 决策点 2-6 补充：dry-run 诊断项暴露本端同步暂停状态（懒读取，反映调用时状态）
    syncPaused: () => settings.getBool(SYNC_PAUSE_KEY, false),
  });
  Object.assign(methods, diagnosticsMethods);

  // M3a 接线：PairingService 已前移至 ChatStore 之前（评审命门 3），此处仅接线 remote.* 方法面 + additionalVerify。
  // 沿用 M1 vault/keyring 路径（KeyringVault L26-36）；DESKMINIS_TEST=1 时 vault 已是 InMemoryVault
  // StaticIdentity 首次生成后持久化到 vault，后续启动复用（设计 §2.1「长期身份」）
  // M3c Task 4：createRemoteMethods 第二参注入 onPairComplete——begin 侧从 conn.remoteAddress + p.listenPort 捕获对端地址（必改 4）
  // M3c Task 6：getOutbound/getRpcServer lazy getter（命门 2 出站 ∪ 入站合并 online）——
  //   outboundClient 在端口持久化后才实例化，用 let 前置声明 + lazy getter 闭包引用
  let outboundClient: OutboundClient | undefined;
  const remoteMethods = createRemoteMethods(pairingService, {
    onPairComplete: (fp, remoteAddr, listenPort) => {
      if (listenPort && listenPort > 0) {
        const host = remoteAddr?.replace(/^::ffff:/, '') ?? '127.0.0.1';
        pairingStore.setAddress(fp, `${host}:${listenPort}`);
      }
    },
    getOutbound: () => outboundClient,
    getRpcServer: () => rpc,
  });
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
  // M3c Task 4：createSyncMethods 第二参注入 pairingService/listenPort（sync.hello 用，端口漂移自愈必改 4）
  //   syncOpts 用可变对象：listen 前占位 0，listen 后更新为实际端口——sync.hello 闭包引用 opts.listenPort 能拿到新值。
  // M3c Task 6：onMergedRemote 注入——sync.push handler 合并有变化时广播 chat.event synced（监听方路径，小项 7e）
  const syncOpts: {
    pairingService: PairingService;
    listenPort: number;
    onMergedRemote?: (peerFingerprint: string | undefined, sessionId: string, result: { mergedCount: number; orphanMarkerIds: string[]; hasChange: boolean }) => void;
  } = {
    pairingService,
    listenPort: 0,
    onMergedRemote: (peerFp, sid, result) => {
      rpc.broadcast('chat.event', { kind: 'synced', sessionId: sid, mergedCount: result.mergedCount, fromDevice: peerFp });
    },
  };
  const syncMethods = createSyncMethods(chat, syncOpts);
  for (const k of Object.keys(syncMethods)) {
    (syncMethods as any)[k] = guardBusinessMethod((syncMethods as any)[k], k);
  }
  Object.assign(methods, syncMethods);

  rpc = new RpcServer(methods, authToken, additionalVerify);
  // M3c Task 4：端口持久化（必改 4b）——读 minisd-port.json 复用 → 占用回退随机 → 写文件
  const listenHost = opts?.host ?? '127.0.0.1';
  const port = await resolveAndPersistPort(root, listenHost, opts?.port ?? 0, (h, p) => rpc.listen(h, p), authToken);
  syncOpts.listenPort = port; // sync.hello 响应带实际监听端口（对端刷新地址簿，端口漂移自愈）

  // M3c Task 6：OutboundClient 装配（决策 8）——出站 WS 客户端，拨已配对对端（主从裁决 myFp < peerFp 者主拨）
  // 在端口持久化后实例化：start() 用 pairingStore 里的地址（pairing 时习得），与端口无直接依赖，
  // 但与 SyncCoordinator 绑定（start/stop 联动），此处实例化顺序最稳。
  outboundClient = new OutboundClient(pairingService, pairingService.myFingerprint);

  // M3b 接线 + M3c Task 6 扩展：SyncCoordinator 注入 OutboundClient（决策 4 拨号方双职责 push+pull）
  const syncCoordinator = new SyncCoordinator(chat, rpc, { outbound: outboundClient });
  chat.onDirty = sid => syncCoordinator.onDirty(sid);
  // M6 Task 5：启动时读 settings.sync.paused 注入暂停阀（决策点 2-6 持久化）——
  //  setPaused 在 start() 前调用：暂停态不拨号/不广播，但 pull（对端主动推来）照常收下。
  syncCoordinator.setPaused(settings.getBool(SYNC_PAUSE_KEY, false));
  syncCoordinator.start(); // 触发 outboundClient.start() + 挂 onRemoteDirty

  return {
    port, listenPort: port, authToken, bridgePipe,
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
