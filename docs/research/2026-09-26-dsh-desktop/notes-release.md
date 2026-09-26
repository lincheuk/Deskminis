# DSH 更新与发布工程 × DeskMinis 对照笔记（2026-09-26）

- 范围：DSH `apps/desktop`（HEAD 46a7f68b0，0.1.7-rc.1）的 electron-updater 用法、更新流程与界面、强制更新、发布元数据、上传、Windows 签名、安装器、实测脚本、打包前后校验；对照 DeskMinis（HEAD 35aab54）的 `electron-builder.yml`、`src/main/index.ts`、`src/main/update-status.ts`、`scripts/verify-release.mjs`、`scripts/e2e-m5-packaging.mjs`、`docs/RELEASE.md`。
- 方法：只读静态读码。另读了 DeskMinis `node_modules` 里 electron-builder 26.15.3（app-builder-lib 的 NSIS 模板）与 electron-updater 6.8.9 的源码，用来核对两边的实际行为。没跑任何项目代码，没上 Windows 真机。凡是从模板或源码推出、没实测的，都标「推断」。
- 行号：DSH 路径相对 `/home/user/refs/deepseek-harness/apps/desktop/`；DeskMinis 路径相对 `/home/user/Deskminis/deskminis/`（docs 相对 `/home/user/Deskminis/`）；electron-builder / electron-updater 源码相对 `/home/user/Deskminis/deskminis/node_modules/`。
- dsh.md 已写过、这里不再展开的（只在需要时引用）：更新前 inspect→lock→排空的准入锁与关停升级梯（R4）；test:updates:local 用真实 NsisUpdater 对回环服务器（R3）；强制更新依赖远端服务、不适合 DeskMinis；可选的安装更新日志（jsonl）用作真机取证；预发布通道用独立 feed；update-attention（任务栏闪烁加单次静默通知）；卸载时保留 DSH_HOME。

---

## 0. 速览

**最值得借（详见各节）**
1. 更新 HTTP 空闲超时（§2.3）。
2. 构建出处写进产物，加上「完成记录」闸门（§4.2、§4.3）。
3. 发布顺序：安装包与 blockmap 先就位，清单最后可见；GitHub 上就是「草稿 → 回验 → 发布」（§5.1）。
4. 已装版本升级的操作员清单（§8.4），发版前先做一次精简演练（§11-C）。
5. 周期检查：抖动、失败退避、resume/focus 触发，自动检查不弹窗（§2.2）。
6. 安装器只装当前用户；更新时等应用自己退出，不强杀（§7.2、§7.3）。
7. 签名立项时一次到位：publisherName 取证书 DN；未签名构建不带 feed；设 channel 后显式关掉降级（§1.4、§6）。

**0.3.0 发版前单列的检查项**：见 §11（A–H）。

**DeskMinis 同样好或更好的**：见 §12。

---

## 1. electron-updater 的用法与配置

### 1.1 provider、channel 与 detectUpdateChannel

**DSH 怎么做**
- 用 generic provider，固定 `channel: 'nightly'`，`detectUpdateChannel: false`（`scripts/electron-builder-config.mjs:244-245`）。
- feed URL 由部署环境（test / production）加目标（`win-x64` 等）算出：只接受纯 HTTPS origin，测试批次再插一段 32 位十六进制的 release-id 目录（`scripts/desktop-auto-update-environment.mjs:103-157`）。
- feed 文件名固定为 `nightly.yml` / `nightly-mac.yml`（同文件 :73-81）。稳定版另发一份指向同一组产物的 `latest.yml` 别名（`scripts/desktop-upload-plan.ts:270-274`，README:236）。
- 运行时：`autoUpdater.channel = 'nightly'`、`allowPrerelease = true`，随后显式写 `allowDowngrade = false`，注释是「选 channel 会顺带打开降级」（`src/update-coordinator.ts:65-70`）。已核实：electron-updater 的 `set channel` 确实会把 `allowDowngrade` 置 true（`electron-updater/out/AppUpdater.js:33-45`）。

**DeskMinis 现状**
- github provider，指向 `lincheuk/deskminis-releases`，不设 channel（`electron-builder.yml:70-73`）。
- `allowPrerelease` 由 electron-updater 按当前版本号推断（0.3.0 没有预发布段，所以是 false；`AppUpdater.js:218`），GitHubProvider 走 `/releases/latest`。
- `allowDowngrade` 保持默认 false。

**差距与建议**
- 0.3.0 用不上。
- 将来开 beta 通道（dsh.md 已建议用独立 feed）时，照 DSH 在设 channel 之后显式写回 `allowDowngrade = false`。照抄，一行。
- 另一个将来的坑：electron-builder 默认会从预发布版本号推出 channel（`app-builder-lib/out/publish/PublishManager.js:410-418`、`appInfo.js:59-65`）。版本号写成 `0.3.1-rc.1` 这类时，产出的清单会叫 `rc.yml` 而不是 `latest.yml`。verify-release ① 会因此 FAIL，算是间接兜住了。
- 波次：签名或开通道时。

### 1.2 差分包与 blockmap

**DSH 怎么做**
- `nsis.differentialPackage: true`（`scripts/electron-builder-config.mjs:242`）。已核实这与默认值等价：`isBuildDifferentialAware = !isPortable && differentialPackage !== false`（`app-builder-lib/out/targets/nsis/NsisTarget.js:66-67`）。
- 上传要求 blockmap 存在且非空，blockmap 先于 YAML 上传（README:298，`scripts/desktop-upload-plan.ts` 的 `requireArtifact`）。
- 用签名下载资格脚本在回环服务器上验证了单段与多段 Range 重建、旧 blockmap 缺失时的回退、Range 被拒时的回退（`tests/README.md:56`）。

**DeskMinis 现状**
- 默认就生成差分感知的归档和 `Setup.exe.blockmap`。
- verify-release ⑤ 核对 blockmap 是 gzip、version 为 "2"、块长之和等于安装包大小（`scripts/verify-release.mjs:295-314`）。
- RELEASE.md 要求旧 Release 不删，差分下载要用（`docs/RELEASE.md:182-183`）。
- 已核实差分下载的输入：
  - 旧 blockmap 的 URL 由新文件 URL 把版本号替换回旧版本得到（`electron-updater/out/providers/Provider.js:22-26`），缓存目录里已有 `current.blockmap` 时优先用缓存（`AppUpdater.js:694-700`）。
  - 旧安装包用的是 NSIS 安装时拷到 `%LOCALAPPDATA%\<updaterCacheDirName>\installer.exe` 的那份（`app-builder-lib/templates/nsis/include/installer.nsh:93`）。
  - GitHubProvider 不用多段 Range（`providers/GitHubProvider.js:16`）。

**差距与建议**
- DeskMinis 的 blockmap 校验比 DSH 严，属于 DeskMinis 更好。
- 不需要改。

