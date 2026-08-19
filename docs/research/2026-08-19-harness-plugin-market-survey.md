# 七家 Harness 插件生态与开源插件市场调研（扩展市场立项输入）

> 调研日期：2026-08-19。目的：为 DeskMinis 的「插件市场」界面（接入开源插件市场与 MCP）提供设计输入。
> 方法：4 组并行实地抓取（GitHub 页面 / raw.githubusercontent.com 原始文件 / 线上 API 实测 / WebSearch 交叉验证），
> 全部结论以当日抓取为准，不依赖模型记忆。凡受网络代理封锁未能直接验证的点，正文中逐处标注。

---

## 0. 结论速览

1. **三个事实标准正在收敛，DeskMinis 已经站在其中两个上**：
   - **SKILL.md（agentskills.io）**：Anthropic 技能格式已开放标准化，46 个客户端采用（含 Hermes、OpenClaw、goose、Cursor、Copilot）。DeskMinis 的技能系统（设计 §5.1）就是这个格式，解析器「未知 frontmatter 键静默忽略」恰好是各家扩展（`metadata.hermes` / `metadata.openclaw`）的正确处理方式。
   - **`mcpServers` 配置 shape**：`{name:{command,args,env}|{type:"http"|"sse",url,headers}}` 被 Claude/Cursor/Windsurf/Gemini/OpenCode/oh-my-pi 共用。DeskMinis 设计 §5.2 的 servers.json 已经是这个格式，零改动对齐。
   - **marketplace.json（Claude Code 格式）**：oh-my-pi 明文兼容（直接读 `.claude-plugin/marketplace.json`），是「git 仓库即市场」的清单标准；最小公分母 `{name, owner{name}, plugins[{name, source}]}`。
2. **可直接消费的开放注册表有三个，且法律与技术门槛都为零**：MCP 官方注册表（REST API、无鉴权、CC0、约 1.9 万 server）、ClawHub（公开 REST API + OpenAPI + 安全扫描裁定接口，数万技能）、awesome-dsh-plugin 索引（静态 plugins.json、CC0、支持 ETag/304——用户截图那套 Plugin Market 的数据源就是它）。
3. **各家的「代码插件」互不兼容，不必也不应支持**：DSH 的 npm+Cordis 包、oh-my-pi 的 TS 模块、opencode 的 npm 插件、OpenClaw 的 plugin SDK 各说各话，没有一家能跑另一家的插件。DeskMinis 的「插件市场」应定位为**技能市场 + MCP 目录**——这两层才是跨家通用资产。
4. **安全教训现成且血淋淋**：ClawHub 上线不到三个月遭 ClawHavoc 供应链投毒（341→824 个恶意技能，投放 AMOS 窃密木马）。行业事后收敛出同构方案：装前扫描 + 恶意硬阻断 + 每日重扫 + 发布静默期 + 账号门槛 + 分层信任。DeskMinis 只做消费端即可避开大半风险，且「技能=提示词数据、执行走既有权限网关」的架构天然优于 OpenClaw 的「装了就以你的权限跑」。
5. **UI 模式有四个现成蓝本**（DSH dshmarket 内嵌市场 / goose 跳 Web 目录 + deeplink 回流 / OpenClaw Control UI 四标签枢纽 / Hermes dashboard 三视图），DeskMinis 适合内嵌市场路线，落在工作台标签（MU5 的 WbTab 数组模型直接承接）。

---

## 1. 七家档案

### 1.1 DeepSeek Harness（DSH）—— 用户截图那套界面的原产地

