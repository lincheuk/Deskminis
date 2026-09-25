# OpenCode V2 / ZCode / AionUi / pi 四家参考对比与优化基准（2026-09-25）

> 用户要求：以 ZCode、OpenCode V2、AionUi 为底层功能设计基准（原话见 `2026-09-25-opencode-v2-baseline.md` 开头）；
> 并问：「OpenCode、ZCode、AionUi 还有 pi 的参考对比优化现在有了吗」。
> 状态：**调研与建议，等用户拍板**。不改代码，不改路线文件，不改 THIRD-PARTY-NOTICES。
> 对象：四家当前克隆的源码（提交见 §5）；DeskMinis 以 main `3a811a1` 为准（写作时仍有别的会话在合流，行号以此提交为准）。
> 附录目录 `docs/research/2026-09-25-four-way/`：`pi-notes.md` pi 逐子系统核验笔记；`spot-checks.md` 旧报告关键行的抽查记录。

## §0 结论

**有，但分在两份报告里，而且都没把 pi 放进基准分工。这份把两份合成一张总表，补上 pi。**

- **9/24 重读报告**（五家重读、117 项能力矩阵、W1–W9 路线）读过 pi 的稳定面，每波的借鉴栏点了 pi 二十多处机制。但它按「能力」横着铺，没有按子系统定主次基准。
- **9/25 OpenCode V2 报告**给了 13 个子系统的主次基准，只在 OpenCode V2、ZCode、AionUi 三家之间分。正文没有 pi，附录 `baseline-and-cuts.md` 只顺带提到两次（:38、:140）。
- **缺的**：四家并排的逐行对比；pi 在分工里的位置；落到 DeskMinis 现状、已借登记和波次的一张总表；已经落进代码的借用一览。
- **这份补了**：
  - §1 总表 21 行：原 13 行照旧，加 pi 真有基准价值的 7 行，再加 1 行宿主生命周期，用来收纳已落地的借用；
  - §2 已落地借用清单；
  - §3 pi 的位置与冲突取舍；
  - §4 对路线的建议。

**pi 的位置（一句话）**：pi 做引擎里「小机制」的基准——报错分类与溢出、模型能力数据、摘要算法、上下文水位、文件编辑与读取、shell 与进程回收 6 行当主基准，provider 请求整形与会话分叉 2 行当次基准；界面、权限、cowork、会话持久化与协议不作基准，实验面（chord、durable、protocol v8）继续不跟。

**已经落进代码的借用**：
- **8 条已在 main**：
  - pi 代码改编 3 条：file_edit 文本处理、上下文超窗正则、Windows 进程树回收；
  - ZCode 代码改编 1 条：数据根锁；
  - AionUi 3 条：界面令牌取值，加单实例、开发态隔离两条仅借思路；
  - deepseek-harness 仅借思路 1 条：删除前先停会话。
- **3 条施工中、未合入**：W2b-6 导航守卫（deepseek-harness 思路）、W2b-7 崩溃记录（改编 pi crash-log）、W2b-11a 中断的工具不再显示成功（OpenCode failInterruptedTools 思路）。
- **计划中的借鉴**：按总表行数算，大头在 W5（9 行）、W7（8 行）、W6（7 行），其次是 W8（5 行）与 W4c（4 行）。

**要拍板的新事只有 1 条**：W7c 是否加「工具输出进度流」（默认加，见 §4）。
另有 1 条沿用旧题：是否采纳这张 21 行分工表，同 9/25 §4 第 4 条，范围从 13 行扩到 21 行，其中第 7 行的次基准由 OpenCode llm 包改为 pi。

## §1 总表

读法：
- 两张表行号一一对应。§1a 写四家各自怎么做，§1b 写主次基准、DeskMinis 现状、已借和排期。
- 每格一句话，附一个证据。没有这块写「无」。AionUi 的引擎 aioncore 不在它的仓库里，引擎侧能力一律记「无」并注明。
- 路径简写：
  - OpenCode（sst/opencode `6df0d5d`）：省略开头的 `packages/`；
  - ZCode（zai-org/ZCode `29628c9`）：`apps/zcode-cli/packages/` 记作 `cli/`，其余从仓库根写起；
  - AionUi（iOfficeAI/AionUi `6744099`）：`packages/desktop/src/` 记作 `desktop/`，其余从仓库根写起；
  - pi（badlogic/pi-mono `8676a0d`）：省略开头的 `packages/`；
  - DeskMinis：省略 `deskminis/src/`，`renderer/` 指 `renderer/src/`。
- 第 1–13 行是 9/25 §3 原表。第 6 行改名，只管触发与熔断，摘要算法拆到第 16 行。第 14–20 行因 pi 新增。第 21 行不是因为 pi 加的，理由见表后说明。

### §1a 四家怎么做

