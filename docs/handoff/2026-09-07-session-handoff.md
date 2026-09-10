# DeskMinis 会话交接文档（2026-09-07，V 波收官后）

> 用途：新对话开局投喂。本文件存于 docs 分支 `docs/handoff/2026-09-07-session-handoff.md`，
> 配套资产（52 例基线清单、26 个审核 driver + 索引）在 `docs/handoff/` 同目录。
>
> **取代 `2026-08-20-session-handoff.md`**——那一版的 §5「关键文件地图」逐条指向
> `components/ChatView.vue` 等，而这些文件在 T 波换壳后已无人引用。拿旧版开局会直奔死代码。

## 0. 三十秒版

- **代码**：main `b7450ca`，**version 0.3.0**。166 测试文件 / 1942 例（云端 1890 过 + 52 基线），typecheck 0。
- **界面重做过两次**：I 波（改造式，已废）→ S 波（质感返工）→ **T 波（推倒重建，当前形态）**。
  现在的 UI 全在 `src/renderer/src/ui/`，旧的 `components/` 只剩 3 个活文件。
- **最近一件大事**：一次可达性盘点发现换壳漏掉了**权限卡**——发布级阻断，
  1890 例全绿没拦住。V 波九步补齐，详见 §7 教训 1。
- **下一件**：三选一，见 §6 一档。
- **发布**：v0.2.0 **从未发布过**（GitHub Releases 只有 v0.1.1）。0.3.0 待 Windows 真机走 `docs/RELEASE.md`。

## 1. 项目与协作模式

- **项目**：DeskMinis——Windows 桌面通用 Agent 应用（Electron + TS + Vue3 + better-sqlite3）。
  仓库 `github.com/lincheuk/Deskminis`，应用代码在 `deskminis/` 子目录。只在 Windows 真机发布验证。
- **两条分支**：`main` = 功能落地线；`claude/deskminis-handoff-dd9wrk` = **权威记账线**
  （PROJECT_NOTES.md 波结 + docs/specs 设计稿 + handoff + driver + audit-shots；
  分支叉在 G 波代码之前，树上代码是旧快照——**看代码去 main，看账本来这里**。合并方式用户未裁定）。
- **模式**：**自己做模式**（H 波起，用户明令）——Claude 设计 + 实现 + 直接推 main，
  纪律全套照旧，审核标准对自己同样执行。设计稿「定稿即施工、决策点事后可否决返工」。
- 用户风格：中文、决策快、放权但要求申报与可否决。

## 2. 纪律（违反任一条即返工，对自己同样适用）

1. **零新 npm 依赖**：dependencies/devDependencies 一行不动（scripts 行有先例可加）。
   U 波的 Office 能力就是在这条约束下自建的——`.docx/.xlsx/.pptx` 是 ZIP+OOXML，
   读用已有的 yauzl、写用内置 zlib。
2. **TDD 先红**：新逻辑先写失败测试，先红输出存档后再实现。
3. 完成后 `cd deskminis && npm test` + `npm run typecheck` 全绿；**`.vue` 不在 typecheck
   覆盖内**——renderer 改动必须配 `tests/renderer-*.test.ts` 源码文本守卫。
   （这条的代价已四次兑现，见 §6「vue-tsc 立项评估」。）
4. 注释中文写「为什么」；最小改动面；**DB 只追加式迁移**（新表走 `store/db.ts` MIGRATIONS
   数组尾部）。加迁移必随动**六个** user_version 版本钉测试——这是设计出来逼显式确认的，
   改它们要在 commit 里申报。同类还有 `tests/m5-packaging.test.ts` 的 version 钉。
5. **commit**：`-F` UTF-8 消息文件（「——」被终端吞过），格式 `<步骤号>: 简述`，身份
   `git -c user.name="lincheuk" -c user.email="linchaoheng3@gmail.com" commit`。
6. **push**：commit 后立即推，失败 2/4/8/16s 退避重试 ≤4 次；推后
   `git log origin/<分支> --oneline -1` 远端验证并贴输出。
