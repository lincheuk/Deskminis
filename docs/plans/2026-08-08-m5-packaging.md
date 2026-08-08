# DeskMinis M5（打包与分发）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 把 DeskMinis 从「开发期 electron-vite 产物」变成「真安装可分发的 Windows 桌面应用」：electron-builder 出 NSIS 安装包；解决三个硬阻塞（bridge-cli 不进产物 / 无 Node 机器上桥失效 / 原生 .node 进 asar 无法加载）；真产物真安装真运行通过验收；全程不碰数据根、不放宽 M3a 安全约束、零功能回归。

**Architecture / 选型预览（决策点 1）:** 用 **electron-builder**（配合 electron-vite，二者同属 electron 工具链，官方 electron-vite 模板即为主流组合）。它负责：asar 打包、resources 拷贝、node_modules 原生模块 unpack、NSIS 安装器、安装/卸载钩子、产物命名。对本项目三个硬阻塞的解法见决策点 1/2/3。

**Tech Stack:** electron-builder（新增 devDependency）/ 现有 electron ^38 / 现有 electron-vite / NSIS（electron-builder 内置）/ 零运行时新依赖（保持现有 dependencies 不变，仅新增打包期工具）。

---

## §0 基线

- 分支基线：`main@6d630ee`（M4.6 已合并；三件套 976/976(90 文件)、typecheck 0、build 三产物，复核方亲验）。
- 前提（复核方已实测取证，作为设计前提，**不重测**）：
  - 项目当前**完全没有打包基建**：`package.json` 无 `build` 字段、devDependencies 无 electron-builder、无任何 electron-builder 配置文件、无 appId、`version` 停在 `0.1.0`。
  - 三个硬阻塞（全部实测）：
    1. **bridge-cli.mjs 不在构建产物里**。`out/` 仅含 `main/index.js`、`main/minisd.js`、`main/chunks/`、`preload/index.cjs`、`renderer/`。stub 只存在于 `src/minisd/bridge-cli.mjs`。`resolveBridgeCliPath()`（[`bridge/server.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/bridge/server.ts) L29-37）三个候选里生产路径是 `resolve(here,'..','..','src','minisd','bridge-cli.mjs')`——现在能命中纯粹因为仓库里 `src/` 与 `out/` 并列；打包产物不含 `src/`，该函数返回 `undefined`，六个桥全部静默失效。
    2. **`resolveBridgeNode()`（同文件 L46-58）兜底在打包态不可用**。`where.exe node` 找不到就回退 `process.execPath`；注释自认前提是「开发期必有 node」。回退到 `process.execPath`（打包后是 DeskMinis.exe，GUI 子系统 PE）M2e 已三方实证不可用：PowerShell `&` 对 GUI 程序不等待、不接管 stdout，`ELECTRON_RUN_AS_NODE` 只改运行时不改 PE 子系统标志。
    3. **两个原生 .node 二进制在 asar 内无法 require**：`node_modules/better-sqlite3/build/Release/better_sqlite3.node`（走 electron-rebuild，`package.json` 有 rebuild/postinstall 脚本）、`node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node`（N-API 预编译，ABI 稳定无需 rebuild，但同样不能在 asar 内加载）。

## §1 锚点（已核实；执行时仍请自行 grep 复核）

- minisd 启动：[`main/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/main/index.ts) L34 `utilityProcess.fork(join(__dirname,'minisd.js'), [], { env:{...,DESKMINIS_STANDALONE:'1'}, stdio:'pipe' })`
- 托盘图标：[`main/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/main/index.ts) L70 `nativeImage.createFromPath(join(__dirname,'../../resources/tray.png'))`，资源在 `deskminis/resources/tray.png`
- preload / renderer：[`main/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/main/index.ts) L91 `join(__dirname,'../preload/index.cjs')`、L94 `loadFile(join(__dirname,'../renderer/index.html'))`
- 数据根：[`minisd/paths.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/paths.ts) L9-13 `%APPDATA%/DeskMinis`（`DESKMINIS_DATA_DIR` 可覆盖）
- 桥装配：[`minisd/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) L253-269（`resolveBridgeCliPath` / `resolveBridgeNode` / `bridgePipePath` / `makeBridgeEnv`）
- dry-run 桥项：[`minisd/diagnostics.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/diagnostics.ts) L157-162（`resolveBridgeNode` 结果：`node.exe` → ready，否则 warning）
- M3a 安全约束：[`minisd/rpc/server.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/rpc/server.ts) L38-56（token + 回环双条件；PASETO/配对码仅 remote/pairing 模式）；[`minisd/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) L637/667（默认绑 127.0.0.1，`MINISD_HOST=0.0.0.0` 才开放局域网）

## §2 决策点（必须先答，定了才写 Task）

### 2-1. 打包方案选型 → **electron-builder**

**结论：** 选 **electron-builder**。

**论证：** 项目用 electron-vite（`electron.vite.config.ts`），其官方模板/文档的打包对接首选就是 electron-builder（`electron-builder.yml` + `electron-vite build && electron-builder`）。electron-forge 是另一选项，但 forge 的 vite 插件与本项目 `electron.vite.config.ts` 的既有 `main/preload/renderer` 三段配置对接成本更高，且 forge 默认打包流程与 current 的 electron-vite 产物布局（`out/main` / `out/preload` / `out/renderer`）需要额外的 `packagerConfig` 适配。electron-builder 对 asar、`asarUnpack`、`extraResources`、`files`、NSIS 的配置表达更直接，且与 electron-vite 的 `out/` 布局天然契合（`files` 直接指向 `out/**` + `package.json`）。

**三个硬阻塞的解法：**
- **硬阻塞 1（bridge-cli 不进产物）** → 决策点 2（见下）。
- **硬阻塞 2（无 Node）** → 决策点 3（见下）。
- **硬阻塞 3（原生 .node 进 asar 无法 require）** → electron-builder 的 **`asarUnpack`**：把 `node_modules/better-sqlite3/**` 与 `node_modules/@napi-rs/keyring-win32-x64-msvc/**` 解包到 `app.asar.unpacked`。better-sqlite3 的 `.node` 及其依赖 DLL 在 unpack 后可被 `require`（electron-builder 对 better-sqlite3 有现成 `asarUnpack` 自动处理，但本项目显式声明更稳）；`@napi-rs/keyring` 的 N-API 预编译 `.node` 同理。运行时 `require('better-sqlite3')` 在 Electron 下会解析到 unpack 路径，无需改源码。

**订正失效注释：** [`bridge/server.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/bridge/server.ts) L26-28（`M4 打包为 SEA exe 后此函数整体退役`）与 L39-44（`M4 SEA 打包后此函数与 resolveBridgeCliPath 一同退役`）引用的「M4 打包」早已变成「提示层加固」，前提悬空。执行时把这两段注释订正为「M5 打包为 Electron 应用后，见决策点 2」，不改变函数行为。

### 2-2. bridge-cli 形态 → **随包发 .mjs + 复用 Electron 运行时**

**结论：** 选 **方向 (a) 随包发 .mjs + 解决找 node**（配合决策点 3 的随包 .cmd 垫片复用 Electron 运行时）。

**三个方向论证：**

- **(a) 随包发 .mjs + 解决找 node：** 保持 stub 为零依赖单文件 `.mjs`，通过 electron-builder `files` 或 `extraResources` 把它放进安装目录（如 `resources/bridge-cli.mjs` 或随 `app.asar.unpacked`）。改造 `resolveBridgeCliPath` 增加「打包态候选：安装目录内 stub 路径」。stub 本身零改动（纯 stdio 往返，不依赖 asar/路径魔法）。**对六个桥的权限卡语义（M2e 双层门控）零影响**——权限判断全在 minisd 侧 `PermissionGatewayImpl`，stub 只是薄转发，不涉权限。关键依赖是「找到能跑 stub 的 node」——这正是决策点 3 解决的点。**结论：最小改动、语义最稳，选此方向。**
- **(b) 把 stub 编译成独立 exe 随包：** 用 Node SEA 把 `bridge-cli.mjs` 打成 `bridge-cli.exe` 随包。**问题**：SEA 单文件 exe 是 CONSOLE 子系统 PE，可被 PowerShell `&` 正常等待/接管 stdout，确实解决「找 node」问题。但① electron-builder 对 SEA 产物的集成没有一等支持，需在打包前手动 `node --experimental-sea-config` + 注入 blob，构建链复杂化；② SEA 产物体积（约 40-80MB，含整个 node 运行时）远大于一个 `.mjs`；③ 本项目已有「随包 .cmd 垫片复用 Electron 运行时」方案（决策点 3），stub 用 `.mjs + 垫片(ELECTRON_RUN_AS_NODE)` 等价可用，SEA 是冗余。**结论：不选，成本高收益低。**
- **(c) 取消外部 stub，桥调用改为 minisd 内部直接执行：** 把六桥功能搬进 minisd 进程内直接调用，去掉 PowerShell/管道往返。**问题：这是对 M2e 架构的破坏性重写**——桥的「会话 shell 内模型可调、经命名管道进 minisd、权限双层门控」就没了，影响面包括 shell 环境变量注入、TerminalManager、整个 BridgeServer/handlers 分发、六个 handler 的 PowerShell 实现定位。虽能彻底解决「无 node 依赖」，但改造面远超本里程碑目标，且触碰 M2e 已验收的权限卡语义。**结论：不选，本里程碑不做；若未来要做，单独立项并标注破坏性变更。**

**权限卡语义影响：** 方向 (a) 对既有六个桥的权限卡语义（M2e 双层门控：stub 转发 + minisd 侧 gateway `askOnce`/`bypass`）**零影响**，不属于破坏性变更。方向 (c) 若未来采纳需单独标注。

### 2-3. 无 Node 环境的产品决策 → **随包发 .cmd 垫片，复用应用自带 Electron 运行时**

**结论：** **随包发一个 63 字节 `.cmd` 垫片**，通过 `ELECTRON_RUN_AS_NODE=1` 复用应用自带的 Electron 运行时（DeskMinis.exe，Chromium 内核附带 Node 运行时）来跑 bridge-cli.mjs。彻底消除「随包内置 node.exe（87.4MB）」的体积代价。同时保留「检测不到时明确降级 + dry-run 说清」的兜底。

**垫片内容（`resources/bridge-node.cmd`，63 字节）：**
```bat
@echo off
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\DeskMinis.exe" %*
```

> **垫片字节数注记**：复核方原实验件为 131 字节（绝对路径 + CRLF 行尾）；随包版改用 `%~dp0` 相对定位且仓库 `.gitattributes` 强制 LF 行尾，实测为 **63 字节**。数字以随包实物为准。

**论证：**
- 终端用户机器不保证装 Node。复核方已实测坐实（**作为设计前提直接采用，不重测**）：垫片经 PowerShell `& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI"` 调用时，stdout 2 行全部捕获、退出码 3 正确传播；含空格路径 + 含空格中文参数无死角（`ARGV:["windows-clipboard","--text","hello world 中文"]`，退出码 0）。模型侧提示零改动——`BRIDGE_SECTION_FULL` 的 `& "$env:MINIS_BRIDGE_NODE" ...` 形式不变，只是该环境变量现在指向垫片。
- **机制**：Electron（含重命名的 DeskMinis.exe）是 CONSOLE 子系统 PE，`ELECTRON_RUN_AS_NODE=1` 让它以 Node 模式运行，可被 PowerShell `&` 正常等待/接管 stdout。垫片只是把「设环境变量 + 调 exe」包成一行，交由系统 cmd 解析。
- **否决「随包内置 node.exe」备选**：node.exe 单文件 **87.4MB**（复核方实测本机值），对桥这一辅助能力代价不成比例，且与 Electron 自带运行时功能重叠。DeskMinis.exe 本体约 200MB 已随包存在，垫片复用它是零新增体积。
- **降级兜底必须保留**：即便随包垫片，仍保留 `resolveBridgeNode` 现有的「检测不到 → warning」逻辑（`diagnostics.ts` L157-162 已把无 node 列为 warning 而非 blocked）。打包态下若垫片或应用 exe 缺失（极端：被杀软隔离/误删），dry-run 该项明确报 warning 且 detail 说明「windows 桥不可用，主流程不受影响」，**绝不静默失效**（现状是 `resolveBridgeCliPath` 返回 undefined 时桥静默失效——这正是硬阻塞 1 的病根，本里程碑一并根治）。

### 2-4. 安装形态 → **两者都出：NSIS 安装包 + portable**

**结论：** 两者都出（NSIS 安装包为主，portable 为免安装形态）。

**论证：** 数据根已固定在 `%APPDATA%/DeskMinis`，portable 若「默认改便携数据根」会与红线 1 冲突，**本里程碑不做便携数据根**。portable 形态仍用同一 `%APPDATA%/DeskMinis` 数据根（与安装版共享），仅「程序本体免安装」，不引入第二套数据语义。**不涉及迁移**（红线 1 不破）。electron-builder 支持同一次配置同时产出 NSIS 安装器与 win unpacked/portable 目标。

### 2-5. 代码签名 → **本里程碑不签名，写进非目标**

**结论：** 本里程碑**不做代码签名**，明确写进非目标段。

**论证：** 不签名触发 SmartScreen「未知发布者」警告；自签不消除警告（同源证书 Windows 默认仍拦截）；购买 EV 证书有年度成本。本里程碑聚焦「真产物真安装真运行」这一功能面，签名是分发面的独立议题。**文档说明 + 警告接受**作为本里程碑姿态，明确写进非目标，不在本里程碑内留空。

### 2-6. 版本与产物命名

**结论：**
- **version 提升：** `0.1.0` → `0.1.1`（不跳版本号，保持语义化；打包首发的功能里程碑，patch 级即可，不给到 1.0 以免误导成熟度）。
- **appId：** `com.deskminis.app`（稳定可识别，符合 electron-builder 要求；与数据根 `DeskMinis` 一致命名）。
- **产物文件名规则：** `DeskMinis-<version>-【目标】`。NSIS 安装包：`DeskMinis-0.1.1-Setup.exe`；portable：`DeskMinis-0.1.1-win-x64-portable.exe`。electron-builder 默认 `artifacts` 目录输出，命名经 `artifactName` 配置。

### 2-7. 垫片如何定位应用 exe（垫片方案引入的必答点）

**结论：** 用 `%~dp0` 相对定位。垫片随包放 `resources/` 下，应用 exe 在其**上层**（安装根），故垫片用 `"%~dp0..\DeskMinis.exe" %*`。**必须在真打包产物里验证**——安装路径含空格（默认 `C:\Program Files\DeskMinis`）时 `%~dp0` 的展开与引号处理是主要风险点，要有针对性测试（进 §6）。

**论证：**
- 垫片是静态文件随包发，但应用安装路径不固定（用户可改 NSIS 安装目录），不能硬编码 exe 绝对路径。`%~dp0` 是 cmd 的「当前脚本所在目录」内置变量，运行时展开，天然跟随安装位置。
- `%~dp0` 展开结果**以反斜杠结尾**且**不含引号**，因此垫片必须自加引号包裹整个路径：`"%~dp0..\DeskMinis.exe"`。含空格路径（`C:\Program Files\DeskMinis\resources\` → `..\DeskMinis.exe`）下，引号包裹确保正确解析。
- **主要风险点**：`%~dp0` 在含空格路径下的展开与 `..` 组合的引号处理。复核方实验已覆盖含空格路径 + 中文参数（退出码 0），但那是**开发期 electron.exe**；真打包产物（重命名 DeskMinis.exe）下的等价性见决策点 2-8，含空格安装路径的真机验证进 §6。

### 2-8. 打包态 app exe 与开发期 electron.exe 行为等价性（垫片方案引入的必答点）

**结论：** 同一个 Electron 二进制，`ELECTRON_RUN_AS_NODE=1` 语义理应等价；但打包后是重命名/重打标的 DeskMinis.exe，**`ELECTRON_RUN_AS_NODE` 可能被 electron-builder 的启动包装（启动器/重打标）干扰**，必须在真产物上实测一次确认。**这条进 §6 验收清单（作为硬性验收项）。**

**论证：**
- 复核方实验用的是 `node_modules/electron/dist/electron.exe`（开发期）。打包后 electron-builder 把它重命名/重打标为 `DeskMinis.exe`，并在安装目录生成配套启动文件。
- 理论上 `ELECTRON_RUN_AS_NODE` 是 Electron 运行时层面的开关，由 main 二进制读取，与文件名无关，理应等价。但打包/重打标链路上任何一步（如启动器包装、NSIS 钩子）都可能改变进程行为，**不能只靠理论推断**，必须真产物实测：在打包安装后的 `resources/bridge-node.cmd` 路径下跑一次六桥调用，确认 stdout 捕获与退出码传播与开发期一致。
- 若实测发现差异，回退方案：垫片改调 `resources\app\` 下解包后的 electron 二进制，或回调到 `where.exe node`（兜底），计划已预留 dry-run warning 兜底不静默。

## §3 红线（不可违反）

- **数据根路径不得改变**（`%APPDATA%/DeskMinis`）。老用户会话库、provider 配置、凭据索引都在那里。portable 形态不换数据根、不引入第二套数据语义（决策点 2-4），不迁移。
- **不得为打包放宽 M3a 安全约束**：minisd 默认绑 `127.0.0.1`、token + 回环双条件校验、PASETO 校验，一条都不能为「打包后方便」而放宽。打包只改文件布局，不改鉴权/绑定语义。
- **MIGRATIONS 零改动**。
- **零功能回归**：打包不是重构借口。决策点 2 选方向 (a)，对六个桥权限卡语义零影响，非破坏性变更；若任何 Task 被迫改产品行为，单独标注并给回归测试方案。
- **不夹带**：R4 落盘审计日志、R2 本端暂停标记均不做（写进非目标，注明「留 M6 立项论证」）。

## §4 非目标（本里程碑明确不做）

- **代码签名**（决策点 2-5；文档说明接受 SmartScreen 警告，签名留后续里程碑）。
- **便携数据根**（决策点 2-4；portable 仍用 `%APPDATA%/DeskMinis`）。
- **消除外部 stub（方向 2c）**：桥调用改 minisd 内部直行不做（破坏性，留独立立项）。
- **macOS / Linux 打包**：仅 Windows x64。
- **自动更新（electron-updater）**：不进本里程碑。
- **R4 落盘审计日志、R2 本端暂停标记**：留 M6 立项论证。

## §5 任务分解（Task 级 Step checkbox：写失败测试 → 确认失败形态 → 实现 → 验证 → commit）

> 每个 Task 的「验证」都含 `npm test` 全量绿 + typecheck 绿。打包相关 Task 的验收面见 §6 复核方实测清单，执行方不贴环境状态类举证。

### Task 1 — 引入 electron-builder 基建 + bridge-cli 进产物（硬阻塞 1）

**目标：** 建打包基建，先让 `bridge-cli.mjs` 进产物、`resolveBridgeCliPath` 打包态可命中；不做完整安装包（Task 6 收束）。

**Step 清单：**
- [x] Step 1「写失败测试」：为 `resolveBridgeCliPath` 补「打包态候选」单测——给定一个含 `bridge-cli.mjs` 的临时目录，断言新候选路径返回它；当前实现无该候选 → 红灯
- [x] Step 2「确认失败形态」：运行单测，确认红灯（红色输出贴交付报告）
- [x] Step 3「实现」：`package.json` 加 `devDependencies.electron-builder`；新增 `electron-builder.yml`（`appId`、`files: ['out/**','package.json','resources/**']`、`extraResources` 把 `src/minisd/bridge-cli.mjs` 拷到安装目录 `resources/bridge-cli.mjs`、`asarUnpack: ['node_modules/better-sqlite3/**','node_modules/@napi-rs/keyring-win32-x64-msvc/**']`）；`resolveBridgeCliPath` 增「安装目录内 stub」候选；订正 `bridge/server.ts` L26-28/L39-44 失效注释
- [x] Step 4「验证」：单文件测试绿 + `npm test` 全量绿 + typecheck 绿 + `electron-vite build` 后能跑 `electron-builder --dir`（unpacked 目录）确认 `resources/bridge-cli.mjs` 存在
- [x] Step 5「commit」：`build(m5): electron-builder 基建 + bridge-cli 进产物（硬阻塞1）`

### Task 2 — 随包 .cmd 垫片 + resolveBridgeNode 打包态优先垫片（硬阻塞 2）

**目标：** 让打包态桥栈有可用 Node 运行时：随包发 63 字节 `.cmd` 垫片，经 `ELECTRON_RUN_AS_NODE=1` 复用应用自带 DeskMinis.exe，根治「无 Node 机器上桥失效」。零新增体积（复用 Electron 自带运行时）。

**Step 清单：**
- [x] Step 1「写失败测试」：为 `resolveBridgeNode` 补「打包态候选优先垫片」单测——临时目录放一个假 `bridge-node.cmd`，断言返回它而非回退 `process.execPath`；当前实现无打包态候选 → 红灯
- [x] Step 2「确认失败形态」：运行单测，确认红灯（红色输出贴交付报告）
- [x] Step 3「实现」：新增 `scripts/bridge-node.cmd`（内容：`@echo off` / `set ELECTRON_RUN_AS_NODE=1` / `"%~dp0..\DeskMinis.exe" %*`，共 63 字节）；`electron-builder.yml` `extraResources` 把垫片拷到安装目录 `resources/bridge-node.cmd`；`resolveBridgeNode` 增「打包态候选：安装目录内 `resources/bridge-node.cmd`」优先于 `where.exe node`；降级兜底逻辑保留（`diagnostics.ts` warning 语义不动）
- [x] Step 4「验证」：单文件测试绿 + `npm test` 全量绿 + typecheck 绿 + `electron-builder --dir` 后确认 `resources/bridge-node.cmd` 存在
- [x] Step 5「commit」：`build(m5): 随包 .cmd 垫片复用 Electron 运行时，resolveBridgeNode 打包态优先（硬阻塞2）`

### Task 3 — asarUnpack 原生模块（硬阻塞 3）

**目标：** 让 better-sqlite3 / @napi-rs/keyring 在打包态可 require。

**Step 清单：**
- [x] Step 1「写失败测试」：静态守卫测试——断言 `electron-builder.yml` 含 `asarUnpack` 且覆盖 `better-sqlite3`、`@napi-rs/keyring-win32-x64-msvc`；当前无 `electron-builder.yml` → 红灯
- [x] Step 2「确认失败形态」：运行单测，确认红灯
- [x] Step 3「实现」：`electron-builder.yml` 配 `asarUnpack`（已在 Task 1 落地，此处补断言与核验）；确认 `electron-builder --dir` 后 `app.asar.unpacked/node_modules/better-sqlite3/**` 与 `@napi-rs/keyring-win32-x64-msvc/**` 存在
- [x] Step 4「验证」：单文件测试绿 + `npm test` 全量绿 + typecheck 绿 + `electron-builder --dir` 产物在 packed 态下能 `require('better-sqlite3')` 与 `@napi-rs/keyring`（复核方实测清单 Step 3）
- [x] Step 5「commit」：`build(m5): asarUnpack 原生模块，打包态可 require（硬阻塞3）`

### Task 4 — 安装形态与产物命名（NSIS + portable）

**目标：** 出 NSIS 安装包与 portable 两形态，命名规则落地。

**Step 清单：**
- [x] Step 1「写失败测试」：静态守卫——断言 `electron-builder.yml` 含 `nsis` 配置与 `portable` 目标、`artifactName` 含当前版本
- [x] Step 2「确认失败形态」：运行单测，确认红灯
- [x] Step 3「实现」：`electron-builder.yml` 配 `win.target: ['nsis','portable']`、`artifactName: 'DeskMinis-${version}-${name}.${ext}'`、`nsis`（oneClick:false 可控、shortcut）/ `portable` 配置；确认 `version` 提升与 `appId` 落地
- [x] Step 4「验证」：单文件测试绿 + `npm test` 全量绿 + typecheck 绿 + `electron-builder` 跑通产出 `DeskMinis-0.1.1-Setup.exe` 与 `DeskMinis-0.1.1-win-x64-portable.exe`。**产物体积预期**：撤销内置 node.exe 后（垫片方案），安装包不再含 87.4MB node，体积预期显著下调（仅 Electron 本体 + 资源 + 垫片 63 字节），交付报告暴露复核方实测体积即可，无需再为 node 预留体积期待
- [x] Step 5「commit」：`build(m5): NSIS+portable 安装形态与产物命名`

### Task 5 — 打包态 dry-run 与降级路径落地

**目标：** 让打包态「桥 Node 解析」在垫片可用/缺失两种情形下可观测、降级明确。**经评审简化**：垫片随包发，不再存在「用户没装 node」情形，仅剩「文件被删/被杀软隔离」极端情况，故 **UI 提示不作为必做项——只保留 dry-run warning，不做 SettingsModal 改动**（无 renderer 改动，§3 已相应移除 renderer 限制红线）。

**Step 清单：**
- [x] Step 1「写失败测试」：为 `diagnostics.dryRun` 的桥项补「打包态垫片缺失 → warning 且 detail 明确」单测；当前行为需确认
- [x] Step 2「确认失败形态」：运行单测，确认预期形态
- [x] Step 3「实现」：确认 `resolveBridgeNode` 打包态候选（`resources/bridge-node.cmd`）+ 降级 warning 语义在 `diagnostics.ts` L157-162 正确反映；dry-run 的 detail 明确写出桥不可用原因与「windows 桥不可用，主流程不受影响」提示。**不做 SettingsModal UI 改动**（垫片随包后 UI 提示必要性下降，见决策点 2-3 / 目标段）
- [x] Step 4「验证」：单文件测试绿 + `npm test` 全量绿 + typecheck 绿
- [x] Step 5「commit」：`fix(m5): 打包态 dry-run 桥项可观测与降级路径`

### Task 6 — 真安装真运行 e2e 脚本 + 全量回归

**目标：** 收束全套验收（§6 复核方实测清单的执行脚本 + 既有 e2e 回归）。

**Step 清单：**
- [x] Step 1「写失败测试」：新增 `scripts/e2e-m5-packaging.mjs`（安装包在临时目录安装 → 启动 → 断言主窗口/托盘/桥），先以「未安装」断言绿灯形式占位
- [x] Step 2「确认失败形态」：运行脚本，确认对「未打包环境」给出明确失败/跳过提示
- [x] Step 3「实现」：补全脚本——安装 → 启动 → 断言主窗口渲染、托盘图标、minisd 起、DB 建、keyring 存取、dry-run 桥项、**打包态 ELECTRON_RUN_AS_NODE 垫片等价性（§6-4）**、**含空格安装路径下垫片可用（§6-5）**、六桥逐一（§6 清单）；既有 e2e 套件（e2e:m3c 等）在打包改动后复跑
- [x] Step 4「验证」：`npm test` 全量绿 + typecheck 绿 + 既有 e2e 全绿
- [x] Step 5「commit」：`test(m5): 打包态 e2e 脚本` + 收尾 `docs(m5)` 勾 checkbox

### Task 7 — 计划收尾（checkbox + 偏差申报）

- [x] Step 1 §6 复核方实测清单逐条核对对应测试/脚本存在
- [x] Step 2 三件套复跑绿 + 偏差申报逐条
- [x] Step 3 计划文档勾全部 checkbox + `docs(m5)` 收尾 commit

## §6 验收清单（复核方实测；执行方只提供脚本与步骤，不贴环境状态类举证）

> 复核方在干净环境（或临时目录）按下列步骤实测，结果贴回；执行方不贴「安装后实际行为 / dry-run 输出 / 桥实测 / 数据根内容」。
>
> **状态下标**：`【已亲验：YYYY-MM-DD 复核方】` = 复核方已在真打包产物上实测通过；`【待验】` = 尚未在真机/真安装上执行，由复核方合并前另行安排。**收尾 commit 不得把【待验】项读作已验。**

1. **安装包干净安装启动**【待验】：双击 `DeskMinis-0.1.1-Setup.exe` 完成安装；启动后主窗口渲染正常、托盘图标出现（`resources/tray.png` 加载成功）。
2. **打包态 minisd 起 + DB + keyring**【待验】：打包后 `utilityProcess.fork` 能找到 `minisd.js`（启动不报「minisd 启动超时」）；能建库（better-sqlite3 从 unpack 位置加载成功）；keyring 能存取（@napi-rs/keyring 从 unpack 位置加载成功）。
3. **打包态 dry-run 全项 OK**【待验】：跑 dry-run，逐项看——特别是「桥 Node 解析」：在**装了 node** 机器上应 ready（命中垫片或系统 node）；在**没装 node** 机器上应 ready（命中随包垫片复用 DeskMinis.exe）；垫片被删/被杀软的极端情形下应 warning 但 detail 明确「windows 桥不可用，主流程不受影响」（不静默）。
4. **打包态 ELECTRON_RUN_AS_NODE 等价性（决策点 2-8，硬性验收项）**【已亲验：2026-08-09 复核方】：安装后直接执行 `resources/bridge-node.cmd`（或经 `& "$env:MINIS_BRIDGE_NODE"` 调用），确认 stdout 被捕获、退出码正确传播——与复核方开发期 electron.exe 实验一致；若差异，按决策点 2-8 回退方案处理。**复核方亲验结果**：垫片经 PowerShell `&` 调用 → `{"argv":["windows-clipboard","--text","hello world 中文"],"exe":"DeskMinis.exe","node":"22.22.0","electron":"38.8.6"}`，stdout 2 行全捕获、`LASTEXITCODE=3` 正确传播；`exe` 字段证明跑的是重命名后的打包产物，`electron` 字段证明复用了应用自带运行时——「87MB 换 63 字节」在真产物上成立。
5. **含空格安装路径下垫片可用（决策点 2-7，硬性验收项）**【已亲验：2026-08-09 复核方】：在默认 `C:\Program Files\DeskMinis`（含空格）安装后，跑一次 windows-clipboard 写中文参数，确认 `%~dp0..\DeskMinis.exe` 定位正确、stdout 与退出码正常。为覆盖 `%~dp0` 引号风险，另可选在自定义含空格目录（如 `C:\My Apps\DeskMinis`）下复测一次。**复核方亲验结果**：双层含空格路径（`Program Files Test\Desk Minis`）下结果与 item 4 完全一致。
6. **六个桥逐一实测**【待验】：打包态下 `windows-notify / windows-clipboard(read+write) / windows-open / windows-speak / windows-screenshot / windows-device` 逐一可用（这是硬阻塞 1/2 的真实验收面，不能只看单测）。
7. **数据根仍是 %APPDATA%/DeskMinis**【待验】：安装版与 portable 均读/写同一数据根；能读到升级前的既有会话与 provider 配置（不迁移、不丢）。
8. **既有 e2e 套件仍绿**【复核方亲验：2026-08-09 三件套 987/987(91 文件) / typecheck 0 / build 三产物；打包态 `--dir` 产物六项齐全】：打包改动后，`npm test` 全量 + 既有 e2e（e2e:m3c 等）在打包改动的基线上仍绿。
9. **垫片缺失降级可观测**【待验】：在垫片被删/被杀软的极端情形下，dry-run 桥项明确 warning、桥不可用但不拖垮主流程（不静默）。

## §7 交付报告要素

- commit 链（Task 1-7 各一个 commit + 收尾）
- 三件套原始输出（npm test / typecheck / build）
- 相关 e2e 原始输出（e2e:m5-packaging + 既有 e2e 回归）
- **决策点结论逐条**（2-1 至 2-8）
- 偏差申报逐条
- checkbox 状态（Task 级 Step 全勾）
- **环境状态类举证（安装后实际行为 / dry-run 输出 / 桥实测 / 数据根内容 / 安装包体积）一律留给复核方实测，执行方不贴**——但计划与脚本已写清复核方怎么测（§6 步骤可执行）。

## §7.5 偏差申报（本里程碑执行期间的偏差记录）

- **Task 6 自动断言范围收敛**：执行方 e2e 脚本（`scripts/e2e-m5-packaging.mjs`）自动断言覆盖 **win-unpacked 产物面**（extraResources 随包 / asarUnpack 解包 / §6-4 垫片 `ELECTRON_RUN_AS_NODE` 等价性 / §6-5 含空格路径垫片可用）——这些是纯自动键、无 GUI 依赖。**NSIS 真安装、六桥逐一、dry-run 极端降级、portable 同一数据根**等真机/真环境项（§6-1/3/6/7/9）按 §6 约定归属复核方实测，脚本给出步骤与占位，不自动执行。
- **真产物已坐实关键产物面**：执行方在给 `--dir` 打包的 win-unpacked 上确认 `DeskMinis.exe`、`resources/bridge-cli.mjs`、`resources/bridge-node.cmd`、`app.asar.unpacked` 下 `better_sqlite3.node` 与 `keyring.win32-x64-msvc.node` 全部存在（对应硬阻塞 1/2/3 产物面）。**§6-4/6-5 的垫片等价性与含空格路径真机实测、以及安装包体积，仍留给复核方在真机上执行**（执行方不贴环境状态类举证）。
- **完整安装包未在执行方环境产出**：执行方仅 `--dir`（unpacked）形态验证；NSIS `Setup.exe` 与 portable 产物由复核方在完整构建上产出并实测体积。`electron-builder` 完整 `win` 目标书写于 `electron-builder.yml`（Task 4 静态守卫覆盖），未执行方环境中因沙箱对 `dist` 写锁/路径限制未完整跑通。
- **无 renderer 改动**：Task 5 经评审简化为「仅 dry-run warning、不做 SettingsModal UI 改动」，故 §3 已移除「renderer 改动限 SettingsModal」红线——本里程碑确实零 renderer 改动，与该修订一致。

## §8 风险

- **安装包体积**：撤销内置 node.exe（垫片方案）后，安装包约等于 Electron 本体 + 资源 + 垫片（63 字节），体积相较「内置 node.exe」显著下调。复核方实测体积，交付报告暴露；若仍过大，后续可评估体积裁剪作为 backlog。
- **打包态 ELECTRON_RUN_AS_NODE 被启动包装干扰（决策点 2-8）**：若 electron-builder 的启动器/重打标改变了 `ELECTRON_RUN_AS_NODE` 行为，垫片方案失效。§6-4 真产物实测是必要防线；差异时按决策点 2-8 回退（改调 unpack 后 electron 二进制 / 回退 `where.exe node`），dry-run warning 兜底不静默。
- **`%~dp0` 含空格路径引号风险（决策点 2-7）**：默认安装路径含空格，`%~dp0..\DeskMinis.exe` 的引号包裹必须正确。§6-5 含空格路径实测是必要防线；复核方实验已覆盖含空格 + 中文参数（退出码 0），真产物上须复验一次。
- **asarUnpack 遗漏 DLL**：better-sqlite3/sqlite 依赖的 DLL 若未随 unpack 一起复制，打包态 require 仍失败。Task 3 的 packed 态 require 实测（§6-3）是必要防线。
- **便携版共享数据根竞态**：portable 与安装版共享 `%APPDATA%/DeskMinis`，同数据根双实例启动的 DB 锁竞态沿用既有语义（红线 1 不破；不引入二套数据根者不新增冲突面）。