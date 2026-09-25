# 附录 E：底层功能设计基准表（全文）

## 会话模型与事件持久化

- 主基准：OpenCode V2（packages/core 的事件日志）
- 次基准：ZCode V4（快照带 seq、revision、logEpoch）
- 参照：opencode/packages/core/src/event.ts:205-367（immediate 事务依次做：读 seq、跑投影、调 commit 钩子、写 sequence/event；:287-299 重放不一致时报错）；opencode/packages/core/src/event/sql.ts:4-25（event_sequence 表加 event 表，(aggregate_id, seq) 唯一）；opencode/packages/schema/src/event.ts:109-123（事件类型带版本号，形如 type.N）；opencode/packages/core/src/session/projector.ts:214-413（投影出 message/part 读模型）；zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts:397,475-476（revision 与 seq）；deskminis/src/minisd/store/db.ts:15-23（现状：messages 是可变行）
- 许可：OpenCode 是 MIT。只借形状、不复制代码时，在 THIRD-PARTY-NOTICES §5 登记为「仅借思路」。一旦复制代码，就新开「OpenCode — 代码改编（MIT）」一节，照录 MIT 全文和 Copyright (c) 2025 opencode，文件头按登记格式写。ZCode 是 Apache-2.0，复制代码登在 §4 的改编表里。
- 零依赖落地：better-sqlite3 的 db.transaction() 是同步的，保证原子性比 Effect 更简单：
- 追加迁移新建 session_events(session_id, seq, type, data_json, created_at, UNIQUE(session_id, seq))；
- chat-store 的 appendMessage/updateMessage 改为先写事件，再在同一事务里投影 messages；
- messages 继续当读模型，UI 和 20 多个 chat 测试不受影响；
- 事件表不进 LAN 同步（派生状态不同步），同步仍按记录级 diff。
- 对路线的影响：不单开 arch 读者建议的「发版后第一个引擎波」。建表放进 W6c，与 W7a 要用的 session_inputs 表合成 0.5.0 唯一一次追加迁移（待你拍板，备选是 W5c）。W6c 的 chat.watch 返回的 seq 直接取自事件表。W5c 已排的逐消息模型归属列和 source_json 列不变。

借鉴要点：

借鉴要点：
1. 单写者：每个会话只有 minisd 一个写者。
2. 追加事件和更新 messages 读模型在同一个事务里完成。
3. 事件类型从第一天起就带版本号。
4. 重放时 seq 必须恰好等于 latest+1；已存在的 seq 必须逐字段一致，否则报错。
5. delta 不落库，只在结束时写一次完整值。
6. commit 钩子用来推进不参与重放的本地状态，比如 context 基线。

反面不借：OpenCode 的事件 schema 一改就重置实验库（specs/v2/schema-changelog.md:14-22）。DeskMinis 有真实用户库，只能追加迁移。

## 引擎与渲染端协议

- 主基准：ZCode V4 协议（已在产品里运行）
- 次基准：OpenCode V2（durable/delta 双轨、按 seq 续传、有限 history、会话钉定的 RPC）
- 参照：zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts、delta.ts（快照加 7 种封闭增量；表达不了的变化整份 resync）；zcode/packages/rpc/src/channelClient.ts:26,68-85（pendingRejections：断开时拒绝全部挂起调用）；opencode/packages/schema/src/session-event.ts:448-519（DurableDefinitions 不含 delta）；opencode/packages/core/src/event.ts:152-164,565-604（先订阅唤醒信号再回放；反面：全局流溢出时直接失败）；opencode/packages/protocol/src/groups/session.ts:320-345（history 按 after 分页，默认 50、上限 100，返回 hasMore）；opencode/specs/v2/api.html:1100 起（操作分三类：服务器级、工作区级、会话钉定）；deskminis/src/minisd/index.ts:749（chat.event 广播不带 seq）；deskminis/src/renderer/src/rpc.ts（71 行，没有 onclose 和重连）
- 许可：ZCode Apache-2.0，复制代码须登 NOTICES §4 并在文件头写「本文件已修改」；OpenCode MIT，同上一行。本项以借语义为主。
- 零依赖落地：JSON-RPC over WebSocket 不换：
- W6b 把 rpc.ts 重写成带连接代次的 RpcClient；
- minisd 侧的 SessionRuntime 为每个会话维护 seq，取自事件表，广播帧加上 epoch 和 seq；
- 渲染端用按会话键控的纯 reducer，发现跳号就重新调 chat.watch。
- 对路线的影响：W6b/W6c 原有的借鉴（ZCode V4 的 seq/resync、pi 的 lane.watch）不变，增补 OpenCode V2 的三点：delta 不进游标、有限 history 分页、会话钉定的 RPC 分类（最后这一点同时并入 W6d 的越权收口）。W6c 验收增加两条：事件词表含执行生命周期四态；全局广播溢出时发 resync 信号。

借鉴要点：

借鉴要点：
1. durable 事件带 (sessionId, seq)；delta 只广播，不推进游标。
2. 先登记订阅再回放，保证不漏也不重。
3. 新增 chat.events.since({sessionId, afterSeq, limit})，返回 {events, hasMore}。
4. 表达不了的变化整份 resync（ZCode 做法）。
5. 连接断开时拒绝全部挂起调用，绝不重发 chat.prompt。
6. 会话方法只收 sessionId，由 minisd 从会话行解析工作区。
7. 自己定一套封闭的事件词表，必须包含执行开始/成功/失败/中断、已安排重试、压缩失败。

不借：全局流溢出时静默断流（DeskMinis 应在溢出时补发「请全量重拉」）；照搬 session.next.* 或 session.execution.* 的事件名；codegen 生成双客户端（违反零依赖）。

## 运行器循环

