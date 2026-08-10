# DeskMinis MU6（能力接线）实施计划

> 状态：**评审通过（2026-08-10）**，两处决策见 §2-1 / §2-4。基线 main@97d864f（MU5 已合并，1058 测试 / 99 文件）。
> 性质：**纯 renderer**，`src/minisd` / `src/main` / `src/preload` 三目录零改动、零新依赖。
> 承接：[MU4 废止说明](2026-08-10-mu4-capability-surfacing.md) 与 [MU5 §9](2026-08-10-mu5-workbench-layout.md)。
> 用户原话（2026-08-10）：「现在很多都是后端冗余很多功能，但是前端没有体现」。

## §0 事实核实（本轮重新数过，与此前记载不同）

在 main@97d864f 上全目录枚举 `src/minisd` 的注册方法，再逐个在 `src/renderer` 全文搜引用：

**已注册 45 个方法，其中 24 个渲染端零引用。**

此前记载是「33 个 RPC / 15 个零引用」——那次只数了 `index.ts`，**漏了 `remote/` 与 `sync/` 两个模块**。以本轮为准。

### 0-1 零引用中有 7 个是**协议内部**，零引用是对的，不属缺口

| 方法 | 为什么不该有 UI |
|---|---|
| `sync.hello` / `sync.list` / `sync.pull` / `sync.push` / `sync.ack` / `sync.cursor` | 设备间同步协议，由 SyncCoordinator 与 sync-cli 调用，不是给界面用的 |
| `remote.pair.complete` | 配对时由**对端**调用，本机 UI 不该调 |

### 0-2 真正缺入口的是 **17 个**

| 组 | 方法 | 后端建成于 | 现状 |
|---|---|---|---|
| 会话操作 | `chat.sessions.delete` / `setMemoryEnabled` / `setModelBinding` | M1 / M2a / M2b | **会话行连右键菜单都没有**，删会话这种基本操作都做不到 |
| 技能管理 | `skills.setEnabled` / `delete` / `import` / `importStatus` | M2c | 渲染端只用 `skills.list` 喂斜杠菜单，**没有任何管理界面** |
| 同步控制 | `control.pause` / `resume` / `status` | M6 | 完整后端 + 审计 + 13 笔 commit，**界面上一个开关都没有** |
| 模型组 | `modelgroup.create/delete/get/list/update` | M2b | 降级链能力建成，**无处配置** |
| 审计日志 | `audit.list` | M6 | 落盘了，**看不到** |
| 预检 | `diagnostics.dryRun` | M4 | 不调模型就能查出「模型不在目录 / provider 缺 key」，**只有 CLI 能用** |

## §1 落点设计（每个能力挂哪儿）

现有可挂载面：`SettingsModal` 四页（模型 / 外观 / 权限 / 设备与同步）、`DevicesModal`、
MU5 新建的工作台标签系统与图标轨。缺的面此轮新建。

| 组 | 落点 | 新建否 |
|---|---|---|
| 会话操作 | 会话行 `⋮` 菜单（展开态）+ 图标轨右键 | 新建菜单组件 |
| 技能管理 | `SettingsModal` 新增第 5 页「技能」 | 新建页 |
| 同步控制 | `SettingsModal`「设备与同步」页顶部 + 侧栏后端选择器显示暂停态 | 扩既有 |
| 模型组 | `SettingsModal`「模型」页下半区 | 扩既有 |
| 审计日志 | 工作台新增「审计」标签（MU5 的标签系统已支持数组渲染，加一枚即可） | 扩既有 |
| 预检 | `SettingsModal`「模型」页顶部「运行预检」按钮 + 结果卡 | 扩既有 |

## §2 决策点（评审需拍板）

### 2-1. 本轮做几组？→ **分两轮（用户 2026-08-10 拍板 A）**

17 个能力、6 组落点、含 2 个新建面，一轮做完体量偏大（估计 +40~60 测试例）。
**MU6 只做前三组**（会话操作 / 技能管理 / 同步控制）——它们是「最常用」与「后端投入最大却完全没露头」的部分；
模型组 / 审计 / 预检 归 MU7。

### 2-2. 会话删除要不要二次确认？→ **要，且走行内确认不弹模态**

