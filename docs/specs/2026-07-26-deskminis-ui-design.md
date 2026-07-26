# DeskMinis UI 设计规格（Apple 美学 + OpenMinis 复刻）

日期：2026-07-26（v2，取代 Codex/WorkBuddy 方向）
状态：待实现（M1 修复波落地后执行，早于端到端验收）
依据：从 `OpenMinis/src/ios` SwiftUI 源码实测提取（见 §0）
取代：`2026-07-26-deskminis-design.md` §7 的最小版三栏描述

---

## 0. 提取结论（为什么这么定）

对 OpenMinis iOS 源码的实测统计，几条决定性事实：

- **它没有自定义设计系统**。`grep 'extension Color' / 'Color(hex'` 全部为零；唯一的自定义
  颜色是 AccentColor（light `#3686EE` / dark `#5490E4`，并非 systemBlue）。中央调色板是
  `Views/Chat/AIChatView.swift:66-86` 的 `enum ChatColors`，每个成员都指向 iOS 语义色。
  → **复刻方式是在 CSS 里实现 iOS 语义色分层，而不是抄色值表。**
- **主按钮/发送键是单色的**（`label`），禁用态 `quaternaryLabel`。**不要做成蓝色。**
- **助手消息无气泡**；只有用户消息有 `tertiarySystemFill`（约 12% 灰）底。不对称。
- **工具调用是胶囊不是方卡**：36pt 高 Capsule，按工具类型给图标配色。
- 排版偏小且密：`.caption`(12) 用 262 次、`.caption2`(11) 142 次为全局最多；
  `design:.monospaced` 108 次。圆角以 8pt 为主（约 50 次）、10pt 次之（36 次）。
  padding 以 12 最多（95 次），栈间距 4/6/8 为主。
- `.ultraThinMaterial` 用 32 次，是浮动输入条与覆盖层的主要材质。
- 明暗：`@AppStorage("appearanceMode")` 0 跟随系统 / 1 强制浅 / 2 强制深。

---

## 1. 主题机制

`prefers-color-scheme` 驱动自动模式；`:root[data-theme="light"|"dark"]` 覆盖强制模式。
所有值只在 tokens 层声明一次，组件一律用变量，**不写死颜色**。

```css
--font-ui: -apple-system, "SF Pro Text", "Segoe UI Variable", system-ui, sans-serif;
--font-mono: "SF Mono", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
```
Windows 上 SF Pro 不存在，`Segoe UI Variable` 是度量与光学最接近的替代；等宽用
Cascadia Code。字重：400 正文 / 500 次级 / **600 标题与按钮（主力）** / 700 强调。

## 2. 颜色令牌（浅 / 深）

```css
/* 背景 */
--bg:                   #FFFFFF / #000000;
--bg-secondary:         #F2F2F7 / #1C1C1E;
--bg-tertiary:          #FFFFFF / #2C2C2E;
--grouped-bg:           #F2F2F7 / #000000;
--grouped-bg-secondary: #FFFFFF / #1C1C1E;
--grouped-bg-tertiary:  #F2F2F7 / #2C2C2E;
/* 文字 */
--label:            #000000 / #FFFFFF;
--label-secondary:  rgba(60,60,67,.6)  / rgba(235,235,245,.6);
--label-tertiary:   rgba(60,60,67,.3)  / rgba(235,235,245,.3);
--label-quaternary: rgba(60,60,67,.18) / rgba(235,235,245,.16);
/* 分隔线（用 0.5px） */
--separator:        rgba(60,60,67,.29) / rgba(84,84,88,.6);
--separator-opaque: #C6C6C8 / #38383A;
/* 填充 */
--fill:            rgba(120,120,128,.2)  / rgba(120,120,128,.36);
--fill-tertiary:   rgba(118,118,128,.12) / rgba(118,118,128,.24);  /* 用户气泡 */
--fill-quaternary: rgba(116,116,128,.08) / rgba(118,118,128,.18);
/* 强调 */
--accent: #3686EE / #5490E4;   /* OpenMinis 自定义蓝：链接、选中、高亮 */
--brand:  #B7AF96 / #504C42;   /* 暖灰褐：会话选中态 */
--link:   #007AFF / #0A84FF;
/* 状态（系统动态色） */
--red:#FF3B30/#FF453A; --green:#34C759/#30D158; --orange:#FF9500/#FF9F0A;
--yellow:#FFCC00/#FFD60A; --blue:#007AFF/#0A84FF;
```

**签名规则**：主按钮、发送键一律 `--label` 单色，禁用 `--label-quaternary`，**绝不上蓝**。

## 3. 字号 / 圆角 / 间距 / 材质

| 语义 | px / 字重 | 用途 |
|---|---|---|
| title2 | 22 / 700 | 空状态标题 |
| title3 | 20 / 600 | 分区标题 |
| headline | 17 / 600 | 行标题 |
| body | 17 / 400 | 阅读正文 |
| message | 16.5 / 400 | 对话正文与 Markdown 基准 |
| subheadline | 15 | 次级行、分区头 |
| footnote | 13 | 错误、计数 |
| caption | 12 | 元数据（最常用） |
| caption2 | 11 / mono | 时间戳、耗时 |

