# I 波设计稿：AionUi 换向——平面简洁骨架 × 蓝白卡片语言 × 欢迎态

状态：**定稿即施工**（自己做模式；用户 2026-08-20 指令「按照 AionUi 重做 UI，现有功能完美集成」。
本稿全部决策点事后可否决返工）。伴生文件：`2026-08-20-aionui-tokens-reference.css`（已验算定稿）。
立项输入：`docs/research/2026-08-20-aionui-survey.md`（AionUi 功能全集与复用裁定）。

## §0 决策点记录（审核方裁定，待用户追认/否决）

| 决策点 | 裁定 | 依据 |
|---|---|---|
| 方向 | **整体换向 AionUi 平面简洁风**：白卡 + 1px 淡边 + 大圆角 + Arco 蓝单强调；Aurora 玻璃/极光/青强调**退场** | 用户明令「按照这个重做」；AionUi 全程无玻璃拟态（survey §3） |
| 深度 | **色板换肤 + 形态与局部布局改造**（比 E 波深一档：动少量 DOM），三栏骨架（布局 B）保留 | AionUi 会话页与 DeskMinis 布局 B 天然同构（survey §3）；骨架重写是纯风险零收益 |
| 欢迎态 | 新增 **welcomeMode**：空会话时工作台退场、对话列铺满、hero + composer 居中（AionUi Guid 页形态） | 欢迎页是 AionUi 的招牌屏；详 §5 |
| 玻璃材质处置 | backdrop-filter 消费全部摘除；--glass-* / --aurora-* 令牌**保留定义**、极光斑透明化 | 「苹果磨砂」是 2026-08-10 的用户要求，被 2026-08-20 新指令取代——申报为覆盖性偏离 |
| cowork 路线 | 本波纯 UI；**J 波助手体系、K 波定时任务**另行立项（survey §4） | 功能波与 UI 波分离，最小改动面 |
| 原 I 波 genui | 延后进候选池 | 用户新指令优先 |

## §1 视觉概念

- **浅色（主人格）**：白色卡片浮在 `#F9FAFB` 微灰底上，边线 `#E5E6EB`，单强调 Arco 蓝
  `#155BF5`（AionUi 原值 #165DFF 微调深保 AA），用户气泡浅蓝、思考条浅渐变。干净、明亮、办公感。
- **暗色**：纯中性灰阶 `#0E0E0E / #1A1A1A / #262626 / #333`（无色相——与 Aurora 的靛蓝底
  本质区别），提亮蓝 `#4D9FFF`，**蓝底深字**（承接 Aurora 青底深字的对比度模式）。
- **材质语言**：无玻璃、无极光、无顶缘内高光。层次靠「底色分级 + 1px 边 + 柔影
  `0 8px 24px`（12% 暗影）」。圆角分级：小件 8px → 卡片 12px → 弹窗 16px → 输入卡 24px → 胶囊 999px。
- **字体**：零新资产，C 区两栈一字不动。mono 读数应用面（E 波资产）保留——AionUi 弱数据感，
  但「过程可见」是 DeskMinis 自己的命题，不跟随。

## §2 调色板（tokens A 区）

**取值唯一来源**：伴生文件 `2026-08-20-aionui-tokens-reference.css`。槽位体系不变
（foreground 7 / background 5 / border 7 / primary 6 / secondary 8 / 状态四族各 8 /
focus-ring 9 / radius 系 / shadow·selection / aurora-1..3）。要点：

- **secondary 族整体换轴**：青（hue 175–200）→ **蓝（hue 254–263）**。B 区 `--accent/--link/--action`
  映射不动，自动变蓝。暗段 `--on-action` 仍走 `--secondary-foreground`（蓝底深字 7.10:1）。
- **中性阶全部换 AionUi 值**：浅段照抄其灰阶；暗段弃靛蓝改纯中性。
- **状态四族换 Arco 值**：装饰档照抄（浅 `#F53F3F/#00B42A/#FF7D00`、暗 `#F76560/#23C343/#FF9A2E`），
  文本档（emphasis/intense）压深/提亮过 AA（自研调整，AionUi 原值 #F53F3F 在白底仅 ~3.9:1）。
