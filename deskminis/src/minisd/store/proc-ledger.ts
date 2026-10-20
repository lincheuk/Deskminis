/**
 * F09 进程账本：每棵进程树（shell 驱动、终端驱动、stdio MCP）一行，记根的身份（PID 加创建时间）、托管状态、怎么结束的，
 * 并与 F05 的代次、run 关联。归属层（proc/owned.ts）经 ProcJournal 接缝写它；启动恢复用它给「结果未知」的调用补一句
 * 进程树的去向。
 *
 * 规则：
 *  - 每个方法各自兜住，失败只告警一次：账本写失败不能让 spawn 或回收失败。
 *  - UPDATE 都带 epoch 条件（closeOrphans 除外，它只动前代的行）：晚到的写入碰不到别的代次。
 *  - 库里的 PID 只用于展示与取证。恢复不结束任何进程、不起任何进程、不按 PID 做任何事——归属不了就不杀，只如实记录。
 *    本文件不引 child_process，也没有任何结束进程的调用（tests/proc-wiring.test.ts 守着）。
 *  - 对 F05 的表只读两处：opened / stopRequested 查 agent_runs 的活动 run；orphanNote 按 id 读 tool_executions 的
 *    claims_json 与 started_at。读不到、解析不了都当作「没有依据」。不写 F05 的任何表。
 *  - 行随会话删除（ChatStore.purgeSessionRows）；已删除的会话不再写行。其余的行启动时只留最近 PRUNE_KEEP 条已结束的。
 */
import type Database from 'better-sqlite3';
import type { ProcEndKind, ProcOwnershipStatus, ProcProtection, ProcSnapshot, ProcStopCause, ProcTreeKind, ProcTreeView } from '../../shared/proc';
import type { ProcJournal, ProcTreeMeta } from '../proc/owned';

/** 已结束的行保留条数。 */
const PRUNE_KEEP = 2000;
/** 快照里带的最近结束的树。 */
const SNAPSHOT_ENDED = 50;
/** MCP 工具全名超长时的截断形态（mcp/manager.ts 的 toolFullName）：前 52 个字符 + '_' + 12 位哈希 = 65。 */
const TRUNCATED_NAME_LENGTH = 65;
const TRUNCATED_NAME_KEEP = 52;
/** F04 资源声明里 MCP 服务器的那一条（tools/resource-locks.ts 的 claimKey：`named:` + `mcp:<服务器名>`）。 */
const MCP_CLAIM_PREFIX = 'named:mcp:';

/** 恢复文案（定稿，测试按字面量断言）。第一句只对作业内的进程下结论，并点明不在保证之内的那几类。 */
export const PROC_NOTE_JOB = '[进程] 这次调用所在的进程树由作业对象托管，树内的进程已随引擎停止由系统结束；已经产生的改动不会回滚。经系统服务、计划任务、提权、WSL / Docker 或桥命令另行启动的程序不在这棵树里，可能仍在运行。';
export const PROC_NOTE_UNVERIFIED = '[进程] 这次调用启动的进程没有被作业对象托管，引擎停止后可能仍在运行并继续产生改动；继续之前请先确认（任务管理器或相关文件），必要时手动结束。';

interface Row {
  id: string; epoch: number; kind: string; session_id: string | null; owner_ref: string | null; tool_prefix: string | null;
  run_id: string | null; root_pid: number | null; root_created: string | null; target_pid: number | null;
  protection: string; protection_reason: string | null; pre_job: number | null; started_at: number;
  stop_cause: string | null; stop_run_id: string | null; stop_at: number | null;
  ended_at: number | null; end_kind: string | null; exit_code: number | null; exit_signal: string | null;
  reaped: string | null; recovered_epoch: number | null;
}

