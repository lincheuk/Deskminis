import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { computeNextRun, validateSchedule, type ScheduleKind } from './schedule';

/** K1 定时任务存储（设计稿 2026-08-20-cron-design.md §1/§3）。
 *  next_run_at 在 create/update/markRun 时算定（epoch 秒），调度器 tick 只做
 *  「enabled 且到点」的查表（dueJobs）。
 *
 *  错过的任务（应用没在跑时过了点）：next_run_at 停在过去，下一次 tick 捞到就补跑一次，不分 kind——
 *  dueJobs 只看过没过点，应用启动后 3 秒那次检查（minisd/index.ts 的 cronBoot）就会把它们各补跑一次。
 *  补跑时 markRun 重算下一次：once 自动停用；interval/cron 从**当下**起算，所以错过几次也只补这一次（不逐次补）。
 *  W2b-11d 订正：这里原写 interval/cron 错过「从当下重算（不补跑）」，与 dueJobs 的实际行为相反。
 *  cron 设计稿 §0 原定 interval/cron 错过跳过、只补 once（怕开机时一起触发），实现从没按 kind 分过；
 *  定时页页头已按实际行为告诉用户「错过的任务下次启动时只补跑一次」（W2b-11a），止血波不改行为，注释跟着行为改。
 *  行为由 tests/cron-store.test.ts「错过的任务」一组钉住。 */
export interface CronJob {
  id: string; name: string; prompt: string;
  scheduleKind: ScheduleKind; scheduleValue: string;
  assistantId?: string; workspaceRoot?: string;
  enabled: boolean; nextRunAt?: number; lastRunAt?: number;
  lastSessionId?: string; lastStatus: string;
  createdAt: number; updatedAt: number;
}

interface Row {
  id: string; name: string; prompt: string;
  schedule_kind: string; schedule_value: string;
  assistant_id: string | null; workspace_root: string | null;
  enabled: number; next_run_at: number | null; last_run_at: number | null;
  last_session_id: string | null; last_status: string;
  created_at: number; updated_at: number;
}

const NAME_MAX = 50;
const PROMPT_MAX = 4000;
const STATUS_MAX = 300;

