# 测试分档与环境要求

从仓库的 `deskminis/` 目录运行。测试通过项目自己的 Electron Node 模式执行，原生模块必须与 Electron ABI 一致。

## 默认档

`npm test` 执行默认全量。两条会写入真实系统剪贴板的往返用例默认跳过；剪贴板处理器的模拟执行器用例仍然执行。默认档不启用完整进程压力测试。

默认档仍包含下面两条真实剪贴板读取用例，保留真实桥管道与权限授权路径的覆盖。它们需要未锁屏、剪贴板可读的 Windows 桌面会话；锁屏或其它程序占用剪贴板时，读取可能失败。

| 测试文件（位于 `deskminis/tests/`） | 真实读取的检查 |
|---|---|
| `rpc.test.ts` | `permission.respond allow-session 且带 bridgeTriggers`：合并授权后经桥管道读取剪贴板，不再广播权限请求 |
| `bridge-minisd.test.ts` | `权限定域端到端`：首次读取触发授权，会话记忆使第二次读取不再询问 |

这两条用例继续默认运行，`DESKMINIS_TEST_CLIPBOARD` 开关只控制两条写入往返用例。读取失败时保留原日志，核对桌面会话与剪贴板可读性后记录复验结果；单独复验通过不能覆盖原失败，也不能仅凭复验通过断定是环境原因。

## 真实剪贴板档

在可用且未锁屏的 Windows 桌面会话中执行：

```powershell
$env:DESKMINIS_TEST_CLIPBOARD = '1'
npm test -- tests/bridge-handlers.test.ts tests/bridge-cli.test.ts
Remove-Item Env:DESKMINIS_TEST_CLIPBOARD
```

`npm run verify:windows -- --evidence <新的证据目录>` 在它的全量子进程中显式打开此开关。两条真实用例会短暂改写剪贴板，现有恢复逻辑只恢复文本；验收前应保存剪贴板中的图片、文件或其它格式。运行该档时不要同时使用剪贴板。默认档的两条真实读取用例仍须满足上节的桌面环境要求。

## 完整进程档

```powershell
$env:DESKMINIS_F09_FULL = '1'
npm test -- tests/proc-lifecycle-process.test.ts tests/proc-own-windows.test.ts
Remove-Item Env:DESKMINIS_F09_FULL
```

完整档覆盖 F09 默认省略的真实进程恢复与性能矩阵。修改子进程归属、启动器、强杀恢复、取消、超时、关停或打包内的进程控制后，以及正式发布验收前，必须运行。不要与其它真实进程验收同时运行。具体矩阵与限制见 [F09 规范](specs/2026-10-04-f09-process-lifecycle.md)。

## 已知受高负载影响的用例

以下清单来自 2026-10-07 质量审查及既有交付记录，不表示这些文件的所有失败都可归因于环境。用例保留原断言、超时和轮询参数，不设置自动重试；失败应保留原日志，再按同一提交、同一环境单独复验并记录结果。

| 测试文件（位于 `deskminis/tests/`） | 受影响的检查 |
|---|---|
| `run-recovery-process.test.ts` | 真实引擎与 shell 强杀、恢复时的握手和状态等待 |
| `crash-log-fork.test.ts` | fork 子进程崩溃日志落盘与退出等待 |
| `search-tools.test.ts` | 灾难性正则测试的事件循环计时断言 |
| `walk-scan.test.ts` | 大目录遍历期间的事件循环计时断言、中途取消的耗时断言（遍历的是仓库自己的 `node_modules`） |
| `convergence-pause.test.ts` | 对端断连、重连和暂停后的异步收敛等待 |
| `skill-zip-bomb.test.ts` | 大 ZIP 校验在负载下的执行时限 |
| `outbound-client.test.ts` | 真实 WebSocket 握手、保活和重连计时 |
| `sync-delete-e2e.test.ts` | 删除传播及保留副本的端到端收敛等待 |

一次完整任务交付仍须全量两遍、类型检查和构建。记录各次结果，区分已存在的失败、新增失败与未验证项；单独复验通过不能覆盖原全量失败。
