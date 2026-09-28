# DeskMinis 0.3.0 发版前真机验证报告

| 项目 | 内容 |
|---|---|
| 时间 | 2026-09-27 21:50 → 2026-09-28 00:55（UTC+8） |
| 机器 | Windows 10 Enterprise LTSC 2021（19044），3840×2160，系统默认中文输入法 |
| 源码 | `lincheuk/Deskminis` main @ **`d1c9a2f`**（本地原先落后 144 个提交，已快进） |
| 依据 | `docs/RELEASE.md` 第 0–3 节中的验证部分 |
| 边界 | **只验证不发布**：未 push、未建 Release、未上传、未改 CHANGELOG、未改代码、未提交 |
| 执行 | 前半程与用户交互；用户睡前授权后，第 3 节由 Claude 全程接管桌面完成 |

---

## 1. 结论

**不建议按现状发版。** RELEASE.md 规定「有 FAIL 就停」，本次有 2 项失败：

| 级别 | 问题 | 性质 |
|---|---|---|
| 🔴 阻塞 | 定时任务改了「间隔」后，「创建 / 保存」**毫无反应、没有任何提示** | 产品 bug，用户可见 |
| 🟡 阻塞（测试） | `npm test` 有 1 例在 UTC+8 下稳定失败 | 测试本身依赖时区，产品行为是对的 |

另有 2 个需要处理的发现：

- `e2e:m5` 跑完后照常重装，会**静默装进已删除的 Temp 目录**，RELEASE.md 的说法不成立；
- agent 的 shell 在 Windows 默认执行策略下**跑不了 `npm`**。

其余项全部通过，包括用户点名的两个重点：**任务栏固定**和**更新交接演练**。

---

## 2. 结果总表

### 第 1–2 节：构建与打包验收

| 项 | 结果 | 证据 | 备注 / 失败原文 |
|---|---|---|---|
| git 同步到 d1c9a2f | ✅ 通过（附条件） | HEAD=`d1c9a2f`，已跟踪文件零改动 | 有 87 个历史未跟踪文件（G1–G4 日志、探针脚本、截图），未动；它们不进打包、测试或 typecheck |
| `npm ci` | ✅ 通过（第 2 次） | `01-npm-ci.log`、`01b-npm-ci-proxy.log` | 第 1 次：`RequestError: connect ETIMEDOUT 20.205.243.166:443`。见 §3.5 |
| `npm test` | ❌ **失败 1 例** | `02-npm-test.log`；时区对照 `02b`、`02c` | 253 个文件 / 3633 例：3624 通过、1 失败、8 跳过（只在 POSIX 上跑的用例）。52 例 Windows 专属用例全部通过。见 §3.6 |
| `npm run typecheck` | ✅ 通过 | `03-typecheck.log` | 零错误 |
| 清空 dist → `npm run dist` | ✅ 通过 | `04-npm-dist.log` | 退出码 0；构建前本来就没有 `dist/`；产物未签名 |
| `npm run verify:release` | ✅ 通过 12/12 | `05-verify-release.log` | — |
| `npm run e2e:m5` | ✅ 通过 13/13 | `06-e2e-m5.log` | 跑之前确认过本机没在运行、也没安装 DeskMinis。副作用见 §3.3 |
| `npm run smoke:release` | ⏭️ 跳过 | — | `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY` 在进程、用户、系统三个范围里都没设 |

### 第 3 节：手动冒烟（安装版）

