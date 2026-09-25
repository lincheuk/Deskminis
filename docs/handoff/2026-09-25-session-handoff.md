# DeskMinis 会话交接文档（2026-09-25，止血波 W1a–W2b 收官、0.3.0 发版前）

> 用途：新对话开局投喂，**一次读完就能开局**。本文件存于 docs 分支 `docs/handoff/2026-09-25-session-handoff.md`，
> 配套资产（52 例 Linux 基线清单、到 Z 波为止的 xvfb 剧本与索引）在 `docs/handoff/` 同目录。
>
> **取代 `2026-09-10-session-handoff.md`**——那一版停在止血波开工前：§6 一档还写着「等用户拍板」，§4 波史停在 Z 波与调研，
> §5 没有本轮新增的二十多个模块。那一版的 §7 教训 12 条仍然有效，本文不再复述。

## 0. 三十秒版

- **代码**：main `d00b991`，**version 0.3.0**，minis.db user_version 仍是 **11**。245 测试文件 / 3445 例
  （云端 3393 过 + 52 Windows-only 基线），typecheck 0。本波零迁移、零新依赖。两条链合入后 main 在〔待合流后填〕。
- **本轮做完了止血波 W1a–W2b**（2026-09-24～25，设计稿 `docs/specs/2026-09-24-hemostasis-design.md`）。
  从 09-10 的 `761b862` 起共 66 个提交：55 笔步骤（其中 18 笔是审查遗留的补修）加 11 次合流。
  - **W1a 伤数据**：file_edit 不再被 `$` 改坏文件；MCP 配置读坏拒写、外部修改不被覆盖、编辑不再丢字段；技能 zip 有上限；
    库比应用新就不打开，开发态数据与正式版分开。
  - **W1b 越权与并发**：数据根读写收窄，shell 免询问只留只读本地命令；单实例锁与数据根锁；删除还在跑的会话先停；
    优雅退出；进程树回收，cmd 与 PowerShell 改 System32 绝对路径。
  - **W2a 引擎与 provider**：压缩改增量、有上界，空摘要拒收，失败看得见；超窗单独分类并给「新建会话接力」；
    新一代 Claude 与 DeepSeek V4 的多轮 400 止血；卸载的大结果读得回来，file_read 能分段。
  - **W2b 界面与发布工程**：运行态与权限卡按会话区分；断线横幅与重启；欢迎页选助手不再撒谎；导航守卫与最小菜单；
    本地崩溃记录与按天日志；更新源改公开仓库、失败说中文；`verify:release`；中断的工具不再显示成功。
- **发 0.3.0 还差什么**：
  1. 主会话合入两条链：链 S（W3-smoke 发版冒烟脚本 `smoke:release` 及补修，`hemo/s`）〔待合流后填〕；
     文档链（W2b-11b/11c：README、CHANGELOG、RELEASE 终稿与 `readme-claims` 守卫，`hemo/docs`）〔待合流后填〕。
  2. 用户在 Windows 上发版（设计稿 §5；RELEASE.md §0 的九步清单随文档链进 main）：
     建公开仓库 `lincheuk/deskminis-releases` → `npm ci`、`npm test`（52 例 Windows-only 也要过）、`npm run dist`
     → `e2e:m5`、`verify:release` → 设两把 key 跑 `smoke:release` → 安装版与便携版手动冒烟
     → CHANGELOG「待发布」改日期 → 建 Release `v0.3.0`（非 draft、非 pre-release）传四件
     → 下载回来再跑 `verify:release` → 新版里「现在检查」显示「已是最新」。
- **发布现状**（2026-09-25 查 GitHub）：源码仓 Releases 只有 v0.1.1；`lincheuk/deskminis-releases` 搜不到，按还没建处理。
- **之后**：W4a 办公内容包（0.3.1）→ W4b–W5 provider 正确性与上下文管线（0.4.0）→ W6–W7 运行时韧性与人在回路（0.5.0）
  → W8–W9 cowork 结构与打磨（0.6.0）。等用户拍板的 9 项列在 §6，每项有默认建议。

## 1. 项目、协作模式、分支

- **项目**：DeskMinis——Windows 桌面通用 Agent 应用（Electron + TS + Vue3 + Pinia + better-sqlite3；引擎 minisd 在 utilityProcess，
  经 WebSocket JSON-RPC 与渲染端通信）。源码仓 `github.com/lincheuk/Deskminis`（私有），应用代码在 `deskminis/` 子目录。
  发布资产改放公开仓库 `lincheuk/deskminis-releases`（设计稿 §2，由用户建）。只在 Windows 真机发布验证。
- **模式**：**自己做模式**——Claude 设计、实现、直接推 main，纪律全套照旧，审核标准对自己同样执行。设计稿先行、定稿即施工，
  决策点事后可否决返工。本轮起点是用户 2026-09-24 对方向评估的答复「按照你的想法把它完善再發出去」：采纳报告建议，
  报告 §7「发版前必须定」五项按默认落定（设计稿 §2）。2026-09-25 用户要求加快，施工改为多链并行（§2 C 组）。
- **用户风格**：中文、决策快、放权但要求**申报与可否决**。有分歧先陈述一两句，然后照做并申报。
- **分支**（规则照旧，多了一支同点分支）：
  - `main` = 功能落地线。代码直接推 main。
  - `claude/handover-documentation-pfr2l4` 与 `claude/deskminis-handoff-qq2kn3` = 云端会话的指定分支，**与 main 同点**：
    每推一次 main，`git branch -f claude/handover-documentation-pfr2l4 main`、`git branch -f claude/deskminis-handoff-qq2kn3 main`，三支一起推。
    2026-09-25 查 origin：三支都在 `d00b991`。
  - `claude/deskminis-handoff-dd9wrk` = **权威记账线**（PROJECT_NOTES 波结、docs/specs、docs/research、docs/handoff、driver）。
    本地是 worktree `/home/user/deskminis-docs` 的 `docs-work` 分支，upstream 指向它；推时写明目标
    `git push origin docs-work:claude/deskminis-handoff-dd9wrk`。树上的代码是旧快照——**看代码去 main，看账本来这里**。
    合入 main 的方式用户仍未裁定。
  - 本轮施工分支 `hemo/*` 只在本地（远端只有上面四支），合流后不推。
- **提交身份与写法**（照旧）：`git -c user.name="lincheuk" -c user.email="linchaoheng3@gmail.com" commit -F <UTF-8 消息文件>`。
  - 标题：步骤提交 `<步骤号>: 简述`，步骤号带子波字母（`W1a-2:`），与 09-07 的旧 W 波（`W1:`）区分；补修用 `<步骤号>b/c`；
    合流用 `合流: 链 X（步骤…）并入 main——一句话`；记账线用 `设计稿:` `研究:` `记账:` `驱动:` 前缀。
  - 正文分节：做了什么 / 为什么 / 先红 / 验证 / 有意翻红的守卫 / 偏差申报 / 自己判错又改回的；经过审查的加「审查意见处置」；
    合流提交写冲突与处置、合流后的验证数字。末尾两行署名照当次会话给的 attribution（Co-Authored-By 与 Claude-Session）。
  - 推送：commit 后立即推，失败 2/4/8/16 秒退避重试不超过 4 次，推后 `git log origin/<分支> --oneline -1` 核对。

## 2. 纪律（违反任一条即返工，对自己同样适用）

### A. 09-10 的全套（仍然有效，本轮有更新的已标出）

1. **零新 npm 依赖**：dependencies / devDependencies 一行不动（scripts 行可加可删）。本轮起有守卫 `tests/deps-frozen.test.ts`
   整体快照两张表与锁根；改依赖先征得用户同意，再改快照并在提交正文申报。
2. **TDD 先红**：新逻辑先写失败测试，红输出存档后再实现。
3. 完成后 `npm test` + `npm run typecheck` 全绿；**`.vue` 不在 typecheck 覆盖内**——renderer 改动必须配源码守卫，**UI 改动必 xvfb 目视**。
4. 注释中文写「为什么」；最小改动面；**DB 只追加式迁移**（本波零迁移；`MIGRATIONS` 已导出并冻结，`tests/db-migrations-immutable.test.ts`
   用 sha256 钉住 [0..10]）。加迁移必随动六个 user_version 版本钉、`m5-packaging` 版本钉与 `mu6-capability-wiring` 清单绊线，并在提交里申报。
5. **commit**：见 §1「提交身份与写法」。正文写做了什么、为什么、验证输出、**偏差逐条申报**、**自己判错又改回的也写**。
6. **push**：见 §1。
7. **退出码必须来自目标命令本身**——管道或链式之后取 `$?` 无效。正确形：`npm run typecheck > /tmp/tc.log 2>&1; echo EXIT=$?`。
8. **cwd 在每次 Bash 调用之间会重置**——每条命令自带 `cd`，或一律绝对路径。
9. **守卫重指前按意图搜，不按旧名搜**。
10. **断言认调用形态 `.action(`，不认裸字符串**。
11. 多任务不共用一个 checkout：本轮改成「每链一个 worktree」（C 组第 1 条）。

### B. 止血波设计稿 §1 八条（本波全部适用，之后的波照此执行）

1. **提交前缀**带子波字母：`W1a-2: …`。
2. **先红取证**：红输出存 `scratchpad/hemo-logs/<步骤>-red.log`，要点抄进提交正文。Linux 上无法先红的写明「非先红」并说明原因。
3. **每步独立全绿**：本步测试绿 + typecheck 0 + 全量 `npm test` 与 52 例基线逐行 diff 为空。新增测试不得落进 Windows-only 基线
   （Linux 上必须能跑）；确需 Windows 的另开 `*.win.test.ts` 并申报。
4. **有意翻红**：改变既有守卫断言的，提交正文逐条列「文件:行 · 原断言 · 新断言 · 为什么」。
5. **借用即登记**：文件头写「改编自 <上游名>（<URL>）」，紧跟「上游：」「许可：」「本文件已修改：」三行；仓库根 `THIRD-PARTY-NOTICES.md`
   对应上游节的表里追加一行。`tests/license-consistency.test.ts` 双向绊线核对两边。
