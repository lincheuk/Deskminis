# 渲染端（W2b-disconnect / W2b-permscope / W2b-runset / W2b-welcome / W2b-modelbar / W2a-overflow 的界面部分）

## facts
- src/renderer/src/rpc.ts:35-37 只挂了 onopen / onerror / onmessage，没有 onclose；pending（:6）是 Map<number,(msg)=>void>，结算方式为 msg.error ? reject : resolve（:52），所以断线时用 {error:{message}} 就能统一结算，不用改 Map 类型
- rpc.ts:18 在 connect() 的第一个 await 之前就同步给 this.ready 赋值（X1 提交 6b6e5eb）；握手期间到达的 call 通过 this.ready.then(sendNow) 排队（:57）。tests/renderer-rpc-connecting.test.ts 的三例守的就是这套结构。它用的 FakeWebSocket（:5-18）没有 readyState 字段，所以任何按 readyState 判断的写法都会让这三例变红
- 浏览器的 WebSocket.send 在 CLOSING/CLOSED 状态下不抛错，只是静默丢弃。所以只靠 onclose 结算 pending 还不够：断线之后的新 call 必须由一个 lost 标志主动拒掉，否则会永远挂着
- stores/chat.ts:134-143 的 chat.event 处理器会丢掉非当前会话的事件（:142 `if (sessionId === this.activeId) this.onEvent(event)`）；open() 切换会话时 :397 无条件执行 `this.running = false`
- stores/chat.ts:10 的 PendingPerm 接口没有 sessionId；:155-161 入库时也没取 req.sessionId。但 minisd/index.ts:307 广播的是完整的 PermissionRequest，而 minisd/tools/types.ts:21 的 PermissionRequest.sessionId 是必填 string，数据本来就有
- stores/chat.ts:165-170 permission.resolved 的超时分支会无条件往当前会话的 eventNotes 补一条「权限请求已超时，自动拒绝」。卡片按会话分开之后，会话 B 的超时会串进会话 A 的对话流
- ui/StageChat.vue:216 用 `v-for="p in chat.pendingPerms"` 渲染全部会话的卡；:158 贴底 watch 也读 chat.pendingPerms.length
- ui/TaskPanel.vue:62-66 显示「{{ chat.pendingPerms.length }} 个请求等在对话里——回合正卡在这」，ui/WorkspacePanel.vue:100 的任务 tab 点也读全局 pendingPerms。卡片按会话分开后，这两处不跟着改就会替别的会话计数，成为新的假话
- LoopEvent 的 kind 见 minisd/agent/loop.ts:16-27：textDelta、thinkingDelta、toolStart、toolEnd、messagePersisted、turnEnd、retry、fallback、compacted、offloaded、pruned、error。另有 payload 级的 kind:'synced'（minisd/index.ts:1117、sync/coordinator.ts:133），它不是回合事件
- 回合的终止事件只有 turnEnd（loop.ts:540）和 error（loop.ts:298/305/440/459/468/493/513/574，以及 IIFE catch 里的 minisd/index.ts:750）；没有「回合开始」事件（用户消息在 index.ts:691 落库，不广播）。chat.event 只在 index.ts:746/750 的 run IIFE 里广播；chat.cancel 按 sessionId 取 controller（index.ts:752-755）
- ui/Composer.vue:225-234 send() 只在 `!chat.activeId` 时按 welcomeAssistantId 建会话。AppShell.vue:50 的 inChat 是 `!!chat.activeId && chat.messages.length > 0`，也就是说，有活动会话但它是空的时候显示的也是欢迎页（NavRail 的「新建会话」NavRail.vue:30-33 最常走到这里）。此时 StageWelcome.vue:52 承诺「直接输入即以该预设开始」，但发送走的是 else 路径，不套用助手
- 同一个谎还有两条隐式路径：Composer.vue:181-185 贴图时、WorkspacePanel.vue:34-36 选工作区时，都会用 chat.newSession() 建一个无助手的会话；newSession→open() 又在 chat.ts:401 把 welcomeAssistantId 清成 ''，欢迎页上的「已选 X」就这样静默作废
- minisd 没有给已有会话套用助手的 RPC：助手预设只经 chat.sessions.create {assistantId}（minisd/index.ts:467-474）和定时任务（index.ts:1147-1150）调用 applyAssistantPreset（minisd/assistants/store.ts:156-170）写入。后端需要的零件都有：chat-store.ts:107 setAssistant、setModelBinding，skills/store.ts:91 setSessionOverride(…, null) 可以清覆盖
- 附件路径是相对于会话的：chat.prompt 在 minisd/index.ts:586-593 按本会话的附件桶校验。所以「换一个新会话再发」这种修法遇到已贴的附件会报「附件不存在」
- 新会话的工作区继承 settings 里的 workspace.lastUsed（minisd/index.ts:457 写、:468/:471 读），不一定是原会话的工作区
- ui/ModelBar.vue:7 的注释写着「选中哪个，下一条消息就用它」，会话或助手有绑定时这是假话；:17 `chat.defaultProviderId || items.value[0]?.id` 的回落与 stores/chat.ts:212-213、minisd/store/provider-store.ts:136（删默认后回落到首个）策略一致；:38-41 .cur 胶囊只显示模型名，没有「默认」字样
- lib/models/binding.ts:64-67 的 default 分支 label 是裸模型名；grep 确认 describeBinding().label 只被 Composer.vue:339 的胶囊消费（NavRail.vue:79/137 与 StageAssistants.vue:67/70/105/164 只用 short/missing/kind）
- 没有任何 RPC 暴露最新压缩摘要：chat.contextInfo（minisd/index.ts:958）只回 token 数；chat-store.ts:217 的 getLatestCompactMarker 只在后端内部用。渲染端手里只有 compactedState.summary（loop 截到 200 字，而且只有本次打开期间发生过压缩才有）
- stores/chat.ts:528-537 的 error 分支一律 `retryable: true`；EventNotes.vue:39 只有「重试」钮。lib/eventnote/copy.ts:23 的 5xx 正则 `/\b(5\d{2})\b/` 实测会把「上下文已满（已用 512 / 200000）」误判成「模型服务暂时不可用（512）」
- Composer.vue:250-258 的 takeDraft 闸是 `if (!chat.lastError || !d) return;`；而 open() 换会话会在 chat.ts:397 清掉 lastError。所以「新建会话接力」没法原样复用 chat.draft 预填
- preload/index.ts:5-32 没有重启通道；main/index.ts:66 只在握手前（minisdPort===0）处理 minisd 退出。握手之后 minisd 崩溃，唯一的可见信号就是渲染端 ws 断开
- tests/mu6-capability-wiring.test.ts:144-150 的自守要求：store 里凡是 4 空格缩进的 `name(` action，要么在 ui/ 下有 `.name(` 调用，要么 store 内有 `this.name(` 调用。新增的每个 action 都受它约束（getter 若写成方法语法同样会被匹配，建议不用 getters，改走 lib 纯模块）
- 调用 init() 的桩测试只有 tests/renderer-permtier.test.ts:57/:65 和 tests/renderer-model-groups.test.ts:62，它们的 rpc 桩（permtier:16、model-groups:15）只有 call/connect/on
- 图标与令牌：ui/UiIcon.vue:33 有 shield、:35 有 alert、:31 有 refresh；PermCard.vue:95 与 TaskPanel.vue:62-66 都用「shield + var(--c-warn)」表达「等你批准」；styles/theme.css:72/76 有 --c-warn/--c-warn-soft，:73/:77 有 --c-err/--c-err-soft（暗色主题在 :172-177 与 :206-211 重定义）
- 基线：本分区相关的 15 个测试文件 145 例全部通过（renderer-rpc-connecting、renderer-first-send、renderer-model-groups、renderer-lost-entries、mu6-capability-wiring、models-binding、renderer-chat-capabilities、renderer-eventnote、renderer-permcard、renderer-permtier、renderer-thinking、renderer-tasks-panel、renderer-assistants、renderer-welcome、renderer-titlebar-stacking）

