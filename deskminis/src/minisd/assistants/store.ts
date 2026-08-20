import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { SkillStore } from '../skills/store';
import type { ChatStore } from '../store/chat-store';
import type { SettingsStore } from '../store/settings';

/** J1 助手体系（设计稿 2026-08-20-assistants-design.md）。
 *  助手 = 命名预设：规则（追加系统提示词）+ 默认技能快照 + 默认模型 + 示例 prompt。
 *  权限档不在此：全局态不劫持（设计稿 §0 裁定）。 */
export interface AssistantMeta {
  id: string; name: string; avatar: string; rules: string;
  modelBinding?: string; skillIds: string[]; prompts: string[];
  sortOrder: number; createdAt: number; updatedAt: number;
}

interface Row {
  id: string; name: string; avatar: string; rules: string;
  model_binding: string | null; skill_ids_json: string; prompts_json: string;
  sort_order: number; created_at: number; updated_at: number;
}

// 写入上限：本地 RPC 也不给无界写入面（annotations ANNO_TEXT_MAX 同一精神）。
// rules 8000 字 ≈ 数千 token——够写完整人设，又不至于一个助手吃掉半个上下文窗。
const NAME_MAX = 50;
const AVATAR_MAX = 8;
const RULES_MAX = 8000;
const PROMPT_MAX = 500;
const PROMPTS_COUNT_MAX = 8;
const SKILL_ID_MAX = 64;
const SKILL_IDS_COUNT_MAX = 100;

/** 一次性种子标记：删了不复活（幂等 ensureSeeds 会复活已删行，违背用户删除意图）。 */
export const ASSISTANTS_SEEDED_KEY = 'assistants.seeded';

/** JSON 字符串数组的宽容解析：空/损坏/形态不对回 []（mcp_disabled_json 同款口径）。 */
function parseStrings(raw: string, itemMax: number, countMax: number): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .slice(0, countMax)
    .map(x => x.slice(0, itemMax));
}

function sanitize(input: { name?: string; avatar?: string; rules?: string; modelBinding?: string; skillIds?: string[]; prompts?: string[] }): {
  name?: string; avatar?: string; rules?: string; modelBinding?: string | null; skillIdsJson?: string; promptsJson?: string;
} {
  const out: ReturnType<typeof sanitize> = {};
  if (input.name !== undefined) out.name = String(input.name).slice(0, NAME_MAX);
  if (input.avatar !== undefined) out.avatar = String(input.avatar).slice(0, AVATAR_MAX);
  if (input.rules !== undefined) out.rules = String(input.rules).slice(0, RULES_MAX);
  if (input.modelBinding !== undefined) {
    const v = typeof input.modelBinding === 'string' ? input.modelBinding.trim() : '';
    out.modelBinding = v === '' ? null : v;
  }
  if (input.skillIds !== undefined) {
    out.skillIdsJson = JSON.stringify(parseStrings(JSON.stringify(input.skillIds ?? []), SKILL_ID_MAX, SKILL_IDS_COUNT_MAX));
  }
  if (input.prompts !== undefined) {
    out.promptsJson = JSON.stringify(parseStrings(JSON.stringify(input.prompts ?? []), PROMPT_MAX, PROMPTS_COUNT_MAX));
  }
  return out;
}

