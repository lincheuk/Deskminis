# dsh:verify
总述：DeepSeek Harness（DSH，仓库 /home/user/refs/deepseek-harness，HEAD 46a7f68b0，0.1.7-rc.1，2026-09-23）是一个基于 vendored Cordis 插件框架的 agent 平台。服务按 ctx 键注入，每项能力拆成 Definition、Provider、Consumer 三个角色；会话是追加式的类型化事件日志，模型历史由 surface 折叠派生，并有「模型可见即落盘」这条运行期不变量。基线 a0bfc2c3fe（2026-08-20，0.1.0-rc.8）当时只有 CLI 和 Web 两端，基线报告也只读了插件与市场层。之后五周共 6717 个提交、14273 个文件变化，packages/ 下 package.json 从 233 增至 316，打了 20 个 dsh-v 标签。

基线后的主要变化：
- 新增 Electron 桌面端（apps/desktop、desktop-host）：RunAsNode 方式拉起 Host，生命周期协议 v4，另有单实例锁、原生致命恢复与崩溃报告、带准入锁的更新、webview 侧栏浏览器。
- 会话存储：删除 SQLite 后端，只保留 JSONL，并建立 v0→v4 的相邻迁移链。
- 插件层补成完整产品面：插件管理器、热重组、npm 源计划、事务化安装，设置统一到 profile。
- 新增交付物组（present 与 git 快照改动卡）、浏览器与桌面操控注册位、SSH 执行世界、PTC 沙箱运行时、实验性 Auto review。
- Windows 写沙箱加上 Low 完整性标签和拒删子项。
- agent-loop 新增持久 inbox、系统提示作为 surface 节点 0、工具调用三阶段。
- session-log-deepseek 默认开启：会把完整会话日志附在官方 DeepSeek API 请求里上传，这是需要警惕的隐私立场。

agent 能力层的 goal、plan、todo、jobs、subagent、workflow、schedule 大多在基线时已经存在，这次是首次细读。

对照 DeskMinis，经静态读码核实的实缺陷有：
- 压缩输入无上界，且不复用缓存；
- 400 一律归为可降级，上下文溢出因此被当成「请求被拒」处理；
- 卸载桩指示用 file_read 取回，读回的全文会被再次卸载；
- minisd 握手成功后如果崩溃，没有任何处理，渲染端 rpc 没有 onclose；
- 没有单实例锁，也没有窗口导航与新窗口守卫；
- 启动时不恢复已保存的主题；
- 删除正在运行的会话前不中止运行；
- 子进程继承完整环境变量；
- MCP 密钥以明文写入 servers.json；
- 路径围栏未做 realpath 规范化。

这些都能零依赖修补，但尚未在 Windows 真机上验证。

要点变化：
- 桌面端全新：apps/desktop（首提 19444907f，author 08-28、合入 08-31）与 desktop-host（09-04）。Electron 以 ELECTRON_RUN_AS_NODE 拉起 Host，生命周期协议版本为 4（host-protocol.ts）；另有单实例锁、setWindowOpenHandler/will-navigate/右键菜单守卫、原生致命恢复对话框与崩溃报告（09-15/09-22）、更新前的 inspect→lock→排空准入锁（update-tasks.ts），以及 webview 侧栏浏览器租约隔离（09-16/09-20）
- 会话存储重构：08-31 删除 SQLite 后端（4553c9d95），只保留 JSONL+zstd；新增 v0→v1…v3→v4 相邻迁移包（v3→v4 于 09-16 引入）。直接起因是一份 116MB 的 v0 日志展开成 914 万个事件，整块迁移在 16GB 堆上 OOM
- 默认外发：session-log-deepseek 于 08-22 新增，09-14（31ec6bc7e）改为默认 enabled:true，由 base 与 sdk-minimal 挂载，在官方 DeepSeek 请求里附带完整的未确认日志后缀（正文、工具参数与结果、工作区路径、反馈）。遥测默认由基线的关闭改为 FEEDBACK_ONLY（08-25）
- 插件产品面：boot/plugin-manager 与 hmr（09-14）、config-editor、ui-plugin-manager。包括 npm 源计划与 npmjs/npmmirror ping 竞速（私有源不回落）、带快照回滚的事务化安装、pnpm 失败分类、依赖构建脚本按包名审批、版本兼容准入（07ad70817，09-23）。settings-file 整包删除，设置统一到 profile patch，写入带修订围栏（+1250/-3759）
- 交付物组：tool-present（37d27fcdf，09-08）；workspace-changes（f937f4e23，09-11）用私有 index 加只读 alternates 做 git 快照，生成回合改动文件卡与逐文件 diff；正文路径只按宿主记录链接（精确路径或唯一 basename）
- 安全加固：Windows 写沙箱加 Low 完整性标签与对所有人拒绝 FILE_DELETE_CHILD（d5ad3baeb/36e632751，09-19）；普通子进程 Job 对象收容（894f6aeb8）；建进程时隐藏控制台（09-16）；web_fetch 单次 DNS 解析、公网校验并钉住地址（b2219bba6，08-24）；实验性 LLM Auto review（55e53907a，09-09）
- 新能力域（09-11~09-12）：browser-use 与 computer-use 注册位（provider 为 Playwright MCP、Chrome DevTools MCP、Stagehand、Cua Driver）；SSH 远程执行世界（fs/subprocess/sandbox 整体替换，helper 仅支持 POSIX）；PTC 沙箱 Node 运行时（环境白名单，process.env 为空）；MCP 官方 SDK 协议协商、scoped resources 与 server instructions（32KB 上限）
- agent-loop 与上下文：持久 inbox 投影 inbox.ts（08-27）；系统提示成为 surface 节点 0（笔记名 09-02）；工具调用 preparing→start→result 三阶段（09-22）；精确前缀 fork 并为未闭合尾部补合成结果（8696ec6ce，09-16）；compaction-image-offload 持久图片卸载（09-08）；app-boot 区分必需与可选组件的启动失败（09-09），未捕获异常一律按致命处理（09-22）
- 多 agent 与作业：活跃 continuable 子代理按根共享上限，09-15 定为 16，09-16 改为 8；委派深度默认改为 1（09-17）；用户授权的子代理模型白名单（08-24）；bash 前台超时转后台作业（08-26），09-21 改为命令启动即登记；归档前询问并停止会话内仍在运行的回合、子代理、作业和提醒（cbae324bf，09-21）；预设拆成 agent-preset 与 registry，改用 profile YAML 声明（09-21）
- 客户端：ui-chat 从 ui-conversation 拆出，新增过程分组、整回合折叠、四档工作详情、「准备中」工具行、回合导航与用量面板、会话分叉按钮；连接分代与持续恢复（09-05）；composer 改用 Lexical；上下文占用环；新增 UI/UX 评审技能 .agents/skills/dsh-client-ui-ux
- 工程与发布：版本从 0.1.0-rc.8 到 0.1.7-rc.1，共 20 个 dsh-v 标签；benchmarks/ 性能门禁（09-05/06，长会话打开、翻页、Trajectory 预算 900/700/520ms，余量 ×1.25）；SAFETY.md（08-23）；implemented Agent Notes 约 487 篇（970 是含中文译文的文件数），其中约 314 篇文件名日期在基线之后

核验后发现（按相关度降序；verdict=CONFIRMED/CORRECTED；DM=DeskMinis 现状）：
- R5 [confirmed|context|新:no|DM:partial] 压缩摘要输入无上界，且完全不复用前缀缓存：DSH 的做法：compaction-basic 只摘要当前 surface 上最旧的一段平衡区间，这段区间已经包含上一次的摘要节点。请求原样重放 system 节点 0、上次请求的 tools 和该区间的消息，压缩指令放在最后，所以只有指令和摘要输出不命中缓存。已有的 <compacted-summary> 按 PRIOR checkpoint 合并。整个事务由日志中的 compaction/start…end 括号加锁，崩溃后的孤儿锁可以被检测到。

DeskMinis 现状：loop 把原始全量 history 传给 summarize()。compact.ts 从第 0 条原始消息一直摘要到锚点，不以上次摘要为输入，也不受窗口约束。systemPrompt 被换成「你是对话摘要助手。」，tools 为空数组，前缀缓存全部失效。摘要限 500 字，maxTokens 1024；摘要出错被 catch 吞掉后照常发请求。按消息数的兜底锚点（倒数第 15 条）可能把 tool_use 和 tool_result 切开。 ⇒ 借鉴：不需要新依赖，改动集中在 compact.ts 和 loop.ts：
（1）摘要输入改为 buildEffectiveHistory 的结果，并截取其中最旧、以真实用户回合为界的一段；
（2）沿用会话当前的 systemPrompt 和同一份 toolDefs，把指令作为最后一条 user 消息追加；
（3）摘要改为固定章节，maxTokens 提到 4–8K，并要求合并已有的 [对话摘要]；
（4）锚点遇到未配对的 toolUse 时向前退到配对完整处；
（5）先写红灯用例：历史超过窗口 2 倍时，第二次压缩的请求 token 数必须低于窗口。（核验：DSH 侧 README 行号与读者给的有 ±1 偏差，内容属实。DeskMinis 侧的全量 history、换 system、tools:[]、1024 tokens、500 字、catch 吞错都已逐行核实。「第二、三次压缩输入超窗」是推论，未实测。）
- R5 [confirmed|context|新:no|DM:missing] 上下文溢出分类，压缩后重试；配额耗尽作为终态：DSH 的做法：isContextWindowExceededError 用多组正则识别「超出上下文窗口」；pi-ai 适配器在 stop 时的 usage 超过窗口时，也归为 CONTEXT_WINDOW_EXCEEDED。compaction-basic 监听 agent/request-error，绕过阈值做一次最大化的平衡裁剪，只有 replaceGeneration 真的前进了才返回 retry。重试次数受 maxOverflowRetries 限制，默认 1。isQuotaExceededError 把 insufficient_quota 等配额耗尽与限流区分开。

DeskMinis 现状：ProviderError 把 400/401/403/404/422/429 一律标为 fallbackable，没有任何溢出识别，也不会压缩后重试。在模型组里，溢出会立即降级并改绑，整链失败后显示「所有模型均不可用」；单模型时直接报原始错误。 ⇒ 借鉴：不需要新依赖：
（1）在 ProviderError 构造处用正则识别溢出（maximum context length、prompt is too long、context_length_exceeded 等），加上 contextOverflow 标记，并设为非 fallbackable；
（2）loop 捕获溢出后强制压缩一次（先剪大结果，再摘要），然后重试一次；仍然溢出时给出专门的中文提示；
（3）把 insufficient_quota 和余额不足识别为终态，不进重试梯；
（4）用 mock 端点返回 400「maximum context length」，钉住「不降级、不改绑、压缩后重试」。（核验：已核实。补充一点：「所有模型均不可用」只在发生过降级（fellBack）时出现；单模型路径报的是原始错误，但同样没有压缩重试。）
- R5 [confirmed|context|新:no（节点 0 化是基线后新增）|DM:partial] 系统提示分稳定段与动态段：动态上下文改为追加的 user 快照：DSH 的做法：PromptSection 是稳定段，作为 surface 节点 0，只在文本真正变化时替换或追加。PromptContext 是动态段，由 RuntimeContextProjection 作为 user 快照追加：内容相同就不追加；清空时写 CLEARED 标记；快照被压缩掉后会重新注入。这样历史前缀能保持字节稳定。

DeskMinis 现状：promptFactory 每一步都重建整个 system prompt。stable 段有 stableCache，但助手规则块按表实时读取；技能超过 20 个时按 use_count 排序，而 file_read 读取 SKILL.md 就会让 use_count 加一；记忆块读 GLOBAL.md 和最近 3 天日志，memory_write 又是往当日日志追加。回合内任何一项变化都会改掉 system 的字节。Anthropic 的 cache_control 打在 system 上，system 之后的 messages 缓存会整体失效。 ⇒ 借鉴：不需要新依赖，也不需要迁移：
（1）system prompt 按「会话纪元」冻结，只在新建会话、改助手规则或技能启停、切换模型时重算；
（2）记忆和日志的变化改为回合开始时追加一条带来源标记的 user 消息，内容哈希未变就跳过；
（3）技能块改用稳定键排序；
（4）加一条不变量测试：同一回合内连续两次调用 promptFactory，结果必须字节相等。（核验：已核实。tools 的 cache 断点在 system 之前（anthropic.ts:32），所以 tools 缓存不受影响；受影响的是 system 以及之后的 messages 前缀。）
- R5 [confirmed|context|新:no|DM:partial（有卸载但取回路径失效）] 卸载桩的取回路径自相矛盾：file_read 读回的全文会被再次卸载：DSH 的做法：spill-policy 把超大结果换成头尾预览（预算各占一半）加完整文件路径，提示用 read 的 offset/limit 或 grep 按需取回。read 自身的结果不受 spill 处理，不会形成循环。spill-local 的文件为 0600、名字带随机前缀、按保留期清理。

