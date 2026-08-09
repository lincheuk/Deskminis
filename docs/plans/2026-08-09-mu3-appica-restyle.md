# DeskMinis MU3（Appica 视觉语言移植：换掉 Apple HIG + label 扩 7 级）实施计划

> 状态：**评审通过**（用户 2026-08-09 拍板，四个申报项均按本计划结论采纳：品牌金色消亡 / 遮罩收编为 `--scrim` / 字体栈保留例外 / `--link` 与 `--accent` 收敛）。
> 代码基线 main@3555b85（三件套 1019/1019 实测于此）；文档基线 main@626a817（本计划及其自审订正）。执行分支 `feature/mu3` 从 main 最新处切，见 §8。
> 唯一取值来源：[2026-08-09-appica-tokens-reference.css](../specs/2026-08-09-appica-tokens-reference.css)（复核方取证，MIT，禁止联网重取、禁止凭印象写值）。

## 决议反转记录（先于一切，显式申报）

MU1 拍板「变体 A + Codex/WorkBuddy/OpenMinis 三合一视觉基准」，其中 Apple HIG 语义色（iOS 系统灰、label 四级、material/backdrop-filter 材质语言）随变体 A 落地并经 MU2a 令牌化。MU3 用户拍板**反转**该基准：

1. **换掉而非融合** —— 全盘采用 Appica（@appica/ui-react v1.0.0，MIT）的视觉语言与取值；Apple HIG 色值体系（含 material 材质）整体退场。
2. **label 扩到 7 级** —— 现有 4 级文字层次扩展为 Appica 的 7 级 foreground 体系。

影响面（不承认反转而当增量演进做，必然出错）：

- ① tokens.css 全部色值、材质、圆角取值失效，按双层架构重构（§2-1）。
- ② [2026-07-31-ui-design-v2.md](../specs/2026-07-31-ui-design-v2.md) 大面积失效，由 v3 接替（§2-7）。
- ③ tokens-evolution.test.ts 的 6 组 Apple 原值锚（`#3686EE/#B7AF96/#34C759/#5490E4/#504C42/#30D158`）必然拆除重锚（§3-1）。
- ④ **品牌金色身份正式消亡**：`--brand/--on-brand` 自 MU2a 起组件侧零消费（本轮实测 grep 确认），本轮删除 token 本体；`--assistant-gradient` 暖金渐变中性化。这是「全盘换掉」的逻辑延伸，单独申报，复核方可在此打回。
- ⑤ MU2a「发送键 --label 黑底退场 → --action 实底」属交互语义决策而非 Apple 色值，**不反转**（Appica monochrome 主按钮语言本期不移植，见 §1 非目标）。

## §0 基线

- main@3555b85（M6 及后续修已合并）。复核方亲跑：npm test **1019/1019（97 文件）**、typecheck 0、build 三产物成功；既有计划文档 checkbox 零未勾。
- 分支：执行期从 **main 最新处**切 `feature/mu3`（本计划、参考 CSS、自审订正三/四笔文档 commit 已在 main 上，见 §8 第 0 条）。
- 代码面自 3555b85 起未变（其后全是 docs commit），故 1019/1019 的三件套基线对 `feature/mu3` 仍然有效。

## §1 锚点（已核实；执行时仍请自行 grep 复核）

**现状（复核方实测 + 本轮 grep 复核）**

