# DSH 桌面端 × DeskMinis：Electron 安全配置与 IPC 面对照笔记

日期：2026-09-26。方法：只读静态读码。没有运行任何一方的代码，没有联网，没有修改任何仓库。

- DSH：/home/user/refs/deepseek-harness（HEAD 46a7f68b0，0.1.7-rc.1）。主要读了 apps/desktop/src（主进程与 5 个打包 preload）、apps/desktop/renderer、apps/desktop-host/src、packages/client/connection/src、packages/client/ui-sidebar-browser、packages/api/session-controller/src/media-references.ts。DSH 为 MIT 许可；凡「照抄改写」的，按路线执行约束登记 THIRD-PARTY-NOTICES。
- DeskMinis（下称 DM）：/home/user/Deskminis/deskminis（HEAD 35aab54，package.json 0.3.0）。主要读了 src/main、src/preload、src/renderer（index.html、rpc.ts、stores/chat.ts 等）、src/minisd/rpc/server.ts、src/minisd/index.ts。
- 记法：「文件:行」。「推断」表示没有实测，只由代码、注释或文档推出。
- dsh.md（2026-09-24 粗读）已经写过、本文不再展开的：新窗口一律 deny 并交 openExternal、will-navigate、中文右键菜单、「minisd:info 校验 sender」这一句建议、webview 租约/分区/客体加固、单实例、致命恢复/崩溃报告/render-process-gone、update-attention、pathFor。本文只在需要对比时引用它们。

---

## 0. 结论速览

| # | 项 | DSH | DM | 判断 |
|---|---|---|---|---|
| 1 | Electron 版本 | 44.0.0 | 38.8.6 | DM 缺（推断 38 已出支持期） |
| 2 | webPreferences | 每个窗口显式写 | 只写 preload，其余靠 Electron 38 默认值 | 生效值相同，DM 只差「显式」 |
| 3 | 自有协议 | dsh-app:// 特权协议 + protocol.handle | file:// | DM 缺（结构性） |
| 4 | CSP | 自有小页有，用户文件响应有 sandbox CSP；主文档无 | 无 | 主文档两边都无 |
| 5 | electronFuses | `{ runAsNode: true }`（只写明默认值） | 未配置 | 两边都没加固 |
| 6 | preload 暴露面 | 按文档源门控，API 最小，有测试 | 无条件暴露 8 个函数（含令牌） | DM 缺 |
| 7 | ipcMain 发送方校验 | 每个通道：窗口 + 主帧 + 帧 URL | 7 个通道只有 1 个比对 sender | DM 缺 |
| 8 | 导航/新窗口守卫 | 分层（主窗口/自有小页/第三方内容） | 主窗口一层，且比 DSH 主窗口严 | 主窗口 DM 更严 |
| 9 | 权限处理 | defaultSession 除 media 外全放行；第三方分区全拒 | defaultSession 只放本页剪贴板写入 | DM 更严 |
| 10 | webview | 主窗口开启 + 租约 | 未开启 | DM 面更小 |
| 11 | 外链 | http/https 直接打开；远端 URL 过 https+源白名单 | http/https/mailto 规范化后打开，终端链接先确认 | 相当 |
| 12 | 证书/代理/HTTP 认证 | 默认；第三方内容取消 login | 默认 | 相当 |
| 13 | 渲染端鉴权 | 凭据只在主进程，按 webContents 注入 | 令牌交给页面脚本，拼进 WS 查询串 | DM 缺 |
| 14 | 后端↔主进程通道 | Node IPC，逐条 schema 校验 | stdout 文本行（令牌也走 stdout） | DM 可借思路 |
| 15 | 打包态忽略开发开关 | 系统性地按 development 门控 | 只做了 ELECTRON_RENDERER_URL | DM 缺 |
| 16 | DevTools/菜单 | 打包版仍可 F12 | 打包版去掉 | DM 更严 |

---

## 1. Electron 运行时版本与支持期

**DSH 怎么做**
- apps/desktop/package.json 的 devDependencies 为 `"electron": "^44.0.0"`；pnpm-lock.yaml:18213 锁定 `electron@44.0.0`。
- 首个桌面提交就是 ^44：`git show 19444907f:apps/desktop/package.json` 第 33 行（提交日期 2026-08-28）。
- 代码按 44 的行为写：update-http-executor.ts:48 注释「Electron 44 can emit writable close after finish…」；main.ts:911-914 用的是 console-message 的新签名（details 对象）。

**DM 现状**
- package.json 为 `"electron": "^38.8.6"`，package-lock.json:3764-3766 锁 38.8.6。
- electron-builder.yml 的 `electronDist: node_modules/electron/dist`，所以装进安装包的就是 38.8.6。
- 立项时装的就是 ^38（/home/user/Deskminis/docs/plans/2026-07-26-m1-skeleton.md:72）。仓库文档里没有查到关于 Electron 支持期或升级计划的记录。

**差距与建议**
- 推断：Electron 官方只维护最新三个稳定大版本（这是记忆中的政策，没有联网核对）。44.0.0 是稳定版号（不带 alpha 或 beta 后缀），支持窗口大约是 42 到 44。按此推断，38 已经出了支持期，Chromium 与 V8 的安全修复不再回补到 38.x。渲染进程沙箱、contextIsolation 这些配置，都以 Chromium 本身得到及时修补为前提。
- 建议：不放进 0.3.0，因为功能已冻结，而且需要真机全量回归。路线规定「0.3.x 补丁线只接 W1 那类伤数据或安全问题的修复」，Electron 升级正好符合，可以作为 0.3.x 的一项，或者在 W4b 之前单列一个子波。回归清单：
  - electron-rebuild better-sqlite3；@napi-rs/keyring 是 N-API，推断不用重编。
  - 验证 bridge-node.cmd 垫片（依赖 RunAsNode）和 e2e:m5。
  - W2b-6 的三种形态接线测试。
  - 逐个核对签名有变化的事件，例如 will-navigate 的位置参数、console-message。
- 另建议在 docs/RELEASE.md 加一条发版前检查：「Electron 大版本仍在支持期内」。性质：只借思路。

---

## 2. 各窗口 webPreferences

**DSH 怎么做**（逐窗口）

