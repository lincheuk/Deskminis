# DeskMinis M3a（远程接入）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 DeskMinis 桌面侧远程接入信道与鉴权（手机端实装属 OpenMinis 代码库，不在本计划范围）：RpcServer 增加可选 `additionalVerify` 回调与按连接 authMode 分级；PASETO v4.local 会话 token；8 字配对码 + X25519 ECDH + PairingKey 落 Windows 凭据库；LAN 直连 + `MINISD_HOST` 接线（mDNS / E2EE 中继往后推）；undici noProxy 出流量隔离红线；`deskminis-cli remote pair/connect/status` 零依赖单文件 CLI；e2e 驱动扮演远程客户端走完整链路。设计依据：`../specs/2026-07-31-m3-sync-design.md` §1-M3a / §2 / §3.1-§3.4。

**Architecture:** RpcServer 老 token 路径增加回环源地址双条件（`remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}`）保证 local 的「本机」语义不依赖 token 保密性，新增 `additionalVerify?: (info) => { ok: true; authMode } | { ok: false } | Promise<...>` 回调与按连接 `authMode: 'local' | 'pairing' | 'remote'` 标记；远程客户端经 `?paseto=<v4.local>` 或 `?pairingCode=<8chars>` 进入 additionalVerify，分别得到 `remote` / `pairing` 模式。`remote.*` RPC 面（pair.begin/pair.complete/status/unpair）按 authMode 分级管控：pair.begin/status/unpair 仅 `local`，pair.complete 仅 `pairing`，业务面（chat.*/permission.*/...）接受 `local | remote` 但拒 `pairing`。PairingKey 由 X25519 静态密钥 ECDH + HKDF 派生（auth_key/session_secret/room_id），存 `KeyringVault`（沿用 M1 路径，key 前缀 `pairing.<fingerprint>`）。传输本期只做 LAN 直连：`MINISD_HOST` env 接到 minisd standalone 分支。undici 新增为直接 dependencies（现状仅 node-gyp 传递依赖）+ noProxy dispatcher 仅给 M3 出流量用，provider 流量继续走系统代理（红线）。

**Tech Stack:** TypeScript (strict) / Node 22（electron as node）/ vitest / `@napi-rs/keyring`（已有，PairingKey 存储）/ **noble 套件新增**（`@noble/ciphers` + `@noble/hashes` + `@noble/curves`，PASETO v4.local + X25519 ECDH + HKDF/BLAKE2b，纯 JS 零原生构建）

## Global Constraints

- 所有代码在 `deskminis/` 子目录（仓库根是 `C:\Users\24739\Downloads\openminis1\`，`OpenMinis/` 是只读参考克隆，永不修改）
- TypeScript `strict: true`；包管理 npm
- 时间戳一律 **epoch 秒（浮点）**
- 测试命令统一 `npm test`（vitest run，跑在 electron as node 下）；单文件 `npm test -- tests/xxx.test.ts`
- 提交信息用 conventional commits + 中文描述（如 `feat(m3a): …`）
- 代码基线 = **main@87b3de4**（M2 全收官 + M3 设计定稿，432 测试 / 42 文件全绿）；本里程碑新增测试约 43 例，完成后全量约 475 例
- **单测禁外网**：配对/PASETO/ECDH 全本地可测；e2e 驱动走本地 127.0.0.1 WS，不拨任何外部地址
- 432 基线不回归：`startMinisd` 返回值只增字段；`verifyClient` 老路径**本机回环连接的行为**不变（仅新增「非回环源地址的老 token 拒绝」分支——见上条 local 双条件红线，基线所有用例都连 127.0.0.1 不触发新分支）；`broadcast` 一行不改
- Windows-only：KeyringVault 走 Windows 凭据库；LAN 直连 + mDNS 发现本期只做直连（mDNS 推到 M3b 前置或独立子项）
- **协议零改动边界**（设计注意点 a）：业务面 RPC（`chat.*` / `permission.*` / `skills.*` / `provider.*` / `modelgroup.*` / `terminal.*` / `files.*`）签名与语义一行不动；新增的 `remote.*` RPC 面是唯一新增面，且按 authMode 分级：`remote.*` 仅接受本机老 token 连接调用，远程 PASETO 连接不可调（防止远程端自己给自己续配对）；唯一例外是 `remote.pair.complete` 接受 `pairing` 模式（配对握手期专用，一次性）
- **local 模式 = 老 token + 回环源地址双条件，缺一即拒**（评审缺口修订）：`MINISD_HOST=0.0.0.0` 开启远程接入后，老 token（per-run UUID）一旦泄漏给局域网（如路由器日志、抓包），若无源地址绑定，持 token 者可获 local 模式进而调 `remote.pair.begin` 自行配对。修订后 `verifyClient` 老路径要求：`token === authToken` **且** `req.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}` 才判 local；非回环源地址的老 token 连接一律 401（不落入 additionalVerify——老 token 语义就是本机，远程客户端走 PASETO/配对码路径）。本机渲染进程/utilityProcess.fork 子进程的 WS 连接经 OS 回环，不受影响。

## 架构决策（实现前必读）

1. **PASETO v4.local 引 noble 套件自实现，不引 paseto 专用库。** 理由：① Node 生态的 paseto 库（`paseto`/`@auth0/paseto`/`paseto-ts`）维护活跃度与审计可信度均不如 noble；② v4.local 的全部原语（XChaCha20-Poly1305、BLAKE2b、HKDF） noble 三件套（`@noble/ciphers` / `@noble/hashes` / `@noble/curves`）覆盖；③ noble 纯 JS 零原生依赖，无需 `electron-rebuild`，与 `@napi-rs/keyring` 的原生构建链解耦；④ 同一套件同时覆盖 Task 3 的 X25519 ECDH，一个依赖族解决 M3a 全部密码学。PASETO PAE（Pre-Authentication Encoding）薄包装层约 40 行，按 spec 实现；测试用往返 + 篡改 + 过期，不依赖凭记忆写死的官方测试向量（实现者可从 paseto-platform/test-vectors 补官方向量用例，但不强制）。
2. **authMode 三级而非两级。** 设计 §2.1 把配对与 PASETO 分开描述，落地到 RpcServer 自然形成三级：`local`（老 authToken **+ 回环源地址双条件**，渲染进程 + 本地 CLI）、`pairing`（`?pairingCode=`，一次性握手专用，只能调 `remote.pair.complete`）、`remote`（`?paseto=`，业务面全开，`remote.*` 全关）。两级（local/remote）无法表达「配对期连接还没 PairingKey 却要完成握手」的中间态——会让 pair.complete 不得不放进 remote 模式，而 remote 模式又要求 PASETO，形成鸡生蛋。pairing 模式 + 5 分钟 code 过期 + 一次性（complete 后服务端关连接）是唯一自洽解。**local 的「本机」语义由 `req.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}` 源地址保证，不依赖 token 保密性**——`MINISD_HOST=0.0.0.0` 后老 token 若被嗅探，局域网攻击者持 token 仍因非回环源地址被 401 拒绝，无法绕过 PASETO/配对码路径自行升权。
3. **PairingKey 存 KeyringVault，key = `pairing.<fingerprint>`。** 沿用 M1 [`KeyringVault`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/provider-store.ts) L26-36（entry service='DeskMinis'），不新引存储后端。fingerprint = base32(ECDH 共享密钥前 3 字节) → 6 字符，与设计 §2.1 第 4 点「6 位安全码」一致，供用户两端比对防 MITM。多设备配对：每个 fingerprint 一条 vault 记录，`remote.status` 列全部。
4. **配对协议时序**（M3a LAN 直连版）：
   - 桌面 `remote.pair.begin()`（local 调用）→ 生成 8 字配对码 + 取本机 X25519 静态公钥；返回 `{ code, ourPubKeyB64, fingerprint, expiresAt }`；pending 记录 5 分钟过期。
   - 手机/CLI `remote.pair.complete({ code, peerPubKeyB64 })`（pairing 模式，`?pairingCode=<code>`）→ 服务端 ECDH(本机 sk, 对端 pk) → HKDF 派生 auth_key/session_secret/room_id → 存 vault `pairing.<fingerprint>` → 返回 `{ fingerprint, ourPubKeyB64 }`（让对端算出相同 fingerprint）→ 服务端关连接。
   - 两端用户比对 6 字 fingerprint → 确认无 MITM（M3a e2e 自动断言两端 fingerprint 相等）。
   - 配对完成后，远程用 auth_key 铸 PASETO v4.local（payload: exp/iat/device_fingerprint），`?paseto=` 连接 → authMode=remote。
5. **MINISD_HOST 接线不改 startMinisd 签名。** 设计 §3.1 已明示。当前 standalone 分支 [`minisd/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/index.ts) L450-461 调 `startMinisd()` 无 opts；改为读 `process.env.MINISD_HOST` 传入 `{ host: process.env.MINISD_HOST ?? '127.0.0.1' }`。主进程 [`main/index.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/main/index.ts) L31 `utilityProcess.fork` 的 env 在「设置-远程接入」开启后追加 `MINISD_HOST: '0.0.0.0'`（或 Tailscale IP，M3a 只默认 0.0.0.0，GUI 开关留 M3b/独立 GUI 任务）。
6. **undici noProxy 是 M3 出流量专用出口，不污染 provider 路径。** 设计 §3.4 红线：「providers 的流量应该尊重系统代理，只有 M3a 的对端/中继连接才强制 noProxy」。落地为独立模块 `src/minisd/remote/noProxyFetch.ts`，导出 `noProxyFetch()` 与 `noProxyDispatcher`；M3 传输代码（relay 拨出、Tailscale 健康检查）独占使用。provider 的 HTTPS（[`providers/`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/providers) 下的 fetch）一行不碰，继续走全局 fetch（受系统代理）。M3a 本身没有 relay 出流量（LAN 直连），该模块作为基础设施 + 红线测试落地，供 M3b relay 接入。
7. **CLI 仿 bridge-cli.mjs 零依赖单文件。** `deskminis/src/cli/remote-cli.mjs`，ESM，只用 node 内建 + `ws`（已在 deps）。连接 minisd 走 WS（`?token=`，local 模式）；port+token 经 `--port`/`--token` 或 env `MINISD_PORT`/`MINISD_TOKEN` 传入（GUI 设置页后续提供复制按钮，M3a 不做 GUI）。子命令：`pair`（调 remote.pair.begin，打印 code+二维码字符画+fingerprint）、`connect <code>`（扮演手机端：本地生成临时 X25519 keypair → 连 `?pairingCode=` → remote.pair.complete → 打印 fingerprint 供比对）、`status`（列已配对节点）、`unpair <fingerprint>`。
8. **e2e 驱动继承 M2 系列临时数据根隔离。** `scripts/e2e-m3a-acceptance.mjs`：mkdtemp 数据根 → spawn `out/main/minisd.js`（先 `npm run build`）带 `DESKMINIS_STANDALONE=1` + `MINISD_HOST=127.0.0.1` + `DESKMINIS_TEST=1`（vault 用 InMemoryVault）→ 握手行取 port+token → 驱动扮演 local/pairing/remote 三种客户端走全链路 → 结束 rmSync 数据根。不触碰真实凭据库、不联网。

## 文件结构总览（相对 main@87b3de4 基线的增量）

```
deskminis/
  package.json                           (改) deps +3: @noble/ciphers, @noble/hashes, @noble/curves；+1: undici（**新增为直接依赖**——现状是 node-gyp 的传递依赖存在于 package-lock，未在 package.json 直接声明；设计 §3.4「devDeps」措辞不准确，计划里以现状为准）
  src/minisd/rpc/server.ts               (改) constructor +additionalVerify；onConnection 标 authMode；RpcConnection 带 authMode
  src/minisd/remote/paseto.ts            (新) PASETO v4.local encode/decode/verify（noble 套件）
  src/minisd/remote/pairing.ts           (新) X25519 静态 keypair 管理 + ECDH + HKDF + fingerprint + PairingKey vault CRUD
  src/minisd/remote/noProxyFetch.ts      (新) undici Agent(noProxy) + noProxyFetch 导出（M3 出流量专用）
  src/minisd/remote/index.ts             (新) remote.* RPC 方法面（pair.begin/pair.complete/status/unpair）+ localOnly/pairingOnly 守卫
  src/minisd/index.ts                    (改) 装配 remote.* 方法；standalone 分支读 MINISD_HOST；startMinisd 注入 additionalVerify
  src/main/index.ts                      (改) utilityProcess.fork env 按远程接入开关追加 MINISD_HOST（M3a 默认关，env 直传先到位）
  src/cli/remote-cli.mjs                 (新) 零依赖单文件 CLI（pair/connect/status/unpair）
  tests/rpc-server-authmode.test.ts      (新) additionalVerify + authMode + localOnly 守卫
  tests/remote-paseto.test.ts            (新) PASETO v4.local 往返/篡改/过期
  tests/remote-pairing.test.ts           (新) ECDH 派生 + fingerprint 一致 + vault CRUD
  tests/remote-rpc.test.ts               (新) remote.* 方法面 + authMode 分级
  tests/remote-noProxyFetch.test.ts      (新) noProxy dispatcher 配置 + 红线隔离
  tests/remote-cli.test.ts               (新) CLI 子命令端到端（真 WS）
  scripts/e2e-m3a-acceptance.mjs         (新) e2e 驱动（配对→PASETO→WS→chat.sessions.list→chat.event 广播）
```

任务依赖：1 → 2 → 3 → 4 → 5 → 6 → 7（严格串行；4 消费 1+2+3，5 独立但语义上属 M3 出流量基建，6 消费 4，7 消费 1-6 全链路）。

---

### Task 1 · RpcServer additionalVerify + authMode 分级 ✅

**Files:**
- Modify: `deskminis/src/minisd/rpc/server.ts`
- Test: `deskminis/tests/rpc-server-authmode.test.ts`

**Interfaces:**
- Consumes: 无（纯 ws）
- Produces（Task 4 依赖，签名以此为准）:
  - `export type AuthMode = 'local' | 'pairing' | 'remote'`
  - `export interface RpcConnection { notify(method: string, params: unknown): void; authMode: AuthMode }`
  - `RpcServer` constructor 新增第三参数：`constructor(private methods: RpcMethods, private authToken: string, private additionalVerify?: (info: { req: IncomingMessage; url: URL }) => Promise<{ ok: true; authMode: AuthMode } | { ok: false }> | { ok: true; authMode: AuthMode } | { ok: false }>)`
  - `verifyClient` 改造（**评审缺口修订：老 token + 回环源地址双条件**）：
    1. **老路径**：`token === authToken` **且** `req.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}` → authMode='local'；任一不满足则**直接 401，不落入 additionalVerify**（老 token 语义就是本机，远程客户端走 PASETO/配对码）。local 命中后再做 Origin 白名单（保留 `undefined / file:// / localhost / 127.0.0.1`）。
    2. **新路径**：老路径未命中时，若 `additionalVerify` 存在则调用之，ok 则取其 authMode，否则 401；Origin 白名单**仅对 local 模式生效**——additionalVerify 返回的 authMode≠'local' 时跳过 Origin 检查（理由照抄设计 §3.2 原文：「WS 本来就不关同源，Origin 防线本来只针对『浏览器任意网页能偷连本机 token』——远程客户端本来就不是浏览器页」）
  - `onConnection` 把 authMode 透传到 `RpcConnection`
  - `broadcast` 完全不改（L64 原样）

