# DeskMinis MCP 最小面设计（定稿）

> 日期：2026-08-19。状态：**已落地**——同日用户确认 §9 决策点 ①–⑦ 全按建议采纳后定稿；
> D1 web_search（399759a）→ D2 配置层 → D3 stdio → D4 http → D5 注册/调用/权限 →
> D6 设置页 → D7 e2e 冒烟（6adb4bf，npm run e2e:mcp 六案全链路），七步全过审，D 波收官
> 于 2026-08-20。市场（G 波）装出的 MCP 条目走本引擎同一链路，装→用闭环已经云端实证。
> 执行期偏离与审核记录见 PROJECT_NOTES D 波各步。
> 定稿时补一处 §2 宽容细化：servers.json **整文件** JSON 损坏时按空配置加载并在 store 暴露
> `loadError`（手编 JSON 的笔误不该崩 minisd 启动），与「坏条目跳过」同一宽容原则。
> 输入：设计总稿 §5.2（docs/specs/2026-07-26-deskminis-design.md）+ 调研报告
> （docs/research/2026-08-19-harness-plugin-market-survey.md，尤其 §2 mcpServers shape 与
> mcp__ 命名共识、§3 官方注册表、§4 消费端防线）。
> 本波只做**引擎**，不做市场 MCP tab（市场波再接，本稿在接缝处留口）。

## 1. 范围（最小面裁剪）

| 做（本波） | 不做（后置，归属） |
|---|---|
| servers.json 读写 + 三变体宽容导入 + 原子写（§5.2 原样） | OAuth/PKCE 全套（§5.2 后半，后续波） |
| stdio + streamable-http 双传输 | SSE 独立旧传输（streamable-http 内的 SSE 响应体已覆盖，§5.2 原文即此） |
| 连接生命周期：首 run 连接、空闲 TTL 驱逐、崩溃单次重建 | CLI 调用路线 + 命名管道池（minis-mcp-cli，规模化优化，后续波） |
| 工具发现 + **直注册**（mcp__server__tool） | `minis-mcp-cli add`（模型自改配置，§5.2 本就默认关闭） |
| 调用透传：超时、取消（A 波取消语义延续） | MCP resources / prompts / sampling / elicitation / roots（只做 tools） |
| 权限门（新 kind=mcp）+ 审计落库沿用 M6 | 市场 MCP tab、注册表客户端（市场波） |
| 设置页「MCP 服务器」管理分区 + 源码守卫 | 会话级禁用的 UI（数据结构与调用层硬执行本波做，UI 后置） |
| $$VAR 环境变量间接引用 + 日志脱敏 | headers 的 safeStorage 加密存储（见决策点②） |
| 错误分类文案 + 对话流事件提示 | diagnostics.dryRun 增 MCP 段（可观测后续补） |

**决策点①（对 §5.2 的一处修订）**：§5.2 原定「提示词描述 + CLI 调用」路线（系统提示只披露
Top-20 名字，模型经 minis-mcp-cli 发现与调用）。本稿建议第一波改走**工具直注册**：
每个 MCP 工具注册为原生工具，命名 `mcp__<server>__<tool>`。理由：(a) 复用现成审批卡/
工具事件流/三 provider schema 映射管线，零新 UI；(b) 不依赖 shell 工具可用性；(c) 业界同形
（Claude Code/Codex/DSH 同名法，调研 §2.2），权限粒度更细。CLI 路线作为「服务器很多时」的
规模化优化保留在总稿，不删。

## 2. 配置与存储

- 文件：`<数据根>/mcp-servers/servers.json`，Claude Desktop 兼容（§5.2 原样）：
  `{"mcpServers":{name:{command,args,env,cwd? | url,headers?, type?, note?, enabled,
  startupTimeoutSeconds?, createdAt, updatedAt}}}`。三变体宽容导入（mcpServers 包裹/名字键控/
  单裸条目/disabled:true）；逐条解码容错（坏条目跳过并事件提示，不拖垮整文件）；
  原子写 temp+rename。`oauth` 等未知字段**读写往返保留不丢弃**（与生态互导不丢数据），本波不消费。
- 判型：有 `command` → stdio；有 `url` → streamable-http。`type` 字段宽容接受
  `http`/`streamable-http`/`streamable_http`/`sse`（sse 也按 streamable-http 处理，POST 响应体
  SSE 分支已覆盖其主流用法）。