- **本体**：deepseek-ai/deepseek-harness，164k★，MIT，developer preview。口号 "Everything is a Plugin"，基于 vendor 进仓库的 **Cordis** 插件框架（论文《A Programming Paradigm for Spatiotemporal Composability》）：插件向共享 context 贡献 service/typed event/可逆 effect，「no privileged core to patch」，卸载即回卷。
- **插件形态**：npm 包，manifest 是 package.json 的 `dsh` 字段——`dsh.bundle`（声明为可安装 bundle，收录硬门槛）、`dsh.profile`、`dsh.client`（Web 客户端插件，只有它则不可安装）。代码三种写法（函数/对象/类），DI 依赖用 `export const inject = ['tools']` 声明。API 面覆盖 `ctx.sessions/tools/agents/llm` 与 `ctx.sandbox/approval/credentials` 等全部「能力接缝」。
- **安装**：底层 pnpm。`dsh plugin --profile <p> add <npm包|github:owner/repo|./tarball>`；git 直装拉的是源码，构建脚本须用户在 `pnpm-workspace.yaml` 手工 allowlist 并建议 pin commit。
- **发现**：`dsh-plugin` GitHub topic（7,849 个仓库，但已被蹭热度挂标污染——官方口号引来无关仓库打标）→ 社区因此转向人工 curated 清单。
- **截图里的 Plugin Market = 社区插件 `dshmarket`**（dsh-market/dsh-market，npm 5 天发 49 个版本）：
  - **数据源**：`https://awesome-dsh-plugin.com/plugins.json`（可经 `DSHM_REGISTRY_URL` 覆盖）；每次请求打源站、ETag/Last-Modified 协商 304、**不做本地小时级缓存也不回退快照**（作者注释："stale is not a degraded answer, it is a wrong one"）。「1283」就是当时线上索引 `count` 字段的实时值（时间线可对账：08-16 快照 839 → 08-18 用户所见 1283 → 08-19 清单仓库 1501 个条目文件）。
  - **Install 按钮**：同源 POST `/dsh-market/install` → 只允许装 curated 注册表内的源 → 优先 npm tarball（**npm 包与 GitHub 仓库双向核验防抢名**）→ spawn pnpm add → 构建脚本默认被 pnpm≥10 拦截、按包显式放行 → **装完验证有 dsh manifest 与可加载入口，坏包立即移除（防假成功）** → 热挂载。
  - **五个标签**：Discover（卡片=图标/名/作者/star/收录日期/双语描述/分类/Install/Source）、Installed、Themes（=注册表 `category: theme` 过滤 + 互斥激活热切换）、Backup & Restore（**只备配置不备 node_modules** 的 ProfileBackup JSON + WebDAV/Gist 同步，敏感路由仅 loopback）、Diagnostics（bundle 栈/重复加载/版本错配 + 依赖约束内拖拽加载顺序）。

### 1.2 awesome-dsh-plugin —— 「awesome 清单仓库即注册表」的完整范式

- 9.5k★，**CC0-1.0**。每插件一个 YAML（`data/plugins/<owner>__<repo>.yml`：url/name/category/description{en,zh}/可选 tarball），**YAML 是唯一事实源**，README 由脚本生成。20 个合法分类。
- **CI 管线**（nightly cron）：probe-stars（GitHub API 抓 star，覆盖率 <66% 拒绝写入）、probe-npm（npm↔repo 双向核验）、probe-downloads/readmes/tarballs、scan-decay（失修检测）→ `build-site.mjs` 产出 **plugins.json 主索引**（顶层 `{name,url,source,updated,count,categories,plugins[]}`，条目 `{name,owner,url,page,category,description{en,zh},npm,tarball,stars,downloads,install,added,screenshots}`）+ 每插件详情页 + feed.atom + count.json 徽章，发 GitHub Pages。
- **收录审核**：CI 只是前置（仓库≥1 天、≥10 commits、声明 `dsh.bundle`、非官方包套壳），**人工终审**核描述真实性（"Overstating is the one thing that gets an otherwise-good plugin sent back"）、纠分类、查可疑代码。免责声明明示清单不做安全审计。
- **对 DeskMinis 的意义**：这是「社区仓库 + CI 静态索引 + 应用内市场消费」的可照抄范式；DeskMinis 将来若要自建精选清单，整套管线设计（YAML 事实源、探针数据入库兜底、双向核验、失修扫描）可直接参考。

### 1.3 goose —— 「扩展即 MCP」+ 最完整的安装安全链路