DeskMinis 现状：桩只附开头 200 字，并指示「使用 file_read 读取 /var/minis/offloads/<id>.txt」。file_read 没有 offset/limit，整文件返回（上限 1MB）；loop 对所有工具结果都调用 shouldOffload（超过 2 万字符），不豁免 file_read。于是读回的全文又被换成一个新桩，模型按提示永远拿不到全文。 ⇒ 借鉴：先写红灯测试：offload 之后用 file_read 读同一路径，结果不能是新桩。修法：
（1）file_read 增加按行的 offset/limit；超长时返回头尾片段并注明总行数；
（2）loop 对 offloads 桶内的 file_read 结果豁免 offload；
（3）桩改成头尾各约 1K 加行数，并推荐 file_read(offset/limit) 或 file_grep 取回。（核验：逐行核实：THRESHOLD=20000，桩文案原样，file_read 无分页参数，loop 无条件 shouldOffload。属于实缺陷。）
- R5 [confirmed|platform|新:yes（apps/desktop 基线后新增；致命恢复与崩溃报告为 09-15/09-22）|DM:partial（仅启动期 showErrorBox）] 后端进程监管、原生致命恢复对话框、崩溃报告与安全模式（合并三条）：DSH 的做法：
- Host 进程：Electron 以 ELECTRON_RUN_AS_NODE 拉起 Host，经 Node IPC 走类型化生命周期事件（ready / fatal / shutdown-complete / 任务查询；协议版本 4）。收到非法消息就 kill；非 0 退出或 Host 报 fatal 都进入 fail 流程。
- 致命对话框：每个进程只弹一次原生对话框，最多等 1 秒写崩溃报告；只显示最后 8 行、1200 字预算和报告路径。按钮为退出、重启、禁用第三方 bundle 后重启；EADDRINUSE 有专门文案。
- 禁用第三方后重启：sanitizeProfile 把 cordis.patch.yml 改名为 .bak-<ts>，不解析，也不删文件。
- 崩溃报告：写到 logs 目录，权限 0600，保留最近 10 份，内含 cause 链和渲染端 error 级控制台尾部。
- 不用启动超时猜测失败。
- app-boot 把 detached 的 unhandledRejection 和同步回调抛出的 uncaught 一律视为致命。

DeskMinis 现状：main 只在握手前（minisdPort===0）处理 minisd 的 exit，启动失败时 showErrorBox 后退出。运行中 minisd 崩溃、render-process-gone 都没有处理，也不落盘。minisd 没有全局异常处理器。 ⇒ 借鉴：只用 Electron 的 dialog 和 node:fs，不需要新依赖：
（1）main 常驻监听 minisd 的 exit，并用环形缓冲保留 stderr 尾部；非退出流程时写 userData/logs/crash-*.log（保留 10 份），弹出「退出 / 重启后台 / 停用全部 MCP 后重启（servers.json 改名备份）」三选项；
（2）再加一个安全模式启动标志：跳过 MCP、同步桥和市场技能；
（3）minisd 注册 uncaughtException / unhandledRejection：写日志后以非 0 码退出；
（4）报告里区分「启动超时」和「崩溃」；
（5）xvfb 剧本：kill minisd 后断言出现横幅或对话框。（核验：已合并核心、客户端、生态三位读者的同一事实。DSH 侧各常量与流程均已核实。DeskMinis 侧 exit 只在握手前处理、源码中没有 uncaughtException 与 render-process-gone，也已核实。）
- R5 [confirmed|sync-storage|新:yes|DM:missing] 渲染端连接分代与断线自动恢复（配状态胶囊）：DSH 的做法：ConnectionController 先收到 ready 帧、确认增量监听已挂上，才发布新的一代，然后读基线。断线后按 500ms/1s/2s/4s/8s/10s 退避，带 50–100% 抖动，封顶 10s 持续重试；offline 时暂停，online 后重来；reconnect() 可立即重试。每条逻辑流在新一代用完整基线原子替换。界面是一枚黄色「连接异常」胶囊，至少显示 800ms，恢复后变绿 2 秒；启动时和一直健康时静默。

DeskMinis 现状：rpc.ts 只挂了 onopen/onerror/onmessage，没有 onclose。断线后已发出的 call 永远不会 settle，没有重连，也没有连接状态显示。 ⇒ 借鉴：不需要新依赖：
（1）rpc.ts 增加 onclose：把全部 pending 以「连接已断开」reject，然后指数退避加抖动重连；
（2）重连成功后广播「新一代」，chat store 重新拉会话列表和当前消息作为基线，不做增量补洞；
（3）main 重启 minisd 后端口和 token 会变，需经 IPC 推给渲染端；
（4）TopBar 的 syncDot 旁加连接胶囊；
（5）用假 WebSocket 测「断开时 pending 必须 reject」。与上一条（后端监管）配套实施。（核验：已核实。connection 恢复决策笔记是 09-05，属于基线后新增。）
- R5 [confirmed|agent-loop|新:no（持久 inbox 为基线后）|DM:missing] 运行中续话：Queue / Steer / Inject 三种投递、持久 inbox 与 QueueDock（合并两条）：DSH 的做法：Agent.send 统一处理投递，另有三个别名：
- followup：排到下一回合；
- steer：在最近的 step 边界消费，空闲时唤醒 agent；
- inject：等下一个 pre-step，不唤醒。
所有 inbox 变更都以 agent/inbox/spliced 事件落日志，冷启动可以重建；排队项支持编辑和撤回；cancel 默认清空 inbox，keepInbox 可保留。
客户端运行中不锁输入：回车按设置走「排队」或「插话」，Ctrl+Enter 走另一种。发送是乐观的：先本地回显，失败时恢复草稿。QueueDock 列出排队项，可编辑、删除、转插话；Send 和 Stop 共用同一个按钮位。

DeskMinis 现状：inFlight 时 chat.prompt 直接抛「该会话正在运行中」；Composer 的 canSend 要求 !chat.running。 ⇒ 借鉴：minisd 先定义后端语义：每个会话维护 steer 队列和 next-turn 队列（先放内存）。loop 在工具结果落库之后、下一次请求之前，把 steer 作为 user 消息插入，保证配对不断；turnEnd 后如果 next-turn 非空，就自动开新回合；取消时是否保留队列，要写进规格。渲染端：Composer 运行中允许发送，并加一个小的 QueueDock。要跨重启，再用只追加迁移新建 queued_inputs 表。TDD 先测 step 边界的消费顺序。（核验：合并了核心与客户端两条。steer API 和 QueueDock 在基线时已存在，持久 inbox.ts 是 08-27 新增（110142236）。）
- R5 [confirmed|agent-loop|新:no|DM:missing] todo_write 整表替换，输入框上方进度面板：DSH 的做法：模型每次都发送完整清单，追加 todo/write 事件，最后一次写入为准。投影在 turn/start 时清空，turn/end 时保留。工具结果只回一行计数。allowParallelInProgress 是部署时必须明确的配置：为 false 时强制最多一个 in_progress。TodoPanel 默认折叠，头部汇总「完成 n · 进行 n · 待办 n」；todo-history 让每张工具卡可以和前一版对比。

DeskMinis 现状：没有 todo 工具。 ⇒ 借鉴：成本最低、收益最高：minisd 加 todo_write，约 150 行，不需要新表，清单就在 parts_json 里，随同步走。渲染端从历史 toolUse 折叠出最新一版。单 agent 先写死单 in_progress。按 TDD 先写 fold 纯函数的红测。（核验：已核实。）
- R5 [confirmed|ux-flow|新:no|DM:missing] 计划模式：/plan 进入、exit_plan_mode 提交审阅；软约束，工具目录不变：DSH 的做法：激活期间只多渲染一段 plan:policy 提示词；exit_plan_mode 始终注册，保证工具目录稳定。计划必须以 # 标题开头，经 plan-review intent 的提问交给审阅卡，审阅卡接管输入框；批准后 plan/mode 事件延迟到下一个 pre-step 才落盘。standard 预设的提示词条款：不改文件；口头同意不等于批准；exit_plan_mode 必须是唯一且最后一个调用；规划阶段不用 todo_write；审阅通道不可用时停在计划模式。本质是软约束，工具照样可调。 ⇒ 借鉴：DeskMinis 可以做得更硬：计划态下由权限网关硬拒 file_write、file_edit、office_write 和非只读 shell。状态存 sessions 追加列；审阅卡沿用 PermCard 形态；提示词条款借鉴 standard.patch.yml；工具列表不随模式增删。（核验：已核实提示词原文。）
- R5 [confirmed|agent-loop|新:no|DM:missing] 后台作业注册表与完成通知（忙则注入、闲则唤醒）：DSH 的做法：ctx.jobs 按 owner 会话隔离；输出放进环形缓冲，溢出部分落 spill 文件。工具有 job_output（wait 默认 30s、上限 10min）、job_list、job_kill。完成时，owner 正忙就 inject，空闲就 wakeup 开新回合。maxConsecutiveWakes 用来限制自激链，但没有默认值，即默认每次都唤醒。系统提示要求不要轮询。

DeskMinis 现状：没有这一能力，交接文档已经划掉了「后台作业」。 ⇒ 借鉴：它解决的是回合内的长命令（dev server、npm install），与 cron 不是同一个需求面，建议重新评估划掉的决定。最小版：shell 加 run_in_background，内存 Map 加尾部缓冲，job_output 和 job_kill（taskkill /T），完成时只注入不唤醒。UI 写明作业重启即丢。（核验：已核实：maxConsecutiveWakes 为 z.number().min(1)，没有默认值。）
- R5 [confirmed|product|新:yes|DM:partial] 交付物：present 显式声明、回合改动文件卡（git 私有快照）与路径只按记录链接（合并三条）：DSH 的做法：
- present：模型显式声明交付文件，maxFiles 默认 8，但描述写「一次最多 4 个」，文档有漂移。
- workspace-changes：每个顶层回合的首尾做 git 快照，用私有 index 加临时对象目录、仓库对象库作只读 alternates，不碰用户的 index 和 refs；文件工具编辑前另做整文件拷贝。由此得到带 +/- 行数的改动卡和逐文件 diff 审阅页，子代理会话不记录。已知限制：摘要只存活在 Host 进程里，重启后早期回合的卡片消失。
- 正文路径链接：行内代码只有在「精确路径」或「唯一 basename」匹配本回合的产出或交付时才链接，重名一律不链接，从不从正文推断。

DeskMinis 现状：collectArtifacts 只从 file_write、file_edit、office_write 的输入推导，shell 生成的文件看不见；改动清单只在右栏的「改动」tab 里。 ⇒ 借鉴：（1）StageChat 回合末放一张小卡，复用 collectArtifacts 和 LCS 行数，点击跳到 PreviewPane；
（2）链接规则写成纯函数 lib/artifacts/link.ts 并先测；
（3）加 present 工具，几十行代码；
（4）回合前后对绑定目录做 mtime+size 快照，覆盖 shell 产物；检测到 git 时再用 alternates 技巧拿精确行数（git 是系统可执行文件，不算 npm 依赖）；
（5）摘要落 SQLite，避免 DSH「重启即丢」的问题。（核验：合并了 agent 两条与客户端一条。两个提交日期已核实；maxFiles=8 与描述「at most 4」的漂移已核实。）
- R5 [confirmed|safety|新:no|DM:missing] 沙箱优先加按次升级阶梯：模式随调用传递，升级必须附理由：DSH 的做法：每次 shell 和 fs 调用都携带 SandboxPolicy。被拒时，模型看到固定标记 `[sandbox: file access denied under <mode> mode]`，并在同一回合收到提示：可以带 sandbox_permissions 和 justification 把「这一次」重试到更宽的模式。升级阶梯是封闭表 WIDER_MODES；批准只对这一次调用生效；后端不可用时报 SANDBOX_UNAVAILABLE，失败关闭。pre-execute 默认 allow。重复申请当前模式直接放行（09-16）。Windows 默认用 pwsh-sandbox 加 workspace-write。

DeskMinis 现状：安全边界是正则分级加人工审批。 ⇒ 借鉴：（1）先把词汇搬进来：每个会话一个 sandboxMode，工作区围栏拒绝时返回统一标记；重试带 justification，PermCard 显示理由。纯 TS，可以先红后绿。
（2）OS 级约束见下一条。现有三档审批作为与沙箱模式正交的「审批策略」。（核验：已核实。escalation.ts 在基线时已存在，same-mode 为 09-16 新增。）
- R5 [corrected|safety|新:partial（Low IL 与拒删为 09-19 新增）|DM:missing] Windows 写入沙箱：WRITE_RESTRICTED 受限令牌、Low 完整性标签、拒绝 FILE_DELETE_CHILD：DSH 的做法：CreateRestrictedToken 带 WRITE_RESTRICTED、DISABLE_MAX_PRIVILEGE、LUA_TOKEN，再降到 Low 完整性。工作区 SID 由路径 sha256 确定性派生，作为常驻 ACE；temp SID 每会话随机生成。每次授权在一次 SetNamedSecurityInfoW 里同时写入三样：能力 SID 的 allow ACE、对所有人拒绝 FILE_DELETE_CHILD、Low no-write-up 标签。任何 Win32 失败都抛错。
文档写明的边界：只管写和删，读、网络、进程可见性不管；Low 标签会比 DSH 活得更久，并放行其他 Low-IL 进程写入；目录拒绝 FullControl 打开。实现依赖 koffi。 ⇒ 借鉴：不能照搬。koffi 违反零依赖；可以改用 PowerShell Add-Type 编译缓存，或单独编译一个 helper。授权范围先只放 sessions/<id>/workspace；对用户的真实项目目录做常驻改写，必须征得显式同意。UI 如实显示 partial；只能在 Windows 真机上做 TDD。（核验：更正基线归属：受限令牌 ACL 沙箱包在基线时就已存在（08-08 笔记）；基线后新增的是 Low IL 标签与拒绝 FILE_DELETE_CHILD（09-19）。技术细节均已核实。）
- R5 [confirmed|safety|新:no|DM:partial（疑似缺陷）] 路径围栏用 realpath 规范化，写入前再确认一次：DSH 的做法：writableRoots 统一经 realpathSync.native 规范化，Seatbelt 与进程内 fs 围栏共用同一份。fs-sandbox 先规范化再判断包含，syscall 前再规范化一次以压缩 TOCTOU 窗口，并明确说明这不是内核边界。

