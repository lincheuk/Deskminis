# DeskMinis — 桌面端 Agent 应用（基于 OpenMinis 理念）项目笔记

> 本项目**独立于 bitapi/onerelay**，所有工作只在 `<repo>\` 下进行。
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

- ✅ **2026-08 修复波（与 Claude 全面审查协作，A1–A7 + A4b + B1–B5 + 冒烟，共 22 commit）**：
  P0 修复包——Anthropic thinking 块存储回放（开思考+工具不再 400）、权限三档接真
  （preset RPC + 持久化，「完全访问」不再是装饰）、绑定工作区文件读写放行、maxTokens
  按模型目录动态化 + 截断自动续写（降级链随 slot 重算）、CJK 水位估算修正（/1.6 分段）、
  压缩解锁（工具结果修剪 + 锚定双轨，单指令长任务可压缩）、中断三修（取消透传工具层 +
  shell 重启告知 + 权限闸后重查取消）。体验波——会话自动命名/重命名、思考过程可见
  （含 reasoning_content 采集）、只读命令免批（结构过滤 + 白名单 + 二段规则，宁漏勿错）、
  审批卡 diff 预览（惰性构造，审计只记布尔）、六件小修（mono 中文回退/权限卡按钮/纪律块
  覆盖国产模型/空响应提醒不落库/SSE 停滞看门狗/思考期 dots）。测试 1105 → **1223 例**全绿。
  新增 `e2e-smoke-wavea.mjs`（A 组行为冒烟 6 案）。真模型验收通过（nodetect/grok-4.5，
  全链路 README 任务 + 自动命名 + 工作区零弹卡实测）。审查记录与 12 步提示词手册存于
  Claude 会话产物（体检报告 + 修复工作流手册两份 Artifact）。

- ✅ **2026-08 中期波 C1–C8（与 Claude 协作，Trae 执行 + Claude 逐 commit 审查，共 8 commit）**：
  能力扩展——provider 模型列表拉取（新 RPC `provider.models.fetch` 按四 kind 分派，密钥在
  ProviderStore 内部消费不出边界；设置页 datalist + gemini/ollama 选项补齐）、只读文件三件套
  `file_list`/`file_glob`/`file_grep`（手写 `** * ?` 保守通配子集、symlink/junction 一律不进入
  以保「基准目录一次授权即覆盖遍历」、正则 DoS 与体积/时间预算全设上限）、`web_fetch`
  （新增 web-fetch 权限类目默认 askOnce——URL 查询串即外泄通道、流式 1MB 上限到限即断、
  charset 嗅探 + GBK 解码）、多模态图片输入（复用现成 mediaRef 落库、`imageData` 仅请求侧合成
  绝不落库、run 级 base64 缓存、三家 provider 各自映射、附件路径正则白名单即穿越防线）。
  加固——桥剪贴板换原生 Win32 + 30×100ms 重试（对抗 UU远程/夸克等剪贴板监听器抢占，
  本机两例真剪贴板测试恢复稳定通过）、shell 输出 GBK 兜底（驱动 `chcp 65001` 双向切 UTF-8 +
  宿主 latin1 字节切割哨兵 + 「有替换符才降级」的 `decodeShellOutput`）、只读免批受限管道
  （引号感知分段、管道右侧仅 12 个纯过滤 cmdlet、段数 ≤3、`|` 移出禁字符表但段内禁字符全保留）。
  小修——纪律块三族同文点名 tool_title 用中文、403 余额类文案细分（401 优先）、卸载桩带
  码点安全摘录（Array.from 截 200 码点防切断 emoji）。测试 1223 → **1356 例**全绿，typecheck 零错误。
  8 步提示词手册存于 Claude 会话产物（《DeskMinis 中期波工作流》Artifact）。
- ✅ **C9 执行型旗标后门（2026-08-19，C8 审查发现的既有缺口，B3 起就在）**：`rg` 在只读白名单里
  无二段规则，而 ripgrep 的 `--pre <程序>` 会对每个待搜文件调用该程序 ⇒ `rg --pre <cmd> pattern`
  此前可静默免批执行任意程序。修法：新增 `EXEC_FLAG_RE`（`--pre` / `--pre-glob` / `--hostname-bin`），
  单段判定与管道段判定**双侧**拒绝。刻意用精确匹配而非 `--pre` 前缀——`git log --pretty=…`
  与 `rg --pretty` 是高频只读用法，前缀匹配会误伤（已加两条回归用例锚定）。8 例，全量 **1364/1364**。

## 进行中 / 下一步

- ✅ **七家 harness 插件生态调研（2026-08-19）**：为「插件市场」界面立项做输入，实地调研
  DeepSeek Harness（dshmarket + awesome 清单 CI 索引范式）、goose（扩展即 MCP + 安装安全链路蓝本）、
  opencode（无机器可读市场，排除）、OpenClaw/ClawHub（真注册表 + ClawHavoc 投毒教训）、
  Hermes（Skills Hub 聚合器 + 装前扫描硬阻断）、oh-my-pi（Claude marketplace.json 兼容方证据）、
  LangGraph（判定不同赛道）。三大结论：SKILL.md 已开放标准化为 agentskills.io（DeskMinis 天然兼容）；
  可直接消费的开放注册表 = ClawHub API（技能）+ MCP 官方注册表（CC0 免鉴权）；各家「代码插件」
  互不兼容故 DeskMinis 市场应定位**技能市场 + MCP 目录**。零新依赖可行性已核实（undici/yauzl/
  importer/§5.2 全现成）。报告 → `docs/research/2026-08-19-harness-plugin-market-survey.md`
  （含 6 个待拍板决策点）。
- **进行中：D 波（2026-08-19 开工，Trae 执行 + Claude 逐 commit 审查）**：
  ① MCP 最小面——设计稿 → `docs/specs/2026-08-19-mcp-minimal-design.md`
  （**2026-08-19 用户确认 ①–⑦ 全按建议，已定稿**；核心修订：§5.2 的 CLI 调用路线本波
  改为工具直注册 `mcp__<server>__<tool>`。步骤 D2 配置与存储 → D3 stdio → D4 http →
  D5 注册/调用/权限 → D6 设置 UI → D7 e2e，逐步出提示词交 Trae）。
  **D2 已完成并过审**（main `cade971`）：`src/minisd/mcp/config.ts`——三变体宽容导入、
  `disabled`/`type` 进 KNOWN_KEYS 消费不进 extra（堵死「toggle 后重启被 extra 里的
  disabled:true 打回」的往返回魂）、extra 先铺识别字段后盖、原子写、`resolveEnvRefs`
  先收集缺失名再替换（已解析值构造上进不了错误文本）、`mcp.servers.list/upsert/remove/toggle`
  RPC。测试 1400 → **1431**（+31），复跑失败集与 52 例平台基线逐条一致。已核偏离四条：
  upsert 细分中文文案、toggle 动 updatedAt、remove 幂等、变体②非对象值跳过——均接受。
  两条审核备忘：`list()` 浅拷贝（嵌套引用共享，D3/D4 进程内消费须只读）；`loadError` 含
  JSON.parse 原文（新 V8 可能带源码片段，D6 展示时须脱敏——文件里有明文 headers）。
  **D3 已完成并过审**（main `59b5fc2`）：`src/minisd/mcp/stdio.ts`——换行分帧（跨 chunk
  缓冲/单 chunk 多消息/CRLF 容忍/垃圾行计数跳过）、initialize 握手（2025-06-18，启动超时
  杀进程不留半死连接）、tools/list nextCursor 翻页（上限 10 页防环）、tools/call 单次超时
  不迁怒连接、取消透传 notifications/cancelled 不等应答（A 波语义）、崩溃统一拒绝在途与
  新请求、结算竞态全对（超时先摘条目、迟到响应按未知 id 丢弃、同 id 只结算一次）、
  stdin EPIPE 吞噬防崩宿主。测试 1431 → **1447**（+16，真子进程 fixture 双平台可跑）。
  已核偏离：kill 后 exitCode 恒 null（Windows 实证）改断言 exitCode|signalCode 任一非 null。
  **两个 D5 硬输入**：① CVE-2024-27980 护栏下 `*.cmd + shell:false` 一律同步 EINVAL——
  设计稿 §3 的「.cmd 兜底」实际拉不起真 npx，D5 须改 `cmd.exe /c` 包裹或解析 .cmd 背后的
  js 直跑（注意参数转义）；② server→client 带 id 请求（sampling 等）现静默忽略，宜回 -32601
  否则对端挂等。**云容器基线加注**：`agent-loop offload 档触发修剪`为 CPU 密集边缘测试
  （150KB 大字符串），容器算力漂移时会贴线超 30s（同日 10→35s，D2 提交点复测同样超时，
  证明与 D3 无关）；D4 已授权给两个重测试加显式 timeout 的一行级小修，Windows 本机全绿仍为权威。
  **D4 已完成并过审，附一处返工 D4b**（main `92c9b65`）：`src/minisd/mcp/http.ts`——三中止源
  （超时/调用方/dispose）监听本地结算不依赖 fetch 传播、SSE 只认 data 行且应答后继续消化通知、
  Mcp-Session-Id 任意 2xx 捕获回显、非 2xx 一律不读响应体、DELETE 告别不挂 dispose 信号只给
  超时兜底。1447 → **1470**（+23）；复跑 52 失败与基线逐条一致（timeout 小修生效，云端复审
  基线恢复干净），typecheck 零错误。已核偏离四条均接受：initialized await-但吞错（受启动超时
  约束、保证协议顺序，优于纯 fire-and-forget）、SSE 用 text() 缓冲（POST-per-RPC 形态等价）、
  会话头任意 2xx 捕获（超集）、垃圾计数口径按 D4 规格文字。**返工 D4b（审核逮住）**：附带
  小修把 offload 例末断言写成 `expect(布尔)` 无 matcher（恒过、静默阉割断言，与报告「断言
  一字未动」不符）——**D4b 已修复并复核**（main `8bc667a`，一行 diff 实核 + 云端独立复跑
  agent-loop 38/38，含恢复断言的 offload 例 32.6s 过、在 120s 新限内）。备忘两条：预中止分支多发一条无害 cancelled；
  SSE 多行 data 不拼接（SDK 服务器均单行，低风险）。**D5 勘察定案**：工具表每 run 现取
  （loop.ts:287）+ excludedToolNames 管线可承接会话禁用；`AgentToolDefinition.parameters` 是
  平铺形（anthropic.ts:26 只认 type/description/enum）——MCP 嵌套 schema 须加可选
  rawInputSchema 由三家 provider 映射透传（列入 D5 白名单）；无现成进程树杀法，D5 补
  taskkill helper；对话流事件提示裁到 D6（状态先经 mcp.servers.list 可查，免动 renderer）。
  **D5 已完成并过审**（main `dd6df66`，20 文件 +1162/−83 全中白名单）：`mcp/manager.ts`——
  两阶段注册（并行连接、按 store 序注册，全局 120 上限截断确定性不受网络快慢影响）、
  命名规范化 + sha256 12 位尾缀、每台 40/全局 120、执行器顺序 signal→会话禁用现查→权限
  askOnce(kind=mcp, detail=server)→闸后重查→调用、崩溃标记 error + 摘工具单次驱逐重建、
  10 分钟空闲驱逐（unref 定时器）、驱逐竞态兜底；`rawInputSchema` 三家透传（gemini 递归
  剥关键字）；win32 裸名改 `cmd.exe /d /s /c` 包裹（shell:false 让 cmd 解释不经宿主 shell
  二次展开）；-32601 应答；taskkill /T 树杀；`mcp_disabled_json` 会话禁用列 +
  `chat.sessions.setMcpDisabled` RPC；**`inFlight.add` 在 `await ensureForRun()` 之前，
  占位原子性不变量保持**（审核实锚验证）。1470 → **1495**（+25），52 失败与基线逐条一致，
  无 matcher 断言扫描零命中。已核偏离：mcp-config.test 两处 toEqual 补 statuses 字段（比报告
  更严格）；chat-store 迁移落在构造器幂等自查（db.ts 不在白名单的务实解，备忘：后续可折进
  MIGRATIONS 但须带同款 PRAGMA 守卫）。备忘三条：factories 同步抛会漏 inFlight 占位（生产
  工厂纯构造不会抛，理论项）；cmd 包裹后 win32 裸名笔误显示为启动超时而非「命令不存在」
  （stderr 尾部有 cmd 原话，D6 可展示）；server→client 请求已回 -32601。
  **D6 已完成并代码过审**（main `562c7fb`，**真机目视验收待用户执行**——MU5/MU6 教训，
  设置页全操作路径：打开→添加→试连→保存→启停→删除）：`McpSettings.vue`（v-for 全挂
  template、`mx-` 前缀避撞车、状态三态点 + 行内 lastError + 行内试连结果）、SettingsModal
  四处行级接入、chat store 五 action；`mcp.servers.test` 两形态试连（{name} 试已存 /
  完整条目走 scratch store 归一校验——mkdtemp 于 OS tmpdir + finally rmSync + finally
  dispose，真 store 零触碰、试连不落库有测试锚定）；`configError` 布尔化（D2 脱敏备忘
  落实：parse 原文不出 minisd，前端固定文案）。1495 → **1509**（+14），52 失败与基线
  逐条一致。已核偏离四条均接受：mcp-config.test 全等断言补 configError:false（收紧非放宽）、
  scratch store 归一（decodeEntry 未导出下的正解，备忘：以后可导出纯函数省临时目录）、
  `mx-` 前缀、push 第 4 次成功（终端吞输出非认证问题）。
  ② ✅ **D1 web_search 已完成并过审**（main `399759a`，Trae 执行 + Claude 逐行审 diff +
  独立复跑）：搜索 provider 化三 kind（brave/tavily/searxng，searxng 供自托管免 key 场景）、
  `SearchProviderStore` 密钥只进 vault 单槽位（get 只回 hasKey、resolve 是唯一流出通道、
  换 kind 无新 key 报错且切 searxng 清残留槽位）、新权限 kind `web-search` 默认 askOnce
  （查询串即外泄通道，同 C4 论证；闸后重查取消沿用 A 波语义）、非 2xx 不读响应体（错误页
  可能回显密钥）、摘要 500 码点 + 总量 32KB 双截断。测试 1364 → **1400**（+36），typecheck
  零错误；云端复跑失败集与 52 例平台基线逐条一致。两处已核偏离：同 kind 留空保留原密钥
  （对齐 provider.instances.update 约定）、timeoutMs 可注入（生产默认 15s 不变）。
  **遗留**：brave/tavily 端点形状按 2026-08 已知信息写死，真 key 首跑属用户侧验收项。
- **下一波候选**：**扩展市场（技能市场 + MCP 目录，先出设计稿，调研报告 §6 有实施顺序建议，
  依赖 D 波 MCP 引擎）**、后台作业（无调研输入，需先出设计稿）、
  历史消息图片缩略图（C6 只做了 chip 元数据，读图 IPC 未做）。
- 遗留既有路线：浏览器/屏幕里程碑（建议单工具 CLI 语法）、模型组 UI 入口（MU7）。

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

  **⟪2026-08-19 更正：本节两条均已清账⟫** 对比度由 E1 Aurora 色板在源头解决（26 对 AA 全过 +
  tokens-aurora-contrast 守卫常驻）；键盘可达经查早在 cc9363a（2026-08-11「a11y 补齐 17→0」）+
  MU5（.tb-ico 退役为原生 button.tb-seg）落地，本节当时未回写导致 E4 规格引用了陈旧状态
  （审核方侦察漏洞，已记入 E4 审核记录），E4 补 renderer-a11y-keyboard 专属守卫钉死防回归。

### E1 审核记录（2026-08-19，云端）
- **E1 过审**（3d0c280，Aurora 调色板落地）：1509→1535（+26 对比度守卫）。云端复跑 typecheck 零错误、
  失败集与 52 例 Linux 基线逐条一致（LC_ALL=C 排序后 diff 为空）。
- 审核要点：①两份 docs 定稿与设计分支逐字一致（照抄纪律成立）；②对比度守卫 OKLCH→sRGB 转换矩阵
  系数逐位核对无误，26+1 断言齐全、全带 matcher（机械扫描零命中）、grab 抓空抛错；③tokens.css B/C 区
  改动恰为规格内 4 处换挡 + glass 切片 3 处，无私货；④evolution 6 组抽样锚与参考文件逐字一致；
  ⑤例 2 解析逻辑零改（含 RAW_FONT_MONO_OVERRIDE 豁免机制）。
- 偏离裁定：两条申报偏离（例 3 内 r-card/r-input 重复锚同步、守卫 doc 注释路径同步）均属必然跟随，接受。
  另点名一处未申报微改：B 区注释「（Appica 弱级仅 2 档）」等措辞去 Appica 化——性质同偏离 2，接受，
  下不为例（注释措辞改动也应入偏离清单）。
- 真渲染目视：xvfb + 强制 data-theme 截四图（主界面/设置页 × 暗/亮）。暗段 body 实测
  oklch(0.16 0.022 262)、浅段 oklch(0.988 0.003 220)——浅段 --bg 换挡生效（微冷白底 + 纯白浮岛卡）。
  青强调肉眼可见（发送钮/活跃项），三级文字可读性提升明显，无崩坏。
- 备忘：E2 需自查 TitleBar 下拉菜单不被玻璃壳层压住（App.vue 加 backdrop-filter 创建层叠上下文，
  菜单弹层若渲染于其内部会被封 z-index）；xterm 三值换算对照表已备（暗.fg #d0d6df / 暗.bg #080d17 /
  暗.bgStrong #1e2532 / 暗.fgMuted #a2adbd）。

### E2 审核记录（2026-08-19，云端）
- **E2 过审**（64cdcc5，Aurora 壳层）：1535→1541（+6 壳层源码守卫）。云端复跑 1541 例、
  52 失败与 Linux 基线逐条一致；typecheck 零错误；build 过。Trae 报告坦白 vitest 汇总行
  非 TTY 丢失、例数为聚合值——云端权威数与其吻合，采信。push 首次未达经坦白二次补推，远端已验。
- 审核要点：①App.vue 壳层三处玻璃 + 极光底分属性写法与守卫规格逐字对应；②TerminalPanel
  正常路径动态读 CSS 变量、兜底仅保险丝（亮色终端不受兜底暗值影响，疑虑解除）；③新守卫 6 例
  ruleBlock 抓空抛错、「恰好一处」用计数断言、反向锚齐全；④例 8 ALLOW 扩容四组件、
  POPUP_OWNERS 逐字未动；例 9 xterm 三值换算对照与参考文件一致；⑤无 matcher 扫描零命中。
- 偏离裁定：六条申报（tb-pulse 补动画、ArtifactsPanel 玻璃落容器、rl.on 显式 accent、
  例 8 注释、注释措辞入清单、tb-pend warn 边线随胶囊移除）全部接受——本次注释措辞改动
  已按上次告诫入偏离清单。
- 真渲染目视：四截图（主界面/设置 × 暗亮）。玻璃壳透斑、青指示线、HUD 任务条成立；
  设置弹层完整浮于玻璃壳上（复核 Trae 真机 72 点网格结论）。观察项：亮色右栏空态区
  极光斑透出的渐变分界稍显突兀，E3 内容区改造自然覆盖，不单独返工。

### E3 审核记录（2026-08-19，云端）
- **E3 过审**（7bd7db2，Aurora 内容区）：1541→1549（+8 内容区源码守卫）。云端复跑 1549 例、
  52 失败与基线逐条一致；typecheck 零错误；build 过。
- 审核要点：①十组件零新增 backdrop-filter（例 8 白名单零扩 + 新守卫例 8 计数锚双保险）；
  ②ThinkingBlock 流式计时器 onBeforeUnmount 清理无泄漏、历史块不伪造时长；③ToolLine :has(.spin)
  运行态缘线零 DOM；④守卫例 4 手写正则带抓空抛错；⑤无 matcher 扫描零命中。
- 偏离裁定：八条全部接受。要点：PermissionCard 主钮保留 --action 因 renderer-permcard 锚定字面
  （--action=--accent 等值链，视觉一致）；用户消息未胶囊化——任务书前提错误（现状是 MU2a/MU5
  拍板的无气泡文档式），Trae 按「宁可少动」正确处理；两处纯展示 DOM（思考秒读 span、裸工具名
  mono class）均申报。
- 真渲染目视：FakeProvider 全链路（defaultProviderId='__fake__' 零 provider 配置即通）。
  浮岛消息卡/顶缘高光/mono 会话 chip/工具行/输入卡聚焦青色外光/HUD 任务条读数全部成立，
  亮暗两主题正常。权限卡在 Linux 云端因 Windows 路径语义走不到权限门（基线内现象），
  其形态由新守卫例 5 + renderer-permcard 既有锚 + Trae 真机探针（accent 逐值一致）三重覆盖。
- 观察项（不返工，记备忘）：①主钮 hover 前后同为 accent 无反馈变化——组件层禁 color-mix，
  无好令牌可用，留待后续 polish 波（可在 tokens 层加 --accent-hover 档）；②E2 遗留的亮色
  右栏空态渐变分界经 E3 后仍在空态可见，属 wempty 平贴底，同归 polish。

### E4 审核记录 + E 波波结（2026-08-19，云端）
- **E4 过审**（baae4d7，仅 +85 行新守卫）：1549→1559。云端复跑 52 失败与基线逐条一致、
  typecheck 零错误。核心主张「组件侧属性已提前落地」经三重独立核实成立：cc9363a 存在且
  即「a11y 补齐 17→0」、普遍守卫 a11y-keyboard-reachable.test.ts 存在（无 renderer- 前缀，
  审核方当初 ls renderer-* 漏检）、SessionList 模板抽查属性齐全。设计稿 §6.2 引用陈旧
  backlog 属审核方侦察漏洞，Trae 发现后按「只补防回归守卫」处理，正确。
- 新守卫质量：:class 排除与跨行开标签兼容、.tb-ico 反向防回魂、失败消息带明细、
  it.each + 汇总双层、无 matcher 扫描零命中。偏离四条全部接受（widget role 比一刀切
  button 更优、CDP trusted 键盘事件证据强度等同真机）。
- **E4 走查新发现 bug（backlog，一行级修待拍板）**：会话卡内 ⋮（.smore 原生 button）
  Enter 无法展开菜单——keydown 冒泡到 .scard 的 @keydown.enter.prevent 被 preventDefault。
  建议修法：.scard 的 enter/space 两个 keydown 加 .self 修饰（优于 Trae 建议的逐子按钮
  加 .stop：一处治全、future-proof，且顺带解决改名 input 回车可能误触 chat.open 的同族隐患；
  新守卫断言为前缀匹配 @keydown.enter，加 .self 不需改锚）。
- **E 波波结（代码侧完成）**：E1 色板（3d0c280）→ E2 壳层（64cdcc5）→ E3 内容区（7bd7db2）
  → E4 a11y 守卫（baae4d7），1509→1559（+50 例），四步全过审。Aurora 换皮四项拍板全部兑现：
  A 骨架 + C 材质、换皮零功能增删、亮暗双主题、无障碍两账清偿。玻璃 blur 面恒定 ≤6、
  POPUP_OWNERS 禁令原样、对比度 AA 闸常驻。遗留 polish 观察项：主钮 hover 无变化档、
  亮色空态渐变分界、.smore Enter（上条）。
- **收官硬条件未清**：用户 Windows 真机目视双主题（连同 D6 设置页目视一并），确认后 E 波关账。

### DSH rc.8 情报自查（2026-08-20，云端，对照其修复项查同款雷）
- **A 推理内容回传：无雷**。openai.ts:112-115 已读 delta.reasoning_content（DeepSeek/Kimi/GLM
  兼容层思考流），另有 reasoning_effort 的 Ollama 兼容开关。DSH rc.8 才修的这条我们早防了。
- **B 取消流式半截回复：同款真雷**。agent/loop.ts 三处取消短路（236/355/375）均
  `yield error; return`，永远到不了 452 行 appendMessage——已流出展示给用户的 text 累积
  不落库，下轮提问模型看不到自己说过的半截话（与 DSH「取消后已展示前缀未带入后续」同病）。
  修法方向：取消短路时 text 非空则落一条 assistant 消息（守住「空 assistant 绝不落库」红线；
  半截工具调用不落，已有 '[工具执行被中断]' 机制的场景不受影响）。
- **C 图片载荷：半个雷**。单文件 5MB + 单条 8 张有校验（index.ts chat.prompt），但
  ①无像素尺寸控制（5MB 内的 PNG 可轻松超模型长边限制）；②context-policy.ts/offload.ts
  对 media part 零处理——多轮带图会话历史图片 base64 全量复带，随轮次累计撞载荷上限
  （DSH「历史图片累计载荷过高」同款）。修法方向：渲染端入库前 canvas 降采样（零依赖）+
  上下文策略对老图片 part 换占位文本（保留近 N 轮）。
- 其余映射：Windows 持久 PowerShell 我们早有（PersistentShell）；Profile Bundle 与商标规范
  （「DeepSeek Harness」注册商标）记为扩展市场波设计输入——市场 UI 文案需按其
  BRAND_GUIDELINES 做描述性使用合规；会话搜索/@ 引用/会话分叉/web_search 并发记入候选池。

### E4b 审核记录（2026-08-20，云端）
- **E4b 过审**（bd0f299）：diff 与提示词逐字一致——仅 SessionList.vue 一行、.scard 两个
  keydown 加 .self、零其它改动。云端复跑 1559 例、52 失败与基线逐条一致、typecheck 零错误。
  a11y 守卫前缀匹配不受影响（预判成立）。.smore Enter 被父卡吞的 bug 关账。

### F 波审核记录（2026-08-20，云端）——F1 d1d8810 + F2 a10c321 一并过审
- 云端一次性全量复跑（对照 Trae 因并行会话分 6 批跑）：**1584 例、52 失败与基线逐条一致、
  typecheck 零错误**，与其聚合数吻合。无 matcher 扫描零命中（两 commit 范围）。
- **并行踩踏事故核实**：Trae 两会话并行 F1/F2 共享 checkout 曾产出杂交 commit，申报已 amend
  修复。逐 hunk 验证成立：a10c321 的 loop.ts hunk 纯 F2（placeholderOldMediaRefs），
  d1d8810 纯 F1（cancelWithPartialReply）且 diff base 为 F2 后树，互不冲掉。
  流程教训入册：**并行执行波必须各自独立 clone 或严格串行**，共享 index 的 amend 是事故温床。
- F1 要点：generator 收尾函数复用两处短路点；turn 头不接的论证成立（续写路径上一轮已
  persist、空响应路径本就空）；streamInterruptCount=1 启用既有语义（恒写 0 无读取方，核实）；
  三例断言含顺序断言（messagePersisted 先于 error）与两红线例。
- F2 要点：downsample「优化不是闸门」回落设计正确；**扩展名跟随是 Trae 超规格抓的真雷**
  （jpeg 字节落 .png → mimeFromPath 报 image/png 与字节不符 → Anthropic 400），ext 白名单 +
  jpg 归一 + 缺省 png 兼容；占位函数保序保长、恒非空占位文本、轮界定义与 isRealUserTurn
  的差异（纯图消息算轮界）有论证；DB 零迁移兑现。
- **用户真机自查清单（未清）**：①E 波双主题目视（连 D6 设置页）；②F2 三项：4000px 大图上传
  落盘为缩后文件、连发 3 轮带图后第 4 轮请求老图成占位、gif 直传动画保留。

### F1 侧报告补达核对（2026-08-20，补记）
- F1 会话报告与云端独立审核逐项吻合：hunk 尺寸（loop 37/test 77）、streamInterruptCount
  侦察结论、远端状态均对上。例数口径澄清：两报告对 agent-loop 的 F2b 增量计数不同
  （F2 报 2 例、F1 报 4 例含纯函数轮界例）——云端权威闭环 1559+3(F1)+22(F2)=1584 成立。
- 先红证据裁定：F1 原始先红日志被覆盖，以「确定性复推」替代（F1 前代码 catch 短路无
  appendMessage）——**接受**，因审核方在 F2 审核时亲眼核过 a10c321 处 loop.ts 正是
  `yield error; return`，复推有独立旁证。流程提醒入册：先红运行的输出应存档进报告，
  复推是兜底不是常规。
- 中间污染 commit 88f1030 已被 amend 出历史，最终链 bd0f299→a10c321→d1d8810 干净（已核）。

### F2-1 真机撞雷与 F2c 立项（2026-08-20）
- 用户真机自查 F2-1 发现：4000px 大图未缩。根因 pickSmallerDataUrl「字节取小」压过像素
  上限——png 缩放重采样引入噪点、无损压缩敏感，「缩后字节反超」是常规场景非罕见，
  原图胜出 → 像素上限失守。**规格责任在审核方**（F2 提示词明写「取小的那份」），
  Trae 忠实执行无过。教训入册：字节与像素是两个独立约束，混在一个「取小」里必失守其一。
- F2c 修复方向已交付提示词：①needsResize 必用缩后结果（像素硬约束）；②删 pickSmallerDataUrl，
  字节估算抽 approxDataUrlBytes；③png 缩后超 5MB 极端兜底转 jpeg 0.92。待执行待审。

### F2c 审核记录（2026-08-20，云端）——F2-1 撞雷修复过审
- **F2c 过审**（d707cc0，2 文件 +48/-24）：1584→1588。云端复跑 52 失败与基线逐条一致、
  typecheck 零错误、无 matcher 扫描零命中。
- 修前取证坐实机理：真机实测 png 4000×3000 原 539094B、缩后 789390B（+46%）——
  「png 重采样噪点致缩后字节反超」从推断变实证，「字节取小」规格缺陷定案。
- 实现要点核过：needsResize 必用缩后结果；pickSmallerDataUrl 删除 + 防回魂反向锚；
  approxDataUrlBytes 表驱动含 base64 填充边界；png 超 5MB 兜底从 original 源直缩改导
  jpeg 0.92（避免二次重采样，正确细节）；容错回落路径原样。
- 真机复验（Trae）：同图落盘 1568×1176、jpeg 路径正常、gif 逐字节直传（F2-3 一并 PASS）、
  e2e 6/6。**F2-1 关账；F2-3（gif）随本报告关账；F2-2（3 轮带图占位）真机项仍待用户。**

### D/E/F 关账 + G 波开门（2026-08-20）
- 用户真机确认：F2-2（3 轮带图占位）过、E 波双主题目视过、D6 设置页目视过。
  **E 波正式关账（E1-E4+E4b 全过审+目视）；F 波关账（F1/F2/F2c 全过审+三项真机全过）；
  D 波仅剩 D7 e2e（提示词在手册 §11，不阻塞新波）。**
- G 波（扩展市场）开门：设计稿 docs/specs/2026-08-20-extension-market-design.md 出稿待确认。
  相对调研时的前提变化：MCP 引擎已落地 → 两翼（技能市场 + MCP 目录）一波做；
  存量复用面核实（SkillImporter 全套 RPC、mcp.servers.upsert、Node 22 全局 fetch 零新依赖）。

### DSH 生态需求盘点 → 候选池扩充与三大件立项（2026-08-20，用户拍板）
- 背景：实抓 awesome-dsh-plugin 全清单（700+ 非主题条目），主体为 DSH 代码插件不可直装，
  按「已验证需求信号」盘点原生化价值。已有印证：终端面板/HUD 任务条/工作区 chip/思考力度。
- **用户点名立项（三大件，各需独立设计稿）**：
  ① 多窗口对话墙（N 会话并排）——架构级：布局骨架、chat store 多会话并发订阅、渲染性能；
  ② genui 内联交互组件（agent 输出渲染交互 UI）——安全敏感：不可信内容执行面需沙箱、
     渲染管线新 part 类型、provider 协议面；
  ③ 文本选区注释（选中文本加注、回复映射）——注释数据模型（DB 追加迁移）、选区锚定、
     注释 UI。三者中最自包续。
- **候选池记入（需求信号排序)**：用量与成本面板（DSH 生态 150+ 同类插件，最强信号）、
  Ctrl+K 命令面板、非图像文件附件、模型选择器搜索、消息内文件路径可点击、已完成回合自动折叠、
  规划模式。
- 排期建议（待用户裁定）：G 波（扩展市场，设计稿已出待确认）先收 → H 注释 → I genui →
  J 对话墙（由小到大，每件先设计稿逐节确认）。

### G1 审核记录（2026-08-20，云端，含性能审）
- **G1 过审**（c4691a5，16 文件 +1925/-12）：1588→1634。云端复跑 52 失败与基线逐条一致、
  typecheck 零错误、无 matcher 扫描零命中。三源实抓全通、B 计划零启用（awesome-dsh 有
  /plugins.json 真 ETag，count=1718，其中技能类 67 条入列）。
- 安全审：白名单闸为运行时行为闸（hostname 全等防仿冒子域、https 强制、闸在 fetch 前）✓；
  请求头零本机标识 ✓；verdict 映射裁定**接受**——列表层无 scan 数据不冒充 ok（unscanned/warn），
  详情层消费上游总裁定 security.status（clean 但 vt 子扫描器异议时不二次裁判，调研 §4 原则）；
  hasWarnings 记 G3 详情页辅助提示候选。fixture 环境变量生产亦生效——与 FakeProvider 先例
  一致，记观察项不改。
- 性能审（用户点名）：缓存 TTL 内零网络 + 预编译语句 ✓；304 只 touch ✓；allSettled 并发聚合
  单源挂不拖垮 ✓；README 不进列表 ✓；分页本地切页策略（SEARCH_FETCH_LIMIT=60 固定窗口保缓存
  命中）合理。**发现一个真竞态**：Semaphore.release 先减计数再唤醒，被唤醒者的 inflight++ 在
  微任务——同步窗口内新 acquire 可使瞬时并发到 3。影响轻微（窗口极窄、仅超「≤2」意图），
  修法=release 名额转交式（有排队者不减计数直接转交），**已排入 G2 顺手修**。
- 迁移 [6] 纯追加建表 ✓ 注释含「发布不可改」纪律；TTL 不入库（策略调整无需迁移）是好设计。

### G2 审核记录（2026-08-20，云端）
- **G2 过审**（477b4c1，13 文件 +1348/-46）：1634→1672。云端复跑 52 失败与基线逐条一致、
  typecheck 零错误、扫描零命中。
- 安全审核过硬处：malicious 硬阻断在 confirm 检查之前且接口物理无 force；rmSync 刻意不带
  force 字样（字面锚延伸）；env「只收声明过的键」比规格更严；content_hash 改下载字节自算
  sha256（/resolve 无 hash 字段，自算比上游更可信）；npx 自动补 -y 防交互挂起（超规格正确跟随）；
  信号量名额转交式修复落地并有峰值例（G1 竞态关账）。
- **审核发现（G3 捎带修）**：stdio 白名单闸的 npx 逃逸拦截用全等匹配，`--call=xxx` 等号连写
  形态漏网（npm 参数解析支持 = 形态）。边际风险有限（恶意条目本可 -y evil-pkg 同效，真防线
  是确认卡展示完整命令），但拦不全=虚假安全感，补 startsWith('--call=') 一行。
- **点名（第二次未申报小改）**：skills/importer.ts 的 unzipToMemory 加 export（纯导出+注释，
  复用解压/防穿越纪律，改法正确）——但白名单外文件改动未入偏离清单。重申纪律：**白名单外
  任何文件的任何改动（含纯导出/注释）必须申报**。
- 偏离六条全部接受（独立 install.ts 职责分离、hash 自算、-y 补位、先红一条例外如实记录、
  rmSync 字面锚、迁移测试连带三处）。

### G3 审核记录（2026-08-20，云端）+ 审核方自纠
- **G3 过审**（0feac61，16 文件 +1285/-14）：1672→1690。云端复跑 52 失败与基线逐条一致、
  G3 头 tsc 显式退出码 0、扫描零命中。偏离五条全部申报（G2 点名生效）且全部接受
  （hasWarnings 透出、类型修复、titlebar 豁免到值不豁免文件、e2e 证据入库沿成例、
  单文件+就地展开实现决策）。
- **审核方自纠（G2 typecheck 假阳性）**：复核证实 477b4c1 上 tsc 实报 TS2304+TS7006 两错——
  G2 轮审核命令里 `npm run typecheck && echo TYPECHECK_OK` 失败后 && 链静默断掉，
  TYPECHECK_OK 从未打印，审核结论却写了「typecheck 零错误」。测试全绿掩盖（vitest 转译
  不查类型）。Trae「HEAD 即有」申报属实，其修复把两错都清了（G3 头验证干净）。
  **流程修正入册：typecheck 验证必须看到显式成功标记（echo 独立行 + 退出码）才可写入结论；
  复合命令的 && 静默断链是审核方自己的 D4 级教训。**
- 云端 fixture 全链路 UI 真跑（DESKMINIS_MARKET_FIXTURE_URL 注入本地 node:http fixture）：
  扩展 tab 激活、两子 tab、源 chips、搜索防抖真发（q=pdf）、卡片流（mono 读数/verdict/
  源徽章/浮岛形态）、Install → detail(ownerHandle 消歧) → scan(verdict 复核) → 确认卡
  （scrim+sheet、双钮）→ 确认后 download——fixture 未配 404 时**失败红字如实透出**
  （失败路径 UI 一并验证）。plan 阶段下载 zip 属设计内（文件清单预告）。
  对照库内 Trae 真机七图：MCP 确认卡 §4 全项齐（完整命令原样/env 值只存在本机/必填缺失
  橙字 gating/未扫描灰字），列表卡片流完整。
- **G 波 G1-G3 完成**：扩展市场全链路上线（三源浏览/搜索/详情/安全确认卡/安装/已装态）。
  G4（更新检查）设计稿标可后置，待用户裁定即做或收官。

### G3 使用闭环验证（2026-08-20，云端，用户点名「装完能不能真调用」）
- **两条链路全通**（fixture 三源 + xvfb 真跑，两段式驱动）：
  ①技能：市场搜索 → 确认卡（download 预告文件清单）→ 确认安装 → 已装态 → skills/pdf/SKILL.md
  真落盘（进系统提示由 skills-prompt.test.ts 既有单测背书）；
  ②MCP：确认卡（npx -y 命令原样 + API_KEY 必填 isSecret 输入）→ servers.json 真生成
  （name 归一 io.github.acme-fetcher、env 值来自确认卡输入而非注册表——反向锚实景验证）→
  引擎试连 ✓ → FakeProvider 会话调 mcp__io_github_acme-fetcher__echo → **权限卡（kind=mcp
  askOnce）弹出** → 允许 → echo 执行 ✓ 输出回流页面。
- 等价替换申报（唯一非真环节）：npx 包载体换 node + tests/mcp-stdio-server.mjs（虚构 npm 包
  云端不可得），条目名/env/结构/引擎链路全真。
- 过程三次 driver 踩坑，**每个都反证了产品防线在工作**：①env 误填搜索框 → G2 必填 gating
  真把安装拦下（「必填环境变量缺失」橙字）；②工具名手拼带点号 → manager sanitizeSegment
  规范化（D5 设计内，模型按工具定义调用不会踩）；③缺 tool_title → 工具协议参数校验拦截。
  均为 driver 侧修正，产品零改动。

### G4 审核记录 + 端到端调用闭环 + G 波波结（2026-08-20，云端）
- **G4 过审**（8824ed4，9 文件 +899/-54）：1690→1713。云端复跑 52 失败与基线逐条一致、
  tsc 显式 TSC_OK_EXPLICIT、扫描零命中。要点：install 时刻也做 ttlMs=0 裁定复核（把
  「checkUpdates 后、install 前上游换恶意包」的时序洞一并堵上，超规格正确）；mergeEnvForUpdate
  纯函数三规则 + existing 来自 servers.json 非注册表的反向锚说明；技能覆盖重装保留使用痕迹。
  偏离 2（/resolve match 恒 null → 字节直比）裁定接受——比的就是将装之物，语义最真；
  性能（手动触发 × KB 级 zip）可忽略，provenance 补 version 字段记 polish 候选。
  偏离 1（importer overwriteId，白名单外）已申报 ✓。
- **端到端调用闭环（用户点名验证，云端 xvfb 全链路）**：
  ①技能：市场 UI 搜索→确认卡→确认安装→toast「已安装『Pdf』」→ 落盘 skills/pdf/SKILL.md
   + SkillStore 注册（提示注入由 skills-prompt.test.ts 既有锚背书）；
  ②MCP：确认卡 env 收集（password 框填 test-key-123）→ servers.json 产物完整（npx -y 命令、
   **env 值来自用户输入、注册表零带值**）→ 命令等价替换 node+本仓 stdio fixture（云端无
   npm 包运行环境，申报）→ 引擎真启动 → 工具注册 mcp__io_github_acme-fetcher__echo →
   FakeProvider 会话真调用 → **kind=mcp 权限卡弹出**（允许/本会话允许/拒绝 + 任务条待批徽记）
   → 允许 → echo 执行 → 结果原样回流 UI。**装→用全链路零产品 bug**。
  ③过程三次弯路全为验证方 driver 侧（Enter 未触发发送、工具名未按 sanitizeSegment 归一、
   缺 tool_title 必填参）——后两者恰证明产品纪律在正确工作（点号归一符合 Anthropic 工具名
   规范；tool_title 是本项目工具协议，真模型按 schema 必带）。
- **G 波正式波结**：G1 客户端 → G2 安装链路 → G3 市场 UI → G4 更新检查，四步全过审，
  1634…→1713（G 波累计 +79 例）。立项初心兑现：三源（ClawHub/MCP Registry/awesome-dsh-plugin）
  浏览/搜索/安全确认卡/一键安装/更新检查全通，装完即用经全链路实证。ClawHavoc 防线全套
  在位（malicious 无 force 硬阻断 × 安装与更新双时刻、env 本地闭环、stdio 白名单、
  install 拒任意 URL）。

### D7 审核记录 + D 波波结（2026-08-20，云端）
- **D7 过审**（6adb4bf，2 文件 +250/-0）：白名单严丝合缝——package.json 仅 scripts 段
  +1 行 `e2e:mcp`，零依赖变动、零新单测；scripts/e2e-mcp-acceptance.mjs 249 行。
  提示词四处适配全部按写落地（基线 1713、tool_title 必填进六案、案 3/案 5 按 FakeProvider
  「重放历史首条」机制设计断言、模板从 mu6 换 m2a 纯 RPC 面），脚本对四个源码锚点
  （DESKMINIS_STANDALONE 握手、turnEnd/textDelta 事件名、SessionMeta.id、「正在运行」
  竞态文案）逐一核对无虚构。
- **云端独立复跑三项全绿**：①build 后 `node scripts/e2e-mcp-acceptance.mjs` 六案 6/6
  退出码 0——脚本在 Linux 云端 headless 全过，与 Trae Windows 真机双平台实证（elapsedMs
  95↔253 为环境差）；②npm test 1713 例/140 文件，52 失败与 Linux 基线**排序归一后逐条
  全等**（首轮 diff 全为行序漂移，LC_ALL=C 双侧重排后空 diff）；③tsc 真实退出码 0
  （审核方首查又踩管道吞退出码——`npm run typecheck | tail; echo $?` 取到的是 tail 的码，
  自查即纠，重跑独立重定向取真码。G2 教训第二次现形，纪律再钉一遍：**退出码必须来自
  目标命令本身，任何管道/链式后取 $? 一律无效**）。
- **脚本质量要点（性能/健壮性视角）**：回合超时 150s > 权限超时 90s 的量化理由写进注释
  （「无权限卡」断言不被误报截断）；waiter 与 collector 双通道监听均在 finally 摘除；
  「该会话正在运行中」已知竞态用 300ms×10 退避而非拍脑袋 sleep；finally 关进程后 800ms
  再删数据根（minis.db 单进程持有）；六案逐案 try/catch，单案异常不吞后续案。零改进项。
- **偏离三条裁定**：① npm.cmd 替代裸 npm（PowerShell 执行策略拦 npm.ps1）——环境层等价，
  接受；② push 退避循环 `| Out-String` 吞掉 git 退出码致首推误判成功，发现后弃循环单条
  重推——坦白属实、最终 `git log origin/main` 验证干净，接受；**与审核方 G2/本轮 typecheck
  同构的第三次「管道吞退出码」，双方各中过，教训对称入册**；③ pull --ff-only 未显式复现
  但谱系（6adb4bf 单父即 8824ed4、无 divergence）证实 no-op 语义满足，接受。
- **D 波正式波结**：D1 web_search（399759a）→ D2 配置层 → D3 stdio 客户端 → D4 http →
  D5 注册/调用/权限 → D6 设置页 → D7 e2e 冒烟（6adb4bf），七步全过审。引擎面：双传输、
  宽容配置、mcp__ 归一命名、kind=mcp askOnce 权限、会话级禁用硬执行、试连、设置页全路径、
  可回归 e2e（npm run e2e:mcp）。G 波市场装出的 MCP 走同一引擎，装→用闭环已实证——
  两波在 servers.json 接缝处如设计稿预留严丝合缝。
- **收官遗留一件**：README 能力表陈旧——「MCP ⛔ 未实现」应转 ✅、缺「扩展市场」行、
  Agent 工具清单缺 web_search。属 main 侧 README.md 三行级小修，**排进下一个 Trae 提示词
  作授权附带小修**（白名单点名，不单开一轮）。
- **收官遗留已清（改道）**：README 对齐未走「下一提示词附带小修」——用户指令
  「你来做收官遗留」授权审核方直接提交 main（032a117，仅 README.md +3/-2）：
  MCP 行 ⛔→✅ 并移入已实现区（紧随扩展市场行，主题相邻）、新增扩展市场行、
  工具清单补 web_search（真名对源码 tools/web-search.ts 核过）。推送经退避循环 +
  远端验证。D 波至此**零遗留**。

### H 波：文本选区注释——设计与实现均由审核方执行（2026-08-20，用户「H波自己做」授权）
- **三步全落 main**：H1 后端（2e5c086，迁移[8] annotations + ChatStore 注释面 + RPC 四件
  + changed 广播，12 例）→ H2 前端（5fa33d1，anchor.ts 纯核心 + 选区浮条引用/标注 +
  CSS Custom Highlight API 渲染，21 例）→ H3 气泡（933d4c3，点高亮查看/编辑笔记/删除 +
  README 能力行，+4 例守卫）。1713→1750，每步 TDD 先红存档、npm test 全绿（云端 52
  平台基线逐条比对全等）、tsc 真实退出码 0。
- **核心技术决策兑现**：①锚定 = TextQuoteSelector 对「渲染后文本」，匹配域取**去尽空白
  骨架 + 偏移映射**（块级边界 selection.toString 合成换行 vs textContent 无分隔，唯此
  双向对齐；中文零损失，歧义由前后文 32 字符消解）；②高亮 = CSS Custom Highlight API
  零 DOM 改写，重算仅由消息/注释/会话变化触发 + rAF 合帧，命中判定与着色同源同批 Range；
  ③注释不入模型上下文、不入设备同步（红线守住，均记候选池）。
- **xvfb 全链路实证**：选区→浮条→标注落库→高亮 count=1→引用预填「> …」→**重启重锚定
  count=1**→点高亮开卡（焦点进笔记框）→存笔记→noted 档=1→note 回显→删除清零。
- **自审逮到并当场修掉两只真 bug**：①浮条 CJK 竖排（absolute 盒 shrink-to-fit 撞右缘，
  width:max-content + 半宽夹紧）——截图目视才见，测试全绿看不见，「全绿 ≠ 界面正常」
  第三次兑现；②`.stream` 挂 `<div @click>` 被 **E4 键盘可达守卫在波终门禁拦下**——
  守卫体系打到了守卫作者自己，正解收编进 mouseup 单手势面而非加豁免。守卫在自做模式下
  的价值实证入册。
- 随动申报：H1 四个迁移版本钉测试 8→9 + 旧库回退块补撤 annotations（G1/G2 同款成例）。
- v1 边界（后续候选）：气泡键盘打开路径（注释列表面板）、注释入模型上下文、注释同步。

### I 波：AionUi 换向 UI 重做——调研/设计/实现/审核全由审核方执行（2026-08-20，用户当日指令）
- **指令与立项**：用户 2026-08-20「喜欢 AionUi 的 UI，按照它重做 UI、现有功能完美集成；
  项目要不止 coding、像 cowork 一样；搜集其功能评估复用」。原 I 波 genui 延后进候选池。
  立项材料入 docs：调研报告（docs/research/2026-08-20-aionui-survey.md，7 路并行代码调研
  iOfficeAI/AionUi v2.1.59 + 截图目视 + 一手精读）+ 设计稿（docs/specs/
  2026-08-20-ui-redo-aionui-design.md）+ 换向色板参考文件（伴生，26+1 对预验算全过）。
- **四步全落 main**：I1 色板换向（c965365，A 区四段替换 AionUi 蓝白系 + B 区圆角三挡
  card 12/input 24/sheet 16 + mu3 例 1/2/3/7 与 evolution 抽样锚改锚；对比度守卫 26+1
  零改动全过——「改色板必过 AA 闸」资产兑现）→ I2 壳层平面化（39ad8b0，玻璃/受光边/极光
  消费退场：App 三壳层 + Progress/Artifacts/Files 实色化；例 8 白名单缩容空集、
  renderer-aurora-shell 改造更名 renderer-shell-form）→ I3 欢迎态（ef3ff93，
  welcomeMode：空会话工作台退场 + hero「你好，今天想做点什么？」+ composer 居中；
  判据抽纯模块 lib/welcome/blank 供 App/ChatView 共用；TitleBar 开关 disabled+说明；
  新守卫 renderer-welcome 9 例）→ I4 内容区平面形态（384e965，用户消息右对齐浅蓝气泡
  （--secondary-subtle + 方向切角，锚域一字未动）+ 助手满行宽平铺 + ThinkingBlock 浅渐变
  + SessionList 行平面化 + 设置四页/市场受光边全站清零 + xterm 兜底三值换算；
  renderer-aurora-content 改造更名 renderer-content-form 10 例）。
  每步 TDD 先红存档、npm test 全量对 Linux 52 例基线 diff 为空、tsc 真实退出码 0。
- **I5 终验（无独立代码 commit）**：设置/市场/弹窗的 AionUi 形态由 I1 色板 + I4 受光边
  收敛自动获得，xvfb 目视确认达标故不加改动（最小改动面）。build 后 xvfb 七张截图
  （欢迎浅/暗、会话浅/暗、工具行、设置浅/暗）入 docs specs/audit-shots/i5-*.png；
  driver 入 handoff/driver/drive-i5.mjs。机制探针：欢迎态 hero 在/工作台+折叠条隐、
  发首条消息工作台回场、气泡 bg=oklch(0.537 0.239 262.8/0.1) 右对齐 flex-end 全实测。
- **事故与教训入册**：①I2 提交链短路——`git add` 对已 rm 文件的 pathspec 报错后，
  换行使 `git commit -F 过期消息文件` 独立执行，把守卫删除以「I1:」误标半提交推出
  （c335ae4，内容无害；39ad8b0 内申报并补齐）。教训：**多命令提交链里 add/commit 必须
  同一 && 链，消息文件写入与提交分开两条 Bash**；②守卫 ruleBlock「首个选择器匹配」陷阱：
  `.pane-c.welcome .composer` 置于原 `.composer` 之前时被守卫误当主块（i3 全量首跑逮到），
  欢迎态变体规则一律置样式末尾并注释成因；③FakeProvider「重放历史首条」再次兑现：
  同会话第二条 __tool__ 不生效致权限卡未目视（file_write 沙箱内自动放行属权限档正常行为），
  PermissionCard 本波仅摘受光边、守卫锚全绿，真机收官时用户可补目视。
- **红线兑现**：零新 npm 依赖（driver 的 playwright-core 装在审核方 scratchpad，项目
  package.json 一字未动）；README 能力表零变化（纯视觉波无能力增删）；DB 零迁移；
  「苹果磨砂」2026-08-10 要求按用户新指令覆盖性退场（设计稿 §0 申报）。
- **后续排期建议（待用户裁定）**：J 波助手体系（名称/头像/规则/默认技能/模型/权限档的
  命名预设 + 欢迎页助手卡，cowork 化地基）→ K 波定时任务（interval/once/cron 三态 +
  绑定会话/模型/技能）；候选池增补见调研报告 §2 表 Ⅲ 档（文件预览增强/@文件/输入历史/
  锚点导航轨/会话级 MCP 勾选/图片生成/内置浏览器升格/办公技能包）。

### J 波：助手体系——cowork 化地基（2026-08-20，用户「做建议立项和候选池」授权，自己做）
- **两步全落 main + 终验**：J1 后端（b209394，迁移[9] assistants + AssistantStore +
  一次性种子 3 个（settings 标记，删除不复活）+ applyAssistantPreset（技能快照覆盖：
  勾选写 1 其余写 0，覆盖回落全局的坑显式堵住）+ chat.sessions.create 扩参 +
  promptFactory 注入 assistantBlock + RPC 五件）→ J2 前端（6ccc68a，欢迎页助手卡两态 +
  AssistantSettings 管理页 + SessionList emoji 前缀）。26+ 新例，五版本钉文件 9→10 随动申报。
- **重大随动修缺**：J2 调研实锤**会话模型绑定休眠 bug**——SessionList 自 MU6 起写裸
  provider id，chat.prompt 解析只认 'provider:'/'group:' 前缀，**绑定从未生效**（静默走
  默认模型，README 宣传的功能形同虚设）。三侧齐修：select 写前缀值 + 显示侧归一化
  bindingValue + 后端兼容分支接住旧库存量裸 id（查无抛错可见，不再无声用错模型）。
- **xvfb 终验实证**（j3-*.png 七图入册）：种子三卡在欢迎页 → 点卡建绑定会话 → hero 换
  🤝通用协作 + 预设 prompts 卡 + 换助手钮 → 点 prompt 填入不发送 → 会话行 emoji 前缀 →
  设置·助手管理页列表与编辑表单双主题全对。
- 已知边界（设计稿 §0 如实记录）：技能覆盖是建会话时快照——会话建成后新装技能会按
  全局开关漏进助手会话（三层判定改造留候选）；deleteSession 级联删补
  session_skill_overrides（残留膨胀治理随 J1 落地）。
- 事故：J2 全量首跑逮到 renderer-mcp-settings 钉 Section 联合类型子串（插 'assistants'
  破锚），改锚申报后绿——「守卫红先想它对不对」，这次守卫对（次序锚保留）、锚宽了（改窄）。

### I6：欢迎屏/侧栏/标题栏对齐 AionUi 新版（2026-08-20，用户「你那个明明是旧版ui」+ 三截图指令）
- **用户批评成立**：I 波落了配色与概念，但骨架留旧壳——图标轨默认、composer 钉底、
  助手卡在 composer 上方、标题栏三文字菜单。edf3dd0 逐项对齐新版参考：
  欢迎屏 hero→composer→助手 chips 次序（EmptyState 分部渲染）+ **选中再输入**流
  （chip 写选择态不建会话、发送才建绑定会话，J2「点卡立即建会话」被取代）+
  侧栏默认恒展开 240px 白底品牌行（覆盖 MU5 决策 2-2，申报）+ 标题栏单 ☰ 菜单。
- 改锚四文件申报（mu5/sessioncard/evolution/assistants）；xvfb 次序与流程探针全过，
  i6-*.png 四图入册。K 波施工为此让路暂停后恢复。
- 遗留：用户第三张截图（会话视图：文件预览中心化 + View Steps 折叠 + 工作区树右栏）
  属会话视图对齐——比欢迎屏面大，列 **I7 候选**待拍板。

### K 波：定时任务——24/7 叙事的诚实版（2026-08-20，自己做）
- **两步全落 main + 终验**：K1 后端（df1abb8，迁移[10] cron_jobs + schedule 纯核心
  （5 段解析/Vixie 日周 OR/本机时区逐分钟扫 366 天上限/interval ≥5 分钟）+ CronStore +
  30s 调度器（unref + tick 防重入 + 任务级并发防重 skipped-running）+ 裸 methods 直调
  chat.prompt + runDoneHooks 完成钩子——顺带治理「loop 抛错仅广播不落库」无痕缺口；
  once 自动停用、错过补跑门在启动首查）→ K2 前端（7fab434，「定时」全局 tab +
  CronPanel 三态表单带实时人话预览 + describe 纯模块「描述不了回落原文不硬编」）。
- **诚实边界产品化**：面板头常驻「应用运行时生效（不驻留后台不假装 24/7）」+
  「无人值守权限卡 90s 自动拒绝，要全自动请全局切完全访问（慎用）」——设计稿 §0
  两裁定的用户可见面。会话形态：⏰ 前缀 + sessions.source='cron'（迁移[0] 预留列
  首次启用）+ 可绑 J 波助手（applyAssistantPreset 复用，J/K 拼积木实证）。
- **xvfb 全链路实证**（k3-*.png 五图）：建任务（interval+绑定通用协作）→ 立即运行 →
  ⏰ 会话建立 → FakeProvider 实跑回复 → last_status ok 回流 → 查看会话跳转全通。
- 版本钉六文件 10→11 随动申报（assistants-store 亦钉版本，「五文件」清单自此修正为六）。
