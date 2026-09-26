# DSH 桌面端 × DeskMinis：安装器与 Windows 系统集成对照笔记（2026-09-26）

- 参考：DeepSeek Harness（DSH，MIT），`/home/user/refs/deepseek-harness`，HEAD 46a7f68b0（0.1.7-rc.1）。下文 DSH 路径都相对仓库根。
- 对象：DeskMinis（DM），`/home/user/Deskminis`，HEAD 35aab54（0.3.0 待发布）。下文 `dm:` 前缀的路径相对 `deskminis/` 工程目录。
- 模板：两边的 app-builder-lib 版本相同，都是 26.15.3。DSH 在 apps/desktop/package.json 里精确钉住；DM 声明 `^26.15.3`，实际装的也是 26.15.3。因此下文引用的 electron-builder NSIS 模板，统一用 DM 本地副本的行号：`tpl:` = `deskminis/node_modules/app-builder-lib/templates/nsis/`，`upd:` = `deskminis/node_modules/electron-updater/out/`。
- Electron 版本：DM 为 38.8.6，DSH 为 ^44。
- 每条按三段写：「DSH 怎么做（文件:行）」「DM 现状（文件:行）」「差距与建议（波次；照抄改写或只借思路）」。
- 标注约定：推断标「推断」。与 9/24 dsh.md 重复的标「[dsh.md 已写]」。与同批兄弟笔记重复的标「[见 notes-xxx §n]」，这里只补安装器角度。
- 限制：只做了静态读码，没有运行任何一方的代码，也没有上 Windows 真机。

---

## 0. 总评（先说结论）

1. **DSH 的「NSIS 自绘安装页」整体不值得搬。**
   - 实现方式：一个 x86 的 `window-frame.dll`（C++/GDI+/DWM，约 300 行，外加 extract/uninstall-data/progress 几个头文件约 700 行），再加 6 个 .nsh（约 900 行）。
   - 构建与发布要求：Visual C++ Build Tools、Windows SDK，并且要给 DLL 签名。
   - 对 DM 的冲突：零依赖约束，而且 DM 没有代码签名。
   - 收益主要在观感（方形无边框窗、亮暗主题、自绘进度条）。
2. **值得借的是它背后的几条安装器纪律：**
   - 更新交接要显式选定安装方式；
   - 卸载只清可再生物，并且带「更新时不清」的闸；
   - 不硬杀用户进程，按完整 exe 路径识别进程；
   - 只装当前用户；
   - 安装失败时说得出真实原因；
   - 安装器声明 DPI 感知，中文用雅黑。
3. **DM 这边有两处 0.3.0 值得零代码核对**，因为 0.3.0 是第一个公开版，装出去就定型了：
   - 「运行中的 0.1.1 被覆盖安装」：这是老用户唯一的升级路径；
   - 「0.3.0 → 下一版的自动更新长什么样」：这段交接代码随 0.3.0 一起装机。
4. **托盘、单实例、隐藏控制台、asar 解包、日志位置这些方面，DM 已经同样好或更好**（见 §23）。

---

## 1. NSIS 接入方式：include 加上对模板的「打补丁」

**DSH 怎么做**
- 常规入口：`nsis.include` 指向 `apps/desktop/scripts/installer.nsh`（apps/desktop/scripts/electron-builder-config.mjs:236）。安装页、主题、生命周期、字符串都在 `apps/desktop/installer/*.nsh` 里，按是否 `BUILD_UNINSTALLER` 分别 include（installer.nsh:11-27）。
- 非常规入口：在 electron-builder 进程内 monkeypatch `NsisTarget.prototype.computeFinalScript`（apps/desktop/scripts/windows-directory-installer.mjs:56-85），做了四件事：
  - 改写上游的 `installSection.nsh`，接入目录事务（:20-44，见 §9）；
  - 在 `allowOnlyOneInstallerInstance.nsh` 与 `installUtil.nsh` 的每个 `Quit` 前插入清理（:51-53）；
  - 从 `uninstaller.nsh` 删掉上游的 `RMDir /r` 数据删除段，把删除 `$INSTDIR` 改用长路径前缀（:92-98）；
  - 往 7za.exe 私有副本签名，并定义 `DSH_UPDATER_CACHE_NAME` 等宏（:70-83）。
- 守卫：`replaceOnce` 在模板文本变化时直接抛出「Desktop NSIS template changed」（:10-13），配合 app-builder-lib 精确钉版本。单测钉住「暂存早于关闭应用、替换早于注册」（apps/desktop/tests/windows-directory-installer.spec.ts:12、35）。
- 构建前钩子 `beforeBuild` 调 `prepare-windows-installer.ps1`，编译 DLL 并把 PNG 转成 BMP；有签名器时给 DLL 签名（electron-builder-config.mjs:116-128）。

**DM 现状**：完全用 electron-builder 默认模板，没有 `build/installer.nsh`，也没有 `nsis.include`（dm:electron-builder.yml:50-55）。

**差距与建议**
- DM 目前零定制，这本身就是低风险的优点，0.3.0 不动。
- 以后要加定制时，借 DSH 两条纪律（只借思路）：
  1. 只用 electron-builder 文档化的钩子宏（customInit、customInstallMode、customUnInstall、customCheckAppRunning、customHeader），不去 monkeypatch 模板；
  2. 一旦依赖模板内部变量（例如 `$isForceCurrentInstall`），就加一条源码守卫测试，并在 deps-frozen 里确认 electron-builder 锁定在确切版本。

---

## 2. 自绘安装页、window-frame.dll、侧栏图

**DSH 怎么做**
- 页面流程：自定义欢迎页，接着是隐藏的原生 INSTFILES 页，上面覆盖自绘进度窗，最后是自定义完成页（installer.nsh:82-97；installer/pages.nsh:33-180；installer/lifecycle.nsh:3-89）。
- 窗口：600×600 逻辑像素的方形窗，按 DPI 用 MulDiv 缩放。`InstallerApplyFrame` 做几件事：
  - 子类化 NSIS 主窗，去掉非客户区；
  - 保留 DWM 阴影，Win11 下加圆角；
  - 隐藏所有原生按钮（installer/window-frame.cpp:256-283；lifecycle.nsh:3-35）。
- 按钮：按钮与复选框用 NM_CUSTOMDRAW 配合 GDI+ 自绘，保留原生焦点、键盘操作与无障碍文本（pages.nsh:288-364）。
- 主题：跟随系统的 `AppsUseLightTheme`（installer/theme.nsh:51-63），命令行 `/THEME=light|dark|auto` 可以强制指定（installer.nsh:45-59）。
- 进度：7-Zip 的真实百分比加上阶段加权估算。只有 NSIS 报告成功之后才能到 100%，并且用 600ms 补满（installer/progress.h:3-60；window-frame.cpp:187-248）。
- 首次显示：只置前不抢焦点；前台是别的窗口时闪任务栏（window-frame.cpp:285-295；笔记 .agents/notes/implemented/bug-fix/2026-09-16-present-delayed-windows-installer.zh.md）。
- 侧栏图：设计稿 PNG 由 PowerShell 的 System.Drawing 转成 24 位 BMP，暗色版铺 #151517 底（apps/desktop/scripts/prepare-windows-installer.ps1:64-79）。`installerSidebar` 和 `uninstallerSidebar` 用同一张 164×314 的卸载侧栏图（electron-builder-config.mjs:234-235）。安装页本身是自绘的，所以侧栏图实际只出现在卸载器的欢迎页和完成页。
- 设计取舍记录在 .agents/notes/implemented/architecture/2026-09-10-windows-native-installer-pages.zh.md。否决了三个方案：Electron 做的安装界面（安装前就要引入运行时）、完整替换 NSIS 脚本（会丢掉 electron-builder 的签名卸载器与注册逻辑）、窗口区域裁圆角（会丢阴影）。

