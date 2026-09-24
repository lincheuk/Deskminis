# aionui:verify
总述：AionUi v2.2.2（HEAD 6744099，2026-09-09；aioncore pin v0.2.2）的形态和基线 v2.1.59（74512d3）一样：Electron 瘦壳（process/ 下 78 个文件，只做平台加固和桥接）+ React 渲染层（979 个文件），再加独立的 Rust 引擎 aioncore。渲染端经 common/adapter 的手写 HTTP/WS 契约直连引擎。

两个版本之间有 30 个提交、307 个文件、+16707/−1411 行，变化几乎全在渲染层。renderer 改了 186 个文件、+8323 行，其中 78 个是 locale JSON（按文件数约 42%，按行数只有约 18%）。以下几处自基线以来没有任何提交：process/（只有 petEventBridge 删了 7 行死订阅）、web-host、web-cli、shared-scripts、mobile、scripts、.github、AGENTS.md、docs/prds。主进程唯一的实质改动是 index.ts 为了字体枚举，装了一个对所有权限一律放行的 handler。

设计 token（色板、圆角、阴影、主题）零变更，唯一的 token 变化是字体变量化。所以 DeskMinis S 波照抄的数值仍然有效，只需补两条基线漏记：默认 0.95 缩放，以及浮层菜单基线就有的轻玻璃。

功能上的新增集中在五条线：
1. 「等待你」状态和桌面待确认通知。
2. 计划条钉在输入框上方，并能恢复快照。
3. 归档优先，外加已归档管理页。
4. @@ 跨会话提及与投递，带限流急停和总开关。
5. 一批壳层体验：空输入开会话并显示助手空态、分区字体、侧栏可拖宽、预览最大化和 tab 菜单、未选模型保持 null、WebUI 401 静默续期、WS 重连风暴修复、explorer 按 tab 刷新。

另外新引入 wavedrom 和 json5 两个依赖，删掉了死事件 confirmation.add/update 和误提交的 Sentry 台账。每个功能 PR 基本都带 DOM 测试；判定逻辑多抽成纯函数，并在注释里写明踩过的坑。

对 DeskMinis 的价值分两类。一类是本期新增的状态可见性（等待态加系统通知）、空会话助手态（能从结构上修掉欢迎页选助手的既有撒谎）、归档、计划条、可拖分栏。另一类是基线前就有、上次没覆盖的进程生命周期加固：单实例、崩溃重启与 rpc 重连、dev 数据隔离、库版本识别、启动失败分类、退出清理、渲染与 GPU 恢复、发布资产校验。两类都能用 Electron 和 Node 内置能力零依赖地实现。

要点变化：
- v2.2.1（7d1c7b7、cbabbc8）：侧栏区分「等待你」和「生成中」。从 permission、acp_permission、ask 三种流帧推出每个会话的待确认 id 集合（纯 reducer），用 Attention 抖动图标显示，优先级高于 Spin。桌面原生通知从「只报回合完成」扩展到待确认，按 conversation_id+msg_id 去重，正文带会话名（截断到 20 字）。
- v2.1.61（300e3e1，core #916）：计划从消息流移出，改由 ConversationPlanBar 钉在输入框上方。只显示最新全量快照，且 turn_id 必须等于当前运行回合；计划行用确定性 id plan:{msg_id}。重开会话时经 /messages/latest?type=plan 回捞。AcpChat 和 AionrsChat 两处都挂了这个组件。
- v2.1.60/61（18e4fdd、3fce329，core #911/#925）：侧栏所有「删除」改为「归档」，改用主色；新增 /settings/archived 页，首屏 5 条、每次加载 10 条，可恢复或永久删除。core 在归档时拆掉 agent 进程。
- v2.1.60（c83bc49，core #914/#949/#952）：@@ 跨会话提及与投递。靠正文里的带内标记块 [[AION_SESSIONS]] 和 [[AION_SESSION_MESSAGE]] 传递，UI 端反解渲染；outbound 和 pair 两道限流门推送 sessionMessage.rateLimited，前端弹不自动消失的急停通知；总开关收成模块级共享 store。
- v2.1.60（57bfc79、4a2a32d）：选了助手后空输入也能建空会话，窗口显示 SingleChatEmptyState（48px 头像、16px 名称、13px 问候语）；空标题显示「未命名」占位，仍可点击改名。
- v2.1.61（74b5d32、2c7bc76）：按区域（app、chat、markdown、code）选字族和字重，app 区新增字号。空值时 removeProperty，由 var(--x, 内置栈) 兜底。为了让 queryLocalFonts 能用，主进程 index.ts:720-730 装了 setPermissionRequestHandler(cb(true))，所有权限一律放行，这是本期主进程唯一的实质改动。
- v2.1.60/61（446e83e、15042d9、7909246）：侧栏可拖宽（200px 到 50vw），拖到下限以下吸附收起、不写盘，双击复位到 260。预览面板可最大化（聊天区隐藏但保持挂载）；tab 右键菜单改为 portal 到 body，修掉 fill-mode 留下的 transform 让 fixed 菜单跑出屏幕的问题，并补齐复制路径和在文件夹中显示。
- v2.1.61（ded1f7d）：「未选模型」一路保持 null，发送时省略 model，不再用 CLI agent 缓存的 current_model_id 或 available_models[0] 顶替。
- v2.2.1（4f7da7e、16589d8）：只对 WebUI 浏览器模式。401 或 WS 1008 时单飞调 /api/auth/refresh 后重放；WS 退避 500ms 到 8s，连接稳定 5s 才重置，终止态和已排队的重试都不再被 emit 重新拨号。
- 依赖与版本：package.json 新增 wavedrom ^3.6.2、json5 ^2.2.3，锁文件带进 bit-field、logidrom、onml、tspan、fs-extra，现在 dependencies 104 个、devDependencies 52 个。aioncoreVersion 从 v0.1.70 锁步升到 v0.2.2，其间 5 次 bump。
- 清理：删除死事件 confirmation.add/update（后端自 AionCore PR #27 起就不再发出），团队徽标和待审批计数的实时 +1 路径早已静默失效；删除误提交的 9 个 sentry-feedback-resolutions/*.json；删除 MessagePlan.tsx。
- 设计体系零变更：default-color-scheme.css、builtinThemes.ts、uno 的颜色和圆角都没有 diff。基线勘误三条：默认窗口缩放 0.95（zoom.ts，基线已有）；/、@ 浮层和搜索弹层基线就用了 blur(14px) 轻玻璃；本仓文档让贡献者直接 git clone AionCore 自建，「闭源」的说法不成立（许可证未核实）。