## W2b-disconnect [M]
行为：【rpc.ts】新增私有 `lost=false`、订阅集合 `lostHandlers`，常量 LOST='与后台服务的连接已断开'，公开方法 `onLost(h: (reason: string) => void)`。在 connect() 的 Promise 执行器里，紧跟 `this.ws = new WebSocket(url)`、和 onopen/onerror 同一处挂上 `this.ws.onclose = () => this.markLost()`。markLost 只生效一次：遍历 pending，逐个用 `{ error: { message: LOST } }` 结算后清空，再通知订阅者；onerror 和 onclose 连续触发也只通知一次。call() 的 sendNow 第一行加 `if (this.lost) return Promise.reject(new Error(LOST))`：不碰 ws，也不进 pending。握手期排队的 call 执行到 sendNow 时同样先判这一句。this.ready 仍在第一个 await 之前同步赋值，握手结构一行不动。不重连，也不重放（pi/ZCode 原则）。不按 readyState 判断。首次连接失败时，浏览器也会先 error 再 close，同样会进 lost，横幅能在首启失败时出现。
【store】state 加 `connection: 'ok' as 'ok' | 'lost'`。init() 在 `await rpc.connect()` 之前注册 `rpc.onLost(() => this.markConnectionLost())`。markConnectionLost 做这几件事：connection='lost'；running=false；runningSessions=[]；pendingPerms=[]（卡已无人接收，留着就是一排点了没反应的按钮）；retryNote=''；streamingThinking=''。保留 streamingText 和 messages，半截回复留给用户复制。不写 lastError，免得会话页红条和顶栏横幅说两遍。新 action `relaunchApp()`，桥访问形态照 chat.ts:386-390：`const b = (window as any).deskminis; if (typeof b?.relaunchApp === 'function') await b.relaunchApp(); else this.lastError = '无法自动重启，请手动退出并重新打开 DeskMinis';`。
【TopBar】在 40px 标题栏下方独立一行（标题栏右侧 146px 被系统 min/max/close 覆盖，横幅不能塞进那一行），渲染 `<div v-if="chat.connection === 'lost'" class="lost" role="alert">`。内容依次是 alert 图标、文案「与后台服务的连接已断开。进行中的任务可能已中止，新的操作不会执行。」、按钮 `<button class="f-btn primary" type="button" @click="chat.relaunchApp()">重启应用</button>`。横幅走正常流，不设 z-index；底色 --c-err-soft，字色 --c-err；按钮放在可交互区（no-drag）。
【Composer】canSend 加上 `chat.connection !== 'lost'`；断线后 running=false，停止键回到发送键，且发送键置灰。
改动点：
  - src/renderer/src/rpc.ts:4-13 加 `private lost = false`、`private lostHandlers = new Set<(r: string) => void>()`，以及 LOST 常量
  - src/renderer/src/rpc.ts:34-43 在 Promise 执行器内、`new WebSocket(url)` 之后加 `this.ws.onclose = () => this.markLost();`
  - src/renderer/src/rpc.ts:49-55 sendNow 首行加 lost 早退；新增 `onLost(h)` 与私有 `markLost()`（放在 on/off 旁，:60-68）
  - src/renderer/src/stores/chat.ts:94-95 附近的 state 加 connection
  - src/renderer/src/stores/chat.ts:129-130 init() 首行（await rpc.connect() 之前）注册 onLost
  - src/renderer/src/stores/chat.ts actions 层（4 空格缩进）新增 markConnectionLost()（store 内 this. 调用）与 relaunchApp()（TopBar 调用）
  - src/renderer/src/ui/TopBar.vue:27-49 在 header 后同级加横幅（多根组件，或外包一层 div）；:52-78 加 `.lost` 样式（不写 z-index）
  - src/renderer/src/ui/Composer.vue:33 canSend 改为 `(…) && chat.connection !== 'lost' && !chat.running && !sending.value`（新条件插在尾锚之前）
  - 【依赖 IPC 分区】src/preload/index.ts:5-32 暴露 `relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch')`；src/main/index.ts:166-200 附近加 `ipcMain.handle('app:relaunch', …)`（app.relaunch，并走 W1b 的优雅退出）