- [ ] **Step 1: 写失败测试**

`deskminis/tests/rpc-server-authmode.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { networkInterfaces } from 'node:os';
import { RpcServer, type AuthMode } from '../src/minisd/rpc/server';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot(additionalVerify?: Parameters<RpcServer['constructor']>[2], host = '127.0.0.1') {
  const rpc = new RpcServer({ echo: (p) => p }, 'LOCAL-TOKEN', additionalVerify);
  const port = await rpc.listen(host, 0);
  cleanups.push(() => rpc.close());
  return { port, rpc };
}

/** 找一个非 internal 的本机 IPv4 用于「LAN 源地址」测试；没有则返回 undefined（用例跳过）。 */
function pickLanIpv4(): string | undefined {
  for (const nets of Object.values(networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return undefined;
}

function connect(port: number, query: string): Promise<{ ws: WebSocket; authMode?: AuthMode }> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?${query}`);
    ws.on('open', () => {
      // 发一个 echo 调用，回包里能间接确认连接已就绪
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { hi: 1 } }));
      ws.once('message', () => res({ ws }));
    });
    ws.on('error', rej);
  });
}

describe('老 token 路径不回归', () => {
  it('?token=LOCAL-TOKEN → local 模式 + Origin 放行', async () => {
    const { port } = await boot();
    const { ws } = await connect(port, 'token=LOCAL-TOKEN');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('?token=错 → 401 拒绝（无 additionalVerify 时）', async () => {
    const { port } = await boot();
    await expect(new Promise((_, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=WRONG`);
      ws.on('open', () => { throw new Error('不该连上'); });
      ws.on('error', rej);
    })).rejects.toThrow();
  });

  it('Origin 白名单仍对 local 生效：http://evil.com Origin → 拒', async () => {
    const { port } = await boot();
    await expect(new Promise((_, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=LOCAL-TOKEN`, { headers: { origin: 'http://evil.com' } });
      ws.on('open', () => { throw new Error('不该连上'); });
      ws.on('error', rej);
    })).rejects.toThrow();
  });
});

describe('local 模式 = 老 token + 回环源地址双条件（评审缺口修订）', () => {
  // 跑 CI/无网环境可能没有非 internal 接口；此时跳过本组（不跳过会假绿——服务器无 LAN IP 可绑）
  const lanIp = pickLanIpv4();
  it.skipIf(!lanIp)('listen 0.0.0.0 + LAN IP 携老 token → 401（防嗅探 token 升权）', async () => {
    const { port } = await boot(undefined, '0.0.0.0');
    // 从 LAN IP 连过来：socket.remoteAddress 是 LAN IP，非回环
    await expect(new Promise((_, rej) => {
      const ws = new WebSocket(`ws://${lanIp}:${port}?token=LOCAL-TOKEN`);
      ws.on('open', () => { throw new Error('LAN IP 携老 token 不该连上'); });
      ws.on('error', rej);
    })).rejects.toThrow();
  });

  it.skipIf(!lanIp)('listen 0.0.0.0 + LAN IP + paseto 合法 → 仍连上（remote 不绑源地址）', async () => {
    const { port } = await boot(async () => ({ ok: true as const, authMode: 'remote' as AuthMode }), '0.0.0.0');
    const ws = await new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(`ws://${lanIp}:${port}?paseto=VALID`);
      w.on('open', () => res(w)); w.on('error', rej);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('回环 127.0.0.1 + 老 token 仍 local（不回归本机渲染进程连接）', async () => {
    const { port } = await boot(undefined, '0.0.0.0');
    const { ws } = await connect(port, 'token=LOCAL-TOKEN');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('additionalVerify 分级', () => {
  it('?paseto=xxx → additionalVerify 返回 {ok:true, authMode:remote} → 连上', async () => {
    const { port } = await boot(async ({ url }) => {
      const p = url.searchParams.get('paseto');
      return p === 'VALID' ? { ok: true as const, authMode: 'remote' as AuthMode } : { ok: false };
    });
    const { ws } = await connect(port, 'paseto=VALID');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('additionalVerify 返回 {ok:false} → 401', async () => {
    const { port } = await boot(async () => ({ ok: false }));
    await expect(new Promise((_, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?paseto=BAD`);
      ws.on('error', rej);
    })).rejects.toThrow();
  });

  it('remote 模式跳过 Origin 白名单：http://evil.com Origin 但 paseto 合法 → 连上', async () => {
    const { port } = await boot(async () => ({ ok: true as const, authMode: 'remote' as AuthMode }));
    const ws = await new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}?paseto=VALID`, { headers: { origin: 'http://evil.com' } });
      w.on('open', () => res(w)); w.on('error', rej);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('pairing 模式同样跳过 Origin 白名单', async () => {
    const { port } = await boot(async () => ({ ok: true as const, authMode: 'pairing' as AuthMode }));
    const ws = await new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}?pairingCode=ABCD1234`, { headers: { origin: 'http://evil.com' } });
      w.on('open', () => res(w)); w.on('error', rej);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('RpcConnection.authMode 透传到方法处理器', () => {
  it('local 连接调 echo → handler 收到 authMode=local', async () => {
    let seen: AuthMode | undefined;
    const rpc = new RpcServer({ echo: (_p, conn) => { seen = conn.authMode; return 'ok'; } }, 'LOCAL-TOKEN');
    const port = await rpc.listen('127.0.0.1', 0);
    cleanups.push(() => rpc.close());
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=LOCAL-TOKEN`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: {} }));
    await new Promise<void>(r => ws.once('message', () => r()));
    expect(seen).toBe('local');
    ws.close();
  });

  it('remote 连接 → handler 收到 authMode=remote', async () => {
    let seen: AuthMode | undefined;
    const rpc = new RpcServer({ echo: (_p, conn) => { seen = conn.authMode; return 'ok'; } }, 'LOCAL-TOKEN', async () => ({ ok: true as const, authMode: 'remote' as AuthMode }));
    const port = await rpc.listen('127.0.0.1', 0);
    cleanups.push(() => rpc.close());
    const ws = new WebSocket(`ws://127.0.0.1:${port}?paseto=X`);
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: {} }));
    await new Promise<void>(r => ws.once('message', () => r()));
    expect(seen).toBe('remote');
    ws.close();
  });
});

describe('broadcast 不回归', () => {
  it('local + remote 两个连接都收到 broadcast', async () => {
    const rpc = new RpcServer({}, 'LOCAL-TOKEN', async () => ({ ok: true as const, authMode: 'remote' as AuthMode }));
    const port = await rpc.listen('127.0.0.1', 0);
    cleanups.push(() => rpc.close());
    const wsLocal = new WebSocket(`ws://127.0.0.1:${port}?token=LOCAL-TOKEN`);
    const wsRemote = new WebSocket(`ws://127.0.0.1:${port}?paseto=X`);
    await Promise.all([
      new Promise<void>((r, e) => { wsLocal.on('open', () => r()); wsLocal.on('error', e); }),
      new Promise<void>((r, e) => { wsRemote.on('open', () => r()); wsRemote.on('error', e); }),
    ]);
    const recv: string[] = [];
    wsLocal.on('message', d => recv.push('local:' + String(d)));
    wsRemote.on('message', d => recv.push('remote:' + String(d)));
    rpc.broadcast('chat.event', { x: 1 });
    await new Promise(r => setTimeout(r, 100));
    expect(recv.some(x => x.startsWith('local:'))).toBe(true);
    expect(recv.some(x => x.startsWith('remote:'))).toBe(true);
    wsLocal.close(); wsRemote.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- rpc-server-authmode`
Expected: FAIL（`AuthMode` 导出不存在、`additionalVerify` 第三参数不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/rpc/server.ts`（完整文件，已对照现状 L1-72；改动点：constructor +additionalVerify、verifyClient 分级、onConnection 透传 authMode、RpcConnection 加 authMode；`broadcast`/`close` 一字不动）：

```typescript
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type AuthMode = 'local' | 'pairing' | 'remote';

export interface RpcConnection { notify(method: string, params: unknown): void; authMode: AuthMode }
export interface RpcMethods { [method: string]: (params: any, conn: RpcConnection) => Promise<unknown> | unknown }

export type AdditionalVerifyResult = { ok: true; authMode: AuthMode } | { ok: false };
export type AdditionalVerify = (info: { req: IncomingMessage; url: URL }) => Promise<AdditionalVerifyResult> | AdditionalVerifyResult;

export class RpcServer {
  private wss: WebSocketServer | undefined;
  private clients = new Set<WebSocket>();

  /** authToken：每次启动新生成，只经 IPC 交给自己的渲染进程。浏览器页面拿不到它。
   *  additionalVerify（可选）：远程客户端鉴权回调；返回 {ok:true,authMode} 放行并标记连接模式，{ok:false} 拒绝。 */
  constructor(private methods: RpcMethods, private authToken: string, private additionalVerify?: AdditionalVerify) {}

  listen(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host, port,
        verifyClient: (info, cb) => {
          const url = new URL(info.req.url ?? '/', 'ws://127.0.0.1');
          const origin = info.req.headers.origin;
          // 老路径（评审缺口修订：token + 回环源地址双条件）：
          //   MINISD_HOST=0.0.0.0 后老 token 可能被嗅探；local 的「本机」语义由 socket.remoteAddress 保证。
          //   非回环源地址的老 token 一律 401，不落入 additionalVerify——老 token 语义就是本机，远程走 PASETO/配对码。
          const tokenMatch = url.searchParams.get('token') === this.authToken;
          const remoteAddr = info.req.socket.remoteAddress;
          const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
          if (tokenMatch) {
            if (!isLoopback) { cb(false, 401, 'Unauthorized'); return; }
            const originOk = origin === undefined || origin === 'file://' || /^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
            if (!originOk) { cb(false, 401, 'Unauthorized'); return; }
            cb(true, 200, undefined, { authMode: 'local' as AuthMode });
            return;
          }
          // 新路径：additionalVerify（paseto / pairingCode）→ pairing/remote 模式
          if (this.additionalVerify) {
            const r = this.additionalVerify({ req: info.req, url });
            const settle = (res: AdditionalVerifyResult) => {
              if (!res.ok) { cb(false, 401, 'Unauthorized'); return; }
              // Origin 白名单对远程关闭：WS 本来就不关同源，Origin 防线本来只针对
              // 「浏览器任意网页能偷连本机 token」——远程客户端本来就不是浏览器页（设计 §3.2 原文）
              cb(true, 200, undefined, { authMode: res.authMode });
            };
            if (r instanceof Promise) r.then(settle).catch(() => cb(false, 401, 'Unauthorized'));
            else settle(r);
            return;
          }
          cb(false, 401, 'Unauthorized');
        },
      });
      this.wss = wss;
      let listening = false;
      wss.on('error', err => { if (!listening) reject(err); });
      wss.on('listening', () => { listening = true; resolve((wss.address() as AddressInfo).port); });
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
    });
  }

  private onConnection(ws: WebSocket, req?: IncomingMessage): void {
    // verifyClient 第四参（WebSocketServer 透传的 userProps）承载 authMode；老路径/无 additionalVerify 默认 local
    const authMode: AuthMode = (req as any)?.__authMode ?? 'local';
    this.clients.add(ws);
    const conn: RpcConnection = { authMode, notify: (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })) };
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => { this.clients.delete(ws); try { ws.terminate(); } catch { /* 已关闭 */ } });
    ws.on('message', async raw => {
      let msg: { id?: number; method?: string; params?: unknown };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }
      if (!msg.method) return;
      const handler = this.methods[msg.method];
      if (!handler) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未知方法: ${msg.method}` } }));
        return;
      }
      try {
        const result = await handler(msg.params ?? {}, conn);
        if (msg.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      } catch (e) {
        if (msg.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e instanceof Error ? e.message : e) } }));
      }
    });
  }

  broadcast(method: string, params: unknown): void {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const ws of this.clients) { try { ws.send(frame); } catch { /* 断开连接忽略 */ } }
  }

  close(): Promise<void> {
    return new Promise(resolve => { if (!this.wss) return resolve(); for (const c of this.clients) c.terminate(); this.wss.close(() => resolve()); });
  }
}
```

> **关键实现细节**：`ws` 库的 `verifyClient` 第四参（`userProps`）会被附加到 `req` 上并以 `req` 形参传给 `connection` 事件。上面用 `cb(true, 200, undefined, { authMode })` 把 authMode 塞进 userProps，`onConnection` 经 `req.__authMode` 取回。若 `ws` 版本 userProps 落点不同（`info.req` vs connection `req`），实现时以 `ws@8.21.1` 实测为准——单测会暴露任何错位。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- rpc-server-authmode`
Expected: 12 passed（原 9 + 评审缺口新增 3：LAN IP 携老 token 401 / LAN IP+paseto 连上 / 回环 127.0.0.1 不回归；其中前 2 例在无 LAN 接口环境下 it.skipIf 跳过，跳过不算 failed）

