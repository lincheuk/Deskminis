# DeskMinis MU4（把已建成的能力接出界面）实施计划

> ⛔ **本计划已废止（2026-08-10）** —— 由 [MU5 · 工作台形态重构](2026-08-10-mu5-workbench-layout.md) 取代。
> 废止理由：本计划的全部 Task 建立在「右栏四标签」结构上（审计挂第 5 标签、FilesPanel 升格预览区），
> 而用户随后拍板改布局 B（工作台为主），该结构整个换掉，照此执行会做两遍。
> **立项依据仍然成立并被继承**：33 个 RPC 中 15 个渲染端零引用（45%）——该部分工作移入 **MU6 · 能力接线**，
> 在 MU5 交付的新导航结构上落地。下方原文保留，仅作依据与分析的存档。

> 状态：**待评审**。基线 main@b2b402f（MU3 及目视调档已合并）。
> 本轮性质：**接线与重组，不造新能力** —— `src/minisd` 整目录零改动是最强红线。

## 立项依据（实证，非推测）

用户反馈「UI 太单薄」，经比对确认**能力面不薄，薄的是「接出来」**：

- `src/minisd/index.ts` 字面注册表共 **33 个 RPC 方法**（`remote.*` 另在 M3a 守卫块注册，渲染端已消费）。
- 其中 **15 个在渲染端零引用（45%）** —— 全文搜确认，非仅查 `call(` 模式。

| 已建成能力 | 零引用 RPC（含 index.ts 行号与签名） | 出处 |
|---|---|---|
| **同步暂停/恢复** | `control.pause`:591 / `control.resume`:597 / `control.status`:609 `→{syncPaused}` | M6 |
| **审计日志** | `audit.list`:585 `(AuditListOpts)` | M6 |
| **模型组 / 降级链** | `modelgroup.create`:478 `{name,memberIds[]}` / `list`:483 / `get`:484 `{id}` / `update`:489 `{id,name?,memberIds?}` / `delete`:496 `{id,confirm?}` | M2b |
| **技能管理** | `skills.setEnabled`:565 `{id,enabled,sessionId?}` / `skills.delete`:573 `{id,confirm?}` / `skills.importStatus`:563 `{taskId?}` | M2c |
| **会话级设置** | `chat.sessions.delete`:313 `{sessionId,confirm?}` / `setModelBinding`:319 `{sessionId,binding?}` / `setMemoryEnabled`:324 `{sessionId,enabled}` | M1/M2a |

**最刺眼的一条**：M6 的「本端暂停」做了完整后端 + 审计 + 收敛方案 A + 13 笔 commit 走全套先红门控，**界面上没有任何开关**。同一毛病的 UI 版：后端建成 ≠ 用户能用到。

**两条计划级发现**：

1. `skills.setEnabled` 签名带 **`sessionId?`** —— 后端早就支持「按会话开关技能」，正是 AionUi「对话头技能指示器」的能力，只差界面。
2. 右栏「进度」标签已有 `.dot-warn` 徽标机制（App.vue:113，挂 `chat.pendingPerms.length > 0`）—— 待批准聚合徽标不必从零造。

**技能面现状（实证）**：渲染端只调 `skills.list`（`stores/chat.ts`:114-115 → `ChatView.vue`:271 斜杠菜单）；`skills.import` 那处是**事件监听**（`chat.ts`:100 `rpc.on('skills.import.progress')`）**不是调用**；`components/` 下**零技能组件**。导入/启停/删除全部按不到。

## §1 锚点（已核实；执行时仍请自行 grep 复核）

- 挂载点一：`SettingsModal.vue`:24-29 `NAV` 四分区 —— `模型 / 外观 / 权限 / 设备与同步`
- 挂载点二：`App.vue`:112-116 右栏四标签 —— `进度 / 产物 / 文件 / 终端`，`.tabs` 样式在 :145
- 挂载点三：`.dot-warn` 徽标（App.vue:113 + 样式 :151）
- 组件面：22 个 `.vue`（MU3 后），无技能/审计/模型组组件
- 基线三件套：npm test **1031/1031（98 文件）**、typecheck 0、build 三产物（复核方于 b2b402f 亲跑）