7. 偏离逐条申报（含白名单外任何改动、注释措辞级别）。
8. **退出码必须来自目标命令本身**——管道/链式后取 `$?` 一律无效。已三次兑现。
   正确形：`npm run typecheck > /tmp/tc.log 2>&1; echo EXIT=$?`。
9. **cwd 在每次 Bash 调用之间会重置回项目根**（本次会话实测，栽过多次：
   `pathspec did not match` / `FileNotFoundError` / TC=254）。每条命令自带 `cd` 前缀，
   或一律用绝对路径。
10. 多任务独占 checkout 串行（F 波 index 踩踏教训）。

## 3. 验证方法论（云端审核工具箱）

- **npm test 的真身**：`cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`
  ——裸 `npx vitest` 会炸 better-sqlite3 ABI。跑单文件照此形。
- **Linux 基线 52 例**：云端跑全量必有 52 例平台性失败（PowerShell/bridge/terminal 类），
  清单在 `docs/handoff/linux-baseline-failures.txt`。比对法：
  ```
  npm test 2>&1 | grep '^ FAIL ' | sed 's/^ FAIL  //' | LC_ALL=C sort
  ```
  与基线（同样 sort 后）diff 必须为空。Windows 真机应全绿。
- **xvfb 真跑**（UI 改动必做）：playwright-core `_electron.launch`
  （executablePath=`node_modules/electron/dist/electron`，args `['--no-sandbox','.']`，cwd=deskminis）。
  **先 `npm run build`**——app 跑的是 out/ 产物。
  26 个现成剧本 + 索引在 `docs/handoff/driver/`（**先读那份 README.md**）。
- **实拍剧本必须覆盖权限门**（V 波血的教训）。触发要点：
  **只读命令默认 `bypass` 不弹卡**（`DEFAULT_LEVELS.readonly = 'bypass'`），
  必须用 `gated` 类命令（如 `npm install …`）或往工作区外写文件。照抄 `drive-v1.mjs`。
- **FakeProvider**：`DESKMINIS_FAKE_PROVIDER=1`；UI 路径必须种子
  `providers.json` = `{"providers":[],"defaultProviderId":"__fake__"}`。
  首条用户文本形如 `__tool__ <工具名> <inputJSON>` 触发一次工具调用；**取历史首条重放**
  （同会话每轮都重放首条，别试图让第二条生效——要不同工具就开新会话）；
  `DESKMINIS_FAKE_REPLY` 定制回复文本。
  **工具 inputJSON 必带 `"tool_title"`**——registry 的 required 校验先于执行与权限闸。
- **交叉验证**（U 波成例）：自建的文件格式要用**独立第三方库**读回来验，不能只自洽。
  python-docx / openpyxl / python-pptx 只装在 scratchpad，不进项目依赖。
  这一步逮到了真 bug：生成的 docx 缺 `Normal` 样式——Word 自己不介意，python-docx 直接抛。
- **headless RPC e2e 模板**：`scripts/e2e-m2a-acceptance.mjs`；GUI/CDP 模板是 `e2e-mu6`；
  `npm run e2e:mcp` 六案可回归；`npm run e2e:m5` 是打包验收。

## 4. 波史与当前状态

