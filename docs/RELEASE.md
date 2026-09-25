# 发布检查单（Windows 真机）

> 章程：**只在 Windows 真机发布验证**。云端已把源码态做到发布就绪
>（版本号 / 图标 / CHANGELOG / 打包结构与 asar 态冒烟全验证过），
> 但安装包必须在 Windows 上构建——electron-builder 在 Linux 交叉构建
> Windows 目标需要 wine（已实测确认不可行），且随包桥 / keyring 均为 Windows 原生件。
>
> ⚠️ **云端的打包结构验证是 R 波（0.2.0）那个快照做的，之后又落了 S–Z 各波（界面整体重建、新增 Office 模块）
> 与发版前的止血波 W1a–W2b（进程树回收、单实例与数据目录锁、优雅退出、更新源改公开仓库、许可随包等）。
> 0.3.0 发布前第 2 节的 `e2e:m5` 必须重跑，不能沿用旧结论。**

## 0. 发版总清单（0.3.0，照着做）

按顺序做，每一步的细节在后面对应的节里。任何一步有 FAIL 就停下，先处理再往下走。

1. [ ] **首次**：在 GitHub 新建**公开**仓库 `lincheuk/deskminis-releases`（只放发布资产），
       放进仓库根的 `README.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`CHANGELOG.md` 四个文件（第 4 节第 1 步）。
2. [ ] Windows 真机上构建并自测（第 1 节）：`npm ci` → `npm test`（Linux 上跑不了的 52 例 Windows 专属用例在这里也要全绿）
       → `npm run typecheck` → `npm run dist`。
3. [ ] 打包验收（第 2 节）：`npm run e2e:m5`、`npm run verify:release`，全 PASS。
4. [ ] 发版冒烟（第 2 节「发版冒烟」）：设好 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY` 后跑 `npm run smoke:release`，
       结果表里没有 FAIL。它替代以前手工做的四件事：Anthropic 官方端点跑 Fable 5.1 / Opus 5.5 多轮工具调用加一次
       `memory_write`、DeepSeek V4 多轮工具调用、参数带 `C:\Program Files\…` 的 MCP 试连、shell 里起 `ping -t` 后点停止不留残留。
5. [ ] 手动冒烟（第 3 节）：装好安装版与便携版各点一遍。
6. [ ] 把根 `CHANGELOG.md` 里 `## 0.3.0 — 待发布` 的「待发布」改成发布当天的日期，提交到源码仓。
7. [ ] 在公开仓库建 Release `v0.3.0`（不能是 draft、不能勾 pre-release），上传 `Setup.exe`、`Setup.exe.blockmap`、
       `portable.exe`、`latest.yml` 四件（第 4 节第 2–4 步）；同步更新公开仓库里的四个文件（第 4 节第 1 步）。
8. [ ] 把 Release 的四件下载回空目录，再跑一次 `npm run verify:release -- --dist <目录>`（第 4 节第 5 步）。
9. [ ] 在装好的新版里点「设置 → 关于 → 现在检查」，应显示「已是最新」（第 4 节第 6 步）。

## 1. 构建

```powershell
git clone https://github.com/lincheuk/Deskminis && cd Deskminis/deskminis
npm ci            # postinstall 自动 electron-rebuild better-sqlite3
npm test          # Windows 上应全绿（Linux 上有 52 例平台性失败是正常的，Windows 上这 52 例也必须过）
npm run typecheck
npm run dist      # 产物在 dist/：Setup.exe + Setup.exe.blockmap + portable.exe + latest.yml
npm run verify:release   # 紧接着核对 dist/ 这四件与随包文件，全 PASS 才往下走（见第 2 节）
```

- 若 `dist/` 被其它进程占用（EBUSY）：构建到临时目录，再用
  `$env:DESKMINIS_M5_UNPACKED` / `$env:DESKMINIS_M5_SETUP` 指向产物跑验收，
  发布校验用 `npm run verify:release -- --dist <临时目录的绝对路径>`（见下）。

## 2. 打包验收与发版冒烟（自动断言）