| 窗口 | 位置 | preload | node / isolation / sandbox / webSecurity | 其它 |
|---|---|---|---|---|
| 主窗口 | main.ts:185-217 | preload-app.cjs | false / true / true / true | `webviewTag: primary`（只有主窗口为 true，:214）；`devTools: true`；spellcheck 未设（默认 true）；defaultSession |
| 欢迎窗 | welcome-window.ts:16-47 | preload-welcome.cjs，经 `additionalArguments` 传语言（:41） | false / true / true / true | will-navigate 全拒、新窗口全拒（:98-99） |
| 更新对话框、强制更新覆盖层 | update-overlay.ts:11-17 | preload-update-dialog / preload-mandatory | false / true / true / true | `setMenu(null)`，新窗口 deny（:46-47） |
| 平台账户视图（WebContentsView） | platform-view.ts:94-98 | preload-platform-account，经 additionalArguments 传允许的源 | false / true / true / true | session 是随机的非持久分区 `dsh-platform-<uuid>`（:74） |
| 策略登录窗（测试部署用） | policy-test-auth.ts:73-76 | 无 | false / true / true / true | `webviewTag:false`、`spellcheck:false`；session 为 `dsh-policy-auth-<uuid>` 且 `cache:false`（:17） |
| 侧栏浏览器 guest | browser-guests.ts:79-89 | 禁止（先删掉渲染端传入的所有键，只留 disablePopups） | false（含 InWorker、InSubFrames）/ true / true / true | `allowRunningInsecureContent:false`、`webviewTag:false`、`plugins:false`、`navigateOnDragDrop:false`、`disableDialogs:true`、`devTools: !isPackaged`，并清空 httpreferrer |

**DM 现状**
- 只有一个 BrowserWindow（index.ts:231-240），webPreferences 只写了 `preload`；其余对话框都是原生 dialog。
- 生效值取 Electron 38 的默认值。node_modules/electron/electron.d.ts 约 18238-18465 行的注释给出了这些默认值：nodeIntegration false，contextIsolation true，sandbox 自 Electron 20 起默认 true，webSecurity true，webviewTag false，navigateOnDragDrop false，spellcheck true，devTools true。
- 已有守卫：electron.vite.config.ts:21-27 把 preload 输出为 CJS；tests/preload-wiring.test.ts:45-53 钉住了「改成 ESM 就只能关沙箱」这一点。

**差距与建议**
- 生效值与 DSH 主窗口相同，而且 DM 没开 webviewTag。差别只在「显式」：electron.d.ts 的注释写明，设了 nodeIntegration:true 会自动关掉沙箱。将来如果有人这样改，目前没有测试会变红。dsh.md 提到过 DSH 是显式写的，W2b-6 没有跟进。
- 建议：createWindow 显式写 `sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true`，可以再加 `webviewTag:false`。tests/main-window-guard-harness.ts:127-129 的 FakeBrowserWindow 目前只记调用名，改成同时记下构造参数，再加断言。这项零行为变化，可以在 0.3.0 前做，也可以并入 W6d。性质：照抄改写。
- spellcheck：两边主窗口都开着默认值。DM 没有右键菜单，用户看不到也用不了拼写建议，只剩下划线。这属于 UX，随 dsh.md 已写的右键菜单一并处理。推断：Windows 上 Chromium 优先用系统拼写服务，但系统不支持的语言会不会去下载 Hunspell 词典，未核实。

---

## 3. 自定义协议与文档来源（protocol.handle / registerSchemesAsPrivileged 对 file://）

**DSH 怎么做**
- 在 ready 之前注册特权协议：main.ts:111-121 调用 `protocol.registerSchemesAsPrivileged`，scheme 为 `dsh-app`，参数有 standard、secure、supportFetchAPI、corsEnabled、stream、codeCache。
- main.ts:561-576 用 `protocol.handle`：
  - `dsh-app://shell/` 只从应用包里的 renderer/ 目录供应静态页（更新对话框等），不经过 Host。
  - `dsh-app://app/` 的 `/`、`/index.html`、`/assets/`、图标和 manifest 从打包的 web 前端 dist 供应，其余路径转发给已鉴权的 Host。Host 没就绪时回 503；其它主机回 404。
- web-document.ts:18-36 的 serveWebDocument 有四条规矩：只收 GET 和 HEAD（否则 405）；decodeURIComponent 失败回 400；resolve 之后必须落在 `root + sep` 之内（否则 403）；按固定 MIME 表返回。README.md:61 把这四条写成了约定。
- 效果：应用文档有一个独立、确定的源 `dsh-app://app`。下面这些来源判断都认它：
  - IPC 来源断言（ipc.ts:80-87）
  - 麦克风权限（microphone-permissions.ts:4-9）
  - WS 的 Origin 检查（main.ts:615）
  - preload 门控（preload-app.ts:28）
  - Host 转发前的 Origin 检查（web-document.ts:79-80）
- 自定义协议只注册在 defaultSession 上。guest 分区的 onBeforeRequest 另外把非网络协议全部拦下，只留 about、data、blob（browser-guests.ts:143-149）。

**DM 现状**
- 打包态用 loadFile 加载 `out/renderer/index.html`（index.ts:216-218、260-261），文档的源是 file://。nav-guard 按「解码后的路径 + 盘符统一大写」精确地只认 index.html 这一个文件（nav-guard.ts:57-74）。
- minisd 的 Origin 白名单接受 `'file://'`（src/minisd/rpc/server.ts:46）。任何 file:// 文档的 Origin 都是这个值，分不出是不是本应用。推断实际影响小，因为还有令牌这一道。
- PreviewPane 用 `file://${workspaceRoot}/${path}` 显示工作区里的图片（src/renderer/src/ui/PreviewPane.vue:125）。
- 推断（依据对 Electron fuses 文档的记忆）：GrantFileProtocolExtraPrivileges 熔丝默认开启，所以 file:// 文档比普通网页多一些特权，例如可以用 fetch 读取其它 file:// 资源。

**差距与建议**
- DM 没有「应用自有源」。这不是缺陷，而是一种更稳的结构：换成自有协议后，IPC、权限、WS 的来源判断都能落在一个不可伪造的源上，也才有条件关掉 file:// 的额外特权。
- 建议（W9 或 0.6.0 之后，规模 M，只借思路）：
  1. 注册一个 `deskminis-app` 特权协议，用 protocol.handle 供应 out/renderer，照搬 serveWebDocument 的四条规矩。
  2. 工作区图片走一条单独的路由：先过工作区围栏，响应带 `CSP: sandbox; default-src 'none'` 和 nosniff（见第 4 节）。
  3. nav-guard 的 isAppUrl 和 permissionAllowed 改为认新源；minisd 的 Origin 白名单去掉 `'file://'`。
  4. 最后再评估关掉 GrantFileProtocolExtraPrivileges（见第 5 节）。
  - 需要 xvfb 和 Windows 真机验证。

---

## 4. CSP 与响应头

**DSH 怎么做**
- Shell 自有的小页都用 meta CSP：
  - apps/desktop/renderer/welcome.html:6：`default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'`
  - update-dialog.html:6、mandatory-update.html:6：`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src …`
  - policy-login-loading.html:11：`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`（只有一个占位页）
