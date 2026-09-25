# 附录 C：DeskMinis 界面部件溯源（阅读者原稿）

结论：现有界面里能坐实出自 OpenCode 的只有一处，就是标题栏的窗口形制：无边框窗口，右上角的最小化/最大化/关闭交给系统绘制（Electron titleBarOverlay 参数）。它是 2026-07-27 与 OpenCode 研读在同一个提交 5c6e4f5 里写进 docs/specs/2026-07-26-deskminis-ui-design.md:109-128（§4.0）的，参数与 docs/research/opencode-0.md:9 记的 OpenCode 做法逐项一致，现落在 src/main/index.ts:131-133 和 ui/TopBar.vue。

OpenCode 研读的定位是「验证 minisd 架构」（提交说明原话）。它给界面提的建议一条都没进 ui/ 树：设计令牌分两层、命名字号类、data-component 样式约定、流式文字控速、虚拟化时间线、工具渲染器注册表、权限 dock、首帧防闪。src/ 与 tests/ 里 grep 不到 opencode 字样，THIRD-PARTY-NOTICES 也没有 OpenCode 条目。

你怀疑的那批部件其实另有出处：
- **写在 OpenCode 研读之前**：三栏工作台、终端、任务面板/上下文水位、file_edit 差分、斜杠菜单、内联权限卡，都写在 2026-07-26 的总设计 §7（design.md:337-351，提交 bcbdf55）和头脑风暴决定表（PROJECT_NOTES.md:33）里，比 OpenCode 研读早一天。出处是照 OpenMinis 复刻，加上 Codex/WorkBuddy 两个基准（ui-audit.md:7-13）。
- **来自 AionUi**：产出物预览当主舞台、「View Steps」步骤组、右栏「文件/改动」，出自用户 I6 给的第三张 AionUi 截图（PROJECT_NOTES.md:627），在 T4 落地。

所以按字面「裁 OpenCode 相关」几乎无可裁。按用户真实意图（去掉 coding 味、向 cowork 收），值得动的是三处自有件：
1. **cut 底部终端抽屉**：面向 coding；是哑管道，没有行编辑；界面还在说「与 agent 共用 shell」的假话。
2. **replace 任务面板**：藏在右栏第三个 tab 里。改成 AionUi / ZCode / OpenCode 三家一致的输入卡上下文占用环，降级/压缩/卸载与停止原因并入对话流事件条。
3. **simplify**：右栏收成 AionUi 同款「文件 / 改动」两 tab；TopBar 去掉只切主题、不落盘的 ☰ 钮和终端钮；窗控符号色与右侧 146px 改照 ZCode 的做法随主题和缩放同步。

其余部件（NavRail、欢迎页、会话舞台、输入卡、预览主舞台、Office 预览、步骤组、差分、权限卡、助手、定时、市场、设置）都保留。

时机：W2b 正在改 TaskPanel、WorkspacePanel、TopBar（hemostasis/renderer.md:33、:72-93、:153），路线也规定 0.3.0 前不加新功能（roadmap.md:311）。所以裁剪应排在 W3 发版之后，先出设计稿。发版前只做 W2b-11 已排的「终端共用 shell」文案订正。

以 OpenCode V2 为基准，该落在新增交互上，不在裁剪上：权限 dock、跟进队列 dock、撤销 dock、上下文占用指示。这几项对应已排的 W7a/W7b/W8b/W9c。

## 标题栏窗口形制（无边框 + 系统绘制窗控 titleBarOverlay + 右侧 146px 让位）及同步状态点

- 文件：/home/user/Deskminis/deskminis/src/main/index.ts、/home/user/Deskminis/deskminis/src/renderer/src/ui/TopBar.vue、/home/user/deskminis-docs/docs/specs/2026-07-26-deskminis-ui-design.md、/home/user/deskminis-docs/docs/research/opencode-0.md
- 出处：OpenCode。ui-design.md:109-128（§4.0 自绘标题栏）是在 docs 提交 5c6e4f5「自绘标题栏规格 + OpenCode 架构研究」（2026-07-27）里加进去的。参数与 opencode-0.md:9 所记 OpenCode desktop windows.ts 逐项一致：Windows 用 frame:false + titleBarOverlay{color:'#00000000', symbolColor 随明暗, height 40}；macOS 用 titleBarStyle:'hidden' + trafficLightPosition。T 波 TopBar.vue:2-4 沿用这套形制。同步点是 M3c 自创。
- 出自 OpenCode：是
- 现状：在用。main/index.ts:131-133 的 symbolColor 写死 '#808080'，不随主题变；TopBar.vue:58 写死 padding-right:146px。右侧有同步点（:41）、终端钮（:42-44）、工作台钮（:45-47）。守卫：renderer-titlebar-stacking.test.ts（全树 z-index 低于标题栏槽位）、renderer-shell-panels.test.ts:19（钉 toggle-term）、renderer-lost-entries / renderer-m3c（同步暂停点）、renderer-welcome、renderer-settings-modal。W2b-3 正在 TopBar 下方加断线横幅（hemostasis/renderer.md:33-42）。
- 用户价值：4
- 建议：simplify｜形制本身保留。AionUi 在 Windows 上也是 frame:false（aionui packages/desktop/src/index.ts:489-499），ZCode 用 titleBarOverlay，三家基准都这么做，砍掉反而要自绘窗控。

要校正的是两处 OpenCode 做对、我们抄漏的细节，改照 ZCode 的做法：
- 主题或页面缩放变化时，用 win.setTitleBarOverlay 同步 overlay 高度与符号色；
- 经 IPC 把右侧安全区宽度推给渲染端，取代写死的 146px。
参照 /home/user/refs/zcode/packages/desktop/src/main/desktopWindowButtonPosition.ts:90-110（Apache-2.0）。照搬要按 THIRD-PARTY-NOTICES 的登记格式署名，并过 license-consistency.test.ts 的双向绊线。

这就是路线 W9c 的「缩放后窗控与 146px 保留区在真机上校验」（roadmap.md:247）。