6. **界面改动必 xvfb 目视**：`npm run build` 后用 playwright-core 剧本实拍，截图亲自看。
7. **Linux 上触发权限卡**：用 `web_fetch`（askOnce，指向剧本里起的本地 HTTP 服务），或写 `/var/minis/skills/x/SKILL.md`；
   不要用 POSIX 绝对路径的 `file_write`（`paths.ts` 直接抛错，进不了网关）。
8. **源码守卫只防现实中会发生的回退**：注释或散文喂饱断言、自然的重构写法（改用 watch、换个函数名、挪进帮手文件或别的目录、同名字段换一个）。
   刻意混淆的写法——HTML 实体或转义拼出标识符、`arguments` 反射、非 ASCII 同义标识符、把函数经高阶调用转手、字符串拼属性名——
   不算测试漏网，审查列作 nit，由行为测试和代码审查兜底。

### C. 本轮形成的做法

1. **多链并行**：按改动文件分链，每链一个 git worktree（`/home/user/wt-<链>`，分支 `hemo/<链>`），`deskminis/node_modules`
   符号链接到主 checkout 的 `node_modules`，不重装。机器 4 核，同时最多 2 个 agent。热点文件（`src/main/index.ts`、preload、TopBar、
   `stores/chat.ts`、`StageChat.vue`、NOTICES 的表）跨链时，合流逐处按语义手工合并；**合流后重跑 typecheck 与全量基线比对，
   有界面改动的在合并后的构建上重拍 xvfb**；合流提交正文写冲突与处置。链内步骤串行，链与链之间不等。
2. **步骤工作流**（脚本归档在 `docs/handoff/driver/hemostasis/hemostasis-steps.workflow.js`，复用前按 README 改路径，或照下面重写）：
   - 实现者：按设计稿与侦察附录 TDD 先红 → 实现 → 全部验证 → 本地提交（不推），按固定格式交报告（含 open_issues）。
   - 独立审查者：对抗式复核（假定它有错），亲自跑测试、写小实验，不改仓库；只把「会导致错误行为、数据损坏、测试漏网或违反纪律」
     的问题列 must_fix，风格与刻意混淆列 nit。
   - 修正者：逐条修，`git commit --amend` 更新同一提交，正文追加「审查意见处置」。
   - **最多三轮审查、两轮修正**。第三轮还有 must_fix 的，另起 `<步骤号>b/c` 补修：要么再走一遍工作流（W1b-2b、W2b-4b、W2a-6b），
     要么主会话直接做、正文写明没有再走独立审查（W2a-1b、W2b-5b、W2b-9b 等）；也可以定为已知边界。
     审查与实现者的遗留统一记进草稿区 `followup-notes.json`（按步骤键）与 `pending-boundaries.md`。
3. **不能先红的用变异自检证明**：回归钉、守卫加固、性能改写的等价性，都在 scratch 副本（`git archive` 或复制，node_modules 软链）上
   逐个打变异、跑相关测试、恢复后逐字节核对，列出「改前的测试全绿、改后的测试变红」的对照。等价变异要认出来并写明。
4. **源码守卫的写法**：只防现实回退（B 组第 8 条）；`.vue` 剥注释走语法树（`tests/sfc-blocks.ts`）；「不许出现」类检查查原文、不剥注释
   （剥注释只会把东西藏起来）；断言锚结构（配平取块、AST 父节点），不锚排版。
5. **子 agent 说明用中性工程措辞**：写「免询问白名单只应包含只读本地的命令」这类工程目标，不写攻击路径与利用细节。
   本轮有一次子 agent 说明被安全审核误判，改写成中性措辞后通过（设计稿 W1b-2g 一行的来由也改成了中性说法，docs `d6be27b`）。
6. `src`、`scripts`、`tests` 下除了登记过的文件头，**不写字面的「改编自」三个字**（license-consistency 扫这三处，会把它当登记标记），
   测试与注释里需要时换个说法。

## 3. 验证工具箱（云端）

- **npm test 的真身**：`cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <files>`——裸 `npx vitest` 会炸
  better-sqlite3 ABI。跑单文件照此形。全量里偶发的超时先单独重跑那个文件再下结论（机器负载）。
- **Linux 基线 52 例**（没变）：清单 `docs/handoff/linux-baseline-failures.txt`（shell 13、files-tools 10、bridge-handlers 6、terminal 5、
  rpc 4、permission-audit 4 等）。比对法（diff 必须为空；Windows 真机应全绿）：
  ```
  npm test > /tmp/full.log 2>&1; grep '^ FAIL ' /tmp/full.log | sed 's/^ FAIL  //' | LC_ALL=C sort \
    | diff /home/user/deskminis-docs/docs/handoff/linux-baseline-failures.txt - && echo BASELINE_DIFF_EMPTY
  ```
- **本轮新增的测试帮手**（`tests/` 下不是 `.test.ts` 的文件）：
  - `sfc-blocks.ts`：取 `.vue` 的脚本、模板、样式三段并剥注释。脚本按 `vue/compiler-sfc` 的 babelParse 注释区间剥，模板按 AST 的注释节点剥；
    解析出错或 lang 不是 ts/js 直接抛（W2b-4b 建，W2b-4c 改语法树）。
  - `sfc-setup.ts`：不挂载组件也能真跑 `script setup`——compiler-sfc 编译、typescript 转 CommonJS、在 effectScope 里执行，拿回顶层绑定；
    `renderSfc` / `visibleText` 按默认状态 SSR 渲染、只看用户看得见的字（W2b-11a）。零新依赖。
  - `main-window-guard-harness.ts`：electron 桩，把 `src/main/index.ts` 从 whenReady 真跑到建好托盘，取出处理器直接调。
    **一个 worker 只能 import 一次主进程模块**，所以打包 / 未打包 / dev 三种形态各开一个测试文件。
  - `sanitize-spec.ts`：URL 凭据脱敏的原正则管线，作规格基准，禁止 import 任何东西。
  - `strip-comments.ts`：正则版剥注释，主进程守卫仍在用；已知漏洞：冒号后紧跟的真注释会被当成 URL 留下（W2b-4c 写明）。
  - `minisd-crash-inject.cjs`：往引擎里注入未处理拒绝 / 未捕获异常（W2b-7）。
- **新脚本**：`npm run verify:release`（发布四件与随包文件的零依赖校验，W2b-10）；`npm run smoke:release`（发版冒烟，`--mock` 在 Linux 自测，
  链 S，〔待合流后填〕）。
- **xvfb 实拍**（UI 改动必做）：
  - 先 `npm run build`（app 跑的是 `out/`）。playwright-core 不入库，也不在 `deskminis/node_modules` 里：在草稿区放一份
    `docs/handoff/driver/package.json` 跑 `npm i`（只装这一个包）。剧本用 `createRequire(import.meta.url)('playwright-core')` 取它
    （ESM 的 import 不认 NODE_PATH），跑法 `NODE_PATH=<草稿区>/driver/node_modules xvfb-run -a node <剧本>`。
  - 到 Z 波为止的剧本与索引在 `docs/handoff/driver/`（先读 README.md）。**本轮有代表性的 17 个剧本（含两个 X11 小工具与一个注入件）
    与步骤工作流脚本已归档到 `docs/handoff/driver/hemostasis/`**（先读那里的 README.md：跑法、模拟打包形态、管道残留怎么清）。
    其余剧本、日志 `hemo-logs/`、截图 `hemo-shots/` 留在会话草稿区，会话一结束就没了。

    | 剧本 | 验什么 |
    |---|---|
    | `W2b-2-permscope.mjs` | 权限卡按会话区分：FakeProvider + `web_fetch` 卡；三个会话，提示行、左栏盾牌标、点提示切过去、批完清空 |
    | `W2b-3-disconnect.mjs` | SIGKILL minisd 看断线横幅（贴标题栏、不溢出）、Enter 硬发被拒且字留框里、真点「重启应用」起新实例；隐藏窗口请求重启被拒 |
    | `W2b-11a-dangling.mjs` | 一个数据根两次启动：卡挂着时 `kill -9` 数据根锁里的 pid，重开看「已中断 · 结果未知」；MutationObserver 验收尾不闪 |
    | `W2b-11a-shell.mjs` | 终端、定时、设备三处文案；`electronApp.evaluate` 让主进程 `webContents.send` 托盘两条通道 |
    | `W2b-6-fix-guards.mjs`（参数 after 或 dev） | 导航守卫与权限白名单：桩掉 `shell.openExternal`、数新建 webContents、本地「外站」记请求；剪贴板复制两种形态 |
    | `W2b-7-crashlog.mjs` | 真 Electron 取证崩溃记录与按天日志（main / engine / quit 三段）；engine 段直接 spawn 构建产物加 `NODE_OPTIONS` 注入 `W2b-7-engine-inject.cjs` |
    | `W2b-6c-menu.mjs`（参数 pkg、dev 或 devurl） | 打包形态的菜单与基址：Ctrl+R、Ctrl+Shift+I、缩放、Ctrl+C/V，按键经 X11 XTest 发 |
    | `W1b-3-gui.mjs`（参数 locked 或 single）、`W1b-5-quit.mjs` | 「已在运行」原生框、第二实例唤回窗口；运行中带权限卡退出、锁释放、MCP 不留孤儿 |
    | `W2b-4b-r5-welcome.mjs`、`W2b-11d-changes.mjs`、`W2b-6b-osc8.mjs` | 欢迎页选助手（真 provider 四路由核请求体）；改动清单按结果判；终端 OSC 8 链接与欺骗地址 |

    每个剧本顶部的 `S`（草稿区）与应用目录（`APP_DIR` 或 `APP`，指当时那条链的工作树 `/home/user/wt-<链>/deskminis`）是写死的绝对路径，
    跑前改成自己的（比如主 checkout 的 `deskminis/`）。
  - **本轮多个剧本走权限门**（上面前三个、`W1b-5-quit`、`W2b-11d-changes`），09-10 那句「唯一走权限门的是 drive-v1」已过时。
  - **模拟打包形态**：Electron 按可执行文件名判 `app.isPackaged`（Linux 上不叫 electron 就算打包）。把 `node_modules/electron/dist`
    硬链接复制一份（W2b-6b 放在草稿区 `W2b-6b-pkgsim/`），可执行文件改名 `deskminis`，用它起同一份 `out/`，主进程里 `app.isPackaged` 为真。
    asar、安装路径与 Windows 行为仍要真机。
  - **原生对话框与按键**：playwright 看不到原生框，容器里也没有 xdotool 与 ImageMagick。用 python ctypes 直调 libX11/libXtst 的小工具
    （`docs/handoff/driver/hemostasis/W1a-8-x11.py`：列窗口、截根窗口、真点按钮；同目录 `W2b-6b-x11.py` 加了组合键）。
  - **造崩溃**：`kill -9` 数据根 `minisd.lock` 里记的 pid。**造引擎内异常**：spawn 构建产物时用 `NODE_OPTIONS=-r <注入件>`——playwright
    会把 NODE_OPTIONS 从环境里拿掉，这一段不能经 playwright 起。
  - **真 provider**：剧本里起本地假 OpenAI 端点（照 `docs/handoff/driver/mock-openai.mjs`），数据根种免密钥的 ollama 类 provider 指向它，
    按路由或最后一条用户消息回不同的工具调用；FakeProvider 同会话每回合重放首条，造不出不同的工具序列。
  - **数据根**一律 mkdtemp，经 `DESKMINIS_DATA_DIR` 注入。未打包且设了 DATA_DIR 时 userData 落在 `<DATA_DIR>/electron`（W1a-9），
    剧本能和开着的 dev 应用并存；**同一个 DATA_DIR 同时只能开一个应用**，第二个被单实例锁静默退出，playwright 会等到超时（W1b-3）。
  - **xvfb 没有窗口管理器**：窗口 focus、minimize 不产生事件，用 `window.dispatchEvent(new Event('focus'))` 证明接线，真窗口行为留给真机。
