<#
  执行隔离 AppContainer 原型（方案文档「第 4 步评估」选项 2）：在应用容器里起 PowerShell，逐项看挡住了什么、哪些工具还能用。

  用法（普通权限的 Windows PowerShell 5.1 即可，不需要管理员；不需要装 DeskMinis，也不碰它的数据）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\appcontainer-probe.ps1
  可选：-Out <json 路径>（默认 %TEMP%\deskminis-appcontainer-probe.json）、-SkipNetwork（不试联网和 npm install）。

  它做的事：
    1. 建一个临时的应用容器（CreateAppContainerProfile，名字 DeskMinisProbe.<随机>），在 %TEMP% 下建一个「工作区」，
       只给这个工作区加上容器的访问权限；在 %APPDATA% 下放一个不给权限的「用户文件」。
    2. 用 cmdkey 往凭据管理器里存一条测试凭据，用 DPAPI 加密一小段文字；本进程开一个回环端口和一个命名管道。
    3. 在容器里起两次 PowerShell：一次不给任何能力，一次只给 internetClient（能出站联网）。每次逐项试：
       读写工作区、读用户文件、列「文档」、写 HKCU、读那条测试凭据、DPAPI 解密、联网、同进程 / 同容器 / 连本机别的进程的回环、
       连本进程的命名管道，以及 git、node、npm、python 能不能用、装在哪。
    4. 打印结论，写一份 JSON，删掉它建的所有东西（容器、目录、测试凭据）。
  联网只访问 registry.npmjs.org（is-number 这个公开的小包）；加 -SkipNetwork 可跳过。
  起容器进程用的是 C#（Add-Type 现场编译）：这只是原型，产品里要并进 F09 的启动器。