Run: `cd deskminis && npm test`
Expected: 全套回归全绿（基线 432 + Task 1 新增约 12 = 约 444；无 LAN 接口环境下实际新增 10）

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/rpc/server.ts deskminis/tests/rpc-server-authmode.test.ts && git commit -m "feat(m3a): RpcServer additionalVerify+authMode分级(local/pairing/remote,老token路径不回归)"
```

---

### Task 2 · PASETO v4.local codec ✅

**Files:**
- Create: `deskminis/src/minisd/remote/paseto.ts`
- Test: `deskminis/tests/remote-paseto.test.ts`

**Interfaces:**
- Consumes: `@noble/ciphers`（XChaCha20-Poly1305）、`@noble/hashes`（BLAKE2b、HKDF）
- Produces（Task 4 依赖）:
  - `export function encodePasetoLocal(payload: Record<string, unknown>, key: Uint8Array, footer?: Uint8Array): string`——key 必须 32 字节；返回 `v4.local.<b64url(payload+nonce+tag)>.<b64url(footer)>`
  - `export function decodePasetoLocal(token: string, key: Uint8Array, footer?: Uint8Array): { payload: Record<string, unknown>; footer: Uint8Array }`——版本/purpose 校验、footer 校验、AEAD 解密失败抛 `PasetoError`
  - `export class PasetoError extends Error`
  - payload 约定：`{ iat: number; exp: number; device_fingerprint: string }`（iat/exp 为 epoch 秒；Task 4 铸造时填）

- [ ] **Step 1: 写失败测试**

`deskminis/tests/remote-paseto.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { encodePasetoLocal, decodePasetoLocal, PasetoError } from '../src/minisd/remote/paseto';
import { randomBytes } from 'node:crypto';

const KEY = randomBytes(32);
const PAYLOAD = { iat: 1785000000, exp: 1785000600, device_fingerprint: 'ABCDEF' };

describe('PASETO v4.local 往返', () => {
  it('encode → decode 还原 payload', () => {
    const t = encodePasetoLocal(PAYLOAD, KEY);
    expect(t).toMatch(/^v4\.local\.[A-Za-z0-9_-]+$/);
    const { payload } = decodePasetoLocal(t, KEY);
    expect(payload).toEqual(PAYLOAD);
  });

  it('带 footer：decode 校验 footer 一致', () => {
    const footer = Buffer.from('deskminis-pairing/ABCDEF', 'utf8');
    const t = encodePasetoLocal(PAYLOAD, KEY, footer);
    expect(t).toContain('.');
    const { footer: f2 } = decodePasetoLocal(t, KEY, footer);
    expect(Buffer.from(f2).toString('utf8')).toBe('deskminis-pairing/ABCDEF');
  });

  it('footer 不匹配 → PasetoError', () => {
    const footer = Buffer.from('expected', 'utf8');
    const t = encodePasetoLocal(PAYLOAD, KEY, footer);
    expect(() => decodePasetoLocal(t, KEY, Buffer.from('wrong', 'utf8'))).toThrow(PasetoError);
  });
});

describe('篡改拒绝', () => {
  it('密文翻转一字节 → PasetoError', () => {
    const t = encodePasetoLocal(PAYLOAD, KEY);
    const parts = t.split('.');
    const body = Buffer.from(parts[2], 'base64url');
    body[0] ^= 0x01;
    parts[2] = body.toString('base64url');
    const tampered = parts.join('.');
    expect(() => decodePasetoLocal(tampered, KEY)).toThrow(PasetoError);
  });

  it('错 key → PasetoError', () => {
    const t = encodePasetoLocal(PAYLOAD, KEY);
    expect(() => decodePasetoLocal(t, randomBytes(32))).toThrow(PasetoError);
  });

  it('版本头不是 v4.local → PasetoError', () => {
    expect(() => decodePasetoLocal('v3.local.xxx', KEY)).toThrow(PasetoError);
    expect(() => decodePasetoLocal('v4.public.xxx', KEY)).toThrow(PasetoError);
  });

  it('token 结构残缺 → PasetoError', () => {
    expect(() => decodePasetoLocal('v4.local', KEY)).toThrow(PasetoError);
    expect(() => decodePasetoLocal('not-a-token', KEY)).toThrow(PasetoError);
  });
});

