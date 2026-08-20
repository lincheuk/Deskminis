import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { SkillStore } from '../src/minisd/skills/store';
import { SettingsStore } from '../src/minisd/store/settings';
import { AssistantStore, applyAssistantPreset } from '../src/minisd/assistants/store';
import type Database from 'better-sqlite3';

/** J1 助手体系——存储层（设计稿 2026-08-20-assistants-design.md §1/§3）。
 *  助手 = 命名预设（规则 + 默认技能快照 + 默认模型 + 示例 prompt）；
 *  会话绑定列 assistant_id 走 ChatStore 构造器幂等补列（mcp_disabled_json 成例）。 */

let db: Database.Database; let chat: ChatStore; let skills: SkillStore;
let settings: SettingsStore; let store: AssistantStore;
beforeEach(() => {
  db = openDb(':memory:');
  chat = new ChatStore(db);
  skills = new SkillStore(db);
  settings = new SettingsStore(db);
  store = new AssistantStore(db);
});

describe('迁移 [9] assistants', () => {
  it('新库 user_version=11 且 assistants 表就位、列全（K1 追加 [10] 后最新版是 11）', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(11);
    const cols = db.prepare('PRAGMA table_info(assistants)').all() as { name: string }[];
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining(
      ['id', 'name', 'avatar', 'rules', 'model_binding', 'skill_ids_json', 'prompts_json', 'sort_order', 'created_at', 'updated_at'],
    ));
  });

  it('sessions.assistant_id 由 ChatStore 构造器幂等补列（重复构造不炸）', () => {
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    expect(cols.some(c => c.name === 'assistant_id')).toBe(true);
    expect(() => new ChatStore(db)).not.toThrow();
  });
});

describe('AssistantStore CRUD', () => {
  it('create + list 读回：字段完整、缺省值就位', () => {
    const a = store.create({ name: '代码助手', avatar: '💻', rules: '你是工程师。' });
    expect(a.id).toMatch(/^[0-9A-F-]{36}$/);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: a.id, name: '代码助手', avatar: '💻', rules: '你是工程师。',
      modelBinding: undefined, skillIds: [], prompts: [], sortOrder: 0,
    });
  });

  it('update 局部改写；未知 id 抛错（用户操作要有反馈）', () => {
    const a = store.create({ name: '甲' });
    store.update(a.id, { rules: '新规则', prompts: ['示例一'], modelBinding: 'provider:P1' });
    const got = store.get(a.id)!;
    expect(got.rules).toBe('新规则');
    expect(got.prompts).toEqual(['示例一']);
    expect(got.modelBinding).toBe('provider:P1');
    expect(got.name).toBe('甲'); // 未传字段不动
    expect(() => store.update('missing', { name: 'x' })).toThrow(/助手不存在/);
  });

  it('remove 删除；未知 id 抛错；删助手不动已绑会话（绑定悬空，会话可用）', () => {
    const a = store.create({ name: '乙' });
    const s = chat.createSession();
    chat.setAssistant(s.id, a.id);
    store.remove(a.id);
    expect(store.get(a.id)).toBeUndefined();
    expect(chat.getSession(s.id)!.assistantId).toBe(a.id); // 悬空保留，注入侧查无即跳过
    expect(() => store.remove('missing')).toThrow(/助手不存在/);
  });

  it('入参截断：name 50 / rules 8000 / prompts 每条 500 最多 8 条 / 坏 skillIds 过滤', () => {
    const a = store.create({
      name: 'x'.repeat(80), rules: 'r'.repeat(9000),
      prompts: Array.from({ length: 12 }, (_, i) => `p${i}` + 'y'.repeat(600)),
      skillIds: ['ok-skill', 123 as unknown as string, ''],
    });
    const got = store.get(a.id)!;
    expect(got.name).toHaveLength(50);
    expect(got.rules).toHaveLength(8000);
    expect(got.prompts).toHaveLength(8);
    expect(got.prompts[0]).toHaveLength(500);
    expect(got.skillIds).toEqual(['ok-skill']);
  });

  it('list 稳定序：sort_order 优先，同序按创建先后（rowid 兜底，Windows 同刻教训）', () => {
    const a = store.create({ name: '一' });
    const b = store.create({ name: '二' });
    const c = store.create({ name: '三' });
    store.update(b.id, { sortOrder: -1 });
    expect(store.list().map(x => x.name)).toEqual(['二', '一', '三']);
    void a; void c;
  });
});

describe('内置种子（settings 一次性标记）', () => {
  it('首次 ensureSeeds 种 3 个；再调不重复；删除后不复活', () => {
    store.ensureSeeds(settings);
    expect(store.list()).toHaveLength(3);
    store.ensureSeeds(settings);
    expect(store.list()).toHaveLength(3);
    const victim = store.list()[0];
    store.remove(victim.id);
    store.ensureSeeds(settings);
    expect(store.list()).toHaveLength(2); // 一次性标记：删了就是删了
    expect(store.list().some(a => a.id === victim.id)).toBe(false);
  });
});

describe('applyAssistantPreset（建会话应用预设）', () => {
  function seedSkill(id: string, enabled = true): void {
    db.prepare(`INSERT INTO skills (id, name, description, version, import_source, is_enabled, installed_at, updated_at, use_count)
      VALUES (?,?,?,?,?,?,?,?,0)`).run(id, id, '', '', 'test', enabled ? 1 : 0, 1, 1);
  }

  it('绑定 + 默认模型 + 技能快照覆盖（勾选写 1、其余写 0、死 id 跳过）', () => {
    seedSkill('sk-a'); seedSkill('sk-b'); seedSkill('sk-c', false);
    const a = store.create({ name: '丙', modelBinding: 'provider:P9', skillIds: ['sk-a', 'sk-dead'] });
    const s = chat.createSession();
    applyAssistantPreset({ chat, skills }, s.id, store.get(a.id)!);
    const meta = chat.getSession(s.id)!;
    expect(meta.assistantId).toBe(a.id);
    expect(meta.modelBinding).toBe('provider:P9');
    const effective = skills.listEnabledForSession(s.id).map(x => x.id);
    expect(effective).toEqual(['sk-a']); // sk-b 全局启用但被快照压 0；sk-c 本就关闭；sk-dead 跳过
  });

  it('skillIds 为空 = 不动全局启用集；无 modelBinding 不写绑定', () => {
    seedSkill('sk-a'); seedSkill('sk-b', false);
    const a = store.create({ name: '丁' });
    const s = chat.createSession();
    applyAssistantPreset({ chat, skills }, s.id, store.get(a.id)!);
    expect(chat.getSession(s.id)!.modelBinding).toBeUndefined();
    expect(skills.listEnabledForSession(s.id).map(x => x.id)).toEqual(['sk-a']);
  });
});

describe('会话删除级联（随动修缺）', () => {
  it('deleteSession 连带清 session_skill_overrides（残留膨胀治理）', () => {
    db.prepare(`INSERT INTO skills (id, name, description, version, import_source, is_enabled, installed_at, updated_at, use_count)
      VALUES ('sk-x','sk-x','','','test',1,1,1,0)`).run();
    const s = chat.createSession();
    skills.setSessionOverride(s.id, 'sk-x', false);
    expect(db.prepare('SELECT COUNT(*) c FROM session_skill_overrides WHERE session_id=?').get(s.id)).toMatchObject({ c: 1 });
    chat.deleteSession(s.id);
    expect(db.prepare('SELECT COUNT(*) c FROM session_skill_overrides WHERE session_id=?').get(s.id)).toMatchObject({ c: 0 });
  });
});
