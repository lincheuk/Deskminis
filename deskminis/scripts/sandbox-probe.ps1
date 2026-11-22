<#
  执行隔离第 3 步：低完整性沙箱的真机验证（方案文档「风险与待决问题」里的四个前提）。

  用法（普通权限的 Windows PowerShell 5.1 即可，不需要管理员；不需要装 DeskMinis，也不碰它的数据）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sandbox-probe.ps1
  可选：-Out <json 路径>（默认 %TEMP%\deskminis-sandbox-probe.json）、-SkipNetwork（不跑 npm install 那一项）。

  它做的事：
    1. 在 %APPDATA% 下建一个假的「数据目录」，放一个假密钥文件，用 DeskMinis 同一段代码打「Low 进程不许读写」的标签；
       在 %USERPROFILE%\AppData\LocalLow 下建一个假的「agent 目录」，里面再放一个打了同样标签的子目录（看继承会不会盖掉它）。
    2. 用 cmdkey 往凭据管理器里存一条测试凭据，用 DPAPI 加密一小段文字。
    3. 起一个 PowerShell，用 DeskMinis 同一段代码把它自己降到低完整性级别，然后在里面逐项试：读写假数据目录、写用户目录、
       写 HKCU、读那条测试凭据、DPAPI 解密，以及 git、node、npm、python、dotnet 等工具能不能正常用。
    4. 打印结论，写一份 JSON，删掉它建的所有东西（目录、测试凭据、注册表项）。
  没有任何东西发往网络，除了 npm install 一个公开的小包（is-number）；加 -SkipNetwork 可跳过。

  下面三段 $NativePs、$LowerPs、$LabelPs 与 src/minisd/proc/sandbox.ts 逐字相同（tests/exec-isolation-step3.test.ts 钉着）。
