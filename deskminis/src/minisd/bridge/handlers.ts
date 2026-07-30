/**
 * 桥请求/信封类型、一次性 PowerShell 执行器、六桥 handler + 分发器。
 *
 * 安全红线：脚本零插值——所有用户载荷一律经 stdin JSON 传入，脚本内 ConvertFrom-Json 取用。
 * 权限定域：每个 (tool, action) 路由到固定 BridgePermissionKind，detail 为能力串 "<tool> <action>"，
 *   会话级 allow-session 后同能力串静默（不会因标题/正文不同重复弹卡）。
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { BridgePermissionKind, PermissionGateway, PermissionRequest } from '../tools/types';
import type { MinisPaths } from '../paths';

/** 会话 id 校验：与 index.ts 的 SESSION_ID_RE 一致（UUID 大小写不限）。 */
const SESSION_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

// ---- 协议类型 ----

export interface BridgeRequest {
  tool: 'windows-notify' | 'windows-clipboard' | 'windows-open' | 'windows-speak' | 'windows-screenshot' | 'windows-device';
  action: string;
  args: Record<string, string>;
  sessionId: string;
  stdin?: string;
}

export interface BridgeEnvelope {
  ok: boolean;
  tool: string;
  action: string;
  data?: unknown;
  error?: { code: string; message: string };
  timestamp: number; // epoch 秒（浮点）
}

// ---- 一次性 PowerShell 执行器 ----

export interface PsResult { stdout: string; stderr: string; exitCode: number }
export type PsRunner = (script: string, stdin?: string, timeoutMs?: number) => Promise<PsResult>;

/**
 * 一次性 PowerShell：-EncodedCommand（UTF-16LE base64）启动模式（M1 已验证），不复用 PersistentShell。
 * 载荷经 stdin 传入；脚本零插值。失败域隔离：本进程崩溃不影响会话壳。
 */
export async function runPowerShell(script: string, stdin = '', timeoutMs = 30000): Promise<PsResult> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    // -STA：System.Windows.Forms.Clipboard 等要求 STAThread，默认 powershell.exe PS5.1 是 STA，
    // 但部分 host 环境（如批处理调用）会落到 MTA——显式 -STA 防御性兜底。
    const proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: PsResult) => { if (!settled) { settled = true; resolve(r); } };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('error', err => finish({ stdout, stderr: stderr + `\n[spawn 失败: ${err.message}]`, exitCode: 127 }));
    proc.on('close', code => finish({ stdout, stderr, exitCode: code ?? 0 }));
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({ stdout, stderr: stderr + '\n[命令超时被终止]', exitCode: 124 });
    }, timeoutMs);
    proc.on('close', () => clearTimeout(timer));
    try {
      proc.stdin.end(stdin);
    } catch (e) {
      finish({ stdout, stderr: stderr + `\n[stdin 写入失败: ${(e as Error).message}]`, exitCode: 127 });
    }
  });
}

// ---- 信封工具 ----

const now = () => Date.now() / 1000;

/** 成功信封（导出：测试 echo server / Task 4 服务端兜底使用）。 */
export function okEnvelope(tool: string, action: string, data: unknown): BridgeEnvelope {
  return { ok: true, tool, action, data, timestamp: now() };
}
/** 错误信封（导出：服务端兜底使用）。 */
export function errEnvelope(tool: string, action: string, code: string, message: string): BridgeEnvelope {
  return { ok: false, tool, action, error: { code, message }, timestamp: now() };
}

function ok(req: BridgeRequest, data: unknown): BridgeEnvelope {
  return okEnvelope(req.tool, req.action, data);
}
function err(req: BridgeRequest, code: string, message: string): BridgeEnvelope {
  return errEnvelope(req.tool, req.action, code, message);
}

// ---- 单个 handler：经权限网关后调 runPowerShell；载荷走 stdin JSON ----

function parseRate(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) return null; // 非整数 → 非法
  const n = Number(v);
  if (n < -10 || n > 10) return null; // 超界 → 非法
  return n;
}

async function notify(req: BridgeRequest, deps: BridgeDeps): Promise<BridgeEnvelope> {
  const p = { title: req.args.title ?? 'DeskMinis', body: req.args.body ?? '' };
  const r = await deps.runPs(NOTIFY_SCRIPT, JSON.stringify(p));
  if (r.exitCode !== 0) return err(req, 'EXEC_ERROR', `windows-notify 失败 (exit=${r.exitCode}): ${r.stderr}`.trim());
  return ok(req, { shown: true });
}