核验后发现（按相关度降序；verdict=CONFIRMED/CORRECTED；DM=DeskMinis 现状）：
- R5 [corrected|ux-flow|新:yes（v2.2.1）|DM:missing] 会话「等待你」状态：侧栏用专门图标区分「卡在权限或提问上」与「生成中」：7d1c7b7（v2.2.1）的做法：
- 从 permission、acp_permission、ask 三种流帧推出每个会话的「待确认 id 集合」。
- 核心是纯 reducer applyWaitingConfirmationTransition，有 mark、unmark、clear 三种转换；unmark 除了去掉对应 id，还会顺带去掉运行时哨兵 id。confirmation.remove 按 id 逐个清除，终态帧整体清空。
- 状态放在模块级 store，通过 useSyncExternalStore 订阅；只有布尔值翻转时才通知订阅者。
- ConversationRow 的前导位显示 Attention（filled，16px，text-warning，animate-wiggle 3s 循环；这个动画基线前就在 uno.config 里）。显示优先级是 等待 > Spin > 未读点，等待时还会隐藏置顶拖拽把手。
- 重载后的补标只发生在某个会话 hydrate 或 send-accepted 时：按 runtime.pending_confirmations 用哨兵 id 标记，只标不清。所以没打开过的会话行不会被补上等待标记。 ⇒ 借鉴：1）不用改 minisd：permission.request 广播里的 req 已经带 sessionId，缺口在渲染端 chat.ts:155 没把它存下来。permission.resolved 不带 sessionId，可以由 requestId 反查。
2）在 lib/ 下写纯 reducer：waitingBySession: Map<sessionId, Set<requestId>>。request 时 mark，resolved 时 unmark，run 终态时 clear。先写 vitest 红测试。
3）minisd 目前没有「列出待审批」的 RPC，只有 permission.respond、getPreset、setPreset。rpc 重连或窗口重载后要对账，就得新增一个类似 permission.pending 的只读 RPC，而且要全量覆盖所有会话，别学 AionUi 只在打开会话时才补标。
4）NavRail 的 .semo 位按「等待 > 运行 > 未读 > emoji」渲染；颜色走 --c-warn；prefers-reduced-motion 下关掉抖动。顺手补回 handoff「收窄」里丢掉的会话行运行态徽标。
最受益的场景：定时任务无人值守时，权限询问 90 秒自动拒绝，用户需要一眼看出是哪个会话在等。（核验：AionUi 侧的事实全部属实。改动两处：一是读者建议「minisd 广播补 sessionId」不对，广播里本来就带（types.ts:21、index.ts:307），只需渲染端存下来；二是 F1 说「从 minisd 的待审批列表对账」，但 minisd 并没有这个 RPC。另外补充了 AionUi 自身的局限：重载后只对打开过的会话补标。本条合并了视角一第 1 条和视角二第 1 条中的状态部分。）
- R5 [corrected|platform|新:部分（桌面待确认通知、ask、去重、会话名是新的；主进程聚焦门控和点击跳转是基线前的）|DM:missing（应用自身事件没有任何系统通知；只有 agent 主动调用的 windows-notify 桥工具）] 桌面原生通知扩展到「等待确认」，正文带会话名：基线时，桌面端 useDesktopTurnNotification 只在回合完成时发通知；WebUI 的浏览器通知已经会报 permission。cbabbc8 和 7d1c7b7 之后有四点变化：
- 桌面原生通知也覆盖待确认（权限、提问）。
- 确认类型加入 ask。
- 按 conversation_id+msg_id 去重，防止重连回放同一请求时重复弹出。
- 正文带会话名，由 getSnapshotConversationName 取、截断到 20 字，文案是「『X』正在等待你确认」和「『X』已完成本轮回复」；取不到名称就回退通用文案。
主进程 notificationBridge 的三条规则本期没改、基线就已存在：设置关闭时不弹；主窗口聚焦时不弹；点击后 restore、show、focus，并 emit notification.clicked 跳到来源会话。 ⇒ 借鉴：全部零依赖：
1）主进程用 Electron 自带的 Notification。Windows 必须调 app.setAppUserModelId('com.deskminis.app')，而且要和 electron-builder.yml 的 appId 一致，否则 NSIS 安装版不出 toast；便携版要在真机上单独验证。
2）窗口聚焦时不弹；按 requestId 去重；正文带会话标题并截断。
3）点击后 show()+focus()，再经 preload 白名单通道让渲染端打开对应会话。
4）定时任务的待确认通知要写明「90 秒后自动拒绝」，免得界面撒谎。
5）SecLook 或设置里加一个本机偏好开关，并登记进 mu6 的 WIRED 清单。轻量版可以只做 win.flashFrame(true)。
和上一条（等待态）共用同一个等待集合，mark 时触发通知。（核验：对照基线 diff 核实：主进程的「聚焦不弹、点击聚焦并跳转」在 74512d3 就已存在，notificationBridge.ts 本期零改动，读者把它写成了新能力。真正新增的是桌面端覆盖待确认、ask、去重和会话名四项。视角二把 DeskMinis 判为 partial，理由是有 windows-notify 桥工具，但那是 agent 调用的工具，不是应用事件通知，所以改判 missing。本条合并了视角一第 2 条和视角二第 1 条中的通知部分。）
- R5 [confirmed|safety|新:no（基线前已有，基线报告没覆盖）|DM:missing] 单实例锁加数据目录实例守卫（对端占用时退避重试）：主进程一开始就调用 app.requestSingleInstanceLock({deepLinkUrl})。第二个实例经 additionalData 把 deep link 交给第一个实例后退出；second-instance 事件里聚焦或重建主窗口。E2E 测试和 AIONUI_MULTI_INSTANCE 可以显式绕开这把锁。
引擎侧还有第二道闸：aioncore 发现数据目录已被别的实例占用时，报边界码 BOOTSTRAP_PEER_ALREADY_RUNNING；launcher 按 250/500/1000/1500ms 退避，最多重试 5 次，不当作致命错误。 ⇒ 借鉴：DeskMinis 托盘常驻，又同时有便携版和安装版，两份实例同时打开 minis.db、同时跑 mDNS 同步的风险是真实存在的。
1）main/index.ts 顶部调 app.requestSingleInstanceLock()，拿不到锁就 quit；second-instance 里 show+focus 主窗口。
2）minisd 在 dataRoot 用 fs.openSync(lock,'wx') 独占创建锁文件，写入 pid 和启动时间。锁已存在时用 process.kill(pid,0) 判断持有者是否还活着：陈旧锁直接接管，活锁就返回带码错误，由 main 显示「另一个 DeskMinis 正在使用数据目录」。
全部用 Node 和 Electron 内置能力；取锁和接管陈旧锁都可以先写红测试。（核验：逐行核对了 index.ts:82-118 和 backend-launcher 的 PEER_RETRY 常量。DeskMinis 侧 grep 零命中。）
- R5 [confirmed|architecture|新:no|DM:missing] 引擎崩溃有界重启（60 秒内最多 3 次）；DeskMinis 的 minisd 握手后崩溃，界面会无声失联：web-host 的 BackendLifecycleManager 对启动后崩溃的引擎做有界重启：restartWindowMs 为 60000、maxRestarts 为 3，超出就进入 error 态。这和启动阶段的「对端占用」重试是两套正交机制。
对照 DeskMinis：
- main 只在握手完成前处理 minisd 的 exit。
- 渲染端 rpc.ts（71 行）没有 onclose，也没有重连；socket 断开后，pending 请求永远不会 resolve 或 reject。 ⇒ 借鉴：main 侧：握手后的 exit 也要处理，照 AionUi 设「60 秒内最多 3 次」的重启上限；重启后经 IPC 推送 minisd:restarted，新端口和 token 仍然走 minisdInfo() 获取。
渲染侧 rpc.ts：
1）加 onclose，先把所有 pending 用可读的中文错误 reject 掉。
2）按「500ms 到 8s 指数退避、连接稳定 5 秒以上才重置、已有排队的重试就不再重拨」重连，每次重连前重新取 minisdInfo。
3）断开期间在顶栏显示横幅。
可以在 node 里用已有的 ws 依赖起一个假服务端，给 RpcClient 做 TDD。（核验：原视角三第 2 条把引擎重启和 WS 重连风暴修复写在一起，这里拆开。引擎重启是基线前的（web-host 零提交）；WS 重连修复并入下面的「WebUI 会话韧性」条。DeskMinis 的两处缺口都读源码确认过。）
- R5 [confirmed|dx-testing|新:no|DM:missing] 发布资产自动校验，并用 mock 产物在 CI 里回归脚本本身：scripts/verify-release-assets.sh 断言以下几点：
- 四个平台的 latest*.yml 都在。
- 每个 yml 的 path/url 字段匹配预期的平台模式。
- 它指向的安装包真实存在。
- web-cli tarball 附带 .sha256。
另外几处配套：
- pr-checks.yml 的 release-script-test job 先用 create-mock-release-artifacts.sh 造假产物，再回归这个脚本。
- release-distribute.yml 分发前校验每个 latest*.yml 的 version 与 tag 一致；目标目录已有文件时拒绝同版本覆盖，理由写明是下游缓存会继续发旧文件。
- tests/unit/releasePackagingConfig.test.ts 用源码文本守卫，把 builder 目标和 workflow 上传的 glob 钉在一起。
注意：AionUi 并不比对 yml 里的 sha512 和安装包是否一致。 ⇒ 借鉴：这正好对上交接文档里唯一的发布阻断项「0.3.0 Release 上架」。
1）新建零依赖脚本 scripts/verify-release.mjs：逐行解析 dist/latest.yml 的 version、path、sha512；断言 version 与 package.json 一致、path 指向的 Setup.exe 存在、用 node:crypto 算出的 sha512 base64 和 yml 相同、.blockmap 存在、便携版命名正确。这里的 sha512 比对比 AionUi 做得更严。
2）package.json 的 scripts 加一行 verify:release，写进 RELEASE.md 第一步，并在 e2e:m5 末尾调用。
3）另写一个 vitest 用例，在临时目录造 mock dist 跑这个脚本：一个正例，加 sha 不符、缺 latest.yml 两个反例，先红后绿。
4）上传前用 gh release view 检查同版本资产是否已存在，存在就拒绝覆盖。（核验：逐一打开了脚本、pr-checks 和 release-distribute 的对应段落。补充了一点：AionUi 不校验 sha512。）
- R5 [confirmed|ux-flow|新:yes（v2.1.60、v2.1.61）|DM:partial（有助手预设和欢迎页开场提示，但空会话没有会话态，欢迎页选助手存在已知的撒谎 bug）] 空输入也能开会话并显示助手空态；空标题仍可点击改名：57bfc79：选了助手后，空输入时按回车或点发送都能建一个空会话。这时不写首条消息，也不自动跑一个空白回合，窗口显示 SingleChatEmptyState。回车和发送按钮共用 send.isButtonDisabled，条件只有「加载中或未选助手」。
空态的头像按以下顺序取：预设 emoji、预设图片、agent 图标，都没有就兜底 Robot 图标；尺寸 48px、rounded-8px、bg-fill-2，emoji 字号 32px。下面是 16px semibold 的助手名和 13px 次级色问候语，gap 20px，max-w 360px。助手名解析时刻意不用 conversation.name 兜底，因为单聊的 name 是标题，不是助手身份。ChatConversation 把 emptySlot 注入 Acp、Aionrs、Legacy 三种会话视图。
4a2a32d：标题为空时显示 text-t-tertiary 色的「未命名」占位，可点区域有 min-h-24px，不会塌成 0 高导致没法改名。 ⇒ 借鉴：这是 DeskMinis 一档遗留 bug 的结构性解法。
1）inChat 改成只看 activeId。StageChat 在 turns 为空时渲染助手空态：emoji、名称、问候语，再把助手的 prompts 作为开场建议。
2）欢迎页选助手时，如果当前会话是空的且没有绑定，就把助手直接绑到这个会话（或新建一个），让副标题的承诺和 send() 的实际行为走同一条路径。
3）回车和发送键继续共用 X 波的重入闸和同一个判断条件。
4）TopBar 标题为空时显示灰色「未命名」，可点击改名，复用 renameSession。
先写 renderer-first-send 风格的调用形态守卫和 store 行为测试，红了再修。（核验：逐一核对了 48px、32px、16px、13px、gap-20px、max-w-360px 这些数值，以及 isButtonDisabled = loading || !selectedAssistantId。DeskMinis 的 AppShell.vue:50 也读源码确认了。本条合并了视角一第 3 条和视角二第 6 条。）
- R4 [confirmed|sync-storage|新:yes（v2.1.60、v2.1.61）|DM:missing] 归档优先：删除入口改为可恢复的归档，设置里提供已归档管理页，归档时回收 agent 进程：18e4fdd 把会话行菜单、批量工具条、项目文件夹菜单、团队菜单里的「删除」统一换成「归档」。图标用 FolderClose，颜色从 danger/warning 改成主色（primary），危险色只留给不可逆的永久删除。
新增 /settings/archived 页（Router.tsx:105）：按项目和普通会话分组，每组首屏 5 条，load-more 每次 10 条（3fce329）；可以恢复、单条永久删除、按项目操作、清空归档。数据走新的 /api/sidebar 命名空间。
core v0.1.72 #925 在归档时拆掉该会话的 agent 进程。
提交说明里记了一个教训：设置页 tab 要在 SettingsSider 和 SettingsPageWrapper 两处注册，漏一处就白屏。 ⇒ 借鉴：1）追加式迁移给 sessions 加 archived_at（NULL 表示活跃），走和 pinned_at 相同的同步路径（wire.ts 已同步 pinned_at），否则一台设备归档、另一台仍然可见。chat.sessions.list 默认过滤已归档会话，新增 archive、unarchive、listArchived 三个 RPC。
2）归档一个正在运行的会话时，先停掉它的 run、长驻 shell 和终端，对齐 aioncore 拆进程的做法，免得留下看不见的会话继续在后台跑。
3）NavRail 的 ⋮ 菜单主动作改为「归档」，用主色；永久删除只放在已归档页，保留二次确认。
4）绑定了定时任务的会话，归档时给出提示。
5）StageSettings 新增的分节必须保持单一注册源，并纳入 mu6 绊线。（核验：常量、路由、颜色 diff 和提交说明都核实过。core 拆进程只能凭 CHANGELOG 判断，本仓看不到 core 源码。本条合并了视角一第 5 条和视角二第 5 条。）
- R4 [confirmed|ui|新:yes（v2.1.61）|DM:missing] 计划条：计划钉在输入框上方，全量快照、确定性 id、重载后恢复：300e3e1 删掉了 MessagePlan.tsx，MessageList 过滤掉 plan 类型；改由 ConversationPlanBar 渲染，AcpChat 和 AionrsChat 两处都挂在 SendBox 上方。规则如下：
- 只取最新的一份全量快照；只在当前会话处理中、且 turn_id 等于正在运行的回合时显示，不显示时不占任何空间。
- 计划行 id 改为确定性的 plan:{msg_id}，实时帧和历史行可以去重；以前每帧生成新 uuid，卡片会反复重挂载。
- usePlanRecovery 在 hydrated 之后经 GET /api/conversations/:id/messages/latest?type=plan 回捞，原因是 upsert 不刷新 created_at，计划行会被分页挤出首屏。
尺寸：
- 根节点 border-top 1px（border-3）、py-6px，不加水平内边距。content-box 下内边距会叠加到计算宽度上，实测 663px 对输入框的 647px，宽出 2×8px。
- 头部：Down/Right 14px 箭头、Badge 标题、12px 的进度 x/y，gap 8px、px 8px。
- 列表：gap 6px、pl 30px，max-height 为 min(22vh,180px)。
- 条目 13px。完成项是 16px 填充的 CheckOne 成功色，未完成项是 14px 空心圆（2px 描边），in_progress 项用主文字色。
有确定性 e2e 注入器 emitPlan/endPlanTurn 覆盖。 ⇒ 借鉴：1）minisd 新增 todo_write 或 plan_update 工具，参数 entries 为 [{content, status: pending|in_progress|completed}]，语义是全量替换，并带上 runId。系统提示词里约定三步以上的任务先列计划。
2）落库沿用消息表：type=plan，id 取确定性的 plan:<runId>，按 upsert 写入。StageChat 切分 turns 时跳过这种类型，免得重复出卡片或把当前状态埋在后面。可以复用现有 JSON 载荷字段，也可以走追加式迁移。
3）在 ui/ 下新建 PlanBar.vue，放在 Composer 上方：宽度和输入卡同源，统一用 box-sizing:border-box；高度按视口封顶；只在 chat.running 且 runId 匹配时显示。
4）新增 chat.messages.latestOfType RPC，用于重开会话时恢复。
先红后绿的纯函数：selectLatestPlan、按回合判断是否显示。（核验：逐行读了 ConversationPlanBar，数值全部吻合。视角一写的是只挂在 AcpChat，实际 AionrsChat 也挂了，已补上。本条合并了视角一第 9 条和视角二第 4 条。）
- R4 [confirmed|ui|新:yes（v2.1.61）|DM:missing] 分区字体：全局、聊天、Markdown、代码四区各自设字族和字重，app 区新增字号：74b5d32 和 2c7bc76 在 common 层放了一张不依赖 DOM 的规格表，把区域映射到 CSS 变量和配置键（ui.fontFamily.*、ui.fontWeight.*）。
- applyFontFamilies 和 applyFontWeights 写 documentElement.style；选空值时 removeProperty，由样式表里的 var(--x, 内置栈) 回退，默认渲染和改动前逐字节一致。
- 代码区用两个间接变量：--font-mono: var(--code-font-family, 等宽栈) 和 --font-mono-weight。已有的调用点（markdown 代码块、编辑器、Shadow DOM 里的聊天内容）自动跟随。uno 的 fontFamily.mono 也改成了 var(--font-mono)。
- 字族名只转义双引号和反斜杠，并追加区域对应的通用族（sans-serif 或 monospace）兜底 CJK 字形。字重只接受 300–700 五档白名单。
- 本机字体用 window.queryLocalFonts 枚举。这个 API 必须在用户手势里调用，所以下拉框打开时才加载，结果在模块级缓存。下拉宽 w-200px，每个选项用该字体本身渲染。
- chat、markdown、code 三区的字号基线前就有，本期只新增了 app 区（12–22，默认 14），body 字号改为 var(--app-font-size, 14px)。 ⇒ 借鉴：1）theme.css 把 --f-ui、--f-mono 和聊天正文字号改成 var(--user-*, 现值) 的形式。
2）写一个纯函数 applyFontPrefs()，写 documentElement.style，空值一律 removeProperty。可以加一条守卫：默认情况下不写任何内联变量。
3）字重用白名单，字族名要转义。
4）偏好存 localStorage，理由同 SecLook 的本机偏好。
5）如果要枚举本机字体（queryLocalFonts，Chromium 内置），主进程必须装白名单 permission handler，只放行 local-fonts，不要照抄 AionUi 的全部放行（见安全条目）。不想碰权限的话，退路是给一组 Windows 常见字体做候选，再加手输字体名。
6）S 波的教训：字体一换，行高和度量就会变，改完要 xvfb 目视和 Windows 真机检查；theme-contrast、同名令牌同值等守卫也要覆盖新变量。（核验：读了 fontFamilies、fontSizes、applyFontFamilies、arco-override、useSystemFonts、FontFamilySelect 的源码。补充了一点：chat、markdown、code 三区字号是基线前就有的。本条合并了视角一第 8 条和视角二第 11 条。）
- R4 [confirmed|ui|新:no（基线勘误）|DM:missing（没有默认缩放控制、设置入口和持久化；Electron 默认菜单的缩放快捷键在无框窗口里是否生效未验证）] 默认窗口缩放 0.95，Ctrl+=/−/0 缩放并持久化（基线报告漏记，影响 S 波数值校准）：zoom.ts 的缩放参数：UI_SCALE_DEFAULT 为 0.95（注释写明是为了「开箱更紧凑」），范围 0.8–1.3，步长 0.05。
- 新窗口创建时 applyZoomToWindow 调 webContents.setZoomFactor。
- before-input-event 拦截 Ctrl/Cmd + = / − / 0，其中 0 复位到 0.95；持久化到 ui.zoomFactor，并同步到所有窗口。
- 渲染端 useFontScale 用同一个 0.95 做回退值，外观页有 ScaleControl 滑杆。
基线 74512d3 就已经是这样。2026-08-20 和 08-21 两份报告都没有提到缩放，所以报告里记录的 px 值在 AionUi 默认状态下都是按 95% 渲染的：14px 约合 13.3px，16px 约合 15.2px。 ⇒ 借鉴：两件事分开处理。
1）校准：S 波直接照搬了 AionUi 的 px 数值，DeskMinis 在 100% 缩放下的观感会比 AionUi 默认大约 5%。二选一：令牌整体乘 0.95，或者把默认缩放也设成 0.95。后者要在 Windows 125%/150% DPI 的真机上确认点击区和 Segoe UI 小字号的清晰度；拿不准就保持 1.0，只在文档里记下这个差异。
2）能力：主进程 setZoomFactor + before-input-event 处理 Ctrl+=/−/0，持久化为本机设置，不进同步；SecLook 加一个缩放步进器。全部零依赖。（核验：核实了基线和 HEAD 的 zoom.ts，也 grep 了两份报告，确实漏记。DeskMinis 没有 setApplicationMenu，所以默认菜单的 View 缩放快捷键理论上可能存在，但窗口是 frame:false，是否生效需要真机确认，状态里已注明。）
- R4 [corrected|ui|新:yes（v2.1.60）|DM:missing] 桌面侧栏可拖宽：连续调宽、吸附收起、双击复位、宽度记忆：446e83e 让侧栏复用 useResizableSplit 的 pointer + rAF 拖拽管线。这个 hook 的 px 模式新增了 collapseThreshold、collapsedWidth、collapsed、onCollapsedChange 四个可选参数，不传时退化为原来的 clamp。
- 宽度下限 200px，上限为视口的 50%（随窗口变化），默认 260。
- 拖到 200 以下进入「收起预览」态：侧栏吸到 0，松手即收起，而且不写盘，保留最后一次合法宽度。
- 双击分隔线复位到 260 并展开。宽度存在 localStorage 的 sider-width-px。
- 侧栏把手热区 8px（right:-4px，z-20），里面有一条常显的 2px 线（bg-3，opacity 0.9），hover 或拖拽时加宽到 6px 并变成品牌色 aou-6。
- 预览分栏的把手热区 20px（left:-20px，z-30），线宽固定 2px，透明度 0.3，hover 或 active 时变为 1；预览最大化时把手隐藏。
测试覆盖 199/200/201 三个边界、双击和展开后恢复宽度。 ⇒ 借鉴：写一个 Vue composable useResizable({min, max, default, collapseAt, storageKey})：
- pointerdown + setPointerCapture，用 rAF 合帧；宽度计算和阈值判断抽成 lib/ 纯函数，先红后绿。
- 拖过下限只吸附收起、不写盘；双击复位。
用在三处：NavRail（200px 到视口 50%）、WorkspacePanel（244px）、对话与预览的分栏（替换固定的 --w-chatcol）。
宽度存 localStorage，理由同 SecLook 的本机偏好。
注意三点：把手的 z-index 放在主体层（小于 50），守住 renderer-titlebar-stacking；把手要能用键盘 ←→ 调宽，满足 a11y-keyboard-reachable；TopBar 右侧 146px 的系统按钮区不能被挤压。（核验：几何数值、阈值、不写盘、双击复位都属实。纠正一处：读者说侧栏把手「hover 时显示 1px 线」，实际是常显 2px 线，hover 时加宽到 6px 并变品牌色（useResizableSplit.tsx:325）。本条合并了视角一第 6 条和视角二第 12 条。）
- R4 [corrected|dx-testing|新:yes（本期发现并清理；失效本身早于基线）|DM:missing（没有这类守卫；目前 11 个订阅事件都有发送方，暂无死通道）] 死事件通道潜伏：confirmation.add/update 早已不发，订阅方的实时路径静默失效：7d1c7b7 清理时承认：后端自 AionCore PR #27 起就不再发 confirmation.add 和 confirmation.update，但渲染端和主进程一直订阅着。
受影响的实时路径：团队侧栏徽标的实时 +1（useSiderTeamBadges）、团队待审批计数的实时 +1（useTeamPendingPermissions）、桌宠的 notification 状态切换（petEventBridge）。这些路径一直静默失效，计数实际只靠 team summary 或 confirmation.list 播种和刷新。
删掉之后，提交说明写明「这些既有缺口保持不变」。 ⇒ 借鉴：DeskMinis 的 mu6 双向绊线只管 store action 有没有调用方，不管广播事件有没有发送方。交接文档 §7 第 12 条也写过「缺失的广播会被别的广播掩盖」。
建议加一个零依赖的源码扫描守卫：按调用形态收集 renderer 里所有 rpc.on('<名>') 的事件名，再收集 minisd 里所有 rpc.broadcast('<名>')，两边取差集。只订阅没人发的，直接判红；只发没人听的，登记进 GAPS。方法仿照 mu6 的可计算不变量。成本很低，而且现在能直接全绿落地。（核验：提交说明和 diff 属实。收窄了表述：失效的是「实时 +1」路径，计数本身仍然由 summary 和 list 播种，不是完全不工作。DeskMinis 侧我逐个核对了 11 个订阅事件都有发送方，所以状态从 partial 改为 missing（缺的是守卫，当下没有死通道）。）
- R4 [confirmed|sync-storage|新:no|DM:missing] 开发态 userData 与正式版隔离，E2E 用一次性沙箱 userData：configureChromium.ts 在任何 getPath 调用之前执行两件事：
- AIONUI_E2E_TEST=1 且提供了 AIONUI_E2E_USER_DATA_DIR 时，把 userData 指向一次性目录。注释写明原因：AionCore 在共享库迁移失败时会拒绝启动。
- 未打包时 app.setName(devAppName)，并显式 setPath('userData', dev 目录)，这样 dev 与正式版数据互不污染，还能同时运行。 ⇒ 借鉴：DeskMinis 在同一台 Windows 真机上既开发又验证发布：npm run dev 会用新迁移改掉用户真实的 minis.db，再打开已安装的旧版，就成了「库比应用新」（见下条）。
1）main fork minisd 时注入 DESKMINIS_DEV=!app.isPackaged。
2）paths.ts 在 dev 下默认用 %APPDATA%\DeskMinis-dev，DESKMINIS_DATA_DIR 仍然优先。
3）keyring 的 service 名也要带 -dev 后缀，否则 dev 会读写真实密钥。
4）给 paths 写单测。零依赖。（核验：源码逐行核对，DeskMinis 的 paths.ts 也确认过。）
- R4 [confirmed|sync-storage|新:no|DM:missing] 数据库比应用新（降级）的专门识别；损坏库经用户确认后备份重建：启动失败分类器对三种库状态分别处理：
- 引擎上报阶段 database.newer_than_app 时，单独归类为 backend_database_newer_than_app：库本身完好，引导用户升级，不归入迁移失败。
- database.recoverable_corruption 走 recoverCorruptedDatabaseAfterUserConfirmation：用户确认后停引擎、备份、重建、重载窗口。
- 迁移失败另有 backend_data_migration_failed 分支。 ⇒ 借鉴：完全兼容「DB 只追加式迁移」纪律，只改 runner，不动历史迁移。
1）openDb 里 user_version > MIGRATIONS.length 时，抛带码错误 DB_NEWER_THAN_APP，main 映射成「数据由更新版本的 DeskMinis 创建，请升级」。
2）执行迁移前先 wal_checkpoint，再 copyFileSync 出 minis.db.bak-v<N>。
3）每条迁移用 try/ROLLBACK 包起来。
4）启动时 PRAGMA quick_check 结果不为 ok，就提示「备份并重建」，由用户确认后执行。
5）版本钉测试按纪律随动。
另外单独评估：设备同步时，如果对端版本更高，应该拒绝同步。（核验：分类常量和 DeskMinis 的 openDb 都读过源码。）
- R4 [confirmed|ux-flow|新:no|DM:missing（启动失败框直接显示 stack，没有分类）] 启动失败分类器：把引擎启动错误映射为可行动的原因：backendStartupFailure.ts 用 message、stderrTail/stdoutTail、边界码和阶段，把启动错误归成十几种 reason，例如：
- 架构不匹配（含 Rosetta）、安装不完整、GLIBC 缺失；
- 目录 EACCES/EPERM、目录不可用；
- 对端并发启动、慢启动仍存活、端口上报超时；
- 库比应用新、可恢复损坏、迁移失败。
backendInstallDiagnostics 附带 resources 目录列举和 runtimeKey，用来判断「安装被破坏」。这些都是纯函数，有表驱动单测。 ⇒ 借鉴：DeskMinis 教训第 2 条就是「内部标识符漏给用户看」，而启动失败框现在正直接显示 stack。
1）main 里给 minisd 的 stderr 加一个环形缓冲，保留最后 50 行。
2）写纯函数 classifyStartupFailure(err, stderrTail)，识别这些情况：NODE_MODULE_VERSION 或 .node 加载失败（安装损坏或被杀软隔离，请重装）、EBUSY 或锁（另一个实例在运行）、EACCES/EPERM（数据目录权限）、keyring 失败、DB_NEWER_THAN_APP、握手超时。
3）每种原因给中文说明、建议操作和「复制诊断」按钮，stack 只写日志。
先写分类器的表驱动红测试。（核验：AionUi 侧属实。视角三给 DeskMinis 判 partial，但 DeskMinis 只是透传 stack，没有任何分类，所以改判 missing。）
- R4 [confirmed|platform|新:no|DM:partial（有 NSIS 安装包，但没有进程树和文件锁处理）] Windows 安装与更新加固：按安装目录归属结束进程树、查文件锁、JSONL 日志、失败标记回传：resources/windows 下 8 个 nsh、support 下 3 个 ps1，共 2403 行。build-with-builder.js 在构建期对 electron-builder 的 installUtil.nsh 打字符串补丁，模板一变就抛错，不会静默失效。能力如下：
- 只结束可执行文件位于 $INSTDIR 之下的进程，沿 ParentProcessId 收集整棵进程树，并排除安装器自己。
- 用 Restart Manager（rstrtmgr.dll）查出占用文件的进程并展示给用户。
- 每个安装会话写 schemaVersion=1 的 JSONL 日志。
- 更新失败时写 installer-last-failure.json，下次启动由 updateBridge 读取并提示用户。
- 安装后用 verify-bundled-aioncore-install.ps1 复核随包的引擎。
- 失败统一给出「错误码 + 中英双语说明 + 用户操作」。
另有 smoke-installer-* 系列脚本，可以在本机复现各类失败。 ⇒ 借鉴：不要照搬 2400 行，也不要照搬 patch electron-builder 模板这种脆弱做法。DeskMinis 的风险点很具体：托盘常驻；minisd 是 utilityProcess；有长驻 PowerShell 和 MCP stdio 子进程；bridge-node.cmd 以 ELECTRON_RUN_AS_NODE 方式起 DeskMinis.exe。这些都可能让更新时文件被占用。建议只取三件：
1）autoUpdater.quitAndInstall 之前，main 先用 taskkill /PID <minisd.pid> /T /F 结束 minisd 子树，并等它退出。
2）用官方扩展点 nsis.include 写一个几十行的 .nsh，自定义 customCheckAppRunning，按 $INSTDIR 前缀结束残留的 DeskMinis.exe。
3）安装失败时写 installer-last-failure.json，下次启动提示用户。
发布前在 Windows 真机专门验一遍：托盘态下正在跑任务时触发自动更新。（核验：数了文件和行数，并抽查了进程控制、RM 调用、补丁抛错三处。）
- R4 [confirmed|product|新:no|DM:partial（配了 github provider，但仓库私有，自动更新实际不可用）] 自有通用更新源（CDN）与本机多版本更新链路验证：CdnGenericProvider 继承 electron-updater 的 GenericProvider，按 static.aionui.com/releases/<version>/<file> 的布局解析下载地址。
release-distribute.yml 在 GitHub Release 发布后，把资产镜像到 S3/CDN，拒绝同版本覆盖。
build-fast-debug-versions.ps1 配合 AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION，可以快速打出多个版本，专门用来在本机验证 vN 到 vN+1 的更新链路。 ⇒ 借鉴：DeskMinis 的自动更新卡在仓库私有上。electron-updater 自带 generic provider，不用像 AionUi 那样写子类：publish 改成 {provider: generic, url: <公开静态托管>} 即可，托管可以是一个只放 Release 资产的公开仓库的 Pages，也可以是对象存储。不需要把 token 打进应用，也不新增依赖。
验证链路照抄思路：用 -c.extraMetadata.version=0.3.1-debug 打第二个版本（CLI 参数，不改 package.json），本机用 node:http 起静态服务，autoUpdater.setFeedURL 指过去，在 Windows 真机走完 0.3.0 到 0.3.1 的全链路。仓库是否转 public 仍由用户拍板。（核验：抽查了 extends GenericProvider 和调试版本的环境变量。）
- R4 [confirmed|safety|新:no|DM:partial（退出时会 kill minisd，但不等待、不清理子进程树）] 有序退出清理（带超时）与孤儿子进程注册表：installQuitCleanup：before-quit 时 preventDefault，依次销毁托盘、停 cron 监听、停引擎、关闭宠物窗口；整体默认 10 秒超时后强制退出。依赖全部注入，可以单测。
web-host 在数据目录维护 runtime/agent-process-registry.json，记录 pid、进程组、会话和命令预览。停止时先发 SIGTERM，1 秒后仍存活的进程再 SIGKILL；Windows 下用 taskkill。回收失败只告警，不阻断退出。 ⇒ 借鉴：Windows 上 utilityProcess.kill 不会连带结束孙进程，长驻 shell 和 MCP stdio 最容易变成孤儿，还会锁住工作区文件。
1）before-quit 改成先 preventDefault，给 minisd 发一个 shutdown RPC：checkpoint WAL、结束子进程树、停 cron；10 秒超时兜底。
2）minisd 在 dataRoot/runtime/children.json 登记自己 spawn 的进程，每次启动时回收上次崩溃留下的孤儿，Windows 用 taskkill /T /F。
3）清理流程写成依赖注入的纯函数，方便 TDD。（核验：常量和流程已核对。）
- R4 [confirmed|platform|新:no|DM:missing] 渲染进程崩溃恢复策略，GPU 崩溃后自动禁用硬件加速：rendererRecovery 是纯函数策略：
- 普通崩溃按 [0, 1s, 3s] 退避重载。
- launch-failed 直接升级为整个应用 relaunch。
- relaunch 的时间戳写进 renderer-recovery.json，5 分钟内再次触发就放弃，防止死循环。
gpuRecovery：
- GPU 进程崩溃累计达到阈值 3 次后，持久化配置，下次启动前调用 app.disableHardwareAcceleration()，并在界面上提示用户。
- 距上次崩溃超过重置窗口后自动恢复硬件加速。
- 用户可以 force-on 或 force-off 覆盖自动判断。 ⇒ 借鉴：Windows 上显卡驱动导致的白屏或崩溃很常见，所用 API 全是 Electron 内置，零依赖。
1）main 里监听 webContents 的 render-process-gone 和 app 的 child-process-gone；type 为 GPU 时计数。
2）策略照抄成纯函数并注入 now，状态写进 dataRoot 下的一个小 json；要带上重置窗口和用户覆盖。
3）设置页加一个「禁用硬件加速」开关，显示当前是否已被自动禁用。
先写策略表的红测试。（核验：补充了 GPU 策略里的重置窗口和用户 force-on/off 覆盖。）
- R4 [confirmed|dx-testing|新:no（结构早于基线；新增测试是本期的）|DM:partial（有纯模块测试和源码守卫，没有组件渲染层测试）] 测试分层（node 与 jsdom 按文件名后缀分流）+ 行为测试规范 + 判定逻辑先抽成纯函数：vitest.config.ts 用 projects 按后缀分流：*.test.ts 跑 node 环境，*.dom.test.ts[x] 跑 jsdom 环境（配 @testing-library/react）。测试的 setup 里注册 NodePlatformServices，同一份 common 代码也能在 node 里跑。
testing 技能规定：
- 描述行为，不描述实现。
- 每个 describe 至少覆盖一条失败路径。
- 单个 it 里超过 3 个 expect，就是测得太多的信号。
- 自检：把被测核心逻辑删掉，测试仍能通过就要重写。
- 从风险出发，而不是从覆盖率缺口出发。
自基线以来，tests/ 下新增 49 个文件、修改 30 个。其中既有 DOM 测试（conversationRowWaitingIcon、PreviewTabsMaximize、useResizableSplitCollapse 等），也有纯函数单测（mentionHighlight、previewTabPaths、planCardMerge、conversationListSyncWaiting）。组件里的判定逻辑多被抽成了不依赖 React 的模块，注释里写明踩过的坑，例如 content-box 溢出、fill-mode 让 fixed 失效、scrollIntoView 牵动祖先滚动。
当前 tests/unit 下共 515 个测试文件，其中 273 个是 DOM 测试。 ⇒ 借鉴：DOM 测试需要新增 jsdom 这类 devDependency，违反零依赖纪律，不学。零新依赖的替代路线：
1）vitest 加一个 project，匹配 *.ssr.test.ts，挂上已有的 @vitejs/plugin-vue。用 vue 包自带的 vue/server-renderer 的 renderToString，配合已有的 pinia 预置 store，渲染 SFC 后断言 HTML。这样能在单测层抓住「权限卡从没渲染过」「历史回放显示裸工具名」这类问题；在 setup 阶段就碰 window 或 rpc 的组件需要打桩。
2）凡是本文件建议吸收的功能，判定逻辑一律先写成 lib/ 纯函数并先红，例如等待态 reducer、计划选择器、分栏 clamp 与吸附、启动失败分类。
3）把「每个 describe 至少一条失败路径」「删掉核心逻辑自检」写进 DeskMinis 纪律；同时学它的注释习惯，把踩过的坑写进注释。（核验：合并了视角一第 19 条和视角三的测试分层条。文件计数实测：tests/unit 下 515 个、DOM 测试 273 个（读者写的是 517 和 273），新增和修改 49/30 属实。也确认了 vue/server-renderer 在现有依赖里可用。）
- R4 [confirmed|dx-testing|新:no|DM:missing] CI：三平台跑单测，Windows 静默安装冒烟，asar 隔离校验：pr-checks.yml：
- unit-tests 在 ubuntu-latest、macos-14、windows-2022 三个平台跑全量 vitest；Windows 上先关 Defender 的实时监控，CI 下超时放宽到 30 秒。
- build-test 打出真实安装包后做冒烟：Windows 用 Start-Process <installer> /S 静默安装，再检查 %LOCALAPPDATA%\Programs\AionUi\AionUi.exe 等落点；macOS 用 hdiutil 挂载 dmg 后运行；Linux 用 dpkg -i 安装。
_build-reusable.yml 用 asar list 断言桌面包里没有混进 packages/web-cli。 ⇒ 借鉴：加一个 windows-latest job：npm ci（其中 postinstall 的 electron-rebuild 在 runner 上能跑），然后 npm run typecheck，再 npm test。不需要新增 npm 依赖。它不能取代 Windows 真机验证，但每次推送都能在 Windows 上全绿回归，Linux 那 52 例平台性失败的基线比对就不再是唯一的自动验证面。私有仓库的 Windows 分钟数按 2 倍计费，要不要上 CI 由用户拍板。静默安装冒烟可以先做成本机脚本并接进 RELEASE.md：Setup.exe /S，检查落点，跑一次 dry-run，最后卸载。（核验：逐段核对了 workflow。）
- R4 [confirmed|dx-testing|新:no|DM:missing] agent 指令单一来源：CLAUDE.md 只有一行 @AGENTS.md，技能按需加载，just push 门禁：CLAUDE.md 全文只有一行 @AGENTS.md。AGENTS.md 共 154 行，只放硬规则和提交格式；其中给 AI 写了专门的提示：lint 告警多不代表失败，以退出码为准。细则拆到 .claude/skills 下（architecture、testing、i18n、bump-version），按触发条件加载。
推送必须走 just push，它依次跑 lint-strict、fmt-check、typecheck、i18n-check、test，任一失败即中止，禁止直接 git push。 ⇒ 借鉴：DeskMinis 的纪律只写在另一个分支的交接文档里，在 main 上干活的 agent 读不到。
1）main 根目录加 AGENTS.md，控制在 150 行以内，写入：零依赖、TDD 先红、追加式迁移与版本钉、退出码必须来自目标命令、cwd 会重置、commit 身份与格式、UI 改动必须 xvfb 目视。再加一个 CLAUDE.md，内容只有一行 @AGENTS.md。
2）把「npm test + typecheck + Linux 基线 diff」写成 scripts/verify.mjs，用 spawnSync 取每个命令自己的退出码，从根上消除「管道吞退出码」。只加一行 scripts，零依赖。
3）同时配上下一条的防腐烂守卫。（核验：AGENTS.md 实测 154 行（读者写的是「约 140 行」），其余属实。）
- R3 [corrected|dx-testing|新:no|DM:partial（有 mu6 等守卫文化，但还没有指令文档，也就谈不上指令文档守卫）] 反面：agent 指令文档与配置层腐烂：这些问题在基线时就存在，至今没修，会把 AI 编码代理引到错误位置：
- AGENTS.md 让人去看 docs/architecture/overview.md，这个文件不存在。
- architecture 技能的决策树把新代码导向 process/agent、worker、webserver、extensions、channels，这些目录都已随迁移搬进 aioncore。现在的 process/ 下只有 backend、bridge、feedback、pet、resources、services、startup、utils。
- vitest 别名 @worker 指向不存在的目录。
- .gemini/styleguide.md 写的是 Tailwind 和 5 种语言，实际是 UnoCSS 和 13 个 locale。
- .specify/memory/constitution.md 仍按旧架构描述。
- 「每个目录不超过 10 个子项」的规则没有机械检查：process/utils 有 24 个子项，Messages/components 有 19 个。 ⇒ 借鉴：如果新增 AGENTS.md，要同时加一条守卫测试：抽出 AGENTS.md 和 .claude/skills 里所有反引号路径和 npm run 命令，断言路径存在、脚本在 package.json 里有定义。README 能力表和 RELEASE.md 里出现的 npm run 命令也纳入同一个守卫。只写规则、不配机械检查，就会重蹈 AionUi 的覆辙。（核验：逐项核实过。纠正一处：locale 实际是 13 个，读者写成 14 个。对 DeskMinis 的影响是预防性的，relevance 从 4 降到 3。）
- R3 [corrected|ux-flow|新:no|DM:missing] 输入法合成期间的按键处理：AionUi 在基线前就做了，DeskMinis 的 Composer 没有：AionUi 的 SendBox 和欢迎页共用 useCompositionInput：compositionstart/end 维护一个标志，合成期间不处理 Enter，也关掉 mention 高亮覆盖层。本期新增的预览 Ctrl+W 快捷键也显式检查了 e.isComposing 和 e.repeat。
DeskMinis 的情况：
- Composer 的 textarea 用 @keydown.enter.exact.prevent 调 onEnter，@keydown.up/down 调 onNav，@keydown.tab 调 onTab，都没有合成判断。
- 渲染端全树 grep 不到 composition 或 isComposing。
风险程度要打折扣：Vue 的按键修饰符按 event.key 匹配，而 Windows 版 Chromium 在 IME 处理中的 keydown 通常报 key='Process'、keyCode=229，所以 .enter/.up/.down/.tab 多数情况下不会触发。残余风险在个别输入法、个别 Chromium 版本的差异上，需要真机复现。 ⇒ 借鉴：1）抽一个纯函数 isImeKey(e)，判断 e.isComposing || e.keyCode === 229，先写红测试。
2）onEnter、onNav、onTab 的第一行遇到合成键直接 return。onEnter 需要改成接收事件参数。
3）不需要去掉 .prevent：Vue 3 编译出的是 withKeys(withModifiers(fn, ['exact','prevent']), ['enter'])，按键不匹配时根本不会走到 preventDefault，不会吞掉 IME 的上屏。
4）Windows 真机分别用微软拼音和搜狗验证三件事：回车上屏不发送；↑↓ 选候选词时不移动菜单；Tab 不误选斜杠项。复现不出来就只保留守卫，降为低优先级。（核验：「DeskMinis 缺合成判断」属实。纠正两点：一是读者建议「去掉 .prevent，否则会吞掉 IME 上屏」不成立，Vue 的 withKeys 先比对按键，再执行 prevent；二是补充了 Windows Chromium 在 IME 处理中报 key='Process' 的说明，风险程度下调，relevance 从 4 降到 3。）
- R3 [confirmed|ui|新:yes（v2.1.61）|DM:partial（已有复制完整路径，但路径是渲染端自己拼的；没有最大化、右键菜单和在文件夹中显示）] 预览面板：最大化切换 + tab 右键菜单（关闭未修改、复制路径、复制相对路径、在文件夹中显示）+ 面板内的 Ctrl+W：15042d9：
- PreviewContext 新增 isMaximized，只在本次会话生命周期内有效，关闭面板、清空或切换作用域都会复位。
- 最大化时聊天区隐藏但保持挂载，侧栏不动，拖拽把手隐藏。
- 操作按钮 20×20、rd-4px，图标 14px secondary 色，按钮间 gap 4px；移动端不显示。
7909246：
- 修了右键菜单「看起来没反应」：.preview-panel 入场动画用了 animation-fill-mode:forwards，末帧 transform 一直留着，给后代的 position:fixed 建立了包含块，菜单坐标相对面板计算、跑到了屏幕外。修法是 createPortal 到 body，并按视口 clamp。
- 菜单补齐：关闭（附 Ctrl+W）、关闭未修改、复制路径、复制相对路径、在文件夹中显示。
- previewTabPaths 用判别联合 filePath / url / projectRef 区分三类 tab：渲染端从来拿不到项目文件的绝对路径，projectRef 一律交给后端经 fs.copyAbsolutePath / fs.reveal 执行；url 单独成一支，保证 URL 永远不会传给 showItemInFolder。
- Ctrl+W 只在按键源自面板内部时生效，并检查 isComposing 和 repeat。
- 这两个后端路由的动作只在桌面端开放，远程 WebUI 不可用。 ⇒ 借鉴：1）最大化：Stage 聊天区用 v-show 隐藏（不用 v-if），保住 Composer 草稿和滚动位置。AppShell 现在一开预览 NavRail 就收成 compact，最大化可以沿用这个开关。
2）在文件夹中显示、用系统程序打开：主进程调 shell.showItemInFolder 或 shell.openPath，经 preload 白名单暴露。绝对路径由 minisd 按工作区围栏（workspaceOf）解析后返回，渲染端不自己拼。DeskMinis 现在的 copyPath 正是渲染端拼接，Windows 上会得到「C:\x/y/z」这种混合分隔符，可以借这次一并改成由 minisd 返回。
3）动画容器里的浮层一律用 <Teleport to="body">：凡是带 transform 或 filter 的祖先，都会让 fixed 定位失效。z 值遵守「模态 100/110」的层级守卫。
4）Ctrl+W 只在预览面板内部拦截。（核验：源码和提交说明都属实。另外发现 DeskMinis 的 PreviewPane 在渲染端拼绝对路径，正是 AionUi 刻意避开的写法，已写进 adoption。本条合并了视角一第 10 条和视角二第 10 条。）
- R3 [confirmed|multi-agent|新:yes（v2.1.60，core #914/#949/#952）|DM:missing] @@ 跨会话提及与投递：会话选择器、来源徽标、再次提及、总开关、限流急停：c83bc49 在输入框加了 @@ 通道，和 @ 文件互斥，@@ 优先。
- 选择器数据源是 GET /api/session-messages/mentionable，分页、防抖；分页请求和查询请求共用同一个序号守卫，防止旧页被追加到新结果上。副标题用 Intl.RelativeTimeFormat 显示相对时间。
- 发送时只传会话 id，名称由后端解析。
- 后端在发送方消息末尾追加 [[AION_SESSIONS]] 块，在接收方消息开头加 [[AION_SESSION_MESSAGE]] 来源块。这些常量必须和后端 constants.rs 逐字一致。UI 反解后渲染成会话 chip 和「来自会话 X」徽标，点击可以按 id 再次 @@；功能关闭时 chip 退化为纯文本。
- 总开关存在 /api/settings 的 cross_session_message_enabled（迁移 040）。关闭时输入框上方常驻一条 fill-2 底色、role=status 的横幅，带「重新开启」按钮。
- 限流：后端有 outbound 和 pair 两道门，推送 WS 事件 sessionMessage.rateLimited。前端弹不自动消失（duration:0）的通知，带「停止两端」和「关闭跨会话」两个按钮，同一对会话 60 秒内不重复弹。广播会扇出到所有连接，前端比对 user_id 过滤。
提交里记录的三个坑：@@ 引用在三个草稿入队点都被丢掉；[[AION_FILES]] 的解析会被紧随其后的 sessions 块打断；总开关在 4 个组件里各有一份 useState，彼此不一致。这些都是 PR 内评审时发现并修掉的。 ⇒ 借鉴：这是比 Team 轻得多的多 agent 协作形态，可以作为三档「多窗口对话墙」的前置，现在不建议立项。先吸收三条原则：
1）结构化元数据落库成列，比如 origin_session_id、mention_refs_json，不要学它往正文里塞 [[标记]] 再反解。
2）自动化失控时，急停要出现在事发处，比如通知里直接给「停止」按钮。
3）多个组件都要读的全局开关，必须来自同一份 Pinia 状态。
将来要做时：minisd 加 session_send 工具（目标会话忙就排队）；Composer 仿 lib/composer/at-files 加 @@ 通道；按「会话对 + 时间窗」限流并广播；投递来的消息作为普通消息参与同步。（核验：常量、端点、冷却时间和横幅都核实过。补充了一点：那三个坑是 PR 内评审时抓到的，不是发布后才暴露的。两个视角给的 relevance 分别是 2 和 4，这里取 3。本条合并了视角一第 16 条和视角二第 3 条。）
- R3 [confirmed|ui|新:yes（v2.1.60、v2.1.61）|DM:partial（Tab 接受和补全加空格已有；键盘选中项不跟着滚动；菜单是固定像素封顶）] Mention、斜杠菜单统一外壳：高度按视口封顶、键盘导航精确滚动、触底分页、着色只给真实引用；斜杠支持 Tab 接受并按实时值判定：c83bc49 抽出 MentionMenuShell，/、@、@@ 三个菜单共用：
- 外观：rounded-14px，1px border-2，阴影 0 8px 24px rgba(0,0,0,.12)，背景 color-mix(bg-1 78%)，backdrop blur(14px) saturate(1.1)。头部 px12/py8，标题 13px semibold。
- 滚动区：p-6px，最大高度 min(34vh,260px)。
- ↑↓ 导航时按选中项超出的像素精确调整 scrollTop，不用 scrollIntoView，因为后者会连带滚动所有祖先，把背后的消息列表拖走。
- 距底 48px 以内触发 onReachEnd 分页。
- @ 或 @@ 补全后自动加一个空格。
mentionHighlight 定下规则「着色 ⇔ 真的附上了引用」。起因是手打的 @config.json 曾经和从下拉里选中的一样被着色，用户以为已经附上，实际 agent 什么都没收到。
573927d 让 Enter、Tab、Shift+Tab 都能接受斜杠命令，Shift+Enter 仍是换行。接受键从事件目标的实时 value 重新计算菜单状态（readInputValue），修掉了 React 受控输入晚一帧、快速输入后回车把「/cmd」原文发出去的竞态。 ⇒ 借鉴：DeskMinis 的技能多于大约 8 个时，键盘选中项会滚出可视区。
1）在 nextTick 里对 .menu 容器按溢出量精确调整 scrollTop，不要用 scrollIntoView，否则会把 StageChat 的滚动容器一起带着滚。
2）高度改成 min(34vh, 280px)。
3）斜杠和 @ 两个菜单可以抽一个 MenuShell.vue 共用。
4）Vue 的 v-model 在 input 事件上同步更新，基本不存在 React 那种滞后竞态，但可以加一条回归用例：快速输入「/技能名」后立即回车，不应发出原文。
5）@ 以后如果改成 chip 附件，着色必须只跟真实附件走。
只学形态和尺寸，不学玻璃材质（DeskMinis 有 renderer-shell-form 守卫）。（核验：数值逐一核对过，序号守卫在 useSessionMentionSearch 里。本条合并了视角一第 12 条、视角一第 18 条（斜杠 Tab）和视角二第 20 条。）
- R3 [confirmed|providers|新:yes（v2.1.61）|DM:partial（T5b/Z2 确立了「默认不靠猜」和 describeBinding 的单一归一化，但显示层仍有 providers[0] 回落，ModelBar 与胶囊的矛盾未解决）] 「未选模型」保持为 null，不再被静默选成某个具体模型：ded1f7d 删掉了两层替换逻辑：
- useGuidAssistantSelection 用 CLI agent 运行时目录里的 current_model_id 或 available_models[0] 给选择器播种；
- useGuidSend 在用户没选时用缓存的 current_model_id 顶替。
current_model_id 其实是这个 agent 上一个会话写回的值；available_models[0] 对 claude 来说是会钉死账户默认的 Default 行。两者都会让 AionUi 实际跑的模型和终端里的 claude 不一致，选择器也自相矛盾。
现在 null 一路保留到发送层，发送时整个省略 model 字段，由 agent 按用户自己的配置解析。显式选择 default 仍然会传过去，因为那是真实存在的一行选项。有 API provider 的助手不受影响，aionrs 仍然使用 current_model.use_model。 ⇒ 借鉴：1）会话没有绑定时，胶囊的可见 label 显示「默认 · X」，不要只显示 X。
2）ModelBar 标题明确写「默认模型」，从文案上化解和胶囊并排时的矛盾。
3）describeBinding 在后端默认失效时回落到 providers[0]，这一点要明示为「默认已失效，临时用 X」，否则就是一个隐蔽的猜测。
4）任何入口都不要把推测出来的默认值写回会话绑定。（核验：AionUi 侧属实。视角二判 DeskMinis 为 has，但 binding.ts:65 仍有 providers[0] 回落，交接文档也把 ModelBar 矛盾列为未修，所以统一判 partial。本条合并了视角一第 13 条和视角二第 13 条。）
- R3 [corrected|ui|新:部分（设计 token 零变更是本期事实；玻璃是基线漏记；MentionMenuShell 是本期抽出的）|DM:has（S 波的色值、圆角、阴影仍对得上 AionUi 最新版）] 设计体系零变更；勘误：浮层菜单基线就用了轻玻璃：74512d3 到 HEAD 之间：
- default-color-scheme.css 和 builtinThemes.ts 没有 diff。
- 样式层只改了 arco-override.css（--font-mono、--font-mono-weight、--app-font-*，body 字号改为 var(--app-font-size, 14px)）、markdown.css（区域字体变量，th 改为 text-align:start）和 uno.config.ts（fontFamily.mono 改为 var(--font-mono)）。
勘误：2026-08-20 报告第 60 行写 AionUi「全程无玻璃拟态」，不准确。基线里 AtFileMenu、SlashCommandMenu、SendBox 浮层都用了 color-mix(bg-1 78%) + blur(14px) saturate(1.05~1.1)，ConversationSearchPopover 用了 blur(10px)，BtwOverlay 和 LoginPage 用了 blur(18px)。基线里带 backdrop 的文件有 11 个（HEAD 为 10 个，其中几处是 none 覆盖）。chat-layout-header--glass 虽有 blur(6px)，但同时有 !bg-1 实底，实际看不出玻璃效果。本期只是把菜单玻璃收进了 MentionMenuShell。 ⇒ 借鉴：S 波的色板、圆角、阴影、边框数值都不用返工。DeskMinis 的「壳层是平的」是 I 波的用户裁定，renderer-shell-form 守卫继续保持：浮层用实底 + 1px 边 + --sh-pop，只学形态和尺寸，不学材质。唯一要做的是修订 2026-08-20 报告第 29 行和第 60 行的表述，免得后人误以为 AionUi 完全不用玻璃，或误以为「反玻璃」是在照抄 AionUi。（核验：token 零变更属实。玻璃这部分补全了证据：基线里是 11 个文件，读者写「约 10 个」；聊天头部的 glass 类实际被实底覆盖。新旧属性标成「部分」。）
- R3 [confirmed|safety|新:yes（v2.1.61）|DM:missing（没有装任何权限 handler，处在 Electron 对多数权限自动放行的默认状态）] 反例：为了用一个字体 API，把所有 Electron 权限请求一律放行：74b5d32 在 handleAppReady 里给 defaultSession 装了 setPermissionRequestHandler((_wc, _perm, cb) => cb(true))。注释的理由是：Electron 37 把 local-fonts 报告成 unknown，没装 handler 时会拒绝；其他权限也一并放行，是为了保持 Electron 默认全放行的行为。
结果是所有 webContents 的所有权限请求（摄像头、麦克风、地理位置、通知、剪贴板读取等）一律放行，等于把不安全的默认值固化成了显式代码。这也是本期主进程唯一的实质改动：index.ts 加了 13 行。 ⇒ 借鉴：DeskMinis 的预览区会渲染 agent 产出的 HTML 和 Office 内容，风险面不小。建议借这次机会装白名单：setPermissionRequestHandler 只放行确实用到的权限（剪贴板写入，以后可能加 local-fonts 和 notifications），其余全部拒绝；同时装 setPermissionCheckHandler 保持一致。先写一条主进程源码守卫把白名单钉住。（核验：diff 核实。视角三写「主进程这一层零变化」，只看了 process/ 目录，漏掉了 index.ts 的这处改动，已在总述里更正。）
- R3 [confirmed|platform|新:yes（v2.2.1）|DM:missing（rpc.ts 没有重连；remote 模式的 token 没有续期）] WebUI 会话韧性：401 单飞静默续期 + WS 重连风暴修复：只作用于 WebUI 浏览器模式：sessionRefresh 在桌面本地模式下直接返回 false。
4f7da7e：httpBridge 遇到 401 时，调 refreshSession()，由模块级 inFlight 合并成一次 POST /api/auth/refresh，成功就重放原请求。WS 收到 1008 时同样先刷新，失败才跳登录页。core #926 做了双 token 单飞刷新，#918 把 JWT TTL 延长到 30 天。
16589d8（#4156）的重连规则：
- 退避 500ms 到 8s，连接稳定 STABLE_CONNECTION_MS=5000 以上才重置。因为「先接受 upgrade 再立刻断开」也会触发 open，只在 open 时复位会把退避钉死在最小值。
- 已有排队的重试时，emit 不再立即重拨。
- 认证类终止后 shouldReconnect=false，emit 也不能把连接复活。
- 登录时手动重连要先清掉排队的计时器。
配了 247 行 DOM 测试。 ⇒ 借鉴：1）rpc.ts 的重连照抄这套规则（和「引擎崩溃」条合起来做）：退避 500ms 到 8s；连接稳定超过 5 秒才重置；call 不得绕过退避直接重拨；认证失败进入终止态；断线期间待发请求快速失败，并给出人话提示。
2）remote 模式的 PASETO 有效期只有 10 分钟，将来接远端客户端时，要在到期前单飞续期，避免多个请求同时撞上过期、各自重连。
都是纯 TS，零依赖。（核验：补充了作用范围：只对 WebUI 生效。视角二判 DeskMinis 为 partial，但 rpc.ts 没有任何重连，改判 missing。本条合并了视角二第 14 条和视角三第 2 条里 WS 重连的部分。）
- R3 [corrected|extensibility|新:部分（core CLI 是新的；定时任务的「对话创建」是基线前的）|DM:missing] agent 可驱动的应用能力：aioncore conversation create 与 CLI 能力索引：本期新增的部分只在 core 侧，本仓只能从 CHANGELOG 看到：
- v0.2.2 #977 新增 `aioncore conversation create`，agent 可以自己创建会话。
- v0.1.72 #929 把未登记的顶层子命令注册进 CLI capability index。
定时任务页的「对话创建」分体按钮（跳首页、用 prefillPrompt 预填提示词，由助手调用 cron 能力建任务）和对应的 PRD，在基线时就已经存在，本期没有改动。 ⇒ 借鉴：在 tools/registry 加原生工具 cron_create、cron_list、session_create，比让 agent 绕 shell 调 CLI 更干净，也能复用 PermCard。
安全上：agent 创建常驻的定时任务，等于一种持久化机制，容易被提示注入利用。权限档必须固定为「每次确认」，确认卡要逐字展示调度表达式、提示词和绑定的助手，不截断。StageCron 可以加一个「对话创建」入口，在欢迎页预填提示词。（核验：读者把定时任务页的「对话创建」算作自基线以来的新增，核实 ScheduledTasksPage 零 diff、PRD 基线已有，所以改为「部分」。core 能力只能凭 CHANGELOG 判断。relevance 从 4 降到 3。）
- R3 [confirmed|ux-flow|新:no|DM:missing] 发送草稿箱：AI 忙时排队，可立即发送、编辑、删除、拖拽排序，支持自动或手动模式：AI 回复期间发出的消息进入输入框上方的 CommandQueuePanel（草稿箱）。
- 每条草稿常驻三个操作：立即发送（sendNow，打断当前回复插队）、编辑、删除。
- 可以拖拽排序。
- 总控可以在 auto 和 manual 两种模式间切换，默认 manual。
这些在基线时就已存在，基线报告第 38 行也以「忙碌排队草稿」列为 Ⅲ 档。自基线以来唯一的变化是：@@ 引用现在会随草稿一起入队。此前三个入队点都丢掉了 sessions 字段，是 PR 内评审时修掉的。 ⇒ 借鉴：只改渲染层：用 Pinia 给每个会话维护一个不落库的队列，显示在 Composer 上方；回合结束时按模式出队；「立即发送」等于先 stop 再发送。minisd「每个会话同一时刻只跑一个任务」的约束不用动。
要吸取 AionUi 的教训：附件、@ 路径、会话级 MCP 禁用等所有发送字段，都要完整穿过入队和出队，并用守卫断言字段集合一致。还要和 X 波的重入闸、chat.draft 草稿寄存对齐，避免三套草稿语义打架。（核验：实现和 PRD 都核实过。补充：基线报告已经提过这一项，不算新发现。）
- R3 [confirmed|product|新:no|DM:missing] 定时任务「转成技能」建议卡：会话里可能出现 skill_suggest 类型的产出物卡片，内容包括建议的技能名、描述和可展开的 SKILL 内容预览。用户一键调用 cron.saveSkill 把它固化为技能；cron.hasSkill 用来避免重复提示。这一项基线前就有，基线报告没有覆盖。 ⇒ 借鉴：定时任务成功跑完 N 次后，在结果回看页显示「转成技能」：由模型按当前流程起草 SKILL.md，预览后写进 skills 目录，默认不启用。这是纯建议，绝不自动安装，符合「技能来源必须可见」的纪律。（核验：确认文件在基线已存在，基线报告里 grep 不到这一项。）
- R3 [confirmed|safety|新:no|DM:partial] 打包资源契约清单，在三处复核（准备时、afterPack、安装后）：shared-scripts/verify-bundled-aioncore-resources.js 定义了 bundle manifest 和 managed-resources 契约：
- schemaVersion=2，不是 2 就报 unsupported。
- 路径字段禁止反斜杠、绝对路径、. 和 ..。
同一个校验在三处执行：prepare-aioncore 准备完成后；electron-builder 的 afterPack 钩子里；NSIS 安装后由 verify-bundled-aioncore-install.ps1 在目标机上复核。 ⇒ 借鉴：1）把 e2e:m5 里的随包断言挪进 electron-builder 的 afterPack 钩子：bridge-cli.mjs、bridge-node.cmd，以及位于 app.asar.unpacked 下的 better-sqlite3 和 keyring 的 .node 文件。写成一个纯 node 脚本，每次 npm run dist 都会执行，缺文件就失败。
2）再生成一份随包 manifest，记录版本和关键文件的 sha256，启动时由 minisd 自检。这样 Windows Defender 隔离了 .node 文件时，能报「安装被安全软件破坏，请重装」，而不是抛一串加载堆栈。（核验：抽查了路径规则、schema 检查和 afterPack 的调用。）
- R3 [corrected|dx-testing|新:no（plan-bar.e2e.ts 和 emitPlan 是新增的）|DM:partial] E2E 组织：打包产物单例运行、渲染层事件注入器、需求 → 用例编号 → 实现的映射文档：Playwright 以 workers=1、全程单例 Electron 的方式运行，支持 dev 和 packaged 两种模式。
AcpE2EStreamInjector 挂在 AcpChat 里，常驻生产包，只靠 sessionStorage 的键开启；本期新增了 emitPlan 和 endPlanTurn。
tests/e2e/docs/<feature>/ 下有 requirements、test-cases（按 P0/P1/P2 编号）、implementation-mapping 等文档。
缺点：
- e2e 只能 workflow_dispatch 手动触发，不拦 PR。
- 很多用例在前置条件不满足时 test.skip。plan-bar.e2e.ts 的注释特意说明，不加 requireAvailable 是因为那会「静默跳过整个守卫」，但它仍会在没有 Codex 助手时 skip。
- tests/e2e 下有 121 个 .e2e.ts 文件（是文件数，不是用例数）。 ⇒ 借鉴：DeskMinis 的 FakeProvider 放在 minisd 层（DESKMINIS_FAKE_PROVIDER），经过真实的 RPC、存储和权限链路，比 AionUi 在渲染层注入更真实，应该保持。可以借的有三点：
1）给 27 个 driver 剧本建用例编号和实现映射表；候选池里的「偶发」条目先补一个 TC 再立项。
2）前置条件不满足时，driver 要 FAIL 并写明原因，不能静默跳过。
3）注入器常驻生产包只靠 sessionStorage 门控，正好对应 DeskMinis 候选池里的「fixture 环境变量生产门控」：测试开关只能在未打包或显式设置 env 时生效。（核验：纠正两处：「121 个 e2e 用例」实为 121 个文件；plan-bar 那段注释的原意是解释为什么不加 requireAvailable，并不是承认自己会静默跳过。）
- R3 [confirmed|architecture|新:no|DM:partial] 壳与引擎两仓锁步发布，契约手写类型，没有协议版本握手：package.json 的 aioncoreVersion 钉住打包用的引擎版本。resolveAioncoreVersion 的解析顺序是 env、pin，最后回落 latest。
前端 HTTP 契约由手写的 httpGet<Resp, Params> 包装构成，没有 codegen；ipcBridge.ts 本期增加了 193 行新端点。dev 模式直接从 PATH 取任意版本的 aioncore，壳与引擎之间没有 API 版本握手。
基线之后锁步 bump 了 5 次（b1dcdb8、1afdf95、18022a4、dc47f4a、6744099）。 ⇒ 借鉴：minisd 和界面同仓同构建，天然不存在版本漂移，这是 DeskMinis 的结构优势，不要为了「像 aioncore」把 minisd 拆出去。真正需要补的是跨版本的对端：设备同步对端、remote 和 CLI 客户端。握手时带 protocolVersion 和 appVersion，不兼容时明确拒绝并提示升级，并用 ipc-contract 测试钉住这个协议版本号。（核验：核实了 pin、latest 回落、5 次 bump；DeskMinis 的 sync wire 也 grep 过。）
- R3 [confirmed|platform|新:no|DM:missing] Windows PATH 从注册表补齐：hydrateWindowsProcessPath 在启动时读取 HKCU\Environment 和 HKLM 下 Session Manager\Environment 的 Path，展开 %VAR%，再解析 PowerShell profile 里追加 PATH 的语句，去重后合并到 process.env.PATH。注册表的输出作为参数注入，所以是可测的纯函数。 ⇒ 借鉴：DeskMinis 的 shell_execute 和终端共用一个长驻 PowerShell。用户在应用运行期间装了 node、python 或 git，agent 仍然找不到，只能重启应用。
建议：minisd 在创建长驻 shell 之前，以及工具报「命令未找到」后重试之前，用 execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path']) 和 HKLM 的同名键重建 PATH，再和进程已有的项合并去重。合并逻辑写成纯函数，可以 TDD。零依赖。（核验：核对了常量和 profile 解析。）
- R3 [corrected|architecture|新:no|DM:partial（minisd 本来就是独立进程，有 DESKMINIS_STANDALONE，但启动链路还和 main 耦合在一起）] 包结构：不依赖 Electron 的 host 层、共用构建脚本、web-cli 单文件发行：各包分工如下：
- @aionui/web-host 不依赖 Electron，包含 BackendLifecycleManager：选端口时避开浏览器禁用端口；stdout 先出 AIONCORE_LISTENING <port>，再出不带参数的 AIONCORE_READY 作为权威就绪信号；有健康检查诊断和崩溃重启。另外负责静态服务和反代。desktop 和 web-cli 都复用它。
- @aionui/shared-scripts 同时服务 electron-builder 打包和 pack-web-cli。
- web-cli 用 bun build --compile 产出单文件，支持 start、resetpass 命令，首次启动自动生成管理员密码，发行 tarball 附带 sha256。
- mobile 是独立的 Expo 项目，不在 workspace 里。
以上各包自基线以来都没有提交。 ⇒ 借鉴：DeskMinis 是单包，不需要改成 monorepo；bun --compile 也不符合 npm 和零依赖纪律。可以借的是分层思路：把「fork minisd、按整行扫描握手、超时、崩溃重启、优雅停止」从 main/index.ts 抽成不依赖 Electron 的 launcher 模块，由 main 注入 utilityProcess.fork，CLI 和 remote 注入 child_process.spawn。这样启动链路能脱离 Electron 单测，也给 DESKMINIS_STANDALONE 铺路。无头的 web-cli 形态会带来大块安全面，暂不投入。（核验：纠正一处：就绪标记是 AIONCORE_LISTENING 和 AIONCORE_READY，读者写成了 AIONUI_*（见 backend-launcher.ts:250-253）。本条合并了视角二第 19 条（web-cli）和视角三的包结构条。）
- R3 [confirmed|architecture|新:no（基线勘误）|DM:unknown] 基线勘误：AionCore 可以按本仓文档公开克隆构建，不是闭源二进制：基线报告第 16 行和第 82 行把 AionCore 定为「闭源外部仓库」「闭源二进制」。本仓自己的证据指向相反方向：
- docs/contributing/development.md 让贡献者 git clone https://github.com/iOfficeAI/AionCore.git，再 cargo install。
- tests/e2e/README.md 要求在 ../AionCore 里 cargo install --path crates/aionui-app。
- readme.md 第 109 行和第 286 行直接链接 AionCore/blob/main 下的 assistants.json 和 builtin-skills 目录。
- 已删除的 Sentry 台账引用了 AionCore 的 PR 号和 crates 源码位置。
AionCore 自身的许可证本仓内没有证据，本次也没有联网核实。 ⇒ 借鉴：参考 cron 调度、session-message 投递、sidebar 读模型、plan 快照、ACP 探测自适应超时这些引擎侧设计时，可以直接读 AionCore 源码，不必只从 UI 形态倒推。前提是先核实 LICENSE，并且沿用「只借模式、不复制代码」的红线。建议后续派一个视角专门读 AionCore。（核验：四处本仓证据都打开核对过；公开与否、许可证都未联网核实，结论限定为「本仓证据指向可克隆构建」。）
- R3 [confirmed|platform|新:no|DM:partial] 结构化诊断：启动诊断字段、反馈日志包（本地 gzip）：BackendStartupError.details 带着 stage、stderrTail、健康检查时序、TCP 探针结果、目录列举、包架构与设备架构。
反馈功能用 node:zlib 把最近 3 天（DEFAULT_LOG_DAYS=3）的 .log、.aioncore.log、.aionrs.log 打成 gzip 附件。sentry.ts 的 beforeSend 会做过滤。
基线里还有一批 Sentry 案例台账，已在 7d1c7b7 删除。其中 ELECTRON-3PN 记录：pi CLI 约 1.93 万个文件，在 Windows 上冷启动执行 --version 要 5.6–6.8 秒，固定 5 秒超时会把它误判为未安装。当时的修复状态是 candidate-fixed，对应 AionCore PR #678。 ⇒ 借鉴：DeskMinis 承诺「不经任何云端」，不接 Sentry。可以做一个本地「导出诊断包」：最近 3 天日志、应用/Electron/OS 版本、dry-run 结果、脱敏后的 providers（去掉 key 和 baseUrl 里的凭据），用 node:zlib 打包，保存到用户选择的位置。入口放在启动失败框和「设置 → 关于」里。
pi 冷启动超过 5 秒这个数据点提醒：MCP stdio 的启动超时（当前 2 秒）和任何 CLI 探测都不宜用固定的短超时。（核验：核对了日志天数和 gzip 实现；台账状态补充为 candidate-fixed。）
- R3 [confirmed|safety|新:no|DM:partial] 反面：外部二进制下载不校验 checksum，找不到 pin 时回退 latest：prepare-aioncore 在 Windows 上用 Invoke-WebRequest、其他平台用 curl 或 wget 下载 Release 资产，解压后只检查二进制是否存在，不校验哈希。而 bump-version 技能明确列出 AionCore release 里有 aioncore-checksums.txt，校验文件已经发布、却没被用上。
resolveAioncoreVersion 找不到 pin 时回退到 latest，构建不可复现。 ⇒ 借鉴：扩展市场一键安装技能和 MCP 时，如果上游提供哈希或完整性字段，应先比对再落盘；没有就在确认卡上明示「未校验」。将来引入任何构建期外部下载，都必须钉版本、校验 checksum，禁止 latest 回退。（核验：grep 确认没有任何校验逻辑。）
- R2 [corrected|platform|新:no|DM:partial（有 remote 配对和 RPC，没有客户端）] 移动端伴侣 App（Expo/React Native）：扫码连 WebUI，在手机上审批、聊天、看文件：mobile/ 是 Expo ~55.0.4、React Native 0.83.2 的独立应用。
- 扫描 WebUI 生成的二维码（/qr-login?token=），用明文 http:// POST /api/auth/qr-login 换取 JWT。
- 再建 WebSocket：token 放在 Sec-WebSocket-Protocol 里，有心跳和指数退避重连。
- 功能包括会话列表、聊天、确认卡（手机上批准或拒绝）、文件预览等。
自基线以来没有提交。 ⇒ 借鉴：不要照搬 Expo/RN：依赖体量巨大，还是另一套工具链。DeskMinis 已有 remote 配对（X25519 + PASETO），缺的只是客户端。手机端最有价值的场景是「在手机上批准权限卡、查看定时任务结果」，和等待态通知是同一个需求。维持远期 Ⅳ 档；立项前要单独做安全评审，AionUi 用明文 http 扫码换 token 的做法不要学。（核验：纠正一处：读者说「基线报告也没覆盖」，但基线第 45 行已经把 WebUI 加手机扫码列为 Ⅳ 档，只是没展开 Expo 应用。补充了 qr-login 走明文 http 的安全细节。relevance 从 3 降到 2。）
- R2 [corrected|architecture|新:yes（v2.1.60，core #911）|DM:partial] 侧栏读模型后端化（/api/sidebar），删除项目的 dry_run 具名预览目前只在契约层：新的 /api/sidebar 一次返回整个左栏：分为置顶、项目、聊天三类，每组按窗口截取，用 keyset 游标分页。types 里定义了 RemoveProjectResult.items，供 dry_run 预览时列出将被删除的具名条目（名称、是否置顶、类型）。
但本版有两点要注意：
- renderer 里没有任何调用方传 dry_run，所以「确认框列出名单」在 UI 上还没实现。
- sidebar.get 唯一的调用方是已归档页；主侧栏按 18e4fdd 的说明仍走旧读模型。 ⇒ 借鉴：会话量大时，可以把分组和分页下沉到 minisd，用 keyset 游标。更值得先借的是 dry_run 具名预览这个思路：将来做清空归档、批量删除这类破坏性批量操作时，确认卡列出具体会删哪些条目。不要学新旧两套读模型并存。（核验：纠正一处：读者写「确认框列出名单而不只是数量」，像是已上线的 UI；实际 renderer 没有任何地方传 dry_run，只停在契约和类型层。）
- R2 [corrected|tools|新:yes（v2.1.60、v2.2.2），但展开集持久化和文件图标是基线前的|DM:partial] Explorer：按当前 tab 刷新、全部折叠、remount 修复失效监听、worktree 重新发现：9914299 把刷新入口收成顶栏一个按钮，按当前 tab 生效：
- Files tab：重新拉取项目，并经 fs/remount 重建每个 root 的监听。
- Changes tab：rediscoverRepos 重新发现仓库（能看到会话中途新建的 worktree，对应 core #959），再重拉状态。
刷新返回 Promise，按钮的忙态跟随真实完成，进行中忽略重复点击。
另外新增 VS Code 风格的「全部折叠」。右缘 tooltip 一律设成 position='br' 向左展开，避免短中文标签在窗口边缘折行（「刷新变更」被挤成「刷新变/更」）。
以下是基线前就有的：展开集按项目存 localStorage、Catppuccin 两套文件图标、git Changes 面板。 ⇒ 借鉴：「全部折叠」是个小改动，可以直接补；刷新按钮的忙态绑定真实 Promise。tooltip 向左展开这一点可以直接用在 DeskMinis 的 244px 右栏上，那里吃过「浮条 CJK 竖排」的亏。改动 tab 的真实性更值得做：collectArtifacts 只统计工具调用里的写操作，shell 命令改的文件统计不到；可以在 minisd 里对 git status --porcelain 做一层只读视图（外调 git，零依赖）来兜底。文件类型图标如果取自 Catppuccin（MIT），要在 THIRD-PARTY-NOTICES 里署名。（核验：纠正一处：视角一标题把「展开集持久化」算作本期新增，但基线的 explorerStore 已有 localStorage 持久化。两个视角给的 relevance 是 3 和 2，这里取 2。本条合并了视角一第 11 条和视角二第 17 条。）
- R2 [confirmed|context|新:yes（core v0.1.71–v0.2.1）|DM:has] 技能改由应用自有视图投递；助手预设改为追加，不再替换：以下变化都在 core 侧，只能凭 CHANGELOG 判断：
- v0.2.1 的 BREAKING 变更（#938）：技能不再落进用户工作区，改由 AionUi 自有视图投递。
- v0.1.72（#930）：按注入预算精简自动注入的技能描述。
- v0.1.71：给 claude 的助手预设改为追加，不再替换原有系统提示词（#900）；给 codex 的预设改走 developerInstructions，不再走 baseInstructions（#897）。 ⇒ 借鉴：DeskMinis 已经是这样做的：技能放在 %APPDATA%/skills，注入上限是 20 条完整描述、每条 200 字，助手规则以 <assistant_preset> 块追加。AionUi 的变化反向印证了这条路线；继续坚持不往用户工作区写任何应用文件。（核验：CHANGELOG 和 DeskMinis 源码常量都核对过。）
- R2 [confirmed|dx-testing|新:no|DM:has（DeskMinis 的守卫纪律更严）] 反面：几道质量门实际上不拦任何东西：逐项看：
- AGENTS.md 第 68 行宣称覆盖率目标不低于 80%，vitest 的 thresholds 却全部为 0。
- test:contract 是 `vitest run tests/contract --passWithNoTests`，而 tests/contract 目录不存在；justfile 的 ext-test 指向同样不存在的 tests/extensions。
- _build-reusable.yml 里 Windows 构建失败只写一条 notice，不阻断流程；workflow 里也看不到 Windows 代码签名配置。
- e2e 只能手动触发。 ⇒ 借鉴：带 --passWithNoTests、阈值为 0、「失败不阻断」的门，一律视同没有设门。DeskMinis 如果上 CI，Windows job 必须硬失败；任何新脚本都不要用 --passWithNoTests 掩盖路径写错。（核验：逐项核实过。）
- R2 [confirmed|architecture|新:no|DM:has（m5-packaging 的版本钉测试已经在防同类漂移）] 反面：构建入口漂移（Dockerfile、homebrew、scripts README、脚本引用）：几处构建入口已经对不上：
- Dockerfile 执行 bun run build:renderer:web，package.json 里没有这个 script，scripts/build-server.mjs 也不存在。
- homebrew/aionui.rb.example 说由 .github/workflows/bump-homebrew.yml 自动更新，该 workflow 不存在。
- scripts/README.md 还在描述 Electron Forge，说 build-with-builder.js 只有 116 行，实际是 925 行。
- package.json 的 debug:mcp 指向不存在的 scripts/debug-mcp.ts。
- web-cli 的 package.json 版本停在 1.9.26。 ⇒ 借鉴：可以再加一条轻量守卫：package.json 里每个 scripts 条目引用的 scripts/*.mjs 文件都必须存在，RELEASE.md 里出现的 npm run 命令也必须在 scripts 中有定义。零依赖，一个测试文件就够。（核验：逐项核实过。）
- R1 [confirmed|ui|新:yes（v2.1.60、v2.1.61）|DM:missing] 图表：聊天内 Mermaid 平移缩放与全屏查看；新增 WaveDrom（新依赖）；表头对齐修正：f858b61 让聊天里的 Mermaid 图也能平移缩放。DiagramZoomOverlay 是一个通用的全屏查看器，通过 portal 渲染：
- 缩放范围 0.1–10 倍，滚轮每次 1.1 倍，按钮每次 1.2 倍。
- 打开时按 contain 方式适配，内边距 80px；卡片上限 90vw × 85vh。
- 可拖拽平移；ESC、点遮罩或关闭按钮都能退出。
8d1ff64 新增 WavedromBlock，为此在 dependencies 里引入 wavedrom ^3.6.2 和 json5 ^2.2.3，锁文件还带进 bit-field、logidrom、onml、tspan、fs-extra 等传递依赖。
8c671bb 把 th 改为 text-align:start；GFM 的对齐标记由 remark-gfm 以内联样式输出，仍然优先。 ⇒ 借鉴：图表库都是新依赖，在零依赖红线之外，不做。可以复用的只有 lightbox 交互：给 PreviewPane 里的图片和 SVG、用户消息的图片附件加上点击全屏查看，用 CSS transform 的 scale 和 translate，配合 wheel 和 pointer 拖拽实现，大约一百行，零依赖。parse.ts 的 :---: 列对齐是低优先级，可以以后补。（核验：常量、依赖和锁文件 diff 都核实过。本条合并了视角一第 17 条和视角二第 21 条。）

未覆盖：
- AionCore 源码本身（cron 调度、session-message 投递与限流、/api/sidebar 读模型、plan 快照持久化、ACP 探测自适应超时、conversation create CLI）。本次按规则不联网，AionCore 的许可证和是否公开也未核实。
- 会话分叉 common/chat/forkConversation.ts（按 agent 声明的 fork capability 决定是否显示入口）：基线前就有，两份基线报告和三个读者都没覆盖，对应 DeskMinis 候选池里的「会话分叉」。
- Team 模式、IM 桥（channels）设置 UI、桌宠（pet）模块：这次只顺带看了死事件清理，没有深读。
- CommandQueuePanel（草稿箱）的具体 UI 数值与交互，以及 docs/prds 的其余条目（只抽读了 send-drafts 和 cron-entry-optimization）。
- Preview 面板其他 tab 类型（Office、diff、URL 浏览）的实现，以及 ScaleControl 和外观设置页的其余控件。
- mobile/ 的完整安全面（qr-login 走明文 http，token 在 URL 里），以及 web-host 的鉴权和反代实现。
- renderer 其余没有改动的大组件（SendBox 约 1900 行、MessageText）内部结构，以及 GroupedHistory 主侧栏旧读模型的分类口径。
- 跨项目：用户要求同时参考 deepseek harness、zcode、pi，本次核验只覆盖 AionUi。可交叉印证的点是已删除的 ELECTRON-3PN 台账：pi CLI 约 1.93 万个文件，Windows 冷启动 --version 要 5.6–6.8 秒，可以交给 pi 视角核对。
- DeskMinis 侧需要 Windows 真机验证的两处：Electron 默认菜单的缩放快捷键在 frame:false 窗口下是否生效且会不会持久化；IME（微软拼音、搜狗）下 Composer 的 Enter、↑↓、Tab 是否真的会误触发。