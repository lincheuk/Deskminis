# M3 · DeskMinis ↔ OpenMinis 互通同步设计（2026-07-31）

> 基线：`main@fa97ead`（M2 收官，432 tests/typecheck/build 全绿，手机端参考克隆位于
> `./OpenMinis/`，仅作只读数据模型对照）。参考架构：paseo.sh。
>
> 产品前提：**两端都是一等 Agent 节点，都有本地 agent 与本地数据；互通的是会话与数据，手机不是瘦客户端/遥控器。**

---

## 0. 设计前提与原则

| 原则 | 说明 |
|---|---|
| 协议零改动优先 | `minisd` 的 WS JSON-RPC 面就是天然边界；M3a 只做「让外面客户端能安全连」，不新增 method。 |
| 单一事实源 · 追加型 | M2a 红线：`RawMessage[]` 是追加型，压缩靠 marker。同步冲突远比一般 CRDT 简单——**不允许改旧消息**，只允许在「消息顺序」与「marker / 元数据」上合并。 |
| 原生能力栈不共享 | DeskMinis 的六个 Windows 桥（windows-*）、OpenMinis 的 iOS iSH Rootfs / Android PRoot、各自本地 shell / file / clipboard / 权限 gate——**跨端互不可用**；接力必须显式声明「工具在哪端跑」。 |
| 语音继续本地 | 像 paseo.sh 一样，语音 STT/TTS 端侧全本地，同步不传输任何语音数据。 |
| 全部 CLI 可操作 | 像 paseo.sh 的 `paseo daemon` / `paseo pair` / `paseo relay`，三阶段均有 CLI 与 GUI 两条路径。 |

### 与 paseo.sh 的差异（写清楚，避免遥控器化）

| 维度 | Paseo | Open* 系列（我们） |
|---|---|---|
| 手机端角色 | 移动「遥控器」+ 查看面板 | **对等 Agent 节点**：独立 Agent Loop、独立本地模型 provider、独立本地 tool 栈（iSH/PRoot），可在地铁里离线跑 agent |
| Agent 进程归属 | 始终在「用户自己机器」（laptop/VM/dev server） | **两端都能起**；会话有「执行粘性」——默认工具在哪端创建就在哪端运行（见 §M3c） |
| 同步范围 | 主要是终端/浏览器视图、agents 列表 | **全会话语义**：RawMessage 追加历史 + compact marker + session 元数据 + offload 路径（不跨端搬运二进制 offload 文件本体，见 §M3b） |
| Relay 形态 | 可选官方托管 E2EE relay / 自托管 / 直连 | **同三件**，但默认启用「配对级 ECDH + 可选 Tailscale 直连」；官方 relay 仅做消息中转（存内转发、落盘零） |
| 原生能力 | 偏 macOS/Linux 一套 | Windows 桥 / iOS iSH / Android Termux 原生三套并存，接力时**能力声明**比 Paseo 更细 |

---

## 1. 三层切分总览（M3a → M3b → M3c）

```
             ┌──────────────────────────────────────────────────────┐
             │                  用户信任域（本地两端）              │
             │                                                      │
   ┌─────────┴──────────┐                              ┌────────────┴──────────┐
   │     DeskMinis      │     直连 / Tailscale /       │       OpenMinis       │
   │  (Windows minisd)  │     E2EE relay 传输          │  (iOS/Android minisd) │
   │                    │◄────────────────────────────►│                      │
   │  M3a 远程接入服务  │                              │  M3a 远程接入客户端  │
   │  M3b 同步引擎(对)  │                              │  M3b 同步引擎(对)    │
   │  M3c 接力调度器    │                              │  M3c 接力调度器      │
   └─────────┬──────────┘                              └────────────┬──────────┘
             │                                                     │
             └─► 两者都是「本地 minisd + 本地 store」，不共享单例 ◄─┘
```

### M3a · 远程接入（先做）

> **只做信道与鉴权，不碰业务方法**。
>
> 目标：手机端 minisd 作为**远程 WS JSON-RPC 客户端**连到桌面 minisd（或反向），能调同一个 RPC 面、能收 `chat.event` 广播。

- **传输三选**（用户可在 GUI 里勾选顺序；实现顺序：Tailscale > 直连 > Relay）：
  1. **Tailscale / 同局域网直连**：首选；两端 IP 可达时，minisd 直接 `listen(host=0.0.0.0 | tailscale ip)`，客户端用 mDNS 或「输入配对码时带 IP」直接连。
  2. **配对码 + mDNS 发现（LAN）**：同 Wi-Fi 场景，配对码完成 ECDH 握手后直接建 WS。
  3. **E2EE 官方中继**（NAT 穿透兜底）：两端都拨到 `wss://relay.openminis.cn/room/<roomId>`，roomId 由配对码派生；**中继只转发密文**，不持有用户任何明文。