- **headless**：直接跑构建产物 `out/main/minisd.js`（`ELECTRON_RUN_AS_NODE=1`、`DESKMINIS_STANDALONE=1`），看握手行与致命行
  （W1a-8、W1b-3 的做法）；`scripts/e2e-*.mjs` 照旧可回归。
- **Windows 语义模拟**（纯函数测试）：路径类夹具按平台取两套，基址用 `pathToFileURL(p, { windows: true / false })` 生成，Linux 上两套都跑；
  必要时在 scratch 副本里拼一个模拟头把 `node:url` 换成 Windows 语义（W2b-6 第二轮审查）。
- **本地日期**：涉及按天分文件的测试，在 beforeAll 里把 `process.env.TZ` 设成 `Asia/Shanghai` 并先断言确实生效（W2b-7b）。
- **跑完查残留**：Linux 上 bridge 的 Windows 管道名会在 cwd 里留下 `\\.\pipe\deskminis-*` 套接字文件（W2b-11d）；盘符路径会被当相对路径写进
  cwd（W1b-2g）。跑完 xvfb 与全量先 `git status`，仓库已加 `.gitignore` 的 `/[A-Za-z]:*`。
- **09-10 的这些照旧有效**：FakeProvider 用法（`__tool__ <工具名> <inputJSON>`，inputJSON 必带 `tool_title`）；工作区是每会话的；
  源码守卫证明「传下去了」、证明不了「点开看得见」；自建格式用第三方库交叉验证；发消息类剧本等回合结束照抄 `drive-x1.mjs` 的 `waitTurn`。

## 4. 波史与当前状态

A–Z、T6 与 09-24 调研的波史见 09-10 交接 §4。本轮的依据：
方向评估 `docs/research/2026-09-24-reference-resurvey.md` → 设计稿 `docs/specs/2026-09-24-hemostasis-design.md`
（附录六份侦察计划与 `cross.md` 在 `docs/specs/2026-09-24-hemostasis/`，附录与设计稿冲突时以设计稿为准）。

「链」一栏：main = 直接在 main 上；B、C、E 三条链是快进进 main 的，没有合流提交；其余链见 §4.6 的合流表。

### 4.1 W1a 伤数据（9 笔）

| 步骤 | 做了什么 | main 上的提交 | 链 |
|---|---|---|---|
| W1a-1 | 借用登记格式与 NOTICES 双向绊线、依赖冻结守卫；许可 ISC → Apache-2.0，LICENSE 与 NOTICES 随安装包 | `7086b56` | main |
| W1a-2 | file_edit 改切片拼接：`$` 不再被解释；CRLF 偏移映射、BOM 保持；拒收非 UTF-8、重叠出现、空 old_string | `95fef05` | A1 |
| W1a-3 | 技能 zip 三道上限（条目数、inflate 之前、流式累计），伪造尺寸不再让导入挂起 | `d3a1290` | A1 |
| W1a-4 | MCP 配置读坏时拒绝一切写入，list 带 `configErrorKind`，设置页一条横幅、开关失败回滚 | `2cbed8e` | A1 |
| W1a-5 | MCP 写前对比磁盘、list 先重读：应用开着时手改的 servers.json 不再被内存旧副本覆盖 | `9563fa5` | A1 |
| W1a-6 | MCP 编辑后端改补丁语义：`null` 删键、`renameFrom` 原位改名、试连不写盘、市场更新保留用户设置、改动即时生效 | `a757177` | A1 |
| W1a-7 | MCP 编辑表单：参数每行一个、只提交改过的字段、同名新建前端拦截 | `2016ac0` | A1 |
| W1a-8 | 迁移守卫：库比应用新时一字节不写、弹「只能退出」的中文框；迁移逐条事务回滚；历史迁移 sha256 钉死；minisd 致命行通道 | `9621fac` | A2 |
| W1a-9 | 开发态数据隔离：主进程一次算定数据根、userData、keyring 服务名、日志目录并经 fork env 下发 | `48097bb` | A2 |

### 4.2 W1b 越权与并发（5 笔）

| 步骤 | 做了什么 | main 上的提交 | 链 |
|---|---|---|---|
| W1b-1 | 进程树回收（taskkill `/T` 不再先杀根）；shell、终端、桥、MCP 的 cmd / PowerShell 改 System32 绝对路径并隐藏窗口；子进程环境剥 `DESKMINIS_*` | `f5a68b0` | A2 |
| W1b-2 | 数据根读写收窄：dataGate 规范化判定，核心数据与凭据硬拒，应用配置与其它会话走卡带说明，搜索跳过数据根，shell 只读命令点到数据根回落询问 | `6866de4` | D1 |
| W1b-3 | 单实例锁与数据根锁：再开一次只唤回托盘里的窗口；同根第二个 minisd 当场拒绝并弹「已在运行」；陈旧锁自动接管 | `d02d861` | D1 |
| W1b-4 | 删除运行中的会话先中止、等收尾再删（10 秒停不下来就不删并报错）；定时任务失败不再记成 ok；左栏「删除中」与报错 | `00e33d1` | D1 |
| W1b-5 | 优雅退出：退出与「重启并安装」先请 minisd 有序关停（了结权限卡、等 run 收尾、关库、放锁），5 秒不退才 kill；close 幂等、拒绝新运行 | `1b411d4` | D1 |

### 4.3 W2a 引擎与 provider（7 笔）

| 步骤 | 做了什么 | main 上的提交 | 链 |
|---|---|---|---|
| W2a-0 | 请求体黄金快照：sha256 表冻结 OpenAI 兼容与 Anthropic 非目标模型的请求体 | `2871e88` | main |
| W2a-1 | 压缩止血：旧摘要加增量、压平并按窗口封顶、空与截断拒收、失败发 `compactFailed`；取名上限 2048 | `6cb83b5` | B |
| W2a-2 | 溢出分类（移植 pi 正则 24 + 3 条）：超窗只降级到更大窗口，否则 `contextFull` 并给接力草稿 | `6797eeb` | B |
| W2a-3 | 新一代 Claude：官方端点三模型发 beta 头与 `drop_block`、不发 `budget_tokens`；绑定 400 不降级；第三方端点剥思考重试一次 | `acb3e88` | B |
| W2a-4 | DeepSeek V4 回放 `reasoning_content`（只对 deepseek-v4 族，每条 assistant 都带） | `2dc3d21` | B |
| W2a-5 | 卸载读回不再二次卸载（按 5 万字封顶落库），修剪桩与卸载桩不再许空头支票 | `c87e004` | B |
| W2a-6 | 溢出与压缩失败的界面：「新建会话接力」、绑定错误不再给重试、降级短句写明因上下文已满改用谁 | `c8d9e30` | D2 |

### 4.4 W2b 界面与发布工程（13 笔，2 笔未合入）

| 步骤 | 做了什么 | main 上的提交 | 链 |
|---|---|---|---|
| W2b-1 | 按会话跟踪运行状态：切回仍在跑的会话停止键回来，流式区显示 midRun 占位 | `ef81d94` | D2 |
| W2b-2 | 权限卡按会话区分：只渲染当前会话的卡，别的会话在等时对话流顶部提示、左栏行上标盾牌 | `dfd65af` | F1 |
| W2b-3 | 断线横幅与重启通道：在途调用统一结算、新调用立即拒绝，横幅带「重启应用」；「重启并安装」装不起来 3 秒后自己退出 | `0b1db3a` | F1 |
| W2b-4 | 欢迎页选助手不再撒谎：新 RPC `chat.sessions.applyAssistant` 给空会话套用或解绑助手 | `d1b0905` | D2 |
| W2b-5 | ModelBar 标明「默认模型」，输入卡胶囊未绑定时显示「默认 · X」 | `41625b3` | C |
| W2b-6 | 窗口导航守卫与权限白名单：新窗口一律拒绝（网页与邮件交系统默认程序），拦下站外导航，权限只放行剪贴板写入 | `fd24dd4` | F2 |
| W2b-7 | 本地崩溃记录 `crashes.json` 与按天日志；握手后意外退出记为崩溃；权限超时的审计写入兜住 | `a4bd5d3` | F2 |
| W2b-8 | `sync.hello` 两端带协议版本 2 与能力位，缺失一律按 0.1.1 处理 | `6ad9e6d` | C |
| W2b-9 | 更新源改公开仓库 `lincheuk/deskminis-releases`；失败给一句中文；便携版不检查；托盘「检查更新」有回执 | `629d5d5` | E |
| W2b-10 | 发布校验脚本 `verify-release`：零依赖核对 latest.yml 的 sha512、安装包与 blockmap、便携版、更新源与随包许可 | `633e222` | E |
| W2b-11a | 界面诚实：历史里没结果的工具标「已中断 · 结果未知」；终端、定时、设备页文案按代码改正；托盘两条死通道接上；三处注释订正 | `4e20153` | H |
| W2b-11b | 对外文档逐行核对：README 按代码改写并附核对清单，CHANGELOG 补齐止血项与已知边界，RELEASE 接上冒烟与发版步骤，加 `readme-claims` 守卫 | 〔待合流后填〕 | 文档链 |
| W2b-11c | 对外文档终稿（在全部代码合入后的状态上做） | 〔待合流后填〕 | 文档链 |

