# AionUi 质感层实测调研：字体 / 圆角 / 阴影 / 间距（2026-08-21）

来源：`git clone` iofficeai/AionUi（v2.1.59）+ 下载 `@arco-design/web-react@2.66.1` npm 包
核对默认 token + 用项目真实 `uno.config.ts` 跑 UnoCSS 引擎验证类名产出。
**全部数值来自源码，非印象。** 用途：S 波（DeskMinis 排版与圆润度返工）的数值依据。

## 0 技术栈（先纠正一个前提）

**不是 Tailwind，是 UnoCSS**（`unocss@66.3.3`，presetMini + presetExtra + presetWind3），
UI 库是 `@arco-design/web-react@2.66.1`（非 antd/shadcn），根目录 `uno.config.ts`，无 tailwind.config。
主题只通过 `ConfigProvider` 传一个色：`primaryColor: '#4E5969'`——**石板灰蓝，不是蓝色**，
这是整体"高级灰"质感的重要来源。

## 1 字体

### 全局栈（`styles/arco-override.css`）

```css
html, body {
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
    'Noto Sans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}
```

**关键决定：他们主动删掉了 Arco 自带的 Inter**，注释原文写着装了 Inter 的机器上字显得太细。
**全仓库无 webfont**——无 `@font-face`、无 Google Fonts、无 woff/ttf 文件。纯系统字体。
（这一条与 DeskMinis 的"零新依赖 + 离线可用"红线天然一致，无需引字体。）

等宽：`ui-monospace, 'SF Mono', SFMono-Regular, Menlo, 'Cascadia Code', 'Roboto Mono', Consolas, 'Liberation Mono', monospace`；`--code-font-size: 13px`。

### 字号（全 tsx 类名频次）

| 值 | 次数 | 用途 |
|---|---|---|
| 12px | **257** | 最高频——辅助文字/标签/次要信息 |
| 14px | **183** | **控件基准**（输入框、表单、按钮） |
| 13px | 165 | 紧凑正文/卡片标题/列表项 |
| 11px | 48 | 极小标注 |
| 16px | 19 | 段落/小标题；**桌面聊天正文** |
| 18px | 6 | 弹窗标题 |
| 24px | 2 | **首页欢迎标题**（text-2xl，lh 32px，weight 600） |

聊天正文专线（`Markdown/ShadowView.tsx`）：桌面 `16px / line-height 24px`，移动 `14px / 19.6px`。
Markdown 预览（`styles/markdown.css`）：`15px / line-height 1.7`。

### 行高配对

12→18(1.5)、13→20(1.54)、14→20(1.43)、16→24(1.5)、18→26(1.44)、24→32(1.33)；
markdown 正文 1.7；图标+文字的横向 flex 行用 `leading-none`(1) 防基线撑高（84 处）。

### 字重分布

500：**151 次**（font-medium 82 + font-500 69）≫ 600：66（font-600 43 + semibold 23）
≫ 700：17 ≫ 400：靠继承（Arco 按钮基线就是 400）。
**「几乎不用粗体、靠 500 提层级」**。

## 2 圆角

无集中 token 覆盖：`uno.config.ts` 的 theme 只改了 colors 和 fontFamily，
`theme.borderRadius` 未覆盖；Arco 原生默认极小（small 2px / medium 4px / large 8px）且**未被改写**，
所以 Arco 原生控件是 2px，容器圆角靠原子类逐处写。

| 档 | 合计次数 | 用途 |
|---|---|---|
| **8px** | **122** | **绝对主力**——列表行、小卡片、按钮块、hover 面板、toast、代码块 |
| 12px | 70 | 中卡片、设置分组、下拉面板 |
| full/999px/50% | ≈103 | 圆形图标按钮(32×32)、pill 选择器、头像、进度条 |
| 4px | 48 | 小 chip、内联代码 |
| 16px | 36 | 大卡片、设置面板、**弹窗** |
| 10px | 36 | |
| 6px | 21 | |
| 14px | 11 | 首页助手卡片 |
| **24px** | 3 | **首页输入框** |
| **20px** | 2 | **会话输入框** |

聊天气泡：用户 `8px 0 8px 8px`（右上缺角），队友 `0 8px 8px 8px`。
**胶囊形分工明确**：只用于圆形按钮/pill/头像/进度条，**容器一律方圆角**，不做通体胶囊。

## 3 阴影与边框

### 核心：卡片靠背景分层，不靠阴影，也基本不靠边框

`shadow-*` 全仓库仅约 36 次，对比 `rd-8px` 122 次。绝大多数"卡片"是
`bg-2 rd-16px px-16px py-16px` 这种——**纯填充 + 圆角，零阴影零边框**。
层次靠 `--bg-base #fff → --bg-1 #f9fafb → --bg-2 #f2f3f5 → --bg-3 #e5e6eb` 明度阶梯
（深色 `#0e0e0e → #1a1a1a → #262626 → #333333`）。

