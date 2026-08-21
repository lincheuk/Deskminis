# U 波设计稿：Office 文档能力（读 / 预览 / 生成）2026-08-21

状态：**定稿即施工**。用户指令：「officecli 自己参考他的源码做一下」。

## §0 先把参照物看清楚（避免又一次照着印象做）

`iOfficeAI/OfficeCLI`（Apache-2.0）已 clone 到 `/home/user/iofficeai/officecli` 读过：

- **它是 C#/.NET 写的单二进制**（354 个 `.cs`，`officecli.slnx` 解决方案），
  安装走 `curl d.officecli.ai/install.sh`；**代码无法移植进我们的 TS/Electron 进程**。
- 能力分三层：**L1 读**（create/view/get/query/validate）→ **L2 改 DOM**（add/set/remove + 路径选择器）
  → **L3 裸 XML**。`view` 有 outline/stats/issues/text/annotated/html/screenshot 多模式。
- 有**常驻模式**（首次访问自动起，60s 空闲超时）避免文件锁冲突；
  有**稳定 ID 寻址**（`@paraId` / `@id`）—— 位置下标会随增删漂移，稳定 ID 不会。
- 靠一份 `SKILL.md` 教 agent 用它；另有 MCP（单 `command` 字符串参数直通 CLI）。
- AionUi 侧只是**调用方**：HTTP `start/stop` 起停它，前端 iframe 加载它返回的 localhost URL，
  状态机 `starting/installing/ready/error`。
- 它的边界也写在 AionUi 源码注释里：**不接受 .csv**；legacy `.doc/.xls/.ppt`、ODF、
  macro-enabled、HEIC 一律 `unsupported`（此前误路由给它，提示"装 officecli"但装了也没用）。

**可参考的是它的设计（能力分层、稳定 ID 寻址、诚实的格式边界），不是它的代码。**

## §1 我们做什么、不做什么

`.docx/.xlsx/.pptx` 本质是 **ZIP + OOXML**。项目已有 `yauzl`（读 zip，技能导入器在用），
Node 自带 `zlib`（写 zip）。所以**零新依赖即可自建**，无需分发 .NET 二进制。

| 层 | 本波做 | 说明 |
|---|---|---|
| **读** | ✅ | 解包 zip → 解析 OOXML → 结构化内容（段落/表格/幻灯片大纲） |
| **预览** | ✅ | 结构化内容 → 复用既有渲染管线，预览区不再显示「不支持」 |
| **生成** | ✅ | 手写 zip + OOXML 骨架，产出可被 Word/Excel/PPT 正常打开的文件 |
| **精改（L2 DOM 编辑）** | ❌ 留候选 | 需要完整 OOXML 对象模型，量级等同重写 OfficeCLI |
| **高保真渲染（PNG/PDF）** | ❌ 留候选 | 需版式引擎；我们做的是**内容预览**不是版式还原，界面上要说清楚 |
| **legacy .doc/.xls/.ppt、ODF** | ❌ 明确不支持 | 二进制老格式，与 OOXML 无关；照 OfficeCLI 的教训**如实告知**，不给假希望 |

**诚实边界（写进 UI 文案）**：我们的预览是「内容预览」——文字、表格、大纲、幻灯片文本
都在，但**字体、精确排版、图片位置、动画不还原**。要看最终版式，用系统 Office 打开。

## §2 分步

| 步 | 内容 | 出口 |
|---|---|---|
| **U1** | `lib/office/` 纯模块：zip 解包 + docx/xlsx/pptx 三解析器 | 纯单测（真实文件字节，非 mock） |
| **U2** | 预览区接入：Office 文件渲染内容预览 + 边界文案 | 实拍：三种格式各一张 |
| **U3** | `lib/office/write.ts`：手写 zip + OOXML 骨架生成三种格式 | 单测 + **生成物能被解析器读回**（往返验证） |
| **U4** | agent 工具 `office_read` / `office_write` 注册 + 权限门 | e2e：FakeProvider 跑一次真实产出 |
| **U5** | 终验 + 记账 |  |

## §3 红线

- 零新 npm 依赖（yauzl 已有、zlib 内置）。
- 生成物必须能被**真实 Office 软件**打开——Windows 真机验收项，云端只能验往返自洽。
- 解析器面对畸形文件不许抛未捕获异常（agent 会拿它读任意文件）。
- 大文件保护：zip 条目数与解压尺寸设上限，防 zip bomb（技能导入器已有同类成例可循）。
