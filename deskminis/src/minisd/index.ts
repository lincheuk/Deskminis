import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dataRoot, logRootFromEnv, MinisPaths } from './paths';
import { openDb } from './store/db';
import { reportStartupFailure } from './fatal';
import { installMinisdCrashHandlers } from './diag/crash-hooks';
import { acquireDataRootLock, type DataRootLock } from './store/data-root-lock';
import { AuditLogger, auditRedact, type AuditListOpts } from './store/audit';
import { SettingsStore, SYNC_PAUSE_KEY, PERMISSION_PRESET_KEY, PAIRING_POLICY_KEY } from './store/settings';
import { parsePairingPolicy } from '../shared/pairing';

/** 全局「上次用过的工作区」——新建会话继承它（用户拍板：每会话各自设 + 继承上次）。 */
const WORKSPACE_LAST_KEY = 'workspace.lastUsed';
import { ChatStore } from './store/chat-store';
import {InputQueueStore, type QueueClaim} from './store/input-queue';
import {createInputController} from './input-controller';
import { ProviderStore, KeyringVault, InMemoryVault, FileVault, keyringServiceFromEnv, type SecretVault, type ProviderInstance } from './store/provider-store';
import { SearchProviderStore } from './store/search-provider-store';
import { McpServersStore, type McpServerEntry } from './mcp/config';
import { McpManager } from './mcp/manager';
import { McpStdioClient } from './mcp/stdio';
import { McpHttpClient } from './mcp/http';
import { ToolRegistry } from './tools/registry';
import { ToolScheduler } from './tools/scheduler';
import { fileReadTool, fileWriteTool, fileEditTool } from './tools/files';
import { officeReadTool, officeWriteTool } from './tools/office';
import { parseOffice } from './office/parse';
import { fileListTool, fileGlobTool, fileGrepTool } from './tools/search';
import { ShellManager, makeShellTool } from './tools/shell';
import { PermissionGatewayImpl, classifyShellCommand } from './tools/permissions';
import { PermissionBroker, responderOf, type SystemSettle } from './tools/permission-broker';
import { buildPreviewMessages, runAgentLoop, shapeMessagesForSlot, type ProviderSlot, type SystemPromptCtx } from './agent/loop';
import { computeSlotBudget, joinSystemPrompt, orderToolDefinitions, prunesBeforeSend } from './agent/request-budget';
import { pruneOldToolResults } from './agent/prune';
import { RpcServer, type RpcConnection } from './rpc/server';
import { ProviderError, type AgentProvider, type StreamRequest, type SystemPromptParts } from './providers/types';
import { PairingStore, PairingService } from './remote/pairing';
import { createRemoteMethods, createAdditionalVerify } from './remote';
import { RpcMethodRegistry } from './rpc/registry';
import { SyncCoordinator, createSyncMethods, OutboundClient, createAttachmentSync, compareLifecycle, decideIncoming } from './sync';
import type { SyncReceiveResult, TombstoneHost, TombstoneOutcome, WireLifecycle } from './sync';
import type { AgentMessage, AgentStreamEvent, AgentToolDefinition, ContentPart, MessagesHave, MessagesListResult, SessionLifecycleNotice, ThinkingLevel } from '../shared/types';
import type { ContextInfo, RequestBudget } from '../shared/request-budget';
import type { CompactionView, ContextRecoveryView } from '../shared/compaction';
import { compactionViewOf } from './agent/compact-meta';
import { briefOf } from './agent/request-budget';
import { mimeFromPath } from '../shared/parts';
import type { RuntimeModel } from '../shared/runtime-model';
import { ModelCatalog, createProxyFetch } from './providers/model-catalog';
import { createOutboundFetch } from './net/outbound-fetch';
import { createModelMetadataMethods } from './providers/model-metadata-rpc';
import { parseOverrideInput, planSlot, resolveRuntimeModel } from './providers/runtime-model';
import { MemoryStore } from './store/memory-store';
import { MemoryInjector } from './store/memory-injector';
import { memoryWriteTool, memoryGetTool, MEMORY_TOOL_NAMES } from './tools/memory';
import { makeWebFetchTool } from './tools/web';
import { makeWebSearchTool } from './tools/web-search';
import { ContextPolicy, FALLBACK_WINDOW } from './agent/context-policy';
import { OffloadEngine } from './agent/offload';
import { CompactEngine } from './agent/compact';
import { createStableCache, STABLE_IDENTITY_NO_TOOLS } from './agent/system-prompt';
import { buildDisciplineBlock } from './agent/model-discipline';
import { buildTitleRequest, cleanTitle } from './agent/auto-title';
import { createDiagnosticsMethods } from './diagnostics';
import { createHash, randomUUID } from 'node:crypto';
import { SkillStore, skillIdFromPath } from './skills/store';
import { buildSkillsBlock } from './skills/prompt';
import { AssistantStore, applyAssistantPreset } from './assistants/store';
import { buildAssistantBlock } from './assistants/prompt';
import { CronStore, type CronJob } from './cron/store';
import { RunLedger, type RunEnd } from './store/run-ledger';
import { createRunRecorder } from './agent/run-recorder';
import { recoverOnBoot, settleOpenBatches, type RecoveryDeps, type RecoveryReport } from './agent/run-recovery';
import { CheckpointStore } from './checkpoints/store';
import { CheckpointService } from './checkpoints/restore';
import { createCheckpointMethods } from './checkpoints/rpc';
import type { FileIo } from './checkpoints/fs';
import { PROMPT_ID_RE, type ChatPromptResult, type RunOrigin, type RunRef, type RunSnapshotQuery, type RunView } from '../shared/run';
import { EventLog } from './rpc/event-log';
import { LiveTails } from './agent/live-tails';
import { createAttachHandler, createOutcomesHandler } from './state-attach';
import type { AttachParams } from '../shared/event-stream';
import { cancelCauseOf } from '../shared/permission';
import { SkillImporter, type ImportKind } from './skills/importer';
import { MarketService } from './market/service';
import { MarketClient } from './market/client';
import { MarketCache } from './market/cache';
import { ClawHubSource } from './market/clawhub';
import { McpRegistrySource } from './market/mcp-registry';
import { AwesomeDshSource } from './market/awesome-dsh';
import { MarketInstaller } from './market/install';
import type { MarketSource } from './market/types';
import { BridgeServer, bridgePipePath, makeBridgeEnv, resolveBridgeCliPath, resolveBridgeNode } from './bridge/server';
import { detectBridgeTriggers } from './bridge/detect';
import { makeBridgeDispatcher } from './bridge/handlers';
import { TerminalManager } from './terminal';
import type { ProcOpts } from './proc/win-exec';
import { ProcSupervisor } from './proc/owned';
import { ProcLedger } from './store/proc-ledger';
import { muteBrokenStdio, watchParent } from './proc/parent-watch';
import { FilesService } from './files';

export { SYSTEM_PROMPT } from './agent/system-prompt';

/** sessionId 直接被拼进文件系统路径（paths.ensureSessionDirs），必须限死成 UUID 形态：
 *  '..\\..\\Windows' 这类值会逃出数据根，在宿主任意目录建目录/落文件。 */
const SESSION_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
function assertSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new Error('非法 sessionId');
  return id;
}

/** chat.prompt 附件路径白名单：会话相对、attachments 桶下单层文件名、扩展名四类图片。
 *  正则本身就是路径穿越防线——`../`、绝对路径、子目录形态全都不匹配，无需再拼接后判界。 */
const ATTACHMENT_REL_RE = /^attachments\/[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp)$/i;
/** 单条消息附件上限与单文件大小上限：早失败、响亮报错——放进 loop 才发现超限，
 *  用户消息已落库、回合已起跑，只能靠用户自己察觉模型「看不清图」。 */
const ATTACHMENTS_MAX = 8;
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** 权限询问未响应的兜底时限：与 PermissionGatewayImpl 的 askTimeoutMs 保持一致。 */
const PERM_TIMEOUT_MS = 90000;

/** 降级链上每个 slot 的显示名：「名称(模型 id)」。首个 slot 与其余成员必须同一格式——
 *  它们一起出现在 fallback 事件的 from → to 里（Z 波：首个 slot 此前是写死的 main）。 */
function slotLabel(i: { name: string; modelId: string }): string { return `${i.name}(${i.modelId})`; }

/** 手动重命名的标题上限。比自动命名的 20 字宽松——用户自己起的名字该由用户说了算，
 *  这里只拦「贴了一整段进来」这种把列表撑坏的输入。 */
const SESSION_TITLE_MAX = 50;

/** createSession 的默认标题。自动命名只在标题还是这个值时才动手——
 *  用户手动改过名（或从别的设备同步来了名字）就不该再被模型覆盖。 */
const DEFAULT_SESSION_TITLE = '新会话';

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

/** 删除运行中的会话时，等它收尾的上限（W1b-4 · 设计稿 §2 生命周期）。超时就不删、报错让用户稍后再删——
 *  硬删的话晚到的 toolResult / user 消息会写成孤儿行，还可能继续往外写文件。 */
const RUN_STOP_TIMEOUT_MS = 10_000;

/** 关停时等在跑的 run 收尾的上限（W1b-5 · lifecycle.md W1b-quit）。abort 之后 run 还要把半截回复、[已取消] 的 toolResult
 *  写进库，不等就关库，这些写入全撞上「database connection is not open」。
 *  它与第 6 步等子进程树回收的 REAP_WAIT_MS 是先后两段等待（W1b-5d）：两者相加必须比主进程的 MINISD_STOP_TIMEOUT_MS
 *  （5 秒，src/main/minisd-stop.ts）小至少 1 秒，留给关桥、关 rpc、关库与 WAL checkpoint——超过主进程的时限，minisd 会在
 *  关库之前被 kill。三者的关系由 tests/minisd-stop.test.ts 钉住。不理会 abort 的调用（部分 MCP）会把等待拖满这个上限。 */
export const CLOSE_GRACE_MS = 3_000;

/** 关停第 6 步等子进程树回收的上限（W1b-5d · 设计稿 §4.1）。Windows 上终端、shell、MCP 的回收是起 taskkill /T 收整棵树，
 *  taskkill 是 minisd 的直接子进程：不等它跑完就退出，它会随 libuv 的作业一并被结束，孙进程没人收（proc/win-exec.ts 头注释）。
 *  卡住的 taskkill（系统繁忙、被安全软件拦住）不能把关停拖过主进程的强杀时限：到点照样往下关桥、rpc 与库，没收完的孙进程留下。
 *  MCP 的 streamable-http 连接关停时发的告别（DELETE）也算在这段里（W1b-5e）。
 *  与 CLOSE_GRACE_MS 相加必须比 MINISD_STOP_TIMEOUT_MS 小至少 1 秒（见上，tests/minisd-stop.test.ts 钉住）。 */
export const REAP_WAIT_MS = 1_000;

/** 关停开始后拒绝新运行时的报错（chat.prompt、定时任务）。 */
const CLOSING_MESSAGE = '后台正在关闭';

/** 关停的一步（W1b-5）：抛错只记一笔、不外抛，后面的步骤照做。关停是尽力而为：进程马上要退了，
 *  这时把错误往上抛只会让后面的 abort、销毁子进程、关库放锁全被跳过。 */
function shutdownStep(what: string, fn: () => void): void {
  try { fn(); } catch (e) { console.warn(`关停：${what}失败，继续后面的步骤:`, e); }
}
async function shutdownStepAsync(what: string, fn: () => Promise<unknown> | undefined): Promise<void> {
  try { await fn(); } catch (e) { console.warn(`关停：${what}失败，继续后面的步骤:`, e); }
}

/** 关停第 6 步的一项：[名字, 发起回收]。发起时返回的 Promise 在回收落定时落定；不返回 Promise 的当场算落定。 */
export type ReapStep = readonly [what: string, reap: () => Promise<unknown> | void];

/** 关停第 6 步（W1b-5d）：销毁终端、shell、MCP，并等它们的子进程树回收落定。
 *  每项当场发起、各自兜住（shutdownStep 的语义）：一项同步抛错或返回的 Promise 拒绝，只记一笔，其余照样发起、照样等。
 *  全部落定返回 'done'；到 limitMs 还有没落定的，记一笔、返回 'timeout'，调用方照样往下关桥、rpc 与库。永不拒绝。
 *  抽成导出函数，是为了与 closeThenExit 一样按行为测（tests/shutdown-reap.test.ts）。 */