先红：
  - tests/rpc-disconnect.test.ts（新，roadmap 验收名）FakeWebSocket 版：照 renderer-rpc-connecting.test.ts:5-18 抄一个假 socket 并加 onclose 字段。① connect+open 后发两个 call，不回包，然后调 `ws.onclose!({})`，断言两者都 rejects.toThrow('与后台服务的连接已断开')，用 Promise.race 配 50ms 计时防挂。现在 RpcClient 不挂 onclose，ws.onclose 为 null，race 超时，所以会红
  - 同文件：断线后新 call 立即 reject，且 ws.sent 长度不变。现在 sendNow 会照常 send，promise 永不结算，所以会红
  - 同文件：`c.onLost(spy)` 后先后触发 onerror 与 onclose，spy 恰好调用 1 次。现在 onLost 不是函数，TypeError，所以会红
  - 同文件回归：握手期排队的 call 在 open 后仍补发（照 renderer-rpc-connecting 用例 2 的形态）。现在绿，改后必须仍绿
  - 同文件真 ws 版：`import { WebSocketServer } from 'ws'`，并 `globalThis.WebSocket = (await import('ws')).default`（ws 已在 dependencies，零新依赖）；window.deskminis.minisdInfo 返回服务端端口。服务端收到帧不回包，执行 `for (const s of wss.clients) s.terminate()` 后，1s 内 pending 被 reject。现在永不结算，所以会红
  - tests/renderer-disconnect.test.ts（新）store 行为：pinia + vi.mock rpc，桩为 `onLost: (h) => { lost = h }`。init() 后造 running=true、runningSessions=['A']、pendingPerms 一条，调 lost()，断言 connection==='lost'、running===false、runningSessions 与 pendingPerms 都为空。现在 chat.connection 是 undefined，所以会红
  - 同文件：relaunchApp 在 window.deskminis.relaunchApp 存在时调用它恰好一次；不存在时 lastError 含「手动」。现在没有这个 action，所以会红
  - 同文件源码守卫（认调用形态）：TopBar 匹配 `/v-if="chat\.connection === 'lost'"/`、`/@click="chat\.relaunchApp\(\)"/`，含「与后台服务的连接已断开」「重启应用」，`.lost` 规则块不含 z-index；Composer 匹配 `/&& chat\.connection !== 'lost' && !chat\.running && !sending\.value\)/`；store 匹配 `/rpc\.onLost\(\(\) => this\.markConnectionLost\(\)\)/`，且它的 indexOf 小于 `await rpc.connect()`；rpc.ts 匹配 `/this\.ws\.onclose = /`
守卫：
  - tests/renderer-permtier.test.ts:16 与 tests/renderer-model-groups.test.ts:15 的 rpc 桩没有 onLost，init() 新增调用后，permtier:57、:65 和 model-groups:62 三例会因 TypeError 变红。重指办法：两个桩各补 `onLost: vi.fn()`，断言不动
  - tests/renderer-first-send.test.ts:32 的 canSend 尾锚是 `&& !chat.running && !sending.value)`，新条件必须插在它前面，否则变红
  - tests/renderer-first-send.test.ts:25 逐字锚了 send() 入口早退行，不要往这行加 connection 判断（断线由 canSend 置灰，再由 chat.send 的 catch 交代）
  - tests/renderer-rpc-connecting.test.ts 三例必须保持绿，它们是握手结构的回归网
  - tests/mu6-capability-wiring.test.ts:144-150：markConnectionLost 须由 store 内 `this.markConnectionLost(` 调，relaunchApp 须由 ui/ 调
  - tests/renderer-titlebar-stacking.test.ts:81-93：横幅若写 z-index ≥50 会变红，所以不写 z-index
风险：
  - relaunch 与 W1b 的单实例锁、数据根锁：Electron 的 relauncher 会等父进程退出再起新实例；但如果旧 minisd 没有干净退出，数据根锁要靠「陈旧锁接管」。IPC 分区要在 xvfb 下验证重启后能握手
  - minisd 卡死但 socket 没断（事件循环阻塞）不会触发 onclose。W2b 没有心跳，这种情况仍会显示为「运行中」，留给 W6a/W6b
  - 断线时清掉 pendingPerms：如果只是连接被踢而 minisd 还活着，后端待批请求会在 90s（minisd/index.ts:87）后超时拒绝；横幅已经说明状态未知，可以接受
  - 断线后点 NavRail 会话会让 open() 里的 rpc.call 被拒，而 NavRail.vue:35 是 `void chat.open(id)`，会产生未处理拒绝（控制台 error）；属于可见噪音，不影响横幅
  - TopBar 改成多根组件：AppShell 传的 props/emit 不受影响，目前也没有 attrs 透传；如果改为外包 div，要确认 AppShell 的 .shell flex 列高度不变
  - dev 模式下 app.relaunch 不带 electron-vite dev server 参数，只影响开发

## W2b-permscope [M]
行为：PendingPerm 增加 `sessionId: string`，permission.request 处理器用 `sessionId: req.sessionId` 写入。新增纯模块 src/renderer/src/lib/perm/scope.ts，提供 `permsOf(perms, sessionId)` 与 `waitingSessionIds(perms): Set<string>`。
- StageChat：只渲染 `permsHere = computed(() => permsOf(chat.pendingPerms, chat.activeId))`；贴底 watch 改读 permsHere.value.length。
- TaskPanel 的「N 个请求等在对话里」与 WorkspacePanel 任务 tab 的点：改用当前会话的 permsOf。
- NavRail 会话行：`waiting = computed(() => waitingSessionIds(chat.pendingPerms))`，在 .srow 按钮内标题之后渲染 `<span v-if="waiting.has(s.id)" class="swait" title="有权限请求等你批准"><UiIcon name="shield" :size="13" /></span>`，样式 `.swait { color: var(--c-warn) }`，与 PermCard/TaskPanel 的「等你批准」用同一图标、同一令牌。当前会话行也显示（切到设置等视图时有用）。
- permission.resolved：先 find 出该卡的 sessionId 再摘卡；reason==='timeout' 只在该卡属于 activeId 时才往 eventNotes 补「权限请求已超时，自动拒绝」。
- 推荐一并做：StageChat 里若有其它会话的待批请求，显示一行「另有 N 个会话在等你批准」，点击 open 第一个。NavRail 收起或 compact 时看不到标记，没有这行的话卡会 90s 后被静默拒绝。
- 孤儿卡（sessionId 不在 chat.sessions 里）：推荐仍显示在当前会话，并在卡上注明「来源会话不在列表中」。
改动点：
  - src/renderer/src/stores/chat.ts:10 PendingPerm 加 `sessionId: string`
  - src/renderer/src/stores/chat.ts:155-161 push 对象加 `sessionId: req.sessionId`
  - src/renderer/src/stores/chat.ts:165-170 resolved：先 `const hit = this.pendingPerms.find(x => x.requestId === requestId)`，再保留原字样 `this.pendingPerms = this.pendingPerms.filter(`，超时条件改为 `reason === 'timeout' && hit?.sessionId === this.activeId`
  - 新文件 src/renderer/src/lib/perm/scope.ts
  - src/renderer/src/ui/StageChat.vue:158 watch 源改为 permsHere.value.length；:216-218 v-for 改 permsHere；EventNotes 之后加其它会话提示行
  - src/renderer/src/ui/NavRail.vue:20-21 旁加 waiting computed；:119-122 的 .srow 内在 .stitle 之后加 .swait；:284-289 附近加 .swait 样式
  - src/renderer/src/ui/TaskPanel.vue:62-66 改为 permsOf(chat.pendingPerms, chat.activeId)
  - src/renderer/src/ui/WorkspacePanel.vue:100 同上
