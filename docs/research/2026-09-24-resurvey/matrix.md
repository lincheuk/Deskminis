# 附录 A：跨项目能力矩阵（2026-09-24）

由第二轮四位矩阵核验者产出。每行列出五个参考项目中谁具备该能力、成熟度与证据，并对照 DeskMinis 现状。
价值 1–5；成本 S<1 天、M 1–3 天、L 约一周、XL 需多波。「DM」列：有 / 部分 / 缺 / 坏。
「坏」表示 DeskMinis 有这项能力但实现有缺陷。高价值行的 DeskMinis 证据由核验者亲自读码确认。

## agent 引擎与上下文（30 项）

| 能力 | 几家有 | 新趋势 | DM | 价值 | 成本 | 需新依赖 | 许可路径 |
|---|---|---|---|---|---|---|---|
| 增量、有界的压缩摘要：以上一份摘要为输入、只摘增量、结构化模板、请求角色合法（以 user 结尾、不切断 tool_use/tool_result）、截断或空摘要拒收、失败可见 | 4（pi、DSH、OpenMinis、ZCode） |  | 坏 | 5 | M |  | pi（MIT）的摘要模板、切点算法、文件清单累积可借代码并署名；DSH（MIT）的「平衡区间 + 复用前缀缓存」可借代码；OpenMinis（GPLv3）的压平成文本、二分重试、墙钟上限只借思路；ZCode（Apache-2.0）的阈值常量可借 |
| 上下文溢出识别 → 强制压缩 → 同槽重试一次（不降级、不改绑）；溢出与限流/配额耗尽/Retry-After 分开分类 | 3（pi、DSH、ZCode） |  | 缺 | 5 | M |  | pi（MIT）的 overflow.ts 正则表与排除表可直接移植，保留版权与 MIT 声明；DSH（MIT）的「只重试一次、压缩真前进才重试」语义可借代码；ZCode（Apache-2.0）只借流程 |
| Anthropic 思考参数按模型代际分形（≤4.5 budget_tokens / 4.6+ adaptive+effort / 「关」的写法按代不同），并补 display 与辅助请求的思考预算 | 3（OpenMinis、pi、ZCode） | 是 | 坏 | 5 | M |  | 规则以 Anthropic 官方模型表为准自写；pi（MIT）thinkingLevelMap/clamp 可借代码；ZCode（Apache-2.0）规则数据可借并署名；OpenMinis（GPLv3）只借「resolver 集中 + 快照钉住」思路，且其 5 系规则本身有偏差不能照搬 |
| OpenAI 兼容端点 compat 矩阵：思考参数格式（openai/deepseek/zai/qwen…）、reasoning_content 回放与补空、默认开思考模型显式关闭、<think> 前缀与 reasoning 字段拼写 | 3（pi、OpenMinis、ZCode） |  | 部分 | 5 | M |  | pi（MIT）的 compat 对象与 detectCompat 可借代码并署名；ZCode（Apache-2.0）规则数据可借；OpenMinis（GPLv3）的回传门控与 <think> 状态机只借思路自写 |
| 编辑工具健壮性：切片拼接替换（避开 String.replace 的 $ 序列）、CRLF 归一并按原行尾写回、多段 edits、参数垫片、有限模糊匹配（禁 NFKC）、歧义报错、预览基于执行同款匹配 | 2（pi、ZCode） |  | 坏 | 5 | M |  | pi（MIT）edit 工具的切片拼接、参数垫片可借代码并署名；ZCode（Apache-2.0）的函数式 replacer 与 matcher 分级可借并在 NOTICE 署名；不借 pi 的 NFKC 归一 |
| 对话级回退与分叉：从此删除（后缀截断）、编辑重发、从某条重试、回合边界 fork，并用显式复制表登记每类状态 | 5（pi、DSH、OpenMinis、ZCode、AionUi） |  | 缺 | 4 | M |  | pi（MIT）与 DSH（MIT）的分叉边界判定与复制表可借代码并署名；ZCode（Apache-2.0）不删行回退可借；OpenMinis（GPLv3）后缀截断只借思路 |
| 权限与审批模型演进：会话级档位覆盖、完全权限就地勾选确认、拒绝附文字反馈给模型、可见可删的持久前缀规则、审批结果封闭词汇 fail-closed、切档时追加告知模型、批准后 danger guard 再判、只读判定防同义拼写绕过 | 5（DSH、ZCode、OpenMinis、AionUi、pi） | 是 | 部分 | 4 | L |  | DSH（MIT）审批词汇、guard 分层与提示词可借代码并署名；ZCode（Apache-2.0）判定顺序与规则建议可借；OpenMinis（GPLv3）basename 同规则只借思路 |
| 大结果可取回：file_read 支持 offset/limit 与续读提示、卸载结果豁免取回路径、按工具声明预览方向（shell 取尾、搜索取头）、超长输出落 spill 文件 | 4（pi、DSH、OpenMinis、ZCode） |  | 坏 | 4 | M |  | pi（MIT）与 DSH（MIT）的截断常量、续读提示与累积器可借代码并署名；ZCode（Apache-2.0）的按工具预算可借；OpenMinis（GPLv3）的 next_offset 只借思路 |
| 提示前缀稳定：system 按会话纪元冻结，记忆/日志/技能/助手规则等动态信息改为带来源标记的追加消息；多断点；工具表稳定排序 | 4（DSH、pi、ZCode、OpenMinis） | 是 | 坏 | 4 | M |  | DSH（MIT）与 pi（MIT）的分段/追加策略可借代码并署名；ZCode（Apache-2.0）三段断点可借；Anthropic 的 mid-conversation system messages 属于 API 用法，按官方文档自写 |
| 运行中插话与排队：steer 在工具批次边界注入、followUp 排到下一回合、队列可编辑撤回、停止时回填草稿 | 4（pi、DSH、ZCode、AionUi） |  | 缺 | 4 | M |  | pi（MIT）与 DSH（MIT）的队列语义与注入时机可借代码并署名；ZCode、AionUi（Apache-2.0）只借交互形态 |
| 部分输出与中断的恢复语义：截断（max_tokens）响应中的工具调用一律不执行并告知准确原因、中断占位区分已开始/未开始并给幂等建议、按尾部形态三态 resume、流式中断从锚点重发 | 4（pi、OpenMinis、DSH、ZCode） |  | 部分 | 4 | M |  | pi（MIT）截断处置与 DSH（MIT）CLOSER_TEXT 文案可借代码并署名；OpenMinis（GPLv3）三态 resume 只借思路；ZCode（Apache-2.0）重发锚点思路可借，但不带供应商特例 |
| 执行面硬化：路径围栏用 realpath 防 junction/符号链接逃逸、子进程擦除凭据形态的环境变量、用绝对路径启动 PowerShell 与 taskkill 防工作区同名 exe 劫持 | 4（DSH、pi、OpenMinis、ZCode） | 是 | 缺 | 4 | M |  | DSH（MIT）realpath 判定与 env 擦除可借代码并署名；pi（MIT）绝对路径常量可借；OpenMinis（GPLv3）只借「两侧都解析」思路 |
| 工具取消与进程树回收：shell 超时/停止/dispose 杀整棵进程树（绝对路径 taskkill /T /F），可选 Job 对象收容 | 4（pi、DSH、ZCode、OpenMinis） |  | 部分 | 4 | S |  | pi（MIT）killProcessTree 可借代码并署名；DSH、ZCode 的 Job 对象方案需 FFI（koffi）不借；OpenMinis（GPLv3）只借「收尾一次 + 兜底清扫」思路 |
| 上下文水位以 provider 真实 usage 为锚（含缓存读写口径），只估算其后的增量；无锚时把 system 与工具 schema 计入；压缩后如实显示「未知」 | 3（pi、DSH、ZCode） |  | 部分 | 4 | M |  | pi（MIT）与 DSH（MIT）的估算逻辑可借代码并署名；ZCode（Apache-2.0）的分来源展示只借形态 |
| 上下文削减决定落盘并单调推进（追加式 context_edit / pruned_through / 媒体截止锚点），重试与溢出失败尝试从模型视图持久省略，一次性提醒不随后删除 | 3（pi、DSH、ZCode） | 是 | 部分 | 4 | M |  | pi（MIT）context_edit 投影与 DSH（MIT）决定事件化可借代码并署名；ZCode（Apache-2.0）阈值可借 |
| 数据驱动的模型能力/思考规则表（规则级联、可解释 trace、黄金快照测试）+ 思考档位入口与按模型只列可用档、就近钳制 | 3（OpenMinis、ZCode、pi） | 是 | 部分 | 4 | L |  | ZCode（Apache-2.0）规则数据与冲突检测思路可借并署名，但不引 CEL 求值器，改用声明式 patch 模板自写；pi（MIT）clamp 可借代码；OpenMinis（GPLv3）的 trace 与黄金快照纪律只借思路 |
| Todo 工具与计划条：整表替换、单 in_progress、钉在输入框上方的进度面板、重开会话可恢复 | 3（DSH、ZCode、AionUi） | 是 | 缺 | 4 | M |  | DSH（MIT）tool-todo 可借代码并署名；AionUi（Apache-2.0）计划条尺寸与恢复逻辑可借；ZCode（Apache-2.0）浮窗只借形态 |
| 项目指令文件 AGENTS.md / CLAUDE.md：从 git 根到 cwd 逐级加载、预算与截断规则、作为带来源标记的消息注入、首次加载经信任确认 | 3（DSH、pi、ZCode） |  | 缺 | 4 | M |  | DSH（MIT）加载顺序、预算与转义规则可借代码并署名；pi（MIT）加载链可借但不借「不经信任注入」 |
| 先读后写与过期检测：按会话记录 file_read 的 mtime/size/hash，未读不许 edit，文件在读后被改则拒绝覆盖 | 2（DSH、ZCode） |  | 缺 | 4 | S |  | DSH（MIT）观测策略可借代码并署名；ZCode（Apache-2.0）mtime+size 判据可借 |
| 计划模式：只读硬约束 + exit_plan 提交审阅（复用权限卡）+ 工具目录不随模式增删 | 2（DSH、ZCode） |  | 缺 | 4 | M |  | DSH（MIT）提示词条款（不改文件、口头同意不等于批准、exit_plan 必须唯一且最后）可借并署名；ZCode（Apache-2.0）判定顺序可借 |
| 文件检查点与回滚：写类工具执行前原文落盘、回退前 hash 校验、按回合的改动卡与回滚预览、shell 改动如实标注不可追踪 | 2（ZCode、DSH） | 是 | 缺 | 4 | L |  | ZCode（Apache-2.0）的 artifact 形状与 safe/unsafe 判定可借并署名；DSH（MIT）的 git 私有 index + alternates 技巧可借代码（git 是系统可执行，不算 npm 依赖） |
| 压缩调度与护栏：按 token 预算选切点、以 rapid-refill 与连续失败熔断取代「每轮最多 3 次」、手动压缩（可附焦点说明）与接力到新会话、压缩开始事件与进度/取消 | 4（ZCode、pi、DSH、OpenMinis） |  | 部分 | 3 | M |  | pi（MIT）与 DSH（MIT）的手动压缩与失败码可借代码并署名；ZCode（Apache-2.0）熔断常量可借；OpenMinis（GPLv3）进度与撤销只借思路 |
| 结构化向用户提问 ask_user：一次多题、单选/多选/自由填写，复用权限卡的挂起与应答通道，无人值守立即返回无人应答，子代理禁用 | 4（DSH、ZCode、pi、AionUi） |  | 缺 | 3 | M |  | DSH（MIT）协议与 IME 判断可借代码并署名；ZCode（Apache-2.0）先到先得登记表可借 |
| 工具批次按副作用元数据调度：只读/concurrentSafe 并行，其余作为屏障按原顺序执行；权限按源顺序逐张判定；结果逐个落库；MCP annotations 映射并发与风险 | 3（ZCode、DSH、pi） |  | 部分 | 3 | S |  | DSH（MIT）默认独占策略可借代码并署名；ZCode（Apache-2.0）调度器分组逻辑可借；pi（MIT）按源顺序预检可借 |
| 重复/死循环工具调用检测：规范化参数签名，连续重复时注入提醒（分级可拦截），maxTurns 只作最后兜底 | 3（ZCode、DSH、OpenMinis） |  | 缺 | 3 | S |  | DSH（MIT）与 ZCode（Apache-2.0）阈值与提醒文案可借并署名；OpenMinis（GPLv3）四策略只借思路 |
| 工具执行进度流：流式参数一出现即显示「准备中 N KB」、shell 输出按尾部视图边读边推、自适应限流发布 | 3（DSH、pi、ZCode） | 是 | 缺 | 3 | M |  | pi（MIT）AdaptivePublisher 约 80 行可照抄并署名；DSH（MIT）三阶段语义可借 |
| 生命周期 hooks：PreToolUse/PostToolUse/UserPromptSubmit/Stop，可阻断可改写，安全类 fail-closed，工作区 hook 按声明哈希信任 | 3（ZCode、DSH、pi） |  | 缺 | 3 | L |  | ZCode（Apache-2.0）信任模型可借并署名；DSH（MIT）合并语义可借代码；pi（MIT）事件分类可借 |
| 子代理/任务委派：先只读 Explore 或 one-shot 前台委派，审批钉死 never、禁用提问与计划切换，深度 1、小并发池，结算结果回灌父会话 | 2（DSH、ZCode） | 是 | 缺 | 3 | L |  | DSH（MIT）上限与审批钉死语义可借代码并署名；ZCode（Apache-2.0）工具剔除策略可借 |
| 会话级长程目标（Goal）与空闲自动续跑：独立 verifier、token/轮数预算、恢复或分叉后默认不续跑、需人类直接输入才能创建 | 2（ZCode、DSH） |  | 缺 | 3 | M |  | DSH（MIT）收尾指令与 armed 语义可借代码并署名；ZCode（Apache-2.0）表结构可借，但不借 fail-open |
| OS 级执行沙箱与「沙箱优先 + 按次升级」阶梯（被拒返回统一标记，重试须附理由，后端不可用即失败关闭） | 2（DSH、OpenMinis） | 是 | 缺 | 3 | XL | 是 | DSH（MIT）的升级阶梯词汇与 ACL 方案可借代码并署名，但其 Windows 实现依赖 koffi（新 npm 依赖，违反红线）；OpenMinis（GPLv3）只借「分发点与判定同规则」思路 |

### 本簇跨项目观察

- 「前缀只追加」已从缓存优化变成硬约束：DSH 把系统提示做成 surface 节点 0、动态上下文作为 user 快照追加、剪枝/图片卸载决定事件化后一直沿用；pi 0.86 转录内系统消息、0.87 追加式 context_edit；ZCode system 三段断点、microcompact 越线一次性清理。API 侧同步收紧：claude-api 技能记载 Fable 5.1 / Opus 5.5 对 2026-08-31 起的新账号强制 preserved-thinking 前缀校验，system、tools、之前任一消息变化即令回放的 thinking 块 400。DeskMinis「raw 永不改写、请求侧合成」的理念正确，但每步重建 system、prune 12 条滑窗、媒体 2 轮滑窗、请求侧注入后又消失的提醒，恰好都是反面，需要作为一个整体改。
- 溢出 → 强制压缩 → 同槽只重试一次、不降级，是 pi、DSH、ZCode 三家同构的做法，且都把溢出与限流、配额耗尽、Retry-After 分开分类。DeskMinis 把 400 一律当可降级并改绑会话，是本簇最直接的「界面撒谎」来源（报「所有模型均不可用」，实为上下文满）。
- 压缩收敛到四要素：增量（带上一份摘要）、输入有界、结构化模板、截断或空摘要拒收且失败可见。pi、DSH、OpenMinis、ZCode 四家都具备，DeskMinis 四项全缺，还多一处 prefill 400 与空摘要写 marker。溢出重试依赖压缩修好，压缩触发依赖真实 usage 水位，三者必须同一波落地，分开做会互相掩盖。
- Provider 兼容走向数据驱动 + 快照测试：OpenMinis Thinking Rules（trace + 黄金快照 + 用户规则）、ZCode 规则级联生成 merge patch、pi compat 矩阵 + detectCompat。三家的共同纪律是改请求体前先冻结字节级快照。DeskMinis 仍在各 provider 里写分支，思考参数停在 budget_tokens 时代，且无界面入口。
- 工具调度转向副作用元数据：ZCode、DSH、pi 默认独占、声明只读才并行，未知一律按独占；ZCode 还把 MCP annotations 用于并发与风险。DeskMinis 全批并发的实际危害已被复核降级，但加元数据是后续做先读后写、检查点、计划模式硬约束、子代理只读白名单的共同地基。
- 「人在回路」的结构化通道普遍化：运行中插话/排队 4 家（pi、DSH、ZCode、AionUi），ask_user 4 家，Todo/计划条 3 家，计划模式 2 家，会话级档位与等待态可见性多家都在做，而且都复用权限卡的挂起与应答通道。DeskMinis 是五家里唯一在运行中锁住输入框的，这是体验差距最大、成本却只有 M 的一项。
- 对话级回退/分叉五家全有（DeskMinis 是唯一缺的）；文件级检查点只有 ZCode 与 DSH 做了，但都指向「写前留底 + 回退前校验 + shell 改动如实标不可追踪」。对 cowork（改用户的 Office 与文档）而言，撤销比再加一个工具更有价值。
- 子代理的共同纪律来自事故：DSH 与 ZCode 都把子代理审批钉死为 never、禁用提问与计划切换（子代理没有审批恢复面会卡住父回合），DSH 在 9 月内把并发上限从 16 收到 8、深度收到 1。若 DeskMinis 做，直接从「只读、深度 1、小池」起步，并先补消息来源标注。
- 反面做法要警惕：pi 的 AGENTS.md 不经信任就注入（docs/security.md:55 自认）；pi 模糊匹配首步 NFKC 会悄改中文全角标点；ZCode Goal verifier 在坏 JSON、请求失败、试图调工具时都 fail-open 判通过，事件却标 failed_closed；ZCode code-mode 的 restrictProcess 泄露完整 process.env 并非沙箱；ZCode CLI 非交互默认 yolo、供应商忙碌码硬编码进 core；DSH 的 session-log-deepseek 默认把完整会话日志附在请求里外发；DSH Windows 沙箱靠 koffi（零依赖红线外）；DSH maxConsecutiveWakes 无默认值（作业完成唤醒可自激）；DSH 计划模式只是软约束；OpenMinis 用进程全局补丁标志传思考意图导致跨请求串扰。
- 本簇几乎全部机制都能零依赖实现（唯一例外是 OS 级沙箱的参考实现依赖 FFI），且 DeskMinis 引擎体量小（loop.ts 594 行、compact.ts 138 行、各 provider 130–200 行）。结论倾向「定向革新引擎层」：把溢出/压缩/水位/前缀稳定/思考形状作为一波成批重写并配请求体快照与假端点测试，而不是继续点状修补；UI 骨架不必动。
- AionUi 的 agent 引擎在 aioncore（Rust，本仓不可见），本簇对它只能从界面层（计划条、等待态、草稿箱、待确认通知）取证，证据权重应低于其余四家；OpenMinis 是 GPLv3，所有借鉴只能是思路。

### 对 DeskMinis 现状说法的纠正

- deskminis-state.md 把「上下文管理（压缩 / 卸载 / 修剪）」标为 [solid] 不成立：压缩取材无界且以 assistant 结尾（compact.ts:62/67、tests/compact.test.ts:92），卸载桩的取回路径自相矛盾（offload.ts:233 + loop.ts:558），修剪桩指向不存在的文件（见下条），应降为 broken。同理「多 Provider 接入 … 会走提示缓存」也应注明 system 每步重建使缓存频繁失效。
- 新发现（context.md #12 的同类第二处）：agent/prune.ts:275 修剪桩写「完整内容通常在 /var/minis/offloads/ 对应文件中」，但修剪阈值 minChars=2000（:262）远低于卸载阈值 20000（offload.ts:204）；被修剪的恰好是 2K–20K 的结果，它们从未写过 offload 文件，桩对模型撒谎。
- context.md #5 需补一条更严重的分支：compact.ts:97 `summary || '[摘要为空]'` 在摘要为空时照样写 marker，之后 buildEffectiveHistory 会把锚点前全部历史替换成「[对话摘要] [摘要为空]」；又不检查 stopReason，截断的摘要也照收。在 Claude 5 家族省略 thinking 即 adaptive 的情况下，maxTokens 1024（compact.ts:92）可能被思考耗尽，这条路径会静默抹掉上下文，而不只是「压缩静默失效」。这是按代码与官方模型表的推断，需在假端点验证。
- context.md #9「渲染层从不传 thinkingLevel，原生思考恒为 off」在 Claude 5 家族上不成立：claude-api 技能核实，省略 thinking 字段时 Opus 5、Sonnet 5、Fable 5/5.1、Opus 5.5 默认 adaptive 思考（只有 Opus 4.7/4.8 省略即不思考），且 display 默认 omitted，思考块文本为空。实际是「在付思考的钱、界面看不到」；auto-title.ts:24 的 maxTokens 64 同样可能被思考吃光。另外 budget_tokens 被 400 拒收的范围是 Opus 4.7/4.8/5、Sonnet 5、Fable 5/5.1、Opus 5.5（4.6 仅弃用）。
- context.md #13 的严重度可能被低估：Fable 5.1 / Opus 5.5 对 2026-08-31 起新建的账号强制 preserved-thinking 前缀校验。DeskMinis 在这些模型上会收到带签名的 thinking 块，loop.ts:474 落库、anthropic.ts:86 回放；此后回合内 system 重建（记忆日志、助手规则）、prune 与媒体占位改写更早消息、请求侧注入后又消失的 CONTINUE_HINT/EMPTY_RESPONSE_REMINDER、会话级禁用 MCP 改工具表，都可能从「缓存失效」升级为 400，而 400 又被 types.ts:27 当作可降级错误触发改绑。取决于账号创建时间与所选模型，需真机或 prefix_mismatch_behavior 测试确认。
- pi.md 说 DeskMinis file_edit「没有 BOM 处理」不构成缺陷：readFileSync(abs,'utf8') 不剥 U+FEFF，替换后原样写回，BOM 实际被保留。真实缺陷只有 $ 替换序列（files.ts:123）与 CRLF 不归一（CRLF 文件配 LF 的 old_string 报「未找到」）。
- context.md #2 复核修正的补充：file_write/file_edit/office_write 写工作区内路径时根本不过权限网关（files.ts:27-32 guardWrite 只对数据根与绑定工作区之外的路径调用 check），所以「同批多张权限卡同时弹出」只发生在工作区外写入与 gated shell/web/MCP 上；pi.md 所说「注定失败的编辑也会先请用户批准」同样只对工作区外路径成立。
- 缓存口径缺失不止 Anthropic 一路：providers/openai.ts:107 也只取 prompt_tokens/completion_tokens，不读 prompt_tokens_details.cached_tokens；而 loop.ts:66-77 toAgentMessages 与 compact.ts buildEffectiveHistory 只保留 {role, parts}，已落库的 reasoningContent 在回放路径上根本不存在，OpenAI 兼容端点的 reasoning_content 回放缺口是结构性的，不是 buildOpenAIBody 少写一个字段。

### 逐行证据与备注

**增量、有界的压缩摘要：以上一份摘要为输入、只摘增量、结构化模板、请求角色合法（以 user 结尾、不切断 tool_use/tool_result）、截断或空摘要拒收、失败可见**

- pi（shipped）：coding-agent/src/core/compaction/compaction.ts：从上次压缩边界取材，previousSummary 放进 <previous-summary> 用 UPDATE_SUMMARIZATION_PROMPT 合并；Done/In Progress/Blocked/Next Steps 模板；findCutPoint 按 keepRecentTokens=20000 选切点、不在 toolResult 处切；97fa14e 拒收以 length 结束的摘要；摘要请求不带工具
- DSH（shipped）：compaction-basic 只摘当前 surface 最旧的平衡区间（已含上次摘要），原样重放 system 节点 0 与上次 tools，压缩指令放最后，只有指令与输出不命中缓存；compaction/start…end 日志括号加锁
- OpenMinis（shipped）：buildConversationTextForSummary 压平成文本（工具结果截 500 字）+ Previous summary/New conversation 增量合并；v1.12 起除网络/取消外任意失败二分重试并拼接；Android 单次压缩 ≤6 次调用、90–300s 墙钟；walkBackUserTurnsBounded 切点不落在 tool_result 上
- ZCode（shipped）：分层管线：microcompact（阈值 90%）→ 自动压缩（窗口−min(maxOutput,21K)−13K）→ 超窗反应式压缩；连续失败 circuit_breaker；压缩后重注入最近读过的 ≤5 个文件
- DeskMinis：亲自读码：agent/loop.ts:328 summarize(history,…) 传的是原始全量 history；compact.ts:62/67 toSummarize=history.slice(0,anchor+1) 每次从 history[0] 起、不读已有 marker；:91-92 systemPrompt 换成「你是对话摘要助手。」、tools:[]、maxTokens:1024，:73 要求「不超过 500 字」；:97 `summary || '[摘要为空]'` 空摘要照样写 marker；不检查 stopReason；loop.ts:340 catch{} 吞掉失败；tests/compact.test.ts:92 钉死摘要请求角色序列 [user,user,assistant]，以 assistant 结尾，claude-api 技能确认 Opus 4.6/4.7/4.8/5/5.5、Sonnet 4.6/5、Fable 上 prefill 一律 400；compact.ts:65 消息数锚点取 length−15，可能落在带 toolUse 的 assistant 上，且摘要请求不经 pairToolResults。对应 context.md #5。
- 备注：两条路线二选一要在设计稿里定：OpenMinis 式压平成单条 user 文本，一次消掉 prefill 和配对两类 400，实现最简；DSH 式沿用会话 system+tools 并把指令追加在最后，能吃到前缀缓存，但要自己保证角色与配对合法。无论哪条都要：取材改为「上一份摘要 + 锚点之后的增量」、maxTokens 提到 4–8K、finish=length 或空文本视为失败且不写 marker、失败发 eventNote。红测：已有 marker 且 raw≈2 倍窗口时第二次摘要请求估算不超窗；Anthropic 形态下摘要请求最后一条是 user；空摘要不写 marker。

**上下文溢出识别 → 强制压缩 → 同槽重试一次（不降级、不改绑）；溢出与限流/配额耗尽/Retry-After 分开分类**

- pi（shipped）：packages/ai/src/utils/overflow.ts 约 27 条 OVERFLOW_PATTERNS + NON_OVERFLOW_PATTERNS（排除 rate limit/Throttling），另识别 stop 但 input+cacheRead 超窗的静默溢出；coding-agent _checkCompaction + _overflowRecoveryAttempted 只重试一次；0.87 起用 context_edit 持久省略失败尝试；provider-retry 读 retry-after，超 60s 直接失败
- DSH（shipped）：packages/llm/llm/src/error.ts isContextWindowExceededError；compaction/compaction-basic 监听 agent/request-error，绕过阈值做一次最大化平衡裁剪，replaceGeneration 前进才 retry，maxOverflowRetries 默认 1；isQuotaExceededError 把 insufficient_quota 作终态
- ZCode（shipped）：recoverModelStepAfterContextExceeded 超窗反应式压缩后重跑该 model step（zcode.md 分层压缩条）
- DeskMinis：亲自读码：providers/types.ts:27 把 400/401/403/404/422/429 一律标 fallbackable；agent/loop.ts:429-431 fallbackable 直接跳出重试梯去降级，:459 链耗尽报「所有模型均不可用」；minisd/index.ts:724-739 降级后在 turnEnd 把会话改绑到接手模型；minisd 全树无任何 context_length/prompt too long 识别。对应 context.md #11。
- 备注：在 ProviderError 构造处先判溢出（contextOverflow=true 且 fallbackable=false），再判限流/配额；命中后绕过 loop.ts:321 的 compactCount<3 和 compact.ts:63 的「≥30 条」门槛强制压缩一次，同 slot 重试，仍溢出给中文专门提示。强依赖第 2 行（压缩本身先修好），否则强制压缩也会失败。TDD 红测：FakeProvider 抛 400「prompt is too long」/context_length_exceeded，断言出现 compacted、无 fallback、无改绑；再补国内厂商真实报错样本。

**Anthropic 思考参数按模型代际分形（≤4.5 budget_tokens / 4.6+ adaptive+effort / 「关」的写法按代不同），并补 display 与辅助请求的思考预算**

- OpenMinis（shipped）：ThinkingRuleResolver.anthropicThinkingShape：4.6+ 发 effort(adaptive)、≤4.5 发 budget；v1.13（T-ios-claude5-thinking-disabled-400）Claude 5+ 关闭时不再发 disabled；核验指出其 5 系规则比官方粗，Sonnet 5/Opus 5 的「关」实际变成 adaptive
- pi（shipped）：packages/ai/src/models.ts：Model.thinkingLevelMap 把 off..max 映射到原生取值，null 表示不支持；clampThinkingLevel 就近夹取
- ZCode（shipped）：config/provider/zcode-builtin.json 的 modelRules 用 reasoningLevel map（受限 CEL）生成请求体 JSON merge patch
- DeskMinis：亲自读码：providers/anthropic.ts:6 BUDGETS、:45 思考开启时只会发 {type:'enabled',budget_tokens}；:109 anthropic-version 2023-06-01；renderer/ 与 minisd/cron 全树 grep thinkingLevel 零命中，loop.ts:245 默认 off，anthropic.ts:35 off 时省略 thinking 字段。claude-api 技能核实：budget_tokens 在 Opus 4.7/4.8/5、Sonnet 5、Fable 5/5.1、Opus 5.5 返回 400；省略 thinking 时 Opus 5/Sonnet 5/Fable/Opus 5.5 默认 adaptive 思考（Opus 4.7/4.8 才不思考），display 默认 omitted 即思考文本为空；Fable 与 Opus 5.5 显式 disabled 400，Opus 5 只在 effort≤high 接受 disabled。auto-title.ts:24 maxTokens 64、compact.ts:92 maxTokens 1024 在 5 系缺省 adaptive 下可能被思考吃光。对应 context.md #9。
- 备注：写纯函数 anthropicThinkingShape(modelId, level) → {thinking?, output_config.effort?}，逐代建表并用请求体快照测试钉住；开思考时带 display:'summarized'，否则 README「思考过程可见」在 5 系上照样不成立；auto-title 与压缩这类辅助请求在 5 系上要显式压低 effort 或放宽 maxTokens。先红测再在 Composer 开放档位（见第 10 行）。

**OpenAI 兼容端点 compat 矩阵：思考参数格式（openai/deepseek/zai/qwen…）、reasoning_content 回放与补空、默认开思考模型显式关闭、<think> 前缀与 reasoning 字段拼写**

