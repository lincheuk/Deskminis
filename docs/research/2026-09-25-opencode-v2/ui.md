# 附录 B：OpenCode V2 界面与客户端（阅读者原稿）

结论：OpenCode 1.18.32 的「V2 界面革新」主要是一次减法。新布局（Home 页 + 标题栏标签页）已从实验开关变成强制默认，旧的「左侧项目/工作区/会话侧栏」界面按硬编码日落日 2026-09-14 下线；默认界面里的 IDE 件大多撤下或默认隐藏，包括文件树、搜索、状态、终端、推理摘要、自定义智能体和「在 VSCode/Cursor 中打开」。内核仍是 coding：项目等于代码目录，改动审阅靠 git 或快照，非 git 目录会引导用户「创建 Git 仓库」；工具渲染器是 read/glob/grep/edit/patch/bash；还有 LSP 面板和 ghostty 终端。所以它是「coding 内核 + 去 IDE 化的外壳」，不是通用 cowork 产品。

数据流上处于过渡态。app 靠探测区分 v1/v2 服务端，拿到 V2 的投影消息（SessionMessageInfo）之后又在前端归一回 V1 的 Message/Part 给 session-ui 渲染。实时通道仍是全局 SSE，16ms 合批；按会话 after=seq 续传的接口已在规格里，但 app 还没用。app 用的客户端是仓外 vendored 的 tarball（1.17.13-v2），它的事件名（session.input.admitted、session.execution.*）和仓内 schema 的 session.next.* 对不上。sdk-next 是进程内宿主，不开端口，仓内没有任何消费者。

对 DeskMinis：
- 会话导航以 AionUi 的左侧分组会话栏为准，不学 OpenCode 砍掉侧栏。
- 以下几条作为底层交互基准，其中多条与 AionUi 形态相同，两边互相印证：
  - 渐进披露：默认界面最小，专业件放进「高级」；
  - 会话级「等待你 > 运行中 > 未读」三态；
  - 提问、计划、排队钉在输入框上方的 dock；
  - 只读探索类工具合并为「已探索 · N 次读取」；
  - 注册表式工具渲染，带兜底；
  - 输入框交互抽成纯状态机；
  - 服务端投影消息 + seq。
- 可以裁或降级的「OpenCode 同类 coding 件」：TopBar 常驻的终端按钮、终端抽屉入口（改走命令/高级开关）、默认展开的文件树，以及注释写着「默认收起」、实际 wsOpen=ref(true) 的右栏。
- 权限卡保留 DeskMinis 自己的 PermCard 规则（路径逐字、倒计时由后端判定），它比 OpenCode 的 dock 更好：OpenCode 至今不展示「始终允许」会保存的范围。

路径约定：opencode/ 指 /home/user/refs/opencode，deskminis/ 指 /home/user/Deskminis/deskminis，aionui/ 指 /home/user/iofficeai/aionui。

## 发现

### 界面总骨架：旧侧栏布局强制下线，改为「Home + 标题栏标签页」（相关度 5，布局/多会话）

新布局默认 true。旧界面日落日硬编码为 2026-09-14，过期后 resolveNewLayoutDesigns 恒返回 true，偏好也会被强制写成 true。新布局外壳只有 Titlebar 加 main，没有侧栏。路由从目录作用域 /:dir/session/:id 改为服务器作用域 /server/:serverKey/session/:id，旧路径只留重定向。首页 / 是 NewHome，新会话走 /new-session?draftId= 草稿标签。旧的 pages/layout.tsx（2444 行，含项目/工作区/会话侧栏）仍在树里但不可达。

证据：opencode/packages/app/src/context/settings.tsx:60-63 newLayoutDesignsDefault=true、oldInterfaceSunset=new Date(2026,8,14)；opencode/packages/app/src/context/settings.tsx:128-131 resolveNewLayoutDesigns：retired 时恒 true；opencode/packages/app/src/context/settings.tsx:340-344 日落后强制写 newLayoutDesigns=true；opencode/packages/app/src/i18n/en.ts:954-959 「Use the new tabs and home layout…」「The previous layout is no longer available」；opencode/packages/app/src/pages/layout-new.tsx:26-47 只有 Titlebar + main + Toast，无侧栏；opencode/packages/app/src/app.tsx:615-645 新旧路由分支；/:dir/session/:id → NewLayoutLegacySessionRedirect；opencode/packages/app/src/pages/layout.tsx（2444 行，旧侧栏壳仍在树中）

对 DeskMinis：与 DeskMinis 定位冲突，不作基准。AionUi 的核心形态就是左侧分组会话栏（aionui/packages/desktop/src/renderer/pages/conversation/GroupedHistory/index.tsx:241），DeskMinis 的 NavRail 已经是这个形态（deskminis/src/renderer/src/ui/NavRail.vue:1-4）。砍掉侧栏、改用浏览器式标签，就是用户说的「四不像」。标签页只在「产出物标签」这一层借用，DeskMinis 已有 TabBar.vue，保持现状。

