# DeskMinis 会话交接文档（2026-08-20，L 波收官后）

> 用途：新对话开局投喂。本文件同时存于 docs 分支 `docs/handoff/2026-08-20-session-handoff.md`，
> 配套资产（52 例基线清单、审核 driver 脚本）在 `docs/handoff/` 同目录。

## 1. 项目与协作模式

- **项目**：DeskMinis——Windows 桌面通用 Agent 应用（Electron + TS + Vue3 + better-sqlite3）。
  仓库 `github.com/lincheuk/Deskminis`，应用代码在 `deskminis/` 子目录。只在 Windows 真机发布验证。
- **两条分支**：`main` = 功能落地线；`claude/deskminis-handoff-dd9wrk` = **权威记账线**
  （PROJECT_NOTES.md 全部审核/波结记录 + docs/specs 设计稿；分支叉在 G 波代码之前，
  树上代码是旧快照——看代码去 main，看账本来这里。合并安排悬空，用户未决定）。
- **两种模式**：
  - **Trae 模式**（A–G 波）：Claude 出提示词 → 用户转 Trae（Windows 本机推 main）→
    Claude 逐 commit 审 diff + 云端独立复跑（**不采信报告**）+ 记账到 docs 分支。
  - **自己做模式**（H 波起，用户明令「H波自己做」）：Claude 设计 + 实现 + 直接推 main，
    纪律全套照旧，审核标准对自己同样执行。**当前默认模式**（I 波起无新指示即沿用；
    用户点名「你做代码审查，性能优化」的视角要求仍然有效）。
- 用户风格：中文、决策快、放权但要求申报与可否决；设计稿逐节确认制（自己做模式下改为
  「定稿即施工、决策点事后可否决返工」）。

## 2. 纪律（违反任一条即返工，对自己同样适用）

1. **零新 npm 依赖**：dependencies/devDependencies 一行不动（package.json scripts 行有先例可加）。
2. **TDD 先红**：新逻辑先写失败测试，先红输出存档后再实现。
3. 完成后 `cd deskminis && npm test` + `npm run typecheck` 全绿；**`.vue` 不在 typecheck
   覆盖内**——renderer 改动必须配 `tests/renderer-*.test.ts` 源码文本守卫。
4. 注释中文写「为什么」；最小改动面；**DB 只追加式迁移**（新表走 `store/db.ts` MIGRATIONS
   数组尾部；单列加法另有 ChatStore 构造器幂等补列成例，见 mcp_disabled_json）。
   加迁移必随动：**六个**「版本钉」测试（db-migration6 / market-cache-migration /
   market-installs-migration / workspace-picker / annotations-store / assistants-store）的
   user_version 断言与旧库回退块（回退 DROP 清单含 assistants / cron_jobs）——
   这是设计出来逼显式确认的，改它们要在 commit 里申报。
5. **commit**：`-F` UTF-8 消息文件（「——」被终端吞过），格式 `<步骤号>: 简述`，身份
   `git -c user.name="lincheuk" -c user.email="linchaoheng3@gmail.com" commit`。
6. **push**：commit 后立即推，失败 2/4/8/16s 退避重试 ≤4 次；推后
   `git log origin/main --oneline -1` 远端验证并贴输出。
7. 偏离逐条申报（含白名单外任何改动、注释措辞级别）。
8. 多任务独占 checkout 串行（F 波 index 踩踏教训）。
9. **退出码必须来自目标命令本身**——管道/链式后取 `$?` 一律无效。此坑三次兑现：
   G2 审核 typecheck 假阳性（`&& echo OK` 静默断链）、Trae push 循环 `| Out-String` 吞码、
   审核方自己 `typecheck | tail; echo $?`。正确形：`npm run typecheck > /tmp/tc.log 2>&1; echo EXIT=$?`。
10. cwd 老坑：cd 进 deskminis/ 后不要再用带 `deskminis/` 前缀的相对路径；多用绝对路径。

## 3. 验证方法论（云端审核工具箱）

- **npm test 的真身**：`cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`
  ——裸 `npx vitest` 会炸 better-sqlite3 ABI（electron-rebuild 产物）。跑单文件照此形。
- **Linux 基线 52 例**：云端跑全量必有 52 例平台性失败（PowerShell/bridge/terminal 类），
  清单在 `docs/handoff/linux-baseline-failures.txt`。比对法：
  `npm test 2>&1 | grep '^ FAIL ' | sed 's/^ FAIL  //' | LC_ALL=C sort` 与基线（同样 sort 后）
  diff 必须为空。Windows 真机（用户/Trae）应全绿。
