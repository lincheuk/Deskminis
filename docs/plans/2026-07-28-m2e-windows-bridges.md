# DeskMinis M2e（windows-* CLI 桥）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付六个 windows-* CLI 桥（windows-notify / windows-clipboard / windows-open / windows-speak / windows-screenshot / windows-device）：薄 stub CLI 经命名管道长度前缀帧 RPC 进 minisd 桥服务，功能实现集中在 minisd（经一次性 PowerShell），权限按 `MINIS_CHAT_SESSION_ID` 会话定域复用 PermissionGatewayImpl，统一 JSON 信封与退出码，系统提示一段话渐进披露。

**Architecture:** 薄 stub（`src/minisd/bridge-cli.mjs`，零依赖单文件，开发期 `node` 直跑，M4 用 Node SEA 打成 exe）→ 命名管道 `\\.\pipe\deskminis-<dataRootHash8>` → minisd 内 `BridgeServer`（每连接一帧请求、一帧响应；4 字节大端长度前缀 + UTF-8 JSON，借鉴 Android NOFF/NOFR 帧思想）→ 分发器按 `tool action` 路由到六个 handler → handler 过权限网关后经一次性 PowerShell 实现功能 → 统一信封 `{ok, tool, action, data|error{code,message}, timestamp}` 回给 stub 打印。shell_execute 的会话 shell 注入 `MINIS_CHAT_SESSION_ID` / `MINIS_BRIDGE_PIPE` / `MINIS_BRIDGE_CLI` / `MINIS_BRIDGE_NODE` 四个环境变量，模型在 shell 里直接调桥。设计依据：`../specs/2026-07-26-deskminis-design.md` §4.4 / §4.5。

**Tech Stack:** TypeScript (strict) / Node 22（electron as node，`net` 命名管道开箱即用）/ PowerShell 5.1（powershell.exe，功能实现）/ vitest（零新增 npm 依赖）

## Global Constraints

- 所有代码在 `deskminis/` 子目录（仓库根是 `C:\Users\24739\Downloads\openminis1\`，`OpenMinis/` 是只读参考克隆，永不修改）
- TypeScript `strict: true`；包管理 npm；**本里程碑零新增 npm 依赖**（帧/管道/CLI 全部用 node 内建模块）
- 时间戳一律 **epoch 秒（浮点）**（信封的 `timestamp` 同样遵守：`Date.now() / 1000`）
- 测试命令统一 `npm test`（vitest run，跑在 electron as node 下，命名管道可用）；单文件 `npm test -- tests/xxx.test.ts` 或子串 `npm test -- bridge-frame`
- 提交信息用 conventional commits + 中文描述（如 `feat(m2e): …`）
- 代码基线 = **M1 + M2b + M2a + M2c 已完成**（313 测试 / 31 个测试文件全绿，假定 M2d 未执行）；本里程碑新增测试约 72 例，完成后全量约 385 例
- Windows-only：命名管道、powershell.exe、System.Speech/System.Drawing 均按 Windows 桌面交互会话前提设计，不做跨平台分支
- 桥脚本安全红线：**永不把用户载荷插值进 PowerShell 源码**——载荷一律经 stdin JSON 传入，脚本内 `ConvertFrom-Json` 取用
- M2e 明确不做：SEA 打包 exe（M4）、桥命令注册进系统 PATH（M4）、截图回传图像字节（先落盘 attachments）、更多桥（录屏/麦克风等）

## 架构决策（实现前必读）

1. **stub 形态：选 (a) Node 单文件 CLI + M4 打包期 SEA 成 exe，不选 .cmd shim。** 理由：① M1 技术栈全 Node，stub 与 minisd 共享同一运行时假设，零工具链新增；② 单文件零依赖 `.mjs` 开发期 `node bridge-cli.mjs` 即可用，测试可直接 spawn；③ SEA（Node Single Executable Application）M4 打包期一个文件变 exe，天然满足设计"薄 stub exe"终态；④ .cmd shim 只是间接层，最终仍要调 node/electron，且散成六个文件难维护。开发期不依赖系统安装 Node：minisd 把 `process.execPath`（electron.exe）作为 `MINIS_BRIDGE_NODE` 注入并置 `ELECTRON_RUN_AS_NODE=1`，`& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" ...` 在任何装了 DeskMinis 的机器上可用（与 `npm test` 跑 vitest 同一机制）。
2. **桥功能实现走独立一次性 PowerShell（`runPowerShell`），不复用 ShellManager。** 理由：① PersistentShell 是会话级有状态长驻壳，桥调用会与 agent 自己的 shell_execute 命令在同一会话队列里串行——agent 跑长命令时 `windows-clipboard get` 会被堵到超时；② 桥请求经管道异步到达，与 agent 循环无 happens-before 关系，必须能并行；③ 桥脚本无状态、一次性， PersistentShell 的哨兵协议/死壳重建/100KB 截断全是无谓耦合；④ 失败域隔离：桥的一次性壳崩溃不影响会话壳。`runPowerShell` 复用 M1 已验证的 `-EncodedCommand`（UTF-16LE base64）启动模式，约 40 行。
3. **权限分类（逐项）：** `bridge-device` → **bypass**（纯只读系统信息，设计 §4.5 三级里的 bypass 级；M1 实现只落地了两级，本里程碑恢复 `bypass` 枚举值，属设计内行为而非新增语义）；`bridge-clipboard-read`、`bridge-screenshot` → **askOnce**（设计 §4.5 明示隐私敏感）；`bridge-clipboard-write` → **askOnce**（覆盖用户剪贴板既有内容，设计未明示，按"写用户共享状态"对齐 file-write 处置）；`bridge-notify` / `bridge-open` / `bridge-speak` → **askOnce**（三者虽即时用户可感知，但可被打扰性滥用——弹窗骚扰/打开钓鱼页/深夜外放；askOnce 配合 allow-session 每会话只问一次，体验与安全平衡）。无 notAllowed 桥项。授权记忆粒度 = `(sessionId, kind, detail)`，桥的 `detail` 统一为能力串 `"<tool> <action>"`（如 `windows-notify show`）而非载荷，否则每条不同标题的通知都会重新弹卡。
4. **退出码语义：0 成功 / 1 一般错误 / 2 权限拒绝 / 3 参数错误 / 4 桥服务不可达。** 设计 §4.4 只列了"退出码 0/1/2/3/4"未给语义，OpenMinis 克隆中也无对应定义（见决策 5）；此处语义为本计划裁定，写入 stub `--help` 固化。映射：信封 `error.code` = `PERMISSION_DENIED`→2、`INVALID_ARGS`（含本地 argv/环境缺失中的会话 id 缺失）→3、stub 本地产生的 `BRIDGE_UNAVAILABLE`（连不上管道/管道超时/管道环境变量缺失）→4、其余（`EXEC_ERROR`/`INTERNAL_ERROR`/`INVALID_REQUEST`）→1。
5. **帧格式：4 字节大端 uint32 长度前缀 + UTF-8 JSON 体，上限 16MB。** 设计参考核查结论：本仓库 OpenMinis 克隆中 grep 不到 Android NOFF/NOFR 实现或 `docs/bridge`（仅 iOS `NativeOffloadUtils.m` 有同名前缀的错误码常量、`LANTransport.swift` 注释提及"长度前缀二进制帧"概念），故只借鉴其"长度前缀帧"思想，格式为本计划自定，代码零复用（GPLv3 隔离）。每连接一帧请求一帧响应（one-shot），天然免粘包歧义；半包由解码器缓冲处理。
6. **截图落盘而非回传字节：** 保存 PNG 到 `sessions/<id>/attachments/screenshot-<ISO时间>.png`，信封 data 返回 `{path, width, height, bytes}`。理由：1080p PNG base64 可达数 MB，塞 JSON 帧/模型上下文都浪费；attachments 桶正是设计 §3 的会话文件归宿，模型后续可 `read_image` 该路径。
7. **stdin 载荷必须显式 `--stdin` 旗标才读取。** stub 若按"stdin 非 TTY 就读"惯例，在 PersistentShell 里运行时 stdin 是 minisd 持有的驱动管道（永不 EOF），会永久悬挂。`--stdin` 显式化后行为确定。
8. **管道名 = `\\.\pipe\deskminis-<sha256(数据根绝对路径小写)前8位hex>`**——同机多数据根实例不冲突；同数据根双实例时第二个 listen 失败仅降级（console.warn + `bridgePipe=undefined` 继续服务），不拖垮 minisd。管道发现只经环境变量（`MINIS_BRIDGE_PIPE` 由 shell 注入）；stub 在 agent shell 外运行属用法错误，退出码 3/4 并提示。

## 文件结构总览（相对 M1+M2b+M2a+M2c 基线的增量）

```
deskminis/
  src/minisd/bridge/frame.ts      (新) 长度前缀帧编解码（纯函数 + 增量解码器，上限 16MB）
  src/minisd/bridge/handlers.ts   (新) 桥请求/信封类型、runPowerShell 一次性执行器、六桥 handler + 分发器
  src/minisd/bridge/server.ts     (新) 命名管道服务器、管道名派生、桥环境变量构造、stub 路径解析
  src/minisd/bridge-cli.mjs       (新) 零依赖薄 stub（node 直跑；M4 转 SEA exe）
  src/minisd/tools/types.ts       (改) PermissionRequest.kind 扩展七个桥类目
  src/minisd/tools/permissions.ts (改) PermissionLevel 恢复 bypass；桥类目默认级别表；check 路由简化
  src/minisd/tools/shell.ts       (改) PersistentShell/ShellManager/makeShellTool 支持每会话环境变量注入
  src/minisd/index.ts             (改) 装配 BridgeServer、SYSTEM_PROMPT 加桥段落、返回值带 bridgePipe
  tests/bridge-frame.test.ts      (新)
  tests/bridge-handlers.test.ts   (新)
  tests/bridge-server.test.ts     (新)
  tests/bridge-minisd.test.ts     (新) 装配与权限定域端到端
  tests/bridge-cli.test.ts        (新) stub 端到端（真管道）
  tests/bridge-util.ts            (新) 测试共享：管道帧客户端 + echo 服务（非 .test.ts，不被 vitest 当套件）
  tests/permissions.test.ts       (改) 追加桥类目用例
  tests/shell.test.ts             (改) 追加环境变量注入用例
```

任务依赖：1 → 2 → 3 → 4 → 5 → 6（严格串行；3 消费 2 的类型，4 消费 1+3，5 消费 4，6 消费 4 并对 5 的产物做端到端）。

---

### Task 1: 长度前缀帧编解码

**Files:**
- Create: `deskminis/src/minisd/bridge/frame.ts`
- Test: `deskminis/tests/bridge-frame.test.ts`

**Interfaces:**
- Consumes: 无（纯 node 内建 Buffer）
- Produces（Task 4/6 与 tests/bridge-util.ts 依赖，签名以此为准）:
  - `const MAX_FRAME_BYTES = 16 * 1024 * 1024`
  - `function encodeFrame(payload: unknown): Buffer`——JSON 序列化 + 4 字节大端长度头；体超长抛错
  - `class FrameDecoder { constructor(maxBytes?: number); push(chunk: Buffer): Buffer[] }`——增量喂字节，返回本轮拆出的完整帧体（不含长度头）；长度头超上限抛错并复位缓冲

- [ ] **Step 1: 写失败测试**

`deskminis/tests/bridge-frame.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '../src/minisd/bridge/frame';

describe('encodeFrame / FrameDecoder', () => {
  it('单帧往返一致（含中文与嵌套对象）', () => {
    const payload = { tool: 'windows-notify', action: 'show', args: { title: '标题①' }, sessionId: 'S1', stdin: '多行\n文本' };
    const frames = new FrameDecoder().push(encodeFrame(payload));
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0].toString('utf8'))).toEqual(payload);
  });

  it('半包：逐字节滴入，收齐才出帧', () => {
    const wire = encodeFrame({ a: 1 });
    const dec = new FrameDecoder();
    for (let i = 0; i < wire.length - 1; i++) {
      expect(dec.push(wire.subarray(i, i + 1))).toEqual([]);
    }
    const out = dec.push(wire.subarray(wire.length - 1));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].toString('utf8'))).toEqual({ a: 1 });
  });

  it('粘包：两帧一次推入，拆出两帧且保序', () => {
    const wire = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]);
    const out = new FrameDecoder().push(wire);
    expect(out.map(f => JSON.parse(f.toString('utf8')).n)).toEqual([1, 2]);
  });

  it('粘包+半包混合：帧跨两次推入边界', () => {
    const f1 = encodeFrame('甲');
    const f2 = encodeFrame('乙');
    const wire = Buffer.concat([f1, f2]);
    const dec = new FrameDecoder();
    const cut = f1.length - 2; // 第一帧差 2 字节处切开
    expect(dec.push(wire.subarray(0, cut))).toEqual([]);
    const out = dec.push(wire.subarray(cut));
    expect(out.map(f => f.toString('utf8'))).toEqual(['"甲"', '"乙"']);
  });

  it('长度头超上限：抛错且解码器复位（后续新帧不受影响）', () => {
    const dec = new FrameDecoder();
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => dec.push(evil)).toThrow(/超过上限/);
    // 复位后正常帧仍可用
    const out = dec.push(encodeFrame({ ok: true }));
    expect(JSON.parse(out[0].toString('utf8'))).toEqual({ ok: true });
  });

  it('长度恰好等于上限：放行', () => {
    const dec = new FrameDecoder();
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME_BYTES, 0);
    expect(dec.push(head)).toEqual([]); // 不抛错，等体
  });

  it('encodeFrame 体超上限直接抛错', () => {
    expect(() => encodeFrame({ big: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow(/超过上限/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- bridge-frame`
Expected: FAIL（模块 `../src/minisd/bridge/frame` 不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/bridge/frame.ts`:

```typescript
/** 桥线协议帧：4 字节大端 uint32 长度前缀 + UTF-8 JSON 体（借鉴 Android NOFF/NOFR 的长度前缀帧思想，格式自定）。
 *  上限 16MB：正常信封远在 1MB 内（剪贴板读在 handler 层已截断 1MB），上限只用于防畸形对端撑爆内存。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new Error(`帧体 ${body.length} 超过上限 ${MAX_FRAME_BYTES}`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 增量帧解码器：任意切块推入（半包缓冲、粘包拆帧），返回本轮新收齐的帧体（不含长度头）。 */
export class FrameDecoder {
  private buf = Buffer.alloc(0);