function viewOf(r: Row): ProcTreeView {
  const v: ProcTreeView = { id: r.id, epoch: r.epoch, kind: r.kind as ProcTreeKind, protection: r.protection as ProcProtection, startedAt: r.started_at };
  if (r.session_id !== null) v.sessionId = r.session_id;
  if (r.owner_ref !== null) v.ownerRef = r.owner_ref;
  if (r.run_id !== null) v.runId = r.run_id;
  if (r.root_pid !== null) v.root = r.root_created !== null ? { pid: r.root_pid, createdAt: r.root_created } : { pid: r.root_pid };
  if (r.target_pid !== null) v.targetPid = r.target_pid;
  if (r.protection_reason !== null) v.protectionReason = r.protection_reason;
  if (r.pre_job !== null) v.preJob = r.pre_job === 1;
  if (r.stop_cause !== null) v.stopCause = r.stop_cause as ProcStopCause;
  if (r.stop_run_id !== null) v.stopRunId = r.stop_run_id;
  if (r.stop_at !== null) v.stopAt = r.stop_at;
  if (r.ended_at !== null) v.endedAt = r.ended_at;
  if (r.end_kind !== null) v.endKind = r.end_kind as ProcEndKind;
  if (r.exit_code !== null) v.exitCode = r.exit_code;
  if (r.exit_signal !== null) v.exitSignal = r.exit_signal;
  if (r.reaped === 'job' || r.reaped === 'unverified') v.reaped = r.reaped;
  if (r.recovered_epoch !== null) v.recoveredEpoch = r.recovered_epoch;
  return v;
}

export class ProcLedger implements ProcJournal {
  private readonly epoch: number;
  private readonly now: () => number;
  private readonly warn: (m: string, e?: unknown) => void;
  private closed = false;
  private warned = false;

  constructor(private readonly db: Database.Database, private readonly o: {
    epoch: number; status: () => ProcOwnershipStatus;
    /** 已删除的会话不再写行（ChatStore.isDeleted）。不给就不查。 */
    isSessionDeleted?: (sessionId: string) => boolean;
    now?: () => number; warn?: (m: string, e?: unknown) => void;
  }) {
    this.epoch = o.epoch;
    this.now = o.now ?? (() => Date.now() / 1000);
    this.warn = o.warn ?? ((m, e) => console.warn(m, e));
  }

  /** 各方法共用的兜底：封账之后是空操作；抛错只告警一次，返回缺省值。 */
  private safe<T>(what: string, dflt: T, fn: () => T): T {
    if (this.closed) return dflt;
    try { return fn(); } catch (e) {
      if (!this.warned) { this.warned = true; this.warn(`进程账本${what}失败（不影响进程的启动与回收；之后同类失败不再提示）:`, e); }
      return dflt;
    }
  }

  /** 该会话此刻的活动 run（F05）。查不到或查询失败返回 null。 */
  private activeRun(sessionId: string): string | null {
    try {
      const r = this.db.prepare('SELECT id FROM agent_runs WHERE session_id = ? AND active = 1').get(sessionId) as { id: string } | undefined;
      return r?.id ?? null;
    } catch { return null; }
  }

  opened(id: string, meta: ProcTreeMeta, root: { pid?: number }): void {
    this.safe('登记', undefined, () => {
      // 已删除的会话拒写：这棵树照常由归属层托管与回收，只是不留一行没人会清的记录
      if (meta.sessionId !== undefined && this.o.isSessionDeleted?.(meta.sessionId) === true) return;
      const runId = meta.kind === 'shell' && meta.sessionId !== undefined ? this.activeRun(meta.sessionId) : null;
      this.db.prepare(`INSERT INTO process_trees (id, epoch, kind, session_id, owner_ref, tool_prefix, run_id, root_pid, protection, started_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?)`)
        .run(id, this.epoch, meta.kind, meta.sessionId ?? null, meta.ownerRef ?? null, meta.toolPrefix ?? null, runId, root.pid ?? null, this.now());
    });
  }

  protection(id: string, p: Parameters<ProcJournal['protection']>[1]): void {
    this.safe('写托管状态', undefined, () => {
      this.db.prepare(`UPDATE process_trees SET protection = ?, protection_reason = ?, root_pid = COALESCE(?, root_pid),
        root_created = COALESCE(?, root_created), target_pid = COALESCE(?, target_pid), pre_job = COALESCE(?, pre_job)
        WHERE id = ? AND epoch = ?`)
        .run(p.protection, p.reason ?? null, p.root?.pid ?? null, p.root?.createdAt ?? null, p.targetPid ?? null,
          p.preJob === undefined ? null : p.preJob ? 1 : 0, id, this.epoch);
    });
  }

