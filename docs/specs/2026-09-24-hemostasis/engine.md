# agent 引擎与 provider（W2a：compact / overflow / claudebinding / deepseek / honest）

## facts
- 路径约定：下文相对路径以 /home/user/Deskminis/deskminis 为根；THIRD-PARTY-NOTICES.md 在 git 根 /home/user/Deskminis/THIRD-PARTY-NOTICES.md（现有 4 节：Appica、OpenMinis、运行时依赖、字体，没有 pi-mono 节）
- 基线：compact/provider-errors/anthropic/openai/offload/prune/auto-title 七个测试文件 62 例全绿；agent-loop 里压缩、降级、修剪相关用例和 modelgroup-fallback-rebind 两例全绿。其中压缩与修剪大串用例各跑 15.8s/22.4s（CPU 密集，已放宽到 120s 超时）
- src/minisd/agent/compact.ts:48：summarize(history, sessionId, provider) 不收窗口、输出上限和取消信号
- compact.ts:58-70 的锚点规则：最近 3 个真用户回合；不足时若 ≥30 条则保留最近 14 条。取材在 :62/:67 一律用 history.slice(0, anchorIdx+1)，从第 0 条开始，不看已有 marker，也没有上界
- compact.ts:74-87 按原消息逐条映射，toolResult 与 toolUse part 原样保留，:87 把提示词 unshift 到最前面。结果是请求以原历史最后一条结尾（常为 assistant），并含工具块
- compact.ts:90-95 只消费 textDelta，忽略 done 事件里的 stopReason；:92 是 maxTokens 1024、thinkingLevel 'off'，没有 signal；:97 摘要为空时写入 '[摘要为空]' marker
- compact.ts:105-137 buildEffectiveHistory 在 :114/:124/:131/:136 四处都只映射成 {role, parts}
- src/minisd/agent/loop.ts:321-353 是压缩分支，:328 调用 summarize，:340-342 的空 catch 把失败吞掉；compactCount 只在成功时 +1（:330），所以失败后每一轮都会再试一次
- loop.ts:15-27 的 LoopEvent 联合里没有 notice/eventNote/compactFailed 类事件；error 事件只有 message 字段；fallback 事件是 {from,to,reason}
- src/shared/types.ts:48-56：AgentStreamEvent 的 done 带 stopReason，可以拿到截断信号。映射表：anthropic.ts:93 STOP_MAP 把 max_tokens 映射为 maxTokens，但缺 model_context_window_exceeded，未知值在 :151 兜底成 endTurn；openai.ts:75 把 length 映射为 maxTokens；gemini.ts:135 把 MAX_TOKENS 映射为 maxTokens
- src/minisd/agent/auto-title.ts:24 的 maxTokens 是 64；index.ts:427 调用它，失败在 :435 静默吞掉。Opus 5.5/Fable 5.1 关不掉思考，思考计入 max_tokens，64 基本必然拿到空标题
- src/minisd/providers/types.ts:17-29 ProviderError：:25 把 5xx 标为 retryable；:27 把 [400,401,403,404,422,429] 一律标为 fallbackable；没有错误分类码字段
- ProviderError 的构造点：anthropic.ts:111-112（HTTP 错误把响应体拼进 message）、openai.ts:96-97、gemini.ts:155-156、sse.ts:44（停滞，retryable）、anthropic.ts:160 / openai.ts:126 / gemini.ts:192（流提前结束）、index.ts:186（FakeProvider 的 __fail__ 固定抛 429）、loop.ts:427（把非 ProviderError 包一层）
- 重要：loop.ts:429-432 遇到 fallbackable 立即降级；但 :434-439 对非 fallbackable 且非 retryable 的错误，只要链上还有下一槽位也会 break 去降级。所以只把 fallbackable 设为 false 挡不住降级，溢出和绑定错误都必须在 :427 之后显式拦截
- loop.ts:456-461：链耗尽且降过级时报「所有模型均不可用」，否则报 lastError.message；:462 的 fallback 事件 reason 直接用原始错误文本
- src/minisd/index.ts:724-743 的改绑逻辑：首次 fallback 记下 pendingRebind，turnEnd 时才 setModelBinding 并广播 chat.sessions.changed；error 结束的回合不会改绑。:602-627 构建的 fallbackChain 槽位只有 provider/label/instanceId，不带窗口信息
- 模型窗口来源：model-catalog.ts:328-332 getModelContextWindow，优先级为手动 > models.dev/basellm 缓存 > BUILTIN（:125-144，例如 /^claude-/ 200K、/^deepseek-v/ 128K 且 thinking:false）；手动值由 providers.json 的 contextWindow 在 index.ts:262-266 注入。ContextPolicy 把 catalog 私有持有（context-policy.ts:17），FALLBACK_WINDOW=128K（:6）没导出，index.ts:985 又抄了一份
- 渲染端事件显示：stores/chat.ts:106 eventNotes 的 kind 联合是 'fallback'|'compacted'|'offloaded'|'retry'|'error'|'synced'|'pruned'；:528-537 的 error 分支固定 retryable:true；:540-548 fallback 的 detail 是 `${from} → ${to}（${reason}）`；lib/eventnote/copy.ts:31-40 里 fallback 短句固定为「已切换到备选模型」；ui/EventNotes.vue:16-27 有 ICONS/TONES/shortOf，:39 只有「重试」按钮
- X 波 chat.draft 机制：chat.ts:47-50 是字段；Composer.vue:235-242 先寄存后发送；:250-258 的 takeDraft 在 :252 以 `!chat.lastError` 为闸；:260 只在 setup 时调用一次。chat.ts:396-397 的 open(新 id) 会清空 lastError，所以接力新会话时 takeDraft 必然提前返回。这两处形态被 tests/renderer-first-send.test.ts:52/:64 钉死，不能直接复用
- 新建会话接力可用的现成件：chat.sessions.setModelBinding（index.ts:534）可以继承绑定；chat.newSession（chat.ts:391）建会话并 open；新会话消息为空，所以 AppShell.vue:49/94 渲染 StageWelcome，会新建一个 Composer 实例
- anthropic.ts:102 的缺省 baseUrl 是 'https://api.anthropic.com'，并去掉末尾斜杠；provider-store.ts:156 透传 p.baseUrl（可能为 undefined）。anthropic.ts:109 的请求头只有 content-type、x-api-key、anthropic-version，目前没有 anthropic-beta 需要合并
- anthropic.ts:35-47：只有 thinkingLevel!=='off' 时才发 {type:'enabled', budget_tokens}（:45）；:40-44 是 staleToolUse 降级关思考的分支。渲染端从不传 thinkingLevel（grep 只命中 index.ts:582/648），但 catalog 的 /^claude-/ 是 thinking:true，远端或桥调用 chat.prompt 带档位时，这两个模型会 400
- 官方文档 model-migration.md 1595-1660（Fable 5.1 的 BC2/BC3）：block_binding 不带请求头是 400「Extra inputs are not permitted」；只带请求头时缺省为 drop_block，但应显式写字段；不一致时的 400 文案含「The block is bound to a different conversation」；keep-tail 压缩会让保留回合的 thinking 失效；恢复法是剥掉全部 thinking 后重试一次。2026-08-31 起注册的账户默认强制校验。Opus 5.5 节（1860 起）：thinking 的 disabled 和 enabled+budget_tokens 在任何 effort 下都 400；BC3 给出的请求形态正是 anthropic-beta: thinking-binding-controls-2026-08-01 加 thinking:{type:'adaptive', block_binding:{prefix_mismatch_behavior:'drop_block'}}；Mythos 5.1 与 Fable 5.1 行为相同
- DeepSeek 推理内容：openai.ts:115 把 delta.reasoning_content 转成 thinkingDelta；loop.ts:412 累积到 reasoning；:526（取消路径在 :294）落为 RawMessage.reasoningContent（shared/types.ts:28）→ 库列 messages.reasoning_content（写在 chat-store.ts:231-235，读在 :260）。AgentMessage（shared/types.ts:76）只有 role/parts；toAgentMessages（loop.ts:66-77）丢掉这个字段；openai.ts:27-33 的 assistant 消息没有 reasoning_content
- 请求构建中重建 AgentMessage 的其它位置：loop.ts:96-110 synthesizeImageData、:139-146 placeholderOldMediaRefs、:192 pairToolResults，三处都只重建 user 消息，assistant 原样透传；prune.ts:41 只重建被修剪的消息（user）；ContextPolicy.estimateTokens（context-policy.ts:24-35）只数 parts，不含 reasoningContent
- 卸载：offload.ts:5 阈值 20000 字符；:34 的桩写着「使用 file_read 读取 /var/minis/offloads/<id>.txt 取回完整内容」；loop.ts:557-562 对任何 >20000 的工具输出都卸载，也包括 file_read 读回卸载文件的结果，于是形成循环
- file_read 在 tools/files.ts:53-70：没有 offset/limit；:5 MAX_READ 1MB，超出时在 :66 提示用 shell_execute 分页。paths.ts:4 里 offloads 属于会话桶；paths.ts:42-63 的 resolveGuestPath 能解析 /var/minis/offloads/... 和 Windows 绝对路径；shell.ts:5 输出上限 100KB，所以用 shell 分页超过 20000 字也会再次被卸载
- 修剪：prune.ts:25-26 keepRecent=12、minChars=2000；:39 的桩说「完整内容通常在 /var/minis/offloads/」。2K–20K 的结果从来没写过盘，这是假话
- pi 溢出正则：/home/user/refs/pi-mono/packages/ai/src/utils/overflow.ts :37-62 OVERFLOW_PATTERNS（27 条），:75-79 NON_OVERFLOW_PATTERNS。MIT，Copyright (c) 2025 Mario Zechner，上游 https://github.com/badlogic/pi-mono，版本 0.87.1，该文件最后提交 0e283203，参考副本 HEAD 8676a0dc。pi 在 :1648 按 baseUrl 含 deepseek.com 打开 requiresReasoningContentOnAssistantMessages，在 :1379-1385 给 assistant 补空串；OpenMinis 在 OpenAIProvider.kt:2505-2510 把 deepseek-v4-flash/-pro 单列门控（只借思路）

