# DeepSeek Harness 桌面端对照研读（2026-09-26）

> 用户原话：「参考一下 Deepseek harness desktop：Mac：…dmg  Windows：…exe」（附两个 0.1.7-rc.1.20260924.1 安装包链接）。
> 状态：**调研与建议**。和 0.3.0 有关的几条等用户拍板（§6）。本报告不改代码。
> 对象：DeepSeek Harness（DSH）桌面端 0.1.7-rc.1。
> - 用户给的两个安装包没下到：本环境的出网策略拒绝了 download.deepseek.com（代理返回 403），按规定没有绕行。
> - 改读本地已有的 DSH 源码克隆 `/home/user/refs/deepseek-harness`（HEAD 46a7f68b0，即 0.1.7-rc.1 的发版提交，MIT）。
>   安装包就是由这份源码打出来的，读不到的只是「装出来的实际观感」。
> - 9/24 的 `2026-09-24-resurvey/dsh.md` 粗读过全仓。这次只看桌面端，分六个方向细读，dsh.md 已写过的不再重复。
>
> 附录目录 `docs/research/2026-09-26-dsh-desktop/`：六份原稿，每条都带两边的「文件:行」。
> - `notes-release.md`：更新与发布
> - `notes-installer.md`：安装器与 Windows 集成
> - `notes-lifecycle.md`：进程与生命周期
> - `notes-security.md`：Electron 安全与 IPC
> - `notes-testing.md`：测试与工程纪律
> - `notes-ui.md`：界面与交互

## §0 结论

- **DSH 桌面端是同类 Electron 应用里工程纪律很强的一个。** 它有：
  - RunAsNode 拉起 Host，配类型化 IPC；
  - 单实例、准入锁更新、崩溃报告；
  - 自绘 NSIS 安装器，完整的 Windows 签名链；
  - 用真 Electron 驱动的资格测试。
- **止血波之后，DeskMinis 不少方面已经同样好或更好（§5）。** 例如托盘常驻、按天日志、关停预算、权限白名单、打包菜单、blockmap 校验与上传后回读、便携版。拓扑不用改。
- **最值得借的是「更新与发布」这一段，而且有几条和 0.3.0 直接相关。**
  - 0.3.0 是第一个公开版。0.3.0 → 0.3.1 这第一次自动更新，由 0.3.0 装进用户机器的代码执行，发出去以后就改不了。
  - 核对下来，有四处该在打包前定（§1），另有一组零代码的发版前核对（§2）。
- **其余借鉴按波次落位（§3）。** 和 O1–O7、F1 没有冲突，有几处需要调整路线（§4）。
- **不借的：**
  - 自绘安装页与 window-frame.dll：要 MSVC 工具链，还要给 DLL 签名，收益只在观感；
  - 目录事务；
  - 账号与强制更新、内测声明；
  - 语音与 Office 的重依赖；
  - 全套国际化；
  - 工作区优先的开局；
  - 开发者面。

## §1 0.3.0 打包前建议改的代码（冻结项）

以下四条的关键说法都由主会话对照源码亲自核过。没上 Windows 真机，推断处已标。

**U1 更新状态的文案说了不实的话**
- 现状：`autoInstallOnAppQuit = false`（`src/main/index.ts:290`）。所以普通退出、重启都不会安装，下次启动（开着自动检查时）只会再问一次。
- 但界面有三处说法不符：
  - 关于页写「新版已下载，重启后生效」（`src/renderer/src/ui/settings/SecAbout.vue:23`）；
  - 托盘回执写「重启应用后生效。」（`src/main/update-status.ts:155`）；
  - 下载完成框写「下次启动时再装」（`index.ts:311`）。
- 建议：三处都改成如实的说法。例如：「点『重启并安装』才会装；关掉 DeskMinis 不会自动装，之后从托盘『检查更新…』可以再装」。
- 成本：只改文案和对应测试。