| 项 | 结果 | 证据 | 备注 |
|---|---|---|---|
| 干净目录安装，默认「仅为我」 | ✅ | `shots/01b`、`03` | 原数据目录已先挪开。没弹 SmartScreen（本机构建无「来自网络」标记），也没弹 UAC |
| 完成页「运行 DeskMinis」 | ✅（初测误报已排除） | `shots/04b` | 初测弹「找不到文件」，查明是自动化环境造成的，见 §3.4 |
| 覆盖安装运行中的 0.1.1 | ⏭️ 跳过 | — | 本机全盘找不到 0.1.1 安装包 |
| 新图标（任务栏 / 开始菜单 / 桌面 / 托盘 / 安装向导） | ✅ | `shots/06`、`56`、`57b` | 都是蓝底三横线 |
| 首启欢迎屏、配 provider、「当前默认」高亮 | ✅ | `shots/07`、`20` | 用本地假端点配 provider，没用任何真 key |
| **权限卡（必验项）** | ✅ | `shots/21`、`24`、`mock-openai.log` | 卡片出现；允许、拒绝、超时自动拒绝三条路径都通。另见 §3.2、§3.7 |
| 助手卡：emoji 前缀 + 规则生效 | ✅ | 系统提示里带 `<assistant_preset name="代码助手">` | 会话名是「💻 代码助手」 |
| **定时任务** | ❌ **失败** | `shots/44`、`45`、`47`、`48` | 改间隔就静默失败，见 §3.1。不改间隔时：⏰ 会话出现、状态回流「上次 ok」 |
| Office 生成 docx 并预览 | ✅ | `shots/28` | 渲染出标题、正文、表格，顶部有「内容预览…不还原」提示条 |
| 终端抽屉 | ✅ | `shots/30` | 能回显，当前目录是会话工作区；首行漏出一行 `#< CLIXML`（§3.9） |
| 外链交给系统浏览器 | ✅ | `shots/33` | 由 Chrome 打开，应用里不多开窗口，主窗口也没被替换 |
| 打包版快捷键 | ✅ | — | Ctrl+R 不重载；Ctrl+Shift+I 不开开发者工具；Ctrl+Shift+= / Ctrl+- / Ctrl+0 能缩放；F11 能全屏。不按 Shift 的 Ctrl+= 不放大（§3.9） |
| 按天日志；数据目录里没有 logs | ✅ | `minisd-2026-09-27.log`、`-28.log` | 跨午夜自动切到新文件 |
| 扩展市场搜索 | ✅ | `shots/39` | 搜「pdf」能从 ClawHub 出结果 |
| 任务面板上下文水位 | ✅ | — | 「上下文 368 / 128.0k · 0%」 |
| 深浅主题三态 | ✅ | `shots/41-*` | 深色背景 `#0E0E0E`，浅色 / 跟随系统 `#FFFFFF` |
| 单实例 | ✅ | — | 点关闭后隐藏到托盘；再双击图标，回来的是同一个窗口、同一个主进程 |
| 托盘退出无残留 | ✅ | — | 1 秒内 5 个 DeskMinis 进程和 3 个 PowerShell 全部退出，锁已释放 |
| 只结束主进程 | ✅ | — | 其余进程 1 秒内退出；残留的 `minisd.lock` 在重启时被正常接管，没报「已在运行」 |
| 关于 → 现在检查 | ✅ | `shots/49` | 「更新失败 · 发布页上还没有可用的版本（发布仓库不存在，或还没发过正式版）」 |
| 便携版冒烟 + 「现在检查」 | ✅ | `shots/64` | 「便携版不自动更新，请到发布页下载新版」；不下载任何东西；和安装版共用同一份数据；退出后解压用的临时目录被清掉 |
| 托盘「检查更新…」回执 | ✅ | `shots/53` | 回执框不挡主窗口（显示期间主窗口仍可用） |
| **任务栏固定** | ✅ | `shots/57b`、`59`、`61`、`62` | 固定项的 AUMID 是 `com.deskminis.app`；退出后点固定项启动，任务栏上始终只有一个按钮 |
| **更新交接演练 1–7 步** | ✅ | `07-rehearsal-build.log`、`static-8000.log`、`shots/67`–`79` | 详见 §4 |
| 断网后「现在检查」 | ◐ 替代验证通过 | `shots/65`、`66` | 「更新失败 · 连不上更新服务器（离线或网络受限）」。真断网要改系统网络设置，没做 |
| 安装目录下的 LICENSE / 第三方声明 | ✅ | 哈希与仓库根的原件一致 | — |
| 卸载后数据保留 | ✅ | — | `%APPDATA%\DeskMinis`、`%LOCALAPPDATA%\DeskMinis`、`%LOCALAPPDATA%\deskminis-updater` 三处都在；卸载还会顺带清掉任务栏固定项 |