### §1.1 目标

1. 15 个零引用 RPC 全部接出界面，渲染端零引用数降为 0。
2. 产出物预览器升格：五个现成组件重组为多标签预览区。
3. `src/minisd` 零改动 —— 本轮不加任何后端能力。

### §1.2 非目标（明确不做）

- **不追 AionUi 的办公套件方向**（21 个助手、PPT/Word/Excel 生成、OfficeCLI）—— 那是其赛道且已深耕；DeskMinis 立足点是 Windows 桥深度 + LAN 直连不依赖云 + 与自家手机端耦合。
- **不做定时任务 / 并行会话 side-by-side** —— 前者牵后端+调度+手机端触发，后者牵布局重构，各自单独立项（见 §7 顺延）。
- 不动 `tokens.css`（MU3 刚定稿并经目视调档）；不动 DOM 层无障碍缺口（9 个 div 型控件的 tabindex，属独立里程碑）。
- 零新依赖；不夹带 backlog。

## §2 决策点（逐条结论 + 理由）

### 2-1. 五块新面各挂哪里 → **按「运行时观察」与「配置」二分**

| 能力 | 结论 | 理由 |
|---|---|---|
| **审计日志** | 右栏**新增第 5 标签「审计」** | 它是运行时观察面，与进度/产物同属「看 agent 在干什么」；埋进设置会失去存在感。**这是 DeskMinis 相对 AionUi 的差异化卖点**——本地优先意味着你能看见 agent 做过什么，AionUi 没有对应面 |
| **模型组 / 降级链** | `SettingsModal` 「模型」分区内扩展（`ProviderSettings` 下方） | 与 provider 配置同源，天然邻接 |
| **技能管理** | `SettingsModal` **新增「技能」分区** + 对话头**技能指示器** | 管理归设置；按会话启停归对话头（后端 `sessionId` 维度现成） |
| **同步暂停** | `DevicesModal`（已有「设备与同步」面）+ 标题栏状态点 | 与同步状态同源；标题栏点提供全局可见性 |
| **会话级设置** | 会话卡**右键菜单**（记忆开关 / 模型绑定 / 删除） | 三个 RPC 都以 `sessionId` 为主参，归属会话卡最自然；避免再开模态 |

### 2-2. 产出物预览器形态 → **增量升格，不推翻 MU2b 结构**

保留右栏四标签，把**「文件」标签升级为多标签预览区**：文件树 + 可同时打开多个文件的标签条，`MarkdownView`/`DiffView`/`TerminalPanel` 按类型路由到预览区。产物卡点击（MU2b Task 3 已有的 `showTab` 通路）改为**在预览区开新标签**而非切标签。

理由：MU2b 的右栏四标签结构经过验收（e2e:mu2b 例 1 断言默宽/四标签/拖拽 clamp），推翻代价高且会打红既有守卫；增量升格能拿到 AionUi Preview Panel 的核心价值（多标签 + 类型路由）而不动结构。

### 2-3. 技能指示器是否做 → **做**

对话头显示当前会话激活的技能数与列表，可逐个开关（走 `skills.setEnabled` 的 `sessionId` 维度）。这是 backend 已支持、UI 完全缺失的能力，且直接对应 AionUi 的同名特性。

### 2-4. 审计日志呈现形态 → **时间线 + 过滤器，不做导出**

`audit.list` 的 `AuditListOpts` 已支持 eventType/sessionId/时间范围/分页（M6 实测四个过滤面）。UI 出：时间线列表 + 事件类型筛选 + 会话筛选 + 分页。**不做导出**（会需要新 RPC，违反「零后端改动」红线）。

### 2-5. 待批准聚合徽标 → **复用既有 `.dot-warn`，扩到左栏**

`.dot-warn` 机制已在右栏进度标签生效。本轮扩到**左栏会话卡**（该会话有待批准时显示）与**标题栏**（全局待批准数）。零新机制。

## §3 Task 序列（串行 TDD；每 Task 先红后绿）

### Task 1 — 守卫先行（先红）