#>
param(
  [string]$Out = (Join-Path $env:TEMP 'deskminis-sandbox-probe.json'),
  [switch]$SkipNetwork
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$NativePs = @'
function __minis_sbx_native {
  $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly([System.Reflection.AssemblyName]::new('MinisSandboxNative'), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
  $tb = $ab.DefineDynamicModule('MinisSandboxNative').DefineType('MinisSandboxNative.N' + [Guid]::NewGuid().ToString('N'), [System.Reflection.TypeAttributes]'Public,Class,Abstract,Sealed')
  $di = [System.Runtime.InteropServices.DllImportAttribute]
  $ctor = $di.GetConstructor([Type[]]@([string]))
  $fl = [System.Reflection.FieldInfo[]]@($di.GetField('SetLastError'), $di.GetField('CharSet'))
  $fv = [object[]]@($true, [System.Runtime.InteropServices.CharSet]::Unicode)
  foreach ($d in $args[0]) {
    $mb = $tb.DefineMethod($d[1], [System.Reflection.MethodAttributes]'Public,Static,PinvokeImpl', $d[2], $d[3])
    $mb.SetCustomAttribute([System.Reflection.Emit.CustomAttributeBuilder]::new($ctor, [object[]]@($d[0]), $fl, $fv))
    $mb.SetImplementationFlags([System.Reflection.MethodImplAttributes]::PreserveSig)
  }
  $tb.CreateType()
}
'@

$LowerPs = @'
function __minis_lower {
  $ProgressPreference = 'SilentlyContinue'
  $M = [Runtime.InteropServices.Marshal]; $step = 'define'; $code = 0; $ok = $false
  try {
    $n = __minis_sbx_native @(
      @('kernel32.dll', 'GetCurrentProcess', [IntPtr], [Type[]]@()),
      @('kernel32.dll', 'CloseHandle', [bool], [Type[]]@([IntPtr])),
      @('advapi32.dll', 'OpenProcessToken', [bool], [Type[]]@([IntPtr], [uint32], [IntPtr].MakeByRefType())),
      @('advapi32.dll', 'SetTokenInformation', [bool], [Type[]]@([IntPtr], [int], [IntPtr], [uint32])),
      @('advapi32.dll', 'GetTokenInformation', [bool], [Type[]]@([IntPtr], [int], [IntPtr], [uint32], [uint32].MakeByRefType())))
    $step = 'open'; $tok = [IntPtr]::Zero
    if (-not $n::OpenProcessToken($n::GetCurrentProcess(), [uint32]0x88, [ref]$tok)) { $code = $M::GetLastWin32Error(); throw 'x' }
    try {
      $step = 'set'
      $sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-16-4096')
      $sb = [byte[]]::new($sid.BinaryLength); $sid.GetBinaryForm($sb, 0)
      $hdr = 2 * [IntPtr]::Size; $len = $hdr + $sb.Length
      $buf = $M::AllocHGlobal($len)
      try {
        $M::Copy($sb, 0, [IntPtr]($buf.ToInt64() + $hdr), $sb.Length)
        $M::WriteIntPtr($buf, 0, [IntPtr]($buf.ToInt64() + $hdr))
        $M::WriteInt32($buf, [IntPtr]::Size, 0x20)
        if (-not $n::SetTokenInformation($tok, 25, $buf, [uint32]$len)) { $code = $M::GetLastWin32Error(); throw 'x' }
      } finally { $M::FreeHGlobal($buf) }
      $step = 'verify'; $need = [uint32]0
      [void]$n::GetTokenInformation($tok, 25, [IntPtr]::Zero, [uint32]0, [ref]$need)
      if ($need -eq 0) { $code = $M::GetLastWin32Error(); throw 'x' }
      $rb = $M::AllocHGlobal([int]$need)
      try {
        if (-not $n::GetTokenInformation($tok, 25, $rb, $need, [ref]$need)) { $code = $M::GetLastWin32Error(); throw 'x' }
        $got = [System.Security.Principal.SecurityIdentifier]::new($M::ReadIntPtr($rb, 0)).Value
      } finally { $M::FreeHGlobal($rb) }
      if ($got -ne 'S-1-16-4096') { throw 'x' }
      $ok = $true
    } finally { [void]$n::CloseHandle($tok) }
  } catch { }
  $function:__minis_sbx_native = $null; $function:__minis_lower = $null
  if (-not $ok) {
    [Console]::Out.WriteLine('[命令隔离没能启动，这条命令没有执行]（步骤 ' + $step + '，错误码 ' + $code + '）')
    [Console]::Out.Flush()
    [Environment]::Exit(196)
  }
}
'@

$LabelPs = @'
$ProgressPreference = 'SilentlyContinue'
$jobs = [string]$env:MINIS_LABEL_JOBS; [Environment]::SetEnvironmentVariable('MINIS_LABEL_JOBS', $null)
$M = [Runtime.InteropServices.Marshal]
$n = __minis_sbx_native @(
  @('kernel32.dll', 'LocalFree', [IntPtr], [Type[]]@([IntPtr])),
  @('advapi32.dll', 'ConvertStringSecurityDescriptorToSecurityDescriptorW', [bool], [Type[]]@([string], [uint32], [IntPtr].MakeByRefType(), [IntPtr])),
  @('advapi32.dll', 'ConvertSecurityDescriptorToStringSecurityDescriptorW', [bool], [Type[]]@([IntPtr], [uint32], [uint32], [IntPtr].MakeByRefType(), [IntPtr])),
  @('advapi32.dll', 'GetSecurityDescriptorSacl', [bool], [Type[]]@([IntPtr], [bool].MakeByRefType(), [IntPtr].MakeByRefType(), [bool].MakeByRefType())),
  @('advapi32.dll', 'GetNamedSecurityInfoW', [uint32], [Type[]]@([string], [int], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr].MakeByRefType())),
  @('advapi32.dll', 'SetNamedSecurityInfoW', [uint32], [Type[]]@([string], [int], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr])),
  @('kernel32.dll', 'GetVolumePathNameW', [bool], [Type[]]@([string], [Text.StringBuilder], [uint32])),
  @('kernel32.dll', 'GetDriveTypeW', [uint32], [Type[]]@([string])),
  @('kernel32.dll', 'GetVolumeInformationW', [bool], [Type[]]@([string], [IntPtr], [uint32], [IntPtr], [IntPtr], [uint32].MakeByRefType(), [IntPtr], [uint32])))
