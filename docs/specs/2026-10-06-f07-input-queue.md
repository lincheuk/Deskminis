# F07 运行中插话与排队消息：实施契约

实现base为59baa7994b1b9811366a08eef81f0750fcc57d39，分支codex/f07。依赖F06 ac5dd9b、F13 c08a8a6以及已合入的F03/F04/F05/F08/F11B/F09契约。按用户选择由当前代理复核，实现与复核不具备独立性。验证状态以交付审核提交与原始日志为准。

## 1. 行为和时机

steer是当前run的补充输入，不取消或重启run；在下一正常模型回合前写入原始历史。工具批、锁等待和审批等待都须等整批落定。插话不答复、撤销或延期权限卡。queue在当前run成功收尾且F05运行槽已释放后作为下一run的首条消息，FIFO，一次一条。

流式期间有steer、模型自然答完无工具调用时，保留已完成回答，在同一run进入下一回合，避免直接结束丢输入。透明重试、故障fallback内部不是投递点，重发既有请求；新输入继续pending。F03发生context_rejected至下一次成功流完模型请求之间，单独defer标志禁止写入新原消息，不依赖可能因fallback被清空的incident。

每个正常边界最多接2条纯文本steer；本run尚未确认交给provider的已写入输入总数不超过3。队列首条含附件且尚未确认时不接steer，保持当前轮图片能力选择和原有图片老化语义。超过限额的输入仍pending，下一边界继续。耗尽回合、失败、停止、关停时未写入输入held；已写入但未确认保持事实，不重新append或自动补发。

queue成功后继续FIFO；失败/取消后暂停全部未写入输入。held队首阻挡后来的queue，只能用户resume或cancel放行。重启只恢复展示，不补跑。未赶上当前run的steer转held，需要显式继续作为queue，不能悄悄变成新run。普通chat.prompt保留旧协议；有未消费queue时明确拒绝插队，界面提示继续或取消队列。定时任务仍新建独立会话，沿用现有入口。

## 2. 持久状态

迁移在已合入的末尾追加session_inputs；现为[17]/user_version18，原[0..16]哈希不变。全局自增seq给出顺序，UNIQUE(session_id,input_id)；字段含模式、原text、附件相对路径JSON、发送参数的规范JSON及digest、绑定run_id、history_message_id、状态、原因、创建/变更时间、请求回执时刻。无密钥或provider配置副本；不进同步。输入正文和附件引用随purgeSessionRows物理删除。

| 状态 | 事实 | 可操作 |
|---|---|---|
| pending | 已被引擎持久接收，尚未选中 | cancel |
| starting | queue已被同步claim，正在起run，尚未写历史 | 停止run，不能当待发送行cancel |
| admitted | 一条历史消息已原子写入，未确认交给provider | 展示送达未确认，不能再append |
| delivered | 完整输入随实际请求交给provider | 展示已交给模型请求，不能承诺服务端处理 |
| held | 未写历史，因取消/失败/重启暂停 | resume或cancel |
| cancelled | 用户取消未写入行 | 终态，不能因同ID重发复活 |

messageId为1–64的字母数字点下划线短横线，唯一性按会话。同ID且规范内容相同返回原行，内容不同明确报冲突；去重行不按短TTL删掉。每会话最多20条尚未消费输入，超限拒收并还草稿。新inbox正文上限128Ki字符，避免持久队列无限放大；旧chat.prompt没有显式正文上限，保持既有行为。列表返回全部pending/starting/held和admitted未确认行及最近100条delivered/cancelled终态；完整去重行仍在库中，可按ID查outcomes，不因列表裁剪复活。

InputQueueStore持有同一SQLite连接。写入前查chat.isDeleted，隐藏保留副本也拒写；快照/list/outcomes均过滤隐藏会话。对端删除保留副本时未写入行held，恢复后仍需显式resume。物理删除同时清输入行，新进程或晚到回调不能重建。正文不写审计/诊断日志。

## 3. 原子性和单run

不能把RunLedger.beginRun放进另一个可回滚Store事务：它事务结束后更新内存active，外层回滚会留下假占位。queue kick同步将pending队首claim为starting，产生内部claim令牌，再调用rawChatPrompt的内部第四参数；beginRun失败时同步解除claim并held。beginRun返回后立即绑定runId；全过程无await/广播间隙。若中途进程崩溃，启动将没有历史的starting转held。

rawChatPrompt占位与ensureForRun保持现有顺序。run.started回调里把唯一user消息写入，并以seq/claim/runId/state条件将输入admitted；条件失效抛错，消息和run.started事务一起回滚。取消pending与claim都是同步条件更新，先发生者获胜；starting只能按绑定run停止。旧claim的迟到处理不能碰恢复/重开的行。

