# DeskMinis 会话交接文档（2026-09-10，T6 清场收官后）

> 用途：新对话开局投喂，**一次读完就能开局**。本文件存于 docs 分支 `docs/handoff/2026-09-10-session-handoff.md`，
> 配套资产（52 例 Linux 基线清单、27 个审核 driver + 索引、实拍截图）在 `docs/handoff/` 同目录。
>
> **取代 `2026-09-07-session-handoff.md`**——那一版是补丁摞出来的：§4 波史停在 W 波、
> §5 仍写着旧组件树「待删」（T6 已删净）、§6 留着两句已失效的话。本版是整合过的。

## 0. 三十秒版

- **代码**：main `26f64af`，**version 0.3.0**，minis.db user_version=**11**。
  165 测试文件 / 1850 例（云端 1798 过 + 52 Windows-only 基线），typecheck 0，build 0。
- **界面**：T 波推倒重建后的新树 `src/renderer/src/ui/` 是唯一的 UI；旧树 **T6 已删净**，
  `components/` 只剩 MarkdownView 一族 3 个活文件。
- **最近一件大事**：**T6 清场做完了**（2026-09-10，十笔代码 + 两笔记账）——删旧组件树 −6781 行、
  8 个失效 e2e 脚本；38 个测试文件的守卫逐条重指/退场；`tests/mu6-capability-wiring.test.ts`
  改成**双向绊线的能力入口清单**。过程中又挖出七处换壳漏搬并补回，另有一批记账不补的缺口
  （§6「换壳遗失的入口」）。
- **下一件**：二选一（§6 一档）——0.3.0 上架 / 首发竞态。
- **发布**：v0.2.0 **从未发布过**（GitHub Releases 只有 v0.1.1）。0.3.0 待 Windows 真机走 `docs/RELEASE.md`，
  **`e2e:m5` 必须重跑**——T6 之后 renderer 产物又变了一轮。

## 1. 项目、协作模式、分支

- **项目**：DeskMinis——Windows 桌面通用 Agent 应用（Electron + TS + Vue3 + better-sqlite3）。
  仓库 `github.com/lincheuk/Deskminis`，应用代码在 `deskminis/` 子目录。只在 Windows 真机发布验证。
- **模式**：**自己做模式**（H 波起，用户明令）——Claude 设计 + 实现 + 直接推 main，纪律全套照旧，
  审核标准对自己同样执行。设计稿先行、**定稿即施工**、决策点事后可否决返工。
- **用户风格**：中文、决策快、放权但要求**申报与可否决**。有分歧先陈述一两句，然后照做并申报。
- **三条分支**：
  - `main` = 功能落地线；
  - `claude/handover-documentation-pfr2l4` = 云端会话的**指定分支**（harness 要求推这里）。
    实操是**两支同点**：每笔提交后 `git branch -f claude/handover-documentation-pfr2l4 main` 一起推；
  - `claude/deskminis-handoff-dd9wrk` = **权威记账线**（PROJECT_NOTES 波结 + docs/specs 设计稿 + handoff + driver）。
    分支叉在 G 波代码之前，树上代码是旧快照——**看代码去 main，看账本来这里**。合入 main 的方式用户未裁定。

## 2. 纪律（违反任一条即返工，对自己同样适用）

1. **零新 npm 依赖**：dependencies/devDependencies 一行不动（scripts 行有先例可加可删）。
   U 波的 Office 能力就是在这条约束下自建的（`.docx/.xlsx/.pptx` = ZIP+OOXML，读用 yauzl、写用内置 zlib）。
2. **TDD 先红**：新逻辑先写失败测试，红输出存档后再实现。
3. 完成后 `cd deskminis && npm test` + `npm run typecheck` 全绿；**`.vue` 不在 typecheck 覆盖内**——
   renderer 改动必须配 `tests/renderer-*.test.ts` 源码文本守卫，**且 UI 改动必 xvfb 目视**（§3）。
4. 注释中文写「为什么」；最小改动面；**DB 只追加式迁移**（`store/db.ts` MIGRATIONS 尾部）。
   加迁移必随动**六个** user_version 版本钉测试——设计出来逼显式确认的，改它们要在 commit 里申报。
   同类还有 `tests/m5-packaging.test.ts` 的 version 钉、`mu6-capability-wiring` 的能力清单绊线（§5）。