**DM 现状**
- 页面：默认的助理式安装器，依次是「安装选项」页（为哪位用户安装）、安装进度页、完成页（带「运行 DeskMinis」勾选）。依据 tpl:assistedInstaller.nsh:18-20、46-64。
- 侧栏图：没有配置，用的是 NSIS 自带的 `nsis3-metro.bmp`（app-builder-lib/out/targets/nsis/NsisTarget.js:431 的默认值）。
- 图标：`win.icon` 用的是 `build/icon.ico`，只有一个 256×256 的 PNG 条目（dm:electron-builder.yml:46；dm:scripts/gen-app-icon.mjs:1-5）。

**差距与建议**
- 自绘页不借，理由见 §0。
- 【W9，照抄改写】品牌侧栏图：
  - 仿照 gen-app-icon.mjs，用零依赖脚本画一张 164×314 的 24 位 BMP（BMP 不压缩，比 PNG 还好写），放在 `build/installerSidebar.bmp` 和 `build/uninstallerSidebar.bmp`；
  - electron-builder 会按文件名自动取用，不用改 yml；
  - 效果：完成页和卸载页不再是通用的 NSIS 图。
- 【W9，照抄思路】多尺寸图标：DSH 把 1024 的 PNG 交给 electron-builder，由它生成多尺寸 ICO（apps/desktop/README.zh.md:23）。
  - DM 的单条 256 ICO，在 16/24/32 像素的任务栏、标题栏、托盘外的系统界面上靠系统缩放，三条细的「对话行」可能发糊（推断，要看真机）。
  - 改法有两种：gen-app-icon 改为输出 512 或 1024 的 PNG 交给 electron-builder；或者在 ICO 里加 16/24/32/48 条目，小尺寸单独调粗线条。
  - 发版前在 RELEASE §3「任务栏图标」一项顺手看一眼即可。

---

## 3. 语言与字体、DPI

**DSH 怎么做**
- 语言：`installerLanguages: ['en_US', 'zh_CN']`（electron-builder-config.mjs:241）。所有自有文案在 installer/strings.nsh:1-57 里成对给出 LangString。
- 卸载器字体：统一用 Segoe UI 9，中文改用 Microsoft YaHei UI 9（installer.nsh:14-19）。安装页是自绘的，字体写死为 YaHei UI（installer/theme.nsh:17）。
- DPI：`ManifestDPIAware true`（installer.nsh:6）。
- 回归测试：分别构建「只有英文」和「只有中文」两个变体，看可见的欢迎页按钮文字来判断语言，再各自跑冒烟（apps/desktop/scripts/test-windows-installer.mjs:91-118）。

**DM 现状**
- 语言：没有设 `installerLanguages`。electron-builder 在 `unicode` 默认为真时，把 26 种内置语言全部打进安装包，按系统界面语言自动选，找不到就回落到第一个语言 en_US（NsisTarget 的 nsisLang.js:14-27；app-builder-lib/out/util/langs.js 的 bundledLanguages，共 26 个，首个是 en_US）。
  - 中文系统上显示中文安装器。关键文案都有 zh_CN 译文，例如 appRunning 是「${PRODUCT_NAME} 正在运行.\n点击“确定”关闭.」（tpl:messages.yml:81）；安装选项页、卸载选项页也有（tpl:assistedMessages.yml:11-356）。
  - 译文质量一般：中文里夹着英文句号。另外，「所有用户」选项被置灰时会拼上一段英文 "(must run as admin)"（tpl:multiUserUi.nsh:114）。
- DPI：模板里没有 `ManifestDPIAware`（tpl 全目录 grep 为空）。NSIS 默认 notset，也就是不声明 DPI 感知，在 125% 到 200% 缩放下会被系统位图拉伸、发糊（推断，依据 NSIS 文档语义）。
- 中文字体：取自 NSIS SimpChinese 语言文件的默认值，推断是宋体 9（本地没有 NSIS 发行包，未核实）。

**差距与建议**
- 【0.3.0 不必改】安装器语言：中文系统本来就是中文，关键字符串齐全。
  - `installerLanguages: zh_CN` 的唯一收益：英文系统上的中文用户也看到中文，安装包略小。
  - 代价：要在英文系统上看一眼中英混排。
  - 可以放到 0.3.x 顺手做，照抄一行。
- 【W9，照抄一行】加 `build/installer.nsh`，内容写 `ManifestDPIAware true`，再在 customHeader 里写 `SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9`。
  - 效果：高分屏下安装器和卸载器文字清晰。
  - 前提：这是 DM 第一次引入 NSIS include，要在真机的 100%、150%、200% 各看一次。欢迎完成页的位图是按 FitControl 拉伸的，会糊，但文字不会。

---

## 4. 只装当前用户（per-user）

**DSH 怎么做**
- 配置：`oneClick:false`、`perMachine:false`、`allowElevation:false`、`allowToChangeInstallationDirectory:false`（electron-builder-config.mjs:237-240）。
- `customInit`（installer.nsh:29-44）做三件事：
  - 命令行带 `/allusers` 就报错退出；
  - HKLM 里已经登记了安装位置，也报错退出，提示「请先卸载已有的所有用户安装版本」（strings.nsh:40-41）；
  - 最后强制 `setInstallModePerUser`。
- `customInstallMode`（installer.nsh:75-80）固定 CurrentUser 并 `Abort`，所以模板的「安装选项」页永远跳过。
- 安装目录实际上允许修改，但放在自绘欢迎页里改，自带校验（见 §5）。

**DM 现状**
- `oneClick:false`、`perMachine:false`，`allowElevation` 缺省为 true（dm:electron-builder.yml:50-55；NsisTarget.js:435-437）。
- 安装选项页因此每次都出现，列出「仅为我安装」和「为使用这台电脑的任何人安装（所有用户）」，后者带 UAC 盾牌（tpl:multiUserUi.nsh:31-146）。选了后者就提权，装到 Program Files。
- 影响：数据根、凭据、userData 都按用户分，按机器安装不会坏。但此后每次更新都要 UAC：
  - 非静默更新时，在安装选项页的 LEAVE 里提权（tpl:multiUserUi.nsh:149-190）；
  - 静默更新时，在安装段开头提权（tpl:installer.nsi:88-114）。

**差距与建议**
- 【0.3.x，照抄一行或三行】二选一：
  - (a) `nsis.allowElevation: false`：非管理员进程里「所有用户」一项置灰，文案带英文尾巴（tpl:multiUserUi.nsh:109-116），页面仍然出现；
  - (b) `build/installer.nsh` 里写 `!macro customInstallMode` 加 `StrCpy $isForceCurrentInstall "1"`，页面直接跳过（tpl:multiUserUi.nsh:41-65），包括自动更新时。
- (b) 的副作用：
  - 全新安装会一打开就开始装，没有确认页；
  - 已经按机器装过的老用户（0.1.1 时期若有人选了「所有用户」），会再装出一份按用户的副本。要照 DSH 的 customInit，检测到 HKLM 登记就提示先卸载。
- 推荐顺序：0.3.0 保持现状；0.3.x 先上 (a)；等决定走静默更新时（§11）再评估 (b)。

---

## 5. 安装路径校验（DSH 自定义目录的前提）

