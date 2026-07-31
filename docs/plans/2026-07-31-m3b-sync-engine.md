# DeskMinis M3b（双向会话同步）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 DeskMinis 桌面侧同步引擎、线格式与 `sync.*` RPC 面（OM 侧实装属 OpenMinis 代码库，不在本计划范围）：DM 侧 `messages` 表新增 `origin_device_id` / `created_locally_at` 两列走 `MIGRATIONS[3]` 追加迁移；线格式对齐 OM [`SyncedTypes.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/SyncedTypes.swift)（§3.6 结论——复用字段名，不发明第三种形状），`WireCompactMarker` 双锚齐备主锚 `lastCompactedMessageId`（§4.4）；`mergeSession` 算法 = 三路去重（id 为准）+ 端内单调（`originDeviceId+createdLocallyAt` 稳定序 + 跨端栅栏）+ marker LWW，单次 O(N)，锚换算严格按 §4.4 时序（回算必须在合并排序之后，失败标 orphan 等补齐重算）；Offload 文件元数据只同步（`sessionId/toolUseId/originDeviceId/relativePath/size/sha256`），文件本体不搬；`sync.*` RPC 面走 M3a 信道（`remote` authMode 可调 `sync.*`——它就是给对端设备用的），两触达（事件驱动 pending 队列 → `sync.dirty` 广播 / 手动 CLI）（评审命门 4：心跳移 M3c）。设计依据：`../specs/2026-07-31-m3-sync-design.md` §1-M3b / §3.6 / §4.4 / §6。

**Architecture:** 复用 M3a 已建立的 PASETO 鉴权信道（[`remote/paseto.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/remote/paseto.ts) + [`remote/pairing.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/remote/pairing.ts) PairingService + [`rpc/server.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/rpc/server.ts) `additionalVerify` 三级 `authMode`），不新增传输层。`sync.*` RPC 方法面与 `remote.*` 同构——在 [`src/minisd/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) L437-454 装配段追加：业务面已由 `guardBusinessMethod`（[`remote/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/remote/index.ts) L119-128）统一拒 pairing 模式，`sync.*` 复用此守卫（pairing 模式只能调 `remote.pair.complete`）。`sync.*` 方法的 `authMode` 允许列表：`local`（手动同步按钮 / CLI）+ `remote`（对端推送 / 拉取），`pairing` 全拒。`SyncCoordinator`（新模块）服务端被动：维护 pending 队列，`onDirty` 时去抖 200ms 后 `rpc.broadcast('sync.dirty', { sessionId, cursor })` 通知已连 remote peer，对端作为 RPC 客户端主动调 `sync.pull` 拉取（评审命门 4：心跳 / 出站客户端 / 地址簿移 M3c）。CompactMarker 锚换算严格按设计 §4.4：DM 出口直接带 `lastCompactedMessageId`（[`shared/types.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/shared/types.ts) L65 已有），`firstKeptMessageId` 按需 transient 带出（DM 本地不存该列，仅在 `toWire` 时按合并后序列回填）；DM 入口优先取 `lastCompactedMessageId`，缺失时回退 `firstKeptMessageId` 在**合并排序后的消息序列**上回算——此回算必须发生在 `mergeSession()` 完成消息合并排序之后，回算失败标 `orphan` 暂不生效。

**Tech Stack:** TypeScript (strict) / Node 22（electron as node）/ vitest / `better-sqlite3`（已有，schema 迁移）/ **零新依赖**（M3a 已引入的 noble 套件 + ws 够用，本计划纯算法 + RPC）

## Global Constraints

- 所有代码在 `deskminis/` 子目录（仓库根是 `C:\Users\24739\Downloads\openminis1\`，`OpenMinis/` 是只读参考克隆，永不修改）
- TypeScript `strict: true`；包管理 npm
- 时间戳一律 **epoch 秒（浮点）**——本计划内 `createdLocallyAt` / `lastSyncedAt` / `cursor` 均为 epoch 秒；**唯一例外**：PASETO v4.local 的 `exp` / `iat` 是毫秒（M3a 现状，[`remote/paseto.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/remote/paseto.ts) 契约），OM 对接时需注意此单位差异
- 测试命令统一 `npm test`（vitest run，跑在 electron as node 下）；单文件 `npm test -- tests/xxx.test.ts`
- 提交信息用 conventional commits + 中文描述（如 `feat(m3b): …`）
- 代码基线 = **main@916778d**（M3a 合并后，526 测试 / 48 文件全绿）；本里程碑新增测试约 54 例，完成后全量约 580 例
- **单测禁外网**：mergeSession 纯算法、wire 换算纯数据、sync.* RPC 测试用本地 WS（127.0.0.1）+ InMemoryVault，不拨任何外部地址
- 526 基线不回归：
  - `MIGRATIONS` 数组只追加 `[3]`，不碰 `[0]`/`[1]`/`[2]`（迁移一经发布不可改——M2a/M2c 教训）
  - `ChatStore.appendMessage` / `appendCompactMarker` / `getLatestCompactMarker` / `listMessages` / `updateMessage` 现有签名与语义一行不动（追加型红线），新方法独立命名（`mergeRemoteSession` / `getSessionCursor` / `listSyncedSessions`）
  - `buildEffectiveHistory`（[`agent/compact.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/agent/compact.ts) L78-102）一行不改——它消费 `RawMessage[] + CompactMarker | undefined`，M3b 只保证喂给它的输入（合并后的 `listMessages` + `getLatestCompactMarker`）正确
  - `chat-context-info.test.ts` 例 2（M2a 红线锚点，L78-110）合并后各自重跑仍绿
  - M3a 的 `remote.*` 方法面 / `additionalVerify` / `guardBusinessMethod` / `RpcServer` 三级 `authMode` / `noProxyFetch` 红线隔离一行不改
- **raw history 追加型永不改写（M2a 红线）**：`mergeRemoteSession` 写入新消息时一律走 `INSERT OR IGNORE`（id 重复跳过），`UPDATE` 只允许作用于 `sort_order` 重排（本地展示索引，不是同步事实源）与 `updated_at`（LWW 元数据），**绝不改 `parts_json` / `role` / `created_at`**
- **sortOrder 只做本地展示索引**：合并后各端自行重排回写，`sortOrder` 不进 wire 格式事实源——`WireMessage` 带 `sortOrder` 仅为 OM 既有字段对齐（[`SyncedTypes.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/SyncedTypes.swift) L76 注释明示「Best-effort hint only. Receivers MUST derive their own sort_order」），DM 入口忽略对端 `sortOrder`，按合并后的 `(originDeviceId, createdLocallyAt, id)` 重排
- **业务面与 M3a 的 `remote.*` / 鉴权面零改动**：`sync.*` 是新增 RPC 面，不修任何现有 `chat.*` / `permission.*` / `skills.*` / `provider.*` / `modelgroup.*` / `terminal.*` / `files.*` / `remote.*` 方法
- **OM 侧实装不在本计划**：线格式即契约，OM 对接在「完成定义」注明——并写明 PASETO `exp`/`iat` 为毫秒的对齐提醒（OM Swift 侧 `Date()` 是秒，需 `* 1000`）

## 架构决策（实现前必读）

1. **MIGRATIONS[3] 加两列 + 建 sync_orphan_markers 表，sessions 表不动。** [`db.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/db.ts) L4-49 现状：`MIGRATIONS[0]` 的 `sessions` 表已预留 `last_synced_at REAL, remote_origin_device_id TEXT, remote_tombstoned_at REAL`（L11），`pinned_at` / `memory_enabled` / `model_binding` 也在；`messages` 表（L13-20）缺 `origin_device_id` / `created_locally_at`；`compact_markers`（L22-25）schema 不能改（M2a 红线——orphan 不得污染 `getLatestCompactMarker`，见决策 4b）。本次迁移：

   ```sql
   -- MIGRATIONS[3] M3b 双向同步：messages 表新增设备来源字段 + orphan marker 隔离表
   -- 旧数据回填 'legacy'（合并靠 id 去重，'legacy' 不影响正确性）
   -- created_locally_at 回填为 created_at（保单调性，旧消息端内序与创建时间一致）
   ALTER TABLE messages ADD COLUMN origin_device_id TEXT NOT NULL DEFAULT 'legacy';
   ALTER TABLE messages ADD COLUMN created_locally_at REAL;
   UPDATE messages SET created_locally_at = created_at WHERE created_locally_at IS NULL;
   CREATE INDEX IF NOT EXISTS idx_messages_origin ON messages(session_id, origin_device_id, created_locally_at);
   -- orphan marker 隔离表（评审命门 2）：锚点未对齐的 wire marker 暂存此处，
   -- 绝不入 compact_markers——避免被 getLatestCompactMarker 选中喂 buildEffectiveHistory 重演 M2a 毒 marker。
   -- 补齐缺失消息后由 mergeRemoteSession 脱孤转入 compact_markers + 删除本表对应行。
   CREATE TABLE sync_orphan_markers (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
     summary TEXT NOT NULL, last_compacted_message_id TEXT NOT NULL, created_at REAL NOT NULL,
     received_at REAL NOT NULL
   );
   CREATE INDEX idx_sync_orphan_markers_session ON sync_orphan_markers(session_id, created_at DESC);
   ```

   SQLite `ALTER TABLE ADD COLUMN` 不能加 `NOT NULL` 无默认值——必须 `DEFAULT 'legacy'`，老库迁移时所有现有行自动得 `'legacy'`，新行 `appendMessage` 显式传值覆盖。`sync_orphan_markers` 是新建表（迁移前不存在），`CREATE TABLE` 直接建即可。

2. **`appendMessage` 默认 `originDeviceId` 从 `PairingService.myFingerprint` 注入；PairingService 装配前移到 ChatStore 之前。** [`chat-store.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/chat-store.ts) L80-90 现签名 `appendMessage(m: Omit<RawMessage, 'sortOrder' | 'updatedAt'>)`——`Omit` 不含 `originDeviceId`/`createdLocallyAt`。改造：`RawMessage` 新增两可选字段（`originDeviceId?: string; createdLocallyAt?: number`），`appendMessage` 在缺失时回退到 `this.defaultOriginDeviceId`（构造时传入）+ `m.createdAt`。`ChatStore` 构造函数加可选第二参 `originDeviceId?: string`；测试中传 `'me'` 或省略（回退 `'local'`）。`legacy` 仅迁移时回填，新消息永不写 `'legacy'`。

   **装配时序问题（评审命门 3）**：[`src/minisd/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) 现状 L105 `new ChatStore(db)` 在 L442 `new PairingService(pairingStore, vault)` 之前——ChatStore 构造时拿不到 `pairingService.myFingerprint`。二选一选 **「PairingService 装配前移到 ChatStore 之前」**（推荐方案）：
   - 依据：`PairingStore` 只依赖 `root + vault`（L107 vault 在 L106 已就绪、root 在 L101 已就绪），`PairingService` 只依赖 `pairingStore + vault`，都不依赖 ChatStore/db，前移是纯顺序调整，不引入新依赖（noble 套件 M3a 已引入）
   - 落地：把 L438-442 的 `PairingStore` + `PairingService` 装配段整体上移到 L104 `openDb` 之后、L105 `new ChatStore` 之前；L105 改为 `new ChatStore(db, pairingService.myFingerprint)`；L442 处删除已上移的装配语句（保留 `remoteMethods` / `additionalVerify` 在原位——它们要等 `methods` 对象构造完才能 `Object.assign`）
   - 不选「`ChatStore.setOriginDeviceId` 延迟注入」的理由：ChatStore 在 L105 装配后立刻被多处引用（`AgentLoop` / `CompactEngine` / `SyncCoordinator` 等），若 `setOriginDeviceId` 注入前有任何 `appendMessage` 调用（启动期就有可能），会落 `originDeviceId='local'`，污染同步——前移方案从根上避免此风险
   - 测试影响：[`tests/chat-store.test.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/tests/chat-store.test.ts) L7 `new ChatStore(db)` 不传第二参，走 `'local'` 兜底——526 基线不回归

3. **线格式定义在 `src/minisd/sync/wire.ts`，字段名严格对齐 OM SyncedTypes。** [`SyncedTypes.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/SyncedTypes.swift)：
   - `SyncedMessage`（L64-124）字段：`id/sessionId/role/partsJson/tokenUsageJson/reasoningContent/streamInterruptCount/sortOrder/createdAt/updatedAt`——**OM 现状无 `originDeviceId`/`createdLocallyAt`**，M3b 线格式 `WireMessage` 在此基础上**追加**两字段（OM 侧加字段属 OM 实装，本计划只定义线格式契约）
   - `SyncedCompactMarker`（L128-183）字段：`id/sessionId/summary/firstKeptSortOrder/compactedCount/createdAt/uiBoundarySortOrder?/boundaryMessageId?/firstKeptMessageId?/lastCompactedMessageId?/version`——DM 本地 `CompactMarker`（[`shared/types.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/shared/types.ts) L60-67）只有 `id/sessionId/summary/lastCompactedMessageId/createdAt`，`WireCompactMarker` 出口时**按本地 `RawMessage` 序回填** `firstKeptSortOrder` / `firstKeptMessageId`（transient，不持久化），其余 OM 字段（`compactedCount` / `boundaryMessageId` / `uiBoundarySortOrder` / `version`）按合理默认填（`compactedCount` = 锚点前消息数，`version` = 2，余 `undefined`）
   - `SyncedSession`（L14-60）字段：DM `SessionMeta` 缺 `modelId` / `category`（DM 走 `model_binding`），线格式 `WireSession` 把 DM 的 `modelBinding` 透传为 `modelBinding`，`modelId` / `category` 填 `undefined`（OM 入口侧 hydrator 容忍缺字段）
   - `SyncedSessionFile`（L187-217）字段：`sessionId/relativePath/fileSize/mimeType?/updatedAt`——**OM 现状无 `originDeviceId`/`sha256`/`toolUseId`**，M3b 线格式 `WireSessionFile` 追加三字段（OM 侧加字段属 OM 实装）

   线格式 = JSON 序列化（不含 CKRecord wrapping，设计 §3.6 原文）。命名：`Wire*` 前缀，避免与 OM `Synced*` 混淆。