先红：
  - tests/perm-session-scope.test.ts（新，roadmap 验收名）：pinia + vi.mock rpc，桩的 `on: (m, h) => handlers.set(m, h)` 捕获处理器。init() 后令 activeId='A'，派发 permission.request {requestId:'R1', req:{sessionId:'B', kind:'file-write', detail:'x', toolTitle:'t'}, meta:{timeoutMs:90000}}，断言 pendingPerms[0].sessionId === 'B'。现在不写 sessionId，所以会红
  - 同文件：再派发 permission.resolved {requestId:'R1', reason:'timeout'}，A 的 eventNotes 长度不变。现在无条件追加，所以会红。回归：卡属于 A 时仍追加「权限请求已超时，自动拒绝」且 retryable:false
  - 同文件纯模块：permsOf 过滤、waitingSessionIds 去重。模块不存在时 import 失败，所以会红
  - 同文件源码守卫：StageChat 匹配 `/v-for="p in permsHere"/` 与 `/permsOf\(chat\.pendingPerms, chat\.activeId\)/`，且不再含 `v-for="p in chat.pendingPerms"`；NavRail 匹配 `/waitingSessionIds\(chat\.pendingPerms\)/`、`/v-if="waiting\.has\(s\.id\)"/`、`name="shield"`，且 .swait 规则含 `var(--c-warn)`；TaskPanel 与 WorkspacePanel 不再含裸 `chat.pendingPerms.length`。现在全部不满足，所以会红
守卫：
  - tests/renderer-chat-capabilities.test.ts:23 `v-for="p in chat.pendingPerms"` 必然变红。重指为 `v-for="p in permsHere"`，再加 permsOf 调用形态
  - tests/renderer-shell-panels.test.ts:45 要求 TaskPanel 含 'pendingPerms'。改成 permsOf(chat.pendingPerms, …) 后仍含，不会红
  - tests/renderer-permcard.test.ts:134 要求 toContain('pendingPerms = this.pendingPerms.filter')，要保留这串字样。:136-138 要求 resolved 处理器在 timeout 判定之前不出现「已超时」，所以 find 取 sessionId 那段不能写文案。:129 要求 `reason === 'timeout'` 之后 400 字内出现 kind:'error'，条件加长后仍满足
  - tests/renderer-permcard.test.ts:157-160 逐字锚了 `preview?: { oldText: string; newText: string }` 与 `preview: req.preview`，别动这两处
  - tests/renderer-lost-entries.test.ts:26 锚了 `<div class="srw"[^>]*>\s*<button[^>]*class="srow"`，标记放进 .srow 按钮内部就不会红
风险：
  - NavRail compact（打开预览时 NavRail.vue:110 不渲染列表）或收起时看不到标记，需要 StageChat 的提示行兜底，否则其它会话的卡会在 90s 后被拒而无人知晓
  - 超时发生在非当前会话时，那条「已超时」留条会丢（eventNotes 是单会话缓冲，open 时清空）；留给 W6c 的 InteractionRegistry
  - 定时任务在跑 prompt 之前已广播 chat.sessions.changed（minisd/index.ts:1163），但 refreshSessions 是异步的，NavRail 标记可能晚一拍出现
  - 孤儿卡如果选择显示在当前会话，必须注明来源，否则又回到本条要修的串台

## W2b-runset [S]
行为：按会话维护运行集合，最小修法如下。
- 新 state `runningSessions: [] as string[]`（用数组，与现有状态风格一致）。
- chat.event 处理器在按 activeId 过滤之前，先调 `this.trackRun(sessionId, event)`：event.kind 为 turnEnd 或 error 时，把该会话移出集合；其它任何 kind（textDelta/thinkingDelta/toolStart/toolEnd/messagePersisted/retry/fallback/compacted/offloaded/pruned）都加入集合，幂等。非当前会话同样更新，synced 不参与。
- send() 在 chat.ts:447 置 running=true 时，同时把 activeId 加入集合；:456 的 catch 移出。
- open() 切换分支 :397 把 `this.running = false` 换成 `this.running = this.runningSessions.includes(id)`。切回仍在跑的会话时停止键可用，chat.cancel 按 sessionId 生效。
- 推荐加 `midRun`：切入正在跑的会话时置 true，StageChat 实时块显示「仍在运行（切换前的输出在本回合结束后显示）」，不渲染从中途接上的半截 streamingText/toolCards；turnEnd/error 时清掉。
- 可选：NavRail 给 runningSessions 画一个运行点。
改动点：
  - src/renderer/src/stores/chat.ts:95 旁加 state `runningSessions: [] as string[]`、`midRun: false`
  - src/renderer/src/stores/chat.ts:134-143 在 `if (sessionId === this.activeId)` 之前加 `this.trackRun(sessionId, event);`
  - src/renderer/src/stores/chat.ts actions 新增 trackRun(sessionId, e)（store 内 this. 调用，满足 mu6 自守）
  - src/renderer/src/stores/chat.ts:397 只替换 `this.running = false` 这一句，其余清零序列不动
  - src/renderer/src/stores/chat.ts:447 与 :456 维护集合
  - src/renderer/src/stores/chat.ts:519-537 turnEnd/error 分支清 midRun
  - src/renderer/src/ui/StageChat.vue:197-209 实时块加 midRun 占位
先红：
  - tests/perm-session-scope.test.ts（同文件，或独立 tests/renderer-run-tracking.test.ts）：捕获 chat.event 处理器，令 activeId='A'，派发 {sessionId:'B', event:{kind:'toolStart', toolUseId:'t', name:'file_write', title:'x', input:'{}'}}，断言 runningSessions 含 'B' 且 running 仍为 false
  - 同文件：rpc 桩对 chat.messages.list 回 []，然后 `await chat.open('B')`，断言 running === true。现在 open 会置 false，所以会红
  - 同文件：派发 B 的 {kind:'turnEnd', stopReason:'endTurn'} 与 {kind:'error', message:'已取消'}，两者都会把 B 移出集合
  - 同文件：send() 失败路径（chat.prompt 桩抛错）结束后集合里不残留 activeId
守卫：
  - tests/renderer-tasks-panel.test.ts:33-36 与 tests/renderer-eventnote.test.ts:104 锚了 open() 切换分支的清零序列：`this.lastError = ''; this.retryNote = ''` 要相邻，lastStopReason→eventNotes→fallbackState→compactedState→offloadedState→contextInfo 要按序。只替换 running 那一句就不会红
  - tests/renderer-thinking.test.ts:37-50 直接调单参的 store.onEvent(e)，所以 trackRun 放在处理器里，不改 onEvent 签名
  - tests/mu6-capability-wiring.test.ts:144-150：store 内必须有 `this.trackRun(` 调用
风险：
  - 渲染端重载后，集合只能从下一个事件开始重建：一个卡在长工具调用（期间没有事件）的会话会显示为未运行，直到 toolEnd；留给 W6b 快照
  - 切回中途的会话后，toolEnd 找不到对应的 toolCard，会被 chat.ts:509 忽略，属预期
  - 不做 midRun 的话，切回后流式区会从句子中间开始显示（不是假话，但截图难看）

