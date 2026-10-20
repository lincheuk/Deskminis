/**
 * F04 调度元数据（ToolExecutor.scheduling）：内置工具与 MCP 执行器的声明、声明覆盖实际触及的路径、shell 的锁范围，
 * 以及接线与旁路的源码守卫。
 *
 * 只看元数据的断言都配了抓实际副作用的核对：T2 真实执行每个写工具，比对执行前后的目录快照，
 * 断言实际被写的文件都落在该调用规划出的写 claim 之内。调度顺序本身的行为用例在 tool-scheduler.test.ts。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinisPaths } from '../src/minisd/paths';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ToolScheduler, planCall, sharedToolScheduler, type SchedulerEvent } from '../src/minisd/tools/scheduler';
import type { LockClaim } from '../src/minisd/tools/resource-locks';
import { pathIdentity } from '../src/minisd/tools/data-gate';
import type { ResourceClaim, SideEffectScope, ToolContext, ToolExecutor, ToolPlanContext } from '../src/minisd/tools/types';
import { fileEditTool, fileReadTool, fileWriteTool } from '../src/minisd/tools/files';
import { officeReadTool, officeWriteTool } from '../src/minisd/tools/office';
import { fileGlobTool, fileGrepTool, fileListTool } from '../src/minisd/tools/search';
import { memoryGetTool, memoryWriteTool } from '../src/minisd/tools/memory';
import { makeWebFetchTool } from '../src/minisd/tools/web';
import { makeWebSearchTool } from '../src/minisd/tools/web-search';
import { ShellManager, makeShellTool } from '../src/minisd/tools/shell';
import type { McpToolInfo } from '../src/minisd/mcp/stdio';
import { allowAll, fakeShellSpawn, mcpOn, withDeadline } from './scheduler-fixture';
import { stripComments } from './strip-comments';
import { expectSame, callMark, onCall, yieldProbe } from './engine-trace';
import { watchEngine, type EngineWatch } from './engine-wiring';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import type { StartMinisdOpts } from '../src/minisd/index';

const qEngines: CapturedEngine[] = [];

const qSavedFake = process.env.DESKMINIS_FAKE_PROVIDER;

afterEach(async () => {
  for (const e of qEngines.splice(0).reverse()) await e.close();
  vi.restoreAllMocks();
  if (qSavedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER;
  else process.env.DESKMINIS_FAKE_PROVIDER = qSavedFake;
});

async function qStart(opts: StartMinisdOpts = {}): Promise<CapturedEngine> {
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const e = await startCapturedEngine(opts);
  qEngines.push(e);
  return e;
}

async function qRpc(e: CapturedEngine, name: string, p: any = {}, conn = probeConnection('local')): Promise<any> {
  return await e.methods[name](p, conn);
}

async function qUntil(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('等待超时: ' + what);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function qPending(w: EngineWatch, e: CapturedEngine): Promise<{ sid: string; release(): void; result: Promise<unknown> }> {
  let release!: () => void;
  w.spy('mcp.ensureForRun').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const { id } = await qRpc(e, 'chat.sessions.create');
  const result = qRpc(e, 'chat.prompt', { sessionId: id, providerId: '__fake__', text: 'Q20A S3' }).catch(error => error);
  await qUntil('run进入MCP挂起点', () => typeof release === 'function');
  return { sid: id, release, result };
}

function mkPaths(label: string): MinisPaths {
  return new MinisPaths(mkdtempSync(join(tmpdir(), `dm-f04-t-${label}-`)));
}

// ---------- T1：声明清单 ----------

/** 键 = index.ts 注册点上的标识符，值 = 照同样写法构造出的执行器。index.ts 新注册一个工具而这里没补，T1(b) 会红。 */
const BUILTINS: Record<string, ToolExecutor> = {
  fileReadTool, fileWriteTool, fileEditTool,
  officeReadTool, officeWriteTool,
  fileListTool, fileGlobTool, fileGrepTool,
  makeShellTool: makeShellTool(new ShellManager()),
  memoryWriteTool, memoryGetTool,
  makeWebFetchTool: makeWebFetchTool(),
  makeWebSearchTool: makeWebSearchTool(() => undefined),
};

