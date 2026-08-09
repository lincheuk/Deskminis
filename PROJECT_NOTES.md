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
