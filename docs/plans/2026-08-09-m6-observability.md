# DeskMinis M6（可观测与控制权：R4 审计日志 + R2 本端暂停）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 承接 M4.6 安全审计挂起的两项设计题——**R4 审计日志**与 **R2 本端暂停**。两者同属「用户对 Agent 的可观测与控制权」：能停下来但看不见做过什么，和看得见却停不下来，都不完整。R4 以「补权限决议 + 一个查询面」的最小落盘方案落地（不重复既有 messages 历史）；R2 以「同步暂停阀」让用户能冻结本端同步而**不破坏 M3c 收敛正确性**。

**Architecture / 选型预览（决策点 1）:** 审计**不新建完整存储**——既有 `messages.parts_json` 已持久化全部消息 parts（含 toolUse/toolResult），且 raw history 追加型永不改写，天然是一份不可篡改的执行记录。**唯一真正的缺口是权限决议（permission.request / resolved）零落库**。因此 R4 = 新增 `audit_logs` 表存权限决议 + 一个跨会话查询面；R2 = 新增 `settings` 表存暂停标志 + 同步暂停阀。两表合入同一迁移 MIGRATIONS[4]（纯追加）。

**Tech Stack:** better-sqlite3（既有）/ 原生 crypto / 零新依赖。

---

## §0 基线

- 分支基线：`main@6782c2e`（M5 已合并；三件套 987/987(91 文件)/typecheck 0/build 三产物，复核方亲验）。
- 前提（复核方已实测取证，作为设计前提，**不重测**）：
  - **R4 相关**：
    - `messages.parts_json` 已持久化全部消息 parts，**含 toolUse / toolResult**——工具调用与结果本就在库里。
    - raw history 是**追加型永不改写**（[`chat-store.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/chat-store.ts) L222 红线注释：新消息 INSERT OR IGNORE，UPDATE 只碰 sort_order）——既有历史本身已是一份不可篡改的执行记录。
    - 被 offload 的大输出**未丢失**：`offload()`（[`agent/offload.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/agent/offload.ts) L19）把原文写盘、消息里留 stub，原文可回溯。
    - **权限决议零落库**：`permission.request` / `permission.resolved`（[`index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) L240/L245/L505，resolved 带 `reason: 'timeout'|'answered'`）只走 `rpc.broadcast`，进程退出即消失。全 minisd 目录 grep 不到任何 appendFile / createWriteStream / .log 落盘。
    - 现有 6 张表：sessions / messages / compact_markers / skills / session_skill_overrides / sync_orphan_markers。
  - **R2 相关**：
    - 同步收敛只有两个触发点（[`sync/coordinator.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/sync/coordinator.ts)）：L114 `outbound.onRemoteDirty = (peerFp, sid) => pullFromPeer`、L123 `outbound.onOnline = (peerFp) => reconcilePeer(peerFp)`。
    - 全 sync 目录 grep 不到 paused / disabled / enabled 任何暂停机制。

---

## §1 锚点（已核实；执行时仍请自行 grep 复核）

- 权限决议发起（超时侧）：[`index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) L237-246（`pendingPerms` / `rpc.broadcast('permission.request', { requestId, req, meta })` L245 / `rpc.broadcast('permission.resolved', { requestId, reason: 'timeout' })` L240）
- 权限决议响应（answered 侧）：[`index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) L493-508（`permission.respond` handler，L505 broadcast resolved reason:'answered'，decision: allow-once|allow-session|deny）
- `PermissionRequest` 结构：[`tools/types.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/tools/types.ts) L16 `{ kind: 'shell'|'file-write'|'file-read'|BridgePermissionKind; detail: string; sessionId: string; toolTitle: string }`
- 同步协调器：[`sync/coordinator.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/sync/coordinator.ts) `flush()` L62-76（broadcast sync.dirty + pushToPeer）;`onRemoteDirty` L114;`onOnline` L123;`reconcilePeer` L147-166（push 全部 + pull 全部）;`stop()` L168-173
- 删除会话（审计独立性的测试锚点）：[`chat-store.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/chat-store.ts) L63-70 `deleteSession`（只删 messages/compact_markers/sessions，**不碰 audit_logs**）
- 迁移 runner 与既有 MIGRATIONS：[`store/db.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/db.ts) L4-67（MIGRATIONS[0..3]），L69-81 `openDb`（user_version 驱动）
- RPC 服务：[`rpc/server.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/rpc/server.ts) `methods` 查发 L103-108、`broadcast` L122-125
- 密钥材料红线（脱敏口径的事实来源）：[`remote/pairing.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/remote/pairing.ts) L22（authKey/sessionSecret/privateKey 禁入日志/RPC 返回）；PASETO 密钥在 [`remote/paseto.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/remote/paseto.ts) L70-104
- M4 出口消毒（**不直接套用**，落盘方向是另一件事）：[`agent/sanitize.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/agent/sanitize.ts) `URL_CRED` L17、`sanitizeLiteral`/`sanitizeMultiline`、`wrapUntrustedDataBlock`
- e2e:m3c 回归脚本：`package.json` L18 `"e2e:m3c": "node scripts/e2e-m3c-acceptance.mjs"`

