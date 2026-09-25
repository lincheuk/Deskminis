import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { MinisPaths } from './paths';
import { killTree, powershellPath, type ProcOpts } from './proc/win-exec';
import { childEnv } from './proc/child-env';

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

  private readonly platform: string;
  private readonly spawnImpl: typeof spawn;
  private readonly sysEnv: NodeJS.ProcessEnv;

  /** opts：平台、spawn 与本进程环境的注入，生产用缺省值（见 proc/win-exec.ts）。 */
  constructor(
    private cwd: string,
    private emit: (data: string) => void,
    private env?: Record<string, string | undefined>,
    opts: ProcOpts = {},
  ) {
    this.platform = opts.platform ?? process.platform;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.sysEnv = opts.sysEnv ?? process.env;
  }

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
    // 与 PersistentShell 同因：win32 用 System32 绝对路径（cwd 是工作区，裸名会先在 cwd 里找）、windowsHide，
    // 子进程环境剥掉 DESKMINIS_*、叠上会话级 MINIS_*（值为 undefined 的跳过）。非 win32 保留裸名。
    const exe = this.platform === 'win32' ? powershellPath(this.sysEnv) : 'powershell.exe';
    const proc = this.spawnImpl(exe, ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv(this.sysEnv, this.env),
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
    // dispose 之后 taskkill 收树要几百毫秒，旧壳这段时间的输出不能再外发：
    // 会话删掉后同 id 重新 attach 的新终端会把它当成自己的输出显示出来。
    if (this.disposed) return;
    this.scrollback += chunk;
    if (this.scrollback.length > MAX_SCROLLBACK) this.scrollback = this.scrollback.slice(-MAX_SCROLLBACK);
    this.emit(chunk);
  }

  /** 返回回收落定的 Promise（见 killTree，从不拒绝）：关停第 6 步等它，删除会话不等（W1b-5d）。 */
  dispose(): Promise<void> {
    this.disposed = true;
    // 杀整棵树（win32 走 taskkill /T，不同步先杀根）：用户在终端里起的 dev server、ping -t 要跟着走。killTree 自己吞错。
    const reaped = this.proc ? killTree(this.proc, this.platform, this.spawnImpl, this.sysEnv, 'SIGKILL') : Promise.resolve();
    this.proc = undefined;
    return reaped;
  }
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  constructor(
    private paths: MinisPaths,
    private emit: (sessionId: string, data: string) => void,
    /** 为该会话构造的桥环境变量（MINIS_*），会在 powershell spawn 时注入 env（决策 #8：终端手动调桥命令）。 */
    private envFor?: (sessionId: string) => Record<string, string | undefined>,
    /** 原样透传给每个 TerminalSession（测试注入用；生产不传）。 */
    private procOpts: ProcOpts = {},
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

  /** 返回回收落定的 Promise；删除会话不等它，行为照旧。 */
  dispose(sessionId: string): Promise<void> {
    const reaped = this.sessions.get(sessionId)?.dispose() ?? Promise.resolve();
    this.sessions.delete(sessionId);
    return reaped;
  }

  /** 关停收口（W1b-5d）：销毁全部终端，返回全部回收落定的 Promise（从不拒绝），关停第 6 步等它。
   *  一个会话的回收同步抛错只记一笔，其余会话照样回收：不然排在它后面的终端树都没人收。 */
  disposeAll(): Promise<void> {
    const reaped: Promise<void>[] = [];
    for (const [sessionId, s] of this.sessions) {
      try { reaped.push(s.dispose()); } catch (e) { console.warn(`销毁终端（会话 ${sessionId}）失败，继续其余会话:`, e); }
    }
    this.sessions.clear();
    return Promise.allSettled(reaped).then(() => undefined);
  }

  private get(sessionId: string): TerminalSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      const env = this.envFor?.(sessionId) ?? {};
      s = new TerminalSession(this.paths.workspaceOf(sessionId), data => this.emit(sessionId, data), env, this.procOpts);
      this.sessions.set(sessionId, s);
    }
    return s;
  }
}