### 多会话状态可见性：标签头像三态，等待你（权限/提问，含子会话）> 运行中转圈 > 未读（相关度 5，多会话/权限提问）

每个会话标签的头像由 useSessionTabAvatarState 推出状态。needsAttention 表示本会话或任一子会话有待答的权限或提问（BFS 遍历会话树），显示红点，并且优先于转圈。working 时显示 SessionProgressIndicatorV2。其余情况看 unseenCount，有未读就显示红点。

证据：opencode/packages/app/src/pages/layout/project-avatar-state.ts:36 needsAttention = hasPermissions || hasQuestions；opencode/packages/app/src/pages/layout/project-avatar-state.ts:41-45 unread 含 attention；loading 在 attention 时让位；opencode/packages/app/src/pages/layout/session-tab-avatar.tsx:49-60 转圈与项目头像切换；opencode/packages/app/src/pages/session/composer/session-request-tree.ts:3-34 子会话请求沿 parentID 树冒泡

对 DeskMinis：值得作为底层交互基准。与 AionUi v2.2.1 的「等待你 > Spin > 未读点」完全同构（见 docs/research/2026-09-24-resurvey/aionui.md R5），两家独立得出同一结论。DeskMinis 的 NavRail.vue 目前没有运行/等待/未读三态，做法是在 lib/ 写纯 reducer：waitingBySession(sessionId → Set<requestId>) 加 running 加 unseen，NavRail 行首按优先级渲染。子会话（pool/batch 若有）的请求也要冒泡到父会话。

### 消息流：行模型 + 虚拟化；只读探索类工具合并为「Exploring/Explored · N reads, M searches」；todo 不进流；推理默认隐藏（相关度 5，消息流/工具调用展示）

时间线先把消息拍平成类型化行：TurnGap、CommentStrip、UserMessage、TurnDivider（compaction/interrupted）、AssistantPart、Thinking、DiffSummary、Error、Retry，再做虚拟化。连续的 read/glob/grep/list 合并成 ContextToolGroup，标题是 Exploring/Explored，附动画计数。todowrite 在流里隐藏，由 todo dock 显示。question 工具在待答期间隐藏，由提问 dock 显示。推理摘要默认不显示，会话忙时只出一行 Thinking 加推理标题。

证据：opencode/packages/app/src/pages/session/timeline/timeline-row.ts:7-52 行类型联合；opencode/packages/app/src/pages/session/timeline/rows.ts:100-200 constructMessageRows（中断分隔、压缩分隔、Thinking 行）；opencode/packages/session-ui/src/components/message-part.tsx:607-608 CONTEXT_GROUP_TOOLS={read,glob,grep,list}、HIDDEN_TOOLS={todowrite}；opencode/packages/session-ui/src/components/message-part.tsx:711-719 renderable：question 待答隐藏；opencode/packages/session-ui/src/components/message-part.tsx:663-700 groupParts；:1043-1083 ContextToolGroup；opencode/packages/ui/src/i18n/en.ts:87-88 Exploring / Explored；opencode/packages/app/src/context/settings.tsx:193 showReasoningSummaries:false

对 DeskMinis：作为基准，但要和 AionUi 的做法混合。DeskMinis 的 StepGroup.vue 按 AionUi「View Steps」把整轮工具默认收成一行。OpenCode 的粒度更细：只合并只读探索类，写入、命令这类有副作用的工具单列可见。对 cowork 用户最要紧的是「它改了什么、发了什么」，建议 StepGroup 只折叠只读类，写文件、跑 PowerShell、外发类单列。todo/计划不进流，放到输入框上方的计划条（见 dock 条目）。

### 权限/提问/todo/排队/回滚都是输入框上方的 dock；权限和提问出现时直接替换输入框（相关度 5，权限/提问/计划todo）

SessionComposerRegion 自上而下依次是：提问 dock、权限 dock（两者出现时 blocked，不渲染输入框）、可折叠的 todo dock（带进度与当前项）、回滚 dock、排队 dock（Send now/Edit），最后是输入框。子会话里输入框被禁用，并提供「返回父会话」。
- 权限 dock：三个按钮 Deny / Allow always / Allow once，只列 patterns。
- 提问 dock：支持多题分页、单选/多选、「自己输入答案」、拒绝，草稿按请求缓存。
- 追问行为：默认 steer，可切换 queue。