- Host 用 /api/file 供应用户文件时，响应带 `Content-Security-Policy: sandbox; default-src 'none'`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`（packages/api/session-controller/src/media-references.ts:15-20）。注释说明原因：HTML 和 SVG 文件可能在已鉴权的源上被直接打开。
- 文档预览会给预览文档插一条 CSP meta（packages/client/ui-sidebar-documentpreview/src/client/html/basic-document.ts:18）。dsh.md R3 已写过 HTML 安全预览。
- 主产品文档没有 CSP：apps/web/index.html 里没有；web-document.ts:10、31-32 还会往 index.html 里注入一段内联脚本。推断：如果要加 `script-src 'self'`，得先处理这段内联脚本。

**DM 现状**
- src/renderer/index.html 只有 charset、title 和一个 module script，没有 CSP。
- 渲染端目前没有加载远程资源的地方：
  - Markdown 解析器不产出图片节点（lib/markdown 里没有 image 处理，grep 无结果）。
  - v-html 只用在静态图标常量上（components/Icon.vue:47、ui/UiIcon.vue:53）。
  - OfficeView 明确禁止 v-html（ui/OfficeView.vue:12）。
- 推断：因此现在缺 CSP 的实际暴露面小。

**差距与建议**
- DSH 的 CSP 只加在自有小页和用户文件响应上，主文档两边都没有。
- 建议（W9a，与「Markdown 工作区内图片」同批做）：给主文档加 meta CSP。这批一旦开始渲染图片，模型输出里的地址就会触发网络请求，CSP 正好从这时起收住。建议取值：
  - `default-src 'self'`；`script-src 'self'`
  - `style-src 'self' 'unsafe-inline'`：xterm 会动态插入 style，图标用 v-html；终端删掉后可以再收紧。
  - `img-src 'self' data: file:`，或改用第 3 节的自有协议路由。
  - `connect-src 'self' ws://127.0.0.1:*`
  - `object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`：HTML 预览上线后，再按需放开 srcdoc 所需的项。
- 推断：electron-vite 官方模板自带这类 meta，dev 和打包形态都能用；仍需要 xvfb 深浅两套主题实拍核对。性质：照抄改写（参照 DSH welcome.html 的写法）。

---

## 5. electronFuses 与打包侧

**DSH 怎么做**
- scripts/electron-builder-config.mjs:113-115 写了 `asar: true` 和 `electronFuses: { runAsNode: true }`。
- app-builder-lib 只翻动配置里显式给出的熔丝（DM 的 node_modules/app-builder-lib/out/platformPackager.js:259-298；两边的 electron-builder 都是 26.15.3）。所以 DSH 实际上只是把 RunAsNode 的默认值写明了。其余熔丝都保持默认：NodeOptions、NodeCliInspect、EmbeddedAsarIntegrity、OnlyLoadAppFromAsar、GrantFileProtocolExtraPrivileges、CookieEncryption。
- 保留 RunAsNode 的原因：Host 和 pnpm 都以 ELECTRON_RUN_AS_NODE 方式启动（node-environment.ts:15；apps/desktop-host/src/index.ts:34）。
- DSH 另外做了代码签名（Windows 用硬件令牌签名，macOS 做公证，见 electron-builder-config.mjs:74-92、148-160、219-227），打包时还校验运行时清单（README.md:73）。

**DM 现状**
- electron-builder.yml 没有 electronFuses，也没有签名配置（路线 W3 的发布说明写了 SmartScreen 提示）。
- 打包态同样依赖 RunAsNode：scripts/bridge-node.cmd 设 `ELECTRON_RUN_AS_NODE=1` 后调用 DeskMinis.exe（src/minisd/bridge/server.ts:52-60）。/home/user/Deskminis/docs/plans/2026-08-08-m5-packaging.md:218 有实测记录。

**差距与建议**
- 两边的熔丝都等于没开，这一项不是 DSH 的优势。RunAsNode 两边都必须保持开启。
- 其余熔丝收益有限，还有兼容风险：
  - EnableNodeOptionsEnvironmentVariable：关掉后忽略 NODE_OPTIONS。推断（记忆中 Electron 文档的说法，待核）：同时也会忽略 NODE_EXTRA_CA_CERTS。如果是这样，在企业代理使用自签 CA 的环境里，minisd 的 HTTPS 请求可能受影响。
  - EmbeddedAsarIntegrityValidation、OnlyLoadAppFromAsar：没有代码签名时价值有限，因为同一用户本来就能替换安装目录里的文件。
  - GrantFileProtocolExtraPrivileges：要等第 3 节换掉 file:// 之后才能关。
  - EnableNodeCliInspectArguments=false：可以考虑，打包态用不到 --inspect。但 RunAsNode 仍然开着，它单独构不成完整的边界。
- 建议：归入发布工程，有签名计划时再一起评估。不进 0.3.0。性质：只借思路。

---

## 6. preload 暴露面（按窗口）

**DSH 怎么做**（打包的 5 个 preload，见 electron-builder-config.mjs:131-136）
- preload-app（主窗口）：
  - 只有当 `location.protocol === 'dsh-app:' && location.hostname === 'app'` 时，才暴露 `__DSH_DIRECTORY_PICKER__`、`__DSH_HOST_PATHS__`、`dshDesktopBoot`、`dshPlatform`、`__DSH_LOCALE__`（preload-app.ts:28-57、65-70）。在其它文档里，`dshDesktop` 只有 `{ protocolVersion: 1 }`（:63）。
  - 产品 API 只有三样：更新状态、「打开原生确认框」、订阅，外加一个按租约工作的浏览器桥（:12-26）。
  - README.md:57 写明：渲染端拿不到文件系统、原始 IPC、shell 或任意 pnpm 参数，也不能指定更新制品或授权安装。
- preload-update-dialog：只在 `location.href === 'dsh-app://shell/update-dialog.html'` 时暴露（preload-update-dialog.ts:14）。API 只有 status、`respond(revision, index)`、subscribe。
- preload-mandatory：只在 `'dsh-app://shell/mandatory-update.html'` 时暴露（preload-mandatory.ts:16）。
- preload-platform-account：只在 `process.isMainFrame` 且 `location.origin` 等于主进程经 additionalArguments 传来的源时暴露（preload-platform-account.ts:5-7）。令牌经一次 sendSync 取到后只存在 preload 闭包里；`getAuthToken()` 同步读取，不再发 IPC（:18-43）。
- preload-welcome：不做门控，因为这个窗口的 will-navigate 全拒（welcome-window.ts:98-99）。API 是只写型的：saveApiKey 只回 `{ok}`（welcome-api.ts:16-17、33）。
- 测试：
  - tests/preload-app.spec.ts:20-91 钉住两件事：API 面只有上面这些（没有 plugins、backend、install）；每个桥只暴露给本地应用文档。
  - tests/preload.e2e.ts:1-80 用 `vm.runInNewContext` 执行构建产物，require 只提供 `'electron'`，以此钉住 preload 在沙箱下能跑。