$want = @{ protect = '(ML;OICI;NRNW;;;ME)'; low = '(ML;OICI;NW;;;LW)'; clear = '' }
# 比较前两边都过一遍系统的 SDDL 往返：系统写回来的旗标、权限的写法和顺序不一定与这里的字面量相同
$canon = {
  $p = [IntPtr]::Zero; $o = ''
  if ($n::ConvertStringSecurityDescriptorToSecurityDescriptorW($args[0], [uint32]1, [ref]$p, [IntPtr]::Zero)) {
    $q = [IntPtr]::Zero
    if ($n::ConvertSecurityDescriptorToStringSecurityDescriptorW($p, [uint32]1, [uint32]0x10, [ref]$q, [IntPtr]::Zero)) { $o = $M::PtrToStringUni($q); [void]$n::LocalFree($q) }
    [void]$n::LocalFree($p)
  }
  $o
}
# 显式（不带 ID 旗标）的完整性标签 ACE，按出现顺序拼成一串
$explicit = { (@([regex]::Matches([string]$args[0], '\(ML;([A-Z]*);[^)]*\)') | Where-Object { -not $_.Groups[1].Value.Contains('ID') } | ForEach-Object { $_.Value })) -join '|' }
$i = -1
foreach ($ln in $jobs.Split([char]10)) {
  $ln = $ln.Trim(); if ($ln -eq '') { continue }
  $i++; $res = 'err 0'
  try {
    $sp = $ln.IndexOf(' '); if ($sp -le 0) { throw 'x' }
    $mode = $ln.Substring(0, $sp); if (-not $want.ContainsKey($mode)) { throw 'x' }
    $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ln.Substring($sp + 1)))
    $ace = $want[$mode]
    # 打标签之前看一眼所在的卷：网络盘（DRIVE_REMOTE = 4）和不保存 ACL 的文件系统（没有 FILE_PERSISTENT_ACLS = 8，如 FAT、exFAT）
    # 记 unsupported。命名管道（\\.\pipe\…）没有卷，不看；看不出来的照常往下走，打不上自然报错
    if ($mode -ne 'clear' -and -not $path.StartsWith('\\.\')) {
      $vb = [Text.StringBuilder]::new(1024)
      if ($n::GetVolumePathNameW($path, $vb, [uint32]1024)) {
        $vol = $vb.ToString(); $fl = [uint32]0
        if ($n::GetDriveTypeW($vol) -eq 4) { $res = 'unsupported'; throw 'x' }
        if ($n::GetVolumeInformationW($vol, [IntPtr]::Zero, [uint32]0, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$fl, [IntPtr]::Zero, [uint32]0) -and -not ($fl -band 8)) { $res = 'unsupported'; throw 'x' }
      }
    }
    $sd = [IntPtr]::Zero
    $rc = $n::GetNamedSecurityInfoW($path, 1, [uint32]0x10, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$sd)
    if ($rc -ne 0) { $res = 'err ' + $rc; throw 'x' }
    $cur = ''; $str = [IntPtr]::Zero
    if ($n::ConvertSecurityDescriptorToStringSecurityDescriptorW($sd, [uint32]1, [uint32]0x10, [ref]$str, [IntPtr]::Zero)) { $cur = $M::PtrToStringUni($str); [void]$n::LocalFree($str) }
    [void]$n::LocalFree($sd)
    $same = (& $explicit $cur) -eq (& $explicit (& $canon ('S:' + $ace)))
    [Console]::Out.WriteLine('__MINIS_LABEL_CUR__ ' + $i + ' ' + $cur)
    if ($same) { $res = 'same' } else {
      $psd = [IntPtr]::Zero
      if (-not $n::ConvertStringSecurityDescriptorToSecurityDescriptorW('S:' + $ace, [uint32]1, [ref]$psd, [IntPtr]::Zero)) { $res = 'err ' + $M::GetLastWin32Error(); throw 'x' }
      try {
        $present = $false; $sacl = [IntPtr]::Zero; $dflt = $false
        if (-not $n::GetSecurityDescriptorSacl($psd, [ref]$present, [ref]$sacl, [ref]$dflt)) { $res = 'err ' + $M::GetLastWin32Error(); throw 'x' }
        $rc = $n::SetNamedSecurityInfoW($path, 1, [uint32]0x10, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, $sacl)
        if ($rc -ne 0) { $res = 'err ' + $rc; throw 'x' }
      } finally { [void]$n::LocalFree($psd) }
      $res = 'ok'
    }
  } catch { }
  [Console]::Out.WriteLine('__MINIS_LABEL__ ' + $i + ' ' + $res)
}
'@