- **协议零改动**：
  - 仍走 JSON-RPC 2.0；RPC methods 表、广播 `chat.event` 帧、`permission.request / permission.respond` 全照旧。
  - 只是在 **握手层** 增加「配对级认证」——`?token=<旧的per-run authToken>` 只保留给本机渲染进程；远程客户端改用 **PASETO 短期 session token**（见 §2）。
- **CLI 化（对照 paseo.sh `paseo pair`）**：
  ```
  deskminis-cli remote pair          # 桌面：显示 8 字配对码 + 二维码
  deskminis-cli remote connect <码>  # 手机：输入配对码，生成配对凭证（长期）
  deskminis-cli remote status        # 列所有已配对节点、当前通道类型、延迟
  ```

### M3b · 双向会话同步（在 M3a 信道建立后做）

> 两端各自本地写库；M3b **把两侧追加型 RawMessage 流合成一个逻辑序列**，marker / 元数据按 LWW 合并。不跨端搬二进制大文件本体。
>
> 由于 M2a 红线（原始历史是追加型，压缩靠 marker，**不删不改旧消息**），合并远比一般文本 CRDT 简单——不用 Yjs/Automerge，**单次交换 O(N) 纯算法**。

同步对象表（只同步「可移动」的，其余永留本地）：

| 数据域 | 同步策略 | 冲突/合并规则 |
|---|---|---|
| `ChatSession(id, title, modelId, createdAt, updatedAt, …元数据)` | 双向（per-session） | 元数据：**LWW on `updatedAt`**（重命名 / 分类 / pin = 谁后写谁赢）；`createdAt / id` 永不改 |
| `RawMessage(sessionId, id, role, partsJSON, sortOrder, createdLocallyAt, originDeviceId)` | **追加型合并，永不改旧** | 合并规则见下；每 msg 带 `originDeviceId`（生成端） + `createdLocallyAt`（单调端内时钟） |
| `CompactMarker(id, sessionId, lastCompactedMessageId?, firstKeptMessageId?, firstKeptSortOrder, summary, createdAt)` | 双向（marker 是事实） | **权威锚 = `lastCompactedMessageId`**（与 DeskMinis 现有类型一致；`firstKeptMessageId` 为辅助锚）。**LWW on `createdAt`**；同一压缩区间若两端各压缩出不同 marker，保留 `createdAt` 较晚的一条，**较早的那条降级为 UI 只读历史**（不删，可在 marker 详情里切换查看）——marker 错配的极端边界由「早 marker 降级」保证 effectiveHistory 永不回涨 |
| `Offload 文件（toolUseId → relativePath 下的 .bin/.log）` | **元数据同步，文件本体不搬** | 仅同步 `(sessionId, toolUseId, originDeviceId, relativePath, size, sha256)`；对侧拿到路径但文件不在本端时，UI 显示「此工具结果在 <设备名> 上，需该设备在线点击取回」，避免手机 256GB 被桌面 log 吃光 |
| 附件（用户上传的图片/文档） | 可选开关，默认「仅同源可用」+ WLAN 时按需推 | 用户显式开「跨端推附件」后，WLAN 直连场景走分块传输，流量与进度可见 |
| Provider 密钥、模型配置、技能代码 / 权限 | **不同步**（两端原生能力栈不同，密钥也不该离开本机） | —— |

**RawMessage 合并规则（核心）**（M3b 第一份伪代码，M3a 验收后写成实现契约）：

```
function mergeSession(sid, A: RawMessage[], B: RawMessage[]): RawMessage[] {
  // 1. 按 <sortOrder, originDeviceId, id> 三路去重（id 重复 = 同一个消息，任一侧有就够）
  const byId = new Map<string, RawMessage>();
  for (const m of [...A, ...B]) byId.set(m.id, m);

  // 2. 排序：先按 (originDeviceId, createdLocallyAt) 做端内稳定序；
  //    再用「该 originDeviceId 下首次出现的 createdLocallyAt」作跨端栅栏（同一条用户消息不能在两端各生成一份还能交叉）。
  // 3. Compact marker 合并：权威锚 = `lastCompactedMessageId`（DeskMinis 侧已有）。
  //    marker 前的所有历史以 `lastCompactedMessageId` 划定（该 id 及之前的消息全部压缩掉）。
  // 4. 结果保证：对任一端的 getLatestCompactMarker(sid) + buildEffectiveHistory，
  //    合并后两侧消息 id 序列与 token 水位完全一致（这是我们 432 用例中 chat-context-info 的红线）。
  //    具体伪代码与锚换算时序在 M3b 计划文档里展开。
}
```