- 主基准：OpenCode V2（两层循环的边界法则）
- 次基准：ZCode（guide 在 model-step 边界消费；不以工具调用次数硬停）
- 参照：opencode/packages/core/src/session/runner/llm.ts:173-355（外层按 steer/queue 调度，内层按 needsContinuation；工具结算后重读投影历史）；opencode/packages/core/src/session/runner/llm.ts:119-139,397（failInterruptedTools：在下一次 run 时把悬空工具判为失败，不重放）；opencode/packages/core/src/session/run-coordinator.ts:51-104（run 加入已有执行、wake 合并唤醒、interrupt 不删收件箱）；opencode/packages/core/src/session/runner/max-steps.ts:1-16 与 llm.ts:202,218（收尾回合；反面：提示以 assistant 消息结尾）；zcode/apps/zcode-cli/packages/core/src/runtime/methods/turn-guide-drain.ts:9-58（每个 model-step 边界最多消费一条 guide，以 user 角色续上）；deskminis/src/minisd/agent/loop.ts:288,371,657,677,686；deskminis/src/minisd/index.ts:602（inFlight 拒收）
- 许可：OpenCode MIT、ZCode Apache-2.0，都以借语义为主，登记在 §5。
- 零依赖落地：loop.ts 保持 refactor，不重写（roadmap 已定）：
- 协调器约 60 行纯 TS，替换 inFlight Set；
- 每次运行开始时对比 assistant(toolUse) 和 toolResult，找出悬空工具；
- 收尾回合复用现有 provider 调用，tools 置空。
- 对路线的影响：W5a 增一项：用收尾回合（user 角色提示 + 空工具列表）替换 loop.ts:686 的「已达最大回合数」错误。W6c 的 SessionRuntime 采用协调器语义。W7a 增一项：结果逐个落库，运行开始时把悬空工具持久化为「执行被中断」。0.3.0 不动引擎：arch 读者提议发版前就做这两项，核验后不成立。

借鉴要点：

借鉴要点：
1. 回合结束后从库里重读历史，再进下一回合。
2. 悬空工具在下一次运行开始时，惰性写成「执行被中断」的失败结果；有副作用的调用绝不自动重跑。
3. 到达 maxTurns 时发一轮不带工具的收尾回合，但提示必须用 user 角色。
4. 会话协调器采用 run/wake/interrupt 语义：准入后只叫醒执行器；运行中只挂一个待续标记；停止只停当前执行，不删已排队的消息。
5. 不以工具调用次数做硬停。

不借：无上限的急切并发；用抛异常当 goto 来控制重跑（llm.ts:152-166,362-388）。

## 工具协议与副作用元数据

- 主基准：ZCode（readOnly / concurrentSafe / sideEffectScope 加 ToolScheduler 屏障）
- 次基准：OpenCode V2（注册时命名、编解码边界、注册表统一截断、stale 守卫、失败分类）
- 参照：zcode/apps/zcode-cli/packages/core/src/tool/scheduler.ts:23-66（readOnly/concurrentSafe，只读工具表兜底）；zcode/apps/zcode-cli/packages/core/src/runtime/methods/tools.ts:50-55（readOnly 要求 sideEffectScope 为 none）；opencode/packages/core/src/tool/tool.ts:9-132（不透明 Tool，名字在注册时给定）；opencode/packages/core/src/tool/registry.ts:42-125（入参解码失败不调 execute；注册身份不一致时返回 Stale tool call）；opencode/packages/core/src/tool-output-store.ts:13-16（按 2000 行 / 50KB 统一截断并落盘）；opencode/specs/v2/tools.md:40-56,130-170（ToolFailure、中断、缺陷三者不混用）；deskminis/src/minisd/agent/loop.ts:62,657（同批工具一律 10 路并发）
- 许可：ZCode Apache-2.0，复制 scheduler 须登 §4；OpenCode MIT，只借法则。
- 零依赖落地：在 tools/registry.ts 加元数据字段和统一的结算函数。调度器写成纯函数：输入调用列表加元数据，输出分段计划；用 vitest 表驱动测试。入参校验沿用现有的手写校验。
- 对路线的影响：W7a 本来就有 readOnly/concurrencySafe 调度，增补 stale 守卫和结果三分类。W5b 的卸载桩改造改为在注册表出口统一做。

借鉴要点：

借鉴要点：
1. 每个工具声明 readOnly、concurrentSafe 和副作用范围；只读且可并发的成段并行，其余作为屏障按原顺序执行。
2. 名字在注册时给定。
3. 入参校验不过，就不调用 handler。
4. 截断和卸载只在注册表的结算出口做一次。
5. stale 守卫：每回合记下「工具名 → 注册实例」，MCP 在回合之间重连后，旧的调用报错，不执行新实现。
6. 结果分三类：被拒绝、被用户纠正（带附言原文）、执行失败。反例是 OpenCode 自己的 mapError（bash.ts:196；edit.ts:110-118），把这三类混成一句「Unable to …」。

## 权限与交互通道

- 主基准：ZCode（InteractionRegistry、无人值守时自动应答）
- 次基准：OpenCode V2 的 PermissionV2（配置 deny 先判、拒绝级联、always 连带重评）
- 参照：zcode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/interaction-registry.ts:30-31；zcode/apps/zcode-cli/packages/core/src/runtime/methods/interaction-auto-resolution.ts；opencode/packages/core/src/permission.ts:137-162,200-215（配置 deny 先判；解析不到 agent 时全拒）；opencode/packages/core/src/permission.ts:231-283（拒绝级联到同会话；always 保存规则后重评其余待批）；opencode/packages/core/src/tool/bash.ts:142-148、util/wildcard.ts:3-14、plugin/agent.ts:109（反面：原始命令存成通配规则，默认 * * allow）；opencode/packages/app/src/pages/session/composer/session-permission-dock.tsx:36-70（反面：不显示「总是允许」保存的范围）；deskminis/src/renderer/src/ui/PermCard.vue:7-13
- 许可：ZCode Apache-2.0；OpenCode MIT。如果照抄 OpenCode 的 dock，须新开 MIT 改编节。
- 零依赖落地：把 index.ts 里的 pendingPerms 和 90 秒倒计时抽成 InteractionRegistry 类，暴露 permission.pending 只读 RPC；级联和重评写成纯函数，表驱动测试。
- 对路线的影响：W6c 不变。W7b 增补拒绝级联、同会话重评和结果三分类；验收加一条：拒绝一张后，同会话其余卡片全部结算。

借鉴要点：

借鉴要点：
1. 权限卡、ask_user、计划审阅、信任卡共用一个 InteractionRegistry。
2. 拒绝其中一张，同会话其余待批全部拒绝，并停止循环。
3. 点「本会话允许」后，重评同会话其余待批。
4. 保存的放行规则永远压不过配置的 deny。
5. 拒绝时的附言原文写进 tool_result。
6. 「总是允许」只存结构化的精确匹配，绝不存模型写的原始命令。
7. 卡片停靠到输入区后，仍逐字显示路径、命令和授权范围。

## 上下文压缩

