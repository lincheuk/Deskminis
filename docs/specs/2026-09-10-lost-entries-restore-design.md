# Y 波设计稿：换壳遗失的入口成批补回（六项）

状态：**定稿即施工**（自己做模式）。立项依据：CHANGELOG 0.3.0「已知边界」写着这批入口「会成批补回」，
README 五行 🟡 等着改回 ✅，`tests/mu6-capability-wiring.test.ts` 的双向绊线就是为这一步设的
（「补上任何缺口它会红——这是设计意图」）。T6 时用户裁定**那一波**只补工作区，其余入池；本波是从池里取出来做，
决策点事后可否决返工。0.3.0 尚未上架，补在发布前比发布后补更划算。

## §1 范围：六项遗失入口，逐项从旧实现核对（教训 §7-1「换壳是搬家」）

| # | 入口 | store action / 字段 | 旧实现（`dddbbf8^`） | 新树落点 |
|---|---|---|---|---|
| **Y1** | 会话行 ⋮ 菜单：记忆开关 / 绑定模型 / 重命名 / 删除 | `setSessionMemory` `setSessionModelBinding` `renameSession` `deleteSession` | `components/SessionList.vue` 行内 `.smenu` | `ui/NavRail.vue` |
| **Y2** | 会话级禁用 MCP | `setSessionMcpDisabled` + `fetchMcpServers` | `ChatView.vue` composer「MCP」pill + 行内 `.mcpanel` | `ui/Composer.vue` |
| **Y3** | 同步暂停 / 恢复 | `setSyncPaused` `refreshSyncPaused` | `SettingsModal.vue` syncbox（三句文案） | `ui/StageDevices.vue` 首节 + `TopBar` 状态点认 paused |
| **Y4** | 助手 ↔ 技能绑定 | `skillIds` | `AssistantSettings.vue` allSkills 复选 + 提示句 | `ui/StageAssistants.vue` 表单与列表标签 |
| **Y5** | 消息锚点导航轨 | 纯渲染侧 | `ChatView.vue` `data-turn-id` + `.trail`/`.tdot` | `ui/StageChat.vue` |
| **Y6** | 清单与文案 | — | — | `mu6-capability-wiring` 清单改造、四处退场守卫复位、README 五行 🟡→✅、CHANGELOG |

**不在本波**：
- **模型组降级 UI**（README 第 34 行 🟡）：后端 `modelgroup.create/list/get/update/delete` 五个 RPC 全在（此前交接文档说「后端全通」是对的），
  但 store 没有任何 group action、设置页没有组编辑器——这是**从未有过的 UI**，不是换壳遗失；且绑定选择器里列 `group:` 选项在没有组编辑器时永远是空列表。
  单开 Z 波：store `modelGroups` + SecModels「模型组」节（建 / 改成员 / 删）+ 会话与助手两处绑定选择器加 `group:` 选项。
- 「收窄」条目（消息来源设备标、☰ 只剩主题、`Ctrl+,`、MCP env/headers 编辑器、逐台试连、用户消息复制钮、
  会话行运行态徽标与产物数、拖拽分栏、任务栏耗时读数）：未设绊线，各自很小，但塞进来会把「六项补回」糊成一锅。留池。

## §2 逐项设计

### Y1 会话行 ⋮ 菜单（NavRail.vue）

- **行结构**：现在 `.srow` 本身是 `<button>`，按钮里不能再嵌按钮。改成 `<div class="srw">` 包 `<button class="srow">`（打开会话）
  + `<button class="smore" title="<标题> 的更多操作">⋮</button>`。⋮ 平时淡出，hover / focus-within / 菜单开着时显形——不抢标题。
- **行内展开，不浮层**（旧 SessionList 的裁定原样继承）：`.list` 是 `overflow:auto`，浮层会被裁掉——MU5 §15 为「弹层被容器裁掉」吃过亏；
  行内展开也天然避开 `renderer-titlebar-stacking` 的 z-index 不变量。`v-for` 挂在 `<template>` 上（行与菜单是两个兄弟节点，
  旧实现踩过「v-for 挂错节点 s 为 undefined 整表崩」的坑，注释保留）。
- **四项**：
  - 记忆：一行按钮「记忆 · 已开启/已关闭」→ `chat.setSessionMemory(s.id, s.memoryEnabled === false)`。
  - 模型：`<select class="f-select">`，值经 `bindingValue(s)` 归一化（旧库存量裸 id 补 `provider:` 前缀，否则错显成「跟随全局默认」），
    option 值 `'provider:' + p.id`（后端 `startsWith('provider:')` 才认——T6a2 在助手侧修过同一分叉，`renderer-stage-views` 钉着助手那份，会话这份本波钉）。
    本波不列 `group:` 选项（理由见 §1）。
  - 重命名：行内 `<input>` 预填现标题 + 「确认」+ Enter；后端拒空标题 / 超 50 字的错误落在菜单里的 `renameErr` 行——吞掉就是「点了确认没反应」。
  - 删除：二次确认「确认删除？此操作不可撤销。」→ `chat.deleteSession(id)`（store 已处理「删的是当前会话就落到别处」）。