同步触发机制（三触达）：
- A. 事件驱动：本地 `RawMessage INSERT / UPDATE compact marker / session rename` → DB trigger → 入 pending 队 → 立即推对端；
- B. 心跳：已配对在线节点 5s 一次 `sync.cursor(sid, afterTs)`，缺的批量拉；
- C. 用户手动：任务面板「同步」按钮 + `deskminis-cli sync pull/push <sid/all>`（paseo 同级 CLI）。

### M3c · 跨端接力（在 M3b 稳定后做）

> 接力 = **M3b 同步 + 执行端粘性切换**。把「工具在哪端跑」显式到 session 绑定里，不搞「透明调度」——透明调度在跨原生栈上必崩。

会话级元数据新增两个可选字段（两端都在 M3c 之后加，旧 build 忽略即向前兼容）：

```typescript
/** 会话执行粘性（M3c 新增）。 */
type SessionRunner =
  | { kind: 'sticky'; deviceId: string }            // 默认：工具在首次创建该会话的 deviceId 上跑
  | { kind: 'pin';    deviceId: string }            // 用户显式钉到某端（如：这条线就是桌面 powershell）
  | { kind: 'auto-native'; preferredToolFamilies: ('windows-bridge'|'ish-proot'|'local-shell')[] };
```

- **创建端粘性（默认）**：会话由哪端新建，后续该会话内的 `shell/files/windows-clipboard` 就走那端；对端发 chat.prompt 时，实际只是 M3a 远程调创建端的 `chat.prompt`——本地端自己不跑 loop。
- **显式钉住**：用户在会话详情下拉「始终在 <桌面/手机> 运行」→ 变 `pin`。切换时做一次 **M3b 全量 flush**（未同步的消息/marker 先推平）再切，避免出现「桌面这边 clip 已读 + 手机那边还在跑旧权限」的半态。
- **接力失败安全**：钉住的那端离线/超时 → UI 橙条显示「<设备> 不在线；请在线后重试 或 改在本机执行」，绝不「默默切到本机」去拿不同能力跑同一个工具名。
- **能力声明**：每条连接在 M3a 握手后顺带 `GET /capabilities` 返回 `{ windowsBridge: true, ish: true, clipboard: 'rw', screenSnippet: 'always-ask' }`，`auto-native` 只按它选，不空跑。

---

## 2. 安全模型

### 2.1 配对与信任建立（类 Signal 的安全码，不引第三方身份）

1. **用户一次性在两端输入 8 字配对码（或扫码）**，两端派生：
   - 长期配对密钥：`PairingKey(seed=HKDF(pairingCode || salt)) → (auth_key, session_secret, room_id)`；`auth_key` 专用于 PASETO v4.local 的对称认证加密，`session_secret` 作为后续会话密钥派生的种子，`room_id` 用于中继房间定位；
   - 长期身份用 **X25519 静态密钥**（本地生成，不导出），配对码只做首次握手的身份绑定。
2. 每次会话（每一次 M3a 连接）：**X25519 ECDH** 生成本次对称密钥 `SessionKey`；**短期 PASETO v4.local**：
   - 时效：10 分钟；
   - 加密端：由 `PairingKey.auth_key` 做 PASETO v4.local 对称认证加密（含 AEAD），payload 内含 `exp / iat / device_fingerprint`；
   - 用途：替换远程客户端的 `?token=`；本机渲染进程仍用老的 per-run UUID token（见 §3，互不干扰）。
3. **不信任中继**：中继只做 roomId -> 两路 WS 的字节转发，**不看 payload**；所有帧在进入 relay 前用 `SessionKey` 做 AES-256-GCM，到对端再解。
4. **设备名与指纹**：每端显示「连接设备」+ 6 位安全码（由静态公钥前 3B 派生），用户在两端比对后再确认，防「中间人」。

### 2.2 传输加密

| 通道 | 加密方式 |
|---|---|
| 局域网直连 | **mTLS**：证书由 PairingKey 派生（两端都是自签但带配对签名），浏览器页端客户端证书由 app 注入 |
| Tailscale / WireGuard | 依赖底层全链路加密；minisd 侧仍要求 PASETO（双重保险，避免 tailscale 被打穿时直接裸奔） |
| 官方中继 | **AES-256-GCM per frame**，密钥走 ECDH 生成，中继见不到明文；WebSocket 本身走 Wss（官方 relay 必须 TLS） |