5. **commit**：`-F` UTF-8 消息文件（「——」被终端吞过），格式 `<步骤号>: 简述`，身份
   `git -c user.name="lincheuk" -c user.email="linchaoheng3@gmail.com" commit`。提交正文要写：做了什么、
   为什么、验证输出、**偏差逐条申报**、**自己判错又改回的也写**。
6. **push**：commit 后立即推，失败 2/4/8/16s 退避重试 ≤4 次；推后 `git log origin/<分支> --oneline -1` 远端验证。
7. **退出码必须来自目标命令本身**——管道/链式后取 `$?` 一律无效（已三次兑现）。
   正确形：`npm run typecheck > /tmp/tc.log 2>&1; echo EXIT=$?`。
8. **cwd 在每次 Bash 调用之间会重置**——每条命令自带 `cd`，或一律绝对路径。
9. **守卫重指前按意图搜，不按旧名搜**（按 `syncdot` 小写搜零命中，差点把活着的 `syncDot` 判成没搬）。
10. **断言认调用形态 `.action(`，不认裸字符串**——`includes('setWorkspace')` 会被同文件注释里的散文喂饱，
    自检时不红（T6 实测）。
11. 多任务独占 checkout 串行（F 波 index 踩踏教训）。

## 3. 验证工具箱（云端）

- **npm test 的真身**：`cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <files>`
  ——裸 `npx vitest` 会炸 better-sqlite3 ABI。跑单文件照此形。
- **Linux 基线 52 例**：云端跑全量必有 52 例平台性失败（PowerShell/bridge/terminal 类），清单在
  `docs/handoff/linux-baseline-failures.txt`。比对法（diff 必须为空；Windows 真机应全绿）：
  ```
  npm test 2>&1 | grep '^ FAIL ' | sed 's/^ FAIL  //' | LC_ALL=C sort \
    | diff /home/user/deskminis-docs/docs/handoff/linux-baseline-failures.txt -
  ```
- **xvfb 实拍**（UI 改动必做）：先 `npm run build`（app 跑的是 `out/` 产物）；剧本用 playwright-core
  `_electron.launch({ executablePath: 'node_modules/electron/dist/electron', args: ['--no-sandbox','.'], cwd: APP_DIR })`；
  `xvfb-run -a node drive-xx.mjs`。**27 个现成剧本 + 索引在 `docs/handoff/driver/`——先读那份 README.md。**
  每个 driver 顶部的 `S` 常量是当时会话的 scratchpad 绝对路径，**跑前改成自己的**；
  playwright-core 不入库，在临时目录 `ln -s <deskminis>/node_modules node_modules` 即可。
- **FakeProvider**：`DESKMINIS_FAKE_PROVIDER=1` + `DESKMINIS_DATA_DIR`，数据根里种子
  `providers.json` = `{"providers":[],"defaultProviderId":"__fake__"}`。首条用户文本 `__tool__ <工具名> <inputJSON>`
  触发一次工具调用；**同会话每回合重放首条**（要不同工具就开新会话）；`DESKMINIS_FAKE_REPLY` 定制回复。
  **inputJSON 必带 `"tool_title"`**——registry 的 required 校验先于执行与权限闸。
- **权限门**：只读命令默认 `bypass` **不弹卡**（`DEFAULT_LEVELS.readonly`），要用 gated 命令
  （`npm install …`）或往工作区外写。**唯一走权限门的剧本是 `drive-v1.mjs`**，照抄它。
- **工作区是每会话的**（`drive-t6e.mjs` 踩的坑）：第二个会话里要先把种子文件铺进它自己的
  `sessions/<sid>/workspace/`，否则 `file_edit` ENOENT、截图上留一条刺眼的「1 步失败」。
- **源码文本守卫证明「传下去了」，证明不了「点开看得见」**：T6e-2 六例全绿后实拍立刻逮到
  `input` 落库是 JSON 字符串、`isRec()` 恒为 false——历史回放标题一直是裸工具名。这条链必须实拍。