4. **`mergeSession` 算法在 `src/minisd/sync/merge.ts`，纯函数 + 单次 O(N log N)。** 设计 §1-M3b 伪代码（L89-103）落地：

   ```typescript
   function mergeSession(
     local: { messages: RawMessage[]; markers: CompactMarker[] },
     remote: { messages: WireMessage[]; markers: WireCompactMarker[] },
   ): { messages: RawMessage[]; markers: CompactMarker[]; orphanMarkerIds: string[] }
   ```

   - **三路去重**：`byId = new Map<string, RawMessage>()`，遍历 `[...local.messages, ...remote.messages]`，**id 重复时保留 local**（local 是「我端已落库的事实」，信任度高于 wire；这是 LWW-by-updatedAt 的退化——id 相同即同一条消息，parts_json 不会真改，只是元数据可能滞后，保留 local 避免无谓写）
   - **k 路归并排序**（评审命门 1 修订）：按 `originDeviceId` 把去重后的消息分成 k 条流，**流内**保持 `createdLocallyAt` 升序（设备内时钟单调），**流间**做 k 路归并——每次比较各流头的 `createdLocallyAt`，较小者出队；**平局**（同一 `createdLocallyAt`）用 `(originDeviceId 字典序, id 字典序)` 决出确定性。这样跨端时序交错（桌面 1-10 → 手机离线 11-20 → 桌面 21-30）会被正确排成交错序列，而不是「字典序主导」排成「桌面整块 + 手机整块」两大块。归并复杂度 O(N log k)（k 为设备数，实测 k ≤ 5），整体 O(N log N)。
     - 红线：`sortOrder` 仅作本地展示索引，归并结果出来后按 0,1,2,... 重排写回（不进 wire 事实源，[`SyncedTypes.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/SyncedTypes.swift) L72-76 注释明示「Best-effort hint only. Receivers MUST derive their own sort_order」）
     - 评审命门 1 指出：决策 4 旧文写了三种互相矛盾的规则（「按 `(originDeviceId, createdLocallyAt, id)` 稳定序」+「组间按 `originDeviceId` 字典序拼接」+「按各组的『首次 createdLocallyAt』稳定归并」）—— 字典序主导会打断跨设备对话流，已统一收敛为 k 路归并。Task 3 必备测试用例覆盖三段轮换场景。
   - **marker LWW**：`byMarkerId = new Map<string, CompactMarker>()`，id 重复取 `createdAt` 较晚者；同 `createdAt` 时 local 优先（避免远端覆盖本端刚落的 marker）
   - **锚换算时序**（§4.4 关键）：`WireCompactMarker` 入口换算 **必须发生在消息 k 路归并之后**——拿到 `mergedMessages` 后，对每个 wire marker：
     1. 优先取 `lastCompactedMessageId`（非空且存在于 `mergedMessages`）→ 直接用
     2. 缺失时取 `firstKeptMessageId` → 在 `mergedMessages` 上找该 id 的前一条消息 id 回算为 `lastCompactedMessageId`；若 `firstKeptMessageId` 不在 `mergedMessages` 或已是首条 → 标 `orphan`
     3. 两锚都缺失 → 用 `firstKeptSortOrder` 在 `mergedMessages` 上按本地 `sortOrder` 定位（legacy v1 链），仍失败标 `orphan`
     - **orphan marker 不得写入 `compact_markers` 表**（评审命门 2 修订：M2a 毒 marker 教训——orphan 锚点不存在于 `mergedMessages`，若被 `getLatestCompactMarker` 选中喂 `buildEffectiveHistory` 会重演「锚点找不到、effectiveHistory 被压成摘要占位 + 空」的毒 marker 场景；`SyncCoordinator` 内存态重启即丢，orphan 自动转正更糟）。改为落 `sync_orphan_markers` 表（见决策 1b），补齐缺失消息重算成功后才经 `appendCompactMarker` 正式落 `compact_markers`。
   - **单次 O(N log N)**：去重 O(N) + k 路归并 O(N log k) ≈ O(N log N)（k ≤ 5）——设计 §1-M3b「单次交换 O(N)」是乐观估计，实测 N < 10000 时 log N ≈ 13，与 O(N) 实际无差异，文档保留 O(N log N) 表述

4b. **`sync_orphan_markers` 表与 `compact_markers` 隔离（评审命门 2 新增）。** MIGRATIONS[3] 一并建独立表，schema 与 `compact_markers` 一致 + 多一个 `received_at`（入库时间，用于排查）：

   ```sql
   CREATE TABLE sync_orphan_markers (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
     summary TEXT NOT NULL, last_compacted_message_id TEXT NOT NULL, created_at REAL NOT NULL,
     received_at REAL NOT NULL
   );
   CREATE INDEX idx_sync_orphan_markers_session ON sync_orphan_markers(session_id, created_at DESC);
   ```

   - 理由（二选一中选「SQLite 表」）：a) 与 `compact_markers` 同库便于事务原子化（合并→orphan 入库 + marker LWW 落库 同一 `db.transaction`）；b) `dataDir JSON` 暂存方案在 minisd 重启后需重新读盘、与 `compact_markers` 跨表事务不兼容、且 OM 侧 sync V2 历史上 JSON 暂存曾出过反序列化丢字段 bug（见 [`ChatStoreSyncHydrators.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/ChatStoreSyncHydrators.swift) 注释），SQLite 表方案更稳。
   - 落库策略：`mergeSession` 返回 `orphanMarkerIds`，`mergeRemoteSession` 把对应 marker 的完整字段（含 wire 原始 `summary`/`createdAt`）`INSERT OR REPLACE` 进 `sync_orphan_markers`（不进 `compact_markers`）；下次 `mergeSession` 若 `mergedMessages` 补齐了缺失消息 → marker 脱孤 → `appendCompactMarker` 落 `compact_markers` + `DELETE FROM sync_orphan_markers WHERE id=?`。
   - `getLatestCompactMarker` 现有查询不动（只查 `compact_markers`），orphan 永不影响 `buildEffectiveHistory`。

5. **`mergeRemoteSession` 落库策略：`INSERT OR IGNORE` + `sortOrder` 重排。** [`chat-store.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/chat-store.ts) 新方法：

   ```typescript
   mergeRemoteSession(remote: { messages: WireMessage[]; markers: WireCompactMarker[]; session?: WireSession }, sessionId: string): { mergedCount: number; orphanMarkerIds: string[] }
   ```

   - 事务内：`listMessages` + `listCompactMarkers`（新方法，拿全量 marker 做 LWW）+ `listOrphanMarkers`（新方法，尝试脱孤）→ `mergeSession` → `INSERT OR IGNORE` 每条新消息（id 重复跳过，parts_json/role/created_at 永不改）→ `sortOrder` 按 `mergedMessages` 顺序 `UPDATE`（仅当本地 `sortOrder` 与合并后序不一致时更新，减少写）→ **非 orphan 的 marker** 经 `INSERT OR IGNORE` 入 `compact_markers`（id 重复时按 LWW 决定是否 `UPDATE summary/last_compacted_message_id`，**`created_at` 不改**——LWW by createdAt 已在 mergeSession 决出胜负）→ **orphan marker** 经 `INSERT OR REPLACE` 入 `sync_orphan_markers`（带 `received_at`，**不入 `compact_markers`**——评审命门 2 红线）→ 已脱孤的旧 orphan（`sync_orphan_markers` 里、本次 `mergedMessages` 已能定位锚点的）经 `appendCompactMarker` 转 `compact_markers` + `DELETE FROM sync_orphan_markers WHERE id=?` → `UPDATE sessions SET updated_at = MAX(local, remote) WHERE id = ?`（LWW on updatedAt）
   - **raw history 永不改写红线**：`INSERT OR IGNORE` 保证 id 重复时 parts_json/role/created_at 原样保留；`UPDATE` 只碰 `sort_order` / `updated_at` / marker 的 `summary` / `last_compacted_message_id`
   - **orphan 隔离红线**（评审命门 2）：`getLatestCompactMarker` 现查询不动（只查 `compact_markers`），orphan 永不污染 `buildEffectiveHistory`

6. **`sync.*` RPC 面权限边界。** 与 `remote.*` 同构（[`remote/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/remote/index.ts) `assertAuthMode` 模式）：

   | 方法 | local | pairing | remote | 用途 |
   |---|---|---|---|---|
   | `sync.push(sessionId, payload)` | ✅ | ❌ | ✅ | 推本端新增到对端 |
   | `sync.pull(sessionId, afterTs)` | ✅ | ❌ | ✅ | 拉对端增量 |
   | `sync.cursor(sessionIds?)` | ✅ | ❌ | ✅ | 查对端各会话 cursor |
   | `sync.list()` | ✅ | ❌ | ✅ | 列本地全量会话元数据 + cursor（首次连接对端用） |
   | `sync.ack(sessionId, lastMergedTs)` | ✅ | ❌ | ✅ | 确认已合并到某点（更新 `sessions.last_synced_at`） |

   - `pairing` 模式全拒（沿用 `guardBusinessMethod` 守卫——sync.* 在装配段同样被包装）
   - `local` + `remote` 都可调：`local` 走手动同步按钮 / CLI；`remote` 走对端 GUI/CLI 主动调（评审命门 4——对端收到 `sync.dirty` 广播后作为 RPC 客户端调 `sync.pull`，本端 SyncCoordinator 不主动推）
   - payload 大小限制：单次 `sync.push` 不超过 1MB（vitest 测试用例覆盖超限拒），超过走分批（M3b 实现简化：直接拒并要求对端用 `afterTs` 分批 `pull`）

7. **`SyncCoordinator` 在 `src/minisd/sync/coordinator.ts`，服务端被动 + 客户端驱动（评审命门 4 收敛）。** 设计 §1-M3b 三触达原写「心跳 5s `sync.cursor`」需要出站 RPC 客户端 + 对端地址簿——两者在 M3b 都不存在（M3a 只建了入站 RpcServer，没建出站 WS 客户端；对端地址簿属 M3c relay 的事）。M3b 收敛为「服务端被动 + 客户端驱动」：
   - **A. 事件驱动 pending 队列（服务端被动）**：`ChatStore` 新增钩子 `onDirty?: (sessionId: string) => void`（构造时注入），`appendMessage` / `appendCompactMarker` / `updateMessage` / `updateSessionTitle` / `setModelBinding` / `setMemoryEnabled` 调用后触发；`SyncCoordinator.onDirty(sid)` 把 sid 入 `pendingQueue: Set<string>`，去抖 200ms 后调 `rpc.broadcast('sync.dirty', { sessionId, cursor })`——**只向已连接的 remote 连接广播**（M3a 已建好的 PASETO 长连客户端），不主动连对端。对端 GUI / CLI 收到 `sync.dirty` 后作为 RPC 客户端调本端 `sync.pull` 拉取。
   - **B. 心跳触达移除**：评审命门 4 指出心跳轮询需要出站 RPC 客户端 + 对端地址簿，M3b 不实现。改为「`sync.dirty` 广播 + 客户端拉取」单向链路——已连接的 remote 客户端收到 `sync.dirty` 后自行决定是否 `sync.pull`，无需服务端轮询。心跳留 M3c relay 实装（写进非目标）。
   - **C. 手动（客户端驱动）**：CLI `deskminis-cli sync pull/push <sid/all>`（新增 `sync-cli.mjs`，仿 [`remote-cli.mjs`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/cli/remote-cli.mjs) 零依赖单文件）——CLI 作为 RPC 客户端用 local token 连本端 minisd 调 `sync.pull` / `sync.push`，或用 PASETO 连对端 minisd 调 `sync.pull`。

   `SyncCoordinator` 不持有任何出站连接，只在 `appendMessage` 等触发 `onDirty` 时向 `rpc` 已连接的 remote 客户端广播 `sync.dirty`——「对端在线」由「对端 GUI 长连本端」体现，本端不主动连对端。

