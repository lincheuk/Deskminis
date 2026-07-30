# DeskMinis M2d（右栏完整 UI + 系统托盘）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M1 右栏的三个占位页签填实——终端（xterm.js 实况）、文件（工作区文件树 + 文本预览）、任务（回合进度 / token 用量 / 上下文水位条），并让应用常驻系统托盘（关窗不杀 minisd）。验收：`npm test` 全绿（含新增 minisd 侧 RPC 测试），`npm run dev` 里三面板与托盘行为通过手工验收清单。

**Architecture:** minisd 侧新增两个服务模块——`terminal.ts`（每会话一个**独立**交互式 PowerShell，滚动缓冲 + `terminal.output` 推送）与 `files.ts`（工作区只读文件服务，限仓防穿越），经既有 `RpcServer.broadcast` 推送；渲染进程新增三个面板组件，全部经 JSON-RPC 取数，UI 无私有持久状态。托盘在 Electron 主进程：拦截 `close` 改隐藏，`window-all-closed` 不再退出。设计依据见 `../specs/2026-07-26-deskminis-design.md` §7 与 `../specs/2026-07-26-deskminis-ui-design.md` §4。

**Tech Stack:** 同 M1（TypeScript strict / Electron ≥38 / electron-vite / Vue 3 + Pinia / vitest / ws）+ 新增 `@xterm/xterm`、`@xterm/addon-fit`

## Global Constraints

- 本计划基于「M1 已完成」的代码基线，**假定其他 M2 子计划（记忆/技能/桥/Provider 补全等）均未执行**；若它们已落地，接线锚点需按当时代码微调
- 所有代码在 `deskminis/` 子目录（仓库根是 `C:\Users\24739\Downloads\openminis1\`，`OpenMinis/` 是只读参考克隆，永不修改）
- TypeScript `strict: true`；时间戳一律 epoch 秒（浮点）；破坏性 RPC 方法要求 `confirm:true`（沿用 M1）
- 右栏组件一律引用 `tokens.css` 变量（含 xterm 主题从计算样式读取），**不写死颜色**；暗色三模式（跟随系统/强制浅/强制深）都必须成立
- 文件面板只做**会话工作区**文件树；外部挂载树（设计 §3.5）留给 M2 后续里程碑
- 上下文窗口：M1 无模型能力目录，水位条固定按 200K 估算（代码里留 `TODO(M2b)` 锚点）
- 测试命令统一 `npm test`；单文件 `npm test -- tests/xxx.test.ts`；typecheck `npm run typecheck`
- 前端无组件测试基建：minisd 侧新 RPC 全部配 vitest（沿用 `tests/rpc.test.ts` 模式）；前端组件以 `npm run typecheck` + `npm run build` + 手工验收兜底
- commit 信息用 conventional commits + 中文（如 `feat(m2d): …`）

## 关键设计决策（实现前必读）

### 决策 1：终端面板用独立的交互式 shell 实例，不与 `shell_execute` 共用 `PersistentShell`

M1 的 `PersistentShell`（`src/minisd/tools/shell.ts`）是为工具调用设计的**机器协议**壳：stdin 只认 `marker base64(command)` 行、输出靠哨兵 `__MINIS_DONE_*` 定界、每命令带超时杀壳、会话内串行队列。徒手输入共用它有三个硬伤：

1. **协议会被徒手输入打碎**：驱动里 `$line.IndexOf(' ')` / `FromBase64String` 对任意用户输入直接抛异常，驱动循环崩溃会把 agent 的工具 shell 一起带走；
2. **阻塞语义冲突**：交互命令（如 `npm init` 卡在提问）会占住会话内互斥锁，agent 的 `shell_execute` 全部排队饿死；反之 agent 跑长命令时终端完全无响应；
3. **超时杀壳冲突**：工具调用的 120s 超时杀壳逻辑对交互式使用是灾难（用户煮着咖啡回来壳没了）。

因此终端面板走 `TerminalManager`（每会话一个独立 `powershell.exe`，cwd = 会话工作区），与 `ShellManager` 并存互不感知。代价是两个 shell 的 cwd/环境变量各自演进（用户在终端 `cd` 不影响 agent 的 shell）——这反而是优点：agent 的工作路径不会被用户意外挪动。两实例统一注入 `MINIS_*` 环境变量（设计 §3.3）留作 M2 后续统一处理（M1 工具 shell 也尚未注入）。

### 决策 2：无 PTY 的「哑管道 + 服务端逐字符回显」终端架构

不引入 `node-pty`（原生模块 + ConPTY 封装，Electron ABI 重建链上再叠一个原生依赖，M2d 收益不成比例）。改为：minisd 侧终端驱动脚本逐字符 `[Console]::In.Read()`，**读到即回显并 Flush**——前端 xterm 不做本地回显，用户看到的每个字符（提示符、键入、输出）都来自 minisd。收益：

- 滚动缓冲天然包含「提示符 + 用户输入回显 + 命令输出」的完整实况，`terminal.attach` 重放不丢输入行（若前端本地回显，重放时输入行全丢）；
- 前端极简：keystroke → `terminal.input`，推送 → `term.write`；
- 单一日志源，多窗口/将来远程 UI 看到的终端完全一致。

已知限制（计划末「已知限制」节对用户可见）：无行编辑（方向键历史/Tab 补全不可用）、命令执行期间的键入缓冲到命令结束才回显、宽度固定 500 列不随面板 resize。

### 决策 3：事件推送沿用 M1 的 broadcast + 前端按 sessionId 过滤

`terminal.output` 与 `chat.event` 同模式：minisd 广播给所有连接（连接已有 per-run token 认证），前端面板按 `chat.activeId` 过滤。不做 per-connection 订阅注册——保持 `RpcServer` 零改动，与「UI 无私有状态，一切经 RPC 订阅推送」一致。

### 决策 4：文件面板只做会话工作区树，且 RPC 层收死在仓内

`files.list/read` 复用 `paths.resolveGuestPath` 解析，但**额外**要求解析结果落在会话 workspace 内：`resolveGuestPath` 对绝对宿主路径（`C:\...`）与全局命名空间（`/var/minis/memory`）是放行的（那是 agent 工具 + 权限网关的领域），文件面板一律拒绝。UI 不成为绕过权限网关读任意文件的新通道。外部挂载树 M2 后续再加。

## 文件结构总览

```
deskminis/
  package.json                       修改：dependencies + @xterm/xterm + @xterm/addon-fit；scripts + gen:tray-icon
  scripts/gen-tray-icon.mjs          新增：托盘图标生成器（无依赖手写 32×32 PNG，可复现可审查）
  resources/tray.png                 新增（生成物，进 git）：托盘图标
  src/minisd/terminal.ts             新增：TerminalSession + TerminalManager（交互式终端壳）
  src/minisd/files.ts                新增：FilesService（工作区限仓的 list/read）
  src/minisd/index.ts                修改：注册 terminal.*/files.* 方法、删除会话时销毁终端、close 清理
  src/main/index.ts                  修改：托盘常驻（close→hide、托盘菜单、window-all-closed 不退出）
  src/renderer/src/rpc.ts            修改：RpcClient 增加 off()
  src/renderer/src/App.vue           修改：三页签接线（懒挂载 + v-show 保活）
  src/renderer/src/stores/chat.ts    修改：UiMessage 带 tokenUsage、记 lastStopReason
  src/renderer/src/components/Icon.vue          修改：+ refresh 图标
  src/renderer/src/components/TerminalPanel.vue 新增：xterm.js 终端面板
  src/renderer/src/components/FilesPanel.vue     新增：文件树 + 预览面板
  src/renderer/src/components/FileTreeNode.vue   新增：递归树节点（懒加载）
  src/renderer/src/components/TasksPanel.vue     新增：任务面板
  tests/terminal.test.ts             新增：terminal.* RPC 测试（6 例）
  tests/files-rpc.test.ts            新增：files.* RPC 测试（11 例）
  tests/tray-lifecycle.test.ts       新增：托盘生命周期源文本守卫（5 例）
```

任务依赖：1 → 3；2 → 4；5、6 独立；7 最后。{1,2} 可并行；{3,4,5,6} 可并行——但 3/4/5 都改 `App.vue`，若并行执行需按 3 → 4 → 5 顺序串行合入（每任务都给出版本完整的 App.vue）。

---

### Task 1: 终端会话后端（terminal.* RPC）

**Files:**
- Create: `deskminis/src/minisd/terminal.ts`
- Modify: `deskminis/src/minisd/index.ts`
- Test: `deskminis/tests/terminal.test.ts`

**Interfaces:**
- Consumes: `MinisPaths`（`sessionBucket` / `ensureSessionDirs`）、`RpcServer.broadcast`、`index.ts` 的 `assertSessionId`
- Produces:
  - `class TerminalSession { constructor(cwd: string, emit: (data: string) => void); attach(): string; input(data: string): void; dispose(): void }`——惰性建壳；`attach()` 返回滚动缓冲（上限 200KB，超出从头丢弃）；壳死自动在下次 `attach/input` 重建
  - `class TerminalManager { constructor(paths: MinisPaths, emit: (sessionId: string, data: string) => void); attach(sessionId: string): string; input(sessionId: string, data: string): void; dispose(sessionId: string): void; disposeAll(): void }`——调用方必须已用 `assertSessionId` 校验
  - RPC 方法：
    - `terminal.attach({sessionId})` → `{ scrollback: string }`（惰性建壳；壳输出经 `broadcast('terminal.output', { sessionId, data })` 推送）
    - `terminal.input({sessionId, data})` → `{ ok: true }`（写 stdin；`data` 为原始键入串，Enter = `'\r'`）
  - 副作用接线：`chat.sessions.delete` 同时 `terminals.dispose(sessionId)`；`close()` 调 `terminals.disposeAll()`

- [ ] **Step 1: 写失败测试**

`deskminis/tests/terminal.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  const notifications: { method: string; params: any }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-term-'));
  process.env.DESKMINIS_TEST = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return { ...srv, dataDir };
}

/** 轮询等待条件成立，超时即失败。终端壳冷启动 ~1s，首断言给足 10s。 */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

/** 某会话已收到的 terminal.output 推送拼接。 */
function pushed(c: ReturnType<typeof rpcClient>, sessionId: string): string {
  return c.notifications
    .filter(n => n.method === 'terminal.output' && n.params.sessionId === sessionId)
    .map(n => String(n.params.data))
    .join('');
}

/** 建会话并 attach（惰性建壳）。 */
async function newSessionWithTerminal(c: ReturnType<typeof rpcClient>): Promise<string> {
  const s = (await c.call('chat.sessions.create', {})).result;
  const r = (await c.call('terminal.attach', { sessionId: s.id })).result;
  expect(r.scrollback).toBe(''); // 新壳：提示符尚未到达，缓冲为空
  return s.id as string;
}