### 4.5 施工中追加（设计稿 §4.1）与审查遗留补修

**新步骤（6 笔，1 笔未合入）**

| 步骤 | 做了什么 | main 上的提交 | 链 | 来由 |
|---|---|---|---|---|
| W1b-2d | file_read 支持 offset/limit 分段读取；卸载读回截断与 1MB 超限提示改指 file_read | `f94af79` | G | W1b-2b 审查 |
| W2a-7 | URL 凭据脱敏改线性扫描：20 万字单行从 23 秒降到毫秒级，结果与原管线逐字相同 | `1560e24` | G | W1b-2d 实现者申报 |
| W1b-2g | shell 免询问白名单只留只读本地命令：npm view/outdated、远程共享路径、env: 提供程序、远程主机参数回落询问；规则拦下与「完全访问」说法如实；删误入仓库的测试残留 | `c18e72f` | P | W2b-11b 三审 |
| W2b-6b | 终端 OSC 8 链接经中文确认框（规范形地址与主机）交系统浏览器；打包版不认 `ELECTRON_RENDERER_URL`、去掉应用菜单 | `f646fe9` | Q | W2b-6 三审、W2b-11a 三审 |
| W2b-11d | 右栏「改动」清单按工具结果判，失败与中断的写工具不再列；cron 注释按实际行为改正 | `9504d64` | R | W2b-11a 三审 |
| W3-smoke | 发版冒烟脚本 `smoke:release`：两家真 key 多轮工具调用、MCP 带空格路径试连、shell 停止后查残留；`--mock` 在 Linux 自测 | 〔待合流后填〕 | S | 设计稿 §5.1 |

**审查遗留补修（18 笔在 main，链 S 的另计）**

| 步骤 | 做了什么 | main 上的提交 | 链 | 来由 |
|---|---|---|---|---|
| W2a-1b | 压缩三处边界补测试（取消信号透传、输入封顶 10 万、至少取一条） | `4846d03` | B | W2a-1 三审 |
| W2b-5b | ModelBar 守卫剥三类注释，禁止藏起「默认模型」标签 | `4579801` | C | W2b-5 审查建议 |
| W1b-2b | 技能溢出提示改指免审的文件工具，不再叫模型用 shell 列数据根 | `6835841` | D1 | W1b-2 三审 |
| W1b-2c | 溢出提示的零卡守卫按「工具 + 实际给出的路径」判，按分句切 | `148b083` | D1 | W1b-2b 三审 |
| W1b-4b | 删除会话补双会话隔离回归钉 | `a2f6b74` | D1 | W1b-4 三审 |
| W1b-5c | 钉住「exit 监听第一句无条件写退出记录」 | `c1aaf7f` | D1 | W1b-5 三审 |
| W2b-4b | 输入卡入参挪进纯模块 `applyStateOf` 逐字段单测，守卫连入参一起认 | `2dda6da` | D2 | W2b-4 三审 |
| W2a-6b | 「接力草稿不许用 watch 消费」守卫改在语法树上判 | `aa33acf` | D2 | W2a-6 三审 |
| W2b-4c | `.vue` 守卫剥注释改走语法树（`tests/sfc-blocks.ts`） | `ddbe3f6` | D2c（D2 合流后直接落 main） | W2b-4b、W2a-6b 三审 |
| W2b-9b | 下载安装包失败也给一句中文（404 说漏传安装包） | `c2a9c2c` | E | W2b-9 三审 |
| W1b-2e | 分段读取四处收口（建议段长 19000、技能计数、非法值回显截断、超长卸载桩给分段读法） | `fbf55ff` | G | W1b-2d 审查 nit |
| W1b-2f | 非法 offset / limit 的回显截断让开代理对 | `d9163dd` | G | W2a-7 审查 nit |
| W2a-7b | 审计落盘脱敏改用同一个线性实现（20 万字 11 秒降到毫秒级） | `4729b9d` | G | W2a-7 审查 nit |
| W2b-2b | 钉住「切过去卡照样渲染」：按模板 AST 判卡与提示行不挂在条件分支下 | `bf20044` | F1 | W2b-2 三审 |
| W2b-3b | 断线之后点别的会话，当前视图原样不动 | `29f88ed` | F1 | W2b-3 修正者申报 |
| W2b-7b | 按天日志的测试钉在东八区 | `5fe86de` | F2 | W2b-7 三审 |
| W1b-2h | 权限文案两处收口：规则拦下时给一条不经 shell 的出路，「每次确认」写上只读命令也放行 | `7d72234` | P | W1b-2g 审查 nit |
| W2b-6c | 打包版换上只含编辑与缩放的最小菜单（不再设 null），未打包 loadFile 形态钉住保留默认菜单 | `b200ae0` | Q | W2b-6b 审查 |
| W3-smokeb 及之后 | 冒烟脚本三审补修：被打断时收整棵子进程树、凭据库清理与选库有测试、输出脱敏的接线有测试 | 〔待合流后填〕 | S | W3-smoke 三审 |

### 4.6 合流提交

| 合流提交 | 链与步骤 | 冲突与处置 | 合流后验证 |
|---|---|---|---|
| `85a10fc` | A1：W1a-2…W1a-7 | NOTICES pi-mono 表两边各加一行，都留 | 与 A2 一起验 |
| `3119bda` | A2：W1a-8、W1a-9、W1b-1 | NOTICES pi-mono 表再加一行 | 198 文件 / 2506 例；build 0 |
| `5f6c5e9` | D1：W1b-2…W1b-5 及 W1b-2b/2c、W1b-4b、W1b-5c | 自动合并无冲突（`main/index.ts` 两边改在不同处） | 213 / 2787 |
| `14236f9` | D2：W2b-1、W2a-6、W2b-4 及 W2b-4b、W2a-6b | `chat.ts` 删会话落欢迎页两边清的都留；`send()` 的 catch 按语义合；两边都加了 `const sid`，自动合并后重复声明，删 D2 那行；send 真跑用例补依赖表 | 218 / 2889 |
| `3a811a1` | G：W1b-2d/2e/2f、W2a-7/7b | 无冲突 | 219 / 2940 |
| `812b529` | F1：W2b-2、W2b-3 及 W2b-2b、W2b-3b | 无冲突 | 223 / 3000 |
| `025d08c` | H：W2b-11a | `StageChat.vue` 的 import 两行都留 | 227 / 3041 |
| `5f1a7af` | F2：W2b-6、W2b-7 及 W2b-7b | `main/index.ts` 的 import 区全留；exit 监听第一句仍无条件写退出记录 | 239 / 3295；合并后的构建重拍 xvfb（导航守卫、崩溃记录 16/16、断线与重启 29/29、托盘与文案） |
| `0fb622d` | P：W1b-2g、W1b-2h | 无冲突 | 241 / 3391 |
| `641fb06` | Q：W2b-6b、W2b-6c | 无冲突 | 244 / 3421 |
| `d00b991` | R：W2b-11d | 无冲突 | 245 / 3445 |
| 〔待合流后填〕 | S：W3-smoke 及补修 | 〔待合流后填〕 | 〔待合流后填〕 |
| 〔待合流后填〕 | 文档链：W2b-11b、W2b-11c | 〔待合流后填〕 | 〔待合流后填〕 |

A1 与 A2 合完一起验，其余每次合流后都跑了 typecheck（退出码 0）与全量，失败都是那 52 例、基线 diff 空。

### 4.7 记账线（docs 分支）本轮相关提交

`bbdac8a` 参考项目重读与方向评估（09-10 交接已提及）· `1665bf9` 止血波设计稿 · `3b43108` OpenCode V2 研读与界面裁剪（待拍板）·
`7f5b5ee` §4.1 施工中追加 · `67beca2` 改为多链并行、W2b-11 拆两步、W2a-7 与 §5.1 冒烟脚本 · `679f27c` §1 第 8 条 ·
`c6c3ba2` 四家参考对比与优化基准（待拍板）· `82c8bbc` §6 补一条（`\v` `\f` 夹在凭据里）· `9a7a968` §4.1 追加 W1b-2g ·
`216390a` §4.1 追加 W2b-6b · `d6be27b` W1b-2g 来由改中性表述 · `6578bf8` §4.1 追加 W2b-11d · `1f52a8a` drive-v1 的 write 模式改写 guest 路径。

### 4.8 当前状态

- main `d00b991`：245 测试文件 / 3445 例，失败 52 例（Windows-only 基线），基线 diff 空；typecheck 0。
- 与 09-10 的 `761b862` 比：66 个提交，214 个文件，+27092 / −764 行；测试文件 170 → 245（新增 75 个，另有 6 个测试帮手）。
- 版本 0.3.0；user_version 11；dependencies / devDependencies 零改动（scripts 加了 `verify:release`；链 S 加 `smoke:release`）；
  `package.json` 与锁根的 license 改为 Apache-2.0。
- 两条链合入后：main 在〔待合流后填〕，数字〔待合流后填〕。

## 5. 关键文件地图（本轮新增或职责变了的）

09-10 §5 的地图仍是底图（`ui/` 组件树、样式令牌、`mu6` 能力清单等没变）。下面只列本轮新增或职责变了的。

### 主进程（`src/main/`）

