# 附录：pi 逐子系统核验笔记（2026-09-25）

对象：badlogic/pi-mono `8676a0d`（coding-agent 0.87.1），MIT，Copyright (c) 2025 Mario Zechner。
路径省略开头的 `packages/`。行号都在本次克隆上打开核对过。
正文 `2026-09-25-four-way-baseline.md` 的 §1 每格只放一个证据，这里补全其余证据、稳定面与实验面的区分，以及落地要点。

## 先分清两层

- **稳定面**（发布、默认路径）：coding-agent 的 CLI、SDK、stdio JSONL RPC，pi-ai 模型层，经典 Agent 循环（`agent/src/agent-loop.ts`、`agent/src/agent.ts`）。
- **实验面**（只在 `PI_EXPERIMENTAL=1` 时用，`coding-agent/src/core/experimental.ts:2`）：chord、durable、`agent/src/harness/`（lane、drive、pico3）、protocol v8、`coding-agent/src/experimental/`（mini、micro、Radius）。
  Unix 传输在 win32 上直接抛错（`client/src/unix.ts:38,99`）。
- **本表的规矩**：
  - 基准只取稳定面。
  - 实验面里没有依赖的小工具可以借，例如 AdaptivePublisher、fork-policy 的复制表，但要写明出处是实验面。
- **依赖面**：
  - pi-ai 依赖各家官方 SDK 与 partial-json，所以整个 provider 层不能搬。
  - 能搬的是不带运行时依赖的工具文件：`ai/src/utils/overflow.ts`、`retry.ts`、`provider-retry.ts`、`agent/src/harness/utils/adaptive-publisher.ts` 没有任何运行时 import；`coding-agent/src/core/crash-log.ts`、`tools/output-accumulator.ts` 只用 Node 内置模块。
  - coding-agent 依赖 diff、jiti、photon 等；agent 包依赖 diff；chord 依赖 esbuild。这些依赖牵着的部分都不借。

## 逐子系统

### 1 会话模型与事件持久化——不作基准

- **做法**：
  - 会话是 JSONL 追加树：每条有 id/parentId，leaf 指针记当前位置，新条目挂在 leaf 下面（`coding-agent/src/core/session-manager.ts:975-986`）。
  - 条目 11 类：消息、思考档变更、模型变更、用量、压缩、分支摘要、自定义、标签、会话信息、自定义消息、上下文编辑（`:57-197`）。
- **持久化**：
  - 逐条 appendFileSync；第一条 assistant 回复之前先不落盘，回复到了再整批写（`:1150-1185`）。
  - 没有 seq，也没有事务。
- **迁移**：CURRENT_SESSION_VERSION=3；加载旧文件时就地迁移 v1→v2→v3，并整文件重写（`:41,286-351,1085-1094,1124`）。
  这一条 9/24 `pi.md` 没写。它写的反面是 session-backends/sqlite-node 原地改写初始迁移。两处性质相同，DeskMinis 都不学。
- **原始转录不动**：模型视图靠追加的 context_edit 投影（`:168-181`；`agent-session.ts:1015` 的 _omitRecoveryAttempt）。
  这个理念 DeskMinis 已有（原始消息永不改写），W5c 的截止点落盘是同一思路，不必引入 context_edit 条目。

### 2 引擎与渲染端协议——不作基准

- **协议形态**：stdio JSONL，一个进程一个客户端。严格按 LF 分帧，不用 Node readline，因为 readline 会把 U+2028/U+2029 当换行（`coding-agent/src/modes/rpc/jsonl.ts:1-60`）。
- **补漏**：`get_entries` 带 since 条目 id，返回其后的条目与 leafId（`rpc-mode.ts:638-649`）。
- **断连**：客户端在子进程退出、出错、stdin 出错时拒绝全部挂起请求（`rpc-client.ts:107-124,541-543`）。这条与 ZCode 同原则，W2b-3 已按此做。
- **实验面**：lane.watch 先截快照、再放缓冲，两阶段订阅（`agent/src/harness/runtime/lane.ts:1705`）。9/24 路线 W6c 把它列进借鉴栏，只借语义。
- **为什么不作基准**：单客户端 stdio 与 DeskMinis 的多连接 WebSocket 不同形；ZCode V4 已在产品里跑。

### 3 运行器循环——不作基准，借两处小机制

- **两层循环**：内层在工具批次之后取 steer，外层在「本来要停」时取 followUp（`agent/src/agent-loop.ts:174-306`）。
  两个队列默认一次取一条（`agent/src/agent.ts:247-248`）。