describe('terminal.* RPC（交互式终端会话）', () => {
  it('键入的命令有回显、输出与提示符（中文可用）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const sid = await newSessionWithTerminal(c);
    await c.call('terminal.input', { sessionId: sid, data: 'echo 你好M2d\r' });
    await waitFor('命令输出', () => pushed(c, sid).includes('你好M2d'));
    const out = pushed(c, sid);
    expect(out).toContain('PS ');
    // 至少两次：逐字符回显一次 + 命令输出一次（服务端回显是 attach 重放不丢输入行的根基）
    expect(out.split('你好M2d').length - 1).toBeGreaterThanOrEqual(2);
    c.close();
  }, 30000);

  it('滚动缓冲在再次 attach 时重放（提示符 + 输入回显 + 输出完整）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const sid = await newSessionWithTerminal(c);
    await c.call('terminal.input', { sessionId: sid, data: 'echo MARKER_721\r' });
    await waitFor('命令输出', () => pushed(c, sid).includes('MARKER_721'));
    const again = (await c.call('terminal.attach', { sessionId: sid })).result;
    expect(again.scrollback).toContain('echo MARKER_721'); // 输入回显行
    expect(again.scrollback).toContain('PS ');             // 提示符
    c.close();
  }, 30000);

  it('两个会话的终端互不影响（推送带 sessionId）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const a = await newSessionWithTerminal(c);
    const b = await newSessionWithTerminal(c);
    await c.call('terminal.input', { sessionId: a, data: 'echo ONLY_IN_A\r' });
    await waitFor('A 输出', () => pushed(c, a).includes('ONLY_IN_A'));
    expect(pushed(c, b)).not.toContain('ONLY_IN_A');
    const bAttach = (await c.call('terminal.attach', { sessionId: b })).result;
    expect(bAttach.scrollback).not.toContain('ONLY_IN_A');
    c.close();
  }, 30000);

  it('非法 sessionId 被拒', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    expect((await c.call('terminal.attach', { sessionId: '..\\..\\x' })).error).toBeTruthy();
    expect((await c.call('terminal.input', { sessionId: 'not-a-uuid', data: 'x' })).error).toBeTruthy();
    c.close();
  });

  it('删除会话销毁其终端：再 attach 是全新的空滚动缓冲', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const sid = await newSessionWithTerminal(c);
    await c.call('terminal.input', { sessionId: sid, data: 'echo OLD_SHELL\r' });
    await waitFor('旧输出', () => pushed(c, sid).includes('OLD_SHELL'));
    await c.call('chat.sessions.delete', { sessionId: sid, confirm: true });
    const again = (await c.call('terminal.attach', { sessionId: sid })).result;
    expect(again.scrollback).toBe('');
    c.close();
  }, 30000);

  it('cd 跨输入持久（与工具 shell 语义一致）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const sid = await newSessionWithTerminal(c);
    await waitFor('首个提示符', () => pushed(c, sid).includes('PS '));
    await c.call('terminal.input', { sessionId: sid, data: 'cd ..\r' });
    // 新提示符形如「PS <dataDir>\sessions\<id>> 」，只在 cwd 真切到上级目录时出现
    const want = ('PS ' + join(dataDir, 'sessions', sid) + '>').toLowerCase();
    await waitFor('提示符切到上级目录', () => pushed(c, sid).toLowerCase().includes(want));
    c.close();
  }, 30000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/terminal.test.ts`
Expected: FAIL（`terminal.attach` 未知方法 / 模块不存在）

- [ ] **Step 3: 实现 terminal.ts**

`deskminis/src/minisd/terminal.ts`:

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { MinisPaths } from './paths';

/** 滚动缓冲上限：超出后从头丢弃（防止长会话把 minisd 内存吃光；xterm 端另有 5000 行滚动）。 */
const MAX_SCROLLBACK = 200 * 1024;

/**
 * 终端驱动（无 PTY 的哑管道，决策见计划「决策 2」）：
 * - 逐字符 [Console]::In.Read()，读到可打印字符即时回显并 Flush —— 前端 xterm 不做本地回显，
 *   用户看到的每个字符都来自这里，于是滚动缓冲天然包含「提示符 + 输入回显 + 输出」，
 *   terminal.attach 重放不丢输入行。
 * - 行结束：CR 或 LF；CR 后紧跟的 LF 用 Peek 吞掉（Windows 剪贴板 \r\n 不触发两次空执行）。
 * - Backspace(8) 行内删除并回写「退格+空格+退格」；Ctrl+C(3) 清行并给新提示符。
 * - 输出策略与工具 shell 一致：2>&1 并入、Out-String -Stream -Width 500 逐行写。
 * - __minis_ 前缀的驱动内部名：用户命令是 dot-source 进驱动作用域执行的（cd 才能跨输入持久），
 *   普通名字（$buf 等）会被用户输入意外改写。
 */
const TERMINAL_DRIVER_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
function __minis_prompt { [Console]::Out.Write('PS ' + (Get-Location).Path + '> '); [Console]::Out.Flush() }
__minis_prompt
$__minis_buf = ''
while ($true) {
  $__minis_ch = [Console]::In.Read()
  if ($__minis_ch -lt 0) { break }
  if ($__minis_ch -eq 3) { [Console]::Out.Write('^C' + [Environment]::NewLine); $__minis_buf = ''; __minis_prompt; continue }
  if (($__minis_ch -eq 13) -or ($__minis_ch -eq 10)) {
    if (($__minis_ch -eq 13) -and ([Console]::In.Peek() -eq 10)) { [Console]::In.Read() | Out-Null }
    [Console]::Out.Write([Environment]::NewLine)
    $__minis_cmd = $__minis_buf
    $__minis_buf = ''
    if ($__minis_cmd.Trim() -ne '') {
      try { . ([scriptblock]::Create($__minis_cmd)) 2>&1 | Out-String -Stream -Width 500 | ForEach-Object { [Console]::Out.WriteLine($_) } }
      catch { [Console]::Out.WriteLine(($_ | Out-String)) }
    }
    [Console]::Out.Flush()
    __minis_prompt
    continue
  }
  if ($__minis_ch -eq 8) {
    if ($__minis_buf.Length -gt 0) { $__minis_buf = $__minis_buf.Substring(0, $__minis_buf.Length - 1); [Console]::Out.Write([char]8 + ' ' + [char]8); [Console]::Out.Flush() }
    continue
  }
  $__minis_buf += [char]$__minis_ch
  [Console]::Out.Write([char]$__minis_ch)
  [Console]::Out.Flush()
}
`;

export class TerminalSession {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private scrollback = '';
  private disposed = false;

  constructor(private cwd: string, private emit: (data: string) => void) {}

  /** 返回当前滚动缓冲；壳不存在时惰性创建。 */
  attach(): string {
    this.ensure();
    return this.scrollback;
  }

  /** 写 stdin（原始键入串，Enter = '\\r'）。壳死时写入失败不抛：下次 attach/input 经 ensure 重建。 */
  input(data: string): void {
    if (this.disposed || data.length === 0) return;
    const proc = this.ensure();
    try { proc.stdin.write(data); } catch { /* 同步 EPIPE：壳刚死，下次 input/attach 重建 */ }
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    const encoded = Buffer.from(TERMINAL_DRIVER_PS, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // 与 PersistentShell 同因：无监听器的 'error' / stdin 'error' 会冒泡成未捕获异常杀死整个 minisd。
    proc.on('error', () => { if (this.proc === proc) this.proc = undefined; });
    proc.stdin.on('error', () => { /* 壳已死时写入的异步 EPIPE：吞掉，下次 ensure 重建 */ });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onOutput(chunk));
    // 原生命令的真实 stderr 不经驱动 2>&1：并入输出流，用户能在终端看到编译器/工具的错误文本。
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => this.onOutput(chunk));
    this.proc = proc;
    return proc;
  }

  private onOutput(chunk: string): void {
    this.scrollback += chunk;
    if (this.scrollback.length > MAX_SCROLLBACK) this.scrollback = this.scrollback.slice(-MAX_SCROLLBACK);
    this.emit(chunk);
  }

  dispose(): void {
    this.disposed = true;
    this.proc?.kill('SIGKILL');
    this.proc = undefined;
  }
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  constructor(private paths: MinisPaths, private emit: (sessionId: string, data: string) => void) {}

  /** 惰性建壳并返回滚动缓冲。调用方（index.ts）必须已用 assertSessionId 校验 sessionId。 */
  attach(sessionId: string): string {
    this.paths.ensureSessionDirs(sessionId);
    return this.get(sessionId).attach();
  }

  input(sessionId: string, data: string): void {
    if (typeof data !== 'string' || data.length === 0) return;
    this.paths.ensureSessionDirs(sessionId);
    this.get(sessionId).input(data);
  }

  dispose(sessionId: string): void {
    this.sessions.get(sessionId)?.dispose();
    this.sessions.delete(sessionId);
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }

  private get(sessionId: string): TerminalSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new TerminalSession(this.paths.sessionBucket(sessionId, 'workspace'), data => this.emit(sessionId, data));
      this.sessions.set(sessionId, s);
    }
    return s;
  }
}
```

- [ ] **Step 4: 接线 minisd/index.ts（5 处插入，锚点逐字引用现有代码）**

**插入 1（import 区）**：在 `import { runAgentLoop } from './agent/loop';` 一行之后插入：

```typescript
import { TerminalManager } from './terminal';
```

**插入 2（服务装配）**：在 `const shells = new ShellManager();` 一行之后插入：

```typescript
  // 终端面板的交互式 shell 与工具调用的长驻 shell 是两个独立实例（决策：共用会把哨兵协议
  // 暴露给徒手输入、并把用户卡住的交互命令变成 agent 工具调用的阻塞点，详见 M2d 计划决策 1）。
  // emit 闭包引用后赋值的 rpc——与下方 pendingPerms 的 prompt 同一模式，推送只发生在 listen 之后。
  const terminals = new TerminalManager(paths, (sessionId, data) => rpc.broadcast('terminal.output', { sessionId, data }));
```

**插入 3（RPC 方法）**：在 `    'provider.instances.list': () => providers.list(),` 一行之前插入：

```typescript
    'terminal.attach': (p: { sessionId: string }) => ({ scrollback: terminals.attach(assertSessionId(p.sessionId)) }),
    'terminal.input': (p: { sessionId: string; data: string }) => { terminals.input(assertSessionId(p.sessionId), String(p.data ?? '')); return { ok: true }; },
```

**插入 4（删除会话销毁终端）**：在 `      chat.deleteSession(sessionId); return { ok: true };` 一行之前插入：

```typescript
      terminals.dispose(sessionId);
```

**插入 5（关闭清理）**：把 close 里的 `      shells.disposeAll(); await rpc.close(); db.close();` 替换为：

```typescript
      terminals.disposeAll(); shells.disposeAll(); await rpc.close(); db.close();
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd deskminis && npm test -- tests/terminal.test.ts`
Expected: `6 passed`
Run: `cd deskminis && npm test && npm run typecheck`
Expected: 全部通过（136 passed）、typecheck 0 errors

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/terminal.ts deskminis/src/minisd/index.ts deskminis/tests/terminal.test.ts && git commit -m "feat(m2d): minisd 终端会话（独立交互 shell + terminal.attach/input RPC + 滚动缓冲推送）"
```

---

### Task 2: 工作区文件服务（files.* RPC）

**Files:**
- Create: `deskminis/src/minisd/files.ts`
- Modify: `deskminis/src/minisd/index.ts`
- Test: `deskminis/tests/files-rpc.test.ts`

**Interfaces:**
- Consumes: `MinisPaths`（`sessionBucket` / `ensureSessionDirs` / `resolveGuestPath`）、`assertSessionId`
- Produces:
  - `interface FileNode { name: string; path: string; kind: 'dir' | 'file'; size: number; mtime: number }`——`path` 为工作区相对 POSIX 分隔（根层条目即文件名）；`mtime` 为 epoch 秒（浮点）
  - `interface FilePreview { path: string; size: number; content: string; truncated: boolean; binary: boolean }`——`size` 为完整字节数；`content` 超 256KB 截前缀；二进制时为空串
  - `class FilesService { constructor(paths: MinisPaths); list(sessionId: string, dir?: string): FileNode[]; read(sessionId: string, path: string): FilePreview }`——目录在前按名排序；任何解析结果必须落在会话 workspace 内（绝对宿主路径/全局命名空间/穿越一律抛错）
  - RPC 方法：
    - `files.list({sessionId, dir?})` → `FileNode[]`（`dir` 省略 = 工作区根）
    - `files.read({sessionId, path})` → `FilePreview`

- [ ] **Step 1: 写失败测试**

`deskminis/tests/files-rpc.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  const notifications: { method: string; params: any }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push({ method: msg.method, params: msg.params });
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, close: () => ws.close() };
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-files-'));
  process.env.DESKMINIS_TEST = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  stop = srv.close;
  return { ...srv, dataDir };
}

/** 建会话并往其工作区播种文件。 */
async function seed(c: ReturnType<typeof rpcClient>, dataDir: string) {
  const s = (await c.call('chat.sessions.create', {})).result;
  const ws = join(dataDir, 'sessions', s.id, 'workspace');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  writeFileSync(join(ws, 'sub', 'b.txt'), 'inside-sub', 'utf8');
  writeFileSync(join(ws, 'a.txt'), '你好文件', 'utf8');
  writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  writeFileSync(join(ws, 'big.txt'), 'x'.repeat(300 * 1024), 'utf8');
  return { sessionId: s.id as string, ws };
}

describe('files.* RPC（工作区文件树）', () => {
  it('空工作区列根返回空数组', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', {})).result;
    expect((await c.call('files.list', { sessionId: s.id })).result).toEqual([]);
    c.close();
  });

  it('列根：目录在前、按名排序，字段完整（name/path/kind/size/mtime）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.list', { sessionId })).result;
    expect(r.map((n: any) => n.path)).toEqual(['sub', 'a.txt', 'big.txt', 'bin.dat']);
    expect(r[0]).toMatchObject({ name: 'sub', path: 'sub', kind: 'dir', size: 0 });
    expect(r[1]).toMatchObject({ name: 'a.txt', path: 'a.txt', kind: 'file', size: Buffer.byteLength('你好文件') });
    expect(typeof r[1].mtime).toBe('number');
    expect(r[1].mtime).toBeGreaterThan(0);
    c.close();
  });

  it('列子目录：path 为工作区相对 POSIX 形式', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.list', { sessionId, dir: 'sub' })).result;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'b.txt', path: 'sub/b.txt', kind: 'file', size: Buffer.byteLength('inside-sub') });
    c.close();
  });

  it('files.read 读文本全文', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.read', { sessionId, path: 'a.txt' })).result;
    expect(r).toMatchObject({ path: 'a.txt', content: '你好文件', truncated: false, binary: false, size: Buffer.byteLength('你好文件') });
    c.close();
  });

  it('files.read 目标为目录时报错', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    expect((await c.call('files.read', { sessionId, path: 'sub' })).error).toBeTruthy();
    c.close();
  });

  it('二进制文件标记 binary、不返回内容', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.read', { sessionId, path: 'bin.dat' })).result;
    expect(r).toMatchObject({ path: 'bin.dat', binary: true, content: '', size: 3 });
    c.close();
  });

  it('超过 256KB 截断并置 truncated（不整文件读入内存）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = (await c.call('files.read', { sessionId, path: 'big.txt' })).result;
    expect(r.truncated).toBe(true);
    expect(r.binary).toBe(false);
    expect(r.size).toBe(300 * 1024);
    expect(r.content.length).toBe(256 * 1024);
    c.close();
  });

  it('不存在的路径报错', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    expect((await c.call('files.read', { sessionId, path: 'nope.txt' })).error).toBeTruthy();
    expect((await c.call('files.list', { sessionId, dir: 'nope-dir' })).error).toBeTruthy();
    c.close();
  });

  it('拒绝工作区外的绝对宿主路径（面板不是绕过权限网关的任意文件读取通道）', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    const r = await c.call('files.read', { sessionId, path: 'C:\\Windows' });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toContain('工作区');
    expect((await c.call('files.list', { sessionId, dir: 'C:\\Windows' })).error).toBeTruthy();
    c.close();
  });

  it('拒绝穿越与越界 guest 路径', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const { sessionId } = await seed(c, dataDir);
    expect((await c.call('files.list', { sessionId, dir: '..\\..\\..' })).error).toBeTruthy();
    expect((await c.call('files.list', { sessionId, dir: '/var/minis/memory' })).error).toBeTruthy();
    expect((await c.call('files.read', { sessionId, path: '/var/minis/workspace/../../minis.db' })).error).toBeTruthy();
    c.close();
  });

  it('非法 sessionId 被拒', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    expect((await c.call('files.list', { sessionId: '..\\..\\x' })).error).toBeTruthy();
    expect((await c.call('files.read', { sessionId: 'not-a-uuid', path: 'a.txt' })).error).toBeTruthy();
    c.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/files-rpc.test.ts`
