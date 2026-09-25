# 主进程生命周期与存储（W1a-dbguard / W1a-devdata / W1b-single / W1b-delete / W1b-quit / W2b-crashlog / W2b-guards / W2b-relaunch）

## facts
- src/minisd/store/db.ts:4 的 `const MIGRATIONS: string[]` 没有导出，11 条（[0]..[10]，:5-188）全是 SQL 模板字符串，没有函数。仓库根 .gitattributes 设了 `* text=auto eol=lf`，而且按 ECMAScript 规范，模板字面量的 CRLF 会归一成 LF，所以 sha256(MIGRATIONS[i],'utf8') 在各种 checkout 下都稳定。改注释不会影响哈希。
- db.ts:191-203 openDb 的顺序：new Database → pragma WAL（:193）→ foreign_keys（:194）→ 读 user_version（:195）→ for v<length 逐条执行 `BEGIN`/exec/pragma/`COMMIT`（:196-201）。事务已经有了，但缺三样：没有 ROLLBACK；异常时连接泄漏，事务悬挂在同一连接上；current > length 时循环一次都不执行，静默返回（没有降级守卫）。
- openDb 在生产代码里只有一处调用：src/minisd/index.ts:235。测试里钉 user_version=11 的有：annotations-store:15、assistants-store:25、cron-store:17、db-migration6:36、workspace-picker:110/140/152、market-cache/installs-migration。没有任何测试把 user_version 设到 11 以上。ChatStore 构造器 chat-store.ts:39-52 在迁移 runner 之外幂等补两列（mcp_disabled_json、assistant_id）。
- 启动失败现在的路径：minisd standalone（index.ts:1229-1234）写 stderr `minisd 启动失败: <stack>` 后 process.exit(1)；主进程只把 stderr 转发到自己的 process.stderr（src/main/index.ts:65），打包后的 GUI 进程里看不到；exit 处理（main:66）以 `minisd 退出 code=1` reject；whenReady 的 catch（main:222-228）用 dialog.showErrorBox 显示的是主进程自己的 stack。结果是真实原因（例如 DB 版本不对）进不了对话框。现有 dialog 用法：showErrorBox main:225、showMessageBox（更新）main:136-144、showOpenDialog main:184。
- src/minisd/paths.ts:9-13 dataRoot() 的规则：DESKMINIS_DATA_DIR 优先，否则取 (APPDATA ?? HOME/.config)/DeskMinis。调用点有两个：minisd/index.ts:232，以及 main/index.ts:200（attachments:save 由主进程自己再算一遍）。fork 在 main:35，env 只有 `{...process.env, DESKMINIS_STANDALONE:'1'}`，主进程不向 minisd 下发数据根、keyring 或日志目录。
- app.getPath('userData') 在代码里只有一个用途：main:108 的 update-prefs.json。package.json:2 的 name 是 'deskminis'，没有 productName；electron-builder.yml:4 的 productName 不会注入包内 package.json（node_modules/app-builder-lib/out/fileTransformer.js:88-91 只合并 extraMetadata，platformPackager.js:357-363 也一样）。推断打包后 userData=%APPDATA%\deskminis，在大小写不敏感的 NTFS 上与数据根 %APPDATA%\DeskMinis 是同一个目录（需要在 Windows 真机上确认 app.getPath('userData')）。dev 与正式版目前共用这一目录，包括 Local Storage 里的主题（SecLook.vue:20/24）。
- keyring 服务名写死在 src/minisd/store/provider-store.ts:41：`new Entry('DeskMinis', key)`（KeyringVault 在 :38-48）。用到的槽位：provider:<id>（provider-store.ts:113-177）、search-provider（search-provider-store.ts:7，全局只有一个槽）、pairing.static-identity（remote/pairing.ts:34）、pairing.<fp>（pairing.ts:186）。dev 和正式版共用这些槽，后果是同一个设备指纹，搜索 key 互相覆盖。vault 在 minisd/index.ts:245-247 选择：DESKMINIS_E2E→FileVault，DESKMINIS_TEST→InMemoryVault，否则 KeyringVault。全树没有 keytar 或 safeStorage。
- e2e 脚本分两类。e2e-acceptance.mjs:24 与 e2e-m2b-acceptance.mjs:8 默认用真实数据根，并清掉 DESKMINIS_TEST 走真 keyring（:40/:44）；e2e-acceptance.mjs 的头注释 :4-5 写明「WAL 允许与正在运行的应用共享同一个 minis.db」。m2a/m2c/m2e/m3a/m3b/mcp 都用 mkdtemp 临时根。dry-run.mjs:14-15 读 <数据根>/minisd-port.json 去连正在运行的实例。driver（deskminis-docs/docs/handoff/driver/*.mjs，例如 drive-l6.mjs:68-74）用 playwright 以未打包的 `electron .` 启动，注入 DESKMINIS_DATA_DIR 临时根，但不设 userData。
- 单实例：main 全文没有 requestSingleInstanceLock。mainWindow 是 whenReady 里的局部变量（main:216）。托盘的显示路径是 show()+focus()（main:76、main:220）。minisd 启动顺序（index.ts:231-235）是 root→mkdirSync→MinisPaths→openDb。同一数据根起第二个实例时：桥命名管道 bridgePipePath(root)（bridge/server.ts:11-14，按数据根取哈希）只会让第二个降级（index.ts:315-332）；端口被占时退回随机端口（index.ts:129-139）。所以今天第二个实例能完整起来，和第一个同写一个库。
- 运行态结构：inFlight Set 与 controllers Map 在 index.ts:404-405，runDoneHooks 在 :408。chat.prompt（:582）在 inFlight.add（:673）之后先 `await mcpManager.ensureForRun()`（:678），再落 user 消息（:691），然后 `void (async()=>{...})()`（:693）。这个 run promise 没有留引用，别处无法 await；finally 在 :752-758。chat.cancel（:762-766）只 abort。chat.prompt 不校验会话是否存在。
- chat.sessions.delete（index.ts:517-522）是同步的，只做 terminals.dispose 和 chat.deleteSession；deleteSession（chat-store.ts:142-153）在一个事务里删五张表。ShellManager 没有按会话销毁的方法（tools/shell.ts:173-177 只有 interrupt 和 disposeAll）。渲染端 NavRail.vue:54-57 的 onDelete 没有 try/catch，也没有进行中状态。
- 权限挂起：pendingPerms Map 在 index.ts:281，超时清理在 :296-302，permission.respond 在 :911-927；网关自己还有 90s 兜底（tools/permissions.ts:331-335）。abort 不会唤醒正在等待的权限：files.ts:63-65 和 shell.ts:200-202 只在权限返回之后才复查 signal。agent 循环在工具批执行完后，无论是否已取消都会落 toolResult（agent/loop.ts:563-570）；取消时的半截回复在 cancelWithPartialReply（:289-299）里落库，由 :426/:448 触发。这两处写入都要求 DB 还开着。
- close()（index.ts:1208-1215）的顺序：停同步 → abort 全部 → 对挂起的权限只 clearTimeout、不 resolve（run 会永远卡在权限上，直到网关 90s 兜底后往已关闭的库写，报 database is not open）→ 销毁终端、shell、MCP → await bridge/rpc close → db.close()。standalone 分支（:1225-1228）把 close 直接丢掉，从没接上。主进程 before-quit（main:230）和 quitAndInstall（main:144）都直接 kill；在 Windows 上 kill 就是 TerminateProcess，MCP 和 PowerShell 子进程会变成孤儿。
- electron-updater 的 quitAndInstall（node_modules/electron-updater/out/BaseUpdater.js:13-27）先同步 spawn 安装器，再 setImmediate 调 app.quit()，所以优雅停止必须在调用它之前完成。Electron 38.8.6 的类型定义里，UtilityProcess 有 postMessage/kill/'exit'/pid；子进程侧的 process.parentPort 在非 utility 进程里是 null（electron.d.ts:25491-25496）。
- 日志与崩溃：全树没有 uncaughtException/unhandledRejection 处理，grep 只命中 tests/rpc.test.ts:148。minisd 自己的输出只有 index.ts:331、:1228、:1232 和 chat-store.ts:325 四处。主进程在 main:60（stdout 非握手行）和 main:65（stderr 整块）转发到 process.stderr。index.ts:158-166 的注释已经承认 Roaming 目录会被域漫游或 OneDrive 同步。
- 渲染端实际用到的权限：只有 navigator.clipboard.writeText 两处（components/MarkdownView.vue:17、ui/PreviewPane.vue:75），paste 事件读 clipboardData（Composer.vue:200，不走权限）。没有 Notification、getUserMedia、fullscreen、geolocation、window.open、iframe/webview。外链只有 MarkdownInline.vue:16 的 `<a target=_blank rel=noopener>`，href 已经由 lib/markdown/parse.ts:43-47 限定为 http/https/mailto。〔2026-09-25 订正：「没有 window.open」「外链只有 MarkdownInline」两句不对。终端抽屉里的 xterm 对 OSC 8 超链接默认的 activate 会先弹英文 confirm，再 window.open() 开空白窗口、改 location.href；主进程 setWindowOpenHandler 只看到 about:blank，按规矩拒绝，点了什么也不发生（W2b-6 第三轮审查实测）。W2b-6b 给 TerminalPane.vue 的 new Terminal({...}) 加了 linkHandler：先用中文 confirm 给出主机与规范形地址（new URL(uri).href），确认后 window.open(同一个规范形地址)，经 setWindowOpenHandler → openInSystem 交给系统浏览器（仍只放 http/https）；W2b-6b 同时订正了 main/nav-guard.ts 头注释里的同一说法。〕Electron 的权限类型里有 'clipboard-sanitized-write'（electron.d.ts:12744/12753）。
- createWindow（main:85-101）没有 setWindowOpenHandler、will-navigate，也没有任何权限 handler；webPreferences 只设了 preload（main:93），其余是默认的 sandbox 和 contextIsolation。
- preload 白名单（src/preload/index.ts:5-32）一共 7 个方法。ipc-contract.test.ts:72-81 自动核对 preload 的 invoke 与 main 的 handle 是否成对。渲染端通过 `(window as any).deskminis` 取用（rpc.ts:19、stores/chat.ts:387/605）。
- 现有守卫里会被这次改动碰到的：tests/ipc-contract.test.ts:13-27 用 vi.mock('electron') 打桩后 import src/main/index.ts，桩只有 whenReady/on/quit/getPath/getVersion/isPackaged，主进程模块顶层新增任何 app.* 调用都会让整个文件在 import 时 TypeError。tray-lifecycle.test.ts:33-49 要求 before-quit 体内字面含 `minisd?.kill()`。auto-update.test.ts:55 要求：如果 `quitAndInstall()` 后紧跟换行，后面 200 字内必须出现 响应/用户/click/confirm。renderer-stage-views.test.ts:71-76 要求 main 里的每个 updateState status 在 SecAbout 都有文案。
- 有 20 个测试文件在进程内调用 startMinisd，每个都用 mkdtemp 的独立根；auto-sync.test.ts:271-282 会在同一个根上 close 后重启。没有测试设置 DESKMINIS_STANDALONE，所以 standalone 分支是安装进程级钩子（崩溃处理、parentPort）的安全位置。tsconfig 的 include 是 src/**/* 和 tests/**/*，main、minisd、preload 都在 typecheck 内；main 与 minisd 在同一个 rollup 构建里（electron.vite.config.ts:10-15），paths.ts 是两者的共享 chunk。
- 借鉴来源：ZCode 的 DataRootLock 在 /home/user/refs/zcode/packages/zcode-server-cli/src/runtime/lock.ts（open 'wx' 写入 pid+ownerToken，经 .recovery 闸接管陈旧锁，pid===process.pid 视为存活，EPERM 视为存活）；pi 的 crash-log 在 /home/user/refs/pi-mono/packages/coding-agent/src/core/crash-log.ts（最多 5 条，7 天只在读取提示时生效，写入时不按天剔除）。基线：本机跑 ipc-contract、tray-lifecycle、auto-update 三个文件，18 例全绿。

