# Z 波设计稿：模型组降级的界面（README 最后一行 🟡）

状态：**定稿即施工**（自己做模式）。交接文档 §6 二档「Z 波候选」；Y 波收官时 README 只剩这一行 🟡。
0.3.0 仍未发布（2026-09-24 查 Releases 只有 v0.1.1），改动继续记在 0.3.0 名下。决策点事后可否决返工。

## §0 事实盘点（读代码 + 立项前探针 `probe-z0.mjs`，现有构建 `ba4b919`）

**后端早就全了**（M2b Task 7）：`modelgroup.create/list/get/update/delete` 五个 RPC；`chat.prompt` 认 `group:<id>`——
链首为主、其余按序为降级链；`chat.contextInfo` 取链首窗口；`resolveGroupMembers` 静默跳过已删 provider；
组不存在或成员全删 → 抛「模型组无可用成员」。`modelgroup.update` 收到空 `memberIds` 会**静默忽略**（保留旧成员）——界面必须自己拦。

**什么时候换下一个**（`providers/types.ts` + `agent/loop.ts`）：
- 400/401/403/404/422/429（限流、密钥失效、请求被拒）→ **立刻**换；
- 网络错误与 500/502/503/504/529 → 先在原模型上走重试梯 3/5/10/15/30 秒（约一分钟）再换；
- 其它错误与空响应 → 有下一个就换。

**降级成功后会话改绑**（M2b 设计 §4.2，刻意的）：接手的那个跑通一回合，会话绑定被改写成 `provider:<接手者>`，只改一次。
之后这个会话不再回到组里。

**探针实测（真 provider + 本地假 OpenAI 端点：主力回 429、备用流式回复；数据根种两个免密钥 ollama 类 provider + 一个组，默认模型设为备用）**：

| # | 现象 | 证据 |
|---|---|---|
| ① | 输入卡模型胶囊**无视会话绑定**：会话绑到组，胶囊照旧显示默认模型 | `before send: binding "group:…", pill "mock-backup"` |
| ② | 降级改绑后**前端停在旧值**：后端已是 `provider:备用`，前端 `sessions[].modelBinding` 仍是 `group:` | `staleBinding "group:…"`、重拉后 `"provider:BBBB…"`、`stale: true` |
| ③ | 降级提示的起点写着 **`main`**——`loop.ts` 给首个 slot 写死的内部标签；只有带降级链时才会进事件，也就是**只有模型组会话才漏** | `fallbackState.from: "main"`；任务面板卡原样显示「main → 备用(mock-backup)：…」 |
| — | 降级链本身是通的：主力被请求一次、备用接手回复 | `mockHits: ["/fail/…#mock-primary", "/ok/…#mock-backup"]` |

② 平时被掩盖：首回合的自动命名会广播一次 `chat.sessions.changed`，顺手把列表刷新了；探针先改名让自动命名不触发，才暴露出来。
①③ 都是「界面撒谎」（教训 §7-3）与「内部标识符漏给用户看」（§7-2）。

## §1 范围

| 步 | 内容 | 落点 |
|---|---|---|
| **Z1** 后端两处 | ② 改绑后 `rpc.broadcast('chat.sessions.changed', {})`；③ `RunOptions.primaryLabel`（缺省仍是 `main`，只有带降级链的调用会传），组路径传 `名称(模型 id)`，与链上其余成员同一格式 | `minisd/index.ts` `agent/loop.ts` |
| **Z2** 纯模块 | `normalizeBinding`（裸 id 补 `provider:`——NavRail 与 StageAssistants 各写一份的归一化收成一处）、`describeBinding` → `{ kind, label, short, title, missing }`、`groupChain` | `lib/models/binding.ts` |
| **Z3** store | `modelGroups` + `refreshModelGroups / createModelGroup / updateModelGroup / deleteModelGroup`（写后重拉；删除带 `confirm:true`；init 拉一次，失败不拖垮启动） | `stores/chat.ts` |
| **Z4** 设置页 | 新组件挂在「模型」tab、provider 列表之后：列表（组名 + 链「A → B」+ 已删成员标注 + 在用数）、编辑器（名称、成员有序 ↑↓移出、加入下拉、校验、两句说明）、删除确认报绑定数。provider 删除确认补一句「它在 N 个模型组里」 | `ui/settings/SecModelGroups.vue` `SecModels.vue` `StageSettings.vue` |
| **Z5** 绑定入口 + 胶囊 | 会话菜单与助手编辑器的模型下拉加 `<optgroup label="模型组">`（值 `group:<id>`）；绑定值指向已删对象时补一个 disabled 选项如实显示；助手列表标签走 `describeBinding`；输入卡胶囊显示**实际生效**的绑定（会话绑定 > 欢迎页选中助手的绑定 > 默认），组用 link 图标 + 组名、title 给整条链，绑定对象已删 → 警示色 | `NavRail.vue` `StageAssistants.vue` `Composer.vue` |
| **Z6** 清单与文案 | mu6 WIRED 加三条；README 最后一行 🟡→✅、图例改写；CHANGELOG | — |