---

## 3. 出错时有没有提示 · 是什么问题 · 怎么引导解决

> 每条都按四栏写：用户能看到什么 / 问题本质 / 用户侧怎么办 / 产品侧怎么改。

### 3.1 🔴 定时任务改了间隔后「创建 / 保存」没反应

- **用户看到什么：没有任何提示。** 表单不关，列表不变，页面自带的错误行（`StageCron.vue:105` 的 `errline`）也不出现。渲染层**没有全局错误兜底**（整个 renderer 找不到 `unhandledrejection` 或 `app.config.errorHandler`），用户只会觉得「按钮坏了」。
- **复现**：
  - 新建任务 → 把间隔从 30 改成 5 → 点「创建」：没反应；
  - 不改间隔（保持默认 30）：能建成；
  - 编辑已有任务并改间隔 → 点「保存」：同样没反应。
- **问题本质**：
  - `StageCron.vue:127` 的间隔框是 `<input v-model="fInterval" type="number">`，Vue 3.5 对 `type="number"` 会**自动把值转成数字**（`@vue/runtime-dom` 里的 `castToNumber`）；
  - `fInterval` 初值是字符串 `'30'`（`:21`），用户一改就变成数字 5；
  - `:48` 的 `fInterval.value.trim()` 对数字抛出 TypeError；
  - 这个调用发生在 `save()` 构造参数时（`:55`），在 `try`（`:60`）之外，于是变成一个无人处理的 Promise 拒绝。
- **用户侧临时办法**（以防这版已经发出去；读码推断，未实测）：「什么时候跑」改选「按 cron 表达式」，填 `*/5 * * * *`。cron 输入框是文本型，不受这个问题影响。
- **产品侧怎么改**：
  1. 改成 `String(fInterval.value).trim()`，或统一用 `v-model.number` 并按数字校验；
  2. 把参数构造挪进 `try`，保证任何异常都能落到 `errline`；
  3. 校验失败时给中文提示，比如「间隔要是 ≥ 1 的整数分钟」；
  4. 补一条 `renderer-*.test.ts` 源码守卫（`.vue` 不在 typecheck 覆盖范围内，协作纪律要求配守卫）；
  5. 考虑加一个渲染层的全局兜底（`app.config.errorHandler` + `unhandledrejection`），至少弹一句「操作没成功：…」，别再出现无声失败。

### 3.2 🟠 agent 跑 `npm`（以及 npx / pnpm / yarn）失败

- **用户看到什么**：对话里显示「已执行 1 步 · 1 步失败」，展开后是 PowerShell 的原始报错，没有任何产品侧的解释：
  > npm : 无法加载文件 C:\Program Files\nodejs\npm.ps1，因为在此系统上禁止运行脚本。有关详细信息，请参阅 https:/go.microsoft.com/fwlink/?LinkID=135170 中的 about_Execution_Policies。
- **问题本质**：
  - Windows 10/11 客户端的默认执行策略是 Restricted（本机所有作用域都是 Undefined）；
  - `src/minisd/tools/shell.ts:87` 起 PowerShell 用的是 `-NoProfile -NoLogo -NonInteractive -EncodedCommand`，没带 `-ExecutionPolicy Bypass`；
  - PowerShell 会优先解析到 `npm.ps1` 垫片，于是被执行策略挡住；
  - 同时 `src/minisd/tools/permissions.ts:21` 把 `set-executionpolicy` 列为危险命令，agent 也没法自己修。
  - 终端抽屉的 PowerShell 用的是同样的起法（`src/minisd/terminal.ts:90`），多半有同样问题，但没单独验证。
