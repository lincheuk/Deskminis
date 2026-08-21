# T 波设计稿：UI 推倒重做（2026-08-21）

状态：**定稿即施工**。
用户指令原文：「抛弃原本的 ui 设计，你一直在基于原本有的做改造，我的目的是你重新做一个，
而不是你在原有基础搞出四不像」。

## §0 为什么前三次都不对（根因，不是道歉是诊断）

| 轮次 | 用户批评 | 我做了什么 | 为什么仍不对 |
|---|---|---|---|
| I 波 | 「按 AionUi 重做 UI」 | 换色板 + 平面化，**留旧骨架** | 只换皮 |
| I6 | 「你那个明明是旧版 ui」 | 改欢迎屏次序/侧栏/标题栏 | 改了布局**局部**，仍是旧结构 |
| S 波 | 「字体 UI 都没有圆角这种感觉」 | 调行高/字号/圆角/字重 | 调了**参数**，骨架与组件形态没变 |

共同错误：**我把「重做」当成「改造」执行**——每次都最小改动面地往旧实现上贴，
三层补丁叠起来就是四不像。「最小改动面」是维护期纪律，用在重做需求上就是错的。

本波改变执行方式：**新建，不编辑**。旧 UI 层整体退场，不做迁移式修补。

## §1 保与弃的边界（这条决定风险）

**保住（一行不动）**：
- `minisd/` 全部后端、`shared/`、`main/`、`preload/`
- `renderer/src/stores/chat.ts`（592 行状态与动作）、`renderer/src/rpc.ts`
- `renderer/src/lib/**`（18 个纯模块：markdown 解析、锚定、cron 描述、@文件、输入历史…）
- 全部后端测试、纯模块测试、e2e 脚本

**作废（整体重写）**：
- `renderer/src/App.vue` + `renderer/src/components/**`（27 个组件，约 7500 行）
- `renderer/src/styles/tokens.css`（旧设计令牌）
- 钉旧视觉实现的 renderer/tokens 守卫（清单见 §5）

即：**表现层全换，数据与逻辑层零改动**。所有新组件仍只通过 `useChat()` 与 `rpc` 说话。

## §2 新设计系统（`styles/theme.css`，从零写，不继承旧 token 命名）

数值依据：`docs/research/2026-08-21-aionui-typography-radius.md`（AionUi 源码实测）。

### 2.1 色（关键变更：主色从亮蓝改为石板灰蓝）

旧 UI 用 `#155BF5` 亮蓝作强调色，界面因此显得**花哨而廉价**——
AionUi 实测 `primaryColor: '#4E5969'`（石板灰蓝），整体观感的"高级"正来自这里：
**彩色只用在必须表意的地方，界面主体是灰白阶梯**。

```
浅色  --c-bg:#ffffff  --c-bg-1:#f9fafb  --c-bg-2:#f2f3f5  --c-bg-3:#e5e6eb
      --c-line:#e5e6eb           （唯一分隔线色，1px）
      --c-ink:#1d2129            （主文字）
      --c-ink-2:#4e5969          （次文字）
      --c-ink-3:#86909c          （弱文字）
      --c-ink-4:#c9cdd4          （禁用）
      --c-brand:#4e5969          （主色=石板灰蓝，按钮/选中/焦点）
      --c-brand-soft:#eff0f6     （主色浅底）
      --c-link:#165dff           （仅链接与真正需要"蓝"的语义）
      --c-ok:#00b42a  --c-warn:#ff7d00  --c-err:#f53f3f
深色  --c-bg:#0e0e0e  --c-bg-1:#1a1a1a  --c-bg-2:#262626  --c-bg-3:#333333
      --c-line:#333333  --c-ink:#ffffff  --c-ink-2:#ced3da  --c-ink-3:#86909c
      --c-brand:#a1aacb  --c-brand-soft:#262c41  --c-link:#4d9fff
```