```powershell
npm run e2e:m5
npm run verify:release
```

`e2e:m5` 覆盖：extraResources 桥件随包、原生模块 asar 解包、打包态垫片 stdout / 退出码、
含空格安装路径。全 PASS 才继续。

`verify:release`（`deskminis/scripts/verify-release.mjs`，零依赖）逐项核对 `dist/`，每项一行 PASS / FAIL / SKIP，
FAIL 后面写着中文原因；有 FAIL 退出码 1，**有一项 FAIL 就不能上传**：

1. `latest.yml` 在——electron-updater 靠它发现新版，漏了自动更新就永远查不到；
2. 能按 electron-builder 的输出形状读懂它（认不出的结构直接 FAIL，不去猜）；
3. 里面的 `version` 等于 `package.json` 的版本（不等说明 `dist/` 里是旧产物）；
4. `files[0]` 是 `DeskMinis-<版本>-Setup.exe`，安装包的大小与 sha512 和 `latest.yml` 记的一致，
   顶层 `path` / `sha512` 与 `files[0]` 一致——sha512 不符照样上传，所有用户下载完都会报 `ERR_CHECKSUM_MISMATCH`；
5. `Setup.exe.blockmap` 在、是 gzip、块长之和等于安装包大小（不是旧安装包的块表）——缺了下一版没法差分下载；
6. 便携版 `DeskMinis-<版本>-win-x64-portable.exe` 在且非空；
7. `win-unpacked/resources/app-update.yml`（装到用户机器上的更新源）与 `electron-builder.yml` 的 `publish` 段一致，
   且不是私有源码仓 `lincheuk/Deskminis`——这一项装上就改不了，是最后一道闸；
8. 随包的 `LICENSE.txt` 与 `THIRD-PARTY-NOTICES.md` 在 `win-unpacked/resources/` 下，且与仓库根的原件一致。

四件必须出自同一次 `npm run dist`：**不要单独重新打包其中一件**（比如只重打安装包），`latest.yml` 与 blockmap 记的是那一次的安装包。

### 发版冒烟 `npm run smoke:release`（真 key）

`deskminis/scripts/smoke-release.mjs` 把「真 key 冒烟」做成一条命令：先构建（electron-vite build），再用 electron 以
node 模式起引擎（`out/main/minisd.js`），经 WebSocket 走 JSON-RPC 跑下面四个用例。在 `deskminis/` 下的 PowerShell 里：

```powershell
$env:ANTHROPIC_API_KEY = "<你的 Anthropic key>"   # 用例 anthropic 要它；不设就标「跳过（缺 ANTHROPIC_API_KEY）」
$env:DEEPSEEK_API_KEY  = "<你的 DeepSeek key>"    # 用例 deepseek 要它；不设就标「跳过（缺 DEEPSEEK_API_KEY）」
npm run smoke:release
Remove-Item Env:ANTHROPIC_API_KEY, Env:DEEPSEEK_API_KEY   # 跑完清掉；这样设的变量只在当前这个 PowerShell 窗口里有效
```

用例（缺对应环境变量的标「跳过（缺 XXX）」，不算失败）：