- **没有回合上限**（源码 grep 不到 maxTurns）。
- **截断回合的工具调用一律不执行**：stopReason 为 length 时，这条消息里的工具调用全部返回「输出被截断，请带完整参数重发」（`agent-loop.ts:262-270,475-501`）。→ W5b 已排。
- **停止时回填**：交互模式在中止时把排队的消息回填到输入框（`coding-agent/src/modes/interactive/interactive-mode.ts:1918`）。→ W7a 已排。
- **实验面**：悬空工具只有存储与声明都是 safe 才重跑，否则合成一条「结果未知」（`agent/src/harness/runtime/drive/tools.ts:44,194,527`）。
  稳定面的 coding-agent 工具没有 replay 声明。所以正文第 3 行悬空工具的主基准仍是 OpenCode 的 failInterruptedTools。

### 4 工具协议与副作用元数据——不作基准，借 details

- **AgentTool**（`agent/src/types.ts:420-468`）：
  - 结果分 content（给模型）与 details（结构化，给日志与界面，不进模型上下文）；
  - prepareArguments 是入参垫片；
  - executionMode 为 sequential 或 parallel，同批里只要有一个 sequential 整批就串行（`agent-loop.ts:508-519`）；
  - terminate 表示整批都要求停时才提前停。
- **例子**：edit 工具的 details 带 diff、patch、首个改动行（`coding-agent/src/core/tools/edit.ts:210`）。→ 正文 §4 第 8 条。
- **为什么不作基准**：ZCode 的 readOnly、concurrentSafe、sideEffectScope 能按段调度，比 pi「一个串行就全串行」细。

### 5 权限与交互通道——明确不作基准

- **没有审批**：官方安全文档写明「不会在每次工具调用前请求批准」（`coding-agent/docs/security.md:3`）。
- **拦截只靠扩展**：beforeToolCall 只在有扩展订阅 tool_call 时才发事件，扩展抛错按拦截处理（`coding-agent/src/core/agent-session.ts:530-550`；`extensions/runner.ts:1134-1150`）。
- **示例扩展**：permission-gate 只拦三类危险 bash（`coding-agent/examples/extensions/permission-gate.ts:1-40`）。
- **可参照的一点**：RPC 的 extension_ui_request 有 select、confirm、input、editor 几种，前三种可带超时（`coding-agent/src/modes/rpc/rpc-types.ts:247-281`）。
  这与 ZCode 的 InteractionRegistry 是同一类东西，不另立基准。

### 6 上下文压缩：触发、熔断与边界——不作基准

- **触发**：超过「窗口减 reserveTokens（默认 16384）」就压（`coding-agent/src/core/compaction/compaction.ts:144-151,289-292`）。
- **失败**：发 compaction_end（带 errorMessage）与 session_compact_failed（`agent-session.ts:2873-2897`）。
  没有连续失败熔断，下一回合超阈值还会再试（源码 grep 不到 circuit、consecutive）。
- **防旧 usage 误触发**：刚压缩完，不用压缩前的 usage 再判一次（`agent-session.ts:2618-2627`）。
- **为什么不作基准**：ZCode 的 rapid-refill 加连续失败熔断更完整。

### 7 provider 请求整形与模型规则——次基准

- **compat 开关**：OpenAICompletionsCompat 有二十多个，涵盖 supportsDeveloperRole、supportsReasoningEffort、maxTokensField、requiresReasoningContentOnAssistantMessages、thinkingFormat 等（`ai/src/types.ts:754-812`）。
- **thinkingFormat**：分 zai、qwen、qwen-chat-template、chat-template、baseten、deepseek、openrouter、ant-ling、together、string-thinking 等（`ai/src/api/openai-completions.ts:874-972`）。
- **DeepSeek**：自动打开「每条 assistant 回放 reasoning_content」（`:1380`）。
- **自动识别**：detectCompat 按 provider 名或 baseUrl 识别（`:1586-1690`），model.compat 可以覆盖。
- **换模**：跨模型时思考块降为普通文本，签名只在同一模型时保留（`ai/src/api/transform-messages.ts:92-116`）。
- **落地**：开关与识别表照抄改写，写进 ZCode 形态的声明式规则数据，providers.json 可覆盖；用请求体黄金快照钉住（W4c 已排）。
  复制代码时在 NOTICES §3 登记。

### 8 配置与指令文件——不作基准（反面）