- 样式唯一文件：[tokens.css](../../deskminis/src/renderer/src/styles/tokens.css)（287 行实读；4 个选择器块 + 基础复位）。
- 组件 22 个（src/renderer/src/components/*.vue），无 views 目录；另有 App.vue。组件侧 `var(--token)` 引用 517 处。
- label 引用实测（与复核方口径微差，以实测为准）：`--label` 48 / `-secondary` 44 / `-tertiary` 34 / `-quaternary` 3 = 129 处 / 18 文件。**无 label 引用组件 4 个**：FadeText、Icon、MarkdownInline、TerminalPanel。
- 硬编码颜色 9 处 / 5 文件（与复核方清单逐条核对一致，见 §4 Task 4）。
- material 消费点实测 5 处：TitleBar.vue:121（.titlebar）、ChatView.vue:430（.back-bottom）、468-469（.composer）、476（.slashmenu）、505（.adel）；`--material-regular` 零消费（死 token）。
- 单例色 token 组件侧消费权威统计（`grep -ro 'var(--X)' components/ App.vue`，自审复测订正）：`--brand` 0 / `--on-brand` 0 / `--purple` 0 / `--blue` 0 / `--yellow` 0 / `--green` 0（仅经 tokens.css 的 state-ok 派生间接消费，本轮改直给后成死 token，作别名保留）/ `--cyan` 1（FileTreeNode:43）/ **`--orange` 6 处 5 行 2 文件**（FileTreeNode:43 + ProviderSettings 136/146/149/158）/ `--red` 7 / `--accent` 6 / `--action` 10 / `--link` 1 / `--assistant-gradient` 1（ChatView 助手头像）。
  - ⚠️ 初稿曾误记 `--orange` 为「1 处」（源于一条只匹配 yellow|purple|cyan|blue 的正则，orange 系同行捎带出现被误读）。**订正影响**：ProviderSettings 的告警态（`.miss` 缺 key 提示 / `.inp.warn` 边框 / `.addbtn.confirm`）会随别名换向由 iOS 橙整体变为 Appica `--warning-emphasis`，是有真实视觉面的改动 → §6 截图清单据此补「Provider 设置告警态」一屏。
- 焦点环现状：tokens.css 与组件中 focus/ring 机制为零；仅 ProviderSettings.vue:145 有 `:focus` 改边框色；`outline: none` 3 处（ChatView:492 .field、DevicesModal:251 配对码、ProviderSettings:143 .inp）。

**守卫测试现场（30 处 var(--token) 断言 / 8 文件）**

**值锚共 11 处必改，但分属两个口径，不可相加充作 30**（自审订正：初稿写「值锚 11 + 名锚 19 = 30」是假平衡——6 处抽样根本不含 `var(`，不在 30 之内）：

- 含 `var()` 的值锚 **5 处**（计入 30）：tokens-evolution L58/L59/L60（color-mix 比例槽）、diff.test L145/L146（color-mix 12%）。
- 不含 `var()` 的值锚 **6 处**（**不计入 30**）：tokens-evolution L64-L69 的 6 组 Apple 原值抽样，形如 `toContain('--accent: #3686EE')` 的纯字符串断言。

**名锚 25 处不动**（= 30 − 5）：tokens-evolution **10**（L74/76/79/81/82/83/87/88/91/92）、eventnote 5、diff 2（L128/129）、sessioncard 3、toolline 2、devices 1、composer 1、settings-modal 1 —— 乙案下 token 名保留，全部继续绿。其中两组本轮后成恒真断言，均保留作防回归：

- L79/L81/L83（newbtn 无 `--brand`/`--on-brand`）——`--brand` 删除后恒真；
- L87/L88（ChatView 无 `color-mix(... var(--orange)/var(--purple)`）——本轮 color-mix 全退场后恒真。
- renderer-titlebar-stacking.test.ts L54 断言 `.titlebar` 块含 `backdrop-filter` —— **全仓库唯一提及 backdrop-filter 的断言**；材质退场后该断言**反转**为 `not.toMatch`（不是删除，理由见 §3-4）。组件侧 `backdrop-filter` 实测 4 处：ChatView 430/469/476 + TitleBar 121（另 ChatView 505 只用 `--material-tint` 无滤镜，故 material 消费 5 处、滤镜 4 处）。
- section() 字面切片标记 6 个：`:root {` / `@media (prefers-color-scheme: dark)` / `/* 强制深色` / `:root[data-theme="dark"]` / `:root[data-theme="light"]` / `/* 基础复位` —— **全部保留**（§2-6）。

**Appica 侧自检锚（与参考文件逐字一致）**

- 亮：`--foreground: oklch(0.446 0.03 256.802)` / `--background: oklch(1 0 0)` / `--border: oklch(0.928 0.006 264.531)` / `--focus-ring: oklch(0.872 0.01 258.338)`
- 暗：`--foreground: oklch(0.872 0.01 258.338)` / `--background: oklch(0.13 0.028 261.692)` / `--background-subtle: oklch(0.551 0.027 264.364 / 8%)`
- 圆角：`--radius: 0.875rem` + `calc(var(--radius) * N / 7)` 派生 11 阶（4xs..4xl）
- 焦点环 8 + `--focus-ring-light`；亮色 alpha 30%、暗色 50%
- 语义族 5 个（error/success/warning/info/secondary）各 8 阶；foreground 7 级；`--border-width: 1px`、`--shadow-color`、`--selection-color`、`--opacity-disabled: 0.65`

### §1.1 目标

1. tokens.css 按 Appica 双层架构重构：raw 值层照抄参考文件 + DeskMinis 语义别名层重锚；组件 517 处引用零改动。
2. label 4 级 → 7 级，新增级在 22 个组件中有清单化消费（§4 Task 5）。
3. material/backdrop-filter 全退场；9 处硬编码收编；焦点环补无障碍缺口。
4. 守卫测试重锚到新基准并全绿；三模式能力不退化。

### §1.2 非目标（明确不做）

- 不装 @appica/ui-react、不引 Tailwind、零新依赖（只移植 token 值）。
- 不移植 Appica 的 monochrome 主按钮语言：`--action` 保留「唯一主行动色」语义；`--label-inverse` 不设别名（raw 层 `--foreground-inverse` 可达，首个反色表面出现时再启用，见 §2-2）。
- 不动组件 DOM/交互逻辑、不动 .5px hairline 宽度（`--border-width: 1px` 入库但不强制组件换宽）。
- 不动字号尺度（--fs/--sp/--ico/--h，Appica 无对应尺度层）与字体栈（见 §2-1 字体系例外）。
- src/minisd 整目录零改动；不带任何 backlog（M5 真机验收、M7 subagent 与本轮无关）。

## §2 决策点（逐条结论 + 理由）

### 2-1. token 命名策略 → **乙案：双层别名（raw 照抄 + 语义层别名）**

**结论**：新增 Appica 原始值层（token 名与值逐字照抄参考文件），DeskMinis 现有语义 token 全部改为指向 raw 层的别名；组件 517 处引用与 **25 处名锚断言**零改动。

**理由**：

- 用户要的是「风格」——取值/色相/圆角/焦点环/材质退场全部由别名层换向完成，与全量改名的视觉产出**完全等价**。
- 这正是 Appica 官方文档自述的两层架构（raw value tokens + aliased theme tokens），乙案不是妥协而是同构。
- 甲案（517 处组件引用 + 30 处断言机械改名）diff 巨大且纯机械，会把真正的视觉回归淹在噪音里；守卫测试的 22 个被断言 token 名全部失效需同步改名，风险与收益不成比例。
- 乙案把全部取值风险收敛到 tokens.css 一个文件，diff 可逐行审；且可为 raw 层立「与参考文件逐字一致」的强守卫（§4 Task 1），移植保真度反而高于甲案。
- **e2e 侧的额外证据（自审补入）**：`e2e-mu2b-acceptance.mjs:471` 的 `CSS_SLOTS` 在三模式下硬校验 `--surface-1/--action/--on-action/--state-ok/--state-warn-bg/--fs-body` 六槽非空。乙案下这 6 个名字全部保留 → e2e 脚本零改动继续绿；**甲案会把 e2e 一并打红**，改名成本比初稿估计的还大一圈。

**映射总表**（别名层；「两段同」= 浅/暗同一目标，写一次仍每段重申以保持四段结构，见 §2-6）：

| DeskMinis 别名 | Appica 目标（浅） | Appica 目标（暗） | 备注 |
|---|---|---|---|
| --bg | --background | 同 | |
| --bg-secondary | --background-muted | 同 | |
| --bg-tertiary | --background | --background-strong | 分叉 |
| --grouped-bg | --background-muted | --background | 分叉（暗色组底=应用底，同现状语义） |
| --grouped-bg-secondary | --background | --background-muted | 分叉（卡片） |
| --grouped-bg-tertiary | --background-muted | --background-strong | 分叉（卡中槽） |
| --surface-0/1/2 | 链式不动（=--bg / grouped-bg-secondary / grouped-bg-tertiary） | | |
| --label | --foreground | 同 | 基色中灰化是 Appica 签名，正文对比度浅 ≈4.9:1 过 AA |
| --label-secondary | --foreground-muted | 同 | |
| --label-tertiary | --foreground-subtle | 同 | |
| --label-quaternary | --foreground-subtle | 同 | **与 tertiary 视觉合并**（Appica 弱级仅 2 档），申报 |
| --label-strong（新） | --foreground-strong | 同 | 消费清单见 Task 5 |
| --label-emphasis（新） | --foreground-emphasis | 同 | 同上 |
| --label-intense（新） | --foreground-intense | 同 | 同上 |
| --separator | --border | 同 | hairline 变浅属 Appica 预期，申报 |
| --separator-opaque | --border-strong | 同 | |
| --fill | --background-strong | 同 | |
| --fill-tertiary | --background-muted | 同 | 用户气泡；暗色由 .24 透明 → 0.21 实底，申报 |
| --fill-quaternary | --background-subtle | 同 | 暗色正好落 Appica 8% 半透明填充手法 |
| --accent | --secondary-emphasis | 同 | |
| --action | --accent（链式不动） | | MU2a 语义保留 |
| --on-action | --primary-foreground | --foreground-intense | 分叉，两模式均白 |
| --link | --secondary-emphasis | 同 | 与 accent 收敛（原两蓝仅微差），申报 |
| ~~--brand / --on-brand~~ | **删除** | | 组件零消费（实测），金色身份消亡，申报 |
| --assistant-gradient | `linear-gradient(135deg, var(--foreground-muted), var(--foreground-subtle))` | 同 | 暖金 → 中性灰阶，申报 |
| --red / --green / --orange | --error-emphasis / --success-emphasis / --warning-emphasis | 同 | |
| --yellow | --warning-intense | 同 | 零消费，近色收编 |
| --blue | --info-emphasis | 同 | 零消费 |
| --purple | --secondary-intense | 同 | 零消费；色相紫→蓝紫，申报 |
| --cyan | --info-strong | 同 | FileTreeNode 文件图标 1 处 |
| --state-ok/-err/-warn/-info | success/error/warning/info **-emphasis** | 同 | |
| --state-*-bg | 对应族 **-subtle**（直给 10% alpha） | 同 | 命门 3，见 §3-3 |
| --state-*-border | 对应族 **-soft**（直给 20% alpha） | 同 | 同上 |
| --shadow-fab | `0 4px 8px var(--shadow-color)` | 同 | 几何不动，只换色源 |
| --shadow-pop | `0 8px 24px var(--shadow-color)` | 同 | 同上 |
| --scrim（新） | `rgba(0,0,0,.4)` | 同 | 遮罩收编，值不变（§4 Task 4，申报） |
| --r-control/md/card/input/bubble/sheet | 见 §2-3 | | |
| --r-pill | `999px`（字面值保留） | | 形状语义，Appica 无对应阶 |
| --ring / --ring-input / --ring-danger（新） | --focus-ring / --focus-ring-input / --focus-ring-error | 同 | §2-5 |
| ~~--material-tint/-thin/-regular~~ | **删除** | | §2-4 |
| --font-ui / --font-mono | **保留现有栈**（置后覆盖 raw 层 --font-sans/--font-mono） | | 例外：Appica 通用栈缺「SF Pro Text / Microsoft YaHei / Cascadia Code」首选，中文与 Windows 等宽回退会退化，申报 |
| --fs-*/--sp-*/--ico-*/--h-* | 原样保留 | | Appica 无尺度层（其 spacing 走 Tailwind 类） |

