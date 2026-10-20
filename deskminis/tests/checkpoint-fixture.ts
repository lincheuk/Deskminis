/**
 * F08 fixture（不是测试）：检查点各组用例的公共件。
 *
 * 全部在真实文件系统上跑：每个环境 mkdtemp 一个数据根与一个独立的「用户目录」（数据根之外、没有 .git），
 * 库是 openDb 的真实 SQLite，存储是真实的 CheckpointStore，账本、调度器、三个写工具都是真的。
 * 断言以磁盘字节、文件 ID 与库里的行为准，不以返回值为准。绝不碰用户的真实文件、真实数据根与本仓库的工作区。
 *
 * 这个文件 import F08 的新模块，只给 C / S / R / K / G 组与 checkpoint-minisd-wired 用；
 * 留红基线的 checkpoint-minisd.test.ts 不 import 它。
 */
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunRecorder } from '../src/minisd/agent/run-recorder';
import { nodeFileIo, type FileIo, type IoPoint } from '../src/minisd/checkpoints/fs';
import { CheckpointService } from '../src/minisd/checkpoints/restore';
import { CheckpointStore, type CheckpointStoreOptions } from '../src/minisd/checkpoints/store';
import { MinisPaths } from '../src/minisd/paths';
import { powershellPath } from '../src/minisd/proc/win-exec';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import { RunLedger, type RunHandle } from '../src/minisd/store/run-ledger';
import { fileEditTool, fileWriteTool } from '../src/minisd/tools/files';
import { officeWriteTool } from '../src/minisd/tools/office';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ToolScheduler, type ScheduledResult } from '../src/minisd/tools/scheduler';
import type { PermissionGateway, ToolContext } from '../src/minisd/tools/types';
import { allowAll } from './scheduler-fixture';

export const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// ---------- 记录调用、可注入故障的 FileIo ----------

type Op = Exclude<keyof FileIo, 'at' | 'syncDir'>;
export interface IoCall { op: string; path: string; from?: string }
type PathPred = (path: string) => boolean;

export interface RecIo extends FileIo {
  calls: IoCall[];
  /** 之后每次（或只第 nth 次，从 1 起）对匹配路径的 op 抛带错误码的错。rename / linkExclusive 的路径是目标。 */
  fail(op: Op, pred: PathPred, code: string, nth?: number): void;
  /** 在指定注入点、或某个 op 被调到（执行之前）的那一刻同步回调。nth：只在第 nth 次匹配时回调。 */
  hook(at: IoPoint | Op, fn: (info: { path: string; tmp?: string }) => void, o?: { nth?: number; pred?: PathPred }): void;
  /** 换掉某个 op 的实现（base 是原实现）。 */
  replace<K extends Op>(op: K, impl: (base: FileIo[K]) => FileIo[K]): void;
  /** 到 point 时先取库快照，此后每个操作都抛：磁盘停在那一刻。返回快照路径的取值函数。 */
  crash(point: IoPoint, snapshot: () => string): void;
  crashedSnapshot(): string | undefined;
  /** 撤掉所有注入（记录保留）。 */
  reset(): void;
  /** 对匹配路径的 op 调用记录。 */
  callsOf(op: string, pred?: PathPred): IoCall[];
}