### 1.3 更新是否启用的判定

**DSH 怎么做**
- 以 `app.isPackaged && existsSync(resourcesPath/app-update.yml)` 为准（`src/update-coordinator.ts:53`）。
- 未签名构建干脆不写 feed：`publish: null`（`scripts/electron-builder-config.mjs:93, 245`），这样安装目录里就没有 app-update.yml。

**DeskMinis 现状**
- 依次判断 `app.isPackaged`、便携版（`PORTABLE_EXECUTABLE_DIR`）、用户开关（`src/main/index.ts:329-347`；`src/main/update-status.ts:137-140`）。
- app-update.yml 缺失的情况由 verify-release ⑦ 在发版前拦下（`scripts/verify-release.mjs:333-354`）。

**差距与建议**
- 两边等价。DeskMinis 多了便携版和用户开关，更贴合自身形态。

### 1.4 publisherName 与签名校验（未签名的含义）

**DSH 怎么做**
- 签名构建从同一张公开证书的 subject 取 `CN`、`O`、`C` 拼成 DN 作为 publisherName，按 RFC 转义，三项缺一即报错（`scripts/windows-sign.mjs:82-95`；`scripts/electron-builder-config.mjs:222-225`）。
- README:300 的说法：用这三项而不钉叶证书指纹，是为了续期不破坏更新；期望的发布者写在已安装的 app-update.yml 里，不由下载来的 feed 决定。
- `scripts/test-windows-update-signature.mjs:51-68` 用真实的 NsisUpdater 验证四种情况：
  - 发布者匹配：接受。
  - 签名有效但发布者不对：拒绝。
  - 未签名：拒绝。
  - 「缺 publisherName」负对照：签名校验被整个跳过、照样接受。

**DeskMinis 现状**
- 未签名，app-update.yml 里没有 publisherName。已核实：`NsisUpdater.verifySignature` 在 publisherName 为空时直接返回 null，即不校验（`electron-updater/out/NsisUpdater.js:84-100`）。
- 所以 0.3.0 的自动更新只校验 latest.yml 里的 sha512，而 latest.yml 和安装包来自同一个 GitHub Release。信任根就是发布账号本身。
- verify-release 的 `flatScalars` 已经预留了「签名后 app-update.yml 带 publisherName 列表」的形状（`scripts/verify-release.mjs:157`）。

**差距与建议**
- 0.3.0：见 §11-H，发布账号要开 2FA，确认没有其他写权限者。
- 签名立项时照抄三条：
  - publisherName 取证书 DN（CN,O,C），不用指纹。
  - 签名版一旦发出，同一 feed 上再也不能发未签名构建，否则所有签名装机都会报 ERR_UPDATER_INVALID_SIGNATURE。DSH 的做法是未签名构建不带 feed，文件名带 `-unsigned`（`scripts/electron-builder-config.mjs:110-111`；README:268）。
  - `describeUpdateError` 补 `ERR_UPDATER_INVALID_SIGNATURE` 的中文。现在它会落进兜底的「未知原因：…」（`src/main/update-status.ts:75-97`）。
- 另外 verify-release ⑦ 可以加一项：publisherName 与证书一致。

---

## 2. 更新流程与界面

### 2.1 协调器：检查、下载、安装三段分离

**DSH 怎么做**
- `DesktopUpdateCoordinator`：
  - `autoDownload = false`、`autoInstallOnAppQuit = false`（`src/update-coordinator.ts:65-66`）。
  - 检查合并进行中的请求（:84-93）。
  - 下载要带用户确认时看到的版本号，版本已变就报 stale（:99-118）。
  - 安装要另一次确认，并要求准入锁和 Host 干净退出（:125-141）。
  - 最后调 `quitAndInstall(true, true)`，即静默安装且装完自动启动（:133）。
- 安装器起不来时，在确认 Host 已干净退出的前提下原地恢复当前版本的 Host，再允许下一次确认（`src/main.ts:447-477`；README:353）。
- 用户选「稍后」后保留「就绪」状态；再点就绪入口会重新打开确认；普通退出绝不安装（README:351）。

**DeskMinis 现状**
- `autoDownload = true`、`autoInstallOnAppQuit = false`（`src/main/index.ts:289-290`）。
- 下载完成弹原生对话框「稍后再说 / 重启并安装」，默认焦点在「稍后」（:296-316）。
- 选安装：先 `stopMinisdGracefully`，再调 `autoUpdater.quitAndInstall()`，参数全用默认值（:315）；3 秒后还没退就自己 `app.quit()`（`src/main/relaunch.ts:18-21`）。

**差距与建议**

（1）`quitAndInstall()` 用默认参数，意味着非静默安装，更新时会弹出 NSIS 向导（推断，据源码与模板）：
- `BaseUpdater.quitAndInstall(isSilent=false, …)` 在非静默时把 isForceRunAfter 设为 `autoRunAppAfterInstall`（默认 true）（`electron-updater/out/BaseUpdater.js:13-26`）。
- `NsisUpdater.doInstall` 只传 `--updated --force-run`，不带 `/S`（`NsisUpdater.js:101-113`）。
- 辅助安装器（`oneClick: false`、`perMachine: false`）的安装模式页（为所有用户 / 仅为我）遇到 `--updated` 不会跳过：它只认 `/allusers`、`/currentuser` 和 `customInstallMode`（`app-builder-lib/templates/nsis/multiUserUi.nsh:30-65`；`assistedInstaller.nsh:18-20`）。
- `--force-run` 只在静默模式下生效（`installSection.nsh:104-109`）。非静默时靠完成页上默认勾选的「运行 DeskMinis」来重启（`assistedInstaller.nsh:46-63`）。
- 结论：0.3.0 → 0.3.1 的更新会出现一个要点两下的向导，对话框里「现在重启即可用上新版本」（`src/main/index.ts:309`）不完全属实。
- 这一行代码随 0.3.0 冻结，决定前要先亲眼看一次（§11-C）。
- 选项 a：保留，改对话框文案。
- 选项 b：改成 `quitAndInstall(true, true)`（DSH 做法），代价是安装失败时用户看不到提示。DSH 用自绘 NSIS 补了这个缺口：等 10 秒，退出码 2（`scripts/installer.nsh:163-192`）。

（2）只有一次性对话框，没有「就绪」入口：
- 选了「稍后」之后，唯一的回头路是「现在检查」重新触发下载完成事件（缓存命中会立刻再弹框），或者重启后等 8 秒的自动检查（前提是开着自动检查）。
- 文案问题见 §11-E。

（3）安装器起不来时的处理：DeskMinis 选择退出应用、由用户重开，DSH 选择原地恢复。DeskMinis 的方案更简单，可以接受。

- 波次：（1）的决定在 W3（发版前）；「就绪入口」放 W6a。只借思路。

### 2.2 检查节奏：周期、抖动、退避