| 波 | 内容 | 关键 commit |
|---|---|---|
| A–G + MU/M 系列（前史） | agent 循环 / 权限网关 / 记忆压缩 / 设备同步 / 技能 / 桥 / MCP / Aurora 换皮 / 扩展市场 | — |
| **H** | 文本选区注释（自己做首波） | `2e5c086` `5fa33d1` `933d4c3` |
| **I** | AionUi 换向 UI**改造**：色板蓝白系 + 壳层平面化 + 欢迎态 | `c965365`→`384e965`；I6 `edf3dd0` |
| **J** | 助手体系（cowork 化地基）；顺带修会话模型绑定休眠 bug | `b209394` `6ccc68a` |
| **K** | 定时任务（诚实版 24/7：应用运行时生效，不假装后台常驻） | `df1abb8` `7fab434` |
| **L** | 候选池批次一：输入历史 / @文件 / 锚点轨 / md 预览 / 会话级 MCP UI | `dd62c7a`…`e60abda` |
| **R** | v0.2.0 发布就绪：升版 / 图标 / 云端打包验证 / `docs/RELEASE.md` | `46f270d` `45f7c80` `6bd9741` `965db29` |
| **S** | 质感层返工（用户「字体 UI 都没有圆角这种感觉」）：**全局根本没有 line-height**（头号成因）、字号阶梯、圆角上调、输入卡阴影语言 | `552ba64` `ddc0df7` `4ceee7c` |
| **T** | **UI 推倒重做**（用户「抛弃原本的 UI 设计，我要你重新做一个，不是搞出四不像」）：新令牌 `theme.css` + 新组件树 `ui/`，入口切 `AppShell`；三栏工作台（产出物预览占主舞台）；含**字体修正**（随包思源黑体，此前照搬 macOS 字体栈是错的）与**色板修正**（把 AionUi 的灰阶 `#4E5969` 当成了主色，界面因此灰扑扑） | `d06c74b`→`bc68510`；T5 `6fd7aa9` |
| **U** | Office 能力（用户「officecli 自己参考他的源码做一下」）：零新依赖自建 OOXML 读/写/预览 + `office_read`/`office_write` | `2b4ab7c` |
| **V** | 换壳能力面补齐（可达性盘点逮到发布级阻断）：权限卡+差分预览 / 事件条+重试 / 思考块 / 终端抽屉 / 任务面板 / 附件 / 扩展市场 / 产物清单 / 注释与引用 九件 | `a3adb6c` `0af3530` `3deaa0e` `82b520b` |
| **W** | 沉淀：升版 0.3.0 + README/CHANGELOG/RELEASE 与代码对齐 + 本文件 | `b7450ca` |

**当前**：main `b7450ca`，**version 0.3.0**，minis.db user_version=**11**。
166 测试文件 / 1942 例（1890 过 + 52 基线），typecheck 0。

## 5. 关键文件地图

> **这一节是本次换代的核心动机**——旧版指向的组件已全部失效。

### renderer（**新树在 `src/renderer/src/ui/`**）

入口 `main.ts` → `styles/theme.css` + `styles/tokens.css` + `ui/AppShell.vue`。

| 文件 | 职责 |
|---|---|
| `ui/AppShell.vue` | 三栏外壳：TopBar / [NavRail \| Stage \| WorkspacePanel] + 底部终端抽屉。视图路由在这里（chat/search/cron/assistants/market/settings/devices） |
| `ui/TopBar.vue` | 40px 标题栏。**右侧必须留 146px** 给系统 min/max/close（frameless + titleBarOverlay） |
| `ui/NavRail.vue` | 左导航。产出物预览打开时自动收成图标条 |
| `ui/StageWelcome.vue` / `ui/StageChat.vue` | 欢迎态 / 会话态（两个**并列视图**，不是同一棵树上叠条件） |
| `ui/StageSettings.vue` + `ui/settings/Sec*.vue` | 设置页七节：Models / Permission / Skills / Mcp / Search / Look / About |
| `ui/StageAssistants` `StageCron` `StageDevices` `StageMarket` `StageSearch` | 五个舞台视图 |
| `ui/Composer.vue` | 输入卡。hero / chat 两态；斜杠菜单 + @ 文件 + 输入历史 + 附件三入口 + `quote()` |
| `ui/PermCard.vue` + `ui/UiDiff.vue` | **权限卡**与批准前差分预览 |
| `ui/PreviewPane.vue` + `ui/OfficeView.vue` | 产出物预览（md/文本/图片 三态工具条）与 Office 内容预览 |
| `ui/WorkspacePanel.vue` + `ui/UiFileTree.vue` + `ui/TaskPanel.vue` | 右栏三 tab：文件 / 改动 / 任务 |
| `ui/TerminalPane.vue` | 终端抽屉（xterm，与 agent 共用长驻 shell） |
| `ui/AnnoLayer.vue` | 选区注释：手势 + CSS Highlight 着色 + 气泡 |
| `ui/StepGroup.vue` `ThinkBlock` `EventNotes` `ModelBar` `TabBar` `UiIcon` | 会话内构件 |

