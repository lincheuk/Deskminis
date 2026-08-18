import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolExecutor } from './types';

const MAX_OUTPUT = 100 * 1024;

/** 超时/取消杀掉常驻驱动后，下一条命令必须带上这句——cd/环境变量已复位，
 *  模型若还按「跨命令持久」的假设继续，会拿着旧状态做错事。 */
const RESET_HINT = '[提示：shell 已重启，工作目录与环境变量已复位到初始状态]';

const DRIVER_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 上一行只管 PowerShell 自身 .NET 输出的编码；原生 exe 按控制台代码页吐字节，
# 中文 Windows 默认 936/GBK——chcp 把控制台代码页切到 UTF-8，多数原生 exe 会跟随
chcp 65001 | Out-Null
# 反方向：PowerShell 经管道喂给原生 exe 的 stdin 编码（默认跟随旧代码页，需一并切）
$OutputEncoding = [System.Text.Encoding]::UTF8
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

/** 宿主侧解码：驱动已把控制台切到 UTF-8，但仍拦不住硬编码 GBK 输出的老 exe。
 *  先按 UTF-8 解，无 U+FFFD 即直接用；含替换符说明字节不是合法 UTF-8（多半是 GBK），降级再解一次。
 *  只做「有替换符才降级」而非「先猜编码」：UTF-8 合法性校验是结构性的（多字节序列必须自洽），
 *  合法 UTF-8 中文几乎不可能恰好也是合理 GBK 文本；反向不成立——先猜会把正常 UTF-8 输出解成乱码。 */
export function decodeShellOutput(bytes: Buffer): string {
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(bytes); // Electron 自带 full-icu，gbk 标签可用
  } catch {
    return utf8; // 运行时不支持 gbk 解码器（非 full-icu 环境）：退回 UTF-8 结果，保持原行为
  }
}

export class PersistentShell {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /** 上一轮超时/取消把驱动杀掉了，进程内积累的 cd/env 已丢；下一条命令开头要提示模型。
   *  与 disposed 正交：会话仍是活跃的，只是 shell 状态被复位。 */
  private wasReset = false;

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
    // 不 setEncoding('utf8')：那会「按 UTF-8 解码后再拼接」，GBK 字节被解成替换符后原始信息不可逆丢失
    // （之后再也拿不回字节做兜底解码）。保持流吐 Buffer，由 runNow 收集后整体解码。
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
    // 上一轮把驱动杀了：本条命令跑在重建后的新进程上，cd/env 已复位，必须让模型知道
    const resetNote = this.wasReset ? RESET_HINT + '\n' : '';
    this.wasReset = false; // 只提示一次：紧接着的这条命令
    const proc = this.ensure();
    const marker = randomUUID().slice(0, 8);
    const sentinel = new RegExp(`__MINIS_DONE_${marker}_EXIT_(-?\\d+)__`);
    const started = Date.now();
    return new Promise(resolve => {
      const chunks: Buffer[] = [];
      // latin1 视图上做哨兵匹配：latin1 每字节恰好映射一个字符，正则命中位置即字节偏移，
      // 可精确切出「本命令输出」的字节段再整体解码。前提是哨兵与退出码本身为纯 ASCII——
      // 在任何代码页下字节不变，latin1 视图不会失真（这是能按字节切割的根基）。
      let out = '';
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        out += chunk.toString('latin1');
        const m = out.match(sentinel);
        if (m) {
          cleanup();
          const bytes = Buffer.concat(chunks).subarray(0, out.indexOf(m[0]));
          const output = resetNote + decodeShellOutput(bytes).replace(/\r\n/g, '\n').trimEnd();
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
        resolve({ output: decodeShellOutput(Buffer.concat(chunks)).replace(/\r\n/g, '\n') + '\n[shell 进程意外退出]', exitCode: 129, durationMs: Date.now() - started });
      };
      const timer = setTimeout(() => {
        cleanup();
        this.interrupt(); // 杀掉整个常驻驱动（cd/env 会丢），并标记 wasReset 供下条命令提示
        resolve({ output: decodeShellOutput(Buffer.concat(chunks)).replace(/\r\n/g, '\n') + '\n[命令超时被终止]', exitCode: 124, durationMs: Date.now() - started });
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

  /** 取消/超时导致的进程中断：杀当前驱动但不释放会话（disposed 保持 false），
   *  下次 ensure() 重建；同时标记 wasReset，让下一条命令开头向模型说明状态已复位。
   *  与 dispose() 的语义差异正是关键：dispose 是会话不再需要 shell，interrupt 是状态丢了但会话还活着。 */
  interrupt(): void {
    this.proc?.kill('SIGKILL');
    this.proc = undefined; // 让下次 ensure() 重建，而不是复用已死的进程
    this.wasReset = true;
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

  /** 会话级中断（取消时由 shell 工具的 abort 监听触发）：杀该会话当前驱动，下条命令自动重建。 */
  interrupt(sessionId: string): void {
    this.shells.get(sessionId)?.interrupt();
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
      // 已取消（用户点了停止）：立即收场，不再发起权限询问、不再启动命令
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
      const command = String(input.command);
      const decision = await ctx.permissions.check({ kind: 'shell', detail: command, sessionId: ctx.sessionId, toolTitle: String(input.tool_title) });
      if (decision === 'deny') return { output: '命令被用户拒绝（可在设置-权限中调整）', success: false };
      // 权限等待可长达 90 秒；等待期间点了停止的话，已 abort 的 signal 之后挂监听不会再触发
      // （abort 事件不补发）——必须在闸后重查一次，否则「批准晚于取消」的命令会原样跑完。
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
      const cwd = ctx.paths.workspaceOf(ctx.sessionId);
      const timeoutMs = (typeof input.timeout_seconds === 'number' ? input.timeout_seconds : 120) * 1000;
      // 执行期间监听取消：abort → 杀当前命令所在驱动。杀掉后会话积累的 cd/env 会丢，
      // 由 PersistentShell.wasReset 在下条命令开头给模型补说明。
      const onAbort = () => manager.interrupt(ctx.sessionId);
      ctx.signal?.addEventListener('abort', onAbort);
      try {
        const r = await manager.run(ctx.sessionId, cwd, command, timeoutMs, envFor?.(ctx));
        let output = r.output;
        if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + `\n[输出超过 100KB 被截断]`;
        return { output: `${output}\n[exit=${r.exitCode}, ${r.durationMs}ms]`, success: r.exitCode === 0 };
      } finally {
        // 清理监听器：signal 是会话级长生命周期对象，不摘会随每次工具调用累积
        ctx.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
