import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolExecutor } from './types';
import { askPermission } from './permission-outcome';
import { permissionFailure } from './permission-text';
import { killTree, powershellPath, type ProcOpts } from '../proc/win-exec';
import { childEnv } from '../proc/child-env';
import type { OwnedTree, ProcSupervisor, ProcTreeMeta } from '../proc/owned';
import type { ProcStopCause } from '../../shared/proc';
import { cancelCauseOf } from '../../shared/permission';
import { ShellOutput, SHELL_OUTPUT_LIMIT } from './shell-output';
import { isReadonlyCommand } from './permissions';
import { LOWER_HOOK_PS, SANDBOX_LOWER_PS, SANDBOX_NATIVE_PS, SANDBOX_REFUSED_EXIT, SANDBOX_REFUSED_TEXT, overrideEnv, type ShellSandbox } from '../proc/sandbox';

const MAX_OUTPUT = SHELL_OUTPUT_LIMIT;

/** 「在沙箱外运行」的卡上那句话（执行隔离第 3 步）。 */
export const SANDBOX_OUTSIDE_NOTE = '要求在命令隔离的沙箱外运行：能读写你的全部文件和 DeskMinis 的数据，完全访问档下也每次询问';

/** 超时/取消杀掉常驻驱动后，下一条命令必须带上这句——cd/环境变量已复位，
 *  模型若还按「跨命令持久」的假设继续，会拿着旧状态做错事。 */
const RESET_HINT = '[提示：shell 已重启，工作目录与环境变量已复位到初始状态]';

/** 驱动脚本。hook 是 F09 的插入点：读到第一条命令、判过 EOF 之后，执行它之前的一行（归属，见 proc/own-script.ts）。
 *  hook 为空串时与 F09 之前的脚本逐字相同。 */
