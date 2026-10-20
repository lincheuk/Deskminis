/**
 * F09 根脚本：让每棵进程树的根（PowerShell 驱动，或 MCP 的 launcher）自己建作业并把自己放进去。
 *
 * 为什么由根自己做：引擎进程里没有调 Win32 的手段（不加 native 件），而且 Node 的 spawn 不能挂起创建——
 * 引擎事后按 PID 归属总晚于子进程的出生，cmd /c npx 这类根立刻就起了孙进程，竞态关不上。根在读到引擎的
 * 第一份输入之前不建作业、不执行任何用户指定的程序；归属之后出生的后代都在不许脱离的作业里。
 *
 * 作业只带 KILL_ON_JOB_CLOSE（LimitFlags = 0x2000）：不设 BREAKAWAY_OK / SILENT_BREAKAWAY_OK，不命名，句柄不可继承，
 * 只在根进程里。根一结束（被 taskkill、自己退出、随运行时的作业被结束）句柄关闭，作业里剩下的进程全部结束。
 * 根另握着属主（引擎）进程的句柄：一条后台线程等它，引擎一结束就终止整个作业（退出码 197）。这条路不依赖运行时。
 *
 * Win32 调用用 Reflection.Emit 在内存里定义 P/Invoke：不落盘、不起 csc.exe。脚本是产品常量加一个数字（属主 PID），
 * 不拼接任何输入；目标命令行经环境变量传给 launcher，不经脚本文本。
 *
 * 结论经 stderr 的一行标记回报（纯 ASCII 的 key=value）：
 *   __MINIS_PROC__ job=armed watch=1 prejob=1 pid=1234 created=133…                      （驱动）
 *   __MINIS_PROC__ job=armed watch=1 prejob=1 pid=1234 created=133… target=5678          （launcher，目标已起）
 *   __MINIS_PROC__ job=armed watch=1 prejob=1 pid=1234 created=133… launch=failed code=2 （launcher，目标没起来）
 *   __MINIS_PROC__ job=failed step=assign code=5 pid=1234 created=133…
 * step 取 go（launcher 没等到放行行）、define、create、setinfo、assign。
 * 根在写出标记行之前不执行任何用户代码，所以标记一定在行首。
 */

export const PROC_MARKER = '__MINIS_PROC__';

export interface ArmReport {
  job: 'armed' | 'failed';
  watch?: boolean; prejob?: boolean; pid?: number; created?: string;
  /** job=failed 时 */
  step?: string; code?: number;
  /** launcher：目标的 pid */
  target?: number;
  /** launcher：CreateProcessW 的错误码 */
  launchFailed?: number;
}