  constructor(private maxBytes = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Buffer[] = [];
    while (true) {
      if (this.buf.length < 4) return out;
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxBytes) {
        // 畸形对端：复位缓冲再抛，让调用方有机会回一帧错误信封而不是僵死
        this.buf = Buffer.alloc(0);
        throw new Error(`帧长度 ${len} 超过上限 ${this.maxBytes}`);
      }
      if (this.buf.length < 4 + len) return out;
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- bridge-frame`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/bridge/frame.ts deskminis/tests/bridge-frame.test.ts && git commit -m "feat(m2e): 桥线协议长度前缀帧编解码(半包/粘包/16MB上限)"
```

---

### Task 2: 权限网关桥类目扩展

**Files:**
- Modify: `deskminis/src/minisd/tools/types.ts`（PermissionRequest.kind 扩展）
- Modify: `deskminis/src/minisd/tools/permissions.ts`（bypass 级别 + 桥类目默认级别 + check 路由）
- Test: `deskminis/tests/permissions.test.ts`（追加 describe；既有用例一字不动）

**Interfaces:**
- Consumes: M1 的 `PermissionGateway`/`PermissionRequest`/`PermissionDecision`、`PermissionGatewayImpl`
- Produces（Task 3 依赖，签名以此为准）:
  - `types.ts`: `type BridgePermissionKind = 'bridge-notify' | 'bridge-clipboard-read' | 'bridge-clipboard-write' | 'bridge-open' | 'bridge-speak' | 'bridge-screenshot' | 'bridge-device'`；`PermissionRequest.kind: 'shell' | 'file-write' | 'file-read' | BridgePermissionKind`
  - `permissions.ts`: `type PermissionLevel = 'bypass' | 'askOnce' | 'notAllowed'`；`type PermissionClass = CommandClass | 'file-write' | 'file-read' | BridgePermissionKind`；默认级别：`bridge-device→bypass`，其余六个桥类目→`askOnce`，`danger/gated/file-*` 不变；`check()` 对非 shell kind 直接用 kind 作类目（不再只特判 file-write/file-read），`bypass→allow` 先于 `notAllowed→deny` 判定

- [ ] **Step 1: 写失败测试**

`deskminis/tests/permissions.test.ts` 文件**末尾追加**（不动既有内容）：

```typescript
describe('桥类目（M2e 扩展）', () => {
  const bridgeReq = (kind: PermissionRequest['kind'], detail: string, sessionId = 'S1'): PermissionRequest =>
    ({ kind, detail, sessionId, toolTitle: 't' });

  it('bridge-device 默认 bypass：放行且从不询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(bridgeReq('bridge-device', 'windows-device info'))).toBe('allow');
    expect(asked).toBe(0);
  });

  it('bridge-clipboard-read / bridge-screenshot 默认 askOnce：先问，allow-session 后按能力串静默', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(bridgeReq('bridge-clipboard-read', 'windows-clipboard get'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(bridgeReq('bridge-clipboard-read', 'windows-clipboard get'))).toBe('allow'); // 同能力 → 静默
    expect(asked).toBe(1);
    expect(await g.check(bridgeReq('bridge-screenshot', 'windows-screenshot capture'))).toBe('allow'); // 不同能力 → 重新问
    expect(asked).toBe(2);
  });

  it('六个 askOnce 桥类目逐个验证：notify/open/speak/clipboard-read/clipboard-write/screenshot', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    const cases: PermissionRequest['kind'][] = [
      'bridge-notify', 'bridge-open', 'bridge-speak',
      'bridge-clipboard-read', 'bridge-clipboard-write', 'bridge-screenshot',
    ];
    for (const kind of cases) {
      expect(await g.check(bridgeReq(kind, `detail-of-${kind}`))).toBe('allow');
    }
    expect(asked).toBe(6); // allow-once 不持久，每个类目都问了
  });

  it('桥 kind 不经 shell 分类器：detail 含危险词也只是按桥级别询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    // 'Remove-Item' 作为 shell 命令是 danger → 若路由错误会静默 deny 且从不询问（对齐 M1 file-read 路由回归用例）
    expect(await g.check(bridgeReq('bridge-notify', 'Remove-Item'))).toBe('allow');
    expect(asked).toBe(1);
  });

  it('桥授权按会话隔离：S1 的 allow-session 不惠及 S2', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(bridgeReq('bridge-open', 'windows-open open', 'S1'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(bridgeReq('bridge-open', 'windows-open open', 'S2'))).toBe('allow');
    expect(asked).toBe(2);
  });

  it('既有行为不回归：danger 硬拦不问、gated 问、file-read 问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check({ kind: 'shell', detail: 'Remove-Item -Recurse C:\\x', sessionId: 'S1', toolTitle: 't' })).toBe('deny');
    expect(asked).toBe(0);
    expect(await g.check({ kind: 'shell', detail: 'dir', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check({ kind: 'file-read', detail: 'C:\\a.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- permissions`
Expected: FAIL（`PermissionRequest['kind']` 不含 `bridge-*` 值，类型/运行期路由不存在——TS 报错或用例失败）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/tools/types.ts`（完整文件，**已对照现状核实**——M2c 已加入 `onFileRead` 钩子，原样保留；本 Task 改动点：`BridgePermissionKind` 导出 + `PermissionRequest.kind` 联合扩展）：

```typescript
import type { AgentToolDefinition } from '../../shared/types';
import type { MinisPaths } from '../paths';

export interface ToolOutcome { output: string; success: boolean }

/** windows-* 桥的能力类目：kind 即权限类目（与 file-write/file-read 同款 1:1 路由）。 */
export type BridgePermissionKind =
  | 'bridge-notify'
  | 'bridge-clipboard-read'
  | 'bridge-clipboard-write'
  | 'bridge-open'
  | 'bridge-speak'
  | 'bridge-screenshot'
  | 'bridge-device';

export interface PermissionRequest { kind: 'shell' | 'file-write' | 'file-read' | BridgePermissionKind; detail: string; sessionId: string; toolTitle: string }
export type PermissionDecision = 'allow' | 'deny';
export interface PermissionGateway { check(req: PermissionRequest): Promise<PermissionDecision> }

export interface ToolContext {
  sessionId: string; paths: MinisPaths; permissions: PermissionGateway;
  /** file_read 成功读取后的通知钩子（技能 use_count 采集点，M2c）；失败/被拒/超限不触发。 */
  onFileRead?: (absPath: string) => void;
}

export interface ToolExecutor {
  definition: AgentToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}
```

`deskminis/src/minisd/tools/permissions.ts`（完整文件，**已对照现状核实**——M2b/M2a/M2c 未改动此文件，现状与 M1 基线一致；本 Task 改动点：`PermissionLevel` 加 `bypass`、`PermissionClass` 并入 `BridgePermissionKind`、默认级别表加七个桥类目、`check` 路由从特判 file-write/file-read 改为"shell 走分类器、其余 kind 即类目"）：

```typescript
import type { BridgePermissionKind, PermissionDecision, PermissionGateway, PermissionRequest } from './types';

/** 危险层保留：这些命令即使用户想批准也硬拦截（不可逆/系统级/影子命名原语）。 */
export type CommandClass = 'danger' | 'gated';
export type PermissionLevel = 'bypass' | 'askOnce' | 'notAllowed';
export type PermissionPrompt = (req: PermissionRequest) => Promise<'allow-once' | 'allow-session' | 'deny'>;

/** 危险：不可逆或系统级操作，顺序无关。 */
const DANGER_ANYWHERE = [
  /\b(remove-item|remove-itemproperty|clear-content|clear-item)\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i,
  /\b(shutdown|restart-computer|stop-computer|logoff)\b/i,
  /\b(diskpart|bcdedit|takeown)\b/i,
  /\bcipher\b[\s\S]*\/w/i,
  /\bicacls\b[\s\S]*\/(grant|deny|setowner)/i,
  /\bsc(\.exe)?\s+(stop|delete|config|create)\b/i,
  /\b(stop-service|remove-service|new-service|set-service)\b/i,
  /\bset-executionpolicy\b/i,
  /\b(stop-process|taskkill)\b/i,
  // 名字绑定原语：影子命名（把无害名字重绑为任意行为）。含常见别名 nal/sal。
  /(^|[;|&(]\s*)(function|filter|workflow)\s/i,
  /\b(set-alias|new-alias|nal|sal)\b/i,
  /\b(set-item|new-item)\b[\s\S]*\b(alias|function):/i,
  /\bset-content\b\s+function:/i,
  /\$(function|alias):/i,
];

/** 短别名歧义大（"del old code" 散文会误伤），仅在命令位匹配。 */
const DANGER_AT_COMMAND_POSITION = [
  /(^|[;|&(]\s*)(rm|ri|del|erase|rd|rmdir)\b/i,
];

export function classifyShellCommand(command: string): CommandClass {
  const c = command.trim();
  if (DANGER_ANYWHERE.some(r => r.test(c))) return 'danger';
  if (DANGER_AT_COMMAND_POSITION.some(r => r.test(c))) return 'danger';
  return 'gated';
}

/** 权限判定类目：shell 命令分级 + 文件读写两类 + windows-* 桥七类（后九类 kind 即类目，绝不经 shell 分类器）。 */
export type PermissionClass = CommandClass | 'file-write' | 'file-read' | BridgePermissionKind;

const DEFAULT_LEVELS: Record<PermissionClass, PermissionLevel> = {
  danger: 'notAllowed', gated: 'askOnce', 'file-write': 'askOnce', 'file-read': 'askOnce',
  // 桥（设计 §4.5 + M2e 计划"架构决策 3"）：device 只读系统信息放行；剪贴板读/截图隐私敏感确认；
  // 剪贴板写覆盖用户既有内容确认；notify/open/speak 可被打扰性滥用确认。
  'bridge-device': 'bypass',
  'bridge-notify': 'askOnce',
  'bridge-clipboard-read': 'askOnce',
  'bridge-clipboard-write': 'askOnce',
  'bridge-open': 'askOnce',
  'bridge-speak': 'askOnce',
  'bridge-screenshot': 'askOnce',
};

export class PermissionGatewayImpl implements PermissionGateway {
  private levels: Record<PermissionClass, PermissionLevel>;
  /** 会话批准：按 (sessionId, kind, 精确命令/路径/能力串) 记忆——同一条命令原样重复才静默。 */
  private sessionGrants = new Set<string>();

  constructor(
    private prompt: PermissionPrompt,
    levels?: Partial<Record<PermissionClass, PermissionLevel>>,
    private askTimeoutMs = 30000,
  ) {
    this.levels = { ...DEFAULT_LEVELS, ...levels };
  }

  async check(req: PermissionRequest): Promise<PermissionDecision> {
    // 非 shell 请求的 detail 是路径/能力串，不能喂给 shell 分类器：
    // 例如 C:\tools\diskpart\notes.txt 会被误判成 danger 而静默拒绝；桥 kind 直接就是类目。
    const cls: PermissionClass = req.kind === 'shell' ? classifyShellCommand(req.detail) : req.kind;
    if (this.levels[cls] === 'bypass') return 'allow';
    if (this.levels[cls] === 'notAllowed') return 'deny';
    const grantKey = `${req.sessionId}\0${req.kind}\0${req.detail}`;
    if (this.sessionGrants.has(grantKey)) return 'allow';

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'deny'>(res => { timer = setTimeout(() => res('deny'), this.askTimeoutMs); });
    let answer: 'allow-once' | 'allow-session' | 'deny';
    try {
      answer = await Promise.race([this.prompt(req), timeout]);
    } finally {
      if (timer) clearTimeout(timer); // 修复：prompt 先返回时清掉悬挂定时器
    }
    if (answer === 'allow-session') { this.sessionGrants.add(grantKey); return 'allow'; }
    return answer === 'allow-once' ? 'allow' : 'deny';
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- permissions`
Expected: 全部 passed（基线既有用例 + 新增 6 个桥用例）

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/tools/types.ts deskminis/src/minisd/tools/permissions.ts deskminis/tests/permissions.test.ts && git commit -m "feat(m2e): 权限网关扩展桥类目(恢复bypass级+六桥askOnce/device放行)"
```

---

### Task 3: 一次性 PowerShell 执行器与六桥 handlers

**Files:**
- Create: `deskminis/src/minisd/bridge/handlers.ts`
- Test: `deskminis/tests/bridge-handlers.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `BridgePermissionKind`/`PermissionGateway`；M1 的 `MinisPaths`（`sessionBucket(sessionId, 'attachments')`）
- Produces（Task 4/5/6 与 bridge-util 依赖，签名以此为准）:
  - `interface BridgeRequest { tool: string; action: string; args: Record<string, string>; sessionId: string; stdin?: string }`
  - `interface BridgeEnvelope { ok: boolean; tool: string; action: string; data?: unknown; error?: { code: string; message: string }; timestamp: number }`（timestamp = epoch 秒浮点）
  - `class BridgeError extends Error { constructor(readonly code: string, message: string) }`
  - `function okEnvelope(tool: string, action: string, data: unknown): BridgeEnvelope`
  - `function errEnvelope(tool: string, action: string, code: string, message: string): BridgeEnvelope`
  - `type PsRunner = (script: string, stdin?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>`
  - `function runPowerShell(script: string, stdin?: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }>`——一次性 `powershell.exe -NoProfile -NoLogo -NonInteractive -EncodedCommand`；stdin 原样写入后关闭；超时被杀返回 exitCode 124；spawn 失败 reject
  - `interface BridgeDeps { permissions: PermissionGateway; paths: MinisPaths; runPs?: PsRunner }`
  - `function makeBridgeDispatcher(deps: BridgeDeps): (req: BridgeRequest) => Promise<BridgeEnvelope>`——分发表七个键：`windows-notify show` / `windows-clipboard get` / `windows-clipboard set` / `windows-open open` / `windows-speak say` / `windows-screenshot capture` / `windows-device info`；未知键→`INVALID_ARGS`；sessionId 必须匹配 UUID 形态（同 index.ts 的 SESSION_ID_RE）否则 `INVALID_ARGS`；权限 deny→`PERMISSION_DENIED`；PowerShell 非零退出→`EXEC_ERROR`；其余异常→`INTERNAL_ERROR`；**任何情况 resolve 信封、绝不 reject**

- [ ] **Step 1: 写失败测试**

`deskminis/tests/bridge-handlers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeBridgeDispatcher, runPowerShell, BridgeError,
  type BridgeRequest, type BridgeDeps, type PsRunner,
} from '../src/minisd/bridge/handlers';
import { MinisPaths } from '../src/minisd/paths';
import type { PermissionGateway, PermissionRequest } from '../src/minisd/tools/types';

const SESSION = 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789';

function allowGateway(captured: PermissionRequest[]): PermissionGateway {
  return { async check(r) { captured.push(r); return 'allow'; } };
}
function denyGateway(): PermissionGateway {
  return { async check() { return 'deny'; } };
}
/** 假执行器：记录调用；stdin JSON 里带 path 时落一个假 PNG（配合截图 handler 的 statSync）；
 *  设备信息脚本返回固定 JSON；其余返回指定 stdout。 */
function fakeRunPs(calls: { script: string; stdin?: string; timeoutMs?: number }[], result: { stdout?: string; stderr?: string; exitCode?: number } = {}): PsRunner {
  return async (script, stdin, timeoutMs) => {
    calls.push({ script, stdin, timeoutMs });
    if (script.includes('Win32_OperatingSystem')) {
      return { stdout: '{"osVersion":"Microsoft Windows 11 10.0.22631","computerName":"FAKE-PC","userName":"fake","cpuCount":8,"totalMemoryMB":16384,"psVersion":"5.1.22621.1"}', stderr: '', exitCode: 0 };
    }
    if (stdin) {
      try {
        const p = JSON.parse(stdin);
        if (typeof p.path === 'string') {
          const { writeFileSync, mkdirSync } = await import('node:fs');
          const { dirname } = await import('node:path');
          mkdirSync(dirname(p.path), { recursive: true });
          writeFileSync(p.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        }
      } catch { /* 非 JSON stdin（剪贴板文本等），忽略 */ }
    }
    return { stdout: result.stdout ?? '1920x1080', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 };
  };
}

function mkDeps(gateway: PermissionGateway, runPs: PsRunner): { deps: BridgeDeps; paths: MinisPaths } {
  const root = mkdtempSync(join(tmpdir(), 'dm-br-'));
  const paths = new MinisPaths(root);
  paths.ensureSessionDirs(SESSION);
  return { deps: { permissions: gateway, paths, runPs }, paths };
}
const req = (tool: string, action: string, args: Record<string, string> = {}, stdin?: string): BridgeRequest =>
  ({ tool, action, args, sessionId: SESSION, ...(stdin !== undefined ? { stdin } : {}) });

describe('分发与权限定域', () => {
  it.each([
    ['windows-notify', 'show', { title: 't' }, 'bridge-notify'],
    ['windows-clipboard', 'get', {}, 'bridge-clipboard-read'],
    ['windows-clipboard', 'set', { text: 'x' }, 'bridge-clipboard-write'],
    ['windows-open', 'open', { target: 'https://example.com' }, 'bridge-open'],
    ['windows-speak', 'say', { text: 'x' }, 'bridge-speak'],
    ['windows-screenshot', 'capture', {}, 'bridge-screenshot'],
    ['windows-device', 'info', {}, 'bridge-device'],
  ])('%s %s → 权限类目 %s，detail 为能力串', async (tool, action, args, kind) => {
    const captured: PermissionRequest[] = [];
    const calls: { script: string; stdin?: string }[] = [];
    const { deps } = mkDeps(allowGateway(captured), fakeRunPs(calls));
    await makeBridgeDispatcher(deps)(req(tool, action, args));
    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe(kind);
    expect(captured[0].detail).toBe(`${tool} ${action}`);
    expect(captured[0].sessionId).toBe(SESSION);
    expect(captured[0].toolTitle.length).toBeGreaterThan(0);
  });

  it('未知工具 → INVALID_ARGS，且不问权限', async () => {
    const captured: PermissionRequest[] = [];
    const { deps } = mkDeps(allowGateway(captured), fakeRunPs([]));
    const env = await makeBridgeDispatcher(deps)(req('windows-nuke', 'boom'));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGS');
    expect(captured).toHaveLength(0);
  });

  it('已知工具未知动作 → INVALID_ARGS', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([]));
    const env = await makeBridgeDispatcher(deps)(req('windows-clipboard', 'delete'));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGS');
  });

  it.each([[''], ['not-a-uuid'], ['..\\..\\Windows'], ['A1B2C3D4-E5F6-4789-ABCD-EF01234567890']])(
    '非法 sessionId %j → INVALID_ARGS，且不问权限（防路径注入）', async (bad) => {
      const captured: PermissionRequest[] = [];
      const { deps } = mkDeps(allowGateway(captured), fakeRunPs([]));
      const env = await makeBridgeDispatcher(deps)({ tool: 'windows-device', action: 'info', args: {}, sessionId: bad });
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('INVALID_ARGS');
      expect(captured).toHaveLength(0);
    });

  it('权限 deny → PERMISSION_DENIED，且不执行 PowerShell', async () => {
    const calls: { script: string }[] = [];
    const { deps } = mkDeps(denyGateway(), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-clipboard', 'get'));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PERMISSION_DENIED');
    expect(calls).toHaveLength(0);
  });

  it('信封形状：ok/data/timestamp(epoch秒浮点) 齐全；错误时 error{code,message} 且无 data', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([]));
    const okEnv = await makeBridgeDispatcher(deps)(req('windows-device', 'info'));
    expect(okEnv.ok).toBe(true);
    expect(okEnv.tool).toBe('windows-device');
    expect(okEnv.action).toBe('info');
    expect(okEnv.timestamp).toBeGreaterThan(1_700_000_000);
    expect(okEnv.error).toBeUndefined();
    const errEnv = await makeBridgeDispatcher(deps)(req('windows-nope', 'x'));
    expect(errEnv.ok).toBe(false);
    expect(errEnv.data).toBeUndefined();
    expect(typeof errEnv.error?.message).toBe('string');
  });
});

describe('六个 handler', () => {
  it('notify：载荷经 stdin JSON 传入，脚本零插值', async () => {
    const calls: { script: string; stdin?: string }[] = [];
    const { deps } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-notify', 'show', { title: '构建完成', body: '附"引号"与\n换行' }));
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ shown: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].script).not.toContain('构建完成'); // 载荷绝不出现在脚本源码里
    expect(JSON.parse(calls[0].stdin!)).toEqual({ title: '构建完成', body: '附"引号"与\n换行' });
  });

  it('notify：title/body 缺省有默认值', async () => {
    const calls: { script: string; stdin?: string }[] = [];
    const { deps } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-notify', 'show'));
    expect(env.ok).toBe(true);
    expect(JSON.parse(calls[0].stdin!)).toEqual({ title: 'DeskMinis', body: '' });
  });

  it('clipboard get：返回文本；超 1MB 截断并标记', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([], { stdout: '剪贴板内容' }));
    const env = await makeBridgeDispatcher(deps)(req('windows-clipboard', 'get'));
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ text: '剪贴板内容', truncated: false });