**层次规则（强制）**：容器分层一律靠 `--c-bg → bg-1 → bg-2 → bg-3` 明度阶梯；
**卡片默认零阴影零边框**。阴影只有两处合法用途：浮层、输入卡聚焦晕。

### 2.2 字

```
--f-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
        Arial, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif
--f-mono: ui-monospace, "SF Mono", Menlo, "Cascadia Code", Consolas, monospace
```
不引 webfont（红线）。**不放 Inter**——AionUi 特意把它从 arco 默认栈里删掉，
理由是装了 Inter 的机器上字显得过细。

字号/行高**成对定义**（AionUi 实测配对，不再各调各的）：

| token | 值 | 用途 |
|---|---|---|
| `--t-hero` | 24px / 32px / 600 | 欢迎标题 |
| `--t-h1` | 18px / 26px / 600 | 弹窗标题、页标题 |
| `--t-h2` | 15px / 22px / 600 | 分区标题 |
| `--t-chat` | 16px / 24px / 400 | **对话正文** |
| `--t-body` | 14px / 20px / 400 | 控件基准、表单、按钮 |
| `--t-item` | 13px / 20px / 400 | 列表行、卡片标题 |
| `--t-aux` | 12px / 18px / 400 | 辅助文字（AionUi 最高频档） |
| `--t-code` | 13px / 20px | 等宽 |

字重只有三档：400 默认继承 / **500 主力**（层级靠它） / 600 仅标题。

### 2.3 形

```
--r-s: 8px    小控件、列表行、按钮      （AionUi 主力档，122 处）
--r-m: 12px   中卡、下拉面板
--r-l: 16px   大卡、弹窗
--r-input: 20px  会话输入框
--r-hero-input: 24px  欢迎页输入卡
--r-pill: 999px  仅胶囊选择器/进度条
50%           仅圆形图标按钮（32×32）与头像
```

间距只用 `4 / 6 / 8 / 10 / 12 / 16 / 20 / 24`，gap 主力 8；
padding **横向比纵向大一档**（px12/py8、px16/py12、px24/py20）。

控件高：`24`(mini) / `28`(主力) / `32`(圆形按钮) / `34`(列表行) / `36`(输入)。

阴影仅两条：
```
--sh-pop: 0 8px 24px rgba(15,23,42,.12)      浮层（深色 0 12px 32px rgba(0,0,0,.45)）
--sh-focus: 0 2px 20px var(--c-brand-soft)   输入卡聚焦晕（静止无影）
```

## §3 布局（重画，不是调旧的）

```
┌─────────────────────────────────────────────────────────┐
│ TitleBar  36px  拖拽区 + 单菜单 + 窗口控件               │
├──────────┬──────────────────────────────┬───────────────┤
│ Rail     │ Stage                        │ Aside         │
│ 248px    │ flex                         │ 320px 可收起  │
│ --c-bg-1 │ --c-bg                       │ --c-bg-1      │
│          │                              │               │
│ 品牌行   │  欢迎态：Hero + 输入卡 +     │ 工作台分栏     │
│ 新建按钮 │        助手卡网格 + 最近      │ （进度/文件/  │
│ ── 分组 ─│                              │  终端/定时…） │
│ 会话     │  会话态：消息流（居中 760）   │               │
│ 定时任务 │        + 底部输入卡           │               │
│ 助手     │                              │               │
│ ── 底部 ─│                              │               │
│ 设置/设备│                              │               │
└──────────┴──────────────────────────────┴───────────────┘
```

与旧布局的实质差异（不是挪像素）：
1. **Rail 是分组导航**（会话/定时/助手/设置四组），不再是纯会话列表 + 底部按钮条。
2. **Stage 内容居中定宽 760**，两侧留白——旧的是撑满列宽，长行难读。
3. **Aside 默认收起**，需要时才出；旧的是常驻右栏挤压中栏到 336px，
   正是"胶囊塞不下"等一连串挤压问题的总根源。
4. 欢迎态与会话态是 **Stage 内的两个视图**，不再靠 `v-if` 在同一棵组件树上叠加条件。