**U2 更新失败的原文只写进 stderr**
- 现状：`index.ts:322` 只写 stderr。打包后的 GUI 没有控制台，`src/minisd/diag/daily-log.ts` 开头自己就写明了这一点。界面上只有截断到 120 字的一句。
- 建议：error 回调里加一行 `minisdLog.append('[update] …')`，再加一条源码守卫。
- 为什么是冻结项：0.3.0 → 0.3.1 如果失败，能不能查到原因，全靠 0.3.0 里的这一行。

**U3 「重启并安装」实际打开的是安装向导**
- 现状：`autoUpdater.quitAndInstall()` 不带参数（`index.ts:315`）。
  - electron-updater 6.8.9 这时不传 `/S`（`BaseUpdater.js:13-16`；`NsisUpdater.js:101-113`）；
  - NSIS 模板里，「安装选项」页不会因为是更新就跳过（`multiUserUi.nsh:31-66`）。许可页和目录页才有 `skipPageIfUpdated`；
  - 完成页要用户点「完成」才启动新版（`assistedInstaller.nsh:46-64`；`installSection.nsh:104-109`）。
- 推断：用户会依次看到「为谁安装」页（旁边就是带 UAC 盾牌的「所有用户」）、进度页和完成页；而对话框说的是「现在重启即可用上新版本」。
- 默认建议：**0.3.0 保留向导，只改对话框文案**，说清三件事：会打开安装程序；保持默认选项；最后一页点「完成」。
- 为什么不照抄 DSH 的静默安装：
  - DSH 用 `quitAndInstall(true, true)`，静默安装、装完自启，但它有目录事务兜底回滚；
  - DeskMinis 用的是默认模板。静默模式下复制一旦失败就直接退出，用户看到的是应用没了，新版也没起来；
  - 所以静默化等 W6a 做完「安装失败就地恢复」再议。
- 例外：§2-C 的更新演练如果发现向导体验不可接受，打包前改成 `(true, true)`，也只是一行代码加一条测试正则。

**U4 任务栏固定项可能和运行中的窗口分成两个按钮（推断）**
- 现状：
  - 安装器给快捷方式写的 AUMID 是 appId `com.deskminis.app`（模板 `include/installer.nsh` 的 `WinShell::SetLnkAUMI`）；
  - 主进程从没调用 `app.setAppUserModelId`（src 全文 grep 为空）；
  - Electron 没有显式 AUMID 时，会自行生成 `electron.app.<名>`（凭对 Electron 源码的记忆，未核实）。
- 默认建议：打包态加一行 `app.setAppUserModelId('com.deskminis.app')`，并用测试钉住它与 `electron-builder.yml` 的 appId 一致。
- 为什么提前：用户的固定项会长期留在机器上，晚改会让老固定项失配。路线 W7b 本来就排了这一行，这里只是提前。

**不挡 0.3.0、可以放 0.3.x 的三条**
- **更新请求没有空闲超时。**
  - 机理：electron-updater 的超时挂在 `request.on('socket')` 上（`builder-util-runtime/out/httpExecutor.js:278-285`），而 Electron 的 ClientRequest 没有这个事件，所以超时永远不会生效。
  - 后果：检查一旦卡住，后面所有检查都接在同一个 promise 上（`AppUpdater.js:257-275`）。托盘「检查更新…」就一直没有回执，要重启才恢复。
  - 改法：根治是照 DSH 的 `update-http-executor.ts`（53 行）改写；最小止血是给托盘回执加 20 秒超时。
- **打包态仍然认测试开关。**
  - 现状：fork minisd 时下发的是整份环境（`index.ts:110-120`）。下面几个开关在装机版里照样生效：
    - `DESKMINIS_E2E`：改用明文凭据文件；
    - `DESKMINIS_TEST`；
    - `DESKMINIS_FAKE_PROVIDER`、`DESKMINIS_FAKE_REPLY`；
    - `DESKMINIS_MARKET_FIXTURE_URL`。
  - 改法：打包态把它们剥掉，约 5 行加 1 个用例。
- **webPreferences 只写了 preload**（`index.ts:239`）。生效值和显式写法相同，差的只是写明加守卫。

## §2 0.3.0 发版前的零代码核对（建议写进 RELEASE.md）

