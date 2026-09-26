# DSH 桌面端 × DeskMinis：进程架构与生命周期对照笔记（2026-09-26）

- DSH：/home/user/refs/deepseek-harness，HEAD 46a7f68b0（0.1.7-rc.1）。主要文件：apps/desktop/src/main.ts（1129 行）、host-process.ts、backend-controller.ts、fatal-recovery.ts、crash-report.ts、update-*.ts；apps/desktop-host/src/index.ts；packages/boot/app-boot/src/index.ts；设计笔记 .agents/notes/implemented/architecture/2026-09-09/09-10/09-15/09-22 四篇。
- DeskMinis（下称 DM）：/home/user/Deskminis/deskminis，main 35aab54（W1、W2、W3-smoke 已合入）。
- 行号都按单文件计。「推断」表示没有运行验证，只凭源码或文档推出。
- 9/24 的 dsh.md 已写过的内容（R5 进程监管、R5 单实例、R5 窗口守卫、R4 更新准入锁、R3 update-attention、R3 更新资格测试、R4 主题首帧）这里不重复，只写新增、更正和 DM 的最新状态。
- 许可：DSH 是 MIT（Copyright (c) 2026 DeepSeek）。DM 的 THIRD-PARTY-NOTICES.md 目前只在 §5「仅借思路」里登记了 DSH（:148-154）。一旦复制 DSH 代码，就要新开「## N. deepseek-harness — 代码改编（MIT）」一节（含改编表和 MIT 全文），并按附录格式写文件头「部分改编自 deepseek-harness（https://github.com/deepseek-ai/deepseek-harness）」；tests/license-consistency.test.ts 会双向核对。

---

## 0. 拓扑一览

| 维度 | DSH | DM |
|---|---|---|
| 后端进程 | `child_process.spawn(process.execPath, …)`，环境里加 ELECTRON_RUN_AS_NODE=1，stdio 为 `['ignore','pipe','pipe','ipc']`（host-process.ts:163-175；node-environment.ts:15） | `utilityProcess.fork(minisd.js, { stdio:'pipe' })`（main/index.ts:110-122） |
| 控制通道 | Node IPC 类型化事件：ready / fatal / platform-session / shutdown-complete / update-tasks（host-process.ts:8-31），逐条校验，非法就 kill（:35-68、:181-184） | stdout 行协议：握手行 `{minisdPort,authToken}` 与致命行 `{minisdFatal}`（index.ts:140-167；fatal.ts:13）；关停走 parentPort `{type:'shutdown'}`（minisd-stop.ts:11；minisd/index.ts:1517-1520） |
| 业务通道 | HTTP + WebSocket 到 127.0.0.1:19387（固定端口，desktop-host/src/index.ts:28 的 `--port 19387`）；cookie 由主进程在网络层注入，只对主窗口生效（main.ts:606-617） | WebSocket JSON-RPC，per-run token 经 IPC 交给渲染端，只认回环地址加 Origin 白名单（rpc/server.ts:36-50） |
| 界面文档 | 自定义特权协议 dsh-app://app/，由主进程从包内提供（main.ts:111-121、561-576） | 打包后用 file://…/index.html（index.ts:216-218、260-261） |
| 关窗 | window-all-closed 时退出（非 darwin，main.ts:1035-1037） | 隐藏到托盘常驻（index.ts:264、493-495） |

结论：拓扑同构。DM 用 utilityProcess 加 stdout 行协议，DSH 用 RunAsNode 加 Node IPC，两边都成立。DM 不用改拓扑（与 roadmap 处置表「保留」一致）。

---

## 1. 启动序列与握手

**DSH 怎么做**
- 主窗口先建好但隐藏（main.ts:1059 → createMainWindow → createWindow(appPreload, false, true)，:906）。
- reconcileBackend 先让主窗口开始加载包内页面，再准备 profile、启动 Host（main.ts:486-501）。页面加载与后端启动并行。
- 页面通过 preload 的 `dshDesktopBoot.ready()` → IPC `boot` 拿注入与流地址。主进程的 handler 会先 `await startup` 再返回（main.ts:581-586；preload-app.ts:49）。
- Host 就绪并读完欢迎状态后，才在 enterWorkspace 里 `window.show()`（main.ts:931-946，:936）。
- 不设启动超时。设计笔记原文是「No elapsed-time heuristic classifies a slow startup as fatal」（2026-09-15-desktop-native-fatal-recovery.md:13）。代价也写明了：「a silent startup hang has no automatic timeout prompt」（同文:29）。

**DM 现状**
- 顺序是串行的：`await startMinisdProcess()` → `await createWindow()`（index.ts:444-445）。
- createWindow 没设 `show:false` 和 backgroundColor，窗口一建出来就可见，随后才 loadFile（index.ts:231-240、260-261）。
- 30 秒握手超时后 kill，并报「启动超时」（index.ts:89、130-134）。
- `minisd:info` 直接返回模块级的 minisdPort/minisdToken（index.ts:368）。握手只在 `minisdPort === 0` 时才接收（:156），所以同一个主进程里第二次 fork 的握手会被忽略。

**差距与建议**
1. 【W6a，先量后改】并行启动。先建窗口（隐藏）并开始加载页面，同时 fork minisd；`minisd:info` 改成等「当前这一代」就绪再返回，引擎处于错误态时 reject。省下的是渲染端 bundle 的解析时间。minisd 启动只 await 桥管道和 rpc 监听（minisd/index.ts:457、1436），MCP 是懒连接（:886），所以收益可能只有几百毫秒（推断）。先在 Windows 真机按按天日志里「启动引擎进程 → 握手完成」两行的时间差量出基线再决定。只借思路。
2. 【W6a，硬性前置】W6a 要在进程内重启 minisd，launcher 就必须按代保存 port/token。DSH 的做法是每次 start 都 new 一个 DesktopHostProcess（main.ts:380-386）。模块级 minisdPort/minisdToken 加 `minisdPort === 0` 这道闸（index.ts:44-47、156）不能沿用。只借思路。
3. 【不改】启动超时。DSH 故意不设，但它启动期窗口是隐藏的，Host 卡住时用户什么也看不到（推断）。DM 的 30 秒超时能给出确定结论，更适合托盘应用；保留。

---

## 2. Host 生命周期协议与消息校验