## W1a-dbguard [M]
行为：【降级守卫】openDb 建连后先只读 user_version（放在 :193 设 WAL 之前）。如果大于 MIGRATIONS.length，先关连接，再抛 DbNewerThanAppError，字段为 {code:'DB_NEWER_THAN_APP', dbVersion, appVersion}，message 用中文。整个过程不写任何字节。
【迁移事务】每条迁移放进 db.transaction(()=>{exec; pragma user_version=v+1})() 执行。失败时整条回滚，user_version 不前进，连接上不留悬挂事务；openDb 失败时先 close 再抛。
【钉住历史迁移】MIGRATIONS 改为 export 的 Object.freeze readonly string[]，条目内容一个字不改，守卫钉住 [0..10] 的 sha256。
【minisd 上报】standalone 捕获到 code 属于 {DB_NEWER_THAN_APP, DATA_ROOT_LOCKED} 时，往 stdout 写一行 {"minisdFatal":{code,dbVersion,appVersion,dataRoot}}，在 write 的回调里 exit(1)。stderr 那一行照旧保留。
【主进程对话框】主进程识别这一行后，用 showMessageBox 弹框：
- type: error
- title:「DeskMinis 无法打开数据」
- message:「这份数据来自更新版本的 DeskMinis」
- detail:「数据库版本为 12，当前应用只支持到 11。为避免损坏你的会话和设置，本次没有打开它，也没有做任何改动。请安装最新版本后再启动。数据目录：<root>」
- 按钮只有 ['退出']，不给清空或重置，点后 app.quit()。
【通用失败路径】顺带把 stderr 末尾约 4KB 附进 showErrorBox，不再只显示「minisd 退出 code=1」。
改动点：
  - src/minisd/store/db.ts:4：`const MIGRATIONS: string[] = [` 改为 `export const MIGRATIONS: readonly string[] = Object.freeze([`，:189 同步收尾，条目本体零改动
  - src/minisd/store/db.ts 新增 `export class DbNewerThanAppError extends Error { readonly code = 'DB_NEWER_THAN_APP'; constructor(readonly dbVersion: number, readonly appVersion: number) }`
  - src/minisd/store/db.ts:191-203：拆出 `export function runMigrations(db, migrations = MIGRATIONS)`，逻辑为先判新旧，再逐条 `db.transaction(...)()`；openDb 在 new Database 之后先读版本并判新（放在 WAL 之前），再设 WAL 和 foreign_keys，再调 runMigrations；整体包 try/catch，失败时 db.close() 后 rethrow
  - src/minisd/index.ts:1229-1234 standalone 的 catch：识别 e.code 后 `process.stdout.write(JSON.stringify({minisdFatal:{...}})+'\n', () => process.exit(1))`
  - 新建 src/main/minisd-fatal.ts（不 import electron，便于测试）：parseMinisdFatal(line)、fatalDialogOptions(fatal)、class MinisdFatalError
  - src/main/index.ts:48-63 stdout 循环：先用 parseMinisdFatal 判断，命中就 settle(reject(new MinisdFatalError(f)))；:65 的 stderr 同时写进 4KB 环形缓冲
  - src/main/index.ts:222-228 catch 分支：MinisdFatalError 走 dialog.showMessageBox(fatalDialogOptions(...))，其余错误走 showErrorBox(message + stderr 尾部)