### 2-2. label 4 级 → 7 级 → **弱级合并、强级新增 3 别名、inverse 暂不设别名**

**① 映射规则**（按强度轴对齐；Appica 亮/暗两段强度序一致：intense > emphasis > strong > base > muted > subtle）：

- --label → foreground（base）；--label-secondary → -muted；--label-tertiary → -subtle；--label-quaternary → -subtle（弱级只有 2 档，3/4 级视觉合并，已知取舍，截图验收覆盖占位符可读性）。
- 新增别名 3 个：--label-strong / --label-emphasis / --label-intense → foreground-strong / -emphasis / -intense。
- --label-inverse **不设别名**：7 级能力由 raw 层 --foreground-inverse 承载；当前 UI 无反色表面（无 tooltip/无 monochrome 主按钮），强行加别名即「加了没人用」。首个反色表面出现时再启用别名 —— 申报，若复核方要求本期必须有 inverse 消费，备选方案是发送键/主按钮 monochrome 化（将连带反转 MU2a「--label 黑底退场」注释语义与 renderer-composer 测试注释，需单独申报）。

**② 新增 3 级消费场景**（每级 ≥2 处真实消费）：

- --label-strong（14 处消费，与 Task 5 表逐行对齐）：ArtifactsPanel、ChatView（.aname/.sname）、DevicesModal 分组标题、DiffView 文件路径、EmptyState 要点标题、FilesPanel、ModelPicker 已选模型名、PermissionCard 标题、PermissionPicker 选项标题、ProgressPanel、ProviderSettings 字段标题、SessionList 会话标题、TitleBar .tb-title、ToolLine 工具名。
- --label-emphasis：EmptyState 主标题、SettingsModal 分组标题。
- --label-intense：DevicesModal 配对码读数、PermissionCard 命令 mono 文本、SettingsModal 页标题（--fs-display 位）。

**③ 逐组件清单**：见 §4 Task 5 大表（22 个逐个过，无留白）。

### 2-3. 圆角 → **7 旧值映射 11 阶派生，5 个等值、sheet +4px、pill 保留字面值**

Appica `--radius: 0.875rem`（=14px @16px 根）派生：4xs=4 / 3xs=6 / 2xs=8 / xs=10 / sm=12 / md=14 / lg=16 / xl=18 / 2xl=24 / 3xl=32 / 4xl=40（px）。

| 旧 token | 旧值 | 映射 | 新值 | 视觉变化 |
|---|---|---|---|---|
| --r-control | 8px | var(--radius-2xs) | 8px | 不变 |
| --r-md | 10px | var(--radius-xs) | 10px | 不变 |
| --r-card | 12px | var(--radius-sm) | 12px | 不变 |
| --r-input | 16px | var(--radius-lg) | 16px | 不变 |
| --r-bubble | 18px | var(--radius-xl) | 18px | 不变 |
| --r-sheet | 20px | var(--radius-2xl) | 24px | **变大 +4px**（模态大面，Appica 大面用 2xl+），申报 |
| --r-pill | 999px | 字面值保留 | 999px | 不变 |

注：--r-sheet 无等值阶（20px 介于 xl=18 与 2xl=24 之间），取 2xl 因模态是最大面；若目视偏大，复核方可打回改 xl（-2px）。

### 2-4. material/backdrop-filter 退场 → **5 处消费全改实底，3 个 token 全删**

| 位置 | 现状 | 改为 |
|---|---|---|
| TitleBar.vue:121 .titlebar | `var(--material-tint)` + `backdrop-filter: var(--material-thin)` | `background: var(--bg)`，删 backdrop-filter（层叠论证见 §3-4） |
| ChatView.vue:430 .back-bottom | 同上 + 硬编码阴影 | `background: var(--surface-1)`；阴影收编 `0 4px 16px var(--shadow-color)` |
| ChatView.vue:468-469 .composer | 同上 | `background: var(--surface-1)`（保留 .5px border） |
| ChatView.vue:476 .slashmenu | 同上 + 硬编码阴影 | `background: var(--surface-1)`；阴影收编 `0 8px 28px var(--shadow-color)` |
| ChatView.vue:505 .adel | `var(--material-tint)` | `background: var(--surface-1)` |
| tokens.css | --material-tint（4 段）/ -thin / -regular | 全删（-regular 本就零消费）；L52 GPU 回退注释随删 |

视觉差异：毛玻璃 → 实底，正是 Appica 语言；composer/slashmenu 失去透视感，由 border + shadow 承担浮层表达。

