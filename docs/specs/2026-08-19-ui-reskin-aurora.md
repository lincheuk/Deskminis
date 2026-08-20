# E 波设计稿：Aurora 换皮——深空控制台骨架 × 流光玻璃材质

状态：**已落地**（用户 2026-08-19 确认全稿；E1 3d0c280 → E2 64cdcc5 → E3 7bd7db2 → E4 baae4d7，
四步全过审，1509→1559 例；§6.2 键盘补课经查已由 cc9363a+MU5 提前落地，E4 实际交付为防回归守卫）。
执行期偏离与观察项见 PROJECT_NOTES E1–E4 审核记录。

## §0 拍板记录（2026-08-19 用户拍板）

| 决策点 | 结论 |
|---|---|
| 方向 | **A 的骨架 + C 的材质**（提案画布 OptionA「深空控制台」的布局/数据语言 + OptionC「流光玻璃」的表面材质），定名 **Aurora（极光控制台）** |
| 实施深度 | **换皮**：重做 tokens 层 + 组件 `<style>` 局部形态；DOM 结构与全部既有测试选择器锚不动。唯一 DOM 开口 = §6 无障碍补课的属性级微创（加 `tabindex`/`role`/`@keydown`，不增删元素、不改类名） |
| 主题策略 | **亮暗双主题**。四段结构（`:root` 浅 / 媒体暗 / 强制暗 / 强制浅）与 appearanceMode 0/1/2 机制原样保留 |
| 顺带补课 | **做**：三级文字对比度过 AA（直接设计进新色板）+ 9 个 div 控件键盘可达 |

前提确认（已核实源码）：现有 App.vue 骨架 = taskbar 任务条 + rail 图标轨 + pane-l 会话列 + pane-chat 主列 + pane-w 工作台右栏——与 OptionA 画布骨架**天然同构**，换皮深度成立，无需动布局 DOM。

## §1 视觉概念

- **暗色「深空极光」**（主人格）：深空靛蓝底（非纯黑，hue 262 微靛）上铺三色极光微斑（青/紫/玫瑰，alpha ≤9%），面板是磨砂玻璃浮岛（半透明 + blur + 顶缘内高光），全局**单强调色 = 青**（`#78edd0` 系），语义色只留给状态。科技感来自 A 的精密：等宽数据字、细亮描边、克制的发光。
- **浅色「云上极光」**：冷白底（hue 220 微青）+ 更淡的极光斑 + 纯白浮岛卡，强调色换深青（`#007370` 系）保对比度。不是「暗色的反相」，是同一世界观的白天面。
- **字体**：零新资产。继续系统栈（`--font-ui` Segoe UI Variable + Noto Sans SC…、`--font-mono` Cascadia Code…，MU5 拍板值一字不动）。A 骨架的「等宽数据感」靠**扩大 mono 应用面**实现（§4），不靠新字体。提案画布里的 Space Grotesk/Sora 是画布示意字体，不落地——tokens 是规范，画布不是。

## §2 Aurora 调色板（tokens A 区）

**取值唯一来源**：[`2026-08-19-aurora-tokens-reference.css`](2026-08-19-aurora-tokens-reference.css)（本设计稿伴生文件，已定稿）。规矩承接 MU3 红线：tokens.css A 区四段与参考文件逐行一致，禁止凭印象写值；改色先改参考文件并过对比度守卫。

要点：

- **槽位体系不变**：Appica 的全部槽名保留（foreground 7 / background 5 / border 7 / primary 6 / secondary 8 / error·success·warning·info 各 8 / focus-ring 9 / radius 系 / shadow·selection），组件与 B 区零感知。唯一结构新增：`--aurora-1/2/3` 三个极光斑槽（浅暗各一套）。
- **secondary 族整体换轴**：蓝（hue 260）→ 青（hue 175–200）。`--accent`/`--link`/`--action` 的 B 区映射不动，自动变青。
- **状态色**：暗段四族逐字继承 Appica（验算全过）；浅段文本档（emphasis/subtle/soft/strong/intense）压深重调——Appica 原浅段 error-emphasis 在白底仅 ~3.9:1，本来就不过 AA，这次一并治了；浅段装饰档（基准/muted）继承。
- **补课主角 `--foreground-subtle`**：暗 0.551→**0.64**、浅 0.707→**0.50**，在全部三层 surface 上 ≥4.5，且与 secondary 级保持 1.5× 亮度差，层次不糊。
- **`--font-mono` 豁免机制保留**：参考文件写原始栈，tokens.css 里带 CJK 回退（守卫例 2 的 RAW_FONT_MONO_OVERRIDE + 例 13 机制一行不改）。