- 主基准：ZCode（microcompact、rapid-refill 与连续失败熔断）
- 次基准：OpenCode V2（单个隐藏检查点、滚动摘要、原生块不跨边界、溢出只补救一次）
- 参照：zcode/apps/zcode-cli/packages/core/src/compact/policy.ts:62,142（circuit_breaker）；zcode/apps/zcode-cli/packages/core/src/runtime/methods/compact.ts:230-244（rapid-refill 熔断）；zcode/apps/zcode-cli/packages/core/src/compact/microcompact.ts；opencode/packages/core/src/session/compaction.ts:12-55,137-243（buffer 20000、保留 8000、合并旧摘要 prior-summary）；opencode/packages/core/src/session/runner/to-llm-message.ts:145-163（检查点之前的 provider 原生块不再回放）；opencode/packages/core/src/session/runner/llm.ts:362-388（溢出时压缩后重跑一次）；deskminis/src/minisd/agent/loop.ts:331,391；deskminis/src/minisd/agent/context-policy.ts:9-12（CJK 字符按 1.6 估算）
- 许可：ZCode Apache-2.0，常量和策略可以复制，须登 §4；OpenCode MIT，只借法则。
- 零依赖落地：W5a 按结构化模板重写 compact.ts；检查点沿用 compact_markers 表；原生块剥离放在请求投影的纯函数里做。
- 对路线的影响：W5a 和 W5c 的原计划已经覆盖，不加范围；OpenCode V2 作为第二份印证。W5a 验收补一条：压缩失败时保留上一个 marker，不写空摘要。

借鉴要点：

借鉴要点：
1. 滚动摘要：把旧摘要和新对话一起合并，不每次从头摘。
2. 检查点之后，不回放 provider 原生的思考块和工具块。
3. 溢出且还没有任何输出时补救一次；第二次溢出如实失败。
4. 压缩的 started 和 ended 都作为事件；只有 ended 在界面上可见；失败时保留上一个边界。
5. 用 rapid-refill 加连续失败熔断，取代现在的 compactCount<3。

不借 chars/4 的 token 估算，DeskMinis 现有的 CJK/1.6 对中文更准。

## provider 与模型规则

- 主基准：ZCode（modelRules 规则数据）；DeskMinis 现有的降级、重试梯、60 秒看门狗保持不倒退
- 次基准：OpenCode 的 @opencode-ai/llm 包（不是 V2 runner）
- 参照：zcode/packages/provider/src/config/rule-data-schema.ts、model-config.ts；opencode/packages/llm/src/route/executor.ts:35-72,94-97（重试、retry-after、错误信息两遍脱敏、响应体截断到 16KB）；opencode/packages/llm/src/cache-policy.ts:5-34；opencode/packages/core/src/session/runner/to-llm-message.ts:71-80（reasoning 和 provider 元数据只在同一模型续写时回放）；opencode/packages/core/src/session/runner/model.ts:131-176、runner/llm.ts:338（反面：V2 runner 只接 3 条路由、不降级、cost 写 0）；deskminis/src/minisd/providers/sse.ts:6-8；deskminis/src/minisd/agent/loop.ts:548,568（retry 和 fallback 的 reason 直接取 provider 原始报文，经 TaskPanel.vue:74 上屏）
- 许可：ZCode Apache-2.0；OpenCode MIT；pi（MIT）已在 roadmap 的借鉴栏里。
- 零依赖落地：ErrorClassifier 和脱敏都写成纯函数；脱敏以本次请求实际用到的密钥串为字典逐一替换；usage 映射用表驱动。
- 对路线的影响：W4c 增一项：错误报文先脱敏，再进 fallback 和 retry 事件。换模时的思考块降级并入 W4c 的矩阵。

借鉴要点：

借鉴要点：
1. provider 错误在落库和上屏之前做两遍脱敏：先按字段名，再按本次请求实际发出的密钥原值。
2. 降级换模后，旧模型的思考签名降为普通文本，不再回放。
3. 请求带上会话亲和键和缓存键。
4. usage 规范化满足 nonCached + cacheRead + cacheWrite = input。
5. 规则数据用声明式 patch 表达。

不向 V2 runner 看齐。

## 配置与指令文件加载

- 主基准：OpenCode V2（System Context 源代数、context epoch、AGENTS.md 向上发现）
- 次基准：ZCode（context sections）
- 参照：opencode/packages/core/src/system-context/index.ts:21-39,197-291（unavailable 与 removed 区分；首次观测时有源 unavailable 就阻塞）；opencode/packages/core/src/session/context-epoch.ts:40-78（首次运行冻结基线；之后追加 context.updated；压缩后重渲基线）；opencode/packages/core/src/instruction-context.ts:39-73,128-137（向上找 AGENTS.md，不越出项目根）；opencode/packages/core/src/config.ts:151-160（反面：配置解析失败时静默跳过该文件）；zcode/apps/zcode-cli/packages/core/src/context/sections/request-user-context.ts、memory.ts；deskminis/src/minisd/providers/anthropic.ts:55,67（现状：system 上打了 cache_control；全仓没有 AGENTS.md 加载）
- 许可：OpenCode MIT，借数据模型，在 §5 登记；ZCode Apache-2.0。
- 零依赖落地：context 源注册表用纯 TS 实现；基线和快照存成 sessions 表的两列，随 W5c 那次追加迁移加上；比较时用稳定序列化后的字符串是否相等。
- 对路线的影响：W5c 已定的方向不变，这里补上具体数据模型；W5c 的迁移增加基线和快照两列；prefix-stable 验收增加「指令文件读取失败不改写请求前缀」。

借鉴要点：

借鉴要点：
1. system 拆成两部分：会话首回合冻结并存库的基线，加上若干带 key 的源（env、日期、指令文件、技能清单、记忆、助手规则）。
2. 每个安全边界重新观察一次；有变化才追加一条带来源标记的注记消息。
3. 只有压缩完成或更换工作区时才重渲基线。
4. 指令文件在 workspaceRoot 内向上查找，再加上 %APPDATA%\\DeskMinis 下的全局文件；读取失败按 unavailable 处理，不当作被删除。
5. 配置文件损坏时显式报错，给出路径和行号，不能当成空配置。

## todo/计划