### 2-5. 焦点环 → **token 与应用同期做（不省）**

现状是全量无障碍缺口（0 个焦点环 + 3 处 `outline: none` 主动灭绝默认环）。本期一次补齐：

- token：raw 层 9 个照抄入库；新增别名 `--ring` / `--ring-input` / `--ring-danger`（= --focus-ring-error，供拒绝/危险钮）。
- 应用规范：按钮/列表项/菜单项 `:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }`；输入类 `:focus-visible { outline: 2px solid var(--ring-input); outline-offset: 1px; }`；3 处 `outline: none` 改为 `:focus:not(:focus-visible)` 豁免或删除（保留鼠标无环、键盘有环）。
- 应用清单（10 组件；选择器执行期 grep 复核）：
  1. ChatView（.field 输入区、发送钮、.back-bottom、.uops 消息操作、.slashitem）
  2. TitleBar（.tb-ico、.mi、.it）
  3. SessionList（会话项、.newbtn、搜索框若存在）
  4. SettingsModal（左 nav 项、关闭钮、表单控件）
  5. ProviderSettings（.inp 现有 `:focus` 边框保留 + 叠加 ring-input、按钮）
  6. PermissionCard（允许钮 --ring / 拒绝钮 --ring-danger）
  7. PermissionPicker（选项行）
  8. ModelPicker（模型项、搜索框）
  9. DevicesModal（配对码输入、按钮）
  10. ToolLine（可点击工具行）
- 键盘可达性验收：双主题下 Tab 自顶向下走查全界面，焦点环可见且不截断；每个场景留截图（§6）。

### 2-6. 三模式 → **四段结构原样保留，段内改为「raw 层 + 别名层」两段式**

- 6 个字面切片标记（§1）全部保留，tokens-evolution 的 section() 与「四段各一份」断言不受影响。
- 每段内部组织：A 区 = Appica raw 层（该模式原值照抄参考文件）；B 区 = DeskMinis 别名层（该模式映射）。主题无关 raw（--font-*/--radius-*/--border-width/--opacity-disabled）只在 :root 写一次（与参考文件一致）。
- 段间关系：`:root` = 浅；`@media dark` = 暗；`[data-theme="dark"]` = 暗重申；`[data-theme="light"]` = 浅重申。raw 层按段全量重复（暗段 ≈66 行/浅段 ≈84 行），别名层每段全量重申（约 45 条/段）——重复是有意的：保住四段切片断言与逐段 diff 可审性。
- 新守卫可断言「tokens.css 各段 A 区与参考文件对应块逐行一致」（§4 Task 1），移植保真度由测试固化。

### 2-7. 设计文档 → **新增 v3，v2 加取代注记（历史正文不改写）**

- 新增 `docs/specs/2026-08-09-ui-design-v3.md`（执行期 Task 7 产物）：Appica 视觉语言总表（§2-1 映射总表的固化）、7 级 label 使用规范、焦点环规范、材质退场声明、决议反转记录同步。
- [2026-07-31-ui-design-v2.md](../specs/2026-07-31-ui-design-v2.md) 顶部加一行注记「⚠ 变体 A/Apple HIG 语言已被 MU3 决议反转，取值以 v3 为准」，正文一字不动（仓库惯例：历史文档不改写）。
- PROJECT_NOTES.md 进度节在收尾 docs commit 中更新。

## §3 命门处理

### 3-1. 命门 1：tokens-evolution 值锚重锚 → **显式授权 + 重新锚定，不删守卫**

**授权声明**：MU3 用户拍板换掉整套调色板，tokens.css「只追加不改既有值」红线自本里程碑起**解除**，替换为新红线：**「raw 层取值唯一来源是参考文件，禁止凭印象写值；别名层映射关系禁止漂移」**。

**旧断言为什么必须改**：L63-70 硬断言 6 组 Apple HIG 原值（`#3686EE/#B7AF96/#34C759/#5490E4/#504C42/#30D158`），换调色板必然全红；该例的守卫价值是「防止基准无意漂移」，换基准后重锚即可续命，删除则留下回归空窗。

**新 6 组抽样锚**（与参考文件逐字一致）：

| 段 | 锚 | 值 | 选锚理由 |
|---|---|---|---|
| rootLight | --foreground | oklch(0.446 0.03 256.802) | 文字基色，7 级体系之锚 |
| rootLight | --secondary-emphasis | oklch(0.623 0.214 259.815) | --accent/--action 的别名目标（交互主色轴） |
| rootLight | --success-emphasis | oklch(0.696 0.17 162.48) | --green/--state-ok 的别名目标（语义色轴，接替原 green 角色） |
| mediaDark | --foreground | oklch(0.872 0.01 258.338) | 暗色文字基色 |
| mediaDark | --background | oklch(0.13 0.028 261.692) | 暗色蓝黑签名（Appica 暗色最标志性取值） |
| mediaDark | --secondary-emphasis | oklch(0.623 0.214 259.815) | 交互主色轴暗段（两段同值，防暗段漂移） |

brand 轴无锚：--brand 消亡（§2-1），由删除断言替代。
另加别名映射断言组（防漂移）：`:root` 段含 `--accent: var(--secondary-emphasis)`、`--green: var(--success-emphasis)`、`--label: var(--foreground)`、`--state-warn-bg: var(--warning-subtle)` 等核心映射逐字断言。

### 3-2. 命门 2：名/结构依赖 → **6 个切片标记全保留，22 个被断言 token 名 20 留 2 删**

- 标记：`:root {` / `@media (prefers-color-scheme: dark)` / `/* 强制深色` / `:root[data-theme="dark"]` / `:root[data-theme="light"]` / `/* 基础复位` —— 全部逐字保留（§2-6），section() 零改动。
- 22 个被断言 token 名：--brand --fill-tertiary --font-mono --fs-body --fs-ui --green --h-control --label --on-brand --orange --purple --red --r-sheet --state-err --state-err-bg --state-err-border --state-info-bg --state-ok --state-ok-bg --state-warn --state-warn-bg --state-warn-border。
  - **20 个保留为别名**（值换向、名不动）。
  - **2 个删除：`--brand` 与 `--on-brand`**（自审订正：初稿写「21 留 1 删」，把 `--on-brand` 错记为保留，与 §2-1「两个都删」自相矛盾）。二者相关的 3 处断言——tokens-evolution L79（`it()` 标题字符串）、L81（newbtn 无 `var(--brand)`）、L83（sessionList 无 `var(--on-brand)`）——全部是**不存在性断言**，token 删除后恒真，保留作防回归。
- 连锁失效面 = 0：**25 处**名锚不动；值锚 11 处（含 `var()` 5 + 纯字符串 6，口径见 §1）改法见 §3-1/§3-3。

### 3-3. 命门 3：state-* 派生机制 → **选 B：Appica 直给 alpha，color-mix 全退场**