```css
--r-control:8px; --r-md:10px; --r-card:12px; --r-input:16px;
--r-bubble:18px; --r-sheet:20px; --r-pill:999px;
/* 间距：2 4 6 8 10 12 16 20 24 32，主力 8–12 */
--material-thin:    blur(20px) saturate(180%);   /* 浮动输入条、覆盖层 */
--material-regular: blur(30px) saturate(180%);
/* 材质底色 light rgba(255,255,255,.6) / dark rgba(30,30,30,.6)，
   GPU 不可用时回退实底 --bg-secondary */
```
数字读数一律 `font-variant-numeric: tabular-nums`（防跳动，对应 `monospacedDigit()`）。

**insetGrouped 列表复刻**：页面底 `--grouped-bg`，左右 padding 16px；每个分区是圆角
10px 的 `--grouped-bg-secondary` 块；行间用**内缩**的 0.5px `--separator`（左边距对齐
图标宽度，约 52px）；分区标题 subheadline/600 `--label-secondary`，**不大写**。

---

## 4. 布局与组件

整体 = 自绘标题栏（顶，全宽）+ 三栏 `260px | 1fr | 300px（可收起）`。

### 4.0 自绘标题栏（frameless）

Electron `frame:false`；高度 40px；半透明材质（`--material-thin`）+ 底部 0.5px
`--separator`。整条 `-webkit-app-region: drag`，其中所有可点元素设 `no-drag`。

- 左：侧栏开关图标；前进/后退（`--label-tertiary`，会话导航，可后置）；
  菜单栏「文件 / 编辑 / 视图 / 帮助」，13px，hover/open 时 `--fill-quaternary` 底
- 中：当前会话名，13/600 `--label-secondary`，`pointer-events:none`
- 右：**窗口控制用 Electron `titleBarOverlay`（系统绘制原生按钮）**，不自绘——
  Windows 上自绘按钮难还原原生悬停/主题/多显示器行为；`titleBarOverlay` 设
  `color:'#00000000'`（透明背景）、`symbolColor` 随明暗、`height:40`
- 菜单弹层：`--grouped-bg-secondary` + 0.5px 边 + `0 8px 24px rgba(0,0,0,.14)` 阴影，
  行 hover 变 `--accent` 底白字，右侧快捷键 `--label-tertiary` 等宽
- 菜单内容（真实功能）：
  - 文件：新建会话(Ctrl+N)、新建工作区、导入技能…、—、退出(Ctrl+Q)
  - 编辑：撤销/重做、—、剪切/复制/粘贴
  - 视图：切换侧栏(Ctrl+B)、切换右侧面板、—、明暗模式、—、重新加载(Ctrl+R)
  - 帮助：文档、键盘快捷键(Ctrl+/)、更新日志、—、诊断信息、关于 DeskMinis
- macOS（将来跨平台）：改 `titleBarStyle:'hidden'` + `trafficLightPosition`，
  菜单走系统原生菜单栏而非自绘

### 4.1 左栏 · 会话列表

`--bg` 底，plain 列表（非 insetGrouped——对话列表 OpenMinis 用的是 `.listStyle(.plain)`
+ 隐藏系统分隔线）。行：`display:flex; gap:8px; padding:12px 16px`。
- 左：44px 圆形头像，色调 18% 填充（选中时 35%）
- 中：标题 16/600 `--label` 单行截断；预览 14 `--label-secondary` 单行截断（gap 4）
- 右：日期 13 `--label-tertiary`；置顶用 10px 图钉字形
- **选中态** = `--brand` 30% 填充，圆角 10px，内缩 6px
- 粘性日期分组头：置顶 / 今天 / 昨天 / 本周 / 本月 / 更早
- 新建会话按钮：56px 圆形 `--brand` 底、白色 22/600 字形、`0 4px 8px rgba(0,0,0,.2)`

### 4.2 中栏 · 对话流

**空状态**：居中 22/700 标题 +（M1 先只放一行副文案，能力卡等 M2 有真实场景再加）。

**消息渲染（不对称）**：
- **用户**：右对齐，`--fill-tertiary` 底，圆角 18px，`padding:10px 14px`，左侧至少留
  60px 空槽。排队中的消息用 1.5px 虚线边框、无填充。
- **助手**：**无气泡**，整行左对齐。18px 暖色渐变图标
  (`linear-gradient(135deg,#B8B097,#99998C)`) + 名称 17/600，下方内容块 VStack gap 8。
  正文 16.5px。行 padding `4–6px 16px`。

