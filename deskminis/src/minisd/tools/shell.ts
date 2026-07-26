import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ToolExecutor } from './types';

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

  constructor(private cwd: string) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    const encoded = Buffer.from(DRIVER_PS, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // spawn 失败（cwd 不存在 / ENOENT / EACCES）会在 child 上发 'error'；
    // 没有监听器时该事件会在事件循环里抛出并杀死整个 minisd 进程。常驻一个兜底监听器，
    // 并清掉缓存引用，使下次 ensure() 重建而不是复用僵尸。
    proc.on('error', () => { if (this.proc === proc) this.proc = undefined; });
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

  getShell(sessionId: string, cwd: string): PersistentShell {
    let s = this.shells.get(sessionId);
    if (!s) { s = new PersistentShell(cwd); this.shells.set(sessionId, s); }
    return s;
  }

  run(sessionId: string, cwd: string, command: string, timeoutMs?: number): Promise<{ output: string; exitCode: number; durationMs: number }> {
    return this.getShell(sessionId, cwd).run(command, timeoutMs);
  }

  disposeAll(): void { for (const s of this.shells.values()) s.dispose(); this.shells.clear(); }
}

export function makeShellTool(manager: ShellManager): ToolExecutor {
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
      const r = await manager.run(ctx.sessionId, cwd, command, timeoutMs);
      let output = r.output;
      if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + `\n[输出超过 100KB 被截断]`;
      return { output: `${output}\n[exit=${r.exitCode}, ${r.durationMs}ms]`, success: r.exitCode === 0 };
    },
  };
}