**`components/` 下只剩三个活文件**：`Icon.vue`、`MarkdownInline.vue`、`MarkdownView.vue`
（被 `ui/PreviewPane`、`ui/StageChat`、`ui/StageMarket` 引用）。**其余 25 个 + `App.vue` 已死**，见 §6 T6。

`stores/chat.ts`（599 行）是全树共享地基，20+ 测试对它做断言。
`lib/` 活模块：`annotations/anchor`、`artifacts/collect`、`attach/downsample`、
`composer/{autogrow,history,at-files}`、`cron/describe`、`devices/fmt`、`diff/{lcs,payload}`、
`eventnote/copy`、`markdown/parse`、`nav/group`、`perm/{copy,countdown}`、`time/{hhmm,relative}`。

### 样式（**两套令牌并存，注意碰撞**）

- `styles/theme.css`（341 行，**新**）：`--c-`（色）/ `--t-`（字号行高成对）/ `--r-`（圆角）/
  `--sp-`（间距）/ `--sh-`（阴影）+ 表单原语 `.f-*` + 排版工具类 `.t-*`。`ui/` 树 69 个变量全出自这里。
- `styles/tokens.css`（737 行，**旧**）：A 区 raw / B 区语义别名 / C 区尺度四段。
  **不能删**——见 §8 风险 A。

### minisd

- `src/minisd/index.ts`：RPC 注册全集 + FakeProvider + 权限广播 + standalone 握手 + cron 调度器
- `store/db.ts`（MIGRATIONS[0..10]）、`store/chat-store.ts`、`store/provider-store.ts`
- **`office/{zip,parse,build}.ts` + `tools/office.ts`**（U 波）：手写 ZIP 容器 + 三解析器 + 三生成器
- `tools/permissions.ts`：`DEFAULT_LEVELS`（**readonly 默认 bypass**）、`classifyShellCommand`
- `agent/loop.ts`、`assistants/`、`cron/`、`mcp/`、`market/`、`remote/`

### 守卫测试（动 UI 必看）

`theme-contrast`（新令牌 35 例）、`tokens-mu3-appica`（**组件零硬编码颜色** + 别名映射）、
`renderer-titlebar-stacking`（**层级序：主体 < 标题栏 50 < 模态 100**）、
`a11y-keyboard-reachable`、`renderer-*` 各源码守卫。
新树的守卫：`renderer-stage-views`、`renderer-chat-capabilities`、`renderer-shell-panels`、
`renderer-attach-shell`、`renderer-market-shell`、`renderer-anno-shell`、
`renderer-office-preview`、`renderer-default-provider`。

## 6. 排期与候选池（2026-09-07 对过账）

### 一档：挡在发布前面的（建议先清，三选一）

1. **0.3.0 Release 上架**——唯一真正的发布阻断。GitHub Releases 目前**只有 v0.1.1**，
   v0.2.0 从未发布。按 main 的 `docs/RELEASE.md` 在 Windows 真机走：
   构建 → `e2e:m5`（**必须重跑，R 波结论已过期**）→ 手动冒烟 → 上传三件套（`latest.yml` 漏传 = 自动更新失明）。
2. **T6 清场**——37 个死文件 / 7238 行 + 40 个测试文件的守卫重指。拖得越久越难拆。
   **开工前必读 §8 风险 A 与下面的补充事实**。
