# 止血波设计稿：W1a–W2b，然后发 0.3.0（2026-09-24）

状态：**定稿即施工**（自己做模式）。
立项依据：用户 2026-09-24 对方向评估报告的答复——「按照你的想法把它完善再發出去」。据此采纳报告的建议，
报告 §7 的拍板项全部按默认建议落定（见 §2）。报告：`docs/research/2026-09-24-reference-resurvey.md`；
路线详案：`docs/research/2026-09-24-resurvey/roadmap.md` 的 W1、W2 两节。

本稿是施工的权威依据。逐项的现状事实、改动点、先红测试、会翻红的守卫，写在同目录附录
`docs/specs/2026-09-24-hemostasis/` 的六份侦察计划里（tools / mcp / lifecycle / engine / renderer / release），
步骤切分与冲突顺序写在 `cross.md`。**附录与本稿冲突时，以本稿为准。**

## §0 范围与边界

- **做**：报告 §4 的 A 组（伤数据、越权）与 B 组（静默失效、界面撒谎）全部在 0.3.0 前修掉；
  侦察补出的同类缺陷一并修（§4 标「补」的步骤）；发布工程补齐到「用户在 Windows 真机上按清单即可上架」。
- **不做**：任何新功能；任何 DB 迁移（`MIGRATIONS` 只加 `export` 与 `Object.freeze`，条目零改动）；
  新 npm 依赖；上下文管线重写与前缀稳定（W5）；会话协议与重连（W6）；思考档位界面与代际表（W4c）。
- **云端做不了、留给用户**：Windows 真机打包、`e2e:m5`、真 key 冒烟、上传发布资产、创建公开发布仓库（§5）。

## §1 纪律（本波全部适用）

交接文档 §2 全套照旧，另加本波约定：
1. **提交前缀**：`W1a-2: …` 这种带子波字母的形式，与 2026-09-07 的旧 W 波（`W1:`…`W6:`）区分。
2. **先红取证**：每步先写失败测试并跑出红，红输出存 `scratchpad/hemo-logs/<步骤>-red.log`，要点抄进提交正文。
   Linux 上无法先红的（Windows-only 行为）写明「非先红」并说明原因。
3. **每步独立全绿**：该步测试绿 + `npm run typecheck` 0 + 全量 `npm test` 与 52 例基线逐行 diff 为空。
   新增测试不得落进 Windows-only 基线（Linux 上必须能跑）；确需 Windows 的另开 `*.win.test.ts` 并在提交里申报。
4. **有意翻红**：改变既有守卫断言的，提交正文逐条列「文件:行 · 原断言 · 新断言 · 为什么」。
5. **借用即登记**：借用 pi（MIT）或 ZCode / AionUi（Apache-2.0）的代码，文件头写「改编自 <上游名>（<URL>）」，
   并在仓库根 `THIRD-PARTY-NOTICES.md` 对应上游节的表里追加一行（格式由 W1a-1 定）。
6. **界面改动必 xvfb 目视**：`npm run build` 后用 playwright-core 剧本实拍，截图存 `scratchpad/hemo-shots/`。
7. **Linux 上触发权限卡**：用 `web_fetch`（askOnce），或 W1b-2 之后写 `/var/minis/skills/x/SKILL.md`；
   不要用 POSIX 绝对路径的 `file_write`（`paths.ts:54-55` 直接抛错，进不了网关）。
8. **源码守卫防什么（2026-09-25 补）**：只防现实中会发生的回退——注释或散文喂饱断言、自然的重构写法
   （改用 watch、换个函数名、挪进帮手文件或别的目录、同名字段换一个）。刻意混淆的写法——HTML 实体或转义拼出标识符、
   `arguments` 反射、非 ASCII 同义标识符、把函数经高阶调用转手、字符串拼属性名——不算测试漏网，审查列作 nit，
   由行为测试和代码审查兜底。理由：三轮审查在 W2a-6、W2b-4 上一路追到这类写法，守卫越写越死，每次正常重构都要改守卫，
   而刻意混淆本来就过不了人工审查。

## §2 拍板项落定

报告 §7「发版前必须定」五项，按默认建议：

| 问题 | 落定 |
|---|---|
| 0.3.0 何时发 | W1、W2 止血后立即发；引擎重写推到 0.4.0 |
| 自动更新源 | GitHub provider 指向公开的只放发布资产的仓库 **`lincheuk/deskminis-releases`**；`electron-builder.yml` 只改 repo。仓库由用户创建 |
| 数据根写入收窄 | 核心数据与凭据一律拒绝；mcp-servers / skills / memory / 其它会话 / 其余应用数据走权限卡并带说明 |
| 新一代 Claude 缓解 | 官方端点上的 `claude-fable-5-1` `claude-mythos-5-1` `claude-opus-5-5` 发 `drop_block`；第三方端点遇绑定 400 剥思考块重试一次 |
| 开发态数据隔离 | 隔离（未打包默认 `DeskMinis-dev`，keyring 服务名 `DeskMinis-dev`），手工迁移步骤写进 README |