### 2.3 Token 生命周期

| Token 类型 | 持有者 | 生命周期 | 吊销方式 |
|---|---|---|---|
| 旧 `authToken`（本机渲染进程） | Electron 主进程 + 自己的 renderer | 进程单次启动 | 退出 minisd 即失效 |
| PASETO 会话 Token（远程客户端） | 两端本地密钥链 | 10 分钟自动过期 | 配对失效（用户删除配对）→ 在服务端校验里直接拒绝该 PairingKey 派生的 PASETO（auth_key 失效） |
| PairingKey 长期认证/加密料 | 仅两端本地 secure storage（iOS Keychain / Android Keystore / Windows DPAPI） | 永久，除非用户取消配对 | GUI「取消配对」+ CLI `deskminis-cli remote unpair <fingerprint>` 双路径 |

---

## 3. 与现架构的接缝（全部锚定到源码，不凭记忆）

### 3.1 `startMinisd` 的 host 参数

- 现入口：[deskminis/src/minisd/index.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) L98
  ```ts
  export async function startMinisd(opts?: { dataDir?: string; host?: string; port?: number; permTimeoutMs?: number }): …
  ```
  且 L437 `const port = await rpc.listen(opts?.host ?? '127.0.0.1', opts?.port ?? 0);`——**host 参数已经存在**，M3a 只需要：
  - 在「设置 → 远程接入」GUI 勾选后，把 Electron `startMinisdProcess()` 里 `utilityProcess.fork(...)` 的 env 加 `MINISD_HOST=0.0.0.0`（或 Tailscale IP），并让 minisd 在 `DESKMINIS_STANDALONE === '1'` 分支里读该 env 传入 `startMinisd({ host })`。
  - **不新增参数、不改签名**。

### 3.2 `RpcServer` 认证

- 现实现：[deskminis/src/minisd/rpc/server.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/rpc/server.ts) L19–30
  - `verifyClient` 当前两件：
    1. `url.searchParams.get('token') === this.authToken`（per-run 本机用）；
    2. Origin 白名单：只放 `undefined / file:// / http://localhost / http://127.0.0.1`。
- M3a 的接缝：**给 RpcServer 构造函数增加可选 `additionalVerify?: (info) => boolean` 回调**（而不是改现有逻辑）：
  - 本机客户端照旧走老 token；
  - 远程客户端**不**带老 token，而是 `?paSeto=<v4.local...>`，在 additionalVerify 里做 PairingKey + 时效校验；
  - Origin 白名单**对远程关闭**：WS 本来就不关同源，Origin 防线本来只针对「浏览器任意网页能偷连本机 token」——远程客户端本来就不是浏览器页。
- **保持 `broadcast(method, params)`（L64）完全不改**：这样不管是本机渲染还是远程手机，`chat.event / permission.request` 都同时送达。

### 3.3 握手行 / minisdInfo IPC

- 主进程 [deskminis/src/main/index.ts](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/main/index.ts) L17 parseHandshake、L102 `ipcMain.handle('minisd:info', () => ({ port, token }))`
- M3a 不碰 IPC 面（手机不走 Electron）；手机端用「PairingKey → PASETO」这条路径连上即可，不拿本机 token。

### 3.4 undici 不走系统代理的现实

- 现状态：`deskminis/package-lock.json` 里 `undici 6.28.0` 做 devDeps；src 里目前**没有**显式 `globalThis.fetch = undici.fetch`，也没有给 fetch 传 `dispatcher: new undici.Agent({ connect: { noProxy: true } })` 的代码。
- M3a 必碰：**所有 minisd 对外出流量（relay 拨出、Tailscale 健康检查）都必须绕开用户系统代理**——否则某公司员工全局代理到 SASE，relay 连接被截胡就把「端到端加密」变成「到代理终止」。做法：
  - 把 undici 提升到 `dependencies`；
  - 在 minisd 的「outbound HTTP 客户端」统一出口里显式传 `noProxy: true` 的 dispatcher；
  - LAN/mDNS/Tailscale 直接走 IP + 自签 host 白名单，不过 HTTP CONNECT。
- 这是 M3a 的显式改动点，在写 M3a 实施计划时单独列一条，不与「现有 provider 的 HTTPS」合并——providers 的流量应该**尊重**系统代理（否则国内用户没代理打不到 OpenAI），只有 M3a 的「对端/中继连接」才强制 noProxy。