**A. 覆盖运行中的 0.1.1**（约 15 分钟，真机）
- 步骤：装 0.1.1，建会话、配 key，关窗藏到托盘；再运行 0.3.0 的 Setup。
- 为什么要做：
  - 0.1.1 的更新源是私仓，永远 404，所以老用户只能手动覆盖安装；
  - 0.1.1 常驻托盘，而且没有单实例锁；
  - RELEASE §3 目前只测干净安装。
- 预期：
  - 选择页默认「仅为我」；
  - 提示「正在运行，点确定关闭」；
  - 旧卸载器以 `/KEEP_APP_DATA --updated` 运行；
  - 会话、key 都在，DB 迁移跑过；
  - 快捷方式只有一份，「应用和功能」里也只有一条。

**B. e2e:m5 会动本机已装的 DeskMinis**（一句文档，或脚本约 10 行）
- 它用同一身份静默安装到临时目录（`scripts/e2e-m5-packaging.mjs:161`）。
- NSIS 会先静默卸掉本机已装的那份（数据保留），并结束正在运行的实例。
- 跑完只删目录、不跑卸载器（:173-175），注册表和快捷方式就指向已删除的目录（推断，据模板）。
- 做法二选一：
  - 先从托盘退出，事后按 §3 重装；
  - 给脚本加 finally 静默卸载。DSH 的安装器冒烟每次用随机的独立身份（`test-windows-installer.mjs:21-25`）。

**C. 更新交接演练**（约 30 分钟，真机）
- 步骤：
  1. 装好 0.3.0，把它的 `resources\app-update.yml` 改成 `provider: generic`，指向本机 http；
  2. 本地打一个绝不上传的高一版，如 `0.3.1-rehearsal.1`。要关掉 detectUpdateChannel 才会产出 latest.yml；
  3. 走一遍：检查 → 下载 →「重启并安装」。
- 为什么现在做：这段代码随 0.3.0 定型，演练不用等 0.3.1。
- 顺带看几件事：
  - 向导实际长什么样（U3）；
  - 主窗口藏在托盘时，下载完成框看不看得见。这个框挂在 `getAllWindows()[0]` 上（`index.ts:298`）；
  - 装完数据是否都在，关于页版本号是否正确。
- 说明：改 app-update.yml 切到 generic 源这一招属推断。

**D. 只杀主进程**（2 分钟，真机）
- 步骤：在任务管理器的「详细信息」里，只结束不带 `--type=` 的那个 DeskMinis.exe。看其余 DeskMinis.exe 是否几秒内都退出，再启动是否正常。
- 为什么：DeskMinis 靠 Chromium 在主进程死后回收 utility 进程（推断）。如果 minisd 活下来，它还握着数据根锁，下次启动会报「已在运行」，而这时已经没有托盘可以退出它。

**E. 任务栏固定**（1 分钟，真机）
- 步骤：从开始菜单启动 → 固定到任务栏 → 退出 → 点固定项启动，看是否只有一个按钮。
- 用途：验证 U4。如果已按默认加了那一行，就是验证它有效。

**F. 构建前清空 `dist/`，并确认 `npm run dist` 退出码为 0**（一行文档）
- 原因：verify-release 只能证明四件产物彼此一致，证明不了它们出自这次构建。

**G. 版本纪律**（一行文档）
- 已发布的版本号永不复用。
- 发现问题一律升 patch 重发，不在同一个 Release 下换构建。
- 依据：DSH README 就是这样规定的；electron-updater 按版本号判断是否更新。

**H. 发布账号就是更新的信任根**（几分钟）
- 背景：0.3.0 没有签名。没有 publisherName 时，electron-updater 跳过签名校验（`NsisUpdater.js:84-100`）。
- 要做的：GitHub 账号开 2FA；确认 `deskminis-releases` 没有其他写权限者，也没有第三方 App 的写授权。

**I. README 安装一节补两句**（文档）
- 提示「DeskMinis 无法关闭」但它其实没在运行时，多半是安全软件拦截了文件。原因是默认模板把任何复制失败都报成「无法关闭」（`extractAppPackage.nsh:108-117`）。
- Windows 11 开了「智能应用控制」时，未签名安装包会被直接拦截，没有「仍要运行」（推断）。README 现在只写了「更多信息 → 仍要运行」。