- **加载**：全局一份，再从 cwd 一路到文件系统根，每级找 AGENTS.override.md、AGENTS.md、CLAUDE.md（`coding-agent/src/core/resource-loader.ts:126-211`）。
  只受 noContextFiles 开关控制，不经项目信任（`:572-579`）。官方文档也承认（`docs/security.md:55`）。
- **系统提示**：
  - 分节（preamble、tools、rules、project_context、skills 等），变化写成转录内的分节补丁（`coding-agent/src/core/system-prompt.ts:121-164,204`；`agent-session.ts:1407-1421`）。
  - 模型数据没标支持中途 system 消息的，补丁会折回首条（`ai/src/utils/transcript.ts:108-120`）。折回意味着前缀变了，缓存失效。
  - 这个开关默认 false（`ai/src/types.ts:811-812`；Anthropic 同样默认 false，`ai/src/api/anthropic-messages.ts:217`）。注释说生成目录会给验证过的模型打开，但本提交的生成目录里一个都没开（`ai/src/providers/` 下 grep 零命中），可能靠远端目录下发。
- **DeskMinis 取舍**：发现范围照 OpenCode（不越出项目根），加信任卡；中途 system 消息只对标了支持的端点发，其余用带来源标记的 user 消息，不折回（正文 §4 第 7 条）。

### 9 todo / 计划——明确不作基准

- **没有内置 todo**。
- **示例扩展**：examples/extensions/todo.ts 把清单存进工具结果 details，会话开始或换分支时从当前分支折叠还原（`:1-11,106-133`）。
  这与 9/25「todo 状态必须能从会话历史里折叠还原」一致，可作印证，不作基准。

### 10 多会话与运行态可见性——明确不作基准

- 终端一次只驱动一个会话；switch_session、new_session、fork 都是整体替换 runtime（`coding-agent/src/modes/rpc/rpc-types.ts:27,61-63`）。

### 11 界面状态投影——明确不作基准

- **稳定面**：TUI 直接订阅 AgentSession 事件。
- **实验面**：micro 把界面能看到的东西收成只读的 MicroView，能做的事收成窄的 MicroController，harness、存储、凭据都不越界（`coding-agent/src/experimental/micro/api.ts:58-88`）。
  可作 DeskMinis「渲染端只拿只读视图」的参照，不作基准。

### 12 cowork 能力——明确不作基准

- 没有助手，也没有定时任务（源码 grep 零命中）。

### 13 改动追踪与回退——明确不作基准

- **没有内置检查点**。
- **示例扩展**：git-checkpoint 每回合 git stash create，分叉时可选还原代码（`coding-agent/examples/extensions/git-checkpoint.ts:1-30`）。依赖 git，不借。

### 14 provider 报错分类与上下文溢出恢复——主基准

- **识别**：
  - OVERFLOW_PATTERNS 24 条、NON_OVERFLOW_PATTERNS 3 条（`ai/src/utils/overflow.ts:37-80`）；Cerebras 无 body 的 400/413 单独判（`:64,145-147`）。
  - isContextOverflow 分三种（`:136-170`）：
    - 报错文本命中；
    - stop 但 input 加 cacheRead 超过窗口（静默溢出）；
    - length 且零输出、输入占满窗口 99%。
  - isRecoverableLength：length 截断但输出低于期望上限（`:178-180`）。
- **恢复**：_checkCompaction（`coding-agent/src/core/agent-session.ts:2599-2697`）。
  - 只看同一模型的消息；
  - 溢出或可恢复的截断：先用 _omitRecoveryAttempt 把失败的那次尝试从模型视图持久省略（`:2694-2695`），再压缩并重试；
  - _overflowRecoveryAttempted 只允许一次，第二次如实报错（`:2671-2692`）；
  - 成功但超窗：只压缩、不重试。
- **重试分类**：
  - 溢出先排除（`:3326-3329`）；
  - 配额与账单类不重试（`ai/src/utils/retry.ts:7-25,237-242`）；
  - provider-retry 读 retry-after-ms、retry-after、x-should-retry，超过 60 秒直接失败（`ai/src/utils/provider-retry.ts:1-60`）。
- **与 9/24 对照**：机制属实。9/24 写「约 27 条」，实为 24 加 3，W2a-2 已订正。
- **已借**：两张正则表（W2a-2 `6797eeb`，NOTICES §3）。DeskMinis 当时没搬 Cerebras 专条和按 usage 判的静默溢出。后者等 W5b 有了 usage 锚点再补（正文 §4 第 3 条）。