    const big = 'x'.repeat(1024 * 1024 + 100);
    const { deps: deps2 } = mkDeps(allowGateway([]), fakeRunPs([], { stdout: big }));
    const env2 = await makeBridgeDispatcher(deps2)(req('windows-clipboard', 'get'));
    expect(env2.ok).toBe(true);
    const d2 = env2.data as { text: string; truncated: boolean };
    expect(d2.truncated).toBe(true);
    expect(d2.text.length).toBe(1024 * 1024);
  });

  it('clipboard set：--text 优先于 stdin；两者皆无 → INVALID_ARGS', async () => {
    const calls: { script: string; stdin?: string }[] = [];
    const { deps } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-clipboard', 'set', { text: '参数文本' }, '管道文本'));
    expect(env.ok).toBe(true);
    expect(JSON.parse(calls[0].stdin!)).toEqual({ text: '参数文本' });

    const { deps: deps2 } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env2 = await makeBridgeDispatcher(deps2)(req('windows-clipboard', 'set', {}, '管道文本'));
    expect(env2.ok).toBe(true);
    expect(JSON.parse(calls[1].stdin!)).toEqual({ text: '管道文本' });

    const { deps: deps3 } = mkDeps(allowGateway([]), fakeRunPs([]));
    const env3 = await makeBridgeDispatcher(deps3)(req('windows-clipboard', 'set'));
    expect(env3.ok).toBe(false);
    expect(env3.error?.code).toBe('INVALID_ARGS');
  });

  it('open：http(s) 直放；本机存在路径放行；不存在且非网址 → INVALID_ARGS', async () => {
    const calls: { script: string; stdin?: string }[] = [];
    const { deps, paths } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-open', 'open', { target: 'https://example.com' }));
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ opened: 'https://example.com' });

    const realFile = join(paths.sessionBucket(SESSION, 'workspace'), 'a.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(realFile, 'x');
    const env2 = await makeBridgeDispatcher(deps)(req('windows-open', 'open', { target: realFile }));
    expect(env2.ok).toBe(true);

    const env3 = await makeBridgeDispatcher(deps)(req('windows-open', 'open', { target: 'C:\\绝\\对\\不\\存\\在.txt' }));
    expect(env3.ok).toBe(false);
    expect(env3.error?.code).toBe('INVALID_ARGS');
    const env4 = await makeBridgeDispatcher(deps)(req('windows-open', 'open', {}));
    expect(env4.ok).toBe(false);
    expect(env4.error?.code).toBe('INVALID_ARGS');
  });

  it('speak：rate 合法直放；非整数/超界 → INVALID_ARGS；--text 与 stdin 兜底', async () => {
    const calls: { script: string; stdin?: string; timeoutMs?: number }[] = [];
    const { deps } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', { text: '你好', rate: '-2' }));
    expect(env.ok).toBe(true);
    expect(JSON.parse(calls[0].stdin!)).toEqual({ text: '你好', rate: -2 });
    expect(calls[0].timeoutMs).toBe(120000); // 播报耗时与文本长度相关，放宽到 120s

    const env2 = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', { text: 'x', rate: '11' }));
    expect(env2.ok).toBe(false);
    expect(env2.error?.code).toBe('INVALID_ARGS');
    const env3 = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', { text: 'x', rate: '1.5' }));
    expect(env3.ok).toBe(false);
    const env4 = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', {}, 'stdin 文本'));
    expect(env4.ok).toBe(true);
    expect(JSON.parse(calls[1].stdin!)).toEqual({ text: 'stdin 文本' });
    const env5 = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', {}));
    expect(env5.ok).toBe(false);
    expect(env5.error?.code).toBe('INVALID_ARGS');
  });

  it('screenshot：PNG 落会话 attachments，返回 {path,width,height,bytes}', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([]));
    const env = await makeBridgeDispatcher(deps)(req('windows-screenshot', 'capture'));
    expect(env.ok).toBe(true);
    const d = env.data as { path: string; width: number; height: number; bytes: number };
    expect(d.path).toContain('attachments');
    expect(d.path).toMatch(/screenshot-.*\.png$/);
    expect(d.width).toBe(1920);
    expect(d.height).toBe(1080);
    expect(d.bytes).toBe(4); // 假 PNG 四字节
    expect(existsSync(d.path)).toBe(true);
  });

  it('device：解析 PowerShell 输出 JSON 为 data', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([]));
    const env = await makeBridgeDispatcher(deps)(req('windows-device', 'info'));
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;
    expect(d.computerName).toBe('FAKE-PC');
    expect(d.cpuCount).toBe(8);
  });

  it('PowerShell 非零退出 → EXEC_ERROR（带 stderr）', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([], { stdout: '', stderr: '爆栈了', exitCode: 1 }));
    const env = await makeBridgeDispatcher(deps)(req('windows-notify', 'show', { title: 'x' }));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('EXEC_ERROR');
    expect(env.error?.message).toContain('爆栈了');
  });
});

describe('runPowerShell（真实 powershell.exe）', () => {
  it('stdin 透传：脚本 ReadToEnd 原样读回（含中文）', async () => {
    const r = await runPowerShell('[Console]::In.ReadToEnd()', '你好，桥');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('你好，桥');
  });

  it('原生命令退出码穿透', async () => {
    const r = await runPowerShell('exit 3');
    expect(r.exitCode).toBe(3);
  });

  it('超时杀进程返回 124', async () => {
    const r = await runPowerShell('Start-Sleep -Seconds 60', '', 1500);
    expect(r.exitCode).toBe(124);
  }, 20000);
});