function toJob(r: Row): CronJob {
  return {
    id: r.id, name: r.name, prompt: r.prompt,
    scheduleKind: r.schedule_kind as ScheduleKind, scheduleValue: r.schedule_value,
    assistantId: r.assistant_id ?? undefined, workspaceRoot: r.workspace_root ?? undefined,
    enabled: r.enabled === 1, nextRunAt: r.next_run_at ?? undefined, lastRunAt: r.last_run_at ?? undefined,
    lastSessionId: r.last_session_id ?? undefined, lastStatus: r.last_status,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** next 计算（epoch 秒）；enabled=false 恒 null。once 的 null 语义 = 时间已过——
 *  create 前已被 validateSchedule 拦住，update 重开时同拦。 */
function nextSec(kind: ScheduleKind, value: string, fromMs: number): number | null {
  const ms = computeNextRun(kind, value, fromMs);
  return ms === null ? null : ms / 1000;
}

export class CronStore {
  constructor(private db: Database.Database) {}

  nowEpoch(): number { return Date.now() / 1000; }
  newId(): string { return randomUUID().toUpperCase(); }

  list(): CronJob[] {
    const rows = this.db.prepare('SELECT * FROM cron_jobs ORDER BY created_at ASC, rowid ASC').all() as Row[];
    return rows.map(toJob);
  }

  get(id: string): CronJob | undefined {
    const r = this.db.prepare('SELECT * FROM cron_jobs WHERE id=?').get(id) as Row | undefined;
    return r ? toJob(r) : undefined;
  }

  create(input: { name: string; prompt: string; scheduleKind: ScheduleKind; scheduleValue: string; assistantId?: string; workspaceRoot?: string }): CronJob {
    const name = String(input.name ?? '').trim().slice(0, NAME_MAX);
    const prompt = String(input.prompt ?? '').slice(0, PROMPT_MAX);
    if (!name) throw new Error('任务名称不能为空');
    if (!prompt.trim()) throw new Error('任务指令不能为空');
    const value = String(input.scheduleValue ?? '').trim();
    validateSchedule(input.scheduleKind, value);
    const now = this.nowEpoch();
    const id = this.newId();
    this.db.prepare(`INSERT INTO cron_jobs (id, name, prompt, schedule_kind, schedule_value, assistant_id, workspace_root, enabled, next_run_at, last_status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,1,?,'',?,?)`)
      .run(id, name, prompt, input.scheduleKind, value,
        input.assistantId?.trim() || null, input.workspaceRoot?.trim() || null,
        nextSec(input.scheduleKind, value, Date.now()), now, now);
    return this.get(id)!;
  }

  update(id: string, patch: { name?: string; prompt?: string; scheduleKind?: ScheduleKind; scheduleValue?: string; assistantId?: string; workspaceRoot?: string; enabled?: boolean }): CronJob {
    const old = this.get(id);
    if (!old) throw new Error(`任务不存在: ${id}`);
    const kind = patch.scheduleKind ?? old.scheduleKind;
    const value = (patch.scheduleValue ?? old.scheduleValue).trim();
    const enabled = patch.enabled ?? old.enabled;
    // 调度或启停变化才重算校验——只改名不该因「once 已过」被卡住
    const scheduleTouched = patch.scheduleKind !== undefined || patch.scheduleValue !== undefined
      || (patch.enabled === true && !old.enabled);
    if (scheduleTouched) validateSchedule(kind, value);
    const next = !enabled ? null : (scheduleTouched ? nextSec(kind, value, Date.now()) : (old.nextRunAt ?? nextSec(kind, value, Date.now())));
    const sets: string[] = ['updated_at=@now', 'schedule_kind=@kind', 'schedule_value=@value', 'enabled=@enabled', 'next_run_at=@next'];
    const args: Record<string, unknown> = { id, now: this.nowEpoch(), kind, value, enabled: enabled ? 1 : 0, next };
    if (patch.name !== undefined) {
      const name = String(patch.name).trim().slice(0, NAME_MAX);
      if (!name) throw new Error('任务名称不能为空');
      sets.push('name=@name'); args.name = name;
    }
    if (patch.prompt !== undefined) {
      const prompt = String(patch.prompt).slice(0, PROMPT_MAX);
      if (!prompt.trim()) throw new Error('任务指令不能为空');
      sets.push('prompt=@prompt'); args.prompt = prompt;
    }
    if (patch.assistantId !== undefined) { sets.push('assistant_id=@aid'); args.aid = patch.assistantId.trim() || null; }
    if (patch.workspaceRoot !== undefined) { sets.push('workspace_root=@ws'); args.ws = patch.workspaceRoot.trim() || null; }
    this.db.prepare(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE id=@id`).run(args);
    return this.get(id)!;
  }

  remove(id: string): void {
    const r = this.db.prepare('DELETE FROM cron_jobs WHERE id=?').run(id);
    if (r.changes === 0) throw new Error(`任务不存在: ${id}`);
  }

  /** enabled 且到点（含错过的：next 停在过去）。同刻 rowid 兜底稳定序。
   *  不分 kind：错过的 interval/cron 与 once 一样会被取出来补跑一次（见文件头）。 */
  dueJobs(nowMs: number): CronJob[] {
    const rows = this.db.prepare('SELECT * FROM cron_jobs WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC, rowid ASC')
      .all(nowMs / 1000) as Row[];
    return rows.map(toJob);
  }

  /** 触发开跑：记会话/时间/running 态；once 自动停用清 next，interval/cron 从当下重算。
   *  从当下算而不是从错过的那个点往后推：补跑的这一次就把错过的几次一并顶掉了，不会接连补好几次。
   *  它挡不住补跑本身：走到这里时，错过的那一次已经被 dueJobs 取出来、正在触发了。 */
  markRun(id: string, sessionId: string): void {
    const job = this.get(id);
    if (!job) throw new Error(`任务不存在: ${id}`);
    const once = job.scheduleKind === 'once';
    const next = once ? null : nextSec(job.scheduleKind, job.scheduleValue, Date.now());
    this.db.prepare('UPDATE cron_jobs SET last_run_at=?, last_session_id=?, last_status=?, enabled=?, next_run_at=?, updated_at=? WHERE id=?')
      .run(this.nowEpoch(), sessionId, 'running', once ? 0 : 1, next, this.nowEpoch(), id);
  }

  /** 记终态（ok / error: … / skipped-running 等），截断防塞长报错。 */
  markDone(id: string, status: string): void {
    const r = this.db.prepare('UPDATE cron_jobs SET last_status=?, updated_at=? WHERE id=?')
      .run(String(status).slice(0, STATUS_MAX), this.nowEpoch(), id);
    if (r.changes === 0) throw new Error(`任务不存在: ${id}`);
  }
}
