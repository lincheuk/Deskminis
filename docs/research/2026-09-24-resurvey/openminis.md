# openminis:verify
总述：OpenMinis 是 iOS（SwiftUI 外壳 + UIKit 组件，Agent 在 iSH Linux 沙箱中跑）与 Android（Compose + proot）双端的通用 Agent 应用。仓库是镜像式整批提交，粒度失真，代码注释里的 [T-xxx]/GH# 标签实际承担变更日志。基线 v1.10（9cf3a85）之后有 v1.12（09fc199）和 v1.13（4ef2900）两次整批同步。我按四个视角核对了源码与 git 历史，主要变化如下。

（1）备份/恢复从零上线，是最大的一块。iOS src/ios/Agent/Backup 共 29 个文件、+9041 行（读者写的是 31 个、约 1 万行，应以此为准）。Android 对应代码在 7b00d5c。包格式为 minisbak/1，口令加密用 PBKDF2 60 万次 + HKDF + AES-GCM 4MiB 分段，写包是自写的流式 zip64 writer。另有恢复语义、路径穿越防护、rclone 远端投递。已核实没有接上的部分：BackupZipWriter 的 resumingAt 没有调用方；加密包不走流式路径；导出侧没有可用空间检查。

（2）Provider 层把一年来各家报 400 的现场沉淀为 Thinking Rules 数据体系：4 个文件共 1410 行，有 provider_thinking_rules 表、黄金快照测试和用户规则编辑器。同时新增视觉组 read_image、目录驱动的 effort 档位、models.dev 归一化加多数票、按发布日期排序。

（3）循环与上下文方面：压缩的分段重试放宽为「除网络/取消外都重试」，两半摘要直接拼接；Android 另加 6 次调用、90–300s 墙钟上限，429/5xx/鉴权不拆分。修了压缩切点落在 tool_result 上的问题。被截断的写入直接拒绝执行。新增第三种中断形态「未获回复的用户尾」的恢复。每条消息落库时记录实际出答模型的快照。

（4）同步与存储的加固：UploadPolicy 漏登记 V3 类型；迁移新增挂起态和非破坏性重置；新字段按「键在不在」区分语义；快照列用 COALESCE 防旧设备回写清空；RebootGuard 降级模式；Android 在打开数据库前做版本守卫。

（5）沙箱与工具层没有新工具种类，全是可靠性修补：iSH shell 超时泄漏、卸载命令的取消转发、fork 背压、后台 CPU 闭环调控器、技能注册表自愈、GH#242 权限绕过。

（6）界面：会话分组加自动归组（v1.13 起两端都默认开启，读者说「两端不一致」不成立），「从此删除」，长粘贴折叠，读屏播报，平板分栏，本地化工具链。

对 DeskMinis，经 grep 核实、最值得立刻处理的有：
- 压缩把完整 raw history 当摘要输入，且请求以 assistant 结尾。tests/compact.test.ts:92 已把这个角色序列钉住，这在 Claude 4.6+ 上属于 prefill，会被 400，然后被 catch 静默吞掉。
- messages 表没有逐条模型字段，而模型组降级会改写会话绑定的模型。
- mcp/config.ts 读失败后 save 会覆盖原文件；openDb 不拦截数据库降级。
- Anthropic 只会发 budget_tokens；OpenAI 兼容路径不回传 reasoning_content。
- shell 超时只杀 powershell 本身，不杀进程树；桥调用没有取消转发；没有 read_image。
- 桥没有对端认证：sessionId 取自环境变量。

要点变化：
- v1.13 备份/恢复整套上线：iOS src/ios/Agent/Backup 29 个文件 +9041 行（6c08b18），Android 在 7b00d5c。包格式 minisbak/1：明文 manifest、JSONL 分片、内容寻址 blobs。加密用 PBKDF2 60 万次 + HKDF + AES-GCM 4MiB 分段，写包是流式 zip64 writer，恢复按 updated_at 取新并逐类别回滚。半截包续写（resumingAt 无调用方）、加密包的流式路径、导出前的空间检查都还没接上
- Thinking Rules 体系（850cad1 → 421699d）：src/ios/Providers/Thinking 共 4 个文件 1410 行，有 provider_thinking_rules 表、trace/证据类别、黄金快照测试和用户规则编辑器。v1.13 起 Claude 5+ 关闭思考时不再发 thinking disabled
- 逐消息模型归属快照（T-token-attribution-snapshot）：messages 追加 4 个可空列，fetchUsageStats 改为 COALESCE + LEFT JOIN，用量页分四态显示；同步回写时对快照列用 COALESCE(?, col)，有回归测试复现修复前后两条 SQL
- 视觉组（#182）：文本模型也注册 read_image，由组内视觉模型「代看」，最多尝试 3 个成员，每次 90s；注册描述与执行分支统一用 activeModelHasNativeVision 判定
- 压缩链路：v1.12 起分段重试「除网络/取消外都重试」，两半摘要直接拼接，不再做第三次合并调用；修复切点落在 tool_result 导致孤儿 function_call_output 的 400；Android 加 6 次调用上限和 90–300s 墙钟，429/5xx/鉴权不拆分
- 写入安全：被截断修复过的 file_write/file_edit 拒绝执行（#119）；file_write 描述里写明大内容分块或用脚本生成（GH#223）；file_read 截断时给出真实行区间和 next_offset
- 沙箱执行层：iSH shell 超时泄漏修复（2df21b6，约 30 次超时后线程池被耗尽）；卸载命令的 abort handler 与 ffmpeg 中毒标记；fork 内存背压；后台 CPU 闭环调控器（有设计文档，真机实测）
- 同步加固：UploadPolicy 补登记漏掉的 V3 provider 类型（#98），关闭开关此前形同虚设；迁移增加挂起态、非破坏性重置、进度钳制（#141/#154）；folderId 按「键在不在」区分语义；ProviderConfigStore 的 RebootGuard 在降级态禁止 save
- Android 在 Room 打开前读 user_version 做降级守卫（DatabaseVersionGuard），引导页刻意不提供清空按钮，并注册 MIGRATION_12_11 空降级迁移
- 中断恢复第三形态（GH#262/263）：会话以没有回复的用户消息结尾时，resumeUnansweredUserTurn 直接请求回复，不注入「用户中止」提示
- 界面：会话分组加「标题生成时顺带归组」（v1.13 起 iOS 注册默认 true，与 Android 一致）、从此删除（后缀截断）、Android 长粘贴折叠、读屏播报、平板可拖拽分栏、应用内语言切换和 locale 脚本
- 文档：新增 docs/ish-bg-cpu-governor-design.md、docs/backup-streaming-package-design.md；中文的 backup-restore-design.md、group-feature-design.md 已从 HEAD 删除（2a79655），但在 2c6ca20 的历史里可以取回。调试 RPC 方法从约 105 个增到约 142 个，docs/specs 自 v1.10（3bfca34）以来没有改过

核验后发现（按相关度降序；verdict=CONFIRMED/CORRECTED；DM=DeskMinis 现状）：
- R5 [corrected|providers|新:部分：两代分叉是基线已有；v1.12 收归 resolver，v1.13 修 Claude 5 的 disabled 400|DM:partial：有 thinkingLevel 通路和钳制，但 Anthropic 只会发 budget_tokens，档位也没有界面入口] Anthropic 思考参数按代际分叉，「关」的写法也分代；OpenMinis 的 5+ 规则比官方文档粗：OpenMinis 的 Anthropic 思考参数由 ThinkingRuleResolver.anthropicThinkingShape 统一决定：
- 4.6+ 发 effort（adaptive）；≤4.5 发 budget_tokens。
- 关闭时只有 4.6–4.x 发 disabled；5+ 什么都不发（v1.13 修复，标签 T-ios-claude5-thinking-disabled-400）。

官方规则（claude-api 技能的模型表）：
- budget_tokens：在 Opus 4.7/4.8/5、Sonnet 5、Fable 5/5.1 上返回 400；在 4.6 上已弃用。
- disabled：Opus 4.7/4.8 和 Sonnet 5 接受；Opus 5 只在 effort≤high 时接受；Fable 和 Opus 5.5 一律 400。
- 缺省 thinking 字段：Opus 4.7/4.8 不思考；Opus 5、Sonnet 5、Fable、Opus 5.5 都走 adaptive。

对照可见两点偏差：
- OpenMinis 在 Sonnet 5 和 Opus 5 上的「关」实际变成了 adaptive 思考。
- 它给 4.6–4.x 显式发 disabled 的注释理由是「缺省会默认思考」，与官方表不符（不过发了也无害）。

DeskMinis：
- anthropic.ts 在 level≠off 时发 {type:enabled, budget_tokens}。
- 渲染端和 cron 都不传 thinkingLevel，所以恒为 off、省略该字段，当前不会 400。
- 一旦开放档位，在 4.7+ 上会全部 400。
- 即使是 off，Claude 5 家族照样会 adaptive 思考。 ⇒ 借鉴：在 minisd/providers 写一个纯函数 anthropicThinkingShape(modelId, level, effort)，按官方表逐代建表，用快照钉住：
- ≤4.5：用 budget。
- 4.6：adaptive+effort。
- 4.7/4.8：adaptive；关闭时省略字段即可（缺省就不思考）。
- Sonnet 5：关闭发 disabled。
- Opus 5：effort≤high 时关闭发 disabled，否则降 effort。
- Fable / Opus 5.5：不能关，只能降 effort（Opus 5.5 默认 medium）。

先写红测，再在 Composer 开放档位。auto-title 的 maxTokens 是 64，在 Claude 5 家族缺省思考的情况下可能被思考吃光，需要一并处理。（核验：源码属实，但有三处要纠正或补充：
- OAuthHTTPClient 的实际行号是 1221-1252。
- adaptive/budget 两代分叉在基线已有，本窗口新增的是：收拢到 resolver，以及 Claude 5 关闭时不发 disabled。
- 补充了官方的「缺省行为」事实。

另：DeskMinis README 写「思考过程可见（Anthropic 原生思考…）」，但档位恒为 off。在 4.x 上不会产生思考；在 5.x 上 display 默认是 omitted，只得到空文本。Anthropic 这一路的「可见」实际不成立，建议复核 README 措辞。）
- R5 [corrected|providers|新:no（Mistral 禁止回传为 v1.13 新增）|DM:missing] 默认开着思考的模型：关闭要显式发；reasoning_content 捕获即回传，占位受门控，Mistral 禁止：OpenMinis 对默认会思考的模型族（Qwen3、DeepSeek V4 等）和 OpenRouter 总是注入思考参数，关闭时也要显式发。源码注释记录了现场 400：deepseek-v4-flash 在关闭档照样思考，随后因工具历史缺 reasoning_content 被拒。