- **无 matcher 断言机械扫描**：`git diff | grep "^+" | grep -oE "expect\([^;]*\);" | grep -vE "\)\.(to|not|resolves|rejects)"` 应零命中。
- **xvfb 真跑**（「全绿 ≠ 界面正常」已三次兑现，UI 改动必做）：playwright-core `_electron.launch`
  （executablePath=node_modules/electron/dist/electron，args ['--no-sandbox','.']，cwd=deskminis）。
  **先 `npm run build`**——app 跑的是 out/ 产物，改了源不重建等于白测。现成 driver 在
  `docs/handoff/driver/`（主题截图 / 市场全链路 / 装→用闭环 / K 波定时全链路 drive-k3 /
  L 波五件套 drive-l6——后者带 sendMsg 落库校验重试与 waitIdle，发消息类 driver 照抄它，
  固定 sleep 后直接连发第二条会被回合竞态吞掉）。
- **FakeProvider**（src/minisd/index.ts:160 附近）：`DESKMINIS_FAKE_PROVIDER=1`；RPC 路径
  chat.prompt 显式传 `providerId:'__fake__'`（无需 providers.json）；UI 路径走默认 provider，
  必须种子 `providers.json` = `{"providers":[],"defaultProviderId":"__fake__"}`。
  首条用户文本形如 `__tool__ <工具名> <inputJSON>` 触发一次工具调用；**取历史首条重放**
  （同会话每轮都重放首条，别试图让第二条生效）；`DESKMINIS_FAKE_REPLY` 定制回复文本。
  **工具 inputJSON 必带 `"tool_title"`**——tools/registry.ts 的 required 校验先于执行与权限闸，
  缺了报「缺少必填参数」且权限卡不弹。
- **headless RPC e2e 模板**：scripts/e2e-m2a-acceptance.mjs——spawn electron out/main/minisd.js
  + `ELECTRON_RUN_AS_NODE=1` + `DESKMINIS_STANDALONE=1`（stdout 握手行 `{minisdPort,authToken}`）
  + `DESKMINIS_TEST=1`（内存 vault）+ `DESKMINIS_DATA_DIR=临时根`；ws 带 `?token=` 连接。
  GUI/CDP 模板是 e2e-mu6。D7 产物 `npm run e2e:mcp` 六案可回归。
- 权限广播：`permission.request {requestId, req:{kind,detail,sessionId,toolTitle,preview?}, meta}`；
  应答 RPC `permission.respond {requestId, decision:'allow-once'|'allow-session'|'deny'}`；
  会话事件 `chat.event {sessionId, event}`，kind ∈ textDelta/toolStart/toolEnd/turnEnd/error…
- 市场 fixture 注入口：`DESKMINIS_MARKET_FIXTURE_URL`（三源端点形状见 tests/market-adapters.test.ts）。

## 4. 波史与当前状态