## §4 组件清单（全部新建于 `renderer/src/ui/`）

| 组件 | 职责 | 替代 |
|---|---|---|
| `AppShell.vue` | 三区栅格 + 主题挂载 | App.vue |
| `TopBar.vue` | 标题栏 | TitleBar.vue |
| `NavRail.vue` | 左导航（分组 + 会话列表 + 底部入口） | SessionList.vue |
| `StageWelcome.vue` | 欢迎视图（hero/输入卡/助手网格/最近） | EmptyState.vue |
| `StageChat.vue` | 会话视图（消息流 + 步骤折叠） | ChatView.vue 上半 |
| `Composer.vue` | 输入卡（两态：hero / 会话） | ChatView.vue 下半 |
| `MsgTurn.vue` | 单回合（用户块 + 助手块 + 工具步骤） | ChatView.vue 中段 |
| `StepGroup.vue` | 工具调用折叠组（AionUi View Steps） | ToolLine.vue |
| `AsideDock.vue` | 右侧工作台容器 + 分栏 | App.vue 右栏 |
| 基础件 | `UiButton/UiCard/UiField/UiPill/UiModal/UiIcon` | 散落各处的裸样式 |

复用（不重写，仅换样式引用）：`MarkdownView/MarkdownInline`（AST 渲染是逻辑）、
`DiffView`、`FileTreeNode`、`ThinkingBlock`。

面板类（`ProgressPanel/FilesPanel/TerminalPanel/CronPanel/MarketPanel/*Settings`）
在 T 波**先套新基础件的壳**，内部结构第二批再整理——它们不是第一印象面。

## §5 旧实现与守卫的退场

旧视觉守卫钉的是被作废的实现，留着必然全红，且它们锚的意图已随设计更替失效：

| 守卫 | 处置 |
|---|---|
| `tokens-mu3-appica` / `tokens-aurora-contrast` / `tokens-evolution` | **退役**（旧 token 体系随之作废）；新建 `theme-contrast` 守卫锚新色板的对比度 |
| `mu5-workbench-layout` / `renderer-shell-form` / `renderer-content-form` / `renderer-sessioncard` / `renderer-turn` / `renderer-composer` / `renderer-assistants`（视觉部分） | **退役**，由新的 `ui-*` 守卫接棒 |
| `renderer-pool` / `renderer-cron` / `renderer-mcp-session` 等**接线**断言 | 逐条搬进新守卫（锚的是功能接线，不随皮变） |
| 纯模块测试、后端测试、e2e | **一行不动** |

退役方式：删除文件并在 commit 里逐个申报理由——不留 `.skip` 尸体。
新守卫的原则不变：**锚意图不锚实现**（例：「输入卡聚焦有晕」而非「box-shadow 值等于 X」）。

## §6 分步（每步一 commit，每步实拍）

| 步 | 内容 | 出口 |
|---|---|---|
| **T1** | `theme.css` 新设计系统 + 对比度守卫 | 令牌齐全、对比度全绿 |
| **T2** | `AppShell/TopBar/NavRail` 骨架（Stage 先占位） | 实拍：新三区布局立起来 |
| **T3** | `Composer` + `StageWelcome` | 实拍：欢迎屏完整可用（选助手、发消息建会话） |
| **T4** | `MsgTurn/StepGroup/StageChat` | 实拍：会话全链路（工具步骤折叠、权限卡） |
| **T5** | `AsideDock` + 面板套壳 | 实拍：右栏收放、各面板可用 |
| **T6** | 旧组件与旧守卫删除 + 新守卫补齐 + 全量对基线 | 全量绿、无死代码 |

## §7 红线

- 功能零回归：每步后 FakeProvider 全链路实跑（发消息/工具/权限/助手/定时/文件预览）。
- 零新 npm 依赖（不引 UI 库、不引字体）。
- 后端与纯模块一行不改——UI 重做不许改数据契约。
- 每步实拍，不做「参数改了但看不出」的空转。
