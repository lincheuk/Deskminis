/**
 * W3-smoke · 发版冒烟脚本 scripts/smoke-release.mjs（止血设计稿 §5 第 3 条、§5.1）。
 *
 * 为什么要它：发版前的真 key 冒烟——新一代 Claude（Fable 5.1 / Opus 5.5）的多轮工具调用与 memory_write、
 * DeepSeek V4 第二轮起的 reasoning_content 回放、参数带空格路径的 MCP 试连、shell 里长命令点停止后进程树不留 ping——
 * 手工做一遍要十几步，还容易碰到用户真实的数据根与凭据。脚本把它做成一条命令，用户在 Windows 上跑；
 * --mock 把两个模型用例改连脚本内起的假端点，在 Linux 上就能验证脚本本身。
 *
 * 本文件分三层：
 *  1. 纯函数：参数解析、跳过判定、minisd 的环境、脱敏、握手行与致命行、结果表与退出码、剧本与指令、
 *     用例判定、权限卡应答、进程表（含停完引擎后收拾它名下的残留进程）、凭据库清理、明文 key 扫描；
 *     清理（cleanup）与选凭据库（chooseVault）用假凭据库直接调，清理的进程操作（取进程表、看还在不在、结束）注入假的——
 *     「结束不了」「核对不了身份」「停引擎前取不到进程表」这几处判 FAIL 在真进程表上凑不出来；凭据库在停引擎前那次取进程表
 *     返回之前就已清掉、停完再清一遍；服务名接错成正式版 DeskMinis 或开发态 DeskMinis-dev 时选库、交给引擎、清理三处一条不碰；
 *     runSmoke 进程内以 platform:'win32' 跑一遍（假凭据库、记下环境就退出的假引擎），钉住这三处服务名的接线；
 *     与引擎打交道的收尾逻辑（连接一断 call 立即拒绝、被打断后连接拒绝新请求、回合原因只报一次、引擎退出与崩溃的判定、
 *     建过的 provider 一建好就登记进凭据库清单、shell-stop 抛出时摘掉回合监听）用本地 ws 或假连接测；
 *  2. 假端点对真 provider：假端点的流式格式必须让 src 里的 AnthropicProvider / OpenAIProvider 解析出剧本里的工具调用；
 *     假端点照真端点拦下错误的请求（key 不对、思考块签名被改、tool_use 没有配对结果、DeepSeek V4 历史缺 reasoning_content）；
 *     脚本写出的最小 MCP 服务器能握手、列工具，参数被拆开时以 3 退出；
 *  3. 整条 --mock：先构建，再以 --mock --memory-vault 跑脚本——四个用例与「清理」都有结论、退出 0、临时目录已删；
 *     打印的每一行都先脱敏（key 恰好取一段一定会打印的字，输出里只剩 [已隐藏]）；输出管道被读的一端先关掉也不崩、照样清理；
 *     shell-stop 单独再走一遍（非 Windows 在 PATH 前面放照驱动行协议办事的假 powershell.exe 与假 ping，
 *     测的是权限卡放行、进程表里找 ping、chat.cancel 之后它退出这整条链）；清理那步的明文 key 扫描用一次植入来证明它接上了；
 *     引擎中途被杀（一握手就 kill -9；shell-stop 里 ping 一起来就杀）时几秒内判完、不干等超时，每行都写明引擎退出了；
 *     用例进行中收到 SIGINT、SIGHUP、SIGTERM（清理途中再来一次 Ctrl+C 也一样）时照样停引擎、删临时目录，再以 128+信号号退出，
 *     打断之后不再开新的用例；停引擎前那次取进程表慢（Windows 上起 PowerShell 要一两秒，用小驱动把它放慢）时，在跑的用例
 *     也不再发新回合；shell-stop 里 ping 已经起来时按 Ctrl+C，引擎名下没跟着退的驱动与 ping 也一并结束；信号那条路等清理那一行
 *     真写出去再退（小驱动在「收到 SIG…」之后大量输出、测试这边停读一阵：POSIX 上 stdout 接管道是异步写，不等就丢掉排队的尾巴）。
 *     --memory-vault 让整条例不碰系统凭据库（与产品单测用 InMemoryVault 同一个理由）；凭据库那一半由第 1 层的假凭据库测。
 *  变异自检见各步提交正文（W3-smoke、W3-smokeb）：那里逐条列出的变异（脚本里的判定与接线，以及它守的产品链——
 *  W2a-3 回放签名、W2a-4 回放 reasoning_content、停止即中断 shell），除注明「Linux 上测不到」的以外，每一条都至少让本文件
 *  一例变红；没列出的改动不在这句话里。Linux 上测不到、只能在 Windows 真机跑 npm run smoke:release 验的：PowerShell 取进程表
 *  与 taskkill、真的系统凭据库、SIGBREAK 与关控制台窗口的 SIGHUP 投递（连同系统给的那几秒）。stdout 截尾只在 POSIX 管道上有
 *  （Windows 上 Node 把 stdout、stderr 的管道设成同步写），上面第 3 层那一例在 Linux 上测它。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket as WsPeer } from 'ws';
import { AnthropicProvider, BINDING_MODELS } from '../src/minisd/providers/anthropic';
import { OpenAIProvider, requiresReasoningContentEcho } from '../src/minisd/providers/openai';
import type { StreamRequest } from '../src/minisd/providers/types';
import { parseMinisdFatal } from '../src/main/minisd-fatal';
import { bridgePipePath } from '../src/minisd/bridge/server';
import type { AgentMessage, AgentStreamEvent, AgentToolDefinition } from '../src/shared/types';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(appRoot, 'scripts', 'smoke-release.mjs');

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface CaseResult { name: string; status: Status; detail: string }
interface ToolRecord { name: string; input: unknown; success: boolean; output: string }
interface TurnRecord { terminal: { kind: string; message?: string; stopReason?: string }; errors: string[]; tools: ToolRecord[] }
interface MockHit { path: string; model: string; action: string; status: number }
interface MockServer { url: string; hits: MockHit[]; close(): Promise<void> }
interface ProcEntry { pid: number; ppid: number; name: string; start?: string; state?: string }
interface KeyringEntry { getPassword(): string | null; setPassword(v: string): void; deletePassword(): boolean }
interface KeyringLike {
  Entry: new (service: string, account: string) => KeyringEntry;
  findCredentials?: (service: string) => Array<{ account: string; password: string }>;
}
type Vault = { kind: 'memory'; reason: string } | { kind: 'keyring'; service: string; keyring: KeyringLike };
interface ExitInfo { code: number | null; signal: string | null }
/** 清理收拾残留进程用的依赖（同 reapTree 的第二个参数），缺省是真的。 */
interface ProcDeps {
  snapshot?: () => Promise<ProcEntry[]>; isAlive?: (p: ProcEntry) => boolean; kill?: (pid: number) => void;
  graceMs?: number; deadlineMs?: number; intervalMs?: number;
}
/** cleanup 要的那部分 ctx（runSmoke 里的 ctx 的子集）。 */
interface CleanupCtx {
  platform: string; tempRoot: string; secrets: string[]; vault: Vault; accounts: Set<string>;
  engine: { child?: { pid?: number; kill(signal?: NodeJS.Signals): boolean; once(ev: 'exit', fn: () => void): unknown }; exit?: ExitInfo; booted: boolean; stopping: boolean };
  client?: { close(): void; closed?: boolean };
  procs?: ProcDeps;
}
interface FakeClient {
  closed: boolean;
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onNotify(fn: (method: string, params: unknown) => void): () => void;
}
interface Directive { kind: string; file?: string; content?: string; markdown?: string; command?: string }
/** 脚本导出的形状（.mjs 没有类型声明，动态导入时在这里补上；静态 import .mjs 会让 typecheck 报缺声明）。 */
interface SmokeModule {
  CASE_NAMES: string[];
  ANTHROPIC_MODELS: string[];
  DEEPSEEK_DEFAULT_MODEL: string;
  parseArgs(argv: string[]): { mock: boolean; memoryVault: boolean; only?: string[]; help: boolean };
  skipReason(name: string, ctx: {
    mock: boolean; env: Record<string, string | undefined>; platform: string;
    which: (cmd: string) => string | undefined; only?: string[];
  }): string | undefined;
  whichCommand(cmd: string, env: Record<string, string | undefined>, platform: string): string | undefined;
  keyringServiceName(pid: number): string;
  buildMinisdEnv(base: Record<string, string | undefined>, o: { dataRoot: string; logDir: string; keyringService?: string }): Record<string, string>;
  redactSecrets(text: string, secrets: Array<string | undefined>): string;
  parseHandshakeLine(line: string): { port: number; token: string } | undefined;
  parseFatalLine(line: string): unknown;
  formatResults(results: CaseResult[]): { lines: string[]; exitCode: number };
  smokePrompts(nonce: string): { file: string; fileMarker: string; memMarker: string; turns: string[] };
  shellStopPrompt(command: string): string;
  pingCommand(platform: string): string;
  parseDirective(text: string): Directive;
  assessToolSession(turns: TurnRecord[], exp: {
    file: string; fileMarker: string; memMarker: string; workspaceFileText?: string; memoryText: string;
  }): { ok: boolean; problems: string[]; notes: string[]; toolCount: number };
  permissionDecision(params: unknown, allow: Array<{ sessionId: string; kind: string; detail: string }>): 'allow-once' | 'deny';
  parseProcStat(text: string): ProcEntry | undefined;
  parseWin32Processes(json: string): ProcEntry[];
  findDescendants(table: ProcEntry[], rootPid: number): ProcEntry[];
  takeProcessSnapshot(platform?: string): Promise<ProcEntry[]>;
  reapPings(pings: ProcEntry[], deps: {
    deadlineMs: number; intervalMs?: number; isAlive: (p: ProcEntry) => boolean;
    snapshot: () => Promise<ProcEntry[]>; kill: (pid: number) => void;
  }): Promise<{ ok: boolean; killed: number[] }>;
  reapTree(tree: ProcEntry[], deps: {
    graceMs?: number; deadlineMs?: number; intervalMs?: number; isAlive: (p: ProcEntry) => boolean;
    snapshot: () => Promise<ProcEntry[]>; kill: (pid: number) => void;
  }): Promise<{ killed: ProcEntry[]; stuck: ProcEntry[]; unverified: ProcEntry[] }>;
  cleanupKeyring(keyring: KeyringLike, service: string, accounts: string[]): { deleted: string[]; leftovers: string[]; sweep: string };
  chooseVault(o: { memoryVault?: boolean; platform: string; service: string; loadKeyring?: () => KeyringLike }): Vault;
  cleanup(ctx: CleanupCtx): Promise<CaseResult>;
  cleanupSignals(platform: string): NodeJS.Signals[];
  engineCwd(hostPlatform: string, tempRoot: string): string | undefined;
  findSecretsInTree(dir: string, secrets: Array<string | undefined>, unreadable?: string[]): string[];
  mcpServerSource(expectedArgs: string[]): string;
  startMockAnthropic(o: { apiKey: string }): Promise<MockServer>;
  startMockOpenAI(o: { apiKey?: string; requireReasoningEcho?: boolean }): Promise<MockServer>;
  connectRpc(port: number, token: string): Promise<{
    call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
    refuse(reason: string): void;
    close(): void;
    readonly closed: boolean;
  }>;
  runTurn(ctx: {
    client: { call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>; onNotify(fn: (method: string, params: unknown) => void): () => void };
    turnTimeoutMs: number;
  }, sessionId: string, text: string, providerId: string): Promise<TurnRecord>;
  engineGone(ctx: { engine: { exit?: { code: number | null; signal: string | null } }; client?: { closed: boolean } }, when: string): Promise<string | undefined>;
  engineCrashed(ctx: {
    engine: { booted: boolean; stopping: boolean; exit?: { code: number | null; signal: string | null } }; client?: { closed: boolean };
  }): Promise<{ code: number | null; signal: string | null } | undefined>;
  runToolSession(ctx: {
    client: FakeClient; accounts: Set<string>; turnTimeoutMs: number; dataRoot: string;
    denied: Array<{ sessionId: string }>; say(line: string): void;
  }, label: string, providerParams: Record<string, unknown>): Promise<{ ok: boolean; summary: string }>;
  caseShellStop(ctx: unknown): Promise<{ status: string; detail: string }>;
  runSmoke(o: {
    mock: boolean; memoryVault: boolean; only?: string[]; platform?: string; env?: Record<string, string | undefined>;
    electronBin: string; minisdEntry?: string; print?: (line: string) => void; loadKeyring?: () => KeyringLike; procs?: ProcDeps;
  }): Promise<{ results: CaseResult[]; say: (line: string) => void; interrupted?: string }>;
}
const load = async (): Promise<SmokeModule> => (await import(pathToFileURL(SCRIPT).href)) as SmokeModule;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 让 readdirSync 读这几个目录时报错（错误码各自给）：测试以 root 跑时 chmod 000 挡不住读。脚本经 ESM 引入 node:fs，
 * 这里改 CommonJS 那份导出，再 syncBuiltinESMExports 让 ESM 那边也看到新函数；用例结束复原。
 * once：每个目录只报一次错——rmSync 内部也可能经同一个函数读目录，删临时目录时得放行。
 */
function failReaddir(failures: Record<string, string>, once = false): void {
  const fsCjs = createRequire(import.meta.url)('node:fs') as { readdirSync: (...a: unknown[]) => unknown };
  const orig = fsCjs.readdirSync;
  const pending = new Map(Object.entries(failures));
  fsCjs.readdirSync = function (this: unknown, ...a: unknown[]): unknown {
    const p = String(a[0]);
    const code = pending.get(p);
    if (code !== undefined) {
      if (once) pending.delete(p);
      throw Object.assign(new Error(`${code}: scandir '${p}'`), { code });
    }
    return orig.apply(this, a);
  };
  syncBuiltinESMExports();
  cleanups.push(() => { fsCjs.readdirSync = orig; syncBuiltinESMExports(); });
}

/** 剧本要用到的工具定义（形状同 registry 交给 provider 的 AgentToolDefinition；非空才不会被假端点当成取标题请求）。 */
const TOOLS: AgentToolDefinition[] = [
  { name: 'file_write', description: '写文件', parameters: { path: { type: 'string', description: '路径' }, content: { type: 'string', description: '内容' }, tool_title: { type: 'string', description: '标题' } }, required: ['path', 'content', 'tool_title'] },
  { name: 'file_read', description: '读文件', parameters: { path: { type: 'string', description: '路径' }, tool_title: { type: 'string', description: '标题' } }, required: ['path', 'tool_title'] },
  { name: 'memory_write', description: '记忆', parameters: { markdown: { type: 'string', description: '内容' }, tool_title: { type: 'string', description: '标题' } }, required: ['markdown', 'tool_title'] },
  { name: 'shell_execute', description: '命令', parameters: { command: { type: 'string', description: '命令' }, tool_title: { type: 'string', description: '标题' } }, required: ['command', 'tool_title'] },
];

type ToolCall = Extract<AgentStreamEvent, { kind: 'toolCallComplete' }>;
type Thinking = Extract<AgentStreamEvent, { kind: 'thinkingComplete' }>;
async function collect(stream: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}
const callsOf = (ev: AgentStreamEvent[]): ToolCall[] => ev.filter((e): e is ToolCall => e.kind === 'toolCallComplete');
const textOf = (ev: AgentStreamEvent[]): string => ev.map(e => (e.kind === 'textDelta' ? e.text : '')).join('');
const reasoningOf = (ev: AgentStreamEvent[]): string => ev.map(e => (e.kind === 'thinkingDelta' ? e.text : '')).join('');
const lastOf = (ev: AgentStreamEvent[]): AgentStreamEvent | undefined => ev[ev.length - 1];

