/**
 * F05 fixture（不是测试）：真实引擎进程、假模型端点、按 PID 强杀引擎、直接读库，以及请求消息的配对断言。
 *
 * 这个文件不引任何 F05 新增的 src 模块：用它的用例（run-recovery-process、run-ledger-minisd、tool-result-pairing）
 * 只经 RPC、读库、读文件系统断言，在 F05 之前的基线上也跑得起来、红在行为上。
 * 需要新模块的进程内崩溃模型（库快照 + 恢复）在 run-recovery-fixture.ts。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { powershellPath, system32 } from '../src/minisd/proc/win-exec';

const appRoot = join(__dirname, '..');
const VITE_NODE = join(appRoot, 'node_modules', 'vite-node', 'vite-node.mjs');
/** 现成的注入件：只用它的 parentPortMessage 通道发 shutdown，不改它。 */
const INJECT = join(__dirname, 'minisd-crash-inject.cjs');

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(25);
  }
}

// ---------- 请求消息的配对断言 ----------

interface PartLike { type: string; value: unknown }
interface MessageLike { role: string; parts: PartLike[] }
const idOf = (p: PartLike): string => (p.value as { toolUseId: string }).toolUseId;
const sorted = (ids: string[]): string => [...ids].sort().join(',');

/**
 * 对一份将要发给 provider 的消息数组断言「工具调用与结果严格配对」（Anthropic / OpenAI 的要求）：
 *  - 每条带 toolUse 的 assistant 后面紧跟一条 user 消息，这条消息开头的 toolResult 的 id 多重集恰好等于那条 assistant 的 toolUse id 多重集；
 *  - 除此之外任何消息里都没有 toolResult（游离的、重复的、被别的消息隔开的都算）。
 * 不符合就抛，带上是第几条消息。
 */
export function assertPaired(messages: readonly MessageLike[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = i > 0 ? messages[i - 1] : undefined;
    const owed = prev && prev.role === 'assistant' ? prev.parts.filter(p => p.type === 'toolUse').map(idOf) : [];
    const have = m.parts.filter(p => p.type === 'toolResult').map(idOf);
    if (owed.length === 0) {
      if (have.length > 0) throw new Error(`第 ${i} 条消息带着 toolResult（${have.join(', ')}），但它前面紧邻的不是声明这些调用的 assistant`);
      continue;
    }
    if (m.role === 'assistant') throw new Error(`第 ${i - 1} 条 assistant 的工具调用（${owed.join(', ')}）后面没有紧跟结果消息`);
    let lead = 0;
    while (lead < m.parts.length && m.parts[lead].type === 'toolResult') lead++;
    if (m.parts.slice(lead).some(p => p.type === 'toolResult')) throw new Error(`第 ${i} 条消息的 toolResult 没有全部排在开头`);
    if (sorted(owed) !== sorted(have)) {
      throw new Error(`第 ${i} 条消息的结果（${have.join(', ') || '无'}）与第 ${i - 1} 条 assistant 的调用（${owed.join(', ')}）对不上`);
    }
  }
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && last.parts.some(p => p.type === 'toolUse')) {
    throw new Error('最后一条 assistant 的工具调用后面没有结果消息');
  }
}

// ---------- RPC 客户端 ----------

export interface Notification { method: string; params: any }

export function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  const notifications: Notification[] = [];
  const listeners: ((n: Notification) => void)[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    else if (msg.method) {
      const n = { method: msg.method, params: msg.params };
      notifications.push(n);
      for (const l of listeners) { try { l(n); } catch { /* 监听者的错误不影响收消息 */ } }
    }
  });
  // 连接断了（引擎被强杀）：挂着的调用按错误了结，测试不会卡死在一个永远不回的 call 上
  ws.on('close', () => { for (const [id, res] of pending) { res({ error: { message: '连接已断开' } }); pending.delete(id); } });
  ws.on('error', () => undefined);
  const ready = new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, notifications, onNotify: (l: (n: Notification) => void) => { listeners.push(l); }, close: () => ws.close() };
}
export type Client = ReturnType<typeof rpcClient>;

export const cardsOf = (c: Client, sessionId?: string): Notification[] =>
  c.notifications.filter(n => n.method === 'permission.request' && (sessionId === undefined || n.params.req.sessionId === sessionId));
export const eventsOf = (c: Client, sessionId: string): any[] =>
  c.notifications.filter(n => n.method === 'chat.event' && n.params.sessionId === sessionId && n.params.event !== undefined).map(n => n.params.event);

