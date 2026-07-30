import type Database from 'better-sqlite3';
import { relative, resolve, sep } from 'node:path';
import type { SkillMeta } from './parser';
import { slugify } from './parser';

export interface SkillRow {
  id: string; name: string; description: string; version: string;
  importSource: string; isEnabled: boolean;
  installedAt: number; updatedAt: number; useCount: number;
}

interface Row {
  id: string; name: string; description: string; version: string;
  import_source: string; is_enabled: number;
  installed_at: number; updated_at: number; use_count: number;
}

/** 任一技能的 use_count 超过该值时，全表归一化到 0-100（防无界膨胀且保持相对热度，设计 §5.1）。 */
export const USE_COUNT_NORMALIZE_THRESHOLD = 1000;

function toSkill(r: Row): SkillRow {
  return {
    id: r.id, name: r.name, description: r.description, version: r.version,
    importSource: r.import_source, isEnabled: r.is_enabled === 1,
    installedAt: r.installed_at, updatedAt: r.updated_at, useCount: r.use_count,
  };
}

/**
 * 命中 `<skillsRoot>/<id>/SKILL.md`（恰好一层子目录、文件名大小写不敏感）时返回技能 id。
 * 归一化后判断：拒绝根外与多级嵌套（技能子目录里的引用文件不算技能正文读取）。
 */
export function skillIdFromPath(skillsRoot: string, absPath: string): string | undefined {
  const rel = relative(resolve(skillsRoot), resolve(absPath));
  if (rel === '' || rel.startsWith('..') || /^[A-Za-z]:/.test(rel)) return undefined;
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length !== 2) return undefined;
  if (parts[1].toLowerCase() !== 'skill.md') return undefined;
  return parts[0];
}

export class SkillStore {
  constructor(private db: Database.Database) {}

  nowEpoch(): number { return Date.now() / 1000; }

  list(): SkillRow[] {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY installed_at ASC, id ASC').all() as Row[];
    return rows.map(toSkill);
  }

  get(id: string): SkillRow | undefined {
    const r = this.db.prepare('SELECT * FROM skills WHERE id=?').get(id) as Row | undefined;
    return r ? toSkill(r) : undefined;
  }

  /** 生成不与现有技能冲突的 slug id（冲突追加 -2/-3…）。 */
  uniqueId(base: string): string {
    const root = slugify(base);
    let id = root; let n = 2;
    while (this.get(id)) { id = `${root}-${n}`; n++; }
    return id;
  }

  /**
   * 入库/更新。损坏重解析（meta 字段缺失）时逐字段保留旧元数据 —— 中途保存写坏的
   * SKILL.md 不应把已入库的名字/描述抹掉（设计 §5.1）。新技能缺 name 用 fallbackName。
   * 重复导入同 id：更新元数据与 updated_at，但保留 installed_at/use_count/is_enabled。
   */
  upsert(input: { id?: string; meta: SkillMeta; fallbackName: string; importSource: string }): SkillRow {
    const now = this.nowEpoch();
    const id = input.id ?? this.uniqueId(input.meta.name ?? input.fallbackName);
    const old = this.get(id);
    const name = input.meta.name ?? old?.name ?? input.fallbackName;
    const description = input.meta.description ?? old?.description ?? '';
    const version = input.meta.version ?? old?.version ?? '';
    this.db.prepare(`INSERT INTO skills (id, name, description, version, import_source, is_enabled, installed_at, updated_at, use_count)
      VALUES (?,?,?,?,?,1,?,?,0)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
        version=excluded.version, import_source=excluded.import_source, updated_at=excluded.updated_at`)
      .run(id, name, description, version, input.importSource, old?.installedAt ?? now, now);
    return this.get(id)!;
  }

  setEnabled(id: string, enabled: boolean): void {
    const r = this.db.prepare('UPDATE skills SET is_enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, this.nowEpoch(), id);
    if (r.changes === 0) throw new Error(`技能不存在: ${id}`);
  }

  /** enabled=null 表示清除会话覆盖（回到全局设置）。 */
  setSessionOverride(sessionId: string, skillId: string, enabled: boolean | null): void {
    if (!this.get(skillId)) throw new Error(`技能不存在: ${skillId}`);
    if (enabled === null) {
      this.db.prepare('DELETE FROM session_skill_overrides WHERE session_id=? AND skill_id=?').run(sessionId, skillId);
    } else {
      this.db.prepare(`INSERT INTO session_skill_overrides (session_id, skill_id, is_enabled) VALUES (?,?,?)
        ON CONFLICT(session_id, skill_id) DO UPDATE SET is_enabled=excluded.is_enabled`).run(sessionId, skillId, enabled ? 1 : 0);
    }
  }

  /** 生效启用 = 会话覆盖优先，缺省用全局 is_enabled；只返回生效启用的技能。 */
  listEnabledForSession(sessionId: string): SkillRow[] {
    const rows = this.db.prepare(`SELECT s.*, o.is_enabled AS override_enabled FROM skills s
      LEFT JOIN session_skill_overrides o ON o.skill_id = s.id AND o.session_id = ?
      ORDER BY s.installed_at ASC, s.id ASC`).all(sessionId) as (Row & { override_enabled: number | null })[];
    return rows.filter(r => (r.override_enabled ?? r.is_enabled) === 1).map(toSkill);
  }

  delete(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_skill_overrides WHERE skill_id=?').run(id);
      this.db.prepare('DELETE FROM skills WHERE id=?').run(id);
    });
    tx();
  }

  bumpUseCount(id: string): void {
    this.db.prepare('UPDATE skills SET use_count=use_count+1 WHERE id=?').run(id);
    const cur = this.get(id);
    if (cur && cur.useCount > USE_COUNT_NORMALIZE_THRESHOLD) this.normalizeUseCounts();
  }

  /** 全表 use_count 线性归一化到 0-100；全 0 时不动。 */
  normalizeUseCounts(): void {
    const { mx } = this.db.prepare('SELECT COALESCE(MAX(use_count),0) mx FROM skills').get() as { mx: number };
    if (mx <= 0) return;
    this.db.prepare('UPDATE skills SET use_count=ROUND(use_count*100.0/?)').run(mx);
  }
}