---

## §2 决策点（必须先答，定了才写 Task）

### 2-1. R4 的真实缺口边界 → **只补权限决议 + 一个查询面，不新建完整审计存储**

**结论：** 权限决议是唯一真正缺失的审计面；其余审计材料（shell 命令、文件路径、剪贴板内容、工具调用与结果）**都已在 `messages.parts_json` 里追加不可改**，天然是一份不可篡改的执行记录。**反对默认新建一套完整审计存储**——那会与既有 messages 大面积重复。

**论证（逐问作答）：**

- **a) 权限决议之外还缺什么？** 几乎不缺。逐类核对：
  - shell 命令、文件路径、剪贴板内容 → 作为 toolUse 的 `input` 已持久化在 `messages.parts_json`（且追加不可改）。
  - 工具执行结果 → toolResult 同样在 parts_json。
  - 大输出被 offload → 原文写盘可回溯。
  - **权限决议（request + resolved，含 reason: timeout/answered 与 decision: allow-once/allow-session/deny）**→ 只走 `rpc.broadcast`，进程退出即消失，**零落库**。审视后确认这是唯一缺口——因为一个 `deny` 的决议可能根本不产生任何 message（工具未执行），messages 无从记录「用户曾拒绝过那次命令」这一控制动作。
- **b) 缺的部分是新表、还是在既有表上补字段、还是跨会话查询视图？** 权限决议是**跨会话、事件型**的：一个决议可能命中的 session 有也可无（deny 时无 message），且审计需要按时间全局查。往 `messages` 补字段违背「raw history 追加型永不改写」且语义不符（决议不是 message）。**新增 `audit_logs` 表**（事件型，含 session_id 冗余列便于按会话过滤），查询面为跨会话 SQL 视图 + 一条 RPC。
- **c) 结论：** 只需补权限决议 + 一个查询面。**不为了里程碑显得厚重而扩大。**

### 2-2. 审计记录的读取面 → **只落盘 + 出一条 RPC 查询面，本里程碑不做 UI 面**

**结论：** 落盘为基础；另出一条 `audit.list` RPC 供查询；**不做 UI 面**。

**论证：** M5 刚打完包、还没做真机验收，用户尚未真实跑起来。此刻做 UI 审计可视化（列表/筛选/时间线）缺少真实使用反馈，价值低、返工风险高。一条 `audit.list` RPC（分页/按时间/按 event_type 过滤）成本极低、可被单测与未来 UI 直接复用，是为 UI 留的接缝。符合「够用不扩大」。

### 2-3. 保留与轮转 → **审计独立于会话生命周期 + 条数上限 FIFO 轮转**

**结论：** 审计记录**独立于会话生命周期**——`deleteSession` 不得连带删除 audit_logs；轮转用**按条数上限（FIFO，插入序淘汰）**。

**论证：** 删会话（`chat-store.deleteSession` 只删 messages/compact_markers/sessions）是「清历史」语义；审计是「用户对 Agent 控制权」的证据面，若删会话时审计跟着删，审计失去追溯意义。两者是两套语义，审计必须独立存活。轮转选**条数上限 FIFO**（如 `MAX_AUDIT_ROWS = 100_000`，超出删最旧）：实现最简、零依赖，与 M4.5 stable 缓存 FIFO 策略一致；不做时间维度轮转（时间口径在跨时区/重启下易漂移，且条数上限已覆盖无界增长止血）。

### 2-4. 脱敏口径 → **落盘专用脱敏：只洗「密钥/凭据样式」，不动「命令/路径/内容正文」**