**DSH 怎么做**（installer/path.nsh:4-168）
- 长度限制：4 到 180 个字符（:7-11）。
- 必须是盘符路径，并且 `GetDriveTypeW` 为 DRIVE_FIXED，也就是本地固定盘（:12-20）。
- 禁止的字符：`: * ? " < > | /` 和控制字符（:21-41）。
- 路径的每一级都要检查三项：
  - 末尾不能是 `.` 或空格；
  - 不能是保留设备名（CON、PRN、AUX、NUL、COM1-9、LPT1-9，带扩展名也算）；
  - 不能是重解析点，也不能不是目录（`0x400` 即 FILE_ATTRIBUTE_REPARSE_POINT）（:42-107）。
- 不能落在 Windows 目录、Program Files 内，也不能直接选用户目录或 LocalAppData 本身（:93-105）。
- 用 `GetFullPathNameW` 规范化（:108-114）。
- Preflight 阶段再查三项：
  - 新装只允许空目录；非空时必须正是已登记的安装目录，并且里面有主 exe（:125-140；文案见 strings.nsh:34-35）；
  - 用 `GetTempFileNameW` 探测可写性（:141-154）；
  - 用 `GetDiskFreeSpaceExW` 按 `APP_64_UNPACKED_SIZE + 64MB` 检查剩余空间（:155-167）。
