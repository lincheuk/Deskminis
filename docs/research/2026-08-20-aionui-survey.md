# AionUi 功能与 UI 调研——复用评估（I 波立项输入）

日期：2026-08-20。对象：`github.com/iOfficeAI/AionUi` v2.1.59（commit 74512d3，Apache-2.0）。
方法：云端浅克隆后 7 路并行代码调研 + 官方截图目视 + 关键文件一手精读（GuidPage/ChatLayout/
default-color-scheme.css/builtinThemes 等）。**全部结论以源码为证，不采信宣传文案。**

背景：用户 2026-08-20 指令——「我喜欢这个项目的 UI，按照这个重做 UI，把目前有的功能完美的把
UI 和功能集成；还有我更希望我的项目不止可以 coding，也可以像 cowork 一样，请搜集里面的功能，
看看有哪些可以复用在本项目里。」

## §1 AionUi 是什么

- 定位：**Cowork 平台**——「A free, open-source, Cowork app with AI Agents」。产品重心已从
  「Gemini CLI 的 GUI」演进为通用 agent 工作台（README 直接对标 Claude Cowork）。
- 架构：本仓库只是「壳 + UI」（Electron + React 19 + Arco Design + UnoCSS）；真正的执行引擎是
  独立 Rust 二进制 **aioncore**（闭源外部仓库 AionCore，版本钉 v0.1.70），前端经 REST `/api/*` +
  WebSocket 通信。cron 调度、IM bot、会话编排、助手目录全在 aioncore 里。
- 对 DeskMinis 的启示：**可抄的是 UI 形态与产品概念，不是实现**——DeskMinis 的 minisd 就是
  自己的「aioncore」，能力全部自研自持（零新依赖纪律下这是唯一路径，也是既有路线）。

## §2 功能全集与复用裁定

裁定档位：**Ⅰ** = I 波（UI 重做）直接吸收；**Ⅱ** = 建议下波立项（J/K）；**Ⅲ** = 候选池；
**Ⅳ** = 不做/远期（重资产或与纪律冲突）。

| 功能 | AionUi 做法（源码证据） | DeskMinis 现状 | 裁定 |
|---|---|---|---|
| 欢迎页（hero + 大输入卡 + 助手选择） | `pages/guid/GuidPage.tsx`：居中 hero 标题 + 胶囊助手条 + 24px 双层输入大卡 + 示例 prompt | EmptyState（3 示例卡 + 最近会话）藏在对话列 | **Ⅰ** |
| 平面卡片视觉语言（白卡 + 1px 淡边 + 大圆角，无玻璃） | `default-color-scheme.css` + `arco-override.css`；Arco 蓝 #165DFF | Aurora 玻璃 + 极光斑 + 青强调 | **Ⅰ** |
| 用户消息右对齐浅色气泡 / assistant 无气泡满行宽 | `MessageText.tsx`：右对齐 `8px 0 8px 8px` 圆角 | 双方同为左对齐块 | **Ⅰ** |
| composer 集成动作行（附件/技能/MCP/模型/权限档/发送） | `SendBox` + `GuidActionRow` | 已有同构动作行（附件/工作区/权限/模型） | **Ⅰ**（重排样式） |
| 会话侧栏分组导航（新建置顶/固定入口/时间分组/底部设置） | `Sider/index.tsx`：SiderToolbar→固定项→分组列表→SiderFooter | SessionList 已按日期分组，入口分散 | **Ⅰ** |
| 思考块「Brain + 计时 + 完成自动折叠」 | `MessageThinking.tsx` | ThinkingBlock 已同构（收起露末两行） | **Ⅰ**（视觉对齐） |
| 助手体系（名称/头像/规则/默认技能/默认模型/默认权限档的命名预设） | aioncore SQLite 目录 + `/api/assistants`；字段见 `assistantTypes.ts`；21 个内置助手 | 无——但技能/模型绑定/权限档三件原料全有 | **Ⅱ（J 波）** |
| 定时任务（interval/once/cron 三态调度 + 绑定会话/模型/技能 + run-now） | UI `pages/cron/`，调度器在 aioncore；`ICronSchedule` 模型干净值得抄 | 无 | **Ⅱ（K 波）** |
| 文件预览多标签 + Source/Preview 分屏 + 打开系统应用 | `Preview/PreviewPanel/`（10+ 格式，md/code/html 可编辑） | FilesPanel 文本预览 + 文件多标签已有 | **Ⅲ**（md 渲染/代码高亮预览增强） |
| @ 文件引用（工作区模糊搜索） | `AtFileMenu/` + `useProjectMentionSearch` | 无（有斜杠技能菜单成例可循） | **Ⅲ** |
| 输入历史上翻 / 忙碌排队草稿 | `SendBox` 历史缓冲 + `CommandQueuePanel` | 无 | **Ⅲ** |
| 消息锚点导航轨（右缘 minimap） | `MessageAnchorRail.tsx` | 无 | **Ⅲ** |
| 会话级 MCP/技能勾选（每会话快照） | 建会话时选 MCP 写入 `extra.mcp_server_ids` | MCP 全局启停（会话禁用 UI 在 polish 池） | **Ⅲ**（与既有 polish 项合并） |
| 图片生成（独立图像模型 + 内置 stdio MCP） | `builtinMcp/imageGenServer.ts` | 无 | **Ⅲ** |
| 内置浏览器（agent 操作页面侧栏可见、可接管） | `builtin-mcp-browser` 连自身 CDP；PRD 完整 | browser tab 空态壳已预留 | **Ⅲ**（既有里程碑，优先级升） |
| Office 三件套（PPT/Word/Excel 产出与实时预览） | 技能引导 agent 调外部 **OfficeCLI** 二进制 + watch server webview 预览 | 技能体系已有；无 OfficeCLI | **Ⅲ**（自研「办公技能包」走既有技能面；外部二进制不进 deps） |
| 语音输入 | `SpeechInputButton` | 无 | **Ⅳ**（模型/服务依赖重） |
| WebUI 远程访问（web-host 反代 + 登录 + 手机扫码） | `packages/web-host`（~1800 行，模式干净） | 无（minisd 已是 ws 服务，架构上可行） | **Ⅳ**（远期；安全面大） |
| IM 桥（Telegram/飞书/钉钉/微信 7 平台） | 配置 UI ~5900 行，bot 运行时在 aioncore | 无 | **Ⅳ** |
| Team 多 agent 协作（leader+teammates 并行列） | `pages/team/`，Team MCP Server 分派 | 无；J 波候选「多窗口对话墙」是近亲 | **Ⅳ**（远期，对话墙立项时再评） |
| 外接 CLI agent（Claude Code/Codex/Qwen，ACP 协议统一） | aioncore spawn CLI + ACP JSON-RPC 握手 | 自研 agent 循环（provider 直连） | **Ⅳ**（架构级改向，需用户单独拍板） |
| 多 provider 预设 28 家 + 协议互转 | `modelPlatforms.ts` + ClientFactory | 4 kind provider 已覆盖主流 | **Ⅳ**（按需逐家加） |