describe('真实 PowerShell 集成（allow-all 网关）', () => {
  const realDeps = (): BridgeDeps => {
    const root = mkdtempSync(join(tmpdir(), 'dm-br-real-'));
    const paths = new MinisPaths(root);
    paths.ensureSessionDirs(SESSION);
    return { permissions: { async check() { return 'allow' as const; } }, paths };
  };

  it('clipboard set→get 往返（会短暂改写本机剪贴板）', async () => {
    const dispatch = makeBridgeDispatcher(realDeps());
    const setEnv = await dispatch(req('windows-clipboard', 'set', { text: 'DeskMinis-M2E-测试①' }));
    expect(setEnv.ok).toBe(true);
    const getEnv = await dispatch(req('windows-clipboard', 'get'));
    expect(getEnv.ok).toBe(true);
    expect((getEnv.data as { text: string }).text).toBe('DeskMinis-M2E-测试①');
  });

  it('device info 返回本机真实字段', async () => {
    const env = await makeBridgeDispatcher(realDeps())(req('windows-device', 'info'));
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;
    expect(d.computerName).toBe(process.env.COMPUTERNAME);
    expect(typeof d.totalMemoryMB).toBe('number');
    expect((d.cpuCount as number) > 0).toBe(true);
  });

  it('screenshot 真截屏存 PNG（需交互式桌面会话）', async () => {
    const env = await makeBridgeDispatcher(realDeps())(req('windows-screenshot', 'capture'));
    expect(env.ok).toBe(true);
    const d = env.data as { path: string; width: number; height: number; bytes: number };
    const head = readFileSync(d.path).subarray(0, 4);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG 魔数
    expect(d.width).toBeGreaterThan(0);
    expect(d.bytes).toBeGreaterThan(1000);
  }, 30000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- bridge-handlers`
Expected: FAIL（模块 `../src/minisd/bridge/handlers` 不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/bridge/handlers.ts`:

```typescript
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MinisPaths } from '../paths';
import type { BridgePermissionKind, PermissionGateway } from '../tools/types';

// ---------- 线协议类型（Task 4 管道服务、Task 6 stub 共用同一形状） ----------

export interface BridgeRequest {
  tool: string;
  action: string;
  args: Record<string, string>;
  sessionId: string;
  stdin?: string;
}

/** 统一 JSON 信封（设计 §4.4）：timestamp 为 epoch 秒浮点（全局约束）。 */
export interface BridgeEnvelope {
  ok: boolean;
  tool: string;
  action: string;
  data?: unknown;
  error?: { code: string; message: string };
  timestamp: number;
}

export class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

export function okEnvelope(tool: string, action: string, data: unknown): BridgeEnvelope {
  return { ok: true, tool, action, data, timestamp: Date.now() / 1000 };
}

export function errEnvelope(tool: string, action: string, code: string, message: string): BridgeEnvelope {
  return { ok: false, tool, action, error: { code, message }, timestamp: Date.now() / 1000 };
}

// ---------- 一次性 PowerShell 执行器（架构决策 2：不复用会话 PersistentShell） ----------

export type PsRunner = (script: string, stdin?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const PS_STDOUT_CAP = 20 * 1024 * 1024; // 截蓄上限，防畸形输出撑爆内存（正常桥输出 ≤1MB）

/** 一次性 powershell.exe：-EncodedCommand(UTF-16LE base64) 免引号转义；stdin 写入即关；超时 SIGKILL 记 124。
 *  与 M1 PersistentShell 同源的启动参数，但无状态、每次独立进程（架构决策 2）。 */
export function runPowerShell(script: string, stdin = '', timeoutMs = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => { if (stdout.length < PS_STDOUT_CAP) stdout += c; });
    proc.stderr.on('data', (c: string) => { if (stderr.length < 1024 * 1024) stderr += c; });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ stdout, stderr: stderr + '\n[桥命令超时被终止]', exitCode: 124 });
    }, timeoutMs);
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? 1 }); });
    // 子进程早退时写 stdin 的异步 EPIPE：吞掉，close 分支会兜底返回非零退出码
    proc.stdin.on('error', () => { /* 见上注释 */ });
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

// ---------- 六桥 handler ----------

export interface BridgeDeps { permissions: PermissionGateway; paths: MinisPaths; runPs?: PsRunner }
interface HandlerCtx { req: BridgeRequest; deps: BridgeDeps; runPs: PsRunner }

/** 与 index.ts 的 SESSION_ID_RE 同源：sessionId 会拼进 attachments 路径，必须限死 UUID 形态。 */
const SESSION_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const CLIPBOARD_MAX_TEXT = 1024 * 1024;

/** 载荷只走 stdin JSON，脚本本体是常量——脚本里永不插值用户数据（全局约束红线）。 */
const NOTIFY_PS = `
$ErrorActionPreference = 'Stop'
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode([string]$p.title)) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode([string]$p.body)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
`;

const CLIPBOARD_GET_PS = `
$t = Get-Clipboard -Raw
if ($null -eq $t) { $t = '' }
[Console]::Out.Write($t)
`;

const CLIPBOARD_SET_PS = `
$ErrorActionPreference = 'Stop'
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Set-Clipboard -Value ([string]$p.text)
`;

const OPEN_PS = `
$ErrorActionPreference = 'Stop'
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Start-Process -FilePath ([string]$p.target)
`;

const SPEAK_PS = `
$ErrorActionPreference = 'Stop'
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($null -ne $p.rate) { $s.Rate = [int]$p.rate }
$s.Speak([string]$p.text)
$s.Dispose()
`;

const SCREENSHOT_PS = `
$ErrorActionPreference = 'Stop'
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$v = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $v.Width, $v.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($v.Left, $v.Top, 0, 0, $bmp.Size)
$bmp.Save([string]$p.path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
[Console]::Out.Write("$($v.Width)x$($v.Height)")
`;

const DEVICE_PS = `
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  osVersion = "$($os.Caption) $($os.Version)"
  computerName = $env:COMPUTERNAME
  userName = $env:USERNAME
  cpuCount = [Environment]::ProcessorCount
  totalMemoryMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
  psVersion = $PSVersionTable.PSVersion.ToString()
} | ConvertTo-Json -Compress
`;

async function runChecked(ctx: HandlerCtx, script: string, payload?: unknown, timeoutMs?: number): Promise<string> {
  const r = await ctx.runPs(script, payload === undefined ? undefined : JSON.stringify(payload), timeoutMs);
  if (r.exitCode !== 0) throw new BridgeError('EXEC_ERROR', `PowerShell 退出码 ${r.exitCode}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

async function notifyShow(ctx: HandlerCtx): Promise<unknown> {
  const title = ctx.req.args.title ?? 'DeskMinis';
  const body = ctx.req.args.body ?? '';
  await runChecked(ctx, NOTIFY_PS, { title, body });
  return { shown: true };
}

async function clipboardGet(ctx: HandlerCtx): Promise<unknown> {
  const text = await runChecked(ctx, CLIPBOARD_GET_PS);
  if (text.length > CLIPBOARD_MAX_TEXT) return { text: text.slice(0, CLIPBOARD_MAX_TEXT), truncated: true };
  return { text, truncated: false };
}

async function clipboardSet(ctx: HandlerCtx): Promise<unknown> {
  const text = ctx.req.args.text ?? ctx.req.stdin;
  if (text === undefined) throw new BridgeError('INVALID_ARGS', '缺少 --text 或 --stdin 文本');
  await runChecked(ctx, CLIPBOARD_SET_PS, { text });
  return { length: text.length };
}

async function openTarget(ctx: HandlerCtx): Promise<unknown> {
  const target = ctx.req.args.target ?? '';
  if (!target) throw new BridgeError('INVALID_ARGS', '缺少 --target（http(s) 网址或本机文件/目录路径）');
  if (!/^https?:\/\//i.test(target) && !existsSync(target)) {
    throw new BridgeError('INVALID_ARGS', `目标不存在且不是 http(s) 网址: ${target}`);
  }
  await runChecked(ctx, OPEN_PS, { target });
  return { opened: target };
}

async function speakSay(ctx: HandlerCtx): Promise<unknown> {
  const text = ctx.req.args.text ?? ctx.req.stdin;
  if (text === undefined || text === '') throw new BridgeError('INVALID_ARGS', '缺少 --text 或 --stdin 文本');
  let rate: number | undefined;
  if (ctx.req.args.rate !== undefined) {
    const n = Number(ctx.req.args.rate);
    if (!Number.isInteger(n) || n < -10 || n > 10) throw new BridgeError('INVALID_ARGS', '--rate 必须是 -10..10 的整数');
    rate = n;
  }
  await runChecked(ctx, SPEAK_PS, { text, rate }, 120000); // 播报时长随文本增长
  return { spoken: true, chars: text.length };
}

async function screenshotCapture(ctx: HandlerCtx): Promise<unknown> {
  const dir = ctx.deps.paths.sessionBucket(ctx.req.sessionId, 'attachments');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  const out = await runChecked(ctx, SCREENSHOT_PS, { path });
  const m = /(\d+)x(\d+)/.exec(out);
  const bytes = statSync(path).size; // 脚本报 0 但文件没落盘：这里抛错 → INTERNAL_ERROR，诚实暴露
  return { path, width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0, bytes };
}

async function deviceInfo(ctx: HandlerCtx): Promise<unknown> {
  const out = await runChecked(ctx, DEVICE_PS);
  try {
    return JSON.parse(out.trim());
  } catch {
    throw new BridgeError('EXEC_ERROR', `设备信息输出不是合法 JSON: ${out.slice(0, 200)}`);
  }
}

interface BridgeDef {
  kind: BridgePermissionKind;
  toolTitle: string; // 权限卡标题（用户语言）；detail 固定为能力串 "<tool> <action>"（架构决策 3）
  run: (ctx: HandlerCtx) => Promise<unknown>;
}

const BRIDGES: Record<string, BridgeDef> = {
  'windows-notify show': { kind: 'bridge-notify', toolTitle: '显示 Windows 通知', run: notifyShow },
  'windows-clipboard get': { kind: 'bridge-clipboard-read', toolTitle: '读取剪贴板内容', run: clipboardGet },
  'windows-clipboard set': { kind: 'bridge-clipboard-write', toolTitle: '写入剪贴板', run: clipboardSet },
  'windows-open open': { kind: 'bridge-open', toolTitle: '打开网址或文件', run: openTarget },
  'windows-speak say': { kind: 'bridge-speak', toolTitle: '语音播报文本', run: speakSay },
  'windows-screenshot capture': { kind: 'bridge-screenshot', toolTitle: '截取屏幕画面', run: screenshotCapture },
  'windows-device info': { kind: 'bridge-device', toolTitle: '读取系统信息', run: deviceInfo },
};

/** 桥分发器：任何情况 resolve 信封（错误也是 ok:false 信封），绝不 reject——管道那头的 stub 只靠信封定退出码。 */
export function makeBridgeDispatcher(deps: BridgeDeps): (req: BridgeRequest) => Promise<BridgeEnvelope> {
  const runPs = deps.runPs ?? runPowerShell;
  return async (req) => {
    const tool = typeof req?.tool === 'string' ? req.tool : '';
    const action = typeof req?.action === 'string' ? req.action : '';
    const key = `${tool} ${action}`;
    try {
      const bridge = BRIDGES[key];
      if (!bridge) {
        throw new BridgeError('INVALID_ARGS', `未知桥命令: ${key.trim() || '(空)'}（支持 windows-notify/clipboard/open/speak/screenshot/device）`);
      }
      const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : '';
      if (!SESSION_ID_RE.test(sessionId)) {
        throw new BridgeError('INVALID_ARGS', '缺少合法的 MINIS_CHAT_SESSION_ID；桥命令只能在 DeskMinis 会话 shell 中调用');
      }
      const decision = await deps.permissions.check({ kind: bridge.kind, detail: key, sessionId, toolTitle: bridge.toolTitle });
      if (decision === 'deny') {
        throw new BridgeError('PERMISSION_DENIED', `${key} 被用户拒绝（可在 设置-权限 中调整）`);
      }
      const data = await bridge.run({ req, deps, runPs });
      return okEnvelope(tool, action, data);
    } catch (e) {
      if (e instanceof BridgeError) return errEnvelope(tool, action, e.code, e.message);
      return errEnvelope(tool, action, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
    }
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- bridge-handlers`
Expected: 全部 passed（分发 11 + handler 9 + runPowerShell 3 + 真实集成 3）。真实集成 3 例需要交互式 Windows 桌面会话（截屏/剪贴板），与日常 `npm test` 运行环境一致。

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/bridge/handlers.ts deskminis/tests/bridge-handlers.test.ts && git commit -m "feat(m2e): 六桥handler+一次性PowerShell执行器(载荷走stdin JSON零插值)"
```

---

### Task 4: 命名管道桥服务

**Files:**
- Create: `deskminis/src/minisd/bridge/server.ts`
- Create: `deskminis/tests/bridge-util.ts`（测试共享助手，非 .test.ts）
- Test: `deskminis/tests/bridge-server.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `encodeFrame`/`FrameDecoder`；Task 3 的 `BridgeRequest`/`BridgeEnvelope`/`errEnvelope`/`okEnvelope`
- Produces（Task 5/6 依赖，签名以此为准）:
  - `function bridgePipePath(dataRootAbs: string): string`——`'\\\\.\\pipe\\deskminis-' + sha256(resolve(root).toLowerCase()).hex.slice(0,8)`
  - `class BridgeServer { constructor(dispatch: (req: BridgeRequest) => Promise<BridgeEnvelope>); listen(pipePath: string): Promise<void>; close(): Promise<void> }`——每连接：30s 内收一帧 → dispatch → 回一帧信封 → 关连接；畸形 JSON/超长帧→`INVALID_REQUEST` 信封；dispatch 抛错→`INTERNAL_ERROR` 信封；listen 失败（占管等）reject 由调用方降级
  - `function makeBridgeEnv(sessionId: string, pipePath: string | undefined, cliPath: string | undefined, execPath: string): Record<string, string>`——产出 `{MINIS_CHAT_SESSION_ID, MINIS_BRIDGE_PIPE, MINIS_BRIDGE_CLI, MINIS_BRIDGE_NODE}`；桥不可用时 PIPE/CLI 为空串
  - `function resolveBridgeCliPath(): string | undefined`——候选 ① `import.meta.url` 同目录 `bridge-cli.mjs`（vitest/ts 直跑）② 上两级 `src/minisd/bridge-cli.mjs`（electron-vite 产物 `out/main/` 布局），返回首个 existsSync 者

- [ ] **Step 1: 写失败测试**

`deskminis/tests/bridge-util.ts`（共享助手，先写它——本 Task 与 Task 5/6 的测试都 import）：

```typescript
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame, FrameDecoder } from '../src/minisd/bridge/frame';
import { BridgeServer, bridgePipePath } from '../src/minisd/bridge/server';
import { okEnvelope, type BridgeEnvelope } from '../src/minisd/bridge/handlers';

/** 一次性管道客户端：发一帧请求，等一帧信封响应（与 stub 同协议的最小实现）。 */
export function pipeRequest(pipePath: string, req: unknown, timeoutMs = 15000): Promise<BridgeEnvelope> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(pipePath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('管道响应超时')); }, timeoutMs);
    socket.on('error', e => { clearTimeout(timer); reject(e); });
    socket.on('connect', () => socket.write(encodeFrame(req)));
    socket.on('data', (chunk: Buffer) => {
      let frames: Buffer[];
      try { frames = decoder.push(chunk); } catch (e) { clearTimeout(timer); socket.destroy(); reject(e); return; }
      if (frames.length === 0) return;
      clearTimeout(timer);
      socket.end();
      resolvePromise(JSON.parse(frames[0].toString('utf8')) as BridgeEnvelope);
    });
  });
}

export function uniquePipePath(): string {
  return bridgePipePath(mkdtempSync(join(tmpdir(), 'dm-pipe-')));
}

/** echo 服务：把请求原样塞进 data.echo 返回（验证线协议保真度）。 */
export async function startEchoServer(): Promise<{ pipePath: string; close: () => Promise<void> }> {
  const pipePath = uniquePipePath();
  const server = new BridgeServer(async req => okEnvelope(req.tool, req.action, { echo: req }));
  await server.listen(pipePath);
  return { pipePath, close: () => server.close() };
}
```

`deskminis/tests/bridge-server.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeServer, bridgePipePath, makeBridgeEnv, resolveBridgeCliPath } from '../src/minisd/bridge/server';
import { encodeFrame, MAX_FRAME_BYTES } from '../src/minisd/bridge/frame';
import { okEnvelope, errEnvelope, type BridgeEnvelope } from '../src/minisd/bridge/handlers';
import { pipeRequest, uniquePipePath, startEchoServer } from './bridge-util';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe('bridgePipePath', () => {
  it('同名确定性 + 不同数据根不同管道', () => {
    const a = bridgePipePath('C:\\Data\\A');
    expect(a).toBe(bridgePipePath('C:\\Data\\A'));
    expect(a).toMatch(/^\\\\\.\\pipe\\deskminis-[0-9a-f]{8}$/);
    expect(a).not.toBe(bridgePipePath('C:\\Data\\B'));
  });

  it('大小写不敏感（Windows 路径语义）', () => {
    expect(bridgePipePath('C:\\Data\\A')).toBe(bridgePipePath('c:\\data\\a'));
  });
});