侦察提出的开放问题，落定如下（采纳推荐的不再复述理由）：

- **MCP**：损坏时拒绝一切写入；空文件或纯空白（剥 BOM 后）当可写的空配置；纳入「外部修改不被覆盖」；
  补丁语义下市场更新保留用户的 enabled / note / cwd / 超时 / headers，env 显式传（空传 `null`）；
  同名新建在前端拦截；删除某键用 `null`；`list` 只在出错时带 `configErrorKind: 'read'|'parse'|'shape'`；
  **「改动即时生效」做成真话**：执行器调用前查 `enabled`，upsert / remove 后通知 manager `forget(name)`；
  改名不迁移会话级禁用名单（写进已知边界）。
- **工具层**：`full` 档对「走卡」类跟随档位放行，硬拒类不受档位影响；数据根内读取用白名单
  （当前会话各桶、shared、skills、memory、绑定工作区免审，其余走卡）；`dataGate` 做规范化
  （最近存在祖先取 realpath，realpath 可注入；win32 小写、剥 ADS、剥尾点尾空格）；搜索三件套跳过数据根子树并尾注；
  file_edit 拒绝非 UTF-8 文件、重叠出现算不唯一、拒绝空 old_string；技能 zip 上限 2000 条 / 64MB 总量 / 32MB 单文件，
  office 单文件上限取 64MB（行为不变）；killTree 不再同步先杀根进程，只在 taskkill 出错或非 0 退出时兜底；
  `cmd.exe` 与桥的 `runPowerShell` 一并改 System32 绝对路径；agent 直写技能每个新文件一张卡，接受。
- **shell 只读白名单读数据根**（侦察推荐「含未加引号的 $ 就改询问」，**不采纳**：PowerShell 的 `$_` 太常见，
  会让大量只读命令弹卡）。改为：只读判定命中、但命令文本（不区分大小写）含 `deskminis`、`$env:`、`%appdata%`、
  `%localappdata%` 之一时回落为 gated。并入 W1b-2。
- **生命周期**：日志与崩溃记录放 `%LOCALAPPDATA%\DeskMinis\logs`（dev 为 `DeskMinis-dev`；设了
  `DESKMINIS_DATA_DIR` 时为 `<DATA_DIR>/logs`）；未打包且设了 `DESKMINIS_DATA_DIR` 时 userData 移到 `<DATA_DIR>/electron`；
  minisd 的 unhandledRejection 记录后继续、uncaughtException 记录后 `exit(1)`，主进程 uncaughtException 记录后照默认；
  e2e 脚本不留锁绕过开关；删除运行中会话等收尾超时（10s）就**不删**并报错；DB_NEWER 对话框只给「退出」；
  pid 复用风险本版接受；断线横幅的「重启」重启整个应用，走优雅退出，处理函数里不出现 `app.exit(`。
- **引擎**：溢出时不在 W2a 做「强制压缩重试」（W5）；预算超出时新锚点后退；第三方端点绑定 400 剥思考重试一次；
  不在 buildEffectiveHistory 剥保留回合的思考（W5）；只处理三个目标模型的 budget_tokens；DeepSeek V4 全量回放已捕获的推理；
  卸载读回上限 50000 字符；auto-title 输出上限 2048；接力继承模型绑定；溢出降级后沿用 turnEnd 改绑。
- **渲染端**：「上下文已满」接力草稿用兄弟字段 `relayDraft: {sessionId, text}`，只在输入卡 setup 消费、要求
  `sessionId === activeId`，不用 watch；断线时清 pendingPerms、保留流式文本；欢迎页修复用新 RPC
  `chat.sessions.applyAssistant`，标题仍为默认值时才改成助手名；切回仍在跑的会话显示 midRun 占位；
  其它会话的待批在对话流顶部提示「另有 N 个会话在等你批准」；胶囊「默认 · X」改在纯模块 `binding.ts`。
- **发布工程**：`sync.hello` 声明 `protocolVersion: 2`、`caps: {}`，对端信息存 `conn.syncPeer`；README 设备同步定 🟡
  并写明跨机器需设 `MINISD_HOST`；LICENSE 与 THIRD-PARTY-NOTICES 随包（extraResources）；登记格式在 W1a-1 定；
  技能 zip 用自家常量，不登记 ZCode；加 `tests/readme-claims.test.ts`（只钉三条）；托盘手动「检查更新」给结果反馈；
  手改 `package-lock.json` 根元数据三处；公开发布仓库放 README / LICENSE / NOTICES / CHANGELOG；CHANGELOG 0.2.0 标「未公开发布」；
  托盘「打开设置」「切换右栏」两条死通道在 W2b-11 接上。

## §3 统一契约

侦察的交叉检查发现几处两边各写一套的契约，这里定死，实现与测试都按此：