export function recIo(base: FileIo = nodeFileIo): RecIo {
  let fails: { op: string; pred: PathPred; code: string; nth?: number; seen: number }[] = [];
  let hooks: { at: string; fn: (info: { path: string; tmp?: string }) => void; nth?: number; pred?: PathPred; seen: number }[] = [];
  let replaced = new Map<string, (...a: any[]) => any>();
  let crashAt: { point: IoPoint; snapshot: () => string } | undefined;
  let snap: string | undefined;
  let crashed = false;
  const calls: IoCall[] = [];
  const coded = (code: string, what: string): Error => Object.assign(new Error(`${code}: 注入的故障, ${what}`), { code });

  const guard = (op: string, path: string, from?: string): void => {
    calls.push(from === undefined ? { op, path } : { op, path, from });
    if (crashed) throw coded('ECRASHED', `${op} '${path}'`);
    for (const h of hooks) {
      if (h.at !== op || (h.pred && !h.pred(path))) continue;
      h.seen += 1;
      if (h.nth === undefined || h.nth === h.seen) h.fn({ path });
    }
    for (const f of fails) {
      if (f.op !== op || !f.pred(path)) continue;
      f.seen += 1;
      if (f.nth === undefined || f.nth === f.seen) throw coded(f.code, `${op} '${path}'`);
    }
  };
  const impl = <K extends Op>(op: K): FileIo[K] => {
    const r = replaced.get(op);
    const b = (base[op] as (...a: any[]) => any).bind(base);
    return (r ? r(b) : b) as FileIo[K];
  };

  const io: RecIo = {
    calls,
    lstat: p => { guard('lstat', p); return impl('lstat')(p); },
    readStable: p => { guard('readStable', p); return impl('readStable')(p); },
    writeDurable: (p, d, m) => { guard('writeDurable', p); impl('writeDurable')(p, d, m); },
    rename: (from, to) => { guard('rename', to, from); impl('rename')(from, to); },
    overwriteInPlace: (p, d) => { guard('overwriteInPlace', p); impl('overwriteInPlace')(p, d); },
    linkExclusive: (from, to) => { guard('linkExclusive', to, from); impl('linkExclusive')(from, to); },
    unlink: p => { guard('unlink', p); impl('unlink')(p); },
    mkdirp: d => { guard('mkdirp', d); impl('mkdirp')(d); },
    writable: p => { guard('writable', p); return impl('writable')(p); },
    realpath: p => { guard('realpath', p); return impl('realpath')(p); },
    readdir: d => { guard('readdir', d); return impl('readdir')(d); },
    syncDir: d => { base.syncDir?.(d); },
    at(point, info) {
      calls.push({ op: `at:${point}`, path: info.path });
      if (crashed) throw coded('ECRASHED', point);
      if (crashAt && crashAt.point === point) {
        snap = crashAt.snapshot();
        crashed = true;
        throw coded('ECRASHED', point);
      }
      for (const h of hooks) {
        if (h.at !== point) continue;
        h.seen += 1;
        if (h.nth === undefined || h.nth === h.seen) h.fn(info);
      }
    },
    fail(op, pred, code, nth) { fails.push({ op, pred, code, nth, seen: 0 }); },
    hook(at, fn, o) { hooks.push({ at, fn, nth: o?.nth, pred: o?.pred, seen: 0 }); },
    replace(op, f) { replaced.set(op, f as (...a: any[]) => any); },
    crash(point, snapshot) { crashAt = { point, snapshot }; },
    crashedSnapshot: () => snap,
    reset() { fails = []; hooks = []; replaced = new Map(); crashAt = undefined; crashed = false; },
    callsOf: (op, pred) => calls.filter(c => c.op === op && (!pred || pred(c.path))),
  };
  return io;
}

// ---------- 环境 ----------

export interface FileSnap { bytes: Buffer; ino: string; mtimeNs: string; nlink: number }

export interface CpEnvOptions {
  /** 存储的注入项（quotaBytes、maxFileBytes、now…）。io 缺省是这个环境的 recIo。 */
  store?: Partial<CheckpointStoreOptions>;
  /** 恢复取锁的等待上限。 */
  lockWaitMs?: number;
  /** 调度器等别的会话放锁的上限。 */
  schedulerLockWaitMs?: number;
  /** 不给存储接账本（commit / tx 用缺省的立即事务）。 */
  plainTx?: boolean;
}