WCAG 验算（脚本：`oklch → linear sRGB → 相对亮度 → 对比度`，标准数学无依赖；按 sRGB clamp 后实际渲染色计算）——**26/26 全过**：

| 文本对（暗） | 比值 | | 文本对（浅） | 比值 |
|---|---|---|---|---|
| tertiary on surface-0/1/2 | 5.78 / 5.33 / 4.56 | | tertiary on 白 / 分组底 / fill | 5.98 / 5.36 / 4.80 |
| secondary on surface-2 | 6.77 | | secondary on fill | 6.49 |
| label on surface-2 | 12.46 | | label on fill | 9.81 |
| accent 文本 on surface-0/2 | 13.72 / 10.82 | | accent 文本 on 白 | 5.72 |
| 深字 on accent 钮底 | 13.72 | | 白字 on accent 钮底 | 5.72 |
| focus-ring on 底（需≥3） | 5.57 | | focus-ring on 白（需≥3） | 3.79 |
| err/ok/warn/info 文本 on 底 | 5.08 / 7.88 / 6.71 / 7.16 | | err/ok/warn/info 文本 on 白 | 5.40 / 5.31 / 5.83 / 5.86 |

色板速览（sRGB 换算）：暗底 `#080d17 / #111722 / #1e2532`，暗字五级 `#818d9f → #f3f4f7`，青强调 `#78edd0`；浅底 `#f9fcfc / #eef3f5 / #e0e8eb`（卡面纯白），浅字五级 `#576574 → #1b2433`，深青强调 `#007370`。

## §3 B 区映射与 C 区材质令牌改动

B 区映射（组件消费面）**仅 4 处换挡**，其余逐行不动：

| 别名 | 现值 | 新值 | 为什么 |
|---|---|---|---|
| `--bg`（仅浅段） | `var(--background)` | `var(--background-subtle)` | 浅色要「纯白浮岛卡浮在微冷白底上」；暗段映射不动 |
| `--on-action`（仅暗两段） | `var(--foreground-intense)` | `var(--secondary-foreground)` | accent 换成**亮青**后，白字在青钮底上仅 1.36:1 不可读；换「青底深字」13.72:1（浅段白字深青底 5.72，不动） |
| `--r-card` | `var(--radius-sm)`（12px） | `var(--radius-md)`（14px） | C 材质大圆角，卡片一档 |
| `--r-input` | `var(--radius-lg)`（16px） | `var(--radius-xl)`（18px） | 输入卡是视觉主角，圆角随材质 |

（`--r-sheet` 24px、`--r-control` 8px 保持；`--radius` 基准不动，纯换挡零新值。`--purple` 目前零消费，维持定义并注记「若启用需先设独立紫槽」。）

C 区玻璃切片扩展（全部 color-mix 从语义令牌调出，主题自动分叉，例 5/9 纪律照旧）：

```css
/* 极光底：铺在 .shell 的三斑径向渐变，纯 CSS 零资产、无 blur 零开销 */
--aurora-ground:
  radial-gradient(52% 44% at 12% 0%,   var(--aurora-1), transparent 70%),
  radial-gradient(44% 40% at 88% 8%,   var(--aurora-2), transparent 70%),
  radial-gradient(40% 36% at 55% 100%, var(--aurora-3), transparent 72%);
/* 浮岛顶缘高光加强（现 7% → 10%，玻璃「有厚度」的关键） */
--glass-edge: color-mix(in oklch, var(--label) 10%, transparent);
/* 青色微光描边：A 的发光语言，用于活跃元素（运行中任务条、焦点卡） */
--glow-accent: color-mix(in oklch, var(--accent) 32%, transparent);
```

`--glass-thin/thick/blur/ground` 保持现值。

## §4 骨架形态清单（A 的语言，逐组件 `<style>` 层改动）

零 DOM。每项都只改样式：