要动的文件：main/index.ts、preload/index.ts（加一个订阅）、TopBar.vue。守卫：新增「符号色随主题」一条；titlebar-stacking 不受影响。

风险：W2b-3 正在改 TopBar，须排在 W3 之后；窗控效果只能在 Windows 真机目视验证。

## TopBar ☰「菜单」钮（实际只切换明暗、不落盘）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/TopBar.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/settings/SecLook.vue
- 出处：自创遗留，与 OpenCode 无关。ui-design.md §4.0 原本规划了「文件/编辑/视图/帮助」一整套自绘菜单。之后逐步收缩：UI 审计 IA-3 批评「标题栏功能虚设」（ui-audit.md，IA-3 节），I6 收成单个 ☰（PROJECT_NOTES.md:619-624）。T 波在 AppShell.vue:63 留了注释「T5 接菜单，先留接口」，至今没有接。
- 出自 OpenCode：否
- 现状：在用但名不副实：TopBar.vue:33-35 的钮 title 是「菜单」，AppShell.vue:64-67 的 toggleTheme 只翻转 dataset.theme，不落盘。设置 → 外观（SecLook.vue:16-27）会写 localStorage，但只在打开外观页时 onMounted 才读回，所以启动时保存的主题不生效，☰ 切出来的主题重启即丢，两个入口互相覆盖。没有专门守卫。
- 用户价值：1
- 建议：cut｜做法：
- 删掉 ☰ 钮、emit 'menu' 和 AppShell 的 toggleTheme，主题只留「设置 → 外观」一个入口。AionUi 的标题栏也没有这种杂项钮。
- 把 SecLook 的 apply 抽成纯函数，在应用启动时（main.ts 或 AppShell 的 onMounted）读回已保存的主题。这就是路线 W9c 的「已保存的主题在首帧生效」。

要动的文件：TopBar.vue:33-35、AppShell.vue:63-67 与 :77、SecLook.vue。守卫：新增一条「TopBar 不再有 menu 事件、主题启动即读回」。

风险低。docs/RELEASE.md 的手动冒烟清单若提到 ☰ 要同步改（W 波吃过「检查单验错界面」的亏）。可以与 W9c 一起做。

## 底部终端抽屉 TerminalPane（含 TopBar 终端钮、minisd terminal.* 与 TerminalManager）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/TerminalPane.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/TopBar.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue、/home/user/Deskminis/deskminis/src/minisd/terminal.ts、/home/user/Deskminis/deskminis/src/minisd/index.ts、/home/user/Deskminis/deskminis/package.json、/home/user/Deskminis/deskminis/tests/terminal.test.ts、/home/user/Deskminis/deskminis/tests/renderer-shell-panels.test.ts、/home/user/Deskminis/deskminis/tests/renderer-content-form.test.ts、/home/user/Deskminis/deskminis/tests/deps-frozen.test.ts
- 出处：不是 OpenCode。出处链：
- 头脑风暴决定表「右=可收起的终端/文件/任务面板」（PROJECT_NOTES.md:33）；
- 总设计 §7「终端（xterm.js 实况）」（2026-07-26-deskminis-design.md:346，提交 bcbdf55，比 OpenCode 研读早一天），来源是 OpenMinis 复刻加 Codex 方向；
- M2d 落地（plans/2026-07-28-m2d-right-panel-ui.md:28-50）；
- T 波改成底部抽屉（TerminalPane.vue:2）。
形态碰巧与 OpenCode（packages/app/src/pages/session/terminal-panel-v2.tsx）和 ZCode（DESIGN.md:485-487 的 bottom terminal frame）相同。AionUi 没有交互终端，全仓只有一个 xterm-headless shim。
- 出自 OpenCode：否
- 现状：在用。入口是 TopBar 终端钮 → AppShell 的 termOpen（:31，默认收起，:102 用 v-if 挂载）。

体验上是无 PTY 的哑管道：没有行编辑，没有 Tab 补全，宽度固定 500 列（m2d 计划 :50）。

界面文案不实：TerminalPane.vue:63 与 :108、README.md:31、CHANGELOG.md:33、docs/RELEASE.md:47 都说「与 agent 共用同一个长驻 shell」。实际 minisd/terminal.ts:11 自称「与工具 shell 独立实例」，index.ts:337 的 TerminalManager 与 :341 的 ShellManager 是两套实例。这一条已列入 W2b-11（hemostasis/release.md:269、:305、:381）。

守卫：
- renderer-shell-panels.test.ts:14-32（V4 三例）；
- renderer-content-form.test.ts:43-56（终端配色两例）；
- terminal.test.ts（5 例，在 Linux 基线失败清单里，只在 Windows 跑）；
- deps-frozen.test.ts:29-30 钉住 @xterm 两个包。
- 用户价值：2
- 建议：cut｜cut 判据全中：
- 面向 coding 的专业件，cowork 用户不敲 PowerShell；
- 哑管道体验差；
- 维护面大：独立的 PowerShell 驱动脚本、xterm 依赖、W1b-1 进程树回收也要照顾它、5 例只能在 Windows 跑的测试；
- 还在说假话。

替代做法：
- 照 AionUi，不给用户交互终端，agent 跑的命令和输出在对话流里看。DeskMinis 已经有：StepGroup 展开区的「输出」块（StepGroup.vue:60-63）。
- 将来如有后台长命令，照 ZCode 的只读 bash-output 侧栏页（/home/user/refs/zcode/packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx），不做可输入终端。

分两步：
1. 0.3.0 前只做 W2b-11 已排的文案订正，不砍。
2. W3 之后单独一步砍。要动：
   - 删 TerminalPane.vue、TopBar 终端钮与 AppShell 的挂载（:24、:31、:76、:102）；
   - 删 minisd/terminal.ts、index.ts:335-338 的装配、:964-965 的两个 RPC，以及删会话时顺带销毁终端的分支；
   - 删 terminal.test.ts；renderer-shell-panels V4 与 renderer-content-form 终端两例按「随实现退场，原位留理由」处理；
   - docs/handoff/linux-baseline-failures.txt 删 5 行，否则基线 diff 非空；
   - README:31、CHANGELOG、RELEASE.md:47 改写；
   - WorkspacePanel.vue:138 提示语去掉「终端」（renderer-workspace-shell.test.ts:65 的正则仍会被「shell」满足）。