function toMeta(r: Row): AssistantMeta {
  return {
    id: r.id, name: r.name, avatar: r.avatar, rules: r.rules,
    modelBinding: r.model_binding ?? undefined,
    skillIds: parseStrings(r.skill_ids_json, SKILL_ID_MAX, SKILL_IDS_COUNT_MAX),
    prompts: parseStrings(r.prompts_json, PROMPT_MAX, PROMPTS_COUNT_MAX),
    sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class AssistantStore {
  constructor(private db: Database.Database) {}

  nowEpoch(): number { return Date.now() / 1000; }
  newId(): string { return randomUUID().toUpperCase(); }

  /** sort_order 优先、同序按创建先后；同刻 rowid 兜底（Windows 时钟 15ms 教训）。 */
  list(): AssistantMeta[] {
    const rows = this.db.prepare('SELECT * FROM assistants ORDER BY sort_order ASC, created_at ASC, rowid ASC').all() as Row[];
    return rows.map(toMeta);
  }

  get(id: string): AssistantMeta | undefined {
    const r = this.db.prepare('SELECT * FROM assistants WHERE id=?').get(id) as Row | undefined;
    return r ? toMeta(r) : undefined;
  }

  create(input: { name: string; avatar?: string; rules?: string; modelBinding?: string; skillIds?: string[]; prompts?: string[]; id?: string }): AssistantMeta {
    const s = sanitize(input);
    if (!s.name || s.name.trim() === '') throw new Error('助手名称不能为空');
    const now = this.nowEpoch();
    const id = input.id ?? this.newId();
    this.db.prepare(`INSERT INTO assistants (id, name, avatar, rules, model_binding, skill_ids_json, prompts_json, sort_order, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,0,?,?)`)
      .run(id, s.name.trim(), s.avatar ?? '', s.rules ?? '', s.modelBinding ?? null, s.skillIdsJson ?? '[]', s.promptsJson ?? '[]', now, now);
    return this.get(id)!;
  }

  /** 局部改写：只更新传入字段。未知 id 抛错——这是用户操作面，静默失败即「点了没反应」。 */
  update(id: string, patch: { name?: string; avatar?: string; rules?: string; modelBinding?: string; skillIds?: string[]; prompts?: string[]; sortOrder?: number }): AssistantMeta {
    if (!this.get(id)) throw new Error(`助手不存在: ${id}`);
    const s = sanitize(patch);
    if (s.name !== undefined && s.name.trim() === '') throw new Error('助手名称不能为空');
    const sets: string[] = ['updated_at=@now'];
    const args: Record<string, unknown> = { id, now: this.nowEpoch() };
    if (s.name !== undefined) { sets.push('name=@name'); args.name = s.name.trim(); }
    if (s.avatar !== undefined) { sets.push('avatar=@avatar'); args.avatar = s.avatar; }
    if (s.rules !== undefined) { sets.push('rules=@rules'); args.rules = s.rules; }
    if (s.modelBinding !== undefined) { sets.push('model_binding=@mb'); args.mb = s.modelBinding; }
    if (s.skillIdsJson !== undefined) { sets.push('skill_ids_json=@sids'); args.sids = s.skillIdsJson; }
    if (s.promptsJson !== undefined) { sets.push('prompts_json=@pj'); args.pj = s.promptsJson; }
    if (patch.sortOrder !== undefined) { sets.push('sort_order=@so'); args.so = Math.trunc(patch.sortOrder); }
    this.db.prepare(`UPDATE assistants SET ${sets.join(', ')} WHERE id=@id`).run(args);
    return this.get(id)!;
  }

  /** 删助手不动已绑会话：assistant_id 悬空，注入侧查无即跳过（会话继续可用，设计稿 §1）。 */
  remove(id: string): void {
    const r = this.db.prepare('DELETE FROM assistants WHERE id=?').run(id);
    if (r.changes === 0) throw new Error(`助手不存在: ${id}`);
  }

  /** 内置种子（设计稿 §0）：一次性标记而非幂等重种——用户删掉的助手不复活。 */
  ensureSeeds(settings: SettingsStore): void {
    if (settings.get(ASSISTANTS_SEEDED_KEY) !== undefined) return;
    const seeds: Array<{ name: string; avatar: string; rules: string; prompts: string[] }> = [
      {
        name: '通用协作', avatar: '🤝',
        rules: '你是用户的通用协作伙伴，擅长把模糊的诉求拆成可执行的步骤并动手完成：整理文件、起草文档、检索资料、跑命令、汇总结论。做事之前先用一两句话说明计划；步骤多时边做边报进度；产出优先落成工作区里的文件，而不是只在对话里给一段话。遇到会改动用户数据的操作，先说明影响再执行。',
        prompts: ['把这个文件夹里的文件按类型整理进子目录，整理前先给我方案', '帮我调研一下这个目录里的项目是做什么的，写一份两百字摘要', '把我接下来口述的要点整理成一份结构化的 Markdown 笔记'],
      },
      {
        name: '代码助手', avatar: '💻',
        rules: '你是严谨的软件工程师。改代码前先读懂上下文与既有约定，保持最小改动面；改完主动跑测试或类型检查验证，并如实报告结果——失败就说失败。解释问题时先给结论，再给关键证据（文件与行号）。不确定的事直接说不确定，不要编造 API。',
        prompts: ['读一下这个项目的入口和核心模块，给我讲讲整体架构', '这个报错是什么原因？帮我定位并修掉，修完跑一下测试', '给这个函数补上单元测试，覆盖边界情况'],
      },
      {
        name: '文档写手', avatar: '✍️',
        rules: '你是中文技术写作者。写作时先列提纲确认结构，再成文；用短句和主动语态，术语首次出现给一句解释；产出落成 Markdown 文件。改稿时保留作者原意，逐处说明为什么这样改。数据和结论必须有出处，没有出处就标注「待核实」。',
        prompts: ['根据这个项目的 README 和代码，写一份面向新手的使用指南', '把这份草稿改得更清楚有力，改完列出主要改动', '帮我把这些零散笔记整理成一篇结构完整的文档'],
      },
    ];
    for (const s of seeds) this.create(s);
    settings.set(ASSISTANTS_SEEDED_KEY, String(Math.trunc(Date.now() / 1000)));
  }
}

/** 建会话应用预设（设计稿 §3）。独立函数而非闭包：K 波定时任务复用 + 可单测。
 *  技能快照：勾选内写 1、其余**已装**技能写 0（覆盖缺省回落全局，不显式写 0 会漏进来——
 *  调研点名的坑）；勾选里的死技能 id 自然跳过（只遍历已装集）。 */
export function applyAssistantPreset(
  deps: { chat: ChatStore; skills: SkillStore },
  sessionId: string,
  a: AssistantMeta,
): void {
  deps.chat.setAssistant(sessionId, a.id);
  if (a.modelBinding) deps.chat.setModelBinding(sessionId, a.modelBinding);
  if (a.skillIds.length > 0) {
    const chosen = new Set(a.skillIds);
    for (const sk of deps.skills.list()) {
      deps.skills.setSessionOverride(sessionId, sk.id, chosen.has(sk.id));
    }
  }
}