| 波 | 内容 | 关键 commit |
|---|---|---|
| A–C + MU/M 系列（前史） | agent 循环/权限网关/记忆压缩/设备同步/技能/工作台 UI/桥 | — |
| D | MCP 最小面：config/stdio/http/manager/权限(kind=mcp askOnce per server)/设置页/e2e | D1 399759a … D7 6adb4bf |
| E | Aurora 换皮：tokens 四段双层、26 对对比度守卫、键盘可达守卫 | 3d0c280→bd0f299 |
| F | DSH rc.8 双雷：取消流式落半截修复、图片 1568px 像素硬约束 | a10c321/d1d8810/d707cc0 |
| G | 扩展市场：三源(ClawHub/MCP Registry/awesome-dsh)/白名单闸/malicious 硬阻断/装→用闭环实证 | c4691a5→8824ed4 |
| 收官 | README 能力表对齐（审核方直推 main 首例） | 032a117 |
| **H** | **文本选区注释（自己做首波）**：迁移[8] annotations + RPC 四件 → anchor 骨架锚定 + 浮条(引用/标注) + CSS Custom Highlight API → 注释气泡 | H1 2e5c086 / H2 5fa33d1 / H3 933d4c3 |
| **I** | **AionUi 换向 UI 重做**（用户 2026-08-20 指令，原 genui 延后）：色板蓝白系 + 壳层/内容区平面化（玻璃/极光退场）+ 欢迎态 welcomeMode；立项材料 docs/research/2026-08-20-aionui-survey.md + specs/2026-08-20-ui-redo-aionui-design.md | I1 c965365 / I2 39ad8b0(+c335ae4 误标半提交，已申报) / I3 ef3ff93 / I4 384e965 |
| **I6** | 欢迎屏/侧栏/标题栏对齐 AionUi 新版（用户「你那个明明是旧版ui」+ 三截图）：hero→composer→助手 chips 次序 + **选中再输入**流 + 侧栏恒展开 240px 品牌行 + 标题栏单 ☰ 菜单；第三截图（会话视图对齐）列 **I7 候选**待拍板 | edf3dd0 |
| **J** | 助手体系（cowork 化地基）：迁移[9] assistants + 一次性种子 3 + applyAssistantPreset（技能快照覆盖）+ promptFactory assistantBlock + 欢迎页助手卡 + 设置·助手管理页；**顺带修会话模型绑定休眠 bug**（裸 id 从未生效，三侧齐修） | J1 b209394 / J2 6ccc68a |
| **K** | 定时任务（诚实版 24/7）：迁移[10] cron_jobs + schedule 纯核心（interval/once/cron，Vixie OR）+ 30s 调度器（防重入/并发防重/once 自停）+ runDoneHooks 完成钩子 + 「定时」tab + CronPanel 人话预览；边界产品化（应用运行时生效 / 权限 90s 自动拒绝文案常驻） | K1 df1abb8 / K2 7fab434 |
| **L** | 候选池批次一（五小件）：L1 输入历史 ↑↓ / L4 FilesPanel md 预览段控 / L5 会话级 MCP pill+面板（D5 后端补 UI 入口）/ L2 @ 文件引用（受限递归 BFS ≤4 层 ≤500）/ L3 锚点导航轨；L6 目视修 pill 首拉时机真 bug | dd62c7a / d0e2eba / 0860084 / c3762ae / 3e2da98 / L6 e60abda |
| **R** | **v0.2.0 发布就绪**（用户 /goal）：升版+CHANGELOG+README 三行+e2e-m5 修根 / build/icon.ico 补缺+tray 换蓝（纯 node 生成）/ 云端打包验证（--dir 结构+asar 态 xvfb 冒烟全通；--win 交叉构建 wine ENOENT 确定不可行）/ docs/RELEASE.md 检查单；tag 推送 403 → Release 发布时自动建 tag v0.2.0（目标 6bd9741） | R1 46f270d / R2 45f7c80 / R4 6bd9741 / R4b 965db29 |

- **当前**：main HEAD `965db29`（R 波收官，**version 0.2.0**）；docs 分支看最新 log。
  测试 **1835 例 / 155 文件**（云端 1783 过 + 52 基线；Windows 待用户真机双主题目视收官）。
  minis.db user_version=**11**（[9] assistants、[10] cron_jobs）。typecheck 零错误。
  **发布**：源码侧就绪，安装包构建与 Release 上传按 main 的 docs/RELEASE.md 在 Windows
  真机执行（latest.yml 必传；私仓期间自动更新 404 静默）。版本钉测试自 R1 起为
  m5-packaging（0.2.0）+ 六个 user_version 钉。守卫更名（I 波）：
  renderer-aurora-shell→renderer-shell-form、renderer-aurora-content→renderer-content-form；
  tokens 参考文件换 2026-08-20-aionui 版。
- H 波技术要点（新会话动 ChatView 前必读）：锚定 = TextQuoteSelector 对「渲染后文本」，
  匹配域 = **去尽空白骨架 + 偏移映射**（`lib/annotations/anchor.ts` 纯核心，12 例单测）；
  高亮 = CSS Custom Highlight API 零 DOM 改写（`::highlight` 样式必须在**非 scoped** 块）；
  点击命中与选区同走 `.stream` 的 **mouseup 单手势面**（`<div @click>` 会被
  a11y-keyboard-reachable 守卫拦下——这是对的，别加豁免）；锚域 `[data-anno-root][data-mid]`
  只包正文（工具行 textContent 会变，绝不能进锚域）；乐观消息 `local-` id 不给标注入口。
  红线：注释不注入模型上下文、不入设备同步。

## 5. 关键文件地图

- **minisd**：`src/minisd/index.ts`（RPC 注册全集 + FakeProvider + 权限广播 + standalone 握手 +
  cron 调度器 runCronJob/cronTick）; `store/db.ts`（MIGRATIONS[0..10]）; `store/chat-store.ts`
  （会话/消息/注释/assistant_id 幂等补列）; `assistants/`（store 种子与预设应用 + prompt 注入块）;
  `cron/`（schedule 纯核心 + store）; `mcp/`（config/
  stdio/http/manager——工具名 `mcp__<server>__<tool>` sanitize 非 [a-zA-Z0-9_-]→_）;
  `market/`（client 白名单闸/cache/三适配器/install stdio 白名单）; `tools/registry.ts`（required 校验）;
  `agent/loop.ts`（事件类型定义）。