- 为什么这样做：上游的卸载器会 `RMDir /r $INSTDIR`（tpl:uninstaller.nsh:187）。用户如果把应用装进 `D:\` 或已有资料的目录，卸载时会把整个目录一起删掉。只接受空目录或已登记目录，就把这个风险堵死了。

**DM 现状**：`allowToChangeInstallationDirectory` 缺省为 false，安装目录固定在 `%LOCALAPPDATA%\Programs\<名>`（按用户），或者 Program Files（按机器），没有这类风险。

**差距与建议**
- 无需动作。
- 如果将来打开「选择安装目录」，必须同时借这套校验（只借思路）。上游的 `instFilesPre` 只是用 StrContains 判断路径里是否包含应用名，不是就补一级子目录（tpl:assistedInstaller.nsh:33-38）。像 `D:\DeskMinisProjects` 这样的已有目录会被原样接受，卸载时整目录删除（推断，依据模板逻辑）。

---

## 6. 运行中进程的检测与结束（安装、卸载都会走）

**DSH 怎么做**
- 用 `customCheckAppRunning`（installer.nsh:163-192）替换模板默认的实现：
  - 调用 DLL 的 `InstallerFindProcess`，按**完整的 exe 路径**匹配。枚举进程快照，文件名相同的，再用 `QueryFullProcessImageNameW` 比较长路径全文（window-frame.cpp:54-84）。别的目录里的同名程序不受影响；
  - 更新场景（isUpdated）：每 250ms 查一次，最多 40 次，也就是等应用自己退出 10 秒；
  - 其它场景：提示「DeepSeek Harness 正在运行。请先关闭应用，再重新运行安装程序」（strings.nsh:30-31），然后以退出码 2 结束。**从不结束用户的进程**；
  - 读不到进程表时（返回 -1）报界面错误并退出（:187-191）。
- 卸载器也先抽出 DLL 再走同一段逻辑（:164-167）。
- README 的说明：「受影响安装路径中的程序运行时显示系统提示，并保持应用运行；…静默更新最多等待受影响应用退出十秒，若仍在运行则以退出码 2 结束」（apps/desktop/README.zh.md:272）。

**DM 现状**：模板默认的 `_CHECK_APP_RUNNING`（tpl:include/allowOnlyOneInstallerInstance.nsh:105-164）。
- 识别方式：优先用 PowerShell 的 `Get-CimInstance Win32_Process`，按 `Path.StartsWith('$INSTDIR')` 做前缀匹配（:64-79）；PowerShell 不可用时，退回 tasklist 按映像名匹配。
- 非更新场景：弹 OK/取消框「DeskMinis 正在运行.点击“确定”关闭.」（:120）。点确定后执行 `Stop-Process`（非强制）→ 等 300ms → 再查 → 等 1 秒 → 强制结束（:127-141）→ 仍失败则弹「无法关闭，请手动关闭后重试」。
- 更新场景：先等 300ms，查到就等 1 秒，然后不弹框直接结束（:108-119）。
- 调用位置：安装段在 INSTFILES 开头调用（tpl:installSection.nsh:35-37），卸载器也调用（tpl:uninstaller.nsh:1-3、148-152）。
- 后果：`Stop-Process` 就是 TerminateProcess，不触发 before-quit。W1b 做的优雅关停（dm:src/main/index.ts:480-492；dm:src/main/minisd-stop.ts:1-7）在这条路上全部失效：
  - 半截回复不落库；
  - 锁文件留给下次按 pid 接管；
  - 会不会留下孤儿子进程，取决于 libuv 的作业对象（dm:src/minisd/proc/win-exec.ts:23 的推断注释）。
- 两个前提：DM 关窗只是藏到托盘（index.ts:264），用户多半不知道它还在运行；0.1.1 的用户手动装 0.3.0 时，**一定**会走到这条路（§12）。

**差距与建议**
- 【W6a，只借思路】写一个 `customCheckAppRunning`：
  - 非更新场景先提示「DeskMinis 仍在托盘里运行：请右键托盘图标选『退出』，然后点『重试』」（MB_RETRYCANCEL），让优雅关停有机会跑完；
  - 用户选「强制结束」时，再调用模板的 KILL_PROCESS 兜底；
  - 识别改为完整 exe 路径加子进程，不用路径前缀。前缀匹配会把 `...\Programs\DeskMinis-xxx` 这类兄弟目录也算进来（推断，边缘情况）。
- 进一步的想法：让安装器执行 `"$INSTDIR\DeskMinis.exe" --quit-for-install`，由单实例锁的 second-instance 转给正在运行的实例，让它优雅退出。
  - 限制：只对 0.3.0 及以后有单实例锁的版本安全。0.1.1 没有单实例锁（`git show 6c48c8b:deskminis/src/main/index.ts` 没有 requestSingleInstanceLock），这样做会再起一整个实例；
  - 顺序：放在 W6a 做 launcher 之后。
- 0.3.0 不改，只在 RELEASE §3 加一条手测（§12）。

---

## 7. 旧版清理（覆盖安装、升级）

**DSH 怎么做**
- 同目录升级不跑旧卸载器。改写后的 `uninstallOldVersion` 宏：已登记目录等于 `$INSTDIR` 时直接视为成功（windows-directory-installer.mjs:27-37）。旧文件由目录事务整体替换（§9）。
- 跨目录或跨范围迁移时，保留上游行为：以 `/S /KEEP_APP_DATA --updated` 调用旧卸载器（笔记 2026-09-11-windows-directory-installation.zh.md「同路径升级跳过旧卸载器…不同路径和安装范围迁移保留 electron-builder 的旧卸载器行为」）。
- 目的：旧卸载器会先删掉回滚副本或注册信息；跳过它，就能保留回滚能力。

**DM 现状**：上游默认流程。
- 安装段依次调用 `uninstallOldVersion SHELL_CONTEXT`；按机器安装时，再对 HKCU 调一次（tpl:installSection.nsh:52-58）。
- 旧卸载器先复制到 `$PLUGINSDIR`，再以 `/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=<旧目录>` 执行（tpl:include/installUtil.nsh:184-230），失败会重试。
- 旧卸载器在 `--updated` 下调用 `un.atomicRMDir`，把旧文件逐个改名移到临时目录；遇到占用就还原并 Abort（tpl:uninstaller.nsh:164-182）。
- 新安装器收到非零退出码时，弹「uninstallFailed: 码」并退出（tpl:include/installUtil.nsh:128-133）。
- 解压：先 7z 解到 `$PLUGINSDIR\7z-out`，再 `CopyFiles` 复制到目标（tpl:include/extractAppPackage.nsh:92-138）。复制失败重试 5 次，之后问用户；用户坚持重试的最后手段是「不管错误直接 Nsis7z 覆盖」（:119-127）。

**差距与建议**
- DM 的载荷只有约一百个文件：Electron 发行目录约 74 个（Linux 版 node_modules/electron/dist 实数），主体代码在 app.asar 里，另有少量 .node（推断 Windows 版量级相同）。
- DSH 的目录事务要解决的是 1.1 万个散文件复制太慢（组件基线 101/79/114 秒，笔记 2026-09-11），以及混合版本问题。对 DM 来说，默认的「先原子搬走旧目录，再复制」已经够用。**不借。**

---

## 8. 快捷方式、AppUserModelId、注册表

**DSH 怎么做**
- 快捷方式和 AUMID 全交给上游：开始菜单与桌面快捷方式都写入 `WinShell::SetLnkAUMI <appId>`（tpl:include/installer.nsh:189-240），卸载时 `WinShell::UninstAppUserModelId`（tpl:uninstaller.nsh:191）。
- 主进程**没有**调用 `app.setAppUserModelId`（apps/desktop/src 全文 grep 为空）。
- 注册表额外补一项：把标准的 `InstallLocation` 写进 Uninstall 键，供清单工具（例如 winget）读取；上游只写在自己的私有键里（installer.nsh:206-207；上游见 tpl:include/installer.nsh:103-104）。
- 协议注册与卸载残留见 §15。

**DM 现状**
- 快捷方式同样由上游生成，AUMID 是 appId `com.deskminis.app`（dm:electron-builder.yml:3）。`shortcutName: DeskMinis`（:53）。
- 主进程也没有 `setAppUserModelId`（dm:src 全文 grep 为空）。
- Uninstall 键里的「发布者」是空的：package.json 的 `author` 为空串，上游只在 `COMPANY_NAME` 存在时写 Publisher（tpl:include/installer.nsh:132-134），「应用和功能」里发布者一栏会空着（推断）。

**差距与建议**
- 【0.3.0 真机一分钟核对，推断】Electron 没有显式设置 AUMID 时，会在需要时自己生成 `electron.app.<应用名>` 并套到进程或窗口上（凭对 Electron 源码 application_info_win 的记忆，未核实）。
  - 如果确实如此，窗口的 AUMID 就和快捷方式上的 `com.deskminis.app` 对不上：固定到任务栏的图标和运行中的窗口可能分成两个按钮，将来的系统通知来源名也会不对。
  - 核对方法：从开始菜单启动，右键任务栏按钮选「固定」，退出，再点固定项启动，看是否只有一个按钮。
  - 如果复现，在 0.3.0 前补一行 `if (app.isPackaged) app.setAppUserModelId('com.deskminis.app')`。理由：用户的固定项会长期保留，晚改会让老的固定项失配。
  - 路线图 W7b 已经排了这一行（roadmap.md W7b 范围），这里只是提前。便携版没有快捷方式，设不设都无害。
- 【可选，0.3.x】package.json 填 `author`，「应用和功能」里就有发布者，exe 属性里也有公司名（DM 自有观察，不是从 DSH 借的）。
- 【不借】`InstallLocation` 写进 Uninstall 键，收益太低。

---

## 9. 目录事务、解压进度与失败报告

**DSH 怎么做**
- 流程（installer-directories.nsh）：
  - 先把新版完整解压到 `$INSTDIR.new-<GUID>`（:30-60）；
  - 解压用 DLL 的 `InstallerExtract`，它通过管道读取 7-Zip 的百分比；7-Zip 子进程放进关闭即结束的 Job，只继承标准句柄（installer/extract.h:40-104）；
  - 解压退出码非零就回滚，并生成报告（:9-28）；
  - 成功后把旧目录改名为 `.old-<GUID>`，新目录改名为正式目录（:95-127）；
  - 注册表写完后再删掉 `.old`（:129-135）；
  - 任何 `Quit` 以及 `.onGUIEnd` 都会回滚（:62-93）。
- 失败报告：写到 `%LOCALAPPDATA%\<updater缓存名>\installer-logs\extract-failure-<时间>.log`（installer.nsh:128-161）。对话框显示标题句加「复制错误信息」「显示详情」（installer/extract-report.h）。提示文案点名「可能是安全软件拦截了文件，或磁盘空间不足」（strings.nsh:44-45）。
- 实测：首装 38.0 秒，同路径升级 27.5 秒（笔记 2026-09-11）。

**DM 现状**
- 上游流程见 §7。任何一次 `CopyFiles` 失败，都只弹 `appCannotBeClosed`，也就是「DeskMinis 无法关闭。请手动关闭它，然后单击重试以继续。」（tpl:include/extractAppPackage.nsh:108-117；tpl:messages.yml:128）。
- 被安全软件拦截、磁盘满、文件被别的程序占用，都会显示成「应用关不掉」，误导用户去找一个并不存在的运行实例（推断，依据模板读码）。

**差距与建议**
- 目录事务：不借（§7）。
- 【0.3.0，文档一行，零代码】在 README 安装一节补一句：「装的时候提示『DeskMinis 无法关闭』，但它并没有在运行：多半是安全软件拦截了安装包里的文件。先临时放行 DeskMinis 的安装目录或安装包，再点重试」。国产安全软件对未签名安装包比较敏感（推断），DM 的安装包没有签名（dm:README.md:79）。
- 【W9 以后，只借思路】要让报告真正可用，就要改 `extractUsing7za` 宏。这属于模板内部，成本不低。先靠文档。

---

## 10. 卸载清理范围

**DSH 怎么做**
- `customUnInstall` 调用 `un.CleanData`（installer.nsh:86-88；installer/uninstall.nsh:12-36）：
  - `isUpdated` 时直接返回，带 `/KEEP_APP_DATA` 时也直接返回（:13-22）。后者正好覆盖了 electron-builder 升级时调用旧卸载器的两种情形；
  - 以 Windows 环境变量形式发布的 `DSH_HOME` 被保护，重叠的路径一律不删（:23-24）；
  - 要删的：`%APPDATA%\<productFilename>`、`%APPDATA%\<包名>`（带 scope 的会嵌套一层），并清掉 `%APPDATA%` 之下已空的父目录（:26-33）；
  - 以及 `%LOCALAPPDATA%\<updaterCacheDirName>`（:34-35）。
- 删除不用 NSIS 的 `RMDir /r`，交给 DLL 做（installer/uninstall-data.h:96-150）：
  - 拒绝已知目录（Profile、AppData、Desktop、Documents、Program Files 等）及其祖先，拒绝与安装目录或受保护主目录重叠的路径，要求本地固定盘；
  - 遍历时以列举权限持有父目录句柄，防止中途被改名替换（:42-54、136-148）；
  - 遇到重解析点只解链，不进入（:63-94）；
  - 清掉只读属性；某个文件被占用就跳过，继续删其它文件，残余不报错。
- 主目录（会话、凭据、插件）永不删除。上游的 `deleteAppDataOnUninstall` 被判为不可用，理由是「不遵守归属、不支持长路径、会进入链接目录」（笔记 .agents/notes/implemented/feature/2026-09-08-desktop-uninstall-preserve-dsh-home.zh.md）。

**DM 现状**
- `deleteAppDataOnUninstall: false`（dm:electron-builder.yml:54）。上游卸载器只删安装目录、快捷方式和注册表（tpl:uninstaller.nsh:160-254），会留下三样：
  - `%APPDATA%\DeskMinis`：打包态下 userData 与数据根是同一个目录，NTFS 不分大小写（dm:src/main/app-dirs.ts:29-31、50）；
  - `%LOCALAPPDATA%\DeskMinis\logs`（app-dirs.ts:35-37、49）；
  - `%LOCALAPPDATA%\deskminis-updater`：updaterCacheDirName 等于小写包名加 `-updater`（app-builder-lib/out/appInfo.js:126-128），里面是安装程序自身的副本和已下载的安装包。
- 文档已经如实写明，并给出彻底清理的方法，包括凭据管理器条目（dm:../README.md:127-136；dm:../CHANGELOG.md:175；dm:../docs/RELEASE.md:155-157）。

**差距与建议**
- DM 的 userData 与数据根是同一个目录，所以**不能**照搬 DSH「卸载删 userData」那一半：会删掉 minis.db。
- 【0.3.x，照抄改写，约 10 行】可以照抄「删更新器缓存」那一半：
  - 做法：写 `customUnInstall`：`${IfNot} ${isUpdated}`，再判断没有 `/KEEP_APP_DATA`，然后 `RMDir /r "$LOCALAPPDATA\deskminis-updater"`；日志目录是否一起删，交给用户拍板；
  - **两道闸必须照抄**：electron-builder 升级时，会以 `--updated /KEEP_APP_DATA` 调用旧卸载器，而新安装器可能正从 deskminis-updater\pending 里运行。没有闸就会去删它自己所在的目录（推断）；
  - 固定路径 `RMDir /r` 足够，不需要 DLL。按机器安装时先 `SetShellVarContext current`；
  - 做完同步改 README:134-136、CHANGELOG 已知边界和 RELEASE §3 卸载那一条。
- 【只借思路，长期】把 Electron 的 userData（Chromium 缓存、localStorage、update-prefs）从数据根挪到 `%LOCALAPPDATA%\DeskMinis\electron`，缓存就不会随漫游配置或 OneDrive 同步，也可以在卸载时安全删除。
  - 代价：丢失已保存的主题和更新开关（app-dirs.ts:29 的注释已经说明）；单实例锁的位置也会变，升级那一次新旧版本可能各算一个实例。
  - 结论：近期不做。
- 0.3.0 不改：文档已经到位。

---

## 11. 运行中升级：自动更新的安装交接（0.3.0 定型）

**DSH 怎么做**
- 交接前：inspect → 确认 → lock → 停 Host，要求优雅退出（apps/desktop/src/main.ts:504-548）[dsh.md 已写]。
- 然后调用 `quitAndInstall(true, true)`（apps/desktop/src/update-coordinator.ts:133）：静默安装，装完自动启动。
  - 安装器侧：`customCheckAppRunning` 在更新时最多等 10 秒（§6）；
  - 欢迎页在 `isUpdated` 时跳过（lifecycle.nsh:37-43），完成页启动时带 `--updated`（pages.nsh:219-245）。
- 已接管退出（`shellInstallerOwnsQuit`）时，before-quit 直接放行（main.ts:540、1038-1044）。

**DM 现状**
- 自动下载完成后弹框，文案是「现在重启即可用上新版本；也可以继续用当前版本，下次启动时再装。」，按钮是「稍后再说 / 重启并安装」（dm:src/main/index.ts:296-315）。
- 选安装后：优雅停 minisd → markStopped → `autoUpdater.quitAndInstall()`（没有参数）→ 3 秒后兜底退出（:315；dm:src/main/relaunch.ts:18-21）。
- 无参数时 `isSilent=false`（upd:BaseUpdater.js:13-16），electron-updater 只传 `--updated --force-run`，不传 `/S`（upd:NsisUpdater.js:101-112；autoRunAppAfterInstall 默认为 true，upd:AppUpdater.js:119）。
- 因此，每次自动更新都会以**非静默的助理式向导**运行（推断，据模板读码，未上真机）：
  - 「安装选项」页照常出现。它的 PRE 函数只认 `/currentuser`、`/allusers` 和 customInstallMode，**没有 isUpdated 跳过**（tpl:multiUserUi.nsh:31-66）。默认选中「仅为我安装」，说明是「已经存在一个安装到当前用户的安装…即将重新安装/升级」，旁边就是带 UAC 盾牌的「所有用户」；
  - 接着是安装进度；
  - 然后是完成页，勾着「运行 DeskMinis」，由用户点「完成」才启动（tpl:assistedInstaller.nsh:46-64）。`--force-run` 只在静默模式下生效（tpl:installSection.nsh:104-109）。
  - 这和对话框里「现在重启即可」的说法不一致。
- 测试钉住了现状：`quitAndInstall()` 这个写法被 dm:tests/main-shutdown-wiring.test.ts:143 的正则固定；dm:tests/auto-update.test.ts:56 是负向正则，不受参数影响。
- 托盘隐藏时的可见性（推断）：下载完成的对话框挂在 `BrowserWindow.getAllWindows()[0]` 上（index.ts:298-307）。主窗口可能正藏在托盘里，这时模态框挂在隐藏的父窗口上，没有独立的任务栏按钮，可能被别的窗口压住，用户看不到。托盘手动检查的回执刻意不挂父窗口（index.ts:349-355 的注释），两处处理不一致。

**差距与建议**
- [见 notes-lifecycle §12.3：那里判断「静默与否属于产品取舍，不借」。本节补充上面的具体事实，并说明为什么必须在 0.3.0 定下来。]
- 为什么要在 0.3.0 定：0.3.0 → 0.3.1 的第一次自动更新，由 0.3.0 装机里的这段代码执行，发布之后改不了（只能影响再下一次）。
- 【0.3.0 / W3，零代码或一行】三选一，并且在真机演练过（演练方法见 §12）：
  - (a) 照抄 DSH，改成 `quitAndInstall(true, true)`：静默安装，装完自启；同时改 main-shutdown-wiring.test.ts:143 的正则。按机器安装时静默也会弹 UAC（tpl:installer.nsi:88-114），不会坏；
    - 静默的代价：失败时看不见。例如复制失败走 `/SD IDCANCEL` 直接退出，用户看到的是应用没了，又没有新版。要补一条「新版没起来时去哪里看」的文档；
  - (b) 保留向导，只改文案：「点『重启并安装』会关闭 DeskMinis 并打开安装程序：保持『仅为我安装』，点『下一步』，完成页保持勾选『运行 DeskMinis』」；
  - (c) 保留向导，加 customInstallMode 跳过安装选项页（§4-b），这就是新的安装器定制。
  - 倾向：0.3.0 取 (b)，风险最低；(a) 等 W6a 做完「重启并安装失败后就地恢复」（见 notes-lifecycle §19-E）之后再考虑。
- 托盘隐藏时下载完成的提示：放 W7b 的注意力回路（flashFrame 加通知）[dsh.md R3 已写机制]。0.3.0 只在演练时看一眼能不能看到。

---

## 12. 手动覆盖安装与演练方法（0.3.0 零代码核对）

**事实**
- 0.1.1 的更新源是私有仓库，永远 404，所以 0.1.1 的用户只能手动装一次 0.3.0（dm:../CHANGELOG.md:172；dm:../docs/RELEASE.md:208）。
- 0.1.1 关窗同样藏到托盘，而且**没有**单实例锁（git 6c48c8b 的 main/index.ts:99、215-218，全文没有 requestSingleInstanceLock）。
- appId 和 productName 与 0.3.0 相同（6c48c8b 的 electron-builder.yml:3-4），会被识别为同一个应用做升级。
- RELEASE §3 只写了「干净机器 / 干净目录安装」（dm:../docs/RELEASE.md:120），没有「覆盖一个正在运行的旧版」，也没有演练自动更新。

**建议加进 RELEASE §3 的两条（W3，零代码）**
1. **覆盖运行中的 0.1.1**：
   - 步骤：装 0.1.1（私仓 Release 的安装包），建两个会话、配一个 key，关窗藏到托盘；然后运行 0.3.0 的 Setup。
   - 预期：
     - 安装选项页默认选「仅为我」，并提示「即将重新安装/升级」；
     - 进入安装步骤后弹「DeskMinis 正在运行.点击“确定”关闭.」，点确定后被结束（§6）；
     - 旧卸载器以 `/KEEP_APP_DATA --updated` 静默运行（§7），装完勾选运行；
     - 会话和 key 都在：数据根与 keyring 服务名 `DeskMinis` 都没变；DB 迁移跑过，user_version 前进；
     - 开始菜单和桌面各只有一个快捷方式，「应用和功能」里只有一条 DeskMinis 0.3.0。
   - 附带观察：快捷方式图标如果还是旧的 Electron 默认图标，多半是系统图标缓存，不是缺陷（推断）。
2. **自动更新演练**：
   - 为什么现在就要做：不用等 0.3.1 上架，也不用额外代码。
   - 步骤：
     1. 装好 0.3.0，打开 `%LOCALAPPDATA%\Programs\DeskMinis\resources\app-update.yml`，改成 `provider: generic`、`url: http://127.0.0.1:<端口>/`。这个文件在每次检查时读取（推断，依据 electron-updater 行为）。
     2. 本机把 version 临时改成 0.3.0 以上（例如 0.3.99），打一个包，不提交。用 `npx http-server` 或 `python -m http.server` 提供 `latest.yml` 和 Setup.exe。
     3. 重启 0.3.0，等下载完成弹框，点「重启并安装」。
   - 观察四件事：
     - 向导实际长什么样（§11）；
     - 主窗口藏在托盘时，这个框能不能看见；
     - 装完是否自启，数据是否都在；
     - `%LOCALAPPDATA%\deskminis-updater` 的变化。
   - 用途：以此决定 §11 的 (a)、(b)、(c)。
   - 和 notes-testing 的关系：那边提议在 W3 之后写自动化的 `scripts/qualify-updater.mjs`（假安装器，只记录调用）。这里是发版前一次性的真安装器演练，两者互补。