## W2a-compact [M]
行为：【取材】summarize 的输入 =「最新 marker 的 summary + 旧锚点之后到新锚点的消息」。旧锚点先按 lastCompactedMessageId 定位，找不到再按 createdAt 自愈；这个定位函数从 buildEffectiveHistory 抽出来两边共用。新锚点仍按「最近 3 个真用户回合 / ≥30 条保留 14 条」计算。新锚点不在旧锚点之后时返回 undefined：不调 provider、不写 marker，loop 落到正常请求，不会死循环。
【压平】请求的 messages 恒为 1 条 role=user、只含 text part，末条必是 user，不含 toolUse/toolResult。正文由【既有摘要】和【新增对话】两段组成。新增对话每行一条：[用户] / [助手] / [工具调用] name(tool_title="…", k="v")，参数值超过 200 字的写成「<N 字>」 / [工具结果·成功|失败]，超过 2000 字时留头 1500 加尾 500，并注明「原 N 字」。单条文本超过 6000 字时留头 4000 加尾 2000。thinking part 和 reasoningContent 不进摘要；mediaRef 写成 [图片 文件名]。全文过 sanitizeMultiline。
【提示词】要求把既有摘要与新增对话合并成一份新的完整摘要，覆盖目标与约束、已完成与进行中、关键决策、涉及的文件路径、待办与下一步，不超过 800 字，只输出正文。
【预算】summaryMaxTokens = min(16384, 调用方给的当前槽位输出上限, floor(window/4))。输入预算 = min(floor(window*0.6) − summaryMaxTokens, 100000) tokens，用 context-policy 抽出的 estimateTextTokens 估算（CJK/1.6，其余/4，公式不变）。从旧锚点之后按时间顺序累加，超出预算就停；新锚点后退到最后一条放得下的消息，至少取 1 条。没摘进去的消息留在原文里，下一轮水位仍高时再压，受 compactCount<3 约束。
【拒收】读 done 事件的 stopReason。summary.trim() 为空，或 stopReason 为 maxTokens 或 refusal 时，抛 CompactRejectedError，不写 marker。文案建议：「摘要模型返回了空内容，未写入压缩记录」「摘要被输出上限截断，未写入压缩记录」「摘要请求被模型拒绝，未写入压缩记录」。anthropic STOP_MAP 补上 model_context_window_exceeded→maxTokens。
【签名】summarize(history, sessionId, provider, opts?: {maxTokens?, windowTokens?, signal?})。缺省窗口 128K、maxTokens 16384，保证 new CompactEngine(store) 和现有测试调用不变。
【loop】调用时传入 {maxTokens: Math.min(16384, resolveMaxTokens(modelId)), windowTokens: contextPolicy.windowOf(modelId), signal: opts.signal}。catch 里先判取消：signal.aborted 时 yield '已取消' 并 return。否则 yield {kind:'compactFailed', reason:'empty'|'truncated'|'refusal'|'error', message}，并置 compactDisabled=true：本次运行不再尝试压缩，避免每轮白打一次失败请求。之后照常发请求。
【渲染】chat.ts 联合类型末尾追加 |'compactFailed'，onEvent 加分支推入 eventNotes {kind:'compactFailed', detail: message}；copy.ts 加 case 'compactFailed' → {icon:'alert', short:'上下文压缩失败，本轮按原样继续', tone:'warn'}；EventNotes.vue 的 ICONS/TONES 补 compactFailed。
【auto-title】maxTokens 64 → 2048（见 open_questions）。
改动点：
  - src/minisd/agent/compact.ts:48 改签名，加 opts {maxTokens, windowTokens, signal}
  - compact.ts:56-70 保留新锚点算法；新增旧锚点定位（从 :121-133 的自愈逻辑抽成 anchorIndexOf(history, marker)，与 buildEffectiveHistory 共用）；increment = history.slice(oldIdx+1, newIdx+1)，为空时 return undefined
  - compact.ts:72-87 整段换成 flattenForSummary(prevSummary, increment, caps)，导出为纯函数便于单测；按预算回退新锚点
  - compact.ts:89-95 同时消费 textDelta 和 done.stopReason；:92 改为 maxTokens: opts.maxTokens，并把 signal 传给 streamAgentMessage
  - compact.ts:97 删掉 '[摘要为空]' 兜底；为空、截断、拒绝时抛 CompactRejectedError（新导出类，带 reason）
  - src/minisd/agent/context-policy.ts:24-35 把单串估算抽成导出的 estimateTextTokens(s)，estimateTokens 改为调用它（结果逐值相同）；新增 public windowOf(modelId) = getModelContextWindow ?? FALLBACK_WINDOW，并导出 FALLBACK_WINDOW（index.ts:985 的副本可一并改成引用）
  - src/minisd/agent/loop.ts:15-27 LoopEvent 增加 {kind:'compactFailed'; reason: string; message: string}
  - loop.ts:321 条件加 && !compactDisabled；:328 传 opts；:340-342 的 catch 改为先判取消、再发 compactFailed、置 compactDisabled
  - src/minisd/providers/anthropic.ts:93 STOP_MAP 增加 model_context_window_exceeded: 'maxTokens'
  - src/minisd/agent/auto-title.ts:24 的 maxTokens 64→2048，同步更新 :7-9 等注释
  - src/renderer/src/stores/chat.ts:106 联合类型末尾追加 |'compactFailed'（必须加在末尾，守卫靠子串匹配）；在 :566 的 pruned 分支后新增 compactFailed 分支
  - src/renderer/src/lib/eventnote/copy.ts:31-40 增加 case 'compactFailed'
  - src/renderer/src/ui/EventNotes.vue:16-23 的 ICONS/TONES 各加 compactFailed