**DSH 怎么做**
- `DesktopUpdateSchedule`：基础间隔 10 分钟，±20% 抖动；失败时间隔翻倍，封顶 1 小时；成功后复位（`src/update-schedule.ts:18-33, 99-110`）。
- 用单调时钟，前台和 resume 的检查遵守同一个到期时间，手动检查立即执行并合并进行中的请求（:65-83）。
- 挂接点：`powerMonitor.on('resume')`（`src/main.ts:789-793`）、窗口 focus（:909）、启动时（:1105）。
- 自动检查从不弹窗、从不下载（README:347）。

**DeskMinis 现状**
- 只在启动 8 秒后检查一次（`src/main/index.ts:437-439`）。
- 应用关窗后常驻托盘，没有开机自启（grep 不到 `setLoginItemSettings`）。
- 下载是自动的，下载完直接弹模态框。

**差距与建议**
- 这个节奏随 0.3.0 冻结：0.3.0 用户要等到下一次启动应用（重启电脑或从托盘退出后再开）才看得到 0.3.1。影响是延迟，不是永久收不到。
- 借鉴时要连带处理弹窗：DeskMinis 自动下载加上周期检查，会在任意时刻弹出模态框。要先做到「窗口不在前台时不弹框，只做提醒」，这部分 dsh.md R3 的 update-attention 已写。
- 波次 W6a。照抄 `update-schedule.ts` 的算法（MIT，约 70 行，须署名）。
- dsh.md R4 只用一句提到过「带抖动和退避」，这里补上了参数和冻结后果。

### 2.3 更新 HTTP 的空闲超时

**DSH 怎么做**
- `DesktopUpdateHttpExecutor extends ElectronHttpExecutor`：每个连接在收到响应头之前、以及两次数据块之间，都有空闲超时（默认 60 秒，可用环境变量调），不设总时长上限（`src/update-http-executor.ts:1-53`）。
- 注释写明：上游那个 socket 计时器是给 Node HTTP 用的，Electron 的 ClientRequest 没有这个事件（:19）。
- 协调器直接替换 autoUpdater 的内部属性 `httpExecutor`（`src/update-coordinator.ts:56-64`）。
- 资格脚本覆盖了「feed 卡住、下载卡住都会超时并能恢复」（`tests/fixtures/local-updater.mjs` 的 stalled-feed 场景；`tests/README.md:33`）。

**DeskMinis 现状**
- 用的是默认的 ElectronHttpExecutor（`src/main/index.ts:269-325`）。
- 已核实：builder-util-runtime 的超时实现是 `request.on('socket', s => s.setTimeout…)`（`builder-util-runtime/out/httpExecutor.js:278-285`），ElectronHttpExecutor 没有覆盖它（`electron-updater/out/electronHttpExecutor.js`）。
- 推断：在 Electron 里，一个卡住不动的检查或下载会永远挂着。又因为 `checkForUpdatesPromise` 和 `downloadPromise` 都做了合并（`AppUpdater.js:257-260, 442-444`），之后的手动检查会并进同一个卡住的 promise。托盘「检查更新…」要等 `await checkUpdates(true)` 返回才弹回执（`src/main/index.ts:352-355`），于是永远没有回执，关于页一直显示「检查中… / 下载中…」。

**差距与建议**
- 照抄改写 DSH 的约 50 行（MIT，须署名）。它碰的是 electron-updater 的非公开属性。DeskMinis 的依赖版本被 `tests/deps-frozen.test.ts` 钉死，风险可控，但必须在真机更新演练里验证一次。
- 波次：W6a；如果 §11-C 的演练里碰上卡住，可以提前。

### 2.4 更新确认界面（update-dialog 与 preload-update-dialog）

**DSH 怎么做**
- 确认框不用原生对话框，而是由壳持有的透明子窗口：沙箱，`contextIsolation`，隔离的 preload（`src/update-overlay.ts:1-49`）。
- 页面只能回传「版本号 revision 加按钮下标」：revision 过期就拒绝（`src/update-dialog.ts:56-66`）；主进程核对发送者是自己的 webContents、主 frame、固定 URL（:137-143）。
- preload 只在 `location.href` 等于固定页面时才暴露 API（`src/preload-update-dialog.ts:14`）。
- 产品页面只能看到状态，不能选择产物，也不能批准安装（README:57）。

**DeskMinis 现状**
- 用原生 `dialog.showMessageBox`（`src/main/index.ts:307-316`）；托盘回执用非模态对话框（`src/main/update-status.ts:144-167`）。
- 渲染层只有读状态、开关、手动检查三个 IPC（`src/preload/index.ts:14-16`），没有安装入口。

**差距与建议**
- DeskMinis 同样好：原生框无法被页面伪造，也更简单。
- DSH 这套主要为了视觉（模糊背景、淡入淡出、多语言），不借。

### 2.5 更新证据与日志

**DSH 怎么做**
- `DSH_DESKTOP_UPDATE_JOURNAL_DIR` 可选开启，按字段白名单写 JSONL：阶段、目标版本、整数进度、固定错误码，不写原文、不写 URL，每次都 flush（`src/update-journal.ts:12-30, 46, 72`；`src/main.ts:295-296, 447-449`）。
- dsh.md 已写过把它当真机取证，这里不重复。

**DeskMinis 现状**
- 更新错误的原文只写进 `process.stderr`（`src/main/index.ts:321-323`）。
- 但 DeskMinis 自己在 `src/minisd/diag/daily-log.ts:4-5` 写明「打包后的 GUI 里 stderr 没人看」，所以按天日志才要写。
- electron-updater 自己的 logger 默认是 console，同样丢失。

**差距与建议**
- 结论：装机版遇到「更新失败 · 未知原因：…」时，界面上只有截断到 120 字的一句（`update-status.ts:42`），完整原因无处可查。
- 0.3.0 的更新失败只能靠 0.3.0 自己的代码留证据，这也是冻结项。
- 建议在 error 回调里加一行 `minisdLog.append('[update] ' + 首行或堆栈)`，并可选把 `autoUpdater.logger` 接到 DailyLog。这比 DSH 的日志轻得多，只借思路。
- 波次 W3，见 §11-D。

### 2.6 「已下载」状态的文案

**DSH 怎么做**：普通退出绝不安装；关掉确认框后保留「就绪」状态，点就绪入口会重开确认（README:351）。

**DeskMinis 现状**
- 关于页 `downloaded: '新版已下载，重启后生效'`（`src/renderer/src/ui/settings/SecAbout.vue:23`）。
- 托盘回执 `'重启应用后生效。'`（`src/main/update-status.ts:154-155`）。
- 下载完成框写「下次启动时再装」（`src/main/index.ts:309`）。
- 然而 `autoInstallOnAppQuit = false`（`src/main/index.ts:290`），而 electron-updater 在这种情况下不挂退出安装的钩子（`BaseUpdater.js` 的 `addQuitHandler`：`!this.autoInstallOnAppQuit` 直接 return）。所以单纯重启不会装上新版。
- 重启后只有开着自动检查，8 秒后才会再弹一次框。关着自动检查就不会再提醒。