### 3.5 现有 Windows 托盘常驻 / quit / lifecycle

- M3c 跑接力时：手机 M3a 远程 call `chat.prompt` → 桌面 loop 跑 windows-bridge → 权限请求仍由 `RpcServer.broadcast('permission.request', req)` 发给所有连接（包括手机）；**手机也能回 `permission.respond`**（allow-once/allow-session/deny 三选一）。
- **不新增加权逻辑**：桌面 GUI 已经会弹 PermissionCard，手机侧有对应 OffloadPermissionDialog 的 UI 链（`OpenMinis/src/ios/Views/Chat/OffloadPermissionDialog.swift`），保持两端都可决策。

### 3.6 M3 协议与 OpenMinis 既有 Sync V2 的关系

OpenMinis 已有一套完整的 `Agent/Sync/V2` 子系统（[`SyncedTypes.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/SyncedTypes.swift)、[`ChatStoreSyncHydrators.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/ChatStoreSyncHydrators.swift)），以 CloudKit `CKRecord` 为传输层，支持 `SessionV2 / MessageV2 / CompactMarkerV2 / SkillV2 / ProviderConfigV2` 等类型的 builder + merger + deletionApplier。M3 不是从零造第三种形状，而是**复用 OM 的 Sync V2 类型定义与水合器、替换其传输层与冲突策略**。

| 维度 | OM 现有 Sync V2 | M3 演进关系 | OM 侧需改 |
|---|---|---|---|
| **线格式定义** | `SyncedSession` / `SyncedMessage` / `SyncedCompactMarker` 等 `Syncable` 协议类型 | **直接复用字段名与类型**，M3 线格式 = SyncedTypes 的 JSON 序列化（不含 CKRecord wrapping），不发明第三种形状 | 无字段改名；仅把 `buildPortable` / `parsePortable` 从 CKRecord 解耦到通用 JSON blob |
| **传输层** | CloudKit `CKRecord` + `fetchRecentV2` / `pushDirtyV2` | **替换为 M3a WS JSON-RPC 帧**（`sync.push` / `sync.pull` / `sync.cursor` methods），同一 `PortableRecord` payload 改走 WebSocket；iCloud 与 M3 并存（用户可选关闭 iCloud 只留 M3，或两者同时开——云端走 CK，M3 走 WS） | 在 `SyncCore` 里新增 `M3TransportAdapter`（实现 `SyncTransport` 协议），与现有 `CloudKitTransport` 并存；builder/merger 复用，脏行标记复用 |
| **冲突策略** | `SessionV2` = LWW-by-updatedAt；`MessageV2` = LWW-by-updatedAt；`CompactMarkerV2` = `.alwaysAccept`（因为 CK 用 record 级 LWW） | **Message/Session 保持 LWW**；**CompactMarker 改为 M3b 专用策略**：`lastCompactedMessageId` 主锚 + LWW on `createdAt` + orphan 降级（见 §4.4），不再是 `.alwaysAccept` | `mergeCompactMarker`（[`ChatStoreSyncHydrators.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/ChatStoreSyncHydrators.swift) L280-302）需要新增分支：当 inbound 来源是 M3 transport 时，执行 M3b 策略；CK 来源保持原 `.alwaysAccept`（避免破坏旧 build 的 iCloud 行为） |
| **设备来源字段** | `SyncedMessage` 无 `originDeviceId`；`mergeRemoteSession` 里 `fromDeviceId` 当前传空串哨兵（[`ChatStoreSyncHydrators.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/ChatStoreSyncHydrators.swift) L182） | **M3b 必填 `originDeviceId`**，用于跨端消息去重与端内单调排序 | `SyncedMessage` 加 `originDeviceId: String` 字段；`mergeRemoteSession` 的 `fromDeviceId` 从空串改为真实 device fingerprint；Kotlin `MessageEntity` 同构加列 |
| **Session 元数据扩展** | `SyncedSession` 已有 `pinnedAt` / `memoryEnabled` / `modelBinding` | **M3c 新增 `sessionRunner` 序列化字段**（JSON string 塞入 `modelBinding` 的兼容位或新增独立字段），旧 build 忽略 | 待定：若 OM 侧 `modelBinding` 已废弃，则直接新增 `sessionRunnerJson` 字段；否则复用 `modelBinding` 做 JSON 透传 |
| **文件传输** | `SessionFileV2` 走 CK `PortableAsset`（builder 把文件塞 asset，merger 写回磁盘） | **M3b 元数据同步复用 `SyncedSessionFile` 字段**；文件本体不走 WS（见 §M3b 表），改用 M3a 的「在线设备按需拉」API（`GET /attachments/:sha256`，经 PASETO 鉴权） | `SessionFileV2` builder 在 M3 transport 下只推元数据（`relativePath/size/sha256`），不附 asset；merger 在 M3 下只写元数据，文件实体走新的 `M3AttachmentDownloader` |
| **Provider/Skill/EnvVar 同步** | 已有整套 builder + merger | **M3 本期不同步**（见 §5 非目标）， builder 在 M3 transport 下返回 `nil`（不推），merger 对 M3 transport 来源直接 skip | `buildProviderConfig` / `buildSkill` 等新增 guard：`if transport.kind == .m3 { return nil }` |

