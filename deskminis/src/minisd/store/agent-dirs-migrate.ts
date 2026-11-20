/** 执行隔离第 2 步：把 agent 能看到的目录从数据根搬到 agent 根（一次性，每次启动都会补搬没搬成的）。
 *
 *  搬的是 sessions/<id>/ 下的四个桶（workspace、attachments、offloads、browser）与 shared/。目录结构不变，只换根，
 *  所以消息里的附件相对路径（attachments/<文件>）、卸载的相对路径都不用改。
 *
 *  - 同一个卷上用 rename：文件身份（卷号 + 文件 ID）不变，检查点的冲突检测照常认得出。跨卷时复制再删，复制失败就删掉
 *    复制了一半的目标、旧桶原样留着。
 *  - 目标已经存在（上次只搬了一部分，或用户自己建过）时逐项并入，同名的留在原处并记下，不覆盖。
 *  - 搬不动的（文件被别的程序占着）留在原处：paths.ts 的 sessionBucketDir 在 agent 根里没有这个桶时继续用旧桶，下次启动再搬。
 *  - 检查点记的是绝对路径：搬完之后把落在旧桶里的记录改到新位置（rewriteCheckpointPaths），恢复与「改动」面板照常。
 *
 *  只在数据根与 agent 根是两个目录时做事。 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import { SESSION_BUCKETS, AGENT_GLOBAL_DIRS } from '../paths';
import { pathKeyOf } from '../tools/data-gate';

export interface AgentDirMove { from: string; to: string }
export interface AgentDirsMigration {
  /** 搬过（整个或部分）的目录：from 下原来的东西现在在 to 下。 */
  moved: AgentDirMove[];
  /** 目标里已有同名项、留在原处的路径。 */
  conflicts: string[];
  /** 搬不动的目录与原因。 */
  failed: Array<{ path: string; error: string }>;
}

/** 文件系统操作，测试可以换掉（模拟跨卷、占用）。 */
export interface MigrateIo {
  rename(from: string, to: string): void;
  copyDir(from: string, to: string): void;
}
const defaultIo: MigrateIo = {
  rename: (from, to) => renameSync(from, to),
  copyDir: (from, to) => cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }),
};

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 整个目录搬过去：同卷 rename，跨卷复制再删。失败时目标不留半截。 */
function moveWhole(from: string, to: string, io: MigrateIo): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    io.rename(from, to);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
  }
  try {
    io.copyDir(from, to);
  } catch (e) {
    try { rmSync(to, { recursive: true, force: true }); } catch { /* 尽力 */ }
    throw e;
  }
  rmSync(from, { recursive: true, force: true });
}

function moveDir(from: string, to: string, io: MigrateIo, out: AgentDirsMigration): void {
  if (!isDir(from)) return;
  try {
    if (!existsSync(to)) {
      moveWhole(from, to, io);
      out.moved.push({ from, to });
      return;
    }
    // 目标已在：逐项并入，同名不覆盖
    let any = false;
    for (const name of readdirSync(from)) {
      const src = join(from, name);
      const dst = join(to, name);
      if (existsSync(dst)) { out.conflicts.push(src); continue; }
      try { moveWhole(src, dst, io); any = true; } catch (e) { out.failed.push({ path: src, error: errText(e) }); }
    }
    if (any) out.moved.push({ from, to });
    try { rmdirSync(from); } catch { /* 还有留下的项 */ }
  } catch (e) {
    out.failed.push({ path: from, error: errText(e) });
  }
}

const removeIfEmpty = (p: string): void => { try { rmdirSync(p); } catch { /* 不空或不存在 */ } };

export function migrateAgentDirs(dataRoot: string, agentRoot: string, io: MigrateIo = defaultIo): AgentDirsMigration {
  const out: AgentDirsMigration = { moved: [], conflicts: [], failed: [] };
  if (resolve(dataRoot) === resolve(agentRoot)) return out;
  const oldSessions = join(dataRoot, 'sessions');
  if (isDir(oldSessions)) {
    let ids: string[] = [];
    try { ids = readdirSync(oldSessions); } catch (e) { out.failed.push({ path: oldSessions, error: errText(e) }); }
    for (const id of ids) {
      const dir = join(oldSessions, id);
      if (!isDir(dir)) continue;
      for (const b of SESSION_BUCKETS) moveDir(join(dir, b), join(agentRoot, 'sessions', id, b), io, out);
      removeIfEmpty(dir);
    }
    removeIfEmpty(oldSessions);
  }
  for (const g of AGENT_GLOBAL_DIRS) moveDir(join(dataRoot, g), join(agentRoot, g), io, out);
  return out;
}

/** p 在 dir 之内时返回相对路径（含相等时的 ''），否则 undefined。Windows 上不分大小写。 */
function within(dir: string, p: string): string | undefined {
  const rel = relative(dir, p);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) return undefined;
  return rel;
}

/** 搬过的目录里的检查点记录改到新位置。只改旧位置上已经没有东西的（并入时同名留在原处的不动）。返回改了几行。 */
export function rewriteCheckpointPaths(db: Database.Database, moved: readonly AgentDirMove[]): number {
  if (moved.length === 0) return 0;
  const map = (p: string | null): string | null => {
    if (p === null) return null;
    for (const m of moved) {
      const rel = within(m.from, p);
      if (rel === undefined) continue;
      if (existsSync(p)) return null; // 还在原处：不动
      return rel === '' ? m.to : join(m.to, rel);
    }
    return null;
  };
  const rows = db.prepare('SELECT seq, path, tmp_path, restore_tmp_path FROM file_checkpoints').all() as Array<{ seq: number; path: string; tmp_path: string | null; restore_tmp_path: string | null }>;
  const update = db.prepare('UPDATE file_checkpoints SET path = ?, path_key = ?, tmp_path = ?, restore_tmp_path = ? WHERE seq = ?');
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const path = map(r.path);
      const tmp = map(r.tmp_path);
      const rtmp = map(r.restore_tmp_path);
      if (path === null && tmp === null && rtmp === null) continue;
      const newPath = path ?? r.path;
      update.run(newPath, pathKeyOf(newPath), tmp ?? r.tmp_path, rtmp ?? r.restore_tmp_path, r.seq);
      n++;
    }
  })();
  return n;
}