**差距与建议**：界面说了不实的话（推断，据源码，未真机确认）。低成本的改法是把文案改成「点『重启并安装』后生效」，或者在关于页 `downloaded` 状态放一个「重启并安装」按钮。见 §11-E。

---

## 3. 强制更新策略（mandatory-update-policy，40005）

**DSH 怎么做**
- 请求远端 `/api/v0/check_client_update`，带上安装身份头：平台、架构、壳与 dsh 版本、应用 ID、语言、固定 nightly（`src/mandatory-update-policy.ts:157-163`）。
- 返回扁平化的 `code 40005` 即为阻断：标题与正文只作纯文本，下载页 URL 必须在 origin 白名单内，否则隐藏（:115-128）。
- 网络或解析失败时保留已知的阻断状态，只有一次新的「不强制」响应才解除（:174-212，失败保留在 :201-204）。
- 不持久化，重启后重新查询；策略永远不选择也不替换更新产物（README:380）。
- 打包时把策略 origin 写进 manifest，打包后的应用忽略运行时的环境变量覆盖（README:359；`scripts/desktop-policy-environment.mjs`）。

**DeskMinis 现状**：没有，也没有自己的服务端。

**差距与建议**
- dsh.md 已判「不适合」，同意。
- 零服务端的替代（推断，未实测）：electron-updater 6.8.9 原生支持 latest.yml 顶层的 `stagingPercentage`（`AppUpdater.js:314-332`），可以按比例灰度或暂停推送。每台装机有一个 `.updaterId` 存在 userData（:502）。改 latest.yml 不影响安装包的 sha512。DeskMinis 的 verify-release 已经会忽略这个键（`scripts/verify-release.mjs:36-37`）。
- 这是「节流」而非「强制」。需要时再用，0.3.0 不动。

---

## 4. 发布元数据

### 4.1 release.ts、版本派生与版本纪律

**DSH 怎么做**
- `release.ts` 校验运行时描述文件里的发布身份：schema、版本、Host 协议、Node 与 pnpm 版本（`src/release.ts:1-35`）。这是 DSH 壳和运行时分离带来的需要，DeskMinis 同仓构建，不需要。
- 版本派生：生产版用产品版本；测试版在它后面追加 `.YYYYMMDD.序号`，稳定基线用 `-test.YYYYMMDD.序号`（`scripts/desktop-build-version.mjs:1-21, 62-77`；README:135-156）。
- 拒绝 build metadata（`+xxx`），因为它不参与 semver 比较，两次构建会被 updater 视为同一版本（`desktop-build-version.mjs:37-45`）。
- 纪律（README:144、156；`.agents/notes/implemented/process/2026-09-16-desktop-release-version-derivation.zh.md`）：
  - 已发布的版本号永不复用。
  - 客户端只接受更高版本，所以「换 feed」救不回已经装了更高错误版本的机器，只能手动安装。
  - 不为修错版本号而开降级。
- 打包前必须先与用户确认完整版本号（README:133）。

**DeskMinis 现状**
- 版本来自 `package.json`；升版规则写在 RELEASE.md §6（`docs/RELEASE.md:217-228`）。
- 「四件必须出自同一次 npm run dist」（:72）；上传出错时从同一个 dist 重传（:196）。
- 没有写「0.3.0 发出后发现问题，不要在同一个 Release 下换成新构建，一律升 0.3.1」。

**差距与建议**：在 RELEASE.md §6 补一行版本纪律。照抄思路，W3，低成本，见 §11-G。

### 4.2 构建出处（build-commit）

**DSH 怎么做**
- 打包入口读一次 `git rev-parse HEAD` 和 `git status --porcelain`（`scripts/desktop-build-commit.mjs:23-29`），经环境变量传给子进程（:36-45），写进 `extraMetadata.dshBuildCommit` / `dshBuildDirty`（`scripts/electron-builder-config.mjs:99, 107`）。
- 这样「直接转手的构建也能追溯」。生产上传成功后再打 `desktop-v<版本>` 标签；脏树构建不打标签；打标签失败不回滚上传，只打印补救命令（`scripts/desktop-release-tag.ts:1-13, 38-80`；README:154）。

**DeskMinis 现状**：RELEASE.md 要求 `npm run dist` 前手工 `git status`，并把 commit 记进 Release 说明（`docs/RELEASE.md:19-20, 171-174`）。

**差距与建议**
- 借思路（零依赖）：在 `dist` 脚本里用 `electron-builder --config.extraMetadata.deskminisBuildCommit=<sha> --config.extraMetadata.deskminisBuildDirty=<0|1>`，由一个小 node 脚本取值后调用。关于页显示 commit。verify-release 读回（asar 头是很简单的 pickle 加 JSON，零依赖约 30 行即可读出 package.json），并要求 dirty=0。
- 在私有源码仓给 0.3.0 的 commit 打 `v0.3.0` 标签，方便以后切 0.3.x 补丁分支。用户在 Windows 本机手工打即可；云端推 tag 会 403（RELEASE.md:176-177）。
- 波次：打标签 W3（随手）；commit 写进产物放 0.3.1。

### 4.3 完成记录：闸门，防止陈旧或半截产物

**DSH 怎么做**
- 每次打包开始先删掉 `<target>-release.json`（`scripts/package-target.ts:405-409`）。
- 只有 electron-builder、全部签名与公证钩子、打包后冒烟都成功后，才写入 {版本, 部署环境, feed URL, commit, dirty}（:140-160, 494-499）。
- 上传前核对这份记录与 feed、版本、文件名、大小、SHA-512 全部一致，然后才读凭据（README:236）。

**DeskMinis 现状**
- verify-release 能证明四件产物彼此一致：latest.yml ↔ Setup.exe ↔ blockmap，以及 win-unpacked 里的 app-update.yml 与许可文件。
- 证明不了它们出自这一次构建、这一个 commit。例如上一次成功的 0.3.0 构建留在 dist 里，这次构建中途失败，verify 照样全 PASS。RELEASE.md 没要求构建前清空 dist（`docs/RELEASE.md:33-46`）。

**差距与建议**
- 0.3.0：构建前清空 `dist/`，并确认 `npm run dist` 退出码为 0（§11-F）。
- 0.3.1：连同 §4.2，由 `dist` 脚本在成功后写 `dist/release-record.json`，verify-release 核对它（照抄思路）。

---

## 5. 上传脚本

### 5.1 发布顺序与回读