| 文件 | 管什么 | 测试 |
|---|---|---|
| `index.ts`（职责变了） | 新增：单实例锁（W1b-3）、userData 与目录下发（W1a-9）、致命行对话框（W1a-8）、唯一的 exit 监听与优雅停（W1b-5）、导航守卫与权限处理器接线（W2b-6）、崩溃钩子与按天日志（W2b-7）、`app:relaunch`（W2b-3）、更新状态与托盘回执（W2b-9）、打包版菜单（W2b-6c） | `ipc-contract`、`main-shutdown-wiring`、`main-window-guard-wiring*`、`crash-log-wiring`、`single-instance`、`main-app-dirs-wiring`、`auto-update` |
| `app-dirs.ts` | 一次算定数据根、userData、keyring 服务名（正式版 `DeskMinis`，dev `DeskMinis-dev`）、日志目录 | `app-dirs`、`main-app-dirs-wiring` |
| `nav-guard.ts` | 新窗口、页内导航、权限请求的判定纯函数：外交协议白名单、本应用页面判定（dev 按源，打包按文件）、只放行 `clipboard-sanitized-write` | `main-window-guard`（纯函数 97 例）加三个接线测试 |
| `app-menu.ts` | 打包版的最小菜单模板：只有编辑与缩放、全屏，没有重载与开发者工具 | `app-menu`、`main-window-guard-wiring-packaged` |
| `relaunch.ts` | 断线横幅「重启应用」的参数（便携版带 execPath 与 args）；「重启并安装」3 秒兜底 | `app-relaunch` |
| `minisd-stop.ts` | 优雅停止 minisd：发 shutdown、5 秒兜底 kill；QuitGate（第一次 before-quit 挡住、停完放行）；唯一的退出记录 | `minisd-stop`、`main-shutdown-wiring` |
| `minisd-fatal.ts` | 致命行的主进程一侧：认行、生成中文对话框参数（DB_NEWER、DATA_ROOT_LOCKED） | `minisd-fatal` |
| `update-status.ts` | 更新错误译成一句中文（按 electron-updater 的两层包装拆）、便携版判定、托盘回执、发布页地址 | `update-error-text`（驱动真 GitHubProvider）、`auto-update` |
| `child-output.ts` | minisd stderr 末尾 4KB 环形缓冲；按行切分（被切开的汉字拼回） | `child-output` |

### minisd（`src/minisd/`）

| 文件 | 管什么 | 测试 |
|---|---|---|
| `index.ts`（职责变了） | 拿数据根锁再装配；`denyPendingPerms` / `stopRun`（删会话与关停共用）；close 幂等与 closing 闸；`chat.sessions.applyAssistant`；MCP 改动后 `forget`；standalone 分支装崩溃钩子、认 shutdown 消息 | `session-delete-running`、`shutdown-partial-reply`、`session-apply-assistant`、`data-root-lock-minisd` |
| `fatal.ts` | 致命行的 minisd 一侧：`{"minisdFatal":{…}}` 一行，只带白名单字段，写完等 500ms 再退 | `minisd-fatal` |
| `store/db.ts`（职责变了） | `MIGRATIONS` 导出并冻结；库比应用新抛 `DbNewerThanAppError`；逐条事务 | `db-migrations-immutable`、`db-newer-than-app` |
| `store/data-root-lock.ts` | 数据根锁 `minisd.lock`：独占建锁、按 pid 判存活、陈旧锁经接管闸接管（改编自 ZCode） | `data-root-lock`、`data-root-lock-minisd` |
| `tools/data-gate.ts` | 数据根读写判定：deny（核心数据与凭据）/ free / ask（带说明）；规范化（realpath、win32 小写、剥 ADS 与尾点尾空格） | `data-gate`、`data-root-write-gate` |
| `tools/edit-text.ts` | file_edit 的纯函数：归一视图里匹配、映射回原文偏移只替换这一段、BOM、UTF-8 往返校验（改编自 pi） | `edit-text`、`file-edit-dollar` |
| `tools/files.ts`（职责变了） | 读写闸走 dataGate；file_read 的 offset/limit（建议段长 19000，切点让开代理对） | `file-read-paged`、`files-tools` |
| `tools/permissions.ts`（职责变了） | shell 只读白名单：数据根字样、远程共享路径、`env:` 提供程序、远程主机参数一律回落询问；npm 只留 ls、config get | `shell-readonly-data-root`、`shell-readonly-local-only`、`permissions` |
| `tools/shell.ts`（职责变了） | 进程树回收走 win-exec；规则拦下时回给模型的话如实，并给出 file_read / file_grep 这条出路 | `shell-kill-tree`、`shell-rule-blocked` |
| `proc/win-exec.ts` | System32 路径（taskkill、cmd、PowerShell）与进程树回收（改编自 pi） | `proc-helpers`、`shell-kill-tree` |
| `proc/child-env.ts` | shell、终端、MCP 子进程环境剥掉 `DESKMINIS_*`（不分大小写） | `proc-helpers` |
| `providers/overflow.ts` | 上下文超窗识别（pi 的 24 条正则与 3 条排除，加 429/5xx 状态闸） | `provider-overflow` |
| `providers/types.ts`、`anthropic.ts`、`openai.ts`（职责变了） | `ProviderError.code`（contextOverflow / thinkingBinding）；三个新 Claude 走 `drop_block`；DeepSeek V4 回放推理 | `anthropic-binding-controls`、`openai-deepseek-reasoning-echo`、`provider-body-golden` |
| `agent/compact.ts`、`loop.ts`、`offload.ts`、`prune.ts`（职责变了） | 增量有界压缩与拒收；溢出与绑定错误拦截、`contextFull` 带 relayDraft；读回判定与封顶；如实的桩 | `compact-bounded`、`offload-roundtrip`、`prune-stub-honest`、`agent-loop` |
| `agent/agent-message.ts` | 持久化消息 → provider 入参的唯一映射（两处各写一份时把 reasoningContent 丢了） | `openai-deepseek-reasoning-echo` |
| `agent/sanitize.ts`、`store/audit.ts`（职责变了） | URL 凭据脱敏改线性扫描 `redactUrlCredentials`，请求与审计共用 | `sanitize`、`audit`、`compact-bounded` ⑬ |
| `diag/crash-log.ts` | `crashes.json`：最多 5 条、保留 7 天、原子写（改编自 pi） | `crash-log` |
| `diag/daily-log.ts` | 按天日志 `minisd-YYYY-MM-DD.log`：按本地日期分文件、单日 10MB 停写、启动时删 7 天前 | `daily-log` |
| `diag/crash-hooks.ts` | 两个进程的崩溃钩子与「握手后意外退出」判定 `minisdExitCrash` | `crash-hooks`、`crash-log-wiring`、`crash-log-fork`、`crash-log-startup-fail`、`crash-log-window-fail`、`crash-log-logroot` |
| `mcp/config.ts`、`mcp/manager.ts`（职责变了） | 读坏拒写、写前对比磁盘、补丁语义、`renameFrom`、preview；manager 的 `forget` 与代次 | `mcp-config-corrupt`、`mcp-config-stale`、`mcp-config-edit-preserve`、`mcp-manager` |
| `skills/importer.ts`、`office/zip.ts`（职责变了） | zip 条目数、总量、单文件上限，取原始字节自己 inflate 并流式计量 | `skill-zip-bomb`、`office-ooxml` |
| `skills/prompt.ts`（职责变了） | 技能太多时的提示改指 file_list / file_grep / file_read | `skills-prompt` |
| `sync/wire.ts`、`rpc.ts`、`outbound-client.ts`（职责变了） | `sync.hello` 协议版本与能力位，对端信息存 `conn.syncPeer` | `sync-hello-version` |
| `paths.ts`（职责变了） | 锁文件名常量、`defaultDataRoot` / `defaultLogRoot` / `logRootFromEnv` | `paths`、`app-dirs`、`crash-log-logroot` |

### 渲染端（`src/renderer/src/`）

| 文件 | 管什么 | 测试 |
|---|---|---|
| `rpc.ts`（职责变了） | `onclose` → `onLost`：在途调用统一结算、之后的调用立即拒绝 | `rpc-disconnect` |
| `stores/chat.ts`（职责变了） | `runningSessions` / `midRun`（W2b-1）、`pendingPerms` 带 sessionId（W2b-2）、`connection` 与 `markConnectionLost`（W2b-3）、`relaySource` / `relayDraft` 与 `relayToNewSession`（W2a-6）、`welcomeAssistantId` 与 `applyAssistantToSession`（W2b-4）；删到最后一个会话落回欢迎页时不留「已取消」（W1b-4；按行的删除中与报错在 NavRail） | `renderer-run-tracking`、`perm-session-scope`、`renderer-disconnect`、`renderer-overflow-relay`、`renderer-welcome-assistant`、`renderer-navrail-delete` |
| `lib/perm/scope.ts` | 从待批的卡看会话：`permsOf` / `waitingSessionIds` / `waitingElsewhere`（ui/ 下读 pendingPerms 必须经它们） | `perm-session-scope` |
| `lib/steps/status.ts` | 工具步骤四态 ok / failed / interrupted / pending | `renderer-step-status` |
| `lib/steps/live.ts` | 最后一个回合是不是还可能在跑（含 settling 那一拍）；lib/ 下第一个依赖 vue 的模块，对话流与改动清单共用 | `renderer-step-status`、`renderer-workspace-changes` |
| `lib/welcome/assistant.ts` | 发送前要不要给空会话套用或解绑助手；胶囊预告哪个绑定；`applyStateOf` 从 store 组装入参 | `renderer-welcome-assistant` |
| `lib/mcp/edit.ts` | MCP 表单 → upsert / test 载荷：只带改过的字段、参数一行一个、同名拦截 | `renderer-mcp-edit` |
| `lib/tray/menu.ts` | 托盘「打开设置」「切换右栏」的订阅与退订 | `renderer-tray-menu`、`renderer-tray-wiring` |
| `lib/annotations/place.ts` | 注释层浮条与气泡的落点（原点量注释层自己的根） | `perm-session-scope` |
| `lib/artifacts/collect.ts`、`lib/eventnote/copy.ts`、`lib/models/binding.ts`（职责变了） | 改动清单按结果判（第三参必填）；按事件 code 选短句；未绑定显示「默认 · X」 | `renderer-artifacts`、`renderer-workspace-changes`、`renderer-eventnote-copy`、`models-binding` |
| `ui/StageChat.vue` | 只渲染当前会话的卡；顶部「另有 N 个会话在等你批准」（在滚动区之外）；步骤状态与「已中断」；错误条按 code 分流 | `perm-session-scope`（模板 AST）、`renderer-tool-steps`、`renderer-overflow-relay` |
| `ui/AppShell.vue` | 断线横幅（标题栏下方独立一行）；托盘两条通道 | `renderer-disconnect`、`renderer-tray-wiring` |
| `ui/Composer.vue` | `takeRelay`（接力草稿只在 setup 取一次、不替用户发送）；`applyStateOf`；断线置灰与交代 | `renderer-overflow-relay`（语法树）、`renderer-welcome-assistant`、`renderer-send-session-switch`（真跑 send） |
| `ui/NavRail.vue`、`ui/WorkspacePanel.vue`、`ui/TaskPanel.vue` | 行上盾牌标与删除中；改动清单；计数只数当前会话 | `perm-session-scope`、`renderer-navrail-delete`、`renderer-workspace-changes` |
| `ui/TerminalPane.vue` | `linkHandler`：中文确认框给规范形地址与真实主机，确定后 `window.open` 交给主进程 | `renderer-terminal-links`、`renderer-honest-copy` |
| `ui/settings/SecMcp.vue`、`SecAbout.vue`、`SecPermission.vue`、`ui/ModelBar.vue`、`ui/EventNotes.vue`、`StageCron.vue`、`StageDevices.vue` | 读坏横幅与表单；更新状态文案；档位副标题如实；「默认模型」标签；接力与短句；文案按代码改正 | `renderer-mcp-settings`、`auto-update`、`renderer-settings-modal`、`renderer-modelbar-default`、`renderer-compact-failed`、`renderer-honest-copy` |

