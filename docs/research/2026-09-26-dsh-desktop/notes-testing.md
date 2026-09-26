# DSH 桌面端测试、性能门禁与工程纪律：细读笔记（2026-09-26）

- 参考：DeepSeek Harness（DSH，MIT），`/home/user/refs/deepseek-harness`，HEAD 46a7f68b0（0.1.7-rc.1）。以下「文件:行」均相对该仓库根，DeskMinis 侧相对 `/home/user/Deskminis/deskminis`（另注明 docs 分支路径）。
- 只读研究：没有运行任何被研究项目的代码，没有联网；行号来自 `cat -n` / `grep -n`。
- 标注：**推断** = 由代码或文档推出、未实测；**零依赖**判断以 DeskMinis「dependencies / devDependencies 一行不动」为准（`typescript`、`vue`、`vue/compiler-sfc`、`pinia`、`@vitejs/plugin-vue`、`electron`、`electron-builder`、`vitest`、`ws` 已在库）。
- 9/24 的 `dsh.md` 已写过、本文不重复展开的：benchmarks 预算 900/700/520 ms 与 ×1.25 余量；真实 Electron + 回环服务器的更新资格测试（及 `scripts/qualify-updater.mjs` 建议）；浏览器 e2e 用回放快照；`e2e:perf` 合成 200 回合会话的建议；10 万推理 chunk 压测 250 ms；UI/UX 评审判据；Model Experience 契约；更新日志 jsonl。本文只补这些条目里 dsh.md 没写到的**机制与纪律细节**。

---

## 0. 总览：DSH 的测试分层（按文件后缀分道）与 DeskMinis 对照

| 层 | DSH 文件后缀 / 位置 | 配置（文件:行） | 工具与依赖 | 执行位置 | DeskMinis 对应 |
|---|---|---|---|---|---|
| 单元 | `*.spec.ts(x)`；DOM 组件用文件头 `// @vitest-environment jsdom` 的 `*.client.spec.tsx` | `vitest.config.ts:123-128`（include）、`:161-203`（thread-safe / process-bound 两个 project，均 forks 池） | vitest、jsdom、@testing-library/react | 每个 PR | `tests/*.test.ts`，vitest 跑在 `ELECTRON_RUN_AS_NODE` 下（`package.json` test 脚本）；无 jsdom |
| 覆盖率门 | 同上 | `vitest.config.ts:358-369` 逐文件 100%；`:204-357` 豁免清单每条写原因或 TODO | @vitest/coverage-v8 | 每个 PR | 无（路线「不做什么」已拒零阈值覆盖率门） |
| 属主本地期望输出 | `tests/expected/*`（`toMatchFileSnapshot`）；CLI 用 `*.expected.e2e.ts` | `vitest.expected.config.ts:6-18` | vitest | 每个 PR | 请求体黄金快照用硬编码 sha256（`tests/provider-body-golden.test.ts:1-38`）；界面文案无期望文件 |
| 录制会话快照 | `snapshots/**/*.snapshot.ts` | `vitest.snapshot.config.ts:28-41`（replay 缺省、record 才读 key）、`:58-72` | vitest + 回放适配器 | 每个 PR（replay 只读） | 无 |
| 浏览器车道 | `apps/web/tests/*.e2e.ts`（179 个文件中约 143 个 e2e） | `vitest.web.config.ts:5-8,31-35`（串行） | **playwright**（Chromium，另有一个用例跑 WebKit） | Linux PR 必需 | docs 分支 `docs/handoff/driver/` 的 playwright-core + xvfb 剧本，不在主库 |
| 真 API e2e | `packages/*/tests/*.e2e.ts`、`apps/cli|desktop/tests/*.e2e.ts` | `vitest.e2e.config.ts:5-8`（缺 key 自跳过）、`:50-60`（retry 2、限并发） | vitest | 有 key 的工作流 | `npm run smoke:release`（Windows 真机、真 key，`--mock` 在 Linux 自测） |
| 必需性能基准 | `benchmarks/**/*.bench.ts`、`*.bench.client.ts` | `vitest.bench.config.ts:5-26`（逐文件串行、1 worker） | playwright（浏览器用例）、构建后的纯 Node worker | Linux PR 必需、单独 job（`.github/workflows/ci.yml:193-237`） | 无 |
| 选跑压测 | `apps/web/stress-tests/*.stress.ts` | `vitest.web-stress.config.ts:5-14`（任何缺省清单都不收） | playwright | 手动 | 无 |
| 手动性能诊断 | `*.perf.ts`、`*.perf.client.ts` | `vitest.web.perf.config.ts:5-19`（`--expose-gc`，无阈值） | playwright | 手动 | 无 |
| 桌面资格测试 | `apps/desktop/scripts/test-*.mjs|ts` + `tests/fixtures/*.mjs` | 不走 vitest，node 脚本 spawn 真 Electron | **只用 Electron 自带 API**，无 playwright | Windows 本机手动 | `scripts/e2e-*.mjs`（只驱动引擎 JSON-RPC，不驱动 GUI）、`verify-release.mjs`、`e2e-m5-packaging.mjs` |
| 安装器 UI | `apps/desktop/tests/windows-installer-smoke.ps1` 等 | `scripts/test-windows-installer.mjs` | PowerShell + `Add-Type` 内联 C# 调 user32（`tests/windows-installer-ui.ps1:1-40`） | Windows 交互桌面 | 只有 RELEASE.md §3 手工勾选 |

要点：
- DSH 桌面端**全仓没有用 Playwright 驱动 Electron**（`grep -rn "_electron\|electron.launch(" apps packages benchmarks scripts` 无结果；playwright 只出现在 `apps/web/package.json:55` 与 `benchmarks/package.json:8`）。桌面外壳的真机验证全部用 `webContents.executeJavaScript`、`sendInputEvent`、`webContents.debugger`、`capturePage`。这正是 DeskMinis 路线 W4b 的备案，已有一个同体量项目跑通。
- 层与层靠**文件后缀 + 独立 vitest config** 分道，缺省 `npm test` 不会误收昂贵或需 key 的用例（`vitest.web-stress.config.ts:5` 注释即「没有缺省配置收 *.stress.ts」）。

---

## 1. 主进程单测怎么桩 electron

### D1 真跑主入口的行为测试：桩要收下 IPC 处理器并伪造发送方
- **DSH 怎么做**：`apps/desktop/tests/main-startup.spec.ts`（1735 行）。
  - `:27-216` 用 `vi.hoisted` 建一个 harness：`FakeWindow`（继承 EventEmitter，`close()` 发 `close` 事件、没被 preventDefault 才 destroy）、`FakeHost`（每个阶段一个 deferred）、`app` 的 `quit()` 会同步发 `before-quit` 并尊重 preventDefault（`:149-160`）。
  - `:228-253` `vi.mock('electron')`：`ipcMain.handle` 把处理器收进 `harness.handlers`，**同一通道注册两次直接抛 `duplicate IPC handler`**（`:236-239`）。
  - `:300-310` `invoke(channel, origin)` 用伪造的 `{ sender, senderFrame: { url } }` 调处理器；`:595-609` 断言「只接受当前应用、主窗口、顶层帧」的调用，其它三种伪造（别的 sender、同 URL 但不是 mainFrame 对象、外站 URL）都抛 `unowned renderer`。
  - `:318-342` 每个用例 `vi.resetModules()` 后 `await import('../src/main.ts')`，假时钟、`vi.stubGlobal('process', {...process, platform:'win32'})` 切平台；`:344-354` afterEach 走完退出流程再还原。一个文件里能跑 60 多个启动场景。
  - `:905-921` 外链：取 `setWindowOpenHandler` 的回调直接调，断言 `deny` + `openExternal`；对 `webContents.emit('will-navigate', event, url)` 断言站外 preventDefault、本应用放行。`:1484-1492` `render-process-gone` 的 clean-exit 与已关窗口不弹框。