- aaif-goose/goose（已入 Linux 基金会 Agentic AI Foundation），53k★。**extension ≡ MCP server**（内置扩展也经 MCP 协议暴露，`type: builtin`）。配置 `~/.config/goose/config.yaml` 顶层 `extensions:`（name/type=builtin|stdio|sse|streamable_http/cmd/args/envs/env_keys/timeout/uri/headers）。
- **目录**：文档站静态 `servers.json`（98 条人工策展，字段 `id/name/description/command/link/installation_notes/is_builtin/endorsed/environmentVariables[]/url/type`），可直接 raw 拉取；搜索纯客户端。桌面端**不内嵌市场**：设置页只有列表管理 + "Browse extensions" 跳浏览器，目录站 Install 按钮经 **`goose://extension?cmd=…&arg=…&env=NAME=描述`** deeplink 回流桌面（env/header 只传变量名，**真实值由桌面弹窗填写**，不进链接）。
- **安全链路（可照抄的蓝本）**：deeplink stdio 命令白名单仅 `cu/docker/jbang/npx/uvx/goose/npx.cmd`，显式拦截 `npx -c` 注入；安装确认三态模态（Blocked / "Install Untrusted Extension?" / Trusted 确认）；管理员 allowlist（`GOOSE_ALLOWLIST` 指向 YAML，按启动命令比对）；**OSV 恶意包检查**（npx/uvx 包装前查 OSV 数据库，命中阻断，服务不可用时放行）；工具执行四模式（Autonomous/Manual/Smart/Chat-only）+ 逐工具 Always/Ask/Never。

### 1.4 opencode —— 无机器可读市场（排除出数据源候选）

- anomalyco/opencode（自 sst 迁出）。插件 = JS/TS 模块（本地目录或 npm 包，`opencode.json` 的 `plugin` 数组声明，Bun 自动装），hooks API 完整（tool/permission.ask/chat.*/shell.env/experimental.*）。
- **市场**：只有文档站 ecosystem 页的人工清单（37 插件，PR 维护），分发走 npm，无索引无 API。MCP 配置在 `opencode.json` 的 `mcp` 键（type: local/remote），CLI `opencode mcp add` 向导，无浏览 UI。
- 值得借鉴的是其 **permission 配置语法**（`{"permission":{"*":"ask","bash":{"git diff":"allow","grep *":"allow"}}}` 按命令 glob 三态）与 agent/command 的 markdown 定义方式——与 DeskMinis 权限档位设计同路。

### 1.5 OpenClaw + ClawHub —— 真注册表 + 最重要的安全反面教材

- openclaw/openclaw，386.7k★，OpenClaw 基金会（2025-11 Clawdbot → 2026-01 Moltbot → OpenClaw，两次改名）。**skills（SKILL.md 超集）与 plugins（代码）分层**：skill 只强制 `name/description`，OpenClaw 扩展全部压在规范预留的 `metadata.openclaw` 键下（`requires.bins/env/config`、`os` 门控、斜杠命令派发等）；plugin 用根目录 `openclaw.plugin.json` manifest（**不执行代码即可校验配置**）+ TS plugin SDK。技能加载有明确优先级链（workspace → ~/.agents → managed → bundled → 插件附带），同名高优先级胜。
- **ClawHub**（openclaw/clawhub，开源可自托管，Convex + 向量搜索）：
  - **完整公开 REST API**：`clawhub.ai/api/v1/*`，OpenAPI 在 `/api/v1/openapi.json`，客户端经 `/.well-known/clawhub.json` 发现；免认证：search / skills（sort=trending 等）/ skills/{slug} / **skills/{slug}/scan（安全扫描结果）** / verify / download / packages / resolve（本地 hash→版本）；限流：匿名读 3000/min。第三方消费完全开放（Hermes 的 hub 就把它当最大上游）。
  - 发布：GitHub OAuth + 账号年龄门槛；强制 MIT-0；bundle ≤50MB；**新发布通过安全审查前不进安装面**。