证据：opencode/packages/app/src/pages/session/composer/session-composer-region.tsx:38-60 提问与权限 dock；opencode/packages/app/src/pages/session/composer/session-composer-region.tsx:62-83 todo dock；:133-140 followup dock；:141-155 子会话禁用输入；opencode/packages/app/src/pages/session/composer/session-permission-dock.tsx:36-50 三键；:63-70 仅渲染 request.patterns；opencode/packages/app/src/pages/session/composer/session-question-dock.tsx:92-101 多题/多选/自定义；:238-262 reject；opencode/packages/app/src/pages/session/composer/session-todo-dock.tsx:59-71 进度与当前项；opencode/packages/app/src/context/settings.tsx:187 followup:'steer'；opencode/packages/app/src/pages/session.tsx:1754-1757 queueEnabled；opencode/specs/v2/session.md:157 steer 在安全回合边界提升

对 DeskMinis：分三块处理：
- 作为基准：提问 dock（多题、多选、自填、可拒绝）和「计划/todo 钉在输入框上方」，后者与 AionUi 的 ConversationPlanBar 同构（aionui/packages/desktop/src/renderer/pages/conversation/PlanBar/ConversationPlanBar.tsx）。
- 不照搬：权限。DeskMinis 的 PermCard.vue:2-13 在流内出现，逐字完整路径、倒计时由 minisd 判定，比 OpenCode 的 dock 更安全（OpenCode 不展示 always 会保存的范围），保留 PermCard；可以在输入框上方加一条「有 N 个待批准」的镜像指示。
- 列为发布后基准：排队/引导。DeskMinis 现状是运行中禁止发送（deskminis/src/renderer/src/ui/Composer.vue:33），这是缺口。

### 渐进披露：新布局默认隐藏文件树/搜索/状态/终端/推理/工具展开/自定义智能体（相关度 5，设置/界面精简）

defaultSettings 把 showFileTree、showNavigation、showSearch、showStatus、showTerminal、showReasoningSummaries、shellToolPartsExpanded、editToolPartsExpanded、showCustomAgents 全设为 false。visible() 在新布局下服从偏好，旧布局下恒显示。新用户（非升级用户）默认隐藏智能体切换，这时固定用 Build。这些开关集中在设置的「高级」分区。

证据：opencode/packages/app/src/context/settings.tsx:183-197 defaultSettings；opencode/packages/app/src/context/settings.tsx:279 visible = !newLayoutDesigns() || preference()；opencode/packages/app/src/context/settings.tsx:97-100 initialAgentVisibility（新装为 false）；opencode/packages/app/src/i18n/zh.ts:931-932 「隐藏时默认使用 Build 智能体」；opencode/packages/app/src/components/settings-v2/general.tsx:389-443 AdvancedSection

对 DeskMinis：这是最值得当作底层交互基准的一条：默认最小界面，专业件进「高级」，入口不删只藏。它与「像 cowork、AionUi 风格」不冲突，反而互相加强。DeskMinis 现状有一处自相矛盾：AppShell.vue:6 注释写「Aside 默认收起」，:28 却是 wsOpen=ref(true)。建议按此基准改为默认收起，或在首次有产出物时自动展开；文件树 tab 不默认激活，改为「改动」优先。

### 数据流：app 仍是 v1/v2 双模型过渡态，全局 SSE 加前端归一（相关度 5，客户端数据流）

数据流分以下几段：
- 协议探测：app 先探测服务端是 v1 还是 v2，再用 createCompatibleApi 路由请求。
- 消息加载：v2 路径用 messageApi.list 按游标分页取投影消息（首屏 20 条、翻页 200 条），经 normalizeSessionMessages 转回 V1 的 Message/Part，再交给 session-ui 渲染；step-start、step-finish、patch 三种 part 直接丢弃。
- 实时通道：全局 event.subscribe（SSE），经 adaptServerEvent 把 v2 事件名映射回 v1，入队合并后每 16ms 刷一次；断线 250ms 后重连。app 没有使用规格里的 sessions.events/history 的 after=seq 续传。
- 缓存：会话缓存上限 40 个。
- 协议漂移：客户端来自 vendored tarball 1.17.13-v2，reducer 处理的 session.input.admitted、session.execution.* 在仓内 schema/client 中不存在（仓内是 session.next.*，规格自称「experimental and unshipped」）。

证据：opencode/packages/app/package.json:57 @opencode-ai/client: file:vendor/opencode-ai-client-1.17.13-v2.tgz；opencode/packages/app/src/utils/server-protocol.ts:26-37 detectServerProtocol；opencode/packages/app/src/context/server-session.ts:29-31 SKIP_PARTS、页大小 20/200；:540-563 按游标分页；opencode/packages/app/src/utils/session-message.ts:48-120 normalizeSessionMessages → V1 Message/Part；opencode/packages/app/src/context/server-session-v2-reducer.ts:29-384 事件归约（session.input.admitted 等）；opencode/packages/app/src/context/server-sdk.tsx:28-56 adaptServerEvent；:218-220 16ms/8ms/250ms；:275-280 全局订阅；opencode/packages/app/src/context/global-sync/session-cache.ts:5 SESSION_CACHE_LIMIT=40；opencode/packages/schema/src/session-event.ts:95 仓内为 session.next.prompt.admitted；opencode/specs/v2/session.md:173 session.next.* 仍 experimental and unshipped；:179 sessions.history after/limit