- 主基准：AionUi（ConversationPlanBar、usePlanRecovery）
- 次基准：ZCode（todo 整表替换、同时最多一个进行中、plan-mode 权限策略）
- 参照：aionui/packages/desktop/src/renderer/pages/conversation/PlanBar/ConversationPlanBar.tsx；aionui/packages/desktop/src/renderer/pages/conversation/PlanBar/usePlanRecovery.ts:23、useLatestPlan.ts；zcode/apps/zcode-cli/packages/core/src/tool/handlers/todo.ts:137-139,195；zcode/apps/zcode-cli/packages/core/src/permission/plan-mode-policy.ts；opencode/packages/core/src/session/todo.ts:32-57、schema/src/session-todo.ts:18-24（反面：todo.updated 不是 durable 事件，也没有读取路由）
- 许可：AionUi Apache-2.0；ZCode Apache-2.0。
- 零依赖落地：todo_write 当作普通工具，结果即 durable 消息；渲染端用纯函数 foldLatestTodo 从消息中折叠出当前清单。
- 对路线的影响：W7c 不变，把 OpenCode 明确排除在借鉴栏之外。

借鉴要点：

借鉴要点：
1. todo_write 采用整表替换，同时最多一个进行中，条目 id 确定。
2. 计划条钉在输入框上方。
3. todo 状态必须能从会话历史里折叠还原出来。
4. 计划审阅复用权限卡。

OpenCode V2 在这一块不作基准。

## 多会话与运行态可见性

- 主基准：AionUi（等待态 reducer：mark/unmark；显示优先级「等待 > 运行 > 未读」）
- 次基准：OpenCode V2 app（子会话请求冒泡到父会话；换壳丢通知的反面教训）
- 参照：aionui/packages/desktop/src/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync.ts:182-219,258-279,472-476；aionui/packages/desktop/src/renderer/pages/conversation/runtime/conversationRuntimeViewStore.ts:12-20,154-166；aionui/packages/desktop/src/process/bridge/notificationBridge.ts；opencode/packages/app/src/pages/layout/project-avatar-state.ts:36-45；composer/session-request-tree.ts:3-34；opencode/packages/app/src/pages/layout.tsx:405-455 对照 layout-new.tsx（反面：权限/提问通知只挂在旧外壳上）；deskminis/src/renderer/src/ui/NavRail.vue
- 许可：AionUi Apache-2.0；OpenCode MIT，只借教训。
- 零依赖落地：lib/waiting/reducer.ts 写成纯函数，配 vitest 测试。
- 对路线的影响：W7b 不变，增补一条验收：通知接线不依赖任何外壳组件是否挂载。

借鉴要点：

借鉴要点：
1. waitingBySession 维护 sessionId → Set<requestId>。
2. 会话行的显示优先级是：等待你 > 运行中 > 未读。
3. 子会话的请求冒泡到父会话。
4. 事件到系统通知的接线放在 store 或 lib 层，不放在外壳组件里。
5. 窗口刷新后，用 permission.pending 回填等待集合。

## 界面状态投影

- 主基准：AionUi（运行态视图投影、流式消息合并）
- 次基准：OpenCode V2（服务端投影的类型化消息联合、时间线行模型；反面：前端又做一次归一）
- 参照：aionui/packages/desktop/src/renderer/pages/conversation/runtime/conversationRuntimeViewStore.ts:99-166；aionui/packages/desktop/src/renderer/pages/conversation/Messages/hooks.ts:140-165；opencode/packages/schema/src/session-message.ts:165-213；opencode/packages/app/src/pages/session/timeline/timeline-row.ts:7-52；opencode/packages/app/src/utils/session-message.ts:48-120（反面）；deskminis/src/renderer/src/stores/chat.ts；deskminis/src/renderer/src/ui/StageChat.vue:86-129,112
- 许可：AionUi Apache-2.0；OpenCode MIT。
- 零依赖落地：在 lib/session-view/ 下写纯 reducer；StageChat 的回合切分抽成纯函数，配表驱动测试。
- 对路线的影响：W6c 的纯 reducer 以 AionUi 的运行态视图为形；W7c 增加对话流内的分隔行。

借鉴要点：

借鉴要点：
1. 渲染端只保留一套消息模型，直接消费 minisd 的投影。
2. 运行态视图用纯函数投影，并带一个「是否支持运行中投递」的标志位。
3. 降级、压缩、换模这类事件作为对话流内的分隔行显示。
4. chat.ts 的 action 名保持不变，先在前面加一层按会话的投影，再逐步迁移。
5. 没有结果的历史工具，不能默认显示为成功。

## cowork 能力（助手与定时）

- 主基准：AionUi（助手体系、ICronSchedule、CronJobManager）
- 次基准：ZCode（无人值守时交互自动应答、自动化指令）
- 参照：aionui/packages/desktop/src/common/adapter/ipcBridge.ts:1673-1760；aionui/packages/desktop/src/renderer/pages/cron/components/CronJobManager.tsx；aionui/packages/desktop/src/renderer/utils/model/assistantSelection.ts；zcode/apps/zcode-cli/packages/core/src/runtime/methods/interaction-auto-resolution.ts；zcode/packages/ui/src/settings/AutomationInstructionsComposer.tsx；deskminis/src/renderer/src/ui/StageAssistants.vue、StageCron.vue
- 许可：AionUi Apache-2.0；ZCode Apache-2.0。技能和助手的正文自己写。
- 零依赖落地：沿用现有的 cron 和助手存储；无人值守判定作为 InteractionRegistry 里的一个策略函数。
- 对路线的影响：W4a、W7b、W8a 不变，OpenCode 不进这几波的借鉴栏。

借鉴要点：

借鉴要点：
1. OpenCode V2 没有助手和定时任务，这一块不作基准。
2. 定时任务运行时遇到 ask_user，立即返回「无人应答」。
3. 助手可以设工具和 MCP 开关，在建会话时快照。
4. 空会话显示助手空态。

## 改动追踪与回退（补充项）

- 主基准：ZCode（rewind 检查点，回退前预览可安全回退与不可回退）
- 次基准：OpenCode V2（回合前后快照；stage / clear / commit 三段式回退）
- 参照：zcode/apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts:30-117；zcode/packages/ui/src/v4/ConversationFileRewindDialog.tsx；opencode/packages/core/src/session/revert.ts:27-121；opencode/packages/core/src/session/runner/llm.ts:224,323-343；opencode/packages/core/src/snapshot.ts:43-60（依赖 git，不借）；deskminis/src/renderer/src/lib/artifacts/collect.ts:40-42
- 许可：ZCode Apache-2.0；OpenCode MIT。
- 零依赖落地：用 Node 内置的 fs 复制文件、crypto 算 sha1；检查点索引随 W8 那次追加迁移建表。
- 对路线的影响：W8b 增补「三段式、可撤回的回退」和「回合结束事件带上改动文件」。