## W2b-welcome [M]
行为：推荐方案要依赖 minisd 分区补一个 S 级 RPC：`chat.sessions.applyAssistant { sessionId, assistantId }`，assistantId 传 '' 表示解绑。后端规则：拒绝已有消息的会话和运行中的会话；语义定为「把这个空会话重置成 chat.sessions.create({assistantId}) 会得到的样子」，即 assistantId、modelBinding = a.modelBinding ?? undefined、技能覆盖先全清（setSessionOverride(…, null)）再按快照写；最后广播 chat.sessions.changed。

渲染端分六处：
1) welcomeAssistantId 的语义从「开局一次性选择」改为「当前空会话的助手选择，打开会话时从它已绑的助手初始化」：chat.ts:401 改为 `this.welcomeAssistantId = this.sessions.find(s => s.id === id)?.assistantId ?? ''`。这样 newSessionWithAssistant、StageAssistants 的「用它开始」（StageAssistants.vue:62）建出的空会话，回到欢迎页时卡片高亮和副标题都如实。
2) 新纯模块 src/renderer/src/lib/welcome/assistant.ts：`assistantToApply({ activeId, hasMessages, boundAssistantId, selected }): string | null`，null 表示不动，'' 表示解绑，id 表示套用；`previewBinding(…)` 给胶囊用，待套用时显示所选助手的绑定，所选助手无绑定或选择为空时显示默认。
3) Composer.send()：`if (!chat.activeId)` 建会话分支原样保留；新增 else 分支 `const want = assistantToApply(…)`，非 null 时 `await chat.applyAssistantToSession(chat.activeId, want)`，失败时 `chat.lastError = \`套用助手失败：…\`; return;`，文字留在输入框里。这个分支放在寄存草稿之前。
4) 贴图与选工作区两处隐式建会话改调新 store action `ensureSession()`：无会话时按 welcomeAssistantId 调 newSessionWithAssistant，否则调 newSession。
5) Composer 的 effectiveBinding 改用 previewBinding，发送前胶囊就显示发送后真正生效的模型。
6) AppShell.vue:50 的 inChat 不动；它的判据与 assistantToApply 的 hasMessages 一致，这一点写进纯模块注释。

备选方案（minisd 分区不加 RPC 时）：需要套用时新建一个绑定助手的会话再发，旧空会话留成孤儿；如果 atts 非空，必须拒发并提示「附件已存入当前会话，请先移除附件或取消选择助手」。
改动点：
  - src/renderer/src/stores/chat.ts:401 open() 从会话的 assistantId 初始化选择
  - src/renderer/src/stores/chat.ts:224-228 旁新 action applyAssistantToSession(id, assistantId)：`await rpc.call('chat.sessions.applyAssistant', { sessionId: id, assistantId })`，再 `await this.refreshSessions()`，再 `void this.refreshSkills()`
  - src/renderer/src/stores/chat.ts 新 action ensureSession()
  - 新文件 src/renderer/src/lib/welcome/assistant.ts
  - src/renderer/src/ui/Composer.vue:43-46 effectiveBinding 改用 previewBinding（modelView 行不动）
  - src/renderer/src/ui/Composer.vue:181-185 try 内改为 `await chat.ensureSession()`，catch 体逐字保留
  - src/renderer/src/ui/Composer.vue:225-234 加 else 分支
  - src/renderer/src/ui/WorkspacePanel.vue:34-36 删掉本地 ensureSession，改调 chat.ensureSession()
  - src/renderer/src/ui/StageWelcome.vue:52 文案保留（修完后属实）；:21-24 的 pick() 不变
  - 【依赖 minisd 分区】src/minisd/index.ts:467 旁新增 'chat.sessions.applyAssistant'
  - tests/mu6-capability-wiring.test.ts:62-82 的 WIRED 登记 `{ name: '空会话套用助手', action: 'applyAssistantToSession', rpc: 'chat.sessions.applyAssistant', where: 'Composer.vue' }`
先红：
  - tests/renderer-welcome-assistant.test.ts（新）纯模块：assistantToApply 的五种情况——activeId 为 '' 返回 null（交给建会话分支）；空会话、未绑、选 X 返回 'X'；已绑 X、选 X 返回 null；已绑 X、选 '' 返回 ''；hasMessages 为 true 返回 null。previewBinding 的四种组合。模块不存在，所以会红
  - 同文件 store 行为（pinia + mock rpc）：sessions=[{id:'E', assistantId:'X'}]，`await open('E')` 后 welcomeAssistantId === 'X'。现在被清成 ''，所以会红
  - 同文件：applyAssistantToSession('E','X') 调用 rpc('chat.sessions.applyAssistant', {sessionId:'E', assistantId:'X'})，随后调 chat.sessions.list；ensureSession 在 activeId=''、welcomeAssistantId='X' 时调 chat.sessions.create {assistantId:'X'}。现在都没有这些 action，所以会红
  - 同文件源码守卫：Composer 的 send 体匹配 `/assistantToApply\(/`、`/await chat\.applyAssistantToSession\(chat\.activeId, /`，且含「套用助手失败：」；Composer 与 WorkspacePanel 匹配 `/await chat\.ensureSession\(\)/`；Composer 不再含 `await chat.newSession()`。现在 Composer.vue:183 还有这句，所以会红
  - 【minisd 分区配套】tests/session-apply-assistant.test.ts：有消息时拒绝；解绑会清 assistantId、模型绑定和技能覆盖；成功时广播 chat.sessions.changed
守卫：
  - tests/renderer-model-groups.test.ts:178 逐字锚了 effectiveBinding 的三元式，必然变红。重指为 `previewBinding(` 调用形态，语义交给纯模块单测接住；:179-185（describeBinding(effectiveBinding.value…)、图标、title、label、bad）保持不变
  - tests/renderer-first-send.test.ts:44/:46 逐字锚了两处「新建会话失败」的 catch 体：新 else 分支用不同文案，不冲突；saveImages 改用 ensureSession 时，catch 体逐字保留
  - tests/renderer-first-send.test.ts:55-60 要求寄存先于清空，且 `await chat.send(...)` 后紧跟 takeDraft 判断：新 else 分支放在寄存之前，后半段不动
  - tests/renderer-assistants.test.ts:45 锚 `aria-pressed="chat.welcomeAssistantId === a.id"`：语义改成镜像会话绑定后，锚串不变，不会红；:61-62 仍满足
  - tests/mu6-capability-wiring.test.ts:91-96：WIRED 新登记要求 minisd 注册 'chat.sessions.applyAssistant'，后端没加就会红（跨分区依赖）；:144-150 由 Composer/WorkspacePanel 调新 action，满足
