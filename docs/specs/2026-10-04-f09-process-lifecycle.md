# F09 进程树的生命周期（Windows 作业对象托管）

状态：已实现。适用：DeskMinis 引擎（minisd）为 shell、终端、stdio MCP 起的子进程。
验证范围：Windows 11（10.0.26200）x64。Windows 10、ARM64、32 位没有验证。

## 1. 解决的问题

引擎起子进程有三个入口：`shell_execute` 的常驻 PowerShell 驱动、终端抽屉的 PowerShell 驱动、stdio MCP 服务器。
以前只有正常取消与正常退出会收进程树（`taskkill /pid <根> /T /F`），留下两类残留：

- **引擎没有机会回收**：引擎崩溃、关停超时被主进程结束、主进程被结束。根（引擎的直接子进程）随运行时自带的作业结束，
  根再起的进程（shell 命令里起的 node、终端里的 dev server、`cmd.exe` 包裹下真正的 MCP 服务器）全部留下。
- **`taskkill /T` 找不到**：它按父进程号找后代，中间进程已经退出的（`cmd /c start`、启动器起完主程序就退出）收不到。

基线上的实测记录（四种情形 × 四个入口）在交付的 `证据\base\`。

## 2. 机制

**每棵进程树的根自己建一个不许脱离、带 `KILL_ON_JOB_CLOSE` 的作业对象并把自己放进去；作业句柄只在根进程里；
根同时握着引擎进程的句柄，引擎一结束就终止整个作业。** 引擎自己的作业关系不动。

| 入口 | 根是谁 | 何时归属 |
|---|---|---|
| shell | PowerShell 驱动 | 读到第一条命令之后、执行它之前 |
| 终端 | PowerShell 驱动 | 读到第一个字符之后、执行任何命令之前 |
| stdio MCP | 一个 PowerShell 启动器（launcher），它在作业里以挂起方式创建真正的服务器 | 读到引擎写来的放行行之后、起服务器之前 |

同一条规则：**根在读到引擎的第一份输入之前不建作业、不执行任何用户指定的程序；引擎只在 `spawn()` 返回之后才写输入。**
所以归属先于任何后代出生，没有「spawn 到归属之间」的竞态。

整棵树在三种情况下由内核回收，互相独立：

1. 根被结束（取消、超时、删会话、关停时的 `taskkill /T`，或根自己退出）→ 作业句柄关闭 → 作业里剩下的全部进程结束。
2. 引擎被结束 → 根里的监视线程等到引擎句柄触发 → `TerminateJobObject(作业, 197)`。
3. 引擎被结束 → 运行时的作业关闭 → 根被结束 → 回到第 1 条。

实现上没有新增依赖，也没有随包文件：用的是系统的 `<System32>\WindowsPowerShell\v1.0\powershell.exe`，
Win32 调用以 `Reflection.Emit` 在内存里定义 P/Invoke（不落盘、不起 `csc.exe`），脚本是打进 `out/main/minisd.js` 的字符串常量。
脚本是产品常量加一个数字（引擎 PID），不拼接任何输入；MCP 的目标命令行经环境变量传给启动器。

主进程被结束时：引擎每秒查一次属主（主进程）是否还在，连续 3 次不在就给自己发 `shutdown`，走与正常退出相同的有序关停
（了结权限卡、停 run、回收进程树、封账、关库、放数据目录锁）。

### 代码位置

| 文件 | 内容 |
|---|---|
| `src/shared/proc.ts` | 线上类型：`ProcTreeView`、`ProcSnapshot`、`ProcOwnershipStatus` 等 |
| `src/minisd/proc/own-script.ts` | 根脚本（归属前导 `armPs`、启动器 `launcherPs`）、标记行的解析与扫描 |
| `src/minisd/proc/owned.ts` | 归属层：`ProcSupervisor`、`OwnedTree`、`spawnCommandOwned`；状态机、停用、回退 |
| `src/minisd/proc/win-cmdline.ts` | `directCommand`、`winCommandLine`（与 Node 生成的命令行逐字相同） |
| `src/minisd/proc/parent-watch.ts` | 引擎的属主轮询、标准流静音 |
| `src/minisd/store/proc-ledger.ts` | 进程账本 `process_trees`、启动恢复关账、恢复文案 |
| `src/minisd/proc/win-exec.ts` | `ProcOpts.supervisor` 注入接缝；`killTree` 没有改 |

## 3. 状态与失败

根把归属结论经 stderr 的一行标记回报（`__MINIS_PROC__ job=armed watch=1 prejob=1 pid=… created=…`），引擎摘掉这一行，不进终端输出与 MCP 诊断。

- `protection = 'job'`：只在根自己报告 `job=armed watch=1`、且标记里的 pid 等于引擎手里的子进程时成立。
- `protection = 'none'`：没有托管，原因在 `protectionReason`（`not-windows`、`disabled`、`batch-target`、`no-marker`、
  `launcher-deadline`、`marker-invalid`、`no-owner-watch`、`exited-before-arm`、`arm-failed:<步>:<错误码>`、`launch-failed:<错误码>`、
  `launcher-not-released`、`fallback:<上面任一>` 等）。
- 状态只少报、不多报。归属建不起来时功能照常，按以前的方式启动与回收。
- 本次运行停用托管（`ProcOwnershipStatus.state = 'disabled'`）的四种情况：归属某一步失败（`arm-failed:…`）；带前导的根没出标记就自己退出
  （`root-exited-before-arm`，典型是脚本被拦）；连续两棵树等满 15 秒都没出标记（`arm-unresponsive`）；根误判属主已不在（`owner-check-misfired`，
  典型是系统时钟被往回拨）。停用只影响本次运行，重启应用重新尝试。
- MCP：启动器路径上的任何失败都回退到直起（以前的路径），报错文案不变。带路径的 `.bat` / `.cmd` 目标不经启动器。
- 总开关：环境变量 `DESKMINIS_PROC_OWNERSHIP=off`（或 `0` / `false`）。

查看状态：

- `proc.trees.snapshot`（只读 RPC）：本代未结束的树 + 最近结束的 50 棵；只有 PID、会话 id、服务器名与状态，没有命令文本与环境。
- `diagnostics.dryRun` 的 `checks.processOwnership`：停用或最近一棵没托管成时是 `warning` 并带原因。
- 停用时引擎告警一行，经主进程进按天日志。

## 4. 进程账本与恢复

表 `process_trees`（只在本机，不同步）：每棵树一行，记根的身份（PID 加创建时间）、托管状态、回收原因（`stop_cause`：
`cancel` / `timeout` / `session-deleted` / `shutdown` / `startup-failed` / `config-changed` / `idle-evicted` / `server-error` / `probe-done`）、
结束方式（`end_kind`：`exited` / `stopped` / `spawn-failed` / `engine-lost`），并与 F05 的代次、run 关联（`epoch`、`run_id`、`stop_run_id`）。
按会话归属的行随会话删除。

启动恢复：前代没关账的行关成 `stopped`（发起过回收）或 `engine-lost`，`reaped = 'job'`（当时受托管）或 `'unverified'`。
**恢复只写库：不结束任何进程、不按记录的 PID 做任何事、不起任何进程。**

F05 的「结果未知」调用：只有能唯一确定「这次调用跑在哪棵本机进程树上」时，结果文本后追加一句树的去向——
shell 取同会话引擎停止时还开着的最新一棵；MCP 要那次调用的资源声明（`named:mcp:<服务器名>`）与树的服务器名精确相等、
树不晚于调用开始、工具名与树的前缀相符。远端（HTTP）MCP 没有进程树，不加话。

## 5. 不在保证之内

- 经系统服务或代理创建的进程：提权启动、WMI / CIM、计划任务、Windows 服务、COM 进程外激活、交给资源管理器打开的文件。
- WSL、Docker、远程会话里的进程。
- 托管不可用的机器上的全部后代（行为同以前，状态如实）。
- 有意绕开的同用户程序：作业对象不是安全边界。
- 引擎进程挂死（没有退出，也不再响应）时：没有任何一条路会触发。
- 桥命令（`windows-open` 等）起的一次性 PowerShell 不在作业里：为用户打开的程序要活过应用。

## 6. 给后续任务的契约

- **G02（浏览器进程）**：用 `spawnCommandOwned`，`kind` 追加 `'browser'`（库里这一列是无约束的 TEXT）。约束：启动器只转交
  stdin / stdout / stderr 三个标准句柄（`--remote-debugging-pipe` 不可用，改用回环端口）；目标显式要求脱离作业会启动失败；
  树的寿命不超过引擎，也不超过它的根。
- **F06（快照）**：`ProcTreeView` 可以直接带进快照。
- **F08**：`process_trees.run_id` / `stop_run_id` / `epoch` 可用来判断结果未知的调用是否还可能在写文件；`RecoveryDeps.processNote` 可以换成更具体的说法。
- **F12（发布验收）**：对安装后的应用跑第 7 节的探针（`--host packaged`），通过口径见 `docs/RELEASE.md`。

## 7. 最小重现与取证

脚本 `deskminis/tests/proc-lifecycle-probe.ts`（vite-node 运行；只动自己起的进程，从不按进程名结束任何东西）：

```
<Electron Node 模式> node_modules/vite-node/vite-node.mjs tests/proc-lifecycle-probe.ts
  --host engine|gui|packaged [--app <DeskMinis.exe>]
  --scenario shutdown|cancel|engine-kill|main-kill|timeout|shutdown-kill|all
  --entry shell|terminal|mcp-abs|mcp-bare|all
  --evidence <目录> --expect record|clean [--stdio file|pipe] [--ownership off]
