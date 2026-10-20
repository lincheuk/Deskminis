/**
 * F04 调度测试的公共 fixture（不是测试文件，vitest 只收 *.test.ts）。
 *
 * 对 F04 的新模块（tools/resource-locks、tools/scheduler）这里只用 import type：
 * 循环级（tool-scheduler-loop）与 minisd 级（tool-scheduler-minisd）的「先红」用例要在还没有这两个模块的基线上跑起来，
 * 红在行为上，而不是红在缺模块上；实现之后同一份用例文本转绿。
 *
 * 约定：
 * - 顺序断言一律看工具侧的 Trace（进门 / 请求审批 / 审批返回 / 副作用 / 出门）、真实文件内容和网关收到的请求序列，
 *   不看调度器自己发的事件——只发事件不真排队的实现照样会红。
 * - 受控延迟一律用 Gate 与挂起的权限请求，由测试决定谁先放行；不靠 sleep 排顺序。
 * - 等待一律等事件（Trace.until、ManualGateway.untilRequests、untilWaiting），带上限，悬挂即失败。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import type { AgentStreamEvent } from '../src/shared/types';
import type { AgentProvider } from '../src/minisd/providers/types';
import type { LoopEvent } from '../src/minisd/agent/loop';
import type {
  PermissionDecision, PermissionGateway, PermissionOutcome, PermissionRequest, ResourceClaim, ToolContext, ToolExecutor, ToolOutcome,
  ToolPlanContext, ToolScheduling,
} from '../src/minisd/tools/types';
import type { LockSnapshot, ResourceLockManager } from '../src/minisd/tools/resource-locks';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import { MinisPaths } from '../src/minisd/paths';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { McpManager, type McpClientLike } from '../src/minisd/mcp/manager';
import { McpServersStore } from '../src/minisd/mcp/config';
import type { McpNotification, McpToolInfo } from '../src/minisd/mcp/stdio';

// ---------- 等待与时限 ----------

/** 让出事件循环若干轮（微任务清空 + 宏任务各一轮）。不是用来排顺序的：
 *  正确的实现下结果与让不让无关；它只保证「不排队的实现」此刻已经把不该跑的调用跑完了，断言红得确定。 */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>(r => setImmediate(r));
}

/** 悬挂即失败：抓死锁与没放锁。 */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`超过 ${ms}ms 仍未完成: ${what}`)), ms); });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

/** 轮询到条件成立（上限 timeoutMs）。只用于「等某件事发生」，条件成立立即返回。 */
export async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// ---------- Trace / Gate / Rendezvous ----------

/** 工具侧的执行记录。顺序断言以它为准。 */
export class Trace {
  readonly lines: string[] = [];
  private waiters: { want: string; resolve: () => void }[] = [];

  log(s: string): void {
    this.lines.push(s);
    for (const w of this.waiters.filter(x => x.want === s)) w.resolve();
    this.waiters = this.waiters.filter(x => x.want !== s);
  }
  has(s: string): boolean { return this.lines.includes(s); }
  at(s: string): number { return this.lines.indexOf(s); }
  /** 等某一笔出现；已经有了立即返回。到点没出现就抛（附当前记录，方便看卡在哪）。 */
  until(s: string, timeoutMs = 2000): Promise<void> {
    if (this.has(s)) return Promise.resolve();
    const hit = new Promise<void>(resolve => { this.waiters.push({ want: s, resolve }); });
    return withDeadline(hit, timeoutMs, `trace 出现 ${s}（当前: ${this.lines.join(', ') || '空'}）`);
  }
}

/** 受控延迟：工具进门后停在这里，直到测试 open()。 */
export class Gate {
  readonly opened: Promise<void>;
  isOpen = false;
  private release!: () => void;
  constructor() { this.opened = new Promise<void>(r => { this.release = r; }); }
  open(): void { this.isOpen = true; this.release(); }
}

/** 会合点：到场者一直等到同时在场数达到 n（'met'），或超时（'timeout'）。全串行的实现永远凑不齐。
 *  凑齐之后再到场的直接通过；maxActive 记下同时在场的最大数（并发上限没生效时会超过 n）。 */
export class Rendezvous {
  active = 0;
  maxActive = 0;
  met = false;
  private waiters: ((r: 'met' | 'timeout') => void)[] = [];
  constructor(readonly n: number, readonly timeoutMs = 2000) {}