**DSH 怎么做**
- 事件有 5 种：ready（带 url、injections）、fatal（带 message，以及 Host 自己 `util.inspect` 出的 diagnostic，上限 64KB）、platform-session、shutdown-complete、update-tasks（host-process.ts:8-31；desktop-host/src/index.ts:82、86-99）。
- 校验很严（host-process.ts:35-68）：收到非法消息就 fail 并发 SIGTERM（:181-184）；没请求过关停却收到 shutdown-complete，也按故障处理（:188-191）。
- 只要进程 close 而此前没请求过关停，就算故障，退出码是 0 也算（:200-205 与 :264-275，fail 在 stopping 期间被忽略）。
- fatal 走 IPC 而不是 stderr。原因写在 desktop-host/src/index.ts:90-93：「stderr bytes and this IPC message race, and the shell reports the first failure it sees」。
- Host 在父进程断开时自己有序停机：`process.once('disconnect', () => void stop())`（desktop-host/src/index.ts:70）。
- 「协议 v4」只是写进随包运行时描述的一个版本戳。准备 profile 时用 parseDesktopRelease 核对，不一致就拒绝启动（host-protocol.ts:4；release.ts:11、23；runtime-tree.ts:198；project-manager.ts:86）。IPC 上没有版本协商。

**DM 现状**
- 致命行只收白名单字段（fatal.ts:13、23-35）。写完先等 500ms 再 exit(1)，这是实测结论：Electron 在子进程 exit 之后就不再交付管道里剩下的数据（fatal.ts:37-44）。
- minisd 意外退出（码为 0 也算）会记成 minisd_exit（crash-hooks.ts:147-157）。
- 握手行里的 token 一字不落盘（index.ts:163-164）。

**差距与建议**
- 不需要协议版本戳。minisd 与界面同仓构建，没有漂移源；roadmap 处置表已说明。
- 不需要把 stdout 行协议改成 IPC。DM 的致命行白名单加 500ms 延迟有实测依据，效果与 DSH 相当。改用 parentPort.postMessage 能否在子进程 exit 之前可靠送达，没有依据（推断），不值得冒险。
- 【W3 手测，零代码；如需修补放 W6a】父进程死亡后引擎是否跟着退出。DSH 的 Host 显式监听断开。DM 依赖 Chromium 在 browser 进程死后回收 utility 进程（推断：Electron 38 的 electron.d.ts 里 UtilityProcess 和 ForkOptions 都没写这条语义）。如果 minisd 活了下来，它还握着数据根锁：锁按 pid 判存活（data-root-lock.ts:163-173），下次启动就会弹「DeskMinis 已在运行」（minisd-fatal.ts:40-49），而这时没有托盘可以退出它。
  - 手测：任务管理器里只结束主进程，看同名的 utility 子进程是否在几秒内消失。
  - 如果没消失，W6a 让 minisd 每隔几秒用 `process.kill(process.ppid, 0)` 探一次父进程，父进程没了就走 close()；要注意 Windows 会复用 pid。

---

## 3. 后端状态机、重启策略与「就地换后端」

**DSH 怎么做**
- DesktopBackendController（backend-controller.ts:33-157）：
  - 状态分 starting / ready / error（:6-10）；
  - 并发的 start 共享同一次尝试（:63）；
  - stop 会取消正在准备的尝试（:104-120），close 之后永不再 spawn（:126-129、61）；
  - 就绪后出错时，先清理再发布 error（:138-148），清理失败时合成 AggregateError（:89-91、146）；
  - host getter 只在 ready 时返回实例（:53）。
  - 配套 9 个行为用例（tests/backend-controller.spec.ts:28-163），例如「close 时等准备完成且之后不再 spawn」「就绪瞬间子进程失败不发布 ready」「先等失败子进程清理完再重试」。
- 致命后不自动重启。backend 进入 error 就交给原生对话框（main.ts:429-432 → reportFatal）。设计笔记写明「A fatal backend failure requires one of the native recovery actions rather than an in-process retry」「restarting on every report can … create restart loops」（2026-09-15 笔记:17、23）。对话框里的「重启」是整应用 `app.relaunch(); app.quit()`（main.ts:82）。
- 只有一处就地换后端：更新安装失败时（main.ts:454-474）。它 `backend.start(...)` 起新 Host，把 `navigation = undefined`，再 navigateMain 重新加载主窗口页面。注释说明了原因：「A replacement Host can have a new port, cookie, or boot injections even at the same URL」（:464）。navigateMain 对同一地址的并发导航共用一个 promise，退出途中或 ERR_ABORTED 的失败静默吞掉（:363-377）。

**DM 现状**
- 握手后崩溃：记入 crashes.json（index.ts:180-192）。渲染端的 ws onclose 触发横幅加「重启应用」，走整应用 relaunch（rpc.ts:47、88-97；chat.ts:621-645；index.ts:378-384）。这与 DSH 的「显式整应用重启」等价，只是没有原生对话框，也不点名崩溃记录。
- W6a 计划的「5 分钟内 1/2/4/8/16 秒退避自动重启」借自 ZCode（roadmap:180）。

**差距与建议**
1. 【W6a，照抄改写或只借测试清单】launcher 的状态机语义照 BackendController 写，先把上面 9 个用例翻成红测（close 后不得再 fork、就绪瞬间失败、清理后才重试、清理失败不重叠）。如果复制代码（157 行），要登 NOTICES 新节并写文件头；只翻译测试清单则算「仅借思路」，追加到 §5。
2. 【W6a，只借思路，排序建议】「就地重启 minisd 后重载渲染页（webContents.reload 或重新 loadFile）」可以作为 W6a 的交付形态，不必等 W6b 的代次化 RpcClient。重载后渲染端会新建 RpcClient，重新调 minisd:info。chat store 已经处理过「渲染端重载后从中途接上」（chat.ts:648-657 的 trackRun 与 midRun 注释）。代价是没发出去的草稿和视图状态会丢，可以在重载前把草稿暂存到 sessionStorage。W6b 再把重载换成无缝重连。
3. 【W6a，只借思路】自动重启要保守。DSH 明确拒绝自动重启，理由是重启循环和掩盖配置问题。建议 DM：崩溃预算保留，但只在「握手后崩溃、且这一代里没有 run 在跑」时自动重启；否则保持现在的横幅加手动重启，并在横幅上点名 crashes.json 的路径。被打断的回合一律不自动续跑（roadmap「不做什么」已写）。
4. 【W6a，只借思路】「重启并安装」失败后的处理。DM 现在是 3 秒后 app.quit()（relaunch.ts:21；index.ts:315），用户看到应用突然消失、也没装上新版。DSH 在安装失败时就地恢复后端，并弹「更新失败」（main.ts:454-476；update-coordinator.ts:35-40 在 installing 期间收到 updater 的 error 就转成 install 失败）。等 W6a 能就地重启 minisd 后，改成「重启引擎 + 重载页面 + 中文提示安装失败」。