export interface CpEnv {
  root: string; dbFile: string; db: Database.Database; ledger: RunLedger; chat: ChatStore;
  paths: MinisPaths; userDir: string; cpDir: string;
  io: RecIo; store: CheckpointStore; service: CheckpointService;
  scheduler: ToolScheduler; registry: ToolRegistry;
  /** 「正在运行」的会话（service 的 isSessionRunning 读它）。 */
  running: Set<string>;
  audits: { type: string; payload: any; sessionId?: string }[];
  changed: string[];
  /** 建一个会话，工作区绑到 userDir（或给定目录）：在里面写入免审。 */
  newSession(workspace?: string): string;
  /** 直接调工具用的上下文（带真实存储）。 */
  ctx(sessionId: string, extra?: Partial<ToolContext>): ToolContext;
  snapshotOf(path: string): FileSnap | undefined;
  /** 目录下每个文件（递归）的 sha256，键是相对路径（正斜杠）。 */
  tree(dir: string): Record<string, string>;
  /** file_checkpoints 的原始行（seq 升序）。 */
  rows(sessionId?: string): any[];
  /** checkpoints/blobs 下的全部文件名（哈希）。 */
  blobFiles(): string[];
  blobPath(hash: string): string;
  /** 同步取一份已提交状态的完整库副本，返回路径。 */
  snapshotDb(): string;
  /** 经真实调度器 + 运行记录器 + 账本跑一批调用（同一个 run）。 */
  runBatch(sessionId: string, calls: { name: string; input: Record<string, unknown> }[], o?: RunToolOptions): Promise<RunBatchResult>;
  runTool(sessionId: string, name: string, input: Record<string, unknown>, o?: RunToolOptions): Promise<RunToolResult>;
  close(): void;
}
export interface RunToolOptions {
  gateway?: PermissionGateway; signal?: AbortSignal;
  /** 跑完不结束 run（run 保持活动：它的检查点受保护）。返回的 handle 由调用方结束。 */
  keepRunActive?: boolean;
}
export interface RunBatchResult { results: ScheduledResult[]; runId: string; handle: RunHandle; execs: any[]; rows: any[] }
export interface RunToolResult { output: string; success: boolean; runId: string; handle: RunHandle; exec: any; rows: any[]; row: any | undefined }

const envs: CpEnv[] = [];
/** 用例收尾：关库、删临时目录。 */
export function closeAllCpEnvs(): void {
  for (const e of envs.splice(0)) { try { e.close(); } catch { /* 收尾尽力 */ } }
}

