/* 部分改编自 pi-mono（https://github.com/badlogic/pi-mono）
 *   上游：packages/coding-agent/src/utils/shell.ts:216-232（killProcessTree 的 win32 分支） @ 8676a0d
 *   许可：MIT，Copyright (c) 2025 Mario Zechner（全文见仓库根 THIRD-PARTY-NOTICES.md）
 *   本文件已修改：SystemRoot 先校验是盘符开头的绝对路径，否则回落 C:\Windows，路径用 path.win32 拼；不设 detached；
 *   taskkill 出错或非 0 退出时再兜底杀根进程；根进程已退出时什么都不做（旧 pid 可能已被复用）；
 *   返回在 taskkill 退出（或兜底之后）才落定、从不拒绝的 Promise，关停时等它；
 *   平台、spawn 与环境可注入；另加 system32、powershellPath 两个路径函数。 */

/**
 * Windows 子进程的启动路径与进程树回收（W1b-1 · 止血波设计稿 §2「工具层」；侦察 tools.md W1b-killtree）。
 *
 * 为什么要绝对路径：shell、终端、MCP 的 cmd.exe 都以工作区或配置里的目录为 cwd 启动。裸名 'powershell.exe' 按
 * Windows 的查找顺序会先找子进程 cwd 里的同名文件，再查 PATH——克隆来的仓库根目录里放一个 powershell.exe 就会被执行。
 * System32 下的绝对路径不走这套查找。
 *
 * 为什么不先杀根进程：taskkill /T 按父进程号找整棵树。以前起 taskkill 的同时就同步 child.kill()，
 * 根进程多半在 taskkill 枚举之前就没了，/T 扑空，npx 拉起的 node、shell 里起的 ping -t 这些孙进程照样活着。
 * 现在只起 taskkill，它出错（找不到文件、被拦）或非 0 退出（没杀干净、没找到进程）时才兜底杀根。
 * 代价是 interrupt 之后旧驱动还要活几百毫秒；超时路径已先以 124 收口，interrupt 路径靠 'close' 结算，
 * taskkill 失败时必有兜底，所以不会悬挂。
 *
 * 为什么关停要等 taskkill 跑完（W1b-5d 订正；依据是 libuv 源码 src/win/process.c 的 uv__init_global_job_handle
 * 与 uv_spawn，没有在 Windows 真机上验证过）：libuv 把非 detached 的子进程放进一个全局作业对象，作业带
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，minisd 一退，作业句柄关闭，作业里的进程被系统一并结束。但作业同时带
 * JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK（源码注释原话：only the processes that we explicitly add are affected,
 * and *their* subprocesses are not），只收 minisd 亲手起的直接子进程——cmd.exe、powershell.exe，还有 taskkill 自己；
 * 它们再起的孙进程（npx 拉起的 node、终端里的 dev server、shell 里的 ping -t）不在作业里，minisd 退了照样活着。
 * 这里原先写的「minisd 一退出整棵树由系统回收」不成立。孙进程只有 taskkill /T 收得到，而 taskkill 自己在作业里：
 * 不等它跑完就退出，它会被一并结束，孙进程留成孤儿。所以 killTree 返回 taskkill 退出（或兜底杀根）之后才落定的
 * Promise，关停第 6 步等它（上限 REAP_WAIT_MS，见 index.ts 的 shutdown）。
 *
 * 为什么 taskkill 仍不设 detached：关停已经等它跑完，正常关停用不着它活过 minisd。设了的话，libuv 以
 * DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP 起它、不放进作业：另开一个进程组，脱离 minisd 的生命周期；
 * minisd 退了之后没人再握着根进程的句柄，根的 pid 可以被系统复用，迟到的 taskkill /pid 会落到无关的进程树上
 * （下面 killTree 开头跳过已退出的根，防的是同一件事）。
 *
 * 已知边界：引擎崩溃或被主进程强杀时根本来不及起 taskkill——直接子进程随作业被结束，它们起的孙进程留下；
 * 关停时等待超过上限，还没跑完的 taskkill 同样随作业被结束，没收到的孙进程留下。
 * 根治要自建不带 breakaway 的作业对象，把子进程和它们再起的进程都收进去（排在 W6）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { win32 } from 'node:path';

/** 构造注入：生产全用缺省值；测试在 Linux 上把 platform 设成 'win32'，断言交给 spawn 的命令与选项。 */
export interface ProcOpts {
  platform?: string;
  spawnImpl?: typeof spawn;
  /** 本进程的环境：既用来找 SystemRoot，也是子进程环境的底子（见 child-env.ts）。缺省 process.env。 */
  sysEnv?: NodeJS.ProcessEnv;
}