- **用户侧怎么办**：
  - 自己在 PowerShell 里执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`（agent 被规则拦下是合理的，这一步应由用户自己做）；
  - 或者让 agent 改用 `npm.cmd`。
- **产品侧怎么改**：
  - 起 PowerShell 时加 `-ExecutionPolicy Bypass`，只作用于这个进程，不改系统设置；
  - 或在工具说明里提示模型在 Windows 上用 `npm.cmd` / `npx.cmd`；
  - 输出里识别到 `about_Execution_Policies` 时，附一句中文说明和上面的解决办法。
- **对 RELEASE.md 的影响**：检查单建议的权限卡测试命令 `npm view left-pad`，在默认策略的机器上会「权限卡照常弹出，但命令本身失败」，验收时别误判成权限卡的问题。

### 3.3 🟠 `e2e:m5` 之后照常重装，会静默装进 Temp

- **用户看到什么**：安装向导第一页只有一行小字：
  > 已经存在一个安装到当前用户的安装.(C:\Users\phainion\AppData\Local\Temp\DeskMinis Install XUroiQ\Program Files\DeskMinis) 即将重新安装/升级.

  这行路径太长，折行后压到了底部分隔线上；向导里没有目录页，用户看不出、也改不了装到哪。
- **问题本质**：
  - `e2e:m5` 用 `/S /D=<临时目录>` 静默安装，跑完只删目录、不跑卸载，于是 `HKCU\Software\ecb7325e-e9df-5c5e-b187-bf7bd15b6aa7\InstallLocation` 一直指向那个已删的 Temp 路径；
  - NSIS 模板（`app-builder-lib/templates/nsis/multiUser.nsh:26-28`）按仅为我安装时，优先用这个值当安装目录；
  - `electron-builder.yml` 没开 `allowToChangeInstallationDirectory`，所以没有目录页；
  - 旧卸载程序不存在也不会报错，只在日志里写一行「Not able to launch uninstaller!」就继续装。
- **影响面**：只影响跑过 `e2e:m5` 的开发机或发版机，普通用户碰不到。但如果开发机上原本装着正式版，跑一次就会被「搬」进 Temp，之后存储感知或磁盘清理可能把程序本体删掉。
- **已经中招怎么办**：在「应用和功能」里卸载一次（数据保留），再装就回到 `%LOCALAPPDATA%\Programs\DeskMinis`。本次实测有效。
- **产品侧 / 文档怎么改**：
  - `e2e:m5` 跑完先执行安装目录里的 `Uninstall DeskMinis.exe /S`（或删掉那两个 HKCU 键）再删目录；
  - RELEASE.md 第 2 节把「跑完重装一次就恢复」改成「跑完先在『应用和功能』里卸载那条 DeskMinis，再按第 3 节安装；装之前看一眼向导第一页的路径是不是 `…\AppData\Local\Programs\DeskMinis`」。

### 3.4 ✅（误报已排除）安装完成页「运行 DeskMinis」报找不到文件

- **看到的提示**（Explorer 弹框）：
  > Windows 找不到文件 'C:\Users\phainion\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\DeskMinis.lnk'。请确定文件名是否正确后，再试一次。
- **查明**：
  - 只在安装包由 Claude 应用派生的进程启动时出现；这时让 Explorer 打开开始菜单目录下**任何** `.lnk` 都会失败，指向记事本的对照快捷方式也一样；
  - 由 Explorer 启动安装包（即用户双击），或由应用自更新拉起安装程序时，完成页都能正常启动应用，本次两种情况都实测过。
- **引导**：用户无需处理。测试人员应**双击** Setup.exe，不要从脚本或终端启动，否则会误判。

### 3.5 🟡 `npm ci` 下载 Electron 超时（发版机网络）

- **看到的报错**：
  > npm error command C:\WINDOWS\system32\cmd.exe /d /s /c node install.js
  > npm error RequestError: connect ETIMEDOUT 20.205.243.166:443

  而且 `npm ci` 开头已经清空了 `node_modules`，失败后整个仓库处于不可用状态，这一点没有任何提示。
- **问题本质**：Electron 的下载器 `@electron/get` 默认不读 `HTTPS_PROXY`，直连 GitHub 超时；本机缓存里的 zip 当初是经 npmmirror 下载的，这次镜像地址不同，所以没命中缓存。
- **建议写进 RELEASE.md 第 1 节**（国内网络二选一）：
  ```powershell
  # 走本机代理
  $env:ELECTRON_GET_USE_PROXY = "1"; $env:GLOBAL_AGENT_HTTPS_PROXY = "http://127.0.0.1:<代理端口>"
  # 或走镜像（能命中以前经镜像下载的缓存）
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  ```

### 3.6 🟡 `npm test` 时区用例

- **失败原文**：
  > FAIL tests/nav-group.test.ts > groupSessions > 「今天」按自然日算而非 24 小时：凌晨的会话与此刻同组，昨晚的进昨天
  > AssertionError: expected [ '今天' ] to include '昨天' ❯ tests/nav-group.test.ts:49:20
- **问题本质**：
  - 测试（`:42-50`）用 `Date.UTC` 构造「凌晨」和「昨晚」，而实现（`src/renderer/src/lib/nav/group.ts:23`）用的是本地午夜 `setHours(0,0,0,0)`；
  - 在 UTC+8 下，「昨晚 23:30 UTC」是本地次日 07:30，和「此刻」同属今天，所以只分出了一组；
  - 云端是 UTC，所以这条一直是绿的。
  - 验证：本机时区下单跑这个文件，稳定失败；只对那一条命令设 `TZ=UTC`，5/5 通过。
- **产品行为是对的**：真机上跨过午夜后，会话正确归入了「昨天」。
- **怎么改**：测试改用本地时刻构造（如 `new Date(2026, 7, 21, 0, 30)`），或在 vitest 配置里固定 TZ。否则 RELEASE.md 要求的「Windows 上全绿」，在 UTC+8 的发版机上会一直挡住。

### 3.7 🟢 权限请求超时：界面清楚，但回给模型的话不准

- **用户看到**：「权限请求已超时，自动拒绝」（`src/renderer/src/stores/chat.ts:214`），表述清楚。
- **问题**：回给模型的却是「命令被用户拒绝（可在设置-权限中调整）」（`src/minisd/tools/shell.ts:266`），模型可能会对用户说「你拒绝了这个命令」。
- **怎么改**：超时分支单独回一句，比如「权限请求超时未获批准」。

### 3.8 ✅ 更新相关提示：表现良好

| 场景 | 实际提示 |
|---|---|
| 发布仓库不存在 / 没发过版 | 更新失败 · 发布页上还没有可用的版本（发布仓库不存在，或还没发过正式版） |
| 连不上更新服务器 | 更新失败 · 连不上更新服务器（离线或网络受限） |
| 已下载、还没安装 | 新版已下载，还没安装：联网时点「现在检查」会重新弹出安装提示 |
| 便携版 | 便携版不自动更新，请到发布页下载新版 |
| 托盘回执：已下载 | 新版本 0.3.1-rehearsal.1 已下载完成 / 在「有新版本可用」的提示里点「重启并安装」才会安装，关掉 DeskMinis 不会自动安装…… |

都是中文，没有堆栈或响应头。唯一要改的是**日志文件**：失败时整段写入了 HTTP 响应头，包括 `set-cookie`（GitHub 的匿名会话 cookie，不涉及账号）。建议只记状态码和 URL。

### 3.9 其它小问题（都不会出提示）

| 问题 | 原因 / 建议 |
|---|---|
| Ctrl+=（不按 Shift）和小键盘 + 不放大 | Electron 的 `zoomIn` 角色只认「Plus」字符（`src/main/app-menu.ts:24`）。建议加一个隐藏菜单项，绑定 `CmdOrCtrl+=` 和 `CmdOrCtrl+numadd` |
| 终端首行漏出 `#< CLIXML` | PowerShell 以 `-EncodedCommand` 启动且 stderr 被重定向时，会输出序列化的进度流。建议启动时设 `$ProgressPreference='SilentlyContinue'`，或过滤掉这一行（推断，未验证） |
| 回复里的裸网址不能点 | Markdown 渲染没开自动识别链接；`[文字](网址)` 形式的链接正常 |
| 扩展市场一条描述里出现 `��` | 来源数据或解码的问题，未深究 |
| 安装向导里长路径压线 | 纯外观问题，只在路径很长时出现（比如 §3.3 那种） |