对 DeskMinis：基准取 V2 的目标形态：服务端投影出类型化消息联合并按游标分页，持久事件带 seq 可续传，只在线的 delta 不进游标。不要学它的过渡态，也就是前端拿到新模型再归一回旧模型、再加一层协议兼容：server-session.ts 1427 行、server-compat.ts 518 行、reducer 509 行都是这层代价。DeskMinis 发版前不迁协议；将来重构 chat store（deskminis/src/renderer/src/stores/chat.ts，636 行）时，直接消费 minisd 的投影视图。16ms 合批加 delta 拼接是零依赖的小改动，可以先做。

### 定位判断：OpenCode V2 界面仍面向 coding，只是外壳去 IDE 化（相关度 5，定位）

两边的证据如下：
- 偏 coding：项目就是代码目录，新会话有 git 分支和 worktree 选择器；Review 依赖 git 或快照，非 git 目录引导建仓；状态弹层有 LSP；「在 VSCode/Cursor/Zed/Xcode 中打开」；内置智能体是 build/plan/general/explore；探索分组只认 read/glob/grep/list；终端是 ghostty PTY。
- 偏通用：默认隐藏专业件；首启自动建 Default Project；提问 dock；provider 提示「Connect to 75+ providers」。

证据：opencode/packages/app/src/pages/new-session/new-session-view.tsx:52-62 PromptGitStatus/PromptWorkspaceSelector；opencode/packages/app/src/i18n/en.ts:682-686 noVcs/createGit；opencode/packages/app/src/components/status-popover-body.tsx:321-324 LSP tab；opencode/packages/app/src/components/session/open-in-app.tsx:31-85；opencode/packages/opencode/src/agent/agent.ts:142-197 build/plan/general/explore；opencode/packages/app/src/i18n/en.ts:666 home.providerTip

对 DeskMinis：DeskMinis 要取 OpenCode 的「减法」和「交互机制」：dock、状态三态、分组折叠、渐进披露、投影消息。不取它的对象模型（项目等于仓库、改动等于 git、终端一等公民）。视觉与信息架构以 AionUi 为准，Agent 运行韧性以 ZCode 为准，这样不会变成「四不像」。

### 会话列表搬进 Home 页：左栏项目（按服务器分组、最近关闭），右栏会话（今天/昨天/更早、搜索、归档）（相关度 4，会话列表）

NewHome 是一个两栏网格：左 280px 放项目，右 720px 放会话。会话按 updated 时间分成 today/yesterday/older 三组，支持搜索，也能在列表里直接归档。项目按服务器分组、可折叠，另有「最近关闭」区。会话以标签打开，标签按窗口持久化，关闭的标签进栈、可以恢复。

证据：opencode/packages/app/src/pages/home.tsx:11-48 两栏网格 lg:grid-cols-[280px_minmax(0,720px)]；opencode/packages/app/src/pages/home/home-sessions-controller.tsx:278-299 groupSessions today/yesterday/older；opencode/packages/app/src/pages/home/home-sessions-controller.tsx:207-220 列表内归档（time.archived）；opencode/packages/app/src/pages/home/home-projects-controller.tsx:26-31,64-72 服务器折叠、recentlyClosed；opencode/packages/app/src/context/tabs.tsx:17-31 SessionTab/DraftTab；:59-67 Persist.window('tabs')；closed 栈 tabs.closed

对 DeskMinis：按自然日分组与 AionUi 同构，DeskMinis 的 lib/nav/group 已经实现，不用改。可以借的有两点：其一是「归档优先」加「最近关闭可恢复」，与 AionUi v2.1.60 的归档优先互相印证；其二是会话搜索。冲突点是 OpenCode 把「项目（代码目录）」当一级容器，DeskMinis 以会话/助手为一级，工作区只是会话属性（deskminis/src/renderer/src/stores/chat.ts:126-128 workspaceRoot/workspaceIsDefault），这层对象模型不要改。

### 工具调用展示：PART_MAPPING + ToolRegistry 两级注册表，未知工具兜底（相关度 4，工具调用展示）

消息 part 按类型映射到组件，工具按名字注册渲染器；getToolInfo 给出 icon/title/subtitle。已注册的工具有 read、list、glob、grep、webfetch、websearch、task、shell、edit、write、patch、todowrite、question、skill，未知工具走通用渲染。task（子代理）行链接到子会话。message-part.tsx 仍是 2642 行的单文件。