describe('BridgeServer', () => {
  it('echo 往返：args/stdin/sessionId 全保真', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const env = await pipeRequest(pipePath, {
      tool: 'windows-notify', action: 'show',
      args: { title: '标题①' }, sessionId: 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789', stdin: '多行\n载荷',
    });
    expect(env.ok).toBe(true);
    const echo = (env.data as { echo: Record<string, unknown> }).echo;
    expect(echo.tool).toBe('windows-notify');
    expect((echo.args as Record<string, string>).title).toBe('标题①');
    expect(echo.stdin).toBe('多行\n载荷');
  });

  it('半包请求：分两次写也正常应答', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const wire = encodeFrame({ tool: 't', action: 'a', args: {}, sessionId: 's' });
    const env = await new Promise<BridgeEnvelope>((resolvePromise, reject) => {
      const socket = net.connect(pipePath);
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write(wire.subarray(0, 3), () => {
          setTimeout(() => socket.write(wire.subarray(3)), 50);
        });
      });
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          socket.end();
          resolvePromise(JSON.parse(buf.subarray(4).toString('utf8')) as BridgeEnvelope);
        }
      });
    });
    expect(env.ok).toBe(true);
  });

  it('请求帧不是合法 JSON → INVALID_REQUEST 信封', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const bad = Buffer.concat([Buffer.alloc(4), Buffer.from('not-json', 'utf8')]);
    bad.writeUInt32BE(8, 0);
    const env = await new Promise<BridgeEnvelope>((resolvePromise, reject) => {
      const socket = net.connect(pipePath);
      socket.on('error', reject);
      socket.on('connect', () => socket.write(bad));
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          socket.end();
          resolvePromise(JSON.parse(buf.subarray(4).toString('utf8')) as BridgeEnvelope);
        }
      });
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_REQUEST');
  });

  it('长度头超上限 → INVALID_REQUEST 且连接关闭', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const env = await new Promise<BridgeEnvelope>((resolvePromise, reject) => {
      const socket = net.connect(pipePath);
      socket.on('error', reject);
      socket.on('connect', () => socket.write(evil));
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          resolvePromise(JSON.parse(buf.subarray(4).toString('utf8')) as BridgeEnvelope);
        }
      });
      socket.on('close', () => resolvePromise({ ok: false, tool: '', action: '', error: { code: 'CLOSED', message: '' }, timestamp: 0 }));
    });
    expect(env.ok).toBe(false);
    expect(env.error?.code === 'INVALID_REQUEST' || env.error?.code === 'CLOSED').toBe(true);
  });

  it('dispatch 抛非 BridgeError → INTERNAL_REQUEST 级兜底 INTERNAL_ERROR 信封', async () => {
    const pipePath = uniquePipePath();
    const server = new BridgeServer(async () => { throw new Error('炸了'); });
    await server.listen(pipePath);
    cleanups.push(() => server.close());
    const env = await pipeRequest(pipePath, { tool: 't', action: 'a', args: {}, sessionId: 's' });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INTERNAL_ERROR');
    expect(env.error?.message).toContain('炸了');
  });

  it('同管道二次 listen → reject（调用方据此降级）', async () => {
    const pipePath = uniquePipePath();
    const s1 = new BridgeServer(async req => okEnvelope(req.tool, req.action, null));
    await s1.listen(pipePath);
    cleanups.push(() => s1.close());
    const s2 = new BridgeServer(async req => okEnvelope(req.tool, req.action, null));
    await expect(s2.listen(pipePath)).rejects.toThrow();
  });

  it('close 后新连接被拒', async () => {
    const { pipePath, close } = await startEchoServer();
    await close();
    await expect(pipeRequest(pipePath, { tool: 't', action: 'a', args: {}, sessionId: 's' }, 3000)).rejects.toThrow();
  });
});

describe('makeBridgeEnv', () => {
  it('桥可用：四个变量齐全', () => {
    const env = makeBridgeEnv('S1', '\\\\.\\pipe\\deskminis-abcdef01', 'C:\\app\\bridge-cli.mjs', 'C:\\electron.exe');
    expect(env).toEqual({
      MINIS_CHAT_SESSION_ID: 'S1',
      MINIS_BRIDGE_PIPE: '\\\\.\\pipe\\deskminis-abcdef01',
      MINIS_BRIDGE_CLI: 'C:\\app\\bridge-cli.mjs',
      MINIS_BRIDGE_NODE: 'C:\\electron.exe',
    });
  });

  it('桥不可用：PIPE/CLI 为空串（stub 读到空串按不可用报错）', () => {
    const env = makeBridgeEnv('S1', undefined, undefined, 'C:\\electron.exe');
    expect(env.MINIS_BRIDGE_PIPE).toBe('');
    expect(env.MINIS_BRIDGE_CLI).toBe('');
    expect(env.MINIS_CHAT_SESSION_ID).toBe('S1');
  });
});

describe('resolveBridgeCliPath', () => {
  it('仓库布局下解析到存在的 bridge-cli.mjs', () => {
    const p = resolveBridgeCliPath();
    expect(p).toBeTruthy();
    expect(p!).toMatch(/bridge-cli\.mjs$/);
  });
});
```

注意：`resolveBridgeCliPath` 的测试在本 Task 只会因"文件不存在"而失败——它指向的 `bridge-cli.mjs` 是 Task 6 才创建的文件。因此本 Task 的 Step 3 需要同时落一个**占位但可运行**的 `deskminis/src/minisd/bridge-cli.mjs`（仅一行导出空对象的合法 JS：`export {};`，Task 6 再整体替换为完整 stub）。这不是功能占位，是让路径解析测试在本里程碑内诚实通过的临时文件，Task 6 Step 3 将其完整重写。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- bridge-server`
Expected: FAIL（模块 `../src/minisd/bridge/server` 不存在）

- [ ] **Step 3: 实现**

`deskminis/src/minisd/bridge/server.ts`:

```typescript
import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFrame, FrameDecoder } from './frame';
import { errEnvelope, type BridgeEnvelope, type BridgeRequest } from './handlers';

/** 管道名：数据根哈希防多实例冲突（架构决策 8）。小写归一 = Windows 路径大小写不敏感语义。 */
export function bridgePipePath(dataRootAbs: string): string {
  const h = createHash('sha256').update(resolve(dataRootAbs).toLowerCase()).digest('hex').slice(0, 8);
  return '\\\\.\\pipe\\deskminis-' + h;
}

/** 会话 shell 的桥环境变量（模型调桥的全部上下文；桥不可用时 PIPE/CLI 为空串，stub 会给出明确报错）。 */
export function makeBridgeEnv(sessionId: string, pipePath: string | undefined, cliPath: string | undefined, execPath: string): Record<string, string> {
  return {
    MINIS_CHAT_SESSION_ID: sessionId,
    MINIS_BRIDGE_PIPE: pipePath ?? '',
    MINIS_BRIDGE_CLI: cliPath ?? '',
    MINIS_BRIDGE_NODE: execPath,
  };
}

/** 定位 bridge-cli.mjs：① vitest/ts 直跑时在源目录同位；② electron-vite 产物在 out/main/，回溯到 src 布局。
 *  M4 打包为 SEA exe 后此函数整体退役（届时 stub 进安装目录/PATH）。 */
export function resolveBridgeCliPath(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(here, 'bridge-cli.mjs'),
    resolve(here, '..', '..', 'src', 'minisd', 'bridge-cli.mjs'),
  ];
  return candidates.find(p => existsSync(p));
}

const READ_TIMEOUT_MS = 30000;

/** 命名管道桥服务：每连接一帧请求 → dispatch → 一帧信封 → 关（one-shot，免粘包/复用歧义）。 */
export class BridgeServer {
  private server: Server | undefined;
  private sockets = new Set<Socket>();

  constructor(private dispatch: (req: BridgeRequest) => Promise<BridgeEnvelope>) {}

  listen(pipePath: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const server = createServer(socket => this.onConnection(socket));
      server.on('error', reject); // 占管(EADDRINUSE)等：reject 给装配层降级
      server.listen(pipePath, () => { this.server = server; resolvePromise(); });
    });
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => { /* 客户端中断：close 事件负责清理 */ });
    const decoder = new FrameDecoder();
    let answered = false;
    const timer = setTimeout(() => socket.destroy(), READ_TIMEOUT_MS);
    socket.on('data', async (chunk: Buffer) => {
      if (answered) return; // one-shot：首帧之后的字节一律忽略
      let frames: Buffer[];
      try {
        frames = decoder.push(chunk);
      } catch (e) {
        answered = true;
        clearTimeout(timer);
        socket.end(encodeFrame(errEnvelope('', '', 'INVALID_REQUEST', (e as Error).message)));
        return;
      }
      if (frames.length === 0) return;
      answered = true;
      clearTimeout(timer);
      const respond = (env: BridgeEnvelope) => socket.end(encodeFrame(env));
      let req: BridgeRequest;
      try {
        req = JSON.parse(frames[0].toString('utf8')) as BridgeRequest;
      } catch {
        respond(errEnvelope('', '', 'INVALID_REQUEST', '请求帧不是合法 JSON'));
        return;
      }
      try {
        respond(await this.dispatch(req));
      } catch (e) {
        // dispatch 正常不该抛（分发器内部全兜成信封）；这里是最后防线
        respond(errEnvelope(req?.tool ?? '', req?.action ?? '', 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>(res => server.close(() => res()));
  }
}
```

`deskminis/src/minisd/bridge-cli.mjs`（本 Task 内的临时单行文件，Task 6 Step 3 完整重写）：

```javascript
export {};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- bridge-server`
Expected: 全部 passed（bridgePipePath 2 + BridgeServer 7 + makeBridgeEnv 2 + resolveBridgeCliPath 1）

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/bridge/server.ts deskminis/src/minisd/bridge-cli.mjs deskminis/tests/bridge-util.ts deskminis/tests/bridge-server.test.ts && git commit -m "feat(m2e): 命名管道桥服务(one-shot帧+占管降级+桥环境变量构造)"
```

---

### Task 5: minisd 装配、shell 环境注入与系统提示

**Files:**
- Modify: `deskminis/src/minisd/tools/shell.ts`（PersistentShell/ShellManager 支持 env，makeShellTool 加 envFor 参数）
- Modify: `deskminis/src/minisd/index.ts`（装配 BridgeServer、注入桥环境、SYSTEM_PROMPT 加桥段落、返回 bridgePipe）
- Test: `deskminis/tests/bridge-minisd.test.ts`（新）
- Test: `deskminis/tests/shell.test.ts`（追加一个用例）

**Interfaces:**
- Consumes: Task 4 的 `BridgeServer`/`bridgePipePath`/`makeBridgeEnv`/`resolveBridgeCliPath`；Task 3 的 `makeBridgeDispatcher`；M1+M2b+M2a+M2c 全部装配件（index.ts 增量清单必须原样保留这些既有能力）
- Produces:
  - `shell.ts`: `class PersistentShell { constructor(cwd: string, env?: Record<string, string>) }`；`ShellManager.getShell(sessionId: string, cwd: string, env?: Record<string, string>)`、`ShellManager.run(sessionId, cwd, command, timeoutMs?, env?)`；`function makeShellTool(manager: ShellManager, envFor?: (ctx: ToolContext) => Record<string, string>): ToolExecutor`——env 在 shell **首次创建时**捕获（长驻进程环境无法在出生后修改）
  - `index.ts`: `export const SYSTEM_PROMPT`（原私有常量改为导出并追加桥段落）；`startMinisd` 返回值加 `bridgePipe: string | undefined`；桥 listen 失败仅 `console.warn` 降级不拖垮启动
  - 系统提示中的桥段落（渐进披露：一段话说清存在与调用法 + `--help` 按需详读，不内嵌任何桥的参数文档）：
    `本机提供六个 Windows 能力桥，在 shell 中调用：& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> [参数]（若系统装有 Node.js，node "$env:MINIS_BRIDGE_CLI" ... 亦可）。工具：windows-notify（弹系统通知）、windows-clipboard（读/写剪贴板）、windows-open（用默认程序打开网址或文件）、windows-speak（语音播报文本）、windows-screenshot（截屏保存到会话附件目录）、windows-device（读取系统信息）。需要某个工具的详细参数时运行 & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> --help 查看；剪贴板读取与截屏等隐私敏感操作会向用户请求确认。`

- [ ] **Step 1: 写失败测试**

`deskminis/tests/bridge-minisd.test.ts`（新文件）：

```typescript
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMinisd, SYSTEM_PROMPT } from '../src/minisd/index';
import { bridgePipePath } from '../src/minisd/bridge/server';
import { pipeRequest } from './bridge-util';

beforeAll(() => {
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
});

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-minisd-br-'));
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return { ...srv, dataDir };
}

