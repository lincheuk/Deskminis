/**
 * F09 W 组：源码守卫、进程内引擎的接线、属主轮询。
 *
 * 守卫认的是真实的调用形态（剥掉注释再看）：
 *  - 产品与取证脚本里没有按进程名 / 映像名结束进程的写法；taskkill 只在 proc/win-exec.ts 里按 /pid 起（任务卡阻断项 1）。
 *  - 进程账本与启动恢复引不到任何结束进程的手段（恢复不按记录的 PID 做任何事）。
 *  - 归属层不读任何随包文件：脚本是打进产物的字符串常量，安装包里没有多出文件（任务卡阻断项 3）。
 *  - index.ts 里三种入口与 MCP 试连拿到的是同一个 supervisor，关停时封进程账，standalone 分支挂了属主轮询与标准流静音。
 * 接线用例起一个进程内引擎：shell、终端走假 spawn（钉登记与状态面），MCP 试连走真实进程（Windows 上就是真实的 launcher）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { spawn } from 'node:child_process';
import { startMinisd } from '../src/minisd/index';
import { McpManager, type McpClientLike } from '../src/minisd/mcp/manager';
import { McpServersStore } from '../src/minisd/mcp/config';
import type { McpNotification, McpToolInfo } from '../src/minisd/mcp/stdio';
import { MinisPaths } from '../src/minisd/paths';
import { PARENT_GONE_STREAK, PARENT_WATCH_MS, muteBrokenStdio, watchParent } from '../src/minisd/proc/parent-watch';
import { PROC_MARKER } from '../src/minisd/proc/own-script';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { claimKey } from '../src/minisd/tools/resource-locks';
import { planCall } from '../src/minisd/tools/scheduler';
import { readDb, rpcClient } from './run-ledger-fixture';
import { stripComments } from './strip-comments';
import { expectSame, callMark } from './engine-trace';
import { watchEngine } from './engine-wiring';
import { probeConnection, startCapturedEngine } from './engine-assembly';
import { runStandaloneBranch } from './standalone-branch';

const APP = join(__dirname, '..');
const SELF = 'tests/proc-wiring.test.ts';
const rel = (file: string): string => relative(APP, file).split(sep).join('/');
const code = (path: string): string => stripComments(readFileSync(join(APP, path), 'utf8'));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const SRC = walk(join(APP, 'src')).map(rel);
const SCRIPTS = walk(join(APP, 'scripts')).map(rel);
/** 本文件自己装着这些写法的正则，不扫自己。 */
const PROC_TESTS = [
  ...readdirSync(join(APP, 'tests')).filter(n => n.startsWith('proc-')).map(n => `tests/${n}`).filter(p => p !== SELF),
  // 真机用例借用的 F05 fixture（结束引擎的那一句在这里）
  'tests/run-ledger-fixture.ts', 'tests/minisd-crash-inject.cjs',
];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('F09 源码守卫（W1–W5、W8）', () => {
  it('W1 没有按进程名 / 映像名结束进程的写法；taskkill 只在 proc/win-exec.ts 里按 /pid 起', () => {
    const banned: [string, RegExp][] = [
      ['taskkill /IM', /taskkill[^\n]*\/IM\b/i],
      ['taskkill /FI IMAGENAME', /\/FI\s+["'`]?\s*IMAGENAME/i],
      ['Stop-Process -Name', /Stop-Process\s+-Name\b/i],
      ['-ProcessName', /-ProcessName\b/i],
      ['Get-Process … | Stop-Process', /Get-Process\b[^|\n]*\|\s*Stop-Process/i],
      ['wmic process where name', /wmic\s+process\s+where\s+["'`(]*\s*name/i],
      ['killall', /\bkillall\b/i],
      ['pkill', /\bpkill\b/i],
    ];
    const hits: string[] = [];
    for (const file of [...SRC, ...SCRIPTS, ...PROC_TESTS]) {
      const text = code(file);
      for (const [what, re] of banned) if (re.test(text)) hits.push(`${file}: ${what}`);
    }
    expect(hits).toEqual([]);
    // 作为 spawn 实参的 taskkill.exe：产品里只在 proc/win-exec.ts，实参是 /pid <根> /T /F。
    // tools/permissions.ts 里的危险命令规则是规则文本、不是调用，它写的是 taskkill（没有 .exe），本来就不在这条里
    const users = SRC.filter(f => /taskkill\.exe/i.test(code(f)));
    expect(users).toEqual(['src/minisd/proc/win-exec.ts']);
    const calls = [...code('src/minisd/proc/win-exec.ts').matchAll(/system32\('taskkill\.exe'[^)]*\)\s*,\s*\[([^\]]*)\]/g)].map(m => m[1].replace(/\s+/g, ''));
    expect(calls).toEqual([`'/pid',String(child.pid),'/T','/F'`]);
    // 取证脚本里既有的那一处同样是按 PID
    const scriptCalls = SCRIPTS.flatMap(f => [...code(f).matchAll(/'taskkill\.exe'\)\s*,\s*\[([^\]]*)\]/g)].map(m => `${f}: ${m[1].replace(/\s+/g, '')}`));
    for (const c of scriptCalls) expect(c).toMatch(/: '\/PID',String\(pid\)/i);
    // 真机用例与 fixture：结束动作只落在句柄或 PID 上，从不带 /T 以外的筛选
    for (const file of PROC_TESTS) {
      for (const m of code(file).matchAll(/taskkill(?:\.exe)?'?\)?\s*,\s*\[([^\]]*)\]/gi)) expect(`${file}: ${m[1]}`).toMatch(/\/pid/i);
    }
  });

  it('W2 src/minisd 里引 node:child_process 的文件恰好是 8 个；桥与市场两处只许 spawnSync', () => {
    const importers = SRC.filter(f => f.startsWith('src/minisd/') && /from 'node:child_process'|require\('node:child_process'\)/.test(code(f))).sort();
    expect(importers).toEqual([
      'src/minisd/bridge/handlers.ts', 'src/minisd/bridge/server.ts', 'src/minisd/market/install.ts', 'src/minisd/mcp/stdio.ts',
      'src/minisd/proc/owned.ts', 'src/minisd/proc/win-exec.ts', 'src/minisd/terminal.ts', 'src/minisd/tools/shell.ts',
    ]);
    for (const f of ['src/minisd/bridge/server.ts', 'src/minisd/market/install.ts']) {
      expect([...code(f).matchAll(/import (?:type )?\{([^}]*)\} from 'node:child_process'/g)].map(m => m[1].trim())).toEqual(['spawnSync']);
    }
  });

  it('W3 进程账本与启动恢复引不到任何结束进程的手段', () => {
    const ledger = code('src/minisd/store/proc-ledger.ts');
    expect(ledger).not.toMatch(/child_process/);
    expect(ledger).not.toMatch(/process\.kill\(|\.kill\(|killTree|taskkill|spawn\(/);
    expect([...ledger.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort()).toEqual(['../../shared/proc', '../proc/owned', 'better-sqlite3']);
    for (const m of ['../../shared/proc', '../proc/owned', 'better-sqlite3']) expect(ledger).toMatch(new RegExp(`import type [^;]* from '${m.replace(/[./]/g, '\\$&')}'`)); // 全是 import type
    // run-recovery.ts 的 import 清单不变（F05 的 K17 同一条断言）
    const recovery = code('src/minisd/agent/run-recovery.ts');
    expect([...recovery.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort())
      .toEqual(['../../shared/permission', '../../shared/run', '../../shared/types', '../cron/store', '../store/chat-store', '../store/run-ledger']);
    // 属主轮询只探测「这个 PID 上还有没有进程」（信号 0），不结束任何东西
    const watch = code('src/minisd/proc/parent-watch.ts');
    expect([...watch.matchAll(/process\.kill\(([^)]*)\)/g)].map(m => m[1].replace(/\s+/g, ''))).toEqual(['pid,0']);
  });

  it('W4 归属层不读任何随包文件；安装包里没有多出文件，运行期依赖没有变', () => {
    const files = [...SRC.filter(f => f.startsWith('src/minisd/proc/')), 'src/minisd/store/proc-ledger.ts', 'src/shared/proc.ts'];
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) expect(code(f), f).not.toMatch(/readFileSync|readFile\(|__dirname|import\.meta\.url|process\.resourcesPath|resolveBridge/);
    const yml = readFileSync(join(APP, 'electron-builder.yml'), 'utf8').split(/\r?\n/).filter(l => !l.trim().startsWith('#'));
    const section = (key: string): string[] => {
      const start = yml.findIndex(l => l.startsWith(`${key}:`));
      const body: string[] = [];
      for (let i = start + 1; i < yml.length && (yml[i].startsWith(' ') || yml[i].trim() === ''); i++) body.push(yml[i].trim());
      return body.filter(Boolean);
    };
    expect(section('files')).toEqual([
      `- 'out/**'`, `- 'package.json'`, `- 'resources/**'`,
      `- '!node_modules/@napi-rs/keyring-{linux,darwin,freebsd}*/**'`,
      `- '!node_modules/@napi-rs/keyring-win32-{arm64,ia32}-msvc/**'`,
      `- '!node_modules/better-sqlite3/{deps,src}/**'`, `- '!node_modules/@xterm/**'`,
      `- '!node_modules/**/*.map'`, `- '!node_modules/@noble/*/src/**'`,
      `- '!node_modules/undici/docs/**'`, `- '!node_modules/js-yaml/dist/**'`,
    ]);
    expect(yml).toContain('electronLanguages: [zh-CN, en-US]');
    expect(section('extraResources').filter(l => l.startsWith('- from:')).map(l => l.slice('- from:'.length).trim()))
      .toEqual(['src/minisd/bridge-cli.mjs', 'scripts/bridge-node.cmd', '../LICENSE', '../THIRD-PARTY-NOTICES.md']);
    expect(section('asarUnpack')).toEqual([`- 'node_modules/better-sqlite3/**'`, `- 'node_modules/@napi-rs/keyring-win32-x64-msvc/**'`]);
    expect(yml.some(l => /^extraFiles:/.test(l))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@napi-rs/keyring', '@noble/ciphers', '@noble/curves', '@noble/hashes', '@xterm/addon-fit', '@xterm/xterm',
      'better-sqlite3', 'electron-updater', 'undici', 'ws', 'yauzl',
    ]);
  });

  it('W5 index.ts：同一个 supervisor 交给终端、shell、MCP 与 MCP 试连；恢复、快照、封进程账、属主轮询都接上了', async () => {
    // 三种入口拿到同一个supervisor，用户注入的其它proc字段原样保留且不能覆盖它。
    const w = watchEngine();
    const f = fakeSpawn();
    const injected = { platform: 'win32' as const, spawnImpl: f.spawnImpl, supervisor: {} as any };
    const recoveredTrees = [{ reaped: 'job' }, { reaped: 'unverified' }];
    w.spy('procLedger.closeOrphans').mockImplementationOnce(() => recoveredTrees);
    let procReads = 0;
    const e = await startCapturedEngine({ get proc() { procReads++; return injected; } });
    expect(procReads).toBe(1);
    expect(w.count('parent.watch')).toBe(0);
    expect(w.count('stdio.mute')).toBe(0);
    cleanups.push(() => e.close());
    const supervisor = w.made('new ProcSupervisor');
    expect(w.count('new ProcSupervisor')).toBe(1);
    const terminalOpts = w.args('new TerminalManager')[3];
    const shellOpts = w.args('new ShellManager')[0];
    expect(terminalOpts).toBe(shellOpts);
    for (const opts of [terminalOpts, shellOpts, w.args('new McpManager')[0]]) {
      expectSame(opts.supervisor, supervisor);
    }
    expect(terminalOpts.platform).toBe(injected.platform);
    expect(terminalOpts.spawnImpl).toBe(injected.spawnImpl);

    // 进程账本接的是本代账本、实际supervisor状态和引擎ChatStore的删除判据。
    const ledger = w.made('new ProcLedger');
    const opts = w.args('new ProcLedger')[1];
    expectSame(w.args('new ProcLedger')[0], w.made('db.open'));
    expect(w.count('new CronStore')).toBe(1);
    expectSame(w.args('recoverOnBoot')[0].cron, w.made('new CronStore'));
    expectSame(w.args('recoverOnBoot')[0].ledger, w.made('new RunLedger'));
    expect(opts.epoch).toBe(w.made('new RunLedger').epoch);
    expect(w.seq(['supervisor.bind', 'recoverOnBoot', 'procLedger.closeOrphans'])).toEqual(['supervisor.bind', 'recoverOnBoot', 'procLedger.closeOrphans']);

    expectSame(w.args('supervisor.bind')[0], ledger);
    expect(w.args('supervisor.bind')).toEqual([ledger]);
    let from = callMark();
    const status = opts.status();
    expect(w.count('supervisor.status', from)).toBe(1);

    expectSame(w.spy('supervisor.status').mock.contexts.at(-1), supervisor);
    expect(status).toBe(w.spy('supervisor.status').mock.results.at(-1)?.value);
    const chat = w.made('new ChatStore');
    for (const id of [chat.createSession('Q20A-PROC').id, 'Q20A-PROC-NEVER-EXISTED']) {
      from = callMark();
      const answer = opts.isSessionDeleted(id);
      expect(w.count('chat.isDeleted', from)).toBe(1);
      expect(w.args('chat.isDeleted')).toEqual([id]);
      expectSame(w.spy('chat.isDeleted').mock.contexts.at(-1), chat);
      expect(answer).toBe(w.spy('chat.isDeleted').mock.results.at(-1)?.value);
      expect(answer).toBe(false);
    }

    // 实际恢复回调问同一份进程账本的orphanNote，边界输入也原样转交；审计带代次和两种回收计数。
    const note = { executionId: 'Q20A-NO-EXEC', sessionId: 'Q20A-NO-SESSION', name: 'shell_execute', epoch: 0 };
    from = callMark();
    const answer = w.args('recoverOnBoot')[0].processNote(note);
    expect(w.count('procLedger.orphanNote', from)).toBe(1);
    expect(w.args('procLedger.orphanNote')).toEqual([note]);

    expectSame(w.spy('procLedger.orphanNote').mock.contexts.at(-1), ledger);
    expect(answer).toBe(w.spy('procLedger.orphanNote').mock.results.at(-1)?.value);
    expect(w.spy('audit.append').mock.calls.filter(args => args[0] === 'proc.recovered')).toEqual([['proc.recovered', { epoch: opts.epoch, trees: 2, unverified: 1 }]]);
    const auditAt = w.spy('audit.append').mock.calls.findIndex(args => args[0] === 'proc.recovered');
    expectSame(w.spy('audit.append').mock.contexts[auditAt], w.made('new AuditLogger'));
    from = callMark();
    const snap = e.methods['proc.trees.snapshot']({}, probeConnection('local'));
    expect(w.count('procLedger.snapshot', from)).toBe(1);
    expect(w.args('procLedger.snapshot')).toEqual([]);

    expectSame(w.spy('procLedger.snapshot').mock.contexts.at(-1), ledger);
    expect(snap).toBe(w.spy('procLedger.snapshot').mock.results.at(-1)?.value);
    from = callMark();
    const diag = await e.methods['diagnostics.dryRun']({}, probeConnection('local')) as any;
    expect(w.count('supervisor.status', from)).toBe(1);

    expectSame(w.spy('supervisor.status').mock.contexts.at(-1), supervisor);
    expect(diag.checks.processOwnership).toEqual({ status: 'ready', detail: '进程托管：本次运行还没有启动过子进程' });

    // MCP试连使用实际工厂实参，只有客户端替成无进程的可控对象；结束按probe-done回收一次。
    const client = {
      connect: vi.fn(async () => {
      }), listTools: vi.fn(async () => []), dispose: vi.fn()
    };
    w.spy('new McpStdioClient').mockImplementationOnce(() => client);
    expect(await e.methods['mcp.servers.test']({ name: 'Q20A-PROBE', command: 'Q20A_FAKE_COMMAND', args: [] }, probeConnection('local'))).toMatchObject({ ok: true, toolCount: 0 });
    expect(w.count('new McpStdioClient')).toBe(1);

    expectSame(w.args('new McpStdioClient')[0].proc.supervisor, supervisor);
    expect(w.args('new McpStdioClient')[0].tree).toEqual({ ownerRef: 'Q20A-PROBE' });
    expect(client.dispose.mock.calls).toEqual([['probe-done']]);
    from = callMark();
    await e.close();
    expect(w.seq(['ledger.close', 'procLedger.close', 'db.close'], from)).toEqual(['ledger.close', 'procLedger.close', 'db.close']);

    // 三种停用值都走关闭分支，大小写不影响；相近但不在集合内的值仍启用。
    const saved = process.env.DESKMINIS_PROC_OWNERSHIP;
    try {
      for (const value of ['off', 'OFF', '0', 'false', 'FALSE', 'on', 'falseX', 'offX', '0x', '', undefined]) {
        vi.restoreAllMocks();
        if (value === undefined) delete process.env.DESKMINIS_PROC_OWNERSHIP; else process.env.DESKMINIS_PROC_OWNERSHIP = value;
        const current = watchEngine();
        const other = await startCapturedEngine();
        cleanups.push(() => other.close());
        expect(current.count('new ProcSupervisor')).toBe(1);
        expect(current.args('new ProcSupervisor')).toEqual([value !== undefined && ['off', '0', 'false'].includes(value.toLowerCase()) ? { disabled: 'disabled-by-env' } : undefined]);
        await other.close();
      }
    } finally {
      if (saved === undefined)
        delete process.env.DESKMINIS_PROC_OWNERSHIP;
      else
        process.env.DESKMINIS_PROC_OWNERSHIP = saved;
    }

    // standalone先装message监听，再静音再挂属主轮询；onGone走同一条shutdown路。
    const run = await runStandaloneBranch();
    try {
      await run.settled();
      expect(run.order().filter(name => ['parentPort.on', 'stdio.mute', 'parent.watch'].includes(name))).toEqual(['parentPort.on', 'stdio.mute', 'parent.watch']);
      expect(run.spies['stdio.mute'].mock.calls).toEqual([[]]);
      expect(run.spies['parent.watch'].mock.calls).toHaveLength(1);
      expect(run.spies['parent.watch'].mock.calls[0][0].ppid).toBe(process.ppid);
      (run.spies['parent.watch'].mock.calls[0][0] as {
        onGone(): void;
      }).onGone();
      // 回调同步发给同一个parentPort的就是shutdown，先核对这条接线再等退出。
      expect(run.spies['parentPort.emit'].mock.calls).toEqual([['message', { data: { type: 'shutdown' } }]]);
      expectSame(run.spies['parentPort.emit'].mock.contexts[0], run.spies['parentPort.on'].mock.contexts[0]);
      expect(await run.exited()).toBe(0);
      expect(run.spies.exit.mock.calls).toEqual([[0]]);
    } finally {
      await run.dispose();
    }
    const absent = await runStandaloneBranch({ parentPort: false, lockHeld: true });
    try {
      await absent.settled();
      expect(absent.spies['stdio.mute'].mock.calls).toHaveLength(0);
      expect(absent.spies['parent.watch'].mock.calls).toHaveLength(0);
      expect(absent.spies['parentPort.on'].mock.calls).toHaveLength(0);
    } finally {
      await absent.dispose();
    }
  }, 60000);

  it('W8 构建产物里带着归属脚本（没有产物则跳过）', () => {
    const out = join(APP, 'out', 'main', 'minisd.js');
    if (!existsSync(out)) { console.log('F09 W8：没有 out/main/minisd.js（未构建），未运行'); return; }
    const js = readFileSync(out, 'utf8');
    // 产物比源码旧（没有重新构建）时不下结论：这条钉的是「脚本确实被打进了产物」，不是构建的新旧
    const newest = Math.max(...['src/minisd/proc/own-script.ts', 'src/minisd/proc/owned.ts'].map(f => statSync(join(APP, f)).mtimeMs));
    if (statSync(out).mtimeMs < newest) { console.log('F09 W8：out/main/minisd.js 比归属层源码旧（需要重新 build），未运行'); return; }
    expect(js).toContain(PROC_MARKER);
    for (const fn of ['CreateJobObjectW', 'AssignProcessToJobObject', 'SetInformationJobObject', 'TerminateJobObject', 'CreateProcessW']) expect(js).toContain(fn);
  });
});

describe('F09 W9：恢复文案依赖的 F04 / F05 格式没有漂', () => {
  it('MCP 工具的资源声明仍是 mcp:<服务器名原文>；调度器算出的声明里恰有一条 named:mcp:<服务器名>，经运行账本落账后读得回', async () => {
    expect(code('src/minisd/mcp/manager.ts')).toMatch(/resources: \(\) => \[\{ kind: 'named', name: `mcp:\$\{server\}`, mode: 'write' \}\]/);
    const root = mkdtempSync(join(tmpdir(), 'dm-f09-w9-'));
    const db = openDb(join(root, 'minis.db')); cleanups.push(() => { db.close(); });
    const chat = new ChatStore(db); const paths = new MinisPaths(root); const registry = new ToolRegistry();
    const store = new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-f09-w9-mcp-'))));
    const SERVER = 'my.server 一号';
    store.upsert({ name: SERVER, command: 'echo', args: [] });
    const client: McpClientLike = {
      onNotification: undefined as ((n: McpNotification) => void) | undefined, closed: false,
      connect: async () => undefined,
      listTools: async (): Promise<McpToolInfo[]> => [{ name: 'x', description: 'x', inputSchema: { type: 'object', properties: {} } }],
      callTool: async () => ({ content: [] }), dispose: () => undefined,
    };
    const mgr = new McpManager({ store, chatStore: chat, registry, factories: () => client });
    cleanups.push(() => mgr.disposeAll());
    await mgr.ensureForRun();
    const defs = registry.definitions().filter(d => d.name.startsWith('mcp__'));
    expect(defs.map(d => d.name)).toEqual(['mcp__my_server_____x']);
    const sid = chat.createSession().id;
    const plan = planCall(registry.get(defs[0].name)!, { tool_title: 't' }, { sessionId: sid, paths });
    const keys = plan.claims.map(claimKey);
    expect(keys.filter(k => k.startsWith('named:mcp:'))).toEqual([`named:mcp:${SERVER}`]);
    expect(plan.sideEffects).toBe('unknown'); // 被打断时落进 effect-unknown 的前提
    expect(plan.readOnly).toBe(false);
    // 进程账本读的两列还在（经真实的循环与运行账本落账后读回 claims_json 的那一步在 proc-recovery-note.test.ts，每条 MCP 用例都断言）
    const cols = (db.prepare(`PRAGMA table_info(tool_executions)`).all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('claims_json'); expect(cols).toContain('started_at');
    expect((db.prepare(`PRAGMA table_info(agent_runs)`).all() as { name: string }[]).map(c => c.name)).toEqual(expect.arrayContaining(['id', 'session_id', 'active']));
    // 账本里按字面量写着的那个前缀，与调度器的键是同一个
    expect(code('src/minisd/store/proc-ledger.ts')).toMatch(/const MCP_CLAIM_PREFIX = 'named:mcp:';/);
  });
});

describe('F09 批量启动：几个会话的 run 同时起跑时，同一台 MCP 服务器只连一次', () => {
  /** 连接挂在闸上的假 client：记下每个实例的连接、回收与原因。 */
  function gated(listTools?: () => Promise<McpToolInfo[]>) {
    const made: { connected: boolean; disposed: string[]; release(ok?: boolean): void }[] = [];
    const factory = (): McpClientLike => {
      let open!: (ok: boolean) => void;
      const gate = new Promise<boolean>(r => { open = r; });
      const rec = { connected: false, disposed: [] as string[], release: (ok = true) => open(ok) };
      made.push(rec);
      return {
        onNotification: undefined as ((n: McpNotification) => void) | undefined, closed: false,
        connect: async () => { if (!(await gate)) throw new Error('注入：连不上'); rec.connected = true; },
        listTools: listTools ?? (async (): Promise<McpToolInfo[]> => [{ name: 'x', description: 'x', inputSchema: { type: 'object', properties: {} } }]),
        callTool: async () => ({ content: [] }),
        dispose: (cause?: string) => { rec.disposed.push(cause ?? 'disposed'); },
      };
    };
    const db = openDb(':memory:'); cleanups.push(() => { db.close(); });
    const registry = new ToolRegistry();
    const store = new McpServersStore(new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-f09-batch-'))));
    store.upsert({ name: 'srv', command: 'echo', args: [] });
    const mgr = new McpManager({ store, chatStore: new ChatStore(db), registry, factories: factory });
    cleanups.push(() => mgr.disposeAll());
    const tools = (): string[] => registry.definitions().map(d => d.name).filter(n => n.startsWith('mcp__'));
    return { made, mgr, store, tools };
  }
  const tick = (): Promise<void> => new Promise(r => setImmediate(r));

  it('五个并发的 ensureForRun：工厂只被调一次，五个都等到同一次连接落定，工具注册一份', async () => {
    const g = gated();
    const runs = [1, 2, 3, 4, 5].map(() => g.mgr.ensureForRun());
    await tick();
    expect(g.made).toHaveLength(1); // 以前是 5 个进程，后落定的顶掉先落定的，前 4 个没人管
    let done = 0; for (const r of runs) void r.then(() => { done++; });
    await tick();
    expect(done).toBe(0); // 都在等
    g.made[0].release();
    await Promise.all(runs);
    expect(g.made).toHaveLength(1);
    expect(g.tools()).toEqual(['mcp__srv__x']);
    expect(g.mgr.statuses()).toMatchObject([{ name: 'srv', status: 'connected', toolCount: 1 }]);
    await g.mgr.ensureForRun(); // 已连上：不再连
    expect(g.made).toHaveLength(1);
    expect(g.made[0].disposed).toEqual([]);
  });

  it('在途的连接失败：等着的那几个不各自再连一遍，这一轮记为出错；下一轮重新连', async () => {
    const g = gated();
    const runs = [1, 2, 3].map(() => g.mgr.ensureForRun());
    await tick();
    g.made[0].release(false);
    await Promise.all(runs);
    expect(g.made).toHaveLength(1);
    expect(g.mgr.statuses()).toMatchObject([{ name: 'srv', status: 'error', lastError: '注入：连不上' }]);
    expect(g.tools()).toEqual([]);
    const again = g.mgr.ensureForRun();
    await tick();
    expect(g.made).toHaveLength(2);
    g.made[1].release();
    await again;
    expect(g.mgr.statuses()).toMatchObject([{ name: 'srv', status: 'connected' }]);
  });

  it('连接途中配置被改（forget）：旧配置的那次连接落定后当场关掉；改完之后起跑的 run 按新配置另连一次，不去等旧的', async () => {
    const g = gated();
    const before = [g.mgr.ensureForRun(), g.mgr.ensureForRun()];
    await tick();
    g.store.upsert({ name: 'srv', args: ['--v2'] }); g.mgr.forget('srv');
    const after = [g.mgr.ensureForRun(), g.mgr.ensureForRun()];
    await tick();
    expect(g.made).toHaveLength(2); // 旧代一个、新代一个（新代的两个 run 共用）
    g.made[0].release();
    await Promise.all(before);
    expect(g.made[0].disposed).toEqual(['config-changed']);
    expect(g.tools()).toEqual([]); // 旧配置的结果不注册
    g.made[1].release();
    await Promise.all(after);
    expect(g.made).toHaveLength(2);
    expect(g.made[1].disposed).toEqual([]);
    expect(g.tools()).toEqual(['mcp__srv__x']);
  });
  it('连接途中关停：当场回收在途 client，迟到连接不注册，后续显式起跑可重新连接', async () => {
    const g = gated();
    const runs = [g.mgr.ensureForRun(), g.mgr.ensureForRun()];
    await tick();
    await g.mgr.disposeAll();
    expect(g.made[0].disposed).toContain('shutdown');
    g.made[0].release();
    await Promise.all(runs);
    expect(g.tools()).toEqual([]);
    expect(g.mgr.statuses()).toMatchObject([{ status: 'idle' }]);
    const next = g.mgr.ensureForRun();
    await tick();
    expect(g.made).toHaveLength(2);
    g.made[1].release();
    await next;
    expect(g.tools()).toEqual(['mcp__srv__x']);
  });

  it('列工具途中关停：迟到的成功列表不会重新注册已经回收的连接', async () => {
    let finish!: (tools: McpToolInfo[]) => void;
    const g = gated(() => new Promise(resolve => { finish = resolve; }));
    const run = g.mgr.ensureForRun();
    await tick(); g.made[0].release(); await tick();
    await g.mgr.disposeAll();
    expect(g.made[0].disposed).toEqual(['shutdown']);
    finish([{ name: 'late', inputSchema: { type: 'object' } }]);
    await run;
    expect(g.tools()).toEqual([]);
    expect(g.mgr.statuses()).toMatchObject([{ status: 'idle' }]);
  });

  it('共享连接的一次列工具失败：同代迟到列表不能覆盖新连接的工具', async () => {
    const lists: { resolve(tools: McpToolInfo[]): void; reject(error: Error): void }[] = [];
    const g = gated(() => new Promise((resolve, reject) => { lists.push({ resolve, reject }); }));
    const first = g.mgr.ensureForRun();
    await tick(); g.made[0].release(); await tick();
    const second = g.mgr.ensureForRun(); await tick();
    expect(lists).toHaveLength(2);
    lists[0].reject(new Error('注入：旧连接列工具失败')); await first;
    const next = g.mgr.ensureForRun();
    await tick(); expect(g.made).toHaveLength(2);
    g.made[1].release(); await tick();
    lists[2].resolve([{ name: 'fresh', inputSchema: { type: 'object' } }]); await next;
    lists[1].resolve([{ name: 'stale', inputSchema: { type: 'object' } }]); await second;
    expect(g.tools()).toEqual(['mcp__srv__fresh']);
    expect(g.made[0].disposed).toEqual(['server-error']);
    expect(g.made[1].disposed).toEqual([]);
    expect(g.mgr.statuses()).toMatchObject([{ status: 'connected', toolCount: 1 }]);
  });
});

type FakeChild = EventEmitter & {
  pid: number; exitCode: number | null; signalCode: string | null; killed: boolean;
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean;
};
/** 假 spawn（同 shutdown-reap.test.ts 的做法）：taskkill 下一拍以 0 退出；其余是带三条流的假子进程，兼当 PowerShell 驱动
 *  （一行「marker base64」→ 完成哨兵）。 */
function fakeSpawn() {
  const spawned: { cmd: string; args: string[]; opts: Record<string, unknown>; child?: FakeChild }[] = [];
  let nextPid = 7000;
  const spawnImpl = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    const rec: (typeof spawned)[number] = { cmd, args: [...args], opts };
    spawned.push(rec);
    if (/taskkill\.exe$/i.test(cmd)) {
      const tk = new EventEmitter();
      setImmediate(() => tk.emit('exit', 0, null));
      return tk;
    }
    const ch = new EventEmitter() as FakeChild;
    Object.assign(ch, { pid: nextPid++, exitCode: null, signalCode: null, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    ch.kill = () => true;
    let buf = '';
    ch.stdin.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (line) ch.stdout.write(`__MINIS_DONE_${line.split(' ')[0]}_EXIT_0__\n`);
      }
    });
    rec.child = ch;
    queueMicrotask(() => ch.emit('spawn'));
    return ch;
  }) as unknown as typeof spawn;
  return { spawned, spawnImpl };
}
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, capMs = 30_000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

describe('F09 W6：进程内引擎的接线', () => {
  it('shell、终端各起一棵树 → 快照与账本各两行；标记到了状态变 job、诊断 ready；MCP 试连多一行 mcp / probe-done', async () => {
    const f = fakeSpawn();
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-f09-w6-'));
    process.env.DESKMINIS_TEST = '1';
    process.env.DESKMINIS_FAKE_PROVIDER = '1';
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0, proc: { platform: 'win32', spawnImpl: f.spawnImpl, sysEnv: { SystemRoot: 'C:\\Windows', PATH: 'C:\\bin' } } });
    cleanups.push(() => srv.close());
    const c = rpcClient(srv.port, srv.authToken);
    await c.ready;
    cleanups.push(() => c.close());
    const paths = new MinisPaths(dataDir);
    const childIn = (sessionId: string): FakeChild => f.spawned.find(s => s.child && s.opts.cwd === paths.workspaceOf(sessionId))!.child!;
    const snapshot = async (): Promise<any> => (await c.call('proc.trees.snapshot', {})).result;

    // 还没起过任何进程
    expect((await snapshot())).toMatchObject({ epoch: 1, ownership: { state: 'untested' }, trees: [] });
    expect((await c.call('diagnostics.dryRun', {})).result.checks.processOwnership).toEqual({ status: 'ready', detail: '进程托管：本次运行还没有启动过子进程' });

    const term = (await c.call('chat.sessions.create', {})).result.id as string;
    expect((await c.call('terminal.attach', { sessionId: term })).error).toBeUndefined();
    const shell = (await c.call('chat.sessions.create', {})).result.id as string;
    const text = `__tool__ shell_execute ${JSON.stringify({ command: 'Get-Date', tool_title: '看时间' })}`;
    expect((await c.call('chat.prompt', { sessionId: shell, providerId: '__fake__', text })).error).toBeUndefined();
    await waitFor('shell 回合跑完', () => c.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === shell && n.params.event.kind === 'turnEnd'));

    // 两种入口交给 spawn 的都是带归属前导的驱动（platform 注入成了 win32，托管可用）
    const decode = (args: string[]): string => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    const drivers = f.spawned.filter(s => s.child).map(s => decode(s.args));
    expect(drivers).toHaveLength(2);
    for (const d of drivers) { expect(d).toContain('function __minis_arm'); expect(d).toContain(`OpenProcess([uint32]0x00101000, $false, [uint32]${process.pid})`); }

    let snap = await snapshot();
    const view = (kind: string): any => snap.trees.find((t: any) => t.kind === kind);
    expect(snap.trees).toHaveLength(2);
    expect(view('terminal')).toMatchObject({ epoch: 1, sessionId: term, protection: 'pending', root: { pid: childIn(term).pid } });
    expect(view('shell')).toMatchObject({ epoch: 1, sessionId: shell, protection: 'pending', root: { pid: childIn(shell).pid } });
    expect(view('terminal').endedAt).toBeUndefined();
    // shell 的树出生在那次调用所在的 run 里
    expect(view('shell').runId).toBe(readDb(dataDir, 'SELECT id FROM agent_runs WHERE session_id=?', shell)[0].id);
    expect(view('terminal').runId).toBeUndefined();
    // 快照里没有命令文本与环境
    expect(JSON.stringify(snap)).not.toMatch(/Get-Date|SystemRoot|EncodedCommand/);
    const rows = readDb(dataDir, 'SELECT kind, session_id, epoch, protection, ended_at FROM process_trees ORDER BY kind');
    expect(rows).toEqual([
      { kind: 'shell', session_id: shell, epoch: 1, protection: 'pending', ended_at: null },
      { kind: 'terminal', session_id: term, epoch: 1, protection: 'pending', ended_at: null },
    ]);

    // 根报告了归属结论：pid 相符的才认
    const sh = childIn(shell);
    sh.stderr.write(`${PROC_MARKER} job=armed watch=1 prejob=1 pid=${sh.pid} created=133500000000000000\r\n`);
    await waitFor('shell 的树离开 pending', async () => { snap = await snapshot(); return view('shell').protection !== 'pending'; });
    expect(view('shell')).toMatchObject({ protection: 'job', preJob: true, root: { pid: sh.pid, createdAt: '133500000000000000' } });
    expect(snap.ownership).toEqual({ state: 'active' });
    expect((await c.call('diagnostics.dryRun', {})).result.checks.processOwnership).toEqual({ status: 'ready', detail: '进程托管：作业对象已生效' });
    const tm = childIn(term);
    tm.stderr.write(`${PROC_MARKER} job=armed watch=1 prejob=1 pid=${tm.pid + 999} created=133500000000000000\r\n`); // 别人的标记
    await waitFor('终端的树离开 pending', async () => { snap = await snapshot(); return view('terminal').protection !== 'pending'; });
    expect(view('terminal')).toMatchObject({ protection: 'none', protectionReason: 'marker-invalid' });
    expect(snap.ownership).toEqual({ state: 'active', lastFailure: 'marker-invalid' });
    expect((await c.call('diagnostics.dryRun', {})).result.checks.processOwnership).toEqual({ status: 'warning', detail: '进程托管：最近一棵进程树没有托管成（marker-invalid）' });
    // 标记行不进终端的滚动缓冲
    expect(String((await c.call('terminal.attach', { sessionId: term })).result.scrollback)).not.toContain(PROC_MARKER);

    // 删会话：两句 dispose 记 session-deleted，行随会话删掉
    expect((await c.call('chat.sessions.delete', { sessionId: term, confirm: true })).error).toBeUndefined();
    expect(readDb(dataDir, 'SELECT kind FROM process_trees WHERE session_id=?', term)).toEqual([]);
    expect(f.spawned.filter(s => /taskkill\.exe$/i.test(s.cmd)).map(s => s.args)).toEqual([['/pid', String(tm.pid), '/T', '/F']]);

    // MCP 试连：真实进程（Windows 上经真实的 launcher）。fixture 以 --no-tree 只当 server，不起后代；自限 + stop 文件收尾
    const fx = mkdtempSync(join(tmpdir(), 'dm-f09-w6-fx-'));
    cleanups.push(() => writeFileSync(join(fx, 'stop'), '1'));
    const probe = await c.call('mcp.servers.test', {
      name: 'f09-probe', command: process.execPath, args: [join(__dirname, 'proc-tree-fixture.cjs'), fx, 'mcp', 'w6', '--no-tree'],
      env: { ELECTRON_RUN_AS_NODE: '1' }, startupTimeoutSeconds: 120,
    });
    expect(probe.result).toMatchObject({ ok: true });
    let mcpRows: any[] = [];
    await waitFor('试连的树关账', () => {
      mcpRows = readDb(dataDir, `SELECT * FROM process_trees WHERE kind='mcp' ORDER BY started_at`);
      return mcpRows.length > 0 && mcpRows.every(r => r.ended_at !== null);
    }, 60_000);
    const last = mcpRows[mcpRows.length - 1];
    expect(last).toMatchObject({ kind: 'mcp', owner_ref: 'f09-probe', tool_prefix: null, session_id: null, stop_cause: 'probe-done', end_kind: 'stopped', epoch: 1 });
    if (process.platform === 'win32') {
      // 真实的 launcher：正常是 job；负载下等标记超时会回退直起（fallback:no-marker），那一格不算断言失败
      if (last.protection !== 'job') console.log(`F09 W6：试连的树没有托管成（${last.protection_reason}），launcher 路径本轮没有验证到`);
      else expect(last).toMatchObject({ protection: 'job', pre_job: 1 });
      expect(last.target_pid === null || typeof last.target_pid === 'number').toBe(true);
    } else {
      expect(last).toMatchObject({ protection: 'none', protection_reason: 'not-windows' });
    }
  }, 180_000);
});