- **--aurora-1/2/3 全透明**：槽位保留，`--aurora-ground` 结构不动、渲染为不可见。
- **主 hex↔oklch 对照**（guarded 槽，全表见参考文件）：

| 槽 | 浅段 hex | 暗段 hex |
|---|---|---|
| foreground-strong / muted / subtle | #1D2129 / #454D5F / #5C6577 | #E8EAEE / #CED3DA / #9AA3B2 |
| background / subtle / muted / strong | #FFF / #F9FAFB / #F2F3F5 / #E5E6EB | #0E0E0E / (8% 填充) / #1A1A1A / #262626 |
| secondary-emphasis（=accent） | #155BF5 | #4D9FFF |
| error/success/warning-emphasis | #D92B2B / #00813E / #A05200 | #F76560 / #23C343 / #FF9A2E |

WCAG 验算（脚本同守卫数学，26 对 + 1 层次全过；`tests/tokens-aurora-contrast.test.ts` **零改动**）：

| 文本对（暗） | 比值 | | 文本对（浅） | 比值 |
|---|---|---|---|---|
| subtle on bg/muted/strong | 7.59 / 6.84 / 5.95 | | subtle on 白/muted/strong | 5.86 / 5.28 / 4.70 |
| muted、strong on strong | 10.06 / 12.56 | | muted、strong on strong | 6.79 / 12.94 |
| accent 文本 on bg/strong | 7.10 / 5.56 | | accent 文本 on 白 | 5.46 |
| 深字 on 蓝钮底 | 7.10 | | 白字 on 蓝钮底 | 5.46 |
| focus-ring on 底（≥3） | 7.10 | | focus-ring on 白（≥3） | 5.46 |
| err/ok/warn/info on 底 | 6.42 / 8.24 / 9.11 / 7.10 | | err/ok/warn/info on 白 | 4.85 / 4.99 / 5.67 / 5.46 |
| 层次比 muted/subtle | 1.79（≥1.25） | | | |

## §3 B 区换挡与材质处置

B 区映射仅 **3 处圆角换挡**，颜色别名逐行不动：

| 别名 | 现值 | 新值 | 为什么 |
|---|---|---|---|
| `--r-card` | `--radius-md`（14px） | `--radius-sm`（12px） | AionUi 卡片一档（8–12px） |
| `--r-input` | `--radius-xl`（18px） | `--radius-2xl`（24px） | AionUi 输入大卡 24px，视觉主角 |
| `--r-sheet` | `--radius-2xl`（24px） | `--radius-lg`（16px） | AionUi 弹窗 16px |

材质令牌（C 区）：定义全部保留（`--glass-thin/thick/blur/edge/ground`、`--aurora-ground`、
`--glow-accent`）——**消费面退场**：App.vue 三处壳层与面板头摘 `backdrop-filter`，组件层摘
顶缘内高光 `inset 0 1px 0 var(--glass-edge)`；`--glow-accent` 保留给运行点脉冲光晕（蓝）。
新增 1 个 C 区令牌：`--shadow-overlay: 0 8px 24px var(--shadow-color)`？——**不加**，
既有 `--shadow-pop` 就是这个形状，直接沿用。零新令牌。

## §4 骨架形态清单（逐组件）