| # | 子系统 | OpenCode V2 | ZCode | AionUi | pi |
|---|---|---|---|---|---|
| 1 | 会话模型与事件持久化 | 单写者事件表：追加事件与投影读模型在同一事务里完成，重放时 seq 必须接续（`core/src/event.ts:205-299`） | V4 会话快照带 logEpoch、seq 与 revision，渲染端刷新后能从快照整份恢复（`packages/shared/src/zcode-protocol-v4/snapshot.ts:470-476`） | 会话与消息存在引擎里，界面按 HTTP 分页读取（`desktop/common/adapter/ipcBridge.ts:1370-1386`） | 会话是 JSONL 追加树（id/parentId 加 leaf 指针），旧版本在加载时就地迁移并整文件重写，没有 seq 也没有事务（`coding-agent/src/core/session-manager.ts:975-986,1085-1094`） |
| 2 | 引擎与渲染端协议 | 持久事件按 seq 续传，只在线的增量不进游标，history 有限分页（`protocol/src/groups/session.ts:307-342`） | 快照加 7 种封闭增量；连接断开时本地拒绝全部挂起调用、不重发（`packages/rpc/src/channelClient.ts:66-85`） | 命令走 HTTP，实时事件走 WebSocket；断线后按 1 秒到 30 秒退避重连，连上后发 realtime.reconnected，让各处重新对账（`desktop/common/adapter/httpBridge.ts:417-458,488-496`） | 稳定面是单客户端 stdio JSONL，严格按 LF 分帧，补漏靠 get_entries since，子进程退出时客户端拒绝全部挂起请求（`coding-agent/src/modes/rpc/rpc-client.ts:107-124`） |
| 3 | 运行器循环 | 两层循环，外层按 steer/queue 调度；下一次 run 开始时把悬空工具判为「执行被中断」，不重放（`core/src/session/runner/llm.ts:119-139,397`） | 每个 model-step 边界最多消费一条 guide，以 user 角色续上，不按工具调用次数硬停（`cli/core/src/runtime/methods/turn-guide-drain.ts:8-30`） | 循环在引擎里；界面按运行态的 supports_midturn_delivery 位决定运行中能否直接投递（`desktop/renderer/pages/conversation/runtime/conversationRuntimeViewStore.ts:154-166`） | 工具批次之后取 steer，将要停下时取 followUp；length 截断的回合里工具调用一律不执行；没有回合上限（`agent/src/agent-loop.ts:174-306`） |
| 4 | 工具协议与副作用元数据 | 名字在注册时给定，入参解码失败不调 execute，注册身份对不上就报「Stale tool call」（`core/src/tool/registry.ts:42-125`） | 工具声明 readOnly、concurrentSafe、sideEffectScope，调度器把不安全的调用当屏障、按原顺序执行（`cli/core/src/tool/scheduler.ts:23-66`） | 无（工具在引擎里执行） | 结果分 content（给模型）与 details（只落库、给界面）；任一工具声明 sequential 整批就串行；另有参数垫片 prepareArguments（`agent/src/types.ts:420-468`） |
| 5 | 权限与交互通道 | PermissionV2 配置里的 deny 先判；拒绝一张就级联了结同会话其余待批，「总是允许」后重评其余（`core/src/permission.ts:137-162,231-283`） | 权限卡、提问、计划审阅共用一个 InteractionRegistry，无人值守时自动应答（`cli/bootstrap/src/zcode-protocol-v4/interaction-registry.ts:30-31`） | 确认按 call_id 提交给引擎，能列出待确认项，判定在引擎里（`desktop/common/adapter/ipcBridge.ts:512-523`） | 无内置审批：只在装了扩展时经 tool_call 事件拦截，扩展抛错按拦截处理（`coding-agent/src/core/agent-session.ts:530-550`） |
| 6 | 上下文压缩：触发、熔断与边界 | 按 system、消息、工具整份估算，超过「窗口减输出或缓冲」才压，只留一个隐藏检查点（`core/src/session/compaction.ts:232-243`） | 自动压缩带 rapid-refill 与连续失败熔断，另有 microcompact 清旧工具结果（`cli/core/src/compact/policy.ts:62,142`） | 无（引擎里） | 超过「窗口减 16384」就压，失败发 session_compact_failed，但没有连续失败熔断，下一回合超阈值还会再试（`coding-agent/src/core/agent-session.ts:2873-2897`） |
| 7 | provider 请求整形与模型规则 | reasoning 与 provider 元数据只在同一模型续写时回放；V2 runner 只接 3 条路由、不降级（`core/src/session/runner/to-llm-message.ts:68-80`） | 按模型名、API 类型、站点地址的正则级联出声明式规则数据（`packages/provider/src/config/rule-data-schema.ts:26-60`） | 无（请求整形在引擎里） | OpenAI 兼容端点用二十多个 compat 开关描述差异（思考参数格式、reasoning_content 回放、max_tokens 字段名），按 provider 或 baseUrl 自动识别（`ai/src/api/openai-completions.ts:1586-1690`） |
| 8 | 配置与指令文件 | 首回合冻结系统上下文基线，之后有变化才追加一条上下文更新；AGENTS.md 向上找，但不越出项目根（`core/src/session/context-epoch.ts:40-78`） | 上下文分节，并标注注入位置（meta_user）与缓存提示（dynamic）（`cli/core/src/context/sections/request-user-context.ts:15-35`） | 无（引擎里） | 全局一份，再从 cwd 一路到文件系统根逐级加载 AGENTS.md/CLAUDE.md，不经项目信任，这是反面（`coding-agent/src/core/resource-loader.ts:174-211`） |
| 9 | todo / 计划 | todo 整表替换存表，但更新事件不是持久事件，协议里也没有读取路由（`core/src/session/todo.ts:32-57`） | todo 整表替换，同时最多一个进行中（`cli/core/src/tool/handlers/todo.ts:135-139`） | 计划条钉在输入框上方，运行中按会话补拉最新计划（`desktop/renderer/pages/conversation/PlanBar/usePlanRecovery.ts:23-30`） | 无内置；示例扩展把清单存进工具结果 details，从当前分支折叠还原（`coding-agent/examples/extensions/todo.ts:106-133`） |
| 10 | 多会话与运行态可见性 | app 把权限与提问请求算作「需要注意」，优先级高于未读（`app/src/pages/layout/project-avatar-state.ts:36-45`） | 侧栏任务行带运行阶段、待处理交互与后台作业，只信会话索引的实时状态（`packages/ui/src/v4/taskListRowActivity.ts:12-19`） | 等待集合用纯 reducer 记 mark、unmark、clear，侧栏按「等待 > 运行 > 未读」显示（`desktop/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync.ts:182-207`） | 无：终端一次只驱动一个会话，换会话是整体替换（`coding-agent/src/modes/rpc/rpc-types.ts:61`） |
| 11 | 界面状态投影 | 服务端投影出类型化的消息联合，前端时间线按行模型渲染（`schema/src/session-message.ts:165-213`） | 渲染端用纯函数把增量折叠进会话快照（`packages/shared/src/zcode-protocol-v4/apply.ts:68-153`） | 运行态视图用纯函数投影，带「是否支持运行中投递」位（`desktop/renderer/pages/conversation/runtime/conversationRuntimeViewStore.ts:150-166`） | 稳定面是 TUI 直接订阅会话事件；实验面 micro 用只读 View 加窄 Controller 隔开（`coding-agent/src/experimental/micro/api.ts:58-88`） |
| 12 | cowork 能力（助手、定时） | 无 | 无人值守时自动应答提问，并记成持久事件（`cli/core/src/runtime/methods/interaction-auto-resolution.ts:11-29`） | 定时任务有 at、every、cron 三种排期，可绑定助手与模型，也能由 agent 自己创建（`desktop/common/adapter/ipcBridge.ts:1673-1760`） | 无 |
| 13 | 改动追踪与回退 | 回合前后打快照，回退分 stage、clear、commit 三段，stage 之后可撤回；快照依赖 git（`core/src/session/revert.ts:59-121`） | 写前检查点，回退前预览哪些文件能安全回退、哪些不能（`cli/core/src/runtime/methods/file-rewind.ts:30-117`） | 「改动」tab 是按 git 的源代码管理面板，没有写前检查点与回退（`desktop/renderer/pages/conversation/explorer/ExplorerContainer.tsx:251-255`） | 无内置；示例扩展每回合 git stash 一次，分叉时可还原代码，依赖 git（`coding-agent/examples/extensions/git-checkpoint.ts:1-30`） |
| 14 | provider 报错分类与上下文溢出恢复 | 27 条溢出正则加 3 条排除，任何无 body 的 400/413 也算溢出；只在还没开始输出时补救一次（`llm/src/provider-error.ts:4-38`） | 按错误码标记（context_length_exceeded 等）沿 cause 链判溢出，之后走被动压缩（`cli/core/src/runtime/helpers/model-errors.ts:202-262`） | 无（引擎里） | 24 条溢出正则加 3 条排除，另认「成功但 usage 超窗」与「length 且零输出占满 99%」；溢出不进重试，压缩后同模型只重试一次（`ai/src/utils/overflow.ts:136-170`） |
| 15 | 模型目录与能力数据 | models.dev 形态：能力、按档位给请求打补丁的 variants、分层单价、context/input/output 上限（`schema/src/model.ts:59-87`） | 思考档与输出上限作为 optionSpecs 写进规则数据，按规则级联覆盖（`packages/provider/src/config/model-config.ts:246-280`） | 模型、模式、思考档由引擎按 ACP 配置项报上来，界面只渲染报上来的选项（`desktop/renderer/hooks/agent/useAcpConfigOptions.ts:436-438`） | thinkingLevelMap 用 null 标出不支持的档，只列支持的档、越界就近夹取；另有 inputLimits、缓存 TTL、分层单价（`ai/src/models.ts:1209-1240`） |
| 16 | 压缩摘要的生成算法 | 固定 Markdown 结构模板，有旧摘要时按 prior-summary 合并，保留尾部约 8000 token；不检查截断（`core/src/session/compaction.ts:12-55`） | 活动历史整段（含上次摘要）按九节模板，先写 analysis 段再写 summary 段，重摘一遍（`cli/core/src/compact/prompt.ts:6-60`） | 无（引擎里） | 旧摘要放进 previous-summary 标签增量合并，按 20000 token 从尾部选切点、不切在工具结果上，length 截断的摘要拒收（`coding-agent/src/core/compaction/compaction.ts:468-500,599-617`） |
| 17 | 上下文水位与用量口径 | 按整份请求的字符估算判断要不要压，不用 provider 报的 usage（`core/src/session/compaction.ts:83,232-243`） | 以最近一条已提交 assistant 的 provider usage 为底，只估算其后的增量（`cli/core/src/runtime/methods/compact.ts:313-340`） | 输入区占用环只用引擎报的窗口大小，报不出就只给原始 token 数，不拿猜的分母算百分比（`desktop/renderer/components/agent/ContextUsageIndicator.tsx:14-22`） | 以最近一条有效 usage（含缓存读写）为锚估算尾部；压缩后到下一次回复前返回 null，界面显示「?」（`coding-agent/src/core/agent-session.ts:3858-3890`） |
| 18 | 会话分叉与对话回退 | V2 内核没有分叉，对话回退并在第 13 行的三段式里；发行版 V1 有 session.fork，复制到某条消息之前（`opencode/src/session/session.ts:691-730`） | 在某条消息处分叉成新会话，同时撤销分叉点之后的检查点；回退另分对话、工作区、两者三种范围（`cli/core/src/runtime/methods/workspace-fork.ts:83-140`） | 在某条消息（含）处分叉成新会话，能否分叉看会话的 fork_capability，实现在引擎里（`desktop/common/adapter/ipcBridge.ts:328-340`） | 会话本身是树，/tree 可在任意节点续写，并给离开的分支写摘要；/fork 从某条用户消息之前另起文件，并把那条原文回填输入框（`coding-agent/src/core/agent-session-runtime.ts:262-351`） |
| 19 | 文件编辑与读取工具 | CRLF 归一后匹配，写回用 writeIfUnchanged 按读到的字节做条件写；但替换仍用 String.replace，`$&` 等会被解释，这是反面（`core/src/tool/edit.ts:179-194`） | 多级匹配并保留引号风格；没读过不许改，读后 mtime 或大小变了拒写（`cli/core/src/tool/handlers/edit.ts:440-460`） | 无（工具在引擎里） | 剥 BOM、CRLF 归一后精确匹配，切片拼接替换，写回还原行尾与 BOM；模糊匹配第一步做 NFKC，这是反面（`coding-agent/src/core/tools/edit.ts:185-197`） |
| 20 | shell 与子进程管理 | killTree 在 Windows 用裸名 taskkill /f /t，Unix 先杀进程组、200ms 后 SIGKILL（`core/src/shell.ts:31-57`） | Windows 用裸名 taskkill /T /F，关停时等它收尾；输出分内联、尾部、落盘三档预算（`cli/adapters/src/exec/node-execution-adapter-process.ts:146-170`） | 无（命令在引擎里执行） | 用 System32 下 taskkill.exe 的绝对路径回收进程树，分离的子进程登记在册、退出时统一回收（`coding-agent/src/utils/shell.ts:198-232`） |
| 21 | 桌面宿主生命周期与崩溃记录 | desktop 包有单实例与窗口导航守卫，崩溃转储只落本地、不上传（`desktop/src/main/logging.ts:39-41`） | 崩溃预算：5 分钟窗口内按 1/2/4/8/16 秒退避重启，用尽即停（`packages/zcode-server-cli/src/supervisor/crashBudget.ts:3-40`） | 引擎 60 秒内最多重启 3 次；另有单实例、开发态 userData 隔离、启动失败分类、渲染进程崩溃恢复（`packages/web-host/src/backend-launcher.ts:525-526`） | 终端应用，只有崩溃记录：未捕获异常写 crashes.json，最多 5 条、保留 7 天，下次启动提示一次（`coding-agent/src/core/crash-log.ts:17-18,123-150`） |