describe('smoke-release：参数与跳过判定', () => {
  it('parseArgs 认 --mock、--memory-vault、--only（两种写法）、--help，别的一律报参数错误', async () => {
    const m = await load();
    expect(m.parseArgs([])).toEqual({ mock: false, memoryVault: false, only: undefined, help: false });
    expect(m.parseArgs(['--mock', '--memory-vault'])).toMatchObject({ mock: true, memoryVault: true, help: false });
    expect(m.parseArgs(['--only', 'anthropic,shell-stop']).only).toEqual(['anthropic', 'shell-stop']);
    expect(m.parseArgs(['--only=mcp-spaces']).only).toEqual(['mcp-spaces']);
    expect(m.parseArgs(['-h']).help).toBe(true);
    expect(m.parseArgs(['--help']).help).toBe(true);
    expect(() => m.parseArgs(['--bogus'])).toThrow(/不认识的参数 --bogus/);
    expect(() => m.parseArgs(['--only'])).toThrow(/--only 后面缺值/);
    expect(() => m.parseArgs(['--only', 'anthropic,nope'])).toThrow(/nope/);
    expect(m.CASE_NAMES).toEqual(['anthropic', 'deepseek', 'mcp-spaces', 'shell-stop']);
  });

  it('命令行：参数错误退 2 并说原因，--help 退 0（都不需要先构建）', () => {
    const bad = spawnSync(process.execPath, [SCRIPT, '--bogus'], { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 });
    expect(bad.status).toBe(2);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/不认识的参数 --bogus/);
    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/--mock/);
    expect(help.stdout).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('parseArgs 组合选项：都写在同一个 -- 后面照认；npm 原样转交的第二个起的 --（每个选项前各写一个 --）也照认', async () => {
    const m = await load();
    expect(m.parseArgs(['--mock', '--memory-vault', '--only', 'deepseek,mcp-spaces']))
      .toEqual({ mock: true, memoryVault: true, only: ['deepseek', 'mcp-spaces'], help: false });
    // npm 10 实测：npm run x -- --mock -- --memory-vault 交给脚本的 argv 是 ["--mock","--","--memory-vault"]
    expect(m.parseArgs(['--mock', '--', '--memory-vault', '--', '--only', 'anthropic']))
      .toEqual({ mock: true, memoryVault: true, only: ['anthropic'], help: false });
    expect(() => m.parseArgs(['--only', '--', 'anthropic'])).toThrow(/--only 后面缺值/);
  });

  it('照抄 --help 里 npm 那一行、把选项全写上，脚本照单全收：那一行只写一个 --（npm 只吃掉第一个，后面的原样转交）', () => {
    const run = (args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 });
    const help = String(run(['--help']).stdout);
    const npmLine = help.split(/\r?\n/).find(l => l.includes('npm run smoke:release'));
    expect(npmLine, help).toBeDefined();
    // 可选项都当写了，占位符换成真用例名；再照 npm 的规矩切：第一个 -- 之前归 npm，之后的原样交给脚本
    const words = npmLine!.slice(npmLine!.indexOf('npm run smoke:release') + 'npm run smoke:release'.length)
      .replace(/[[\]]/g, ' ').replace(/<[^>]*>/g, 'anthropic,mcp-spaces').trim().split(/\s+/);
    const first = words.indexOf('--');
    expect(first, npmLine).toBeGreaterThanOrEqual(0);
    const argv = words.slice(first + 1);
    expect(argv.filter(w => w === '--'), `${npmLine}：选项要都写在同一个 -- 后面`).toEqual([]);
    const r = run([...argv, '--help']);
    expect(r.status, `${argv.join(' ')}\n${String(r.stderr)}`).toBe(0);
  });

  it('skipReason：缺 key 的模型用例在真 key 模式下标「跳过（缺 XXX）」，--mock 不跳；shell-stop 看本机有没有 powershell.exe 与 ping', async () => {
    const m = await load();
    const none = (): string | undefined => undefined;
    const ctx = { mock: false, env: {} as Record<string, string | undefined>, platform: 'linux', which: none };
    expect(m.skipReason('anthropic', ctx)).toBe('跳过（缺 ANTHROPIC_API_KEY）');
    expect(m.skipReason('deepseek', ctx)).toBe('跳过（缺 DEEPSEEK_API_KEY）');
    expect(m.skipReason('anthropic', { ...ctx, env: { ANTHROPIC_API_KEY: '   ' } })).toBe('跳过（缺 ANTHROPIC_API_KEY）');
    expect(m.skipReason('anthropic', { ...ctx, env: { ANTHROPIC_API_KEY: 'sk-ant-something' } })).toBeUndefined();
    expect(m.skipReason('deepseek', { ...ctx, env: { DEEPSEEK_API_KEY: 'sk-something' } })).toBeUndefined();
    expect(m.skipReason('anthropic', { ...ctx, mock: true })).toBeUndefined();
    expect(m.skipReason('deepseek', { ...ctx, mock: true })).toBeUndefined();
    expect(m.skipReason('mcp-spaces', ctx)).toBeUndefined();
    // 非 Windows：tools/shell.ts 也起 powershell.exe（裸名），本机没有就测不了
    expect(m.skipReason('shell-stop', ctx)).toMatch(/^跳过（.*powershell\.exe/);
    expect(m.skipReason('shell-stop', { ...ctx, which: (c: string) => (c === 'powershell.exe' ? '/x/powershell.exe' : undefined) })).toMatch(/^跳过（.*ping/);
    expect(m.skipReason('shell-stop', { ...ctx, which: (c: string) => `/x/${c}` })).toBeUndefined();
    // Windows：System32 下两样都在，产品也按绝对路径起
    expect(m.skipReason('shell-stop', { ...ctx, platform: 'win32' })).toBeUndefined();
    expect(m.skipReason('anthropic', { ...ctx, mock: true, only: ['deepseek'] })).toBe('跳过（--only 未选）');
    expect(m.skipReason('deepseek', { ...ctx, mock: true, only: ['deepseek'] })).toBeUndefined();
  });

  it('whichCommand 按 PATH 找可执行文件（PATH 分隔符随本机平台）', async () => {
    const m = await load();
    const dir = tempDir('dm-smoke-which-');
    const exe = join(dir, 'powershell.exe');
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    expect(m.whichCommand('powershell.exe', { PATH: dir }, process.platform)).toBe(exe);
    expect(m.whichCommand('ping', { PATH: dir }, process.platform)).toBeUndefined();
    expect(m.whichCommand('powershell.exe', {}, process.platform)).toBeUndefined();
  });
});

describe('smoke-release：隔离与脱敏', () => {
  it('keyring 服务名是 DeskMinis-smoke-<pid>', async () => {
    const m = await load();
    expect(m.keyringServiceName(4242)).toBe('DeskMinis-smoke-4242');
  });

  it('buildMinisdEnv：剥掉 key、外层的 DESKMINIS_*（不分大小写）与 MINISD_HOST，再写临时数据根、日志目录与凭据库选择', async () => {
    const m = await load();
    const base = {
      PATH: '/usr/bin', HOME: '/home/u',
      ANTHROPIC_API_KEY: 'sk-ant-real', DEEPSEEK_API_KEY: 'sk-real',
      DESKMINIS_DATA_DIR: '/real/root', DESKMINIS_KEYRING_SERVICE: 'DeskMinis', DESKMINIS_TEST: '1',
      deskminis_fake_provider: '1', MINISD_HOST: '0.0.0.0',
    };
    const keyring = m.buildMinisdEnv(base, { dataRoot: '/tmp/smoke/data', logDir: '/tmp/smoke/logs', keyringService: 'DeskMinis-smoke-7' });
    expect(keyring).toEqual({
      PATH: '/usr/bin', HOME: '/home/u',
      ELECTRON_RUN_AS_NODE: '1', DESKMINIS_STANDALONE: '1',
      DESKMINIS_DATA_DIR: '/tmp/smoke/data', DESKMINIS_LOG_DIR: '/tmp/smoke/logs',
      DESKMINIS_KEYRING_SERVICE: 'DeskMinis-smoke-7',
    });
    const memory = m.buildMinisdEnv(base, { dataRoot: '/tmp/smoke/data', logDir: '/tmp/smoke/logs' });
    expect(memory.DESKMINIS_TEST).toBe('1');
    expect(memory).not.toHaveProperty('DESKMINIS_KEYRING_SERVICE');
    expect(memory).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(memory.DESKMINIS_DATA_DIR).toBe('/tmp/smoke/data');
  });

  it('buildMinisdEnv：交给引擎的凭据库服务名不是 DeskMinis-smoke-<进程号> 就拒绝——正式版、开发态的不行，空白也不行（引擎读到空白回落正式版的 DeskMinis）', async () => {
    const m = await load();
    for (const svc of ['DeskMinis', 'DeskMinis-dev', ' ', 'DeskMinis-smoke-']) {
      expect(() => m.buildMinisdEnv({ PATH: '/usr/bin' }, { dataRoot: '/d', logDir: '/l', keyringService: svc }), JSON.stringify(svc))
        .toThrow(/不是冒烟专用的 DeskMinis-smoke-<进程号>/);
    }
  });

  it('redactSecrets 把每个 key 的每次出现都换掉，空的与过短的不当 key', async () => {
    const m = await load();
    const k = 'sk-ant-abcdefgh12345';
    expect(m.redactSecrets(`a ${k} b ${k}`, [k, undefined, '', 'abc'])).toBe('a [已隐藏] b [已隐藏]');
    expect(m.redactSecrets('abc 不动', ['abc'])).toBe('abc 不动');
    expect(m.redactSecrets('无 key', [])).toBe('无 key');
  });

  it('findSecretsInTree 在临时根里逐文件找明文 key（含二进制与子目录），返回相对路径', async () => {
    const m = await load();
    const dir = tempDir('dm-smoke-scan-');
    const k = 'sk-smoke-scan-0123456789';
    mkdirSync(join(dir, 'data', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'data', 'providers.json'), '{"providers":[]}');
    writeFileSync(join(dir, 'data', 'sub', 'minis.db'), Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(k), Buffer.from([0])]));
    writeFileSync(join(dir, 'clean.log'), 'nothing here');
    expect(m.findSecretsInTree(dir, [k, undefined]).map(p => p.replace(/\\/g, '/'))).toEqual(['data/sub/minis.db']);
    expect(m.findSecretsInTree(dir, ['short'])).toEqual([]);
  });

  it('findSecretsInTree：子目录读不了不抛错，记进 unreadable 交给清理报出来；扫的途中没了的目录跳过；别处照扫', async () => {
    const m = await load();
    const dir = tempDir('dm-smoke-scan-');
    const k = 'sk-smoke-scan-0123456789';
    for (const d of ['locked', 'gone', 'ok']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'ok', 'leak.txt'), k);
    failReaddir({ [join(dir, 'locked')]: 'EACCES', [join(dir, 'gone')]: 'ENOENT' });
    const unreadable: string[] = [];
    expect(m.findSecretsInTree(dir, [k], unreadable).map(p => p.replace(/\\/g, '/'))).toEqual(['ok/leak.txt']);
    expect(unreadable.map(p => p.replace(/\\/g, '/'))).toEqual(['locked']);
  });

  it('cleanupKeyring：删掉已知条目与枚举到的条目、核对无残留，别的服务名一条不碰', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-7';
    const fake = fakeKeyring({
      [`${svc}\u0000pairing.static-identity`]: 'id',
      [`${svc}\u0000provider:AAA`]: 'k1',
      [`${svc}\u0000provider:ZZZ`]: 'k2', // 脚本不知道、只有枚举才找得到的
      ['DeskMinis\u0000provider:REAL']: 'real-user-key',
    });
    const r = m.cleanupKeyring(fake, svc, ['pairing.static-identity', 'provider:AAA']);
    expect(r.leftovers).toEqual([]);
    expect(r.sweep).toBe('ok');
    expect([...r.deleted].sort()).toEqual(['pairing.static-identity', 'provider:AAA', 'provider:ZZZ']);
    expect([...fake.store.keys()]).toEqual(['DeskMinis\u0000provider:REAL']);
  });

  it('cleanupKeyring：枚举不可用时只删已知条目；删不掉的记为残留', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-8';
    const noFind = fakeKeyring({ [`${svc}\u0000provider:AAA`]: 'k1' }, { findThrows: true });
    const r1 = m.cleanupKeyring(noFind, svc, ['provider:AAA', 'pairing.static-identity']);
    expect(r1).toMatchObject({ sweep: 'unsupported', leftovers: [] });
    expect(noFind.store.size).toBe(0);
    const stuck = fakeKeyring({ [`${svc}\u0000provider:AAA`]: 'k1' }, { deleteFails: ['provider:AAA'] });
    expect(m.cleanupKeyring(stuck, svc, ['provider:AAA']).leftovers).toEqual(['provider:AAA']);
  });

  it('cleanupKeyring：服务名不是 DeskMinis-smoke-<进程号>（接错成正式版的 DeskMinis、开发态的 DeskMinis-dev）就抛错，一条也不删、连枚举都不做', async () => {
    const m = await load();
    for (const svc of ['DeskMinis', 'DeskMinis-dev', 'DeskMinis-smoke-', '']) {
      const log: KeyringOp[] = [];
      const fake = fakeKeyring(userVault(), { log });
      expect(() => m.cleanupKeyring(fake, svc, ['pairing.static-identity', 'provider:AAA']), JSON.stringify(svc))
        .toThrow(/不是冒烟专用的 DeskMinis-smoke-<进程号>，一条也没删/);
      expect(Object.fromEntries(fake.store), JSON.stringify(svc)).toEqual(userVault());
      expect(log, JSON.stringify(svc)).toEqual([]);
    }
  });

  it('cleanupSignals：Ctrl+C、SIGTERM、关终端或控制台窗口（SIGHUP）都先清理再退；Windows 上再加 Ctrl+Break（SIGBREAK）', async () => {
    const m = await load();
    // Windows 关控制台窗口时 node 收到的是 SIGHUP、Ctrl+Break 是 SIGBREAK：漏挂哪个，凭据库里本次写的条目与临时目录就一条都不删。
    // 整条 --mock 里的信号例在 Windows 上测不到处理器（child.kill 一律是 TerminateProcess），Windows 那一份清单只能在这里核对
    const sorted = (a: string[]): string[] => [...a].sort();
    expect(sorted(m.cleanupSignals('win32'))).toEqual(['SIGBREAK', 'SIGHUP', 'SIGINT', 'SIGTERM']);
    // SIGBREAK 别处没人发，也没有这个信号号
    expect(sorted(m.cleanupSignals('linux'))).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
    expect(sorted(m.cleanupSignals('darwin'))).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
  });
});

/** 假凭据库上的一次操作（log 选项逐次记下）：op 为 get / set / delete / find，find 没有 account。 */
interface KeyringOp { op: string; service: string; account?: string }

/** 内存里的假凭据库：键为 服务名\0账户名。findThrows 模拟 Linux 无 Secret Service 时枚举抛错；
 *  deleteFails / getFails 里的账户删除或读取时抛错（像凭据库半路出毛病）；log 给了就逐次记下读、写、删、枚举落在哪个服务名下。 */
function fakeKeyring(initial: Record<string, string>, opts: { findThrows?: boolean; deleteFails?: string[]; getFails?: string[]; log?: KeyringOp[] } = {}): KeyringLike & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  const key = (s: string, a: string): string => `${s}\u0000${a}`;
  class Entry implements KeyringEntry {
    constructor(private readonly s: string, private readonly a: string) {}
    getPassword(): string | null {
      opts.log?.push({ op: 'get', service: this.s, account: this.a });
      if (opts.getFails?.includes(this.a)) throw new Error('Couldn\'t access platform storage: AccessDenied');
      return store.get(key(this.s, this.a)) ?? null;
    }
    setPassword(v: string): void { opts.log?.push({ op: 'set', service: this.s, account: this.a }); store.set(key(this.s, this.a), v); }
    deletePassword(): boolean {
      opts.log?.push({ op: 'delete', service: this.s, account: this.a });
      if (opts.deleteFails?.includes(this.a)) throw new Error('Couldn\'t access platform storage');
      return store.delete(key(this.s, this.a));
    }
  }
  const findCredentials = (s: string): Array<{ account: string; password: string }> => {
    opts.log?.push({ op: 'find', service: s });
    if (opts.findThrows) throw new Error('no secret service provider or dbus session found');
    return [...store].filter(([k]) => k.startsWith(`${s}\u0000`)).map(([k, v]) => ({ account: k.slice(s.length + 1), password: v }));
  };
  return { Entry, findCredentials, store };
}

/** 用户真实的凭据：正式版 DeskMinis 与开发态 DeskMinis-dev 下各几条。服务名一旦接错成这两个，清理按服务名枚举就会把它们删光。
 *  provider:AAA 与冒烟服务名下的同名：连「按已知清单删」那条路也得挡住。 */
const userVault = (): Record<string, string> => ({
  ['DeskMinis\u0000pairing.static-identity']: 'real-device-identity',
  ['DeskMinis\u0000provider:AAA']: 'sk-ant-user-real-key-0123456789',
  ['DeskMinis\u0000provider:REAL2']: 'sk-user-real-key-9876543210',
  ['DeskMinis-dev\u0000pairing.static-identity']: 'dev-device-identity',
  ['DeskMinis-dev\u0000provider:DEV']: 'sk-dev-user-key-0123456789',
});