export async function shutdownReap(steps: readonly ReapStep[], limitMs: number): Promise<'done' | 'timeout'> {
  const reaping = steps.map(([what, reap]) => {
    const failed = (e: unknown): void => { console.warn(`关停：${what}失败，继续后面的步骤:`, e); };
    try {
      return Promise.resolve(reap()).then(() => undefined, failed);
    } catch (e) {
      failed(e);
      return Promise.resolve();
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), limitMs); });
  try {
    const outcome = await Promise.race([Promise.all(reaping).then(() => 'done' as const), expired]);
    if (outcome === 'timeout') console.warn(`关停：等子进程树回收超过 ${limitMs}ms（远端 MCP 的告别也算在内），照样往下关（没收完的孙进程会留下，告别可能没发出去）`);
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/** standalone 收到主进程的 shutdown 之后（W1b-5）：等启动完成 → 有序 close → 做完（成败都算）才 exit(0)。
 *  启动失败不管：reportStartupFailure 写完致命行后自己以 1 退出。
 *  抽成函数是为了按行为测「close 做完之前不退出」（tests/shutdown-partial-reply.test.ts）：
 *  审查实测 `void inst.close(…); process.exit(0);` 这种库还没关就退的写法骗得过只认调用形态的守卫。 */
export function closeThenExit(starting: Promise<Pick<MinisdHandle, 'close'>>, exit: (code: number) => void): Promise<void> {
  return starting.then(
    inst => inst.close({ graceMs: CLOSE_GRACE_MS }).catch(() => { /* 关停尽力而为，照样退出 */ }).finally(() => exit(0)),
    () => { /* 启动失败：见上 */ },
  );
}

/** runStopTimeoutMs：删除运行中会话时等收尾的上限，缺省 RUN_STOP_TIMEOUT_MS（测试注入短值验超时分支）。
 *  reapWaitMs：关停时等子进程树回收的上限，缺省 REAP_WAIT_MS（测试注入短值验上限分支）。
 *  proc：终端与 shell 子进程的平台、spawn 与环境，原样透传给 TerminalManager / ShellManager。生产不传；
 *  测试在 Linux 上注入 platform 'win32' 与假 spawn，才走得到 taskkill 那条要等的分支（W1b-5d）。
 *  toolLockWaitTimeoutMs（F04）：工具调用等别的会话放资源锁的上限，缺省 LOCK_WAIT_TIMEOUT_MS（测试注入短值验超时分支，与 permTimeoutMs 同类）。
 *  now（F11B）：仅测试。这台实例会话库的时钟（毫秒），用来在同进程里造两台时钟不同的设备。
 *  tombstoneSeenTtlS（F11B）：仅测试。墓碑里消息 id 列表的保留时长（秒），缺省 TOMBSTONE_SEEN_TTL_S。
 *  checkpointIo（F08）：文件检查点的文件操作（写入事务、存储、恢复共用）。生产不传；测试注入故障（检查点目录写满等）。
 *  没有、也不加任何降低检查点容量下限的开关：容量清理用真实数据量验证。
 *  eventRetention（F06）：广播保留窗口的上限（条数 / 字符数），缺省见 rpc/event-log.ts（测试注入小值验「窗口过期改取快照」，与 permTimeoutMs 同类；生产不传）。 */
export type StartMinisdOpts = {
  dataDir?: string; host?: string; port?: number; permTimeoutMs?: number; runStopTimeoutMs?: number;
  reapWaitMs?: number; proc?: ProcOpts; toolLockWaitTimeoutMs?: number; checkpointIo?: FileIo;
  now?: () => number; tombstoneSeenTtlS?: number;
  eventRetention?: { maxEvents?: number; maxChars?: number };
};
/** F11B：墓碑里的消息 id 列表保留多久（90 天）。到期只压掉列表，墓碑行与条数、摘要永远留着（ChatStore.compactTombstones）。 */
export const TOMBSTONE_SEEN_TTL_S = 90 * 86400;
/** close：graceMs 是等在跑 run 收尾的上限，缺省 CLOSE_GRACE_MS。幂等，重复调用拿到同一个 promise。 */
export type MinisdHandle = { port: number; listenPort: number; authToken: string; bridgePipe?: string; close(opts?: { graceMs?: number }): Promise<void> };

/** 起一个 minisd：建数据根 → 拿数据根锁 → 装配。
 *  W1b-3（设计稿 §3 第 9 条）：锁在打开库之前拿，拿不到就以 DATA_ROOT_LOCKED 当场抛出，库、端口文件、桥一样都不碰
 *  （以前同一个根上的第二个实例能完整起来，和第一个同写一个 minis.db）。拿到之后装配任何一步失败都先释放再抛——
 *  不释放的话锁里是本进程的 pid，同一进程里这个根就再也打不开了。装配成功后由 close() 的最后一步释放。
 *  为什么是外壳加 assembleMinisd，而不是把装配整段包进 try：那样近千行要整体重缩进，与本波其它步骤处处冲突（cross.md S11）。
 *  不留绕过开关：两个 minisd 同写一个库正是这把锁要挡的（设计稿 §2 生命周期「e2e 脚本不留锁绕过开关」）。 */
export async function startMinisd(opts?: StartMinisdOpts): Promise<MinisdHandle> {
  const root = opts?.dataDir ?? dataRoot();
  mkdirSync(root, { recursive: true });
  const lock = acquireDataRootLock(root);
  try {
    return await assembleMinisd(root, lock, opts);
  } catch (e) {
    lock.release();
    throw e;
  }
}

async function assembleMinisd(root: string, lock: DataRootLock, opts?: StartMinisdOpts): Promise<MinisdHandle> {
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
  // W1a-9：keyring 服务名由主进程经 DESKMINIS_KEYRING_SERVICE 下发（dev 为 DeskMinis-dev），缺省仍是正式版的 DeskMinis。
  const vault: SecretVault = process.env.DESKMINIS_E2E
    ? new FileVault(root)
    : (process.env.DESKMINIS_TEST ? InMemoryVault.forDataRoot(root) : new KeyringVault(keyringServiceFromEnv(process.env)));
  const pairingStore = new PairingStore(root, vault);
  // F11C：本机配对策略落 settings 表（缺失或非法值按缺省的 legacy），每次用时现读；配对生命周期事件写审计
  //（事件里没有配对码和密钥；审计写失败不该让配对失败，PairingService 会吞掉回调里的错，这里再包一层说明意图）。
  const pairingService = new PairingService(pairingStore, vault, {
    policy: {
      get: () => parsePairingPolicy(settings.get(PAIRING_POLICY_KEY)),
      set: p => settings.set(PAIRING_POLICY_KEY, p),
    },
    onEvent: e => {
      try {
        audit.append(`pair.${e.kind}`, e, 'peerFingerprint' in e ? { peerFingerprint: e.peerFingerprint } : {});
      } catch { /* 见上 */ }
    },
  });
  const chat = new ChatStore(db, pairingService.myFingerprint, { now: opts?.now });
  const inputQueue = new InputQueueStore(db, {isSessionDeleted: s => chat.isDeleted(s)});
  inputQueue.recover(); // Never automatically resend a pre-restart input.
  // Paths 不认识 DB，故用注入的方式把「会话工作区覆盖值」喂给 workspaceOf。
  paths.setWorkspaceResolver(id => chat.getWorkspaceRoot(id));
  const providers = new ProviderStore(root, vault);
  // 搜索 provider 与模型 provider 同库隔离：密钥走同一 vault（另一槽位），配置独立文件
  const searchProviderStore = new SearchProviderStore(root, vault);
  // D2 MCP 配置层：只做 servers.json 读写，连接（网络/子进程）在 D3/D4
  const mcpServers = new McpServersStore(paths);

  // 模型能力目录：后台预热 models.dev；失败静默回退磁盘缓存/内置兜底表
  const catalog = new ModelCatalog(join(root, 'models-dev-cache.json'), createOutboundFetch(() => createProxyFetch() ?? fetch));
  void catalog.refresh();
  // F01：运行时模型规格按「配置实例 + 端点/协议 + 模型」现解析（providers.json 与目录都是当前值，不留副本）。
  // 取代 M4.5 的 syncManualOverrides：它按 modelId 往目录里塞全局覆盖——同名模型的其它配置被带偏，
  // 而且只写不撤，清空或删除配置后旧值一直留到重启。手动修正现在只作用于它所在的实例，优先级：手动 > 端点记录 > 汇总 > 内置。
  const runtimeOf = (inst: ProviderInstance): RuntimeModel => resolveRuntimeModel(inst, catalog);
  /** 假 provider（DESKMINIS_FAKE_PROVIDER，仅测试）不对应任何配置实例：按本机未知模型解析，能力全是「未确认」，与 F01 之前的默认一致。 */
  const fakeRuntime = (): RuntimeModel => resolveRuntimeModel({ kind: 'openai-compat', baseUrl: 'http://127.0.0.1/__fake__', modelId: 'fake' }, catalog);

  // 权限：把询问经 RPC 广播给 UI，UI 用 permission.respond 回决议。
  // 广播给所有连接是安全的——RpcServer 现在要求 per-run token，能连上的只可能是本应用自己的窗口。
  // 网关的兜底时限与 broker 的时限用同一个值；即使不同，两个定时器谁先到都落到 broker 的同一个了结函数（F13）
  const permTimeoutMs = opts?.permTimeoutMs ?? PERM_TIMEOUT_MS;
  let rpc: RpcServer;
  // F13：卡片的登记与了结收进 PermissionBroker——一张卡只了结一次，第一终态获胜；
  // 超时、答复、取消、失效四条路共用一个了结函数，广播与审计各自兜住（W2b-7 的超时审计保护搬到了那里并推广到每条路径）。
  // 几个回调都是延迟执行的闭包，引用后面才声明的 gateway / stableCache 与后面才赋值的 rpc
  const permBroker = new PermissionBroker({
    timeoutMs: permTimeoutMs,
    broadcast: (m, p) => rpc.broadcast(m, p),
    audit: (t, p, o) => audit.append(t, p, o),
    // 一张卡只接受发卡时已经连着的连接的答复：断线之后换一条连接、凭旧 requestId 发来的批准不生效。
    // 去掉这一行就退回「任何已授权连接都可答复」（broker 在 connSeq 缺省时不做这项检查）
    connSeq: () => rpc.lastConnSeq(),
    // 晚到的答复没有生效，但说明用户在场：清掉这个会话的「连续无人答复」计数
    onUserSeen: sid => gateway.resetUnanswered(sid),
    // 决策 4b：广播附 meta（风险分级 / 桥触发探测——仅 shell kind，bridgeTriggers 探测非空时才带）
    describe: req => {
      if (req.kind !== 'shell') return {};
      const t = detectBridgeTriggers(req.detail);
      return { riskClass: classifyShellCommand(req.detail), ...(t.length > 0 ? { bridgeTriggers: t } : {}) };
    },
    onApproved: (e, decision) => {
      // 决策 4c 桥双段授权合并：shell 卡批准时，对探测到的每个桥 kind 同步授权（会话级/一次性计数）。
      // 只在「这张卡以允许了结」这一处发：晚到的、没生效的批准走不到这里
      for (const k of e.bridgeTriggers) {
        if (decision === 'allow-session') gateway.grantBridgeSession(e.req.sessionId, k);
        else gateway.grantBridgeOnce(e.req.sessionId, k);
      }
      // M4 Task 2：桥授权状态变化 → 失效该会话 stable 缓存，下一轮工厂重建（精简→完整桥段落当轮生效）
      if (e.bridgeTriggers.length > 0) stableCache.invalidate(e.req.sessionId);
    },
  });
  /** 系统代为了结挂起的权限请求（W1b-4）：filter 为会话 id 时只了结该会话的，'all' 了结全部。
   *  为什么要主动了结：abort 唤不醒正在等权限的工具（files/shell/web 都是拿到决议后才复查 signal），
   *  不了结的话 run 要一直等到用户点卡或 90 秒兜底，删除就等不到它收尾；卡片也会留在别的窗口里。
   *  逐张了结、逐条广播 resolved 并写审计（broker 里每张的审计各自兜住，单张失败不挡后面的卡——W1b-5 审查）。
   *  F13：了结的原因是「取消」而不是「拒绝」——工具拿到的是 cancelled，线上 reason 仍是这三个旧值。 */
  type SystemEnd = 'cancelled' | 'session-deleted' | 'shutdown';
  function denyPendingPerms(filter: string | 'all', reason: SystemEnd): void {
    permBroker.settleWhere(e => filter === 'all' || e.req.sessionId === filter,
      { reason: 'cancelled', cause: reason === 'cancelled' ? 'user-stop' : reason });
  }
  const gateway = new PermissionGatewayImpl(permBroker.ask, undefined, permTimeoutMs, undefined, {
    // 不弹卡的拒绝（规则拦截、核心数据、MCP 停用、无人答复抑制）与「批准之后没执行」记一条审计，不广播
    onDenied: (req, d, o) => {
      const { preview: _p, ...reqNoPreview } = req;
      try {
        audit.append('permission.denied', { req: reqNoPreview, outcome: d, origin: o?.origin ?? 'tool', ...(o?.toolUseId ? { toolUseId: o.toolUseId } : {}) }, { sessionId: req.sessionId });
      } catch (e) {
        console.warn('未弹卡的权限拒绝写审计失败（拒绝本身不受影响）:', e);
      }
    },
    // 该会话有 run 在跑时到达的桥询问（多半是 agent 的 shell 子进程发的）与工具询问一样计入「连续无人答复」、
    // 到上限后不再弹卡：shell 命令已获会话授权、又探测不到桥触发时，模型原样重跑会一张接一张地弹桥卡。
    // 没有 run 时（用户在终端面板里手动跑的桥命令）不受影响。去掉这一行就退回「桥询问不计数、不受限」。
    // 延迟执行的闭包，引用后面才声明的 inFlight
    runActive: sid => inFlight.has(sid),
    // F05：一张卡的放行没能落进执行账本、被改成了拒绝（record-failed）时，把它批准那一刻发出的桥合并授权也收回——
    // 与上面 broker 的 onApproved 对称，探测用同一个函数。会话授权由网关自己撤（revokeGrant）。
    // 不收回的话，卡片在审计里是「已失效」，它带出的桥授权却照样被后面的桥调用消费
    onRevoked: (req, a) => {
      if (req.kind !== 'shell') return;
      const kinds = detectBridgeTriggers(req.detail);
      for (const k of kinds) {
        if (a.via === 'user-session') gateway.revokeBridgeSession(req.sessionId, k);
        else gateway.revokeBridgeOnce(req.sessionId, k);
      }
      if (kinds.length > 0) stableCache.invalidate(req.sessionId);
    },
  });
  /** F13：MCP 停用 / 会话禁用 / 改配置 / 移除时，把这台挂着的权限卡当场作废——卡片从界面消失、工具立即返回，
   *  不用等人点或 90 秒。调用点都放在配置已写入、forget 之后：工具醒来现查配置时看到的是新状态。
   *  没经过 RPC 的手改配置没有这个钩子，由执行器的闸后复查兜住。 */
  const invalidateMcpCards = (server: string, cause: Extract<SystemSettle, { reason: 'invalidated' }>['cause'], sessionId?: string): void => {
    permBroker.settleWhere(
      e => e.req.kind === 'mcp' && e.req.detail === server && (sessionId === undefined || e.req.sessionId === sessionId),
      { reason: 'invalidated', cause });
  };
  // 权限档位持久化（permission.preset）：启动读回并应用，否则用户上次选的「完全访问」重启后就失效。
  // 白名单校验：库里的脏值/旧值一律忽略，落到默认档（gateway 构造即默认 ask）。
  const savedPreset = settings.get(PERMISSION_PRESET_KEY);
  if (savedPreset === 'ask' || savedPreset === 'session' || savedPreset === 'plan' || savedPreset === 'full') gateway.applyPreset(savedPreset);

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

  // F09 进程树托管：本引擎实例唯一，终端、shell、MCP 与 MCP 试连共用。每棵树的根自己建不许脱离的作业并把自己放进去，
  // 引擎一停（崩溃、被强杀、关停超时）整棵树由系统结束；建不起来就按原来的方式启动与回收，状态如实（proc/owned.ts）。
  // DESKMINIS_PROC_OWNERSHIP=off / 0 / false 是总开关：本次运行不托管。
  const ownOff = /^(off|0|false)$/i.test(process.env.DESKMINIS_PROC_OWNERSHIP ?? '');
  const procSupervisor = new ProcSupervisor(ownOff ? { disabled: 'disabled-by-env' } : undefined);
  const procOpts: ProcOpts = { ...opts?.proc, supervisor: procSupervisor };

  // 终端面板：交互式 powershell 独立实例（env 注入 MINIS_* 桥环境变量，#8 决策落地：用户可在终端手动调桥命令）
  const terminals = new TerminalManager(paths, (sessionId, data) => rpc.broadcast('terminal.output', { sessionId, data }),
    sessionId => makeBridgeEnv(sessionId, bridgePipe, bridgeCli, bridgeNode), procOpts);
  const filesSvc = new FilesService(paths);

  const shells = new ShellManager(procOpts);
  const tools = new ToolRegistry();
  tools.register(fileReadTool); tools.register(fileWriteTool); tools.register(fileEditTool);
  // U4 Office 文档：读走结构化文本、写从结构化 JSON 产出（权限门与 file_* 同一道）
  tools.register(officeReadTool); tools.register(officeWriteTool);
  tools.register(fileListTool); tools.register(fileGlobTool); tools.register(fileGrepTool);
  tools.register(makeShellTool(shells, ctx => makeBridgeEnv(ctx.sessionId, bridgePipe, bridgeCli, bridgeNode)));
  tools.register(memoryWriteTool); tools.register(memoryGetTool);
  tools.register(makeWebFetchTool());
  // web_search 照常注册（未配置时调用返回引导文案），密钥经 resolve() 闭包内部消费、不外流
  tools.register(makeWebSearchTool(() => searchProviderStore.resolve()));
  // D5 MCP 管理器：run 开始连接 enabled server，其工具以 mcp__<server>__<tool> 动态进出本 registry
  const mcpManager = new McpManager({ store: mcpServers, chatStore: chat, registry: tools, supervisor: procSupervisor });
  // F04：工具调度器——本引擎实例唯一，所有会话的 run 共用一张资源锁表（两个会话写同一文件、同一工作区里各跑 shell 都要排队）
  const toolScheduler = new ToolScheduler({ lockWaitTimeoutMs: opts?.toolLockWaitTimeoutMs });

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

  // ---- J1 助手体系：命名预设目录 + 一次性种子 ----
  const assistantStore = new AssistantStore(db);
  assistantStore.ensureSeeds(settings);
  // ---- K1 定时任务：存储在此、调度器在 RpcServer 之后 ----
  const cronStore = new CronStore(db);
  // F11B 启动自检：登记与隐藏标记不一致时修成一致（宁可显示或保留，不清内容）。排在启动恢复之前——
  // 恢复按「会话行可不可见」决定给被打断的调用补不补结果消息，要让它看到的是修好的状态：否则登记为已删除、
  // 却没打隐藏标记的会话会被拿去补消息，存储层拒写，那一批每次启动都失败一遍。自己兜住，失败不挡启动
  try { chat.repairLifecycle(); } catch (e) { console.warn('会话生命周期自检失败:', e); }
  // ---- F05 运行账本：构造即开新代次（租约）。它失败说明库此刻不可写——没有代次就没有租约，任何 run 都不该起，
  //  照旧走启动失败（与 openDb、迁移失败同级），所以不兜。
  const runLedger = new RunLedger(db, { appVersion: process.env.DESKMINIS_APP_VERSION ?? '' });
  // ---- F08 文件检查点：内置文件 / Office 写入的写前状态存在 <数据根>/checkpoints 下，元信息在库里。
  //  记录的提交与执行意图同一规格（关停即拒、校验租约、FULL 同步）：记录落不下，就不许动目标文件。
  //  构造不抛：目录建不出来只告警，引擎照常启动，之后的文件写入被拒并说明原因。
  const checkpointStore = new CheckpointStore(db, join(root, 'checkpoints'), {
    commit: fn => runLedger.durableAtomic(fn), tx: fn => runLedger.atomic(fn), io: opts?.checkpointIo,
    onChange: sessionId => rpc?.broadcast('checkpoints.changed', { sessionId }),
  });
  // 先对账、再做运行恢复：崩溃时停在「写前状态已存、替换没确认」的记录按实际文件落定（已生效 / 没发生 / 无法确认），
  // 运行恢复随后只读这些结论，把事实补进「结果未知」的文件类调用。只动检查点自己的行与库里记着的临时文件，从不改用户文件。
  // 全部兜住：与启动恢复同一条规则，从不让引擎起不来
  try {
    checkpointStore.markSinceEpoch(runLedger.epoch);
    const settled = checkpointStore.reconcile();
    if (settled.length > 0) console.warn(`检查点对账：${settled.length} 条被打断的文件写入或恢复已按实际文件落定，没有改动任何用户文件`);
  } catch (e) { console.warn('检查点对账失败（引擎照常启动，下次查看改动或下次启动再对）:', e); }
  const recoveryDeps: RecoveryDeps = {
    ledger: runLedger, chat, audit: (t, p, o) => audit.append(t, p, o),
    effectEvidence: row => checkpointStore.effectEvidence(row),
  };
  // ---- F06 有序事件：每条广播在 RpcServer.broadcast 里拿到本代次内连续的序号（ev { epoch, seq }）并留进内存窗口，
  //  断线的客户端凭游标续传；流式尾巴在分配序号的同一步里折叠，所以它恒等于 seq <= lastSeq 的增量的折叠。
  //  代次取账本的 epoch：引擎重启后旧序号全部作废，客户端据此改取快照。
  const liveTails = new LiveTails();
  const eventLog = new EventLog({ epoch: runLedger.epoch, ...opts?.eventRetention, onAppend: (m, p, seq) => liveTails.observe(m, p, seq) });
  // F09 进程账本：与运行账本同一个代次。接上之前还没有任何入口能起进程（RPC 还没监听、恢复不执行工具）
  const procLedger = new ProcLedger(db, { epoch: runLedger.epoch, status: () => procSupervisor.status, isSessionDeleted: id => chat.isDeleted(id) });
  procSupervisor.bind(procLedger);
  // 启动恢复：数据根锁保证此刻没有别的引擎，库里仍标着活动的 run 一定属于已死的前代。同步执行，一定在监听端口与定时器首查之前。
  // 只收口状态：被打断的工具调用各落一条明确的结果（真实结果 / 未执行 / 结果未知），run 记为中断，定时任务状态收口。
  // 不执行任何工具、不续跑任何 run、不补跑定时任务。recoverOnBoot 按契约不抛，这层 try 是兜底：
  // 万一漏了一处，后果是一行告警而不是应用打不开（触发它的那行数据每次启动都还在）。
  let recovered: RecoveryReport | undefined;
  try { recovered = recoverOnBoot({ ...recoveryDeps, cron: cronStore, processNote: x => procLedger.orphanNote(x) }); }
  catch (e) { console.warn('启动恢复失败（引擎照常启动；没收口的运行留到该会话下次提问或下次启动）:', e); }
  if (recovered && (recovered.runs.length > 0 || recovered.batches.length > 0 || recovered.cronJobs.length > 0 || recovered.failed.length > 0)) {
    console.warn(`启动恢复（第 ${recovered.epoch} 代）：${recovered.runs.length} 个被中断的运行、${recovered.batches.length} 个工具批次、`
      + `${recovered.cronJobs.length} 个定时任务状态已收口，没有重新执行任何工具`
      + (recovered.failed.length > 0 ? `；${recovered.failed.length} 步失败（${recovered.failed.map(f => f.what).join('、')}），留到该会话下次提问或下次启动` : ''));
  }
  // F08：启动清扫（这一刻没有任何写入在途）——没有记录引用的内容、目录里没登记的残留文件、过了保留期与超出容量的记录
  try { checkpointStore.gc({ sweep: true }); checkpointStore.prune(); }
  catch (e) { console.warn('检查点清理失败（引擎照常启动）:', e); }
  // 变化清单、对比、恢复与另存。恢复取的是工具调度器的同一张资源锁表；会话有 run 在跑时不允许恢复（延迟求值的闭包）
  const checkpointService = new CheckpointService({
    store: checkpointStore, paths, locks: toolScheduler.locks, io: opts?.checkpointIo,
    isSessionRunning: sessionId => inFlight.has(sessionId),
    // F11B：已删除的会话（含保留副本）不显示、不恢复——与 chat.prompt 的入口闸、chat.runs.snapshot 的过滤读同一个判据
    isSessionDeleted: sessionId => chat.isDeleted(sessionId),
    uncoveredCalls: sessionId => {
      const out = new Map<string, { shell: number; mcp: number; other: number }>();
      const rows = db.prepare("SELECT run_id, tool_name, COUNT(*) AS n FROM tool_executions WHERE session_id=? AND started=1 AND side_effects='unknown' GROUP BY run_id, tool_name")
        .all(sessionId) as { run_id: string; tool_name: string; n: number }[];
      for (const r of rows) {
        const g = out.get(r.run_id) ?? { shell: 0, mcp: 0, other: 0 };
        if (r.tool_name === 'shell_execute') g.shell += r.n; else if (r.tool_name.startsWith('mcp__')) g.mcp += r.n; else g.other += r.n;
        out.set(r.run_id, g);
      }
      return out;
    },
    runMeta: runIds => {
      const out = new Map<string, { generation: number; createdAt: number; state: string }>();
      const get = db.prepare('SELECT generation, created_at, state FROM agent_runs WHERE id=?');
      for (const id of runIds) {
        const r = get.get(id) as { generation: number; created_at: number; state: string } | undefined;
        if (r) out.set(id, { generation: r.generation, createdAt: r.created_at, state: r.state });
      }
      return out;
    },
    audit: (t, p, o) => audit.append(t, p, o),
  });
  // F09：前代没关账的进程树在这里关账（排在上面的恢复之后——恢复文案要读到它们关账之前的状态也读得到之后的，两者都认）。
  // 只写库：不结束任何进程、不按记录的 PID 做任何事、不起任何进程。自己兜住，从不让引擎起不来
  try {
    const orphanTrees = procLedger.closeOrphans();
    if (orphanTrees.length > 0) {
      const unverified = orphanTrees.filter(t => t.reaped !== 'job').length;
      console.warn(`进程树恢复（第 ${runLedger.epoch} 代）：前代留下 ${orphanTrees.length} 棵没关账的进程树，其中 ${orphanTrees.length - unverified} 棵受作业对象托管（已随引擎停止由系统结束）、`
        + `${unverified} 棵没有依据（可能仍在运行）。没有结束任何进程`);
      try { audit.append('proc.recovered', { epoch: runLedger.epoch, trees: orphanTrees.length, unverified }); } catch (e) { console.warn('进程树恢复写审计失败:', e); }
    }
    procLedger.prune();
  } catch (e) { console.warn('进程树恢复失败（引擎照常启动）:', e); }
  /** 会话 → 生效助手（悬空绑定查无回 undefined，注入侧即跳过——删助手不杀会话）。 */
  const assistantOf = (sessionId: string) => {
    const aid = chat.getSession(sessionId)?.assistantId;
    return aid ? assistantStore.get(aid) : undefined;
  };

  // ---- F02 请求预算接线：chat.prompt 与 chat.contextInfo 共用同一套系统提示与工具定义的组法，
  //  上下文条看到的才是循环真正会发的东西 ----
  /** 运行中各会话最近一次发出的请求的预算（循环的 onRequestBudget 写，finishRun 删）。 */
  const liveBudgets = new Map<string, RequestBudget>();
  /** F03：各会话最近一次超窗恢复的状态（仅内存）。收到 contextRecovery 事件时写；下一次 chat.prompt 占位时清、会话删除时清。
   *  停在「正在重发」的那一份不留到运行结束之后（重发被取消或以别的错误收尾时循环不会再发终态）：finishRun 记一条审计后删掉。 */
  const liveRecovery = new Map<string, ContextRecoveryView>();
  /**
   * 这个会话的系统提示工厂（M4 Task 2 决策点 3 方案 a：每轮用当前槽位的 modelId 调，走 stable 段缓存 + 桥段落条件注入
   * （会话授权状态当轮生效）+ 助手规则 + 技能块 + 记忆注入）。创建时读一次会话的记忆开关与提示配置。
   * F02：返回两段——稳定段是人设、身份与桥段落、纪律块、助手规则、技能索引；动态段是全局记忆与最近日志
   * （memory_write 在运行中会改它）。文本顺序与内容和分段之前相同，一段不删。
   * 以前这里先用占位符拼好记忆块、再用 String.replace 把占位符换回正文：正文（助手规则、技能描述）里的 $& 之类
   * 会被当成替换模式改写，人设里出现字面的占位符时还会换错位置。现在直接拼接，这些文本原样保留。
   */
  const promptFactoryFor = (sessionId: string): ((ctx: SystemPromptCtx) => SystemPromptParts) => {
    const memoryEnabled = chat.getSession(sessionId)?.memoryEnabled ?? true;
    const promptConfig = providers.getPromptConfig();
    return (ctx: SystemPromptCtx): SystemPromptParts => {
      // F01R：这个槽位这次不带工具（不支持工具调用）时，换一份不声称工具能力的身份段，并去掉三段工具指令——
      // 桥段落（靠 shell 调用）、纪律块（要求必须调用工具）、技能索引（要求用 file_read 读技能文件）。
      // 不带工具的分支不读不写 stable 缓存，带工具路径的缓存键与内容都不变
      const sendTools = ctx.sendTools !== false;
      const bridgeGranted = gateway.hasBridgeGrant(ctx.sessionId);
      // M4 Task 3：纪律块按 modelId 分派（降级切换后当轮跟着变）；stable 段走缓存
      const disciplineBlock = buildDisciplineBlock(ctx.modelId, promptConfig.discipline ?? {});
      const stable = sendTools
        ? stableCache.get(ctx.sessionId, { bridgeGranted, modelId: ctx.modelId, config: promptConfig, disciplineBlock })
        : STABLE_IDENTITY_NO_TOOLS;
      const skillsBlock = sendTools ? buildSkillsBlock(skillStore.listEnabledForSession(ctx.sessionId), skillsRoot, skillStore.nowEpoch()) : '';
      // J1：助手规则块置 stable 后、技能块前（设计稿 §4）；每轮实时读表——会话中改助手规则下一轮生效。
      // 助手规则与下面的记忆注入是用户内容，不是工具指令：不带工具时照旧带上
      const assistantBlock = buildAssistantBlock(assistantOf(ctx.sessionId));
      const { head, tail } = memoryInjector.buildParts(stable + assistantBlock + skillsBlock + (sendTools ? mcpManager.omissionBlock(sessionId) : ''), { memoryEnabled });
      const plan = sendTools && gateway.isPlanMode()
        ? '当前权限档是「只读 / 计划」：可以读文件、运行只读命令，联网会询问用户；写文件、会改动东西的命令、MCP 工具会被直接拒绝。需要改动时，先给出具体方案，等用户切换档位后再做。' : '';
      return { stable: head, dynamic: plan ? (tail ? tail + '\n\n' + plan : plan) : tail };
    };
  };
  /** 这个会话会列给模型的工具定义：排成确定顺序（内置在前、MCP 按名字），去掉关掉记忆时的记忆工具与会话禁用的 MCP 台。
   *  与循环里「按会话排除后排序」的结果相同（过滤与排序互不影响次序）。 */
  const sessionToolDefs = (sessionId: string): AgentToolDefinition[] => {
    const memoryEnabled = chat.getSession(sessionId)?.memoryEnabled ?? true;
    const memoryTools = new Set<string>(MEMORY_TOOL_NAMES);
    const mcpExcluded = mcpManager.excludedToolNames(sessionId);
    return orderToolDefinitions(tools.definitions()).filter(t => (memoryEnabled || !memoryTools.has(t.name)) && !mcpExcluded.has(t.name));
  };

  // ---- G1/G2 扩展市场（设计 §2/§3/§6）：三源适配器 + market_cache 缓存 + 读 RPC + 安装链路。
  //  client/cache/sources 共享装配：读侧服务与安装链路共用同一份缓存与并发预算（≤2）。
  //  SQLite 走既有 db 连接不新开；读操作免批（与 skills.list 同档）；install 属状态变更——
  //  确认卡 confirm + 服务端 verdict 复核（不信任 renderer 传参），malicious 硬阻断。----
  const marketClient = new MarketClient();
  const marketCache = new MarketCache(db, marketClient);
  const marketSources: MarketSource[] = [
    new ClawHubSource(marketCache),
    new McpRegistrySource(marketCache),
    new AwesomeDshSource(marketCache),
  ];
  const market = new MarketService(db, { client: marketClient, cache: marketCache, sources: marketSources });
  const marketInstaller = new MarketInstaller({
    db, sources: marketSources, client: marketClient, importer, skillStore, mcpStore: mcpServers,
    bridgeNodePath: bridgeNode, // 与 diagnostics/终端桥同一 resolveBridgeNode 结果（白名单闸第四类命令）
    onSkillsChanged: () => rpc.broadcast('skills.changed', {}),
    // W1a-6：市场装成或更新一台 MCP 后同 mcp.servers.upsert 一样让 manager 忘掉它，下一回合按新配置重连
    // F13：这台挂着的权限卡同时作废（批准是在旧配置下要的）
    onMcpChanged: name => { mcpManager.forget(name); invalidateMcpCards(name, 'mcp-config-changed'); },
  });

  const fakeEnabled = process.env.DESKMINIS_FAKE_PROVIDER === '1';

  /** 同一会话同时只允许跑一个 agent 循环：两个循环会读到彼此写了一半的历史，
   *  交错落库出 Anthropic 直接 400 的消息序列（tool_use 没有配对的 tool_result）。 */
  const inFlight = new Set<string>();
  const controllers = new Map<string, AbortController>();
  /** 每个在跑会话的「收尾完成」promise（W1b-4），与 inFlight 同生同灭：chat.prompt 在 inFlight.add 时就登记
   *  （覆盖 ensureForRun 那段 await），IIFE 的 finally 里兑现并摘掉。以前 run promise 没留引用，
   *  别处无法等它——删除只能不等就删，晚到的写入全成孤儿行。 */
  const runs = new Map<string, Promise<void>>();
  const runStopTimeoutMs = opts?.runStopTimeoutMs ?? RUN_STOP_TIMEOUT_MS;
  const reapWaitMs = opts?.reapWaitMs ?? REAP_WAIT_MS;
  /** 关停已开始（W1b-5）：close() 的第一步置真，此后 chat.prompt 与定时任务一律拒绝——
   *  否则 close 正在等旧 run 收尾时又起一个新 run，它不在等待名单里，会在关库之后照写不误。 */
  let closing = false;
  const inputController = createInputController({
    inbox: inputQueue, chat, ledger: runLedger, sessionId: assertSessionId,
    closing: () => closing, busy: s => inFlight.has(s),
    launch: (p, claim) => rawChatPrompt(p, undefined, undefined, claim),
    broadcast: (method, params) => rpc.broadcast(method, params),
    validateAttachments: p => {
      const attachments = p.attachments ?? [];
      if (attachments.length > ATTACHMENTS_MAX) throw Error('附件数量超过上限');
      const dir = paths.sessionBucket(p.sessionId, 'attachments');
      for (const rel of attachments) {
        if (!ATTACHMENT_REL_RE.test(rel)) throw Error('非法附件路径');
        const stat = statSync(join(dir, rel.slice('attachments/'.length)));
        if (!stat.isFile() || stat.size > ATTACHMENT_MAX_BYTES) throw Error('附件不存在或超过5MB');
      }
    },
  });
  /** 停下一个会话的 run 并等它收尾（W1b-4）：先把它挂着的权限卡了结，再 abort，再等收尾 promise 与超时赛跑。
   *  返回 true = 已停下（或本来就没在跑）；false = 超时仍未收尾。删除用它，close() 以后复用（W1b-5）。 */
  async function stopRun(sessionId: string, timeoutMs: number, reason: 'session-deleted' | 'shutdown'): Promise<boolean> {
    inputController.hold(sessionId, reason);
    // F13：先了结卡片，再看有没有 run——没在跑的会话也可能经桥挂着卡（终端面板里手动跑的桥命令、别处用这个会话 id 发来的管道请求）。
    // 以前没有 run 就直接返回：删除之后那张卡仍可被批准并执行（截屏会把已删会话的 attachments 目录重新建出来）。
    // 有 run 时「了结卡片 → abort」之间仍然没有 await，顺序与以前相同
    denyPendingPerms(sessionId, reason);
    const run = runs.get(sessionId);
    if (!run) return true;
    controllers.get(sessionId)?.abort(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>(r => { timer = setTimeout(() => r(false), timeoutMs); });
    try { return await Promise.race([run.then(() => true as const), timedOut]); }
    finally { clearTimeout(timer); }
  }
  /** K1 回合完成接缝（设计稿 §0）：一次性钩子，chat.prompt 的 IIFE finally 消费——
   *  调度器借此写 last_status，顺带治理「loop 抛错仅广播不落库、无人值守失败无痕」缺口。 */
  const runDoneHooks = new Map<string, (err?: string) => void>();
  /** F05：run 事件（带 event 字段的 chat.event）的唯一发布点，带上它属于哪次运行（id / 会话内第几次 / 引擎代次）。
   *  调用处保证对应的状态先提交、再发布。kind:'synced' 的同步通知不属于任何 run，不经这里、不带 run。 */
  const emitRunEvent = (r: RunRef, event: unknown): void =>
    rpc.broadcast('chat.event', { sessionId: r.sessionId, event, run: { id: r.runId, generation: r.generation, epoch: r.epoch } });
  /** F05：本进程里还没落 user 消息的 run 的「起跑结果」（runId → promise）：落了 user 消息即兑现，起跑前失败 / 被取消即拒绝（带原错误）。
   *  与 run 行的 starting 状态同生同灭，只在 chat.prompt 里登记与摘除。 */
  const launches = new Map<string, Promise<void>>();
  /** F05：对重复提交（同会话、同 promptId、内容相同）的应答：原 run 的现状，不起新 run。
   *  原 run 还在 starting（连 MCP 那一段，历史里还没有这条消息）时先等它的起跑结果：这时就答 duplicate 的话，
   *  原提交随后起跑前失败或被取消，promptId 被放掉、消息不在历史里，重复提交的一方却以为它已被接收——没有任何 run 会再送它。
   *  等到之后：落了 user 消息 → 答 duplicate；起跑前失败 → 把同一个错误抛给重复提交方。
   *  单独成函数：chat.prompt 里幂等检查到 beginRun 之间不能有 await，等待只能放在这条不再起 run 的路上。 */
  const answerDuplicate = async (run: RunView, launch: Promise<void> | undefined): Promise<ChatPromptResult> => {
    let now = run;
    if (launch) {
      await launch;
      now = runLedger.getRun(run.runId) ?? run;
    }
    return {
      ok: true, runId: now.runId, generation: now.generation, duplicate: true, state: now.state,
      ...(now.stopReason !== undefined ? { stopReason: now.stopReason } : {}),
    };
  };
  /** F06：state.attach / state.outcomes 的处理器（state-attach.ts）。attach 是同步函数：lastSeq 与会话、run、待批卡、尾巴
   *  在同一段同步代码里取，这就是快照与增量之间的无缝边界。revision 取 SQLite 的 total_changes()（本连接的行变更总数）：
   *  没有对应事件的库写入（建会话、改绑定、beginRun、账本行迁移）也会让它变大，两份 lastSeq 相同的快照据它区分。 */
  const totalChanges = db.prepare('SELECT total_changes() AS n');
  const attachState = createAttachHandler({
    log: eventLog, instanceId: runLedger.instanceId, ledger: runLedger, chat, broker: permBroker, tails: liveTails,
    revision: () => (totalChanges.get() as { n: number }).n,
    // F11B：已删除的会话（含保留副本）的运行、执行记录、产物、尾巴不进快照与续传应答——与 chat.runs.snapshot 的过滤同一个判据
    isSessionDeleted: sessionId => chat.isDeleted(sessionId), inputs: inputQueue,
  });
  const writeOutcomes = createOutcomesHandler({
    epoch: runLedger.epoch, instanceId: runLedger.instanceId, ledger: runLedger, broker: permBroker,
    launchOf: runId => launches.get(runId), sessionId: assertSessionId,
    // F11B：已删除的会话（含保留副本）名下的提交与执行记录不从结果查询里带出去
    isSessionDeleted: sessionId => chat.isDeleted(sessionId), inputs: inputQueue,
  });
  /** 正在自动命名的会话。命名是 fire-and-forget 的，没有这道闸，
   *  同一会话前后两轮的命名请求会并发跑、互相覆盖标题。 */
  const titling = new Set<string>();

  /**
   * 首回合跑完后给还叫「新会话」的会话取个名——否则左栏一排一模一样的卡，
   * 用户只能靠时间和位置猜哪个是哪个。
   * 刻意 fire-and-forget + 全程静默：取名是锦上添花，失败不值得打断用户，
   * 更不该让它把已经成功跑完的这一轮染成 error。失败的表现就是标题还叫「新会话」。
   */
  async function autoTitle(sessionId: string, userText: string, provider: AgentProvider, catalogProviderId?: string): Promise<void> {
    if (titling.has(sessionId)) return;
    titling.add(sessionId);
    // 整段包在 try 里（而非只包网络调用）：这是个没人 await 的 promise，
    // 漏出去的异常会变成 unhandledRejection——进程关停后 DB/连接已销毁，读库本身就会抛。
    try {
      if (chat.getSession(sessionId)?.title !== DEFAULT_SESSION_TITLE) return;
      let out = '';
      for await (const ev of provider.streamAgentMessage({ ...buildTitleRequest(userText), session: { id: sessionId, catalogProviderId } })) {
        if (ev.kind === 'textDelta') out += ev.text;
      }
      const title = cleanTitle(out);
      // 再查一次：这一趟网络往返期间用户可能已经手动改名了，别把人家起的名字盖回去
      if (!title || chat.getSession(sessionId)?.title !== DEFAULT_SESSION_TITLE) return;
      chat.updateSessionTitle(sessionId, title);
      rpc.broadcast('chat.sessions.changed', {});
    } catch { /* 静默：标题留在「新会话」，用户随时可以手动改 */ }
    finally { titling.delete(sessionId); }
  }

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
    // J1 扩参：带 assistantId 时建会话并应用预设三件（绑定/默认模型/技能快照，设计稿 §3）。
    // 返回 getSession 重取——预设写入发生在 createSession 之后，直接回 create 的返回值会缺字段。
    'chat.sessions.create': (p: { title?: string; assistantId?: string }) => {
      if (p.assistantId === undefined) return chat.createSession(p.title, settings.get(WORKSPACE_LAST_KEY));
      const a = assistantStore.get(p.assistantId);
      if (!a) throw new Error(`助手不存在: ${p.assistantId}`);
      const s = chat.createSession(p.title ?? a.name, settings.get(WORKSPACE_LAST_KEY));
      applyAssistantPreset({ chat, skills: skillStore }, s.id, a);
      return chat.getSession(s.id)!;
    },
    // W2b-4 空会话套用 / 解绑助手（止血设计稿 §2「渲染端」；renderer.md W2b-welcome）。
    // 欢迎页在**已存在的空会话**上（NavRail「新建会话」最常走到这里）承诺「直接输入即以该预设开始」，
    // 可助手此前只能随 create 一起带上，这条路发送时从没套过。
    // 语义：把空会话重置成 create({assistantId}) 会得到的样子；assistantId 传 '' 即解绑，得到 create({}) 的样子。
    // 助手 id、模型绑定、技能覆盖三件一起重置，覆盖先全清再按快照写——新助手不勾技能时快照为空，不清的话旧助手的快照整份留下。
    // 三件放一个事务里，不留「助手换了、绑定还是旧的」的半截状态。
    // 空会话上手动设过的模型绑定会被助手的绑定（或清空）盖掉：输入卡胶囊在发送前已按同一语义预告（lib/welcome/assistant 的 previewBinding）。
    'chat.sessions.applyAssistant': (p: { sessionId: string; assistantId: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      if (typeof p.assistantId !== 'string') throw new Error('assistantId 必须是字符串（传空串表示解绑）');
      const s = chat.getSession(sessionId);
      if (!s) throw new Error(`会话不存在: ${sessionId}`);
      // 运行中：这一回合已按旧预设取了 provider 与系统提示，换了也不作用于它，界面却会说换好了
      if (inFlight.has(sessionId)) throw new Error('该会话正在运行中，不能更换助手');
      if (inputQueue.hasUnconsumed(sessionId)) throw Error('会话有待发送输入，不能更换助手');
      // 有消息：历史是按旧预设跑出来的，半途换预设等于改写过去——要换就新建会话
      if (chat.listMessages(sessionId).length > 0) throw new Error('会话已有消息，不能更换助手，请新建会话后再选');
      const assistantId = p.assistantId.trim();
      const a = assistantId ? assistantStore.get(assistantId) : undefined;
      if (assistantId && !a) throw new Error(`助手不存在: ${assistantId}`);
      // 标题只改「默认名」：create({}) 给的「新会话」，或 create / 上一次套用按旧助手起的名。
      // 只认「新会话」的话，create({assistantId:X}) 建出的空会话改选 Y 后标题还叫 X——列表上的名字与实际助手对不上；
      // 用户自己起的名一概不动
      const prev = s.assistantId ? assistantStore.get(s.assistantId) : undefined;
      const autoTitled = s.title === DEFAULT_SESSION_TITLE || (prev !== undefined && s.title === prev.name);
      db.transaction(() => {
        chat.setAssistant(sessionId, undefined);
        chat.setModelBinding(sessionId, undefined);
        for (const sk of skillStore.list()) skillStore.setSessionOverride(sessionId, sk.id, null);
        if (a) applyAssistantPreset({ chat, skills: skillStore }, sessionId, a);
        if (autoTitled) chat.updateSessionTitle(sessionId, a ? a.name : DEFAULT_SESSION_TITLE);
      })();
      // 会话元数据变了：前端靠这条重拉列表（NavRail 的助手 emoji、胶囊的绑定），多窗口同理
      rpc.broadcast('chat.sessions.changed', {});
      return chat.getSession(sessionId)!;
    },
    // J1 助手 CRUD：读免批（skills.list 同档）；写操作广播 assistants.changed 供前端刷新
    'assistants.list': () => assistantStore.list(),
    'assistants.create': (p: { name: string; avatar?: string; rules?: string; modelBinding?: string; skillIds?: string[]; prompts?: string[] }) => {
      const a = assistantStore.create(p);
      rpc.broadcast('assistants.changed', {});
      return a;
    },
    'assistants.update': (p: { id: string; name?: string; avatar?: string; rules?: string; modelBinding?: string; skillIds?: string[]; prompts?: string[]; sortOrder?: number }) => {
      const a = assistantStore.update(p.id, p);
      rpc.broadcast('assistants.changed', {});
      return a;
    },
    'assistants.delete': (p: { id: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除助手需要 confirm: true 确认');
      assistantStore.remove(p.id);
      rpc.broadcast('assistants.changed', {});
      return { ok: true };
    },
    // ---- K1 定时任务 RPC（读免批同 skills.list 档；写操作广播 cron.changed 供面板刷新）----
    'cron.list': () => cronStore.list(),
    'cron.create': (p: { name: string; prompt: string; scheduleKind: 'interval' | 'once' | 'cron'; scheduleValue: string; assistantId?: string; workspaceRoot?: string }) => {
      const j = cronStore.create(p);
      rpc.broadcast('cron.changed', {});
      return j;
    },
    'cron.update': (p: { id: string; name?: string; prompt?: string; scheduleKind?: 'interval' | 'once' | 'cron'; scheduleValue?: string; assistantId?: string; workspaceRoot?: string; enabled?: boolean }) => {
      const j = cronStore.update(p.id, p);
      rpc.broadcast('cron.changed', {});
      return j;
    },
    'cron.delete': (p: { id: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除定时任务需要 confirm: true 确认');
      cronStore.remove(p.id);
      rpc.broadcast('cron.changed', {});
      return { ok: true };
    },
    'cron.runNow': (p: { id: string }) => {
      const j = cronStore.get(p.id);
      if (!j) throw new Error(`任务不存在: ${p.id}`);
      runCronJob(j);
      return { ok: true };
    },
    // W1b-4：删除运行中的会话要先让它停下、等它收尾再删（顺序见 cross.md：run 收尾 → 终端 / shell 释放 → 删库 → 广播）。
    // 以前是同步直删：挂着的权限卡没人了结，删完再点「允许」工具照样出网 / 写文件，loop 还把 toolResult 写进已删会话。
    'chat.sessions.delete': async (p: { sessionId: string; confirm?: boolean }) => {
      const sessionId = assertSessionId(p.sessionId);
      if (p.confirm !== true) throw new Error('删除会话需 confirm:true');
      const stopped = await stopRun(sessionId, runStopTimeoutMs, 'session-deleted');
      // 不理会 abort 的调用（部分 MCP、卡住的连接）会拖满上限：宁可不删也不留孤儿行（设计稿 §2「超时就不删并报错」）
      if (!stopped) throw new Error('会话仍在停止中，请稍后再删');
      terminals.dispose(sessionId);
      // 会话的 agent shell 连同子进程树一起回收（W1b-1 的 dispose(sessionId)），否则删了会话它还在后台开着
      shells.dispose(sessionId);
      liveRecovery.delete(sessionId); // F03：恢复说明随会话清掉
      chat.deleteSession(sessionId);
      // 别的窗口靠这条广播重拉左栏
      rpc.broadcast('chat.sessions.changed', {});
      return { ok: true };
    },
    // F11B：已在其他设备删除、本机因为有对方没见过的内容（消息或标注）而留下的会话。设备页列出它们，可恢复或彻底删除。
    'chat.sessions.listRetained': () => chat.listRetainedSessions(),
    // 彻底删除一个保留副本：只清本机留着的内容，版本不变、不再同步。不复用上面的 chat.sessions.delete——那一个分不出
    // 调用方的意图：设备页上的保留清单过期时（另一台设备或另一个窗口刚恢复了它，这个窗口还没重拉），同一个调用落到的是
    // 一个存活的会话，会写出新的墓碑、把刚恢复的会话在所有设备上再删一次。这里只认「此刻仍是保留副本」，判断与清除在
    // 存储层的同一个事务里；不是就报错，什么都不动。
    // 不经 stopRun：保留副本上没有 run（落成保留副本之前 run 已收尾，chat.prompt 在入口拒绝已删除的会话）；
    // 终端与 shell 排在清除之后释放——没清成（它已经是一个存活的会话）就什么都不碰。
    'chat.sessions.purgeRetained': (p: { sessionId: string; confirm?: boolean }) => {
      const sessionId = assertSessionId(p.sessionId);
      if (p.confirm !== true) throw new Error('彻底删除保留副本需 confirm:true');
      if (closing) throw new Error(CLOSING_MESSAGE);
      chat.purgeRetained(sessionId);
      terminals.dispose(sessionId);
      shells.dispose(sessionId);
      return { ok: true };
    },
    // 显式恢复：产生更高的偶数版本并同步出去，其它设备按版本接受（普通旧副本不带版本，仍被拒收）。
    'chat.sessions.restore': (p: { sessionId: string; confirm?: boolean }) => {
      const sessionId = assertSessionId(p.sessionId);
      if (p.confirm !== true) throw new Error('恢复会话需 confirm:true');
      if (closing) throw new Error(CLOSING_MESSAGE);
      chat.restoreSession(sessionId);
      rpc.broadcast('chat.sessions.changed', {});
      return { ok: true };
    },
    'chat.sessions.rename': (p: { sessionId: string; title: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      const title = (typeof p.title === 'string' ? p.title : '').trim();
      // 空标题会让左栏出现一行没有名字的卡（点得到但认不出）；超长把 212px 的单行卡撑变形
      if (!title) throw new Error('会话标题不能为空');
      if (title.length > SESSION_TITLE_MAX) throw new Error(`会话标题不能超过 ${SESSION_TITLE_MAX} 个字`);
      chat.updateSessionTitle(sessionId, title);
      // 多窗口/多设备下别的界面不知道标题变了，靠这条广播各自重拉列表
      rpc.broadcast('chat.sessions.changed', {});
      return { ok: true };
    },
    'chat.sessions.setPinned': (p: { sessionId: string; pinned: boolean }) => {
      const sessionId = assertSessionId(p.sessionId);
      if (typeof p.pinned !== 'boolean') throw new Error('置顶状态必须是布尔值');
      chat.setPinned(sessionId, p.pinned);
      rpc.broadcast('chat.sessions.changed', {});
      return { ok: true };
    },
    'chat.sessions.setModelBinding': (p: { sessionId: string; binding?: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      chat.setModelBinding(sessionId, p.binding);
      return { ok: true };
    },
    // ── H1 文本选区注释（免批：本地会话数据操作，与 rename 同级；变更广播供多窗口一致）──
    'chat.annotations.list': (p: { sessionId: string }) => ({ annotations: chat.listAnnotations(assertSessionId(p.sessionId)) }),
    'chat.annotations.add': (p: { sessionId: string; messageId: string; exact: string; prefix?: string; suffix?: string; note?: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      // 会话必须真实存在——注释挂在会话生命周期上（deleteSession 级联），孤儿注释无人回收
      if (!chat.getSession(sessionId)) throw new Error(`会话不存在: ${sessionId}`);
      const messageId = typeof p.messageId === 'string' ? p.messageId.trim() : '';
      const exact = typeof p.exact === 'string' ? p.exact : '';
      if (!messageId) throw new Error('注释 messageId 不能为空');
      if (!exact.trim()) throw new Error('注释 exact 不能为空');
      const a = chat.addAnnotation({
        sessionId, messageId, exact,
        prefix: typeof p.prefix === 'string' ? p.prefix : '',
        suffix: typeof p.suffix === 'string' ? p.suffix : '',
        note: typeof p.note === 'string' ? p.note : '',
      });
      rpc.broadcast('chat.annotations.changed', { sessionId });
      return a;
    },
    'chat.annotations.update': (p: { id: string; note: string }) => {
      const sessionId = chat.updateAnnotationNote(String(p.id ?? ''), typeof p.note === 'string' ? p.note : '');
      if (sessionId) rpc.broadcast('chat.annotations.changed', { sessionId });
      return { ok: true };
    },
    'chat.annotations.remove': (p: { id: string }) => {
      const sessionId = chat.removeAnnotation(String(p.id ?? ''));
      if (sessionId) rpc.broadcast('chat.annotations.changed', { sessionId });
      return { ok: true };
    },
    'chat.sessions.setMemoryEnabled': (p: { sessionId: string; enabled: boolean }) => {
      const sessionId = assertSessionId(p.sessionId);
      chat.setMemoryEnabled(sessionId, p.enabled);
      return { ok: true };
    },
    // D5 会话禁用 MCP server（命名形态对齐记忆开关）：写库即生效——工具表剔除在下一次 run 开头，
    // 调用层硬执行则立即生效（正在跑的 run 里也会被拒）。
    'chat.sessions.setMcpDisabled': (p: { sessionId: string; servers: string[] }) => {
      const sessionId = assertSessionId(p.sessionId);
      const servers = Array.isArray(p.servers) ? p.servers.filter((s): s is string => typeof s === 'string') : [];
      chat.setMcpDisabled(sessionId, servers);
      // F13：新名单里每一台在本会话挂着的权限卡当场作废（别的会话同一台的卡不动）
      for (const s of servers) invalidateMcpCards(s, 'mcp-session-disabled', sessionId);
      return { ok: true };
    },
    // Q14：have 可选。不带时与以前完全相同（完整列表）。带了、而且接得上：{ append: 排在调用方最后一条之后的消息 }；
    // 接不上（判据在 ChatStore.listMessagesAfter）仍给完整列表——完整列表永远是对的答案
    'chat.messages.list': (p: { sessionId: string; have?: MessagesHave }): MessagesListResult => {
      const sessionId = assertSessionId(p.sessionId);
      if (p.have === undefined) return chat.listMessages(sessionId);
      const append = chat.listMessagesAfter(sessionId, p.have);
      return append ? { append } : chat.listMessages(sessionId);
    },
    // F05：promptId（可选）标识一次提交，持久去重；origin 只有进程内调用给得了（RPC 分发只传前两个实参），定时任务用它记来源
    'chat.prompt': async (p: { sessionId: string; text: string; providerId?: string; thinkingLevel?: ThinkingLevel; modelGroupId?: string; attachments?: string[]; maxOutputTokens?: number; promptId?: string }, _conn?: RpcConnection, origin?: RunOrigin, inputClaim?: QueueClaim): Promise<ChatPromptResult> => {
      const sessionId = assertSessionId(p.sessionId);
      // W1b-5：关停中不再起新 run。与下面 inFlight.add 之间全是同步代码，close 要么先看到这个 run、要么它在这里被拒
      if (closing) throw new Error(CLOSING_MESSAGE);
      // F11B：已删除的会话（含在别的设备上被删、本机留着副本的）不再接受提问。存储层的 appendMessage 本来就拒写，
      // 但等到那里账本已经占了一行 run——会话已清除的话，这一行再也没人清。排在幂等检查之前：
      // 保留副本的账本行还在，重发同一个 promptId 得到的也是这一句，不是 duplicate
      if (chat.isDeleted(sessionId)) throw new Error('会话已删除');
      if (inputClaim) inputQueue.assertClaim(inputClaim);
      // F05 幂等：同一会话同一 promptId 至多落一条 user 消息、至多起一个进过 running 的 run（run 结束后、引擎重启后仍然如此）。
      // 命中时不校验附件、不落消息、不起 run、不碰 inFlight；原 run 还在跑、已结束、被重启打断，答法相同，state 如实
      // （原 run 还没落 user 消息时等它的起跑结果再答，见 answerDuplicate）。
      // 排在「运行中」守卫之前：重发同一条 prompt 得到的是原 run 的现状，不是「该会话正在运行中」。
      // 从这里到下面 beginRun 之间没有 await：两条并发的同 promptId 提交不会都过。
      let promptDigest: string | undefined;
      if (p.promptId !== undefined) {
        if (typeof p.promptId !== 'string' || !PROMPT_ID_RE.test(p.promptId)) throw new Error('非法 promptId');
        promptDigest = createHash('sha256')
          .update(JSON.stringify([typeof p.text === 'string' ? p.text : '', Array.isArray(p.attachments) ? p.attachments : []]), 'utf8').digest('hex');
        const dup = runLedger.findByPrompt(sessionId, p.promptId);
        // 命中的 run 还在 starting（没落过 user 消息）时，看本进程是不是正在起它：
        //  - 正在起（launches 里有）：算重复，但要等它的起跑结果再作答（answerDuplicate）；
        //  - 没在起：陈旧行（前代留下而启动恢复没收掉，或终态没写成）。这条消息从没被接收过，不算重复——
        //    照常往下走，beginRun 会把陈旧行收掉（没落过消息的行不占 promptId）
        const starting = dup?.run.state === 'starting' ? launches.get(dup.run.runId) : undefined;
        if (dup && (dup.run.state !== 'starting' || starting !== undefined)) {
          // 同一个 id 配了另一条内容：报错，不把另一条消息静默吞掉
          if (dup.promptDigest !== promptDigest) throw new Error('promptId 已用于另一条消息，这一条没有发送');
          return answerDuplicate(dup.run, starting);
        }
      }
      // 附件校验（先于空文本判定：文本+附件任一非空即放行，两者皆空才拒）
      const attachments = Array.isArray(p.attachments) ? p.attachments : [];
      if (attachments.length > ATTACHMENTS_MAX) throw new Error(`附件数量不能超过 ${ATTACHMENTS_MAX} 个`);
      const attDir = paths.sessionBucket(sessionId, 'attachments');
      for (const rel of attachments) {
        if (typeof rel !== 'string' || !ATTACHMENT_REL_RE.test(rel)) throw new Error(`非法附件路径: ${String(rel)}`);
        let size: number;
        try { size = statSync(join(attDir, rel.slice('attachments/'.length))).size; }
        catch { throw new Error(`附件不存在: ${rel}`); }
        if (size > ATTACHMENT_MAX_BYTES) throw new Error(`附件超过 5MB 上限: ${rel}`);
      }
      const text = typeof p.text === 'string' ? p.text : '';
      // 纯空白的 text block 会被 Anthropic 以 400 拒收，而消息此时已落库 ⇒ 该会话此后每次请求都失败（永久变砖）。
      // 有附件时允许空文本：图片本身就是消息内容，mediaRef part 不会变成空 text block。
      if (text.trim() === '' && attachments.length === 0) throw new Error('消息内容不能为空');
      // F02 任务偏好的输出量（可选）：这次运行想要的单次输出额度，在模型上限与剩余空间之内生效。
      // 不是正整数就当场报错——此时用户消息还没落库，不会留下一条发不出去的消息
      const rawOutputPreference: unknown = p.maxOutputTokens;
      if (rawOutputPreference !== undefined && rawOutputPreference !== null
        && (typeof rawOutputPreference !== 'number' || !Number.isSafeInteger(rawOutputPreference) || rawOutputPreference <= 0)) {
        throw new Error('maxOutputTokens 必须是正整数');
      }
      const outputPreference = typeof rawOutputPreference === 'number' ? rawOutputPreference : undefined;
      if (!inputClaim && inputQueue.hasUnconsumed(sessionId)) throw Error('会话有待发送输入，请先继续或取消队列');
      if (inFlight.has(sessionId)) throw new Error('该会话正在运行中，请等待完成或取消');

      // ── 链式解析 provider + fallbackChain（F01：每个槽位带上它配置实例的运行时规格）──
      let provider!: AgentProvider;
      let fallbackChain: (ProviderSlot & { instanceId?: string })[] = [];
      let primaryLabel: string | undefined; // 首个 slot 的真名：进 fallback 事件与能力提示
      let primaryRuntime!: RuntimeModel;
      const useGroup = (gid: string): void => {
        const members = providers.resolveGroupMembers(gid);
        if (members.length === 0) throw new Error('模型组无可用成员');
        provider = fakeEnabled ? new FakeProvider() : members[0].instantiate();
        primaryLabel = slotLabel(members[0].instance);
        primaryRuntime = runtimeOf(members[0].instance);
        fallbackChain = members.slice(1).map(m => ({
          provider: fakeEnabled ? new FakeProvider() : m.instantiate(), label: slotLabel(m.instance), instanceId: m.instance.id, runtime: runtimeOf(m.instance),
        }));
      };
      const useProvider = (pid: string): void => {
        if (fakeEnabled && pid === '__fake__') { provider = new FakeProvider(); primaryRuntime = fakeRuntime(); return; }
        provider = providers.instantiate(pid); // 查无 / 缺密钥照旧当场抛错
        const inst = providers.get(pid)!;
        primaryLabel = slotLabel(inst);
        primaryRuntime = runtimeOf(inst);
      };

      if (p.modelGroupId) {
        // 显式指定模型组
        useGroup(p.modelGroupId);
      } else if (p.providerId) {
        // 显式指定单 provider（M1 既有行为）
        useProvider(p.providerId);
      } else {
        // 从会话绑定解析
        const session = chat.getSession(sessionId);
        const binding = session?.modelBinding;
        if (binding?.startsWith('group:')) {
          useGroup(binding.slice('group:'.length));
        } else if (binding?.startsWith('provider:')) {
          useProvider(binding.slice('provider:'.length));
        } else if (binding) {
          // J2 随动修缺（兼容分支）：MU6 起 SessionList 曾把**裸 provider id**（无前缀）写进
          // model_binding——本分支此前不存在，裸值静默落到默认 provider，绑定形同虚设。
          // 旧库存量按 provider 解；查无（provider 已删）则照 instantiate 语义抛错可见，
          // 好过继续无声用错模型。
          // T6a2 更正：这条注释一度说「新数据不再走到这里」——T 波换壳后 StageAssistants
          // 又写回了裸 id，本分支从兜底变成了主路径，注释因此有一段时间是假话。
          // 现已改回写前缀，但 T→W 期间产生的助手绑定仍是裸值，本分支继续兜着。
          useProvider(binding);
        } else {
          // 未绑定 → 默认 provider（M1 既有行为）
          const defaultId = providers.getDefaultId();
          if (!defaultId) throw new Error('尚未配置任何模型 provider，请先在设置中添加');
          useProvider(defaultId);
        }
      }

      // F01 发送前检查：这条消息至少要有一个槽位接得住（输出文本；本条带图片时收图片）。都接不了就当场拒绝——
      // 用户消息还没落库、一次请求都没发，渲染端把草稿交还给输入框；不会把图片悄悄丢掉再发。
      // 主槽位接不了而组里后面有接得住的：放行，循环开头按能力切过去（fallback cause:'capability'，不改绑会话）。
      const chain = [{ label: primaryLabel ?? `当前模型(${provider.modelId})`, runtime: primaryRuntime }, ...fallbackChain.map(s => ({ label: s.label, runtime: s.runtime! }))];
      const blocks = chain.map(s => planSlot(s.runtime, 'off', { currentImages: attachments.length, historyImages: 0 }, s.label).blocked);
      if (blocks.every(b => b !== undefined)) {
        const noText = chain.every(s => planSlot(s.runtime, 'off', { currentImages: 0, historyImages: 0 }, s.label).blocked !== undefined);
        const hint = noText
          ? '请改用能输出文本的对话模型'
          : '可以移除图片后重发、改用支持图片输入的模型；如确认该接入能收图片，可在「设置 → 模型 → 编辑 → 手动修正」把图片输入标为支持';
        throw new Error(`${blocks.length === 1 ? blocks[0] : `模型组里没有能接这条消息的模型：${blocks.join('；')}`}。消息未发送，${hint}`);
      }

      // F01：推理档位交给循环按每个槽位各自钳制 / 映射（降级后不沿用主模型的参数）；这里只认四个合法值，其余按关处理
      // （旧实现把任意字符串原样传下去，档位表查不到时预算算成 NaN）
      const requestedThinking: ThinkingLevel = p.thinkingLevel === 'low' || p.thinkingLevel === 'medium' || p.thinkingLevel === 'high' || p.thinkingLevel === 'xhigh' || p.thinkingLevel === 'max' ? p.thinkingLevel : 'off';

      // 记忆注入（设计 §3.4：每轮系统提示注入 GLOBAL/SOUL/日志）+ 工具过滤（memory_enabled=false 时排除记忆工具）
      const session = chat.getSession(sessionId);
      // M4 Task 2：systemPrompt 是工厂函数（决策点 3 方案 a）——每轮用当前 activeSlot.provider.modelId 调工厂。
      // F02：工厂提成 promptFactoryFor（chat.contextInfo 共用），返回稳定段与动态段两段
      const memoryEnabled = session?.memoryEnabled ?? true;
      const promptFactory = promptFactoryFor(sessionId);
      let excludedToolNames = memoryEnabled ? undefined : new Set<string>(MEMORY_TOOL_NAMES);

      // 从这里到 IIFE 启动之间除 ensureForRun 外没有 await：占位原子性靠守卫到 add 之间
      // 全同步保证（并发第二发在守卫处被拒，不会双跑）；ensureForRun 不抛（单台失败内部消化）。
      // F05：先在账本里占用会话的活动 run（数据库的部分唯一索引兜底：同一会话最多一个）。抛错时还没占位，直接向调用方报错
      const run = runLedger.beginRun({ sessionId, origin: origin ?? { kind: 'user' }, promptId: p.promptId, promptDigest });
      if (inputClaim) {
        try { inputQueue.bind(inputClaim, run.ref.runId); }
        catch (e) { run.end({state:'failed',reason:'start-failed',detail:String(e)}); throw e; }
      }
      inFlight.add(sessionId);
      // F13：用户发了新消息 = 在场。清掉这个会话的「连续无人答复」计数，本轮重新允许弹卡
      gateway.resetUnanswered(sessionId);
      const controller = new AbortController();
      controllers.set(sessionId, controller);
      // W1b-4：收尾 promise 在占位的同一刻登记——删除可能恰好落在下面 ensureForRun 的 await 窗口里，
      // 这时还没有 IIFE，但删除也得等得到它。finishRun 是唯一的收尾出口（IIFE 的 finally / 起跑前失败都走它）。
      let settleRun!: () => void;
      runs.set(sessionId, new Promise<void>(r => { settleRun = r; }));
      // F03：上一次运行留下的恢复说明到此为止——这次运行有自己的
      liveRecovery.delete(sessionId);
      /** F03：压缩成功后记下的待写审计。等下一次请求的预算（压缩之后的样子）到了再写；压缩后没再发请求就结束的，收尾时不带 after 写。 */
      let pendingCompaction: CompactionView | undefined;
      const auditCompaction = (after?: RequestBudget): void => {
        const d = pendingCompaction;
        if (!d) return;
        pendingCompaction = undefined;
        // 载荷不含摘要正文与用户原话；写失败不影响运行
        try {
          audit.append('context.compacted', {
            markerId: d.markerId, trigger: d.trigger, rule: d.rule, coverage: d.coverage, counts: d.counts, before: d.before,
            ...(after ? { after: briefOf(after) } : {}), request: d.request,
          }, { sessionId });
        } catch { /* 审计写失败不影响运行 */ }
      };
      const finishRun = (): void => {
        inFlight.delete(sessionId); controllers.delete(sessionId); runs.delete(sessionId);
        // F02：运行结束后上下文条回到「按落库状态推算下一次请求」，不留着这次运行最后一次请求的预算
        liveBudgets.delete(sessionId);
        // F03：压缩后没再发请求就结束的，补写那条审计
        auditCompaction();
        // F03：重发没有完成（被取消，或以超窗以外的错误收尾）——循环不会再发这次事故的终态。记一条审计后清掉，
        // 运行结束后 chat.contextInfo 不再报「正在重发」。终态（已恢复 / 已换槽 / 失败）照旧留到下一次 chat.prompt
        const stuck = liveRecovery.get(sessionId);
        if (stuck?.phase === 'resending') {
          try { audit.append('context.recovery', { ...stuck, interrupted: true }, { sessionId }); } catch { /* 审计写失败不影响收尾 */ }
          liveRecovery.delete(sessionId);
        }
        settleRun();
      };
      // F05：这次起跑的结果，给落在下面 ensureForRun 那段窗口里的同 promptId 重复提交等（见 answerDuplicate）。
      // 没人等时拒绝也不能成未处理拒绝，所以先挂一个空的 catch
      let launched!: () => void;
      let launchFailed!: (e: unknown) => void;
      const launch = new Promise<void>((res, rej) => { launched = res; launchFailed = rej; });
      launch.catch(() => undefined);
      launches.set(run.ref.runId, launch);
      // F05：run 终态的提交。只生效一次；在广播终止事件、放掉内存占位之前调（状态先提交，事件后发布）。
      // 先补送没交付的工具批次：正常流程下是空操作，它管的是循环在落 assistant 之后、落结果之前退出的情形
      // （已落定的补真实结果，没开始的补「未执行」；不执行任何工具）。两步都兜住：没人等的 IIFE 不能抛出未处理拒绝
      let ended = false;
      let successful = false;
      const commitEnd = (e: RunEnd): void => {
        if (ended) return;
        ended = true;
        try { settleOpenBatches(recoveryDeps, { runId: run.ref.runId }); } catch (err) { console.warn('run 收尾时补送工具结果失败（留到下次启动）:', err); }
        try {
          run.end(e);
          successful = e.state === 'completed' && !controller.signal.aborted && runLedger.getRun(run.ref.runId)?.state === 'completed';
          inputQueue.finish(sessionId, run.ref.runId, successful, successful ? '运行已结束，补充指示未投递' : '运行停止，等待用户继续');
          inputController.changed(sessionId);
          if (controller.signal.aborted && !closing && !chat.isDeleted(sessionId)) rpc.broadcast('chat.inputs.stopped', inputController.stopSummary(sessionId, run.ref.runId));
        } catch (err) {
          successful = false;
          console.warn('run 或输入队列终态写入失败（下次起跑或启动时补记）:', err);
        }
      };
      const cancelledEnd = (detail?: string): RunEnd => ({ state: 'cancelled', reason: cancelCauseOf(controller.signal), detail });
      try {
        // D5 MCP 接线：run 开始连接 enabled server（已连接/未 stale 的台秒回），工具动态进注册表。
        // 会话禁用的 MCP 台：工具表剔除第一层（第二层是调用层硬执行——工具若因竞态仍在表内也会被拒）。
        await mcpManager.ensureForRun();
        // 连 MCP 期间被删除 / 取消了：不落 user 消息（会话可能正等着被删，落了就是孤儿行），直接收尾
        if (controller.signal.aborted) throw new Error('会话已取消');
        const mcpExcluded = mcpManager.excludedToolNames(sessionId);
        if (mcpExcluded.size > 0) {
          excludedToolNames = excludedToolNames ? new Set([...excludedToolNames, ...mcpExcluded]) : mcpExcluded;
        }
        // 落库 user 消息：文本非空才落 text part（空文本+附件时不产空 text block），
        // 每个附件一枚 mediaRef part（文件本体留在附件桶，请求侧由 loop 合成 base64，永不落库）
        const userParts: ContentPart[] = [];
        if (text.trim() !== '') userParts.push({ type: 'text', value: text });
        for (const rel of attachments) {
          // 校验正则白名单已保证扩展名可映射；兜底 octet-stream 只是防类型收窄，实际到不了
          userParts.push({ type: 'mediaRef', value: { id: chat.newId(), relativePath: rel, mimeType: mimeFromPath(rel) ?? 'application/octet-stream' } });
        }
        // F05：user 消息与 run 进入 running 同一个事务——starting 的 run 一定没有 user 消息，running 的一定有
        run.started(() => {
          const message = chat.appendMessage({ id: chat.newId(), sessionId, role: 'user', parts: userParts, createdAt: chat.nowEpoch(), streamInterruptCount: 0 });
          if (inputClaim) inputQueue.admittedQueue(inputClaim, run.ref.runId, message.id);
          return message;
        });
        if (inputClaim) inputController.changed(sessionId);
        // user 消息已落：这次提交已被接收，等着的重复提交可以答 duplicate 了
        launches.delete(run.ref.runId);
        launched();
        paths.ensureSessionDirs(sessionId);
      } catch (e) {
        // 起跑前任何一步失败都要放掉占位：以前这里抛出会让 inFlight 永远占着（会话一直「运行中」），
        // 现在还会让删除白等满 10 秒。
        // F05：先落 run 的终态（没落过 user 消息的同时放掉 promptId），再放内存占位——少了这一句，run 行停在 starting / active，
        // 账本的活动表不摘，这个会话此后每次提交都被拒到重启为止
        commitEnd(controller.signal.aborted ? cancelledEnd(String(e)) : { state: 'failed', reason: 'start-failed', detail: String(e) });
        // 等在这次起跑上的重复提交拿到同一个错误（user 消息已经落了的话上面已兑现，这里是空操作）
        launches.delete(run.ref.runId);
        launchFailed(e);
        finishRun();
        throw e;
      }
      void (async () => {
        let runErr: string | undefined; // K1：完成钩子的终态入参（undefined = 正常收尾）
        let pendingRebind: string | undefined; // 降级候选 instanceId，等 turnEnd 才落库
        let rebound = false; // 是否已改写绑定（只改一次）
        // F01R：本次运行的第一跳一定是离开会话绑定的首槽位。它是按能力换的（首槽位一次请求都没发、没有故障）→
        // 这次运行不改绑，哪怕接手的成员随后又因故障降级；它是故障 → 维持原规则
        let firstHop: 'none' | 'capability' | 'failure' = 'none';
        // 自动命名要发给「这轮最后真正在跑的那个 provider」：降级换过 slot 后仍拿初始 provider，
        // 等于把命名请求投给刚刚已经失败的端点，必然再失败一次。
        // 与 pendingRebind 分开记：那个只认第一次降级（绑定只改一次），这个得跟到最后一跳。
        let activeProvider = provider;
        let activeCatalogProviderId = primaryRuntime?.endpoint.catalogProviderId;
        try {
          for await (const event of runAgentLoop(chat, {
            sessionId, provider, tools,
            toolContext: {
              sessionId, paths, permissions: gateway,
              // F08：写前检查点的保存方。内置文件 / Office 写入在落盘之前先经它存下原始字节；存不下就不写
              checkpoints: checkpointStore,
              // 取消信号透传：chat.cancel 只 abort 循环层不够，正在跑的 shell/文件写必须能立即停下
              signal: controller.signal,
              // use_count 采集点（Task 4 钩子）：仅恰好命中 <skillsRoot>/<id>/SKILL.md 的成功读取计数
              onFileRead: (abs) => {
                const id = skillIdFromPath(skillsRoot, abs);
                if (id && skillStore.get(id)) skillStore.bumpUseCount(id);
              },
            },
            systemPrompt: promptFactory, thinkingLevel: requestedThinking,
            // F01：max_tokens、推理参数、窗口、工具与图片都由各槽位的 runtime 决定（手动 > 端点记录 > 汇总 > 内置，
            // 输出上限都没有时兜底 8192——部分 OpenAI 兼容端点对超大 max_tokens 直接 400，宁低勿高，长文截断由续写兜底；
            // F01R：非手动的输出上限还要不超过窗口的 3/4，目录的占位写法不原样发出去）。
            // 降级切换 slot 后按新槽位的配置实例重算，同名模型的不同配置互不影响。
            primaryRuntime,
            signal: controller.signal,
            fallbackChain, primaryLabel,
            contextPolicy, compactEngine, offloadEngine, excludedToolNames,
            scheduler: toolScheduler,
            inputQueue: {
              admit: append => {
                const inputs = inputQueue.admitSteers(sessionId, run.ref.runId, input => append(input.text));
                if (inputs.length) inputController.changed(sessionId);
                return inputs;
              },
              hasPending: () => inputQueue.pendingSteers(sessionId, run.ref.runId),
              delivered: ids => { if (inputQueue.delivered(sessionId, ids)) inputController.changed(sessionId); },
            },
            // F02：单次请求实际发出的 max_tokens 由循环按预算定（偏好、模型上限、剩余空间三者的最小值）；
            // 每次发请求前把那份预算交出来，运行中的上下文条显示的就是它
            ...(outputPreference !== undefined ? { outputPreference } : {}),
            onRequestBudget: b => { liveBudgets.set(sessionId, b); auditCompaction(b); },
            // F05：运行记录器——执行意图先落账再调工具，结果在调用落定时提交，结果消息与「已交付」同一事务
            recorder: createRunRecorder(runLedger, run.ref, { signal: controller.signal, offload: offloadEngine }),
          })) {
            // fallback 事件：记下候选 instanceId，但不立即改写——等该 slot 真正跑通（turnEnd）才落库。
            // F01：因能力不符换槽位（cause:'capability'，比如这一轮带图片而主模型不收图片）不是故障，不改绑——
            // 下一条不带图片的消息仍该先给主模型。F01R：只排除那一条事件不够——按能力换到的成员随后故障降级时，
            // 会话会被改绑到最后接手的成员、丢掉整个组，而首槽位其实没有失败过；所以看第一跳（firstHop）。
            // F02：因固定开销放不下换槽位（cause:'requestBudget'）同样一次请求都没发、不是故障，与 'capability' 同等对待
            // F02b：因输出额度在正文之前用完换槽位（cause:'outputLimit'）时请求发过一次，但那个槽位没有出故障——额度是模型自己的
            // 上限或手动填的最大输出，下一条消息仍该先给它。同样不算改绑的理由、同样按第一跳算
            const skipped = event.kind === 'fallback' && (event.cause === 'capability' || event.cause === 'requestBudget' || event.cause === 'outputLimit');
            if (event.kind === 'fallback' && firstHop === 'none') firstHop = skipped ? 'capability' : 'failure';
            // 第一跳是故障、已经要改绑时，候选跟到最后接手的成员。按输出额度换的那一跳也得跟：被换下的成员这一轮没有给出回答，
            // 候选留在它身上的话，回合跑通后会话改绑到它、丢掉整个组——下一条消息只发给它，它再把输出用完就没有备用可换。
            // 'capability' / 'requestBudget' 的换槽照旧不动候选
            const follows = !skipped || (event.kind === 'fallback' && event.cause === 'outputLimit');
            if (event.kind === 'fallback' && firstHop === 'failure' && follows && !rebound) {
              const target = fallbackChain.find(s => s.label === event.to) as (ProviderSlot & { instanceId?: string }) | undefined;
              if (target?.instanceId) pendingRebind = target.instanceId;
            }
            if (event.kind === 'fallback') {
              const slot = fallbackChain.find(s => s.label === event.to);
              if (slot) { activeProvider = slot.provider; activeCatalogProviderId = slot.runtime?.endpoint.catalogProviderId; }
            }
            // turnEnd：该 slot 真正跑通，执行推迟的改写
            if (event.kind === 'turnEnd' && !rebound && pendingRebind) {
              rebound = true;
              chat.setModelBinding(sessionId, `provider:${pendingRebind}`);
              pendingRebind = undefined;
              // Z1：绑定是会话元数据，改了就得广播——前端靠这条重拉会话列表。缺了它，会话菜单与模型胶囊
              // 一直显示「模型组」，实际已改绑到接手的模型（探针实测 stale: true）。平时被首回合自动命名的
              // 那次广播顺手掩盖，第二回合起的降级才露馅。
              rpc.broadcast('chat.sessions.changed', {});
            }
            // 首回合结束即取名（内部自查标题是否仍是默认值，多轮会话不会重复发请求）
            if (event.kind === 'turnEnd') void autoTitle(sessionId, p.text, activeProvider, activeCatalogProviderId);
            // W1b-4（cross.md corrections / missing）：loop 失败是 yield error 事件后正常返回，不 throw——
            // 下面的 catch 对 provider 失败、「已取消」「所有模型均不可用」都不触发，runErr 恒为 undefined，
            // 定时任务就把失败的运行记成 ok。loop 的每个 error 事件之后都立即 return，记最后一个即终态。
            if (event.kind === 'error') runErr = event.message;
            // F03：压缩与超窗恢复的记录（审计三类，载荷不含摘要正文与用户原话；写失败不影响运行）。
            // 事件走下面同一个发布点（emitRunEvent），不另开
            if (event.kind === 'compacted' && event.detail) {
              auditCompaction(); // 上一条还没等到请求就又压了一次：先把它写掉
              pendingCompaction = event.detail;
            } else if (event.kind === 'compactFailed') {
              try { audit.append('context.compactFailed', { reason: event.reason, trigger: event.trigger, message: event.message }, { sessionId }); } catch { /* 同上 */ }
            } else if (event.kind === 'contextRecovery') {
              liveRecovery.set(sessionId, event.view);
              if (event.view.phase !== 'resending') {
                try { audit.append('context.recovery', event.view, { sessionId }); } catch { /* 同上 */ }
              }
            }
            // F05：循环的每个 turnEnd / error 之后都立即 return，它们就是终态——先提交 run 的终态，再广播
            if (event.kind === 'turnEnd') commitEnd({ state: 'completed', reason: event.stopReason });
            else if (event.kind === 'error') commitEnd(controller.signal.aborted ? cancelledEnd(event.message) : { state: 'failed', reason: event.code ?? 'error', detail: event.message });
            emitRunEvent(run.ref, event);
          }
        } catch (e) {
          runErr = String(e);
          commitEnd(controller.signal.aborted ? cancelledEnd(String(e)) : { state: 'failed', reason: 'error', detail: String(e) });
          emitRunEvent(run.ref, { kind: 'error', message: String(e) });
        }
        finally {
          // 被删除打断的 run：loop 报的是「已取消」，但对定时任务来说真正的原因是会话被删了
          if (controller.signal.aborted && controller.signal.reason === 'session-deleted') runErr = '会话已删除';
          // F05 兜底：没有终止事件就结束的 run 也要落终态（账本先落终态、再放内存占位）
          commitEnd(controller.signal.aborted ? cancelledEnd(runErr) : { state: 'failed', reason: 'error', detail: runErr ?? '运行结束时没有终止事件' });
          finishRun();
          // K1：一次性完成钩子（定时任务写终态用）；先摘再调，钩子抛错不影响清理
          const hook = runDoneHooks.get(sessionId);
          runDoneHooks.delete(sessionId);
          try { hook?.(runErr); } catch { /* 钩子自身的错误不外溢 */ }
          if (successful && !closing && !chat.isDeleted(sessionId)) inputController.kick(sessionId);
        }
      })();
      // 不带 promptId 的调用（旧客户端）拿到的仍是 { ok: true }
      return p.promptId === undefined ? { ok: true } : { ok: true, runId: run.ref.runId, generation: run.ref.generation, duplicate: false, state: 'running' };
    },
    // F05：运行与工具执行的只读快照（全部活动 run；给了 sessionId 时再带上该会话最近一次 run）。不带工具入参与输出正文
    'chat.runs.snapshot': (p?: RunSnapshotQuery) => {
      const snap = runLedger.snapshot({
        ...(typeof p?.sessionId === 'string' ? { sessionId: assertSessionId(p.sessionId) } : {}),
        ...(typeof p?.runId === 'string' ? { runId: p.runId } : {}),
      });
      // F11B：已删除的会话不显示。保留副本的账本行还在库里（显式恢复之后要用），但它已不在会话列表里，
      // 它的运行也不从这里带出去；按会话、按 runId 查与残留的活动行同样滤掉
      const live = (r: { sessionId: string }): boolean => !chat.isDeleted(r.sessionId);
      return { ...snap, runs: snap.runs.filter(live), executions: snap.executions.filter(live) };
    },
    // F06：重载 / 重连 / 切到在跑的会话时取状态。带游标且保留窗口盖得住 → 续传（游标之后的全部帧）；否则 → lastSeq 时刻的快照
    //（会话列表、run、待批卡、流式尾巴；给了 sessionId 再带上它的消息）。同步处理器，不能写成 async。
    // 两种应答都把调用连接登记为待批卡的可答复连接：conn 由 RpcServer 传入（经 guardBusinessMethod 包装后仍是第二个参数）
    'state.attach': (p: AttachParams | undefined, conn?: RpcConnection) => attachState({
      ...(p?.resume !== undefined ? { resume: p.resume } : {}),
      ...(typeof p?.sessionId === 'string' ? { sessionId: assertSessionId(p.sessionId) } : {}),
    }, conn),
    // F06：断线时在途的写调用（prompt 按 promptId、批准按 requestId）实际怎么样了。只读；客户端据此交代结局，不重发
    'state.outcomes': (p: { refs?: unknown }) => writeOutcomes(p),
    'chat.cancel': (p: { sessionId: string; runId?: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      if (p.runId !== undefined && inputController.active(sessionId)?.runId !== p.runId) throw Error('运行已更换，停止请求没有执行');
      inputController.hold(sessionId, '用户停止，等待用户继续');
      const c = controllers.get(sessionId);
      if (c) {
        // F04：先了结这个会话挂着的权限卡，再 abort——与 stopRun 同一顺序，两句之间不能有 await：
        // 工具在权限闸之后先看取消，落的是 [已取消] 而不是「被用户拒绝」。
        // 不了结的话，调度器让 run 在取消时立即收尾，卡片却还挂着：同会话重发会两张卡并存，到点还被记成超时。
        // try/finally：了结卡片的广播万一抛错，也不能挡住 abort。没有在跑的 run 时仍是空操作，不动任何卡片。
        try { denyPendingPerms(sessionId, 'cancelled'); } finally { c.abort(); }
      }
      return { ok: true };
    },
    // F01：provider.runtime.resolve 按配置实例（或设置页未保存的表单）解析运行时规格；只读目录与 providers.json，不碰密钥
    'provider.instances.list': () => providers.list(),
    'provider.instances.create': (p: { name: string; kind: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl?: string; modelId: string; apiKey?: string; contextWindow?: number | null; maxOutputTokens?: number | null; capabilityOverrides?: Record<string, boolean | null> | null; catalogProviderId?: string | null }) => {
      const baseUrl = (typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '') || undefined;
      if (p.kind === 'openai-compat' && !baseUrl) throw new Error('OpenAI 兼容 provider 需要 base URL');
      // ollama 本地端点免 key；其余类型必须带 key
      if (p.kind !== 'ollama' && (typeof p.apiKey !== 'string' || p.apiKey === '')) throw new Error('该 provider 类型需要 API key');
      // F01：手动修正只作用于这个实例；不合法当场报错、不落库（不再按 modelId 同步进目录）
      const ov = parseOverrideInput(p as Record<string, unknown>);
      return providers.create({
        name: p.name, kind: p.kind, baseUrl, modelId: p.modelId,
        ...(ov.contextWindow !== undefined ? { contextWindow: ov.contextWindow } : {}),
        ...(ov.maxOutputTokens !== undefined ? { maxOutputTokens: ov.maxOutputTokens } : {}),
        ...(ov.capabilityOverrides ? { capabilityOverrides: ov.capabilityOverrides } : {}),
        ...(ov.catalogProviderId !== undefined ? { catalogProviderId: ov.catalogProviderId } : {}),
      }, p.apiKey || undefined);
    },
    /** 改配置不必删了重建；apiKey 省略/空串 = 保留原密钥（前端也永远拿不到旧密钥回显）。 */
    'provider.instances.update': (p: { id: string; name?: string; kind?: 'anthropic' | 'openai-compat' | 'gemini' | 'ollama'; baseUrl?: string; modelId?: string; apiKey?: string; contextWindow?: number | null; maxOutputTokens?: number | null; capabilityOverrides?: Record<string, boolean | null> | null; catalogProviderId?: string | null }) => {
      const cur = providers.list().find(x => x.id === p.id);
      if (!cur) throw new Error(`provider 不存在: ${p.id}`);
      const patch: Partial<Omit<ProviderInstance, 'id'>> & { apiKey?: string } = {};
      if (typeof p.name === 'string' && p.name.trim()) patch.name = p.name.trim();
      if (p.kind === 'anthropic' || p.kind === 'openai-compat' || p.kind === 'gemini' || p.kind === 'ollama') patch.kind = p.kind;
      if (typeof p.modelId === 'string' && p.modelId.trim()) patch.modelId = p.modelId.trim();
      if (p.baseUrl !== undefined) patch.baseUrl = (typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '') || undefined;
      if (typeof p.apiKey === 'string' && p.apiKey !== '') patch.apiKey = p.apiKey;
      // M4.5 Task 3 / F01：手动修正「出现了才改」，null（JSON 里的清空写法）或 undefined = 清空；
      // 运行时每次现解析，清空、删除后下一条消息就回到按资料取值，不会有旧覆盖残留
      const ov = parseOverrideInput(p as Record<string, unknown>);
      if (ov.present.has('contextWindow')) patch.contextWindow = ov.contextWindow;
      if (ov.present.has('maxOutputTokens')) patch.maxOutputTokens = ov.maxOutputTokens;
      if (ov.present.has('capabilityOverrides')) patch.capabilityOverrides = ov.capabilityOverrides;
      if (ov.present.has('catalogProviderId')) patch.catalogProviderId = ov.catalogProviderId;
      // 校验「改完之后」的形态，而不是补丁本身：openai-compat 没有 base URL 无法请求
      const kind = patch.kind ?? cur.kind;
      const baseUrl = 'baseUrl' in patch ? patch.baseUrl : cur.baseUrl;
      if (kind === 'openai-compat' && !baseUrl) throw new Error('OpenAI 兼容 provider 需要 base URL');
      providers.update(p.id, patch);
      return { ok: true };
    },
    'provider.instances.delete': (p: { id: string; confirm?: boolean }) => {
      if (p.confirm !== true) throw new Error('删除 provider 需 confirm:true');
      providers.delete(p.id);
      return { ok: true };
    },
    'provider.setDefault': (p: { id: string }) => { providers.setDefaultId(p.id); return { ok: true }; },
    /** T5b：读默认 provider。以前没有这个 RPC，渲染端只能猜「列表第一个」——
     *  设置页把这个猜测放大成一条「当前默认」高亮，用户看到 A、后端实际用 B。 */
    'provider.getDefault': () => ({ id: providers.getDefaultId() ?? '' }),
    /** 设置页「获取列表」：拉端点模型清单填 datalist。纯查询——不广播、不落 settings。
     *  有 id → 已存实例（密钥在 store 内部从 vault 取）；无 id → 新建未保存场景（表单临时 key，
     *  与 create 同一信任边界）。失败抛 ProviderError，由前端静默回退手输。 */
    'provider.models.fetch': async (p: { id?: string; kind?: string; baseUrl?: string; apiKey?: string }) => {
      if (p.id !== undefined) {
        if (typeof p.id !== 'string') throw new Error('id 必须为字符串');
      } else {
        // 无 id 时 kind 决定端点形态与鉴权头，必须是四值之一（有 id 时 kind 由实例决定）
        if (p.kind !== 'anthropic' && p.kind !== 'openai-compat' && p.kind !== 'gemini' && p.kind !== 'ollama') {
          throw new Error('kind 必须是 anthropic/openai-compat/gemini/ollama 之一');
        }
      }
      const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() || undefined : undefined;
      const apiKey = typeof p.apiKey === 'string' ? p.apiKey : undefined;
      const models = await providers.fetchModels(
        { id: typeof p.id === 'string' ? p.id : undefined, kind: p.kind as 'anthropic' | 'openai-compat' | 'gemini' | 'ollama' | undefined, baseUrl, apiKey },
      );
      return { models };
    },
    // ── 网络搜索 provider（独立于模型 provider）：get 只回 {kind, hasKey, baseUrl?}，
    //    密钥留在 vault 内部（前端永远拿不到回显）；set 的 kind 传空/none 表示清除配置。
    'search.provider.get': () => searchProviderStore.get(),
    'search.provider.set': (p: { kind: string; apiKey?: string; baseUrl?: string }) => {
      searchProviderStore.set(p);
      return { ok: true };
    },
    // ── D2 MCP 配置面（servers.json CRUD）：$$VAR 原样存取不解析——渲染端展示引用名本身是安全的，
    //    实际解析在 D3/D4 连接时发生。D6 起 list 增 configError 布尔 + mcp.servers.test 试连。 ──
    // configError 只回布尔：loadError 原文是 parse 异常消息，可能带文件片段（内含明文 headers），
    // 不出 minisd（D2 审核备忘的脱敏落实）；前端据布尔显示固定警示文案。
    // W1a-4：出错时另带 configErrorKind 枚举（read / parse / shape），界面据此区分「改语法」与「查权限或占用」。
    // 只在出错时带这个键——不带 null：mcp-config.test.ts 的 list 用 toEqual 精确比对，枚举也不含任何原文。
    // W1a-5：先对比磁盘重读（只读不写）。设置页每次打开都看到 servers.json 的现状：应用开着时手改的条目、
    // 写坏又修好的文件（拒写态随之解除），都不用重启——横幅「修好后回到这页即可」靠的就是这一步。
    'mcp.servers.list': () => {
      mcpServers.refresh();
      return {
        servers: mcpServers.list(), statuses: mcpManager.statuses(), configError: Boolean(mcpServers.loadError),
        ...(mcpServers.loadErrorKind ? { configErrorKind: mcpServers.loadErrorKind } : {}),
      };
    },
    // W1a-6「改动即时生效」成真：ensureForRun 只连还没连上的服务器，已连上的不会因为配置改了而重连——
    // 改完 env 要等 10 分钟空闲驱逐或重启才生效。所以写成功后让 manager 忘掉这台（断开、摘工具、回 idle），
    // 下一回合按新配置重连。改名时新旧两个名字都忘：旧名那条连接用的是旧配置，也不该再留着。
    // upsert 是补丁语义（只给改过的字段、null 删键、renameFrom 改名），规则见 McpServersStore.compose。
    // 改名不迁移会话级禁用名单（sessions.mcp_disabled_json 存的是名字）——设计稿 §6 已知边界。
    'mcp.servers.upsert': (p: Record<string, unknown>) => {
      const saved = mcpServers.upsert(p);
      mcpManager.forget(saved.name);
      if (typeof p.renameFrom === 'string') mcpManager.forget(p.renameFrom);
      // F13：新旧两个名字挂着的权限卡都作废——批准是在旧配置下要的
      invalidateMcpCards(saved.name, 'mcp-config-changed');
      if (typeof p.renameFrom === 'string') invalidateMcpCards(p.renameFrom, 'mcp-config-changed');
      return { ok: true };
    },
    'mcp.servers.remove': (p: { name: string }) => {
      const name = String(p.name ?? '');
      mcpServers.remove(name);
      mcpManager.forget(name);
      invalidateMcpCards(name, 'mcp-removed');
      return { ok: true };
    },
    'mcp.servers.toggle': (p: { name: string; enabled: boolean }) => {
      const name = String(p.name ?? '');
      mcpServers.toggle(name, p.enabled === true);
      // F13：停用时这台挂着的权限卡当场作废（重新启用不需要：没有卡可言）
      if (p.enabled !== true) invalidateMcpCards(name, 'mcp-disabled');
      return { ok: true };
    },
    /** D6 试连：构造独立临时 client（transport 分派同 manager 缺省工厂）connect + listTools 后即 dispose。
     *  不进 manager 运行时、不注册工具、完整条目形态不落库——试连是「摸一下」，
     *  不能让一次探测改变 run 期状态或配置事实。两形态：
     *  ① 仅 { name }：试已存条目，配置从 store 取；
     *  ② 带条目字段：表单「保存前试连」——W1a-6 起走 store.preview：与 upsert 同一套补丁合并与校验，
     *     以已存条目为底（编辑表单只提交改过的字段，已存的 env / headers / cwd / 超时要带进试连），
     *     不写盘、不受读坏拒写拦截。原先在空的 scratch store 里 upsert，底稿永远是空的。
     *     校验中文错误与连接错误一样回 { ok:false, error }。 */
    'mcp.servers.test': async (p: Record<string, unknown>) => {
      let entry: McpServerEntry;
      if (Object.keys(p).every(k => k === 'name')) {
        const found = mcpServers.list().find(e => e.name === String(p.name ?? ''));
        if (!found) return { ok: false, error: `MCP server 不存在: ${String(p.name ?? '')}` };
        entry = found;
      } else {
        try {
          entry = mcpServers.preview(p);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      const client = entry.transport === 'stdio'
        // F09：试连的 server 同样在作业里启动并登记（不带 toolPrefix：它不承载工具调用，恢复文案不会选中它）
        ? new McpStdioClient({ command: entry.command ?? '', args: entry.args, env: entry.env, cwd: entry.cwd, startupTimeoutSeconds: entry.startupTimeoutSeconds, proc: { supervisor: procSupervisor }, tree: { ownerRef: entry.name } })
        : new McpHttpClient({ url: entry.url ?? '', headers: entry.headers, startupTimeoutSeconds: entry.startupTimeoutSeconds });
      const startedAt = Date.now();
      try {
        await client.connect();
        const tools = await client.listTools();
        return { ok: true, toolCount: tools.length, elapsedMs: Date.now() - startedAt };
      } catch (e) {
        // client 层文案透传即可——$$ 解析值/headers/env 明文不进错误文本（client 层已保证）
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        client.dispose('probe-done');
      }
    },
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
    // F13：答复交给 broker——第一终态获胜。decision 不是三种合法值时报错、卡不动；
    // 卡已了结 / 不认识这个 id / 答复来自发卡之后才建立的连接时返回 applied:false（旧客户端只读 ok，行为不变）。
    // conn 由 RpcServer 传入（经 guardBusinessMethod 包装后仍是第二个参数）：应答方与连接序号从它取
    'permission.respond': (p: { requestId: string; decision: 'allow-once' | 'allow-session' | 'deny' }, conn?: RpcConnection) =>
      permBroker.respond(String(p?.requestId ?? ''), p?.decision, responderOf(conn)),
    // ---- 权限档位预设（permission.preset）：四档真实作用于权限网关 ----
    'permission.getPreset': () => ({ preset: settings.get(PERMISSION_PRESET_KEY) ?? 'ask' }),
    'permission.setPreset': (p: { preset: string }) => {
      const preset = String(p?.preset ?? '');
      // 白名单校验：非四档一律拒绝。非法值若落库，重启时启动读回会把它兜到默认档，
      // 但当场不应静默接受——界面高亮与网关行为必须一致，说不清的档位不如直接报错。
      if (preset !== 'ask' && preset !== 'session' && preset !== 'plan' && preset !== 'full') throw new Error(`非法权限档位: ${preset}`);
      const prev = settings.get(PERMISSION_PRESET_KEY) ?? 'ask';
      gateway.applyPreset(preset);
      settings.set(PERMISSION_PRESET_KEY, preset);
      // 审计带新旧值：切到「完全访问」是高风险动作，未来排查「谁放行了什么」要有据可查
      audit.append('permission.preset', { preset, prev });
      return { ok: true, preset };
    },
    // ---- M2d: terminal.* + files.* + chat.contextInfo（水位条小型 RPC）----
    // F09：进程树的只读快照（本代未结束的树 + 最近结束的）。只有 PID、会话 id、服务器名与状态，没有命令文本与环境
    'proc.trees.snapshot': () => procLedger.snapshot(),
    'terminal.attach': (p: { sessionId: string }) => ({ scrollback: terminals.attach(assertSessionId(p.sessionId)) }),
    'terminal.input': (p: { sessionId: string; data: string }) => { terminals.input(assertSessionId(p.sessionId), String(p.data ?? '')); return { ok: true }; },
    /** U2：Office 文档内容预览。走与 files.read 同一套路径解析，但返回结构化内容
     *  （段落/表格/工作表/幻灯片），由 renderer 渲染成可读预览。
     *  **是内容预览不是版式还原**——UI 上要说明这点（设计稿 §1）。 */
    'office.read': async (p: { sessionId: string; path: string }) => {
      const sessionId = assertSessionId(p.sessionId);
      const abs = paths.resolveGuestPath(sessionId, String(p.path ?? ''));
      const buf = readFileSync(abs);
      if (buf.length > 32 * 1024 * 1024) throw new Error('文件超过 32MB，拒绝解析');
      return await parseOffice(abs, buf);
    },
    'files.list': (p: { sessionId: string; dir?: string }) => filesSvc.list(assertSessionId(p.sessionId), typeof p.dir === 'string' ? p.dir : undefined),
    'files.read': (p: { sessionId: string; path: string }) => filesSvc.read(assertSessionId(p.sessionId), String(p.path ?? '')),
    // chat.contextInfo（M2a 红线：usedTokens 必须基于 buildEffectiveHistory，禁止用原始 history 直接估算）
    // F02：返回 ContextInfo——旧三项保留（windowTokens 仍是上下文窗口），另带这次 / 下一次请求的预算：
    //  运行中是循环发请求前算出、并写进 max_tokens 的那个对象（live: true）；空闲时用同一个 computeSlotBudget、
    //  同一套输入构造方式（系统提示工厂、工具定义、请求消息、按能力改写）推算下一次请求（live: false），
    //  循环发请求前会先修剪的（水位到了修剪档，或余量不足），这里也按修剪后的历史算；历史图片只保留最近两轮、
    //  修剪保留最近若干条，这两处循环都把正在发送的那条算在内，推算时垫一条占位的下一条用户消息来对齐。
    //  两者之差只有：还没发的那条用户消息本身（推算按不带图的文字算）、运行期的临时内容（续写提示、空响应提醒、推理预算加成）、
    //  MCP 是否已连接，以及压缩——付费的摘要请求不在推算里模拟，循环真压缩了的话实际请求只会更小。
    'chat.contextInfo': (p: { sessionId: string }): ContextInfo => {
      const sid = assertSessionId(p.sessionId);
      const history = chat.listMessages(sid);
      // F11B: retained copies remain hidden until explicit restoration.
      const marker = chat.isDeleted(sid) ? undefined : chat.getLatestCompactMarker(sid);
      const effective = compactEngine.buildEffectiveHistory(history, marker);
      // 复用 chat.prompt 的会话绑定→provider/模型组解析链（内联复刻；模型组取链首 slot）。
      // F01：窗口按配置实例解析（与 chat.prompt 传给循环的 runtime 同一个 resolver），不再按 modelId 查目录——
      // 同名模型的两个配置各有各的窗口与手动修正；裸 provider id 的旧绑定也与 chat.prompt 一样按 provider 解
      const instanceSlot = (pid: string): { runtime: RuntimeModel; label: string } | undefined => {
        if (fakeEnabled && pid === '__fake__') return { runtime: fakeRuntime(), label: '当前模型(fake)' };
        const inst = providers.get(pid);
        return inst ? { runtime: runtimeOf(inst), label: slotLabel(inst) } : undefined;
      };
      let slot: { runtime: RuntimeModel; label: string } | undefined;
      const binding = chat.getSession(sid)?.modelBinding;
      if (binding?.startsWith('group:')) {
        const members = providers.resolveGroupMembers(binding.slice('group:'.length));
        slot = members[0] ? { runtime: runtimeOf(members[0].instance), label: slotLabel(members[0].instance) } : undefined;
      } else if (binding?.startsWith('provider:')) {
        slot = instanceSlot(binding.slice('provider:'.length));
      } else if (binding) {
        slot = instanceSlot(binding);
      } else {
        const defaultId = providers.getDefaultId();
        slot = defaultId ? instanceSlot(defaultId) : undefined;
      }
      const runtime = slot?.runtime;
      const windowTokens = runtime?.limits.contextWindow.value ?? FALLBACK_WINDOW;
      let budget: RequestBudget | undefined;
      let live = false;
      if (slot) {
        const running = inFlight.has(sid) ? liveBudgets.get(sid) : undefined;
        if (running) { budget = running; live = true; }
        else {
          try {
            // 每张图只读文件头量尺寸（循环那边是整张图的 base64，度量只解同一段前缀，两边量出同一个尺寸）
            const attDir = paths.sessionBucket(sid, 'attachments');
            const attHeads = new Map<string, string | null>();
            // 下一次请求的末尾会多一条用户消息，循环组消息（历史图片只保留最近两轮、当前轮带不带图）与修剪（保留最近若干条）
            // 都把它算在内：垫一条占位再组、再数、再修剪，组完拿掉（buildPreviewMessages）——推算的是下一次请求里除新消息以外的部分。
            // 新消息按不带图的文字算
            const next: AgentMessage = { role: 'user', parts: [{ type: 'text', value: '' }] };
            const build = (withNext: AgentMessage[]) => buildPreviewMessages(withNext, attHeads, rel => join(attDir, basename(rel)));
            const { messages, needs } = build([...effective, next]);
            const rt = slot.runtime; const label = slot.label;
            const plan = planSlot(rt, 'off', needs, label);
            // 这个槽位接不了下一轮（不输出文本之类）：不出预算，条按旧口径显示
            if (!plan.blocked) {
              const sys = promptFactoryFor(sid)({ modelId: rt.modelId, sessionId: sid, sendTools: plan.sendTools });
              const toolDefs = plan.sendTools ? sessionToolDefs(sid) : [];
              const budgetFor = (m: AgentMessage[]): RequestBudget => computeSlotBudget({
                rt, label, messages: shapeMessagesForSlot(m, plan, label),
                system: { text: joinSystemPrompt(sys), parts: sys }, tools: toolDefs, history,
              }).budget;
              budget = budgetFor(messages);
              // 循环在这份预算下发请求之前会先修剪（减压第 ① / ③ 步）的，这里也修剪后重算：不然条上显示的是修剪前的输入，
              // 还会带出一条实际不会发生的「max_tokens 收紧 / 端点可能拒绝」。只套修剪，不模拟付费的压缩。
              // 修剪同样带着那条占位（循环「保留最近若干条」是把新消息算在内的），两边换成桩的就是同一批结果
              if (prunesBeforeSend(contextPolicy.decideWindow(budget.limits.inputLimit, budget.input.tokens), budget)) {
                const { pruned, history: prunedHistory } = pruneOldToolResults([...effective, next]);
                if (pruned > 0) budget = budgetFor(build(prunedHistory).messages);
              }
            }
          } catch { /* 预算算不出来不影响上下文条：按旧口径显示 */ }
        }
      }
      const usedTokens = budget ? budget.input.tokens : contextPolicy.estimateTokens(effective);
      // F03：最新压缩记录的摘录（来自库，重启后仍在）与最近一次超窗恢复的状态（仅内存）。没有值时不带键。
      // 停在「正在重发」的状态只在运行中有意义（finishRun 会清；这里再挡一道）
      const recovery = liveRecovery.get(sid);
      const showRecovery = recovery && (recovery.phase !== 'resending' || inFlight.has(sid)) ? recovery : undefined;
      return {
        windowTokens, usedTokens, remaining: Math.max(0, windowTokens - usedTokens), ...(budget ? { budget, live } : {}),
        ...(marker ? { compaction: compactionViewOf(marker) } : {}),
        ...(showRecovery ? { recovery: showRecovery } : {}),
      };
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
      if (p.sessionId !== undefined) {
        const sessionId = assertSessionId(p.sessionId);
        // F11B：已删除的会话（含在别的设备上被删、本机留着副本的）不接受技能覆盖。覆盖行按会话归属、随会话一起清：
        // 已清除的会话再写进去，就是一行没人回收的孤儿；保留副本是冻结的，恢复之后的启用集得是它被留下时的那一份。
        // 覆盖表不归 ChatStore 管，存储层那道闸够不着，所以判在这里。从未删除过的 id 不受影响
        if (chat.isDeleted(sessionId)) throw new Error('会话已删除');
        skillStore.setSessionOverride(sessionId, p.id, p.enabled);
      } else skillStore.setEnabled(p.id, p.enabled);
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
    // ---- G1 市场读侧 RPC（设计 §6）：读操作免批（与 skills.list 同档）----
    'market.sources.list': () => market.sourcesList(),
    'market.search': (p: { kind?: unknown; q?: unknown; category?: unknown; cursor?: unknown }) =>
      market.search(p ?? {}),
    'market.detail': (p: { id?: unknown }) => market.detail(p ?? {}),
    // ---- G2 市场安装链路 RPC（设计 §3/§4/§6）：installPlan 确认卡数据 / install 执行 /
    //  installed 双向核对。install 是状态变更：确认卡 confirm + 服务端 verdict 复核
    //  （malicious 硬阻断，无任何跳过参数）；技能装后广播 skills.changed，零自动执行。----
    'market.installPlan': (p: { id?: unknown }) => marketInstaller.installPlan(p ?? {}),
    'market.install': (p: { id?: unknown; confirm?: unknown; env?: unknown }) => marketInstaller.install(p ?? {}),
    'market.installed': (p: { kind?: unknown }) => marketInstaller.installed(p ?? {}),
    // ---- G4 市场更新检查 RPC（设计 §6）：checkUpdates 只读上游比对（免批），仅手动触发
    // （UI 按钮，无后台轮询）；detail 走 ttlMs=0 条件请求。Update 流复用 installPlan/install
    // （状态变更照走确认卡 + verdict 复核，无独立 update 通道）。----
    'market.checkUpdates': () => marketInstaller.checkUpdates(),
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

  // K1：捕获**包装前**的 chat.prompt 裸引用——guardBusinessMethod 包装体读 conn.authMode，
  // 调度器是进程内调用没有 conn；处理器本身不用第二参（调研核实），裸调即等价本地调用。
  // F05：第三个实参是运行来源——只有这种进程内调用给得了，远端客户端无法把自己的 prompt 标成定时任务
  const rawChatPrompt = methods['chat.prompt'] as (p: { sessionId: string; text: string; promptId?: string }, conn?: RpcConnection, origin?: RunOrigin, claim?: QueueClaim) => Promise<ChatPromptResult>;

  const authToken = randomUUID().toUpperCase();

  const isPaired = (fp: string): boolean => pairingService.get(fp) !== undefined;
  const registry = new RpcMethodRegistry(isPaired);
  registry.register(methods, 'business');
  registry.register(inputController.methods, 'business');
  registry.register(createModelMetadataMethods(catalog, { getInstance: id => providers.get(id) }), 'business');

  // M4 Task 4：diagnostics.dryRun RPC 方法（authMode=local，仅本机渲染进程/CLI 可调）
  // 注册时统一拒 pairing，方法体内另拒 remote（保持原有两层检查与报错）。
  const diagnosticsMethods = createDiagnosticsMethods({
    providers, vault, catalog, skillStore, pairingService, skillsRoot,
    config: providers.getPromptConfig(),
    // M6 R2 决策点 2-6 补充：dry-run 诊断项暴露本端同步暂停状态（懒读取，反映调用时状态）
    syncPaused: () => settings.getBool(SYNC_PAUSE_KEY, false),
    // F01：窗口检查与实际请求同一个解析（实例手动修正生效、同名的其它配置不串）
    runtimeOf: id => { const inst = providers.get(id); return inst ? runtimeOf(inst) : undefined; },
    // F09：进程树托管状态（诊断项 processOwnership）
    procOwnership: () => procSupervisor.status,
  });
  registry.register(diagnosticsMethods, 'business');
  // F08：checkpoints.*（仅本机连接，方法体第一句就拒远程）。
  registry.register(createCheckpointMethods(checkpointService, checkpointStore, { audit: (t, p, o) => audit.append(t, p, o) }), 'business');

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
  // 配对协议单独声明连接模式；业务面已在每次注册时复查配对。
  registry.register(remoteMethods, name => ({ authModes: name === 'remote.pair.complete' ? ['pairing'] : ['local'] }));
  const additionalVerify = createAdditionalVerify(pairingService);

  // F11A 附件同步：消息里引用的附件经同一条加密通道传到对方（sync.att.*），本机方法 attachments.* 给界面看状态、重试、打开。
  // 构造时同步做一次启动自检（清上次留下的暂存）。outbound / rpc 都是懒取值：它们在后面才实例化。
  const attachmentSync = createAttachmentSync({
    db, root, paths, isPaired,
    pairedPeers: () => pairingService.list().map(d => d.peerFingerprint),
    // F11B：getSession 看不到已删除的会话，也看不到保留副本（在别的设备上被删、本机留着内容）——
    // 附件同步因此把它们当作没有任何引用：不登记、不送出、不受理。恢复之后重新可见，引用随之回来
    sessionExists: sid => chat.getSession(sid) !== undefined,
    sessionCursor: sid => chat.getSessionCursor(sid),
    outbound: () => outboundClient,
    isInboundOnline: fp => rpc.isInboundOnline(fp),
    broadcast: (m, p) => rpc.broadcast(m, p),
    audit: (event, payload, sessionId) => audit.append(event, payload, { sessionId }),
  });

  // ---- F11B：应用对端墓碑的宿主（规格 docs/specs/2026-10-03-f11b-delete-propagation.md）----
  // 对端删除了一个会话，本机这个会话可能正在跑。顺序与本机删除相同：停 run → 释放终端与 shell → 落库。
  // 唯一的 await 是 stopRun；从它兑现到落库之间全是同步代码（新的 chat.prompt、remote.unpair 都是另一个任务，插不进来）。
  /** run 还没停下的会话上等着落地的墓碑（每个会话至多一条）。只在内存里：进程重启后靠对账重新送达。 */
  const deferredTombstones = new Map<string, { t: WireLifecycle; fromPeer?: string }>();

  /** 落库前的闸，全是同步判断。返回不能落库的原因；可以落库返回 undefined。 */
  function tombstoneBlock(fromPeer: string | undefined): 'closing' | 'paused' | 'unpaired' | undefined {
    if (closing) return 'closing';
    // 暂停期间墓碑平面静默：对端的删除不在本机生效（设备页写的是「已暂停：不再与其它设备收发会话」）
    if (settings.getBool(SYNC_PAUSE_KEY, false)) return 'paused';
    // 已取消配对的设备的删除不再落地。外层的业务守卫只在调用入口查一次配对，而应用墓碑要等 run 停下；
    // 拨号方从应答或拉取里拿到的墓碑根本不经过那层守卫。fromPeer 为空是本机连接注入的，不查
    if (fromPeer !== undefined && !isPaired(fromPeer)) return 'unpaired';
    return undefined;
  }

  /** 早退路径：本机这个会话不是存活态（重复、过期、同代、本机已是删除态），没有 run 可停。参数名故意不叫 sessionId。 */
  function applyTombstoneNoRun(sid: string, t: WireLifecycle, fromPeer: string | undefined): TombstoneOutcome {
    return chat.applyTombstone(sid, t, { fromPeer });
  }

  /** run 收尾后的延后重试。条目先取出再删，重试走主函数的入口闸（期间可能已关停、暂停、取消配对）。 */
  function retryDeferredTombstone(sid: string): Promise<TombstoneOutcome> | undefined {
    const waiting = deferredTombstones.get(sid);
    deferredTombstones.delete(sid);
    return waiting ? applyRemoteTombstone(sid, waiting.t, waiting.fromPeer) : undefined;
  }

  async function applyRemoteTombstone(sessionId: string, t: WireLifecycle, fromPeer: string | undefined): Promise<TombstoneOutcome> {
    const blocked = tombstoneBlock(fromPeer);
    if (blocked) return { status: 'deferred', reason: blocked };
    // 只有「对端胜出、本机这个会话还活着」才需要先停 run；其余情形交给早退路径（与这句判定之间没有 await，事务里还会再判一次）
    const decision = decideIncoming(chat.getLifecycle(sessionId), t);
    if (!(decision.action === 'apply-tombstone' && !decision.localDeleted)) return applyTombstoneNoRun(sessionId, t, fromPeer);
    const waiting = deferredTombstones.get(sessionId);
    if (waiting) {
      // 上一条还在等 run 停下：不再重复等。换成更优先的那条，或原来那条的来源已取消配对时换成这条
      if (compareLifecycle(t, waiting.t) > 0 || (waiting.fromPeer !== undefined && !isPaired(waiting.fromPeer))) {
        deferredTombstones.set(sessionId, { t, fromPeer });
      }
      return { status: 'deferred', reason: 'run-stopping' };
    }
    // 中止原因沿用 'session-deleted'：挂着的权限卡按它了结，定时任务的终态记「会话已删除」
    const stopped = await stopRun(sessionId, runStopTimeoutMs, 'session-deleted');
    // await 期间可能已关停、暂停，或送来这条墓碑的设备被取消配对：复查，不能落库就丢下（已经发出的中止不撤回）
    const blockedAfterStop = tombstoneBlock(fromPeer);
    if (blockedAfterStop) return { status: 'deferred', reason: blockedAfterStop };
    if (!stopped) {
      // 停不下来（不理会 abort 的调用）：不硬删。记下这条墓碑，run 自己收尾后重试；对端下次对账也会重送
      deferredTombstones.set(sessionId, { t, fromPeer });
      const run = runs.get(sessionId) ?? Promise.resolve();
      void run.then(() => retryDeferredTombstone(sessionId)).catch((e: unknown) => {
        console.warn(`延后应用会话 ${sessionId} 的删除失败，等下次对账:`, e);
      });
      return { status: 'deferred', reason: 'run-stopping' };
    }
    terminals.dispose(sessionId);
    shells.dispose(sessionId);
    return chat.applyTombstone(sessionId, t, { fromPeer });
  }

  const tombstoneHost: TombstoneHost = { applyRemoteTombstone };

  // M3b 接线：sync.* 在注册时拒 pairing、每次调用复查配对（红线 4e）。
  // M3c Task 4：createSyncMethods 第二参注入 pairingService/listenPort（sync.hello 用，端口漂移自愈必改 4）
  //   syncOpts 用可变对象：listen 前占位 0，listen 后更新为实际端口——sync.hello 闭包引用 opts.listenPort 能拿到新值。
  // M3c Task 6：onMergedRemote 注入——sync.push handler 合并有变化时广播 chat.event synced（监听方路径，小项 7e）
  const syncOpts: {
    pairingService: PairingService;
    listenPort: number;
    onMergedRemote?: (peerFingerprint: string | undefined, sessionId: string, result: SyncReceiveResult) => void;
    onPeerHello?: (peerFingerprint: string | undefined, peer: { protocolVersion: number; caps: Readonly<Record<string, boolean>> }) => void;
    lifecycleHost?: TombstoneHost;
    isPaused?: () => boolean;
  } = {
    pairingService,
    listenPort: 0,
    onMergedRemote: (peerFp, sid, result) => {
      rpc.broadcast('chat.event', { kind: 'synced', sessionId: sid, mergedCount: result.mergedCount, fromDevice: peerFp });
      // F11B：合并新建了会话行，或让保留副本重新可见——界面要重拉列表，恢复出来的会话才会出现
      if (result.sessionCreated) rpc.broadcast('chat.sessions.changed', {});
    },
    // F11A：应答端记下每个入站对端在 sync.hello 里的声明（支不支持附件同步）
    onPeerHello: (fp, peer) => attachmentSync.onPeerHello(fp, peer),
    // F11B：对端推来的墓碑经宿主先停 run 再落库；本端暂停时对 remote 连接不交出墓碑
    lifecycleHost: tombstoneHost,
    isPaused: () => settings.getBool(SYNC_PAUSE_KEY, false),
  };
  const syncMethods = createSyncMethods(chat, syncOpts);
  registry.register(syncMethods, 'business');
  registry.register(attachmentSync.peerMethods, 'business');
  registry.register(attachmentSync.localMethods, 'business');

  rpc = new RpcServer(registry.methods, authToken, additionalVerify, { events: eventLog });

  // ---- K1 调度器（设计稿 §3）：30s tick + 启动后 3 秒先查一次 ----
  // 运行边界：minisd 随应用进程起停——关窗只是藏到托盘，照常 tick；从托盘退出或关机后才不跑。
  // 错过的任务（应用没在跑时过了点）：dueJobs 不分 once / interval / cron，只看 next_run_at 过没过点，
  // 所以启动后 3 秒那次检查会把每个过点的任务各补跑一次；markRun 再从当下重算下一次，错过几次也只补这一次（不逐次补）。
  // W2b-11d 订正：这里原写 interval/cron 错过「跳过重算（markRun 从当下起算，天然如此）」——从当下起算只管补跑之后的
  // 下一次，挡不住补跑本身。cron 设计稿 §0 原定 interval/cron 错过不补、只补 once，实现从没按 kind 分过；
  // 定时页页头已按实际行为告诉用户（W2b-11a），止血波不改行为，注释跟着行为改（cron/store.ts 文件头同）。
  function runCronJob(job: CronJob): void {
    // W1b-5：关停中不再建会话、不再起 run（cron.runNow 的调用方会收到这句）；30 秒 tick 在 close 第二步就停了
    if (closing) throw new Error(CLOSING_MESSAGE);
    try {
      // 并发防重：上次会话还在跑就跳过本次，重算下一次（不排队不叠跑）
      if (job.lastSessionId && inFlight.has(job.lastSessionId)) {
        cronStore.markRun(job.id, job.lastSessionId); // 重算 next（once 会因此停用——正确：它已在跑）
        cronStore.markDone(job.id, 'skipped-running：上一次触发还在运行');
        rpc.broadcast('cron.changed', {});
        return;
      }
      const stamp = new Date();
      const mm = String(stamp.getMonth() + 1).padStart(2, '0');
      const dd = String(stamp.getDate()).padStart(2, '0');
      const hh = String(stamp.getHours()).padStart(2, '0');
      const mi = String(stamp.getMinutes()).padStart(2, '0');
      const s = chat.createSession(`⏰ ${job.name} ${mm}-${dd} ${hh}:${mi}`, settings.get(WORKSPACE_LAST_KEY), 'cron');
      let statusNote = '';
      if (job.assistantId) {
        const a = assistantStore.get(job.assistantId);
        if (a) applyAssistantPreset({ chat, skills: skillStore }, s.id, a);
        else statusNote += '助手已删，按无助手跑；';
      }
      if (job.workspaceRoot) {
        if (existsSync(job.workspaceRoot)) chat.setWorkspaceRoot(s.id, job.workspaceRoot);
        else statusNote += '工作区目录不存在，用默认；';
      }
      cronStore.markRun(job.id, s.id);
      if (statusNote) cronStore.markDone(job.id, `running（${statusNote.replace(/；$/, '')}）`);
      // 完成钩子：写终态并广播——无人值守失败不再无痕（设计稿 §0 治理项）
      runDoneHooks.set(s.id, (err) => {
        cronStore.markDone(job.id, err ? `error: ${err.slice(0, 200)}` : 'ok');
        rpc.broadcast('cron.changed', {});
      });
      rpc.broadcast('chat.sessions.changed', {});
      rpc.broadcast('cron.changed', {});
      // F05：定时任务复用同一个执行入口，run 行记下来源（哪个任务）；每次触发新建会话，promptId 按会话取
      void rawChatPrompt({ sessionId: s.id, text: job.prompt, promptId: 'cron:' + s.id }, undefined, { kind: 'cron', ref: job.id }).catch((e: unknown) => {
        // 同步拒绝（并发闸/空文本等）走不到 IIFE 的 finally——钩子在这里收尾
        runDoneHooks.delete(s.id);
        cronStore.markDone(job.id, `error: ${String(e).slice(0, 200)}`);
        rpc.broadcast('cron.changed', {});
      });
    } catch (e) {
      // create/markRun 阶段的失败也要留痕（任务不存在除外——那是调用方的错）
      try { cronStore.markDone(job.id, `error: ${String(e).slice(0, 200)}`); } catch { /* 任务已删 */ }
      rpc.broadcast('cron.changed', {});
    }
  }
  let cronTicking = false;
  function cronTick(): void {
    if (cronTicking || closing) return; // tick 防重入（上一轮建会话/写库还没完时不叠加）；关停中不再触发
    cronTicking = true;
    try { for (const job of cronStore.dueJobs(Date.now())) runCronJob(job); }
    finally { cronTicking = false; }
  }
  const cronTimer = setInterval(cronTick, 30_000);
  cronTimer.unref(); // McpManager 巡检同款：定时器不阻止进程退出
  const cronBoot = setTimeout(cronTick, 3_000); // 启动首查延后 3s，等装配稳定
  cronBoot.unref();
  // F05：运行心跳（有活动 run 时每 10 秒写一次）。只供存活判断与诊断，没有任何逻辑据此改状态
  runLedger.startHeartbeat();
  // M3c Task 4：端口持久化（必改 4b）——读 minisd-port.json 复用 → 占用回退随机 → 写文件
  const listenHost = opts?.host ?? '127.0.0.1';
  const port = await resolveAndPersistPort(root, listenHost, opts?.port ?? 0, (h, p) => rpc.listen(h, p), authToken);
  syncOpts.listenPort = port; // sync.hello 响应带实际监听端口（对端刷新地址簿，端口漂移自愈）

  // M3c Task 6：OutboundClient 装配（决策 8）——出站 WS 客户端，拨已配对对端（主从裁决 myFp < peerFp 者主拨）
  // 在端口持久化后实例化：start() 用 pairingStore 里的地址（pairing 时习得），与端口无直接依赖，
  // 但与 SyncCoordinator 绑定（start/stop 联动），此处实例化顺序最稳。
  outboundClient = new OutboundClient(pairingService, pairingService.myFingerprint);

  // M3b 接线 + M3c Task 6 扩展：SyncCoordinator 注入 OutboundClient（决策 4 拨号方双职责 push+pull）
  const syncCoordinator = new SyncCoordinator(chat, rpc, { outbound: outboundClient, attachments: attachmentSync.port, lifecycleHost: tombstoneHost });
  chat.onDirty = sid => syncCoordinator.onDirty(sid);
  // F11B：会话生命周期事件（删除、对端删除落地、恢复、清掉保留副本、旧副本被拒）→ 附件侧失效、审计、广播。
  /** 「旧副本被拒」的审计每个（会话，对端）在进程生命周期内只记一次：拿着旧副本的旧版对端每次对账都会再推一遍。 */
  const staleCopyLogged = new Set<string>();
  chat.onLifecycle = e => {
    // 第一句：让附件同步对这个会话的引用缓存与「已收敛」记号作废。放在审计之前并单独兜住，审计写失败时它照样发生；
    // Erase session-owned event retention before publishing the deletion notice.
    // Retained copies are hidden too; explicit restoration does not restore old frames.
    if (e.kind === 'deleted' || e.kind === 'tombstone-applied' || e.kind === 'purged' || e.kind === 'retained-released') {
      inputQueue.holdSession(e.sessionId, '会话已删除');
      liveRecovery.delete(e.sessionId); // F03: all deletion paths, including remote retained copies
      eventLog.redactSession(e.sessionId);
    }
    // 清掉保留副本、保留副本被释放这两种不经 onDirty（登记没变），只有这一条路
    if (e.kind !== 'stale-content-rejected') {
      try { attachmentSync.port.markDirty(e.sessionId); } catch { /* 端口方法约定不抛 */ }
    }
    // F08：会话被物理清除（本机删除、对端墓碑覆盖了全部内容、保留副本被释放或彻底删除）时，它的检查点记录已在同一个事务里清掉；
    // 这里随即回收不再被任何记录引用的内容文件。那些是用户文件的明文副本：不回收的话要等下一次文件写入、看「改动」页或重启，
    // 而对端删除落地的这台机器可能很久都没有这些动作。保留（retained）不触发——它的检查点与内容一起留着；
    // 本机从没有过的会话的墓碑也不触发——首次配对可能一次收到上千条，而它们名下没有检查点。gc 自己兜住所有错误，从不抛
    if (e.kind === 'deleted' || e.kind === 'purged' || e.kind === 'retained-released'
      || (e.kind === 'tombstone-applied' && e.hadLocalCopy && !e.retained)) checkpointStore.gc();
    try {
      const { sessionId, lifecycle } = e;
      const by = lifecycle.originDeviceId;
      const notice = (n: Omit<SessionLifecycleNotice, 'sessionId' | 'v' | 'byDevice'>): void => {
        const full: SessionLifecycleNotice = { sessionId, v: lifecycle.v, byDevice: by, ...n };
        rpc.broadcast('chat.sessions.lifecycle', full);
      };
      // 审计载荷不含标题与任何消息内容；对端指纹放进 payload（audit.list 不返回 peer_fingerprint 列）
      switch (e.kind) {
        case 'deleted':
          audit.append('session.deleted', { v: lifecycle.v, opId: lifecycle.opId, messageCount: e.messageCount }, { sessionId });
          notice({ kind: 'deleted', origin: 'local' }); // chat.sessions.changed 由删除处理器照旧广播
          break;
        case 'tombstone-applied':
          // 本机从没有过这个会话（别的设备转发来的墓碑）：不记审计、不广播——首次配对时可能一次收到上千条
          if (!e.hadLocalCopy) break;
          audit.append('session.deleted.remote', {
            v: lifecycle.v, opId: lifecycle.opId, by, via: e.fromPeer, retained: e.retained, unseenCount: e.unseenCount, annotationCount: e.annotationCount,
          }, { sessionId });
          rpc.broadcast('chat.sessions.changed', {});
          notice({ kind: 'tombstone-applied', origin: 'remote', viaPeer: e.fromPeer, retained: e.retained, unseenCount: e.unseenCount });
          break;
        case 'retained-released':
          audit.append('session.retained.released', { v: lifecycle.v, opId: lifecycle.opId, by, via: e.fromPeer }, { sessionId });
          rpc.broadcast('chat.sessions.changed', {});
          notice({ kind: 'retained-released', origin: 'remote', viaPeer: e.fromPeer });
          break;
        case 'restored':
          audit.append('session.restored', { v: lifecycle.v, opId: lifecycle.opId }, { sessionId });
          notice({ kind: 'restored', origin: 'local' }); // chat.sessions.changed 由 chat.sessions.restore 处理器广播
          break;
        case 'restore-applied':
          audit.append('session.restored.remote', { v: lifecycle.v, opId: lifecycle.opId, by, via: e.fromPeer }, { sessionId });
          notice({ kind: 'restore-applied', origin: 'remote', viaPeer: e.fromPeer }); // chat.sessions.changed 由 sessionCreated 那条路广播
          break;
        case 'purged':
          audit.append('session.retained.purged', { v: lifecycle.v }, { sessionId });
          notice({ kind: 'purged', origin: 'local' });
          break;
        case 'stale-content-rejected': {
          const key = `${sessionId}\n${e.fromPeer ?? ''}`;
          if (staleCopyLogged.has(key)) break;
          if (staleCopyLogged.size >= 10_000) staleCopyLogged.clear();
          staleCopyLogged.add(key);
          audit.append('session.stale-copy.rejected', { v: lifecycle.v, via: e.fromPeer }, { sessionId });
          break;
        }
      }
    } catch (err) {
      console.warn(`会话生命周期事件 ${e.kind} 的审计或广播失败（操作本身不受影响）:`, err);
    }
  };
  // F11B 墓碑压实：只置空超龄墓碑的消息 id 列表，不删行。自己兜住，失败不挡启动。（生命周期自检在启动恢复之前做过了）
  try { chat.compactTombstones(chat.nowEpoch(), opts?.tombstoneSeenTtlS ?? TOMBSTONE_SEEN_TTL_S); } catch (e) { console.warn('墓碑压实失败:', e); }
  // M6 Task 5：启动时读 settings.sync.paused 注入暂停阀（决策点 2-6 持久化）——
  //  setPaused 在 start() 前调用：暂停态不拨号/不广播，但 pull（对端主动推来）照常收下。
  syncCoordinator.setPaused(settings.getBool(SYNC_PAUSE_KEY, false));
  syncCoordinator.start(); // 触发 outboundClient.start() + 挂 onRemoteDirty
  // F05：启动恢复补写的结果消息是普通消息，照常同步——恢复那会儿 chat.onDirty 还没接上，这里补标一次
  for (const sid of recovered?.sessions ?? []) syncCoordinator.onDirty(sid);

  /** 有序关停（W1b-5 · lifecycle.md W1b-quit）。旧顺序是 abort 之后对挂起的权限只 clearTimeout、不了结，然后不等 run 收尾就关库：
   *  卡在权限上的 run 永远等不到决议，toolResult 从没落库（重开会话带着孤儿 tool_use）；流式中途的半截回复能不能落库全看运气。
   *  新顺序：
   *   1. 置 closing，此后 chat.prompt / 定时任务拒绝；
   *   2. 停同步与调度器；
   *   3. 按 'shutdown' 了结全部挂起的权限卡（含不属于在跑 run 的，例如终端里桥命令发起的）；
   *   4-5. 逐个 stopRun：abort 并等收尾，与 graceMs 赛跑（并发等，总时长不超过 graceMs）；
   *   6. 销毁终端、shell、MCP，等它们的子进程树回收落定（上限 reapWaitMs，W1b-5d），再关桥与 rpc；
   *   7. 关库；
   *   8. 释放数据根锁——库关了才让别的实例进来（设计稿 §3 第 9 条）。
   *  第 3、4 步在同一段同步代码里：工具在权限闸之后先看取消，落库的是 [已取消]，不是「被用户拒绝」。
   *  第 2–6 步每一步各自兜住（shutdownStep / shutdownReap / shutdownStepAsync）：一步抛错只记一笔，后面的 abort、
   *  销毁子进程照做——审查实测，以前第 3 步的审计写入一抛，run 没中止、MCP 与 PowerShell 子进程没销毁（Windows 上成孤儿），
   *  关库放锁也被跳过，同一进程里这个根再也打不开。第 7、8 步在 finally 里，兜住之外的意外也挡不住它们。 */
  async function shutdown(graceMs: number): Promise<void> {
    closing = true;
    try {
      shutdownStep('停同步', () => syncCoordinator.stop());
      shutdownStep('停调度器', () => { clearInterval(cronTimer); clearTimeout(cronBoot); }); // K1：调度器随进程收尾
      shutdownStep('停运行心跳', () => runLedger.stopHeartbeat());
      shutdownStep('了结权限卡', () => denyPendingPerms('all', 'shutdown'));
      // 与上一句之间不能有 await：map 同步跑完每个 stopRun 的开头（abort），工具醒来时看到的已是「已取消」。
      // 每个会话单独兜住：Promise.all 遇到第一个失败就不等了，其余 run 还在写库时就会往下关库
      await Promise.all([...runs.keys()].map(sessionId => stopRun(sessionId, graceMs, 'shutdown').catch((e: unknown) => {
        console.warn(`关停：停会话 ${sessionId} 失败，继续后面的步骤:`, e);
      })));
      // 第 6 步（W1b-5d）：三者都当场发起，再一起等回收落定，最多等 reapWaitMs。以前起了 taskkill 不等就往下关库、
      // standalone 随即 exit(0)：taskkill 随 minisd 的作业一起被结束，npx 拉起的 node、终端里的 dev server 没人收（proc/win-exec.ts）
      await shutdownReap([
        ['销毁终端', () => terminals.disposeAll()],
        ['销毁 shell', () => shells.disposeAll()],
        ['断开 MCP', () => mcpManager.disposeAll()],
      ], reapWaitMs);
      await shutdownStepAsync('关桥', () => bridge?.close());
      await shutdownStepAsync('关 rpc', () => rpc.close());
      // F05 封账：本代次记为有序关停，此后账本的一切写入是空操作（没在时限内停下的 run 晚到的写入不再碰库）。
      // 仍活动的 run 留给下次启动，记成 interrupted / shutdown-timeout
      shutdownStep('封输入队列', () => inputQueue.close());
      shutdownStep('封账', () => runLedger.close());
      // F09：进程账本同样封账——此后的写入是空操作；回收已发起、退出事件没赶上的树由下一代关成 stopped
      shutdownStep('封进程账', () => procLedger.close());
    } finally {
      // release 可重复调用，同一个根 close 后能在本进程里重启（auto-sync.test.ts）
      try { db.close(); } finally { lock.release(); }
    }
  }
  let closed: Promise<void> | undefined;

  return {
    port, listenPort: port, authToken, bridgePipe,
    // 幂等：主进程的 shutdown 消息、测试的 afterEach 可能各调一次，第二次拿到同一个 promise，不会二次关库
    close: (o?: { graceMs?: number }) => (closed ??= shutdown(o?.graceMs ?? CLOSE_GRACE_MS)),
  };
}

/** 引擎被设成监听本机以外的地址时启动写的一行提示（W3-sec5；W3-sec6 起设备之间的连接已加密）。
 *  还剩配对那一步不加密：同一网络里的主动攻击者看得到配对码就能在配对时插一脚，所以提醒只在可信网络里配对。
 *  只监听回环（不设、127.x、localhost、::1）返回 undefined。 */
export function lanExposureWarning(host: string | undefined): string | undefined {
  const h = (host ?? '').trim().toLowerCase();
  if (h === '' || h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return undefined;
  return `提示：MINISD_HOST=${host}，引擎对本机以外开放。设备之间的连接是加密的，但配对那一步不加密（明文交换公钥），请只在可信的局域网里配对。`;
}

// 作为独立进程启动时（Electron utilityProcess / --headless）
if (process.env.DESKMINIS_STANDALONE === '1') {
  // W2b-7 崩溃钩子（行为在 diag/crash-hooks.ts）：未捕获异常记进 <logRoot>/crashes.json 后退出，未处理拒绝记完继续跑。
  // 分支第一句，赶在装配之前：启动途中的崩溃也记得下。只装在这里：进程内起 minisd 的测试不经过这个分支，
  // 装进 vitest worker 会吞掉测试框架自己的未捕获异常。日志目录由主进程经 DESKMINIS_LOG_DIR 下发。
  installMinisdCrashHandlers(logRootFromEnv(process.env));
  // M3a：MINISD_HOST env 接线（设计 §3.1）——main/index.ts utilityProcess.fork 时 env 注入，
  // standalone 分支读 env 传入 startMinisd({ host })，不改 startMinisd 签名。
  // 默认 127.0.0.1（仅本机）；设 0.0.0.0 开放局域网（配 PASETO/配对码鉴权）。
  const startOpts = process.env.MINISD_HOST ? { host: process.env.MINISD_HOST } : undefined;
  // stderr 由主进程记进按天日志（[minisd:err] 行）
  const lanWarning = lanExposureWarning(process.env.MINISD_HOST);
  if (lanWarning) process.stderr.write(lanWarning + '\n');
  const starting = startMinisd(startOpts);
  // W1b-5 优雅退出：主进程退出（托盘、before-quit、重启并安装）前 postMessage({type:'shutdown'})，
  // 这里有序 close（了结权限卡、等 run 收尾、关库、放锁）再退；主进程等 5 秒，超时才 kill。
  // 以前 startMinisd 的返回值直接丢掉，close 从没接上，退出一律是硬杀。
  // 监听在启动完成之前就挂上：启动期间收到的 shutdown 不丢，启动完立刻关；启动失败由下面的 catch 收尾退出。
  // 不接 SIGTERM：kill() 在 POSIX 上发的就是它，接了会让主进程的超时兜底变成再等一轮。
  // 关停这条路只经 closeThenExit 退出：close 做完（关库、放锁）才 exit(0)。分支里别处不写 process.exit（守卫认这一点）。
  process.parentPort?.on('message', (e) => {
    if ((e?.data as { type?: unknown } | undefined)?.type !== 'shutdown') return;
    void closeThenExit(starting, code => process.exit(code));
  });
  // F09 属主轮询：主进程没了（被强杀、崩溃）而引擎还活着时，给自己发一条 shutdown，走与主进程请求关停完全相同的那条路
  // ——了结权限卡、停 run、回收子进程树、封账、关库、放数据根锁。没有它，引擎会握着锁一直留在后台。
  // 标准流静音在启动时就挂：主进程一死，通往它的输出管道就断了，从那一刻到轮询发现的几秒里，一次直接写冒出来的 EPIPE
  // 没有监听就是未捕获异常（proc/parent-watch.ts）。只在有 parentPort 时启用（真实的 utilityProcess）。
  if (process.parentPort) {
    muteBrokenStdio();
    watchParent({
      ppid: process.ppid,
      onGone: () => { process.parentPort?.emit('message', { data: { type: 'shutdown' } }); },
    });
  }
  starting
    // 握手行同时交出 token：主进程必须把它经 ipcMain.handle('minisd:info') 交给渲染进程，
    // 否则渲染进程连不上自己的守护进程。
    .then(({ port, authToken }) => { process.stdout.write(JSON.stringify({ minisdPort: port, authToken }) + '\n'); })
    // 没有 .catch 的话，DB / 密钥库任一失败都只是一次未处理拒绝：进程静默退出，
    // 父进程只能看到 "exit code=1"，真正的原因（哪一行、什么错）永远看不到。
    // stderr 那行照旧；库比应用新 / 数据目录被占这类用户能自己处理的，再写一行致命行给主进程弹框（§3 第 8 条）。
    // 数据根用 dataRoot()：standalone 不传 dataDir，startMinisd 用的就是它。
    .catch(e => reportStartupFailure(e, dataRoot()));
}