| 用例 | 要什么 | 测什么 |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Anthropic 官方端点，Fable 5.1 与 Opus 5.5 各跑一个多轮会话：至少两次工具调用（工作区里 `file_write` 再 `file_read`）和一次 `memory_write`。断言回合正常结束、没有 error 事件、工具结果成功、记忆文件里有约定的标记——新一代 Claude 的思考块绑定（`drop_block`）在真端点上过得去 |
| `deepseek` | `DEEPSEEK_API_KEY` | DeepSeek V4 多轮工具调用，第二轮起不报 400——历史里的 `reasoning_content` 回传对了 |
| `mcp-spaces` | 不要 key | 脚本把一个最小的 stdio MCP 服务器写进带空格的目录（Windows 上 node 本身多半也在 `C:\Program Files\nodejs\`），登记后能连上并列出工具 |
| `shell-stop` | 不要 key | 用本地假端点让模型调 `shell_execute` 跑长命令（Windows 上是 `ping -t 127.0.0.1`），然后取消这一回合；断言几秒内进程树里没有残留的 ping |

- **隔离**：数据根一律是新建的临时目录（`DESKMINIS_DATA_DIR`），凭据写在服务名 `DeskMinis-smoke-<pid>` 下
  （`DESKMINIS_KEYRING_SERVICE`），结束时删掉脚本写进凭据库的条目和临时目录；不碰你真实的数据目录与凭据，
  日志与输出里不出现 key。真 key 会产生几次付费调用。
- **结果**：最后打一张通过 / 失败 / 跳过表，任一用例失败退出码非 0。**有失败就不发版**，先按表里写的原因处理。
- **`--mock`**：`npm run smoke:release -- --mock` 让 `anthropic`、`deepseek` 两个用例改连脚本自己起的本地假端点
  （Anthropic 与 OpenAI 兼容各一个，按剧本回工具调用），不要 key、不花钱——用来确认脚本本身能跑（Linux 上也行），
  **不能代替真 key 那一遍**。

## 3. 手动冒烟（安装版）

- [ ] 干净机器 / 干净目录安装 `DeskMinis-<版本>-Setup.exe`；SmartScreen「未知发布者」
      属预期（未签名，README 已注明）。
- [ ] 任务栏 / 开始菜单 / 窗口图标是**蓝底三对话行**新图标（不是 Electron 默认图标）。
- [ ] 首启：欢迎屏正常，设置 → 模型 配一个 provider（配完确认「当前默认」高亮的是你选的那个）。
- [ ] **跑一回合带工具调用，权限卡出现且能批准 / 拒绝**——这一条是**必验项**：
      权限卡在 0.2.0 之后的界面重做里曾被整个漏掉，1890 例测试全绿也没拦住
      （只读命令默认免询问，要用会改动系统的命令才触发）。
- [ ] 欢迎屏点一个助手卡 → 输入发送 → 会话带 emoji 前缀且规则生效。
- [ ] 定时任务：建一个「每 5 分钟」任务点「运行」→ ⏰ 会话出现、状态回流 ok。
- [ ] Office：让 agent 生成一份 `.docx`，在右栏「改动」里点开 → 预览区渲染出内容
      且顶部有「内容预览 ≠ 版式还原」提示条。
- [ ] 终端：标题栏终端钮拉出底部抽屉，敲一条命令有回显（它是在本会话工作区里另起的 PowerShell，
      与 agent 的 shell 不共享 cd 和环境变量）。
- [ ] 扩展市场：导航「扩展市场」能搜出条目（搜不到时看提示是「没有找到」还是「连不上市场」）。
- [ ] 任务面板：右栏「任务」tab 有上下文水位读数。
- [ ] 深浅双主题切一遍（设置 → 外观：跟随系统 / 浅色 / 深色 三态）。
- [ ] 单实例：点窗口的关闭按钮（只是隐藏到托盘），再双击桌面图标——原来的窗口回来，不起第二个。
- [ ] 让 agent 跑过命令、开过终端之后，从托盘「退出」：任务管理器里没有残留的 DeskMinis 进程，
      也没有它起的 powershell 留在后台（自己开着的 PowerShell 窗口不算，看「详细信息」页的命令行分辨）。
- [ ] 「设置 → 关于 → 现在检查」：这时公开仓库里还没有这一版，显示「更新失败 · 发布页上还没有可用的版本…」
      或「已是最新」都属预期；发布之后按第 4 节第 6 步再核一次。
- [ ] 便携版同机再冒烟一次：**先从托盘「退出」安装版**——便携版与安装版共用 `%APPDATA%\DeskMinis`，
      安装版还在托盘里时双击便携版，只会把安装版的窗口叫出来。
- [ ] 便携版的「设置 → 关于 → 现在检查」显示「便携版不自动更新，请到发布页下载新版」，且不下载任何东西
      （靠便携启动器设的 `PORTABLE_EXECUTABLE_DIR` 认出便携版，这一条只能在真机上确认）。
- [ ] 托盘「检查更新…」弹出结果回执（已是最新 / 发现新版正在下载 / 失败原因），关掉即可，不挡主窗口。
- [ ] 断网后点「现在检查」：状态行是「更新失败 · 连不上更新服务器（离线或网络受限）」这样一句中文，
      没有英文堆栈和响应头。
- [ ] 安装目录 `resources\` 下有 `LICENSE.txt` 与 `THIRD-PARTY-NOTICES.md`（W1a-1 起随包；
      `extraResources` 的 `from: ../` 指向工程目录之外，缺了就退回在 `deskminis/` 下放拷贝并加一致性测试）。
      `verify:release` 第 8 项查的是 `win-unpacked`，这一条确认装出来的也有。
- [ ] 卸载：数据目录保留（`deleteAppDataOnUninstall: false`）。

## 4. 发布到公开发布仓库 `lincheuk/deskminis-releases`

源码仓 `lincheuk/Deskminis` 是私有的，发布资产**不再**传到它的 Releases；安装包里写死的更新源是公开仓库
`lincheuk/deskminis-releases`（`deskminis/electron-builder.yml` 的 `publish` 段，2026-09-24 止血设计稿 §2 落定）。

1. **首次**：在 GitHub 新建**公开**仓库 `lincheuk/deskminis-releases`（只放发布资产，不放源码），
   把仓库根的 `README.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`CHANGELOG.md` 拷进去——
   源码仓外人看不到，这里是唯一的对外入口，Apache-2.0 与 MIT 的声明也应该在分发处可见。
   以后每次发版同步更新这四个文件。
   - **对外 README 就是根 `README.md` 原样拷贝**，不用另写一份：它的相对链接只指向 `LICENSE`、`THIRD-PARTY-NOTICES.md`、
     `CHANGELOG.md` 这三个同样拷过去的文件；提到源码仓 `docs/` 的地方写的是纯文本路径，在公开仓库里不会变成死链。
     以后改 README 时保持这一点（要链到 `docs/` 就写成纯文本路径），拷贝才不用手改。
   - README 的 Releases 链接必须指向这个公开仓库——`deskminis/tests/readme-claims.test.ts` 核对它与 `publish` 段一致。