# ---- 在 Low 进程里逐项试（降级之后才跑）。输入经 PROBE_* 环境变量；结论以一行 __PROBE__ <json> 输出 ----
$ChildPs = @'
# 中文系统的控制台代码页是 936：不切成 UTF-8 的话，父进程按 UTF-8 读到的报错原文是乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$R = [System.Collections.ArrayList]::new()
function Add-R($id, $result, $detail) { [void]$R.Add([ordered]@{ id = $id; result = $result; detail = [string]$detail }) }
function Try-Access($id, [scriptblock]$b) {
  try { $o = & $b; Add-R $id 'allowed' $o } catch { Add-R $id 'denied' $_.Exception.Message }
}
function Try-Tool($id, $exe, [scriptblock]$b) {
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { Add-R $id 'absent' ''; return }
  $ErrorActionPreference = 'Continue'
  try {
    $global:LASTEXITCODE = 0
    $o = (& $b 2>&1 | Out-String).Trim()
    $last = (($o -split "`r?`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 3) -join ' | '
    if ($LASTEXITCODE -eq 0) { Add-R $id 'ok' $last } else { Add-R $id 'fail' ('exit ' + $LASTEXITCODE + ': ' + $last) }
  } catch { Add-R $id 'fail' $_.Exception.Message }
}
$started = Get-Date

$groups = (whoami /groups) -join ' '
Add-R 'il' $(if ($groups -match 'S-1-16-4096') { 'low' } elseif ($groups -match 'S-1-16-8192') { 'medium' } else { 'other' }) ''

$data = $env:PROBE_DATA; $nested = $env:PROBE_NESTED; $ws = $env:PROBE_WS
Try-Access 'data-read' { (Get-Content -LiteralPath (Join-Path $data 'secret.txt') -Raw).Length }
Try-Access 'data-list' { @(Get-ChildItem -LiteralPath $data -Force).Count }
Try-Access 'data-write' { Set-Content -LiteralPath (Join-Path $data 'new.txt') -Value 'x'; 'written' }
Try-Access 'nested-read' { (Get-Content -LiteralPath (Join-Path $nested 'secret.txt') -Raw).Length }
Try-Access 'nested-write' { Set-Content -LiteralPath (Join-Path $nested 'new.txt') -Value 'x'; 'written' }
Try-Access 'ws-write' { Set-Content -LiteralPath (Join-Path $ws 'a.txt') -Value 'x'; 'written' }
Try-Access 'temp-write' { $f = [IO.Path]::GetTempFileName(); Remove-Item -LiteralPath $f; $f }
Try-Access 'user-read' { (Get-Content -LiteralPath $env:PROBE_USERFILE -Raw).Length }
$docs = [Environment]::GetFolderPath('MyDocuments')
Try-Access 'docs-write' { $f = Join-Path $docs ('deskminis-probe-' + $env:PROBE_TAG + '.txt'); Set-Content -LiteralPath $f -Value 'x'; Remove-Item -LiteralPath $f; 'written' }
Try-Access 'profile-cache-write' { $d = Join-Path $env:USERPROFILE ('.cache\deskminis-probe-' + $env:PROBE_TAG); New-Item -ItemType Directory -Path $d -Force | Out-Null; Remove-Item -LiteralPath $d -Recurse -Force; 'written' }
Try-Access 'hkcu-write' { New-Item -Path ('HKCU:\Software\DeskMinisProbe-' + $env:PROBE_TAG) -Force | Out-Null; Remove-Item -Path ('HKCU:\Software\DeskMinisProbe-' + $env:PROBE_TAG) -Force; 'written' }
Try-Access 'hkcu-lowdata-write' { New-Item -Path ('HKCU:\Software\AppDataLow\DeskMinisProbe-' + $env:PROBE_TAG) -Force | Out-Null; Remove-Item -Path ('HKCU:\Software\AppDataLow\DeskMinisProbe-' + $env:PROBE_TAG) -Force; 'written' }

# 凭据管理器：读父进程用 cmdkey 存的那条（CRED_TYPE_GENERIC = 1）
try {
  $n = __minis_sbx_native @(
    @('advapi32.dll', 'CredReadW', [bool], [Type[]]@([string], [uint32], [uint32], [IntPtr].MakeByRefType())),
    @('advapi32.dll', 'CredEnumerateW', [bool], [Type[]]@([IntPtr], [uint32], [uint32].MakeByRefType(), [IntPtr].MakeByRefType())),
    @('advapi32.dll', 'CredFree', [void], [Type[]]@([IntPtr])))
  $M = [Runtime.InteropServices.Marshal]
  $p = [IntPtr]::Zero
  if ($n::CredReadW($env:PROBE_CRED, [uint32]1, [uint32]0, [ref]$p)) {
    $size = $M::ReadInt32($p, $(if ([IntPtr]::Size -eq 8) { 32 } else { 24 }))
    $n::CredFree($p); Add-R 'cred-read' 'allowed' ('blob ' + $size + ' bytes')
  } else { Add-R 'cred-read' 'denied' ('error ' + $M::GetLastWin32Error()) }
  $cnt = [uint32]0; $p = [IntPtr]::Zero
  if ($n::CredEnumerateW([IntPtr]::Zero, [uint32]0, [ref]$cnt, [ref]$p)) { $n::CredFree($p); Add-R 'cred-enum' 'allowed' ('' + $cnt + ' entries') }
  else { Add-R 'cred-enum' 'denied' ('error ' + $M::GetLastWin32Error()) }
} catch { Add-R 'cred-read' 'error' $_.Exception.Message }

# DPAPI：解开父进程加密的那段
try {
  Add-Type -AssemblyName System.Security
  $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:PROBE_DPAPI), $null, 'CurrentUser')
  Add-R 'dpapi' 'allowed' ([Text.Encoding]::UTF8.GetString($plain).Length)
} catch { Add-R 'dpapi' 'denied' $_.Exception.Message }