**结论**：--state-*-bg/-border 由 `color-mix(in srgb, var(--X) N%, transparent)` 改为 Appica 直给（-subtle 10% / -soft 20%），color-mix 从 tokens.css 清零（组件侧 MU2a 已清零，本轮 token 层清零）。

**理由**：乙案哲学是取值照抄；color-mix 在 Appica 色相上只能逼近、不等于参考值，且「比例三模式各调」是 Apple 动态色语境的设计，Appica 两模式 subtle/soft 同为 10%/20% 直给，无需比例槽。

**对三模式四段的影响**：state 别名四段同文（Appica 两段 subtle/soft alpha 相同），四段结构由 raw 层与分叉别名承载；视觉差异申报——浅色 bg 10%→10%（不变）、暗色 bg 12%→10%（略弱）、border 30%→20%（略弱），EventNote/DiffView/SessionList 状态块双主题截图验收。

**受影响断言改法**：

- tokens-evolution L57-61 例改为：`--state-warn-bg: var(--warning-subtle)`、`--state-warn-border: var(--warning-soft)`（:root 段）；暗段同色断言删除（值已两段同文），四段存在性由既有「四段各一份」例继续保证。
- diff.test L145-146 改为：`--state-ok-bg: var(--success-subtle)`、`--state-err-bg: var(--error-subtle)`。

### 3-4. 命门 4：TitleBar 层叠 → **保留 z-50 结论，理由重论证；测试修订属计划内修正，单独申报**

**重新论证**：backdrop-filter 移除后，「滤镜创建层叠上下文困住 .pop」的原始诱因消失——严格说此时 .pop(z-40) 在根层叠上下文已能压过 .datehead(z-1)。但保留 `.titlebar { position: relative; z-index: 50 }` 的结论不变，理由改写为**防御性层级槽位**：

- 「主体所有 z-index < 50 < 模态 100/110」的不变量已由守卫后三例固化，保留槽位使该不变量继续可守卫、可推理；
- 未来任何浮层/滤镜/transform 重新引入 titlebar 层叠上下文时，陷阱不复发；
- 保留成本为零（一行既有 CSS 不动）。

**测试修订（计划内修正，单独申报）→ 反转，不是删除**（自审第 8 处订正，见 §10）：

renderer-titlebar-stacking.test.ts 第 1 例把 L54 的

```js
expect(block).toMatch(/backdrop-filter/);       // 旧义：陷阱前提仍在
```

**反转**为

```js
expect(block).not.toMatch(/backdrop-filter/);   // 新义：材质已退场，不得回潮
```

position/z-index 两断言保留不动；文件头注重写为防御性槽位论证；第 2-4 例（模态 > 50、主体 < 50、.pop < 50）一字不动，必须继续绿。

**为什么必须反转而不能删**（初稿写「删除」，是错的）：

1. **删除会让先红预期落空**。删掉 L54 后第 1 例只剩 position/z-index 两条，而这两条**当前代码本来就满足**（489b1f0 修的正是它们），Task 1 修订完该例立刻转绿并一路绿到底 —— 计划 Task 1 写的「预期 titlebar 第 1 例红」根本不成立。
2. **删除会留下守卫真空**。全仓库只有 L54 这一条断言提到 `backdrop-filter`；删掉它，Task 3 摘除 4 处 `backdrop-filter`（ChatView 430/469/476 + TitleBar 121）就**没有任何测试能证明它真的走了**，也拦不住日后回潮重新踩中层叠上下文陷阱。
3. **反转同时解决两者**：Task 1 时 TitleBar:121 仍有 `backdrop-filter` → 反转断言**必然红，且红得对**（计划原有的红预期反而因此成立，只是理由从「删了所以红」换成「还没摘所以红」）；Task 3 摘除后自然转绿；守卫本身不消失，只是把守的方向从「前提仍在」换成「不得回潮」。

**配套加宽守卫**：新守卫文件增设一例「组件侧 `backdrop-filter` 清零」——walk 全部 `.vue` 的 `<style>` 块断言零命中，覆盖 ChatView 那 3 处（原方案对它们零覆盖）。同为 Task 1 红、Task 3 绿。

## §4 Task 序列（串行 TDD；每 Task 先红后绿）

### Task 1 — 守卫重锚 + 新守卫文件（先红）

- [x] tokens-evolution.test.ts：文件头红线注释改写（只追加红线 → MU3 新红线，引用本节授权声明）；L57-61 color-mix 例改别名断言；L63-70 抽样例改 §3-1 新 6 锚 + 别名映射断言组
- [x] diff.test.ts L145-146 改别名断言（§3-3）
- [x] renderer-titlebar-stacking.test.ts 第 1 例 L54 **反转**为 `expect(block).not.toMatch(/backdrop-filter/)` + 头注重写（§3-4；**不是删除**——删除会让红预期落空且留下守卫真空）
- [x] 新建 tests/tokens-mu3-appica.test.ts（读源码一律 `replace(/\r\n/g,'\n')` 归一化行尾——项目既有教训）：
  - [x] MIT 头注四要素（unpkg URL / @appica/ui-react@1.0.0 / MIT / 参考文件相对路径）
  - [x] tokens.css 各段 A 区与参考文件对应块（`:root,.light` / `.dark`）声明体逐行一致（提取后 trim 比对）
  - [x] 别名映射总表全量断言（§2-1 表逐行转为 :root 段断言；分叉项另断 mediaDark 段）
  - [x] 7 级 label：--label-strong/-emphasis/-intense 存在且指向 var(--foreground-strong/-emphasis/-intense)
  - [x] color-mix 清零：tokens.css 全文不含 `color-mix`
  - [x] material 清零：tokens.css 全文不含 `--material`
  - [x] **组件侧 `backdrop-filter` 清零**：walk 全部 `.vue` 的 `<style>` 块零命中（覆盖 ChatView 430/469/476 + TitleBar 121 共 4 处；§3-4 配套加宽）
  - [x] 圆角别名：--r-control: var(--radius-2xs) 等 6 条 + --r-pill 字面值保留
  - [x] 组件零硬编码颜色：walk 全部 .vue 的 <style> 块，无 `#[0-9a-fA-F]{3,8}` / `rgba?(`（TerminalPanel <script> 兜底 4 值登记白名单，Task 4 换算后白名单值同步更新）
  - [x] 焦点环：10 组件清单各含 `:focus-visible` 与 `var(--ring`
  - [x] --scrim 收编：tokens.css 含 `--scrim: rgba(0,0,0,.4)`；DevicesModal/SettingsModal 用 var(--scrim)
- [x] 全量跑红，**逐条记录失败形态并确认红得对**（预期：新守卫全红 + 重锚例红 + **titlebar 第 1 例红——因反转后断言与「此刻 TitleBar:121 仍有 backdrop-filter」冲突**，而非因删除）；commit