- 换行即清确认态与改名态（旧实现的 `toggleMenu` 语义）。

### Y2 会话级禁用 MCP（Composer.vue）

- pill `.mcpbtn` 放工具行「@」之后：只在 `chat.activeId && 已启用 server 数 > 0` 时出现；文案 `MCP` / `MCP · 禁 N`，
  N 只数「已启用 ∩ 已禁用」（名单里可能残留已全局删除的 server 名，光数名单会对不上可见行）。
- 面板 `.mcpanel` 行内展开在卡内工具行之下：每台一个 checkbox「本会话禁用」→ `chat.setSessionMcpDisabled(chat.activeId, next)`
  （整表覆写是后端语义；幽灵名单项原样保留，不越权清理）；一句交代「本会话禁用，下一回合生效」。
- 数据时机：`watch(activeId, immediate)`——有会话即证明 rpc 就绪，名单为空才拉（L6 目视逮到的「组件创建时裸拉、rpc 未连、pill 永不出现」教训原样继承）。
- 与斜杠 / @ 菜单互斥不必做：那两个是浮在卡上方的键盘菜单，面板在卡内，不打架。

### Y3 同步暂停 / 恢复（StageDevices.vue + TopBar.vue）

- 设备页首节「同步」：状态句（进行中：会话与记忆在已配对设备之间自动同步 / 已暂停：不再与其它设备收发会话与记忆）+
  按钮「暂停同步 / 恢复同步」→ `chat.setSyncPaused(!chat.syncPaused)` + 警示句原文照搬：
  「暂停的只是**设备间同步**，**不会中断**正在执行的任务——要停下当前回合请用输入框旁的停止按钮。暂停状态会保留到下次启动。」
  这句是 MU6 立的（用户曾以为点了能停任务），换壳不能把它丢了。
- `onMounted` 补 `refreshSyncPaused()`（init 已读回一次；进页再读一次自愈）。
- TopBar `syncDot`：`chat.syncPaused` 优先于三态——橙点（`--c-warn`）+ title「已暂停设备间同步」。状态可见是 §6 表里「状态可见改不了」那一格的另一半。

### Y4 助手 ↔ 技能绑定（StageAssistants.vue）

- 表单加「默认技能」区：`chat.allSkills` 逐个 checkbox（管理页要看得见全局停用的，标「（全局已停用）」；斜杠菜单那份 `skills` 不是它）；
  提示句原文照搬：「不勾任何项 = 跟随全局启用集；勾选 = 该助手的会话只启用勾选技能」；没有技能时「尚未安装任何技能——技能页导入或扩展市场安装后可在此勾选」。
- `fSkills` 随 `startNew/startEdit` 复位；`save` 的 input 带 `skillIds: fSkills.value`。列表卡加标签「N 项技能」。
- `onMounted` 补 `refreshAllSkills()`。

### Y5 消息锚点导航轨（StageChat.vue）

- turn 节补 `:data-turn-id="t.id"`，实时回合 `data-turn-id="live"`；`.stage` 已是 `position: relative`（注释层要的），轨道吃它。
- `<nav class="trail" aria-label="回合导航">`：≥3 回合才显示（少于 3 没有导航价值），每回合一个 `<button class="tdot">`
  （title = 用户消息首 24 字 / 「助手回合」），实时回合一个 `.tdot.live` 脉动点；点击 `scrollIntoView({ behavior: 'smooth', block: 'start' })`。
- 样式：右缘 6px 竖排 8px 圆点，`z-index: 15`（< 50 槽位）；**不写组件级 `:focus-visible`**（`renderer-focus-ring`：环收在 theme.css 一处）。
- 分栏态（`narrow`）对话列右缘有一条边线，轨道贴在线内侧。

### Y6 清单与文案

- `mu6-capability-wiring`：六条从 GAPS 挪进 WIRED；GAPS **允许为空**（自守例原写「两组都非空」，全部补回正是目标态，改口是裁定变更不是漂移）；
  两块单独绊线（锚点轨 / skillIds）翻成正向断言。**新增一条可计算的不变量**：store 的每个 action 要么 `ui/` 下有调用、要么 store 内部有 `this.x(` 调用（refresh 类 helper），
  否则必须登记在 GAPS——以后再掉一个入口，不用等人手数，清单自己会红。本波实测零 UI 调用的正好是六个缺口 + 七个内部 helper。