---

## 4. 单实例

**DSH 怎么做**：claimDesktopSingleInstance 在模块顶层拿锁。拿不到就 quit，而且根本不注册 whenReady 的工作（single-instance.ts:16-26；main.ts:1116-1118）。second-instance 由 focusPrimaryWindow 处理（main.ts:1010-1024）：窗口已销毁就重建；启动期工作区还没就绪时直接 return，不把隐藏着、还在加载的主窗口翻出来（:1020）。

**DM 现状**：W1b-3 已完成（index.ts:64-77、416）。退出途中忽略 second-instance；主窗口还没建好时记一笔，建好后唤出（:58、71、447）。另有数据根锁兜住「两份 userData 指向同一个数据根」的情况（data-root-lock.ts）。

**结论**：不借。DM 更完整：DSH 靠固定端口 19387 的 EADDRINUSE 发现与 `dsh web` 的冲突（fatal-recovery.ts:73；locale.ts:23、153 的专门文案），DM 有数据根锁，并且对陈旧锁做接管与隔离核对。

---

## 5. 原生致命恢复对话框

**DSH 怎么做**（fatal-recovery.ts）
- 每个进程只呈现第一次致命故障，锁存在等待对话框之前就置上（:65-67）。后来的故障只进日志（2026-09-15 笔记:15）。
- 先写崩溃报告，最多等 1 秒（:20、106-119），拿到路径就在对话框里单独一行点名。
- detail 只放错误的最后 8 行，总预算 1200 个 UTF-16 码元（含截短提示、报告路径、重装建议），因为原生对话框不能滚动（:23、26、34-41）。
- 按钮：退出 / 重启 / 禁用第三方插件并备份 profile patch 后重启。EADDRINUSE 时换专门文案，只给前两个按钮（:73-87）。
- 恢复操作本身失败时，同一个对话框改显示「恢复操作失败」并循环，不算第二次致命（:88-103）。
- 退出途中发生的致命故障只写报告，不弹框（main.ts:101-109）。

**DM 现状**
- 启动失败：DB_NEWER_THAN_APP 和 DATA_ROOT_LOCKED 用专门对话框，只给「退出」（minisd-fatal.ts:28-51）；其余用 showErrorBox，附 stderr 末尾（index.ts:456-468；minisd-fatal.ts:54-56）。
- 运行期引擎崩溃：没有原生框，只有渲染端横幅（见 §3）。
- 主进程未捕获异常：每次都 showErrorBox，框里点名 crashes.json（crash-hooks.ts:109-117）。

**差距与建议**
1. 【W6a，只借思路】主进程错误框加两条规则：同一进程只弹第一次，后续只记录；quitting 时不弹。现在如果某个监听器反复抛错，会连弹阻塞框；退出途中窗口和托盘都收掉了，还会凭空弹出一个框。改动约 5 行，给 installMainCrashHandlers 加一个 `quitting()` 注入和一个已弹标志。
2. 【W6a，只借思路】如果 W6a 给「握手后崩溃且不自动重启」配原生框，照搬 8 行 / 1200 字的预算、先写记录再点名路径（最多等 1 秒）、第一次锁存这三条。按钮换成 DM 的：退出 / 重启 / 以安全模式重启（见 §8）。
3. 不借 EADDRINUSE 专门文案：DM 端口不固定（resolveAndPersistPort，minisd/index.ts:1436），不存在这个失败面。

---

## 6. 崩溃报告的内容与形态

**DSH 怎么做**（crash-report.ts）
- 一次致命故障写一个文件 `crash-<ISO>-<source>.log`，source 取 host、web-boot、renderer、main 之一（:14、47、94-96）。
- 目录权限 0700；文件用 `flag:'wx'` 独占创建，权限 0600（:147-157）。
- 启动时按文件名只保留最新 10 份，名字对不上的文件一概不碰（:50、166-184；main.ts:294）。
- 报告内容（:104-130）：
  - 头部事实：time、source、phase（startup 或 running）、app 名与版本、platform/arch、electron、node、locale、shell pid；
  - 错误段：用 `util.inspect(error,{depth:6,…})` 而不用 `.stack`，上限 256KB（:56、132-137），因为 fs 错误的 code/syscall/path 和 cause 链都是可枚举属性，stack 行里没有（2026-09-22 笔记:21）；
  - Host 自报的诊断，原样放在单独一段（:125）；
  - 主窗口 error 级控制台的尾部，上限 64KB，按整行丢弃、不截断行（:53、63-86）。
- 隐私立场（2026-09-22 笔记:35）：连续日志将来只存固定类别；崩溃报告是例外，可以存原文，但必须有上限、只落本地、只有属主可读、只在已经弹致命框时写，并且框里点名文件，让用户知道自己将分享什么。
- 促成这套设计的现场教训（同文:9-15）：两次线上故障都只能靠截图里那 8 行诊断。

**DM 现状**
- 单个 crashes.json，最多 5 条、保留 7 天，写临时文件后 rename 原子替换（crash-log.ts:29-35、101-139）。
- 字段只有 timestamp、version、process、kind、message、stack、exitCode、stderrTail（:41-53）。Error 只取 message 和 stack（:91-98、124-125），cause 链和 `.code`（例如 SQLITE_BUSY、SQLITE_FULL）都会丢；fs 系统错误的 message 自带 code 和 path，影响小（推断）。
- 没有运行阶段、平台、Electron 或 Node 版本字段。
- 另有 DSH 没有的按天日志（daily-log.ts）。

**差距与建议**
1. 【W6a，只借思路】记录补一个 `detail` 字段，存 `inspect(error,{depth:4})`，截到 16KB；再补 `phase`（startup 或 running，可由 handshaken 推出）、`os`（os.release()）、`arch`、`electron`、`node`。W6a 的诊断包正好需要这些头部字段。改动集中在 crash-log.ts 的 recordCrash 和 crash-hooks.ts 的两个安装函数，不需要迁移（坏条目本来就丢弃，新字段是可选的）。
2. 不改成一故障一文件：DM 有按天日志兜住完整 stderr，5 条 JSON 足够。
3. 【W6a 诊断包，只借思路】借 DSH 的隐私分层：导出包里 crashes.json 保留原文（有上限），按天日志做脱敏（pi 的 SENSITIVE_KEY 规则，roadmap 已列）；导出前在界面上列出将要打包的文件。

