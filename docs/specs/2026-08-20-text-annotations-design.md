# H 波设计稿：文本选区注释——选中加注 + 回复映射

状态：**已落地**（用户 2026-08-20「H波自己做」——设计与实现均由审核方执行，决策点按
本稿建议直接采纳，用户可事后对任何一条否决返工。H1 2e5c086 → H2 5fa33d1 → H3 933d4c3
三步全落 main，1713→1750；xvfb 全链路实证含重启重锚定与气泡三动作。执行记录见
PROJECT_NOTES H 波条目）。
立项来源：DSH 生态需求盘点三大件之 ③（PROJECT_NOTES 2026-08-20 立项记录）——
「选中文本加注、回复映射；注释数据模型（DB 追加迁移）、选区锚定、注释 UI；三者中最自包续」。

## §0 范围与定位

- **做**：在对话流里选中一段**已落库消息**的正文文本后，浮条给两个动作：
  ①「引用」（回复映射）——把选中文本以 Markdown 引用块预填进输入框，用户续写后随消息进模型；
  ②「标注」——高亮持久化（可附笔记），跨重启、跨会话切换保留，点击高亮可查看/编辑/删除。
- **不做（v1 红线）**：标注**不注入模型上下文**——标注是用户侧笔记，对模型不可见；
  「注入所选标注为上下文」是独立的上下文影响面，记候选池另立项。
  流式区（无消息 id）不参与；工具行输出与思考块不参与（只作用于正文）；
  标注不进设备同步面（M3 sync 不动，记候选池）；无多色（存 color 字段留扩展，v1 单色）。
- 前提核实（已勘察）：MarkdownView 是 AST→模板渲染、零 v-html、文本全 `{{ }}` 插值——
  渲染后 DOM 文本 = 确定性函数(消息文本)，锚定对象取「渲染后文本」即稳定；
  消息不可编辑（无编辑面），锚不漂移；Electron 38 = Chromium 140，
  CSS Custom Highlight API（Chrome 105+）可用。

## §1 决策点（每条带定论）

| # | 决策 | 定论 |
|---|---|---|
| 1 | 锚定模型 | **W3C TextQuoteSelector**：`{exact, prefix, suffix}`（前后文各截 32 字符）对消息「渲染后纯文本」锚定；重锚定时 prefix+exact+suffix 全串优先、退 exact 单独匹配取首个命中；匹配做**空白规范化**（连续空白折叠为单空格）并维护偏移映射回原始 DOM 偏移——块级边界的合成换行（selection.toString 有、textContent 无）由此吸收 |
| 2 | 高亮技术 | **CSS Custom Highlight API**（`CSS.highlights` + `::highlight()`）：零 DOM 改写（跨节点 `<mark>` 包裹会破坏 Vue 视图一致性与 diff），重渲染后只需重算 Range；API 缺失（理论不发生）降级为无着色，数据面不受影响 |
| 3 | 数据模型 | 迁移 **[8]**（db.ts MIGRATIONS，新表走迁移数组成例；D5 构造器补列是单列加法的另一成例，本波不用）：`annotations(id PK, session_id, message_id, exact, prefix, suffix, note, color, created_at, updated_at)` + 索引 `(session_id)` |
| 4 | RPC 面 | `chat.annotations.list({sessionId})` / `add({sessionId,messageId,exact,prefix,suffix,note?})` / `update({id,note})` / `remove({id})`；变更后广播 `chat.annotations.changed {sessionId}`（多窗口一致）。权限：本地会话数据操作，免批（与 sessions.rename 同级） |
| 5 | 生命周期 | `deleteSession` 级联删 annotations（与 messages/compact_markers 同事务同模式）；消息永不单删、不可编辑 → 无孤儿路径；压缩/修剪不动消息正文文本 part → 锚不受影响 |
| 6 | 选区判定 | mouseup 时 `getSelection()` 非空、且 anchor 与 focus 都落在**同一** `[data-mid]` 消息容器的 `[data-anno-root]` 正文区内才出浮条（跨消息选区不支持——两动作语义都以单消息为界）；助手正文（MarkdownView 区）与用户正文（.utext）都参与 |
| 7 | 引用格式 | 选中文本逐行加 `> ` 前缀 + 空行，**追加**到输入框现有草稿之后（不覆盖用户已敲的字），聚焦输入框；不截断（引用就是引用） |
| 8 | 注释气泡 | 点击高亮区（`caretRangeFromPoint` 命中判定）弹气泡卡：引文摘要（exact 截 80）+ note 输入 + 保存/删除；有 note 的标注叠加虚线下划线样式与无 note 高亮区分 |
| 9 | 视觉 | 高亮底色 = accent 通道低透明度叠加（`color-mix(in srgb, var(--accent) 22%, transparent)` 级），正文对比度由原文字色保证不降级；浮条/气泡实底 `--surface-1` 浮岛（ChatView 不在 blur 白名单例 8 的 ALLOW，也不申请扩——零 blur）；按钮全原生 button + aria-label（E4 键盘守卫口径） |

## §2 模块与拆步

- **纯核心 `src/renderer/src/lib/annotations/anchor.ts`**（可测内核，先红 TDD 主战场）：
  `normalizeWithMap(text)`（空白折叠 + 原偏移映射）、`matchQuote(rawText, {exact,prefix,suffix})
  → {start,end} | null`（规范化域匹配、全串优先退 exact、映射回原始偏移）、
  `offsetsToRange(root, start, end)`（TreeWalker 文本偏移 → 跨节点 DOM Range）。
- **H1 后端**：迁移 [8] + ChatStore 注释五方法（list/add/update/remove/级联）+ RPC 四件 + 广播；
  先红：tests/annotations-store.test.ts + tests/annotations-rpc.test.ts。
- **H2 前端**：anchor.ts 纯模块 + ChatView 集成（data-mid/data-anno-root、选区浮条、
  引用追问、标注创建、Highlight 渲染重算——watch messages+annotations 合帧 rAF）+
  store 侧 annotations 状态与 changed 订阅；先红：tests/annotations-anchor.test.ts（纯函数真测）+
  tests/renderer-annotations.test.ts（源码守卫：data-anno-root 锚、CSS.highlights 调用、
  浮条按钮 aria、零 v-html 反向锚）。
- **H3 气泡管理 + 收尾**：注释气泡（查看/编辑 note/删除）、::highlight 样式两档、
  会话切换/删除时前端状态清理；xvfb 双主题截图验收（浮条/高亮/气泡三态）。
- 每步一个 commit 落 main（`H<n>: 简述`），npm test + typecheck 全绿后推送；
  基线从 1713 起步；e2e 选区驱动属审核驱动（scratchpad driver），不入库。

## §3 性能红线（自审口径）

高亮重算仅由 messages/annotations/activeId 变化触发（输入框键入零重算），rAF 合帧；
匹配是 O(会话文本量) 的字符串扫描、注释预期 <100 条/会话，无正则回溯面；
流式期间零参与（流式区不在 data-mid 内）；Highlight 对象复用单实例 set/clear，不逐条建名。