DeskMinis 现状：isInsideRoot 只用 resolve 和 relative 做字面判断，工作区内的 junction（mklink /J 不需要管理员权限）可以写到工作区外。另有一个次要问题：名为 `..foo` 的相对路径会被误判为工作区外，只会导致多问一次，属于保守方向。 ⇒ 借鉴：不需要新依赖：对目标路径中已存在的最深祖先和工作区根都做 realpathSync.native，再判断包含，写入前再算一次；改成按路径分段判断。红测用 fs.symlinkSync(target, p, 'junction') 构造。（核验：已核实。junction 逃逸是由代码推断的，未在 Windows 实测。）
- R5 [confirmed|safety|新:no（PTC 部分为新）|DM:missing] 子进程统一擦除凭据形态的环境变量；PTC 进一步收紧到白名单（合并两条）：DSH 的做法：shell、终端、LSP、MCP stdio 都从 scrubbedParentEnv() 起步：丢掉名字匹配 /KEY|PASSWORD|SECRET|TOKEN/i 的变量和所有 DSH_* 变量，再叠加显式配置的 env。proxyEnvironmentForChild 恢复代理变量，并设 NODE_USE_ENV_PROXY=1。插件管理器服务端清洗环境，CLI 则有意继承。PTC 只留 PATH、PATHEXT、SYSTEMROOT、WINDIR、TEMP、TMP，程序里的 process.env 为空；ELECTRON_RUN_AS_NODE 在执行模型代码前删除。

DeskMinis 现状：
- shell.ts 传入 { ...process.env, ELECTRON_RUN_AS_NODE:'1', ...env }；
- terminal.ts 和 mcp/stdio.ts 都把完整的 process.env 交给子进程。 ⇒ 借鉴：加一个共享的纯函数 childEnv()：按同一正则擦除凭据变量和 DESKMINIS_* 变量，显式加回 MINIS_* 桥变量；ELECTRON_RUN_AS_NODE 只注入给确实需要的桥脚本。MCP 走「擦除后叠加用户声明的 env」。留一个例外白名单设置项；确认卡写明「依赖环境变量中 token 的 MCP 需要显式填写」。（核验：合并了工具与生态两条。DSH 的擦除在基线时已有；代理恢复和 PTC 白名单是新增。DeskMinis 三处 spawn 已逐一核实。）
- R5 [confirmed|platform|新:yes|DM:missing] 单实例锁与二次启动聚焦：DSH 的做法：在碰任何 profile 之前先调 requestSingleInstanceLock，拿不到就 quit；second-instance 事件把焦点交还主窗口。

DeskMinis 现状：main/index.ts 里完全没有单实例锁。双击两次就会起两个 minisd，并发写同一个 minis.db，同步与 mDNS 同时广播，cron 也会双发。 ⇒ 借鉴：约 10 行：在 whenReady 之前调用；second-instance 里对主窗口执行 show、restore、focus，托盘隐藏状态也要能唤出。先对注入式接口写单测，再到真机验证。minisd 另加一个 DB 旁的锁文件兜底。（核验：已核实。）
- R5 [confirmed|safety|新:yes|DM:missing] 外链、新窗口、页面导航与右键菜单的主进程守卫：DSH 的做法：每个 BrowserWindow 都做四件事：
- setWindowOpenHandler 一律 deny，http(s) 链接交给 openExternal；
- will-navigate 拦住非本协议的导航；
- 显式开启 sandbox 和 contextIsolation；
- 自建中文右键菜单。

DeskMinis 现状：MarkdownInline 用 target="_blank" 渲染链接，主进程却既没有 setWindowOpenHandler，也没有 will-navigate 和右键菜单。preload 暴露了 minisdInfo()（端口加 token），ipcMain 的 minisd:info 不校验发送方。如果新开的窗口继承了 preload，外部页面就能拿到 token 驱动 agent，这一点需要真机核实。 ⇒ 借鉴：都是 Electron 内置 API：
（1）setWindowOpenHandler 对 http、https、mailto 调 openExternal，并 deny；
（2）will-navigate 只允许 dev server 或自身 file://；
（3）按 editFlags 建中文右键菜单；
（4）minisd:info 校验 sender 是主窗口主帧。
先用源码守卫钉住，再到真机验证。（核验：已核实，并补充了 ipcMain 不校验发送方这一点。新窗口是否继承 preload 仍待真机核实。）
- R5 [confirmed|ui|新:yes|DM:partial] 过程分组标题分类、整回合自动折叠与四档「工作详情」：DSH 的做法：
- 过程组：推理和工具按过程组切分；回复、用户输入、插话、重试、报错是分组边界。
- 组标题：进行中显示最新运行中调用的类别加细节，细节按固定字段优先级取；标题至少停留 150ms；完成后取次数前三的类别拼成标题。
- 整回合折叠：正常结束的回合自动收起过程，失败、停止、中途插话的回合不折。
- 四档：只改变可见范围，不重建行。

DeskMinis 现状：StepGroup 只写「正在执行…」或「已执行 N 步」，ThinkBlock 流式时默认展开。 ⇒ 借鉴：先把类别映射和细节提取写成纯函数 lib/steps/，按 DeskMinis 的工具名重写映射表，TDD。StageChat 的 turns 层照 DSH 的条件表实现整回合折叠；四档先做 standard 和 verbose 两档。只改渲染端，不需要新依赖。（核验：已核实三个 conversation-nodes 文件在基线时不存在。）
- R5 [confirmed|safety|新:yes|DM:partial] 扩展密钥只在配置里写名字；DeskMinis 市场装的 MCP 密钥明文落盘：DSH 的做法：凭据接缝规定配置只写名字，取值优先级为启动环境 > 本地凭据文件 > 项目 .env > home .env；Settings 表单对 secret 角色结构化脱敏，只返回「已设置」标记；webhook-github 每次请求时按 secretEnv 解析密钥。

DeskMinis 现状：
- install.ts 解析了 isSecret，但确认卡收集到的值原样写进 servers.json 的 env；
- mcp.servers.list 把条目原样发给渲染端。 ⇒ 借鉴：不需要新依赖：
（1）加 `$$vault:<key>` 引用；
（2）isSecret 字段写进 KeyringVault，servers.json 只存引用；
（3）stdio 启动时解析引用；
（4）list 对密钥键只返回 {configured:true}，headers 同样处理；
（5）先写红测：安装后 servers.json 与 list 结果里都不应出现明文。（核验：DeskMinis 侧已核实 env 原样落盘与 list 原样返回。DSH 的凭据改动是 +6779 行，已核实。）
- R4 [confirmed|context|新:no|DM:partial] 水位以供应商 usage 锚定，并对完整请求信封计价：DSH 的做法：token-meter 以最近一次成功调用的真实 usage 作为基线（kind:'usage'），前提是那次请求的规范信封与当前一致；之后用带符号的 surfaceDeltaTokens 叠加增减。没有可复用的锚点时，才对完整信封（system、tools schema、全部 surface 节点、按路由计价的图片）做估算。DSH 自认按 4 字符/token 会低估 CJK。

DeskMinis 现状：estimateTokens 只统计 history 的 parts（CJK 按 /1.6，其余按 /4），不算 system prompt，也不算工具 schema；chat.contextInfo 同样只估 history。assistant 消息已经落库了 token_usage，却没有被使用。 ⇒ 借鉴：（1）水位取最近一条同模型、且之后没有新压缩标记的 assistant 的 usage input+output，再加上其后新增消息的估算；
（2）没有 usage 时，把 systemPrompt 和 JSON.stringify(toolDefs) 纳入估算，CJK 规则不变；
（3）单测：挂 30 个 MCP 工具时，水位必须显著高于只算 history 的值；
（4）任务面板标注水位是「实测」还是「估算」。（核验：已核实。DeskMinis 的 CJK/1.6 确实比 DSH 的 4 字符/token 更准。）
- R4 [confirmed|platform|新:yes|DM:partial] 更新与退出的准入锁、任务检查、优雅关停升级梯（合并两条）：DSH 的做法：
- 安装前：先调 inspect，看有没有运行中的 agent、非空的 nextTurn/nextStep inbox、运行或停止中的 job。有就把确认框改成 warning，按钮为「停止任务并安装 / 稍后」，默认焦点在「稍后」。确认后调 lock：新请求一律 503，等已接纳的写请求跑完再复查一遍。
- 关停：先发 shutdown，等 10 秒；再 SIGTERM，等 5 秒；最后 SIGKILL。要求优雅退出而实际不洁时，抛 DesktopHostUncleanExitError 拒绝安装。
- 自动检查：不弹窗、不下载，带抖动和退避。

DeskMinis 现状：update-downloaded 后弹「稍后再说 / 重启并安装」（默认焦点在稍后），选安装就直接 quitAndInstall，不检查 agent 或 cron 是否在跑；before-quit 直接 minisd.kill()，没有关停握手，半截回复来不及落库。 ⇒ 借鉴：不需要新依赖：
（1）minisd 新增 system.activeWork RPC（返回 inFlight、待批权限、运行中的 cron）和 system.shutdown RPC（abort 所有 controller，让 cancelWithPartialReply 落库，关闭 MCP 和同步后回 ack）；
（2）安装前查 activeWork，有任务就改成 warning 文案；
（3）before-quit 先调 shutdown，最多等 5 秒再 kill；
（4）e2e:m5 加一条剧本：运行中退出，重启后半截回复仍在。（核验：合并了核心与客户端两条。DeskMinis 已有用户确认框，默认焦点也在非破坏选项上，所以判为 partial，缺的是忙碌检查和关停握手。）
- R4 [confirmed|context|新:no|DM:missing] 工作区指令文件链（AGENTS.md / CLAUDE.md）的加载与增量刷新：DSH 的做法：agent-instructions 在会话首次请求时注入一条持久基线消息，内容依次为：$DSH_HOME/AGENTS.md，然后从 .git 根到 cwd 的每一层 AGENTS.md、CLAUDE.md，再加 *.local.md 覆盖层，顺序由宽到窄。内容相同的兄弟文件只渲染一次。之后 read、write、edit 触及更深的目录时增量加入新文件；文件变化就替换，文件删除就发移除通知。maxBytes 预算的处理：先整份丢弃较宽泛的文件，再截断最具体的那份，并给出可见提示。注入内容用 <\system-reminder> 包裹，正文里的字面闭合标签会被转义。根目录探测遇到 I/O 失败直接报错，不会换上级目录当根。

DeskMinis 现状：会话可以绑定真实项目目录，但完全不读这类约定文件。 ⇒ 借鉴：（1）绑定工作区后的首个回合，向上找到 .git 根，按由宽到窄的顺序拼接，预算约 32KB，超出时照 DSH 的规则处理并提示；
（2）作为一条带来源标记的 user 消息落库，不塞进 system；
（3）内容来自仓库，属于半可信：先 sanitizeMultiline 清洗，在任务面板列出已加载的文件，并提供会话级开关；
（4）触及更深目录时的增量刷新放到第二期。（核验：已核实（dsh-base 默认 maxBytes 65536）。）
- R4 [confirmed|context|新:partial（image-offload 为新增）|DM:partial] 上下文削减的决定落盘且单调推进，以稳定前缀缓存：DSH 的做法：
- 工具结果剪枝：写成 tool/result 的 replace 事件，外加一条 compaction/prune 影子计价事件；
- 图片卸载：写 image/offload 事件，跨路由、恢复、重放都沿用这一决定；
- 压缩：写成 user/message 的 replace。
决定一旦做出就一直沿用，缓存只在决定点失效一次。

DeskMinis 现状：两处是请求侧的滚动窗口。
- pruneOldToolResults 固定保留最近 12 条：offload 档下窗口边界每一步都前移；水位回落后桩又还原成全文。
- placeholderOldMediaRefs 只保留最近 2 轮图片：每个新回合都会把更早一轮的图片换成占位。
这两处都会反复打破前缀缓存。 ⇒ 借鉴：保持「不改写原始消息」，只把「削减到哪儿」这个决定落盘：
（1）只追加迁移，给 sessions 加 pruned_through_message_id 和 media_cutoff_message_id；
（2）只在档位触发时成块推进边界，之后维持不动；
（3）构建请求时按锚点做确定性替换；
（4）单测：同一水位下连续两次构建请求，messages 前缀字节必须相同。（核验：已核实。图片卸载包的首个提交是 09-08，不是读者写的 09-10。剪枝器在基线时已有。）
- R4 [corrected|safety|新:partial|DM:missing（刻意保持无）] （警惕）默认外发：会话日志上传、匿名安装 ID 头与仅反馈遥测（合并两条）：session-log-deepseek 于 08-22 新增，09-14 改为默认 enabled:true，base 和 sdk-minimal 组合都挂载了它。每次请求官方 DeepSeek 端点（或配置的网关）时，都会在 dsh_session_log 字段里附带尚未确认上传的完整日志后缀。决策笔记写明内容包括消息正文、工具参数与结果、工作区路径、反馈。以 HTTP 2xx 作为确认水位，至少投递一次，崩溃窗口内会重复上传。只有 headless/ACP 语料和 Web 测试脚手架显式关闭了它。