**DSH 怎么做**
- 上传计划把渠道清单（YAML）放在最后（`scripts/desktop-upload-plan.ts:36, 270`），先传安装包和 blockmap。
- 每个对象一次流式 PUT，带长度和 Content-MD5；不重试（README:206）。
- 留存 `plan.json`、`events.jsonl`、`result.json`；没有 result 就等于「没确认完成」（README:206）。
- 公网 CDN 回读明确标为 `not-performed`，交给后续资格验证（README:206）。
- 决策笔记给出的理由：直接发布「可能在所有引用产物就绪前暴露频道元数据」（`/home/user/refs/deepseek-harness/.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md:131`）。

**DeskMinis 现状**
- 建 Release（不能是草稿、不能勾预发布）并上传四件，然后下载回来再跑一遍 verify-release（`docs/RELEASE.md:28-30, 171-196`）。
- 回读这一点比 DSH 更进一步。但回读发生在已公开之后。

**差距与建议**
- 从 0.3.1 起把回读变成发布前的闸门：Release 先存为草稿，上传四件，把草稿资产下载回来验证，全过再点发布。在 GitHub 上，资产要到发布那一刻才对 updater 可见，所以等价于 DSH 的「清单最后」。
- gh 能否下载草稿资产属于推断：gh 按 tag 找不到时会在列表里找草稿，需要登录；做不到就在网页上逐个下载。
- 0.3.0 不需要：新源上还没有任何客户端（0.1.1 用户指向私仓，查不到），不存在时间窗问题。
- 波次 0.3.1。只借思路。

### 5.2 凭据与上传记录（COS、DPAPI）

**DSH 怎么做**：凭据只从 git 忽略的平台 dotenv 读，子进程环境里剥掉凭据；Windows 可以用 DPAPI 加密的 CLIXML 注入（README:158, 208）。

**DeskMinis 现状**：手工在 GitHub 网页或用 gh 上传，不涉及对象存储。

**差距与建议**：不需要。

---

## 6. Windows 签名与签名缓存（DeskMinis 签名立项前只作参考）

**DSH 怎么做**
- EV 硬件 Token（SafeNet）：
  - 签名钩子只调一次 SignTool；时间戳在隔离副本上单独完成，只对「正常退出但失败或告警」重试三次（README:318-320）。
  - 「No private key is available」意味着 PIN 错了，立即停下，因为错五次会锁死 Token（README:302）。
  - 签名前用一个小探针先签一次做预检（README:296）。
  - 有签名互锁文件：失败后必须人工解除（README:306）。
  - 按账号缓存运行时签名，恢复前逐个校验摘要、信任链、时间戳和证书（README:286-294）。
  - 给 electron-builder 临时生成的 NSIS 引导程序也签名，以通过企业代码完整性策略（`scripts/windows-sign.mjs:299-326`）。
- 未签名的 Windows 测试构建：产物隔离到 `unsigned-artifacts`，不带更新配置，也不写完成记录，因此永远过不了上传（README:260-268）。

**DeskMinis 现状**：0.3.0 未签名。README 与 CHANGELOG 已写明 SmartScreen「未知发布者」（`/home/user/Deskminis/README.md:79`、`/home/user/Deskminis/CHANGELOG.md:174`）。

**差距与建议**
- 签名立项时照抄这些思路：publisherName 取 DN、失败不重试、只对时间戳做有界重试、签名预检、未签名构建不带 feed 并加后缀。
- 缓存和互锁是 EV 硬件 Token 才需要的东西，普通 OV 证书或云签名不需要。
- 旁注（推断，非 DSH 依据）：Windows 11 若开启「智能应用控制」，未签名安装包会被直接拦截，没有「仍要运行」。README 里「更多信息 → 仍要运行」的说法对这类机器不成立。可以在发布说明里加一句。

---

## 7. 安装器

### 7.1 NSIS 选项对照

**DSH 怎么做**：`oneClick: false`、`perMachine: false`、`allowElevation: false`、`allowToChangeInstallationDirectory: false`、中英两种界面语言、`differentialPackage: true`（`scripts/electron-builder-config.mjs:233-243`）。其余全部由自定义页面接管。

**DeskMinis 现状**：`oneClick: false`、`perMachine: false`、`deleteAppDataOnUninstall: false`，其余为默认（`electron-builder.yml:50-55`）。

**差距与建议**：按 electron-builder 的约定，`oneClick: false` 加 `perMachine: false` 会显示安装模式页，可选「为所有用户安装」（需提权）或「仅为我」。这会造出一批按机器安装（Program Files）的用户，他们每次更新都要 UAC。见 §7.2。

### 7.2 只装当前用户

**DSH 怎么做**
- `customInit` 遇到 `/allusers` 或 HKLM 里已有安装位置，就以退出码 2 拒绝（`scripts/installer.nsh:29-40`）。
- `customInstallMode` 固定为当前用户并跳过安装模式页（:75-80）。
- 冒烟脚本断言 `/S /allusers` 被拒、非空的陌生目录被拒（`tests/windows-installer-smoke.ps1:227-236`）。

**DeskMinis 现状**：用默认的安装模式页。

**差距与建议**
- 借思路：在 `build/installer.nsh` 里定义 `!macro customInstallMode StrCpy $isForceCurrentInstall "1" !macroend`，模板会据此直接走「仅为我」并跳过这一页（`multiUserUi.nsh:41-65`），再在 `electron-builder.yml` 里设 `nsis.include`。
- 安装器模板不会被 0.3.0 冻结：更新时实际运行的是新版本的 Setup。可以放到 0.3.1。
- 如果想让 0.3.0 就不产生按机器安装的用户，就得在发版前做，而且需要真机重测安装。建议：0.3.1 做；0.3.0 在 RELEASE.md §3 写一句「安装模式选『仅为我』」。

### 7.3 检查应用是否在运行，以及覆盖升级

**DSH 怎么做**
- `customCheckAppRunning`：只找安装目录下的那个 exe；更新时最多等 10 秒让它自己退出，仍在运行就提示并以退出码 2 结束，从不强杀（`scripts/installer.nsh:163-192`）。
- 装在别的目录、同名的应用不受影响（`tests/windows-installer-smoke.ps1:207-219`）。
- 自己的目录式安装：安装目录与已登记的相同时，跳过 `uninstallOldVersion`，改为「暂存再改名替换」，失败可还原（`scripts/windows-directory-installer.mjs:20-45`）。
- 解压失败时把报告写进 `%LOCALAPPDATA%\<updater cache>\installer-logs`（`scripts/installer.nsh:128-161`）。

**DeskMinis 现状**
- electron-builder 26.15.3 默认：优先用 PowerShell CIM，按「进程路径以 $INSTDIR 开头」匹配后结束进程，先普通结束、再强制结束；PowerShell 不可用时退回按映像名 `taskkill`（`app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh:64-164`）。
- 推断：退回按映像名的路径时，可能连同名的便携版进程一起结束。
- 覆盖安装总会先静默运行旧版的卸载器（`installSection.nsh:52`；`include/installUtil.nsh:142-243`，参数 `/S /KEEP_APP_DATA --updated`），数据保留。
- DeskMinis 在「重启并安装」之前已经优雅停掉 minisd（`src/main/index.ts:315`），所以正常路径上强杀的只是正在退出的主进程。