## §2 文案（照事实写，不美化）

- 编辑器说明一：「按顺序使用：排第一的出错时自动换下一个。限流、密钥失效、请求被拒会立刻换；网络中断和服务端 5xx 先在原模型上重试约一分钟再换。」
- 编辑器说明二：「换成功后，这个会话会改绑到接手的模型，之后不再回到组里；想回到组，在会话菜单里重新选它。」
- 单成员提示：「只有一个成员时不会降级，效果和直接选这个模型一样。」
- 校验：名称空 →「给模型组起个名字」；成员空 →「至少选一个模型」（后端对空成员静默忽略，这句必须在前端拦）。
- 删除确认（有绑定时）：「N 个会话、M 个助手绑定了它；删除后它们发消息会报「模型组无可用成员」，需要重新绑定。」
- 胶囊 title：组 →「模型组「主备」：主力 → 备用（按顺序降级）」；已删 →「绑定的模型组已删除，发送会报错——在会话菜单里重新选」。

## §3 不做（理由）

- **默认模型设成组**：后端 `provider.setDefault` 只认 provider id，要动后端语义，另议。
- **删组时级联解绑**：会让助手预设悄悄改变；现在的处理是如实报错 + 胶囊警示 + 删除前告知绑定数。
- **降级成功后自动回到组**：M2b 的刻意设计（别反复撞已失败的主力），改它是另一场讨论；本波只负责把它说清楚。
- **欢迎页 ModelBar 认组**：它管的是默认 provider；「这条消息实际用谁」由胶囊负责，Z5 之后两者分工清楚。
- **降级原因的原始报文**（如 `OpenAI HTTP 429: {"error":…}`）：是 provider 的真实报错，排查 API 问题要用；事件条已收在「详情」里。任务面板卡直显原文，记账不改。

## §4 拆步与先红

| 步 | 先红 |
|---|---|
| Z1 | `tests/modelgroup-fallback-rebind.test.ts`：测试内起本地假 OpenAI 端点，两个 ollama 类 provider 组成组，会话先改名再绑组；断言 ①后端改绑成 `provider:备用`（特征测试，修前就绿）②fallback 之后收到 `chat.sessions.changed` ③fallback 事件的 `from` 是「主力(mock-primary)」不是 `main` |
| Z2 | `tests/models-binding.test.ts`（纯函数，模块不存在即红） |
| Z3 | `tests/renderer-model-groups.test.ts` store 组（pinia + mock rpc 的行为测试，成例 `renderer-default-provider`） |
| Z4-Z5 | 同文件源码守卫组（认调用形态）+ `mu6` 三条 WIRED；`renderer-lost-entries` Y1 的 `bindingValue` 守卫**重指**（归一化逻辑搬进纯模块，由 Z2 的单测接住） |
| Z6 | — |

两笔 commit：Z1 后端单独一笔（独立的 bug，界面之外也成立）；Z2-Z6 一笔。

## §5 验证面（`drive-z1.mjs`：真 provider + 本地假端点，不用 FakeProvider）