- **交叉验证**（U 波成例）：自建文件格式要用独立第三方库（python-docx / openpyxl / python-pptx，只装 scratchpad）读回来验。
- **headless RPC e2e**：`scripts/e2e-m2a-acceptance.mjs` 是模板；`npm run e2e:mcp` 六案可回归；
  `npm run e2e:m5` 是打包验收。GUI/CDP 类旧脚本已随旧 UI 失效并在 T6f 删除，GUI 剧本一律照 driver/ 写。

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
| **S** | 质感层返工：**全局根本没有 line-height**（头号成因）、字号阶梯、圆角、输入卡阴影 | `552ba64` `ddc0df7` `4ceee7c` |
| **T** | **UI 推倒重做**：新令牌 `theme.css` + 新组件树 `ui/`，入口切 `AppShell`；三栏工作台；字体随包思源黑体；色板修正 | `d06c74b`→`bc68510`；T5 `6fd7aa9` |
| **U** | Office 能力：零新依赖自建 OOXML 读/写/预览 + `office_read`/`office_write` | `2b4ab7c` |
| **V** | 换壳能力面补齐（可达性盘点逮到发布级阻断——权限卡从没渲染过）九件 | `a3adb6c` `0af3530` `3deaa0e` `82b520b` |
| **W** | 沉淀：升版 0.3.0 + README/CHANGELOG/RELEASE 对齐 + 交接文档换代 | `b7450ca` |
| **T6** | **清场**（下表） | `ed1dc09`…`26f64af` |

**T6 十笔（main）+ 两笔记账（docs `33e4c0f` `e60fbc9`）：**

| 步 | commit | 结果 |
|---|---|---|
| T6a | `ed1dc09` | 先补新树守卫真空：UiIcon v-html 白名单 / a11y 扫全树 / 注释层 ARIA / 全局焦点环；顺带修 TabBar 关闭键键盘不可达 |
| T6a2 | `c663c52` | 助手绑定模型写回 `provider:` 前缀（J2 修过的格式分叉换壳时回魂） |
| T6b | `8858b4d` | 补回工作区绑定入口（WorkspacePanel 绑定行）；**修真 bug**：`files.ts` 围栏基准用错桶，绑定自定义目录后文件面板整个列不出 |
| T6c | `e50fa5a` | README 五行过度宣称改 🟡 |
| T6d | `906d093` | 令牌碰撞归位：theme.css 改成实际渲染值（零视觉变化），配「同名令牌必须同值」守卫 |
| T6e-1 | `31e2fd2` | 8 个死 lib 随实现退场，mu5 不变量迁入 `renderer-form-invariants` |
| T6e-2 | `eb9339f` | 补搬：工具步骤 `input` 字段 + `file_edit` 差分视图 + 参数回落；技能启停「全局」交代；**修老账**：历史回放标题裸工具名 |
| T6e-3/4 | `dddbbf8` | 删 25 组件 + App.vue + 3 lib + 1 测试（−6781 行）；38 个测试文件守卫逐条 REPOINT/SPLIT/RETIRE（退场留理由）；mu6 改双向绊线；补回六句交代 + `.f-btn` nowrap + 用户正文可标注 |
| T6f | `a52f1f9` | 删 8 个失效 GUI e2e 脚本 + 5 个死 npm 入口 + 42 张旧壳截图；反向同步无 e2e 覆盖如实记账 |
| T6g | `26f64af` | README 助手行「默认技能」改 🟡（新挖出的换壳遗失） |

**自报判错五处**（都改回，提交正文有输出为证）：「30 个测试一删即崩」实为 17；批量换令牌名误伤了
`tokens-evolution`/`diff.test`（它们断言的就是旧词汇），从 HEAD 恢复；把活着的 `syncDot` 判成没搬；
给 Composer 补的 `@click` 是重复绑定（build 报 Duplicate attribute 才发现）；空前缀批量退场误删 m3c 配对例，按 diff 补回。

## 5. 关键文件地图

### renderer（`src/renderer/src/`，UI 全在 `ui/`）

入口 `main.ts` → `styles/theme.css` + `styles/tokens.css` + `ui/AppShell.vue`。