## §3 UI 视觉体系要点（I 波施工输入）

- **组件库不可抄**（Arco + UnoCSS 均为 npm 依赖，零新依赖红线），抄的是**形态与色值**：
  - 中性灰阶：`#FFF → #F9FAFB → #F2F3F5 → #E5E6EB → … → #1D2129 → #0C0E12`；
    暗色：`#0E0E0E / #1A1A1A / #262626 / #333`（纯中性，无色相）。
  - 功能色 Arco 系：蓝 `#165DFF`、绿 `#00B42A`、橙 `#FF7D00`、红 `#F53F3F`；
    暗色提亮 `#4D9FFF / #23C343 / #FF9A2E / #F76560`。
  - 品牌紫灰 AOU 10 阶（`#EFF0F6…#0D101C`）用于品牌钮与助手条底。
  - 圆角分级：小件 8px → 弹窗 16px → 输入卡 **24px** → 胶囊 999px。
  - 卡片 = 白底 + 1px 淡边 + 柔影（`0 8px 24px rgba(15,23,42,.12)`）；**全程无玻璃拟态**。
  - 招牌元素：胶囊 agent 选择条（选中白底浮起）、双层输入大卡（聚焦光环过渡）、
    浅色横向渐变提示条、思考面板渐变底。
- 布局骨架与 DeskMinis 天然同构：顶栏 + 侧栏（260px 可折叠）+ 主区 + 右侧预览列。
  会话页 = 聊天流 + 可拖分割 + workspace/预览面板 —— 即 DeskMinis 的布局 B。

## §4 Cowork 化路线建议（待用户裁定排期）

1. **J 波：助手体系**（cowork 化的地基）——本地 assistants 目录（迁移[9]）：
   名称/emoji 头像/规则(追加系统提示词)/默认技能勾选/默认模型/默认权限档/示例 prompt；
   欢迎页助手卡接线「选助手开会话」。AionUi 的 21 个助手证明：**cowork = 会打包的技能+提示词预设**，
   DeskMinis 三件原料（技能/模型绑定/权限档）全部就位，缺的只是打包层。
2. **K 波：定时任务**——`ICronSchedule` 三态模型（interval/once/cron）+ minisd 内调度器 +
   触发即建会话跑 agent；侧栏「定时任务」入口。24/7 自动化是 cowork 叙事的另一半。
3. 候选池增补（§2 表 Ⅲ 档全部）+ 原池保留项按需求信号重排。
4. 原 I 波 genui（内联交互组件）延后为候选，与本轮不冲突（用户 2026-08-20 指令优先）。

## §5 许可与红线

- AionUi 为 Apache-2.0：参考其**设计与色值**合法；本调研未复制其代码。落地实现全部自研。
- 零新 npm 依赖红线不变：不引 Arco/UnoCSS/react-markdown/OfficeCLI；同能力走既有自研面
  （MarkdownView AST 白名单渲染、tokens 双层体系、技能目录）。
- aioncore 是闭源二进制，任何「直接复用」都不成立；web-host/cron UI 的**模式**可参考。