删除是不可逆的。但为一次删除弹一个模态太重，采用行内二次确认（点「删除」→ 该行变成
「确认删除？ 删除 / 取消」），与 `DevicesModal` 的移除设备一致（MU2b 已验收的交互）。

### 2-3. `control.pause` 暂停的是什么？→ **同步，不是 agent 回合**

M6 的 `control.pause` 暂停的是**设备间同步**（SyncCoordinator），不是正在跑的 agent。
界面文案必须说清，否则用户会以为点了能停下正在执行的任务——那是 `chat.cancel`（已接）。

### 2-4. 技能「导入」用什么入口？→ **设置页路径文本框（用户 2026-08-10 拍板 A）**

`skills.import({ kind, source })` 支持 `folder` / `zip` / `github-url` 三种。本轮**只接 `folder`**，
入口是**设置页里的一个路径文本框，手动输入或粘贴目录绝对路径**。

**为什么不是原生目录选择器**（这是拍板时点明的关键）：原生选择器要走主进程 `dialog.showOpenDialog`，
那就动了 `src/main`，**直接破红线 1**。文本框是唯一能守住「纯 renderer」的通路。
代价是用户要自己粘路径——可接受，且路径非法时后端会抛错，界面照实显示即可。

GitHub 拉取涉及网络与信任边界，独立评估，不在本轮。

## §2.5 已核实的 RPC 签名（实现照此对齐，勿凭记忆）

| 方法 | 签名 | 要点 |
|---|---|---|
| `chat.sessions.delete` | `{ sessionId, confirm?: boolean }` | **后端强制 `confirm:true`**，否则抛错 |
| `chat.sessions.setMemoryEnabled` | `{ sessionId, enabled: boolean }` | |
| `chat.sessions.setModelBinding` | `{ sessionId, binding?: string }` | `binding` 省略即解绑 |
| `skills.setEnabled` | `{ id, enabled: boolean, sessionId? }` | **带 `sessionId` 写会话覆盖，不带写全局**——界面须说清范围（§6） |
| `skills.delete` | `{ id, confirm?: boolean }` | **后端强制 `confirm:true`** |
| `skills.import` | `{ kind: 'folder'\|'zip'\|'github-url', source: string }` | 后台任务，进度走 `skills.import.progress` 广播 + `importStatus` |
| `skills.importStatus` | `{ taskId? }` | 省略 taskId 即列全部任务 |
| `control.pause` | `()` → `{ ok, syncPaused: true }` | 暂停的是**同步**不是 agent 回合（§2-3） |
| `control.resume` | `()` | 内部顺序敏感：先清标志再收敛 |
| `control.status` | `()` → `{ syncPaused: boolean }` | |

两个破坏性操作后端本身就要求 `confirm:true`——这与 §2-2 的行内二次确认互为印证，不是重复设防。

## §3 Task 序列（串行 TDD；每 Task 先红后绿）

- [x] **Task 1 · 守卫先行（先红）**：新建 `tests/mu6-capability-wiring.test.ts`，逐组锚落点与调用
- [x] **Task 2 · 会话操作**：会话行 `⋮` 菜单（删除含行内二次确认 / 记忆开关 / 模型绑定）
- [x] **Task 3 · 技能管理**：`SettingsModal` 第 5 页（启用停用 / 删除 / 本地目录导入 + 进度）
- [x] **Task 4 · 同步控制**：设备页暂停/恢复开关 + 后端选择器显示暂停态 + 文案澄清（2-3）
- [x] **Task 5 · 文档与验收**：计划勾选、PROJECT_NOTES、三件套 + e2e 双跑 + 截图重生成

（若 2-1 决定一轮做完，追加 Task 6 模型组 / Task 7 审计标签 / Task 8 预检）

## §4 红线

1. **`src/minisd` / `src/main` / `src/preload` 三目录零改动**。本轮全部消费**既有** RPC，
   一个新方法都不加。若发现某能力非改后端不可，**停手报告**。
