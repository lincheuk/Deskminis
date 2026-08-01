# DeskMinis MU2（UI 实施）计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把定稿设计 [2026-07-31-ui-design-v2.md](file:///c:/Users/24739/Downloads/openminis1/docs/specs/2026-07-31-ui-design-v2.md)（下称「设计 v2」，章节引用 §n 均指该文档）落到真实应用，消掉审计 [2026-07-31-ui-audit.md](file:///c:/Users/24739/Downloads/openminis1/docs/specs/2026-07-31-ui-audit.md) 22 条（下称「审计」，条目引用 H1-H5/IA-1~5/V-1~5/X-1~7）。拆两阶段串行：**MU2a = 对话流核心**（Markdown 渲染 / 流式淡入与滚动治理 / 令牌层演进 / 回合结构 / 工具行 / diff 视图 / 事件条统一 / minisd 权限白名单 / 权限卡 v2），**MU2b = 面板与外围**（右栏任务仪表板 / 产物 tab / 左栏变体 A / 设置独立模态 + 标题栏瘦身 / 空状态 + Composer v2 / 配对管理面接 M3a `remote.*` 真 RPC / 暗色三模式全量验收）。先内容后骨架：没有 Markdown 渲染与令牌层的右栏/左栏改造是返工坯（设计 v2 §9 顺序的收敛）。

**Architecture:** 渲染端逻辑全部下沉 **纯 TS 模块**（`src/renderer/src/lib/`：markdown / diff / fade / perm-meta 等，无 DOM 依赖、node 直测），Vue 组件只做接线与呈现；新组件：MarkdownView / FadeText / ToolLine / DiffView / EventNote / TurnMessage（回合）/ ProgressPanel / ArtifactsPanel / SessionCard（左栏任务卡）/ SettingsModal / DevicesModal / ComposerBar；改造：ChatView / ToolPill→ToolLine 替换 / PermissionCard / App / SessionList / TasksPanel→ProgressPanel 替换 / TitleBar / EmptyState / Icon（只追加）。minisd 侧只在**决策 4 白名单**三点内动（权限超时常量 / permission.request 广播元数据 / 桥合并授权），其余零改动。

**Tech Stack:** TypeScript (strict) / Vue 3.5 + pinia 3（既有）/ electron-vite 4 / vitest 3（electron as node）/ **零新运行时依赖**（Markdown 自研解析，决策 2）；**零新测试框架依赖**（不引入组件挂载测试，决策 5）

## Global Constraints

