# 发布检查单（Windows 真机）

> 章程：**只在 Windows 真机发布验证**。云端已把源码态做到发布就绪
>（版本号 / 图标 / CHANGELOG / 打包结构与 asar 态冒烟全验证过），
> 但安装包必须在 Windows 上构建——electron-builder 在 Linux 交叉构建
> Windows 目标需要 wine（已实测确认不可行），且随包桥 / keyring 均为 Windows 原生件。

## 1. 构建

```powershell
git clone https://github.com/lincheuk/Deskminis && cd Deskminis/deskminis
npm ci            # postinstall 自动 electron-rebuild better-sqlite3
npm test          # Windows 上应全绿（Linux 上有 52 例平台性失败是正常的）
npm run typecheck
npm run dist      # 产物在 dist/：Setup.exe + portable.exe + latest.yml
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
- [ ] 首启：欢迎屏正常，设置 → 模型 配一个 provider，跑一回合带工具调用，权限卡出现且生效。
- [ ] 欢迎屏点一个助手卡 → 输入发送 → 会话带 emoji 前缀且规则生效。
- [ ] 定时任务：建一个「每 5 分钟」任务点「运行」→ ⏰ 会话出现、状态回流 ok。
- [ ] 深浅双主题切一遍（标题栏 ☰ → 主题）。
- [ ] 便携版同机再冒烟一次（数据根同 `%APPDATA%\DeskMinis`）。
- [ ] 卸载：数据目录保留（`deleteAppDataOnUninstall: false`）。

## 4. 发布到 GitHub Releases

1. 在 GitHub 新建 Release 时填 tag `v<版本>`、目标选升版 commit（0.2.0 → `6bd9741`），
   发布时 GitHub 会自动创建该 tag。（云端侧实测 tag 推送被 403 拒——凭据只放行分支推送，
   故 tag 统一走 Release 发布这条路。）
2. Release notes 直接取根 `CHANGELOG.md` 对应版本段。
3. 上传 **三个**资产：`DeskMinis-<版本>-Setup.exe`、
   `DeskMinis-<版本>-win-x64-portable.exe`、**`latest.yml`**。
   > `latest.yml` 是 electron-updater 的版本清单，**漏传 = 自动更新永远查不到新版**。

## 5. 自动更新须知

- 仓库保持 **private** 期间自动更新不可用（版本检查 404，应用侧静默处理，不打扰用户）。
  要启用：仓库转 public（配置已就绪，转了即生效），或改 generic provider 另行托管（需改配置）。
- 便携版不参与自动更新（NSIS 安装版专属）。

## 6. 版本号与下一版

- 升版：改 `deskminis/package.json` 的 `version`（功能波升 minor，修补升 patch），
  随动 `tests/m5-packaging.test.ts` 版本钉（改锚要在 commit 申报）+ 根 `CHANGELOG.md` 新段。
  产物名 / e2e-m5 默认路径 / 更新清单都从 package.json 版本派生，无其它硬编码点。