@xterm 两个依赖要删，需要用户点头，并改 deps-frozen 的 FROZEN 与锁文件。锁文件要在本机 npm 生成，云端按规则做不了。可以先只砍界面，依赖留给用户本机处理。

风险：
- 失去「在终端里手动调 windows-* 桥命令」这个小众入口（m2d 决策 #8）。
- mu6 的不变量只查 store action，而终端直接调 rpc，砍掉不会有守卫变红。能力退场必须在提交正文里申报，README 能力行同步删掉，不能指望守卫兜底（T 波教训）。

## 任务面板 TaskPanel（上下文水位条 + 降级/压缩/卸载/待批准四态 + 上轮结束原因）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/TaskPanel.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/WorkspacePanel.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/EventNotes.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/Composer.vue、/home/user/Deskminis/deskminis/src/renderer/src/stores/chat.ts、/home/user/Deskminis/deskminis/src/renderer/src/lib/eventnote/copy.ts、/home/user/Deskminis/deskminis/tests/renderer-shell-panels.test.ts、/home/user/Deskminis/deskminis/tests/renderer-tasks-panel.test.ts、/home/user/Deskminis/deskminis/tests/mu6-capability-wiring.test.ts
- 出处：不是 OpenCode。出处链：
- 总设计 §7「任务（回合进度、token 用量、上下文水位条）」（design.md:346-347，早于 OpenCode 研读）；
- M2d Task 5 首建（m2d 计划 :7、:20）；
- UI 审计 H5 以 WorkBuddy/Codex 为参照，批评它字段稀疏（ui-audit.md:48-55）；
- V5 在新壳重建（TaskPanel.vue:1-8）。
OpenCode 的对应物是输入区旁的上下文指示加侧栏 context 页（/home/user/refs/opencode/packages/app/src/components/session-context-usage.tsx），但当年的研读没有记这一条。
- 出自 OpenCode：否
- 现状：在用，但藏在右栏第三个 tab：WorkspacePanel.vue:99-101 的「任务」→ :169 的 TaskPanel。每 15 秒轮询一次 chat.contextInfo（TaskPanel.vue:16-18）。

内容：
- 水位条（:47-60）；
- 等你批准（:62-68）；
- 降级/压缩/卸载三张卡（:70-95）。这些对话流的 EventNotes 已经出过条，面板是第二份。UI 审计早就指出「同一事件双份呈现」（ui-audit.md:42）。
- 上轮结束原因（:97-100）。「达到单轮输出上限——回答可能被截断」全界面只在这里出现。

W2b-2 正在改这里的待批准计数（hemostasis/renderer.md:72、:84）。

守卫：
- renderer-shell-panels.test.ts:34-49（V5）与 :60-69（V5c，StopReason 四值都有中文）；
- renderer-tasks-panel.test.ts S1-S4，钉 store 的 contextInfo/fallbackState/compactedState/offloadedState 字段（chat.ts:105-113）和 fetchContextInfo（:582）。
- 用户价值：3
- 建议：replace｜信息有用，位置错：cowork 用户不会去翻右栏第三个 tab。

换成三家基准一致的做法：输入卡工具行上放一个上下文占用环，悬停看详情。
- AionUi：components/agent/ContextUsageIndicator.tsx，挂在 AcpSendBox.tsx:933。拿不到真实窗口大小时只画空心环，不拿猜的分母给百分比。
- ZCode：packages/ui/src/chat-input-toolbar/contextUsage.tsx。
- OpenCode V2：session-context-usage.tsx。
环的形态取 AionUi（用户喜欢的风格）；数值语义跟路线 W5b，以最近一次真实 usage 为锚。

其余内容的去向：
- 降级/压缩/卸载三张卡删掉，只留 EventNotes 一份。
- 「上轮结束原因」（maxTokens、refusal）改成 EventNotes 的新 kind，追加在联合类型末尾（chat.ts:108 注释写明既有守卫按前缀子串匹配）。
- 「等你批准」由 W2b-2 的 NavRail 等待标和 W7b 的权限 dock 承担。
- 最后 WorkspacePanel 去掉「任务」tab（见 WorkspacePanel 那一条）。

要动的文件：
- 删 TaskPanel.vue；
- Composer.vue 加环。刷新改由事件触发：store 在 turnEnd/fallback/compacted/offloaded 分支里已经调 fetchContextInfo（chat.ts:522 起），15 秒轮询可以去掉；
- EventNotes.vue 与 lib/eventnote/copy.ts 加停止原因。

守卫：
- renderer-shell-panels 的 V5/V5c 重指到 Composer 和 EventNotes。StopReason 四值中文这条不变量保留，只换文件；
- renderer-tasks-panel 的 store 字段锚，若删三个 state 字段要逐条退场并留理由。

风险（T 波「换壳遗失入口」教训）：mu6 的「store action 零 UI 调用」不变量抓不到这次搬家。fetchContextInfo 在 store 内部有 this. 调用，三个 state 字段又不是 action，面板删掉后守卫照样全绿。必须先在 mu6「非 store action 的界面能力」一节加正向钉（水位环、停止原因文案），再删面板。

时机：W3 之后，与 W9c「输入区显示上下文占用环」（roadmap.md:247）合并做。

