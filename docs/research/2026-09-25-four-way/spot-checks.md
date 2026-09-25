# 附录：旧报告关键行抽查记录（2026-09-25）

用途：正文 §5「重新核对过的」逐条出处。
- 「来源」指旧报告里的位置：9/24 = `2026-09-24-reference-resurvey.md` 及其附录，9/25 = `2026-09-25-opencode-v2/baseline-and-cuts.md`，NOTICES = 仓库根 `THIRD-PARTY-NOTICES.md`。
- 结论三种：
  - **对**：行号与说法都对得上；
  - **偏**：说法对，行号偏了几行，本文用新行号；
  - **错**：以源码为准，已在正文注明。
- 路径简写同正文 §1。

## OpenCode（sst/opencode `6df0d5d`）

| # | 来源 | 说法 | 核对位置 | 结论 |
|---|---|---|---|---|
| 1 | 9/25 会话模型 | 事件在 immediate 事务里读 seq、跑投影、写事件 | `core/src/event.ts:205-299` | 对 |
| 2 | 9/25 会话模型 | 重放不一致时报错 | `core/src/event.ts:285-300` | 对 |
| 3 | 9/25 会话模型 | event_sequence 加 event 两表，(aggregate_id, seq) 唯一 | `core/src/event/sql.ts:4-25` | 对 |
| 4 | 9/25 会话模型 | 事件类型带版本号，引 `schema/src/event.ts:109-123` | 实际在 `schema/src/event.ts:94-105`（versionedType）；109-123 是只读 Map 包装 | 错 |
| 5 | 9/25 会话模型 | 投影出 message/part 读模型 | `core/src/session/projector.ts:210-413` | 对 |
| 6 | 9/25 协议 | DurableDefinitions 不含增量 | `schema/src/session-event.ts:448-519` | 对 |
| 7 | 9/25 协议 | 全局流溢出时直接失败 | `core/src/event.ts:152-164`（Queue.dropping 满了就 fail） | 对 |
| 8 | 9/25 协议 | 先订阅唤醒信号再回放 | `core/src/event.ts:565-604` | 对 |
| 9 | 9/25 协议 | history 分页，引 `protocol/src/groups/session.ts:320-345` | history 端点在 `:307-323`，events 端点在 `:326-342` | 偏 |
| 10 | 9/25 运行器 | failInterruptedTools 在下一次 run 把悬空工具判失败 | `core/src/session/runner/llm.ts:119-139,397` | 对 |
| 11 | 9/25 运行器 | 收尾回合的提示以 assistant 结尾 | `core/src/session/runner/llm.ts:202,218`；`runner/max-steps.ts:1-16` | 对 |
| 12 | 9/25 运行器 | 溢出压缩后只重跑一次，再溢出报错 | `core/src/session/runner/llm.ts:355-388` | 对 |
| 13 | 9/25 工具 | 注册身份不一致时报 Stale tool call | `core/src/tool/registry.ts:57,61` | 对 |
| 14 | 9/25 工具 | 按 2000 行 / 50KB 统一截断并落盘 | `core/src/tool-output-store.ts:13-15` | 对 |
| 15 | 9/25 权限 | 配置 deny 先判；拒绝级联到同会话 | `core/src/permission.ts:137-162,231-240` | 对 |
| 16 | 9/25 压缩 | buffer 20000、保留 8000、合并旧摘要 | `core/src/session/compaction.ts:12-55` | 对。另见：模板已是固定 Markdown 结构，并且不查 length 截断（`:178-221`） |
| 17 | 9/25 压缩 | 检查点之前的原生块不再回放 | `core/src/session/runner/to-llm-message.ts:145-163` | 对 |
| 18 | 9/25 provider | reasoning 只在同一模型续写时回放 | `core/src/session/runner/to-llm-message.ts:68-80` | 对 |
| 19 | 9/25 provider | 重试、retry-after、脱敏、响应体截到 16KB | `llm/src/route/executor.ts:35-50,94-100` | 对 |
| 20 | 9/25 provider | V2 runner 只接 3 条路由、cost 写 0 | `core/src/session/runner/model.ts:142-169`；`runner/llm.ts:338` | 对 |
| 21 | 9/25 指令文件 | 首次运行冻结基线，之后追加 context.updated | `core/src/session/context-epoch.ts:40-78` | 对 |
| 22 | 9/25 指令文件 | AGENTS.md 向上找、不越出项目根 | `core/src/instruction-context.ts:39-50` | 对 |
| 23 | 9/25 指令文件 | 配置解析失败时静默跳过 | `core/src/config.ts:150-160`（有错误就 return） | 对 |
| 24 | 9/25 todo | todo.updated 不是持久事件，没有读取路由 | `schema/src/session-todo.ts:18-25`；`core/src/session/todo.ts:32-57`；protocol 里 grep 不到 todo | 对。补一句：清单本身整表存进 TodoTable |
| 25 | 9/25 回退 | 三段式回退 | `core/src/session/revert.ts:59-121` | 对 |
| 26 | 9/25 可见性 | 权限与提问算「需要注意」 | `app/src/pages/layout/project-avatar-state.ts:36-45` | 对 |
| 27 | 9/25 界面投影 | 类型化消息联合 | `schema/src/session-message.ts:165-213` | 对 |
| 28 | 本次新读 | 溢出正则 27 条加 3 条排除；无 body 的 400/413 一律算溢出 | `llm/src/provider-error.ts:4-38` | — |
| 29 | 本次新读 | 编辑仍用 String.replace，`$&` 会被解释 | `core/src/tool/edit.ts:179-182`；Node 复现：`"x = 1".replace("1", "$$5 $&")` 得到 `x = $5 1` | — |
| 30 | 本次新读 | 编辑写回用 writeIfUnchanged | `core/src/tool/edit.ts:192-194`；`core/src/file-mutation.ts:60-61,144-160` | — |
| 31 | 本次新读 | killTree 用裸名 taskkill | `core/src/shell.ts:31-57` | — |
| 32 | 本次新读 | V1 发行路径的 session.fork | `opencode/src/session/session.ts:691-730` | — |
| 33 | 本次新读 | desktop 包：单实例、导航守卫、崩溃转储不上传 | `desktop/src/main/index.ts:198`；`windows.ts:257-270`；`logging.ts:39-41` | — |