| 部位 | 现状 → AionUi 形态 |
|---|---|
| `.shell` 底 | 保持 `--bg`（新值 #F9FAFB/#0E0E0E）；`--aurora-ground` 消费行保留（已不可见） |
| `.taskbar` | 玻璃 → 实色 `--surface-1` + 底边框；mono 读数、蓝点脉冲保留 |
| `.rail` 图标轨 | 玻璃 → 实色 `--surface-1`；活跃项蓝左条保留（--accent 自动变蓝） |
| `.pane-l` + SessionList | 白底列；顶部「+ 新建会话」全宽主钮（AionUi SiderToolbar）；会话行 hover 灰底 8px 圆角、活跃行 `--fill` 底；底部 footer 行：设置/设备/主题三钮（复用 provide 通路，原生 button） |
| ChatView 用户消息 | 左对齐块 → **右对齐浅蓝气泡**：`--secondary-subtle` 底、圆角 `8px 0 8px 8px`、utag 行右对齐；`data-anno-root`/`data-mid` 锚域属性一字不动 |
| ChatView 助手消息 | E3 实心浮岛卡 → **无背景满行宽平铺**（AionUi assistant 形态）；devmark/思考块/工具行结构不动 |
| ThinkingBlock | 细边半透明卡 → 浅渐变条 `linear-gradient(90deg, var(--secondary-subtle), var(--fill-quaternary))`（AionUi thought-gradient 的令牌化）+ 完成自动折叠文案保留 |
| ToolLine | 32px 行保持；running 左缘活动线换蓝（自动）；展开体白卡细边 8px 圆角 |
| PermissionCard | 浮岛 → 白卡 + 1px 边 + `--shadow-pop`；主钮蓝底白字（浅）/蓝底深字（暗）自动 |
| composer | **双层输入大卡**：外层 `--bg-secondary` 24px 圆角，内层 `--surface-1` + 1px 边；聚焦 `box-shadow` 蓝光环过渡（`--ring` 30% 档）；发送钮圆形蓝底；cpill 胶囊 999px |
| EmptyState | → hero 化（§5） |
| `.wtabs` 页签条 | 玻璃 → 实色；活跃页签白底 + 蓝底缘线保留 |
| 工作台面板/设置/市场 | 分组卡白底细边 12px 圆角；主钮/开关/徽记经 --accent 自动变蓝；行 hover `--fill-quaternary`；`.wctl` 段控/`.seg` 保持 |
| 弹窗（Settings/Devices） | `--r-sheet` 16px；标题 18px/600（AionUi 弹窗规格） |

## §5 欢迎态（welcomeMode）

定义：`welcomeMode = 无活动会话 || (活动会话零消息 && 非 running)`（App.vue computed，数据全取既有 store）。

行为：
- `pane-w` 与 `.wbrail` 的 v-show 增加 `&& !welcomeMode`——**四个内置面板的 v-show 绑定一字不动**
  （它们在 pane-w 内层，renderer-artifacts/files/tasks 三守卫的锚不受影响）；
- 对话列铺满（既有 `flex: 1 1 auto` 通路，工作台隐藏时自然发生，零新逻辑）；
- TitleBar 工作台开关在 welcomeMode 下 disabled + title 说明（「点了没反应」教训，成例 `.wctl`）；
- ChatView 空态：hero 标题「**你好，今天想做点什么？**」（text-2xl/600 居中）→ EmptyState
  示例卡群（保留 @fill 通路）→ composer 视觉居中、`max-width: 800px`（AionUi 内容宽
  `clamp(360px, 100%-32px, 800px)`）；
- 发出首条消息 → welcomeMode 自动翻 false、工作台回场。
- 红线：`.stream` mouseup 单手势面、`.composer` 结构、slash 菜单、附件/工作区面板 DOM 不动——
  只动排布与样式；乐观消息瞬间（`local-` id）不允许闪回欢迎态（isEmpty 判据含乐观消息）。

## §6 守卫迁移表

