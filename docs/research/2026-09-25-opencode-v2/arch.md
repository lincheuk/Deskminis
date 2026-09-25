# 附录 A：OpenCode V2 底层架构（阅读者原稿）

结论先说：OpenCode 的「V2」不是上次研究之后才出现的新重写。上次研究是 2026-07-27 读的 1.18.5，当时已经读到 packages/core 这套 V2 内核，包括事件溯源、两层循环、session_input、context epoch 和 PermissionV2。schema-changelog 里的契约变更集中在 2026-06-03 到 06-26，都早于上次研究。这次的参考仓库是浅克隆，只有一个提交，没法逐版 diff，所以「变了什么」只能拿上次的每条说法逐条去核现在的源码。

**落地情况。** 1.18.32 真正发行出去的 opencode 二进制和桌面/网页 app 跑的仍是 V1 循环：默认走 AI SDK 的 streamText，原生 @opencode-ai/llm 要设 OPENCODE_EXPERIMENTAL_NATIVE_LLM 才启用。V2 runner 只有三条入口能碰到：/api/session/* 路由、实验 CLI lildax、sdk-next 内嵌模式。specs/v2/todo.md 开篇也承认 V2 还没 launch。

**V2 真正值得当基准的，是几套数据模型和边界法则：**
- 单写者事件表，投影和追加在同一个事务里完成；
- durable 事件和 live-only delta 分成两路，按 seq 续传，另有有限分页的 history；
- 准入和投递分开：session_input 收件箱加 steer/queue 两种投递，带幂等回执；
- 进程崩溃后，悬空的工具调用判失败，不重放；
- System Context 由带 key 的源组成，基线不可变，之后的变化作为按时间排列的更新消息追加（直接关系到提示缓存能不能命中）；
- 工具协议：注册时命名、编解码边界、在注册表统一截断、stale 守卫；
- 压缩：单个隐藏检查点，provider 原生块不跨过这个边界，上下文溢出只补救一次。

**V2 没做或做得弱的地方：**
- 仍是半成品：compact/wait/shell/skill 返回 503；retried、tool.progress、compaction.delta 这几个事件有定义但没有地方发；Step.Ended 的 cost 固定写 0；V2 runner 只接了 3 条 provider 路由，没有模型降级，也没有 loop 级的重试、超时和状态记录。
- todo/计划这块很弱：整表替换，用的是非持久事件。
- 权限还有旧洞：模型写的原始命令被存成通配规则，默认 `* * allow`。
- 新发现一个问题：用户拒绝时写给模型的纠正意见（CorrectedError）被各工具的 mapError 吞掉了，模型收不到。
- 新发现 UI 契约分叉：app 依赖的 vendored client 用 session.execution.* 这套事件名，仓内内核发的却是 session.next.*。

**对 DeskMinis 的建议：**
- **可以裁。** 渲染层不照搬 OpenCode 的事件名、reducer 和状态机。渲染层里查不到 OpenCode 署名代码，裁剪没有许可负担。
- **引擎层按「形状」借。** 零依赖可以做到：better-sqlite3 的同步事务比 Effect 更容易保证原子性。
- **分三批。** 发版前只做止血：悬空工具判失败、max-turns 收尾回合。发版后第一个引擎波做事件表、seq 续传和收件箱插话/排队。再往后做 System Context、AGENTS.md 和回退。
- **按领域选基准。** 会话/事件/压缩/工具协议以 OpenCode V2 为主。todo/计划、工具副作用调度、压缩熔断、UI 状态同步取 ZCode 或 AionUi。provider 降级、重试、看门狗和中文 token 估算，DeskMinis 现有实现比 V2 更完整，不要倒退去对齐它。

## 发现

### 前提更正：V2 早就在上次研究范围内；1.18.32 实际在跑的仍是 V1（相关度 5，总判/落地面）

上次研究（2026-07-27，1.18.5）已经读过 packages/core 的事件溯源、两层 runner、session_input、context epoch、PermissionV2。schema-changelog 的契约变更日期在 06-03～06-26，都早于上次研究，是 feat/opencode-embedded-api 分支合入的成果。本次参考仓库是浅克隆，只有一个提交，无法逐版 diff。1.18.32 的现状：发行的 opencode 二进制默认仍走 AI SDK streamText，原生 LLM 需设 OPENCODE_EXPERIMENTAL_NATIVE_LLM 才启用；V2 路由挂在旧 server 的 /api/* 下，但 app 看到 /global/health 就判为 v1；仓内新 server 的 /api/health 只返回 {healthy:true}、不带 pid，也会被判成 v1。V2 runner 的真实入口只有 lildax 实验 CLI 和 sdk-next 内嵌。todo.md 开篇写的是「要 launch v2 才能走出重建期」。

证据：opencode:specs/v2/todo.md:3；opencode:specs/v2/schema-changelog.md:3-31；opencode:packages/opencode/src/effect/runtime-flags.ts:54；opencode:packages/opencode/src/session/llm.ts:224-280；opencode:packages/opencode/src/server/routes/instance/httpapi/server.ts:299-302；opencode:packages/app/src/utils/server-protocol.ts:25-35；opencode:packages/server/src/handlers/health.ts:6；opencode:packages/cli/package.json:7-9；opencode:packages/sdk-next/src/opencode.ts:10-41

对 DeskMinis：把 OpenCode V2 当「底层设计基准」可以，但它是未发布的规格加半成品，不是经过用户验证的行为。借它的数据模型和边界法则，不借「它已经这么跑」的信心。凡是 V2 标为 deferred 或未勾选的项（重试、超时、执行状态、崩溃续跑、并发上限），DeskMinis 现有实现往往更完整，不能倒退去对齐。

### 事件日志：单写者 event 表，投影在同一事务内完成，本地 commit 钩子（相关度 5，事件与持久化）

event_sequence 表（aggregate_id 为主键、seq、owner_id）加 event 表（按 aggregate_id+seq 唯一；type 带版本号，形如 type.N）。commitDurableEvent 在一个 immediate 事务里依次做：读最新 seq、跑全部投影器、跑调用方的 commit(seq) 钩子（用于 context epoch 快照这类不重放的本地状态）、写 sequence 和 event。重放时只接受 seq 恰好等于 latest+1，已存在的 seq 必须 id、类型、数据完全一致，否则判定 Replay diverged。投影器同时覆盖 V1 的 message/part 表（V1 到 V2 的影子桥）和 V2 的 session_message 表。

证据：opencode:packages/core/src/event/sql.ts:4-25；opencode:packages/core/src/event.ts:205-367；opencode:packages/core/src/event.ts:320-323,351；opencode:packages/schema/src/event.ts:109-123；opencode:packages/core/src/session/projector.ts:214-413；opencode:packages/core/src/session/sql.ts:119-137

对 DeskMinis：零依赖可做：better-sqlite3 的 db.transaction() 是同步的，保证「追加事件 + 更新 messages 行」原子比 Effect 版更简单。做法：追加式迁移新建 session_events(session_id, seq, type, data, UNIQUE(session_id,seq))；chat-store 的 appendMessage/updateMessage 改成先写事件、再在同一事务里投影；messages 表继续做读模型，UI 不用动。发版前不动；发版后第一个引擎波就做。现在 messages 是可变记录（db.ts:15-23），LAN 同步也是记录级 diff，越晚改越贵。事件类型从第一天就带版本号。

### durable/ephemeral 双轨 + 按 seq 续传 + 有限 history 分页；全局流有损（相关度 5，事件与持久化 / 协议同步）

text/reasoning/tool-input 的 delta 只发到内存，publisher 在内存里累积，结束时写一次完整值的 ended 事件；DurableDefinitions 里不含任何 delta。sessions.events({after}) 先订阅一个 sliding(1) 唤醒信号，再回放 SQLite，之后每次唤醒重查数据库，所以不会漏也不会重复。HTTP 上 /api/session/:id/event 只推 durable 事件；/history 按 after 分页，默认 50 条、上限 100，返回 hasMore。全局 /api/event 用 Queue.dropping(256)，溢出时直接让流失败，客户端并不知道自己漏了哪些。

证据：opencode:packages/schema/src/session-event.ts:448-519；opencode:packages/core/src/session/runner/publish-llm-event.ts:86-120,254-262；opencode:packages/core/src/event.ts:152-164,565-604；opencode:packages/core/src/session.ts:346-359；opencode:packages/protocol/src/groups/session.ts:320-345；opencode:packages/server/src/handlers/event.ts:9,33；opencode:specs/v2/session.md:175-183

对 DeskMinis：minisd 的 chat.event 广播不带 seq（index.ts:749），重连后只能整页重拉 chat.messages.list。可借：每条 durable 事件带 (sessionId, seq)；新增 chat.events.since({sessionId, afterSeq, limit}) 返回 {events, hasMore}；delta 只广播、不落库、不推进游标；先登记订阅再回放。全局广播可以保持有损，但溢出时必须补发一个「请全量重拉」信号，不能学 OpenCode 直接断流。

### 准入与投递分离：session_input 收件箱 + steer/queue + 幂等回执（相关度 5，会话模型 / 运行器）

prompt() 只发 PromptAdmitted（durable）并写 session_input 行，然后 wake 执行器；id 可由客户端提供，完全相同的重试返回同一份回执，同一 id 配不同内容返回 PromptConflictError。runner 在每个 provider 回合的安全边界，按准入顺序把截止 seq 之前的 steer 输入提升为 Prompted，并把回合计数重置为 1；queue 输入则等会话要空闲时按 FIFO 一次只提升一条，然后重新判断要不要续跑。提升时写入 promoted_seq，和投影在同一事务里完成。

证据：opencode:packages/core/src/session.ts:360-386；opencode:packages/core/src/session/input.ts:41-81,245-288；opencode:packages/core/src/session/runner/llm.ts:187-196,390-413；opencode:specs/v2/session.md:7-41,155-163；opencode:packages/core/src/session/sql.ts:140-165

对 DeskMinis：DeskMinis 运行中直接拒收新消息（index.ts:602「该会话正在运行中」），候选池里的「插话/排队」卡在这里。借法：追加式迁移建 session_inputs(id 由客户端生成, session_id, delivery, admitted_seq, promoted_seq)；chat.prompt 改成「准入即返回回执」；loop.ts 在每回合开始前提升 steer，结束前 FIFO 提升一条 queue。客户端生成 id 后重试天然幂等，还顺带修掉 chat.send 按调用时 activeId 发错会话的技术债。ZCode 的 guide/queue 语义与此同构，可以交叉核对。

### 崩溃恢复：进程丢失后把悬空工具判为失败，绝不重放（相关度 5，运行器循环）

run() 在组装 provider 请求之前，先调 failInterruptedTools：扫描投影历史里仍处于 pending/running 的工具，发 session.next.tool.failed（"Tool execution interrupted"），保留 provider 元数据，保证后续续写请求合法。规格明确写着：被放弃的副作用永远不静默重放；wake 也不会推断模糊状态的 provider 工作可以安全重试。

证据：opencode:packages/core/src/session/runner/llm.ts:119-139,397；opencode:specs/v2/session.md:50,165；opencode:specs/v2/schema-changelog.md（2026-06-03 Embedded Local-Tool Recovery Alignment 段）

对 DeskMinis：这是止血级、发版前就能做的改动。minisd 被杀或崩溃后，messages 里的工具 part 会停在运行态。loop.ts:229 的 pairToolResults 只在请求侧补齐，落库状态不变，界面会一直显示「运行中」。借法：minisd 启动时扫一遍，把未结算的工具调用写成「执行被中断」的错误结果并广播；shell_execute、file_write 这类有副作用的调用绝不自动重跑。

### System Context 源代数 + Context Epoch：不可变基线 + 按时间排列的更新消息（相关度 5，配置与指令加载）

每个源定义为 {key, codec, load, baseline, update, removed?}，load 可以返回 unavailable（与「被删除」不同）。会话首次运行时，观察全部源，渲染出不可变的 baseline 存进 session_context_epoch，结构化快照另存。之后每个安全边界重新观察一次：没变就什么都不做；有变化时，把 update/removed 渲染出的文本作为一条 durable 的 session.next.context.updated 系统消息追加进历史，并在同一事务里推进快照（借助 commit 钩子）。首次观察时只要有源 unavailable 就阻塞，prompt 保持待处理；压缩完成后直接重渲新基线；会话移动位置时清空 epoch。env、日期、AGENTS.md，以及按 agent 权限过滤后的技能清单，都是注册进来的源。

证据：opencode:packages/core/src/system-context/index.ts:21-39,197-291；opencode:packages/core/src/system-context/registry.ts:74-94；opencode:packages/core/src/system-context/builtins.ts:16-42；opencode:packages/core/src/session/context-epoch.ts:40-78；opencode:packages/core/src/session/history.ts:24-53；opencode:packages/core/src/skill/guidance.ts；opencode:packages/core/src/session/runner/llm.ts:168-171,197-198；opencode:specs/v2/session.md:54-109

对 DeskMinis：DeskMinis 在 system 上打了 cache_control，但只要 system 里混进日期、工作区、技能列表或记忆，其中任何一项一变，整段缓存就失效。借法：system 拆成「会话首回合冻结、存库的基线」加「带 key 的源」（env/date/instructions/skills/memory），源的变化作为注记消息追加进历史；只有压缩完成或更换工作区时才重渲基线。这同时解决「技能覆盖是建会话时拍的快照」那条技术债。实现只需 JSON 比较，零依赖。

### 指令文件加载：全局 AGENTS.md + 从工作目录向上找到项目根（相关度 5，配置与指令加载）

InstructionContext 用 fs.up 从 location.directory 向上找 AGENTS.md，找到 project 根目录为止（路径先规范化，越出项目根的不收），再加全局配置目录下的 AGENTS.md，按路径去重。文件发现了但读取失败，整个源判为 unavailable，保留上次已采纳的内容。内容更新时的文案是「These instructions replace all previously loaded ambient instructions」；全部删除时发撤销文案。是否也读 CLAUDE.md、配置里的 instructions 数组、嵌套目录发现，这三项在对照表里都还是 missing。

证据：opencode:packages/core/src/instruction-context.ts:39-73,128-137；opencode:packages/core/src/config.ts:96-98；opencode:specs/v2/session.md:128-131

对 DeskMinis：DeskMinis 全仓没有任何 AGENTS.md/CLAUDE.md 加载（现状画像标为 missing），cowork 用户同样会在工作区里放约定文件。借法：会话绑定 workspaceRoot 后，在 workspaceRoot 内向上查找（不越出绑定目录），再加上 %APPDATA%\DeskMinis 下的全局文件（可与 GLOBAL.md 合并考虑），作为上一条里的一个 context 源。读失败按 unavailable 处理，不当作被删除。是否兼容 CLAUDE.md 由 DeskMinis 自己定，V2 也还没定。

### 规格与落地对照：哪些已落地、哪些只是定义、哪些只是规格（相关度 4，规格 vs 落地）

已落地，但只在 V2 路径上有调用方：事件日志与投影、steer/queue 收件箱、两层 runner、context epoch 与 AGENTS.md、自动压缩和溢出压缩、12 个内置工具、PermissionV2、provider.use 策略、有限 history 分页。只有定义、没有发出方：session.next.retried（投影器已注释掉）、tool.progress（只有投影器）、compaction.delta（message-updater 里是空操作）、compaction 的 reason 值 "manual"。接口在但未实现：Session.compact/wait/shell/skill 返回 OperationUnavailable，而 HTTP 路由 /compact、/wait 已经暴露，调用会得到 503。只有规格：api.html 里的 config/mcp/vcs/workspace/auth/session.todo/delete 路由，protocol 里都没有；api.html 的事件信封 {time,context,payload} 与实现的 {data,durable,location} 不一致；delivery 在 api.html 里是 immediate|deferred，代码里是 steer|queue；config.md 标为 remove 的 default_agent 和 commands 仍在代码里被消费。明确延期：provider 超时与看门狗、崩溃后续跑、工具并发上限、后台 bash、迁移的跨进程锁。另外 Step.Ended 的 cost 固定写 0。

证据：opencode:packages/core/src/session.ts:387-424；opencode:packages/server/src/handlers/session.ts:184-190；opencode:packages/protocol/src/groups/session.ts:226,241；opencode:packages/core/src/session/projector.ts:387,392；opencode:packages/core/src/session/message-updater.ts:376；opencode:packages/core/src/session/runner/llm.ts:43-91,338；opencode:specs/v2/api.html:923,1068；opencode:specs/v2/config.md:43,245；opencode:packages/core/src/config/plugin/agent.ts:74；opencode:packages/core/src/config.ts:93；opencode:specs/v2/session.md:153,165,173；opencode:specs/v2/todo.md:123

对 DeskMinis：今后 DeskMinis 设计稿凡写「对齐 OpenCode V2 的 X」，必须同时注明 X 的状态（已落地 / 只有定义 / 只是规格）和代码路径，不能直接引 specs/v2 的文字。尤其 provider-model.md 和 api.html 已经过时。

### 运行器循环：两层循环、每回合一次 stream、工具急切执行、续跑前重载历史、到顶收尾（相关度 4，运行器循环）

外层循环按 steer 和 queue 调度，内层按 needsContinuation 走。每个 provider 回合只调一次 llm.stream，needsContinuation 取决于有没有收到非 provider 执行的 tool-call，与 finish_reason 无关。每个完整的工具调用先 durable 落库，再在 FiberSet 里立即开跑；流结束后等全部工具结算完，重新读投影后的历史，再进下一回合。到达 agent.steps 上限时，最后一回合传 tools:[]、toolChoice:none，并追加 MAX_STEPS_PROMPT 让模型收尾。用户拒绝权限或问题会直接中断循环，不把拒绝当成工具结果交给模型。

证据：opencode:packages/core/src/session/runner/llm.ts:173-355；opencode:packages/core/src/session/runner/llm.ts:202-221,250-278,303-308；opencode:packages/core/src/session/runner/max-steps.ts:1-16；opencode:specs/v2/session.md:50

对 DeskMinis：loop.ts 本来就是等价的回合循环。可以直接借两点：(1) 达到 maxTurns 时发一轮不带工具的收尾回合，让模型总结已完成的工作，而不是 yield「已达最大回合数」（loop.ts:686）；这点发版前就能做。(2) 工具结果全部落库后，从库里重载历史再进下一回合。不要借「无上限急切并发」，见反面清单。

### 工具协议：不透明 Tool、注册时命名、编解码边界、注册表统一截断、stale 守卫（相关度 4，工具协议）

Tool.make 返回一个冻结的空对象，行为放在模块级 WeakMap 里，名字在 register 时由记录的 key 给出。输入解码失败不会调用 execute，输出编码失败也不会产生 success。截断统一在注册表结算时由 ToolOutputStore 做（2000 行 / 50KB，超出落盘，给首尾预览加 outputPaths），工具本身返回完整的领域输出。materialize 时记录每个名字对应的注册身份（identity），结算时身份不一致就返回 "Stale tool call"。执行期上下文只有 sessionID、agent、assistantMessageID、toolCallID。规格还写明：ToolFailure、中断、缺陷三者不能混用，不许宽泛地捕获 cause。

证据：opencode:packages/core/src/tool/tool.ts:9-132；opencode:packages/core/src/tool/registry.ts:42-125；opencode:packages/core/src/tool-output-store.ts:13-16；opencode:specs/v2/tools.md:40-56,130-170

对 DeskMinis：tools/registry.ts 可以借三条法则，不借 Effect Schema：(1) 名字在注册时给定，MCP 工具天然适配；(2) 入参校验不过就不调用 handler；(3) 截断和落盘只在注册表的结算边界做一次，把 offload.ts 从各工具挪到统一出口。另外借 stale 守卫：每回合记下已经发给模型的「工具→注册实例」，MCP 服务在回合之间重连或换了工具时，旧调用返回错误，不执行新实现。

### PermissionV2 的进步（可借）：配置 deny 先判、缺 agent 全拒、拒绝级联、always 顺带放行兄弟请求（相关度 4，权限）

evaluateInput 先只用 agent 配置的规则判 deny，命中就直接拒；没命中才并入项目级已保存的放行规则，统一 findLast，默认 ask。解析不到 agent 时用 [*,*,deny]。reply 为 reject 时，同会话其余待批请求全部级联拒绝；带附言则抛 CorrectedError。reply 为 always 时，保存规则后重新评估其余待批请求，满足的自动放行并广播。其中「配置 deny 先判」上次研究已记录；缺 agent 全拒、拒绝级联、always 连带放行是本次新读到的。

证据：opencode:packages/core/src/permission.ts:15,137-162；opencode:packages/core/src/permission.ts:231-247；opencode:packages/core/src/permission.ts:250-283；opencode:packages/core/src/permission/saved.ts:54-69

对 DeskMinis：DeskMinis 工具并发 10 路（loop.ts:62），一次可能弹出好几张权限卡。可借两点：「拒绝其中一张 = 本会话其余待批全部拒绝并停止循环」，以及「点了总是允许后，自动重评其余待批」。「保存的放行永远压不过配置的 deny」和 DeskMinis 的 danger 层硬拦立场一致。按项目作用域保存规则可以借，但要配一个可见、可撤销的规则列表，OpenCode 至今没有这个 UI。

### PermissionV2 仍没修的洞（不可借）：原始命令存成通配规则、默认全放行、拒绝附言被吞（相关度 4，权限）

bash 仍以 save:[input.command] 把模型写的原始命令存成规则；Wildcard.match 把 * 转成 .*（s 标志，Windows 下还不区分大小写）。默认 agent 的规则是 {*,*,allow}。新发现：PermissionV2.assert 只把 DeclinedError 转成 defect，CorrectedError（用户拒绝并附言）和 BlockedError 仍是 typed error，而 bash/edit/write/read/grep/webfetch 都用 mapError 一律改写成「Unable to …」的 ToolFailure。结果是用户写给模型的纠正意见和被 deny 的规则信息都到不了模型，这也违背了 tools.md 自己写的「不许宽泛吞错」法则。

证据：opencode:packages/core/src/tool/bash.ts:142-148,196；opencode:packages/core/src/util/wildcard.ts:3-14；opencode:packages/core/src/plugin/agent.ts:109；opencode:packages/core/src/permission.ts:62-67,208-210；opencode:packages/core/src/tool/edit.ts:110-118；opencode:packages/core/src/tool/write.ts:88；opencode:specs/v2/tools.md:170

对 DeskMinis：如果 DeskMinis 做「拒绝时附一句话给模型」（ZCode 有这个功能），要保证附言原文进入 tool_result，并把「被拒 / 被纠正 / 执行失败」做成三种不同的结果类型，不要在工具层统一 catch 成一句「执行失败」。「总是允许」也不要保存原始命令，只存结构化的精确匹配记录。

### 压缩：整请求估算 + 绝对余量；单个隐藏检查点；provider 原生块不跨边界；溢出只补救一次（相关度 4，压缩）

每个回合前把 {system, messages, tools} 序列化后估算 token，与 context − max(输出上限, buffer) 比较（buffer 默认 20000，保留原文 8000 token）。触发后，把历史压平成文本，最近约 8000 token 原样保留，其余交给模型按固定 Markdown 模板总结；已有旧摘要时，把旧摘要作为 <prior-summary> 一起合并。compaction.started 和 ended 是 durable 事件，只有 ended 才会投影成可见消息；失败时保留上一个边界。检查点渲染成一条 <conversation-checkpoint> 用户消息，边界之前的 provider 原生 reasoning/tool 块全部不再回放。provider 报上下文溢出、且还没有任何 durable 输出时，做一次压缩重跑；第二次溢出直接失败。代码默认值与 config.md 示例（keep 2000 / buffer 10000）不一致。

证据：opencode:packages/core/src/session/compaction.ts:12-55,137-174,176-243；opencode:packages/core/src/session/runner/to-llm-message.ts:145-163；opencode:packages/core/src/session/runner/llm.ts:222-223,289-295,362-388；opencode:specs/v2/session.md:111-121；opencode:specs/v2/config.md:354-372；opencode:packages/core/src/util/token.ts:3-5

对 DeskMinis：DeskMinis 的 compact.ts 已有摘要标记和每次运行最多压 3 次的上限（loop.ts:391）。可借三点：(1) 滚动更新摘要，把旧摘要和新对话一起合并，而不是每次从头摘；(2) 检查点之后不回放 provider 原生的思考和工具块——DeskMinis 以后打开 Anthropic 原生思考时，签名块跨过边界会触发 400；(3) 溢出且尚无输出时补救一次，第二次直接失败。不借 chars/4 的估算，DeskMinis 的 CJK/1.6 对中文更准（context-policy.ts:22）。熔断和分层压缩以 ZCode 为基准。

### V2 面向 UI 的事件词表自身分叉：内核发 session.next.*，app 依赖 session.execution.*（相关度 4，协议与客户端同步 / UI 裁剪）

packages/app 依赖的是 vendored tarball @opencode-ai/client 1.17.13（仓库地址 anomalyco/opencode），不是仓内的 packages/client。它的事件词表是 session.input.admitted/promoted、session.execution.started/succeeded/failed/interrupted、session.retry.scheduled、session.compaction.admitted/failed、session.forked、session.instructions.updated、session.skill.activated；app 的 V2 reducer 按这套名字写。仓内内核的 DurableDefinitions 只有 session.next.*，没有 execution 生命周期事件，runner 清单里「durable 地标记 busy/retrying/idle/interrupted/失败」也还没勾。上次研究只注意到这个 tarball 读不了，没比对词表。

证据：opencode:packages/app/package.json:57；opencode:packages/app/vendor/opencode-ai-client-1.17.13-v2.tgz → dist/promise/generated/types.d.ts:1901-1954,3024-3034；opencode:packages/app/src/context/server-session-v2-reducer.ts:29-32,323-330；opencode:packages/schema/src/session-event.ts:448-477；opencode:packages/core/src/session/runner/llm.ts:52

对 DeskMinis：用户问能不能裁掉和 OpenCode 相关的 UI：可以裁，而且 Vue 渲染层不应照搬 OpenCode 的事件名、reducer 和会话状态机，它自己的 UI 契约还没定下来。渲染层 grep 不到 OpenCode 署名代码，裁剪没有许可负担。但这套 app 词表反过来说明了 UI 真正需要、内核还没有的东西：durable 的执行生命周期（开始/成功/失败/中断）、已安排重试、压缩失败。DeskMinis 定自己的封闭事件词表时要把这几项放进去，用来解决「重连后不知道会话是否还在跑」。

### 单会话串行协调器：run 加入已有执行、wake 合并唤醒、interrupt 保留收件箱（相关度 3，运行器循环 / 并发）

SessionRunCoordinator 每个 key 只允许一次 drain：run 在空闲时启动，否则等待当前那次；wake 在运行中只置 pendingWake，当前 drain 结束后自动再跑一次；interrupt 只停本进程的 fiber，并清掉已合并的 wake，不删 durable 收件箱。sessions.active() 只是进程内快照，重启后为空。

证据：opencode:packages/core/src/session/run-coordinator.ts:51-104；opencode:packages/core/src/session/execution/local.ts:14-36；opencode:specs/v2/session.md:167-171

对 DeskMinis：minisd 现在用 inFlight Set 做互斥。有了收件箱之后需要 wake 语义：准入后只「叫醒」，运行中则挂一个待续标记，结束后自动再跑一轮。约 60 行纯 TS 可以重写，不需要 Effect。「停止」只停当前执行、不删已准入的排队消息，这点要在 UI 上说清楚。

### Provider/模型：llm 包按 Protocol×Endpoint×Auth×Framing 组合路由，但 V2 runner 只接了 3 条，也不降级（相关度 3，provider/模型抽象）

@opencode-ai/llm 有 6 种协议，新增了 OpenAI Responses 的 WebSocket 传输；执行器层 MAX_RETRIES=2、500ms 起步、10s 封顶、支持 retry-after，错误信息先按字段名、再按请求里实际发过的密钥原值两遍脱敏，响应体截到 16KB；缓存策略默认 auto，打 3 个断点。V2 runner 的 fromCatalogModel 只支持 aisdk 的 @ai-sdk/openai（走 Responses）、@ai-sdk/anthropic、@ai-sdk/openai-compatible（须带 url）三种，没有 native 分支；与 provider-model.md 列的 native endpoint 不符。选不到模型就报 ModelUnavailable，没有降级。历史里的 reasoning 和 provider 元数据只在「同一模型续写」时回放。请求头带 x-session-affinity，OpenAI 带 promptCacheKey。

证据：opencode:packages/llm/src/route/protocol.ts；opencode:packages/llm/src/protocols/openai-responses.ts:1004-1013；opencode:packages/llm/src/route/executor.ts:35-72,94-97；opencode:packages/llm/src/cache-policy.ts:5-34；opencode:packages/core/src/session/runner/model.ts:131-176,186-210；opencode:packages/core/src/session/runner/to-llm-message.ts:71-80；opencode:packages/core/src/session/runner/llm.ts:204-214；opencode:specs/v2/provider-model.md:270-284

对 DeskMinis：DeskMinis 在这一层比 V2 runner 完整：4 类 provider、模型组降级、3/5/10/15/30 秒重试梯、60 秒空闲看门狗（sse.ts:8），不要去对齐。可借三点：(1) 降级换模后，旧模型的思考签名和加密元数据降为普通文本，不再回放；(2) 请求带会话亲和键和缓存键；(3) provider 错误落库和上屏之前做两遍脱敏——DeskMinis 的降级卡直接显示原始报文，这里是泄漏点。usage 的规范化不变式（nonCached+cacheRead+cacheWrite=input）可以直接用在用量和成本展示上。

### 配置：单一 schema、键名复数、统一 disabled、permissions 是有序数组、mcp.servers 带双超时；但加载器静默吞错且只读一次（相关度 3，配置）

config.md 逐组评审旧字段，代码里的 Config.Info 基本按评审落地：command 并入 skills、permissions 用有序的 {action,resource,effect} 数组、删掉 tools 布尔表、mcp.servers 带 timeout.startup/request、compaction 改为 keep.tokens 加 buffer、instructions 是一个路径/URL 数组。文件名只认 opencode.json/jsonc，按「全局 → 项目直读文件 → .opencode 目录」排优先级。问题：JSONC 解析出错或 schema 解码失败时，这个文件直接当不存在；配置只在 location 打开时读一次；default_agent 和 commands 虽被标为 remove，仍在代码里使用；instructions 字段没有任何消费方。

证据：opencode:specs/v2/config.md:16,43-46,245-249,354-372；opencode:packages/core/src/config.ts:29-107,151-160,175-203；opencode:packages/core/src/config/plugin/agent.ts:66-110

对 DeskMinis：servers.json 可以对齐 mcp.servers 的结构，并加上启动超时和请求超时两档；「命令」不单独做配置、归入技能，与 DeskMinis 技能优先的方向一致。反面要避开：配置坏了就当不存在——DeskMinis 已经踩过「servers.json 坏了显示成空列表」这种界面撒谎，应显式报「配置损坏 + 路径 + 行号」。

### Todo/计划：V2 很弱，这一块改用 AionUi/ZCode 当基准（相关度 3，todo/计划）

SessionTodo.update 先删后插整张表，发的 todo.updated 是非 durable 事件，不进会话事件日志；todowrite 用整表替换语义，其权限检查失败同样会被 mapError 吞掉；protocol 里没有读 todo 的路由（api.html 列的 session.todo 没实现）。plan 只是一个把 edit 设为 deny（只放行 plans/*.md）的 agent，plan_exit 尚未移植。

证据：opencode:packages/core/src/session/todo.ts:32-57；opencode:packages/schema/src/session-todo.ts:6-24；opencode:packages/core/src/tool/todowrite.ts:14-50；opencode:packages/core/src/plugin/agent.ts:133-147；opencode:packages/core/src/tool/builtins.ts:26-29；opencode:specs/v2/api.html（session.todo 行）

对 DeskMinis：计划和 Todo 的基准取 AionUi（计划条钉在输入框上方、全量快照、确定性 id、重开会话时回捞）和 ZCode（计划与权限档正交、计划审批复用权限卡、Todo 提醒节流），不取 OpenCode。能从 V2 借的只有「todowrite 整表替换」这一模型语义；但要把它做成会话 durable 事件、进事件表，否则重连或同步之后计划条会丢。

### 协议与客户端：以 HttpApi 为唯一来源生成 OpenAPI 和双客户端；内嵌模式走同一协议；前端 store 按上下文分区（相关度 3，协议与客户端同步）

18 个 HttpApiGroup 由 server 组装；packages/client 由 codegen 生成 promise 和 effect 两套客户端（client.ts 1029 行），CI 检查生成物是否漂移。sdk-next 把 createEmbeddedRoutes 包成一个假 fetch，内嵌到同进程里跑同一套客户端。api.html 把操作分三类：server 级；按请求上下文（directory+workspace）；按会话钉定（会话方法不接收上下文参数，由服务端从会话行解析）。前端单一 SyncStore 按 contextKey 分区，持久实体按各自 ID 建键。

证据：opencode:packages/protocol/src/groups/session.ts；opencode:packages/server/src/routes.ts；opencode:packages/client/package.json（check:generated 脚本）；opencode:packages/client/src/generated/client.ts；opencode:packages/sdk-next/src/opencode.ts:10-41；opencode:specs/v2/api.html（Context Model / Operation Inventory / Frontend Sync Store 段，:1100 起）

对 DeskMinis：DeskMinis 不引 Effect，也不做 codegen（零依赖）。可借两点设计：(1) RPC 分成服务器级、工作区级、会话钉定三类，会话方法只收 sessionId、由 minisd 从会话行解析工作区，不再同时收路径参数，从结构上减少越权面；(2) 渲染端单一 store 按上下文分区、实体按 ID 建键，这是拆分 stores/chat.ts（627 行）的方向。JSON-RPC over WebSocket 本身不用换。

### 回退：git 影子快照 + 回合级改动文件 + stage/clear/commit 三段式（相关度 3，会话模型 / 改动追踪）

每个 provider 回合开始前抓一次 snapshot；回合结束时再抓一次，求出本回合改动的文件列表，写进 Step.Ended。revert.stage 把目标消息之后各回合改动的文件恢复到对应回合开始时的树，生成 diff，发 RevertEvent.Staged（可撤回）；clear 恢复原状；commit 才真正截断历史。snapshot 依赖 git。

证据：opencode:packages/core/src/session/runner/llm.ts:224,323-343；opencode:packages/core/src/session/revert.ts:27-121；opencode:packages/core/src/snapshot.ts:43-60；opencode:packages/schema/src/session-event.ts:433-446

对 DeskMinis：DeskMinis 没有检查点和撤销，「改动」面板也看不到 shell 改的文件。可借这个形状：回合前后各抓一次工作区状态，把「本回合改动了哪些文件」记进回合结束事件，顺带解决 shell 改动不可见的问题；回退做成 stage → clear/commit 三段，可撤回。实现不能照搬 git：cowork 场景的工作区常常不是 git 仓，应改用写前文件副本加 hash 校验（ZCode 的写前检查点更贴近），零依赖可做。

### Catalog 可重放 transform + 策略最后生效；provider-model 规格已和代码漂移（相关度 2，provider/模型抽象 / 配置）

Catalog 用 State.transform 管理插件、配置、models.dev、凭据各自注册的变换；有变化就把所有 transform 按注册顺序重放一遍，最后应用 provider.use 策略（deny 的 provider 直接移除），再发 Catalog.Updated。策略只有 allow/deny，findLast 取最后一条匹配，默认 allow；读取时把配置文档倒序，保证用户全局规则能压过仓库规则。规格选的是 option B（Catalog transforms），热重载尚未设计。provider-model.md 里的 Schema（endpoint/enabled/options）已经过时，代码实际是 api:native|aisdk、disabled、request、integrationID。

证据：opencode:packages/core/src/catalog.ts:63-170；opencode:packages/core/src/policy.ts:17-45；opencode:packages/core/src/config.ts:204-211；opencode:specs/v2/provider-policy.md:81-86,159,200；opencode:specs/v2/catalog-config-plugin-lifecycle.md:3；opencode:packages/schema/src/provider.ts:26-61

对 DeskMinis：provider-store 可借「目录 = 有序、可撤销的 transform 重放结果」：models.dev 元数据、用户自定义、凭据可用性各是一个 transform，任何一个变了就整体重算并广播 providers.changed，不再到处就地修改。provider.use 这类组织级策略对个人桌面应用价值低，暂不做。引用 OpenCode provider 模型时以 schema/src/provider.ts 为准。

### 插件与热重载：规格方向很明确（hook 拿草稿可 cancel、提交后才发事件、一切可热重载），大多还没落地（相关度 2，扩展/生命周期）

instructions.md 要求：核心服务做成小容器，把策略放进插件 hook；hook 接收不可变输入和可变输出（Immer 草稿），带 cancel，按顺序触发；只为已提交的变更发事件。todo.md 的 Plugin API 和热重载两节都还是「???」；config 只在打开时读一次；运行时上下文对照表里，插件对消息、系统提示、参数、请求头的变换都是 missing。

证据：opencode:specs/v2/instructions.md:7,40-50,105,119；opencode:specs/v2/todo.md:76-84,144-146；opencode:packages/core/src/config.ts:175-176；opencode:specs/v2/session.md:137-138

对 DeskMinis：DeskMinis 现在没有插件 API，不急。先记两条原则备用：hook 的输出是可丢弃的草稿、带 cancel；只在提交之后发粒度事件，比如 providers.changed、skills.changed，不为尝试中的操作发事件。Immer 是新依赖，只借原则不借实现。

## 相对上次研究的变化

- 前提更正：上次研究（2026-07-27，1.18.5）已经读到同一套 V2 内核（packages/core、schema、protocol、server、client、llm），当时就把它当作「两代并存里的新一代」来研究。schema-changelog 的契约变更日期（06-03～06-26）早于上次研究。本次参考仓库是浅克隆、只有一个提交，无法逐版 diff，所以「变化」只能靠逐条复核上次的说法。
- 复核后仍成立的上次结论：event_sequence/event 表结构、durable 与 delta 分离、sliding(1) 续传、两层 runner、max-steps 收尾回合、工具输出三通道、stale 守卫、执行器重试与两遍脱敏、配置 deny 先判、bash 保存原始命令、默认 * * allow、外部目录扫描只给告警、12 个 V2 内置工具。
- 上次的说法需修正：上次写「V1 按调用在 AI SDK 与原生 runtime 之间择一」，现在原生 runtime 由 OPENCODE_EXPERIMENTAL_NATIVE_LLM 门控，默认仍走 streamText（runtime-flags.ts:54，session/llm.ts:224-226）。
- 上次未覆盖、本次新读到的：System Context 源代数（key、unavailable、removed、InitializationBlocked）；context.updated 按时间排列的系统消息与基线重渲规则；按 agent 权限过滤的技能指引和 reference 指引作为 context 源；AGENTS.md 向上发现；Policy 的 provider.use 以及「用户全局规则压过仓库规则」的倒序读取；有限 history 分页（hasMore）；failInterruptedTools 崩溃恢复；缺 agent 时全拒；拒绝级联；always 连带放行其余待批；git 快照回退三段式；config.md 逐字段评审；catalog 生命周期选定 option B。
- 新发现的落地缺口：Session.compact/wait/shell/skill 返回 OperationUnavailable（HTTP 层 503）；retried、tool.progress、compaction.delta 只有定义没有发出方；Step.Ended 的 cost 固定写 0；V2 runner 只支持 3 条 provider 路由，没有 native 分支；todo 没有 durable 事件，也没有读取路由。
- 新发现的分叉：app 依赖 vendored 的 @opencode-ai/client 1.17.13（anomalyco/opencode），事件词表是 session.execution.*、session.input.*，与仓内内核的 session.next.* 不一致。上次只注意到这个 tarball 读不了。
- 新发现的反面：CorrectedError（拒绝并附言）和 BlockedError 被各工具的 mapError 吞成「Unable to …」；配置 JSONC 解析或 schema 解码失败时静默跳过该文件；实验性 V2 事件 schema 反复变更，每次都「重置」库里的实验数据。
- 规格文档自身已漂移：provider-model.md 的 Provider/Model Schema、api.html 的事件信封和 delivery 取值、config.md 标为 remove 的 default_agent 和 commands，都与代码不一致，不能把规格当作事实引用。
- 基准分工调整：会话事件模型、准入与投递、System Context、工具协议、压缩边界以 OpenCode V2 为基准；todo/计划、工具副作用调度、压缩熔断、UI 状态同步与流式合并改以 ZCode/AionUi 为基准；provider 降级、重试、看门狗和中文 token 估算，DeskMinis 现有实现比 V2 更完整。

## 反面做法

- 把模型写的原始命令存成通配放行规则：bash 用 save:[input.command]，Wildcard 把 * 转成 .*（s 标志，Windows 下不区分大小写），批准一次 `git add *` 就等于放行了一大类命令（opencode:packages/core/src/tool/bash.ts:142-148；util/wildcard.ts:3-14）。
- 默认 agent 的规则是 {*,*,allow}，整套权限机制开箱即不设防（opencode:packages/core/src/plugin/agent.ts:109）。
- 在工具层把权限错误统一 catch 成「Unable to …」：用户拒绝时写给模型的纠正意见和被 deny 的规则信息全部丢失，也违背了它自己「不许宽泛吞错」的法则（opencode:packages/core/src/tool/bash.ts:196；edit.ts:110-118；write.ts:88；permission.ts:62-67,208-210；specs/v2/tools.md:170）。
- 工具急切执行没有数量上限，也没有单工具超时；规格承认这是「刻意不设界」（opencode:packages/core/src/session/runner/llm.ts:250-278；specs/v2/session.md:173）。DeskMinis 同批工具一律 10 路并发本身也是已知缺陷，应按 ZCode 的思路：只读或声明可并发的工具并行，其余作为屏障按原顺序执行。
- 不设 provider 流的空闲超时和看门狗，流挂住会话就一直挂着（opencode:specs/v2/session.md:153；schema-changelog「Provider Stream Watchdog Policy Deferred」）。DeskMinis 的 60 秒空闲看门狗必须保留。
- 全局事件流有损，溢出时直接让流失败，不告诉客户端漏了哪些（opencode:packages/core/src/event.ts:152-164；packages/server/src/handlers/event.ts:9,33）。
- 配置文件解析失败就当它不存在，属于界面撒谎一类；并且配置只在打开时读一次，与「一切可热重载」的规格相悖（opencode:packages/core/src/config.ts:151-160,175-176）。
- durable 事件 schema 一改就重置用户库里的实验数据（opencode:specs/v2/schema-changelog.md:14-22；specs/v2/session.md:173）。DeskMinis 有真实用户库，只能追加式迁移、给事件类型带版本，绝不能照这样做。
- 协议上先暴露事件和路由，实际没有发出方或没实现：retried 的投影被注释、tool.progress 没人发、compaction.delta 是空操作、/compact 和 /wait 返回 503（opencode:packages/core/src/session/projector.ts:387,392；message-updater.ts:376；session.ts:387-424）。在 DeskMinis 里，这会让 UI 渲染出永远不会出现的状态。
- 成本固定写 0（opencode:packages/core/src/session/runner/llm.ts:338），token 估算用 chars/4、不区分 CJK（util/token.ts:3-5）。这两块不能拿 V2 当基准。
- 用「抛 defect 再 catchDefect」当 goto 控制压缩后的重跑（opencode:packages/core/src/session/runner/llm.ts:152-166,362-388）。这是 Effect 特有的写法，在普通 TS 里模仿成抛异常控制流会让逻辑难以追踪，应改用显式的返回状态。
- UI 契约与内核事件词表分叉：app 依赖 vendored client 的 session.execution.*，内核发的是 session.next.*（opencode:packages/app/package.json:57；packages/schema/src/session-event.ts:448-477）。渲染层照搬这套事件名只会跟着它漂移。
- 数据库迁移只有进程内信号量，两个进程同时开同一个库时会竞争（opencode:packages/core/src/database/migration.ts:11,19；specs/v2/todo.md:123）。DeskMinis 的 CLI（pair/sync）与 minisd 同时打开 minis.db 时，要有同样的防护意识。
- 规格文档与代码漂移，却被当作权威引用（opencode:specs/v2/provider-model.md 对照 packages/schema/src/provider.ts:26-61；specs/v2/api.html:923,1068）。