先红：
  - tests/db-newer-than-app.test.ts (a)：在临时目录建库，openDb 后 close；用裸 better-sqlite3 设 user_version=MIGRATIONS.length+1 后 close，记下 sha256(minis.db)。断言 `expect(() => openDb(file)).toThrow(expect.objectContaining({ code: 'DB_NEWER_THAN_APP' }))`，之后文件哈希不变。现在会红，因为 db.ts:196 的循环对 v≥length 直接跳过，openDb 正常返回。
  - tests/db-newer-than-app.test.ts (b)：对内存库调用 `runMigrations(db, [MIGRATIONS[0], 'CREATE TABLE t_ok(x); CREATE TABLE t_bad('])`，抛错后在同一连接上断言：db.inTransaction===false，sqlite_master 里没有 t_ok，user_version===1。现在会红：runMigrations 没有导出；即使导出，旧写法 BEGIN 后没有 ROLLBACK，同一连接上看得到 t_ok，inTransaction 也还是 true。
  - tests/db-migrations-immutable.test.ts：`import { MIGRATIONS }`，断言 length≥11 且 Object.isFrozen；对 i=0..10 断言 sha256(MIGRATIONS[i],'utf8') 等于 PINNED[i]（实现时算出后写死）；另加自证用例，给副本的 [3] 末尾加一个空格，哈希必须不同。现在会红，因为 MIGRATIONS 没有导出，拿到的是 undefined。
  - tests/minisd-fatal.test.ts：
- parseMinisdFatal 能解析 fatal 行，对普通日志行和握手行返回 undefined；
- parseHandshake 遇到 fatal 行仍返回 undefined；
- fatalDialogOptions({code:'DB_NEWER_THAN_APP',dbVersion:12,appVersion:11}) 的 buttons 深等 ['退出']，文本不匹配 /清空|删除|重置|覆盖/，并且包含「更新版本」和两个版本号；
- 源码守卫：main/index.ts 的 catch 分支里同时出现调用形态 `showMessageBox(` 和 `fatalDialogOptions(`。
现在会红，因为模块不存在。
守卫：
  - tests/workspace-picker.test.ts:38-46 读的是 db.ts 源文本，只检查 ALTER 的位置和它前面的内容。加 export/freeze 不影响，保持绿。
  - 六处 user_version=11 的钉（annotations-store:15、assistants-store:25、cron-store:17、db-migration6:36、workspace-picker:110/140/152、market-*-migration）：这次不加迁移，全部不受影响。
  - electron-builder.yml:2 注释里的红线「MIGRATIONS 零改动」：只加 export 和 freeze，条目不动，红线保持。
风险：
  - 这道守卫只对「装过 0.3.0 之后再回退」生效。已经装着 0.1.1 的用户打开 0.3.0 的库，照样拦不住。守卫必须随 0.3.0 发出去，发布说明要如实写明。
  - stdout 管道写完立即 exit 可能丢行。用 write 回调再 exit；万一丢了，主进程还有 exit code 加 stderr 尾部的通用对话框兜底。
  - 在 WAL 之前读 user_version 会给 WAL 库建出 -shm 文件，close 后应当清掉。所以哈希断言只对准主库文件，不数目录里的文件。
  - sha256 守卫也会被条目内的空白改动触发，这正是它的目的。失败文案要写清「只允许追加新迁移」。

## W1a-devdata [M]
行为：主进程只算一次目录，结果通过 fork env 显式下发（DESKMINIS_DATA_DIR / DESKMINIS_KEYRING_SERVICE / DESKMINIS_LOG_DIR），不改写 process.env。main 的 attachments:save 用同一个结果，不再调 dataRoot()。未打包时在日志里打一行「开发态数据根：…」。
【未打包，且没设 DESKMINIS_DATA_DIR】
- 数据根：%APPDATA%\DeskMinis-dev（Linux 下是 HOME/.config/DeskMinis-dev）
- userData：app.setPath 到同一个目录，和正式版在 Windows 上 userData≡数据根的布局一致
- keyring 服务名：'DeskMinis-dev'
【未打包，设了 DESKMINIS_DATA_DIR=X】
- 数据根：X，优先级不变
- userData：X/electron，每个临时根有独立的 Chromium 配置和单实例锁，driver 可以和开着的 dev 应用并存
- keyring 服务名：仍是 'DeskMinis-dev'
【打包态】
- 与现在完全相同：数据根 %APPDATA%\DeskMinis，不调 setPath，服务名 'DeskMinis'。
改动点：
  - 新建 src/main/app-dirs.ts（纯函数，不 import electron）：`resolveAppDirs({ isPackaged, env, appData, localAppData }) → { dataRoot, userData?: string, keyringService, logRoot, variant: 'prod'|'dev' }`
  - src/minisd/paths.ts:9-13：抽出 `defaultDataRoot(env, variant)`，复用同一套 APPDATA/HOME 回退。dataRoot() 对外行为不变，standalone 脚本仍默认用正式版的根。
  - src/main/index.ts 模块顶层（:14 之后，并且要早于任何 getPath('userData')、requestSingleInstanceLock 和 ready）：`const dirs = resolveAppDirs({...}); if (dirs.userData) app.setPath('userData', dirs.userData);`
  - src/main/index.ts:35：utilityProcess.fork 的 env 增加 DESKMINIS_DATA_DIR: dirs.dataRoot、DESKMINIS_KEYRING_SERVICE: dirs.keyringService、DESKMINIS_LOG_DIR: dirs.logRoot
  - src/main/index.ts:200：`dataRoot()` 改为 `dirs.dataRoot`（:5 的 import 相应调整）
  - src/minisd/store/provider-store.ts:38-42：KeyringVault 改为 `constructor(readonly service = 'DeskMinis')`，entry() 使用 this.service；新增 export `keyringServiceFromEnv(env)`，空白或缺省时返回 'DeskMinis'
  - src/minisd/index.ts:247：`new KeyringVault()` 改为 `new KeyringVault(keyringServiceFromEnv(process.env))`
  - 文档与脚本：
- scripts/e2e-acceptance.mjs:1-7 和 e2e-m2b-acceptance.mjs 的头注释补一句：要验 dev 数据，需同时设 DESKMINIS_DATA_DIR 和 DESKMINIS_KEYRING_SERVICE=DeskMinis-dev（脚本已经展开 process.env，不用改代码）；
- scripts/dry-run.mjs:17-19 找不到端口文件时，提示 dev 数据根的位置；
- deskminis-docs/docs/handoff/driver/README.md 记一笔：userData 现在落在 <DATA_DIR>/electron。
先红：
  - tests/app-dirs.test.ts：按「是否打包 × 是否设 DATA_DIR」四种组合断言。
- dev、无 env：dataRoot 以 DeskMinis-dev 结尾，userData===dataRoot，keyringService==='DeskMinis-dev'；
- dev、DATA_DIR=X：dataRoot===X，userData===join(X,'electron')；
- prod、无 env：dataRoot 与 paths.dataRoot() 同值，userData 为 undefined，服务名 'DeskMinis'；
- prod、DATA_DIR=X：dataRoot===X，userData 为 undefined。
现在会红，因为模块不存在。
  - tests/keyring-service.test.ts：new KeyringVault().service==='DeskMinis'；new KeyringVault('DeskMinis-dev').service==='DeskMinis-dev'（entry 懒加载，不会碰原生模块）；keyringServiceFromEnv({})==='DeskMinis'。现在会红，因为既没有 service 属性，也没有这个函数。
  - tests/main-app-dirs-wiring.test.ts（源码守卫，认调用形态）：
- 在 main/index.ts 里，`app.setPath('userData'` 的位置早于 `requestSingleInstanceLock(`，后者又早于 `app.whenReady(`；
- utilityProcess.fork 的 env 对象字面量里含 DESKMINIS_DATA_DIR 和 DESKMINIS_KEYRING_SERVICE；
- attachments:save 的处理体里不再有 `dataRoot()` 调用；
- minisd/index.ts 里出现 `new KeyringVault(keyringServiceFromEnv(`。
现在会红，因为这些都还不存在。
守卫：
  - tests/ipc-contract.test.ts:16-19：electron 桩缺 setPath，以及 W1b 要用的 requestSingleInstanceLock，import 时会 TypeError，整个文件 5 例翻红。需要同步给桩补上 `setPath: () => {}`、`requestSingleInstanceLock: () => true`、relaunch、exit。桩的注释（:14-15）已经有「桩跟着 index.ts 走」的先例。
  - tests/paths.test.ts 只测 MinisPaths，不受影响；dataRoot() 对外行为也不变。
  - tests/auto-update.test.ts:68 的 update-prefs 守卫不受影响。
