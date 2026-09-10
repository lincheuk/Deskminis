# X 波设计稿：首发竞态排查——「紧跟启动的首条 Enter 偶发被吞」

状态：**定稿即施工**（自己做模式；交接文档 §6 一档二选一，0.3.0 上架需 Windows 真机，云端只能做这件）。
候选池条目原文（L6，2026-08-20）：「紧跟启动的首条 Enter 偶发被吞（driver 实测，lastError 空、
running 未起即返回），三次里偶现一次；不盲修，待专项排查」。T 波把输入链路整个重写过，先重新复现。

## §1 复现结论（drive-x1.mjs，冷启动 + 全新数据根，main `26f64af`）

| 场景 | 做法 | 结果 |
|---|---|---|
| **startup** 紧跟启动直发 | textarea 一出现就（延迟 0/150/600ms）真键盘输入 + Enter，各 2 次 | **6/6 落库**。Enter→`running=true` 31–43ms，Enter→回合结束重取 66–78ms，零 pageerror |
| **l6** L6 判定法回放 | 照抄 drive-l6.mjs 的 sendMsg（waitIdle 400ms 宽限 + 1200ms + 落库校验重试）+ 它的种子（一台永不应答的 MCP，`startupTimeoutSeconds: 2`），3 次 | **3/3 判「首条被吞」**；真相：`runningAtCheck: true`（回合正在跑）、消息全部落库、重试的 Enter 被 `chat.running` 挡掉、文字留在框里 |
| 同上，不带 MCP 种子 | 3 次 | **3/3 首次即过** |
| **double** 首条消息双击 Enter | 真按键两次 / 同步派发两次，各 2 次 | **4/4 复现真缺陷**：建出 2 个会话（后端 sessions 目录数为证）、红横幅「该会话正在运行中，请等待完成或取消」、回合进行中 `running` 被误归零 |
| **noprov** 全新用户无模型首发 | 不种 FakeProvider，输入 + Enter | **1/1 复现真缺陷**：会话建了、文字清了、`lastError` 只在 store 里，欢迎页零交代 |

**L6 的「首发竞态」是剧本判定的假阳性，消息从未丢过。** 三个因素叠出来的：

1. **首条消息要先建会话**：`send()` 里 `await newSession()`（create → list → messages.list → workspace.get 四趟往返）
   之后才到 `chat.send()` 把 `running` 置 true——Enter 到 running 有 30–46ms 的窗口；后续消息是同步置位、零窗口。
2. drive-l6 的 `waitIdle` 在 `keyboard.press` 一返回就轮询 `.send.stop`，正好落在这个窗口里 → 见「未在跑」→
   400ms 宽限后返回 → 再睡 1200ms → 查落库。**判定期限实际只有 ~1.6s。**
3. 它的种子 MCP 永不应答、启动超时 2s，而 `chat.prompt` 落库 user 消息之前要 `await mcpManager.ensureForRun()`——
   首回合被拖过 1.6s，用户消息尚未经 turnEnd→`open()` 重取回前端，判定即失败。

「lastError 空、running 未起即返回」正是 ②的观察面；「三次里偶现一次」是①的窗口与 CDP 往返的赛跑。

## §2 排查顺带挖出的三处真缺陷（本波修）