const STEPS = new Set(['go', 'define', 'create', 'setinfo', 'assign']);
const UINT_RE = /^\d{1,20}$/;
const posInt = (v: string | undefined): number | undefined => {
  if (v === undefined || !UINT_RE.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** 一行文本是不是标记；不是或字段坏了返回 undefined。 */
export function parseArmMarker(line: string): ArmReport | undefined {
  const text = line.replace(/\r$/, '');
  if (!text.startsWith(PROC_MARKER + ' ')) return undefined;
  const kv = new Map<string, string>();
  for (const part of text.slice(PROC_MARKER.length + 1).split(' ')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || kv.has(part.slice(0, eq))) return undefined; // 没有等号、重复的键：按坏行处理
    kv.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const job = kv.get('job');
  if (job !== 'armed' && job !== 'failed') return undefined;
  const pid = posInt(kv.get('pid'));
  const created = kv.get('created');
  if (pid === undefined || created === undefined || !UINT_RE.test(created)) return undefined;
  const out: ArmReport = { job, pid, created };
  const code = kv.get('code');
  if (code !== undefined && !UINT_RE.test(code)) return undefined;
  if (job === 'failed') {
    const step = kv.get('step');
    if (step === undefined || !STEPS.has(step) || code === undefined) return undefined;
    out.step = step; out.code = Number(code);
    return out;
  }
  const watch = kv.get('watch'); const prejob = kv.get('prejob');
  if ((watch !== '0' && watch !== '1') || (prejob !== '0' && prejob !== '1')) return undefined;
  out.watch = watch === '1'; out.prejob = prejob === '1';
  if (kv.has('target')) {
    const target = posInt(kv.get('target'));
    if (target === undefined) return undefined;
    out.target = target;
  }
  if (kv.has('launch')) {
    if (kv.get('launch') !== 'failed' || code === undefined) return undefined;
    out.launchFailed = Number(code);
  }
  return out;
}

/** 一行标记最长也就一百多个字符；从行首起攒到这么长还没见到换行，就不是标记，原样放行。 */
const MARKER_LINE_MAX = 512;

/**
 * 在 stderr 文本流里找标记行。feed 返回要原样透传的文本（标记行连同行尾被摘掉）。
 * 只扣住「从行首起可能是标记前缀」的那一小段，其余一到就透传；摘过一行之后继续找（迟到的第二行也摘）。
 */
export class MarkerScanner {
  private held = '';
  private atLineStart = true;

  constructor(private readonly onReport: (r: ArmReport) => void) {}

  feed(chunk: string): string {
    const s = this.held + chunk;
    this.held = '';
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (this.atLineStart) {
        const rest = s.slice(i);
        if (rest.startsWith(PROC_MARKER)) {
          const nl = rest.indexOf('\n');
          if (nl < 0) {
            if (rest.length > MARKER_LINE_MAX) { out += rest; this.atLineStart = false; return out; }
            this.held = rest; // 等这一行收全
            return out;
          }
          const report = parseArmMarker(rest.slice(0, nl));
          if (report) this.onReport(report); else out += rest.slice(0, nl + 1); // 长得像但字段坏了：不是标记，照常透传
          i += nl + 1;
          continue;
        }
        if (PROC_MARKER.startsWith(rest)) { this.held = rest; return out; } // chunk 恰好断在前缀中间
        this.atLineStart = false;
      }
      const nl = s.indexOf('\n', i);
      if (nl < 0) { out += s.slice(i); return out; }
      out += s.slice(i, nl + 1);
      i = nl + 1;
      this.atLineStart = true;
    }
    return out;
  }

  /** 流结束时把扣着的那一小段交出来（没等到换行的半行）。 */
  flush(): string {
    const h = this.held;
    this.held = '';
    return h;
  }
}

function assertOwnerPid(ownerPid: number): void {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error(`属主 PID 不合法: ${String(ownerPid)}`);
}

/** 在内存里定义 kernel32 的 P/Invoke 与监视线程的入口。只用 .NET 调用，不触发模块自动加载。
 *  Watch 的 IL：if (WaitForSingleObject(Owner, INFINITE) == 0) TerminateJobObject(Job, 197); */
const K32_FN_PS = `function __minis_k32 {
  $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly([System.Reflection.AssemblyName]::new('MinisProcNative'), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
  $tb = $ab.DefineDynamicModule('MinisProcNative').DefineType('MinisProcNative.K32', [System.Reflection.TypeAttributes]'Public,Class,Abstract,Sealed')
  $di = [System.Runtime.InteropServices.DllImportAttribute]
  $ctor = $di.GetConstructor([Type[]]@([string]))
  $fl = [System.Reflection.FieldInfo[]]@($di.GetField('SetLastError'), $di.GetField('CharSet'))
  $fv = [object[]]@($true, [System.Runtime.InteropServices.CharSet]::Unicode)
  $mm = @{}
  foreach ($d in $args[0]) {
    $mb = $tb.DefineMethod($d[0], [System.Reflection.MethodAttributes]'Public,Static,PinvokeImpl', $d[1], $d[2])
    $mb.SetCustomAttribute([System.Reflection.Emit.CustomAttributeBuilder]::new($ctor, [object[]]@('kernel32.dll'), $fl, $fv))
    $mb.SetImplementationFlags([System.Reflection.MethodImplAttributes]::PreserveSig)
    $mm[$d[0]] = $mb
  }
  $fo = $tb.DefineField('Owner', [IntPtr], [System.Reflection.FieldAttributes]'Public,Static')
  $fj = $tb.DefineField('Job', [IntPtr], [System.Reflection.FieldAttributes]'Public,Static')
  $il = $tb.DefineMethod('Watch', [System.Reflection.MethodAttributes]'Public,Static', [void], [Type[]]@()).GetILGenerator()
  $op = [System.Reflection.Emit.OpCodes]; $ret = $il.DefineLabel()
  $il.Emit($op::Ldsfld, $fo); $il.Emit($op::Ldc_I4_M1); $il.Emit($op::Call, [System.Reflection.MethodInfo]$mm['WaitForSingleObject']); $il.Emit($op::Brtrue, $ret)
  $il.Emit($op::Ldsfld, $fj); $il.Emit($op::Ldc_I4, [int]197); $il.Emit($op::Call, [System.Reflection.MethodInfo]$mm['TerminateJobObject']); $il.Emit($op::Pop)
  $il.MarkLabel($ret); $il.Emit($op::Ret)
  $tb.CreateType()
}
`;

/** 归属与属主监视共用的 P/Invoke 清单（每项：函数名, 返回类型, 形参类型数组）。 */
const ARM_DEFS_PS = `@('GetCurrentProcess', [IntPtr], [Type[]]@()),
      @('IsProcessInJob', [bool], [Type[]]@([IntPtr], [IntPtr], [bool].MakeByRefType())),
      @('CreateJobObjectW', [IntPtr], [Type[]]@([IntPtr], [IntPtr])),
      @('SetInformationJobObject', [bool], [Type[]]@([IntPtr], [int], [IntPtr], [uint32])),
      @('AssignProcessToJobObject', [bool], [Type[]]@([IntPtr], [IntPtr])),
      @('OpenProcess', [IntPtr], [Type[]]@([uint32], [bool], [uint32])),
      @('GetProcessTimes', [bool], [Type[]]@([IntPtr], [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType())),
      @('WaitForSingleObject', [uint32], [Type[]]@([IntPtr], [uint32])),
      @('TerminateJobObject', [bool], [Type[]]@([IntPtr], [uint32]))`;

/** launcher 另外要的几个。CreateProcessW 的命令行是 StringBuilder（要可写），DllImport 统一带 CharSet = Unicode。 */
const LAUNCH_DEFS_PS = `,
      @('SetEnvironmentVariableW', [bool], [Type[]]@([string], [string])),
      @('GetStdHandle', [IntPtr], [Type[]]@([int])),
      @('CreateProcessW', [bool], [Type[]]@([IntPtr], [System.Text.StringBuilder], [IntPtr], [IntPtr], [bool], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr])),
      @('GetExitCodeProcess', [bool], [Type[]]@([IntPtr], [uint32].MakeByRefType())),
      @('CloseHandle', [bool], [Type[]]@([IntPtr])),
      @('SetProcessWorkingSetSize', [bool], [Type[]]@([IntPtr], [IntPtr], [IntPtr])),
      @('ResumeThread', [uint32], [Type[]]@([IntPtr])),
      @('TerminateProcess', [bool], [Type[]]@([IntPtr], [uint32]))`;

/**
 * 归属的主体（驱动与 launcher 共用）。跑完之后：$armed 为真时 $msg 是 job=armed…，否则是 job=failed…；$k 是 P/Invoke 类型。
 * 顺序固定：define → 取内核记录的创建时间 → IsProcessInJob（prejob）→ create → setinfo → assign → 属主监视。
 * 判定「属主已不在」（打不开且错误码 87；属主的创建时间晚于自己；属主已结束）时不执行任何用户代码，立即以 197 退出。
 * 0x00101000 = SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION。JOBOBJECT_EXTENDED_LIMIT_INFORMATION 在 x64 是 144 字节、
 * x86 是 112 字节，LimitFlags 在偏移 16。
 */
function armBodyPs(ownerPid: number, extraDefs: string): string {
  return `  $me = [System.Diagnostics.Process]::GetCurrentProcess()
  $born = $me.StartTime.ToFileTimeUtc()
  $id = ' pid=' + $me.Id + ' created=' + $born
  $M = [Runtime.InteropServices.Marshal]; $step = 'define'; $code = 0; $watch = 0; $armed = $false
  try {
    $k = __minis_k32 @(
      ${ARM_DEFS_PS}${extraDefs})
    $self = $k::GetCurrentProcess()
    $sc = [long]0; $se = [long]0; $sk = [long]0; $su = [long]0
    if ($k::GetProcessTimes($self, [ref]$sc, [ref]$se, [ref]$sk, [ref]$su)) { $born = $sc; $id = ' pid=' + $me.Id + ' created=' + $born }
    $inj = $false; [void]$k::IsProcessInJob($self, [IntPtr]::Zero, [ref]$inj)
    $step = 'create'
    $job = $k::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)
    if ($job -eq [IntPtr]::Zero) { $code = $M::GetLastWin32Error(); throw 'x' }
    $step = 'setinfo'
    $len = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
    $buf = $M::AllocHGlobal($len)
    try {
      for ($i = 0; $i -lt $len; $i++) { $M::WriteByte($buf, $i, 0) }
      $M::WriteInt32($buf, 16, 0x2000)
      if (-not $k::SetInformationJobObject($job, 9, $buf, [uint32]$len)) { $code = $M::GetLastWin32Error(); throw 'x' }
    } finally { $M::FreeHGlobal($buf) }
    $step = 'assign'
    if (-not $k::AssignProcessToJobObject($job, $self)) { $code = $M::GetLastWin32Error(); throw 'x' }
    $gone = $false
    $ho = $k::OpenProcess([uint32]0x00101000, $false, [uint32]${ownerPid})
    if ($ho -eq [IntPtr]::Zero) { if ($M::GetLastWin32Error() -eq 87) { $gone = $true } }
    else {
      $oc = [long]0; $oe = [long]0; $ok = [long]0; $ou = [long]0
      if ($k::GetProcessTimes($ho, [ref]$oc, [ref]$oe, [ref]$ok, [ref]$ou) -and ($oc -gt $born)) { $gone = $true }
      elseif ($k::WaitForSingleObject($ho, [uint32]0) -eq 0) { $gone = $true }
      else {
        $k.GetField('Owner').SetValue($null, $ho); $k.GetField('Job').SetValue($null, $job)
        $th = [Threading.Thread]::new([Threading.ThreadStart][Delegate]::CreateDelegate([Threading.ThreadStart], $k.GetMethod('Watch')))
        $th.IsBackground = $true; $th.Start(); $watch = 1
      }
    }
    if ($gone) { [Environment]::Exit(197) }
    $msg = 'job=armed watch=' + $watch + ' prejob=' + [int]$inj + $id; $armed = $true
  } catch { $msg = 'job=failed step=' + $step + ' code=' + $code + $id }
`;
}

/** 定义 __minis_k32 与 __minis_arm 两个函数，不执行任何东西。ownerPid 以字面量写进脚本；不是正整数则抛。
 *  __minis_arm 跑完写一行标记，然后把两个函数删掉（用户命令里调不到第二次）。
 *  删函数用给 $function: 赋 $null，不用 Remove-Item：后者是 cmdlet，会触发模块自动加载（本机实测多 40 多毫秒，
 *  还会往 stderr 冒一条「正在准备首次使用模块」的进度记录）；归属全程只用 .NET 调用。 */
export function armPs(ownerPid: number): string {
  assertOwnerPid(ownerPid);
  return `${K32_FN_PS}function __minis_arm {
  $ProgressPreference = 'SilentlyContinue'
${armBodyPs(ownerPid, '')}  [Console]::Error.WriteLine('${PROC_MARKER} ' + $msg)
  $function:__minis_k32 = $null; $function:__minis_arm = $null
}
`;
}

/** 驱动循环里那一行：读到第一份输入、判过 EOF 之后，执行任何命令之前，归属一次。 */
export const ARM_HOOK_PS = 'if (-not $__minis_armed) { $__minis_armed = $true; __minis_arm }';

/**
 * launcher 全文。除 ownerPid 外是常量，不拼接任何输入：目标命令行、放行用的随机数、PSModulePath 的原值都经
 * MINIS_OWN_* 环境变量传入，读完即从进程环境里删掉（目标看不到它们）。
 *
 * 顺序（测试钉着）：逐字节读到放行行（不带缓冲，不会多吃目标的输入）→ 归属与属主监视 → 还原环境 →
 * CreateProcessW（创建标志 0x4 = CREATE_SUSPENDED：目标已在作业里，但一条指令都没执行，往共用的 stderr 上写不出东西）→
 * 写带 target= 的标记 → ResumeThread → 等目标退出 → 以目标的退出码退出。
 * 退出用 TerminateJobObject(自己的作业, 目标的退出码)：launcher 自己也在作业里，连同目标留下的后代当场一起结束，退出码原样。
 * 只用 [Environment]::Exit 的话 PowerShell 收尾要两秒多（真机实测），这段时间里引擎看不到「进程已退出」、后代也还活着；
 * Exit 留作兜底（TerminateJobObject 失败时才走得到）。
 * 放行行不符或 EOF：job=failed step=go，以 197 退出。归属失败：写标记，以 197 退出，不启动目标。
 * 目标起不来：launch=failed code=<GetLastError>，以 198 退出。
 * STARTUPINFOW 手工填：dwFlags = 0x101（STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW），wShowWindow = 0（SW_HIDE，对应
 * windowsHide: true），三个标准句柄取 GetStdHandle(-10 / -11 / -12)。x64 的偏移是 60 / 80 / 88 / 96（总长 104），
 * x86 是 44 / 56 / 60 / 64（总长 68）。PROCESS_INFORMATION：hProcess 在 0，hThread 在一个指针之后，dwProcessId 在两个指针之后。
 */
export function launcherPs(ownerPid: number): string {
  assertOwnerPid(ownerPid);
  return `$ProgressPreference = 'SilentlyContinue'
${K32_FN_PS}$nonce = $env:MINIS_OWN_NONCE; $cmdline = $env:MINIS_OWN_CMDLINE; $pset = $env:MINIS_OWN_PSMP_SET; $pval = $env:MINIS_OWN_PSMP; $cset = $env:MINIS_OWN_COMPAT_SET; $cval = $env:MINIS_OWN_COMPAT
$s = [Console]::OpenStandardInput(); $sb = [System.Text.StringBuilder]::new()
while ($true) { $b = $s.ReadByte(); if ($b -lt 0 -or $b -eq 10) { break }; if ($b -ne 13) { [void]$sb.Append([char]$b) } }
if ($b -lt 0 -or [string]::IsNullOrEmpty($nonce) -or $sb.ToString() -ne $nonce) {
  $me = [System.Diagnostics.Process]::GetCurrentProcess()
  [Console]::Error.WriteLine('${PROC_MARKER} job=failed step=go code=0 pid=' + $me.Id + ' created=' + $me.StartTime.ToFileTimeUtc())
  [Environment]::Exit(197)
}
& {
${armBodyPs(ownerPid, LAUNCH_DEFS_PS)}  if (-not $armed) { [Console]::Error.WriteLine('${PROC_MARKER} ' + $msg); [Environment]::Exit(197) }
  if ($pset -eq '1') { [void]$k::SetEnvironmentVariableW('PSModulePath', [string]$pval) } else { [void]$k::SetEnvironmentVariableW('PSModulePath', $null) }
  if ($cset -eq '1') { [void]$k::SetEnvironmentVariableW('__COMPAT_LAYER', [string]$cval) } else { [void]$k::SetEnvironmentVariableW('__COMPAT_LAYER', $null) }
  foreach ($n in @('MINIS_OWN_NONCE', 'MINIS_OWN_CMDLINE', 'MINIS_OWN_PSMP_SET', 'MINIS_OWN_PSMP', 'MINIS_OWN_COMPAT_SET', 'MINIS_OWN_COMPAT')) { [Environment]::SetEnvironmentVariable($n, $null) }
  $p8 = [IntPtr]::Size -eq 8
  $sil = if ($p8) { 104 } else { 68 }
  $si = $M::AllocHGlobal($sil); $pinf = $M::AllocHGlobal(24)
  for ($i = 0; $i -lt $sil; $i++) { $M::WriteByte($si, $i, 0) }
  for ($i = 0; $i -lt 24; $i++) { $M::WriteByte($pinf, $i, 0) }
  $M::WriteInt32($si, 0, $sil)
  $M::WriteInt32($si, $(if ($p8) { 60 } else { 44 }), 0x101)
  $M::WriteIntPtr($si, $(if ($p8) { 80 } else { 56 }), $k::GetStdHandle(-10))
  $M::WriteIntPtr($si, $(if ($p8) { 88 } else { 60 }), $k::GetStdHandle(-11))
  $M::WriteIntPtr($si, $(if ($p8) { 96 } else { 64 }), $k::GetStdHandle(-12))
  $cl = [System.Text.StringBuilder]::new($cmdline)
  $ok = $k::CreateProcessW([IntPtr]::Zero, $cl, [IntPtr]::Zero, [IntPtr]::Zero, $true, [uint32]0x4, [IntPtr]::Zero, [IntPtr]::Zero, $si, $pinf)
  if (-not $ok) { [Console]::Error.WriteLine('${PROC_MARKER} ' + $msg + ' launch=failed code=' + $M::GetLastWin32Error()); [Environment]::Exit(198) }
  $hp = $M::ReadIntPtr($pinf, 0); $ht = $M::ReadIntPtr($pinf, [IntPtr]::Size); $tp = $M::ReadInt32($pinf, 2 * [IntPtr]::Size)
  [Console]::Error.WriteLine('${PROC_MARKER} ' + $msg + ' target=' + $tp)
  if ($k::ResumeThread($ht) -eq [uint32]::MaxValue) { [void]$k::TerminateProcess($hp, [uint32]198); [Environment]::Exit(198) }
  [void]$k::CloseHandle($ht)
  [void]$k::SetProcessWorkingSetSize($self, [IntPtr](-1), [IntPtr](-1))
  [void]$k::WaitForSingleObject($hp, [uint32]::MaxValue)
  $xc = [uint32]0
  [void]$k::GetExitCodeProcess($hp, [ref]$xc)
  [void]$k::TerminateJobObject($job, $xc)
  [Environment]::Exit([BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$xc), 0))
}
`;
}