先红：
  - 新建 tests/compact-bounded.test.ts ①「摘要请求是单条 user 文本」：历史含 toolUse/toolResult，断言 provider.received[0].messages 长度为 1、role 为 'user'、每个 part.type==='text'。现在会红：compact.ts:74-87 发 N+1 条且含工具块
  - ② 已有 marker（anchor=A2，summary='OLD-SUM'）时，请求文本含 'OLD-SUM' 和 '用户回合3'，不含 '用户回合0'。现在会红：:62 从 history[0] 取材，也不带旧摘要
  - ③ 预算：windowTokens=64000，增量约为窗口 2 倍（CJK/ASCII 混合），断言 estimateTextTokens(systemPrompt+文本) + received[0].maxTokens < 64000，且新 marker 锚点早于未截取时的锚点。现在会红：没有任何上界
  - ④ 截断：toolResult 为 'R'.repeat(50000) 时请求文本不含 'R'.repeat(2001)，但含「原 50000 字」；toolUse 的 content 参数 10000 字时文本含「<10000 字>」和工具名。现在会红：原样送出
  - ⑤ SummaryProvider('') 时 await expect(summarize()).rejects.toThrow(/摘要为空/)，且 getLatestCompactMarker 为 undefined。现在会红：:97 写入 '[摘要为空]'
  - ⑥ provider 吐出 'partial' 并以 done stopReason='maxTokens' 结束时 rejects /截断/，不写 marker。现在会红：stopReason 被忽略
  - ⑦ summarize(h, sid, p, {maxTokens: 64000}) 时 received[0].maxTokens===16384；{maxTokens: 8192} 时为 8192。现在会红：固定 1024
  - ⑧ loop 级（可放进 compact-bounded）：window 64K 加 12 条大消息，dualProvider 第 1 次吐空摘要、第 2 次正常回复。断言 events 含 {kind:'compactFailed'}、最后一个事件是 turnEnd、库里没有 marker。现在会红：空摘要写入毒 marker 并发 compacted
  - ⑨ loop 级：摘要 provider 抛 ProviderError(500) 时出现 compactFailed；带一次工具调用、跑两轮的场景里摘要请求只发 1 次（compactDisabled 生效）。现在会红：错误被 :340 吞掉，每轮重试
  - ⑩ tests/anthropic.test.ts 追加：SSE 的 message_delta stop_reason 为 'model_context_window_exceeded' 时，最后事件是 {kind:'done', stopReason:'maxTokens'}。现在会红：落成 endTurn
  - ⑪ tests/auto-title.test.ts：buildTitleRequest('x').maxTokens===2048。现在会红：值是 64
守卫：
  - tests/compact.test.ts:92 断言角色序列 ['user','user','assistant']，有意翻红，改成 ['user']，并断言 parts 全是 text（:93 注释同步改）
  - tests/compact.test.ts:117 断言 received[0].messages 长度 28，有意翻红，改成 1（:116 注释同步改）；可另断言文本含 'TR0' 与 'TR25' 的工具结果行
  - tests/auto-title.test.ts:8-11 断言 maxTokens 64，有意翻红，改成 2048（用例标题同步改）
  - tests/agent-loop.test.ts:888-919、:922-959 的两例压缩用例预期保持绿：前者增量约 22.5K tokens，低于 64K×0.6−4096 的预算；后者 U0/A0 各 9 万字，按单条 6000 字截断后远低于预算。需复跑确认耗时仍在 120s 内
  - tests/renderer-eventnote.test.ts:89/:108 用 toContain 匹配联合类型子串，新 kind 必须追加在 'pruned' 之后，否则翻红
  - tests/renderer-chat-capabilities.test.ts:66 逐个检查 7 个 kind 是否存在，新增 kind 不影响
  - tests/context-policy.test.ts 全部断言的是公式值，抽出 estimateTextTokens 后必须逐值相等
风险：
  - 锚点后退意味着一次压缩可能只消化一部分增量，长会话会连续压缩（每次运行最多 3 次）；每次都是一次付费请求
  - 逐项截断会丢掉工具输出细节，这是有意取舍（pi 同样截到 2000）；文件路径靠 toolUse 参数行保住
  - 估算仍是字符口径（CJK/1.6，其余/4），异常内容（大量 emoji、base64）可能低估；0.6 系数加 16K 输出余量兜底，真正以 usage 为锚是 W5 的事
  - compactDisabled 让一次失败后本次运行不再压缩；水位继续涨时会走到溢出路径（W2a-overflow 的「上下文已满」给出路）。需要用户认可
  - 摘要请求落在 Opus 5.5/Fable 5.1 官方端点时会被 W2a-claudebinding 带上 beta 头和 block_binding；单条 user 请求没有可绑定的思考块，无副作用
  - marker 会同步到对端设备（chat-store 脏钩子）；新 marker 是累积摘要，对端同样只取最新 marker，语义兼容
  - 两例压缩用例本来就 CPU 密集，新增的压平和估算会再加时，注意 CI 时限