  arrive(): Promise<'met' | 'timeout'> {
    this.active++;
    if (this.active > this.maxActive) this.maxActive = this.active;
    if (!this.met && this.active >= this.n) {
      this.met = true;
      for (const w of this.waiters.splice(0)) w('met');
    }
    if (this.met) return Promise.resolve('met');
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== done);
        resolve('timeout');
      }, this.timeoutMs);
      const done = (r: 'met' | 'timeout'): void => { clearTimeout(timer); resolve(r); };
      this.waiters.push(done);
    });
  }
  leave(): void { this.active--; }
}

// ---------- 受控工具 ----------

const CANCELLED: ToolOutcome = { output: '[已取消]', success: false };
type Input = Record<string, unknown>;

/** fixture 工具的路径解析：/var/minis/* 与相对路径走 resolveGuestPath（任何平台都可用），宿主绝对路径原样用。
 *  resources() 与 execute 都调它——与真实工具「两处同一个解析表达式」的约定一致。 */
export function hostPath(p: unknown, ctx: Pick<ToolContext, 'sessionId' | 'paths'>): string {
  const s = String(p);
  if (!s.startsWith('/var/minis/') && isAbsolute(s)) return s;
  return ctx.paths.resolveGuestPath(ctx.sessionId, s);
}

export interface GatedToolOpts {
  name: string;
  /** trace 里的前缀：缺省取入参的 tag，再缺省取工具名。 */
  tagOf?: (input: Input) => string;
  /** 省略 = 未声明工具（调度器按 barrier 处理）。 */
  scheduling?: ToolScheduling;
  trace: Trace;
  /** 进门（以及审批）之后、副作用之前等的闸。 */
  gateOf?: (input: Input) => Gate | undefined;
  /** 进门之后先到会合点。 */
  rendezvous?: Rendezvous;
  /** 真实副作用（读写文件、追加计数文件）；返回值作为工具输出。 */
  effect?: (input: Input, ctx: ToolContext) => string | void | Promise<string | void>;
  /** 给出权限请求 = 这个工具先经 ctx.permissions.check 过闸（与真实工具同序：闸后先看取消、再看拒绝）。 */
  ask?: (input: Input, ctx: ToolContext) => PermissionRequest;
  /** false = 不理会取消的工具（闸没开就一直停着）。缺省 true。 */
  honorAbort?: boolean;
  fail?: 'throw' | 'outcome';
  required?: string[];
}

function abortedOf(signal: AbortSignal): { promise: Promise<void>; dispose: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, dispose: () => { if (onAbort) signal.removeEventListener('abort', onAbort); } };
}

/** 每一步都往 trace 记一笔的工具：`<tag>:enter` → `<tag>:ask` → `<tag>:ret` → `<tag>:effect` → `<tag>:exit`。 */
export function gatedTool(o: GatedToolOpts): ToolExecutor {
  const honor = o.honorAbort !== false;
  const tagOf = o.tagOf ?? ((input: Input) => String(input.tag ?? o.name));
  const tool: ToolExecutor = {
    definition: {
      name: o.name, description: `F04 fixture: ${o.name}`,
      parameters: { tool_title: { type: 'string', description: 't' } },
      required: o.required ?? [],
    },
    async execute(input, ctx) {
      const tag = tagOf(input);
      o.trace.log(`${tag}:enter`);
      let arrived = false;
      try {
        if (honor && ctx.signal?.aborted) return CANCELLED;
        if (o.ask) {
          o.trace.log(`${tag}:ask`);
          const d = await ctx.permissions.check(o.ask(input, ctx));
          o.trace.log(`${tag}:ret`);
          if (honor && ctx.signal?.aborted) return CANCELLED;
          if (d === 'deny') return { output: `${tag} 被拒绝`, success: false };
        }
        if (o.rendezvous) { arrived = true; await o.rendezvous.arrive(); }
        const gate = o.gateOf?.(input);
        if (gate) {
          if (honor && ctx.signal) {
            const ab = abortedOf(ctx.signal);
            try { await Promise.race([gate.opened, ab.promise]); } finally { ab.dispose(); }
            if (ctx.signal.aborted) return CANCELLED;
          } else {
            await gate.opened;
          }
        }
        if (o.fail === 'throw') throw new Error(`${tag} 故障注入`);
        if (o.fail === 'outcome') return { output: `${tag} 失败（故障注入）`, success: false };
        o.trace.log(`${tag}:effect`);
        const out = await o.effect?.(input, ctx);
        return { output: typeof out === 'string' ? out : `${tag} ok`, success: true };
      } finally {
        if (arrived) o.rendezvous!.leave();
        o.trace.log(`${tag}:exit`);
      }
    },
  };
  if (o.scheduling) tool.scheduling = o.scheduling;
  return tool;
}