**DM 现状**
- src/preload/index.ts:5-34 无条件执行 `exposeInMainWorld('deskminis', …)`，暴露 8 个调用和 2 个订阅：
  - minisdPort（遗留，:7）
  - minisdInfo（端口加令牌，:9）
  - pickFolder
  - getUpdatePrefs、setUpdateEnabled、checkForUpdates
  - onMenuOpenSettings、onMenuToggleRight
  - saveAttachment
  - relaunchApp
- minisdPort 只在 minisdInfo 不存在时兜底（src/renderer/src/rpc.ts:36-37）。两者出自同一个 preload，所以这条路径实际走不到。
- 已有守卫：tests/ipc-contract.test.ts 保证 preload 里 invoke 的每个通道都有 handle；tests/preload-wiring.test.ts 保证 CJS 格式。

**差距与建议**
- DM 的 preload 不管当前文档是谁。W2b-6 已经关掉了新窗口和外站导航；/home/user/deskminis-docs/docs/research/2026-09-24-resurvey/context.md:89 和同目录 exp-window-open 实验也确认子窗口不继承 preload。所以现在只有本应用页面能拿到这些函数。门控是纵深防线，价值体现在将来出现第二个文档的时候（HTML 预览、OAuth 窗、内置浏览器）。
- 建议（W6d，照抄改写）：
  1. createWindow 通过 additionalArguments 把 appBase 交给 preload（DSH 传源用的是同一手法，preload-platform-account.ts:5-7）。preload 只在 `process.isMainFrame` 且 location 是本应用页面时才暴露。
  2. 删除 minisdPort 和 `minisd:port` 两端。ipc-contract 守卫要求两边一起删，照做即可。
  3. 加一条 API 面快照测试：暴露的键集合必须等于白名单。

---

## 7. ipcMain 处理器：来源校验与参数校验（逐通道）

**DSH 怎么做**

| 通道 | 方式 | 发送方校验 | 参数校验与返回 | 位置 |
|---|---|---|---|---|
| dsh-desktop:boot | handle | assertDesktopSender(app) | 无参；先 `await startup`；只回 injections 和 streamBaseUrl（只含源） | main.ts:581-586 |
| dsh-desktop:boot-failed | handle | app + 主窗口 + 主帧 | typeof string | main.ts:588-595 |
| browser-acquire / release | handle | assertProductSender（app + 主窗口 + 主帧） | workspace 长度 1–4096；lease 必须属于本窗口 | main.ts:597-604；browser-guests.ts:28-61 |
| dsh-platform:open / bounds / close | handle | 主窗口 + 主帧 + 帧 URL 以 dsh-app://app/ 开头 | page 为枚举；bounds 为 0–100000 的有限数 | main.ts:619-638；platform-view.ts:19-29 |
| dsh-platform:bootstrap | on（sendSync） | 平台视图主帧 + 账户源 | 只读内存，不等 Host、磁盘或网络 | main.ts:625-628；platform-view.ts:165-173 |
| native-theme-set | on | 主窗口 | light / dark / system 枚举 | main.ts:640-643 |
| locale-bootstrap / locale-changed | handle / on | 主窗口 + 主帧（+ 源） | typeof string | main.ts:644-662 |
| updates-status / updates-open | handle | assertProductSender | 无参；渲染端不能指定版本或 URL | main.ts:663-670 |
| windows-menu | handle | app + 主窗口 + 主帧 | name 为枚举；x、y 为 0–100000 的有限数 | main.ts:856-890 |
| windows-appearance | on | 主窗口 + 主帧 + 帧 URL 前缀 | 语言和颜色都用正则校验 | main.ts:891-902 |
| directory-pick | handle | 主窗口 + 主帧 + app | 同一窗口的并发请求去重；弹框前先 restore、show、focus | directory-picker.ts:11-27 |
| dsh-welcome:* | handle，只在窗口存在期间注册，关窗时 removeHandler | 欢迎窗主帧 | API key 只允许可打印 ASCII；id 为字符串；只回 `{ok}` | welcome-window.ts:61-97 |
| update-dialog:status / respond | handle，dispose 时 removeHandler | 对话框主帧，且帧 URL 等于本页 | 用 revision 拒绝过期应答；index 范围校验；关闭等于取消，不会授权安装 | update-dialog.ts:1、56-66、115-126、137-143 |
| mandatory:status / action | handle，dispose 时 removeHandler | 覆盖层主帧加 URL，或嵌入态下主窗口主帧加 app | action、version、revision | mandatory-update-window.ts:74-75、234-235、294-306 |

- 共同做法：每个通道都校验三件事：event.sender 是所属窗口的 webContents；event.senderFrame 是它的 mainFrame；帧 URL 属于预期的源或页面。
- 顺序：先建窗口并赋给 mainWindow，再加载页面（main.ts:1059 先 createMainWindow，之后 reconcileBackend 里才 navigateMain，:486-488）；boot 通道还会先 `await startup`（:583）。
- 测试：tests/main-startup.spec.ts:604-607、742、858-865、1008-1015、1435 覆盖「unowned renderer」被拒的各种情形。

**DM 现状**

| 通道 | 发送方校验 | 参数与返回 | 位置 |
|---|---|---|---|
| update:getPrefs | 无 | 无参 | index.ts:357 |
| update:setEnabled | 无 | `on !== false` 归一为布尔后写入 update-prefs.json | index.ts:358-361 |
| update:check | 无 | 无参 | index.ts:362 |
| minisd:port（遗留） | 无 | 只回端口 | index.ts:365 |
| minisd:info | 无 | 回 `{port, token}` | index.ts:368 |
| app:relaunch | sender === mainWindow.webContents（不比 senderFrame） | 无参；在退出中就不再处理 | index.ts:378-384 |
| dialog:pickFolder | 无（弹在聚焦窗口上） | 取消时回 null | index.ts:388-397 |
| attachments:save | 无 | sessionId 必须是 UUID、扩展名走白名单、dataUrl 过正则；没有体积上限 | index.ts:403-411；attachments.ts:7-35 |

- 主进程发往渲染端的只有 `menu:open-settings` 和 `menu:toggle-right`（index.ts:203-204）。

**差距与建议**
- 7 个 handle 通道里，只有 app:relaunch 比对了发送方，而且不比 senderFrame。目前没有子框架，推断这一点没有实际差别。
- **时序坑**（推断，依据代码顺序）：渲染端在挂载时就取令牌，而 mainWindow 要等页面加载完才赋值。
  - 取令牌的链路：ui/AppShell.vue:56 的 onMounted → stores/chat.ts:160-164 的 init → renderer/src/rpc.ts:33 的 minisdInfo()。
  - mainWindow 赋值在 `await createWindow()` 之后（index.ts:445-446）；createWindow 在 :260 `await loadFile`，而 loadFile 要等页面加载完成才 resolve。
  - 所以，如果照 dsh.md 那一句建议直接写 `e.sender !== mainWindow?.webContents`，会把首次连接拒掉，界面随之出现「与后台服务的连接已断开」横幅。DSH 没有这个问题，因为它先建窗口、登记，再加载。