- **DeskMinis 现状**：`tests/main-window-guard-harness.ts:114-223` 同样真跑 `src/main/index.ts` 到建好托盘，对 Electron 38 的真实签名很讲究（`will-navigate` 六个位置参数、`loadFile` 的 URL 拼法），打包 / 未打包 / dev 三形态各一个测试文件（`:1-35` 注释）。但 **`ipcMain: { handle: () => {} }`（`:184`）把处理器丢掉了**，IPC 只能靠 `tests/ipc-contract.test.ts:58-59` 的源码正则比对通道名。源码里 `minisd:info` 直接回端口与 token、不看发送方（`src/main/index.ts:368`），`app:relaunch` 只比 `e.sender`（`:378-379`），没有按 `senderFrame` 判顶层帧。
- **建议**：W2b 补修或 W6a。桩的 `ipcMain.handle` 改成收进 Map、重复即抛；harness 导出 `invoke(channel, {sender, frameUrl, isMainFrame})`；为每个 handle 通道写「主窗口顶层帧放行 / 别的 webContents、子帧、外站 URL 拒绝」四例。`minisd:info` 先写红测再补发送方校验。**零依赖可行**（只改测试帮手与 main）。

### D2 生命周期片段抽成「吃结构化 app 子集」的小模块，源码守卫退役
- **DSH 怎么做**：`apps/desktop/src/` 把主进程拆成约 55 个小模块（`single-instance.ts`、`crash-report.ts`、`fatal-recovery.ts`、`host-process.ts`、`update-schedule.ts`、`update-attention.ts` 等），各配行为测试。例：`apps/desktop/tests/single-instance.spec.ts:1-32` 给 `claimDesktopSingleInstance(application, focus)` 传 `satisfies DesktopSingleInstanceApplication` 的三方法假对象，两例覆盖「拿不到锁就 quit 且不挂监听」「second-instance 调 focus」。`apps/desktop/tests/*.spec.ts` 几乎不读源码文本：唯一一处是 `installer-packaging.spec.ts:73-94` 扫 `src/` 里引用的 `preload-*.cjs` 文件名、核对它们都在打包清单里——与 DeskMinis `preload-wiring.test.ts` 同类的「隐式耦合」守卫；其余行为一律靠结构化假对象测。
- **DeskMinis 现状**：`src/main/` 已拆出 9 个小模块（`nav-guard.ts`、`minisd-stop.ts`、`relaunch.ts` 等，`index.ts` 495 行），但单实例仍是源码守卫（`tests/single-instance.test.ts:1-20` 用 `stripComments` + 正则钉调用形态与位置）；主进程相关的测试里有 15 个文件读 `src/main` 源码文本。
- **建议**：W6a（launcher 抽取本来就在范围里）。抽 `claimSingleInstance(app: Pick<App,'requestSingleInstanceLock'|'quit'|'on'>, reveal)`、崩溃预算、启动失败分类等为纯模块，用结构化假对象测行为；只保留少量「调用放在 whenReady 之前」这类顺序性守卫。**零依赖可行**。

### D3 生命周期协议用「内联假子进程」测，不起真引擎
- **DSH 怎么做**：`apps/desktop/tests/host-process.spec.ts:10-44` 把一个几十行的假 Host 写成字符串落到临时目录，它 `listen(0,'127.0.0.1')` 后 `process.send({type:'ready'})`，按请求路径模拟 fatal、崩溃退出码 7、按消息回 `shutdown-complete`，并把自己看到的 `NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`、`execArgv` 回显出来，用来断言启动器擦了环境。
- **DeskMinis 现状**：有真 fork minisd 的测试（`crash-log-fork.test.ts`）与注入件 `tests/minisd-crash-inject.cjs`，没有可按指令崩溃的轻量假引擎。
- **建议**：W6a 的崩溃预算（5 分钟内 1/2/4/8/16 秒退避）、握手超时、致命行分类，用内联假子进程按指令「握手后第 N 秒退出 / 写致命行 / 不握手」驱动，配注入时钟；真 fork 只留一两条集成用例。**零依赖可行**。

---

## 2. 窗口、IPC 与界面的真 Electron 驱动（不用 Playwright）

### Q1 进程内驱动：spawn 真 Electron 跑一个 fixture，fixture 在主进程里 import 构建产物再驱动窗口
- **DSH 怎么做**：
  - 启动器 `apps/desktop/scripts/test-local-updater.mjs:9-38`：只在 win32 上跑（`:9`）；环境擦掉名字匹配 `KEY|SECRET|TOKEN|PASSWORD` 的变量与 `NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`（`:13-14`）；`spawn(electron, [fixture])`（`:15-16`）；**120 秒总时限**（`:18`）；超时、信号、退出码**分开报**（`:24-26`）；证据复制进 `.desktop-build/qualification/local-updater-<随机>`（`:27-34`）；临时目录带重试删除（`:37`）。
  - 更完整的 `apps/desktop/scripts/test-workspace-updates.ts:59-67`：子进程环境**只留** `PATH/SYSTEMROOT/WINDIR/COMSPEC/PATHEXT`，`HOME/USERPROFILE/TEMP/TMP` 全部指进本次运行目录；`:66` 注释「隐藏 GUI 进程会压掉首个窗口并可能挂起渲染端帧回调」，所以 `windowsHide:false`。
  - fixture `apps/desktop/tests/fixtures/workspace-updates.mjs:16-29`：`app.setAppPath` / `app.setPath('userData')` 指向私有目录，用 `node:module` 的 `registerHooks` 把**编译后主入口**里的 `./update-coordinator.js`、`./host-process.js` 换成适配器，然后跑真的 `lib/main.js`。
- **DeskMinis 现状**：GUI 剧本在 docs 分支，裸 import `playwright-core`，`S`/`APP` 常量写死会话草稿区路径，node_modules 不入库（`docs/handoff/driver/README.md`）；主库里的 `scripts/e2e-*.mjs` 只经 WebSocket 驱动引擎，而且 `e2e-acceptance.mjs:34` 缺省就用真实的 `%APPDATA%\DeskMinis`。剧本环境是 `{...process.env, DESKMINIS_DATA_DIR}` 全量继承（例 `docs/handoff/driver/hemostasis/W2b-3-disconnect.mjs` 的 `env()`）。
- **建议**：W4b，作为 SSR spike 之外的**并行**一层（不是失败备案）。主库加 `scripts/gui/run.mjs`（启动器）+ `tests/gui/*.gui.mjs`（场景）：启动器按上面四条（擦环境、只留白名单并把 HOME/APPDATA/LOCALAPPDATA/TEMP 指进运行目录、总时限、三类结局分开报）；场景在主进程里 `import('../../out/main/index.js')` 后用 Electron API 驱动。DeskMinis 的 `package.json` 是 `type: module`，`out/main/index.js` 是 ESM，可以直接 import（**推断**，需 spike 验证 whenReady 前后的挂载时机）。Electron 38.8.6 内置 Node v22.22.0（从二进制字符串推得），`module.registerHooks`（22.15 起）可用（**推断**）。**零依赖可行**，也兑现路线「不引 playwright-core」。