/** 对这些会话的权限卡自动回 allow-once（其余会话的卡不动）。sessions 是活的集合：先挂监听、再往里加会话 id。 */
export function autoAllow(c: Client, sessions: Set<string>): void {
  c.onNotify(n => {
    if (n.method !== 'permission.request' || !sessions.has(n.params.req.sessionId)) return;
    void c.call('permission.respond', { requestId: n.params.requestId, decision: 'allow-once' });
  });
}

/** chat.runs.snapshot；方法不存在（F05 之前的基线）时返回 undefined，调用方据此跳过这一项核对。 */
export async function runsSnapshot(c: Client, q?: { sessionId?: string; runId?: string }): Promise<any | undefined> {
  const r = await c.call('chat.runs.snapshot', q ?? {});
  return r.error ? undefined : r.result;
}

// ---------- 真实引擎进程 ----------

export interface Engine {
  child: ChildProcess; pid: number; port: number; token: string;
  stdout(): string; stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** 经 stdin 发一条 parentPort 消息（主进程发 shutdown 的那条通道）。 */
  post(message: unknown): void;
}

/**
 * 起一个真实的引擎进程：产品的 standalone 分支（DESKMINIS_STANDALONE=1），vite-node 直接跑 src/minisd/index.ts。
 * 凭据走数据根里的文件库（DESKMINIS_E2E=1，跨进程稳定、不碰开发机 keyring）；不设 DESKMINIS_TEST / DESKMINIS_FAKE_PROVIDER。
 * 从 stdout 读握手行拿端口与 token；handshakeMs 内没握手就抛（附 stderr）。
 */
export function spawnEngine(dataDir: string, extraEnv: Record<string, string> = {}, handshakeMs = 60_000): Promise<Engine> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...extraEnv,
    ELECTRON_RUN_AS_NODE: '1', DESKMINIS_STANDALONE: '1', DESKMINIS_E2E: '1',
    DESKMINIS_DATA_DIR: dataDir, DESKMINIS_LOG_DIR: join(dataDir, 'logs'),
  };
  delete env.DESKMINIS_TEST;
  delete env.DESKMINIS_FAKE_PROVIDER;
  delete env.MINISD_HOST;
  const child = spawn(process.execPath, ['-r', INJECT, VITE_NODE, 'src/minisd/index.ts'], { cwd: appRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(res => { child.on('exit', (code, signal) => res({ code, signal })); });
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => { err += d; });
  child.stdout!.setEncoding('utf8');
  return new Promise<Engine>((resolve, reject) => {
    let done = false;
    const fail = (why: string): void => {
      if (done) return; done = true; clearTimeout(timer);
      reject(new Error(`${why}\n--- stderr ---\n${err.slice(-4000)}`));
    };
    const timer = setTimeout(() => { killTreeOfPid(child.pid); fail(`引擎 ${handshakeMs}ms 内没有握手`); }, handshakeMs);
    child.on('error', e => fail(`引擎进程起不来: ${String(e)}`));
    void exited.then(x => fail(`引擎在握手前退出（code=${x.code} signal=${x.signal}）`));
    child.stdout!.on('data', (d: string) => {
      out += d;
      if (done) return;
      for (const line of out.split('\n')) {
        if (!line.includes('"minisdPort"')) continue;
        let hs: { minisdPort?: number; authToken?: string };
        try { hs = JSON.parse(line.trim()); } catch { continue; }
        if (typeof hs.minisdPort !== 'number' || typeof hs.authToken !== 'string') continue;
        done = true; clearTimeout(timer);
        resolve({
          child, pid: child.pid!, port: hs.minisdPort, token: hs.authToken, exited,
          stdout: () => out, stderr: () => err,
          post: message => { child.stdin!.write(JSON.stringify({ parentPortMessage: message }) + '\n'); },
        });
        return;
      }
    });
  });
}

function killTreeOfPid(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // 只按 PID 杀测试自己起的那棵树（/T 连同它起的子进程）；绝对路径，不按进程名。调用方要保证这个 pid 此刻确实还是自己的进程
    spawnSync(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已经不在了 */ }
  }
}

/** killTree 用到的那几样（自检用例拿一个普通子进程充当引擎）。 */
export type EngineProc = Pick<Engine, 'child' | 'pid' | 'exited'>;

/** 引擎结束之后，等它的直接子进程随作业对象一起结束的上限。实测是立即结束的（见 killTree 的说明）。 */
const CHILD_REAP_WAIT_MS = 1000;