3. **首发竞态排查**——L6 实测：紧跟启动的首条 Enter 偶发被吞，`lastError` 空。
   T 波把输入链路整个重写过，**旧复现脚本可能已不适用，需重新复现**。

### 二档：前提已变 / 纯补入口

4. **办公技能包**——原搁置理由「无本地 Office 工具，教 agent 用 python-pptx 质量不可保证」
   **已被 U 波消除**，值得重新评估。
5. **模型组降级 UI 入口**——后端 `group:` 分派全通，README 挂 🟡 已经好几波了。
6. **vue-tsc 立项评估**——「全绿 ≠ 界面正常」已**四次**兑现，最近一次是发布级阻断
   （权限卡漏渲染躲过 1890 例全绿）。撞零新依赖红线，故是「立项评估」不是「直接做」。

### 三档：需先出设计稿

会话正文全文搜索（要在 minisd 侧建索引；界面上已如实说明现在只搜标题）、
用量与成本面板（DSH 生态最强需求信号；注意 V5 的任务面板做的是**上下文水位**，
token 占用 ≠ 花了多少钱）、genui 内联交互组件、多窗口对话墙、图片生成、内置浏览器。

### 预览区 T10 遗留（需新 IPC 或存储）

Snapshot / History / Open in system app / Download / 代码语法高亮——五项全部仍未做。

### 其它仍未做

Office L2 DOM 精改（量级等同重写 OfficeCLI）、Office 高保真渲染（需版式引擎，
且「内容预览不是版式还原」已是刻意的产品化边界）、Ctrl+K 命令面板、非图像文件附件
（V6 补的是入口，格式面仍只收 `image/*`）、模型选择器搜索、消息内文件路径可点击、
已完成回合自动折叠、规划模式、会话分叉、技能覆盖三层判定、会话级权限覆盖、
注释入上下文 / 入同步 / 多色、`marketplace.json` 自定义源、market provenance 补 version、
fixture 环境变量生产门控、MCP 的 OAuth / resources / prompts / 非文本内容。

### 已划掉（做完了或已被覆盖，别再数一遍）

**I7 会话视图对齐**（三项被 T4 三栏 + StepGroup + WorkspacePanel 整体覆盖）、
首页输入卡双层结构（T 波 Composer hero 态）、MCP 会话级禁用 UI（L5/L6）、
市场 MCP tab（G 波）、后台作业（K 波定时任务是同一需求面的诚实版）、
历史消息附件（V6 做成 chip + 点开预览；**内联缩略图仍未做**）。

### 换壳遗失的入口（T6 清场对账，2026-09-10；用户裁定只补工作区，其余在此）

后端与 store 都通、`ui/` 下零调用。**已由 `tests/mu6-capability-wiring.test.ts` 设双向绊线**：
补上任何一条那条测试会红，请顺手把它从 GAPS 挪进 WIRED、README 的 🟡 改回 ✅。

| 入口 | store action / 字段 | 立于 | 备注 |
|---|---|---|---|
| 删除会话 / 重命名 | `deleteSession` `renameSession` | MU6 / B1 | 会话行 ⋮ 菜单整个没搬 |
| 会话记忆开关 / 绑定模型 | `setSessionMemory` `setSessionModelBinding` | MU6 / J2 | 同上 |
| 会话级禁用 MCP | `setSessionMcpDisabled` | L5 | 输入卡 pill + 行内面板 |
| 同步暂停 / 恢复 | `setSyncPaused` | M6 | 状态可见（TopBar `syncDot`），改不了 |
| 助手 ↔ 技能绑定编辑 | `skillIds`（assistants.create/update） | J | 新编辑器无此字段 |
| 消息锚点导航轨 | `data-turn-id` + 轨道组件 | L3 | 纯渲染侧，绊线单独钉 |