| 部位 | 现状 → Aurora 形态 |
|---|---|
| `.shell` 底 | 平色 → `var(--bg)` + `--aurora-ground` 极光斑（App.vue 一处） |
| `.taskbar` 任务条 | 灰条 → HUD 条：玻璃底、`--font-mono` 读数、运行中 `.tb-dot` 青色 + `--glow-accent` 脉冲光晕、`.tb-pend` 权限徽记青底深字胶囊 |
| `.rail` 图标轨 | 玻璃底、活跃项左缘 2px 青色指示线 + 图标微光 |
| `.pane-l` 会话列 | 卡片浮岛化：`--r-card` 圆角、顶缘高光、活跃卡青色细描边 |
| 消息流（ChatView） | 助手消息卡：实心浮岛（`--surface-1` + 顶缘高光 + 柔影；**不用 blur**，§5）；用户消息保持青系胶囊 |
| ToolLine 工具行 | `mcp__`/工具名走 `--font-mono`；运行中行左缘青色活动线 |
| ThinkingBlock | 细描边半透明卡 + 「思考 · N 秒」读数走 mono |
| PermissionCard 权限卡 | 浮岛卡 + 左缘 3px 青色警示线（MCP/工具名 mono），按钮组主钮青底 |
| web_search / MCP 工具卡 | 同浮岛语言；来源数、耗时等读数一律 mono |
| 输入卡（composer） | `--r-input` 18px 圆角浮岛、聚焦时 `--glow-accent` 外光 1px→2px；chip（工作区/权限档/模型）mono 字 |
| `.wtabs` 工作台页签 | 玻璃底、活跃页签底缘青色指示线、`.lv` 活动点青色 |
| 设置页（Settings/Provider/Skills/Mcp） | 分组卡浮岛化、`.sitem` 活跃项青色指示线、开关/主钮换青 |
| 读数 mono 应用面 | 耗时、步数、模型名、token 量、端口/路径类读数统一 `font-family: var(--font-mono)`（各组件就地加） |

## §5 材质应用面与性能纪律（C 的语言）

玻璃（`backdrop-filter`）白名单从 `['ProgressPanel']` 扩为：

| 组件 | 用量 | 依据 |
|---|---|---|
| App.vue（taskbar/rail/wtabs 三处壳层） | `--glass-thin` | 贴极光底，透出斑色才有「流光」；壳层数量恒定，开销 O(1) |
| ProgressPanel | 已有，保持 | 白名单现任 |
| ArtifactsPanel / FilesPanel | `--glass-thin` 面板头 | 轻量、无弹层 |

**硬边界**（守卫例 8 双保险原样保留）：POPUP_OWNERS（TitleBar/ModelPicker/PermissionPicker/SettingsModal/DevicesModal/ChatView/SessionList）**永久禁 blur**——层叠上下文会压死弹层（TitleBar 实测取证在案）。所以消息卡、输入卡、设置 sheet 一律用**实心浮岛**（不透明 surface + 顶缘高光 + 柔影）模拟质感，不透底。这同时就是性能纪律：blur 面数量恒定 ≤6（壳三 + 面板三），不随消息数增长；`--glass-blur` 保持 20px 不加码。

提案画布 OptionA 的「任务条水位 41%」**不落地**：现有 agent 循环没有总步数概念，水位是伪数据源；running 态用青点脉冲 + mono 步数读数表达活动，诚实且零 DOM。

## §6 无障碍补课

**6.1 对比度**（已在 §2 色板层解决）+ 新增**对比度守卫测试** `tests/tokens-aurora-contrast.test.ts`：内置 oklch→sRGB→WCAG 纯数学函数（~40 行，零依赖），从 tokens.css 浅暗两段正则抓值，断言 §2 表格全部 26 对。**从此改色板必过 AA 闸**，欠账不再复发。TDD 首红：在现 Appica 值上 tertiary 四断言红。

**6.2 键盘可达 9 控件**（唯一 DOM 开口，属性级微创，类名/结构/事件不动）：

| 控件 | 改法 |
|---|---|
| TitleBar `.tb-ico` `.mi` `.it`、SessionList `.scard` `.newbtn`、SettingsModal `.sitem` `.opt`、PermissionPicker `.mrow`、ModelPicker `.mrow` | 各加 `role="button"` + `tabindex="0"` + `@keydown.enter.prevent="…"` `@keydown.space.prevent="…"`（复用既有 click 处理器） |

统一用 `role="button"` 最小语义（不上 listbox/aria-selected 结构工程，那是独立里程碑）。新增守卫 `tests/renderer-a11y-keyboard.test.ts`：断言 9 个类名所在元素模板同时带 `tabindex`、`role` 与 `@keydown`；MU3 的 26 个 `:focus-visible` 守卫（例 11）不动，从此 9 个空转环真正可达。