| 文件 | 职责 |
|---|---|
| `ui/AppShell.vue` | 三栏外壳：TopBar / [NavRail \| Stage \| WorkspacePanel] + 底部终端抽屉。**视图路由**：`view` ∈ chat/search/cron/assistants/market/settings/devices，按值切舞台（没有模态、没有惰性挂载） |
| `ui/TopBar.vue` | 40px 标题栏；`syncDot` 三态（syncing/idle/未连接）；☰ 现在只切主题（重载/退出在主进程原生菜单）。**右侧留 146px** 给系统按钮 |
| `ui/NavRail.vue` | 左导航 + 会话列表（`emojiOf` 助手头像）；底部「设置」「设备」。会话行**没有 ⋮ 菜单**（§6 缺口） |
| `ui/StageWelcome.vue` / `ui/StageChat.vue` | 欢迎态 / 会话态，**并列视图**。欢迎页开场提示来自选中助手的 `prompts` |
| `ui/StageChat.vue` | 回合切分 `turns`；用户右对齐 `.ubub`、助手满宽文档式；`toolInput()` 解析落库的 JSON 字符串载荷；用户与助手正文都挂 `data-anno-root` |
| `ui/StepGroup.vue` | 工具折叠组。**`file_edit` 走 `extractEditPair`+`UiDiff`，其余回落参数区**；`views` 只在展开时算（LCS） |
| `ui/Composer.vue` | 输入卡 hero/chat 两态；斜杠菜单 + @ 文件（`syncAt` 挂 input/click/keyup）+ 输入历史 + 附件 + `quote()` |
| `ui/PermCard.vue` + `ui/UiDiff.vue` | 权限卡（路径/命令逐字不截断、倒计时只显示不自判、桥双段告知）+ 差分预览（`path?` 可选） |
| `ui/PreviewPane.vue` + `ui/OfficeView.vue` | 产出物预览三态工具条 + Office 内容预览（docx 纸 / xlsx 网格 / pptx 16:9） |
| `ui/WorkspacePanel.vue` + `ui/UiFileTree.vue` + `ui/TaskPanel.vue` | 右栏三 tab：文件（含**绑定行**，只在文件 tab）/ 改动（`collectArtifacts`）/ 任务（上下文水位） |
| `ui/StageSettings.vue` + `ui/settings/Sec*.vue` | 七节：Models / Permission / Skills / Mcp / Search / Look / About（左 tab 列 + 右定宽内容） |
| `ui/StageAssistants` `StageCron` `StageDevices` `StageMarket` `StageSearch` | 五个舞台。Market 是唯一的模态宿主（确认卡 + toast，z 100） |
| `ui/TerminalPane.vue` / `ui/AnnoLayer.vue` | 终端抽屉（xterm，兜底色走 `v('--c-…') || '#…'`）/ 选区注释（CSS Highlight，零 DOM 改写） |
| `ui/ThinkBlock` `EventNotes` `ModelBar` `TabBar` `UiIcon` | 会话内构件 |

**`components/` 只剩三个活文件**：`Icon.vue`、`MarkdownInline.vue`、`MarkdownView.vue`
（被 `ui/PreviewPane`、`ui/StageChat`、`ui/StageMarket` 引用）。可达性遍历下全树唯一不可达的是 `shims.d.ts`（tsconfig 拾取，不是 import，**别删**）。

`stores/chat.ts` 是全树共享地基，20+ 测试对它做断言；`toolCards` 带 `input`（JSON 字符串）。
`lib/` 活模块：`annotations/anchor`、`artifacts/collect`、`attach/downsample`、`composer/{autogrow,history,at-files}`、
`cron/describe`、`devices/fmt`、`diff/{lcs,payload}`、`eventnote/copy`、`markdown/parse`、`nav/group`、
`perm/{copy,countdown}`、`time/{hhmm,relative}`。

### 样式

- `styles/theme.css`（**新，唯一真相源**）：`--c-`（色）/ `--t-`（字号行高成对）/ `--r-`（圆角）/ `--sp-`（间距，8 档）/
  `--sh-`（阴影）/ `--w-` `--h-`（尺寸）+ 表单原语 `.f-*`（`.f-btn` 已 nowrap）+ 排版工具类 `.t-*`。
  间距值是**当前真正渲染的值**（T6d 对齐过），`--sp-7` 与 `--sp-5` 同值是历史遗留。
- `styles/tokens.css`（737 行，**旧**）：**不能删**——MarkdownView 消费 14 个、MarkdownInline 4 个只在它里面声明的变量；
  两套同名令牌已同值（守卫钉着），把这 18 个搬进 theme.css 后即可删。层级序不变量：**主体 z-index < 50 < 模态 100/110**，
  50 是空置的防御性槽位；豁免做**值级**不做文件级。

### minisd

- `src/minisd/index.ts`：RPC 注册全集 + FakeProvider + 权限广播 + cron 调度器；`provider.getDefault`（T5b）；
  `mcp.servers.list` 回 `configError`（界面 T6e 起才读）
- `store/db.ts`（MIGRATIONS[0..10]）、`store/chat-store.ts`、`store/provider-store.ts`、`store/search-provider-store.ts`（只认 brave/tavily/searxng）
- `files.ts`：围栏基准 **`workspaceOf`**（认每会话覆盖值，T6b 修）
- `office/{zip,parse,build}.ts` + `tools/office.ts`；`tools/permissions.ts`（`DEFAULT_LEVELS` readonly=bypass）；
  `agent/loop.ts`（工具载荷 `input` 以 JSON 字符串落库）