风险：
  - 跨分区依赖：RPC 不落地就得退到备选方案，附件与孤儿会话问题要重新评估
  - 空会话上手动设过模型绑定、再选助手时，这个绑定会被助手的绑定（或清空）覆盖；发送前胶囊已经预览出真实结果，可以接受，要写进 RPC 注释
  - welcomeAssistantId 语义变化会影响 Composer.vue:50-53 的 placeholder：绑了助手的非空会话里，输入框提示会变成「让 X 做点什么…」。这是真话，但属于可见变化，xvfb 要看
  - 会话 assistantId 指向已删除的助手时，镜像出来的 id 找不到对应助手，picked 为空、副标题回落通用文案，而 bound===selected 所以不会触发套用；行为正确，但要单测钉住
  - 标题：create 路径用助手名作标题（minisd/index.ts:471），因此不再自动命名；apply 路径是否改标题，需要和后端分区对齐

## W2b-modelbar [S]
行为：ModelBar（欢迎页那条）要明说自己管的是「默认模型」：
- .cur 胶囊里在模型名前加小标签 `<span class="clabel">默认模型</span>`；
- 整条加 title「默认模型：没有绑定模型的会话都用它；会话或助手绑定了模型时以绑定为准」；
- 右侧 provider 圆点的 title 改为「设为默认模型：名称 · 模型」；
- 更正 :7 的注释；
- :40 的 .cname 兜底文字不再用「默认模型」（标签已经表达了），改为 active?.name；
- :17 的 `|| items.value[0]?.id` 回落保持不动，它和 store、后端是同一策略。

输入卡胶囊在未绑定时显示「默认 · X」：推荐直接改纯模块 lib/models/binding.ts 的 default 分支，label 改为 `默认 · ${d.modelId || d.name}`（label 只有胶囊在用）；未配置任何模型时仍显示「未配置模型」。它与 W2b-welcome 的 previewBinding 叠加后：欢迎页选了无绑定的助手，胶囊显示「默认 · X」；选了有绑定的助手，显示它的模型名，不带前缀。
改动点：
  - src/renderer/src/lib/models/binding.ts:66-67 default 分支 label 加「默认 · 」前缀（title/short 不变）
  - src/renderer/src/ui/ModelBar.vue:1-9 头注释改成真话（:7）
  - src/renderer/src/ui/ModelBar.vue:37-41 .bar 加 title，.cur 内加 .clabel，:40 兜底改为 active?.name
  - src/renderer/src/ui/ModelBar.vue:43-49 dot 的 title 改为「设为默认模型：…」
  - src/renderer/src/ui/ModelBar.vue:71-77 加 .clabel 样式（--c-ink-3、--t-aux-size）
先红：
  - tests/models-binding.test.ts:41-48 先改期望：`describeBinding('', P, G, 'P2').label` 应为 '默认 · qwen3'，回落用例应为 '默认 · gpt-4o'。现在返回裸 'qwen3'，所以会红。:49-53 的「未配置模型」用例不变
  - tests/renderer-modelbar-default.test.ts（新源码守卫）：ModelBar.vue 匹配 `/<span class="clabel">默认模型<\/span>/`，.bar 的 title 含「以绑定为准」，不再含「下一条消息就用它」。现在没有标签，注释里有那句假话，所以会红
守卫：
  - tests/models-binding.test.ts:41-48 两例有意变红并重指，在提交正文里申报
  - tests/renderer-model-groups.test.ts:182 锚 `{{ modelView.label }}`，不变，保持绿
  - ModelBar 目前没有任何守卫（grep 零命中）
风险：
  - 胶囊 max-width 190px（Composer.vue:406），多出「默认 · 」后长模型名会更早省略；title 仍给全称
  - ModelBar 条本身是 overflow-x:auto，加标签后 provider 多时更早出现横向滚动

## W2a-overflow-ui [M]
行为：先与 W2a 引擎分区约定事件契约：LoopEvent 的 error 增加两个可选字段，`code?: 'context_overflow'` 和 `relaySummary?: string`（最新 marker 摘要，引擎侧截到 ≤8000 字）。渲染端对不带 code 的事件用 /上下文已满/ 兜底识别。

【store】error 分支：溢出时 eventNotes 写入 `{ kind:'error', detail, retryable:false, relay:true }`（原地重试必然再溢出，所以不给「重试」），并把 relaySummary 存进新 state `overflowRelay: null | { sessionId, summary? }`。非溢出分支保留 `retryable: true` 字面量。eventNotes 的类型加 `relay?: boolean`。

【文案】copy.ts 的 humanizeError 在 5xx 正则之前先认 /上下文已满|context_length_exceeded|prompt is too long/，返回「上下文已满」。

【EventNotes】加 `<button v-if="n.relay" class="rt relay" type="button" @click="chat.relayToNewSession()">新建会话接力</button>`，用品牌色，与红色重试钮区分。

【新 action relayToNewSession()】
1) 用纯函数 lib/relay/draft.ts 的 `buildRelayDraft({ title, summary, recentUserTexts })` 拼接力文本：摘要优先用 overflowRelay.summary，其次 compactedState.summary；都没有时只列最近 3 条真实用户请求原文，并如实写「没有可用的摘要」。总长封顶 6000 字。
2) 先 `rpc.call('chat.sessions.create', from.assistantId ? { assistantId } : {})` 拿到新 id。
3) 在 open 之前写 `this.relayDraft = { sessionId: s.id, text }`，再 refreshSessions、open(s.id)。
4) 原会话如果有自定义工作区（!workspaceIsDefault），对新会话 setWorkspace 同一路径；原会话手动设的模型绑定也照抄。
5) 失败时清掉 relayDraft，写 lastError「新建接力会话失败：…」。

【Composer】在 setup 顶层（与 takeDraft() 同处）调 `takeRelay()`：relayDraft 存在且 sessionId === chat.activeId 时才取，取完即清；输入框里已有字时，接力文本放在前面。只在 setup 时消费，不用 watch：新会话没有消息，AppShell 会从 StageChat 切到 StageWelcome，由新挂载的 hero 输入卡拿到草稿；旧的 StageChat 输入卡在 open() 的 await 期间还挂着，用 watch 的话它会先抢走草稿，然后随组件卸载丢掉。不自动发送，由用户确认后按 Enter。