**结论：** 新增独立的 `auditRedact`（落盘方向），**不直接套用 M4 的 sanitize**。

**论证：** M4 sanitize 是「入 prompt 方向」的出口消毒（`sanitizeLiteral`/`sanitizeMultiline` 剥控制字符 + URL user:pass 脱敏），目的是不让不可信数据污染模型输入。**落盘方向是另一件事**：审计要落盘 shell 命令、文件路径、剪贴板内容——这些是审计存在的核心价值（用户要看到 Agent 跑了什么命令），剥光即失去可观测性。因此审计脱敏边界 = **只洗凭据样式，保留正文**：
- **URL 凭据**：`http(s)://user:pass@...` → 复用 `URL_CRED` 正则（[`sanitize.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/agent/sanitize.ts) L17）替换为 `$1://***:***@`。
- **常见密钥样式**：`Authorization: Bearer <token>`、`sk-...`、`api_key`/`api-key`/`apikey` 后跟高熵串、`x-api-key:` 头等 → 用**原生正则**擦除键名后的值（**零新依赖**）。
- **密钥材料硬拒**：PairingKey / authKey / StaticIdentity 私钥 / PASETO 密钥——这些**根本不允许进入 audit_logs 的 payload**（见 §5 红线），在写入点做防御性断言（若检测到直接丢弃该敏感字段），不依赖正则兜底。
- **保留**：命令主体、文件路径、剪贴板文本正文（它们要进审计）。

### 2-5. R2 暂停的语义边界 → **只停同步收敛，不停 agent 循环/工具执行**

**结论：** 同步暂停阀**只暂停本端发起的同步动作**（sync.dirty 广播、push、reconcile 的 push 方向）；**不停 agent 循环/工具执行**。

**论证：** agent 循环/工具执行是本地主执行循环，冻结它会让用户正在进行的会话卡死，且「停止当前回合」已有既有 stop 能力覆盖。R2 的「本端暂停」聚焦**同步控制轴**——用户冻结本端对外数据流，让本端不再把新变化推给对端。暂停 agent 循环属另一能力，本里程碑不做（写进非目标）。

### 2-6. 暂停状态的持久性 → **落盘（settings 表），重启后仍暂停**

**结论：** 暂停标志持久化到 `settings` 表（`sync.paused=1`），重启后仍暂停，需用户显式恢复。

**论证：** 暂停同步是「用户控制意图」，用户预期是「我关了就是关了」。若内存态，重启后静默恢复同步，会在用户以为已冻结时悄悄产生数据流，违背控制权语义。落盘更符合「控制权」。存放：新增 `settings(key TEXT PRIMARY KEY, value TEXT, updated_at)` 表（MIGRATIONS 纯追加，不碰既有 6 表）。

### 2-7. 暂停期间对端推来的数据 → **收下照常合并，但本端不发起任何同步；保证解除后已收敛**

**结论：** **收下合并但不回推**。暂停期间对端（拨号方 onRemoteDirty→pullFromPeer，或监听方 sync.push handler）主动推来的数据照常 `mergeRemoteSession` 幂等落库（INSERT OR IGNORE），但本端**不**因自身 dirty 触发 broadcast/push，也不发起 reconcile 的 push 方向。

**论证（三选一）：**
- **拒收**：对端改动在暂停期间不落库；若连接保持，解除后无 `onOnline` 触发就没有 reconcile 补拉 → **对端改动永久丢失**，违反红线。
- **收下不合并**：需临时缓冲且解除后要重放，实现复杂易错，且缓冲本身也是「落库前暂存」，边界难定。
- **收下合并不回推** ✓：对端数据落库即**永不丢失**；只禁本端对外广播/推送，实现最简、语义最清晰。唯一张力是「本端状态被对端改动影响」——但红线「解除后必须收敛回一致」优先于「本端不被对端影响」的软诉求，且本端本地改动不受影响。
- **暂停期间本端 dirty 信号被丢弃而非保留**（如实说明，不依赖机制假设）：`flush()` 头两行 `const sids = Array.from(this.pendingQueue); this.pendingQueue.clear();` 在广播/推送**之前**就清空队列。故无论暂停阀装在 `onDirty`（仿 `stopped` 提前 return，sid 根本不入队）还是装在 `flush`（入队也被 clear 丢弃），暂停期间本端产生的 dirty 信号都会丢，解除暂停时队列是空的，**没有残留可「自然 dequeue」**。收敛必须靠**恢复时的显式动作**（见 Task 5 方案 A），不能靠队列残留。
- **两种暂停场景的「收下」与收敛路径不同（如实订正，不破红线）**：本决策点标题「暂停期间对端推来的数据照常收下合并」只对**运行时暂停**成立；对**启动即暂停（未拨号）**不成立——
  - **运行时暂停（连接在线）**：pull 方向照常，对端 sync.push / sync.dirty 广播照收照合；本端不发起任何同步。解除后收敛靠**方案 A**（显式重推全部 synced session）。
  - **启动即暂停（暂停态启动不拨号，无连接）**：暂停期间**收不到任何对端数据**（既收不到 sync.push 也收不到 sync.dirty 广播，无连接即无输入）。对端改动在**恢复首拨**后由 `onOnline → reconcilePeer` 双向对账补拉，**不丢但延迟**。
  - **红线校验**：两条路径都不破「解除后收敛回一致」——运行时暂停靠方案 A，启动即暂停靠首拨 reconcile，均无永久丢失。**方案 A 正是为「运行时暂停」这一场景存在的**（启动即暂停由首拨 reconcile 覆盖，不需要方案 A）。
- **专项测试（双向）**：既有 `A 暂停 → B 改动 → A 恢复 → A 收敛到 B`（B 推 A），另补镜像 `A 暂停 → A 本地改动 → A 恢复 → B 收到 A 的改动`（A 推 B）。两条方向各细分为 A 为监听方 / A 为拨号方，共四条子路径（见 Task 8）。其中方向 2（A 推 B）的**运行时暂停**场景即方案 A 的验收面。

### 2-8. R4 与 R2 的先后与耦合 → **先 R4（建表）后 R2（暂停阀），R2 的 pause/resume 写入审计**

**结论：** 执行顺序 **R4 → R2**。耦合点：**暂停/恢复动作本身要进审计记录**（它是「用户对 Agent 控制权」的事件），故 `audit_logs` 表先建，R2 才能写审计。

**论证：** R2 的暂停标志读取只依赖 `settings` 表，**不依赖** R4；但 R2 的 pause/resume 事件要落 audit_logs，故 R4 的 `audit_logs` 表必须先于 R2 存在。两表（audit_logs + settings）可合入同一迁移 MIGRATIONS[4] 一次建好，然后 Task 顺序：先做 audit 写入器 + 权限决议落库，再做同步暂停阀 + pause/resume 审计。

---

## §3 里程碑范围（Task 分解）

| Task | 内容 | 产出 |
|------|------|------|
| 1 | MIGRATIONS[4] 纯追加 `audit_logs` + `settings` 两表 | 迁移 SQL |
| 2 | `AuditLogger`（redact + append + list + 条数 FIFO 轮转）+ `auditRedact` 落盘脱敏 | 新文件 `store/audit.ts` |
| 3 | 权限决议落库：request + resolved（timeout/answered + decision）写入 audit_logs | index.ts 改动 |
| 4 | RPC 查询面 `audit.list`（分页/按时间/按 event_type） | index.ts 注册 |
| 5 | R2 暂停标志 `settings.sync.paused` + RPC `control.pause`/`control.resume`（resume 显式触发方案 A 收敛） | 新 store 方法 + RPC |
| 6 | SyncCoordinator 同步暂停阀（暂停 flush 广播/push + reconcile push；pull 照常） | coordinator.ts 改动 |
| 7 | R2 pause/resume 写审计；`deleteSession` 不删 audit_logs（验证决策点 2-3） | 审计联动 |
| 8 | 测试：R2 收敛正确性（e2e:m3c 回归 + 专项）、删会话审计保留、脱敏对抗用例 | 单测 + e2e |

---

## §4 Task 细节

### Task 1 — MIGRATIONS[4] 纯追加两表

在 [`store/db.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/db.ts) `MIGRATIONS` 数组**末尾追加** `[4]`（既有 [0]–[3] 一字不动）：

```sql
-- [4] M6 可观测与控制权：audit_logs（R4 审计）+ settings（R2 暂停标志）
-- 迁移一经发布不可改：已发布库 user_version=4，runner 只对 v<5 的库跑 MIGRATIONS[4]。
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  session_id TEXT,
  peer_fingerprint TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at REAL NOT NULL
);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC, id);
CREATE INDEX idx_audit_logs_type ON audit_logs(event_type, created_at DESC);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);
```

> 说明：`payload_json` 存已脱敏的事件体（权限决议的 req/meta + reason/decision）。`session_id`/`peer_fingerprint` 冗余为列便于按会话/按设备过滤而无需 JSON 解析。全局轮转按 `created_at` FIFO 删最旧。

**checkbox：**
- [ ] MIGRATIONS[4] 追加到数组末尾，[0]–[3] 一字不动
- [ ] 两表均建索引
- [ ] openDb 迁移跑通（新建库 + 已有库升级 user_version 4 均验证）

### Task 2 — AuditLogger + auditRedact 落盘脱敏

新文件 `src/minisd/store/audit.ts`：

- `auditRedact(obj: unknown): unknown`：深拷贝并对字符串字段做落盘脱敏 —— URL 凭据（复用 `URL_CRED` 逻辑）+ 常见密钥样式（原生正则，零依赖）。**保留命令/路径/内容正文**。
- `AuditLogger`：
  - `append(eventType, payload, meta?: { sessionId?, peerFingerprint? })`：`auditRedact` 后 INSERT 一行，然后触发**条数轮转**（总行数 > `MAX_AUDIT_ROWS` 时按 `created_at` FIFO 删最旧）。
  - `list(opts: { eventType?, sessionId?, from?, to?, limit?, offset? })`：跨会话查询视图。
  - 密钥材料防御：若 payload 含 `authKey`/`privateKey`/`sessionSecret`/`paseto` 等字段名，直接剔除该字段（KeySafe 白名单，见决策点 2-4）。

**checkbox：**
- [ ] `auditRedact` 对 URL user:pass 脱敏
- [ ] `auditRedact` 对常见密钥样式（Bearer/sk-/api_key/x-api-key）擦值保留键名
- [ ] `auditRedact` 保留命令主体/文件路径/剪贴板正文
- [ ] `AuditLogger.append` 触发条数 FIFO 轮转
- [ ] `AuditLogger.list` 支持 eventType/sessionId/时间/分页过滤
- [ ] 密钥材料字段名防御剔除

### Task 3 — 权限决议落库

在 [`index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) 两处写入审计事件：