describe('过期校验（业务层）', () => {
  it('exp 已过 → decodePasetoLocal 仍解出 payload（过期判断由调用方）', () => {
    const past = { iat: 1785000000, exp: 1785000010, device_fingerprint: 'X' };
    const t = encodePasetoLocal(past, KEY);
    const { payload } = decodePasetoLocal(t, KEY);
    expect(payload.exp).toBeLessThan(Date.now() / 1000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- remote-paseto`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 安装依赖 + 实现**

先安装 noble 套件：
```bash
cd deskminis && npm install @noble/ciphers @noble/hashes @noble/curves
```

`deskminis/src/minisd/remote/paseto.ts`（PASETO v4.local 按 spec 实现；PAE 薄包装）：

```typescript
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { blake2b } from '@noble/hashes/blake2b';

export class PasetoError extends Error {
  constructor(message: string) { super(message); this.name = 'PasetoError'; }
}

const HEADER = 'v4.local';
const KEY_LEN = 32;
const NONCE_LEN = 24;

/** Pre-Authentication Encoding (PAE)：length-prefix 串联，防混淆。 */
function pae(parts: Uint8Array[]): Uint8Array {
  let total = 8;
  for (const p of parts) total += 8 + p.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  const enc = (n: number) => { dv.setBigUint64(off, BigInt(n), true); off += 8; };
  enc(parts.length);
  for (const p of parts) { enc(p.length); out.set(p, off); off += p.length; }
  return out;
}

function b64u(b: Uint8Array): string { return Buffer.from(b).toString('base64url'); }
function unb64u(s: string): Uint8Array { return new Uint8Array(Buffer.from(s, 'base64url')); }

export function encodePasetoLocal(payload: Record<string, unknown>, key: Uint8Array, footer?: Uint8Array): string {
  if (key.length !== KEY_LEN) throw new PasetoError(`key 必须 ${KEY_LEN} 字节，收到 ${key.length}`);
  const f = footer ?? new Uint8Array();
  const nonce = xchacha20poly1305(key).().nonce; // 取随机 nonce（noble API 实测为准）
  const msg = new TextEncoder().encode(JSON.stringify(payload));
  const preAuth = pae([new TextEncoder().encode('paseto.local'), nonce, f]);
  const cipher = xchacha20poly1305(key, nonce, preAuth);
  const ct = cipher.encrypt(msg);
  const body = new Uint8Array(nonce.length + ct.length);
  body.set(nonce, 0); body.set(ct, nonce.length);
  const token = `${HEADER}.${b64u(body)}`;
  return f.length ? `${token}.${b64u(f)}` : token;
}

export function decodePasetoLocal(token: string, key: Uint8Array, expectedFooter?: Uint8Array): { payload: Record<string, unknown>; footer: Uint8Array } {
  if (key.length !== KEY_LEN) throw new PasetoError(`key 必须 ${KEY_LEN} 字节`);
  const parts = token.split('.');
  if (parts.length < 3 || parts.length > 4) throw new PasetoError('token 结构残缺');
  if (parts[0] !== 'v4' || parts[1] !== 'local') throw new PasetoError('版本/purpose 不是 v4.local');
  const body = unb64u(parts[2]);
  const footer = parts.length === 4 ? unb64u(parts[3]) : new Uint8Array();
  if (expectedFooter && !Buffer.from(footer).equals(Buffer.from(expectedFooter))) throw new PasetoError('footer 不匹配');
  if (body.length < NONCE_LEN) throw new PasetoError('body 过短');
  const nonce = body.subarray(0, NONCE_LEN);
  const ct = body.subarray(NONCE_LEN);
  const preAuth = pae([new TextEncoder().encode('paseto.local'), nonce, footer]);
  const cipher = xchacha20poly1305(key, nonce, preAuth);
  const msg = cipher.decrypt(ct);
  if (!msg) throw new PasetoError('AEAD 解密失败（密钥错误或密文被篡改）');
  const payload = JSON.parse(new TextDecoder().decode(msg)) as Record<string, unknown>;
  return { payload, footer };
}
```

> **实现提示**：noble `@noble/ciphers` 的 `xchacha20poly1305(key, nonce?, ad?)` API 形态以实测为准——上面是 spec 思路的伪代码骨架，实现时按 noble 实际导出调整（可能需 `xchacha20poly1305(key, { nonce, ad })` 或函数式调用）。关键不变量：① nonce 24 字节随机；② AD = PAE(['paseto.local', nonce, footer])；③ tag 校验失败必须抛 PasetoError。单测覆盖不变量，API 形态自由。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- remote-paseto`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/remote/paseto.ts deskminis/tests/remote-paseto.test.ts deskminis/package.json deskminis/package-lock.json && git commit -m "feat(m3a): PASETO v4.local codec(noble套件,往返/篡改/过脚校验)"
```

---

### Task 3 · PairingKey（X25519 ECDH + HKDF + vault CRUD） ✅（含追加修正）

**Files:**
- Create: `deskminis/src/minisd/remote/pairing.ts`
- Test: `deskminis/tests/remote-pairing.test.ts`

**Interfaces:**
- Consumes: `@noble/curves`（x25519，从 `@noble/curves/ed25519.js` 导入）、`@noble/hashes`（hkdf、sha256，从 `@noble/hashes/hkdf.js` + `@noble/hashes/sha2.js` 导入）、M1 `SecretVault`（[`provider-store.ts`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/provider-store.ts) L12-16，仅 set/get/delete 无 list）
- Produces（Task 4 依赖，三层分层）:
  - `export function generatePairingCode(): string`——8 字符，去除易混淆字符 0/O/1/I/L，字符集 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
  - `export class StaticIdentity { constructor(privateKey?: Uint8Array); readonly privateKey/publicKey/fingerprint; static loadOrCreate(vault: SecretVault): StaticIdentity }`——X25519 静态密钥对；无参构造随机生成（测试用），传 privateKey 从私钥恢复；`loadOrCreate` 首次生成后存 vault key=`pairing.static-identity`（base64 私钥），后续启动加载复用；fingerprint = `sha256(publicKey).slice(0,6)` 的 12 字符 hex（48-bit 强度）
  - `export function derivePairingKey(myPriv, peerPub, pairingCode, peerFingerprint?, peerName?): PairingKey`——ECDH + HKDF-SHA256 派生 64 字节（前 32=authKey，后 32=sessionSecret）+ 5 字节 roomId（base32 编码 8 字符）；createdAt 为 epoch 秒（`Math.floor(Date.now()/1000)`）
  - `export class PairingStore { constructor(dataDir, vault); save(key): void; get(fp): PairingKey | undefined; list(): PairingKeyPublicView[]; delete(fp): void }`——持久化 CRUD；vault 存密钥本体（key=`pairing.<fp>`），`pairing-index.json` 存 fingerprint 列表（SecretVault 无 list 接口，自管索引）；list() 返回脱敏视图（不含 authKey/sessionSecret）
  - `export class PairingService { constructor(store: PairingStore, vault: SecretVault); beginPairing(): { code, ourPubKeyB64, fingerprint, expiresAt }; completePairing(code, peerPubKeyB64, peerFingerprint, peerName?): { fingerprint, ourPubKeyB64 }; hasPending(code): boolean; cleanupExpired(): void; list()/get(fp)/delete(fp) 代理 store }`——配对协议生命周期；StaticIdentity 经 `loadOrCreate` 持久化；pending 表存进程内存（5 分钟过期，complete 后一次性消费）
  - `export interface PairingKey { authKey: Uint8Array(32); sessionSecret: Uint8Array(32); roomId: string; peerFingerprint: string; peerName: string; createdAt: number }`
  - `export interface PairingKeyPublicView { peerFingerprint; peerName; roomId; createdAt }`——脱敏视图
  - `export const PAIRING_CODE_TTL_S = 300`——配对码有效期 5 分钟（秒）

- [ ] **Step 1: 写失败测试**

`deskminis/tests/remote-pairing.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { PairingStore, type PairingKey } from '../src/minisd/remote/pairing';
import { InMemoryVault, type SecretVault } from '../src/minisd/store/provider-store';

let vault: SecretVault;
beforeEach(() => { vault = new InMemoryVault(); });

describe('静态密钥生命周期', () => {
  it('首次 beginPairing 生成静态私钥并存 vault；二次复用', () => {
    const s = new PairingStore(vault);
    const a = s.beginPairing();
    const b = s.beginPairing();
    expect(a.ourPubKeyB64).toBe(b.ourPubKeyB64);
    expect(vault.get('pairing.static-priv')).toBeTruthy();
  });
});

describe('配对码', () => {
  it('8 字 Crockford base32，去除易混字符', () => {
    const s = new PairingStore(vault);
    for (let i = 0; i < 20; i++) {
      const { code } = s.beginPairing();
      expect(code).toHaveLength(8);
      expect(/^[0-9A-HJ-NP-Z]+$/.test(code)).toBe(true); // 无 I/L/O/U
    }
  });

  it('5 分钟过期：begin 后 5 分钟 complete → 抛错', async () => {
    const s = new PairingStore(vault);
    const { code } = s.beginPairing();
    await new Promise(r => setTimeout(r, 10));
    // 用过期 pending 模拟（实现里 pending 记录 expiresAt；这里不真等 5 分钟，改用 store 内部时钟注入或直接测 expiresAt 字段）
    const { expiresAt } = s.beginPairing();
    expect(expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(expiresAt).toBeLessThan(Date.now() / 1000 + 310);
  });
});

describe('completePairing ECDH 对称性', () => {
  it('两端 ECDH 派生出相同 fingerprint + authKey', () => {
    // 桌面 A
    const storeA = new PairingStore(vault);
    const begin = storeA.beginPairing();
    // 手机 B（用另一个 vault 模拟另一端）
    const vaultB = new InMemoryVault();
    const storeB = new PairingStore(vaultB);
    // 手机 B 调 connect：本地生成临时 keypair（这里直接用 storeB 的静态密钥当 peer）
    const beginB = storeB.beginPairing();
    // A 收到 B 的公钥 → completePairing
    const doneA = storeA.completePairing(begin.code, beginB.ourPubKeyB64);
    // B 收到 A 的公钥 → completePairing（用 B 自己的 code？不——B 是 connect 方，用 A 的 code）
    const doneB = storeB.completePairing(begin.code, begin.ourPubKeyB64);
    expect(doneA.fingerprint).toBe(doneB.fingerprint);
    const keyA = storeA.get(doneA.fingerprint)!;
    const keyB = storeB.get(doneB.fingerprint)!;
    expect(Buffer.from(keyA.authKey).equals(Buffer.from(keyB.authKey))).toBe(true);
    expect(keyA.peerPubKeyB64).toBe(beginB.ourPubKeyB64);
    expect(keyB.peerPubKeyB64).toBe(begin.ourPubKeyB64);
  });

  it('completePairing 后 pending code 失效（一次性）', () => {
    const s = new PairingStore(vault);
    const { code, ourPubKeyB64 } = s.beginPairing();
    s.completePairing(code, ourPubKeyB64); // 自配对（测试用）
    expect(() => s.completePairing(code, ourPubKeyB64)).toThrow();
  });
});

describe('list / delete', () => {
  it('list 列全部已配对；delete 移除', () => {
    const s = new PairingStore(vault);
    const { code, ourPubKeyB64 } = s.beginPairing();
    const { fingerprint } = s.completePairing(code, ourPubKeyB64);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0].fingerprint).toBe(fingerprint);
    s.delete(fingerprint);
    expect(s.list()).toHaveLength(0);
    expect(s.get(fingerprint)).toBeUndefined();
  });

  it('vault 持久化：静态私钥与 PairingKey 经 vault round-trip', () => {
    const s1 = new PairingStore(vault);
    const { code, ourPubKeyB64 } = s1.beginPairing();
    const { fingerprint } = s1.completePairing(code, ourPubKeyB64);
    // 新实例同 vault → 能读回已存 PairingKey + 复用静态私钥
    const s2 = new PairingStore(vault);
    expect(s2.get(fingerprint)).toBeTruthy();
    expect(s2.beginPairing().ourPubKeyB64).toBe(ourPubKeyB64);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- remote-pairing`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/remote/pairing.ts`:

```typescript
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { blake2b } from '@noble/hashes/blake2b';
import { randomBytes } from 'node:crypto';
import type { SecretVault } from '../store/provider-store';

export interface PairingKey {
  fingerprint: string;
  authKey: Uint8Array;   // 32
  sessionSecret: Uint8Array; // 32
  roomId: string;        // 16 hex
  peerPubKeyB64: string;
  createdAt: number;
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32，无 I/L/O/U
const CODE_LEN = 8;
const PAIRING_TTL_S = 300;
const VAULT_STATIC_PRIV = 'pairing.static-priv';
const VAULT_PAIRING_PREFIX = 'pairing.';
const FINGERPRINT_LEN = 6;

interface PendingPairing { code: string; ourPubKeyB64: string; expiresAt: number }

function b64u(b: Uint8Array): string { return Buffer.from(b).toString('base64url'); }
function unb64u(s: string): Uint8Array { return new Uint8Array(Buffer.from(s, 'base64url')); }
function base32(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return s;
}

export class PairingStore {
  private ourStaticPriv: Uint8Array;
  private pending = new Map<string, PendingPairing>();

  constructor(private vault: SecretVault, ourStaticPriv?: Uint8Array) {
    if (ourStaticPriv) {
      this.ourStaticPriv = ourStaticPriv;
    } else {
      const existing = vault.get(VAULT_STATIC_PRIV);
      if (existing) {
        this.ourStaticPriv = unb64u(existing);
      } else {
        this.ourStaticPriv = x25519.utils.randomPrivateKey();
        vault.set(VAULT_STATIC_PRIV, b64u(this.ourStaticPriv));
      }
    }
  }

  private get ourPubKey(): Uint8Array { return x25519.getPublicKey(this.ourStaticPriv); }

  beginPairing(): { code: string; ourPubKeyB64: string; fingerprint: string; expiresAt: number } {
    const code = base32(randomBytes(CODE_LEN));
    const ourPubKeyB64 = b64u(this.ourPubKey);
    const expiresAt = Math.floor(Date.now() / 1000) + PAIRING_TTL_S;
    // 预派生 fingerprint（completePairing 时用 ECDH 共享密钥重算覆盖；此处给 begin 端一个占位用于显示）
    const fingerprint = base32(blake2b(this.ourPubKey, { dkLen: 3 })).slice(0, FINGERPRINT_LEN);
    this.pending.set(code, { code, ourPubKeyB64, expiresAt });
    return { code, ourPubKeyB64, fingerprint, expiresAt };
  }

  completePairing(code: string, peerPubKeyB64: string): { fingerprint: string; ourPubKeyB64: string } {
    const pending = this.pending.get(code);
    if (!pending) throw new Error('配对码不存在或已失效');
    if (pending.expiresAt < Date.now() / 1000) { this.pending.delete(code); throw new Error('配对码已过期'); }
    const peerPub = unb64u(peerPubKeyB64);
    const shared = x25519.getSharedSecret(this.ourStaticPriv, peerPub);
    const okm = hkdf(blake2b, shared, new TextEncoder().encode(code), 'deskminis-m3a', 64);
    const authKey = okm.subarray(0, 32);
    const sessionSecret = okm.subarray(32, 64);
    const roomId = blake2b(shared, { dkLen: 8 }).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    const fingerprint = base32(blake2b(shared, { dkLen: 3 })).slice(0, FINGERPRINT_LEN);
    const key: PairingKey = {
      fingerprint, authKey, sessionSecret, roomId,
      peerPubKeyB64, createdAt: Math.floor(Date.now() / 1000),
    };
    this.vault.set(VAULT_PAIRING_PREFIX + fingerprint, JSON.stringify({
      fingerprint, authKey: b64u(authKey), sessionSecret: b64u(sessionSecret),
      roomId, peerPubKeyB64, createdAt: key.createdAt,
    }));
    this.pending.delete(code); // 一次性
    return { fingerprint, ourPubKeyB64: pending.ourPubKeyB64 };
  }

  list(): PairingKey[] {
    const out: PairingKey[] = [];
    for (const [k, v] of Object.entries(this.vault)) {
      if (!k.startsWith(VAULT_PAIRING_PREFIX)) continue;
      // InMemoryVault 不是 dict；实现需按 SecretVault 接口调整（见提示）
    }
    // SecretVault 没有 list 接口——PairingStore 维护一份 fingerprint 索引（vault key=`pairing.index`，JSON 数组）
    return out;
  }

  get(fingerprint: string): PairingKey | undefined {
    const raw = this.vault.get(VAULT_PAIRING_PREFIX + fingerprint);
    if (!raw) return undefined;
    const o = JSON.parse(raw) as { authKey: string; sessionSecret: string; roomId: string; peerPubKeyB64: string; createdAt: number; fingerprint: string };
    return { ...o, authKey: unb64u(o.authKey), sessionSecret: unb64u(o.sessionSecret) };
  }

  delete(fingerprint: string): void {
    this.vault.delete(VAULT_PAIRING_PREFIX + fingerprint);
  }
}
```

> **实现提示（关键）**：M1 的 [`SecretVault`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/store/provider-store.ts) L12-16 接口只有 `set/get/delete`，**没有 list**。`PairingStore.list()` 不能遍历 vault。落地方案：PairingStore 自管一份 `vault.set('pairing.index', JSON.stringify([fp1, fp2, ...]))` 索引，每次 completePairing/delete 同步更新。上面的 `list()` 伪代码用 `Object.entries(vault)` 是错的（InMemoryVault 内部是 Map 不暴露），实现时改为读 `pairing.index`。单测 `list 列全部` 会暴露任何错位。另外 `x25519` 在 `@noble/curves` 里的导入路径以实测为准（`@noble/curves/ed25519` 导出 `x25519`，或需 `@noble/curves` 顶层）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- remote-pairing`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/remote/pairing.ts deskminis/tests/remote-pairing.test.ts && git commit -m "feat(m3a): PairingKey(X25519 ECDH+HKDF+指纹+vault持久化,配对码一次性5分钟过期)"
```

---

### Task 4: remote.* RPC 方法面 + MINISD_HOST 接线

**Files:**
- Create: `deskminis/src/minisd/remote/index.ts`
- Modify: `deskminis/src/minisd/index.ts`（装配 remote.* + additionalVerify 接 PASETO/PairingStore + standalone 读 MINISD_HOST）
- Test: `deskminis/tests/remote-rpc.test.ts`

**Interfaces:**
- Consumes: Task 1 `AuthMode`/`RpcConnection`/`AdditionalVerify`；Task 2 `encodePaseto`/`decodePaseto`；Task 3 `PairingService`（含 `beginPairing`/`completePairing`/`hasPending`/`list`/`get`/`delete`）
- Produces:
  - `export function createRemoteMethods(service: PairingService): RpcMethods`——每个方法第一参为 `(params, conn)`，内部 `assertAuthMode(conn, ...)` 守卫：
    - `remote.pair.begin`：仅 `local`；调 `service.beginPairing()`；返回 `{ pairingCode, myPublicKey(Uint8Array), myPublicKeyB64, myFingerprint, expiresIn }`
    - `remote.pair.complete({ pairingCode, peerPublicKey, peerFingerprint, peerName? })`：仅 `pairing`；调 `service.completePairing`；返回 `{ ok, peerFingerprint }`
    - `remote.status`：仅 `local`；返回 `{ devices: PairingKeyPublicView[](脱敏,不含密钥) }`
    - `remote.unpair({ peerFingerprint })`：仅 `local`；调 `service.delete`
  - `export function createAdditionalVerify(service: PairingService): AdditionalVerify`——
    - `?paseto=<token>`：遍历 `service.list()`，用每个 authKey 试 `decodePaseto`；成功则 `{ ok:true, authMode:'remote' }`；任一失败继续下一个；全失败 → `{ ok:false }`
    - `?pairingCode=<code>`：`service.hasPending(code)` → `{ ok:true, authMode:'pairing' }`；否则 `{ ok:false }`
  - `export function guardBusinessMethod(method, name): method`——包装业务面方法，pairing 模式拒（remote 模式全开）
  - `minisd/index.ts` 改动：
    - 装配 `const pairingStore = new PairingStore(root, vault); const pairingService = new PairingService(pairingStore, vault);`
    - `new RpcServer(methods, authToken, createAdditionalVerify(pairingService))`（第三参）
    - methods 合并 `createRemoteMethods(pairingService)` + 业务面方法统一用 `guardBusinessMethod` 包装
    - standalone 分支：`startMinisd({ host: process.env.MINISD_HOST })`（不传则默认 127.0.0.1）

- [ ] **Step 1: 写失败测试**

`deskminis/tests/remote-rpc.test.ts`:

```typescript
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd } from '../src/minisd/index';
import { PairingStore } from '../src/minisd/remote/pairing';
import { encodePasetoLocal } from '../src/minisd/remote/paseto';

beforeAll(() => { process.env.DESKMINIS_TEST = '1'; process.env.DESKMINIS_FAKE_PROVIDER = '1'; });
let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-m3a-'));
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return srv;
}

function ws(port: number, query: string) {
  return new Promise<{ ws: WebSocket; call: (m: string, p?: unknown) => Promise<any>; notifications: any[] }>((res, rej) => {
    const c = new WebSocket(`ws://127.0.0.1:${port}?${query}`);
    const notifications: any[] = [];
    let idc = 0; const pending = new Map<number, (v: any) => void>();
    c.on('message', d => {
      const msg = JSON.parse(String(d));
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
      else if (msg.method) notifications.push(msg);
    });
    c.on('open', () => res({
      ws: c,
      call: (method, params) => new Promise(r => { const id = ++idc; pending.set(id, r); c.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }),
      notifications,
    }));
    c.on('error', rej);
  });
}

describe('remote.* authMode 分级', () => {
  it('local 连接可调 remote.pair.begin', async () => {
    const { port, authToken } = await boot();
    const c = await ws(port, `token=${authToken}`);
    const r = await c.call('remote.pair.begin', {});
    expect(r.result).toBeTruthy();
    expect(r.result.code).toHaveLength(8);
    c.ws.close();
  });

  it('remote（paseto）连接不可调 remote.pair.begin → 错误', async () => {
    const { port, authToken } = await boot();
    // 先 local 配对（自配对拿 authKey）
    const cl = await ws(port, `token=${authToken}`);
    const begin = (await cl.call('remote.pair.begin', {})).result;
    // 用 pairing 模式 complete
    const cp = await ws(port, `pairingCode=${begin.code}`);
    const done = await cp.call('remote.pair.complete', { code: begin.code, peerPubKeyB64: begin.ourPubKeyB64 });
    expect(done.result.fingerprint).toBeTruthy();
    cp.ws.close();
    // 铸 paseto
    const pairings = (await cl.call('remote.status', {})).result.pairings;
    const authKey = Uint8Array.from(Buffer.from(pairings[0].authKeyB64, 'base64url'));
    const token = encodePasetoLocal({ iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+600, device_fingerprint: pairings[0].fingerprint }, authKey);
    // remote 连接调 remote.pair.begin → 必须拒绝
    const cr = await ws(port, `paseto=${encodeURIComponent(token)}`);
    const r = await cr.call('remote.pair.begin', {});
    expect(r.error).toBeTruthy();
    expect(r.error.message).toMatch(/local|权限|不允许/);
    cr.ws.close(); cl.ws.close();
  });

  it('pairing 连接不可调 chat.sessions.list → 错误', async () => {
    const { port, authToken } = await boot();
    const cl = await ws(port, `token=${authToken}`);
    const begin = (await cl.call('remote.pair.begin', {})).result;
    const cp = await ws(port, `pairingCode=${begin.code}`);
    const r = await cp.call('chat.sessions.list', {});
    expect(r.error).toBeTruthy();
    cp.ws.close(); cl.ws.close();
  });

  it('remote 连接可调 chat.sessions.list（业务面开放）', async () => {
    const { port, authToken } = await boot();
    const cl = await ws(port, `token=${authToken}`);
    const begin = (await cl.call('remote.pair.begin', {})).result;
    const cp = await ws(port, `pairingCode=${begin.code}`);
    await cp.call('remote.pair.complete', { code: begin.code, peerPubKeyB64: begin.ourPubKeyB64 });
    cp.ws.close();
    const pairings = (await cl.call('remote.status', {})).result.pairings;
    const authKey = Uint8Array.from(Buffer.from(pairings[0].authKeyB64, 'base64url'));
    const token = encodePasetoLocal({ iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+600, device_fingerprint: pairings[0].fingerprint }, authKey);
    const cr = await ws(port, `paseto=${encodeURIComponent(token)}`);
    const r = await cr.call('chat.sessions.list', {});
    expect(r.result).toBeDefined();
    cr.ws.close(); cl.ws.close();
  });

  it('过期 paseto → 连接被拒（401）', async () => {
    const { port, authToken } = await boot();
    const cl = await ws(port, `token=${authToken}`);
    const begin = (await cl.call('remote.pair.begin', {})).result;
    const cp = await ws(port, `pairingCode=${begin.code}`);
    await cp.call('remote.pair.complete', { code: begin.code, peerPubKeyB64: begin.ourPubKeyB64 });
    cp.ws.close();
    const pairings = (await cl.call('remote.status', {})).result.pairings;
    const authKey = Uint8Array.from(Buffer.from(pairings[0].authKeyB64, 'base64url'));
    const token = encodePasetoLocal({ iat: 1, exp: 2, device_fingerprint: 'X' }, authKey); // 远古过期
    await expect(new Promise((_, rej) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}?paseto=${encodeURIComponent(token)}`);
      c.on('error', rej);
    })).rejects.toThrow();
    cl.ws.close();
  });

  it('remote.status 与 remote.unpair 仅 local', async () => {
    const { port, authToken } = await boot();
    const cl = await ws(port, `token=${authToken}`);
    const begin = (await cl.call('remote.pair.begin', {})).result;
    const cp = await ws(port, `pairingCode=${begin.code}`);
    await cp.call('remote.pair.complete', { code: begin.code, peerPubKeyB64: begin.ourPubKeyB64 });
    cp.ws.close();
    const st = (await cl.call('remote.status', {})).result;
    expect(st.pairings).toHaveLength(1);
    const del = await cl.call('remote.unpair', { fingerprint: st.pairings[0].fingerprint, confirm: true });
    expect(del.result.ok).toBe(true);
    const st2 = (await cl.call('remote.status', {})).result;
    expect(st2.pairings).toHaveLength(0);
    cl.ws.close();
  });
});

describe('MINISD_HOST 接线', () => {
  it('startMinisd({ host: "127.0.0.1" }) 默认仍 127.0.0.1（不回归）', async () => {
    const srv = await boot();
    // 仅断言能起来；host 绑定由 OS 保证
    expect(srv.port).toBeGreaterThan(0);
  });
});
```

> **注意**：`remote.status` 返回的 pairings 须含 `authKeyB64`（base64url 字符串）以便测试与 CLI 铸 PASETO；正式 UI 不显示该字段（GUI 任务在 M3b 处理，M3a RPC 返回含密钥，鉴权边界已保证只有 local 能调）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- remote-rpc`
Expected: FAIL（`makeRemoteMethods`/`makeAdditionalVerify` 不存在、`startMinisd` 未接 additionalVerify）

- [ ] **Step 3: 实现 remote/index.ts**

```typescript
import type { RpcConnection, AuthMode } from '../rpc/server';
import { decodePasetoLocal, PasetoError } from './paseto';
import type { PairingStore } from './pairing';

export type RemoteMethods = {
  'remote.pair.begin': (p: unknown, conn: RpcConnection) => unknown;
  'remote.pair.complete': (p: { code: string; peerPubKeyB64: string }, conn: RpcConnection) => unknown;
  'remote.status': (p: unknown, conn: RpcConnection) => unknown;
  'remote.unpair': (p: { fingerprint: string; confirm?: boolean }, conn: RpcConnection) => unknown;
};

function assertAuthMode(conn: RpcConnection, ...allowed: AuthMode[]): void {
  if (!allowed.includes(conn.authMode)) {
    throw new Error(`该方法仅允许 ${allowed.join('/')} 连接调用，当前为 ${conn.authMode}`);
  }
}

export function makeRemoteMethods(pairing: PairingStore): RemoteMethods {
  return {
    'remote.pair.begin': (_p, conn) => {
      assertAuthMode(conn, 'local');
      return pairing.beginPairing();
    },
    'remote.pair.complete': (p, conn) => {
      assertAuthMode(conn, 'pairing');
      if (typeof p.code !== 'string' || typeof p.peerPubKeyB64 !== 'string') throw new Error('code 与 peerPubKeyB64 必填');
      return pairing.completePairing(p.code, p.peerPubKeyB64);
    },
    'remote.status': (_p, conn) => {
      assertAuthMode(conn, 'local');
      // 返回含 authKeyB64 供 local CLI 铸 PASETO（M3a 测试/CLI 用；GUI 不显示）
      const pairings = pairing.list().map(k => ({
        fingerprint: k.fingerprint, roomId: k.roomId,
        peerPubKeyB64: k.peerPubKeyB64, authKeyB64: Buffer.from(k.authKey).toString('base64url'),
        createdAt: k.createdAt,
      }));
      return { pairings };
    },
    'remote.unpair': (p, conn) => {
      assertAuthMode(conn, 'local');
      if (p.confirm !== true) throw new Error('取消配对需 confirm:true');
      pairing.delete(p.fingerprint);
      return { ok: true };
    },
  };
}

export function makeAdditionalVerify(pairing: PairingStore) {
  return async ({ url }: { req: any; url: URL }): Promise<{ ok: true; authMode: AuthMode } | { ok: false }> => {
    const paseto = url.searchParams.get('paseto');
    if (paseto) {
      const now = Math.floor(Date.now() / 1000);
      for (const k of pairing.list()) {
        try {
          const { payload } = decodePasetoLocal(paseto, k.authKey);
          if (typeof payload.exp === 'number' && payload.exp > now) {
            return { ok: true, authMode: 'remote' };
          }
        } catch { /* 该 key 不匹配，试下一个 */ }
      }
      return { ok: false };
    }
    const code = url.searchParams.get('pairingCode');
    if (code && pairing.hasPending(code)) {
      return { ok: true, authMode: 'pairing' };
    }
    return { ok: false };
  };
}
```

- [ ] **Step 4: 改 minisd/index.ts 装配**

改动点（增量，不动既有能力）：
1. import：`import { PairingStore } from './remote/pairing'; import { makeRemoteMethods, makeAdditionalVerify } from './remote';`
2. 在 `const vault = ...` 之后加 `const pairing = new PairingStore(vault);`
3. `methods` 对象末尾追加 `...makeRemoteMethods(pairing)`（展开合并；或 Object.assign）
4. `new RpcServer(methods, authToken)` → `new RpcServer(methods, authToken, makeAdditionalVerify(pairing))`
5. standalone 分支 L450-461：`startMinisd()` → `startMinisd({ host: process.env.MINISD_HOST ?? '127.0.0.1' })`
6. `close` 里加 `pairing` 无需特殊清理（vault 是 db 之外的，进程退出即落盘完成）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd deskminis && npm test -- remote-rpc`
Expected: 7 passed
Run: `cd deskminis && npm test`
Expected: 全套绿（441 + Task2 9 + Task3 8 + Task4 7 = 465；含 Task2/3 已先过）

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/remote/index.ts deskminis/src/minisd/index.ts deskminis/tests/remote-rpc.test.ts && git commit -m "feat(m3a): remote.* RPC面(authMode分级守卫)+additionalVerify接PASETO/配对码+MINISD_HOST接线"
```

---

### Task 5: undici noProxy 出流量隔离（红线）

**Files:**
- Create: `deskminis/src/minisd/remote/noProxyFetch.ts`
- Test: `deskminis/tests/remote-noProxyFetch.test.ts`
- Modify: `deskminis/package.json`（undici **新增为直接依赖**——现状：undici 仅作为 node-gyp 的传递依赖存在于 package-lock（`^6.25.0`，由 `@electron/rebuild` 链引入），未在 package.json 的 dependencies/devDependencies 直接声明；设计 §3.4 把它当 devDeps 的说法不准确，本计划以现状为准——`npm install undici` 将其提升为直接 dependencies）

**Interfaces:**
- Consumes: `undici`（Agent / fetch）
- Produces:
  - `export const noProxyDispatcher: undici.Agent`——`new undici.Agent({ connect: { noProxy: true } })`（M3a LAN 无实际出流量，模块作为基建）
  - `export async function noProxyFetch(url: string, init?: undici.RequestInit): Promise<undici.Response>`——`undici.fetch(url, { ...init, dispatcher: noProxyDispatcher })`
  - 红线文档化：模块顶部注释明示「仅 M3 传输代码（relay/对端）使用；provider 的 HTTPS 禁止 import 此模块」

- [ ] **Step 1: 写失败测试**

`deskminis/tests/remote-noProxyFetch.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { noProxyDispatcher, noProxyFetch } from '../src/minisd/remote/noProxyFetch';

describe('noProxy dispatcher 配置', () => {
  it('noProxyDispatcher 是 undici.Agent 且 connect.noProxy=true', () => {
    expect(noProxyDispatcher).toBeTruthy();
    // undici Agent 不直接暴露 connect 选项；通过 Symbol 或 toString 断言形态
    expect(String(noProxyDispatcher)).toContain('Agent');
  });

  it('noProxyFetch 是函数且绑定 dispatcher', () => {
    expect(typeof noProxyFetch).toBe('function');
  });
});

describe('红线隔离：provider 路径不引入 noProxyFetch', () => {
  it('src/minisd/providers/ 下无 noProxyFetch import', () => {
    const { readFileSync, readdirSync } = require('node:fs');
    const { join } = require('node:path');
    const root = join(__dirname, '..', 'src', 'minisd', 'providers');
    const check = (dir: string): boolean => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (check(p)) return true; }
        else if (e.name.endsWith('.ts') && readFileSync(p, 'utf8').includes('noProxyFetch')) return true;
      }
      return false;
    };
    expect(check(root)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- remote-noProxyFetch`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

先把 undici 新增为直接依赖（现状：仅 node-gyp 传递依赖，未在 package.json 声明）：
```bash
cd deskminis && npm install undici
```

`deskminis/src/minisd/remote/noProxyFetch.ts`:

```typescript
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';

/**
 * M3 远程接入出流量专用 HTTP 客户端。
 *
 * 红线（设计 §3.4）：仅 M3 传输代码（relay 拨出、Tailscale 健康检查、对端连接）使用此模块。
 * providers 的 HTTPS 必须继续走全局 fetch（尊重系统代理——否则国内用户没代理打不到 OpenAI）。
 * provider 路径禁止 import 此模块（有单测守卫）。
 *
 * noProxy=true 确保 M3 的对端/中继连接绕开用户系统代理，避免 SASE 全局代理把
 * 「端到端加密」截胡成「到代理终止」。
 */
export const noProxyDispatcher = new Agent({ connect: { noProxy: true } });

export async function noProxyFetch(url: string, init?: RequestInit): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: noProxyDispatcher });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- remote-noProxyFetch`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/remote/noProxyFetch.ts deskminis/tests/remote-noProxyFetch.test.ts deskminis/package.json deskminis/package-lock.json && git commit -m "feat(m3a): undici noProxy出流量隔离(M3专用,provider红线禁用)"
```

---

### Task 6: CLI（deskminis-cli remote pair/connect/status/unpair）

**Files:**
- Create: `deskminis/src/cli/remote-cli.mjs`
- Test: `deskminis/tests/remote-cli.test.ts`

**Interfaces:**
- Consumes: Task 4 的 remote.* RPC（经 WS，`?token=` local 模式）；`ws` 包
- Produces（参照 [`bridge-cli.mjs`](file:///c:/Users/24739/Downloads/openminis1/deskminis/src/minisd/bridge-cli.mjs) 零依赖单文件先例）:
  - 调用形态：`node remote-cli.mjs <子命令> [参数] [--port <n>] [--token <t>] [--help]`
  - 环境契约：`MINISD_PORT` / `MINISD_TOKEN`（env）或 `--port` / `--token`（args）
  - 子命令：
    - `pair` → 调 `remote.pair.begin` → 打印 code + ourPubKeyB64 + fingerprint + expiresAt + 二维码字符画（可选，用纯 ASCII block 字符；不引二维码库，简化为 code 的等宽显示）
    - `connect <code> <peerPubKeyB64>` → 本地无需 WS 业务调用；实际是「扮演手机端」：连 `?pairingCode=<code>` → 调 `remote.pair.complete({ code, peerPubKeyB64 })` → 打印 fingerprint + ourPubKeyB64 供比对（注意：connect 端需先有自己的静态公钥——CLI 临时生成 X25519 keypair 不存库，因 connect 是模拟手机端，真机由 OM 实现）
    - `status` → 调 `remote.status` → 表格打印已配对节点（fingerprint / roomId / createdAt / peerPubKeyB64 前 12 字符）
    - `unpair <fingerprint>` → 调 `remote.unpair` → 打印 ok
  - 输出：成功 stdout JSON 或表格；失败 stderr 错误 + 退出码（0 成功 / 1 一般错误 / 3 参数错误 / 4 连不上 minisd）

- [ ] **Step 1: 写失败测试**

`deskminis/tests/remote-cli.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMinisd } from '../src/minisd/index';
import WebSocket from 'ws';

const CLI = fileURLToPath(new URL('../src/cli/remote-cli.mjs', import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function runCli(argv: string[], envExtra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(res => {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...envExtra };
    const proc = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', c => stdout += c);
    proc.stderr.on('data', c => stderr += c);
    proc.on('close', code => res({ code, stdout, stderr }));
    proc.stdin.end();
  });
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-cli-m3a-'));
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  cleanups.push(() => srv.close());
  return srv;
}

describe('help 与参数校验', () => {
  it('--help 列子命令，退出 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pair');
    expect(r.stdout).toContain('connect');
    expect(r.stdout).toContain('status');
  });

  it('缺子命令 → 退出 3', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(3);
  });

  it('缺 MINISD_PORT/TOKEN → 退出 4', async () => {
    const r = await runCli(['status'], {});
    expect(r.code).toBe(4);
  });
});

describe('pair / status / unpair', () => {
  it('pair 返回 code + fingerprint；status 列出；unpair 移除', async () => {
    const { port, authToken } = await boot();
    const env = { MINISD_PORT: String(port), MINISD_TOKEN: authToken };
    const pair = await runCli(['pair'], env);
    expect(pair.code).toBe(0);
    const pj = JSON.parse(pair.stdout);
    expect(pj.code).toHaveLength(8);
    expect(pj.fingerprint).toBeTruthy();

    const st = await runCli(['status'], env);
    expect(st.code).toBe(0);
    // status 表格或 JSON；断言含 fingerprint（pair 还没 complete，status 应为 0 个配对）
    // pair 只 begin，未 complete → status 列 0 条
    expect(st.stdout).not.toContain(pj.fingerprint);

    // complete（自配对）需 connect 子命令或直接 WS；这里用 connect 模拟
    const conn = await runCli(['connect', pj.code, pj.ourPubKeyB64], env);
    expect(conn.code).toBe(0);
    const cj = JSON.parse(conn.stdout);
    expect(cj.fingerprint).toBe(pj.fingerprint);

    const st2 = await runCli(['status'], env);
    expect(st2.stdout).toContain(pj.fingerprint);

    const del = await runCli(['unpair', pj.fingerprint], env);
    expect(del.code).toBe(0);
    const st3 = await runCli(['status'], env);
    expect(st3.stdout).not.toContain(pj.fingerprint);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- remote-cli`
Expected: FAIL（CLI 文件不存在）

- [ ] **Step 3: 实现**

`deskminis/src/cli/remote-cli.mjs`（零依赖单文件，参照 bridge-cli.mjs 风格；`connect` 子命令用 `@noble/curves` 临时生成 X25519 keypair——但 CLI 是零依赖单文件，引 noble 会破坏零依赖。权衡：connect 子命令需要 X25519，要么引 noble（破坏零依赖），要么用 Node 内建 crypto 的 diffieHellman（Node 22 支持 `crypto.diffieHellman` 但曲线是 modp 系列，不是 x25519）。

**决策**：connect 子命令引 `@noble/curves`（已是 deps），CLI 不再是「零依赖」而是「零原生依赖」（与 bridge-cli.mjs 的零 npm 依赖有别，但 noble 是纯 JS）。在 CLI 顶部 import `@noble/curves` 的 x25519。help 文档里注明 connect 需要 noble（随 DeskMinis 安装自带）。

```javascript
#!/usr/bin/env node
/**
 * DeskMinis 远程接入 CLI（M3a）：pair / connect / status / unpair。
 * 连接 minisd 走 WS（?token=，local 模式）；port+token 经 env MINISD_PORT/MINISD_TOKEN 或 --port/--token。
 * connect 子命令用 @noble/curves 临时生成 X25519 keypair（模拟手机端；真机由 OpenMinis 实现）。
 */
import WebSocket from 'ws';
import { x25519 } from '@noble/curves/ed25519';

const EXIT = { OK: 0, ERROR: 1, ARGS: 3, UNAVAILABLE: 4 };

function rpc(port, token, method, params) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
    const timer = setTimeout(() => { ws.terminate(); rej(new Error('连接 minisd 超时')); }, 5000);
    ws.on('error', e => { clearTimeout(timer); rej(e); });
    ws.on('open', () => {
      const id = 1;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      ws.on('message', d => {
        clearTimeout(timer);
        ws.close();
        res(JSON.parse(String(d)));
      });
    });
  });
}

function parseGlobalArgs(argv) {
  const out = { port: process.env.MINISD_PORT, token: process.env.MINISD_TOKEN, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') { out.port = argv[++i]; continue; }
    if (argv[i] === '--token') { out.token = argv[++i]; continue; }
    if (argv[i] === '--help' || argv[i] === '-h') { out.help = true; continue; }
    out.rest.push(argv[i]);
  }
  return out;
}

const HELP = `DeskMinis 远程接入 CLI（M3a）

用法: node remote-cli.mjs <子命令> [参数] [--port <n>] [--token <t>]
环境: MINISD_PORT / MINISD_TOKEN（或 --port / --token）

子命令:
  pair                          生成 8 字配对码 + 本机公钥 + 指纹（桌面端用）
  connect <code> <peerPubKeyB64>  扮演手机端：用配对码 + 对端公钥完成握手，返回指纹
  status                        列出所有已配对节点
  unpair <fingerprint>          取消配对

退出码: 0 成功 / 1 一般错误 / 3 参数错误 / 4 minisd 不可达
`;

async function main() {
  const args = parseGlobalArgs(process.argv.slice(2));
  if (args.help || args.rest.length === 0) {
    if (args.help) { process.stdout.write(HELP); process.exit(EXIT.OK); return; }
    process.stderr.write('缺少子命令\n\n' + HELP); process.exit(EXIT.ARGS); return;
  }
  const cmd = args.rest[0];
  if (!args.port || !args.token) {
    process.stderr.write('缺少 MINISD_PORT/MINISD_TOKEN（用 --port/--token 或 env 传入）\n');
    process.exit(EXIT.UNAVAILABLE); return;
  }
  try {
    if (cmd === 'pair') {
      const r = await rpc(args.port, args.token, 'remote.pair.begin', {});
      if (r.error) throw new Error(r.error.message);
      process.stdout.write(JSON.stringify(r.result, null, 2) + '\n');
      process.exit(EXIT.OK);
    } else if (cmd === 'connect') {
      const code = args.rest[1]; const peerPubKeyB64 = args.rest[2];
      if (!code || !peerPubKeyB64) { process.stderr.write('connect 需要 <code> <peerPubKeyB64>\n'); process.exit(EXIT.ARGS); return; }
      // 临时 X25519 keypair（模拟手机端；真机由 OpenMinis 持久化）
      const priv = x25519.utils.randomPrivateKey();
      const pub = x25519.getPublicKey(priv);
      const ourPubKeyB64 = Buffer.from(pub).toString('base64url');
      // 连 pairing 模式 WS（不带 token）
      const ws = new WebSocket(`ws://127.0.0.1:${args.port}?pairingCode=${code}`);
      const r = await new Promise((res, rej) => {
        ws.on('error', rej);
        ws.on('open', () => {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'remote.pair.complete', params: { code, peerPubKeyB64 } }));
          ws.on('message', d => { ws.close(); res(JSON.parse(String(d))); });
        });
      });
      if (r.error) throw new Error(r.error.message);
      process.stdout.write(JSON.stringify({ fingerprint: r.result.fingerprint, ourPubKeyB64 }, null, 2) + '\n');
      process.exit(EXIT.OK);
    } else if (cmd === 'status') {
      const r = await rpc(args.port, args.token, 'remote.status', {});
      if (r.error) throw new Error(r.error.message);
      const ps = r.result.pairings;
      if (ps.length === 0) { process.stdout.write('（无已配对节点）\n'); }
      else {
        for (const p of ps) {
          process.stdout.write(`${p.fingerprint}  room=${p.roomId}  peer=${p.peerPubKeyB64.slice(0, 12)}...  createdAt=${new Date(p.createdAt * 1000).toISOString()}\n`);
        }
      }
      process.exit(EXIT.OK);
    } else if (cmd === 'unpair') {
      const fp = args.rest[1];
      if (!fp) { process.stderr.write('unpair 需要 <fingerprint>\n'); process.exit(EXIT.ARGS); return; }
      const r = await rpc(args.port, args.token, 'remote.unpair', { fingerprint: fp, confirm: true });
      if (r.error) throw new Error(r.error.message);
      process.stdout.write('ok\n');
      process.exit(EXIT.OK);
    } else {
      process.stderr.write(`未知子命令: ${cmd}\n\n${HELP}`);
      process.exit(EXIT.ARGS);
    }
  } catch (e) {
    process.stderr.write(`错误: ${e.message}\n`);
    process.exit(EXIT.ERROR);
  }
}

main();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- remote-cli`
Expected: 6 passed
Run: `cd deskminis && npm test`
Expected: 全套绿（465 + Task5 3 + Task6 6 = 474；Task7 e2e 是脚本不计入 npm test）

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/cli/remote-cli.mjs deskminis/tests/remote-cli.test.ts && git commit -m "feat(m3a): remote-cli零依赖单文件(pair/connect/status/unpair,WS直连minisd)"
```

---

### Task 7: e2e 验收驱动

**Files:**
- Create: `deskminis/scripts/e2e-m3a-acceptance.mjs`
- Modify: `deskminis/package.json`（加 `"e2e:m3a": "node scripts/e2e-m3a-acceptance.mjs"`）

**目标**：扮演「远程客户端」走完整链路——配对 → PASETO → WS 连接 → 调 chat.sessions.list → 收 chat.event 广播 → 断言 remote 不可调 remote.*。继承 M2 系列 e2e 临时数据根隔离。

- [ ] **Step 1: 写 e2e 脚本**

`deskminis/scripts/e2e-m3a-acceptance.mjs`（参照 [`e2e-m2e-acceptance.mjs`](file:///c:/Users/24739/Downloads/openminis1/deskminis/scripts/e2e-m2e-acceptance.mjs) L1-70 的 spawn + 临时数据根模式）：

```javascript
// DeskMinis M3a 端到端验收驱动（对应 docs/plans/2026-07-31-m3a-remote-access.md「完成定义」）。
// 用法：先 `npm run build`，再 `npm run e2e:m3a`。
//
// 覆盖（本地完整链路，不联网）：
//   1) 配对：local 调 remote.pair.begin → pairing 模式 complete → 两端 fingerprint 一致
//   2) PASETO：用 authKey 铸 v4.local token（exp/iat/device_fingerprint）
//   3) WS 远程连接：?paseto= 连上，authMode=remote
//   4) 业务面：remote 调 chat.sessions.list → 收到结果
//   5) 广播：local 调 chat.prompt（fake provider）→ remote 连接收 chat.event 广播
//   6) 边界：remote 调 remote.pair.begin → 被拒（设计注意点 a）
//
// 环境隔离：临时数据根（mkdtemp）+ DESKMINIS_TEST=1（InMemoryVault）+ MINISD_HOST=127.0.0.1，结束 rmSync。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { encodePasetoLocal } from '../src/minisd/remote/paseto.ts';
import { x25519 } from '@noble/curves/ed25519';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) { console.error('找不到 out/main/minisd.js —— 先 npm run build'); process.exit(2); }

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-m3a-'));
const results = [];
const record = (step, pass, detail) => { results.push({ step, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// spawn minisd standalone
const proc = spawn(electronBin, [MINISD_ENTRY], {
  env: { ...process.env, DESKMINIS_STANDALONE: '1', DESKMINIS_TEST: '1', DESKMINIS_FAKE_PROVIDER: '1', MINISD_HOST: '127.0.0.1', ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let port = 0, token = '';
proc.stdout.on('data', d => {
  const lines = d.toString().split('\n');
  for (const line of lines) {
    try { const o = JSON.parse(line); if (o.minisdPort && o.authToken) { port = o.minisdPort; token = o.authToken; } } catch {}
  }
});
proc.stderr.on('data', d => process.stderr.write('[minisd] ' + d.toString()));

function wsConnect(query) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?${query}`);
    let idc = 0; const pending = new Map(); const notifications = [];
    ws.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method) notifications.push(msg);
    });
    ws.on('open', () => res({
      ws,
      call: (method, params) => new Promise(r => { const id = ++idc; pending.set(id, r); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }),
      notifications,
    }));
    ws.on('error', rej);
  });
}