### §1b 基准分工与落地

「主基准」「次基准」栏里，带「新」的是新增行；带「改」的是相对 9/25 §3 改了的；其余照 9/25 §3。

| # | 子系统 | 主基准 | 次基准 | DeskMinis 现状 | 已借 | 计划在哪一波 |
|---|---|---|---|---|---|---|
| 1 | 会话模型与事件持久化 | OpenCode V2 | ZCode | messages 是可变行，parts 原地更新，没有事件表和 seq（`minisd/store/db.ts:15-22`） | — | W6c 建带 seq 的会话事件表（放哪次迁移同 9/25 §4 第 3 条） |
| 2 | 引擎与渲染端协议 | ZCode | OpenCode V2 | chat.event 发给所有连接、不带 seq；渲染端 rpc.ts 没有 onclose（`minisd/rpc/server.ts:127-130`） | — | W2b-3 断线结算与横幅（止血，排在 W2b-2 之后）；W6b 连接代次与重连；W6c chat.watch、seq、按订阅投递；W6d 会话钉定的 RPC |
| 3 | 运行器循环 | OpenCode V2 | ZCode | 回合上限 200，到顶直接报错；会话运行中再发一律拒收（`minisd/agent/loop.ts:288,687`） | — | W5a 收尾回合（user 角色）；W5b 截断回合的工具调用不执行；W6c 协调器；W7a steer/queue、悬空工具持久化为中断 |
| 4 | 工具协议与副作用元数据 | ZCode | OpenCode V2 | 结果只有 output 与 success，同批工具一律 10 路并发（`minisd/tools/types.ts:10`） | — | W5b 注册表出口统一截断；W7a 副作用调度、stale 守卫、结果三分类 |
| 5 | 权限与交互通道 | ZCode | OpenCode PermissionV2 | 三档判定加 danger 硬拒，待批卡 90 秒自动拒绝；W1b-2 已收窄数据根（`minisd/index.ts:88,337-363`） | — | W2b-2 按会话区分（施工中，链 F1）；W6c InteractionRegistry；W7b 拒绝级联、重评、附言写进结果 |
| 6 | 上下文压缩：触发、熔断与边界 | ZCode | OpenCode V2 | 每次运行最多压 3 次，失败一次本次运行就不再压，失败发 compactFailed（`minisd/agent/loop.ts:331-427`） | — | W5a 用熔断取代次数上限，失败保留上一个 marker |
| 7 | provider 请求整形与模型规则 | ZCode | pi（改，原为 OpenCode llm 包，后者挪到第 14 行） | OpenAI 兼容只有两个开关，DeepSeek V4 按模型名回放推理；Anthropic 只有三个新模型走 drop_block，其余开思考仍发 budget_tokens（`minisd/providers/openai.ts:12-30`） | — | W4c compat 对象与 detectCompat、按代建表的思考参数、请求体黄金快照 |
| 8 | 配置与指令文件 | OpenCode V2 | ZCode | system 每一步重建，记忆、技能、助手规则一变就整段改写；不读 AGENTS.md（`minisd/index.ts:804-815`） | — | W5c 基线冻结加带来源的追加；AGENTS.md 信任卡 |
| 9 | todo / 计划 | AionUi | ZCode | 没有 todo 工具与计划条（源码 grep 零命中） | — | W7c |
| 10 | 多会话与运行态可见性 | AionUi | OpenCode V2 app | W2b-1 起按会话记运行态，左栏还没有「等待你」标（`renderer/stores/chat.ts:117`） | — | W2b-2 左栏盾牌（施工中）；W7b 等待态 reducer 与系统通知 |
| 11 | 界面状态投影 | AionUi | OpenCode V2 | 历史回合里没有结果的工具默认显示成功（`renderer/ui/StageChat.vue:112`） | —（W2b-11a 施工中） | W2b-11a 标「已中断 · 结果未知」（施工中）；W6c 按会话的纯 reducer；W7c 对话流内分隔行 |
| 12 | cowork 能力（助手、定时） | AionUi | ZCode | 助手与定时已有；定时任务里的权限卡要等 90 秒自动拒绝，没有无人值守应答（`minisd/index.ts:1367-1369`） | — | W4a 办公内容包（0.3.1）；W7b 无人值守应答；W8a 助手空态 |
| 13 | 改动追踪与回退 | ZCode | OpenCode V2 | 改动清单只认三种写工具，没有检查点与回退（`renderer/lib/artifacts/collect.ts:40-42`） | — | W8b |
| 14 | provider 报错分类与上下文溢出恢复 | pi（新） | OpenCode V2（llm 包） | 溢出单独分类，只降级到窗口更大的槽位，否则报「上下文已满」并给接力草稿；不读 Retry-After，不认配额耗尽（`minisd/agent/loop.ts:518-526`） | pi overflow.ts（NOTICES §3，W2a-2 `6797eeb`） | W4c 完整错误分类与报文脱敏；W5a 先压缩再同槽重试一次 |
| 15 | 模型目录与能力数据 | pi（新） | ZCode | 只有窗口、输出上限、是否思考三项，数据来自 models.dev（`minisd/providers/model-catalog.ts:6-10`） | — | W4c 档位映射与就近夹取；W9c 思考档位胶囊只列可用档 |
| 16 | 压缩摘要的生成算法 | pi（新） | OpenCode V2 | W2a-1 起「最新摘要加增量」压平成一段、按窗口封顶，空、截断、拒答都拒收；模板仍是 800 字以内的自由格式（`minisd/agent/compact.ts:176-177`） | —（W2a-1 `6cb83b5` 自写） | W5a 结构化模板、按 token 选切点、文件清单累积 |
| 17 | 上下文水位与用量口径 | pi（新） | AionUi | 水位按字符估算，中文按 1.6 字一 token；usage 已按消息落库，但 Anthropic 只取 input_tokens，没有缓存读写（`minisd/providers/anthropic.ts:198`） | — | W4c usage 补缓存读写；W5b usage 锚点与输入区占用环（占用环提前同 9/25 §4 第 5 条）；W8c 用量面板按实际出答模型归属 |
| 18 | 会话分叉与对话回退 | ZCode（新） | pi | 没有分叉、从某条重试、截断后缀这类操作（chat.* 方法里 grep 零命中） | — | W8b 消息级操作；会话分叉在 0.6.0 之后先出设计稿 |
| 19 | 文件编辑与读取工具 | pi（新） | ZCode | file_edit 已是切片拼接、CRLF 偏移映射、保 BOM；file_read 已支持按字符的 offset/limit；没有先读后写（`minisd/tools/files.ts:150,224`） | pi edit（NOTICES §3，W1a-2 `95fef05`） | W5b 卸载桩给头尾；W8b 先读后写与写前检查点 |
| 20 | shell 与子进程管理 | pi（新） | ZCode | 常驻 PowerShell 用 System32 绝对路径启动，超时、取消、释放都回收整棵进程树；输出要到结束才一次性给出（`minisd/tools/shell.ts:75`） | pi killProcessTree（NOTICES §3，W1b-1 `f5a68b0`） | W5b 结果取尾部、完整输出落卸载目录；W6d 子进程环境擦凭据、删终端后端（同 9/25 §4 第 1 条）；W7c 工具输出进度流（§4 待拍板） |
| 21 | 桌面宿主生命周期与崩溃记录 | AionUi（新） | ZCode | 单实例锁、数据根锁、开发态隔离、优雅退出已有；握手后引擎崩溃只记一笔、不重启（`main/index.ts:150-153`） | ZCode 数据根锁（NOTICES §4，W1b-3 `d02d861`）；AionUi 单实例与开发态隔离思路（§5，`d02d861`、`48097bb`）；deepseek-harness 停会话思路（§5，W1b-4 `00e33d1`） | W2b-6 导航守卫、W2b-7 崩溃记录（施工中）；W6a launcher、崩溃预算、启动失败分类 |