---

## 13. 单实例与 second-instance

- DSH：在碰任何 profile 之前 `requestSingleInstanceLock`；second-instance 时聚焦主窗口，或者重新建窗口；**不读 argv**（apps/desktop/src/single-instance.ts:16-26；main.ts:1116）[dsh.md 已写]。
- DM：W1b 已做。锁在 setPath('userData') 之后申请；second-instance 能唤出藏在托盘里的窗口，窗口还没建好时先记下「待唤出」（dm:src/main/index.ts:60-77、447）。
- 结论：无差距。DM 另有数据根锁兜底，覆盖两份 userData 指向同一个数据根的情况（index.ts:62-63）。

---

## 14. 托盘

- DSH：**没有托盘**。关掉最后一个窗口就退出（apps/desktop/src/main.ts:1035-1037）。
- DM：
  - 常驻托盘，托盘菜单有显示主窗口、切换右栏、打开设置、检查更新、退出（dm:src/main/index.ts:196-209、448-452）；
  - 关窗只是隐藏（:264），定时任务靠它在后台跑；
  - 托盘图标是 32×32 的 PNG（dm:resources/tray.png；dm:scripts/gen-tray-icon.mjs:12-18）。
- 结论：DM 更好，这是 cowork 场景需要的。「首次隐藏到托盘要告知用户」[见 notes-ui §10.2，W7b]。
- 顺带一点，DM 自有，不是从 DSH 借的：托盘图标只有单张 32px 图，100% 缩放下由系统缩到 16px。以后可以给 nativeImage 加一个 `@2x` 变体或者用 ICO，W9 再看。