- 参数校验：attachments:save 该做的校验都做了，只缺体积上限。渲染端会先降采样（attachments.ts:10-12 的注释），所以优先级低。DSH 没有对应的通道，它的上传走 Host 的 HTTP。
- pickFolder 用的是聚焦窗口，而不是发起请求的窗口，也不去重。DM 只有一个窗口，没有实际差别。
- 建议（W6d，照抄改写）：
  1. 在 createWindow 里、`new BrowserWindow` 之后和 loadFile 之前，记下 appContentsId（或者把 mainWindow 的赋值提前）。写一个 `assertAppFrame(e)`，检查三件事：sender.id 相符；senderFrame === sender.mainFrame；`isAppUrl(senderFrame.url, appBase)`。
  2. 把它套到全部 handle 通道上。顺序：minisd:info 优先，然后是 attachments:save、update:setEnabled、dialog:pickFolder；app:relaunch 也改用同一个函数。
  3. 在 main-window-guard-harness 的假 webContents 上补 id、mainFrame 和 url。接线测试覆盖两种情形：首次连接早于 load 完成时要放行；其它 webContents 和子框架要被拒。
  4. attachments:save 在主进程加一个体积上限（数值待定），低优先级。
- 不建议在 0.3.0 前临时加：这是启动握手路径上的时序改动，回归面大于收益。

---

## 8. 导航与新窗口守卫（只写 dsh.md 以外的差异）

**DSH 怎么做**
- 主窗口：
  - setWindowOpenHandler：http/https 交系统浏览器，一律 deny（main.ts:218-221）。
  - will-navigate：放行任意主机的 dsh-app: 地址，以及同源 http（开发态）；其余一律阻止，其中 http(s) 交系统浏览器（main.ts:281-289）。这里的 `new URL(url)` 没有包 try。
- 自有小页：
  - 欢迎窗：will-navigate 全拒，新窗口全拒（welcome-window.ts:98-99）。
  - 更新对话框和强制更新页：只允许本页 URL（update-dialog.ts:109；mandatory-update-window.ts:198-199）。
  - overlay 统一 deny 新窗口（update-overlay.ts:47）。
- 第三方内容：
  - 平台视图和登录窗：will-navigate 与 will-redirect 都校验（platform-view.ts:132-133；policy-test-auth.ts:101-106）。
  - will-attach-webview 一律阻止（platform-view.ts:134；policy-test-auth.ts:107；guest 内部 browser-guests.ts:122）。
- guest：主框架的 will-frame-navigate 和 will-redirect 只放行三类都满足的地址：http(s)、不带 userinfo、不指向应用自己的 Host（browser-guests.ts:116-121、152-165）。

**DM 现状**
- setWindowOpenHandler 经 openInSystem 只交出 http/https/mailto，交出的是规范化后的 href，打开失败会 catch（index.ts:220-228、246-249；nav-guard.ts:20、33-36）。
- will-navigate 只放行本应用页面：打包态精确到 index.html 一个文件，开发态要求同源（index.ts:252-256；nav-guard.ts:68-74）。守卫在加载之前挂上，tests/main-window-guard-wiring.test.ts 有注册时机的用例。
- 没有 will-redirect（推断不需要，file:// 文档没有服务端重定向）、没有 will-frame-navigate（没有子框架）、没有 will-attach-webview（webviewTag 默认 false）。
- 小订正（推断，未实测，不影响守卫本身）：nav-guard.ts:1-15 的头注释说「把文件拖到输入区以外，Chromium 会按 file:// 导航」。但 Electron 38 的 navigateOnDragDrop 默认为 false（electron.d.ts 约 18350-18353 行的注释），两者可能不一致。

**差距与建议**
- 主窗口这一层，DM 比 DSH 严。DSH 多出来的是分层：每一种内容面各有一套守卫（自有小页全拒、第三方内容校验重定向、禁止挂载 webview）。DM 只有一个窗口，目前用不上。
- 建议：以后每新增一个窗口或视图，都照 DSH 的分层来：
  - 自有小页的 will-navigate 全拒，或精确到本页。
  - 第三方内容加上 will-redirect 和 will-attach-webview 的校验。
  - 可以考虑加一个 `app.on('web-contents-created')` 兜底，保证新建的 webContents 默认 deny 新窗口。两边目前都没有这一项。
- 归入对应的功能子波。性质：只借思路。

---

## 9. 权限请求处理

**DSH 怎么做**
- defaultSession 由主窗口、欢迎窗和更新窗共用。installMicrophonePermissions 只管 `media` 这一种权限：要求来自主窗口的主帧、源为 dsh-app://app、只请求音频，macOS 上另外查系统授权。**其它权限的检查一律返回 true，请求一律 `callback(true)`**（microphone-permissions.ts:16-30；安装位置 main.ts:579）。
- 独立分区（平台视图、策略登录、侧栏浏览器）的请求和检查一律拒绝（platform-view.ts:75-76）：
  - 策略登录分区另外设了 `setDevicePermissionHandler(() => false)`（policy-test-auth.ts:37-39）。
  - 侧栏浏览器分区另外设了 `setDisplayMediaRequestHandler` 并回 `callback({})`（browser-guests.ts:138-141）。
  - 下载一律 preventDefault（policy-test-auth.ts:40；browser-guests.ts:142）。

**DM 现状**
- defaultSession 的请求和检查只放行一项：本应用页面的 `clipboard-sanitized-write`，其余全部拒绝（nav-guard.ts:22-25、82-84；index.ts:427-435）。处理器在建窗口之前注册，三种形态都有接线测试（tests/main-window-guard-wiring*.test.ts）。
- 设备权限（hid、serial、usb）在权限检查这一步就被拒绝。没有注册 `select-*-device` 监听，也没有设 setDisplayMediaRequestHandler，推断按 Electron 默认会取消请求（未实测）。

**差距与建议**
- 在 defaultSession 上，DM 比 DSH 严。DSH 的长处在于「第三方内容进独立分区并全部拒绝」，而 DM 目前还没有第三方内容。
- 建议：保持现状。将来接入 OAuth 登录窗、HTML 预览或内置浏览器时，照抄改写 browser-guests.ts:137-149：独立的非持久分区，请求、检查、设备、屏幕共享全部拒绝，并拦截 will-download。

---

## 10. webview 约束