type Expected = {
  name: string; readOnly: boolean; concurrencySafe: boolean; sideEffects: SideEffectScope;
  input: Record<string, unknown>;
  /** 期望的资源声明；undefined = 不写 resources（不碰本地资源）。 */
  claims?: (p: MinisPaths, sid: string) => ResourceClaim[];
};
const guest = (mode: 'read' | 'write', guestPath: string) =>
  (p: MinisPaths, sid: string): ResourceClaim[] => [{ kind: 'path', mode, path: p.resolveGuestPath(sid, guestPath) }];
const memoryDir = (mode: 'read' | 'write') =>
  (p: MinisPaths): ResourceClaim[] => [{ kind: 'path', mode, path: join(p.root, 'memory') }];
const R = { readOnly: true, concurrencySafe: true, sideEffects: 'none' } as const;
const W = { readOnly: false, concurrencySafe: true, sideEffects: 'local-files' } as const;

/** 设计 §4.1 的声明表。 */
const TABLE: Record<string, Expected> = {
  fileReadTool: { name: 'file_read', ...R, input: { path: 'a/b.txt' }, claims: guest('read', 'a/b.txt') },
  officeReadTool: { name: 'office_read', ...R, input: { path: '/var/minis/shared/r.docx' }, claims: guest('read', '/var/minis/shared/r.docx') },
  fileListTool: { name: 'file_list', ...R, input: { path: 'sub' }, claims: guest('read', 'sub') },
  // path 可省：缺省 '.'
  fileGlobTool: { name: 'file_glob', ...R, input: { pattern: '*.ts' }, claims: guest('read', '.') },
  fileGrepTool: { name: 'file_grep', ...R, input: { pattern: 'x', path: '/var/minis/skills' }, claims: guest('read', '/var/minis/skills') },
  fileWriteTool: { name: 'file_write', ...W, input: { path: 'out.txt', content: '' }, claims: guest('write', 'out.txt') },
  fileEditTool: { name: 'file_edit', ...W, input: { path: '/var/minis/skills/x/SKILL.md', old_string: 'a' }, claims: guest('write', '/var/minis/skills/x/SKILL.md') },
  officeWriteTool: { name: 'office_write', ...W, input: { path: 'r.xlsx', content: '{}' }, claims: guest('write', 'r.xlsx') },
  memoryGetTool: { name: 'memory_get', ...R, input: { query: 'q' }, claims: memoryDir('read') },
  memoryWriteTool: { name: 'memory_write', ...W, input: { markdown: 'm' }, claims: memoryDir('write') },
  makeWebFetchTool: { name: 'web_fetch', readOnly: true, concurrencySafe: true, sideEffects: 'network', input: { url: 'https://example.com' } },
  makeWebSearchTool: { name: 'web_search', readOnly: true, concurrencySafe: true, sideEffects: 'network', input: { query: 'q' } },
  makeShellTool: {
    name: 'shell_execute', readOnly: false, concurrencySafe: false, sideEffects: 'unknown', input: { command: 'echo' },
    claims: (p, sid) => [{ kind: 'path', mode: 'write', path: p.workspaceOf(sid) }],
  },
};

const SRC = join(__dirname, '../src/minisd');
/** src/minisd 下全部 .ts 源文件（相对路径用正斜杠），已剥注释。
 *  stripComments 按正则去注释、不认字符串（见 strip-comments.ts）；这里的断言只认调用形态的有无。 */