steer在轮首统一事务逐条append并markAdmitted，时间由现有MonotonicClock.next递增，不复写旧历史。写入失败不发虚假广播，不重复执行已有工具；禁用本会话本轮自动kick并显示未送达事实，原输入保留供后续核对。关停关闭Store后所有晚到观察回调空操作，写历史入口仍由run租约和删除/取消守卫拒绝。

## 4. 请求来源和送达证据

不用锚点之后的ID集合或字符串包含查找。F03会把锚点前最近3条原話拼成带序号的新text part；同文本不同ID也必须能区分。新增内部provenance模块以WeakMap给原始用户part登记messageId、part序号和总数，不增加AgentMessage/请求JSON字段。

toAgentMessage先按每条原消息克隆用户part再登记，避免两个原消息共享part对象时串编号；summaryMessage对完整userTurnText合成part登记覆盖的原text序号，只有确实原样保留才登记；synthesizeImageData成功读图并转imageData时传递原mediaRef来源。媒体省略、文件丢失、能力占位都不传递覆盖。pairToolResults合并时保留原part；flatten若给完整文本加分隔换行，明确传递其完整来源，截断时绝不传递。现有trim只修改toolResult，保留用户parts。slotReq.messages覆盖同一输入全部序号才具备交给请求的证据。

回执时机：先获取原provider迭代器并调用第一次next，等待它成功返回第一项或正常结束后，再同步持久markDelivered并广播；不在调用provider之前或仅创建尚未开始的异步迭代器时落回执。起迭代失败/首项前抛错/已经abort不记送达。网络错误无法证明端点是否处理，admitted文案如实保留送达未确认；delivered文案只指交给模型请求，不承诺服务端处理。回执存储/广播观察口失败不能使已经启动的provider重试或引发重复副作用，保持admitted/未确认并显示限制。包装器须正确转发next/return/throw，finally关闭原迭代器；没有inbox时沿用原for-await路径。

已写入未确认的旧输入在随后普通请求中若确实完整出现，可以补真实回执；不重新append、不自动重发单条。来源证明必须由实际请求结构和三个协议构建器测试验证，不能只检查字段。

## 5. RPC、快照与重连

新增chat.input.send/list/cancel/resume；mode steer带当前runId，陈旧或不存在时明确拒绝。queue不需要活动run，闲时按FIFO起跑。输入参数只含原正文、相对附件与已有模型/输出偏好参数，统一沿用chat.prompt校验。内部claim参数不可从RPC注入。

新广播chat.inputs.changed带顶层sessionId和该会话列表，状态先持久提交、发布之间无await。StateSnapshot.inputs同步读取，coveredBySnapshot包含新整体替换广播。F06 eventSessionId必须能识别它，删除钩子物理脱敏，晚到隐藏载荷再滤。WriteRef增加kind=input；state.outcomes按sessionId/messageId查持久行，accepted返回事实，未接收明确返回not-accepted，删除会话统一拒绝。

在途send丢应答不自动重发；renderer保留同ID和原规范载荷的inDoubt引用，重连outcomes核对。not-accepted草稿全部按会话保留，显式取回未改的草稿沿用同ID/原规范载荷；改字、模式、附件或steer runId则使用新ID。not-accepted允许显式同ID重试；accepted使用当前行。cancel/resume丢应答按当前列表核对。list/send/cancel/resume和outcomes的应答均核对会话生命周期和引擎epoch；旧epoch的send只登记待核对，outcomes转向当前引擎重新查询，队列操作转向当前列表。后台队列可更新原会话事实，但不改换走后的活动对话缓冲。Stop广播绑定原runId，历史摘要标为“停止记录”，避免误称新run已停止。队列写入历史时刷新当前会话原子快照，历史加尾巴保持正确位置。

四个方法沿用已有认证/远程业务守卫，每次复查配对。没有额外授权路径，不能让插话、重连或resume代答审批。

## 6. 停止、助手与配置

chat.cancel可选runId；先核对它再了结卡片/abort，陈旧停止不得击中queue新run。运行态不能切助手保持原规则；无历史但有待发送输入也阻止切助手，避免旧稿所称“必已有消息”的错误假设。取消队列后可按原规则切换。steer使用当前run已选槽位；queue实际起跑时读当前模型绑定，界面写明。配置删除导致起跑校验失败则held，不自动连发错误。

停止摘要仅用本次run F05 executions：已开始、未启动、结果未知、是否可能有副作用。停止不回滚已产生改动，F08检查点另行展示。摘要应按请求runId核对，不把新run记录算给旧停止。

## 7. 界面