reasoning_content 的回传分两路：
- 已捕获的值只要存在就原样回传，包括空串，不受当前档位门控（T-mimo-reasoning-echo：MiMo 缺字段会 400）。Responses 的加密摘要替换成空串。
- 补空占位受门控：需要 includeReasoning（当前开思考或模型必推理，且模型可能推理），并且模型必推理或声明了 interleaved 字段。
- Mistral（v1.13，#87）两路都禁止，否则 422。

DeskMinis：
- buildOpenAIBody 的 assistant 消息只带 content 和 tool_calls。
- 流里只读 delta.reasoning_content。
- 关闭档从不显式关闭。
- 用 DeepSeek V4 跑多轮工具调用，正好是 OpenMinis 实测 400 的那种形态。 ⇒ 借鉴：AgentMessage 增加 reasoningContent 字段，经 buildEffectiveHistory 一路传到 buildOpenAIBody。

回传策略：
- 按端点和模型族门控，Mistral 设为 never。
- 已捕获的值原样回传。
- 占位只在开思考且模型族要求时补。

关闭档对 deepseek-v4* 发根级 thinking:{type:disabled}。先写红测，覆盖 DeepSeek 形态的多轮工具请求体。（核验：读者把回传条件写成「按当前开启思考…为条件回传」，这不准确：只有占位是这样门控的，已捕获的值是「存在即回传」。另外，MiMo 的两路拆分在基线已有，本窗口新增的只是 Mistral 禁止回传。）
- R5 [corrected|context|新:部分：重试策略与拼接为 v1.12 新增；Android 预算为 v1.13 新增|DM:partial：有压缩与卸载，但输入选取、输出上限、错误可见性都有缺陷] 压缩：DeskMinis 把完整 raw history 当摘要输入，请求以 assistant 结尾（Claude 4.6+ 上是 prefill，会 400）；OpenMinis 做法是压平成文本、增量合并、分段重试、设预算上限：OpenMinis 的压缩流程：
- 用 buildConversationTextForSummary 把对话压平成文本：工具结果截 500 字，工具调用只保留 path 或 command。
- 与上一份摘要按「Previous context summary / New conversation to merge」增量合并。
- system prompt 是结构化的：原样保留路径和标识符，全部写成过去时，不列待办。
- 输出上限为 max(1024, min(8192, 窗口−输入))。

以上在基线已有。v1.12 新增：除取消和网络错误外，任何失败都二分重试（深度<3），两半摘要直接拼接，不再发第三次合并调用。Android 另加三道闸：单次压缩最多 6 次 LLM 调用；墙钟 90s 起、每 1 万字符加 30s、封顶 300s；429/5xx/鉴权失败不拆分。

DeskMinis 的问题：
- loop.ts 把 store.listMessages 的完整 raw history 传给 summarize，切片从 history[0] 开始，不并入已有 marker。第二次压缩时，摘要请求会远大于触发压缩的有效历史。
- maxTokens 只有 1024，提示词要求「≤500 字」。
- 失败被 catch 吞掉。

核验时补充的一处缺陷：摘要请求的 messages 形如 [summaryPrompt(user), …, 锚点(assistant)]。tests/compact.test.ts:92 显式钉住了角色序列 [user, user, assistant]。锚点通常是上一轮助手的收尾消息，因此请求以 assistant 结尾。按 claude-api 技能，assistant prefill 在 Opus 4.6/4.7/4.8/5、Sonnet 4.6/5、Fable 上一律 400。所以 Anthropic 原生路径上对当前 Claude 模型的压缩很可能从未成功过，只是被静默吞掉了。 ⇒ 借鉴：先写两条红测：
- 已有 marker、raw 约为窗口 2 倍时，断言摘要请求的估算不超窗。
- Anthropic 形态下，断言摘要请求的最后一条是 user。

修法：
- 输入改为「上一份摘要 + 锚点之后到新锚点的消息」。
- 压平成单条 user 文本：同时消除 prefill 和 tool 配对问题。
- 失败时二分，深度≤2、调用≤6，加墙钟上限，429/5xx/鉴权不拆分。
- maxTokens 提到 4096–8192，改用结构化提示词。
- catch 里至少发一条 eventNote 并记录原因。

以上都是纯 TS。（核验：事实属实。纠正 new_since：压平成文本和增量合并在基线已有；新增的是「任意错误都重试 + 拼接」以及 Android 的三道闸。prefill 这条是核验时从 DeskMinis 测试和 claude-api 官方表推出的，建议在本地假端点或真机上用 Opus 4.6+ 复现确认。）
- R5 [confirmed|providers|新:yes|DM:partial] 数据驱动的思考参数规则表：两阶段解析、可解释的 trace、用户规则和编辑器：ThinkingWireFormat 枚举了各家的思考参数形状，包括 omitEverything、reasoningEffort(offValue)、reasoningEffortNested、deepSeekSibling、qwenDual、qwenRootOnly、booleanToggle、extraBodyToggle、customPath、anthropic 与 gemini 各型，每个 case 都附有现场证据。

解析器是纯函数，输入是 ThinkingResolveContext，其中端点特性（isOpenRouter / isMistral / isXAI / isDashScope 等）由调用方算好传入。
- 规则顺序：用户规则 → 内置规则。
- 每次解析输出 trace，含 gate 证据类别：modelFamily / catalogAuthoritative / catalogHeuristic / endpointIdentity / modelCapability。
- 用户规则存在 provider_thinking_rules 表，iCloud 同步。
- 编辑器支持 glob 匹配（. 与 - 等价）、拖动排序、请求预览。
- 在官方协议路径（Anthropic / Gemini / Responses）上，编辑器会明说「用户规则不生效」。

DeskMinis 目前只在 OpenAI 兼容路径发平铺的 reasoning_effort，外加两个布尔兼容开关。 ⇒ 借鉴：新增 minisd/providers/thinking-rules.ts：导出一个纯函数 resolve(ctx)，返回 {patch, trace}，由 openai、anthropic、gemini 三条路径共用。

第一版只放内置规则：
- DeepSeek V4：根级并列。
- OpenRouter：嵌套写法，关闭时省略。
- Mistral：全部省略。
- Qwen：按 DashScope / 中转分形状。

trace 写进 dry-run 诊断。用户规则等有界面再做，持久化可放在 providers.json，不需要新表。界面上照「不生效就明说」的原则处理。（核验：4 个文件共 1410 行，由 850cad1/421699d 新增，已逐项核对。合并了界面读者的「思考规则编辑器」一条。）
- R5 [corrected|tools|新:yes（视觉组；T264 占位基线已有）|DM:missing] 视觉组 + read_image：文本模型也能「看」图，注册和执行用同一个判定：视觉组就是一个普通 ModelGroup，由 ProviderConfig.visionGroupId 指向。

工作方式：
- 主模型不能看图时仍注册 read_image，把图交给组内能看图的成员，返回「描述 + 可见文字逐字转写」。
- 描述模型的系统提示明确要求不执行图内指令。
- 可选 prompt 参数让主模型追问细节。
- 最多尝试前 3 个成员，每次 90s；loadBalance 组按 seed 轮转。
- UI 显示是哪个模型描述的、之前哪些失败了。

注册描述文案和执行时的分支统一用 activeModelHasNativeVision，取自实际发请求的 resolveCurrentEntry()。历史图片在非视觉模型上换成占位符（T264 在基线已有）；新增的是配置了视觉组时，占位符里提示「调用 read_image 读取 <path>」。Android 去掉了凭据探测门槛。

DeskMinis：
- 没有 read_image，也没有任何视觉能力判定。
- openai.ts 对任何模型都无条件拼 image_url。 ⇒ 借鉴：分两步做：
1. model-catalog 增加 imageInput 能力位。模型不支持时，历史图片换成带路径的文本占位符，防止切到文本模型后会话 400。
2. 内置 read_image(path, prompt?)：
   - 原生视觉模型：Anthropic 在 tool_result 里放 image 块；OpenAI 兼容在工具结果后追加一条带图的 user 消息；Gemini 用 inlineData。
   - 否则走视觉组。视觉组复用模型组，settings 加 visionGroupId 指针。

降级改绑后，注册和执行要用同一个函数，按当前 slot 重新判定。（核验：合并了 agent 视角与工具视角的两条。纠正：非视觉模型的图片占位（T264）在基线已有，本窗口新增的是视觉组，以及占位符里的可操作提示。「最多 3 次」已确认（maxAttempts=3）。）
- R5 [confirmed|sync-storage|新:yes|DM:missing] 逐消息模型归属快照：用量不再随会话改绑漂移：问题：用量页原来用 sessions.model_id 连表，而这一列每次换模型（包括静默降级）都会被改写，会话的全部历史都被算到当前模型头上（注释原话：a billion deepseek tokens became grok tokens）。

v1.13 的做法：
- messages 表追加 model_id、model_display_name、provider_type、provider_instance_id 四个可空列，NULL 就表示「旧行、按会话估算」。
- fetchUsageStats 改为 COALESCE(m.model_id, s.model_id) + LEFT JOIN + has_snapshot。
- UI 分 measured / estimated / unknownSession / measuredRemoved 四态，各自分桶。
- 同步 UPDATE 对快照列用 COALESCE(?, col)，防止旧设备回写把新设备的记录抹掉。SyncedMessage 以可选字段携带，不升协议版本。
- Android 有 schema 12 和迁移测试。

DeskMinis：
- messages 只有 token_usage。
- 模型组降级会把会话改绑到接手的模型（README 已写明），将来做用量面板会遇到同样的错账。 ⇒ 借鉴：追加迁移 MIGRATIONS[11]：messages 增加 model_id / model_label / provider_kind / provider_id 四列，全部可空、不设默认值。loop 落库助手消息时，写入实际出流的 slot（slotLabel 已是唯一格式出口）。sync/wire 以可选字段追加，合并端用 COALESCE。

历史数据补不回来，列越早加越好；面板可以晚做。要同步更新 user_version 版本钉测试，并在 commit 里申报。（核验：合并了三个视角的同一事实。数量级以源码为准：是十亿（billion），同步读者写的「一亿」有误。）
- R5 [confirmed|safety|新:yes|DM:missing] 配置「读不出来」不等于「不存在」：降级模式下禁止保存（RebootGuard）：ProviderConfigStore 把加载结果分成三态：文件不存在 / 存在但读不出 / 读得出但解码失败。后两种进入降级模式：
- save() 被硬拦截，不写库，也不推送 iCloud。
- 设备解锁或回到前台时重新加载。
- 如果解锁后仍然解码失败，就退出降级态，靠 V3 DB 恢复。