## 右栏工作区面板外壳 WorkspacePanel（文件 / 改动 / 任务 三 tab）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/WorkspacePanel.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue、/home/user/Deskminis/deskminis/tests/renderer-shell-panels.test.ts、/home/user/Deskminis/deskminis/tests/renderer-workspace-shell.test.ts
- 出处：不是 OpenCode。右栏的演变：
- 最早是总设计 §7 的三个抽屉：终端/文件/任务（design.md:346，OpenMinis/Codex 方向）；
- MU5 改成工作台（ui-design-v4.md §3-§4，依据是 AionUi 与 Agent Canvas 截图）；
- T 波按用户 I6 第三张 AionUi 截图「工作区树右栏」重做（PROJECT_NOTES.md:627；WorkspacePanel.vue:2-4 注释写「用户参考图的 Workspace 栏」）。
AionUi 的这一栏正好是「文件 / 变更」两个 tab（/home/user/iofficeai/aionui/packages/desktop/src/renderer/pages/conversation/explorer/ExplorerContainer.tsx:512-548）。第三个「任务」tab 是 V5 自己加的。
- 出自 OpenCode：否
- 现状：在用。只在 view==='chat' 时显示（AppShell.vue:105-109），TopBar 的「工作台」钮负责开合。

三个 tab 挤在 244px 里，按钮被迫 nowrap（WorkspacePanel.vue:187-189 注释：V4 实拍时「文件」被折成两行）。文件 tab 顶部是 T6b 补回的工作区绑定行。

守卫：
- mu6 WIRED 的三条工作区能力（mu6-capability-wiring.test.ts:66-68）；
- renderer-workspace-shell.test.ts；
- renderer-files-panel、renderer-artifacts:73；
- renderer-shell-panels V5（钉 'tasks'）；
- workspace-picker.test.ts。

W2b-2 与 W2b-4 正在改它（hemostasis/renderer.md:85、:153）。
- 用户价值：4
- 建议：simplify｜收成 AionUi 同款两个 tab：「文件 / 改动」，去掉「任务」tab。任务内容的去向见 TaskPanel 那一条。

要动：
- WorkspacePanel.vue 的 tab 联合类型（:63）、tab 按钮（:99-101）、TaskPanel 的 import（:10）和 v-else（:169）；
- renderer-shell-panels 的 V5「工作区面板多一个任务 tab」改为反向锚，或退场并留理由。

好处：244px 不再拥挤，可以去掉 nowrap 那段补丁。

风险：工作区绑定入口在文件 tab 里，本身不受影响，但改 tab 结构后要跑一遍 renderer-workspace-shell 全套和 mu6。W2b 期间不动。

## 改动清单（WorkspacePanel「改动」tab + lib/artifacts/collect）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/WorkspacePanel.vue、/home/user/Deskminis/deskminis/src/renderer/src/lib/artifacts/collect.ts、/home/user/Deskminis/deskminis/tests/renderer-artifacts.test.ts
- 出处：不是 OpenCode。
- 数据源是 MU2b Task 3 的「产物 tab」（collect.ts:1-4）。UI 审计 H5 以 WorkBuddy 的「结果区……变更/预览、产物汇总」为参照（ui-audit.md:48-55）。
- T 波把它放进 AionUi 截图里 Changes 的位置（WorkspacePanel.vue:3-4）。
OpenCode 的对应物是带行内评论的 git 差分审阅面板（packages/app/src/pages/session/v2/review-panel-v2.tsx），DeskMinis 没有照它做。
- 出自 OpenCode：否
- 现状：在用。WorkspacePanel.vue:89 走 collectArtifacts，:160-168 渲染列表，点条目会打开预览。

只统计 file_write、file_edit、office_write，shell 命令改动的文件统计不到（aionui.md:370 已指出）。

守卫：renderer-artifacts.test.ts（纯模块 5 例、接线、V8 的 office_write 2 例）；renderer-shell-panels.test.ts:51-58（V5b，单一数据源）。
- 用户价值：4
- 建议：keep｜保留。cowork 的核心诉求是「agent 给我做出了什么」，这张清单就是入口。

可选的文案级简化：「改/写」标签和 +N/-N 计数偏 coding，可以把「改动」改叫「产出」。AionUi 叫「变更」，指的是 git，含义不同。

后续增强不属于裁剪，已在排期：
- 路线 W8b：每回合一张改动卡 + 写前检查点 + 一键回退（roadmap.md:224）。对应 OpenCode V2 composer 区的 SessionRevertDock（/home/user/refs/opencode/packages/app/src/pages/session/composer/session-composer-region.tsx:92-117）与 ZCode 的检查点。
- shell 改动的兜底按 aionui.md:370 的建议，走只读的 git status --porcelain。

## 文件树 + 工作区绑定（WorkspacePanel「文件」tab + UiFileTree）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/WorkspacePanel.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/UiFileTree.vue
- 出处：总设计 §7「文件（工作区+挂载树）」（design.md:346）；M2d Task 4 首建；T 波按 AionUi 截图「工作区树右栏」放置（PROJECT_NOTES.md:627），与 AionUi explorer 同构；T6b 补回绑定入口（WorkspacePanel.vue:17-60）。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用。文件树懒加载；绑定行在 :108-145，提供原生选择器和粘贴路径两种方式。守卫：mu6 WIRED 中的 setWorkspace/resetWorkspace/pickWorkspaceFolder；renderer-workspace-shell.test.ts；renderer-files-panel.test.ts；workspace-picker.test.ts。
- 用户价值：4
- 建议：keep｜保留，不动。cowork 用户需要看到和找到文件。可选的小改不属于裁剪：AionUi v2.1.60 起的「全部折叠」、刷新钮忙态绑定真实 Promise、tooltip 向左展开（aionui.md:366-370）。

## 产出物预览主舞台（PreviewPane + TabBar 标签 + OfficeView + 舞台分栏）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/PreviewPane.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/TabBar.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/OfficeView.vue
- 出处：AionUi。
- AppShell.vue:32-33 注释：「Cowork 形态的核心（用户 2026-08-21 参考图）：产出物是主角」；
- I6 第三张截图的「文件预览中心化」（PROJECT_NOTES.md:627）；
- 三态工具条照 AionUi 的「Source / Preview / 分屏」（PreviewPane.vue:29-31，ui-design-v4.md §4 的「模式段控」）。
OfficeView 是 U 波参考 OfficeCLI 的设计自建的（PROJECT_NOTES.md:725-735）。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用。从改动/文件 tab 点开，或经 pendingFilePreview 打开，舞台就分栏，对话收成左边一条（AppShell.vue:85-92、:118-122）。守卫：renderer-files-panel、renderer-office-preview、renderer-pool、a11y-keyboard-reachable（TabBar）。
- 用户价值：5
- 建议：keep｜保留。这正是「像 cowork」的主轴。已排的增强不属于裁剪：
- W8a：「用系统程序打开 / 在文件夹中显示」，绝对路径改由 minisd 过工作区围栏后返回，顺带修掉 PreviewPane.vue:74 在渲染端自己拼绝对路径的问题；
- AionUi 的预览最大化与 tab 右键菜单（aionui.md:244-256）。