风险：
  - 开发者本机的现有数据留在 %APPDATA%\DeskMinis，dev 首次启动会是空库。API key 存在 keyring 'DeskMinis' 下，复制目录也带不过去，只能重填。配对身份会在 'DeskMinis-dev' 下重新生成，dev 从此算另一台设备，已配对的设备要重配（这本来就是隔离的目的）。
  - e2e-acceptance 和 m2b 仍默认读正式版的根和正式 keyring，与 dev 应用看到的数据不是同一份，容易误判成「数据丢了」。
  - setPath 必须早于任何 getPath('userData')、requestSingleInstanceLock 和 ready。这是顶层代码的隐式顺序耦合，只能靠源码守卫钉住。
  - driver 用 `electron .` 跑 out/，app.isPackaged 也是 false，会走 dev 分支。设了 DATA_DIR 时只有 keyring 名和 userData 跟着变。
  - shell、MCP、终端这些子进程会继承到 DESKMINIS_DATA_DIR 等新变量。今天它们本来就继承完整 env；收窄子进程 env 属于 W1b 的其它分区。

## W1b-single [M]
行为：【主进程单实例锁】时机：W1a 的 setPath 之后、ready 之前，调 app.requestSingleInstanceLock()。
- 拿不到锁：app.quit()，并且 whenReady 体首行早退，不 fork minisd、不建窗口。
- 拿到锁：挂 second-instance。主窗口已存在时，isMinimized 就 restore，然后 show()、focus()，托盘隐藏的窗口也能唤出；窗口还没建时记个标志，createWindow 之后立即 show；正在退出（quitting）时忽略。
【minisd 数据根锁】位置：startMinisd 里 mkdirSync(root) 之后、openDb 之前，同步获取 <dataRoot>/minisd.lock。
- 获取：openSync(path,'wx',0o600)，写入 {pid, acquiredAt, ownerToken}。
- 遇到 EEXIST 就读锁：pid 存活（process.kill(pid,0) 成功、报 EPERM，或 pid===process.pid）时，抛 DataRootLockedError{code:'DATA_ROOT_LOCKED', pid, dataRoot}；pid 已不存在、内容损坏或空文件时，经 minisd.lock.recovery 闸接管。
- 释放：close() 最后一步按 ownerToken 删锁，幂等；拿锁之后装配过程中任何一步失败，都先释放再抛。
【主进程对话框】走 W1a 的 fatal 通道：
- 标题：「DeskMinis 已在运行」
- 正文：「另一个 DeskMinis（进程 <pid>）正在使用数据目录 <root>。请先从托盘退出它，再重新打开。」
- 按钮：只有「退出」
改动点：
  - src/main/index.ts 顶层（紧跟 W1a 的 setPath）：`const gotLock = app.requestSingleInstanceLock(); if (!gotLock) app.quit(); else app.on('second-instance', () => {...})`
  - src/main/index.ts:8 附近新增模块级 `let mainWindow: BrowserWindow | undefined`，:216 处赋值；:206 whenReady 回调首行加 `if (!gotLock) return;`
  - 新建 src/minisd/store/data-root-lock.ts：同步版 DataRootLock，提供 acquire/release/inspect，思路借自 ZCode runtime/lock.ts。许可证是 Apache-2.0，要在文件头署名并登记 THIRD-PARTY-NOTICES。
  - src/minisd/index.ts:233-235 之间插入 `const lock = acquireDataRootLock(root)`，把 :235 起的整段装配包进 try，catch 里 `lock.release(); throw e`
  - src/minisd/index.ts:1208-1215：close() 的最后一步调 lock.release()
  - src/minisd/index.ts:1229 standalone 的 catch 与 W1a 共用 fatal 行，加上 DATA_ROOT_LOCKED；src/main/minisd-fatal.ts 增加这条的中文文案
  - 跨分区提醒：W1b 数据根写入收窄（tools/files.ts:27-32）需要把 minisd.lock 和 minisd.lock.recovery 列入禁止写、禁止删
先红：
  - tests/data-root-lock.test.ts：
(a) 同一个根连续 acquire 两次，第一把不释放（pid===process.pid 算存活），第二次抛 code 'DATA_ROOT_LOCKED' 并带 pid；
(b) 先写 {pid: 一个已退出子进程的 pid}（spawn process.execPath -e '' 并等它退出），acquire 成功，锁文件里的 pid 变成 process.pid；
(c) 空文件和坏 JSON 都能被接管；
(d) release 只删 ownerToken 相同的锁。
现在会红，因为模块不存在。
  - tests/data-root-lock-minisd.test.ts（进程内，DESKMINIS_TEST=1）：第一个 startMinisd({dataDir}) 不 close，第二个同 dataDir 的 startMinisd 应以 code DATA_ROOT_LOCKED reject；first.close() 之后再起同一个根能成功。现在会红：第二个实例今天能完整起来，端口会退回随机（index.ts:129-139）。
  - tests/single-instance.test.ts（源码守卫）：
- main/index.ts 里 `requestSingleInstanceLock(` 出现在 `app.whenReady(` 之前；
- 拿锁失败的分支调用 `app.quit(`；
- `on('second-instance'` 的处理体含 `.show()`、`.focus()` 和 `restore()`；
- whenReady 回调的开头有 gotLock 早退。
现在会红，因为这些都零命中。
守卫：
  - tests/ipc-contract.test.ts:16-19：桩要补 `requestSingleInstanceLock: () => true`，否则 import 时 TypeError，整个文件翻红。
  - tests/bridge-minisd.test.ts:88-91 的「占管」用例用 net.Server 占住管道，占的不是 minisd，不受锁影响。
  - tests/auto-sync.test.ts:271-282 和 convergence-pause 在同一个根上 close 后重启，依赖 close() 释放锁，必须保证 release 在 close 里执行且幂等。
风险：
  - Windows 会复用 pid。如果陈旧锁里的 pid 恰好被别的进程占了，会误判为存活而拒绝启动。本版接受，对话框里写明锁文件路径；W6a 可以加本根的桥命名管道 bridgePipePath 探活，作为第二个判据。
  - scripts/e2e-acceptance.mjs:4-5 和 e2e-m2b 的设计本身就是「应用开着时另起 minisd 共用真实库」。加锁后，只要应用开着它们就会以 exit 1 失败。要改头注释和失败提示：先退出应用，或者改用 DESKMINIS_DATA_DIR 临时根。dry-run.mjs 只连不起，不受影响。
  - Electron 的单实例锁按 userData 算。如果 W1a-devdata 不为 DATA_DIR 分出独立的 userData，dev 应用开着时 driver 会被当成第二实例秒退，playwright launch 等到 45s 超时，报错也看不出原因。
  - 即使 requestSingleInstanceLock 失败后调了 app.quit()，ready 仍可能触发。whenReady 体必须早退，否则第二个实例照样 fork minisd（会被数据根锁拦下，但会多弹一个框）。
  - dev 与正式版的数据根不同，彼此的锁互不干扰；如果被手动指向同一个根，由数据根锁兜住，这正是需要第二道闸的原因（Electron 锁按 userData 算，挡不住这种情况）。

## W1b-delete [M]
行为：chat.sessions.delete 改成 async，依次做：
1. 校验 confirm。
2. 如果会话在 inFlight：把它挂起的权限请求全部按 deny 了结（广播 permission.resolved，reason 为 'session-deleted'，并写审计）→ controller.abort('session-deleted') → await 这个会话的 run 完成 promise，上限 10 秒。超时就不删，抛「会话仍在停止中，请稍后再删」。
3. run 结束后：terminals.dispose(sessionId) → shells.dispose(sessionId) → chat.deleteSession → 广播 chat.sessions.changed。

