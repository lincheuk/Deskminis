# DeskMinis 设计文档

日期：2026-07-26
状态：已与用户逐节确认
参考实现：`../../OpenMinis/`（官方仓库克隆，GPLv3）
研究依据：`../research/readers-*.md`、`../research/followups-*.md`（对 OpenMinis 代码库的九份深读报告，含具体文件行号）

---

## 0. 一句话定位

Windows 桌面端（exe）AI Agent 应用：Minis 的理念（真电脑给 AI 用、技能、记忆、
工作区）+ Codex 的编码能力，多台电脑之间通过内网同步会话上下文、记忆、技能与
设置，同步协议与 OpenMinis 的 PortableRecord 格式兼容，为将来接入 fork 的手机端
预留互通能力。

**许可注意**：本项目借鉴 OpenMinis 的架构理念与数据格式（格式/协议不受版权保护），
不复制其 GPLv3 代码。若未来直接移植其代码片段，本项目须转为 GPLv3 开源。

---

## 1. 已确认的产品决策

| 议题 | 决定 |
|---|---|
| 项目名 | DeskMinis（暂定私用；公开发布前评估与官方品牌区分） |
| 产品形态 | 通用 Agent 桌面应用 + 强化编码能力 |
| 技术栈 | Electron + TypeScript；UI 用 Vue 3 + Pinia |
| 进程架构 | Electron UI + 独立 Agent 核心服务 minisd（JSON-RPC over localhost WebSocket） |
| 执行环境 | 双模式：默认宿主机直执行（权限网关兜底）+ 可选 WSL2 沙箱 |
| 模型接入 | 四轨：Anthropic 原生、OpenAI 兼容自定义端点、Gemini 原生、Ollama 本地 |
| 技能系统 | SKILL.md 生态兼容 + MCP 双轨 |
| 同步范围 | 会话上下文、持久记忆、工作区文件（按会话可选）、技能+设置（密钥默认不同步） |
| 同步拓扑 | 默认 P2P（mDNS + 直连），可配置常开中心节点（Hub = 永在线的普通对等节点） |
| 同步协议 | PortableRecord 兼容 + 修掉 OpenMinis 四个架构缺陷（见 §6） |
| 界面 | 三栏式工作台 |

---

## 2. 总体架构