- pi（shipped）：packages/ai/src/api/openai-completions.ts OpenAICompletionsCompat 二十多个开关（thinkingFormat、requiresReasoningContentOnAssistantMessages、maxTokensField、supportsDeveloperRole…），detectCompat 按 baseUrl 识别 deepseek.com/api.z.ai/moonshot 等，DeepSeek 回放时缺字段补空串
- OpenMinis（shipped）：已捕获的 reasoning_content 存在即回传（含空串），补空占位受门控，v1.13 对 Mistral 两路都禁止（否则 422）；deepseek-v4 关闭档显式发根级 thinking:{type:disabled}（注释记录现场 400）；ThinkPrefixStreamParser 状态机拆 <think> 前缀，同时读 reasoning/reasoning_content
- ZCode（shipped）：modelApiRules 72 / providerSiteRules 52 条规则按 API 类型与站点生成请求体 merge patch
- DeskMinis：亲自读码：providers/openai.ts:28 assistant 消息只带 content 与 tool_calls，不回放 reasoning_content——虽然 loop.ts:526 已把 reasoningContent 落库，但 loop.ts:66-77 toAgentMessages 与 compact.ts:105-114 buildEffectiveHistory 只留 {role, parts}，回放路径上根本没有它；openai.ts:71 只发平铺 reasoning_effort，关闭档从不显式关；:115 只读 delta.reasoning_content，不读 delta.reasoning、不拆 <think>；:12-17 OpenAICompatFlags 只有两个布尔；model-catalog.ts:132 内置表把 ^deepseek-v 判 thinking:false，clampThinkingLevel（:345-348）会把档位钳到 off。对应 context.md #9 后半。
- 备注：AgentMessage 增加 reasoningContent 字段贯穿 buildEffectiveHistory → buildOpenAIBody；按 compat 决定回放/补空/禁止；deepseek-v4 这类默认思考的模型关闭档显式发关闭字段。用 mock-openai 端点对 deepseek/zai/qwen/mistral 做请求体快照测试，覆盖「多轮工具调用 + 关闭档」这个 OpenMinis 实测 400 的形态。

**编辑工具健壮性：切片拼接替换（避开 String.replace 的 $ 序列）、CRLF 归一并按原行尾写回、多段 edits、参数垫片、有限模糊匹配（禁 NFKC）、歧义报错、预览基于执行同款匹配**

- pi（shipped）：coding-agent/src/core/tools/edit.ts：edits[] 多段、逆序 substring 切片拼接、检测重叠与唯一性，剥 BOM/CRLF→LF 匹配后还原；prepareEditArguments 兼容 edits 发成字符串/单对象/顶层字段；computeEditsDiff 预览与执行同逻辑。反面：normalizeForFuzzyMatch 首步 NFKC 会把「，（）：　」改成半角
- ZCode（shipped）：apps/zcode-cli/packages/core/src/tool/handlers/edit.ts：content.replace(search, () => replacement) 注释点名避开 $$/$&；edit-matchers 8 级匹配、多处命中报 ambiguous；detectLineEndings 保持 CRLF/LF；expectedRevision
- DeskMinis：亲自读码：tools/files.ts:123 writeFileSync(abs, content.replace(oldStr, newStr)) 用字符串形式替换，new_string 中的 $$、$&、$' 会被解释（context.md #1）；:120 用 split 计数、不做 CRLF 归一，CRLF 文件配 LF 的 old_string 直接报「未找到」；:100-105 只支持单段；:111-114 权限预览只带 old/new_string，无行号上下文。另：files.ts:28 guardWrite 对工作区内路径不过网关，所以「注定失败的编辑先弹卡」只在工作区外发生。
- 备注：分两步：第一步（S，半天）只修 $ 缺陷与 CRLF：indexOf+slice 拼接，CRLF→LF 匹配后按原行尾写回，红测覆盖 $$、$&、$'、CRLF 文件；第二步（M）加 edits 数组与参数垫片，模糊匹配只做去行尾空白、统一智能引号/破折号/NBSP 四件事，歧义一律报错，绝不做 NFKC 或 U+3000 归一（会悄改中文全角标点）。

**对话级回退与分叉：从此删除（后缀截断）、编辑重发、从某条重试、回合边界 fork，并用显式复制表登记每类状态**

- pi（shipped）：会话条目 id/parentId 树，/tree /fork /clone，RPC fork/clone/get_tree；0.85.0 修分叉丢压缩边界；harness fork-policy.ts（09-01，实验面）闭合投影表，未知命名空间直接抛错
- DSH（shipped）：SessionStore.fork(source, boundary) 要求前缀在回合外结束，buildForkSeed 为未闭合尾部补 forked 合成结果；客户端已完成回合页脚分叉按钮
- OpenMinis（shipped）：Edit/Retry/Delete From Here（v1.13 后缀截断，锚定用户气泡防孤立 tool_use）/Compact Above/撤销压缩=删最新 marker；SessionForkManager 深拷贝并重映射 compact marker
- ZCode（shipped）：session.revert 记录 branchCutAfterMessageID 与 keptMessageIDs，不删行；队列通知带 branchGeneration，回退后作废
- AionUi（partial）：common/chat/forkConversation.ts 按 agent 声明的 fork capability 显示入口（基线已有，未深读）
- DeskMinis：亲自 grep：minisd/index.ts 的 chat.* 方法只有 annotations.*/cancel/contextInfo/messages.list/prompt/sessions.{create,delete,list,rename,setMcpDisabled,setMemoryEnabled,setModelBinding}，无 truncate/fork/retryFrom/compactBefore；deskminis-state「会话分叉 / 回退 / 撤销 [missing]」。
- 备注：五家都有，DeskMinis 是唯一缺的。先做 chat.messages.truncateFrom（只允许后缀截断、锚定用户消息）与 retryFrom，红测不变量「截断后无孤立 tool_use」；fork 放第二步：sessions 追加 parent_session_id/forked_from_message_id，写显式复制表（compact marker 仅在锚点早于分叉点时复制、注释随消息复制、运行态与待批权限重置、origin_device_id 重生成），未登记列在测试里报错。与 Fable 5.1/Opus 5.5 的 preserved thinking 兼容：截断是删尾部，合法。

**权限与审批模型演进：会话级档位覆盖、完全权限就地勾选确认、拒绝附文字反馈给模型、可见可删的持久前缀规则、审批结果封闭词汇 fail-closed、切档时追加告知模型、批准后 danger guard 再判、只读判定防同义拼写绕过**

- DSH（shipped）：预设 = 沙箱模式×审批策略，设置页只改「新会话默认」，输入区控件只切当前会话；完全权限需勾选 RiskConfirmation；审批结果只有 allowed-once/rejected/cancelled/unavailable，无应答者归 unavailable；setPolicy 以 agent.inject 追加告知；pre-execute 瀑布 → 审批 → 同步 guard 单调不可推翻；实验 Auto review（09-09）三级 JSON 失败关闭
- ZCode（shipped）：PermissionService 固定判定顺序，alwaysAsk 不可被模式放行；前缀/通配持久规则，按命令族深度给 ≤5 条建议；拒绝时 freeText 反馈升级为用户反馈；数字键 1/2/3 直选
- OpenMinis（shipped）：GH#242 权限判定改按 basename 与分发同规则，防绝对路径绕过；minis-config ConfigRisk 三级 + 120s 确认闸 + 审计
- AionUi（partial）：审批由引擎发帧；v2.2.1 侧栏「等待你」状态（permission/acp_permission/ask 推出待确认集合）与桌面待确认通知按 conversation_id+msg_id 去重
- pi（partial）：无内置权限系统，靠扩展 tool_call 事件 block；项目信任只覆盖 .pi 下资源
- DeskMinis：亲自读码：tools/permissions.ts:265-285 applyPreset 改的是全局 levels，无会话级覆盖；:250/:314 sessionGrants 按 (sessionId,kind,精确 detail) 内存记忆，无持久规则；:332 90 秒超时自动 deny；tools/types.ts:148 PermissionDecision 只有 allow/deny，拒绝不带反馈；:220 danger 在 full 档也 notAllowed 且无删文件工具；切档不告知模型；tools/files.ts:28 工作区内写入完全不过网关。
- 备注：建议拆两波：M 波先做会话级覆盖（sessions 追加 perm_override）、full 档就地确认、permission.respond 可选 feedback 写进 tool_result、切档与 cron 开跑时追加告知消息、批准后 danger 再判守卫；L 波再做持久前缀规则（设置页可见可删，PowerShell 命令族深度手写小表，不引 fig）。补一组同义拼写红测（绝对路径 git.exe、.\git、cmd /c、pwsh -c、Invoke-Expression 不得进免批）。自动审查档只给无人值守、默认关。

**大结果可取回：file_read 支持 offset/limit 与续读提示、卸载结果豁免取回路径、按工具声明预览方向（shell 取尾、搜索取头）、超长输出落 spill 文件**

- pi（shipped）：read 工具 offset/limit，默认截到 2000 行或 50KB，末尾写「Use offset=b+1 to continue」；bash 用 OutputAccumulator 只留滚动尾部，超限写临时文件并告知路径
- DSH（shipped）：spill-policy 超大结果换成头尾预览（各半预算）+ 文件路径，提示用 read 的 offset/limit 或 grep；read 自身结果不受 spill；spill-local 文件 0600、随机前缀、按保留期清理
- OpenMinis（shipped）：file_read 截断时回退到最后完整行并给 next_offset（Android b4d7ff5、iOS v1.13）；file_write 描述要求大内容分块 append
- ZCode（shipped）：工具声明 resultBudget：Bash maxModelBytes 30K 取尾预览，Grep 取头
- DeskMinis：亲自读码：agent/offload.ts:204 THRESHOLD=20000，:233 桩写「使用 file_read 工具读取 /var/minis/offloads/<id>.txt」、摘录只取开头 200 字；tools/files.ts:54 file_read 只有 path 参数，:66 超 1MB 拒绝、:67 整文件读；agent/loop.ts:558 对所有工具结果（含 file_read）无条件 shouldOffload，读回的全文再次被换成桩（context.md #12）。新发现：agent/prune.ts:275 修剪桩写「完整内容通常在 /var/minis/offloads/ 对应文件中」，但修剪阈值 minChars=2000（:262）远低于卸载阈值 20000，被修剪的 2K–20K 结果从未落 offload 文件，桩指向的文件不存在。
- 备注：file_read 加 offset/limit（行号从 1 起）并在截断时写「显示第 a-b 行，共 N 行，续读请用 offset=b+1」；loop 对 offloads 桶内的 file_read 豁免卸载；桩改头尾各约 1K 并给行数；shell_execute 结果改取尾（PowerShell 报错多在尾部）；修正 prune 桩文案或让被修剪的结果也落文件。红测：卸载后用 file_read 读同一路径，结果不能又是桩。

**提示前缀稳定：system 按会话纪元冻结，记忆/日志/技能/助手规则等动态信息改为带来源标记的追加消息；多断点；工具表稳定排序**

