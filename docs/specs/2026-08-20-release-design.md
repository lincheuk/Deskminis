# R 波设计稿：v0.2.0 发布就绪（2026-08-20）

状态：**定稿即施工**（自己做模式；用户 /goal「把他做成一个可以发布的版本」）。
章程不变：**只在 Windows 真机发布验证**——云端把「发布就绪」做到可做的最大面
（源码态/产物结构/叙事/发布件），真机安装冒烟与 Release 资产上传归用户，检查单给全。

## §0 裁定（事后可否决）

1. **版本 0.1.1 → 0.2.0**：I 波起累计四波功能面（UI 重做/助手/定时/候选池批次），
   minor 升版；m5 版本钉测试改锚申报，e2e-m5 的 0.1.1 硬编码改读 package.json（一次修根）。
2. **图标品牌对齐 + 补 app 图标**：现 tray.png 还是 Aurora 暖灰褐（I 波换蓝白系后过时），
   且 **build/icon.ico 缺失**——装出来是 Electron 默认图标，发布不过关。两图标统一
   AionUi 蓝（#155BF5）+ 白三对话行 motif；纯 node 生成脚本成例（gen-tray-icon），
   图标可复现进 git。ICO 走 256×256 PNG-in-ICO（ico 容器原生支持，零依赖可写）。
3. **不做代码签名**（无证书；README SmartScreen 文案已有）；**tag v0.2.0 由审核方推**
   （源码快照标记；Release 资产 Windows 构建后由用户上传，检查单载明）。
4. 零新 npm 依赖不动摇；package.json 仅动 version 与 scripts 行（gen:app-icon，先例允许）。
5. 自动更新维持现状申报：私有仓库下检查 404 被静默吞（main 已处理）；转 public 或
   换托管才真正生效——写进检查单，不在本波动代码。

## §1 拆步

| 步 | 内容 | 验证 |
|---|---|---|
| **R1** | version 0.2.0 + m5 版本钉改锚 + e2e-m5 读 pkg 版本；README 能力表补 助手体系/定时任务/输入体验三行 + 测试数对齐；根 CHANGELOG.md 新建（0.2.0 全量 + 0.1.x 简史） | m5-packaging 绿；README/CHANGELOG 人审 |
| **R2** | gen-tray-icon 品牌色换 #155BF5 重生成 tray.png；新增 scripts/gen-app-icon.mjs → build/icon.ico；electron-builder.yml `win.icon`；npm scripts 加 `gen:app-icon` | 新守卫 tests/app-icon.test.ts **先红**：ICO 头/条目 256/内嵌 PNG magic/yml 接线 |
| **R3** | 云端打包验证：`npm run build` → `electron-builder --dir`（Linux dir 目标验 asar 结构：out/**、resources/tray.png、extraResources 桥件、asarUnpack better-sqlite3）→ 解包产物 xvfb 冒烟（FakeProvider 打招呼）；`--win` 交叉构建试一次留证据（成败都申报，失败即真机步骤） | 产物结构断言 + 冒烟截图入册 |
| **R4** | docs/handoff/release-checklist.md（Windows 真机全流程：构建→e2e:m5→手动冒烟→上传 Release→自动更新警示）；推 tag v0.2.0 | 检查单人审；tag 远端可见 |

## §2 图标规格

- 母版 motif 不变（识别连续性）：圆角方块底 + 三条白「对话行」；底色
  #155BF5（tokens.css 浅色 --accent，侧栏品牌方块同源）。
- tray.png 32×32（regen）；icon.ico 单条目 256×256 PNG（electron-builder 最低要求 256，
  NSIS/任务栏由 Windows 自行降采样；多尺寸条目留待有真机目视再加，不盲堆）。

## §3 边界（本波不做）

- 代码签名 / MS Store / 多语言 installer——无证书无需求信号。
- Linux/macOS 发布目标——章程 Windows-only。
- 自动更新私仓问题的代码面（generic provider 等）——待用户裁定仓库可见性。