证据：opencode/packages/session-ui/src/components/message-part.tsx:469-561 getToolInfo switch；opencode/packages/session-ui/src/components/message-part.tsx:932-934 registerPartComponent；opencode/packages/session-ui/src/components/message-part.tsx:1534-1560 ToolPartDisplay（todowrite 返回 null）；opencode/packages/session-ui/src/components/message-part.tsx:1776-2642 各 ToolRegistry.register；opencode/packages/session-ui/src/components/message-part.tsx:1978-2000 task → childSessionId 链接

对 DeskMinis：注册表加良好兜底这个模式延续为基准：MCP 或桥工具不认识时要能渲染，不能崩。但注册的工具集合要换成 DeskMinis 自己的（Office、PowerShell、浏览器、windows-notify 等桥工具），不要搬 glob/grep/patch 这类 coding 渲染器，也不要把所有渲染器塞进一个 2600 行的文件。

### diff/改动：右栏 Review V2（改动文件列表 + 差异预览 + 行内评论回填输入框），依赖 git 或快照（相关度 4，diff/改动）

ReviewPanelV2 包含文件列表侧栏（按 add/del/mix 着色的树）、差异预览、统一/分栏切换，以及行内评论。评论会作为上下文附进输入框。数据来自 VcsFileDiff 或 SnapshotFileDiff。非 git 目录显示「Create a Git repository」按钮；快照关闭时提示改动不可用。每轮末尾有 DiffSummary 行。V2 的 assistant 消息本身带 snapshot{start,end,files}。

证据：opencode/packages/app/src/pages/session/v2/review-panel-v2.tsx:1-60；opencode/packages/app/src/pages/session/v2/review-diff-kinds.ts:40-60 add/del/mix；opencode/packages/session-ui/src/v2/components/session-review-empty-no-git-v2.tsx:10-25；opencode/packages/app/src/i18n/en.ts:682-690 noVcs/createGit/noSnapshot；opencode/packages/app/src/pages/session/timeline/timeline-row.ts:31-34 DiffSummary；opencode/packages/schema/src/session-message.ts:165-190 Assistant.snapshot

对 DeskMinis：部分冲突。对 cowork 用户引导「建 Git 仓库」是错误引导。DeskMinis 的 WorkspacePanel「改动」tab 走 collectArtifacts，不依赖 git（deskminis/src/renderer/src/ui/WorkspacePanel.vue:2-4,86），方向正确，保持。
- 可借：每轮末尾一行「本轮改动 N 个文件 +a/−d」摘要，以及按回合快照支撑撤销。
- 裁掉：行内评论回填输入框。它是代码评审交互，DeskMinis 的批注层（AnnoLayer）另有定位，不需要。

### 终端与 IDE 件退居二线：V2 会话头只剩「状态 + 右栏开关」（相关度 4，终端/界面精简）

旧会话头（fallback 分支）有「在 VSCode/Cursor/Zed/Xcode/终端中打开」菜单、终端开关、文件树开关。V2 头部组件只剩 StatusPopoverV2 和右栏开关，而且状态默认隐藏。终端（ghostty-web PTY）从底部通栏移进右栏，与 Review 上下堆叠，默认关闭，入口是 ctrl+` 或 /terminal 命令。showTerminal 设置项定义了但没有任何消费者。另外 header 里 when={isV2} 传的是访问器本身而非调用结果，分支恒真，旧 fallback 实际已死。

证据：opencode/packages/app/src/components/session/session-header.tsx:325-505 旧分支（open-in-app、terminal、fileTree 开关）；opencode/packages/app/src/components/session/session-header.tsx:529-567 SessionHeaderV2Actions 仅 status + review；opencode/packages/app/src/components/session/session-header.tsx:164,326 isV2 为访问器、when={isV2} 未调用；opencode/packages/app/src/components/session/open-in-app.tsx:31-85 IDE 列表；opencode/packages/app/src/pages/session.tsx:2346-2388 TerminalPanelV2 在右栏堆叠；:2387-2389 旧 TerminalPanel；opencode/packages/app/src/pages/session/use-session-commands.tsx:548-551 terminal.toggle ctrl+` /terminal；opencode/packages/app/src/context/settings.tsx:31,192,395 showTerminal 仅定义

对 DeskMinis：这是「裁掉 OpenCode 相关界面」最直接的依据：连 OpenCode 自己都把终端、文件树、IDE 跳转从主界面撤下了。DeskMinis 的 TopBar 常驻终端按钮（deskminis/src/renderer/src/ui/TopBar.vue:42-43）加 TerminalPane 抽屉（xterm）建议降级：移出 TopBar，改由命令面板或设置-高级开关打开。「PowerShell 实况」对 cowork 用户不是一线需求。xterm 依赖留或去，视 shell 能力对齐设计（2026-08-21-shell-capability-parity）的结论而定。