**表后说明**：
- **第 7 行改了次基准**。OpenCode llm 包在原表里贡献的是报文两遍脱敏、Retry-After、换模时思考块降为文本。前两样属于报错处理，挪到第 14 行当次基准；第三样 pi 也有（`ai/src/api/transform-messages.ts:92-116`）。请求整形这一块，pi 的 compat 矩阵正是 W4c 要做的东西，所以次基准换成 pi。
- **第 6 行拆成两行**。原表把「压缩」当一行，主基准 ZCode 的长处在触发与熔断；摘要本身怎么写，pi 更完整。拆开后第 6 行只管触发、熔断、边界，第 16 行管摘要算法，两行的主基准不同。
- **第 21 行为什么加**。pi 在这一行只有崩溃记录可借，够不上次基准。加这一行，是因为 9/24 路线里的宿主加固（W1b、W2b、W6a）和已经落地的四条借用在原表里没有位置。
- **考虑过、没加的行**：
  - 扩展与技能加载：pi 的扩展是 TS 代码扩展，DeskMinis 不开放第三方代码；技能多根与项目信任闸在 9/24 矩阵里价值 3，路线没排。
  - 评测体系：开发流程，不是产品子系统。
  - MCP、设备同步、Office、发布工程：pi 没有可借的，9/24 矩阵已覆盖。
  - 界面令牌：不是底层功能，放在 §2。

## §2 已落进代码的借用清单

登记以仓库根 `THIRD-PARTY-NOTICES.md` 为准（行号按 main `3a811a1`）；提交 hash 都已确认在 main 上。
本节路径照 NOTICES 的写法，从各自仓库根写起，不用 §1 的简写。

### §2a 已在 main

