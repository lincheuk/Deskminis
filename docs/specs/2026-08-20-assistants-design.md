# J 波设计稿：助手体系——cowork 化地基（命名预设 = 规则 + 默认技能 + 默认模型）

状态：**定稿即施工**（自己做模式；用户 2026-08-20「做建议立项和候选池」授权）。
立项依据：AionUi 调研 §4（docs/research/2026-08-20-aionui-survey.md）——cowork = 会打包的
技能+提示词预设；DeskMinis 三件原料（技能/模型绑定/会话覆盖）全部就位，缺的只是打包层。

## §0 决策点记录（审核方裁定，事后可否决）

| 决策点 | 裁定 | 依据 |
|---|---|---|
| 助手四要素 | **名称+emoji / 规则（追加系统提示词）/ 默认技能勾选 / 默认模型绑定** + 示例 prompt | AionUi assistant 字段面（assistantTypes.ts）的 DeskMinis 化 |
| 默认权限档 **不做** | 权限档是全局态（settings 键 permission.preset + gateway.applyPreset 全局单例，src/minisd/tools/permissions.ts:269）——助手不劫持全局态；会话级权限覆盖是独立命题，留候选池 | 最小侵入 + 不做惊讶行为 |
| 默认技能语义 | skill_ids_json='[]' = **不动**（会话用全局启用集）；非空 = 建会话时**快照式**写 session_skill_overrides：勾选内 enabled=1、其余已装技能 enabled=0。已知边界（如实记录）：覆盖只快照当时已装集——**会话建成后新装的技能**没有覆盖行、会按全局开关漏进助手会话（覆盖缺省回落全局，skills/store.ts:106）；v1 不做三层判定改造，记候选 | 快照可预期；覆盖机制全复用（setSessionOverride/listEnabledForSession 后端全通）；三层判定需动查询语义，侵入大 |
| 会话绑定字段 | sessions.assistant_id 走**构造器幂等补列**（mcp_disabled_json 成例 chat-store.ts:39-48），不占迁移位 | 单列加法成例（交接文档纪律 4） |
| 助手表 | 迁移[9] 新表 assistants（user_version 9→10），四个版本钉测试随动申报 | 追加式纪律 |
| 内置种子 | 首次启动种 3 个助手（通用协作🤝/代码助手💻/文档写手✍️），**settings 键 assistants.seeded 一次性**——用户删了不复活 | 欢迎页不空置；幂等 ensureSeeds 会复活已删行，违背用户意图，故用一次性标记 |
| 规则注入位 | chat.prompt 的 promptFactory（index.ts:574-577）：`base = stable + assistantBlock + skillsBlock`——置技能块前、stable 后；无助手时空串零开销 | 与 skillsBlock 同一注入模式；每轮实时读表（会话中改助手规则下一轮生效） |
| 默认模型 | 建会话时把助手 model_binding 写进 sessions.model_binding——此后走既有解析链（index.ts:539-557）**零改动**；用户会话内改绑定即覆盖 | 复用 > 新机制 |

## §1 数据模型（迁移[9]）

```sql
CREATE TABLE assistants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  model_binding TEXT,
  skill_ids_json TEXT NOT NULL DEFAULT '[]',
  prompts_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
```

- avatar = emoji 短串（渲染 {{ }} 插值，零 v-html 红线不碰）；model_binding 与 sessions 同格式
  （'provider:<id>' | 'group:<id>' | NULL=跟随全局）；prompts_json = 示例 prompt 字符串数组。
- AssistantStore（src/minisd/assistants/store.ts）：list/get/create/update/remove +
  ensureSeeds(settings)。入参截断（name 50 / rules 8000 / prompts 各 500、最多 8 条）、
  未知 id 不抛回 undefined、删除时**不**动已建会话（assistant_id 悬空 = 规则注入查无即跳过，
  会话继续可用——删助手不杀会话）。
- sessions.assistant_id：ChatStore 构造器幂等补列 + getSession/listSessions 带出 + setAssistant。

## §2 RPC 面

| RPC | 参数 | 说明 |
|---|---|---|
| assistants.list | {} | 全量列表（sort_order, created_at 排序） |
| assistants.create | { name, avatar?, rules?, modelBinding?, skillIds?, prompts? } | 建后广播 assistants.changed |
| assistants.update | { id, ...同上可选 } | 同上广播 |
| assistants.delete | { id, confirm? } | confirm 二次确认（技能删除成例）；广播 |
| chat.sessions.create **扩参** | { title?, assistantId? } | 绑定 + 应用预设（§3）；不新开 RPC |