## 工具步骤组 StepGroup（「已执行 N 步」折叠）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StepGroup.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageChat.vue、/home/user/Deskminis/deskminis/tests/renderer-tool-steps.test.ts
- 出处：AionUi「View Steps」（StepGroup.vue:2；I6 第三张截图里的「View Steps 折叠」，PROJECT_NOTES.md:627）。更早「一个工具一枚胶囊」的做法出自 OpenMinis（ui-design.md:152）。

OpenCode 研读建议过三件：按工具名注册渲染器、未知 MCP 工具用通用图标兜底、重内容延迟挂载（opencode-0.md:23-24、:61-62）。都没有采纳，StepGroup 只对 file_edit 开了一个特例分支。
- 出自 OpenCode：否
- 现状：在用。StageChat.vue:86-129 负责回合切分；:192 渲染历史步骤组，:202 渲染实时步骤组。默认收起；展开后列出 tool_title，再按工具显示 file_edit 差分，或参数 JSON 与输出（各截 2000 字）。守卫：renderer-tool-steps.test.ts（6 例）、renderer-content-form.test.ts:36-41（进行中有活动指示）、diff.test.ts。
- 用户价值：4
- 建议：keep｜保留。这是 AionUi 形态，默认收起、对话是主角，对 cowork 友好。

可选简化：展开区的原始「参数」JSON 对非开发者是噪音。可以只让 file_edit 显示差分，其它工具默认只列标题和输出，参数收进二级「详情」折叠。改动小，要调 renderer-tool-steps.test.ts:44-56 两例的锚。

W7c 已排：已完成回合折叠成「已工作 N 分钟」，运行中/已中断的步骤各有状态点（roadmap.md:203）。

## 差分视图 UiDiff（权限卡写入预览 + 步骤组 file_edit）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/UiDiff.vue、/home/user/Deskminis/deskminis/src/renderer/src/lib/diff/lcs.ts、/home/user/Deskminis/deskminis/src/renderer/src/lib/diff/payload.ts
- 出处：出处链：
- 总设计 §7「file_edit 内嵌 diff」（design.md:343）；
- UI 审计 X-4 以 Codex 的 diff 式展示为基准（ui-audit.md:118）；
- A 波的「审批卡 diff 预览」（PROJECT_NOTES.md:93）；
- V1 在新壳重建（UiDiff.vue:1-3）。
差分算法是自写的 LCS，不是 OpenCode 用的 @pierre/diffs（opencode-0.md:25）。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用两处：权限卡批准前预览要写入的内容（PermCard.vue:68 附近的 UiDiff），和步骤组展开 file_edit（StepGroup.vue:48-55）。守卫：diff.test.ts、renderer-chat-capabilities.test.ts、renderer-tool-steps.test.ts。
- 用户价值：3
- 建议：keep｜保留。权限卡里的差分是「批准前看清要写什么」的安全件，对非开发者同样有用：写周报、改文档也会走 file_edit。不要换成 OpenCode 的虚拟化差分库，那是新依赖，违反零依赖红线。

## 权限确认卡 PermCard（对话流内联，三钮 + 倒计时 + 桥双段告知）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/PermCard.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageChat.vue、/home/user/Deskminis/deskminis/tests/renderer-permcard.test.ts
- 出处：OpenMinis 权限 sheet 的内部构图，改成内联进对话流（ui-design.md:174 起「5.1 权限确认（内联卡，非模态）」）；「仅此次 / 本会话允许 / 拒绝」三钮同源。OpenCode 研读建议改成输入框上方的 dock（opencode-0.md:26、:63），没有采纳。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用。StageChat.vue:216-217 按 chat.pendingPerms 渲染，按钮在 PermCard.vue:74-80。V 波才补回：此前从未渲染过，是发布级阻断。守卫：renderer-permcard.test.ts、renderer-chat-capabilities.test.ts。W2b-2 正在把它改为按会话过滤（permsOf）。
- 用户价值：5
- 建议：keep｜发版前不动。

W7b 已排「PermCard 停靠到输入区（Composer 用 v-show 保住草稿）+ 拒绝时可附一句反馈」（roadmap.md:202）。这正是 OpenCode V2 的 SessionPermissionDock（/home/user/refs/opencode/packages/app/src/pages/session/composer/session-permission-dock.tsx，once/always/reject 三键），也是 DSH「审批接管输入区」的做法，属于「以 OpenCode V2 为基准」的替换。

但要吸取 opencode-2.md 的教训：OpenCode 的 dock 把「总是允许」的授权范围藏起来了。DeskMinis 的卡必须继续逐字显示路径、命令与授权范围，PermCard.vue 头注释那三条规矩不能丢。若照搬 OpenCode 代码，需在 THIRD-PARTY-NOTICES 新开一个 MIT 条目（目前没有 OpenCode 条目）。