## pi（badlogic/pi-mono `8676a0d`）

| # | 来源 | 说法 | 核对位置 | 结论 |
|---|---|---|---|---|
| 1 | NOTICES §3 第 1 行 | 上游 `edit-diff.ts:11-25,306-314`、`edit.ts:190-197`、`utils/text.ts:2-4` | 三处都打开看过 | 对 |
| 2 | NOTICES §3 第 2 行 | 24 条溢出正则加 3 条排除 | `ai/src/utils/overflow.ts:37-63,75-79` | 对 |
| 3 | NOTICES §3 第 3 行 | killProcessTree 的 win32 分支在 `shell.ts:216-232` | `coding-agent/src/utils/shell.ts:216-232` | 对 |
| 4 | 9/24 `pi.md` R5 溢出 | 「约 27 条 OVERFLOW_PATTERNS」 | 实为 24 条加 3 条排除，W2a-2 提交已订正 | 错 |
| 5 | 9/24 `pi.md` R5 溢出 | 静默溢出、length 零输出两种情况 | `ai/src/utils/overflow.ts:150-167` | 对 |
| 6 | 9/24 `pi.md` R5 溢出 | 只补救一次，失败尝试从模型视图持久省略 | `coding-agent/src/core/agent-session.ts:2599-2697` | 对 |
| 7 | 9/24 `pi.md` R5 compat | thinkingFormat 各家分支；DeepSeek 回放 reasoning_content | `ai/src/api/openai-completions.ts:874-972,1380,1586-1690` | 对 |
| 8 | 9/24 `pi.md` R5 编辑 | NFKC 模糊匹配会改中文全角标点 | `coding-agent/src/core/tools/edit-diff.ts:37` | 对 |
| 9 | 9/24 `pi.md` R5 压缩 | 旧摘要增量合并、截断拒收、摘要请求不留缓存 | `coding-agent/src/core/compaction/compaction.ts:599-617,653` | 对 |
| 10 | 9/24 `pi.md` R5 压缩 | 默认 reserve 16384、keep 20000 | `compaction.ts:144-151` | 对 |
| 11 | 9/24 `pi.md` R4 水位 | 压缩后返回 null、显示「?」 | `coding-agent/src/core/agent-session.ts:3858-3890` | 对 |
| 12 | 9/24 `pi.md` R4 读取 | 续读提示 | `coding-agent/src/core/tools/read.ts:169-178` | 对 |
| 13 | 9/24 `pi.md` R4 插话 | steer/followUp 双队列、中止时回填 | `agent/src/agent-loop.ts:174-306`；`agent/src/agent.ts:247-248`；`interactive-mode.ts:1918` | 对 |
| 14 | 9/24 `pi.md` R4 AGENTS.md | 不经信任就注入 | `coding-agent/src/core/resource-loader.ts:572-579`；`docs/security.md:55` | 对 |
| 15 | 9/24 `pi.md` R4 崩溃记录 | 最多 5 条、保留 7 天 | `coding-agent/src/core/crash-log.ts:17-18` | 对 |
| 16 | 9/24 `pi.md` R3 截断回合 | 工具调用一律不执行 | `agent/src/agent-loop.ts:262-270,475-501` | 对 |
| 17 | 9/24 `pi.md` R3 details | 结果分 content 与 details | `agent/src/types.ts:420-432`；`coding-agent/src/core/tools/edit.ts:210` | 对 |
| 18 | 9/24 `pi.md` R3 转录内 system | 只有验证过的模型按位置发，其余折回首条 | `ai/src/types.ts:811-812`；`ai/src/utils/transcript.ts:108-120` | 对 |
| 19 | 9/24 `pi.md` R3 耐久内核 | replay safe/never | `agent/src/harness/runtime/drive/tools.ts:44,194,527` | 对。补一句：只在实验面用，稳定面工具没有这个声明 |
| 20 | 9/24 `pi.md` R2 实验面 | Unix 传输在 win32 抛错 | `client/src/unix.ts:38,99` | 对 |
| 21 | 本次新读 | 会话文件加载旧版本时整文件重写 | `coding-agent/src/core/session-manager.ts:1085-1094,1124` | — |
| 22 | 本次新读 | 权限：不在每次工具调用前请求批准 | `coding-agent/docs/security.md:3`；`agent-session.ts:530-550` | — |
| 23 | 本次新读 | 编辑预览依赖 npm 的 diff 包 | `coding-agent/src/core/tools/edit-diff.ts:5` | — |
| 24 | 本次新读 | 自动压缩失败没有连续失败熔断 | `coding-agent/src/core/agent-session.ts:2873-2897`；grep 不到 circuit、consecutive | — |
| 25 | 本次新读 | 尾部 token 估算用 chars/4 | `coding-agent/src/core/compaction/compaction.ts:333,339` | — |