### 守卫地图（动 UI 必看）

- **`tests/mu6-capability-wiring.test.ts` = 能力入口清单，双向绊线**。WIRED（8 项）断言 `ui/` 里有**调用**；
  GAPS（6 项 + 锚点轨 + 助手技能绑定）断言 store action 与 minisd 注册都在、且 `ui/` 下零调用。
  **补上任何缺口它会红——这是设计意图**：把那条从 GAPS 挪进 WIRED，README 的 🟡 改回 ✅。
- 全树扫描类：`a11y-keyboard-reachable`（递归全树）、`renderer-titlebar-stacking`（全树 z-index）、
  `renderer-shell-form`（玻璃拟物反向锚）、`renderer-ui-icon-guard`（v-html 白名单）、`renderer-focus-ring`、
  `theme-contrast`（含同名令牌同值）、`tokens-mu3-appica`（零硬编码色）。
- 新树各源码守卫：`renderer-stage-views`、`renderer-chat-capabilities`、`renderer-shell-panels`、`renderer-attach-shell`、
  `renderer-market-shell`、`renderer-anno-shell`、`renderer-office-preview`、`renderer-default-provider`、
  `renderer-tool-steps`、`renderer-workspace-shell`、`renderer-form-invariants`、`renderer-content-form`。
- **守卫处置原则**：不变量仍成立 → 重指新树；随实现退场 → 连同实现一起删，**在原位留理由注释**并在 commit 说明；
  裁定被推翻的（如用户气泡回归）要写明是裁定变更不是漂移。一删了之留下的真空比死代码更危险。

## 6. 排期与候选池（2026-09-10 对过账）

### 一档：挡在发布前面的（二选一）

1. **0.3.0 Release 上架**——唯一真正的发布阻断。GitHub Releases 目前**只有 v0.1.1**。
   按 main 的 `docs/RELEASE.md` 在 Windows 真机走：构建 → `e2e:m5`（**必须重跑**）→ 手动冒烟 → 上传三件套（`latest.yml` 漏传 = 自动更新失明）。
2. **首发竞态排查**——L6 实测：紧跟启动的首条 Enter 偶发被吞，`lastError` 空。T 波把输入链路整个重写过，需重新复现。

### 换壳遗失的入口（用户裁定只补工作区，其余在此；已设绊线）

| 入口 | store action / 字段 | 立于 | 备注 |
|---|---|---|---|
| 删除会话 / 重命名 | `deleteSession` `renameSession` | MU6 / B1 | 会话行 ⋮ 菜单整个没搬 |
| 会话记忆开关 / 绑定模型 | `setSessionMemory` `setSessionModelBinding` | MU6 / J2 | 同上 |
| 会话级禁用 MCP | `setSessionMcpDisabled` | L5 | 输入卡 pill + 行内面板 |
| 同步暂停 / 恢复 | `setSyncPaused` | M6 | 状态可见（`syncDot`），改不了 |
| 助手 ↔ 技能绑定编辑 | `skillIds` | J | 新编辑器无此字段 |
| 消息锚点导航轨 | `data-turn-id` + 轨道组件 | L3 | 纯渲染侧，绊线单独钉 |

**收窄**（入口变少或换形态，未设绊线）：消息来源设备标（`originDeviceId` 落库仍在）· ☰ 只剩主题切换 ·
`Ctrl+,` 打开设置 · MCP env/headers 编辑器（只能手改 servers.json）· MCP 列表行逐台试连 · 用户消息复制钮 ·
会话行运行态徽标与产物数 · 拖拽分栏 · 任务栏耗时读数。

### 二档：前提已变 / 纯补入口

办公技能包（原搁置理由已被 U 波消除）· 模型组降级 UI 入口（后端 `group:` 全通，README 🟡 好几波了）·
vue-tsc 立项评估（「全绿 ≠ 界面正常」已四次兑现；撞零新依赖红线，故是评估）。

### 三档：需先出设计稿

会话正文全文搜索（minisd 侧建索引）、用量与成本面板（注意任务面板做的是上下文水位，≠ 花了多少钱）、
genui 内联交互组件、多窗口对话墙、图片生成、内置浏览器。

### 预览区 T10 遗留 / 其它仍未做

