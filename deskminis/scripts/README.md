# 验收脚本

从仓库内的 `deskminis/` 目录运行下列 npm 入口。它们独立于默认 `npm test`；先按
[构建说明](../../docs/RELEASE.md#1-构建) 准备 Windows x64 环境与依赖，并执行 `npm run build`。
M5 还需要实际打包产物。测试分档见 [测试说明](../../docs/TESTING.md)。

本次仅核对源码：以下入口均未实际运行，**未验证当前版本能否运行**。
历史验收记录只适用于当时的源码与环境。尤其 M3a/M3b 仍使用旧的 PASETO 远端连接写法，
本说明不把它们当作当前加密同步或双真实设备验收已通过的证据。

| npm 入口 | 用途 | 真实模型 | 前置条件、数据与副作用 |
|---|---|---|---|
| `npm run e2e` | 基础 Agent、工具调用、权限与文件落盘 | 需要有效的模型配置与凭据 | 默认直接用正式数据根，保留验收会话；运行前退出占用该根的应用。可用环境变量改数据根，空目录需先配置模型。 |
| `npm run e2e:m2b` | 坏密钥主模型降级到有效备选、模型绑定与重启持久化 | 需要有效备选，另造无效密钥主模型 | 默认用正式数据根；创建测试模型组与主模型，收尾尝试删除，验收会话保留。退出占用该根的应用。 |
| `npm run e2e:m2a` | 记忆注入、写入/检索、会话记忆开关、大结果卸载 | 需要 | 自建临时根，固定从正式根复制 `providers.json`，使用系统凭据；不通过此脚本实测长窗口压缩。 |
| `npm run e2e:m2c` | 技能写入、重启后发现、技能读取与使用计数 | 需要 | 自建临时根，固定复制正式模型配置，使用系统凭据；自动回答测试权限卡，斜杠菜单需另行验收。 |
| `npm run e2e:m2e` | 六类 Windows 桥、权限事件与真实系统操作 | 需要 | 自建临时根，固定复制正式模型配置；需要可访问桌面的 Windows 会话，会写剪贴板、截图、通知、打开目录和发声。只保存/尝试恢复剪贴板文本，不能保留图片等其它格式。 |
| `npm run e2e:m3a` | 同机回环上的配对、远端业务/广播与权限边界 | 不需要，使用模拟 provider | 临时数据根、内存凭据与回环监听；旧 PASETO 连接路径的兼容性未验证。 |
| `npm run e2e:m3b` | 同机双实例的消息/压缩记录同步与上下文一致性 | 不需要，使用模拟 provider | 两个临时根与内存凭据；会直接加载 `better-sqlite3`。必须用此 npm 入口的 Electron Node 模式，不能直接换成普通 Node；旧 PASETO 路径未验证。 |
| `npm run e2e:mcp` | 真实 stdio 夹具、MCP 配置/调用、批准/拒绝、会话禁用与试连 | 不需要，使用模拟 provider | 自建临时根与内存凭据，需要 `tests/mcp-stdio-server.mjs`；脚本自动回答测试权限卡，会启动真实夹具子进程。 |
| `npm run e2e:m5` | 包构成、原生 ABI、随包垫片、含空格路径与临时安装 | 不需要 | 先生成 `dist/win-unpacked` 和/或版本匹配的 NSIS 安装器；有安装器时会实际安装并卸载测试包。需无正式安装和 DeskMinis 进程的隔离 Windows 环境，保护检查不通过会拒绝安装/卸载。 |

## 数据与凭据

`e2e`、`e2e:m2b` 绕过主进程，默认根是 `%APPDATA%\DeskMinis`，默认凭据服务名也是 `DeskMinis`。
要使用 dev 已配置的数据与凭据，两个变量都要设置：

```powershell
$env:DESKMINIS_DATA_DIR = Join-Path $env:APPDATA 'DeskMinis-dev'
$env:DESKMINIS_KEYRING_SERVICE = 'DeskMinis-dev'
npm run e2e
```

`e2e:m2a`、`e2e:m2c`、`e2e:m2e` 会自行创建数据根，并固定从 `%APPDATA%\DeskMinis\providers.json`
复制配置；设置 `DESKMINIS_DATA_DIR` 不会改变这份配置的来源。需要按配置中的 provider id 在相应凭据服务下准备有效密钥。
临时根隔离会话和文件，不隔离模型费用或 Windows 桥对桌面的操作。

## M5 产物与安装

目录包可用 `npm run dist:dir` 生成，安装器用 `npm run dist` 生成。脚本默认读 `dist/`；
其它产物位置可设 `DESKMINIS_M5_UNPACKED`（目录包根）与 `DESKMINIS_M5_SETUP`（安装器路径）。
设置 `DESKMINIS_M5_PROBE_DIR` 后还会调用包内 utilityProcess 行为探针并保存证据。

安装与卸载前会检查安装登记、运行进程及本次目录归属。失败时以输出的具体原因和保留目录为准；
完整运行和收尾方法见 [发布检查单第 2 节](../../docs/RELEASE.md#2-打包验收与发版冒烟自动断言)。
当前发布的统一留证入口为 `npm run verify:windows -- --evidence <新目录>`，详见该发布检查单。