- `$$VAR`：`env` 与 `headers` 的值支持 `$$NAME` 间接引用宿主环境变量（§5.2 原样）；
  解析仅发生在 minisd 发起连接/请求的瞬间；日志与错误文案只出现 `$$NAME` 引用名，绝不出现解析值。

**决策点②**：headers/env 中的 token 允许明文落 servers.json（Claude Desktop 同款行为，
保证互导兼容），设置 UI 文案引导用 `$$VAR` 引用环境变量；safeStorage 加密后置。
替代方案是本波就上 safeStorage（代价：servers.json 不再可直接互导）。**建议采纳明文 + $$VAR 引导**。

## 3. 传输层

- **stdio**：`spawn(command, args, { shell: false })` + 换行分隔 JSON-RPC；Windows 解析兜底：
  command 无路径分隔且 ENOENT 时自动补试 `<command>.cmd`（npx/uvx 场景，goose 白名单同时含
  npx 与 npx.cmd 即此坑的印证）；`initialize` 握手（protocolVersion 2025-06-18，服务器回落版本
  宽容接受；clientInfo=deskminis）；启动超时 `startupTimeoutSeconds` 默认 30s；stderr 采集进
  日志（限量），不并入协议流。
- **streamable-http**：POST per JSON-RPC（undici，fetchImpl 可注入以便测试）；
  `Accept: application/json, text/event-stream`；`application/json` 直取；SSE 响应体取末条
  `data:`（§5.2 原样）；回显 `Mcp-Session-Id`；GET 通知长流本波不开（无订阅需求）。
- **生命周期**：run 启动时并行连接「enabled 且未连」的 server（每台各自受启动超时约束，
  失败者本 run 缺席 + 对话流事件提示，不阻塞 run）；run 间保持连接，空闲 10 分钟 TTL 驱逐
  （minisd 进程内定时器，无独立池进程）；调用崩溃/超时 → 单次驱逐重建（§5.2 原样）；
  minisd 退出统一 dispose（stdio 子进程树杀干净，沿用 shell 工具的进程清理经验）。
- **取消**：用户中断 run → 对进行中的 MCP 调用发 `notifications/cancelled` 并本地立即返回
  取消结果（不等服务器），与 A 波「取消透传工具层」语义一致。

## 4. 工具发现与注册

- 发现：连接成功后 `tools/list`；结果缓存于连接；收到 `notifications/tools/list_changed`
  则失效缓存、下个 run 重新 list。
- 命名：`mcp__<server>__<tool>`；规范化：非 `[a-zA-Z0-9_-]` 替换为 `_`；总长 >64 时截断 +
  12 位确定性哈希尾缀防碰撞（DSH 方案，调研 §1.1）；server 名规范化后撞名 → 后加载者整台
  拒载 + 事件提示。
- schema：MCP `inputSchema`（JSON Schema）进现有三 provider 工具映射管线；gemini 不支持的
  关键字保守剥离（沿用 C6 三家各自映射的处理路数）。
- 结果映射：`content[]` 中 `text` 拼接为工具结果；`image` 等非文本项本波降级为
  `[非文本内容：<type>，暂不支持]` 占位（与 C6 图片链路的对接留到后续）；`isError: true` →
  按工具错误呈现。
- **上限**：每 server 工具数上限 40（超出按返回顺序截断 + 事件提示「N 个工具被截断」），
  MCP 工具总上限 120。**决策点③**：上限取值（40/120 为建议值，可调）。
- 展示：工具行/审批卡 tool_title 为「MCP·<server>·<tool>」（中文前缀纪律沿用 C7）；
  description 透传原文。
- **会话级禁用**：会话 overrides 里禁用的 server：其工具不进该会话工具表，且调用层硬拒
  （双保险，§5.2 修坑点原样——「原版仅提示词层，模型猜名仍可调」）。本波做数据结构 +
  RPC + 调用层硬执行；设置 UI 后置（决策点⑤）。

## 5. 权限

- 新权限 kind：`mcp`，detail = server 名（server 粒度）。默认档 **askOnce per server**：
  首次调用弹卡（展示 server 名、工具名、入参预览——惰性构造，审计只记 hasPreview 布尔，
  A 波模式），允许后同 server 本会话免弹；deny 拒绝且不发请求；「完全访问」档全放。