Snapshot / History / Open in system app / Download / 代码语法高亮。Office L2 DOM 精改、Office 高保真渲染
（「内容预览不是版式还原」是刻意边界）、Ctrl+K 命令面板、非图像附件、模型选择器搜索、消息内路径可点击、
已完成回合自动折叠、规划模式、会话分叉、技能覆盖三层判定、会话级权限覆盖、注释入上下文/入同步/多色、
`marketplace.json` 自定义源、market provenance 补 version、fixture 环境变量生产门控、MCP 的 OAuth/resources/prompts/非文本。

### 已划掉 / 悬空

已划掉：I7 会话视图对齐、首页输入卡双层、MCP 会话级禁用 UI（L5 做过、T 波丢了→见上表）、市场 MCP tab、后台作业、
历史消息附件（chip + 点开预览；内联缩略图仍未做）、**T6 清场**。
悬空（等用户裁定）：docs 分支合并进 main 的方式；仓库转 public（转了自动更新即生效）；brave/tavily 真 key 首跑验收。

## 7. 教训镇魂碑（别再踩）

1. **换壳是搬家，不是在新房子里重写主要房间**。搬家清单必须**从旧实现逐项核对**。代价：权限卡从没渲染过，
   1890 例全绿 + typecheck 0 + 所有实拍都没拦住——没有一个剧本走过权限门。
2. **内部标识符漏给用户看**（V 波一波三次）：`StopReason` 枚举上屏、更新状态照事件名写映射、yauzl 英文报错直达预览卡。
3. **界面撒谎比界面难看严重**：默认 provider 曾是猜的（`providers[0]`）；servers.json 坏了曾显示成空列表。
4. **「全绿 ≠ 界面正常」已五次兑现**：`.smore`、浮条 CJK 竖排、文泉驿、权限卡漏渲染、历史回放裸工具名。UI 改动必 xvfb 目视。
5. **守卫是资产**：遇守卫红先想「它对不对」，对就改代码不加豁免（T6 里 `.f-btn` nowrap、StageMarket 模态 z 都是这么改的）。
   豁免要做值级不做文件级。
6. **有守卫 ≠ 有覆盖**：守卫锚在哪个目录就只守那个目录；能被注释喂饱的断言等于没有断言。
7. 管道吞退出码 ×3；Windows 时钟 ~15ms（同刻排序 rowid tiebreaker）；`assertSessionId` 是格式闸；
   乐观消息 id `local-<n>` 落库后被换，持久引用不得挂它。
8. **换壳漏搬不止漏整块能力，也漏「页面上的一句交代」与「顺手丢掉的字段」**：T6 补回六句交代
   （技能启停全局 / SearXNG 要开 JSON / servers.json 坏了按空配置加载 / 定时任务 90 秒自动拒绝 / 每次确认 90 秒按拒绝 / 权限档位说明）
   和一个字段（工具 `input`：读了 `tool_title` 就把整个对象扔了）。搬家清单要**逐句核对旧页面文案**。
9. **守卫重指前按意图搜，不按旧名搜；断言认调用形态，不认字符串**（§2 第 9、10 条的出处）。
10. **自己的报告也要有输出为证**——自己做模式下同样成立；判错了就在提交正文里写清怎么改回的。

## 8. 已知风险与技术债

- **A（已处理，T6d `906d093`）** 两套令牌同名碰撞：实测 9 个同名 / 7 个值不同 / 297 处引用（W 波记的「4 个」是数错了）。
  处置是承认现状 + 同值守卫。tokens.css 仍不能删，原因见 §5。
- **B（已处理，T6a `ed1dc09`）** 新树守卫真空：UiIcon v-html、a11y 全树扫描、注释层 ARIA、焦点环，三者都做过「故意破坏→变红→还原」。
- **C 打包验证已过期**：R 波 asar 结论对 0.2.0 快照；之后 S/T/U/V/T6 五波。**0.3.0 发布前 `npm run e2e:m5` 必须重跑。**
- **D 反向同步无 e2e 覆盖**：持数据方=监听方这一向此前由 `e2e:m3c` 用例 6 随机覆盖；该脚本随旧 UI 失效、T6f 删除，
  现在只有 `tests/auto-sync.test.ts` 单测。记账，不假装还有。
- 其它：`--win` 交叉构建在 Linux 不可行（`spawn wine ENOENT`，证据 `docs/handoff/r3-win-crossbuild-fail.log`）；
  tag 推送被 403 拒，tag 走 GitHub Release 自动创建；私仓期间自动更新 404 静默为既知态。