describe('smoke-release：清理与选凭据库（Windows 真跑时唯一要删的是凭据库里本次写的条目，这一半用假凭据库测）', () => {
  /** 引擎没起来过的 ctx：清理只剩凭据库、明文 key 扫描与删临时目录。 */
  function cleanupCtx(o: { tempRoot: string; vault: Vault; accounts?: string[]; secrets?: string[] }): CleanupCtx {
    return {
      platform: process.platform, tempRoot: o.tempRoot, secrets: o.secrets ?? [], vault: o.vault,
      accounts: new Set(o.accounts ?? ['pairing.static-identity']),
      engine: { booted: false, stopping: false }, client: undefined,
    };
  }
  /** 冒烟服务名下两条（设备身份、用户的真 key），正式版 DeskMinis 下一条（绝不能碰）。 */
  const seeded = (svc: string): Record<string, string> => ({
    [`${svc}\u0000pairing.static-identity`]: 'id',
    [`${svc}\u0000provider:AAA`]: 'sk-user-real-key-0123456789',
    ['DeskMinis\u0000provider:REAL']: 'real-user-key',
  });

  it('cleanup：删掉冒烟服务名下本次写进去的凭据，正式版 DeskMinis 下的一条不碰；清理行写明凭据库已清空，临时目录也删了', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-4242';
    const fake = fakeKeyring(seeded(svc));
    const root = tempDir('dm-smoke-cleanup-');
    const r = await m.cleanup(cleanupCtx({ tempRoot: root, vault: { kind: 'keyring', keyring: fake, service: svc }, accounts: ['pairing.static-identity', 'provider:AAA'] }));
    expect(r, r.detail).toMatchObject({ name: '清理', status: 'PASS' });
    expect(r.detail).toContain(`凭据库 ${svc} 已清空（删 2 条）`);
    expect([...fake.store.keys()]).toEqual(['DeskMinis\u0000provider:REAL']);
    expect(existsSync(root), '临时目录没删').toBe(false);
  });

  it('cleanup：凭据库里有删不掉的条目就判 FAIL「还剩 N 条」并点名，临时目录照删', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-4243';
    const fake = fakeKeyring(seeded(svc), { deleteFails: ['provider:AAA'] });
    const root = tempDir('dm-smoke-cleanup-');
    const r = await m.cleanup(cleanupCtx({ tempRoot: root, vault: { kind: 'keyring', keyring: fake, service: svc }, accounts: ['pairing.static-identity', 'provider:AAA'] }));
    expect(r.status, r.detail).toBe('FAIL');
    expect(r.detail).toMatch(new RegExp(`凭据库 ${svc} 还剩 1 条（provider:AAA）`));
    expect(fake.store.has(`${svc}\u0000pairing.static-identity`)).toBe(false);
    expect(fake.store.has('DeskMinis\u0000provider:REAL')).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('cleanup：临时目录里有读不了的目录，判 FAIL「读不了、没扫到」、不说「没有明文 key」，临时目录照删', async () => {
    const m = await load();
    const root = tempDir('dm-smoke-cleanup-');
    const locked = join(root, 'data', 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(root, 'data', 'providers.json'), '{"providers":[]}');
    failReaddir({ [locked]: 'EACCES' }, true);
    const r = await m.cleanup(cleanupCtx({ tempRoot: root, vault: { kind: 'memory', reason: '' }, secrets: ['sk-smoke-scan-0123456789'] }));
    expect(r.status, r.detail).toBe('FAIL');
    expect(r.detail).toMatch(/^临时目录里有 1 处读不了、没扫到：data[\\/]locked/);
    expect(r.detail).not.toContain('临时目录里没有明文 key');
    expect(r.detail).toContain('临时目录已删');
    expect(existsSync(root)).toBe(false);
  });

  it('cleanup：前面哪一步抛错，删凭据库与删临时目录也照做（try/finally），抛的错记进清理行判 FAIL', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-4244';
    const fake = fakeKeyring(seeded(svc));
    const root = tempDir('dm-smoke-cleanup-');
    const ctx = cleanupCtx({ tempRoot: root, vault: { kind: 'keyring', keyring: fake, service: svc }, accounts: ['pairing.static-identity', 'provider:AAA'] });
    ctx.client = { close: () => { throw new Error('连接对象坏了'); } };
    const r = await m.cleanup(ctx);
    expect(r.status, r.detail).toBe('FAIL');
    expect(r.detail).toContain('连接对象坏了');
    expect([...fake.store.keys()]).toEqual(['DeskMinis\u0000provider:REAL']);
    expect(existsSync(root)).toBe(false);
  });

  it('cleanup：引擎 kill 之后又强杀仍没有退出，判 FAIL「引擎停不下来（pid N）」，不写「引擎已停」；凭据库与临时目录照样清', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-4245';
    const fake = fakeKeyring(seeded(svc));
    const root = tempDir('dm-smoke-cleanup-');
    // 永远不发 exit 的假引擎；pid 取一个比 Linux 进程号上限还大的数，强杀那一下落空，碰不到任何真进程
    const signals: unknown[] = [];
    const child = Object.assign(new EventEmitter(), { pid: 2 ** 30, kill: (s?: NodeJS.Signals): boolean => { signals.push(s); return true; } });
    const ctx = cleanupCtx({ tempRoot: root, vault: { kind: 'keyring', keyring: fake, service: svc }, accounts: ['pairing.static-identity', 'provider:AAA'] });
    ctx.engine = { child, booted: true, stopping: false };
    vi.useFakeTimers();
    cleanups.push(() => { vi.useRealTimers(); });
    const pending = m.cleanup(ctx);
    // kill 后等 10 秒、强杀后再等 5 秒；Windows 上停引擎前取进程表还有自己的 10 秒时限。假时钟，推多少都不花真时间
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await pending;
    expect(signals.length, '没有先 kill 一次').toBeGreaterThan(0);
    expect(r.status, r.detail).toBe('FAIL');
    expect(r.detail).toMatch(/引擎停不下来（pid 1073741824）/);
    expect(r.detail).not.toContain('引擎已停');
    expect([...fake.store.keys()]).toEqual(['DeskMinis\u0000provider:REAL']);
    expect(existsSync(root)).toBe(false);
  });

  it('engineCwd：非 Windows 上引擎以临时根为 cwd（管道套接字随临时根删掉），Windows 上沿用脚本的 cwd、真机行为不变（W3-smokec）', async () => {
    const m = await load();
    expect(m.engineCwd('linux', '/tmp/dm-smoke-x')).toBe('/tmp/dm-smoke-x');
    expect(m.engineCwd('darwin', '/tmp/dm-smoke-x')).toBe('/tmp/dm-smoke-x');
    expect(m.engineCwd('win32', 'C:\\Temp\\dm-smoke-x')).toBeUndefined();
  });

  it('cleanup：引擎进程没拿到 pid（spawn 运行期报 EACCES 一类错，Node 只发 error 与 close、不发 exit）时按没起来处理：不取进程表、不空等，不报「停不下来」（W3-smokec）', async () => {
    const m = await load();
    const root = tempDir('dm-smoke-cleanup-');
    const signals: unknown[] = [];
    // 与真的一样：spawn 失败的 ChildProcess 没有 pid，也永远不会发 exit
    const child = Object.assign(new EventEmitter(), { pid: undefined, kill: (s?: NodeJS.Signals): boolean => { signals.push(s); return false; } });
    const ctx = cleanupCtx({ tempRoot: root, vault: { kind: 'memory', reason: '' } });
    ctx.engine = { child, booted: false, stopping: false };
    let snapshots = 0;
    ctx.procs = { ...QUICK, snapshot: async () => { snapshots += 1; return []; }, isAlive: () => false, kill: () => { throw new Error('不该杀'); } };
    vi.useFakeTimers();
    cleanups.push(() => { vi.useRealTimers(); });
    const pending = m.cleanup(ctx);
    // 改之前 stopEngine 在这里等满 10 + 5 秒（假时钟推过去不花真时间），最后判「停不下来（pid undefined）」
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await pending;
    expect(r.status, r.detail).toBe('PASS');
    expect(r.detail).not.toContain('停不下来');
    expect(r.detail, '压根没起来的引擎不该说「已停」').not.toContain('引擎已停');
    expect(snapshots, '没起来的引擎不该去取进程表（Windows 上每次要起一个 PowerShell）').toBe(0);
    expect(signals, '没有进程可停，不该 kill').toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it('cleanup：系统不支持按服务名枚举时，按已知清单（设备身份、建过的 provider）删，清理行写明只核对了已知条目', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-4246';
    const fake = fakeKeyring(seeded(svc), { findThrows: true });
    const root = tempDir('dm-smoke-cleanup-');
    const r = await m.cleanup(cleanupCtx({ tempRoot: root, vault: { kind: 'keyring', keyring: fake, service: svc }, accounts: ['pairing.static-identity', 'provider:AAA'] }));
    expect(r.status, r.detail).toBe('PASS');
    expect(r.detail).toContain(`凭据库 ${svc} 已清空（删 2 条；系统不支持按服务名枚举，只核对了已知条目）`);
    expect([...fake.store.keys()]).toEqual(['DeskMinis\u0000provider:REAL']);
  });

  // 清理收拾引擎名下残留进程的三处判 FAIL：真进程表上凑不出「结束不了」「核对不了身份」「停引擎前取不到进程表」，
  // 进程操作换成假的（照 chooseVault 注入 loadKeyring 的办法）。进程号都取比 Linux 进程号上限还大的数，万一落到真的强杀也碰不到任何进程
  const ENGINE_PID = 2 ** 30;
  const DRIVER: ProcEntry = { pid: ENGINE_PID + 1, ppid: ENGINE_PID, name: 'powershell.exe', start: '101' };
  const PING: ProcEntry = { pid: ENGINE_PID + 2, ppid: ENGINE_PID + 1, name: 'PING.EXE', start: '102' };
  const TABLE: ProcEntry[] = [{ pid: ENGINE_PID, ppid: 1, name: 'electron', start: '100' }, DRIVER, PING];
  const QUICK = { graceMs: 20, deadlineMs: 100, intervalMs: 5 };
  /** 起来了的假引擎：kill() 当场发 exit，像引擎收到 SIGTERM 当场退出（清理照常写「引擎已停」）。 */
  const liveEngine = (): CleanupCtx['engine'] => {
    const child = Object.assign(new EventEmitter(), { pid: ENGINE_PID, kill: (): boolean => { child.emit('exit'); return true; } });
    return { child, booted: true, stopping: false };
  };

  it('cleanup：引擎名下有进程结束了还在，判 FAIL「结束不了」并点名，请用户去任务管理器；结束掉的照样写明', async () => {
    const m = await load();
    const root = tempDir('dm-smoke-cleanup-');
    const alive = new Set([DRIVER.pid, PING.pid]);
    const killed: number[] = [];
    const ctx = cleanupCtx({ tempRoot: root, vault: { kind: 'memory', reason: '' } });
    ctx.engine = liveEngine();
    // 驱动一结束就没了，ping 怎么结束都还在
    ctx.procs = { ...QUICK, snapshot: async () => TABLE, isAlive: p => alive.has(p.pid), kill: (pid) => { killed.push(pid); if (pid === DRIVER.pid) alive.delete(pid); } };
    const r = await m.cleanup(ctx);
    expect(r.status, r.detail).toBe('FAIL');
    expect(r.detail).toMatch(new RegExp(`^引擎名下有 1 个进程结束不了（PING\\.EXE pid ${PING.pid}），请到任务管理器里结束`));
    expect(r.detail).toContain('引擎已停');
    expect(r.detail).toContain(`结束了引擎名下没随它退出的 1 个进程（powershell.exe pid ${DRIVER.pid}）`);
    expect([...killed].sort()).toEqual([DRIVER.pid, PING.pid]);
    expect(existsSync(root)).toBe(false);
  });

  it('cleanup：停完引擎再取进程表失败，核对不了身份就一个也不结束，判 FAIL 并请用户去看', async () => {
    const m = await load();
    const root = tempDir('dm-smoke-cleanup-');
    let snapshots = 0;
    const killed: number[] = [];
    const ctx = cleanupCtx({ tempRoot: root, vault: { kind: 'memory', reason: '' } });
    ctx.engine = liveEngine();
    // 停引擎前那次取得到（子树记下了驱动与 ping），停完核对身份那次取不到
    ctx.procs = {
      ...QUICK, isAlive: () => true, kill: (pid) => { killed.push(pid); },
      snapshot: async () => { if (++snapshots > 1) throw new Error('powershell 起不来'); return TABLE; },
    };
    const r = await m.cleanup(ctx);
    expect(r.status, r.detail).toBe('FAIL');
    expect(r.detail).toMatch(new RegExp(`^引擎名下还有 2 个进程在跑（powershell\\.exe pid ${DRIVER.pid}、PING\\.EXE pid ${PING.pid}），取不到进程表、核对不了身份，没有替你结束`));
    expect(killed, '核对不了身份就不该结束任何进程').toEqual([]);
    expect(snapshots).toBe(2);
    expect(r.detail).toContain('引擎已停');
    expect(existsSync(root)).toBe(false);
  });

  it('cleanup：停引擎前就取不到进程表，判 FAIL「停引擎前取不到进程表」；引擎照停、临时目录照删', async () => {
    const m = await load();
    const root = tempDir('dm-smoke-cleanup-');
    const ctx = cleanupCtx({ tempRoot: root, vault: { kind: 'memory', reason: '' } });
    ctx.engine = liveEngine();
    ctx.procs = { ...QUICK, snapshot: async () => { throw new Error('powershell 起不来'); }, isAlive: () => true, kill: () => { throw new Error('不该杀'); } };
    const r = await m.cleanup(ctx);
    expect(r.status, r.detail).toBe('FAIL');
    expect(r.detail).toMatch(/^停引擎前取不到进程表（powershell 起不来），没法核对它名下有没有留下进程，请到任务管理器里看一眼/);
    expect(r.detail).toContain('引擎已停');
    expect(existsSync(root)).toBe(false);
  });

  it('cleanup：凭据库先清——停引擎前那次取进程表还没返回（Windows 上起 PowerShell 慢，关控制台窗口后系统只给几秒），用户的 key 就已删掉；停完引擎再清一遍，兜住在途的写入', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-4247';
    const fake = fakeKeyring(seeded(svc));
    const root = tempDir('dm-smoke-cleanup-');
    const ctx = cleanupCtx({ tempRoot: root, vault: { kind: 'keyring', keyring: fake, service: svc }, accounts: ['pairing.static-identity', 'provider:AAA'] });
    ctx.engine = liveEngine();
    // 停引擎前那次取进程表挂住（像 PowerShell 冷启动、WMI 忙），测试看过凭据库再放行
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    let atSnapshot: string[] | undefined;
    ctx.procs = {
      ...QUICK, isAlive: () => false, kill: () => { throw new Error('不该杀'); },
      snapshot: async () => {
        if (atSnapshot === undefined) { atSnapshot = [...fake.store.keys()]; await gate; }
        return TABLE;
      },
    };
    const pending = m.cleanup(ctx);
    for (let i = 0; atSnapshot === undefined && i < 300; i++) await new Promise(res => setTimeout(res, 10));
    expect(atSnapshot, '停引擎前没有取进程表').toBeDefined();
    expect(atSnapshot, '凭据库排在了取进程表之后：取表一慢，系统强杀时用户的 key 还在').toEqual(['DeskMinis\u0000provider:REAL']);
    // 取表挂着的这段时间里引擎还活着，一次在途的写入落了盘（刚建好的 provider，脚本还不知道它的 id）：停完引擎那一遍按服务名枚举删掉它
    fake.store.set(`${svc}\u0000provider:LATE`, 'sk-user-real-key-late-0123456789');
    release();
    const r = await pending;
    expect(r.status, r.detail).toBe('PASS');
    expect(r.detail).toContain(`凭据库 ${svc} 已清空（删 3 条）`);
    expect([...fake.store.keys()]).toEqual(['DeskMinis\u0000provider:REAL']);
    expect(existsSync(root)).toBe(false);
  });

  it('cleanup：引擎名下的进程在缺省的宽限里自己退了（读到 stdin 结束的 MCP 服务器），不替它结束、不再取一次进程表、不算进「结束了几个」', async () => {
    // 宽限用缺省值（不注入 graceMs）：Windows 上每取一次进程表要起一次 PowerShell（一两秒），停完引擎还在的都去核对、结束，
    // 清理就平白慢了，清理行也把本来就会退的进程算成「结束了」
    const m = await load();
    const root = tempDir('dm-smoke-cleanup-');
    const ctx = cleanupCtx({ tempRoot: root, vault: { kind: 'memory', reason: '' } });
    const MCP: ProcEntry = { pid: ENGINE_PID + 3, ppid: ENGINE_PID, name: 'node', start: '103' };
    let stoppedAt = 0;
    const child = Object.assign(new EventEmitter(), { pid: ENGINE_PID, kill: (): boolean => { stoppedAt = Date.now(); child.emit('exit'); return true; } });
    ctx.engine = { child, booted: true, stopping: false };
    let snapshots = 0;
    ctx.procs = {
      snapshot: async () => { snapshots++; return [TABLE[0], MCP]; },
      // 停引擎之后 0.15 秒才退，比缺省的宽限短得多
      isAlive: () => stoppedAt === 0 || Date.now() - stoppedAt < 150,
      kill: () => { throw new Error('不该结束'); },
    };
    const r = await m.cleanup(ctx);
    expect(r.status, r.detail).toBe('PASS');
    expect(r.detail).not.toContain('结束了引擎名下');
    expect(snapshots, '停完引擎又取了一次进程表：没等宽限').toBe(1);
    expect(existsSync(root)).toBe(false);
  });

  for (const svc of ['DeskMinis', 'DeskMinis-dev']) {
    it(`cleanup：凭据库服务名接错成 ${svc}（${svc === 'DeskMinis' ? '正式版' : '开发态'}）时一条也不删，判 FAIL 并写明；临时目录照删`, async () => {
      const m = await load();
      const fake = fakeKeyring(userVault());
      const root = tempDir('dm-smoke-cleanup-');
      const r = await m.cleanup(cleanupCtx({ tempRoot: root, vault: { kind: 'keyring', keyring: fake, service: svc }, accounts: ['pairing.static-identity', 'provider:AAA'] }));
      expect(r.status, r.detail).toBe('FAIL');
      expect(r.detail).toMatch(new RegExp(`^清凭据库时出错：服务名 ${svc} 不是冒烟专用的 DeskMinis-smoke-<进程号>，一条也没删`));
      expect(r.detail, '同一个原因只报一次').not.toMatch(/一条也没删[^]*一条也没删/);
      expect(Object.fromEntries(fake.store), '用户真实的凭据被动了').toEqual(userVault());
      expect(existsSync(root)).toBe(false);
    });
  }

  it('chooseVault：Windows 上加载得到、写读删探一次都通就用系统凭据库，探针不留下；只调一次加载器', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-7';
    const fake = fakeKeyring({});
    const loadKeyring = vi.fn(() => fake);
    const v = m.chooseVault({ platform: 'win32', service: svc, loadKeyring });
    expect(v).toMatchObject({ kind: 'keyring', service: svc });
    expect(v.kind === 'keyring' && v.keyring).toBe(fake);
    expect(loadKeyring).toHaveBeenCalledTimes(1);
    expect([...fake.store.keys()], '探针条目留下了').toEqual([]);
  });

  it('chooseVault：加载 @napi-rs/keyring 抛错时退回内存凭据库并写明原因', async () => {
    const m = await load();
    const v = m.chooseVault({ platform: 'win32', service: 'DeskMinis-smoke-7', loadKeyring: () => { throw new Error('Cannot find module keyring.win32-x64-msvc.node\n  at require'); } });
    expect(v.kind).toBe('memory');
    expect(v.kind === 'memory' && v.reason).toBe('（加载 @napi-rs/keyring 失败：Cannot find module keyring.win32-x64-msvc.node）');
  });

  it('chooseVault：非 Windows 与 --memory-vault 一律用内存凭据库，连加载器都不调（Linux 的 Secret Service 在容器里写不进）', async () => {
    const m = await load();
    const loadKeyring = vi.fn(() => fakeKeyring({}));
    expect(m.chooseVault({ platform: 'linux', service: 'DeskMinis-smoke-7', loadKeyring })).toMatchObject({ kind: 'memory', reason: expect.stringContaining('linux 上不用系统凭据库') });
    expect(m.chooseVault({ platform: 'darwin', service: 'DeskMinis-smoke-7', loadKeyring }).kind).toBe('memory');
    expect(m.chooseVault({ memoryVault: true, platform: 'win32', service: 'DeskMinis-smoke-7', loadKeyring })).toEqual({ kind: 'memory', reason: '（--memory-vault）' });
    expect(loadKeyring).not.toHaveBeenCalled();
  });

  it('chooseVault：探针写进去之后读回出错，退回内存凭据库，探针照样删掉（删在 finally 里）', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-7';
    const fake = fakeKeyring({}, { getFails: ['__smoke_probe__'] });
    const v = m.chooseVault({ platform: 'win32', service: svc, loadKeyring: () => fake });
    expect(v.kind).toBe('memory');
    expect(v.kind === 'memory' && v.reason).toMatch(/^（系统凭据库不可用：Couldn't access platform storage: AccessDenied/);
    expect([...fake.store.keys()], '读回出错时探针留在了凭据库里').toEqual([]);
  });

  it('chooseVault：探针删不掉就不用系统凭据库（清理时也删不掉用户的 key），原因里点名留下的探针条目', async () => {
    const m = await load();
    const svc = 'DeskMinis-smoke-7';
    const fake = fakeKeyring({}, { deleteFails: ['__smoke_probe__'] });
    const v = m.chooseVault({ platform: 'win32', service: svc, loadKeyring: () => fake });
    expect(v.kind).toBe('memory');
    expect(v.kind === 'memory' && v.reason).toMatch(new RegExp(`__smoke_probe__.*${svc}`));
  });

  it('chooseVault：服务名不是 DeskMinis-smoke-<进程号>（接错成正式版或开发态的）就不碰系统凭据库——不加载、不写探针，退回内存凭据库并写明原因', async () => {
    const m = await load();
    for (const svc of ['DeskMinis', 'DeskMinis-dev']) {
      const log: KeyringOp[] = [];
      const fake = fakeKeyring(userVault(), { log });
      const loadKeyring = vi.fn(() => fake);
      const v = m.chooseVault({ platform: 'win32', service: svc, loadKeyring });
      expect(v.kind, svc).toBe('memory');
      expect(v.kind === 'memory' && v.reason, svc).toMatch(new RegExp(`服务名 ${svc} 不是冒烟专用的 DeskMinis-smoke-<进程号>`));
      expect(loadKeyring, svc).not.toHaveBeenCalled();
      expect(log, svc).toEqual([]);
      expect(Object.fromEntries(fake.store), svc).toEqual(userVault());
    }
  });

  it('runSmoke 的服务名接线（Windows 上）：选库的探针、交给引擎的 DESKMINIS_KEYRING_SERVICE、清理都落在 DeskMinis-smoke-<本进程号> 下，正式版与开发态的凭据一条不碰', async () => {
    // 进程内以 platform:'win32' 跑一遍，只选 mcp-spaces（不要 key）；引擎换成一个记下自己环境就退出的假引擎（用例因此判 FAIL，
    // 清理照常走）。Linux 上整条例一律走内存凭据库，这三处服务名接线别处都执行不到：接错成正式版的 DeskMinis，
    // Windows 上的清理就会按服务名枚举，把用户的全部凭据删光还报 PASS
    const m = await load();
    const svc = `DeskMinis-smoke-${process.pid}`;
    const log: KeyringOp[] = [];
    // 冒烟服务名下预先放一条设备身份（像引擎起动时写的），看清理删的是不是它
    const fake = fakeKeyring({ ...userVault(), [`${svc}\u0000pairing.static-identity`]: 'smoke-device-identity' }, { log });
    const dir = tempDir('dm-smoke-wiring-');
    const dump = join(dir, 'engine-env.json');
    const entry = join(dir, 'fake-minisd.mjs');
    writeFileSync(entry, [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.env.SMOKE_ENV_DUMP, JSON.stringify({ service: process.env.DESKMINIS_KEYRING_SERVICE ?? null, test: process.env.DESKMINIS_TEST ?? null }));',
      '',
    ].join('\n'));
    const lines: string[] = [];
    const { results } = await m.runSmoke({
      mock: false, memoryVault: false, only: ['mcp-spaces'], platform: 'win32',
      env: { ...process.env, SMOKE_ENV_DUMP: dump }, electronBin: process.execPath, minisdEntry: entry,
      print: (line) => { lines.push(line); }, loadKeyring: () => fake,
      // 假引擎退得比清理早，清理不该去取进程表、结束进程；万一去了也碰不到本机的进程表
      procs: { snapshot: async () => { throw new Error('不该取进程表'); }, isAlive: () => false, kill: () => { throw new Error('不该结束进程'); } },
    });
    const out = lines.join('\n');
    const root = /临时目录：(.+)$/m.exec(out)?.[1]?.trim();
    cleanups.push(() => { if (root) rmSync(root, { recursive: true, force: true }); });
    expect(out).toContain(`凭据库：系统凭据库，服务名 ${svc}（`);
    expect(existsSync(dump), `假引擎没起来：\n${out}`).toBe(true);
    expect(JSON.parse(readFileSync(dump, 'utf8')), '交给引擎的凭据库选择').toEqual({ service: svc, test: null });
    const clean = results.find(r => r.name === '清理');
    expect(clean?.status, clean?.detail).toBe('PASS');
    expect(clean?.detail).toContain(`凭据库 ${svc} 已清空（删 1 条）`);
    expect([...new Set(log.map(o => o.service))], '碰了冒烟服务名以外的凭据').toEqual([svc]);
    expect(log.filter(o => o.op === 'set').map(o => o.account), '除了选库的探针不该写任何条目').toEqual(['__smoke_probe__']);
    expect(Object.fromEntries(fake.store)).toEqual(userVault());
    expect(existsSync(root!), `临时目录没删：${root}`).toBe(false);
  });
});