- **发起**（L245 `rpc.broadcast('permission.request', ...)` 旁）：`audit.append('permission.request', { requestId, req, meta })`，meta 含 timeoutMs/riskClass/bridgeTriggers。
- **超时**（L240 `rpc.broadcast('permission.resolved', { reason:'timeout' } ...)` 旁）：`audit.append('permission.resolved', { requestId, reason:'timeout' })`。
- **answered**（L505 `rpc.broadcast('permission.resolved', { reason:'answered' } ...)` 旁）：`audit.append('permission.resolved', { requestId, reason:'answered', decision })`。

关键词：`requestId` 用于关联 request→resolved 成对事件。`req` 里 `detail`（shell 命令/剪贴板）经 `auditRedact` 落盘。

**checkbox：**
- [x] permission.request 落库（含 req/meta）
- [x] permission.resolved（timeout）落库
- [x] permission.resolved（answered，含 decision）落库
- [x] requestId 关联成对

### Task 4 — RPC 查询面 audit.list

在 [`index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) RPC `methods` 注册 `audit.list`，透传 `AuditLogger.list` 的过滤参数，返回 `{ rows, total }`。

**checkbox：**
- [x] `methods['audit.list']` 注册并可查
- [x] 返回脱敏后的 payload（防御性再红act一次）

### Task 5 — R2 暂停标志 + control.pause/control.resume

- 新增 `settings` 读写：`getSetting(key)` / `setSetting(key, value)`（`store/settings.ts` 或并入现有 store）。
- 常量 `SYNC_PAUSE_KEY = 'sync.paused'`。
- RPC `control.pause` / `control.resume`：写 `settings` 表 + 通知 SyncCoordinator 切换暂停阀 + 落审计 `audit.append('sync.paused'/'sync.resumed', {})`。
- `control.status` 或复用现有 status 返回 `syncPaused` 布尔。
- **`control.resume` 必须显式触发一次收敛（方案 A 定案，见下）**——因为暂停期间本端 dirty 信号已被丢弃（2-7 论证），恢复不能靠队列残留，必须显式重推。
- **两种暂停场景的收敛路径不同（复核方订正，见 2-7）**：**运行时暂停**（连接在线）解除后靠**方案 A**（显式重推全部 synced session）；**启动即暂停**（暂停态启动未拨号）解除后靠**首拨 `onOnline → reconcilePeer`** 双向对账补拉。方案 A 正是为「运行时暂停」这一场景存在的——启动即暂停由首拨 reconcile 覆盖，不需要方案 A。`control.resume` 统一触发方案 A 即可同时兜住两种场景（运行时暂停：重推；启动即暂停：重推前先首拨连接的 reconcile 已补拉，重推保证本端改动也流出）。

**恢复收敛方案选型（决策点 2-7 落地）：选 方案 A。**

- **方案 A：对所有 synced session 重新 `onDirty(sid)` 入队后 `flush()`。** 一次覆盖两种角色：监听方角色走 `flush` 的 `rpc.broadcast('sync.dirty', ...)`（远端拨号方客户端收到后 pull 本端）；拨号方角色走 `flush` 的 `pushToPeer`（本端主动 push）。**监听方角色被完整覆盖**——这是方案 B 的盲区。
- **方案 B：对所有 `dialedPeers()` 调 `reconcilePeer(peerFp)`。** 现成、双向（a. push 全部会话 / b. pull 对端清单）、自带 in-flight 防抖，但**只覆盖拨号方**：本端是纯监听方（无 outbound）时 `dialedPeers()` 为空，恢复后监听方角色的本地改动仍不广播，搁浅未解决。
- **结论：选方案 A。** 理由：① 监听方角色是方案 B 单用会漏掉的，而暂停用户可能恰好就是纯监听方；② A 复用既有 `onDirty`→`flush` 路径，无新增对账逻辑；③ 冗余被 id 幂等吸收——`buildPushBatches` 是全量态，对未改动会话重 push 无副作用，peer 侧 merge id 重合 `hasChange=false` 无 ping-pong。**不加方案 B**（A 已覆盖两种角色，B 是多余全量对账）。

**checkbox：**
- [x] settings 表 get/set 方法
- [x] `control.pause` / `control.resume` RPC 注册
- [x] `control.resume` 显式触发方案 A：对全部 synced session `onDirty` + `flush`
- [x] 暂停标志持久化（重启后仍暂停）
- [x] 启动时读 `settings.sync.paused` 注入 coordinator（`start()` 前 `setPaused`，暂停态不拨号/不广播，但 pull 照常）
- [x] pause/resume 写审计事件

**暂停态的用户可见性（决策点 2-6 补充结论）：** 重启后仍暂停带来一个用户可见后果——同步静默停着，直到用户显式 `control.resume`；用户可能忘了自己暂停过，把「同步没动静」当成 bug 查。**结论：本里程碑暴露 `syncPaused` 于 `control.status`（RPC 可查）+ dry-run 诊断项（`diagnostics` 加一行「当前同步状态：已暂停」），UI 不渲染**（2-2 已定本里程碑不出 UI）。这样用户/外部工具随时可查暂停态，兜住「忘了暂停」的困惑。

### Task 6 — SyncCoordinator 同步暂停阀

在 [`sync/coordinator.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/sync/coordinator.ts) 增加暂停开关：