---

## 15. 协议处理（dsh://）

**DSH 怎么做**
- 注册：electron-builder 配置里写了 `protocols: [{ name, schemes: ['dsh'] }]`（electron-builder-config.mjs:102），但这一项只作用于 mac、Linux 和 appx。NSIS 不会写协议注册表（DM 本地的 app-builder-lib 里 grep `protocols`，只在 electronMac、LinuxTargetHelper、AppxTarget 里出现）。
- Windows 上实际靠运行时 `app.setAsDefaultProtocolClient('dsh')` 注册，只在打包版或开发 App 里做（main.ts:1026）。
- `open-url` 只认精确的 `dsh://open` 或 `dsh://open/`，作用是聚焦窗口（:1027-1030）。这个事件只在 macOS 上有；Windows 上协议激活会新起一个进程，被单实例锁挡下，再经 second-instance 聚焦。argv 不解析，也就不带任何参数或凭据（README.zh.md:413：「只显示窗口而不传递凭证」）。用途是浏览器登录完成后回到应用。
- 反面教材：卸载时**从不**删 `HKCU\Software\Classes\dsh`（installer 与 src 全文 grep 不到 removeAsDefaultProtocolClient 或 DeleteRegKey Classes）。卸载之后，这个协议键还指向一个已经不存在的 exe。

**DM 现状**：没有协议，也没有这类需求 [见 notes-security：「无差距」]。

**建议（将来需要时，只借思路）**
- 运行时注册，只在打包版里做；
- 在 second-instance 的 argv 里按白名单解析，只接受无参的动作；
- 永不携带凭据；
- 同时在 customUnInstall 里，在非 `isUpdated` 时 `DeleteRegKey HKCU "Software\Classes\deskminis"`。

---

## 16. 系统通知、任务栏闪烁、进度与徽标

- DSH：
  - 通知只用在一个地方：「更新已就绪」的注意力提示。窗口不在前台时 `flashFrame(true)`，并发一条静默通知；点击只回到确认界面，获焦就清除（apps/desktop/src/update-attention.ts:23-73）[dsh.md R3 已写]。
  - 没有 `setProgressBar`、`setOverlayIcon`、`setBadgeCount`。下载百分比显示在应用内账户行（README.zh.md:351）。
- DM：
  - 完全没有 Notification、flashFrame、setProgressBar（dm:src 全文 grep）；
  - 路线图 W7b 已经排了通知、flashFrame 和 AUMID（roadmap.md W7b）。
- 结论：DSH 在这方面没有新东西可借。
- 可选的小项，DM 自有，放 W7b：更新下载期间用 `win.setProgressBar(p)` 在任务栏按钮上显示进度，下载完成或出错时设回 -1；「待批准」可以用 `setOverlayIcon` 做任务栏角标。

---

## 17. 开机自启、文件关联

- 两边都没有：没有 `setLoginItemSettings`，也没有 `fileAssociations`（两个仓库 src 全文 grep）。
- DM 的定时任务只在应用运行时触发，比 DSH 更需要开机自启。如果要做（只借思路，放 W7b 或以后）：
  - 用 `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`，默认关闭，由用户在设置里打开；
  - 写入的 Run 值名缺省取 AUMID（dm:node_modules/electron/electron.d.ts:22321），又一个应该先把 AUMID 定死的理由（§8）；
  - 卸载时上游不会删 `HKCU\...\Run` 下的这个值（推断，模板里 grep 不到），要在 customUnInstall 里删。
- 文件关联：cowork 场景下「双击 .docx 用 DeskMinis 打开」的价值不大，不做。

---

## 18. 拖放

