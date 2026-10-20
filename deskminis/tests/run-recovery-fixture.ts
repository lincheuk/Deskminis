/**
 * F05 fixture（不是测试）：账本单元、循环级与进程内崩溃模型用的公共件。
 *
 * 进程内的崩溃模型：在故障点同步取库快照（VACUUM INTO，那一刻已提交状态的完整副本），原进程继续跑完；
 * 再在副本上开新一代账本做恢复。故障点全部取自实现之外（循环事件、工具进门、权限卡发出、工具的副作用回调）。
 * 它模拟的是「已提交状态」，不模拟写到一半的页——SQLite 自己保证事务原子性。真实进程的强杀在 run-recovery-process.test.ts。
 *
 * 与 run-ledger-fixture.ts 分开：那个文件不引 F05 的新模块（M、R、Q 三组要在基线上跑得起来），这个文件引。
 */
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProvider } from '../src/minisd/providers/types';
import type { PermissionAskOptions, PermissionDecision, PermissionDenied, PermissionGateway, PermissionOutcome, PermissionRequest } from '../src/minisd/tools/types';
import { runAgentLoop, type LoopEvent } from '../src/minisd/agent/loop';
import type { OffloadEngine } from '../src/minisd/agent/offload';
import { createRunRecorder, type RunRecorder } from '../src/minisd/agent/run-recorder';
import { recoverOnBoot, type RecoveryDeps, type RecoveryReport } from '../src/minisd/agent/run-recovery';
import { CronStore } from '../src/minisd/cron/store';
import { MinisPaths } from '../src/minisd/paths';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import { RunLedger, type RunHandle } from '../src/minisd/store/run-ledger';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ToolScheduler } from '../src/minisd/tools/scheduler';
import { Trace, allowAll } from './scheduler-fixture';

/** 能挂钩子的 Trace：某一笔出现的那一刻同步回调（用来在「工具进门」这类时刻取库快照）。 */
export class HookTrace extends Trace {
  private hooks = new Map<string, () => void>();
  on(line: string, fn: () => void): void { this.hooks.set(line, fn); }
  override log(s: string): void {
    super.log(s);
    const h = this.hooks.get(s);
    if (h) { this.hooks.delete(s); h(); }
  }
}

export interface LedgerEnv {
  root: string; file: string; db: Database.Database; paths: MinisPaths; store: ChatStore; tools: ToolRegistry;
  ledger: RunLedger; scheduler: ToolScheduler;
  newSession(): string;
  /** 同步取一份已提交状态的完整副本，返回路径。 */
  snapshot(): string;
  /** 旁路连接（另开一个连接读写同一个库文件）。 */
  side(): Database.Database;
}