### 15 模型目录与能力数据——主基准

- **Model 字段**（`ai/src/types.ts:1060-1100`）：
  - reasoning；
  - thinkingLevelMap：统一档位映射到 provider 原生取值，null 表示不支持；
  - promptCache TTL、contextWindow、maxTokens、inputLimits（图片尺寸、每条与每请求图片数、单请求字节）、分层单价。
- **档位**：getSupportedThinkingLevels 只列支持的档，clampThinkingLevel 先向上、再向下就近夹取（`ai/src/models.ts:1209-1240`）。
- **计价**：calculateCost 按输入量切档，1 小时缓存写入按 2 倍 input 计价（`ai/src/models.ts:1187-1207`）。
- **数据**：按 provider 生成（`ai/src/models.generated.ts`，由 `scripts/generate-models.ts` 产出）。
- **落地**：clamp 约 30 行照抄改写，登 NOTICES §3；档位数据放进规则数据；数据来源仍是 models.dev 加内置兜底表（DeskMinis 现状）。

### 16 压缩摘要的生成算法——主基准

- **默认值**：reserveTokens 16384、keepRecentTokens 20000（`coding-agent/src/core/compaction/compaction.ts:144-151`）。
- **切点**：findCutPoint 从尾部累加，够 keepRecentTokens 就停，不切在 toolResult 上（`:453-500`）。
  切在回合中间时，另用 TURN_PREFIX 提示词单独摘这一回合的前缀（`:964`）。
- **增量**：
  - prepareCompaction 从上一个压缩边界之后取材，把上一次摘要作为 previousSummary（`:894-960`）；
  - 放进 previous-summary 标签，用 UPDATE_SUMMARIZATION_PROMPT 合并（`:599-605,740-753`）。
- **拒收**：getSummarizationFailure 对 error 与 length 一律拒收（`:607-617`，基线后的 97fa14e 新增）。
- **请求形态**：摘要请求 cacheRetention 为 none（`:653`）；序列化时工具结果截到 2000 字（`compaction/utils.ts:89,109-144`）。
- **文件清单**：读过与改过的文件从工具参数里抽出，跨多次压缩累积（`compaction/utils.ts:18-89`）。
- **落地**：
  - 提示词改写成中文结构化模板；
  - 切点与文件清单逻辑照抄改写，登 NOTICES §3；
  - 调用模型的那一层用 DeskMinis 自己的 provider（pi 这里走 pi-ai 的 completeSimple，`compaction.ts:26`）。

### 17 上下文水位与用量口径——主基准

- **估算**：
  - calculateContextTokens = input + output + cacheRead + cacheWrite（`coding-agent/src/core/compaction/compaction.ts:162-164`）；
  - 从后往前找最近一条有效 assistant（不是 error、aborted，usage 大于 0），以它为锚，只估算其后的消息（`:166-247`）。
- **压缩之后**：getContextUsage 在拿到压缩后的新回复之前返回 tokens:null，界面显示「?」（`agent-session.ts:3858-3890`）。
- **尾部估算**：用 chars/4（`compaction.ts:333,339`）。DeskMinis 不搬，保留中文 1.6。
- **成本归属**：getUsageCostBreakdown 按 provider 加实际出答的 responseModel 分组（`coding-agent/src/core/usage-totals.ts:37-47`）。9/24 路线 W8 借鉴栏已列，对应 W8c 用量面板。
- **与 9/24 对照**：属实。9/24 已纠正「DeskMinis 没落库 usage」的说法：已落库，缺的是缓存口径，也没用来算水位。本次在 `3a811a1` 上复核仍如此（`minisd/providers/anthropic.ts:198` 只取 input_tokens）。

### 18 会话分叉与对话回退——次基准

- **分叉**：fork(entryId, position)（`coding-agent/src/core/agent-session-runtime.ts:262-351`）。
  - position 为 before 时，目标必须是用户消息：新会话复制到它的父节点，并把这条原文作为 selectedText 返回，界面放回输入框（`:280-287`）；
  - position 为 at 时复制到它本身。
- **树内导航**：在同一文件里移 leaf，离开的分支可以写一条 branch_summary（`session-manager.ts:1572-1620`）。
- **复制表**（实验面）：分叉时每类状态怎么处理有一张闭合表，未知命名空间直接抛错（`agent/src/harness/session/fork-policy.ts:1-67`）。9/24 路线 W8 借鉴栏已列。
- **落地**：
  - 不引入树形存储（路线已定）；
  - 「从某条用户消息重试」借「原文回填草稿」这一点，只借思路，登 NOTICES §5；
  - 复制表自写。