1. **ProviderError.code**：`'contextOverflow' | 'thinkingBinding'`，在 W2a-2 一次定型；两者缺省 `fallbackable=false`、`retryable=false`。
   loop 在捕获处（`loop.ts:427` 之后）**显式拦截**这两个 code，不能只靠 fallbackable（`:434-439` 对非 fallbackable 也会降级）。
2. **溢出事件**：找不到更大窗口的槽位时，loop 发 `{kind:'error', code:'contextFull', message, relayDraft}`；
   `relayDraft` 由引擎用库里完整的最新 marker 摘要加最后一条真用户消息拼成，上限 8000 字。
   降级到更大窗口时，`fallback` 事件带 `cause:'contextOverflow'`，reason 为「上下文已满」。
3. **绑定错误事件**：`{kind:'error', code:'thinkingBinding', message}`，message 中文在前、原始错误在后。
4. **压缩失败事件**：`{kind:'compactFailed', reason:'empty'|'truncated'|'refusal'|'error', message}`；
   渲染端 eventNotes 的 kind 联合**在末尾追加** `'compactFailed'`。
5. **渲染端 eventNote 字段**：新增 `relay?: boolean`、`short?: string`；草稿正文放 `store.relayDraft.text`。
   `lib/eventnote/copy.ts` 先按事件的 code 选短句，不对原始报文跑状态码正则。
6. **PermissionRequest.note?: string**（W1b-2）与渲染端 **PendingPerm.sessionId**（W2b-2）：改同一接口与同一 push 对象，
   后合入的一方保留两个字段。
7. **断线**：`rpc.onLost(handler)` 专门 API；`preload.relaunchApp()` ↔ `ipcMain.handle('app:relaunch')`，
   主进程校验 sender 是主窗口，`app.relaunch()` 后走 `app.quit()`（before-quit 里优雅停止）。
8. **minisd 致命行**：standalone 捕获 `DB_NEWER_THAN_APP` / `DATA_ROOT_LOCKED` 时往 stdout 写
   `{"minisdFatal":{code,…}}` 一行，写回调里 `exit(1)`；主进程解析后弹对话框。stderr 末尾 4KB 环形缓冲只实现一次。
9. **数据根锁**：`<dataRoot>/minisd.lock`（接管闸 `minisd.lock.recovery`），文件名常量放 `paths.ts`，
   `dataGate` 硬拒表引用同一常量；close 最后一步释放，释放幂等。
10. **子进程环境**：shell、终端、MCP 子进程的 env 剥掉 `DESKMINIS_*` 这组变量（W1b-1）。
11. **引擎进程的退出监听**只挂一个（W1b-5 建），W2b-7 复用它区分「退出流程中的 exit」与崩溃。

## §4 施工步骤

「侦察号」对应 `cross.md` 的步骤；「补」表示报告 §4 之外、侦察补出的缺陷。每步一个提交，独立全绿。