function sources(): { rel: string; code: string }[] {
  const out: { rel: string; code: string }[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else if (name.endsWith('.ts')) out.push({ rel: r, code: stripComments(readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')) });
    }
  };
  walk(SRC, '');
  return out;
}
const codeOf = (rel: string): string => {
  const hit = sources().find(s => s.rel === rel);
  if (!hit) throw new Error(`没有源文件 ${rel}`);
  return hit.code;
};

describe('T1 内置工具与 MCP 执行器都有调度声明，且与声明表一致', () => {
  const paths = mkPaths('T1');
  const sid = 't1';
  const planCtx: ToolPlanContext = { sessionId: sid, paths };

  it('(a) 13 个内置工具逐个与声明表一致；只读工具的 resources() 只给读；只有 shell 是 barrier', () => {
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(BUILTINS).sort());
    for (const [key, tool] of Object.entries(BUILTINS)) {
      const want = TABLE[key];
      expect(tool.definition.name, key).toBe(want.name);
      const s = tool.scheduling;
      expect(s, `${key} 没有 scheduling`).toBeDefined();
      expect({ readOnly: s!.readOnly, concurrencySafe: s!.concurrencySafe, sideEffects: s!.sideEffects }, key)
        .toEqual({ readOnly: want.readOnly, concurrencySafe: want.concurrencySafe, sideEffects: want.sideEffects });
      if (want.claims) {
        const got = s!.resources!(want.input, planCtx);
        expect(got, key).toEqual(want.claims(paths, sid));
        if (want.readOnly) expect(got.every(c => c.mode === 'read'), `${key} 只读却给出写 claim`).toBe(true);
      } else {
        expect(s!.resources, `${key} 不该声明资源`).toBeUndefined();
      }
      // 声明落到规划上：只有 shell 按 barrier 排，其余都能与不冲突的调用并行
      expect(planCall(tool, want.input, planCtx).barrier, key).toBe(key === 'makeShellTool');
    }
  });

  it('(a) MCP 执行器的声明是常量：服务器自报只读也照样 barrier，只锁 mcp:<server>', async () => {
    const registry = new ToolRegistry();
    const selfReported = [{
      name: 'read_only_query', description: '只读查询', inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    }] as unknown as McpToolInfo[];
    const mcp = mcpOn(registry, selfReported);
    await mcp.manager.ensureForRun();
    const tool = registry.get('mcp__srv__read_only_query');
    expect(tool).toBeDefined();
    expect(tool!.scheduling).toMatchObject({ readOnly: false, concurrencySafe: false, sideEffects: 'unknown' });
    const input = { tool_title: 't', readOnly: true, concurrencySafe: true };
    expect(tool!.scheduling!.resources!(input, planCtx)).toEqual([{ kind: 'named', name: 'mcp:srv', mode: 'write' }]);
    const plan = planCall(tool!, input, planCtx);
    expect(plan.barrier).toBe(true);
    expect(plan.claims.map(c => [c.ns, c.mode])).toEqual([['named', 'write'], ['session', 'write']]);
  });

  it('(b) 源码守卫：index.ts 的注册点与上面的清单是同一个集合（新注册的工具必须进清单、必须声明）', async () => {
    // 实际注册的13份执行器与清单同一集合，每次实参就是注册表保存的那份。
    const w = watchEngine();
    await qStart();
    const registry = w.made('new ToolRegistry');
    expect(w.count('new ToolRegistry')).toBe(1);
    expect(w.count('tools.register')).toBe(13);
    const registered = w.spy('tools.register').mock.calls.map(([tool]) => tool.definition.name);
    expect(registered.sort()).toEqual(Object.values(BUILTINS).map(tool => tool.definition.name).sort());
    expect(registry.definitions().map((d: any) => d.name).sort()).toEqual(registered);
    for (const [i, [tool]] of w.spy('tools.register').mock.calls.entries()) {
      expect(w.spy('tools.register').mock.contexts[i]).toBe(registry);
      expect(registry.get(tool.definition.name)).toBe(tool);
    }
  }, 60000);

  it('(c) 源码守卫：index.ts 之外只有 mcp/manager.ts 往注册表里放工具，放的是 mkExecutor 造出来的', async () => {
    // 内置集合装配之后，真实MCP管理器只把自己mkExecutor的产物注册到同一表。
    const w = watchEngine();
    const create = w.spy('new McpManager').getMockImplementation()!;
    const client = { closed: false, onNotification: undefined, connect: vi.fn(async () => { }), listTools: vi.fn(async () => [{ name: 'Q20A_tool', description: 'q', inputSchema: { type: 'object', properties: {} } }]), callTool: vi.fn(async () => ({})), dispose: vi.fn() };
    w.spy('new McpManager').mockImplementation(function(this: unknown, ...args: any[]) {
      args[0] = { ...args[0], factories: () => client };
      return create.apply(this, args);
    });
    const e = await qStart();
    const registry = w.made('new ToolRegistry');
    const manager = w.made('new McpManager');
    expect(w.count('tools.register')).toBe(13);
    await qRpc(e, 'mcp.servers.upsert', { name: 'Q20A_SRV', command: 'Q20A-NOT-EXECUTED', args: [], enabled: true });
    const from = callMark();
    await manager.ensureForRun();
    expect(w.count('new ToolRegistry')).toBe(1);
    expect(w.count('tools.register', from)).toBe(1);
    const executor = w.args('tools.register')[0];
    expect(w.count('mcp.mkExecutor', from)).toBe(1);
  const listed = await client.listTools.mock.results[0].value;
  expect(w.args('mcp.mkExecutor')).toEqual(['Q20A_SRV', listed[0], 'mcp__Q20A_SRV__Q20A_tool']);
  expectSame(w.args('mcp.mkExecutor')[1], listed[0]);
    expect(w.spy('mcp.mkExecutor').mock.contexts.at(-1)).toBe(manager);
    expect(executor).toBe(w.spy('mcp.mkExecutor').mock.results.at(-1)?.value);
    expect(executor.definition.name).toBe('mcp__Q20A_SRV__Q20A_tool');
    expect(executor.scheduling).toMatchObject({ readOnly: false, concurrencySafe: false, sideEffects: 'unknown' });
    expect(registry.get(executor.definition.name)).toBe(executor);
    expect(w.spy('tools.register').mock.contexts.at(-1)).toBe(registry);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.listTools).toHaveBeenCalledTimes(1);
  }, 60000);
});