- [dsh.md R4 已写]：DSH 的 preload 用 `webUtils.getPathForFile` 取真实路径，拖入或选取的非图片文件、文件夹插成 `@path` 引用，不上传（apps/desktop/src/preload-app.ts:42-47）。
- DM：只接收图片（dm:src/renderer/src/ui/Composer.vue:180-216）。拖入 .docx 这类文件时 onDrop 直接 return，默认导航又被 will-navigate 拦下，结果是静默无反应。
- 补充一点：Electron 32 起 `File.path` 已经移除，DM 用的是 Electron 38，必须走 preload 的 webUtils。不再展开。

---

## 19. 「用系统程序打开」：走 explorer.exe（新，9/24 未写）

**DSH 怎么做**
- 笔记 .agents/notes/implemented/bug-fix/2026-09-22-windows-open-through-shell-resolution.zh.md：
  - 故障现象：某台 Win11 上，`.yml` 的默认程序只记在 `...\FileExts\.yml\UserChoiceLatest` 里。在宿主进程中，`Invoke-Item`、`cmd /c start`、`Shell.Application` 的默认动词、`AssocQueryString` 都认为「没有关联应用」，`Invoke-Item` 还返回 0，于是界面显示「已打开」，实际上什么也没发生。
  - 改法：把路径作为一个 argv 元素交给 `explorer.exe`，编码成 file URI，只对 `,` 和 `=` 做百分号编码（资源管理器按这两个字符分段），非 ASCII 字符保持字面。Explorer 的退出码 1 表示「已转交」，按成功处理。
  - 已知限制：非交互会话（服务、SSH 的 session 0）里同样返回 1，却什么也不做。

**DM 现状**：只有 `shell.openExternal`，而且只接受 http、https、mailto（dm:src/main/index.ts:222-228）。没有打开本地文件的入口，路线图 W8a 计划做「用系统程序打开」。

**建议（W8a，只借思路）**
- 先在真机上核对 Electron 的 `shell.openPath`（在主进程里调用 ShellExecuteEx）在「默认程序只记在 UserChoiceLatest」的 Win11 上是否犯同样的病（推断：有可能，因为它和 Shell.Application 用同一套解析）。
- 如果犯病，改成 `spawn(<System32>\\explorer.exe, [fileUri])`，编码规则照抄。
- 「在文件夹中显示」同样走 explorer，参数为 `/select,<编码后的 URI>`。
- 验收：路径里带逗号、等号、中文的文件都能打开到正确的目标。

---

## 20. 子进程与控制台窗口隐藏

- [dsh.md 已写]：DSH 普通子进程用 `windowsHide:true`；原生创建进程时，把 `STARTF_USESHOWWINDOW` 和 `SW_HIDE` 与标准句柄一起传入；不用 `CREATE_NO_WINDOW`，因为受限令牌下会触发 0xC0000142（笔记 2026-09-16-windows-subprocess-console-visibility、2026-09-03-hidden-windows-subprocess-windows）。
- DSH 的 Host 是以 `ELECTRON_RUN_AS_NODE` 拉起的 Electron exe，没有设 windowsHide（apps/desktop/src/host-process.ts:163-175；node-environment.ts:12-18）。Electron 主程序是 GUI 子系统，本来就不会弹控制台，这一点和 DM 的 bridge-node.cmd 情况一致（dm:scripts/bridge-node.cmd）。
- DM：W1b 已经做完。shell、终端、MCP、where.exe、taskkill 都带 windowsHide，taskkill 用 System32 绝对路径（dm:src/minisd/proc/win-exec.ts:84、119；tools/shell.ts:85-88；terminal.ts:87-91；mcp/stdio.ts:72、100-101；bridge/server.ts:64；market/install.ts:256）。
- 结论：无差距。
- DSH 笔记里有一条附带结论可以记下：被隐藏的宿主「直接启动」的 GUI 程序也会继承隐藏。所以将来「打开文件」必须走主进程的 shell 或 explorer（§19），不能让 agent 的 PowerShell 去 `Invoke-Item`。

---

## 21. asar 解包、原生模块、ripgrep、LibreOffice kit、熔丝

**DSH 怎么做**
- 解包规则：`**/*.{node,dylib,dll,so,exe}`、`**/*.so.*`、`**/spawn-helper`、`**/@vscode/ripgrep-*/bin/rg`，以及整个 `@deepseek-ai/libreoffice-kit-<平台>-<架构>` 目录（electron-builder-config.mjs:72-73）。beforePack 再算出 Office 包依赖闭包，追加解包规则（:166-171；scripts/libreoffice-packages.mjs:24-70）。
- Windows 上把随包运行时里的每个 PE 文件逐个列成解包规则（apps/desktop/scripts/windows-asar-unpack.mjs:25-48）。签名之后校验每个 PE 都已解包、不是链接、字节与签名版一致（:57-70；electron-builder-config.mjs:192、201）。这套校验是为了保住预签名。
- ripgrep：用 `@vscode/ripgrep`。在 Electron 里把路径中的 `.asar` 换成 `.asar.unpacked`（packages/fs/tool-fs-search/src/search-core.ts:172-183），执行时固定前置 `--no-config`（:239）。理由见 :194-196：宿主的 `RIPGREP_CONFIG_PATH` 可以注入 `--pre`，让 ripgrep 对每个文件执行任意程序。
- 熔丝：显式写 `electronFuses: { runAsNode: true }`（electron-builder-config.mjs:115），因为要用 Electron exe 充当 Node 拉起 Host。

**DM 现状**
- 显式解包 better-sqlite3 与 keyring 的原生包（dm:electron-builder.yml:34-36）。上游 smartUnpack 默认开启，含 .node、.dll、.exe、.so 的模块目录会自动解包（app-builder-lib/out/asar/asarUtil.js:71；unpackDetector.js:8-11、30），两道保险。
- e2e-m5 检查这两个 .node 确实已解包（dm:scripts/e2e-m5-packaging.mjs:127-135）。
- 不随包 ripgrep：零依赖。系统里装了 rg 时，它在只读白名单里免审（dm:src/minisd/tools/permissions.ts:48、86），命令行上的 `--pre`、`--pre-glob`、`--hostname-bin` 会被拒（:96-101、177-178）。**没有考虑** `RIPGREP_CONFIG_PATH`。子进程环境只剥掉 DESKMINIS_* 前缀（dm:src/minisd/proc/child-env.ts:13-15）。
- LibreOffice：不引入 [dsh.md R2 已写]。
- 熔丝：没有配置，全用默认值，runAsNode 默认开启。DM 的 bridge-node.cmd 和 `npm test` 都依赖它。

**差距与建议**
- asar：够用，不借 DSH 的逐字节校验，那是为签名服务的。
- ripgrep：
  - 【W6d，只借思路】在 childEnv 里去掉 `RIPGREP_CONFIG_PATH`，或者只在它没设时才让 rg 免审，二选一；同时写进 CHANGELOG 已知边界，和 git 读仓库配置那一条并列（dm:../CHANGELOG.md:197）。
  - 风险评估：低。要求用户环境里本来就设了这个变量，而且它指向 agent 能免审写入的位置（推断）。
- 熔丝：
  - 【W9 或以后，照抄一行】在 electron-builder.yml 里显式写 `electronFuses: { runAsNode: true }`，并加注释「bridge-node.cmd、npm test 依赖它」。这样将来做熔丝加固时不会误关 [熔丝加固整体见 notes-security §5]。

---

## 22. 递归删除与 junction