- **ClawHavoc 事件（2026-02，Koi Security）**：全量审计 2,857 个技能发现 **341 个恶意**（335 个同一行动），伪装为加密钱包工具/YouTube 工具/auto-updater，以「假前置依赖」诱导安装 **Atomic Stealer（AMOS）** 窃密木马（窃取 Keychain、60+ 加密钱包、浏览器凭据）；注册表涨到 10,700+ 后恶意技能翻倍至 **824**。**根因：开放上传 + 无前置审核 + 技能可指示 agent 执行任意命令**。
- **官方应对（现已制度化）**：VirusTotal 合作（发布即扫 + Code Insight LLM 分析 + **全部在架技能每日重扫**，判恶意阻断下载）、下架 2,419 个可疑技能、三件套审计栈（SkillSpector/VirusTotal/ClawScan，裁定 Pass/Review/Warn/Malicious/Pending）、每技能公开安全审计页与 API、客户端 `skills verify` 验 trust envelope、风险安装需 `--acknowledge-clawhub-risk`。**密码学签名仍未落地**。
- Control UI 的 Plugins 枢纽四标签：Installed / Discover（内联查 ClawHub，带下载数 + 来源核验徽章）/ Skills（按 agent 启停 + API key 录入）/ Workshop（经验成技能的提案审阅）。

### 1.6 Hermes Agent —— 聚合器模式 + 装前扫描硬阻断

- NousResearch/hermes-agent，232.7k★。技能兼容 agentskills.io（扩展在 `metadata.hermes`：tags/category/requires_toolsets/fallback_for_toolsets/config）。**Skills Hub 是聚合器不是注册表**：聚合 11 个上游约 9 万技能（ClawHub 69,150、skills.sh 19,967、LobeHub、browse.sh、NVIDIA、官方 optional 115……），目录每日重建两次。安装标识多源：`official/…`、`skills-sh/…`、`clawhub/…`、`github owner/repo/path`、**`well-known:https://…/.well-known/skills/index.json`**（站点自述技能索引的约定）、直接 HTTPS URL。
- **安全**：hub 安装一律过 **Skills Guard 扫描**（检外传/prompt injection/破坏性命令/供应链信号），**`dangerous` 裁定硬阻断且 `--force` 不可越过**；`hermes skills audit` 全量重扫；agent 自写技能可配 `skills.write_approval` 进 pending 人工批。官方层（内置 81 + optional 115 + MCP catalog）全走 PR 人工审核（8 条硬标准）。
- **UI**：TUI `/skills browse` + 本地 Web Dashboard（Skills 三视图：Installed / Toolsets / **Hub Browser（跨源浏览 + 实时安装日志 + Update all）**；MCP 页：增删测试 + Nous 批准目录一键装、内联提示所需 API key）。
- MCP 配置 `~/.hermes/config.yaml` 的 `mcp_servers`（stdio/HTTP，OAuth 2.1、mTLS），工具前缀 `mcp_<server>_<tool>`。

### 1.7 oh-my-pi / 上游 pi —— Claude 市场格式的兼容方证据

- can1357/oh-my-pi（Mario Zechner 的 pi 的编码向 fork）。扩展 = TS 模块（工厂函数收 `ExtensionAPI`：registerTool/registerCommand/registerShortcut/事件族/TUI 渲染），四来源有序加载（`.omp/extensions` 目录 / hook / npm 包 `omp.extensions` 字段 / 配置列表）。
- **marketplace 与 Claude Code 同形**：清单在 `.omp-plugin/marketplace.json` **或 `.claude-plugin/marketplace.json`（两个路径都读，官方自称 "Claude Code-compatible"，示例直接挂 Anthropic schema URL）**；`/marketplace add owner/repo`、`/marketplace install name@marketplace`，装进 `~/.omp/plugins/cache` 并 symlink + lock 文件。npm source 暂拒装（"not yet supported"）。**无安装信任确认 UX**（文档明言插件进程内跑、无沙箱）——反面参考。
- **MCP 配置继承**：首启自动继承 `.claude/.cursor/.windsurf/.gemini/.codex/.cline/.vscode` 等 9 家的 MCP 配置，异构键名（TOML、`mcp.servers`）全部归一到 `mcpServers` shape，文档给出明确优先级序——这份路径表就是「`mcpServers` 是行业共识」的最好证据。
- 上游 pi：npm/git 包安装（`pi install npm:… / git:…`），无市场清单概念——市场层是 omp 加的。