- DSH：dsh.md 已写（租约、分区、will-attach-webview 时用主进程配置覆盖 webPreferences）。补充两点：
  - 主窗口是唯一开启 webviewTag 的窗口（main.ts:214）。
  - 主窗口开始新的主框架导航、渲染进程退出或被销毁时，释放它名下的全部租约（browser-guests.ts:125-134）。
- DM：webviewTag 默认 false，没有 `<webview>`，也没有 iframe（见 /home/user/deskminis-docs/docs/specs/2026-09-24-hemostasis/lifecycle.md:19 的事实清单）。
- 建议：目前无差距。内置浏览器（0.6.0 之后）直接沿用 dsh.md 的结论。

---

## 11. 外链打开

**DSH 怎么做**
- 主窗口：http/https 直接调用 shell.openExternal（main.ts:219、287），不弹确认；mailto 和其它协议静默拒绝。
- 平台视图：只放 https，并且 URL 不得带用户名或密码（platform-view.ts:117-125）。
- 强制更新页：远端下发的下载页地址必须同时满足四条：https、不带 userinfo、源在部署白名单里、长度不超过 2048（mandatory-update-policy.ts:103-109）。
- 登录链接由主进程拼好后再 openExternal（main.ts:179-183、399-401），渲染端不提供 URL。

**DM 现状**
- 只交出 http/https/mailto，交出的是 `new URL` 规范化后的 href，打开失败会 catch（nav-guard.ts:18-36；index.ts:220-228）。
- Markdown 链接（MarkdownInline.vue:16）的 href 已由解析器限定为 http/https/mailto，点击后直接交给系统浏览器。
- 终端里的 OSC 8 链接会先弹中文确认，显示主机名和规范形地址（TerminalPane.vue:83-98；tests/renderer-terminal-links.test.ts）。
- externalUrlOf 不检查 userinfo。

**差距与建议**
- 差距小。DSH 只在「远端下发的 URL」上多做了三道：https、源白名单、不带 userinfo。DM 目前没有远端下发后直接打开的 URL，更新页地址是 update-status.ts 里的常量 RELEASES_PAGE_URL。
- 建议（可选，W6d，1–2 行，只借思路）：externalUrlOf 拒绝带 userinfo 的地址，或者让这类地址也走终端那样的确认。以后如果出现远端下发的链接（市场条目主页、公告），照 desktopPolicyPage 的规则先过一道。

---

## 12. 证书、代理、HTTP 认证

**DSH 怎么做**
- 没有 setCertificateVerifyProc，也没有处理 certificate-error 或 select-client-certificate（apps/desktop/src 全文 grep 无结果），即沿用 Chromium 默认。
- HTTP 认证：平台视图、登录窗和 guest 的 `login` 事件一律 preventDefault，再以空参数 callback() 取消（browser-guests.ts:123；policy-test-auth.ts:108）。更新请求的 login 转发给 updater 的事件（update-coordinator.ts:60-63），并加了 60 秒空闲超时（update-http-executor.ts:6-52）。
- 代理：更新走 Electron net，即系统代理。子进程代理变量的恢复在 Host 侧（dsh.md R5 已写 proxyEnvironmentForChild）。

**DM 现状**
- 同样没有任何证书覆写。app 上没有 `login` 监听，推断按 Electron 默认取消认证。
- 代理在 minisd 层处理：
  - model-catalog 只对 models.dev 用 undici 的 ProxyAgent，尊重 NO_PROXY，并禁止 setGlobalDispatcher（src/minisd/providers/model-catalog.ts:94-117）。
  - 配对和同步刻意直连（remote/noProxyFetch.ts:12；sync/outbound-client.ts:16、127）。
- select-client-certificate 两边都没处理（Electron 默认使用证书库里的第一张）。推断 DM 实际不会触发：它的 Chromium 网络栈只有 electron-updater 访问 GitHub 这一处。

**差距与建议**
- 没有差距，两边都沿用默认行为：拒绝无效证书、取消 HTTP 认证。
- 建议：继续不覆写证书校验。以后加 OAuth 登录窗或内置浏览器时，照 DSH 的做法在对应的 webContents 上取消 `login`。

---

## 13. 渲染端与后端的连接鉴权（令牌如何交给渲染端）

**DSH 怎么做**
- Host 端：
  - 每个进程生成一个 32 字节的随机启动令牌（packages/client/connection/src/browser-auth.ts:14、52-58），只作为查询参数出现在 authenticatedUrl 里（:223-227）。
  - 带正确令牌访问 `GET /` 时，回 303 重定向并下发 cookie。cookie 属性为 HttpOnly、SameSite=Strict、Path=/，有效期按天计；值的格式是「版本.载荷.HMAC」，并绑定请求的 authority（:106-132、238-263）。令牌比较用 timingSafeEqual（:100-104）。
  - 所有 /api 请求还要过 Host/Origin 围栏（api-request-trust.ts:91-118）：Host 必须是回环地址或声明过的可信主机；`sec-fetch-site: cross-site` 直接拒绝；带了 Origin 时，Origin 必须与 Host 一致。
- 桌面主进程：
  - Host 就绪后，经 Node IPC 把带令牌的 URL 交给主进程（apps/desktop-host/src/index.ts:81-82）。主进程用它换来 cookie，只存在主进程的变量里（main.ts:389；web-document.ts:43-50）。
  - HTTP：渲染端请求 `dsh-app://app/api/…`，protocol.handle 转发给 Host 时由主进程加上 cookie。请求带了 Origin 而且不是 `dsh-app://app` 的，直接回 403。响应里去掉 set-cookie 等头，cookie 不会进入页面的 cookie 罐（web-document.ts:58-62、77-92；main.ts:570-573）。
  - WebSocket：session.defaultSession.webRequest.onBeforeSendHeaders 只拦截 `ws://127.0.0.1/*`（main.ts:606-617；测试 tests/main-startup.spec.ts:826-845）：
    - webContentsId 不是主窗口的，原样放行，不加凭据；
    - 目标主机不是 Host 的，原样放行；
    - Origin 不是 `dsh-app://app` 的，取消请求；
    - 其余情况把 Origin 改写为 Host 的源，并加上 cookie 和 `sec-fetch-site: same-origin`。
  - boot IPC 只返回 injections 和 streamBaseUrl（只含源，不含令牌），见 main.ts:581-586。README.md:5 的概括是「credentials attached only for the owned application window」。
- 平台账户的 token 另走一条路：Host 经 IPC 交给主进程，主进程只交给平台视图的主帧（platform-view.ts:165-173）。README.md:13 写明「account RPC and the Harness renderer receive no token」。