### 脚本与仓库根

- `scripts/verify-release.mjs`：发布四件与随包文件的八项校验，任一 FAIL 退 1（`verify-release`、`m5-packaging`）。
- `scripts/smoke-release.mjs`：发版冒烟四用例（`smoke-release`），链 S，〔待合流后填〕。
- `scripts/e2e-acceptance.mjs`、`e2e-m2b-acceptance.mjs`：握手循环认 DATA_ROOT_LOCKED 致命行并给可照做的提示。
- `electron-builder.yml`：publish 的 repo 改为 `deskminis-releases`；extraResources 加 `LICENSE.txt` 与 `THIRD-PARTY-NOTICES.md`。
- `THIRD-PARTY-NOTICES.md`：改成「每个上游一节一张表」，文末附登记格式；pi-mono 表 4 行（edit-text、overflow、win-exec、crash-log），
  ZCode 表 1 行（data-root-lock）；「仅借思路」一节有 AionUi 与 deepseek-harness，**还没有 OpenCode**（§6 待办）。
- `docs/RELEASE.md`：发版检查单；§0 九步总清单与 §2 冒烟一节随文档链进 main（〔待合流后填〕）。

### 守卫地图补充（本轮新增，动相关代码必看）

- `license-consistency`：NOTICES 双向绊线、随包依赖许可与锁逐包对账、extraResources 的源文件存在。
- `deps-frozen`：依赖两张表与锁根的快照。
- `provider-body-golden`：OpenAI 兼容与 Anthropic 非目标模型请求体的 sha256 表。**它的夹具自带冻结的工具定义，钉的是请求整形，不钉真实工具定义**
  （W1b-2d 改 file_read 定义时没有翻红）。
- `db-migrations-immutable`、`db-newer-than-app`：历史迁移逐条 sha256；库比应用新时一字节不写。
- `main-window-guard-wiring`（未打包、走 loadFile）/ `-dev`（设了 `ELECTRON_RENDERER_URL`）/ `-packaged`（`isPackaged` 为真）、
  `main-shutdown-wiring`、`crash-log-wiring`、`single-instance`：
  主进程接线的行为测试加结构钉（例如 exit 监听只一个、第一句无条件写退出记录；两道窗口守卫在加载之前）。
- `perm-session-scope`：模板 AST 判权限卡与提示行不挂在任何条件分支下；ui/ 下读 pendingPerms 必须经 scope 三函数。
- `renderer-overflow-relay`：在语法树上钉「接力草稿只在 setup 顶层取一次、不用 watch、不替用户发送」。
- `renderer-welcome-assistant`、`renderer-model-groups` Z5：输入卡入参与胶囊的调用形态。
- `readme-claims`：README 里能机器核对的三条（不写死测试例数；提到 mDNS 就必须真有实现；下载链接与 `publish` 段是同一个仓库），文档链带进来，〔待合流后填〕。
- 09-10 的守卫地图（mu6 双向绊线、全树扫描类、各源码守卫）照旧有效。

## 6. 排期与候选池（2026-09-25 对过账）

### 一档：发 0.3.0

**主会话先做（云端）**：
1. 合入链 S 与文档链〔待合流后填〕；合流后 typecheck、全量基线比对，有界面改动的重拍 xvfb。
2. 合流后小修（草稿区 `pending-boundaries.md`）：NOTICES §2 补一句「theme.css 的色值、字号、圆角同样取自 AionUi」
   （T1 `d06c74b`、T7 `999bb5c`）；NOTICES §5 补登 OpenCode（MIT）：标题栏窗控形制借思路、W2b-11a 的「历史中断工具」语义借 failInterruptedTools 思路。
3. ~~本轮剧本入册~~ 已做：17 个剧本与步骤工作流在 `docs/handoff/driver/hemostasis/`（docs `272e84c` 与交接提交），
   两份 driver README 补了 userData 在 `<DATA_DIR>/electron`、同一数据根同时只能开一个应用、打包形态单实例锁不随数据根分开。
4. ~~lifecycle.md 前提订正~~ 已做：事实清单「渲染端没有 window.open」句后加了 2026-09-25 订正（docs `272e84c`）。