## AionUi（iOfficeAI/AionUi `6744099`，本次浅克隆）

| # | 来源 | 说法 | 核对位置 | 结论 |
|---|---|---|---|---|
| 1 | 9/24 正文 §2 | 设计令牌自上次阅读以来零变更 | `git diff 74512d3 6744099 -- packages/desktop/src/renderer/styles/themes/default-color-scheme.css` 为空 | 对 |
| 2 | 9/25 可见性 | 等待集合纯 reducer | `desktop/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync.ts:182-207` | 对 |
| 3 | 9/25 界面投影 | 运行态视图带运行中投递位 | `desktop/renderer/pages/conversation/runtime/conversationRuntimeViewStore.ts:12-22,150-166` | 对 |
| 4 | 9/25 todo | usePlanRecovery | `desktop/renderer/pages/conversation/PlanBar/usePlanRecovery.ts:23-30` | 对 |
| 5 | 9/25 cowork | ICronSchedule | `desktop/common/adapter/ipcBridge.ts:1673-1760` | 对。补一句：定时任务可绑定助手与模型，created_by 可以是 agent |
| 6 | 9/25 裁剪清单 | 右栏只有 files/changes 两个 tab | `desktop/renderer/pages/conversation/explorer/ExplorerContainer.tsx:512-548` | 对。补一句：changes 是源代码管理面板（`:251`） |
| 7 | 9/25 裁剪清单 | 占用环不拿猜的分母给百分比 | `desktop/renderer/components/agent/ContextUsageIndicator.tsx:14-22` | 对 |
| 8 | 9/24 `aionui.md` | 单实例锁 | `desktop/index.ts:85-120` | 对 |
| 9 | 9/24 `aionui.md` | 开发态 userData 隔离 | `desktop/process/utils/configureChromium.ts:28-40` | 对 |
| 10 | 9/24 `aionui.md` | 引擎 60 秒内最多重启 3 次 | `packages/web-host/src/backend-launcher.ts:525-526,1024-1035` | 对 |
| 11 | 本次新读 | 在某条消息处分叉成新会话 | `desktop/common/adapter/ipcBridge.ts:328-340` | — |
| 12 | 本次新读 | 桌面端实时通道：退避重连后发重连信号，不补发 | `desktop/common/adapter/httpBridge.ts:417-458,488-496` | — |
| 13 | 本次新读 | Web 模式桥断线时排队、重连后补发 | `desktop/common/adapter/browser.ts:161-164,282-290` | — |
| 14 | 本次新读 | 思考档等选项由引擎报上来 | `desktop/renderer/hooks/agent/useAcpConfigOptions.ts:436-438` | — |