MigrationEngine 在读到 0 个会话却有 N 条消息时，判定库不一致，拒绝走「删除云端 v1 区」的捷径。

DeskMinis：
- mcp/config.ts 在 load 解析失败时（readFileSync 抛 EBUSY 也在同一个 try 里）只设置 loadError，entries 为空；save() 不检查 loadError。结果是新增一台服务器，就会把损坏但本可手修的原文件原子覆盖掉。
- provider-store 解析失败会在构造器里直接抛异常。 ⇒ 借鉴：load 区分 ENOENT 与其它错误。有 loadError 时 save 拒绝，或者先把原文件改名为 servers.json.corrupt-<ts> 再写。Windows 上杀软、OneDrive 短暂占用文件导致的 EBUSY 更常见。同步也不能把降级加载得到的空状态当作真相发出去。先写红测。（核验：已逐行核对。合并了 agent 视角「降级守卫」条目中关于 RebootGuard 的部分。）
- R5 [confirmed|ui|新:no|DM:missing] 流式 Markdown 的分档节流、换行快通道、大消息折叠与流式降级：iOS 按回复长度分档刷新：500 字以下 0.2s，2K 以下 0.3s，32K 以下 0.5s，64K 以下 1s，128K 以下 1.5s，再往上 2s。5000 字以内另有换行快通道（攒够 50 个未刷新字符）。

Android 按块渲染并采样；已冻结消息超过 32K 字默认折叠，流式缓冲超过 8K 降级为纯文本尾窗。

DeskMinis 的 StageChat：streamNodes 每次增量都对整段文本重新解析；模板里的 mdOf(b.text) 是函数调用，每次重渲染会把全部历史消息重新解析一遍。 ⇒ 借鉴：四步：
1. 历史回合按 messageId+长度缓存解析结果，或抽成子组件。
2. 写 lib/markdown/throttle.ts 纯函数做采样，照搬 6 档时间和换行快通道。
3. 只重解析最后一个未闭合的块。
4. 超过 32K 默认折叠。

先写红测，零依赖。（核验：已核实。）
- R5 [corrected|ux-flow|新:部分（仅从此删除为新增）|DM:partial] 消息级操作面：编辑重发、重试、从此删除（后缀截断）、压缩到此、撤销压缩：用户消息菜单：Edit / Retry / Delete From Here（带确认）/ Compact Above；助手消息菜单另有 Copy All / Copy Markdown / Read from Start / Force Sync。

从此删除只允许后缀截断，并锚定在用户气泡上，防止出现孤立的 tool_use。

反面：助手菜单的 Copy All 和 Copy Markdown 执行的是逐字相同的代码。

DeskMinis 只有出错时的 retryLast，没有截断、重试、手动压缩类 RPC。 ⇒ 借鉴：加三个 RPC：chat.messages.truncateFrom、chat.retryFrom、chat.compactBefore。每个都先写红测，覆盖「截断后没有孤立 tool_use」这一不变量。撤销压缩就是删掉最新的 marker。桌面上用悬停工具条，破坏性操作二次确认，每个菜单项都要有测试。（核验：new_since_baseline 应为「部分」：只有从此删除是 v1.13 新增；编辑、压缩到此、撤销压缩在基线已有。Copy All 与 Copy Markdown 相同已逐行确认。）
- R5 [confirmed|tools|新:yes|DM:partial] shell 超时和停止：清理整棵进程树，超时路径自己收尾：泄漏原因：已被回收成僵尸的任务不会再发退出通知，上下文和读线程永远挂着，大约 30 次超时就耗尽线程池，只能重启设备。

修法（2df21b6，ISHShellExecutor.m +408 行）：
- finalizeTimedOutPid，由 didFinalize 保证只收尾一次。
- closePipesIfNoReaders：读线程全部退出后才关 fd。
- 60 秒一次的 sweepStaleContexts 兜底清扫。
- killProcessGroup 按 pgid 和祖先链匹配，先 TERM 后 KILL。
- Stop 不再进 actor 排队。
- claimResume 防止重复 resume。

DeskMinis 的 interrupt/dispose 只对 powershell 本身 kill('SIGKILL')，Windows 上孙进程会成为孤儿；killTree 只用在 MCP 上。 ⇒ 借鉴：interrupt/dispose 复用 killTree（taskkill /T /F）。进一步可以只杀本条命令的子树（枚举驱动进程的子进程），保留 cwd 和环境变量。ShellManager 暴露存活计数。Windows 真机用心跳孙进程做测试。（核验：已核实。）
- R4 [confirmed|dx-testing|新:yes|DM:partial] 重构前先提交按旧实现生成的字节级黄金快照，并补交叉维度：ThinkingWireGoldenSnapshotTests 覆盖「模型 × 档位 × 端点标志」矩阵，渲染成规范化 JSON（键排序、数字格式稳定），要求重构后原样通过。它和 ThinkingRulesRegressionTests 分工：回归测试证明「测过的没变」，快照证明「什么都没变」。文件头规定：不得为了变绿而重新生成快照。