| # | 上游（许可） | 借了什么 | 本仓位置 | 上游位置 @ 提交 | 步骤 | 提交 | 登记 |
|---|---|---|---|---|---|---|---|
| 1 | pi-mono（MIT） | file_edit 文本处理：剥 BOM、按首个换行判行尾、CRLF 归一后匹配、拒绝空 old_string | `deskminis/src/minisd/tools/edit-text.ts` | `packages/coding-agent/src/core/tools/edit-diff.ts:11-25,306-314`、`core/tools/edit.ts:190-197`、`utils/text.ts:2-4` @ 8676a0d | W1a-2 | `95fef05`（链 A1 合流 `85a10fc`） | NOTICES §3 第 1 行（:68） |
| 2 | pi-mono（MIT） | 上下文超窗正则 24 条与排除表 3 条，连同逐家报文样例注释 | `deskminis/src/minisd/providers/overflow.ts` | `packages/ai/src/utils/overflow.ts` @ 8676a0d（v0.87.1） | W2a-2 | `6797eeb` | NOTICES §3 第 2 行（:69） |
| 3 | pi-mono（MIT） | Windows 进程树回收：System32 绝对路径起 taskkill /F /T，带 windowsHide，吞掉 spawn 错误 | `deskminis/src/minisd/proc/win-exec.ts` | `packages/coding-agent/src/utils/shell.ts:216-232` @ 8676a0d | W1b-1 | `f5a68b0`（链 A2 合流 `3119bda`） | NOTICES §3 第 3 行（:70） |
| 4 | ZCode（Apache-2.0） | 数据根锁：wx 独占建锁文件、按 pid 判存活、陈旧锁经接管闸接管 | `deskminis/src/minisd/store/data-root-lock.ts` | `packages/zcode-server-cli/src/runtime/lock.ts` @ 29628c9 | W1b-3 | `d02d861`（链 D1 合流 `5f6c5e9`） | NOTICES §4（:105） |
| 5 | AionUi（Apache-2.0） | 界面令牌取值：Arco/AOU 色系，hex 换算成 oklch | `deskminis/src/renderer/src/styles/tokens.css` A 区 | `packages/desktop/src/renderer/styles/themes/default-color-scheme.css` @ 74512d3（v2.1.59；到 6744099 一字未改） | I 波 I1（不属止血） | `c965365` | NOTICES §2（:50） |
| 6 | AionUi（Apache-2.0） | 单实例锁思路：拿不到锁就退，second-instance 时唤回托盘里的窗口 | `deskminis/src/main/index.ts:47-60` | `packages/desktop/src/index.ts:85-120` @ 6744099 | W1b-3 | `d02d861` | NOTICES §5（:137） |
| 7 | AionUi（Apache-2.0） | 开发态数据隔离思路：未打包时另用 -dev 的数据根与 keyring 服务名 | `deskminis/src/main/app-dirs.ts:26-52` | `packages/desktop/src/process/utils/configureChromium.ts:28-40` @ 6744099 | W1a-9 | `48097bb`（链 A2 合流 `3119bda`） | NOTICES §5（:137） |
| 8 | deepseek-harness（MIT） | 删除前先停掉会话里仍在跑的工作，停不下来就不删 | `deskminis/src/minisd/index.ts:494-505,652-660` | `packages/workspace/workspace/src/index.ts:129-147,348-480` @ 46a7f68b0（功能提交 cbae324bf） | W1b-4 | `00e33d1`（链 D1 合流 `5f6c5e9`） | NOTICES §5（:142） |

### §2b 施工中（未合入 main）

| # | 上游（许可） | 借了什么 | 本仓位置 | 上游位置 @ 提交 | 步骤 | 状态 | 登记 |
|---|---|---|---|---|---|---|---|
| 9 | deepseek-harness（MIT） | 窗口导航守卫：新窗口一律拒绝，外链交系统浏览器，拦下非本应用的导航 | `deskminis/src/main/nav-guard.ts`（新文件）加 `deskminis/src/main/index.ts` 接线 | `apps/desktop/src/main.ts:218-290` @ 46a7f68b0 | W2b-6 | 分支 hemo/f2（写作时 `fd24dd4`），链 F2 | NOTICES §5 已在 W1a-1 预登（:142） |
| 10 | pi-mono（MIT） | 本地崩溃记录：crashes.json 最多 5 条、保留 7 天、下次启动提示一次 | 待定（main 与 minisd 两侧） | `packages/coding-agent/src/core/crash-log.ts:17-18,123-150` @ 8676a0d | W2b-7 | 链 F2 排在 W2b-6 之后，写作时还没有提交 | 照抄改写要在 NOTICES §3 追加一行并写文件头；只借思路则写进 §5 |
| 11 | OpenCode（MIT） | 历史里没有结果的工具标「已中断 · 结果未知」，思路来自 failInterruptedTools | `deskminis/src/renderer/src/lib/steps/status.ts`（新文件）加 `deskminis/src/renderer/src/ui/StageChat.vue` | `packages/core/src/session/runner/llm.ts:119-139` @ 6df0d5d | W2b-11a | 分支 hemo/h（写作时 `4e20153`），链 H | NOTICES 还没有 OpenCode 条目；9/25 §4 第 4 条已建议补登 §5 |

**核对中发现的三件事**：
- **路线里写了、实际没借的**。9/24 路线 W1 借鉴栏还列了 pi 的 durable 迁移 runner 与 settings-manager「有 loadError 就不写」，以及 ZCode 的 edit replacer 与 zip 上限常量。实际施工都没用上：W1a-3 提交写明「技能 zip 用自家常量，不登记 ZCode」，W1a-4、W1a-8 是自写。这几条不算已借，改写借鉴栏时要订正。
- **登记漏了一处**。theme.css 里的色值和字号、圆角同样取自 AionUi，文件注释写明了出处（T1 `d06c74b`、T7 `999bb5c`）；NOTICES §2 只点名 tokens.css 的 A 区。建议在 §2 补一句，同一上游、同一许可，不用新开节。
- **止血进度（供参考）**：设计稿 §4 的 32 步里，27 步已在 main；W2b-2、W2b-3、W2b-6、W2b-7、W2b-11 还没合入。

## §3 pi 的位置

### §3.1 结论

- **主基准 6 行（全是新行）**：14 报错分类与溢出、15 模型能力数据、16 摘要算法、17 上下文水位、19 文件编辑与读取、20 shell 与子进程。
- **次基准 2 行**：7 provider 请求整形（替换 OpenCode llm 包）、18 会话分叉（新行）。
- **不作基准 13 行**：1、2、3、4、5、6、8、9、10、11、12、13、21。其中 5 权限、9 todo、10 与 11 界面、12 cowork、13 文件回退是明确不该，理由见 §3.3。
- **一句话的依据**：pi 是终端 coding agent。它的强项是 pi-ai 这一层多 provider 模型库，以及经典 Agent 循环里打磨过的小机制；界面是 TUI，没有审批，没有 cowork；「会话服务化」那一套还在实验面。

### §3.2 升为主基准或次基准的行