/**
 * pid 现在指的进程是不是这台引擎起的子进程（Windows）：父进程号等于引擎的 pid，而且创建时刻不晚于我们看到引擎退出的时刻。
 * 父进程死后 ParentProcessId 不变；引擎的 pid 在它退出之前一直被测试进程握着句柄、不会被复用，所以满足这两条的只可能是
 * 这台引擎活着时起的进程。查不到、对不上、查询本身失败都返回 false。
 * 非 Windows 上父进程一死子进程就被 init 收养，认不出来：一律 false（宁可留一个自己会超时退出的脚本，也不按 pid 盲杀）。
 */
function isChildOfEngine(pid: number, enginePid: number, engineGoneAt: number): boolean {
  if (process.platform !== 'win32') return false;
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; `
    + 'if ($p) { "$($p.ParentProcessId) $(([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds())" }';
  const r = spawnSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const m = /^(\d+) (\d+)\s*$/m.exec(typeof r.stdout === 'string' ? r.stdout : '');
  return m !== null && Number(m[1]) === enginePid && Number(m[2]) <= engineGoneAt;
}

/**
 * 强杀引擎，等它退出。已经退出的引擎不做任何事（也不动 descendants）。只按 PID，不按进程名。
 *
 * 不给 descendants：taskkill /T 整棵树一把杀（清理用）。引擎的句柄还握在测试进程手里，它的 pid 不会被复用。
 *
 * 给了 descendants（引擎起的子进程 pid，测试从计数文件里读到的 PowerShell 驱动；可以是空数组）：只结束引擎本身。
 * 为什么不用 /T：它是从叶子杀起的——引擎会在自己被结束之前先看到 PowerShell 驱动死掉，把正在跑的 shell 调用记成
 * 「shell 进程意外退出」（失败、结果已提交），放锁后还会接着调度后面的调用。那是另一个故障，不是要注入的「引擎被杀」
 * （全量并行负载下实测撞到过）。只结束引擎，它就来不及观察到任何子进程的结局。
 *
 * 引擎一死，它的直接子进程随 libuv 的作业对象被系统一并结束（本机实测：taskkill 返回时 PowerShell 驱动已经不在）。
 * 所以这之后 descendants 里的 pid 正常情况下都已释放：不能再拿它们去 taskkill——那个 pid 若恰好被别的进程复用，
 * 杀掉的就是一棵无关的进程树（这台机器上同时有别的工作流在起进程）。这里只做两件事：
 *  - 等它们消失（最多 CHILD_REAP_WAIT_MS）；
 *  - 到点还活着的，先核对它确实是这台引擎起的子进程（isChildOfEngine），对得上才按 PID 结束它那棵树；
 *    对不上、查不到的一律跳过。
 * 核对与结束之间仍隔着一次 taskkill 的启动时间：目标要在引擎死后活过一秒、又恰在这几十毫秒里退出并被复用才会误伤，不再设防。
 */
export async function killTree(engine: EngineProc, descendants?: readonly number[]): Promise<void> {
  const wasAlive = engine.child.exitCode === null && engine.child.signalCode === null;
  if (wasAlive) {
    if (descendants === undefined) killTreeOfPid(engine.pid);
    else if (process.platform === 'win32') {
      spawnSync(system32('taskkill.exe'), ['/PID', String(engine.pid), '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(engine.pid, 'SIGKILL'); } catch { /* 已经不在了 */ }
    }
  }
  await engine.exited;
  if (!wasAlive || descendants === undefined || descendants.length === 0) return;
  const engineGoneAt = Date.now();
  let left = descendants.filter(pidAlive);
  const deadline = Date.now() + CHILD_REAP_WAIT_MS;
  while (left.length > 0 && Date.now() < deadline) { await sleep(25); left = left.filter(pidAlive); }
  for (const pid of left) {
    if (isChildOfEngine(pid, engine.pid, engineGoneAt)) killTreeOfPid(pid);
  }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

// ---------- 假模型端点（OpenAI 兼容 SSE） ----------

export type LlmStep =
  | { tools: { name: string; input: Record<string, unknown> }[] }
  | { text: string }
  /** 收到请求后不应答（连接一直挂着，直到对端断开或端点关闭）。 */
  | { hang: true };

export interface LlmHit { at: number; tag?: string; step: number; messages: any[]; stream: boolean }

const TAG_RE = /\[\[(S\d+)\]\]/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
}

/**
 * 本地 OpenAI 兼容端点：POST <baseUrl>/chat/completions。
 * 剧本按请求里第一条 user 文本中的标签（[[S1]]…）选；第几步 = 请求里 assistant 消息的条数（重试同一步不会串步）。
 * 没有标签、或剧本走完的请求回一段短文本（自动命名等）。每个请求的时刻与 messages 都记下来。
 * 工具调用的 id 是确定的：call_<标签>_<步>_<下标>。
 */
export async function mockLlm(scripts: Record<string, LlmStep[]>): Promise<{
  baseUrl: string; hits: LlmHit[]; hitsOf(tag: string): LlmHit[]; close(): Promise<void>;
}> {
  const hits: LlmHit[] = [];
  const sockets = new Set<Socket>();
  const sse = (res: ServerResponse, model: string, step: LlmStep | undefined, tag: string | undefined, stepNo: number, usage: boolean): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = `chatcmpl-f05-${hits.length}`;
    const created = Math.floor(Date.now() / 1000);
    const send = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
    const chunk = (delta: unknown, finish: string | null = null): unknown =>
      ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
    send(chunk({ role: 'assistant', content: '' }));
    if (step && 'tools' in step) {
      step.tools.forEach((t, i) => {
        send(chunk({ tool_calls: [{ index: i, id: `call_${tag}_${stepNo}_${i}`, type: 'function', function: { name: t.name, arguments: '' } }] }));
        send(chunk({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(t.input) } }] }));
      });
      send(chunk({}, 'tool_calls'));
    } else {
      send(chunk({ content: step && 'text' in step ? step.text : '好的' }));
      send(chunk({}, 'stop'));
    }
    if (usage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.write('data: [DONE]\n\n');
    res.end();
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => { raw += d; });
    req.on('end', () => {
      let body: any;
      try { body = JSON.parse(raw); } catch { res.writeHead(400).end('bad json'); return; }
      const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
      const firstUser = messages.find(m => m?.role === 'user');
      const tag = TAG_RE.exec(textOf(firstUser?.content))?.[1];
      const stepNo = messages.filter(m => m?.role === 'assistant').length;
      const step = tag ? scripts[tag]?.[stepNo] : undefined;
      hits.push({ at: Date.now(), tag, step: stepNo, messages, stream: body.stream === true });
      if (step && 'hang' in step) return; // 不应答
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-f05', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: step && 'text' in step ? step.text : '好的' }, finish_reason: 'stop' }] }));
        return;
      }
      sse(res, String(body.model ?? ''), step, tag, stepNo, body.stream_options?.include_usage === true);
    });
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`, hits,
    hitsOf: tag => hits.filter(h => h.tag === tag),
    close: () => new Promise<void>(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

// ---------- 读库、读文件 ----------

/** 只读连接查一次就关（不占着库文件；引擎活着、死了都能读）。 */
export function readDb<T = any>(dataDir: string, sql: string, ...args: unknown[]): T[] {
  const db = new Database(join(dataDir, 'minis.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
}

/** 文件的非空行；文件不存在是空数组。
 *  写它的是另一个进程（PowerShell 的 Add-Content 写入那一瞬间独占文件，Windows 上读会撞 EBUSY）：短暂重试，仍读不到才抛。 */
export function lines(file: string): string[] {
  for (let attempt = 0; ; attempt++) {
    if (!existsSync(file)) return [];
    try {
      return readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() !== '');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') || attempt >= 50) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // 同步等 10ms 再读
    }
  }
}

// ---------- 带闸的 PowerShell 脚本 ----------

/**
 * 真实副作用的计数脚本（fx 是每个会话独立的目录，路径里不能有单引号）：
 *  - 进门先往 started.log 追加一行（行数 = 脚本被启动的次数）；
 *  - 等 go 文件出现：出现后往 effects.log 追加一行（行数 = 副作用发生的次数），再等 release；
 *  - 两段等待共用一个上限（waitSeconds，小于 shell 工具自己的超时），到点自己退出。
 * 不放 go：停在副作用之前；预先放好 go：做完副作用后停住。
 */
export function gatedScript(fx: string, waitSeconds = 100): string {
  return [
    `Add-Content -LiteralPath '${fx}\\started.log' -Value $PID`,
    `$until = (Get-Date).AddSeconds(${waitSeconds})`,
    `while (-not (Test-Path -LiteralPath '${fx}\\go') -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 50 }`,
    `if (Test-Path -LiteralPath '${fx}\\go') {`,
    `  Add-Content -LiteralPath '${fx}\\effects.log' -Value 'x'`,
    `  while (-not (Test-Path -LiteralPath '${fx}\\release') -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 50 }`,
    `}`,
    `'fx-done'`,
  ].join('\n');
}