export function cpEnv(label: string, o: CpEnvOptions = {}): CpEnv {
  const root = mkdtempSync(join(tmpdir(), `dm-f08-${label}-root-`));
  const userDir = mkdtempSync(join(tmpdir(), `dm-f08-${label}-user-`));
  const dbFile = join(root, 'minis.db');
  const db = openDb(dbFile);
  const paths = new MinisPaths(root);
  const chat = new ChatStore(db);
  const workspaces = new Map<string, string>();
  paths.setWorkspaceResolver(sid => workspaces.get(sid));
  const ledger = new RunLedger(db, { warn: () => undefined });
  const io = recIo();
  const cpDir = join(root, 'checkpoints');
  const changed: string[] = [];
  const store = new CheckpointStore(db, cpDir, {
    ...(o.plainTx ? {} : { commit: fn => ledger.durableAtomic(fn), tx: fn => ledger.atomic(fn) }),
    io, warn: () => undefined, onChange: sid => { changed.push(sid); },
    ...o.store,
  });
  store.markSinceEpoch(ledger.epoch);
  const scheduler = new ToolScheduler({ lockWaitTimeoutMs: o.schedulerLockWaitMs });
  const registry = new ToolRegistry();
  registry.register(fileWriteTool); registry.register(fileEditTool); registry.register(officeWriteTool);
  const running = new Set<string>();
  const audits: CpEnv['audits'] = [];
  const service = new CheckpointService({
    store, paths, locks: scheduler.locks, io, lockWaitMs: o.lockWaitMs, warn: () => undefined,
    isSessionRunning: sid => running.has(sid),
    // F11B：已删除的会话（含保留副本）——与 index.ts 的接法相同，读真实的生命周期登记
    isSessionDeleted: sid => chat.isDeleted(sid),
    uncoveredCalls: () => new Map(),
    runMeta: ids => {
      const out = new Map<string, { generation: number; createdAt: number; state: string }>();
      for (const id of ids) {
        const r = db.prepare('SELECT generation, created_at, state FROM agent_runs WHERE id=?').get(id) as any;
        if (r) out.set(id, { generation: r.generation, createdAt: r.created_at, state: r.state });
      }
      return out;
    },
    audit: (type, payload, opts) => { audits.push({ type, payload, sessionId: opts.sessionId }); },
  });
  let snapNo = 0;
  let closed = false;
  let lastMsgAt = 0;

  const walk = (dir: string, rel: string, out: Record<string, string>): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, rel === '' ? name : `${rel}/${name}`, out);
      else if (st.isFile()) out[rel === '' ? name : `${rel}/${name}`] = sha(readFileSync(full));
      else out[rel === '' ? name : `${rel}/${name}`] = '<link>';
    }
  };

  const env: CpEnv = {
    root, dbFile, db, ledger, chat, paths, userDir, cpDir, io, store, service, scheduler, registry, running, audits, changed,
    newSession(workspace = userDir): string {
      const s = chat.createSession();
      paths.ensureSessionDirs(s.id);
      workspaces.set(s.id, workspace);
      return s.id;
    },
    ctx(sessionId, extra = {}): ToolContext {
      return { sessionId, paths, permissions: allowAll, checkpoints: store, ...extra };
    },
    snapshotOf(path) {
      const st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!st) return undefined;
      return { bytes: readFileSync(path), ino: String(st.ino), mtimeNs: String(st.mtimeNs), nlink: Number(st.nlink) };
    },
    tree(dir) { const out: Record<string, string> = {}; walk(dir, '', out); return out; },
    rows(sessionId) {
      return sessionId === undefined
        ? db.prepare('SELECT * FROM file_checkpoints ORDER BY seq').all()
        : db.prepare('SELECT * FROM file_checkpoints WHERE session_id=? ORDER BY seq').all(sessionId);
    },
    blobFiles() {
      const dir = join(cpDir, 'blobs');
      if (!existsSync(dir)) return [];
      return readdirSync(dir).flatMap(sub => readdirSync(join(dir, sub)));
    },
    blobPath: hash => join(cpDir, 'blobs', hash.slice(0, 2), hash),
    snapshotDb(): string {
      const p = join(root, `snap-${++snapNo}.db`);
      db.exec(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
      return p;
    },
    async runBatch(sessionId, calls, ro = {}) {
      const controller = new AbortController();
      const signal = ro.signal ?? controller.signal;
      const handle = ledger.beginRun({ sessionId, origin: { kind: 'user' } });
      // 时间严格递增：同一毫秒里落的两条消息谁是「最后一条」取决于随机的 id，运行恢复据此决定补不补结果消息
      const msg = (role: 'user' | 'assistant', text: string) => {
        lastMsgAt = Math.max(chat.nowEpoch(), lastMsgAt + 0.001);
        return chat.appendMessage({ id: chat.newId(), sessionId, role, parts: [{ type: 'text', value: text }], createdAt: lastMsgAt, streamInterruptCount: 0 });
      };
      handle.started(() => msg('user', '开始'));
      const recorder = createRunRecorder(ledger, handle.ref, { signal, warn: () => undefined });
      const scheduled = calls.map((c, i) => ({ toolUseId: `tu-${handle.ref.generation}-${i}`, name: c.name, input: JSON.stringify(c.input) }));
      recorder.persistAssistant(scheduled, () => msg('assistant', '调用工具'));
      running.add(sessionId);
      let results: ScheduledResult[];
      try {
        results = await scheduler.runBatch({
          calls: scheduled, registry, journal: recorder.journal, signal,
          ctx: { sessionId, paths, permissions: ro.gateway ?? allowAll, signal, checkpoints: store },
        });
      } finally { running.delete(sessionId); }
      try { recorder.persistResults(results, () => msg('user', '结果')); } catch { /* 账本关停等：用例自己断言 */ }
      if (!ro.keepRunActive) handle.end({ state: 'completed', reason: 'end_turn' });
      const execs = db.prepare('SELECT * FROM tool_executions WHERE run_id=? ORDER BY call_index').all(handle.ref.runId);
      const rows = db.prepare('SELECT * FROM file_checkpoints WHERE run_id=? ORDER BY seq').all(handle.ref.runId);
      return { results, runId: handle.ref.runId, handle, execs, rows };
    },
    async runTool(sessionId, name, input, ro = {}) {
      const b = await env.runBatch(sessionId, [{ name, input: { tool_title: '测试', ...input } }], ro);
      const r = b.results[0];
      return { output: r.outcome.output, success: r.outcome.success, runId: b.runId, handle: b.handle, exec: b.execs[0], rows: b.rows, row: b.rows[b.rows.length - 1] };
    },
    close(): void {
      if (closed) return;
      closed = true;
      try { ledger.close(); } catch { /* 已关 */ }
      try { db.close(); } catch { /* 已关 */ }
      for (const d of [root, userDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 上偶有占用，留给系统清 */ } }
    },
  };
  envs.push(env);
  return env;
}