### 输入框聚焦光晕（"高级感"的核心，`hooks/chat/useInputFocusRing.ts`）

```ts
activeBorderColor:   isDark ? '#4D4B87' : '#E1E0FF',
inactiveBorderColor: isDark ? '#3a3a4a' : '#c9cacf',
activeShadow: isDark ? '0px 2px 20px rgba(77, 75, 135, 0.45)'
                     : '0px 2px 20px rgba(225, 224, 255, 0.6)',
```
**静止态 `boxShadow: 'none'`**，聚焦才出这层大扩散低透明的淡紫晕，同时边框变色。

其余阴影只用于浮层：`0 8px 24px rgba(15,23,42,.12)`（深色 `0 12px 32px rgba(0,0,0,.45)`）。
侧边栏显式 `box-shadow: none !important`。

### 边框

一律 `1px solid`，色 `#e5e6eb`（深色 `#333333`）。**全仓库没有任何 2px 边框，也没有 .5px**。
preflight 把 `border-color` 基线设成 `transparent`（而非 Tailwind 的 currentColor），
故漏写颜色类的边框直接隐形——实测有 64 处 `border-border-2` 类**在 UnoCSS 下不产出任何 CSS**，
即视觉上真实边框比源码看起来还少，反过来印证"靠填充分层"。

## 4 间距与控件高

- gap：`8px` **209 次**为绝对主力，其次 6/4/12/10/2/16/24。
- padding：横向普遍比纵向大一档（`px-12 py-8`、`px-16 py-12`、`px-24 py-20`）。
- 控件高：按钮以 Arco `small`(28px) 为主（166 次）、其次 `mini`(24px)（92 次）；
  圆形按钮/弹窗关闭 32×32；侧边栏行 34px；标题栏 Win/Linux 42px。
- 滚动条 6px，thumb 圆角 3px，**默认 transparent 仅 hover 显形**。

## 5 首页输入卡的"托盘 + 白卡"双层（未移植，留候选）

外壳 `--bg-2` 灰托盘（24px 圆角、overflow:hidden），内卡白底 + `1px solid --color-border-3` + 24px 圆角、
padding 12px；托盘下缘露出 workspace 脚注条；聚焦时**内外双层同时**上淡紫光晕。
布局 `width: clamp(360px, 100% - 32px, 800px)`，容器 `margin-top: -5vh`（重心上移）。

## 6 移植清单（浓缩）

```
字体   系统栈，删掉 Inter，不引 webfont
字号   10/11/12/13/14(控件基准)/15/16(聊天正文)/18(弹窗标题)/24(欢迎标题)
行高   12→18, 13→20, 14→20, 16→24, 18→26, 24→32；markdown 1.7；图标行 lh:1
字重   400 继承 / 500 主力 / 600 标题 / 700 极少
圆角   8(主力) 12 16(大卡与弹窗) 20(会话输入) 24(首页输入) / 50% 圆形 / 999px 胶囊
边框   一律 1px，#e5e6eb（深 #333333）
阴影   卡片不用；仅浮层 0 8px 24px rgba(15,23,42,.12)；输入聚焦 0 2px 20px 淡色晕
间距   gap 8 主力；padding 横向比纵向大一档
控件高 24/28(主力)/32(圆形)/34(列表行)
分层   #fff → #f9fafb → #f2f3f5 → #e5e6eb
```

## 7 与 DeskMinis 的差异裁定（S 波据此施工）

| 项 | AionUi | DeskMinis 改前 | S 波裁定 |
|---|---|---|---|
| 全局行高 | 有（逐档配对） | **无**（缺省 1.2） | 补 --lh-* 四档，body 取 normal |
| 聊天正文 | 16/24 | 14/1.2 | --fs-chat 16 + --lh-relaxed 1.7 |
| 字重主力 | 500 | 600（71 处） | 600 只留 19 处标题，余降 500 |
| 卡片圆角 | 16 | 12 | --r-card 上调到 16 |
| 中卡圆角 | 12 | 10 | --r-md 上调到 12 |
| 边框 | 1px | .5px（103 处） | 一律 1px |
| 输入卡静止阴影 | **none** | 常驻柔影 | 改 none，聚焦才出晕 |
| 欢迎标题 | 24/32/600（800px 布局） | 26 | 28（内容区 1000+ 等比） |
| 主色 | #4E5969 灰蓝 | #155BF5 蓝 | **不改**（I 波已定，用户认可） |
| 首页输入卡双层托盘 | 有 | 无 | **留候选**（结构改动，非本波质感层） |