### Q2 渲染端操作的几件套（可以整段照抄思路）
- **DSH 怎么做**（`apps/desktop/tests/fixtures/workspace-updates.mjs`）：
  - `observed(window, subject, op)`（`:51-89`）：每个渲染端操作写一行 `operations.jsonl`（start/done/failed），20 秒超时；失败时再用 2 秒上限采集 `visibilityState`、`hasFocus()`、`document.getAnimations()` 的状态写进日志；操作期间 `setBackgroundThrottling(false)`，结束后还原并断言还原成功。
  - `documentReady(expr)`（`:91-97`）：在页面里用 `MutationObserver` 等表达式为真，带 20 秒 deadline；同样的写法见 `fixtures/local-updater.mjs:275-285`，超时时把 `location.href`、`innerText`、桥对象类型打印出来。
  - `press(expr)`（`:140-157`）：先等目标 enabled 且有布局，再等目标所在元素的有限动画结束，算中心点，**用 `document.elementFromPoint` 确认没被遮挡**（否则抛 `Click target is obscured`），最后 `sendInputEvent` 发 mouseMove/Down/Up（可信输入）。
  - `screenshot()`（`:124-132`）：等一帧 rAF 再等所有有限动画 `finished`，然后 `capturePage()`。
  - `windowAt(url)`（`:99-117`）：`browser-window-created` + `did-finish-load` 等出目标窗口。
  - 需要打到子帧时，`fixtures/mandatory-frame.mjs:14-28` 用 `webContents.debugger.attach('1.3')` + `Input.dispatchMouseEvent`（Electron 自带 CDP）。
  - 键盘：`fixtures/update-dialogs.mjs:80` 用 `sendInputEvent({type:'keyDown', keyCode:'Escape'})`；`:66-71` 派发 Tab / Shift+Tab 验焦点陷阱。
- **DeskMinis 现状**：playwright 的 `page.evaluate`、`locator.click` 在剧本里用得很熟；handoff 记着 xvfb 没有窗口管理器、焦点事件要手工派发、playwright 看不到原生框（`docs/handoff/2026-09-25-session-handoff.md` §3）。进程与 minisd 的 pid 靠扫 `/proc`（`W2b-3-disconnect.mjs` 的 `procTable()`）。
- **建议**：W4b。把这几件套写成主库 `tests/gui/helpers.mjs`：`until`、`press`（含遮挡检查）、`type`（`sendInputEvent` 逐字 char 事件）、`shot`、`observed`；子进程 pid 改用 `app.getAppMetrics()`（Electron 内置，返回全部子进程 pid 与 type，Windows 真机同样可用），替代 `/proc` 扫描（**推断**：utilityProcess 在 metrics 里的 type 名需实测）。原生框仍用 docs 分支的 X11 小工具，或在主进程里桩 `dialog.showMessageBox` 记录参数。**零依赖可行**。

### Q3 断言要落到「计算样式、几何、焦点、隔离」，截图失败单列
- **DSH 怎么做**：`apps/desktop/tests/fixtures/update-dialogs.mjs:53-64` 一次取回标题、正文、按钮文字、卡片宽度（380）、圆角（`24px`）、主按钮背景色、焦点元素、`typeof window.require === 'undefined'`（上下文隔离），与期望对象 `deepEqual`；`:64` 断言父窗口 `filter` 为 `blur(2px)`；`:101-106` 断言展开的技术细节区高度不超过 180 且主按钮仍在视口内。`fixtures/local-updater.mjs:317-322` 把可见按钮与文案组成快照，和 `tests/expected/mandatory-update-zh.json` 比。`:326-332` `capturePage` 失败只记 `{captured:false, reason}`，文档写明「截图失败单独记录；缺少截图不能证明视觉验收通过」（`.agents/notes/implemented/testing/2026-09-10-desktop-local-updater-qualification.zh.md` 后果节）。
- **DeskMinis 现状**：剧本里有 `geom()` 取几何（`W2b-3-disconnect.mjs`）、`drive-ui-audit.mjs` 批量取计算样式；结论靠人看截图；截图失败与目视结论没有分开记账。
- **建议**：W4b。每个 GUI 场景输出结构化的「视图摘要」（文字、按钮 disabled 态、关键尺寸、焦点），和主库 `tests/gui/expected/*.json` 逐项比；截图仍存证据目录供人看，但**截图是否拍到**与**断言是否通过**分两栏记。**零依赖可行**。

### Q4 用例账本：期望清单与实跑结果逐项比对
- **DSH 怎么做**：安装器冒烟 `apps/desktop/tests/windows-installer-smoke.ps1:15` 读 `tests/expected/windows-installer.json` 的 `cases` 数组，每过一段 `$results.Add('<case>')`，末尾 `:254` `Compare-Object @($expected.cases) @($results)`，多一个少一个都失败；本地更新 fixture 每个 `scenario(name, run)` 跑完才 `cases.push(name)`（`fixtures/local-updater.mjs:68`），最后打一行 `LOCAL_UPDATER_RESULT=` 并写 `result.json`（`:377-379`）。
- **DeskMinis 现状**：剧本逐行打印 PASS/FAIL（`results.push({name, ok})`），没有期望清单；一个分支提前 return 或场景被注释掉，不会有任何东西变红。
- **建议**：W4b。每个 `*.gui.mjs` 旁边放 `expected-cases.json`，启动器比对「期望集合 = 实跑且通过的集合」，并把 `result.json`（用例、截图是否拍到、Electron 版本、构建哈希）写进 `<运行目录>/evidence/`。**零依赖可行**。

### Q5 产物新鲜度闸：跑的必须是刚构建的 out/
- **DSH 怎么做**：`benchmarks/support/built-worker.ts:83-97` `assertBuiltBenchmarkRuntime` 拒绝不在 `.dsh-build/` 下、带 TS loader、或包入口没解析到 `lib/` 的 worker；`docs/testing.md:37-41`「真实入口指发布产物」。
- **DeskMinis 现状**：driver README 头一句就是「app 跑的是 out/ 产物，改了源不重建等于白测」，只靠人记得先 `npm run build`。
- **建议**：W4b。GUI 启动器与 `e2e:perf` 先比较 `src/**` 最新 mtime 与 `out/**` 最旧 mtime（或在构建时把源码树哈希写进 out 的一个文件），不新鲜就退出码 2 并提示。**零依赖可行**。

---

## 3. 安装器与更新实测

### I1 回环更新资格测试的机制细节（dsh.md 只写了「用回环服务器」）
- **DSH 怎么做**：
  - 假更新源 `apps/desktop/tests/fixtures/update-server.mjs:11-91`：`listen(0,'127.0.0.1')`（`:68-71`）；模式表 `healthy / feed-404 / feed-408 / invalid-yaml / feed-stall / hold-check / hold-download / download-404 / corrupt / disconnect / download-stall`（`:29-65`）；**请求屏障** `arrived()` / `release()`（`:19-20,44,58-63,75-83`）让并发条件确定地出现，不靠 sleep；关闭时 `closeAllConnections()` 再等 close（`:84-89`）。
  - fixture `fixtures/local-updater.mjs:40-67`：只在 fixture 里 `setFeedURL({provider:'generic', url: 回环})`，生产配置从不加载；`quit/relaunch/onQuit` 一律抛「不许退出或重启」；`quitAndInstall` 被替换成记录调用（`:61`）。场景含：同版本 / 更低版本不更新、404/408/坏 YAML「自动检查静默、手动检查可见、恢复后可用」（`:80-90`）、下载卡住按真实超时失败再恢复（`:91-98`）、两个并发检查只发一个请求（`:99-107`）、校验和错 / 断流 / 卡住后需要显式重试且自动检查不重试（`:152-172`）、**注入 ENOSPC：真写了一部分再失败，部分文件不许留成可安装状态**（`:173-216`）、dispose 之后迟到的结果不发布（`:217-225`）。
- **DeskMinis 现状**：`electron-updater` 的 github provider（`electron-builder.yml` publish 段），`src/main/update-status.ts` 译错误；更新链路只能在 W3 之后的真机手测里验（`docs/RELEASE.md` §3 末尾、§4 第 6 步）。
- **建议**：W3 之后、0.3.1 之前（或并入 W6a）。照上面的模式表写 `scripts/qualify-updater.mjs`（Windows 本机跑）；DeskMinis 要验的额外一条是「下载完成只提示、不自动装」（`autoInstallOnAppQuit=false`）。**零依赖可行**：node:http + 已有的 electron-updater；NsisUpdater 相关路径只在 Windows 跑（DSH 同样在 `test-local-updater.mjs:9` 拒绝非 win32）。