// ---------- T2：声明覆盖实际触及的路径 ----------

/** 目录下全部文件的内容快照（相对路径 → base64）。 */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs); else out.set(abs, readFileSync(abs).toString('base64'));
    }
  };
  walk(dir);
  return out;
}
/** 两次快照之间新增或内容变了的文件。 */
function writtenBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.entries()].filter(([abs, content]) => before.get(abs) !== content).map(([abs]) => abs);
}
/** abs 是否落在某条 path 写 claim 之内（claim 的各段是它的前缀）。 */
function coveredByWrite(claims: LockClaim[], abs: string): boolean {
  const id = pathIdentity(abs);
  return claims.some(c => c.ns === 'path' && c.mode === 'write' && c.root === id.root
    && c.segs.length <= id.segs.length && c.segs.every((seg, i) => seg === id.segs[i]));
}

describe('T2 声明覆盖实际触及的路径', () => {
  it('写工具：真实执行后实际被写的文件，都在该调用规划出的写 claim 之内', async () => {
    const paths = mkPaths('T2w');
    const sid = 't2w';
    paths.ensureSessionDirs(sid);
    const ctx: ToolContext = { sessionId: sid, paths, permissions: allowAll };
    writeFileSync(join(paths.workspaceOf(sid), 'edit.txt'), 'old text', 'utf8');
    const cases: { tool: ToolExecutor; input: Record<string, unknown> }[] = [
      { tool: fileWriteTool, input: { path: 'out/a.txt', content: 'a', tool_title: 't' } },
      { tool: fileWriteTool, input: { path: '/var/minis/shared/t2/b.txt', content: 'b', tool_title: 't' } },
      { tool: fileWriteTool, input: { path: '/var/minis/skills/t2/SKILL.md', content: 's', tool_title: 't' } },
      { tool: fileEditTool, input: { path: 'edit.txt', old_string: 'old', new_string: 'new', tool_title: 't' } },
      { tool: officeWriteTool, input: { path: 'doc/r.docx', content: JSON.stringify({ blocks: [{ kind: 'para', text: '正文' }] }), tool_title: 't' } },
      { tool: memoryWriteTool, input: { markdown: '记一条', tool_title: 't' } },
    ];
    for (const { tool, input } of cases) {
      const what = `${tool.definition.name} ${String(input.path ?? '')}`;
      const plan = planCall(tool, input, { sessionId: sid, paths });
      const before = snapshot(paths.root);
      const outcome = await tool.execute(input, ctx);
      expect(outcome.success, `${what}: ${outcome.output}`).toBe(true);
      const written = writtenBetween(before, snapshot(paths.root));
      // 探针有效：确实写了东西
      expect(written.length, what).toBeGreaterThan(0);
      for (const abs of written) expect(coveredByWrite(plan.claims, abs), `${what} 写了 ${abs}，不在它的写 claim 之内`).toBe(true);
      // 判定不是恒真：数据根下另一处不在这次调用的写 claim 之内
      expect(coveredByWrite(plan.claims, join(paths.root, 'elsewhere', 'x.txt')), what).toBe(false);
      expect(plan.barrier, what).toBe(false);
    }
  });

  it('读工具：claim 路径就是工具实际解析并读取的路径', async () => {
    const paths = mkPaths('T2r');
    const sid = 't2r';
    paths.ensureSessionDirs(sid);
    const planCtx: ToolPlanContext = { sessionId: sid, paths };
    const cases: [ToolExecutor, Record<string, unknown>, string][] = [
      [fileReadTool, { path: 'r.txt' }, 'r.txt'],
      [fileReadTool, { path: '/var/minis/skills/k/SKILL.md' }, '/var/minis/skills/k/SKILL.md'],
      [officeReadTool, { path: 'doc/r.docx' }, 'doc/r.docx'],
      [fileListTool, { path: 'sub' }, 'sub'],
      [fileGlobTool, { pattern: '*' }, '.'],
      [fileGlobTool, { pattern: '*', path: 'sub' }, 'sub'],
      [fileGrepTool, { pattern: 'x' }, '.'],
      [fileGrepTool, { pattern: 'x', path: '/var/minis/shared' }, '/var/minis/shared'],
    ];
    for (const [tool, input, guestPath] of cases) {
      expect(tool.scheduling!.resources!(input, planCtx), `${tool.definition.name} ${guestPath}`)
        .toEqual([{ kind: 'path', mode: 'read', path: paths.resolveGuestPath(sid, guestPath) }]);
    }
    // file_read 实际读的那个路径（成功读取后的钩子给出）就是 claim 的路径
    const abs = join(paths.workspaceOf(sid), 'r.txt');
    writeFileSync(abs, '内容', 'utf8');
    const readPaths: string[] = [];
    const outcome = await fileReadTool.execute({ path: 'r.txt', tool_title: 't' },
      { sessionId: sid, paths, permissions: allowAll, onFileRead: p => { readPaths.push(p); } });
    expect(outcome).toEqual({ output: '内容', success: true });
    expect(fileReadTool.scheduling!.resources!({ path: 'r.txt' }, planCtx).map(c => c.kind === 'path' && c.path)).toEqual(readPaths);
  });

  it('规划与执行拿到的是同一个会话 id、同一个 paths 对象；锁与事件也归在这个会话名下', async () => {
    const paths = mkPaths('T2s');
    const sid = 't2-session';
    paths.ensureSessionDirs(sid);
    const scheduler = new ToolScheduler();
    const planned: { sessionId: string; paths: MinisPaths; keys: string[] }[] = [];
    const executed: { sessionId: string; paths: MinisPaths; held: string[] }[] = [];
    const probe: ToolExecutor = {
      definition: { name: 'probe', description: '', parameters: {}, required: [] },
      scheduling: {
        readOnly: true, concurrencySafe: true, sideEffects: 'none',
        resources: (_input, ctx) => { planned.push({ sessionId: ctx.sessionId, paths: ctx.paths, keys: Object.keys(ctx).sort() }); return []; },
      },
      async execute(_input, ctx) {
        executed.push({ sessionId: ctx.sessionId, paths: ctx.paths, held: scheduler.locks.snapshot().held.map(h => h.label) });
        return { output: 'ok', success: true };
      },
    };
    const registry = new ToolRegistry();
    registry.register(probe);
    const events: SchedulerEvent[] = [];
    const results = await withDeadline(scheduler.runBatch({
      calls: [{ toolUseId: 'P', name: 'probe', input: '{}' }], registry,
      ctx: { sessionId: sid, paths, permissions: allowAll, signal: new AbortController().signal },
      onEvent: e => { events.push(e); },
    }), 2000, 'T2 探针批次');

    expect(results[0].outcome.success).toBe(true);
    expect(planned.length).toBeGreaterThan(0);
    for (const p of planned) {
      expect(p.sessionId).toBe(sid);
      expect(p.paths).toBe(paths);
      // 资源解析只拿得到这两样：权限网关与取消信号没有传进来
      expect(p.keys).toEqual(['paths', 'sessionId']);
    }
    expect(executed).toHaveLength(1);
    expect(executed[0].sessionId).toBe(sid);
    expect(executed[0].paths).toBe(paths);
    expect(executed[0].held).toEqual([`${sid}/P/probe`]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.sessionId === sid)).toBe(true);
  });
});