**差距与建议**：影响小。自绘 NSIS 成本高，不借。只借一条：安装失败的日志落到固定位置，便于用户反馈。放 W9 或以后。

### 7.4 卸载时的数据

**DSH 怎么做**：卸载删除 Electron 的 userData 与 updater 缓存，保留 DSH_HOME（README:280）。dsh.md 已写。

**DeskMinis 现状**：`deleteAppDataOnUninstall: false`；打包版的 userData（`%APPDATA%\deskminis`）与数据根是同一个目录（`src/main/app-dirs.ts:29-31`），所以本来就不能只删缓存。README 写明了彻底清理的步骤。

**差距与建议**：约束不同，DeskMinis 的选择是对的，不改。

### 7.5 7-Zip 过滤器（BCJ）

**DSH 怎么做**：强制 `ELECTRON_BUILDER_7Z_FILTER=BCJ`，因为 7-Zip 24 会给 ARM64 PE 自动选 ARM64 过滤器，而 NSIS 解码器解不开（README:308）。

**DeskMinis 现状**：DeskMinis 在 Windows 上的生产依赖只有 x64 原生件：better-sqlite3 与 keyring-win32-x64-msvc（推断：Linux 云端的 node_modules 里看不到 Windows 可选包，但从包结构判断如此）。

**差距与建议**：现在不受影响。将来引入带多架构二进制的依赖（如 ripgrep 或 node-pty 的预编译包）时，记得设这个变量。

### 7.6 旁注：electronDist 指向已解包目录时 default_app.asar 会留下

已核实：`electronDist` 是已解包目录时，electron-builder 的 `selectElectron` 返回 false，不做完整清理，`resources/default_app.asar` 和根目录的 `version` 文件都会留下（`app-builder-lib/out/electron/ElectronFramework.js:175-190, 228-236`）。DSH 同样如此。app.asar 存在时 default_app 不会被加载，基本无害。可以让 verify-release 顺手报一行 WARN。优先级低。

---

## 8. 安装器与更新的实测脚本

### 8.1 test-windows-installer.mjs

**DSH 怎么做**
- 每次运行用唯一的产品身份：appId、productName、包名、`nsis.guid` 全部带随机 id（`scripts/test-windows-installer.mjs:21-25, 46, 106-110`），所以永远不会碰到机器上的正式安装。
- 装进私有目录，在 finally 里静默卸载，并确认安装目录已被移除（`tests/windows-installer-smoke.ps1:237-251`）。
- 覆盖的检查（`tests/windows-installer-smoke.ps1:160-236`）：
  - 登记的安装目录（含尾随分隔符）。
  - `/S --updated` 保持 InstallLocation 不变，并忽略别处的同名进程。
  - 拒绝 `/allusers` 和陌生目录。
  - 中英两种界面各跑一遍。

**DeskMinis 现状**
- `e2e:m5` 用正式的 Setup.exe（同一个 appId、同一个 GUID）执行 `/S /D=<临时目录>`，spawnSync 返回后又固定 sleep 60 秒，校验完直接 `rmSync` 临时目录，不卸载（`scripts/e2e-m5-packaging.mjs:157-176`）。
- 推断（据模板静态阅读，未真机复现）会有以下副作用：
  1. 本机如已装有 DeskMinis（0.1.1、dev 装机，或第 3 节冒烟装的 0.3.0），安装程序会静默运行它登记的卸载器（`installSection.nsh:52` → `installUtil.nsh:142-243`），把那份安装的程序文件删掉，数据保留。
  2. 旧卸载器在静默模式下会结束旧目录下正在运行的 DeskMinis（`uninstaller.nsh:18-19` → `CHECK_APP_RUNNING`），属于硬结束，不走优雅退出。
  3. e2e 删掉临时目录后，注册表里的卸载项和桌面、开始菜单快捷方式都指向一个不存在的目录。silent 全新安装同样会建快捷方式，见 `include/installer.nsh:216-246`。
  4. 这台机器之后就没法再做「0.1.1 → 0.3.0 覆盖安装」的实测（§11-A）。
  5. `/D=` 确实会覆盖登记的目录（`multiUser.nsh:50-54`），所以文件确实装进了临时目录，e2e 本身会 PASS，不会报错。

**差距与建议**
- 0.3.0 用低成本处理（§11-B）：RELEASE.md 写明跑 e2e:m5 前先从托盘退出 DeskMinis，§11-A 排在 e2e:m5 之前或换一台机器做；或者给 e2e:m5 加收尾，删目录前先跑临时目录里的 `Uninstall DeskMinis.exe /S` 并等它退出。
- 长期照 DSH 做：测试安装包用唯一身份（改 appId/GUID 后单独打一个测试包）。那要改打包流程，放 W9。

### 8.2 test-local-updater.mjs 与 test-signed-updates.mjs

- dsh.md 已写：真实 NsisUpdater 加回环服务器，安装调用只做记录。
- 补两点边界，都是 DSH 自己承认的：它不执行安装器、不覆盖已装应用、不证明新版能起来（`tests/README.md:66-67`）；签名下载资格脚本覆盖了差分的单段、多段 Range 和两种回退，但「不证明 CDN 的 Range 支持」（`tests/README.md:54-56`）。

### 8.3 test-windows-update-signature.mjs

见 §1.4。签名立项时照抄这个四用例（含负对照）的做法。

### 8.4 已装版本升级的操作员清单（tests/installed-update/README.md）

**DSH 怎么做**
- 两个递增的测试版本，用私有 appId、私有 productName、私有 feed 路径（`scripts/installed-update-qualification.ts:1-60`）。
- 操作员顺序（`tests/installed-update/README.md:73-86`）：
  1. 装 v1，从快捷方式启动，核对 exe 路径和显示的版本。
  2. 建一段可识别的测试会话，改一项设置。
  3. 做 feed 404 和「同版本」两种检查。
  4. 发布 v2，手动检查。
  5. 下载时注入网络故障。
  6. 显式重试。
  7. 单独确认安装。
  8. 核对自动重启进入 v2，第 2 步的会话和设置都还在。
- 另有报告模板（:110-124）。
- 架构决策把「每个发布阻断平台上的签名已安装产物均能从上一个受支持版本成功更新」列为结果之一（`.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md:150`）。

**DeskMinis 现状**
- 更新的真机验证推迟到 0.3.1 发布之后，「用一台装着上一版的机器检查一次」（`docs/RELEASE.md:197-199`）。
- 也就是说，0.3.0 的下载、交接、NSIS、重启这条链，第一次跑是在用户机器上。