另外两点：
- 每个请求都带 x-deepseek-harness-user-id 头（带会话时还有 session-id 头），这在基线时就已存在；
- OTel 遥测在基线时默认关闭，08-25 起默认为 FEEDBACK_ONLY：只有用户主动反馈才授权上传，配置成 FULL 会被拒绝。 ⇒ 借鉴：这是 DeskMinis 应当保持「没有」的能力：
（1）不引入任何默认开启的轨迹上传或安装 ID 头；
（2）以后如果做反馈上报，参照 FEEDBACK_ONLY：只在用户显式点击时上传，上传前本地预览并脱敏，子会话单独授权；
（3）把「会话只留在本机和已配对设备」写进隐私说明；
（4）将来如果兼容 DSH 的配置或插件，必须审查这一项。（核验：合并了两条。已更正：匿名 ID 头与 session-id 头在基线时就已存在，不是新增；新增的是 session-log 上传（08-22，09-14 起默认开启）和 FEEDBACK_ONLY 默认（08-25）。「只有测试语料关掉它」基本属实，Web 测试脚手架 apps/web/tests/scaffold.ts 也显式关闭。）
- R4 [corrected|ui|新:yes|DM:missing] 工具调用「准备中」阶段（合并两条）：DSH 的做法（09-22）：同一个 callId 贯穿 preparing、start、result 三个阶段。流式 delta 里一出现 callId 和工具名，就插一行不可展开的「准备中」；write/edit 类显示「正在准备内容 N KB」（按已收参数长度估算）。不解析残缺 JSON，不改变请求、派发和持久格式；流失败时未派发的准备行直接隐藏。历史回放从 start 开始。

DeskMinis 现状：provider 已经发出 toolInputDelta{toolUseId, name, accumulatedJson}，但 loop 在 :417 直接丢弃（注释写着「M1 UI 不用增量预览」）。toolStart 要等整条流结束才发，写长文件时界面长时间没有动静。 ⇒ 借鉴：比读者估计的更便宜：provider 不用改。loop 把首个 toolInputDelta 转发成 toolPreparing{toolUseId, name, bytes}，按约 250ms 节流；store 按 toolUseId 与 toolStart 合并成同一行，流失败时移除。不落库，不需要新依赖。（核验：合并了两条。更正采纳建议：读者说要让 provider 新发 toolCallStart，实际上 DeskMinis 的 anthropic 和 openai provider 已经发出带 name 的 toolInputDelta，只是 loop 把它丢弃了。）
- R4 [confirmed|tools|新:yes|DM:missing] 前台命令超时自动转后台作业（而不是杀掉）：DSH 的做法：有作业注册表时，每条 bash 命令一启动就登记为 job。前台调用超时后返回同一个 job id，命令继续运行（promoteOnTimeout 默认 true）；没有注册表时才退回「超时即杀」。首版在 08-26，09-21 重构为启动即登记。 ⇒ 借鉴：难点在于 DeskMinis 的 agent 和终端共用一个长驻 shell。可以只对「独立进程模式」开启，或者超时后让出共享 shell 并重建一个。先出设计稿，再上 Windows 真机验证。（核验：已核实。）
- R4 [confirmed|multi-agent|新:no|DM:missing] 子代理委派：spawn 与 fork、前台或后台、结算通知回灌父会话：DSH 的做法：ctx.subagents 是多提供者注册表。spawn 开全新上下文；fork 以父会话最后一个 turn/end 之前的前缀作为种子；外部产品（Codex、Claude Code 等）默认禁用。前台调用等结果；后台分两种：one-shot 登记为 job，continuable 立即返回持久子会话 id，结束时向父会话投递 subagent-settled 通知。send_message 只允许直接父子之间通信。工具措辞随「是否继承对话」切换。outputSchema 靠强制调用的 structured_output 捕获。

DeskMinis 现状：没有子代理。 ⇒ 借鉴：先做 one-shot 前台子代理：另起一个 run，默认只给只读工具，只把最终文本回给父会话，UI 用 StepGroup 折叠。fork（共享前缀对缓存有利）排在 continuable 之前。外部产品子代理需要引入 npm 依赖，不做。（核验：抽查属实。）
- R4 [confirmed|safety|新:no|DM:missing（尚无子代理）] 子代理审批钉死为 never，且不能向人提问（DELEGATED_CALLER）：DSH 的做法：委派时子会话的 approvalPolicy 钉为 never，并注入 runtime context 告知子代理：需要审批的操作会被自动拒绝，受限就在结果里报告。userQuestions.ask 对非根 agent 抛 DELEGATED_CALLER。这源自一次教训：后台子代理卡在一个没有任何界面显示的审批上，看起来和「正在工作」一模一样。 ⇒ 借鉴：DeskMinis 以后做子代理时要预先定下：子代理的权限是父会话档位的只读子集，凡需审批立即拒绝，不要等 90 秒；不给子代理 ask 类工具。（核验：已核实。）
- R4 [confirmed|agent-loop|新:no|DM:missing] 同会话目标（goal）、空闲自动续跑与权限分级：DSH 的做法：每个会话最多一个 goal；阶段为 active、paused、blocked、complete，另有进程内的 armed 标志，从不持久化。round driver 在空闲时排入 <goal_round> 提示（默认上限 256 轮）；恢复或分叉后一律 disarmed，要人显式 resume。创建、编辑、暂停、恢复都要求本回合有直接的人类输入；同一阻塞连续 3 轮才允许标记 blocked；完成或阻塞时注入收尾指令。已知限制：只有轮数预算，没有 token 或费用预算。 ⇒ 借鉴：sessions 表追加 goal_json 列，前提是先做消息来源标注。armed 标志绝不能进同步，否则两台机器会同时续跑。必须补上 token 或费用上限；UI 显示「第 n/上限 轮」；收尾指令可以直接翻译借用。（核验：已核实。）
- R4 [confirmed|ux-flow|新:no|DM:missing] 结构化向人提问 ask_user_question 与提问组件（合并三条）：DSH 的做法：
- 工具：一次可以问多个问题，每题有 options（推荐项带「(Recommended)/(推荐)」后缀）、multi_select 和自由填写，回答为结构化的 answers。只有根 agent 能问，委派调用抛 DELEGATED_CALLER。intent（目前只有 plan-review）会换成专用界面，协议不变。
- 组件：QuestionComposer 接管输入区；推荐后缀单独标注，提交值保持原文；可跳过；IME 组字期间（含 keyCode 229）的回车不提交；草稿存在会话级 store。

DeskMinis 现状：没有这类工具，模型只能在正文里提问然后结束回合。 ⇒ 借鉴：复用权限网关的「挂起 promise、广播、倒计时」机制实现 ask_user，结果以 JSON 回填为 tool_result。cron 或无人值守时立即返回「无人应答」。前端在 Composer 位置换成问题卡，照抄 IME 判断。以后的计划审阅卡可以建在这套机制上。（核验：合并了 agent、工具、客户端三条。推荐后缀正则和 keyCode 229 已核实。）
- R4 [confirmed|architecture|新:no|DM:missing] 消息来源标注（MessageSource）：区分人类输入与合成消息：DSH 的做法：每条 user/message 都带 source（user、goal、agent-message relay、subagent-settled notice、tool-jobs 等）。form 分 notice 和 relay，决定 UI 是折叠还是转述。权限判断只认 source.kind==='user'，而省略 source 默认就是 user，所以非人类生产者必须自带来源。只有 goal 来源的消息消耗轮次。

DeskMinis 现状：messages 表没有来源列，只有 origin_device_id；sessions 表有 source 列（例如 cron），但定时任务的 prompt 仍是一条普通 user 气泡。 ⇒ 借鉴：作为 goal、作业、子代理、指令文件注入的地基先做：ALTER TABLE messages ADD COLUMN source_json（NULL 表示用户）；StageChat 把非用户来源渲染成一行 EventNote；权限判断只认 NULL 或 user。（核验：已核实。）
- R4 [confirmed|ux-flow|新:yes|DM:partial（疑似缺陷）] 归档或删除前询问并停止仍在运行的工作；DeskMinis 删除运行中会话不中止：DSH 的做法（09-21）：通过 workspace/session-activity 瀑布逐个询问插件还有什么在跑（回合、子代理、作业、提醒），有就拒绝归档并列出清单；用户确认「停止并归档」后，派发 workspace/session-stop 逐项停止。

DeskMinis 现状：chat.sessions.delete 只释放终端就删库，没有检查 inFlight，也没有 abort 对应的 controller。 ⇒ 借鉴：先写红测再修：删除前如果 inFlight.has(id)，就返回「会话正在运行」；NavRail 的二次确认改为「停止并删除」，确认后先 abort、等 run 结束再删；cron 的 lastSessionId 也要处理。（核验：DSH 与 DeskMinis 两侧均已核实。孤儿写入的后果尚未实测。）
- R4 [confirmed|ui|新:partial|DM:partial] 进度可视化的一组 UI 模式（停靠条、会话头、聊天节点、侧栏）：DSH 的做法：
- 停靠条：输入框上方放 GoalBar（阶段、目标、暂停/恢复/编辑/清除，不显示轮次）和默认折叠的 TodoPanel。
- 会话头：作业下拉（滚动计时、实时输出、终止）、提醒闹钟目录、子代理目录（token 求和、活动时长）。
- 聊天节点：workflow 运行节点按 phase 分组。有一条规则：没有结束事件、但回合已关闭时，派生为「已中断」，不会一直转圈。

DeskMinis 现状：只有 TaskPanel 和 StepGroup。 ⇒ 借鉴：在 ui/ 新树给 Composer 上方加一个统一的 dock 区，纳入 a11y 和 z 序守卫。「已中断」规则可以马上用在 StepGroup：没有终态的工具卡，只要回合已结束或会话不在 inFlight，就显示「已中断」。（核验：抽查属实；会话头提醒目录是 08-25 新增。）
- R4 [confirmed|platform|新:yes|DM:partial] Windows 进程树收容（Job 对象）与建进程时隐藏控制台：DSH 的做法：普通子进程先挂起创建，分配进 KILL_ON_JOB_CLOSE 的 Job 后再恢复运行；拿不到 Job 时退回 taskkill /T /F。建进程时用 STARTF_USESHOWWINDOW 加 SW_HIDE，Node 侧统一 windowsHide:true；不用 CREATE_NO_WINDOW，因为受限令牌下会触发 0xC0000142。

DeskMinis 现状：
- 只有 mcp/stdio.ts 的 killTree 用 taskkill 杀整棵树；
- shell 和终端都只调用 proc.kill('SIGKILL')，会留下孤儿进程；
- shell、终端、MCP 的 spawn 都没设 windowsHide。 ⇒ 借鉴：把 killTree 抽成共享 helper，shell 和终端复用；补上 windowsHide 并在真机核对。Job 对象需要 FFI 或 helper，和沙箱 runner 一起做。（核验：已核实；win32-process 包在基线时不存在。）
- R4 [confirmed|safety|新:yes|DM:missing] Auto review：用当前模型逐次审查工具调用，代替人工审批（实验）：DSH 的做法：以 prepend 方式挂在 tools/pre-execute 上。输出只能是固定的 JSON：low 只能 allow；medium 可以 allow 或 deny，但需要人类授权到具体动作、目标和范围；high 一律 deny，即使有授权。审查输入排除 tool 来源的消息、助手正文和推理、工具结果，用来抵抗提示注入。格式不合、调用出错、情况含糊都失败关闭。该档只作用于当前会话，开启前要风险确认；插件卸载时 Auto 会话退回 Full access。被拒的调用在工具卡上标明，并说明「本体未执行」。 ⇒ 借鉴：可以给 cron 和无人值守场景做一个可选的「自动审查」档：只审权限网关判为 gated 的调用，照搬三级 JSON 协议和失败关闭；默认关闭，只作用于单个会话或任务，开启时二次确认。（核验：已核实 REVIEW_POLICY 原文与历史过滤逻辑。）
- R4 [confirmed|safety|新:no|DM:partial] 审批服务：封闭结果词汇、失败关闭、审计成对、策略切换以追加消息告知模型：DSH 的做法：结果只有 allowed-once、rejected、cancelled、unavailable 四种；没有应答者或应答异常都归为 unavailable。策略为 never 时服务自己判定为 rejected，并告诉模型不要申请升级。setPolicy 以 agent.inject 追加一条策略变更消息，不改写系统提示。ACP 应答者只提供一次性选项。 ⇒ 借鉴：（1）用户在会话中途切换档位时，追加一条告知消息；
（2）cron 开跑时先告诉模型「需要审批的操作会被自动拒绝」；
（3）核对迟到的 PermCard 点击是否已按 requestId 丢弃。（核验：已核实。）
- R4 [confirmed|safety|新:yes|DM:missing] web_fetch 防 SSRF：只解析一次 DNS，校验公网单播后钉住地址：DSH 的做法：只做一次 DNS 解析，每个地址都必须是全球可达的单播地址；IPv4-mapped 地址按内嵌的 v4 判断，NAT64 等过渡前缀一律拦截；校验通过的地址通过自定义 lookup 交给 undici，连接时不再解析，防 DNS rebinding。只跟随同源重定向，有跳数上限，每跳重新校验。