以下是**收窄**（不是能力缺失，是入口变少或换了形态），未设绊线，做不做看需要：
消息来源设备标（`originDeviceId` 落库仍在，没人渲）· ☰ 菜单只剩主题切换（重载/退出走原生菜单，
三区切换/复制没了渲染端入口）· `Ctrl+,` 打开设置 · MCP env/headers 编辑器（只能手改 servers.json）·
MCP 列表行逐台试连（表单内仍可试）· 用户消息 hover 复制钮 · 会话行运行态徽标与产物数 ·
拖拽分栏（新壳纯 flex，`--w-chatcol` 定宽）· 任务栏耗时读数。

### 悬空（等用户裁定）

docs 分支合并进 main 的方式；仓库转 public（转了自动更新即生效）；
brave/tavily 真 key 首跑验收。

### T6 开工前的补充事实（已实测）

- `components/` 下**只有 25 个死文件**，`Icon` / `MarkdownInline` / `MarkdownView` **三个仍活**。
- **`tokens.css` 不能随旧组件一起删**：MarkdownView 消费 14 个、MarkdownInline 消费 4 个
  只存在于 tokens.css 的变量（`--font-mono` `--label` `--r-md` `--separator` 等）。
  `main.ts` 现在的注释把原因记成了「DiffView 等」——**那是错的**，DiffView 已死，
  真正的钉子是 MarkdownView。
- 触及死文件的是 **40 个**测试文件（不是此前记的 43）。`renderer-*` 大多在**模块顶层**
  `readFileSync`——一个文件缺失会让该测试文件的**全部** `it()` 无法加载，而不是只红几例。
  `tests/renderer-mcp-settings.test.ts` 是唯一用 `existsSync` 保护过的先例，值得照抄。
- 三个死 lib 模块的能力被新树**内联重写**（`scroll/follow` → StageChat 硬编码 120px 阈值、
  `settings/theme` → SecLook 内联 localStorage、`toolline/group` → StepGroup），
  等于把已测的纯判据换成了未测的内联代码。`lib/pane/drag` 则是**能力缺失**——
  新壳是纯 flex，**没有拖拽分栏**。
- 守卫分类原则：**不变量仍成立 → 重新指向新树；随实现退场 → 连同实现一起删并在 commit 说明理由。**
  一删了之会留下守卫真空，比留着死代码更危险。

## 7. 教训镇魂碑（别再踩）

1. **换壳是搬家，不是在新房子里重写主要房间。**
   搬家清单必须**从旧实现逐项核对**，不能从新设计出发补全——后者只会补上你想得起来的那些。
   代价：`StageChat` 只在 watch 依赖里数了 `chat.pendingPerms.length` 却**从没渲染过权限卡**。
   默认档位就是「每次确认」，agent 一请求权限，界面什么都不出现，回合无声卡死到 90 秒超时被判拒绝。
   **1890 例全绿、typecheck 0、之前所有 xvfb 实拍都没拦住**——因为没有一个剧本走过权限门。
2. **内部标识符漏给用户看**（V 波一波内撞三次）：`StopReason` 枚举原样上屏（`endTurn`）、
   更新状态照 electron-updater 的**事件名**写映射（主进程存的是 status 值，一条都对不上）、
   yauzl 英文报错直达预览卡。三条各补一道守卫钉住两边一致。
3. **界面撒谎比界面难看严重。** 默认 provider 一直是猜的（取 `providers[0]`），
   设置页把这个猜测显示成「当前默认」高亮——用户看到 A、后端在用 B。补了 `provider.getDefault` RPC。
4. **「全绿 ≠ 界面正常」已四次兑现**：`.smore` bug、浮条 CJK 竖排、字体在容器里全是
   文泉驿（截图给用户看的中文是变形的）、权限卡漏渲染。UI 改动必 xvfb 目视。
5. **守卫是资产**：遇守卫红**先想「它对不对」**，对就改自己的代码，不加豁免。已五次兑现，
   最近两次：S 波抬 `--radius` 基准撞 A 区逐行契约、V 波在组件里写死 rgba 遮罩
   （tokens.css 早有 `--scrim` 收编先例）与把模态 z-index 放进主体档。
   注意豁免要做**值级**不是文件级——文件级会让面板内容整个失去守卫。