function rpcClient(port: number, authToken: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${authToken}`);
  let idc = 0;
  const pending = new Map<number, (v: never) => void>();
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg as never); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<{ result?: never; error?: { message: string } }> {
    const id = ++idc;
    return new Promise(res => { pending.set(id, res as never); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

describe('minisd 桥装配', () => {
  it('返回值带 bridgePipe 且与数据根派生一致；真管道可调 windows-device info（bypass 不问权限）', async () => {
    const { bridgePipe, dataDir } = await boot();
    expect(bridgePipe).toBe(bridgePipePath(dataDir));
    const env = await pipeRequest(bridgePipe!, {
      tool: 'windows-device', action: 'info', args: {},
      sessionId: 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789',
    });
    expect(env.ok).toBe(true);
    expect((env.data as Record<string, unknown>).computerName).toBe(process.env.COMPUTERNAME);
  }, 30000);

  it('权限定域端到端：管道调 clipboard get → RPC 收到 permission.request(kind=bridge-clipboard-read) → allow-session → 第二次不再问', async () => {
    const { port, authToken, bridgePipe } = await boot();
    const c = rpcClient(port, authToken);
    await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result as unknown as { id: string };

    const first = await pipeRequest(bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: s.id });
    // 第一次调用触发询问：先等广播到达再应答
    for (let i = 0; i < 50 && !c.notifications.some(n => n.method === 'permission.request'); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    const permReq = c.notifications.find(n => n.method === 'permission.request');
    expect(permReq).toBeTruthy();
    const reqBody = permReq!.params.req as { kind: string; detail: string; sessionId: string; toolTitle: string };
    expect(reqBody.kind).toBe('bridge-clipboard-read');
    expect(reqBody.detail).toBe('windows-clipboard get');
    expect(reqBody.sessionId).toBe(s.id);
    await c.call('permission.respond', { requestId: permReq!.params.requestId, decision: 'allow-session' });
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    expect(typeof (firstResult.data as { text: string }).text).toBe('string');

    const nBefore = c.notifications.filter(n => n.method === 'permission.request').length;
    const second = await pipeRequest(bridgePipe!, { tool: 'windows-clipboard', action: 'get', args: {}, sessionId: s.id });
    expect(second.ok).toBe(true);
    expect(c.notifications.filter(n => n.method === 'permission.request').length).toBe(nBefore); // 会话记忆生效
    c.close();
  }, 30000);

  it('同数据根管道被占：minisd 正常启动，bridgePipe 为 undefined（降级不拖垮）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-minisd-occ-'));
    const blocker = net.createServer();
    await new Promise<void>(res => blocker.listen(bridgePipePath(dataDir), res));
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    stop = srv.close;
    expect(srv.bridgePipe).toBeUndefined();
    expect(srv.port).toBeGreaterThan(0);
    await new Promise<void>(res => blocker.close(() => res()));
  });

  it('SYSTEM_PROMPT 含桥渐进披露段落（声明存在+调用法+--help，不含参数级文档）', () => {
    expect(SYSTEM_PROMPT).toContain('windows-notify');
    expect(SYSTEM_PROMPT).toContain('windows-clipboard');
    expect(SYSTEM_PROMPT).toContain('windows-open');
    expect(SYSTEM_PROMPT).toContain('windows-speak');
    expect(SYSTEM_PROMPT).toContain('windows-screenshot');
    expect(SYSTEM_PROMPT).toContain('windows-device');
    expect(SYSTEM_PROMPT).toContain('MINIS_BRIDGE_CLI');
    expect(SYSTEM_PROMPT).toContain('--help');
  });
});
```

`deskminis/tests/shell.test.ts` 文件**末尾的 `describe('shell_execute 工具')` 块内追加**一个用例（紧接既有"权限 deny 时不执行"用例之后，不动既有内容）：

```typescript
  it('envFor 注入的变量在会话 shell 可见（MINIS_* 桥环境）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dm-sh-env-'));
    const paths = new MinisPaths(root); paths.ensureSessionDirs('S1');
    const mgr = new ShellManager();
    const tool = makeShellTool(mgr, ctx => ({ MINIS_CHAT_SESSION_ID: ctx.sessionId, MINIS_BRIDGE_PIPE: '\\\\.\\pipe\\deskminis-deadbeef' }));
    const allowAll = { async check(): Promise<PermissionDecision> { return 'allow'; } };
    const r = await tool.execute({ command: '$env:MINIS_CHAT_SESSION_ID + "|" + $env:MINIS_BRIDGE_PIPE', tool_title: '读桥环境变量' }, { sessionId: 'S1', paths, permissions: allowAll });
    expect(r.success).toBe(true);
    expect(r.output).toContain('S1|\\\\.\\pipe\\deskminis-deadbeef');
    mgr.disposeAll();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- bridge-minisd`
Expected: FAIL（`bridgePipe`/`SYSTEM_PROMPT` 导出不存在）
Run: `cd deskminis && npm test -- shell`
Expected: FAIL（`makeShellTool` 第二参数不存在——新用例类型/行为缺失）

- [ ] **Step 3: 实现 shell.ts 环境注入**

`deskminis/src/minisd/tools/shell.ts`（完整文件，**已对照现状核实**——M2b/M2a/M2c 未改动此文件，现状与 M1 基线一致；本 Task 改动点 4 处：PersistentShell 构造加 env、ensure 的 spawn 加 env、ShellManager.getShell/run 加 env 透传、makeShellTool 加 envFor）：

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolExecutor } from './types';

const MAX_OUTPUT = 100 * 1024;

const DRIVER_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $sp = $line.IndexOf(' ')
  $marker = $line.Substring(0, $sp)
  $cmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line.Substring($sp + 1)))
  $global:LASTEXITCODE = $null
  $ok = $true
  try { . ([scriptblock]::Create($cmd)) 2>&1 | Out-String -Stream -Width 500 | ForEach-Object { [Console]::Out.WriteLine($_) } }
  catch { $ok = $false; [Console]::Out.WriteLine(($_ | Out-String)) }
  $ec = if ($null -ne $global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($ok) { 0 } else { 1 }
  [Console]::Out.WriteLine("__MINIS_DONE_" + $marker + "_EXIT_" + $ec + "__")
}
`;

export class PersistentShell {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  /** env：会话级环境变量（MINIS_CHAT_SESSION_ID/桥管道等），在 shell 首次创建时捕获——长驻进程出生后无法改环境。 */
  constructor(private cwd: string, private env?: Record<string, string>) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    const encoded = Buffer.from(DRIVER_PS, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env ? { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...this.env } : process.env,
    });
    // spawn 失败（cwd 不存在 / ENOENT / EACCES）会在 child 上发 'error'；
    // 没有监听器时该事件会在事件循环里抛出并杀死整个 minisd 进程。常驻一个兜底监听器，
    // 并清掉缓存引用，使下次 ensure() 重建而不是复用僵尸。
    proc.on('error', () => { if (this.proc === proc) this.proc = undefined; });
    // 子进程已退出但 Node 尚未 flush 时向 stdin 写入，会在 stdin 流上异步发 'error'（EPIPE）；
    // 无监听器时它会冒泡到进程级 unhandled 处理并杀死整个 minisd。挂一个吞掉的兜底监听器，
    // 让 runNow 的 close/error 分支正常兜底。（同步 write 抛出仍由下方 try/catch 兜住，纵深防御。）
    proc.stdin.on('error', () => { /* 子进程已退出时写入的异步 EPIPE：吞掉，runNow 的 close/error 处理会兜底 */ });
    proc.stdout.setEncoding('utf8');
    proc.stderr.resume(); // 驱动已 2>&1 并入 stdout；排空真实 stderr 管道避免写满阻塞
    this.proc = proc;
    return proc;
  }

  /** 会话内串行：排队执行。 */
  run(command: string, timeoutMs = 120000): Promise<{ output: string; exitCode: number; durationMs: number }> {
    const next = this.queue.then(() => this.runNow(command, timeoutMs));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private runNow(command: string, timeoutMs: number): Promise<{ output: string; exitCode: number; durationMs: number }> {
    // dispose() 后队列里剩余（或之后新来）的调用不得再 ensure()，否则会复活一个无人跟踪的孤儿进程。
    if (this.disposed) return Promise.resolve({ output: '[shell 已释放]', exitCode: 130, durationMs: 0 });
    const proc = this.ensure();
    const marker = randomUUID().slice(0, 8);
    const sentinel = new RegExp(`__MINIS_DONE_${marker}_EXIT_(-?\\d+)__`);
    const started = Date.now();
    return new Promise(resolve => {
      let out = '';
      const onData = (chunk: string) => {
        out += chunk;
        const m = out.match(sentinel);
        if (m) {
          cleanup();
          const output = out.slice(0, out.indexOf(m[0])).replace(/\r\n/g, '\n').trimEnd();
          resolve({ output, exitCode: Number(m[1]), durationMs: Date.now() - started });
        }
      };
      // 子进程没能答复就死了：也必须 resolve，绝不悬挂、绝不抛。
      const onError = (err: Error) => {
        cleanup();
        resolve({ output: `shell 启动失败: ${err.message}`, exitCode: 127, durationMs: Date.now() - started });
      };
      const onClose = () => {
        cleanup();
        resolve({ output: out.replace(/\r\n/g, '\n') + '\n[shell 进程意外退出]', exitCode: 129, durationMs: Date.now() - started });
      };
      const timer = setTimeout(() => {
        cleanup();
        proc.kill('SIGKILL'); // 死壳，下次 ensure() 重建
        resolve({ output: out.replace(/\r\n/g, '\n') + '\n[命令超时被终止]', exitCode: 124, durationMs: Date.now() - started });
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.off('error', onError);
        proc.off('close', onClose);
      };
      proc.stdout.on('data', onData);
      proc.on('error', onError);
      proc.on('close', onClose);
      try {
        proc.stdin.write(`${marker} ${Buffer.from(command, 'utf8').toString('base64')}\n`);
      } catch (e) {
        // 向已死的子进程写 stdin 会同步抛 EPIPE / ERR_STREAM_DESTROYED。
        cleanup();
        resolve({ output: `shell 启动失败: ${(e as Error).message}`, exitCode: 127, durationMs: Date.now() - started });
      }
    });
  }

  dispose(): void { this.disposed = true; this.proc?.kill('SIGKILL'); this.proc = undefined; }
}

export class ShellManager {
  private shells = new Map<string, PersistentShell>();

  getShell(sessionId: string, cwd: string, env?: Record<string, string>): PersistentShell {
    let s = this.shells.get(sessionId);
    if (!s) { s = new PersistentShell(cwd, env); this.shells.set(sessionId, s); }
    return s;
  }

  run(sessionId: string, cwd: string, command: string, timeoutMs?: number, env?: Record<string, string>): Promise<{ output: string; exitCode: number; durationMs: number }> {
    return this.getShell(sessionId, cwd, env).run(command, timeoutMs);
  }

  disposeAll(): void { for (const s of this.shells.values()) s.dispose(); this.shells.clear(); }
}

/** envFor：按 ToolContext 产出会话级环境变量（M2e 注入 MINIS_CHAT_SESSION_ID/桥三件套）。
 *  注意只在会话 shell 首次创建时生效；envFor 每次调用都求值、由 getShell 决定是否使用。 */
export function makeShellTool(manager: ShellManager, envFor?: (ctx: ToolContext) => Record<string, string>): ToolExecutor {
  return {
    definition: {
      name: 'shell_execute',
      description: '在会话的长驻 PowerShell 中执行命令。cwd 初始为会话工作区，cd 与环境变量跨命令持久。stderr 并入输出。',
      parameters: {
        command: { type: 'string', description: 'PowerShell 命令，可多行' },
        timeout_seconds: { type: 'integer', description: '超时秒数，默认 120' },
        tool_title: { type: 'string', description: '这次调用的 5-10 字用户语言摘要' },
      },
      required: ['command', 'tool_title'],
    },
    async execute(input, ctx) {
      const command = String(input.command);
      const decision = await ctx.permissions.check({ kind: 'shell', detail: command, sessionId: ctx.sessionId, toolTitle: String(input.tool_title) });
      if (decision === 'deny') return { output: '命令被用户拒绝（可在设置-权限中调整）', success: false };
      const cwd = ctx.paths.sessionBucket(ctx.sessionId, 'workspace');
      const timeoutMs = (typeof input.timeout_seconds === 'number' ? input.timeout_seconds : 120) * 1000;
      const r = await manager.run(ctx.sessionId, cwd, command, timeoutMs, envFor?.(ctx));
      let output = r.output;
      if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + `\n[输出超过 100KB 被截断]`;
      return { output: `${output}\n[exit=${r.exitCode}, ${r.durationMs}ms]`, success: r.exitCode === 0 };
    },
  };
}
```

- [ ] **Step 4: 实现 index.ts 装配**

`deskminis/src/minisd/index.ts`（**增量修改**——废弃完整文件写法；现状含 M2b/M2a/M2c 全部能力，逐项增量标注现状锚点）：

> **必须原样保留的 M2b/M2a/M2c 既有能力（禁止全文重写，下列能力一个都不能丢）**：
> - **M2b**：`chat.prompt` 里的链式解析 `modelGroupId` / `group:` / `provider:` 与 `pendingRebind`（降级候选等 turnEnd 才落库）、`modelgroup.*` RPC、`gemini` / `ollama` kind、`catalog.clampThinkingLevel`
> - **M2a**：`memoryInjector` / `contextPolicy` / `compactEngine` / `offloadEngine` / `excludedToolNames`、`chat.sessions.setModelBinding` / `setMemoryEnabled`、`memoryWriteTool` / `memoryGetTool` 注册、`CompactEngine` / `MemoryStore` / `MemoryInjector` / `ContextPolicy` / `OffloadEngine` 装配
> - **M2c**：`skills` 装配段（`SkillStore` / `SkillImporter` / `adoptOrphans`）、`baseWithSkills` 系统提示组合、`toolContext.onFileRead` 钩子、`skills.*` RPC（`list` / `import` / `importStatus` / `setEnabled` / `delete`）、`FakeProvider` 的 `__fail__` 模式
> - 现状 `import` 段含 `rmSync`（M2c `skills.delete` 用）；`SYSTEM_PROMPT` 当前是 `const`（非 export）

**改动清单（a-f，严格增量）：**

**a) import 桥模块**——追加到现有 import 段末尾（现状末尾是 `import { SkillImporter, type ImportKind } from './skills/importer';`）：

```typescript
import { BridgeServer, bridgePipePath, makeBridgeEnv, resolveBridgeCliPath } from './bridge/server';
import { makeBridgeDispatcher } from './bridge/handlers';
```

**b) `SYSTEM_PROMPT` 改为 `export` 并在常量本体追加桥渐进披露段落**——现状是 `const SYSTEM_PROMPT = '...'`（单行字符串，无桥段落）；改为 `export const SYSTEM_PROMPT = '...'` 并在原文本末尾追加桥段落（windows-notify / windows-clipboard / windows-open / windows-speak / windows-screenshot / windows-device 六桥，`& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> [参数]` 调用方式，`--help` 按需详读，隐私敏感项会请求确认）。
> **组合链不变**：现状是 `baseWithSkills = SYSTEM_PROMPT + buildSkillsBlock(...)` → `memoryInjector.build(baseWithSkills, ...)`。桥段落进的是 `SYSTEM_PROMPT` 常量本体，自动流经技能块与记忆注入全链，`chat.prompt` 的组装代码一行不动。Task 5 测试对 `SYSTEM_PROMPT` 导出的断言不受影响。

**c) 装配 `BridgeServer`（带 listen 失败 `console.warn` 降级不拖垮启动）**——插在现状 skills 装配段（`importer.adoptOrphans()` 之后）：

```typescript
// windows-* 桥：命名管道服务。占管（同数据根双实例）等失败只降级，不拖垮 minisd（架构决策 8）。
const bridgeCli = resolveBridgeCliPath();
const pipePath = bridgePipePath(root);
let bridge: BridgeServer | undefined;
let bridgePipe: string | undefined;
try {
  bridge = new BridgeServer(makeBridgeDispatcher({ permissions: gateway, paths }));
  await bridge.listen(pipePath);
  bridgePipe = pipePath;
} catch (e) {
  console.warn('windows-* 桥服务监听失败，桥命令本次运行不可用:', e);
  bridge = undefined;
}
```