- **groups**：设置 → 模型 → 新建组「主备」，先加备用再加主力，↑ 把主力提到第一 → 保存 → 列表链「主力（会限流） → 备用」。
- **bind**：新建会话 → 先改名 → ⋮ → 模型选「主备」→ 胶囊显示 link 图标 + 主备 → 发消息 → 降级提示起点是「主力（会限流）(mock-primary)」→ 回合结束后胶囊变成备用、会话菜单下拉值 = `provider:备用`（②的修复，GUI 侧复验）。
- **assistant**：助手编辑器模型下拉有组 → 选中保存 → 列表标签「组 · 主备」。
- **delete**：会话绑回组 → 删组，确认句含「1 个会话」→ 回会话，胶囊警示「绑定的模型组已删除」→ 发消息 → 红横幅「模型组无可用成员」。
- 全量对 Linux 基线 diff 空；typecheck 0；build 0。

## §6 终验（施工后，main `7415ee7`（Z1）+ `761b862`（Z2-Z6））

| 项 | 结果 |
|---|---|
| Z1 先红 | 首跑 `expected 'main' to be '主力(mock-primary)'`；修 ③ 后 ② 变红「等待超时: 改绑后的 chat.sessions.changed 广播」；修 ② 后 2/2 绿。①修前就绿（特征测试） |
| Z1 全量（隔离 worktree，只带三个文件） | typecheck 0；168 文件 / 1882 例（1830 过 + 52 基线），基线 diff 空；rpc.test.ts 4 例红逐条核对在基线内 |
| Z2-Z6 先红 | `models-binding` 模块不存在即红；`renderer-model-groups` 16 红（store 缺 action + 组件不存在 + 下拉 / 胶囊未接）；`mu6` 3 红（新 WIRED 三条）；`renderer-lost-entries` 1 红（Y1 归一化守卫重指） |
| Z2-Z6 全量 | typecheck 0；170 测试文件 / 1914 例（云端 1862 过 + 52 Windows-only 基线），基线 diff 空；build 0 |
| 实拍（`drive-z1.mjs`，真 provider + 本地假端点） | 空成员点创建被拦「至少选一个模型」、组数仍 0；先加备用再加主力 → ↑ 后顺序「主力 → 备用」；创建后列表链「主力（会限流） → 备用」；会话菜单 optgroup「模型组」只有「主备」一项；绑组后胶囊「主备」+ link 图标，title「模型组「主备」：主力（会限流） → 备用（按顺序降级）」；发消息 → 假端点收到 `/fail#mock-primary`、`/ok#mock-backup` 各一次；**不手动刷新**，前端绑定自己变成 `provider:备用`、胶囊变成 mock-backup、菜单下拉值同步（Z1 广播的 GUI 复验）；任务面板卡「主力（会限流）(mock-primary) → 备用(mock-backup)：…」；助手编辑器选组 → 列表标签「组 · 主备」；删组确认「1 个会话、1 个助手绑定了它；删除后它们发消息会报「模型组无可用成员」，需要重新绑定。」；删后胶囊橙色「绑定的模型组已删除」、会话菜单禁用项「组已删除」且被选中；再发消息 → 红横幅「模型组无可用成员」、草稿留在框里；助手标签变「已删除的模型组」（err 色）；零 pageerror |
| 实拍当场修的两处 | 会话菜单禁用项原文「已删除的模型组（请重新选择）」在百来像素宽的下拉里被截成「已删除的模型」，读成删的是模型 → 改最短说法「组已删除 / 模型已删除」；删除确认句末「确认删除？」在「删/除」中间折行、又和按钮重复 → 去掉 |
| 守卫订正 | `renderer-lost-entries` Y1 的 `bindingValue` 守卫重指：归一化逻辑搬进纯模块，语义由 `models-binding` 单测接住，这里只钉「委托给它」 |

**实拍看到、记账不修**：
- 欢迎页上方的默认模型条（ModelBar）与输入卡胶囊并排时会显得矛盾（`z1-bound.png`：条上「mock-backup」、胶囊上「主备」）。
  条管的是**默认**模型，界面上没写明这一点——候选：条上加「默认」字样，或绑定生效时给一句提示。
- 会话行 ⋮ 菜单的开合状态跨视图保留（去设置再回来，菜单还开着）。无害，记一笔。
- 任务面板降级卡直显 provider 原始报文（`OpenAI HTTP 429: {"error":…}`），见 §3。
- **不属本波的既有撒谎**：点「新建会话」得到空会话后再在欢迎页选助手，副标题写「已选 X——直接输入即以该预设开始」，
  但 `Composer.send()` 只在**没有**活动会话时才按助手建会话——消息发进当前空会话、不带预设。候选池一档小修。