Expected: FAIL（`files.list` 未知方法 / 模块不存在）

- [ ] **Step 3: 实现 files.ts**

`deskminis/src/minisd/files.ts`:

```typescript
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { MinisPaths } from './paths';

/** files.read 预览上限（超出截断并置 truncated）。 */
const MAX_PREVIEW = 256 * 1024;
/** 二进制嗅探窗口：前 8KB 含 NUL 即视为不可预览。 */
const SNIFF_BYTES = 8192;

export interface FileNode {
  name: string;          // 条目名（不含路径）
  path: string;          // 工作区相对路径，POSIX 分隔（'sub/b.txt'；根层条目为 'a.txt'）
  kind: 'dir' | 'file';
  size: number;          // 字节；目录为 0
  mtime: number;         // epoch 秒（浮点，全局约束）
}

export interface FilePreview {
  path: string;          // 工作区相对 POSIX 路径
  size: number;          // 完整文件字节数（截断时也回全量大小，供 UI 展示）
  content: string;       // 文本内容（可能只含前缀）；二进制时为空串
  truncated: boolean;    // 因超过 256KB 只读了前缀
  binary: boolean;       // 嗅探为二进制：不可预览
}

/** 归一化后的包含判断（与 tools/files.ts 的 isInsideRoot 同策略：防 <root>\..\.. 前缀欺骗）。 */
function isInside(abs: string, base: string): boolean {
  const rel = relative(resolve(base), resolve(abs));
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

export class FilesService {
  constructor(private paths: MinisPaths) {}

  /**
   * 把 UI 给的目录/文件引用解析为「工作区内」绝对路径。
   * resolveGuestPath 对绝对宿主路径（C:\...）与全局命名空间（/var/minis/memory）是放行的——
   * 那是 agent 工具 + 权限网关的领域；文件面板是工作区树，必须额外收死在仓内（计划决策 4）。
   */
  private resolveInWorkspace(sessionId: string, ref?: string): { abs: string; rel: string } {
    const base = this.paths.sessionBucket(sessionId, 'workspace');
    const abs = this.paths.resolveGuestPath(sessionId, ref ?? '/var/minis/workspace');
    if (!isInside(abs, base)) throw new Error(`文件面板只允许访问会话工作区: ${ref ?? '/'}`);
    const rel = relative(base, abs).split('\\').join('/');
    return { abs, rel };
  }

  /** 列目录一层（懒加载树的单步）。dir 省略 = 工作区根。目录在前、按名称排序。 */
  list(sessionId: string, dir?: string): FileNode[] {
    this.paths.ensureSessionDirs(sessionId);
    const { abs, rel } = this.resolveInWorkspace(sessionId, dir);
    const st = statSync(abs); // ENOENT 原样抛给 RPC 层，前端显示「路径不存在」
    if (!st.isDirectory()) throw new Error(`不是目录: ${rel || '/'}`);
    const entries = readdirSync(abs, { withFileTypes: true });
    const nodes: FileNode[] = entries.map(e => {
      const isDir = e.isDirectory();
      let size = 0; let mtime = 0;
      try {
        const cs = statSync(resolve(abs, e.name));
        size = isDir ? 0 : cs.size;
        mtime = cs.mtimeMs / 1000;
      } catch { /* 列目录瞬间被删的条目：按 0 返回，不让整层失败 */ }
      return { name: e.name, path: rel ? `${rel}/${e.name}` : e.name, kind: isDir ? 'dir' as const : 'file' as const, size, mtime };
    });
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return nodes;
  }

  /** 读文本预览：只读前 256KB+1 字节（不整文件入内存）；嗅探含 NUL 视为二进制不返回内容。 */
  read(sessionId: string, path: string): FilePreview {
    this.paths.ensureSessionDirs(sessionId);
    const { abs, rel } = this.resolveInWorkspace(sessionId, path);
    const st = statSync(abs);
    if (st.isDirectory()) throw new Error(`不能预览目录: ${rel}`);
    const fd = openSync(abs, 'r');
    let buf: Buffer;
    try {
      const head = Buffer.alloc(Math.min(st.size, MAX_PREVIEW + 1));
      const n = readSync(fd, head, 0, head.length, 0);
      buf = head.subarray(0, n);
    } finally { closeSync(fd); }
    const sniffLen = Math.min(buf.length, SNIFF_BYTES);
    for (let i = 0; i < sniffLen; i++) {
      if (buf[i] === 0) return { path: rel, size: st.size, content: '', truncated: false, binary: true };
    }
    const truncated = st.size > MAX_PREVIEW;
    const content = buf.subarray(0, truncated ? MAX_PREVIEW : buf.length).toString('utf8');
    return { path: rel, size: st.size, content, truncated, binary: false };
  }
}
```

- [ ] **Step 4: 接线 minisd/index.ts（3 处插入，锚点逐字引用现有代码）**

**插入 1（import 区）**：在 `import { TerminalManager } from './terminal';` 一行之后插入：

```typescript
import { FilesService } from './files';
```

**插入 2（服务装配）**：在 `  const terminals = new TerminalManager(paths, (sessionId, data) => rpc.broadcast('terminal.output', { sessionId, data }));` 一行之后插入：

```typescript
  const filesSvc = new FilesService(paths);
```

**插入 3（RPC 方法）**：在 `    'provider.instances.list': () => providers.list(),` 一行之前插入：

```typescript
    'files.list': (p: { sessionId: string; dir?: string }) =>
      filesSvc.list(assertSessionId(p.sessionId), typeof p.dir === 'string' && p.dir !== '' ? p.dir : undefined),
    'files.read': (p: { sessionId: string; path: string }) => {
      if (typeof p.path !== 'string' || p.path === '') throw new Error('files.read 需要 path');
      return filesSvc.read(assertSessionId(p.sessionId), p.path);
    },
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `cd deskminis && npm test -- tests/files-rpc.test.ts`
Expected: `11 passed`
Run: `cd deskminis && npm test && npm run typecheck`
Expected: 全部通过（147 passed）、typecheck 0 errors

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/minisd/files.ts deskminis/src/minisd/index.ts deskminis/tests/files-rpc.test.ts && git commit -m "feat(m2d): minisd 工作区文件服务（files.list/read RPC + 限仓防穿越 + 256KB 截断与二进制嗅探）"
```

---

### Task 3: 终端面板（xterm.js 接入）

**Files:**
- Create: `deskminis/src/renderer/src/components/TerminalPanel.vue`
- Modify: `deskminis/package.json`（新增依赖）、`deskminis/src/renderer/src/rpc.ts`（+ `off`）、`deskminis/src/renderer/src/App.vue`（接线终端页签）
- Manual verify: 见 Step 5

**Interfaces:**
- Consumes: `terminal.attach` / `terminal.input` / `terminal.output` 推送（Task 1）、`useChat().activeId`、`tokens.css` 变量
- Produces:
  - `RpcClient.off(method: string, h: Handler): void`（组件卸载时摘订阅；现有 `on` 不变）
  - `TerminalPanel.vue`：无 props；挂载时 attach 当前会话、键入直送 `terminal.input`、推送写入 xterm；`activeId` 变化时 reset 并重新 attach；主题从 `getComputedStyle` 读 tokens，随明暗切换重读
  - `App.vue`：右栏页签改为懒挂载 + `v-show` 保活（`visited` 记录首切）

- [ ] **Step 1: 安装 xterm 依赖**

```bash
cd "C:\Users\24739\Downloads\openminis1\deskminis" && npm i @xterm/xterm @xterm/addon-fit
```

Run: `cd deskminis && npm ls @xterm/xterm @xterm/addon-fit`
Expected: 两个包均在 dependencies 中（版本号由 npm 解析，如 `@xterm/xterm@5.5.x`、`@xterm/addon-fit@0.10.x`）

- [ ] **Step 2: RpcClient 增加 off（完整替换 rpc.ts）**

`deskminis/src/renderer/src/rpc.ts`:

```typescript
type Handler = (params: any) => void;

export class RpcClient {
  private ws: WebSocket | undefined;
  private idc = 0;
  private pending = new Map<number, (v: any) => void>();
  private handlers = new Map<string, Set<Handler>>();

  async connect(): Promise<void> {
    const bridge = (window as any).deskminis;
    // minisd 要求 per-run token（否则任意网页都能连上本地端口驱动 agent）。
    // 老的 minisdPort() 只在 minisdInfo 不存在时兜底。
    let port: number;
    let token: string | undefined;
    if (typeof bridge?.minisdInfo === 'function') {
      const info = await bridge.minisdInfo();
      port = info?.port;
      token = info?.token;
    } else {
      port = await bridge.minisdPort();
    }
    const url = token
      ? `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
      : `ws://127.0.0.1:${port}`;
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      this.ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined && this.pending.has(msg.id)) { this.pending.get(msg.id)!(msg); this.pending.delete(msg.id); }
        else if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
      };
    });
  }

  call<T = any>(method: string, params?: unknown): Promise<T> {
    const id = ++this.idc;
    return new Promise((resolve, reject) => {
      this.pending.set(id, msg => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  on(method: string, h: Handler): void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(h);
  }

  /** 组件卸载时摘订阅：不摘的话已销毁组件的闭包会永远挂在广播链上（泄漏 + 向死 xterm 写数据）。 */
  off(method: string, h: Handler): void {
    const set = this.handlers.get(method);
    if (!set) return;
    set.delete(h);
    if (set.size === 0) this.handlers.delete(method);
  }
}

export const rpc = new RpcClient();
```

- [ ] **Step 3: TerminalPanel.vue（新建）**

`deskminis/src/renderer/src/components/TerminalPanel.vue`:

```vue
<script setup lang="ts">
/** 右栏 · 终端面板（设计 §7）——xterm.js 实况。
 *  无 PTY 架构（计划决策 2）：minisd 侧终端驱动逐字符回显，前端不做本地回显，
 *  xterm 显示的一切都来自 terminal.attach 滚动缓冲 + terminal.output 推送。
 *  挂载时序：先订阅推送并缓冲 → attach 拿滚动缓冲写入 → 再冲刷缓冲，避免缝隙丢数据。 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';

const chat = useChat();
const host = ref<HTMLElement | null>(null);

let term: Terminal | undefined;
let fit: FitAddon | undefined;
let ro: ResizeObserver | undefined;
let mo: MutationObserver | undefined;
let attachedFor = '';
/** attach 返回前到达的推送先缓冲，防止「滚动缓冲之后的输出」被吞 */
let pending: string[] = [];
let attaching = false;

/** xterm 主题跟随 tokens（暗色适配硬约束）：从计算样式读语义色，主题切换时重读。 */
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    background: v('--bg') || '#ffffff',
    foreground: v('--label') || '#000000',
    cursor: v('--label') || '#000000',
    selectionBackground: v('--fill') || 'rgba(120,120,128,.2)',
  };
}

function applyTheme(): void { if (term) term.options.theme = readTheme(); }

const media = window.matchMedia('(prefers-color-scheme: dark)');
const onMedia = () => applyTheme();

function onOutput(params: any): void {
  if (!params || params.sessionId !== chat.activeId) return;
  const data = String(params.data ?? '');
  if (attaching) pending.push(data);
  else term?.write(data);
}