## 斜杠技能菜单 + @ 文件引用 + 输入历史（Composer 输入辅助）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/Composer.vue、/home/user/Deskminis/deskminis/src/renderer/src/lib/composer/at-files.ts、/home/user/Deskminis/deskminis/src/renderer/src/lib/composer/history.ts
- 出处：都不是 OpenCode。
- 斜杠菜单：出自 OpenMinis 的「slash-menu skill rows as a pure typing aid」（readers-2.md:42），经总设计 §5.1「/名字 斜杠菜单 = 纯输入辅助」（design.md:238），在 M2c Task 7 落地。
- @ 文件与输入历史：出自 AionUi（aionui-survey.md:37-38 的 AtFileMenu 与 SendBox 历史缓冲），在 L 波落地。
- 出自 OpenCode：否
- 现状：在用：斜杠菜单在 Composer.vue:48-57，@ 文件在 :59-89，输入历史在 :91-100。守卫：renderer-pool.test.ts:49-63（L2 接线，斜杠优先、两菜单互斥）、composer-at-files.test.ts、renderer-composer.test.ts。
- 用户价值：3
- 建议：keep｜保留。技能是 cowork 的核心资产，斜杠菜单就是它的输入口。可选（不属裁剪）：按 AionUi v2.1.60 的 MentionMenuShell，把 / 与 @ 两个菜单统一成一个外壳，高度按视口封顶，键盘导航时滚动跟随（aionui.md:268）。

## 三栏外壳 AppShell（NavRail | Stage | WorkspacePanel + 视图路由）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue
- 出处：不是 OpenCode。
- 头脑风暴决定表「三栏式工作台」（PROJECT_NOTES.md:33）与总设计 §7（design.md:337），都在 OpenCode 研读之前，照 OpenMinis 复刻；
- MU5 的布局 B 来自 AionUi 与 Agent Canvas 截图（ui-design-v4.md §3-§4）；
- T 波按 AionUi 形态重建（ui-rebuild-design.md §3）。
UI 审计定下的三个基准是 Codex、WorkBuddy、OpenMinis（ui-audit.md:7-13），从来没有 OpenCode。
- 出自 OpenCode：否
- 现状：在用，是入口根：main.ts → AppShell。视图路由见 :47，预览分栏见 :32-45，终端挂载见 :102。守卫：renderer-stage-views、renderer-shell-panels、renderer-welcome、renderer-tasks-panel 等 14 个 renderer 测试引用它。
- 用户价值：5
- 建议：keep｜骨架保留。前面几条裁掉终端、收掉任务 tab 后，它自然收敛成 AionUi 的「侧栏 + 会话 + 预览 + 工作区」四区。已排的增强：W9b 可拖分栏，采用 AionUi useResizableSplit 的数值（roadmap.md:246）。

## 左导航 NavRail（分组导航 + 会话行 ⋮ 菜单 + 模型组下拉）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/NavRail.vue
- 出处：AionUi Sider（aionui-survey.md:32）：I6 对齐到 AionUi 新版（PROJECT_NOTES.md:619-624），T 波重建（NavRail.vue:2-4），Y1 补回 ⋮ 菜单，Z5 加模型组。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用。守卫：mu6 WIRED 的删除、重命名、记忆、模型绑定四条（mu6-capability-wiring.test.ts:72-75）；renderer-lost-entries、renderer-model-groups、renderer-session-rename、renderer-sessioncard。W2b-2 要在这里加等待标（hemostasis/renderer.md:73）。
- 用户价值：5
- 建议：keep｜保留。W7b 已排「等待 > 运行 > 未读」三级徽标，照 AionUi 的等待态 reducer（roadmap.md:202）。

## 欢迎页 StageWelcome + 默认模型条 ModelBar

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StageWelcome.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/ModelBar.vue
- 出处：AionUi：GuidPage 与 assistantCard（StageWelcome.vue:2-5；aionui-survey.md:28）；ModelBar 照 AionUi homepage.png 上的 CLI 胶囊条（ModelBar.vue:2-5）。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用。StageWelcome.vue:56-57 挂着 ModelBar 与 hero 态输入卡。守卫：renderer-welcome、renderer-assistants、renderer-composer、renderer-modelbar-default（W2b-5 刚改完）。交接 §6 记过「ModelBar 与输入卡胶囊并排显得矛盾」。
- 用户价值：4
- 建议：keep｜保留。W2b-5 已经给 ModelBar 标上「默认模型」。欢迎页选助手的撒谎，W2b-4 做最小修、W8a 做结构修（roadmap.md:223）。ModelBar 是否与胶囊合并，等 W8a 后再评估，现在不动。

## 会话舞台 StageChat 与输入卡 Composer 主体（用户气泡 / 助手满宽 / 胶囊 / 附件 / 锚点导航轨）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StageChat.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/Composer.vue
- 出处：AionUi。
- 用户气泡右对齐缺角，助手满宽平铺（StageChat.vue:264-269 注释「AionUi --message-user-bg / 同形」；aionui-survey.md 的 §2 表）；
- 输入卡静止零阴影、双层托盘（Composer.vue:5、:364）；
- 锚点轨照 AionUi MessageAnchorRail（aionui-survey.md:39），L3 首建、Y5 补回。
与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用。守卫：renderer-first-send、renderer-chat-stream、renderer-content-form、renderer-mcp-session、renderer-model-groups、renderer-attach-shell；mu6 的锚点轨正向钉（mu6-capability-wiring.test.ts:116-123）。W2b 正在改 Composer（hemostasis/renderer.md 引用 7 处）。
- 用户价值：5
- 建议：keep｜保留。以 OpenCode V2 为基准的增强都落在这里，而且都是新增，不是裁剪：
- W7a 的 QueueDock：对应 OpenCode V2 的 SessionFollowupDock 与 specs/v2/session.md 的 durable inbox 加 steer/queue 两种投递；
- W7c 的 PlanBar：对应 AionUi 的 ConversationPlanBar，或 OpenCode 的 SessionTodoDock；
- W9c 的上下文环。
按路线 roadmap.md:301，每波只动一个耦合簇。

## 事件提示条 EventNotes（降级/压缩/卸载/修剪/重试/出错/同步/压缩失败）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/EventNotes.vue、/home/user/Deskminis/deskminis/src/renderer/src/lib/eventnote/copy.ts
- 出处：自创。UI 审计 H4 以 OpenMinis 的 AssistantBlockView info 块为参照（ui-audit.md:36-45）；MU2a Task 8 首建（chat.ts:108 注释）；V2 在新壳重建（EventNotes.vue:1-7）。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用：StageChat.vue:212。守卫：renderer-eventnote、renderer-eventnote-copy、renderer-compact-failed、renderer-chat-capabilities、tokens-evolution。
- 用户价值：4
- 建议：keep｜保留，并让它接手任务面板的降级/压缩/卸载状态和停止原因（见 TaskPanel 那一条）。新增 kind 一律追加在 chat.ts:108 联合类型的末尾。