DeskMinis 现状：web_fetch 只校验协议，然后过权限卡；完全访问档或「本会话沿用」之后可以访问内网和 169.254.169.254。 ⇒ 借鉴：不需要新依赖：dns.lookup({all:true}) 加 net.BlockList 做校验，用 https.request 的 lookup 选项钉住地址，redirect 设为 manual 并逐跳校验。允许显式放行 localhost，权限卡上单独标注「内网或本机地址」。（核验：已核实。）
- R4 [confirmed|tools|新:no|DM:missing] 先读后写：没读过不能编辑，文件变了拒绝覆盖：DSH 的做法：fs-observation-policy 按会话记录每个目标的观测。write 的规则：没见过或确认不存在走 createIfAbsent，见过存在走 replaceIfVersion（按版本 CAS）。edit 没读过就报 FS_NOT_OBSERVED。观测不持久化。

DeskMinis 现状：file_edit 和 file_write 没有新鲜度保护；审批卡可能停留几分钟，期间用户自己的修改会被覆盖。 ⇒ 借鉴：file_read 时记录 {mtimeMs, size, sha1}（每会话一个内存 Map）；file_edit 以及覆盖已存在文件的 file_write，要求读过且记录未变，否则返回「请先 file_read 再重试」。纯 TS，适合 TDD。（核验：已核实。）
- R4 [confirmed|safety|新:yes|DM:missing] Electron <webview> 侧栏浏览器：租约、非持久分区与客体加固（合并两条）：DSH 的做法：只有主窗口开启 webviewTag。渲染端先申请一次性租约（随机 UUID），再拿到按工作区分配的随机非持久 partition。will-attach-webview 时逐项核对租约、窗口和分区，然后用主进程自己的配置覆盖 webPreferences：关闭 node、打开 sandbox、contextIsolation、webSecurity，禁止 preload。guest session 拒绝所有权限请求和下载；只接受无凭据的 http(s)，拦截 file:、应用自身 Host 和 loopback 别名；新窗口一律 deny，转成侧栏新标签页。 ⇒ 借鉴：做「内置浏览器」时，直接以这套模型作为设计稿的安全基线。全部是 Electron 内置 API；preload 只暴露「申请租约 / 释放租约」两个白名单 IPC。（核验：合并了工具与客户端两条；租约和分区代码已核实。）
- R4 [confirmed|tools|新:yes|DM:missing] 浏览器操控：只做注册位，由第三方 MCP provider 提供，浏览器按会话归属：DSH 的做法：dsh-browser-use 只登记 provider 名字，不定义操作接口。Playwright MCP provider 用当前 Node 可执行文件启动，默认 --isolated 加 headless，并清掉 PLAYWRIGHT_MCP_* 环境变量；另有 Chrome DevTools MCP 和 Stagehand。浏览器归属于会话，attach 到用户已有浏览器是独占的。 ⇒ 借鉴：在市场里上架 Playwright MCP 或 chrome-devtools-mcp 的精选预设，默认 --isolated --headless 并擦除 PLAYWRIGHT_MCP_*；attach 到用户浏览器必须显式开启。前提是先支持 MCP 图片结果。（核验：已核实。）
- R4 [confirmed|ux-flow|新:no|DM:partial] 权限预设 = 沙箱模式 × 审批策略；完全权限需勾选确认；默认档与本会话档分开（合并两条）：DSH 的做法：
- 预设：每个预设打包一个沙箱模式和一个审批策略；组合匹配不到时显示 custom，可以离开但不能选。
- 作用范围：设置页只改「新会话默认」，输入区控件和 /permission 只切当前会话，由会话投影确认后才显示新值。
- 风险确认：选完全权限时，RiskConfirmation 要求先勾选「我已了解风险，并愿意继续」，主按钮才可点。Auto 档只对当前会话生效。

DeskMinis 现状：点「完全访问」立即调用 setPermTier，之后才显示警示框；档位是全局的，会话级覆盖还在候选池。 ⇒ 借鉴：（1）选 full 时弹就地确认卡（复选框 + 确认），确认后才生效；
（2）会话级覆盖：sessions 表只追加 perm_override 列，网关解析时会话值优先；Composer 加档位胶囊；设置页文案改为「新会话默认」；
（3）以后加沙箱模式，仍只给用户一个选择器。（核验：合并了工具与客户端两条，文案已核实。）
- R4 [confirmed|safety|新:no|DM:partial] 审批与提问「接管输入区」，而不是插在消息流里：DSH 的做法：审批面板以 priority 1 注入到 conversation.composer 链，有待审批时替换输入区，默认 composer 仍挂在下面不卸载，草稿不丢。请求走 waterfall，本客户端不接就调 next()；答复失败会恢复按钮。

DeskMinis 现状：PermCard 渲染在 StageChat 消息流末尾，长输出时可能被滚出视口。 ⇒ 借鉴：保留 PermCard 现有的规矩，只改挂载位置：pendingPerms 非空时，在 Composer 位置渲染紧凑形态（Composer 用 v-show 保留草稿），消息流里留一行锚点；多个待批时显示「第 1/3 个」。守卫测试 renderer-chat-capabilities 要同步改指向。（核验：已核实。）
- R4 [confirmed|ui|新:yes|DM:partial（缺陷）] 主题在首帧前同步生效；Windows 标题栏按钮颜色跟随主题：DSH 的做法：boot-theme 在 head 注入画布底色，在 body 脚本里于 shell 挂载前设好主题和字号。preload-windows 用探针元素加 1×1 canvas 规范化颜色，MutationObserver 监听变化后经 IPC 调 setTitleBarOverlay，主进程校验发送方和颜色格式。

DeskMinis 现状：保存的主题只在 SecLook 挂载时（即打开「设置→外观」）读回，启动时不恢复；AppShell 的 ☰ 切换也不持久化。titleBarOverlay 的 symbolColor 固定为 #808080。 ⇒ 借鉴：先修缺陷：在 index.html 放内联脚本，或在 main.ts 挂载前读取 deskminis.theme 并设 data-theme，☰ 切换也要持久化；先写一条源码守卫，要求启动路径消费这个 key。标题栏颜色走白名单 IPC，并在真机截取深浅两态验证。（核验：已核实，并补充了 AppShell 切换不持久化这一点。）
- R4 [confirmed|ux-flow|新:yes|DM:missing] 拖入或粘贴非图片文件转成 @路径引用（不上传）：DSH 的做法：preload 暴露 pathFor(file)，内部是 webUtils.getPathForFile。输入区对拖入、粘贴、选取的文件夹和非图片文件，插成原子的 @path chip：工作区内写相对路径，工作区外写绝对路径，整批先校验。只有图片仍走上传。