| # | 子系统 | pi 的依据 | 为什么是 pi | 许可与零依赖落地 |
|---|---|---|---|---|
| 14 | 报错分类与溢出（主） | `ai/src/utils/overflow.ts:37-80,136-170`；`ai/src/utils/retry.ts:7-25,237-242`；`ai/src/utils/provider-retry.ts:1-60`；`coding-agent/src/core/agent-session.ts:2599-2697,3326-3329` | 溢出正则最全，还能认出静默溢出；配额耗尽不重试；溢出排在重试判定之前；失败的那次尝试不再进模型视图 | MIT。正则表已照抄进 `overflow.ts` 并登记；其余照抄改写，纯 TS |
| 15 | 模型能力数据（主） | `ai/src/types.ts:1060-1100`；`ai/src/models.ts:1209-1240` | null 表示「这一档不支持」，就近夹取，正是 W9c 思考档位胶囊要的语义 | MIT。clamp 约 30 行照抄改写；档位数据放进 ZCode 形态的规则数据 |
| 16 | 摘要算法（主） | `coding-agent/src/core/compaction/compaction.ts:144-151,468-500,599-617,653,894-960,964`；`compaction/utils.ts:18-89` | 增量合并、切点不落在工具结果上、切在回合中间时另摘前缀、文件清单跨次累积、截断摘要拒收，四家里最完整 | MIT。模板改写成中文、切点逻辑照抄改写，纯 TS |
| 17 | 上下文水位（主） | `coding-agent/src/core/compaction/compaction.ts:162-247`；`coding-agent/src/core/agent-session.ts:3858-3890` | usage 为锚、只估尾部，与 ZCode 同法；多一条「压缩后显示未知」，正是 W5b 验收写的「下次回复后更新」 | MIT。尾部估算保留 DeskMinis 的中文 1.6，不照搬 pi 的 chars/4（`compaction.ts:333,339`） |
| 19 | 文件编辑与读取（主） | `coding-agent/src/core/tools/edit.ts:185-197`；`edit-diff.ts:11-25,306-314`；`read.ts:138-178` | 已经照它改好了 file_edit；续读提示的写法也可照搬 | MIT，已登记。不搬模糊匹配（`edit-diff.ts:37` 的 NFKC 会把中文全角标点改成半角） |
| 20 | shell 与子进程（主） | `coding-agent/src/utils/shell.ts:198-232`；`coding-agent/src/core/tools/output-accumulator.ts:22-40` | 四家里只有它用 System32 绝对路径起 taskkill，能防工作区里的同名 exe；输出累积器只留尾部、完整输出落文件 | MIT，杀树已登记；累积器照抄改写要再登一行 |
| 7 | provider 请求整形（次） | `ai/src/api/openai-completions.ts:874-972,1380,1586-1690`；`ai/src/types.ts:754-812` | 每家兼容端点要哪个开关，pi 写成了现成的表（DeepSeek 的 reasoning_content 回放、z.ai、qwen 的思考格式）；W2a-4 已拿它作印证 | MIT。开关与识别表照抄改写；规则形态以 ZCode 为准，写进声明式数据，providers.json 可覆盖 |
| 18 | 会话分叉（次） | `coding-agent/src/core/agent-session-runtime.ts:262-351`；`agent/src/harness/session/fork-policy.ts:1-67` | 「从这条用户消息分叉」的语义最清楚：复制它之前的前缀，把原文放回输入框；复制表逐类说明状态怎么带过去 | MIT。只借语义，自写；不借树形存储 |

### §3.3 明确不作基准的行

| # | 子系统 | 为什么不该 | 证据 |
|---|---|---|---|
| 5 | 权限与交互 | 没有审批，安全靠操作系统或容器隔离；只有装了扩展才经 tool_call 拦截 | `coding-agent/docs/security.md:3`；`coding-agent/src/core/agent-session.ts:530-550` |
| 8 | 指令文件 | 不经信任就加载 AGENTS.md，一路找到文件系统根，这是反面；分节补丁对不支持的模型折回首条，会改动前缀 | `coding-agent/src/core/resource-loader.ts:174-211,572-579`；`ai/src/utils/transcript.ts:108-120` |
| 9 | todo / 计划 | 没有内置 todo，只有示例扩展 | `coding-agent/examples/extensions/todo.ts:1-11` |
| 10、11 | 多会话可见性、界面投影 | 终端单会话 TUI；实验面的 View/Controller 边界可作参照，不作基准 | `coding-agent/src/modes/rpc/rpc-types.ts:61`；`coding-agent/src/experimental/micro/api.ts:58-88` |
| 12 | cowork | 没有助手，也没有定时任务 | 源码 grep 零命中 |
| 13 | 改动回退 | 没有内置检查点，示例扩展靠 git stash，依赖 git | `coding-agent/examples/extensions/git-checkpoint.ts:1-30` |
| 1、2 | 持久化与协议 | 稳定面是 JSONL 文件加单客户端 stdio；实验面（chord、durable、protocol v8）只在 PI_EXPERIMENTAL 下用，Unix 传输在 win32 上直接抛错 | `coding-agent/src/core/session-manager.ts:1085-1094`；`client/src/unix.ts:38,99` |
| 3、4、6 | 循环、工具协议、压缩触发 | 有可借的小机制，但 OpenCode V2 与 ZCode 更完整；小机制记进 §4 | 见 `pi-notes.md` |

### §3.4 与 OpenCode V2、ZCode 冲突时的取舍

| 子系统 | 冲突 | 取舍 | 理由 |
|---|---|---|---|
| 14 溢出识别 | OpenCode 把任何无 body 的 400/413 都算溢出；pi 只对 Cerebras 这样判 | 按 pi | 普通 400 空 body 当成溢出，会把真正的请求错误藏起来；`overflow.ts` 文件头已写明不搬 |
| 14 溢出补救 | OpenCode 只在还没开始输出时补救；pi 先把失败的那次尝试从模型视图省掉再重试 | 两条都要 | 前者避免重复出字，后者避免失败尝试留在前缀里；DeskMinis 用 W5c 的截止点落盘实现省略，不引 context_edit 表 |
| 16 摘要 | OpenCode 不查 length 截断；pi 截断就拒收 | 按 pi | W2a-1 已按 pi 做拒收；OpenCode「发之前先算摘要请求放不放得下」DeskMinis 也已有 |
| 16 保留尾部 | pi 保留原消息；OpenCode 把尾部序列化成文本，原生块不跨检查点 | 保留原消息，但剥掉保留回合里的思考块 | 原消息保住 tool_use 与 tool_result 的配对；剥思考块照 W5c 已定的 keep-tail 规则 |
| 6 压缩触发 | pi 失败后下一回合还会再试，没有熔断；ZCode 有 rapid-refill 与连续失败熔断 | 按 ZCode | DeskMinis 现在「失败一次本次运行不再压」只是止血，W5a 要换成熔断 |
| 17 水位 | pi 与 ZCode 同法；OpenCode 用整份请求的字符估算 | 按 pi，没锚点时照 OpenCode 把工具 schema 也算进去 | 挂 30 个 MCP 工具时，只算历史会严重偏低（W5b 验收已写） |
| 19 编辑 | pi 精确匹配；ZCode 多级模糊匹配加先读后写；OpenCode 条件写，但有 `$` 替换缺陷 | 匹配与替换按 pi（已落地）；先读后写按 ZCode；OpenCode 的 writeIfUnchanged 只借思路 | 永不用 String.replace，永不做 NFKC；OpenCode 的 `edit.ts:179-182` 与 DeskMinis 修掉的 A 组第 1 条是同一个缺陷 |
| 20 杀树 | pi 用绝对路径；ZCode、OpenCode 用裸名 taskkill；ZCode 另有原生 Job Object | 按 pi | 裸名会先搜子进程 cwd；Job Object 要原生模块，违反零依赖 |
| 7 请求整形 | ZCode 是声明式规则级联；pi 是 TS 开关加按网址识别 | 形态按 ZCode，内容按 pi | 用户能在 providers.json 覆盖，黄金快照钉住请求体；pi 的表省去逐家试错 |
| 15 能力数据 | pi 用 thinkingLevelMap；OpenCode 用 variants；ZCode 用 optionSpecs | 语义按 pi，数据放进 ZCode 形态的规则里，来源仍是 models.dev 加内置兜底表 | 「null 表示不支持、就近夹取」最直接，界面只列可用档 |
| 18 分叉 | pi 是树；ZCode 分三种回退范围；AionUi 在消息上分叉 | 不做树形存储；回退范围按 ZCode；分叉语义与复制表按 pi；入口形态照 AionUi | 路线已定「不为分叉引入树形存储」；DeskMinis 按消息落库 |
| 3 插话 | pi 的 steer/followUp 与 ZCode 的 guide/queue 语义相同 | 不冲突 | W7a 两家都借；pi 多一条「停止时排队消息回填输入框」 |