---

## 4. 更新交接演练（W3-upd）详情

| 步 | 结果 | 说明 |
|---|---|---|
| 1. 把 `app-update.yml` 改为 generic + `http://127.0.0.1:8000/` | ✅ | 保留了 `updaterCacheDirName`；原件先备份了 |
| 2. 另打 `0.3.1-rehearsal.1`（`dist-rehearsal`） | ✅ | 按文档原命令打包，退出码 0，产出 `latest.yml`。本机没有 Python，用 Node 写的静态服务代替，只监听 127.0.0.1，支持 Range |
| 3. 重启后等「有新版本可用」的框 | ✅ | 框里写着「DeskMinis 0.3.1-rehearsal.1 已下载完成」，并说明会打开安装程序。**主窗口藏在托盘时框可见**：藏托盘后从托盘点「检查更新…」，提示框和回执都可见。「刚启动就藏进托盘」这一时机没观察到 |
| 4. 稍后再说 → 托盘「检查更新…」/ 关于页「现在检查」 | ✅ | 两处都让提示重新弹出；回执写着「已下载完成」 |
| 5. 重启并安装 → 向导默认选项 → 完成 | ✅ | 应用关闭，安装程序以 `--updated --force-run` 打开；完成后拉起了新版，关于页是 `v0.3.1-rehearsal.1`，会话和设置都在。**弹框文案和实际向导吻合，不用改** |
| 6. 按天日志 | ✅ | 有「发现新版本」「已下载完成」「用户点了「重启并安装」」、`Install: isSilent: false, isForceRunAfter: true`、`Executing … --updated,--force-run` 几行 |
| 7. 卸载演练版 → 重装正式版 → 删 `dist-rehearsal` | ✅ / ◐ | 重装后 `app-update.yml` 恢复成 github 源；`dist-rehearsal` 里剩 2 个 `.asar` 被 Claude 应用占着，删不掉（见 §6） |