DeskMinis 现状：Composer 只收 image/*，非图片直接丢掉。 ⇒ 借鉴：preload 白名单加 pathForFile（webUtils 是 Electron 内置）；非图片且有路径的，复用 at-files 模块插入 @路径；工作区外的路径由 minisd 的权限网关在读取时询问。（核验：已核实。）
- R4 [confirmed|ui|新:no|DM:missing] 流式渲染性能：按帧批量发布、增量 Markdown（冻结前缀）与 10 万 chunk 压测：DSH 的做法：Notifier 分三档：结构性更新用微任务批量（markDirty），可见的流式更新按 rAF 每帧最多一次（markFrameDirty），只有用户手势回显同步通知（notifyNow）。IncrementalMarkdownParser 冻结除最后 2 块外的所有块，未闭合的代码围栏另设第二条前沿（08-31）。压测：10 万个推理 chunk，主线程延迟预算 250ms。

DeskMinis 现状：每个 textDelta 都直接拼接 streamingText，streamNodes 用 computed 对全文 parseMarkdown。 ⇒ 借鉴：（1）textDelta 先写入非响应式缓冲，每帧合并一次；
（2）给自研 parse 加一层「冻结前面的块，只重解析最后两块，未闭合围栏整块留在尾部」的增量包装，用性质测试保证与全量解析逐块相等；
（3）用 FakeProvider 发 1 万个 delta 压测。（核验：已核实；增量 Markdown 在基线时已有，围栏增量是 08-31 新增。）
- R4 [confirmed|platform|新:yes|DM:missing] npm 源按计划尝试并探测镜像：npmjs 与 npmmirror 竞速，私有源不回落：DSH 的做法：源计划依次是用户指定源、首选源、回落源（npmmirror）；只有网络错误、超时、找不到包或版本这几类才换源。pnpm 配了非官方源（如私有源）时只问它一个，防依赖混淆。首次安装时并发 GET 两个源的 -/ping（redirect:'error'，默认 1.5s 超时），先回 2xx 的胜出。GitHub 安装串先做 git ls-remote 预检。

DeskMinis 现状：源码里没有任何 npmmirror 或 registry 处理。 ⇒ 借鉴：加一个「npm 源」设置（自动 / 官方 / npmmirror / 自定义）。自动模式用 fetch 竞速 ping 并缓存，只给 npx 型子进程注入 npm_config_registry。用户已配置私有源时绝不改写。需要在 Windows 真机验证 npx 确实认这个变量。（核验：已核实常量与探测代码。「缓存 5 分钟」未单独核实。）
- R4 [confirmed|ux-flow|新:yes|DM:partial] 安装事务化：先检查后安装、失败或取消回滚、Host 回执才算取消、装完再启用：DSH 的做法：
- inspect 被拒时，在输入框下用一句话说明；
- installBundle 装前快照 package.json 和 lockfile，失败或取消时恢复；
- requestId 驱动日志和状态流；
- cancelInstall 要等子进程退出并完成恢复才回 cancelled，加载阶段之后回 too-late；
- waitForInstall 可找回丢失的响应；
- 对话框一律以未启用状态安装，末屏再给「立即启用」；
- 结果把「已保存 / 已生效 / 需重启」分开报告。

DeskMinis 现状：已有 installPlan、确认卡和恶意标记硬阻断。 ⇒ 借鉴：补上：安装带 requestId；取消以 minisd 回执为准；MCP 装完默认未启用，末屏给「启用并试连」；结果分三态报告；丢失的响应可以找回。（核验：抽查属实。）
- R4 [confirmed|ux-flow|新:yes|DM:partial] 安装与启动失败分类器：一句话原因加折叠原文，并把失败归到源或主机上：DSH 的做法：classifyInstallFailure 按固定顺序匹配 ERR_PNPM_* 和 errno，归为 build-blocked、not-found、no-matching-version、disk-full、permission、integrity、network、timeout、pnpm-missing、unknown。attributeFailure 判断失败算在 registry 还是 spec-host 上。界面只显示一句原因，原文折叠。

DeskMinis 现状：stdio.ts 保留了 8KB 的 stderr 尾部，但没有分类。 ⇒ 借鉴：写一个纯函数 classifyMcpStartFailure，覆盖 E404、ETARGET、ENOTFOUND、ETIMEDOUT、EACCES、EINTEGRITY，以及 spawn 的 ENOENT（未装 Node 或 uv）；配「改用国内镜像重试」按钮；先写 fixture 单测。（核验：已核实正则表。）
- R3 [confirmed|agent-loop|新:no|DM:partial] 工具并发按安全性分类，默认独占：DSH 的做法：executionMode 只在 isConcurrencySafe(args) 恰好返回 true 时才并行；未知、隐藏、未声明、分类器抛错的，一律按独占处理，作为排序屏障。并行走有界的滚动池（maxParallelToolCalls 默认 10，属于易变配置），结果按模型给出的顺序提交；中止后未派发的调用补一条 ABORTED_BEFORE_DISPATCH。分类只看单个调用，依赖兄弟调用比较的场景必须声明为独占。

DeskMinis 现状：runWithConcurrency 对所有调用统一 10 并发。shell 有会话内队列，是串行的；但 file_write、file_edit、office_write 与 shell 并发时先后不确定，还可能同时弹出多张权限卡。工具结果要等全部完成才整批落库。 ⇒ 借鉴：（1）ToolExecutor 增加可选的 concurrencySafe，只有只读类工具返回 true，MCP 默认 false；
（2）loop 按顺序把调用切成「可并行段」和「独占单个」；
（3）每个结果完成后立即增量落库；
（4）用两个 file_write 加一个 shell 的剧本钉住执行顺序。（核验：已核实。）
- R3 [confirmed|agent-loop|新:no|DM:partial] 中断工具的补齐结果要有语义：区分已开始与未开始，并给出重试建议：DSH 的做法：repair.ts 的 CLOSER_TEXT 按原因分文案。
- interrupted：已开始的写「结果未知；只读或幂等操作才可重试；可能有副作用的，先核实外部状态或询问用户；不要盲目重试」，未开始的写「如仍需要可以重试」；
- forked：另有两句文案。
补完结果后，再补 step/end 和 turn/end。

DeskMinis 现状：pairToolResults 只在构建请求时补一句「[工具执行被中断，结果未知]」，没有重试建议；工具开始并不持久化，所以也区分不了已开始还是未开始。 ⇒ 借鉴：成本很低：把占位文案换成带幂等性建议的中文版本。如果采纳增量落库，就能进一步区分已完成、已开始、未开始三种状态。不需要改库。（核验：已核实文案原文。）
- R3 [confirmed|architecture|新:no|DM:missing] 「模型可见即落盘」与请求重建不变量：DSH 的做法：进入模型请求的一切都必须能从日志用纯函数重建。invariant.ts 在发送前断言：
- 请求已冻结；
- messages 与 deriveMessages() 完全相同；
- 不存在 system 字段（系统提示作为节点 0 放在 messages 里）；
- header 与折叠结果一致。

DeskMinis 现状：系统提示、剪枝、图片占位、CONTINUE_HINT、空响应提醒、pairToolResults 都只在请求侧合成，不落库，事后无法还原模型实际看到了什么。 ⇒ 借鉴：不照搬全量事件溯源，取两个轻量做法：
（1）只追加迁移新建 prompt_snapshots 表，system 哈希变化时写一行；assistant 消息加 prompt_snapshot_id、tools_hash 和请求侧变换标记位；
（2）开发构建里做发送前断言：tool_use 与 tool_result 严格配对、没有空 text block、入参是合法 JSON。（核验：已核实。）
- R3 [confirmed|ux-flow|新:no|DM:missing] 手动 /compact 与空闲期维护任务：DSH 的做法：compactNow() 在两轮之间以 runMaintenance 形式运行，占住空闲阶段，此后的新 prompt 按 FIFO 排队。低于压力阈值也会执行一次有意义的压缩；没有可压区间时返回 null，不写任何东西。失败码为封闭集合：busy、cancelled、changed、summary、commit、persistence。/compact 回报压缩了多少条、约省多少 token。

DeskMinis 现状：只有自动压缩，没有手动入口。 ⇒ 借鉴：minisd 新增 chat.compact RPC：inFlight 时拒绝或排队，复用改造后的 CompactEngine。入口放在任务面板的「立即压缩」和斜杠菜单里；结果用中文说明「压缩了 N 条，约省 X token」。（核验：已核实。）
- R3 [confirmed|sync-storage|新:yes|DM:missing] 在回合边界分叉会话（合并两条）：DSH 的做法：
- 后端：SessionStore.fork(source, boundary?) 要求前缀在回合之外结束，落在未闭合回合里的边界显式拒绝。buildForkSeed 复制前缀、加 session/end-seed{inherited}，并为未闭合尾部补原因为 forked 的合成结果（子代理 fork 用）。子会话记录 parentSession、isSeeded 和精确的继承条数。
- 客户端：已完成回合的页脚有分叉按钮，把真实的 turn/end seq 发给 Host，由 Host 精确切分。

DeskMinis 现状：会话分叉在候选池里，尚未实现。 ⇒ 借鉴：用 SQLite 实现：
（1）只追加迁移，给 sessions 加 parent_session_id 和 fork_message_id；
（2）只允许在「以答复结尾、且没有未配对 toolUse」的消息处分叉，边界由后端判定；
（3）复制前缀消息并重新生成 id；前缀内的压缩标记一并复制；offloads 和 attachments 直接复制文件，不用硬链接；
（4）同步层把分叉出的会话当作新会话；
（5）UI 入口放在消息 ⋮ 菜单「从这里分叉」。（核验：合并了核心与客户端两条。docs 与 fork.ts 已核实；补充说明：合成闭合事件主要用于子代理 fork。）
- R3 [confirmed|architecture|新:yes|DM:partial] 启动与运行期失败的处置矩阵：DSH 的做法：app-boot 按「可选组件或必需组件 × 启动期或热重载期」列出处置表。模块导入失败、schema 校验失败、apply 抛错、依赖服务缺失、端口绑定失败：可选组件告警后继续，必需组件停机。热重载期拒绝无效改动、保留原实例。detached 的 rejection 和同步回调里的 uncaught 一律视为致命。启动失败汇总成一条 StartupError，保留 cause 链。

DeskMinis 现状：各子系统自行兜底（例如 servers.json 损坏时按空配置加载），另有 diagnostics.dryRun 做静态预检，但没有统一的分级约定。 ⇒ 借鉴：把 DB、密钥库、RPC 端口定为必需组件，失败就以非 0 码退出，交给 main 的致命对话框；MCP、同步、桥、cron 定为可选组件，失败时隔离、告警，并把状态暴露给设置和诊断。把这张表写进 docs，再加一条守卫测试：注入可选组件的初始化异常后，聊天主链路仍然可用。（核验：已核实表格与两个提交日期。）
- R3 [confirmed|dx-testing|新:no|DM:missing] Model Experience 文档契约与 KV 缓存纪律（合并两条）：DSH 的做法：每个包的 README 都必须有 Model Experience 小节，含 What the model sees、Token effect、KV Cache effect 三个字段，由 scripts/verify-package-readme-model-experience.ts 门禁；不涉及模型的包要登记白名单并写明理由。缓存纪律落在多处设计里：
- 计划模式不增删工具，只切换提示段；
- todo_write 只回一行计数；
- preset 修订保证运行中 agent 的组合不变；
- 子代理的委派声明走 runtime context，而不是 system prompt。

DeskMinis 现状：没有这类文档契约，请求侧注入的缓存影响也没有被系统地评估。 ⇒ 借鉴：（1）为 system-prompt、memory-injector、skills、assistants、compact、prune、offload 以及各类 HINT 建一份 docs/model-experience.md，写明注入原文、token 量级和缓存影响；
（2）加 vitest 守卫：注入常量必须在文档中逐字出现；
（3）设计稿模板固定加三行（模型可见内容 / Token 影响 / 缓存影响）；新工具的工具列表按会话固定。（核验：合并了核心与 agent 两条。已核实。）
- R3 [confirmed|platform|新:yes|DM:missing] 用本机应用打开 / 在文件夹中显示，以及 HTML 安全预览（合并两条）：DSH 的做法：
- 应用目录：host/open-in-app（09-07）维护固定的应用目录，只展示探测到存在的条目；spawn 时不传递凭据类环境变量。
- 客户端：拆分按钮，主按钮用默认程序打开，下拉列出关联程序，底部固定「在文件夹中显示」。Windows 用 PowerShell 内联 C#（SHAssocEnumHandlers）枚举关联程序，路径作为数据传入。
- HTML 预览：默认用 DOMPurify 净化，放进无权限 sandbox 的 iframe，由 CSP 禁用脚本；开发者开关打开后才用 Blob 执行脚本。

DeskMinis 现状：没有 openPath 或 showItemInFolder；PreviewPane 只渲染 md 和 Office 内容预览。 ⇒ 借鉴：（1）先用 Electron 的 shell.openPath 和 shell.showItemInFolder，路径先过工作区围栏；
（2）关联程序列表放到后期，参数经 base64 或环境变量传入；
（3）HTML 预览不需要 DOMPurify：iframe 设 sandbox=""，srcdoc 里放 CSP（default-src 'none'）；
（4）spawn 第三方程序时清理 env。（核验：合并了两条。open-in-app 包的创建日期已核实为 09-07。）
- R3 [confirmed|multi-agent|新:yes|DM:missing] 子代理资源上限与用户授权的模型白名单：DSH 的做法：活跃的 continuable 子代理按根共享一个池子，09-15 定为 16，09-16 改为默认 8；超限抛 ACTIVATION_LIMIT_REACHED，文案是可操作的「等现有子代理结束，或用现有代理完成」。委派深度 09-17 改为默认 1。两者都是 volatile 配置，可以在设置里编辑。用户授权的 provider/model 白名单加 list_subagent_models 工具（model-selection.ts 为新文件）。 ⇒ 借鉴：做子代理时直接采用「深度 1、并发 2–4」；子代理默认继承会话绑定的模型或模型组，走 binding.ts 归一化；超限报错要带可操作建议。（核验：各提交日期已核实。）
- R3 [confirmed|multi-agent|新:no|DM:missing] workflow 工具：模型写 JS 编排脚本扇出子代理：DSH 的做法：meta 加纯 JS 脚本体，钩子有 agent、pipeline（无屏障）、parallel（有屏障）、phase、log、args。子代理失败解析为 null，钩子用错则杀掉脚本。默认上限：并发 min(16, cores−2)，单次运行最多 1000 个 agent，单调用 4096 项，同步段 5s。脚本在受沙箱策略约束的新 Node PTC 进程里运行，描述写明不提供 fs、网络、定时器。run_in_background 时登记为 job（09-01）。 ⇒ 借鉴：DeskMinis 暂缓。没有进程级沙箱就不要开放脚本编排；如果要做，做成固定的参数化编排工具。总 agent 数兜底、失败即 null、按阶段分组显示这些思路值得保留。（核验：已核实默认值与描述原文。）
- R3 [confirmed|product|新:no|DM:partial] 模型在对话中创建同会话提醒（schedule_create/list/delete）：DSH 的做法：提醒分 after、at、every 三种；at 必须带显式偏移或 IANA 时区，不猜环境时区；every 间隔至少 300 秒，以首次设定时间为锚对齐。只在空闲时以 followup 投递，不补积压，fork 不继承。创建前后各 flush 一次，状态不确定时返回 persistence_uncertain。

DeskMinis 现状：定时任务只能由用户在界面上建，每次触发都新开会话。 ⇒ 借鉴：加 schedule_create 工具，写进现有 cron 表，追加 target_session_id 列；有该列就只在空闲时投递到原会话，复用 30s tick；同样要求显式时区。（核验：已核实。）
- R3 [confirmed|agent-loop|新:no|DM:missing] Ralph：每轮全新子代理加结构化交接的迭代循环：DSH 的做法：编排脚本固定，模型只提供 objective 和 maxRounds。每轮只带目标和上一轮交接，交接上限 16384 字符。交接结构为 status、summary、evidence、nextSteps、blocker，校验很严：complete 必须有 evidence，continue 必须有 nextSteps。默认最多 256 轮；standard 预设配 64 轮，并且默认禁用。 ⇒ 借鉴：不必做这个工具。交接 schema（没有 evidence 不算完成）可以借用到 goal 的完成判定，以及 compact 摘要的三段结构。（核验：已核实。）
- R3 [confirmed|extensibility|新:yes（重组）|DM:partial] Agent 预设：按会话选择整套工具、提示、技能组合，运行中保留旧修订：DSH 的做法：预设是一组子插件声明，会话选定一个。修改只影响新建的 agent，运行中的 agent 保留原修订，保证工具目录稳定。内置 standard、ptc、cordis、minimal 四套。09-21 从基线时的 agent-presets 拆成 agent-preset 和 agent-preset-registry，改用 profile YAML 声明。

DeskMinis 现状：助手不能选择工具集。 ⇒ 借鉴：给助手加「工具开关」，存为 assistants 追加列；会话创建时做快照，之后编辑助手不影响已有会话，以保护前缀缓存。（核验：已核实：基线时是 agent-presets，属于重组而非全新。）
- R3 [confirmed|tools|新:yes|DM:missing] 桌面操控：Cua Driver（MCP 或原生）加一段操作纪律提示：DSH 的做法：computer-use 同样只做注册位。原生 SDK 在宿主进程内运行，崩溃会连带宿主。工具名校验为 [A-Za-z0-9_-]{1,64}。GUIDANCE 段写明：动手前取新鲜快照；新快照会让旧 token 失效；优先后台投递，被拒不等于可以改用前台；点击送达不代表结果达成，要再看状态确认；取消后已送达的输入不会回滚；其他会话可能同时在改同一个桌面。 ⇒ 借鉴：不引入原生 SDK，走 MCP 路线。GUIDANCE 几乎可以原样作为提示节；所有桌面输入类工具都走 gated。可以先用 desktopCapturer 做只读截图工具。（核验：已核实 GUIDANCE 原文。）
- R3 [corrected|tools|新:partial|DM:partial] MCP 客户端加固：server instructions 限长并标注来源、resources、重连预算、代际替换：DSH 的做法：server instructions 作为字面文本注入，前面标注服务器名，超过 32768 字节拒绝整个连接。resources 由共享工具统一发现和读取。断线重连从 500ms 指数退避到 30s，每次故障最多 10 次。工具集按代际原子替换，拉取失败保留上一代。官方 SDK 负责协议协商。

DeskMinis 现状：已有 stdio 与 streamable-http、list_changed 重列、超长名 sha256 截断，但没有自动重连，也没有 instructions 和 resources。 ⇒ 借鉴：（1）带次数预算的自动重连；
（2）instructions 注入时限长并标注服务器名；
（3）resources 和图片结果；
（4）更新失败时保留上一代工具集。都是 minisd 内部改动。（核验：更正基线归属：重连退避和代际替换在基线 README 中就已存在；基线后新增的只有 instructions、resources 和 SDK 协议协商（09-12）。）
- R3 [confirmed|safety|新:no|DM:partial] 工具管线：pre-execute 瀑布 → 审批 → 批准也推不翻的 guard：DSH 的做法：pre-execute 瀑布里插件可以返回 allow、deny、cancel 或 ask；ask 交给审批，没有审批服务就 deny；同步的 guard 层在 allow 之后再判一次，结果单调，审批通过也推不翻。hooks、Auto review、插件管理都挂在这个接缝上。

DeskMinis 现状：已有「danger 不可批准」的硬拦截。 ⇒ 借鉴：把网关形式化成有序阶段：扩展检查 → PermCard → danger guard 在批准之后再判一次；写一条守卫测试「批准后 danger 仍被拦」。（核验：抽查属实。）
- R3 [confirmed|tools|新:no|DM:has] 常驻 pwsh 会话：OSC 就绪标记、只重置不修补、改沙箱模式时有终端栅栏：DSH 的做法：每个 agent 一个常驻 pwsh；凡是状态不确定就关闭 shell 并告诉模型。终端后端设了 sandboxModeFences：owner 还有打开的终端时，拒绝更改沙箱模式，防止宽权限打开的终端在降级后继续存活。

DeskMinis 现状：已有常驻 shell 和 wasReset 提示。 ⇒ 借鉴：用户从「完全访问」降档时重建会话 shell。将来加沙箱时，要重新审视「终端与 agent 共用 shell」这一点。（核验：抽查属实。）
- R3 [confirmed|agent-loop|新:no|DM:missing] 重复工具调用提醒（只提醒、不拦截）：DSH 的做法：同一工具、参数规范化后完全相同的连续调用，在第 3、5、8 次注入提醒，参数预览截到 500 字符；收到新的用户消息后清零。base bundle 默认启用。 ⇒ 借鉴：loop 里约 60 行即可：以排序键后的 JSON 作链键，提醒作为带来源标记的消息注入。对无人值守的 cron 场景尤其有用。（核验：已核实默认值 [3, 5, 8]。）
- R3 [confirmed|extensibility|新:no|DM:partial] 技能：项目级根目录、调用面控制字段与目录监听（合并两条）：DSH 的做法：技能根目录按优先级依次是项目 .dsh/skills、项目 .agents/skills、自定义目录、用户 ~/.dsh/skills、用户 ~/.agents/skills、内置目录。解析 disable-model-invocation 和 user-invocable：前者控制是否进模型目录，后者控制是否进 / 命令；取值写错时丢弃整条技能，即按「不开放」处理。目录有监听，清单完整替换后追加进上下文。skill-office 为办公技能绑定一个 Python 环境（09-16）。

DeskMinis 现状：只有全局库；解析器忽略未知键，两个调用面字段不生效，标了「只许人调用」的技能也会进模型目录。 ⇒ 借鉴：（1）先支持两个调用面字段，出错按不开放处理，分别作用于 <available_skills> 注入和 / 菜单；
（2）项目级 .agents/skills 相当于仓库向 agent 注入指令，首次发现时要让用户确认启用，并在菜单中标明来源。（核验：合并了工具与生态两条。调用面字段在基线时已存在。）
- R3 [confirmed|extensibility|新:no|DM:missing] Claude Code / Codex hooks.json 兼容桥（只支持 command hook）：DSH 的做法：支持 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop 等事件。多个 hook 合并时按 deny > ask > allow 取最严，continue:false 一旦出现就生效到底。只执行 command 类 hook；配置读不了就不跑任何 hook。 ⇒ 借鉴：优先级低。如果要做，只读用户级配置，工作区里的 hooks 不能自动加载；PreToolUse 的 ask 映射到 PermCard。（核验：已核实合并语义。）
- R3 [corrected|providers|新:partial|DM:has（密钥库）/ missing（授权流）] 凭据：配置只写引用、人工授权流注册表；本地存储在 Windows 上等于明文（合并两条）：DSH 的做法：配置里只写 CredentialRef。authorization 接缝有几条规则：同一 key 同时只允许一次尝试，否则报 ALREADY_IN_FLIGHT；流程结束时必须已经提交记录，否则报 NOT_COMMITTED；用户拒绝记为 cancelled；提示只发给发起授权的界面。DeepSeek 账号登录用 PKCE 加临时回环路由；pi-ai 的多厂商 OAuth 也走这套接缝。credentials-local 用 YAML 存储，在 win32 上直接跳过权限检查（基线时就是如此）。

DeskMinis 现状：用 @napi-rs/keyring 把密钥存进 Windows 凭据库。 ⇒ 借鉴：不要退回文件存储。以后做 MCP OAuth 时照这几条语义：一把钥匙一次尝试；写入 KeyringVault 后才算成功；取消不报错；回调只挂临时的 127.0.0.1 路由；verifier 不经过渲染端。（核验：合并了两条。更正：credentials-local 以及它在 win32 跳过检查的行为基线时就有；新增的是 authorization（author 08-13，基线后合入）和 records/deepseek-account。）
- R3 [confirmed|ux-flow|新:yes|DM:missing] 后台等待时的注意力提示：任务栏闪烁加单次静默通知，回到前台即清：DSH 的做法：update-attention 只在窗口不在前台时提醒：Windows 用 flashFrame(true)，同一事件只发一条 silent 通知；主窗口一获得焦点就清除；点通知只回到确认界面，不替用户做授权。

DeskMinis 现状：权限卡的倒计时在后台会静默超时，没有任何提醒。 ⇒ 借鉴：收到 permission.request 时，如果主窗口未聚焦或已隐藏到托盘，经 IPC 请求主进程提醒：每个 requestId 只提醒一次，focus 或 resolved 时清除；点击通知只执行 show 加 focus。需要在真机验证专注助手模式下的表现。（核验：已核实。）
- R3 [corrected|ui|新:yes|DM:partial] 滚动所有权：尾部跟随、读者手势采样、回到底部按钮、历史分页锚点：DSH 的做法：读者在底部时由 ResizeObserver 跟随；读者的移动先记为 pending，到采样间隔或 scrollend 才定论，避免内容增高吞掉小幅上滑；发送消息立即恢复跟随；回到底部按钮放在裁剪区外；「加载更早」以首个可见内容为语义锚点。

DeskMinis 现状：用 120px 阈值判断跟随，没有回到底部按钮，也没有 ResizeObserver；messages.list 一次拉全部历史。 ⇒ 借鉴：近期：加 ResizeObserver 跟随、pending 加 scrollend 定论、回到底部按钮，都是原生 API。之后 messages.list 加 beforeId/limit 做分页，只做外层补偿。（核验：补全基线判定（读者写的是 unknown）：「Scroll ownership」文档在基线时不存在，08-31 之后才出现，use-scroll-follow.ts 是 09-22 新增，所以判为基线后新增。）
- R3 [confirmed|ux-flow|新:no|DM:partial] 斜杠命令直接弹选择器（/model、/permission），带中英别名，命令不静默降级：DSH 的做法：/ 行分三类：popupSelect、action、host 命令；以 / 开头的命令行永远不会被静默当成普通提示词发给模型。中文拼写与英文走同一目录；「＋」按钮与 / 打开同一个菜单；带附件时，只有声明接收附件的命令能提交。

DeskMinis 现状：/ 只列技能。 ⇒ 借鉴：在斜杠菜单加一层「命令」分组：/模型、/权限、/压缩；命令写成纯数据 lib/composer/commands.ts 并先测。以 / 开头又匹配不到命令时，提示用户，不发送。（核验：已核实。）
- R3 [confirmed|ui|新:yes|DM:partial] 输入区下方的上下文占用环；回合用量「不精确就不显示」：DSH 的做法：拿到用量和窗口容量后，输入卡下方显示一个环形百分比，点开是 token 分解面板。回合用量必须加载到 turn/start，并且每次尝试都上报了精确用量，否则整块隐藏，不显示部分合计。

DeskMinis 现状：水位只在右栏的任务 tab 里，不打开就看不到。 ⇒ 借鉴：在 Composer 的模型胶囊旁加一个 16px 的 SVG 环，复用 contextInfo 的数据。做成本面板时照搬「不精确就不显示」原则。（核验：已核实两个文件在基线时不存在。）
- R3 [corrected|dx-testing|新:yes|DM:partial] 真实 Electron 加本地回环服务器的更新资格测试；浏览器 e2e 用回放快照：DSH 的做法：test:updates:local 用真实的 NsisUpdater 对着回环 HTTP 服务器，覆盖校验失败拒装、重试、并发合并和安装交接（只记录调用，不真装）。Web 端约 143 个 e2e 文件，用 DSH_SNAPSHOT=replay 回放录制的模型流，按改动面分层运行。 ⇒ 借鉴：（1）scripts/qualify-updater.mjs：用 node:http 提供 latest.yml 和假安装包，覆盖检查、下载、校验失败、运行中任务警告四条路径；
（2）用 webContents.executeJavaScript 加 capturePage 驱动 e2e，FakeProvider 回放，截图交人工目检。（核验：更正数量：apps/web/tests 下 e2e 文件为 143 个，不是 179 个。其余属实。）
- R3 [confirmed|ux-flow|新:yes|DM:partial] UI/UX 评审判据：反馈面怎么选、加载态、浮层三验、双主题校验：DSH 的做法：把界面判断写成评审技能。反馈面按消息寿命选择：一次性结果用全局 Toast，且 Toast 宿主要比发起面板活得更久；操作失败保留原数据。另有：功能 CSS 字重上限 500；每个颜色都在深浅两个主题下校验；加载态同一页面只用一种；浮层要能用点外部或 Esc 关闭、贴合视口、不被裁切。

DeskMinis 现状：toast 只在 StageMarket 里私有实现。 ⇒ 借鉴：把判据写进 docs 作为评审清单；在 AppShell 放一个 Toast 宿主（占用空置的 50 槽位），替代 Market 的私有实现；浮层三验加进 renderer-form-invariants 守卫。（核验：已核实。）
- R3 [confirmed|safety|新:yes|DM:missing] 面向 agent 的插件管理工具：每个动作都要审批，连查看列表也要：DSH 的做法：plugin_manager 所有动作（包括 list）都经 approveEscalation 申请 danger-full-access。审批不改变会话的权限档，但批准的改动会影响这个 profile 下的所有会话。approvedBuilds 和 acceptRisk 的描述要求先在对话中得到用户的明确同意。原先的「生成代码插件」工具已撤掉，tool-cordis 只剩两个只读工具。 ⇒ 借鉴：如果以后让 agent 帮忙安装，工具只产出 installPlan，然后走 PermCard 和确认卡，不能让 agent 自己传 confirm:true；恶意标记硬阻断继续留在服务端。（核验：已核实工具描述原文。）
- R3 [confirmed|safety|新:yes|DM:missing] 依赖安装脚本按包名逐个审批：DSH 的做法：pnpm 11 拦下的包作为 pendingBuilds 报给界面，失败页显示「允许这些脚本并重试」。批准按精确包名写进 allowBuilds；已有的拒绝和通配规则不能被覆盖，YAML 锚点和别名会被拒绝；失败回滚时刻意不恢复这个文件，重试时还能用上批准。 ⇒ 借鉴：确认卡加一行事实说明：npx 首次启动会下载依赖，依赖的安装脚本以用户权限执行；可选开关注入 npm_config_ignore_scripts=true，默认值要在真机试过常用 MCP 后再定。（核验：文件存在，抽查属实。）
- R3 [confirmed|sync-storage|新:yes|DM:missing] 设置统一到一个真相源：修订围栏、敏感字段脱敏、旧文件一次性迁移：DSH 的做法：settings-file 整包删除，Settings 只是 volatile 字段的投影。每个命名空间带 revision，过期写入会被拒绝；写入会被更高层遮住时也拒绝；敏感字段只回「已设置」。旧的 settings.yaml 在首次写入前先改名为 .imported，只迁移一次。

DeskMinis 现状：设置分散在各 RPC 里，没有修订围栏。 ⇒ 借鉴：设置类写入加 revision：读时带回，写时校验，冲突返回错误码，前端提示「已被别处修改，已刷新」。文件配置迁移借用「导入后改名 .imported」的一次性语义。（核验：已核实，并把 deskminis_status 从 unknown 更正为 missing（grep 无 revision）。）
- R3 [confirmed|ui|新:yes|DM:partial] 插件配置与插件放在一起：只点保存才写，不做 schema 自动生成的通用表单：DSH 的做法：插件配置从 Settings 挪到 Plugins 页，通过三个插槽挂载；只有点保存才写入。明确拒绝按 schema 自动生成通用表单，autoGenerate 标志还留着，但没有客户端使用。官方配置页拆成伴生包，只在 Host 提供对应命名空间时才注册。

DeskMinis 现状：换壳后 MCP 的 env/headers 编辑器丢了。 ⇒ 借鉴：把已装 MCP 的配置编辑放回市场的已装详情页；表单由注册表的 environmentVariables（isRequired、isSecret）驱动，复用确认卡组件；isSecret 字段走 vault。（核验：已核实。）
- R3 [confirmed|extensibility|新:yes|DM:has] 官方仍不做内置市场，只给社区市场留详情页插槽：DSH 的做法：仓库里没有市场实现，README 仍推荐 dsh-plugin topic。可选包笔记明确拒绝了「官方可安装目录」。Plugins 详情页开放 actions、badge、section 三个插槽，用例写的是「市场插件的更新徽章」。

DeskMinis 现状：awesome-dsh 源只收 category=skill 的条目。这些条目本质上是 DSH 代码包，按 github-url 整仓导入，可能出现根目录没有 SKILL.md 的情况。 ⇒ 借鉴：内置市场的路线是对的。给 awesome-dsh 条目加导入后校验，并提示「该条目为 DSH 插件，只尝试提取 SKILL.md」，或者降级为只读浏览。（核验：已核实。）
- R3 [confirmed|product|新:yes|DM:partial] 随安装附带、默认关闭、不可卸载的「官方可选包」：DSH 的做法：OPTIONAL_BUNDLES 代码常量列出语音输入和 Agent Teams 两个包，随产品附带、默认关闭、打开时不需要联网、不能卸载。名单写在代码里而不是 manifest 里，防止已发布的包自称「官方」；静态门禁检查默认组合不引用名单里的包。 ⇒ 借鉴：「办公技能包」可以照这个模式做：打进安装包的 resources，在市场「官方」分组显示「随应用提供 · 默认关闭」，名单写成代码常量并配守卫测试。（核验：已核实。）
- R3 [confirmed|product|新:yes|DM:partial] 发布状态：rc.8 到 0.1.7-rc.1 的高频预发布，以及桌面端的发布与更新机制：基线时版本为 0.1.0-rc.8；之后打了 20 个 dsh-v 标签（0.1.1-rc.1 到 0.1.7-rc.1），cli、web、desktop 版本号一致。桌面端有：
- 卸载时保留 DSH_HOME；
- 远端策略驱动的强制更新；
- 由环境变量开启的安装更新日志（jsonl）；
- 提案阶段的 nightly/stable 双通道（allowDowngrade=false）。 ⇒ 借鉴：（1）将来开预发布通道时用独立的 feed 文件；
（2）用可选的更新日志在真机取证「下载 → 安装 → 新版本启动」整条链路，补强 RELEASE.md 的验收；
（3）强制更新依赖远端服务，不适合 DeskMinis。（核验：版本与标签数已核实。）
- R3 [confirmed|dx-testing|新:yes|DM:missing] 性能基准门禁：按用户路径设预算：DSH 的做法：benchmarks/ 于 09-05/06 新建；根目录的 BENCHMARK.md 在基线后没有改过。long-session-browser 用合成的 240 回合会话，打开、翻旧页、进入 Trajectory 的预算分别为 900/700/520ms，共用 1.25 倍余量，另有「流式输出期间打字不被阻塞」。每个样本在全新进程中运行，数据全部合成，预算写成源码常量。 ⇒ 借鉴：用现有的 Electron e2e 加一个 e2e:perf：合成 200 回合以上的会话，测首次渲染、滚动到底和流式期间的输入延迟；预算写成常量，并注明是在哪台真机上测的。（核验：已核实。）
- R2 [confirmed|sync-storage|新:no|DM:has] 检查点先于副作用（fail-closed）：DSH 的做法：session-checkpoint-policy 设三道持久化屏障：请求前 flush，失败就不调用适配器；工具执行前 flush，失败就不执行；每步边界把上一步 flush。

DeskMinis 现状：better-sqlite3 是同步写，assistant(toolUse) 在工具执行之前已经落库，前两道屏障天然具备；差别只在工具结果要等全部完成才整批落库。 ⇒ 借鉴：核心性质已经具备。只需改为逐个落库工具结果；不要引入异步写缓冲。（核验：抽查属实。）
- R2 [confirmed|sync-storage|新:yes|DM:has] 会话格式演进：已发布格式不可变、只做相邻迁移，以及「存每个流 delta」的教训：DSH 的做法：v0 在 alpha 版就已发布，一个月内演进到 v4。原则：只写 vN→vN+1 的有状态流式迁移；在旁边独占发布 session.vN.jsonl，绝不改写已提交的旧代；只读打开时在内存里迁移；遇到未来版本拒绝读取。教训：v0 把每个 delta 都存成一个事件，一份 116MB 的日志展开后约 914 万个事件，旧的整块迁移在 16GB 堆上 OOM；新格式把压缩后的流嵌入 assistant/message，折叠后只剩 72,784 个事件。08-31 删除了 SQLite 后端。 ⇒ 借鉴：这是对 DeskMinis 只追加迁移纪律的确认。保持消息级落库，不存流片段；将来改 parts_json 结构时，旧行保持原样、读时兼容。（核验：已核实数字与日期。）
- R2 [confirmed|platform|新:yes|DM:partial（刻意边界）] Office 转 PDF 高保真预览（LibreOffice kit）：DSH 的做法：ctx.officeToPdf 转换 DOC/DOCX/XLS/XLSX/PPT/PPTX。默认并发 2、超时 60s；按源文件 SHA-256 缓存；前台请求优先，最后一个读者离开就取消。依赖独立发布的 @deepseek-ai/libreoffice-kit，桌面端还捆绑 Python Office 运行时。 ⇒ 借鉴：违反零依赖，不引入，保持「内容预览不是版式还原」的边界。零依赖的增强路径：检测本机的 soffice 或 Office COM，导出 PDF 后用 Electron 自带的 PDF 查看器显示。（核验：已核实；引入时间在 09-14 至 09-16 之间。）
- R2 [confirmed|multi-agent|新:no|DM:missing] 实验性 Agent Teams：名册、持久邮箱与任务 DAG：DSH 的做法：叠在可续子代理之上。成员进名册；邮箱先存在 Lead 会话，送达才确认；共享任务 DAG 每次写完整快照并带 CAS 修订号，blockedBy 必须无环。writeScopes 只是建议性的路径前缀，不是锁。 ⇒ 借鉴：对 DeskMinis 太早。记下一点：多 agent 并行写同一工作区时，必须先定冲突策略。（核验：抽查文件存在，基线时即有。）
- R2 [confirmed|dx-testing|新:no|DM:missing] 严格重放与不变量伴生件：DSH 的做法：goal、todo、schedule、workflow 等持久域都有 invariant.ts，独立地对日志做增量折叠并校验；发现损坏就 fail-closed，不推导出错误的视图。 ⇒ 借鉴：不照搬框架。DeskMinis 的折叠状态写成纯函数 fold 加单测，遇到坏数据显示「状态损坏」即可。（核验：文件存在。）
- R2 [corrected|extensibility|新:partial|DM:missing] ACP：标准 v1 服务端加 ACP 子代理客户端：DSH 的做法：通过 stdio 对外提供 ACP v1（new、list、resume、close、prompt、cancel、set_config_option，以及按会话挂载 MCP）。session/request_permission 只给「允许一次 / 拒绝」两个选项。subagent-acp 可以把任意 ACP agent 拉起来作为子代理。 ⇒ 借鉴：短期不做。将来让 minisd 做 ACP 服务端，只需加一层 stdio 适配；权限桥接只允许一次性选项。（核验：更正：ACP 服务端、allow_once/reject_once 和 subagent-acp 在基线时就已存在；基线后只是在 08-22 补全了 v1 自动化控制。）
- R2 [confirmed|tools|新:yes|DM:missing] PTC：模型写 TypeScript 程序调用工具，在同一沙箱里运行：DSH 的做法：每次调用起一个全新的 Node 进程，受与 bash 相同的沙箱策略约束。控制消息用长度分帧的 JSON；OS 环境只留白名单变量；有超时、输出上限和堆上限；内层工具调用同样走审批规则。workflow 也复用这套运行时。 ⇒ 借鉴：暂不需要。以后如果做：Electron 加 ELECTRON_RUN_AS_NODE 起子进程，环境走白名单，执行前删除该变量，内层调用走权限网关。OS 沙箱落地之前不开放。（核验：已核实。）
- R2 [confirmed|platform|新:yes|DM:missing] SSH 远程执行世界：fs、subprocess、sandbox 整体替换：DSH 的做法：通过部署方自有的 OpenSSH，把文件系统、子进程、终端、沙箱整体换成远端实现，模型看不到任何 SSH 专用工具。远端 helper 要校验 SHA-256，靠租约和心跳触发清理；断连后不重放可能已执行的动作。helper 只支持 POSIX 主机。 ⇒ 借鉴：对 Windows 桌面价值低。可借的是原则：断线后绝不重放可能已执行的动作，可以写进设备接力与同步的设计约束。（核验：已核实。）
- R2 [confirmed|architecture|新:yes|DM:不适用] Cordis + Slot 插件化 React 客户端架构（警惕，不宜照搬）：DSH 的做法：约 60 个客户端插件包，props 由五类派生份额组成，Slot 注册表拼装界面，有一堆 verify 脚本，客户端源码要求逐文件 100% 覆盖；composer 在基线后改用 Lexical。值得借鉴的只有几条纪律：业务数据只放在对象层；界面不往日志写呈现信息；未知或畸形的工具数据回落到通用卡片。 ⇒ 借鉴：不照搬。把三条纪律写进 docs 即可；StepGroup 基本已经符合。（核验：已核实 Lexical 是基线后引入的。）
- R2 [confirmed|extensibility|新:yes|DM:has] 插件本地化元数据：不执行代码也能读出多语言标题和简介：DSH 的做法：locale/<语言>.json 里放 meta.title 和 meta.description，按模块解析找到文件，全程不执行插件代码；两个字段各自独立回落到 package.json 和完整模块名；格式错误报诊断，不静默回落。 ⇒ 借鉴：技能本来就是数据，基本已满足，不需要额外工作。（核验：只核实了笔记存在与入库日期。）
- R2 [confirmed|extensibility|新:yes|DM:missing（不适用）] 版本兼容准入与精确豁免，拒绝原因以带类型的记录返回：DSH 的做法：按 peerDependencies 与当前运行时版本比对，不兼容就拒绝加载；bundle 本身不兼容则整个跳过（07ad70817，09-23）。豁免只接受精确的「包版本 × 运行时版本」配对，并且必须 acceptRisk。拒绝以 incompatible-version 码加结构化记录返回，由各端自行组织措辞。 ⇒ 借鉴：不需要准入机制。可以借「服务端返回 {code, params}，界面自己组织措辞」这一点，把 minisd 需要分类处理的错误逐步改过来。（核验：已核实提交。）
- R2 [confirmed|agent-loop|新:yes|DM:missing] webhook 运行时：外部事件转成新会话，只触发不等结果：DSH 的做法：register 加 dispatch；受信的规则回调返回会话请求（工作区、标题、初始提示、预设、权限预设）。webhook-github 负责 HMAC 校验和请求体大小上限，校验通过就立刻返回 202。已知限制：只在进程内触发，崩溃就丢，不去重，不回报执行结果。 ⇒ 借鉴：桌面端用不上。如果以后需要本机脚本触发，走 bridge-cli 或仅限 127.0.0.1 的 RPC，外部文本要标为不可信。（核验：已核实。）
- R2 [confirmed|product|新:yes|DM:partial] SAFETY.md：坦白说明安全边界：DSH 的做法：基线后新增的 SAFETY.md（27 行）写明：项目没有经过安全审计；沙箱和审批只能降低风险；第三方插件可能破坏主机或泄露凭据；建议用最小权限、虚拟机或容器运行。credentials-local 的文档也承认挡不住以同一用户身份运行的 agent 子进程。 ⇒ 借鉴：DeskMinis 的 README 补一段市场与 MCP 的安全说明：MCP 以你的系统权限运行；上游的安全裁定不等于审计；凭据库里的密钥同样能被以你身份运行的程序读取。（核验：已核实。）
- R1 [confirmed|tools|新:no|DM:missing] LSP：只读代码导航工具：DSH 的做法：一个 lsp 工具提供定义、引用、实现、hover 四种查询；每个工作区按需启动语言服务器，服务器本身不带沙箱。 ⇒ 借鉴：DeskMinis 不是 IDE，file_grep 已经够用，不建议引入。（核验：只确认了文件存在。）
- R1 [corrected|dx-testing|新:partial|DM:missing] 文档站：每页附原始 Markdown，并生成 llms.txt：website/ 下的 VitePress 站点在基线时就已存在（有 config.ts、docs.ts 和 AGENTS.md）。基线当天稍后（08-20）加入了「每页原始 Markdown 路由 + llms.txt 索引」；08-26 是构建幂等修复，不是新建站点；09-15 又加了页面级的 Markdown 复制与查看。 ⇒ 借鉴：暂时不需要。以后如果开放文档，沿用「一份正文、构建时投影」和 llms.txt 的做法。（核验：更正：读者称「VitePress 文档站 08-26 起新建」有误，站点在基线时已存在，08-26 只是幂等修复；llms.txt 属于基线后（当天）新增。）

未覆盖：
- vendor/cordis 框架本体（服务注入、effect 回卷、五种事件调度）只从概述了解，未读源码
- packages/llm 下各适配器：llm-deepseek 的请求扩展注册表、llm-pi-ai 的多厂商路由与 OAuth 登录。pi-ai 与用户点名的 pi 项目相关，适合与 pi 交叉对照
- session-stats、session-turn-outline、session-projection-cache、session-query 的具体实现（回合大纲、全会话统计字段）
- python/ SDK、sdk-runtime、BENCHMARK.md 指向的外部评测，以及 packages/sdk
- packages/attachment、storage、e2b、code-runtime、feedback、typert、workspace 等未被任何视角覆盖的包
- packages/extensions 的 Creator 模式全流程，experimental 下的 voice-input、agent-team 深入细节
- native/ 目录、win32-process 的 verify/abi-probe.cpp、koffi 绑定表
- 客户端的 ui-dockkit 停靠引擎、ui-sidebar-files/terminal、各 ui-settings-* 伴生包，以及 i18n 词典体系
- apps/desktop 的 NSIS 自绘安装页、欢迎窗与登录、强制更新策略服务（40005）、release.ts 发布元数据
- snapshots/ 录制与回放机制、apps/cli 的 headless 和 ACP 语料
- docs/user 用户文档与 docs/config-catalog 生成目录
- DeskMinis 侧确认的缺陷（压缩、溢出降级、卸载桩循环、minisd 崩溃无处理、单实例、窗口守卫、主题恢复、删除运行中会话、环境变量泄露、MCP 密钥明文、junction 逃逸）都只做了静态读码，没有跑测试或上 Windows 真机复现
- 本任务只覆盖 deepseek-harness；用户点名的 zcode 与 pi 不在本次核验范围内