### Task 2 — tokens.css 双层重构（转绿：新守卫 1-7 例）

- [x] 头注重写：MIT 归属（来源 URL + v1.0.0 + MIT）+ 双层架构说明 + 明暗机制说明（保留现有机制注释语义）
- [x] :root A 区照抄参考文件 `:root,.light` 块全部声明（含 --font-*/--radius-*/--border-width/--opacity-disabled/--focus-ring-light/--selection-color）
- [x] B 区别名层按 §2-1 总表落地（含 --font-ui/--font-mono 现有栈置后覆盖、--scrim、--ring 三别名、--label-strong/-emphasis/-intense）
- [x] @media dark / [data-theme="dark"] 段：A 区照抄 `.dark` 块 + 暗段别名（含分叉映射）
- [x] [data-theme="light"] 段：浅段重申
- [x] 基础复位段：追加 `::selection { background: var(--selection-color); }`（申报：Appica 便宜特性顺手移植）；svg/body 规则不动
- [x] 6 个切片标记逐字保留；删除 --material-* 三 token 与 --brand/--on-brand
- [x] 对应守卫转绿，commit

### Task 3 — material 退场（5 处）+ TitleBar 层叠修订（转绿：titlebar 第 1 例）

- [x] 按 §2-4 表改 TitleBar.vue:121、ChatView.vue 430/468-469/476/505
- [x] TitleBar.vue .titlebar 注释重写为防御性槽位论证（§3-4），`position: relative; z-index: 50` 不动
- [x] titlebar-stacking 测试 4 例全绿（第 1 例由反转断言驱动转绿——摘除 backdrop-filter 后成立）+ 新守卫「组件侧 backdrop-filter 清零」转绿；commit（message 显式申报测试修订为**反转**而非删除）

### Task 4 — 硬编码收编 9 处（转绿：零硬编码守卫）

- [x] ChatView.vue:432 → `0 4px 16px var(--shadow-color)`；:478 → `0 8px 28px var(--shadow-color)`
- [x] DevicesModal.vue:197、SettingsModal.vue:102 → `var(--scrim)`。**MU2b 豁免结论：「值」延续（rgba(0,0,0,.4)、明暗同色不动），字面值收编为 token** —— tokens.css「唯一声明处」红线高于字面值豁免；若复核方认定 MU2b 豁免含「组件内字面值不得动」，打回后回落为保留字面值 + 守卫白名单登记
- [x] TerminalPanel.vue:30-33 四兜底：按新调色板做 oklch→srgb 换算（bg=oklch(1 0 0)→#FFFFFF；foreground/cursor=oklch(0.446 0.03 256.802) 换算值；selectionBackground=--fill 浅色目标 oklch(0.928 0.006 264.531) 换算值），commit message 记录换算式与工具
- [x] TitleBar.vue:156 `.it:hover .kbd` → `color: var(--on-action); opacity: .7`（与 rgba(255,255,255,.7) 视觉等效）
- [x] 守卫白名单值同步更新；全量绿；commit

### Task 5 — 22 组件 7 级 label 清单化改造（转绿：7 级 label 守卫）

| # | 组件 | label 引用数 | 改/不改 | 内容 |
|---|---|---|---|---|
| 1 | ArtifactsPanel | 3 | 改 | 面板头/工件名 → --label-strong |
| 2 | ChatView | 17 | 改 | .aname、.sname → --label-strong |
| 3 | DevicesModal | 16 | 改 | 配对码读数 → --label-intense；分组标题 → --label-strong |
| 4 | DiffView | 4 | 改 | 文件路径 → --label-strong |
| 5 | EmptyState | 10 | 改 | 主标题 → --label-emphasis；要点标题 → --label-strong |
| 6 | EventNote | 2 | 不改 | — |
| 7 | FadeText | 0 | 不改 | — |
| 8 | FileTreeNode | 3 | 不改 | — |
| 9 | FilesPanel | 6 | 改 | 面板头 → --label-strong |
| 10 | Icon | 0 | 不改 | — |
| 11 | MarkdownInline | 0 | 不改 | — |
| 12 | MarkdownView | 4 | 不改 | 正文随基色走，层次够用 |
| 13 | ModelPicker | 5 | 改 | 已选模型名 → --label-strong |
| 14 | PermissionCard | 5 | 改 | 标题 → --label-strong；命令 mono → --label-intense |
| 15 | PermissionPicker | 4 | 改 | 选项标题 → --label-strong |
| 16 | ProgressPanel | 11 | 改 | 面板头/关键读数 → --label-strong |
| 17 | ProviderSettings | 8 | 改 | 字段标题 → --label-strong |
| 18 | SessionList | 9 | 改 | 会话标题（含选中态）→ --label-strong |
| 19 | SettingsModal | 8 | 改 | 分组标题 → --label-emphasis；页标题 → --label-intense |
| 20 | TerminalPanel | 0 | 不改 | — |
| 21 | TitleBar | 6 | 改 | .tb-title → --label-strong（配合既有 w600） |
| 22 | ToolLine | 8 | 改 | 工具名（mono）→ --label-strong |

- [x] 上表 **15** 个「改」组件逐落地（仅 class 级 token 换名，不动 DOM/逻辑）；**7** 个「不改」组件 git diff 自查为空（自审订正：初稿误写「13 改 9 不改」，按表逐行点数实为 15 改 7 不改）
- [x] 守卫转绿；commit

### Task 6 — 焦点环应用（转绿：焦点环守卫）

- [x] 按 §2-5 清单 10 组件落地 :focus-visible；3 处 `outline: none` 改造
- [x] 守卫转绿（例 11，tokens-mu3-appica 12/12）；commit（096eb25）
  - 键盘 Tab 走查自测（双主题）：运行态目视取证，判明移交复核方随 §6 双主题逐屏目视一并执行（与执行指令「双主题逐屏目视验收由复核方亲跑」口径一致），非执行方代码交付面

### Task 7 — 文档

- [x] 新增 docs/specs/2026-08-09-ui-design-v3.md（§2-1 总表固化 + 7 级 label 规范 + 焦点环规范 + 决议反转记录）
- [x] ui-design-v2.md 顶部加取代注记（正文不动）
- [x] PROJECT_NOTES.md 进度节更新
- [x] 本计划 checkbox 按实勾选；commit（独立 docs commit）

### Task 8 — 验收与截图