### 19 文件编辑与读取工具——主基准

- **编辑**：
  - 剥 BOM；按首个换行判行尾；old 与 new 都把 CRLF 归一为 LF 后匹配；拒绝空 oldText（`edit-diff.ts:11-25,306-314`）。
  - 在归一后的正文上应用替换，写回时还原行尾与 BOM（`coding-agent/src/core/tools/edit.ts:185-197`）。
- **反面**：模糊匹配第一步做 NFKC（`edit-diff.ts:37`），会把中文全角标点改成半角。DeskMinis 没搬模糊匹配。
- **读取**：offset/limit 按行，默认截到 2000 行或 50KB（`read.ts:16-17,138-161`；`truncate.ts:11-12`）。
  截断时在末尾写「Showing lines a-b of N. Use offset=… to continue.」（`read.ts:169-178`）。
- **同一文件的改写**：按 realpath 串行（`coding-agent/src/core/tools/file-mutation-queue.ts:1-61`）。DeskMinis 读、改、写之间全是同步调用，目前不需要。
- **已借**：编辑文本处理（W1a-2 `95fef05`，NOTICES §3）。
  DeskMinis 的做法与 pi 有意不同：只替换命中区间、不整文件归一；只折叠 CRLF、不动孤立的 CR。
  file_read 的 offset/limit（W1b-2d，按字符而不是按行）是自写的，未登记。

### 20 shell 与子进程管理——主基准

- **杀树**：killProcessTree 在 Windows 用 `%SystemRoot%\System32\taskkill.exe /F /T /PID`，带 windowsHide，吞掉异步 error（`coding-agent/src/utils/shell.ts:216-232`）。
- **登记**：分离的子进程登记在册，退出时统一杀树（`:198-210`）。
- **输出**：OutputAccumulator 流式解码，只留滚动尾部，完整输出超限时写进临时文件，把路径告诉模型（`coding-agent/src/core/tools/output-accumulator.ts:22-40`）。
- **进度**（实验面工具）：AdaptivePublisher 共 87 行（`agent/src/harness/utils/adaptive-publisher.ts`）。
  空闲后第一帧立即发，之后按编码字节数「购买」冷却，默认最小间隔 100ms；另有尾随定时器，保证最后一帧一定发出。
- **已借**：杀树（W1b-1 `f5a68b0`，NOTICES §3）。DeskMinis 比上游多两步：taskkill 失败时兜底杀根进程；根进程已退出就什么都不做。
- **待借**：累积器（W5b）与发布器（W7c，待拍板）。两者都只用 Node 内置模块，照抄改写要各登一行。

### 21 桌面宿主生命周期与崩溃记录——不作基准，只借崩溃记录

- **崩溃记录**：
  - crashes.json 最多 5 条、保留 7 天（`coding-agent/src/core/crash-log.ts:17-18`）；
  - recordCrash 追加并截断（`:123-140`）；
  - takeUnnotifiedCrash 下次启动提示一次（`:146-150`）；
  - 栈里匹配到已加载扩展的路径时指出是哪个扩展（`:70-120`）。DeskMinis 没有扩展，不借这一段。
- **诊断包**：/bug 的脱敏（键名正则、URL 凭据）另在 `coding-agent/src/core/bug-report.ts`。9/24 路线 W6a 已列「导出诊断包」。
- **为什么不作基准**：终端应用，没有单实例、导航守卫、渲染进程恢复这些桌面问题。

## 与 9/24 `pi.md` 的对照小结

- **全部属实**：溢出识别与一次补救、compat 矩阵、编辑稳健性与 NFKC 陷阱、迭代式压缩、usage 水位、断连结算、steer 队列、Windows 杀树、AGENTS.md 不经信任、崩溃记录、截断回合工具不执行、details 字段、faux provider。faux provider 本次没有逐行复核，只确认入口在（`ai/src/compat.ts:162`）。
- **补充**：
  - coding-agent 会话文件在加载旧版本时整文件重写（`session-manager.ts:1085-1094`）；
  - replay 声明只在实验面 harness 用，稳定面工具没有；
  - 编辑预览依赖 npm 的 diff 包（`edit-diff.ts:5`）；
  - 中途 system 消息的开关默认关，本提交的生成目录里没有一个模型打开。
- **修正**：溢出正则是 24 条加 3 条排除，不是「约 27 条」。
