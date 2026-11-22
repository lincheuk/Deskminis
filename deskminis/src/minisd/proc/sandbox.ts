/**
 * 执行隔离第 3 步（一）：低完整性级别（Low IL）沙箱的核心。
 *
 * 做法（方案文档 C1）：
 *  - shell 驱动读到第一条命令、归属进作业之后、执行它之前，把自己进程令牌的完整性级别降到 Low（lowerSelfPs）。
 *    之后它执行的命令、起的子进程全在 Low 下。降级只降不升，不需要任何特权；已经打开的句柄（和引擎之间的管道）照常可用。
 *    降不下去时驱动不执行这条命令，写一行说明后以 196 退出：开了沙箱就不会悄悄在原级别下跑。
 *  - 引擎（Medium）启动时给数据根打显式的 Medium 标签，带 NO_READ_UP | NO_WRITE_UP、对子目录和文件继承（labelScriptPs）：
 *    Low 进程连读都读不到会话库、密钥和端口文件。给 agent 根打 Low 标签：agent 的工作区、附件、临时目录照常可写。
 *    给自己的文件打不高于自身级别的标签不需要管理员。
 *  - Low 进程写不了 %TEMP%、npm / pip 缓存这些 Medium 目录，所以沙箱里的 TEMP、TMP 和几个常见缓存指到 agent 根下（sandboxEnv）。
 *
 * 这一部分只在开发者开关 DESKMINIS_SANDBOX=1 下生效（sandboxDecision），默认关：绑定到别处的工作区还没有打 Low 标签、
 * windows-* 桥的命名管道 Low 进程还连不上、「在沙箱外运行」的卡还没做，这些在第 3 步第二部分。
 * 四个前提（文件上的 NO_READ_UP、凭据管理器与 DPAPI、杀软反应、工具链兼容）要在真机上跑 scripts/sandbox-probe.ps1 验证；
 * 脚本里的三段 PowerShell 与这里逐字相同（tests/exec-isolation-step3.test.ts 钉着）。
 *
 * Win32 调用沿用 F09 的做法（proc/own-script.ts）：Reflection.Emit 在内存里定义 P/Invoke，不落盘、不起 csc.exe；
 * 脚本是产品常量，路径之类的输入经环境变量传入，不拼进脚本文本。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { childEnv } from './child-env';
import { powershellPath, type ProcOpts } from './win-exec';

/** 降级失败时驱动的退出码（197 / 198 是 F09 的，见 own-script.ts）。 */
export const SANDBOX_REFUSED_EXIT = 196;
/** Low 完整性级别的 SID。 */
export const LOW_IL_SID = 'S-1-16-4096';
/** 驱动降级失败时写到 stdout 的话（会落进这条命令的输出，模型和用户都看得到）。 */
export const SANDBOX_REFUSED_TEXT = '[命令隔离没能启动，这条命令没有执行]';

/** 在内存里定义 P/Invoke。每项：dll, 函数名, 返回类型, 形参类型数组。返回定义好的类型。 */
export const SANDBOX_NATIVE_PS = `function __minis_sbx_native {
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
`;

/**
 * __minis_lower：把本进程令牌的完整性级别降到 Low，读回确认。成功什么也不写；失败往 stdout 写 SANDBOX_REFUSED_TEXT
 * 加步骤与错误码，以 196 退出。跑完把两个函数删掉（用户命令里调不到）。
 * 0x88 = TOKEN_ADJUST_DEFAULT | TOKEN_QUERY；25 = TokenIntegrityLevel；0x20 = SE_GROUP_INTEGRITY。
 * TOKEN_MANDATORY_LABEL 就是一个 SID_AND_ATTRIBUTES：指针 + DWORD，按指针对齐后长两个指针，SID 紧跟在后面。
 */
export const SANDBOX_LOWER_PS = `function __minis_lower {
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
      $sid = [System.Security.Principal.SecurityIdentifier]::new('${LOW_IL_SID}')
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
      if ($got -ne '${LOW_IL_SID}') { throw 'x' }
      $ok = $true
    } finally { [void]$n::CloseHandle($tok) }
  } catch { }
  $function:__minis_sbx_native = $null; $function:__minis_lower = $null
  if (-not $ok) {
    [Console]::Out.WriteLine('${SANDBOX_REFUSED_TEXT}（步骤 ' + $step + '，错误码 ' + $code + '）')
    [Console]::Out.Flush()
    [Environment]::Exit(${SANDBOX_REFUSED_EXIT})
  }
}
`;

