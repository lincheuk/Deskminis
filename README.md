# DeskMinis

Windows 桌面端的通用 Agent 应用。让模型在你自己的机器上读写文件、执行命令、完成任务——
会话、记忆、工作区都存在本机；多台设备之间的会话同步走局域网直连，**不经任何云端**。

用 Electron + TypeScript 实现，产品理念参考 [OpenMinis](https://github.com/openminis/openminis)
（只研读了它的架构，没有用它的代码）。少量实现改编自 [pi-mono](https://github.com/badlogic/pi-mono)（MIT）
与 [ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）；界面令牌的槽位结构承自 Appica UI（MIT），
取值来自 [AionUi](https://github.com/iOfficeAI/AionUi)（Apache-2.0）。逐项登记在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## 现在能做什么

| 能力 | 状态 |
|---|---|
| Agent 循环 + 工具调用 | ✅ `shell_execute` / `file_read` / `file_write` / `file_edit` / `file_list` / `file_glob` / `file_grep` / `web_fetch` / `web_search` / `memory_get` / `memory_write`（Office 的两个见下）；`file_read` 可按 `offset` / `limit` 分段读大文件；输出被长度上限截断时自动续写（最多两次）；点停止即时中断正在跑的工具，shell 连同它起的子进程整棵回收；老程序吐的 GBK 乱码自动兜底解码 |
| 模型接入 | ✅ OpenAI 兼容端点 / Anthropic 原生 / Gemini 原生 / Ollama 本地；模型 ID 可从端点直接拉取成下拉，不必手输。思考过程：DeepSeek 这类经 OpenAI 兼容端点返回 `reasoning_content` 的推理模型，推理过程会显示；Anthropic 与 Gemini 的原生思考还没有档位入口，界面不请求；新一代 Claude（Fable 5.1 / Mythos 5.1 / Opus 5.5）总在思考，但服务端默认不返回思考文本，界面上看不到 |
| 图片输入 | ✅ 粘贴 / 拖拽 / ＋ 选择图片直接进模型，Anthropic、OpenAI 兼容、Gemini 三条链路各自映射（图片字节只在请求时合成，不写进会话库） |
| 权限网关 | ✅ 三档（每次确认 / 本会话沿用 / 完全访问），选择跨重启保留。前两档的后端判定相同，差别在权限卡默认高亮「允许」还是「本会话允许」（「本会话允许」只记原样重复的同一条命令、同一路径，MCP 按服务器记）；「完全访问」不再询问任何操作，但危险命令与文件工具写核心数据照样拦下（见下）。危险命令（Remove-Item / del、format C:、reg delete、shutdown、taskkill 这类）任何档位都直接拒绝，但只按命令写法认，经 `cmd /c` 转一手这类写法认不出。常见只读命令免询问，含 `git log \| select-object -first 20` 这类受限只读管道；工作区内（含绑定的项目目录）文件直接放行；写文件审批带 diff 预览；访问网络单列一档，默认每次确认。DeskMinis 自己的数据目录另有一道闸，**只管文件工具**（`file_*`、`office_*`）：会话库、模型与搜索服务配置、配对记录、本机连接凭据这些核心数据，文件工具写不了（完全访问也不行）；文件工具改 MCP 配置、技能与记忆文件，读会话库，碰别的会话，前两档下要过权限卡、卡上写明动的是什么，完全访问下照档位放行。**shell 命令与 MCP 工具不走这道闸**，照常按档位过卡：完全访问下 agent 用 shell 改写上面这些核心数据也不会被拦、不会被问；只读 shell 命令的文本里出现 DeskMinis、`$env:`、`%APPDATA%`、`%LOCALAPPDATA%` 时不再免询问、改按普通命令过卡，但用 `..\..\..` 这类相对路径（默认工作区就在数据目录里）或 `DeskMi*` 这类通配点到数据目录时认不出，照常免询问 |
| 会话 | ✅ 首回合后自动命名；会话行 ⋮ 菜单：重命名 / 删除（二次确认）/ 记忆开关 / 绑定模型；删除还在跑的会话会先让它停下再删（10 秒内停不下来就不删并报错）；可按标题搜索会话 |
| 助手体系 | ✅ 命名预设（名称 / emoji / 规则 / 默认模型）：欢迎页选中助手再输入即建绑定会话并注入规则；助手页可增删改；内置通用协作 / 代码助手 / 文档写手三个种子；可绑定默认技能（不勾即跟随全局启用集） |
| 定时任务 | ✅ 每 N 分钟 / 一次性 / cron 三种调度，可绑定助手，支持立即运行与结果回看，运行出错如实记为出错。关掉窗口后应用仍在托盘里运行，任务照常触发；从托盘退出或关机后就不再触发，错过的任务下次启动时只补跑一次（不逐次补）。无人值守时权限询问 90 秒自动拒绝 |
| 输入与导航 | ✅ ↑ 召回输入历史（草稿不抢）；@ 引用工作区文件路径；/ 技能菜单；产出物预览支持源码 / 渲染 / 分栏对照三态；右缘锚点轨一键跳回合（≥3 回合显示） |
| 选区注释 | ✅ 选中消息文本：一键引用到输入框追问，或加标注（高亮 + 笔记）持久保存，点高亮可查看 / 编辑 / 删除 |
| 持久记忆 + 上下文压缩 | ✅ Markdown 记忆库（按会话开关）、自动压缩与大结果卸载；单指令长任务也能压缩，陈旧的大工具结果自动修剪。0.3.0 的压缩是止血版：接着上一份摘要只压新增的部分，摘要为空或被截断就拒收，压缩失败会在对话流里提示、回合照常继续，不再静默；长会话的压缩质量留给 0.4.0 的引擎重写 |
| 技能系统 | ✅ `SKILL.md` 生态兼容，设置里可启停 / 删除 / 导入；技能包（zip）解压有上限：2000 个文件、总计 64MB、单个文件 32MB |
| Office 文档 | ✅ 读 / 生成 `.docx` / `.xlsx` / `.pptx`（零新依赖自建 OOXML）：agent 可用 `office_read` / `office_write`，预览区渲染**内容预览**——文字、表格、大纲、幻灯片文本都在，但字体、精确排版、图片位置、动画不还原，要看最终版式请用系统 Office 打开；旧版 `.doc/.xls/.ppt` 与 ODF 是另一套二进制格式，明确不支持 |
| 扩展市场 | ✅ 应用内浏览 / 搜索 / 一键安装技能与 MCP 服务器（ClawHub、官方 MCP Registry、awesome-dsh-plugin 三源）；装前确认卡展示来源、落盘清单或完整启动命令与上游安全裁定（恶意标记硬阻断）；已装项可检查更新，更新 MCP 服务器时保留你改过的启停、备注等设置 |
| MCP | ✅ stdio / streamable-http 双传输；设置页添加 / 编辑（可改名）/ 试连 / 启停 / 删除，改动即时生效（停用的当场拒绝调用，改过配置的下一回合按新配置重连）；配置文件读坏或在应用外被改过时，界面与市场都不会把它覆盖掉；工具以 `mcp__<服务器>__<工具>` 进会话，前两档下调用要过权限卡（选「本会话允许」后本会话同一服务器不再问），完全访问下不问；`npm run e2e:mcp` 全链路冒烟可回归；输入卡「MCP」胶囊可对单个会话禁用某台（下一回合生效） |
| 工作区 | ✅ 每会话绑定真实项目目录（原生选择器或粘贴路径） |
| 设备同步 | 🟡 局域网直连配对：一台生成配对码，另一台填它的 host:port 和配对码。配对后会话双向同步——同步的是消息、压缩摘要，以及标题、记忆开关、模型绑定、置顶这几项会话属性；记忆文件、附件文件与设置不同步。引擎缺省只监听本机（127.0.0.1），**跨机器使用要先在两台机器上都设环境变量 `MINISD_HOST=0.0.0.0` 再启动**，界面暂无开关；本机端口界面上也不显示，在数据目录的 `minisd-port.json` 里。设备页可暂停 / 恢复同步（不中断正在跑的任务，标题栏状态点变橙） |
| 内嵌终端 / 文件树 / 改动与任务面板 | ✅ 底部终端抽屉在本会话工作区里另起一个 PowerShell，与 agent 的 shell 不共享 cd 和环境变量；右栏三 tab：工作区文件树 / 本会话改动清单 / 任务面板（上下文水位 + 降级、压缩、卸载、待批准四态） |
| 打包分发 | ✅ NSIS 安装包（自动更新：从公开发布仓库 `lincheuk/deskminis-releases` 检查并后台下载，可在 设置 → 关于 关掉）+ 便携版（不自动更新）；安装目录附带本项目许可与第三方声明 |
| **浏览器 / 屏幕** | ⛔ 未实现（独立里程碑；界面上不留占位） |
| 模型组降级 | ✅ 设置 → 模型 → 模型组：把几个模型排成顺序，会话菜单与助手都能绑定到组；限流、密钥失效、请求被拒立刻换下一个，网络中断与服务端 5xx 先在原模型重试约一分钟再换；换成功后该会话改绑到接手的模型，胶囊与会话菜单同步显示。上下文超窗时只换到窗口更大的模型，没有更大的就提示「上下文已满」并给「新建会话接力」（预填接力草稿，由你过目后再发）；新一代 Claude 的思考块绑定报错不换模型 |

> 记号：✅ 可用；🟡 后端已建成，但缺界面入口或要手工设置（行内写明缺什么）；⛔ 未实现。
> 2026-08 那次界面推倒重做时漏接的入口，0.3.0 已成批补回；模型组降级（后端早就建成）也有了界面。

> 诚实说明：这是个人项目，只发 Windows（x64）安装包，也只在 Windows 上验证过。

每个版本改了什么见 [CHANGELOG.md](CHANGELOG.md)。

## 安装

到 [Releases](https://github.com/lincheuk/deskminis-releases/releases) 下载（这个公开仓库只放发布资产，源码仓目前不公开）：

- `DeskMinis-<版本>-Setup.exe` — 安装版（推荐）。启动后到上面这个发布仓库查一次新版，有就在后台下载，
  下载完提示你重启安装；不想自动检查就到 **设置 → 关于** 关掉。
- `DeskMinis-<版本>-win-x64-portable.exe` — 便携版，免安装，**不自动更新**，新版请回发布页下载。
  数据和安装版一样存在 `%APPDATA%\DeskMinis`：两者共用一份数据，不能同时运行。

**从 0.1.1 升级**：0.1.1 里写死的更新源是私有的源码仓，永远查不到新版——需要手动下载安装一次 0.3.0，之后才能自动更新。

安装包未做代码签名，Windows SmartScreen 会提示「未知发布者」，选择「更多信息 → 仍要运行」。

首次启动后到 **设置 → 模型** 添加一个 provider（起个名称、选类型，填 base URL / 模型 ID / API Key）即可开始。

## 从源码构建

源码仓目前不公开，下面写给有源码的开发者：

```bash
cd deskminis && npm ci
npm run dev              # 开发模式（自动起 minisd 与渲染进程）
npm test                 # Windows 上应全绿；Linux 上 PowerShell、终端、桥这类 Windows 专属用例会失败
npm run typecheck
npm run dist             # 出安装包到 deskminis/dist/
npm run verify:release   # 核对 dist/ 里要上传的四件（latest.yml、安装包、blockmap、便携版）与随包文件
```

发布一个新版本的完整流程（构建 → 验收 → 冒烟 → 上传 Release）见源码仓的 `docs/RELEASE.md`。

**开发态数据与正式版分开**：未打包运行（`npm run dev`）时，数据在 `%APPDATA%\DeskMinis-dev`，凭据在 Windows
凭据管理器的服务名 `DeskMinis-dev` 下，日志在 `%LOCALAPPDATA%\DeskMinis-dev\logs`，不碰装好的正式版。dev 首次启动是空库；
想把正式版的数据带进 dev：

1. 从托盘退出所有 DeskMinis，也停掉 `npm run dev`。
2. 把 `%APPDATA%\DeskMinis` 整个复制为 `%APPDATA%\DeskMinis-dev`（`minis.db` 连同 `-wal`、`-shm` 一起；原目录留给正式版，别移动）。
3. 在 dev 的设置里重填模型与搜索的 API key——key 存在凭据管理器里，复制目录带不过去。
4. dev 会生成新的配对身份，算另一台设备；要同步的设备在「设备」里重新配对。
5. 主题等界面偏好 dev 首次回到默认，重选一次即可。

如果正式版启动时提示「这份数据来自更新版本的 DeskMinis」，说明以前共用目录时 dev 已经把库升级了：把这个目录改名给 dev 用
（`DeskMinis-dev`），正式版装上最新版本再开。临时换一个数据目录：设 `DESKMINIS_DATA_DIR=<目录>`。

## 数据存在哪

安装版与便携版都在 `%APPDATA%\DeskMinis`：

```
minis.db              会话、消息、压缩摘要、助手、定时任务、注释、审计、设置等（SQLite）
sessions\<id>\        每会话的沙箱：workspace / attachments / offloads / browser
memory\               持久记忆（纯 Markdown，可直接编辑）
skills\               已安装技能
mcp-servers\          MCP 服务器配置（servers.json；其中的 env / headers 是明文，可能含密钥）
shared\               各会话共用的目录
其余几个 .json         模型与搜索服务配置（不含密钥）、模型目录缓存、本机引擎的端口与连接令牌（明文）、配对记录
minisd.lock           数据目录锁（运行时存在）
```

Electron 自己的缓存与界面偏好（包括自动更新开关 `update-prefs.json`）也在这个目录里。
模型与搜索服务的 API key、本机的设备身份与配对密钥不在这个目录里，存在 Windows 凭据管理器（服务名 `DeskMinis`）。
**但这个目录里仍有明文的敏感内容**：MCP 服务器的 env / headers（包括在扩展市场确认卡里填的密钥）原样写在
`mcp-servers\servers.json`；本机引擎的连接令牌（每次启动换新）写在 `minisd-port.json`；会话库与各会话目录里是全部对话内容
（含 agent 读到的文件内容与命令输出）。把这个目录打包发给别人、放进网盘或同步盘、做备份之前，先想到这些。
日志与崩溃记录在 `%LOCALAPPDATA%\DeskMinis\logs`。

删除会话会清掉它在库里的记录，但不删磁盘上的 `sessions\<id>\` 目录。
卸载不会删除上面这些。想彻底清干净：删掉 `%APPDATA%\DeskMinis` 与 `%LOCALAPPDATA%\DeskMinis`，
再到 Windows 凭据管理器里删掉名字带 `DeskMinis` 的条目。

## 关于联网

除了你自己配置的模型服务，DeskMinis 会在这些时候出网：

| 什么时候 | 连哪里 | 怎么关 |
|---|---|---|
| 启动时（模型目录缓存超过 24 小时才拉） | models.dev（失败时回退 basellm.github.io），取各模型的上下文窗口与输出上限 | 没有开关 |
| 安装版启动 8 秒后检查更新；有新版就在后台下载 | GitHub 上的公开发布仓库 `lincheuk/deskminis-releases` | **设置 → 关于** 关掉自动检查；便携版从不检查 |
| 你打开「扩展市场」、搜索、安装或检查更新时 | clawhub.ai、registry.modelcontextprotocol.io、awesome-dsh-plugin.com；装 awesome-dsh 的条目时经 api.github.com 拉仓库文件 | 不打开市场就不连 |
| agent 调用 `web_fetch` / `web_search` 时 | 目标网址；搜索走你在 **设置 → 网络搜索** 配的服务（Tavily、Brave 或自建的 SearXNG） | 默认每次过权限卡 |
| 你配置的 MCP 服务器 | 取决于服务器本身（streamable-http 的直接连它的地址） | **设置 → MCP** 里停用 |
| 设备同步 | 只在局域网里直连已配对的设备，不经任何服务器 | 设备页暂停同步；不设 `MINISD_HOST` 时引擎只监听本机 |

## 架构

```
渲染进程 (Vue 3)  ──WebSocket JSON-RPC + per-run token──▶  minisd (utilityProcess)
      │                                                        │
      └─ preload 白名单 IPC ─▶ 主进程 (窗口/托盘/对话框/更新)     ├─ Agent 循环 + Provider
                                                               ├─ 工具 + 权限网关
                                                               ├─ SQLite（迁移追加式）
                                                               └─ 同步引擎（手填 host:port 配对 + 直连）
```

后端逻辑全在独立的 `minisd` 进程里，渲染层只通过 JSON-RPC 说话——
这让后端可被 CLI、e2e 脚本、将来的手机端复用。

设计与实施记录在源码仓的 `docs/`：`specs/` 是设计定稿，`plans/` 是逐里程碑的 TDD 计划，
`research/` 是研读报告（OpenMinis 研读 8 份，另有 OpenCode 研读 5 份与插件市场调研 1 份）。

## 许可

[Apache License 2.0](LICENSE)。第三方材料的署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；
安装目录的 `resources\` 下附有这两份（`LICENSE.txt` 与 `THIRD-PARTY-NOTICES.md`）。
