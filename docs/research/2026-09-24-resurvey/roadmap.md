# 附录 B：分波路线详案（2026-09-24）

由第二轮综合裁决产出，并已按完备性批评修订。正文 §5 是摘要，这里给出每个子波的范围、借鉴来源和可验证的验收标准。
裁决里引用的 DeskMinis 缺陷，已由主会话逐条回到源码复核，结果见正文 §4。

## 子系统处置表

| 子系统 | 处置 | 理由 |
|---|---|---|
| 进程与传输拓扑（minisd 在 utilityProcess，WebSocket JSON-RPC 加 per-run token） | 保留 | ZCode、DSH、AionUi 三家都收敛到这种形态。minisd 与界面同仓构建，没有壳和引擎之间的版本漂移。不拆包，也不嵌入外部运行时。 |
| 界面组件树（src/renderer/src/ui/ 与 theme.css） | 保留 | 用户已裁定过「重新做」，T 波已执行完。AionUi 的设计 token 零变更。渲染侧 53 个测试里 47 个是源码文本守卫，重写界面等于在没有测试网的地方施工。今后只新增组件，每项都配 SSR 测试并在 xvfb 下目视。 |
| 上下文管线（agent/compact.ts、prune.ts、offload.ts、context-policy.ts，以及 minisd/index.ts 里 promptFactory 的组装） | 重写 | 缺陷在这里最集中： - 压缩取材从 history[0] 开始，没有上界（compact.ts:62/67）；请求以 assistant 结尾，被 tests/compact.test.ts:92 钉死；maxTokens 只有 1024（:92）；摘要为空也写 marker（:97）；失败被 loop.ts:340 吞掉。 - 卸载桩（offload.ts:34）让模型用 file_read 取回，但 loop.ts:558 会把读回的内容再次卸载。 - 修剪桩（prune.ts:39）指向从未落盘的文件，而 minChars=2000（:26）远低于卸载阈值 20000（offload.ts:5）。 - system 每一步都重建；prune 用 12 条滑窗（prune.ts:25），媒体占位也是滑窗，都会改写旧消息。 在 Fable 5.1 和 Opus 5.5 的前缀校验下，最后这一类已从缓存失效升级为 400。 按四条不变量一次重做：前缀字节稳定、摘要请求角色合法、空或截断的摘要拒收、水位以真实 usage 为锚。W2a 先做不改结构的止血。 |
| agent 循环（agent/loop.ts，594 行） | 重构 | 骨架可靠：重试梯、延迟改绑、续写、cancelWithPartialReply、同步落库都有 agent-loop.test.ts 行为网覆盖，推倒重写会重演搬家遗失。 只补缺失的接缝： - 工具批次之后的插话注入点； - maxTokens 截断时带的工具调用不执行； - 工具结果逐个落库（:567 现在整批落库）； - 按 readOnly/concurrencySafe 分段调度（:550 现在一律 10 路并发）； - toolInputDelta 转为「准备中」（:417 现在直接丢弃）。 |
| provider 层（anthropic.ts、openai.ts、gemini.ts、types.ts、model-catalog.ts） | 重构 | SSE 自解析和 AgentProvider 接口保留。请求整形与错误分类改为纯函数加规则表： - 错误按溢出、配额、限流与 Retry-After、前缀绑定不一致、真拒绝分开（types.ts:27 现在一律标为可降级）； - anthropicThinkingShape 按代际建表（anthropic.ts 开思考时只会发 budget_tokens）； - OpenAI compat 对象负责 reasoning_content 回放、显式关闭、<think> 拆分； - usage 补上缓存读写口径。 W2a 先对 Fable 5.1/Opus 5.5 官方端点和 deepseek-v4 做最小止血，W4c 做完整矩阵。动手前先冻结含交叉维度的请求体黄金快照。 |
| 工具层（tools/files.ts、shell.ts、terminal.ts、skills/importer.ts） | 原地修 | 缺陷都是局部的，每项都能先写红测： - files.ts:123 的 $ 替换序列与 CRLF； - 数据根整体免审批写入（files.ts:27-32）； - file_read 没有 offset/limit； - shell 和终端只杀 powershell.exe，不杀进程树，且按裸名 spawn； - 子进程拿到完整的 process.env； - 路径围栏没做 realpath； - unzipToMemory 没有上限； - 没有先读后写检测。 |
| 权限网关与交互通道（tools/permissions.ts、files.ts 的 guardWrite/guardRead、index.ts 的 pendingPerms） | 重构 | 判定核心（只读白名单、danger 硬拒）保留。先原地收窄数据根的免审范围（W1b）。再把「挂起 promise + 广播 + 倒计时」抽成带快照的 InteractionRegistry（W6c），用来承载权限卡、ask_user、计划审阅和信任卡。最后补会话级档位、拒绝时的反馈、切档后告知模型（W7b）。 |
| minisd 编排（minisd/index.ts，1235 行） | 重构 | inFlight（:404）、controllers、pendingPerms（:281）都是闭包私有状态；run 是 chat.prompt 里的 IIFE，无法从别处发起。抽出 SessionRuntime，负责 run 生命周期、每会话 inbox、live 快照和单调 seq。chat.prompt、cron，以及将来的子代理和 goal，都改为调用 runtime.submit()。现有 RPC 方法名全部保留。 |
| 渲染端连接层（renderer/src/rpc.ts，以及 stores/chat.ts 的事件层） | 重写 | rpc.ts 只有 71 行，没有 onclose、重连和代次；chat.ts:142 丢弃非当前会话的事件，:397 一切会话就把 running 置 false。这是崩溃重启、重连、快照、订阅、插话、等待态六项的公共地基。 做法：W2b 先止血（断连结算加横幅），W6b/W6c 整层重写为带代次的 RpcClient 加按会话键控的纯 reducer。chat.ts 被 20 多个测试锁住，只重写事件层，store 的 action 名不变。 |
| 主进程生命周期（src/main/index.ts，233 行） | 重构 | 只管了启动期：:66 的 exit 只在 minisdPort===0 时生效，:230 的 before-quit 直接 kill，没有单实例锁、窗口导航守卫、权限请求白名单、崩溃记录。minisd/index.ts:1208 已有有序的 close()，但从没接上。 W1b/W2b 先接线补闸，W6a 再把 fork、握手、崩溃预算、优雅停止抽成不依赖 Electron 的 launcher 模块。 |
| 会话存储（store/db.ts、chat-store.ts） | 原地修 | 只追加迁移加同步写库的设计是对的；DSH 弃用 SQLite 的起因（按 delta 存储）不适用。runner 补三样：降级时抛 DB_NEWER_THAN_APP、迁移包进事务、用 sha256 钉住历史迁移（W1a）。新列（逐消息模型归属、source_json、pruned_through、media_cutoff）合并进 W5c 那一次追加迁移，减少改六个版本钉的摩擦。 |
| 消息渲染管线（StageChat.vue 流式部分、MarkdownView、lib/markdown/parse.ts） | 重构 | StageChat.vue:126 每来一个 delta 就全量重解析，:139 的 mdOf 每次渲染都重解析全部历史；parse.ts:127 只认 # 到 ###。改为帧合批、增量解析（用性质测试保证与全量逐块相等）、历史 AST 缓存，零依赖补全 GFM 和轻量高亮。动手前先量化性能。 |
| MCP 客户端与配置（mcp/*、ui/settings/SecMcp.vue） | 原地修 | 先修三条静默丢数据的路径（W1a）：解析失败后保存覆盖原文件；编辑保存抹掉 env/headers 并强制启用；参数按空白重新切分。 之后再做：vault 引用（改用不与 `$$NAME` 冲突的整值形式）、列表脱敏、图片结果、带预算的重连、instructions 限长。继续用自写的客户端。 |
| 设备同步（sync/*） | 原地修 | sync.hello 带上 protocolVersion 和能力位，缺失一律按 false（W2b，首个公开版就带）。合成消息只推给声明了支持的对端（W5c）。删除墓碑（db.ts:11 预留了 remote_tombstoned_at 但无人读写）放到 W8c。削减决定、队列、运行态这类派生状态不进同步。 |
| Office 能力（office/*、tools/office.ts、PreviewPane） | 保留 | 零依赖自建的 OOXML 是差异化资产，「内容预览不等于版式还原」这条边界不变。缺的不是引擎，而是三样：随包的办公技能包（W4a）、用系统程序打开（W8a）、写入前的检查点（W8b）。 |
| 助手、定时任务、扩展市场 | 原地修 | cowork 的地基保留。要修的： - 欢迎页选助手的撒谎：Composer.vue:225 与 AppShell.vue:50 条件不一致，W2b 最小修，W8a 结构修； - 定时任务缺注意力回路（W7b）； - 解压没有上限（W1a）； - 技能覆盖重装不是原子操作（W8c）。 |
| 发布工程（electron-builder.yml、scripts/e2e-m5-packaging.mjs、docs/RELEASE.md、package.json） | 原地修 | Releases 只有 v0.1.1。publish: github 在私仓下会 404；package.json 的 license 写 ISC，与 LICENSE（Apache-2.0）不符；没有 sha512 校验，也没有依赖冻结守卫。W2b 补上脚本和守卫；更新源作为 W3 的前置阻断项，交用户拍板。 |

## W1 数据完整性与越权止血（两子波：W1a 伤数据、W1b 越权与并发）（规模 L）

**目标**：用户的文件、配置、数据库不再被静默改坏；agent 不能绕过权限卡改应用自己的配置；两个实例不会同写一个库。零架构改动、零新功能。

**范围**：

- [W1a] file_edit 改用 indexOf+slice 拼接；CRLF 文件先归一为 LF 再匹配，写回时按原行尾还原；保留 BOM
- [W1a] MCP 配置三条丢数据路径：mcp/config.ts 区分 ENOENT 与其它错误，有 loadError 时拒绝保存（或先把原文件改名为 servers.json.corrupt-<ts>）；upsert 对输入里没出现的键保留旧值；SecMcp.vue 的 payload 只提交用户改过的字段，不再强塞 enabled:true，参数未改动时原样保留，不再 join 后按空白重切（SecMcp.vue:31/:44）
- [W1a] store/db.ts：user_version 大于 MIGRATIONS.length 时抛 DB_NEWER_THAN_APP，主进程显示中文说明，不给清空按钮；每条迁移用 db.transaction 包裹；守卫测试钉住 MIGRATIONS[0..10] 各条的 sha256
- [W1a] skills/importer.ts 的 unzipToMemory 复用 office/zip.ts 的条目数、解压总量、单文件三道闸，在 inflate 之前按 entry.uncompressedSize 和累计值拒绝
- [W1a] 开发态数据隔离：dev 默认使用 APPDATA 下的 DeskMinis-dev，keyring 服务名加 -dev 后缀，DESKMINIS_DATA_DIR 仍然优先（需用户点头）
- [W1b] 收窄数据根写入（tools/files.ts:27-32）：免审只保留当前会话 sessions/<id>/ 下各桶、绑定的工作区和 shared/。providers.json、minis.db*、配对与凭据文件一律拒绝。mcp-servers/、skills/、memory/ 以及其它会话的桶走权限卡，并写明「将修改应用配置」。读取 minis.db* 和其它会话的桶也走权限卡
- [W1b] 单实例：requestSingleInstanceLock，second-instance 时唤出托盘隐藏的窗口；minisd 在 dataRoot 用 openSync('wx') 建锁文件，写入 pid，陈旧锁可接管
- [W1b] chat.sessions.delete 遇到运行中的会话，先 abort，等 run 结束再删
- [W1b] 优雅退出：before-quit 与 quitAndInstall 调用已有的 close()（minisd/index.ts:1208），修掉 abort 后不等 run 收尾就 db.close 的竞态，最多等 5 秒
- [W1b] shell 和终端的 interrupt、dispose、超时路径复用 killTree，改用 System32 下 taskkill.exe 的绝对路径加 /T /F；powershell.exe 改用 System32 绝对路径启动；spawn 统一加 windowsHide

**借鉴**：pi edit.ts 的切片拼接与 CRLF/BOM 还原、durable 迁移 runner、settings-manager「有 loadError 就不写」、killProcessTree 的 System32 绝对路径（MIT，须署名）；ZCode edit.ts 的函数式 replacer、插件 zip 上限常量、DataRootLock 陈旧锁判定（Apache-2.0，须署名并登记 NOTICE）；OpenMinis RebootGuard、DatabaseVersionGuard（GPLv3，只借思路）；AionUi 单实例锁与 dev userData 隔离（Apache-2.0）；DSH 的 session-stop 语义（MIT）

**验收**：

- tests/file-edit-dollar.test.ts：new_string 含 $$5、$&、$' 时，落盘内容逐字相等；CRLF 文件配 LF 的 old_string 能改成功，写回后仍是 CRLF；带 BOM 的文件改完后前三个字节仍为 EF BB BF
- tests/mcp-config-corrupt.test.ts：servers.json 损坏时执行 add，原文件字节不变，或原内容完整保存在 .corrupt-<ts> 中
- tests/mcp-config-edit-preserve.test.ts：只改 note 后保存，env、headers、cwd、startupTimeoutSeconds、enabled=false 全部原样；args 含 Program Files 这类带空格的路径时逐元素相等
- tests/db-newer-than-app.test.ts：user_version=MIGRATIONS.length+1 的临时库打开即抛错，且库文件哈希不变；注入一条会失败的迁移后 user_version 不前进。tests/db-migrations-immutable.test.ts：改动任意一条历史迁移就变红
- tests/skill-zip-bomb.test.ts：超条目、超总量、超单文件三种 zip 都在 inflate 之前被拒（断言拒绝发生在 readEntry 回调里，不测内存峰值）
- tests/data-root-write-gate.test.ts：file_write 写 /var/minis/mcp-servers/servers.json 会弹卡；写数据根下的 providers.json 被拒；写 /var/minis/workspace/a.txt 不弹卡；file_read 读数据根下的 minis.db 会弹卡
- tests/data-root-lock.test.ts：锁持有者存活时拒绝；pid 已不存在时接管
- tests/session-delete-running.test.ts：删除运行中的会话后，不再有工具执行，也不再向已删会话写消息。tests/shutdown-partial-reply.test.ts：运行中关停，重启后半截回复已落库，且没有 database is not open 异常
- tests/shell-kill-tree.test.ts：spawn 的第一个参数是绝对路径；interrupt 和 dispose 走 taskkill /T /F
- npm test 与 52 例 Windows-only 基线的 diff 为空；typecheck 为 0；每条红测都存档先红的输出；借用了 MIT/Apache 代码的，THIRD-PARTY-NOTICES 已登记，改动文件头有来源声明

## W2 失效与撒谎止血 + 发布工程（两子波：W2a 引擎与 provider、W2b 界面与发布）（规模 L）

**目标**：失败都看得见，界面不说假话。最新 Claude 和 DeepSeek V4 这两条主力路径在 0.3.0 不静默失效。备好发布校验和本地诊断。不加迁移、不加新功能。

**范围**：

- [W2a] 压缩止血（compact.ts）：输入改为「最新 marker 的摘要 + 锚点之后的增量」，压平成单条 user 文本，并按窗口预算截取；摘要为空或 stopReason=length 时不写 marker（:97）；摘要请求的 maxTokens 提到 16K（Claude 5 家族缺省就走 adaptive，思考计入 max_tokens）；失败时发 eventNote，不再被 loop.ts:340 吞掉；auto-title 的 maxTokens 同步放宽
- [W2a] 溢出分类（providers/types.ts:27）：移植 pi 的溢出正则表和排除表。命中后不降级到窗口相同的模型：模型组里有更大窗口的槽位时，允许降级过去，并如实提示「因上下文已满改用 X」；否则显示「上下文已满」，附「新建会话接力」按钮（用最新摘要预填新会话草稿，由用户确认后发送）
- [W2a] 最新 Claude 止血：只对 api.anthropic.com 上的 Fable 5.1 和 Opus 5.5，加请求头 anthropic-beta: thinking-binding-controls-2026-08-01，并发送 thinking:{type:'adaptive', block_binding:{prefix_mismatch_behavior:'drop_block'}}（这两个模型缺省本来就是 adaptive）。第三方兼容端点不带。「bound to a different conversation」这类 400 标为不可降级，并给出中文说明
- [W2a] DeepSeek V4 止血：AgentMessage 增加 reasoningContent，从 toAgentMessages、buildEffectiveHistory 一路传到 buildOpenAIBody；只对 deepseek-v4* 模型族回放（已捕获的值存在就回传，缺失补空串），其余端点与模型的请求体不变
- [W2a] 三处对模型或用户说假话的地方：卸载目录下 file_read 的结果不再被二次卸载（loop.ts:558）；修剪桩（prune.ts:39）改为如实说明，不再指向不存在的文件；ModelBar 标题改为「默认模型」，未绑定时胶囊显示「默认 · X」
- [W2b] rpc.ts 加 onclose：全部 pending 以「与后台服务的连接已断开」reject；断线期间的新调用立即失败；store 置 connection='lost' 并复位 running；顶栏显示横幅，附「重启应用」
- [W2b] 权限卡按会话区分：入 store 时存下 req.sessionId，StageChat 只渲染当前会话的卡，其它会话的待批请求在 NavRail 上标出来源
- [W2b] 欢迎页选助手的最小修：选中助手后，直接绑定到当前空会话，或新建一个已绑定该助手的会话
- [W2b] 主进程守卫：加 setWindowOpenHandler 和 will-navigate，外链交给系统浏览器；setPermissionRequestHandler 和 setPermissionCheckHandler 改为白名单，只放行确实用到的权限
- [W2b] 本地诊断：main 和 minisd 都挂 uncaughtException 与 unhandledRejection，写 crashes.json（最多 5 条、保留 7 天）；minisd 的输出按天写入 LOCALAPPDATA 下的日志文件，只落本地
- [W2b] sync.hello 带上 protocolVersion 和可选能力位，缺失一律视为 false
- [W2b] 发布工程：scripts/verify-release.mjs 比对 latest.yml 的 sha512；依赖冻结守卫；package.json 的 license 改为 Apache-2.0；README 能力表逐行核对，涉及自动更新、思考可见、记忆同步、mDNS、测试例数，以及关窗后仍在托盘运行、定时任务照常触发

**借鉴**：pi overflow.ts 的 OVERFLOW_PATTERNS 与 NON_OVERFLOW_PATTERNS；OpenAICompletionsCompat 中 DeepSeek 的 requiresReasoningContentOnAssistantMessages 语义（MIT，须署名）；claude-api 技能 shared/model-migration.md 的 preserved thinking 章节（thinking-binding-controls、drop_block、keep-tail 规则），照官方文档自行实现；OpenMinis 的「压平成文本」摘要输入、reasoning 回传门控（GPLv3，只借思路）；pi 与 ZCode 的「断连时本地 reject、绝不自动重放」原则；DSH 主进程窗口守卫（MIT）；AionUi 权限 handler 作为反面教材，verify-release-assets 作为正面参考（Apache-2.0）；pi 的 crash-log（MIT）

**验收**：

- tests/compact-bounded.test.ts：已有 marker、原始历史约为窗口 2 倍时，摘要请求的估算小于窗口；请求最后一条是 user，且不含 toolUse/toolResult；空文本或 length 截断时不写 marker，并出现 eventNote（compact.test.ts:92 有意翻红，在提交里逐条申报）
- tests/provider-overflow.test.ts：FakeProvider 抛 400「prompt is too long」或 context_length_exceeded 时，不降级到窗口相同的槽位，会话绑定不变，文案含「上下文已满」；组内有更大窗口的槽位时会降级，并出现「因上下文已满改用」；带 rate limit 字样的 400 不判为溢出
- tests/anthropic-binding-controls.test.ts（请求体快照）：官方端点加 claude-fable-5-1 或 claude-opus-5-5 时，带 beta 头和 block_binding；第三方 baseUrl 与其它模型都不带；「bound to a different conversation」的 400 满足 fallbackable=false
- tests/openai-deepseek-reasoning-echo.test.ts：deepseek-v4 多轮工具调用的请求体里，每条 assistant 都带 reasoning_content，缺失时为空串；非 deepseek-v4 模型的请求体与改动前逐字节一致
- tests/offload-roundtrip.test.ts：卸载后用 file_read 读同一路径，得到全文而不是新桩。tests/prune-stub-honest.test.ts：修剪桩文案不再指向不存在的路径
- tests/rpc-disconnect.test.ts（用已有 ws 起假服务端）：服务端关闭后 1 秒内全部 pending 被 reject。xvfb：运行中 kill minisd 后出现横幅，停止键不再卡在「运行中」
- tests/perm-session-scope.test.ts 加 xvfb 实拍：会话 A 的权限卡不出现在会话 B 的对话流里
- tests/main-window-guard.test.ts：源码守卫钉住 setWindowOpenHandler、will-navigate 和权限白名单（出现 cb(true) 全放行就变红）
- tests/crash-log.test.ts：条数和天数封顶正确。tests/sync-hello-version.test.ts：缺少 protocolVersion 的 hello 视为旧版
- tests/verify-release.test.ts：mock dist 正例通过，sha512 不符、缺 latest.yml 两个反例都失败。tests/deps-frozen.test.ts：依赖与快照完全一致
- xvfb：ModelBar 显示「默认模型」，胶囊显示「默认 · X」；欢迎页选助手后发出的消息带着该预设
- 提交正文附 README 能力表逐行核对清单：每一行写明「属实 / 已改写」并注明依据

## W3 0.3.0 Windows 真机发布（含真 key 冒烟）（规模 M）

**目标**：冻结功能，走完 docs/RELEASE.md，上架第一个公开版本，作为后续成批重写对照回归的基线。

**范围**：

- 前置阻断：用户先定更新源。默认建议改用 electron-updater 的 generic provider，指向公开的静态托管，只改配置；如果不定，本版就如实声明「不带自动更新」
- Windows 真机：npm test（含 52 例 Windows-only）、e2e:m5、verify:release；另把 win-unpacked 拷到全新目录，用全新 APPDATA 冒烟
- 真 key 冒烟（用户提供 key，在本机跑，不进 CI）：Anthropic 请求设 prefix_mismatch_behavior:'error'，这样任何账号都会进入强制校验，依次跑五个场景：memory_write 之后的下一步、跨日日志、压缩一次后继续聊、改助手规则后继续聊、会话中途启用或停用 MCP。DeepSeek V4 跑关闭档的多轮工具调用
- 真机手测：杀进程树、单实例与托盘唤出、DB_NEWER_THAN_APP 提示；另记录同名 exe 劫持和 junction 逃逸能否复现，修复在 W6d
- 只修真机暴露的阻断项；不加功能，不加迁移

**借鉴**：ZCode zcode-distribution-smoke：在仓库外、清空 NODE_PATH 的环境里冒烟（Apache-2.0）；AionUi 发布资产校验思路（Apache-2.0）；claude-api 技能中 preserved thinking 的三步自检

**验收**：

- Windows 真机上 npm test 全绿（含 52 例 Windows-only）；e2e:m5 与 verify:release 通过
- 全新目录、全新 APPDATA 下启动：握手成功，能配置 provider，能跑完一轮对话
- 真 key 冒烟记录：'error' 模式下五个场景都不出现 400，或者出现的 400 已被 W2a 标为不可降级并如实提示，且记录了原因、在 W5c 立项；DeepSeek V4 多轮工具调用不出现 400
- 手测：运行 node -e 'setInterval(()=>{},1000)' 后点停止，任务管理器里没有残留的 node.exe；连续双击启动两次，只剩一个实例；用 0.3.0 打开 user_version+1 的库时显示中文提示，库文件哈希不变
- 手测：权限卡在当前会话可见、可批；模型输出的链接由系统浏览器打开
- GitHub Release 上架 v0.3.0；发布说明写明 SmartScreen 提示、自动更新状态和已知限制（例如压缩质量要到 0.4.0 才改进）

## W4 办公内容先行 + 验收地基 + provider 正确性（三子波：W4a 可单独发 0.3.1）（规模 XL）

**目标**：先把 cowork 的内容送到用户手里；再建好能证明「行为没变」和「界面真渲染了」的测试面；然后把 provider 边界改成纯函数与规则表。

**范围**：

- [W4a，可单独发 0.3.1] 办公内容包：3–4 个随包办公技能（周报、PPT、表格整理、文档改写）和 2–3 个办公助手。名单写成代码常量并配守卫，放进 extraResources，默认关闭；启动时作为 builtin 装入，接上 skills/prompt.ts:34 已预留的注入位；市场里单列「随应用提供」
- [W4b] SSR 渲染测试层 spike：vitest 加 *.ssr.test.ts project，挂已有的 @vitejs/plugin-vue，用 vue/server-renderer 加预置的 pinia store。如果 spike 失败，改用 Electron 自带的 webContents.executeJavaScript 和 capturePage，把 xvfb 剧本迁进主库，不引入 playwright-core
- [W4b] FakeProvider 加按 modelId 分组的脚本队列（第 N 次抛 429 或溢出 400、length 截断的工具调用、带 reasoning_content 的流、空响应）；用现有实现生成请求体字节级黄金快照（端点 × 模型族 × 档位 × 有无图 × 有无工具，含交叉行）；假 Anthropic 端点能模拟 prefill 400 和 prefix_binding_mismatch
- [W4c] ErrorClassifier 完整版：溢出、配额耗尽（终态）、限流（读 Retry-After，超过 60 秒直接降级）、前缀绑定不一致、真拒绝
- [W4c] 纯函数 anthropicThinkingShape(modelId, level)，按官方模型表逐代建表；开思考时带 display:'summarized'；辅助请求显式压低 effort
- [W4c] OpenAI compat 对象加 detectCompat(baseUrl)：thinkingFormat、reasoning 回放矩阵、默认开思考的模型在关闭档显式关闭、读取 delta.reasoning、流式 <think> 状态机、修正 model-catalog 把 ^deepseek-v 判为不支持思考；TokenUsage 补 cacheRead 与 cacheWrite

**借鉴**：DSH OPTIONAL_BUNDLES 的「名单写成代码常量 + 守卫」模式（MIT）；AionUi 内置 Office 助手的形态（Apache-2.0，技能正文自己写）；pi 的 registerFauxProvider、OpenAICompletionsCompat、detectCompat、thinkingLevelMap/clamp、provider-retry（MIT，须署名）；ZCode modelRules 的规则数据与同路径冲突检测（Apache-2.0，不引 CEL，改用声明式 patch 自写）；OpenMinis ThinkingWireGoldenSnapshot 纪律、ThinkPrefixStreamParser（GPLv3，只借思路）

**验收**：

- tests/builtin-office-bundle.test.ts：名单常量与 extraResources 一致，默认未启用；启用后 <available_skills> 里出现 builtin 条目。xvfb：市场「随应用提供」分组可见
- tests/ssr-permcard.ssr.test.ts：pendingPerms 非空时，renderToString 输出里有权限卡；删掉 StageChat 里 PermCard 的挂载就变红（故意破坏自检）
- tests/fixtures/provider-body.golden.json：本波前后，除提交里逐条申报的形状修正外，逐字节一致；文件头写明「不得为了变绿而重新生成」
- tests/anthropic-thinking-shape.test.ts：Opus 4.7/4.8/5、Sonnet 5、Fable 5/5.1、Opus 5.5 在任何档位下都不出现 budget_tokens；Fable 与 Opus 5.5 的关闭档不发 disabled
- tests/openai-compat-matrix.test.ts：deepseek、zai、qwen、mistral 四种请求体快照，覆盖「多轮工具调用 + 关闭档」；Mistral 不带 reasoning_content
- tests/think-prefix-parser.test.ts：标签被切在两个 chunk 之间、正文里提到 <think>、整轮只有思考。tests/provider-error-classify.test.ts 表驱动。tests/usage-cache-tokens.test.ts：三家 usage 都映射出 cacheRead 和 cacheWrite
- 用户在 Windows 用真 key 抽样：Claude 5 家族开思考不 400；DeepSeek V4 开关两档的多轮工具调用都不 400

## W5 上下文管线定向重写（三子波，完成后发布 0.4.0）（规模 XL）

**目标**：长任务能可靠跑完：压缩真正生效；溢出时自动压缩后重试；水位反映真实用量；卸载的内容取得回来；请求前缀在整个会话内只追加不改写，缓存能命中，也不再触发前缀校验导致的 400。

**范围**：

- [W5a] 压缩重写：中文结构化模板（目标、约束、已完成、进行中、受阻、关键决策、下一步）；按 token 预算选切点，不切在 tool_result 上；跨次压缩累积文件清单；用 rapid-refill 加连续失败熔断取代 compactCount<3（loop.ts:321）；压缩开始时发事件
- [W5a] 溢出处置顺序：先强制压缩一次，再在同一槽位重试一次；仍然溢出、且有更大窗口的槽位时才降级；否则如实提示
- [W5b] 水位以最近一次有效 usage（含缓存读写）为锚，只估算其后的增量；没有锚点时把 system 和工具 schema 计入；压缩后显示「下次回复后更新」
- [W5b] file_read 支持 offset/limit 并给续读提示；卸载桩改为头尾各约 1K 加总行数；shell 结果预览取尾部；maxTokens 截断时带的工具调用一律不执行，并说明原因；中断占位文案附幂等建议
- [W5c] 前缀只追加：system 在会话内冻结，记忆日志、技能、助手规则的变化都改为带来源标记的追加消息（哈希不变就跳过），支持的端点可以用会话中途的 system 消息；工具全集在会话开始时声明，按名字稳定排序，会话级禁用 MCP 改为调用时拒绝；prune 和媒体占位的截止点落盘、单调推进；CONTINUE_HINT 和 EMPTY_RESPONSE_REMINDER 追加在工具结果之后并保留
- [W5c] keep-tail 压缩之后，剥掉保留回合里的 thinking 块（官方端点另外带 drop_block）；AGENTS.md/CLAUDE.md 首次加载时弹信任卡，内容作为带来源标记的消息注入
- [W5c] 一次追加迁移：messages 增加实际出答模型四列与 source_json，sessions 增加 pruned_through_message_id 与 media_cutoff_message_id；线格式里作为可选字段、合并用 COALESCE；对端没声明支持来源标记时，合成消息不推送，或降级为 EventNote 形态

**借鉴**：pi compaction.ts、estimate.ts、context_edit 投影、_overflowRecoveryAttempted、failToolCallsFromTruncatedMessage（MIT，须署名）；DSH compaction-basic 平衡区间、token-meter、RuntimeContextProjection、spill-policy、agent-instructions、repair.ts CLOSER_TEXT（MIT，须署名）；ZCode microcompact、rapid-refill、circuit_breaker 常量（Apache-2.0）；claude-api 技能的 append-only 替代表（会话中途 system 消息、提醒保留、keep-tail 剥 thinking）；OpenMinis 二分重试、切点不落在 tool_result 上（GPLv3，只借思路）

**验收**：

- tests/compact-incremental.test.ts：已有 marker、原始历史约为窗口 2 倍时，第二次压缩的请求估算小于窗口，且以 user 结尾
- tests/overflow-recovery.test.ts：第 1 次溢出 400 之后出现 compacted，同一槽位第 2 次成功；连续溢出时只重试一次，然后如实提示；会话不被改绑到窗口相同的模型
- tests/prefix-stable.test.ts：同一回合里连续两次构建请求，system、tools、messages 前缀逐字节相等；memory_write、file_read SKILL.md、改助手规则之后仍然相等
- 假 Anthropic 端点设 prefix_mismatch_behavior:'error'，跑 20 回合，期间含一次压缩、一次改助手规则、一次 memory_write、一次会话级禁用 MCP，全程无 400
- tests/watermark-anchor.test.ts：挂 30 个 MCP 工具时，水位显著高于只算 history 的值；压缩后显示「下次回复后更新」
- tests/truncated-toolcall.test.ts：maxTokens 截断且带 file_write 调用时，调用未执行，文件没被改动，文案写明是截断
- tests/agents-md-trust.test.ts：不信任就不注入；信任后作为来源消息落库，不进 system
- tests/sync-v030-replay.test.ts：0.3.0 的线格式载荷回放后合并正确；对不支持来源标记的对端不推送合成消息；六个 user_version 钉与 m5 版本钉同步更新并申报
- Windows 真机用真 key 跑一个压缩 4 次以上的长任务：能完成，cache_read_input_tokens 大于 0

## W6 会话协议与运行时韧性（四子波）（规模 XL）

**目标**：引擎崩溃后能自己回来，界面断线后能自己接上；任何会话的运行态、待批项、流式正文在刷新、重连、切会话之后都不缺不重；执行面补上几道零依赖的防线。

**范围**：

- [W6a] main 抽出 launcher 模块：握手之后继续监听 minisd 退出；崩溃预算为 5 分钟内按 1/2/4/8/16 秒退避，耗尽后显示可重试的错误页；启动失败分类器（纯函数、表驱动）加安全模式（跳过 MCP、同步、市场技能）；「导出诊断包」（脱敏，只落本地）；处理 render-process-gone 与 GPU 崩溃
- [W6b] 重写 RpcClient：连接代次；500ms 到 10s 退避加抖动，连接稳定 5 秒才复位；每次重连前重新取 minisdInfo；重连后只重拉只读数据，绝不重发 chat.prompt；chat.prompt 带 clientMsgId 去重；RPC 错误带 data.code
- [W6c] 抽出 SessionRuntime 与 InteractionRegistry；chat.watch(sessionId) 返回 {messages, live, seq}，事件带 epoch 和 seq；新增 permission.pending 与 chat.sessions.running 两个只读 RPC；按连接的 subscribedSessions 投递，pairing 态连接收不到业务广播；新增 chat.settled 事件
- [W6d] 执行面硬化：路径围栏改用 realpathSync.native；新增 childEnv() 擦除凭据类环境变量，MCP 需要的环境变量须显式声明，并在确认卡上写明；web_fetch 只解析一次 DNS，用 BlockList 校验后钉住地址，逐跳校验重定向；桥请求带每会话 token

**借鉴**：ZCode V4 snapshot 的 seq 与 resync 语义、CrashBudget、ChannelClient pendingRejections、commandId 幂等（Apache-2.0，不引入 V4 全套）；pi lane.watch 两阶段订阅、按附着投递、断连不重放、/bug 诊断包的脱敏规则（MIT）；DSH ConnectionController 连接分代与状态胶囊、scrubbedParentEnv、realpath 围栏、web_fetch 钉住地址（MIT）；AionUi backendStartupFailure 分类器、rendererRecovery、gpuRecovery（Apache-2.0）

**验收**：

- tests/crash-budget.test.ts（注入 now）：5 分钟内第 6 次崩溃进入停止态。tests/startup-failure-classify.test.ts 表驱动：覆盖 .node 加载失败、EBUSY、EACCES、keyring、DB_NEWER_THAN_APP、握手超时
- tests/rpc-reconnect.test.ts：按退避重连，重连后没有重发任何 chat.prompt；重复的 clientMsgId 返回 duplicate
- tests/session-watch.test.ts：流式中途 watch 得到的快照加上之后的事件，等于全量，不缺不重；出现跳号就重新 watch
- tests/broadcast-scope.test.ts：pairing 态连接收不到 chat.event 和 permission.request；没订阅的连接收不到 textDelta。tests/event-channel-diff.test.ts：渲染端订阅的每个事件名都有发送方
- tests/path-fence-realpath.test.ts：用 junction 构造逃逸，写入被拒。tests/child-env-scrub.test.ts：名字匹配 KEY/TOKEN/SECRET/PASSWORD 的变量不进子进程。tests/web-fetch-ssrf.test.ts：169.254.169.254、内网地址、DNS rebinding 都被拦截。tests/bridge-token.test.ts：token 缺失或错误时返回 UNAUTHORIZED
- xvfb 三条剧本：kill minisd 后先出现横幅，再自动恢复且历史完整；有待批权限时刷新渲染端，权限卡仍在；流式中途切走再切回，停止键仍在，正文开头不缺
- Windows 真机：utilityProcess 崩溃后自动重启、渲染端自动重连；junction 逃逸在修复前可复现、修复后被拒（附记录）

## W7 人在回路交互层（三子波，完成后发布 0.5.0）（规模 XL）

**目标**：这是用户最能直接感到「更像 cowork」的一波：运行中可以继续输入；每个会话在等什么一目了然，窗口不在前台时有系统通知；长任务有计划条和进度；审批和提问占住输入区，不会埋进消息流里被滚走。

**范围**：

- [W7a] 工具声明 readOnly/concurrencySafe，可并行的调用成段并行，其余作为屏障按原顺序执行，结果逐个落库；queue：SessionRuntime 为每个会话维护 FIFO，回合结束后自动开下一轮，QueueDock 可编辑、可撤回，点停止时回填 chat.draft；steer：在工具结果落库之后、下一次请求之前注入；附件、@路径、会话级 MCP 禁用等发送字段完整穿过入队与出队
- [W7b] 等待态纯 reducer，NavRail 按「等待 > 运行 > 未读」显示徽标；Electron Notification 加 flashFrame，setAppUserModelId 与 appId 一致，定时任务的通知写明「90 秒后自动拒绝」；PermCard 停靠到输入区（Composer 用 v-show 保住草稿）；拒绝时可附一句反馈，写进 tool_result；会话级权限档与「完全访问」就地确认；切档和定时任务开跑时追加告知消息；ask_user 走 InteractionRegistry，无人值守时立即返回「无人应答」，输入法组字（keyCode 229）期间不提交
- [W7c] todo_write（整表替换，最多一个进行中）加钉在输入框上方的 PlanBar；已完成的回合折叠为「已工作 N 分钟」，工时取落库时间戳；工具参数流到达时显示「准备中」行；运行中、已中断的步骤用各自的状态点；重复调用签名提醒，作为保留的来源消息；aria-live 播报

**借鉴**：DSH 持久 inbox 与 QueueDock、ask_user_question、tool-todo、审批接管输入区、update-attention、tool-calls 默认独占（MIT）；ZCode guide/queue 语义、ToolScheduler、interaction-registry、splitTurnHistory、classifyStep（Apache-2.0）；AionUi 等待态 reducer、ConversationPlanBar 尺寸、通知去重（Apache-2.0）；pi steer/followUp、restoreQueuedMessagesToEditor、AdaptivePublisher（MIT）

**验收**：

- tests/tool-schedule-order.test.ts：同一批里 file_write 之后是读同一文件的 shell，shell 读到新值；结果落库顺序与模型给出的顺序一致
- tests/steer-boundary.test.ts（性质测试，随机批次）：插话永远不会落在 tool_use 与 tool_result 之间。tests/queue-fields.test.ts：入队前与出队后的字段集合一致
- tests/waiting-reducer.test.ts：mark、unmark、clear 的转换与显示优先级都正确。tests/ask-user-unattended.test.ts：定时任务轮里调用 ask_user 立即返回「无人应答」
- tests/todo-fold.test.ts：能从历史中折叠出最新清单，且最多一个 in_progress
- SSR：pendingPerms 非空时，权限卡渲染在输入区的位置，Composer 的草稿仍在 DOM 里
- xvfb 实拍：运行中输入第二条，出现 QueueDock 芯片；点停止后草稿回填；后台会话申请权限时，NavRail 对应行出现等待标；已完成的回合折叠为「已工作 N 分钟」
- Windows 真机：安装版和便携版在窗口失焦时都弹出 toast、任务栏闪烁；用微软拼音和搜狗按回车上屏，不会误发送

## W8 cowork 结构、可撤销与扩展安全（三子波）（规模 XL）

**目标**：把「不止 coding」从内容延伸到结构：助手有独立的空态与工具集；agent 的改动能一键撤销；消息能复制、重试、截断；会话能归档，能按正文搜索；用量看得见；MCP 密钥不再明文存放。

**范围**：

- [W8a] 从结构上修掉欢迎页选助手的撒谎：inChat 只看 activeId，空会话显示助手空态，新增「给会话绑定助手」的 RPC；助手可设工具和 MCP 开关，在建会话时快照；「用系统程序打开 / 在文件夹中显示」，绝对路径由 minisd 过工作区围栏后返回；办公呈现档，权限卡在任何模式下都逐字展示并由守卫钉住
- [W8b] 写前检查点：file_write、file_edit、office_write 执行前把原文落到 sessions/<id>/checkpoints/，索引走追加迁移；每个回合一张改动卡；一键回退前做 hash 校验，任一文件不安全就整批拒绝；shell 造成的改动如实标「无法回滚」；先读后写，按 mtime、size、sha1 判断过期；消息级操作：复制、retryFrom、truncateFrom（只允许截掉后缀）
- [W8c] 删除墓碑与归档优先（先出设计稿，archived_at 进同步）；用 LIKE 做正文搜索；用量面板，单价未知时显示「—」，按实际出答模型归属；MCP 密钥改用 vault 引用，采用整值形式 vault:<key>，避开现有的 $$NAME 语法，list 结果脱敏，并恢复 env/headers 编辑器；技能改为 staging 原子安装

**借鉴**：ZCode rewind 检查点与 safe/unsafe 回滚预览、InterfaceMode 办公档（Apache-2.0）；DSH workspace-changes 改动卡、凭据只写引用、fs-observation-policy、open-in-app（MIT）；AionUi SingleChatEmptyState 的数值与归档页（Apache-2.0）；pi getUsageCostBreakdown、fork-policy 复制表（MIT）；OpenMinis 从此删除锚定用户消息、LIKE 搜索（GPLv3，只借思路）

**验收**：

- tests/checkpoint-revert.test.ts：file_edit 之后回退，文件恢复为原字节；文件被外部改动后再回退，整批被拒
- tests/read-before-write.test.ts：没读过就 file_edit 被拒；读过之后文件被外部修改，再写也被拒。tests/truncate-from.test.ts：截断后不留孤立的 tool_use
- tests/tombstone-sync.test.ts：设备 A 删除会话后同步给 B，该会话不会被复活
- tests/mcp-vault.test.ts：市场安装后，servers.json 与 mcp.servers.list 的结果里都没有明文密钥；vault:<key> 不会被 resolveEnvRefs 误判为环境变量
- SSR 加 xvfb：空会话选中助手后显示助手空态（头像、名称、问候语、开场建议），之后发出的消息带该预设
- xvfb：回合末出现改动卡；点「撤销本回合改动」后，预览分为「可安全回退」和「无法回滚」两组
- Windows 真机：「用系统程序打开」能打开 docx；「在文件夹中显示」能选中该文件

## W9 渲染管线与桌面打磨（三子波，完成后发布 0.6.0）（规模 XL）

**目标**：长会话流畅，Markdown 和代码块达到日常可读的水平；常用操作有快捷键，布局可以自己调；思考档位和上下文占用在输入区就能看到，而且不在任何状态上显示假信息。

**范围**：

- [W9a] 先测后改：用 FakeProvider 发 1 万个 delta 记录基线；textDelta 先进非响应式缓冲，每帧合并一次；增量解析只重解析末尾未闭合的块；历史 AST 按 id+长度缓存；超过 32K 的消息默认折叠；Markdown 补齐 h1–h6、任务列表、列对齐和工作区内的图片，加图片/SVG 全屏查看；零依赖的轻量语法高亮
- [W9b] 快捷键注册表（过滤 IME 组字与按键重复），并把托盘「打开设置」「切换右栏」两条没人订阅的 IPC 接回来；可拖分栏（吸附收起、双击复位、键盘可调）；滚动跟随只由用户意图改变，离开底部时显示「回到最新」
- [W9c] 模型选择器支持搜索和分组；思考档位胶囊，只列当前模型可用的档（依赖 W4c）；输入区显示上下文占用环（依赖 W5b 的真实水位）；已保存的主题在首帧生效；缩放后窗控与 146px 保留区在真机上校验

**借鉴**：DSH IncrementalMarkdownParser、Notifier 帧合批、use-scroll-follow（MIT）；ZCode 快捷键 bindings 与 coalesce（Apache-2.0）；AionUi useResizableSplit 的数值、DiagramZoomOverlay 常量（Apache-2.0）；OpenMinis 分档节流与自写高亮器（GPLv3，只借思路）

**验收**：

- tests/markdown-incremental.property.test.ts：随机切分成流时，增量解析与全量解析逐块相等
- e2e:perf：1 万个 delta 流式期间，主线程最长任务不超过 250ms（参照 DSH 的预算）；真机实测后只允许收紧，不许放宽，并注明测量机器
- tests/markdown-headings.test.ts：#### 渲染为 h4，# 渲染为 h1；任务列表与列对齐正确。tests/highlight.test.ts：输出 token 数组，守卫确认模板里没有 v-html
- tests/shortcut-match.test.ts：keyCode 229、key=Process、repeat 事件都不匹配。tests/tray-ipc-wired.test.ts：两个托盘通道在新 UI 树里都有订阅方（按调用形态匹配）
- xvfb 深浅两套主题实拍：代码块有高亮；「回到最新」按钮可点；分栏拖动能吸附；启动即恢复已保存的主题
- Windows 真机：Ctrl+= 缩放后，标题栏窗控与 146px 保留区不错位

## 发版节奏

0.3.0 在 W1 与 W2 共四个子波之后发布，作为 W3 单独执行，排在任何成批重写之前。

为什么这样排：
1. 降级守卫只有装在旧版本里，才能拦住「旧程序打开新库」。0.3.0 是第一个公开版本，必须带着它出去。
2. 仓库是私有的，publish: github 检查更新会 404，0.3.0 带出去的缺陷没法靠自动更新补救。所以下面这些都要在上架前修掉：file_edit 的 $ 改写；MCP 配置被覆盖或抹掉；数据根免审写入；双实例同写一个库；断线后界面永远显示运行中；空摘要抹掉上下文；别的会话的权限卡冒充当前会话；新账号用 Fable 5.1 或 Opus 5.5 时的前缀 400；DeepSeek V4 多轮工具调用 400。
3. 前两次重做已经让 0.2.0 没能发布。W4 和 W5 需要真实端点验收，如果挡在发版前面，发布会第三次被拖住。
4. 先发版能拿到一条经 Windows 真机验证的基线，后面的重写都拿它对照回归。

W3 有一个前置阻断：用户先定更新源。默认建议改用 electron-updater 自带的 generic provider，指向一个公开的静态托管（例如只放 Release 资产的公开仓库 Pages，或对象存储）。这只是改配置，不加依赖。0.3.0 安装包里写死的 feed 地址，决定了这批用户以后能不能自动升级；如果不定，就如实声明「本版不带自动更新」。

之后的节奏（按每个子波 1–3 天粗估，单个 AI 会话推进）：
- 0.3.0：W1a、W1b、W2a、W2b、W3，共 5 个子波，约 1–3 周，含用户在真机上的时间。
- 0.3.1：W4a 办公内容包，1 个子波，纯内容。
- 0.4.0：W4b、W4c、W5a、W5b、W5c，共 5 个子波，约 1–3 周，内容是 provider 正确性和长任务引擎。
- 0.5.0：W6a 到 W6d、W7a 到 W7c，共 7 个子波，约 1.5–4 周，内容是运行时韧性和人在回路。
- 0.6.0：W8a 到 W8c、W9a 到 W9c，共 6 个子波，约 1.5–3.5 周，内容是 cowork 结构、可撤销和打磨。
从发版到 0.6.0 共约 19 个子波。0.3.x 补丁线只接 W1 那类伤数据或安全问题的修复。

执行约束：
- 每个子波最多 2 个 M 级改动，必须独立全绿、能单独提交。
- 数据库迁移按发布批量合并：0.4.0 只在 W5c 做一次；W8 的检查点索引与归档合并成一次。
- 每次发版都在 Windows 真机重跑 e2e:m5、verify:release 和真 key 冒烟。
- 凡借用 MIT 或 Apache 代码的子波，都在 THIRD-PARTY-NOTICES 登记。

0.6.0 之后，逐项先出设计稿、默认关闭：
- 数据备份与恢复：db.backup 整库快照加目录打包、口令加密凭证段。排在删除墓碑之后，否则「恢复旧备份」和「对端推回已删会话」会缠在一起。
- 视觉（read_image、MCP 图片结果）与内置浏览器：采用 DSH 的租约与分区安全基线，外加 5 个走审批的 CDP 离散工具。
- 计划模式：在网关层做硬约束。
- 会话分叉。
- 只读 Explore 子代理：深度 1，需审批的操作立即拒绝。
- Goal：失败即暂停（fail-closed），armed 状态不进同步。
- 单窗口多会话分屏。
- 图片生成。

## 不做什么

- **第三次整体换皮或更换 UI 框架（包括移植 AionUi 的 React 代码，或再「照参考图改造」一遍）**：AionUi 的设计 token 自基线以来零变更，S 波的数值仍然有效。T 波换壳时，1890 例全绿也没拦住权限卡从来没渲染过，之后又用了四波才把入口补回来。渲染侧测试几乎全是源码文本守卫，没有测试网能兜住一次整体重写。
- **用外部 agent 运行时替换 minisd（aioncore、pi harness 或 chord、zcode-cli、嵌入 ACP），或者拆成 monorepo**：引擎侧约 95 个行为测试文件会一起作废；零新依赖和「后端留在独立 minisd」两条硬约束也会被打破。pi 的实验面在 win32 上直接抛错，OpenMinis 是 GPLv3，不能衍生代码。
- **把存储改成 JSONL 事件溯源，或换成 node:sqlite**：DSH 弃用 SQLite 的起因是按 delta 存储，116MB 的日志在迁移时 OOM；DeskMinis 按消息落库，没有这个问题。换存储本身也属于依赖变更。
- **在一波里同时重写 loop.ts、compact.ts、providers、rpc.ts 和 chat store，或者一次性重写 chat.ts 的全部 action 面**：每波只动一个耦合簇，并且要先有 W4b 的验收面，否则「有意翻红」的测试和真实回归混在一起分不清。chat.ts 被 20 多个测试锁住，还挂着 mu6 绊线，只能先在前面加一层按会话的投影，再逐步迁移。
- **引入新的 npm 依赖：vue-tsc、shiki 或 highlight.js、katex、mermaid、wavedrom 或 json5、cmdk、jsdom 或 @testing-library、playwright-core（包括把 driver 剧本迁进主库时）、koffi、Playwright 注入脚本、官方 MCP SDK、ssh2、i18next、tokenlens、LibreOffice kit**：零新依赖是硬约束。能自建的都自建（高亮、增量解析、分栏、lightbox、SSR 测试、用 Electron 自带的 executeJavaScript 和 capturePage 驱动 e2e）。数学公式和 Mermaid 如实降级为等宽原文，除非用户明确破例。
- **在 0.3.0 前，对第三方 Anthropic 兼容端点发送 thinking-binding-controls beta 头或 block_binding 字段**：官方文档写明，这组控制只在 Claude API 等少数平台可用，不支持的平台会拒绝这个头；不带头却发送 block_binding 会 400。0.3.0 只对 api.anthropic.com 上会强制校验的两个模型做止血。
- **学参考项目的默认外发：DSH 的 session-log-deepseek 默认上传完整会话日志、遥测默认 FEEDBACK_ONLY；ZCode 把 Coding Plan 端点静默改发到自家网关，并带 ARMS 与 OTel；pi 的 cache-warmer 在后台自动发请求花钱**：DeskMinis 承诺数据只在本机、不经云端。崩溃记录和诊断包只落本地，导出由用户主动发起。
- **放宽宿主安全：AionUi 用 setPermissionRequestHandler 一律放行；ZCode 内置浏览器提供全证书放行开关，并向网页暴露 bridge；从 Chrome 提权导入 Cookie；--web 在回环地址上默认不发 token、/ws 不验 Origin；AionUi 用明文 http 扫码换 token**：预览区会渲染 agent 产出的内容，DeskMinis 又没有 OS 沙箱。token、回环、Origin 三道闸必须保留，权限 handler 只能按白名单放行。
- **失败即放行与自动续跑：ZCode Goal verifier fail-open、CLI 无头模式默认 yolo、DSH maxConsecutiveWakes 没有默认值、重连后自动重放 chat.prompt、进程重启后自动续跑被打断的回合**：这些会导致写操作重复执行，或者无人值守时自激烧钱。被打断的回合只标为「上次中断」，由用户决定是否继续。
- **学这些具体写法：pi 模糊匹配第一步做 NFKC；pi 未经信任就注入 AGENTS.md；AionUi 往正文里塞 [[AION_*]] 标记再反解；OpenMinis 用进程全局补丁标志传递思考意图，并冒充官方 CLI 身份做 OAuth；ZCode code-mode 的 restrictProcess**：NFKC 会悄悄把中文全角标点改成半角；未经信任就注入等于开了提示注入面；把元数据塞进正文很脆弱；全局标志会让请求之间串扰；冒充官方身份违背出网承诺；restrictProcess 不是沙箱，还会泄露完整的 process.env。
- **OS 级沙箱（Job 对象、受限令牌 ACL，参照 DSH 与 ZCode 基于 koffi 的实现）**：参考实现依赖 koffi（FFI），违反零依赖。近期只做零依赖的几道防线：realpath 围栏、擦除子进程环境变量、用绝对路径启动 shell 和 taskkill、用 taskkill /T 杀进程树（W1b、W6d）。
- **近期不做：多 agent 团队与 workflow 脚本编排、PTC、SSH 执行世界、LSP、IM 机器人、国际化翻译、多窗口 BrowserWindow 对话墙**：DSH 和 ZCode 的团队与编排都还在实验区，而且依赖 OS 沙箱兜底；IM 机器人与「不经云端」冲突；对话墙要等 W6c 的按会话订阅，并且只做单窗口分屏；国际化与 LSP 对中文 cowork 用户收益低。
- **在没有双闸的情况下，让 agent 自己创建常驻定时任务**：这相当于一个持久化的提示注入面。要做就必须同时做到：automation 轮对模型隐藏 cron 工具、执行器再次拒绝、总数设上限、时间必须带显式时区、确认卡逐字展示，并且先由用户拍板。
- **在 0.3.0 前（W1 到 W3）加任何新功能或数据库迁移**：为了控制范围蔓延，前两次重做正是这样拖住了发布。逐消息模型归属、source_json 等新列统一放进 W5c 那一次追加迁移。W2a 的 DeepSeek 回放与 Claude 止血都是正确性修复，不算新功能，也不动表结构。
- **为了让测试变绿而重新生成黄金快照；使用 --passWithNoTests；设阈值为 0 的覆盖率门；Windows job 失败只写 notice、不阻断**：这些是 AionUi 等项目的反面做法，等于没有设门，也违背「守卫是资产」的纪律。
- **像 DSH 那样把计划模式做成软约束**：DeskMinis 的权限网关天然能硬拒写类工具。要做就做硬约束，工具目录不随模式增减，以保住前缀。

## 需要用户拍板的事（含默认建议）

1. **0.3.0 什么时候发？**
   - 选项：W1 和 W2 的四个子波止血后，立刻在 Windows 真机发（W3）；引擎重写推到 0.4.0 ／ 现在原样发，带着会改坏数据、会说假话的缺陷 ／ 等压缩与溢出彻底重写完（W5）再发
   - 默认建议：W1 和 W2 的四个子波止血后，立刻在 Windows 真机发（W3）；引擎重写推到 0.4.0
2. **自动更新源怎么解决？这是 W3 的前置阻断项，私仓下 publish: github 检查更新会 404**
   - 选项：另建公开静态托管（只放 Release 资产的公开仓库 Pages，或对象存储），改用 electron-updater 的 generic provider，只改配置 ／ 仓库转为 public ／ 0.3.0 明确不带自动更新，README 和发布说明如实写明需要手动下载升级
   - 默认建议：另建公开静态托管（只放 Release 资产的公开仓库 Pages，或对象存储），改用 electron-updater 的 generic provider，只改配置
3. **数据根写入收窄到什么程度？（现在 agent 不经确认就能写 providers.json、servers.json、skills/、memory/、minis.db）**
   - 选项：应用配置与数据库一律拒绝；mcp-servers/、skills/、memory/ 和其它会话的桶走权限卡，并写明「将修改应用配置」 ／ 全部走权限卡（包括 providers.json 和 minis.db） ／ 维持现状
   - 默认建议：应用配置与数据库一律拒绝；mcp-servers/、skills/、memory/ 和其它会话的桶走权限卡，并写明「将修改应用配置」
4. **0.3.0 对最新 Claude 的止血方式？**
   - 选项：只对 api.anthropic.com 上的 Fable 5.1 和 Opus 5.5 发送 drop_block（前缀不一致时丢弃旧思考块，请求照常成功），前缀绑定类 400 标为不可降级；根治放到 W5c ／ 不做止血，只在 README 里写明已知限制 ／ 对所有 Claude 5 家族模型都发送 drop_block
   - 默认建议：只对 api.anthropic.com 上的 Fable 5.1 和 Opus 5.5 发送 drop_block（前缀不一致时丢弃旧思考块，请求照常成功），前缀绑定类 400 标为不可降级；根治放到 W5c
5. **开发态数据是否与正式版隔离（改用 APPDATA 下的 DeskMinis-dev，keyring 服务名加 -dev）？**
   - 选项：隔离（本机现有的开发数据需要手工迁移一次） ／ 不隔离，只靠 DB_NEWER_THAN_APP 守卫兜底
   - 默认建议：隔离（本机现有的开发数据需要手工迁移一次）
6. **零新依赖是否对某项破例？**
   - 选项：全不破例：公式和图表如实显示等宽原文，自写轻量高亮，e2e 用 Electron 自带接口驱动 ／ 破例引入 katex 渲染数学公式 ／ 破例引入 mermaid 渲染图表 ／ 破例引入 vue-tsc，把 .vue 纳入类型检查 ／ 破例引入 playwright-core，把 driver 剧本迁进主库
   - 默认建议：全不破例：公式和图表如实显示等宽原文，自写轻量高亮，e2e 用 Electron 自带接口驱动
7. **是否增加 Windows CI job（每次推送在 windows-latest 上跑 typecheck 和 npm test；私仓分钟数按 2 倍计费）？**
   - 选项：上：Windows job 失败即阻断 ／ 暂不上，只在每次发版时由用户真机验证
   - 默认建议：暂不上，只在每次发版时由用户真机验证
8. **办公技能包什么时候发、默认开还是关？**
   - 选项：作为 0.3.1 紧跟 0.3.0 发布，默认关闭；首批做周报、PPT、表格整理、文档改写，配 2–3 个办公助手 ／ 随 0.6.0 与助手结构修复一起发 ／ 默认开启
   - 默认建议：作为 0.3.1 紧跟 0.3.0 发布，默认关闭；首批做周报、PPT、表格整理、文档改写，配 2–3 个办公助手
9. **Claude 5 家族的思考默认怎么设（W4c 起生效）？**
   - 选项：开思考时默认 display:'summarized'，让思考过程可见；关闭档按代际选最省的写法；自动标题和压缩用最低 effort ／ 保持缺省 adaptive，不显式设置（界面看不到思考，但照样计费）
   - 默认建议：开思考时默认 display:'summarized'，让思考过程可见；关闭档按代际选最省的写法；自动标题和压缩用最低 effort
10. **运行中发送的默认语义是什么？**
   - 选项：Enter 排到下一回合（queue），Ctrl+Enter 在工具边界插话（steer） ／ Enter 插话，Ctrl+Enter 排队 ／ 只做排队，不做插话
   - 默认建议：Enter 排到下一回合（queue），Ctrl+Enter 在工具边界插话（steer）
11. **配对的远端设备能否批准本机的权限卡、接收本机全部会话的流式正文？**
   - 选项：不能批准，只能接收自己显式订阅的会话 ／ 能批准自己订阅的会话的权限卡 ／ 维持现状（全量广播，remote 端可以调 permission.respond）
   - 默认建议：不能批准，只能接收自己显式订阅的会话
12. **删除文件、结束进程这类 danger 操作怎么处理？（现在在「完全访问」下也一律拒绝）**
   - 选项：新增走审批的「删除进回收站」工具，danger 命令仍然硬拒 ／ 在「完全访问」下允许 danger 命令按次批准 ／ 维持一律拒绝
   - 默认建议：新增走审批的「删除进回收站」工具，danger 命令仍然硬拒
13. **是否采纳「删除改为归档优先」，并用删除墓碑阻止对端复活已删会话？**
   - 选项：采纳，W8c 先出设计稿（archived_at 进同步，永久删除写墓碑） ／ 只做墓碑，不做归档 ／ 都不做
   - 默认建议：采纳，W8c 先出设计稿（archived_at 进同步，永久删除写墓碑）
14. **新增的状态哪些进设备同步？**
   - 选项：消息来源与逐消息模型归属进同步，只推给声明支持的对端；削减决定、队列、运行态、goal 的 armed 标志只留在本机 ／ 全部进同步 ／ 全部不进同步
   - 默认建议：消息来源与逐消息模型归属进同步，只推给声明支持的对端；削减决定、队列、运行态、goal 的 armed 标志只留在本机
15. **数据备份与恢复排在哪里？**
   - 选项：0.6.0 之后首批立项，排在删除墓碑之后，第一版用 db.backup 加目录打包 ／ 提前到 0.5.0 ／ 暂不做
   - 默认建议：0.6.0 之后首批立项，排在删除墓碑之后，第一版用 db.backup 加目录打包
16. **纪律文件是否进 main，权威账本分支怎么处理？**
   - 选项：在 main 放一份不超过 150 行的 AGENTS.md（写明零依赖、TDD、追加迁移、xvfb 目视等纪律）和一行的 CLAUDE.md，并配路径与命令存在性守卫；账本分支 claude/deskminis-handoff-dd9wrk 的合并方式由用户另行裁定 ／ 维持现状，纪律只写在交接分支
   - 默认建议：在 main 放一份不超过 150 行的 AGENTS.md（写明零依赖、TDD、追加迁移、xvfb 目视等纪律）和一行的 CLAUDE.md，并配路径与命令存在性守卫；账本分支 claude/deskminis-handoff-dd9wrk 的合并方式由用户另行裁定
17. **是否允许 agent 自己创建定时任务？**
   - 选项：本路线内不开放 ／ 开放，但必须同时做到：双闸（automation 轮隐藏 cron 工具，执行器二次拒绝）、总数上限、显式时区、逐字确认卡
   - 默认建议：本路线内不开放

## 评审分歧与处置

- 方向标签：用户价值和工程风险两位评审写的是 mixed，架构评审写的是 B。三份方案的实质一致：引擎与连接层成批重写，界面树保留，其余原地修，外加发版前的止血波。按 context.md 对 B 的定义（保留骨架、只对某几个子系统成批重写），标签采用 B；止血与发版只是排序安排，不算另一种方向。
- agent 循环 loop.ts 是否重写：架构评审主张改写成「请求投影纯函数 + 回合驱动器」，另两位主张 refactor。采纳 refactor。理由是 loop.ts 已被 agent-loop.test.ts 的行为网覆盖，并有约 16 项细粒度行为，整体重写最容易重演搬家遗失。请求投影的纯函数化并入上下文管线重写（W5c）。
- 逐消息模型归属列要不要在 0.3.0 前加：架构评审认为列越早加越好。不采纳，放进 W5c 那一次追加迁移。理由是首个公开版之前几乎没有真实用户，早加这一列能保住的历史很少；而发版前加迁移会连带改六个版本钉，与「发版前不加迁移」的纪律冲突。
- 验收地基要不要单独成一波：工程风险评审主张单独成波。本版把它作为 W4b 子波，放在 provider 改动之前。按批评者的意见修正了失败时的备案：SSR spike 不通时，改用 Electron 自带的 webContents.executeJavaScript 和 capturePage 驱动 xvfb 剧本，不再把自带 playwright-core 的 driver 剧本迁进主库，因为那会引入新依赖。
- provider 与上下文谁先做：工程风险评审主张先做上下文。采纳 provider 先做（W4c 在 W5 之前），因为溢出重试依赖错误分类，水位锚定依赖缓存用量口径。那两个会挂死的症状，W2a 已经用最小切口止血。
- 欢迎页选助手的撒谎怎么修：采纳两段式。W2b 做最小修，因为它是交接 §6 一档里的界面撒谎；W8a 再用空会话助手态从结构上根治。
- 优雅退出接线：本版放进 W1b，归入数据完整性，理由是它保证半截回复落库。工程风险评审担心 abort 之后不等 run 收尾就关库的竞态，用 tests/shutdown-partial-reply.test.ts 钉住。
- cowork 内容与渲染管线谁先做：采纳批评者意见，把办公内容包提前到 W4a，可单独发 0.3.1。理由是它是纯内容，不依赖引擎重写，也直接回应用户 08-20「像 cowork 一样」的表态。需要改结构的助手空态修复留在 W8a；genui 的封闭指令协议推迟到 0.6.0 之后。
- sync.hello 的 protocolVersion：上一版以「新版遇到缺失字段按旧版处理」为由推迟到 W6，本版改为采纳，前移到 W2b。批评者指出上一版只论证了新版接收旧版这一个方向；反方向，也就是 0.3.0 接收 0.4.0 带来源标记的合成消息，并不安全。W5c 另外规定：对端没有声明能力，就不推送合成消息，并加上 0.3.0 线格式回放测试。
- 溢出之后能不能降级：pi、DSH、ZCode 三家都是「溢出不降级，先压缩再重试」。本版在 W2a 暂时允许降级到更大窗口的槽位，并如实提示（采纳批评者），理由是 0.3.0 还没有「强制压缩后同槽重试」这条救援路径，完全禁止降级会让长会话停在「上下文已满」里出不来。等 W5a 落地强制压缩重试，降级退为最后手段，而且只降到更大窗口的槽位。
- DeepSeek V4 的 reasoning_content 回放：批评者建议 W3 用真 key 测出 400 再提前。本版直接放进 W2a，只对 deepseek-v4* 生效。理由：两家参考独立印证了这个问题（pi 的 detectCompat 对 deepseek.com 强制回放，OpenMinis 源码注释记录了现场 400）；云端没有真 key，等 W3 测出来再回头会打断发布；改动面小，并有「非 deepseek-v4 的请求体逐字节不变」测试兜底。W3 的真 key 冒烟仍作为验收门。
- Claude 前缀校验的 W5 设计：采纳批评者意见，修正上一版「改助手规则或技能启停时重算 system」的写法。system 在会话内冻结，所有变化都走追加消息；keep-tail 压缩之后剥掉保留回合里的 thinking 块，官方端点再带 drop_block；验收补上压缩、改规则、memory_write、禁用 MCP 四个场景。
- 强制压缩同槽重试没有放进 W2：批评者没有要求这一项。为控制 0.3.0 的范围，W2a 只做到三件事：压缩输入有界、溢出后如实给出路、允许降级到更大窗口。强制压缩重试放在 W5a，与结构化压缩一起做。
- 执行面硬化（realpath 围栏、子进程环境擦除、web_fetch 防 SSRF）放在 W6d，没有放进 W2（批评者给了 W2 或 W6 两个选项）。理由：擦除环境变量会改变依赖环境变量 token 的 MCP 的行为，需要确认卡配套；junction 逃逸目前只是按代码推断，需要真机复现。首发先在 W2b 装上 Electron 权限请求白名单。
- 备份与恢复没有排进 0.6.0 之前，只列入 0.6.0 之后的首批：它是 L 到 XL 级，而且必须先定下删除墓碑（W8c），否则「恢复旧备份」和「对端推回已删会话」会缠在一起。本地日志和 crashes.json 按批评者意见提前到 W2b，诊断包导出放在 W6a。
- 数据根收窄的边界：采纳批评者「免审只留会话桶」的意见，并额外把读取 minis.db 和其它会话的桶也纳入权限卡，因为 files.ts 自己的注释就把 minis.db 列为外泄目标。mcp-servers/、skills/ 是直接拒绝还是走卡，交用户拍板；默认走卡，因为用户可能确实想让 agent 帮忙写技能。
- 测试文件计数：批评者给的是 94/19，本次按字符串匹配 grep 得到 96/21（含注释里的引用），统一写成「约 95 个，其中约 20 个」。上一版 rewrite_map 引用的 offload.ts:204/233 和 prune.ts:261/262/275 行号有误，已按源码更正为 offload.ts:5/:34、prune.ts:25/:26/:39。
- context.md 中已被复核降级的两条，没有当作严重缺陷处理：#2 同批工具并发不会丢更新，只是先后次序无保证，放进 W7a 的调度接缝；#10 桥不认证对端，同一用户的进程本来就有同等权限，放进 W6d，作为低优先级。

## 完备性批评（修订前）

批评者对第一版裁决提出以下问题。修订版已逐条处理：采纳的已改进路线，不采纳的理由见上节「评审分歧与处置」。

- 【高】波次排序：Claude 最新模型和 DeepSeek V4 这两条主力 provider 路径可能在 0.3.0 里静默失效，但裁决把修复排在发版后的 W4/W5，发布前既不止血也不做真 key 验证。另外 W5 自己的设计也会触发 preserved-thinking 校验。　修法：W2 加最小缓解：只对官方 api.anthropic.com 上的 Fable 5.1 和 Opus 5.5 带 thinking-binding-controls-2026-08-01 头，并设 thinking.block_binding.prefix_mismatch_behavior:'drop_block'（第三方兼容端点不带）。同时把 prefix_binding_mismatch 类 400 标为不可降级。W3 验收加真 key 冒烟：设 prefix_mismatch_behavior:'error'，技能写明任何账号设了这个字段都会进入强制校验，所以老账号也能测。场景包括 memory_write、跨日志、压缩一次、DeepSeek V4 关闭档多轮工具调用。测出 400 就把 deepseek 的 reasoning_content 最小回放提前到发版前。W5 改为：system 变化走追加的 system 或带来源标记的消息；keep-tail 压缩要剥掉保留回合里的 thinking 块，或者带 drop_block；验收补上压缩和规则变更两种场景。
- 【高】漏掉一个绕过权限网关的缺陷：数据根整体免审批写入，而数据根里放着应用自己的配置。agent 可以不经任何权限卡改 providers.json 和 servers.json，裁决和矩阵都没发现，也没排入任何波次。　修法：并入 W1（数据完整性）：免审批范围收窄到当前会话的 sessions/<id>/ 各桶（加上需要时的 shared/），写 providers.json、mcp-servers/、skills/、memory/、minis.db 和其他会话的桶一律走权限卡或直接拒绝。先写红测：file_write('/var/minis/mcp-servers/servers.json') 必须弹卡或被拒。
- 【高】规模估计系统性偏低：W4 到 W9 都标 L（按裁决的说法就是 a/b 两个子波），但每波装了 5 到 10 项矩阵自己评为 M 或 L 的能力，实际量级约是标注的 3 到 5 倍。0.4.0、0.5.0、0.6.0 的节奏因此失真。　修法：把 W4 到 W9 重标为 XL，并按「每个子波最多 2 个 M」拆成明确的子波清单，重新给出各版本预计需要几波。W2 显式拆成 W2a（静默失效和撒谎类止血）和 W2b（发布工程和文档），两者都在 W3 之前完成。时间线拉长后，更新通道必须在 0.3.0 前定下来（见另一条）。
- 【中】W2 的压缩止血不完整：摘要输入仍然没有上界，第二次压缩起请求本身就可能超窗。而溢出在 W2 被改成不可降级，手动压缩、截断、接力要到 W5 或 W8 才有，所以 0.3.0 的长会话会停在「上下文已满」出不来。原本模型组降级到大窗口模型有时还能救回来，这条路也被关掉了，属于回退。　修法：W2 同时做输入有界：以最新 marker 的摘要加锚点之后的增量为输入，压平后的文本按窗口预算截取。模型组里有更大窗口的 slot 时，溢出仍然允许降级过去，并如实提示「因上下文已满改用 X」。「上下文已满」提示附一个「新建会话并带上摘要」按钮。压缩请求在 5 系上放宽到 16K，或按模型门控传低 effort。
- 【中】W1 的 MCP 编辑防丢验收漏了一条已存在的数据损坏路径：args 在编辑时会按空白重新切分，带空格的参数（比如 Program Files 路径）只要保存一次就会被拆坏。　修法：W1 的 payload 只提交用户实际改动过的字段；args 用列表编辑器，或者在未修改时原样保留。mcp-config-edit-preserve 测试加一条：args 为 ['C:\\Program Files\\x']，只改 note 后保存，args 逐元素相等。
- 【中】有几处「对模型或用户撒谎」的缺陷，最小修法都是 S，却排在很后面：卸载桩的取回死循环和修剪桩指向不存在的文件在 W5，交接 §6 一档的 ModelBar 猜默认值在 W9。这违反「静默失效先修」和教训 3。　修法：W2 加三刀：offloads 桶内的 file_read 结果豁免再卸载；修剪桩文案改成如实说明，或者让被修剪的结果也落文件；ModelBar 标题改为「默认模型」，未绑定时胶囊显示「默认 · X」。三处各配一条红测，分页和搜索仍留在 W5 和 W9。
- 【中】已识别的安全硬化项没有排进任何波次，not_doing 里也没写：realpath 围栏、子进程完整继承环境变量、web_fetch SSRF、Electron 权限请求白名单。　修法：realpath 和子进程环境擦除（零依赖，S 到 M）并入 W2 或 W6，需要 Windows 真机复现 junction 逃逸。权限白名单并入 W2 的窗口守卫。web_fetch SSRF 放进 W6。如果决定暂缓，就写进 not_doing 并给出理由。
- 【中】几项高价值能力既不在任何波次，也不在 not_doing 或 0.6.0 之后的清单里：项目指令文件（AGENTS.md/CLAUDE.md）、备份与恢复、首个公开版的本地日志和诊断包。　修法：W2 或 W3 加 S 级的本地按天日志和 crashes.json（只落本地）。AGENTS.md 加信任卡并入 W5，与前缀只追加一起设计。备份恢复（db.backup 加打包）列入 0.6.0 之后的清单，或者写进 not_doing 并给出理由。
- 【中】跨版本同步冲突：W5 开始落库带来源标记的合成消息（记忆和日志快照、提醒），而协议版本握手推到了 W6。0.3.0 的对端不认识 source 字段，会把这些合成消息当成用户发言显示，也会送进自己的模型上下文。　修法：sync.hello 的 protocolVersion 和能力位提前到 W5 或更早。对端不声明支持 source 时，合成消息不推送（或推送时降级为 EventNote 形态）。加一条「0.3.0 线格式回放」测试。
- 【中】更新通道的默认决策和裁决自己的推理冲突。默认「0.3.0 不带自动更新」，而 publish: github 在私仓下永远 404，这意味着每个 0.3.0 用户都得手动下载才能拿到 W4 和 W5 的 provider 修复。按实际规模，这个窗口会很长。　修法：把更新源决策列为 W3 的前置阻断项，默认改为「generic provider 指向公开静态托管」。这只是配置改动，不加依赖。0.3.0 装机包里写死的 feed 决定了它以后能不能自动升级。
- 【低】与用户历来表态的排序张力：用户 08-20 明确的战略诉求是「不止 coding，像 cowork」，裁决把所有 cowork 内容都放到 W8 和 0.6.0。按真实规模算，这可能是几个月后的事。　修法：0.3.0 之后把办公技能包和配套助手作为纯内容子波提前（比如与 W4 并行，或放进 0.3.x）；结构性的欢迎页和助手态修复仍留在 W8。
- 【低】零依赖和许可证有几处隐患：W4 的备案「把 xvfb 剧本迁进主库」会引入 playwright-core；借用 Apache-2.0 代码缺少署名方面的验收；W8 的 `$$vault:` 语法和现有的 `$$NAME` 引用冲突。　修法：备案改为用 Electron 自带的 webContents.executeJavaScript 和 capturePage 驱动（DSH 建议），或者把引入 playwright-core 列为「需用户破例」。每波凡是借用 Apache-2.0 或 MIT 代码的，验收加一条：THIRD-PARTY-NOTICES 已登记，改动文件头已声明。vault 引用改用不与 ENV_REF_RE 冲突的语法，并配测试。
- 【低】有几处引用没核实就写了：rewrite_map 的行号是错的；「96 个测试文件都是行为测试」说过了头。　修法：更正行号，免得执行者按行号找不到代码；把「96 个都是行为测试」改成「约 94 个行为测试（含部分源码守卫）」。
- 【低】有几条验收标准没法客观判定。　修法：zip 炸弹改为断言在 inflate 之前就按 entry.uncompressedSize 或累计值拒绝。W9 先给目标值（比如 1 万个 delta 时主线程最长任务不超过 250ms，参照 DSH），实测后只允许收紧、不许放宽。W2 加 README 能力表逐行核对清单，写进提交正文。

## 三位评审的原始方向

### user：组合

结论：B 定向革新为主，A 点状补齐为辅，外加一个「先止血、后发布」的前置波。不选 C。  【保留】以下部分不动： - minisd（utilityProcess）+ Electron + Vue3/Pinia 骨架，JSON-RPC 边界。 - T 波新 UI 树 src/renderer/src/ui/，不做第三次换皮。 - DB 只追加迁移，better-sqlite3 同步写，工具执行前 assistant(toolUse) 已落库（等于天然的检查点）。 - 权限网关与 90 秒无人应答规则。 - 零依赖自建的 Office、Markdown、SSE、差分。 - 助手、定时任务、市场、同步这些 cowork 地基。  【定向重写】两块，各一次到位并配不变量红测，不在旧实现上层层打补丁： ① 上下文管线：compact.ts 138 行、context-policy.ts、prune.ts、offload.ts，以及 minisd/index.ts 的 promptFactory 组装。改成增量结构化压缩 + 溢出后强制压缩并重试一次 + 以真实 usage 为锚的水位 + 前缀只追加 + 卸载内容可取回。 ② 会话协议层：renderer/src/rpc.ts 71 行 + minisd 事件出口 + chat store 事件层。改成断连结算 + 自动重连 + 快照/序号续传 + 按订阅投递 + 幂等。  【重构】三处： - agent/loop.ts（594 行）：加注入点（插话、截断调用、逐个落库、副作用调度）。 - provider 层：错误分类，思考形状按模型代际建表，compat 矩阵，reasoning_content 回放，缓存用量口径。 - main/index.ts 生命周期：单实例、崩溃预算、优雅退出、启动失败分类。  【点状补齐（A）】其余全部：人在回路交互、撤销、办公内容包、渲染打磨、浏览器。  【0.3.0 的位置】先做一个只收「伤数据 / 撒谎 / 挂死」三类的 W1 止血波，W1 完成后立刻在 Windows 真机按 docs/RELEASE.md 发布。定向重写从 W2 开始。  【为什么不选 C（重构）】 - 三个能力簇核验下来，没有任何一项需要换引擎架构或换 UI 框架。 - 引擎体量小：loop.ts 594 行，各 provider 134–197 行，成批重写可行。 - 嵌外部运行时（aioncore 是 Rust，pi-ai/zcode-cli 要引 npm 依赖，ZCode 约 29 万行）违反零依赖和「minisd 独立进程」这两条硬约束。 - AionUi 设计 token 自基线以来零变更（aionui.md 总述），S/T 波的数值仍然对得上，重做 UI 没有依据。 - 历史上两次重做让 0.2.0 从未发布；再来一次 C，等于再次放弃「可发布」这个 /goal。  【为什么不选纯 A】 - 交接 §6 的待办把精力导向三档新功能（genui、对话墙、图片生成），但核心循环有正确性缺陷：   - 压缩在当前 Claude 上很可能从未成功过：tests/compact.test.ts:92 钉死的角色序列以 assistant 结尾，loop.ts:340 的 catch{} 把失败吞掉；   - 溢出被当成「所有模型均不可用」：providers/types.ts:27；   - 卸载桩的内容取不回：offload.ts；   - 断连后界面永远显示「运行中」：rpc.ts 没有 onclose。   在这上面继续加功能等于建在沙上。 - 崩溃重启、重连、快照、订阅、插话、等待态六项彼此咬合，零散点修只会反复返工，也就是用户反感的四不像。  【三档候选重排】 - 用量面板：数据列在 W3 落，面板在 W6 做。 - 全文搜索：用 LIKE 即可，降级到 W6。 - genui：先做「回合改动 / 交付物卡」这一形态，放 W6。 - 内置浏览器：放 W8，先出设计稿。 - 多窗口对话墙、图片生成：顺延，等 W4 的订阅投递和 W8 的视觉能力就绪再评。

发版位置：0.3.0 放在 W1 之后、W2 之前：先做 W1 止血，然后在 Windows 真机按 docs/RELEASE.md 重跑 e2e:m5、verify-release 和手动冒烟后上架。  【为什么不等引擎重写做完再发】 - W2/W3 合计是 M+L，需要真实端点验收。塞进 0.3.0 就会重演「0.2.0 做完发布就绪、又被重做覆盖、始终没发」的旧路。用户的 /goal 是「做成可以发布的版本」，Releases 停在 v0.1.1 本身就是最大的用户价值缺口。  【为什么不原样直接发】 - 当前代码会静默改坏文件：files.ts:123 的 $ 序列。 - 读失败时会覆盖用户的 servers.json；SecMcp 编辑保存会抹掉 env/headers。 - 双实例会同时写一个库；断连后界面永远显示「运行中」。 - 空摘要会抹掉上下文，溢出被报成「所有模型均不可用」。 - 别的会话的权限卡会冒充当前会话，可能让用户批错对象。 - README 宣称了不存在的自动更新和记忆同步。 这些随首个正式版发出去，违背「界面撒谎比难看更严重」，而且修复都是 S 级。  【之后的节奏】 - 0.4.0 = W2+W3：provider 正确性加长任务引擎。 - 0.5.0 = W4+W5：韧性加人在回路，是用户最能感知的 cowork 升级。 - 0.6.0 = W6+W7：内容、撤销、打磨。 - W8 浏览器单独发版。 私仓期间自动更新不可用，每次发版用户都要手动下载。所以发版频率取决于用户对更新源的拍板：如果转 public 或走公开静态托管，可以改成每一波一发。

### risk：组合

组合方案，概括为「先止血并发布，再搭验收地基，然后对引擎做定向 B，界面继续走 A，排除 C」。  保留不动的部分： - minisd、Electron、Vue 三层骨架，以及 WebSocket JSON-RPC 边界。 - 数据库的只追加迁移体系（store/db.ts 的 MIGRATIONS[0..10]）。 - 零依赖自建的 Office、Markdown、SSE 和权限网关。 - T 波之后的 ui/ 组件树（35 个 .vue 文件）。不做第三次换壳，界面只在现有树上按能力差距逐项增加，每次改动都在 xvfb 下目视。  成批重写（B）只限三处，每处都能被行为测试覆盖： 1. 上下文管线：agent/compact.ts（138 行）、context-policy、prune、offload、溢出分类。 2. provider 请求形状层：一个纯函数 anthropicThinkingShape，一个 OpenAI compat 对象，外加字节级黄金快照。 3. 会话协议层：renderer/src/rpc.ts（71 行）、stores/chat.ts 的事件投影部分，以及 main 对 minisd 的监管。loop.ts（594 行）只重构，不重写。  为什么不选纯 A： - 压缩、溢出重试、真实 usage 水位、提示前缀稳定四件事互相依赖，矩阵的跨簇结论已经指出这一点，分开点修会互相掩盖。 - claude-api 技能文档说明，2026-08-31 起新建的账号在 Fable 5.1 和 Opus 5.5 上会强制校验前缀：system、tools 以及此前每条消息都必须字节不变。DeskMinis 在每个 step 重建 system（index.ts promptFactory），prune 用 12 条滑动窗口，媒体占位只保留 2 轮，CONTINUE_HINT 注入后下一轮又删掉。这些做法会从「缓存失效」升级成 400，而 400 又被 providers/types.ts:27 判为可降级，结果是会话被降级并改绑。点修只能压住表面症状。  为什么不选 C： - 最有价值的测试资产在引擎侧。173 个测试文件里有 95 个直接 import src/minisd，做的是行为测试。 - 渲染侧 53 个测试中有 47 个是 readFileSync 读源码文本的守卫，没有一个真正挂载组件。T 波已经证明，这类守卫在 1890 例全绿的情况下没拦住「权限卡从没渲染过」。 - 如果换引擎或嵌入外部运行时，引擎侧 95 个文件的行为网会一起作废。如果再换一次 UI，就是在没有有效测试网的区域做第三次搬家。 - 四个簇里几乎所有能力都能在现有骨架上零依赖补齐，唯一例外是 OS 沙箱（参考实现依赖 koffi），不存在必须推倒的架构理由。  对现有测试的影响和处理纪律：B 波会让一小批「把错误行为钉死的测试」变红，这是设计意图。已知的有两处：tests/compact.test.ts:92 钉死了以 assistant 结尾的角色序列 ['user','user','assistant']；tests/provider-errors.test.ts:29 钉死了 400 可降级。每个 B 波的设计稿要先列出「预期翻红的用例清单」，提交时逐条申报，其余用例必须保持绿。

发版位置：0.3.0 放在 W0a 和 W0b（止血）之后、作为 W1 单独发布，排在 W2 到 W5 的任何成批重写之前。理由有四条：  (1) 降级打开守卫（db.ts）只有装在「旧版」程序里才能保护「新库被旧程序打开」的情形。0.3.0 是第一个公开版本，必须带着它出去。  (2) 仓库私有，electron-builder.yml 的 github provider 检查更新会 404，0.3.0 里带出去的缺陷无法靠自动更新修正。file_edit 的 $ 改写、servers.json 被空列表覆盖、SecMcp 编辑丢 env 和 headers、双实例同写一个库、空摘要写入 marker 这类会损坏数据的问题，必须在上架前修掉。  (3) L 级的引擎重写不能挡在发布前面。历史上两次重做让 0.2.0 从未发布，用户的 /goal 就是「可以发布的版本」。  (4) 先发布，可以得到一条经过 Windows 真机验证的已知良好基线，W3 到 W5 的回归都拿它对照。  之后的节奏：每个 B 波（W3、W4、W5）结束后各走一次 Windows 验证，发一个 0.3.x 补丁版或 0.4.0，数据库迁移按版本批量合并。前提是用户先决定自动更新渠道；否则每个版本都要写明「需要手动下载覆盖安装」。

### arch：B 定向革新

【保留】 - 进程与传输拓扑：minisd 跑在独立 utilityProcess，通过 WebSocket JSON-RPC（per-run token）通信。ZCode（utilityProcess Host）、DSH（RunAsNode Host）、AionUi（外置引擎）都收敛到这个形态。 - 存储：better-sqlite3，只追加迁移。 - 上下文哲学：「raw 永不改写、推理时合成」。pi 0.87 的 context_edit 投影、DSH 的 surface 折叠证明这条路线是对的。 - 其余资产：T 波新组件树与 theme.css；自建的 Office、Markdown、SSE；权限网关；同步协议。 - 渲染层与 minisd 同仓构建，天然没有版本漂移。AionUi 的壳和引擎不同仓、锁步发版，这正是它的软肋，不要为了「像 aioncore」把 minisd 拆出去。  【成批重写三块，每块边界明确、对外接口不变】 ① 回合引擎（agent/loop.ts、compact.ts、prune.ts、offload.ts、context-policy.ts，以及 index.ts:657-668 的 promptFactory）重写为「请求投影纯函数 + 回合驱动器」。 - 投影的输入只允许是持久化、单调推进的状态：冻结的 system 纪元、compact marker、落盘的削减决定、带来源标记的追加消息。 - 不变的部分：LoopEvent 只增不删；AgentProvider 接口不动；store 只追加列；pairToolResults、safeToolInput 等已测函数原样保留。 ② 会话运行时与连接协议。 - minisd 侧：把 index.ts 闭包里的 inFlight（:404）、controllers、pendingPerms（:281）、runDoneHooks 抽成 SessionRuntime 和 InteractionRegistry。 - 协议：事件带 epoch 和 seq，新增 watch/snapshot/pending 三个只读 RPC，改为按连接订阅投递。 - 主进程：抽出 launcher/supervisor。 - 渲染端：rpc.ts（71 行，没有 onclose）和 chat store 的事件层，重写为带连接代次的 RpcClient 加按会话键控的投影 reducer。store 对组件暴露的 action 名保持不变。 ③ 消息渲染管线：流式合批、增量 Markdown、历史解析缓存、封闭指令节点（给 genui 留位）。  【其余子系统】 - provider 层做数据化重构（规则表、错误分类器、黄金快照），SSE 解析不动。 - 工具、MCP、设置、cowork 能力原地修。  【为什么不选 A】 - 缺陷是两条咬合的链：上下文簇是「溢出 → 压缩 → 水位 → 前缀稳定 → 思考形状」，运行时簇是「崩溃重启 → 重连 → 快照 → 序号 → 订阅 → 排队」。点状修补会互相掩盖。例如先接上溢出重试，但压缩请求本身以 assistant 结尾会 400，又被 loop.ts:340 的 catch{} 吞掉。 - 未来一年要做的子代理、计划模式、插话、对话墙、genui，每一项都至少依赖以下五个接缝中的两个：SessionRuntime、InteractionRegistry、消息来源标注、按会话投影、工具副作用元数据。今天这五个都不存在。继续往 1235 行的 index.ts 闭包和只认一个 activeId 的 627 行 store 上堆，一定会返工。  【为什么不选 C】 - 运行时簇 28 项能力、agent 簇除 OS 沙箱以外的所有项，都能在现有骨架上零依赖实现。 - 引擎本来就小：loop.ts 594 行，compact.ts 138 行，各 provider 134–197 行。重写成本是一两波的量级，不需要换架构。 - pi 的新架构（chord、protocol v8、durable）仍在实验面：Unix 传输在 win32 上直接抛错，harness format 4 自述是 WIP。 - DSH 弃用 SQLite 的起因是按 delta 存的 116MB v0 日志；DeskMinis 按消息落库，这个起因不适用。 - 嵌入外部运行时（aioncore、ACP）会丢掉权限网关、Office、同步这些自建资产，也会撞上零依赖红线。 - UI 再推倒就是第三次换皮。AionUi 的设计 token 自基线以来零变更；T 波推倒重建后，用了 V、T6、Y、Z 四波才把遗失的入口补回来。

发版位置：0.3.0 放在 W0 之后、W1 之前发布。W0 预计 2–3 天，只收三类：静默数据损坏、安全、首发即冻结。做完后在 Windows 真机走 RELEASE.md 和 e2e:m5，发 0.3.0。  理由有三： 1. 0.3.0 是第一个公开版，有几样东西一经发出就冻结在用户机器上，旧版无法追补：    - updater 配置：当前是 publish:github 加私仓，检查会 404，0.3.0 用户将永远收不到自动更新；    - DB 降级守卫：用户回装旧版时，只有旧版自己带守卫才拦得住；    - 同步握手的版本号；    - 数据目录锁。    这些必须在发版前钉好。 2. W1 到 W3 会成批改动 provider 边界、回合引擎和连接协议。先发一个稳定基线，后续回归才有参照，也能打破「两次 UI 重做让 0.2.0 从未发布」的循环。 3. W2 和 W3 是 L 级重写，需要真 API 加真机的多轮验收。如果要求「重写完再发」，会第三次拖住发布。  之后的版本节奏： - 0.3.x 补丁线只接 W0 类修复； - W1 加 W2 完成后发 0.4.0（引擎与 provider）； - W3 加 W4 完成后发 0.5.0（运行时韧性与人在回路）。
