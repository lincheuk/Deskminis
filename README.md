# DeskMinis

Windows 桌面端的通用 Agent 应用。让模型在你自己的机器上读写文件、执行命令、完成任务——
会话、记忆、工作区都存在本机，设备之间走内网直连同步，**不经任何云端**。

用 Electron + TypeScript 从零实现，理念参考 [OpenMinis](https://github.com/openminis/openminis)
（只研读架构，未复用代码，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）。

---

## 现在能做什么

| 能力 | 状态 |
|---|---|
| Agent 循环 + 工具调用 | ✅ `shell_execute` / `file_read` / `file_write` / `file_edit` / `memory_get` / `memory_write` |
| 模型接入 | ✅ OpenAI 兼容端点 / Anthropic 原生 / Gemini 原生 / Ollama 本地 |
| 权限网关 | ✅ 三档（每次确认 / 本会话沿用 / 完全访问），工作区内文件直接放行 |
| 持久记忆 + 上下文压缩 | ✅ Markdown 记忆库、自动压缩与卸载 |
| 技能系统 | ✅ `SKILL.md` 生态兼容，设置里可启停/删除/导入 |
| 工作区 | ✅ 每会话绑定真实项目目录（原生选择器或粘贴路径） |
| 设备同步与接力 | ✅ 内网直连配对，会话与记忆双向同步，可暂停 |
| 内嵌终端 / 文件树 / 产物面板 | ✅ |
| 打包分发 | ✅ NSIS 安装包 + 便携版 + 自动更新 |
| **浏览器 / 屏幕** | ⛔ 未实现（界面已留位并明确标注，属独立里程碑） |
| **MCP** | ⛔ 未实现 |
| **模型组降级** | 🟡 后端已建成，尚无界面入口 |

> 诚实说明：这是个人项目，目前只在 Windows 上开发与验证过。

## 安装

到 [Releases](https://github.com/lincheuk/Deskminis/releases) 下载：

- `DeskMinis-<版本>-Setup.exe` — 安装版（推荐，支持自动更新）
- `DeskMinis-<版本>-win-x64-portable.exe` — 便携版

安装包未做代码签名，Windows SmartScreen 会提示「未知发布者」，选择「更多信息 → 仍要运行」。

首次启动后到 **设置 → 模型** 添加一个 provider（填 base URL / 模型 ID / API Key）即可开始。

## 从源码构建

```bash
cd deskminis && npm install
npm run dev          # 开发模式（自动起 minisd 与渲染进程）
npm test             # 1100 例
npm run typecheck
npm run dist         # 出安装包到 deskminis/dist/
```

## 数据存在哪

一切都在 `%APPDATA%\DeskMinis`：

```
minis.db          会话、消息、技能、审计、设置（SQLite）
sessions/<id>/    每会话的沙箱：workspace / attachments / offloads / browser
memory/           持久记忆（纯 Markdown，可直接编辑）
skills/           已安装技能
```

卸载不会删除它。想彻底清干净就手动删掉这个目录。

## 关于联网

除了你自己配置的模型 API，本应用**只有一处主动出网**：启动时向 GitHub 查一次版本号。
在 **设置 → 关于与更新** 里可以彻底关掉。设备之间的同步只走内网直连，不经任何服务器。

## 架构

```
渲染进程 (Vue 3)  ──WebSocket JSON-RPC + per-run token──▶  minisd (utilityProcess)
      │                                                        │
      └─ preload 白名单 IPC ─▶ 主进程 (窗口/托盘/对话框/更新)     ├─ Agent 循环 + Provider
                                                               ├─ 工具 + 权限网关
                                                               ├─ SQLite（迁移追加式）
                                                               └─ 同步引擎（mDNS + 直连）
```

后端逻辑全在独立的 `minisd` 进程里，渲染层只通过 JSON-RPC 说话——
这让后端可被 CLI、e2e 脚本、将来的手机端复用。

设计与实施记录在 [`docs/`](docs/)：`specs/` 是设计定稿，`plans/` 是逐里程碑的 TDD 计划，
`research/` 是 OpenMinis 研读报告。

## 许可

[Apache License 2.0](LICENSE)。第三方材料的署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