| 提交号 | 侦察号 | 内容 | 依赖 |
|---|---|---|---|
| W1a-1 | S0a | 登记格式与双向绊线、依赖冻结守卫、package.json 与 lock 的 license、LICENSE/NOTICES 随包 | — |
| W2a-0 | S0b | 请求体黄金快照（sha256 硬编码表），先冻结再改 provider | — |
| W1a-2 | S1 | file_edit：slice 拼接、CRLF 偏移映射、BOM、非 UTF-8 拒绝、重叠算不唯一、空 old_string 拒绝 | W1a-1 |
| W1a-3 | S2 | 技能 zip 上限（entryCount、inflate 前、流式三处） | — |
| W1a-4 | S3 | MCP 配置损坏时拒写，`configErrorKind`，SecMcp 横幅与开关回滚 | — |
| W1a-5 | S4 | MCP 外部修改不被覆盖（写前对比磁盘，list 先 refresh） | W1a-4 |
| W1a-6 | S5 | MCP 编辑后端：补丁语义、`null` 删键、`renameFrom`、试连不写盘、市场更新 env 显式；**补**：即时生效成真 | W1a-5 |
| W1a-7 | S6 | MCP 编辑表单：参数每行一个、只提交改过的字段、改名、同名拦截 | W1a-6 |
| W1a-8 | S7 | 迁移守卫（DB_NEWER、事务回滚、sha256 钉）与 minisd 致命行通道 | — |
| W1a-9 | S8 | 开发态数据隔离（app-dirs、userData、keyring 服务名、日志目录下发） | W1a-8 |
| W1b-1 | S9 | 进程树回收与 System32 绝对路径、windowsHide、`ShellManager.dispose(sessionId)`；**补**：剥 `DESKMINIS_*` | W1a-1 |
| W1b-2 | S10 | 数据根读写收窄（dataGate、note、搜索跳过数据根）；**补**：shell 只读规则 | W1a-2、W1a-9、W1a-4 |
| W1b-3 | S11 | 单实例锁与数据根锁 | W1a-8、W1a-9、W1b-2 |
| W1b-4 | S12 | 删除运行中会话先中止；**补**：定时任务失败不再记为 ok；NavRail 删除中状态 | W1b-1、W1b-2、W1b-3 |
| W1b-5 | S13 | 优雅退出（shutdown 消息、5s 兜底、close 幂等与竞态） | W1b-4 |
| W2a-1 | S14 | 压缩：旧摘要加增量、压平、预算、拒收空与截断、compactFailed、auto-title 2048 | W2a-0 |
| W2a-2 | S15 | 溢出分类与 contextFull 契约（移植 pi 正则） | W2a-1、W1a-1 |
| W2a-3 | S16 | 新一代 Claude：beta 头与 drop_block；绑定 400 不可降级；第三方剥思考重试一次 | W2a-0、W2a-2 |
| W2a-4 | S17 | DeepSeek V4 回放 reasoning_content | W2a-0、W2a-3 |
| W2a-5 | S18 | 卸载读回不再二次卸载、修剪桩如实 | W2a-4 |
| W2b-1 | S19a | 按会话跟踪运行状态、midRun 占位 | 合流后 |
| W2b-2 | S19b | 权限卡按会话区分、NavRail 等待标、对话流顶部提示 | W1b-2、W2b-1、W1b-4 |
| W2b-3 | S20 | 重启通道与断线横幅 | W1b-5、W2b-2 |
| W2a-6 | S21 | 溢出的界面部分（接力按钮、relayDraft 消费、fallback 短句） | W2a-2、W2b-3 |
| W2b-4 | S22 | 欢迎页选助手：新 RPC `chat.sessions.applyAssistant` 与渲染端修复 | W2a-6、W1b-5 |
| W2b-5 | S23 | ModelBar 标「默认模型」，胶囊「默认 · X」 | — |
| W2b-6 | S24 | 窗口导航守卫与权限白名单（只放行 clipboard-sanitized-write） | W2b-3 |
| W2b-7 | S25 | 本地崩溃记录与按天日志 | W2b-6、W2b-4 |
| W2b-8 | S26 | `sync.hello` 带协议版本 | — |
| W2b-9 | S27 | 更新源改公开发布仓库、中文错误文案、便携版状态、托盘手动检查反馈 | W2b-7、W1a-1 |
| W2b-10 | S28 | `scripts/verify-release.mjs` 与 `npm run verify:release` | W2b-9 |
| W2b-11 | S29 | README / CHANGELOG / RELEASE 逐行核对；界面同类假话；托盘两条死通道；`readme-claims` 守卫 | 全部 |

**施工组织**：W1a-1 与 W2a-0 先在 main 上完成。之后三条链在各自的 git worktree 里并行：
链 A1（W1a-2…W1a-7）、链 A2（W1a-8、W1a-9、W1b-1）、链 B（W2a-1…W2a-5）。三条链合入 main、全量验证后，
其余步骤在 main 上串行，W2b-5 与 W2b-8 可并行。每步由一位实现者完成，再由一位独立审查者按本稿与附录对抗式复核，
必须修的问题修完才进入下一步。

### §4.1 施工中追加（2026-09-25）

审查第三轮留下、又落在别的步骤范围里的问题，按下表并入；均不加迁移、不加依赖。