### 1.8 LangGraph —— 不同赛道（判定依据）

langchain-ai/langgraph 是 agent 编排**库**：生态物是 pip 集成包（`libs/partners/`）、脚手架模板（`langgraph new`）、LangSmith Prompt Hub（社区 prompt 市场）。三者都不存在「宿主应用 + 第三方包边界 + 安装/启停/更新生命周期」命题，对本立项判定为不相关。可借鉴两点：`langgraph.json` 的声明式应用清单样式；Prompt Hub 对内容型条目的 fork/版本/试跑 UX。

---

## 2. 三个事实标准（DeskMinis 的对齐点）

### 2.1 SKILL.md → agentskills.io 开放标准

- Anthropic 原创格式已开放标准化：规范正典从 anthropics/skills 迁至 agentskills.io（原 spec 文件只剩重定向句）；Apache-2.0/CC-BY 4.0；46 个客户端进 showcase。
- frontmatter 规范字段：`name`（1–64，小写字母数字连字符，**须与父目录名一致**）、`description`（1–1024）必填；`license`/`compatibility`/`metadata`（字符串键值对，**各实现的扩展点**）/`allowed-tools`（experimental）可选。目录约定 `SKILL.md + scripts/ + references/ + assets/`。三段渐进披露（元数据 ~100 tokens → 正文 <5000 → 按需读文件）。
- **DeskMinis 对齐现状**：§5.1 实现即此格式；解析 `name/description/version` + 未知键静默忽略 = 正确消费 `metadata.hermes`/`metadata.openclaw` 扩展的方式。`<available_skills>` XML 注入 + 正文 file_read 触发 = 渐进披露同构。**差距**：各家 gating 字段（`requires.bins/env`、`os`）DeskMinis 忽略后技能可能缺运行时依赖——市场 UI 应把这些字段读出来展示（不阻断，提示用户）。

### 2.2 mcpServers 配置 shape 与工具命名

- `{"mcpServers":{name:{command,args,env} | {type:"http"|"sse",url,headers}}}` 为 Claude/Cursor/Windsurf/Gemini/OpenCode/omp 共识；DeskMinis §5.2 servers.json 即此。
- 工具命名 `mcp__<server>__<tool>` 为 Claude Code/Codex/DSH 共识（Hermes 用 `mcp_` 单下划线变体）。§5.2 落地时建议采用双下划线主流形。

### 2.3 marketplace.json（Claude Code 格式）

- 顶层 `{name, owner{name,email?,url?}, plugins[], metadata?{pluginRoot}, …}`；插件条目必填 `name+source`，source 七种（相对路径 / github{repo,ref,sha} / url / git-subdir / npm / archive / command）；插件包目录约定 `skills/<name>/SKILL.md`、`commands/*.md`、`agents/*.md`、`hooks/hooks.json`、`.mcp.json`，`.claude-plugin/plugin.json` 可选（唯一必填字段 `name`）。
- 「git 仓库即市场」：`/plugin marketplace add owner/repo` 即接入。安装确认 UX 展示 **Will install 组件清单 + Context cost + scope 选择**；社区市场条目全部 pin 到 commit SHA + 自动化安全筛查。
- **对 DeskMinis**：最小公分母（name/owner/plugins + 相对路径/github/url 三种 source）实现成本低；其技能子集可直接进现有 importer，commands/agents/hooks 不适用（DeskMinis 无对应机制）可显示为「不支持的组件」。适合作为 v2 的「添加自定义市场」通道（个人/团队自建市场场景）。

---

## 3. 可消费数据源对照