- 新增 `setPaused(paused: boolean)`。
- `flush()`（L62-76）：暂停时**跳过** `rpc.broadcast('sync.dirty', ...)` 与 `pushToPeer`（本端不发起同步）。
- `reconcilePeer()`（L147-166）：暂停时**跳过 push 方向**（a 段），**保留 pull 方向**（b 段，对端数据照常收下合并）。
- `onRemoteDirty`（L114→pullFromPeer）：**不受暂停影响**（对端推来照常收下合并）。
- 暂停期间若有对端 push 从 `sync.push` handler 进来，`mergeRemoteSession` 幂等落库，但因其内部 `onDirty` 触发的 `flush` 被暂停阀挡住，不会回推。

**checkbox：**
- [x] `setPaused` 影响 flush 的 broadcast + push
- [x] `setPaused` 影响 reconcile 的 push 方向，但保留 pull 方向
- [x] `onRemoteDirty`/`sync.push` 收下合并不受暂停影响
- [x] 解除暂停后收敛正确（见 Task 8 专项测试）

### Task 7 — 审计联动 + 删会话审计保留

- pause/resume 写审计已在 Task 5 覆盖。
- 验证 `chat-store.deleteSession`（L63-70）**不**删 audit_logs：补一条断言测试（决策点 2-3 落地）。