第一版规则表调换了顺序，引入 qwen×统一网关、gpt-5×DashScope 的静默退化，快照没有拦住，因为每行只变一个维度。之后才补上交叉行。Android 有同构测试。 ⇒ 借鉴：改 buildOpenAIBody、anthropic、gemini 之前，先用现有实现生成 tests/fixtures/*.golden.json（递归排序键，零依赖）。矩阵要包含交叉维度：端点 ×模型族 ×档位 ×有无图 ×有无工具。与 TDD 纪律直接契合。（核验：「重构前先提交」这一点：镜像是整批提交，git 上无法佐证提交顺序，只能以文件头的声明为准。）
- R4 [confirmed|ux-flow|新:部分：档位选择器基线已有；effort 数据驱动为新增|DM:missing（后端有钳制，没有界面，也没有 effort 档位数据）] 思考档位由目录声明的 effort 档位驱动；界面只列真实不同的档，并显示钳制提示：数据来源：LLMModel.reasoningEffortValues 取自 models.dev 的声明，例如 glm-5.2 / deepseek-v4 为 [high,max]。

界面：
- selectableThinkingLevels 只列线上值真正不同的档位，声明里的最高档作为上限；用户覆盖只能压低上限。
- 斜杠菜单里的 /thinking 分段控件（基线已有）：超出上限时高亮落在最高可用档，并显示橙色 ↑。

发送：
- clampEffort 按阶梯取不高于请求的最近声明档。
- 关闭档刻意不走 clamp。
- offTierNotDeclared 只在声明是权威时才压制关闭档；跨 provider 多数票的结果只用于钳制。

DeskMinis：
- 只有 off/low/medium/high 四档，model-catalog 只有一个 thinking 布尔位。
- 渲染端不传 thinkingLevel，没有界面入口。 ⇒ 借鉴：Composer 加一个「思考」胶囊，按会话记住选择（sessions 加 thinking_level 列，只追加迁移）。ModelCatalogEntry 增加 effortValues 和 authoritative 字段，胶囊只列可用档，钳制时显示 ↑。clampEffort 写成纯函数放进 thinking-rules.ts。（核验：合并了界面视角的「思考强度选择器」（基线已有）和 agent 视角的「目录驱动 effort」（v1.12/1.13 新增）。）
- R4 [confirmed|agent-loop|新:yes（第三态为新增）|DM:partial] 中断恢复分三态：retry / resume / 未获回复的用户尾：OpenMinis 区分三种中断形态：
1. retry：清掉未提交的流尾，重新请求。
2. resume：历史以 assistant 结尾时，补一条合成的 Continue；以 tool_result 结尾时直接续跑。
3. v1.13 新增（GH#262/263）：用户消息已落库但回复还没落库时进程被杀。recheckCanResumeFromHistory 会识别这种尾巴，resumeUnansweredUserTurn 不注入「用户中止」提示，直接新建 assistant 行请求回复。

DeskMinis：
- retryLast 只是把最后一条用户文本再 send 一次，会在历史里重复用户回合。
- 入口挂在内存里的 eventNotes 上，重载后就没了。
- minisd 没有 resume/retry RPC。 ⇒ 借鉴：加一个 chat.resume(sessionId)，按尾部形态分三种处理：
- 不新写用户消息，合成提示只加在请求侧。
- 复用 runAgentLoop 和 pairToolResults。

渲染端：最后一条是 user 且没有在跑，或者 assistant 带 errorInfo 时，显示持久的「继续」按钮，不依赖 eventNotes。（核验：已核实。）
- R4 [confirmed|safety|新:yes|DM:partial] 参数被截断时：写入类工具拒绝执行，并告诉模型准确原因；大文件写入给出分块指引：OpenMinis 的 JSON 修复遇到未闭合的字符串会补上结尾，对 file_write 来说这和模型本来就在那里结束 content 无法区分，结果半个文件落盘，两边都报成功。

v1.12 起（#119）：
- 修复策略为 truncation+ 的 file_write/file_edit 直接拒绝执行。给模型的文案写明：没有执行、文件未改动、多半撞到了输出上限，请分块 append。UI 显示「Blocked: arguments were truncated in transit」。
- 其它工具照常执行，但在结果末尾附 system-reminder，工具卡显示失败态。
- 大文件写入超时时，错误文案追加一句分块或改用脚本生成的建议（GH#223）。

DeskMinis：非法 JSON 一律落成 '{}'，由 preflight 报「缺少必填参数」，不会写半截文件。但模型拿到的原因是错的，可能反复重试同一个超长写入。 ⇒ 借鉴：保留「落成 '{}'」的安全做法，只补原因：当 JSON.parse 失败且原始 input 非空（或本轮 stopReason=maxTokens）时，把该工具的错误结果换成专门文案「参数在输出上限处被截断，未执行，目标文件未改动；请分多次 append 或用脚本生成」。

一条红测即可钉住，同时断言文件没有被改动。（核验：合并了 agent 视角与工具视角的两条，已逐行核对。）
- R4 [confirmed|sync-storage|新:yes|DM:missing] 数据库降级守卫：库版本比程序新时，在打开前拦下，引导页不给清空按钮：Android 的 DatabaseVersionGuard 在 Room 构造之前，以只读方式读取 user_version。库版本比代码认识的新、又不在无害降级白名单里时，进入引导页。引导页刻意不提供「清空数据继续」。同时为只加列的迁移注册了空的降级迁移 MIGRATION_12_11，并有测试钉住版本常量。

DeskMinis 的 openDb 在 current > MIGRATIONS.length 时一次迁移都不跑，照常读写，不发出任何信号。而安装版和便携版共用 %APPDATA%。 ⇒ 借鉴：openDb 在 current > MIGRATIONS.length 时抛出带类型的错误，主进程显示「数据由更新的版本写入，数据未改动，请安装最新版」，不提供清空按钮。先写红测：构造一个 user_version=N+1 的临时库。零依赖。（核验：合并了三个视角的同一事实。）
- R4 [confirmed|sync-storage|新:yes|DM:missing] .minisbak/1 包格式：明文 manifest、分片 JSONL 信封、内容寻址 blobs、目录树索引：包本身是标准 zip：
- manifest.json 始终明文，带 format 主版本（读端不认识就拒绝）、统计、limits、encryption、integrity。
- data/*.jsonl 每行一个 {t,v,d} 信封，单片上限 64MB。
- blobs/<xx>/<sha256> 按内容去重。
- files.index.jsonl 记录目录树，含墓碑。

解码器手写容错：未知字段忽略，缺失字段取默认值。Voice Corrections 移出可备份列表，但枚举值保留。 ⇒ 借鉴：在 minisd/backup 下按类别导出 JSONL，外加 blobs，格式主版本号和「未知字段忽略」规则写成测试。整库灾备可以另走 better-sqlite3 自带的 db.backup()。备份不纳入会话绑定的用户项目目录。读端按规格自己写，不照搬代码。（核验：已核实。）
- R4 [confirmed|sync-storage|新:yes|DM:partial（只有 OOXML 用的内存 zip）] 流式 ZIP 写入：不用 data descriptor，从一开始就写 zip64：BackupZipWriter 的做法：
- 条目按产出顺序顺序追加，临时副本写完立即删除。
- 每个条目在写头之前就算好 CRC 和大小，不用 data descriptor，这样可以顺着本地头链做续写。
- 已压缩的扩展名直接 store。
- 从一开始就输出 zip64。

读端已经补上 zip64 EOCD 和 0x0001 extra field。设计动机：3.84GB 的备份需要约 11.5GB 可用空间。 ⇒ 借鉴：另写一个流式 writer：fs.writeSync 追加写入，用 zlib.crc32（DeskMinis 已经在用，不需要回落方案）。按扩展名选 store 或 deflate，从一开始就写 zip64。要有 >4GB 的稀疏文件往返测试。（核验：已核实。）
- R4 [confirmed|safety|新:yes|DM:missing] minisbak-enc/1：只用标准库的口令加密，由引擎层强制「带凭证必须加密」：密钥与加密：
- PBKDF2-HMAC-SHA256 600k 次，不用 Argon2（两个平台都要引第三方库）。
- HKDF 派生 data、secrets、mac、verify 四把子密钥。
- AES-GCM 按 4MiB 分段，AAD 为 path#segment。

校验：
- verifier 让口令错误立刻报错。
- manifest.mac 对原始字节做 MAC。
- integrity 存的是密文哈希。
- 顺序固定为：完整性 → verifier → MAC → 解密。

防护：
- 降级保护：manifest 没声明加密、包里却有 .enc 成员时拒绝。
- exportBody 在引擎层拒绝「导出凭证但没有口令」。
- 恢复凭证时，本地已有的不覆盖。 ⇒ 借鉴：用 node:crypto 的 pbkdf2（异步版）、hkdfSync、aes-256-gcm 可以一比一实现。DPAPI 与本机绑定，换机后解不开，所以换机迁移必须用口令加密凭证段。「无口令导出凭证」必须在 minisd 引擎层拒绝，不能只靠 UI。（核验：已核实。）
- R4 [confirmed|sync-storage|新:yes|DM:missing] 恢复语义：按记录合并、updated_at 取新、清除删除墓碑、跳过运行中会话、恢复后以本机身份重新同步：恢复默认是合并而不是替换：
- 按 id upsert，本地更新或相等时保留本地，重复恢复不产生变化。
- 消息保留原始 sort_order。
- 恢复前清掉删除墓碑。
- 正在跑的会话跳过并计数。
- 恢复出来的行走普通脏标记，由同步重新上传，不写 pushed 账本。

Provider 原来是整体替换，而确认框写的是「不删除任何东西」；现在改为按 id 取并集合并，并按备份里的顺序排列。报告按类别列出计数。

DeskMinis 的 LAN 同步没有删除墓碑：删掉的会话会被对端 sync.list 加 pull 重新创建。 ⇒ 借鉴：恢复复用 sync/merge.ts 的合并逻辑，拒绝写入正在运行的会话，报告逐类别给数字。先明确删除语义（墓碑），否则「恢复旧备份」和「对端推回已删会话」会缠在一起。（核验：只抽查了主要路径。DeskMinis 缺墓碑一点已 grep 确认。）
- R4 [confirmed|safety|新:yes|DM:partial（只有工具侧的 workspaceOf 围栏）] 防路径穿越：包内索引里的路径也是攻击面，包含检查两侧都要解析符号链接：恢复写文件时，目标路径来自 files.index.jsonl 的内容，不是 zip 条目名，所以解压器自带的穿越防护覆盖不到。

修复：
- 每个类别一个 containmentRoot。
- 两侧都先 standardized 再 resolvingSymlinksInPath（iOS 的 /var 是 /private/var 的软链，只解析一侧会拒掉所有文件）。
- 前缀比较要求末尾带分隔符。

Android 用 canonicalFile 实现同一规则。 ⇒ 借鉴：导入包或安装技能 zip 时，Windows 上要做到：
- 路径比较大小写不敏感。
- 拒绝盘符、UNC、ADS 冒号、保留设备名，以及结尾的点或空格。
- 两侧都用 fs.realpathSync.native 解析后再比较，前缀以 path.sep 结尾。
- 守卫要有「故意破坏 → 变红」的测试。（核验：已核实。）
- R4 [corrected|sync-storage|新:yes|DM:partial] 同步字段演进：用「键在不在」区分语义，快照列用 COALESCE：新增字段一律做成可选字段，不升协议版本。
- 接收端用 record.fields["folderId"] != nil 判断键是否存在：键存在（哪怕是显式 null）才允许清空本地值；键缺失说明对方是旧版，不动本地值。
- 快照列用 COALESCE。
- 文件夹删除作为墓碑传播，只清空成员的 folderId。

DeskMinis 的问题在 chat-store.mergeRemoteSession：当对端 updatedAt 更新时，UPDATE 用 ws.modelBinding ?? null、ws.pinnedAt ?? null。旧版对端缺这两个键，就会把本地值清成 NULL。 ⇒ 借鉴：解码时用 'key' in obj 判断键是否存在，缺失就保留本地值。加一个「旧版 wire 载荷回放」的单测。（核验：读者把问题定位在 wire.ts 的 x ?? null，不准确：wire.ts 里只有 reasoningContent 用了这个写法，而且消息层遇到相同 id 保留本地、不受影响。真正的覆盖点在 chat-store.ts:426-428 的会话元数据 UPDATE。）
- R4 [confirmed|platform|新:yes|DM:missing] 诊断：同步落盘的工具执行面包屑、崩溃循环绕过、shell 死因捕获、环境横幅与可信的内存读数：iOS CrashReporter（+431/−11 行）：
- DEBUG 下用 O_WRONLY|O_APPEND|O_SYNC 写 [ToolExec] 的 STARTING/FINISHED，开关持久化。
- 60 秒内连续两次前台崩溃，就跳过恢复上次会话，判定是自评估的。
- 注入 dylib 只做检测。

Android：
- PersistentShell 保留输出的开头 1KB 和滚动的末尾 2KB，并记录 spawn 上下文。
- EnvironmentBanner 每个日志会话打一行环境信息。
- MemorySnapshot 改读 /proc/self/status 的 VmRSS，因为 vivo ROM 上 nativeHeap 报出 9.7GB，带偏了一整轮排查。

DeskMinis：
- minisd 日志只转发到主进程 stderr，没有日志文件。
- 只在启动阶段监听 exit，没有 child-process-gone / render-process-gone。
- shell 意外退出固定写 exitCode 129。 ⇒ 借鉴：都可以零依赖实现：
- %LOCALAPPDATA% 下按天滚动的日志文件。
- minisd 启动时写一行环境横幅（版本、内存、fs.statfsSync 取剩余空间）。
- shell_execute 开始前用 'as' 标志（O_SYNC）写一行面包屑。
- 主进程监听 child-process-gone，minisd 挂了退避重启。
- shell 死亡时带上退出码和输出尾部。（核验：合并了同步视角的「崩溃诊断」和工具视角的「执行面包屑 + shell 死因」。CrashReporter 实际是 +431/−11，读者写的 +442 略有出入。）
- R4 [confirmed|ux-flow|新:no|DM:missing] 后台完成通知、会话行运行/未读/中断徽标、锁屏实时活动：完成通知的正文取最后一段纯文本，剥掉 Markdown、截到 200 字，并过滤内部指令文本。会话行按优先级显示徽标：运行中 SpinningRing、paused、unread。Live Activity 支持隐私模式。

DeskMinis 主进程只有 Tray：没有 Notification、setProgressBar、powerSaveBlocker。会话行的运行态徽标在换壳时丢失（交接文档「收窄」一节）。 ⇒ 借鉴：全部用 Electron 内置能力：窗口未聚焦时发 Notification，setProgressBar、flashFrame、setOverlayIcon，定时任务和长回合期间开 powerSaveBlocker。NavRail 加运行、未读、待批准三种点。AppUserModelId 要在真机上验证。（核验：已核实。）
- R4 [confirmed|ux-flow|新:no|DM:missing] 统一的应用内链接路由：设置子页、终端预填、文件预览：handleMinisURLTap 负责分发：
- http(s) 在应用内打开。
- minis://settings/<页> 经 DeepLinkCoordinator 跳转。
- minis://open_terminal?init_command= 打开终端并预填命令。
- 文件路径按扩展名预览。

DeskMinis：MarkdownInline 对所有链接一律 target=_blank；isSafeHref 只允许 http、https、mailto。 ⇒ 借鉴：isSafeHref 放行 deskminis: 协议，在渲染层路由到 settings、PreviewPane、TerminalPane（终端只预填、不执行）。权限拒绝的结果里附上设置链接。（核验：已核实。）
- R4 [corrected|ux-flow|新:yes|DM:missing] 会话分组 + 标题生成时顺带自动归组 + 手动「AI 建议」：v1.12 新增 folders 表（id / name / icon / color / origin / sort_index / pinned_at / description），名字不设唯一约束。

自动归组合并在标题生成那一次调用里完成：
- 只归入已经存在的组。
- 只对还没归组的会话生效（setFolderIfUnfiled）。

手动「AI 建议」的结果只作为预填，永不自动执行。

默认值：v1.13 起两端都默认开启。iOS 在 MinisApp.swift:142 注册了 autoGroupingEnabled 默认 true，注释说明推翻了原先的 opt-in 决定；Android 默认 true。 ⇒ 借鉴：追加迁移：folders 表 + sessions.folder_id。auto-title 输出扩成 {title, folder}，写入用 setFolderIfUnfiled 语义。DeskMinis 可以自行决定默认关闭，但不要以「OpenMinis 两端不一致」为理由。（核验：读者说「iOS 默认关闭、Android 默认开启，两端不一致」，这是错的：iOS 在 v1.13（ada340b）注册了默认 true，Android 注释也写明两端都默认开启。界面视角「反面 3」随之不成立。）
- R4 [confirmed|ui|新:yes|DM:missing] 长粘贴折叠成 [Pasted#N] 占位芯片，超过阈值转成 .txt 附件：Android v1.13 新增。触发阈值：英文为主时超过 1000 词，否则超过 1200 字；ASCII 字母占比过半算英文为主。
- 粘贴内容替换成 [Pasted#N] 标记，原文存在内存缓冲里。
- 发送时单次扫描展开，被展开的内容不再参与扫描，未知 id 原样保留。
- 超过 15000 字直接转成 .txt 附件。

DeskMinis 的 Composer.onPaste 只处理图片。 ⇒ 借鉴：写 lib/composer/paste-fold.ts 纯函数，红测重点测「粘贴内容里本身含标记」的情况。超过 15K 走 saveAttachment。如果以后持久化草稿，缓冲要一起持久化。（核验：已核实。）
- R4 [confirmed|ux-flow|新:no|DM:partial（只搜标题）] 会话全文搜索：LIKE 扫描消息 JSON 并返回命中片段，不建索引：searchSessions 用标题 LIKE 或 parts_json LIKE 查询，再取片段；searchMessages 支持关键词 AND 和日期区间。这两个在基线已有。

DeskMinis 的 StageSearch 只搜标题，界面上也如实写了这一点。 ⇒ 借鉴：加 chat.sessions.search RPC，用 LIKE 加片段截取，限定在 user/assistant 的文本部分。说明第一版不需要先建索引，可以把这项从三档降级。（核验：已核实。）
- R4 [confirmed|tools|新:yes|DM:missing] file_read 给出真实行区间和 next_offset；file_write 支持 append 并提示分块：截断时回退到最后一个完整行，头部给出 next_offset=N（Android 在 b4d7ff5，iOS 在 v1.13）。file_write 描述明确写：约 8KB 以上分块 append，或用脚本生成。

DeskMinis 的 file_read 只有 path 参数，超过 1MB 直接拒绝；file_write 只能覆盖。 ⇒ 借鉴：file_read 加 offset、lines、max_length、direction 四个参数；file_write 加 append，权限卡的 diff 只显示追加段。纯 TS。（核验：已核实。）
- R4 [confirmed|extensibility|新:yes|DM:partial] 技能注册表自愈：重新解析空描述，清除孤儿行，坏行不影响其它行：iOS GH#215：descStale 包含 isEmpty，而且只允许非空的新值替换空的旧值。

Android：
- 加载时对非内置技能检查 SKILL.md 是否存在，缺失就删行。
- 名字也参与自愈。
- 逐行 runCatching，单行坏数据不拖垮启动。

DeskMinis 的 adoptOrphans 只在 minisd 启动时跑一次，而且只收录未知目录。 ⇒ 借鉴：每轮构建技能索引前做一次低成本对账：比较 mtime 决定是否重新解析，只用非空值覆盖空值，目录不存在就删行并级联，每项单独 try/catch。（核验：已核实。）
- R4 [confirmed|tools|新:yes|DM:missing] 原生卸载的取消转发：guest 被杀时，宿主处理器也停下：新增 native_offload_set_abort_handler。ffmpeg 本身无法中断，就设中毒标记 g_ffmpeg_poisoned，之后的调用快速失败。另有只在 DEBUG 下注册的 minis-hangtest 用来验证这条路径，以及有界等待 noff_dispatch_main_sync_timeout。

DeskMinis 的 BridgeServer.onConnection 在 socket 关闭时不中止 dispatch；speak 的超时是 120s。 ⇒ 借鉴：改成 dispatch(req, signal)，用 socket close 触发 AbortController。PermissionGateway 在取消时撤掉挂起的卡片，runPs 在 abort 时用 taskkill /T。另加一个测试用的 hangtest 处理器供 e2e。（核验：已核实（宿主侧）。内核侧的 iSH 子模块没有检出。）
- R4 [confirmed|safety|新:n/a|DM:missing] 宿主桥缺少对端认证：会话 id 来自可伪造的环境变量：OpenMinis Android 的抽象 socket native-offload 不校验对端，会话 id 来自 MINIS_CHAT_SESSION_ID。DeskMinis 同构：
- 管道名由数据根路径的 sha256 前 8 位推出。
- bridge-cli.mjs 从 process.env.MINIS_CHAT_SESSION_ID 取 sessionId，服务端只校验 UUID 格式，没有 token。

结果是同一用户下的其他进程可以冒用任意会话 id。如果该会话已经是「本会话允许」，或者全局完全访问，就能静默读剪贴板、截屏。 ⇒ 借鉴：为每个会话生成随机 token，注入 shell 的 env，桥请求带上，在分发点校验，零依赖。先写红测：没有 token 或 token 错误时返回 UNAUTHORIZED。（核验：这条出自工具读者「反面 11」的叙述，不在读者的 JSON 发现里。已 grep 核实 DeskMinis 这一侧；OpenMinis Android 那一侧没有逐行核对。）
- R4 [confirmed|safety|新:no|DM:missing] 用户环境变量/密钥注入 shell，并在输出里脱敏：基线已有：EnvVarStore 存在 Keychain；EnvVarRedactor 在 Privacy Mode 下做纯字符串替换（长度≥5、从长到短），命中后附提醒；minis-config 可以管理这些变量。

DeskMinis 没有用户级的环境变量或密钥存储。 ⇒ 借鉴：主进程用 safeStorage（DPAPI）存储，沿 makeBridgeEnv 同一路径注入；变量改了要重建 shell。输出在落库前脱敏，密文不进设备同步。（核验：已核实。）
- R4 [confirmed|agent-loop|新:no|DM:missing] 工具调用死循环检测：四种策略，分级拦截：ToolLoopDetector 的默认阈值：historySize 30、警告 10、严重 20、未知工具 10、全局熔断 30；判为严重时直接不执行。基线已有，readers-3 当时也记录过。

DeskMinis 只有 maxTurns=200 的上限。 ⇒ 借鉴：写纯 TS 的 tool-loop-detector.ts（参数排序后算 sha1），在执行前 check。定时任务无人值守，最该先做。（核验：已核实。这是基线早已指出、DeskMinis 仍未做的项。）
- R3 [confirmed|context|新:yes|DM:partial] 压缩切点不能落在携带 tool_result 的 user 消息上；DeskMinis 的摘要请求没有经过配对：OpenMinis 的现场报告：priorIdx 落在一条 tool_result 上，它对应的 tool_use 被切进了摘要，残留的 function_call_output 导致 400「No tool call found」。每次重试切法都一样，会话在所有降级模型上都永久卡死。修法：walkBackUserTurnsBounded 只把不含 toolResult 的 user 消息当作边界。

DeskMinis：
- 正式请求有 pairToolResults 兜底。
- compact.summarize 的请求直接调用 streamAgentMessage，没有经过配对。
- 30 条消息的那条路径锚点取 length−15，可能落在带 tool_use 的 assistant 上，请求末尾就是悬空的 tool_calls。 ⇒ 借鉴：如果采纳「压平成文本」的摘要输入，这个问题和 prefill 问题会一起消失。否则的最小修法：锚点前移到不含 toolUse 的 assistant，并给摘要请求也套一次 pairToolResults。（核验：OpenMinis 的修复属实，是 v1.12/1.13 新增。DeskMinis 的风险是按代码推断的，没有复现过。）
- R3 [confirmed|providers|新:yes|DM:partial] models.dev 查找：id 归一化 + 本 provider 权威优先 + 跨 provider 多数票：OpenMinis 的查找逻辑：
- normalizedModelKey：取最后一段路径、转小写、把 . 和 _ 统一成 -。
- 先查本 provider 的条目（权威）。
- 再查全目录索引，取声明最多的 effort 集合（例如 glm-5.2 是 23:4），索引会缓存。
- authoritative 标记决定这个声明能否压制用户的关闭。

DeskMinis：
- 已有「≥2 家佐证取最小窗口、thinking 任一为真」的冲突消解，比 OpenMinis 更稳。
- 但 lookup 只做精确匹配和去斜杠尾部匹配，没有大小写和 ./_ 归一化。 ⇒ 借鉴：lookup 增加归一化键，写缓存时同时按归一化键建索引，并把 MERGE_RULE_VERSION 加 1。等加入 effortValues 时，按「本 vendor 权威 / 多数票启发」两类来源分别记录。（核验：已核实。）
- R3 [confirmed|providers|新:yes|DM:missing] 子任务（标题 / AI 分组）走独立的子模型解析链，并过滤非对话模型：v1.13 把自动标题和手动重新生成标题的模型解析统一为 resolveSourceForSubTasks（#112：之前手抄的副本漏掉了可用性规则）。
- 候选链：子模型 → 主模型 → 会话 modelId → 默认组 → 其余可用模型。
- isTitleEligible 排除非文本模型。
- 压缩仍用主模型（resolveCurrentEntry）。

DeskMinis：标题和压缩都直接用当前活动 provider，标题请求的 maxTokens 只有 64。 ⇒ 借鉴：设置里加一个可选的「辅助模型」，autoTitle 优先用它。标题请求在 Claude 5 家族上要注意：缺省 thinking 时会 adaptive 思考（见第 1 条），64 token 可能被吃光。（核验：已核实。）
- R3 [confirmed|providers|新:no（Android 移植为 v1.12）|DM:missing] content 里的 <think> 前缀用流式状态机拆分，并兼容多种 reasoning 字段拼写：ThinkPrefixStreamParser 是一个 UNDECIDED→THINKING→BODY 状态机：
- 只认回合开头的 <think>，容忍前导空白。
- 标签被切在两个 chunk 之间时先缓存。
- 正文里提到的 <think> 原样保留。

流里同时读 reasoning_content、reasoning 以及模型声明的 interleaved 字段。iOS 在基线已有；Android 在 v1.12 移植并补了测试。

DeskMinis 只读 delta.reasoning_content。Ollama/OpenRouter 常用的 reasoning 字段和 <think> 前缀都会混进正文。 ⇒ 借鉴：在 openai.ts 加一个约 100 行的纯函数状态机，并同时读 delta.reasoning。红测要覆盖：标签跨 chunk、正文里提到 <think>、只有思考的回合。（核验：已核实。）
- R3 [corrected|providers|新:部分|DM:partial] 提示缓存补漏：OpenRouter 的 anthropic/* 显式 cache_control；prompt_cache_key 只发官方 OpenAI：GH#191：OpenRouter 上 host 为 openrouter.ai、模型 id 以 anthropic/ 开头时，要发顶层 cache_control:{type:ephemeral}，否则拿不到缓存。

prompt_cache_key 在基线已用于 Responses。v1.12/1.13 的变化：
- Chat Completions 也发送。
- 用 shouldSendPromptCacheKey 限定为官方 OpenAI（没有自定义 base，也不是 Azure）或强制走 Responses，因为第三方网关会报 400 UNKNOWN_FIELD。
- 键优先取「首条用户消息文本」的哈希；没有文本时才退回「首条消息结构形状」的哈希。

DeskMinis：Anthropic 原生路径已有断点缓存；OpenAI 兼容路径没有缓存提示，也不统计 cache token。 ⇒ 借鉴：usage 事件扩展 cacheRead/cacheWrite 两个字段，先落进 token_usage JSON。OpenRouter 的条件放进端点特性判定。OpenRouter 顶层 cache_control 的语义以其官方文档为准，采纳前用假端点钉住请求体。（核验：读者说「键由首条消息的形状哈希而来」，不准确：主路径是哈希首条用户文本，形状只是回退。prompt_cache_key 本身在基线已有；新增的是扩展到 Chat Completions，以及端点门控。）
- R3 [corrected|multi-agent|新:no（重试为新增）|DM:missing] minis-model-use：agent 通过 CLI 调用其它已配置模型：原生卸载 CLI，支持 list、search、run 三个动作：
- --model 可用 id、显示名或 label/id；--input 传 OpenAI messages；支持 --prompt-file、--system-file、--endpoint、--modality。
- 只暴露 resolvedAgentLoopEntries，用户隐藏的模型不会给出去。

v1.13 对 transientError 加了指数退避：2/4/8/16/32s，最多重试 5 次。 ⇒ 借鉴：做成内置工具 model_use(model, prompt, system?)，复用 provider-store。首次调用走权限确认（有成本），只列用户显式勾选为「可被 agent 调用」的模型。先出设计稿。（核验：退避间隔是 2/4/8/16/32s，读者写的 2/4/8s 不完整。CLI 本体在基线已有，重试为 v1.13 新增。）
- R3 [confirmed|safety|新:no|DM:n/a（刻意不做）] 订阅账号 OAuth 靠冒充官方 CLI 身份：不要吸收：OpenMinis 的 OAuth 线路冒充官方客户端：
- Anthropic：发 User-Agent claude-cli/2.1.195 (external, cli) 和 X-App: cli。
- Codex：发 codex_cli_rs 的 UA 和 Originator，外加 Chatgpt-Account-Id。

可用模型要靠实测白名单维护（T-codex-oauth-model-prune）。本窗口没有新的登录流程。 ⇒ 借鉴：DeskMinis 保持「只用 API key 或本地端点」，这与 README 的出网承诺一致。可以借鉴的只有一点：不可调用的模型在「快速测试」里就暴露出来。（核验：已核实。）
- R3 [confirmed|sync-storage|新:yes|DM:missing] 导出快照截止时刻 snapshotAt + 可续做导出（类别完成标记、staging 放持久目录、续做必须显式发起）：导出流程：
- 固定一个截止时刻 snapshotAt，续做时沿用它。
- 续做兼容性判断很严格。
- 口令不持久化，加密导出续做必须重新输入。

文件 mtime 规则是不对称的：只有 mtime 明显晚于截止时刻才排除。

allowResume 默认 false：点「开始备份」永远是新备份，续做只能在历史记录里显式发起。 ⇒ 借鉴：SQLite 部分在一个读事务里导出，或者先 db.backup()。staging 放 %LOCALAPPDATA%。「开始备份永远是新的」这条产品规则可以原样采用。（核验：已核实。注意流式包的临时路径其实在 temporaryDirectory（BackupExporter.swift:243）。）
- R3 [confirmed|sync-storage|新:yes|DM:missing] 恢复的崩溃安全：逐文件原子替换、按 runId 分开的回滚快照、恢复日志、进程级锁：写文件先写成同目录的 .restore-<uuid>.tmp，再 replaceItemAt，取代原来的先删后拷。

回滚快照放在 Application Support 下的 rollback-<runId>，下次启动时对账。某个类别失败只回滚这个类别。

BackupActivityLock 是进程级单例，因为每个调用点都会 new 一个新 actor，actor 自身的串行化管不住。 ⇒ 借鉴：Windows 上 rename 覆盖遇到文件被占用会 EPERM/EBUSY，需要短退避重试，失败计入报告。恢复期间调用 setSyncPaused。（核验：已核实。）
- R3 [confirmed|sync-storage|新:yes|DM:missing] 云端占位文件和超限文件写墓碑而不是空文件，报告里写明缺了什么：iCloud 占位文件读出来是 0 字节且不报错，旧代码会拿 0 字节覆盖用户的真实文件。

现在的处理：
- 先触发下载；仍未就绪就写 not_downloaded 墓碑。
- 超过上限的写 size 墓碑。
- blob 缺失的计入 missingBlobs。
- 三类在报告里分开计数。 ⇒ 借鉴：Windows 上对应 OneDrive 按需文件：对单个文件设读取超时，失败就写墓碑。原则照抄：读不到绝不能打包成空文件。（核验：已核实。）
- R3 [confirmed|platform|新:yes|DM:missing] 交付目的地 = 系统挂载的文件夹；rclone 只作补充，上传用 .partial、比对大小后改名：主路径：用户在「文件」App 里连好 SMB 或 WebDAV，再授权给 Minis，应用里没有网络代码。

补充路径：内嵌 librclone，只链接 5 个后端（全部 70 个 gz 后 25.6MB，其中约 18MB 是 Go runtime）。上传到 <name>.partial，比对大小后 movefile 改名；清扫按 .partial 后缀匹配。partial 刻意不带点前缀，因为 alist 会在列表里隐藏点文件，清扫就永远找不到它们。

凭证存 Keychain；rclone 的 obscure 可逆，不算保护。 ⇒ 借鉴：Windows 原生支持 UNC、映射盘和网盘同步文件夹，所以不要打包 rclone。上传语义照抄：写 .partial，fsync，读回校验 sha256，再 rename；启动时清扫遗留的 .partial。（核验：已核实。附带发现：RcloneChunkedUpload.swift 的文件头（:34）和 :124-131 注释仍写「dot-prefixed」，与 :106 的实现矛盾，属于注释漂移。）
- R3 [confirmed|safety|新:yes|DM:missing] 备份产物与 agent 可见的工作区、被备份的类别目录物理隔离：早期版本把包放在 shared/Backups/，有三处错误：
- shared/ 被 bind-mount 进沙箱，agent 用一条 shell 命令就能读到或删掉含凭证的包。
- shared/ 本身就是一个备份类别，下一次备份会把上一个包打进去，包套包。
- 语义上也不该复用「agent 共享工作区」这个概念。

现在改为与 shared/ 平级的 Backups/，导出时再按 isBackupArtifact 兜底排除。 ⇒ 借鉴：默认输出目录放 %LOCALAPPDATA%，绝不能落在会话 workspace 或绑定的项目目录里。导出时排除 *.deskbak，并把备份目录列为敏感路径。（核验：已核实。）
- R3 [confirmed|ux-flow|新:yes|DM:partial（定时任务有结果回看，没有通用任务历史）] 长任务运行历史：按时间保留 30 天、逐目的地结果、瞬态行就地替换、ETA 估不出就留空：BackupHistory 按 30 天清理，不按条数。
- isTransient 的进度行就地替换，不追加。
- isProblem 行高亮。
- 跳过文件最多保留 500 条，但计数始终精确。
- ETA 估不出来就显示空，不编数字。

BackupRunController 只持有一个任务句柄。备份与恢复界面用 ZStack 加 opacity 让两个标签页常驻，切换不丢状态。 ⇒ 借鉴：job_runs 表加 job_log（只追加迁移），备份、导入、市场安装、首次全量同步共用。transient 行用 UPSERT 覆盖，通过 JSON-RPC 广播推给渲染端。（核验：合并了界面视角的「备份与恢复界面」。）
- R3 [confirmed|sync-storage|新:yes|DM:n/a（目前只有全局暂停）] 同步分类开关漏登记 V3 类型，开关形同虚设；未归类类型改为告警放行：三个 V3 provider 类型已经接进 zone 映射、白名单和拉取列表，却没有登记到 UploadPolicy 的类别里；加上 allowsRecordType 对未知类型返回 true，用户关掉「同步 Providers」后照样上传（#98）。

修复：补登记这几个类型；未归类类型仍然放行，但打 warning。 ⇒ 借鉴：DeskMinis 以后做分类同步时，用 satisfies Record<SyncKind, Category> 做编译期穷举，再加一个单测断言每种 kind 都有归属。（核验：已核实。）
- R3 [confirmed|ux-flow|新:yes|DM:partial] 迁移与同步进度的可解释性：挂起显式化、非破坏性重置、保留游标、进度钳制、节流算延期：MigrationEngine（+185/−15 行）的改动：
- 增加 isSuspended 状态。
- 取消不重置游标，避免重新标脏引发风暴。
- resetMigrationProgress 只清本地账本，不动服务器数据。
- 进度分母做钳制（#154 的截图是「41 / 14 (100%)」）。
- 零会话捷径先核对消息数。
- 节流算延期，不累计失败。 ⇒ 借鉴：首次配对的全量拉取也要有「挂起 / 等待对端」状态、钳制后的进度和可取消的断点。清账本这类操作要与破坏性操作在界面上分开。（核验：已核实。）
- R3 [confirmed|ui|新:yes|DM:missing] 读屏播报回合结束；占位提示在读屏开启时不轮换：ChatAccessibilityAnnouncer（102 行，新增）在回合结束时，按结果播报「完成 / 已停止 / 失败」。Android 的占位提示在 TalkBack 开启时固定不变。

DeskMinis 的 ui/ 里没有 aria-live，也没有 role=status。 ⇒ 借鉴：放一个视觉隐藏的 aria-live=polite 区域，写入三种结果文案；权限卡出现时用 assertive 播报。加一条源码守卫。（核验：已核实。）
- R3 [confirmed|ux-flow|新:no（Android VAD 为新增）|DM:missing] 语音输入：VAD 分段、OpenAI 兼容转写、LLM 纠错：iOS 有内联语音面板、12 家厂商的 VoiceProvider、VoiceCorrectionEngine。纠错需要加载约 5MB 的 jieba 词典，冷启动实测 1934ms，而检索预算是 80ms、端到端 800ms。Android 的 VAD 是 v1.13 新增。 ⇒ 借鉴：零依赖路线：getUserMedia + MediaRecorder 录音，AnalyserNode 做简易 VAD，minisd 转发到用户已配置的 /v1/audio/transcriptions。不照搬 jieba 纠错。（核验：已核实。）
- R3 [corrected|ux-flow|新:no（Android ToolSpeech 为新增）|DM:partial（有 agent 侧的 windows-speak 桥，没有界面朗读）] 回复朗读：流式分句、有序预取、粘性故障转移、朗读清洗、工具播报：朗读流程：
- extractSentencesStatic 按句切分，软上限 60 字。
- VoiceOutputPlayer 有序预取，并有 stickyCandidateKey 粘性故障转移。
- VoiceTextSanitizer 做朗读清洗。
- ToolSpeech 在 v1.13 以纯函数移植到 Android。 ⇒ 借鉴：用 speechSynthesis 做界面朗读，分句函数移植成 lib/speech/segment.ts 纯函数。agent 侧已经有 windows-speak，可以复用同一套清洗规则。（核验：补充 DeskMinis 现状：已有 windows-speak 桥，agent 可以调用系统 TTS，所以不是「完全没有语音」。界面上的逐条朗读确实没有。）
- R3 [confirmed|platform|新:no|DM:partial] 快捷指令与自动化入口：iOS 的 App Intents 有 SendPrompt、GetSessionStatus、ListSessions、FollowUpSession、RetryRun、QuickTask、OpenSession 等，ShortcutRunTracker 负责挂起记录。

DeskMinis 的 remote-cli 只有 pair、connect、status、unpair 四个命令，没有发送提示。 ⇒ 借鉴：加 CLI 子命令 prompt、status、list，再用 app.setUserTasks 做任务栏跳转列表、setAsDefaultProtocolClient 注册 deskminis:// 协议。（核验：已核实。）
- R3 [confirmed|ui|新:no|DM:partial] 工具实况查看器：ANSI 清洗、单行长度上限、分块懒加载：sanitizeForDisplay 去掉 CSI/OSC 转义，单行超过 2000 字强制折行，输出按 40 行一块懒加载。

DeskMinis 的 StepGroup 直接 slice(0, 2000) 放进 <pre>，minisd 和渲染层都没有 ANSI 剥离。 ⇒ 借鉴：写 lib/tool/sanitize.ts 纯函数，先写红测；截断改成可以逐块展开。（核验：已核实。）
- R3 [corrected|ui|新:部分|DM:partial] 思考块：限高跟随、字数显示、尾部窗口、结束时收起：iOS 思考块的 maxHeight 300、字数和尾窗提示在基线已有。v1.12 修复「程序滚动误解除跟随」，v1.13 修复自动收起时漏发布局失效通知。Android 有自动展开开关。

DeskMinis 的 ThinkBlock 流式时展开，.tbody 不限高。 ⇒ 借鉴：.tbody 设 max-height 和 overflow:auto，区分用户滚动与程序滚动，流结束时收起。（核验：读者标 new_since=yes 不准确：限高 300 在基线已有（git show 9cf3a85 可见），新增的只是跟随修复和收起时的失效通知修复。）
- R3 [confirmed|ux-flow|新:yes|DM:missing] 记录里的记忆写入可一键撤销：MemoryWriteRevoker（94 行，新增）供工具胶囊和记忆面板共用。只在今天和昨天的日志里查找正文完全相同的条目，连同 <!-- 时间戳 --> 标记一起删除。基线时撤销只存在于记忆详情页。 ⇒ 借鉴：在 StepGroup 的 memory_write 步骤加「撤销这条记忆」，调用 memory.revokeEntry，匹配范围同样限定两天。（核验：已核实。）
- R3 [confirmed|ux-flow|新:yes|DM:partial] 压缩进行中的秒表与取消：Android v1.13 新增 CompactProgressIndicator：显示已用时间、当前分段，可以取消。

DeskMinis 只在压缩完成后显示「上下文已压缩」。 ⇒ 借鉴：minisd 在压缩开始时发 compacting 事件，界面显示用时和取消按钮。（核验：已核实。）
- R3 [confirmed|ui|新:yes|DM:partial] 输入框拖拽调高、聊天区与输入框字号分别缩放：iPad 输入框的 pinnedHeight（T-ipad-composer-resize 共 7 处）。Android 字号分三组，每组 6 档，倍率 0.88–1.21。 ⇒ 借鉴：Composer 加拖拽柄，外观页加两个字号滑杆（CSS 变量乘数），注意主题守卫。（核验：已核实。）
- R3 [corrected|ux-flow|新:no|DM:partial] 会话菜单：置顶、导出并预览、复制副本、多选：SessionContextMenu 支持置顶、导出（JSON 或纯文本，带预览）、复制副本、移动到组、Report Content 等。SessionForkManager 深拷贝消息并重新映射 compact marker。这些在基线已有。

Report Content 是用户主动点击后，经 mailto 唤起邮件客户端，需要用户手动发送，不是默认外发。 ⇒ 借鉴：先做导出（dialog.showSaveDialog）和复制副本（在一个事务里重映射 compact_markers）。置顶只需要补界面和 RPC，不需要迁移。（核验：读者说「置顶需要追加迁移给 sessions 加 pinned_at 列」，这是错的：MIGRATIONS[0] 已经有 pinned_at，同步 wire 也在携带 pinnedAt。另外，界面视角把 Report Content 称为「默认外发」属于夸大。）
- R3 [confirmed|ui|新:yes|DM:partial] 可拖拽分栏与全局快捷键：ChatSplitScaffold 的数值：默认占窗口 28%，宽度限制在 340–500dp，分隔线热区是 48dp 的覆盖层；另有 Ctrl+N、Ctrl+F。 ⇒ 借鉴：交接文档记录「拖拽分栏」和「Ctrl+,」在换壳时丢失。可以照搬比例和上下限，在 AppShell 统一注册快捷键，并纳入 a11y 守卫。（核验：已核实。）
- R3 [corrected|providers|新:yes|DM:partial] 子模型身份污染：调用环境不等于模型身份：v1.12（#103）：minis-model-use 的默认系统提示原来是「You are Minis, an on-device AI assistant」，三家供应商的子模型都自称 Minis 并编造厂商。现在改为描述调用环境，并明说「这不是你的身份，保持你自己的模型身份」。同时修了超时被当成成功的问题。

但 OpenMinis 主 agent 的系统提示仍然是 SoulStore 的「You are {name}, a capable AI assistant…」人格句。 ⇒ 借鉴：DeskMinis 有降级改绑，用户需要能问「你是什么模型」来确认。可以把稳定段改成「你运行在 DeskMinis 中（这是运行环境，不是你的模型身份）」。这会影响 stableCache 的缓存键，需要与 prompt-cache 一起回归。（核验：读者把 DeskMinis 的 STABLE_IDENTITY 等同于 OpenMinis 已经修掉的写法，范围不对：OpenMinis 只修了子模型调用；主 agent 仍然断言人格身份（可由 SOUL.md 配置）。这条建议成立，但它是 DeskMinis 自己的取舍，不是「照 OpenMinis 已证明的修法」。）
- R3 [confirmed|tools|新:yes|DM:partial] 面向 LLM 的 CLI：失败不能伪装成成功，拿不到的测量值不能用 0 冒充：三个修复：
- HealthKit（GH#128）：锁屏时读取失败被吞成 ok:true + 0 行。
- 可用空间（#102）：失败时回退到保守值，不报 0。
- model-use：超时落进了成功分支。

日历重复规则方面：非法值拒绝整条命令，写入后回显实际存下的规则。 ⇒ 借鉴：给 windows-* 写逐处理器的契约测试：超时返回 TIMEOUT，clipboard 区分「空」与「失败」，测量类失败绝不回退成 0。（核验：抽查属实。）
- R3 [confirmed|safety|新:yes|DM:has] 权限判定必须和分发用同一套规则（GH#242：绝对路径绕过卸载权限）：OffloadPermissionManager 原来用首个 token 原样匹配命令名，而内核按 basename 分发，所以写绝对路径就能绕过权限。现在改为按 basename 匹配。注释承认 sh -c 之类的间接调用仍可绕过，根治要把检查挪到分发点。

DeskMinis 的桥在分发点调用 permissions.check；shell 免批用白名单，没匹配上就回落到询问。 ⇒ 借鉴：给 permissions.ts 补一组同义拼写的红测：绝对路径的 git.exe、.\git、cmd /c、pwsh -c、Invoke-Expression 都不能误进免批。（核验：已核实。）
- R3 [confirmed|platform|新:yes|DM:partial] 构建产物完整性校验：「沙箱能启动」不等于「能执行命令」：build_proot.sh 新增 verify_artifacts：检查 vendored Termux loader 的 sha256、大小下限和 ELF 架构。build_ish.sh 在 release 构建显式设 b_ndebug，因为 meson 的 release 并不隐含 NDEBUG。 ⇒ 借鉴：npm run dist 之后跑一个零依赖的校验脚本：确认 bridge-cli.mjs 和 bridge-node.cmd 存在，并用打包后的 exe 真正调一次 windows-device info。接进 RELEASE.md 的验收步骤。（核验：已核实。）
- R3 [confirmed|extensibility|新:no|DM:missing] minis-config：agent 可写的设置注册表：基线已有：ConfigRisk 三级风险、ConfigConfirmationGate（120s）、ConfigAuditLog。v1.12 新增 thinkingrules 集合和 config.* 调试 RPC，调试 RPC 与 CLI 共用 ConfigOffloadBridge 入口。 ⇒ 借鉴：如果要做，给桥加一个 config 工具，路由到现有的 minisd RPC；写入走 PermCard 加 diff 预览，审计表只追加迁移。（核验：抽查属实。）
- R3 [confirmed|dx-testing|新:yes|DM:missing] 调试 RPC 自描述（rpc.discover），以及手写规格与实现的漂移：每个方法都登记为 MethodSpec，rpc.discover 返回全部方法。按 name 字面量粗略统计，方法数从基线约 105 个增到约 142 个，而 docs/specs 的最后一次改动停在 v1.10（3bfca34）。Android 修了 body 按字节读取的问题。 ⇒ 借鉴：minisd 注册表附上轻量 spec，暴露 rpc.discover，加守卫要求每个方法都有 spec。（核验：方法数以粗略 grep 为准（105→142），读者写的 107→144 在误差范围内。）
- R3 [confirmed|ux-flow|新:no|DM:partial] minis:// 会话内资源 URL：工具产物既能被引用，也能内联显示：规格 minis-url-scheme.md 自 v1.10 以来没有变化：定义了四个 namespace，Markdown 内联渲染，read_image 的 path 接受 minis://。Android GH#139 把照片导出到会话的 offloads 目录。

DeskMinis 源码里 grep minis:// 零命中。 ⇒ 借鉴：用 protocol.handle 注册协议，先规范化路径并做围栏检查；MarkdownView 放行该协议。要与 CSP 和 v-html 守卫一起评审。（核验：抽查属实。）
- R3 [confirmed|platform|新:yes|DM:partial] 同步文件系统调用碰到网络盘或云盘，会卡死主线程或事件循环：iOS v1.12：主线程上刷新挂载目录的符号链接，遇到不可达的 SMB 或 FileProvider 卷会触发看门狗 0x8BADF00D。修法是主线程只做快照，文件系统操作移到 detached task，比较时用 readlink。

DeskMinis 的 minisd 是单事件循环，文件工具用 statSync、readFileSync。 ⇒ 借鉴：先在文件树和 @ 索引这两个高频路径上改用 fs.promises，加超时，并对 UNC 绑定目录给出提示。（核验：已核实。）
- R3 [confirmed|safety|新:yes|DM:missing] 窄口径的自愈重试：只在「这次运行不可能产生过任何效果」时自动重跑：SeccompFallbackPolicy 的触发条件（四个同时满足）：
- 退出码是 132、135、139 或 159。
- 存活不到 1.5 秒。
- 没有任何输出。
- 这条命令还没有重试过。

满足时加 PROOT_NO_SECCOMP=1 重试一次，证实需要后在该 shell 的整个生命周期内保持。 ⇒ 借鉴：写一个纯函数 shouldRetryStartup，只对 PowerShell 驱动一启动就死、没有输出的情况降级重试；用户命令绝不自动重跑。（核验：已核实。）
- R3 [confirmed|sync-storage|新:yes|DM:missing] 交接用临时文件和会话目录的回收：Android 卸载回复的临时文件以前从来没人删。现在服务启动时全量清扫，运行中按 10 分钟 TTL 抽样清扫。

DeskMinis 的 deleteSession 只删数据库行，chat.sessions.delete 只释放终端，sessions/<id>/ 下的文件留着。 ⇒ 借鉴：删会话后异步删除会话桶：绝不删绑定的项目目录，不跟随 junction；启动时清扫孤儿桶。要先出设计稿，因为和同步删除语义有交互。（核验：已核实。）
- R2 [confirmed|agent-loop|新:yes|DM:has] 流停滞改抛可重试错误，并记录停滞诊断：iOS 看门狗原来抛一个私有错误，agent 循环认不出，停滞后任务直接结束。现在改抛 LLMError.transientError，走正常的重试和降级流程，并加了 [StreamDiag] 诊断记录。另外每个 SSE 流用独立的 URLSession。

DeskMinis 的 sse.ts 早就会先 cancel 再抛 retryable ProviderError。 ⇒ 借鉴：只需借鉴诊断部分：停滞时记录距上个事件的时间、事件数、模型和 host。（核验：已核实。）
- R2 [confirmed|ux-flow|新:yes|DM:missing] 模型列表按发布日期排序（只排序，不据此推断可调用）：ModelReleaseIndex 的排序键依次为：日期、输出单价、上下文窗口、名称。没有日期的模型沉底，但不隐藏。注释明确写着「Never infer callable from a release date」。动机是 #83。 ⇒ 借鉴：缓存里多存 release_date（MERGE_RULE_VERSION 加 1），和「模型选择器搜索」放在一起做。（核验：已核实。）
- R2 [confirmed|architecture|新:yes|DM:has] 反例：用进程全局的补丁标志传递单次请求的思考意图，导致跨请求串扰：SwiftAnthropic SDK 不支持相关参数，所以 Anthropic 的思考参数靠 RequestBodyPatcher 在 URLProtocol 层改写请求体，意图通过进程全局的静态变量传递。v1.13 发现中间插进来的请求（例如标题生成）会抢走本不属于它的 disabled 意图。修补办法是给意图打上 modelId 戳，不匹配就丢弃；但没有戳的旧调用仍然照用。

DeskMinis 按请求用纯函数组装请求体，天然不会有这个问题。 ⇒ 借鉴：守住现状，可以加一条源码守卫：禁止 providers/*.ts 出现模块级 let。（核验：已核实，其中 disabledForModel.isEmpty 分支仍然放行。）
- R2 [confirmed|sync-storage|新:yes|DM:missing] rescue.json + manifest 副本：损坏包抢救用的最小明文索引：rescue.json 始终是明文，只记录 blob 归属和会话 id、标题、消息数，不含消息内容和凭证。manifest 在包尾再写一份副本。调试 RPC 提供 forwardScan。 ⇒ 借鉴：成本低。会话标题默认不写，因为可能含项目名或客户名。（核验：抽查属实。）
- R2 [confirmed|sync-storage|新:yes|DM:missing] 磁盘空间预检：导出侧没有实现；导入侧放在解包之后；inspect 要整包解压：BackupExporter 里 grep 不到任何可用空间检查。导入侧的 preflight（BackupImporter.swift:206/418-431）在 unpack（:136）、完整性校验（:154）和解密之后才执行。inspect()（:274-278）为了读 manifest 也会把整包解压一遍，尽管 BackupPackageReader 已经能按中央目录单独读一个条目。 ⇒ 借鉴：最先用 fs.statfsSync 检查 staging 盘和目的地盘；预览 manifest 走中央目录读取。（核验：已核实。）
- R2 [corrected|dx-testing|新:yes|DM:n/a] 设计文档跑在代码前面：resumingAt 没有调用方，加密与续做仍走旧 staging 路径：BackupZipWriter 提供了 init(url:resumingAt:existingNames:)，但唯一调用点只传了 url；注释引用的 resumeState 不存在。streaming 只在「不加密且不是续做」时启用，所以带凭证、必须加密的包仍然占用约 3 倍空间。

中文设计文档 docs/backup-restore-design.md 和 group-feature-design.md 已从 HEAD 删除（2a79655），但仍可从 2c6ca20 的历史里取回。 ⇒ 借鉴：借鉴 OpenMinis 前，先用 grep 找到调用点确认已实现。DeskMinis 如果做加密备份，第一版就把加密放进逐条目的管线。（核验：读者说代码注释里的 §编号「在开源仓库里无从查证」，这不对：两份文档都能用 git show 2c6ca20:docs/backup-restore-design.md 取回，属于后续可读材料。）
- R2 [confirmed|dx-testing|新:yes|DM:n/a] 跨平台格式漂移：Android 禁止 zip64，iOS 写端已主动输出 zip64：Android BackupZip 的注释以「iOS 读端从 16 位 EOCD 取条目数」为由，禁止单个成员或总大小超过 4GB、条目数超过 65535。但 iOS 读端已经支持 zip64，写端也在输出 zip64。两端注释各自描述的是对方的旧状态。 ⇒ 借鉴：读写两端用同一份实现，并用往返测试钉住。（核验：已核实。）
- R2 [confirmed|ux-flow|新:yes|DM:missing] 本地包清理规则：至少有一个目的地且全部成功，才删除本地副本：判断条件是 destinations.isNotEmpty() && all { succeeded }，因为错误代价不对称。 ⇒ 借鉴：写成纯谓词函数，生产代码和测试调用同一个函数。（核验：属实。反面细节：测试里复制了一份谓词，而不是调用生产代码（注释承认 drift 风险）；这里的「校验」实际指目的地报告 succeeded，不是回读比对。）
- R2 [confirmed|ui|新:yes|DM:missing] 输入框占位提示轮换：由聚焦触发；空会话保留默认文案；读屏开启时固定不变。实现是纯函数。 ⇒ 借鉴：写 lib/composer/placeholder.ts，准备 5–6 条中文提示。（核验：抽查属实。）
- R2 [confirmed|dx-testing|新:yes|DM:missing] 应用内语言切换与本地化工具链：方法交换 Bundle 影响不到 String(localized:)，作者实测三种拦截手段都失败。scripts 下新增三个 locale 脚本，Android 新增 9 种语言。 ⇒ 借鉴：暂不投入。将来做国际化时只走一个 t() 入口。（核验：抽查属实。）
- R2 [confirmed|platform|新:yes|DM:n/a] iSH 后台 CPU 闭环调控器与 fork 内存背压：设计文档实测 iOS 后台预算：60 秒内最多 48 CPU 秒。调控器天花板设在 38 CPU 秒（约 63%）。§7 附录说明原来的 tick hook 在热循环里根本不触发，是死代码。另有 fork 守卫。 ⇒ 借鉴：不需要移植。方法论值得记：度量操作系统实际计费的量，并在真机上验证执行器确实生效。（核验：文档属实。内核子模块没有检出，无法核对实现。）

未覆盖：
- 用户要求同时参考的 deepseek harness、zcode、pi 三个项目，不在本次 OpenMinis 核验范围内，需要另派读者或核验者
- iSH 子模块 deps/ish 在本地没有检出（v1.13 起跟踪 master，7414c0d），内核侧的 native_offload abort、fork guard、governor 钩子都没法核对
- 可从历史取回、但没人读过的中文设计文档：git show 2c6ca20:docs/backup-restore-design.md、git show 2c6ca20:docs/group-feature-design.md（backup 代码注释里的 § 编号指向这里，分组功能的完整设计也在其中）
- MCP 方面的变化没有任何视角覆盖：minis-mcp-cli 的 http transport 重新初始化（daemon.py、transport/http.py，新增 test_http_reinit.py 共 281 行）
- BrowserUse：iOS +302 行，Android BrowserUseManager.kt +158 行；Android KaTeX/Markdown 解析改动（KaTeXView、MarkdownParser 加两份测试），以及 50a03d0 里 MinisTextKit、主题相关改动，都只读了一部分
- 同步侧只抽查到文件级：ICloudSharedZoneTransport 的「两次全量拉取条数一致才下锚」、CKRecord 名按 UTF-8 字节计长、CloudSyncEngine.mergeProviderConfigForRestore，都没有逐行核对
- iOS ContextPolicy 的绝对余量阈值、Gemini provider（+62/−85）、Qwen DashScope 与中转站的形状、xAI 目录声明的具体规则，没有逐行核对
- Background/BackgroundKeepAliveManager.swift（+211）和语音 12 家厂商的实现细节没有读
- DeskMinis 侧有两处需要真机或假端点验证：①摘要请求以 assistant 结尾时，Claude 4.6+ 是否 400（推断依据是 tests/compact.test.ts:92 加官方的 prefill 规则）；②README 写「Anthropic 原生思考可见」，但档位恒为 off，这个说法是否属实