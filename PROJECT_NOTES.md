# DeskMinis — 桌面端 Agent 应用（基于 OpenMinis 理念）项目笔记

> 本项目**独立于 bitapi/onerelay**，所有工作只在 `C:\Users\24739\Downloads\openminis1\` 下进行。
> 建议在本目录单独打开 Claude Code 会话继续此项目。

## 目标

做一个 Windows 桌面端（exe）的类 Codex Agent 应用，借鉴 OpenMinis
（`./OpenMinis/`，仅作架构参考）的理念：Agent 循环、技能系统、持久记忆、
工作区、沙箱执行。支持上下文同步与设备内网同步。

## 参考项目

- `./OpenMinis/` — 官方仓库克隆（2026-07-26），iOS Swift/SwiftUI + Android
  Kotlin/Compose，沙箱用 iSH (iOS) / PRoot (Android)。
- 注意：代码不可直接复用到 Windows；GPLv3 协议，若衍生其代码则本项目也须 GPLv3。
- 关键参考文档：`OpenMinis/docs/specs/`（debug-server-api、minis-url-scheme）、
  `OpenMinis/README.md`（技能系统、工作区设计）。

## 已确认的设计决策（2026-07-26 头脑风暴，进行中）

| 议题 | 决定 |
|---|---|
| 项目名 | **DeskMinis**（暂定私用，公开发布前需评估与官方品牌的区分） |
| 产品形态 | 通用 Agent 桌面应用 + 强化编码能力（Minis 理念 + Codex 能力兼顾） |
| 同步方案 | 先做桌面端之间的内网互同步；协议设计为开放格式，将来手机端可接入 |
| 技术栈 | Electron (TypeScript) |
| 执行环境 | 双模式：默认宿主机直接执行（带权限确认）+ 可选 WSL2 沙箱 |
| 模型接入 | 四轨并行进第一版：OpenAI 兼容自定义端点、Anthropic 原生、Gemini 原生、Ollama 本地 |
| 技能系统 | SKILL.md 生态兼容（可直接用 MinisSkills/Claude 技能）+ MCP 双轨 |
| 同步范围 | 会话上下文、持久记忆、工作区文件（按工作区可选开启）、技能+设置（敏感项加密） |
| 同步拓扑 | 默认 P2P（mDNS 发现 + 直连），也可配置常开中心节点 |
| 界面布局 | 三栏式工作台：左=工作区/会话列表，中=对话流（内嵌工具调用/diff），右=可收起的终端/文件/任务面板 |

## 已完成

- ✅ 深度阅读 OpenMinis 代码库 → 九份研究报告 `docs/research/`
- ✅ 设计文档（用户逐节确认）→ `docs/specs/2026-07-26-deskminis-design.md`
- ✅ M1 实施计划（14 个 TDD 任务）→ `docs/plans/2026-07-26-m1-skeleton.md`
- ✅ **M1 骨架 + 端到端验收（2026-07-28）**：Electron 三进程 + minisd 独立进程
  （WebSocket JSON-RPC + per-run token）、Agent 循环、Anthropic/OpenAI 兼容双 Provider、
  shell/file 工具 + 权限网关、SQLite 会话存储、OpenMinis 复刻三栏 UI。130/130 测试、
  typecheck、build 全绿。验收：`npm run e2e`（`deskminis/scripts/e2e-acceptance.mjs`，
  可重复回归）5/5 通过，真实 provider=nodetect/grok-4.5。
- ✅ **M2–M6、MU1/MU2（2026-07-28 ~ 2026-08-09）**：记忆/压缩、技能、Windows 桥、
  右栏 UI、M3a/b/c 同步与接力、提示层加固、模型目录、安全加固、打包、可观测与控制权；
  各里程碑完成状态与验收记录见 `docs/plans/` 对应计划文档（checkbox 全勾）。
- ✅ **MU3 Appica 视觉语言移植（2026-08-09）**：Apple HIG 取值层整体退场，
  tokens.css 按双层架构重构（Appica raw 层照抄参考文件 + DeskMinis 语义别名重锚），
  组件 517 处引用零改动；label 4→7 级、material/backdrop-filter 全退场、
  9 处硬编码收编、10 组件焦点环补齐。设计定稿 → `docs/specs/2026-08-09-ui-design-v3.md`
  （v2 加取代注记）。1031/1031 测试、typecheck、build 全绿。
- ✅ **MU5 工作台形态重构（2026-08-10）**：布局 B——**flex 关系反转**为
  图标轨 52（可展开 212）| 对话列 336 定宽可拖 | 工作台 1fr。变的不是数值，是哪一栏承担弹性。
  顶部任务条把「当前动作/步数/耗时/上下文水位」摆到常驻位（回应「右栏四标签装的全是结果、
  过程全程不可见」的诊断）；工作台标签改数组渲染，可关闭、可多开（产物卡点击开出文件标签）；
  对话去气泡收尾（行高 1.72）+ 输入卡浮起 + ＋ 附件入口；会话行改状态点 + 右对齐时间；
  中文字体切 Noto Sans SC。**纯 renderer，`src/minisd`/`src/main`/`src/preload` 三目录零改动。**
  1048/1048 测试、typecheck、build、`e2e:mu2a` 7/7、`e2e:mu2b` 8/8 全绿。
  设计定稿 → `docs/specs/2026-08-10-ui-design-v4.md`，拍板稿入库 → `docs/prototypes/mu5/layout-b.html`
  （消费真实 tokens.css，故「换板与否」有图可验；结论：不换）。MU4 废止，其立项依据转 MU6。

- ✅ **MU6 能力接线 · 第一轮（2026-08-10）**：把「后端建成但前端没入口」的能力接出来。
  重新核实的事实：`src/minisd` 注册 **45 个方法、24 个渲染端零引用**（此前记的「33/15」只数了
  `index.ts`，漏了 `remote/` 与 `sync/`）；24 个里 **7 个是协议内部零引用是对的**，
  真正缺入口的 **17 个**。本轮按拍板接前三组：会话操作（删除 / 记忆开关 / 模型绑定）、
  技能管理（设置页第 5 页：启停 / 删除 / 本地目录导入）、同步控制（M6 的暂停开关 + 常驻暂停态）。
  **纯 renderer，三目录零改动、零新依赖。** 1068/1068 测试、typecheck、build、
  `e2e:mu2a` 7/7、`e2e:mu2b` 8/8、**新建 `e2e:mu6` 6/6**。
  计划 → `docs/plans/2026-08-10-mu6-capability-wiring.md`（§7 记了 e2e 当场逮到的致命 bug）。
  剩余四组（模型组 5 / 审计日志 1 / 预检 1）归 MU7。

## 关键发现（写进设计的依据）

- OpenMinis iOS 已有传输无关的 Sync V2 架构 + `LANTransport.swift` 骨架（未实现），
  注释写明预期协议：mDNS `_minis-sync._tcp` + WebSocket + PortableRecord JSON 批次。
  DeskMinis 照此实现即可为将来手机端接入预留互通。
- 数据格式全部同步友好：会话 SQLite（parts_json 跨平台字节兼容）、记忆纯 Markdown、
  技能原样 SKILL.md、MCP 用 Claude Desktop 兼容 servers.json。
- 要修的 OpenMinis 缺陷：LAN 无历史回填、密钥无差别广播、工作区文件不处理删除/重命名/
  无内容哈希——设计 §6 已给出修补方案。
- **同一 minis.db 只能被一个 minisd 进程持有**（2026-07-28 验收时发现）：第二个进程
  在 `journal_mode = WAL` 处即报 `disk I/O error`。e2e 验收/未来 --headless 调试前须
  先退出应用；不影响产品形态（minisd 本就是每应用一个的 utilityProcess）。

## 进行中 / 下一步

- **写 M2 实施计划**（沿用 M1 的 TDD 计划格式）：Gemini/Ollama Provider、模型组降级、
  上下文压缩/卸载、记忆系统、技能系统（SKILL.md 生态兼容）、windows-* 桥、
  右栏终端/文件/任务面板完整 UI
- 之后依次 M3（内网同步）、M4（文件同步+打包）

### Backlog（MU6 执行期再次兑现代价）

- **`.vue` 不在 typecheck 覆盖内，这一轮直接造成一次「全绿但界面空白」**：
  `v-for` 挂在 `.scard` 而非包住兄弟节点的 `<template>` 上，`renderList` 抛错、整个会话列表渲染挂掉。
  1068 例源码守卫全绿、typecheck 零错误、build 成功，**只有 e2e 真跑起来才暴露**。
  换 `vue-tsc` 仍是新依赖（各轮红线 3 一直禁），但代价已经兑现两次，值得单独立项评估。

### Backlog（MU5 执行期发现）

- **`.vue` 不在类型检查覆盖内**：`npm run typecheck` 是 `tsc --noEmit`，而 `tsc` 只解析
  `.ts/.tsx/.d.ts`——`include` 里的 `.vue` 被静默跳过。约 2900 行 SFC 代码零类型保护。
  MU5 期间就此漏过一个真 bug（托盘回调引用已删除的 `rightOpen`，改名后成悬空引用，
  测试与 build 都没报）。修法是把 typecheck 换成 `vue-tsc`，但那是新依赖（MU5 红线 3 禁止），
  故记为独立决策项。
- **源码文本守卫看不见「难看」**：MU5 有两个缺陷是 1048 例全绿 + e2e 16/16 全过之后
  靠看真机截图才逮到的（输入卡 chip 逐字换行、Vue scoped CSS 类名撞车致收起工作台后大片死白）。
  详见 `docs/plans/2026-08-10-mu5-workbench-layout.md` §11。**目视验收不可被测试替代。**
- **e2e 的 localStorage 不随临时数据根隔离**：renderer 偏好落在 Electron userData 下，
  跨次残留。MU2b 时默认值与复位值相同看不出来；MU5 换默认值后立刻显形（例 1 读到上一轮的尾巴）。
  已在 `e2e-mu2b-acceptance.mjs` 开测前显式清键并断言清干净。同类脚本可照此加固。

### Backlog（MU3 交付复验发现，独立决策项）

- **三级文字对比度不过 WCAG AA**：`--label-tertiary`/`-quaternary` → `--foreground-subtle`，浅 2.60 / 暗 4.16（AA 需 4.5）。
  这是**从 Apple 调色板继承的既有缺口**（旧值浅 1.73 / 暗 2.25，MU3 已把它改善 +50%~85%），非 MU3 引入。
  补齐需把三级上提到 `--foreground-muted`（浅 4.84），代价是与次级同色、压掉一层层次——属独立无障碍决策，
  实测数据见 [ui-design-v3.md §8](docs/specs/2026-08-09-ui-design-v3.md)。
- **9 个 div 型控件键盘走不到**：MU3 落地的 26 个 `:focus-visible` 里 17 个生效、9 个空转
  （TitleBar .tb-ico/.mi/.it、SessionList .scard/.newbtn、SettingsModal .sitem/.opt、PermissionPicker .mrow、ModelPicker .mrow）——
  它们是 `<div @click>` 无 `tabindex`，Tab 到不了。成因是 MU3 §2-5（补键盘可达性）与 §1.2（禁动 DOM）的内在矛盾，
  样式层已尽力。补齐需 DOM 层改造（tabindex + Enter/Space + role），属独立无障碍里程碑。
  详见 [ui-design-v3.md §5-1](docs/specs/2026-08-09-ui-design-v3.md)。