| 数据源 | 形态 | 鉴权/许可 | 规模（2026-08） | 增量机制 | 给 DeskMinis 的角色 |
|---|---|---|---|---|---|
| **MCP 官方注册表** registry.modelcontextprotocol.io | REST API v0.1（frozen），`GET /v0.1/servers`，server.json schema 2025-12-11 | 无鉴权，**CC0**，官方明文欢迎第三方 ETL | ~1.9 万 server | cursor 分页 + `updated_since` + `search` | **MCP 目录全量底座**（注意宽进审核，需自建过滤层） |
| **ClawHub** clawhub.ai/api/v1 | REST API + OpenAPI + `/.well-known/clawhub.json` 发现，向量搜索 | 免认证读 3000/min，技能强制 MIT-0 | 数万技能（口径 3k~69k 混乱） | sort=updated/trending，`/resolve` hash 对账 | **技能市场主源**（SKILL.md 直装 + `/scan` 安全裁定联动） |
| **awesome-dsh-plugin 索引** awesome-dsh-plugin.com/plugins.json | GitHub Pages 静态 JSON，ETag/304 | **CC0** | 1,501 条 | nightly 重建，整文件条件请求 | 范式参考（DSH 插件本体装不进 DeskMinis） |
| **goose servers.json** | 仓库内静态 JSON | 公开 | 98 条 | 无版本语义 | MCP **精选层**（endorsed 字段） |
| **skills.sh（Vercel）** | Hermes hub 上游 | 待验证（本次被代理封锁） | ~2 万技能 | 未查明 | 技能市场候补源（v2 再核） |
| Claude 系 marketplace.json 仓库 | git 仓库即市场 | 随仓库 | 分散 | git ref/SHA | v2「添加自定义市场」 |
| Smithery / PulseMCP | API 需 key（PulseMCP 子注册表 API 兼容官方规范 + 安全/热度富化） | API key | - | - | 可选富化层（涉及外发 key，默认不做） |
| GitHub topic 搜索 | Search API | 限流 | 噪声大（DSH topic 已被蹭标污染） | - | **不采用**（反面教材） |
| opencode | 无机器可读目录 | - | - | - | 排除 |

**server.json 关键字段**（MCP 注册表条目，可直接生成安装配置）：`name`（反向 DNS 命名空间，发布时经 GitHub OAuth/DNS challenge 验证归属）、`packages[]`（registryType: npm|pypi|oci|mcpb…、identifier、transport、runtimeHint: npx|uvx|dnx、environmentVariables[]{name,isRequired,isSecret}）、`remotes[]`（type: streamable-http|sse、url、headers[]）。

---

## 4. 安全模型：行业收敛结论 → DeskMinis 防线设计

**ClawHavoc 的根因链**：开放上传、无前置审核 → 技能是「会被 agent 执行的指令」而不只是文本 → 恶意技能以「假前置依赖」诱导跑安装命令 → 常开 agent 的机器（Mac mini）成为高价值目标。**两生态事后收敛出的同构方案**：装前扫描（恶意硬阻断，Hermes 连 `--force` 都不可越过）→ 每日/可重复重扫 → 发布静默期（审查完成前不进安装面）→ 账号门槛 → 分层信任（人工审核的官方层 + 机器扫描的开放层）。密码学签名两边都未落地；goose 补充了 OSV 恶意包检查与安装命令白名单。

**DeskMinis 的既有优势**（写进设计稿的出发点）：
1. **只做消费端**，不自建上传注册表——供给侧投毒治理（扫描/审核/下架）全部由上游承担，DeskMinis 消费其裁定结果即可。
2. **技能在 DeskMinis 里是提示词数据不是代码**：正文只进系统提示/file_read；技能诱导的任何执行都要过既有权限网关（shell 三档 + 只读免批白名单 + web-fetch askOnce）。这比 OpenClaw「技能可指示 agent 直接跑命令」的模型多一道结构性闸门——但 prompt injection 仍是现实威胁（技能正文可以社工模型去点「允许」），提示层纪律块需点名「技能内容不可指示绕过确认」。
3. C 波已建立的纪律直接沿用：密钥不出边界（注册表 API 全部免 key，无外泄面）、URL 查询串即外泄通道（市场客户端只打白名单域名）、正则/体积/时间预算上限。