### I2 安装器冒烟：每次运行用独立产品身份
- **DSH 怎么做**：`apps/desktop/scripts/test-windows-installer.mjs:21-25` 每次随机 GUID、产品名 `Harness Installer Test <8位>`、包名带随机 scope，不会碰到机器上真装着的应用；`:56` 子进程环境擦掉签名凭据；`:92-110` 用**生产的** electron-builder 配置（`createElectronBuilderConfig()`）分中英文各打一个测试安装包，payload 是一个几行的 NSIS 小程序（`:74-89`）；`:112-116` 交给 PowerShell 冒烟。冒烟脚本 `tests/windows-installer-smoke.ps1:22-32` 轮询控件文字（30 秒上限，失败时把可见文字全部打印）、`:82` 断言进度条不回退、`:237-252` finally 里杀掉所有启动过的进程、静默卸载并等文件消失；`scripts/smoke-windows.ps1:50-56` 清理前确认目标在临时根目录下，否则拒删。
- **DeskMinis 现状**：`docs/RELEASE.md` §3 手工勾「干净目录安装」「卸载后数据目录保留」等；`electron-builder.yml` 用缺省 NSIS 页面（`oneClick:false`、`perMachine:false`、`deleteAppDataOnUninstall:false`）。
- **建议**：W3。写 `scripts/smoke-installer.ps1`（Windows 真机）：用 `-c.appId=com.deskminis.smoke.<随机> -c.productName="DeskMinis Smoke <随机>"` 覆盖出一个测试安装包，静默安装到临时目录（`/S /D=`），核对 exe、`resources\app.asar`、`app-update.yml`、`LICENSE.txt`、卸载注册表项；再装同版本验覆盖；静默卸载后核对程序删净、`%APPDATA%\<产品名>` 保留；清理前校验路径在临时根下。期望用例清单照 Q4。**零 npm 依赖**（PowerShell 与 electron-builder 已在），只能真机。

### I3 操作员清单改成「证据表」，缺省 pending
- **DSH 怎么做**：`apps/desktop/tests/installed-update/README.md:110-124` 的报告模板是「项目 | 证据位置 | 结果（缺省 pending）」（规则见 `:126`），规则：遇到第一个失败的前置条件就停；不删证据、不覆盖失败批次，重做就开新 run；「本地清单或完整日志序列不代表安装器合格」。`apps/desktop/tests/README.md:25-56` 分「Evidence」与 `:58-72`「Open verification」两节，把未验证的东西列明。
- **DeskMinis 现状**：`docs/RELEASE.md` §3 是勾选框清单，勾了什么、证据在哪没有记录位。
- **建议**：W3。§3 每一条改成表格行：证据位置（截图 / 日志 / 命令输出路径）+ 结果（pending / 通过 / 失败）；发版说明附这张表；未能验证的项写进「已知限制」。**零依赖**，纯文档。

---

## 4. 打包产物怎么校验

### P1 构建后的 preload 在沙箱式 require 下能跑、暴露的键对得上
- **DSH 怎么做**：`apps/desktop/tests/preload.e2e.ts:51-67`：读构建产物 `lib/preload-*.cjs`，用 `node:vm` 的 `runInNewContext` 执行，`require` 只允许 `'electron'`（其它一律抛 `sandbox cannot load`），收集 `contextBridge.exposeInMainWorld` 的键和值再断言；`describe.skipIf(!existsSync(产物))`（`:50`）。
- **DeskMinis 现状**：`src/main/index.ts:239` 的 `webPreferences` 只给了 preload，没显式写 `sandbox`（Electron 20 起缺省沙箱）；`tests/preload-wiring.test.ts:6-10` 只核对配置产出名与主进程引用名一致。打包器哪天把 `node:path` 之类打进 preload，沙箱下 preload 静默失败、`window.deskminis` 不存在，现有测试全绿（**推断**：失败形态与 `ipc-contract.test.ts` 注释描述的「空窗口」同类）。
- **建议**：W4b（或 W2b 补一刀）。`tests/preload-artifact.test.ts`：`out/preload/index.cjs` 在 vm 里只许 require electron，断言 `exposeInMainWorld('deskminis', …)` 的方法集合等于渲染端类型声明里的集合；另加一句 `webPreferences` 显式 `sandbox: true, contextIsolation: true` 的守卫。**零依赖可行**。

### P2 asar 内容与构建产物逐文件哈希相等
- **DSH 怎么做**：`apps/desktop/scripts/verify-runtime-archive.ts:14-53`：把准备阶段封存的清单（路径、字节数、sha256、可执行位）与 `app.asar` 内实际文件、`app.asar.unpacked` 里的物理文件逐项比；unpacked 里多出任何清单外的文件都失败；asar 里出现链接也失败。读 asar 用的是 `app-builder-lib/out/asar/asar.js`（electron-builder 的内部路径）。
- **DeskMinis 现状**：`scripts/e2e-m5-packaging.mjs:1-20` 查 extraResources 与两个原生模块在 unpacked 里存在；`verify-release.mjs:14-21` 查 latest.yml、blockmap、app-update.yml、随包许可。没有检查 asar 里装的是不是这次构建的 `out/`。
- **建议**：W3，作为 `verify:release` 第 ⑨ 项。构建后写 `out/` 的清单；打包后比对 `win-unpacked/resources/app.asar` 内 `out/**`、`package.json`、`resources/**` 与清单逐项相等，`app.asar.unpacked` 只含 `asarUnpack` 白名单。读 asar：测试本身跑在 Electron 下，Electron 的 fs 对 asar 路径透明（**推断**：`ELECTRON_RUN_AS_NODE` 模式下 asar 支持仍开启，需实测），不行就手写 asar 头解析（8 字节 pickle 长度 + JSON 目录，约 30 行，**推断**）。不要 import `app-builder-lib` 的内部路径（非公开 API）。**零依赖可行**。

### P3 用打包出来的可执行文件把 asar 里的引擎真起一次
- **DSH 怎么做**：`apps/desktop/scripts/smoke-packaged-runtime.ts:1-23` 用打包目录里的可执行文件、`resources/app.asar/dsh` 里的 Host 起一次冒烟；`scripts/smoke-runtime.ts` 在私有 home 里起 Host，挂一个外部插件验证它拿到的是同一个 Cordis 实例，并做一次真实 Office 转 PDF。
- **DeskMinis 现状**：`e2e-m5-packaging.mjs` 用随包垫片跑一个探针 .mjs；docs 分支 `drive-r3.mjs` 做过打包态冒烟，但不在主库。
- **建议**：W3。`verify:release` 或 `e2e:m5` 加一步：`ELECTRON_RUN_AS_NODE=1 win-unpacked\DeskMinis.exe resources\app.asar\out\main\minisd.js`（`DESKMINIS_STANDALONE=1`、临时数据根、`DESKMINIS_FAKE_PROVIDER=1`），等握手行，经 ws 跑一个假回合，确认 better-sqlite3 与 keyring 在打包形态下能加载。**零依赖可行**（ws 已在）；只能真机或 Windows 构建机。

---

## 5. 界面测试分层与假模型

### U1 按后缀分道
- **DSH 怎么做**：见 §0 表；每条道有自己的 config、并行度与超时（`vitest.bench.config.ts:21-22` 串行单 worker，`vitest.web-stress.config.ts:11-13` 600 秒）。
- **DeskMinis 现状**：唯一的 `vitest.config.ts` 只收 `tests/**/*.test.ts`（5 行）；handoff 约定了 `*.win.test.ts` 但主库还没有这类文件。
- **建议**：W4b 定约定：`*.test.ts`（缺省）、`*.ssr.test.ts`（SSR project）、`*.win.test.ts`（Windows 限定并申报）、`*.bench.ts`（`vitest.bench.config.ts`，串行，W9a 用）、`*.perf.ts`（手动、无阈值）、`tests/gui/*.gui.mjs`（Electron 驱动，不进 npm test）。**零依赖可行**。