借鉴要点：

借鉴要点：
1. 写入前把原文落到检查点目录；回退前做 hash 校验，只要有一个文件不安全就整批拒绝。
2. 回退分三段：stage 预演，clear 或 commit 结束，stage 之后可以撤回。
3. 回合结束事件记录本回合改动了哪些文件。
4. 不依赖 git。

# 裁剪清单（全文）

## [simplify] 标题栏窗控形制（无边框 + 系统绘制窗控 titleBarOverlay + 右侧 146px 让位）。这是唯一能确认出自 OpenCode 的界面件

理由：出处成立，但证据是间接的：docs 提交 5c6e4f5（2026-07-27）把 ui-design.md:109-128（§4.0）和 opencode-0.md 一起加入，参数与 opencode-0.md:9 所记的 OpenCode windows.ts 逐项一致；只借了思路，没有复制代码。这个形制应该保留：ZCode 也用 titleBarOverlay（desktopWindowButtonPosition.ts:90-110）；AionUi 在 Windows 上用 frame:false 加自绘窗控，DeskMinis 改成那样反而要多写窗控。要修的是两处当初抄漏的细节：main/index.ts:129-130 的注释写「符号色随明暗」，实际 :133 写死了 '#808080'；TopBar.vue:2-3 的注释写留 140px，实际样式 :58 是 146px。

替换：参照 ZCode packages/desktop/src/main/desktopWindowButtonPosition.ts:90-110（Apache-2.0）：主题或页面缩放变化时，用 win.setTitleBarOverlay 同步 overlay 高度和符号色；经 IPC 把右侧安全区宽度推给渲染端，取代写死的 146px。如果照抄代码，要在 THIRD-PARTY-NOTICES §4 的 ZCode 改编表里登记，并按登记格式写文件头。守卫：新增一条「符号色随主题」的源码守卫；renderer-titlebar-stacking 不受影响；license-consistency 的双向绊线会检查登记。

文件：/home/user/Deskminis/deskminis/src/main/index.ts、/home/user/Deskminis/deskminis/src/preload/index.ts、/home/user/Deskminis/deskminis/src/renderer/src/ui/TopBar.vue、/home/user/Deskminis/deskminis/tests/renderer-titlebar-stacking.test.ts、/home/user/Deskminis/deskminis/tests/license-consistency.test.ts、/home/user/Deskminis/THIRD-PARTY-NOTICES.md

时机：0.3.0 期间：只借 W2b-3 这一步（它本来就要改 TopBar 和 main/index.ts）把两处注释改成与实现一致，行为不动。实现排在 W9c（原计划已有「缩放后窗控与 146px 保留区在真机上校验」），需要 Windows 真机目视验证。

## [cut] TopBar 的 ☰「菜单」钮（实际只切换明暗，而且不保存）

理由：这是自创的遗留件，与 OpenCode 无关：§4.0 原本规划了一整套自绘菜单，I6 收成一个 ☰，到 T 波只剩切主题。按钮名不副实：TopBar.vue:33-35 的 title 写「菜单」，AppShell.vue:63-67 的 toggleTheme 只翻转 dataset.theme，不落盘。另一个入口 SecLook.vue:16-27 只在打开外观页时才读回 localStorage，所以设置里保存的主题启动时不生效，两个入口还会互相覆盖。AionUi 的标题栏也没有这类杂项钮。

替换：主题只保留「设置 → 外观」这一个入口。把 SecLook 的 apply 抽成纯函数，在应用启动时调用读回，也就是把 W9c 的「已保存的主题在首帧生效」提前做。守卫：新增「TopBar 不再有 menu 事件、主题在启动时读回」；renderer-settings-modal.test.ts:62 的用例名顺手改掉（名字写「主题键保留」，实际不做断言）。主题存在 userData 下的 localStorage，要和 W1a-9 的开发态数据隔离一起验证；docs/RELEASE.md 的冒烟清单如果提到 ☰，同步修改。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/TopBar.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/settings/SecLook.vue、/home/user/Deskminis/deskminis/src/renderer/src/main.ts、/home/user/Deskminis/deskminis/tests/renderer-settings-modal.test.ts、/home/user/Deskminis/docs/RELEASE.md

时机：0.3.0 期间不动，因为 W2b-3 正在改 TopBar。发版后新增一个「U 子波：界面减法」，排在 W4b 之后、W4c 之前，随 0.4.0 发布。放在 W4b 之后，是为了用 W4b 的 SSR 渲染测试给「入口没丢」做守卫，避开 T 波靠源码 grep 守卫、换壳时丢入口的老问题。

## [cut] 底部终端抽屉 TerminalPane，连同 TopBar 终端钮和 minisd 的 terminal.* / TerminalManager

理由：不是 OpenCode 的：它最早见于 design.md:346（提交 bcbdf55），早于 OpenCode 研读，也记在 PROJECT_NOTES.md:33。砍掉的理由：
- 这是面向 coding 的专业件，cowork 用户不会去敲 PowerShell。
- 体验是没有 PTY 的哑管道：没有行编辑，也没有 Tab 补全。
- 界面文案不实：说与 agent 共用 shell，实际 index.ts:337 和 :341 是两套实例。
- 维护面大：单独的驱动脚本、两个 @xterm 依赖、W1b-1 进程树回收也要照顾它，还有 5 例测试只能在 Windows 上跑。
OpenCode 自己也把终端撤出了主界面（session-header.tsx:529-567），AionUi 没有交互终端。但它是 V 波刚补回来的能力，PROJECT_NOTES.md:397 把它列为已验证的需求信号，所以砍不砍要你拍板。

