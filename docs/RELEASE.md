# 发布检查单（Windows 真机）

> 章程：**只在 Windows 真机发布验证**。云端已把源码态做到发布就绪
>（版本号 / 图标 / CHANGELOG / 打包结构与 asar 态冒烟全验证过），
> 但安装包必须在 Windows 上构建——electron-builder 在 Linux 交叉构建
> Windows 目标需要 wine（已实测确认不可行），且随包桥 / keyring 均为 Windows 原生件。
>
> ⚠️ **云端的打包结构验证是 R 波（0.2.0）那个快照做的，之后又落了 S/T/U/V 四波
> （界面整体重建 + 新增 Office 模块）。0.3.0 发布前第 2 节的 `e2e:m5` 必须重跑，
> 不能沿用旧结论。**

## 1. 构建

```powershell
git clone https://github.com/lincheuk/Deskminis && cd Deskminis/deskminis
npm ci            # postinstall 自动 electron-rebuild better-sqlite3
npm test          # Windows 上应全绿（Linux 上有 52 例平台性失败是正常的）
npm run typecheck
npm run dist      # 产物在 dist/：Setup.exe + Setup.exe.blockmap + portable.exe + latest.yml
```

- 若 `dist/` 被其它进程占用（EBUSY）：构建到临时目录，再用
  `$env:DESKMINIS_M5_UNPACKED` / `$env:DESKMINIS_M5_SETUP` 指向产物跑验收（见下）。

## 2. 打包验收（自动断言）

```powershell
npm run e2e:m5
```

覆盖：extraResources 桥件随包、原生模块 asar 解包、打包态垫片 stdout / 退出码、
含空格安装路径。全 PASS 才继续。

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
- [ ] 终端：标题栏终端钮拉出底部抽屉，敲一条命令有回显（与 agent 共用同一个 shell）。
- [ ] 扩展市场：导航「扩展市场」能搜出条目（搜不到时看提示是「没有找到」还是「连不上市场」）。
- [ ] 任务面板：右栏「任务」tab 有上下文水位读数。
- [ ] 深浅双主题切一遍（设置 → 外观：跟随系统 / 浅色 / 深色 三态）。
- [ ] 便携版同机再冒烟一次（数据根同 `%APPDATA%\DeskMinis`）。
- [ ] 便携版的「设置 → 关于 → 现在检查」显示「便携版不自动更新，请到发布页下载新版」，且不下载任何东西
      （靠便携启动器设的 `PORTABLE_EXECUTABLE_DIR` 认出便携版，这一条只能在真机上确认）。
- [ ] 托盘「检查更新…」弹出结果回执（已是最新 / 发现新版正在下载 / 失败原因），关掉即可，不挡主窗口。
- [ ] 断网后点「现在检查」：状态行是「更新失败 · 连不上更新服务器（离线或网络受限）」这样一句中文，
      没有英文堆栈和响应头。
- [ ] 安装目录 `resources\` 下有 `LICENSE.txt` 与 `THIRD-PARTY-NOTICES.md`（W1a-1 起随包；
      `extraResources` 的 `from: ../` 指向工程目录之外，缺了就退回在 `deskminis/` 下放拷贝并加一致性测试）。
- [ ] 卸载：数据目录保留（`deleteAppDataOnUninstall: false`）。

## 4. 发布到公开发布仓库 `lincheuk/deskminis-releases`

源码仓 `lincheuk/Deskminis` 是私有的，发布资产**不再**传到它的 Releases；安装包里写死的更新源是公开仓库
`lincheuk/deskminis-releases`（`deskminis/electron-builder.yml` 的 `publish` 段，2026-09-24 止血设计稿 §2 落定）。

1. **首次**：在 GitHub 新建**公开**仓库 `lincheuk/deskminis-releases`（只放发布资产，不放源码），
   把仓库根的 `README.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`CHANGELOG.md` 拷进去——
   源码仓外人看不到，这里是唯一的对外入口，Apache-2.0 与 MIT 的声明也应该在分发处可见。
   以后每次发版同步更新这四个文件。
2. 在**公开仓库**新建 Release：tag 填 `v<版本>`（如 `v0.3.0`），发布时 GitHub 自动创建该 tag；
   Release 说明里写上对应的源码仓 commit（历史：0.2.0 → `6bd9741`）。
   **不能是 draft，也不能勾 pre-release**：electron-updater 走 `github.com/<owner>/<repo>/releases/latest`
   找最新正式版，草稿和预发布它看不见。（云端侧实测 tag 推送被 403 拒——凭据只放行分支推送，
   故 tag 统一走 Release 发布这条路。）
3. Release notes 直接取根 `CHANGELOG.md` 对应版本段。
4. 上传 **四个**资产（都在 `deskminis/dist/`）：
   - `DeskMinis-<版本>-Setup.exe`
   - `DeskMinis-<版本>-Setup.exe.blockmap`——差分下载靠它；旧版本的 blockmap 要留在旧 Release 下，
     所以**旧 Release 不要删**，删了老用户就只能整包下载
   - `DeskMinis-<版本>-win-x64-portable.exe`
   - **`latest.yml`**——electron-updater 的版本清单，**漏传 = 自动更新永远查不到新版**；
     里面记着 Setup.exe 的文件名、sha512 与大小，资产不能改名、不能重新打包后只换其中一个
5. 发布后在装好的新版里点「设置 → 关于 → 现在检查」，应显示「已是最新」（不是「更新失败」）；
   从 0.3.1 起，再用一台装着上一版的机器检查一次，应显示「有新版本 · <版本>」并开始下载。
   （0.3.0 是第一个走新源的版本，装着 0.1.1 的机器查不到它，见 §5。）

## 5. 自动更新须知

- 更新源写死在安装目录的 `resources\app-update.yml`（打包时由 `publish` 段生成）：github provider，
  `lincheuk/deskminis-releases`。检查走 github.com 的 `releases.atom` 与 `/releases/latest` 两个网页端点，
  不走 API、不需要 token。**要换更新源，只能先在旧源发一个带新 `publish` 配置的过渡版**——装在用户机器上的旧版只认旧源。
  改源时 `deskminis/src/main/update-status.ts` 的 `RELEASES_PAGE_URL` 一起改（`tests/update-error-text.test.ts` 核对两边一致）。
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
  + `package-lock.json` 根上的两处 `version`（手改即可，不必为此跑 `npm install`；
  `tests/license-consistency.test.ts` 核对锁根与清单一致）。
  产物名 / e2e-m5 默认路径 / 更新清单都从 package.json 版本派生，无其它硬编码点。
- 依赖：`dependencies` / `devDependencies` 由 `tests/deps-frozen.test.ts` 整体快照钉住（锁根的同名字段一并核对）。
  改依赖先征得用户点头，再同步改快照，并在 commit 正文申报；随包的间接依赖跟着变时，
  照 `tests/license-consistency.test.ts` 的提示同步根 `THIRD-PARTY-NOTICES.md` 第 6 节（非 MIT 的包与没带许可文件的包逐个登记）。