### 新建会话 = 草稿标签；首启自动在「文档/Default Project」建目录并开草稿（相关度 4，会话创建/上手）

草稿标签（DraftTab）持久化未发送的输入框内容。新会话页的输入框居中，下方是项目选择器、git 分支状态、工作区选择器，另有 provider 提示。桌面首启时如果是全新安装、本地服务、无标签，就在系统「文档」下建 Default Project 并直接打开草稿，用户不必先选仓库。

证据：opencode/packages/app/src/context/tabs.tsx:24-30 DraftTab；:43 draftHref；opencode/packages/app/src/app.tsx:185-230 DraftRoute/ResolvedDraftRoute；opencode/packages/app/src/pages/new-session/new-session-view.tsx:44-62 输入框 + 项目/分支/工作区选择；opencode/packages/desktop/src/main/onboarding.ts:10,36-46 Default Project 于 documents；opencode/packages/desktop/src/renderer/onboarding.tsx:28-47 首启触发条件与开草稿

对 DeskMinis：「不必先选目录」与 cowork 契合。DeskMinis 已有默认沙箱工作区（workspaceIsDefault），可以借两点：草稿会话持久化，也就是未发送先存、切走不丢；以及把工作区选择放在输入框下方而不是弹窗。git 分支和 worktree 选择器不借。

### V2 消息模型：切换助手/模型、压缩、shell 都是流内一等消息（相关度 4，消息模型/消息流）

Session.Message 是一个联合类型，成员有 agent-switched、model-switched、user、synthetic、system、shell、assistant 和 compaction。assistant 的 content 是 text|reasoning|tool 数组，另带 snapshot、tokens、cost、error。compaction 带 reason（auto/manual）、summary 和 recent。时间线里对应 TurnDivider(compaction/interrupted) 分隔行。

证据：opencode/packages/schema/src/session-message.ts:196-213 Message 联合；opencode/packages/schema/src/session-message.ts:165-190 Assistant（content/snapshot/tokens/cost）；opencode/packages/app/src/pages/session/timeline/timeline-row.ts:18-21 TurnDivider label

对 DeskMinis：对 cowork 同样成立，可作基准。DeskMinis 的 TaskPanel.vue:2-7 把降级、压缩、卸载、待批准放在侧栏，平时没人看。建议在流内同步插一行轻量分隔，例如「已切换到备选模型」「上下文已压缩」，TaskPanel 继续负责细节。

### 输入框 V2：交互抽成纯状态机（! 进 shell 模式、@ 上下文、/ 命令、命令菜单）（相关度 3，输入框）

transitionPromptInputV2(state, event) 返回 {state, commands}，不带副作用，附有 machine.test.ts。建议项分 agent、command、file、reference、resource 五类。附件、评论上下文也挂在输入框上。

证据：opencode/packages/session-ui/src/v2/components/prompt-input/machine.ts:59-81 事件分发；opencode/packages/session-ui/src/v2/components/prompt-input/machine.ts:84-118 '!'→shell、'@'→context、'/'→command；opencode/packages/session-ui/src/v2/components/prompt-input/types.ts:1-120 Prompt/Suggestion 类型；opencode/packages/session-ui/src/v2/components/prompt-input/machine.test.ts

对 DeskMinis：借做法，不借功能。DeskMinis 的 Composer.vue（478 行）把 / 与 @ 的逻辑写在 SFC 里（:56-77），可以抽成 lib/composer/machine.ts 纯函数，再配 vitest，零依赖，也便于修重入类竞态。'!' shell 模式是程序员习惯，不借。

### 设置：模态对话框，左导航分 Desktop（通用/快捷键）与 Server（服务器/Provider/模型）；MCP/LSP/插件放在状态弹层（相关度 3，设置）

settings-v2 的「通用」页分区为：界面、通用、外观、通知（完成/权限/错误三开关）、声音、更新、显示、高级。MCP、LSP、插件、服务器的运行状态不在设置里，而在状态弹层；状态弹层入口默认隐藏（showStatus=false）。

证据：opencode/packages/app/src/components/settings-v2/dialog-settings-v2.tsx:53-102 分区与 tab；opencode/packages/app/src/components/settings-v2/general.tsx:546-567 分区顺序；opencode/packages/app/src/components/settings-v2/general.tsx:445-487 通知三开关；opencode/packages/app/src/components/status-popover-body.tsx:312-329 servers/mcp/lsp/plugins

对 DeskMinis：不作基准。DeskMinis 的 StageSettings 是整页分区（SecModels/SecMcp/SecSkills/SecPermission…），更接近 AionUi，对非程序员更可发现；把 MCP 藏进默认隐藏的弹层，对通用用户等于功能消失。可借的只有通知三开关的划分（完成/等待确认/错误），它与 AionUi 的「等待你确认」系统通知是同一件事。