---

## 7. 进程级致命策略：uncaught 与 unhandled，以及有上限的收尾

**DSH 怎么做**
- installFailLoud（packages/boot/app-boot/src/index.ts:635-726）：uncaughtException 和 unhandledRejection 都判致命。处理顺序是：
  1. 先写一行带标签的 `util.inspect` 诊断，避免收尾卡住时把原因吞掉；
  2. 在 2 秒上限内等 release 钩子（FAIL_LOUD_RELEASE_TIMEOUT_MS，:635），计时器保持 referenced，免得空事件循环以 0 退出；
  3. exit(1)。
- 收尾期间处理器不卸载，靠锁存让后续错误落入等待中的退出。
- CLI 与 Host 共用的 profile runner 挂的 release 是 `app.current?.fiber.dispose()`，即在 2 秒内把整棵应用（作业、子进程、会话）收掉（apps/cli/src/profile-boot.ts:278-282）。
- 理由（2026-09-22 笔记:21、51）：监听器抛错时状态只有抛出点知道。现场案例：一个 stdout 'data' 监听器在 spill 目录被删后，每来一块数据就抛一次；如果继续运行，就会把一个不存在的 spill 路径当结果返回。
- DSH 的 Electron 主进程没有任何进程级钩子（apps/desktop/src 里 grep `process.on(` 结果为空），笔记也自承无法报告主进程崩溃（2026-09-15 笔记:29）。

**DM 现状**
- minisd 遇到 uncaughtException：记录后立即 exit(1)（crash-hooks.ts:70-77），不关库、不回收子进程树、不放锁。
- 后果：直接子进程随 libuv 作业一起被结束，孙进程（npx 拉起的 node、dev server）留成孤儿（win-exec.ts 头注释「已知边界」）；锁变陈旧，下次按 pid 接管。
- unhandledRejection：记录后继续运行。这是设计稿 §2 拍板的（2026-09-24-hemostasis-design.md:68-70）。

**差距与建议**
1. 【W6a，只借思路】uncaught 退出前加有上限的收尾。先写记录（已有），再在最多 1.5 秒内做三件事：各项 disposeAll 加上 killTree 回收、`db.close()`、`lock.release()`，然后 exit(1)。这就是 W1b-5d 那张清单的应急版，可以复用 shutdownReap（minisd/index.ts:271-290）。主进程的 5 秒强杀闸不受影响，因为这条路径是 minisd 自己退出。
   - 风险：异常之后状态不可信。所以只做「回收子进程、关库、放锁」这类幂等动作，不做 abort run 或落库。
   - 验收：注入一次 uncaught，断言 taskkill 被调用、锁文件被删、退出码为 1。
2. 【W6a 之后再议】unhandledRejection 要不要改成致命。DSH 的现场案例说明「继续跑」可能把可见的崩溃变成静默的错误输出；DM 的取舍是在没有自动重启的前提下定的。建议 W6a 自动重启落地后，先统计 crashes.json 里 unhandled_rejection 的实际出现频率，再决定是否改成「记录、收尾、exit(1)，交给 launcher 重启」。本条不动代码，只记为待决。

---

## 8. 安全模式与「禁用第三方」

**DSH 怎么做**
- 恢复对话框的第三个按钮会先停 Host，再在 profile 锁下调 sanitizeProfile（project-manager.ts:76-78、93-130）：
  - 把 profile patch 改名为 `.bak-<ms>`（重名追加序号）；
  - 把 package.json 里的 bundle 列表重写成恢复用的默认集合（profile-sanitize.ts:18-33）；
  - 不解析 patch，不删已安装的文件。
- 做完后整应用 relaunch（fatal-recovery.ts:93-97）。这是持久改动，不是一次性标志。

**DM 现状**
- W6a 计划安全模式「跳过 MCP、同步、市场技能」（roadmap:180）。9/24 建议过「停用全部 MCP 后重启（servers.json 改名备份）」。
- 事实：DM 的 MCP 是懒连接，run 开始时才 ensureForRun，空闲 10 分钟就释放（minisd/index.ts:886；mcp/manager.ts:2-6）。坏掉的 MCP 挡不住启动。
- 启动期真正的阻断点是库、密钥库、端口、桥、锁，而且已有专门处置（DB_NEWER、DATA_ROOT_LOCKED）。
- 同步在装配时就 start（minisd/index.ts 的 syncCoordinator.start()）。

**差距与建议**
- 【W6a，修正 9/24 的建议】不改名 servers.json。W1a 花了四步才让 MCP 配置不再被静默改坏，改名会让用户以为配置丢了。安全模式做成一次性启动标志：relaunch 时经 fork env 传 `DESKMINIS_SAFE_MODE=1`，minisd 在本次运行里跳过同步 start、MCP ensureForRun 和市场技能注入；界面顶部显示「安全模式」横幅，带「正常重启」按钮。
- 它的价值在「运行期崩溃循环」，也就是同步或 MCP 客户端代码抛出 uncaught 的情况，而不在启动阻断。
- DSH「不解析、不删、留原字节」的原则仍然适用：安全模式期间不写任何配置。

---

## 9. 渲染端的失败面（新增，9/24 未写）

**DSH 怎么做**（main.ts:905-930）
- `console-message` 中 level 为 error 的行进入 RendererConsoleTail，上限 64KB（:911-914；crash-report.ts:63-86）。
- `did-fail-load`：只看主框架，且错误码不是 -3（ERR_ABORTED）（:915-919）。
- `preload-error`（:920-922）。
- `render-process-gone`：reason 不是 clean-exit 时（:923-928）。
- 页面自己的启动失败：web 入口把整个启动包在 try/catch 里，失败时调 preload 的 `dshDesktopBoot.failed(message)`（apps/web/src/main.ts:11-38；preload-app.ts:50）；主进程只接受主窗口主框架发来的这个请求（main.ts:588-595）。
- 以上都进入 reportFatal：写报告，弹原生框。
- 打包版保留 F12 和 Ctrl+Shift+I 打开 DevTools（main.ts:844-854；apps/desktop/README.md「including in packaged builds」）。