## 思考块 ThinkBlock

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/ThinkBlock.vue
- 出处：AionUi MessageThinking（aionui-survey.md:33），I4 视觉对齐，V3 在新壳重建。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用：StageChat.vue:191、:199。守卫：renderer-thinking、renderer-chat-capabilities。
- 用户价值：3
- 建议：keep｜保留，不动。

## 文本选区注释 / 引用层 AnnoLayer

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/AnnoLayer.vue
- 出处：自创（H 波，PROJECT_NOTES.md:540-560）：用 CSS Custom Highlight API，零 DOM 改写。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用。守卫：renderer-anno-shell、renderer-annotations、annotations-*。
- 用户价值：3
- 建议：keep｜保留。对阅读长文、改稿的 cowork 场景有用，维护面小。

## 助手管理 StageAssistants + 定时任务 StageCron

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StageAssistants.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageCron.vue
- 出处：AionUi：助手体系与 ICronSchedule 三态（aionui-survey.md:34-35，§4 cowork 化路线）→ J/K 波 → T5 进新壳。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用，从 NavRail 分组进入。守卫：renderer-assistants、renderer-cron、renderer-stage-views、mu6 的助手技能正向钉（mu6-capability-wiring.test.ts:125-131）、renderer-lost-entries。
- 用户价值：5
- 建议：keep｜保留，这是 cowork 的地基。W7b 要给定时任务加注意力回路（通知里写明「90 秒后自动拒绝」）；W4a 的办公助手包会直接用上这里的助手目录。

## 扩展市场 StageMarket

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StageMarket.vue
- 出处：自创。依据是七家 harness 插件生态调研（docs/research/2026-08-19-harness-plugin-market-survey.md：DSH、goose、ClawHub、MCP 官方注册表），G 波落地，V7 进新壳。那份调研里 OpenCode 因为「没有机器可读的市场」被排除（survey.md:48-51、:117）。
- 出自 OpenCode：否
- 现状：在用。它是全树唯一的模态宿主（z 100）。守卫：renderer-market、renderer-market-shell、renderer-titlebar-stacking（值级豁免）。
- 用户价值：4
- 建议：keep｜保留，安全闸不动。

## 设备配对与同步 StageDevices

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StageDevices.vue
- 出处：OpenMinis 的 Sync V2 与 LANTransport 理念（PROJECT_NOTES.md:75-77），经 M3a/b/c，T5 进新壳。OpenCode 研读的结论是 OpenCode 在这方面没有可借鉴的先例（opencode-study-synthesis.md 的 GAPS 一节）。
- 出自 OpenCode：否
- 现状：在用，从 NavRail 底部进入。守卫：renderer-devices、renderer-m3c、mu6 WIRED 的 setSyncPaused（mu6-capability-wiring.test.ts:77）。
- 用户价值：3
- 建议：keep｜保留。W2b-8 已排：sync.hello 带上协议版本。

## 设置页 StageSettings（模型/模型组/权限/技能/MCP/搜索/外观/关于）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StageSettings.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/settings/SecLook.vue
- 出处：自创（T5，StageSettings.vue:1-5），表单原语是 theme.css 里的 .f-*。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用。守卫：renderer-stage-views（七节）、renderer-settings-modal、renderer-mcp-settings、renderer-model-groups、auto-update，以及 mu6 WIRED 中的技能、MCP、模型组各条。
- 用户价值：5
- 建议：keep｜保留。唯一的连带修改见 ☰ 那一条：SecLook 的主题读回要挪到启动时执行。

## 会话搜索 StageSearch（只搜标题）

- 文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StageSearch.vue
- 出处：自创（T5，StageSearch.vue:1-5），页面上如实写明「只搜会话标题」。与 OpenCode 无关。
- 出自 OpenCode：否
- 现状：在用，从 NavRail 进入。没有专门守卫（tests 里 grep 不到 StageSearch）。
- 用户价值：2
- 建议：keep｜保留。W8c 已排用 LIKE 做正文搜索（roadmap.md:225），届时再补守卫。现在不裁：维护面小，也没有 coding 味。

## 备注

- 方法与总判断。按任务要求读完了以下材料：opencode-0 至 opencode-3、opencode-study-synthesis、docs/specs 下各设计稿（ui-design 各版、ui-audit、v4、I 波、T 波、hemostasis）、交接文档 §4-§7、PROJECT_NOTES，以及 m2d、m2c 两份计划。

定时间线：
- 总设计与界面 §7：docs 提交 bcbdf55，2026-07-26 17:49；
- OpenCode 研读：docs 提交 5c6e4f5，2026-07-27 00:04，提交说明原话是「OpenCode 研究独立验证了我们的核心决策（utilityProcess sidecar、每次启动令牌认证、sandbox preload），并给出 M2/M3 应提前采纳的事件溯源存储」，研读定位是验证 minisd 架构，不是界面参考。

其余证据：
- 此后所有界面设计稿都没有出现 OpenCode 字样；
- 源码侧 grep -i opencode 在 src/、tests/、scripts/ 零命中；
- THIRD-PARTY-NOTICES 没有 OpenCode 条目；
- main 分支上只有 W1a-1 提交正文提到 OpenCode，而且只是在统计研究报告份数。
- OpenCode 研读给界面的建议（opencode-0.md:57-76、synthesis「M4 / UI redesign」）落地情况，逐条核对都是没有落地：
- 两层令牌：实际走的是 Appica 槽位 + AionUi 取值（tokens.css:1-20）；
- data-component/slot 样式约定：没有；
- 流式文字控速 createPacedValue 与 16ms 合批：store 里 grep 不到 flush/coalesce/requestAnimationFrame（chat.ts:504 起 onEvent 逐条直写）；
- 虚拟化时间线：StageChat 没有，只在滚动贴底时用了双 rAF；
- 工具渲染器注册表与 MCP 通用兜底：StepGroup 只对 file_edit 开特例；
- 权限 dock：是内联卡；
- 首帧防闪 FOUC 与原生背景色同步：没有，且保存的主题只在打开外观页时才生效。