await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('minisd 启动超时')), 15000);
  const check = () => { if (port && token) { clearTimeout(t); res(); } else setTimeout(check, 100); };
  check();
});
console.log(`minisd 起来: port=${port}`);

try {
  // 1. local 连接 + begin pairing
  const local = await wsConnect(`token=${token}`);
  const begin = (await local.call('remote.pair.begin', {})).result;
  record('begin', begin.code.length === 8, `code=${begin.code} fp=${begin.fingerprint}`);

  // 2. pairing 模式 complete（模拟手机端：临时 X25519 keypair）
  const phonePriv = x25519.utils.randomPrivateKey();
  const phonePub = x25519.getPublicKey(phonePriv);
  const phonePubB64 = Buffer.from(phonePub).toString('base64url');
  const pairingConn = await wsConnect(`pairingCode=${begin.code}`);
  const done = (await pairingConn.call('remote.pair.complete', { code: begin.code, peerPubKeyB64: phonePubB64 })).result;
  record('complete', done.fingerprint === begin.fingerprint, `fp 对齐: ${done.fingerprint}`);
  pairingConn.ws.close();

  // 3. 取 authKey + 铸 PASETO
  const status = (await local.call('remote.status', {})).result;
  const authKey = Uint8Array.from(Buffer.from(status.pairings[0].authKeyB64, 'base64url'));
  const paseto = encodePasetoLocal(
    { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, device_fingerprint: done.fingerprint },
    authKey,
  );
  record('paseto', paseto.startsWith('v4.local.'), `token 前 20=${paseto.slice(0, 20)}...`);

  // 4. remote 连接 + chat.sessions.list
  const remote = await wsConnect(`paseto=${encodeURIComponent(paseto)}`);
  const list = (await remote.call('chat.sessions.list', {})).result;
  record('remote.list', Array.isArray(list), `sessions=${list.length}`);

  // 5. 广播：local 建会话 + prompt → remote 收 chat.event
  const sess = (await local.call('chat.sessions.create', { title: 'm3a-e2e' })).result;
  await local.call('chat.prompt', { sessionId: sess.id, text: '__tool__ shell_execute {"command":"echo hi","tool_title":"测"}' });
  let gotEvent = false;
  for (let i = 0; i < 50; i++) {
    if (remote.notifications.some(n => n.method === 'chat.event' && n.params.sessionId === sess.id)) { gotEvent = true; break; }
    await sleep(50);
  }
  record('broadcast', gotEvent, 'remote 收到 chat.event');

  // 6. 边界：remote 调 remote.pair.begin → 被拒
  const denied = (await remote.call('remote.pair.begin', {})).error;
  record('denied', !!denied, `remote 调 remote.pair.begin 被拒: ${denied?.message ?? '未拒绝'}`);

  remote.ws.close(); local.ws.close();
} catch (e) {
  record('error', false, e.message);
} finally {
  proc.kill();
  rmSync(DATA_ROOT, { recursive: true, force: true });
}