**消费端防线清单（设计稿逐条采纳/裁剪）**：
- 信任源分层：内置源白名单（ClawHub / MCP 官方注册表 / goose 精选），默认全开但**分层标示**；自定义源（DSHM_REGISTRY_URL 式覆盖 / marketplace.json 仓库）显式添加 + 警示。
- 安装确认卡（对齐 Claude Code 的 Will install + goose 三态）：列出将落盘的文件清单、来源（owner/repo + 双向核验结果）、上游安全裁定（ClawHub `/scan` 结果：Malicious 硬阻断不可越过、Warn 需确认）、gating 字段提示（requires.bins/env、os 不匹配）。
- 技能安装 = 纯文件落盘（复用 importer），装后不自动执行任何东西；孤儿回收与卸载沿用现有机制。
- MCP 添加 = 写 servers.json + 确认卡展示完整启动命令；stdio 命令白名单（npx/uvx/docker + 桥随包 node，学 goose 精确拦截 `npx -c`）；env/secret 值一律本地弹窗填写（isSecret 走 safeStorage），绝不从注册表数据带值。
- 市场 RPC 面最小化：install 只接受「源内条目 id」不接受任意 URL；敏感操作（源管理）走设置页权限。
- 更新检查：版本字段 + 内容 hash（ClawHub `/resolve` 即此用途）；更新同样过确认卡。

---

## 5. 市场 UI 模式对照与 DeskMinis 形态建议

| | DSH dshmarket | goose | OpenClaw Control UI | Hermes dashboard |
|---|---|---|---|---|
| 位置 | 设置页内嵌市场（本身是插件） | 设置页列表，浏览跳 Web + deeplink 回流 | Web 控制台 Plugins 四标签枢纽 | 本地 Web，Skills 三视图 + MCP 页 |
| 发现 | Discover 卡片流 + 搜索 + 分类 chips | 目录站（站内搜索） | Discover + 内联 ClawHub 搜索 | Hub Browser 跨源浏览 |
| 卡片元素 | 图标/名/作者/star/收录日期/双语描述/分类/Install/Source | 名/描述/命令/env 声明/endorsed | 下载数 + 来源核验徽章 | 安装标识 + 实时安装日志 |
| 已装管理 | Installed 标签 + 启停/更新/分组/加载顺序 | 列表 toggle + 编辑模态 | Skills 按 agent 启停 + key 录入 | Installed 搜索 + 启停 + Update all |
| 特色 | Themes 互斥激活 / 配置备份 / Diagnostics | 安装安全三态模态 | Workshop 提案审阅 | MCP 目录一键装 |

**DeskMinis 形态建议**（供设计稿讨论，非定案）：
- **入口**：工作台新标签「扩展市场」（`WbTab` 数组模型直接挂新 panel；市场是大面积浏览界面，塞设置模态放不下）；已装技能管理保留在设置第 5 页（MU6），市场页提供跳转。
- **v1 两个 tab**：技能市场（源：ClawHub 主源 + 官方精选；搜索/分类/卡片：名/作者/star 或下载/描述/安全裁定徽章/Install）+ MCP 目录（源：官方注册表 + goose 精选层叠加 endorsed 标；卡片展示 transport 与所需 env，Install 生成 servers.json 条目 + 确认卡）。Installed 视图与 Diagnostics 可后置（诊断先复用 M6 可观测面）。
- **交互骨架照抄已验证模式**：卡片 → 详情（README 渲染，ClawHub 有 readme 负载）→ Install 确认卡（第 4 节防线）→ 装后 toast + 已装态。
- 后端新增「市场客户端」模块进 minisd（undici fetch + ETag 缓存进 SQLite 新表 + 预算上限），RPC 面 `market.sources.list / market.search / market.detail / market.install / market.check-updates` 量级。

---

## 6. 落地判断与决策点（待用户拍板）

**核心判断（建议采纳）**：
1. DeskMinis 的「插件市场」定位为**技能市场 + MCP 目录**，不做任何一家的「代码插件」运行时（互不兼容，且违背零新依赖/安全红线）。
2. **零新依赖可行性已核实**：undici（HTTP+ETag）、yauzl（zip）、better-sqlite3（索引缓存）、现有 skills importer（GitHub URL/ZIP 落盘）、§5.2 servers.json 设计——全部现成，市场是纯增量。
3. **实施顺序建议**：技能市场先行（importer 已就绪，不被 MCP 引擎阻塞，接 ClawHub 立刻获得数万条内容）→ MCP 最小面按 §5.2 实现（本就是下一波候选）→ MCP 目录 tab 随引擎落地。即「D 波=扩展市场设计稿+技能市场，E 波=MCP 引擎+MCP 目录」或合并为一波分步，设计稿里拆。