async function clipboard(req: BridgeRequest, deps: BridgeDeps): Promise<BridgeEnvelope> {
  if (req.action === 'get') {
    const r = await deps.runPs(CLIPBOARD_GET_SCRIPT);
    if (r.exitCode !== 0) return err(req, 'EXEC_ERROR', `windows-clipboard get 失败 (exit=${r.exitCode}): ${r.stderr}`.trim());
    const MAX = 1024 * 1024;
    const text = r.stdout.length > MAX ? r.stdout.slice(0, MAX) : r.stdout;
    return ok(req, { text, truncated: r.stdout.length > MAX });
  }
  if (req.action === 'set') {
    const text = req.args.text ?? req.stdin;
    if (text === undefined) return err(req, 'INVALID_ARGS', 'clipboard set 需要 --text 或 stdin');
    const r = await deps.runPs(CLIPBOARD_SET_SCRIPT, JSON.stringify({ text }));
    if (r.exitCode !== 0) return err(req, 'EXEC_ERROR', `windows-clipboard set 失败 (exit=${r.exitCode}): ${r.stderr}`.trim());
    return ok(req, { length: text.length });
  }
  return err(req, 'INVALID_ARGS', `未知 action: ${req.action}`);
}

async function open(req: BridgeRequest, deps: BridgeDeps): Promise<BridgeEnvelope> {
  const target = req.args.target;
  if (!target) return err(req, 'INVALID_ARGS', 'open 需要 --target');
  const isUrl = /^https?:\/\//i.test(target);
  const isExisting = existsSync(target);
  if (!isUrl && !isExisting) return err(req, 'INVALID_ARGS', `目标既非 http(s) 网址也不存在: ${target}`);
  const r = await deps.runPs(OPEN_SCRIPT, JSON.stringify({ target }));
  if (r.exitCode !== 0) return err(req, 'EXEC_ERROR', `windows-open 失败 (exit=${r.exitCode}): ${r.stderr}`.trim());
  return ok(req, { opened: target });
}

async function speak(req: BridgeRequest, deps: BridgeDeps): Promise<BridgeEnvelope> {
  if (req.action !== 'say') return err(req, 'INVALID_ARGS', `未知 action: ${req.action}`);
  const text = req.args.text ?? req.stdin;
  if (text === undefined) return err(req, 'INVALID_ARGS', 'speak say 需要 --text 或 stdin');
  const rate = parseRate(req.args.rate);
  if (rate === null) return err(req, 'INVALID_ARGS', `rate 必须是 -10 到 10 之间的整数，收到: ${req.args.rate}`);
  // rate 缺省时 stdin 不带 rate 键，PowerShell 端默认 0（计划测试假设）。
  const p: { text: string; rate?: number } = { text };
  if (rate !== undefined) p.rate = rate;
  const r = await deps.runPs(SPEAK_SCRIPT, JSON.stringify(p), 120000);
  if (r.exitCode !== 0) return err(req, 'EXEC_ERROR', `windows-speak 失败 (exit=${r.exitCode}): ${r.stderr}`.trim());
  return ok(req, { spoken: true });
}

async function screenshot(req: BridgeRequest, deps: BridgeDeps): Promise<BridgeEnvelope> {
  if (req.action !== 'capture') return err(req, 'INVALID_ARGS', `未知 action: ${req.action}`);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = deps.paths.sessionBucket(req.sessionId, 'attachments');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `screenshot-${ts}.png`);
  const r = await deps.runPs(SCREENSHOT_SCRIPT, JSON.stringify({ path }));
  if (r.exitCode !== 0) return err(req, 'EXEC_ERROR', `windows-screenshot 失败 (exit=${r.exitCode}): ${r.stderr}`.trim());
  if (!existsSync(path)) return err(req, 'EXEC_ERROR', `截图未落盘: ${path}`);
  const st = statSync(path);
  const dim = r.stdout.trim().split(/[x×]/);
  const width = Number(dim[0] ?? 0);
  const height = Number(dim[1] ?? 0);
  return ok(req, { path, width, height, bytes: st.size });
}

async function device(req: BridgeRequest, deps: BridgeDeps): Promise<BridgeEnvelope> {
  if (req.action !== 'info') return err(req, 'INVALID_ARGS', `未知 action: ${req.action}`);
  const r = await deps.runPs(DEVICE_SCRIPT);
  if (r.exitCode !== 0) return err(req, 'EXEC_ERROR', `windows-device 失败 (exit=${r.exitCode}): ${r.stderr}`.trim());
  try {
    const data = JSON.parse(r.stdout);
    return ok(req, data);
  } catch {
    return err(req, 'EXEC_ERROR', `device 输出非 JSON: ${r.stdout.slice(0, 200)}`);
  }
}