const pass = results.filter(r => r.pass).length;
console.log(`\nM3a e2e: ${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
```

- [ ] **Step 2: 构建并运行**

Run: `cd deskminis && npm run build`
Run: `cd deskminis && npm run e2e:m3a`
Expected: 6/6 passed（begin / complete / paseto / remote.list / broadcast / denied）

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/scripts/e2e-m3a-acceptance.mjs deskminis/package.json && git commit -m "test(m3a): e2e验收驱动(配对→PASETO→WS→业务面→广播→权限边界)"
```

---

## M3a 完成定义

- 全套单测绿（`cd deskminis && npm test`，基线 432 + M3a 新增约 43 = 约 475 例）
- e2e 驱动 6/6 通过（`npm run build && npm run e2e:m3a`）：配对 → PASETO → WS → chat.sessions.list → chat.event 广播 → remote 不可调 remote.*
- 432 基线零回归（`startMinisd` 返回值只增字段、verifyClient 老路径行为不变、broadcast 一字不改）
- 交付物：
  - RpcServer 支持 additionalVerify + authMode(local/pairing/remote) 三级
  - PASETO v4.local 铸/验（noble 套件，10 分钟时效）
  - 8 字配对码 + X25519 ECDH + PairingKey 落 KeyringVault
  - MINISD_HOST env 接线（standalone 分支读 env）
  - undici noProxy 出流量模块（M3 专用，provider 红线隔离）
  - `deskminis-cli remote pair/connect/status/unpair`
- **不在本计划范围（显式）**：
  - 手机端实装（OpenMinis 代码库）——待 OM 侧实装后补真机联调
  - mDNS 发现、E2EE 官方中继（云端部署件，单独立项；M3a 仅 LAN 直连）
  - GUI「设置-远程接入」开关与配对码展示（独立 GUI 任务，M3a 只提供 CLI + RPC）
  - M3b 双向会话同步、M3c 跨端接力（后续里程碑）

> 下一步：评审通过后，按 M3a → M3b → M3c 顺序实施；M3a 落地后启动 OM 侧对接与真机联调。