补充观察：旧版 blockmap 返回 404 后，更新器自动回落到全量下载，符合预期；electron-updater 提示 `disableWebInstaller` 建议设为 true。

---

## 5. 与 RELEASE.md 的偏差和环境说明

- **未跟踪文件**：`git status` 并不干净，有 87 个历史未跟踪文件，但已跟踪文件零改动；它们不影响打包、测试和 typecheck。
- **模型**：全程用本地假 OpenAI 端点（127.0.0.1:18080）加本次生成的假 key，没有碰任何真实 key。真实模型端点（Anthropic / DeepSeek）的行为**没有覆盖**，要靠补跑 `smoke:release`。
- **数据目录**：测试前把原数据 `%APPDATA%\DeskMinis`（8/20 的开发数据）挪开，做真正的干净安装，测完已复原。
- **断网**：用「更新源指向一个关闭的本地端口」替代；真断网需要改系统网络设置，没做。
- **SmartScreen**：本机构建的文件没有「来自网络」标记，所以不会弹；从 Release 下载回来的包要再看一次。
- **中途干扰**：用户中途碰过一次界面（跳到了定时任务页），不影响任何结论。
- **自动化环境**：本机打字要绕开中文输入法；「完成页找不到文件」是自动化环境误报（§3.4）；工作区里的 `.asar` 会被 Claude 应用占用。