### U2 SSR 层的两处小增强：子组件留记号、可见文字投影带状态
- **DSH 怎么做**：组件测试用 jsdom（依赖）。桌面欢迎页 `apps/desktop/tests/welcome-renderer.client.spec.tsx:33-42` 的 `copy()` 把标题、图片 alt、标题文字、可见按钮（带 `[disabled]`）、密码框（`[password]`）拼成一段文本，和 `tests/expected/welcome/<语言>.expected.txt` 比（`:52,56`）。
- **DeskMinis 现状**：`tests/sfc-setup.ts:111-113` `renderSfc` 已能零依赖 SSR，`:120-138` `visibleText` 去掉隐藏元素；但子组件被替换成渲染为空的壳（`:68`），「StageChat 里挂没挂 PermCard」这种 W4b 验收（`tests/ssr-permcard.ssr.test.ts`）无从断言；渲染端 68 个 `renderer-*.test.ts` 里 59 个用 `readFileSync` 读源码。
- **建议**：W4b。① 壳改成渲染一个记号元素 `<x-shell data-c="PermCard.vue">`（可带序列化 props），`visibleText` 忽略它、另给 `mountedShells(html)` 列出挂了哪些子组件，这样不用深渲染也能判「状态 X 下 PermCard 挂上了」（**推断**：改动约 10 行）；② 加 `projection(html)`：按行列出可见文字与交互元素状态（`button: 发送 [disabled]`），和 `tests/expected/*.txt` 用 `readFileSync` 直接比，不用 `-u` 自动改写（与黄金快照纪律一致，见 U6）。路线里的整树 SSR project 另做，两者并存。**零依赖可行**。

### U3 FakeProvider 脚本队列照 llm-mock-server 的行为表与四条规则
- **DSH 怎么做**：`packages/test-support/llm-mock-server/README.md:54-70` 行为表：`connection_reset`、`stream_disconnect`、`partial_disconnect`、`stall`、`empty`、`empty_body`/`stream_eof`/`partial_eof`、`malformed_json`/`malformed_event`、`rate_limit`/`server_error`/`service_unavailable`、`auth_error`/`invalid_request`/`context_overflow`/`quota_exceeded`、`success`/`slow_success`/`reasoning_success`、`tool_call_success`/`max_tokens`、`wrong_content_type`、`random`。规则：一个**合法**请求恰好消耗一条（`:111`）；**队列耗尽回结构化 500**，要复用最后一条必须显式 `--repeat-last`（`:54`）；方法、路径、key、JSON 不合法的请求回 4xx **不消耗**队列（`:97`）；`random` 用带种子的 PRNG，没给种子就生成一个并打印在 ready 记录里（`:87`、`:111`）；返回全部请求记录供断言。实现是纯 node:http（`src/index.ts` 749 行）。
- **DeskMinis 现状**：`src/minisd/index.ts:180-232` 的 FakeProvider 靠首条用户文本 `__tool__` / `__fail__` 触发，工具调用只发一次，回复文本经 `DESKMINIS_FAKE_REPLY`；handoff 写明「FakeProvider 同会话每回合重放首条，造不出不同的工具序列」。docs 分支 `driver/mock-openai.mjs` 是按路径 fail/ok 的迷你版。
- **建议**：W4b。① 进程内 FakeProvider 改成读 `DESKMINIS_FAKE_SCRIPT`（JSON 文件路径）按 `modelId` 分组 FIFO，行为名直接用上表（DeskMinis 需要的子集：`rate_limit`、`context_overflow`（"prompt is too long" 等）、`quota_exceeded`、`max_tokens` 带工具调用、`reasoning_success`（带 reasoning_content）、`empty`、`partial_disconnect`、`stall`、`tool_call_success`），耗尽即抛可辨认的错误；② 主库 `tests/support/mock-llm-server.mjs`（node:http）说 OpenAI 兼容与 Anthropic 两种线格式，给 W4c 的真 provider SSE 解析与错误分类用，把 `mock-openai.mjs` 收编；③ 加一个 `delta_storm` 行为（N 个 delta、每批 128 个、批间 16 ms、下一批要等测试放行），服务 W9a（见 B4）。**零依赖可行**。

### U4 计数型预算：启动与切会话的 RPC 次数
- **DSH 怎么做**：`apps/web/tests/startup-rpc-budget.e2e.ts:1-44` 冷启动期间 `settings/describe` 恰好 2 次（一次主动读 + 一次首连重置），与机器快慢无关。
- **DeskMinis 现状**：`messages.list` 一次拉全部历史（dsh.md R3 滚动条目已记）；store 测试已有 mock rpc 的写法（`renderer-send-session-switch.test.ts`）。
- **建议**：W6b 或 W9a。store 层测试数 RPC：切一次会话 `chat.messages.list` 恰好 1 次、启动时 `chat.sessions.list` 恰好 1 次、重连后只重拉只读方法且 `chat.prompt` 为 0 次（与 W6b 验收互补）。**零依赖可行**。

### U5 真模型流录下来做回放夹具（可选）
- **DSH 怎么做**：`snapshots/AGENTS.md`：record 模式调真 API 并更新夹具，replay 只读回放；易变身份换成保留关系的类型化记号，**不许**因为「长得像 id」就抹掉任意正文；`vitest.snapshot.config.ts:28-41` replay 与 refresh 从不读 `.env`。
- **DeskMinis 现状**：W3 真 key 冒烟在用户 Windows 机上跑，跑完即丢；provider 解析器只对手写 SSE 测。
- **建议**：W4b/W4c，可选。`smoke:release` 加 `--record <目录>`：经本地转发把原始 SSE 字节落盘（固定测试提示词，没有用户内容），id 换记号；W4c 的解析测试用这些真实线格式回放（Anthropic 思考块签名、DeepSeek V4 reasoning_content）。**零依赖可行**（node:http/https 转发，**推断**）；隐私上只录冒烟用的合成对话。

### U6 期望输出文件：可读、可审，但不许自动重生成
- **DSH 怎么做**：`apps/desktop/tests/fatal-recovery.spec.ts:43,71,161` 用 `toMatchFileSnapshot` 把原生致命框的完整文案落成 `tests/expected/fatal-dialog-*.txt`（例 `expected/fatal-dialog-with-report-zh-CN.txt`：标题、正文、报告路径、三个按钮）；菜单 `main-startup.spec.ts:817` 落 JSON。改文案时 diff 一眼可读。
- **DeskMinis 现状**：全仓零处 snapshot 匹配；黄金快照刻意用 sha256 手改（`provider-body-golden.test.ts:14-17` 的理由：`-u` 会静默整体改写）。原生框、托盘菜单、更新状态文案多为逐条 `toContain`。
- **建议**：W4b 起用于用户可见的整段文案（原生框、托盘菜单、SSR 投影）：期望文件 `readFileSync` 后 `toBe`，**不用** `toMatchFileSnapshot`；有意改文案时手改期望文件，按「有意翻红」申报。二者分工：请求体这类不可读字节继续 sha256，人要读的文案用可读文件。**零依赖可行**。

---

## 6. 性能预算怎么定、怎么在 CI 里执行

### B1 预算的换算：参考机预期 × 机器系数 × 余量，写成源码常量
- **DSH 怎么做**：`benchmarks/support/calibration.ts:3-15` `CI_TIME_SCALE = 2`（x64 CI 相对 arm64 参考机实测）、`PERFORMANCE_BUDGET_HEADROOM = 1.25`，`ciTimeBudget(ms) = ceil(ms × 2 × 1.25)`；标准托管 runner 上单独实测过的终点只乘 1.25（`long-session.bench.ts:15-22`）。`benchmarks/AGENTS.md:11-12`：机器系数**不用于内存与无量纲比值**；预算是评审过的源码常量，**环境变量不许覆盖**；报告要给出原始样本和判定用的聚合方式（中位数、最小值、绝对值还是比值）。
- **DeskMinis 现状**：没有 CI；W9a 验收「主线程最长任务 ≤250 ms，真机实测后只许收紧、注明测量机器」。
- **建议**：W9a。预算常量旁边写「测量机器、样本、聚合方式」注释；xvfb 容器与 Windows 真机各一套预期，不互相换算。**零依赖**。