### sdk-next / client：进程内宿主与生成客户端，仓内无 UI 消费者（相关度 3，客户端/SDK）

sdk-next 在内存里执行 Server 的路由，不开端口，提供 sessions.events({sessionID, after}) 的持久事件回放加尾随，以及 tools.register。README 自称是过渡包，将取代旧的生成 sdk。client 是从 HttpApi 生成的 Promise 客户端和 Effect 客户端，PTY 等自定义传输不在其中。仓内只有 sdk-next 自己的 package.json 引用它；app 和 session-ui 用的是 vendored client 加旧的 @opencode-ai/sdk/v2 类型。

证据：opencode/packages/sdk-next/README.md（In-process host，不开 listener；sessions.events after）；opencode/packages/sdk-next/src/opencode.ts:10-49 create/tools.register/layer；opencode/packages/client/README.md（Promise/Effect 两入口；PTY 在外）；opencode/packages/app/package.json:57-61 依赖 vendored client + @opencode-ai/sdk

对 DeskMinis：它印证了 DeskMinis「minisd 独立进程、渲染端纯客户端」的架构，进程内宿主也对应 DeskMinis CLI 复用 minisd 的场景。它不是界面设计基准，本轮不用跟。

### 通知：权限/提问的原生通知只接在旧壳 layout.tsx 里（待核实的回归）（相关度 3，权限/提问/通知）

新布局下，notification.tsx 只处理 session.idle 和 session.error（完成、错误）。permission.asked 和 question.asked 的 toast 加原生 notify 在 pages/layout.tsx:405-455，也就是旧壳。新布局外壳 layout-new.tsx 里没有等价实现，但设置 V2 仍保留「权限通知」开关。静态阅读判断，新路由下这条通知很可能已失效；未实机验证。

证据：opencode/packages/app/src/context/notification.tsx:346-405 仅 idle/error；opencode/packages/app/src/pages/layout.tsx:405-455 permission/question → platform.notify；opencode/packages/app/src/pages/layout-new.tsx:1-49 无对应接线；opencode/packages/app/src/components/settings-v2/general.tsx:463-468 权限通知开关仍在

对 DeskMinis：这是反面教材：换壳时，挂在旧外壳组件里的副作用接线会被遗漏。DeskMinis T 波已踩过同类坑（PermCard.vue:4-5 注释「T 波换壳时漏掉的最严重一块」）。做「等待你」系统通知时，事件到通知的接线放在 store/lib 层（和等待集合 reducer 同处），不要放在 AppShell 或 NavRail 这类外壳组件里。

### 多窗口与 Storybook（相关度 2，多窗口/组件开发）

两块内容：
- 多窗口：桌面端用窗口 UUID 注册表恢复窗口，标签按窗口持久化；关闭最后一个窗口视为退出，保留 id 以便下次恢复。
- Storybook：stories 与组件同目录，数量从旧研究的约 35 个增至 90 个；timeline-playground.stories.tsx 有 2090 行，app 另有 timeline 稳定性 e2e。

证据：opencode/packages/desktop/src/main/window-registry.ts:1-50；opencode/packages/app/src/context/tabs.tsx:59-67 Persist.window；opencode/packages/storybook/.storybook/main.ts:13-30 stories 路径；opencode/packages/session-ui/src/components/timeline-playground.stories.tsx（2090 行）；opencode/packages/app/package.json:28 test:stability

对 DeskMinis：多窗口发版前不做，沿用旧研究「窗口稳定 ID」的结论即可。Storybook 是新 npm 依赖，违反零新依赖约束，不引入。替代做法是一个只在 dev 构建里出现的 fixture 路由页，用假数据渲染 StepGroup、PermCard、计划条等组件。

## 相对上次研究的变化