> 锚点说明：`gateway` 在现状代码里已声明（`const gateway = new PermissionGatewayImpl(...)`），`paths` / `root` 已在作用域内；桥装配段插在 skills 装配之后、`shells` / `tools` 装配之前均可，`gateway` 必须已声明。

**d) 现状 `tools.register(makeShellTool(shells))` 改为传 `envFor`**：

```typescript
// 现状（M1）：
tools.register(makeShellTool(shells));
// 改为：
tools.register(makeShellTool(shells, ctx => makeBridgeEnv(ctx.sessionId, bridgePipe, bridgeCli, process.execPath)));
```

> `makeBridgeEnv` 产出 `MINIS_CHAT_SESSION_ID` / `MINIS_BRIDGE_PIPE` / `MINIS_BRIDGE_CLI` / `MINIS_BRIDGE_NODE` 四个环境变量；`bridgePipe` 为 `undefined` 时（降级）shell 不注入桥管道变量，桥命令自然会连不上并报退出码 4。

**e) `startMinisd` 返回值加 `bridgePipe: string | undefined`**——现状返回类型是 `Promise<{ port: number; authToken: string; close(): Promise<void> }>`，改为 `Promise<{ port: number; authToken: string; bridgePipe: string | undefined; close(): Promise<void> }>`；返回对象加 `bridgePipe` 字段。

**f) `close` 里加桥关闭**——插进现状 close 的清理序列（`shells.disposeAll()` 之后、`rpc.close()` 之前），其余清理项不动：

```typescript
await bridge?.close();
```

> 现状 close 序列：`controllers.abort()` → `pendingPerms clearTimeout` → `pendingPerms.clear()` → `shells.disposeAll()` → `rpc.close()` → `db.close()`。桥关闭插在 `shells.disposeAll()` 之后。

**测试自查**：新基线下 `boot` 出的 minisd 含上述全部 M2b/M2a/M2c 方法（`modelgroup.*` / `chat.sessions.setMemoryEnabled` / `skills.*` 等）与 M2e 新增的 `bridgePipe` 字段；Task 5 测试断言 `SYSTEM_PROMPT` 导出、`bridgePipe` 字段存在、shell env 注入、桥降级——不与既有能力冲突。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd deskminis && npm test -- bridge-minisd`
Expected: 4 passed
Run: `cd deskminis && npm test -- shell`
Expected: 全部 passed（基线既有 shell 用例 + 新增 env 注入 1 例）
Run: `cd deskminis && npm test`
Expected: 全套回归全绿（rpc/agent-loop 等基线测试不受签名扩展影响——`startMinisd` 返回值只增字段）

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/index.ts deskminis/src/minisd/tools/shell.ts deskminis/tests/bridge-minisd.test.ts deskminis/tests/shell.test.ts && git commit -m "feat(m2e): minisd装配桥服务+shell注入桥环境变量+系统提示渐进披露"
```

---

### Task 6: CLI stub（bridge-cli.mjs）与端到端

**Files:**
- Modify: `deskminis/src/minisd/bridge-cli.mjs`（Task 4 的临时单行文件 → 完整 stub）
- Test: `deskminis/tests/bridge-cli.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `BridgeServer`（测试起 echo/真分发服务）；Task 1 帧协议（stub 内自带最小编解码副本——有意重复，保持 stub 零依赖单文件，SEA 打包友好）；Task 3 的 `makeBridgeDispatcher`（真分发端到端用例）
- Produces:
  - 调用形态：`[node] bridge-cli.mjs <工具> [动作] [--参数 值 ...] [-q|--compact] [--stdin] [--help]`
  - 动作默认值：`windows-notify→show`、`windows-clipboard→get`、`windows-open→open`、`windows-speak→say`、`windows-screenshot→capture`、`windows-device→info`；`windows-open` 的目标允许位置参数（`windows-open https://x` 或 `windows-open open https://x`）
  - 环境契约：必读 `MINIS_CHAT_SESSION_ID`（缺失→退出 3）、`MINIS_BRIDGE_PIPE`（缺失→退出 4）
  - 输出契约：stdout 恒为 JSON 信封（默认 2 空格美化，`-q` 单行紧凑）；本地故障（连不上/超时/环境缺失）也输出信封，`error.code = BRIDGE_UNAVAILABLE` 或 `INVALID_ARGS`；`--help` 输出纯文本说明（非信封）
  - 退出码：0 成功 / 1 一般错误（EXEC_ERROR/INTERNAL_ERROR/INVALID_REQUEST）/ 2 PERMISSION_DENIED / 3 INVALID_ARGS / 4 BRIDGE_UNAVAILABLE
  - 超时：连接 5s；读响应 180s（覆盖 30s 权限询问 + 120s 语音播报 + 余量）

- [ ] **Step 1: 写失败测试**

`deskminis/tests/bridge-cli.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeServer } from '../src/minisd/bridge/server';
import { makeBridgeDispatcher, errEnvelope, type BridgeEnvelope } from '../src/minisd/bridge/handlers';
import { MinisPaths } from '../src/minisd/paths';
import { uniquePipePath, startEchoServer } from './bridge-util';

const CLI = fileURLToPath(new URL('../src/minisd/bridge-cli.mjs', import.meta.url));
const SESSION = 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function runCli(argv: string[], envExtra: NodeJS.ProcessEnv = {}, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(res => {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...envExtra };
    delete env.MINIS_BRIDGE_PIPE;
    delete env.MINIS_CHAT_SESSION_ID;
    Object.assign(env, envExtra);
    const proc = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('close', code => res({ code, stdout, stderr }));
    if (input !== undefined) proc.stdin.write(input);
    proc.stdin.end();
  });
}

const BRIDGE_ENV = (pipePath: string) => ({ MINIS_CHAT_SESSION_ID: SESSION, MINIS_BRIDGE_PIPE: pipePath });

describe('帮助与本地参数校验（无需管道）', () => {
  it('--help：列出六桥与退出码说明，退出 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    for (const t of ['windows-notify', 'windows-clipboard', 'windows-open', 'windows-speak', 'windows-screenshot', 'windows-device']) {
      expect(r.stdout).toContain(t);
    }
    expect(r.stdout).toContain('退出码');
  });

  it('<工具> --help：输出该工具用法，退出 0', async () => {
    const r = await runCli(['windows-notify', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--title');
    expect(r.stdout).toContain('--body');
  });

  it('缺工具名 → 退出 3 + INVALID_ARGS 信封', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(3);
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGS');
  });

  it('未知工具 → 退出 3', async () => {
    const r = await runCli(['windows-nuke', 'boom'], BRIDGE_ENV('\\\\.\\pipe\\deskminis-whatever'));
    expect(r.code).toBe(3);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('INVALID_ARGS');
  });

  it('缺 MINIS_CHAT_SESSION_ID → 退出 3', async () => {
    const r = await runCli(['windows-device', 'info'], { MINIS_BRIDGE_PIPE: '\\\\.\\pipe\\deskminis-whatever' });
    expect(r.code).toBe(3);
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    expect(env.error?.code).toBe('INVALID_ARGS');
    expect(env.error?.message).toContain('MINIS_CHAT_SESSION_ID');
  });

  it('缺 MINIS_BRIDGE_PIPE → 退出 4（BRIDGE_UNAVAILABLE）', async () => {
    const r = await runCli(['windows-device', 'info'], { MINIS_CHAT_SESSION_ID: SESSION });
    expect(r.code).toBe(4);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('BRIDGE_UNAVAILABLE');
  });

  it('管道无服务监听 → 退出 4', async () => {
    const r = await runCli(['windows-device', 'info'], BRIDGE_ENV(uniquePipePath()));
    expect(r.code).toBe(4);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('BRIDGE_UNAVAILABLE');
  });
});

describe('经 echo 服务的线协议行为', () => {
  it('默认美化输出（多行）+ echo 保真（tool/action/args/sessionId/stdin）', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const r = await runCli(['windows-notify', 'show', '--title', '标题①'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n').length).toBeGreaterThan(1); // 美化缩进
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    const echo = (env.data as { echo: Record<string, unknown> }).echo;
    expect(echo.tool).toBe('windows-notify');
    expect(echo.action).toBe('show');
    expect((echo.args as Record<string, string>).title).toBe('标题①');
    expect(echo.sessionId).toBe(SESSION);
    expect(env.timestamp).toBeGreaterThan(1_700_000_000);
  });

  it('-q 单行紧凑输出', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const r = await runCli(['windows-device', 'info', '-q'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).ok).toBe(true);
  });

  it('省略动作用默认动作；windows-open 位置参数当 target', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const r1 = await runCli(['windows-device'], BRIDGE_ENV(pipePath));
    expect((JSON.parse(r1.stdout) as BridgeEnvelope).action).toBe('info');
    const r2 = await runCli(['windows-open', 'https://example.com'], BRIDGE_ENV(pipePath));
    const env2 = JSON.parse(r2.stdout) as BridgeEnvelope;
    expect(env2.action).toBe('open');
    expect(((env2.data as { echo: Record<string, unknown> }).echo.args as Record<string, string>).target).toBe('https://example.com');
  });

  it('--stdin 文本载荷转发到管道', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const r = await runCli(['windows-clipboard', 'set', '--stdin'], BRIDGE_ENV(pipePath), '多行\n文本①');
    expect(r.code).toBe(0);
    const echo = (JSON.parse(r.stdout) as BridgeEnvelope).data as { echo: Record<string, unknown> };
    expect(echo.echo.stdin).toBe('多行\n文本①');
  });

  it('PERMISSION_DENIED 信封 → 退出 2', async () => {
    const pipePath = uniquePipePath();
    const server = new BridgeServer(async req => errEnvelope(req.tool, req.action, 'PERMISSION_DENIED', '被用户拒绝'));
    await server.listen(pipePath);
    cleanups.push(() => server.close());
    const r = await runCli(['windows-clipboard', 'get'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('PERMISSION_DENIED');
  });

  it('EXEC_ERROR 信封 → 退出 1', async () => {
    const pipePath = uniquePipePath();
    const server = new BridgeServer(async req => errEnvelope(req.tool, req.action, 'EXEC_ERROR', 'PowerShell 退出码 1'));
    await server.listen(pipePath);
    cleanups.push(() => server.close());
    const r = await runCli(['windows-notify', '--title', 'x'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(1);
  });
});

describe('真分发端到端（真 PowerShell）', () => {
  async function startRealServer(): Promise<{ pipePath: string; close: () => Promise<void> }> {
    const root = mkdtempSync(join(tmpdir(), 'dm-cli-real-'));
    const paths = new MinisPaths(root);
    paths.ensureSessionDirs(SESSION);
    const dispatch = makeBridgeDispatcher({ permissions: { async check() { return 'allow' as const; } }, paths });
    const pipePath = uniquePipePath();
    const server = new BridgeServer(dispatch);
    await server.listen(pipePath);
    return { pipePath, close: () => server.close() };
  }

  it('windows-device info：stub→管道→真 PowerShell 全链路', async () => {
    const { pipePath, close } = await startRealServer();
    cleanups.push(close);
    const r = await runCli(['windows-device', 'info'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    expect(env.ok).toBe(true);
    expect((env.data as Record<string, unknown>).computerName).toBe(process.env.COMPUTERNAME);
  }, 30000);

  it('windows-clipboard set/get 经 CLI 往返（会短暂改写本机剪贴板）', async () => {
    const { pipePath, close } = await startRealServer();
    cleanups.push(close);
    const set = await runCli(['windows-clipboard', 'set', '--text', 'CLI-端到端①'], BRIDGE_ENV(pipePath));
    expect(set.code).toBe(0);
    expect((JSON.parse(set.stdout) as BridgeEnvelope).data).toEqual({ length: 8 });
    const get = await runCli(['windows-clipboard', 'get'], BRIDGE_ENV(pipePath));
    expect(get.code).toBe(0);
    expect(((JSON.parse(get.stdout) as BridgeEnvelope).data as { text: string }).text).toBe('CLI-端到端①');
  }, 30000);

  it('windows-open 不存在目标：服务端 INVALID_ARGS → 退出 3', async () => {
    const { pipePath, close } = await startRealServer();
    cleanups.push(close);
    const r = await runCli(['windows-open', 'C:\\绝\\对\\不\\存\\在\\x.txt'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(3);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('INVALID_ARGS');
  }, 30000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- bridge-cli`
Expected: FAIL（Task 4 留下的 `bridge-cli.mjs` 只有 `export {};`——无解析/无输出，全部用例失败）

- [ ] **Step 3: 实现完整 stub**

`deskminis/src/minisd/bridge-cli.mjs`（完整重写本文件；零依赖单文件——开发期 `node bridge-cli.mjs` 直跑，M4 用 Node SEA 打成 exe；帧编解码为 Task 1 算法的最小副本，**有意重复**以保持单文件自给）：

```javascript
#!/usr/bin/env node
/**
 * DeskMinis windows-* 桥 CLI（薄 stub）：argv/stdin → 命名管道一帧请求 → minisd → 一帧信封 → stdout。
 * 零依赖单文件（架构决策 1：开发期 node 直跑；M4 用 Node SEA 打成 exe）。
 * 正常调用方式（DeskMinis 会话 shell 内环境变量已注入）：
 *   & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> [动作] [--参数 值 ...]
 */
import net from 'node:net';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5000;
/** 读响应上限 180s：30s 权限询问 + 120s 语音播报 + 余量（架构决策见计划）。 */
const READ_TIMEOUT_MS = 180000;

const EXIT = { OK: 0, ERROR: 1, DENIED: 2, ARGS: 3, UNAVAILABLE: 4 };

const GLOBAL_HELP = `DeskMinis windows-* 桥 CLI（在 DeskMinis 会话 shell 中使用）

用法:
  <工具> [动作] [--参数 值 ...] [-q|--compact] [--stdin]
  实际路径经环境变量传入，通常这样调用:
    & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> ...

工具:
  windows-notify       弹 Windows 系统通知
  windows-clipboard    读/写剪贴板文本
  windows-open         用默认程序打开网址或文件
  windows-speak        语音播报文本（TTS）
  windows-screenshot   截取全部屏幕保存到会话附件目录
  windows-device       读取系统信息（版本/计算机名/内存等）

全局旗标:
  -q, --compact   单行紧凑 JSON 输出（默认两空格美化）
  --stdin         从标准输入读取文本载荷（clipboard set / speak 用；必须显式给出，见架构决策 7）
  --help          本说明；<工具> --help 查看该工具参数