## §7 守卫迁移表（21 例逐条裁定 + 新增 2 文件）

`tokens-mu3-appica.test.ts`（13 例）：

| 例 | 裁定 |
|---|---|
| 1 归属四要素 | **改锚**：REF 指向 aurora 参考文件；头部归属改「结构承自 Appica（MIT）+ Aurora 自研，取值唯一来源 = aurora 参考文件」 |
| 2 A 区逐行一致 | **只换 REF 路径常量**，解析逻辑（section/decls/THEME_INDEPENDENT/RAW_FONT_MONO_OVERRIDE）一行不改；新参考文件沿用 `:root,.light` + `.dark` 块结构 |
| 3 别名映射总表 | **改 2 处锚**（浅段 `--bg` 换挡成新分叉项；`--on-action` 暗段期望值换 `--secondary-foreground`，§3） |
| 4 label 7 级定义 | 保留 |
| 5 color-mix 仅限玻璃块 | **白名单扩至新令牌**（--aurora-ground/--glass-edge 新值/--glow-accent 仍在 glass 切片内，逻辑不改） |
| 6 material 清零 | 保留 |
| 7 圆角 6 映射 | **改 2 行锚**（--r-card/--r-input 换挡，§3） |
| 8 backdrop-filter 白名单 | **ALLOW 扩容**（§5 表），POPUP_OWNERS 双保险逐字保留 |
| 9 零硬编码 + xterm 白名单 | 逻辑保留；**xterm 兜底三值按新色板换算同步**（暗字 `#d0d6df`、浅字 `#3c4959` 等，E2 步内给定稿值） |
| 10 label 消费清单 | 保留 |
| 11 焦点环 26 处 | 保留 |
| 12 scrim 收编 | 保留 |
| 13 mono CJK 回退 | 保留 |

`tokens-evolution.test.ts`（8 例）：「Appica 原值 6 组抽样锚」**换 Aurora 抽样锚**（新参考文件 6 组代表值）；其余 7 例（尺度唯一、语义槽四段、state 直给、迁槽清零等）逐字保留。

新增：`tokens-aurora-contrast.test.ts`（§6.1）、`renderer-a11y-keyboard.test.ts`（§6.2）。

## §8 功能覆盖表（「目前有的功能完美做进去」的兑现清单）

换皮零功能增删。全部现有能力逐项确认不受影响，仅视觉形态变化：会话管理（新建/改名/切换/rail 折叠）、消息流全形态（文本/思考块/工具行/权限卡/图片 chip/事件注记/Markdown+代码块）、web_search 卡、MCP 权限卡与 askOnce 档、设置四页（Provider/Skills/MCP/Devices）、模型选择、权限档切换、任务条与权限徽记、工作台四面板（进度/产物/文件/终端）+ 未启用占位两页、亮暗主题切换、全部 RPC 面。验收即 §9 每步的云端真跑截图 × 亮暗两主题。

## §9 拆步计划（E 波，每步一个 Trae 提示词，TDD + commit/push 收尾）

| 步 | 内容 | 先红守卫 |
|---|---|---|
| **E1** | Aurora 色板落地：参考文件入库（已定稿，照抄本稿伴生文件）→ 写对比度守卫（红）→ tokens.css A 区四段替换 + B 区 3 行换挡 → 改锚（例 1/2/3/7 + evolution 抽样锚）→ 全绿 | tokens-aurora-contrast |
| **E2** | 壳层与材质：极光底 + 玻璃三处壳层 + 例 8 白名单扩容 + xterm 三值换算 + taskbar/rail/wtabs HUD 化 | 例 8 改锚先红 + 新形态源码断言 |
| **E3** | 内容区形态：消息卡/思考块/工具行/权限卡/输入卡/设置页浮岛化 + mono 读数应用面 | 各组件源码守卫新断言 |
| **E4** | 键盘可达补课：9 控件属性微创 + a11y 守卫 | renderer-a11y-keyboard |

每步纪律照 D 波成例：开工 `git pull --ff-only`、`-F` 消息文件提交（`E1: …`）、push 重试退避、远端验证贴输出；我逐 commit 审 + 云端复跑 + xvfb 双主题截图目视。E4 完成后用户真机目视双主题为收官硬条件。