**DM 现状**
- 以上监听一个都没有（index.ts:230-266 的 createWindow 只挂了导航守卫和关窗隐藏）。
- 渲染端入口 `createApp(AppShell).use(createPinia()).mount('#app')` 没有 try/catch，也没有 app.config.errorHandler（renderer/src/main.ts:10）。
- W2b-6c 为防误触，在打包版去掉了开发者工具（app-menu.ts:3-28）。这个选择是对的，但结果是用户机器上的界面错误完全不可见。
- W6a 目前只列了 render-process-gone 和 GPU 崩溃（roadmap:180）。

**差距与建议**
1. 【W6a（也可以作为 0.3.x 之后的首个小改动），照抄改写或自写】主窗口挂 `console-message`，把 level 为 'error' 的行写进现有的按天日志，加 `[renderer]` 前缀。每行截到 2KB，每分钟最多 N 行，防刷屏。Electron 38 的签名与 DSH 相同：`(details) => details.level/message/sourceId/lineNumber`（electron.d.ts:15247 与 WebContentsConsoleMessageEventParams）。Vue 生产构建的默认错误处理和 Chromium 的「Uncaught (in promise)」都会落在 console.error，一个监听就能全部接住（推断）。只落本地，日志本来就不上传。
2. 【W6a】`render-process-gone`（非 clean-exit）：记一条 `process:'renderer', kind:'renderer_gone'`，带 reason 和 exitCode；第一次自动 `webContents.reload()`，minisd 不受影响，回合照跑。短时间内再次发生，就弹原生框（退出 / 重启）。`did-fail-load`（主框架、非 -3）和 `preload-error` 同样只记录加弹框。「首次自动重载」借 AionUi 的 rendererRecovery（roadmap 已列）；「只看主框架、排除 -3」和 reason 过滤借 DSH。
3. 【W6a】渲染端启动失败回报。renderer 的 main.ts 用 try/catch 包住 mount，chat.init 里 connect 以外的初始化异常也调 preload 新增的 `reportBootFailure(message)`；主进程校验 sender 是主窗口主框架后，记录并弹框。新通道要过 ipc-contract 的配对守卫。
4. 如果复制 RendererConsoleTail（24 行），就要登 NOTICES 新节；自写环形行缓冲则只追加 §5。DM 的 child-output.ts 已有类似实现，建议自写。

---

## 10. 日志与诊断导出

**DSH 怎么做**
- 就绪前调用 `app.setAppLogsPath()`（main.ts:67）。按 Electron 文档，Windows 上这个目录在 userData 下，也就是 Roaming（推断，据文档）。
- 没有连续日志，被列为 future work（2026-09-22 笔记:35）。
- 没有「导出诊断包」，只在致命框里点名报告文件。
- 有一个开发与冒烟用的开关：主进程启动失败时，如果设了 `DSH_DESKTOP_DIAGNOSTIC_FILE`，就把堆栈写进这个文件（main.ts:1121-1124）。

**DM 现状**
- 有按天日志（10MB/天、7 天，daily-log.ts:21-23、56-124），日志目录在 LOCALAPPDATA，不随漫游（app-dirs.ts:49；paths.ts:45-48）。
- 有 crashes.json。诊断包排在 W6a。

**差距与建议**
- DM 在这一项上领先，不借。
- 【W4b 或 W6a，可选，只借思路】给冒烟和 e2e 加一个 `DESKMINIS_DIAGNOSTIC_FILE`：设了它时，启动失败把原因写进文件后直接以 1 退出，不弹阻塞框。这样 e2e:m5 和 smoke:release 碰到启动失败时能确定地失败，而不是卡在模态框上等超时（推断：现在的剧本遇到 showErrorBox 会一直挂到超时）。

---

## 11. 退出与关停

**DSH 怎么做**
- before-quit 的处理（main.ts:1038-1057）：
  1. 如果安装器接管了退出（shellInstallerOwnsQuit），直接放行；
  2. 否则 preventDefault，把 quitting 置真；
  3. 停账号订阅，隐藏窗口，释放更新计划和对话框；
  4. 等 `Promise.all([policy.dispose, backend.close()])` 结束后再调 app.quit()。
- will-quit 里清理计时器和 powerMonitor 监听（:794-798）。
- Host 的 stop 按升级梯进行（host-process.ts:242-262）：先发 shutdown 等 10 秒，再 SIGTERM 等 5 秒，再 SIGKILL 等 5 秒，还不退就抛错。
  - `requireGraceful` 用于安装前：必须满足退出码为 0、收到过 shutdown-complete、且没超时，否则抛 DesktopHostUncleanExitError，拒绝安装。
  - 按 Node 文档，Windows 上 SIGTERM 与 SIGKILL 都是强制终止（推断）。所以在 Windows 上这道升级梯实际等于「10 秒后硬杀」。
- Host 端收到 shutdown 后调 `running.shutdown.shutdown(0)`，发 shutdown-complete，再 disconnect（desktop-host/src/index.ts:47-53）。

**DM 现状**
- QuitGate：第一次 before-quit 挡住，先收起界面，再请 minisd 有序 close，5 秒后仍未退出就 kill（minisd-stop.ts:8、46-63、86-111；index.ts:480-492）。
- minisd 的 close 有 8 步，每步各自兜住；关库之后才放锁；等 run 收尾 3 秒、回收子进程树 1 秒，这两段预算由测试钉住（minisd/index.ts:243、250、1466-1491；tests/minisd-stop.test.ts）。
- stop 的结果（exited 或 killed）没有被使用，也没记日志（index.ts:315、489）。
- closeThenExit 不管 close 成败都 exit(0)（minisd/index.ts:296-301），主进程分不出「有序关停做完」和「关停中途出错」。