/** 驱动循环里那一行：排在 F09 的归属之后、执行命令之前，只跑一次。 */
export const LOWER_HOOK_PS = 'if (-not $__minis_low) { $__minis_low = $true; __minis_lower }';

/**
 * 打标签的一次性脚本。输入经环境变量 MINIS_LABEL_JOBS：每行「模式 空格 路径的 UTF-8 base64」；读完即从进程环境删掉。
 * 模式：protect = Medium + NO_READ_UP|NO_WRITE_UP，继承给子目录与文件（数据根）；low = Low + NO_WRITE_UP，继承（agent 根）；
 * clear = 去掉显式标签（回到默认的隐式 Medium）。
 * 已经是这个标签（显式、带继承）的不再写一遍：SetNamedSecurityInfo 会把继承来的标签逐个推给已有的子项，大目录要花时间。
 * 每行输出一条结论（纯 ASCII）：__MINIS_LABEL__ <序号> ok | same | err <错误码>。
 * 0x10 = LABEL_SECURITY_INFORMATION；1 = SE_FILE_OBJECT，也是 SDDL_REVISION_1。
 */
export const LABEL_MARKER = '__MINIS_LABEL__';
export const SANDBOX_LABEL_PS = `$ProgressPreference = 'SilentlyContinue'
$jobs = [string]$env:MINIS_LABEL_JOBS; [Environment]::SetEnvironmentVariable('MINIS_LABEL_JOBS', $null)
$M = [Runtime.InteropServices.Marshal]
$n = __minis_sbx_native @(
  @('kernel32.dll', 'LocalFree', [IntPtr], [Type[]]@([IntPtr])),
  @('advapi32.dll', 'ConvertStringSecurityDescriptorToSecurityDescriptorW', [bool], [Type[]]@([string], [uint32], [IntPtr].MakeByRefType(), [IntPtr])),
  @('advapi32.dll', 'ConvertSecurityDescriptorToStringSecurityDescriptorW', [bool], [Type[]]@([IntPtr], [uint32], [uint32], [IntPtr].MakeByRefType(), [IntPtr])),
  @('advapi32.dll', 'GetSecurityDescriptorSacl', [bool], [Type[]]@([IntPtr], [bool].MakeByRefType(), [IntPtr].MakeByRefType(), [bool].MakeByRefType())),
  @('advapi32.dll', 'GetNamedSecurityInfoW', [uint32], [Type[]]@([string], [int], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr].MakeByRefType())),
  @('advapi32.dll', 'SetNamedSecurityInfoW', [uint32], [Type[]]@([string], [int], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr])))
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
$explicit = { (@([regex]::Matches([string]$args[0], '\\(ML;([A-Z]*);[^)]*\\)') | Where-Object { -not $_.Groups[1].Value.Contains('ID') } | ForEach-Object { $_.Value })) -join '|' }
$i = -1
foreach ($ln in $jobs.Split([char]10)) {
  $ln = $ln.Trim(); if ($ln -eq '') { continue }
  $i++; $res = 'err 0'
  try {
    $sp = $ln.IndexOf(' '); if ($sp -le 0) { throw 'x' }
    $mode = $ln.Substring(0, $sp); if (-not $want.ContainsKey($mode)) { throw 'x' }
    $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ln.Substring($sp + 1)))
    $ace = $want[$mode]
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
  [Console]::Out.WriteLine('${LABEL_MARKER} ' + $i + ' ' + $res)
}
`;

export type LabelMode = 'protect' | 'low' | 'clear';
export interface LabelJob { mode: LabelMode; path: string }
export type LabelResult = { path: string; outcome: 'ok' | 'same' } | { path: string; outcome: 'err'; code: number };

/** 解析打标签脚本的输出。没报的一项记 err -1（脚本没跑完）。 */
export function parseLabelOutput(jobs: readonly LabelJob[], stdout: string): LabelResult[] {
  const out: LabelResult[] = jobs.map(j => ({ path: j.path, outcome: 'err', code: -1 }));
  const re = new RegExp(`^${LABEL_MARKER} (\\d+) (ok|same|err (\\d+))\\r?$`, 'gm');
  for (const m of stdout.matchAll(re)) {
    const i = Number(m[1]);
    if (!Number.isSafeInteger(i) || i < 0 || i >= jobs.length) continue;
    const path = jobs[i].path;
    out[i] = m[2] === 'ok' || m[2] === 'same' ? { path, outcome: m[2] } : { path, outcome: 'err', code: Number(m[3]) };
  }
  return out;
}