// ---- 分发器：tool+action → (handler, BridgePermissionKind) ----

export interface BridgeDeps {
  permissions: PermissionGateway;
  paths: MinisPaths;
  runPs?: PsRunner; // 测试注入；运行时默认 runPowerShell
}

const ROUTES: Record<string, { action: string; kind: BridgePermissionKind; toolTitle: string; fn: (req: BridgeRequest, deps: BridgeDeps) => Promise<BridgeEnvelope> }> = {
  'windows-notify|show': { action: 'show', kind: 'bridge-notify', toolTitle: '桌面通知', fn: notify },
  'windows-clipboard|get': { action: 'get', kind: 'bridge-clipboard-read', toolTitle: '读取剪贴板', fn: clipboard },
  'windows-clipboard|set': { action: 'set', kind: 'bridge-clipboard-write', toolTitle: '写入剪贴板', fn: clipboard },
  'windows-open|open': { action: 'open', kind: 'bridge-open', toolTitle: '打开链接或文件', fn: open },
  'windows-speak|say': { action: 'say', kind: 'bridge-speak', toolTitle: '语音播报', fn: speak },
  'windows-screenshot|capture': { action: 'capture', kind: 'bridge-screenshot', toolTitle: '截屏', fn: screenshot },
  'windows-device|info': { action: 'info', kind: 'bridge-device', toolTitle: '设备信息', fn: device },
};

export function makeBridgeDispatcher(deps: BridgeDeps): (req: BridgeRequest) => Promise<BridgeEnvelope> {
  const runPs: PsRunner = deps.runPs ?? runPowerShell;
  return async (req: BridgeRequest): Promise<BridgeEnvelope> => {
    if (typeof req !== 'object' || req === null || typeof req.sessionId !== 'string' || !SESSION_ID_RE.test(req.sessionId)) {
      return err(req ?? { tool: '?', action: '?', args: {}, sessionId: '' }, 'INVALID_ARGS', '非法 sessionId');
    }
    const route = ROUTES[`${req.tool}|${req.action}`];
    if (!route) {
      return err(req, 'INVALID_ARGS', `未知工具或动作: ${req.tool} ${req.action}`);
    }
    const preq: PermissionRequest = {
      kind: route.kind,
      detail: `${req.tool} ${req.action}`,
      sessionId: req.sessionId,
      toolTitle: route.toolTitle,
    };
    const decision = await deps.permissions.check(preq);
    if (decision === 'deny') return err(req, 'PERMISSION_DENIED', `权限拒绝: ${preq.detail}`);
    try {
      return await route.fn(req, { ...deps, runPs });
    } catch (e) {
      if (e instanceof BridgeError) return err(req, e.code, e.message);
      return err(req, 'INTERNAL_ERROR', (e as Error).message);
    }
  };
}

/** 桥内部错误：handler 主动抛出时携带错误码。 */
export class BridgeError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'BridgeError'; }
}

// ---- PowerShell 脚本（脚本源码里绝无用户载荷；载荷一律 stdin） ----

const NOTIFY_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.NotifyIcon
$form.Icon = [System.Drawing.SystemIcons]::Information
$form.Visible = $true
$form.BalloonTipTitle = $p.title
$form.BalloonTipText = $p.body
$form.ShowBalloonTip(3000)
Start-Sleep -Milliseconds 3500
$form.Dispose()
`;

const CLIPBOARD_GET_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())
`;

const CLIPBOARD_SET_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($p.text)
`;

const OPEN_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Start-Process $p.target
`;

const SPEAK_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($p.PSObject.Properties['rate']) { $sp.Rate = [int]$p.rate }
$sp.Speak($p.text)
$sp.Dispose()
`;

const SCREENSHOT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($p.path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[Console]::Out.Write("$($bounds.Width)x$($bounds.Height)")
`;

const DEVICE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
$totalMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
[PSCustomObject]@{
  osVersion = $os.Caption + ' ' + $os.Version
  computerName = $cs.Name
  userName = $env:USERNAME
  cpuCount = [int]$cpu
  totalMemoryMB = [int]$totalMB
  psVersion = $PSVersionTable.PSVersion.ToString()
} | ConvertTo-Json -Compress
`;