2. 在**公开仓库**新建 Release：tag 填 `v<版本>`（如 `v0.3.0`），发布时 GitHub 自动创建该 tag；
   Release 说明里写上对应的源码仓 commit（历史：0.1.1 → `6c48c8b`，发在源码仓的 Releases；0.2.0 未公开发布）。
   **不能是 draft，也不能勾 pre-release**：electron-updater 走 `github.com/<owner>/<repo>/releases/latest`
   找最新正式版，草稿和预发布它看不见。（云端侧实测 tag 推送被 403 拒——凭据只放行分支推送，
   故 tag 统一走 Release 发布这条路。）
3. Release notes 直接取根 `CHANGELOG.md` 对应版本段（日期已从「待发布」改成发布日，见第 0 节第 6 步）。
4. 上传 **四个**资产到公开仓库 `lincheuk/deskminis-releases` 的这个 Release（都在 `deskminis/dist/`，
   上传前 `npm run verify:release` 必须全 PASS，见第 2 节）：
   - `DeskMinis-<版本>-Setup.exe`
   - `DeskMinis-<版本>-Setup.exe.blockmap`——差分下载靠它；旧版本的 blockmap 要留在旧 Release 下，
     所以**旧 Release 不要删**，删了老用户就只能整包下载
   - `DeskMinis-<版本>-win-x64-portable.exe`
   - **`latest.yml`**——electron-updater 的版本清单，**漏传 = 自动更新永远查不到新版**；
     里面记着 Setup.exe 的文件名、sha512 与大小，资产不能改名、不能重新打包后只换其中一个