**差距与建议**
1. 【W6a，只借思路，小】关停结果进按天日志。结果为 'killed' 时记一行「引擎 5 秒内没退出，已强制结束（半截回复可能丢失）」。minisd 在 close 末尾经 parentPort 回一条 `{type:'shutdown-result', runsStopped, reap:'done'|'timeout', error?}`，由主进程写日志；如果消息没到（通道已断），就按「不洁」记。这相当于 DSH shutdown-complete 回执的轻量版。用户反馈「退出后半截回复没了」时，靠这一行就能判断原因。
2. 不借升级梯和 requireGraceful 拒装。DM 在 Windows 上 5 秒硬杀，与 DSH 的实际效果等价（见上）。安装前的忙碌检查（inspect/lock）9/24 R4 已写，至今未排进任何波次，建议并入 W6a 或 W7b（它依赖 W6c 的 SessionRuntime 提供 activeWork）。
3. 双方都没处理 Windows 注销和关机（DM 的已知边界见 index.ts:478；DSH 里 grep session-end 同样为空）。
   - Electron 38 的 BrowserWindow 在 win32 上有两个事件（已核对 electron.d.ts）：
     - 'query-session-end'：`preventDefault()` 可以推迟关机（:2207-2216）；
     - 'session-end'：无法阻止（:2306-2313）；
     - 两者都带 reasons，取值为 shutdown、close-app、critical、logoff 之一（:19298-19307）。
   - DM 可以考虑在 query-session-end 里挡一下，发出 shutdown，等 minisd 退出后再放行。副作用是 Windows 会显示「此应用正在阻止关机」，需要真机评估体验，也可能根本不值得做（推断）。
   - 这不是 DSH 的借鉴项，只作记录，排不排、排进哪一波留给 W6a 设计稿决定。

---

## 12. 更新的生命周期（新增项，9/24 只写了准入锁）

### 12.1 网络空闲超时

**DSH 怎么做**：用 DesktopUpdateHttpExecutor 替换 electron-updater 的 httpExecutor（update-http-executor.ts:6-53；update-coordinator.ts:56-64）。它给表头到达前、以及响应数据块之间的静默各设一个空闲期限（默认 60 秒），收到数据就续期，结束、中止或出错时释放。注释写明「The upstream socket timer is for Node HTTP; Electron ClientRequest has response/close events instead」（:19）。资格测试覆盖了「stalled-feed and stalled-download deadlines」（2026-09-10-desktop-local-updater-qualification.md:29、43）。

**DM 现状**（均为源码核实）
- 用的是默认 ElectronHttpExecutor（electron-updater 6.8.9 的 AppUpdater.js:206）。
- 超时挂在 `request.on("socket", …)` 上（builder-util-runtime 9.7.0 的 httpExecutor.js:141-147、278-283），而 Electron 38 的 ClientRequest 只有 abort、close、error、finish、login、redirect、response 这几个事件（electron.d.ts:6522-6623），所以这个超时永远不会生效。
- 检查请求卡住后，AppUpdater 会把之后所有的 checkForUpdates 都接到同一个 promise 上（AppUpdater.js:257-275）。托盘的「检查更新…」要 `await checkUpdates(true)`（index.ts:345、352-355），于是永远没有回执，W2b-9「手动检查要有回音」的承诺在这种情况下失效。
- manualCheckDialog 的注释写着「正常走不到这里」（update-status.ts 的 default 分支）。
- 下载卡住时，本次运行里一直停在「正在后台下载」。
- 更新源是 github.com，面向的是国内用户，连接中途卡住并不罕见（推断）。

**建议**：放 W6a。如果在意 0.3.x 补丁到达用户的速度，可以提前到 0.3.1。有两种做法：
- (a) 照抄改写 DesktopUpdateHttpExecutor（53 行，要深引 `electron-updater/out/electronHttpExecutor.js`，升级 electron-updater 时须复核），登 NOTICES 新节并写文件头；
- (b) 最小止血：checkUpdatesFromTray 用 Promise.race 加 20 秒超时，超时就回「检查超时，请稍后再试或到发布页下载」。这只能保证有回执，根因还在。
- 验收：用 node:http 起一个回环服务，先发表头再挂住，确认检查在期限内以错误结束，而且下一次检查会真正重新发请求。

### 12.2 周期检查

**DSH 怎么做**
- DesktopUpdateSchedule（update-schedule.ts:18-111）：默认间隔 10 分钟，失败时间隔翻倍、上限 1 小时，加 ±20% 抖动。截止时间从上一次检查完成时算起，定时、获焦、resume、手动几种触发共用这一个截止时间；手动检查绕过截止并加入正在进行的请求。
- 触发来源：窗口 focus（main.ts:909）、`powerMonitor.on('resume')`（:793）；will-quit 时清理（:794-798）。

**DM 现状**：只在启动 8 秒后检查一次，其余靠手动（index.ts:439）。DM 常驻托盘，一个实例可能连跑数周，这期间永远不会再查（推断）。github provider 走网页端点，不受 API 限流（electron-builder.yml 的 publish 注释），周期检查没有配额压力。

**建议**：放 W6a，照抄改写或只借思路。在启动检查之外，每 6 小时加抖动查一次，powerMonitor 的 'resume' 和托盘唤出时按截止时间补查，失败退避，关掉「自动检查」开关时全部停止。代码不长，自写就够；如果复制，登 NOTICES。

### 12.3 其它

- DSH 安装走 `quitAndInstall(true, true)`：静默安装并强制重启（update-coordinator.ts:133）。DM 用默认参数，显示 NSIS 界面。这属于产品取舍，不借。
- DSH 显式设 `allowDowngrade = false`，并写明原因「Selecting a channel can enable downgrade」（:69-70）。DM 没设 channel，默认值就是 false，不需要改；将来开预发布通道时要记得显式写上（9/24 R3 已提过通道）。

---

## 13. 窗口：首帧、状态保存与多窗口

### 13.1 首帧与白闪（W9c）

**DSH 怎么做**
- 主窗口 `show:false`，页面载入、工作区就绪后才 show（main.ts:906、936）。
- Windows 标题栏的 overlay 颜色和符号色在创建时按 nativeTheme 选（:167-169、192-196），之后由渲染端测量调色板、经 IPC 同步（9/24 已写）。
- 子窗口（更新遮罩）也用 `show:false` 加 'ready-to-show'（update-overlay.ts:13、45）。
- 更正：09-09 的即时窗口笔记说启动期窗口可见，但 HEAD 上主窗口其实是隐藏的，页面只是在后台与 Host 并行加载（main.ts:486-501）。以代码为准。

**DM 现状**：窗口创建即可见，没有 backgroundColor，符号色固定为 #808080（index.ts:231-240）。渲染端默认跟随系统主题（theme.css:183-185）。深色系统下，首帧是白底，页面载入后才变深（推断，未实拍）。