export const driverPs = (hook: string): string => `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 上一行只管 PowerShell 自身 .NET 输出的编码；原生 exe 按控制台代码页吐字节，
# 中文 Windows 默认 936/GBK——chcp 把控制台代码页切到 UTF-8，多数原生 exe 会跟随
chcp 65001 | Out-Null
# 反方向：PowerShell 经管道喂给原生 exe 的 stdin 编码（默认跟随旧代码页，需一并切）
$OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
${hook === '' ? '' : `  ${hook}\n`}  $sp = $line.IndexOf(' ')
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
const DRIVER_PS = driverPs('');

/** 问驱动此刻在哪个目录（隔离方案第 1 步：只读命令的相对路径按它解析）。包在 & { } 里，不在会话作用域留下变量；
 *  不是文件系统位置（cd 到了 HKLM: 之类）时回空。路径按 UTF-8 转 base64，避开控制台编码。 */
const LOCATION_QUERY = "& { $l = Get-Location; if ($l.Provider.Name -eq 'FileSystem') { [Console]::Out.WriteLine('__MINIS_LOC_' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($l.ProviderPath)) + '__') } else { [Console]::Out.WriteLine('__MINIS_LOC___') } }";
const LOCATION_RE = /__MINIS_LOC_([A-Za-z0-9+/=]*)__/;
const LOCATION_TIMEOUT_MS = 10_000;

/** run 的附加选项。keepsLocation：这条命令改不了当前目录，跑完之后记下的位置仍然有效。
 *  internal：宿主自己发的查询，不消费「shell 已重启」的提示（那句话要留给模型的下一条命令）。 */
export interface RunOptions { keepsLocation?: boolean; internal?: boolean }

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

  private readonly platform: string;
  private readonly spawnImpl: typeof spawn;
  private readonly sysEnv: NodeJS.ProcessEnv;
  /** F09：进程树的登记与托管。没有（或没给 meta）时启动形态与回收路径同 F09 之前，逐字不变。 */
  private readonly supervisor: ProcSupervisor | undefined;
  /** 当前驱动对应的那棵树（与 proc 同生共换）。 */
  private tree: OwnedTree | undefined;
  /** 已知的当前目录（隔离方案第 1 步）。只对记下它时的那个驱动有效；跑过可能改目录的命令就作废，下次用时再问驱动。 */
  private loc: { proc: ChildProcessWithoutNullStreams; path: string } | undefined;

  /** env：会话级环境变量（MINIS_CHAT_SESSION_ID/桥管道等），在 shell 首次创建时捕获——长驻进程出生后无法改环境。
   *  opts：平台、spawn 与本进程环境的注入，生产用缺省值（见 proc/win-exec.ts）。
   *  cwd 只读公开（F04）：驱动的出生目录，被杀后重建用的仍是它；ShellManager.cwdOf 读它来算锁范围。
   *  meta（F09）：这棵进程树归谁；与 opts.supervisor 都在时，驱动带归属前导并登记进进程账本。 */
  constructor(readonly cwd: string, private env?: Record<string, string>, opts: ProcOpts = {}, private readonly meta?: ProcTreeMeta, sandbox?: ShellSandbox) {
    this.platform = opts.platform ?? process.platform;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.sysEnv = opts.sysEnv ?? process.env;
    this.supervisor = opts.supervisor;
    // 执行隔离第 3 步：沙箱只在 Windows 上有意义；标签打完之前（ready）队列里的命令都等着，驱动也不起
    // ready 落定为 false：这台机器上开不了沙箱（数据目录所在的盘不支持标签），照原级别跑
    this.sandbox = this.platform === 'win32' ? sandbox : undefined;
    if (this.sandbox) this.queue = this.sandbox.ready.then(ok => { if (ok === false) this.sandbox = undefined; }, () => undefined);
  }

  /** 执行隔离第 3 步：开了沙箱时驱动在执行第一条命令之前把自己降到低完整性级别（proc/sandbox.ts）。 */
  private sandbox: ShellSandbox | undefined;

  /** 这个 shell 跑在沙箱里吗（开了沙箱且在 Windows 上）。 */
  get sandboxed(): boolean { return this.sandbox !== undefined; }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    // F09：托管可用时驱动带归属前导——读到第一条命令之后、执行它之前，自己建作业并把自己放进去（proc/own-script.ts）。
    // 托管不可用（非 win32、已停用、没有 supervisor）时用的就是原来的脚本
    const armed = this.meta !== undefined && this.supervisor?.wants(this.platform) === true;
    // 执行隔离第 3 步：沙箱的降级排在归属之后（作业照常建在原级别下），执行第一条命令之前；降不下去驱动自己退出，不执行命令
    const sbx = this.sandbox !== undefined;
    const lowered = (hook: string): string => SANDBOX_NATIVE_PS + SANDBOX_LOWER_PS + driverPs(hook === '' ? LOWER_HOOK_PS : `${hook}\n  ${LOWER_HOOK_PS}`);
    const script = armed
      ? this.supervisor!.armedDriver(sbx ? lowered : driverPs)
      : (sbx ? lowered('') : DRIVER_PS);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    // win32 用 System32 下的绝对路径：cwd 是工作区（可能是克隆来的仓库），裸名会先在 cwd 里找同名 exe。
    // 非 win32 保留裸名，Linux 上 shell.test.ts 的失败与通过逐例不变。
    // windowsHide：打包后的 minisd 自己没有控制台（推断），控制台程序不加这一项会另开一个可见的控制台窗口。
    const exe = this.platform === 'win32' ? powershellPath(this.sysEnv) : 'powershell.exe';
    // -ExecutionPolicy Bypass（W3-ps，真机验证报告 §3.2）：Windows 客户端默认策略是 Restricted，npm / npx / pnpm / yarn 会先解析到
    // 同名 .ps1 垫片而被挡下，agent 跑不了它们（set-executionpolicy 在危险规则里，agent 也改不了——这是对的）。
    // 只作用于这个进程（从它里面再起的 PowerShell 经 PSExecutionPolicyPreference 继承）、不改系统设置；组策略设定的执行策略仍优先，
    // 那样的机器上照旧被挡。执行策略不是安全边界，命令照旧逐条过权限网关。-EncodedCommand 必须留在最后。
    const proc = this.spawnImpl(exe, ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      // 剥掉 DESKMINIS_*（§3 第 10 条，见 proc/child-env.ts）；会话级变量与 ELECTRON_RUN_AS_NODE 照旧
      // 沙箱里 TEMP 与缓存指到 agent 根下（Low 进程写不了原来的位置）
      env: overrideEnv(childEnv(this.sysEnv, this.env ? { ELECTRON_RUN_AS_NODE: '1', ...this.env } : undefined), this.sandbox?.env),
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
    // （之后再也拿不回字节做兜底解码）。保持流吐 Buffer，流式保留两种解码的受限头部。
    if (this.supervisor && this.meta) {
      // F09：登记这棵树。adopt 自己在 stderr 上挂了 data 监听（从里面摘归属标记），等价于排空，不再 resume
      this.tree = this.supervisor.adopt(proc, this.meta, { platform: this.platform, spawnImpl: this.spawnImpl, sysEnv: this.sysEnv }, { armed });
    } else {
      this.tree = undefined;
      proc.stderr.resume(); // 驱动已 2>&1 并入 stdout；排空真实 stderr 管道避免写满阻塞
    }
    this.proc = proc;
    this.loc = { proc, path: this.cwd }; // 新驱动在出生目录里
    return proc;
  }

  /** 驱动此刻的当前目录（隔离方案第 1 步）。驱动还没起或已经没了：下一条命令在出生目录里跑，就是它。
   *  说不清（查询超时、不在文件系统里、已释放）时返回 undefined。查询排在命令队列里，不会插到正在跑的命令中间。 */
  async location(): Promise<string | undefined> {
    if (this.disposed) return undefined;
    const live = this.proc !== undefined && this.proc.exitCode === null && !this.proc.killed;
    if (!live) return this.cwd;
    if (this.loc !== undefined && this.loc.proc === this.proc) return this.loc.path;
    const r = await this.run(LOCATION_QUERY, LOCATION_TIMEOUT_MS, { keepsLocation: true, internal: true });
    const m = LOCATION_RE.exec(r.output);
    if (m === null || m[1] === '') return undefined;
    const path = Buffer.from(m[1], 'base64').toString('utf8');
    if (this.proc !== undefined && this.loc === undefined) this.loc = { proc: this.proc, path };
    return path;
  }

  /** 会话内串行：排队执行。 */
  run(command: string, timeoutMs = 120000, opts: RunOptions = {}): Promise<{ output: string; exitCode: number; durationMs: number }> {
    const next = this.queue.then(() => this.runNow(command, timeoutMs, opts));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private runNow(command: string, timeoutMs: number, opts: RunOptions = {}): Promise<{ output: string; exitCode: number; durationMs: number }> {
    // dispose() 后队列里剩余（或之后新来）的调用不得再 ensure()，否则会复活一个无人跟踪的孤儿进程。
    if (this.disposed) return Promise.resolve({ output: '[shell 已释放]', exitCode: 130, durationMs: 0 });
    // 上一轮把驱动杀了：本条命令跑在重建后的新进程上，cd/env 已复位，必须让模型知道
    const resetNote = this.wasReset && !opts.internal ? RESET_HINT + '\n' : '';
    if (!opts.internal) this.wasReset = false; // 只提示一次：紧接着的这条命令
    const proc = this.ensure();
    // 这条命令可能 cd 到别处：记下的位置作废（只读白名单里的命令改不了目录，留着）
    if (!opts.keepsLocation) this.loc = undefined;
    const marker = randomUUID().slice(0, 8);
    const sentinel = new RegExp(`__MINIS_DONE_${marker}_EXIT_(-?\\d+)__`);
    const started = Date.now();
    return new Promise(resolve => {
      const output = new ShellOutput();
      // latin1 视图上做哨兵匹配：latin1 每字节恰好映射一个字符，正则命中位置即字节偏移，
      // 可精确切出「本命令输出」的字节段再整体解码。前提是哨兵与退出码本身为纯 ASCII——
      // 在任何代码页下字节不变，latin1 视图不会失真（这是能按字节切割的根基）。
      // 驱动哨兵（8 位 marker + Int32 退出码）不到 64 字节。仅保留待匹配尾部，
      // 延后解码这些字节，保证跨块哨兵和同块的后续输出不会进入本条命令结果。
      let tail = Buffer.alloc(0);
      let receivedBytes = 0;
      const onData = (chunk: Buffer) => {
        const window = Buffer.concat([tail, chunk]);
        const m = sentinel.exec(window.toString('latin1'));
        if (m) {
          cleanup();
          // 全局偏移独立于受限的解码头部；丢弃中段后不拿头部长度定位哨兵。
          const end = receivedBytes - tail.length + m.index;
          output.append(window.subarray(0, end - output.bytes));
          resolve({ output: resetNote + output.finish(true), exitCode: Number(m[1]), durationMs: Date.now() - started });
        } else {
          const end = Math.max(0, window.length - 64);
          output.append(window.subarray(0, end));
          tail = Buffer.from(window.subarray(end));
          receivedBytes += chunk.length;
        }
      };
      const unfinishedOutput = () => { output.append(tail); return output.finish(false); };
      // 子进程没能答复就死了：也必须 resolve，绝不悬挂、绝不抛。
      const onError = (err: Error) => {
        cleanup();
        resolve({ output: `shell 启动失败: ${err.message}`, exitCode: 127, durationMs: Date.now() - started });
      };
      const onClose = () => {
        cleanup();
        // 沙箱降级失败：驱动已把原因写进输出（SANDBOX_REFUSED_TEXT），这条命令一行都没执行
        const refused = this.sandbox !== undefined && proc.exitCode === SANDBOX_REFUSED_EXIT;
        const out = unfinishedOutput();
        resolve(refused
          ? { output: (out.includes(SANDBOX_REFUSED_TEXT) ? out : `${out}\n${SANDBOX_REFUSED_TEXT}`) + '\n[命令隔离启动失败，shell 已退出]', exitCode: SANDBOX_REFUSED_EXIT, durationMs: Date.now() - started }
          : { output: out + '\n[shell 进程意外退出]', exitCode: 129, durationMs: Date.now() - started });
      };
      const timer = setTimeout(() => {
        cleanup();
        this.interrupt('timeout'); // 杀掉整个常驻驱动（cd/env 会丢），并标记 wasReset 供下条命令提示
        resolve({ output: unfinishedOutput() + '\n[命令超时被终止]', exitCode: 124, durationMs: Date.now() - started });
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
        // F09：第一份输入已写出，驱动此后才归属；从这一刻起等它的标记（重复调用无效）
        if (this.tree?.child === proc) this.tree.firstInput();
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
  interrupt(cause: ProcStopCause = 'cancel'): void {
    void this.killProc(cause); // 不等收树：在途命令靠 'close' 或超时收口，下条命令重建驱动，与以前一样
    this.proc = undefined; // 让下次 ensure() 重建，而不是复用已死的进程
    this.wasReset = true;
  }

  /** 返回回收落定的 Promise（见 killTree，从不拒绝）：关停第 6 步等它，删除会话不等（W1b-5d）。 */
  dispose(cause: ProcStopCause = 'session-deleted'): Promise<void> {
    this.disposed = true;
    const reaped = this.killProc(cause);
    this.proc = undefined;
    return reaped;
  }

  /** 杀整棵进程树（win32 走 taskkill /T，不同步先杀根，见 proc/win-exec.ts）：
   *  命令里起的孙进程（ping -t、dev server 之类）要跟着驱动一起走，只杀驱动会留孤儿。
   *  F09：登记过的树经 tree.stop——先记下原因，再走同一个 killTree（实参相同）；根一结束，它自建的作业关闭，
   *  taskkill /T 按父进程号找不到的后代也一并结束。 */
  private killProc(cause: ProcStopCause): Promise<void> {
    if (!this.proc) return Promise.resolve();
    if (this.tree?.child === this.proc) return this.tree.stop(cause, 'SIGKILL');
    return killTree(this.proc, this.platform, this.spawnImpl, this.sysEnv, 'SIGKILL');
  }
}

export class ShellManager {
  private shells = new Map<string, PersistentShell>();
  /** 执行隔离第 3 步：每个会话另有一个不在沙箱里的 shell，只跑用户批准过的「在沙箱外运行」的命令。与沙箱里的那个不共享目录与环境变量。 */
  private outside = new Map<string, PersistentShell>();

  /** opts 原样透传给每个会话的 PersistentShell（测试注入用；生产不传）。
   *  sandbox（执行隔离第 3 步）：开了沙箱时由 index.ts 给，每个会话的 shell 都跑在低完整性级别下。 */
  constructor(private readonly procOpts: ProcOpts = {}, private readonly sandbox?: ShellSandbox) {
    sandbox?.ready.then(ok => { if (ok === false) this.unavailable = true; }, () => undefined);
  }

  /** 沙箱的 ready 落定为 false（这台机器上开不了）。 */
  private unavailable = false;
  /** 已经给模型说过的工作区说明（会话 + 目录）：每个只说一次。 */
  private notesShown = new Set<string>();

  /** 开了命令隔离吗（且在 Windows 上，且没有落定为开不了）。 */
  get sandboxed(): boolean { return this.sandbox !== undefined && !this.unavailable && (this.procOpts.platform ?? process.platform) === 'win32'; }

  /** 执行隔离第 3 步：沙箱里的命令要在 dir 里跑之前调用（给 agent 根以外的工作区打 Low 标签）。
   *  返回要附在这条命令输出前面的说明：同一会话同一目录只返回一次。没开沙箱时什么也不做。 */
  async prepareWorkspace(sessionId: string, dir: string): Promise<string | undefined> {
    if (!this.sandboxed || !this.sandbox?.workspace) return undefined;
    await this.sandbox.ready.catch(() => undefined);
    if (!this.sandboxed) return undefined;
    const note = await this.sandbox.workspace(dir).catch(() => undefined);
    if (note === undefined) return undefined;
    const key = `${sessionId}\0${dir}`;
    if (this.notesShown.has(key)) return undefined;
    this.notesShown.add(key);
    return note;
  }

  getShell(sessionId: string, cwd: string, env?: Record<string, string>, outside = false): PersistentShell {
    if (outside && this.sandboxed) {
      let o = this.outside.get(sessionId);
      if (!o) { o = new PersistentShell(cwd, env, this.procOpts, { kind: 'shell', sessionId }); this.outside.set(sessionId, o); }
      return o;
    }
    let s = this.shells.get(sessionId);
    if (!s) { s = new PersistentShell(cwd, env, this.procOpts, { kind: 'shell', sessionId }, this.sandbox); this.shells.set(sessionId, s); }
    return s;
  }

  /** 隔离方案第 1 步：该会话的命令此刻会在哪个目录里跑。还没建 shell 时是 fallback（工作区，shell 会在那里出生）。 */
  locationOf(sessionId: string, fallback: string): Promise<string | undefined> {
    const s = this.shells.get(sessionId);
    return s === undefined ? Promise.resolve(fallback) : s.location();
  }

  /** F04：该会话常驻 shell 的出生目录（没建过返回 undefined）。只读，给调度器算锁范围用：
   *  getShell 只在首次创建时用 cwd，会话中途改了工作区之后 shell 仍在旧目录里跑。 */
  cwdOf(sessionId: string): string | undefined { return this.shells.get(sessionId)?.cwd; }

  run(sessionId: string, cwd: string, command: string, timeoutMs?: number, env?: Record<string, string>, opts?: RunOptions & { outside?: boolean }): Promise<{ output: string; exitCode: number; durationMs: number }> {
    return this.getShell(sessionId, cwd, env, opts?.outside === true).run(command, timeoutMs, opts);
  }

  /** 会话级中断（取消时由 shell 工具的 abort 监听触发）：杀该会话当前驱动，下条命令自动重建。 */
  interrupt(sessionId: string, cause?: ProcStopCause): void {
    this.shells.get(sessionId)?.interrupt(cause);
    this.outside.get(sessionId)?.interrupt(cause);
  }

  /** 会话级释放（供删除会话调用，W1b-4 接线）：回收该会话驱动的整棵进程树并从表里摘掉。
   *  与 interrupt 的区别同 PersistentShell：这里是会话不再需要 shell。未知会话静默。
   *  返回回收落定的 Promise；删除会话不等它，行为照旧。 */
  dispose(sessionId: string, cause: ProcStopCause = 'session-deleted'): Promise<void> {
    const reaped = this.shells.get(sessionId)?.dispose(cause) ?? Promise.resolve();
    const reapedOutside = this.outside.get(sessionId)?.dispose(cause) ?? Promise.resolve();
    this.shells.delete(sessionId);
    this.outside.delete(sessionId);
    return Promise.all([reaped, reapedOutside]).then(() => undefined);
  }

  /** 关停收口（W1b-5d）：释放全部会话的驱动，返回全部回收落定的 Promise（从不拒绝），关停第 6 步等它。
   *  一个会话的回收同步抛错只记一笔，其余会话照样回收：不然排在它后面的进程树都没人收。 */
  disposeAll(): Promise<void> {
    const reaped: Promise<void>[] = [];
    for (const [sessionId, s] of [...this.shells, ...this.outside]) {
      try { reaped.push(s.dispose('shutdown')); } catch (e) { console.warn(`释放 shell（会话 ${sessionId}）失败，继续其余会话:`, e); }
    }
    this.shells.clear();
    this.outside.clear();
    return Promise.allSettled(reaped).then(() => undefined);
  }
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
        timeout_seconds: { type: 'integer', description: '超时秒数，范围 1–3600，默认 120；超出范围按边界执行，非有限数字按默认值执行' },
        sandbox: { type: 'boolean', description: '只在开了命令隔离时有意义。命令隔离下 shell 跑在低权限沙箱里：读写不了 DeskMinis 的数据，写不了工作区和临时目录以外的地方。确实要在沙箱外做的事（装系统软件、改用户配置）传 false，每次都要用户确认；没开命令隔离时忽略' },
        tool_title: { type: 'string', description: '这次调用的 5-10 字中文摘要，用于 UI 卡片' },
      },
      required: ['command', 'tool_title'],
    },
    // F04：命令会动什么说不清，恒为 barrier——同批里它前面的调用先跑完，后面的等它跑完；不借 classifyShellCommand 放宽
    // （那是权限分类器，读写目标解析不出来，cd / 环境变量还有跨命令状态）。
    // 跨会话占两处的写锁：当前工作区（文件工具按它解析相对路径；shell 还没建时也在它里面出生），
    // 以及常驻 shell 的出生目录——workspace.set / reset 不动已建的 shell，改过工作区后它仍在旧目录里跑。
    // 命令里 cd 到别处、用绝对路径写到这两个目录之外，调度器看不见。
    scheduling: {
      readOnly: false, concurrencySafe: false, sideEffects: 'unknown',
      resources: (_input, ctx) => {
        const dirs = [ctx.paths.workspaceOf(ctx.sessionId)];
        const born = manager.cwdOf(ctx.sessionId);
        if (born !== undefined) dirs.push(born);
        return dirs.map(path => ({ kind: 'path' as const, mode: 'write' as const, path }));
      },
    },
    async execute(input, ctx) {
      // 已取消（用户点了停止）：立即收场，不再发起权限询问、不再启动命令
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
      const command = String(input.command);
      // 执行隔离第 3 步：开了命令隔离、模型要求在沙箱外跑——每次都问（完全访问也问），卡上说明
      const outside = input.sandbox === false && manager.sandboxed;
      const req = outside
        ? { kind: 'shell' as const, detail: command, sessionId: ctx.sessionId, toolTitle: String(input.tool_title), outsideSandbox: true as const, note: SANDBOX_OUTSIDE_NOTE }
        : { kind: 'shell' as const, detail: command, sessionId: ctx.sessionId, toolTitle: String(input.tool_title) };
      const o = await askPermission(ctx, req);
      // 权限等待可长达 90 秒；等待期间点了停止的话，已 abort 的 signal 之后挂监听不会再触发
      // （abort 事件不补发）——必须在闸后重查一次，否则「批准晚于取消」的命令会原样跑完。
      // 先看取消、再看拒绝（W1b-5）：关停 / 删除会话时后台了结卡片并 abort，那不是用户拒绝的
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
      // F13：原因来自网关——危险命令是规则拦下的（RULE_BLOCKED，W1b-2g），超时是没人答复，只有用户点了拒绝才说「被用户拒绝」
      if (o.decision !== 'allow') return permissionFailure(o, req);
      const cwd = ctx.paths.workspaceOf(ctx.sessionId);
      const requested = input.timeout_seconds;
      const seconds = typeof requested === 'number' && Number.isFinite(requested) ? Math.min(3600, Math.max(1, requested)) : 120;
      const timeoutMs = seconds * 1000;
      const timeoutNote = requested === undefined || requested === seconds ? ''
        : 'timeout_seconds=' + String(requested) + ' 不在 1–3600 的有限数字范围内，已按 ' + seconds + ' 秒执行\n';
      // 执行期间监听取消：abort → 杀当前命令所在驱动。杀掉后会话积累的 cd/env 会丢，
      // 由 PersistentShell.wasReset 在下条命令开头给模型补说明。
      // F09：把取消的来由带给进程账本——删会话、关停原样记，其余（用户点了停止、请求方没了）记 cancel
      const onAbort = () => {
        const why = cancelCauseOf(ctx.signal);
        manager.interrupt(ctx.sessionId, why === 'session-deleted' || why === 'shutdown' ? why : 'cancel');
      };
      ctx.signal?.addEventListener('abort', onAbort);
      try {
        // 只读白名单里的命令改不了当前目录：跑完不必再问驱动在哪（隔离方案第 1 步）
        // 执行隔离第 3 步：沙箱里第一次在这个工作区跑命令前给它打 Low 标签；打不了的，在输出前面说一句
        const note = outside ? undefined : await manager.prepareWorkspace(ctx.sessionId, cwd);
        if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
        const r = await manager.run(ctx.sessionId, cwd, command, timeoutMs, envFor?.(ctx), { keepsLocation: isReadonlyCommand(command), ...(outside ? { outside } : {}) });
        let output = note === undefined ? r.output : `${note}\n${r.output}`;
        if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + `\n[输出超过 100KB 被截断]`;
        return { output: `${timeoutNote}${output}\n[exit=${r.exitCode}, ${r.durationMs}ms]`, success: r.exitCode === 0 };
      } finally {
        // 清理监听器：signal 是会话级长生命周期对象，不摘会随每次工具调用累积
        ctx.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