- [见 notes-lifecycle §15，那里已给出 W8c 的建议，这里只补一个出处。] DSH 的 `removeOwnedDirectory` 逐层 lstat，只解链不进入（apps/desktop/src/owned-directory.ts:11-26），注释写的是「Electron's recursive rm follows nested Windows junctions into installed resources」。
- docs/defensive-patterns.md:31-33 写了通用规则。
- 另外两份归档笔记（.agents/notes/archived/bug-fix/2026-08-12-unlink-fixture-junctions-before-delete.zh.md、2026-08-12-unlink-stale-profile-fallback-links.zh.md）说明：`git worktree remove` 曾经穿过 junction 删掉了仓库自己的源码；Node 24 的 rmSync 递归本身只删 junction，但存在检查与删除之间的竞态。
- DSH 卸载删数据时同样不进入重解析点（installer/uninstall-data.h:63-94）。

---

## 23. DeskMinis 已经同样好或更好

1. **托盘常驻加单实例唤出**（dm:src/main/index.ts:60-77、264、448-452）。DSH 没有托盘，关窗就退出（main.ts:1035-1037）。
2. **更新前先优雅停引擎，再兜底退出**（index.ts:315；relaunch.ts:18-21；minisd-stop.ts:5-7）。DSH 的 inspect/lock 更强 [dsh.md 已写]，但「停了再装」这条纪律两边一致。
3. **日志放在 %LOCALAPPDATA%**，不随漫游配置或 OneDrive 同步（app-dirs.ts:35-37）。DSH 的 `app.setAppLogsPath()` 在 Windows 上落在 userData，也就是 Roaming（main.ts:67）。
4. **打包版菜单去掉了重载和 DevTools**，保留缩放与全屏（dm:src/main/app-menu.ts:13-29）。DSH 打包版仍然可以 F12 或 Ctrl+Shift+I 打开 DevTools（README.zh.md:19；main.ts:844-847（devToolsItems））。对办公用户，DM 的取舍更稳。
5. **子进程统一隐藏控制台、用绝对路径调 taskkill**（§20），与 DSH 等价。
6. **asar 解包**：smartUnpack 加显式列表加 e2e 检查（§21），够用。
7. **有便携版，并且它不自动更新**（dm:src/main/index.ts:337-340）。DSH 没有便携版。
8. **卸载的「保留什么、怎么彻底清」写进了用户文档**（README:127-136），透明度与 DSH README 相当。
9. **默认的解压加复制对 DM 约百个文件的载荷不慢**（推断），不需要 DSH 的目录事务（§7）。

---

## 24. 与 9/24 dsh.md、兄弟笔记的关系（避免重复）

- dsh.md 已写，本文不再展开：单实例；窗口守卫与中文右键菜单；更新的 inspect、lock 与关停梯；flashFrame 加静默通知；拖入非图片转 @path；Job 对象与隐藏控制台；LibreOffice kit 不引入；标题栏颜色随主题；更新日志与 nightly 通道；本地 updater 资格测试。
- 兄弟笔记已写：
  - 周期检查更新、网络空闲超时、quitAndInstall 静默与否的取舍（notes-lifecycle §12）；
  - 递归删除不跟随 junction（notes-lifecycle §15）；
  - 自有特权协议与熔丝、深链无差距（notes-security §3、§5）；
  - 安装器隔离身份冒烟与 qualify-updater（notes-testing）；
  - 关窗藏到托盘的首次告知（notes-ui §10.2）。
- 对 notes-lifecycle §12.3 的补充：「DM 用默认参数，显示 NSIS 界面」的实际含义，是每次更新都会出现「安装选项」页（带「所有用户」和 UAC 选项）和完成页，与对话框「重启即可」的说法不一致；这段代码随 0.3.0 装机，决定第一次自动更新的体验。所以不是单纯的「不借」，建议 0.3.0 前演练后改文案（§11、§12）。

---

## 25. 建议汇总（按波次）

| # | 建议 | 波次 | 借法 | 依据 |
|---|---|---|---|---|
| 1 | RELEASE §3 加一条「覆盖运行中的 0.1.1」手测 | 0.3.0 / W3 | 零代码 | §6、§7、§12 |
| 2 | 改装好的 app-update.yml 指向本地 generic 源，演练一次自动更新，据此定更新交接方式（倾向先改对话框文案） | 0.3.0 / W3 | 零代码或一行 | §11、§12；DSH update-coordinator.ts:133 |
| 3 | 真机核对固定到任务栏后是否分成两个按钮；复现就补 setAppUserModelId | 0.3.0 / W3（W7b 提前） | 一行（推断） | §8 |
| 4 | README 安装一节补「提示『无法关闭』多半是安全软件拦截」 | 0.3.0 | 文档 | §9；DSH strings.nsh:44-45 |
| 5 | customUnInstall 删 deskminis-updater，照抄 isUpdated 与 /KEEP_APP_DATA 两道闸 | 0.3.x | 照抄改写 | §10；DSH uninstall.nsh:12-36 |
| 6 | allowElevation:false，或 customInstallMode 只装当前用户 | 0.3.x | 照抄一行或三行 | §4；DSH installer.nsh:29-44、75-80 |
| 7 | customCheckAppRunning：先请用户从托盘退出、再重试，强杀只做兜底；按完整路径识别 | W6a | 只借思路 | §6；DSH installer.nsh:163-192、window-frame.cpp:54-84 |
| 8 | 打开本地文件走 explorer.exe 加 file URI（先核对 shell.openPath 在 UserChoiceLatest 下的表现） | W8a | 只借思路 | §19；DSH 笔记 2026-09-22 |
| 9 | ManifestDPIAware、中文雅黑、品牌侧栏 BMP、多尺寸图标 | W9 | 照抄改写 | §2、§3 |
| 10 | 去掉 RIPGREP_CONFIG_PATH 或据此收紧 rg 免审；显式写 runAsNode 熔丝 | W6d / W9 | 只借思路或照抄一行 | §21 |
| 11 | 将来要做深链时：白名单解析 argv，卸载时删协议键 | 视需求 | 只借思路 | §15 |
| 12 | 开机自启（默认关）和卸载时清 Run 值 | W7b 或以后 | 只借思路（DSH 也没有） | §17 |

- 不借：自绘安装页与 window-frame.dll（§0、§2）；目录事务与 7-Zip 进度（§7、§9）；安装路径校验（DM 不开放选择安装目录，§5）；asar 逐字节校验（§21）。
- 许可：DSH 是 MIT。上表里「照抄改写」的几项（5、6、9）都是把几行配置或 NSIS 宏改写后自己写一遍，文本很短，按 DM 惯例在 THIRD-PARTY-NOTICES §5「仅借思路」下追加一行即可；如果直接复制 DSH 的 NSIS 或 C++ 源文件，就另开新节（notes-lifecycle 开头已说明）。

---

## 26. 未覆盖或未验证

- 全部结论都来自静态读码。以下几点需要真机确认：
  - 安装选项页在非静默更新时是否确实出现（§11）；
  - Electron 38 缺省的 AUMID 行为（§8）；
  - 隐藏父窗口下的模态框能否被看到（§11）；
  - shell.openPath 在 UserChoiceLatest 下的表现（§19）；
  - NSIS 简体中文的默认字体（§3）。
- 没有细读的 DSH 部分：
  - installer/drawing.nsh 的绘制细节；
  - extract-report.h 的报告格式全文；
  - tests/windows-installer-ui.ps1 与 windows-uninstall-smoke.ps1 的逐个用例；
  - installed-update-* 系列：安装版更新物料隔离、COS 发布；
  - EV 签名链：windows-sign.mjs、签名缓存。
- DSH 的 macOS 部分（dmg、公证、Launch Services 注册 dsh://）不在本方向内。