**用户在 Windows 上做**（设计稿 §5；RELEASE.md §0 九步清单随文档链进 main）：
1. 在 GitHub 新建**公开**仓库 `lincheuk/deskminis-releases`，放 README、LICENSE、THIRD-PARTY-NOTICES、CHANGELOG 四个文件。
2. 真机构建自测：`npm ci` → `npm test`（52 例 Windows-only 也必须过）→ `npm run typecheck` → `npm run dist`。
3. 打包验收：`npm run e2e:m5`（**必须重跑**，R 波之后的结论全部过期）、`npm run verify:release`，全 PASS。
4. 发版冒烟：设 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY` 后 `npm run smoke:release`，没有 FAIL
   （Fable 5.1 / Opus 5.5 多轮工具调用加 memory_write、DeepSeek V4 多轮工具调用、`C:\Program Files\…` 的 MCP 试连、`ping -t` 停止后无残留）。
5. 手动冒烟（RELEASE.md §3）：安装版与便携版各一遍。顺带补看只有真机才看得到的（§8 D）。
6. 根 `CHANGELOG.md` 的「0.3.0 — 待发布」改成发布当天的日期，提交到源码仓。
7. 在公开仓库建 Release `v0.3.0`（不能是 draft、不能勾 pre-release），传 `Setup.exe`、`Setup.exe.blockmap`、`portable.exe`、`latest.yml` 四件。
8. 把四件下载回空目录，`npm run verify:release -- --dist <目录>`（第 7、8 项 SKIP 属正常）。
9. 装好的新版里「设置 → 关于 → 现在检查」显示「已是最新」。

真机暴露的问题只修阻断项，不加功能、不加迁移（路线 W3）。

### 二档：发版之后的路线（照 9/24 路线，按 9/25 两份报告调整）

| 子波 | 内容 | 发版 | 本轮带来的调整 |
|---|---|---|---|
| W4a | 随包办公内容包：3–4 个办公技能、2–3 个办公助手，默认关 | 0.3.1 | — |
| W4b | SSR 渲染测试层 spike；FakeProvider 按 modelId 的脚本队列；完整请求体快照 | | 黄金快照的非目标模型部分 W2a-0 已做；W4b 之后排「界面减法」子波（砍终端入口与 ☰ 钮，见拍板 O1） |
| W4c | provider 正确性：错误分类（pi 为主：配额耗尽不重试、Retry-After 超过 60 秒直接降级、溢出判定排在重试之前）、思考参数按代际建表、OpenAI compat 矩阵、usage 补缓存读写、报文脱敏 | | 次基准改 pi（四家 §4 第 1、2、13 条） |
| W5a–c | 上下文管线定向重写：结构化增量压缩（pi 摘要算法）、熔断取代次数上限、溢出先压缩再同槽重试一次（补两种静默溢出）、usage 锚点水位、shell 输出只留尾部完整落卸载目录、前缀只追加与 AGENTS.md 信任卡、一次追加迁移 | 0.4.0 | file_read 分段已在 W1b-2d 做掉；输入区占用环从 W9c 提前到 W5b，同子波删任务面板、右栏收成两个 tab（拍板 O5） |
| W6a–d | 运行时韧性：launcher 与崩溃预算、自动重连、会话快照与 seq、按订阅投递、执行面硬化（realpath 围栏、子进程擦凭据、web_fetch 钉地址）、删终端后端 | | W2b-3 只做了断线横幅与手动重启，W2b-7 只记崩溃不重启；会话事件表放 W6c（拍板 O3） |
| W7a–c | 人在回路：副作用调度、stale 守卫、结果三分类、悬空工具落库为中断、steer / queue、等待态徽标与系统通知、审批停靠输入区、拒绝级联与重评与附言、todo 与计划条、回合折叠 | 0.5.0 | W2b-2 只做了按会话区分与提示行；工具输出进度流待拍板（F1） |
| W8a–c | cowork 结构与可撤销：空会话助手态、写前检查点与一键回退、先读后写、消息级操作、墓碑与归档、正文搜索、用量面板、MCP 密钥外置 | | W2b-4 是最小修，结构修在 W8a；右栏默认收起在 W8a 再议（拍板 O6） |
| W9a–c | 渲染与打磨：帧合批与增量解析、Markdown 补全与轻量高亮、快捷键、可拖分栏、模型选择器、思考档位胶囊、窗控随主题与缩放 | 0.6.0 | 托盘两条通道已在 W2b-11a 接上，W9b 那一项去掉 |

0.6.0 之后逐项先出设计稿：备份与恢复、视觉与内置浏览器、计划模式、会话分叉（ZCode 主、pi 次）、只读子代理、Goal、单窗口分屏、图片生成。

### 待用户拍板（9 项，每项有默认建议）

来自 `docs/research/2026-09-25-opencode-v2-baseline.md` §4（O1–O7）与 `docs/research/2026-09-25-four-way-baseline.md` §4（F1–F2）。

| # | 事项 | 默认建议 | 现状 |
|---|---|---|---|
| O1 | 底部终端抽屉砍不砍 | 砍，分两步：W4b 之后的界面减法子波先删入口，W6d 再删引擎侧与 xterm 依赖；0.3.0 的 CHANGELOG 不把终端写成亮点 | 0.3.0 一件不裁（刚在 W1b-1 加了进程树回收）；文档链的 CHANGELOG 草稿已把终端那句改成如实描述 |
| O2 | 历史回合里没有结果的工具显示成「成功」，0.3.0 修不修 | 修 | 已按默认做了（W2b-11a `4e20153`），用户可否决 |
| O3 | 会话事件表放哪次迁移 | W6c，与 W7a 的收件箱表合成 0.5.0 唯一一次追加迁移 | 未动 |
| O4 | 是否采纳 13 行基准分工表，并据此改写路线各波的「借鉴」行 | 采纳；0.3.0 之后先补一份逐条标明落地状态的 OpenCode V2 研读稿，再改路线；NOTICES「仅借思路」补登 OpenCode | NOTICES 补登排在一档的合流后小修 |
| O5 | 上下文占用环从 W9c 提前到 W5b，同一子波删任务面板、右栏收成两个 tab | 是 | — |
| O6 | 右栏默认展开还是收起 | 0.3.0 保持展开、只改注释；收起留到 W8a 设计稿再议 | 注释已在 W2b-11a 改正 |
| O7 | 工具步骤组要不要改成只折叠只读类工具 | 不改，保持整组折叠，组头加「写了 N 个文件 / 跑了 N 条命令」摘要（W7c） | — |
| F1 | W7c 加不加「工具输出进度流」 | 加：长命令跑时步骤展开区能看到输出尾部在动；照抄 pi 约 80 行发布器，登 NOTICES §3；代价是 0.5.0 多一项 | — |
| F2 | 是否采纳 21 行分工表 | 采纳：同 O4，范围从 13 行扩到 21 行，第 7 行次基准由 OpenCode llm 包改为 pi | 四家 §4 第 17 条（订正借鉴栏里「列了没借」的四处）等它拍板后做 |

### 其它悬空

- **9/24 报告 §7「可以晚点定」十二项**仍悬着（零依赖对 katex、mermaid、vue-tsc、playwright-core 破不破例；Windows CI；办公包默认开关；
  新一代 Claude 思考默认显示摘要；运行中发送的默认语义；已配对设备能否批准本机权限卡；danger 操作；归档优先与墓碑；新状态进不进同步；
  备份排期；main 放不放 AGENTS.md；agent 能否自建定时任务），默认建议见该报告。
- **本轮施工留下的小裁定**：终端链接确认框的按钮是 Electron 写死的英文「Ok / Cancel」（要中文得改走主进程对话框，多一条 IPC）；
  合法中文域名在确认框里显示成 punycode；`openInSystem` 要不要节流；README 要不要写 MCP 的 env / headers 可用 `$$变量名` 引用环境变量
  （界面没提供，改环境变量要从托盘退出再开）。
- **09-10 就悬着的**：docs 分支合入 main 的方式；brave / tavily 真 key 首跑验收。（「仓库转 public」已由公开发布仓库取代。）
- **09-10 候选池的去向**：办公技能包 → W4a；vue-tsc 立项评估 → 上面十二项里的零依赖破例；会话正文全文搜索、用量与成本面板 → W8c；
  genui、多窗口对话墙（改单窗口分屏）、图片生成、内置浏览器 → 0.6.0 之后；预览区 T10 遗留与「其它仍未做」多数落在 W8、W9，其余照旧在池里；
  「收窄」九条照旧。09-10 一档补充的两件（欢迎页选助手撒谎、ModelBar 与胶囊矛盾）本轮 W2b-4、W2b-5 已修。

## 7. 教训（本轮新增，09-10 的 12 条仍然有效）

1. **自动合并不等于合对了**。D2 合流时两边都在 `send()` 里加了 `const sid = this.activeId;`，git 无冲突地合出了重复声明（`14236f9`）。
   → 每次合流后必跑 typecheck 与全量；热点函数逐段看合并结果。落在 `.vue` 里的同类问题 typecheck 看不见，只能靠 build 与测试。
2. **源码守卫被注释喂饱的形态比想的多**：HTML 注释里放真 title（W2b-5b）；行尾 `// portable: '…'`（W2b-9）；冒号后紧跟 `//` 的真注释、
   字符串里的 `'/*'` 开出假块注释、模板里提前结束的注释（W2b-4c）；字符串里的 `'a//'` 被按行剥注释连带剥掉后面的真代码（W2a-6b）；
   散文里带反引号的包名喂饱「列全」（W1a-1）；别处代码里同名的 `error:` 喂饱文案检查（W2b-9）。
   → 剥注释走语法树；「不许出现」类查原文；断言锚结构；变异自检里专门放「注释喂食」变异。
3. **容器是 UTC，按本地日期的逻辑测了等于没测**。按天日志改成按 UTC 算照样全绿（W2b-7 三审）。
   → 涉及本地日期的测试把 TZ 钉在 Asia/Shanghai，并先断言确实生效。
4. **Linux 上盘符路径会变成相对路径**。drive-v1 的 write 模式让 file_write 写 `C:\Users\me\Documents\notes.txt`，Linux 上落进应用目录，
   随 `a3adb6c` 进了仓库，W1b-2g 才删；变异时用 posix 的 `path.join` 拼盘符路径也被折叠，变异没生效（W1b-2c）。
   → 剧本以临时目录为 cwd；Windows 路径用 `path.win32` 或字面量；跑完先 `git status`。
5. **并行链改同一文件，冲突要按语义合**。NOTICES 的 pi-mono 表三条链各加一行；`StageChat.vue`、`main/index.ts` 的 import 区；
   `stores/chat.ts` 的 `send()` 与删会话。
   → 分链时按改动文件分，热点文件尽量只归一条链；合流正文逐条写冲突与处置；合流后全量，有界面的在合并后的构建上重拍。
6. **审查会一路追到刻意混淆的写法**。W2a-6b 三轮审查累计 44 个变异、W2b-4b 累计 27 个，追到 HTML 实体、`\u` 转义、`arguments` 反射；
   守卫越写越死，W2b-4b 那一段「分支里加任何一行都得同步改守卫」。
   → 施工前先定守卫防什么（设计稿 §1 第 8 条），刻意混淆列 nit，由行为测试与代码审查兜底。
7. **utilityProcess 退出前的最后一行 stdout 会丢**。写回调里立刻 exit，0ms 时 11 次丢 10 次（W1a-8）。
   → 致命行写完等 500ms 再退；关键信息别只靠退出前的最后一次写。
8. **异步的 `showMessageBox` 点完可能 30 秒后才 resolve**（应用空闲时要等下一个事件唤醒，W1a-8）。
   → 启动已失败、没有窗口的场合用 `showMessageBoxSync`。
9. **侦察前提要拿构建产物核**。W2b-6 依据侦察「渲染端没有 window.open」，漏了 xterm 自带的 defaultActivate，终端链接从此点了没反应，三审才逮到（W2b-6b 修）。
   → 说「代码里没有 X」之前，grep 一遍 `out/renderer` 的产物，第三方包的代码也算。
10. **状态切换的那一拍会闪假状态**。running 落下到历史重取回来之间，最后一个回合的工具会被判「已中断」（W2b-11a 的 settling、W2b-11d 的间隔）。
    → 判「还在不在跑」要看历史换没换，不只看 running；xvfb 里装 MutationObserver 记闪没闪。
11. **截断后进历史的字符串要让开代理对**。非法参数的回显截在 emoji 中间，孤立代理项留在历史里，严格的 JSON 端之后每轮都 400（W1b-2f）。
    → 切点前一位是高代理项就少取一位；测试里放 emoji。
12. **每次请求都跑的正则必须是线性的**。URL 凭据正则在长单行上是平方级：20 万字一行 23 秒，审计那份 11 秒，压缩测试曾因它跑 15.6 秒（W2a-1、W2a-7、W2a-7b）。
    → 加「20 万字符单行 300ms 内」的性能钉；改写时拿原正则做规格基准，逐码元对拍。
13. **xvfb 与 playwright 的盲区**：没有窗口管理器，focus、minimize 不产生事件（W1a-5、W1b-3）；看不到原生对话框（W1a-8）；
    会把 NODE_OPTIONS 从环境里拿掉（W2b-7）。
    → 派发事件证明接线、ctypes X11 小工具点原生框、注入件直接 spawn 构建产物；真窗口行为写进真机清单。
14. **拿手拼的错误形状测第三方库会测错**。electron-updater 把 `/releases/latest` 的失败先包一层再包一层，测试里手拼的形状全是假想的（W2b-9 审查）。
    → 驱动真的 provider，执行器换成按路径应答的桩，并钉住错误码。
15. **子 agent 说明写攻击路径会被安全审核误判**（本轮一次）。
    → 说明与设计稿用中性工程措辞，写工程目标，不写利用细节（§2 C 组第 5 条）。

## 8. 已知风险与技术债

### A. 写进 CHANGELOG 的已知边界（设计稿 §6）