- **renderer**：`components/ChatView.vue`（回合流/composer/选区注释/斜杠+@ 双菜单/输入历史/
  锚点轨/工作区+MCP 双行内面板全套）; `MarkdownView.vue`（AST→模板，**零 v-html 红线**）;
  `EmptyState.vue`（分部渲染 hero/below）; `AssistantSettings.vue`; `CronPanel.vue`;
  `FilesPanel.vue`（md 渲染/源码段控）; `MarketPanel.vue`; `McpSettings.vue`; `stores/chat.ts`;
  `lib/annotations/anchor.ts`; `lib/composer/`（autogrow/history/at-files）; `lib/cron/describe.ts`;
  `styles/tokens.css`（四段：:root 浅/媒体暗/强制暗/强制浅；
  A 区 raw 值唯一来源是 docs 分支 `docs/specs/2026-08-20-aionui-tokens-reference.css`）。
- **守卫测试**（动 UI 必看）：`tokens-aurora-contrast`（26+1 断言）; `a11y-keyboard-reachable`
  （div @click 必带键盘等价）; 玻璃 blur 白名单例 8（ALLOW=['ProgressPanel','App',
  'ArtifactsPanel','FilesPanel']，POPUP_OWNERS 永久禁 blur，不扩）; `renderer-*` 各源码守卫。
- **设计稿**（docs 分支 docs/specs/）：2026-07-26 总稿、2026-08-19 MCP、2026-08-19 Aurora、
  2026-08-20 扩展市场、2026-08-20 文本选区注释、2026-08-20 ui-redo-aionui、
  2026-08-20 assistants、2026-08-20 cron、2026-08-20 pool-batch（以上全部已落地）。
  调研：docs/research/2026-08-19-harness-plugin-market-survey.md、
  docs/research/2026-08-20-aionui-survey.md（AionUi 功能/复用裁定，I–L 波的立项母本）。

## 6. 排期与候选池

- J/K/L 三波已收（助手体系 / 定时任务 / 候选池批次一：输入历史、@ 文件、锚点轨、
  md 预览、会话级 MCP UI），落地详情见 §4 波史与 PROJECT_NOTES 对应波结。
- **下一件（建议，待用户裁定）：I7 会话视图对齐**（用户第三张 AionUi 截图：文件预览
  中心化 + View Steps 折叠 + 工作区树右栏）——比欢迎屏面大，需先出设计稿。
- 留池四项（pool-batch §6 裁定附理由）：图片生成（provider 协议新面，独立设计稿量级）、
  内置浏览器（独立里程碑）、办公技能包（内容工程，待用户对产出格式拍板）、
  忙碌排队草稿（需队列语义，runDoneHooks 是单钩子）。
- 顺延候选：genui 内联交互组件（安全敏感先出设计稿）、多窗口对话墙、
  技能覆盖三层判定（会话建后新装技能会漏进助手会话，J 波已知边界）。
- 候选池（需求信号序）：用量与成本面板（DSH 生态 150+ 同类，最强信号）、Ctrl+K 命令面板、
  非图像文件附件、模型选择器搜索、消息内文件路径可点击、已完成回合自动折叠、规划模式、
  **首发竞态排查**（L6 实测：紧跟启动的首条 Enter 偶发被吞，lastError 空，未盲修）。
- polish 池：--accent-hover 档、亮色空态渐变、market provenance 补 version、fixture 环境变量
  生产门控、注释键盘打开路径（列表面板）、注释入上下文、注释同步。
- 悬空：docs 分支合并进 main 的方式（等用户裁定）；「模型组降级」README 行仍 🟡（后端有、无 UI 入口）；
  I7 候选待拍板；**v0.2.0 Release 上架**（Windows 真机按 main docs/RELEASE.md 走：构建→
  e2e:m5→冒烟→上传三件套并填 tag v0.2.0/目标 6bd9741）；自动更新要生效需仓库转 public（用户裁定）。

## 7. 教训镇魂碑（别再踩）

1. 管道吞退出码 ×3（见纪律 9）。
2. 「全绿 ≠ 界面正常」×3：.smore bug、浮条 CJK 竖排（absolute 盒 shrink-to-fit 撞右缘，
   解法 width:max-content + 半宽夹紧）、真机截图才见的一切——UI 改动必 xvfb 目视。
3. 守卫是资产：E4 键盘守卫在 H3 波终门禁拦下守卫作者自己的 `<div @click>`——遇守卫红，
   先想「它对不对」，对就改自己的代码，不加豁免。
4. Windows 时钟 ~15ms：同刻排序一律 rowid tiebreaker。
5. `assertSessionId` 是格式闸，测「会话不存在」要用格式合法的 UUID。
6. 乐观消息 id `local-<n>` 落库后被换——任何持久引用不得挂它。
7. Trae 报告可能真也可能漏——一切结论以自己复跑为准（本纪律在自己做模式下同样成立：
   自己的报告也要有输出为证）。