## ZCode（zai-org/ZCode `29628c9`）

| # | 来源 | 说法 | 核对位置 | 结论 |
|---|---|---|---|---|
| 1 | 9/25 会话模型 | 快照带 revision 与 seq，引 `snapshot.ts:397,475-476` | 会话快照的 logEpoch、seq、revision 在 `:470-476`；`:397` 是子代理投影自己的 revision | 偏 |
| 2 | 9/25 协议 | 7 种封闭增量 | `packages/shared/src/zcode-protocol-v4/delta.ts:96-140`（row 四种、state 一种、workflowRun 两种） | 对 |
| 3 | 9/25 协议 | 断开时拒绝全部挂起调用 | `packages/rpc/src/channelClient.ts:66-85` | 对 |
| 4 | 9/25 运行器 | 每个 model-step 边界最多消费一条 guide | `cli/core/src/runtime/methods/turn-guide-drain.ts:8-30` | 对 |
| 5 | 9/25 工具 | readOnly、concurrentSafe、sideEffectScope | `cli/core/src/tool/scheduler.ts:23-36` | 对 |
| 6 | 9/25 权限 | InteractionRegistry 与自动应答 | `cli/bootstrap/src/zcode-protocol-v4/interaction-registry.ts:30-31`（隐藏宽限 60 秒、自动应答 300 秒） | 对 |
| 7 | 9/25 压缩 | circuit_breaker | `cli/core/src/compact/policy.ts:62,142` | 对 |
| 8 | 9/25 压缩 | rapid-refill 熔断 | `cli/core/src/runtime/methods/compact.ts:230-244` | 对 |
| 9 | 9/25 todo | 整表替换、一个进行中 | `cli/core/src/tool/handlers/todo.ts:135-139` | 对 |
| 10 | 9/25 回退 | 回退前预览 safe/unsafe，有一个不安全就整批拒绝 | `cli/core/src/runtime/methods/file-rewind.ts:79,94,117` | 对 |
| 11 | 9/24 路线 W6a | 崩溃预算 5 分钟、1/2/4/8/16 秒 | `packages/zcode-server-cli/src/contracts.ts:5-6`；`supervisor/crashBudget.ts:3-40` | 对 |
| 12 | NOTICES §4 | 数据根锁上游 `packages/zcode-server-cli/src/runtime/lock.ts` | 文件在（210 行） | 对 |
| 13 | 9/24 路线 W7 借鉴栏 | ZCode「splitTurnHistory、classifyStep」 | 按名搜不到；最接近的是 `packages/ui/src/v4/conversationTurnRenderUnits.ts:146` 的 splitTurnTailRows | 错（名字对不上，W7 设计稿前重新定位） |
| 14 | 本次新读 | usage 为底、只估增量 | `cli/core/src/runtime/methods/compact.ts:313-340` | — |
| 15 | 本次新读 | 按错误码判溢出、被动压缩 | `cli/core/src/runtime/helpers/model-errors.ts:202-262`；`runtime/methods/compact.ts:352` | — |
| 16 | 本次新读 | 编辑的先读后写与过期判定 | `cli/core/src/tool/handlers/edit.ts:440-460` | — |
| 17 | 本次新读 | 分叉时撤销分叉点之后的检查点；回退三种范围 | `cli/core/src/runtime/methods/workspace-fork.ts:83-140`；`cli/contracts/src/rewind/index.ts:21-27` | — |
| 18 | 本次新读 | Windows 裸名 taskkill；输出收集器；输出编码用 iconv-lite | `cli/adapters/src/exec/node-execution-adapter-process.ts:146-170`；`output-collector.ts:12-40`；`outputEncoding.ts:3` | — |