**DM 现状**
- minisd 每次启动用 randomUUID 生成令牌（src/minisd/index.ts:1305），经 stdout 的握手行交给主进程（:1524；main index.ts:155-160）。握手行不写日志（:163-164）。
- 主进程经 minisd:info 把 `{port, token}` 交给渲染端（index.ts:368；preload/index.ts:9），渲染端把令牌拼进 WS 查询串 `?token=`（renderer/src/rpc.ts:39-41）。
- minisd 的 verifyClient 要求三个条件同时成立（src/minisd/rpc/server.ts:35-52）：令牌相等；socket 来自回环地址；Origin 为空、`file://`、`http://localhost:*` 或 `http://127.0.0.1:*`。比较用的是 `===`。
- 令牌另外以明文写进数据根下的 minisd-port.json，供 CLI dry-run 免交互连接。代码注释已申报这是有意的取舍，包括 Roaming 目录可能被同步出本机（src/minisd/index.ts:145-176）。

**差距与建议**
- 保管位置：DSH 桌面端的凭据只在主进程里；DM 的令牌进入渲染端 JS 内存，还出现在 WS URL 里。
- 绑定对象：DSH 的注入同时按 webContents id 和 Origin 限定；DM 只要拿到令牌、从回环地址连接即可。
- 比较方式：DSH 用常数时间比较；DM 用 `===`。推断在回环上计时差异的实际意义很小。
- 寿命：DM 的令牌每次启动都换，比 DSH「持久签名密钥 + 按天有效的 cookie」短；但 DM 会把令牌落盘到 Roaming（已申报）。
- 建议（随 W6b 重写 RpcClient 一起做，只借思路）：
  1. 主进程对「主窗口 webContents 发往 ws://127.0.0.1:<minisd 端口> 的握手」用 onBeforeSendHeaders 注入令牌请求头（例如 x-deskminis-token）。其它 webContents、其它端口一律不注入。
  2. minisd 的 verifyClient 同时接受请求头里的令牌（CLI、配对等其它模式不变），比较改用 timingSafeEqual。
  3. minisd:info 只返回端口。W6b 本来就计划「重连前重新取 minisdInfo」，正好一并改成只取端口。
  4. 动手前先实测 Electron 38 能不能改写 ws:// 握手的请求头。DSH 在 Electron 44 上依赖这个行为，推断 38 也支持。
  5. minisd-port.json 里的令牌维持现状（有 CLI 需求，路线已登记缓解方向）。也可以改写到不漫游的 LOCALAPPDATA，理由与 W2b-7 把日志放在 Local 相同，但要先评估 CLI 的读取路径。

---

## 14. 后端进程 ↔ 主进程通道

**DSH 怎么做**
- Host 以 ELECTRON_RUN_AS_NODE 方式 spawn，stdio 带 `'ipc'`（host-process.ts:163-175）。
- 主进程只认 ready、fatal、platform-session、shutdown-complete、update-tasks 五类消息，逐字段校验；收到任何不认识的消息就判失败并 SIGTERM（:35-68、180-185）。platform-session 还要求源是 https 或回环 http，请求头名单里禁止 authorization 等头（:43-59）。
- Host 对主进程发来的消息同样只认 shutdown 和 update-tasks 两类（apps/desktop-host/src/index.ts:54-69）。

**DM 现状**
- minisd 由 utilityProcess.fork 启动（index.ts:110-122）。握手行和致命行走 stdout 文本行（:140-167；src/minisd/index.ts:1524）；关停消息走 parentPort（src/minisd/index.ts:1517-1520）。
- 握手行必须同时带数字端口和非空令牌（index.ts:93-103），并且只接受第一行（:156）。

**差距与建议**
- DM 的令牌经 stdout 管道传递；DSH 走结构化的 IPC 通道，并对每条消息做 schema 校验。
- 建议（W6a 抽 launcher 模块时，只借思路）：
  - 握手改走 parentPort.postMessage（关停已经在用这条通道），stdout 只留给日志。
  - 主进程侧给每类消息写校验函数，不认识的消息记日志即可。minisd 是自家代码，不必像 DSH 那样直接杀进程。

---

## 15. 打包态忽略开发/测试开关

**DSH 怎么做**
- 下列环境变量只在未打包时读取：
  - DSH_DESKTOP_PNPM_ENTRY、DSH_DESKTOP_DSH_DIR（main.ts:134-138）
  - DSH_DESKTOP_PRIMARY_RUNTIME_DIR（:142-148、300-302）
  - DSH_DESKTOP_HOST_INSPECT_PORT（:150-158、381）
  - DSH_DESKTOP_MANDATORY_UPDATE_CONFIG（:1062-1066）
- 自动打开 DevTools 也只在开发态（:943-945、1110-1112）。

**DM 现状**
- 已做：打包态不认 ELECTRON_RENDERER_URL（W2b-6b；index.ts:211-218；tests/main-window-guard-wiring-packaged.test.ts）。
- 未做：fork minisd 时把整份 process.env 下发（index.ts:111-120），minisd 不区分是否打包，照样读取以下开关：

| 开关 | 效果 | 位置 |
|---|---|---|
| DESKMINIS_E2E | 改用明文的 FileVault（dataRoot/vault.json） | src/minisd/index.ts:342-347；store/provider-store.ts:65 |
| DESKMINIS_TEST | 改用内存凭据库 | src/minisd/index.ts:347 |
| DESKMINIS_FAKE_PROVIDER、DESKMINIS_FAKE_REPLY | 启用假 provider | src/minisd/index.ts:180-198、531 |
| DESKMINIS_MARKET_FIXTURE_URL | 把市场请求改发到指定地址 | src/minisd/market/client.ts:87-92 |