## W2a-overflow [L]
行为：【识别】新增 src/minisd/providers/overflow.ts：OVERFLOW_PATTERNS 与 NON_OVERFLOW_PATTERNS 从 pi 原样移植，不含 Cerebras 无 body 专条和按 usage 判定的静默溢出。导出 isContextOverflowMessage(message, status?)：status 为 429 或 ≥500 时一律 false，然后先排除 NON_OVERFLOW，再匹配 OVERFLOW。ProviderError 增加 code?: 'contextOverflow' | 'thinkingBinding'，opts.code 可以显式给出；没给时按 message+status 推导。code=contextOverflow 时 fallbackable 和 retryable 缺省都是 false。
【loop】在 :427 之后、:429 之前拦截 code==='contextOverflow'：
- curWin = contextPolicy.windowOf(activeSlot.provider.modelId)。在 fallbackChain 里找第一个下标 > slotIndex 且 windowOf(slot.provider.modelId) > curWin 的槽位。窗口相同或更小的槽位直接跳过，不发请求。
- 找到：slotIndex 设为该槽位下标减 1，标 overflowFallback 后 break。:462 发出的 fallback 事件带 reason:'上下文已满' 和 cause:'contextOverflow'。
- 找不到：yield {kind:'error', code:'contextFull', message:'上下文已满：当前模型放不下这段对话，可新建会话用摘要接力', relayDraft} 后 return。不走「所有模型均不可用」，也不改绑。
- 没有 contextPolicy 时视为各槽位窗口相同，结果只会报「上下文已满」。
【relayDraft】loop 用 store.getLatestCompactMarker 和最后一条真用户消息拼成：「接续上一个会话（上下文已满）。\n\n之前对话的摘要：\n<summary；没有摘要时写（上一会话还没有生成摘要）>\n\n我最后的请求是：\n<最后真用户文本，截 2000 字>」。
【改绑】沿用 index.ts 现有规则：溢出导致的降级在 turnEnd 后改绑；contextFull 没有 turnEnd，会话绑定不变。
【渲染】
- chat.ts：在通用 error 分支（:528）之前新增 `else if (e.kind === 'error' && e.code === 'contextFull')`：写 lastError、running=false、清空流式缓冲，推入 eventNotes {kind:'error', detail, retryable:false, relay:String(e.relayDraft ?? '')}，然后 open()。
- fallback 分支：e.cause==='contextOverflow' 时 eventNote 加 short:`因上下文已满改用 ${e.to}`。eventNotes 类型增加 relay?: string 和 short?: string。
- EventNotes.vue：shortOf 优先用 n.short；增加 `<button v-if="n.relay" type="button" @click="chat.relayToNewSession(n.relay)">新建会话接力</button>`。
- store 新增 relayDraft: null as null | string，以及 action relayToNewSession(text)：先记下旧会话的 modelBinding，设 this.relayDraft=text，再 await newSession()；旧 binding 存在时调 chat.sessions.setModelBinding 继承。
- Composer.vue 在 setup 和 watch(() => chat.relayDraft, {immediate:true}) 里消费：输入框为空就填入，非空就把接力文本放前面；然后清空 relayDraft 并聚焦。不自动发送，由用户确认。
- 不复用 chat.draft（理由见 facts）。
【署名】overflow.ts 文件头写：「OVERFLOW_PATTERNS / NON_OVERFLOW_PATTERNS 移植自 pi-mono packages/ai/src/utils/overflow.ts（MIT, Copyright (c) 2025 Mario Zechner, https://github.com/badlogic/pi-mono, v0.87.1 @0e283203）；判定函数按 DeskMinis ProviderError 改写」。THIRD-PARTY-NOTICES.md 新增「pi-mono（MIT）」一节，附 MIT 全文，列明用到的文件；与 W1a 借用的 pi edit.ts、killProcessTree 合并成同一节。
改动点：
  - 新建 src/minisd/providers/overflow.ts（正则表加 isContextOverflowMessage，加署名头）
  - src/minisd/providers/types.ts:17-29 增加 code 字段和 opts.code；构造时调用 overflow 判定（与 W2a-claudebinding 的 thinkingBinding 判定放在同一处）；:27 的 fallbackable 推导在 code 命中时改为缺省 false
  - src/minisd/agent/context-policy.ts 新增 windowOf 并导出 FALLBACK_WINDOW（与 W2a-compact 共用）
  - src/minisd/agent/loop.ts:23 fallback 事件增加可选 cause；:27 error 事件增加可选 code 和 relayDraft
  - loop.ts:427 之后插入 contextOverflow 拦截；加 findLargerWindowSlot() 和 buildRelayDraft(store, sessionId, history) 两个小函数
  - loop.ts:462 的 fallback 事件在 overflowFallback 时使用 reason '上下文已满' 和 cause，发出后复位该标记
  - src/minisd/index.ts:724-743 不需要改代码，只核对 contextFull 不会触发改绑
  - src/renderer/src/stores/chat.ts:50 附近新增 relayDraft 字段；:106 类型加 relay?/short?；:528 前插入 contextFull 分支；:540-548 fallback 分支按 cause 设 short；新增 relayToNewSession action（复用 :391 的 newSession 和 chat.sessions.setModelBinding）
  - src/renderer/src/ui/EventNotes.vue:24-27 shortOf 先取 n.short；:39 旁边加接力按钮
  - src/renderer/src/ui/Composer.vue:259-260 旁边新增 relayDraft 消费（setup 和 watch 两处），不动 takeDraft
  - /home/user/Deskminis/THIRD-PARTY-NOTICES.md 新增 pi-mono 节