### B2 与机器无关的判据优先：工作量计数与缩放比
- **DSH 怎么做**：
  - 工作量计数：`packages/client/ui-primitives/tests/markdown-incremental.client.spec.tsx:132-156` 给增量解析器传一个记录输入的语法函数，40 段落流下来，断言稳态每次喂给语法器的文本 < 200 字符、不含第 0 段，累计解析字节 < 5 × 文档长（全量重解析约 20 ×）。完全不计时。
  - 缩放比：`benchmarks/conversation-fold/conversation-fold.bench.client.ts:34-40` 两个窗口事件数相同、delta 数差 20 倍，正确实现耗时比约 2.5，按 delta 重放约 11，预算 `2.5 × 1.25`；`2026-09-04-session-open-performance-gate.zh.md` 校准表里「Client fold delta 缩放比 2.5× → 3.125×」不乘机器系数。
- **DeskMinis 现状**：`StageChat.vue:123` 每个 delta 对全文 `parseMarkdown`，`:143` `mdOf` 每次渲染重解析历史（路线 §子系统处置表已记）。
- **建议**：W9a 的**第一道门**用这两种：① `tests/markdown-incremental.test.ts` 里数「喂给 `parseMarkdown` 的累计字符数 ≤ k × 文档长」「稳态单次输入有上界」，进 `npm test`；② `*.bench.ts` 里测 N 与 10N 个 delta 的总耗时比 ≤ 期望 × 1.25。两者在云端容器与 Windows 上结论一致，正好补上 DeskMinis 没有固定 runner 的短板。ms 预算做第二道门。**零依赖可行**。

### B3 每道门都要有负对照与门自身的测试
- **DSH 怎么做**：`benchmarks/long-session-browser/long-session.bench.ts:85-113`：用历史实测样本断言「新预算接受它、旧预算拒绝它、预算 + 1 ms 被拒、预算常量恰好等于 1125/875/650」；`:115-129` 用注入 DOM 验证「隐藏文本不算看见标记」这个测量探针本身；校准笔记写「临时零额度覆盖每条拒绝路径；负向对照证明预算执行」（`.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.zh.md:39`）。`dsh-speed-up-perf/SKILL.md:74`：负对照要求收紧后的断言在原实现上失败；阈值宽到退化也能过就不算保护；低于噪声底的预算也不可靠。
- **DeskMinis 现状**：W9a 验收没有写负对照；DeskMinis 的变异自检纪律（handoff §2 C.3）天然适合做这件事。
- **建议**：W9a。① 负对照：在 scratch 副本把增量解析换回全量重解析，计数门与缩放比门必须红（存档）；② 门自测：把「预算推导」「中位数取法」写成纯函数并单测「预算 + 1 被拒」。**零依赖可行**。

### B4 渲染端响应性：心跳 + 定时交互 + 真实输入重叠，生产者要带背压
- **DSH 怎么做**：
  - 选跑压测 `apps/web/stress-tests/reasoning-chunks.stress.ts:18-21` 10 万 chunk、每批 128 个、批间 16 ms，`MAIN_THREAD_DELAY_BUDGET_MS = 250`；`:56-72` `emitNextBatch()` 要等这一批真送达才返回（背压，避免追赶式突发造出另一种负载）；`:153-176` 页内探针：50 ms `setInterval` 记最大迟到量，1 秒后派发一个自定义事件记处理延迟；`:224-225` 两者都 < 250 ms；`:226-227` pageErrors 与 warnings 为空。
  - 必需基准 `long-session.bench.ts:71-83` 在发送前装输入见证：Composer 的第一个 `input` 事件必须 `isTrusted`、且当时回复里有首段标记但还没有完成标记（真正在流式期间打字）；`:218-223` 测完后在完成之后再打一个字，同一断言必须失败（负对照）；主线程时间取 CDP `Performance.getMetrics` 的 `TaskDuration` 差值。
  - `dsh-speed-up-perf/SKILL.md:57`：只有 Node 折叠、假 DOM、自定义心跳，都不足以证明浏览器响应性，要用真实输入并观察 UI 更新。
- **DeskMinis 现状**：路线 W9a 写「主线程最长任务 ≤250 ms（参照 DSH）」。**口径更正**：DSH 的 250 ms 是**选跑压测**里的心跳最大迟到与定时交互延迟，不是必需门禁，也不是 longest task；必需门禁里流式阶段用的是累计 TaskDuration（参考 1800 ms）加输入与首段、完整回复三个终点。
- **建议**：W9a 的 `e2e:perf` 在 Q1 的进程内驱动里做：FakeProvider `delta_storm`（U3）带背压；页内心跳 + 定时交互 + `PerformanceObserver('longtask')`（Chromium 自带）三者都记；Composer 用 `sendInputEvent` 在流式期间真打字，装输入见证并做「完成后再打字必失败」的负对照；主线程时间用 `webContents.debugger.sendCommand('Performance.getMetrics')`。每个样本新起一次应用、新数据根，取 3 次中位数；报告原始值与测量机器。**零依赖可行**（全部 Electron / Chromium 内置）。

### B5 测量探针自身的开销要控制
- **DSH 怎么做**：`benchmarks/long-session-browser/README.md:13`：标记查找只读最新一个 Assistant 步骤，避免全历史文本扫描把观测器成本算进被测区间；首次观测的诊断在打字之后再取，不增加输入前的往返；「两次 rAF 表示有一次渲染机会，不等于硬件呈现」（`long-session.bench.ts:24-27`）。
- **建议**：W9a。`e2e:perf` 的 `until` 只查最后一条助手消息节点；`executeJavaScript` 往返不要插在「发送 → 打字」之间。**零依赖**。

### B6 进程级样本：新进程、私有临时根、GC 口径、受限堆完成性
- **DSH 怎么做**：`benchmarks/AGENTS.md:10`：墙钟与常驻内存样本在新子进程、私有 mkdtemp 根里跑，限时、等退出、失败也清理；`support/built-worker.ts:28-76` 删掉 `NODE_OPTIONS`、可选 `--expose-gc` 与 `--max-old-space-size`，超时 SIGKILL，结局分 `exitCode/signal/timedOut` 报，只取 stdout 最后一行 JSON；会话打开门禁（`2026-09-04-session-open-performance-gate.zh.md`「决定」节）每端点 5 个新进程样本取中位数，另起一个 128 MB 老生代上限的子进程只判「能否跑完」，GC 前后各两轮、GC 时间不计入；堆与 DOM 数只作诊断，不当泄漏预算（`long-session-browser/README.md:13`）。
- **DeskMinis 现状**：无。
- **建议**：W9a 的 Node 级基准（长会话 `toAgentMessages` / 历史折叠 / markdown）用 `spawn(process.execPath, [worker], {env:{ELECTRON_RUN_AS_NODE:'1'}})` 起新进程（DeskMinis 测试本来就跑在 Electron-as-Node 下，better-sqlite3 ABI 一致）；`--expose-gc` 在 RunAsNode 下可用（**推断**，需验）。**零依赖可行**。