```
┌────────────────────────── DeskMinis.exe (Electron) ──────────────────────────┐
│  ┌──────────────┐   localhost WebSocket   ┌─────────────────────────────┐    │
│  │ Electron UI  │◄──── JSON-RPC 2.0 ─────►│  minisd (Agent 核心服务)     │    │
│  │ Vue 3 三栏   │   chat.* provider.*     │  Electron utilityProcess     │    │
│  └──────────────┘   sync.* skill.* mcp.*  │  子进程；可 --headless 独立跑 │    │
│                                           │  ┌─────────┐ ┌────────────┐  │    │
│  其他客户端（将来）：deskminis-cli、        │  │Agent循环 │ │ 存储层      │  │    │
│  fork 的手机 App、别的电脑 ──────────────► │  │Provider  │ │ 同步引擎    │  │    │
│        mDNS + WebSocket（同步端口）        │  │工具+权限 │ │ SyncCore    │  │    │
│                                           │  └─────────┘ └────────────┘  │    │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **minisd 是产品本体**：Agent 循环、Provider、工具执行、存储、同步引擎全在其中。
  UI 崩溃不影响任务；`--headless` 模式可只做同步节点或被远程驱动。
- **控制协议**采用 OpenMinis debug-server 的 JSON-RPC 方法命名与语义
  （`OpenMinis/docs/specs/debug-server-api.md`）：`chat.prompt`（带 wait/waitTimeout）、
  `chat.sessions.list/get`、`chat.messages.list`、`chat.session.status/cancel/delete`、
  `provider.types / provider.instances.* / provider.models.* / provider.groups.*`、
  破坏性方法要求 `confirm:true`、凭据只写不读。DeskMinis 新增命名空间：
  `sync.*`（设备列表、配对、状态）、`skill.*`、`mcp.*`。
  loopback 免认证；LAN 连接要求配对 token（同款 constant-time 比较）。
- **模块划分**（各自可独立测试）：`provider` / `agent-loop` / `tools` / `store` /
  `sync` / `rpc` / `ui`。UI 无私有状态，一切经 RPC 订阅推送（多窗口/远程 UI 免费获得）。

---

## 3. 数据层

数据根目录 `%APPDATA%\DeskMinis\`：

```
minis.db                    会话/消息 SQLite
skills.db                   技能元数据 + session_skill_overrides + mcp_session_overrides
memory\                     GLOBAL.md / SOUL.md / YYYY-MM-DD.md
skills\<id>\SKILL.md        技能文件夹，原样存放永不改写
mcp-servers\servers.json    Claude Desktop 兼容格式
sessions\<sessionId>\       每会话桶：workspace\ attachments\ offloads\ browser\
shared\                     跨会话共享目录
mounts.json                 外部挂载 registry
sync\                       同步引擎状态（设备表、版本向量、密钥）
```

### 3.1 SQLite 结构（对齐 OpenMinis ChatStore / Room 双端一致的 schema）

- `sessions(id TEXT PK, title, model_id, category, model_binding, source, memory_enabled,
  pinned_at, created_at, updated_at, last_synced_at, remote_origin_device_id, ...)`
- `messages(id TEXT PK, session_id, role, parts_json, created_at, updated_at, token_usage,
  sort_order, reasoning_content, stream_interrupt_count, error_info, part_flags)`
  - 一行 = 一个回合；`error_info`、`part_flags` 为设备本地列，**不同步**
  - `sort_order` 同步时仅作 hint，接收端一律按 `(created_at ASC, id ASC)` 重排
- `compact_markers`：压缩摘要，锚定 last_compacted_message_id（消息 id 而非序号）
- 同步表：`sync_dirty_records(record_type, record_id, operation, priority, created_at)`、
  `sync_devices`、`deleted_record_tombstones`（30 天 TTL）、`change_log(device_id, seq,
  record_type, record_id, operation)`（DeskMinis 新增，见 §6.1）

### 3.2 ContentPart（消息体，与 iOS/Android 字节兼容）

`{"type":"text|mediaRef|toolUse|toolResult","value":...}` 标签联合：
- toolUse = `{toolUseId, name, input(JSON字符串), description, thoughtSignature?}`
- toolResult = `{toolUseId, output, success, mediaRef?, snapshot?, status}`
- mediaRef = `{id, relativePath, mimeType, originalFileName, linuxPath}`

### 3.3 路径契约

Agent 可见路径沿用 `/var/minis/*` 虚拟前缀与 `minis://` URL scheme：
- 每会话：`/var/minis/{workspace,attachments,offloads,browser}`
- 全局：`/var/minis/{memory,skills,shared,mcp-servers}`、`/var/minis/mounts/<name>`
- 宿主机直执行模式：工具层做前缀改写（file_* 工具翻译路径；shell 的 cwd 设为
  会话 workspace 实际路径，并注入 `MINIS_*` 环境变量指向各桶）
- WSL2 模式：真实 bind mount
- 收益：为手机写的技能/提示词在桌面原样可用

### 3.4 记忆

- `GLOBAL.md`（用户维护，agent 只读）+ `SOUL.md`（人设，YAML frontmatter + 正文
  ≤2000 token）+ `YYYY-MM-DD.md` 每日日志
- 条目格式 `<!-- YYYY-MM-DD HH:mm:ss -->\n{markdown}\n\n`，前插（最新在前）；
  时间戳注释同时是搜索分界、同步去重键、UI 撤销锚点
- 注入策略：每轮系统提示注入完整 GLOBAL.md + 最近 3 个非空日志（各 200 行内），
  措辞框定为"背景上下文而非常设指令，以用户最新消息为准"
- 工具：`memory_write` / `memory_get`（0.5×关键词命中率 + 0.5×新近度评分，
  上限 60 条/30KB）；会话级记忆开关关闭时工具整个从 schema 移除且不注入

### 3.5 外部挂载

`mounts.json`：`{id, name, path, isWritable(OS 探测), userAllowWrite(用户软锁)}`，
生效可写 = 两者与；聚焦时重探测。挂载暴露于 `/var/minis/mounts/<name>`。

---

## 4. Agent 核心

### 4.1 Provider 抽象（单方法契约）

```typescript
interface AgentProvider {
  streamAgentMessage(req: {
    messages: AgentMessage[]; systemPrompt?: string;
    tools: AgentToolDefinition[]; maxTokens: number; thinkingLevel: ThinkingLevel;
  }): AsyncIterable<AgentStreamEvent>;
}
```

统一事件：`contentBlockStart | textDelta | toolInputDelta(累积JSON) | toolCallComplete
| thinkingDelta | reasoningContent(回显用) | usage | done(stopReason: endTurn|toolUse|
maxTokens|refusal)`。`refusal` 独立于重试路径。

实现：
- **Anthropic**：4 断点 prompt caching（tools 末尾 + system + 最后两条用户消息，
  每轮命中前缀）、可选 1h TTL、thinking 两代参数（budget_tokens / output_config.effort，
  自适应模型 level=off 须显式关）、eager_input_streaming
- **OpenAI 兼容**：自定义 base URL；Chat Completions 为主，Responses API 备选
  （encrypted reasoning 仅存内存、按 (providerKind, modelId) 精确匹配才回放）；
  xAI/Kimi/OpenRouter/DeepSeek/Mistral/Azure 全走此路 + 兼容 flag
- **Gemini**：函数调用整体到达（合成 UUID id）、thoughtSignature 持久化于
  toolUse.thoughtSignature 并回放、无签名历史调用降级为文本摘要
- **Ollama**：走其 OpenAI 兼容端点
- 模型能力目录：models.dev API + 缓存 + 内置兜底；ThinkingLevel 按模型族钳制

### 4.2 循环

- 回合上限 200（defer 计数 + hitTurnLimit 旗标；压缩轮不占额度，每循环至多 3 次）
- 每轮顺序：修剪旧图片（保最近 20，被剪的替换为指向溢出文件的占位符，可 read_image
  取回）→ 大工具结果卸载（>20k 字符写 `offloads/`，历史替换为
  `[CONTEXT OFFLOADED] ... use file_read` 桩）→ 上下文水位检查（ContextPolicy 按模型
  窗口分层：<32K 不管；32-64K 卸载；64-128K 卸载+自动压缩；≥128K 更早触发）→
  流式请求 → 提交文本+tool_use → 无工具调用则收尾；有则并发执行（上限 10，
  原顺序回填）→ tool_result 作为 user 消息追加 → 单事务持久化 → 下一轮
- 压缩：LLM 摘要存 compact_markers，推理时合成（effectiveAgentHistory），不改写存储
  历史；保留最近 3 个用户回合原文；锚点丢失按 createdAt 自愈
- **三层错误处理**：连接期透明重试（≤2 次，仅首字节前，杜绝流中重复内容）→
  可见倒计时自动重试 [3,5,10,15,30]s → 模型组降级链（ModelGroup 用户自定义跨厂商
  备用链，降级原因展示，成功后改写会话绑定；HTTP-200 空响应换成员循环；
  tool_result 后空响应先注入一次 <system-reminder> 重试）
- 错误分类：isRetryable（网络/5xx/529，同模型重试）vs isFallbackable（限流/无效
  key/provider 错误，立刻降级）
- **历史自愈两处**：循环入口（丢弃中断的 assistant 尾、清孤儿 tool_result、给孤儿
  tool_use 注占位 result）+ Anthropic Provider 边界（配对/排序/同角色合并）
- 工具循环检测：未知工具连击 ≥10、30 次无进展全局熔断、轮询双阈值(10 警/20 断)、
  通用重复警告
- 流稳态：120s 停滞看门狗（stream.next 与 sleep 竞速）；UI 刷新按累积长度分层节流；
  重复 tool id 改名 `<id>-2`；部分 JSON 字节级提取预览
- 工具参数健壮性：preflight 用发布给模型的同一 schema 校验（无漂移）；修复三策略
  （截断补闭合、标量类型强转、Levenshtein≤1 字段名纠正）
- 中途用户输入：当前工具结束后打断，作为独立 user 回合注入（不并进 tool_result）

### 4.3 工具面（保持极小）

`shell_execute`、`file_read`、`file_write`、`file_edit`、`memory_write`、`memory_get`
（随记忆开关整体进出 schema）、`read_image`（仅具图像能力的模型）。
每个工具必带 `tool_title`（5-10 词用户语言摘要，驱动 UI 卡片）。
浏览器自动化第一版不做原生工具（预留 MCP 接入）。

shell：长驻 PowerShell（或 WSL bash）每会话一个 + 会话内互斥、跨会话并发
（Android ExecutionCoordinator 模式）；哨兵标记取退出码
`echo "__MINIS_DONE_{marker}_EXIT_$?__"`；死壳自动重建；env 快照差分含 unset；
输出经消毒 + 截断（单命令输出上限 100KB），>20k 字符的工具结果走上下文卸载（§4.2）。

### 4.4 windows-* CLI 桥

仿 apple-*/android-*：`windows-notify / windows-clipboard / windows-open /
windows-speak / windows-screenshot / windows-device ...`。实现为薄 stub exe，经
命名管道 RPC 进 minisd（借鉴 Android 的 NOFF/NOFR 长度前缀帧协议），会话 id 经
`MINIS_CHAT_SESSION_ID` 环境变量传递用于权限定域。统一 JSON 信封
`{ok, tool, action, data|error{code,message}, timestamp}`，`--compact`/`-q` 旗标，
退出码 0/1/2/3/4。系统提示一段话声明 + `--help` 按需详读（渐进披露）。