### §3.5 许可与登记

- **pi-mono**：MIT，Copyright (c) 2025 Mario Zechner。ai、agent、coding-agent 三个包的 package.json 都是 MIT。
  - 复制代码：在 NOTICES §3 的表里追加一行，文件头按 W1a-1 定的格式写；
  - 只借思路：写进 NOTICES §5，§5 现在还没有 pi 的条目。
- **可借的部分都是纯 TS**：溢出正则、compat 开关、clamp、摘要模板与切点、水位估算、编辑文本处理、杀树、崩溃记录、输出累积器、发布器（AdaptivePublisher）。
- **不能借的**：
  - chord 依赖 esbuild；
  - durable 与 harness 是实验面；
  - TUI 与 jiti 扩展加载器跟 DeskMinis 不相干；
  - 编辑预览用的是 npm 的 diff 包（`coding-agent/src/core/tools/edit-diff.ts:5`），DeskMinis 用自家 lib/diff。
- **其余几家**：OpenCode MIT（Copyright (c) 2025 opencode），ZCode Apache-2.0（Copyright 2026 Z.AI Co., Ltd），AionUi Apache-2.0（Copyright 2025 AionUi），deepseek-harness MIT（Copyright (c) 2026 DeepSeek），OpenMinis GPLv3 只借思路。

## §4 对路线的影响

只提建议，不改 `roadmap.md`。下表是因为补进 pi 而新增或改变的借鉴条目；「拍板」栏写「同 9/25 §4 第 N 条」的，是旧题的延伸。

| # | 条目 | 放在哪一波 | 变化 | 来源 | 零依赖落地与许可 | 拍板 |
|---|---|---|---|---|---|---|
| 1 | 第 7 行次基准由 OpenCode llm 包改为 pi；OpenCode 的报文两遍脱敏与 Retry-After 挪到第 14 行 | W4c（范围不变） | 改主次 | pi `ai/src/api/openai-completions.ts:1586-1690` | compat 表照抄改写，登 NOTICES §3 | 同 9/25 §4 第 4 条 |
| 2 | 错误分类以 pi 为主：配额耗尽不重试，Retry-After 超过 60 秒直接降级，溢出判定排在重试之前 | W4c | 定主次（路线借鉴栏已有 provider-retry） | pi `ai/src/utils/retry.ts:7-25,237-242`、`provider-retry.ts:1-60` | 正则照抄改写，登 §3；脱敏照 OpenCode `llm/src/route/executor.ts:35-72` 只借思路 | 不用 |
| 3 | 溢出补救补两种静默溢出（成功但 usage 超窗；length 且零输出占满 99%）；失败的那次尝试不再进模型视图；补救只在本次请求还没有可见输出时做 | W5a（静默溢出要用 W5b 的 usage，实际落在 W5b 之后） | 新增 | pi `ai/src/utils/overflow.ts:150-167`、`coding-agent/src/core/agent-session.ts:2694-2695`；OpenCode `core/src/session/runner/llm.ts:238-296` | 改 `overflow.ts` 与 loop，NOTICES §3 第 2 行「怎么改的」同步改 | 不用 |
| 4 | 摘要细节：切在回合中间时另摘这一回合的前缀；读过与改过的文件清单跨次累积；摘要请求不带工具 | W5a | 新增细节（路线已列 pi compaction.ts） | pi `coding-agent/src/core/compaction/compaction.ts:964`、`compaction/utils.ts:18-89` | 模板改中文、切点照抄改写，登 §3 | 不用 |
| 5 | 水位的尾部估算保留中文 1.6 字一 token，不搬 pi 的 chars/4 | W5b | 明确不借 | pi `coding-agent/src/core/compaction/compaction.ts:333,339` | — | 不用 |
| 6 | shell 输出：内存只留滚动尾部，完整输出落卸载目录，并设总量预算 | W5b | 补全（路线只写了「预览取尾部」） | pi `coding-agent/src/core/tools/output-accumulator.ts:22-40`；ZCode `cli/adapters/src/exec/output-collector.ts:12-40` | 累积器照抄改写，登 §3；ZCode 只借预算思路 | 不用 |
| 7 | 会话中途的 system 消息只发给模型数据里标了支持的端点，默认关；其余一律改用带来源标记的 user 消息，不学 pi 折回首条 | W5c | 新增细节 | pi `ai/src/types.ts:811-812`、`ai/src/utils/transcript.ts:108-120` | 只借思路，登 §5 | 不用 |
| 8 | 工具结果加 details：落库、不进 provider 请求；file_edit 带真实 diff 与首改行号，界面不再从参数重算 | W7a（界面在 W7c 用） | 新增 | pi `agent/src/types.ts:420-432`、`coding-agent/src/core/tools/edit.ts:210` | 只借形状，自写，登 §5 | 不用 |
| 9 | 工具输出进度流：shell 边跑边推尾部视图，发布器按字节限流，最终结果仍只落库一次 | W7c | 新增范围（W7 借鉴栏已列 AdaptivePublisher，范围里没写） | pi `agent/src/harness/utils/adaptive-publisher.ts`（87 行） | 约 80 行照抄改写，登 §3 | **要拍板** |
| 10 | file_edit 预检：弹权限卡之前用执行时同一套匹配先跑一遍，注定失败的直接回模型、不弹卡；预览带行号与上下 4 行 | W7b | 新增 | pi `coding-agent/src/core/tools/edit-diff.ts:514-547`、`tools/renderers/edit.ts:187` | 只借思路；差分用自家 lib/diff，不引 diff 包 | 不用 |
| 11 | 消息级操作：「从某条用户消息重试」把原文回填草稿；回退确认框分「只回退对话 / 只回退文件 / 两者」 | W8b | 新增细节 | pi `coding-agent/src/core/agent-session-runtime.ts:262-287`；ZCode `cli/contracts/src/rewind/index.ts:21-27` | 只借思路，两家都登 §5 | 不用 |
| 12 | 会话分叉：不做树形存储，复制前缀成新会话，配显式复制表 | 0.6.0 之后的设计稿 | 不变，只写明主次：ZCode 主、pi 次 | pi `agent/src/harness/session/fork-policy.ts:1-67`；ZCode `cli/core/src/runtime/methods/workspace-fork.ts:83-140` | 自写 | 不用 |
| 13 | 模型能力数据加档位映射（null 表示不支持）与就近夹取；inputLimits（每请求图片数与字节上限）先不排 | W4c；inputLimits 等视觉代看的设计稿 | 定主次（路线已列 thinkingLevelMap/clamp） | pi `ai/src/models.ts:1209-1240`、`ai/src/types.ts:1060-1100` | clamp 照抄改写，登 §3 | 不用 |
| 14 | W2b-7 崩溃记录照 pi：5 条、7 天、下次启动提示一次；不借「栈归因到扩展」，DeskMinis 没有扩展 | W2b-7（施工中） | 落实 | pi `coding-agent/src/core/crash-log.ts:17-18,123-150` | 照抄改写要登 §3 并写文件头 | 不用 |
| 15 | W6c 借鉴栏里 pi 的 lane.watch 出自实验面，只借「先截快照、再放缓冲」的语义；协议形状以 ZCode 为准 | W6c | 不变，写明出处 | pi `agent/src/harness/runtime/lane.ts:1705` | 只借思路，登 §5 | 不用 |
| 16 | NOTICES：§5 补登 OpenCode（W2b-11a 借的是 failInterruptedTools 的语义）；§2 补一句 theme.css 的取值也来自 AionUi | 随 W2b-11b | 登记订正 | §2 的核对 | — | OpenCode 补登同 9/25 §4 第 4 条；theme.css 不用 |
| 17 | 改写路线借鉴栏时，订正四处「列了没借」：pi 的 durable 迁移 runner、settings-manager，ZCode 的 edit replacer、zip 上限常量 | 改写路线时 | 订正 | 各步提交正文 | — | 同 9/25 §4 第 4 条 |