## §3 借鉴清单（按波次）

「出处」一列指附录原稿的章节。

| 波次 | 条目 | 借法 | 出处 |
|---|---|---|---|
| 0.3.x 补丁线 | 更新请求空闲超时（§1 末） | 照抄改写 | lifecycle §12.1；release §2.3 |
| 0.3.x | 卸载时删 `%LOCALAPPDATA%\deskminis-updater`；照抄「更新时不删」「带 /KEEP_APP_DATA 不删」两道闸；数据根不删 | 照抄改写，约 10 行 NSIS | installer §10 |
| 0.3.x | 只装当前用户：`nsis.allowElevation: false` | 一行配置 | installer §4；release §7.2 |
| 0.3.x | 打包态剥测试开关；显式写 webPreferences（若 0.3.0 没做） | 照抄改写 | security §15、§2 |
| 0.3.x | Electron 升级到当时受支持的大版本（需同意，见 §6） | — | security §1 |
| 0.3.1 | 构建出处（commit、dirty）写进产物，关于页显示；打包全部成功才写完成记录，verify-release 核对；Release 先存草稿，回验通过再发布 | 只借思路 | release §4.2、§4.3、§5.1 |
| W3 后、0.3.1 前 | `scripts/qualify-updater.mjs`：回环假更新源加模式表（feed-404、stall、corrupt、ENOSPC 等），`quitAndInstall` 换成记录调用 | 只借思路，零依赖 | testing I1 |
| W3 后 | `scripts/smoke-installer.ps1`：安装器冒烟每次用随机独立身份；RELEASE §3 改成「证据位置 + 结果（缺省 pending）」表 | 只借思路 | testing I2、I3 |
| W4a | 欢迎页开场示例换成办公向 | — | ui §12.2 |
| W4b | 主库不引 Playwright：用 Electron 自带的 executeJavaScript、sendInputEvent、debugger、capturePage 驱动真窗口（DSH 桌面端就是这么做的）；按文件后缀分道；SSR 子组件记号；脚本队列与 HTTP 假端点；可读期望文件；代理变量清理 | 只借思路 | testing §2、§5 |
| W4c | 首启服务商预设与 Key 引导，与 `detectCompat` 共用一张厂商表 | 只借思路 | ui §1 |
| W5b | 删任务面板时，把「上轮结束原因」和 70%/90% 水位提示迁进对话流与占用环 | — | ui §12.1 |
| W6a | 见表下 | 多为只借思路 | lifecycle §19 A–J；installer §6 |
| W6b | 令牌不进渲染端：主进程注入请求头，minisd 用 timingSafeEqual 比较，`minisd:info` 只回端口；RPC 计数预算 | 只借思路 | security §13；testing U4 |
| W6d | 见表下 | 照抄改写 / 只借思路 | security §6、§7、§11；installer §21；testing E4 |
| W7b | 见表下 | 照抄改写 / 只借思路 | ui §4.1、§5、§10；installer §16、§17 |
| W7c | aria-live 只在状态跃迁时播报 | 照抄改写 | ui §13 |
| W8a | 「用系统程序打开」走 explorer.exe 加 file URI（`,` 和 `=` 做百分号编码）。先真机核对：默认程序只记在 UserChoiceLatest 的 Win11 上，`shell.openPath` 是否同样失灵 | 只借思路 | installer §19 |
| W8b | 改动卡：cowork 默认先给交付卡，再给「撤销本回合」，差分收进展开区（设计稿里定） | — | ui §6.2 |
| W8c | 置顶：已有列和分组，缺写入入口，补 `chat.sessions.setPinned` 和行菜单项；删技能目录时不跟随 junction | — | ui §3.5；lifecycle §15 |
| W9 | 安装器观感：`ManifestDPIAware`、中文用雅黑、品牌侧栏 BMP、多尺寸图标；显式写 `electronFuses: { runAsNode: true }` 并注明依赖 | 照抄改写 | installer §2、§3、§21 |
| W9a | 主文档加 meta CSP（与 Markdown 工作区图片同批）；性能判据 B1–B9 | 照抄改写 / 只借思路 | security §4；testing §6 |
| W9b | 编辑右键菜单（路线漏项） | 只借思路 | ui §8.1 |
| W9c | 窗口先隐藏、载入后再显示，底色按主题 | 只借思路 | lifecycle §13 |
| 签名立项时 | publisherName 取证书 DN；未签名构建不带 feed；设 channel 后显式关降级 | 只借思路 | release §1.4、§6 |
| 纪律（AGENTS.md 那一项） | 空 catch 棘轮；拒绝掩盖型修复；单一来源与行数棘轮；改动面 → 证据对照表 | 只借思路 | testing §7 |