// ---------- T3、T5 ----------

describe('T3 资源解析的入参类型里没有权限网关与取消信号', () => {
  it('类型守卫（由 tsc 核对）：取 ToolPlanContext 的 permissions / signal 是类型错误', () => {
    // @ts-expect-error 解析阶段拿不到权限网关：不可能在这里弹卡或授予权限
    type NoPermissions = ToolPlanContext['permissions'];
    // @ts-expect-error 也拿不到取消信号
    type NoSignal = ToolPlanContext['signal'];
    const keys: (keyof ToolPlanContext)[] = ['sessionId', 'paths'];
    expect(keys).toHaveLength(2);
  });
});

describe('T5 进程级缺省调度器', () => {
  it('sharedToolScheduler() 每次返回同一个实例（漏接线也不会退化成每个 run 一张锁表）', () => {
    const a = sharedToolScheduler();
    expect(sharedToolScheduler()).toBe(a);
    expect(sharedToolScheduler().locks).toBe(a.locks);
  });
});

// ---------- T6：shell 的锁范围 ----------

describe('T6 shell_execute 的锁范围：当前工作区 + 常驻 shell 的出生目录', () => {
  it('没建过 shell 只锁当前工作区；建过之后改工作区，新旧两处都锁；没改过时去重成一条', async () => {
    const paths = mkPaths('T6');
    const W1 = join(paths.root, 'ext', 'w1'); const W2 = join(paths.root, 'ext', 'w2');
    mkdirSync(W1, { recursive: true }); mkdirSync(W2, { recursive: true });
    let bound = W1;
    paths.setWorkspaceResolver(() => bound);
    const sh = fakeShellSpawn();
    // platform 'linux'：释放 shell 时直接 kill 假进程，不去起 taskkill
    const shells = new ShellManager({ platform: 'linux', spawnImpl: sh.spawnImpl });
    const tool = makeShellTool(shells);
    const sid = 't6';
    const planCtx: ToolPlanContext = { sessionId: sid, paths };
    const input = { command: 'echo', tool_title: 't' };
    const writeKeys = (): string[] => planCall(tool, input, planCtx).claims
      .filter(c => c.ns === 'path').map(c => { expect(c.mode).toBe('write'); return c.display; });

    expect(shells.cwdOf(sid)).toBeUndefined();
    expect(shells.cwdOf('没有这个会话')).toBeUndefined();
    expect(writeKeys()).toEqual([W1]);

    // 在 W1 下真实跑一条命令（假驱动答复）：shell 在 W1 里出生
    const ran = tool.execute(input, { sessionId: sid, paths, permissions: allowAll });
    await sh.untilCommands(1);
    sh.commands[0].reply('ok');
    expect((await withDeadline(ran, 5000, 'T6 第一条命令')).success).toBe(true);
    expect(sh.spawns.map(s => s.cwd)).toEqual([W1]);
    expect(shells.cwdOf(sid)).toBe(W1);
    // 没改过工作区：两条同键，去重后一条
    expect(writeKeys()).toEqual([W1]);

    // 改工作区：cwdOf 仍是出生目录，不跟着当前工作区走；两处都锁
    bound = W2;
    expect(paths.workspaceOf(sid)).toBe(W2);
    expect(shells.cwdOf(sid)).toBe(W1);
    expect(writeKeys().sort()).toEqual([W1, W2].sort());
    expect(planCall(tool, input, planCtx).barrier).toBe(true);

    void shells.dispose(sid);
    expect(shells.cwdOf(sid)).toBeUndefined();
    expect(writeKeys()).toEqual([W2]);
  });
});