**需要用户拍板的**：
1. **W7c 加不加「工具输出进度流」**（加）。
   - 做法：长命令跑的时候，步骤展开区能看到输出尾部在动，而不是等结束才一次性出现。
   - 成本：一个 S–M 项，零依赖；照抄 pi 约 80 行发布器，登 NOTICES §3。
   - 代价：0.5.0 的范围多一项。
2. **是否采纳这张 21 行分工表**（采纳）：同 9/25 §4 第 4 条，范围从 13 行扩到 21 行，第 7 行次基准改为 pi。

其余条目都是在已排的波次里补细节，主会话可以按默认写进对应设计稿，不必单独问。

## §5 方法与局限

**读了哪些提交**：

| 项目 | 提交 | 版本 | 本次怎么读的 |
|---|---|---|---|
| OpenCode（sst/opencode） | `6df0d5d` | 1.18.32 | 本地克隆；抽查 9/25 附录引用的行，另读 overflow、edit、shell、fork、desktop 主进程 |
| pi（badlogic/pi-mono） | `8676a0d` | coding-agent 0.87.1 | 本地克隆；逐行读 21 个子系统对应的源码 |
| ZCode（zai-org/ZCode） | `29628c9` | v3.14.3 | 本地克隆，仓库只有 3 个提交；抽查旧报告引用的行，另读溢出、编辑、执行、分叉、崩溃预算 |
| AionUi（iOfficeAI/AionUi） | `6744099` | v2.2.2 | 本次浅克隆（`--depth 50`，一次成功），与 9/24 报告读的是同一提交 |
| deepseek-harness | `46a7f68b0` | 0.1.7-rc.1 | 只核对两处被借思路的位置 |
| DeskMinis | main `3a811a1`；分支 hemo/f1 `dfd65af`、hemo/f2 `fd24dd4`、hemo/h `4e20153`、hemo/s `1ec56d6` | — | 现状栏逐条打开核对；借用逐条对 NOTICES 与提交正文 |

**重新核对过的**（逐条记录见 `spot-checks.md`）：
- pi：9/24 `pi.md` 的关键行，以及 NOTICES §3 三行的上游行号，全部打开看过；本表 pi 列的每个证据都是这次读的。
- OpenCode V2：9/25 附录 13 个子系统的主证据抽查了 27 处；新行的证据是这次读的。
- AionUi：本文引用的 17 处都在 `6744099` 上打开看过；设计令牌文件从 74512d3 到 6744099 一字未改，9/24「零变更」属实。
- ZCode：旧报告引用的行抽查 13 处，另读了新行用到的 5 处。
- DeskMinis：现状栏每条都在 `3a811a1` 上打开看过。

**核对不上、以源码为准的**：
- 9/25 附录说「事件类型带版本号，见 `schema/src/event.ts:109-123`」，实际在 `:94-105`（versionedType），109-123 是一个只读 Map 包装。
- 9/25 附录的 history 分页引 `protocol/src/groups/session.ts:320-345`，实际 history 端点在 `:307-323`，events 端点在 `:326-342`。
- 9/24 `pi.md` 写 pi 有「约 27 条」溢出正则；实际 24 条加 3 条排除，W2a-2 提交已订正。OpenCode 恰好是 27 条，另有 3 条排除。
- 9/24 路线 W7 借鉴栏的 ZCode「splitTurnHistory、classifyStep」按名搜不到，最接近的是 `packages/ui/src/v4/conversationTurnRenderUnits.ts:146` 的 splitTurnTailRows。W7 设计稿前要重新定位。
- 新发现：
  - OpenCode V2 的编辑工具仍用 String.replace（`core/src/tool/edit.ts:179-182`），替换文本里的 `$&`、`$$` 会被解释，用 Node 复现过；
  - pi 的会话文件在加载旧版本时会整文件重写（`session-manager.ts:1085-1094`）；
  - AionUi 的 Web 模式桥（不是桌面端）断线期间的发送会排队、重连后补发（`desktop/common/adapter/browser.ts:161-164,282-290`）；桌面端的实时通道不补发，只发重连信号（`httpBridge.ts:439-447`）。

**沿用旧报告、这次没重核的**：
- ZCode 与 AionUi 在原 13 行里没被本表引用的细节，例如 ZCode 的 plan-mode 策略、AionUi 的通知去重。
- OpenCode V2 app 端除 `project-avatar-state.ts` 外的界面文件。
- deepseek-harness 除两处借用外的全部结论。
- OpenMinis 全部。

**局限**：
- 全部是云端静态读码，没有 Windows 真机，也没有真 API key。第 20 行「裸名 taskkill 会先搜子进程 cwd」沿用 9/24 按 libuv 源码的推断，没有实测。
- pi 的实验面（chord、durable、pico3、protocol v8）只核对了本表用到的几处，没有逐包读。
- AionUi 的引擎 aioncore 不在其仓库里，引擎侧能力一律按「无」记，实际能力可能更多。
- DeskMinis main 在写作期间还在合流；本文行号以 `3a811a1` 为准，施工中分支的 hash 以写作时为准。