另外三处配合：
- chat.prompt 在 inFlight.add 时就登记完成 promise，覆盖 :678 ensureForRun 那段 await 窗口；ensureForRun 返回后如果已被 abort，就不落 user 消息，清理后抛「会话已取消」。
- 被删除打断的 run，runErr 记为「会话已删除」，定时任务的 last_status 不再误记为 ok。
- 渲染端对 reason 不是 timeout 的 permission.resolved 只移除卡片（chat.ts:165-170），不用改。
改动点：
  - src/minisd/index.ts:404-405 旁新增 `const runs = new Map<string, Promise<void>>()`，和 inFlight 同生同灭
  - src/minisd/index.ts:673-675：inFlight.add 时建一个 deferred，runs.set(sessionId, promise)；:752-758 的 finally 里 resolve 它，并 runs.delete
  - src/minisd/index.ts:678 与 :691 之间插入：`if (controller.signal.aborted) { inFlight.delete(sessionId); controllers.delete(sessionId); settle(); throw new Error('会话已取消'); }`
  - src/minisd/index.ts:281 旁新增 `denyPendingPerms(filter: sessionId | 'all', reason)`：逐个 clearTimeout、delete、resolve('deny')、broadcast 并写审计。close() 和 delete 共用它，chat.cancel 可选复用。
  - src/minisd/index.ts 新增 `stopRun(sessionId, timeoutMs): Promise<boolean>`（先 deny，再 abort，再 await 与超时 race），delete 和 close 共用
  - src/minisd/index.ts:517-522：改写为 async 版本，流程如上
  - src/minisd/tools/shell.ts:173-177：ShellManager 增加 `dispose(sessionId)`。这和 W1b 的 killTree 项改的是同一个文件，需要协调。
  - src/minisd/index.ts:743-751 的 catch 和 finally：如果 controller.signal.reason==='session-deleted'，把 runErr 设为「会话已删除」
先红：
  - tests/session-delete-running.test.ts（进程内 startMinisd，DESKMINIS_TEST=1、DESKMINIS_FAKE_PROVIDER=1，permTimeoutMs 设 60000）：
- 步骤：发 chat.prompt，文本为 `__tool__ file_write {"path":"<mkdtemp 外部绝对路径>/x.txt","content":"x","tool_title":"t"}` → 等到 permission.request 通知 → 调 chat.sessions.delete {confirm:true} → 再对这个 requestId 调 permission.respond allow-once → 等 300ms。
- 断言：x.txt 不存在；close 后用 better-sqlite3 直读 minis.db，该会话的 messages 行数为 0；收到过 reason 为 'session-deleted' 的 permission.resolved。
- 现在会红：删除既不唤醒权限也不 abort，respond 之后工具照样写文件，loop.ts:567 还会把 toolResult 写进已删会话，留下孤儿行。
  - 同一文件的第二例：让 chat.prompt 停在 ensureForRun（index.ts:678），做法是种一台连不上的 MCP，它有约 2s 的启动超时；期间删除会话，断言删完后该会话的 messages 行数为 0。如果这个时序在 CI 上不稳，退一步用源码守卫：在 ensureForRun 之后、appendMessage(role:'user') 之前出现 `signal.aborted` 判断。
守卫：
  - tests/rpc.test.ts:87-93（缺 confirm 报错）和 :190（非法 id 报错）：行为不变，保持绿。
  - tests/terminal.test.ts:115-125（删会话时销毁终端）：顺序改成 run 结束后再 dispose，断言不变。
  - tests/mu6-capability-wiring.test.ts:72 只认 RPC 名，不受影响；stores/chat.ts:268-277 的 deleteSession 调用形态也不变。
风险：
  - 删除现在可能要等 run 收尾，最坏 10 秒。NavRail.vue:54-57 的 onDelete 没有 try/catch，也没有进行中状态，超时报错会变成未处理的 rejection，界面看起来就是点了没反应。需要渲染端分区补上错误展示和删除中状态（.vue 改动要配守卫和 xvfb 目视）。
  - 不理会 abort 的工具（部分 MCP 调用）会把等待拖满上限。
  - chat.prompt 不校验会话是否存在（:582-583），对已删的 id 再发 prompt 仍会写孤儿消息。本项不改，记为已知风险。

## W1b-quit [M]
行为：【主进程】
- before-quit：quitting=true。如果 minisd 活着且还没停过，就 preventDefault，立即隐藏所有窗口、销毁托盘图标（用户马上看到已退出），然后 `stopMinisdGracefully(5000)`：postMessage({type:'shutdown'})，等 'exit'；5 秒内没退就 kill()。结束后置 minisdStopped，再调 app.quit()，第二次 before-quit 直接放行。
- 如果 minisd 已经先崩了（记录过 exit），不再等待。
- 更新弹框里点「重启并安装」时：quitting=true → await stopMinisdGracefully(5000) → minisdStopped=true → autoUpdater.quitAndInstall()。这样安装器在 minisd 退出之后才 spawn。
【minisd】
- standalone 分支保留 startMinisd 的返回值，`process.parentPort?.on('message')` 收到 shutdown 后调 inst.close({graceMs:3000})，finally 里 process.exit(0)。SIGINT/SIGTERM 可选走同一路径。
- close() 的新顺序：
  1. 置 closing，此后 chat.prompt 和 runCronJob 拒绝，提示「后台正在关闭」；
  2. 停同步和调度器；
  3. denyPendingPerms('all','shutdown')；
  4. abort 全部；
  5. await Promise.race([allSettled(runs), delay(graceMs)])；
  6. 销毁终端、shell、MCP，关 bridge 和 rpc；
  7. db.close()；
  8. 释放数据根锁。
  整个 close 幂等，重复调用复用同一个 promise。
改动点：
  - src/main/index.ts:17 旁：新增 `MINISD_STOP_TIMEOUT_MS = 5000` 和 `async function stopMinisdGracefully(timeoutMs)`，内部用 postMessage、once('exit')、setTimeout 后 kill()，并复用 stopping promise 保证幂等
  - src/main/index.ts:66 之后：新增常驻 'exit' 监听，置 minisdExited；不在退出流程中时交给 W2b 记崩溃
  - src/main/index.ts:230 before-quit：按上面的流程改写
  - src/main/index.ts:144：改为 `.then(async r => { if (r.response === 1) { quitting = true; await stopMinisdGracefully(MINISD_STOP_TIMEOUT_MS); minisdStopped = true; autoUpdater.quitAndInstall(); } })`，保持 `quitAndInstall();` 和 `}` 在同一行
  - src/main/index.ts:226：握手前的启动失败分支仍然直接 kill，不走优雅停
  - src/minisd/index.ts:1206-1216：按上面的顺序重写 close，签名改为 `close(opts?: { graceMs?: number })`
  - src/minisd/index.ts:1225-1228：standalone 改为 `.then(inst => { 写握手行; process.parentPort?.on('message', e => { if (e?.data?.type === 'shutdown') void inst.close({ graceMs: 3000 }).finally(() => process.exit(0)); }); })`
  - src/minisd/index.ts:582（chat.prompt 入口）和 :1131（runCronJob 入口）加 closing 判断
先红：
  - tests/shutdown-partial-reply.test.ts (a)，进程内：
- 步骤：让 FakeProvider 触发一次需要权限的 file_write，等到 permission.request 后调 close()。
- 断言：close 在 5 秒内 resolve；用 better-sqlite3 重开 minis.db，该会话里有 assistant(toolUse)，紧跟一条 user(toolResult)，内容为 '[已取消]'、success=false；再用 startMinisd 起同一个根能成功（锁已释放）。
- 现在会红：旧 close 只 clearTimeout 不 resolve（index.ts:1211-1212），run 永远卡在权限上，toolResult 从没落库。
  - tests/shutdown-partial-reply.test.ts (b)，流中途关停：
- 步骤：测试里用 node:http 起一个假的 OpenAI 兼容 SSE 服务（先发一个「半截」delta 然后挂住），经 provider.instances.create 建一个 ollama 类 provider 指向它；收到 textDelta 后调 close()。
- 断言：重开库后有 stream_interrupt_count=1 且文本含「半截」的 assistant 消息；同时计数 process 的 unhandledRejection 和 'database connection is not open'，都为 0。
- 这一例在旧实现下是竞态，可能偶然通过，只当回归网，不作为先红证据。
  - tests/main-shutdown-wiring.test.ts（源码守卫）：