【为什么不直接复用 chat.draft】takeDraft 的闸（Composer.vue:252）要求 lastError 非空，而 open() 换会话会清掉 lastError，接力草稿永远取不出来。放宽这道闸，又会让「发送中寄存」的草稿在首条消息乐观入列、欢迎页换成会话页时被新实例抢走，这正是 X 波设这道闸的原因。
改动点：
  - src/renderer/src/stores/chat.ts:106 eventNotes 类型在 retryable 之后加 `relay?: boolean`（kind 联合串不动）
  - src/renderer/src/stores/chat.ts:90-93 旁加 state `overflowRelay`、`relayDraft: null as null | { sessionId: string; text: string }`
  - src/renderer/src/stores/chat.ts:528-537 error 分支按 code 分流（非溢出分支逐字保留 `retryable: true`）
  - src/renderer/src/stores/chat.ts 新 action relayToNewSession()（由 EventNotes 调用）
  - 新文件 src/renderer/src/lib/relay/draft.ts（buildRelayDraft、recentUserTexts；跳过 toolResult 载体，判据同 StageChat.vue:53-56）
  - src/renderer/src/lib/eventnote/copy.ts:13-27 humanizeError 在 :23 的 5xx 正则之前加溢出识别
  - src/renderer/src/ui/EventNotes.vue:39 旁加接力钮；:62-67 加 .rt.relay 样式（--c-brand / --c-brand-ink）
  - src/renderer/src/ui/Composer.vue:260 旁调 takeRelay()；函数定义放在 quote() 之后，避开 first-send 守卫的 sendBody 切片
  - 【依赖 W2a 引擎分区】src/minisd/agent/loop.ts:27 的 error 变体加 code/relaySummary
先红：
  - tests/renderer-overflow-relay.test.ts（新）纯模块 buildRelayDraft：有摘要、无摘要（含「没有可用的摘要」）、超长截断 ≤6000、最近 3 条只取真实用户文本。模块不存在，所以会红
  - 同文件 store 行为：`onEvent({kind:'error', message:'上下文已满…', code:'context_overflow', relaySummary:'S'})` 后，eventNotes 末条 relay===true、retryable===false，overflowRelay.summary==='S'。现在溢出也给 retryable:true 且没有 relay，所以会红。普通 error 仍 retryable:true（回归）
  - 同文件：relayToNewSession 的 rpc 调用顺序是 chat.sessions.create → chat.sessions.list → chat.messages.list；桩在处理 chat.messages.list 时断言 relayDraft 已经是 {sessionId: 新 id, text 含 'S'}。原会话 workspaceIsDefault=false 时会对新会话调 workspace.set。现在没有这个 action，所以会红
  - tests/renderer-eventnote-copy.test.ts 追加一例：humanizeError('上下文已满（已用 512 / 200000）') === '上下文已满'。现在命中 5xx 正则返回「模型服务暂时不可用（512）」，实测会红
  - 同文件源码守卫：EventNotes 匹配 `/v-if="n\.relay"[^>]*@click="chat\.relayToNewSession\(\)"/`，且含「新建会话接力」；Composer 有 `function takeRelay(): void`，在 setup 顶层调用，函数体按 `chat.relayDraft.sessionId !== chat.activeId` 早退；store 里 `this.relayDraft = {` 出现在 relayToNewSession 体内的 `await this.open(` 之前
守卫：
  - tests/renderer-eventnote.test.ts:95 锚 `/e\.kind === 'error'[\s\S]*?kind: 'error'[\s\S]*?retryable: true/`：非溢出分支保留 `retryable: true` 字面量就不会红；:90 `retryable?: boolean`、:106-107 kind 联合串不动
  - tests/renderer-eventnote.test.ts:69-76 锚 EventNotes 的结构（ICONS/TONES/<details/retry），不变
  - tests/renderer-first-send.test.ts:20 的 sendBody 切到 `\nfunction quote(` 为止，takeRelay 要定义在 quote 之后；:52 锚 draft 类型逐字、:64 锚 takeDraft 闸逐字，走兄弟字段就都不动
  - tests/renderer-eventnote-copy.test.ts 现有 6 例：新分支放在 401/403/429 判定之后、5xx 之前，不受影响
  - tests/mu6-capability-wiring.test.ts:144-150：relayToNewSession 由 EventNotes 调，满足
风险：
  - 强依赖 W2a 的事件契约：如果 W2a 只给文案不给 code，渲染端只能靠正则兜底，文案一改就失效。要在 W2a 的 provider-overflow 测试里钉住 code 字段
  - relaySummary 体积：事件广播和草稿都会随之变大，引擎侧要封顶
  - 新会话默认继承 workspace.lastUsed（minisd/index.ts:457/468），不一定是原会话的工作区；不显式 setWorkspace，接力后 agent 就会在另一个目录里干活
  - W2a 降级到更大窗口的模型时，fallback 事件的 reason 会带「因上下文已满改用 X」，现有 chat.ts:540-549 能显示出来；但 eventCopy('fallback') 的短句固定是「已切换到备选模型」，可选改成读 reason

## open_questions
- Q: 重启应用的桥接名与主进程语义（IPC 分区负责实现）
  推荐: preload 暴露 `window.deskminis.relaunchApp(): Promise<void>`，走 ipcRenderer.invoke('app:relaunch')；主进程先 app.relaunch()，再走 W1b 的优雅退出（before-quit→close()，最多 5s），超时再 app.exit(0)。渲染端以 `typeof b?.relaunchApp === 'function'` 探测；探测不到时如实提示手动重启
  理由: 渲染端只设计调用形态，名字要两边对齐。直接 app.exit 会绕过 W1b 的收尾，还会与数据根锁、单实例锁打架
- Q: 断线通知用专门的 rpc.onLost(h)，还是借现有 rpc.on 挂一个伪事件名
  推荐: 用专门的 onLost，并给 renderer-permtier.test.ts:16、renderer-model-groups.test.ts:15 两个桩补 `onLost: vi.fn()`
  理由: API 显式，守卫好钉，也不会被服务端同名通知冒充；代价只是改两个测试桩，断言不动
- Q: 断线时是否清空 pendingPerms 和 streamingText
  推荐: 清 pendingPerms；保留 streamingText 和 messages
  理由: 卡片已经不可能被应答，留着就是一排点了没反应的按钮；半截回复没落库，留在屏上方便用户复制
- Q: 欢迎页修法：minisd 新增 chat.sessions.applyAssistant（空会话套用或解绑助手），还是渲染端新建一个绑定会话
  推荐: 新增 RPC（minisd 分区，规模 S），再配合渲染端 open() 从会话绑定初始化 welcomeAssistantId
  理由: 新建会话的做法会留下孤儿空会话、会让已贴附件失效（会话相对路径），还解决不了「取消选择要解绑」；后端零件（setAssistant、setModelBinding、setSessionOverride(null)）都已存在，无迁移
- Q: applyAssistant 是否像 create 路径那样把标题改成助手名
  推荐: 只在标题仍是默认值时改成助手名，与 minisd/index.ts:471 一致
  理由: 两条建出「绑定助手的空会话」的路径应该产出同样的会话，否则一条会自动命名、另一条不会