| 守卫 | 裁定 |
|---|---|
| `tokens-aurora-contrast`（26+1） | **零改动**——新色板全过（§2 表）。这正是它存在的意义 |
| `tokens-mu3-appica` 例 1/2 | 改锚：REF 指 `2026-08-20-aionui-tokens-reference.css`；归属文案改「结构 Appica（MIT）→ 取值 AionUi（Apache-2.0）移植 + 自研 AA 调整」；解析逻辑一行不改 |
| 例 3/7（别名/圆角映射） | 改 3 行锚（--r-card/--r-input/--r-sheet 换挡，§3） |
| 例 5（color-mix 仅玻璃块） | 保留（玻璃块定义还在） |
| 例 8（blur 白名单） | 消费全摘后 ALLOW 缩容为 `[]`（POPUP_OWNERS 双保险逐字保留——它保护的是「永远不许」，与消费现状无关） |
| 例 9（零硬编码 + xterm 兜底） | 逻辑保留；xterm 三值按新色板换算（I4 步内定稿值） |
| 例 4/6/10/11/12/13 | 保留 |
| `tokens-evolution` | Aurora 抽样锚 6 组 → 新参考文件抽样；其余 7 例逐字保留 |
| `renderer-aurora-shell` / `renderer-aurora-content` | **改造为平面形态守卫**并更名 `renderer-shell-form` / `renderer-content-form`：断言壳层零 backdrop-filter、消息区无浮岛内高光、用户气泡右对齐类存在等（I2/I4 步内定断言） |
| `renderer-composer` | 改锚（空态与输入区形态 v3） |
| `mu5-workbench-layout` | welcomeMode 触点改锚 + 新增断言（welcome 下 pane-w 隐藏、面板 v-show 绑定仍在） |
| `a11y-keyboard-reachable`、`markdown-xss`、`renderer-a11y-keyboard` | 不动；新增交互一律原生 button + :focus-visible |
| 其余 renderer-* | 样式级改动不碰锚；凡确需碰锚逐条在 commit 里申报 |

## §7 功能覆盖表（「现有功能完美集成」兑现清单）

零功能增删。逐项确认仅视觉/排布变化：会话管理全套（新建/改名/置顶/删/记忆/模型绑定/自动标题）、
消息流全形态（文本/思考流/工具行+成组/附件 chip/事件条 7 类/Markdown+围栏复制/复制回合）、
选区引用与标注（锚域属性红线 §4）、权限（内联卡/三档/超时/审计徽标/askOnce）、上下文水位、
任务条、provider 4 kind+搜索、技能启停导入+斜杠菜单、MCP 管理试连、扩展市场三源全链路、
设备配对与同步、workspace 选择、文件树/预览/多标签、终端、产物、browser/screen 占位、
主题三模式、键盘可达、托盘通道。验收 = I5 xvfb 双主题截图目视 + 全守卫绿 + Windows 真机确认。

## §8 拆步计划（I 波，TDD + commit/push 每步收尾）

| 步 | 内容 | 先红守卫 |
|---|---|---|
| **I1** | 色板换向：tokens.css A 区四段替换（照参考文件）+ B 区 3 处圆角换挡 + 例 1/2/3/7、evolution 改锚；`tokens-aurora-contrast` 必须全绿零改动 | 改锚例先红（旧锚断新值） |
| **I2** | 壳层平面化：玻璃/高光消费退场 + taskbar/rail/wtabs 实色化 + SessionList AionUi 化（新建主钮/行样式/footer）+ 例 8 缩容 + shell 守卫改造更名 | renderer-shell-form 新断言先红 |
| **I3** | 欢迎态：welcomeMode + EmptyState hero 化 + composer 居中 + TitleBar 禁用态 + mu5/composer 守卫改锚 | 新断言先红 |
| **I4** | 内容区形态：用户气泡右对齐 + 助手平铺 + ThinkingBlock 渐变 + ToolLine/PermissionCard/EventNote/composer 双层卡 + xterm 三值 + content 守卫改造更名 | renderer-content-form 先红 |
| **I5** | 工作台/设置/市场/弹窗对齐 + `npm run build` + xvfb 双主题截图目视 + 全量测试对基线 + 波结记账 | —（终验步） |

每步纪律照旧：改前 `git pull --ff-only`；`cd deskminis && npm test`（Linux 对 52 例基线 diff 为空）+
`npm run typecheck`（EXIT=$? 直取）；`-F` UTF-8 消息文件、`I<n>: 简述`、lincheuk 身份提交；
push 退避重试 + 远端验证贴输出；UI 改动步必 xvfb 目视（先 build）。Windows 真机双主题目视为收官硬条件。