### 4.5 权限网关（宿主机直执行的安全命门）

- 每命令/每能力三级 `bypass / askOnce / notAllowed`，持久化；askOnce 弹 UI 确认
  （CheckedContinuation 式挂起，30s 超时即拒绝），授权按会话记忆
- shell 命令危险度分类：读类（dir/type/git status…）直行；写文件/装包/网络出站
  提示一次；删除/格式化/注册表/服务操作默认拦截
- 拒绝以 tool_result 错误返回并带 `minis://settings/permissions` 深链
- WSL2 沙箱模式放宽（隔离由沙箱承担）
- windows-* 桥中隐私敏感项（剪贴板、截图）默认 askOnce

---

## 5. 技能 + MCP

### 5.1 技能

- SKILL.md 原样落盘永不改写；元数据仅解析 `name/description/version`，未知 frontmatter
  键静默忽略（= Claude/Codex 兼容机制）；解析器容错：headless frontmatter、YAML 块
  标量含 chomping 变体、中途保存损坏时保留旧元数据、URL 兜底命名、slugify 稳定 id
- skills.db：`skills(id, name, description, version, import_source, is_enabled,
  installed_at, updated_at, use_count)` + `session_skill_overrides`
- 系统提示注入 `<available_skills>` XML（名 + ≤200 字描述 + 绝对路径），>20 个时
  分级披露（内置 > 7 天内更新 ≤10 > use_count 归一化），溢出列名并提示可 ls/grep；
  正文永不预载，模型 file_read 触发；拦截 `<skillsRoot>/<id>/SKILL.md` 读取计
  use_count（>1000 时全体归一化到 0-100）