# ssh-agent 管道、git 凭据助手
$pipe = @([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -like '*openssh-ssh-agent' }).Count -gt 0
if ($pipe) { Try-Tool 'ssh-agent' 'ssh-add' { ssh-add -l; if ($LASTEXITCODE -eq 1) { $global:LASTEXITCODE = 0 } } } else { Add-R 'ssh-agent' 'absent' 'no openssh-ssh-agent pipe' }

# 工具链（在 agent 目录的工作区里）
Set-Location -LiteralPath $ws
Try-Tool 'git' 'git' { git init -q repo; git -C repo -c user.name=probe -c user.email=probe@example.invalid commit --allow-empty -q -m probe; git -C repo log --oneline }
Try-Tool 'git-credential-helper' 'git' { git config --get credential.helper; if ($LASTEXITCODE -eq 1) { $global:LASTEXITCODE = 0 } }
Try-Tool 'node' 'node' { node -e "require('fs').writeFileSync('node.txt', process.version); console.log(process.version)" }
Try-Tool 'npm-cache' 'npm' { npm config get cache }
if ($env:PROBE_NETWORK -eq '1') { Try-Tool 'npm-install' 'npm' { New-Item -ItemType Directory -Force npmproj | Out-Null; Set-Location npmproj; npm init -y | Out-Null; npm install is-number@7.0.0 --no-audit --no-fund --loglevel=error; Set-Location .. } }
Try-Tool 'python' 'python' { python -c "import sys; print(sys.version)"; python -m venv venv; if (Test-Path venv) { 'venv ok' } }
Try-Tool 'dotnet' 'dotnet' { dotnet --version }
Try-Tool 'cargo' 'cargo' { cargo --version }
Try-Tool 'go' 'go' { go version }
Try-Tool 'java' 'java' { java -version }

[Console]::Out.WriteLine('__PROBE__ ' + (@{ ms = [int]((Get-Date) - $started).TotalMilliseconds; results = $R } | ConvertTo-Json -Compress -Depth 4))
'@

# ---------------------------------------------------------------- 父进程（原级别）