替换：参照 AionUi：agent 跑的命令和输出在对话流里看，也就是 StepGroup 展开区的输出块（StepGroup.vue:60-63）。将来如果有后台长命令，参照 ZCode 的只读侧栏页 packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx，不做可输入的终端。分两步做：
1. 删界面入口：TopBar.vue:42-44，AppShell.vue:24、31、73、76、102，以及 TerminalPane.vue。renderer-content-form.test.ts 在模块级读取 TerminalPane，删文件会让整份 4 例全红，所以要先把其中「用户气泡」和「活动指示」两条形态裁定迁到别的测试文件；renderer-shell-panels 的 V4 三例原位退场并写明理由。
2. 删后端：minisd/terminal.ts，以及 index.ts:65、337、523、964-965、1235 的装配。shell-kill-tree.test.ts 在顶层 import 了 TerminalManager、workspace-picker.test.ts:32 在模块级读 terminal.ts，两者都要先去掉对终端的引用，否则整文件变红。terminal.test.ts 删除，linux-baseline-failures.txt:48-52 删 5 行，tokens-mu3-appica 例 9 一并处理。两个 @xterm 依赖由你在本机用 npm 改锁文件，deps-frozen 与 license-consistency（NOTICES §6 对账）同步更新。
README:31、CHANGELOG、RELEASE.md:47 改写为「移除」。mu6 守卫抓不到这次退场（终端直接调 rpc），所以要在提交正文里申报能力退场。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/TerminalPane.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/TopBar.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue、/home/user/Deskminis/deskminis/src/minisd/terminal.ts、/home/user/Deskminis/deskminis/src/minisd/index.ts、/home/user/Deskminis/deskminis/package.json、/home/user/Deskminis/deskminis/tests/terminal.test.ts、/home/user/Deskminis/deskminis/tests/shell-kill-tree.test.ts、/home/user/Deskminis/deskminis/tests/workspace-picker.test.ts、/home/user/Deskminis/deskminis/tests/renderer-content-form.test.ts、/home/user/Deskminis/deskminis/tests/renderer-shell-panels.test.ts、/home/user/Deskminis/deskminis/tests/tokens-mu3-appica.test.ts、/home/user/Deskminis/deskminis/tests/deps-frozen.test.ts、/home/user/Deskminis/deskminis/tests/license-consistency.test.ts、/home/user/deskminis-docs/docs/handoff/linux-baseline-failures.txt、/home/user/Deskminis/README.md、/home/user/Deskminis/CHANGELOG.md、/home/user/Deskminis/docs/RELEASE.md

时机：0.3.0 期间只做 W2b-11 已排好的文案订正，不砍。W1b-1 刚给终端加了进程树回收，发版前删掉等于推翻刚合入的止血成果，也违反 roadmap.md:311。第 1 步放进 U 子波（W4b 之后）；第 2 步放进 W6d（执行面硬化，正好收缩子进程面），依赖删除等你在本机操作。

## [replace] 任务面板 TaskPanel（上下文水位、降级/压缩/卸载三张卡、待批准、上轮结束原因）

理由：不是 OpenCode 的：出处是 design.md:346-347 和 M2d。信息本身有用，问题在位置和重复：
- 藏在右栏第三个 tab 里（WorkspacePanel.vue:99-101），靠 15 秒轮询刷新（TaskPanel.vue:16-18）。
- 降级/压缩/卸载三张卡（:70-95）和对话流里的 EventNotes 重复，ui-audit.md:42 早就指出过。
- 「达到单轮输出上限，回答可能被截断」这句提示在整个渲染层只出现在这里（:34-39、:97-100），用户基本看不到。
- 降级卡直接显示 provider 的原始报文：loop.ts:568 的 lastError.message 原样上屏，见 :74。

替换：换成输入卡工具行上的上下文占用环：
- 形态取 AionUi 的 packages/desktop/src/renderer/components/agent/ContextUsageIndicator.tsx（拿不到真实窗口大小时只画空心环，不用猜出来的分母给百分比）。ZCode 的 packages/ui/src/chat-input-toolbar/contextUsage.tsx 和 OpenCode 的 packages/app/src/components/session-context-usage.tsx 是同一种做法。
- 数值以 W5b 的真实 usage 为锚。
- 刷新改成事件驱动：chat.ts 在 turnEnd/fallback/compacted/offloaded 分支里已经会调 fetchContextInfo，15 秒轮询可以去掉。
其余内容的去向：停止原因作为 EventNotes 的新 kind，追加在 chat.ts:108 联合类型的末尾；三张重复卡删掉；「等你批准」交给 W2b-2 的 NavRail 等待标和 W7b。
守卫的顺序很重要：
1. mu6 的可计算不变量（:144-150）只认 store action，抓不到这次搬家，所以删面板之前，先在 mu6「非 store action 的界面能力」一节（:115-132）给上下文环和停止原因文案加正向钉。
2. renderer-tasks-panel.test.ts:13 在模块级读 TaskPanel.vue，要先把只锚 chat.ts 的 S1-S4 迁到别的文件，再删面板。
3. renderer-shell-panels 的 V5/V5c 改指向 Composer 和 EventNotes，「StopReason 四个值都有中文」这条不变量保留。
4. W2b-2 新建的 perm-session-scope.test.ts 同步修改。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/TaskPanel.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/Composer.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/EventNotes.vue、/home/user/Deskminis/deskminis/src/renderer/src/lib/eventnote/copy.ts、/home/user/Deskminis/deskminis/src/renderer/src/stores/chat.ts、/home/user/Deskminis/deskminis/tests/renderer-tasks-panel.test.ts、/home/user/Deskminis/deskminis/tests/renderer-shell-panels.test.ts、/home/user/Deskminis/deskminis/tests/mu6-capability-wiring.test.ts、/home/user/Deskminis/deskminis/tests/renderer-eventnote.test.ts、/home/user/Deskminis/deskminis/tests/renderer-eventnote-copy.test.ts

时机：0.3.0 期间不动：W2b-2 正在改 TaskPanel.vue:62-66，W2a 正在改 chat.ts 和 EventNotes。放到 W5b 收尾时做，把 W9c 的「输入区上下文占用环」提前到 W5b，和真实水位同一个子波交付，否则真实水位做完了也没有地方显示。

## [simplify] 右栏 WorkspacePanel 从「文件 / 改动 / 任务」三个 tab 收成「文件 / 改动」两个

理由：不是 OpenCode 的。AionUi 的 ExplorerContainer.tsx:512-548 就只有 files/changes 两个 tab。WorkspacePanel.vue 文件头 :2-4 本来也写的是「两个 tab」，和现在的三个 tab 自相矛盾；三个 tab 挤在 244px 里，只能靠 nowrap 补丁撑住（:187-189）。注意：任务 tab 上的橙点（:100）是右栏唯一的「等你批准」提示。