- [ ] 新建 `tests/mu4-capability-surfacing.test.ts`：
  - [ ] **RPC 接线覆盖守卫**：15 个方法名在 `src/renderer` 全文各 ≥1 次引用（这是本轮的总闸，红→绿即里程碑完成）
  - [ ] 审计标签：`App.vue` 含第 5 标签且 `AuditPanel.vue` 存在
  - [ ] 技能分区：`SettingsModal.vue` `NAV` 含 `skills` 分区
  - [ ] 技能指示器：`ChatView.vue` 含技能指示器锚
  - [ ] 模型组：`ProviderSettings.vue` 或新组件含 `modelgroup.` 调用
  - [ ] 同步暂停：`DevicesModal.vue` 含 `control.pause`/`control.resume`
  - [ ] 会话右键菜单：`SessionList.vue` 含三个会话级 RPC
  - [ ] 预览区多标签：`FilesPanel.vue` 含多标签结构锚
  - [ ] 徽标扩展：`SessionList.vue` 与 `TitleBar.vue` 含待批准徽标锚
- [ ] 全量跑红，逐条记录失败形态并确认红得对；commit

### Task 2 — 审计日志查看器（转绿：审计标签）

- [ ] 新建 `AuditPanel.vue`：时间线 + eventType/sessionId 筛选 + 分页
- [ ] `App.vue` 右栏加第 5 标签「审计」
- [ ] 同步修订 `e2e-mu2b-acceptance.mjs` 例 1「四 tab」断言为五 tab（**计划内修正，单独申报**）
- [ ] commit

### Task 3 — 同步暂停开关 + 状态（转绿：暂停守卫）

- [ ] `DevicesModal.vue` 加暂停/恢复开关，读 `control.status`
- [ ] `TitleBar.vue` 加同步状态点（暂停时显著化）
- [ ] commit

### Task 4 — 模型组 / 降级链界面（转绿：模型组守卫）

- [ ] 「模型」分区内加模型组列表 + 增删改 + 成员排序（降级顺序）
- [ ] commit

### Task 5 — 技能管理分区 + 对话头指示器（转绿：技能两条守卫）

- [ ] `SettingsModal` `NAV` 加「技能」分区：列表 / 启停 / 删除 / 导入（含 `importStatus` 进度）
- [ ] `ChatView` 对话头技能指示器：当前会话激活技能数 + 逐个开关（走 `sessionId` 维度）
- [ ] commit

### Task 6 — 会话级设置右键菜单 + 徽标扩展（转绿：会话级与徽标守卫）

- [ ] `SessionList` 会话卡右键菜单：记忆开关 / 模型绑定 / 删除（删除走 `confirm` 二次确认）
- [ ] `.dot-warn` 扩到会话卡与标题栏
- [ ] commit

### Task 7 — 产出物预览器升格（转绿：预览区守卫）

- [ ] `FilesPanel` 升级为多标签预览区：标签条 + 按类型路由到 `MarkdownView`/`DiffView`/原生预览
- [ ] 产物卡点击改为在预览区开新标签（复用 MU2b 的 `showTab` 通路）
- [ ] commit

### Task 8 — 文档与验收

- [ ] `PROJECT_NOTES.md` 进度节更新；计划 checkbox 按实勾选
- [ ] 三件套 + `git diff --stat -- src/minisd` 为空 + e2e 双跑 + 截图重生成
- [ ] commit

## §4 红线（执行期硬约束）