| 步骤 | 并入内容 | 来由 |
|---|---|---|
| W1b-2d（新，S10 余项，接 W2a-5） | `file_read` 加可选 `offset`（非负整数，按 UTF-16 码元计的字符偏移，默认 0）与 `limit`（正整数，最多返回的字符数，上限 100000）。切点不落在代理对中间。带任一参数时，文件大小上限从 1MB 放宽到 16MB，返回片段末尾附一行「[第 a–b 字符，共 N 字符]」；不带参数时行为与输出逐字不变。卸载读回截断（offload.ts `clampReadBack`）与 1MB 超限提示改指 `file_read` 分段读取（写明下一段的 offset），不再叫模型用 `shell_execute`；超过 16MB 才提示 shell。工具定义变了；`provider-body-golden` 的夹具自带冻结的工具定义、不钉真实工具，实际不用重指（实现核实，交接复核订正） | W1b-2b 审查：卸载文件在数据根里，W1b-2 起 shell 只读命令点到它回落 gated，照提示读卸载内容每次弹卡；当前会话的 offloads 对文件工具免审 |
| W2b-3 | 「重启并安装」兜底：`quitAndInstall()` 之后若应用没有退出（electron-updater 的 install() 返回 false 时不会调 app.quit），3 秒后 `app.quit()`，不留下引擎已停、窗口还开着的状态 | W1b-5 三审 nit |
| W2b-7 | 权限超时回调里的 `audit.append` 兜住：库写失败只进按天日志，不在定时器里抛未捕获异常 | W1b-5 修正者申报 |
| W2b-11 拆成两步 | **W2b-11a（界面诚实）**：`StageChat.vue` 里不在运行中的回合、没有结果的工具不再显示成功，显示「已中断 · 结果未知」；release.md「W2b-readme」风险条列的界面同类假话（TerminalPane、StageCron、StageDevices，SecMcp 视 MCP 链落地情况）；托盘「打开设置」「切换右栏」两条死通道在 AppShell 接上；main/index.ts 符号色注释、TopBar 高度注释（140→146px）、AppShell「默认收起」注释三处订正。**W2b-11b（对外文档）**：README / CHANGELOG / RELEASE 逐行核对与 `readme-claims` 守卫，排在全部代码合入之后 | OpenCode V2 研读报告 §2（`docs/research/2026-09-25-opencode-v2-baseline.md`）；拆开是为了界面部分先并行做 |
| W2a-7（新，接 W2a-1） | URL 凭据脱敏改成线性扫描，结果与原正则逐字相同（随机对拍钉住） | W1b-2d 实现者申报：长单行平方级，20 万字一行 23 秒，每次构建请求都跑 |
| W1a-7b（新，接 W1a-7；侦察 mcp.md 的 W1a-mcplossy） | MCP 配置保存不再静默丢三样：读入时认不出的条目按原键原文保留、servers.json 顶层 mcpServers 以外的键保留，保存时原样写回（识别出的条目在前）；参数与环境变量里的有限数字、布尔值转成字符串，不再丢弃 | W1a-6 提交正文第 9 条申报「W1a-mcplossy 没做」；属伤数据类，交接起草时复核发现仍是现状 |
| W1a-7c（新，接 W1a-7b） | W1a-7b 第三轮审查的必须修（只补测试，实现不改）：单个裸条目认不出时整份按 `default` 原样写回、`mcpServers` 写成数组时按名为 `mcpServers` 的条目原样写回，各补一例，用审查变异 R1、Y5 证明变红 | W1a-7b 三审（工作流三轮审查用完）；主会话直接做 |
| W1b-2g（新，接 W1b-2） | shell 只读白名单堵出网口：npm 的 view、outdated 移出免批（连 npm 源，view 能取任意网址）；只读命令的文本里出现 UNC 或类 UNC 路径（以 `\\` 或 `//` 起头的路径记号，含 `::\\` 提供程序前缀与 `\\?\`、`\\.\` 设备路径）时回落 gated；不带 `$` 的 `env:` 提供程序路径同 `$env:` 一样回落 gated。另改两处权限文案：危险命令被规则拦下时，shell 回给模型的话不再说「被用户拒绝」；设置页「完全访问」的副标题按危险规则的实际覆盖面写，不再许诺「不可逆的系统操作仍拦截」。顺带删掉测试误建进仓库的 `C:\Users\me\Documents\notes.txt` 并修掉建它的那个测试 | W2b-11b 三审：只读白名单里 `npm view <网址>` 与点到远程共享路径的只读命令，在任何档位下都不询问就会访问外部网络或远程主机；免询问白名单只应包含只读本地的命令 |
| W2b-6b（新，接 W2b-6、W2b-11a） | 终端抽屉的 OSC 8 超链接交给系统浏览器：TerminalPane 的 Terminal 选项加 linkHandler，activate 里 window.open(uri)，经 setWindowOpenHandler 交出（xterm 默认先开空白窗口再改地址，守卫只看到 about:blank，点了没反应）；打包版不再认 ELECTRON_RENDERER_URL（只在未打包时认）；打包版去掉应用菜单（Menu.setApplicationMenu(null)），Ctrl+R 不再在回合中途重载界面、Ctrl+Shift+I 不再打开开发者工具 | W2b-6 三审（终端超链接静默失效）、W2b-6 修正者待裁项、W2b-11a 三审 nit（默认菜单在生产包里生效） |
| W2b-11d（新，接 W2b-11a） | 右栏「改动」清单按工具结果判：失败的与历史回合里中断没有结果的写工具不再列成改动（复用 W2b-11a 的步骤状态判定，运行中回合里还没结果的照旧列）；引擎 cron 两处「错过不补跑」的注释按实际行为改正（启动后第一次检查会补跑一次） | W2b-11a 三审 nit：同一类界面假话；注释与界面新文案相反 |
| W1b-5d（新，接 W1b-5、W1b-1） | 关停等进程树回收做完再退：`killTree` 返回一个在 taskkill 退出（或兜底杀根）之后才落定、从不拒绝的 Promise，现有不等它的调用照旧；终端、shell、MCP 的 `disposeAll` 返回全部回收落定的 Promise；minisd `shutdown` 第 6 步各自兜住地调用三者、等它们落定（另设上限，与 `CLOSE_GRACE_MS` 相加仍比主进程的 `MINISD_STOP_TIMEOUT_MS` 少至少 1 秒，由 `tests/minisd-stop.test.ts` 钉住），之后才关桥、rpc 与库。`proc/win-exec.ts` 头注释按 libuv 的实际行为订正：非 detached 的子进程放进「作业关闭即杀」的作业对象，但作业带 `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`，随 minisd 退出的只有直接子进程，它们起的孙进程不在作业里。引擎崩溃或被强杀时孙进程仍会留下，写进已知边界（根治要自建不带 breakaway 的作业，排在 W6） | 交接复核：W3-smoke 三审实测冒烟脚本被打断时孙进程留下，追到产品——关停第 6 步起了 taskkill 不等就关库退出，taskkill 是 minisd 的直接子进程，按 libuv 源码会随作业一起被结束（推断，真机确认）；`npx` 拉起的 MCP server、终端里起的 dev server 在 Windows 上可能留成孤儿，与 W1b-5「不留孤儿」相悖 |
| W1b-5e（新，接 W1b-5d） | W1b-5d 审查 nits 收口：接线守卫补「等回收排在等 run 收尾之后」；`killTree` 在注入的 spawn 交回的东西挂不上监听时也不拒绝；超时日志、`REAP_WAIT_MS` 与 `McpClientLike.dispose` 的注释写全（MCP http 告别也在这 1 秒里、dispose 从不拒绝）；win-exec.ts 已知边界的措辞；主进程 `MINISD_STOP_TIMEOUT_MS` 的注释把 `REAP_WAIT_MS` 算进去；`tests/crash-log-fork.test.ts` 跑完删掉引擎在应用目录留下的管道套接字 | W1b-5d 审查 nits 与实现者申报；主会话直接做 |
| W3-smokec（新，接 W3-smokeb） | 冒烟脚本起引擎时，非 Windows 上以临时根为 cwd：Linux 上桥的命名管道 `\\.\pipe\deskminis-<哈希>` 是相对路径，套接字文件落进引擎的 cwd，以前每跑一次 `--mock` 就在应用目录留一个（全量测试一遍 15 个）；改后随临时根一起删。Windows 上的命名管道不落盘，cwd 不动。引擎进程没拿到 pid（spawn 运行期报错，Node 只发 'error' 与 'close'、不发 'exit'）时按「没起来」处理：不取进程表、停引擎直接返回，不再空等 15 秒后误报「引擎停不下来（pid undefined）」 | W3-smokeb 第六轮审查 nit；主会话直接做 |
| W2a-8（新，接 W1a-6 的会话级 MCP 禁用与记忆开关） | 按会话排除的工具在执行侧也拒绝：agent loop 执行工具之前查 `excludedToolNames`，命中就回一条失败的工具结果「本会话没有启用这个工具」，不执行。记忆关掉的会话里，模型照着历史里的调用再叫 `memory_write` / `memory_get` 不再生效——以前只是不把它们列给模型，执行侧（loop → `ToolRegistry.execute`）不查。MCP 的会话级禁用本来就有调用层的第二道，行为不变 | W2b-11c 实现者申报；README「按会话开关」的记忆库要在执行侧也成立 |
| W3-upd（新，接 W2b-9、W2b-3） | 更新交接如实，更新过程留痕。①「下载完成」对话框的选项抽成 `update-status.ts` 的纯函数 `downloadedDialog(version)`（与托盘回执 `manualCheckDialog` 同一手法），说明改成：点「重启并安装」会关闭 DeskMinis 并打开安装程序，保持默认选项往下点，最后一页点「完成」就打开新版；也可以先用当前版本，关掉不会自动安装，之后从托盘「检查更新…」再装。不再说「现在重启即可」「下次启动时再装」。按钮、默认焦点与 `quitAndInstall()`（不带参数，保留安装向导）都不变。②关于页 `downloaded` 状态与托盘回执 `downloaded` 的「重启后生效」改成同样如实的说法（关于页指向「现在检查」：再查一次会重新弹出安装提示）。③更新过程写进按天日志，每行带 `[update]`：发现新版并开始下载、已是最新（带发布页上的最新版本号）、下载完成、用户点「重启并安装」、出错（原文逐行，照旧也写 stderr）。测试：纯函数与关于页文案；harness 的 electron-updater 桩改为记下处理器，逐个触发后看按天日志、对话框实参与「重启并安装」的先后顺序 | DSH 桌面端对照报告 §1 U1–U3（`docs/research/2026-09-26-dsh-desktop.md`）：`autoInstallOnAppQuit=false` 时退出与重启都不会装，界面却说「重启后生效」；更新失败原文只进 stderr，打包后没人看得到；「重启并安装」实际打开非静默安装向导。0.3.0 → 0.3.1 的第一次自动更新由 0.3.0 装机的代码执行。用户 2026-09-26「按照你的意思，先把打包前四处代码修看看」；主会话直接做 |
| W3-aumid（新） | 打包后的 Windows 版在模块顶层、建任何窗口与托盘之前 `app.setAppUserModelId('com.deskminis.app')`，与 electron-builder.yml 的 appId 一致（NSIS 写进开始菜单与桌面快捷方式的 AUMID 就是它）。常量与判定放新模块 `src/main/app-identity.ts`（只在 win32 且打包时设，安装版与便携版都设；开发态与其它平台不设；不 import electron，单测直接跑）。测试：判定三种情形；常量与 yml 的 appId 一致；主进程在模块顶层、`app.whenReady` 之前调用；harness 的 app 桩补 `setAppUserModelId` 并记下实参（Windows 上跑 `npm test` 时打包形态的接线测试会走到它），打包形态接线测试按平台断言 | 报告 §1 U4：主进程从没设 AUMID，Electron 会自己生成一个，任务栏固定项与运行中的窗口可能分成两个按钮（推断，交由 RELEASE 发版前核对真机确认）；固定项长期留在用户机器上，晚改会让老固定项失配。路线 W7b 原排的这一行提前；主会话直接做 |
| W3-updb（新，接 W3-upd） | `checkUpdates` 接住 electron-updater 自动下载的 `downloadPromise`：①无论自动还是手动检查都挂上处理——下载失败时 electron-updater 先发 `'error'`（W3-upd 的处理器已记日志、置状态）再让它 reject，以前没人接，成了主进程的未处理拒绝，被 W2b-7 的钩子当主进程崩溃记进 crashes.json（只留最近 5 条，会把真崩溃挤掉）；②手动检查（托盘「检查更新…」、关于页「现在检查」）再等它最多 `MANUAL_CHECK_SETTLE_MS`（1.5 秒）：已经下载过的安装包只核对缓存，几毫秒后才发 `update-downloaded`，等到了，回执与关于页说「已下载」，与同时弹出的安装提示一致；真要从头下载的，等满上限照常回「正在后台下载」。「发现新版本」那行日志不再一律说「开始后台下载」（下载过的只核对一遍）。并入 W3-upd 独立审查的建议修：③electron-updater 自己的记录接进按天日志（`autoUpdater.logger` 的 info / warn / error 三级都接：安装参数、启动安装程序、启动失败的输出与差分下载退回整包只走它；error 级回显 'error' 事件的那份与处理器写的重复，接受）；④出错原文改由纯函数 `updateErrorForLog` 生成：接上错误码、截掉 INVALID_RELEASE_FEED 拼在后面的整段 releases.atom、转不成文字的对象不抛；⑤文案：下载完成框与关于页写「联网时」再查（再查要先拉到版本信息才会核对已下载的安装包），「完成」不加引号（安装程序语言跟随系统，英文系统上是 Finish）；⑥RELEASE.md §5 删掉「原文只写 stderr」，§3 补「任务栏固定」与「更新交接演练」两条真机核对（W3-upd、W3-aumid 的注释引用它们）；⑦补审查指出的测试缺口（选「稍后再说」不记点击、无窗口也记下载完成、空行不写、「已是最新」带当前版本）。测试：harness 记下 ipcMain.handle 的处理器与 Menu.buildFromTemplate 的模板、checkForUpdates 可换实现；按打包形态起主进程，走 `update:check` 与托盘「检查更新…」两条路，覆盖缓存命中、正在下载、下载失败三种情形 | W3-upd 实拍（Linux + xvfb，真 electron-updater，本地 generic 源）：关掉下载完成框后再查，安装提示照常再弹，但托盘回执说「发现新版本，正在后台下载」、关于页变成「有新版本」——`checkForUpdates()` 落定时 `update-downloaded` 还没发（实测晚 7–16ms）；追查时发现下载失败会留下未处理拒绝（electron-updater 6.8.9 `AppUpdater.downloadUpdate` 的 `.catch(e => { throw errorHandler(e) })`）；主会话直接做 |

**施工组织（2026-09-25 改为多链并行，用户要求加快）**：机器 4 核，每个工作流同时最多 2 个 agent，按下表分链：

| 链 | 步骤 | 起点 | 合流 |
|---|---|---|---|
| D2 | W2b-1、W2a-6、W2b-4 及补修 | 已在施工 | 补修完、W2b-4c 接上后合入 |
| D2c | W2b-4c：`tests/sfc-blocks.ts` 脚本段按 babel 注释区间剥、模板段按 AST 注释节点剥 | D2 当前头 | 摘到 D2 最终头上，随 D2 合入 |
| G | W1b-2d、W1b-2e、W2a-7 | main | W2a-7 审完即合 |
| F1 | W2b-2 → W2b-3 | D2 当前头 | D2 合入后变基到 main 再合 |
| F2 | W2b-6 → W2b-7 | main | 做完即合 |
| H | W2b-11a | main | 做完即合 |
| S | W3-smoke（§5.1） | main | 做完即合 |
| M | W1a-7b | main `d00b991` | 做完即合（09-25 下午追加，下同） |
| 文档 | W2b-11b → W2b-11c | W2b-11b 在 F1、F2、H 合入后起步；W2b-11c 并入 main `d00b991` 后起步 | 做完即合 |
| K | W1b-5d | main `d00b991` | 做完即合 |

main/index.ts、preload、TopBar.vue 会被 F1、F2、H 同时改，冲突在合流时逐处手工合并，合并后跑 typecheck 与全量基线比对，界面改动重拍一次 xvfb。
全部合入后做 W2b-11b，再做 W3 其余部分。

## §5 发版（W3）

云端完成 W1a–W2b 后，0.3.0 的发布动作需要用户在 Windows 上做，清单写进 `docs/RELEASE.md`：
1. 在 GitHub 新建**公开**仓库 `lincheuk/deskminis-releases`，放 README、LICENSE、THIRD-PARTY-NOTICES、CHANGELOG。
2. Windows 真机：`npm ci` 后 `npm test`（含 52 例 Windows-only 全绿）、`npm run dist`、`npm run e2e:m5`、`npm run verify:release`。
3. 真 key 冒烟：Anthropic 官方端点跑 Fable 5.1 / Opus 5.5 多轮工具调用加一次 memory_write；DeepSeek V4 多轮工具调用；
   一台参数带 `C:\Program Files\…` 的 MCP 试连；shell 里起 `ping -t` 后点停止，任务管理器里没有残留。
4. 在公开仓库建 Release `v0.3.0`，上传 Setup.exe、Setup.exe.blockmap、portable.exe、latest.yml 四件。

### §5.1 冒烟脚本（W3-smoke）

把上面第 3 条的手工冒烟做成一条命令，用户在 Windows 上跑，也能在 Linux 上用假端点自测：
- `scripts/smoke-release.mjs`，`npm run smoke:release`。零新依赖，照 `scripts/e2e-*.mjs` 的写法：先 `npm run build`，用 electron 以 node 模式起 `out/main/minisd.js`，经 `ws` 走 JSON-RPC。
- 隔离：数据根一律是新建的临时目录（`DESKMINIS_DATA_DIR`），keyring 服务名用 `DeskMinis-smoke-<pid>`（`DESKMINIS_KEYRING_SERVICE`），结束时删掉脚本写进凭据库的条目和临时目录；绝不碰用户真实的数据根与凭据。日志与输出里不出现 key。
- 用例，缺对应环境变量的用例标「跳过（缺 XXX）」，不算失败：
  1. **anthropic**（`ANTHROPIC_API_KEY`）：官方端点，Fable 5.1 与 Opus 5.5 各跑一个多轮会话，要求至少两次工具调用（工作区里 file_write 再 file_read）和一次 memory_write；断言回合正常结束、没有 error 事件、工具结果成功、记忆文件里有约定标记。
  2. **deepseek**（`DEEPSEEK_API_KEY`）：DeepSeek V4 多轮工具调用，第二轮起不报 400（reasoning_content 回放）。
  3. **mcp-spaces**：脚本自己写一个最小 stdio MCP 服务器到带空格的目录（Windows 上 node 本身多在 `C:\Program Files\nodejs\`），登记后能连上并列出工具。
  4. **shell-stop**：用假端点让模型调用 shell_execute 跑长命令（Windows `ping -t 127.0.0.1`，其它平台 `ping 127.0.0.1`），然后 chat.cancel；断言几秒内进程树里没有残留的 ping。
- `--mock`：1、2 两个用例改连本地假端点（脚本内起，Anthropic 与 OpenAI 兼容各一个，按剧本回工具调用），用来在 Linux 上验证脚本本身；另加一条 vitest 用例在 Linux 上跑 `--mock`，或把脚本里可测的纯函数单测。
- 输出一张通过 / 失败 / 跳过表，任一失败退出码非 0。RELEASE.md 的接入留给 W2b-11b。

## §6 已知边界（写进 CHANGELOG）

- 思考档位仍无界面入口；除三个目标模型外，Opus 4.7/4.8/5、Sonnet 5、Fable 5 在带思考档位的远端调用下仍会发 budget_tokens（W4c）。
- 系统提示仍每步重建（W5）：第三方端点上的新账号靠「剥思考重试」维持，官方端点靠 drop_block，首轮成本与延迟会上升。
- 溢出时只降级到更大窗口或报「上下文已满」给出接力，还没有「强制压缩后同槽重试」（W5）。
- 删除会话不删磁盘上的 `sessions/<id>/` 目录；MCP 改名不迁移会话级禁用名单。
- 数据库降级守卫只对装过 0.3.0 之后再回退的情况有效。
- 设备同步默认只监听本机，跨机器需设 `MINISD_HOST`，界面暂无开关；记忆文件不同步。
- 数据根是 UNC 路径（`\\server\share\…`）时，文件工具按相对路径处理并以穿越拒绝，读不到技能与卸载文件。
- 技能索引里的 `<path>` 按 XML 转义，用户名含 `&` 时模型照抄进 file_read 会失败（旧问题）。
- URL 凭据脱敏：多行文本先脱敏、后剥 `\v`、`\f` 等控制字符，凭据本身夹着这类字符时口令不打码（现实里碰不到；改规格要同步 stripInvisible 与两份对拍基准，W2a-7 审查）。