替换：改成 AionUi ExplorerContainer 那样的两个 tab，和 TaskPanel 的替换放在同一个提交里。删任务 tab 之前，先确认 W2b-2 的 NavRail 等待标和 StageChat 的「另有 N 个会话在等你批准」提示行都已落地。守卫：renderer-shell-panels V5（:36-40）改成反向锚，或原位退场并写明理由；renderer-tasks-panel S5（:63-65）同样处理；renderer-workspace-shell 全套、mu6 的工作区三条（:66-68）都要回归。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/WorkspacePanel.vue、/home/user/Deskminis/deskminis/tests/renderer-shell-panels.test.ts、/home/user/Deskminis/deskminis/tests/renderer-tasks-panel.test.ts、/home/user/Deskminis/deskminis/tests/renderer-workspace-shell.test.ts、/home/user/Deskminis/deskminis/tests/renderer-artifacts.test.ts

时机：0.3.0 期间不动：W2b-2 要改 :100，W2b-4 要改 :34-36。和 TaskPanel 的替换一起，放在 W5b 收尾时做。

## [simplify] 右栏默认展开：AppShell.vue:28 是 wsOpen=ref(true)，但 :6 的注释写「默认收起」

理由：注释和实现相反，ui-rebuild-design.md:136 也写的是默认收起。OpenCode 和渐进披露的思路都主张默认收起，但 T6b 之后，工作区绑定入口只在右栏的「文件」tab 里（WorkspacePanel.vue:108）。如果直接改成默认收起，setWorkspace 和 pickWorkspaceFolder 会被藏进二级界面，而 mu6 守卫不会变红，这和 T 波「换壳丢入口」是同一类风险。

替换：0.3.0 只改注释，让它与现状一致，也就是保持展开。「默认收起 + 首个产出物出现时自动展开」放到 W8a，和助手空态一起设计。前提是先把工作区绑定行挪出「文件」tab，比如挪到输入框下方，参照 OpenCode new-session-view.tsx:44-62 放工作区选择器的位置。到时候用 SSR 断言加一条守卫：绑定入口在一级界面可达。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/WorkspacePanel.vue、/home/user/Deskminis/deskminis/tests/mu6-capability-wiring.test.ts

时机：注释订正随 W2b-11 一起做：它在接托盘「切换右栏」IPC 时本来就要改 AppShell 的 wsOpen。行为改动放到 W8a。

## [simplify] 0.3.0 期间唯一允许的一批：三处注释/文案订正，随已排的 W2b 步骤顺带完成

理由：按你定的规矩，0.3.0 期间界面结构不动。这一批只改注释和已排好的文案，不改行为，也不会让任何守卫变红；而且都搭在本来就要改这些文件的止血步骤上，所以和止血没有冲突。除这一批外，没有任何既是纯删除、又有守卫保护、又不与 W2b 冲突的界面裁剪项：TopBar、TaskPanel、WorkspacePanel、Composer、StageChat 都在 W2b 的改动清单里。

替换：三处内容：
1. main/index.ts:129-130 的「符号色随明暗」改成如实描述「当前固定 #808080，W9c 随主题同步」；TopBar.vue:2-3 的 140px 改成 146px。这两处随 W2b-3。
2. AppShell.vue:6 的「默认收起」改成如实描述，随 W2b-11。
3. TerminalPane.vue:63、:108 的「与 agent 共用 shell」，W2b-11 已排。
另外，renderer-settings-modal.test.ts:62 的用例名顺手改掉。

文件：/home/user/Deskminis/deskminis/src/main/index.ts、/home/user/Deskminis/deskminis/src/renderer/src/ui/TopBar.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/TerminalPane.vue、/home/user/Deskminis/deskminis/tests/renderer-settings-modal.test.ts

时机：0.3.0：分别随 W2b-3 和 W2b-11 完成，不单独立步骤。

## [replace] 历史回合里没有结果的工具，被显示成「成功」（StageChat.vue:112 的 ok: r ? r.ok : true）

理由：这不是 OpenCode 的界面件，但它是核验「悬空工具判失败」时发现的界面撒谎。arch 读者以为崩溃后界面会「一直显示运行中」，实际正好相反：历史里没有结果的工具默认 ok:true，显示为成功。loop.ts:677 要等整批工具跑完才写结果，所以 minisd 崩溃后，连已经完成的工具结果也会丢。模型那一侧已经由 pairToolResults（loop.ts:258）补上了「[工具执行被中断，结果未知]」，只有界面还在说假话。

替换：不在运行中的回合里，没有结果的工具显示为「已中断 · 结果未知」，正在运行的回合保持现状，并配一条红测。引擎侧参照 OpenCode 的 failInterruptedTools（core/src/session/runner/llm.ts:119-139,397）：在下一次运行开始时，把悬空工具持久化为「执行被中断」的失败结果，有副作用的调用绝不重跑；这部分放进 W7a（逐个落库）。守卫：renderer-tool-steps.test.ts 加一例。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StageChat.vue、/home/user/Deskminis/deskminis/tests/renderer-tool-steps.test.ts、/home/user/Deskminis/deskminis/src/minisd/agent/loop.ts

时机：需要你拍板。建议并入 W2b-11 的「界面同类假话」，只改渲染端一处，不碰引擎和表结构；但它不在已定的 30 步里，所以需要你点头。引擎侧的持久化放 W7a。

## [keep] 工具步骤组 StepGroup（「已执行 N 步」整组折叠）

理由：它出自 AionUi 的「View Steps」（StepGroup.vue:2），是你选定的形态。OpenCode 的做法是只合并只读探索类工具（message-part.tsx:607-608），写文件和跑命令单独列出。这偏离了整组折叠，而且依赖 W7a 才有的 readOnly 声明，在那之前只能硬编码工具名表。

替换：保持整组折叠，在组头追加「写了 N 个文件 / 跑了 N 条命令」的摘要，数据来自 W7a 的副作用元数据。非 file_edit 工具的原始参数 JSON 收进二级「详情」。守卫：renderer-tool-steps.test.ts:44-56 的两例要调整锚点，不能让非 file_edit 工具展开后一片空白。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/StepGroup.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageChat.vue、/home/user/Deskminis/deskminis/tests/renderer-tool-steps.test.ts

时机：0.3.0 期间不动。放进 W7c，那里已排了回合折叠为「已工作 N 分钟」和各步骤的状态点。

## [keep] 权限确认卡 PermCard（对话流内联，三个按钮 + 倒计时 + 桥双段告知）