- 旧研究（1.18.5）记载 newLayoutDesigns 开关下新旧两套并存，未确定默认值。现状（1.18.32）是默认 true，日落日 2026-09-14 已过，旧界面强制下线：settings.tsx:60-63,128-131,340-344；en.ts:958-959「The previous layout is no longer available」
- 删：左侧项目/工作区/会话侧栏（pages/layout.tsx，2444 行）被 Home 页加标题栏标签页取代；目录作用域路由 /:dir/session/:id 改为服务器作用域 /server/:serverKey/session/:id，只保留重定向（app.tsx:615-645）。旧代码仍留在树中，属于「体验删了、代码没删」
- 删（默认界面层面）：V2 会话头只剩状态和右栏开关，「在 IDE 中打开」、终端开关、文件树开关撤下（session-header.tsx:325-505 对比 :529-567）。文件树、搜索、状态、终端、推理摘要、工具展开、自定义智能体默认全部隐藏（settings.tsx:183-197,279）
- 改：终端从底部通栏移进右栏，与 Review 上下堆叠（session.tsx:2346-2388）。评论条行在 v2 改为用户消息内联（rows.ts:108-110,146-152）。Review 升级为带文件列表侧栏和无 git 空态的 V2（review-panel-v2.tsx；session-review-empty-no-git-v2.tsx）
- 新：草稿标签 /new-session?draftId（tabs.tsx:24-30,43；app.tsx:185-230）；桌面首启自动建「文档/Default Project」并开草稿（desktop/src/main/onboarding.ts:10,36-46）；标签头像三态（project-avatar-state.ts:36-45）；输入框 V2 纯状态机（prompt-input/machine.ts）；设置 V2 模态对话框（settings-v2/*）；会话缓存上限 40（session-cache.ts:5）
- 新：app 消费 V2 投影消息（server-session-v2-reducer.ts），但前端又归一回 V1 的 Message/Part（utils/session-message.ts:48-120）。app 用的事件名 session.input.admitted、session.execution.* 在仓内 schema 中不存在，仓内是 session.next.*（schema/src/session-event.ts:95），客户端来自 vendored 1.17.13-v2 tarball（app/package.json:57）
- 新：出现 packages/sdk-next（进程内宿主、sessions.events after 回放）和 packages/client（生成客户端），但仓内没有 UI 消费 sdk-next
- 未变：权限 dock 仍只显示 patterns，不展示「始终允许」的保存范围（session-permission-dock.tsx:36-70）。客户端自动批准仍在（context/permission.tsx:334-338）
- 未变：双 token 体系行数与旧研究一致（ui/src/styles/theme.css 631 行、v2/styles/theme.css 503 行、v2/styles/colors.css 172 行），仍是 37 个主题 JSON。message-part.tsx 2642 行（旧 2662），message-timeline.tsx 1847 行（旧 1865）
- 未变：全局 SSE、16ms 合批、250ms 重连（server-sdk.tsx:218-220）。app 仍没有使用按会话 after=seq 的续传
- 规模：*.stories.tsx 从约 35 个增至 90 个；desktop 包 TS 由约 4.5k 行增至约 8.5k 行，新增 onboarding、window-registry、draft-store、updater-controller、background-cli 等

## 反面做法

- 新旧两套界面长期靠布尔开关在 40 多处组件里分叉，日落日期硬编码在代码里（settings.tsx:62）；旧界面下线后旧代码仍留在树中：pages/layout.tsx 2444 行、components/prompt-input.tsx 1793 行、pages/home/legacy-home.tsx。DeskMinis 裁界面时应直接删文件，不要留开关
- 前端双数据模型：拿到 V2 投影消息后再归一回 V1 的 Message/Part（utils/session-message.ts:48-120），再叠加 v1/v2 探测与兼容 API（server-protocol.ts、server-compat.ts 518 行、server-session.ts 1427 行）
- 桌面 UI 依赖仓外 vendored 客户端 tarball，事件名与仓内 schema 漂移（session.input.admitted 对 session.next.prompt.admitted），协议真相不在同一个仓里
- 换壳遗漏副作用接线：权限/提问的原生通知只挂在旧壳 pages/layout.tsx:405-455，新布局未见对等实现（待实机核实）
- 用访问器当布尔值：session-header.tsx:326 写成 when={isV2}，没有调用，分支恒真，旧 fallback 静默变成死代码
- 定义了却没有消费者的设置项：showTerminal（settings.tsx:31,192,395）成了死开关
- 权限「始终允许」不展示将保存的范围（session-permission-dock.tsx:36-70 只列 patterns），客户端还会自动代答（context/permission.tsx:334-338），等于策略放在可替换的客户端里
- 对非程序员做错误引导：非 git 目录的改动面板只给「创建 Git 仓库」一条路（i18n/en.ts:683-686）
- 功能藏进默认隐藏的弹层：MCP、LSP、插件状态只在状态弹层，而 showStatus 默认 false（status-popover-body.tsx:317-329；settings.tsx:191）。对通用用户等于功能消失
- 超大单文件集中在核心路径：message-part.tsx 2642 行、pages/layout.tsx 2444 行、pages/session.tsx 2391 行、message-timeline.tsx 1847 行；双 token 体系继续并存
- 对 DeskMinis 而言的反面做法：照搬 OpenCode 砍掉左侧会话栏改用标签页（与 AionUi 形态冲突）；照搬「项目等于代码目录」的一级对象模型；引入 Storybook 或 ghostty-web（违反零新依赖）；把 IDE 跳转、终端当一等入口常驻顶栏
- 对 DeskMinis 现状的提醒：AppShell.vue:6 注释称右栏默认收起，:28 却是 wsOpen=ref(true)。注释与实现相反时，应按「渐进披露」基准改实现，不改注释