- 所有代码在 `deskminis/` 子目录（仓库根 `C:\Users\24739\Downloads\openminis1\`，`OpenMinis/` 是只读参考克隆，永不修改）；文档在仓库根 `docs/`（MU1 已归一）
- TypeScript `strict: true`；包管理 npm；测试命令统一 `npm test`（vitest run，electron as node）；单文件 `npm test -- tests/xxx.test.ts`
- 提交信息 conventional commits + 中文描述（`feat(mu2a): …` / `test(mu2a): …` / `feat(mu2b): …` / `docs(mu2): …`）
- 代码基线 = **main@39f495c**（MU1 定稿提交；M3b 已合并 main@119f5f3，**594 测试 / 55 文件**全绿）。本计划测试估算：MU2a 新增约 132 例 → 完成后约 726；MU2b 新增约 62 例（毛计；MU2b T2 改写退役旧断言 7 例，净增以实际为准）→ 完成后约 788（均相对 594 基线）
- **594 基线不回归**：`npm test` / `npm run typecheck` / `npm run build` 每个 Task 收官必跑；既有 e2e（e2e / e2e:m2a / e2e:m2b / e2e:m2c / e2e:m2e / e2e:m3a / e2e:m3b 七条 scripts）一律保留不删（package.json 只追加 `e2e:mu2a` / `e2e:mu2b` 两条）
- **源文本守卫测试同步修订清单**（改组件必读）：
  - [renderer-files-panel.test.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/tests/renderer-files-panel.test.ts) L55-60 断言 ChatView.vue 含 `useChat` / `activeId` / `messages` 三锚——MU2a 重做 ChatView 必须保住这三个字符串（不会丢，保留即可）；L46-53 断言 App.vue 的 `FilesPanel`/`rightTab === 'files'`/`visited.files` 锚——MU2b 改右栏 tab 结构时**同 Task 内同步修订**该文件断言并注明
  - [renderer-tasks-panel.test.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/tests/renderer-tasks-panel.test.ts) 守卫 TasksPanel.vue / App.vue / chat.ts 的 M2d 锚——MU2b Task 2（TasksPanel → ProgressPanel 替换）**同 Task 内同步修订**该文件（改为守卫 ProgressPanel + 等价锚点），禁止先红后补
- **组件禁止写死颜色**（设计 v2 §3.3-1 红线延续）；新增：**禁止写死 `color-mix` 百分比**（收进语义槽）；新增组件一律走 tokens.css 变量
- **三模式硬约束**：tokens.css 既有色值/媒体查询/`data-theme` 覆盖结构一行不改（只追加，决策 7）；任何新组件必须浅/深/跟随系统三模式可验收（MU2b Task 8 全量截图收口）
- **XSS 红线**：Markdown 渲染全链路禁止 `v-html` / `innerHTML` / `outerHTML`；AST 白名单节点 + 链接协议白名单（决策 2c），LLM 产出中的任何 HTML 一律转义为纯文本
- **单测禁外网**：markdown/diff/fade/perm-meta 纯模块、minisd 权限侧、配对管理 store 接线全部本地断言；e2e 走 `DESKMINIS_FAKE_PROVIDER=1` 假 provider，零真实 HTTP
- **M3b 落地点不回退**（冲突面自查，决策 6）：`src/minisd/sync/**`、`store/chat-store.ts` 同步方法、`store/db.ts` MIGRATIONS[3]、`src/minisd/index.ts` 的 M3a/M3b 装配段、`src/shared/types.ts` 一律不碰

## 架构决策（实现前必读）

1. **阶段切分：MU2a（对话流核心）→ 合并 → MU2b（面板与外围），各一个 feature 分支。** 切法理由三条：
   - **价值密度**：审计 5 条硬差距 H1-H4 全在中栏对话流与权限卡（H5 才到右栏）；Markdown 渲染（H1）是「全局皮肤 = OpenMinis」的根基（审计结论 1），必须最先
   - **依赖方向**：令牌层（设计 v2 §3.1/§3.2）与统一组件语法（EventNote / 卡片皮肤 / 状态色槽）是 MU2b 各面板的公共地基——先令牌再面板，否则 MU2b 每个 Task 都要自带一份临时样式，合并即返工
   - **冲突面**：MU2a 唯一碰 minisd 的 Task（Task 9 权限白名单）做完即收口，MU2b 纯渲染端，与后续任何 minisd 侧工作（M3c 等）零冲突
   - 分支：`feature/mu2a`（11 Tasks）→ 复核合并 main → `feature/mu2b`（8 Tasks）→ 复核合并 main。两阶段可独立验收、独立回滚

2. **Markdown 引擎：renderer 内自研轻量解析（`src/renderer/src/lib/markdown/`），不引第三方 md 库。** 设计 v2 §5.1 已定调「自研轻量解析，对齐 OpenMinis MinisMarkdownParser 的 AST 思路，不引重型依赖」，本决策落实选型对比与体积代价：

   | 方案 | min 体积 | gzip | XSS 模型 | 结论 |
   |---|---|---|---|---|
   | **自研白名单解析（选）** | **<10KB（约 700 行 TS）** | ~3KB | **白名单 AST——解析器根本不产生 HTML 节点，注入不可能** | 选 |
   | marked + DOMPurify | ~97KB + ~63KB | ~54KB | 黑名单消毒——消毒剂漏一个向量就穿 | 弃 |
   | markdown-it + 消毒 | ~250KB+ | ~80KB+ | 同上，且 GFM 全量远超需求 | 弃 |

   理由四条：a) 跨端一致性硬约束（设计 v2 §6.1「Markdown 渲染能力同源」）——AST 思路对齐 [`OpenMinis/ios/Views/Chat/`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/ios/Views/Chat) 的 MarkdownRenderView 先例；b) 渲染范围是 GFM 小子集（§5.1 列 11 项：h2/h3、粗/斜/删、行内码、围栏、无序/有序列表、引用、链接、简单表格、分隔线——**无 HTML、无任务列表、无脚注**），自研可控；c) XSS 红线用白名单从根上满足（见 2c）；d) 零依赖、零供应链、体积可忽略。
   - **2b. 模块形态**：`lib/markdown/parse.ts`（`parseMarkdown(src: string): MdNode[]`，纯函数无 DOM）+ `lib/markdown/prefix.ts`（`stablePrefixEnd(src: string): number`，决策 3 的流式稳定前缀切分）+ `components/MarkdownView.vue`（AST → 模板递归渲染，文本一律 `{{ }}` 插值转义）。AST 节点类型闭集：`paragraph / heading(2|3) / bold / italic / strikethrough / inlineCode / codeBlock / ul / ol / li / blockquote / link / table / hr / text`。
   - **2c. XSS 消毒方案（红线，测试必配）**：① 输入中一切 HTML（块级/行内/注释/实体伪装）不解析，按纯文本转义输出；② `link` 节点 href 协议白名单 `http: / https: / mailto:`，其余（`javascript:` / `data:` / `vbscript:` / 实体编码绕过如 `&#106;avascript:` / 大小写混淆 / 前导空白控制符）一律降级为纯文本；③ 组件渲染禁 `v-html`（Global Constraints 已写死）。测试向量至少覆盖：`<script>`、`<img src=x onerror=…>`、`[a](javascript:alert(1))`、`[a](JaVaScRiPt:…)`、`[a](&#106;avascript:…)`、`[a](data:text/html,…)`、`<a href="…">`、HTML 注释、`---` 与 `<hr>` 混淆、未闭合围栏。
   - **2d. 语法高亮**：代码围栏只做语言名展示 + 复制（§2.3），**不做 token 级高亮**（§2.3「无语法高亮配色狂欢」；真要上也是后续里程碑独立决策）。

3. **流式渲染：稳定前缀 + 尾部重解析；词粒度淡入；滚动跟随可解除。** 设计 v2 §2.4/§5.1 落地：
   - **稳定前缀**：`stablePrefixEnd()` 找「最后完整块边界」——成对空行（`\n\n`）之后、且不在未闭合代码围栏内的最后一个偏移；`streamingText` 每次更新：稳定区 AST 缓存复用，只重解析尾部（等价 OpenMinis append-only fast path，避免 O(N²) 全量重解析）。围栏未闭合时尾部按纯文本兜底（围栏开始行也按文本显示，闭合后一整块翻正——与 OpenMinis 行为一致）。
   - **词粒度淡入（FadeText）**：`lib/fade/split.ts`（`diffWords(prev, next): { stable: string; added: { word: string; delay: number }[] }`，按词切分、交错 ≤0.08s 递增 delay，纯函数可测）；组件对新增词建 `<span>` 只做 opacity 0→1 transition（0.3s ease-out，§8 参数），不触发重排。`prefers-reduced-motion` 全局降级（§8：淡入全关，即时呈现）。
   - **滚动治理（治审计 X-2）**：ChatView 现状 [ChatView.vue](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/renderer/src/components/ChatView.vue#L79-L82) L79-82 是无条件贴底。改为：`lib/scroll/follow.ts` 纯函数 `shouldFollow(scrollTop, scrollHeight, clientHeight, prevFollowing): boolean`（用户上翻使 `scrollHeight - scrollTop - clientHeight > 40` 即解除跟随；回到底部 ≤40 恢复）；解除时右下浮「↓ 回到底部」圆钮（点击恢复 + 贴底）。

4. **minisd 权限侧改动白名单（MU2a Task 9 专属，写死；除此之外 minisd 零改动）：**
   - **a) 超时 30s → 90s**（审计 H2；设计 v2 §5.2-1）：[index.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) L46 `PERM_TIMEOUT_MS = 30000 → 90000`；[permissions.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/tools/permissions.ts) L65 `askTimeoutMs = 30000 → 90000` 默认值。两处必须同值（index.ts L45 既有注释约束：「与 PermissionGatewayImpl 的 askTimeoutMs 保持一致」）。`opts.permTimeoutMs` 覆盖路径不动（[rpc.test.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/tests/rpc.test.ts) L195 传 150、permissions.test.ts L88 传 50，均不受影响——已核实无测试断言默认值 30000）。
   - **b) `permission.request` 广播附加 meta**：index.ts L126-139 prompt 闭包内，广播体从 `{ requestId, req }` 扩为 `{ requestId, req, meta: { timeoutMs, riskClass, bridgeTriggers? } }`。`riskClass` = shell 时 `classifyShellCommand(req.detail)` 的结果（`'gated' | 'danger'`；danger 现状恒被网关硬拒不弹卡——M1 语义不动，字段带上供组件分级与将来档位化）；`bridgeTriggers` = 桥命令探测结果（新模块 `src/minisd/bridge/detect.ts`：`detectBridgeTriggers(command: string): BridgePermissionKind[]`——匹配 `MINIS_BRIDGE_CLI` + `windows-<tool>` + action 段，映射表与 [handlers.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/bridge/handlers.ts) L202-209 ROUTES 同款七路由；探测不到则字段省略）。**`PermissionRequest` 接口（[tools/types.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/tools/types.ts) L16）一行不动**——meta 只活在广播信封里。
   - **b') `permission.resolved` 广播附加 reason 字段**：index.ts L133 超时路径 `{ requestId }` → `{ requestId, reason: 'timeout' }`；L372 应答路径 → `{ requestId, reason: 'answered' }`（两处行号已核实）。纯增量字段——既有 rpc.test.ts 只断言 requestId 不回归；renderer 摘卡按 requestId 匹配不受影响。**必要性（评审命门 1）**：Task 10「超时留条」的判定源只能是 minisd 侧——renderer 自判 deadline（收到广播时刻+timeoutMs）恒晚于 minisd deadline 一个广播延迟，resolved 永远先到，没有 reason 字段留条就是永不触发的死码。
   - **c) 桥双段授权合并（治审计 H3）**：`permission.respond` 处理器在 `decision ∈ {allow-once, allow-session}` 且该 requestId 对应的请求带 `bridgeTriggers` 时，对每个触发的桥 kind 调网关新方法：`allow-session` → `gateway.grantBridgeSession(sessionId, kind)`（会话级按 kind 记忆）；`allow-once` → `gateway.grantBridgeOnce(sessionId, kind)`（一次性计数，桥 check 命中即消费 -1）。`PermissionGatewayImpl` 新增：`sessionBridgeGrants: Set<`${sessionId}\0${kind}`>`、`bridgeOnce: Map<`${sessionId}\0${kind}`, { count: number; grantedAt: number }>`、`grantBridgeSession()` / `grantBridgeOnce()` 两公开方法；`check()` 内在**既有 `sessionGrants` 精确 key 查找之后、`prompt` 之前**插两个查找层（先会话级按 kind，再一次性格式消费）。**一次性授权 TTL（评审命门 2）**：check 消费一次性层时校验 `now - grantedAt <= 120_000`，过期条目懒清理、不消费走 prompt——探测假阳性（命令含桥字样但未实际触发/命令提前失败）产生的悬挂授权，不得被会话内之后任意同 kind 桥调用静默消费；`now` 可注入（构造可选参数或方法级，实现时二选一并在 commit 说明），同 kind 多次 grant 的 grantedAt 以最后一次为准。**红线**：`classifyShellCommand` / DANGER 两表 / `DEFAULT_LEVELS` / danger 硬拒路径 / grantKey 精确记忆语义 / check 既有顺序语义全部不变；构造签名不变（permissions.test.ts 17 例全绿不动——例数已按现文件核实）；桥 kind 的 `bypass` / `notAllowed` 档位判定仍在新查找层之前（档位优先于合并授权）。
   - **d) 白名单以外 minisd 零改动**：`sync/**` / `store/**` / `agent/**` / `remote/**` / `rpc/**` / `providers/**` / `skills/**` / `bridge/**`（除新增 `bridge/detect.ts`）/ `terminal/**` / `files/**` / `src/shared/types.ts` 一律不碰；index.ts 只碰 L46 常量、L126-139 prompt 闭包、permission.respond 方法体、import 行——M3a/M3b 装配段（L106-112 PairingService 前移、syncMethods 段）不碰。

5. **渲染端测试基建：不引入 @vue/test-utils / jsdom / happy-dom，维持「纯模块单测 + 源文本守卫」双轨。** 理由三条：a) vitest 跑在 `ELECTRON_RUN_AS_NODE=1 electron` 下（better-sqlite3 ABI 硬约束），无 DOM 基座；引入 DOM 环境需新增两个 devDep 且与 electron-as-node 混杂有环境坑（全局 fetch/Buffer 语义差异），收益不成比例；b) 项目 55 个测试文件从无组件挂载先例（M1-M3b 全程纯模块 + 源文本守卫 + RPC 集成），MU2 不开新口子；c) 本计划把所有逻辑（markdown 解析/消毒、稳定前缀、词切分、滚动判定、diff LCS、倒计时计算、桥探测、配对码格式化）下沉 `lib/` 纯模块，node 直测覆盖比组件挂载更细。**每个渲染端 Task 的替代验收四件套（写进各 Task Step）**：① lib 纯模块单测（新行为必须 100% 走这里）；② 组件源文本守卫（接线锚点断言，renderer-files-panel.test.ts 先例）；③ `npm run typecheck` + `npm run build`；④ 阶段 e2e（决策 8）CDP 驱动真实应用 DOM 断言。组件内**不得**残留无法经这四件套验证的逻辑分支（发现即下沉 lib）。

6. **与 M3b 的冲突面自查（M3b 已合并 main@119f5f3，594 测试全绿）。** 文件级交集表：

   | MU2 触碰文件 | M3b 是否碰过 | 冲突面处理 |
   |---|---|---|
   | `src/renderer/**`（全部） | 否（M3b 纯 minisd） | 零交集 |
   | `src/minisd/index.ts` | 是（PairingService 前移 L106-112、syncMethods 装配） | MU2a Task 9 只碰 L46 常量 / L126-139 prompt 闭包 / permission.respond 方法体 / import 行；装配段不碰（决策 4d） |
   | `src/minisd/tools/permissions.ts` | 否 | Task 9 白名单内 |
   | `src/minisd/bridge/detect.ts`（新建） | 否（bridge/ 目录 M3b 未碰） | 零交集 |
   | `src/shared/types.ts` | 是（Wire* 类型） | **MU2 一律不碰** |
   | `stores/chat.ts` | 否（M3b 未接线 renderer；同步字段 §7.2/§7.3 属 M3c） | MU2 增量改（meta 消费 / pendingPerms 扩字段 / 配对管理 actions），M2c/M2d 既有字段与 actions 原样保留（源文本守卫兜底） |

   每个 Task 的 Step 3 全量测试即冲突面回归闸；Task 9 额外跑 `npm run e2e:m3a`（权限信道相关）做实证。

7. **令牌层演进：tokens.css 只追加、不改既有值；组件尺度迁移就近映射。** 设计 v2 §3 落地：
   - **追加**（`:root` 一段，尺度与主题无关只写一次；语义色槽浅/暗/双 data-theme 各一份）：§3.1 尺度令牌（`--fs-display/title/body/ui/caption/mono/micro`、`--sp-1..8`、`--ico-s/m/l`、`--h-control/h-input`）；§3.2 语义槽（`--surface-0/1/2`、`--action`、`--state-ok/err/warn/info` + 三模式各调的 `--state-*-bg/border` color-mix 比例槽）；工具类型色退役（`--tool-shell/doc/edit/plan/brain` 全部映射回 `var(--label-secondary)`，保留变量名兼容——ToolPill 引用处随 Task 6 删除）。
   - **不改**：既有色板（iOS 语义色、`--brand`/`--accent`/`--link` 值、媒体查询与 data-theme 结构）——OpenMinis 皮肤同源，改了破坏跨端一致性（设计 v2 §0 全球皮肤归属）。
   - **组件尺度映射**（审计 V-1）：ChatView 正文 16.5→`--fs-body`(14)、助手名 17→`--fs-title`(15)、工具/辅助 13→`--fs-ui`、12/12.5→`--fs-caption`/`--fs-mono`；**brand 降权**（审计 V-2 + §3.2）：新建会话按钮 `--brand` 实底 → `--action` 或中性 `--fill` 底；`--brand` 只留头像渐变/装饰。
   - 迁移集中 MU2a Task 4 一次做完（中栏 + 全局 tokens），MU2b 新组件直接用令牌，不再回流改 tokens.css。

8. **e2e 基建：CDP 驱动真实 dev 实例，假 provider 脚本化造场景。** 新增 `scripts/e2e-mu2a-acceptance.mjs` / `scripts/e2e-mu2b-acceptance.mjs`（package.json 追加 `e2e:mu2a` / `e2e:mu2b`，既有 7 条 e2e scripts 保留）：
   - **启动**：spawn `electron-vite dev -- --remote-debugging-port=9222`（MU1 审计已实证该链路可用——[cdp-eval.mjs](file:///c:/Users/24739/Downloads/openminis1/docs/specs/audit-shots/cdp-eval.mjs) 连 `127.0.0.1:9222` 拿 localhost:5173 page 求值）。**实现期第一验证点**：electron-vite 4 对 `--` 后参数的 electron 透传行为在 e2e 脚本第一步断言（轮询 `http://127.0.0.1:9222/json` 60s 超时即失败并打印排查指引）；若透传失效，回退方案 = 脚本内先 `electron-vite build` 再 spawn `electron out/main/index.js --remote-debugging-port=9222`（file:// 加载，page 匹配条件放宽为 `type === 'page'`）——两案都写在脚本注释里，落地其一。
   - **环境**：`DESKMINIS_DATA_DIR` 指向 `mkdtemp` 临时目录 + `DESKMINIS_TEST=1`（内存 vault）+ `DESKMINIS_FAKE_PROVIDER=1`（假 provider：`__tool__` 脚本化工具调用 / `__fail__` 触发 fallback——权限卡、工具行、事件条、错误治理全部可脚本化造出，零真网）。
   - **断言**：内联 eval helper（复制 cdp-eval.mjs 的 `Runtime.evaluate` 模式），DOM 查询断言（存在性/文本/类名/样式计算值）；截图留证 `scripts/e2e-shots-mu2{x}/`（复用 cdp-shot.mjs 的 `Page.captureScreenshot` 模式）。
   - **收尾**：kill 进程树（Windows `taskkill /pid /T /F`），临时数据目录删除；脚本退出码非零即失败。
   - e2e 不跑在 `npm test` 里（与既有 e2e 一致，验收时手动执行）。

---

# MU2a · 对话流核心（feature/mu2a，11 Tasks）

> 顺序即依赖序：T1 引擎 → T2 接线 → T3 流式 → T4 令牌（中栏内容齐了之后做尺度，避免来回）→ T5 回合 → T6 工具行 → T7 diff → T8 事件条 → T9 minisd 权限 → T10 权限卡 v2 → T11 e2e 收官。每 Task 五 Step（红 → 绿 → 单测+全量 → typecheck+build → checkbox+commit）。

## Task 1：Markdown 解析引擎（lib/markdown，纯模块）——审计 H1 · 设计 §5.1 · 决策 2

**目标**：交付 `parseMarkdown()` + `stablePrefixEnd()` 两个纯函数与全部消毒测试，不碰任何组件。

- [x] **Step 1（红）**：新建 `tests/markdown-parse.test.ts`：
  - 块级：h2/h3（`##`/`###`，h1 降级 h2——§2.3 标题层级 ≤3）、段落、围栏（带语言名 / 无语言名 / 未闭合→纯文本兜底）、ul/ol（含 2 级嵌套缩进）、引用块（可含列表）、hr（`---`/`***`）、简单表格（表头 + 分隔行 + 数据行；缺分隔行按段落）
  - 行内：粗 `**x**`、斜 `*x*`、删 `~~x~~`、行内码 `` `x` ``（内容不二次解析）、链接 `[t](https://…)`、嵌套（**粗中斜**、行内码内 `**` 不解析）、纯文本
  - 混合：「段落 + 围栏 + 列表」组合文档断言 AST 逐节点
  - `\r\n` 归一化、空串、纯空白、无尾换行
- [x] **Step 2（红）**：新建 `tests/markdown-xss.test.ts`（决策 2c 红线）：
  - `<script>alert(1)</script>` → 输出无 script 节点，文本转义
  - `<img src=x onerror=alert(1)>` / `<a href="https://x">t</a>` / `<!-- c -->` → 全部纯文本
  - `[x](javascript:alert(1))` / `[x](JaVaScRiPt:alert(1))` / `[x]( javascript:alert(1))` / `[x](&#106;avascript:alert(1))` / `[x](data:text/html,<script>…)` / `[x](vbscript:…)` → link 节点不生成，按纯文本
  - `[ok](https://a.b/c?d=e)` / `[ok](mailto:a@b.c)` → link 节点保留 href
  - AST 序列化不含任何 `html` / `rawHtml` 类型字段（白名单闭集断言：节点 type ∈ 决策 2b 枚举）
- [x] **Step 3（红）**：新建 `tests/markdown-prefix.test.ts`：`stablePrefixEnd()`——空行成对处切 / 未闭合围栏内不切（返回围栏开始前的边界）/ 全文无空行返回 0 / 尾部就是边界时幂等 / `\r\n` 文档
- [x] **Step 4（绿）**：实现 `src/renderer/src/lib/markdown/parse.ts` + `prefix.ts`（约 700 行；tokenizer 按行扫描 → 块级 AST → 行内递归；零依赖零 DOM）。跑三个测试文件全绿 + `npm test` 594+ 不回归
- [x] **Step 5**：`npm run typecheck`；checkbox 勾选；commit `feat(mu2a): Markdown 解析引擎（白名单 AST + XSS 消毒 + 稳定前缀，纯模块零依赖）`

测试估算：+35 例（parse 18 / xss 12 / prefix 5）。

## Task 2：MarkdownView 组件 + 对话流接线——审计 H1 · 设计 §2.1/§2.3/§5.1

**目标**：助手历史正文与流式文本全量走 Markdown 渲染；代码围栏带语言槽 + 复制键；流式走稳定前缀缓存。

- [x] **Step 1（红）**：新建 `tests/renderer-markdown-view.test.ts`（源文本守卫）：
  - `MarkdownView.vue`：props `{ nodes: MdNode[] }`；模板递归渲染各节点类型；**全文无 `v-html`**（守卫 `expect(src).not.toContain('v-html')`）；围栏块含语言名槽 + 复制按钮（`Icon name="copy"`）；链接 `target="_blank" rel="noopener"`；表格/引用/列表/行内码类名锚点
  - `lib/markdown/cache.ts`（新）：`MarkdownCache` 类——`update(text): { stableNodes: MdNode[]; tailNodes: MdNode[] }`，稳定前缀 AST 缓存、尾部重解析（纯模块，node 直测：连续 append 三次断言 parseMarkdown 只被调用于尾部区间——用 vi.spyOn 计数）
- [x] **Step 2（绿）**：实现 `MarkdownView.vue` + `cache.ts`；[ChatView.vue](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/renderer/src/components/ChatView.vue) 两处增量替换：L136 历史 `class="atext"` 插值 → `<MarkdownView :nodes="…">`（每消息一 cache 实例，computed）；L155 流式 `{{ chat.streamingText }}` → `<MarkdownView :nodes="streamNodes">`（`MarkdownCache.update` 驱动）。用户消息 L129 不动（§5.1：用户消息不渲染 Markdown，纯文本 pre-wrap 保留）。`.atext` 样式类让位给 MarkdownView 内部排版（§2.3：正文 14px/1.6 在 Task 4 统一迁移，本 Task 先保视觉等价）
- [x] **Step 3**：`npm test -- tests/markdown-parse.test.ts tests/markdown-xss.test.ts tests/renderer-markdown-view.test.ts` 绿；`npm test` 全量不回归（[renderer-files-panel.test.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/tests/renderer-files-panel.test.ts) L55-60 三锚 `useChat`/`activeId`/`messages` 仍在）
- [x] **Step 4**：`npm run typecheck` + `npm run build`；手工 `npm run dev` 目视：假 provider 回合 + 含围栏/列表/表格的助手文本渲染正确
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2a): MarkdownView 组件接线对话流（历史+流式稳定前缀缓存，围栏语言槽+复制）`

测试估算：+8 例（守卫 5 / cache 3）。

## Task 3：流式淡入（FadeText）+ 滚动跟随治理——审计 X-1/X-2 · 设计 §2.4/§8 · 决策 3

**目标**：流式文本词粒度淡入；上翻解除跟随 + 「回到底部」浮钮。

- [x] **Step 1（红）**：新建 `tests/fade-scroll.test.ts`（纯模块）：
  - `lib/fade/split.ts` `diffWords(prev, next)`：prev 是 next 前缀 → added 词列 + 交错 delay（≤0.08s 递增）；prev 非前缀（流式重置）→ 整体重来；空 prev；词切分按空白 + 保留换行；CJK 连续字符按字粒度
  - `lib/scroll/follow.ts` `shouldFollow()`：距底 ≤40 → true；>40 且 prev=true → false（解除）；解除后回到底部 → true；prev=false 且仍 >40 → false（不抢回）
- [x] **Step 2（红）**：源文本守卫（并入 `tests/renderer-markdown-view.test.ts` 或新 `tests/renderer-chat-stream.test.ts`）：`FadeText.vue` 存在且 props `{ text: string }`；对 added 词渲染 `<span class="fade-word" :style="{ animationDelay }">`；`@media (prefers-reduced-motion: reduce)` 下无 transition（样式锚）；ChatView 含 `shouldFollow(` 调用 + 「回到底部」按钮锚 + 滚动事件绑定；L79-82 旧的无条件 `scrollTop = scrollHeight` watch 已移除（守卫 `not.toContain` 旧形态需按实现措辞调整，落地时核实）
- [x] **Step 3（绿）**：实现 `FadeText.vue`（watch text → diffWords → 追加 span；reduced-motion 直接整段更新）+ ChatView 滚动接线（scroll 监听更新 following ref；流式/消息 watch 仅在 following 时贴底；浮钮点击恢复）。流式区 `MarkdownView` 与 `FadeText` 的关系：淡入作用于**流式尾部纯文本段**（围栏未闭合尾巴），稳定区 Markdown 直接呈现不做淡入（块级结构淡入会闪）——与设计 §2.4「文本增量按词粒度淡入」一致（增量=textDelta，落在尾部）
- [x] **Step 4**：单文件 + 全量绿；typecheck + build；dev 手工：假 provider 流式中上翻 → 不被拽回；点浮钮 → 回底恢复跟随
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2a): 流式词粒度淡入 + 滚动跟随治理（上翻解除/回到底部浮钮/reduced-motion 降级）`

测试估算：+9 例（split 5 / follow 4 / 守卫随 Task 2 文件内 +3 计入 Task 2 估算，不重复计）。

## Task 4：令牌层演进（tokens.css §3.1/§3.2）+ 中栏密度迁移——审计 V-1/V-2/V-5 · 设计 §3 · 决策 7

**目标**：尺度令牌与语义色槽落地；中栏组件（ChatView/MarkdownView/PermissionCard 暂不含——Task 10 重写时直接吃令牌/ToolPill 暂留 Task 6）尺度迁移；brand 降权。

- [x] **Step 1（红）**：新建 `tests/tokens-evolution.test.ts`（源文本守卫）：
  - tokens.css 追加段含 §3.1 全部尺度令牌名（`--fs-body`/`--fs-ui`/`--fs-caption`/`--fs-mono`/`--fs-micro`/`--fs-title`/`--fs-display`/`--sp-1`/`--sp-8`/`--ico-s`/`--h-control`/`--h-input`）与 §3.2 语义槽（`--surface-0/1/2`、`--action`、`--state-ok/err/warn/info`、`--state-warn-bg` 类 color-mix 比例槽）
  - 语义槽浅/暗/双 data-theme 四段各有一份（守卫四段选择器内均含 `--surface-1`）
  - 既有色值不回归：`--accent: #3686EE`（浅）与 `--accent: #5490E4`（暗）等 6 组抽样断言原值仍在
  - ChatView.vue：`16.5px` 不再出现（`not.toContain('16.5px')`）；`--fs-body` 出现；`.aname` 用 `--fs-title`
  - SessionList.vue 新建按钮不再以 `--brand` 为底（改 `--action` 或 `--fill`；守卫 `newbtn` 块无 `var(--brand)`）
  - evnote 三处 `color-mix(in srgb, var(--orange) 10%` 等写死比例 → 收进 `--state-warn-bg`/`--state-warn-border` 等槽（ChatView 内不再出现写死百分比的 color-mix——Task 8 重写 EventNote 时最终清零，本 Task 先把槽位立起来并迁移 evnote）
- [x] **Step 2（绿）**：tokens.css 追加（决策 7：只追加不改值）；ChatView / MarkdownView / SessionList（新建按钮色权）尺度迁移；evnote color-mix 比例迁槽
- [x] **Step 3**：单文件 + 全量绿；renderer-files-panel / renderer-tasks-panel 守卫不回归
- [x] **Step 4**：typecheck + build；dev 三模式目视（跟随系统/强制浅/强制深）：密度明显下降、evnote 三色在暗色下不糊
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2a): 令牌层尺度与语义槽落地 + 中栏密度迁移 + brand 降权`

测试估算：+8 例。

## Task 5：回合结构 + 用户消息标签行 + hover 复制——审计 X-3 · 设计 §2.1

**目标**：用户消息从右侧灰气泡改为无气泡标签行「你 · HH:MM」+ hover 复制；助手块去名称行改回合容器；回合间分隔线 + 间距。

- [x] **Step 1（红）**：新建 `tests/renderer-turn.test.ts`（守卫 + 纯模块）：
  - `lib/time/hhmm.ts`：`fmtHHMM(epochSec): string`（消息 createdAt → 「HH:MM」；epoch 秒入参，纯函数）
  - ChatView.vue：用户消息块含 `你 ·` 标签行锚 + hover 才显示的复制钮（`class="uops"`/`title="复制"` 锚）；不再含 `.msg-u` 右对齐气泡样式（守卫 `justify-content: flex-end` 从 msg-u 移除；`--r-bubble` 在用户消息上不再引用）
  - 助手块：`.ahead`（DeskMinis 名称行）从**历史**助手消息移除（保留实时块的极简态或同去——落地时按设计 §2.1 回合容器实现，守卫以最终形态为准）；回合容器 `.turn` 分隔线样式锚（`border-top` + `--sp-6` 间距）
  - 复制实现走 `navigator.clipboard.writeText`（守卫调用点）
- [x] **Step 2（绿）**：实现（ChatView 模板重排为用户标签行 + 助手回合容器；复制钮组件内联；`fmtHHMM` 接线）
- [x] **Step 3**：单文件 + 全量绿（files-panel 三锚存活）
- [x] **Step 4**：typecheck + build；dev 目视：用户消息左对齐无气泡、hover 出复制、复制内容正确
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2a): 回合结构 + 用户消息标签行（无气泡/hover 复制）`

测试估算：+6 例。

## Task 6：工具行 ToolLine（ToolPill 重做）——审计 V-5/X-4 形态部分 · 设计 §2.2

**目标**：ToolPill 36px 彩色胶囊 → 32px 单行工具行：状态符号（✓绿/✕红/⠿执行中）+ 人话标题 + 耗时 mono 右置 + 展开 chevron；类型色五色退役；连续 3+ 同类型成组折叠；展开区参数/输出 mono 内滚（file_edit 展开区留给 Task 7 换 DiffView）。

- [x] **Step 1（红）**：新建 `tests/renderer-toolline.test.ts`：
  - 纯模块 `lib/toolline/group.ts`：`groupToolCards(cards): (ToolCard | ToolGroup)[]`——连续 ≥3 个同 name 卡片成组（`{ kind: 'group'; name; count; items }`），组边界被异名打断；不足 3 不成组；空数组
  - `lib/toolline/duration.ts`：`fmtDuration(startTs, endTs): string`（`0.3s` / `1m02s`；纯函数）
  - 守卫 `ToolLine.vue`：props `{ name; title; state: 'running'|'ok'|'fail'; duration?; input?; output? }`；单行 32px 锚（`--h-control`）；状态符号三态；chevron 展开；展开区 `max-height: 240px` 内滚；**五色类型色不出现**（`not.toContain('--tool-')`）
  - 守卫 ChatView.vue：ToolPill import 移除、ToolLine import 存在；`groupToolCards(` 调用点
  - 守卫 `ToolPill.vue` 已删除（`existsSync === false`）——其引用随本 Task 全部切走
- [x] **Step 2（绿）**：实现 `ToolLine.vue`（执行中 CSS 旋转圆环 14px，§2.2 shimmer 取消）+ `group.ts`/`duration.ts` + ChatView 接线（历史 ToolPill 处 → ToolLine 按 parts 渲染；实时 `chat.toolCards` → groupToolCards 分组渲染）；删除 ToolPill.vue；`Icon.vue` 追加 `chevron-down` / `chevron-right`（只追加）
- [x] **Step 3**：单文件 + 全量绿
- [x] **Step 4**：typecheck + build；dev 目视：假 provider `__tool__` 三连发同工具 → 成组「执行 3 个 … [›]」
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2a): 工具行 ToolLine 替换 ToolPill（单行折叠/状态符号/类型色退役/同型成组）`

测试估算：+10 例（group 5 / duration 2 / 守卫 3）。

## Task 7：diff 视图（file_edit 展开区）——审计 X-4 · 设计 §5.4

**目标**：file_edit 工具的展开区从裸 JSON → 文件头槽（相对路径 mono + `+N/−M` 徽标）+ 行级 diff（行号 / +绿 −红 / 上下文 2 行折叠「⋯ 收起 N 行」）；纯前端 LCS，零后端改动。

- [x] **Step 1（红）**：新建 `tests/diff.test.ts`（纯模块 `lib/diff/lcs.ts`）：
  - `diffLines(oldStr, newStr): DiffLine[]`（`{ type: 'ctx'|'add'|'del'; text: string; oldNo?: number; newNo?: number }`）：同文件 → 全 ctx；纯插入；纯删除；中段替换；多空行块
  - `collapseCtx(lines, keep=2): (DiffLine | { type: 'fold'; count: number })[]`——上下文 >2*keep 折叠中间；边界不足不折
  - `countAddDel(lines): { add: number; del: number }`
  - `\r\n` 归一；old/new 为空串（新建/清空）；超 2000 行降级为「整段替换」标记（性能闸）
  - file_edit 载荷提取 `lib/diff/payload.ts`：`extractEditPair(inputJson): { path: string; oldStr: string; newStr: string } | null`——从工具 input JSON 取 path/old_string/new_string（缺字段 → null 回落 JSON 展开）；**相对路径化**（数据根前缀剥掉，守卫不含数据根）
- [x] **Step 2（红→绿）**：守卫 `DiffView.vue`（props `{ path; addCount; delCount; lines }`；文件头槽 + 行列表 + 折叠行锚）+ ToolLine 展开区在 `name === 'file_edit'` 且 `extractEditPair` 命中时渲染 DiffView（否则原参数/输出区）；diff 红绿底走 `--state-ok-bg`/`--state-err-bg` 槽（Task 4 已立，暗色 alpha 12% 三模式各调——守卫在 tokens.css 四段）
- [x] **Step 3**：单文件 + 全量绿
- [x] **Step 4**：typecheck + build；dev 目视：假 provider file_edit → 展开见红绿行与 +N/−M
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2a): file_edit diff 视图（LCS 行级/上下文折叠/增删徽标，纯前端）`

测试估算：+14 例（lcs 8 / payload 3 / 守卫 3）。

## Task 8：EventNote 统一事件条 + 错误治理——审计 H4/X-5 · 设计 §5.3/§4.2/§1.3

**目标**：retry/fallback/compacted/offloaded/error 五类一套组件 `[图标] 短句 · 详情[›]`；errbar 红色横幅退场，error 进对话流内联（短句 + 详情折叠 + 重试钮）；retry 橙字行并入 EventNote。

- [x] **Step 1（红）**：新建 `tests/renderer-eventnote.test.ts`：
  - 纯模块 `lib/eventnote/copy.ts`：`eventCopy(kind, detail): { icon; short; tone }`——五类短句映射（fallback「已切换到备选模型」/ compacted「上下文已压缩」/ offloaded「大段输出已存入文件」/ retry「网络波动，正在重试」/ error 从原始 message 提炼一句人话：`humanizeError(msg)` 剥 HTTP 状态码 → 「模型服务暂时不可用（503）」类；剥不出 → 截断 80 字）；`humanizeError` 对 401/403 → 「API Key 无效或过期」、429 → 「请求过频或额度不足」、5xx → 「模型服务暂时不可用（xxx）」、`fetch failed`/ENOTFOUND → 「网络连接失败」
  - 守卫 `EventNote.vue`：props `{ kind; icon; short; detail?; retryable? }`；详情 `<details>` 或等价折叠锚；retryable 时「重试」按钮锚；色走 `--state-*-bg/border` 槽（无写死 color-mix 百分比）
  - 守卫 ChatView.vue：`.errbar` / `.eclose` 移除（`not.toContain`）；`retry` 行移除；五类统一 `<EventNote`；error 的「重试」调 `chat.send` 重发上一条用户消息（store 新增 `retryLast()`——守卫 chat.ts 含该方法）
  - 守卫 chat.ts：`lastError` 字段保留（TasksPanel 等仍引用）但对话流不再渲染 errbar；`eventNotes` kind 联合类型扩 `'retry' | 'error'`
  - 守卫 store 事件接线：retryNote 流转为 eventNotes 一条（kind retry）；error 事件（loop.ts L22 `{ kind: 'error'; message }`）入 eventNotes（kind error + retryable: true）——M2d 已有 retryNote 字段保留（TasksPanel L98 引用），双写过渡期在 MU2b Task 2 收口
- [x] **Step 2（绿）**：实现 `copy.ts` + `EventNote.vue` + ChatView/store 接线（`retryLast()`：取最后一条非结果载体用户消息重发；无 → 按钮不出现）
- [x] **Step 3**：单文件 + 全量绿
- [x] **Step 4**：typecheck + build；dev 目视：假 provider `__fail__ 429` → 内联 error 条「请求过频或额度不足 · 详情[›] [重试]」；点重试 → 重发成功
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2a): EventNote 五类事件统一语法 + 错误治理（短句/详情折叠/重试）`

测试估算：+10 例（copy/humanize 6 / 守卫 4）。

## Task 9：minisd 权限侧白名单（90s / 广播 meta / 桥合并授权）——审计 H2/H3 后端准备 · 决策 4（红线 Task）

**目标**：决策 4 的 a/b/c 三点落地；白名单以外 minisd 零改动。**本 Task 红线重申**：只碰 index.ts L46 常量 / L126-139 prompt 闭包 / permission.respond 方法体 / import 行；permissions.ts 的 L65 默认值 + 新增两集合两方法与 check 内两查找层；新建 `bridge/detect.ts`。其余 minisd 文件（含 `bridge/handlers.ts` 本体、`tools/types.ts`、`shared/types.ts`、M3a/M3b 全部落地点）一行不动。

- [x] **Step 1（红）**：`tests/bridge-detect.test.ts`（新模块）：
  - `detectBridgeTriggers()`：`& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" windows-screenshot capture` → `['bridge-screenshot']`；`node "$env:MINIS_BRIDGE_CLI" windows-notify show --title x` → `['bridge-notify']`；`windows-clipboard get` → `['bridge-clipboard-read']`；`windows-clipboard set --text x` → `['bridge-clipboard-write']`；device info → `['bridge-device']`；open/speak 两例；一条命令两段桥调用（`;` 连接）→ 两 kind 都出；非桥命令（`Get-ChildItem`）→ `[]`；无 action 段 → `[]`；大小写不敏感
- [x] **Step 2（红）**：`tests/permissions-bridge-merge.test.ts`：
  - `grantBridgeSession` 后同 sessionId 同桥 kind `check` → allow 且 prompt 未再被调（计数断言）；异 sessionId → 仍 prompt
  - `grantBridgeOnce` 后第一次 check → allow 且消费（第二次再 check → prompt 被调）；计数只减不增
  - 档位优先：`bridge-device`（bypass）不受合并授权影响仍直行；构造时 levels 覆盖某桥 kind 为 notAllowed → 合并授权不复活（notAllowed 判定在新查找层之前）
  - 既有 `sessionGrants` 精确 key 语义不回归（同 kind 异 detail 不静默——桥 kind 的会话合并是**新层**，精确层行为不变）
  - `grantBridgeOnce` TTL（决策 4c 评审命门 2）：grant 后 `now - grantedAt > 120_000` 再 check → 不消费、条目懒清理、走 prompt（测试用可注入 now 或短 TTL 构造参数——实现时二选一并在 commit 说明）
  - 同 kind 二次 allow-once 累积（count=2）后整体过期 → 一并失效不残留（grantedAt 以最后一次 grant 为准）
  - permissions.test.ts 既有 17 例全绿（构造签名与 check 主流程未变）
- [x] **Step 3（红）**：`tests/rpc.test.ts` 追加用例（同文件内增量，遵守该文件既有 boot/rpcClient 模式）：
  - `permission.request` 广播含 `meta.timeoutMs === 90000`（boot 不传 permTimeoutMs 的默认路径）；shell 命令请求含 `meta.riskClass === 'gated'`；桥命令请求含 `meta.bridgeTriggers` 深等于期望数组
  - `permission.resolved` 广播含 reason（决策 4b' 评审命门 1）：`permTimeoutMs: 150` 短超时路径 → 收到 `{ requestId, reason: 'timeout' }`（新增独立用例）；permission.respond 应答路径 → `{ requestId, reason: 'answered' }`（断言并入既有 respond 用例）
  - permission.respond `allow-session` + bridgeTriggers → 之后同桥 kind 的第二次请求**不再广播** permission.request（直接放行——端到端验证合并授权过 RPC 面）
  - `permTimeoutMs: 150` 覆盖路径不回归（既有 L195 用例）
- [x] **Step 4（绿）**：实现 `bridge/detect.ts`；permissions.ts 三点增量（L65 默认 90000 + 两集合两方法 + check 内两查找层——一次性层带 120s TTL 懒清理，决策 4c）；index.ts 五点增量（L46 → 90000；prompt 闭包广播体加 meta——`bridgeTriggers` 仅 shell kind 且探测非空时附加；L133 超时 resolved 加 `reason: 'timeout'` + L372 应答 resolved 加 `reason: 'answered'`（决策 4b'）；permission.respond 处理器在 allow-* 且带 bridgeTriggers 时逐 kind 调 grant 方法——需把 requestId → {sessionId, bridgeTriggers} 暂存进 pendingPerms 条目，resolved 后清理；import detect/classifyShellCommand）
- [x] **Step 5**：`npm test` 全量绿；`npm run typecheck`；`npm run e2e:m3a` 实证不回归（决策 6）；checkbox 勾选；commit `feat(mu2a): 权限侧白名单（90s 超时/广播 meta 超时与桥触发/桥双段合并授权）`

测试估算：+18 例（detect 6 / merge 8 / rpc 4）。

## Task 10：权限卡 v2（倒计时 / 分级文案 / 七类 kind / 双段告知）——审计 H2/H3/X-7 · 设计 §5.2

**目标**：PermissionCard 重写：右上 mono 倒计时（≤10s 变橙）；danger 红盾 / gated 橙盾分级；桥七类专属标题；shell 卡识别桥命令时卡内列出「此命令将触发：xx 权限」双段告知；按钮序「允许（--action 实底）/ 本会话允许 / 拒绝（文本）」；预选 2px `--action` 边框。

- [x] **Step 1（红）**：新建 `tests/renderer-permcard.test.ts`：
  - 纯模块 `lib/perm/copy.ts`：`permTitle(kind): string` 七类桥映射——bridge-notify「请求发送通知」/ bridge-clipboard-read「请求读取剪贴板」/ bridge-clipboard-write「请求写入剪贴板」/ bridge-open「请求打开链接或文件」/ bridge-speak「请求语音播报」/ bridge-screenshot「请求截屏」/ bridge-device「请求读取设备信息」；shell「请求执行命令」/ file-write「请求写入文件」/ file-read「请求读取文件」（既有三类文案保留）；未知 kind → 「请求权限」（default 保留兜底）
  - `lib/perm/countdown.ts`：`remainSeconds(deadlineMs, nowMs): number`（ceil、 clamp ≥0）；`countdownTone(remain): 'normal'|'urgent'`（≤10 → urgent）
  - 守卫 PermissionCard.vue：倒计时读秒锚（`remain` + `--font-mono`）；urgent 类锚（`--state-warn`）；盾牌分色（danger `--state-err` / 其余 `--state-warn`）；七类标题经 `permTitle(`；双段告知块锚（`此命令将触发` + 触发项列表，仅在 `bridgeTriggers?.length` 时渲染）；按钮三枚且「允许」主钮 `--action` 实底锚；`.pre` 用 2px `--action` 边框
  - 守卫 chat.ts：`PendingPerm` 扩字段（`timeoutMs?: number; riskClass?: string; bridgeTriggers?: string[]`）；`permission.request` 处理器把 `params.meta` 并入 pendingPerms 条目；`deadlineMs = Date.now() + timeoutMs` 在 push 时计算
  - 守卫 PermissionCard 对超时移除的兜底：`permission.resolved` 到达即摘卡（既有行为，断言引用未删）
  - 守卫超时留条（设计 §5.2-1「超时 deny 在对话流留『已超时拒绝』事件条」）：`permission.resolved` 且 `reason === 'timeout'` → 摘卡 + `eventNotes` 追加 `{ kind: 'error', detail: '权限请求已超时，自动拒绝' }`（retryable: false）；`reason === 'answered'`（或无 reason 的旧广播）→ 只摘卡不补条。判定源是 minisd 广播 reason（决策 4b'），**renderer 不做 deadline 自判**——倒计时纯作 UI 显示，不承担判定（renderer deadline 恒晚于 minisd 一个广播延迟，自判永不触发，评审命门 1）
- [x] **Step 2（绿）**：实现 `copy.ts`/`countdown.ts` + PermissionCard 重写（setInterval 1s 驱动 remain；unmount 清定时器；preselect 逻辑保留——permTier 映射不变）+ chat.ts 增量（M2c/M2d 字段全保留，只扩 PendingPerm 与处理器；`permission.resolved` 处理器按 `reason` 分流——timeout → 摘卡 + 超时留条，answered/无 reason → 只摘卡）
- [x] **Step 3**：单文件 + 全量绿
- [x] **Step 4**：typecheck + build；dev 手工（假 provider `__tool__` 触发 file_write 卡 + 桥命令卡）：读秒跳动、≤10s 变橙、桥命令卡含触发列表、批准一次后桥不再弹卡（Task 9 合并授权端到端）
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2a): 权限卡 v2（倒计时可视/风险分级/桥七类文案/双段授权一卡告知）`

测试估算：+12 例（copy 8 / countdown 2 / 超时留条 2——守卫并入计数）。

## Task 11：MU2a e2e 验收（CDP 驱动）+ 阶段收官

**目标**：`scripts/e2e-mu2a-acceptance.mjs` 落地，决策 8 全链路实证；阶段 DoD 收口。

- [x] **Step 1**：写 e2e 脚本（决策 8：dev + 9222 透传验证点 / 临时数据目录 / FAKE_PROVIDER / eval helper / taskkill 收尾）。验收用例：
  1. 渲染进程就绪，无 console error（`Runtime.evaluate` 采集）
  2. 假 provider 回合：助手 Markdown 渲染——DOM 存在 `h2`/`code` 围栏语言槽/列表元素（发送预置 markdown 文本的脚本化回复——FakeProvider 目前只回「（假回复）」，e2e 内改为直接调 `chat.messages.list` 不可行；**落地方案**：e2e 用 CDP 直接在渲染进程执行 store 操作不可行（隔离），改用真实路径：先通过渲染进程输入框 DOM 填 `__tool__ file_write …` 触发工具卡，再断言 ToolLine 存在；Markdown 断言改用手工验收步骤——**或**在 e2e 脚本里预置：`DESKMINIS_FAKE_PROVIDER` 的假回复文本不可配置，本 Task 给 FakeProvider 加一个 env 钩子 `DESKMINIS_FAKE_REPLY`（<200 字 markdown 样本，**这是 minisd 白名单外的一行增量——列入本 Task 红线例外**：仅 index.ts FakeProvider 类内 `yield { kind: 'textDelta', text: … }` 的文本源从 env 读，默认不变；既不影响生产路径也不影响既有测试）。选后者，写进 commit 说明）
  3. `__tool__ file_write`（数据根外路径）→ 权限卡出现；断言倒计时文本存在；DOM 点「允许」→ 卡消失、ToolLine 出现
  4. 桥命令卡（`__tool__ shell_execute` 带 MINIS_BRIDGE_CLI windows-notify show）→ 断言双段告知块文本；「本会话允许」→ 二次桥命令不再弹卡
  5. `__fail__ 429` → EventNote error 条含「请求过频或额度不足」与重试钮；点重试 → 回合成功
  6. 流式期间上翻（`scrollTop = 0`）→ 新 delta 后 scrollTop 未被拽回底部；点「回到底部」→ 恢复
  7. 三模式截图各一（`data-theme` 切换 + `Page.captureScreenshot` 存 `scripts/e2e-shots-mu2a/`）
- [x] **Step 2**：跑通 e2e 7/7；`npm test` 全量绿（实际 **741/741** · 69 文件）；typecheck + build
- [x] **Step 3**：MU2a 计划文档 checkbox 全勾；手工验收清单（Markdown 各节点目视 / 淡入 / 滚动 / 密度 / 三模式）逐项过（三模式截图 scripts/e2e-shots-mu2a/ 已目视复核；全量手工目视留复核方）
- [x] **Step 4**：commit `test(mu2a): e2e 验收驱动（CDP 7 用例 + 三模式截图）`；feature/mu2a 交复核 → 合并 main

测试估算：+0（e2e 不进 npm test；FakeProvider env 钩子随 rpc 测试文件 +2 例：env 设置时回复定制文本 / 未设置时原文不变）。

---

# MU2b · 面板与外围（feature/mu2b，8 Tasks）

> 前置：MU2a 已合并 main（令牌层/EventNote/权限卡 v2 可用）。顺序即依赖序：T1 右栏骨架 → T2 进度 → T3 产物 → T4 左栏 → T5 设置模态+标题栏 → T6 空状态+Composer → T7 配对管理 → T8 e2e+三模式收官。**MU2b 纯渲染端 + main/preload 微增量三处：T5 preload 追加托盘菜单事件订阅两方法（main 侧零改动——现状核查：`menu:open-settings`/`menu:toggle-right` 由 main 发送（[src/main/index.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/main/index.ts) L73-74）但 preload/renderer 从未监听（[preload/index.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/preload/index.ts) 全文仅 minisdPort/minisdInfo），是 M2d 遗留死通道，T5 一并接通）；T6 `attachments:save` handler + preload `saveAttachment`。src/minisd 整目录零改动**（决策 4 白名单是 MU2a Task 9 专属，MU2b 不援引）。

## Task 1：右栏骨架（360px 默宽 + 拖拽 + tab 重排）——审计 H5 · 设计 §1.2/§4.1

**目标**：右栏 300→360px 默认宽、320–480 可拖（6px 热区分隔条）、可收起保留；tab 从「终端/文件/任务+gear」重排为「**进度**（默认）/产物/文件/终端」；gear 暂留（Task 5 移除，串行演进不回退——M2d 先例）。

- [x] **Step 1（红）**：新建 `tests/renderer-rightpane.test.ts`（守卫 + 纯模块）：
  - `lib/pane/drag.ts`：`clampPaneWidth(px): number`（<320→320、>480→480、区间原值）；`nextWidth(startX, startW, moveX): number`（左拖增宽：dx 取反 + clamp，纯函数）
  - 守卫 [App.vue](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/renderer/src/App.vue)：`.pane-r` 宽 `360px`；`rightTab` 类型含 `'progress' | 'artifacts' | 'files' | 'terminal'`；tab 行四个文本 tab（进度/产物/文件/终端）+ gear 暂存锚；默认 tab `'progress'`；分隔条元素锚（`class="rdrag"` + mousedown 绑定）
  - 守卫宽度持久化：拖拽结果写 `localStorage('deskminis.rightW')`，启动读回（localStorage 读写锚）
- [x] **Step 2（绿）**：实现 App.vue 增量（tab 类型/默认值/分隔条拖拽接线/宽度持久化）；tasks tab 改名「进度」仍挂 TasksPanel（Task 2 替换组件）；产物 tab 一期挂占位 div（Task 3 填实，同 M2d「串行演进占位」模式）
- [x] **Step 3**：单文件 + 全量绿（renderer-tasks-panel/renderer-files-panel 的 App.vue 锚点按 Global Constraints 修订清单**同步修订**：`rightTab === 'tasks'` → `'progress'`、visited 字段名同步——断言语义不变只换名）
- [x] **Step 4**：typecheck + build；dev 手工：拖拽 320/480 边界钳制、重启宽度保留、终端 80 列不折行（360px）
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2b): 右栏骨架（360px 默宽/320-480 拖拽/tab 重排进度默认）`

测试估算：+6 例（drag 3 / 守卫 3）。

## Task 2：进度 tab（ProgressPanel 替换 TasksPanel）——审计 H5/H4 · 设计 §4.1

**目标**：TasksPanel 重做 → ProgressPanel：任务句（会话标题亲和呈现）+ 步骤列表（与对话流 ToolLine 同数据、进度叙事呈现）+ Token 两行 + 水位条（contextInfo 沿用）+ 等待批准显著化（pendingPerms>0 → tab 标题橙点 + 卡内「⏸ 等待批准 — xxx [去处理]」点击滚动定位权限卡）；fallback/compacted/offloaded 三状态卡保留（WorkBuddy 圆角卡 + 左 3px 色条，M2d 成果换皮肤不推翻）；事件不再对话流/面板双份（设计 §1.3：面板是「当前状态」，对话流是「历史记录」——EventNote 内联条管历史，ProgressPanel 卡管当下，语义不同不视为重复）。

- [x] **Step 1（红）**：`tests/renderer-tasks-panel.test.ts` **同 Task 内改写**为守卫 ProgressPanel（Global Constraints 修订清单允许）：
  - 组件改名 `ProgressPanel.vue`（TasksPanel.vue 删除守卫 `existsSync === false`；App.vue import 同步）
  - 组成锚：任务句区（`chat.sessions` 找 activeId 标题）/ 步骤列表（`chat.toolCards` v-for：状态符号 + title + duration——复用 Task 6 `fmtDuration`）/ Token 区（lastUsage/totals 沿用 M2d computed）/ 水位条（watermark 沿用，`--state-ok/warn` 色槽替写死）/ 事件卡三态（fallbackState/compactedState/offloadedState 沿用）
  - 等待批准锚：`chat.pendingPerms.length > 0` 时渲染「去处理」按钮（点击 emit 或直接调 ChatView 暴露的滚动定位——落地方案：chat store 新增 `permFocusRequestId: string | null`，ProgressPanel 写入，ChatView watch 后 `scrollIntoView` 对应 PermissionCard 并清空；守卫 store 含该字段）
  - App.vue 橙点锚：tab「进度」在 `chat.pendingPerms.length > 0` 时带 `class="dot-warn"`
  - M2d 语义回归锚：contextInfo 优先水位、stopLabel 映射、toolStats 三计数——断言保留
- [x] **Step 2（绿）**：实现 `ProgressPanel.vue`（M2d computed 逻辑平移 + 新皮肤 + 步骤列表 + 批准显著化）+ App.vue 接线 + chat.ts 增量 `permFocusRequestId`（M2c/M2d 字段全保留）+ ChatView 滚动定位接线；删除 TasksPanel.vue
- [x] **Step 3**：单文件 + 全量绿
- [x] **Step 4**：typecheck + build；dev 手工：假 provider `__tool__` 触发权限卡 → 进度 tab 橙点 + 步骤行「⏸ 等待批准」；点「去处理」→ 对话流定位到权限卡
- [x] **Step 5**：checkbox 勾选；commit `feat(mu2b): 进度 tab 任务仪表板（步骤叙事/等待批准显著化/TasksPanel→ProgressPanel）`

测试估算：+8 例（改写后净增约 3，另 5 为新增锚；基线口径记 +8，被替换的旧断言 7 例等数退役——MU2b 完成后总数按实际文件重计，此处给净估算）。

## Task 3：产物 tab（ArtifactsPanel）——审计 H5 · 设计 §4.1

**目标**：本会话写/编过的文件汇总卡：类型图标 + 相对路径 + `+N/−M` 增删徽标 + 点击切文件 tab 并定位预览；空态「本轮还没有产物」。

- [ ] **Step 1（红）**：新建 `tests/renderer-artifacts.test.ts`：
  - 纯模块 `lib/artifacts/collect.ts`：`collectArtifacts(messages, toolCards): Artifact[]`（`{ path: string; kind: 'write'|'edit'; add?: number; del?: number }`）——历史 messages parts 扫 `toolUse` name ∈ {file_write, file_edit} 提取 path（相对化：剥数据根/workspace 前缀）+ 实时 toolCards 补充；同路径去重（edit 优先，增删数用 Task 7 `extractEditPair`+`countAddDel` 算）；空输入 → `[]`
  - 守卫 `ArtifactsPanel.vue`：卡列表锚（图标 + 路径 mono + 徽标 `+N/−M` 绿红）+ 空态文案锚 + 点击行为（`chat.pendingFilePreview = path` + `showTab('files')` 等价调用）
  - 守卫 chat.ts 新增 `pendingFilePreview: string | null`；FilesPanel watch 该字段 → 触发既有 preview 流程并清空（FilesPanel 增量守卫）
  - App.vue：`rightTab === 'artifacts'` 挂 ArtifactsPanel（v-show + visited 模式沿用）
- [ ] **Step 2（绿）**：实现 collect.ts + ArtifactsPanel.vue + chat.ts/FilesPanel/App.vue 接线
- [ ] **Step 3**：单文件 + 全量绿
- [ ] **Step 4**：typecheck + build；dev 手工：假 provider file_write+file_edit 各一 → 产物 tab 两卡、增删数正确；点击 → 文件 tab 展开并预览该文件
- [ ] **Step 5**：checkbox 勾选；commit `feat(mu2b): 产物 tab（写编文件汇总卡/增删徽标/点击定位文件预览）`

测试估算：+9 例（collect 5 / 守卫 4）。

## Task 4：左栏变体 A（任务卡式）+ 底部设置/设备入口——审计 IA-1 · 设计 §1.1-1（变体 A 定稿）

**目标**：SessionList 列表项 → 任务卡：标题 + 相对时间 + 状态徽标（●进行中绿 / ⏸等待批准橙 / ✕失败红 / ✓完成灰）+ 产物计数角标；新建按钮 `--action`（Task 4 已降权，本 Task 核形态）；底部固定「设置」「设备」两入口（设置先路由既有右栏 gear 行为——Task 5 切模态；设备一期 disabled 置灰——Task 7 填实，串行演进）。

- [ ] **Step 1（红）**：新建 `tests/renderer-sessioncard.test.ts`：
  - 纯模块 `lib/session/status.ts`：`sessionBadge(s, live): 'running'|'waiting'|'failed'|'done'|null`——live（仅活动会话：`{ running, pendingPerms, lastStopReason }`）推导：running → running；pendingPerms>0 → waiting；lastStopReason ∈ error 系 → failed；有消息 → done；非活动会话一期 `null`（**数据源诚实说明**：`chat.sessions.list` RPC 无 running 字段，非活动会话状态不可得——全局徽标需 minisd 扩字段，列入非目标）；`artifactCountOf(messages): number`（复用 Task 3 collect）
  - `lib/time/relative.ts`：`fmtRelative(epochSec, nowSec): string`（刚刚/N 分钟前/HH:MM/昨天/M-D）
  - 守卫 SessionList.vue：任务卡结构锚（`.scard` + `.sbadge` 四态类 + `.scount` 角标）；分组（置顶/今天/昨天/本周/本月/更早——M1 既有）保留锚；底部 `.lfoot` 两按钮（设置/设备）锚；`232px` 宽守卫（App.vue `.pane-l` 260→232，设计 §1.2）
- [ ] **Step 2（绿）**：实现 status.ts/relative.ts + SessionList 重做 + App.vue 宽改 232 + 底部入口接线（设置 → `settingsOpen=true; rightOpen=true` 等价；设备 → disabled）
- [ ] **Step 3**：单文件 + 全量绿
- [ ] **Step 4**：typecheck + build；dev 手工：活动会话徽标随 running/perm/失败切换；产物角标数与产物 tab 一致
- [ ] **Step 5**：checkbox 勾选；commit `feat(mu2b): 左栏变体 A 任务卡（状态徽标/产物角标/底部设置设备入口，232px）`

测试估算：+9 例（status 4 / relative 3 / 守卫 2）。

## Task 5：设置独立模态 + 标题栏瘦身——审计 IA-2/IA-3 · 设计 §1.1-2/§5.6

**目标**：SettingsModal（左 180px section 导航 + 右内容：模型=ProviderSettings 平移 / 外观=三模式单选+说明 / 权限=档位+90s 超时说明 / 设备与同步=打开 DevicesModal 入口）；遮罩 40% 黑 + 卡片 720px `--r-sheet` + Esc 关闭 + `Ctrl+,` 打开；右栏 gear 移除；左栏「设置」入口切到模态；托盘菜单死通道接通（MU2b 引言核查）：preload 追加订阅 + App.vue 监听——`menu:open-settings` 开模态、`menu:toggle-right` 顺带接通（右栏开合，M2d 菜单项一并救活）；主题选择持久化 localStorage（现状内存态丢失）；TitleBar 瘦身：无 handler 的前进/后退删除、菜单数据 noop 项删除（保留真实可用项）。

- [ ] **Step 1（红）**：新建 `tests/renderer-settings-modal.test.ts`：
  - 守卫 `SettingsModal.vue`：四 section 导航锚（模型/外观/权限/设备与同步）+ ProviderSettings import 平移锚 + Esc 关闭 + 遮罩 `rgba(0,0,0,.4)` + 720px + `--r-sheet`
  - 纯模块 `lib/settings/theme.ts`：`loadTheme(): 'system'|'light'|'dark'`（localStorage 读、非法值回 system）；`saveTheme(t)`（App.vue theme 接线改造守卫：cycleTheme 保留 + 新增 setTheme 落盘 + 启动 loadTheme）
  - 守卫 App.vue：gear tab 移除（`not.toContain("tab gear")`）；`settingsOpen` 语义改为模态开关（原右栏 settingsOpen 分支移除）；`window.deskminis.onMenuOpenSettings(...)` 调用点开模态 + `onMenuToggleRight(...)` 切右栏；`Ctrl+,` keydown 绑定锚；左栏设置入口 emit → 开模态
  - 守卫 preload/index.ts：追加 `onMenuOpenSettings(cb: () => void)` / `onMenuToggleRight(cb: () => void)` 两订阅（`ipcRenderer.on` 包装 + 返回取消订阅函数）；既有 `minisdPort`/`minisdInfo` 不动——**preload 白名单：本 Task 仅此两方法追加；main 侧零改动**（tray-lifecycle.test.ts 等 M2d 守卫不回归）
  - 守卫 TitleBar.vue：前进/后退按钮移除锚；菜单数据无 noop 项（逐项列出现存 noop label 断言消失——实施期先读 TitleBar 菜单数据列全清单）；侧栏开关/标题/主题键保留锚
  - 守卫 ProviderSettings.vue 本体零改动（从右栏 rbody 平移进模态，组件不动——M2b/M2c 成果）
- [ ] **Step 2（绿）**：实现 SettingsModal + theme.ts + App.vue/TitleBar/SessionList 接线；权限 section 文案含「危险命令始终拦截 / 每次确认默认 90 秒未响应自动拒绝」
- [ ] **Step 3**：单文件 + 全量绿（renderer-rightpane.test.ts 的 gear 暂存锚**同步移除**——T1 预留的演进点）
- [ ] **Step 4**：typecheck + build；dev 手工：Ctrl+, 开关、Esc 关、外观三模式立即生效且重启保留、托盘「打开设置」出模态
- [ ] **Step 5**：checkbox 勾选；commit `feat(mu2b): 设置独立模态（四 section/Ctrl+,/主题持久化）+ 标题栏瘦身删 noop`

测试估算：+8 例（theme 3 / 守卫 5）。

## Task 6：空状态任务起点页 + Composer v2——审计 IA-5/X-6 · 设计 §1.3/§5.5

**目标**：EmptyState 重做（3 示例指令卡：读代码/写脚本/跑命令 + 最近任务 3 条——点击填入输入框或开会话）；Composer 自适应长高 1–8 行（36→176px 超内滚）；图片粘贴/拖拽 → main 进程落盘会话附件目录 → 48px chip（可删）→ 发送时文本尾附 `[附件] attachments/<file>`；发送键 32px 圆形 `--action` 实底（色权修正）。

- [ ] **Step 1（红）**：新建 `tests/renderer-composer.test.ts`：
  - 纯模块 `lib/composer/autogrow.ts`：`rowsFor(text, maxRows=8): number`（按 `\n` 数 + 长行折估，clamp 1..8）；`lib/composer/attach.ts`：`attachNote(paths: string[]): string`（`\n[附件] a.png\n[附件] b.jpg` 形态；空数组 → `''`）
  - 守卫 EmptyState.vue：三示例卡锚（读代码/写脚本/跑命令文案）+ 最近任务锚（`chat.sessions` 前 3，`fmtRelative` 复用）+ 点击行为（示例 → emit fill；最近 → `chat.open(id)`）
  - 守卫 ChatView.vue：textarea 无 `rows="1"` 写死（改 `:rows="rowsFor(input)"` 或等价）；`@paste`/`@drop` 处理器锚；chip 列表渲染锚（48px + 删除 ×）；发送键类含 `--action` 背景锚（`var(--label)` 黑底退场守卫）
  - 守卫 main 侧：`src/main/index.ts` 追加 `ipcMain.handle('attachments:save', …)`（dataUrl 解码 → `sessions/<id>/attachments/paste-<ts>.png`，返回相对路径；sessionId 用 minisd 同款 UUID 正则校验防路径逃逸）；preload 暴露 `saveAttachment(sessionId, dataUrl)`——**main/preload 白名单：仅此一处 handler + preload 一个方法，窗口/托盘/启动逻辑不碰**
- [ ] **Step 2（绿）**：实现两模块 + EmptyState 重做 + ChatView composer 接线 + main/preload 增量；假 provider 无视觉回归
- [ ] **Step 3**：单文件 + 全量绿；新增 `tests/main-attachments.test.ts`（main 侧 handler 逻辑抽纯函数 `attachmentPath(root, sessionId, ts)` + dataUrl 解码器——node 直测，不启动 Electron；非法 sessionId/坏 dataUrl 拒绝）
- [ ] **Step 4**：typecheck + build；dev 手工：粘贴截图 → chip 出现 → 发送后文本含 `[附件] attachments/paste-…png`；文件真实落盘会话目录；9 行文本内滚
- [ ] **Step 5**：checkbox 勾选；commit `feat(mu2b): 空状态任务起点页 + Composer v2（自适应长高/图片粘贴附件 chip/发送键色权）`

测试估算：+10 例（autogrow 3 / attach 2 / main-attachments 3 / 守卫 2）。

## Task 7：配对管理面（DevicesModal，接 M3a remote.* 真 RPC）——审计 IA-4 · 设计 §7.1

**目标**：左栏「设备」入口填实 → DevicesModal：① 已配对设备列表（`remote.status` → devices：设备名/指纹前 12 hex/last seen 相对时间/移除钮）；② 发起配对（`remote.pair.begin` → 8 字配对码 32px mono 字距 8px 展示 + `expiresIn` 倒计时 + 「等待对端输入…」状态句）；③ 加入配对（输入 8 位码）——**一期置灰带说明「需 M3c 出站通道」**（M3b 命门 4：出站客户端/地址簿属 M3c，桌面端一期只有被动侧；`remote.pair.complete` 是 pairing authMode 专属，UI 不可经本地连接调用——[remote/index.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/remote/index.ts) L57 assertAuthMode 已实证）。

- [ ] **Step 1（红）**：新建 `tests/renderer-devices.test.ts`：
  - 纯模块 `lib/devices/fmt.ts`：`fmtFingerprint(fp): string`（前 12 hex 大写分组 `XX XX XX XX XX XX`）；`fmtPairingCode(code): string`（8 字 `XXXX-XXXX`）；`codeInputNormalize(raw): string`（大写化、剥非字母数字、限 8 位）
  - 守卫 chat.ts 新增 actions：`refreshDevices()`（`remote.status` → state.devices）、`beginPairing()`（`remote.pair.begin` → state.pairingSession `{ code, myFingerprint, expiresIn, startedAt }`）、`cancelPairing()`（清 state）、`unpair(fingerprint)`（`remote.unpair` + 刷新）——M3a 红线：`remote.*` 仅 local authMode，渲染端老 token 连接天然满足
  - 守卫 `DevicesModal.vue`：三区块锚（设备列表卡 / 发起配对区：码大字 mono + 倒计时读秒复用 `lib/perm/countdown` / 加入配对区置灰 + M3c 说明文案）；移除钮二次确认锚；指纹 mono 展示锚
  - 守卫左栏「设备」按钮从 disabled 改为开 DevicesModal（SessionList/App 接线锚）
  - 守卫设置模态「设备与同步」section 内入口同开 DevicesModal
- [ ] **Step 2（绿）**：实现 fmt.ts + chat.ts 四 actions + DevicesModal.vue + 接线；配对完成感知：`remote.pair.complete` 由对端触发，本机感知靠轮询 `remote.status`（发起配对状态下 2s 轮询，设备出现 → 滑入列表 + 清 pairingSession；超时 expiresIn → 状态句「配对码已过期，请重新发起」）
- [ ] **Step 3**：单文件 + 全量绿；RPC 行为层由 M3a 既有测试背书（[remote-rpc.test.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/tests/remote-rpc.test.ts) 26 例 + rpc-server-authmode / paseto-v4-local / pairing-store 等 M3a 文件），本 Task 不重测 RPC 语义
- [ ] **Step 4**：typecheck + build；手工（或 e2e-mu2a 同款 CDP）：发起配对 → 出码+倒计时；CLI 侧完成配对（`deskminis-cli` M3a 成果）→ 设备滑入；移除 → 列表清空
- [ ] **Step 5**：checkbox 勾选；commit `feat(mu2b): 配对管理面（设备列表/发起配对出码倒计时/移除，接 remote.* 真 RPC）`

测试估算：+9 例（fmt 4 / 守卫 5）。

## Task 8：MU2b e2e + 暗色三模式全量截图验收（§3.3-2 硬约束）+ 阶段收官

**目标**：`scripts/e2e-mu2b-acceptance.mjs`；三模式全量截图；MU2 整体验收收口。

- [ ] **Step 1**：写 e2e 脚本（决策 8 同基建）。验收用例：
  1. 右栏：默认 360px（`getComputedStyle`）；tab 四枚且默认「进度」；拖拽分隔条到 500 → clamp 480
  2. 进度 tab：假 provider `__tool__` 回合 → 步骤列表出现；权限卡触发 → tab 橙点 + 「去处理」点击定位
  3. 产物 tab：file_write 回合 → 卡出现 + 点击切文件 tab 预览
  4. 左栏：任务卡徽标随状态切换；底部「设置」开模态、「设备」开 DevicesModal
  5. 设置模态：Ctrl+, 开、Esc 关、外观切深色立即生效、重启（重载 page）主题保留
  6. 空状态：新窗口无会话 → 三示例卡 + 点击填入输入框；Composer 粘贴图片（CDP 模拟 paste 事件不可行时改断言 saveAttachment preload 桥存在 + main-attachments 单测背书，手工验收补截图）
  7. DevicesModal：remote.pair.begin 出码文本 8 字 + 连字符格式 + 倒计时读秒
  8. **三模式全量截图**（§3.3-2）：浅/深/跟随系统（深色系统）× {主对话屏（含 Markdown/工具行/diff/权限卡/EventNote）、右栏进度、右栏产物、设置模态、DevicesModal} 共 15 张存 `scripts/e2e-shots-mu2b/`；断言无 console error、三模式切换无未定义 CSS 变量（eval 遍历 `getComputedStyle(document.body)` 关键槽位非空）
- [ ] **Step 2**：跑通 e2e 8/8；`npm test` 全量绿（约 594+132+62≈788，以实际为准）；typecheck + build
- [ ] **Step 3**：设计 v2 §3.3-1 巡检：全组件 grep 写死颜色/color-mix 写死比例（守卫脚本或手工 grep 清单附 e2e 输出）
- [ ] **Step 4**：MU2 计划文档 checkbox 全勾；审计 22 条逐条回销核对表（H1-H5/IA/V/X 各条 → 落地 Task 映射）附在收官 commit body 或 PR 描述
- [ ] **Step 5**：commit `test(mu2b): e2e 验收 + 暗色三模式全量截图（15 张）`；feature/mu2b 交复核 → 合并 main

测试估算：+3 例（main-attachments 补强 / 残余守卫；e2e 不进 npm test）。

---

## 完成定义（DoD）

### MU2a（feature/mu2a → main）

- [x] 11 个 Task 全部完成，checkbox 全勾
- [x] `npm test` 全绿：594 基线 + MU2a 新增 147 = **741**（以实际为准；较估算 726 偏差 +2.1%，<10%）
- [x] `npm run typecheck` 零错误；`npm run build` 三产物（main/preload/renderer）成功
- [x] `npm run e2e:mu2a` 7/7 通过；`npm run e2e:m3a` 不回归（Task 9 后必跑）；`npm run e2e`（M1 链路）不回归（mu2a 7/7 与 m3a 6/6 复核方亲跑通过；M1 链路环境性阻塞——中继余额耗尽 403 insufficient_user_quota 且 grok-4.5 agent 面 404 UnsupportedModel，代码面由 741 例 + mu2a/m3a e2e 全覆盖，留待充值换模后重跑）
- [x] XSS 红线测试 12 例全绿；全组件 grep 无 `v-html`/`innerHTML`（12/12 全绿；唯一 grep 命中 Icon.vue v-html 为 M1 静态 PATHS 字典，评审裁决豁免——编译期常量零用户输入面）
- [x] 审计 H1-H4、V-1/V-2/V-5、X-1~X-5、X-7 回销；三模式手工目视通过（三模式截图经执行方与复核方双目视）
- [x] minisd 白名单合规自查：`git diff main...feature/mu2a --stat -- src/minisd` 只含 index.ts / tools/permissions.ts / bridge/detect.ts（+ FakeProvider env 钩子一处，Task 11 红线例外已声明）

### MU2b（feature/mu2b → main）

- [ ] 8 个 Task 全部完成，checkbox 全勾
- [ ] `npm test` 全绿：MU2a 基线 + MU2b 新增约 62 ≈ **788**（以实际为准）
- [ ] `npm run typecheck` / `npm run build` 通过；`npm run e2e:mu2b` 8/8 通过；既有 e2e 全部不回归
- [ ] 三模式全量截图 15 张入库（`scripts/e2e-shots-mu2b/`）；写死颜色/写死 color-mix 比例巡检清零
- [ ] 审计 22 条全部回销（核对表落地）；`git diff --stat -- src/minisd` 为空（MU2b 零 minisd 改动）

## 非目标（MU2 两阶段均不做）

1. **语法高亮**（决策 2d：围栏只带语言槽 + 复制）
2. **组件挂载测试框架引入**（决策 5：@vue/test-utils/jsdom 不进仓库）
3. **标题栏同步状态点 / 会话来源设备点 / 跨端执行钉选**（设计 §7.2/§7.3/§7.4——M3c 范围；DevicesModal 的「加入配对」出站 complete 同属 M3c）
4. **非活动会话的运行状态徽标**（Task 4 数据源说明：`chat.sessions.list` 无 running 字段，需 minisd 扩字段——后续里程碑单独立项）
5. **语音输入 / `@` 文件引用 / 附件进协议 ContentPart**（§5.5 明示语音/`@` 不进 MU2；附件一期仅落盘 + 文本路径提示）
6. **OM（OpenMinis）侧任何改动**（线格式/UI 对齐均以 OM 为只读参照）
7. **右栏 tab 内容跨会话切换保活重构**（现状 v-show+visited 沿用，不推倒）
8. **菜单栏新增功能项**（只删 noop，不加新功能）