**建议**：放 W9c，与「已保存的主题首帧生效」一起做，只借思路。
- `show:false`，在 `did-finish-load` 或 `ready-to-show` 后再 show。second-instance 和托盘唤出的逻辑不受影响。
- backgroundColor 与 titleBarOverlay 的颜色按「已保存主题，否则 nativeTheme.shouldUseDarkColors」选。主进程读不到 localStorage，要像 update-prefs.json 那样落一个小文件。
- 验收：在 xvfb 下给深色主题实拍首帧。

### 13.2 窗口位置与尺寸的保存恢复

双方都没有。DSH 里 grep getNormalBounds、isMaximized 结果为空，每次都是 1280×820；DM 每次都是 1280×800。DSH 没有可借的。如果要做，放 W9b（布局）：在 close 和 hide 时记下 getNormalBounds 和 isMaximized，写进 userData 的小 JSON；恢复时用 screen.getDisplayMatching 校验仍在可见区域内，否则居中。完全自写。

### 13.3 多窗口的生命周期（将来加窗口时的清单，现在不动）

DSH 的欢迎窗、更新遮罩、强制更新窗都遵守同一套纪律：
- 每个窗口在创建时注册自己的 IPC handler，在 'closed' 时移除；换新窗口时立即交出 handler 所有权（welcome-window.ts:50-71、97；update-dialog.ts:124-125）。
- sender 必须是该窗口的 webContents 和主框架（welcome-window.ts:72-76）。
- 对话框响应带 revision，过期的响应一律拒绝（update-dialog.ts:60）。
- 子窗口跟随父窗口移动和缩放，关闭时摘掉监听（update-overlay.ts:29-44）。
- 加载失败就 destroy 并 reject，不留半截窗口（welcome-window.ts:100-106）。

DM 现在是单窗口（roadmap：近期不做多窗口）。这份清单留到将来加更新窗或对话墙时用。

---

## 14. IPC 发送方校验（补充 9/24）

**DSH 怎么做**：所有 handler 都校验来源。assertDesktopSender 检查 frame URL 的协议和主机（ipc.ts:80-87）；产品 IPC 还要求 sender 是主窗口、senderFrame 是主框架（main.ts:356-362、619-624）。目录选择器对同一窗口的并发请求共用一个对话框，弹出前先 restore、show、focus（directory-picker.ts:11-29）。

**DM 现状**：只有 app:relaunch 校验了 sender（index.ts:378-379）。minisd:info、dialog:pickFolder、attachments:save、update:* 都不校验（:357-368、388-411）。W2b-6 之后新窗口一律拒绝，导航也拦下了，暴露面已经很小。pickFolder 没有防并发。

**建议**：放 W6d 顺手做，只借思路，低优先级。抽一个 `assertMainFrame(e)`，所有 handler 统一先调；pickFolder 按窗口加 pending 共享。9/24 已提 minisd:info，这里只补上其余通道。

---

## 15. 防御性模式：删除目录时不跟随 junction（与 teardown 相关）

**DSH 怎么做**
- docs/defensive-patterns.md:31-33：凡是可能是链接的路径，先 `lstat().isSymbolicLink()` 再 `unlinkSync`；「recursive deletion may descend through [a junction] into its target. Reserve recursive rmSync for known real directories」。
- apps/desktop/src/owned-directory.ts:11-24 逐层 lstat，只 unlink 链接，注释是「Electron's recursive rm follows nested Windows junctions into installed resources」。这个文件现在只有测试脚本在用。
- 同文还有两条可以当评审清单：「Dispose must reach quiescence, not just request it」（:19-21）、「Report orthogonal outcomes independently」（:7-9）。

**DM 现状**
- 删除技能是 `rmSync(join(skillsRoot, id), {recursive:true, force:true})`（minisd/index.ts:1252）；覆盖重装也先 rmSync 目录（skills/importer.ts:231）。
- agent 经权限卡可以往 skills/ 下写东西，也可以经 shell 执行 `mklink /J`。
- 如果 Electron 38 自带的 Node 的递归 rm 会穿过 junction（DSH 的现场结论；DM 这个版本是否如此是推断），用户删除一个含 junction 的技能时，可能连同 junction 指向目标里的内容一起删掉。
- 会话删除不删目录，不受影响。

**建议**：放 W8c（技能改 staging 原子安装时一起重写删除），W6d 的 junction 红测夹具可以复用。
- 先在 Windows 真机验证：临时目录里建一个 junction 指向另一个目录，对外层 rmSync 递归，看目标是否受损。
- 再改成逐层 lstat、只 unlink 链接的删除函数。如果照抄 owned-directory.ts（26 行），登 NOTICES；自写则只追加 §5。

---

## 16. 开发体验（低优先级，只作记录）

- 给引擎挂调试器端口。DSH 在开发态用 `DSH_DESKTOP_HOST_INSPECT_PORT` 给 Host 加 `--inspect=127.0.0.1:<port>`，并校验端口范围（main.ts:150-158；host-process.ts:165）。DM 可以只在未打包时读 `DESKMINIS_MINISD_INSPECT_PORT`，经 utilityProcess.fork 的 execArgv 传入（ForkOptions 有 execArgv，electron.d.ts:20546），方便 W4b 以后调引擎。只借思路。
- 开发菜单里的「Restart App Host」（main.ts:833-837）：DM 开发态保留了默认菜单，可以 Ctrl+R，不需要。

---

## 17. DeskMinis 同样好或更好的地方

1. 数据根锁（data-root-lock.ts）：用 ownerToken 加接管闸，陈旧锁先改名隔离、核对内容后才删，释放从不抛错。DSH 的 profile 锁只有 pid 加 ESRCH 判断（project-manager.ts:93-130），跨实例冲突还要靠固定端口的 EADDRINUSE 来发现。
2. 权限白名单：DM 只放行本应用页面的剪贴板写入（nav-guard.ts:25、82-83）。DSH 除麦克风以外全部沿用 Electron 默认的「放行」（microphone-permissions.ts:18、24）。
3. 连续的按天日志和主进程崩溃记录（daily-log.ts；crash-hooks.ts:104-124）：DSH 两样都没有（grep 为空，笔记自承）。DM 的日志放在 LOCALAPPDATA，不随漫游。
4. 关停：时间预算的三者关系由测试钉住，close 的 8 步逐步兜住，关库之后才放锁，第 6 步会等子进程树回收（minisd/index.ts:243、250、271-290、1466-1491）。DSH 的 10s/5s/5s 升级梯在 Windows 上实际只相当于一次硬杀（推断）。
5. 便携版重启到外层 exe（relaunch.ts:12-19）；「重启并安装」没退出时 3 秒兜底（:21）。DSH 没有便携版。
6. 启动致命行加 500ms 退出延迟，有实测数据（fatal.ts:37-44）；握手 token 不落盘；DB_NEWER 和 LOCKED 都有专门对话框，只给「退出」。
7. 打包菜单去掉了重载和开发者工具，保留编辑和缩放（app-menu.ts）。DSH 在打包版保留 DevTools，是另一种取舍；DM 的选择没错，但需要 §9 的渲染端错误采集来补上可诊断性。
8. 端口不固定（resolveAndPersistPort），不存在 DSH 那种「与 dsh web 抢 19387」的失败面。