- before-quit 的处理体里调用了 `preventDefault()` 和 `stopMinisdGracefully(`；
- stopMinisdGracefully 体内有 `.postMessage(` 且带 'shutdown'，有 `.kill()` 兜底，超时常量不超过 5000；
- update-downloaded 回调里 `await stopMinisdGracefully(` 出现在 `autoUpdater.quitAndInstall(` 之前；
- minisd/index.ts 的 standalone 分支有 `parentPort` 的 'message' 监听，并调用 `.close(`。
- 现在会红：before-quit 里只有 kill，:1225-1228 把 close 丢掉了。
守卫：
  - tests/tray-lifecycle.test.ts:33-49 要求 before-quit 体内字面含 `minisd?.kill()`，改完必然翻红。需要重指为「before-quit 调 stopMinisdGracefully，helper 里有 kill() 兜底」，并在提交说明里逐条申报。
  - tests/auto-update.test.ts:55 的负向正则：只要让 `quitAndInstall();` 和收尾的 `}` 留在同一行就不会触发；如果它独占一行，后面 200 字内必须出现 响应/用户/click/confirm。
  - tests/ipc-contract.test.ts:16-26：before-quit 用的是 app.on，桩里已有，不受影响。
  - 所有进程内测试的 afterEach close()：新 close 最多多等 graceMs（3 秒），仍在 vitest 默认 hookTimeout 10 秒之内。卡在权限上的用例现在会被 deny 放行，反而收尾得更快。
风险：
  - Windows 注销或关机时不会触发 before-quit（Electron 文档写明），这条路径仍是硬杀，只能靠 WAL 保底。
  - graceMs（3 秒）要小于主进程的上限（5 秒），留 2 秒给 db.close 和 WAL checkpoint；超过 5 秒仍会被 kill，半截回复可能丢。
  - 退出窗口期内用户又双击图标：旧进程还拿着单实例锁，会收到 second-instance。处理器在 quitting 时必须忽略，否则会把正在退出的窗口重新唤出来。
  - electron-updater 的 NSIS 安装器会等待或强杀同名进程，utilityProcess 和主进程是同一个 exe。先停 minisd 可以避免 MCP 子进程被连带硬杀。
  - electron-vite dev 自己也会杀 electron，优雅停止的效果只能在打包版和 driver（electron .）下验证。

## W2b-crashlog [M]
行为：【目录】
- logRoot 由主进程经 DESKMINIS_LOG_DIR 下发；
- 设了 DESKMINIS_DATA_DIR 时为 <DATA_DIR>/logs；
- 否则为 %LOCALAPPDATA%\DeskMinis\logs（dev 为 DeskMinis-dev）；
- 非 Windows 回退到 HOME/.local/state/DeskMinis[-dev]/logs。
crashes.json 放在 <logRoot>/crashes.json。数据根锁不覆盖日志目录；单实例锁加上 dev/prod 分目录，基本保证只有一个写者。日志目录不在数据根，所以不进设备同步和漫游，也不在 W1b 写闸和将来备份的范围内。
【crashes.json】
- 格式：数组，每条为 {timestamp, version, process:'main'|'minisd', kind:'uncaught_exception'|'unhandled_rejection'|'minisd_exit', message, stack|null, exitCode?, stderrTail?}。
- 写入：读出 → 丢掉超过 7 天的 → 追加 → 只留最新 5 条 → 写 tmp 后 rename 原子替换。
- 容错：坏文件当空处理；写失败一律静默，崩溃路径上不能再抛。
【主进程钩子】放在 whenReady 首行（或模块顶层，但只在 process.versions.electron 存在且没有 ELECTRON_RUN_AS_NODE 时）：
- uncaughtException：记录，再 showErrorBox，与 Electron 默认一样可见，然后继续运行；
- unhandledRejection：只记录；
- minisd 握手之后、不在退出流程中的 exit（code≠0）：记一条 minisd_exit，附 stderr 环形缓冲的末尾 4KB。
【minisd 钩子】只装在 standalone 分支：
- uncaughtException：同步记录后 process.exit(1)，保持会崩的语义；
- unhandledRejection：记录后继续。今天 Node 默认会 throw，直接打死引擎，界面永远停在运行中。
【按天日志】
- 主进程把 minisd 的 stdout 非握手行（main:60）和 stderr（main:65，改为按行切分）写入 <logRoot>/minisd-YYYY-MM-DD.log；
- 按本地日期分文件，每行前加 ISO 时间；另外写主进程自己的生命周期行：fork、握手端口、shutdown 请求、exit code；
- 启动时删掉超过 7 天的文件；单日超过 10MB 后停写，并记一行截断说明；
- 只落本地。
改动点：
  - 新建 src/minisd/diag/crash-log.ts：recordCrash(rec, path, now)、readCrashLog(path)，纯 fs 实现。放在 minisd 侧，因为 main 已经 import ../minisd/paths，两端可以共用，且不依赖 electron。
  - 新建 src/minisd/diag/daily-log.ts：class DailyLog，提供 append(line, now)、prune(now, keepDays)，内置大小上限
  - src/main/app-dirs.ts（与 W1a-devdata 同一个函数）给出 logRoot
  - src/main/index.ts:60 与 :65：转发的同时调用 minisdLog.append；:65 改为按行切分
  - src/main/index.ts:66 之后：常驻 exit 监听，记 minisd_exit（与 W1b-quit 共用）
  - src/main/index.ts:206：whenReady 回调首行调用 installMainCrashHandlers(dirs.logRoot)
  - src/minisd/index.ts:1220：standalone 分支首行调用 installMinisdCrashHandlers(logRootFromEnv(process.env))
  - 版本号：主进程用 app.getVersion()，经 env DESKMINIS_APP_VERSION 下发给 minisd
先红：
  - tests/crash-log.test.ts（注入 now，结果确定）：
- 连写 7 条后文件只剩最新 5 条，顺序正确；
- 预置一条 8 天前的记录再写一条，旧记录被剔除；
- 坏 JSON 当空处理，写入成功；
- 把一个普通文件当目录传进去，返回 undefined，不抛。
现在会红，因为模块不存在。
  - tests/daily-log.test.ts：
- 同一天两次 append 落在同一个文件；
- now 加一天后落到新文件；
- prune 删掉 8 天前的文件，保留 6 天内的；
- 超过大小上限后只追加一次截断说明。
现在会红，因为模块不存在。
  - tests/crash-log-wiring.test.ts（源码守卫）：
- main/index.ts 的 `process.on('uncaughtException'` 和 `'unhandledRejection'` 只能出现在 installMainCrashHandlers 函数体里，并且 whenReady 回调调用了它，不许在模块顶层裸挂；
- minisd/index.ts 的同名钩子只在 `DESKMINIS_STANDALONE === '1'` 分支里，startMinisd 体内零命中；
- main 的 stdout/stderr 转发处出现 `.append(` 调用。
现在会红，因为这些都零命中。
守卫：
  - tests/ipc-contract.test.ts:36 会 import main/index.ts。如果钩子挂在模块顶层，就会装进 vitest worker，吞掉测试框架自己的未捕获异常，还会往开发机真实的 LOCALAPPDATA 写 crashes.json。所以钩子必须放进 whenReady，或者加 ELECTRON_RUN_AS_NODE 判断。
  - 20 个进程内 startMinisd 测试：钩子不能装进 startMinisd，只能装在 standalone 分支。
  - tests/rpc.test.ts:148-154 自己挂 uncaughtException 的用例不受影响。