- **决策点④**：粒度与档位。备选：每工具每次 ask（最保守，但 MCP 工具通常连环调用，
  弹卡会非常频繁）。**建议 askOnce（server 粒度）**——与 bridge-* 类目的 bridgeTriggers
  放行模式同构，理由：用户添加 server 时已过一道「装什么」的决策，运行期把关到
  「这个 server 本会话可不可以用」即可。
- 审计：permission.request/resolved 落库沿用 M6；调用本身进现有 tool 事件流。

## 6. 设置 UI 与 RPC

- 设置新页「MCP 服务器」（技能页同级）：列表（名/类型/连接状态点/enabled toggle/删除）+
  添加/编辑表单：名称、类型切换（stdio|http）、stdio 侧 command + args（逐行）+ env 键值对、
  http 侧 url + headers 键值对、note、高级项 startupTimeoutSeconds；env/headers 值输入框旁
  提示「敏感值建议填 $$环境变量名」。「测试连接」按钮 → `mcp.servers.test`（连接 + initialize +
  返回工具数与耗时），结果内联展示。
- renderer 源码守卫：tests/renderer-mcp-settings.test.ts（断言页标题、类型切换分支控件、
  $$VAR 提示文案、测试连接按钮锚点）。
- RPC 面：`mcp.servers.list / upsert / remove / toggle / test`。list 返回给渲染端时
  headers/env 的值原样返回（决策点②采纳明文即无额外脱敏面；若②改 safeStorage 则此处改掩码）。

## 7. 可观测与错误文案

- 对话流事件提示（EventNote 样式）：server 连接失败/超时/进程退出/工具截断。
- 错误分类：ENOENT →「命令不存在：<command>。请确认已安装对应运行时（如 Node/Python）
  或改用绝对路径」；启动超时；协议错误（initialize 失败）；HTTP 401/403 →「认证失败或无权限
  （HTTP xxx），请检查 headers 配置」（401 优先细分，C7 模式）；5xx；连接被拒。
- 日志脱敏：headers/env 解析值不进日志（$$VAR 名可见）；stderr 限量采集。

## 8. 测试与验收

- 单测（预估 60–80 例）：
  - tests/mcp-config.test.ts：三变体导入/坏条目跳过/未知字段往返/原子写/判型宽容。
  - tests/mcp-client.test.ts：stdio 握手/换行分帧/工具列表/调用/取消透传/启动超时/崩溃重建/
    `.cmd` 兜底/dispose 清理。fixture 用 node 脚本 mock MCP server（零依赖）。
  - tests/mcp-http.test.ts：fetchImpl 注入——JSON 直取/SSE 末条 data:/Mcp-Session-Id 回显/
    401 403 文案细分/超时。
  - tests/mcp-tools.test.ts：命名规范化 + 哈希尾缀/撞名拒载/上限截断/三 provider schema 映射/
    非文本占位/会话禁用硬执行（工具表剔除 + 调用层拒绝双断言）。
  - tests/mcp-permission.test.ts：askOnce 语义/deny 不发请求/审计布尔。
  - tests/renderer-mcp-settings.test.ts：源码守卫。
- e2e 冒烟（波末步骤）：scripts/e2e-mcp-acceptance.mjs——真 stdio mock server 端到端一轮
  工具调用（含权限放行路径）。
- 每步验收：`cd deskminis && npm test` + `npm run typecheck` 全绿。

## 9. 决策点汇总（逐节确认清单）

| # | 决策 | 建议 |
|---|---|---|
| ① | 调用路线：直注册（修订 §5.2 的 CLI 路线为后续优化） | 采纳直注册 |
| ② | headers/env 明文落 servers.json + $$VAR 引导；safeStorage 后置 | 采纳明文 |
| ③ | 工具上限：每 server 40 / 总 120 | 采纳该值 |
| ④ | 权限：kind=mcp，askOnce per server + 入参预览 | 采纳 askOnce |
| ⑤ | 会话级禁用：数据结构 + 调用层硬执行本波做，UI 后置 | 采纳 |
| ⑥ | 传输：不做独立 SSE 旧传输（§5.2 原文确认） | 确认即可 |
| ⑦ | 步骤拆分预告：D2 配置与存储 → D3 stdio 客户端 → D4 http 客户端 →
      D5 工具注册/调用/权限 → D6 设置 UI → D7 e2e 冒烟（确认后逐步出提示词） | 确认拆法 |