先红：
  - 新建 tests/provider-overflow.test.ts ① 单元：以下文本配 status 400 时 isContextOverflowMessage 为 true：'Anthropic HTTP 400: {"error":{"message":"prompt is too long: 213462 tokens > 200000 maximum"}}'、'OpenAI HTTP 400: context_length_exceeded'、DeepSeek 的 'This model's maximum context length is 131072 tokens'、Kimi 的 'exceeded model token limit'、Qwen 的 'Range of input length should be [1, 98304]'、GLM 的 'Prompt too long'。'rate limit … too many tokens'、status 429 的 'prompt is too long'、status 500 均为 false。现在会红：模块不存在
  - ② new ProviderError('Anthropic HTTP 400: prompt is too long …', {status:400}) 的 code 为 'contextOverflow'、isFallbackable 为 false。现在会红：types.ts:27 判为 fallbackable
  - ③ loop：主槽位 modelId 'small'（窗口 128K）抛上述 400，链上是同为 128K 的 'peer'（getModelContextWindow 按 modelId 取表）。断言没有 fallback 事件、peer.calls===0、最后事件是 {kind:'error', code:'contextFull'}、message 含「上下文已满」。现在会红：会降级到 peer
  - ④ loop：链为 [peer 128K, big 1M] 时发生 fallback，to==='big'、cause==='contextOverflow'、reason 含「上下文已满」，peer.calls===0，big 正常回复后以 turnEnd 结束。现在会红
  - ⑤ loop：没有降级链时 error.code==='contextFull'，message 不含 'HTTP 400'。现在会红：原样透出英文 400
  - ⑥ loop：库里已有 marker（summary='S1'）且最后用户消息为 'U-last' 时，contextFull 事件的 relayDraft 同时含 'S1' 和 'U-last'。现在会红
  - ⑦ 回归（现在绿，必须保持绿）：status 400 且文本为 'rate limit exceeded: too many tokens' 时仍按老路径降级到 peer
  - ⑧ 集成（仿 tests/modelgroup-fallback-rebind.test.ts 起本地假 OpenAI 端点）：组 [A, B] 的 contextWindow 同为 128000，A 返回 400 {error:{message:"This model's maximum context length is 131072 tokens"}}。跑完后 B 的请求次数为 0；会话 binding 仍是 'group:<gid>'；收到的 chat.event 是 error 且 code 为 contextFull。现在会红：会降级到 B 并改绑 provider:B
  - ⑨ 新建 tests/renderer-context-full.test.ts（源码守卫，认调用形态，不认裸字符串）：chat.ts 匹配 /e\.kind === 'error' && e\.code === 'contextFull'[\s\S]*?retryable: false[\s\S]*?relay:/；EventNotes.vue 匹配 /@click="chat\.relayToNewSession\(n\.relay\)"/；Composer.vue 匹配 /watch\(\s*\(\) => chat\.relayDraft/；chat.ts 的 relayToNewSession 体内匹配 /chat\.sessions\.setModelBinding/；fallback 分支匹配 /e\.cause === 'contextOverflow'[\s\S]*?因上下文已满改用/。现在会红
守卫：
  - tests/provider-errors.test.ts:29-33 用的是 message 'x'，400/404/422 仍判 fallbackable，保持绿
  - tests/agent-loop.test.ts:452-494 三例降级用例用 429，不受影响；:493 的「所有模型均不可用」文案不改
  - tests/rpc.test.ts:536 的 FakeProvider __fail__ 固定 status 429（index.ts:186），被状态闸排除，保持绿
  - tests/renderer-eventnote.test.ts:94 的正则 /e\.kind === 'error'[\s\S]*?kind: 'error'[\s\S]*?retryable: true/：contextFull 分支放在通用分支之前、通用分支保留字面量 `retryable: true`，就仍能匹配。若把通用分支改成条件表达式会翻红，需申报重指
  - tests/renderer-first-send.test.ts:52/:64 钉住 draft 类型和 takeDraft 闸：本方案不碰，保持绿
  - tests/renderer-tasks-panel.test.ts:34-35 的 open/send 清零正则：新增 relayDraft 时不要插进那两段清零序列，或插在末尾之后
风险：
  - 正则误判：例如 'exceeds the limit of \d+' 可能命中配额类文案；靠 NON_OVERFLOW 加状态闸缓解，需要为国内厂商补真实样本
  - 「更大窗口」依赖模型目录：BUILTIN 的 /^claude-/ 是 200K，而 Opus 5.5/Fable 5.1 实际 1M；deepseek-v 是 128K。目录偏低时会误报「上下文已满」，偏高时会漏掉；用户可以在设置里填手动 contextWindow
  - 中转商把报错包成中文或自定义格式时正则不命中，行为退回老路径（fallbackable 降级），不会比现在更差
  - 降级到更大窗口的模型会更贵，提示条如实说明；改绑后后续回合一直用大模型
  - 接力新会话走欢迎页，relayDraft 的消费时机依赖 Composer 重新挂载；watch 加 immediate 兜住两种时序，需要 xvfb 实拍
  - 渲染端 .vue 不在 typecheck 覆盖内，只能靠源码守卫加 xvfb

## W2a-claudebinding [S]
行为：【判定】anthropic.ts 新增三件：
- 纯函数 isOfficialAnthropicEndpoint(baseUrl)：new URL() 解析，要求 protocol==='https:' 且 hostname==='api.anthropic.com'，精确相等，不用 includes/endsWith；解析失败返回 false。
- BINDING_MODELS = new Set(['claude-fable-5-1','claude-mythos-5-1','claude-opus-5-5'])，精确匹配，带别名或日期后缀的 id 不命中，维持旧行为。
- 导出 anthropicBindingControls(baseUrl, modelId) = 以上两者同时成立。
【请求体】buildAnthropicBody(req, modelId, opts?: {bindingControls?: boolean})：
- modelId ∈ BINDING_MODELS 时，不看 thinkingLevel，也不看 staleToolUse，一律不发 {type:'enabled', budget_tokens} 或 disabled（这两种在这些模型上都是 400）。
- bindingControls=true 时写 body.thinking = {type:'adaptive', block_binding:{prefix_mismatch_behavior:'drop_block'}}，赋值位置沿用 :45，即 system 之后；否则不写 thinking，缺省就是 adaptive，第三方端点不带 block_binding，否则会 400「Extra inputs are not permitted」。
- 其它模型走原分支，一字不动，JSON 逐字节不变。
【请求头】streamAgentMessage 在 :109 的 'anthropic-version' 之后，bindingControls 为真时加 'anthropic-beta': 'thinking-binding-controls-2026-08-01'。经 mergeBetas(list) 按逗号合并去重；目前没有其它 beta 值需要合并。
【400 分类】:112 的响应体含 /bound to a different conversation/i 时，抛 ProviderError，code='thinkingBinding'、fallbackable=false、retryable=false。message 中文在前、原文在后：「Claude 拒绝回放历史思考块：对话前缀校验未通过，换模型无法解决。请新建会话继续；如在用第三方中转，可改用官方端点。（原始错误：…）」。humanizeError 会截到 80 字，所以中文句必须放在最前面。
【loop】:427 之后遇到 code==='thinkingBinding' 直接 yield error 并 return，不走 :434-439 那条「非 fallbackable 也降级」的路径。
【不做】thinkingLevel→output_config.effort 映射，留给 W4c。
改动点：
  - src/minisd/providers/anthropic.ts:1-6 新增 BINDING_MODELS、isOfficialAnthropicEndpoint、anthropicBindingControls、mergeBetas
  - anthropic.ts:8 签名加第三个可选参数 opts；:35-47 在最前面加 BINDING_MODELS 分支（命中后 return 前只可能写 adaptive+block_binding），原分支保持原样
  - anthropic.ts:106-110：const binding = anthropicBindingControls(this.baseUrl, this.modelId)；headers 条件追加 anthropic-beta；body 调用时传 {bindingControls: binding}
  - anthropic.ts:112：先读 text，匹配绑定文案时带 code:'thinkingBinding' 构造，其余仍按 status 构造
  - src/minisd/providers/types.ts:17-29 的 code 联合包含 'thinkingBinding'（与 W2a-overflow 同一处改动）；推导函数也认 /bound to a different conversation/i，兜住 openai 兼容中转转发的同类错误
  - src/minisd/agent/loop.ts:427 之后插入 thinkingBinding 拦截（与 contextOverflow 拦截相邻）
先红：
  - 新建 tests/anthropic-binding-controls.test.ts ①：fetchImpl 捕获 init，AnthropicProvider({modelId:'claude-opus-5-5'}) 不传 baseUrl。断言 headers['anthropic-beta']==='thinking-binding-controls-2026-08-01'；JSON.parse(body).thinking 深等于 {type:'adaptive', block_binding:{prefix_mismatch_behavior:'drop_block'}}。现在会红：既没有头也没有字段
  - ② claude-fable-5-1、claude-mythos-5-1，以及 baseUrl 为 'https://api.anthropic.com/'（带尾斜杠）时同①。现在会红
  - ③ 官方端点 + claude-opus-5-5 + thinkingLevel 'high' 时 thinking 仍是 adaptive+block_binding，JSON 里不出现 'budget_tokens'。现在会红：anthropic.ts:45 发出 enabled+budget_tokens，真端点会 400
  - ④ 第三方 baseUrl 'https://relay.example.com' + claude-opus-5-5 + thinkingLevel 'high'：请求头里没有 anthropic-beta 键，body.thinking 为 undefined，JSON 里不出现 'block_binding' 和 'budget_tokens'。现在会红：会发 budget_tokens
  - ⑤ 回归（现在绿，冻结后保持绿）：官方端点 + 'claude-sonnet-4-5' / 'claude-opus-5' / 'm' 时，请求头没有 anthropic-beta 键，body 的 JSON.stringify 与冻结的黄金串相等（放进 tests/provider-body-golden.test.ts，见 W2a-deepseek）
  - ⑥ fetchImpl 返回 400，响应体为 'messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. …'。await rejects.toMatchObject({code:'thinkingBinding', fallbackable:false, retryable:false})，message 以「Claude 拒绝回放历史思考块」开头。现在会红：判为 fallbackable 且是英文
  - ⑦ loop：主槽位抛出⑥的错误，链上有 backup。断言没有 fallback 事件、backup.calls===0、最后一个 error 事件的 message 含「新建会话」。现在会红：loop.ts:429 或 :434 会降级
守卫：
  - tests/anthropic.test.ts:34（'claude-sonnet-5'）、:45-58/:67-70/:87-101（'m'）都不是目标模型，保持绿
  - tests/anthropic.test.ts:157-217 流式用例的 modelId 'm' 走缺省官方 baseUrl，但不是目标模型，不加头，保持绿
  - tests/agent-loop.test.ts:284/:332/:337 以两参形式调用 buildAnthropicBody(…, 'claude-x')，第三参可选，保持绿
  - tests/provider-errors.test.ts 全部保持绿
风险：
  - 未经真 key 验证（报告 #15 已标注）。beta 头值或字段名若在正式上线时变化，三个模型在官方端点上的全部请求都会 400。可选兜底：400 文案含 'block_binding' 或 'Extra inputs are not permitted' 时去掉头和字段重试一次（未计入本项）
  - 第三方中转对 2026-08-31 后注册的账户仍会 400。触发前缀变化的来源有：index.ts:657 系统提示每步重建（含当日记忆日志）、prune.ts:25 的 12 条滑窗、loop.ts:125 的媒体占位滑窗、loop.ts:370-379 续写和空响应提醒只加在请求侧、keep-tail 压缩。W2a 之后这些会话会直接报中文错误而不是乱降级，但仍然走不下去，见 open_questions 中的剥离重试
  - drop_block 会在前缀变化后丢掉思考，前缀之后的首轮成本和延迟上升（文档已说明）。这不影响正确性；前缀稳定要等 W5
  - staleToolUse 分支对这三个模型不再生效：历史里 tool_use 缺思考块时交给 API 处理（drop_block 自身就会产生这种形态，文档也建议剥离保留回合的思考），仍需真 key 验证

## W2a-deepseek [S]
行为：【类型与透传】
- AgentMessage 增加可选 reasoningContent，只在 role==='assistant' 且 RawMessage.reasoningContent !== undefined 时条件展开，不产生值为 undefined 的键。
- toAgentMessages（loop.ts:66-77）和 buildEffectiveHistory（compact.ts:114/:124/:131/:136）共用一个 toAgentMessage(m)。建议放进新模块 src/minisd/agent/agent-message.ts，避免 compact.ts 反向 import loop.ts 形成循环。
- pairToolResults、synthesizeImageData、placeholderOldMediaRefs 对 assistant 原样透传，无需改动。prune.ts:41 改成 { ...m, parts } 防止将来丢字段，当前只改 user 消息，行为不变。
【回放】openai.ts 新增并导出 requiresReasoningContentEcho(modelId) = /(?:^|\/)deepseek-v4(?:$|[^0-9])/i.test(modelId)。
- 命中：deepseek-v4、deepseek-v4-flash、deepseek-v4-pro、deepseek-ai/DeepSeek-V4-Pro、deepseek/deepseek-v4。
- 不命中：deepseek-chat、deepseek-reasoner（旧推理模型输入里带 reasoning_content 会 400）、deepseek-v3.2、deepseek-v40。
- buildOpenAIBody 在 assistant 分支（:28-32 之后）执行 if (echo) msg.reasoning_content = m.reasoningContent ?? ''，每条 assistant 都带，缺失补空串。别的地方不加这个键，请求头、thinking 参数、reasoning_effort 都不变。
- Anthropic 和 Gemini 构建器忽略这个字段，逐字节不变。
【钉住】先提交 tests/provider-body-golden.test.ts 冻结黄金值，再改实现。
- 矩阵：请求 4 种（纯文本；工具回合 toolUse+toolResult；带图 user；thinkingLevel 'high'）× OpenAI 兼容模型（gpt-5、deepseek-chat、deepseek-reasoner、deepseek-v3.2、qwen3-max、kimi-k2、glm-4.6）× flags（缺省；{reasoningEffort:false}），外加 Anthropic 若干模型 × 官方/第三方 baseUrl。
- 对 JSON.stringify(body) 计算 sha256，与硬编码 hex 表逐项比较。不用 vitest 快照，避免 -u 静默改写。
- 请求里的 assistant 消息带 reasoningContent（写成对象字面量加 as AgentMessage），证明非 v4 模型忽略这个字段。
改动点：
  - src/shared/types.ts:76 把 AgentMessage 改成 { role: Role; parts: ContentPart[]; reasoningContent?: string }（渲染端不引用 AgentMessage，已 grep 确认）
  - 新建 src/minisd/agent/agent-message.ts，内含 toAgentMessage(m)（sanitize toolResult，条件带上 reasoningContent）；loop.ts:66-77 与 compact.ts:107-136 改为调用它
  - src/minisd/agent/prune.ts:41 把 { role: m.role, parts } 改成 { ...m, parts }
  - src/minisd/providers/openai.ts:19 前新增 requiresReasoningContentEcho；:27-33 的 assistant 分支追加条件赋值
  - src/minisd/agent/context-policy.ts:12-14 的注释更新（reasoningContent 已进入 AgentMessage，但估算仍只数 parts，这是有意保留，W5 改为以 usage 为锚）
先红：
  - 新建 tests/openai-deepseek-reasoning-echo.test.ts ①：多轮工具调用，assistant#1 的 reasoningContent 为 'R1' 并带 toolUse，assistant#2 没有该字段，模型 'deepseek-v4-pro'。body.messages 中所有 role==='assistant' 的项依次带 reasoning_content 'R1' 和 ''。现在会红：openai.ts:28 没有这个键
  - ② 'deepseek-v4-flash' 和 'deepseek-ai/DeepSeek-V4-Pro' 同①；'deepseek-chat'、'deepseek-reasoner'、'deepseek-v3.2'、'gpt-5' 的 JSON.stringify(body) 不含子串 'reasoning_content'。v4 部分现在会红
  - ③ loop 级：库里有 assistant RawMessage，reasoningContent 为 'THINK' 并带 toolUse T1，后跟 T1 的 toolResult 和新的 user 消息。runAgentLoop 配 ScriptedProvider 时，seen[0].messages 中该 assistant 的 reasoningContent 为 'THINK'。现在会红：toAgentMessages 丢掉了
  - ④ compact 级：buildEffectiveHistory(history, marker) 返回的锚点之后的 assistant 保留 reasoningContent。现在会红：compact.ts:124 只映射 {role, parts}
  - ⑤ 新建 tests/provider-body-golden.test.ts：所有非 v4 用例和非目标 Anthropic 用例的 sha256 与冻结表相等。在改实现之前单独提交并保持绿，改完仍须全绿；这是「其它模型请求体逐字节不变」的钉子
  - ⑥ 回归：同一个带 reasoningContent 的请求交给 buildAnthropicBody 和 buildGeminiBody，得到的 JSON 与去掉该字段的请求完全相等
守卫：
  - tests/openai.test.ts:18-73 用的模型是 'm' 或 'gpt-x'，不命中正则，保持绿
  - tests/context-policy.test.ts:28-35 断言只数 parts，数值不变，保持绿；其注释「buildEffectiveHistory 时已被丢弃」会过时，需同步改注释
  - tests/agent-loop.test.ts 中凡用 toEqual 比较 req.messages 的用例：因为是条件展开，历史里没有 reasoningContent 时不产生新键，保持绿；toStrictEqual 已 grep，没有命中
风险：
  - DeepSeek V4 多轮工具调用的 400 由两家参考项目独立印证，但 DeskMinis 未用真 key 复现，需要 W3 冒烟
  - 全量回放已捕获的推理会加大 token 成本，并让水位估算偏低（estimateTokens 不数 reasoningContent）
  - OpenRouter 这类聚合端点上的 deepseek/deepseek-v4 也会回放；上游若不接受该字段会 400，没有样本
  - shared/types.ts 被渲染端共享；字段可选，对 .vue 无影响

## W2a-honest [S]
行为：【卸载读回不再二次卸载】offload.ts 新增 readBackOf(sessionId, toolName, inputJson)，满足以下全部条件才返回 {absPath}，否则 undefined：
- toolName==='file_read'；
- JSON.parse(input).path 是字符串；
- paths.resolveGuestPath 不抛错；
- relative(paths.sessionBucket(sessionId,'offloads'), abs) 非空、不以 '..' 开头、不是绝对路径。
这样 guest 路径 /var/minis/offloads/<id>.txt 和宿主绝对路径两种写法都能识别；别的会话的 offloads 不算。
新增 READBACK_MAX = 50_000 字符和 clampReadBack(output, absPath)：不超过上限原样返回；超过时按码点截取前 50000（Array.from，与 :33 同规，不切断 emoji），尾部追加「\n[已截断：该文件共 N 字符，这里只返回前 50000 字符。其余部分请用 shell_execute 分段读取，每段不超过 20000 字符，否则会再次被卸载。文件位置：<abs>]」。
loop.ts:557-562 先判 readBackOf：命中时 outputToStore = clampReadBack(...)，不写新文件，也不发 offloaded 事件；否则走原来的 shouldOffload。toolEnd 事件仍广播完整输出。
【桩文案】offload.ts:34 第三行：output.length ≤ READBACK_MAX 时维持原文，保证 offload.test.ts:35 的全等断言不变；超过时改为「使用 file_read 读取 /var/minis/offloads/<id>.txt 可取回前 50000 字符（全文 N 字符，其余需分段读取）」。
【修剪桩如实】prune.ts:39 改为「[工具结果已修剪：原 N 字符。为控制上下文长度，这条较早的结果未随本次请求发送；如仍需要，请重新调用相应工具获取]」。不再指向 offloads，也不宣称「未落盘」，因为被修剪的也可能是读回结果。「已修剪」和「原 N 字符」两个子串保留。
改动点：
  - src/minisd/agent/offload.ts:1-5 新增 import relative/isAbsolute、READBACK_MAX 常量
  - offload.ts:13-36 新增 readBackOf 和 clampReadBack 两个方法；:34 的桩第三行按长度二分
  - src/minisd/agent/loop.ts:557-562 卸载判定前加读回分支（c.input 已在 :479 经 safeToolInput 归一，可直接 JSON.parse）
  - src/minisd/agent/prune.ts:39 替换文案（:10-22 的注释同步改）
先红：
  - 新建 tests/offload-roundtrip.test.ts ①：用 mkCtx 加真实 fileReadTool，预先写 offloads/T1.txt（25000 个 'X'）。ScriptedProvider 先发 file_read {path:'/var/minis/offloads/T1.txt'}，再发 endTurn。断言库里这条 toolResult.output === 'X'.repeat(25000)，没有 path 含 'T1' 之外的新 offloaded 事件，offloads 目录里没有以本次 toolUseId 命名的新文件。现在会红：loop.ts:558 会再卸载成桩
  - ② 同①，但 path 用宿主绝对路径 join(paths.sessionBucket(sid,'offloads'),'T1.txt')。现在会红
  - ③ 读回文件为 60000 字符时，落库 output 以 50000 个字符开头，含「已截断」「共 60000 字符」「每段不超过 20000 字符」和宿主绝对路径，总长 < 50600。现在会红：会被卸载成桩
  - ④ 回归（现在绿）：file_read 读工作区里 25000 字的 big.txt 仍然被卸载，并发 offloaded 事件
  - ⑤ OffloadEngine.offload(SID,'T9','Y'.repeat(60000)).stub 含「前 50000 字符」，不含「取回完整内容」。现在会红
  - 新建 tests/prune-stub-honest.test.ts ⑥：pruneOldToolResults 修剪 3000 字结果得到的桩不匹配 /offloads/，含「重新调用」「已修剪」和「原 3000 字符」。现在会红：prune.ts:39 指向 /var/minis/offloads/
守卫：
  - tests/offload.test.ts:35 全等断言 25000 字符的桩，走 ≤READBACK_MAX 分支，文案不变，保持绿
  - tests/prune.test.ts:26-28、:40 断言含「已修剪」和「原 3000 字符」，新文案保留这两个子串，保持绿
  - tests/agent-loop.test.ts:855-885 卸载用例用自定义 big 工具，不是 file_read，保持绿
  - tests/agent-loop.test.ts:981-982 断言含「已修剪」和「原 150000 字符」，保持绿
风险：
  - W1b 会收窄 guardRead/guardWrite（files.ts:27-32/:44-49）；读当前会话自己的 offloads 桶必须继续免审，需要和 W1b 分区对齐
  - file_read 的 1MB 上限（files.ts:66）仍在；超过 1MB 的卸载文件只能用 shell 读，提示文案已写明分段读
  - 用 shell 读回超过 20000 字仍会被卸载；只在提示里要求每段 ≤20000，没有做机制保证
  - 50000 字符的读回内容进入历史后会占用水位，之后由修剪和压缩处理

## open_questions
- Q: 溢出时要不要先强制压缩一次，再在同一槽位重试（pi 的做法，resurvey/pi.md:61 也这样建议），然后才考虑降级或报「上下文已满」？
  推荐: W2a 不做，登记给 W5
  理由: 路线图 W2a 已经定为「只降级到窗口更大的槽位，否则报上下文已满并提供接力」。在止血波里给循环新增一条「压缩→重试」路径风险较高，而且 W2a 的压缩刚改为有预算、可能分多次推进。等 W5 改成以真实 usage 定水位后再做，补上去大约 40 行
- Q: 摘要输入超出预算时怎么截：让新锚点后退，只摘能放下的最早一段（剩下的下轮再压）；还是省略增量中段？
  推荐: 新锚点后退
  理由: 省略中段的内容既不在摘要里，也不在保留原文里，等于永久丢失。锚点后退不丢任何内容，代价是可能连续压缩几次，每次运行最多 3 次
- Q: 第三方端点遇到「bound to a different conversation」时，是否在 AnthropicProvider 内剥掉全部 thinking/redacted_thinking 块后重试一次（官方文档的恢复法 1）？
  推荐: 做。仅限未带 beta 头的请求，每个请求最多一次，重试仍失败再抛 thinkingBinding 中文错误
  理由: 国内用户大多走中转。2026-08-31 之后注册的账户，只要系统提示每步重建、修剪滑窗或做了压缩，每次请求都会 400。只做「不可降级 + 中文说明」等于会话报废；剥离重试只改 anthropic.ts 一处，不影响官方端点（官方端点已经用 drop_block）
- Q: 要不要在 buildEffectiveHistory 里剥掉 marker 创建之前就存在的保留消息上的 thinking part（文档对 keep-tail 压缩的建议）？
  推荐: W2a 不做，放到 W5 与前缀稳定一起做
  理由: 官方端点已有 drop_block 兜底；单做这一项修不好第三方端点，那里前缀还会被系统提示、修剪、媒体滑窗改变。它还会改变所有带 marker 的 Anthropic 会话的请求体，与「止血不改结构」不符
- Q: 「不发 budget_tokens」是否扩到所有只支持 adaptive 的代际（opus-4-7/4-8/5、sonnet-5、fable-5、mythos-5），以及是否把 thinkingLevel 映射到 output_config.effort？
  推荐: W2a 只处理三个目标模型；代际表和 effort 映射都放 W4c
  理由: 渲染端从不传 thinkingLevel（只命中 index.ts:582/648），budget_tokens 分支目前基本不会被触发；扩大范围会改动更多模型的请求体，超出止血范围
- Q: DeepSeek V4 的回放范围：所有 assistant 都回放已捕获的推理（缺失补空串）；还是只回放当前回合，更早的一律补空串？
  推荐: 全部回放已捕获的值（与路线图和 pi 一致）
  理由: 对同一条历史，请求前缀保持稳定，DeepSeek 的前缀缓存能命中；「只回放当前回合」会在下一回合把上回合的推理换成空串，前缀随之改变。成本上升先靠 W3 真 key 冒烟观察
- Q: 读回卸载文件的上限取多少？要不要借这次给 file_read 加 offset/limit？
  推荐: 固定 50000 字符，超出时如实提示用 shell 分段读、每段 ≤20000；offset/limit 放到 W4/W5
  理由: 50000 约为卸载阈值的 2.5 倍，普通 shell 输出（≤100KB）读两次能读完。file_read 加参数会改工具 schema，属于新功能，而 W2 约定不加新功能
- Q: auto-title 的 maxTokens 放宽到多少？
  推荐: 2048
  理由: Opus 5.5 和 Fable 5.1 关不掉思考，DeepSeek V4 默认也会思考，思考都计入 max_tokens；1024 在 medium effort 下仍可能被思考吃光。按实际生成量计费，上限放宽本身不多花钱；2048 对各家兼容端点也都安全
- Q: 「新建会话接力」要不要继承旧会话的模型绑定？
  推荐: 继承 modelBinding，调用 index.ts:534 已有的 chat.sessions.setModelBinding；工作区沿用现有「新会话继承上次用过的工作区」逻辑，不另做
  理由: 不继承会落到默认模型，窗口可能更小，接力后立即再次溢出
- Q: 溢出导致降级到更大窗口的模型后，要不要改绑会话？
  推荐: 沿用现有规则：该槽位跑通、turnEnd 之后改绑
  理由: 不改绑的话，下一回合又从小窗口主力开始，每轮先白打一次 400。改绑已有广播和提示，fallback 事件带 cause，界面能说清原因

## files
- src/minisd/agent/compact.ts
- src/minisd/agent/loop.ts
- src/minisd/agent/context-policy.ts
- src/minisd/agent/auto-title.ts
- src/minisd/agent/offload.ts
- src/minisd/agent/prune.ts
- src/minisd/agent/agent-message.ts（新建）
- src/minisd/providers/types.ts
- src/minisd/providers/overflow.ts（新建）
- src/minisd/providers/anthropic.ts
- src/minisd/providers/openai.ts
- src/shared/types.ts
- src/minisd/index.ts（仅在 :985 改为引用导出的 FALLBACK_WINDOW，可选）
- src/renderer/src/stores/chat.ts
- src/renderer/src/lib/eventnote/copy.ts
- src/renderer/src/ui/EventNotes.vue
- src/renderer/src/ui/Composer.vue
- /home/user/Deskminis/THIRD-PARTY-NOTICES.md
- tests/compact.test.ts（:92、:117 有意翻红并重指）
- tests/auto-title.test.ts（:8-11 有意翻红并重指）
- tests/anthropic.test.ts（追加 STOP_MAP 用例）
- tests/compact-bounded.test.ts（新建）
- tests/provider-overflow.test.ts（新建）
- tests/renderer-context-full.test.ts（新建）
- tests/anthropic-binding-controls.test.ts（新建）
- tests/openai-deepseek-reasoning-echo.test.ts（新建）
- tests/provider-body-golden.test.ts（新建，先于实现提交）
- tests/offload-roundtrip.test.ts（新建）
- tests/prune-stub-honest.test.ts（新建）

## xvfb
- 压缩失败提示条（compactFailed）：警告语调和图标出现在对话流里，短句为「上下文压缩失败，本轮按原样继续」，详情能展开，本轮回复照常出现
- 溢出降级提示条：短句直接显示「因上下文已满改用 <名称(模型)>」，而不是「已切换到备选模型」；模型胶囊随之显示改绑后的模型
- 「上下文已满」错误条：没有「重试」按钮，有「新建会话接力」按钮；点击后切到新会话（欢迎页），输入框预填接力文本（含摘要和最后的请求）且不自动发送，模型胶囊显示继承的绑定
- 接力时输入框里已有字的情况：接力文本排在前面，原有文字不被吞掉