async function attach(sessionId: string): Promise<void> {
  if (!term || !sessionId) return;
  attaching = true;
  pending = [];
  attachedFor = sessionId;
  term.reset();
  try {
    const r = await rpc.call('terminal.attach', { sessionId });
    if (attachedFor !== sessionId) return; // 等待期间又切了会话：丢弃这次结果（watch 已发起新 attach）
    if (r?.scrollback) term.write(String(r.scrollback));
    const queued = pending;
    pending = [];
    attaching = false;
    for (const d of queued) term.write(d);
  } catch (e) {
    attaching = false;
    term.writeln(`\x1b[31m[终端连接失败: ${e instanceof Error ? e.message : String(e)}]\x1b[0m`);
  }
}

watch(() => chat.activeId, id => { if (id && id !== attachedFor) void attach(id); });

onMounted(() => {
  term = new Terminal({
    fontFamily: '"Cascadia Code", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
    theme: readTheme(),
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value!);
  fit.fit();
  // 键入直送 stdin（回显由 minisd 驱动完成）；无会话时忽略（左栏必有可选会话时才用得上终端）
  term.onData(data => {
    if (!chat.activeId) return;
    void rpc.call('terminal.input', { sessionId: chat.activeId, data }).catch(() => { /* 连接断开：下次 attach 重建 */ });
  });
  rpc.on('terminal.output', onOutput);
  if (chat.activeId) void attach(chat.activeId);
  // v-show 隐藏时尺寸为 0，fit 会抛：兜住，重新显示时 RO 会再触发
  ro = new ResizeObserver(() => { try { fit?.fit(); } catch { /* 隐藏态忽略 */ } });
  ro.observe(host.value!);
  media.addEventListener('change', onMedia);
  // 强制明暗模式落在 <html data-theme>：观察属性变化重读 tokens
  mo = new MutationObserver(applyTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});

onBeforeUnmount(() => {
  rpc.off('terminal.output', onOutput);
  ro?.disconnect();
  mo?.disconnect();
  media.removeEventListener('change', onMedia);
  term?.dispose();
});
</script>

<template>
  <div ref="host" class="termhost"></div>
</template>

<style scoped>
.termhost { flex: 1; min-height: 0; padding: 8px 0 8px 10px; background: var(--bg); overflow: hidden; }
.termhost :deep(.xterm) { height: 100%; }
</style>
```

- [ ] **Step 4: App.vue 接线终端页签（完整替换）**

`deskminis/src/renderer/src/App.vue`:

```vue
<script setup lang="ts">
/** 应用外壳（设计 §4）——自绘标题栏（顶，全宽）+ 三栏 260 | 1fr | 300（右栏可收起）。 */
import { onMounted, ref, computed, provide, reactive } from 'vue';
import { useChat } from './stores/chat';
import TitleBar from './components/TitleBar.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import ProviderSettings from './components/ProviderSettings.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import Icon from './components/Icon.vue';

const chat = useChat();

const sidebarOpen = ref(true);
const rightOpen = ref(true);
const settingsOpen = ref(false);
const rightTab = ref<'terminal' | 'files' | 'tasks'>('terminal');

/** 右栏面板懒挂载 + v-show 保活：首次切到才创建组件（xterm/文件树不必为未看页签付启动成本），
 *  之后切换页签只隐藏不销毁——终端会话、xterm 缓冲与树展开态不丢。 */
const visited = reactive({ terminal: true, files: false, tasks: false });
function showTab(tab: 'terminal' | 'files' | 'tasks'): void {
  settingsOpen.value = false;
  rightTab.value = tab;
  visited[tab] = true;
}
function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
  if (!settingsOpen.value) visited[rightTab.value] = true;
}

// 明暗：appearanceMode 0 跟随系统 / 1 强制浅 / 2 强制深——循环切换并落到 <html data-theme>
type Theme = 'system' | 'light' | 'dark';
const theme = ref<Theme>('system');
function applyTheme(): void {
  const el = document.documentElement;
  if (theme.value === 'system') el.removeAttribute('data-theme');
  else el.dataset.theme = theme.value;
}
function cycleTheme(): void {
  theme.value = theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system';
  applyTheme();
}

// 当前会话标题（无选中时留空）——首帧 activeId 为空、sessions 为空也不解引用 undefined
const activeTitle = computed(() => chat.sessions.find(s => s.id === chat.activeId)?.title ?? '');

// ModelPicker 的「管理模型…」经此进入设置面板（无需逐层 emit）
provide('openSettings', () => { settingsOpen.value = true; rightOpen.value = true; });

onMounted(() => { void chat.init(); });
</script>

<template>
  <div class="shell">
    <TitleBar
      :title="activeTitle"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @toggle-right="rightOpen = !rightOpen"
      @toggle-theme="cycleTheme"
    />
    <div class="win">
      <aside v-show="sidebarOpen" class="pane-l"><SessionList /></aside>
      <main class="pane-c"><ChatView /></main>
      <aside v-show="rightOpen" class="pane-r">
        <div class="tabs">
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'terminal' }" @click="showTab('terminal')">终端</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'files' }" @click="showTab('files')">文件</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'tasks' }" @click="showTab('tasks')">任务</div>
          <div class="tab gear" :class="{ on: settingsOpen }" title="模型设置" @click="toggleSettings"><Icon name="gear" :size="15" /></div>
        </div>
        <div v-if="settingsOpen" class="rbody"><ProviderSettings /></div>
        <template v-else>
          <div v-show="rightTab === 'terminal'" class="rfill"><TerminalPanel v-if="visited.terminal" /></div>
          <div v-if="rightTab !== 'terminal'" class="rempty">M2d 后续任务填入文件树与任务进度</div>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100vh; background: var(--bg); }
.win { flex: 1; display: flex; min-height: 0; overflow: hidden; }