Composer继续允许运行中编辑；保留停止键，文本有内容时显示“补充指示”和“排队”。Enter默认steer、Ctrl+Enter queue，带附件时只能queue；菜单候选优先，IME组合输入不发送。断线/发送重入闸与现有草稿恢复保持。按钮旁说明等当前流或工具批落定，审批仍须独立答复。runId尚未同步时steer不可用，queue仍可用。

StageChat输入框上方InputQueue列出模式、顺序、文本预览、实际状态与cancel/resume。starting明确正在起跑；admitted明确“已写入对话，送达未确认”；delivered为“已交给模型请求”，不能写服务端已处理。held显示具体原因。取消只用于pending/held；starting使用停止当前run。暂停后resume是明确用户动作，不默认选中后自动提交。

## 8. 验证矩阵与变异

| 组 | 必须证明的行为 |
|---|---|
| S 存储 | 同ID相同返回同一行/不同冲突，seq保序，20上限，pending取消/claim竞争，原子append失败回滚，starting/admitted启动恢复，删除/保留副本隐藏/恢复 |
| L 循环 | 四种等待各发送steer，下一安全请求完整一次；两条steer顺序；超过3条按边界分批；正常无工具回答期间补充不丢；截断/空响应/fallback/重试；context恢复I7守卫 |
| Q 起跑 | 两queue FIFO，各一个run；取消queue不启动；失败/取消held阻挡；starting迟到不能取消成假pending；关停/重启不补跑；助手与模型变化；同ID重试至多一条历史 |
| P 请求 | 同文本不同ID、紧锚原话、媒体变换/丢失/占位、tool配对/flatten/trim；三个实际协议构建器看到原内容；同步起迭代失败不记回执；回执失败不重复请求 |
| R 权限 | 审批等待插话不授权/延期；停止未开始工具不execute；已开始/未知副作用事实；陈旧runId停止不影响新run；锁等待时边界不抢跑 |
| F 快照 | 重载/重启/断线丢应答、重复广播/乱序/旧水位、删会话物理脱敏、保留副本/晚到send/list、outcomes同ID核对 |
| U 实际界面 | 运行中输入、两种按钮/Enter菜单与IME、队列状态/cancel/resume、草稿错误恢复、送达回执、换会话、停止摘要；真实截图留证 |

有意义的变异至少覆盖：同ID重复append、digest不核对、取消仍claim、两个queue同跑、失败自动续发、重启自动补跑、恢复期插入、锚点/字符串伪造回执、provider调用前回执、缺媒体标完成、来源泄漏、观察口失败重复请求、插话答审批、陈旧停止命中新run、删除/快照脱敏缺失、迟到应答改当前视图。先红/故障注入记录和源码复原证据独立保留。

## 9. 实施与交付闸门

F09验收并合入后核对实际base/迁移，创建F07隔离worktree。先存储/起跑/循环负例，再接请求来源、F06及renderer；全链路复核明确问题全部收口。每任务1本地提交，LOCAL (not upstream)身份；补丁含设计/契约/必要测试，证据分开。tsc/build、相关测试、两遍全量、实际UI截图和变异完成后才合入。未真实调用模型端点时如实记录使用结构化假provider与真实协议构建器，不能把它称为在线模型确认。

无新增依赖，无推送/发版，不改正式数据，不使用子代理。旧未完成方案作为历史保留；本稿修订了其锚点回执、无限批插话、恢复期写入、回执提前、起跑取消和空会话切助手等缺口。

## 10. 实施复核补充（2026-10-06）

- 不使用旧promptId给queue去重：inbox messageId按完整规范载荷持久去重，内部claim独立传递，F05仍各新建一轮run，避免两个编号域碰撞。
- 输入updatedAt采用数据库已存最大值加至少1微秒与当前时钟的最大值，保证同一时钟tick/时钟后退时旧send应答不能覆盖新回执。
- 原有欢迎页套用助手分支仅在空闲且没有pending/starting/held输入时调用；分支体和失败还草稿行为保留，并更新原源码回归守卫。
- 收件面板展示全部未解决输入和最近3条已交给请求的记录，最高220px可滚动；窄窗口控制行可换行，420/600/960px均留有输入框和Stop。
- Stop的“已开始”指F05 execute入口已开始，包含正在等审批的工具，不等于已写文件。真实用例分别证明未批准无写入、已批准写入仍在、下一未开始工具不执行。未知结果只按账本说明，不宣称回滚。
- 产品运行时不调用在线模型进行核验；delivered只证明完整输入进入实际provider请求且迭代器首项成功，文案“已交给完整模型请求”，不保证服务端已执行。
- 实际Vue组件在无头Chrome检查，RPC受控；真实RpcClient/HTTP/SQLite/引擎故障恢复另由集成用例证明。未做双真实设备、在线API或本项Electron窗口人工验收。