#>
param(
  [string]$Out = (Join-Path $env:TEMP 'deskminis-appcontainer-probe.json'),
  [switch]$SkipNetwork
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class DeskMinisAcProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSidW(string str, out IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr val, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  /// 建容器（已经有了就取它的 SID），返回 SID 字符串。
  public static string EnsureProfile(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, "DeskMinis AppContainer probe", IntPtr.Zero, 0, out sid);
    if (hr == unchecked((int)0x800700B7)) hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
    if (hr != 0) throw new Exception("CreateAppContainerProfile 0x" + hr.ToString("X8"));
    try {
      IntPtr s;
      if (!ConvertSidToStringSidW(sid, out s)) throw new Win32Exception();
      try { return Marshal.PtrToStringUni(s); } finally { LocalFree(s); }
    } finally { FreeSid(sid); }
  }

  public static int DeleteProfile(string name) { return DeleteAppContainerProfile(name); }

  /// 在容器里起进程（不继承句柄、不开窗口），等它结束，返回退出码；超时杀掉返回 -1。起不来抛 Win32Exception。
  public static long Run(string containerSid, string[] capSids, string app, string cmdLine, string cwd, uint timeoutMs) {
    IntPtr acSid;
    if (!ConvertStringSidToSidW(containerSid, out acSid)) throw new Win32Exception();
    IntPtr[] caps = new IntPtr[capSids.Length];
    IntPtr capArr = IntPtr.Zero, scBuf = IntPtr.Zero, attr = IntPtr.Zero;
    bool attrInit = false;
    try {
      int saaSize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
      if (capSids.Length > 0) {
        capArr = Marshal.AllocHGlobal(saaSize * capSids.Length);
        for (int i = 0; i < capSids.Length; i++) {
          if (!ConvertStringSidToSidW(capSids[i], out caps[i])) throw new Win32Exception();
          SID_AND_ATTRIBUTES saa = new SID_AND_ATTRIBUTES();
          saa.Sid = caps[i]; saa.Attributes = 4; // SE_GROUP_ENABLED
          Marshal.StructureToPtr(saa, new IntPtr(capArr.ToInt64() + i * saaSize), false);
        }
      }
      SECURITY_CAPABILITIES sc = new SECURITY_CAPABILITIES();
      sc.AppContainerSid = acSid; sc.Capabilities = capArr; sc.CapabilityCount = (uint)capSids.Length;
      int scSize = Marshal.SizeOf(typeof(SECURITY_CAPABILITIES));
      scBuf = Marshal.AllocHGlobal(scSize);
      Marshal.StructureToPtr(sc, scBuf, false);
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attr = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attr, 1, 0, ref size)) throw new Win32Exception();
      attrInit = true;
      // 0x00020009 = PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
      if (!UpdateProcThreadAttribute(attr, 0, (IntPtr)0x00020009, scBuf, (IntPtr)scSize, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
      STARTUPINFOEX si = new STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.lpAttributeList = attr;
      PROCESS_INFORMATION pi;
      // 0x00080000 = EXTENDED_STARTUPINFO_PRESENT；0x08000000 = CREATE_NO_WINDOW
      if (!CreateProcessW(app, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x08000000, IntPtr.Zero, cwd, ref si, out pi)) throw new Win32Exception();
      try {
        if (WaitForSingleObject(pi.hProcess, timeoutMs) != 0) { TerminateProcess(pi.hProcess, 1); return -1; }
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        return code;
      } finally { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
    } finally {
      if (attrInit) DeleteProcThreadAttributeList(attr);
      if (attr != IntPtr.Zero) Marshal.FreeHGlobal(attr);
      if (scBuf != IntPtr.Zero) Marshal.FreeHGlobal(scBuf);
      if (capArr != IntPtr.Zero) Marshal.FreeHGlobal(capArr);
      foreach (IntPtr c in caps) if (c != IntPtr.Zero) LocalFree(c);
      LocalFree(acSid);
    }
  }
}
'@

# ---- 在容器里逐项试。输入经 PROBE_* 环境变量；结论写到 PROBE_OUT（JSON） ----
$ChildPs = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$R = [System.Collections.ArrayList]::new()
$started = Get-Date
function Add-R($id, $result, $detail) { [void]$R.Add([ordered]@{ id = $id; result = $result; detail = [string]$detail }) }
function Save-R { [IO.File]::WriteAllText($env:PROBE_OUT, (@{ ms = [int]((Get-Date) - $started).TotalMilliseconds; results = $R } | ConvertTo-Json -Compress -Depth 4), [Text.UTF8Encoding]::new($false)) }
function Try-Access($id, [scriptblock]$b) {
  try { $o = & $b; Add-R $id 'allowed' $o } catch { Add-R $id 'denied' $_.Exception.Message }
  Save-R
}
function Try-Tool($id, $exe, [scriptblock]$b) {
  $c = Get-Command $exe -ErrorAction SilentlyContinue
  if (-not $c) { Add-R $id 'absent' ''; Save-R; return }
  $ErrorActionPreference = 'Continue'
  try {
    $global:LASTEXITCODE = 0
    $o = (& $b 2>&1 | Out-String).Trim()
    $last = (($o -split "`r?`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 3) -join ' | '
    if ($LASTEXITCODE -eq 0) { Add-R $id 'ok' ($c.Source + ' | ' + $last) } else { Add-R $id 'fail' ($c.Source + ' | exit ' + $LASTEXITCODE + ': ' + $last) }
  } catch { Add-R $id 'fail' ($c.Source + ' | ' + $_.Exception.Message) }
  $ErrorActionPreference = 'Stop'
  Save-R
}
Add-R 'started' 'ok' $PSVersionTable.PSVersion.ToString()
Save-R

try {
  $g = (whoami /groups) -join ' '
  $ac = [regex]::Match($g, 'S-1-15-2-[\d-]+').Value
  $il = if ($g -match 'S-1-16-4096') { 'low' } elseif ($g -match 'S-1-16-8192') { 'medium' } else { 'other' }
  Add-R 'token' $(if ($ac) { 'appcontainer' } else { 'not-appcontainer' }) ($il + ' ' + $ac)
} catch { Add-R 'token' 'error' $_.Exception.Message }
Save-R

$ws = $env:PROBE_WS
Try-Access 'ws-write' { Set-Content -LiteralPath (Join-Path $ws ('w-' + $env:PROBE_RUN + '.txt')) -Value 'x'; 'written' }
Try-Access 'ws-read' { (Get-Content -LiteralPath (Join-Path $ws 'given.txt') -Raw).Length }
Try-Access 'temp-write' { $f = [IO.Path]::GetTempFileName(); Remove-Item -LiteralPath $f; $f }
Try-Access 'user-read' { (Get-Content -LiteralPath $env:PROBE_USERFILE -Raw).Length }
Try-Access 'docs-list' { @(Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('MyDocuments')) -Force).Count }
Try-Access 'profile-list' { @(Get-ChildItem -LiteralPath $env:USERPROFILE -Force).Count }
Try-Access 'hkcu-read' { (Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop').PSChildName }
Try-Access 'hkcu-write' { New-Item -Path ('HKCU:\Software\DeskMinisAcProbe-' + $env:PROBE_TAG) -Force | Out-Null; Remove-Item -Path ('HKCU:\Software\DeskMinisAcProbe-' + $env:PROBE_TAG) -Force; 'written' }

# 凭据管理器：读父进程用 cmdkey 存的那条（CRED_TYPE_GENERIC = 1）。P/Invoke 用 Reflection.Emit 在内存里定义（容器里起 csc.exe 不一定行）
try {
  $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly([System.Reflection.AssemblyName]::new('AcProbeNative'), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
  $tb = $ab.DefineDynamicModule('AcProbeNative').DefineType('AcProbeNative.N', [System.Reflection.TypeAttributes]'Public,Class,Abstract,Sealed')
  $di = [System.Runtime.InteropServices.DllImportAttribute]
  $ctor = $di.GetConstructor([Type[]]@([string]))
  $fl = [System.Reflection.FieldInfo[]]@($di.GetField('SetLastError'), $di.GetField('CharSet'))
  $fv = [object[]]@($true, [System.Runtime.InteropServices.CharSet]::Unicode)
  foreach ($d in @(
      @('CredReadW', [bool], [Type[]]@([string], [uint32], [uint32], [IntPtr].MakeByRefType())),
      @('CredEnumerateW', [bool], [Type[]]@([IntPtr], [uint32], [uint32].MakeByRefType(), [IntPtr].MakeByRefType())),
      @('CredFree', [void], [Type[]]@([IntPtr])))) {
    $mb = $tb.DefineMethod($d[0], [System.Reflection.MethodAttributes]'Public,Static,PinvokeImpl', $d[1], $d[2])
    $mb.SetCustomAttribute([System.Reflection.Emit.CustomAttributeBuilder]::new($ctor, [object[]]@('advapi32.dll'), $fl, $fv))
    $mb.SetImplementationFlags([System.Reflection.MethodImplAttributes]::PreserveSig)
  }
  $C = $tb.CreateType()
  $M = [Runtime.InteropServices.Marshal]
  $p = [IntPtr]::Zero
  if ($C::CredReadW($env:PROBE_CRED, [uint32]1, [uint32]0, [ref]$p)) { $C::CredFree($p); Add-R 'cred-read' 'allowed' '' }
  else { Add-R 'cred-read' 'denied' ('error ' + $M::GetLastWin32Error()) }
  $n = [uint32]0; $p = [IntPtr]::Zero
  if ($C::CredEnumerateW([IntPtr]::Zero, [uint32]0, [ref]$n, [ref]$p)) { $C::CredFree($p); Add-R 'cred-enum' 'allowed' ('' + $n + ' entries') }
  else { Add-R 'cred-enum' 'denied' ('error ' + $M::GetLastWin32Error()) }
} catch { Add-R 'cred-read' 'error' $_.Exception.Message }
Save-R
try {
  Add-Type -AssemblyName System.Security
  $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:PROBE_DPAPI), $null, 'CurrentUser')
  Add-R 'dpapi' 'allowed' ([Text.Encoding]::UTF8.GetString($plain).Length)
} catch { Add-R 'dpapi' 'denied' $_.Exception.Message }
Save-R

# 回环：同一进程里自连；同一容器里另一个进程来连；连容器外（父进程）开的端口
try {
  $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port
  try {
    Try-Access 'loop-self' { $c = [Net.Sockets.TcpClient]::new(); try { $c.Connect('127.0.0.1', $port); 'connected' } finally { $c.Close() } }
    $exe = (Get-Process -Id $PID).Path
    $cmd = '$c = [Net.Sockets.TcpClient]::new(); try { $c.Connect(''127.0.0.1'', ' + $port + '); exit 0 } catch { exit 3 }'
    $p = Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', $cmd) -WindowStyle Hidden -PassThru -Wait
    Add-R 'loop-sibling' $(if ($p.ExitCode -eq 0) { 'allowed' } else { 'denied' }) ('exit ' + $p.ExitCode)
  } finally { $l.Stop() }
} catch { Add-R 'loop-sibling' 'error' $_.Exception.Message }
Save-R
Try-Access 'loop-host' { $c = [Net.Sockets.TcpClient]::new(); try { $c.Connect('127.0.0.1', [int]$env:PROBE_HOSTPORT); 'connected' } finally { $c.Close() } }
Try-Access 'pipe-host' { $c = [IO.Pipes.NamedPipeClientStream]::new('.', $env:PROBE_PIPE, [IO.Pipes.PipeDirection]::InOut); try { $c.Connect(3000); 'connected' } finally { $c.Dispose() } }

# 联网：直连；系统代理（多半是本机回环端口，容器里连不上）
if ($env:PROBE_NETWORK -eq '1') {
  Try-Access 'net-direct' { $r = Invoke-WebRequest -UseBasicParsing -Uri 'https://registry.npmjs.org/is-number' -TimeoutSec 20 -Proxy $null -ErrorAction Stop; 'HTTP ' + $r.StatusCode }
  if ($env:PROBE_PROXY) { Try-Access 'net-proxy' { $r = Invoke-WebRequest -UseBasicParsing -Uri 'https://registry.npmjs.org/is-number' -TimeoutSec 20 -Proxy $env:PROBE_PROXY -ErrorAction Stop; 'HTTP ' + $r.StatusCode } }
}

# 工具链（在工作区里）
Set-Location -LiteralPath $ws
Try-Tool 'cmd' 'cmd' { cmd /c echo ok }
Try-Tool 'git' 'git' { git init -q ('repo-' + $env:PROBE_RUN); git -C ('repo-' + $env:PROBE_RUN) -c user.name=probe -c user.email=probe@example.invalid commit --allow-empty -q -m probe; git -C ('repo-' + $env:PROBE_RUN) log --oneline }
Try-Tool 'node' 'node' { node -e "require('fs').writeFileSync('node.txt', process.version); console.log(process.version)" }
Try-Tool 'npm' 'npm' { npm --version }
if ($env:PROBE_NETWORK -eq '1') {
  Try-Tool 'npm-install' 'npm' { $d = 'npm-' + $env:PROBE_RUN; New-Item -ItemType Directory -Force $d | Out-Null; Set-Location $d; npm init -y | Out-Null; npm install is-number@7.0.0 --no-audit --no-fund --loglevel=error; Set-Location .. }
}
Try-Tool 'python' 'python' { python -c "import sys; print(sys.version)" }
Save-R
'@

# ---------------------------------------------------------------- 父进程（原级别）
$tag = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$name = 'DeskMinisProbe.' + $tag
$base = Join-Path $env:TEMP ('DeskMinisAcProbe-' + $tag)
$ws = Join-Path $base 'workspace'
$tmp = Join-Path $ws 'tmp'
$userDir = Join-Path $env:APPDATA ('DeskMinisAcProbe-' + $tag)
$userFile = Join-Path $userDir 'user-file.txt'
$credTarget = 'DeskMinisAcProbe-' + $tag
$pipeName = 'deskminis-acprobe-' + $tag
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$report = [ordered]@{ tag = $tag; os = [Environment]::OSVersion.VersionString; build = ''; ps = $PSVersionTable.PSVersion.ToString(); runs = [ordered]@{} }
try { $report.build = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').DisplayVersion + ' ' + (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuild } catch { }
$proxy = ''
try { $u = [Uri]'https://registry.npmjs.org/'; $pu = [Net.WebRequest]::GetSystemWebProxy().GetProxy($u); if ($pu -and $pu.AbsoluteUri -ne $u.AbsoluteUri) { $proxy = $pu.AbsoluteUri } } catch { }
$report.systemProxy = $proxy
foreach ($t in @('git', 'node', 'npm', 'python')) { $c = Get-Command $t -ErrorAction SilentlyContinue; $report['where-' + $t] = $(if ($c) { $c.Source } else { '' }) }

$listener = $null; $pipe = $null
try {
  foreach ($d in @($ws, $tmp, $userDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  Set-Content -LiteralPath (Join-Path $ws 'given.txt') -Value 'probe-given'
  Set-Content -LiteralPath $userFile -Value 'probe-user-file'
  $sid = [DeskMinisAcProbe]::EnsureProfile($name)
  $report.containerSid = $sid
  # 只给工作区加容器的访问权限（带继承，推给已有的文件）
  $acl = & icacls $base /grant ('*' + $sid + ':(OI)(CI)M') /T /Q 2>&1
  $report.grant = ($acl | Out-String).Trim()

  & cmdkey "/generic:$credTarget" /user:probe /pass:probe-secret-cred | Out-Null
  Add-Type -AssemblyName System.Security
  $blob = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('probe-secret-dpapi'), $null, 'CurrentUser'))
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start()
  $pipe = [IO.Pipes.NamedPipeServerStream]::new($pipeName, [IO.Pipes.PipeDirection]::InOut, 4, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous)
  [void]$pipe.BeginWaitForConnection($null, $null)

  $childFile = Join-Path $ws 'child.ps1'
  [IO.File]::WriteAllText($childFile, $ChildPs, [Text.UTF8Encoding]::new($true))
  $runs = [ordered]@{ none = @(); internetClient = @('S-1-15-3-1') }
  # 容器进程继承本进程的环境变量：先改，跑完还原
  $saved = @{}
  foreach ($k in @('TEMP', 'TMP', 'npm_config_cache', 'PROBE_WS', 'PROBE_USERFILE', 'PROBE_TAG', 'PROBE_CRED', 'PROBE_DPAPI', 'PROBE_HOSTPORT', 'PROBE_PIPE', 'PROBE_NETWORK', 'PROBE_PROXY', 'PROBE_OUT', 'PROBE_RUN')) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
  try {
    $env:TEMP = $tmp; $env:TMP = $tmp; $env:npm_config_cache = Join-Path $ws 'npm-cache'
    $env:PROBE_WS = $ws; $env:PROBE_USERFILE = $userFile; $env:PROBE_TAG = $tag; $env:PROBE_CRED = $credTarget; $env:PROBE_DPAPI = $blob
    $env:PROBE_HOSTPORT = [string]$listener.LocalEndpoint.Port; $env:PROBE_PIPE = $pipeName; $env:PROBE_PROXY = $proxy
    $env:PROBE_NETWORK = $(if ($SkipNetwork) { '0' } else { '1' })
    foreach ($run in $runs.Keys) {
      $outFile = Join-Path $ws ('result-' + $run + '.json')
      $env:PROBE_OUT = $outFile; $env:PROBE_RUN = $run
      $entry = [ordered]@{ capabilities = @($runs[$run]) }
      $sw = [Diagnostics.Stopwatch]::StartNew()
      try {
        $entry.exit = [DeskMinisAcProbe]::Run($sid, [string[]]@($runs[$run]), $ps, ('"' + $ps + '" -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File "' + $childFile + '"'), $ws, 300000)
      } catch { $entry.launchError = $_.Exception.Message }
      $entry.ms = $sw.ElapsedMilliseconds
      if (Test-Path -LiteralPath $outFile) { $entry.child = (Get-Content -LiteralPath $outFile -Raw -Encoding UTF8 | ConvertFrom-Json) }
      $report.runs[$run] = $entry
    }
    # PowerShell 起不来时，看看最简单的 cmd 能不能在容器里起来
    if (-not $report.runs['none'].child) {
      try { $report.cmdExit = [DeskMinisAcProbe]::Run($sid, [string[]]@(), (Join-Path $env:SystemRoot 'System32\cmd.exe'), ('cmd.exe /c echo ok> "' + (Join-Path $ws 'cmd.txt') + '"'), $ws, 30000); $report.cmdWrote = Test-Path -LiteralPath (Join-Path $ws 'cmd.txt') } catch { $report.cmdError = $_.Exception.Message }
    }
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
} catch {
  $report.error = $_.Exception.Message
} finally {
  if ($listener) { try { $listener.Stop() } catch { } }
  if ($pipe) { try { $pipe.Dispose() } catch { } }
  try { & cmdkey "/delete:$credTarget" | Out-Null } catch { }
  try { $report.deleteProfile = [DeskMinisAcProbe]::DeleteProfile($name) } catch { }
  foreach ($d in @($base, $userDir)) { try { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } } catch { $report.cleanupFailed += @($d) } }
}

# ---------------------------------------------------------------- 结论
$expect = [ordered]@{
  'started' = @('ok', 'PowerShell 5.1 在容器里起得来');
  'token' = @('appcontainer', '进程在应用容器里');
  'ws-write' = @('allowed', '往给了权限的工作区写'); 'ws-read' = @('allowed', '读工作区里已有的文件'); 'temp-write' = @('allowed', '写临时文件（TEMP 指到工作区下）');
  'user-read' = @('denied', '读没给权限的用户文件'); 'docs-list' = @('denied', '列「文档」'); 'profile-list' = @('?', '列用户目录');
  'hkcu-read' = @('?', '读 HKCU'); 'hkcu-write' = @('denied', '写 HKCU\Software');
  'cred-read' = @('?', '读凭据管理器里的凭据'); 'cred-enum' = @('?', '列凭据管理器'); 'dpapi' = @('?', 'DPAPI 解密');
  'loop-self' = @('?', '同一进程里连自己开的回环端口'); 'loop-sibling' = @('?', '同一容器里另一个进程连回环端口');
  'loop-host' = @('denied', '连容器外进程开的回环端口'); 'pipe-host' = @('denied', '连容器外进程开的命名管道（默认权限）');
}
$netExpect = @{ none = 'denied'; internetClient = 'allowed' }
Write-Host ''
Write-Host ('系统：' + $report.os + ' ' + $report.build + '，PowerShell ' + $report.ps + $(if ($proxy) { '，系统代理 ' + $proxy } else { '，没有系统代理' }))
if ($report.error) { Write-Host ('出错：' + $report.error) -ForegroundColor Red }
foreach ($run in $report.runs.Keys) {
  $e = $report.runs[$run]
  Write-Host ''
  Write-Host ('== 容器能力：' + $(if ($run -eq 'none') { '无' } else { $run }) + '，退出码 ' + $e.exit + '，用时 ' + $e.ms + ' ms')
  if ($e.launchError) { Write-Host ('  起不来：' + $e.launchError) -ForegroundColor Red; continue }
  if (-not $e.child) { Write-Host '  PowerShell 没有写出任何结果（多半是在容器里没起来）' -ForegroundColor Red; continue }
  $byId = @{}; foreach ($r in $e.child.results) { $byId[$r.id] = $r }
  $exp = [ordered]@{}; foreach ($k in $expect.Keys) { $exp[$k] = $expect[$k] }
  if ($byId.ContainsKey('net-direct')) { $exp['net-direct'] = @($netExpect[$run], '直连外网') }
  if ($byId.ContainsKey('net-proxy')) { $exp['net-proxy'] = @('?', '经系统代理联网') }
  foreach ($k in $exp.Keys) {
    $r = $byId[$k]; $want = $exp[$k][0]
    $got = if ($r) { $r.result } else { '缺' }
    $mark = if ($want -eq '?') { '记录' } elseif ($got -eq $want) { '符合' } else { '不符合' }
    $color = if ($mark -eq '不符合') { 'Red' } elseif ($mark -eq '记录') { 'Yellow' } else { 'Green' }
    Write-Host ('  [' + $mark + '] ' + $exp[$k][1] + '：' + $got + $(if ($r -and $r.detail -and $mark -ne '符合') { '  ' + $r.detail } else { '' })) -ForegroundColor $color
  }
  Write-Host '  工具链：'
  foreach ($r in $e.child.results) {
    if ($exp.Contains($r.id)) { continue }
    Write-Host ('    ' + $r.id + '：' + $r.result + $(if ($r.detail) { '  ' + $r.detail } else { '' }))
  }
}
if ($null -ne $report.cmdExit -or $report.cmdError) { Write-Host ('cmd.exe 在容器里：' + $(if ($report.cmdError) { $report.cmdError } else { '退出码 ' + $report.cmdExit + '，写文件 ' + $report.cmdWrote })) }
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Out -Encoding UTF8
Write-Host ''
Write-Host ('完整结果已写到 ' + $Out + '。如果运行中有安全软件弹窗或拦截提示，请一并告诉我。')