.pane-l {
  width: 260px; flex: 0 0 260px; background: var(--bg); border-right: .5px solid var(--separator);
  display: flex; flex-direction: column; overflow: hidden;
}
.pane-c { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
.pane-r {
  width: 300px; flex: 0 0 300px; border-left: .5px solid var(--separator); background: var(--bg);
  display: flex; flex-direction: column; overflow: hidden;
}
.tabs { display: flex; gap: 2px; padding: 10px; border-bottom: .5px solid var(--separator); }
.tab {
  flex: 1; text-align: center; padding: 6px; font-size: 13px; font-weight: 500; color: var(--label-secondary);
  border-radius: var(--r-control); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.tab.gear { flex: 0 0 32px; }
.tab.on { background: var(--fill-quaternary); color: var(--label); }
.rbody { flex: 1; overflow: auto; padding: 12px 14px; }
.rfill { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.rempty {
  flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
  font-size: 13px; color: var(--label-tertiary); padding: 24px; line-height: 1.6;
}
</style>
```

- [ ] **Step 5: typecheck + build + dev 手工冒烟**

Run: `cd deskminis && npm run typecheck`
Expected: 0 errors
Run: `cd deskminis && npm run build`
Expected: main / preload / renderer 全部构建成功（renderer 含 xterm css）
Run: `cd deskminis && npm run dev`
Expected（人工确认）：右栏默认终端页出现 `PS <工作区路径>> ` 提示符；键入 `echo hello` 回车后有逐字符回显 + 输出 + 新提示符；切到文件/任务页签仍是占位文案，切回终端内容仍在

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/package.json deskminis/package-lock.json deskminis/src/renderer/src/rpc.ts deskminis/src/renderer/src/App.vue deskminis/src/renderer/src/components/TerminalPanel.vue && git commit -m "feat(m2d): 右栏终端面板（xterm.js + 滚动缓冲重放 + 主题跟随 tokens）"
```

---

### Task 4: 文件面板（懒加载树 + 文本预览）

**Files:**
- Create: `deskminis/src/renderer/src/components/FilesPanel.vue`, `deskminis/src/renderer/src/components/FileTreeNode.vue`
- Modify: `deskminis/src/renderer/src/components/Icon.vue`（+ refresh 图标）、`deskminis/src/renderer/src/App.vue`（接线文件页签）
- Manual verify: 见 Step 4

**Interfaces:**
- Consumes: `files.list` / `files.read`（Task 2；类型 `FileNode` / `FilePreview` 以 type-only 从 `src/minisd/files.ts` 导入，构建期擦除）、`useChat().activeId` / `useChat().running`
- Produces:
  - `FileTreeNode.vue`：props `{ node: FileNode; sessionId: string; depth: number; refreshKey: number }`，emits `preview(path: string)`；目录首次展开时 `files.list(dir=node.path)` 懒加载；`refreshKey` 变化时已展开目录重新拉一层
  - `FilesPanel.vue`：无 props；根列表 + 刷新按钮；`running` 由真变假（agent 回合落盘结束）自动刷新根与已展开目录；文件点击 → 底部预览（文本 / 截断提示 / 二进制提示）
  - `Icon.vue`：`PATHS` 新增 `refresh`

- [ ] **Step 1: Icon.vue 增加 refresh 图标（完整替换）**

`deskminis/src/renderer/src/components/Icon.vue`:

```vue
<script setup lang="ts">
/** 本地内联线性图标集（描边风，复用预览稿的 SVG 路径）。
 *  离线/CSP 友好：不引任何外部图标库或网络资源。
 *  颜色由父级 color 决定（内部一律 stroke="currentColor"）。 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 });

const PATHS: Record<string, string> = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 18l6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
  file: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-up': '<path d="M18 15l-6-6-6 6"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  hand: '<path d="M18 11V6a2 2 0 00-4 0M14 10V4a2 2 0 00-4 0v2M10 10.5V6a2 2 0 00-4 0v8"/><path d="M18 8a2 2 0 014 0v6a8 8 0 01-8 8h-2a8 8 0 01-8-8"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.5"/>',
  memory: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8v.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-2.82 1.17V21a2 2 0 01-4 0v-.09A1.65 1.65 0 007 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83 2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001 1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06-.06A1.65 1.65 0 0019.4 9c.14.31.22.65.22 1z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>',
  refresh: '<path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6"/>',
};

const inner = computed(() => PATHS[props.name] ?? PATHS.info);
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" stroke="currentColor" v-html="inner" />
</template>
```

- [ ] **Step 2: FileTreeNode.vue（新建，递归节点）**

`deskminis/src/renderer/src/components/FileTreeNode.vue`:

```vue
<script setup lang="ts">
/** 文件树节点（递归，按文件名自引用）：目录可展开（首次展开时懒加载一层），文件点击发 preview。
 *  refreshKey 由父级在「agent 回合结束 / 手动刷新 / 切会话」时递增：已展开目录重新拉一层。 */
import { ref, watch } from 'vue';
import { rpc } from '../rpc';
import Icon from './Icon.vue';
import type { FileNode } from '../../../minisd/files';

const props = defineProps<{ node: FileNode; sessionId: string; depth: number; refreshKey: number }>();
const emit = defineEmits<{ preview: [path: string] }>();

const expanded = ref(false);
const children = ref<FileNode[] | null>(null); // null = 尚未加载
const loading = ref(false);
const failed = ref('');

async function loadChildren(): Promise<void> {
  loading.value = true;
  failed.value = '';
  try {
    children.value = await rpc.call('files.list', { sessionId: props.sessionId, dir: props.node.path });
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e);
    children.value = null;
  } finally {
    loading.value = false;
  }
}

async function toggle(): Promise<void> {
  if (props.node.kind !== 'dir') { emit('preview', props.node.path); return; }
  expanded.value = !expanded.value;
  if (expanded.value && children.value === null) await loadChildren();
}

watch(() => props.refreshKey, () => { if (expanded.value && children.value !== null) void loadChildren(); });
</script>

<template>
  <div class="node">
    <button class="row" :style="{ paddingLeft: `${6 + depth * 14}px` }" @click="toggle">
      <span class="tw" :class="{ open: expanded, leaf: node.kind !== 'dir' }"><Icon name="chevron-down" :size="12" /></span>
      <span class="fi" :style="{ color: node.kind === 'dir' ? 'var(--orange)' : 'var(--cyan)' }">
        <Icon :name="node.kind === 'dir' ? 'folder' : 'file'" :size="15" />
      </span>
      <span class="nm">{{ node.name }}</span>
    </button>
    <div v-if="expanded && loading" class="hint" :style="{ paddingLeft: `${28 + depth * 14}px` }">加载中…</div>
    <div v-else-if="expanded && failed" class="hint err" :style="{ paddingLeft: `${28 + depth * 14}px` }">{{ failed }}</div>
    <div v-else-if="expanded && children && children.length === 0" class="hint" :style="{ paddingLeft: `${28 + depth * 14}px` }">空目录</div>
    <template v-else-if="expanded && children">
      <FileTreeNode
        v-for="c in children" :key="c.path"
        :node="c" :session-id="sessionId" :depth="depth + 1" :refresh-key="refreshKey"
        @preview="(p: string) => emit('preview', p)"
      />
    </template>
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px 4px 6px;
  background: none; border: none; cursor: pointer; font-family: var(--font-ui);
  font-size: 13px; color: var(--label); text-align: left; border-radius: var(--r-control);
}
.row:hover { background: var(--fill-quaternary); }
.tw { display: inline-flex; flex: 0 0 12px; color: var(--label-tertiary); transform: rotate(-90deg); transition: transform .12s; }
.tw.open { transform: none; }
.tw.leaf { visibility: hidden; }
.fi { display: inline-flex; flex: 0 0 auto; }
.nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.hint { font-size: 12px; color: var(--label-tertiary); padding: 3px 8px; }
.hint.err { color: var(--red); }
</style>
```

- [ ] **Step 3: FilesPanel.vue（新建）+ App.vue 接线（完整替换两文件）**

`deskminis/src/renderer/src/components/FilesPanel.vue`:

```vue
<script setup lang="ts">
/** 右栏 · 文件面板（设计 §7）——会话工作区文件树（懒加载）+ 文本预览。
 *  数据全部经 files.* RPC（minisd 为唯一事实源）；本组件只缓存「已展开的目录」这一视图状态。
 *  agent 回合结束（running 真→假）自动刷新根与已展开目录；外部挂载树在 M2 后续里程碑补（计划决策 4）。 */
import { onMounted, ref, watch } from 'vue';
import { rpc } from '../rpc';
import { useChat } from '../stores/chat';
import FileTreeNode from './FileTreeNode.vue';
import Icon from './Icon.vue';
import type { FileNode, FilePreview } from '../../../minisd/files';

const chat = useChat();
const root = ref<FileNode[] | null>(null);
const loading = ref(false);
const failed = ref('');
const refreshKey = ref(0);
const preview = ref<FilePreview | null>(null);
const previewLoading = ref(false);
const previewFailed = ref('');

async function loadRoot(): Promise<void> {
  if (!chat.activeId) { root.value = null; return; }
  loading.value = true;
  failed.value = '';
  try {
    root.value = await rpc.call('files.list', { sessionId: chat.activeId });
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e);
    root.value = null;
  } finally {
    loading.value = false;
  }
}

function refreshAll(): void {
  refreshKey.value++; // 已展开目录经 FileTreeNode 的 watch 重拉
  void loadRoot();
}

async function showPreview(path: string): Promise<void> {
  previewLoading.value = true;
  previewFailed.value = '';
  preview.value = null;
  try {
    preview.value = await rpc.call('files.read', { sessionId: chat.activeId, path });
  } catch (e) {
    previewFailed.value = e instanceof Error ? e.message : String(e);
  } finally {
    previewLoading.value = false;
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

watch(() => chat.activeId, () => {
  preview.value = null;
  previewFailed.value = '';
  refreshKey.value++;
  void loadRoot();
});
// 回合落盘结束 → 工作区可能已被 agent 改动：自动刷新（免手动）
watch(() => chat.running, (now, prev) => { if (prev && !now) refreshAll(); });
onMounted(() => { void loadRoot(); });
</script>

<template>
  <div class="fpanel">
    <div class="fhead">
      <span class="ftitle">工作区</span>
      <button class="fbtn" title="刷新" @click="refreshAll"><Icon name="refresh" :size="14" /></button>
    </div>
    <div class="ftree">
      <div v-if="!chat.activeId" class="fhint">先在左栏选择一个会话</div>
      <div v-else-if="loading && !root" class="fhint">加载中…</div>
      <div v-else-if="failed" class="fhint err">{{ failed }}</div>
      <div v-else-if="root && root.length === 0" class="fhint">工作区为空<br />agent 创建的文件会出现在这里</div>
      <FileTreeNode
        v-for="n in root ?? []" :key="n.path"
        :node="n" :session-id="chat.activeId" :depth="0" :refresh-key="refreshKey"
        @preview="showPreview"
      />
    </div>
    <div v-if="preview || previewLoading || previewFailed" class="fprev">
      <div class="phead">
        <span class="pname">{{ preview?.path ?? '读取中…' }}</span>
        <button class="fbtn" title="关闭预览" @click="preview = null; previewFailed = ''"><Icon name="x" :size="13" /></button>
      </div>
      <div v-if="previewLoading" class="fhint">读取中…</div>
      <div v-else-if="previewFailed" class="fhint err">{{ previewFailed }}</div>
      <template v-else-if="preview">
        <div class="pmeta">
          {{ fmtSize(preview.size) }}<template v-if="preview.truncated"> · 超过 256KB，仅显示前缀</template>
        </div>
        <div v-if="preview.binary" class="fhint">二进制文件不可预览</div>
        <pre v-else class="pbody">{{ preview.content }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.fpanel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fhead {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: .5px solid var(--separator); flex: 0 0 auto;
}
.ftitle { font-size: 13px; font-weight: 600; color: var(--label-secondary); }
.fbtn {
  background: none; border: none; color: var(--label-secondary); cursor: pointer;
  display: inline-flex; padding: 4px; border-radius: var(--r-control);
}
.fbtn:hover { background: var(--fill-quaternary); color: var(--label); }
.ftree { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px; }
.fhint { font-size: 12px; color: var(--label-tertiary); padding: 12px; text-align: center; line-height: 1.6; }
.fhint.err { color: var(--red); }
.fprev {
  flex: 0 0 auto; max-height: 45%; display: flex; flex-direction: column;
  border-top: .5px solid var(--separator); background: var(--grouped-bg-secondary);
}
.phead { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px 4px; }
.pname { font-size: 12px; font-weight: 600; font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pmeta { font-size: 11px; color: var(--label-tertiary); padding: 0 12px 6px; font-variant-numeric: tabular-nums; }
.pbody {
  flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 0 12px 10px;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: var(--label);
  white-space: pre-wrap; word-break: break-word;
}
</style>
```

`deskminis/src/renderer/src/App.vue`（完整替换；相对 Task 3 版本：+ FilesPanel import、文件页签填实、占位只剩任务页）:

```vue
<script setup lang="ts">
/** 应用外壳（设计 §4）——自绘标题栏（顶，全宽）+ 三栏 260 | 1fr | 300（右栏可收起）。 */
import { onMounted, ref, computed, provide, reactive } from 'vue';
import { useChat } from './stores/chat';
import TitleBar from './components/TitleBar.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import ProviderSettings from './components/ProviderSettings.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import FilesPanel from './components/FilesPanel.vue';
import Icon from './components/Icon.vue';

const chat = useChat();

const sidebarOpen = ref(true);
const rightOpen = ref(true);
const settingsOpen = ref(false);
const rightTab = ref<'terminal' | 'files' | 'tasks'>('terminal');

/** 右栏面板懒挂载 + v-show 保活：首次切到才创建组件（xterm/文件树不必为未看页签付启动成本），
 *  之后切换页签只隐藏不销毁——终端会话、xterm 缓冲与树展开态不丢。 */
const visited = reactive({ terminal: true, files: false, tasks: false });
function showTab(tab: 'terminal' | 'files' | 'tasks'): void {
  settingsOpen.value = false;
  rightTab.value = tab;
  visited[tab] = true;
}
function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
  if (!settingsOpen.value) visited[rightTab.value] = true;
}

// 明暗：appearanceMode 0 跟随系统 / 1 强制浅 / 2 强制深——循环切换并落到 <html data-theme>
type Theme = 'system' | 'light' | 'dark';
const theme = ref<Theme>('system');
function applyTheme(): void {
  const el = document.documentElement;
  if (theme.value === 'system') el.removeAttribute('data-theme');
  else el.dataset.theme = theme.value;
}
function cycleTheme(): void {
  theme.value = theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system';
  applyTheme();
}

// 当前会话标题（无选中时留空）——首帧 activeId 为空、sessions 为空也不解引用 undefined
const activeTitle = computed(() => chat.sessions.find(s => s.id === chat.activeId)?.title ?? '');

// ModelPicker 的「管理模型…」经此进入设置面板（无需逐层 emit）
provide('openSettings', () => { settingsOpen.value = true; rightOpen.value = true; });

onMounted(() => { void chat.init(); });
</script>

<template>
  <div class="shell">
    <TitleBar
      :title="activeTitle"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @toggle-right="rightOpen = !rightOpen"
      @toggle-theme="cycleTheme"
    />
    <div class="win">
      <aside v-show="sidebarOpen" class="pane-l"><SessionList /></aside>
      <main class="pane-c"><ChatView /></main>
      <aside v-show="rightOpen" class="pane-r">
        <div class="tabs">
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'terminal' }" @click="showTab('terminal')">终端</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'files' }" @click="showTab('files')">文件</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'tasks' }" @click="showTab('tasks')">任务</div>
          <div class="tab gear" :class="{ on: settingsOpen }" title="模型设置" @click="toggleSettings"><Icon name="gear" :size="15" /></div>
        </div>
        <div v-if="settingsOpen" class="rbody"><ProviderSettings /></div>
        <template v-else>
          <div v-show="rightTab === 'terminal'" class="rfill"><TerminalPanel v-if="visited.terminal" /></div>
          <div v-show="rightTab === 'files'" class="rfill"><FilesPanel v-if="visited.files" /></div>
          <div v-if="rightTab === 'tasks'" class="rempty">M2d 后续任务填入任务进度</div>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100vh; background: var(--bg); }
.win { flex: 1; display: flex; min-height: 0; overflow: hidden; }

.pane-l {
  width: 260px; flex: 0 0 260px; background: var(--bg); border-right: .5px solid var(--separator);
  display: flex; flex-direction: column; overflow: hidden;
}
.pane-c { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
.pane-r {
  width: 300px; flex: 0 0 300px; border-left: .5px solid var(--separator); background: var(--bg);
  display: flex; flex-direction: column; overflow: hidden;
}
.tabs { display: flex; gap: 2px; padding: 10px; border-bottom: .5px solid var(--separator); }
.tab {
  flex: 1; text-align: center; padding: 6px; font-size: 13px; font-weight: 500; color: var(--label-secondary);
  border-radius: var(--r-control); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.tab.gear { flex: 0 0 32px; }
.tab.on { background: var(--fill-quaternary); color: var(--label); }
.rbody { flex: 1; overflow: auto; padding: 12px 14px; }
.rfill { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.rempty {
  flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
  font-size: 13px; color: var(--label-tertiary); padding: 24px; line-height: 1.6;
}
</style>
```

- [ ] **Step 4: typecheck + build + dev 手工冒烟**

Run: `cd deskminis && npm run typecheck`
Expected: 0 errors
Run: `cd deskminis && npm run build`
Expected: main / preload / renderer 全部构建成功
Run: `cd deskminis && npm run dev`
Expected（人工确认）：文件页签出现「工作区」树；让 agent 创建 hello.txt 后回合结束树自动出现该文件（不手动刷新）；子目录首次点击展开才加载；点文件底部出预览；切走页签再切回，树的展开态与终端内容都保留

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/renderer/src/components/Icon.vue deskminis/src/renderer/src/components/FileTreeNode.vue deskminis/src/renderer/src/components/FilesPanel.vue deskminis/src/renderer/src/App.vue && git commit -m "feat(m2d): 右栏文件面板（懒加载文件树 + 文本预览 + 回合结束自动刷新）"
```

---

### Task 5: 任务面板（回合进度 / token 用量 / 上下文水位条）

**Files:**
- Create: `deskminis/src/renderer/src/components/TasksPanel.vue`
- Modify: `deskminis/src/renderer/src/stores/chat.ts`、`deskminis/src/renderer/src/App.vue`（接线任务页签）
- Manual verify: 见 Step 4

**Interfaces:**
- Consumes: `useChat()`——`messages`（后端 `chat.messages.list` 返回的 RawMessage **本就带 tokenUsage**，经 JSON-RPC 原样到达，本任务只是给 UI 类型补上）、`toolCards`、`running`、`retryNote`、tokens.css 变量
- Produces:
  - `UiMessage.tokenUsage?: { inputTokens: number; outputTokens: number }`（与 `shared/types.ts` 的 `TokenUsage` 同构）
  - store state `lastStopReason: string`——`turnEnd` 时记录；`send()` 与切换会话时清零
  - `TasksPanel.vue`：无 props；回合区（状态 / 重试提示 / 本回合工具计数 / 上回合停止原因）、token 区（上回合与会话累计）、上下文水位条（分子 = 最后一条带用量 assistant 消息的 input+output tokens；分母固定 200K 估算，代码留 `TODO(M2b)` 锚点接模型能力目录）

- [ ] **Step 1: stores/chat.ts 补 tokenUsage 类型与 lastStopReason（完整替换）**

`deskminis/src/renderer/src/stores/chat.ts`:

```typescript
import { defineStore } from 'pinia';
import { rpc } from '../rpc';

let localSeq = 0;

// tokenUsage 与 shared/types.ts 的 TokenUsage 同构：后端 RawMessage 本就带它，
// chat.messages.list 经 JSON-RPC 原样送达——这里只是让 UI 类型对齐（任务面板取数）。
interface UiMessage { id: string; role: string; parts: any[]; tokenUsage?: { inputTokens: number; outputTokens: number } }
interface PendingPerm { requestId: string; detail: string; kind: string; toolTitle: string }
interface UiProvider { id: string; name: string; hasApiKey: boolean; modelId?: string; kind?: string }
type PermTier = 'ask' | 'session' | 'full';

export const useChat = defineStore('chat', {
  state: () => ({
    sessions: [] as { id: string; title: string; updatedAt?: number; pinnedAt?: number }[],
    activeId: '' as string,
    messages: [] as UiMessage[],
    streamingText: '' as string,
    toolCards: [] as { toolUseId: string; name: string; title: string; output?: string; success?: boolean }[],
    pendingPerms: [] as PendingPerm[],
    providers: [] as UiProvider[],
    // 循环报错（API Key 错误、provider 故障…）必须看得见，否则界面就是「按了没反应」
    lastError: '' as string,
    // 透明重试期间的提示；下一个 textDelta / turnEnd 清掉
    retryNote: '' as string,
    // 当前回合是否在跑：控制发送键 ↔ 停止键、以及底部实时助手块的显隐
    running: false as boolean,
    // 上回合停止原因（turnEnd 事件携带）：任务面板显示；发新回合/切会话时清零
    lastStopReason: '' as string,
    // 后端没有暴露「读取默认 provider」的 RPC；渲染端本地镜像当前选择（模型胶囊显示 + 打勾）。
    // 初值置为首个 provider —— 后端 create() 也把首个建的 provider 设为默认。
    defaultProviderId: '' as string,
    // 权限档位为 M1 渲染端本地偏好（后端网关一次性构造、无对应设置）：只影响权限卡里预选高亮哪个按钮。
    permTier: 'ask' as PermTier,
  }),
  actions: {
    async init() {
      await rpc.connect();
      rpc.on('chat.event', ({ sessionId, event }: any) => { if (sessionId === this.activeId) this.onEvent(event); });
      rpc.on('permission.request', ({ requestId, req }: any) => this.pendingPerms.push({ requestId, detail: req.detail, kind: req.kind, toolTitle: req.toolTitle }));
      // 询问超时（30s）或别的窗口已答复时 minisd 广播 resolved：不摘掉卡片就会永远挂在界面上
      rpc.on('permission.resolved', ({ requestId }: any) => { this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId); });
      await this.refreshSessions();
      await this.refreshProviders();
    },
    async refreshSessions() { this.sessions = await rpc.call('chat.sessions.list'); },
    async refreshProviders() {
      this.providers = await rpc.call('provider.instances.list');
      // 本地默认选择未定/已失效时，回落到列表首个（与后端 create() 的默认策略一致）
      if (!this.providers.some(p => p.id === this.defaultProviderId)) this.defaultProviderId = this.providers[0]?.id ?? '';
    },
    async newSession() { const s = await rpc.call('chat.sessions.create', {}); await this.refreshSessions(); await this.open(s.id); },
    async open(id: string) {
      // 换会话才清错误横幅：turnEnd/error 之后的自刷新调用的也是 open，
      // 在那条路径上清掉的话，刚设置的 lastError 会被立刻抹掉（错误又变成看不见）。
      if (id !== this.activeId) { this.lastError = ''; this.retryNote = ''; this.running = false; this.lastStopReason = ''; }
      this.activeId = id; this.messages = await rpc.call('chat.messages.list', { sessionId: id }); this.streamingText = ''; this.toolCards = [];
    },
    async send(text: string) {
      this.streamingText = ''; this.toolCards = []; this.lastError = ''; this.retryNote = ''; this.lastStopReason = '';
      // 乐观消息用唯一 id：一次会话内连发多条时 'local' 会造成 :key 重复
      const optimisticId = `local-${++localSeq}`;
      this.messages.push({ id: optimisticId, role: 'user', parts: [{ type: 'text', value: text }] });
      this.running = true;
      // chat.prompt 会同步拒绝（未配置 provider / 空文本 / 会话运行中 / 非法 sessionId）。
      // 不 catch 的话是一次未处理拒绝：用户只看到「按了没反应」。捕获后写进 lastError 让它可见，
      // 并摘掉这条从未落库的乐观消息（否则会留下一个假的「已发送」气泡）。
      try {
        await rpc.call('chat.prompt', { sessionId: this.activeId, text });
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.messages = this.messages.filter(m => m.id !== optimisticId);
        this.running = false;
      }
    },
    async cancel() {
      if (!this.activeId) return;
      try { await rpc.call('chat.cancel', { sessionId: this.activeId }); }
      catch (e) { this.lastError = e instanceof Error ? e.message : String(e); }
    },
    async setDefaultProvider(id: string) {
      await rpc.call('provider.setDefault', { id });
      this.defaultProviderId = id;
    },
    setPermTier(tier: PermTier) { this.permTier = tier; },
    async createProvider(p: any) { await rpc.call('provider.instances.create', p); await this.refreshProviders(); },
    async updateProvider(id: string, p: any) { await rpc.call('provider.instances.update', { id, ...p }); await this.refreshProviders(); },
    async deleteProvider(id: string) { await rpc.call('provider.instances.delete', { id, confirm: true }); await this.refreshProviders(); },
    async respondPerm(requestId: string, decision: string) {
      this.pendingPerms = this.pendingPerms.filter(x => x.requestId !== requestId);
      await rpc.call('permission.respond', { requestId, decision });
    },
    onEvent(e: any) {
      if (e.kind === 'textDelta') { this.retryNote = ''; this.streamingText += e.text; }
      else if (e.kind === 'toolStart') this.toolCards.push({ toolUseId: e.toolUseId, name: e.name, title: e.title });
      else if (e.kind === 'toolEnd') { const c = this.toolCards.find(x => x.toolUseId === e.toolUseId); if (c) { c.output = e.output; c.success = e.success; } }
      else if (e.kind === 'retry') {
        // 循环会整回合重来，已缓冲的半截文本是过期的（不清就会和重试后的正文拼在一起）
        this.streamingText = '';
        this.retryNote = `正在重试…（第 ${e.attempt} 次，${Math.round((e.delayMs ?? 0) / 1000)}s 后）`;
      }
      else if (e.kind === 'turnEnd') { this.retryNote = ''; this.running = false; this.lastStopReason = String(e.stopReason ?? ''); void this.open(this.activeId); }
      else if (e.kind === 'error') {
        // 先记错误再刷新：open 在同会话路径上不动 lastError，横幅得以留在界面上
        this.lastError = String(e.message ?? '未知错误');
        this.retryNote = '';
        this.running = false;
        void this.open(this.activeId);
      }
    },
  },
});
```

- [ ] **Step 2: TasksPanel.vue（新建）**

`deskminis/src/renderer/src/components/TasksPanel.vue`:

```vue
<script setup lang="ts">
/** 右栏 · 任务面板（设计 §7）——回合进度 / token 用量 / 上下文水位条。
 *  数据全部来自 chat store（其事实源是 chat.messages.list 与 chat.event 推送，UI 无私有状态）：
 *  - 回合进度：running + retryNote + 本回合工具卡计数（toolCards 在 send() 清零）
 *  - token 用量：最近一条带 tokenUsage 的 assistant 消息；其 inputTokens 是当次请求的全量
 *    上下文规模，加 outputTokens 即「此刻上下文水位」的最佳可得估算
 *  - 上下文水位：M1 无模型能力目录，分母固定 200K（TODO(M2b)：能力目录落地后按当前模型取真实窗口） */
import { computed } from 'vue';
import { useChat } from '../stores/chat';

const chat = useChat();

// TODO(M2b): 模型能力目录落地后按当前模型取真实上下文窗口
const CONTEXT_LIMIT = 200_000;

/** 最近一条带用量的 assistant 消息的 tokenUsage（倒序找）。 */
const lastUsage = computed(() => {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.role === 'assistant' && m.tokenUsage) return m.tokenUsage;
  }
  return undefined;
});