**核心原则**：OM 侧 `ChatStoreSyncHydrators` 的注册表结构（`builder / merger / deletionApplier`）保持不动；M3 只新增一个 transport adapter 和几行来源分支判断，不拆 Hydrators。这样 OM 侧改动面最小，且 iCloud Sync V2 与 M3 可长期并存。

---

## 4. 两端数据模型差异与同步映射（§1 OpenMinis 克隆只读核实）

> 以下差异来自 `./OpenMinis/src/` 的实际源码扫描；没有的字段不假设存在。

### 4.1 会话层

| 字段（DeskMinis = DM） | 类型（DM） | 字段（OpenMinis iOS = OM） | 类型（OM） | 映射 |
|---|---|---|---|---|
| `ChatSession.id` | UUID | `ChatSession.id` | String | **1:1 同一 ID，永不换**；新建会话由创建端生成 UUID，同步直接带 |
| `ChatSession.title` | string \| null | `.title` | String? | LWW on updatedAt |
| `ChatSession.createdAt/updatedAt` | number (ms) | `.createdAt/updatedAt` | Foundation.Date | OM → Unix ms；同步两端都按数值比较，避免时区漂移 |
| `ChatSession.lastMessage` | string | `.lastMessage` | String? | 由 RawMessage 合并后派生，不同步字段本体，合并时在本地重算 |
| **DM 没有但 OM 有**：`lastSyncedAt / remoteDeviceId / remoteDeviceName` | — | — | Date? / String? / String? | DM 追加到 `sessions` 表（作为 M3b 新列），旧值 NULL；OM 这些字段原样保留，用于 UI 显示「该会话来自 <设备名>」 |
| **OM 有但 DM 没有**：`pinnedAt` | — | `.pinnedAt` | Date? | DM 同步新增 `pinnedAt` 列（paseo 等价「pin」） |

### 4.2 消息层

| DeskMinis `RawMessage`（见 chat-store.ts schema） | OpenMinis `RawMessage`（ChatStore.swift + Kotlin `MessageEntity`） | 同步映射 |
|---|---|---|
| `id TEXT PRIMARY` | `id TEXT` | 1:1，永不改 |
| `sessionId TEXT` | `sessionId TEXT` | 1:1 |
| `role TEXT('user'/'assistant'/'toolResult'/…)` | `role`（OM 里叫 `ChatMessageRole` + DB enum） | 枚举名对齐；不一致时 DM 统一成小写字符串入库，对侧再映射 |
| **parts**：`partsJSON TEXT`（M1 共用 parts.ts，包含 text / toolUse / toolResult） | `AssistantBlock / user content + attachments`，拆多列 + blocks JSON | **统一同步为 `partsJSON`**；OM 侧在合并前后做 A→B 转换（iOS 已存在「Phase 2/2.5 组装 ChatMessage」的 hydrator：`Agent/Sync/V2/ChatStoreSyncHydrators.swift`，可复用） |
| 新增：`originDeviceId TEXT`、`createdLocallyAt INTEGER` | **两端均为新增列**：OM 侧 `RawMessage`（Swift）/ `MessageEntity`（Kotlin）当前均无设备来源字段；M3b schema 迁移时各端各加（OM iOS DB `origin_device_id TEXT` + `created_locally_at REAL`，Android 同构）。旧历史统一回填 `originDeviceId = 'legacy'`，合并时靠 id 去重，不影响正确性 |
| `sortOrder` 单调整数 | `sort_order INTEGER`（Kotlin）/ Swift `sourceSortOrder/lastSourceSortOrder` UI 字段 | **同步不直接信任 sortOrder**（两端各写会撞号），合并时按 §M3b 「端内单调 + 端首次出现」重排稳定序，再各自写回自己的 sortOrder——这样 sortOrder 只是本地展示索引，不是同步事实源 |
| `CompactMarker.lastCompactedMessageId` | `CompactMarker.lastCompactedMessageId` + `CompactMarker.firstKeptMessageId`（iOS Phase A 双锚；见下方锚换算） | **线格式权威锚 = `lastCompactedMessageId`**（对齐 OM `SyncedCompactMarker`，该字段已有但 OM 主写 `firstKeptMessageId`）；辅助锚 `firstKeptMessageId` 用于 OM→DM 缺失 `lastCompactedMessageId` 时的回算（见 §4.4） |