- DSH（shipped）：系统提示成为 surface 节点 0（09-02），只在文本真变化时替换；动态段 PromptContext 由 RuntimeContextProjection 作为 user 快照追加，内容相同不追加、清空写 CLEARED、被压缩掉后重注入
- pi（shipped）：0.86.0（9e05370）转录内系统消息：sections 分节补丁与 toolsAdded/toolsRemoved 写进对话；coding-agent/src/core/system-prompt.ts diffSystemPromptSections；只有目录验证过的模型按位置发送，其余 collapseSystemMessages 折叠回首条
- ZCode（shipped）：ContextBuilder 把 system 拆 cli_prefix/stable/dynamic 三块各打 ephemeral 断点；记忆抽取 sidecar 在主会话 providerEntries 后追加一条 prompt 复用前缀（反例：Goal verifier 传 tools:[] 破坏工具前缀）
- OpenMinis（partial）：只做了端点侧补漏：prompt_cache_key 限官方 OpenAI、OpenRouter 的 anthropic/* 发顶层 cache_control（GH#191）
- DeskMinis：亲自读码：minisd/index.ts:657-668 promptFactory 在每个 step 重建 system：memoryInjector.build 注入最近日志（store/memory-injector.ts:49-51），而 memory_write 正往当日日志追加；buildSkillsBlock 带 skillStore.nowEpoch()（skills/prompt.ts:33-51，>20 个技能时按时间与 use_count 分级，file_read SKILL.md 即 bumpUseCount）；buildAssistantBlock 每轮实时读表；providers/anthropic.ts:34 system 单块单断点。claude-api 技能核实：Fable 5.1 / Opus 5.5 对 2026-08-31 起新建账号强制 preserved-thinking 前缀校验，system、tools、之前每条消息须字节不变，否则回放的 thinking 块 400；DeskMinis 在 off 档省略 thinking 时这些模型照样 adaptive 思考并回传带签名的块，loop.ts:474 落库、anthropic.ts:86 回放。对应 context.md #13，但严重度可能不止缓存失效。
- 备注：system 只在新建会话、改助手规则或技能启停、切换模型时重算；记忆/日志变化在回合开始时追加一条带来源标记的 user 消息（哈希未变就跳过）；技能块用稳定键排序；工具按名排序，会话级禁用 MCP 不删工具而是拒绝调用。不变量测试：同一回合内连续两次调用 promptFactory 字节相等。上线前用 cache_read_input_tokens 验收，并在假端点上用 prefix_mismatch_behavior 模拟 preserved-thinking 校验。

**运行中插话与排队：steer 在工具批次边界注入、followUp 排到下一回合、队列可编辑撤回、停止时回填草稿**

- pi（shipped）：Agent.steer()/followUp() 双队列（one-at-a-time 或 all）；steer 在当前工具批次完成后、下次请求前注入；RPC steer/follow_up/set_steering_mode，clear_queue 为 0.84.4 新增；interactive-mode.ts restoreQueuedMessagesToEditor 中止时回填
- DSH（shipped）：Agent.send 统一投递 followup/steer/inject；持久 inbox.ts（08-27）以 agent/inbox/spliced 事件落日志冷启动可重建；客户端运行中不锁输入、QueueDock 可编辑/删除/转插话
- ZCode（shipped）：guide（合法 model-step 边界、每次一条）与 queue；runtime 命令队列 now/next/later；队列面板可编辑撤回、拖拽排序；会话级草稿存 localStorage
- AionUi（shipped）：渲染层 CommandQueuePanel 草稿箱：立即发送（打断插队）/编辑/删除/拖拽排序，auto/manual 两模式（基线已有）
- DeskMinis：亲自读码：minisd/index.ts:599 inFlight 时 chat.prompt 直接抛「该会话正在运行中，请等待完成或取消」；renderer/src/ui/Composer.vue:33 canSend 含 !chat.running；agent/loop.ts 在工具结果落库（:567）与下一次请求构建之间没有任何注入点。
- 备注：五家里 DeskMinis 是唯一锁输入框的。先做 queue（minisd 按会话持有 FIFO，turnEnd 后自动开下一轮，Composer 上方显示可撤回芯片，停止时回填 chat.draft），再做 steer：在工具结果落库后、下一次请求前作为 user 消息插入，写守卫「不落在 tool_use 与 tool_result 之间」。附件、@路径、会话级 MCP 禁用等发送字段必须完整穿过入队出队（AionUi 的 @@ 在三个入队点被丢的教训）。

**部分输出与中断的恢复语义：截断（max_tokens）响应中的工具调用一律不执行并告知准确原因、中断占位区分已开始/未开始并给幂等建议、按尾部形态三态 resume、流式中断从锚点重发**

- pi（shipped）：packages/agent/src/agent-loop.ts failToolCallsFromTruncatedMessage：stopReason=length 时本条所有工具调用返回「Re-issue the tool call with complete arguments」；耐久 harness（实验面）意图/结算两段提交、replay:safe|never、INTERRUPTION_MARKER
- OpenMinis（shipped）：#119（v1.12）被截断修复过的 file_write/file_edit 拒绝执行并写明「未执行、文件未改动、请分块」；retry/resume/未获回复的用户尾三态（v1.13 GH#262/263 resumeUnansweredUserTurn）
- DSH（shipped）：packages/core/session/src/repair.ts CLOSER_TEXT：已开始的写「结果未知；只读或幂等才可重试；先核实外部状态」，未开始的写「如仍需要可以重试」
- ZCode（shipped）：runtime/methods/streaming-recovery.ts STREAM_RECOVERY_MAX_RETRIES=10，从已提交锚点重发并发 StreamRecovery* 事件（反面：同文件硬编码供应商忙碌码）
- DeskMinis：亲自读码：agent/loop.ts:532-550 只在无工具调用时看 stopReason==='maxTokens'（续写），有调用时照常执行；:231-237 safeToolInput 把非法 JSON 落成 '{}'，tools/registry.ts:196-197 报「缺少必填参数」——安全但原因错误；loop.ts:210 pairToolResults 只补「[工具执行被中断，结果未知]」，无重试建议；工具开始不持久化、结果在 :567 整批落库，分不清已开始/未开始；chat.* RPC 方法表无 resume/retry；renderer stores/chat.ts:618 retryLast 把最后一条用户文本再发一次，会重复用户回合。已有 loop.ts:289 cancelWithPartialReply 落半截文本。
- 备注：最便宜的两刀先做（各 S）：maxTokens 且有调用时统一合成「参数在输出上限处被截断，未执行，文件未改动；请分块写或用脚本生成」；占位文案换成带幂等建议的中文版。再做 chat.resume(sessionId) 按尾部形态三分，合成提示只在请求侧、不新写用户消息，渲染端给持久「继续」按钮（不依赖内存 eventNotes）。逐个落库工具结果后才能区分已开始/未开始。

**执行面硬化：路径围栏用 realpath 防 junction/符号链接逃逸、子进程擦除凭据形态的环境变量、用绝对路径启动 PowerShell 与 taskkill 防工作区同名 exe 劫持**

- DSH（shipped）：packages/sandbox/sandbox/src/roots.ts 与 sandbox-windows-acl/src/path-boundary.ts：writableRoots 统一 realpathSync.native，syscall 前再判；scrubbedParentEnv 丢弃 /KEY|PASSWORD|SECRET|TOKEN/i 与 DSH_*，再叠加显式 env，PTC 只留白名单
- pi（shipped）：taskkill 改从 %SystemRoot%\System32 取绝对路径（注释 trusted System32 executable，基线后）；PowerShell 经 where 解析（where 自身仍搜 cwd，并非完全安全）
- OpenMinis（shipped）：备份恢复每类 containmentRoot，两侧都 resolvingSymlinksInPath，前缀比较要求末尾分隔符
- ZCode（partial）：插件 sensitive 配置只许展开到 env（PluginVariableError），spawn 前剥敏感 env；processTreeTerminator 校验进程身份防 PID 复用
- DeskMinis：亲自读码：tools/files.ts:18-21 isInsideRoot 只用 resolve+relative 字面判断，src/minisd grep realpath 零命中（工作区内 mklink /J 可写到外部——按代码推断，未实测）；tools/shell.ts:61 与 terminal.ts:74 裸名 spawn('powershell.exe')，cwd 为会话工作区；shell.ts:63 { ...process.env, ELECTRON_RUN_AS_NODE:'1', ...env }，terminal.ts:72 与 mcp/stdio.ts:89-90 同样把完整 process.env 交给子进程。
- 备注：会话能绑定不可信仓库，agent 又直接在宿主执行，这三项是没有沙箱时最便宜的防线。realpath 对目标已存在的最深祖先与工作区根都做 realpathSync.native，写入前再判；共享 childEnv() 擦除凭据变量与 DESKMINIS_*，显式加回 MINIS_* 桥变量，MCP 走「擦除后叠加用户声明的 env」并在确认卡写明；PowerShell 用 %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe。三项都必须 Windows 真机复现（junction 逃逸、同名 exe 劫持均为推断）。

**工具取消与进程树回收：shell 超时/停止/dispose 杀整棵进程树（绝对路径 taskkill /T /F），可选 Job 对象收容**

- pi（shipped）：killProcessTree 在 Windows spawn System32\taskkill.exe /F /T /PID，once('error') 吞异步错误；trackDetachedChildPid 登记子进程退出统一杀树；bash 超时与中止都走杀树
- DSH（shipped）：win32-process：普通子进程挂起创建、分入 KILL_ON_JOB_CLOSE Job 后恢复，拿不到 Job 退回 taskkill /T /F；windowsHide；Job 需 FFI/helper
- ZCode（shipped）：processTreeTerminator taskkill /T 并先校验进程身份；MCP stdio 经 koffi 挂 Job Object，失败回退 taskkill；强杀 Host 前至少等 3.5s
- OpenMinis（shipped）：2df21b6 iSH finalizeTimedOutPid 只收尾一次、killProcessGroup 先 TERM 后 KILL、60 秒 sweepStaleContexts 兜底
- DeskMinis：亲自读码：tools/shell.ts:151 interrupt 与 :156 dispose 只 proc.kill('SIGKILL')，Windows 上只结束 powershell.exe 本身；terminal.ts:97 同；mcp/stdio.ts:106-107 已有 taskkill /pid /T /F 杀树但按裸名启动。对应 context.md #8。
- 备注：复用 mcp/stdio.ts 的杀树逻辑抽成公共函数，改绝对路径、加 windowsHide 与 error 监听，接到 shell 的 interrupt/dispose/超时与终端 dispose。进一步可只杀本条命令的子树以保留 cwd/env。必须 Windows 真机验收：跑 node -e "setInterval(()=>{},1000)" 点停止，任务管理器无残留 node.exe。

**上下文水位以 provider 真实 usage 为锚（含缓存读写口径），只估算其后的增量；无锚时把 system 与工具 schema 计入；压缩后如实显示「未知」**

- pi（shipped）：packages/ai/src/utils/estimate.ts estimateContextTokens：取最近一条有效 assistant 的 input+output+cacheRead+cacheWrite 为基准，只对其后消息 chars/4；压缩或 context_edit 后废弃旧 usage，footer 显示「?/窗口」
- DSH（shipped）：token-meter 以最近成功调用的真实 usage 为基线（信封一致时），之后叠加带符号的 surfaceDeltaTokens；无锚时对完整信封（system、tools schema、全部节点、图片）估算
- ZCode（shipped）：contextUsage 按 system_prompt/skills/mcp_tool_schemas 等来源分项画分段条，并显示缓存命中率
- DeskMinis：亲自读码：agent/context-policy.ts:162-173 estimateTokens 只对 history 的 parts JSON 按 CJK/1.6、其余/4 估算，不含 systemPrompt 与 toolDefs；minisd/index.ts:958-963 chat.contextInfo 同源；providers/anthropic.ts:119 只取 input_tokens，不加 cache_read_input_tokens/cache_creation_input_tokens；providers/openai.ts:107 只取 prompt/completion_tokens，不读 cached_tokens；loop.ts:526 已把 tokenUsage 落库但无人读取。
- 备注：是第 1、2 行的前置：压缩触发时机与溢出预防都靠它。保留 DeskMinis 的 CJK/1.6（比 pi/DSH 的 chars/4 更准）作兜底；TokenUsage 加 cacheRead/cacheWrite；任务面板标注「实测/估算」，压缩后到下次回复前显示「下次回复后更新」而不是编一个数（界面撒谎教训）。红测：挂 30 个 MCP 工具时水位显著高于只算 history 的值。

**上下文削减决定落盘并单调推进（追加式 context_edit / pruned_through / 媒体截止锚点），重试与溢出失败尝试从模型视图持久省略，一次性提醒不随后删除**

- pi（shipped）：0.87.0（466db0f）ContextEditEntry {targetId, replacement}，replacement=null 为省略；buildSessionProjection 投影时应用，原始转录与用量不动；_omitRecoveryAttempt 持久省略失败尝试
- DSH（shipped）：工具结果剪枝写成 tool/result replace 事件 + compaction/prune 影子计价；image/offload 事件（09-08）跨路由沿用；决定一经做出一直沿用，缓存只在决定点失效一次
- ZCode（shipped）：microcompact 越线时一次清到只保留最近 5 个旧结果，节省少于 256 token 就不做
- DeskMinis：亲自读码：agent/prune.ts:261 固定保留最近 12 条的滑动窗口，由 loop.ts:343-352 在 offload 档每个 step 于请求侧重算，窗口边界每步前移；loop.ts:125-147 placeholderOldMediaRefs 只保留最近 2 轮图片，每个新回合改写更早一轮；loop.ts:370-379 CONTINUE_HINT 与 EMPTY_RESPONSE_REMINDER 只在请求侧注入、下一轮消失——正是 claude-api 技能点名会破坏前缀的「注入后删除的每轮提醒」。理念（raw 永不改写）对，但请求侧合成是滚动的。
- 备注：正好符合 DeskMinis「DB 只追加迁移」：新增 context_edits(message_id, part_index, replacement 可空) 或 sessions 追加 pruned_through_message_id / media_cutoff_message_id，只在档位触发时成块推进；一次性提醒改为落在工具结果之后并保留（或作为带来源标记的消息落库）。同步引擎要纳入新表/新列（需同步设计）。红测：同一水位下连续两次构建请求，messages 前缀字节相同。

**数据驱动的模型能力/思考规则表（规则级联、可解释 trace、黄金快照测试）+ 思考档位入口与按模型只列可用档、就近钳制**

- OpenMinis（shipped）：Providers/Thinking 4 文件 1410 行：ThinkingWireFormat 各家形状附现场证据、两阶段纯函数解析、trace 证据类别、provider_thinking_rules 用户规则表与编辑器；ThinkingWireGoldenSnapshotTests 模型×档位×端点矩阵；selectableThinkingLevels/clampEffort 由 models.dev 声明驱动，/thinking 分段控件超上限显示橙色 ↑
- ZCode（shipped）：zcode-builtin.json（revision 30）modelRules 84/modelApiRules 72/providerSiteRules 52/templateModelRules 244；受限 CEL 求值为 merge patch，同路径冲突抛错，非 JSON 请求体 fail-closed；thoughtLevelOptions 别名归一
- pi（shipped）：getSupportedThinkingLevels 过滤、clampThinkingLevel 先上后下就近夹取；/thinking 只作用本会话
- DeskMinis：亲自读码：providers/model-catalog.ts:9 ModelCatalogEntry 只有 contextWindow/maxOutputTokens/thinking 布尔；:345-348 clampThinkingLevel 只有「支持则原样、否则 off」两态；providers/openai.ts:12-17 compat 只有两个布尔开关；renderer 全树 thinkingLevel 零命中，Composer 无思考档位入口。
- 备注：OpenMinis 的教训：第一版规则表调换顺序引入交叉维度静默退化，逐维快照没拦住——改 buildOpenAIBody/anthropic/gemini 前先用现有实现生成递归排序键的 golden.json，矩阵含端点×模型族×档位×有无图×有无工具。界面侧：Composer 加思考胶囊，sessions 追加 thinking_level 列（只追加迁移、同步钉测试），UI 必 xvfb 目视。依赖第 3、4 行的形状函数。

**Todo 工具与计划条：整表替换、单 in_progress、钉在输入框上方的进度面板、重开会话可恢复**

- DSH（shipped）：packages/todo/tool-todo：每次发完整清单，追加 todo/write 事件、最后一次为准；allowParallelInProgress=false 时最多一个 in_progress；工具结果只回一行计数；TodoPanel 默认折叠，头部「完成 n · 进行 n · 待办 n」
- ZCode（shipped）：TodoWrite 隔 N 轮未用注入节流提醒；会话状态浮窗 TODO 焦点窗口、buildPlanModel 保持快照原顺序不重排
- AionUi（shipped）：v2.1.61（300e3e1）计划移出消息流，ConversationPlanBar 钉在 SendBox 上方，只显示当前回合最新全量快照，确定性 id plan:{msg_id}，重开时 /messages/latest?type=plan 回捞（计划内容由引擎流帧提供）
- DeskMinis：亲自 grep：src/minisd 与 src/renderer 中 todo_write、PlanBar、planMode 零命中；deskminis-state.md「规划模式 / Todo [missing]」。
- 备注：pi 与 OpenMinis 都没有内置 todo（pi 明确不做）。minisd 加 todo_write（约 150 行，清单就在 parts_json 里随同步走，不需新表），渲染端从历史 toolUse 折叠出最新一版，先写 fold 纯函数红测；PlanBar 与输入卡同宽、box-sizing:border-box（AionUi 实测 content-box 宽出 16px 的坑），UI 必 xvfb 目视。工具结果只回一行计数，保护缓存。

**项目指令文件 AGENTS.md / CLAUDE.md：从 git 根到 cwd 逐级加载、预算与截断规则、作为带来源标记的消息注入、首次加载经信任确认**

- DSH（shipped）：packages/context/agent-instructions：$DSH_HOME/AGENTS.md → .git 根到 cwd 每层 AGENTS.md/CLAUDE.md → *.local.md，由宽到窄；maxBytes 65536，先整份丢宽泛文件再截最具体的并提示；system-reminder 标签 包裹并转义字面闭合标签；触及更深目录时增量加入、文件删除发移除通知
- pi（shipped）：全局 AGENTS.md + 根到 cwd 每级 AGENTS.override.md/AGENTS.md/CLAUDE.md 注入 project_context 节。反面：docs/security.md:55 自认上下文文件不论是否信任都会加载，是提示注入面
- ZCode（partial）：技能多根发现（用户级 + 项目逐级到 git 根，.zcode 与 .agents 合并，safeToAutoLoad 白名单）与工作区 hook 按声明 sha256 信任；输入核验未单独确认 AGENTS.md 加载
- DeskMinis：亲自 grep：src/minisd、src/renderer、src/shared 中 AGENTS.md、CLAUDE.md 零命中；会话可绑定真实项目目录（minisd/paths.ts:30 workspaceOf），内置「代码助手」预设却读不到仓库约定。
- 备注：绑定工作区后的首个回合向上找 .git 根，由宽到窄拼接，预算约 32KB；作为一条带来源标记的 user 消息落库（不塞 system，护缓存）；内容来自仓库属半可信，先过 sanitizeMultiline；首次加载复用 PermCard 样式弹信任卡（仅本会话/始终/不加载，按路径存 DB），任务面板列出已加载文件。项目级 .agents/skills 同一道信任闸。

**先读后写与过期检测：按会话记录 file_read 的 mtime/size/hash，未读不许 edit，文件在读后被改则拒绝覆盖**

- DSH（shipped）：packages/fs/fs-observation-policy：没见过或确认不存在走 createIfAbsent，见过存在走 replaceIfVersion（版本 CAS），edit 未读报 FS_NOT_OBSERVED；观测不持久化
- ZCode（shipped）：edit.ts 用归一后的 mtime+size 判过期，写回带 expectedRevision
- DeskMinis：亲自读码：tools/files.ts:74-98 file_write 直接覆盖，:100-125 file_edit 无任何读状态；工作区外路径的审批卡最长等 90 秒（tools/permissions.ts:259 askTimeoutMs=90000），其间用户的手动修改会被覆盖；minisd 无 per-session 读观测表。
- 备注：cowork 场景下用户会同时在 Word/编辑器里改文件，agent 盲覆盖代价高。file_read 记录 {mtimeMs,size,sha1}（每会话内存 Map），file_edit 与覆盖已存在文件的 file_write 要求读过且未变，否则返回「请先 file_read 再重试」；office_write 同理。纯 TS，适合 TDD。

**计划模式：只读硬约束 + exit_plan 提交审阅（复用权限卡）+ 工具目录不随模式增删**

- DSH（shipped）：packages/plan/plan-mode：激活期只多渲染一段 plan:policy 提示，exit_plan_mode 常驻注册保证工具目录稳定；计划以 # 标题开头，经 plan-review 审阅卡接管输入框，批准后延迟到下一个 pre-step 落盘；本质是软约束
- ZCode（shipped）：apps/zcode-cli/packages/core/src/permission/service.ts plan-mode-policy：plan 模式 deny 非只读工具；ExitPlanMode 附计划，审批复用 PermissionDialog，批准后自动关闭
- DeskMinis：亲自读码：tools/permissions.ts:208-245 只有 danger/readonly/gated 与各 kind 的 levels，无 plan 态；minisd grep exit_plan/planMode 零命中；交接文档 §6「规划模式」列为未做。
- 备注：DeskMinis 的权限网关天然能做成硬约束（比 DSH 软约束更稳）：计划态对 file_write/file_edit/office_write 与非只读 shell 直接 deny；exit_plan 走 PermCard；状态存 sessions 追加列。工具列表不随模式增删以护缓存。子代理里要剔除计划切换工具（ZCode 教训：子代理没有审批恢复面会卡住父回合）。

**文件检查点与回滚：写类工具执行前原文落盘、回退前 hash 校验、按回合的改动卡与回滚预览、shell 改动如实标注不可追踪**

- ZCode（shipped）：contracts/src/rewind + core/src/runtime/helpers/rewind.ts：执行前生成 workspace_file_before_change（beforeContent/afterContent/structuredPatch），回退前 hash 校验，任一 unsafe 整批拒绝，journal 补偿；回滚预览分 safe/unsafe/ignored 并说明原因
- DSH（shipped）：deliverables workspace-changes（f937f4e23，09-11）：每个顶层回合首尾用私有 index + 只读 alternates 做 git 快照，文件工具编辑前另做整文件拷贝，生成回合改动卡与逐文件 diff；已知限制：摘要只存 Host 内存，重启即丢
- DeskMinis：亲自 grep：src/minisd 中 checkpoint/rewind/rollback/revert 零命中（只有 terminal scrollback 与 WAL checkpoint）；deskminis-state「改动」tab 只汇总 file_write/file_edit/office_write 的输入，shell 改动看不到，无撤销。
- 备注：cowork 场景（改用户的 Office 与文档）最需要「一键撤销 agent 的改动」。第一步：file_write/file_edit/office_write 执行前把原文落到 sessions/<id>/checkpoints/，索引走追加迁移，回退前比对 hash；第二步：回合前后对绑定目录做 mtime+size 快照以覆盖 shell 产物，只能标注「无法回滚」时如实说明；摘要落 SQLite，避开 DSH 重启即丢。与第 12 行（先读后写）共用读观测。

**压缩调度与护栏：按 token 预算选切点、以 rapid-refill 与连续失败熔断取代「每轮最多 3 次」、手动压缩（可附焦点说明）与接力到新会话、压缩开始事件与进度/取消**

- ZCode（shipped）：rapid-refill：连续 3 次压缩之间工具轮都少于 3 轮即阻断；连续失败 circuit_breaker；压缩后重注入最近读过的 ≤5 个文件（单个 5K、合计 50K）
- pi（shipped）：/compact [instructions] 以 Additional focus 拼入摘要；RPC compact(instructions)；56700d4 工具结果后先压缩再请求；示例扩展 handoff 生成新会话首条提示由用户审阅后发送
- DSH（shipped）：compactNow() 以 runMaintenance 在两轮之间运行，失败码封闭集合 busy/cancelled/changed/summary/commit/persistence，回报「压缩了多少条、约省多少 token」
- OpenMinis（shipped）：Compact Above、撤销压缩=删最新 marker；Android v1.13 CompactProgressIndicator 显示已用时间、当前分段、可取消
- DeskMinis：亲自读码：agent/loop.ts:321 compactCount<3 硬上限；compact.ts:58-70 按「3 个真用户回合 / ≥30 条消息保留 14 条」锚定而非 token 预算；loop.ts:24 只有完成后的 compacted 事件，无开始事件；chat.* 方法表无 compact。
- 备注：排在第 2 行之后做。chat.compact RPC 在 inFlight 时拒绝或排队；任务面板「立即压缩」可填一句焦点说明，结果用中文说明压缩条数与约省 token；撤销压缩=删最新 marker 成本极低。

**结构化向用户提问 ask_user：一次多题、单选/多选/自由填写，复用权限卡的挂起与应答通道，无人值守立即返回无人应答，子代理禁用**

- DSH（shipped）：packages/interaction/user-questions ask_user_question：options 带推荐后缀、multi_select、结构化 answers；只有根 agent 能问（DELEGATED_CALLER）；QuestionComposer 接管输入区，IME keyCode 229 不提交
- ZCode（shipped）：AskUserQuestion 1–4 题；interaction-registry 反向应答与 resolveInteraction 竞态先到先得、迟到 noop；隐藏后 60s 宽限、300s 自动结束并持久化
- pi（partial）：RPC extension_ui_request select/confirm/input/editor 可带 timeout，示例扩展 question；ui_prompt_start/end（0.84.4）区分等待回答与在干活
- AionUi（partial）：引擎 ask 帧；v2.2.1 把 ask 纳入「等待你」待确认集合与桌面通知
- DeskMinis：亲自 grep：src/minisd 无 ask_user；tools/types.ts:147-153 PermissionGateway 只有权限请求一种向用户要输入的通道。
- 备注：复用 permissions.ts 的挂起 promise + 广播 + 倒计时；cron/无人值守立即返回「无人应答」；前端在 Composer 位置换成问题卡。计划模式的审阅卡（第 15 行）可以建在这套机制上。

**工具批次按副作用元数据调度：只读/concurrentSafe 并行，其余作为屏障按原顺序执行；权限按源顺序逐张判定；结果逐个落库；MCP annotations 映射并发与风险**

- ZCode（shipped）：apps/zcode-cli/packages/core/src/tool/scheduler.ts：拓扑分层，层内连续可并行合组（上限 10），不可并行的 flush 后单独执行；canRunInParallel 看 destructive/concurrentSafe/readOnly/sideEffectScope；MCP readOnlyHint/destructiveHint 映射风险与并发
- DSH（shipped）：packages/core/agent-loop/src/tool-calls.ts：isConcurrencySafe(args) 恰为 true 才并行，未知/未声明/分类器抛错一律独占；结果按模型顺序提交；中止后未派发补 ABORTED_BEFORE_DISPATCH
- pi（shipped）：并行模式下按源顺序做 prepare/validate/beforeToolCall 预检再并发；任一工具 executionMode:'sequential' 则整批串行；withFileMutationQueue 以 realpath 串行化同文件变更
- DeskMinis：亲自读码：agent/loop.ts:550 runWithConcurrency(calls, 10) 同批一律并发；tools/types.ts:164-167 ToolExecutor 无 readOnly/concurrencySafe 元数据；tools/shell.ts:82 会话内串行队列；loop.ts:567 全部完成后整批落库；mcp/ 未读 annotations。context.md #2 已复核降级：读改写在 await 之后同步，不丢更新，真实问题是同批次序无保证与多卡并发。
- 备注：ToolExecutor.definition 加可选 concurrencySafe（只读类 true，MCP 默认 false 或按 readOnlyHint）；loop 切成「可并行段」与「独占单个」，结果按原顺序拼回并逐个落库（为第 12 行区分已开始/未开始铺路）。红测：file_write 后接 shell 读同文件必须读到新值。注意工作区内写不过网关（files.ts:28），多卡问题只在工作区外写与 gated shell/web/MCP 上出现。

**重复/死循环工具调用检测：规范化参数签名，连续重复时注入提醒（分级可拦截），maxTurns 只作最后兜底**

- ZCode（shipped）：runtime/helpers model-anomaly：工具名+stableJson(input) 签名连续 3 次相同注入 system-reminder，每 turn 预算提醒最多 3 次；核心循环 while(true) 不以调用次数硬停
- DSH（shipped）：packages/guard/repeat-tool-reminder：同一工具规范化参数完全相同的连续调用在第 3/5/8 次提醒，参数预览截 500 字，新用户消息清零，base bundle 默认启用
- OpenMinis（shipped）：ToolLoopDetector：historySize 30、警告 10、严重 20、未知工具 10、全局熔断 30，严重时直接不执行（基线已有，DeskMinis 仍未做）
- DeskMinis：亲自读码：agent/loop.ts:240 maxTurns 默认 200、:574 到顶报「已达最大回合数」；agent/ 目录无签名重复检测。
- 备注：定时任务无人值守最先受益。loop 里约 60 行：排序键后的 JSON 作签名，提醒作为带来源标记的消息追加在工具结果之后并保留（不要只在请求侧注入后删除，见第 8、9 行的前缀问题）。

**工具执行进度流：流式参数一出现即显示「准备中 N KB」、shell 输出按尾部视图边读边推、自适应限流发布**

- DSH（shipped）：09-22 工具调用 preparing→start→result 三阶段：流式 delta 出现 callId 与名字即插不可展开的「准备中」行，write/edit 显示「正在准备内容 N KB」，不解析残缺 JSON，流失败隐藏
- pi（shipped）：tool_execution_update/onUpdate 基线已有；0095bce（09-01）AdaptivePublisher（首帧立即、按字节购买冷却、100ms/100KB/s）与 OutputCapture（head/tail 有界 + spill 文件、剔除控制字符）
- ZCode（partial）：V4 增量合并 coalesce 纯函数，continuous 30ms / replayable 150ms 投递档位
- DeskMinis：亲自读码：agent/loop.ts:417 toolInputDelta 直接丢弃（注释「M1 UI 不用增量预览」），而 providers/anthropic.ts:138 与 openai.ts:122 已发出带 name 的 toolInputDelta；loop.ts:15-27 LoopEvent 无工具进度事件，shell 输出到 toolEnd 才一次性给出。
- 备注：loop 把首个 toolInputDelta 转成 toolPreparing{toolUseId,name,bytes}，约 250ms 节流，不落库；PersistentShell 边读边推 tail 视图，最终结果仍只落库一次，GBK 兜底解码放在 capture 之前。写长文件时界面长时间无动静是现有体验弱项。

**生命周期 hooks：PreToolUse/PostToolUse/UserPromptSubmit/Stop，可阻断可改写，安全类 fail-closed，工作区 hook 按声明哈希信任**

- ZCode（shipped）：7 事件 Claude Code 兼容，stdin 带 snake_case 别名，退出码 2 阻断；cli/src/hooks-trust-command.ts 信任键 (workspaceIdentity, hookDeclarationDigest)，执行前实时复核、信任库损坏一律 blocked；默认 enabled:false
- DSH（shipped）：packages/hooks/hooks-claude-code、hooks-codex：只执行 command hook，多 hook 按 deny>ask>allow 取最严，continue:false 生效到底，配置读不了不跑任何 hook
- pi（shipped）：扩展事件：context/before_provider_request 可改写，tool_call 可 block，tool_result 可改，session_before_compact 可取消；基线后 user_bash handler 出错 fail-closed，turn_end/agent_before_settle 可要求再请求一次（0.87.0）
- DeskMinis：亲自 grep：src/minisd 中 PreToolUse/PostToolUse/UserPromptSubmit/hooks.json 零命中；权限、offload、prune、记忆注入都内联在 agent/loop.ts 与 minisd/index.ts。
- 备注：分两步：先在 minisd 内部建类型化 hook 表，把权限、offload、prune、记忆注入拆成独立 handler 各自单测（重构收益，不开放第三方）；外部 hooks 优先级低，若做只读用户级配置，工作区 hooks 不自动加载，PreToolUse 的 ask 映射 PermCard，Windows 上 spawn shell:false。

**子代理/任务委派：先只读 Explore 或 one-shot 前台委派，审批钉死 never、禁用提问与计划切换，深度 1、小并发池，结算结果回灌父会话**

- DSH（shipped）：packages/subagent/tool-subagent：spawn/fork、前台或后台、continuable 结束投递 subagent-settled；活跃子代理按根共享上限（09-15 定 16、09-16 改 8），委派深度默认 1（09-17）；子会话 approvalPolicy 钉 never，userQuestions.ask 对非根抛 DELEGATED_CALLER；用户授权模型白名单
- ZCode（shipped）：runtime/methods/subagent.ts autoBackgroundMs、inactivityTimeoutMs 看门狗；tool-policy 强制剔除 EnterPlanMode/ExitPlanMode（子代理无审批恢复面会卡住父回合）；只读 Explore 档
- DeskMinis：亲自 grep：src/minisd 中 subagent/delegate 零命中；minisd/index.ts:599 inFlight 保证一会话一循环。
- 备注：OpenMinis 只有 minis-model-use CLI 调别的模型（非子代理），pi 仅实验面 Pico5 任务记录，AionUi 的 @@ 跨会话投递与 Team 模式未深读，均未计入。前置依赖：消息来源标注（DSH MessageSource，messages 追加 source_json）。首版同进程起第二个 loop、工具白名单只放读类、只把最终文本回父会话，凡需审批立即拒绝（不要等 90 秒）。

**会话级长程目标（Goal）与空闲自动续跑：独立 verifier、token/轮数预算、恢复或分叉后默认不续跑、需人类直接输入才能创建**

- ZCode（shipped）：session_target 表（objective≤4000 字、active/paused/budget_limited/complete、可选 token_budget），verifier 传 tools:[] 只回 {passed,reason,nextAction}。反面：坏 JSON、调工具、请求异常都 failOpen 返回 passed:true，异常分支事件却标 failed_closed
- DSH（shipped）：每会话最多一个 goal，armed 标志从不持久化，空闲排入 <goal_round>（默认上限 256 轮），恢复或分叉后一律 disarmed；创建/编辑需本回合有人类直接输入；同一阻塞连续 3 轮才允许 blocked；已知只有轮数预算
- DeskMinis：deskminis-state.md 与交接文档 §6 均无此项；src/minisd grep goal/target 相关实现为零（定时任务每次触发新开会话）。
- 备注：适合定时任务与无人值守。三条不照抄：预算与最大轮数强制默认值且含 token 上限；verifier 失败时暂停并提示（fail-closed）；armed 绝不进同步（否则两台设备同时续跑）。前置：消息来源标注。

**OS 级执行沙箱与「沙箱优先 + 按次升级」阶梯（被拒返回统一标记，重试须附理由，后端不可用即失败关闭）**

- DSH（shipped）：packages/sandbox/sandbox/src/escalation.ts WIDER_MODES 封闭阶梯，被拒固定标记 [sandbox: file access denied under <mode> mode]，sandbox_permissions+justification 只放宽这一次，SANDBOX_UNAVAILABLE 失败关闭；sandbox-windows-acl：WRITE_RESTRICTED 受限令牌 + Low IL + 对所有人拒 FILE_DELETE_CHILD（09-19），实现依赖 koffi
- OpenMinis（shipped）：整个 agent 跑在 iSH（iOS）/proot（Android）Linux 沙箱内，属平台形态差异；GH#242 修权限与分发规则不一致
- DeskMinis：deskminis-state.md「执行隔离 / 沙箱 [missing]：设计决策里有可选 WSL2 沙箱，代码零实现」；亲自读码 tools/shell.ts:61 所有命令直接在宿主 PowerShell 执行，只靠 permissions.ts 正则分级与审批。
- 备注：能否零依赖自建：能，但成本高——用 PowerShell Add-Type 编译缓存或单独编译一个 helper exe 调 CreateRestrictedToken/SetNamedSecurityInfoW，或走 wsl.exe 轻量形态（需吸收 UTF-16LE 输出、回环代理改写等 WSL 坑）。建议先做第一步纯 TS：会话 sandboxMode 词汇、围栏拒绝统一标记、重试带 justification 显示在 PermCard；授权范围先只放 sessions/<id>/workspace，对用户真实项目目录做常驻 ACL 改写须显式同意。pi 仅 evals 用 Docker，ZCode code-mode 的 restrictProcess 不是沙箱（泄露 process.env），AionUi 无，均未计入。只能 Windows 真机 TDD。

## 运行时韧性与会话协议（28 项）

| 能力 | 几家有 | 新趋势 | DM | 价值 | 成本 | 需新依赖 | 许可路径 |
|---|---|---|---|---|---|---|---|
| 运行中插话：queue 排到下一回合，steer / guide 在下一个 step 边界注入 | 5（DSH、ZCode、pi、AionUi、OpenMinis） |  | 缺 | 5 | M |  | pi 与 DSH 是 MIT，ZCode 是 Apache-2.0，可借代码，要署名；OpenMinis 是 GPLv3，只借思路 |
| 引擎运行期崩溃监管与有界重启（崩溃预算） | 4（ZCode、AionUi、DSH、pi） | 是 | 缺 | 5 | M |  | ZCode 的 crashBudget.ts 约 40 行，Apache-2.0，可借，要署名；AionUi 的常量同样是 Apache-2.0；DSH 是 MIT |
| RPC 断连时结算所有挂起调用（外加可选的调用超时和取消） | 4（ZCode、pi、DSH、AionUi） | 是 | 缺 | 5 | S |  | 借 pi（MIT）和 ZCode（Apache-2.0）的思路即可，约 20 行自写 |
| 会话运行态快照 + 事件序号续传：刷新、重连、切换会话后不缺不重 | 4（ZCode、pi、DSH、AionUi） | 是 | 缺 | 5 | M |  | 借 ZCode（Apache-2.0）与 pi（MIT）的语义；最小版代码自己写，不引入 V4 或 Chord |
| 配置文件读失败保护：读不出不等于不存在，降级态禁止保存 | 4（OpenMinis、pi、DSH、ZCode） | 是 | 坏 | 5 | S |  | pi 是 MIT，「有 loadError 就不写」的写法可借，要署名；OpenMinis 是 GPLv3，只借思路 |
| 单实例锁 + 数据目录锁（第二个实例把焦点交给第一个；陈旧锁可接管） | 3（AionUi、DSH、ZCode、pi） | 是 | 缺 | 5 | S |  | AionUi 与 ZCode 是 Apache-2.0，可借代码（ZCode 的 DataRootLock 陈旧锁判定尤其合适），要保留署名和 NOTICE；DSH 是 MIT，可借，要署名 |
| 渲染端自动重连与连接状态胶囊 | 3（DSH、AionUi、ZCode、pi） | 是 | 缺 | 5 | M |  | DSH 是 MIT，AionUi 是 Apache-2.0，退避常量与状态机可借，要署名 |
| 子进程树回收：shell 与终端的取消、超时、退出；孤儿登记；用绝对路径调用 taskkill | 5（pi、DSH、ZCode、AionUi、OpenMinis） |  | 坏 | 4 | S |  | pi 是 MIT，killProcessTree 可借，要署名。Job 对象要 FFI（koffi）或原生 helper，属于新依赖，不做；taskkill /T /F 这条路零依赖 |
| 数据库降级打开守卫：库比程序新就拒绝打开并引导升级 | 5（OpenMinis、AionUi、pi、DSH、ZCode） | 是 | 缺 | 4 | S |  | OpenMinis 是 GPLv3，只借思路；pi 是 MIT，可借代码，要署名 |
| 崩溃记录与全局异常处理器 | 5（pi、DSH、ZCode、OpenMinis、AionUi） | 是 | 缺 | 4 | S |  | pi 是 MIT，crash-log 可借，要署名；ZCode 的「crashReporter 只落本地」用法是 Apache-2.0 |
| 本地日志落盘、环境横幅与诊断包导出（不上传） | 5（pi、AionUi、OpenMinis、ZCode、DSH） | 是 | 部分 | 4 | M |  | pi 是 MIT，脱敏正则与同意流程可借，要署名；AionUi 是 Apache-2.0 |
| 启动与致命失败的分类、可操作的错误页、安全模式 | 4（AionUi、DSH、ZCode、OpenMinis） | 是 | 部分 | 4 | M |  | AionUi 分类器是 Apache-2.0，可借代码，要署名；DSH 对话框与处置矩阵是 MIT，可借 |
| 优雅退出：shutdown 握手、分阶段超时、半截回复落库 | 4（DSH、ZCode、AionUi、pi） | 是 | 部分 | 4 | S |  | 只需借思路（DSH 是 MIT，ZCode 与 AionUi 是 Apache-2.0），代码自己写几十行即可 |
| 中断回合恢复：进程被杀或崩溃后，处理未获回复的用户尾、半截流、未结算的工具 | 4（OpenMinis、pi、ZCode、DSH） | 是 | 部分 | 4 | M |  | OpenMinis 三态只借思路（GPLv3）；pi（MIT）的 replay 声明与中断文案可借，要署名 |
| 流式渲染性能：服务端合并窗口 + 帧合批 + 增量 Markdown + 历史解析缓存 | 4（DSH、OpenMinis、ZCode、pi） | 是 | 缺 | 4 | M |  | DSH 与 pi 是 MIT，ZCode 是 Apache-2.0，可借代码，要署名；OpenMinis 的档位数值只借思路 |
| 事件按会话订阅投递，不再向全部连接广播 | 3（pi、ZCode、DSH） |  | 缺 | 4 | M |  | 借 pi（MIT）与 ZCode（Apache-2.0）的思路，自己写 |
| 逐条消息记录实际出答模型（用量不随会话改绑而漂移） | 2（OpenMinis、pi） | 是 | 缺 | 4 | S |  | OpenMinis 是 GPLv3，只借思路；pi 是 MIT |
| 数据备份与恢复（包格式、口令加密、合并式恢复） | 2（OpenMinis、AionUi） | 是 | 缺 | 4 | L |  | OpenMinis 是 GPLv3，只借思路：格式规格要自己写，不能照搬代码 |
| 同步字段演进与删除语义（键在不在的语义、COALESCE、删除墓碑、分类开关穷举） | 1（OpenMinis） | 是 | 部分 | 4 | M |  | OpenMinis 是 GPLv3，只借思路 |
| 迁移安全：出错回滚、迁移前备份、历史迁移不可变的校验 | 5（pi、ZCode、DSH、OpenMinis、AionUi） | 是 | 部分 | 3 | S |  | pi（MIT）的 runner 写法可借，要署名；ZCode checksum 的思路是 Apache-2.0 |
| 协议版本与能力握手（同步对端、remote 与 CLI 客户端） | 4（ZCode、DSH、pi、OpenMinis） | 是 | 缺 | 3 | S |  | ZCode（Apache-2.0）的「缺失即 false」约定可借 |
| 长会话列表：分页加载、滚动锚定、回到底部、性能预算门禁 | 4（DSH、ZCode、pi、OpenMinis） | 是 | 部分 | 3 | M |  | DSH 是 MIT，ZCode 是 Apache-2.0，思路与常量可借 |
| 渲染进程 / GPU 崩溃恢复 | 3（AionUi、ZCode、DSH） |  | 缺 | 3 | S |  | AionUi 是 Apache-2.0，策略表可借，要署名 |
| 更新或退出前的忙碌检查与准入锁 | 3（DSH、AionUi、ZCode） | 是 | 部分 | 3 | S |  | DSH 是 MIT，可借思路和代码，要署名 |
| 命令幂等（clientMsgId / requestId 去重）与断线不自动重放 | 3（ZCode、pi、DSH） | 是 | 缺 | 3 | S |  | 思路可借（ZCode 是 Apache-2.0，pi 是 MIT） |
| 结构化 RPC 错误码（code / retryAfterMs，界面按码组织中文文案） | 3（ZCode、DSH、pi） |  | 缺 | 3 | M |  | 只借思路 |
| 删除或归档运行中的会话前先停止它的工作 | 3（DSH、AionUi、OpenMinis） | 是 | 缺 | 3 | S |  | DSH 是 MIT，思路可借 |
| 开发态与正式版的数据隔离 | 1（AionUi） |  | 缺 | 3 | S |  | AionUi 是 Apache-2.0，思路与写法可借 |

### 本簇跨项目观察

- 三家桌面端（AionUi、DSH、ZCode）已经收敛到同一套引擎外置进程的地基：单实例锁加数据目录锁、主进程监管加崩溃预算、有序关停加分阶段超时、致命错误页加启动失败分类。DSH 是在基线后五周内把这整套从零补齐的，说明这是「能发布」的前提，不是锦上添花。DeskMinis 同样用 utilityProcess 外置引擎，却只做了「启动期」那一半：握手后崩溃无人处理，没有单实例锁，退出直接 kill。
- 协议层的共同走向，是从「请求-响应加全量广播」升级为「快照 + 单调序号 + 断档就重水合 + 按订阅投递」（ZCode V4、pi 的 lane.watch 与 Chord、DSH 连接分代）。几家共同遵守两条原则：断连时在本地 reject 所有挂起调用；绝不自动重放写操作（pi 明文写进规范，ZCode 用 commandId 幂等）。DeskMinis 的 rpc.ts（71 行，无 onclose）加 RpcServer 全量广播，是五家里最原始的形态。
- 运行中插话五家全有：AionUi、DSH、pi、OpenMinis 在基线时就有，ZCode 是首次读到。所以这不是新趋势，而是 DeskMinis 的长期欠账。语义分两种：queue（下一回合）和 steer/guide（下一个 step 边界）。共同不变量是「不插在 tool_use 与 tool_result 之间」，中止时把排队内容还回输入框。
- 数据安全守卫在本轮同期出现：库比程序新就拒绝打开（OpenMinis v1.13、pi durable、DSH 会话格式、AionUi）；读不出不等于不存在，降级态禁止保存（OpenMinis RebootGuard、pi settings-manager、DSH revision 围栏）；历史迁移不可变（ZCode checksum、DSH 相邻迁移）。这三类都只要 S 级成本，也都完全符合 DeskMinis「DB 只追加」的纪律。
- 本地诊断在几家都是「只落本地、导出要用户同意」：pi 的 /bug 离线时只能导出 zip，ZCode 的 crashReporter 把上传地址设成本地专用，OpenMinis 写 O_SYNC 面包屑。这和 DeskMinis「不经云端」的承诺天然契合，可以直接吸收。
- 流式渲染普遍在两端都做节流：服务端有合并窗口（ZCode 30/150ms，pi AdaptivePublisher 100ms / 100KB/s），客户端做帧合批和增量 Markdown（DSH 冻结前缀、OpenMinis 分档）。DSH 还用 benchmarks 给出用户路径的性能预算。DeskMinis 两端都是每个 delta 全量处理。
- 对方向决策的结构判断：本簇 28 项能力全部能在现有 minisd + Electron + Vue 骨架上零依赖补齐（唯一要依赖的 Job 对象 FFI 有 taskkill 替代），没有任何一项需要换引擎架构或 UI 框架，这是反对方案 C 的证据。但崩溃重启、断连结算、自动重连、快照续传、订阅投递、运行中插话这六项彼此咬合：重启导致端口和 token 变化，渲染端要重连，重连要取快照，快照要带序号，序号要按会话订阅，排队项也是快照的一部分。零散点修会反复返工，适合作为一波「会话协议与运行时韧性」成批重写（即方案 B 的定向革新），范围限定在 rpc.ts、stores/chat.ts 的事件层和 minisd 的事件出口，不碰 UI 树。
- 发布前的 S 级快速项（可以排在 0.3.0 上架之前或同一波）：断连结算、配置读失败保护、DB 降级守卫、单实例锁、进程树回收、优雅退出接线（close() 已有，只差触发）、崩溃记录、逐消息模型归属列（列越早加越好）。
- 参考项目里要警惕的反面做法：DSH 的 session-log-deepseek 默认把完整会话日志外发，遥测默认 FEEDBACK_ONLY；AionUi 为了一个字体 API 放行全部 Electron 权限，WebUI 事件扇出到所有连接后靠前端比对 user_id 过滤；ZCode 写了 PersistentProtocol（ACK / 重放 / 心跳）却没有任何产品调用方，Goal verifier 失败时 fail-open，注释引用的黄金测试不在仓库里；pi 在 sqlite-node 里原地改写初始迁移、删除 writer-lease，而且客户端刻意不自动重连（DeskMinis 若做自动重连，必须只重拉只读数据）；OpenMinis 的备份 resumingAt 是设计跑在代码前面，没有调用方。借鉴任何机制前都要先用 grep 确认调用点，并写 DeskMinis 自己的不变量红测。
- 核验中对参考侧输入的补充（没有写进 deskminis_corrections）：OpenMinis iOS 在基线 v1.10 就有运行中排队（AIChatViewModel+Misc.swift:62 与 AIChatViewModel.swift:4193），openminis.md 没列；pi 有配置读失败禁止保存（settings-manager.ts:671/689）；ZCode 有单实例锁与 DataRootLock（desktop/src/main/index.ts:1886、zcode-server-cli/src/runtime/lock.ts），也有只落本地的崩溃转储（desktopCrashCapture.ts）。以上都已写进对应行的 refs。
- 过程申报：为确认 v0.1.1 发布版的线格式，我误执行了一次 git ls-remote（只读列出远端标签，属于联网），随后改用本地已有的提交 6c48c8b 完成核对。其余全部是本地只读操作，没有修改、安装或构建任何东西。

### 对 DeskMinis 现状说法的纠正

- context #4（rpc.ts 没有 onclose）属实，但比原描述更严重。浏览器 WebSocket 在 CLOSED 态 send() 不抛错，只是丢弃数据，所以断线后新发的调用也会永远挂起，包括停止按钮发出的 chat.cancel。stores/chat.ts 里 running 只在 turnEnd/error 事件时复位，minisd 一崩溃，界面就永久停在「运行中」，停止无效，也没有任何提示。
- dsh.md 说「before-quit 直接 minisd.kill()，没有关停握手」，这点属实，但漏了一件事：minisd/index.ts:1208 startMinisd 已经返回一个完整的有序 close()（abort 全部 controller，清理 pendingPerms 和 cron，disposeAll 终端/shell/MCP，关 rpc 和 db），只被测试调用，standalone 分支（:1220）从未接线。所以优雅退出是「已建未接」，成本从 M 降到 S。接线时要修正 close() 在 abort 后不等循环收尾就 db.close 的竞态。
- aionui.md 与 dsh.md 说双实例会「同时跑 mDNS 同步 / 同步与 mDNS 同时广播」，这不对：DeskMinis 源码 grep mdns、bonjour、multicast、dgram 零命中，配对靠手输 host:port。双实例的真实后果是：两个 minisd 同写 minis.db，cron 两边各发一次，两个 OutboundClient 同时拨对端，minisd-port.json 被覆写，第二个实例的 windows-* 桥管道 EADDRINUSE 后静默降级。
- openminis.md 说 chat-store.ts:425-428 的 ws.modelBinding ?? null / ws.pinnedAt ?? null 会被「旧版对端」清空。代码属实，但这两个键在唯一发布版 v0.1.1（commit 6c48c8b 的 wire.ts:45-46）就已存在，现实中不存在缺这两个键的旧对端。这是「今后新增字段时」缺少演进规则，不是现存 bug。真正现存的同步缺陷是删除没有墓碑：db.ts:11 预留了 remote_tombstoned_at，但全仓没有读写，已删会话会被对端复活。
- deskminis-state 说「resultOf 每个工具调用都要遍历全部消息，是 O(n²)」，需要收窄。resultOf 在 turns computed 里，只在 chat.messages 变化时重算（每次 turnEnd/error 后 open() 整会话重拉），不是每个 delta 都付一次。每个 delta 真正的全量开销，是模板函数 mdOf（StageChat.vue:139/:189）把全部历史文本块重新 parseMarkdown，加上 streamNodes 对整段流式文本全量解析（:126）。
- deskminis-state 把 README「会话与记忆双向同步」标为有待核实。现已核实不成立：sync/wire.ts 只有 WireMessage、WireCompactMarker、WireSession、WireSessionFile 四类，sync/ 目录 grep memory 只命中 memoryEnabled 开关（wire.ts:44/:156），记忆 Markdown 根本不同步。README 这一行属于界面撒谎类问题。
- 输入没有列出的新缺陷，一：permission.request 进 store 时没有存 sessionId（stores/chat.ts:155-161），StageChat.vue:216 渲染 chat.pendingPerms 也不按会话过滤，所以后台定时任务或其它会话的权限卡会出现在当前打开的会话里。二：open() 切会话时把 running 置 false（chat.ts:397），非当前会话的事件被丢弃（:142），切回一个仍在跑的会话后，发送键可点（点了被 minisd 拒），流式正文缺开头。
- 输入没有列出的新缺陷，三：凭 8 位配对码处于 pairing 态的 WS 连接也会进入 RpcServer.clients（rpc/server.ts:82），能收到全部广播，包括带写文件 preview 全文的 permission.request；remote 态的配对设备可以调 permission.respond（remote/index.ts:249-257 只拦 pairing）。另外每个 textDelta 都逐条广播给所有连接（index.ts:746），配对设备会收到本机全部会话的流式正文。
- context #6 的补充：同一类「读不出当成不存在」还出现在 provider-store.ts:103 和 search-provider-store.ts:23。它们不会覆盖文件，但构造器一抛错，整个 minisd 就起不来，主进程弹出 e.stack（安全但用户无从下手）。FileVault 在 vault.json 损坏时会以空 vault 起步、下次 set 就覆盖，但它只在 DESKMINIS_E2E=1 时启用，不影响生产。
- context #8（shell 超时只杀 PowerShell 本身）属实，但孤儿范围比字面上窄：驱动脚本读到 stdin EOF 会 break（tools/shell.ts:20），minisd 被杀时空闲的 shell 会自行退出，真正留下的孤儿是「正在执行的长命令及其孙进程」。另外 shell.ts:61 与 terminal.ts:74 用裸名 spawn('powershell.exe')、mcp/stdio.ts:116 用裸名 spawn('taskkill')，存在被工作区里同名 exe 劫持的面（依据 pi.md 对 libuv 的分析，尚未在真机复现）。

### 逐行证据与备注

**运行中插话：queue 排到下一回合，steer / guide 在下一个 step 边界注入**

- DSH（shipped）：Agent.send 有 followup / steer / inject 三种投递；持久化的 inbox.ts（08-27 新增）以 agent/inbox/spliced 事件落日志，冷启动可重建；QueueDock 支持编辑、删除、转插话；回车与 Ctrl+Enter 按设置互换（dsh.md R5）
- ZCode（shipped）：guide 只在合法的 model-step 边界消费，每次一条，不插进 tool_use 与 tool_result 之间；队列面板可编辑撤回、立即发送、拖拽排序、暂停；packages/ui/src/v4/composer/followupModeSettings.ts（zcode.md R5）
- pi（shipped）：Agent 提供 steer() 与 followUp() 两个队列；clear_queue 为 0.84.4 新增；中止时 restoreQueuedMessagesToEditor 把排队内容回填编辑器（interactive-mode.ts，pi.md R4）
- AionUi（shipped）：CommandQueuePanel 草稿箱：立即发送（打断当前回复插队）、编辑、删除、拖拽排序，auto/manual 两种模式，基线前就有（aionui.md R3）
- OpenMinis（shipped）：iOS AIChatViewModel+Misc.swift:62 的 enqueuePrompt：运行中入队，虚线气泡可撤回（:92）；回复结束后由 AIChatViewModel.swift:4193 的 injectQueuedPromptsAsNewTurn 合并注入；取消时把最后一条回填输入框。基线 v1.10 已有（本次补查，openminis.md 未列）
- DeskMinis：Composer.vue:33 的 canSend 条件里含 !chat.running，:341 运行中把发送钮换成停止钮；:318 的 Esc 只用来关菜单。minisd index.ts:599 在 inFlight 时让 chat.prompt 直接抛「该会话正在运行中」。stores/chat.ts:50 已有 draft 寄存，可以复用来做回填
- 备注：先做 queue：minisd 按会话维护 FIFO，回合结束自动开下一轮；渲染端能展示、撤回，停止时回填草稿。再做 steer：loop.ts:567 工具结果落库之后、下一次请求之前就是合法边界，要写守卫保证「不落在 tool_use 与 tool_result 之间」。附件、会话级 MCP 禁用等所有发送字段都要完整穿过入队和出队（AionUi 的教训），用守卫断言字段集合一致

**引擎运行期崩溃监管与有界重启（崩溃预算）**

- ZCode（shipped）：packages/zcode-server-cli/src/supervisor/crashBudget.ts：5 分钟窗口内按 1/2/4/8/16s 退避，第 6 次崩溃进入 crash-loop-stopped；core 监听父进程 IPC disconnect，自行收口（zcode.md R5）
- AionUi（shipped）：packages/web-host/src/backend-launcher.ts 的 BackendLifecycleManager：restartWindowMs 60000，maxRestarts 3，超出后进入 error 态（aionui.md R5）
- DSH（shipped）：桌面 Host 用生命周期协议 v4：非 0 退出或 Host 报 fatal 都进入 fail 流程，原生致命对话框提供「重启」（基线后新增，dsh.md R5）
- pi（experimental）：实验 server 的 SessionWorkerManager：worker 被替换后对未完成的持久操作 lane.resume() 续跑；最后一个展示端离开 10 秒后退役（pi.md R3）
- DeskMinis：src/main/index.ts:66 的 minisd.on('exit') 只在 minisdPort===0（握手前）时生效，握手后 minisd 退出没有任何处理。preload/index.ts 只暴露 minisdInfo/minisdPort 这类 invoke，没有「引擎已重启」的推送通道。src/minisd 里 grep uncaughtException/unhandledRejection 零命中（index.ts:423 只是一句注释）
- 备注：必须和「断连结算」「自动重连」「运行态快照」放在同一波做。每次重启端口和 token 都会变，需要经 IPC 推 minisd:restarted。预算耗尽后显示可重试的错误页，并附 stderr 尾部。重启后不要自动续跑被打断的回合，交给用户决定。utilityProcess 的重启路径要在 Windows 真机验证

**RPC 断连时结算所有挂起调用（外加可选的调用超时和取消）**

- ZCode（shipped）：packages/rpc/src/channelClient.ts 用 pendingRejections 在 dispose 时拒绝全部挂起 Promise；CancellationToken 发 PromiseCancel(101)。反面：Web 客户端 onClose 是空函数（zcode.md R5）
- pi（shipped）：pi-client 断连时本地 reject 全部挂起调用，从不自动重放；基线后的 mini RPC 有 cancel 帧、按调用超时、15 秒无帧即判死（pi.md R5）
- DSH（shipped）：packages/client/connection/src/client/connection.ts：断线后每条逻辑流在新一代里原子替换（dsh.md R5）
- AionUi（partial）：只在 WebUI 浏览器模式：认证终止后进入终态，已排队的重试不会被 emit 复活（aionui.md R3）
- DeskMinis：renderer/src/rpc.ts 全文 71 行：只挂了 onopen/onerror/onmessage（:36-42），没有 onclose；pending 是 Map<id, resolve>（:6），断线后永远不会 settle。浏览器 WebSocket 在 CLOSED 态 send() 不抛错，只是丢弃，所以断线后新发的调用也永远挂起，包括停止按钮发出的 chat.cancel。stores/chat.ts 里 running 只在 turnEnd/error 事件时复位（:519-536），minisd 一崩，界面就永远停在「运行中」，停止无效，也没有任何提示
- 备注：做法：onclose 时用「与后台服务的连接已断开」reject 全部 pending，store 置 connection='lost'；断线期间新的 call 立即失败。可以在 node 里用已有的 ws 依赖起一个假服务端先写红测。这是 0.3.0 上架前就该补的 S 级缺口

**会话运行态快照 + 事件序号续传：刷新、重连、切换会话后不缺不重**

- ZCode（shipped）：packages/shared/src/zcode-protocol-v4/snapshot.ts：conversationSnapshot 带 logEpoch/seq/revision 以及 control/queue/pendingInteractions 等状态；增量只有 7 种封闭 op，表达不了的一律整份 resync；base 有效就续传增量（zcode.md R5）
- pi（shipped）：harness 的 lane.watch 分两阶段：先截取 LaneSnapshot（流式消息、运行中工具、队列）并缓冲事件，start() 时排空；Chord 复制状态用单调 seq，一断档就清空重水合（chord 是基线后的实验包，pi.md R4）
- DSH（shipped）：连接分代：新一代里每条逻辑流用完整基线原子替换，不做增量补洞（dsh.md R5）
- AionUi（partial）：计划条靠 /messages/latest?type=plan 回捞；hydrate 时按 runtime.pending_confirmations 补标等待态，但只覆盖打开过的会话（aionui.md R5、R4）
- DeskMinis：后端：inFlight 与 pendingPerms 都是闭包私有变量（index.ts:404、:281），没有运行态或待批的查询 RPC；chat.event 不带序号（:746）。渲染端：stores/chat.ts:396-403 的 open() 一切会话就把 running 置 false，并清空 streamingText 和 toolCards；不是当前会话的 chat.event 直接丢弃（:142）。结果一：切走再切回一个仍在跑的会话，running 为 false，发送键可点，点了被 minisd「该会话正在运行中」拒掉，流式正文缺开头，要等 turnEnd 重拉才补齐。结果二：渲染端一重载，pendingPerms 全丢，minisd 却还在等，90 秒后自动拒绝，界面上没有卡可批。另：permission.request 入 store 时没存 sessionId（chat.ts:155-161），StageChat.vue:216 也不按会话过滤，所以后台定时任务或别的会话的权限卡会出现在当前打开的会话里
- 备注：最小版：epoch 取 minisd 的启动 id；每个会话维护 seq，外加一份内存 live 快照（流式文本、运行中工具、待批权限、排队项）；新增 chat.watch(sessionId) 返回 {messages, live, seq}，渲染端丢掉 seq 不大于快照的事件，发现跳号就重新 watch。可顺带加 chat.settled 事件，表示降级、重试、压缩全部结束（pi 的 agent_settled），给 e2e 剧本用来替代轮询。先写红测：刷新后权限卡仍在、running 仍为真

**配置文件读失败保护：读不出不等于不存在，降级态禁止保存**

- OpenMinis（shipped）：ProviderConfigStore.swift 把加载结果分为不存在 / 读不出 / 解码失败，后两种进入降级模式，save 被硬拦截、不推 iCloud（RebootGuard）；MigrationEngine 在 0 会话却有 N 条消息时拒绝走捷径（openminis.md R5）
- pi（shipped）：packages/coding-agent/src/core/settings-manager.ts:326-327 记录 global/project 的 loadError，:671 和 :689 在有 loadError 时 save 直接 return 不写；只回写改动过的字段；#7829 在 TUI 里显示文件路径警告（本次补查，pi.md 未列）
- DSH（shipped）：设置统一到 profile，每个命名空间带 revision，过期写入被拒；旧文件首次写入前改名为 .imported；sanitizeProfile 改名为 .bak，不删文件（dsh.md R3、R5）
- ZCode（partial）：ConfigOverlay 三层覆盖；插件目录按 staging→backup→rename 带事务记录（zcode.md R5、R4）
- DeskMinis：mcp/config.ts:123-134：load 解析失败只设 loadError，entries 为空（readFileSync 抛 EBUSY 也走这个 catch，杀软或 OneDrive 占用时就会遇到）。:152-176 的 save() 不检查 loadError，:209/:215/:223 任何一次增、删、改都会用空列表原子覆盖原来的 servers.json（context #6 属实）；渲染端只拿到一个 configError 布尔（index.ts:837）。provider-store.ts:103 与 search-provider-store.ts:23 解析失败会在构造器里抛出：不会覆盖文件，但整个应用起不来
- 备注：修法：load 区分 ENOENT 和其它错误；有 loadError 时 save 拒绝，或者先把原文件改名为 servers.json.corrupt-<ts> 再写；界面如实说「配置读取失败，未作改动」。先写红测：损坏文件 + add 之后，原文件字节不变

**单实例锁 + 数据目录锁（第二个实例把焦点交给第一个；陈旧锁可接管）**

- AionUi（shipped）：packages/desktop/src/index.ts:89 app.requestSingleInstanceLock({deepLinkUrl})，second-instance 时聚焦窗口；aioncore 发现数据目录被占用报 BOOTSTRAP_PEER_ALREADY_RUNNING，launcher 按 250/500/1000/1500ms 退避，最多 5 次（aionui.md R5）
- DSH（shipped）：apps/desktop/src/single-instance.ts + tests/single-instance.spec.ts，在碰任何 profile 之前取锁；桌面端是基线后新增（dsh.md R5）
- ZCode（shipped）：packages/desktop/src/main/index.ts:1886 requestSingleInstanceLock；packages/zcode-server-cli/src/runtime/lock.ts DataRootLock 区分 missing/active/stale/invalid/unreadable（本次核验补查，zcode.md 未列）
- pi（experimental）：CLI 形态，不需要单实例；反面：session-backends/sqlite-node 在基线后删掉了 writer-lease.ts（pi.md 要点变化）
- DeskMinis：亲自读过 src/main/index.ts 全部 233 行：没有 requestSingleInstanceLock，也没有 second-instance。minisd/index.ts:112-139 resolveAndPersistPort 遇到端口被占就退回随机端口，并覆写 minisd-port.json；bridge/server.ts:89 命名管道 EADDRINUSE 时只降级；paths.ts:9-13 数据根固定为 %APPDATA%\DeskMinis。所以开两个实例的真实后果是：两个 minisd 同写 minis.db，cron（index.ts:1184 每 30s 一次）两边各发一次，两个 OutboundClient 同时去拨对端，第二个实例的 windows-* 桥静默不可用
- 备注：要做两道闸。第一道是 main 里约 10 行的 requestSingleInstanceLock；second-instance 里要能把托盘隐藏态的窗口唤出来。第二道是 minisd 在 dataRoot 用 openSync('wx') 建锁文件，写入 pid，并用 process.kill(pid,0) 判断是否陈旧。第二道不能省：Electron 的锁按 userData 算，dev 构建与安装版可能不在同一把锁下，却共用 %APPDATA%\DeskMinis。可以先写红测，最后在 Windows 真机上验证

**渲染端自动重连与连接状态胶囊**

- DSH（shipped）：ConnectionController 等 ready 帧确认后才发布新一代；按 500ms/1s/2s/4s/8s/10s 退避，带 50–100% 抖动；offline 时暂停；黄色「连接异常」胶囊至少停留 800ms，恢复后变绿 2 秒（基线后 09-05，dsh.md R5）
- AionUi（shipped）：WebUI 从 500ms 退避到 8s，连接稳定 5s 以上才重置；认证失败后不能被 emit 复活；配 247 行 DOM 测试（v2.2.1，aionui.md R3）
- ZCode（partial）：桌面端 renderer 刷新时重新挂上端口即可恢复；Web 客户端 onClose 为空，不重连（zcode.md R5）
- pi（shipped）：反向的刻意设计：客户端从不自动重连，由调用方显式 reconnect()，只重做已知安全的操作（pi.md R5）
- DeskMinis：rpc.ts 没有任何重连逻辑，connect() 只在 stores/chat.ts:130 的 init 里调用一次；主进程没有通知渲染端「minisd 已重启」的通道；TopBar 只有表示同步态的 syncDot，没有连接态
- 备注：要与崩溃重启同一波做。每次重连前重新取 minisdInfo；重连成功后只重拉只读的基线数据，绝不自动重发 chat.prompt（pi 的原则）。验收用 xvfb 剧本：kill minisd，断言出现横幅并能自动恢复

**子进程树回收：shell 与终端的取消、超时、退出；孤儿登记；用绝对路径调用 taskkill**

- pi（shipped）：packages/coding-agent/src/core/tools/bash.ts 与 harness/env/nodejs.ts 的 killProcessTree 调用 %SystemRoot%\System32\taskkill.exe /F /T；trackDetachedChildPid；超时与中止都杀整棵树（pi.md R4）
- DSH（shipped）：子进程先挂起创建，分进 KILL_ON_JOB_CLOSE 的 Job 对象后再恢复；拿不到 Job 时退回 taskkill /T /F；统一 windowsHide（dsh.md R4）
- ZCode（shipped）：processTreeTerminator 用 taskkill /T，先校验进程身份防 PID 复用；MCP stdio 经 koffi 挂 Job Object（zcode.md R4）
- AionUi（shipped）：web-host 的 runtime/agent-process-registry.json 登记 pid，停止时 SIGTERM，1s 后 SIGKILL，Windows 用 taskkill（aionui.md R4）
- OpenMinis（shipped）：iSH 的 killProcessGroup 先 TERM 后 KILL；finalizeTimedOutPid 保证只收尾一次；每 60s sweepStaleContexts（openminis.md R5）
- DeskMinis：tools/shell.ts:151（interrupt）和 :156（dispose）都只 proc.kill('SIGKILL')，terminal.ts:97 也一样，Windows 上只结束 powershell.exe 本身（context #8 属实）。mcp/stdio.ts:109-121 有 killTree，但只给 MCP 用，而且 :116 用裸名 spawn('taskkill')。shell.ts:61 与 terminal.ts:74 用裸名 spawn('powershell.exe')，cwd 是会话工作区（pi.md 提示 libuv 会先搜 cwd，存在被同名 exe 劫持的面，本次未上真机复现）。所有 spawn 都没设 windowsHide。补充：驱动脚本读到 stdin EOF 会 break（shell.ts:20），所以 minisd 被杀时空闲 shell 会自己退出，孤儿主要是正在跑的长命令及其孙进程
- 备注：把 killTree 抽成共用函数，改为 System32 绝对路径，加 windowsHide 和 error 监听，接到 shell 的 interrupt/dispose/超时、terminal 的 dispose 和 minisd 退出上。真机验收：用 node -e "setInterval(()=>{},1000)" 跑一个命令，点停止后任务管理器里不应残留 node.exe

**数据库降级打开守卫：库比程序新就拒绝打开并引导升级**

- OpenMinis（shipped）：Android 的 DatabaseVersionGuard 在 Room 打开前以只读方式读 user_value 的版本号；NewerDatabaseGuidanceScreen.kt 刻意不提供清空按钮；另注册了空降级迁移 MIGRATION_12_11，有 DatabaseVersionGuardTest.kt（v1.13，openminis.md R4）
- AionUi（shipped）：database.newer_than_app 单独归类为 backend_database_newer_than_app：库本身完好，引导升级，不算迁移失败（aionui.md R4）
- pi（shipped）：durable 的 applySqliteMigrations 遇到比程序新的库直接抛错拒绝（09-18 新包，pi.md R4）
- DSH（shipped）：会话格式遇到未来版本拒绝读取，只读打开时在内存里迁移（dsh.md R2）
- ZCode（partial）：schema_migration 的 checksum 不一致就拒绝启动，防的是篡改历史迁移，不是降级（zcode.md R4）
- DeskMinis：store/db.ts:191-202 的 openDb 只跑 for (v = current; v < MIGRATIONS.length; v++)。current 大于 MIGRATIONS.length 时一次迁移都不跑，照常读写，也不发任何信号（context #7 属实）。安装版、便携版、dev 都用 %APPDATA%\DeskMinis（paths.ts:9-13），回装一个旧便携版就会触发
- 备注：只改 runner，不动历史迁移，符合只追加纪律。抛出带码的 DB_NEWER_THAN_APP，主进程映射成「数据由更新版本写入，未作改动，请安装最新版」，不给清空按钮。红测：构造 user_version=N+1 的临时库

**崩溃记录与全局异常处理器**

- pi（shipped）：packages/coding-agent/src/core/crash-log.ts 写 crashes.json，最多 5 条、保留 7 天，下次启动提示一次，崩溃栈能归因到具体扩展（0.86.0，pi.md R4）
- DSH（shipped）：崩溃报告写进 logs 目录，权限 0600，保留最近 10 份，含 cause 链；未捕获异常一律按致命处理（09-22，dsh.md R5）
- ZCode（shipped）：packages/desktop/src/main/desktopCrashCapture.ts：crashReporter 的上传地址是 LOCAL_ONLY_CRASH_SUBMIT_URL（只落本地），归档最多 5 份、100MB，附 V8 OOM 摘要（本次补查，zcode.md 未列）
- OpenMinis（shipped）：iOS CrashReporter +431 行：用 O_SYNC 写工具执行面包屑，60 秒内两次崩溃就跳过恢复上次会话；Android 的 PersistentShell 保留输出开头 1KB 和末尾 2KB（openminis.md R4）
- AionUi（partial）：用 Sentry 云端上报，DeskMinis 不能学；本地另有日志（aionui.md R3）
- DeskMinis：src/main 和 src/minisd 里 grep uncaughtException、unhandledRejection、crash 零命中。main/index.ts:60/:65 只把 minisd 的输出转发到主进程 stderr，打包后没人看得到，也不落盘
- 备注：main 和 minisd 各挂 uncaughtException/unhandledRejection，记录 utilityProcess 的退出码和 stderr 环形缓冲，追加写 userData/crashes.json（5 条、7 天封顶）。和「不经云端」一致，只落本地

**本地日志落盘、环境横幅与诊断包导出（不上传）**

- pi（shipped）：packages/coding-agent/src/core/bug-report.ts 的 /bug：用 SENSITIVE_KEY 正则脱敏，redactUrl 剥掉 URL 凭据，分级征得同意；PI_OFFLINE 时只能导出 zip（0.86.0，pi.md R4）
- AionUi（shipped）：反馈功能用 node:zlib 把最近 3 天的 .log 打成 gzip；BackendStartupError.details 带 stderrTail、时序和目录列举（aionui.md R3）
- OpenMinis（shipped）：Android 的 EnvironmentBanner 每个日志会话打一行环境信息；内存读数取 /proc/self/status 的 VmRSS，因为 nativeHeap 曾报出 9.7GB 带偏排查（openminis.md R4）
- ZCode（shipped）：packages/debug 提供本地只读的日志与 DB 查看器；RPC 日志用装饰器包装（zcode.md R2）
- DSH（partial）：只有崩溃报告。反面：session-log-deepseek 默认把完整会话日志附进请求上传（dsh.md R4）
- DeskMinis：diagnostics.ts 只做 dryRun 静态预检（:1-8 头注释：不调模型、不执行工具）。没有日志文件，main/index.ts:60/:65 只 process.stderr.write。audit_logs 在库里，但 audit.list 没有界面入口。没有「导出诊断包」的入口
- 备注：日志写到 %LOCALAPPDATA% 下按天滚动；启动时写一行环境横幅（版本、内存、fs.statfsSync 得到的剩余空间）。打包用 office/zip.ts 或 node:zlib，零依赖。只导出到用户选择的位置，绝不学 DSH 默认外发。入口放在启动失败框和「设置 → 关于」

**启动与致命失败的分类、可操作的错误页、安全模式**

- AionUi（shipped）：packages/desktop/src/process/startup/backendStartupFailure.ts：用 message、stderrTail、边界码和阶段把启动错误归成十几种 reason（架构不符、安装损坏、EACCES、对端占用、库比应用新、迁移失败等），配表驱动单测（aionui.md R4）
- DSH（shipped）：每个进程只弹一次原生致命对话框，只显示最后 8 行、1200 字；按钮为退出 / 重启 / 禁用第三方 bundle 后重启；sanitizeProfile 把配置改名为 .bak-<ts>，不删文件；app-boot 按必需组件与可选组件分别处置（dsh.md R5、R3）
- ZCode（partial）：生命周期状态含 crash-loop-stopped；DatabaseStartupCoordinator 上报启动阶段，失败后只能由显式 retry 推进（zcode.md R3）
- OpenMinis（partial）：Android 的 NewerDatabaseGuidanceScreen.kt 只针对库比应用新这一种情况，引导页刻意不给清空按钮（openminis.md R4）
- DeskMinis：main/index.ts:222-227：启动失败时用 showErrorBox 直接显示 e.stack，随后 app.quit，没有分类、重试或安全模式。minisd/index.ts:1220-1233：启动失败只写 stderr 然后 exit(1)。provider-store.ts:103 与 search-provider-store.ts:23 在构造器里 JSON.parse，一旦抛错，providers.json 手改坏了整个应用就起不来，只看到一串堆栈。唯一算得上 partial 的是 diagnostics.ts 的 dryRun 静态预检
- 备注：分类器写成纯函数 classifyStartupFailure(err, stderrTail)，先写表驱动红测。至少覆盖：.node 加载失败或被杀软隔离、EBUSY/锁、EACCES、keyring 失败、DB_NEWER_THAN_APP、握手超时。安全模式跳过 MCP、同步和市场技能。stack 只写进日志，不上屏（教训 2）

**优雅退出：shutdown 握手、分阶段超时、半截回复落库**

- DSH（shipped）：先发 shutdown 等 10 秒，再 SIGTERM 等 5 秒，最后 SIGKILL；要求优雅退出但实际不干净时抛 DesktopHostUncleanExitError，拒绝安装（dsh.md R4）
- ZCode（shipped）：runHostShutdownPhases 给每个阶段单独设超时，记录 failedPhases/timedOutPhases；disposeHostProcess 强杀前至少等 3.5s（zcode.md R4）
- AionUi（shipped）：packages/desktop/src/process/startup/quitCleanup.ts：before-quit 先 preventDefault，再依次销毁托盘、停 cron、停引擎，整体 10s 超时后强退，依赖全部注入可单测（aionui.md R4）
- pi（partial）：trackDetachedChildPid 在退出时统一杀树；durable 关闭时做 wal_checkpoint(TRUNCATE)（pi.md R4）
- DeskMinis：main/index.ts:230 的 before-quit 直接 minisd?.kill()，不握手也不等待。但 minisd/index.ts:1208 startMinisd 已经返回一个有序的 close()：abort 全部 controller、清空 pendingPerms、停 cron、依次 disposeAll 终端/shell/MCP、关闭 rpc、db.close。它只被测试调用，standalone 分支（:1220 起）从来没接上，也没有 shutdown RPC 或 parentPort 消息。loop.ts:289/426/448 的 cancelWithPartialReply 在 abort 时会把半截回复落库，所以只要接上就能拿到「退出时半截回复不丢」
- 备注：接线时要顺带修一处竞态：close() 在 abort 之后没有等各 run 的 finally 收尾就 db.close()，循环可能还在写库。main 侧最多等 5 秒再 kill。红测：运行中退出，重启后半截回复仍在

**中断回合恢复：进程被杀或崩溃后，处理未获回复的用户尾、半截流、未结算的工具**

- OpenMinis（shipped）：中断分三态：retry / resume / 未获回复的用户尾（resumeUnansweredUserTurn，v1.13 GH#262/263）（openminis.md R4）
- pi（shipped）：durable 的意图与结算两段提交，工具声明 replay safe|never，写出 INTERRUPTION_MARKER「外部结果未知」；AssistantMessageFrameEncoder 把流式帧持久化，结算时删除（pi.md R3）
- ZCode（shipped）：STREAM_RECOVERY_MAX_RETRIES=10，从已提交的锚点重发，并发 StreamRecovery 事件；session.revert 不删行（zcode.md R3）
- DSH（shipped）：checkpoint 策略设三道 flush 屏障；repair.ts 的补齐文案区分「已开始」与「未开始」，并给重试建议（dsh.md R2、R3）
- DeskMinis：loop.ts:289-296 的 cancelWithPartialReply 只在用户主动取消时把半截文本落库；进程被杀或退出时流中内容全丢（before-quit 直接 kill）。loop.ts:210 的 pairToolResults 只在构建请求时补一句「[工具执行被中断，结果未知]」，没有重试建议；loop.ts:548-570 要等全部工具完成才一次性落库结果。minisd 没有 resume/retry RPC。渲染端 retryLast（stores/chat.ts:618-625）是重新 send 最后一条用户文本，会在历史里重复一个用户回合、丢掉附件，入口挂在内存里的 eventNotes 上，重载就没了
- 备注：要与优雅退出、运行态快照放在一起做。最小子集：新增 chat.resume(sessionId)，按历史尾部的形态分别处理，不新写用户消息；工具结果改为逐个落库；启动时把残留的 running 回合标成「上次中断」，由用户决定是否继续，绝不自动续跑

**流式渲染性能：服务端合并窗口 + 帧合批 + 增量 Markdown + 历史解析缓存**

- DSH（shipped）：packages/api/session-controller/src/client/sessions/notifier.ts 分三档：结构性更新走微任务、可见流式更新按 rAF 每帧最多一次、手势回显同步；packages/client/ui-primitives/src/markdown/incremental.ts 冻结除最后 2 块外的所有块，未闭合围栏另设一条前沿（08-31）；压测 10 万个 chunk，主线程预算 250ms（dsh.md R4）
- OpenMinis（shipped）：iOS 按回复长度分 6 档刷新（0.2s 到 2s），另有换行快通道；Android 对已冻结的超过 32K 字的消息默认折叠，流式缓冲超过 8K 降级为纯文本尾窗（openminis.md R5）
- ZCode（shipped）：coalesce 纯函数，flushWindowMs 分 30ms 与 150ms 两档，不变量是合并前后的终态逐字节一致（zcode.md R4）
- pi（shipped）：AdaptivePublisher 默认最小间隔 100ms、目标 100KB/s，按编码字节数「购买」冷却时间（0095bce，基线后）；mini 按 entry id 追加，只在前缀分歧时整体重绘（pi.md R4）
- DeskMinis：服务端：index.ts:746 对每个 LoopEvent（包括每个 textDelta）立即 rpc.broadcast，没有合并窗口。渲染端：stores/chat.ts:504 每个 textDelta 直接拼到 streamingText；StageChat.vue:126 的 streamNodes 对整段流式文本全量 parseMarkdown；:139 的 mdOf 是模板里的普通函数，:189 对每个历史文本块调用。因为模板引用了 streamNodes，每个 delta 都会让整个组件重渲染，把全部历史块重新解析一遍。渲染层 grep 不到 throttle 或 coalesce，只有贴底滚动用了 rAF（:152）
- 备注：四步：(1) textDelta 先写进非响应式缓冲，每帧合并一次；(2) 历史块按 messageId + 长度缓存解析结果，或抽成子组件；(3) 给自研 parse 包一层增量解析，用性质测试保证与全量解析逐块相等；(4) 用 FakeProvider 发 1 万个 delta 压测，并在 xvfb 下目视检查。零依赖

**事件按会话订阅投递，不再向全部连接广播**

- pi（shipped）：pi-server 用 {serverId, sessionId, attachmentId} 路由，订阅更新只发给发起订阅的那个附着；mini README 把「向所有展示端广播，N 端 N² 次」列为已知捷径（pi.md R4）
- ZCode（shipped）：按会话订阅 base{logEpoch,seq}；connection-scoped facade 在转发前剥掉客户端可伪造的身份字段（zcode.md R4）
- DSH（partial）：客户端的逻辑流按订阅组织（dsh.md R5）
- DeskMinis：rpc/server.ts:122-125 的 broadcast 遍历全部 clients；:82 把所有通过鉴权的连接都加进 clients，包括 authMode 为 pairing 和 remote 的配对端。结果：每个 textDelta（index.ts:746 逐条广播）和每个 permission.request（:307，带写文件 preview 全文）都会推给已连接的配对设备，甚至推给只凭 8 位配对码、仍处于 pairing 态的连接。remote/index.ts:249-257 的 guardBusinessMethod 只拦 pairing，所以 remote 态的设备可以调 permission.respond
- 备注：做法：每个连接维护 subscribedSessions，chat.event 和 permission.request 只投给订阅了该会话的连接；*.changed 这类失效通知可以继续广播。动手前要先请用户拍板接力语义：配对的远端能不能批准本机的权限卡

**逐条消息记录实际出答模型（用量不随会话改绑而漂移）**

- OpenMinis（shipped）：v1.13 给 messages 追加 model_id、model_display_name、provider_type、provider_instance_id 四个可空列；fetchUsageStats 改为 COALESCE + LEFT JOIN；同步回写时用 COALESCE(?, col)；Android schema 12 有迁移测试（openminis.md R5）
- pi（shipped）：AssistantMessage 记录 responseModel 和 providerThinkingLevel；getUsageCostBreakdown 按 provider + responseModel 分组；harness 另有只追加的 usage ledger（pi.md R4、R3）
- DeskMinis：db.ts:13-20 的 messages 表只有 token_usage 等字段，之后的 ALTER 只加了 origin_device_id 和 created_locally_at（:56-57）。loop.ts:524-526 落库助手消息时只带 tokenUsage，不带实际出流的 slot。index.ts:735-743 降级成功后用 setModelBinding 改绑会话，此后这个会话的全部历史用量都会算到接手的模型头上。wire.ts:41 的 modelId 是会话级字段
- 备注：历史数据补不回来，列加得越早越好，面板可以以后再做。做法：一条追加迁移加四个可空列；loop 落库时写入 slotLabel 对应的身份；sync wire 以可选字段携带，合并端用 COALESCE。要同步改六个版本钉，并在 commit 里申报

**数据备份与恢复（包格式、口令加密、合并式恢复）**

- OpenMinis（shipped）：v1.13 的 minisbak/1：明文 manifest + JSONL 分片 + 内容寻址 blobs；minisbak-enc/1 用 PBKDF2 60 万次 + HKDF + AES-GCM 按 4MiB 分段；恢复按记录合并、updated_at 取新，逐文件原子替换，带 rollback-<runId>；iOS Backup 目录 +9041 行。已核实还没接上的：resumingAt 没有调用方、加密包不走流式路径、导出前不查可用空间（openminis.md R4、R3）
- AionUi（partial）：只有「损坏库经用户确认后先备份再重建」（aionui.md R4）
- DeskMinis：src/minisd 全局 grep backup、db.backup 零命中（loop.ts 里只有 mock-backup 这个字样）。README「数据存在哪」只说卸载不删目录，没有导出或导入；会话也不能导出
- 备注：第一版（L）：better-sqlite3 自带的 db.backup() 做整库快照，加上 memory/skills/配置目录打包，再加一个恢复向导。口令加密与按记录合并的恢复是后续一波（XL），用 node:crypto 的 pbkdf2/hkdf/aes-256-gcm 和 zlib.crc32，全是内置。凭证段必须口令加密，因为 DPAPI 换机后解不开。产物放 %LOCALAPPDATA%，绝不落进会话工作区。先定删除墓碑，否则「恢复旧备份」会和「对端推回已删会话」缠在一起

**同步字段演进与删除语义（键在不在的语义、COALESCE、删除墓碑、分类开关穷举）**

- OpenMinis（shipped）：folderId 按 fields[key] != nil 区分语义，键存在（哪怕是显式 null）才清空本地值；快照列用 COALESCE(?, col)；文件夹删除以墓碑传播；UploadPolicy 漏登记类型（#98）后建议做编译期穷举；迁移有挂起态和进度钳制（openminis.md R4、R3）
- DeskMinis：删除墓碑：db.ts:11 预留了 remote_tombstoned_at 列，但全仓没有任何读写；chat.sessions.delete（index.ts:517-522）只 deleteSession，不留墓碑，对端下次 pull 会把已删的会话推回来。字段演进：chat-store.ts:419-428 更新会话元数据时用 ws.modelBinding ?? null 和 ws.pinnedAt ?? null，缺键就清空。但这两个键在唯一发布版 v0.1.1（commit 6c48c8b 的 wire.ts:45-46）就已经有了，现存对端不会缺键，只是今后加字段时的隐患。记忆不在线格式里：wire.ts 只有 WireMessage、WireCompactMarker、WireSession、WireSessionFile 四类，会话级只同步 memoryEnabled 开关（:44）
- 备注：已删会话被对端复活，是用户看得见的错误。墓碑要先出设计稿，因为它和备份恢复、会话桶回收都有交互。字段演进规则写成「'key' in obj 才覆盖」，加一条「旧版 wire 载荷回放」单测

**迁移安全：出错回滚、迁移前备份、历史迁移不可变的校验**

- pi（shipped）：durable 先校验版本号从 1 起连续，用 BEGIN IMMEDIATE，出错 ROLLBACK；关闭时 wal_checkpoint(TRUNCATE)；表用 STRICT + json_valid。反例：sqlite-node 原地改写了 001_initial.sql（pi.md R4）
- ZCode（shipped）：schema_migration 表记录每条迁移的 sha256，启动重算，不一致就抛 checksum_mismatch（zcode.md R4）
- DSH（shipped）：只写相邻的 vN→vN+1 流式迁移，新版旁路写成 session.vN.jsonl，绝不改写已提交的旧版本（dsh.md R2）
- OpenMinis（shipped）：迁移有挂起态、非破坏性重置、进度钳制（#141/#154）；Android 有迁移测试（openminis.md R3）
- AionUi（partial）：损坏库经用户确认后先备份再重建；迁移失败单独归类（aionui.md R4）
- DeskMinis：db.ts:196-201 每条迁移只是 BEGIN / exec / COMMIT，exec 抛错时没有 ROLLBACK。没有迁移前备份，没有 quick_check，也没设 synchronous。「历史迁移不可改」只靠 db.ts:28-165 各处的注释和六个 user_version 版本钉测试维持
- 备注：成本最低的一步：加一条守卫测试，把 MIGRATIONS[0..10] 每条的 sha256 钉死；runner 改用 db.transaction() 包裹。迁移前先 wal_checkpoint，再 copyFileSync 一份 minis.db.bak-v<N>

**协议版本与能力握手（同步对端、remote 与 CLI 客户端）**

- ZCode（shipped）：hostCapabilitiesSchema 的能力位全部是可选布尔，缺失就等于 false，只允许用 === true 判断；hello 带 protocolVersion（zcode.md R3）
- DSH（shipped）：Host 生命周期协议版本 4（host-protocol.ts，dsh.md 总述）
- pi（experimental）：protocol v8 的 hello 返回逻辑 serverId，严格 JSON（pi.md R2）
- OpenMinis（partial）：同步新增字段一律做成可选字段，不升协议版本，用「键在不在」区分语义（openminis.md R4）
- DeskMinis：sync/rpc.ts:77 的 sync.hello 只收 nonce，返回 mac 和 listenPort，没有 protocolVersion 或 appVersion。wire.ts 只在 WireCompactMarker 上有 version:2（:34/:108），会话级握手不协商版本
- 备注：v0.1.1 已经带同步，以后不同版本的设备混用一定会遇到。版本不兼容时明确拒绝并提示升级，不要静默断开

**长会话列表：分页加载、滚动锚定、回到底部、性能预算门禁**

- DSH（shipped）：滚动所有权：ResizeObserver 跟随，用户的移动先记 pending，到 scrollend 才定论，有回到底部按钮，「加载更早」以首个可见内容为锚点（use-scroll-follow.ts 09-22）；benchmarks/long-session-browser 合成 240 回合，打开、翻页、进入 Trajectory 的预算为 900/700/520ms，余量 ×1.25（dsh.md R3）
- ZCode（shipped）：跟随态只由真实用户输入改变，BOTTOM_ANCHOR_EPSILON_PX=48；每个会话记住滚动位置，LRU 200 条；运行中的尾部不进虚拟列表（zcode.md R4）
- pi（shipped）：可点击的 Jump to latest（0.85.0）；按 entry id 追加渲染（pi.md R2）
- OpenMinis（partial）：大消息默认折叠（openminis.md R5）
- DeskMinis：chat-store.ts:254-255 的 listMessages 一次取全部，chat.messages.list（index.ts:581）没有分页参数；stores/chat.ts 每次 turnEnd 或 error（:524/:536）都 open() 整个会话重拉。StageChat.vue:57-66 的 resultOf 对每个 toolUse 遍历全部消息，在 turns computed 里是 O(n²)，只在 messages 变化时重算。:141-146 任何 scroll 事件都按距底 120px 重算 following。没有回到底部按钮，没有虚拟列表；已有的是 Y5 锚点轨（:231）
- 备注：虚拟列表库违反零依赖，只能自己写。性能门禁可以用现有 Electron e2e 做一个 e2e:perf，预算写成常量，并注明是在哪台真机上测的

**渲染进程 / GPU 崩溃恢复**

- AionUi（shipped）：rendererRecovery 纯函数按 [0,1s,3s] 退避重载，5 分钟内再次 relaunch 就放弃；gpuRecovery 累计 3 次 GPU 崩溃后禁用硬件加速，过重置窗口自动恢复，用户可强制开关（aionui.md R4）
- ZCode（partial）：packages/desktop/src/main/index.ts:2326 的 render-process-gone 只复位快捷键录制态；renderer 刷新时 Main 不杀 Host，只补挂 MessagePort（zcode.md R5；本次补查）
- DSH（partial）：崩溃报告里附带渲染端 error 级控制台尾部（dsh.md R5）
- DeskMinis：src 下 grep render-process-gone、child-process-gone 零命中
- 备注：Windows 上显卡驱动导致的白屏很常见。全部用 Electron 内置 API；策略写成注入 now 的纯函数，状态存进 dataRoot 下一个小 json；设置页加一个「禁用硬件加速」开关

**更新或退出前的忙碌检查与准入锁**

- DSH（shipped）：update-tasks.ts 走 inspect→lock→排空：有运行中的 agent、非空 inbox 或 job 时，确认框改成 warning，默认焦点在「稍后」；确认后新请求一律回 503（dsh.md R4）
- AionUi（partial）：NSIS 按 $INSTDIR 结束进程树，用 Restart Manager 查文件占用，把 installer-last-failure.json 回传给下次启动（aionui.md R4）
- ZCode（partial）：packages/desktop/src/main/index.ts 的 before-quit 用 shouldConfirmAppQuit 做应用级退出确认（本次补查）
- DeskMinis：main/index.ts:131-145：update-downloaded 后弹「稍后再说 / 重启并安装」，默认焦点在稍后，这部分已有。但选安装就直接 quitAndInstall，不检查 inFlight、待批权限或 cron。minisd 方法表里没有 activeWork 一类的查询
- 备注：依赖上一行的 shutdown RPC。新增 system.activeWork，返回 inFlight、待批权限、运行中的 cron，据此把确认文案改成 warning

**命令幂等（clientMsgId / requestId 去重）与断线不自动重放**

- ZCode（shipped）：命令信封带客户端生成的 commandId（uuid v7，重试不变），ACK 有 accepted/rejected/stale/duplicate/noop/failed 六种；CommandInbox 每会话 512 条 LRU（zcode.md R4）
- pi（experimental）：Pico5 的 submissionByRequest 在会话内按 requestId 去重（durable 包 09-18 新增，pi.md R2）
- DSH（partial）：乐观发送，失败时恢复草稿（dsh.md R5）
- DeskMinis：chat.prompt 的参数里没有 clientMsgId（index.ts:582），只有 inFlight 拒绝（:599），前端只有 X 波的重入闸
- 备注：现在没有重连，所以暂时不会重放；但一旦做了自动重连就必须同时做这一项，否则断线前已被接纳的 prompt 被用户再点一次就会重复落库

**结构化 RPC 错误码（code / retryAfterMs，界面按码组织中文文案）**

- ZCode（shipped）：PromiseError.data 带 code/kind/status/retryAfterMs/traceId，业务侧抛稳定码，如 REMOTE_SESSION_OFFLINE（zcode.md R4）
- DSH（shipped）：拒绝原因以 {code, params} 记录返回，由各端自己组织措辞；审批结果只有四种封闭值（dsh.md R2、R4）
- pi（partial）：protocol v8 用严格信封，拒绝未知字段（pi.md R2）
- DeskMinis：rpc/server.ts:105 只有 -32601，:112 一律 -32000 加 message 字符串；渲染端 rpc.ts:52 只读 msg.error.message
- 备注：对应教训 2「内部标识符漏给用户看」。可以逐步迁移：先覆盖断连、会话运行中、库比程序新、配置读失败这几类，测试断言 code 而不是断言字符串

**删除或归档运行中的会话前先停止它的工作**

- DSH（shipped）：cbae324bf（09-21）：用 workspace/session-activity 瀑布逐个询问回合、子代理、作业和提醒是否还在跑，有就拒绝归档并列出清单；用户确认「停止并归档」后逐项停止（dsh.md R4）
- AionUi（shipped）：core #925 在归档时拆掉该会话的 agent 进程（只能凭 CHANGELOG 判断，aionui.md R4）
- OpenMinis（partial）：恢复备份时跳过正在运行的会话并计数（openminis.md R4）
- DeskMinis：index.ts:517-522 的 chat.sessions.delete 只做 terminals.dispose 和 chat.deleteSession：不查 inFlight，不 abort controller，也不释放该会话的 shell。运行中的循环会继续往已删除的会话写消息（后果尚未实测）
- 备注：先写红测：inFlight 时删除要返回「会话正在运行」。二次确认改为「停止并删除」：先 abort，等 run 结束再删；定时任务的 lastSessionId 也要一并处理

**开发态与正式版的数据隔离**

- AionUi（shipped）：packages/desktop/src/process/utils/configureChromium.ts：未打包时 setName(devAppName)，并 setPath('userData', dev 目录)；E2E 用一次性的 userData（aionui.md R4）
- DeskMinis：paths.ts:9-13 只认 DESKMINIS_DATA_DIR，否则用 %APPDATA%\DeskMinis；KeyringVault 的服务名固定为 'DeskMinis'（provider-store.ts:41）。于是 npm run dev 会用新迁移改写用户真实的 minis.db、读写真实密钥，之后再打开已安装的旧版，就会触发上面的「库比程序新」
- 备注：只追加：dev 下默认用 %APPDATA%\DeskMinis-dev，keyring 服务名加 -dev 后缀，DESKMINIS_DATA_DIR 仍然优先。开发和发布验证都在同一台 Windows 真机上，这一项价值不低

## 桌面体验与界面（29 项）

| 能力 | 几家有 | 新趋势 | DM | 价值 | 成本 | 需新依赖 | 许可路径 |
|---|---|---|---|---|---|---|---|
| 会话「等待你/运行中/未读」徽标与跨会话运行态 | 5（AionUi、OpenMinis、ZCode、DSH、pi） | 是 | 缺 | 5 | M |  | AionUi（Apache-2.0）的 reducer 形态可移植成 lib/ 纯函数，需署名；OpenMinis 徽标优先级只借思路 |
| 应用事件系统通知与任务栏注意力（待确认/回合完成） | 4（AionUi、DSH、ZCode、OpenMinis） | 是 | 缺 | 5 | M |  | 全部用 Electron 内置 API；去重和文案规则借 AionUi（Apache-2.0）/DSH（MIT）思路 |
| 用量与成本面板（全口径 usage、缓存读写、按实际模型归属） | 4（pi、OpenMinis、DSH、ZCode） | 是 | 缺 | 5 | L |  | pi 的计价与口径代码（MIT）可移植，保留署名；OpenMinis 的四态与同步 COALESCE 规则只借思路；ZCode 的 tokenlens 属于新依赖，不引，单价从已在拉取的 models.dev 数据里解析 |
| Markdown 渲染完整度（h1–h6、图片、任务列表、表格对齐、数学公式） | 5（AionUi、ZCode、DSH、pi、OpenMinis） |  | 部分 | 4 | M |  | 在自研零依赖 parser 上扩展，借 AionUi/ZCode（Apache-2.0）的节点覆盖清单和表头对齐修正思路；OpenMinis 只借思路 |
| 代码块语法高亮（聊天与预览源码态） | 5（AionUi、ZCode、DSH、pi、OpenMinis） |  | 缺 | 4 | M |  | 零依赖自建。OpenMinis 的 94 行自写高亮器证明轻量路线可行，但 GPLv3 只能借思路；shiki/highlight.js 属于新依赖，不引 |
| 快捷键注册表与全局快捷键（过滤 IME 和 repeat、可重绑） | 5（ZCode、pi、AionUi、OpenMinis、DSH） |  | 缺 | 4 | M |  | ZCode 的 matchesBinding 思路（Apache-2.0）、pi 的 keybindings 表（MIT）可借，需署名 |
| 模型选择器（搜索、分组、明示「默认」、与胶囊一致） | 5（pi、ZCode、OpenMinis、AionUi、DSH） | 是 | 部分 | 4 | M |  | 只借交互思路；搜索和排序是纯函数自写 |
| 全文搜索（跨会话正文 + 会话内查找高亮） | 5（AionUi、ZCode、DSH、pi、OpenMinis） |  | 部分 | 4 | M |  | 只借思路；SQL 用 LIKE 自写 |
| 消息悬停操作条（复制、编辑重发、重试、从此删除、分叉入口） | 5（OpenMinis、DSH、pi、ZCode、AionUi） |  | 缺 | 4 | M |  | 交互只借思路；复制可以直接复用 MarkdownView 已有的剪贴板逻辑 |
| 流式渲染性能（增量解析、帧合批、历史解析缓存、超长消息折叠） | 4（OpenMinis、DSH、ZCode、pi） |  | 缺 | 4 | M |  | DSH/pi（MIT）的增量解析包装和发布器可移植，需署名；ZCode coalesce（Apache-2.0）；OpenMinis 的分档常数只借思路 |
| 已完成回合自动折叠与过程分组标题（「已工作 N 分钟」） | 4（DSH、ZCode、AionUi、OpenMinis） | 是 | 部分 | 4 | M |  | DSH（MIT）的折叠条件表和类别标题规则可移植，需署名；ZCode（Apache-2.0）纯函数思路 |
| 工具调用「准备中」行与执行中进度流 | 4（DSH、pi、ZCode、OpenMinis） | 是 | 缺 | 4 | M |  | pi 的 AdaptivePublisher（MIT，约 80 行）可以照抄，需署名；DSH 准备中行规则（MIT） |
| 输入区停靠区（审批、提问、计划、队列接管输入区，不埋进消息流） | 4（DSH、AionUi、ZCode、pi） | 是 | 部分 | 4 | M |  | DSH（MIT）的挂载规则可借代码；AionUi（Apache-2.0）的计划条尺寸常量可借，需署名 |
| 预览面板增强（最大化、tab 右键菜单、在文件夹中显示/系统程序打开、路径由后端给） | 4（AionUi、DSH、ZCode、OpenMinis） | 是 | 部分 | 4 | M |  | Electron 内置 shell.openPath/showItemInFolder；AionUi 判别联合 previewTabPaths 思路（Apache-2.0） |
| 会话归档（可恢复）以及归档/删除前停止运行 | 3（AionUi、DSH、ZCode） | 是 | 缺 | 4 | M |  | 只借交互与语义（AionUi Apache-2.0、DSH MIT）；实现走 DeskMinis 自己的追加迁移和同步 |
| 思考档位控件（按模型列出可用档、钳制提示、按会话记忆） | 3（OpenMinis、pi、ZCode） | 是 | 缺 | 4 | L |  | 思路借 OpenMinis；夹取函数可参考 pi（MIT） |
| 消息内链接与路径（外链交系统浏览器、路径可点击、Windows 路径解析） | 3（DSH、ZCode、OpenMinis） | 是 | 坏 | 4 | M |  | 窗口守卫是 Electron 内置 API，思路来自 DSH（MIT）；路径链接规则可移植 DSH 纯函数，需署名 |
| 空会话助手空态（从结构上修掉欢迎页选助手的撒谎） | 2（AionUi、ZCode） | 是 | 坏 | 4 | M |  | AionUi（Apache-2.0）的尺寸数值和判定条件可借，需署名 |
| 命令入口：Ctrl+K 命令面板与斜杠命令分组（/模型 /权限 /压缩） | 5（ZCode、DSH、pi、AionUi、OpenMinis） | 是 | 部分 | 3 | M |  | cmdk 是依赖，不引，自写 listbox；DSH（MIT）的命令数据表形态和 AionUi（Apache-2.0）的菜单尺寸可借 |
| 工具步骤语义摘要与输出清洗（分类标题、ANSI 剥离、分块展开） | 4（ZCode、DSH、OpenMinis、pi） | 是 | 部分 | 3 | M |  | ZCode 的分类正则（Apache-2.0）和 pi 的 details 结构（MIT）可借，需署名；OpenMinis 清洗规则只借思路 |
| 输入法合成保护（IME） | 4（AionUi、ZCode、DSH、pi） |  | 缺 | 3 | S |  | 纯函数自写；思路来自 AionUi/ZCode |
| 可拖分栏与布局记忆（吸附收起、双击复位、键盘可调） | 4（AionUi、ZCode、OpenMinis、DSH） | 是 | 缺 | 3 | M |  | AionUi 的阈值和常量（Apache-2.0）可借，需署名；composable 自写 |
| 字体与缩放偏好（分区字体、字号、Ctrl+=/−/0） | 4（AionUi、ZCode、OpenMinis、DSH） | 是 | 缺 | 3 | M |  | AionUi 区域规格表思路（Apache-2.0）；queryLocalFonts 是 Chromium 内置 |
| 滚动所有权与回到最新 | 4（ZCode、DSH、pi、OpenMinis） | 是 | 部分 | 3 | S |  | 都是原生 API，思路来自 ZCode/DSH |
| 上下文占用可见性（输入区占用环、按来源拆分、实测或估算标注） | 3（DSH、ZCode、pi） | 是 | 部分 | 3 | M |  | pi/DSH（MIT）的锚定算法可移植，需署名 |
| 多面板对话墙（同屏并排多个会话） | 3（AionUi、ZCode、DSH） |  | 缺 | 3 | XL |  | 只借布局模型思路（ZCode Apache-2.0 的分割树纯状态机可参考） |
| 外观偏好首帧生效与持久化（主题、标题栏按钮颜色） | 2（DSH、ZCode） | 是 | 坏 | 3 | S |  | 思路来自 DSH（MIT） |
| 国际化（i18n） | 4（AionUi、ZCode、DSH、OpenMinis） |  | 缺 | 2 | XL |  | 自写 t() 字典即可，不需要 i18next |
| 图表渲染与全屏查看（Mermaid、图片/SVG lightbox） | 3（AionUi、ZCode、pi） | 是 | 缺 | 2 | L | 是 | lightbox 交互可借 AionUi DiagramZoomOverlay 的常量（Apache-2.0，需署名），零依赖自写约百行；Mermaid 渲染只能引 mermaid |

### 本簇跨项目观察

- 运行态可见性是五家本期共同的主线，也是 DeskMinis 缺口最集中的地方：AionUi 的「等待你」徽标和待确认通知（v2.2.1）、DSH 的「准备中」工具行（09-22）和 flashFrame 注意力提示、ZCode 的会话快照恢复与阻塞徽标、pi 的 ui_prompt_start/end。DeskMinis 的根因是结构性的：渲染端只跟踪一个 activeId（stores/chat.ts:142 丢弃其它会话的事件，切会话就把 running 清零），minisd 不提供 running/pending 查询。徽标、系统通知、对话墙、断线恢复缺的是同一块地基，应作为「按会话状态投影 + 快照 RPC」成批做，不要逐个界面打补丁。
- 「过程退后、结果突出」是第二条共同走向：DSH 整回合自动折叠加过程分组标题，ZCode 的「已工作 N 分钟」，AionUi 把计划从消息流移到输入框上方的计划条，DSH 让审批和提问接管输入区。DeskMinis 的 StepGroup 已经默认折叠，但回合级折叠、工时、停靠区都没有，PermCard 还埋在消息流末尾，可能被滚出视口。
- 流式渲染性能各家都做了节流、合批、增量解析：OpenMinis 分档节流、DSH rAF 合帧加冻结前缀（10 万 chunk 压测）、ZCode 30ms coalesce、pi AdaptivePublisher。DeskMinis 每个 delta 全量重解析，历史消息每次重渲染都重解析（StageChat.vue:126/139），是典型的「多家都在做、DeskMinis 缺失」。建议和 Markdown 补全、语法高亮合成一次「消息渲染管线」定向重写，TDD 用性质测试（增量等于全量）兜底。
- 渲染栈上四家靠成熟库堆叠（react-markdown/streamdown/shiki/katex/mermaid/highlight.js），只有 OpenMinis Android 用 94 行自写高亮器。零依赖约束下 DeskMinis 能自建 GFM 补全、轻量高亮、增量解析、lightbox；数学公式排版和 Mermaid 做不好，要么显式列为「需用户破例」，要么保持诚实降级（等宽原文加复制）。
- 用量与成本方面，pi、DSH、OpenMinis、ZCode 都补齐了缓存读写口径，并坚持「不精确就不显示、单价未知显示—」，按实际响应模型归属。OpenMinis v1.13 的教训（会话级 model_id 随降级改绑，导致十亿 token 错账）对 DeskMinis 同样适用：先用追加迁移补列和口径（历史补不回，越早越好），面板后做。
- 布局上，可拖分栏已是桌面 agent 的标配：AionUi 吸附收起加双击复位、ZCode 4px 缝加有序自动收栏、OpenMinis 平板分栏、DSH dockkit。对话墙两家都走「单窗口多面板」（ZCode paneLayoutTree、AionUi Team parallel 视图），而不是多个 BrowserWindow。这给 DeskMinis 的「多窗口对话墙」设计稿一个方向提示：优先单窗口分屏，避开多窗口加单 minisd 的全量广播和状态同步问题。
- 参考项目本期在视觉上几乎零变更（AionUi 设计 token 无 diff，只新增分区字体变量），新增集中在交互模型和状态可见性上。这印证了交接文档的结论：本簇不需要第三次整体换皮，应按能力差距逐项迁移。对应方向建议：只对「会话状态投影层」和「消息渲染管线」两处做定向成批重写（B），其余都是 S/M 级的点状补齐（A）。
- 要警惕的反面做法：(1) AionUi 为了 queryLocalFonts 把所有 Electron 权限请求一律放行，DeskMinis 做字体设置时只放行 local-fonts；(2) AionUi 的 confirmation.add/update 死事件通道潜伏多版，DeskMinis 托盘菜单的两条 IPC 正是同类死通道，只靠「preload 含字符串」的守卫抓不到；(3) ZCode 的 DESIGN.md 规则没有守卫，已漂移出 26+7 处硬编码字号，206 个文件豁免 max-lines；(4) AionUi 着色和真实附件不一致的教训：「着色必须等于真的附上了」；(5) ZCode 的 Office 简洁模式隐藏命令原文、权限规则按 160 字截断，DeskMinis 做简洁显示时权限卡必须逐字；(6) AionUi 靠新增 wavedrom/json5 依赖扩图表，DSH 客户端拆成约 60 个插件包加 Lexical，复杂度都不宜照搬；(7) OpenMinis 助手菜单的 Copy All 与 Copy Markdown 是逐字相同的代码（入口重复，名不副实）。
- 可访问性上，OpenMinis 新增了回合结束读屏播报（aria-live），DSH 把「反馈面按消息寿命选择、浮层三验、双主题校验」写成评审技能。DeskMinis 的 ui/ 里没有 aria-live 和 role=status，toast 也只在 StageMarket 里私有实现。成本低，可以随等待态和通知一起补。

### 对 DeskMinis 现状说法的纠正

- 补充 AionUi 核验：不只是渲染端丢了 permission.request 的 sessionId（stores/chat.ts:155-161，PendingPerm 类型 chat.ts:10 没有这个字段）。ui/StageChat.vue:216 还会把全部 pendingPerms 渲染进当前打开的会话，所以别的会话或定时任务的权限卡会出现在用户正在看的会话里，没有来源标注，用户无法判断是谁在申请。这属于「界面撒谎」，不只是「缺徽标」。
- 补充 pi 核验（「切换运行中会话会丢流式文本和工具卡」）：open() 在切会话时把 running 置 false（stores/chat.ts:397），onEvent 没有任何分支会恢复它。切回仍在运行的会话后，Composer 显示「发送」而不是「停止」（Composer.vue:341-346），用户在回合结束前无法从界面停止这个会话；这时发送会撞上 minisd 的「该会话正在运行中」（index.ts:599）。
- 新发现一处换壳遗失入口，不在交接「九处收窄」清单里：托盘菜单「打开设置」「切换右栏」（main/index.ts:77-78）只会把窗口调出来。preload/index.ts:17-27 暴露了 onMenuOpenSettings/onMenuToggleRight，但新 UI 树没有任何订阅方；tests/renderer-settings-modal.test.ts:53-55 只断言 preload 里有这两个字符串，是「有守卫 ≠ 有覆盖」的又一例。
- deskminis-state 写的「Markdown 只有 h2/h3」「h1 和 h4 以上不区分」需要说得更准：HEADING_RE=/^(#{1,3})\s+/（parse.ts:127）加 level 映射（parse.ts:186），结果是 # 渲染成 h2，而 #### 及以上根本不被识别为标题，会以段落形式原样显示「#### 」。
- 新发现一处小的界面撒谎：StepGroup 里运行中的步骤用 --c-ok 绿点（StepGroup.vue:83；StageChat 实时映射 ok: c.success !== false），和已成功的步骤外观一样；没有收到 toolEnd 的中断步骤在重载前也一直显示为绿点。
- 「模型选择器无搜索」要细化：设置页 SecModels.vue:175 有 <datalist>，填模型 ID 时有原生过滤；真正没有搜索的是会话绑定（NavRail.vue:131-142 的原生 select）和输入卡胶囊（Composer.vue:339，只读 span，不能点选）。ModelBar.vue:17 回落到 items[0] 属于猜测默认，和 AionUi 核验的判断一致。
- 预览面板：Office 解析失败卡和旧格式卡都叫用户「请用系统应用打开」，却只提供「复制完整路径」，preload 白名单里没有 openPath/showItemInFolder。README:26 也让用户「用系统 Office 打开」。这不算撒谎，但承诺的出路在应用里没有入口。copyPath 在渲染端拼路径（PreviewPane.vue:71），和 AionUi 核验一致。
- DSH 核验说「启动时不恢复已保存的主题」，属实，补充两点：renderer/index.html 完全没有启动脚本；AppShell.vue:64-67 的 ☰ 只做浅深切换、不持久化，也覆盖不到「跟随系统」。标题栏 symbolColor 固定为 #808080（main/index.ts:92），这一点也属实。
- deskminis-state 说长会话性能隐患是「从代码推断」，亲自读码确认代码层面属实（StageChat.vue:126 流式全文重解析、:139 mdOf 模板函数、resultOf 双层遍历），但仍没有实测数据，建议立项前先用 FakeProvider 压测量化。

### 逐行证据与备注

**会话「等待你/运行中/未读」徽标与跨会话运行态**

- AionUi（shipped）：v2.2.1 7d1c7b7：纯 reducer applyWaitingConfirmationTransition（mark/unmark/clear），侧栏 Attention 图标优先级 等待>Spin>未读（aionui.md R5 条）；局限：重载后只补标打开过的会话
- OpenMinis（shipped）：会话行按优先级显示 SpinningRing/paused/unread 徽标（openminis.md R4「后台完成通知、会话行运行/未读/中断徽标」）
- ZCode（shipped）：会话列表阻塞交互绿色 confirmation 胶囊 + 未读点（zcode.md R3「会话列表阻塞交互徽标」）
- DSH（partial）：client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx collapsedSessionRows：运行中行（含子代理在跑的父会话）不计入折叠配额
- pi（partial）：RPC 事件 ui_prompt_start/end（0.84.4）区分「在等用户回答」与「真的在干活」（pi.md R2 question 条）
- DeskMinis：亲自核对：ui/NavRail.vue:118-122 会话行只有 emoji/色点+标题；stores/chat.ts:142 非当前会话的 chat.event 全部丢弃；stores/chat.ts:155-161 permission.request 入队时丢掉 req.sessionId（minisd tools/types.ts:21 本就携带）；PendingPerm 类型（chat.ts:10）无 sessionId；chat.ts:397 切会话即 running=false；minisd 的 inFlight 是 index.ts:404 私有 Set，chat.* 方法表里没有 running/pending 查询 RPC
- 备注：补两个只读 RPC（permission.pending、chat.sessions.running），覆盖全部会话，不要学 AionUi 只补打开过的会话。连带修两处界面撒谎：别的会话的权限卡出现在当前会话里；切回运行中的会话后停止键消失（见 corrections）。同批多张权限卡同时弹出属于已降级的缺陷 2，只作为低优先级顺手处理。定时任务无人值守时收益最大（90 秒自动拒绝）

**应用事件系统通知与任务栏注意力（待确认/回合完成）**

- AionUi（shipped）：cbabbc8/7d1c7b7：桌面通知扩展到待确认（权限、ask），按 conversation_id+msg_id 去重，正文带会话名截 20 字；聚焦时不弹、点击后跳转在基线就已存在（aionui.md R5）
- DSH（shipped）：update-attention：窗口不在前台时 flashFrame(true)，同一事件只发一条 silent 通知，获得焦点即清（dsh.md R3「后台等待时的注意力提示」）
- ZCode（shipped）：系统通知 silent:true，声音由渲染端播放；supportsAppUnreadBadge 只认 darwin/linux（zcode.md R3）
- OpenMinis（shipped）：iOS 完成通知取最后一段纯文本，剥 Markdown、截 200 字，另有 Live Activity 隐私模式（openminis.md R4）
- DeskMinis：亲自 grep：src/main/index.ts 里 Notification、flashFrame、setProgressBar、setOverlayIcon、setAppUserModelId 零命中（全文 233 行，只有 Tray 和托盘菜单）；windows-notify 是 agent 主动调用的桥工具，不是应用事件通知
- 备注：与上一行共用同一个等待集合，mark 时触发。AppUserModelId 必须与 electron-builder appId 一致，否则 NSIS 安装版不出 toast；便携版要单独在 Windows 真机验证。定时任务的待确认通知写明「90 秒后自动拒绝」，避免界面撒谎。设置里加本机开关，并登记进 mu6 WIRED

**用量与成本面板（全口径 usage、缓存读写、按实际模型归属）**

- pi（shipped）：Usage 含 cacheRead/cacheWrite/cacheWrite1h/cost；getUsageCostBreakdown 按 provider+responseModel 分组；footer 显示缓存命中率与累计成本；UsageEntry 为基线后新增（pi.md R4「全口径 Usage」）
- OpenMinis（shipped）：v1.13 messages 追加 model_id 等 4 个可空列，用量页分 measured/estimated/unknownSession/measuredRemoved 四态；注释记录会话级 model_id 导致十亿 token 错账（openminis.md R5）
- DSH（shipped）：client/ui-chat/src/client/chat/TurnUsagePanel.tsx 显示缓存命中率/读/写；回合用量「不精确就不显示」（dsh.md R3 占用环条）
- ZCode（shipped）：packages/ui/src/components/ai-elements/context.tsx 显示输入、输出、总成本（依赖 tokenlens）
- DeskMinis：亲自核对：token 已落库（minisd/agent/loop.ts:526 写 tokenUsage，store/chat-store.ts:231-234 INSERT token_usage），但界面从不展示；providers/anthropic.ts:119 只取 input_tokens，没有 cache_read/creation；providers/openai.ts:107 只取 prompt/completion_tokens；messages 没有逐条模型列（模型只在 sessions，store/db.ts:8）；model-catalog 没有单价
- 备注：先补数据口径再做面板：追加迁移给 messages 加实际出流模型列，token_usage 扩出 cacheRead/cacheWrite。历史补不回来，列越早加越好。单价未知存 NULL，界面显示「—」，不显示编造的 0。按降级后真正接手的模型归属。交接候选池里需求信号最强的就是这一项

**Markdown 渲染完整度（h1–h6、图片、任务列表、表格对齐、数学公式）**

- AionUi（shipped）：packages/desktop/package.json 依赖 react-markdown、remark-gfm、remark-math、rehype-katex、katex；8c671bb 把 th 改为 text-align:start
- ZCode（shipped）：packages/ui/package.json 依赖 streamdown、katex
- DSH（shipped）：client/ui-primitives/package.json 依赖 katex；IncrementalMarkdownParser（dsh.md R4 流式渲染条）
- pi（shipped）：tui 依赖 marked；coding-agent 的 markdown-transform.ts（终端渲染）
- OpenMinis（shipped）：iOS Agent/Markdown/MathRenderScheduler.swift；Android ui/markdown/KaTeXView.kt、MarkdownParser.kt
- DeskMinis：亲自核对：lib/markdown/parse.ts:127 HEADING_RE=/^(#{1,3})\s+/，:186 只映射 level 2|3，所以 # 渲染成 h2，#### 及以上原样显示为段落；MdInline 没有 image 节点；components/MarkdownView.vue 只渲染 h2/h3/codeBlock/ul/ol/blockquote/table/hr，没有任务列表和数学公式
- 备注：GFM 缺的部分（h1/h4-6、任务列表、列对齐、图片）可以零依赖补。数学公式要真正排版就需要 katex（新依赖，需用户破例）；零依赖的退路是用等宽原文显示并加标注。图片只放行工作区内相对路径和 data:，外链图片默认不加载（出网承诺）。继续守住「文本一律插值、不直出 HTML」这条红线

**代码块语法高亮（聊天与预览源码态）**

- AionUi（shipped）：src/renderer/components/Markdown/CodeBlock.tsx + react-syntax-highlighter
- ZCode（shipped）：packages/ui 依赖 shiki、highlight.js；components/ai-elements/code-block.tsx
- DSH（shipped）：client/ui-primitives/package.json 依赖 shiki
- pi（shipped）：coding-agent/package.json 依赖 highlight.js（终端着色）
- OpenMinis（shipped）：Android ui/markdown/SyntaxHighlighter.kt，94 行自写关键字/字符串/注释/数字着色，没有依赖
- DeskMinis：亲自核对：components/MarkdownView.vue:39 `<pre class="md-pre"><code>{{ n.code }}</code></pre>` 是纯文本；ui/PreviewPane.vue 源码态 `<pre class="codebody">` 也是纯文本；交接 §6「其它未做」列有代码语法高亮
- 备注：写纯函数 lib/markdown/highlight.ts，按语言产出 token 数组，模板用 {{ }} 插值渲染（不走 v-html）。先覆盖 ts/js/json/py/ps1/sh/css/html/sql/yaml，颜色走 theme.css 双主题令牌，守卫要覆盖深浅两态对比度。预览源码态复用同一函数

**快捷键注册表与全局快捷键（过滤 IME 和 repeat、可重绑）**

- ZCode（shipped）：SHORTCUT_COMMANDS 声明 id/scope/默认绑定；bindings.ts 对 isComposing/Process/Dead/keyCode 229/repeat 一律不匹配，按 event.code 匹配（zcode.md R4）
- pi（shipped）：coding-agent/src/core/keybindings.ts + keybindings.json 可重绑；interactive/components/keybinding-hints.ts
- AionUi（partial）：zoom.ts 用 before-input-event 处理 Ctrl+=/−/0；预览 Ctrl+W 检查 isComposing 和 repeat（aionui.md R4/R3）
- OpenMinis（partial）：Android Ctrl+N、Ctrl+F（openminis.md R3 可拖分栏条）
- DSH（partial）：Enter/Ctrl+Enter 在排队与插话之间按设置切换（dsh.md R5 续话条）
- DeskMinis：亲自 grep：renderer 全树没有 window/document 的 keydown 监听（唯一的 document 监听是 AnnoLayer.vue:192 的 selectionchange）；main 没有 globalShortcut/before-input-event；Ctrl+, 在换壳时丢了。另外发现托盘菜单「打开设置」「切换右栏」（main/index.ts:77-78）的 IPC 在新 UI 树里没有订阅方
- 备注：在 src/shared 建命令表，写纯函数 matchesBinding（TDD 覆盖 229/Process/repeat）。先挂 Ctrl+, / Ctrl+N / Ctrl+B / Ctrl+J / Esc 停止；Esc 的事件路径上有对话框时跳过。顺手把托盘两条死通道接回来，守卫要认调用形态

**模型选择器（搜索、分组、明示「默认」、与胶囊一致）**

- pi（shipped）：interactive/components/model-selector.ts 用 fuzzyFilter 搜索；scoped-models-selector.ts
- ZCode（shipped）：模型分组；OpenRouter 的 :free 是模型 ID 的一部分，不按冒号拆（zcode.md R3）
- OpenMinis（shipped）：ModelReleaseIndex 按发布日期排序，没有日期的沉底但不隐藏（openminis.md R2，基线后新增）
- AionUi（shipped）：ded1f7d：未选模型一路保持 null，发送时省略 model，不用缓存值或 available_models[0] 顶替（aionui.md R3）
- DSH（shipped）：client/ui-model-selection 包；/model 斜杠命令直接弹选择器（dsh.md R3）
- DeskMinis：亲自核对：ui/Composer.vue:339 模型胶囊是只读 span，不能点选；ui/ModelBar.vue:17 activeId 回落到 items[0]（猜默认），标题也不写「默认」（交接 §6 一档「ModelBar 与胶囊矛盾」）；会话绑定只在 NavRail ⋮ 菜单的原生 <select>（NavRail.vue:131-142），没有搜索；设置页 SecModels.vue:175 只有 <datalist> 的原生过滤
- 备注：胶囊改成可点的弹层选择器（搜索 + 按 provider/组分组），选中后写会话绑定；未绑定时显示「默认 · X」；describeBinding 回落 providers[0] 时明示「默认已失效，临时用 X」；任何入口都不把推测出来的默认值写回绑定

**全文搜索（跨会话正文 + 会话内查找高亮）**

- AionUi（shipped）：GroupedHistory/ConversationSearchPopover.tsx 调 database.searchConversationMessages，关键词高亮、分页、最近搜索
- ZCode（shipped）：command-center/CommandCenterDialog.tsx 任务搜索带 searchSnippets；会话内查找用 CSS Highlight API（zcode.md R3）
- DSH（shipped）：ui-workspace WorkspaceBrowser.tsx 走宿主 session.search 内容搜索，防抖 250ms，查询上限 500 码元
- pi（shipped）：session-selector-search.ts 搜索 allMessagesText，支持 fuzzy/phrase/regex
- OpenMinis（shipped）：searchSessions 用标题或 parts_json LIKE 查询并截片段，不建索引（openminis.md R4）
- DeskMinis：亲自核对：ui/StageSearch.vue:20-24 只在前端内存里按标题过滤（界面上 :37 如实说明了）；minisd 的 chat.* 方法表没有 search，store/ 里没有 FTS 或 LIKE 查询
- 备注：第一版加 chat.sessions.search RPC，用 LIKE 加片段截取，只查 user/assistant 的文本部分。OpenMinis 证明不需要先建索引，这项可以从三档降级。会话内查找复用 AnnoLayer 已有的 CSS Highlight 机制

**消息悬停操作条（复制、编辑重发、重试、从此删除、分叉入口）**

- OpenMinis（shipped）：用户消息有 Edit/Retry/Delete From Here/Compact Above，助手消息有 Copy All/Copy Markdown（反面：这两个执行的是逐字相同的代码）（openminis.md R5）
- DSH（shipped）：ui-chat/src/client/chat/MessageIconActions.tsx；已完成回合的页脚有分叉按钮
- pi（shipped）：/fork /clone /tree，user-message-selector.ts
- ZCode（shipped）：选中文本可开旁路对话；session.revert 回退（zcode.md R3/R4）
- AionUi（partial）：Messages/components/SelectionReplyButton.tsx 选区回复
- DeskMinis：亲自核对：ui/StageChat.vue 的用户气泡（.urow/.ubub）没有复制钮（换壳时丢了）；助手正文没有整条复制，只有代码块复制（MarkdownView.vue:34-37）；只有 AnnoLayer 的引用和标注；minisd 没有截断、重试、分叉 RPC
- 备注：复制整条和复制 Markdown 是 S，先做。编辑重发、重试、从此删除、分叉需要后端 RPC 和「截断后没有孤立 tool_use」的不变量，归会话流程簇。破坏性操作要二次确认，每个菜单项都要有测试

**流式渲染性能（增量解析、帧合批、历史解析缓存、超长消息折叠）**

- OpenMinis（shipped）：iOS 按回复长度分 6 档节流，外加换行快通道；Android 已冻结消息超过 32K 默认折叠，流式缓冲超过 8K 降级为纯文本尾窗（openminis.md R5）
- DSH（shipped）：Notifier 按 rAF 每帧合批；IncrementalMarkdownParser 冻结除最后 2 块外的所有块，08-31 新增未闭合围栏第二前沿；压测 10 万 chunk、主线程预算 250ms（dsh.md R4）
- ZCode（shipped）：coalesce 纯函数加 30ms/150ms flush 窗口，不变量是合并前后终态逐字节一致（zcode.md R4）
- pi（experimental）：AdaptivePublisher（0095bce）最小间隔 100ms、目标 100KB/s；mini 按 entry id 追加渲染（pi.md R4/R2）
- DeskMinis：亲自核对：ui/StageChat.vue:126 streamNodes 每个 delta 都对全文 parseMarkdown；:139 mdOf 是模板函数，每次重渲染都重新解析全部历史；resultOf（StageChat.vue 约 55-66 行）每个工具调用都遍历全部消息，O(n²)；stores/chat.ts onEvent 每个 textDelta 直接拼到响应式字符串上；没有虚拟列表
- 备注：四步：历史消息按 id+长度缓存 AST；delta 先进非响应式缓冲，每帧合并一次；只重解析最后一个未闭合块；超过 32K 默认折叠。用性质测试保证增量解析与全量解析逐块相等，用 FakeProvider 发 1 万个 delta 压测。deskminis-state 标注这是「推断未实测」，要在 xvfb 下量化

**已完成回合自动折叠与过程分组标题（「已工作 N 分钟」）**

- DSH（shipped）：ui-chat 过程组以回复/插话/重试/报错为边界；组标题取次数前三的类别；正常结束的回合自动收起，失败、停止、插话的不折；四档工作详情（dsh.md R5，基线后新增）
- ZCode（shipped）：splitTurnHistory：「工作中/已工作 {duration}」，工时取 header.activeMs 或落库时间戳，不用渲染时钟现算（zcode.md R5）
- AionUi（partial）：Messages/components/MessageToolGroupSummary.tsx 做工具组摘要折叠（基线已有）
- OpenMinis（partial）：思考块限高 300、流结束时收起；v1.12/1.13 修复跟随与失效通知（openminis.md R3）
- DeskMinis：亲自核对：ui/StepGroup.vue:13 默认收起，标题只有「正在执行…/已执行 N 步」（:37-38）；ui/ThinkBlock.vue:9 落库后收起，但 .tbody 不限高；回合内的中间段文本和多组 StepGroup 全部平铺，没有整回合折叠和工时；交接 §6 列「已完成回合自动折叠」为未做
- 备注：只改渲染端。工时用 user.createdAt 到最后一条 assistant.createdAt，不需要迁移。类别映射按 DeskMinis 工具名重写，并和权限网关的只读判定共用一张表。失败或停止的回合保持展开

**工具调用「准备中」行与执行中进度流**

- DSH（shipped）：09-22：同一 callId 贯穿 preparing→start→result，写类工具显示「正在准备内容 N KB」，流失败时隐藏未派发的准备行（dsh.md R4）
- pi（shipped）：tool_execution_update/onUpdate 基线已有；AdaptivePublisher 和 OutputCapture（0095bce，有界 head/tail、落 spill 文件）为基线后新增（pi.md R4）
- ZCode（shipped）：row.delta 流式行加 coalesce 合并投递（zcode.md R4）
- OpenMinis（shipped）：工具实况查看器，按 40 行一块懒加载（openminis.md R3）
- DeskMinis：亲自核对：minisd/agent/loop.ts:417 `case 'toolInputDelta': break; // M1 UI 不用增量预览`（provider 已经发出带 name 的增量）；toolStart 要等整条流结束才发（loop.ts:549）；shell 输出只在 toolEnd 一次性给出；运行中的步骤用 --c-ok 绿点（StepGroup.vue:83，StageChat 实时映射 ok: success!==false），看起来和已成功一样
- 备注：loop 把首个 toolInputDelta 转成 toolPreparing，按约 250ms 节流；store 按 toolUseId 合并；不落库。PersistentShell 边读边推 tail，GBK 兜底解码放在 capture 之前。运行中和中断的步骤要有独立状态点，不能用成功色

**输入区停靠区（审批、提问、计划、队列接管输入区，不埋进消息流）**

- DSH（shipped）：审批面板以 priority 1 替换输入区，默认 composer 仍挂载，草稿不丢；Composer 上方有 GoalBar/TodoPanel/QueueDock（dsh.md R4 两条）
- AionUi（shipped）：v2.1.61 300e3e1 ConversationPlanBar 钉在输入框上方；CommandQueuePanel 草稿箱（aionui.md R4/R3）
- ZCode（shipped）：AskUserQuestion 内联在输入区上方；会话状态浮窗含 Goal/TODO/后台任务（zcode.md R3/R4）
- pi（partial）：TUI 中止时用 restoreQueuedMessagesToEditor 把排队消息回填编辑器（pi.md R4）
- DeskMinis：亲自核对：PermCard 渲染在消息流末尾（ui/StageChat.vue:216，位于滚动容器 .col 内），长输出时可能被滚出视口；.dock（StageChat.vue:241）只放 Composer；没有计划条和队列
- 备注：分两步。先只迁 PermCard：pendingPerms 非空时在 Composer 位置渲染紧凑卡，Composer 用 v-show 保住草稿，多张时显示「第 1/3 个」（S）。计划条和队列依赖 agent 簇的 todo_write 与排队投递，后做。守卫 renderer-chat-capabilities 要同步改指向

**预览面板增强（最大化、tab 右键菜单、在文件夹中显示/系统程序打开、路径由后端给）**

- AionUi（shipped）：15042d9 最大化：聊天区隐藏但保持挂载；7909246 tab 右键菜单 portal 到 body，含复制相对路径、在文件夹中显示，由后端经 fs.reveal 执行（aionui.md R3）
- DSH（shipped）：host/open-in-app（09-07）：默认程序打开、关联程序列表、在文件夹中显示；HTML 预览放进 sandbox iframe 加 CSP（dsh.md R3）
- ZCode（shipped）：WorkspaceSidePaneTab 是 19 种 tab 的联合，按工作区记忆（zcode.md R3）
- OpenMinis（partial）：handleMinisURLTap 把文件路径按扩展名路由到预览（openminis.md R4）
- DeskMinis：亲自核对：ui/PreviewPane.vue 有源码/渲染/分栏三态和行号；没有最大化和 tab 右键菜单；copyPath 在渲染端拼 `${workspaceRoot}/${path}`（PreviewPane.vue:71，Windows 上分隔符混用）；Office 失败卡和旧格式卡叫用户「用系统应用打开」，却只给「复制完整路径」；preload/index.ts 白名单里没有 openPath/showItemInFolder
- 备注：绝对路径由 minisd 按 workspaceOf 围栏解析后返回，渲染端不再自己拼；最大化用 v-show 保住 Composer 草稿；浮层用 Teleport 到 body（有 transform 的祖先会让 fixed 失效，AionUi 7909246 的教训）。Snapshot/History/Download 放在后面

**会话归档（可恢复）以及归档/删除前停止运行**

- AionUi（shipped）：18e4fdd 删除改为归档（主色），/settings/archived 首屏 5 条、每次加载 10 条；core 归档时拆掉 agent 进程（aionui.md R4）
- DSH（shipped）：client/ui-settings-general/src/client/SettingsRoot.tsx 有 'archived-sessions' 分区；cbae324bf（09-21）归档前询问并停止回合、子代理、作业（dsh.md R4）
- ZCode（shipped）：packages/ui/src/DeleteAllArchivedTasksButton.tsx，任务菜单有归档
- DeskMinis：亲自核对：ui/NavRail.vue:158-163 只有「删除会话」和「确认删除？此操作不可撤销」；sessions 没有 archived_at；context 缺陷 16：chat.sessions.delete 不会 abort 正在跑的 run
- 备注：追加迁移 archived_at，走和 pinned_at 相同的同步路径；新增 archive/unarchive/listArchived 三个 RPC；归档或删除运行中的会话时先停 run、shell、终端（顺带修掉缺陷 16）；永久删除只放在已归档页。每次迁移要连带改六个版本钉

**思考档位控件（按模型列出可用档、钳制提示、按会话记忆）**

- OpenMinis（shipped）：effort 档由目录声明驱动，界面只列线上值真正不同的档，超出上限时显示橙色 ↑（openminis.md R4，v1.12/13 新增）
- pi（shipped）：interactive/components/thinking-selector.ts；thinkingLevelMap 用 null 表示不支持，不支持时就近夹取（pi.md R3）
- ZCode（shipped）：thoughtLevelOptions 把 nothink/no-think 等别名归一为 off（zcode.md R3）
- DeskMinis：亲自 grep：Composer.vue 没有思考控件；renderer 全树没有 thinkingLevel（minisd index.ts:582 的接口有这个参数，:648 做钳制）；providers/anthropic.ts:45 开思考时只发 budget_tokens（context 缺陷 9）
- 备注：必须先在 providers 簇修好 Anthropic 思考参数的代际形状和 OpenAI 兼容的 reasoning_content 回传，否则一开放界面就会 400。README:16「思考过程可见（Anthropic/Gemini 原生思考…）」目前不成立。界面部分约 S–M，跨簇合计按 L 估

**消息内链接与路径（外链交系统浏览器、路径可点击、Windows 路径解析）**

- DSH（shipped）：每个 BrowserWindow 都有 setWindowOpenHandler deny 加 openExternal、will-navigate 守卫和中文右键菜单；正文路径只在精确路径或唯一 basename 命中本回合产出时才链接（dsh.md R5/R5）
- ZCode（shipped）：修复 CommonMark 反转义吃掉 Windows 盘符/UNC 反斜杠的问题，并解析 path:line:col（zcode.md R4）
- OpenMinis（shipped）：handleMinisURLTap 统一路由设置子页、终端预填、文件预览（openminis.md R4）
- DeskMinis：亲自核对：components/MarkdownInline.vue:16 所有链接都是 target="_blank"；src/main/index.ts 里 setWindowOpenHandler/will-navigate 零命中，外链会开在无地址栏的应用窗口里（context 缺陷 15；主会话实验：子窗口不继承 preload，风险是钓鱼，不是令牌泄露）；lib/markdown/parse.ts:45-50 isSafeHref 只放行 http/https/mailto；路径不可点（§6 其它未做）
- 备注：先做窗口守卫（S）：http/https/mailto 交 openExternal 并 deny，will-navigate 只放行自身。再做路径链接（M）：只链接本回合真实产出的路径，重名不链，从不从正文推断；Windows 盘符、UNC、:行:列都先写红测

**空会话助手空态（从结构上修掉欢迎页选助手的撒谎）**

- AionUi（shipped）：57bfc79：选了助手后空输入也能建空会话，显示 SingleChatEmptyState（48px 头像、16px 名称、13px 问候）；4a2a32d：空标题显示可点击的「未命名」（aionui.md R5）
- ZCode（partial）：商店的 Example Prompt 只预填、不自动发送（zcode.md R2）
- DeskMinis：亲自核对：ui/AppShell.vue:50 inChat 要求 messages.length>0，空会话一律落到 StageWelcome；ui/StageWelcome.vue:52 副标题写「直接输入即以该预设开始」，但当前已有空会话时，消息发进这个空会话且不带预设（交接 §6 一档）；chat.* 方法表里没有给已有会话设助手的 RPC
- 备注：inChat 改为只看 activeId；StageChat 在 turns 为空时渲染助手空态，并把助手的 prompts 作为开场建议；选助手时把它绑到当前空会话（需新增 RPC），让副标题的承诺和 send() 走同一条路径。回车和发送键继续共用 X 波的重入闸

**命令入口：Ctrl+K 命令面板与斜杠命令分组（/模型 /权限 /压缩）**

- ZCode（shipped）：command-center/CommandCenterDialog.tsx（基于 cmdk），含任务搜索、片段和搜索历史
- DSH（shipped）：斜杠行分 popupSelect/action/host 三类，/model、/permission 直接弹选择器，中英别名；以 / 开头但匹配不到时不静默发送（dsh.md R3）
- pi（shipped）：TUI 的 /model /thinking /compact /tree 等选择器命令
- AionUi（shipped）：c83bc49 MentionMenuShell 统一 / @ @@ 三个菜单：高度 min(34vh,260px)，精确调 scrollTop 而不用 scrollIntoView；573927d Enter/Tab 可接受斜杠项（aionui.md R3）
- OpenMinis（partial）：斜杠菜单里的 /thinking 分段控件（openminis.md R4）
- DeskMinis：ui/Composer.vue:56-64 斜杠菜单只列技能；键盘选中项不随滚动（AionUi 核验）；没有 Ctrl+K（§6 其它未做）
- 备注：命令写成纯数据 lib/composer/commands.ts 并先测；/压缩 依赖 agent 簇新增 chat.compact RPC。只学菜单形态，不学玻璃材质（renderer-shell-form 守卫）

**工具步骤语义摘要与输出清洗（分类标题、ANSI 剥离、分块展开）**

- ZCode（shipped）：classifyStep 剥掉 powershell/pwsh -Command 外壳，按读写正则分类，摘要为「查阅 N 文件 · 改动 M 文件」（zcode.md R4）
- DSH（shipped）：组标题按类别和细节字段优先级取，至少停留 150ms；没有终态的卡在回合结束后派生为「已中断」（dsh.md R5/R4）
- OpenMinis（shipped）：sanitizeForDisplay 去掉 CSI/OSC，单行超过 2000 字强制折行，40 行一块懒加载（openminis.md R3）
- pi（shipped）：工具结果分 content（给模型）和 details（给界面），渲染器拆到 tools/renderers（eb3e9fe，基线后）（pi.md R3）
- DeskMinis：StepGroup.vue 摘要只有步数；输出直接 `s.output.slice(0, 2000)`（:62），没有 ANSI 清洗和分块展开；file_edit 差分靠 extractEditPair+LCS 从入参重算；没有「已中断」态
- 备注：分类表和 permissions.ts 的只读判定共用一张。如果以后做 Office/简洁显示模式，权限卡在任何模式下都要逐字展示（ZCode 自己守住了这一点）

**输入法合成保护（IME）**

- AionUi（shipped）：useCompositionInput 由 SendBox 和欢迎页共用：合成期间不处理 Enter（aionui.md R3）
- ZCode（shipped）：bindings.ts 过滤 isComposing、Process、keyCode 229（zcode.md R4）
- DSH（shipped）：QuestionComposer：IME 组字期间（含 keyCode 229）的回车不提交（dsh.md R4）
- pi（partial）：model-selector.ts:43 的输入组件为 IME 光标定位实现了 Focusable
- DeskMinis：亲自 grep：renderer 里 composition、isComposing、keyCode 零命中；Composer.vue:314-317 的 @keydown.enter.exact.prevent / up / down / tab 都没有合成判断
- 备注：AionUi 核验已下调风险：Windows Chromium 在 IME 处理中报 key='Process'，Vue 按键修饰符多半不会触发。需要在真机用微软拼音和搜狗复现；复现不出来也保留 isImeKey 守卫

**可拖分栏与布局记忆（吸附收起、双击复位、键盘可调）**

- AionUi（shipped）：446e83e 侧栏 200px 到 50vw，低于下限吸附收起且不写盘，双击复位到 260，把手热区 8px（aionui.md R4）
- ZCode（shipped）：4px 可拖缝，把手支持键盘；宽度小于 480 先收右栏、小于 360 再收左栏（依赖 react-resizable-panels）（zcode.md R3）
- OpenMinis（shipped）：平板 ChatSplitScaffold 默认 28%，宽度 340–500dp（openminis.md R3）
- DSH（shipped）：client/ui-dockkit：带标签页的分割树，右侧栏用它
- DeskMinis：ui/AppShell.vue:122 `.split.withPreview .chatcol { flex: 0 0 var(--w-chatcol) }`，styles/theme.css:142 --w-chatcol 固定 372px；ui/ 下没有 pointerdown/setPointerCapture；交接「收窄」列有拖拽分栏丢失
- 备注：写 useResizable composable，clamp 和吸附判定抽成 lib/ 纯函数先红；把手 z-index 小于 50，守住 titlebar-stacking；键盘 ←→ 可调，满足 a11y 守卫；TopBar 右侧 146px 系统按钮区不能被挤压

**字体与缩放偏好（分区字体、字号、Ctrl+=/−/0）**

- AionUi（shipped）：74b5d32/2c7bc76 按 app/chat/markdown/code 四区设字族和字重，空值 removeProperty 回退；zoom.ts 默认 0.95、Ctrl+=/−/0 持久化在基线就有（aionui.md R4 两条）
- ZCode（shipped）：uiFontSize 12–20；主窗口改为自绘窗控，因为 WCO 不随 zoom（zcode.md R4/R3）
- OpenMinis（shipped）：Android 字号分三组、每组 6 档（0.88–1.21）；iPad 输入框可拖拽调高（openminis.md R3）
- DSH（shipped）：boot-theme 在 shell 挂载前设好字号（dsh.md R4）
- DeskMinis：ui/settings/SecLook.vue 只有主题三态；main 里 setZoomFactor/before-input-event 零命中；main/index.ts:90-92 是 frame:false 加 titleBarOverlay，symbolColor 固定 '#808080'
- 备注：做本机字体枚举需要装白名单 permission handler，只放行 local-fonts，AionUi 全部放行是反例。S 波教训：字体一改，行高和度量都会变，必须 xvfb 加 Windows 真机检查。缩放后 WCO 与 146px 保留区是否错位要真机验证

**滚动所有权与回到最新**

- ZCode（shipped）：following 只由真实用户输入改变，BOTTOM_ANCHOR_EPSILON_PX=48，会话滚动记忆 LRU 200（zcode.md R4）
- DSH（shipped）：use-scroll-follow（09-22 新增）：ResizeObserver 跟随、scrollend 定论、回到底部按钮（dsh.md R3）
- pi（shipped）：可点击的「Jump to latest message」（0.85.0）（pi.md R2）
- OpenMinis（partial）：v1.12 修复思考块「程序滚动误解除跟随」（openminis.md R3）
- DeskMinis：ui/StageChat.vue:143-146 任何 scroll 事件都按距底 120px 重算 following，内容增高也会被误判成用户上翻；没有回到底部按钮；有 Y5 回合锚点导航轨（≥3 回合才显示）
- 备注：监听 wheel/pointerdown/keydown 标记用户意图，只有带意图的 scroll 才改 following；following=false 时在输入卡上方显示「回到最新」

**上下文占用可见性（输入区占用环、按来源拆分、实测或估算标注）**

- DSH（shipped）：输入卡下方环形百分比，点开是 token 分解，基线后新增（dsh.md R3）
- ZCode（shipped）：contextUsage 把 system_prompt/skills/mcp_tool_schemas 分项，并显示缓存命中率（zcode.md R3）
- pi（shipped）：以最近一次有效响应的 usage 为基准，只估算其后的消息；压缩后 footer 显示 '?/窗口'（pi.md R4）
- DeskMinis：ui/TaskPanel.vue:25-52 水位条只在右栏任务 tab 里；数据来自 chat.contextInfo 的字符估算，不含 system prompt 和工具 schema，也没用已落库的 usage；压缩后照常显示估算值
- 备注：环本身是 S，锚定真实 usage 要改后端。遵守「不精确就不显示」：压缩后、下一次回复前显示「待更新」

**多面板对话墙（同屏并排多个会话）**

- AionUi（shipped）：Team 模式有 parallel/single/board 三种视图（pages/team/TeamPage.tsx:831、components/TeamViewToggle.tsx），成员会话并排
- ZCode（shipped）：v4/paneLayoutTree + paneLayoutStore.ts 提供 splitPaneAt、openSessionInNewPane；WorkbenchSplitDivider；刷新时恢复布局
- DSH（partial）：client/ui-dockkit 分割树引擎，目前只用于右侧栏面板，不用于会话
- DeskMinis：stores/chat.ts 只有一个 activeId 和一份 store，chat.event 只处理当前会话（:142）；main 只建一个 BrowserWindow；交接 §6 三档，需先出设计稿
- 备注：前置条件是「按会话的状态投影 + 快照/订阅 RPC」（见第一行）。两家都是单窗口分屏，不是多 BrowserWindow。DeskMinis 的 RpcServer.broadcast 是全量广播（pi mini 把 N² 广播列为已知捷径），要先改成按订阅投递

**外观偏好首帧生效与持久化（主题、标题栏按钮颜色）**

- DSH（shipped）：boot-theme 在 head 注入画布底色，挂载前设主题；preload-windows 监听主题，经 IPC 调 setTitleBarOverlay（dsh.md R4）
- ZCode（partial）：主窗口自绘窗控按钮，WCO 只留在更新窗口（zcode.md R4）
- DeskMinis：亲自核对：renderer/index.html 没有启动脚本；SecLook.vue:22-28 只在打开「设置→外观」时读回 deskminis.theme；AppShell.vue:64-67 ☰ 切换不持久化；main/index.ts:92 symbolColor 固定 #808080
- 备注：在 main.ts 挂载前读取 deskminis.theme 并设 data-theme；☰ 切换也写 localStorage（包 try/catch）；加一条源码守卫，要求启动路径消费这个 key。标题栏颜色走白名单 IPC，真机截取深浅两态

**国际化（i18n）**

- AionUi（shipped）：i18next + react-i18next，services/i18n/locales 下 13 个 locale
- ZCode（shipped）：packages/ui/src/i18n：zh-CN/en-US 各约 6500 条，另有 LocaleSwitcher
- DSH（shipped）：client/locale 包（en/zh）和 README.i18n.yaml
- OpenMinis（shipped）：Android res/values-* 多语言 strings.xml；v1.13 应用内语言切换加 locale 脚本（openminis.md R2）
- DeskMinis：界面文案中文硬编码；renderer 全树 grep i18n/locale 零命中
- 备注：大量源码守卫按中文字符串断言，抽 t() 会连锁改守卫。目标用户是中文用户，建议只约定「以后统一走一个 t() 入口」，不投入翻译

**图表渲染与全屏查看（Mermaid、图片/SVG lightbox）**

- AionUi（shipped）：components/Markdown/MermaidBlock.tsx + DiagramZoomOverlay.tsx（0.1–10 倍缩放、平移、ESC 退出，f858b61 新）；WavedromBlock 新增 wavedrom/json5 依赖（aionui.md R1）
- ZCode（shipped）：packages/ui/src/components/ai-elements/mermaid-block.tsx
- pi（shipped）：coding-agent 的 interactive/components/mermaid.ts 用 grok-mermaid 渲染终端字符画，基线已有
- DeskMinis：lib/markdown/parse.ts 没有图片和图表节点，```mermaid 按普通代码块显示；ui/PreviewPane.vue 图片只是 <img>，不能缩放
- 备注：需要用户破例：Mermaid 排版必须引入 mermaid（新依赖，体积大），自建解析和布局不现实。零依赖能做的只有图片/SVG 全屏查看（S），用 CSS transform 加 wheel/pointer 实现

## cowork 广度与生态（30 项）

| 能力 | 几家有 | 新趋势 | DM | 价值 | 成本 | 需新依赖 | 许可路径 |
|---|---|---|---|---|---|---|---|
| 发布就绪工程：资产校验、仓库外冒烟、随包资源契约、依赖冻结守卫、Windows CI | 5（AionUi、ZCode、pi、OpenMinis、DSH） | 是 | 部分 | 5 | S |  | AionUi（Apache-2.0）、pi（MIT）的脚本思路可借，须署名；OpenMinis 只借思路 |
| 无人值守的注意力回路：会话「等待你/运行中/未读」徽标、系统通知、任务栏闪烁 | 4（AionUi、DSH、ZCode、OpenMinis） | 是 | 缺 | 5 | M |  | AionUi（Apache-2.0）的 reducer 和去重规则可借，须署名；DSH（MIT）；OpenMinis 只借思路 |
| 扩展密钥与 MCP 配置编辑：vault 引用、列表脱敏、env/headers 编辑器、编辑不丢字段 | 3（DSH、ZCode、OpenMinis） | 是 | 坏 | 5 | M |  | DSH（MIT）、ZCode（Apache-2.0）的语义可借，须署名；OpenMinis 只借思路 |
| MCP 协议面：图片结果、resources、prompts、server instructions、annotations、自动重连 | 4（DSH、ZCode、OpenMinis、AionUi） | 是 | 部分 | 4 | L |  | DSH（MIT）、ZCode（Apache-2.0）可借，须署名；不引官方 SDK，沿用自写的 stdio/http 客户端 |
| 视觉代看：read_image、视觉组、工具结果和截图能被模型看见 | 4（OpenMinis、pi、DSH、ZCode） | 是 | 缺 | 4 | M |  | pi/DSH（MIT）的工具结果图片块实现可借，须署名；OpenMinis 的视觉组只借思路 |
| 结构化向人提问 ask_user（问题卡接管输入区，无人值守时回「无人应答」） | 4（DSH、ZCode、AionUi、pi） |  | 缺 | 4 | M |  | DSH（MIT）、ZCode（Apache-2.0）可借，须署名 |
| 助手预设体系：规则/模型/技能/开场白，空会话显示助手态，助手级工具集在建会话时快照 | 3（AionUi、DSH、OpenMinis） | 是 | 部分 | 4 | M |  | AionUi（Apache-2.0）的空态交互和尺寸数值可借，须署名；DSH（MIT）「建会话时快照助手修订」的语义可借；OpenMinis 只借思路 |
| 随包官方技能与助手内容包（办公类：PPT/Word/Excel 流程技能，默认关闭） | 3（AionUi、DSH、ZCode） | 是 | 缺 | 4 | M |  | DSH（MIT）的「名单写成代码常量 + 守卫」模式可借；AionUi 的技能正文放在 AionCore 仓库，许可证没核实，不直接搬；技能正文自己写 |
| 安装与解包安全：zip 上限、原子激活、事务化安装、哈希校验 | 3（ZCode、DSH、pi） | 是 | 坏 | 4 | S |  | ZCode（Apache-2.0）的上限常量和原子激活流程可借，须署名；也可以直接复用自家 office/zip.ts 的三道闸 |
| MCP OAuth：授权码 + PKCE、回环回调、token 进 vault | 3（AionUi、ZCode、OpenMinis） |  | 缺 | 4 | L |  | ZCode（Apache-2.0）的授权状态机可借，须署名；OpenMinis 只借思路 |
| Office 文档：读写、高保真预览、用系统程序打开 | 3（AionUi、DSH、ZCode） | 是 | 有 | 4 | M |  | DSH（MIT）的 open-in-app 设计可借；AionUi 的 OfficeCLI（C#）只借设计；ZCode 的预览库都是新依赖，不引 |
| 内置浏览器（用户可见的 webview 侧栏标签 + 安全基线） | 3（DSH、ZCode、OpenMinis） | 是 | 缺 | 4 | L |  | DSH（MIT）的租约/分区模型可借，须署名；ZCode（Apache-2.0）的 attach 加固可借；OpenMinis 只借思路 |
| agent 操控浏览器与桌面（CDP 离散工具、Playwright MCP 预设、computer-use、操作指示浮层） | 3（ZCode、DSH、OpenMinis） | 是 | 缺 | 4 | XL |  | ZCode（Apache-2.0）、DSH（MIT）可借，须署名；Playwright 注入脚本是新依赖，不引 |
| Todo / 计划条 / 计划模式（长任务可见进度） | 3（DSH、ZCode、AionUi） | 是 | 缺 | 4 | M |  | AionUi（Apache-2.0）PlanBar 的数值和规则、DSH（MIT）、ZCode（Apache-2.0）可借，须署名 |
| 自动更新可用性、更新准入锁（运行中任务检查）、安装器加固 | 3（AionUi、DSH、ZCode） | 是 | 坏 | 4 | M |  | AionUi（Apache-2.0）的 generic provider 思路和 nsis.include 片段、DSH（MIT）的准入锁语义可借，须署名 |
| 技能多根与项目级技能：调用面字段、项目信任闸、注册表自愈 | 5（pi、DSH、ZCode、AionUi、OpenMinis） |  | 部分 | 3 | L |  | pi/DSH（MIT）、ZCode（Apache-2.0）的解析与优先级规则可借，须署名；OpenMinis 的自愈只借思路 |
| 外部生态导入：粘贴 mcp.json、Claude/Codex 插件包、跨 agent 配置迁移、自定义 marketplace 源 | 5（ZCode、pi、AionUi、OpenMinis、DSH） |  | 部分 | 3 | M |  | ZCode/AionUi（Apache-2.0）、pi（MIT）的解析代码可借，须署名；OpenMinis 只借思路 |
| 远程与自动化入口：WebUI/手机伴侣、无头 CLI、深链协议 | 5（AionUi、ZCode、OpenMinis、pi、DSH） |  | 部分 | 3 | L |  | pi（MIT）的 RPC 语义、AionUi/ZCode（Apache-2.0）可借，须署名；OpenMinis 只借思路 |
| genui 内联交互组件：交付物卡 present、回合改动卡、内联指令块、富块查看器 | 5（DSH、ZCode、AionUi、OpenMinis、pi） | 是 | 缺 | 3 | L |  | DSH（MIT）、ZCode（Apache-2.0）可借，须署名；OpenMinis 只借思路；图表库都是新依赖，不引 |
| 定时任务：agent 可创建（cron/提醒工具）、同会话提醒、防递归双闸、常驻 | 4（DSH、ZCode、AionUi、OpenMinis） |  | 部分 | 3 | M |  | DSH（MIT）、ZCode（Apache-2.0）的规则可借，须署名；OpenMinis 只借思路 |
| 子代理委派（只读 Explore / one-shot / 调用其它模型） | 4（DSH、ZCode、OpenMinis、AionUi） |  | 缺 | 3 | L |  | DSH（MIT）、ZCode（Apache-2.0）可借，须署名；OpenMinis 只借思路 |
| 评测体系：成对行为评测、文档一致性审计、性能基准、状态空间枚举 | 4（pi、DSH、ZCode、OpenMinis） | 是 | 缺 | 3 | M |  | pi/DSH（MIT）可借，须署名；ZCode（Apache-2.0）；OpenMinis 只借思路；pi 的 evals 依赖 vitest-evals/autoevals，不引 |
| IM 机器人接入（飞书/钉钉/企微/Telegram/微信） | 3（AionUi、ZCode、DSH） |  | 缺 | 3 | XL |  | AionUi、ZCode（Apache-2.0）的平台适配可借，须署名 |
| 图片生成 | 3（AionUi、OpenMinis、pi） | 是 | 缺 | 3 | L |  | AionUi（Apache-2.0）、pi（MIT）可借，须署名；OpenMinis 只借思路 |
| 跨会话提及与上下文引用（@@ 会话、跨会话检索、会话间投递） | 3（AionUi、ZCode、OpenMinis） | 是 | 缺 | 3 | M |  | AionUi/ZCode（Apache-2.0）可借，须署名；OpenMinis 只借思路 |
| Goal 长程目标与自动续跑 | 3（DSH、ZCode、pi） |  | 缺 | 3 | L |  | DSH（MIT）、ZCode（Apache-2.0）可借，须署名 |
| 后台作业（长命令转后台、完成后回灌） | 2（DSH、ZCode） | 是 | 缺 | 3 | L |  | DSH（MIT）、ZCode（Apache-2.0）可借，须署名 |
| 非开发者界面模式（Office/cowork 呈现：隐藏命令原文、终端、diff 计数） | 1（ZCode） |  | 缺 | 3 | M |  | ZCode（Apache-2.0）可借，须署名 |
| 生命周期 hooks 与代码级扩展 API | 4（ZCode、DSH、pi、AionUi） |  | 缺 | 2 | L |  | pi/DSH（MIT）、ZCode（Apache-2.0）的语义可借，须署名 |
| 多 agent 团队协作与工作流编排 | 4（AionUi、DSH、ZCode、pi） |  | 缺 | 2 | XL |  | AionUi/ZCode（Apache-2.0）、DSH/pi（MIT）的思路和部分代码可借，须署名；ZCode dynamic-workflow 依赖 typescript，不引 |

### 本簇跨项目观察

- 结构化交互通道已成共识：ask_user（DSH/ZCode/AionUi/pi）、计划审阅卡（DSH/ZCode）、「等待你」状态（AionUi v2.2.1）都挂在统一的待处理交互机制上（ZCode interaction-registry、DSH approval/question waterfall、pi extension_ui_request）。DeskMinis 只有 PermCard 一种。建议把 PermCard 的「挂起 promise + 广播 + 倒计时」泛化成通用 interaction 通道，作为本簇第一块基建：ask_user、计划审阅、项目信任卡、OAuth 提示、goal 确认都建在它上面
- 无人值守必须配注意力回路：四个 GUI 项目（AionUi、DSH、ZCode、OpenMinis）都有等待态徽标和系统通知，AionUi v2.2.1 还把待确认纳入桌面通知。DeskMinis 有定时任务和 90 秒自动拒绝，却一条通知都没有。这是「多家在做、DeskMinis 缺失、成本 M、零依赖」最典型的一项，也是定时任务能否可信的前提
- 视觉是浏览器、computer-use、图片生成三件事的共同前提：OpenMinis 有视觉组，pi 和 DSH 的 read 工具能返回图片，ZCode 对 MCP 图片做 image-first 归一。DeskMinis 丢弃 MCP 图片，连自己截的屏都看不到。合理路线是：图片进工具结果 → read_image/视觉组 → 内置浏览器 → CDP 离散工具 → computer-use。跳步只会得到一个看不见结果的 agent
- 浏览器能力收敛到一种形态：宿主内 webview + 独立的非持久 partition + will-attach-webview 覆盖配置 + 离散工具过审批（DSH、ZCode、OpenMinis）。原生 SDK 和代码模式都已暴露风险：ZCode code-mode 的 restrictProcess 不是沙箱，DSH 的原生 Cua SDK 跑在宿主进程里，ZCode 开源版 CUA 是空壳
- 生态互通替代自造格式：ZCode 兼容 .claude-plugin/.codex-plugin，pi、DSH、ZCode 都读 .agents/skills，DSH、ZCode 的 hooks 兼容 Claude Code，AionUi、OpenMinis 支持粘贴 mcp.json。DeskMinis 只兼容 SKILL.md。这个趋势的伴生物是项目信任闸（ZCode 按声明 sha256、pi 的 project trust、DSH 首次确认）：DeskMinis 读取项目目录里的任何配置之前，都要先有信任表
- cowork 广度靠内容包，不靠代码：AionUi 有 21 个助手和内置 pptx/docx/xlsx 技能，DSH 有 OPTIONAL_BUNDLES 和 skill-office，ZCode 有 bundled-skills。DeskMinis 的零依赖 Office 引擎比 DSH 的 LibreOffice kit + Python、ZCode 的五个预览库都轻，缺的是随包办公技能和配套助手。这是零依赖约束下扩广度最便宜的路
- 密钥外置和配置防丢是扩 MCP 之前的门槛：DSH 只写凭据引用，ZCode 规定 sensitive 值只进 env，OpenMinis 用 Keychain 注入。DeskMinis 的 MCP 密钥明文落盘、列表把明文发给渲染端，设置页编辑一次还会抹掉 env/headers（本次新发现）。OAuth、配置导入这类「让接入更方便」的功能都会放大这个缺陷，必须先修
- 多 agent 普遍先做子代理、后做团队：DSH 深度 1、活跃上限 8、审批钉为 never，ZCode 只有只读 Explore；团队和工作流除 AionUi（倚赖外部 ACP agent）外都在实验区。DeskMinis 应跳过团队；子代理、goal、跨会话投递也都要先有「消息来源标注」这块地基
- 发布工程是本簇最大的缺口，比功能缺口更大：五家都有发布校验和持续发版（DSH 五周 20 个标签，pi 从 0.84 到 0.87），DeskMinis 从未正式发布，README 宣称的自动更新在私仓下不可用。本簇任何新能力都要先有可发布的通道，用户才验证得到
- 定时任务工具化的安全配套已经成型：ZCode 在 automation 轮隐藏 cron_*、执行器二次拒绝、总数上限 20；DSH 要求显式时区、最小间隔 300 秒、fork 不继承。agent 可建常驻任务就是提示注入的持久化面，DeskMinis 若开放，这几条要一起带上
- IM 和远程接入是 AionUi、ZCode「cowork」叙事的主入口（飞书/钉钉/Telegram/微信 + WebUI），但与 DeskMinis 本机优先的定位冲突。DeskMinis 已有的配对后端（remote 模式可调业务 RPC）更贴合自身定位，适合作为远程底座；IM 若做，必须默认关闭、逐平台 opt-in，并写明流量途经哪家服务器
- 反面做法清单：①默认外发：DSH session-log-deepseek 默认把完整会话日志附在请求里上传；ZCode 把 Coding Plan 端点静默改发到自家网关，并带 ARMS/OTel 遥测；pi cache-warmer 在后台自动发请求花钱。②放宽宿主安全：AionUi 为一个字体 API 放行全部 Electron 权限；ZCode IAB 提供证书全放行开关并向网页注入 bridge；ZCode --web 在回环上默认不发 token、/ws 不验 Origin；AionUi 手机端用明文 http 扫码换 token。③失败即放行：ZCode Goal verifier fail-open，CLI 无头模式默认 yolo；DSH maxConsecutiveWakes 没有默认值，可形成自激链。④供应链与质量门：AionUi 下载外部二进制不校验 checksum 还回退 latest，质量门用 --passWithNoTests 和阈值 0。⑤其它：AionUi 跨会话投递往正文塞 [[标记]] 再反解，图片生成下拉曾列出必定失败的模型；OpenMinis 的 OAuth 冒充官方 CLI 身份；pi 未经信任就注入 AGENTS.md。以上都不吸收

### 对 DeskMinis 现状说法的纠正

- MCP 设置页编辑会静默丢数据，比输入所说的「env/headers 编辑器丢了、只能手改 servers.json」更糟。ui/settings/SecMcp.vue 的 payload() 只有 name/transport/enabled/note/command/args/url；minisd/mcp/config.ts:186-210 的 upsert 用 decodeEntry(input) 整条替换，只保留 createdAt 和 extra。所以对任一已有服务器点「编辑→保存」（哪怕只改备注），都会抹掉 env（含市场装入的密钥）、headers、cwd、startupTimeoutSeconds，还会把已停用的服务器强制改回 enabled:true。「试连接」也不带 env/headers（index.ts:856-870 走 scratch upsert），需要密钥的服务器试连必然失败。tests/mcp-config.test.ts 只钉住了 extra（oauth）的保留，没覆盖 env/headers。它与 context #6 是 MCP 配置上两条独立的静默丢数据路径
- 截屏能力对模型实际为空。windows-screenshot（bridge/handlers.ts:159-171）只返回 {path,width,height}；file_read 以 utf8 读文件（tools/files.ts:65）；没有 read_image；MCP 返回的图片被替换成「[非文本内容：image，暂不支持]」（mcp/manager.ts:86）。deskminis-state 把含截屏的 Windows 能力桥记为 solid，并把截屏当作屏幕能力唯一的现存基础，实际上 agent 截了屏也看不到画面
- README.md:32「打包分发 ✅ NSIS 安装包 + 便携版 + 自动更新」和 README.md:45「安装版（推荐，支持自动更新）」不实：electron-builder.yml 配的是 publish: github，私仓下检查会 404（配置注释自己承认），而且从未正式发布过。deskminis-state 列出的「对外文档与代码不一致」清单漏了这一条。另外 main/index.ts:131-144 选「重启并安装」时不检查运行中的回合、定时任务和待批权限，与同处注释「Agent 应用可能正跑着长任务」的顾虑不一致
- README.md:21 定时任务写「应用运行时生效（不驻留后台…）」有误导：main/index.ts:99 关窗时是 hide 到托盘，应用和 cron 调度器都继续运行。窗口关掉后定时任务照常触发，权限询问照样 90 秒后自动拒绝，用户却可能以为关窗就停了
- 市场装入的 MCP 密钥不只是明文落盘：index.ts:837 的 mcp.servers.list 把含 env/headers 的完整条目原样发给渲染端，而渲染端从来用不到这些值。DSH 核验已提过，这里亲自复核属实
- 助手体系标 solid 偏高。assistants/store.ts:10-14 的助手没有工具集、MCP、权限维度，而 DSH 的预设能选整套工具。欢迎页撒谎的机制已亲自复核：Composer.vue:225-228 只在 !chat.activeId 时才按 welcomeAssistantId 建会话，AppShell.vue:50 却以「有 activeId 且有消息」判定 inChat；存在空会话时欢迎页照样出现，并承诺「直接输入即以该预设开始」（StageWelcome.vue:52）
- 技能的 builtin 分级是死代码：skills/prompt.ts:34-39 给 importSource==='builtin' 预留了优先注入位，但全仓没有任何写入 builtin 的路径，resources/ 下只有 tray.png。也就是说目前没有任何随包技能，交接里的「办公技能包」要从零开始
- 许可证元数据不一致：deskminis/package.json 写 "license": "ISC"，仓库根 LICENSE 和 deskminis-state 都是 Apache-2.0，发布前要统一。另外 THIRD-PARTY-NOTICES.md 目前只登记了 Appica UI 和 OpenMinis，今后借用 AionUi、ZCode（Apache-2.0）或 DSH、pi（MIT）的代码时，要先在那里补条目

### 逐行证据与备注

**发布就绪工程：资产校验、仓库外冒烟、随包资源契约、依赖冻结守卫、Windows CI**

- AionUi（shipped）：scripts/verify-release-assets.sh 配 mock 产物回归；分发前校验 version 与 tag 一致，拒绝同版本覆盖；随包资源在准备时、afterPack、安装后三处复核（aionui.md R5/R3）
- ZCode（shipped）：zcode-distribution-smoke.mjs 把发行包解到临时目录，清空 NODE_PATH/NODE_OPTIONS 后运行（zcode.md R3）
- pi（shipped）：0.85.0 误把实验代码发到 npm，0.85.1 在 files 里排除并新增 check-runtime-deps.mjs；另有 check-entry-graphs（pi.md R3）
- OpenMinis（shipped）：build_proot.sh 的 verify_artifacts 检查 sha256、大小下限和 ELF 架构（openminis.md R3）
- DSH（shipped）：基线后打了 20 个 dsh-v 标签；test:updates:local 用真实 NsisUpdater 对着回环服务器测试（dsh.md R3）
- DeskMinis：亲自读码：scripts/e2e-m5-packaging.mjs:119-135 只断言 bridge-cli 和原生 .node 随包；不校验 latest.yml、sha512、blockmap；仓库没有 .github，也就没有 CI；deskminis/package.json 的 license 写 ISC，和根目录 LICENSE（Apache-2.0）不一致；Releases 仍只有 v0.1.1（context）
- 备注：这对应交接 §6 一档唯一的发布阻断，是本簇 ROI 最高的一项。scripts/verify-release.mjs 零依赖解析 latest.yml 并比对 sha512（比 AionUi 更严），配 vitest 造 mock dist 的正反例，接进 RELEASE.md 和 e2e:m5。依赖冻结守卫把「零新依赖」变成一条会先红的测试。Windows CI 由用户拍板（私仓分钟数按 2 倍计费）。避开 AionUi 的反面：--passWithNoTests、覆盖率阈值 0、Windows 构建失败只写 notice

**无人值守的注意力回路：会话「等待你/运行中/未读」徽标、系统通知、任务栏闪烁**

- AionUi（shipped）：v2.2.1（7d1c7b7/cbabbc8）：纯 reducer 维护待确认 id 集合，Attention 图标优先级高于 Spin；桌面通知覆盖待确认和 ask，按 id 去重，正文带会话名（aionui.md R5 两条）
- DSH（shipped）：update-attention：窗口失焦时 flashFrame，同一事件只发一条静默通知，回到前台即清除（dsh.md R3）
- ZCode（shipped）：会话列表显示阻塞交互徽标；通知设 silent，由渲染端播放声音（zcode.md R3）
- OpenMinis（shipped）：完成通知剥掉 Markdown、截到 200 字；Live Activity 支持隐私模式（openminis.md R4）
- DeskMinis：亲自 grep：main/index.ts 里没有 Notification、flashFrame、setProgressBar、setAppUserModelId、powerSaveBlocker；stores/chat.ts:155 的 pendingPerms 只挂在当前视图；NavRail.vue:120 会话行只有助手 emoji；README.md:21 写明无人值守时权限询问 90 秒自动拒绝，用户却看不到任何提醒
- 备注：全用 Electron 内置能力。Windows 必须调 setAppUserModelId，且与 electron-builder 的 appId 一致，安装版和便携版都要真机验证。加一个只读的 permission.pending RPC，重连时对账，覆盖所有会话，不要学 AionUi 只给打开过的会话补标。定时任务的通知要写明「90 秒后自动拒绝」，避免界面撒谎

**扩展密钥与 MCP 配置编辑：vault 引用、列表脱敏、env/headers 编辑器、编辑不丢字段**

- DSH（shipped）：凭据接缝：配置里只写名字，取值优先级为启动环境 > 凭据文件 > .env；Settings 对 secret 字段只回「已设置」（dsh.md R5，基线后 +6779 行）
- ZCode（shipped）：sensitive 值只允许展开到 env，写进其它字段就抛 PluginVariableError（zcode.md R4）
- OpenMinis（shipped）：EnvVarStore 存在 Keychain，输出落库前由 EnvVarRedactor 脱敏（openminis.md R4）
- DeskMinis：亲自读码：market/install.ts:13-15、176-184 把确认卡收集的密钥原样写进 servers.json 的 env；index.ts:837 mcp.servers.list 把含 env/headers 的整条原样发给渲染端。新发现：ui/settings/SecMcp.vue 的 payload() 只有 name/transport/enabled/note/command/args/url，而 mcp/config.ts:186-210 的 upsert 用 decodeEntry(input) 整条替换，只保留 createdAt 和 extra。所以在设置页对任一服务器点「编辑→保存」，会静默抹掉 env（含密钥）、headers、cwd、startupTimeoutSeconds，并强制 enabled:true；「试连接」（index.ts:856-870 走 scratch upsert）也不带 env/headers
- 备注：修复顺序：①红测「编辑保存后 env/headers 不丢、停用状态不被改」，upsert 对输入里没出现的键保留旧值（S）；②恢复 env/headers 编辑器，isSecret 字段只显示「已设置」；③引入 $$vault:<key> 引用，值进 KeyringVault，servers.json 和 list 里都不出现明文。加上 context #6（解析失败后 save 覆盖原文件），MCP 配置共有两条静默丢数据的路径，要在扩展 MCP（OAuth、导入）之前修掉

**MCP 协议面：图片结果、resources、prompts、server instructions、annotations、自动重连**

- DSH（shipped）：packages/mcp/mcp-resources 统一发现和读取资源；instructions 注入时标注服务器名，超过 32KB 就拒绝连接；断线重连 500ms→30s，每次故障最多 10 次；工具集按代际替换（dsh.md R3，instructions/resources 为 09-12 新增）
- ZCode（shipped）：readOnlyHint/destructiveHint 映射到风险档和并发；图片 inline 上限 200KiB，image 放在 text 之前；core/src/mcp/index.ts:424 把 resource 块转成文本（zcode.md R4）
- OpenMinis（partial）：minis-mcp-cli 只做 tools；v1.13 修了 http transport 的重新初始化（test_http_reinit.py）
- AionUi（partial）：MCP 由引擎 aioncore 按各 agent 的能力注入或同步（readme.md:175），本仓看不到协议层实现
- DeskMinis：亲自读码：mcp/manager.ts:78-90 把非文本内容一律替换成「[非文本内容：image，暂不支持]」；mcp/http.ts:4 注明 GET 长流、OAuth、自动重连都不做；stdio.ts:339 对 sampling/roots 回 -32601；mcp/ 目录里没有 resources/prompts
- 备注：优先级：图片结果（浏览器类 MCP 的前提，接进第 18 行的视觉管线）> 带次数预算的自动重连，失败时保留上一代工具 > instructions（限长、标注来源、按半可信处理）> resources/prompts（prompts 可以挂进 / 菜单）。readOnlyHint 可作为「本会话沿用」自动放行的依据，但网关仍兜底。pi 按设计不做 MCP

**视觉代看：read_image、视觉组、工具结果和截图能被模型看见**

- OpenMinis（shipped）：v1.13 视觉组：主模型不能看图时仍注册 read_image，交给组内视觉模型返回描述和逐字转写，最多试 3 个成员、每次 90s（openminis.md R5）
- pi（shipped）：packages/coding-agent/src/core/tools/read.ts:2-52 读到图片时返回 ImageContent，并按目标模型缩放；0.86 加了图片输入限额
- DSH（shipped）：packages/fs/tool-fs/src/read-image.ts；09-08 起图片卸载作为持久决定
- ZCode（shipped）：agent/file-part-hydration.ts:14 回填图片/视频/PDF；MCP 图片按 image-first 归一（zcode.md R4）
- DeskMinis：亲自读码：没有 read_image；file_read 以 utf8 读任意文件（tools/files.ts:65）；windows-screenshot 只回 {path,width,height}（handlers.ts:159-171），截了屏模型也没有任何途径看到；MCP 图片被占位丢掉（mcp/manager.ts:86）；model-catalog 里 grep image/vision 零命中
- 备注：这是浏览器、computer-use、图片生成结果自检的共同地基。步骤：catalog 加 imageInput 能力位，非视觉模型的历史图片换成带路径的占位，防止切模型后 400；再做 read_image(path, prompt?)，Anthropic 放进 tool_result 的 image 块，OpenAI 兼容路径追加一条带图的 user 消息，Gemini 用 inlineData；最后视觉组复用模型组。给描述模型的提示词要写明不执行图里的指令

**结构化向人提问 ask_user（问题卡接管输入区，无人值守时回「无人应答」）**

- DSH（shipped）：ask_user_question 一次可问多题，支持推荐项后缀、多选和自由填写；QuestionComposer 接管输入区；委派调用抛 DELEGATED_CALLER（dsh.md R4）
- ZCode（shipped）：AskUserQuestion 每次 1–4 题；interaction-registry 先到先得，迟到的应答为 noop，300s 自动结束并持久化（zcode.md R3）
- AionUi（shipped）：v2.2.1 的 ask 确认类型（pages/conversation/Messages/MessageQuestion.tsx），并入「等待你」状态
- pi（partial）：RPC 的 extension_ui_request 提供 select/confirm/input/editor，另有 question 示例扩展（pi.md R2）
- DeskMinis：亲自 grep：tools/*.ts 注册的 13 个工具里没有提问类；向用户要输入的唯一通道是 PermCard
- 备注：把权限网关的「挂起 promise + 广播 + 倒计时」泛化成通用的 interaction 通道，以后的计划审阅、项目信任卡、OAuth 提示都挂在上面。cron 和无人值守时立即返回「无人应答」，与 90 秒规则一致。照抄 IME 组字（keyCode 229）判定

**助手预设体系：规则/模型/技能/开场白，空会话显示助手态，助手级工具集在建会话时快照**

- AionUi（shipped）：readme.md:101 内置 21 个专业助手（Cowork/PPT/Word/Excel Creator 等），支持自定义；57bfc79（v2.1.60）空输入也能建会话并显示 SingleChatEmptyState（aionui.md R5）
- DSH（shipped）：agent-preset 按会话选定整套工具/提示词/技能，运行中的会话保留旧修订；09-21 拆分为 agent-preset + registry，改用 profile YAML 声明（dsh.md R3）
- OpenMinis（partial）：只有 SoulStore 的人格句（可用 SOUL.md 配置），没有多个预设（openminis.md R3 子模型身份条）
- DeskMinis：亲自读码：minisd/assistants/store.ts:10-14 助手只有 rules/modelBinding/skillIds/prompts，没有工具集、MCP、权限维度；种子只有 3 个（store.ts:131-148）。欢迎页撒谎的机制：Composer.vue:225-228 只在 !chat.activeId 时才按 welcomeAssistantId 建会话，而 AppShell.vue:50 的 inChat 要求「有 activeId 且有消息」，所以存在空会话时欢迎页照样出现，StageWelcome.vue:52 承诺「直接输入即以该预设开始」，消息却发进了不带预设的空会话
- 备注：先修撒谎：inChat 改为只看 activeId，空会话直接绑定选中的助手，让副标题的承诺和 send 走同一条路径；TDD 用调用形态守卫。再给助手加「工具/MCP 开关」，在建会话时快照，之后编辑助手不影响已有会话。这样也顺带缓解 context #13（助手规则每一步实时读表，打断前缀缓存）

**随包官方技能与助手内容包（办公类：PPT/Word/Excel 流程技能，默认关闭）**

- AionUi（shipped）：readme.md:107-155、284：内置 pptx/docx/pdf/xlsx/mermaid 技能和 PPT/Word/Excel 助手；技能分内置/自定义/扩展三层
- DSH（shipped）：OPTIONAL_BUNDLES 代码常量列出官方可选包：随产品安装、默认关闭、不能卸载，有静态门禁（dsh.md R3）；packages/skill/skill-office 给办公技能绑定一个 Python 环境（09-16）
- ZCode（shipped）：apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows 和 superpowers-plugin 随包提供
- DeskMinis：亲自 grep：skills/prompt.ts:34-39 给 importSource==='builtin' 预留了优先注入位，但全仓没有任何写入 builtin 的路径；resources/ 下只有 tray.png；交接 §6 二档「办公技能包」未做
- 备注：这是零依赖约束下扩大 cowork 广度最便宜的一条：DeskMinis 已经有自建的 office_read/office_write 引擎，缺的是教模型走「做周报/做 PPT/整理表格」流程的 SKILL.md，以及配套助手。放进 extraResources，市场里单列「随应用提供 · 默认关闭」。不要学 DSH 捆 Python 或 LibreOffice

**安装与解包安全：zip 上限、原子激活、事务化安装、哈希校验**

- ZCode（shipped）：插件 zip 有 200MB/500MB/20000 条/50MB 四道上限，强制 sha256，跳转时剥掉鉴权头；staging→backup→rename 原子激活，带事务记录和崩溃恢复（zcode.md R4 两条）
- DSH（shipped）：installBundle 装前快照，失败或取消时回滚，装完默认不启用，结果分三态报告（dsh.md R4，09-14）
- pi（shipped）：npm/git 包按版本钉住，项目包要先过项目信任（docs/packages.md）
- DeskMinis：亲自读码：skills/importer.ts:69-100 的 unzipToMemory（基于 yauzl）没有条目数、解压总量、单文件大小上限，市场 installPlan 也复用它（importer.ts:68 注释）；对照 office/zip.ts:14-15、109-111 已有 2000 条和 64MB 的闸（context #3）
- 备注：S：在 yauzl 的 entry 回调里先检查 entry.uncompressedSize 和累计量，再 readEntry；红测构造一个 zip 炸弹。追加 M：技能覆盖重装改成 staging→rename，Windows 上遇 EPERM/EBUSY 短退避重试。上游提供哈希时比对；没有就在确认卡写明「未校验」。反面：AionUi 下载外部二进制不校验 checksum，找不到 pin 还回退 latest

**MCP OAuth：授权码 + PKCE、回环回调、token 进 vault**

- AionUi（shipped）：pages/settings/ToolsSettings/McpManagement.tsx:17-68 用 useMcpOAuth 做登录、状态检查、需重登标记（授权流程在引擎侧）
- ZCode（shipped）：PKCE 加跨进程 leader/follower 租约，owner 死掉后回收，AUTHORIZATION_LEASE_MAX_WAIT_MS=250（zcode.md R3）
- OpenMinis（partial）：src/ios/Views/MCP/MCPFormSheet.swift:35-42 只支持 HTTP 的静态 OAuth（Client ID + Secret）
- DeskMinis：亲自 grep：mcp/config.ts:8 把 oauth 等未识别字段原样放进 extra，不解析；mcp/http.ts:4 注明 OAuth 不做；交接 §6 列为未做
- 备注：零依赖做法：node:crypto 生成 PKCE，回调挂在临时的 127.0.0.1 路由上，verifier 不经渲染端，token 和 refresh 写进 KeyringVault，servers.json 只存引用。进程内单飞就够，但前提是先补单实例锁（context #14）。托管型 SaaS MCP 大多要 OAuth，这是 cowork 接入外部工作面的门槛。依赖第 6 行的 vault 先落地

**Office 文档：读写、高保真预览、用系统程序打开**

- AionUi（shipped）：内置 OfficeCLI（C#）驱动 PPT Morph、Word、Excel 助手和 pptx/docx/xlsx 技能（readme.md:107-155）
- DSH（shipped）：09-14~16 引入 LibreOffice kit 转 PDF 预览（新依赖），skill-office 绑定 Python 运行时；open-in-app 用关联程序打开，并能在文件夹中显示（dsh.md R2/R3）
- ZCode（partial）：packages/ui/package.json:21-69 用 docx-preview、pptx-renderer、react-xlsx、pdfjs 做预览，没有生成能力
- DeskMinis：亲自读码：tools/office.ts:54、79 有 office_read/office_write；office/{zip,parse,build}.ts 零依赖自建 OOXML（U 波）。缺口：PreviewPane.vue:40、115-120 对 pdf 和旧二进制格式只写「请用系统应用打开」，却没有按钮；main 和 preload 里 grep 不到 openPath/showItemInFolder
- 备注：保持「内容预览不等于版式还原」的边界和零依赖自建，这相对 DSH/ZCode 是差异化。要补的：shell.openPath/showItemInFolder，路径先过工作区围栏（S）；可选的高保真预览：探测本机 soffice 或 Office COM 导出 PDF，用 Electron 自带的 PDF 查看器显示（M）。和第 2 行的办公技能包一起做收益最大

**内置浏览器（用户可见的 webview 侧栏标签 + 安全基线）**

- DSH（shipped）：09-16/09-20 webview 侧栏：一次性租约 + 随机非持久 partition，will-attach-webview 用主进程配置覆盖 webPreferences，guest 拒绝全部权限请求和下载（dsh.md R4）
- ZCode（shipped）：IAB：独立 partition，will-attach-webview 强制 sandbox/contextIsolation，上限 32 个 tab；反面：注入宿主自己的 preload（含向官网暴露的桥），还有放行全部证书错误的开关（zcode.md R5）
- OpenMinis（shipped）：src/ios/Agent/BrowserUse：BrowserWebView、BrowserTabPool、CookieAuditLogger（iOS +302 行，Android +158 行）
- DeskMinis：README.md:33 写「浏览器/屏幕 ⛔」；main 和 renderer 里 grep webview/WebContentsView 零命中；外链目前会开一个无地址栏的 Electron 窗口（context #15），要先修
- 备注：先修 context #15（setWindowOpenHandler 一律交给 openExternal）。设计稿直接用 DSH 的租约模型做安全基线，preload 只暴露「申请/释放租约」。不做证书全放行，不向网页暴露任何 bridge，不导入 Chrome Cookie（ZCode 用提权 helper 解密是反面）

**agent 操控浏览器与桌面（CDP 离散工具、Playwright MCP 预设、computer-use、操作指示浮层）**

- ZCode（shipped）：IAB 通过 webContents.debugger 走 CDP，用 Playwright 注入脚本做 ARIA 快照；agent 操作浮层设 setContentProtection，排除出截图；开源版 CUA 只是占位包（zcode.md R5/R4/R3）
- DSH（experimental）：browser-use/computer-use 只做注册位，provider 是 Playwright MCP、Chrome DevTools MCP、Stagehand、Cua Driver，都在 packages/experimental 下；另有 GUIDANCE 操作纪律提示（dsh.md R4/R3）
- OpenMinis（shipped）：src/ios/Agent/BrowserUse/BrowserUseActions.swift、BrowserUseJavaScript.swift：应用内浏览器上的 agent 动作
- DeskMinis：bridge/handlers.ts:22 只有 6 个桥；唯一与屏幕相关的 windows-screenshot 只返回路径（handlers.ts:159-171），模型看不到画面（见第 18 行）
- 备注：零依赖路线：用 webContents.debugger 发 CDP，ARIA 快照改用 Accessibility.getFullAXTree 自己压缩。先做 5 个离散工具（navigate/snapshot/click/type/screenshot），全部过权限网关。反面：ZCode 的 code-mode 是单一 js 工具，restrictProcess 不是沙箱，还泄露全部环境变量；DSH 的原生 SDK 跑在宿主进程里，崩溃会连带宿主。桌面 computer-use 走 MCP 路线，输入类工具一律 gated，DSH 的 GUIDANCE 几乎可以原样作为提示节。前置条件：第 7 行的 MCP 图片结果和第 18 行的视觉能力

**Todo / 计划条 / 计划模式（长任务可见进度）**

- DSH（shipped）：todo_write 整表替换，TodoPanel 默认折叠；/plan 进入计划模式，exit_plan_mode 交审阅卡（软约束）（dsh.md R5 两条）
- ZCode（shipped）：TodoWrite 加节流提醒；plan 模式在权限层 deny 非只读工具，ExitPlanMode 复用权限卡；会话右上角状态浮窗（zcode.md R4 两条）
- AionUi（shipped）：v2.1.61 ConversationPlanBar 钉在输入框上方，确定性 id plan:{msg_id}，重开会话时回捞（aionui.md R4）
- DeskMinis：亲自 grep：13 个工具里没有 todo/plan；交接 §6「规划模式」未做；进度只有 TaskPanel 和 StepGroup
- 备注：todo_write 约 150 行，不需要新表：清单放在 parts_json 里，随同步走；渲染端从历史折叠出最新快照做 PlanBar。计划模式在权限网关层硬拒写类工具，比 DSH 的软约束更硬；工具目录不随模式增删，保住前缀缓存。与 agent 循环簇有交集，这里按「长任务可见进度」计入

**自动更新可用性、更新准入锁（运行中任务检查）、安装器加固**

- AionUi（shipped）：CdnGenericProvider 自有更新源；build-fast-debug-versions 在本机验证 vN→vN+1；NSIS 按 $INSTDIR 结束进程树、用 Restart Manager 查占用、写 installer-last-failure.json（aionui.md R4 两条）
- DSH（shipped）：inspect→lock→排空的准入锁；有运行中任务时改成 warning，默认焦点在「稍后」；关停走 shutdown→TERM→KILL 升级梯（dsh.md R4）
- ZCode（partial）：supervisor 的生命周期状态含 updating 和 crash-loop-stopped（zcode.md R5）
- DeskMinis：亲自读码：electron-builder.yml 配 publish: github，注释自认私仓下检查会 404；main/index.ts:131-144 选「重启并安装」就直接 quitAndInstall，不查运行中的回合、定时任务或待批权限；而 README.md:32 写「打包分发 ✅ … + 自动更新」，README.md:45 写「安装版（推荐，支持自动更新）」
- 备注：electron-updater 自带 generic provider，publish 指向一个公开静态托管即可，不把 token 打进应用，也不加依赖；仓库转不转公开由用户拍板。minisd 加 system.activeWork 和 system.shutdown 两个 RPC；用 nsis.include 写几十行 customCheckAppRunning，不要学 AionUi 给 electron-builder 模板打字符串补丁。必须在 Windows 真机走一遍「托盘态 + 有任务在跑时触发更新」

**技能多根与项目级技能：调用面字段、项目信任闸、注册表自愈**

- pi（shipped）：docs/skills.md:61 从 cwd 向上到仓库根发现 .agents/skills；docs/packages.md 规定项目包要等项目信任后才加载
- DSH（shipped）：6 级技能根（项目 .dsh/.agents → 用户 → 内置）；disable-model-invocation/user-invocable 取值写错时整条按不开放处理（dsh.md R3）
- ZCode（shipped）：多个根按 PRIORITY_STEP 合并；frontmatter 全在白名单内才标 safeToAutoLoad；工作区资源按声明 sha256 做信任（zcode.md R3/R4）
- AionUi（shipped）：readme.md:248-255 三层技能，会话头有技能指示器，可逐会话排除
- OpenMinis（shipped）：GH#215 技能注册表自愈：只用非空值覆盖空值、清理孤儿行、坏行不拖垮其它行（openminis.md R4）
- DeskMinis：skills/parser.ts:146-148 只认 name/description/version，调用面字段被忽略；minisd 里 grep .agents/.claude/AGENTS.md 零命中；只有全局库；「全局/助手/会话」三层判定没做（state 技术债）
- 备注：先做两个调用面字段（S）。项目级目录要等信任表（追加迁移 workspace_trust，按规范化内容的 sha256 记录，执行前复核）建好再做；不要学 pi 在未信任时就注入 AGENTS.md（pi.md R4）

**外部生态导入：粘贴 mcp.json、Claude/Codex 插件包、跨 agent 配置迁移、自定义 marketplace 源**

- ZCode（shipped）：manifest 可放在 .claude-plugin/.codex-plugin；市场源支持 url/github/git/npm/file/directory，不支持的组件逐条给诊断；settingsSyncService（2402 行）迁移十余家 agent 的配置（zcode.md R4 两条）
- pi（shipped）：docs/packages.md：pi install npm:/git:/本地路径，版本钉住，项目包要先过信任
- AionUi（shipped）：pages/settings/ToolsSettings/mcpJsonImport.ts 粘贴 JSON 导入 MCP
- OpenMinis（shipped）：src/ios/Views/MCP/MCPJSONImportSheet.swift
- DSH（shipped）：npm 源计划：npmjs 与 npmmirror 竞速，私有源不回落（dsh.md R4）
- DeskMinis：技能能从 github-url、zip、本地文件夹导入，市场固定三个源（market/client.ts:12）；没有 mcp.json 导入、没有插件包格式、没有 marketplace.json 自定义源（state 技术债列出）
- 备注：第一步只做「粘贴 Claude Desktop/Cursor 形态的 mcpServers JSON」，走现有确认卡：逐条给 skipReason，默认不覆盖。插件包只导入 skills 和 mcpServers 这个子集。导入值里的密钥一律进 vault（见第 6 行），否则导入越方便，明文越多

**远程与自动化入口：WebUI/手机伴侣、无头 CLI、深链协议**

- AionUi（shipped）：WebUI + Expo 手机端扫码登录，但扫码换 token 走明文 http（aionui.md R2）
- ZCode（shipped）：zcode --web + web-remote；反面：回环地址默认不发 token，/ws 不校验 Origin（zcode.md R4）
- OpenMinis（shipped）：src/ios/Agent/Intents：SendPrompt/ListSessions/FollowUpSession/RetryRun 等 App Intents
- pi（shipped）：stdio JSONL RPC 是稳定集成面，另有 SDK；Radius 云中继是实验品（pi.md R2）
- DSH（shipped）：ACP v1 服务端，CLI headless 模式（dsh.md R2）
- DeskMinis：remote/ 已有 X25519+PASETO 配对；index.ts:1097-1099 的 guardBusinessMethod 只拒 pairing 模式，authMode=remote 的对端可以调业务 RPC；cli/remote-cli.mjs 只有 pair/connect/status/unpair；没有 -p 无头提示、没有 deskminis:// 协议、没有任何客户端
- 备注：先做低成本的 CLI prompt/status/list（复用 RPC）、setAsDefaultProtocolClient 和任务栏跳转列表。手机端最有价值的场景是远程批准权限卡、查看定时任务结果，和第 11 行共用等待集合。立项前做安全评审：不学明文扫码换 token，不学回环无 token；还要先定下远端能不能批准本机的权限卡（pi.md R4 的附着语义）

**genui 内联交互组件：交付物卡 present、回合改动卡、内联指令块、富块查看器**

- DSH（shipped）：tool-present（09-08）让模型显式声明交付文件；workspace-changes（09-11）生成回合改动卡；正文里的路径只按记录链接（dsh.md R5）
- ZCode（shipped）：::name{k=v} 指令协议：code-comment 行级审阅卡、file-citation；流式未闭合时先隐藏（zcode.md R4）
- AionUi（shipped）：聊天内 Mermaid 可平移缩放、全屏查看；WaveDrom（新依赖）（aionui.md R1）
- OpenMinis（shipped）：minis:// 会话内资源 URL 可内联显示（openminis.md R3）
- pi（partial）：工具自带 renderCall/renderResult 渲染器（pi.md R3）
- DeskMinis：自研白名单 Markdown 只支持 h2/h3、列表、表格、围栏代码、引用、链接（state）；「改动」tab 只汇总文件工具的写入；交接三档「genui 内联交互组件」要求先出设计稿
- 备注：先做 present 工具和回合末的交付物卡，复用 collectArtifacts 和 LCS，一个几十行的工具加一张卡。再做 ::file 指令：纯函数抽取，TDD 覆盖代码块内不解析、未闭合、盘符路径。组件协议必须是封闭白名单，绝不渲染模型产出的任意 HTML（受 v-html 守卫约束）

**定时任务：agent 可创建（cron/提醒工具）、同会话提醒、防递归双闸、常驻**

- DSH（shipped）：schedule_create 支持 after/at/every；at 必须带显式时区，every 至少 300s，只在空闲时以 followup 投递，fork 不继承（dsh.md R3）
- ZCode（shipped）：CronCreate/Update/Delete 在 automation 轮对模型不可见，handler 再二次拒绝，总数上限 20；zcode-server-cli 守护进程常驻（zcode.md R3/R5）
- AionUi（shipped）：pages/cron/ScheduledTasksPage；「对话创建」由助手调用 cron 能力建任务；core v0.2.2 新增 conversation create；readme.md:84 标榜「Cron — 24/7」（aionui.md R3）
- OpenMinis（partial）：src/ios/Agent/Intents/* 用系统快捷指令自动化代替应用内调度
- DeskMinis：亲自读码：13 个内置工具里没有 cron 类；index.ts:493-511 的 cron.* 只供界面调用；index.ts:1128-1175 每次触发都新建会话、跑完写 markDone；main/index.ts:99 关窗是 hide 到托盘，应用和调度器继续运行；没有开机自启
- 备注：让 agent 建常驻任务，等于给提示注入开了一个持久化面。开放时要同时做到：权限固定为每次确认，确认卡逐字展示表达式、提示词和绑定的助手，automation 轮隐藏 cron_* 且执行器二次拒绝，设总数上限。同会话提醒需要给 cron 表追加 target_session_id 列。AionUi 的「跑成功 N 次后建议转成技能」卡可作为低成本配套

**子代理委派（只读 Explore / one-shot / 调用其它模型）**

- DSH（shipped）：spawn 与 fork，前台或后台，结束时通知回灌父会话；子代理审批钉为 never、不能向人提问；09-16 活跃上限改为 8，09-17 委派深度默认 1（dsh.md R4/R3）
- ZCode（shipped）：只读 Explore 档案，autoBackgroundMs，按无活动计时的看门狗，剔除审批类工具（zcode.md R3）
- OpenMinis（partial）：minis-model-use CLI 让 agent 调用其它已配置模型，v1.13 加了指数退避（openminis.md R3）
- AionUi（partial）：Team 模式经 ACP 拉起外部 agent 作为队员（readme.md:186）
- DeskMinis：state 标为 missing；13 个工具里没有 task/subagent
- 备注：起步只做 one-shot 前台只读子代理：同进程再起一个 loop，工具白名单只放读类，只把最终文本回给父会话。深度 1，并发 2–4，需审批的操作立即拒绝，不要等 90 秒（DSH 的教训：后台子代理卡在一个看不见的审批上）。前置：消息来源标注（dsh.md R4 MessageSource）

**评测体系：成对行为评测、文档一致性审计、性能基准、状态空间枚举**

- pi（shipped）：evals 重写：Docker 隔离的成对「文档增益」评测，两臂奇偶轮交替，缺臂即阻断 headline，缺失遥测记为不可用；documentation-audit.eval 输出结构化裁决（pi.md R4/R3）
- DSH（shipped）：09-05/06 新建 benchmarks/：合成 240 回合会话，打开、翻旧页、进 Trajectory 的预算分别为 900/700/520ms，统一 1.25 倍余量（dsh.md R3）
- ZCode（experimental）：formal-proof 枚举产品行为的状态空间，把 undefined 决策显式暴露；注释引用的黄金测试不在仓库里（zcode.md R4/R2）
- OpenMinis（partial）：ThinkingWireGoldenSnapshotTests 做字节级黄金快照（openminis.md R4）
- DeskMinis：tests/ 下 173 个文件都是单测和源码守卫，没有模型行为评测，也没有性能基准；GUI 验收靠 docs 分支上的 27 个 driver 剧本（state）
- 备注：零依赖形态：scripts/eval-*.mjs 经 minisd RPC 驱动真实模型（opt-in 提供 key），每次用全新 userData 和临时工作区，只按结果态评分（文件、DB 行、工具调用序列），不进 npm test；用于成对比较系统提示或技能包改动前后。文档审计 eval 直接对应「界面撒谎」教训：把 README 能力表每一行做成用例，本次就查出 README 的自动更新 ✅ 不实

**IM 机器人接入（飞书/钉钉/企微/Telegram/微信）**

- AionUi（shipped）：channels/ 下有 TelegramConfigForm、LarkConfigForm、DingTalkConfigForm、WecomConfigForm、SlackConfigForm、DiscordConfigForm；readme.md:296-303
- ZCode（shipped）：packages/services/src/bots/providers/feishuProvider、telegramProvider、weixinProvider；绑定码有 TTL，只接私聊，绑定时带工作区白名单（zcode.md R3）
- DSH（partial）：webhook 运行时把外部事件转成新会话，HMAC 校验，只触发不回报结果（dsh.md R2）
- DeskMinis：minisd 里没有 bots 或 channels 模块；远程面只有 remote/ 下的 X25519 配对
- 备注：这与「数据只在本机、除模型 API 外尽量不出网」的约束冲突。要做就默认关闭、逐平台 opt-in，界面写明消息经过哪家服务器；绑定码短 TTL、只接私聊、工作区白名单；IM 来的消息要标来源，权限只认本机人类输入。零依赖可行：长轮询或 webhook 用 fetch，验签用 node:crypto。每个平台单独一波

**图片生成**

- AionUi（shipped）：内置 image-gen MCP，外加平台×模型白名单（common/utils/imageModelAllowlist.ts）；注释承认：用名字子串匹配时，下拉里曾列出 gpt-image-1、dall-e-3 这类必定失败的模型
- OpenMinis（shipped）：minis-model-use 按 modality 支持文生图、图生图、图片编辑、TTS/STT（ModelUseOffloadBridge.swift:92-102）
- pi（partial）：pi-ai 的 generateImages 统一了 image 模型类型，只实现了 OpenRouter（a328aa8，09-23）；coding-agent 只在 model-runtime.ts:738 暴露给扩展
- DeskMinis：minisd 里 grep generateImage 和 images/generations 零命中；自研 Markdown 不支持图片（state）；交接 §6 三档候选，要求先出设计稿
- 备注：零依赖：复用 provider 的 fetch，走 OpenAI 兼容的 /v1/images/generations 和 Gemini 多模态输出；结果落到 attachments，并在消息里显示，这要给自研 Markdown 和预览补上图片渲染。吸取 AionUi 的教训：模型下拉只列已验证的白名单，不列必失败项。生成要花钱，首次调用走权限卡

**跨会话提及与上下文引用（@@ 会话、跨会话检索、会话间投递）**

- AionUi（shipped）：v2.1.60 @@ 通道：会话选择器、来源徽标、总开关，outbound/pair 两道限流，外加不自动消失的急停通知；反面：往正文里塞 [[AION_*]] 标记再反解（aionui.md R3）
- ZCode（partial）：read_session_context 按 query 打分截取，默认 24K 字符，上限 48K（zcode.md R2）
- OpenMinis（shipped）：minis-sessions-cli：querySessions 和 searchMessages 跨会话检索（SessionsOffloadBridge.swift:15-80）
- DeskMinis：minisd 没有会话间引用工具；StageSearch 只搜标题（state）
- 备注：先做只读的「@会话」引用：minisd 用 LIKE 取片段，结构化元数据落成列，不往正文塞标记。之后再考虑 session_send 投递，配「会话对 × 时间窗」限流，急停按钮放在出事的地方。检索实现和会话正文全文搜索（三档候选）共用

**Goal 长程目标与自动续跑**

- DSH（shipped）：每个会话最多一个 goal；空闲时排入 <goal_round>，默认上限 256 轮；恢复或分叉后一律 disarmed；创建和编辑要求本回合有人类输入（dsh.md R4）
- ZCode（shipped）：session_target 加独立 verifier 续跑，有 budget_limited 状态；反面：verifier 遇坏 JSON、请求失败或模型想调工具时都返回 passed:true（fail-open）（zcode.md R4）
- pi（partial）：agent_before_settle 可以追加条目并要求再请求一次（0.87.0，pi.md R3）
- DeskMinis：没有 goal 机制；loop.ts 以 maxTurns 200 硬停（zcode.md R4 核验）；用户说过「把他做成一个可以发布的版本」的 /goal 用法，说明有需求
- 备注：前置：消息来源标注。armed 标志绝不能进同步，否则两台机器会同时续跑。必须补 token 或费用上限，以及最大轮数的默认值；verifier 失败要暂停并提示，反 ZCode 的 fail-open；定时任务轮默认不自动续跑

**后台作业（长命令转后台、完成后回灌）**

- DSH（shipped）：ctx.jobs 按会话隔离，提供 job_output/list/kill；完成时 owner 正忙就 inject、空闲就 wakeup；08-26 起前台超时转后台，09-21 改为命令启动即登记；反面：maxConsecutiveWakes 没有默认值（dsh.md R5/R4）
- ZCode（shipped）：会话快照里有 backgroundWorks 状态键，状态浮窗里后台任务可以停（zcode.md R5/R4）
- DeskMinis：交接文档划掉了「后台作业」（dsh.md R5 核验）；agent 和终端共用一个长驻 PowerShell（terminal.ts）
- 备注：它和 cron 解决的不是同一个需求：这里是回合内的长命令（dev server、npm install）。难点在共享 shell，只对独立进程模式开启；进程树回收要用 taskkill /T，context #8 得先修。完成时只注入、不唤醒；UI 写明应用重启后作业即丢

**非开发者界面模式（Office/cowork 呈现：隐藏命令原文、终端、diff 计数）**

- ZCode（shipped）：InterfaceMode 分 office 和 coding，全仓 72 处 isOfficeMode，Ctrl+Shift+U 切换，权限卡不受模式影响（zcode.md R5）
- DeskMinis：渲染层 grep displayMode/officeMode/interfaceMode 零命中；StepGroup 直接展示工具名和命令
- 备注：直接回应用户「不止 coding，也像 cowork」的表态，但只动呈现层。红线：权限卡在任何模式下都逐字展示，写成守卫。可以和 DSH 的四档「工作详情」合并设计。按换壳教训，做成一个偏好开关，不要做第二套 UI

**生命周期 hooks 与代码级扩展 API**

- ZCode（shipped）：7 个 Claude Code 兼容事件，退出码 2 表示阻断，默认关闭；工作区 hook 按声明 sha256 做信任，执行前复核（zcode.md R4 两条）
- DSH（shipped）：hooks.json 兼容桥只执行 command 类，合并按 deny>ask>allow；Cordis 插件体系，09-14 新增插件管理器和热重组（dsh.md R3）
- pi（shipped）：extensions：tool_call 可阻断，user_bash 出错即中止（fail-closed），agent_before_settle 可要求再请求一次；用 packages 分发（pi.md R3，docs/extensions.md）
- AionUi（shipped）：Extension SDK：pages/settings/ExtensionSettingsPage.tsx 渲染扩展贡献的设置页，readme.md:255 的扩展技能层
- DeskMinis：state 标注「代码级插件/扩展 API/Hooks」为 missing；权限、offload、prune、记忆注入都内联在 loop.ts 里（pi.md R3 核验）
- 备注：不开放第三方 JS 插件（完整插件 API 属 XL）。反面参照：DSH 的 plugin_manager 连 list 都要审批，还撤掉过「生成代码插件」工具；pi 的包能执行扩展代码，必须先过项目信任。要做的话只做用户级 command hook，PreToolUse 映射到 PermCard；工作区 hook 必须过信任闸。内部可以先把 loop 拆成类型化 hook 表，方便单测

**多 agent 团队协作与工作流编排**

- AionUi（shipped）：Team 模式：Leader 拆任务，Teammate 并行执行，异步邮箱，共享任务板，队员可动态增减（readme.md:178-199，pages/team）
- DSH（experimental）：experimental/agent-team：名册、持久邮箱、任务 DAG；workflow 工具让模型写 JS 编排；Ralph 迭代（dsh.md R2/R3）
- ZCode（partial）：Expert 工作流（分阶段 + 终审 critic）；dynamic-workflow 依赖 typescript 编译（zcode.md R2）
- pi（experimental）：Pico5 的 TaskRecord 支持 after 依赖和 background（pi.md R2）
- DeskMinis：没有任何多 agent 结构；一个会话只有一条循环（state）
- 备注：除了倚赖外部 ACP agent 的 AionUi，其余都在实验区；DSH 自己承认 writeScopes 只是建议性前缀，不是锁。DeskMinis 应暂缓，先有子代理和并行写同一工作区的冲突策略。反面：没有进程级沙箱就开放脚本编排（DSH 的 workflow/PTC 有 OS 沙箱兜底，DeskMinis 没有）