风险：
  - 日志里有路径和错误原文，可能夹带用户内容，或 provider 返回的错误原文（含 URL）。现在只落本地、不上传；W6a 做诊断包导出时要脱敏，可参照 pi 的 SENSITIVE_KEY 做法。
  - main 和 minisd 同写 crashes.json，读改写之间理论上可能丢一次更新。崩溃本来就罕见，可以接受；tmp 加 rename 保证文件本身不会坏。
  - minisd 平时几乎不输出，日志的价值主要在启动失败和崩溃栈。要看运行期状况，得另外加日志行。
  - unhandledRejection 改成「记录后继续」是语义变化，可能掩盖状态不一致，需要拍板（见待决问题）。
  - LOCALAPPDATA 下的目录卸载时不会删除，这与 deleteAppDataOnUninstall:false 的取向一致。

## W2b-guards [S]
行为：【新开窗口】setWindowOpenHandler：URL 协议是 http:、https: 或 mailto: 时交给 shell.openExternal(url)，失败静默；无论什么情况都返回 {action:'deny'}，永远不新开 Electron 窗口。
【页内导航】will-navigate：目标和应用自身 URL 不一致就 preventDefault。自身 URL 在 dev 下是 ELECTRON_RENDERER_URL 的 origin，打包后是 out/renderer/index.html 的 file URL（去掉 hash 和 query 后全等比较）。被拦下的如果是 http/https/mailto，再交给 openExternal。顺带修掉一个潜在缺陷：今天把文件拖到输入区以外，file:// 导航会把整个界面替换掉。
【权限白名单】ALLOWED = ['clipboard-sanitized-write']。依据是全树只用到 navigator.clipboard.writeText；paste 事件不走权限。
- setPermissionRequestHandler：(wc, p, cb) => cb(ALLOWED.has(p) && isAppUrl(wc.getURL()))
- setPermissionCheckHandler：(wc, p, origin) => ALLOWED.has(p) && isAppOrigin(origin)
- 其余一律拒绝：notifications、media、fullscreen、geolocation、clipboard-read、openExternal、midi、pointerLock 等。
改动点：
  - 新建 src/main/nav-guard.ts（纯函数）：EXTERNAL_PROTOCOLS、ALLOWED_PERMISSIONS、isExternalSafe(url)（用 new URL 解析，解析失败返回 false）、isAppUrl(url, appBase)
  - src/main/index.ts:85-96 createWindow：在 loadURL/loadFile 之前注册 `win.webContents.setWindowOpenHandler(...)` 和 `win.webContents.on('will-navigate', ...)`；appBase 取 `process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname,'../renderer/index.html')).href`
  - src/main/index.ts:206 whenReady：在 createWindow 之前设置 session.defaultSession 的两个 handler
  - src/main/index.ts:1：import 增加 shell 和 session
先红：
  - tests/main-window-guard.test.ts，纯函数部分：
- isExternalSafe 对 'https://a.b' 和 'mailto:x@y' 返回 true；
- 对 'javascript:alert(1)'、'file:///C:/x'、'data:text/html,x'、'deskminis://x' 和坏 URL 返回 false；
- isAppUrl 在 dev 和 prod 下各有正反例，带 #hash 算同页；
- ALLOWED_PERMISSIONS 深等 ['clipboard-sanitized-write']。
  - tests/main-window-guard.test.ts，源码守卫部分：
- main/index.ts 出现 `setWindowOpenHandler(`，它的处理体里只有 `action: 'deny'`，不含 'allow'；
- `'will-navigate'` 的处理体含 `preventDefault()`；
- 出现 `setPermissionRequestHandler(` 和 `setPermissionCheckHandler(`；
- 全文件不匹配 /\b(cb|callback)\(\s*true\s*\)/。
现在会红，因为这些全部零命中。
守卫：
  - tests/preload-wiring.test.ts:30 用 /preload\/([\w.]+)'/ 抽取引用名，新增的 import 不含这个模式，不受影响。
  - tests/ipc-contract.test.ts 的 electron 桩：session 和 shell 只在处理器里访问，import 时不会触发；如果在顶层读 session.defaultSession，就要补桩。
  - tests/markdown-xss.test.ts：渲染端的白名单不变，不受影响。
风险：
  - 如果 Electron 38 的 writeText 真的走 'clipboard-sanitized-write' 请求，而白名单写错了，复制代码和复制路径会静默失败：MarkdownView.vue:17 和 PreviewPane.vue:75 都是 catch 后什么也不提示。必须在 xvfb 下实测。
  - dev 下 HMR 的整页刷新是 reload，不会触发 will-navigate；origin 比较必须用 ELECTRON_RENDERER_URL 的实际值，不能写死端口。
  - 没有默认邮件客户端的机器上，对 mailto: 调 shell.openExternal 会 reject，要 catch 后静默。

## W2b-relaunch [S]
行为：【preload】新增 relaunchApp(): Promise<void>，内部调 ipcRenderer.invoke('app:relaunch')。
【main】ipcMain.handle('app:relaunch')：
1. 校验 event.sender 是 mainWindow.webContents，不是就抛错；
2. quitting = true；
3. 调 app.relaunch()。portable 版传 { execPath: process.env.PORTABLE_EXECUTABLE_FILE }，否则会重启到解压出来的临时副本；
4. 调 app.quit()，不用 app.exit()，这样会走 before-quit 的优雅停；minisd 已经死了的话立即放行。
新实例在旧实例退出后才启动，那时单实例锁和数据根锁都已释放；如果是 kill 兜底留下的陈旧锁，按 pid 接管。
【渲染端（另一个分区）】断线横幅的「重启应用」按钮用调用形态 `.relaunchApp(` 接入。
改动点：
  - src/preload/index.ts:31 之后：`relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),`
  - src/main/index.ts:177 旁：新增 `ipcMain.handle('app:relaunch', (e) => {...})`
  - 渲染端分区：src/renderer/src/rpc.ts 的 onclose 横幅按钮调用 `(window as any).deskminis.relaunchApp()`，对应的守卫也按调用形态写
先红：
  - tests/app-relaunch.test.ts（源码守卫）：
- preload 里有 `relaunchApp` 和 `ipcRenderer.invoke('app:relaunch')`；
- main 里有 `ipcMain.handle('app:relaunch'`；处理体中 `app.relaunch(` 出现在 `app.quit()` 之前，不含 `app.exit(`，并且引用了 PORTABLE_EXECUTABLE_FILE。
- 现在会红，因为这些都零命中。
- 另外，ipc-contract.test.ts:73-81 会自动检查 invoke 和 handle 是否成对：只加了 preload 却漏了 main，它就会红。
守卫：
  - tests/ipc-contract.test.ts:72-81 会自动覆盖新通道，这是正向保护。
  - tests/renderer-composer.test.ts:68-72 只断言 attachments:save 存在，不计 handler 数量，不受影响。
风险：
  - electron-vite dev 下，relaunch 出来的新进程脱离了 dev server 的父进程；dev server 可能跟着旧进程一起退出，新窗口会白屏。只影响开发态。
  - 如果 minisd 其实还活着、只是 WS 断了，点重启会走满 5 秒的优雅停，用户会觉得点了重启要等好几秒。
  - playwright 驱动时进程被替换，driver 拿不到新窗口，要改用截屏加 ps 验证。

## open_questions
- Q: 崩溃记录和按天日志放在哪：%LOCALAPPDATA%，还是数据根下的 logs/（或 matrix.md:469 写的 userData/crashes.json）？
  推荐: 正式版放 %LOCALAPPDATA%\DeskMinis\logs\minisd-YYYY-MM-DD.log，crashes.json 放在同一 logs 目录；dev 放 DeskMinis-dev；设了 DESKMINIS_DATA_DIR 时放 <DATA_DIR>/logs。
  理由: 数据根在 Roaming 下，index.ts:158-166 已经承认它会被域漫游或 OneDrive 同步；而且在 Windows 上 userData 和数据根是同一个目录，写 userData 等于写数据根。日志不该跟着漫游，也不该进入 W1b 数据根写闸和将来备份打包的范围。放在 LOCALAPPDATA 还与数据根锁、设备同步互不相干。roadmap.md:75 的范围写的也是 LOCALAPPDATA。