**W6a 的条目**
- 渲染端失败面：console 错误行写进日志；did-fail-load、preload-error、render-process-gone 要处置。
- minisd 致命退出前，做有上限的收尾。
- launcher 状态机。
- 「重启并安装」失败后就地恢复引擎。
- 周期检查更新：带抖动与退避，resume 时补查。
- 关停回执写进日志。
- 安全模式做成一次性启动标志。
- 安装器的 `customCheckAppRunning`：先请用户从托盘退出，强杀只作兜底。

**W6d 的条目**
- IPC 全通道校验主窗口主框架。
- preload 门控。
- 删掉 `minisd:port`。
- API 面快照测试。
- 外链拒绝带 userinfo 的地址。
- 附件体积上限。
- 子进程环境去掉 `RIPGREP_CONFIG_PATH`，或据此收紧 rg 免审。
- 删目录时先解链 junction 再删。

**W7b 的条目**
- 注意力回路：flashFrame 加一次静默通知。
- 首次关窗、隐藏到托盘时告知用户。
- 输入法回车守卫补全成三道闸，写成纯函数 `enter-guard.ts`。
- 审批卡目前「先删卡再发 RPC」（`src/renderer/src/stores/chat.ts:611-614`），改成失败可恢复。
- 可选：下载进度显示到任务栏；开机自启（默认关，卸载时清 Run 值）。

**许可**
- DSH 是 MIT。THIRD-PARTY-NOTICES §5「仅借思路」已经登记了 DSH。
- 上表「照抄改写」的几项，如果只是按思路重写几行配置或宏，在 §5 追加一行即可。
- 一旦复制 DSH 源文件，就新开一节并加文件头。`tests/license-consistency.test.ts` 会双向核对。

## §4 对已拍板路线的调整

1. **首启服务商预设与 Key 引导没有排进任何子波。** 建议作为 W4c 的界面子项，也可以随 W4a（0.3.1）先出轻量版。
2. **W5b 删任务面板会丢两样东西：** 上轮结束原因（maxTokens、refusal）和 70%/90% 水位提示。要在同一个提交里迁走，并用 SSR 渲染测试钉住。
3. **W7b 要更正依据，并补两项。**
   - 更正依据：DSH 只对「更新就绪」做注意力提示，审批既没有通知也没有超时。机制照搬没问题，但必要性来自 DeskMinis 自己的 90 秒审批超时。
   - 补「首次关窗隐藏到托盘时告知」。
   - 输入法守卫从只看 keyCode 229，补全为三道闸：isComposing、compositionend 后 10ms 保护窗、repeat 与 Shift+Enter。
     - 为什么不挡 0.3.0：Windows 上 Chromium 在组字时，keydown 报的是 `Process`/229，`Composer.vue:351` 的 `.enter` 修饰符大概率本来就不会触发。
4. **编辑右键菜单是路线漏项。** DeskMinis 没有任何右键菜单，输入框里复制粘贴只能靠快捷键。放 W9b，或随界面减法一起做。
5. **W6a 范围扩大**，加入 §3 列的 W6a 条目。最要紧的是更新空闲超时和周期检查：DeskMinis 常驻托盘，一个实例可能连跑数周，现在只在启动时查一次（`index.ts:439`）。
6. **Electron 版本。**
   - 现状：DeskMinis 在 38.8.6，DSH 在 44。
   - 判断：Electron 每 8 周一个大版本，只支持最近三个。照这个节奏，38 大概率已出支持期，不再有 Chromium 安全补丁（推断，未联网核实）。
   - 升级属于依赖版本变更，要先得到同意（§6-3）。