describe('smoke-release：握手行、致命行、结果表', () => {
  it('parseHandshakeLine 与 main/index.ts 的 parseHandshake 同一套判定（同 ipc-contract 的向量）', async () => {
    const m = await load();
    expect(m.parseHandshakeLine(JSON.stringify({ minisdPort: 51234, authToken: 'D3F4-TOKEN-UUID' }))).toEqual({ port: 51234, token: 'D3F4-TOKEN-UUID' });
    expect(m.parseHandshakeLine(JSON.stringify({ minisdPort: 51234 }))).toBeUndefined();
    expect(m.parseHandshakeLine(JSON.stringify({ minisdPort: 51234, authToken: '' }))).toBeUndefined();
    expect(m.parseHandshakeLine(JSON.stringify({ authToken: 'X' }))).toBeUndefined();
    expect(m.parseHandshakeLine('[minisd] booting db...')).toBeUndefined();
    expect(m.parseHandshakeLine('not json at all')).toBeUndefined();
    expect(m.parseHandshakeLine('null')).toBeUndefined();
    const fatal = { code: 'DB_NEWER_THAN_APP', dbVersion: 12, appVersion: 11, dataRoot: 'C:\\x' };
    expect(m.parseHandshakeLine(JSON.stringify({ minisdFatal: fatal }))).toBeUndefined();
  });

  it('parseFatalLine 与主进程的 parseMinisdFatal 逐行一致', async () => {
    const m = await load();
    const lines = [
      JSON.stringify({ minisdFatal: { code: 'DB_NEWER_THAN_APP', dbVersion: 12, appVersion: 11, dataRoot: 'C:\\x' } }),
      JSON.stringify({ minisdFatal: { code: 'DATA_ROOT_LOCKED', pid: 42, dataRoot: '/d' } }),
      JSON.stringify({ minisdFatal: { code: 'DATA_ROOT_LOCKED', pid: 0, dataRoot: '/d' } }),
      JSON.stringify({ minisdFatal: { code: 'DATA_ROOT_LOCKED', pid: 42, dataRoot: '' } }),
      JSON.stringify({ minisdFatal: { code: 'DB_NEWER_THAN_APP', dbVersion: 1.5, appVersion: 11, dataRoot: '/d' } }),
      JSON.stringify({ minisdFatal: { code: 'SOMETHING_ELSE', dataRoot: '/d' } }),
      JSON.stringify({ minisdFatal: { code: 'DATA_ROOT_LOCKED', pid: 42, dataRoot: '/d', extra: 'x' } }),
      JSON.stringify({ minisdPort: 1, authToken: 't' }),
      'null', '[]', '42', 'not json',
    ];
    for (const line of lines) expect(m.parseFatalLine(line), line).toEqual(parseMinisdFatal(line));
  });

  it('formatResults：逐行 PASS/FAIL/SKIP 加汇总；有 FAIL 退 1，只有 PASS 与 SKIP 退 0', async () => {
    const m = await load();
    const ok = m.formatResults([
      { name: 'anthropic', status: 'PASS', detail: '两个模型都过' },
      { name: 'deepseek', status: 'SKIP', detail: '跳过（缺 DEEPSEEK_API_KEY）' },
    ]);
    expect(ok.exitCode).toBe(0);
    expect(ok.lines.some(l => /^PASS\s+anthropic\s+两个模型都过$/.test(l))).toBe(true);
    expect(ok.lines.some(l => /^SKIP\s+deepseek\s+跳过（缺 DEEPSEEK_API_KEY）$/.test(l))).toBe(true);
    expect(ok.lines.join('\n')).toMatch(/汇总：PASS 1 · FAIL 0 · SKIP 1/);
    const bad = m.formatResults([
      { name: 'mcp-spaces', status: 'FAIL', detail: '第一行\n第二行' },
      { name: '清理', status: 'PASS', detail: '干净' },
    ]);
    expect(bad.exitCode).toBe(1);
    expect(bad.lines.join('\n')).toMatch(/汇总：PASS 1 · FAIL 1 · SKIP 0/);
    // 多行说明的续行缩进对齐，不会被误读成一行新结论
    expect(bad.lines.filter(l => /^(PASS|FAIL|SKIP)\s/.test(l))).toHaveLength(2);
    expect(bad.lines.some(l => /^\s+第二行$/.test(l))).toBe(true);
  });
});

describe('smoke-release：剧本、判定与权限卡', () => {
  it('剧本提示与指令解析互为往返：假端点从提示里读出的正是脚本要核对的文件名与标记', async () => {
    const m = await load();
    const pr = m.smokePrompts('a1b2c3');
    expect(pr).toMatchObject({ file: 'smoke-a1b2c3.txt', fileMarker: 'SMOKE-A1B2C3-FILE', memMarker: 'SMOKE-A1B2C3-MEMORY' });
    expect(pr.turns).toHaveLength(3);
    expect(m.parseDirective(pr.turns[0])).toEqual({ kind: 'write-read', file: pr.file, content: pr.fileMarker });
    expect(m.parseDirective(pr.turns[1])).toEqual({ kind: 'memory', markdown: pr.memMarker });
    expect(m.parseDirective(pr.turns[2])).toEqual({ kind: 'text' });
    expect(m.pingCommand('win32')).toBe('ping -t 127.0.0.1');
    expect(m.pingCommand('linux')).toBe('ping 127.0.0.1');
    expect(m.parseDirective(m.shellStopPrompt('ping -t 127.0.0.1'))).toEqual({ kind: 'shell', command: 'ping -t 127.0.0.1' });
  });

  it('模型 ID 以代码里的规则为准：两个 Claude 在绑定模型表里（官方端点才发 drop_block），DeepSeek 缺省模型命中 V4 回放规则', async () => {
    const m = await load();
    expect(m.ANTHROPIC_MODELS).toEqual(['claude-fable-5-1', 'claude-opus-5-5']);
    for (const id of m.ANTHROPIC_MODELS) expect(BINDING_MODELS.has(id), id).toBe(true);
    expect(m.DEEPSEEK_DEFAULT_MODEL).toBe('deepseek-v4-flash');
    expect(requiresReasoningContentEcho(m.DEEPSEEK_DEFAULT_MODEL)).toBe(true);
  });

  it('assessToolSession：三轮都正常收尾、file_write 之后 file_read 读到标记、memory_write 成功、盘上两处都有标记才算过', async () => {
    const m = await load();
    const pr = m.smokePrompts('a1b2c3');
    const exp = { file: pr.file, fileMarker: pr.fileMarker, memMarker: pr.memMarker, workspaceFileText: `${pr.fileMarker}\n`, memoryText: `<!-- 2026-09-25 10:00:00 -->\n${pr.memMarker}\n` };
    const good = (): TurnRecord[] => [
      { terminal: { kind: 'turnEnd', stopReason: 'endTurn' }, errors: [], tools: [
        { name: 'file_write', input: { path: pr.file, content: pr.fileMarker, tool_title: '写文件' }, success: true, output: '已写入' },
        { name: 'file_read', input: JSON.stringify({ path: pr.file, tool_title: '读文件' }), success: true, output: `${pr.fileMarker}\n` },
      ] },
      { terminal: { kind: 'turnEnd', stopReason: 'endTurn' }, errors: [], tools: [
        { name: 'memory_write', input: { markdown: `冒烟标记 ${pr.memMarker}`, tool_title: '记一笔' }, success: true, output: '已写入 2026-09-25 日志' },
      ] },
      { terminal: { kind: 'turnEnd', stopReason: 'endTurn' }, errors: [], tools: [] },
    ];
    expect(m.assessToolSession(good(), exp)).toMatchObject({ ok: true, problems: [], toolCount: 3 });

    const errored = good();
    errored[1] = { terminal: { kind: 'error', message: 'Anthropic HTTP 400: bound to a different conversation' }, errors: ['Anthropic HTTP 400: bound to a different conversation'], tools: [] };
    const e = m.assessToolSession(errored, exp);
    expect(e.ok).toBe(false);
    expect(e.problems.join('\n')).toMatch(/第 2 轮/);
    expect(e.problems.join('\n')).toMatch(/bound to a different conversation/);

    // 先读后写：读失败，写之后没有再读——不算「file_write 再 file_read」
    const readFirst = good();
    readFirst[0].tools = [
      { name: 'file_read', input: { path: pr.file }, success: false, output: 'ENOENT' },
      { name: 'file_write', input: { path: pr.file, content: pr.fileMarker }, success: true, output: '已写入' },
    ];
    expect(m.assessToolSession(readFirst, exp).problems.join('\n')).toMatch(/file_read/);

    expect(m.assessToolSession(good(), { ...exp, memoryText: '' }).problems.join('\n')).toMatch(/记忆文件/);
    expect(m.assessToolSession(good(), { ...exp, workspaceFileText: undefined }).problems.join('\n')).toMatch(/工作区/);

    // 额外的失败调用只记一笔，不判失败（模型走了弯路不等于产品坏了）
    const detour = good();
    detour[0].tools.unshift({ name: 'file_list', input: {}, success: false, output: '目录不存在' });
    const d = m.assessToolSession(detour, exp);
    expect(d.ok).toBe(true);
    expect(d.notes.join('\n')).toMatch(/file_list/);
  });

  it('permissionDecision：只放行本用例预期的那一条（同会话、同类、同命令），其余一律拒绝', async () => {
    const m = await load();
    const allow = [{ sessionId: 'S1', kind: 'shell', detail: 'ping -t 127.0.0.1' }];
    const req = (r: Record<string, unknown>): unknown => ({ requestId: 'R1', req: { kind: 'shell', detail: 'ping -t 127.0.0.1', sessionId: 'S1', ...r }, meta: {} });
    expect(m.permissionDecision(req({}), allow)).toBe('allow-once');
    expect(m.permissionDecision(req({ detail: 'ping -t 127.0.0.1; Remove-Item C:\\x' }), allow)).toBe('deny');
    expect(m.permissionDecision(req({ sessionId: 'S2' }), allow)).toBe('deny');
    expect(m.permissionDecision(req({ kind: 'file-write' }), allow)).toBe('deny');
    expect(m.permissionDecision({}, allow)).toBe('deny');
    expect(m.permissionDecision(req({}), [])).toBe('deny');
  });
});