- 退场守卫复位：`renderer-mcp-session`（L5 pill + 面板）、`renderer-pool` L3、`renderer-session-rename`（菜单重命名项）、`renderer-assistants` 第 4 例（allSkills 数据源）——都重指新树，退场注释改成复位说明。
- README：会话 / 助手 / 输入与导航 / MCP / 设备同步五行 🟡→✅；脚注改口（只剩模型组一行 🟡）。
- CHANGELOG 0.3.0：「修复」加「界面重做时漏接的入口已成批补回」条；「已知边界」删掉两句过期的（「旧界面的组件文件尚未清理」——T6 已删净；「会成批补回」——本波已补）。

## §3 拆步与先红

| 步 | 内容 | 先红 |
|---|---|---|
| **Y1** | NavRail 菜单 | `renderer-lost-entries` Y1 组 + `renderer-session-rename` 复位例 |
| **Y2** | Composer MCP pill + 面板 | `renderer-lost-entries` Y2 组 + `renderer-mcp-session` 复位组 |
| **Y3** | StageDevices 同步节 + TopBar 点 | `renderer-lost-entries` Y3 组 |
| **Y4** | StageAssistants 技能区 | `renderer-lost-entries` Y4 组 + `renderer-assistants` 第 4 例复位 |
| **Y5** | StageChat 锚点轨 | `renderer-lost-entries` Y5 组 + `renderer-pool` L3 复位 |
| **Y6** | 清单改造 + README + CHANGELOG | `mu6-capability-wiring`（六条挪组即红 → 施工后绿） |

一次 commit 落 main（六项是一件事：把丢的搬回来），提交正文逐项申报。

## §4 验证面（drive-y1.mjs，xvfb 实拍，每场景独立数据根）

- **Y1**：发一条消息后点行尾 ⋮ → 截图；改名「已改名的会话」→ 左栏与标题栏同步；记忆点一下 → `sessions[].memoryEnabled` 翻转；
  绑定模型 → 先经 store 建一个 ollama 类 provider（免 key）→ 选中 → `sessions[].modelBinding === 'provider:<id>'`；删除 → 确认 → 会话从列表消失、`activeId` 落到别处或空。
- **Y2**：种 L6 那台连不上的 MCP → 有会话后 pill「MCP」可见 → 开面板勾禁用 → 「MCP · 禁 1」+ `sessions[].mcpDisabled` 含它 → 截图。
- **Y3**：设备页点「暂停同步」→ `syncPaused` true、标题栏点变橙 + title → 截图 → 恢复。
- **Y4**：先经 `importSkillFolder` 导入一个种子技能 → 助手页编辑「通用协作」勾上 → 保存 → `assistants[].skillIds` 含它、列表标「1 项技能」→ 截图。
- **Y5**：三回合后 `.trail .tdot` 数 = 3 → 点第一个 → `scrollTop` 回到顶部 → 截图。
- 全量对 Linux 基线 diff 空；typecheck 0；build 0；`mu6` 清单绿。

## §5 终验（施工后，main `ba4b919`）

| 项 | 结果 |
|---|---|
| 先红 | `renderer-lost-entries` 16 红 + `mu6` 9 红 + 四处复位例各 1 红 → 修后 236/236 绿 |
| typecheck / build | 0 / 0 |
| 全量 | 167 测试文件 / 1880 例（云端 1828 过 + 52 Windows-only 基线），对 Linux 基线逐行 diff 空 |
| menu | 记忆翻 false；绑定 `provider:<id>`；空标题被拒「会话标题不能为空」显示在菜单里；改名后左栏与标题栏同步；删除二次确认后会话 0、回欢迎页（`y1-menu*.png` `y1-rename-err.png` `y1-delete-ask.png` `y1-deleted.png`） |
| mcp | 「MCP」→ 面板「demo-tools · 未连接 · 本会话禁用」→ 「MCP · 禁 1」，`mcpDisabled=['demo-tools']`（`y1-mcp-*.png`） |
| sync | `syncPaused` true；标题栏点 title「已暂停设备间同步」、底色 rgb(255,125,0)；恢复后 false（`y1-sync-paused.png`） |
| skills | 导入种子技能 → 勾选 → `skillIds=['演示技能']`，列表「1 项技能」（`y1-skills-*.png`） |
| rail | 三点、title 首 24 字；点第一个 scrollTop 2444→20（`y1-rail*.png`） |
| 守卫订正 | `<button v-if=` 单行写法放宽为 `\s+`（属性换行是排版自由，意图不变） |