## §5 DeskMinis 已经同样好或更好的

- **托盘**：常驻托盘，加单实例唤出。DSH 没有托盘，关窗即退出。
- **日志**：有按天日志和主进程崩溃记录，日志放在 `%LOCALAPPDATA%`，不随漫游。DSH 两样都没有，日志在 Roaming。
- **关停**：时间预算由测试钉住，第 6 步会等进程树回收。DSH 的升级梯在 Windows 上实际只相当于一次硬杀（推断）。
- **锁与端口**：数据根锁带接管闸；端口不固定，没有 DSH 那种与 Web 端抢 19387 端口的失败面。
- **权限与窗口**：以下几项都比 DSH 严——
  - 权限白名单只放行本页的剪贴板写入；
  - 主窗口导航守卫精确到 index.html；
  - 打包版去掉了重载和 DevTools；
  - 没有开 webview。
- **发布**：
  - blockmap 校验更严；
  - 上传后下载回来再验一遍；
  - 更新源的最后一道闸会拦住私有仓；
  - 更新错误分类更细，原文不进界面；
  - 便携版不自动更新；
  - 自动检查可以关。
- **安装**：默认模板的「先原子搬走旧目录，再复制」，对 DeskMinis 约百个文件的载荷已经够用。DSH 的目录事务是为 1.1 万个散文件做的，DeskMinis 不需要。

## §6 需要拍板的事（括号内为默认建议）

1. **0.3.0 打包前要不要先合一个小补丁**（要）。
   - 内容：U1 文案、U2 更新错误写进按天日志、U3 对话框文案（保留向导）、U4 AUMID 一行。
   - 规模：一个步骤，含测试约半天。
   - 如果你已经在打包，也可以不合，0.3.1 再修。代价是 0.3.0 → 0.3.1 这一次更新的提示不准，失败时查不到原因。
2. **§2 的发版前核对写进 RELEASE.md**（写，随补丁一起）。其中 A、C、D、E 要在 Windows 真机上做。
3. **Electron 从 38 升到当时受支持的大版本**（同意升）。
   - 排在 0.3.x 安全补丁线，单独一步，真机全回归，不挡 0.3.0。
   - 这是依赖版本变更，需要你点头。
4. **§1 末尾三条放 0.3.x**（是）。三条是：更新空闲超时、剥测试开关、显式 webPreferences。
5. **§3 借鉴清单与 §4 路线调整写进路线详案**（写）。拍板后改 roadmap.md 各波范围。

## §7 方法与局限

- **怎么读的**：六路并行静态读码，方向是更新与发布、安装器与 Windows 集成、进程与生命周期、Electron 安全与 IPC、测试与工程纪律、界面与交互。全程只读，不联网，不运行任何一方的代码。
- **主会话亲自复核了 §1、§2 引用的关键说法：**
  - electron-updater 6.8.9 的 `quitAndInstall` 缺省参数，以及传给 NSIS 的参数拼装；
  - NSIS 模板（app-builder-lib 26.15.3）的安装选项页没有更新跳过，完成页只在点击后启动；
  - `checkForUpdates` 复用同一个 promise；超时挂在 socket 事件上，而 Electron 38 的 ClientRequest 没有这个事件；
  - `e2e-m5-packaging.mjs` 用同一身份静默安装，且事后不卸载；
  - `index.ts` 的更新代码与三处文案；
  - fork 时整份环境下发。
- **没在 Windows 上复现的推断**，集中在这几处：
  - 更新时实际出现的向导；
  - AUMID 的默认行为；
  - 主进程死后 utility 进程是否退出；
  - 智能应用控制；
  - 隐藏父窗口下的对话框能否被看见。
  §2 的真机核对就是为这些准备的。
- **观感部分**：安装包本身没下到（见开头），所以 DSH 安装器与界面的实际观感只按源码、设计笔记和 README 描述。