/** 打标签脚本的全文与它要的环境变量。 */
export function labelInvocation(jobs: readonly LabelJob[]): { script: string; jobsEnv: string } {
  const jobsEnv = jobs.map(j => `${j.mode} ${Buffer.from(j.path, 'utf8').toString('base64')}`).join('\n');
  return { script: SANDBOX_NATIVE_PS + SANDBOX_LABEL_PS, jobsEnv };
}

const LABEL_TIMEOUT_MS = 120_000;

/** 起一个一次性的 PowerShell 打标签。从不拒绝：起不来、超时都按每项 err 返回。 */
export function applyLabels(jobs: readonly LabelJob[], proc: ProcOpts = {}, timeoutMs = LABEL_TIMEOUT_MS): Promise<LabelResult[]> {
  const spawnImpl = proc.spawnImpl ?? spawn;
  const sysEnv = proc.sysEnv ?? process.env;
  const { script, jobsEnv } = labelInvocation(jobs);
  return new Promise(done => {
    let stdout = '';
    let settled = false;
    const finish = (): void => { if (settled) return; settled = true; clearTimeout(timer); done(parseLabelOutput(jobs, stdout)); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } finish(); }, timeoutMs);
    timer.unref?.();
    const child = spawnImpl(powershellPath(sysEnv), ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      env: { ...childEnv(sysEnv), MINIS_LABEL_JOBS: jobsEnv },
    });
    child.on('error', finish);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (s: string) => { stdout += s; });
    child.on('close', finish);
  });
}

export type SandboxDecision =
  | { enabled: true }
  | { enabled: false; reason: 'off' | 'not-windows' | 'agent-root-overlaps-data-root' };

const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const sameOrNested = (a: string, b: string, win: boolean): boolean => {
  const na = resolve(a); const nb = resolve(b);
  const [x, y] = win ? [na.toLowerCase(), nb.toLowerCase()] : [na, nb];
  return inside(x, y) || inside(y, x);
};

/** 开不开沙箱：只认 DESKMINIS_SANDBOX=1，且只在 Windows 上。agent 根与数据根重叠（老布局：显式给了数据根）时不开——
 *  给数据根打「不许读」会把 agent 自己的工作区一起挡住。 */
export function sandboxDecision(o: { env: Readonly<Record<string, string | undefined>>; platform: string; root: string; agentRoot: string }): SandboxDecision {
  if (o.env.DESKMINIS_SANDBOX !== '1') return { enabled: false, reason: 'off' };
  if (o.platform !== 'win32') return { enabled: false, reason: 'not-windows' };
  if (sameOrNested(o.root, o.agentRoot, true)) return { enabled: false, reason: 'agent-root-overlaps-data-root' };
  return { enabled: true };
}

/** 沙箱里 TEMP、TMP 与常见缓存的位置：都在 agent 根的 sandbox 目录下（Low 可写）。 */
export function sandboxEnv(agentRoot: string): Record<string, string> {
  const base = join(agentRoot, 'sandbox');
  const tmp = join(base, 'tmp');
  const cache = (name: string): string => join(base, 'cache', name);
  return {
    TEMP: tmp, TMP: tmp,
    npm_config_cache: cache('npm'), YARN_CACHE_FOLDER: cache('yarn'),
    PIP_CACHE_DIR: cache('pip'), NUGET_PACKAGES: cache('nuget'),
    GOCACHE: cache('go-build'), GOMODCACHE: cache('go-mod'),
  };
}

/** 建好 sandboxEnv 里的目录（TEMP 不存在时很多工具直接失败）。失败的照常返回给调用方记日志。 */
export function ensureSandboxDirs(env: Record<string, string>): string[] {
  const failed: string[] = [];
  for (const dir of new Set(Object.values(env))) {
    try { mkdirSync(dir, { recursive: true }); } catch { failed.push(dir); }
  }
  return failed;
}

/** 在子进程环境上覆盖几项：Windows 的变量名不分大小写，先删掉同名（不论大小写）的原值，免得出现两份。返回新对象。 */
export function overrideEnv(env: Readonly<Record<string, string>>, overrides: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (!overrides) return { ...env };
  const keys = new Set(Object.keys(overrides).map(k => k.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!keys.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...overrides };
}

/** shell 的沙箱配置：开了沙箱时由 index.ts 建好交给 ShellManager。ready 落定之前不起驱动（等标签打完）。 */
export interface ShellSandbox {
  env: Record<string, string>;
  ready: Promise<unknown>;
}
