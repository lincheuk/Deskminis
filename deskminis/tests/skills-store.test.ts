import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { SkillStore, skillIdFromPath, USE_COUNT_NORMALIZE_THRESHOLD } from '../src/minisd/skills/store';
import type Database from 'better-sqlite3';
import { join } from 'node:path';

let db: Database.Database; let store: SkillStore;
beforeEach(() => { db = openDb(':memory:'); store = new SkillStore(db); });

describe('skills 表 migration', () => {
  it('建出 skills 与 session_skill_overrides 两表', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name);
    expect(tables).toContain('skills');
    expect(tables).toContain('session_skill_overrides');
  });
  it('已有 M1+M2a 库（user_version=2）只补跑第 3 条 migration MIGRATIONS[2]', () => {
    // openDb 已对 :memory: 全量跑完；此处验证 skills 表列齐全
    const cols = (db.prepare('PRAGMA table_info(skills)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(['id', 'name', 'description', 'version', 'import_source', 'is_enabled', 'installed_at', 'updated_at', 'use_count']);
  });
});

describe('SkillStore upsert/查询', () => {
  it('新技能入库：完整元数据 + 默认值', () => {
    const s = store.upsert({ meta: { name: 'PDF 工具', description: '处理 pdf', version: '1.0' }, fallbackName: 'x', importSource: 'folder' });
    expect(s.id).toBe('pdf-工具');
    expect(s.isEnabled).toBe(true);
    expect(s.useCount).toBe(0);
    expect(store.list()).toHaveLength(1);
  });
  it('缺 name 用 fallbackName；id 冲突追加 -2', () => {
    const a = store.upsert({ meta: {}, fallbackName: 'same', importSource: 'orphan' });
    expect(a.name).toBe('same');
    const b = store.upsert({ meta: {}, fallbackName: 'same', importSource: 'orphan' });
    expect(b.id).toBe('same-2');
  });
  it('损坏重解析（meta 为空）逐字段保留旧元数据，只刷新 updated_at', () => {
    const a = store.upsert({ meta: { name: 'good', description: '好描述', version: '2' }, fallbackName: 'x', importSource: 'github:o/r' });
    db.prepare('UPDATE skills SET updated_at=1 WHERE id=?').run(a.id);
    const b = store.upsert({ id: a.id, meta: {}, fallbackName: 'ignored', importSource: 'github:o/r' });
    expect(b.name).toBe('good');
    expect(b.description).toBe('好描述');
    expect(b.version).toBe('2');
    expect(b.updatedAt).toBeGreaterThan(1);
  });
  it('重新导入同 id 更新元数据但保留 installed_at/use_count/is_enabled', () => {
    const a = store.upsert({ meta: { name: 's', description: 'v1' }, fallbackName: 's', importSource: 'folder' });
    db.prepare('UPDATE skills SET use_count=7, is_enabled=0 WHERE id=?').run(a.id);
    const b = store.upsert({ id: a.id, meta: { name: 's', description: 'v2' }, fallbackName: 's', importSource: 'folder' });
    expect(b.description).toBe('v2');
    expect(b.useCount).toBe(7);
    expect(b.isEnabled).toBe(false);
    expect(b.installedAt).toBe(a.installedAt);
  });
});

describe('SkillStore 启用/会话覆盖', () => {
  it('setEnabled 全局开关；不存在抛错', () => {
    const a = store.upsert({ meta: { name: 'a' }, fallbackName: 'a', importSource: 'folder' });
    store.setEnabled(a.id, false);
    expect(store.get(a.id)!.isEnabled).toBe(false);
    expect(() => store.setEnabled('nope', true)).toThrow();
  });
  it('会话覆盖优先于全局；null 清除覆盖回到全局', () => {
    const a = store.upsert({ meta: { name: 'a' }, fallbackName: 'a', importSource: 'folder' });
    const b = store.upsert({ meta: { name: 'b' }, fallbackName: 'b', importSource: 'folder' });
    store.setEnabled(b.id, false);
    // 全局：a 启用 b 禁用
    expect(store.listEnabledForSession('S1').map(s => s.id)).toEqual([a.id]);
    // S1 覆盖启用 b、禁用 a
    store.setSessionOverride('S1', b.id, true);
    store.setSessionOverride('S1', a.id, false);
    expect(store.listEnabledForSession('S1').map(s => s.id)).toEqual([b.id]);
    // S2 不受 S1 覆盖影响
    expect(store.listEnabledForSession('S2').map(s => s.id)).toEqual([a.id]);
    // 清除覆盖回到全局
    store.setSessionOverride('S1', a.id, null);
    store.setSessionOverride('S1', b.id, null);
    expect(store.listEnabledForSession('S1').map(s => s.id)).toEqual([a.id]);
  });
  it('delete 级联删会话覆盖', () => {
    const a = store.upsert({ meta: { name: 'a' }, fallbackName: 'a', importSource: 'folder' });
    store.setSessionOverride('S1', a.id, false);
    store.delete(a.id);
    expect(store.get(a.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) c FROM session_skill_overrides').get()).toEqual({ c: 0 });
  });
});

describe('SkillStore use_count', () => {
  it('bumpUseCount 递增', () => {
    const a = store.upsert({ meta: { name: 'a' }, fallbackName: 'a', importSource: 'folder' });
    store.bumpUseCount(a.id);
    store.bumpUseCount(a.id);
    expect(store.get(a.id)!.useCount).toBe(2);
  });
  it('任一技能超过阈值时全表归一化到 0-100（保持相对热度）', () => {
    const a = store.upsert({ meta: { name: 'a' }, fallbackName: 'a', importSource: 'folder' });
    const b = store.upsert({ meta: { name: 'b' }, fallbackName: 'b', importSource: 'folder' });
    db.prepare('UPDATE skills SET use_count=? WHERE id=?').run(USE_COUNT_NORMALIZE_THRESHOLD, a.id);
    db.prepare('UPDATE skills SET use_count=501 WHERE id=?').run(b.id);
    store.bumpUseCount(a.id); // 1001 > 阈值 → 触发归一化
    expect(store.get(a.id)!.useCount).toBe(100);
    expect(store.get(b.id)!.useCount).toBe(50);
  });
  it('normalizeUseCounts 全 0 时不动', () => {
    store.upsert({ meta: { name: 'a' }, fallbackName: 'a', importSource: 'folder' });
    store.normalizeUseCounts();
    expect(store.list()[0].useCount).toBe(0);
  });
});

describe('skillIdFromPath（use_count 拦截的命中判定）', () => {
  const root = join('C:', 'data', 'skills');
  it('恰好 <skillsRoot>/<id>/SKILL.md 命中', () => {
    expect(skillIdFromPath(root, join(root, 'foo', 'SKILL.md'))).toBe('foo');
    expect(skillIdFromPath(root, join(root, 'foo', 'skill.md'))).toBe('foo'); // 文件名大小写不敏感
  });
  it('层级不对/文件名不对/根外不命中', () => {
    expect(skillIdFromPath(root, join(root, 'foo', 'sub', 'SKILL.md'))).toBeUndefined();
    expect(skillIdFromPath(root, join(root, 'foo', 'README.md'))).toBeUndefined();
    expect(skillIdFromPath(root, join(root, 'SKILL.md'))).toBeUndefined();
    expect(skillIdFromPath(root, join('C:', 'data', 'other', 'foo', 'SKILL.md'))).toBeUndefined();
    expect(skillIdFromPath(root, join(root, '..', 'skills2', 'foo', 'SKILL.md'))).toBeUndefined();
  });
});