- 导入：GitHub URL（Contents API 同级文件递归、部分成功报告、脱离 UI 生命周期）、
  ZIP（容忍一层包装目录）、本地文件夹、agent 直写目录的孤儿回收
- `/名字` 斜杠菜单 = 纯输入辅助（填 `/name` 进输入框，加载仍走模型侧）

### 5.2 MCP

- `servers.json` Claude Desktop 兼容：`{"mcpServers":{name:{url/headers |
  command/args/env, note, enabled, startupTimeoutSeconds, oauth, createdAt,
  updatedAt}}}`；三变体宽容导入（mcpServers 包裹/名字键控/单裸条目/disabled:true）；
  逐条解码容错；原子写（temp+rename）
- **提示词描述 + CLI 调用**路线：系统提示只披露 Top-20 服务器的名字+备注（≤200 字），
  模型用 `minis-mcp-cli tools <server>` 发现、`call <server> <tool>` 调用
- 连接池在 minisd 进程内：每服务器 10 分钟空闲 TTL、崩溃/超时单次驱逐重建、
  空池 60s 自退；CLI 是命名管道薄客户端（不用原版 os.fork daemon）
- 传输：stdio（子进程 + 换行 JSON-RPC）与 Streamable HTTP（POST per RPC，
  application/json 或 SSE 响应体取末条 data:，回显 Mcp-Session-Id）
- 凭据：`$$VAR` 环境变量间接引用 + shell 输出脱敏 pass；OAuth = PKCE S256 +
  loopback 54546 回调 + RFC 8707 resource + 提前 60s/401 刷新；token 存
  Electron safeStorage（Windows 凭据库）