**工具调用 · 胶囊**（不是方卡）：
36px 高 Capsule，底 `--grouped-bg-tertiary`，0.5px `--separator` 边，`padding:0 12px`，
gap 8：`[工具图标] + 13/500 摘要(tool_title) + 11px mono 耗时`。
图标按工具类型配色：shell 绿 / file_read 青 / file_write 蓝 / file_edit 橙 / 记忆 粉。
状态覆盖图标色：成功绿、失败红、取消黄；执行中用微光扫过 + 三点跳动。
点击展开显示参数与输出（等宽 12px，最高 200px 内滚），`file_edit` 展开显示 diff。

思考块：`--blue` 6% 底、0.5px `--blue` 15% 边、圆角 12px、可折叠、13px 正文。

**输入区**：浮动容器圆角 16–20px 置于 `--material-thin` 之上；输入域底
`#FFFFFF`/`#1F1F1F` + 1px `--separator` 边。底部工具条放三个胶囊选择器
（工作区 / 权限档 / 模型），右侧 34px 圆形发送键（`--label` 字形，禁用
`--label-quaternary`）。运行中变方形停止键（调 `chat.cancel`）。

### 4.3 右栏（M1 占位）

标签页：终端 / 文件 / 任务。M1 只放占位说明，M2 填实。

---

## 5. 权限相关组件

### 5.1 权限确认（内联卡，非模态）

**与 OpenMinis 的刻意分歧**：它用不可关闭的模态底部 sheet，因为它只在隐私敏感的
apple-* 调用时才问，频率极低；DeskMinis 每条命令都要确认，模态会让人疯掉。
所以采用 OpenMinis sheet 的**内部构图**，但**内联在对话流里**（也符合原设计
§7「权限确认以内联卡片出现在流里」，且保留了"这个请求属于哪次工具调用"的上下文）。

构图：圆角 12px `--grouped-bg-secondary` 卡 + 0.5px `--separator` 边
- 顶行：`--orange` 盾形图标 20px + 标题 17/600（请求执行命令 / 写入文件 / 读取文件）
- 参数卡：`--grouped-bg-tertiary` 圆角 10px，键 footnote/600 `--label-secondary`，
  值 footnote 等宽 —— **命令或路径逐字完整显示，可换行，绝不截断**
- 底部三个按钮，`padding:10px`，gap 8：
  **仅此次** / **本会话允许**（均为 `--label` 单色描边按钮）、**拒绝**（`--red` 文字）

### 5.2 权限档位选择器（输入区胶囊 → 弹出菜单）

Apple action-sheet 版式，双行行式（图标 + 标题 + 说明），当前档右侧对勾，
危险档整行 `--red`：

```
应如何批准 DeskMinis 的操作？
  ✋ 每次确认        工作区内文件直接放行；其余每次询问     ✓
  ⏱ 本会话沿用      批准过的命令原样重复时不再询问
  ⚠ 完全访问        不再询问任何操作；不可逆的系统操作仍拦截   （红）
```

映射：每次确认 = 全部 `askOnce`；本会话沿用 = 弹窗默认选中 `allow-session`；
完全访问 = 除 danger 外 `bypass`，danger 仍 `notAllowed`。

**刻意不做「自动识别风险操作」档**：该档依赖把命令分类为安全/危险，本项目已用四轮
对抗验证证伪该前提（分号串联、裸括号求值、`get-*` 通配符 + 长驻 shell 两步提权、
`git diff --output=` 写任意路径、UNC 路径泄露 NTLM）。给出做不到的检测承诺，会让用户
误以为风险已被拦下而放松警惕，比不提供更危险。「本会话沿用」是可靠替代：同样减少
打扰，但只做逐字匹配，不做语义判断。

完全访问档的底线：不可逆/系统级操作在任何档位都拦截；要连这个也放开，走设置页里
的独立开关（`PermissionGatewayImpl` 构造参数已支持覆盖 danger 级别），不放进本菜单。

### 5.3 模型选择器（输入区胶囊 → 弹出菜单）

列出 `provider.instances.list`：每行实例名 17/400 + 模型 id 13 `--label-secondary`，
当前项打勾；无密钥的置灰并标「缺密钥」；底部「管理模型」进设置。
**绝不显示密钥**，`hasApiKey` 只决定是否置灰。

---

## 6. 实现约定

- 新增 `src/renderer/src/styles/tokens.css` 声明 §2–§3 全部变量（浅/深两套）
- 淘汰现有内联样式，改用语义类；组件只引用变量
- 图标用一套线性图标集（Lucide/Phosphor，400–600 字重）替代 SF Symbols
- `backdrop-filter` 在 Electron/Chromium 可用，但必须配实底回退
- 明暗跟随系统 + 设置里可强制（对应 appearanceMode 0/1/2）
- 新增组件：`ModelPicker.vue`、`PermissionPicker.vue`、`ToolPill.vue`、`EmptyState.vue`

## 7. 不做（M2+）

右栏实际内容、会话搜索与拖拽、技能与设备面板、能力卡（等有真实高频场景再定）、
squircle 超椭圆精确还原（先用普通圆角）。