/** 会话累计（全部 assistant 消息的 input/output 求和）。 */
const totals = computed(() => {
  let input = 0; let output = 0;
  for (const m of chat.messages) {
    if (m.role === 'assistant' && m.tokenUsage) { input += m.tokenUsage.inputTokens; output += m.tokenUsage.outputTokens; }
  }
  return { input, output };
});

const watermark = computed(() => {
  const used = (lastUsage.value?.inputTokens ?? 0) + (lastUsage.value?.outputTokens ?? 0);
  return { used, pct: Math.min(100, Math.round((used / CONTEXT_LIMIT) * 100)) };
});
const waterColor = computed(() =>
  watermark.value.pct < 60 ? 'var(--green)' : watermark.value.pct < 85 ? 'var(--orange)' : 'var(--red)');

const toolStats = computed(() => {
  const done = chat.toolCards.filter(c => c.success !== undefined);
  const ok = done.filter(c => c.success).length;
  return { total: chat.toolCards.length, ok, fail: done.length - ok, running: chat.toolCards.length - done.length };
});

const STOP_LABEL: Record<string, string> = {
  endTurn: '正常结束', maxTokens: '达到输出上限', refusal: '模型拒绝', toolUse: '中断于工具调用',
};
const stopLabel = computed(() => STOP_LABEL[chat.lastStopReason] ?? (chat.lastStopReason || '—'));

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
</script>

<template>
  <div class="tpanel">
    <div v-if="!chat.activeId" class="thint">先在左栏选择一个会话</div>
    <template v-else>
      <div class="tsec">
        <div class="thead">回合</div>
        <div class="trow">
          <span class="tlabel">状态</span>
          <span class="tval"><span class="dot" :class="{ run: chat.running }"></span>{{ chat.running ? '运行中' : '空闲' }}</span>
        </div>
        <div v-if="chat.retryNote" class="tnote">{{ chat.retryNote }}</div>
        <div class="trow">
          <span class="tlabel">工具调用</span>
          <span class="tval">{{ toolStats.total }} 次<template v-if="toolStats.total">（成功 {{ toolStats.ok }} · 失败 {{ toolStats.fail }}<template v-if="toolStats.running"> · 进行中 {{ toolStats.running }}</template>）</template></span>
        </div>
        <div class="trow"><span class="tlabel">停止原因</span><span class="tval">{{ stopLabel }}</span></div>
      </div>
      <div class="tsec">
        <div class="thead">Token 用量</div>
        <div class="trow">
          <span class="tlabel">上回合</span>
          <span class="tval">{{ lastUsage ? `输入 ${fmt(lastUsage.inputTokens)} · 输出 ${fmt(lastUsage.outputTokens)}` : '—' }}</span>
        </div>
        <div class="trow">
          <span class="tlabel">会话累计</span>
          <span class="tval">{{ totals.input || totals.output ? `输入 ${fmt(totals.input)} · 输出 ${fmt(totals.output)}` : '—' }}</span>
        </div>
      </div>
      <div class="tsec">
        <div class="thead">上下文水位</div>
        <div class="wbar"><div class="wfill" :style="{ width: watermark.pct + '%', background: waterColor }"></div></div>
        <div class="wnum">{{ fmt(watermark.used) }} / {{ fmt(CONTEXT_LIMIT) }}（{{ watermark.pct }}%，按最后请求估算）</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tpanel { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.thint { font-size: 12px; color: var(--label-tertiary); padding: 12px; text-align: center; line-height: 1.6; }
.tsec { background: var(--grouped-bg-secondary); border-radius: var(--r-card); padding: 10px 12px; }
.thead { font-size: 12px; font-weight: 600; color: var(--label-secondary); margin-bottom: 8px; }
.trow { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 13px; }
.tlabel { color: var(--label-secondary); flex: 0 0 auto; }
.tval { color: var(--label); display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; text-align: right; }
.tnote { font-size: 12px; color: var(--orange); padding: 2px 0 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex: 0 0 auto; }
.dot.run { background: var(--orange); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.wbar { height: 6px; border-radius: var(--r-pill); background: var(--fill-quaternary); overflow: hidden; }
.wfill { height: 100%; border-radius: var(--r-pill); transition: width .3s ease; }
.wnum { font-size: 11px; color: var(--label-tertiary); padding-top: 6px; font-variant-numeric: tabular-nums; }
</style>
```

- [ ] **Step 3: App.vue 接线任务页签（完整替换——相对 Task 4 版本：+ TasksPanel import、任务页签填实、占位文案删除）**

`deskminis/src/renderer/src/App.vue`:

```vue
<script setup lang="ts">
/** 应用外壳（设计 §4）——自绘标题栏（顶，全宽）+ 三栏 260 | 1fr | 300（右栏可收起）。 */
import { onMounted, ref, computed, provide, reactive } from 'vue';
import { useChat } from './stores/chat';
import TitleBar from './components/TitleBar.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import ProviderSettings from './components/ProviderSettings.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import FilesPanel from './components/FilesPanel.vue';
import TasksPanel from './components/TasksPanel.vue';
import Icon from './components/Icon.vue';

const chat = useChat();

const sidebarOpen = ref(true);
const rightOpen = ref(true);
const settingsOpen = ref(false);
const rightTab = ref<'terminal' | 'files' | 'tasks'>('terminal');

/** 右栏面板懒挂载 + v-show 保活：首次切到才创建组件（xterm/文件树不必为未看页签付启动成本），
 *  之后切换页签只隐藏不销毁——终端会话、xterm 缓冲与树展开态不丢。 */
const visited = reactive({ terminal: true, files: false, tasks: false });
function showTab(tab: 'terminal' | 'files' | 'tasks'): void {
  settingsOpen.value = false;
  rightTab.value = tab;
  visited[tab] = true;
}
function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
  if (!settingsOpen.value) visited[rightTab.value] = true;
}

// 明暗：appearanceMode 0 跟随系统 / 1 强制浅 / 2 强制深——循环切换并落到 <html data-theme>
type Theme = 'system' | 'light' | 'dark';
const theme = ref<Theme>('system');
function applyTheme(): void {
  const el = document.documentElement;
  if (theme.value === 'system') el.removeAttribute('data-theme');
  else el.dataset.theme = theme.value;
}
function cycleTheme(): void {
  theme.value = theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system';
  applyTheme();
}

// 当前会话标题（无选中时留空）——首帧 activeId 为空、sessions 为空也不解引用 undefined
const activeTitle = computed(() => chat.sessions.find(s => s.id === chat.activeId)?.title ?? '');

// ModelPicker 的「管理模型…」经此进入设置面板（无需逐层 emit）
provide('openSettings', () => { settingsOpen.value = true; rightOpen.value = true; });

onMounted(() => { void chat.init(); });
</script>

<template>
  <div class="shell">
    <TitleBar
      :title="activeTitle"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @toggle-right="rightOpen = !rightOpen"
      @toggle-theme="cycleTheme"
    />
    <div class="win">
      <aside v-show="sidebarOpen" class="pane-l"><SessionList /></aside>
      <main class="pane-c"><ChatView /></main>
      <aside v-show="rightOpen" class="pane-r">
        <div class="tabs">
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'terminal' }" @click="showTab('terminal')">终端</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'files' }" @click="showTab('files')">文件</div>
          <div class="tab" :class="{ on: !settingsOpen && rightTab === 'tasks' }" @click="showTab('tasks')">任务</div>
          <div class="tab gear" :class="{ on: settingsOpen }" title="模型设置" @click="toggleSettings"><Icon name="gear" :size="15" /></div>
        </div>
        <div v-if="settingsOpen" class="rbody"><ProviderSettings /></div>
        <template v-else>
          <div v-show="rightTab === 'terminal'" class="rfill"><TerminalPanel v-if="visited.terminal" /></div>
          <div v-show="rightTab === 'files'" class="rfill"><FilesPanel v-if="visited.files" /></div>
          <div v-show="rightTab === 'tasks'" class="rfill"><TasksPanel v-if="visited.tasks" /></div>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100vh; background: var(--bg); }