**差距与建议**
- 发版前做一次精简演练（§11-C），不必做全套。
- 以后每个版本发布前，用上一版的真实安装包跑一遍第 1、2、7、8 步。

---

## 9. 打包前后校验（verify 系列）

**DSH 怎么做**
- `check:package`：构建前检查应用 ID、更新 origin、签名配置，并探测外部工具，比如 tar 能否处理 Windows 路径、VS 的 C++ 工具链（README:160；`scripts/desktop-toolchain-preflight.ts:1-9`）。
- `smoke-packaged-runtime.ts`：打包后用打包出来的可执行文件跑运行时冒烟（`scripts/smoke-packaged-runtime.ts:1-23`）。
- `verifyWindowsAsarUnpack`：每个 PE 都必须处于 asar 解包状态、不是链接，并且与准备好的字节完全一致（`scripts/windows-asar-unpack.mjs:57-70`）。
- `verify-installed-update-package.ts`：解开最终安装包，核对应用身份、feed、缓存目录、publisherName、运行时字节与签名。
- 仓库根目录的 `verify-*` 多数是 monorepo 的包布局与文档门禁，和发布无关。只有 `verify-public-repository-links.ts` 相关：拒绝引用不可用的旧仓库。

**DeskMinis 现状**
- `e2e:m5`：检查随包的桥件、原生模块的 asar 解包、打包态垫片的 stdout 与退出码、含空格路径（`scripts/e2e-m5-packaging.mjs:1-18`）。
- `verify:release` 八项（`scripts/verify-release.mjs:14-21`）。
- `readme-claims` 与 `update-error-text` 测试核对三处更新源一致：README、`RELEASE_PAGE_URL`、publish 段。

**差距与建议**
- 可借一项思路：把「每个 .node / .dll 都已解包」从写死两个文件名改成枚举 asar 头（零依赖可读）。这样以后新加原生依赖也能兜住。放 W9 或以后。
- 缺少一个守卫：appId `com.deskminis.app`、包名 `deskminis`、productName `DeskMinis` 都是「装上就改不了」的身份常量，它们决定 NSIS 的 GUID、userData 目录和 updater 缓存目录，目前没有测试钉住（已查 `tests/m5-packaging.test.ts`）。建议 0.3.1 补三条断言。
- 已核实：0.1.1（6c48c8b）与现在这三个值完全相同，覆盖安装会走旧版卸载路径，不会装成两份。

---

## 10. 对照中顺带发现的 DeskMinis 问题（汇总）

| # | 问题 | 依据 | 冻结？ | 成本 |
|---|---|---|---|---|
| 1 | e2e:m5 同身份静默安装，会卸掉本机已装版本，并留下悬空的登记项与快捷方式（推断） | `scripts/e2e-m5-packaging.mjs:157-176`；`installSection.nsh:52`；`installUtil.nsh:142-243`；`uninstaller.nsh:18-19` | 否（影响发版机器） | 低 |
| 2 | 更新失败原文只写 stderr，打包版里丢失 | `src/main/index.ts:321-323`；`src/minisd/diag/daily-log.ts:4-5` | 是 | 低 |
| 3 | 「新版已下载，重启后生效」等文案不实（推断） | `SecAbout.vue:23`；`update-status.ts:154-155`；`index.ts:290, 309`；`BaseUpdater.js addQuitHandler` | 是 | 低 |
| 4 | `quitAndInstall()` 非静默，更新时出 NSIS 向导（推断） | `index.ts:315`；`NsisUpdater.js:101-113`；`multiUserUi.nsh:30-65` | 是 | 决策加演练 |
| 5 | 只在启动时检查一次，托盘常驻用户迟迟看不到新版 | `index.ts:437-439` | 是 | 中（需配合不弹框） |
| 6 | 更新请求没有空闲超时，卡住就永远挂着（推断） | `builder-util-runtime/out/httpExecutor.js:278-285`；`AppUpdater.js:257-260, 442-444` | 是 | 中 |
| 7 | 构建前不清 dist，verify 无法证明产物出自这次构建 | `docs/RELEASE.md:33-46, 72` | 否 | 低 |
| 8 | 身份常量没有守卫 | §9 | 否 | 低 |
| 9 | 安装模式页允许「为所有用户」 | `electron-builder.yml:50-55` | 半（会造出按机器安装的用户） | 低到中 |
| 10 | default_app.asar 残留 | §7.6 | 否 | 可忽略 |

---

## 11. 0.3.0（未签名）发版前值得对照、而 RELEASE.md 与 verify-release 没覆盖的检查项

只列有依据、成本低的。「推断」处需要真机确认。

**A. 0.1.1 → 0.3.0 覆盖安装实测**
- 做什么：在装着 0.1.1 并用过（有会话、有 key）的机器或虚拟机上，直接运行 0.3.0 的 Setup.exe。
- 看什么：「应用和功能」里只有一项 DeskMinis；旧会话能打开（数据库迁移成功）；key 可用；快捷方式指向新版。
- 顺序：放在 e2e:m5 之前，或换一台机器（见 B）。
- 依据：
  - DSH `tests/installed-update/README.md:77-86`（装 v1 造数据 → 升级 → 核对会话与设置）；架构笔记 :150。
  - DeskMinis RELEASE.md §3 只测干净安装（`docs/RELEASE.md:120-121`），§5 说 0.1.1 用户要手动装 0.3.0（:208）。
  - 覆盖安装会静默运行 0.1.1 的卸载器并保留数据（`installUtil.nsh:202-224`）。已核对 appId 与包名跟 0.1.1 相同。
- 成本：约 15 分钟。

**B. e2e:m5 的副作用**
- 做什么：跑之前从托盘退出本机的 DeskMinis；知道它会卸掉本机已装的版本（数据保留），并留下悬空快捷方式，之后的第 3 节安装会重新登记。或者给 e2e:m5 加收尾，删目录前先 `Uninstall DeskMinis.exe /S`。
- 依据：§8.1（推断，据模板）；DSH 的唯一身份加 finally 卸载（`scripts/test-windows-installer.mjs:21-25, 46`；`tests/windows-installer-smoke.ps1:237-251`）。
- 成本：写一句文档，或给脚本加约 10 行。

**C. 更新交接演练（中低成本，但它验证的正是 0.3.0 冻结的代码）**
- 做法：
  1. 装好 0.3.0。
  2. 另外打一个只在本地用、绝不上传的高一版：例如 `npx electron-builder --config.extraMetadata.version=0.3.1-rehearsal.1 --config.detectUpdateChannel=false --config.directories.output=dist-rehearsal`。关掉 detectUpdateChannel 才会产出 `latest.yml`（`PublishManager.js:410-418`）；generic provider 不过滤预发布版本（`AppUpdater.js:339-362`）；这个版本号又低于将来真正的 0.3.1，不会挡住它。
  3. 把已装 0.3.0 的 `resources\app-update.yml` 改成 `provider: generic`、`url: http://127.0.0.1:8000/`，保留 `updaterCacheDirName`。
  4. 用 `python -m http.server 8000` 或任意静态服务托管 dist-rehearsal，并把 0.3.0 的 blockmap 放进去，这样也能验证差分下载。
  5. 点「现在检查」，确认发现新版、下载、弹出「重启并安装」。
  6. 观察：是否出现 NSIS 向导（安装模式页、完成页）；新版是否自动启动；会话与设置是否还在；关于页的版本号。
  7. 演练完卸载，再装回真正的 0.3.0（数据保留）。