/** 在一份库快照上开「下一代」：新账本、新存储（同一个检查点目录与用户目录）。返回的 close 只关这一代的库。 */
export function nextGeneration(env: CpEnv, snapshot: string): { db: Database.Database; ledger: RunLedger; store: CheckpointStore; service: CheckpointService; io: RecIo; close(): void } {
  const db = openDb(snapshot);
  const ledger = new RunLedger(db, { warn: () => undefined });
  const io = recIo();
  const store = new CheckpointStore(db, env.cpDir, { commit: fn => ledger.durableAtomic(fn), tx: fn => ledger.atomic(fn), io, warn: () => undefined });
  const chat = new ChatStore(db);
  const service = new CheckpointService({
    store, paths: env.paths, locks: new ToolScheduler().locks, io, warn: () => undefined,
    isSessionRunning: () => false, isSessionDeleted: sid => chat.isDeleted(sid), uncoveredCalls: () => new Map(), runMeta: () => new Map(),
  });
  return { db, ledger, store, service, io, close: () => { try { ledger.close(); } catch { /* 已关 */ } try { db.close(); } catch { /* 已关 */ } } };
}

// ---------- Windows 专用辅助 ----------

/** 目录联接（不需要管理员）。 */
export function junction(target: string, link: string): void {
  symlinkSync(target, link, 'junction');
}

/** 这台机器能不能建文件符号链接（Windows 上要开发者模式或管理员）。 */
export function canSymlink(): boolean {
  const d = mkdtempSync(join(tmpdir(), 'dm-f08-symlink-'));
  try {
    writeFileSync(join(d, 'a'), 'x');
    symlinkSync(join(d, 'a'), join(d, 'b'), 'file');
    return true;
  } catch { return false; }
  finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
}

/**
 * 起一个 PowerShell 以给定的共享方式只读打开文件，等它就绪后返回释放函数（释放后等它退出）。
 * share：'ReadWrite, Delete'（全共享只读句柄：改名失败、原地覆盖成功）、'Read'（读得到，改名与原地打开都失败）、
 * 'None'（连读都失败）。信号文件放在另一个临时目录里，不进被断言的用户目录。
 */
export async function holdOpen(path: string, share: 'ReadWrite, Delete' | 'Read' | 'None'): Promise<() => Promise<void>> {
  const d = mkdtempSync(join(tmpdir(), 'dm-f08-hold-'));
  const ready = join(d, 'ready'); const go = join(d, 'go');
  const q = (s: string): string => s.replace(/'/g, "''");
  const script = `$s=[IO.File]::Open('${q(path)}','Open','Read','${share}'); Set-Content -LiteralPath '${q(ready)}' -Value 1; `
    + `while(-not (Test-Path -LiteralPath '${q(go)}')){Start-Sleep -Milliseconds 20}; $s.Close()`;
  const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise<void>(r => { child.once('exit', () => r()); child.once('error', () => r()); });
  const deadline = Date.now() + 60_000;
  while (!existsSync(ready)) {
    if (child.exitCode !== null) throw new Error(`占用进程提前退出（share=${share}）`);
    if (Date.now() > deadline) { child.kill(); throw new Error(`占用进程没有就绪（share=${share}）`); }
    await new Promise(r => setTimeout(r, 20));
  }
  return async () => {
    writeFileSync(go, '1');
    await exited;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
  };
}