**checkbox：**
- [x] 删会话后 audit_logs 记录仍在（测试固化）

### Task 8 — 测试

**单测：**
- `audit.test.ts`：append/redact/list/FIFO 轮转/密钥字段剔除。
- `auditRedact` **对抗性用例**：构造含 `PairingKey`/`authKey` base64、`sk-...`、`Authorization: Bearer <jwt>`、`http://user:pass@host`、`x-api-key: <hex>` 的字符串，断言**不出现在**审计记录 payload 里；同时断言命令正文/路径**保留**。
- `settings.test.ts`：get/set/持久化。
- `coordinator-pause.test.ts`：暂停时 flush 不广播不 push、reconcile 不 push 但 pull；解除后恢复。

**删会话审计保留测试：** 插入会话 + 审计记录 → `deleteSession` → 断言 messages/compact_markers 被删但 audit_logs 记录仍在。

**收敛正确性专项（R2，必跑 `e2e:m3c` 回归）：** 双向 × 双角色，共四条子路径，断言解除后收敛一致且无重复（id 幂等）。

- **方向 1（B 推 A，对端数据流入本端）：** `A 暂停 → B 改动 → A 恢复 → A 收敛到 B 的改动`。
  - 子路径 1a：A 为监听方（B push 经 `sync.push` 收下合并）。
  - 子路径 1b：A 为拨号方（B dirty → A `onRemoteDirty` → `pullFromPeer` 收下合并）。