- 修掉原版两个坑：oauth 键统一 camelCase、读取兼容 snake_case；会话级禁用在
  **调用层硬执行**（原版仅提示词层，模型猜名仍可调）
- 保守默认：`minis-mcp-cli add`（模型自改配置）默认关闭，设置里可开

---

## 6. 同步引擎

### 6.1 分层与协议

```
store.markDirty → sync_dirty_records(SQLite, 崩溃安全)
              → SyncCore(传输无关：防抖、批次、合并、回声抑制)
                  ├─ LANTransport  (mDNS "_minis-sync._tcp" + WebSocket)
                  └─ HubTransport  (可选；Hub = 永在线普通对等节点，同一协议)
```

- **PortableRecord 与 OpenMinis 逐字段兼容**：`{id:"Type:id", fields:{key:{t,v}}
  (t∈null|string|int|double|bool|date|data|json), assets, schemaVersion,
  minimumCompatibleVersion(高于本地版本则拒绝应用), unknownFields(写回时透传，
  旧客户端永不剥掉新客户端字段), updatedAt}`
- 记录类型对齐：SessionV2 / MessageV2 / CompactMarkerV2 / SessionFileV2 / SkillV2 /
  SoulV2 / MemoryGlobalV2 / MemoryDailyV2 / ProviderInstanceV3(+ModelEntry/Group) /
  EnvVarItem / MCPServerItem / SyncDeviceV2
- 线协议：WebSocket 长连推送 JSON 批次 `{records, deletes}`；文件资产走同连接
  长度前缀二进制帧；删除 = 墓碑记录广播 + 本地墓碑表(30 天)防复活
- **类型元数据单一注册表**：每类型一处声明 `{冲突策略, 作用域, 传输白名单,
  schemaVersion}`——修掉原版"注册表/脏队列白名单/zone 映射三处注册漏一处即静默
  丢失"的事故模式

### 6.2 对等历史回填（修 OpenMinis 缺陷 #1）

- 每设备单调递增 seq，`change_log(device_id, seq, ...)` 记每次变更
- 握手交换版本向量 `{deviceId: maxSeenSeq}`，差量由对方从 SQLite 应答
- 任一电脑可为新设备/断线设备全量补历史；LAN 传输具备 deltaFetch 能力
  （原版 LAN 只有 pushObserve，迟加入者永远缺历史、被迫依赖 iCloud）

### 6.3 配对与加密（修缺陷 #2/#3）

- 首次配对：6 位数字码双端确认 + X25519 交换会话密钥（借鉴其 debug-server
  DebugAuth v1 已验证方案）
- 之后所有 LAN 流量：HMAC-SHA256 加密信封、encrypt-then-MAC、随机 nonce +
  重放 LRU、±120s 时间窗、响应方向独立密钥、30 天闲置过期
- 未配对设备 mDNS 可见但不可读
- **密钥类型默认不同步**（ProviderInstance.secretBlob、EnvVarItem 值）；用户显式
  开启后仅走已配对加密通道，落盘进 Windows 凭据库；传输白名单在类型注册表声明
  （原版无差别广播给所有传输层）

### 6.4 冲突策略（每类型注册时声明）

| 类型 | 策略 |
|---|---|
| Session / Message | LWW by updatedAt（append-only，冲突罕见）；流式进行中延迟合并 |
| CompactMarker / SyncDevice | alwaysAccept |
| MemoryDaily | 按时间戳**集合并集**（多设备条目累积） |
| GLOBAL.md / SOUL.md | 单例整文件 LWW by mtime，应用后回写 mtime |
| 配置类（Provider/EnvVar/MCP） | **逐条记录** LWW（吸取整文件 LWW 丢并发新增的教训） |
| 工作区文件 | LWW + 输家存 `名字.conflicted-<设备名>.ext` 冲突副本 |

回声抑制：推送前 30s TTL 戳记 + 应答时二次戳记，入站过滤自己的回声。

### 6.5 工作区文件同步（修缺陷 #4，五个修补）

按会话可选开启。记录 = `{sessionId:relativePath}` 复合键 + 文件字节资产。
1. 应用远端文件后**回写 mtime 至记录 updatedAt** + 自写抑制集合（桌面 FS watcher
   会看到同步引擎自己的写，不修必死循环——iOS 靠 fakefs 只见客体写侥幸躲过）