const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';
/** 盘符 + 反斜杠开头才算数：相对路径、盘符相对路径（C:Windows）、UNC、未展开的 %SystemRoot% 都不认。 */
const DRIVE_ABS_RE = /^[A-Za-z]:\\/;

/** Windows 的环境变量名不分大小写；process.env 在 Windows 上自己会忽略大小写，但拷贝出来的普通对象不会。 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === lower && typeof v === 'string') return v;
  return undefined;
}

/** 依次看 SystemRoot、windir，取第一个盘符开头的绝对路径；都不合格回落 C:\Windows。 */
export function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of ['SystemRoot', 'windir']) {
    const v = envValue(env, name);
    if (v && DRIVE_ABS_RE.test(v)) return v;
  }
  return DEFAULT_SYSTEM_ROOT;
}

/** <SystemRoot>\System32\<name>。必须用 path.win32：Linux 上跑测试也得拼出反斜杠。 */
export function system32(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(systemRoot(env), 'System32', name);
}

/** Windows PowerShell 5.1 的固定位置。32 位进程跑在 64 位系统上会被重定向到 SysWOW64 的 32 位版本，可以接受。 */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 回收子进程整棵树。参数按位置排，与 mcp/stdio.ts 原来的 killTree(child, platform, spawnImpl) 兼容。
 * - win32 且有 pid：起 <System32>\taskkill.exe /pid <pid> /T /F（windowsHide，stdio 忽略），不同步杀根；
 *   taskkill 同步抛错、发 'error'、或以非 0 退出（含被信号终止）时，兜底 child.kill(signal) 一次。
 * - 其余（非 win32，或 spawn 就失败了没有 pid）：直接 child.kill(signal)。
 * - 根进程已经自己退出（exitCode 或 signalCode 已有值）：什么都不做，任何平台都一样。
 * signal 缺省不传，child.kill() 用 Node 的默认信号；shell 与终端传 'SIGKILL'，与原来的行为一致。
 * 返回回收落定的 Promise，从不拒绝（W1b-5d）：起了 taskkill 的，等它发 'exit'（非 0 先兜底）或 'error'（先兜底）才落定；
 * 其余情形（taskkill 同步抛错已兜底、非 win32、没有 pid、根已退出）立即落定。taskkill 一直不退就一直不落定，
 * 等多久由等它的一方定（关停第 6 步最多等 REAP_WAIT_MS）。interrupt、超时、删除会话、MCP 握手失败这些调用点不等它，行为照旧。
 */
export function killTree(
  child: ChildProcess,
  platform: string = process.platform,
  spawnImpl: typeof spawn = spawn,
  env: NodeJS.ProcessEnv = process.env,
  signal?: NodeJS.Signals,
): Promise<void> {
  // 根进程已经自己退出（Node 填好 exitCode / signalCode 再发 'exit'，同时关掉进程句柄）：直接返回。
  // 句柄一关，Windows 就可以把这个 pid 发给别的进程，taskkill /pid <旧 pid> /T /F 杀的会是一棵无关的树；
  // 原来 shell 与终端用的按句柄 proc.kill 对已退出的进程什么都不做，不会有这个问题。
  // 跳过不丢回收能力：根不在了，taskkill /T 本来也按这个 pid 找不到它留下的孙进程。
  // 'exit' 到达之前 Node 还握着句柄，Windows 不复用仍被句柄引用的 pid，那段时间起 taskkill 是安全的。
  // 用宽松的 != null：测试里的假子进程常不带这两个字段（undefined），按「还活着」处理。
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  let fellBack = false;
  const fallback = (): void => {
    if (fellBack) return; // 'error' 之后可能还有 'exit'，只兜一次
    fellBack = true;
    try { child.kill(signal); } catch { /* 已死进程的 kill 在个别平台会抛，吞掉 */ }
  };
  if (platform !== 'win32' || typeof child.pid !== 'number') {
    fallback();
    return Promise.resolve();
  }
  let tk: ChildProcess;
  try {
    tk = spawnImpl(system32('taskkill.exe', env), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    fallback(); // taskkill 起不来不该炸宿主
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    // 常挂 'error' 监听：没有监听器的 'error' 会冒泡成未捕获异常，杀死整个 minisd。
    // 两个事件都可能来（'error' 之后还有 'exit'）：兜底只做一次，先兜底再落定，resolve 重复调用无害
    try {
      tk.on('error', () => { fallback(); resolve(); });
      tk.on('exit', (code: number | null) => { if (code !== 0) fallback(); resolve(); });
    } catch {
      // 挂不上监听（注入的 spawn 交回的东西不像 ChildProcess）：不知道 taskkill 何时跑完，兜底杀根后立即落定。
      // 执行器里的异常会变成拒绝，「从不拒绝」要在这里也成立（W1b-5e）
      fallback();
      resolve();
    }
  });
}