### 4.4 CompactMarker 锚换算时序（M3b 关键算法）

> 前提：DeskMinis 当前只存 `lastCompactedMessageId`（[`shared/types.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/shared/types.ts) L65）；OpenMinis 的 `SyncedCompactMarker`（[`Agent/Sync/V2/SyncedTypes.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/SyncedTypes.swift) L132-160）同时有 `firstKeptMessageId?`、`lastCompactedMessageId?`、`firstKeptSortOrder`、遗留下的 `boundaryMessageId`。线格式必须同时兼容两端，因此采用「双锚齐备，主锚 = `lastCompactedMessageId`」方案。

**线格式（DM ↔ OM）权威定义**：

```typescript
interface WireCompactMarker {
  id: string;
  sessionId: string;
  summary: string;
  createdAt: number;
  /** 主锚：最后一条被压缩的消息 id。优先使用该字段。 */
  lastCompactedMessageId?: string;
  /** 辅助锚：压缩区间后第一条保留消息 id。仅在 `lastCompactedMessageId` 缺失时使用。 */
  firstKeptMessageId?: string;
  /** 辅助排序锚：firstKeptSortOrder 必填（Sync V2 已有，DM 按本地序回填）。 */
  firstKeptSortOrder: number;
  compactedCount: number;
  /** 遗留字段，兼容旧 OM build */
  boundaryMessageId?: string;
  uiBoundarySortOrder?: number;
  version: number;
}
```

**DM → 线格式（出口）**：
- 直接从本地 `CompactMarker` 带出 `lastCompactedMessageId`；
- 按本地 `RawMessage` 表 `sortOrder` 序，找到 `lastCompactedMessageId` 的 `sortOrder`，其下一个消息的 `sortOrder` 即 `firstKeptSortOrder`；若后方无消息，则 `firstKeptSortOrder = lastCompactedMessageId.sortOrder + 1`；
- `firstKeptMessageId` 按需填入（若不为空则作为辅助锚发给对端，DM 本地不存该列，可线格式 transient 带出）。

**线格式 → DM（入口）**：
1. **优先取 `lastCompactedMessageId`**（非空且该 id 存在于合并后的消息序列中）→ 直接写入 DM `CompactMarker`；
2. **缺失时回退到 `firstKeptMessageId`** → 在**合并排序后的消息序列**上查找该 id 的前一条消息 id，回算为 `lastCompactedMessageId`；
   - *时序关键*：此回算**必须发生在 `mergeSession()` 完成消息合并排序之后**，不能对线格式原始记录直接算（因为 raw messages 在两端的顺序可能不同，只有合并后的统一序列才具备「前一条」语义）；
   - 若回算失败（firstKeptMessageId 在合并序列中不存在或已是首条），则将该 marker 标记为 `orphan`，暂不生效，等后续缺失消息从对端补齐后再重算；
3. **两个锚都缺失** → 降级为 legacy v1 处理链：用 `firstKeptSortOrder` 在合并后序列上按 sortOrder 定位，取该位置前一条消息 id 作为 `lastCompactedMessageId`；仍失败则标记 orphan。