**需要拍板的决策点**：
| # | 决策 | 选项 |
|---|---|---|
| 1 | v1 范围 | A. 技能市场先行，MCP 目录随引擎（推荐）／B. 一波全做／C. 只做 MCP |
| 2 | 市场 UI 位置 | A. 工作台标签（推荐）／B. 设置页新页 |
| 3 | 技能主源 | A. ClawHub API（规模+安全裁定，推荐）／B. 自建精选清单起步（仿 awesome-dsh 管线）／C. 双轨 |
| 4 | marketplace.json 兼容（自定义市场） | v1 就做 ／ v2 再做（推荐） |
| 5 | stdio MCP 运行时策略 | 命令白名单集合怎么定（npx/uvx/docker/桥 node），无 node 环境的用户体验怎么兜 |
| 6 | agentskills.io showcase 上榜申请 | 对外动作，与代码无关，是否要做 |

**遗留核实项**（不阻塞设计稿）：skills.sh 的索引开放性（域名被本环境代理封锁）；ClawHub 当日权威总数；awesome-dsh-plugin.com 线上索引实抓（字段结构已经 build 脚本源码 + dshmarket 内快照双重证实）。

---

## 7. 来源索引（关键）

- DSH：github.com/deepseek-ai/deepseek-harness（docs/architecture.md、docs/user/develop/basic/*、packages/mcp/mcp-client/README.md）；dsh-market/dsh-market（src/registry.ts、install.ts、routes.ts、themes.ts、backup.ts）；awesome-dsh-plugin/awesome-dsh-plugin（contributing.md、scripts/build-site.mjs、data/plugins/*.yml）
- goose：github.com/aaif-goose/goose（documentation/docs/getting-started/using-extensions.md、guides/allowlist.md、guides/managing-tools/*、documentation/static/servers.json、ui/desktop/src/components/settings/extensions/*、ExtensionInstallModal.tsx）
- opencode：github.com/anomalyco/opencode（packages/web/src/content/docs/{plugins,mcp-servers,permissions,agents,commands,config,ecosystem}.mdx、packages/plugin/src/index.ts）
- MCP 注册表：registry.modelcontextprotocol.io/openapi.yaml（实测）、/v0.1/servers（实测）；github.com/modelcontextprotocol/registry（docs/reference/server-json/*、moderation-policy、registry-aggregators、terms-of-service、ecosystem-vision）
- agentskills.io：github.com/agentskills/agentskills（docs/specification.mdx、docs/snippets/clients.jsx）；github.com/anthropics/skills/spec/agent-skills-spec.md（重定向证据）
- Hermes：github.com/NousResearch/hermes-agent（website/docs/user-guide/features/{skills,mcp,web-dashboard}.md、user-guide/security.md、CONTRIBUTING.md）
- OpenClaw/ClawHub：github.com/openclaw/openclaw（docs/tools/{skills,creating-skills,mcp,skill-workshop}.md、docs/plugins/{manifest,sdk-overview}.md、docs/web/control-ui.md、docs/clawhub/cli.md）；github.com/openclaw/clawhub（docs/{http-api,skill-format,publishing,security-audits,moderation}.md）
- ClawHavoc：koi.ai/blog/clawhavoc-341-malicious-clawedbot-skills-found-by-the-bot-they-were-targeting、thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html、unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/、openclaw.ai/blog/virustotal-partnership
- oh-my-pi：github.com/can1357/oh-my-pi（docs/{extensions,extension-loading,marketplace,mcp-config,plugin-manager-installer-plumbing}.md）；上游 github.com/badlogic/pi-mono
- Claude Code 插件市场：code.claude.com/docs/en/{plugin-marketplaces,plugins-reference,discover-plugins}
- LangGraph：github.com/langchain-ai/langgraph（libs/cli）、github.com/langchain-ai/langchain（libs/partners）