| # | 缺陷 | 复现 | 后果 |
|---|---|---|---|
| **X1** | 首条消息建会话期间 `send()` **无重入闸**：`chat.running` 直到会话建好才为 true，这 30–46ms 里第二次 Enter / 点发送键照样进 `send()` | double 4/4 | 两个会话（一个成孤儿「新会话」）；第二个 `chat.send` 撞后端 `inFlight` 抛「该会话正在运行中」→ 红横幅 + **`running=false` 而回合仍在跑**（停止键消失、进行中指示消失——界面撒谎） |
| **X2** | 首条消息被**同步拒绝**时欢迎页零交代：`chat.lastError` 只有 StageChat 渲染；乐观消息一摘 `inChat` 回落欢迎页，横幅无处可显；草稿已清空 | noprov 1/1 | 全新用户第一次按 Enter：文字消失、多出一个幽灵会话、没有任何一句话——**这就是真正会被用户体验为「首条被吞」的那一种** |
| **X2b** | 同路径的 `newSession()` 若抛错（建会话 RPC 失败）是 unhandled rejection | 代码审阅 | 同样静默 |
| **X3** | `RpcClient.connect()` 的注释说「握手完成信号：connect() 一开始就赋值」，实际 `this.ready` 在 `await bridge.minisdInfo()` **之后**才赋值；这几毫秒里发起的 `call()` 走 `sendNow()` 撞 `this.ws` 未建 → TypeError | 单测可红（人手打不进这窗口，但 `renderer-rpc-connecting` 那个真机撞过的 CONNECTING 竞态与它同源） | 静默失败 |

记账不修（不在首发路径上，或代价与收益不配）：

- `chat.send()` 用**调用时刻**的 `activeId`：首条消息建会话期间若用户点了别的会话/「新建会话」，消息发进切过去的那个会话。X1 闸挡住了本卡的重入，挡不住 NavRail。真实触发概率极低，且「发进用户眼前那个会话」并不算错得离谱。
- 首回合被 MCP `ensureForRun` 拖慢（按配置的启动超时可达数秒）：界面已有 running 点阵，后端也已 `inFlight` 占位，不算撒谎；MCP 启动超时的语义是 D5 定的，不在此改。
- drive-l6.mjs 存档件**不改**（它是 L6 那一刻的真实剧本，改了就复现不了假阳性），但 driver/README 的「发消息类 driver 一律照抄它」要**改口**：落库校验的思路可以抄，`waitIdle` 必须先等 running 起来再等它落下（drive-x1 的 `waitTurn`）。

## §3 修法

### X1 重入闸（Composer.vue）

- `const sending = ref(false)`；`send()` 入口 `if ((!t && !paths.length) || chat.running || sending.value) return;`；
  进入即 `sending.value = true`，`finally` 放开。Enter 与发送键都走 `send()`，一处闸两条路。
- `canSend` 追加 `&& !sending.value`：建会话那几十毫秒发送键变灰——这就是「已经在发」的反馈，不另加 spinner。
- 命门：闸必须 `finally` 放，否则任一 await 抛错后输入卡永久失能。

### X2 交代（Composer.vue + StageChat 不动）

- 输入卡在 **hero 态**渲染 `chat.lastError`（`cardError = variant === 'hero' ? chat.lastError : ''`）：欢迎页没有会话视图那条
  横幅，首条消息被拒只能在这张卡上说。会话页由 StageChat 的 `.err` 负责，这里不重复（同一条错显示两遍是另一种撒谎）。
- 建会话失败：`catch (e) { chat.lastError = \`新建会话失败：${message}\`; return; }`——草稿留在框里，闸在 finally 放。
  附件路径 `saveImages()` 的同款 `newSession()` 同样兜住，写 `attErr`。
- 文案：错误原文来自后端（「尚未配置任何模型 provider，请先在设置中添加」本身就是人话），不再套一层。

### X2b 草稿交回（stores/chat.ts + Composer.vue）

- 现状：`send()` 先清 `text` 再 `await chat.send()`；被拒后 `chat.send` 只写 `lastError`、摘乐观消息。
  **为什么不能只在本实例里恢复**：首条消息乐观入列的一瞬 `inChat` 翻真，欢迎页整棵换成会话页，发它的那个输入卡实例已卸载；
  拒绝回来时 `inChat` 又翻假，欢迎页**新建**一个输入卡实例——草稿必须跨实例传递。
- 做法：store 加 `draft: null | { text; attachments }`（与 `pendingFilePreview` 同一种「一处写、另一处消费即清」的寄存字段）。
  Composer 在清空输入框之前寄存 `chat.draft = { text: text.value, attachments: atts.value }`；
  `await chat.send()` 返回后：`chat.lastError` 非空 → 取回，否则 `chat.draft = null`。
  新实例 setup 时同样 `if (chat.lastError && chat.draft) 取回`——欢迎页那个新实例靠这条。
