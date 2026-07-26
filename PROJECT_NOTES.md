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

## 进行中

- 深度阅读 OpenMinis 代码库（会话存储、记忆/工作区格式、技能加载、
  Agent 循环/Provider 抽象、沙箱与 debug-server 协议），为设计文档提供依据
- 之后：提出 2-3 个整体架构方案 → 分节确认设计 → 设计文档写入本目录
  `docs/specs/` → 实施计划 → 开发

## 待设计细节

- 记忆系统与会话的数据结构（需为可同步、可合并的文件格式）
- 内网同步协议细节（配对/认证、传输加密、冲突处理策略）
- Electron 进程架构（UI 与 Agent 核心/同步引擎的进程划分）