退出码:
  0 成功 / 1 一般错误 / 2 权限被拒绝 / 3 参数错误 / 4 桥服务不可达

输出: stdout 恒为 JSON 信封 { ok, tool, action, data | error, timestamp }
示例:
  & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" windows-notify --title 你好 --body 任务完成
  & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" windows-clipboard get -q
`;

/** 工具规格表：动作集合/默认动作/位置参数槽/工具级帮助。六桥与 minisd 侧 BRIDGES 表一一对应。 */
const TOOLS = {
  'windows-notify': {
    actions: ['show'], defaultAction: 'show', positionalArg: null,
    help: `windows-notify [show] [--title 标题] [--body 正文]

弹 Windows 系统通知（toast）。
  --title   通知标题，默认 "DeskMinis"
  --body    通知正文，默认空`,
  },
  'windows-clipboard': {
    actions: ['get', 'set'], defaultAction: 'get', positionalArg: null,
    help: `windows-clipboard [get]
windows-clipboard set (--text 文本 | --stdin)

读/写剪贴板文本。读取是隐私敏感操作，首次使用会向用户请求确认。
  get       输出 { text, truncated }（超过 1MB 截断）
  set       写入文本，输出 { length }；文本经 --text 或 --stdin 提供`,
  },
  'windows-open': {
    actions: ['open'], defaultAction: 'open', positionalArg: 'target',
    help: `windows-open [open] <目标>

用默认程序打开网址或本机文件/目录。目标也可写作 --target <目标>。
目标必须是 http(s) 网址或已存在的本机路径，否则报 INVALID_ARGS。`,
  },
  'windows-speak': {
    actions: ['say'], defaultAction: 'say', positionalArg: null,
    help: `windows-speak [say] (--text 文本 | --stdin) [--rate -10..10]

语音播报文本（System.Speech TTS）。
  --text    要播报的文本（或用 --stdin 从标准输入读）
  --rate    语速 -10（最慢）..10（最快），默认 0`,
  },
  'windows-screenshot': {
    actions: ['capture'], defaultAction: 'capture', positionalArg: null,
    help: `windows-screenshot [capture]

截取全部屏幕，PNG 保存到会话附件目录，输出 { path, width, height, bytes }。
隐私敏感操作，首次使用会向用户请求确认。`,
  },
  'windows-device': {
    actions: ['info'], defaultAction: 'info', positionalArg: null,
    help: `windows-device [info]

读取系统信息，输出 { osVersion, computerName, userName, cpuCount, totalMemoryMB, psVersion }。
只读操作，不触发权限确认。`,
  },
};

// ---------- 帧编解码：Task 1 算法的最小副本（有意重复，保持 stub 零依赖单文件） ----------

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new Error(`帧体 ${body.length} 超过上限 ${MAX_FRAME_BYTES}`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

class FrameDecoder {
  constructor(maxBytes = MAX_FRAME_BYTES) { this.maxBytes = maxBytes; this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (true) {
      if (this.buf.length < 4) return out;
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxBytes) { this.buf = Buffer.alloc(0); throw new Error(`帧长度 ${len} 超过上限 ${this.maxBytes}`); }
      if (this.buf.length < 4 + len) return out;
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
  }
}

// ---------- argv 解析 ----------

class ArgsError extends Error {}

/** 全局旗标 -q/--compact、--stdin 先于 --参数 识别；其余 --key 必须带值（值不能以 -- 开头）。 */
function parseArgs(argv) {
  const args = {};
  const positional = [];
  let compact = false;
  let useStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-q' || a === '--compact') { compact = true; continue; }
    if (a === '--stdin') { useStdin = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!key) throw new ArgsError('非法参数: --');
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) throw new ArgsError(`参数 --${key} 缺少值`);
      args[key] = val;
      i++;
      continue;
    }
    if (a.startsWith('-') && a !== '-') throw new ArgsError(`未知旗标: ${a}`);
    positional.push(a);
  }
  return { args, positional, compact, useStdin };
}

/** 动作解析：第二位置参数命中动作集则消费之（否则用默认动作）；windows-open 的下一个位置参数进 target 槽。 */
function resolveAction(spec, positional, args) {
  const rest = positional.slice(1);
  let action = spec.defaultAction;
  if (rest.length > 0 && spec.actions.includes(rest[0])) action = rest.shift();
  if (spec.positionalArg && rest.length > 0) {
    if (args[spec.positionalArg] !== undefined) throw new ArgsError(`目标重复：位置参数与 --${spec.positionalArg} 同时给出`);
    args[spec.positionalArg] = rest.shift();
  }
  if (rest.length > 0) throw new ArgsError(`未知动作或多余的位置参数: ${rest.join(' ')}`);
  return action;
}

// ---------- stdin / 管道 ----------

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', reject);
  });
}

/** 一次性管道客户端：连上 → 发已编码帧 → 等一帧信封 → 关。任何失败 reject（调用方归一为 BRIDGE_UNAVAILABLE）。 */
function requestEnvelope(pipePath, wire) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const socket = net.connect(pipePath);
    const decoder = new FrameDecoder();
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(readTimer);
      socket.destroy();
      fn(v);
    };
    const connectTimer = setTimeout(() => done(reject, new Error('连接桥服务超时（5s）')), CONNECT_TIMEOUT_MS);
    let readTimer;
    socket.on('error', e => done(reject, e));
    socket.on('connect', () => {
      clearTimeout(connectTimer);
      readTimer = setTimeout(() => done(reject, new Error(`等待桥服务响应超时（${READ_TIMEOUT_MS / 1000}s）`)), READ_TIMEOUT_MS);
      socket.write(wire);
    });
    socket.on('data', chunk => {
      let frames;
      try { frames = decoder.push(chunk); } catch (e) { done(reject, e); return; }
      if (frames.length === 0) return;
      try { done(resolvePromise, JSON.parse(frames[0].toString('utf8'))); }
      catch { done(reject, new Error('桥服务响应不是合法 JSON')); }
    });
    socket.on('close', () => done(reject, new Error('桥服务未应答即断开连接')));
  });
}

// ---------- 输出与退出码 ----------

function formatEnvelope(env, compact) {
  return compact ? JSON.stringify(env) + '\n' : JSON.stringify(env, null, 2) + '\n';
}

function localEnvelope(tool, action, code, message) {
  return { ok: false, tool, action, error: { code, message }, timestamp: Date.now() / 1000 };
}

/** 信封 error.code → 进程退出码（架构决策 4；语义同时写进 --help 固化）。 */
function exitCodeFor(env) {
  if (env.ok) return EXIT.OK;
  const code = env.error && env.error.code;
  if (code === 'PERMISSION_DENIED') return EXIT.DENIED;
  if (code === 'INVALID_ARGS') return EXIT.ARGS;
  if (code === 'BRIDGE_UNAVAILABLE') return EXIT.UNAVAILABLE;
  return EXIT.ERROR;
}

/** stdout 是管道时 write 异步 flush，直接 process.exit 会截断输出——等写完再退。 */
function writeOutThenExit(text, code) {
  process.stdout.write(text, () => process.exit(code));
}

function fail(tool, action, code, message, exitCode, compact) {
  writeOutThenExit(formatEnvelope(localEnvelope(tool, action, code, message), compact), exitCode);
}

async function main() {
  const argv = process.argv.slice(2);

  // --help 优先于一切：纯文本输出（非信封），全局级或工具级
  if (argv.includes('--help') || argv.includes('-h')) {
    const name = argv.find(a => !a.startsWith('-'));
    const spec = name ? TOOLS[name] : undefined;
    writeOutThenExit((spec ? spec.help : GLOBAL_HELP) + '\n', EXIT.OK);
    return;
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    fail('', '', 'INVALID_ARGS', e.message, EXIT.ARGS, false);
    return;
  }
  const { args, positional, compact, useStdin } = parsed;

  const tool = positional[0];
  if (!tool) {
    fail('', '', 'INVALID_ARGS', '缺少工具名；运行 --help 查看用法', EXIT.ARGS, compact);
    return;
  }
  const spec = TOOLS[tool];
  if (!spec) {
    fail(tool, '', 'INVALID_ARGS', `未知工具: ${tool}（支持 ${Object.keys(TOOLS).join(' / ')}）`, EXIT.ARGS, compact);
    return;
  }
  let action;
  try {
    action = resolveAction(spec, positional, args);
  } catch (e) {
    fail(tool, '', 'INVALID_ARGS', e.message, EXIT.ARGS, compact);
    return;
  }

  // 环境契约：会话 id 缺失属用法错误（3）；管道缺失/空串（桥降级）属服务不可达（4）
  const sessionId = process.env.MINIS_CHAT_SESSION_ID;
  if (!sessionId) {
    fail(tool, action, 'INVALID_ARGS', '缺少环境变量 MINIS_CHAT_SESSION_ID；桥命令只能在 DeskMinis 会话 shell 中调用', EXIT.ARGS, compact);
    return;
  }
  const pipePath = process.env.MINIS_BRIDGE_PIPE;
  if (!pipePath) {
    fail(tool, action, 'BRIDGE_UNAVAILABLE', '缺少环境变量 MINIS_BRIDGE_PIPE：桥服务不可达（minisd 未启动或桥监听失败）', EXIT.UNAVAILABLE, compact);
    return;
  }

  const req = { tool, action, args, sessionId };
  if (useStdin) req.stdin = await readStdin();

  // 先编码再连接：载荷超 16MB 是本地参数问题（退出 3），不应混进"桥不可达"（退出 4）
  let wire;
  try {
    wire = encodeFrame(req);
  } catch (e) {
    fail(tool, action, 'INVALID_ARGS', `载荷过大: ${e.message}`, EXIT.ARGS, compact);
    return;
  }

  let env;
  try {
    env = await requestEnvelope(pipePath, wire);
  } catch (e) {
    fail(tool, action, 'BRIDGE_UNAVAILABLE', `桥服务不可达: ${e.message}`, EXIT.UNAVAILABLE, compact);
    return;
  }
  writeOutThenExit(formatEnvelope(env, compact), exitCodeFor(env));
}

main().catch(e => {
  writeOutThenExit(formatEnvelope(localEnvelope('', '', 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e)), false), EXIT.ERROR);
});
```

实现要点对照（写代码时自查）：
- 测试 spawn 方式是 `process.execPath bridge-cli.mjs`（electron as node，ESM `.mjs` 直跑），因此文件必须是合法 ESM 且只用 node 内建模块
- echo 保真用例断言 `echo.tool/action/args.title/sessionId`：请求体四字段原样发送；`stdin` 仅在 `--stdin` 时带上（`req.stdin = await readStdin()` 不 trim，与断言 `'多行\n文本①'` 精确相等一致）
- 美化输出 `JSON.stringify(env, null, 2)` 多行、`-q` 单行，均 `+ '\n'` 收尾
- 本地故障也出信封：`缺工具名/未知工具/解析失败/缺会话 id/载荷过大 → INVALID_ARGS(3)`；`缺管道变量/连不上/超时/对端早退 → BRIDGE_UNAVAILABLE(4)`——stub 使用者（模型）永远只需解析一种输出形态
- `resolveAction` 里 `windows-open open https://x` 与 `windows-open https://x` 两种形态殊途同归（动作命中动作集先消费，剩余位置参数进 `positionalArg` 槽）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd deskminis && npm test -- bridge-cli`
Expected: 16 passed（帮助与本地参数校验 7 + echo 线协议 6 + 真分发端到端 3）

Run: `cd deskminis && npm test`
Expected: 全套回归全绿（基线 313 + M2e 新增 72 ≈ 385 例：frame 7 / permissions 桥 6 / handlers 26 / server 12 / minisd 桥装配 4 / shell env 1 / cli 16）

- [ ] **Step 5: 应用内手工验收（推荐，验真权限卡链路）**

自动化已覆盖真管道+真 PowerShell，但权限卡 UI 链路只在 minisd 装配测试里断言了 RPC 广播，最后过一遍真人验收：

先退出所有 DeskMinis 实例（同一数据根只能一个进程持有，见项目约束），然后：

```bash
cd deskminis && npm run dev
```

验收清单：
1. 新建会话，输入"用 windows-device 看看这台机器的配置，然后弹个通知告诉我"→ 观察：shell_execute 工具卡里出现桥调用命令行 → Windows 通知弹出 → 回复中含计算机名/内存等信息（device 是 bypass，全程不应弹权限卡）
2. 输入"读一下剪贴板内容"→ 弹出权限卡（标题"读取剪贴板内容"，kind=bridge-clipboard-read）→ 点"仅此次"→ 剪贴板文本出现在回复中
3. 输入"把 测试文本① 写进剪贴板，再读出来"→ 写权限卡（bridge-clipboard-write）→ 选"本会话不再询问"→ 随后读操作仍会弹卡（读/写是不同类目，互不串用）；再读第二次 → 读的权限卡若此前选过"本会话不再询问"则静默
4. 输入"截个屏"→ 权限卡（bridge-screenshot）→ 允许 → 回复给出 PNG 路径；确认 `%APPDATA%\DeskMinis\sessions\<id>\attachments\screenshot-*.png` 存在且能打开
5. 输入"语音说 你好世界"→ 权限卡（bridge-speak）→ 允许 → 听到播报
6. 关闭重开应用 → 新会话里再调 notify → 重新弹卡（会话批准不跨会话持久）

全部通过则 M2e 达成。若步骤 2-5 不弹卡直接执行，回查 Task 2 默认级别表与 Task 3 的 kind 映射；若桥命令报 BRIDGE_UNAVAILABLE，回查 Task 5 的 listen 降级日志（console.warn）与 `MINIS_BRIDGE_PIPE` 注入。

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/bridge-cli.mjs deskminis/tests/bridge-cli.test.ts && git commit -m "feat(m2e): 桥CLI stub(argv/stdin→管道帧→JSON信封,退出码0-4)+端到端测试"
```

---

## M2e 完成定义

- 全套测试绿（`cd deskminis && npm test`，基线 313 + M2e 新增 ≈ 385 例），含真管道、真 PowerShell、真剪贴板/截屏的端到端用例
- 六个 windows-* 桥在应用内手工验收 6 步全过（隐私敏感项弹卡、会话记忆生效、降级不拖垮）
- 交付物：agent 在会话 shell 里可调用 windows-notify/clipboard/open/speak/screenshot/device；统一 JSON 信封 + 退出码 0-4；权限按会话定域；系统提示一段话渐进披露、`--help` 按需详读
- 下一步（不在本里程碑）：M4 把 stub 用 Node SEA 打成 exe 并注册进 PATH（届时 `resolveBridgeCliPath` 退役）；截图字节回传与更多桥按后续子计划