```

- 每格起一个引擎、一棵「根 → 子 → 孙」进程树（含 `detached` 的后代与父链已断的后代），外加一组无关的同名进程。
- 一个不在任何被测作业里的观察者进程握住每个进程的句柄，取内核记录的创建 / 退出时刻与是否在作业里；每个 fixture 进程每 100 ms 写一行心跳。
- 判定以触发回收的那个进程（根或引擎）由内核记录的退出时刻为锚点：「死了」只认句柄显示已退出；「还活着」要锚点之后又写了至少 10 行心跳、
  且到锚点之后 60 秒句柄仍未退出；其余是没有结论。
- 证据 JSON：进程树形状、每个进程的 PID / 父 PID / 映像名 / 创建时刻 / 是否在作业里 / 退出时刻 / 退出码 / 心跳、动作与锚点、
  引擎怎么结束的、无关进程是否都在、`process_trees` 的导出。
- 退出码：0 = 与 `--expect` 一致；1 = 有残留或误伤了无关进程；2 = 环境不满足或没有结论。
- `--ownership off` 重现没有托管时的行为。

用例分层（`deskminis/tests/`）：`proc-lifecycle-process.test.ts`（真实引擎）、`proc-own-windows.test.ts`（真机机制）、
`proc-owned.test.ts` / `proc-cmdline.test.ts` / `proc-ledger.test.ts` / `proc-recovery-note.test.ts` / `proc-wiring.test.ts`（各平台都跑）。
`DESKMINIS_F09_FULL=1` 打开全部真机用例（有序关停、结束主进程、关停超时、总开关、批量与快速起停）。

## 8. 本机实测的代价（Windows 11，x64；负载低时）

| 项 | 直起 | 托管 |
|---|---|---|
| shell 驱动的第一条命令 | p50 约 0.33 s | 首次约 0.83 s，p50 约 0.49 s |
| stdio MCP 从起进程到握手完成 | p50 约 0.11 s | p50 约 0.52 s |
| 每个 stdio MCP 连接常驻的启动器 | — | 工作集约 9–24 MB，私有字节约 64–71 MB |

## 9. 2026-10-05 续修整合与复核范围

整合基线 b5f6b4f（含 F03/F06/F08/F10A）。进程账本迁移追加在 [16]，user_version17；旧迁移保持不变。F08 检查点事实和 F09 进程说明分别兜错、独立追加到恢复结果，调用终态仍为结果未知；F06 有序事件与删除时的物理脱敏保留。对端删除留下保留副本时，进程行继续保留供显式恢复，但诊断快照不显示该会话的活动或已结束进程；隐藏期间也不新增行。

开发态与真实目录包各完成引擎强杀、主进程强杀 × shell/终端/MCP绝对路径/MCP裸名，共16格。树全部退出，无关同名进程保留，根均报告 job/watch 且观察者记录 inJob。开发态主进程退出到引擎退出24–29ms；目录包24–93ms，close_kind为空，不能据此声称走了属主轮询的有序关停。

常规 electron-builder 目录打包在 npm 依赖树收集阶段失败，本机没有npm；Electron Node模式调用CLI另有yargs把脚本路径视为参数的问题。验证包由现成普通Node、相同构建产物与依赖、相同配置在临时副本中生成；仅临时packageManager设为traversal以选用构建工具自带离线遍历。没有重编依赖，没有修改产品配置/清单，没有发布。方法记录位于 work/packaging-F09-codex-20261005/packaging-method.json。目录包证据能验证asar里的托管代码，不能代替常规npm打包链、NSIS安装包、签名或其它架构验证；后者留F12。临时副本的node_modules也是目录联接，不能递归删除它。

按用户选择，由当前Codex代理复核并记录限制，没有独立子代理审查。新增保留副本快照先红回归及三种文件/进程恢复说明组合故障用例。最终测试、变异与补丁结果以交付/F09中的记录为准。

## 10. 2026-10-06 迟到连接与列表的复核修复

自复核确认了三组会绕过回收的窗口：连接与列工具尚未落定时关停；共享连接一次列工具失败后另一份列表迟到；空闲驱逐或服务器退出之后列表迟到。McpManager 在连接起跑时保留 client 句柄，关停当场回收它，各断开路径递增代次，旧结果不再注册或覆盖新连接。stdio 在起根/等 launcher 标记时保留起根 promise；dispose 等自己的根交回后回收一次，已关闭的连接不再启动或发 initialize。回收等待仍受既有 shutdownReap 总上限约束。

六条带闸门回归在修复前全部失败，修复后通过；另两条空闲/退出路径先红、修复后通过。七个 MCP/关停测试文件最终141条通过；未放宽旧断言。此轮完整 R 档40条通过（1040秒），完整 P 档10条通过（157秒），R在本节修复之前，最终覆盖以交付记录为准。P10：托管 shell 首次/95分位1696ms，中位715ms；托管 MCP 首次638ms、中位585ms、95分位640ms；launcher工作集8642560字节、私有字节70901760，低于设计门槛3秒/100MB。

第9节开发态/目录包16格与asar字节匹配是上一实现头40d61b6的证据。本文新增源码修复之后需要重新构建目录包与复验，不能把上一包称为最终实现。标准npm收集链、签名、安装包、其它架构的限制继续保留。复核由当前Codex代理完成，没有独立审查者。

## 11. 2026-10-06 变异复跑与环境差分

首轮变异的M15b确实存活：继承的PSModulePath等于PowerShell默认值，没有测试出恢复步骤删除。其余后段从M18真实进程测试开始出现无JSON结果，M19以后测试进程以0xC000026B退出（窗口站关闭时初始化失败）；这些旧结果不能计作通过或变异存活。源码逐项复原、git干净，原记录保留。重跑检查器单独目录F09-codex-r2；记录stdout/stderr和进程状态，清掉旧JSON再执行，零匹配用例/文件级错误/环境失败/无JSON都为INCONCLUSIVE并立即停止、先复原源码。

增强P2：整份环境相等的旧断言保留；两边的fixture显式指定RunAsInvoker兼容标志，并分别指定自定义、空PSModulePath，使用宿主实际变量名大小写避免夹具重复键。原launcher漏传兼容标志已复现；旧.NET SetEnvironmentVariable的空字符串删除语义会混淆空值与缺失。launcher现在只在自己的进程环境里经现有内存P/Invoke机制调用SetEnvironmentVariableW，恢复PSModulePath和__COMPAT_LAYER，空值强制为非null的空字符串。缺失仍传null，六个内部MINIS_OWN变量全部删除，目标环境与直接启动一致。未改变用户或系统环境、未添加native依赖。P2真实差分和U3/U8共12条通过，完整后续验证以交付记录为准。

依据：https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55 、https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/9.0/empty-env-variable 、https://learn.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-setenvironmentvariablew 。

P2后续补强：当前Windows PowerShell对自定义PSModulePath可能原样保留，因此第二次删除恢复步骤仍存活，不能算检查完成。P2另外起一台真实宿主，在测试用的spawn包装层仅把PSModulePath改成固定合成值，随后继续执行实际launcher；正常宿主的整份环境相等、参数与退出码差分仍保持。该注入宿主再测自定义值/空值、断言job而非回退。原删除恢复变异与把native调用改回旧.NET调用分别检查原值和空值；去掉显式字符串转换在此PowerShell绑定器下是等价变异，改用会改变空值行为的旧.NET API回退。重跑目录F09-codex-r3保留前两轮证据，按最新有效结果判断。

## 12. 2026-10-06 全量中的M8夹具前提

第一遍最终全量395文件/6595用例，6551通过、43跳过、仅F05 M8失败：它期望HTTP MCP连接直到启动超时都不响应关停，实际F09在disposeAll中回收在途client，使握手及时取消，run已为cancelled。主干对照M8通过，F09单独重跑同样在starting预期处失败；这不是负载失败或产品缺失回收。

M8现明确注入不响应dispose的HTTP client，仍保持原先starting/interrupted/shutdown-timeout/同ID重试/无关闭后写库的全部断言；新增M8a走实际HTTP握手，在50ms关停时限内取消，重启不恢复虚假中断，同ID重试只产生一条user消息。整个F05生产链路测试27条通过；M37删除pending client回收，再由mock及实际HTTP两种用例判红并复原。此轮只调整测试和契约，产品源码与717537c完全相同。最终验证重新在新的本地快照上执行；前一次全量失败和其余旧结果保留在独立历史目录。