- [x] 三件套全绿；`git diff main...feature/mu3 --stat -- src/minisd` 为空（完成定义硬项）
- [x] **执行方跑 `npm run e2e:mu2a` 与 `npm run e2e:mu2b`**：断言全过（mu2b 的 `CSS_SLOTS` 6 槽在三模式下均非空，验证别名链在真实渲染环境下解析成功——这是乙案能否成立的活链路证据，比单测的源文本断言更硬）（mu2a 7/7、mu2b 8/8，CSS 槽位三模式 true/true/true）
- [x] **18 张入库截图 artifact 重生成并入库**（mu2a 3 张 + mu2b 15 张）；**本轮不得 `git checkout --` 回退这些 artifact**（换板后新图即新事实，见 §7）
- [x] 交付报告（§9）随分支提交给出；双主题逐屏截图目视（§6 清单）判明移交复核方亲跑（运行态目视取证非执行方交付面）

## §5 红线（执行期硬约束）

1. 零新依赖；不装 @appica/ui-react、不引 Tailwind；只移植 token 值。
2. MIT 归属声明写进 tokens.css 头部注释（来源 URL + 版本 + 许可证 + 参考文件路径）。
3. raw 层取值唯一来源是参考文件；禁止联网重取、禁止凭印象写值（xterm 兜底换算值除外，须记录换算式）。
4. src/minisd 整目录零改动（完成定义含 git diff 自查为空）。
5. XSS 红线一行不动：Markdown 全链路禁 v-html/innerHTML；Icon.vue 静态字典豁免维持。
6. renderer-titlebar-stacking.test.ts 修订仅限 §3-4 申报范围（第 1 例 L54 **反转**为 `not.toMatch` + 头注重写），第 2-4 例一字不动、必须继续绿；**不得删除该断言**。
7. 三模式（跟随系统/强制暗/强制浅）能力不得退化；6 个切片标记逐字保留。
8. 不夹带 backlog（M5 真机验收、M7 subagent 与本轮无关）。
9. 测试读源码文本必须 `replace(/\r\n/g,'\n')` 归一化行尾（既有教训）；仓库 .gitattributes 已固定 LF，不新增行尾风险。
10. 执行中发现本计划未覆盖的决策点，停手报告，不自行拍板。

## §6 验收与完成定义

- [x] npm test 全绿；测试数估算 **1019 → ≈1030**（新守卫文件 +11 例，含 §3-4 配套的「组件侧 backdrop-filter 清零」；tokens-evolution 例数不变（8 例，2 例内容重锚）；diff/titlebar 例数不变，titlebar 第 1 例为断言反转不增减例数）—— **实际 1019 → 1031（98 文件）**：新守卫实落 12 例（7 级 label 拆「别名定义」与「组件消费清单」两例，见 tokens-mu3-appica 头注），比估算 +1
- [x] typecheck 0 错误；build 三产物成功
- [x] `git diff --stat -- src/minisd` 为空
- [x] `e2e:mu2a` / `e2e:mu2b` 执行方跑通（含 `CSS_SLOTS` 六槽三模式非空——别名链的活链路证据）；18 张入库截图 artifact 已重生成并提交
- [x] 既有断言账（口径见 §1，两类值锚不可混算）：30 处 `var()` 断言 = **25 名锚零改动绿 + 5 值锚**按 §3-3 改法绿；另 **6 处纯字符串值锚**按 §3-1 重锚绿；titlebar 1 处按计划内修正绿
- [x] 双主题逐屏截图目视，场景 **≥ 10**：对话流（含 markdown/工具行/EventNote）、左栏会话列表、右栏三面板（Files/Artifacts/Progress）、设置模态、**Provider 设置告警态（.miss/.inp.warn/.addbtn.confirm，自审补入——`--orange` 实为 6 处消费，见 §1）**、设备/配对面、权限卡、空状态、终端面板、焦点环 Tab 走查（每主题 ≥1 张代表）＝ **≥20 张**（10 场景 × 2 主题）—— 判明移交复核方亲跑（运行态目视取证非执行方交付面）
- [x] 重点目视项：正文基色中灰化（--label→foreground base）、用户气泡暗色变实（fill-tertiary→background-muted）、状态块 alpha 略弱（命门 3）、sheet 圆角 +4px、hairline 变浅（separator→border）、助手头像金色退场、**ProviderSettings 告警态 iOS 橙 → Appica warning-emphasis** —— 同上，判明移交复核方亲跑
- [x] 计划 checkbox 全勾；独立 docs commit（ff47a96；Task 8/§6 各项随截图 commit 收尾勾选）

## §7 影响面清单

**改（src/renderer 侧）**：tokens.css（重构）；ChatView、TitleBar（material + 硬编码 + label + 焦点环）；DevicesModal、SettingsModal、TerminalPanel（硬编码/焦点环）；ArtifactsPanel、DiffView、EmptyState、FilesPanel、ModelPicker、PermissionCard、PermissionPicker、ProgressPanel、ProviderSettings、SessionList、ToolLine（label 升级 + 部分焦点环）。
**不改（组件）**：EventNote、FadeText、FileTreeNode、Icon、MarkdownInline、MarkdownView、App.vue、rpc.ts、main.ts。
**测试**：tokens-evolution（重锚）、diff（重锚）、renderer-titlebar-stacking（计划内修正）、tokens-mu3-appica（新建）；其余 5 个含 token 断言的测试文件零改动。

**e2e 与入库截图 artifact（自审补入，初稿完全遗漏）**：

- `scripts/e2e-mu2b-acceptance.mjs:471` 定义 `CSS_SLOTS = ['--surface-1','--action','--on-action','--state-ok','--state-warn-bg','--fs-body']`，在 light/dark/system 三模式下逐一断言 `getComputedStyle(document.body).getPropertyValue(k)` 非空。**乙案下 6 个名字全部保留为别名 → 该用例继续绿，脚本零改动**；反之甲案（全量改名）会把 e2e 一并打红——这是初稿没算进去的、支持乙案的额外证据。
- **18 张入库截图 artifact 会全部过时**：`scripts/e2e-shots-mu2a/`（3 张：light/dark/system）+ `scripts/e2e-shots-mu2b/`（15 张：3 模式 × chat/progress/artifacts/settings/devices）。它们是 MU2a/MU2b 在 **Apple HIG 调色板下**的视觉验收记录，换板后与实际产品不符，**必须由执行方重跑 `e2e:mu2a`/`e2e:mu2b` 重生成并入库**（Task 8）。
  - 注意与既有教训的方向差异：平时「复核方亲跑 e2e 会刷新入库 artifact 字节 → 定向 `git checkout -- <artifact 目录>` 恢复」是正解；**本轮相反——重生成的 artifact 就是新事实，必须提交，不得 checkout 回退**。
**文档**：本计划 + 参考 CSS（本轮）；v3 新增、v2 注记、PROJECT_NOTES（执行期 Task 7）。
**零改动面**：src/minisd 整目录、src/main、src/preload；组件 517 处 var() 引用零改动；组件 DOM/逻辑零改动。

## §8 执行顺序与 commit 规划

分支 `feature/mu3`，**从 main 最新处切**（本轮三笔文档 commit 已直接落在 main 上，见下）。commit 链（conventional + 中文）：