### B7 道与道分开：必需门、选跑压测、手动诊断
- **DSH 怎么做**：`benchmarks/AGENTS.md:3` 包内诊断用 `.perf.ts` 不进 `test:bench`；`vitest.web.perf.config.ts:5-6`「高基数诊断不进任何缺省清单」；CI 的 bench job 单独跑在标准托管 runner 上、不与其它门并发（`.github/workflows/ci.yml:193-199`），开 `DSH_GATE_VERBOSE` 让成功用例也输出原始样本供校准（`:234-237`）。
- **建议**：W9a。`npm test` 只收计数门（B2①）；`npm run bench` 串行跑缩放比门；`npm run e2e:perf` 跑渲染端并输出原始样本 JSON；`*.perf.ts` 手动诊断不设阈值。**零依赖**。

### B8 放宽预算是一次显式决策
- **DSH 怎么做**：校准笔记记录过一次「Trajectory 上限 625 → 650 ms，明确的 4% 放宽，接受重试中位数、仍拒绝首次中位数；这是预算决策，不代表产品提速」，并用同一判定断言拒绝 651 ms（`2026-09-06-frontend-performance-budgets.zh.md:71`）；`dsh-speed-up-perf/SKILL.md:53`「不许放宽预算或挑幸运的一次来掩盖退化」。
- **DeskMinis 现状**：W9a「只许收紧、不许放宽」。
- **建议**：保留 DeskMinis 的更严写法；如果真机实测证明预算低于噪声底，放宽必须附：原始样本、新旧预算下的接受 / 拒绝对照、「预算 + 1 被拒」自测，并在提交正文申报。**零依赖**。

### B9 性能改动的「测量卡」
- **DSH 怎么做**：`.agents/skills/dsh-speed-up-perf/SKILL.md:37-52` 动手前填一张卡：用户操作与可观察的完成条件、负载（固定维度与为何代表常态与尾部）、入口（生产调用与构建产物、哪些外部边界被桩）、时钟（起止点、冷热、排除项）、内存（终点可达对象、GC 策略、常驻与瞬时）、判定（原始样本、聚合、绝对 / 比值 / 内存上限、负对照）、行为（归属的功能测试与允许的细微差异）。
- **建议**：W9a 设计稿模板直接加这七行。**零依赖**，纯文档。

---

## 7. 工程纪律（AGENTS.md / testing.md / defensive-patterns / skills）

### E1 空 catch 必须写明错误与原因，try 只包一句；用 AST 指纹做「只减不增」棘轮
- **DSH 怎么做**：`AGENTS.md:148`「An empty `catch` names the error and why; keep its `try` to one statement」；`AGENTS.md:145` 对 `as unknown` 的做法是「保持或减少精确的历史基线」，实现 `scripts/verify-no-unknown-casts.ts:1-60`：用 TypeScript 编译器 API 找出所有断言，按「文件 + 语法记号 sha256（不含注释与空白）」计数，和 `scripts/no-unknown-casts.baseline.json` 比，挪行不影响、新增一个就红。
- **DeskMinis 现状**：路线已记 `loop.ts:340` 的 `catch {}` 吞掉压缩失败，是实缺陷；目前没有针对空 catch 的守卫。
- **建议**：纪律条目 + 一个守卫 `tests/empty-catch-ratchet.test.ts`：TS 文件用 `typescript` 的 AST，`.vue` 走现成的 `tests/sfc-blocks.ts`；空 catch（或只有注释但没写明错误名与原因的 catch）按指纹计数，只许减少；基线 JSON 随修复递减。**零依赖可行**（typescript 已是 devDep）。

### E2 拒绝「掩盖型」修复；超时预算不得低于跑道预算
- **DSH 怎么做**：`.agents/skills/dsh-ci-test-reliability/SKILL.md:102-116` 列明不算根因修复的做法：加大超时却说不出在等什么、加重试、全部串行、吞错误或未处理拒绝、弱化断言、把不稳定行为规范化掉、在清理或断言前加 sleep；`:67-73` 单个用例的超时会**覆盖**跑道的 `--testTimeout`，写得比跑道小等于降低了预算；钩子预算要与用例预算一起提；`:97` 自带时限的子进程要先断言「不是信号或超时结束的」再断言退出码。`docs/testing.md:19-21`「只有单独跑才过的 spec 是 spec 的缺陷，不是 runner 不稳」。
- **DeskMinis 现状**：handoff §3「全量里偶发的超时先单独重跑那个文件再下结论（机器负载）」；`vitest.config.ts` 统一 `testTimeout: 30000`。
- **建议**：写进 AGENTS.md（路线 #16）：单独重跑只用于诊断，确认是负载型偶发后要记进偶发账本并按上面清单找根因；新测试不许把用例超时写得低于 30 秒而不注明原因。**零依赖**。

### E3 拆除要到静止；报告相互正交的结局
- **DSH 怎么做**：`docs/defensive-patterns.md:7-9` 超时与退出码 0 可能同时成立，`timedOut`、`signal`、`exitCode` 要各自上报；`:19-21` 发出 kill/abort 就返回会留孤儿，要等子进程退出，并且先关监听注册表再杀，迟到的完成才不会触发回调；`dsh-ci-test-reliability/SKILL.md:85-89` 清理要在获取资源后立刻登记。
- **DeskMinis 现状**：W1b-5 已做「abort 后等 run 收尾再关库」「等进程树回收」，与此一致；各 e2e 脚本的结局多合成一个 PASS/FAIL。
- **建议**：GUI 启动器与 `smoke:release` 的子进程结局按三栏报（Q1 已含）。其余已同样好。**零依赖**。

### E4 链接形路径先 unlink 再删目录（W6d 的 junction 测试直接相关）
- **DSH 怎么做**：`docs/defensive-patterns.md:31-33`：可能是符号链接或 Windows junction 的路径，先 `lstatSync().isSymbolicLink()` 再 `unlinkSync`；Windows 上对 junction 递归删可能穿进目标；递归 `rmSync` 只用于确知是真目录的路径。`apps/desktop/scripts/smoke-windows.ps1:50-56` 清理前确认目标在临时根下。
- **DeskMinis 现状**：W6d 验收 `tests/path-fence-realpath.test.ts` 要「用 junction 构造逃逸」；现有测试普遍 `rmSync(d, {recursive:true, force:true})` 收尾。
- **建议**：W6d。junction 用例在 afterEach 里先 `unlinkSync(junction)` 再删临时根；junction 的目标放一个哨兵目录，测完断言哨兵文件还在（**推断**：Node 的递归删除对 junction 的行为在不同版本有差异，按 DSH 的保守写法做即可）。**零依赖**。

### E5 测试进程的代理环境变量统一清掉
- **DSH 怎么做**：`scripts/test-proxy-environment.ts:1-63` 作为每个 vitest config 的 setupFile，删掉 8 个代理变量与 `NODE_USE_ENV_PROXY`；`:36-45` 用 glob 发现全部 `vitest*.ts`，配一条接线测试保证凡是声明了 setupFiles 的配置都带上它。理由（`:4-9`）：开发机的 Clash 与 CI 的代理都会导出 `HTTP_PROXY`，发往本地夹具的请求被送进代理，代理的错误页被当成期望输出。
- **DeskMinis 现状**：`src/minisd/providers/model-catalog.ts:98-117` 会读 `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY`；云端容器设着 `HTTPS_PROXY`；`tests/proxy-fetch.test.ts` 在自己的用例里删变量，但测试起的 minisd 子进程全量继承环境（**推断**：目前没发现因此失败的用例，属潜在风险）。
- **建议**：低优先，可随 W4b。加 `tests/setup/env.ts` 清代理变量并在 `vitest.config.ts` 挂上，另加接线守卫。**零依赖可行**。