---

## 18. 对 9/24 dsh.md 的更正与补充

| 9/24 原文 | 更正或补充 | 依据 |
|---|---|---|
| 「生命周期协议 v4（host-protocol.ts）」 | 只是随包运行时描述里的版本戳，准备 profile 时比对；IPC 上没有协商。DM 同仓构建，不需要 | release.ts:11、23；runtime-tree.ts:198 |
| 「非 0 退出或 Host 报 fatal 都进入 fail 流程」 | 没请求过关停的任何 close 都算故障，退出码 0 也算（报「stopped」）；另有第五种事件 platform-session | host-process.ts:26-31、200-205 |
| 「sanitizeProfile 把 patch 改名为 .bak-<ts>，不解析，也不删文件」 | 补充：还把 package.json 的 bundle 列表重写为恢复集合；在 Host 停止后、profile 锁下执行 | profile-sanitize.ts:32；project-manager.ts:76-78 |
| 「app-boot 把 unhandledRejection 和 uncaught 一律视为致命」 | 补充：致命路径在 2 秒上限内先 dispose 整棵应用再 exit(1)；Electron 主进程本身没有进程级钩子 | app-boot/src/index.ts:635-726；cli/src/profile-boot.ts:280；main.ts 中 grep 为空 |
| 「setWindowOpenHandler / will-navigate / 右键菜单守卫」列为 DSH 的强项 | 权限请求不在其中：DSH 对非 media 权限全部放行，DM 的 W2b-6 白名单更严 | microphone-permissions.ts:18、24 |
| 即时窗口（09-09 笔记）隐含「启动期可见」 | HEAD 上主窗口 `show:false`，就绪后才显示；只有页面在并行加载 | main.ts:906、936、486-501 |
| R5 建议「停用全部 MCP 后重启（servers.json 改名备份）」 | DM 的 MCP 是懒连接，挡不住启动；安全模式改为一次性启动标志，不改名配置文件（见 §8） | minisd/index.ts:886；mcp/manager.ts:2-6 |

DM 在 9/24 之后的进展（不再列为缺口）：单实例与数据根锁（W1b-3）、优雅退出与进程树回收（W1b-5/5d）、断线横幅与重启（W2b-3）、崩溃记录与按天日志（W2b-7）、窗口守卫与权限白名单（W2b-6）、打包菜单（W2b-6c）。

仍然开着的缺口：安装前忙碌检查（9/24 R4）；握手后崩溃的原生框与自动重启、安全模式、render-process-gone（W6a）。本笔记新增的缺口：§7 致命前有上限的收尾、§9 渲染端失败面、§12 更新空闲超时与周期检查、§5 主进程错误框去重。

---

## 19. 汇总：建议、波次与借法

| # | 建议 | 波次 | 借法 | NOTICES |
|---|---|---|---|---|
| A | 渲染端失败面：console-message 错误行写进按天日志，did-fail-load、preload-error、render-process-gone 记录并处置，界面启动失败回报 | W6a | 思路（RendererConsoleTail 可照抄） | 照抄就开新节，否则追加 §5 |
| B | minisd 的 uncaught 退出前，在 ≤1.5 秒内回收子进程树、关库、放锁 | W6a | 思路 | §5 |
| C | 崩溃记录补 inspect 全量和运行环境头；主进程错误框去重、退出途中不弹 | W6a | 思路 | §5 |
| D | launcher 状态机照 BackendController 写红测；就地重启后重载页面，让 W6a 不依赖 W6b；minisd:info 等当前代就绪 | W6a | 照抄改写或借测试清单 | 视情况 |
| E | 「重启并安装」失败后就地恢复引擎，替代 3 秒后退出 | W6a（在 D 之后） | 思路 | §5 |
| F | 更新请求的网络空闲超时 | W6a（可提前到 0.3.1） | 照抄改写 update-http-executor，或最小止血 | 照抄就开新节 |
| G | 周期检查更新，并在 resume 或唤出时补查 | W6a | 思路或照抄改写 | 视情况 |
| H | 关停结果回执写进按天日志 | W6a | 思路 | §5 |
| I | 窗口先隐藏、载入后再显示，底色按主题选 | W9c | 思路 | §5 |
| J | 安全模式做成一次性启动标志 | W6a | 思路（修正 9/24） | 无 |
| K | 递归删除技能目录时不跟随 junction（先真机验证） | W8c | 思路或照抄 owned-directory | 视情况 |
| L | 所有 IPC handler 统一校验主窗口主框架，pickFolder 防并发 | W6d | 思路 | §5 |
| M | 父进程死亡后引擎是否退出（真机核对，如需修补放 W6a） | W3 手测 | — | 无 |
| N | 开发态引擎调试端口；冒烟用的诊断文件开关 | W4b（可选） | 思路 | §5 |

没有必须在 0.3.0 前改的代码。只有 M 是零代码核对，建议加进 W3 手测清单。

---

## 未覆盖

- welcome-backend、account-backend、platform-view（WebContentsView 平台页）、强制更新策略窗（mandatory-update-*）的完整状态机：属于账号和强制更新，与 DM 无关，只扫了窗口纪律部分。
- apps/desktop 的打包、签名、安装器脚本（installer/*.cpp、*.ps1）和 core-package-set：发布工程不在本方向。
- apps/desktop/tests/main-startup.spec.ts（1735 行假 Electron 剧本）只看了夹具结构。DM 已有同类夹具 tests/main-window-guard-harness.ts，没有逐例对照。
- 以下都没有运行验证：父进程死亡后 utility 进程是否退出、Node 递归 rm 是否穿过 junction、深色系统下的首帧白闪、electron-updater 卡住时的实际表现。其中最后一项的机理已经过源码与类型核实，但没有真机或回环复现。