// ---------- T4：源码守卫 ----------

/** code 里第一处 `callee(` 调用的完整文本（按括号配对）。 */
function callText(code: string, callee: string): string {
  const start = code.search(new RegExp(`\\b${callee}\\(`));
  if (start < 0) return '';
  let depth = 0;
  for (let i = start + callee.length; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return code.slice(start, i + 1);
  }
  return '';
}

describe('T4 源码守卫：工具只经调度器执行，调度不参与权限判定', () => {
  const all = sources();
  const filesWith = (re: RegExp): string[] => all.filter(s => re.test(s.code)).map(s => s.rel);

  it('src/minisd 里没有绕过调度器直接执行工具的调用；registry.run( 只出现在调度器里', () => {
    expect(filesWith(/\b(?:tools|registry)\.execute\(/)).toEqual([]);
    expect(filesWith(/\bregistry\.run\(/)).toEqual(['tools/scheduler.ts']);
  });

  it('loop.ts 不再有固定并发执行器，工具批次交给 scheduler.runBatch', () => {
    const loop = codeOf('agent/loop.ts');
    expect(loop).not.toMatch(/runWithConcurrency/);
    expect(loop).not.toMatch(/\bCONCURRENCY\b/);
    expect(loop).toMatch(/\bscheduler\.runBatch\(/);
    expect(loop).toMatch(/const scheduler = opts\.scheduler \?\? sharedToolScheduler\(\)/);
  });

  it('index.ts：每个引擎实例只建一个调度器，等锁上限来自启动参数，并传给 runAgentLoop', async () => {
    // 唯一调度器收到非默认上限，实际循环共享该实例。
    const w = watchEngine();
    const e = await qStart({ toolLockWaitTimeoutMs: 137 });
    expect(w.count('new ToolScheduler')).toBe(1);
    expect(w.args('new ToolScheduler')).toEqual([{ lockWaitTimeoutMs: 137 }]);
    const scheduler = w.made('new ToolScheduler');
    const s = await qRpc(e, 'chat.sessions.create');
    await qRpc(e, 'chat.prompt', { sessionId: s.id, text: 'Q20A SCHEDULER', providerId: '__fake__' });
    await qUntil('循环已调用', () => w.count('runAgentLoop') === 1);
    expectSame(w.args('runAgentLoop')[1].scheduler, scheduler);
    expect(w.count('new ToolScheduler')).toBe(1);
  }, 60000);

  it('index.ts：chat.cancel 先了结该会话的权限卡、再 abort，两句之间没有 await', async () => {
    // 真实运行已进入挂起点，取消实际执行broker收口→abort且没有让步。
    const w = watchEngine();
    const e = await qStart();
    const run = await qPending(w, e);
    const gaps = yieldProbe(w.spy('broker.settleWhere'), w.spy('abort'));
    const from = callMark();
    await qRpc(e, 'chat.cancel', { sessionId: run.sid });
    expect(w.seq(['broker.settleWhere', 'abort'], from)).toEqual(['broker.settleWhere', 'abort']);
    expect(gaps).toEqual([false]);
    run.release();
    await run.result;
  }, 60000);

  it('mcp/manager.ts 的 mkExecutor 不读服务器自报的 annotations / readOnlyHint', () => {
    const manager = codeOf('mcp/manager.ts');
    const body = (manager.split('private mkExecutor(')[1] ?? '').split('\nfunction defaultClientFactory')[0];
    expect(body).toMatch(/scheduling:/);
    expect(body).not.toMatch(/annotations/);
    expect(body).not.toMatch(/readOnlyHint/);
    expect(manager).not.toMatch(/readOnlyHint/);
  });

  it('调度器与锁表不做命令分类、不调数据根判定、不引入权限网关实现', () => {
    for (const rel of ['tools/scheduler.ts', 'tools/resource-locks.ts']) {
      const code = codeOf(rel);
      expect(code, rel).not.toMatch(/classifyShellCommand/);
      expect(code, rel).not.toMatch(/\bdataGate\(/);
      expect(code, rel).not.toMatch(/from '\.\/permissions'/);
    }
  });
});