- 取回策略：框空 → 原样放回；框里已有新字 → 草稿在前、换行、新字在后（不吞任何一方）。
- 为什么判 `lastError` 而不是让 `chat.send` 返回布尔：`chat.send` 的现有契约是「同步拒绝写 lastError」，20+ 测试锚着它；
  且新实例 setup 时拿不到那个返回值，只能看 store。

### X3 握手信号提前（rpc.ts）

- `this.ready` 改为在 `connect()` **第一个 await 之前**赋值：整段（minisdInfo → new WebSocket → onopen）包进一个 async IIFE，
  `this.ready = iife(); await this.ready;`。`call()` 的排队逻辑不动。注释改成真话。

## §4 拆步与先红

| 步 | 内容 | 先红 |
|---|---|---|
| **X1** | rpc.ts 握手信号提前 | `renderer-rpc-connecting.test.ts` 新增「call 紧跟 connect() 同步发起（minisdInfo 尚未返回）也排队」——现状 TypeError 拒绝 |
| **X2** | Composer 重入闸 + hero 态交代 + 草稿寄存/取回 + 附件路径兜底；store `draft`；CHANGELOG 0.3.0 修复条 | 新守卫 `renderer-first-send.test.ts`（断言认调用形态：`sending.value` 入口判 / `finally` 放 / `canSend` 含闸 / `chat.lastError =` 写 / `chat.draft = {` 寄存 / `if (chat.lastError && chat.draft)` 取回 / hero 态 `v-if` 渲染）；`mu6-capability-wiring` 不受影响（不新增 store action） |
| 终验 | typecheck 0 / 全量对 Linux 基线 diff 空 / build / drive-x1 `double` `noprov` `startup` 重跑 + 截图 | — |

## §5 验证面（终验必须有输出）

- double：`sessionDirs` 必须是 1、`lastError` 空、`errShown` 空、回合结束时 `userMsgs 1`。
- noprov：欢迎页 `errShown` 含「尚未配置任何模型 provider」、`draft` 等于输入原文、`sessionDirs` 1（会话仍会建，这是既有语义；建了但有交代，不算幽灵）。
- startup：6/6 照旧落库（闸不能把正常首发挡掉）。
- xvfb 截图入册：noprov 修后欢迎页（错误行 + 草稿仍在）、double 修后会话页（单会话、无横幅）。

## §6 终验（施工后，main `6b6e5eb` + `a270df6`）

| 项 | 结果 |
|---|---|
| 先红 | `renderer-first-send` 7 红 + `renderer-rpc-connecting` 新例红（TypeError: Cannot read properties of undefined (reading 'send')）→ 修后 10/10 绿 |
| typecheck / build | 0 / 0（build 无 Duplicate attribute 类告警） |
| 全量 | 166 测试文件 / 1858 例（云端 1806 过 + 52 Windows-only 基线），对 Linux 基线逐行 diff 空 |
| double（修后） | 4/4：`sessionDirs` 1、`lastError` 空、`errShown` 空、回合结束 `userMsgs` 1（`x1-double-after.png`） |
| noprov（修后） | 1/1：欢迎页 `errShown` = 「尚未配置任何模型 provider，请先在设置中添加」、`draft` 等于输入原文、`sessionDirs` 1（`x1-noprov-after.png`） |
| startup（修后） | 3/3 落库，Enter→running 35–42ms（闸没把正常首发挡掉） |
| 守卫订正 | 「finally 首句放闸」放宽为「finally 块内」——守卫意图是块内，代码在放闸前写了行注释；不是豁免 |
| 顺带发现（不修） | StageWelcome 的 scoped `.hero` 规则命中 Composer 根节点（`class="wrap hero"` 同名），卡内错误行在欢迎页居中；lockfile `version` 字段仍是 0.1.1（npm install 会把它同步成 0.3.0，本波还原未提交） |