0. ~~计划交付~~ **已完成，且已在 main 上**：`a9b3033`（参考 CSS）→ `02c8296`（本计划）→ `e389152`（自审订正 5 处 + §10）。**执行方不要重复提交计划文档**；`feature/mu3` 从 `e389152` 之后切，第一笔实现 commit 即下面第 2 条。
   （自审注：§8 初稿写「从 main@3555b85 切 + commit 1 为计划交付」，与文档实际落点不符——照此执行会重复提交。已订正。）
2. `test(mu3): 守卫重锚（tokens-evolution/diff/titlebar-stacking）+ tokens-mu3-appica 新守卫（先红）`
3. `feat(mu3): tokens.css 双层重构——Appica raw 层照抄 + 语义别名层重锚（含 MIT 头注）`
4. `feat(mu3): material/backdrop-filter 全退场 + TitleBar 层叠论证修订（测试计划内修正申报）`
5. `feat(mu3): 9 处硬编码收编（scrim token 化/xterm 兜底换算/kbd 等效改写/阴影走 shadow-color）`
6. `feat(mu3): 22 组件 7 级 label 清单化改造（15 改 7 不改）`
7. `feat(mu3): 焦点环 token 应用——10 组件 :focus-visible + outline:none 改造`
8. `docs(mu3): ui-design-v3 新增 + v2 取代注记 + PROJECT_NOTES 进度 + checkbox 勾选`
9. `test(mu3): 重跑 e2e:mu2a/e2e:mu2b 并重生成 18 张入库截图 artifact（换板后新图即新事实）`

先红说明：Task 1 一笔全红（新守卫 + 重锚 + titlebar），Task 2-6 逐片转绿；每 Task 先跑对应测试文件确认失败形态，实现后跑该文件转绿，再跑全量确认无连带。

## §9 交付报告要素

- 每 Task 的红/绿证据（失败形态记录 + 转绿输出）
- 11 处值锚（含 `var()` 5 + 纯字符串 6）改法与理由清单（对照 §3-1/§3-3）
- xterm 兜底 4 值的 oklch→srgb 换算式与结果
- 测试数 1019 → 实际值（与估算 1029 的偏差说明）
- 双主题截图索引（≥20 张）+ 重点目视项结论
- `git diff --stat -- src/minisd` 为空 的证据
- 偏差与申报项汇总（本计划全部「申报」标注点的最终处置）

## §10 自审记录（本计划由复核方自撰，故按「他人交付物」再审一遍）

本计划非 Trae 所写，缺少两方互检，因此落盘后按既有纪律（M4.5 教训：**写完自己的计划要当成他人交付物复核一遍**）自审一轮。**结论：架构判断站得住，账目/自洽性/影响面/时序有 8 处错，已全部订正。**

站得住的部分（复测验证）：

- 引用的 25 个 Appica token 名**全部存在**于参考文件（逐个 `grep -c` 验证）。
- 圆角旧值逐一属实：8/10/12/16/18/20/999px；`--radius: 0.875rem` 的 11 阶派生算术全部核对无误（5 个等值、sheet 20→24）。
- tokens.css 确为 287 行、4 段结构、6 个切片标记齐全。
- `--brand`/`--on-brand`/`--purple`/`--blue`/`--yellow` 零消费属实（这是乙案与「删 brand」成立的前提）。

订正的 8 处错：

| # | 缺陷 | 性质 | 订正处 |
|---|---|---|---|
| 1 | `--orange` 误记为 1 处，实为 **6 处 / 5 行 / 2 文件** | 事实错。源于一条只匹配 `yellow\|purple\|cyan\|blue` 的正则，orange 系同行捎带出现被误读。**漏掉 ProviderSettings 整个告警态的视觉影响面** | §1、§6 截图清单 +1 屏、§6 重点目视项 |
| 2 | 「值锚 11 + 名锚 19 = 30」是**假平衡** | 口径错。11 里有 6 处（Apple 原值抽样）不含 `var(`、不在 30 之内；真实分桶为 **值锚(var) 5 + 名锚 25 = 30**，另有 6 处纯字符串值锚独立计。且原名锚清单**漏列 L87/L88** | §1、§3-2、§6、§9 |
| 3 | 「13 改 9 不改」与 Task 5 表不符，实为 **15 改 7 不改** | 计数错。该数字是 Task 5 的完成判据，错了会让执行方按错误基数自查 | Task 5、§8 commit 6 |
| 4 | §2-2 的 `--label-strong` 消费清单 12 项，与 Task 5 表的 14 项不一致（漏 DevicesModal 分组标题、EmptyState 要点标题） | 内部不一致 | §2-2 |
| 5 | §3-2 写「22 个被断言 token 名 **21 留 1 删**」，把 `--on-brand` 错记为保留 | **自相矛盾**。§2-1 明写 `--brand`/`--on-brand` 两个都删；实为 **20 留 2 删**。执行方若照 §3-2 保留 `--on-brand` 别名，会与 §2-1 直接打架 | §3-2 |
| 6 | §8 写「从 main@3555b85 切 + commit 1 为计划交付」，与文档实际落点不符（三笔文档 commit 已直接落在 main） | 与仓库现状脱节。照此执行会**重复提交计划文档** | §8 |
| 8 | **titlebar 第 1 例的「先红」预期与 §3-4 授权的修订内容自相矛盾**（用户评审指出） | **时序错 + 守卫真空**。§3-4 原授权「删除 L54」，但删完只剩 position/z-index 两条本就满足的断言 → Task 1 修订后立刻转绿，「预期红」不成立；且全仓库仅此一条断言提及 `backdrop-filter`，删除后 Task 3 摘除 4 处滤镜无任何回归守卫。改为**反转**为 `not.toMatch`：Task 1 红得对、Task 3 转绿、守卫换向续命，并配套加宽为组件级清零守卫 | §1、§3-4、Task 1、Task 3、§5、§6 |
| 7 | **影响面完全遗漏 e2e 与入库截图 artifact** | 漏面。初稿 §7 一字未提 e2e：① `e2e-mu2b:471` 的 `CSS_SLOTS` 六槽三模式校验（乙案下继续绿，但这是对乙案的硬约束，也是甲案代价的追加证据）；② **18 张入库 PNG**（mu2a 3 + mu2b 15）是 Apple 板下的视觉记录，换板后与产品不符，必须重生成入库，且**不得按既有习惯 checkout 回退** | §2-1、§7、§6、Task 8、§8 |

**教训（可复用）**：① 用正则统计消费面时，**匹配组之外的 token 会在同一行捎带出现**，逐行读输出容易把邻近 token 记到匹配组头上——统计每个 token 必须各跑一次 `grep -o`。② 断言账目必须先定义口径再相加；两个不同口径的数字凑出一个「正好对上」的总数，是最容易骗过自己的一类错。