8. **e2e 驱动起两个 standalone minisd 实例 + PASETO 远程调 `sync.pull` + openDb 直落 marker。** 仿 [`e2e-m3a-acceptance.mjs`](file:///c:/Users/24739/Downloads/openminis1/deskminis/scripts/e2e-m3a-acceptance.mjs) spawn 模式，起 A/B 两实例（各自 mkdtemp 数据根 + `DESKMINIS_TEST=1` + `MINISD_HOST=127.0.0.1` + 不同 port），用 M3a 配对码互连（A 调 `remote.pair.begin` → B 调 `remote.pair.complete` 拿到 A 的 fingerprint + authKey），然后：
   - A 端 `chat.sessions.create` + `chat.prompt` 多轮（fake provider）
   - **openDb 直落 marker**（评审命门 5b）：e2e 主进程用 `better-sqlite3` 直接 open A 的 `minis.db`（WAL 模式支持多进程共存——M2c 已实证 standalone minisd 与运行中应用同库并存），`INSERT INTO compact_markers` 落测试 marker（[`chat-context-info.test.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/tests/chat-context-info.test.ts) L91-97 先例的跨进程版）；Step 2 实测为准，若真报 disk I/O 再回退并在 commit 申报
   - A 端 `sync.push` → B 端 `mergeRemoteSession`
   - **PASETO 远程调 `sync.pull`**（评审命门 5a）：B 端用派生的 PASETO token 连 A 的 `?paseto=` 端点调 `sync.pull`，断言与 local token 拉取结果一致——`sync.*` 的 remote 面是本里程碑唯一新权限面，e2e 必须摸到
   - 断言：两端 `sync.pull` 拿到的消息 id 序列**逐位完全一致**（设计 §6 验收红线）+ 两端 `chat.contextInfo.usedTokens` 差值 **= 0**（estimateTokens 是确定性纯函数，effectiveHistory 一致则 token 数必相等）+ marker 同步成功（openDb 落的 marker 经 `sync.pull` 拉到 B 端）

## 文件结构总览（相对 main@916778d 基线的增量）

```
deskminis/
  package.json                           (改) 新增 e2e:m3b script
  src/shared/types.ts                    (改) RawMessage 新增 originDeviceId?/createdLocallyAt?
  src/minisd/store/db.ts                 (改) MIGRATIONS 追加 [3]：messages 表 +2 列 + 索引
  src/minisd/store/chat-store.ts         (改) ChatStore 构造 +originDeviceId；appendMessage 默认填充；新增 mergeRemoteSession/listCompactMarkers/getSessionCursor/listSyncedSessions
  src/minisd/sync/wire.ts                (新) Wire* 类型 + toWire/fromWire + CompactMarker 锚换算
  src/minisd/sync/merge.ts               (新) mergeSession 算法（三路去重 + 端内单调 + marker LWW + orphan）
  src/minisd/sync/coordinator.ts         (新) SyncCoordinator（pending 队列 + sync.dirty 广播，服务端被动）
  src/minisd/sync/rpc.ts                 (新) sync.* RPC 方法面 + assertAuthMode 守卫
  src/minisd/sync/index.ts               (新) 装配工厂（createSyncMethods + createSyncCoordinator）
  src/minisd/index.ts                    (改) 装配 sync.* + ChatStore 注入 pairingService.myFingerprint
  src/cli/sync-cli.mjs                   (新) 零依赖单文件 CLI（pull/push/status）
  tests/sync-wire.test.ts                (新) 线格式出入口 + CompactMarker 锚换算
  tests/sync-merge.test.ts               (新) mergeSession 算法
  tests/sync-chat-store.test.ts          (新) ChatStore 同步写入接口
  tests/sync-rpc.test.ts                 (新) sync.* RPC + authMode 分级
  tests/sync-coordinator.test.ts         (新) pending 队列 + 心跳
  tests/sync-cli.test.ts                 (新) CLI 子命令端到端
  scripts/e2e-m3b-acceptance.mjs         (新) e2e 驱动（两实例配对互连 + 同步 + 红线断言）
```

任务依赖：1 → 2 → 3 → 4 → 5 → 6 → 7（严格串行；3 消费 2，4 消费 1+3，5 消费 4，6 消费 5，7 消费 1-6 全链路）。

---

### Task 1 · schema 迁移 [3] + RawMessage 类型扩展

**Files:**
- Modify: `deskminis/src/minisd/store/db.ts`
- Modify: `deskminis/src/shared/types.ts`
- Modify: `deskminis/src/minisd/store/chat-store.ts`
- Test: `deskminis/tests/sync-schema.test.ts`

**Interfaces:**
- Consumes: 无（纯 schema 迁移 + 类型扩展）
- Produces（Task 4 依赖）:
  - `RawMessage` 新增可选字段 `originDeviceId?: string` / `createdLocallyAt?: number`（[`shared/types.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/shared/types.ts) L13-25）
  - `ChatStore` 构造函数 `constructor(private db: Database.Database, private defaultOriginDeviceId: string = 'local')`（[`chat-store.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/chat-store.ts) L13-14）
  - `appendMessage` 在 `m.originDeviceId` 缺失时回退 `this.defaultOriginDeviceId`，`m.createdLocallyAt` 缺失时回退 `m.createdAt`
  - `listMessages` 读回时附带 `originDeviceId` / `createdLocallyAt`
  - `MIGRATIONS[3]`：见架构决策 1（messages +2 列 + sync_orphan_markers 表 + 两索引）
  - `sync_orphan_markers` 表（评审命门 2）：orphan marker 隔离存放，`compact_markers` schema 一行不改

- [x] **Step 1: 写失败测试**

`deskminis/tests/sync-schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import type Database from 'better-sqlite3';

let db: Database.Database; let store: ChatStore;
beforeEach(() => { db = openDb(':memory:'); store = new ChatStore(db, 'me'); });

describe('MIGRATIONS[3] messages 表新列', () => {
  it('迁移后 messages 表有 origin_device_id / created_locally_at 列', () => {
    const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain('origin_device_id');
    expect(names).toContain('created_locally_at');
  });

  it('旧库迁移：现有消息 origin_device_id 回填 "legacy"，created_locally_at 回填 created_at', () => {
    // 直接插一条「老格式」消息（不通过 appendMessage，模拟迁移前数据）
    db.prepare(`INSERT INTO messages (id, session_id, role, parts_json, created_at, updated_at, sort_order, stream_interrupt_count)
      VALUES (?,?,?,?,?,?,?,?)`).run('OLD1', 'S1', 'user', '[]', 1000.5, 1000.5, 0, 0);
    // 迁移已在 openDb 时跑过——查回
    const row = db.prepare('SELECT origin_device_id, created_locally_at FROM messages WHERE id=?').get('OLD1') as any;
    expect(row.origin_device_id).toBe('legacy');
    expect(row.created_locally_at).toBe(1000.5);
  });

  it('新索引 idx_messages_origin 存在', () => {
    const idxs = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'").all() as { name: string }[];
    expect(idxs.map(i => i.name)).toContain('idx_messages_origin');
  });
});

describe('MIGRATIONS[3] sync_orphan_markers 表（评审命门 2）', () => {
  it('迁移后 sync_orphan_markers 表存在 + 字段齐全', () => {
    const cols = db.prepare("PRAGMA table_info(sync_orphan_markers)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'id', 'session_id', 'summary', 'last_compacted_message_id', 'created_at', 'received_at',
    ]));
  });

  it('idx_sync_orphan_markers_session 索引存在', () => {
    const idxs = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sync_orphan_markers'").all() as { name: string }[];
    expect(idxs.map(i => i.name)).toContain('idx_sync_orphan_markers_session');
  });

  it('compact_markers 表 schema 未改（M2a 红线：不增 is_orphan 列）', () => {
    const cols = db.prepare("PRAGMA table_info(compact_markers)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).not.toContain('is_orphan');
    expect(names).toEqual(['id', 'session_id', 'summary', 'last_compacted_message_id', 'created_at']);
  });
});

describe('ChatStore defaultOriginDeviceId', () => {
  it('appendMessage 缺省 originDeviceId → 用 defaultOriginDeviceId="me"', () => {
    const s = store.createSession();
    const m = store.appendMessage({
      id: 'M1', sessionId: s.id, role: 'user',
      parts: [{ type: 'text', value: 'hi' }], createdAt: store.nowEpoch(), streamInterruptCount: 0,
    });
    expect(m.originDeviceId).toBe('me');
    expect(m.createdLocallyAt).toBe(m.createdAt);
  });

  it('appendMessage 显式传 originDeviceId → 用传入值', () => {
    const s = store.createSession();
    const m = store.appendMessage({
      id: 'M2', sessionId: s.id, role: 'user',
      parts: [], createdAt: store.nowEpoch(), streamInterruptCount: 0,
      originDeviceId: 'remote-device-fp', createdLocallyAt: 9999.0,
    });
    expect(m.originDeviceId).toBe('remote-device-fp');
    expect(m.createdLocallyAt).toBe(9999.0);
  });

  it('listMessages 回读 originDeviceId / createdLocallyAt', () => {
    const s = store.createSession();
    store.appendMessage({
      id: 'M3', sessionId: s.id, role: 'user', parts: [], createdAt: 1234.5, streamInterruptCount: 0,
      originDeviceId: 'phone', createdLocallyAt: 5555.0,
    });
    const list = store.listMessages(s.id);
    expect(list[0].originDeviceId).toBe('phone');
    expect(list[0].createdLocallyAt).toBe(5555.0);
  });

  it('defaultOriginDeviceId 缺省 → "local"（保 ChatStore(db) 调用兼容）', () => {
    const s2 = new ChatStore(db);
    const s = s2.createSession();
    const m = s2.appendMessage({
      id: 'M4', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0,
    });
    expect(m.originDeviceId).toBe('local');
  });
});

describe('526 基线不回归', () => {
  it('chat-store.test.ts 既有用例仍绿（appendMessage 默认 sortOrder 递增）', () => {
    const s = store.createSession();
    const base = { sessionId: s.id, role: 'user' as const, parts: [], streamInterruptCount: 0 };
    store.appendMessage({ ...base, id: 'A', createdAt: 1.0 });
    store.appendMessage({ ...base, id: 'B', createdAt: 2.0 });
    const list = store.listMessages(s.id);
    expect(list.map(m => m.id)).toEqual(['A', 'B']);
    expect(list[1].sortOrder).toBe(1);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- sync-schema`
Expected: 全部 fail（`origin_device_id` 列不存在 / `RawMessage.originDeviceId` 类型不存在 / `ChatStore` 构造函数第二参不接受）

- [x] **Step 3: 实现**

`deskminis/src/minisd/store/db.ts`：在 `MIGRATIONS` 数组末尾追加 `[3]`（不碰 `[0]`/`[1]`/`[2]`）：

```typescript
  // [3] M3b 双向同步：messages 表新增设备来源字段 + sync_orphan_markers 隔离表（设计 §1-M3b / §4.2 / 评审命门 2）
  //  迁移一经发布不可改：已发布库 user_version=3，runner 只对 v<4 的库跑 MIGRATIONS[3]。
  //  旧数据回填：origin_device_id='legacy'（DEFAULT 自动），created_locally_at=created_at（UPDATE 显式）。
  //  'legacy' 仅作占位，合并靠 id 去重不影响正确性——新消息 appendMessage 永不写 'legacy'。
  //  sessions 表 MIGRATIONS[0] 已预留 last_synced_at/remote_origin_device_id/remote_tombstoned_at（L11），本次不动。
  //  compact_markers schema 一行不改（M2a 红线）——orphan 落 sync_orphan_markers 隔离表。
  `
  ALTER TABLE messages ADD COLUMN origin_device_id TEXT NOT NULL DEFAULT 'legacy';
  ALTER TABLE messages ADD COLUMN created_locally_at REAL;
  UPDATE messages SET created_locally_at = created_at WHERE created_locally_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_origin ON messages(session_id, origin_device_id, created_locally_at);
  CREATE TABLE sync_orphan_markers (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    summary TEXT NOT NULL, last_compacted_message_id TEXT NOT NULL, created_at REAL NOT NULL,
    received_at REAL NOT NULL
  );
  CREATE INDEX idx_sync_orphan_markers_session ON sync_orphan_markers(session_id, created_at DESC);
  `,
```

`deskminis/src/shared/types.ts` L13-25 `RawMessage` 新增两可选字段：

```typescript
export interface RawMessage {
  id: string;               // UUID 大写
  sessionId: string;
  role: Role;
  parts: ContentPart[];
  createdAt: number;        // epoch 秒（浮点）
  updatedAt: number;
  sortOrder: number;
  tokenUsage?: TokenUsage;
  reasoningContent?: string;
  streamInterruptCount: number;
  errorInfo?: string;       // 设备本地列，不同步
  // M3b 同步字段（设计 §4.2）
  originDeviceId?: string;      // 生成端 fingerprint；缺省=本机；旧数据迁移后='legacy'
  createdLocallyAt?: number;    // 端内单调时钟（epoch 秒）；缺省=createdAt
}
```

`deskminis/src/minisd/store/chat-store.ts`：
- L6-11 `MessageRow` 新增 `origin_device_id: string; created_locally_at: number | null`
- L13 `constructor(private db: Database.Database, private defaultOriginDeviceId: string = 'local') {}`
- L80-90 `appendMessage` 在构造 `full` 时填充 `originDeviceId` / `createdLocallyAt`，INSERT 语句加两列
- L102-111 `listMessages` 读回时附带两字段

- [x] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- sync-schema`
Expected: 11 passed（8 原有 + 3 sync_orphan_markers 表断言）
Run: `cd deskminis && npm test -- chat-store`
Expected: 既有 12 用例全绿（526 基线不回归）

- [x] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/store/db.ts deskminis/src/shared/types.ts deskminis/src/minisd/store/chat-store.ts deskminis/tests/sync-schema.test.ts && git commit -m "feat(m3b): schema迁移[3]+RawMessage加originDeviceId/createdLocallyAt(526基线不回归)"
```

---

### Task 2 · 线格式定义 + CompactMarker 锚换算

**Files:**
- Create: `deskminis/src/minisd/sync/wire.ts`
- Test: `deskminis/tests/sync-wire.test.ts`

**Interfaces:**
- Consumes: Task 1 `RawMessage` 新字段
- Produces（Task 3 依赖）:
  - `WireMessage`：对齐 [`SyncedTypes.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/SyncedTypes.swift) L64-124 `SyncedMessage`，**追加** `originDeviceId` / `createdLocallyAt`（OM 侧加字段属 OM 实装）
  - `WireCompactMarker`：双锚齐备，主锚 `lastCompactedMessageId`（§4.4）
  - `WireSession`：对齐 `SyncedSession`
  - `WireSessionFile`：对齐 `SyncedSessionFile` + 追加 `originDeviceId` / `sha256` / `toolUseId`
  - `toWireMessage(m: RawMessage): WireMessage`
  - `toWireMarker(m: CompactMarker, messages: RawMessage[]): WireCompactMarker`（出口时回填 `firstKeptSortOrder` / `firstKeptMessageId`）
  - `toWireSession(s: SessionMeta): WireSession`
  - `fromWireMessage(w: WireMessage): Pick<RawMessage, ...>`（不含 `sortOrder` / `updatedAt`，由 `mergeRemoteSession` 落库时定）
  - `resolveWireMarker(w: WireCompactMarker, mergedMessages: RawMessage[]): { marker: CompactMarker; isOrphan: boolean }`（§4.4 入口换算，**必须在 mergedMessages 上算**）

- [ ] **Step 1: 写失败测试**

`deskminis/tests/sync-wire.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { toWireMessage, toWireMarker, toWireSession, fromWireMessage, resolveWireMarker,
  type WireMessage, type WireCompactMarker, type WireSession } from '../src/minisd/sync/wire';
import type { RawMessage, CompactMarker, SessionMeta } from '../src/shared/types';

function mkMsg(id: string, sid: string, origin: string, localTs: number, sortOrder: number): RawMessage {
  return {
    id, sessionId: sid, role: 'user', parts: [{ type: 'text', value: 'x' }],
    createdAt: localTs, updatedAt: localTs, sortOrder, streamInterruptCount: 0,
    originDeviceId: origin, createdLocallyAt: localTs,
  };
}

describe('WireMessage 字段对齐 OM SyncedMessage', () => {
  it('toWireMessage 输出 id/sessionId/role/partsJson/originDeviceId/createdLocallyAt 等字段', () => {
    const m = mkMsg('M1', 'S1', 'me', 1000.0, 0);
    const w = toWireMessage(m);
    expect(w.id).toBe('M1');
    expect(w.sessionId).toBe('S1');
    expect(w.role).toBe('user');
    expect(w.partsJson).toBe(JSON.stringify([{ type: 'text', value: 'x' }]));
    expect(w.originDeviceId).toBe('me');
    expect(w.createdLocallyAt).toBe(1000.0);
    expect(w.streamInterruptCount).toBe(0);
    expect(typeof w.sortOrder).toBe('number'); // best-effort hint
  });

  it('fromWireMessage 还原为本地 RawMessage 输入（不含 sortOrder/updatedAt）', () => {
    const w: WireMessage = {
      id: 'W1', sessionId: 'S1', role: 'assistant', partsJson: '[]',
      tokenUsageJson: null, reasoningContent: null, streamInterruptCount: 0,
      sortOrder: 5, createdAt: 2000.0, updatedAt: 2000.0,
      originDeviceId: 'phone', createdLocallyAt: 1999.0,
    };
    const r = fromWireMessage(w);
    expect(r.id).toBe('W1');
    expect(r.role).toBe('assistant');
    expect(r.originDeviceId).toBe('phone');
    expect(r.createdLocallyAt).toBe(1999.0);
    expect((r as any).sortOrder).toBeUndefined();
    expect((r as any).updatedAt).toBeUndefined();
  });
});

describe('WireCompactMarker 双锚齐备', () => {
  it('toWireMarker 出口：lastCompactedMessageId 主锚 + firstKeptSortOrder/firstKeptMessageId 辅锚按本地序回填', () => {
    const sid = 'S1';
    const msgs = [mkMsg('A', sid, 'me', 1.0, 0), mkMsg('B', sid, 'me', 2.0, 1), mkMsg('C', sid, 'me', 3.0, 2)];
    const marker: CompactMarker = { id: 'MK1', sessionId: sid, summary: '摘要', lastCompactedMessageId: 'B', createdAt: 100.0 };
    const w = toWireMarker(marker, msgs);
    expect(w.id).toBe('MK1');
    expect(w.lastCompactedMessageId).toBe('B');
    expect(w.firstKeptMessageId).toBe('C'); // B 的下一条
    expect(w.firstKeptSortOrder).toBe(2);   // C 的 sortOrder
    expect(w.compactedCount).toBe(2);        // A, B 两条被压缩
    expect(w.version).toBe(2);
  });

  it('toWireMarker 锚=末条消息：firstKeptMessageId=undefined, firstKeptSortOrder=lastSortOrder+1', () => {
    const sid = 'S1';
    const msgs = [mkMsg('A', sid, 'me', 1.0, 0), mkMsg('B', sid, 'me', 2.0, 1)];
    const marker: CompactMarker = { id: 'MK2', sessionId: sid, summary: '摘要', lastCompactedMessageId: 'B', createdAt: 100.0 };
    const w = toWireMarker(marker, msgs);
    expect(w.firstKeptMessageId).toBeUndefined();
    expect(w.firstKeptSortOrder).toBe(2); // B.sortOrder(1) + 1
  });

  it('resolveWireMarker 入口：优先取 lastCompactedMessageId', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0), mkMsg('B', 'S', 'me', 2.0, 1)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: 'B', firstKeptSortOrder: 2, compactedCount: 2, version: 2,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(false);
    expect(r.marker.lastCompactedMessageId).toBe('B');
  });

  it('resolveWireMarker 入口：lastCompactedMessageId 缺失 → firstKeptMessageId 在合并序列回算（§4.4 时序）', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0), mkMsg('B', 'S', 'me', 2.0, 1), mkMsg('C', 'S', 'me', 3.0, 2)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: undefined,
      firstKeptMessageId: 'C', firstKeptSortOrder: 2, compactedCount: 2, version: 2,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(false);
    expect(r.marker.lastCompactedMessageId).toBe('B'); // C 的前一条
  });

  it('resolveWireMarker 入口：firstKeptMessageId 是合并序列首条 → orphan', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0), mkMsg('B', 'S', 'me', 2.0, 1)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: undefined,
      firstKeptMessageId: 'A', firstKeptSortOrder: 0, compactedCount: 0, version: 2,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(true);
  });

  it('resolveWireMarker 入口：firstKeptMessageId 不在合并序列 → orphan', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: undefined,
      firstKeptMessageId: 'MISSING', firstKeptSortOrder: 0, compactedCount: 0, version: 2,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(true);
  });

  it('resolveWireMarker 两锚都缺 → firstKeptSortOrder 按 sortOrder 回算（legacy v1 链）', () => {
    const merged = [mkMsg('A', 'S', 'me', 1.0, 0), mkMsg('B', 'S', 'me', 2.0, 1), mkMsg('C', 'S', 'me', 3.0, 2)];
    const w: WireCompactMarker = {
      id: 'MK', sessionId: 'S', summary: 'x', createdAt: 100.0,
      lastCompactedMessageId: undefined, firstKeptMessageId: undefined,
      firstKeptSortOrder: 2, compactedCount: 2, version: 1,
    };
    const r = resolveWireMarker(w, merged);
    expect(r.isOrphan).toBe(false);
    expect(r.marker.lastCompactedMessageId).toBe('B'); // sortOrder=2 的前一条
  });
});

describe('WireSession 字段对齐 OM SyncedSession', () => {
  it('toWireSession 输出 id/title/createdAt/updatedAt/memoryEnabled/modelBinding/pinnedAt', () => {
    const s: SessionMeta = { id: 'S1', title: '测试', createdAt: 1.0, updatedAt: 2.0, memoryEnabled: true, modelBinding: 'provider:abc', pinnedAt: 3.0 };
    const w = toWireSession(s);
    expect(w.id).toBe('S1');
    expect(w.title).toBe('测试');
    expect(w.createdAt).toBe(1.0);
    expect(w.updatedAt).toBe(2.0);
    expect(w.memoryEnabled).toBe(1);
    expect(w.modelBinding).toBe('provider:abc');
    expect(w.pinnedAt).toBe(3.0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- sync-wire`
Expected: 全部 fail（模块不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/sync/wire.ts`：

```typescript
import type { CompactMarker, RawMessage, SessionMeta, TokenUsage } from '../../shared/types';
import { serializeParts, parseParts } from '../../shared/parts';

/** 线格式 Message，对齐 OM SyncedMessage（SyncedTypes.swift L64-124）+ M3b 追加 originDeviceId/createdLocallyAt。 */
export interface WireMessage {
  id: string;
  sessionId: string;
  role: string;
  partsJson: string;
  tokenUsageJson: string | null;
  reasoningContent: string | null;
  streamInterruptCount: number;
  /** best-effort hint only（同 OM 注释 L72-76）： receivers MUST derive their own sort_order */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  // M3b 追加字段（OM 侧需加，本计划只定契约）
  originDeviceId: string;
  createdLocallyAt: number;
}

/** 线格式 CompactMarker，双锚齐备主锚 lastCompactedMessageId（§4.4）。 */
export interface WireCompactMarker {
  id: string;
  sessionId: string;
  summary: string;
  createdAt: number;
  lastCompactedMessageId?: string;
  firstKeptMessageId?: string;
  firstKeptSortOrder: number;
  compactedCount: number;
  boundaryMessageId?: string;
  uiBoundarySortOrder?: number;
  version: number;
}

export interface WireSession {
  id: string;
  title: string;
  category?: string;
  modelId?: string;
  createdAt: number;
  updatedAt: number;
  memoryEnabled: number;
  modelBinding?: string;
  pinnedAt?: number;
}

export interface WireSessionFile {
  sessionId: string;
  relativePath: string;
  fileSize: number;
  mimeType?: string;
  updatedAt: number;
  // M3b 追加字段（OM 侧需加）
  originDeviceId: string;
  sha256?: string;
  toolUseId?: string;
}

export function toWireMessage(m: RawMessage): WireMessage {
  return {
    id: m.id, sessionId: m.sessionId, role: m.role,
    partsJson: serializeParts(m.parts),
    tokenUsageJson: m.tokenUsage ? JSON.stringify(m.tokenUsage) : null,
    reasoningContent: m.reasoningContent ?? null,
    streamInterruptCount: m.streamInterruptCount,
    sortOrder: m.sortOrder, // best-effort
    createdAt: m.createdAt, updatedAt: m.updatedAt,
    originDeviceId: m.originDeviceId ?? 'legacy',
    createdLocallyAt: m.createdLocallyAt ?? m.createdAt,
  };
}

export function fromWireMessage(w: WireMessage): Omit<RawMessage, 'sortOrder' | 'updatedAt'> {
  return {
    id: w.id, sessionId: w.sessionId, role: w.role as RawMessage['role'],
    parts: parseParts(w.partsJson),
    createdAt: w.createdAt,
    tokenUsage: w.tokenUsageJson ? JSON.parse(w.tokenUsageJson) as TokenUsage : undefined,
    reasoningContent: w.reasoningContent ?? undefined,
    streamInterruptCount: w.streamInterruptCount,
    originDeviceId: w.originDeviceId,
    createdLocallyAt: w.createdLocallyAt,
  };
}

/** 出口：从本地 CompactMarker + 本地消息序列回填辅助锚。 */
export function toWireMarker(m: CompactMarker, messages: RawMessage[]): WireCompactMarker {
  const idx = messages.findIndex(x => x.id === m.lastCompactedMessageId);
  let firstKeptMessageId: string | undefined;
  let firstKeptSortOrder: number;
  if (idx >= 0 && idx + 1 < messages.length) {
    firstKeptMessageId = messages[idx + 1].id;
    firstKeptSortOrder = messages[idx + 1].sortOrder;
  } else if (idx >= 0) {
    // 锚=末条：firstKept 不存在，sortOrder = 末条 + 1
    firstKeptSortOrder = messages[idx].sortOrder + 1;
  } else {
    // 锚不在本地序（理论不该发生，防兜底）
    firstKeptSortOrder = 0;
  }
  return {
    id: m.id, sessionId: m.sessionId, summary: m.summary, createdAt: m.createdAt,
    lastCompactedMessageId: m.lastCompactedMessageId,
    firstKeptMessageId, firstKeptSortOrder,
    compactedCount: idx + 1, // 锚点前的消息数
    version: 2,
  };
}

/**
 * 入口：在 **合并排序后的消息序列** 上回算（§4.4 时序关键）。
 * 必须在 mergeSession() 完成消息合并排序之后调用——不能对 wire 原始记录直接算。
 */
export function resolveWireMarker(
  w: WireCompactMarker,
  mergedMessages: RawMessage[],
): { marker: CompactMarker; isOrphan: boolean } {
  const marker: CompactMarker = {
    id: w.id, sessionId: w.sessionId, summary: w.summary,
    lastCompactedMessageId: w.lastCompactedMessageId ?? '', // 占位，下面回填
    createdAt: w.createdAt,
  };
  // 1. 优先取 lastCompactedMessageId（非空且存在于 mergedMessages）
  if (w.lastCompactedMessageId) {
    const found = mergedMessages.some(m => m.id === w.lastCompactedMessageId);
    if (found) {
      marker.lastCompactedMessageId = w.lastCompactedMessageId;
      return { marker, isOrphan: false };
    }
  }
  // 2. 缺失/未命中 → firstKeptMessageId 在 mergedMessages 上找前一条
  if (w.firstKeptMessageId) {
    const idx = mergedMessages.findIndex(m => m.id === w.firstKeptMessageId);
    if (idx > 0) {
      marker.lastCompactedMessageId = mergedMessages[idx - 1].id;
      return { marker, isOrphan: false };
    }
    // idx === 0 → firstKept 是首条，无前一条 → orphan
    return { marker, isOrphan: true };
  }
  // 3. 两锚都缺 → firstKeptSortOrder 在 mergedMessages 上按 sortOrder 定位（legacy v1 链）
  const idxBySort = mergedMessages.findIndex(m => m.sortOrder === w.firstKeptSortOrder);
  if (idxBySort > 0) {
    marker.lastCompactedMessageId = mergedMessages[idxBySort - 1].id;
    return { marker, isOrphan: false };
  }
  return { marker, isOrphan: true };
}

export function toWireSession(s: SessionMeta): WireSession {
  return {
    id: s.id, title: s.title,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
    memoryEnabled: s.memoryEnabled === false ? 0 : 1,
    modelBinding: s.modelBinding,
    pinnedAt: s.pinnedAt,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- sync-wire`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/sync/wire.ts deskminis/tests/sync-wire.test.ts && git commit -m "feat(m3b): 线格式Wire*对齐OM SyncedTypes+CompactMarker双锚换算(§4.4时序)"
```

---

### Task 3 · mergeSession 算法（三路去重 + 端内单调 + marker LWW + orphan）

**Files:**
- Create: `deskminis/src/minisd/sync/merge.ts`
- Test: `deskminis/tests/sync-merge.test.ts`

**Interfaces:**
- Consumes: Task 2 `WireMessage` / `WireCompactMarker` / `resolveWireMarker` / `fromWireMessage`
- Produces（Task 4 依赖）:
  - `mergeSession(local, remote): { messages: RawMessage[]; markers: CompactMarker[]; orphanMarkerIds: string[] }`
  - 纯函数（无副作用，不碰 DB）

- [ ] **Step 1: 写失败测试**

`deskminis/tests/sync-merge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mergeSession } from '../src/minisd/sync/merge';
import { toWireMessage, toWireMarker, type WireMessage, type WireCompactMarker } from '../src/minisd/sync/wire';
import type { RawMessage, CompactMarker } from '../src/shared/types';

function mkMsg(id: string, sid: string, origin: string, localTs: number, sortOrder: number): RawMessage {
  return {
    id, sessionId: sid, role: 'user', parts: [{ type: 'text', value: 'x' }],
    createdAt: localTs, updatedAt: localTs, sortOrder, streamInterruptCount: 0,
    originDeviceId: origin, createdLocallyAt: localTs,
  };
}
function toWire(m: RawMessage): WireMessage { return toWireMessage(m); }

describe('mergeSession 三路去重', () => {
  it('local 与 remote 各有不同 id → 合并后全部出现', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    const remote = { messages: [toWire(mkMsg('B', sid, 'phone', 2.0, 0))], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.id).sort()).toEqual(['A', 'B']);
  });

  it('id 重复 → 保留 local（信任本端已落库）', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    // 同 id 不同 origin（理论不会发生，但容错）
    const remoteMsg = { ...toWire(mkMsg('A', sid, 'phone', 2.0, 5)) };
    const remote = { messages: [remoteMsg], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].originDeviceId).toBe('me'); // local 胜
  });
});

describe('mergeSession k 路归并（评审命门 1）', () => {
  it('同一 originDeviceId 内按 createdLocallyAt 升序（流内单调）', () => {
    const sid = 'S1';
    // 故意乱序输入
    const local = { messages: [mkMsg('B', sid, 'me', 2.0, 1), mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    const remote = { messages: [], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.id)).toEqual(['A', 'B']);
  });

  it('跨端时序交错：桌面 1-3 → 手机 4-6 → 桌面 7-9 → 交错排列（非字典序两大块）', () => {
    const sid = 'S1';
    // 桌面 ts=1,2,3,7,8,9；手机 ts=4,5,6（手机离线期 ts 在桌面之后、桌面恢复前）
    // 期望 k 路归并按 createdLocallyAt 交错：1,2,3,4,5,6,7,8,9
    // ——旧「字典序主导」会把桌面 7,8,9 排到手机 4,5,6 前面，错
    const local = {
      messages: [
        mkMsg('D1', sid, 'desk', 1.0, 0), mkMsg('D2', sid, 'desk', 2.0, 1), mkMsg('D3', sid, 'desk', 3.0, 2),
        mkMsg('D4', sid, 'desk', 7.0, 3), mkMsg('D5', sid, 'desk', 8.0, 4), mkMsg('D6', sid, 'desk', 9.0, 5),
      ],
      markers: [],
    };
    const remote = {
      messages: [
        toWire(mkMsg('P1', sid, 'phone', 4.0, 0)),
        toWire(mkMsg('P2', sid, 'phone', 5.0, 1)),
        toWire(mkMsg('P3', sid, 'phone', 6.0, 2)),
      ],
      markers: [],
    };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.id)).toEqual(['D1','D2','D3','P1','P2','P3','D4','D5','D6']);
  });

  it('跨端平局：同 createdLocallyAt 用 (originDeviceId 字典序, id) 决出确定性', () => {
    const sid = 'S1';
    // desk 与 phone 同 ts=5.0，desk 字典序在前
    const local = { messages: [mkMsg('D', sid, 'desk', 5.0, 0)], markers: [] };
    const remote = { messages: [toWire(mkMsg('P', sid, 'phone', 5.0, 0))], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.id)).toEqual(['D', 'P']);
  });

  it('两端独立调用 mergeSession 结果逐位一致（评审命门 1 验收红线）', () => {
    const sid = 'S1';
    // 桌面视角：local=desk 消息 + remote=phone wire
    const deskLocal = {
      messages: [
        mkMsg('D1', sid, 'desk', 1.0, 0), mkMsg('D2', sid, 'desk', 3.0, 1), mkMsg('D3', sid, 'desk', 5.0, 2),
      ],
      markers: [],
    };
    const phoneWire = {
      messages: [
        toWire(mkMsg('P1', sid, 'phone', 2.0, 0)),
        toWire(mkMsg('P2', sid, 'phone', 4.0, 1)),
      ],
      markers: [],
    };
    const fromDesk = mergeSession(deskLocal, phoneWire).messages.map(m => m.id);
    // 手机视角：local=phone 消息 + remote=desk wire（toWire 转换）
    const phoneLocal = {
      messages: [
        mkMsg('P1', sid, 'phone', 2.0, 0), mkMsg('P2', sid, 'phone', 4.0, 1),
      ],
      markers: [],
    };
    const deskWire = {
      messages: [
        toWire(mkMsg('D1', sid, 'desk', 1.0, 0)),
        toWire(mkMsg('D2', sid, 'desk', 3.0, 1)),
        toWire(mkMsg('D3', sid, 'desk', 5.0, 2)),
      ],
      markers: [],
    };
    const fromPhone = mergeSession(phoneLocal, deskWire).messages.map(m => m.id);
    expect(fromDesk).toEqual(fromPhone);
    expect(fromDesk).toEqual(['D1','P1','D2','P2','D3']);
  });

  it('sortOrder 按 mergedMessages 顺序重排（0,1,2,...）', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 5), mkMsg('B', sid, 'me', 2.0, 3)], markers: [] };
    const remote = { messages: [toWire(mkMsg('C', sid, 'phone', 100.0, 99))], markers: [] };
    const r = mergeSession(local, remote);
    expect(r.messages.map(m => m.sortOrder)).toEqual([0, 1, 2]);
  });
});

describe('mergeSession marker LWW', () => {
  it('两端 marker id 不同 → 全部保留', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [{ id: 'MK1', sessionId: sid, summary: '旧', lastCompactedMessageId: 'A', createdAt: 100.0 }] };
    const remote = { messages: [], markers: [{ id: 'MK2', sessionId: sid, summary: '新', lastCompactedMessageId: 'A', createdAt: 200.0, firstKeptSortOrder: 1, compactedCount: 1, version: 2 } as WireCompactMarker] };
    const r = mergeSession(local, remote);
    expect(r.markers).toHaveLength(2);
  });

  it('marker id 重复 → createdAt 较晚者胜', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [{ id: 'MK', sessionId: sid, summary: 'local旧', lastCompactedMessageId: 'A', createdAt: 100.0 }] };
    const remote = { messages: [], markers: [{ id: 'MK', sessionId: sid, summary: 'remote新', lastCompactedMessageId: 'A', createdAt: 200.0, firstKeptSortOrder: 1, compactedCount: 1, version: 2 } as WireCompactMarker] };
    const r = mergeSession(local, remote);
    expect(r.markers).toHaveLength(1);
    expect(r.markers[0].summary).toBe('remote新');
  });

  it('marker 同 createdAt 同 id → local 优先（避免远端覆盖本端刚落的）', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [{ id: 'MK', sessionId: sid, summary: 'local', lastCompactedMessageId: 'A', createdAt: 100.0 }] };
    const remote = { messages: [], markers: [{ id: 'MK', sessionId: sid, summary: 'remote', lastCompactedMessageId: 'A', createdAt: 100.0, firstKeptSortOrder: 1, compactedCount: 1, version: 2 } as WireCompactMarker] };
    const r = mergeSession(local, remote);
    expect(r.markers[0].summary).toBe('local');
  });
});

describe('mergeSession 锚换算时序（§4.4）', () => {
  it('remote marker 只带 firstKeptMessageId → 在合并序列上回算 lastCompactedMessageId', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0), mkMsg('B', sid, 'me', 2.0, 1), mkMsg('C', sid, 'me', 3.0, 2)], markers: [] };
    const remote = {
      messages: [],
      markers: [{
        id: 'MK', sessionId: sid, summary: 'phone压缩', createdAt: 200.0,
        lastCompactedMessageId: undefined, firstKeptMessageId: 'C',
        firstKeptSortOrder: 2, compactedCount: 2, version: 2,
      } as WireCompactMarker],
    };
    const r = mergeSession(local, remote);
    expect(r.markers).toHaveLength(1);
    expect(r.markers[0].lastCompactedMessageId).toBe('B'); // C 的前一条
    expect(r.orphanMarkerIds).toEqual([]);
  });

  it('remote marker firstKeptMessageId 在 mergedMessages 首条 → orphan', () => {
    const sid = 'S1';
    const local = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    const remote = {
      messages: [],
      markers: [{
        id: 'MK', sessionId: sid, summary: 'phone压缩', createdAt: 200.0,
        lastCompactedMessageId: undefined, firstKeptMessageId: 'A',
        firstKeptSortOrder: 0, compactedCount: 0, version: 2,
      } as WireCompactMarker],
    };
    const r = mergeSession(local, remote);
    expect(r.orphanMarkerIds).toEqual(['MK']);
    // orphan marker 仍返回（mergeRemoteSession 据此落 sync_orphan_markers，不落 compact_markers）
    expect(r.markers.map(m => m.id)).toContain('MK');
  });

  it('orphan marker 脱孤：补齐缺失消息后 next mergeSession 不再标 orphan', () => {
    const sid = 'S1';
    // 第一次合并：A 在 local，phone marker firstKeptMessageId='B'（B 不在 mergedMessages）→ orphan
    const local1 = { messages: [mkMsg('A', sid, 'me', 1.0, 0)], markers: [] };
    const remote1 = {
      messages: [],
      markers: [{
        id: 'MK', sessionId: sid, summary: 'phone压缩', createdAt: 200.0,
        lastCompactedMessageId: undefined, firstKeptMessageId: 'B',
        firstKeptSortOrder: 1, compactedCount: 1, version: 2,
      } as WireCompactMarker],
    };
    const r1 = mergeSession(local1, remote1);
    expect(r1.orphanMarkerIds).toEqual(['MK']);

    // 第二次合并：B 已补齐到 local（模拟 sync.pull 拿到了 B）
    const local2 = { messages: [mkMsg('A', sid, 'me', 1.0, 0), mkMsg('B', sid, 'me', 2.0, 1)], markers: [] };
    const remote2 = remote1; // 同一 marker wire
    const r2 = mergeSession(local2, remote2);
    expect(r2.orphanMarkerIds).toEqual([]);
    expect(r2.markers[0].lastCompactedMessageId).toBe('A'); // B 的前一条
  });
});

describe('mergeSession 单次 O(N) 复杂度（用例覆盖，非真实测时）', () => {
  it('100 条消息两端各 50 → 合并 100 条，sortOrder 0-99', () => {
    const sid = 'S1';
    const localMsgs = Array.from({ length: 50 }, (_, i) => mkMsg(`L${i}`, sid, 'me', i, i));
    const remoteMsgs = Array.from({ length: 50 }, (_, i) => toWire(mkMsg(`R${i}`, sid, 'phone', 100 + i, i)));
    const r = mergeSession({ messages: localMsgs, markers: [] }, { messages: remoteMsgs, markers: [] });
    expect(r.messages).toHaveLength(100);
    expect(r.messages.map(m => m.sortOrder)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- sync-merge`
Expected: 全部 fail（模块不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/sync/merge.ts`：

```typescript
import type { CompactMarker, RawMessage } from '../../shared/types';
import { fromWireMessage, resolveWireMarker, type WireCompactMarker, type WireMessage } from './wire';

export interface MergeInput {
  messages: RawMessage[];
  markers: CompactMarker[];
}
export interface WireMergeInput {
  messages: WireMessage[];
  markers: WireCompactMarker[];
}
export interface MergeResult {
  messages: RawMessage[];
  markers: CompactMarker[];
  orphanMarkerIds: string[];
}

/**
 * 合并本地与远端会话数据（设计 §1-M3b / §4.4）。
 * 单次 O(N log N)（去重 O(N) + k 路归并 O(N log k)，k ≤ 5）。
 *
 * 红线：
 *  - raw history 追加型永不改写——id 重复时保留 local（信任本端已落库）
 *  - sortOrder 只是本地展示索引，合并后按统一序重排
 *  - marker 锚换算必须在 k 路归并后做（§4.4 时序关键）
 *  - orphan marker 不入 compact_markers（评审命门 2）——只返回 orphanMarkerIds，由 mergeRemoteSession 落 sync_orphan_markers
 */
export function mergeSession(local: MergeInput, remote: WireMergeInput): MergeResult {
  // 1. 三路去重（id 为准），重复时保留 local
  const byId = new Map<string, RawMessage>();
  for (const m of local.messages) byId.set(m.id, m);
  for (const w of remote.messages) {
    if (!byId.has(w.id)) {
      byId.set(w.id, fromWireMessage(w) as RawMessage);
    }
  }

  // 2. k 路归并（评审命门 1）：按 originDeviceId 分流，流内 createdLocallyAt 升序，流间归并按流头 ts
  //    平局用 (originDeviceId 字典序, id 字典序) 决出确定性——保证两端独立调用结果逐位一致。
  const streams = new Map<string, RawMessage[]>();
  for (const m of byId.values()) {
    const origin = m.originDeviceId ?? 'legacy';
    const arr = streams.get(origin);
    if (arr) arr.push(m); else streams.set(origin, [m]);
  }
  // 流内排序（稳定：createdLocallyAt 升序，平局 id 字典序）
  for (const arr of streams.values()) {
    arr.sort((a, b) => {
      const ta = a.createdLocallyAt ?? a.createdAt;
      const tb = b.createdLocallyAt ?? b.createdAt;
      if (ta !== tb) return ta - tb;
      return a.id < b.id ? -1 : 1;
    });
  }
  // k 路归并：用最小堆（实测 k ≤ 5，简单线性扫流头即可，O(N·k) ≈ O(N log k) 当 k 小）
  const heads: { origin: string; msg: RawMessage }[] = [];
  const streamArr = Array.from(streams.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1); // 流间按 origin 字典序（仅影响平局时取流顺序）
  const cursors = new Map<string, number>();
  for (const [origin, arr] of streamArr) {
    cursors.set(origin, 0);
    heads.push({ origin, msg: arr[0] });
  }
  const merged: RawMessage[] = [];
  while (heads.length > 0) {
    // 找流头 ts 最小者；平局用 (origin 字典序, id 字典序)
    let pickIdx = 0;
    for (let i = 1; i < heads.length; i++) {
      const a = heads[pickIdx].msg, b = heads[i].msg;
      const ta = a.createdLocallyAt ?? a.createdAt;
      const tb = b.createdLocallyAt ?? b.createdAt;
      if (ta !== tb) { if (tb < ta) pickIdx = i; continue; }
      // 平局：origin 字典序
      if (heads[i].origin < heads[pickIdx].origin) { pickIdx = i; continue; }
      if (heads[i].origin > heads[pickIdx].origin) continue;
      // 仍平局：id 字典序
      if (b.id < a.id) pickIdx = i;
    }
    const picked = heads[pickIdx];
    merged.push(picked.msg);
    const arr = streams.get(picked.origin)!;
    const next = ++cursors.get(picked.origin)!;
    if (next < arr.length) {
      heads[pickIdx] = { origin: picked.origin, msg: arr[next] };
    } else {
      heads.splice(pickIdx, 1);
    }
  }

  // 3. sortOrder 按合并后顺序重排（0,1,2,...）
  merged.forEach((m, i) => { m.sortOrder = i; });

  // 4. marker LWW：id 重复取 createdAt 较晚者；同 createdAt local 优先
  const byMarkerId = new Map<string, { marker: CompactMarker; createdAt: number; isLocal: boolean }>();
  for (const m of local.markers) {
    byMarkerId.set(m.id, { marker: m, createdAt: m.createdAt, isLocal: true });
  }
  // remote markers 先转 wire → resolveWireMarker（在 merged 上回算）→ 再 LWW
  const orphanMarkerIds: string[] = [];
  const resolvedRemote: CompactMarker[] = [];
  for (const w of remote.markers) {
    const { marker, isOrphan } = resolveWireMarker(w, merged);
    if (isOrphan) orphanMarkerIds.push(marker.id);
    resolvedRemote.push(marker);
  }
  for (const m of resolvedRemote) {
    const existing = byMarkerId.get(m.id);
    if (!existing) {
      byMarkerId.set(m.id, { marker: m, createdAt: m.createdAt, isLocal: false });
    } else {
      // LWW：createdAt 较晚者胜；同 createdAt local 优先
      if (m.createdAt > existing.createdAt) {
        byMarkerId.set(m.id, { marker: m, createdAt: m.createdAt, isLocal: false });
      }
      // 否则保留 existing（local 优先）
    }
  }

  return {
    messages: merged,
    markers: Array.from(byMarkerId.values()).map(x => x.marker),
    orphanMarkerIds,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- sync-merge`
Expected: 17 passed（14 原有 + k 路归并交错场景 + 跨端平局 + 两端独立调用一致 + orphan 脱孤）

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/sync/merge.ts deskminis/tests/sync-merge.test.ts && git commit -m "feat(m3b): mergeSession算法(三路去重+k路归并+marker LWW+orphan隔离,§4.4时序,评审命门1/2)"
```

---

### Task 4 · ChatStore 同步写入接口

**Files:**
- Modify: `deskminis/src/minisd/store/chat-store.ts`
- Test: `deskminis/tests/sync-chat-store.test.ts`

**Interfaces:**
- Consumes: Task 1 schema + Task 3 `mergeSession`
- Produces（Task 5 依赖）:
  - `ChatStore.mergeRemoteSession(remote: { messages: WireMessage[]; markers: WireCompactMarker[]; session?: WireSession }, sessionId: string): { mergedCount: number; orphanMarkerIds: string[] }`
  - `ChatStore.listCompactMarkers(sessionId: string): CompactMarker[]`（M3b 新增，mergeSession 需要全量 marker 做 LWW）
  - `ChatStore.listOrphanMarkers(sessionId: string): CompactMarker[]`（M3b 新增，评审命门 2——尝试脱孤：把 `sync_orphan_markers` 里、本次 `mergedMessages` 已能定位锚点的 marker 转入 `compact_markers`）
  - `ChatStore.getSessionCursor(sessionId: string): { lastMessageTs: number; lastMarkerTs: number }`（供 sync.cursor）
  - `ChatStore.listSyncedSessions(): Array<SessionMeta & { cursor: { lastMessageTs: number; lastMarkerTs: number } }>`（首次连接对端用）
  - `onDirty?: (sessionId: string) => void`（构造时可选注入，Task 6 SyncCoordinator 用）
  - orphan 隔离红线：`getLatestCompactMarker` 现查询不动（只查 `compact_markers`），orphan 永不污染 `buildEffectiveHistory`

- [ ] **Step 1: 写失败测试**

`deskminis/tests/sync-chat-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { toWireMessage, toWireMarker, type WireMessage, type WireCompactMarker } from '../src/minisd/sync/wire';
import type Database from 'better-sqlite3';

let db: Database.Database; let store: ChatStore;
beforeEach(() => { db = openDb(':memory:'); store = new ChatStore(db, 'me'); });

function mkMsg(id: string, sid: string, origin: string, localTs: number, sortOrder: number) {
  return {
    id, sessionId: sid, role: 'user' as const,
    parts: [{ type: 'text' as const, value: 'x' }],
    createdAt: localTs, updatedAt: localTs, sortOrder, streamInterruptCount: 0,
    originDeviceId: origin, createdLocallyAt: localTs,
  };
}

describe('ChatStore.mergeRemoteSession', () => {
  it('远端新消息 → INSERT OR IGNORE 落库', () => {
    const s = store.createSession();
    const remote: WireMessage[] = [toWireMessage(mkMsg('R1', s.id, 'phone', 100.0, 0) as any)];
    const r = store.mergeRemoteSession({ messages: remote, markers: [] }, s.id);
    expect(r.mergedCount).toBe(1);
    const list = store.listMessages(s.id);
    expect(list.map(m => m.id)).toContain('R1');
    expect(list.find(m => m.id === 'R1')?.originDeviceId).toBe('phone');
  });

  it('id 重复 → 跳过（parts_json 永不改写红线）', () => {
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('DUP', s.id, 'me', 1.0, 0), parts: [{ type: 'text', value: 'local原文' }] });
    // 远端同 id 不同 parts（理论不会，但容错测试）
    const remoteMsg = { ...toWireMessage(mkMsg('DUP', s.id, 'phone', 2.0, 5) as any), partsJson: JSON.stringify([{ type: 'text', value: 'remote篡改' }]) };
    store.mergeRemoteSession({ messages: [remoteMsg], markers: [] }, s.id);
    const list = store.listMessages(s.id);
    expect(list.find(m => m.id === 'DUP')?.parts).toEqual([{ type: 'text', value: 'local原文' }]); // local 胜
  });

  it('sortOrder 按合并后序重排（UPDATE sort_order，不改 parts_json）', () => {
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('A', s.id, 'me', 2.0, 0), parts: [{ type: 'text', value: 'a' }] });
    store.appendMessage({ ...mkMsg('B', s.id, 'me', 1.0, 1), parts: [{ type: 'text', value: 'b' }] });
    // 远端推一条更早的 → sortOrder 重排
    store.mergeRemoteSession({ messages: [toWireMessage(mkMsg('Z', s.id, 'aaa', 0.5, 0) as any)], markers: [] }, s.id);
    const list = store.listMessages(s.id);
    expect(list.map(m => m.id)).toEqual(['Z', 'B', 'A']); // (originDeviceId, createdLocallyAt) 序
    expect(list.map(m => m.sortOrder)).toEqual([0, 1, 2]);
    // parts 不变
    expect(list.find(m => m.id === 'A')?.parts).toEqual([{ type: 'text', value: 'a' }]);
  });

  it('远端 marker → INSERT OR IGNORE + LWW 决定是否 UPDATE', () => {
    const s = store.createSession();
    store.appendMessage(mkMsg('A', s.id, 'me', 1.0, 0) as any);
    store.appendCompactMarker(s.id, 'local摘要', 'A');
    // 远端同 id 不同 summary，createdAt 更晚 → LWW 远端胜
    const localMarker = store.getLatestCompactMarker(s.id)!;
    const remoteMarker: WireCompactMarker = {
      id: localMarker.id, sessionId: s.id, summary: 'remote摘要', createdAt: localMarker.createdAt + 100,
      lastCompactedMessageId: 'A', firstKeptSortOrder: 1, compactedCount: 1, version: 2,
    };
    store.mergeRemoteSession({ messages: [], markers: [remoteMarker] }, s.id);
    const got = store.getLatestCompactMarker(s.id);
    expect(got?.summary).toBe('remote摘要');
  });

  it('session 元数据 LWW on updatedAt', () => {
    const s = store.createSession();
    const oldUpdatedAt = s.updatedAt;
    const remote = { messages: [], markers: [], session: { id: s.id, title: '远端改名', createdAt: s.createdAt, updatedAt: oldUpdatedAt + 100, memoryEnabled: 1 } };
    store.mergeRemoteSession(remote as any, s.id);
    const got = store.getSession(s.id);
    expect(got?.title).toBe('远端改名');
    expect(got?.updatedAt).toBe(oldUpdatedAt + 100);
  });

  it('raw history 永不改写：UPDATE 只碰 sort_order / updated_at，不改 parts_json / role / created_at', () => {
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('A', s.id, 'me', 1.0, 0), role: 'user', parts: [{ type: 'text', value: '原文' }] });
    // 故意推一条同 id 不同 role/parts/createdAt 的远端消息
    const hack: WireMessage = {
      ...toWireMessage(mkMsg('A', s.id, 'phone', 999.0, 5) as any),
      role: 'assistant', partsJson: JSON.stringify([{ type: 'text', value: '篡改' }]),
    };
    store.mergeRemoteSession({ messages: [hack], markers: [] }, s.id);
    const row = db.prepare('SELECT parts_json, role, created_at FROM messages WHERE id=?').get('A') as any;
    expect(row.role).toBe('user'); // 不改
    expect(JSON.parse(row.parts_json)).toEqual([{ type: 'text', value: '原文' }]); // 不改
    expect(row.created_at).toBe(1.0); // 不改
  });

  it('orphan marker 入 sync_orphan_markers，不入 compact_markers（评审命门 2 红线）', () => {
    const s = store.createSession();
    store.appendMessage(mkMsg('A', s.id, 'me', 1.0, 0) as any);
    // 远端 marker firstKeptMessageId='B'（B 不在本地）→ orphan
    const remoteMarker: WireCompactMarker = {
      id: 'MK_ORPHAN', sessionId: s.id, summary: 'phone压缩', createdAt: 200.0,
      lastCompactedMessageId: undefined, firstKeptMessageId: 'B',
      firstKeptSortOrder: 1, compactedCount: 1, version: 2,
    };
    const r = store.mergeRemoteSession({ messages: [], markers: [remoteMarker] }, s.id);
    expect(r.orphanMarkerIds).toEqual(['MK_ORPHAN']);
    // orphan 行在 sync_orphan_markers
    const orphanRow = db.prepare('SELECT id, summary FROM sync_orphan_markers WHERE session_id=?').get(s.id) as any;
    expect(orphanRow.id).toBe('MK_ORPHAN');
    expect(orphanRow.summary).toBe('phone压缩');
    // compact_markers 表为空——getLatestCompactMarker 返回 undefined（不污染 buildEffectiveHistory）
    expect(store.getLatestCompactMarker(s.id)).toBeUndefined();
    const compactRows = db.prepare('SELECT COUNT(*) c FROM compact_markers WHERE session_id=?').get(s.id) as any;
    expect(compactRows.c).toBe(0);
  });

  it('orphan marker 脱孤：补齐消息后转 compact_markers + 删 sync_orphan_markers', () => {
    const s = store.createSession();
    store.appendMessage(mkMsg('A', s.id, 'me', 1.0, 0) as any);
    // 第一次合并：firstKeptMessageId='B' → orphan
    const remoteMarker: WireCompactMarker = {
      id: 'MK_ORPHAN', sessionId: s.id, summary: 'phone压缩', createdAt: 200.0,
      lastCompactedMessageId: undefined, firstKeptMessageId: 'B',
      firstKeptSortOrder: 1, compactedCount: 1, version: 2,
    };
    store.mergeRemoteSession({ messages: [], markers: [remoteMarker] }, s.id);
    expect(store.getLatestCompactMarker(s.id)).toBeUndefined(); // 仍 orphan

    // 第二次合并：补 B 进来 → 脱孤
    const remoteMsgB = toWireMessage(mkMsg('B', s.id, 'phone', 2.0, 1) as any);
    store.mergeRemoteSession({ messages: [remoteMsgB], markers: [remoteMarker] }, s.id);
    // 已转 compact_markers
    const got = store.getLatestCompactMarker(s.id);
    expect(got).toBeDefined();
    expect(got?.summary).toBe('phone压缩');
    expect(got?.lastCompactedMessageId).toBe('A'); // B 的前一条
    // sync_orphan_markers 已删
    const orphanCount = db.prepare('SELECT COUNT(*) c FROM sync_orphan_markers WHERE session_id=?').get(s.id) as any;
    expect(orphanCount.c).toBe(0);
  });
});

describe('ChatStore.listCompactMarkers', () => {
  it('返回会话全部 marker（按 createdAt ASC）', () => {
    const s = store.createSession();
    store.appendCompactMarker(s.id, '旧', 'A');
    store.appendCompactMarker(s.id, '新', 'B');
    const list = store.listCompactMarkers(s.id);
    expect(list).toHaveLength(2);
    expect(list[0].summary).toBe('旧');
    expect(list[1].summary).toBe('新');
  });
});

describe('ChatStore.getSessionCursor', () => {
  it('返回 lastMessageTs + lastMarkerTs', () => {
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('A', s.id, 'me', 100.0, 0), parts: [] } as any);
    store.appendMessage({ ...mkMsg('B', s.id, 'me', 200.0, 1), parts: [] } as any);
    store.appendCompactMarker(s.id, '摘要', 'A');
    const cursor = store.getSessionCursor(s.id);
    expect(cursor.lastMessageTs).toBe(200.0);
    expect(cursor.lastMarkerTs).toBe(store.getLatestCompactMarker(s.id)!.createdAt);
  });

  it('无消息无 marker → { lastMessageTs: 0, lastMarkerTs: 0 }', () => {
    const s = store.createSession();
    const cursor = store.getSessionCursor(s.id);
    expect(cursor).toEqual({ lastMessageTs: 0, lastMarkerTs: 0 });
  });
});

describe('ChatStore.onDirty 钩子（Task 6 SyncCoordinator 用）', () => {
  it('appendMessage 后触发 onDirty(sid)', () => {
    const dirty: string[] = [];
    store.onDirty = sid => dirty.push(sid);
    const s = store.createSession();
    store.appendMessage({ ...mkMsg('A', s.id, 'me', 1.0, 0), parts: [] } as any);
    expect(dirty).toContain(s.id);
  });

  it('appendCompactMarker 后触发 onDirty(sid)', () => {
    const dirty: string[] = [];
    store.onDirty = sid => dirty.push(sid);
    const s = store.createSession();
    store.appendCompactMarker(s.id, '摘要', 'A');
    expect(dirty).toContain(s.id);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- sync-chat-store`
Expected: 全部 fail（`mergeRemoteSession` / `listCompactMarkers` / `getSessionCursor` / `onDirty` 不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/store/chat-store.ts`：
- 顶部 `import { mergeSession } from '../sync/merge'; import type { WireMessage, WireCompactMarker, WireSession } from '../sync/wire';`
- 类内新增 `onDirty?: (sessionId: string) => void;`
- `appendMessage` / `appendCompactMarker` / `updateMessage` / `updateSessionTitle` / `setModelBinding` / `setMemoryEnabled` 末尾加 `this.onDirty?.(sessionId);`
- 新增 `listCompactMarkers(sessionId)`：`SELECT * FROM compact_markers WHERE session_id=? ORDER BY created_at ASC, rowid ASC`
- 新增 `getSessionCursor(sessionId)`：查 `MAX(created_at)` from messages + `MAX(created_at)` from markers
- 新增 `listSyncedSessions()`：`listSessions()` + 各自 `getSessionCursor`
- 新增 `mergeRemoteSession(remote, sessionId)`：
  - 事务内：`local = { messages: this.listMessages(sid), markers: this.listCompactMarkers(sid) }`
  - `merged = mergeSession(local, remote)`
  - `INSERT OR IGNORE INTO messages ...` 每条（id 重复跳过）
  - `UPDATE messages SET sort_order=? WHERE id=? AND sort_order != ?`（仅 sort_order 不一致时写）
  - marker：`INSERT OR IGNORE INTO compact_markers ...`；若已存在 id 且 `merged.createdAt > local.createdAt` → `UPDATE compact_markers SET summary=?, last_compacted_message_id=? WHERE id=?`（**不改 created_at**）
  - session 元数据：`UPDATE sessions SET title=?, updated_at=?, memory_enabled=?, model_binding=?, pinned_at=? WHERE id=? AND updated_at < ?`（LWW on updatedAt）
  - 返回 `{ mergedCount, orphanMarkerIds }`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- sync-chat-store`
Expected: 12 passed（10 原有 + orphan 隔离 + orphan 脱孤）
Run: `cd deskminis && npm test -- chat-store`
Expected: 既有 12 用例全绿
Run: `cd deskminis && npm test -- chat-context-info`
Expected: 既有 2 用例全绿（M2a 红线锚点不回归）

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/store/chat-store.ts deskminis/tests/sync-chat-store.test.ts && git commit -m "feat(m3b): ChatStore同步写入接口(mergeRemoteSession INSERT OR IGNORE+sortOrder重排+session LWW)"
```

---

### Task 5 · sync.* RPC 方法面 + authMode 守卫

**Files:**
- Create: `deskminis/src/minisd/sync/rpc.ts`
- Create: `deskminis/src/minisd/sync/index.ts`（装配工厂）
- Test: `deskminis/tests/sync-rpc.test.ts`

**Interfaces:**
- Consumes: Task 4 `ChatStore.mergeRemoteSession` / `getSessionCursor` / `listSyncedSessions` + M3a `RpcConnection.authMode`
- Produces（Task 6 依赖）:
  - `createSyncMethods(chat: ChatStore): RpcMethods`——返回 5 个方法：
    - `sync.push(sessionId, payload)`：调 `chat.mergeRemoteSession`
    - `sync.pull(sessionId, afterTs)`：返回 `{ messages: WireMessage[], markers: WireCompactMarker[], session?: WireSession }`（afterTs 之后的增量）
    - `sync.cursor(sessionIds?)`：返回 `Array<{ sessionId, lastMessageTs, lastMarkerTs }>`
    - `sync.list()`：返回 `chat.listSyncedSessions()`
    - `sync.ack(sessionId, lastMergedTs)`：`UPDATE sessions SET last_synced_at=? WHERE id=?`
  - 所有方法用 `assertAuthMode(conn, ['local', 'remote'], 'sync.xxx')` 守卫（pairing 模式全拒——但 pairing 已被 `guardBusinessMethod` 在装配段统一拒，这里守卫是双保险）
  - payload 大小限制：`sync.push` payload > 1MB → 抛错（`Error('sync.push payload 超过 1MB 限制')`）

- [ ] **Step 1: 写失败测试**

`deskminis/tests/sync-rpc.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { createSyncMethods } from '../src/minisd/sync/rpc';
import { toWireMessage } from '../src/minisd/sync/wire';
import type { AuthMode, RpcConnection, RpcMethods } from '../src/minisd/rpc/server';
import type Database from 'better-sqlite3';

let db: Database.Database; let store: ChatStore; let methods: RpcMethods;
beforeEach(() => { db = openDb(':memory:'); store = new ChatStore(db, 'me'); methods = createSyncMethods(store); });

function makeConn(mode: AuthMode): RpcConnection {
  return { authMode: mode, notify: () => {} };
}

describe('sync.push（local + remote 可调，pairing 拒）', () => {
  it('local 模式推远端消息 → mergeRemoteSession 落库', async () => {
    const s = store.createSession();
    const remoteMsg = toWireMessage({
      id: 'R1', sessionId: s.id, role: 'user', parts: [{ type: 'text', value: 'x' }],
      createdAt: 100.0, updatedAt: 100.0, sortOrder: 0, streamInterruptCount: 0,
      originDeviceId: 'phone', createdLocallyAt: 100.0,
    } as any);
    const r = await methods['sync.push']!({ sessionId: s.id, payload: { messages: [remoteMsg], markers: [] } }, makeConn('local')) as any;
    expect(r.mergedCount).toBe(1);
    expect(store.listMessages(s.id).map(m => m.id)).toContain('R1');
  });

  it('remote 模式推 → 同样可调', async () => {
    const s = store.createSession();
    const remoteMsg = toWireMessage({
      id: 'R2', sessionId: s.id, role: 'user', parts: [], createdAt: 100.0, updatedAt: 100.0, sortOrder: 0, streamInterruptCount: 0,
      originDeviceId: 'phone', createdLocallyAt: 100.0,
    } as any);
    const r = await methods['sync.push']!({ sessionId: s.id, payload: { messages: [remoteMsg], markers: [] } }, makeConn('remote')) as any;
    expect(r.mergedCount).toBe(1);
  });

  it('pairing 模式 → 拒', async () => {
    await expect(methods['sync.push']!({}, makeConn('pairing'))).rejects.toThrow(/local|remote|authMode/i);
  });

  it('payload 超 1MB → 拒', async () => {
    const s = store.createSession();
    const bigPayload = { messages: [{ id: 'X', sessionId: s.id, role: 'user', partsJson: 'x'.repeat(2 * 1024 * 1024), tokenUsageJson: null, reasoningContent: null, streamInterruptCount: 0, sortOrder: 0, createdAt: 1.0, updatedAt: 1.0, originDeviceId: 'x', createdLocallyAt: 1.0 }], markers: [] };
    await expect(methods['sync.push']!({ sessionId: s.id, payload: bigPayload }, makeConn('local'))).rejects.toThrow(/1MB|payload/i);
  });
});

describe('sync.pull（增量拉取）', () => {
  it('local 模式拉本地增量', async () => {
    const s = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 100.0, streamInterruptCount: 0 } as any);
    store.appendMessage({ id: 'B', sessionId: s.id, role: 'user', parts: [], createdAt: 200.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.pull']!({ sessionId: s.id, afterTs: 150.0 }, makeConn('local')) as any;
    expect(r.messages.map((m: any) => m.id)).toEqual(['B']); // 只拉 afterTs 之后的
  });

  it('remote 模式拉 → 同样可调', async () => {
    const s = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.pull']!({ sessionId: s.id, afterTs: 0 }, makeConn('remote')) as any;
    expect(r.messages).toHaveLength(1);
  });

  it('pairing 模式 → 拒', async () => {
    await expect(methods['sync.pull']!({}, makeConn('pairing'))).rejects.toThrow(/local|remote|authMode/i);
  });
});

describe('sync.cursor', () => {
  it('返回各会话 cursor', async () => {
    const s = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 100.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.cursor']!({ sessionIds: [s.id] }, makeConn('remote')) as any;
    expect(r).toHaveLength(1);
    expect(r[0].sessionId).toBe(s.id);
    expect(r[0].lastMessageTs).toBe(100.0);
  });

  it('不传 sessionIds → 返回本地全部会话 cursor', async () => {
    const s1 = store.createSession();
    const s2 = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s1.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.cursor']!({}, makeConn('local')) as any;
    expect(r).toHaveLength(2);
  });
});

describe('sync.list', () => {
  it('返回本地全部会话 + cursor', async () => {
    const s = store.createSession();
    store.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 } as any);
    const r = await methods['sync.list']!({}, makeConn('remote')) as any;
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].id).toBe(s.id);
    expect(r.sessions[0].cursor.lastMessageTs).toBe(1.0);
  });
});

describe('sync.ack（更新 last_synced_at）', () => {
  it('local 模式 ack → 更新 sessions.last_synced_at', async () => {
    const s = store.createSession();
    await methods['sync.ack']!({ sessionId: s.id, lastMergedTs: 1234.5 }, makeConn('local'));
    const row = db.prepare('SELECT last_synced_at FROM sessions WHERE id=?').get(s.id) as any;
    expect(row.last_synced_at).toBe(1234.5);
  });
});

describe('方法面只含 sync.* 五个', () => {
  it('createSyncMethods 返回的方法集 keys', () => {
    expect(Object.keys(methods).sort()).toEqual(['sync.ack', 'sync.cursor', 'sync.list', 'sync.pull', 'sync.push']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- sync-rpc`
Expected: 全部 fail（模块不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/sync/rpc.ts`：

```typescript
import type { AuthMode, RpcConnection, RpcMethods } from '../rpc/server';
import type { ChatStore } from '../store/chat-store';
import { toWireMessage, toWireMarker, toWireSession, type WireCompactMarker, type WireMessage, type WireSession } from './wire';

const MAX_PUSH_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB

function assertAuthMode(conn: RpcConnection, allowed: AuthMode[], what: string): void {
  if (!allowed.includes(conn.authMode)) {
    throw new Error(`${what} 需要 authMode=${allowed.join('/')}，当前=${conn.authMode}`);
  }
}

export function createSyncMethods(chat: ChatStore): RpcMethods {
  return {
    'sync.push': async (p: { sessionId: string; payload: { messages: WireMessage[]; markers: WireCompactMarker[]; session?: WireSession } }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.push');
      const size = JSON.stringify(p.payload).length;
      if (size > MAX_PUSH_PAYLOAD_BYTES) {
        throw new Error(`sync.push payload 超过 1MB 限制（实际 ${size} 字节），请用 sync.pull 分批`);
      }
      return chat.mergeRemoteSession(p.payload, p.sessionId);
    },

    'sync.pull': async (p: { sessionId: string; afterTs?: number }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.pull');
      const afterTs = p.afterTs ?? 0;
      const allMsgs = chat.listMessages(p.sessionId);
      const messages = allMsgs.filter(m => m.createdAt > afterTs).map(toWireMessage);
      const allMarkers = chat.listCompactMarkers(p.sessionId);
      const markers = allMarkers.filter(m => m.createdAt > afterTs).map(m => toWireMarker(m, allMsgs));
      const session = toWireSession(chat.getSession(p.sessionId)!);
      return { messages, markers, session };
    },

    'sync.cursor': async (p: { sessionIds?: string[] }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.cursor');
      const ids = p.sessionIds ?? chat.listSessions().map(s => s.id);
      return ids.map(id => ({ sessionId: id, ...chat.getSessionCursor(id) }));
    },

    'sync.list': async (_p, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.list');
      return { sessions: chat.listSyncedSessions() };
    },

    'sync.ack': async (p: { sessionId: string; lastMergedTs: number }, conn) => {
      assertAuthMode(conn, ['local', 'remote'], 'sync.ack');
      // 直接 SQL UPDATE（ChatStore 没必要加方法）
      (chat as any).db.prepare('UPDATE sessions SET last_synced_at=? WHERE id=?').run(p.lastMergedTs, p.sessionId);
      return { ok: true };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- sync-rpc`
Expected: 12 passed

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/sync/rpc.ts deskminis/src/minisd/sync/index.ts deskminis/tests/sync-rpc.test.ts && git commit -m "feat(m3b): sync.* RPC面(push/pull/cursor/list/ack,authMode local+remote可调,pairing拒)"
```

---

### Task 6 · SyncCoordinator + 装配 + CLI

**Files:**
- Create: `deskminis/src/minisd/sync/coordinator.ts`
- Modify: `deskminis/src/minisd/index.ts`
- Create: `deskminis/src/cli/sync-cli.mjs`
- Test: `deskminis/tests/sync-coordinator.test.ts`
- Test: `deskminis/tests/sync-cli.test.ts`

**Interfaces:**
- Consumes: Task 5 `sync.*` 方法面 + M3a `RpcServer.broadcast`
- Produces:
  - `SyncCoordinator`（服务端被动，评审命门 4 收敛）：
    - `constructor(chat: ChatStore, rpc: RpcServer, opts?: { debounceMs?: number })`
    - `onDirty(sessionId: string): void`——入 pendingQueue，去抖 200ms 调 `flush()`
    - `flush(): Promise<void>`——遍历 pendingQueue，对每个 sid 调 `rpc.broadcast('sync.dirty', { sessionId, cursor })`（只向已连接的 remote 连接广播，不主动连对端）
    - `start(): void`——空实现（评审命门 4：心跳移除，留 M3c relay 实装；保留方法签名供未来扩展，避免装配处条件判断）
    - `stop(): void`——清 pendingQueue + 去抖 timer
  - **不引入**：出站 WS 客户端、对端地址簿、`onlinePeers` 管理、5s 心跳 `setInterval`——均移 M3c relay（见非目标）
  - 「对端在线」由「对端 GUI 长连本端」（M3a PASETO 长连）体现，本端 `SyncCoordinator` 只在 `onDirty` 时 `rpc.broadcast('sync.dirty', ...)`，远端 GUI / CLI 收到后作为 RPC 客户端主动调本端 `sync.pull` 拉取

- [ ] **Step 1: 写失败测试**

`deskminis/tests/sync-coordinator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { SyncCoordinator } from '../src/minisd/sync/coordinator';
import type { RpcServer } from '../src/minisd/rpc/server';

let broadcastSpy: ReturnType<typeof vi.fn>;
let rpc: { broadcast: ReturnType<typeof vi.fn> };
let coord: SyncCoordinator;
let chat: ChatStore;

beforeEach(() => {
  const db = openDb(':memory:');
  chat = new ChatStore(db, 'me');
  broadcastSpy = vi.fn();
  rpc = { broadcast: broadcastSpy };
  coord = new SyncCoordinator(chat, rpc as unknown as RpcServer, { debounceMs: 50 });
  chat.onDirty = sid => coord.onDirty(sid);
});
afterEach(() => coord.stop());

describe('SyncCoordinator 事件驱动 pending 队列（服务端被动，评审命门 4）', () => {
  it('appendMessage 后去抖期内广播 sync.dirty', async () => {
    const s = chat.createSession();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    // 去抖 50ms（测试用短去抖）
    await new Promise(r => setTimeout(r, 100));
    expect(broadcastSpy).toHaveBeenCalledWith('sync.dirty', expect.objectContaining({ sessionId: s.id }));
  });

  it('appendCompactMarker 后触发 sync.dirty', async () => {
    const s = chat.createSession();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    broadcastSpy.mockClear();
    chat.appendCompactMarker(s.id, '摘要', 'A');
    await new Promise(r => setTimeout(r, 100));
    expect(broadcastSpy).toHaveBeenCalledWith('sync.dirty', expect.objectContaining({ sessionId: s.id }));
  });

  it('连续多次写 → 去抖合并一次广播', async () => {
    const s = chat.createSession();
    broadcastSpy.mockClear();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    chat.appendMessage({ id: 'B', sessionId: s.id, role: 'user', parts: [], createdAt: 2.0, streamInterruptCount: 0 });
    chat.appendMessage({ id: 'C', sessionId: s.id, role: 'user', parts: [], createdAt: 3.0, streamInterruptCount: 0 });
    await new Promise(r => setTimeout(r, 100));
    const dirtyCalls = broadcastSpy.mock.calls.filter(c => c[0] === 'sync.dirty');
    expect(dirtyCalls.length).toBe(1); // 合并
  });

  it('start() 是空实现（评审命门 4：心跳移除）——不广播 sync.heartbeat', async () => {
    coord.start();
    await new Promise(r => setTimeout(r, 120));
    expect(broadcastSpy).not.toHaveBeenCalledWith('sync.heartbeat', expect.any(Object));
    coord.stop();
  });

  it('stop 后不再广播 sync.dirty', async () => {
    const s = chat.createSession();
    coord.stop();
    broadcastSpy.mockClear();
    chat.appendMessage({ id: 'A', sessionId: s.id, role: 'user', parts: [], createdAt: 1.0, streamInterruptCount: 0 });
    await new Promise(r => setTimeout(r, 100));
    expect(broadcastSpy).not.toHaveBeenCalledWith('sync.dirty', expect.any(Object));
  });
});
```

`deskminis/tests/sync-cli.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'sync-cli.mjs');

let dataDir: string;
let proc: any;
let port = 0, token = '';

afterEach(async () => {
  if (proc) { try { proc.kill(); } catch {} }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }
});

async function bootMinisd() {
  dataDir = mkdtempSync(join(tmpdir(), 'dm-synccli-'));
  writeFileSync(join(dataDir, 'providers.json'), JSON.stringify({
    providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }],
    defaultProviderId: '__fake__',
  }), 'utf8');
  proc = spawn(electronBin, [MINISD_ENTRY], {
    env: { ...process.env, DESKMINIS_STANDALONE: '1', DESKMINIS_TEST: '1', DESKMINIS_DATA_DIR: dataDir, MINISD_HOST: '127.0.0.1', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const line = await new Promise<string>((res, rej) => {
    proc.stdout.once('data', d => res(String(d).trim()));
    proc.stderr.on('data', d => process.stderr.write(d));
    setTimeout(() => rej(new Error('minisd 启动超时')), 8000);
  });
  ({ minisdPort: port, authToken: token } = JSON.parse(line));
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(res => {
    const p = spawn(electronBin, [CLI_ENTRY, ...args], {
      env: { ...process.env, MINISD_PORT: String(port), MINISD_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => res({ code: code ?? 0, stdout: out, stderr: err }));
  });
}

describe('sync-cli.mjs（手动同步按钮等价命令行）', () => {
  it('status 子命令：列出本地会话 + cursor', async () => {
    await bootMinisd();
    // 先用 WS 创建一个会话
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.sessions.create', params: {} }));
    await new Promise(r => ws.on('message', r));
    ws.close();
    const r = await runCli(['status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('sessions');
  }, 15000);

  it('pull <sid>：拉取本地会话（自拉自，验证链路通）', async () => {
    await bootMinisd();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.sessions.create', params: {} }));
    const resp = await new Promise<any>(r => ws.on('message', d => r(JSON.parse(String(d)))));
    ws.close();
    const sid = resp.result.id;
    const r = await runCli(['pull', sid]);
    expect(r.code).toBe(0);
  }, 15000);

  it('无 MINISD_PORT/MINISD_TOKEN → 退出 2', async () => {
    const r = await new Promise<{ code: number }>(res => {
      const p = spawn(electronBin, [CLI_ENTRY, 'status'], { env: { ...process.env, MINISD_PORT: '', MINISD_TOKEN: '', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      p.on('close', code => res({ code: code ?? 0 }));
    });
    expect(r.code).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- sync-coordinator sync-cli`
Expected: 全部 fail（模块不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/sync/coordinator.ts`：

```typescript
import type { ChatStore } from '../store/chat-store';
import type { RpcServer } from '../rpc/server';

export interface SyncCoordinatorOpts {
  debounceMs?: number;
}

/**
 * 同步协调器（服务端被动，评审命门 4 收敛）。
 *
 * A. 事件驱动：chat.onDirty → 入 pendingQueue → 去抖 N ms → rpc.broadcast('sync.dirty', { sessionId, cursor })
 *    远端 GUI / CLI 收到 sync.dirty 后作为 RPC 客户端调本端 sync.pull（M3a 已建好 PASETO 长连）
 * B. 手动：CLI deskminis-cli sync pull/push（local token 连本端调 sync.* RPC）
 *
 * 本协调器不主动连对端（那是 M3c relay 的事）——「对端在线」由「对端 GUI 长连本端」体现，本端只广播。
 * start() 为空实现：评审命门 4 移除 5s 心跳，保留方法签名供 M3c relay 扩展，避免装配处条件判断。
 */
export class SyncCoordinator {
  private pendingQueue = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;

  constructor(
    private chat: ChatStore,
    private rpc: RpcServer,
    opts: SyncCoordinatorOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 200;
  }

  onDirty(sessionId: string): void {
    this.pendingQueue.add(sessionId);
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    const sids = Array.from(this.pendingQueue);
    this.pendingQueue.clear();
    for (const sid of sids) {
      const cursor = this.chat.getSessionCursor(sid);
      this.rpc.broadcast('sync.dirty', { sessionId: sid, cursor });
    }
  }

  start(): void { /* 评审命门 4：心跳移除，空实现——留 M3c relay 实装 */ }

  stop(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    this.pendingQueue.clear();
  }
}
```

`deskminis/src/minisd/sync/index.ts`（装配工厂）：

```typescript
export { SyncCoordinator } from './coordinator';
export { createSyncMethods } from './rpc';
export { mergeSession } from './merge';
export * from './wire';
```

`deskminis/src/minisd/index.ts` 增量修改（**严格按增量清单，禁止全文重写**）：
- a. L15-16 后追加 `import { SyncCoordinator, createSyncMethods } from './sync';`
- b. **PairingService 装配前移到 ChatStore 之前**（评审命门 3，决策 2 推荐方案）：把 L438-442 的 `PairingStore` + `PairingService` 装配段整体上移到 L104 `openDb` 之后、L105 `new ChatStore` 之前；L105 改为 `const chat = new ChatStore(db, pairingService.myFingerprint);`；L442 处删除已上移的装配语句（保留 `remoteMethods` / `additionalVerify` 在原位——它们要等 `methods` 对象构造完才能 `Object.assign`）。前移依据：`PairingStore` 只依赖 `root + vault`（L106 vault 在 L105 之前需先就绪——vault 装配也要一并前移到 `chat` 之前），`PairingService` 只依赖 `pairingStore + vault`，都不依赖 ChatStore/db。**不选 `setOriginDeviceId` 延迟注入的理由**：ChatStore 装配后立刻被多处引用（AgentLoop / CompactEngine / SyncCoordinator），若注入前有 `appendMessage` 调用会落 `originDeviceId='local'` 污染同步——前移从根上避免此风险。
- c. L443-452 装配段后追加（`pairingService` 已前移，此处仅接线）：
  ```typescript
  // M3b 接线：sync.* 方法 + SyncCoordinator
  const syncMethods = createSyncMethods(chat);
  for (const k of Object.keys(syncMethods)) {
    (methods as any)[k] = guardBusinessMethod((syncMethods as any)[k], k);
  }
  Object.assign(methods, syncMethods);
  const syncCoordinator = new SyncCoordinator(chat, rpc);
  chat.onDirty = sid => syncCoordinator.onDirty(sid);
  syncCoordinator.start(); // 空实现（评审命门 4），保留调用供 M3c 扩展
  ```
- d. L458-463 `close` 函数内追加 `syncCoordinator.stop();`

`deskminis/src/cli/sync-cli.mjs`（仿 [`remote-cli.mjs`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/cli/remote-cli.mjs) 零依赖单文件）：
- 子命令：`status` / `pull <sid|all>` / `push <sid|all>`
- 连本端 minisd 走 `?token=`（local 模式），port+token 经 `--port`/`--token` 或 env `MINISD_PORT`/`MINISD_TOKEN`
- 无 env 退出 2

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- sync-coordinator sync-cli`
Expected: 8 passed (5 coordinator + 3 cli)
Run: `cd deskminis && npm test`
Expected: 全套绿（526 + Task1 8 + Task2 10 + Task3 14 + Task4 10 + Task5 12 + Task6 8 = 588；Task7 e2e 不计入 npm test）
Run: `cd deskminis && npm run typecheck`
Expected: 0 错误
Run: `cd deskminis && npm run build`
Expected: 三件套（main/preload/renderer）构建通过

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/sync/coordinator.ts deskminis/src/minisd/sync/index.ts deskminis/src/minisd/index.ts deskminis/src/cli/sync-cli.mjs deskminis/tests/sync-coordinator.test.ts deskminis/tests/sync-cli.test.ts && git commit -m "feat(m3b): SyncCoordinator服务端被动(pending去抖+sync.dirty广播)+CLI+index.ts装配(PairingService前移)"
```

---

### Task 7 · e2e 验收驱动（两实例配对互连 + 红线断言）

**Files:**
- Create: `deskminis/scripts/e2e-m3b-acceptance.mjs`
- Modify: `deskminis/package.json`（新增 `e2e:m3b` script）

**目标**：起两个 standalone minisd 实例（各自临时数据根）→ M3a 配对互连 → A 端写入 4 轮对话 → openDb 直落 compact marker → 双向同步 → 断言两端 `sync.pull` 拿到的消息 id 序列逐位一致 + `chat.contextInfo.usedTokens` 差值 = 0（设计 §6 验收红线）+ PASETO 远程调 `sync.pull` 与 local 一致 + marker 同步成功。

**compact marker 同步路径经 openDb 直落验证**（评审命门 5b）：e2e 主进程用 `better-sqlite3` 直接 open A 的 `minis.db`（WAL 模式支持多进程共存——M2c 已实证 standalone minisd 与运行中应用同库并存），`INSERT INTO compact_markers` 落测试 marker（[`chat-context-info.test.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/tests/chat-context-info.test.ts) L91-97 先例的跨进程版）。Step 2 实测为准，若真报 disk I/O 再回退现方案并在 commit 申报。

**PASETO 远程调 `sync.pull`**（评审命门 5a）：B 端用派生的 PASETO token 连 A 的 `?paseto=` 端点调 `sync.pull`，断言与 local token 拉取结果一致——`sync.*` 的 remote 面是本里程碑唯一新权限面，e2e 必须摸到。

**步骤**：

- [ ] **Step 1: 写 e2e 脚本**

`deskminis/scripts/e2e-m3b-acceptance.mjs`（参照 [`e2e-m3a-acceptance.mjs`](file:///c:/Users/24739/Downloads/openminis1/deskminis/scripts/e2e-m3a-acceptance.mjs) spawn + 临时数据根 + PASETO 派生模式）：

```javascript
// DeskMinis M3b 端到端验收驱动（对应 docs/plans/2026-07-31-m3b-sync-engine.md「完成定义」）。
// 用法：先 `npm run build`，再 `npm run e2e:m3b`。
//
// 覆盖（本地完整链路，不联网）：
//   1) 双实例：A/B 两个 standalone minisd（各自临时数据根 + 不同 port）
//   2) M3a 配对互连：A 调 remote.pair.begin → B 调 remote.pair.complete → 两端 fingerprint + authKey 一致
//   3) A 端写入：chat.sessions.create + chat.prompt 4 轮（fake provider）
//   4) openDb 直落 marker：e2e 主进程用 better-sqlite3 直接 open A 的 minis.db 落 compact marker（评审命门 5b）
//   5) 单向同步：A 端 sync.pull 拿 wire payload → B 端 local token 连自己调 sync.push 入库
//   6) PASETO 远程调 sync.pull：B 端用 PASETO 连 A 调 sync.pull，断言与 local 一致（评审命门 5a）
//   7) 红线断言 1：两端 chat.contextInfo.usedTokens 差值 = 0
//   8) 红线断言 2：两端 sync.pull 拿到的消息 id 序列逐位完全一致
//   9) marker 同步成功：openDb 落的 marker 经 sync.pull 拉到 B 端
//
// 环境隔离：临时数据根（mkdtemp × 2）+ DESKMINIS_TEST=1（InMemoryVault）+ MINISD_HOST=127.0.0.1，结束 rmSync。
// authKey 派生：与 e2e-m3a 一致——独立用 ECDH 对称性派生（phonePriv + desktopPub + code → HKDF）。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const Database = require('better-sqlite3');  // 评审命门 5b：openDb 直落 marker
const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) { console.error('找不到 out/main/minisd.js —— 先 npm run build'); process.exit(2); }

const results = [];
const record = (step, pass, detail) => { results.push({ step, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- PASETO v4.local encode + authKey 派生（与 e2e-m3a 一致） ----
const PASETO_HEADER = 'v4.local';
const NONCE_LEN = 24;
function encodePaseto(payload, authKey) {
  const nonce = randomBytes(NONCE_LEN);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const aad = Buffer.concat([Buffer.from(PASETO_HEADER, 'ascii'), Buffer.from([0x00]), nonce]);
  const cipher = xchacha20poly1305(authKey, nonce, aad);
  const sealed = cipher.encrypt(plaintext);
  const b64u = bytes => Buffer.from(bytes).toString('base64url');
  return `${PASETO_HEADER}.${b64u(nonce)}.${b64u(sealed)}`;
}
const HKDF_INFO_PAIRING = new TextEncoder().encode('DeskMinis/PairingKey/v1');
function deriveAuthKey(myPriv, peerPub, code) {
  const shared = x25519.getSharedSecret(myPriv, peerPub);
  const salt = new TextEncoder().encode(code);
  return hkdf(sha256, shared, salt, HKDF_INFO_PAIRING, 64).slice(0, 32);
}
function deviceFingerprint(pubKey) {
  return Buffer.from(sha256(pubKey).slice(0, 6)).toString('hex');
}

// ---- spawn 单个 minisd 实例 ----
function spawnMinisd(label, dataRoot) {
  writeFileSync(join(dataRoot, 'providers.json'), JSON.stringify({
    providers: [{ id: '__fake__', name: 'fake', kind: 'openai-compat', modelId: 'fake' }],
    defaultProviderId: '__fake__',
  }), 'utf8');
  const proc = spawn(electronBin, [MINISD_ENTRY], {
    env: { ...process.env, DESKMINIS_STANDALONE: '1', DESKMINIS_TEST: '1', DESKMINIS_FAKE_PROVIDER: '1', DESKMINIS_DATA_DIR: dataRoot, MINISD_HOST: '127.0.0.1', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    proc.stdout.once('data', d => {
      try {
        const { minisdPort, authToken } = JSON.parse(String(d).trim());
        resolve({ label, proc, port: minisdPort, token: authToken, dataRoot });
      } catch (e) { reject(e); }
    });
    proc.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));
    setTimeout(() => reject(new Error(`${label} 启动超时`)), 10000);
  });
}

// ---- WS RPC 客户端 ----
function rpcClient(url) {
  const ws = new WebSocket(url);
  let idc = 0;
  const pending = new Map();
  const notifications = [];
  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method, params) {
    const id = ++idc;
    return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

async function waitFor(what, cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(20);
  }
}

async function promptTurn(c, sessionId, text) {
  await c.call('chat.prompt', { sessionId, text, providerId: '__fake__' });
  await waitFor(`turnEnd for "${text.slice(0, 20)}"`, () =>
    c.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === sessionId && n.params.event.kind === 'turnEnd'));
  c.notifications.length = 0;
}

async function main() {
  const dataRootA = mkdtempSync(join(tmpdir(), 'dm-m3b-A-'));
  const dataRootB = mkdtempSync(join(tmpdir(), 'dm-m3b-B-'));
  console.log('临时数据根 A: ' + dataRootA);
  console.log('临时数据根 B: ' + dataRootB);

  let A, B;
  try {
    A = await spawnMinisd('A', dataRootA);
    B = await spawnMinisd('B', dataRootB);
    console.log(`A port=${A.port} B port=${B.port}`);

    // 1) M3a 配对：A local 调 remote.pair.begin → B 用 pairingCode 连 A 调 remote.pair.complete
    const localA = rpcClient(`ws://127.0.0.1:${A.port}/?token=${A.token}`); await localA.ready;
    const begin = (await localA.call('remote.pair.begin', {})).result;
    record('1. beginPairing', !!begin.pairingCode, `code=${begin.pairingCode} fp=${begin.myFingerprint}`);

    // B 端扮演手机：生成临时 X25519 keypair → 用 pairingCode 连 A 调 remote.pair.complete
    const phoneKp = x25519.keygen();
    const phoneFp = deviceFingerprint(phoneKp.publicKey);
    const pairingUrl = `ws://127.0.0.1:${A.port}/?pairingCode=${begin.pairingCode}`;
    const pairConn = rpcClient(pairingUrl); await pairConn.ready;
    const complete = (await pairConn.call('remote.pair.complete', {
      pairingCode: begin.pairingCode,
      peerPublicKey: Buffer.from(phoneKp.publicKey).toString('base64'),
      peerFingerprint: phoneFp,
      peerName: 'B-phone',
    })).result;
    record('2. completePairing', complete.ok && complete.peerFingerprint === phoneFp, `peerFp=${complete.peerFingerprint}`);
    pairConn.close();

    // 派生 authKey（B 端作为手机，用 phonePriv + A 的公钥 + code）
    const authKey = deriveAuthKey(phoneKp.secretKey, Buffer.from(begin.myPublicKeyB64, 'base64'), begin.pairingCode);
    const paseto = encodePaseto({ exp: Date.now() + 60000, iat: Date.now(), device_fingerprint: phoneFp }, authKey);

    // 2) A 端写入：创建会话 + 4 轮对话
    const s = (await localA.call('chat.sessions.create', {})).result;
    await promptTurn(localA, s.id, '回合 1：测试同步前写入');
    await promptTurn(localA, s.id, '回合 2：继续追加');
    await promptTurn(localA, s.id, '回合 3：再追加');
    await promptTurn(localA, s.id, '回合 4：最后一轮');
    record('3. A 写入 4 轮对话', !!s.id, `sid=${s.id}`);

    // 3) A 端 sync.pull 拿 wire payload（消息列表，用于后续 marker 锚点）
    const payload = (await localA.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    record('4. A sync.pull', payload.messages.length > 0, `拿到 ${payload.messages.length} 条消息`);

    // 4) openDb 直落 compact marker（评审命门 5b）：e2e 主进程用 better-sqlite3 直接 open A 的
    //    minis.db（WAL 模式支持多进程共存——M2c 已实证），INSERT INTO compact_markers 落测试 marker。
    //    last_compacted_message_id 取 payload 最后一条消息 id（确保锚点存在，不产 orphan）。
    const lastMsgId = payload.messages[payload.messages.length - 1].id;
    const MARKER_ID = 'MK_E2E';
    try {
      const dbA = new Database(join(dataRootA, 'minis.db'));
      dbA.pragma('journal_mode = WAL');
      dbA.prepare(`INSERT INTO compact_markers (id, session_id, summary, last_compacted_message_id, created_at) VALUES (?,?,?,?,?)`)
        .run(MARKER_ID, s.id, 'e2e 摘要：前 4 轮已压缩', lastMsgId, Date.now() / 1000);
      dbA.close();
      record('5. openDb 直落 marker', true, `markerId=${MARKER_ID} lastCompactedMsgId=${lastMsgId}`);
    } catch (e) {
      // Step 2 实测为准：若真报 disk I/O（WAL 多进程冲突），回退现方案并在 commit 申报
      record('5. openDb 直落 marker', false, `disk I/O? ${e.message}——回退方案：marker 同步仅靠单测覆盖`);
    }

    // 5) A 端重新 sync.pull（含 marker）→ B 端 local token 连自己调 sync.push 入库
    const payloadWithMarker = (await localA.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    const localB = rpcClient(`ws://127.0.0.1:${B.port}/?token=${B.token}`); await localB.ready;
    const pushResult = (await localB.call('sync.push', { sessionId: s.id, payload: payloadWithMarker })).result;
    record('6. B sync.push', pushResult.mergedCount > 0, `mergedCount=${pushResult.mergedCount}`);

    // 6) PASETO 远程调 sync.pull（评审命门 5a）：B 端用派生的 PASETO 连 A 的 ?paseto= 端点调
    //    sync.pull，断言与 local token 拉取结果一致——sync.* 的 remote 面是本里程碑唯一新权限面。
    const remoteClient = rpcClient(`ws://127.0.0.1:${A.port}/?paseto=${paseto}`); await remoteClient.ready;
    const remotePull = (await remoteClient.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    const remoteIds = remotePull.messages.map(m => m.id);
    const localIds = payloadWithMarker.messages.map(m => m.id);
    record('7. PASETO 远程 sync.pull 与 local 一致', JSON.stringify(remoteIds) === JSON.stringify(localIds), `remote=[${remoteIds.join(',')}] local=[${localIds.join(',')}]`);
    remoteClient.close();

    // 7) 红线断言 1：两端 chat.contextInfo.usedTokens 差值 = 0
    //   （contextInfo 内部走 buildEffectiveHistory + estimateTokens，effectiveHistory 一致则 token 数必相等）
    const ctxA = (await localA.call('chat.contextInfo', { sessionId: s.id })).result;
    const ctxB = (await localB.call('chat.contextInfo', { sessionId: s.id })).result;
    record('8. usedTokens 差值=0', ctxA.usedTokens === ctxB.usedTokens, `A=${ctxA.usedTokens} B=${ctxB.usedTokens} diff=${Math.abs(ctxA.usedTokens - ctxB.usedTokens)}`);

    // 8) 红线断言 2：两端 sync.pull 拿到的消息 id 序列逐位完全一致（设计 §6）
    const pullA = (await localA.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    const pullB = (await localB.call('sync.pull', { sessionId: s.id, afterTs: 0 })).result;
    const idsA = pullA.messages.map(m => m.id);
    const idsB = pullB.messages.map(m => m.id);
    record('9. 消息 id 序列逐位一致', JSON.stringify(idsA) === JSON.stringify(idsB), `A=[${idsA.join(',')}] B=[${idsB.join(',')}]`);

    // 9) marker 同步成功：openDb 落的 marker 经 sync.pull 拉到 B 端
    const hasMarkerB = pullB.markers.some(m => m.id === MARKER_ID);
    record('10. marker 同步成功', hasMarkerB, `B markers=${JSON.stringify(pullB.markers.map(m => m.id))}`);

    localA.close(); localB.close();
  } finally {
    if (A) { try { A.proc.kill(); } catch {} }
    if (B) { try { B.proc.kill(); } catch {} }
    await sleep(200);
    try { rmSync(dataRootA, { recursive: true, force: true }); } catch {}
    try { rmSync(dataRootB, { recursive: true, force: true }); } catch {}
  }

  console.log(`\nM3b e2e: ${results.filter(r => r.pass).length}/${results.length} passed`);
  process.exit(results.every(r => r.pass) ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
```

`deskminis/package.json` `scripts` 段追加（不碰既有 scripts）：

```json
    "e2e:m3b": "node scripts/e2e-m3b-acceptance.mjs",
```

- [ ] **Step 2: 构建并运行**

Run: `cd deskminis && npm run build`
Run: `cd deskminis && npm run e2e:m3b`
Expected: 10/10 passed（begin / complete / A 写入 / A pull / openDb 直落 marker / B push / PASETO 远程 sync.pull / usedTokens 差值=0 / 消息 id 序列逐位一致 / marker 同步成功）

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/scripts/e2e-m3b-acceptance.mjs deskminis/package.json && git commit -m "test(m3b): e2e验收驱动(双实例配对互连+openDb直落marker+PASETO远程sync.pull+usedTokens差值=0+id序列逐位一致)"
```

---

## 完成定义

- [ ] Task 1-7 全部 commit 落地
- [ ] `npm test` 全套绿（526 基线 + 约 54 M3b 新增 = 约 580）
- [ ] `npm run typecheck` 0 错误
- [ ] `npm run build` 三件套通过
- [ ] `npm run e2e:m3b` 10/10 passed
- [ ] `npm run e2e:m3a` 仍 6/6 通过（M3a 不回归）
- [ ] `chat-context-info.test.ts` 例 2（M2a 红线锚点）仍绿
- [ ] **OM 对接契约**（不在本计划实施，但需在交付报告里注明）：
  - `WireMessage` / `WireCompactMarker` / `WireSession` / `WireSessionFile` 字段名即契约，OM 侧 `SyncedMessage` / `SyncedCompactMarker` / `SyncedSession` / `SyncedSessionFile` 需追加 `originDeviceId` / `createdLocallyAt`（[`SyncedTypes.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/SyncedTypes.swift) L64-124 / L128-183 / L14-60 / L187-217）
  - `SyncedCompactMarker.conflictPolicy`（L163 `.alwaysAccept`）需在 OM 侧 `mergeCompactMarker`（[`ChatStoreSyncHydrators.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/ChatStoreSyncHydrators.swift) L278-302）加来源分支：M3 transport 走「主锚 + LWW on createdAt + orphan 降级」策略，CK 来源保持 `.alwaysAccept`
  - `mergeRemoteSession` 的 `fromDeviceId`（L182 现传空串哨兵）需改为真实 device fingerprint
  - **PASETO exp/iat 单位对齐**：DM 侧 [`remote/paseto.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/remote/paseto.ts) 用毫秒（M3a 现状），OM Swift `Date()` 是秒——OM 侧铸 PASETO 时 `exp` / `iat` 需 `* 1000`
  - 同步触发：OM 侧 GUI 收到 `sync.dirty` 广播后，作为 RPC 客户端调 DM 端 `sync.pull`（OM 持有 DM 的 PASETO + 地址，M3a 已建好这条路径）

## 非目标（本计划绝对不做）

- ❌ **OM 侧实装**：本计划只交付 DM 侧同步引擎 + 线格式契约，OM 侧 `SyncedTypes` 加字段 / `mergeCompactMarker` 加分支 / GUI 接 `sync.dirty` 广播 均属 OM 代码库
- ❌ **本端主动连对端 / 出站 WS 客户端 / 对端地址簿 / 5s 心跳轮询**：`SyncCoordinator` 只 `rpc.broadcast('sync.dirty', ...)` 通知已连 remote peer，不主动 WS 连对端、不维护在线 peer 列表、不周期 `sync.cursor`（评审命门 4：这些均移 M3c relay 实装）
- ❌ **CompactMarker 自动语义合并**：摘要 LLM 产物无语义合并算法，LWW + orphan 降级足够
- ❌ **附件文件本体同步**：只同步元数据，文件本体走 M3c「在线设备按需取回」
- ❌ **GUI 同步按钮**：M3b 只交付 CLI，GUI 按钮留独立任务
- ❌ **业务面 / `remote.*` / 鉴权面任何改动**：`sync.*` 是纯新增 RPC 面
- ❌ **`MIGRATIONS[0]`/`[1]`/`[2]` 任何改动**：只追加 `[3]`
- ❌ **`buildEffectiveHistory` / `appendMessage` / `appendCompactMarker` 现有契约任何改动**：M2a 红线