- 结论用来决定 `quitAndInstall()` 保持原样还是改成 `(true, true)`，以及对话框文案怎么写。
- 依据：
  - `docs/RELEASE.md:197-199` 把首次更新验证推迟到 0.3.1。
  - DSH `tests/README.md:66-67`（自动化测不到「安装器执行与新版启动」，需要操作员验证）、`tests/installed-update/README.md:73-86`、架构笔记 :150。
  - generic provider 没有 https 限制（`electron-updater/out/providers/GenericProvider.js`）。
  - 改 app-update.yml 切换 provider 属于推断，未实测。

**D. 更新失败原文落进按天日志**
- 做什么：`autoUpdater.on('error')` 里加一行 `minisdLog.append(...)`，可选把 `autoUpdater.logger` 接到 DailyLog。
- 依据：§2.5；DeskMinis 自己的 `daily-log.ts:4-5`；DSH 的 `update-journal.ts`。这是冻结项：0.3.0 → 0.3.1 失败时能否查原因，取决于 0.3.0 的代码。
- 成本：1 到 5 行，加一条源码守卫。

**E. 「已下载」文案与 `autoInstallOnAppQuit=false` 一致**
- 做什么：关于页的「新版已下载，重启后生效」、托盘回执的「重启应用后生效。」、下载完成框的「下次启动时再装」，都改成如实的说法，例如「点『重启并安装』后生效；关掉也不会自动装」。
- 依据：§2.6；DSH README:351（普通退出绝不安装、保留就绪入口）；DeskMinis 自己的「界面诚实」原则。
- 推断：据 electron-updater 源码，未在真机确认。
- 成本：只改文案，加相应测试。

**F. 构建前清空 dist 并确认退出码**
- 做什么：RELEASE.md 第 1 节 `npm run dist` 之前加 `Remove-Item dist -Recurse -Force`，并要求退出码为 0。
- 依据：verify-release 只能证明四件彼此一致；DSH 每次打包开头先删完成记录、全部成功才写（`scripts/package-target.ts:405-409, 494-499`）。
- 成本：一行文档。

**G. 版本纪律写进 RELEASE.md §6**
- 做什么：写明「已发布的版本号永不复用；发布后发现问题一律升 patch 重发，不在同一 Release 下换新构建；不开降级」。
- 依据：DSH README:144、156，以及版本派生笔记。
- 成本：一行文档。

**H. 未签名时，发布账号就是更新的信任根**
- 做什么：确认 GitHub 账号开了 2FA、`deskminis-releases` 没有其他写权限者，也没有第三方 App 的写授权。
- 依据：electron-updater 在没有 publisherName 时跳过签名校验（`NsisUpdater.js:84-100`）；DSH 的「缺 publisherName」负对照（`scripts/test-windows-update-signature.mjs:52, 68`）证实会跳过。
- 成本：几分钟。

**可选（发版前决定，否则放 0.3.1）**
- 安装模式固定为「仅为我」（§7.2）。
- 更新空闲超时（§2.3）。
- 周期检查（§2.2）。
- 这三项都不是低成本加低风险的组合，建议不挡 0.3.0。

---

## 12. DeskMinis 已经同样好或更好的

1. **blockmap 校验更严**：DeskMinis 核对 gzip 头、version "2"、块长之和等于安装包大小（`scripts/verify-release.mjs:295-314`）；DSH 只要求非空（README:298）。
2. **上传后回读**：DeskMinis 把 Release 的四件下载回空目录再验一遍（`docs/RELEASE.md:187-196`）；DSH 把公网回读标成 not-performed（README:206）。
3. **Windows 更新源最后一道闸**：verify-release ⑦ 核对 app-update.yml 与 publish 段一致，并拦截私有源码仓（`scripts/verify-release.mjs:333-354`）；DSH 只对 macOS 显式核对 app-update.yml（`scripts/macos-app-update-config.mjs`），Windows 交给 electron-builder。另外 ⑧ 核对随包许可文件。
4. **错误分类更细**：`describeUpdateError` 按 GitHubProvider 的三跳细分，会拆开 INVALID_RELEASE_FEED 的包装，下载 404 单独报「漏传安装包」，原文不进界面（`src/main/update-status.ts:23-132`）；DSH 只用一个网络正则把错误分成三类操作（`src/update-presentation.ts:5-16`）。
5. **确认界面**：原生对话框无法被页面伪造，托盘回执非模态，默认焦点在不打断用户的选项（`src/main/index.ts:307-316`；`update-status.ts:144-167`），同样安全、更简单。
6. **便携版**：认出便携版就不检查、不下载（`update-status.ts:137-140`）；便携版重启回到外层 exe（`src/main/relaunch.ts:8-16`）。DSH 没有便携版形态。
7. **用户开关**：自动检查可关，开关由主进程持有（`src/main/index.ts:273-282`）；DSH 只能用环境变量调参。
8. **零依赖解析器**：只认 electron-builder 输出形状的 YAML 解析器，遇到不认识的结构直接 FAIL，不去猜（`scripts/verify-release.mjs:46-155`），符合零依赖约束；DSH 用 js-yaml。
9. **对外链接一致**：三处更新源一致由测试钉住（readme-claims、update-error-text），与 DSH 的 `verify-public-repository-links` 思路相当。
10. **安装前停引擎**：「重启并安装」先优雅停掉引擎，并有 3 秒退出兜底（`src/main/index.ts:301-315`）。核心顺序与 DSH「先停 Host 再装」一致；准入锁与关停升级梯的差距 dsh.md 已写。

---

## 13. 局限与未覆盖

- 没读的：`mandatory-update-window.ts` 与 `preload-mandatory*` 的界面细节；`installed-update-*` 的物料准备与发布脚本细节；macOS 签名与公证（与 DeskMinis 无关）；运行时描述文件与签名缓存的实现细节。
- 「推断」各条都据 electron-builder 26.15.3 与 electron-updater 6.8.9 的源码和模板静态阅读，未在 Windows 上复现，特别是：e2e:m5 的副作用、更新时出 NSIS 向导、HTTP 卡住不超时、改 app-update.yml 切换 generic 的演练方法、智能应用控制。
- DeskMinis 侧只读了与更新发布相关的文件；没重跑它的测试。