- 这些开关的使用方都不经过打包后的主进程：e2e-m3a、e2e-m3b、e2e-mcp、smoke-release 都是直接起 minisd（用 ELECTRON_RUN_AS_NODE 或 --memory-vault）；e2e-m5-packaging 只用桥垫片（对 scripts/*.mjs 的 grep）。推断：在打包态剥掉它们不影响现有脚本。

**差距与建议**
- 用户环境里如果残留这些测试开关，DM 的打包版就会改变凭据的存储方式和数据来源。
- 建议：app.isPackaged 时，从 fork env 里删掉 DESKMINIS_E2E、DESKMINIS_TEST、DESKMINIS_FAKE_PROVIDER、DESKMINIS_FAKE_REPLY、DESKMINIS_MARKET_FIXTURE_URL。接线测试用 harness 已经记录的 h.forks 断言（tests/main-window-guard-harness.ts:102-103、205-207）。DESKMINIS_DATA_DIR 不在此列：W1a-9 有意支持它，它只改变数据位置。
- 规模约 5 行加 1 个用例。可以在 0.3.0 前做，也可以放进 0.3.x。性质：照抄改写（参照 DSH 的 development 门控写法）。

---

## 16. DevTools 与应用菜单

- DSH：
  - 打包版保留两个隐藏的菜单项 toggleDevTools，分别对应 Ctrl+Shift+I 和 F12（main.ts:844-854；README.md:19）。Windows 的应用菜单只装这两项。reload 和「重启 Host」只在开发态出现（:830-838）。
  - 更新 overlay 调用 `setMenu(null)`（update-overlay.ts:46）；登录窗按 F12 手动打开 DevTools（policy-test-auth.ts:95-99）；guest 在打包态关闭 devTools（browser-guests.ts:87）。
- DM：打包版菜单只留「编辑」和「视图」（缩放、全屏），没有重载，也没有开发者工具（app-menu.ts:13-29；tests/app-menu.test.ts:28-32）。开发态保留默认菜单（index.ts:30-34）。
- 判断：DM 更严，维持现状。

---

## 17. 渲染进程故障事件（稳健性，简记）

- DSH 的 main.ts:905-929 处理四类事件：
  - console-message 的 error 行进入崩溃报告尾部；
  - 主帧 did-fail-load（错误码不是 -3）判为致命；
  - preload-error 判为致命；
  - render-process-gone（不是 clean-exit）判为致命。
- DM：以上都没有处理。render-process-gone 已排进 W6a（roadmap.md W6a）。
- 建议：W6a 顺带接上 preload-error。preload 加载失败时 `window.deskminis` 不存在，rpc.connect 会在 rpc.ts:37 抛错，应该写日志并提示用户。性质：只借思路。

---

## 18. 其它小项

- 令牌比较改用 timingSafeEqual：见第 13 节，W6d 或 W6b，1 行。
- 更新诊断：DSH 的 technicalDetails 由主进程持有、默认折叠，不包含子进程输出和凭据（ipc.ts:33-34；host-process.ts:259-260 的注释）。DM 在 W2b-9 之后只显示一句中文，原文写到 stderr（index.ts:317-324）。两者相当。
- 更新授权：DSH 的渲染端不能指定制品，也不能授权安装（README.md:57；ipc.ts:61-70）。DM 的渲染端只能查询状态、开关自动检查和手动检查，安装确认用原生对话框（index.ts:307-315、357-362）。两者相当。
- 深链：DSH 注册 `dsh://`，只接受精确等于 `dsh://open` 的地址，其效果只是聚焦窗口（main.ts:1026-1030）；second-instance 也不读 argv。DM 不注册协议。无差距。

---

## 19. DeskMinis 已经同样好或更好的

- defaultSession 权限：DM 只放行本页的 clipboard-sanitized-write；DSH 对 media 以外的权限一律放行（microphone-permissions.ts:17-18、23-24）。**DM 更严。**
- 主窗口 will-navigate：DM 精确到 index.html 一个文件，解析失败即拒；DSH 放行任意主机的 dsh-app: 地址，而且 `new URL` 没有包 try。**DM 更严。**
- DevTools 与重载：DM 的打包版去掉了；DSH 打包版仍可按 F12 打开。**DM 更严。**
- webviewTag：DM 没开；DSH 主窗口开启，靠租约兜住。**DM 暴露面更小。**
- 更新安装确认：DM 用原生对话框，比 DSH 自绘 HTML 对话框再加 revision 校验更简单，效果相当。
- 外链：DM 交出规范化的 href，失败有 catch，终端链接先确认；DSH 主窗口直接打开。相当，DM 略好。
- webPreferences 的生效值、证书与代理（两边都不覆写）、单实例（DM 的 W1b-3，index.ts:64-77）：相当。
- 熔丝：两边都没加固，都依赖 RunAsNode。相当，这一项不是 DSH 的优势。
- 令牌寿命：DM 每次启动都换，比 DSH 短；但 DM 会落盘到 Roaming。各有取舍。
- 已有测试守卫：DM 的 ipc-contract、preload-wiring、main-window-guard 三种形态、app-menu、app-relaunch，覆盖面与 DSH 的 main-startup.spec 属于同一类做法。

---

## 20. 建议汇总（按波次）

| 波次 | 事项 | 性质 |
|---|---|---|
| 0.3.0 前（可选） | A. 打包态从 fork env 剥掉 5 个测试开关（第 15 节） | 照抄改写 |
| 0.3.0 前（可选） | B. createWindow 显式写 webPreferences，harness 记构造参数并断言（第 2 节） | 照抄改写 |
| 0.3.x（安全补丁线） | Electron 升级到当时受支持的大版本，真机全回归（第 1 节） | 只借思路 |
| W6a | 接上 preload-error；握手改走 parentPort，并逐类校验消息（第 14、17 节） | 只借思路 |
| W6b | 令牌不进渲染端：主进程注入请求头，minisd 兼收请求头并用 timingSafeEqual，minisd:info 只回端口（第 13 节） | 只借思路 |
| W6d | assertAppFrame 覆盖全部通道并解决时序；preload 门控；删除 minisd:port；API 面快照测试；externalUrlOf 拒 userinfo；attachments 体积上限（第 6、7、11 节） | 照抄改写 |
| W9a | 与 Markdown 工作区图片同批，给主文档加 meta CSP（第 4 节） | 照抄改写 |
| W9 或 0.6.0 后 | 自有特权协议替代 file://；之后评估 GrantFileProtocolExtraPrivileges 等熔丝，有代码签名时再动 asar 完整性相关项（第 3、5 节） | 只借思路 |
| 新内容面（OAuth 窗、HTML 预览、内置浏览器） | 独立非持久分区，权限全拒；拦截 will-redirect、will-attach-webview 和 will-download；取消 login；preload 精确门控；handler 随窗口生灭（第 7–12 节） | 照抄改写 |

不建议在 0.3.0 前临时加的：minisd:info 发送方校验（时序坑，见第 7 节）、主文档 CSP（需要全界面实拍）、令牌注入、更换协议、Electron 升级。

---

## 21. 未覆盖与待核

- 以下几点需要联网或实测核对：
  - Electron 的支持期政策，以及 38.x 的具体停更日期；
  - NodeOptions 熔丝与 NODE_EXTRA_CA_CERTS 的关系；
  - Windows 上拼写检查是否会外连；
  - Electron 38 能否改写 ws:// 握手的请求头；
  - 没有 select-*-device 监听、没有 setDisplayMediaRequestHandler 时的默认行为。
- DSH 的 apps/web 前端（渲染端）怎样渲染 Markdown 链接和 HTML，没有细读。
- DSH Host 的 webserver 监听地址没有核实（推断默认是回环地址；桌面端的端口固定为 19387，见 apps/desktop-host/src/index.ts:28）。
- DM 的 minisd JSON-RPC 方法级权限（按 authMode 区分）和桥（命名管道）的鉴权，不在本文范围内；桥的鉴权属于 W6d。