---

## 6. 清理状态

**已恢复成测试前的样子：**
- 本机不装 DeskMinis：「应用和功能」登记、安装目录、开始菜单 / 桌面 / 任务栏快捷方式、任务栏固定项的墓碑文件都已清掉；
- `%APPDATA%\DeskMinis` 已复原为原来的数据：344 个文件，`minis.db` 仍是 8 月 20 日 04:28 的；
- `%LOCALAPPDATA%\DeskMinis`（日志）和 `%LOCALAPPDATA%\deskminis-updater` 已挪进下面的证据目录，原处不留；
- 测试 provider 连同它在凭据库里的假 key 已删；
- 假端点和静态服务已停；外链测试带起来的 Chrome 已正常关闭（测试前它没在运行）；
- `e2e:m5` 留下的 Temp 空目录已删。

**留下的：**

| 残留 | 原因 | 怎么处理 |
|---|---|---|
| `deskminis/dist-rehearsal/`（只剩 2 个 `.asar`，约 23 MB） | Claude 桌面应用自己占着这两个文件的句柄，删不掉也挪不动；会在 `git status` 里显示成一条未跟踪项 | 重启 Claude 应用后运行 `Remove-Item C:\Users\phainion\Desktop\Deskminis\deskminis\dist-rehearsal -Recurse -Force` |
| 凭据库条目 `pairing.static-identity.DeskMinis` | 来源确认不了，可能是以前开发时就有的，所以没动 | 如确认是这次测试产生的：`cmdkey /delete:pairing.static-identity.DeskMinis` |

**按要求保留的**：`deskminis/dist/`（本次构建产物）、重装过的 `node_modules`、重新构建的 `out/`（后两者都在 `.gitignore` 里）。

---

## 7. 发版前还要做的（建议顺序）

1. 修 §3.1 定时任务 bug，并补 renderer 守卫测试；修 §3.6 测试。之后重跑第 1 节全套。
2. 设好 key，补跑 `npm run smoke:release`（第 0 节第 4 步，这次跳过了）。
3. 如果能拿到 0.1.1 安装包，补做「覆盖安装运行中的 0.1.1」。
4. 处理 §3.3：修 `e2e:m5` 或改 RELEASE.md 第 2 节的说法；考虑 §3.2 的执行策略问题。
5. 然后再做第 0 节的第 1、6–9 步（建公开仓库、改 CHANGELOG 日期、建 Release、下载回来复核、发布后看关于页）。

---

## 8. 证据索引

证据都在 `C:\Users\phainion\AppData\Local\Temp\claude\C--Users-phainion-Desktop-Deskminis\0959a542-05b9-4a14-96f6-66578ae0d8f9\scratchpad\`。它在 `%TEMP%` 里，可能被系统清理，要长期保留请自行拷走。

| 文件 | 内容 |
|---|---|
| `01-npm-ci.log` / `01b-npm-ci-proxy.log` | npm ci 第 1 次（失败）和第 2 次（通过） |
| `02-npm-test.log`、`02b-nav-group-localtz.log`、`02c-nav-group-utc.log` | 全量测试；时区对照 |
| `03-typecheck.log`、`04-npm-dist.log`、`05-verify-release.log`、`06-e2e-m5.log` | 构建与验收 |
| `07-rehearsal-build.log`、`static-8000.log` | 演练包构建；静态服务的请求日志 |
| `mock-openai.log` | 假端点收到的请求结构（不含请求头和 key） |
| `shots/*.png` | 全程截图（编号和上文对应） |
| `evidence/localappdata-DeskMinis-logs/logs/minisd-2026-09-27.log`、`-28.log` | 应用的按天日志 |
| `evidence/appdata-DeskMinis-smoke/` | 冒烟期间的数据目录 |
| `evidence/localappdata-deskminis-updater/` | 更新缓存（含演练版安装包） |