const pathClaim = (mode: 'read' | 'write', key = 'path') =>
  (input: Input, ctx: ToolPlanContext): ResourceClaim[] => [{ kind: 'path', mode, path: hostPath(input[key], ctx) }];

type Preset = Omit<GatedToolOpts, 'name' | 'scheduling' | 'effect'> & { name?: string };

/** 只读、并发安全，读 input.path（path 读）。输出文件内容。 */
export function fxRead(o: Preset): ToolExecutor {
  return gatedTool({
    name: 'fx_read', ...o,
    scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none', resources: pathClaim('read') },
    effect: (input, ctx) => readFileSync(hostPath(input.path, ctx), 'utf8'),
  });
}

/** 只读、并发安全、不碰任何资源（相当于 web_fetch 那一类）。 */
export function fxPure(o: Preset): ToolExecutor {
  return gatedTool({ name: 'fx_pure', ...o, scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'network' } });
}

/** 写 input.path = input.content（path 写）。 */
export function fxWrite(o: Preset): ToolExecutor {
  return gatedTool({
    name: 'fx_write', ...o,
    scheduling: { readOnly: false, concurrencySafe: true, sideEffects: 'local-files', resources: pathClaim('write') },
    effect: (input, ctx) => {
      const abs = hostPath(input.path, ctx);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(input.content), 'utf8');
    },
  });
}

/** 交换 input.a 与 input.b 两个文件的内容（两条 path 写）；读与写之间隔一次 await，没有互斥就会交错。 */
export function fxSwap(o: Preset): ToolExecutor {
  return gatedTool({
    name: 'fx_swap', ...o,
    scheduling: {
      readOnly: false, concurrencySafe: true, sideEffects: 'local-files',
      resources: (input, ctx) => [...pathClaim('write', 'a')(input, ctx), ...pathClaim('write', 'b')(input, ctx)],
    },
    effect: async (input, ctx) => {
      const a = hostPath(input.a, ctx); const b = hostPath(input.b, ctx);
      const va = readFileSync(a, 'utf8'); const vb = readFileSync(b, 'utf8');
      await new Promise<void>(r => setImmediate(r));
      writeFileSync(a, vb, 'utf8'); writeFileSync(b, va, 'utf8');
    },
  });
}

/** 未声明工具（没有 scheduling）：副作用是往 input.counter 追加一行，文件存在即说明它执行过。 */
export function fxUnknown(o: Preset): ToolExecutor {
  return gatedTool({
    name: 'fx_unknown', ...o,
    effect: (input, ctx) => {
      if (input.counter === undefined) return;
      const abs = hostPath(input.counter, ctx);
      mkdirSync(dirname(abs), { recursive: true });
      appendFileSync(abs, 'x\n', 'utf8');
    },
  });
}

/** 目录读（path 读，天然是整棵子树）：输出目录下所有文件的相对路径。 */
export function fxTreeRead(o: Preset): ToolExecutor {
  const walk = (dir: string, rel: string, out: string[]): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name); const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r, out); else out.push(r);
    }
  };
  return gatedTool({
    name: 'fx_tree', ...o,
    scheduling: { readOnly: true, concurrencySafe: true, sideEffects: 'none', resources: pathClaim('read') },
    effect: (input, ctx) => { const out: string[] = []; walk(hostPath(input.path, ctx), '', out); return out.join('\n'); },
  });
}

// ---------- 权限网关 ----------

type Rule = (req: PermissionRequest) => 'hold' | PermissionDecision;

/** 可手动放行的权限网关：check() 记下请求，按规则挂起（等测试放行）或立即返回指定决议。
 *  它是真实工具的受控延迟来源：/var/minis/skills/... 写要问、读免审；/var/minis/mcp-servers/... 读写都要问。 */
export class ManualGateway implements PermissionGateway {
  /** 累计收到的全部请求，按到达顺序。 */
  readonly requests: PermissionRequest[] = [];
  private pending: { req: PermissionRequest; resolve: (d: PermissionDecision) => void }[] = [];
  private waiters: { n: number; resolve: () => void }[] = [];
  constructor(private rule: Rule = () => 'hold') {}

