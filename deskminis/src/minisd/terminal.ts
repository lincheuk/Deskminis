import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { MinisPaths } from './paths';

/** 滚动缓冲上限：超过后只保留末尾（xterm 也仅渲染可见区域 + 它自己的行缓存）。 */
const MAX_SCROLLBACK = 10_000 * 80;

/** 交互式终端驱动（与工具 shell 独立实例）：
 * - 驱动脚本 dot-source 用户命令（cd 跨输入持久；与 PersistentShell 的 System.Management.Automation.Runspace 模式不同，兼容性更好）
 * - 行结束：CR 或 LF；CR 后紧跟的 LF 用 Peek 吞掉（Windows 剪贴板 \r\n 不触发两次空执行）
 * - Backspace(8) 行内删除并回写「退格+空格+退格」；Ctrl+C(3) 清行并给新提示符
 * - 输出策略与工具 shell 一致：2>&1 并入、Out-String -Stream -Width 500 逐行写
 * - __minis_ 前缀的驱动内部名：用户命令是 dot-source 进驱动作用域执行的，普通名字（$buf 等）会被用户意外改写
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

  constructor(private cwd: string, private emit: (data: string) => void, private env?: Record<string, string | undefined>) {}

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
    const extraEnv = this.env ?? {};
    const procEnv: Record<string, string | undefined> = { ...process.env };
    for (const [k, v] of Object.entries(extraEnv)) if (v !== undefined) procEnv[k] = v;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: procEnv,
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
    try { this.proc?.kill('SIGKILL'); } catch { /* 杀失败不挂 */ }
    this.proc = undefined;
  }
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  constructor(
    private paths: MinisPaths,
    private emit: (sessionId: string, data: string) => void,
    /** 为该会话构造的桥环境变量（MINIS_*），会在 powershell spawn 时注入 env（决策 #8：终端手动调桥命令）。 */
    private envFor?: (sessionId: string) => Record<string, string | undefined>,
  ) {}

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
      const env = this.envFor?.(sessionId) ?? {};
      s = new TerminalSession(this.paths.sessionBucket(sessionId, 'workspace'), data => this.emit(sessionId, data), env);
      this.sessions.set(sessionId, s);
    }
    return s;
  }
}