## deepseek-harness（`46a7f68b0`）

| # | 来源 | 说法 | 核对位置 | 结论 |
|---|---|---|---|---|
| 1 | NOTICES §5 | 窗口导航与新窗口守卫 | `apps/desktop/src/main.ts:218,281` | 对 |
| 2 | NOTICES §5 | 删除前先停止会话里的工作 | `packages/workspace/workspace/src/index.ts:129-147,348-480`（功能提交 cbae324bf） | 对 |

## DeskMinis（main `3a811a1`）

| # | 来源 | 说法 | 核对位置 | 结论 |
|---|---|---|---|---|
| 1 | 9/25 §5 | 历史工具缺结果时默认显示成功 | `renderer/ui/StageChat.vue:112` | 对（main 上仍是；W2b-11a 在 hemo/h 分支） |
| 2 | 9/24 §4 第 13 条 | rpc.ts 没有 onclose | `renderer/rpc.ts:34-41` | 对（W2b-3 未合入） |
| 3 | 9/24 §4 第 11 条 | 溢出被当成可降级 | 已由 W2a-2 修掉：`minisd/providers/types.ts:57-79`、`minisd/agent/loop.ts:518-526` | 已修 |
| 4 | 9/24 §4 第 5、10 条 | 压缩从 history[0] 取材、空摘要也写 | 已由 W2a-1 修掉：`minisd/agent/compact.ts:221-312` | 已修 |
| 5 | 9/24 §4 第 1 条 | file_edit 用 String.replace | 已由 W1a-2 修掉：`minisd/tools/edit-text.ts:66-103` | 已修 |
| 6 | 9/24 §4 第 7 条 | 没有单实例锁 | 已由 W1b-3 修掉：`main/index.ts:47-60`；`minisd/index.ts:279` | 已修 |
| 7 | 9/24 §4 第 19 条 | shell 超时只杀 PowerShell 本身 | 已由 W1b-1 修掉：`minisd/tools/shell.ts:75`；`minisd/proc/win-exec.ts` | 已修 |
| 8 | 本次 | 握手后引擎退出只记一笔、不重启 | `main/index.ts:150-153` | — |
| 9 | 本次 | system 每步重建 | `minisd/index.ts:804-815`；`minisd/agent/loop.ts:481-482` | — |
| 10 | 本次 | Anthropic 只取 input_tokens | `minisd/providers/anthropic.ts:198` | — |
| 11 | 本次 | 没有 todo、分叉、AGENTS.md、ask_user | 源码 grep 零命中 | — |