  check(req: PermissionRequest): Promise<PermissionDecision> {
    this.requests.push(req);
    const r = this.rule(req);
    const answer = r === 'hold'
      ? new Promise<PermissionDecision>(resolve => { this.pending.push({ req, resolve }); })
      : Promise.resolve(r);
    for (const w of this.waiters.filter(x => this.requests.length >= x.n)) w.resolve();
    this.waiters = this.waiters.filter(x => this.requests.length < x.n);
    return answer;
  }
  /** F13：带原因的结果。这个替身模拟的是「用户在卡上点了允许 / 拒绝」，所以把自己的二值答复映成 user-once / user-denied。
   *  只有 check 的网关会被读成「没有说明原因」——断言「被用户拒绝」的用例（S19、S17 的拒绝分支）就说不出来了。 */
  async decide(req: PermissionRequest): Promise<PermissionOutcome> {
    return (await this.check(req)) === 'allow' ? { decision: 'allow', via: 'user-once' } : { decision: 'deny', reason: 'user-denied' };
  }
  hasBridgeGrant(): boolean { return false; }

  /** 正挂着等放行的请求。 */
  get held(): PermissionRequest[] { return this.pending.map(p => p.req); }
  /** 等到累计收到 n 个请求。 */
  untilRequests(n: number, timeoutMs = 3000): Promise<void> {
    if (this.requests.length >= n) return Promise.resolve();
    const hit = new Promise<void>(resolve => { this.waiters.push({ n, resolve }); });
    return withDeadline(hit, timeoutMs, `网关收到第 ${n} 个权限请求（当前 ${this.requests.length} 个）`);
  }
  /** 了结第一个匹配的挂起请求；没有可了结的就抛（测试写错了顺序）。 */
  answer(decision: PermissionDecision, match: (req: PermissionRequest) => boolean = () => true): void {
    const i = this.pending.findIndex(p => match(p.req));
    if (i < 0) throw new Error('没有匹配的挂起权限请求');
    const [p] = this.pending.splice(i, 1);
    p.resolve(decision);
  }
  allow(match?: (req: PermissionRequest) => boolean): void { this.answer('allow', match); }
  deny(match?: (req: PermissionRequest) => boolean): void { this.answer('deny', match); }
}

export const allowAll: PermissionGateway = { async check() { return 'allow'; }, hasBridgeGrant: () => false };

// ---------- 循环级：脚本 provider 与环境 ----------

export interface ScriptedCall { id: string; name: string; input: Record<string, unknown> | string }

/** 一轮吐多个工具调用。 */
export function toolTurn(calls: ScriptedCall[]): AgentStreamEvent[] {
  return [
    ...calls.map(c => ({
      kind: 'toolCallComplete' as const, toolUseId: c.id, name: c.name,
      input: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
    })),
    { kind: 'done' as const, stopReason: 'toolUse' as const },
  ];
}

/** 脚本化 provider：按调用次数吐事件序列；脚本用完后吐一句文本收尾。 */
export class ScriptProvider implements AgentProvider {
  readonly name = 'f04-script'; readonly modelId = 'fake';
  calls = 0;
  constructor(private turns: AgentStreamEvent[][]) {}
  async *streamAgentMessage(): AsyncIterable<AgentStreamEvent> {
    const turn = this.turns[this.calls++] ?? [{ kind: 'textDelta', text: '完成' }, { kind: 'done', stopReason: 'endTurn' }];
    for (const e of turn) yield e;
  }
}

export async function collect(gen: AsyncGenerator<LoopEvent>, into: LoopEvent[] = []): Promise<LoopEvent[]> {
  for await (const e of gen) into.push(e);
  return into;
}

/** 循环级用例的环境：自己的数据根、自己的库。会话 id 由库生成（UUID，天然不重复）——
 *  循环级用例共用进程级缺省调度器，靠「数据根与会话 id 互不相同」隔离，不能复用。 */