- **方向 2（A 推 B，本端数据流出到对端，镜像——硬要求）：** `A 暂停 → A 本地改动 → A 恢复 → B 收到 A 的改动`。
  - 子路径 2a：A 为监听方（恢复后 `flush` 广播 `sync.dirty` → B 拉取）。
  - 子路径 2b：A 为拨号方（恢复后 `flush` `pushToPeer` 推给 B）。
- **先红后绿门控（硬要求）：** 方向 2 的测试必须在**实现 Task 5 方案 A 之前先红**（暂停期间产生本地改动、恢复后 B 收不到——暴露搁浅）。若在改 Task 5 之前它已绿，说明测试没测到真东西，**停手报告**，不得继续。

**checkbox：**
- [x] audit 单测（append/redact/list/轮转/密钥剔除）
- [x] auditRedact 对抗性用例（密钥样式不出现在审计）
- [x] settings 单测
- [x] coordinator-pause 单测
- [x] 删会话审计保留测试
- [x] R2 收敛方向 1（B 推 A）子路径 1a/1b
- [x] R2 收敛方向 2（A 推 B）子路径 2a/2b，且**先红后绿**（改 Task 5 前必红）
- [x] `e2e:m3c` 回归通过

---

## §5 红线（执行期硬约束）

- **MIGRATIONS 纯追加**：新表只能追加到 MIGRATIONS 末尾；既有 6 张表结构与既有 migration [0]–[3] 一行不动。
- **raw history 追加型永不改写**：审计不得以任何方式改写 messages 表既有行；审计只写 audit_logs/settings。
- **暂停不得破坏 M3c 收敛正确性**：暂停期间无论哪种对端数据处理策略，**解除后必须收敛回一致**——不得出现「暂停期间对端的改动永久丢失」。必须有针对性测试（Task 8 专项），不能只靠走查。
- **密钥材料禁入审计落盘**：PairingKey / authKey / StaticIdentity 私钥 / PASETO 密钥材料一律不得写入审计记录（Task 2 白名单 + 防御性剔除 + Task 8 对抗用例）。
- **零新依赖**：脱敏用原生正则，不用任何新库。
- **不夹带**：subagent、历史提炼技能提案层均不做（已顺延 M7，见 §7）。

---

## §6 复核方验证步骤（环境状态类举证，交复核方实测）

> 复核方负责取证审计文件实际内容、落盘位置、体积增长；此处给可执行步骤，执行方不贴环境证据。