describe('smoke-release：进程表', () => {
  it('parseProcStat 认括号里带空格与括号的进程名，取父进程号、状态与启动时刻', async () => {
    const m = await load();
    const line = '1234 (my (odd) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000 50';
    expect(m.parseProcStat(line)).toEqual({ pid: 1234, ppid: 1, name: 'my (odd) proc', state: 'S', start: '98765' });
    expect(m.parseProcStat('garbage')).toBeUndefined();
  });

  it('parseWin32Processes 认 PowerShell 5.1 的单个对象与数组、/Date(毫秒)/ 与 ISO 时间', async () => {
    const m = await load();
    const one = '{"ProcessId":4,"ParentProcessId":0,"Name":"System","CreationDate":"\\/Date(1790000000000)\\/"}';
    expect(m.parseWin32Processes(one)).toEqual([{ pid: 4, ppid: 0, name: 'System', start: '1790000000000' }]);
    const many = JSON.stringify([
      { ProcessId: 100, ParentProcessId: 4, Name: 'powershell.exe', CreationDate: '2026-09-25T10:00:00.1234567+08:00' },
      { ProcessId: 200, ParentProcessId: 100, Name: 'PING.EXE', CreationDate: null },
    ]);
    expect(m.parseWin32Processes(many)).toEqual([
      { pid: 100, ppid: 4, name: 'powershell.exe', start: '2026-09-25T10:00:00.1234567+08:00' },
      { pid: 200, ppid: 100, name: 'PING.EXE', start: undefined },
    ]);
    expect(m.parseWin32Processes('')).toEqual([]);
  });

  it('findDescendants 沿父进程号往下找整棵子树，不含根、不含旁支', async () => {
    const m = await load();
    const table: ProcEntry[] = [
      { pid: 10, ppid: 1, name: 'minisd' }, { pid: 11, ppid: 10, name: 'powershell.exe' },
      { pid: 12, ppid: 11, name: 'PING.EXE' }, { pid: 13, ppid: 1, name: 'PING.EXE' }, { pid: 14, ppid: 12, name: 'child' },
    ];
    expect(m.findDescendants(table, 10).map(p => p.pid).sort()).toEqual([11, 12, 14]);
    expect(m.findDescendants(table, 99)).toEqual([]);
  });

  it('findDescendants 不把比「父进程」还早启动的进程算作后代：Windows 的父进程号不随父进程退出而更新，进程号又会复用', async () => {
    const m = await load();
    // 清理要结束引擎整棵子树：早先占过引擎这个进程号的程序留下的孤儿（及其子孙）绝不能算进来
    const table: ProcEntry[] = [
      { pid: 10, ppid: 1, name: 'electron.exe', start: '1790000005000' },
      { pid: 11, ppid: 10, name: 'powershell.exe', start: '1790000006000' },
      { pid: 12, ppid: 11, name: 'PING.EXE', start: '1790000007000' },
      { pid: 13, ppid: 10, name: 'notepad.exe', start: '1789999000000' },
      { pid: 14, ppid: 13, name: 'helper.exe', start: '1789999100000' },
    ];
    expect(m.findDescendants(table, 10).map(p => p.pid).sort()).toEqual([11, 12]);
    // PowerShell 7 的 ISO 时间（七位小数）同样比较；同一毫秒起的不排除
    const iso: ProcEntry[] = [
      { pid: 20, ppid: 1, name: 'electron.exe', start: '2026-09-25T10:00:00.1234567+08:00' },
      { pid: 21, ppid: 20, name: 'PING.EXE', start: '2026-09-25T10:00:00.1239999+08:00' },
      { pid: 22, ppid: 20, name: 'old.exe', start: '2026-09-25T09:59:59.0000000+08:00' },
    ];
    expect(m.findDescendants(iso, 20).map(p => p.pid)).toEqual([21]);
    // 启动时刻缺了或认不出（系统进程、macOS 的 ps 不给）就不排除
    const unknown: ProcEntry[] = [
      { pid: 30, ppid: 1, name: 'electron' }, { pid: 31, ppid: 30, name: 'ping', start: '5' }, { pid: 32, ppid: 30, name: 'x', start: 'garbage' },
    ];
    expect(m.findDescendants(unknown, 30).map(p => p.pid).sort()).toEqual([31, 32]);
  });

  it('reapPings：deadline 内都退出算过；不退的核对身份后结束，进程号被复用的（启动时刻对不上）绝不误杀，核对不了就不杀', async () => {
    const m = await load();
    const a: ProcEntry = { pid: 101, ppid: 100, name: 'PING.EXE', start: 't1' };
    const b: ProcEntry = { pid: 102, ppid: 100, name: 'PING.EXE', start: 't2' };
    // 第三次看时都没了
    let polls = 0;
    const ok = await m.reapPings([a, b], { deadlineMs: 2_000, intervalMs: 10, isAlive: () => ++polls < 3, snapshot: async () => [], kill: () => { throw new Error('不该杀'); } });
    expect(ok).toEqual({ ok: true, killed: [] });

    // 一直不退：a 在进程表里原样还在 → 结束它；102 已被别的程序复用（启动时刻不同）→ 不碰
    const killed: number[] = [];
    const stuck = await m.reapPings([a, b], {
      deadlineMs: 150, intervalMs: 10, isAlive: () => true,
      snapshot: async () => [{ pid: 101, ppid: 100, name: 'PING.EXE', start: 't1' }, { pid: 102, ppid: 7, name: 'PING.EXE', start: 'other' }],
      kill: (pid) => { killed.push(pid); },
    });
    expect(stuck).toEqual({ ok: false, killed: [101] });
    expect(killed).toEqual([101]);

    // 进程表拿不到：判失败，但谁也不杀
    const blind = await m.reapPings([a], { deadlineMs: 50, intervalMs: 10, isAlive: () => true, snapshot: async () => { throw new Error('powershell 起不来'); }, kill: () => { throw new Error('不该杀'); } });
    expect(blind).toEqual({ ok: false, killed: [] });
  });

  it('reapTree（停完引擎后收拾它名下没跟着退的）：身份核对得上的才结束；进程号被复用的不碰；结束不了的、核对不了的分开报', async () => {
    const m = await load();
    const drv: ProcEntry = { pid: 201, ppid: 200, name: 'powershell.exe', start: 's1' };
    const ping: ProcEntry = { pid: 202, ppid: 201, name: 'PING.EXE', start: 's2' };
    const mcp: ProcEntry = { pid: 203, ppid: 200, name: 'node.exe', start: 's3' };
    const quick = { graceMs: 30, deadlineMs: 200, intervalMs: 10 };
    const noSnapshot = async (): Promise<ProcEntry[]> => { throw new Error('不该取进程表'); };
    const noKill = (): void => { throw new Error('不该杀'); };

    // 名单是空的（引擎名下本来就没有进程），或都跟着引擎退了：什么也不做
    expect(await m.reapTree([], { ...quick, isAlive: () => true, snapshot: noSnapshot, kill: noKill })).toEqual({ killed: [], stuck: [], unverified: [] });
    expect(await m.reapTree([drv, ping], { ...quick, isAlive: () => false, snapshot: noSnapshot, kill: noKill })).toEqual({ killed: [], stuck: [], unverified: [] });
    // 引擎一没就读到 stdin 结束、在 grace 里自己退了的（MCP 服务器）：先等它，不替它结束，也不算进「结束了几个」
    let polls = 0;
    expect(await m.reapTree([mcp], { ...quick, isAlive: () => ++polls < 3, snapshot: noSnapshot, kill: noKill })).toEqual({ killed: [], stuck: [], unverified: [] });

    // 驱动跟着引擎退了；ping 还在、身份对得上 → 结束；203 号已被别的程序复用（启动时刻不同）→ 不碰
    const alive = new Set([202, 203]);
    const killed: number[] = [];
    const r = await m.reapTree([drv, ping, mcp], {
      ...quick, isAlive: p => alive.has(p.pid),
      snapshot: async () => [{ pid: 202, ppid: 201, name: 'PING.EXE', start: 's2' }, { pid: 203, ppid: 9, name: 'node.exe', start: 'other' }],
      kill: (pid) => { killed.push(pid); alive.delete(pid); },
    });
    expect(killed).toEqual([202]);
    expect(r).toEqual({ killed: [ping], stuck: [], unverified: [] });

    // 名字对不上（进程号被一个同启动时刻都查不到的别的程序占了）也不碰
    const renamed = await m.reapTree([ping], { ...quick, isAlive: () => true, snapshot: async () => [{ ...ping, name: 'explorer.exe' }], kill: noKill });
    expect(renamed).toEqual({ killed: [], stuck: [], unverified: [] });

    // 杀了还在：记为结束不了
    const stuck = await m.reapTree([ping], { ...quick, isAlive: () => true, snapshot: async () => [ping], kill: () => {} });
    expect(stuck).toEqual({ killed: [], stuck: [ping], unverified: [] });

    // 进程表取不到：核对不了身份，谁也不杀，记为核对不了
    const blind = await m.reapTree([ping], { ...quick, isAlive: () => true, snapshot: async () => { throw new Error('powershell 起不来'); }, kill: noKill });
    expect(blind).toEqual({ killed: [], stuck: [], unverified: [ping] });
  });

  it('takeProcessSnapshot 在本机真能列出本进程与它的父进程号', async () => {
    const m = await load();
    const snap = await m.takeProcessSnapshot();
    const me = snap.find(p => p.pid === process.pid);
    expect(me, '进程表里找不到本进程').toBeDefined();
    expect(me!.ppid).toBe(process.ppid);
  }, 30_000);
});