  stopRequested(id: string, cause: ProcStopCause): void {
    this.safe('写回收原因', undefined, () => {
      const row = this.db.prepare('SELECT session_id FROM process_trees WHERE id = ? AND epoch = ? AND stop_cause IS NULL AND ended_at IS NULL')
        .get(id, this.epoch) as { session_id: string | null } | undefined;
      if (!row) return; // 只记第一次；已结束的不记
      const stopRunId = (cause === 'cancel' || cause === 'timeout') && row.session_id !== null ? this.activeRun(row.session_id) : null;
      this.db.prepare('UPDATE process_trees SET stop_cause = ?, stop_run_id = ?, stop_at = ? WHERE id = ? AND epoch = ? AND stop_cause IS NULL AND ended_at IS NULL')
        .run(cause, stopRunId, this.now(), id, this.epoch);
    });
  }

  ended(id: string, e: Parameters<ProcJournal['ended']>[1]): void {
    this.safe('关账', undefined, () => {
      // 行可能已随会话删除：改到 0 行，不报错
      this.db.prepare('UPDATE process_trees SET ended_at = ?, end_kind = ?, exit_code = ?, exit_signal = ? WHERE id = ? AND epoch = ? AND ended_at IS NULL')
        .run(this.now(), e.kind, e.exitCode, e.signal, id, this.epoch);
    });
  }

  /**
   * 启动恢复：把前代没关账的行关掉，返回它们。只写库，不碰任何进程。不抛。
   *  - end_kind：发起过回收（有 stop_cause）→ stopped；否则 engine-lost（引擎停止时这棵树还开着）。
   *  - reaped：当时 protection 是 job → job（整棵树已随引擎由系统结束，依据是根当时自己的报告加内核语义）；
   *    其余（含 pending）→ unverified（没有依据，可能仍在运行）。
   */
  closeOrphans(): ProcTreeView[] {
    return this.safe('恢复关账', [] as ProcTreeView[], () => {
      const now = this.now();
      const close = this.db.transaction((): Row[] => {
        const rows = this.db.prepare('SELECT * FROM process_trees WHERE epoch < ? AND ended_at IS NULL ORDER BY started_at').all(this.epoch) as Row[];
        const upd = this.db.prepare('UPDATE process_trees SET ended_at = ?, end_kind = ?, reaped = ?, recovered_epoch = ? WHERE id = ? AND ended_at IS NULL');
        for (const r of rows) {
          r.end_kind = r.stop_cause !== null ? 'stopped' : 'engine-lost';
          r.reaped = r.protection === 'job' ? 'job' : 'unverified';
          r.ended_at = now; r.recovered_epoch = this.epoch;
          upd.run(now, r.end_kind, r.reaped, this.epoch, r.id);
        }
        return rows;
      });
      return close().map(viewOf);
    });
  }