export function loopEnv(label: string): { root: string; paths: MinisPaths; store: ChatStore; tools: ToolRegistry; newSession(): string } {
  const root = mkdtempSync(join(tmpdir(), `dm-f04-${label}-`));
  const paths = new MinisPaths(root);
  const store = new ChatStore(openDb(':memory:'));
  const tools = new ToolRegistry();
  return {
    root, paths, store, tools,
    newSession(): string {
      const s = store.createSession();
      paths.ensureSessionDirs(s.id);
      store.appendMessage({ id: store.newId(), sessionId: s.id, role: 'user', parts: [{ type: 'text', value: '开始' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
      return s.id;
    },
  };
}

/** 按 toolUseId 取 toolEnd 事件。 */
export function toolEndOf(events: LoopEvent[], toolUseId: string): Extract<LoopEvent, { kind: 'toolEnd' }> | undefined {
  return events.find((e): e is Extract<LoopEvent, { kind: 'toolEnd' }> => e.kind === 'toolEnd' && e.toolUseId === toolUseId);
}

// ---------- 锁表观察 ----------

type Waiting = LockSnapshot['waiting'][number];

/** 等到锁表里出现 label 含 needle 的等待者（上限 2 秒）。用「确实在等」的正面断言代替「睡一会儿看它没跑」。 */
export async function untilWaiting(locks: ResourceLockManager, needle: string, timeoutMs = 2000): Promise<Waiting> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = locks.snapshot().waiting.find(w => w.label.includes(needle));
    if (hit) return hit;
    if (Date.now() > deadline) {
      const snap = locks.snapshot();
      throw new Error(`锁表里没有等到 ${needle}（waiting: ${snap.waiting.map(w => w.label).join(', ') || '空'}；held: ${snap.held.map(h => h.label).join(', ') || '空'}）`);
    }
    await new Promise<void>(r => setImmediate(r));
  }
}

// ---------- 真实 shell / MCP 的假底座 ----------

export interface FakeShellCommand { command: string; replied: boolean; reply(output?: string, exitCode?: number): void }

/** 假 PowerShell 驱动（经 ProcOpts.spawnImpl 注入真实的 ShellManager）：记下每次 spawn 的 cwd 与收到的每条命令；
 *  命令挂着不答复，直到测试调 reply()——真实 PersistentShell 靠哨兵行认结束。 */
export function fakeShellSpawn(): {
  spawns: { cwd: string }[]; commands: FakeShellCommand[]; spawnImpl: typeof spawn;
  untilCommands(n: number, timeoutMs?: number): Promise<void>;
} {
  const spawns: { cwd: string }[] = [];
  const commands: FakeShellCommand[] = [];
  let waiters: { n: number; resolve: () => void }[] = [];
  const spawnImpl = ((_cmd: string, _args: string[], opts?: { cwd?: string }) => {
    spawns.push({ cwd: String(opts?.cwd) });
    const ch = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough(); const stdout = new PassThrough();
    Object.assign(ch, { pid: 4242, exitCode: null, signalCode: null, killed: false, stdin, stdout, stderr: new PassThrough() });
    ch.kill = () => true;
    let buf = '';
    stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const sp = line.indexOf(' ');
        const marker = line.slice(0, sp);
        const entry: FakeShellCommand = {
          command: Buffer.from(line.slice(sp + 1), 'base64').toString('utf8'), replied: false,
          reply(output = '', exitCode = 0) { entry.replied = true; stdout.write(`${output}\n__MINIS_DONE_${marker}_EXIT_${exitCode}__\n`); },
        };
        commands.push(entry);
        for (const w of waiters.filter(x => commands.length >= x.n)) w.resolve();
        waiters = waiters.filter(x => commands.length < x.n);
      }
    });
    queueMicrotask(() => ch.emit('spawn'));
    return ch;
  }) as unknown as typeof spawn;
  return {
    spawns, commands, spawnImpl,
    /** 等到驱动累计收到 n 条命令。 */
    untilCommands(n: number, timeoutMs = 3000): Promise<void> {
      if (commands.length >= n) return Promise.resolve();
      const hit = new Promise<void>(resolve => { waiters.push({ n, resolve }); });
      return withDeadline(hit, timeoutMs, `假 shell 收到第 ${n} 条命令（当前 ${commands.length} 条）`);
    },
  };
}

/** 与真 client（McpStdioClient / McpHttpClient）同形的假 MCP client：记下调用；onCall 可挂住调用。 */
export class FakeMcpClient implements McpClientLike {
  onNotification: ((n: McpNotification) => void) | undefined;
  closed = false;
  callLog: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
  constructor(private readonly tools: McpToolInfo[], private readonly onCall: () => Promise<void>) {}
  async connect(): Promise<void> { /* 假连接 */ }
  async listTools(): Promise<McpToolInfo[]> { return this.tools; }
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    this.callLog.push({ name, args });
    await this.onCall();
    return { content: [{ type: 'text', text: 'mcp ok' }] };
  }
  dispose(): void { this.closed = true; }
}

/** 真实 McpManager 接到给定的注册表上：一台名为 srv 的服务器，client 是假的（每次连接新建一个，按序记在 clients 里）。 */
export function mcpOn(registry: ToolRegistry, tools: McpToolInfo[], onCall: () => Promise<void> = async () => undefined): {
  manager: McpManager; clients: FakeMcpClient[];
} {
  const store = new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-f04-mcp-'))));
  store.upsert({ name: 'srv', command: 'echo', args: [], enabled: true });
  const clients: FakeMcpClient[] = [];
  const manager = new McpManager({
    store, chatStore: new ChatStore(openDb(':memory:')), registry,
    factories: () => { const c = new FakeMcpClient(tools, onCall); clients.push(c); return c; },
  });
  return { manager, clients };
}