2. 零新依赖。
3. **不改 MU5 交付的布局骨架**：三区比例规则、分区三态、拖拽契约一律不动。
4. XSS 红线一行不动：Markdown 全链路禁 `v-html`/`innerHTML`；`Icon.vue` 静态字典豁免维持。
5. **新增交互元素一律原生 `button`/`input` + `:focus-visible`**（MU5 已把新增控件做到 100% 可聚焦，不得倒退）。
6. 破坏性操作（删会话、删技能）必须二次确认，且**默认焦点不落在危险项上**。
7. 密钥材料禁入日志与界面（`remote.status` 脱敏契约维持）。
8. 测试读源码文本一律 `replace(/\r\n/g,'\n')` 归一化行尾。
9. **守卫锚意图不锚实现**（MU5 §15 教训：曾断言 `.ctools` 必须 `overflow:hidden`，把 bug 焊死了）。
10. 执行中发现本计划未覆盖的决策点，停手报告，不自行拍板。

## §5 验收

- [x] npm test 全绿：**1058 → 1068**（守卫 10 例；估算的 +25~35 偏高——三组落点比预想集中）
- [x] typecheck 0；build 三产物
- [x] **`git diff --stat -- src/minisd src/main src/preload` 三者均为空**
- [x] `e2e:mu2a` 7/7；`e2e:mu2b` 8/8；**新建 `e2e:mu6` 6/6**
- [x] 运行态实测：每个新接的能力**真的调通了后端**——新建 `scripts/e2e-mu6-acceptance.mjs`，
      纪律是「执行界面操作 → 用 minisdCall **直接问后端** → 断言后端的值变了」。
      刻意不读渲染端内存：读内存证明不了 RPC 真的出去过。**这一步当场逮到一个致命 bug，见 §7。**
- [x] 键盘 Tab 走查：`e2e:mu6` 例 6 逐个查 tabIndex（`.impbtn` / 路径框 / `.smore` 全部可聚焦；
      `.rtoggle` 因当前未装技能不在 DOM，报 -1，留待有技能时补验）
- [x] 计划 checkbox 按实勾选（**不为凑「零未勾」而虚勾**）

## §6 已知会踩的坑（提前记下）

- **`skills.setEnabled` 签名带 `sessionId?`**：意味着技能可以按会话粒度启停。
  界面要说清当前改的是全局还是本会话，否则用户不知道自己改了什么范围。
- **`.vue` 不在 `npm run typecheck` 覆盖内**（`tsc` 只解析 `.ts/.tsx/.d.ts`）。
  本轮新增大量 `.vue`，**运行态验证不是可选项**。
- **弹层在窄列里会被裁**（MU5 §15）：新增的 `⋮` 菜单挂在 212px 侧栏里，
  从一开始就要按「容器可能很窄」设计，别重蹈覆辙。

## §7 e2e 当场逮到的致命 bug：`v-for` 挂错节点，整个会话列表渲染挂掉

**1068 例源码守卫全绿、typecheck 零错误、build 三产物成功——界面上会话列表一行都没有。**

会话行 `.scard` 与它的行内操作区 `.smenu` 是**两个兄弟节点**，而我把 `v-for="s in grp.items"`
挂在了 `.scard` 自己身上。于是 `s` 的作用域只覆盖 `.scard`，`.smenu` 里的 `s` 是 `undefined`，
`renderList` 直接抛 `TypeError: Cannot read properties of undefined (reading 'id')`，
**整个列表渲染崩掉**——store 里明明有 2 个会话，`.list` 却是空的。

为什么两层防线都没拦住：
- **源码文本守卫**只查字符串在不在，`menuFor` / `.smore` / `confirmDelete` 全都在，照样全绿
- **typecheck 覆盖不到**：`npm run typecheck` 是 `tsc --noEmit`，`tsc` 只解析 `.ts/.tsx/.d.ts`，
  `.vue` 被静默跳过（PROJECT_NOTES backlog 已记，本轮再次兑现代价）

修法是把 `v-for` 提到包住两者的 `<template>` 上，并加了回归锚
（正锚 `<template v-for="s in grp.items"`、反锚 `<div v-for="s in grp.items"`）。

**这条印证了 §5 那句「运行态实测不可被守卫替代」不是客套话。** 若本轮跳过 e2e 直接合并，
交付的会是一个「会话列表整个空白」的版本，而所有自动化检查都会告诉你没问题。

### 7-1 e2e 自身的两处修正（非产品缺陷）

1. 前置漏了展开侧栏：MU5 起侧栏默认折叠为 52px 图标轨，会话行在展开态里。
   这是真实用户路径的一部分，补上而非绕过。
2. 设置模态是 `v-if`：关掉再开会重建组件、`section` 回默认页，复原步骤必须重新点导航。