/** 真实 SQLite 文件库 + 账本 + 自己的调度器（不与别的用例共用锁表）。 */
export function ledgerEnv(label: string): LedgerEnv {
  const root = mkdtempSync(join(tmpdir(), `dm-f05-${label}-`));
  const file = join(root, 'minis.db');
  const db = openDb(file);
  const paths = new MinisPaths(root);
  const store = new ChatStore(db);
  const tools = new ToolRegistry();
  const ledger = new RunLedger(db, { warn: () => undefined });
  const scheduler = new ToolScheduler();
  let snapNo = 0;
  return {
    root, file, db, paths, store, tools, ledger, scheduler,
    newSession(): string {
      const s = store.createSession();
      paths.ensureSessionDirs(s.id);
      return s.id;
    },
    snapshot(): string {
      const p = join(root, `snap-${++snapNo}.db`);
      db.exec(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
      return p;
    },
    side(): Database.Database { return new Database(file); },
  };
}

export interface StartedRun {
  controller: AbortController; handle: RunHandle; recorder: RunRecorder;
  events: LoopEvent[]; done: Promise<LoopEvent[]>;
  /** 消费方每收到一个循环事件同步回调一次（生成器此刻停在这个 yield 上）。 */
  onEvent(l: (e: LoopEvent) => void): void;
}

/** 像 index.ts 那样起一个带账本的 run：beginRun → 落 user 消息 → 带记录器跑循环 → 终止事件时落终态。 */
export function startRun(
  env: LedgerEnv, sessionId: string, provider: AgentProvider,
  o: { gateway?: PermissionGateway; offload?: OffloadEngine; text?: string } = {},
): StartedRun {
  const controller = new AbortController();
  const handle = env.ledger.beginRun({ sessionId, origin: { kind: 'user' } });
  handle.started(() => env.store.appendMessage({
    id: env.store.newId(), sessionId, role: 'user', parts: [{ type: 'text', value: o.text ?? '开始' }],
    createdAt: env.store.nowEpoch(), streamInterruptCount: 0,
  }));
  const recorder = createRunRecorder(env.ledger, handle.ref, { signal: controller.signal, offload: o.offload, warn: () => undefined });
  const events: LoopEvent[] = [];
  const listeners: ((e: LoopEvent) => void)[] = [];
  const done = (async (): Promise<LoopEvent[]> => {
    for await (const e of runAgentLoop(env.store, {
      sessionId, provider, tools: env.tools,
      toolContext: { sessionId, paths: env.paths, permissions: o.gateway ?? allowAll, signal: controller.signal },
      systemPrompt: 'sys', signal: controller.signal, scheduler: env.scheduler, recorder, offloadEngine: o.offload,
    })) {
      events.push(e);
      for (const l of listeners) l(e);
      if (e.kind === 'turnEnd') handle.end({ state: 'completed', reason: e.stopReason });
      else if (e.kind === 'error') handle.end(controller.signal.aborted ? { state: 'cancelled', reason: 'user-stop' } : { state: 'failed', reason: 'error', detail: e.message });
    }
    return events;
  })();
  return { controller, handle, recorder, events, done, onEvent: l => { listeners.push(l); } };
}

export interface Recovered {
  db: Database.Database; chat: ChatStore; ledger: RunLedger; cron: CronStore; deps: RecoveryDeps; report: RecoveryReport;
  audits: { type: string; payload: any; sessionId?: string }[]; warns: string[];
}

/** 在库副本上开新一代账本。不做恢复（要注入失败的用例自己调 recoverOnBoot）。 */
export function openGeneration(path: string): Omit<Recovered, 'report'> {
  const db = openDb(path);
  const chat = new ChatStore(db);
  const ledger = new RunLedger(db, { warn: () => undefined });
  const cron = new CronStore(db);
  const audits: Recovered['audits'] = [];
  const warns: string[] = [];
  const deps: RecoveryDeps = {
    ledger, chat, cron,
    audit: (type, payload, opts) => { audits.push({ type, payload, sessionId: opts.sessionId }); },
    warn: msg => { warns.push(msg); },
  };
  return { db, chat, ledger, cron, deps, audits, warns };
}

/** 在库副本上做一次「重启」：开新一代账本 → recoverOnBoot。 */
export function recoverOn(path: string): Recovered {
  const g = openGeneration(path);
  return { ...g, report: recoverOnBoot(g.deps) };
}

/**
 * 会发卡的受控网关：规则判 'card' 的请求发一张卡（同步回报 onIssued），挂到测试放行 / 拒绝为止；
 * 'free' 的直接放行、不发卡（档位免审）；'deny' 的规则拦截。询问方取消时卡片按 cancelled 了结。
 */
export class IssuingGateway implements PermissionGateway {
  readonly issued: { id: string; req: PermissionRequest }[] = [];
  readonly noted: { req: PermissionRequest; denied: PermissionDenied; opts?: Pick<PermissionAskOptions, 'toolUseId' | 'origin'> }[] = [];
  /** 卡片发出、已回报给询问方之后同步回调（测试在这里取快照）。 */
  onCard?: (id: string, req: PermissionRequest) => void;
  private pending = new Map<string, (o: PermissionOutcome) => void>();
  private waiters: { n: number; resolve: () => void }[] = [];
  constructor(private rule: (req: PermissionRequest) => 'card' | 'free' | 'deny' = () => 'card') {}

  async check(req: PermissionRequest): Promise<PermissionDecision> { return (await this.decide(req)).decision; }

  decide(req: PermissionRequest, opts?: PermissionAskOptions): Promise<PermissionOutcome> {
    const r = this.rule(req);
    if (r === 'free') return Promise.resolve({ decision: 'allow', via: 'level-bypass' });
    if (r === 'deny') return Promise.resolve({ decision: 'deny', reason: 'rule-blocked', cause: 'level-not-allowed' });
    const id = `CARD-${this.issued.length + 1}`;
    this.issued.push({ id, req });
    const answer = new Promise<PermissionOutcome>(resolve => { this.pending.set(id, resolve); });
    opts?.signal?.addEventListener('abort', () => this.settle(id, { decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: id }), { once: true });
    try { opts?.onIssued?.(id); } catch { /* 观察者的错误不影响判定 */ }
    this.onCard?.(id, req);
    for (const w of this.waiters.filter(x => this.issued.length >= x.n)) w.resolve();
    this.waiters = this.waiters.filter(x => this.issued.length < x.n);
    return answer;
  }

  private settle(id: string, o: PermissionOutcome): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(o);
  }
  allow(id: string): void { this.settle(id, { decision: 'allow', via: 'user-once', requestId: id }); }
  deny(id: string): void { this.settle(id, { decision: 'deny', reason: 'user-denied', requestId: id }); }
  /** 等到累计发出 n 张卡。 */
  untilCards(n: number, timeoutMs = 3000): Promise<void> {
    if (this.issued.length >= n) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待第 ${n} 张权限卡超时（当前 ${this.issued.length} 张）`)), timeoutMs);
      this.waiters.push({ n, resolve: () => { clearTimeout(timer); resolve(); } });
    });
  }
  noteDenied(req: PermissionRequest, denied: PermissionDenied, opts?: Pick<PermissionAskOptions, 'toolUseId' | 'origin'>): void {
    this.noted.push({ req, denied, opts });
  }
  hasBridgeGrant(): boolean { return false; }
}

/** 直接读账本表的行（断言用）。 */
export function execRows(db: Database.Database, sessionId: string): any[] {
  return db.prepare('SELECT * FROM tool_executions WHERE session_id=? ORDER BY batch, call_index').all(sessionId);
}
export function runRows(db: Database.Database, sessionId: string): any[] {
  return db.prepare('SELECT * FROM agent_runs WHERE session_id=? ORDER BY generation').all(sessionId);
}
/** 历史里的全部 toolResult（按消息顺序）。 */
export function resultsOf(chat: ChatStore, sessionId: string): { toolUseId: string; output: string; success: boolean; status: string }[] {
  return chat.listMessages(sessionId).flatMap(m => m.parts).filter(p => p.type === 'toolResult')
    .map(p => p.value as { toolUseId: string; output: string; success: boolean; status: string });
}