1. **审计落盘位置与增长**：跑一次含权限卡（shell 命令 → allow-once/deny）的会话，进入数据根 `%APPDATA%\DeskMinis`（`DESKMINIS_TEST=1` 时换测试根），用 `ELECTRON_RUN_AS_NODE` 打开 `minis.db`，`SELECT event_type, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 20`，确认 permission.request / permission.resolved（含 reason/decision）成对落库。
2. **脱敏**：对审计记录中 `permission.request` 的 `payload` 抽查，确认 shell 命令主体保留而无密钥样式；构造含密钥样式字符串的对抗用例，断言不出现在 payload。
3. **轮转**：临时把 `MAX_AUDIT_ROWS` 调小（如 10），插入 20 条，确认只保留最近 10 条（FIFO）。
4. **删会话独立性**：删一个会话，确认 `messages`/`compact_markers` 被清而 `audit_logs` 记录仍在。
5. **R2 持久性**：`control.pause` 后重启应用，确认 `control.status` 返回 `syncPaused:true`，`settings` 表 `sync.paused=1` 仍在。
6. **R2 收敛**：跑 `e2e:m3c` 回归 + 收敛专项（方向 1「B 推 A」+ 方向 2「A 推 B」各双角色），暂停→改动→恢复→收敛一致，确认无重复无丢失。
7. **三件套**：`npm test`（987 基线 + 新增单测）、`typecheck`、`build` 三产物，原始输出留档。

---

## §7 非目标（明确不做，顺延 M7）

- **subagent 能力扩展**：属另一条轴（能力扩展），且更适合等真实用户跑起来之后再做，顺延 M7。
- **历史提炼技能提案层**：顺延 M7。
- **审计 UI 面**：M5 未真机验收，本里程碑不出 UI，只留 `audit.list` RPC 接缝（决策点 2-2）。
- **暂停 agent 循环/工具执行**：只停同步收敛（决策点 2-5）。
- **时间维度轮转**：只用条数 FIFO（决策点 2-3）。

---

## §8 执行顺序与 commit 链

从 `main@6782c2e` 开 `feature/m6`，按依赖序提交（conventional commits + 中文描述）：

| 顺序 | 内容 | commit type |
|------|------|-------------|
| 0 | 本计划文档初稿（评审前，不提交） | `docs(m6)` |
| 1 | Task 1 MIGRATIONS[4] 两表 + 迁移测试 | `feat(m6)` |
| 2 | Task 2 AuditLogger + auditRedact + 单测（含对抗用例） | `feat(m6)` |
| 3 | Task 3 权限决议落库 | `feat(m6)` |
| 4 | Task 4 audit.list RPC | `feat(m6)` |
| 5 | **先红（TDD 门控）**：Task 8 收敛方向 2 镜像测试先写先跑，**断言红**（暴露暂停期间本端改动搁浅），停此提交，不实现恢复 | `test(m6)` |
| 6 | Task 5 settings + control.pause/resume + 持久化 + **方案 A 恢复收敛**（使上一提交的方向 2 转绿） | `feat(m6)` |
| 7 | Task 6 SyncCoordinator 暂停阀 + 单测 | `feat(m6)` |
| 8 | Task 7 删会话审计保留测试 | `test(m6)` |
| 9 | Task 8 R2 收敛专项测试全量补齐（方向 1 + 方向 2 全子路径）+ 全量回归（含 e2e:m3c） | `test(m6)` |
| 10 | 三件套亲验 + 复核方验证步骤 | `build(m6)` |

---

## §9 交付报告要素

commit 链、三件套原始输出（`npm test` / `typecheck` / `build`）、`e2e:m3c` 原始输出、决策点结论逐条（§2 八条）、偏差申报、checkbox 状态（§4 逐项 [x]）。偏差申报如触发：MIGRATIONS 是否追加成功、暂停阀是否按决策点 2-7 语义落地、脱敏对抗用例是否全绿。

---

## §10 里程碑顺延说明（背景）

早前调研 openclaw/hermes 后，路线曾把 M6 暂定为「subagent + 历史提炼技能提案层」。**现调整**：那部分**顺延为 M7**，M6 改为承接 M4.6 安全审计挂起的两项设计题（R4 审计日志、R2 本端暂停）。理由：两者同属「用户对 Agent 的可观测与控制权」，互为一半——能停下来但看不见做过什么，和看得见却停不下来，都不完整；而 subagent 是能力扩展，属另一条轴，且更适合等真实用户跑起来之后再做。本计划非目标（§7）已明确不夹带 M7 内容。