- 思考档位仍无界面入口；除三个目标模型外，Opus 4.7/4.8/5、Sonnet 5、Fable 5 在带思考档位的远端调用下仍会发 `budget_tokens`（W4c）。
- 系统提示仍每步重建（W5）：第三方端点上的新账号靠「剥思考重试」维持，官方端点靠 `drop_block`，首轮成本与延迟会上升。
- 溢出时只降级到更大窗口或报「上下文已满」给出接力，还没有「强制压缩后同槽重试」（W5）。
- 删除会话不删磁盘上的 `sessions/<id>/`；MCP 改名不迁移会话级禁用名单。
- 数据库降级守卫只对装过 0.3.0 之后再回退的情况有效。
- 设备同步默认只监听本机，跨机器需设 `MINISD_HOST`，界面暂无开关；记忆文件不同步。
- 数据根是 UNC 路径时，文件工具按相对路径处理并以穿越拒绝，读不到技能与卸载文件。
- 技能索引里 path 元素的值按 XML 转义，用户名含 `&` 时模型照抄进 file_read 会失败（旧问题）。
- URL 凭据脱敏：多行文本先脱敏、后剥 `\v`、`\f`，凭据本身夹着这类字符时口令不打码（现实里碰不到）。

### B. 待写进 CHANGELOG / README 的（草稿区 `pending-boundaries.md`，W2b-11c 收）

- 「不替用户发送」只在 `takeRelay` 体内有源码守卫，输入卡其它位置的自动发送没有守卫（测试范围，用户看不见）。
- 刻意混淆的写法不在源码守卫范围（设计稿 §1 第 8 条）。
- **危险命令只按写法认**：Format-Volume、Clear-Disk、`[IO.File]::Delete` 这类没列进表的写法判 gated，经 `cmd /c` 转一手也认不出——
  前两档照常弹卡，「完全访问」下直接执行（设置页已如实写）。
- **数据目录的闸只管文件工具**（`file_*`、`office_*`）：shell 与 MCP 不走它，完全访问下不问；只读 shell 用 `..\..\..` 或 `DeskMi*` 通配点到数据目录时认不出
  （文档链的 CHANGELOG 草稿已写）。
- 只读命令的间接读取看不见：`-OutVariable` / `-PipelineVariable` 写变量、`findstr /F:` 清单文件，能在下一条只读命令里读到远程或 `env:` 路径而不询问。
- 部分克隆（promisor）仓库里，只读的 git 命令会按需连远端取对象。
- 「每次确认」与「本会话沿用」两档网关行为相同，差别只在权限卡上预选的按钮。
- 设备同步不传播删除：一台机器上删掉的会话，已配对设备再推送时会回来（`chat-store.ts` 的 `mergeRemoteSession` 遇到本地没有的会话直接插入）。
- MCP 服务器的 env / headers 以明文存在 `mcp-servers\servers.json`（可写 `$$变量名` 引用环境变量，界面未提供）。
- 左栏收起时，在欢迎页或设置页看不到别的会话在等批准（会话页有提示行，左栏展开时行上有盾牌标，W2b-2 遗留）。
- 卸载后 `%LOCALAPPDATA%\deskminis-updater`（安装程序副本与更新下载缓存）不会被删。

### C. 各步审查与申报里留下、影响真实使用的（未处理）

- **minisd 崩溃或被强杀时，shell 里起的长命令会留下**：libuv 的作业对象带 SILENT_BREAKAWAY_OK，只有它亲手放进去的直接子进程跟着退，
  `ping -t` 这类孙进程照样活着；`proc/win-exec.ts` 头注释「minisd 一退出整棵树由系统回收」与此不符。优雅关停走 taskkill `/T`，不受影响。
  出处：`followup-notes.json` 的 W3-smokeb nits 末条（冒烟脚本自己的注释已在 W3-smokeb 改正）。
- **MCP 保存时静默丢三样**：解码失败的条目、servers.json 顶层的其它键、数字参数（侦察里的 W1a-mcplossy 没做）。出处：W1a-6 `a757177` 偏差 9。
- MCP 改名同样不迁移 `market_installs.local_ref`，改名后市场对它的更新追踪丢失。出处：W1a-6 偏差 11（设计稿 §6 只写了禁用名单）。
- servers.json 刚被外部写坏、还没人重读时，调用照旧按内存里上次读到的配置判启停。出处：W1a-6 偏差 13。
- 同会话 `open()` 在回合中途会清空流式正文与步骤卡却不置 midRun：回合跑着时点一下当前会话，正文从半句开始长。出处：W2b-11a `4e20153` 已知边界。
- 渲染端在回合中途重载后，下一个事件到达之前，在跑的工具先显示「已中断」、停止键缺席；设备同步过来的在跑回合同样先标「已中断」。出处：同上。
- 断线横幅只在连接断开时出现：minisd 卡死但 socket 没断不会触发（没有心跳，W6）。出处：W2b-3 `0b1db3a` 偏差 8。
- 在 A 上点停止、又在 A 的发送被拒之前切走，A 那条话既不交回输入框也没落库。出处：W1b-4 `00e33d1` 偏差 11。
- `chat.cancel` 不了结权限卡：点停止后卡还在，要等用户点或 90 秒超时。出处：W1b-4 偏差 8。
- 「重启并安装」停引擎那几秒（最坏 5 秒）窗口仍可见可点；这段时间横幅上的「重启应用」是个空按钮。出处：W1b-5 `1b411d4` 偏差 9、W2b-3 偏差 5。
- 「≥30 条保留 14 条」的压缩规则，锚点可能落在 toolUse 与 toolResult 中间（旧行为）。出处：W2a-1 `6cb83b5` 待决问题。
- file_write 写回会丢 BOM；file_read 会把 U+FEFF 交给模型。出处：W1a-2 `95fef05` 已知边界。
- 「新建会话接力」的新会话用自己的沙箱，旧沙箱里的文件不随过去。出处：W2a-6 `c8d9e30` 偏差 6。
- `openInSystem` 没有节流：渲染端循环 `window.open` 会不停拉起系统浏览器。出处：W2b-6 三审 nit（followup-notes 的 W2b-6b 键）、W2b-6b 留给主会话。
- `will-redirect` 与子框架导航没设守卫（打包后是 file://、应用里没有 iframe）。出处：W2b-6 `fd24dd4` 留给主会话。
- 崩溃记录：Windows 注销或关机不触发 before-quit，可能多记一条 minisd_exit；主进程与 minisd 同写 `crashes.json` 理论上可能丢一次更新；
  stdout 按块解码可能切坏多字节字符；陈旧的 `crashes.json.*.tmp` 无人清；Windows 上 rename 被占用时静默丢一条；日志含路径与错误原文，只落本地，
  诊断包导出时要脱敏（W6a）。出处：W2b-7 `a4bd5d3` 偏差 11、W2b-7b `5fe86de` 偏差申报。
- 权限提示行：最后一刻点允许与超时的竞态、连点提示行后焦点落到 body（W2b-2 三审 nit，`bf20044` 偏差申报）。
- MCP 设置页：用「先删后写」方式保存的编辑器有极短窗口，这时列表可能空一次、市场可能清掉登记行（W1a-5 `9563fa5` 偏差 4）；
  开关被拒写时错误行与横幅同一句出现两次（W1a-5 偏差 8）。
- 开发与测试侧：`e2e-acceptance`、`e2e-m2b` 仍默认读正式版的数据根与 keyring，要读 dev 的数据得同时设 `DESKMINIS_DATA_DIR` 与
  `DESKMINIS_KEYRING_SERVICE=DeskMinis-dev`（W1a-9 `48097bb` 已知风险）；dev 下「重启应用」拉起的新进程脱离 electron-vite 的 dev server（W2b-3 偏差 8）；
  主进程守卫仍用正则版 `strip-comments.ts`（W2b-4c 偏差）；`provider-body-golden` 不钉真实工具定义（§5）。
- 代码卫生（不影响用户）：`minisd/index.ts` 里上下文窗口的回落值仍写死 `128_000`，没有引用 `FALLBACK_WINDOW`（W2a-1 偏差 7）；
  `provider-body-golden.test.ts` 文件头「AgentMessage 还没有这个字段」已过时（W2a-4 偏差 1）。

### D. 只有 Windows 真机能确认的推断

- 打包后的 minisd 自己没有控制台，子进程不加 `windowsHide` 会弹出控制台窗口（W1b-1 偏差 10，已加，未实测）。
- 设置页 MCP 一节在「切回窗口」时重拉（W1a-5 偏差 2，xvfb 只能派发事件）；「最小化后唤出」（W1b-3 偏差 10）。
- 便携版：`PORTABLE_EXECUTABLE_DIR` 真由启动器设上、「重启应用」重启的是外面那个便携 exe（W2b-9、W2b-3 偏差 4）。
- `Program Files` 与中文用户名下的 file:// 本应用判定与 `fileURLToPath` 还原；`main-window-guard-wiring*` 接线测试的 Windows 语义
  没法在 Linux 模拟，要等真机的 `npm test`（W2b-6 留给主会话）。
- NSIS 的真实下载、校验不符；打包版菜单下输入框的 Ctrl+C / Ctrl+V（W2b-9 偏差 6、W2b-6b 偏差 6）。
- 路线 W3 列的真机手测：杀进程树、双击启动两次只剩一个实例、DB_NEWER 提示；另记录同名 exe 劫持与 junction 逃逸能否复现（修复在 W6d）。

### E. 仍有效的旧账

- **打包验证已过期**：R 波的 asar 结论对 0.2.0 快照，之后 S–Z 与止血波都改过打包相关的东西。**0.3.0 发布前 `npm run e2e:m5` 必须重跑。**
- 反向同步（持数据方是监听方这一向）仍只有 `tests/auto-sync.test.ts` 单测，没有 e2e。
- `--win` 交叉构建在 Linux 不可行（`spawn wine ENOENT`，证据 `docs/handoff/r3-win-crossbuild-fail.log`）；tag 推送被 403 拒，tag 走 GitHub Release 自动创建。
- **0.1.1 的用户收不到自动更新**：0.1.1 写死的更新源是私有源码仓，检查永远 404，要手动装一次 0.3.0 之后才走新源。