describe('smoke-release：假端点对真 provider', () => {
  it('Anthropic 假端点：真 AnthropicProvider 解析出 file_write → file_read → 收尾文本 → memory_write，思考块带签名且回放被认', async () => {
    const m = await load();
    const key = 'sk-ant-unit-0123456789abcdef';
    const mock = await m.startMockAnthropic({ apiKey: key });
    cleanups.push(() => mock.close());
    const p = new AnthropicProvider({ apiKey: key, modelId: 'claude-fable-5-1', baseUrl: mock.url });
    const pr = m.smokePrompts('a1b2c3');
    const history: AgentMessage[] = [{ role: 'user', parts: [{ type: 'text', value: pr.turns[0] }] }];
    const req = (): StreamRequest => ({ messages: history, tools: TOOLS, maxTokens: 1024, thinkingLevel: 'off', systemPrompt: '系统提示' });
    /** 照 loop 的落库形状把一步回复接进历史：思考块在前，工具调用在后，再补一条工具结果。 */
    const replay = (ev: AgentStreamEvent[], result?: string): ToolCall | undefined => {
      const think = ev.find((e): e is Thinking => e.kind === 'thinkingComplete');
      const call = callsOf(ev)[0];
      const parts: AgentMessage['parts'] = [];
      if (think) parts.push({ type: 'thinking', value: { text: think.text, signature: think.signature } });
      const text = textOf(ev);
      if (text) parts.push({ type: 'text', value: text });
      if (call) parts.push({ type: 'toolUse', value: { toolUseId: call.toolUseId, name: call.name, input: call.input } });
      history.push({ role: 'assistant', parts });
      if (call) history.push({ role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: call.toolUseId, output: result ?? '', success: true, status: 'success' } }] });
      return call;
    };

    let ev = await collect(p.streamAgentMessage(req()));
    const think1 = ev.find((e): e is Thinking => e.kind === 'thinkingComplete');
    expect(think1?.signature, '假端点要像新一代 Claude 一样回带签名的思考块').toBeTruthy();
    const write = replay(ev, '已写入');
    expect(write?.name).toBe('file_write');
    expect(JSON.parse(write!.input)).toMatchObject({ path: pr.file, content: pr.fileMarker });
    expect(lastOf(ev)).toEqual({ kind: 'done', stopReason: 'toolUse' });

    ev = await collect(p.streamAgentMessage(req()));
    const read = replay(ev, `${pr.fileMarker}\n`);
    expect(read?.name).toBe('file_read');
    expect(JSON.parse(read!.input)).toMatchObject({ path: pr.file });

    ev = await collect(p.streamAgentMessage(req()));
    expect(callsOf(ev)).toEqual([]);
    expect(textOf(ev)).toContain(pr.fileMarker);
    expect(lastOf(ev)).toEqual({ kind: 'done', stopReason: 'endTurn' });
    replay(ev);

    history.push({ role: 'user', parts: [{ type: 'text', value: pr.turns[1] }] });
    ev = await collect(p.streamAgentMessage(req()));
    const mem = replay(ev, '已写入 2026-09-25 日志');
    expect(mem?.name).toBe('memory_write');
    expect(JSON.parse(mem!.input).markdown).toContain(pr.memMarker);
    ev = await collect(p.streamAgentMessage(req()));
    expect(lastOf(ev)).toEqual({ kind: 'done', stopReason: 'endTurn' });

    // 没有工具的请求（自动取标题）回一段短文本
    const title = await collect(p.streamAgentMessage({ messages: [{ role: 'user', parts: [{ type: 'text', value: pr.turns[0] }] }], tools: [], maxTokens: 64, thinkingLevel: 'off', systemPrompt: '你是标题生成器' }));
    expect(textOf(title).length).toBeGreaterThan(0);
    expect(mock.hits.every(h => h.status === 200)).toBe(true);
  });

  it('Anthropic 假端点照真端点拦：key 不对 401、思考块签名被改 400、tool_use 没有配对结果 400、新一代模型收到 enabled 思考 400', async () => {
    const m = await load();
    const key = 'sk-ant-unit-0123456789abcdef';
    const mock = await m.startMockAnthropic({ apiKey: key });
    cleanups.push(() => mock.close());
    const pr = m.smokePrompts('d4e5f6');
    const user: AgentMessage = { role: 'user', parts: [{ type: 'text', value: pr.turns[0] }] };
    const req = (messages: AgentMessage[]): StreamRequest => ({ messages, tools: TOOLS, maxTokens: 1024, thinkingLevel: 'off', systemPrompt: 's' });

    const wrong = new AnthropicProvider({ apiKey: 'sk-ant-wrong-key-000000', modelId: 'claude-opus-5-5', baseUrl: mock.url });
    await expect(collect(wrong.streamAgentMessage(req([user])))).rejects.toMatchObject({ status: 401 });

    const p = new AnthropicProvider({ apiKey: key, modelId: 'claude-opus-5-5', baseUrl: mock.url });
    const tampered: AgentMessage[] = [user,
      { role: 'assistant', parts: [{ type: 'thinking', value: { text: 'x', signature: 'forged-signature' } }, { type: 'toolUse', value: { toolUseId: 'toolu_1', name: 'file_write', input: '{}' } }] },
      { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: 'toolu_1', output: 'ok', success: true, status: 'success' } }] }];
    await expect(collect(p.streamAgentMessage(req(tampered)))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/signature/) });

    const unpaired = { model: 'claude-opus-5-5', max_tokens: 64, stream: true, messages: [
      { role: 'user', content: [{ type: 'text', text: pr.turns[0] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'file_write', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] }], tools: [] };
    const r1 = await fetch(`${mock.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(unpaired) });
    expect(r1.status).toBe(400);
    expect(await r1.text()).toMatch(/tool_result/);

    const enabled = { model: 'claude-opus-5-5', max_tokens: 64, stream: true, thinking: { type: 'enabled', budget_tokens: 32 }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    const r2 = await fetch(`${mock.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(enabled) });
    expect(r2.status).toBe(400);
  });

  it('DeepSeek 假端点：真 OpenAIProvider（deepseek-v4-flash）拿到推理与工具调用，带回 reasoning_content 的历史第二轮起不报 400', async () => {
    const m = await load();
    const key = 'sk-unit-0123456789abcdef';
    const mock = await m.startMockOpenAI({ apiKey: key, requireReasoningEcho: true });
    cleanups.push(() => mock.close());
    const p = new OpenAIProvider({ apiKey: key, modelId: 'deepseek-v4-flash', baseUrl: mock.url });
    const pr = m.smokePrompts('0a0b0c');
    const history: AgentMessage[] = [{ role: 'user', parts: [{ type: 'text', value: pr.turns[0] }] }];
    const req = (): StreamRequest => ({ messages: history, tools: TOOLS, maxTokens: 1024, thinkingLevel: 'off', systemPrompt: 's' });
    const step = async (result: string): Promise<ToolCall | undefined> => {
      const ev = await collect(p.streamAgentMessage(req()));
      const reasoning = reasoningOf(ev);
      expect(reasoning.length, '假端点要像 V4 思考模式一样先吐 reasoning_content').toBeGreaterThan(0);
      const call = callsOf(ev)[0];
      const text = textOf(ev);
      const parts: AgentMessage['parts'] = [];
      if (text) parts.push({ type: 'text', value: text });
      if (call) parts.push({ type: 'toolUse', value: { toolUseId: call.toolUseId, name: call.name, input: call.input } });
      history.push({ role: 'assistant', parts, reasoningContent: reasoning });
      if (call) history.push({ role: 'user', parts: [{ type: 'toolResult', value: { toolUseId: call.toolUseId, output: result, success: true, status: 'success' } }] });
      return call;
    };
    expect((await step('已写入'))?.name).toBe('file_write');
    expect((await step(pr.fileMarker))?.name).toBe('file_read');
    expect(await step('')).toBeUndefined();
    history.push({ role: 'user', parts: [{ type: 'text', value: pr.turns[1] }] });
    const mem = await step('已写入');
    expect(mem?.name).toBe('memory_write');
    expect(JSON.parse(mem!.input).markdown).toContain(pr.memMarker);
    expect(mock.hits.every(h => h.status === 200)).toBe(true);
  });

  it('DeepSeek 假端点照真端点拦：assistant 历史缺 reasoning_content 回 400，key 不对回 401；不要求回放的实例放行', async () => {
    const m = await load();
    const key = 'sk-unit-0123456789abcdef';
    const mock = await m.startMockOpenAI({ apiKey: key, requireReasoningEcho: true });
    cleanups.push(() => mock.close());
    const body = { model: 'deepseek-v4-flash', stream: true, messages: [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'file_write', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' }], tools: [] };
    const post = (url: string, k: string | undefined, b: unknown): Promise<Response> => fetch(`${url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}) }, body: JSON.stringify(b) });
    const r1 = await post(mock.url, key, body);
    expect(r1.status).toBe(400);
    expect(await r1.text()).toMatch(/reasoning_content/);
    expect((await post(mock.url, 'sk-wrong-0000000000', body)).status).toBe(401);

    const lax = await m.startMockOpenAI({ requireReasoningEcho: false });
    cleanups.push(() => lax.close());
    const r3 = await post(lax.url, undefined, body);
    expect(r3.status).toBe(200);
    await r3.text();
  });

  it('shell 剧本：假端点让模型调用 shell_execute 跑那条长命令', async () => {
    const m = await load();
    const mock = await m.startMockOpenAI({ requireReasoningEcho: false });
    cleanups.push(() => mock.close());
    const p = new OpenAIProvider({ apiKey: '', modelId: 'smoke-shell', baseUrl: mock.url, compat: { reasoningEffort: false } });
    const ev = await collect(p.streamAgentMessage({ messages: [{ role: 'user', parts: [{ type: 'text', value: m.shellStopPrompt('ping -t 127.0.0.1') }] }], tools: TOOLS, maxTokens: 256, thinkingLevel: 'off' }));
    const call = callsOf(ev)[0];
    expect(call?.name).toBe('shell_execute');
    expect(JSON.parse(call!.input)).toMatchObject({ command: 'ping -t 127.0.0.1' });
    expect(typeof JSON.parse(call!.input).tool_title).toBe('string');
  });
});

describe('smoke-release：最小 MCP 服务器', () => {
  /** 起服务器、发几行 JSON-RPC、收齐应答。env 带 ELECTRON_RUN_AS_NODE：单测跑在 Electron 上，process.execPath 是 electron。 */
  function runServer(file: string, args: string[], lines: unknown[]): Promise<{ code: number | null; out: Array<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(process.execPath, [file, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Array<Record<string, unknown>> = [];
      let buf = '';
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) out.push(JSON.parse(line) as Record<string, unknown>);
          if (out.length >= lines.filter(l => (l as { id?: unknown }).id !== undefined).length) child.stdin!.end();
        }
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error('MCP 服务器没有应答')); }, 15_000);
      // 参数被拆开的那次服务器一起来就退出，随后往 stdin 写会 EPIPE：吞掉，结论看退出码
      child.stdin!.on('error', () => {});
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
      for (const l of lines) child.stdin!.write(`${JSON.stringify(l)}\n`);
    });
  }

  it('放进带空格的目录也能握手、列出唯一的工具；参数被拆开时以 3 退出', async () => {
    const m = await load();
    const dir = join(tempDir('dm-smoke-mcp-'), 'smoke mcp server');
    mkdirSync(dir, { recursive: true });
    const expected = ['C:\\Program Files\\DeskMinis Smoke\\probe arg'];
    const file = join(dir, 'server.mjs');
    writeFileSync(file, m.mcpServerSource(expected), 'utf8');
    const ok = await runServer(file, expected, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deskminis' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const init = ok.out.find(o => o.id === 1) as { result?: { protocolVersion?: string } } | undefined;
    expect(init?.result?.protocolVersion).toBe('2025-06-18');
    const list = ok.out.find(o => o.id === 2) as { result?: { tools?: Array<{ name: string }> } } | undefined;
    expect(list?.result?.tools?.map(t => t.name)).toEqual(['smoke_ping']);
    expect(ok.code).toBe(0);

    const split = await runServer(file, ['C:\\Program', 'Files\\DeskMinis', 'Smoke\\probe', 'arg'], [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
    expect(split.code).toBe(3);
    expect(split.out).toEqual([]);
  });
});

describe('smoke-release：与引擎的 RPC 连接', () => {
  it('connectRpc：连接一断（像引擎被 kill -9），挂着的请求立即拒绝，之后的 call 也立即拒绝、不干等超时，并说明多半是引擎退出了', async () => {
    const m = await load();
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(r => wss.once('listening', () => r()));
    cleanups.push(() => new Promise<void>(r => wss.close(() => r())));
    const peers: WsPeer[] = [];
    wss.on('connection', s => { peers.push(s); }); // 收下请求不回：像引擎正忙着的时候被杀
    const client = await m.connectRpc((wss.address() as AddressInfo).port, 'tok');
    cleanups.push(() => client.close());
    const inFlight = client.call('provider.instances.create', {}, 10_000).then(() => '竟然成功了', (e: Error) => e.message);
    for (let i = 0; peers.length === 0 && i < 200; i++) await new Promise(r => setTimeout(r, 10));
    peers[0].terminate(); // TCP 直接断，没有关闭帧
    const inFlightMsg = await inFlight;
    const t0 = Date.now();
    const afterMsg = await client.call('workspace.get', {}, 10_000).then(() => '竟然成功了', (e: Error) => e.message);
    expect(afterMsg).toMatch(/^workspace\.get：与引擎的连接已断开（引擎退出了？）/);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(inFlightMsg).toMatch(/^provider\.instances\.create：与引擎的连接断了（引擎退出了？）/);
    expect(client.closed).toBe(true);
  }, 30_000);

  it('connectRpc.refuse（被打断之后）：新请求当场拒绝并说明原因、一个也不发给引擎；连接不断，已经发出的请求照常收应答', async () => {
    const m = await load();
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(r => wss.once('listening', () => r()));
    cleanups.push(() => new Promise<void>(r => wss.close(() => r())));
    const got: string[] = [];
    let answer: (() => void) | undefined;
    wss.on('connection', s => {
      s.on('message', (d) => {
        const msg = JSON.parse(String(d)) as { id: number; method: string };
        got.push(msg.method);
        // 先收着不回：refuse 之后再回，看已经发出的请求还收不收得到应答
        answer = () => s.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
      });
    });
    const client = await m.connectRpc((wss.address() as AddressInfo).port, 'tok');
    cleanups.push(() => client.close());
    const inFlight = client.call('chat.sessions.create', {}, 10_000);
    // 下面哪句先失败的话它就没人等了，收尾断开时的拒绝不该变成未处理的拒绝（照样在后面 await 它）
    inFlight.catch(() => {});
    for (let i = 0; got.length === 0 && i < 200; i++) await new Promise(r => setTimeout(r, 10));
    expect(got).toEqual(['chat.sessions.create']);
    client.refuse('已收到 SIGINT、正在清理，不再给引擎发新请求');
    const t0 = Date.now();
    await expect(client.call('chat.prompt', {}, 10_000)).rejects.toThrow(/^chat\.prompt：已收到 SIGINT、正在清理，不再给引擎发新请求$/);
    await expect(client.call('permission.respond', {}, 10_000)).rejects.toThrow(/^permission\.respond：已收到 SIGINT/);
    expect(Date.now() - t0, '被拒绝的请求不该干等超时').toBeLessThan(1_000);
    answer!();
    await expect(inFlight).resolves.toEqual({ ok: true });
    await new Promise(r => setTimeout(r, 50));
    expect(got, '被拒绝的请求不该发给引擎').toEqual(['chat.sessions.create']);
    expect(client.closed, '连接不该断：清理还要趁引擎活着取进程表').toBe(false);
  }, 30_000);

  it('runTurn：chat.prompt 当场失败（比如连接已断）时这一轮的原因只报一次，不在「以错误结束」之外再报一条同样的 error 事件', async () => {
    const m = await load();
    const why = 'chat.prompt：与引擎的连接已断开（引擎退出了？）';
    const client = { call: async (): Promise<unknown> => { throw new Error(why); }, onNotify: () => () => {} };
    const t = await m.runTurn({ client, turnTimeoutMs: 5_000 }, 'S1', '你好', 'P1');
    const a = m.assessToolSession([t], { file: 'smoke-x.txt', fileMarker: 'F', memMarker: 'M', workspaceFileText: undefined, memoryText: '' });
    expect(a.problems.filter(p => p.startsWith('第 1 轮'))).toEqual([`第 1 轮以错误结束：${why}`]);
  });

  it('engineGone：连接先断、exit 事件后到时稍等它，说明里带上退出码或信号；连接断了引擎却还在，最多等 3 秒；引擎好好的就是 undefined', async () => {
    const m = await load();
    const engine: { exit?: { code: number | null; signal: string | null } } = {};
    setTimeout(() => { engine.exit = { code: null, signal: 'SIGKILL' }; }, 200);
    expect(await m.engineGone({ engine, client: { closed: true } }, '已在前面')).toBe('引擎已在前面退出（SIGKILL）');
    expect(await m.engineGone({ engine: { exit: { code: 3, signal: null } }, client: { closed: true } }, '在这个用例进行中')).toBe('引擎在这个用例进行中退出（3）');
    const t0 = Date.now();
    expect(await m.engineGone({ engine: {}, client: { closed: true } }, '已在前面')).toBe('与引擎的连接已在前面断开');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await m.engineGone({ engine: {}, client: { closed: false } }, '已在前面')).toBeUndefined();
  }, 15_000);

  it('engineCrashed（清理判「中途崩溃」）：起来过、不是脚本停的却退了才算；连接先断、exit 后到时先等它，不把崩溃当成自己停的', async () => {
    const m = await load();
    const killed = { code: null, signal: 'SIGKILL' };
    const engine: { booted: boolean; stopping: boolean; exit?: { code: number | null; signal: string | null } } = { booted: true, stopping: false };
    setTimeout(() => { engine.exit = killed; }, 200);
    expect(await m.engineCrashed({ engine, client: { closed: true } })).toEqual(killed);
    expect(await m.engineCrashed({ engine: { booted: true, stopping: true, exit: killed }, client: { closed: true } })).toBeUndefined();
    expect(await m.engineCrashed({ engine: { booted: false, stopping: false, exit: { code: 1, signal: null } } })).toBeUndefined();
    expect(await m.engineCrashed({ engine: { booted: true, stopping: false }, client: { closed: false } })).toBeUndefined();
  });

  it('shell-stop 中途抛出（chat.prompt 报错）也摘掉回合监听、撤掉放行、删会话与 provider：不留 120 秒的计时器把脚本在打完结果表之后拖住', async () => {
    const m = await load();
    const listeners = new Set<(method: string, params: unknown) => void>();
    const calls: string[] = [];
    const client = {
      closed: false,
      async call(method: string): Promise<unknown> {
        calls.push(method);
        if (method === 'provider.instances.create') return { id: 'P1' };
        if (method === 'chat.sessions.create') return { id: 'S1' };
        if (method === 'chat.prompt') throw new Error('chat.prompt：模型实例不存在');
        return {};
      },
      onNotify(fn: (method: string, params: unknown) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
    };
    const ctx = { client, platform: process.platform, allow: [] as unknown[], engine: { child: { pid: 0 } } };
    await expect(m.caseShellStop(ctx)).rejects.toThrow(/chat\.prompt：模型实例不存在/);
    expect(listeners.size, '回合监听没摘').toBe(0);
    expect(ctx.allow).toEqual([]);
    expect(calls).toEqual(expect.arrayContaining(['chat.sessions.delete', 'provider.instances.delete']));
  });

  it('runToolSession：建过的 provider 登记成凭据库账户 provider:<id>（清理据此删用户的 key），收尾照删会话与 provider', async () => {
    const m = await load();
    const dir = tempDir('dm-smoke-session-');
    const listeners = new Set<(method: string, params: unknown) => void>();
    const calls: string[] = [];
    const client: FakeClient = {
      closed: false,
      async call(method: string): Promise<unknown> {
        calls.push(method);
        if (method === 'provider.instances.create') return { id: 'P1' };
        if (method === 'chat.sessions.create') return { id: 'S1' };
        if (method === 'workspace.get') return { root: dir };
        if (method === 'chat.prompt') {
          // 回合立刻收尾（不调工具）：判定会是 FAIL，这里只看登记与收尾
          setTimeout(() => { for (const l of [...listeners]) l('chat.event', { sessionId: 'S1', event: { kind: 'turnEnd', stopReason: 'endTurn' } }); }, 0);
        }
        return {};
      },
      onNotify(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    };
    const ctx = { client, accounts: new Set(['pairing.static-identity']), turnTimeoutMs: 5_000, dataRoot: dir, denied: [], say: () => {} };
    const r = await m.runToolSession(ctx, 'claude-opus-5-5', { name: '冒烟', kind: 'anthropic', modelId: 'claude-opus-5-5', apiKey: 'sk-ant-x' });
    expect([...ctx.accounts]).toEqual(['pairing.static-identity', 'provider:P1']);
    expect(r.ok).toBe(false);
    expect(calls).toEqual(expect.arrayContaining(['chat.sessions.delete', 'provider.instances.delete']));
  });

  it('runToolSession：provider 一建好就登记，紧接着建会话就失败（引擎半路没了）也不漏——凭据库里那条存着用户的 key，系统不支持枚举时清理只认这份清单', async () => {
    const m = await load();
    const calls: string[] = [];
    const client: FakeClient = {
      closed: false,
      async call(method: string): Promise<unknown> {
        calls.push(method);
        if (method === 'provider.instances.create') return { id: 'P2' };
        if (method === 'chat.sessions.create') throw new Error('chat.sessions.create：与引擎的连接断了（引擎退出了？）');
        return {};
      },
      onNotify() { return () => {}; },
    };
    const ctx = { client, accounts: new Set(['pairing.static-identity']), turnTimeoutMs: 5_000, dataRoot: tempDir('dm-smoke-session-'), denied: [], say: () => {} };
    await expect(m.runToolSession(ctx, 'claude-opus-5-5', { name: '冒烟', kind: 'anthropic', modelId: 'claude-opus-5-5', apiKey: 'sk-ant-x' }))
      .rejects.toThrow(/^chat\.sessions\.create：/);
    expect([...ctx.accounts]).toEqual(['pairing.static-identity', 'provider:P2']);
    expect(calls, '建过的 provider 收尾照删').toContain('provider.instances.delete');
  });
});

describe('smoke-release：package.json 入口', () => {
  it('smoke:release 先构建再跑脚本，依赖一行不动', () => {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['smoke:release']).toBe('electron-vite build && node scripts/smoke-release.mjs');
    expect(existsSync(SCRIPT)).toBe(true);
  });
});

describe('smoke-release：整条 --mock（先构建）', () => {
  // out/ 是 main 与 minisd 的构建产物：脚本起的是 out/main/minisd.js，不先构建就测的是旧代码（或根本没有）。
  // 构建与 npm run build 相同（electron-vite build），只写 out/，没有别的测试读它。
  beforeAll(() => {
    const bin = join(appRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
    const r = spawnSync(process.execPath, [bin, 'build'], { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 150_000 });
    expect(r.status, `构建失败：\n${r.stdout}\n${r.stderr}`).toBe(0);
  }, 180_000);

  /** 照 npm run smoke:release 的方式起脚本（cwd 是工程目录，Electron 当 Node 跑），收齐输出。
   *  onOutput 在每块输出到达时拿到累计的全文与脚本进程：植入明文 key 的那例要赶在清理之前动手，信号那几例要在用例进行中发信号。
   *  deadlineMs（缺省 85 秒）还没完就发 SIGINT（脚本清理后退出）。signal 非空说明脚本是被信号当场打死的，没走自己的清理。
   *  file 缺省是脚本本身；换成调 runSmoke 的小驱动时，用同样的方式起。
   *  out 是 stdout 与 stderr 按到达先后拼起来的（块与块之间可能不在行边界上），stdout 另给一份。按 utf8 流式解码：
   *  逐块各自 toString 的话，一个汉字恰好跨两块时两边都成了乱码。 */
  function runScript(args: string[], env: Record<string, string | undefined>, onOutput?: (all: string, child: ChildProcess) => void, deadlineMs = 85_000, file = SCRIPT): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; stdout: string; elapsed: number; endedAt: number }> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [file, ...args], { cwd: appRoot, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { stdout += d; out += d; onOutput?.(out, child); });
      child.stderr.on('data', (d: string) => { out += d; onOutput?.(out, child); });
      const timer = setTimeout(() => { child.kill('SIGINT'); }, deadlineMs);
      // 等 close 而不是 exit：exit 到的时候管道里可能还有没读的尾巴。信号那条路紧跟着清理那一行就 process.exit，
      // 按 exit 收会时不时丢掉最要看的那一行（脚本不把 stdout 交给任何子进程，close 不会被孙进程拖住）
      child.on('close', (code, signal) => { clearTimeout(timer); const endedAt = Date.now(); resolve({ code, signal, out, stdout, elapsed: endedAt - started, endedAt }); });
    });
  }
  const row = (out: string, name: string): string | undefined => out.split(/\r?\n/).find(l => new RegExp(`^(PASS|FAIL|SKIP)\\s+${name}\\s`).test(l));
  /** 结果表里某一行连同它的续行（续行以空格缩进）。 */
  const rowBlock = (out: string, name: string): string => {
    const lines = out.split(/\r?\n/);
    const at = lines.findIndex(l => new RegExp(`^(PASS|FAIL|SKIP)\\s+${name}\\s`).test(l));
    if (at < 0) return '';
    let end = at + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
    return lines.slice(at, end).join('\n');
  };
  const tempRootOf = (out: string): string | undefined => /临时目录：(.+)$/m.exec(out)?.[1]?.trim();

  /** 非 Windows 上 shell_execute 起的是裸名 powershell.exe：在 PATH 最前面放一个照驱动行协议办事的假货，再放一个假 ping（正文由调用方给）。
   *  驱动把自己与引擎（它的父进程）的进程号导出给假 ping 用。 */
  function fakeShellEnv(pingBody: string[]): Record<string, string | undefined> {
    const bin = tempDir('dm-smoke-fakebin-');
    writeFileSync(join(bin, 'powershell.exe'), [
      '#!/bin/sh',
      '# 假 powershell.exe：每行「标记 base64(命令)」，交给 sh 跑完回一行哨兵（同 src/minisd/tools/shell.ts 的驱动）',
      'SMOKE_DRIVER_PID=$$',
      'SMOKE_ENGINE_PID=$PPID',
      'export SMOKE_DRIVER_PID SMOKE_ENGINE_PID',
      'while IFS= read -r line; do',
      '  marker=${line%% *}',
      '  cmd=$(printf \'%s\' "${line#* }" | base64 -d)',
      '  sh -c "$cmd" 2>&1',
      '  printf \'__MINIS_DONE_%s_EXIT_%s__\\n\' "$marker" "$?"',
      'done',
      '',
    ].join('\n'));
    writeFileSync(join(bin, 'ping'), ['#!/bin/sh', ...pingBody, ''].join('\n'));
    chmodSync(join(bin, 'powershell.exe'), 0o755);
    chmodSync(join(bin, 'ping'), 0o755);
    return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
  }

  it('四个用例与清理都有结论、退出 0；输出里没有任何 key；临时目录已删（总时长 90 秒内）', async () => {
    // 环境里故意放两把「真 key」：--mock 不该用它们，也绝不能让它们出现在输出里
    const envKeyA = 'sk-ant-envkey-must-not-leak-0123456789';
    const envKeyD = 'sk-envkey-must-not-leak-9876543210';
    const r = await runScript(['--mock', '--memory-vault'], { ...process.env, ANTHROPIC_API_KEY: envKeyA, DEEPSEEK_API_KEY: envKeyD });
    expect(r.code, r.out).toBe(0);
    expect(row(r.out, 'anthropic'), r.out).toMatch(/^PASS/);
    expect(row(r.out, 'deepseek'), r.out).toMatch(/^PASS/);
    expect(row(r.out, 'mcp-spaces'), r.out).toMatch(/^PASS/);
    // Linux 容器里没有 powershell.exe：写明原因的 SKIP（下一例用假的补上）；Windows 上真跑并 PASS
    expect(row(r.out, 'shell-stop'), r.out).toMatch(/^(PASS|SKIP\s+shell-stop\s+跳过（.*(powershell\.exe|ping))/);
    expect(row(r.out, '清理'), r.out).toMatch(/^PASS/);
    expect(r.out).not.toContain(envKeyA);
    expect(r.out).not.toContain(envKeyD);
    expect(r.out, '假端点用的 key 也不该出现在输出里').not.toMatch(/smoke-mock-[0-9a-f]{8}/);
    const root = tempRootOf(r.out);
    expect(root, '脚本要说明临时目录在哪').toBeTruthy();
    expect(existsSync(root!), `临时目录没删：${root}`).toBe(false);
    // W3-smokec：非 Windows 上桥的命名管道 \\.\pipe\deskminis-<哈希> 是相对路径，套接字文件落在引擎的 cwd。
    // 引擎以临时根为 cwd 起，它就随临时根一起删；以前落在脚本的 cwd（应用目录），每跑一次留一个
    if (process.platform !== 'win32') {
      const pipe = bridgePipePath(join(root!, 'data'));
      expect(existsSync(join(appRoot, pipe)), `应用目录里留下了引擎的管道套接字 ${pipe}`).toBe(false);
    }
    expect(r.elapsed).toBeLessThan(90_000);
  }, 90_000);

  it('打印的每一行都先脱敏：key 恰好是一定会打印的字时，输出里只剩 [已隐藏]', async () => {
    // --mock 不用环境里的 key，它们只进脱敏与明文扫描的名单。上一例那种 sk-… 形状的 key 本来就不会被打印，
    // 「输出里没有它」恒为真；这里挑两段一定会打印、又不会落进临时目录的字当 key：分隔线开头由 runSmoke 的 say 打
    // （横幅上下），结尾由 main 用 runSmoke 交回的 say 打（结果表上下）；清理行的最后半句也由 main 打。
    // 哪一处打印绕过了脱敏，原文就会出现在输出里。横幅里的「DeskMinis 发版冒烟」不能用：mcp-spaces 写进临时目录的
    // 服务器源码头一行注释就有这几个字，清理的明文扫描会把它当成泄露的 key
    const rule = '═'.repeat(8);
    const cleanTail = '临时目录里没有明文 key';
    const r = await runScript(['--mock', '--memory-vault', '--only', 'mcp-spaces'], { ...process.env, ANTHROPIC_API_KEY: rule, DEEPSEEK_API_KEY: cleanTail });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(rule);
    expect(r.out).not.toContain(cleanTail);
    const rules = r.out.split(/\r?\n/).filter(l => l === '[已隐藏]'.repeat(8));
    expect(rules.length, '横幅上下两条、结果表上下两条分隔线都该换掉').toBe(4);
    // 两段字都不在临时目录里（清理的明文扫描用的是同一份名单），所以清理照样 PASS，行尾那半句换成了 [已隐藏]
    expect(row(r.out, '清理'), r.out).toMatch(/^PASS\s+清理\s+引擎已停；临时目录已删；\[已隐藏\]$/);
  }, 90_000);

  it('输出管道被读的一端先关掉（npm run smoke:release | head）：不因 EPIPE 崩掉，照样停引擎、删临时目录，按结论退出', async () => {
    // 带上 deepseek：读的一端关掉之后，脚本还要在好几拍里接着打印（每轮一行、最后是结果表）。只错一拍的话，console.log 自己就把那次
    // EPIPE 吞了——process.stdout 出错后会自己复位（dummyDestroy → _undestroy），console 只吞得住第一拍，第二拍的 'error' 没人接才崩
    // （只跑 mcp-spaces 时切断之后多半只剩结果表那一拍，入口不挂吞错监听也常常照绿）
    const child = spawn(process.execPath, [SCRIPT, '--mock', '--memory-vault', '--only', 'deepseek,mcp-spaces'], { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let cut = false;
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      // 拿到引擎 pid（与临时目录）就把读的一端关掉：之后脚本每写一行（用例进度、结果表）都是 EPIPE
      if (!cut && /引擎：pid \d+/.test(out)) { cut = true; child.stdout!.destroy(); }
    });
    child.stderr!.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { child.kill('SIGINT'); }, 60_000);
    const code = await new Promise<number | null>(res => child.on('close', c => { clearTimeout(timer); res(c); }));
    const root = tempRootOf(out);
    const enginePid = Number(/引擎：pid (\d+)/.exec(out)?.[1]);
    // 红的时候脚本当场崩掉，引擎与临时目录都留下：先登记收拾
    cleanups.push(() => {
      if (Number.isInteger(enginePid) && pidAlive(enginePid)) process.kill(enginePid, 'SIGKILL');
      if (root) rmSync(root, { recursive: true, force: true });
    });
    expect(cut, `${out}\n${err}`).toBe(true);
    expect(err, '脚本因 EPIPE 崩掉了').not.toMatch(/EPIPE|Unhandled 'error'/);
    expect(code, err).toBe(0);
    expect(root, out).toBeTruthy();
    expect(existsSync(root!), `临时目录没删：${root}`).toBe(false);
    for (let i = 0; pidAlive(enginePid) && i < 30; i++) await new Promise(res => setTimeout(res, 100));
    expect(pidAlive(enginePid), `引擎 pid ${enginePid} 还在`).toBe(false);
  }, 90_000);

  it('shell-stop 整条走一遍：权限卡只放行那条命令，chat.cancel 后引擎名下的 ping 几秒内退出（Windows 上是真 powershell 与 ping）', async () => {
    // 非 Windows：假 ping 在驱动（假 powershell）没了之后自己退出——于是「停止后驱动被杀」就等价于「ping 退出」，测的正是
    // chat.cancel → shell 中断这条产品链；最多活两分钟，测试中途失败也不会在测试机上留孤儿
    const env = process.platform === 'win32' ? { ...process.env } : fakeShellEnv([
      'parent=${SMOKE_DRIVER_PID:-$PPID}',
      'n=0',
      'while kill -0 "$parent" 2>/dev/null && [ "$n" -lt 1200 ]; do sleep 0.1; n=$((n + 1)); done',
    ]);
    const r = await runScript(['--mock', '--memory-vault', '--only', 'shell-stop'], env);
    expect(r.code, r.out).toBe(0);
    expect(row(r.out, 'shell-stop'), r.out).toMatch(/^PASS\s+shell-stop\s+chat\.cancel 后 \d+ms 内引擎名下的 ping 全部退出（pid \d+/);
    expect(row(r.out, '清理'), r.out).toMatch(/^PASS/);
  }, 90_000);

  it('清理：临时目录里出现明文 key 就判 FAIL、退出 1，只报文件不报 key，目录照删', async () => {
    const key = 'sk-ant-planted-must-not-leak-0123456789';
    let planted = false;
    const r = await runScript(['--mock', '--memory-vault', '--only', 'mcp-spaces'], { ...process.env, ANTHROPIC_API_KEY: key }, (all) => {
      const root = tempRootOf(all);
      if (root === undefined || planted) return;
      planted = true;
      // 模拟某处把 key 落了盘（日志、配置、库）：清理那一步的扫描必须抓到它
      writeFileSync(join(root, 'data', 'planted.txt'), `leak=${key}\n`);
    });
    expect(planted, r.out).toBe(true);
    expect(r.code, r.out).toBe(1);
    expect(row(r.out, 'mcp-spaces'), r.out).toMatch(/^PASS/);
    expect(row(r.out, '清理'), r.out).toMatch(/^FAIL\s+清理\s+临时目录里发现明文 key：.*planted\.txt/);
    expect(r.out).not.toContain(key);
    expect(existsSync(tempRootOf(r.out)!)).toBe(false);
  }, 90_000);

  it('引擎中途被杀：余下用例不再发 RPC、不干等超时，20 秒内退 1；每行都写明引擎退出了，单个模型出事只记在它自己那一行', async () => {
    let killedAt = 0;
    const r = await runScript(['--mock', '--memory-vault'], { ...process.env }, (all) => {
      const pid = /引擎：pid (\d+)/.exec(all)?.[1];
      if (pid === undefined || killedAt > 0) return;
      killedAt = Date.now();
      process.kill(Number(pid), 'SIGKILL'); // 像引擎崩溃：TCP 直接断，没有关闭帧
    }, 45_000);
    expect(killedAt, r.out).toBeGreaterThan(0);
    expect(r.code, r.out).toBe(1);
    expect(r.endedAt - killedAt, r.out).toBeLessThan(20_000);
    expect(r.out, '引擎没了之后不该再有 RPC 干等到超时').not.toMatch(/秒没有应答/);
    // 引擎死在哪个用例里，那一行第一句就点明；排在后面的一律「没有跑」。杀得几乎是一握手就动手，所以多半死在 anthropic 里；
    // 机器极忙、杀晚了的话前面的用例可能已经跑完（那就该是 PASS）
    const ran = ['anthropic', 'deepseek', 'mcp-spaces', 'shell-stop'].map(name => ({ name, block: rowBlock(r.out, name) })).filter(c => !/^SKIP/.test(c.block));
    const during = ran.findIndex(c => new RegExp(`^FAIL\\s+${c.name}\\s+引擎在这个用例进行中退出（`).test(c.block));
    expect(during, r.out).toBeGreaterThanOrEqual(0);
    for (const c of ran.slice(0, during)) expect(c.block, r.out).toMatch(/^PASS/);
    for (const c of ran.slice(during + 1)) expect(c.block, r.out).toMatch(new RegExp(`^FAIL\\s+${c.name}\\s+没有跑：引擎已在前面退出（`));
    if (ran[during].name === 'anthropic') {
      // 两个模型各有一行结论：前一个模型的结论不会被后一个模型的异常盖掉
      for (const model of ['claude-fable-5-1', 'claude-opus-5-5']) expect(ran[during].block, r.out).toMatch(new RegExp(`\\n\\s+${model}：`));
      // 第一个模型里就出了事，第二个模型不再发 RPC
      if (!/claude-fable-5-1：\d+ 轮都正常结束/.test(ran[during].block)) expect(ran[during].block, r.out).toMatch(/\n\s+claude-opus-5-5：没有跑：引擎已在前面退出（/);
    }
    expect(row(r.out, '清理'), r.out).toMatch(/^FAIL\s+清理\s+引擎在冒烟过程中自己退出了/);
    expect(existsSync(tempRootOf(r.out)!), '临时目录照删').toBe(false);
  }, 90_000);

  // Windows 上 shell_execute 起的是 System32 下真的 powershell 与 ping，没法在 ping 起来那一刻插手；这条链上等待与收手的逻辑
  // 与平台无关（连接断开 → 回合终态 → 轮询收手），在这里验
  it.skipIf(process.platform === 'win32')('shell-stop 途中引擎崩溃：不干等轮询与超时，几秒内判 FAIL、写明引擎退出了，也不留孤儿', async () => {
    // 假 ping 一起来就 kill -9 引擎（假驱动的父进程），模拟 shell 命令跑着时引擎崩溃，随即自己退出；
    // 假驱动随后往已断的管道写哨兵，跟着退出
    const env = fakeShellEnv(['kill -9 "$SMOKE_ENGINE_PID"']);
    let caseStartedAt = 0; // 从用例开始算，不算引擎起动（机器忙时起动本身就可能要好几秒）
    const r = await runScript(['--mock', '--memory-vault', '--only', 'shell-stop'], env, (all) => {
      if (caseStartedAt === 0 && all.includes('── shell-stop ──')) caseStartedAt = Date.now();
    }, 45_000);
    expect(r.code, r.out).toBe(1);
    expect(caseStartedAt, r.out).toBeGreaterThan(0);
    expect(r.endedAt - caseStartedAt, r.out).toBeLessThan(20_000);
    expect(r.out).not.toMatch(/秒没有应答|20 秒内|30 秒内/);
    expect(rowBlock(r.out, 'shell-stop'), r.out).toMatch(/^FAIL\s+shell-stop\s+引擎在这个用例进行中退出（SIGKILL）\n\s+\S/);
    expect(row(r.out, '清理'), r.out).toMatch(/^FAIL\s+清理\s+引擎在冒烟过程中自己退出了（SIGKILL）/);
    if (existsSync('/proc/self/cmdline')) {
      // 命令行里带着假 bin 目录的进程（假驱动、假 ping）一个也不剩；给 3 秒余量
      const bin = env.PATH!.split(delimiter)[0];
      const survivors = (): string[] => readdirSync('/proc').filter(n => /^\d+$/.test(n)).filter(n => {
        try { return readFileSync(`/proc/${n}/cmdline`, 'utf8').includes(bin); } catch { return false; }
      });
      for (let i = 0; survivors().length > 0 && i < 30; i++) await new Promise(res => setTimeout(res, 100));
      expect(survivors(), r.out).toEqual([]);
    }
  }, 90_000);

  /** 进程还在不在：kill 0 只探不发；EPERM 说明在，只是不归我们管。 */
  const pidAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  };

  /** 信号那几例的 DEEPSEEK_API_KEY：取清理行的最后半句。信号那条路打的清理行也得先脱敏（--mock 不用环境里的 key，它只进脱敏与
   *  明文扫描的名单；这几个字不在临时目录里，清理照样 PASS），打出来的该是 [已隐藏]。 */
  const CLEAN_TAIL = '临时目录里没有明文 key';

  /** 起 --mock，一到「── anthropic ──」（引擎起来了、用例正在跑）就给脚本发 first；给了 again 的话，脚本一说「收到 first」就再发它
   *  （清理途中又按了一次）。holdEngine：发 first 之前先 SIGSTOP 引擎——停引擎那一步（kill 之后等 exit）就卡住，
   *  again 一定落在清理途中，不会因为机器忙、清理早早做完而落空；脚本一说「又收到 again」就 SIGCONT 放行。
   *  file：换成调 runSmoke 的小驱动（同样的参数与环境）。tap：每块输出（stdout、stderr 都算）到达时在上面这些之后再调一次。
   *  红的时候脚本被信号当场打死，引擎与临时目录都会留下：先登记收拾，断言失败也不在测试机上留孤儿（SIGKILL 对停住的进程照样有效）。 */
  async function interruptRun(first: NodeJS.Signals, again?: NodeJS.Signals, opts: { holdEngine?: boolean; file?: string; tap?: (all: string, child: ChildProcess) => void } = {}): Promise<Awaited<ReturnType<typeof runScript>> & { sent: number; root?: string; enginePid: number }> {
    let sent = 0;
    let held = 0;
    const signalAt = (all: string, child: ChildProcess): void => {
      if (sent === 0 && all.includes('── anthropic ──')) {
        if (opts.holdEngine) { held = Number(/引擎：pid (\d+)/.exec(all)?.[1]); process.kill(held, 'SIGSTOP'); }
        sent = 1;
        child.kill(first);
        return;
      }
      if (again !== undefined && sent === 1 && all.includes(`收到 ${first}：`)) { sent = 2; child.kill(again); return; }
      // 「又收到」说明第二个信号是在清理途中处理的；这时清理早已发出 kill（它在头一个信号的同一轮里就发了），放行引擎让它退出
      if (held > 0 && sent === 2 && all.includes(`又收到 ${again}：`)) { process.kill(held, 'SIGCONT'); held = 0; }
    };
    const r = await runScript(['--mock', '--memory-vault'], { ...process.env, DEEPSEEK_API_KEY: CLEAN_TAIL }, (all, child) => {
      signalAt(all, child);
      opts.tap?.(all, child);
    }, 45_000, opts.file);
    const root = tempRootOf(r.out);
    const enginePid = Number(/引擎：pid (\d+)/.exec(r.out)?.[1]);
    cleanups.push(() => {
      if (Number.isInteger(enginePid) && pidAlive(enginePid)) process.kill(enginePid, 'SIGKILL');
      if (root) rmSync(root, { recursive: true, force: true });
    });
    return { ...r, sent, root, enginePid };
  }

  /** 打断之后该有的样子：收到信号之后不再开新的用例；清理那一行 PASS（引擎已停、临时目录已删），行尾那半句照样脱敏；
   *  临时目录真没了，「引擎：pid N」那个进程真不在了；不打结果表（被打断的一轮没有完整结论，被打断的用例只会是一行误导人的 FAIL）。 */
  async function expectCleanedUp(r: { out: string; root?: string; enginePid: number }): Promise<void> {
    // 清理正趁引擎还活着取进程表（Windows 上要起 PowerShell，一两秒）：这时开的用例会用真 key 调接口、新建 provider，
    // shell-stop 还会起出不在名单上的 ping
    const at = r.out.search(/^收到 SIG[A-Z]+：/m);
    expect(at, r.out).toBeGreaterThanOrEqual(0);
    expect(r.out.slice(at), `收到信号之后又开了新的用例\n${r.out}`).not.toMatch(/^── \S+ ──$/m);
    expect(r.out).toMatch(/^PASS\s+清理\s+引擎已停；临时目录已删；\[已隐藏\]$/m);
    expect(r.out, '信号那条路打的清理行没有脱敏').not.toContain(CLEAN_TAIL);
    expect(r.out, '被打断的一轮不该再打结果表').not.toMatch(/^汇总：/m);
    expect(r.root, r.out).toBeTruthy();
    expect(existsSync(r.root!), `临时目录没删：${r.root}\n${r.out}`).toBe(false);
    expect(Number.isInteger(r.enginePid), r.out).toBe(true);
    for (let i = 0; pidAlive(r.enginePid) && i < 30; i++) await new Promise(res => setTimeout(res, 100));
    expect(pidAlive(r.enginePid), `引擎 pid ${r.enginePid} 还在：脚本没停它就退了\n${r.out}`).toBe(false);
  }

  // 用例进行中被打断（Ctrl+C、kill、关掉终端；Windows 上关控制台窗口也是 SIGHUP）：照样停引擎、删临时目录（Windows 上还有凭据库里
  // 本次写的条目），再以 128+信号号退出。Windows 上 child.kill 发什么都是 TerminateProcess，测不到处理器：
  // 那里要挂的信号（多一个 Ctrl+Break）由上面 cleanupSignals 一例核对
  for (const [sig, code] of [['SIGINT', 130], ['SIGHUP', 129], ['SIGTERM', 143]] as const) {
    it.skipIf(process.platform === 'win32')(`用例进行中收到 ${sig}：先清理（引擎已停、临时目录已删）再以 ${code} 退出，不是被信号当场打死`, async () => {
      const r = await interruptRun(sig);
      expect(r.sent, r.out).toBe(1);
      expect({ code: r.code, signal: r.signal }, r.out).toEqual({ code, signal: null });
      expect(r.out).toContain(`收到 ${sig}：`);
      await expectCleanedUp(r);
    }, 90_000);
  }

  it.skipIf(process.platform === 'win32')('清理途中又按一次 Ctrl+C：不被当场打死（那样本次写进凭据库的条目就留下了），清完照样以 130 退出', async () => {
    // 引擎先停住：清理卡在「等引擎退出」，第二个 Ctrl+C 一定落在清理途中（不然机器忙时它可能落在脚本退出之后，这一例就空转了）
    const r = await interruptRun('SIGINT', 'SIGINT', { holdEngine: true });
    expect(r.sent, r.out).toBe(2);
    expect(r.out, '第二个 Ctrl+C 没有在清理途中被接住').toContain('又收到 SIGINT：');
    expect({ code: r.code, signal: r.signal }, r.out).toEqual({ code: 130, signal: null });
    await expectCleanedUp(r);
  }, 90_000);

  it.skipIf(process.platform === 'win32')('停引擎前那次取进程表慢（Windows 上起 PowerShell 要一两秒）时，打断之后在跑的用例也不再发新回合、不开下一个用例', async () => {
    // Linux 上读 /proc 是一瞬间，清理紧接着就断开连接，在跑的用例想发也发不出去；Windows 上取进程表要起 PowerShell，
    // 这一两秒里连接还开着（引擎与它的子树得留给取进程表）。进程内调 runSmoke 的话，收到信号时它会 process.exit 掉测试进程：
    // 写一个小驱动照 main 的样子调它，只把清理头一次（停引擎前那次）取进程表放慢——至少 3 秒，打断之后又正常跑完两轮就不必再等
    // （没拒绝新请求时，3 秒够在跑的用例再跑好几轮）
    const driver = join(tempDir('dm-smoke-slowsnap-'), 'drive.mjs');
    writeFileSync(driver, [
      "import { createRequire } from 'node:module';",
      `const m = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`,
      `const electronBin = createRequire(${JSON.stringify(SCRIPT)})('electron');`,
      'const printed = [];',
      'const print = (line) => { printed.push(line); console.log(line); };',
      'let first = true;',
      'async function snapshot() {',
      '  if (first) {',
      '    first = false;',
      '    const normalSince = () => printed.slice(printed.findIndex((l) => /^收到 SIG[A-Z]+：/.test(l))).filter((l) => /轮：正常结束/.test(l)).length;',
      '    const t0 = Date.now();',
      '    while (Date.now() - t0 < 3_000 && normalSince() < 2) await new Promise((r) => setTimeout(r, 20));',
      '    console.log(`【驱动】停引擎前取进程表放慢了 ${Date.now() - t0} ms`);',
      '  }',
      '  return m.takeProcessSnapshot(process.platform);',
      '}',
      'await m.runSmoke({ mock: true, memoryVault: true, electronBin, print, procs: { snapshot } });',
      '',
    ].join('\n'));
    const r = await interruptRun('SIGINT', undefined, { file: driver });
    expect(r.sent, r.out).toBe(1);
    expect({ code: r.code, signal: r.signal }, r.out).toEqual({ code: 130, signal: null });
    // 慢的那次取进程表真用上了（不然清理紧接着断开连接，下面几句怎么都成立，这一例就空转了）
    expect(r.out, `小驱动放慢的取进程表没用上：runSmoke 没把 procs 交给清理？\n${r.out}`).toMatch(/^【驱动】停引擎前取进程表放慢了 \d+ ms$/m);
    // 打断前已经发出的那一轮可以照常跑完；之后的 chat.prompt（连同建会话、放行权限卡）当场被拒，不再发给引擎
    const after = r.out.slice(r.out.indexOf('收到 SIGINT：'));
    expect((after.match(/轮：正常结束/g) ?? []).length, `打断之后在跑的用例又发了新回合\n${r.out}`).toBeLessThanOrEqual(1);
    await expectCleanedUp(r);
  }, 90_000);

  it.skipIf(process.platform === 'win32')('信号那条路等清理那一行真写出去再退：POSIX 上 stdout 接管道是异步写，读的一端慢时紧跟着 process.exit 会丢掉排队的尾巴', async () => {
    // Windows 上 Node 把 stdout、stderr 的管道设成同步写（Node 文档 process 一节「A note on process I/O」），截不掉；POSIX 上管道一满，
    // 写不进去的在进程里排队，process.exit 就把它们丢了——排在最后的正是清理的结论。小驱动照 main 的样子调 runSmoke，在「收到 SIG…」
    // 之后多打 3000 行、约 670KB 垫字（像输出多、读的一端又慢，比如 | tee、| less）；测试一看到「收到 SIGINT：」就停读 stdout，等驱动在 stderr 上说
    // 清理那一行已经交给 stdout，再过 0.2 秒才接着读。不等输出写完就退的话，这时脚本早已退出，清理那一行连同垫字的尾巴都没了
    const PAD = 3000;
    const MARK = '【驱动】清理那一行已交给 stdout';
    const driver = join(tempDir('dm-smoke-flush-'), 'drive.mjs');
    writeFileSync(driver, [
      "import { createRequire } from 'node:module';",
      `const m = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`,
      `const electronBin = createRequire(${JSON.stringify(SCRIPT)})('electron');`,
      "const pad = 'x'.repeat(200);",
      'const print = (line) => {',
      '  console.log(line);',
      `  if (/^收到 SIG[A-Z]+：/.test(line)) for (let i = 0; i < ${PAD}; i++) console.log(\`【驱动】垫字 \${i} \${pad}\`);`,
      `  if (/^(PASS|FAIL)\\s+清理\\s/.test(line)) process.stderr.write(${JSON.stringify(`${MARK}\n`)});`,
      '};',
      'await m.runSmoke({ mock: true, memoryVault: true, electronBin, print });',
      '',
    ].join('\n'));
    let paused = false;
    let markSeen = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const r = await interruptRun('SIGINT', undefined, {
      file: driver,
      tap: (all, child) => {
        if (!paused && all.includes('收到 SIGINT：')) {
          paused = true;
          child.stdout!.pause();
          // 兜底：驱动一直不说话也不能永远停着读（那样脚本 2 秒后自己退，这一例照样红在垫字没收全）
          timers.push(setTimeout(() => child.stdout!.resume(), 5_000));
        }
        // 脚本先退的话，Node 在子进程退出时会自己把 stdout 接着读完（child_process 的 flushStdio），读到的只剩已经进了管道的那一截
        if (paused && !markSeen && all.includes(MARK)) { markSeen = true; timers.push(setTimeout(() => child.stdout!.resume(), 200)); }
      },
    });
    for (const t of timers) clearTimeout(t);
    // 断言只看 stdout（stderr 上那一行插在 stdout 两块之间，不一定落在行边界上）；垫字太长，出错时不整段打印
    const shown = r.stdout.split('\n').filter(l => !l.startsWith('【驱动】垫字')).join('\n');
    expect(r.sent, shown).toBe(1);
    expect(paused, `没有在「收到 SIGINT：」时停读，这一例没测到读的一端慢\n${shown}`).toBe(true);
    expect(markSeen, `驱动没说清理那一行已交给 stdout\n${r.out.split('\n').filter(l => !l.startsWith('【驱动】垫字')).join('\n')}`).toBe(true);
    expect({ code: r.code, signal: r.signal }, shown).toEqual({ code: 130, signal: null });
    expect((r.stdout.match(/^【驱动】垫字 \d+ x+$/gm) ?? []).length, `垫字没收全：排队的输出被丢了\n${shown}`).toBe(PAD);
    await expectCleanedUp({ ...r, out: shown });
  }, 90_000);

  /** 命令行里带着 dir 的进程号（假 bin 目录里的假驱动、假 ping；僵尸的命令行是空的，不算）。 */
  const procsWith = (dir: string): number[] => readdirSync('/proc').filter(n => /^\d+$/.test(n)).filter(n => {
    try { return readFileSync(`/proc/${n}/cmdline`, 'utf8').includes(dir); } catch { return false; }
  }).map(Number);
  /** SIGTERM 是否挂在这个进程上没处理（进程被 SIGSTOP 停住时，发给它的信号都挂着，见 /proc/<pid>/status 的 SigPnd、ShdPnd）。 */
  const termPending = (pid: number): boolean => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const mask = ['SigPnd', 'ShdPnd'].reduce((acc, f) => acc | BigInt(`0x${new RegExp(`^${f}:\\s*([0-9a-f]+)$`, 'm').exec(status)?.[1] ?? '0'}`), 0n);
      return (mask & (1n << 14n)) !== 0n; // SIGTERM 是 15 号，掩码第 14 位
    } catch { return false; }
  };

  it.skipIf(process.platform === 'win32' || !existsSync('/proc/self/status'))('shell-stop 里 ping 已经起来时按 Ctrl+C：清理停引擎前先记下它的整棵子树，停完把没跟着退的驱动与 ping 一并结束，写明结束了几个，再以 130 退出', async () => {
    // 假 ping 像真 ping 一样一直跑、不管父进程还在不在（最多两分钟，红的时候也不会留孤儿太久）。它一起来就先停住引擎、再给脚本发 SIGINT：
    // 引擎停住就处理不了 chat.cancel，驱动与 ping 在清理记下子树那一刻一定还挂在引擎名下（不然 shell-stop 自己的 chat.cancel
    // 可能抢先杀掉驱动，ping 被过继出去，这一例就时红时绿）；脚本是引擎的父进程，进程号取引擎 /proc/<pid>/stat 里最后一个「)」之后的第 2 段
    const env = fakeShellEnv([
      'kill -STOP "$SMOKE_ENGINE_PID"',
      'script=$(sed -e \'s/^.*) [^ ]* \\([0-9][0-9]*\\) .*$/\\1/\' "/proc/$SMOKE_ENGINE_PID/stat")',
      'kill -INT "$script"',
      'n=0',
      'while [ "$n" -lt 1200 ]; do sleep 0.1; n=$((n + 1)); done',
    ]);
    const bin = env.PATH!.split(delimiter)[0];
    let enginePid = 0;
    let released = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    cleanups.push(() => {
      clearInterval(poll);
      for (const pid of procsWith(bin)) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ } }
      if (enginePid > 0 && pidAlive(enginePid)) process.kill(enginePid, 'SIGKILL');
    });
    const r = await runScript(['--mock', '--memory-vault', '--only', 'shell-stop'], env, (all) => {
      if (enginePid === 0) enginePid = Number(/引擎：pid (\d+)/.exec(all)?.[1] ?? 0);
      if (poll || !all.includes('收到 SIGINT：')) return;
      // 清理对停住的引擎发了 kill（SIGTERM 挂着）才放行：这时子树早已记下，引擎一恢复就被 SIGTERM 结束，处理不了任何请求
      poll = setInterval(() => {
        if (released || !termPending(enginePid)) return;
        released = true;
        clearInterval(poll);
        process.kill(enginePid, 'SIGCONT');
      }, 20);
    }, 45_000);
    clearInterval(poll);
    const root = tempRootOf(r.out);
    cleanups.push(() => { if (root) rmSync(root, { recursive: true, force: true }); });
    expect(released, r.out).toBe(true);
    expect({ code: r.code, signal: r.signal }, r.out).toEqual({ code: 130, signal: null });
    // 驱动（假 powershell.exe）与 ping 都没跟着引擎退：清理把它们结束掉，清理行写明几个、是谁
    const cleanLine = r.out.split(/\r?\n/).find(l => /^(PASS|FAIL)\s+清理\s/.test(l)) ?? '';
    expect(cleanLine, r.out).toMatch(/^PASS\s+清理\s+引擎已停；结束了引擎名下没随它退出的 \d+ 个进程（/);
    expect(cleanLine, r.out).toMatch(/powershell\.exe pid \d+/);
    expect(cleanLine, r.out).toMatch(/ping pid \d+/);
    expect(r.out, '被打断的一轮不该再打结果表').not.toMatch(/^汇总：/m);
    for (let i = 0; procsWith(bin).length > 0 && i < 30; i++) await new Promise(res => setTimeout(res, 100));
    expect(procsWith(bin), `命令行带假 bin 的进程还在\n${r.out}`).toEqual([]);
    expect(existsSync(root!), `临时目录没删：${root}`).toBe(false);
    expect(pidAlive(enginePid), `引擎 pid ${enginePid} 还在`).toBe(false);
  }, 90_000);
});