- Q: 接力草稿复用 chat.draft，还是新开兄弟字段 relayDraft
  推荐: 兄弟字段 relayDraft {sessionId, text}，仍用「store 寄存、输入卡 setup 时消费」的机制
  理由: takeDraft 的 lastError 闸（Composer.vue:252）在换会话后必然挡住接力草稿；放宽它会重新打开 X 波堵上的「发送中草稿被新实例抢走」；兄弟字段还能让 renderer-first-send 的两条逐字守卫（:52、:64）保持不动
- Q: 溢出事件与 W2a 的契约
  推荐: error 事件加 `code: 'context_overflow'` 和可选的 `relaySummary`（≤8000 字）；W2a 的 provider-overflow 测试钉住 code
  理由: 目前没有 RPC 能取到最新压缩摘要，渲染端只有 200 字截断版；只靠文案正则识别太脆
- Q: 切回仍在运行的会话时，是否用 midRun 占位替代中途接上的流式片段
  推荐: 做（规模 S）：显示「仍在运行（切换前的输出在本回合结束后显示）」，turnEnd 后由 open() 重取完整历史
  理由: 不做的话流式区会从句子中间开始显示；完整快照要到 W6b
- Q: NavRail 收起或 compact 时，其它会话的待批请求靠什么让用户看到
  推荐: StageChat 加一行「另有 N 个会话在等你批准」，点击跳过去；孤儿卡显示在当前会话，并注明来源会话不在列表中
  理由: NavRail.vue:110 在 compact 时不渲染会话列表，标记跟着消失；卡片 90s（minisd/index.ts:87）后会被静默拒绝，违背「失败都看得见」
- Q: 胶囊「默认 · X」改在纯模块 describeBinding 里，还是只在 Composer 模板里拼
  推荐: 改纯模块 lib/models/binding.ts:66-67，并重指 models-binding.test.ts:41-48
  理由: label 只有胶囊在消费（已 grep 确认），改在一处，语义由单测接住；在模板里拼会把判断再分叉一次，正是 Z2 收拢要避免的

## files
- src/renderer/src/rpc.ts
- src/renderer/src/stores/chat.ts
- src/renderer/src/ui/TopBar.vue
- src/renderer/src/ui/Composer.vue
- src/renderer/src/ui/StageChat.vue
- src/renderer/src/ui/NavRail.vue
- src/renderer/src/ui/TaskPanel.vue
- src/renderer/src/ui/WorkspacePanel.vue
- src/renderer/src/ui/EventNotes.vue
- src/renderer/src/ui/ModelBar.vue
- src/renderer/src/ui/StageWelcome.vue（只核对文案，预计不改）
- src/renderer/src/lib/models/binding.ts
- src/renderer/src/lib/eventnote/copy.ts
- src/renderer/src/lib/perm/scope.ts（新）
- src/renderer/src/lib/welcome/assistant.ts（新）
- src/renderer/src/lib/relay/draft.ts（新）
- tests/rpc-disconnect.test.ts（新）
- tests/renderer-disconnect.test.ts（新）
- tests/perm-session-scope.test.ts（新）
- tests/renderer-welcome-assistant.test.ts（新）
- tests/renderer-modelbar-default.test.ts（新）
- tests/renderer-overflow-relay.test.ts（新）
- tests/renderer-eventnote-copy.test.ts（追加一例）
- tests/models-binding.test.ts（:41-48 重指）
- tests/renderer-model-groups.test.ts（:15 桩补 onLost；:178 重指）
- tests/renderer-permtier.test.ts（:16 桩补 onLost）
- tests/renderer-chat-capabilities.test.ts（:23 重指）
- tests/mu6-capability-wiring.test.ts（WIRED 登记 applyAssistantToSession）
- 【跨分区依赖，不归本分区改】src/preload/index.ts、src/main/index.ts（app:relaunch）、src/minisd/index.ts（chat.sessions.applyAssistant）、src/minisd/agent/loop.ts（error 事件 code/relaySummary）

## xvfb
- 断线横幅：用 FakeProvider 发 `__tool__ file_write {"path":"<工作区外>","content":"x","tool_title":"写外部文件"}` 让回合挂在权限卡上，此时停止键可见。再按 `pgrep -P <app.process().pid> -f 'utility-sub-type=node.mojom.NodeService'` 杀掉 minisd。2s 内应看到：40px 标题栏下方独立一行出现「与后台服务的连接已断开…」和「重启应用」；输入卡回到发送键且置灰；权限卡消失。明暗主题各拍一张；窄窗（约 900px）下横幅不溢出，也不被右上系统按钮区遮住
- 点「重启应用」：应用进程退出并重启（playwright 侧 app 的 close 事件触发），新实例握手成功，数据根锁被正常接管（依赖 IPC 分区）
- 权限卡按会话区分：会话 A 挂着卡时新建或切到会话 B，B 的对话流里没有卡；B 的任务面板不显示「1 个请求等在对话里」，任务 tab 也没有点；NavRail 上 A 行有橙色盾牌标，B 行没有；StageChat 显示「另有 1 个会话在等你批准」。切回 A 后卡还在，停止键可用，点停止后回合结束（出现「已取消」），停止键复位
- 预览打开（NavRail 进入 compact）时其它会话有待批请求：提示行仍可见
- 定时任务：runNow 一个需要权限的任务，卡不出现在当前会话，NavRail 的「⏰」会话行出现标记
- 切回仍在跑的会话：显示 midRun 占位，不出现从句中接上的半截文字；回合结束后完整回复出现
- 欢迎页选助手：用 NavRail「新建会话」进入空会话，点一张助手卡，副标题、卡片高亮、输入卡胶囊都显示该助手的绑定（无绑定时显示「默认 · X」）。发送后看后端真相（数据根 minis.db 或 store 的 sessions[].assistantId），NavRail 行出现助手 emoji。另走两条路径：先贴图再选助手再发；先选助手再在工作区面板选目录再发。取消选择后发送，会话不带助手。在 StageAssistants「用它开始」后回到欢迎页，卡片应高亮
- ModelBar：欢迎页那条上有「默认模型」标签，悬停有「以绑定为准」的说明；输入卡胶囊在未绑定时显示「默认 · <模型名>」；会话绑到 provider 后变成不带前缀的模型名；长模型名在 190px 内正确省略
- 上下文已满（在 driver 目录给 mock-openai.mjs 加 /overflow 路由，回 400 context_length_exceeded，依赖 W2a）：事件条显示「上下文已满」，没有「重试」、有「新建会话接力」；点接力后进入新会话的欢迎页，输入框里预填接力文本、未发送；工作区与原会话相同；按 Enter 后正常回复