function Invoke-Label($jobs) {
  $lines = ($jobs | ForEach-Object { $_[0] + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_[1])) }) -join "`n"
  $psi = [Diagnostics.ProcessStartInfo]::new((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  $psi.Arguments = '-NoProfile -NoLogo -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($NativePs + $LabelPs))
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['MINIS_LABEL_JOBS'] = $lines
  $p = [Diagnostics.Process]::Start($psi); $o = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
  $map = @{}
  foreach ($m in [regex]::Matches($o, '__MINIS_LABEL__ (\d+) (\S+(?: \d+)?)')) { $map[[int]$m.Groups[1].Value] = $m.Groups[2].Value }
  for ($k = 0; $k -lt @($jobs).Count; $k++) { if ($map.ContainsKey($k)) { $map[$k] } else { 'missing' } }
}

$tag = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$base = Join-Path $env:APPDATA ('DeskMinisProbe-' + $tag)
$data = Join-Path $base 'data'
$lowRoot = Join-Path $env:USERPROFILE ('AppData\LocalLow\DeskMinisProbe-' + $tag)
$ws = Join-Path $lowRoot 'workspace'
$nested = Join-Path $lowRoot 'nested-protected'
$tmp = Join-Path $lowRoot 'sandbox\tmp'
$userFile = Join-Path $base 'user-file.txt'
$credTarget = 'DeskMinisProbe-' + $tag
$report = [ordered]@{ tag = $tag; os = [Environment]::OSVersion.VersionString; build = ''; ps = $PSVersionTable.PSVersion.ToString(); arch = $(if ([IntPtr]::Size -eq 8) { 'x64' } else { 'x86' }) }
try { $report.build = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').DisplayVersion + ' ' + (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuild } catch { }

try {
  foreach ($d in @($data, $ws, $nested, $tmp)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  Set-Content -LiteralPath (Join-Path $data 'secret.txt') -Value 'probe-secret-data'
  Set-Content -LiteralPath (Join-Path $nested 'secret.txt') -Value 'probe-secret-nested'
  Set-Content -LiteralPath $userFile -Value 'probe-user-file'
  # 文件先建、标签后打：看继承标签会不会推给已有的文件（DeskMinis 给老用户的数据目录打标签就是这种情形）
  $labels = @(Invoke-Label @(@('protect', $data), @('low', $lowRoot), @('protect', $nested)))
  $labels2 = @(Invoke-Label @(, @('protect', $data)))
  $report.labels = [ordered]@{ data = $labels[0]; agentRoot = $labels[1]; nested = $labels[2]; dataAgain = $labels2[0] }

  & cmdkey "/generic:$credTarget" /user:probe /pass:probe-secret-cred | Out-Null
  Add-Type -AssemblyName System.Security
  $blob = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('probe-secret-dpapi'), $null, 'CurrentUser'))

  $childFile = Join-Path $base 'child.ps1'
  # __minis_lower 跑完会删掉 __minis_sbx_native（产品里用户命令调不到它），读凭据要用，降级之后再定义一次
  [IO.File]::WriteAllText($childFile, $NativePs + $LowerPs + "__minis_lower`n" + $NativePs + $ChildPs, [Text.UTF8Encoding]::new($true))
  $psi = [Diagnostics.ProcessStartInfo]::new((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  $psi.Arguments = '-NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File "' + $childFile + '"'
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $ws
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $ev = $psi.EnvironmentVariables
  $ev['PROBE_DATA'] = $data; $ev['PROBE_NESTED'] = $nested; $ev['PROBE_WS'] = $ws; $ev['PROBE_USERFILE'] = $userFile
  $ev['PROBE_TAG'] = $tag; $ev['PROBE_CRED'] = $credTarget; $ev['PROBE_DPAPI'] = $blob; $ev['PROBE_NETWORK'] = $(if ($SkipNetwork) { '0' } else { '1' })
  # 和 DeskMinis 开了沙箱时一样：TEMP 与常见缓存指到 agent 目录下
  foreach ($k in @('TEMP', 'TMP')) { $ev[$k] = $tmp }
  $cache = Join-Path $lowRoot 'sandbox\cache'
  $ev['npm_config_cache'] = Join-Path $cache 'npm'; $ev['YARN_CACHE_FOLDER'] = Join-Path $cache 'yarn'; $ev['PIP_CACHE_DIR'] = Join-Path $cache 'pip'
  $ev['NUGET_PACKAGES'] = Join-Path $cache 'nuget'; $ev['GOCACHE'] = Join-Path $cache 'go-build'; $ev['GOMODCACHE'] = Join-Path $cache 'go-mod'

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = [Diagnostics.Process]::Start($psi)
  $errTask = $p.StandardError.ReadToEndAsync()
  $outText = $p.StandardOutput.ReadToEnd()
  if (-not $p.WaitForExit(600000)) { try { $p.Kill() } catch { } }
  $report.childExit = $p.ExitCode; $report.childMs = $sw.ElapsedMilliseconds
  $report.childStderr = (($errTask.Result -split "`r?`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 5) -join ' | '
  $line = ($outText -split "`r?`n") | Where-Object { $_.StartsWith('__PROBE__ ') } | Select-Object -Last 1
  if ($line) { $report.child = ($line.Substring(10) | ConvertFrom-Json) }
  else { $report.childOutput = (($outText -split "`r?`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 5) -join ' | ' }
} finally {
  try { & cmdkey "/delete:$credTarget" | Out-Null } catch { }
  foreach ($d in @($base, $lowRoot)) { try { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } } catch { $report.cleanupFailed += @($d) } }
}

# ---------------------------------------------------------------- 结论
$expect = [ordered]@{
  'il' = @('low', '进程完整性级别');
  'data-read' = @('denied', '读数据目录里的文件'); 'data-list' = @('denied', '列数据目录'); 'data-write' = @('denied', '往数据目录写文件');
  'nested-read' = @('denied', '读 agent 目录里打了标签的子目录'); 'nested-write' = @('denied', '往那个子目录写');
  'ws-write' = @('allowed', '往工作区写'); 'temp-write' = @('allowed', '写临时文件');
  'user-read' = @('allowed', '读没打标签的用户文件（已知短板）'); 'docs-write' = @('denied', '往「文档」写');
  'profile-cache-write' = @('denied', '往 %USERPROFILE%\.cache 写'); 'hkcu-write' = @('denied', '写 HKCU\Software');
  'hkcu-lowdata-write' = @('allowed', '写 HKCU\Software\AppDataLow');
  'cred-read' = @('?', '读凭据管理器里的凭据'); 'cred-enum' = @('?', '列凭据管理器'); 'dpapi' = @('?', 'DPAPI 解密');
}
$byId = @{}
if ($report.child) { foreach ($r in $report.child.results) { $byId[$r.id] = $r } }
Write-Host ''
Write-Host ('系统：' + $report.os + ' ' + $report.build + '，PowerShell ' + $report.ps + '，' + $report.arch)
Write-Host ('标签：数据目录 ' + $report.labels.data + '，agent 目录 ' + $report.labels.agentRoot + '，子目录 ' + $report.labels.nested + '，再打一次 ' + $report.labels.dataAgain)
if ($report.childExit -eq 196) { Write-Host '降级失败：进程没能降到低完整性级别（可能被安全软件拦下）。' -ForegroundColor Red; Write-Host $report.childOutput }
elseif (-not $report.child) { Write-Host ('Low 进程没有给出结果，退出码 ' + $report.childExit + '：' + $report.childOutput + ' ' + $report.childStderr) -ForegroundColor Red }
else {
  Write-Host ('Low 进程用时 ' + $report.childMs + ' ms')
  foreach ($k in $expect.Keys) {
    $r = $byId[$k]; $want = $expect[$k][0]
    $got = if ($r) { $r.result } else { '缺' }
    $mark = if ($want -eq '?') { '记录' } elseif ($got -eq $want) { '符合' } else { '不符合' }
    $color = if ($mark -eq '不符合') { 'Red' } elseif ($mark -eq '记录') { 'Yellow' } else { 'Green' }
    Write-Host ('  [' + $mark + '] ' + $expect[$k][1] + '：' + $got) -ForegroundColor $color
  }
  Write-Host '工具链：'
  foreach ($r in $report.child.results) {
    if ($expect.Contains($r.id)) { continue }
    Write-Host ('  ' + $r.id + '：' + $r.result + $(if ($r.detail) { '  ' + $r.detail } else { '' }))
  }
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Out -Encoding UTF8
Write-Host ''
Write-Host ('完整结果已写到 ' + $Out + '。如果运行中有安全软件弹窗或拦截提示，请一并告诉我。')