理由：不是 OpenCode 的：它是把 OpenMinis 的权限 sheet 改成了内联卡。PermCard.vue:7-13 的三条规矩是：路径逐字显示、倒计时由 minisd 判定、桥操作双段告知。这比 OpenCode 的 dock 安全：OpenCode 的 dock 只列 patterns（session-permission-dock.tsx:63-70），不告诉用户「总是允许」会保存成什么规则。

替换：按 W7b 已定的方案，把卡片停靠到输入区（Composer 用 v-show 保住草稿），形态与 OpenCode 的 SessionPermissionDock、DSH 一致，三条规矩全部带过去。另外补上 V2 的三点：拒绝一张就级联拒绝同会话其余待批；点「本会话允许」后重评同会话其余待批；拒绝时的附言原文写进 tool_result。如果照抄 OpenCode 代码，要在 NOTICES 新开 MIT 改编节（目前没有 OpenCode 条目）。守卫：renderer-permcard，以及 W4b 的 ssr-permcard。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/PermCard.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageChat.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/Composer.vue、/home/user/Deskminis/deskminis/tests/renderer-permcard.test.ts

时机：0.3.0 期间只做 W2b-2（按会话过滤），形态不动；停靠改造在 W7b。

## [keep] 改动清单（WorkspacePanel 的「改动」tab + lib/artifacts/collect.ts）

理由：cowork 用户最关心「agent 给我做出了什么」，这张清单就是入口。OpenCode 的对应物是 git 差分审阅加行内评论，非 git 目录还会引导用户「创建 Git 仓库」（i18n/en.ts:682-686），对 cowork 用户是错误引导，不借。

替换：可选：把 tab 名从「改动」改成「产出」。shell 命令改动的文件目前看不到（collect.ts:40-42 只认三种写工具），这个问题交给 W8b：每回合一张改动卡，加写前检查点，参照 ZCode 的 file-rewind 区分可安全回退与不可回退。守卫：renderer-artifacts，renderer-shell-panels 的 V5b。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/WorkspacePanel.vue、/home/user/Deskminis/deskminis/src/renderer/src/lib/artifacts/collect.ts、/home/user/Deskminis/deskminis/tests/renderer-artifacts.test.ts

时机：不动，增强放在 W8b。

## [keep] 输入卡辅助：斜杠技能菜单、@ 文件引用、输入历史

理由：斜杠菜单出自 OpenMinis，@ 文件和输入历史出自 AionUi，都不是 OpenCode 的。OpenCode 输入框 V2 有一处做法值得借：交互逻辑抽成纯函数 transitionPromptInputV2，并配有 machine.test.ts。它的「!」进 shell 模式是程序员习惯，不借。

替换：把 Composer.vue 里 / 和 @ 的交互逻辑抽成 lib/composer/machine.ts 纯函数，配 vitest，零依赖，也方便修重入类竞态。两个菜单的外壳统一，参照 AionUi 的 MentionMenuShell。守卫：renderer-pool.test.ts:49-63、composer-at-files、renderer-composer。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/Composer.vue、/home/user/Deskminis/deskminis/src/renderer/src/lib/composer/at-files.ts、/home/user/Deskminis/deskminis/src/renderer/src/lib/composer/history.ts、/home/user/Deskminis/deskminis/tests/renderer-pool.test.ts、/home/user/Deskminis/deskminis/tests/composer-at-files.test.ts、/home/user/Deskminis/deskminis/tests/renderer-composer.test.ts

时机：0.3.0 期间不动：W2b-3、W2b-4、W2a-6 都在改 Composer。W7a 把 QueueDock 放进 Composer 时顺带做，同属一个耦合簇。

## [keep] 渲染端事件层（stores/chat.ts、rpc.ts）

理由：这里没有 OpenCode 的代码，也不该引入。OpenCode app 的 reducer 用的是 vendored client 里的 session.execution.* 事件名，与内核发出的 session.next.* 不一致（app/package.json:57；server-session-v2-reducer.ts:29-32,323-330）；它还在前端把 V2 投影消息再归一回 V1 模型（utils/session-message.ts:48-120），多了一整层兼容代码。照搬只会跟着它一起漂移。

替换：W6b/W6c 自己定一套封闭的事件词表，必须包含执行开始/成功/失败/中断、已安排重试、压缩失败这几项，这正是 OpenCode UI 需要而内核缺的。按会话键控的纯 reducer 以 AionUi 的 conversationRuntimeViewStore.ts 为形；帧合批放在 W9a。守卫：W6c 验收里的 event-channel-diff（渲染端订阅的每个事件名都有发送方）。

文件：/home/user/Deskminis/deskminis/src/renderer/src/stores/chat.ts、/home/user/Deskminis/deskminis/src/renderer/src/rpc.ts

时机：0.3.0 期间只做 W2b 的断连结算与横幅；重写在 W6b/W6c。

## [keep] 其余都保留：三栏外壳 AppShell、NavRail、欢迎页 + ModelBar、会话舞台、产出物预览主舞台 + OfficeView、UiDiff、EventNotes、ThinkBlock、AnnoLayer、助手、定时、市场、设备、设置、会话搜索

理由：逐件溯源都不是 OpenCode 的：
- UI 审计定的三个基准是 Codex、WorkBuddy、OpenMinis（ui-audit.md:7-13）；
- THIRD-PARTY-NOTICES 没有 OpenCode 条目；
- src/ 和 tests/ 里 grep 不到 opencode；
- 插件市场调研里，OpenCode 因为「没有机器可读的市场」被排除。
这些部件就是 AionUi 和 cowork 的形态。OpenCode V2 砍掉侧栏、改用 Home 页加标签页（settings.tsx:60-63），与 AionUi 的形态冲突，不学。

替换：各自的增强都已排期：
- NavRail 的「等待 > 运行 > 未读」三级徽标：W7b；
- EventNotes 接手停止原因，并在对话流里插入「已切换模型」「已压缩」这类轻量分隔行（参照 OpenCode 的消息联合 session-message.ts:196-213）：W5b/W7c；
- 预览里的「用系统程序打开」：W8a；
- 可拖分栏：W9b；
- 正文搜索：W8c。

文件：/home/user/Deskminis/deskminis/src/renderer/src/ui/AppShell.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/NavRail.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageWelcome.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageChat.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/PreviewPane.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/OfficeView.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/EventNotes.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageAssistants.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageCron.vue、/home/user/Deskminis/deskminis/src/renderer/src/ui/StageSettings.vue

时机：不动。