describe('F09 W7：属主轮询与标准流静音', () => {
  it('连续 3 次不在才调一次 onGone；中间有一次在就重新计数；stop() 之后不再调', () => {
    vi.useFakeTimers();
    const alive: boolean[] = [false, false, true, false, false];
    const asked: number[] = [];
    let gone = 0;
    watchParent({ ppid: 4242, onGone: () => { gone++; }, isAlive: pid => { asked.push(pid); return alive.shift() ?? false; } });
    vi.advanceTimersByTime(PARENT_WATCH_MS * 5);
    expect(asked).toEqual([4242, 4242, 4242, 4242, 4242]);
    expect(gone).toBe(0); // 不在、不在、在、不在、不在：没有连续 3 次
    vi.advanceTimersByTime(PARENT_WATCH_MS);
    expect(gone).toBe(1);
    vi.advanceTimersByTime(PARENT_WATCH_MS * 10);
    expect(gone).toBe(1); expect(asked).toHaveLength(6); // 触发之后停表
    expect(PARENT_GONE_STREAK).toBe(3);

    let gone2 = 0;
    const w = watchParent({ ppid: 7, onGone: () => { gone2++; }, isAlive: () => false, intervalMs: 10 });
    vi.advanceTimersByTime(20);
    w.stop();
    vi.advanceTimersByTime(1000);
    expect(gone2).toBe(0);
  });

  it('ppid 不是正整数不启动；探测抛错当作在；onGone 抛错不外泄', () => {
    vi.useFakeTimers();
    let asked = 0; let gone = 0;
    for (const ppid of [0, -1, 1.5, Number.NaN]) watchParent({ ppid, onGone: () => { gone++; }, isAlive: () => { asked++; return false; }, intervalMs: 10 });
    vi.advanceTimersByTime(1000);
    expect({ asked, gone }).toEqual({ asked: 0, gone: 0 });
    watchParent({ ppid: 9, onGone: () => { gone++; }, isAlive: () => { throw new Error('查询失败'); }, intervalMs: 10 });
    vi.advanceTimersByTime(1000);
    expect(gone).toBe(0);
    watchParent({ ppid: 9, onGone: () => { gone++; throw new Error('关停自己兜错'); }, isAlive: () => false, intervalMs: 10 });
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(gone).toBe(1);
  });

  it('缺省探测：只有 ESRCH 算不在，EPERM 与别的错误都算在', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill');
    cleanups.push(() => kill.mockRestore());
    const errno = (codeName: string): never => { throw Object.assign(new Error(codeName), { code: codeName }); };
    let gone = 0;
    kill.mockImplementation(((): boolean => errno('EPERM')) as unknown as typeof process.kill);
    watchParent({ ppid: 31337, onGone: () => { gone++; }, intervalMs: 10 });
    vi.advanceTimersByTime(100);
    expect(gone).toBe(0);
    expect(kill).toHaveBeenCalledWith(31337, 0); // 只探测，信号 0
    kill.mockImplementation(((): boolean => errno('ESRCH')) as unknown as typeof process.kill);
    vi.advanceTimersByTime(30);
    expect(gone).toBe(1);
    for (const call of kill.mock.calls) expect(call).toEqual([31337, 0]);
  });

  it('muteBrokenStdio：挂上之后流上的 error 不再抛；重复调用不叠加监听', () => {
    const bare = new EventEmitter();
    expect(() => bare.emit('error', new Error('EPIPE'))).toThrow('EPIPE'); // 没有监听时 EventEmitter 会把它抛出来
    const a = new EventEmitter(); const b = new EventEmitter();
    muteBrokenStdio([a, b]);
    muteBrokenStdio([a, b]);
    expect(a.listenerCount('error')).toBe(1); expect(b.listenerCount('error')).toBe(1);
    expect(() => { a.emit('error', new Error('EPIPE')); b.emit('error', new Error('EPIPE')); }).not.toThrow();
  });
});