## §3 建会话应用预设（index.ts 'chat.sessions.create' 内）

1. `chat.createSession(title ?? 助手名, workspace)` → `chat.setAssistant(id, assistantId)`；
2. 助手有 model_binding → `chat.setModelBinding(sessionId, binding)`；
3. skill_ids_json 非空 → 对 skillStore.list() 每个技能写 setSessionOverride（勾选内 1 其余 0；
   列表里的死技能 id 静默跳过——技能可能已被删）；
4. 广播 chat.sessions.changed（既有）。
失败语义：assistantId 查无 → 抛错不建会话（前端卡片来自 list，正常到不了）。
随动修缺（申报）：chat-store.deleteSession 级联删清单**补 session_skill_overrides**——
该表此前不在会话删除链路（调研证实全库仅 skills/store.ts 读写），批量覆盖写入后
残留会随会话数膨胀，趁本波一并治理（annotations 级联成例）。

## §4 规则注入（promptFactory 一处）

```ts
const assistantBlock = buildAssistantBlock(chat.getSessionAssistant(ctx.sessionId), assistants);
const base = stable + assistantBlock + skillsBlock;
```
buildAssistantBlock（src/minisd/assistants/prompt.ts 纯函数）：无助手/查无/rules 空 → ''；
否则 `\n\n<assistant_preset name="...">\n...rules...\n</assistant_preset>\n`。
规则是用户自己写的配置（同技能 SKILL.md 信任级），不包 untrusted 壳；
名称进 name 属性做提示词内自指认。

## §5 UI

- **欢迎页（EmptyState）**：
  - 活动会话**未绑助手**（或无会话）：hero 下方新增「助手」卡区——emoji + 名称 + 规则首行
    摘要（截 40 字），点卡 → `chat.newSessionWithAssistant(id)`（新建绑定会话，welcome 仍在
    但换助手态）；既有三示例卡与最近任务保留在其下。
  - 活动会话**已绑助手**：hero 换助手身份（emoji + 名称 + 「由助手预设驱动」副行），
    示例卡换该助手的 prompts（沿用 @fill 通路），通用示例卡隐藏；「换助手」小钮 →
    新建另一助手会话（不改当前会话绑定——绑定不可换，会话身份稳定）。
- **设置页**：NAV 加 `{ id: 'assistants', label: '助手' }` + AssistantSettings.vue
  （ProviderSettings 版式）：列表（emoji/名称/技能数/模型）+ 新建/编辑表单
  （名称/emoji/规则 textarea/模型 select 复用 chat.providers + 跟随全局/技能复选
  chat.skills/示例 prompt 每行一条 textarea）+ 删除二次确认。
- **SessionList 会话行**：绑定助手的会话行标题前缀 emoji（纯文本插值，零新元素）。
- store：chat.assistants + refreshAssistants + 订阅 assistants.changed；
  newSessionWithAssistant(id)；sessions 列表带 assistantId。

## §6 守卫与测试

- 新纯测：assistants-store.test.ts（迁移例 + CRUD + 截断 + 种子一次性——删后不复活）+
  assistants-prompt.test.ts（buildAssistantBlock 空态/转义/格式）。
- 集成测：chat.sessions.create 扩参应用三件预设（modelBinding/overrides/assistant_id 落库）。
- 源码守卫：renderer-assistants.test.ts（EmptyState 助手卡接线 @fill 通路不破、
  SettingsModal NAV 项、store 订阅、a11y——卡片用 tabindex+role+keydown 成例）。
- **版本钉随动申报**：db-migration6（:37/:75/:99 toBe(9)→10 + :58 DROP assistants）、
  market-cache-migration（:23/:50/:68 + :38）、market-installs-migration（:26/:52/:72 + :40）、
  workspace-picker（:150/:180/:192 + :168-173 回退段）。

## §7 拆步

| 步 | 内容 | 先红 |
|---|---|---|
| **J1** | 迁移[9] + AssistantStore + ensureSeeds + prompt 纯函数 + RPC 五件 + 建会话应用预设 + promptFactory 注入 + 版本钉随动 | assistants-store / assistants-prompt / 版本钉改锚 |
| **J2** | 前端：store 面 + EmptyState 助手卡两态 + SessionList emoji 前缀 + AssistantSettings + NAV | renderer-assistants |
| **J3** | xvfb 目视（欢迎页助手卡/绑定会话态/设置管理页 × 双主题）+ 全量对基线 + 记账 | —（终验步） |

纪律照旧：TDD 先红存档、npm test 对 52 基线 diff 空、typecheck EXIT=0、-F 消息、推后远端验证。