6. **有守卫 ≠ 有覆盖**：删旧组件不会让新树的守卫真空变红（见 §8 风险 B）。
   守卫锚在哪个目录，就只守那个目录。
7. 管道吞退出码 ×3；Windows 时钟 ~15ms（同刻排序一律 rowid tiebreaker）；
   `assertSessionId` 是格式闸（测「会话不存在」要用格式合法的 UUID）；
   乐观消息 id `local-<n>` 落库后被换，任何持久引用不得挂它。
8. **换壳漏搬不止漏整块能力，也漏「页面上的一句交代」与「顺手丢掉的字段」**。
   T6 一波里补回六句交代（技能启停是全局的 / SearXNG 要开 JSON / servers.json 坏了会按空配置加载 /
   定时任务 90 秒自动拒绝 / 每次确认 90 秒按拒绝 / 权限档位说明），一个字段（工具 `input`：
   读了 `tool_title` 当标题，把整个对象扔了——差分视图与参数区因此整个没了）。
   搬家清单要**逐句核对旧页面文案**，不只核对功能点。
9. **守卫重指前按意图搜，不按旧名搜；断言认调用形态，不认字符串**。同一波里栽两次：
   按 `syncdot` 小写搜 TopBar 零命中，差点把活着的同步点判成「没搬」；能力清单初版用
   `includes(action)`，被同文件注释里的散文提及喂饱，自检时**没红**。改成认 `.action(` 才响。
10. **自己的报告也要有输出为证**——不采信报告这条纪律在自己做模式下同样成立。

## 8. 已知风险与技术债（记录在案，尚未处理）

### 风险 A（已处理，T6d `906d093`）：两套令牌系统同名碰撞

W 波记的是「四个同名令牌」——**数错了**，提取正则锚了行首、每行只数到第一个声明。
实测 **9 个同名、7 个值不同、`ui/` 下 297 处引用**（`--sp-2/3/4/5/6/8` 与 `--r-input`
被 tokens.css 顶高一档）。T6d 的处置是**承认现状**：把 theme.css 改成当前真正渲染出来的值
（零视觉变化），`--sp-7` 保持 20px 与 `--sp-5` 同值不动；配守卫「两文件同名令牌必须同值」
（`tests/theme-contrast.test.ts`，带 px/rem/var/calc 解析器，认不出的形态直接抛错不跳过）。
tokens.css 本身**仍不能删**：MarkdownView 消费 14 个、MarkdownInline 消费 4 个只在它里面声明的变量，
搬完这 18 个再删。

### 风险 B（已处理，T6a `ed1dc09`）：新树上的守卫真空

UiIcon 的 `v-html` 现在有 `tests/renderer-ui-icon-guard.test.ts` 白名单守着；
`a11y-keyboard-reachable` 改成递归扫描整棵 renderer 树（旧的只扫 `components/`），
顺带修掉了 TabBar 关闭键键盘不可达。三个守卫都做过「故意破坏→变红→还原」。
旧的 `renderer-a11y-keyboard.test.ts` 在 T6e 随之删除（同一规则不守两份）。

### 风险 C：打包验证已过期

R 波的 asar 结构与冒烟结论是对 0.2.0 那个快照做的，之后又落了 S/T/U/V 四波
（UI 整体重建 + 新增 Office 模块）。**0.3.0 发布前 `npm run e2e:m5` 必须重跑。**
已在 `docs/RELEASE.md` 章程段加了警告。

### 其它

- `--win` 交叉构建在 Linux 实测 `spawn wine ENOENT` 不可行，证据
  `docs/handoff/r3-win-crossbuild-fail.log`。安装包只能在 Windows 上构建。
- tag 推送被 403 拒（凭据只放行分支推送），故 tag 统一走 GitHub Release 发布时自动创建。
- 私仓期间自动更新 404 静默为既知态。