### E6 AGENTS.md / CLAUDE.md 单一来源 + 行数棘轮 + 引用存在性
- **DSH 怎么做**：`AGENTS.md:178` 根目录与 `packages/` 下的 `CLAUDE.md` 是指向 `AGENTS.md` 的符号链接（`ls -la` 可见）；`scripts/verify-doc-budgets.ts:1-7` 按清单给常设文档设字数上限，「只往下调、至少留 5% 余量，上调要在 PR 里说明理由」；`scripts/verify-doc-refs.ts:1-40` 扫源码注释里的 `docs/*.md` 路径必须存在；`AGENTS.md:172` 可机检的不变量要接进一个执行中的门，并证明改动过的验收路径能拒绝非法输入。
- **DeskMinis 现状**：路线拍板项 #16 默认「main 放一份不超过 150 行的 AGENTS.md 与一行的 CLAUDE.md，配路径与命令存在性守卫」。
- **建议**：落 #16 时：Windows 检出符号链接要开发者模式或 `core.symlinks`，所以 CLAUDE.md 不用符号链接，写一行 `@AGENTS.md` 引用（**推断**：Claude Code 支持 CLAUDE.md 里的 @ 导入）；守卫三件：行数上限（中文不按词数，按行数；只许下调）、AGENTS.md 里每个 `npm run X` 在 `package.json` scripts 里存在、每个反引号路径在仓库里存在。**零依赖可行**。

### E7 「证据按表面匹配」与「验证世界、不信自报」
- **DSH 怎么做**：`AGENTS.md:116` 证据要与改动面匹配：行为测试、模型或用户可见输出的快照、文档门、发布路径的构建冒烟、provider 的真 API；`docs/testing.md:33-35` e2e 断言要从外部重读文件或重跑命令，未改动的文件要逐字节相等；`:37-41` 守卫只有在回退会让它失败时才算守卫，要亲手引入回退、看它变红、再撤回。
- **DeskMinis 现状**：已有同等纪律（UI 改动必 xvfb、先红存档、变异自检、`smoke:release` 从外部读工作区文件与记忆文件）。**已同样好**，只需把 AGENTS.md:116 那张「改动面 → 证据类型」对照表译成 DeskMinis 版写进 AGENTS.md。
- **零依赖**。

### E8 不借：「绝不默认跑全量」
- **DSH 怎么做**：`AGENTS.md:117` 提交或推送前不跑全量，CI 负责穷举与平台矩阵。
- **DeskMinis 现状**：每步全量 + 52 例基线 diff。
- **结论**：DeskMinis 没有 CI（路线拍板 #7 暂不上 Windows CI），本机全量就是它的 CI，**保持现状**。

---

## 8. DeskMinis 已经同样好或更好的

1. **零依赖 + `tests/deps-frozen.test.ts`**：DSH 反而「优先用维护中的依赖」（`AGENTS.md:139`），devDeps 里有 jsdom、@testing-library、playwright、fast-check、coverage-v8、jscpd、oxlint。
2. **请求体黄金快照**：sha256 硬编码、禁 `-u` 重生成、改哪一项一目了然（`tests/provider-body-golden.test.ts:1-38`）；DSH 靠 record/refresh 模式加人审 diff。
3. **先红存档 + 变异自检 + 有意翻红逐条申报 + 最多三轮对抗审查**（handoff §2）：比 DSH 的「when practical 观察回退失败」更系统。
4. **主进程接线测试**：`main-window-guard-harness.ts` 真跑主入口、三形态分文件、桩的签名贴合 Electron 38，细致度与 DSH `main-startup.spec.ts` 同级（只差 D1 的 IPC 处理器收集）。
5. **发布校验两段式**：`verify-release.mjs` 在上传前与「下载回来」各跑一次（RELEASE.md），等价于 DSH 发布工具的公开回读；YAML 零依赖解析；随包许可核对。
6. **冒烟的秘密卫生**：`smoke-release.mjs:25-31` 凭据库服务名先核对再动、key 只经 RPC、输出脱敏、结束时扫临时目录找明文 key、信号中断照样清理。DSH 的更新资格启动器只擦环境变量。
7. **Windows-only 失败显式记账**：52 例基线 diff 让「在 Linux 上本该失败的」保持可见；DSH 用平台排除清单（`vitest.config.ts:22-61`）配逐条注释，二者相当。
8. **零依赖 SFC 执行与 SSR**（`tests/sfc-setup.ts`）：DSH 同类需求靠 jsdom。
9. **剧本收集 pageerror / console.error**（hemostasis 剧本）：与 DSH `watchConsole` 同样做法。
10. **时区与 Windows 语义模拟**：handoff §3 的 `TZ=Asia/Shanghai` 先断言生效、`pathToFileURL(p,{windows:true})` 两套夹具，符合 DSH「时区、locale 是独占的可变全局资源」与「尊重平台语义」的要求。

---

## 9. 不借或需破例

| 项 | DSH 做法 | 结论 |
|---|---|---|
| jsdom + @testing-library 组件测试 | `*.client.spec.tsx` | **需破例**；替代：SSR（U2）+ 进程内 Electron 驱动（Q1–Q4） |
| Playwright 浏览器车道与基准 | `apps/web/tests`、`benchmarks` | **需破例**；替代：Electron 自带 `executeJavaScript` / `sendInputEvent` / `debugger` / `capturePage`，DSH 桌面端自己就是这么做的 |
| 逐文件 100% 覆盖率门 | `vitest.config.ts:358-369` | **需破例**（@vitest/coverage-v8）；路线已拒零阈值覆盖率门，近期不做 |
| fast-check 性质测试 | `packages/*/tests/properties.spec.ts` | 不需要：DSH 的增量 Markdown 等价测试本身就是「多种块长 + 种子 LCG」的确定性写法（`markdown-incremental.client.spec.tsx:59-72,468-486`），零依赖照抄即可 |
| 读 asar 用 `app-builder-lib/out/asar/asar.js` | `verify-runtime-archive.ts:5` | 不借内部路径；用 Electron 的 asar fs 或手写头解析（P2） |
| wine 下跑 Windows 门 | `scripts/wine-windows-gates.sh:1-17` | 不借：DeskMinis 测试要 Electron ABI 的 better-sqlite3 与 powershell.exe，wine 下成本高且保真度存疑（**推断**） |
| Windows 观察性车道（allowFailure） | `scripts/run-gates.ts:580-604` | 与路线「Windows job 失败只写 notice 不阻断」的反例冲突；若将来上 Windows CI，至少 build 与 `npm test` 要阻断 |
| 「不默认跑全量」 | `AGENTS.md:117` | 不借（E8） |

---

## 10. 落位汇总

| 子波 | 条目 | 零依赖 |
|---|---|---|
| W2b 补修 | D1（IPC 处理器收集与发送方伪造测试；`minisd:info` 发送方校验先红）、P1（preload 产物沙箱检查） | 可行 |
| W3 | I2（安装器冒烟独立身份）、I3（证据表）、P2（asar 清单比对）、P3（打包 exe 起引擎） | 可行（真机） |
| W4b | Q1–Q5（主库零 Playwright 的 Electron 驱动、几件套、结构化断言、用例账本、新鲜度闸）、U1（后缀分道）、U2（SSR 子组件记号与可见投影）、U3（脚本队列与 HTTP 假端点、delta_storm）、U6（可读期望文件）、E5（代理变量清理） | 可行 |
| W4b/W4c | U5（真流录制回放，可选） | 可行（推断） |
| W6a | D2（生命周期纯模块、源码守卫退役）、D3（内联假子进程测崩溃预算）、I1（更新资格测试，亦可排 0.3.1 前） | 可行 |
| W6b / W9a | U4（RPC 计数预算） | 可行 |
| W6d | E4（junction 先 unlink、哨兵目录） | 可行 |
| W9a | B1–B9（机器无关判据优先、负对照、背压生产者、真实输入重叠、探针开销、新进程样本、分道、放宽即决策、测量卡），口径更正「250 ms」 | 可行 |
| 纪律（#16 AGENTS.md） | E1（空 catch 棘轮）、E2（拒绝掩盖型修复、超时预算）、E6（单一来源、行数棘轮、引用存在性）、E7（改动面 → 证据对照表） | 可行 |