唯一有些像的是 theme.css:256-262 的 .t-* 命名字号类，形状像 OpenCode 的 .text-14-medium，但 T 波设计稿（ui-rebuild-design.md §2.2）把它归因于 AionUi 实测。ZCode 的 DESIGN.md:7-18 也强制 text-ui-* 字号阶，所以不算 OpenCode 出处。
- 「以 OpenCode V2 为底层功能基准」该落在哪里：落在新增的人在回路交互，不在裁剪现有界面。OpenCode V2 composer 区有五个 dock（/home/user/refs/opencode/packages/app/src/pages/session/composer/session-composer-region.tsx:42-135），与路线的对应是：
- 权限 dock → W7b；
- 提问 dock → W7b 的 ask_user；
- 待办 dock → W7c 的 PlanBar（用户偏好 AionUi，形态建议取 ConversationPlanBar）；
- 撤销 dock → W8b 的检查点 + 回退；
- 跟进 dock → W7a 的 QueueDock，底层语义照 specs/v2/session.md 的 durable session_input inbox 加 steer/queue；
- 上下文占用指示 components/session-context-usage.tsx → W9c。

OpenCode V2 里纯 coding 的件建议明确不借：带行内评论的差分审阅面板（v2/review-panel-v2.tsx、session-ui 的 line-comment*）、terminal-panel-v2、文件浏览 tab。

2026-09-24 的重读报告只覆盖 OpenMinis、AionUi、DSH、ZCode、pi 五家，没有重读 OpenCode。若要把 OpenCode V2 正式纳入 W7-W9 的借鉴栏，建议先补一份 V2 研读，重点读 specs/v2/session.md 与 composer docks，再改 roadmap.md 各波的「借鉴」行。
- 顺带核实的问题（都不是 OpenCode 相关，但与本次要动的部件重叠）：
1. 终端「与 agent 共用同一个长驻 shell」是假话，出现在 TerminalPane.vue:63 与 :108、README.md:31、CHANGELOG.md:33、docs/RELEASE.md:47。实际 minisd/index.ts:337 与 :341 是两套实例。已列入 W2b-11（hemostasis/release.md:269、:305、:381）。
2. 托盘菜单「切换右栏」「打开设置」两条 IPC（main/index.ts:118-119 → preload/index.ts:17-28）在新树里没人订阅。已排 W2b-11 与 W9b。
3. 主题问题：SecLook 只在打开外观页时读回 localStorage，启动时不生效；TopBar 的 ☰ 切主题又不落盘，两处互相打架。
4. 「达到单轮输出上限——回答可能被截断」全界面只在任务 tab（TaskPanel.vue:37、:97-100）出现，用户基本看不到。砍任务面板时必须把它挪进事件条，不能跟着丢。
- 纪律与时机：
- W2b 正在改 TaskPanel、WorkspacePanel、TopBar、NavRail、Composer（hemostasis/renderer.md:33、:72-93、:153，文件清单在 :285-290）。
- 路线规定 0.3.0 前不加任何新功能或迁移（roadmap.md:311）。
- 因此本清单里的 cut/replace/simplify 全部排在 W3 发版之后，单独立一个「界面减法」子波，先出设计稿（自己做模式下定稿即施工、事后可否决）。
- 每一步都要 xvfb 实拍（交接 §7 第 4 条：全绿不等于界面正常）。
- 建议顺序：① ☰ 与主题首帧（最小）→ ② 任务面板换成上下文环加事件条，同时 WorkspacePanel 收成两 tab → ③ 砍终端（涉及依赖与 Windows 基线）→ ④ 窗控随主题和缩放同步（需真机）。
- 守卫风险（T 波「换壳遗失入口」的教训落到这次）：
- mu6-capability-wiring.test.ts:144-150 的可计算不变量只认「store action 在 ui/ 下有调用」，这次三处搬家它都抓不到：
  - 终端直接调 rpc.call('terminal.*')；
  - 水位的 fetchContextInfo 在 store 内部有 this. 调用；
  - fallbackState、compactedState、offloadedState 是 state，不是 action。
  所以砍之前，要先在 mu6「非 store action 的界面能力」一节（:115-132）给新落点加正向钉：上下文环、停止原因文案。
- 退场的守卫一律原位留理由，不留 .skip。
- 删掉 terminal.test.ts 要同步 docs/handoff/linux-baseline-failures.txt（5 行），否则 Linux 基线 diff 非空。
- deps-frozen.test.ts 钉着 @xterm 两个包：删依赖要用户点头，锁文件要在本机 npm 生成。
- 若照搬 AionUi 的 ContextUsageIndicator、ZCode 的 desktopWindowButtonPosition 或 OpenCode 的 dock 代码，要写「改编自 <名>（https://…）」，并在 THIRD-PARTY-NOTICES 按登记格式立节。license-consistency.test.ts 的双向绊线会检查这一点；OpenCode（MIT）目前还没有条目。
- 未核实或只读了部分的内容：
- OpenCode 1.18.32 的 session-context-usage.tsx 只读了前 80 行，session-side-panel.tsx 只 grep 了 tab 相关；
- ZCode 的 side pane 只看了 lib/workspaceSidePane.ts 的 type 表和 desktopWindowButtonPosition.ts:90-110；
- AionUi 的 ContextUsageIndicator 只看了 props 与挂载点；
- main 分支 src/main/index.ts 的 git 历史被压过，titleBarOverlay 那几行的最早提交显示为 933d4c3，出处以 docs 提交 5c6e4f5 的设计稿为准；
- 按规则没有构建、运行或实拍，所有「在用」判断都来自源码可达性（AppShell 挂载与入口按钮）。