- Q: 开发态数据隔离（DeskMinis-dev，keyring 加 -dev）是否执行？roadmap.md:38 标了「需用户点头」，拍板项 5 的默认是隔离。
  推荐: 隔离，但不写 keyring 搬运脚本。在 README 或交接文档里写清手工迁移步骤：复制目录、在设置里重填 API key、重新配对设备。
  理由: 现在 dev 和正式版共用同一个库、同一个 keyring 槽，包括配对身份和搜索 key 的单槽，npm run dev 可以把正式库迁移到正式版不认识的新版本。有了 DB_NEWER 守卫也只是「打不开」，拦不住数据被改。搬运 keyring 需要枚举已知的槽名，收益小，还容易误伤。
- Q: 设了 DESKMINIS_DATA_DIR 时，userData 要不要跟着移到 <DATA_DIR>/electron？
  推荐: 未打包时跟着移，打包态不动。
  理由: Electron 单实例锁按 userData 算。不移的话，dev 应用开着时 driver 会被当成第二实例秒退，playwright launch 等到 45s 超时，报错也不直观；driver 之间也不能并行。打包态动 userData 会丢用户已保存的主题（localStorage）和 update-prefs。
- Q: minisd 里的 unhandledRejection：记录后继续运行，还是记录后退出（Node 默认的 throw 语义）？
  推荐: unhandledRejection 记录后继续；uncaughtException 记录后 exit(1)。主进程这边，uncaughtException 记录后照 Electron 默认弹 showErrorBox 并继续，unhandledRejection 只记录。
  理由: 今天任何一个漏网的 rejection 都会打死引擎，而渲染端要到 W2b 才有断线横幅，W6a 才有重启。rejection 通常只影响局部；uncaughtException 之后的进程状态不可信，应该保持会崩的语义。
- Q: scripts/e2e-acceptance.mjs 和 e2e-m2b 的设计是「应用开着时另起 minisd 共用真实库」，加数据根锁后会被拒绝。要不要给它们留绕过开关？
  推荐: 不留。改头注释和失败提示：要么先从托盘退出应用，要么用 DESKMINIS_DATA_DIR 临时根。
  理由: 绕过开关会重新打开「两个 minisd 同写一个库」的口子，而这正是 A 组第 7 条缺陷。这两个脚本手动运行、频率很低。
- Q: 删除运行中的会话时，等 run 收尾超时（例如 10 秒）之后怎么处理？
  推荐: 不删，报错「会话仍在停止中，请稍后再删」。渲染端分区在 NavRail 补上 try/catch 和删除中状态。
  理由: 超时后硬删，晚到的 toolResult 或 user 消息会写成孤儿行，还可能继续往外写文件，正好违反验收里「不再向已删会话写消息」那一条。
- Q: DB_NEWER_THAN_APP 对话框除了「退出」，要不要加「打开数据目录」？
  推荐: 只给「退出」，数据目录的路径写在 detail 文本里。
  理由: 路线要求不给清空按钮。打开目录会诱导用户手工删库或换库；把路径以文字给出，已经足够指导高级用户。
- Q: Windows 复用 pid 可能让陈旧锁被误判为存活，要不要在本版就加第二判据？
  推荐: 本版接受这个风险，对话框里写明锁文件路径。W6a 再用本根的桥命名管道（bridgePipePath）探活，作为第二判据。
  理由: 要可靠核对进程身份，需要进程启动时间或句柄；零依赖做起来复杂，而误判的概率很低。命名管道由操作系统在进程死亡时自动释放，适合做第二判据，但改动更大。
- Q: 断线横幅上的「重启」是重启整个应用，还是只重启 minisd？
  推荐: 本版重启整个应用（app.relaunch 加 quit），引擎级重启留给 W6a 的 launcher 和崩溃预算。
  理由: 渲染端的 rpc.ts 没有重连和代次（W6b 才重写），只重启 minisd 的话，界面状态和新引擎对不上；整应用重启最简单，也最诚实。

## files
- /home/user/Deskminis/deskminis/src/minisd/store/db.ts
- /home/user/Deskminis/deskminis/src/minisd/index.ts
- /home/user/Deskminis/deskminis/src/minisd/paths.ts
- /home/user/Deskminis/deskminis/src/minisd/store/provider-store.ts
- /home/user/Deskminis/deskminis/src/minisd/tools/shell.ts
- /home/user/Deskminis/deskminis/src/minisd/store/data-root-lock.ts（新建）
- /home/user/Deskminis/deskminis/src/minisd/diag/crash-log.ts（新建）
- /home/user/Deskminis/deskminis/src/minisd/diag/daily-log.ts（新建）
- /home/user/Deskminis/deskminis/src/main/index.ts
- /home/user/Deskminis/deskminis/src/main/app-dirs.ts（新建）
- /home/user/Deskminis/deskminis/src/main/minisd-fatal.ts（新建）
- /home/user/Deskminis/deskminis/src/main/nav-guard.ts（新建）
- /home/user/Deskminis/deskminis/src/preload/index.ts
- /home/user/Deskminis/deskminis/tests/ipc-contract.test.ts（electron 桩补 setPath/requestSingleInstanceLock/relaunch/exit）
- /home/user/Deskminis/deskminis/tests/tray-lifecycle.test.ts（before-quit 守卫重指）
- /home/user/Deskminis/deskminis/tests/db-newer-than-app.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/db-migrations-immutable.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/minisd-fatal.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/app-dirs.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/keyring-service.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/main-app-dirs-wiring.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/data-root-lock.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/data-root-lock-minisd.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/single-instance.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/session-delete-running.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/shutdown-partial-reply.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/main-shutdown-wiring.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/crash-log.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/daily-log.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/crash-log-wiring.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/main-window-guard.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/app-relaunch.test.ts（新建）
- /home/user/Deskminis/deskminis/scripts/e2e-acceptance.mjs（头注释与失败提示）
- /home/user/Deskminis/deskminis/scripts/e2e-m2b-acceptance.mjs（头注释与失败提示）
- /home/user/Deskminis/deskminis/scripts/dry-run.mjs（dev 数据根提示）
- /home/user/Deskminis/THIRD-PARTY-NOTICES.md（登记 ZCode DataRootLock、pi crash-log 来源）
- /home/user/deskminis-docs/docs/handoff/driver/README.md（userData 落 <DATA_DIR>/electron、数据根锁说明）

## xvfb
- DB_NEWER_THAN_APP：在临时根里放一个 user_version=99 的 minis.db，用 DESKMINIS_DATA_DIR 指向它启动应用。截原生对话框，确认标题和说明是中文、只有「退出」一个按钮；点击后进程退出，库文件哈希不变。
- DATA_ROOT_LOCKED：先用 ELECTRON_RUN_AS_NODE 起一个 standalone minisd 占住临时根，再启动应用。截对话框，确认文案带进程号和数据目录，只有「退出」。
- 单实例：启动后点 × 隐藏到托盘，再次启动同一个应用。第一个实例的窗口应被唤到前台，第二个进程秒退，ps 里只剩一组进程。
- 断线横幅「重启应用」：kill 掉 minisd 后点这个按钮，旧进程应退出、新窗口出现。playwright 会丢失进程，改用 import -window root 截屏加 ps 验证。
- 外链：让助手回复里带一个 markdown 链接并点击。BrowserWindow 数量仍为 1；在主进程里 stub 掉 shell.openExternal，确认它收到了这个 URL。
- 复制：在权限白名单下，代码块的「复制」按钮和预览区的复制路径仍能写入剪贴板。用 app.evaluate 读 clipboard.readText 对比内容。
- 退出：会话运行中、权限卡挂着时，从托盘点「退出」。窗口应立即消失，5 秒内全部进程退出；重启后该会话里有「[已取消]」工具结果，没有报错条。
- 删除运行中的会话：权限卡挂着时删除该会话。卡片消失，左栏移除该会话，界面没有残留的错误条（依赖渲染端分区补上错误展示）。