5. **上传后再验一遍**：把这个 Release 的四件下载回一个空的临时目录，对它跑校验——
   本地 `dist/` 自洽，不等于传上去的也对（上传中断被截断、传成了上一版的文件、漏传 `latest.yml` 或 blockmap，都只在这一步看得见）：
   ```powershell
   $d = Join-Path $env:TEMP "deskminis-release-check"
   Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $d | Out-Null
   gh release download v<版本> --repo lincheuk/deskminis-releases --dir $d   # 没装 gh 就在网页上把四件下载进 $d
   npm run verify:release -- --dist $d
   ```
   第 7、8 项会 SKIP 并写明原因（下载回来的只有四件，没有 `win-unpacked`，属正常），其余必须全 PASS；
   有 FAIL 就删掉出错的资产、从同一个 `dist/` 重传，再验一遍。
6. 发布后在装好的新版里点「设置 → 关于 → 现在检查」，应显示「已是最新」（不是「更新失败」）；
   从 0.3.1 起，再用一台装着上一版的机器检查一次，应显示「有新版本 · <版本>」并开始下载。
   （0.3.0 是第一个走新源的版本，装着 0.1.1 的机器查不到它，见 §5。）

## 5. 自动更新须知

- 更新源写死在安装目录的 `resources\app-update.yml`（打包时由 `publish` 段生成）：github provider，
  `lincheuk/deskminis-releases`。检查走 github.com 的 `releases.atom` 与 `/releases/latest` 两个网页端点，
  不走 API、不需要 token。**要换更新源，只能先在旧源发一个带新 `publish` 配置的过渡版**——装在用户机器上的旧版只认旧源。
  改源时 `deskminis/src/main/update-status.ts` 的 `RELEASES_PAGE_URL` 一起改（`tests/update-error-text.test.ts` 核对两边一致），
  根 `README.md` 的 Releases 链接也一起改（`tests/readme-claims.test.ts` 核对）。
- **0.1.1 的用户收不到自动更新**：0.1.1 写死的是私有源码仓，检查永远 404，需要手动下载安装一次 0.3.0，之后才走新源。
- 公开仓库建好、还没发第一个正式 Release 时，检查会显示「发布页上还没有可用的版本」——这是预期，不是坏了。
  已经发过版却也显示这句，先看最新那个 Release 是不是误勾了 pre-release、是不是还停在 draft、`latest.yml` 有没有传上去。
- 失败原因由主进程译成一句中文（`src/main/update-status.ts` 的 `describeUpdateError`）；原始错误（含响应头与堆栈）
  只写进主进程的 stderr。
- 便携版不参与自动更新：主进程认出便携版（环境变量 `PORTABLE_EXECUTABLE_DIR`）就不检查、不下载，
  状态显示「便携版不自动更新，请到发布页下载新版」。
- 下载完成后只提示，不自动安装（`autoInstallOnAppQuit = false`），由用户选择何时重启。

## 6. 版本号与下一版

- 升版：改 `deskminis/package.json` 的 `version`（功能波升 minor，修补升 patch），
  随动 `tests/m5-packaging.test.ts` 版本钉（改锚要在 commit 申报）+ 根 `CHANGELOG.md` 新段
  （标题先写「待发布」，发版当天改成日期）
  + `package-lock.json` 根上的两处 `version`（手改即可，不必为此跑 `npm install`；
  `tests/license-consistency.test.ts` 核对锁根与清单一致）。
  产物名 / e2e-m5 默认路径 / 更新清单都从 package.json 版本派生，无其它硬编码点。
- 依赖：`dependencies` / `devDependencies` 由 `tests/deps-frozen.test.ts` 整体快照钉住（锁根的同名字段一并核对）。
  改依赖先征得用户点头，再同步改快照，并在 commit 正文申报；随包的间接依赖跟着变时，
  照 `tests/license-consistency.test.ts` 的提示同步根 `THIRD-PARTY-NOTICES.md` 第 6 节（非 MIT 的包与没带许可文件的包逐个登记）。
- README 不写死测试例数（`tests/readme-claims.test.ts` 会拦）；例数与 Linux 失败基线写在提交正文里。