2. 入站删除**真正 unlink**（原版注册了 no-op，A 删的文件在 B 上永存）
3. 重命名成对处理（delete+upsert 原子应用）
4. **SHA-256 内容哈希**跳过未变更文件（原版每轮全量重传所有文件）
5. 并发编辑冲突副本（不静默毁掉输家内容）

监视：chokidar per-path LWW 合并 → mtime 追平过滤（open 不写不触发）→ 30s 衰减；
垃圾目录排除表（node_modules/.git/__pycache__/…，watcher 与扫描两路都挂）；
单文件大小上限默认 1MB 可调；Agent 回合结束统一 flush。

### 6.6 节流

3s 防抖合并发送；Agent 流式期间暂缓（脏行照记，回合末 flush）；退避基准 5s ×
前台/后台系数；用户可暂停至指定时刻。

---

## 7. UI（三栏工作台）

- **左栏**：工作区/会话列表（置顶/分类/来源设备标记，远端会话可续聊或 fork——
  fork 深拷贝并重映射消息 id 与压缩标记引用）；底部设备面板（对等设备、在线状态、
  同步进度、配对入口）
- **中栏**：对话流。工具调用 = 可折叠卡片（标题 tool_title，展开看参数/输出）；
  file_edit 内嵌 diff；shell 输出 ANSI 渲染；权限确认内联卡片（批准/仅此次/拒绝）；
  minis:// 链接 = 文件芯片点击右栏打开；输入框支持 /技能、@文件、拖拽附件、
  模型与 thinking 切换；降级/重试原因以信息块展示
- **右栏**（可收起，标签页）：终端（xterm.js 实况）、文件（工作区+挂载树）、
  任务（回合进度、token 用量、上下文水位条）
- 明暗主题；系统托盘常驻（关窗不杀 minisd）
- 实现：Vue 3 + Pinia；所有状态经 JSON-RPC 订阅 minisd 推送，UI 无私有状态

---

## 8. 错误处理与测试

- **provider**：录制 SSE 流回放单测（事件归一化、断流、部分 JSON、重复 tool id）
- **agent-loop**：假 Provider 测重试梯/降级链/历史自愈/熔断/压缩触发
- **sync**（重点）：双/三节点内存传输仿真——版本向量收敛、并发编辑冲突副本、
  迟加入回填、墓碑防复活、回声抑制、密钥白名单不外泄
- **tools/权限**：分级、超时拒绝、路径改写正确性
- 端到端：Playwright 驱动 Electron 主链路；同机双实例（不同端口/数据目录）跑
  真实 mDNS 配对与同步
- minisd 的 JSON-RPC 面即 debug-server 协议，脚本可直接 `chat.prompt`+wait 回归

---

## 9. 里程碑

| 期 | 内容 | 验收 |
|---|---|---|
| **M1 骨架** | minisd + JSON-RPC + SQLite 存储 + Anthropic/OpenAI 兼容 Provider + 最小循环 + shell/file 工具 + 权限网关 + 最小聊天 UI | 单机能当 Codex 用：对话中改文件、跑命令 |
| **M2 补全** | Gemini/Ollama、模型组降级、压缩/卸载、记忆、技能、windows-* 桥、三栏完整 UI | MinisSkills 技能跑通；记忆跨会话生效 |
| **M3 同步** | SyncCore + 脏队列 + LAN 传输 + 配对加密 + 版本向量回填 + 会话/记忆/技能/设置同步 | 两台电脑无缝续聊；断线重连自动追平 |
| **M4 收尾** | 工作区文件同步（五修补）+ Hub 模式 + WSL2 沙箱 + MCP OAuth + 打包签名 exe | 完整产品，一键安装 |

依赖关系：M1→M2→M3→M4 串行；M2 内部记忆/技能/桥三块可并行；M4 内部四块可并行。

---

## 10. 明确不做（第一版）

- 手机端 fork 与接入（协议已备好，另立项目）
- 浏览器自动化原生工具（走 MCP）
- 向量检索/embedding 记忆（词法评分够用，格式不变将来可加）
- 云端中转同步（Hub 已覆盖"总有一台在线"场景）
- 多用户/团队协作