1. **`src/minisd` 整目录零改动** —— 本轮性质是接线，完成定义含 `git diff` 自查为空。若发现某能力必须改后端才能接出，**停手报告**，不得自行扩范围。
2. 零新依赖。
3. **不动 `tokens.css`** —— MU3 刚定稿并经目视调档；新组件一律消费既有别名，禁写死颜色（`tokens-mu3-appica` 例 9 零硬编码守卫继续生效）。
4. XSS 红线一行不动：Markdown 全链路禁 `v-html`/`innerHTML`；`Icon.vue` 静态字典豁免维持。**审计日志渲染尤其注意——payload 是脱敏后的用户/命令文本，必须走文本节点**。
5. 三模式（跟随系统/强制暗/强制浅）能力不得退化；MU3 的四段 token 结构与 6 个切片标记逐字保留。
6. 新增交互元素必须带 `:focus-visible` 环（MU3 §2-5 规范），且**优先用原生可聚焦元素**（`button`/`input`），不要再制造 `<div @click>` —— MU3 已留下 9 个不可达控件，本轮不得新增。
7. e2e 断言的修订仅限 Task 2 申报范围（四 tab → 五 tab），其余一字不动。
8. 不夹带 backlog（定时任务、并行会话、DOM 层无障碍改造均已顺延）。
9. 测试读源码文本一律 `replace(/\r\n/g,'\n')` 归一化行尾。
10. 执行中发现本计划未覆盖的决策点，停手报告，不自行拍板。

## §5 验收与完成定义

- [ ] npm test 全绿；测试数估算 **1031 → ≈1045**（新守卫文件约 +10 例，e2e 断言修订不增减例数）
- [ ] typecheck 0；build 三产物成功
- [ ] **`git diff --stat -- src/minisd` 为空**（本轮最硬的一项）
- [ ] **RPC 接线覆盖守卫全绿** —— 15 个零引用方法降为 0，这是里程碑的总闸
- [ ] `e2e:mu2a` 7/7、`e2e:mu2b` 8/8（后者含五 tab 修订）；18 张入库截图重生成
- [ ] 双主题逐屏截图目视（复核方亲跑）：新增五面各一屏 × 明暗 = ≥10 张
- [ ] 计划 checkbox 零未勾

## §6 影响面清单

**改（renderer）**：`App.vue`（第 5 标签）、`SettingsModal`（技能分区 + 模型组）、`DevicesModal`（暂停开关）、`TitleBar`（同步点 + 徽标）、`SessionList`（右键菜单 + 徽标）、`ChatView`（技能指示器）、`FilesPanel`（多标签预览区）、`ProviderSettings`（模型组）
**新增**：`AuditPanel.vue`、技能管理与模型组子组件（数量执行期定）
**测试**：新建 `mu4-capability-surfacing.test.ts`；`e2e-mu2b-acceptance.mjs` 例 1 四 tab → 五 tab（申报）
**零改动**：`src/minisd` 整目录、`tokens.css`、`src/main`、`src/preload`

## §7 顺延（不在本轮）

- **定时任务**（对标 AionUi `pages/cron`）：牵后端调度 + 与手机端远程触发耦合，单独立项
- **并行会话 side-by-side**：牵布局重构
- **DOM 层无障碍改造**：9 个 div 型控件的 `tabindex` + 键盘事件（MU3 遗留，见 ui-design-v3 §5-1）
- **用户 CSS 覆盖层**：MU3 的双层 token 架构使其近乎零成本，但属独立特性

## §8 执行顺序与 commit 规划

分支 `feature/mu4` 从 main 最新处切。commit 链（conventional + 中文）：

1. `docs(mu4): MU4 实施计划（待评审）`（本轮交付）
2. `test(mu4): 接线覆盖守卫 + 五面锚点守卫（先红）`
3. `feat(mu4): 审计日志查看器 + 右栏第 5 标签（e2e 四→五 tab 修订申报）`
4. `feat(mu4): 同步暂停开关 + 标题栏同步状态点`
5. `feat(mu4): 模型组 / 降级链界面`
6. `feat(mu4): 技能管理分区 + 对话头技能指示器`
7. `feat(mu4): 会话级设置右键菜单 + 待批准徽标扩展`
8. `feat(mu4): 产出物预览器升格为多标签预览区`
9. `docs(mu4): PROJECT_NOTES + checkbox 勾选`
10. `test(mu4): 重跑 e2e 并重生成入库截图`

## §9 交付报告要素

commit 链、每 Task 红/绿证据（含先红那笔单独 checkout 重放）、三件套与 e2e 原始输出、**15 个 RPC 接线前后对照表**、`git diff -- src/minisd` 为空的证据、偏差申报、checkbox 状态。