.win { flex: 1; display: flex; min-height: 0; overflow: hidden; }

.pane-l {
  width: 260px; flex: 0 0 260px; background: var(--bg); border-right: .5px solid var(--separator);
  display: flex; flex-direction: column; overflow: hidden;
}
.pane-c { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
.pane-r {
  width: 300px; flex: 0 0 300px; border-left: .5px solid var(--separator); background: var(--bg);
  display: flex; flex-direction: column; overflow: hidden;
}
.tabs { display: flex; gap: 2px; padding: 10px; border-bottom: .5px solid var(--separator); }
.tab {
  flex: 1; text-align: center; padding: 6px; font-size: 13px; font-weight: 500; color: var(--label-secondary);
  border-radius: var(--r-control); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.tab.gear { flex: 0 0 32px; }
.tab.on { background: var(--fill-quaternary); color: var(--label); }
.rbody { flex: 1; overflow: auto; padding: 12px 14px; }
.rfill { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.rempty {
  flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
  font-size: 13px; color: var(--label-tertiary); padding: 24px; line-height: 1.6;
}
</style>
```

- [ ] **Step 4: typecheck + build + dev 手工冒烟**

Run: `cd deskminis && npm run typecheck`
Expected: 0 errors
Run: `cd deskminis && npm run build`
Expected: main / preload / renderer 全部构建成功
Run: `cd deskminis && npm run dev`
Expected（人工确认）：任务页签三段齐全；发一个带工具调用的 prompt——运行中状态点为橙色脉冲、工具计数递增；回合结束后出现停止原因「正常结束」、上回合输入/输出 token、累计用量与绿色水位条

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/src/renderer/src/stores/chat.ts deskminis/src/renderer/src/components/TasksPanel.vue deskminis/src/renderer/src/App.vue && git commit -m "feat(m2d): 右栏任务面板（回合进度 + token 用量 + 上下文水位条）"
```

---

### Task 6: 系统托盘常驻（关窗不杀 minisd）

**Files:**
- Create: `deskminis/scripts/gen-tray-icon.mjs`、`deskminis/resources/tray.png`（生成物，进 git）
- Modify: `deskminis/src/main/index.ts`（完整替换）、`deskminis/package.json`（scripts + `gen:tray-icon`）
- Test: `deskminis/tests/tray-lifecycle.test.ts`

**Interfaces:**
- Consumes: Electron 主进程内置 `Tray` / `Menu` / `nativeImage`（无新增 npm 依赖）
- Produces:
  - `npm run gen:tray-icon` → `resources/tray.png`（32×32 RGBA：品牌色圆角方块 + 三条白色对话行；无依赖手写 PNG 容器 + zlib，生成物进 git——审查脚本比审查二进制容易）
  - 主进程行为：关窗（标题栏 × / Alt+F4）→ 拦截 `close` 改 `hide()`；托盘左键或菜单「显示主窗口」→ 还原并聚焦；菜单「退出 DeskMinis」→ `before-quit` 里杀 minisd 后真退出
  - 不变量：`window-all-closed` 空转——正常路径到不了（close 已拦截为 hide，窗口永不销毁），它若再杀进程就是「关窗后 agent 死了」的回归

**为什么托盘行为用源文本守卫而不是自动化运行测试：** 托盘依赖真实 Electron 主进程 + 系统通知区，vitest（ELECTRON_RUN_AS_NODE）里 `app`/`Tray` 全是桩，跑不出行为；而「M1 的 window-all-closed 杀进程逻辑被留下来」这类漂移 typecheck/build 都不红，只在用户手上爆发。沿用 `build-config.test.ts` 的源文本守卫模式（`ipc-contract.test.ts` 证明该模式在本仓库有效）。注意：`ipc-contract.test.ts` 用 vi.mock 提供 electron 桩并把 main/index.ts 整个 import——本任务新增的 `Tray`/`Menu`/`nativeImage` 只许在函数体内使用（模块顶层不允许 `new Tray(...)`），否则桩模块在 import 时即崩，该测试会红。

- [ ] **Step 1: 写失败测试**

`deskminis/tests/tray-lifecycle.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 静态托盘生命周期守卫：不启动 Electron，只读源文本 + 图标文件。
// 背景：托盘常驻是「关窗不杀 minisd」的载体（设计 §7）。M1 的 window-all-closed 直接
// minisd.kill() + app.quit()——改成托盘常驻时漏掉任何一环（close 未拦截 / 菜单没有真退出
// 路径 / 旧的 window-all-closed 杀进程逻辑被留下），typecheck 和 build 都不会红，只在用户
// 手上表现为「关窗后 agent 死了」或「托盘退不出」。这类漂移只有源文本守卫挡得住。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8');

describe('托盘生命周期（源文本守卫）', () => {
  it('拦截 close：默认关窗改为隐藏（关窗不杀 minisd 的根基）', () => {
    expect(/\.on\(\s*['"]close['"]/.test(mainSrc),
      '主窗口必须注册 close 处理器——不拦截的话 × 直接销毁窗口并触发 window-all-closed').toBe(true);
    expect(/preventDefault\(\)/.test(mainSrc),
      'close 处理器必须 preventDefault()  veto 默认关闭，否则窗口照样销毁').toBe(true);
    expect(/\.hide\(\)/.test(mainSrc),
      'close 处理器必须 hide() 窗口——「关窗 = 隐藏到托盘」').toBe(true);
  });

  it('创建托盘与菜单：显示主窗口 + 退出两项', () => {
    expect(/new Tray\(/.test(mainSrc)).toBe(true);
    expect(/Menu\.buildFromTemplate\(/.test(mainSrc)).toBe(true);
    expect(mainSrc).toContain('显示主窗口');
    expect(mainSrc).toContain('退出 DeskMinis');
  });

  it('存在真退出路径：quitting 标志 + before-quit 杀 minisd（close 拦截不能变成永远退不出）', () => {
    expect(/quitting\s*=\s*true/.test(mainSrc),
      '必须有 quitting 标志：托盘菜单退出时置真，close 处理器对它放行默认关闭').toBe(true);
    expect(/before-quit/.test(mainSrc),
      '必须在 before-quit 里回收 minisd——托盘菜单只 app.quit() 时，子进程靠这里杀掉').toBe(true);
    const m = mainSrc.match(/before-quit['"]\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*\)/);
    expect(m, '找不到 before-quit 处理器（守卫依赖 => { ... } 的写法）').toBeTruthy();
    expect(/minisd\?\.kill\(\)/.test(m?.[1] ?? ''),
      'before-quit 必须 minisd?.kill()——否则托盘退出后 minisd 成孤儿进程，还占着 minis.db').toBe(true);
  });

  it('window-all-closed 不再杀 minisd / 退出（M1 行为必须移除）', () => {
    const m = mainSrc.match(/window-all-closed['"]\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*\)/);
    expect(m, '找不到 window-all-closed 处理器（守卫依赖 => { ... } 的写法）').toBeTruthy();
    const body = m?.[1] ?? '';
    expect(/app\.quit|minisd\?\.kill|minisd\.kill/.test(body),
      'window-all-closed 里仍有 quit/kill——托盘常驻下关窗不销毁窗口，但 darwin 上 Cmd+Q 之外' +
      '的路径（如多窗口场景全部关闭）会走这里把 agent 杀掉；它必须空转，退出只走托盘菜单').toBe(false);
  });

  it('托盘图标资源存在且有生成脚本（32×32 PNG 进 git，可复现可审查）', () => {
    const icon = join(repoRoot, 'resources', 'tray.png');
    expect(existsSync(icon), 'resources/tray.png 缺失——先跑 npm run gen:tray-icon 并把它提交进 git').toBe(true);
    expect(statSync(icon).size).toBeGreaterThan(0);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['gen:tray-icon'],
      'package.json 必须有 "gen:tray-icon" 脚本——图标要能一键复现，不能是某台机器上的手工产物').toContain('gen-tray-icon');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/tray-lifecycle.test.ts`
Expected: FAIL（5 例全红：无 close 拦截 / 无 Tray / 无 quitting / window-all-closed 仍杀进程 / 图标缺失）

- [ ] **Step 3: 托盘图标生成器 + package.json 脚本，生成图标**

`deskminis/scripts/gen-tray-icon.mjs`:

```javascript
// 生成 resources/tray.png（32×32 RGBA）：品牌色圆角方块 + 三条白色「对话行」。
// 不引任何依赖：PNG 容器 + zlib（node 内置）手写——图标进 git 且可复现，
// 审查这个脚本比审查二进制 PNG 现实得多。用法：npm run gen:tray-icon
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 32, R = 7;
const BRAND = [0xB7, 0xAF, 0x96, 0xFF]; // tokens.css --brand（浅色）：暖灰褐
const WHITE = [0xFF, 0xFF, 0xFF, 0xFF];
const CLEAR = [0, 0, 0, 0];
// 三条对话行（h 取 3：通知区 16px 缩略后仍可辨）
const BARS = [
  { x: 8, y: 9, w: 16, h: 3 },
  { x: 8, y: 15, w: 16, h: 3 },
  { x: 8, y: 21, w: 10, h: 3 },
];

/** 点在圆角方块内（四角以半径 R 圆弧收角，角外透明）。 */
function inRoundedRect(x, y) {
  const cx = x < R ? R : x > SIZE - 1 - R ? SIZE - 1 - R : x;
  const cy = y < R ? R : y > SIZE - 1 - R ? SIZE - 1 - R : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= R * R;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // 每行 filter 字节：None
  for (let x = 0; x < SIZE; x++) {
    let px = inRoundedRect(x, y) ? BRAND : CLEAR;
    if (px === BRAND) {
      for (const b of BARS) {
        if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) { px = WHITE; break; }
      }
    }
    raw.set(px, row + 1 + x * 4);
  }
}

// CRC32（PNG 块校验，多项式 0xEDB88320）
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit，color type 6 = RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'tray.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log('written:', out, png.length, 'bytes');
```

`deskminis/package.json`：在 `"rebuild": "electron-rebuild -f -w better-sqlite3",` 一行之后插入：

```json
    "gen:tray-icon": "node scripts/gen-tray-icon.mjs",
```

生成图标并确认第 5 例转绿：

```bash
cd "C:\Users\24739\Downloads\openminis1\deskminis" && npm run gen:tray-icon
```

Run: `cd deskminis && npm test -- tests/tray-lifecycle.test.ts`
Expected: 1 passed, 4 failed（图标例转绿，其余 4 例待 Step 4 的主进程改动）

- [ ] **Step 4: src/main/index.ts（完整替换）**

`deskminis/src/main/index.ts`:

```typescript
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray, utilityProcess, type UtilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

let minisd: UtilityProcess | undefined;
let minisdPort = 0;
// per-run token：从握手行里接住并经 minisd:info 通道交给渲染进程；
// 没有它渲染进程连 RPC 会被 401 拒绝（RpcServer 要求 ?token=<authToken>），应用只能开一个空窗口。
let minisdToken = '';
let tray: Tray | undefined;
/** 托盘「退出」/ 启动失败兜底置 true：close 拦截只对「关窗=隐藏」生效，真退出路径必须放行默认关闭，
 *  否则 app.quit() 会卡在「窗口拒绝关闭」上（quit 触发各窗口 close，被 veto 后 quit 中止）。 */
let quitting = false;

/** 子进程未在此时限内上报端口就判定启动失败——否则挂死的子进程会让主进程永远停在白屏前。 */
const MINISD_START_TIMEOUT_MS = 30_000;

/** 一行文本是不是握手行 `{"minisdPort":<n>,"authToken":"<uuid>"}`；不是就返回 undefined（调用方把它当普通日志转发）。
 *  必须同时拿到 port 和 token 才算握手——只有 port 没有 token 的行不是握手行，转发它、继续等。 */
export function parseHandshake(line: string): { port: number; token: string } | undefined {
  try {
    const o = JSON.parse(line) as { minisdPort?: unknown; authToken?: unknown } | null;
    const port = o?.minisdPort;
    const token = o?.authToken;
    if (typeof port === 'number' && Number.isFinite(port) && typeof token === 'string' && token.length > 0) {
      return { port, token };
    }
  } catch { /* not the handshake line */ }
  return undefined;
}

function startMinisdProcess(): Promise<number> {
  return new Promise((resolve, reject) => {
    minisd = utilityProcess.fork(join(__dirname, 'minisd.js'), [], { env: { ...process.env, DESKMINIS_STANDALONE: '1' }, stdio: 'pipe' });

    let settled = false;
    const settle = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => settle(() => {
      minisd?.kill();
      reject(new Error(`minisd 启动超时：${MINISD_START_TIMEOUT_MS / 1000}s 内没有上报端口（子进程可能卡在 DB / 密钥库初始化）`));
    }), MINISD_START_TIMEOUT_MS);

    // 按「完整行」扫描，而不是只看第一个换行符之前的内容：
    // 子进程只要在握手行之前打印过任何一行日志，旧写法就会把那一行当成 JSON 解析失败，
    // 且 buf 永不推进 —— 端口永远解析不出来，启动永久卡死。现在非握手行一律转发到 stderr。
    let buf = '';
    minisd.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        const hs = parseHandshake(line);
        if (hs !== undefined && minisdPort === 0) {
          minisdPort = hs.port;
          minisdToken = hs.token;
          settle(() => resolve(hs.port));
        } else {
          process.stderr.write('[minisd] ' + line + '\n');
        }
      }
    });
    // 转发子进程 stderr：启动失败时这里才是真正的原因所在
    minisd.stderr?.on('data', (d: Buffer) => process.stderr.write('[minisd] ' + d.toString()));
    minisd.on('exit', code => { if (minisdPort === 0) settle(() => reject(new Error(`minisd 退出 code=${code}`))); });
  });
}

/** 托盘图标：resources/tray.png 由 scripts/gen-tray-icon.mjs 生成（npm run gen:tray-icon，生成物进 git）。
 *  路径相对 out/main——dev 与 unpackaged build 的 __dirname 都是 out/main，两级上去即 deskminis/。
 *  TODO(M4)：打包时经 extraResources 带图标并改用 process.resourcesPath 解析。 */
function loadTrayIcon(): Electron.NativeImage {
  const iconFile = join(__dirname, '../../resources/tray.png');
  if (existsSync(iconFile)) {
    const image = nativeImage.createFromPath(iconFile);
    if (!image.isEmpty()) return image;
  }
  // 图标缺失不致命：空图建托盘在 Windows 上是空白占位，菜单功能仍在；
  // 但必须把原因打到 stderr——否则用户以为「托盘功能根本没做」。
  process.stderr.write(`[tray] 图标缺失或无法解码: ${iconFile}（先跑 npm run gen:tray-icon）\n`);
  return nativeImage.createEmpty();
}

function createTray(win: BrowserWindow): void {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('DeskMinis');
  const show = (): void => { win.show(); win.focus(); };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: show },
    { type: 'separator' },
    // 先置 quitting 再 quit：app.quit() 会给每个窗口发 close，close 处理器看到 quitting=true 才不 veto
    { label: '退出 DeskMinis', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', show);
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    // 无边框 + 自绘标题栏（设计 §4.0）：DOM 里不画窗口控制，
    // titleBarOverlay 让系统在右上角绘制原生 min/max/close（透明底、符号色随明暗）。
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#808080', height: 40 },
    webPreferences: { preload: join(__dirname, '../preload/index.cjs') },
  });
  // 常驻托盘（设计 §7「关窗不杀 minisd」）：关窗 = 隐藏到托盘，minisd、会话、终端壳全部保活。
  // 真退出只走托盘菜单（quitting=true 放行默认关闭 → before-quit 统一回收）。
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  createTray(win);
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, '../renderer/index.html'));
}

// 旧通道保留（无害；渲染层重写后会弃用）：只给端口，连不上带 token 认证的 minisd。
ipcMain.handle('minisd:port', () => minisdPort);
// 新通道：端口 + per-run token。preload 的 minisdInfo() invoke 的就是这个通道——
// 少了它，渲染层调用命中一个未注册的通道、静默失败、每个 WS 连接被 401，应用连不上 minisd。
ipcMain.handle('minisd:info', () => ({ port: minisdPort, token: minisdToken }));

app.whenReady().then(async () => {
  // 不 catch 的话：minisd 起不来 → 这里抛出 → createWindow 永远不执行 →
  // 应用「启动了但什么都不显示」，用户和开发者都拿不到任何线索。
  try {
    await startMinisdProcess();
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  } catch (e) {
    const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write('DeskMinis 启动失败: ' + message + '\n');
    dialog.showErrorBox('DeskMinis 启动失败', message);
    quitting = true;
    minisd?.kill();
    app.quit();
  }
});
// 托盘常驻：关窗已被拦截为 hide，窗口不销毁，正常路径根本到不了这里；它必须空转。
// （M1 在这里 minisd.kill() + app.quit()——留着它就是「关窗后 agent 死了」的回归。）
app.on('window-all-closed', () => { /* 退出只走托盘菜单 */ });

// 真退出的统一回收点：托盘菜单 app.quit()、启动失败兜底、系统注销都经此处。
app.on('before-quit', () => {
  quitting = true;
  tray?.destroy();
  minisd?.kill();
});
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归 + typecheck**

Run: `cd deskminis && npm test -- tests/tray-lifecycle.test.ts`
Expected: `5 passed`
Run: `cd deskminis && npm test`
Expected: 全部通过（152 passed；`ipc-contract.test.ts` 仍绿——它用 vi.mock 桩 import 本文件，`new Tray(...)` 等只在函数体内，import 路径不触碰）
Run: `cd deskminis && npm run typecheck`
Expected: 0 errors

- [ ] **Step 6: dev 手工冒烟**

Run: `cd deskminis && npm run dev`
Expected（人工确认）：点窗口 × → 窗口消失但进程仍在（任务管理器可见），通知区出现托盘图标；左键点托盘图标 → 窗口还原且会话/终端原样；托盘右键菜单「退出 DeskMinis」→ 应用与 minisd 都退出（任务管理器无残留 electron 进程）；重开应用，会话历史完整

- [ ] **Step 7: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add deskminis/scripts/gen-tray-icon.mjs deskminis/resources/tray.png deskminis/src/main/index.ts deskminis/package.json deskminis/tests/tray-lifecycle.test.ts && git commit -m "feat(m2d): 系统托盘常驻（关窗隐藏不杀 minisd + 托盘菜单显窗/退出 + 生命周期源文本守卫）"
```

---

### Task 7: 全量回归与手工验收

- [ ] **Step 1: 全量自动化测试**

Run: `cd deskminis && npm test`
Expected: 19 个测试文件 152 例全绿（M1 基线 130 + terminal 6 + files-rpc 11 + tray-lifecycle 5）

- [ ] **Step 2: typecheck + build**

Run: `cd deskminis && npm run typecheck`
Expected: 0 errors
Run: `cd deskminis && npm run build`
Expected: main / preload / renderer 全部构建成功

- [ ] **Step 3: 手工验收清单**

```bash
cd deskminis && npm run dev
```

验收清单（对应 M2d 验收标准「右栏三面板填实 + 托盘常驻」）：
1. 终端：右栏默认页出现 `PS <工作区路径>> ` 提示符；键入 `echo 你好` 回车，有逐字符回显 + 输出 + 新提示符，中文无乱码
2. 终端保活：切到文件/任务页再切回终端，已显示的输出与提示符仍在（v-show 保活）
3. 终端随会话切换：切到另一会话，终端内容换成该会话的滚动缓冲；在该会话终端 `cd ..` 后新提示符路径变为上级目录
4. 文件树自动刷新：中栏让 agent「在工作区创建 hello.txt 写入 你好」→ 回合结束后文件页**不点刷新**自动出现 hello.txt
5. 文件预览：点 hello.txt 底部显示「你好」；放 >256KB 文件显示截断提示；放二进制文件显示「二进制文件不可预览」
6. 文件树懒加载与保活：子目录首次点击才展开加载；切走页签再切回，展开态与预览仍在
7. 任务面板：发带工具调用的 prompt——运行中状态点橙色脉冲、工具计数实时递增；回合结束后显示停止原因「正常结束」、上回合输入/输出 token、会话累计、绿色水位条
8. 水位条分色：<60% 绿（橙 ≥60%、红 ≥85% 的阈值由代码评审确认即可，不必真塞爆上下文）
9. 托盘常驻：点窗口 × → 窗口消失但应用进程与 minisd 都在（任务管理器可见），通知区有托盘图标
10. 托盘还原：左键点托盘图标 → 窗口回来，会话、终端缓冲、文件树展开态原样
11. 托盘退出：托盘菜单「退出 DeskMinis」→ 应用与 minisd 全部退出（任务管理器无残留 electron 进程）；重开应用，左栏会话与历史消息完整
12. 暗色三模式：标题栏循环切跟随系统/强制浅/强制深，终端配色、文件树、任务面板、水位条全部可读、无写死色穿帮

全部通过则 M2d 达成。若某步失败，按 systematic-debugging 定位到对应模块的单测补测再修。

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\24739\Downloads\openminis1" && git add docs/plans/2026-07-28-m2d-right-panel-ui.md && git commit -m "docs(m2d): 右栏 UI + 系统托盘实施计划（勾选完成项）"
```

---

## M2d 完成定义

- 19 个自动化测试文件全绿（`npm test`，152 例）：M1 基线 16 个 + terminal、files-rpc、tray-lifecycle
- `npm run typecheck` / `npm run build` 通过
- 手工验收 12 项全过
- 交付物：右栏三面板全部填实（xterm 终端实况 / 工作区文件树 + 文本预览 / 回合任务与用量水位），应用常驻系统托盘、关窗不杀 minisd
- 下一步：M2 其余子计划（Provider 补全、模型组降级、上下文压缩/卸载、记忆、技能、windows-* 桥）→ M3 内网同步

## 已知限制（对用户可见）

1. 终端无行编辑：方向键历史、Tab 补全、光标左右移动不可用（哑管道逐字符协议，决策 2）；Backspace 与 Ctrl+C 可用
2. 命令执行期间的键入会缓冲到命令结束后才回显（PowerShell 管道语义），交互式 TUI 程序（vim 等）不可用
3. 终端输出宽度固定 500 列，不随面板 resize 重排（xterm 宽度只是视口）
4. 终端壳与 agent 工具壳是两个独立 PowerShell：终端里 `cd` / 设环境变量不影响 agent 的 shell（决策 1，刻意隔离）
5. 上下文水位条分母固定 200K 估算（M1 无模型能力目录）；能力目录落地后按当前模型取真实窗口（代码内 `TODO(M2b)` 锚点）
6. 托盘图标路径相对 `out/main` 解析；M4 打包时需经 extraResources 携带并改用 `process.resourcesPath`（代码内 `TODO(M4)` 锚点）
7. 文件面板只做会话工作区树；外部挂载树（设计 §3.5）与中栏 minis:// 文件芯片联动留待 M2 后续里程碑