  /**
   * F05 恢复文案的补充：只有能唯一确定「这次调用跑在哪棵树上」时才加话；任何一步对不上都返回 undefined，F05 的文案原样。
   * 没有「猜不中就按全部树下结论」的兜底。只对前代的行作答（x.epoch < 本代）。只读，不抛。
   *
   * 候选的树一律限定为 epoch = x.epoch，且 ended_at IS NULL 或 recovered_epoch IS NOT NULL（引擎停止时还开着的；
   * 在那一代里已经结束的树与这次中断无关）。
   *  - shell_execute：同会话、kind = 'shell' 的最新一棵。
   *  - mcp__ 开头：三个条件同时成立——① 那次调用的资源声明里恰有一条 named:mcp:<服务器名原文>；② 树的 kind = 'mcp'、
   *    owner_ref 等于它、带 tool_prefix（排除试连的树）、不晚于那次调用开始；③ 工具名与这棵树的前缀相符（含全名被截断的情形）。
   *    为什么这么严：streamable-http 的 MCP 工具同样叫 mcp__<server>__<tool>，却没有进程树——远端的操作可能还在进行；
   *    规范化后的服务器名会相同（a.b 与 a_b）或互为前缀（a 与 a__b），只按前缀会对上别人的树。多棵时取最保守的结论。
   *  - 其它工具、没查到树、声明为空 / 解析不了 / 没有或不止一条：undefined。
   */
  orphanNote(x: { executionId: string; sessionId: string; name: string; epoch: number }): string | undefined {
    return this.safe('查询', undefined as string | undefined, () => {
      if (!(x.epoch < this.epoch)) return undefined;
      const open = 'epoch = ? AND (ended_at IS NULL OR recovered_epoch IS NOT NULL)';
      let trees: Pick<Row, 'protection'>[];
      if (x.name === 'shell_execute') {
        trees = this.db.prepare(`SELECT protection FROM process_trees WHERE ${open} AND kind = 'shell' AND session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`)
          .all(x.epoch, x.sessionId) as Pick<Row, 'protection'>[];
      } else if (x.name.startsWith('mcp__')) {
        const exec = this.db.prepare('SELECT claims_json, started_at FROM tool_executions WHERE id = ?').get(x.executionId) as { claims_json: string | null; started_at: number | null } | undefined;
        if (!exec || exec.claims_json === null || exec.started_at === null) return undefined;
        let claims: unknown;
        try { claims = JSON.parse(exec.claims_json); } catch { return undefined; }
        if (!Array.isArray(claims)) return undefined;
        const servers = claims.filter((c): c is string => typeof c === 'string' && c.startsWith(MCP_CLAIM_PREFIX));
        if (servers.length !== 1) return undefined;
        const server = servers[0].slice(MCP_CLAIM_PREFIX.length);
        const rows = this.db.prepare(`SELECT protection, tool_prefix FROM process_trees WHERE ${open} AND kind = 'mcp' AND owner_ref = ? AND tool_prefix IS NOT NULL AND started_at <= ?`)
          .all(x.epoch, server, exec.started_at) as { protection: string; tool_prefix: string }[];
        trees = rows.filter(r => x.name.startsWith(r.tool_prefix)
          || (x.name.length === TRUNCATED_NAME_LENGTH && r.tool_prefix.length > TRUNCATED_NAME_KEEP && r.tool_prefix.startsWith(x.name.slice(0, TRUNCATED_NAME_KEEP))));
      } else {
        return undefined;
      }
      if (trees.length === 0) return undefined;
      return trees.every(t => t.protection === 'job') ? PROC_NOTE_JOB : PROC_NOTE_UNVERIFIED;
    });
  }

  /** 本代全部未结束的树 + 最近结束的 50 棵（含恢复关账的）。内容只有 PID、会话 id、服务器名与状态，没有命令文本与环境。 */
  snapshot(): ProcSnapshot {
    const trees = this.safe('快照', [] as ProcTreeView[], () => {
      const open = this.db.prepare('SELECT * FROM process_trees WHERE epoch = ? AND ended_at IS NULL ORDER BY started_at').all(this.epoch) as Row[];
      const ended = this.db.prepare('SELECT * FROM process_trees WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT ?').all(SNAPSHOT_ENDED) as Row[];
      // F11B：保留副本的账本仍在库中，但已删除的会话不显示；显式恢复后可再查看。
      return [...open, ...ended]
        .filter(r => r.session_id === null || this.o.isSessionDeleted?.(r.session_id) !== true)
        .map(viewOf);
    });
    return { epoch: this.epoch, takenAt: this.now(), ownership: this.o.status(), trees };
  }

  /** 已结束的行只留最近 2000 条（未关账的行不删）。不抛。 */
  prune(): void {
    this.safe('清理', undefined, () => {
      this.db.prepare(`DELETE FROM process_trees WHERE ended_at IS NOT NULL AND rowid NOT IN
        (SELECT rowid FROM process_trees WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT ?)`).run(PRUNE_KEEP);
    });
  }

  /** 有序关停时调：此后一切写入是空操作（没赶上关账的行由下一代关）。不抛。 */
  close(): void { this.closed = true; }
}