**线格式 → OM（入口，已有 hydrator 可复用）**：
- 直接映射到 `SyncedCompactMarker` 全字段，`mergeRemoteCompactMarker`（[`Agent/Sync/V2/ChatStoreSyncHydrators.swift`](file:///c:/Users/24739/Downloads/openminis1/OpenMinis/src/ios/Agent/Sync/V2/ChatStoreSyncHydrators.swift) L280-302）原样写入；OM 本地已有双锚字段，无需额外换算。

### 4.3 能力差异（决定 M3c 的工具家族白名单）

| 原生工具 | DeskMinis（Windows） | OpenMinis iOS | OpenMinis Android | 跨端接力默认行为 |
|---|---|---|---|---|
| Shell | PowerShell（windows 系统） + 六个桥（windows-*） | iSH Alpine 沙箱（非真实 Linux） | Termux + PRoot | 跑在创建端；**不在两端透明转发 shell 字节流**（那相当于另做一个 Paseo 终端，本期不做，M3 非目标） |
| Files | 本机文件系统（受会话工作区 + mounted folders 限制） | iOS FileProvider 挂载 | SAF / Storage Access | 同 shell，默认创建端；需要跨端取文件用 M3b 的「按需取附件」 |
| Clipboard | 有（windows-clipboard） | UIPasteboard（需权限） | `ClipboardManager` | 默认创建端；跨端剪贴同步是 M4 单独立项，不蹭本次 |
| 模型 provider / 密钥 | 独立 provider-store（Windows Credential Manager / DPAPI 存储） | Keychain + ProviderConfigStore | EncryptedSharedPreferences | 永远不同步；两端各自配 |
| 语音（STT/TTS） | 本地 SAPI / System.Speech（或本地 Vosk） | 本地 `SpeechOffload / VisionOffload / SpeakOffload / WeatherOffload` 原生桥（`OpenMinis/src/ios/NativeOffloads/*.{swift,m,h}`） | Android `SpeechRecognizer + TextToSpeech` | **不同步任何语音字节、不同步识别文本**；两端自己 STT 后，把文本结果当普通 user message 走正常 RawMessage 同步链路 |

---

## 5. 明确非目标（本期 M3 绝对不做，写死防需求蠕变）

- ❌ 「外部挂载树」「NAS 网络盘双向同步」「SMB/SFTP 实时镜像」：属于文件同步子系统，M3 只处理会话数据；用户需要跨端看文件，走 M3c「钉在源端跑 + 按需拉单文件附件」。
- ❌ 多用户 / 协作 / 共享会话：M3 是「同一个用户的多设备」，不是「多人共写一条会话」。配对永远是 1:1 用户自己的两设备，不做邀请链接。
- ❌ 云端存储 / 云端数据库托管：官方 relay 只做**存内密文转发**，不落盘、不持久化、不备份；用户要云端备份自己挂 iCloud/OneDrive，M3b 不接任何对象存储 SDK。
- ❌ 透明跨端 shell 字节流：即 Paseo 的「把桌面终端镜像到手机」那种；需要在手机里复现 PSReadLine、Unicode 宽字符、Windows 控制台转义序列等一堆大坑，单独立项（或等 Paseo 做成熟后评估是否复用），M3 不接。
- ❌ 跨端 clipboard 自动同步：属隐私敏感，单独立项 + 独立权限弹窗 + 独立审计；不蹭 M3 的同步管道。
- ❌ marker 冲突时做「自动合并两个不同压缩摘要」：摘要本身是 LLM 产物，两条不同摘要没有语义合并算法；本期直接晚写赢 + 旧摘要降级可读，足够。
- ❌ 自动「哪端更近就切到哪端」：能力栈差异太大，自动调度=坑；M3c 只有创建端粘性（默认）和用户显式钉（可控）。

---

## 6. 验收路径（高层，非测试代码）

| 里程碑 | 可验收事件 |
|---|---|
| M3a 通过 | 同 Wi-Fi，两端配对成功；手机端在 GUI 里连到桌面，能看见桌面已有会话列表；对桌面 `chat.prompt` 一条，手机侧实时流式拿到 `textDelta / toolStart / toolEnd / turnEnd` |
| M3b 通过 | 地铁模式：手机离线新建会话并发 20 条 + 1 次 compact；回家连上桌面 Wi-Fi，10 秒内合并完成。合并后：① 两侧 `buildEffectiveHistory(sid)` 返回的消息 `id` 序列**逐位完全一致**；② 两侧 `chat.contextInfo.usedTokens` 差值 **= 0**（estimateTokens 是确定性纯函数，effectiveHistory 一致则 token 数必相等；1% 松弛会掩盖合并错位，故要求严格零差） |
| M3c 通过 | 手机把一条原本钉在桌面的会话「改在本机执行」，该会话内的 shell 调用开始报错「本机无 windows-bridge，是否改为在桌面执行？」（而不是静默切到手机 termux 跑空命令） |
| 安全 | Wireshark 在中继侧抓包，全量帧：payload 全密文、roomId 仅派生；取消配对后，旧 PASETO 在 10s 内被服务端拒绝（≤ PASETO 过期窗口） |
| 红线回归 | `npm test 432/432` 全绿；`chat-context-info.test.ts` 例 2 （marker 后水位下降）在两端合并后各自重跑仍绿 |

> 下一步：评审通过后，按 M3a → M3b → M3c 顺序拆三份独立实施计划（每份都按 M2 系列的 Task 化结构 + TDD + 红线）。
